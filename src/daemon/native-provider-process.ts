import { randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { createProviderProcessReleaseProofIssuer, type ProviderProcessInvocation,
  type ProviderProcessReservation } from "../domain/provider-process-custody.ts";
import { observeNativeHost } from "../native-process/observer.ts";
import { encodeNativeLaunch, type NativeLaunch, type NativeWriteResult } from "../native-process/protocol.ts";
import { NativeProcessTransport, type NativeCustodySettlement, type NativeProcessOptions } from "../native-process/transport.ts";
import type { StateStore } from "../storage/state-store.ts";
import type { DaemonAuthorityFence, DaemonLock } from "./daemon-lock.ts";

type Transport = Pick<NativeProcessTransport, "ready" | "rootExited" | "joined" | "transportCompleted"
  | "stdout" | "stderr" | "write" | "closeInput" | "requestStop" | "forceStop">;
type Reservation = Omit<ProviderProcessReservation, "nonce" | "launchContext" | "daemon">;
export type NativeProviderProcessOptions = Readonly<{
  store: StateStore; lock: DaemonLock; fence: DaemonAuthorityFence;
  /** Product-owned, admitted immutable artifact. Never read from provider RPC. */
  helperExecutable: () => string;
  reservation: Reservation;
  launch: Omit<NativeLaunch, "nonce" | "scope"> & { scope: "posix-process-group" };
  /** Trusted host composition seams for deterministic tests. */
  observeHost?: typeof observeNativeHost;
  transportFactory?: (options: NativeProcessOptions) => Transport;
}>;

/** Compose physical process custody with Oompa's existing authority and journal.
 * The shared transport owns neither account policy nor durable release. */
export class NativeProviderProcess {
  readonly #options: NativeProviderProcessOptions;
  readonly #transport: Transport;
  readonly #bindingDigest: string;
  #row: ProviderProcessInvocation;
  #closing = false;
  #releaseTask: Promise<void> | null = null;

  readonly ready: Transport["ready"];
  readonly rootExited: Transport["rootExited"];
  readonly joined: Transport["joined"];
  readonly transportCompleted: Transport["transportCompleted"];
  readonly stdout: Transport["stdout"];
  readonly stderr: Transport["stderr"];

  private constructor(options: NativeProviderProcessOptions, row: ProviderProcessInvocation, launch: NativeLaunch) {
    options = Object.freeze({ ...options });
    this.#options = options;
    this.#row = row;
    this.#bindingDigest = row.bindingDigest;
    this.#transport = (options.transportFactory ?? (input => new NativeProcessTransport(input)))({
      helperExecutable: options.helperExecutable(), launch,
      onPrepared: async prepared => {
        this.#assertFiles();
        options.fence.assertCurrentSynchronously();
        if (this.#closing) throw Error("PROVIDER_PROCESS_CUSTODY_STALE");
        this.#row = options.store.prepareProviderProcessInvocation({ ...this.#transition(), prepared });
      },
      beforeActivate: () => { this.#assertDispatch("prepared"); },
      onReady: async ready => {
        this.#assertDispatch("prepared");
        this.#row = options.store.markProviderProcessInvocationRunning({ ...this.#transition(), ready });
      },
    });
    this.ready = this.#transport.ready;
    this.rootExited = this.#transport.rootExited;
    this.joined = this.#transport.joined;
    this.transportCompleted = this.#transport.transportCompleted;
    this.stdout = this.#transport.stdout;
    this.stderr = this.#transport.stderr;
    // Retire the durable writer barrier after actual closure even if the RPC or
    // stream consumer failed. A failed commit remains retryable on this handle.
    void this.releaseCustody().catch(() => {});
  }

  static async launch(options: NativeProviderProcessOptions): Promise<NativeProviderProcess> {
    options = Object.freeze({ ...options });
    const reservation = structuredClone(options.reservation);
    const nonce = randomBytes(16).toString("hex");
    const launch: NativeLaunch = structuredClone({ ...options.launch, nonce });
    if (launch.scope !== "posix-process-group") throw Error("PROVIDER_PROCESS_SCOPE_UNQUALIFIED");
    encodeNativeLaunch(launch); // Reject malformed input before reserving a row.
    await options.fence.assertCurrent();
    const observed = await (options.observeHost ?? observeNativeHost)({ helperExecutable: options.helperExecutable() });
    options.fence.assertCurrentSynchronously();
    const receipt = options.lock.receipt;
    if (receipt.generation !== options.fence.authority.generation || receipt.bootId !== options.fence.authority.bootId) {
      throw Error("PROVIDER_PROCESS_CUSTODY_STALE");
    }
    const row = options.store.reserveProviderProcessInvocation({ ...reservation, nonce,
      daemon: { daemonGeneration: options.fence.authority.generation, bootId: options.fence.authority.bootId },
      launchContext: { ...observed.context, localFiles: {
        authority: options.lock.nativeFileIdentity(), state: options.store.nativeFileIdentity(),
      } },
    });
    // No await between reservation and helper construction. A constructor
    // failure leaves the durable prefix for held-lock startup recovery.
    return new NativeProviderProcess(options, row, launch);
  }

  #transition(): Readonly<{ nonce: string; expectedRevision: number; daemon: ProviderProcessInvocation["daemon"] }> {
    return { nonce: this.#row.nonce, expectedRevision: this.#row.revision, daemon: this.#row.daemon };
  }

  #assertFiles(): void {
    const current = { authority: this.#options.lock.nativeFileIdentity(), state: this.#options.store.nativeFileIdentity() };
    if (!isDeepStrictEqual(current, this.#row.launchContext.localFiles)) throw Error("PROVIDER_PROCESS_CUSTODY_STALE");
  }

  #assertDispatch(state: "prepared" | "running"): void {
    if (this.#closing) throw Error("PROVIDER_PROCESS_CUSTODY_STALE");
    this.#assertFiles();
    this.#options.fence.assertCurrentSynchronously();
    this.#options.store.assertProviderProcessInvocationCurrent({ ...this.#transition(), state });
  }

  write(bytes: Uint8Array): Promise<NativeWriteResult> {
    try {
      this.#assertDispatch("running");
      const expectedBytes = bytes.byteLength;
      // The transport checks readiness and queues synchronously. No await can
      // reopen the interval between this product fence and native dispatch.
      return this.#transport.write(bytes).then(result => {
        if (result.outcome !== "accepted-full" || result.acceptedBytes !== expectedBytes) this.forceStop();
        return result;
      }).catch((error: unknown) => { this.forceStop(); throw error; });
    } catch (error) { this.forceStop(); return Promise.reject(error); }
  }

  closeInput(): Promise<void> { this.#closing = true; return this.#transport.closeInput(); }
  requestStop(): void { this.#closing = true; this.#transport.requestStop(); }
  forceStop(): void { this.#closing = true; this.#transport.forceStop(); }

  releaseCustody(): Promise<void> {
    if (this.#releaseTask !== null) return this.#releaseTask;
    const task = this.#transport.joined.then(settlement => { this.#commitRelease(settlement); });
    this.#releaseTask = task;
    void task.catch(() => { if (this.#releaseTask === task) this.#releaseTask = null; });
    return task;
  }

  #commitRelease(settlement: NativeCustodySettlement): void {
    this.#closing = true;
    if (settlement.binding.scope !== "posix-process-group") throw Error("PROVIDER_PROCESS_CUSTODY_UNPROVED");
    this.#assertFiles();
    const current = this.#options.store.readProviderProcessInvocation(this.#row.nonce);
    if (current === null || current.bindingDigest !== this.#bindingDigest) {
      throw Error("PROVIDER_PROCESS_CUSTODY_STALE");
    }
    // A commit can succeed before its caller observes failure. Reconcile the
    // exact durable invocation instead of replaying a stale local transition.
    // This path grants closure only; it can never admit another provider write.
    this.#row = current;
    if (current.state === "released") return;
    this.#row = this.#options.store.beginProviderProcessInvocationRelease(this.#transition());
    const issuer = createProviderProcessReleaseProofIssuer("live-process");
    const proof = issuer.issue({ kind: "native-settled", nonce: this.#row.nonce, bindingDigest: this.#bindingDigest,
      expectedRevision: this.#row.revision, observedAt: Date.now(), actor: { kind: "live-daemon", daemon: this.#row.daemon },
      observed: { ...settlement, binding: { ...settlement.binding, scope: "posix-process-group" } },
      committedPrepared: this.#row.prepared, committedReady: this.#row.ready });
    this.#row = this.#options.store.releaseProviderProcessInvocation({ ...this.#transition(), proof });
  }

  stopAndRelease(): Promise<void> { this.requestStop(); return this.releaseCustody(); }
}
