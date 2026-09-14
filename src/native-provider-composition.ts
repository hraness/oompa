import { launchPinnedCodexAppServer, type LaunchPinnedCodexOptions } from "./codex/runtime.ts";
import { nativeCodexRuntimeContractDigest, spawnNativeCodexProcess, type NativeCodexProcessOwner } from "./codex/native-process.ts";
import { validateAuthority } from "./codex/protocol.ts";
import { NativeProviderProcess } from "./daemon/native-provider-process.ts";
import type { DaemonAuthorityFence, DaemonLock } from "./daemon/daemon-lock.ts";
import { codexProviderAccountAuthoritySchema } from "./domain/provider-accounts.ts";
import type { StateStore } from "./storage/state-store.ts";
import { NativeObservationError } from "./native-process/observer.ts";
// Staged source import is replaced by the exact immutable package dependency at
// consumer cutover. Product policy remains in this composition root.
import { nativeArtifactExecutable, nativeArtifactIdentity,
  type AdmittedNativeArtifact } from "../packages/native-process/src/artifact-resolver.ts";

export type NativeCodexComposition = Readonly<{
  store: StateStore; lock: DaemonLock; fence: DaemonAuthorityFence;
  artifact: AdmittedNativeArtifact; cwd: string;
}>;

export class NativeProviderCompositionClosedError extends Error {
  constructor() { super("Native provider launch admission is closed."); this.name = "NativeProviderCompositionClosedError"; }
}
export class NativeProviderCompositionCleanupError extends Error {
  constructor() { super("Native provider launches or durable process custody remain unsettled."); this.name = "NativeProviderCompositionCleanupError"; }
}

type RetainedOwner = { readonly owner: NativeCodexProcessOwner; release: Promise<void> | null };
function notification(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

/** Daemon-local lifetime ownership, independent of RPC/session semantics.
 * The application must start close concurrently with manager shutdown, then
 * join it before closing its store/lock. Failed native releases retain exact
 * handles for cleanup retry, never launch replay. Unknown observer cleanup,
 * late client cleanup failure, or an escaped factory lifetime permanently
 * refuses successful close; the daemon must retain its state for recovery. */
export class NativeProviderProcessRegistry {
  readonly #owners = new Map<NativeCodexProcessOwner, RetainedOwner>();
  readonly #seenOwners = new WeakSet<NativeCodexProcessOwner>();
  readonly #launches = new Set<Promise<void>>();
  readonly #termGraceMs: number;
  readonly #settlementMs: number;
  #open = true;
  #forceClosing = false;
  #changed = notification();
  #closeTask: Promise<void> | null = null;
  #closeSucceeded = false;
  #unprovedCleanup = false;

  constructor(limits: Readonly<{ termGraceMs?: number; settlementMs?: number }> = {}) {
    const grace = limits.termGraceMs ?? 2000, settlement = limits.settlementMs ?? 1000;
    if (![grace, settlement].every(value => Number.isSafeInteger(value) && value >= 1 && value <= 30_000)) {
      throw Error("NATIVE_PROVIDER_COMPOSITION_LIMIT_INVALID");
    }
    this.#termGraceMs = grace;
    this.#settlementMs = settlement;
  }

  /** Register the full launch before invoking any factory code, including
   * synchronous exceptions or reentrant shutdown. Retain each constructed
   * native owner before awaiting its readiness or Codex initialization. */
  runLaunch<T>(factory: (retain: (owner: NativeCodexProcessOwner) => void) => T | PromiseLike<T>,
    closeLateResult?: (result: T) => Promise<void>): Promise<T> {
    if (!this.#open) return Promise.reject(new NativeProviderCompositionClosedError());
    let resolve!: (value: T | PromiseLike<T>) => void, reject!: (error: unknown) => void;
    const result = new Promise<T>((done, failed) => { resolve = done; reject = failed; });
    let factorySettled = false;
    const retained = new Set<RetainedOwner>();
    const settled = result.then(() => {}, () => {
      for (const entry of retained) if (this.#owners.get(entry.owner) === entry) this.#stop(entry);
    });
    this.#launches.add(settled);
    void settled.then(() => { this.#launches.delete(settled); this.#notify(); });
    const failed = (error: unknown): void => {
      factorySettled = true;
      // An observer can fail before any native provider handle exists. Its
      // rejected cleanup is not erased by an otherwise empty owner registry.
      if (error instanceof NativeObservationError && error.reason === "cleanup-unproven") this.#retainUnknownCleanup();
      reject(error);
    };
    try {
      const produced = factory(owner => {
        if (this.#seenOwners.has(owner)) throw Error("NATIVE_PROVIDER_OWNER_ALREADY_RETAINED");
        const entry: RetainedOwner = { owner, release: null };
        this.#seenOwners.add(owner);
        this.#owners.set(owner, entry);
        retained.add(entry);
        this.#release(entry);
        if (factorySettled) {
          // A trusted factory violated its lifetime: preserve the late handle
          // for cleanup and invalidate any cached success, never drop custody.
          this.#retainUnknownCleanup();
          this.#stop(entry);
          throw Error("NATIVE_PROVIDER_LAUNCH_ALREADY_SETTLED");
        }
        if (!this.#open) this.#stop(entry);
        this.#notify();
      });
      void Promise.resolve(produced).then(value => {
        factorySettled = true;
        if (!this.#open) {
          const closed = new NativeProviderCompositionClosedError();
          void Promise.resolve().then(async () => { await closeLateResult?.(value); }).then(() => { reject(closed); }, (error: unknown) => {
            this.#retainUnknownCleanup();
            reject(new AggregateError([closed, error], "Native provider initialization finished after shutdown and client cleanup failed."));
          });
          return;
        }
        // No promise hop between final admission and exposing the result.
        resolve(value);
      }, failed);
    } catch (error) { failed(error); }
    return result;
  }

  /** Recheck immediately before every helper spawn after asynchronous runtime
   * or host admission. A resulting reserved prefix stays in the durable census. */
  assertAdmission(): void {
    if (!this.#open) throw new NativeProviderCompositionClosedError();
  }

  /** Fence first so a stop callback cannot reenter provider admission. */
  closeAdmission(): void {
    if (!this.#open) return;
    this.#open = false;
    for (const entry of this.#owners.values()) this.#stop(entry);
    this.#notify();
  }

  close(): Promise<void> {
    this.closeAdmission();
    if (this.#closeTask !== null) return this.#closeTask;
    // Defer work one microtask so the close promise is retained before an
    // owner's synchronous release/stop callback can reenter close().
    const task = Promise.resolve().then(async () => { await this.#closeOwned(); }).then(() => {
      // Settlement itself crosses promise boundaries. Recheck at the actual
      // success commit so a late retained owner cannot leave cached success.
      if (!this.#empty()) throw new NativeProviderCompositionCleanupError();
      this.#closeSucceeded = true;
    });
    this.#closeTask = task;
    void task.catch(() => { if (this.#closeTask === task) this.#closeTask = null; });
    return task;
  }

  #stop(entry: RetainedOwner): void {
    try { entry.owner.requestStop(); } catch { /* Only exact release proves closure. */ }
    if (this.#forceClosing) {
      try { entry.owner.forceStop(); } catch { /* Retain until release is observed. */ }
    }
  }

  #release(entry: RetainedOwner): void {
    if (entry.release !== null || this.#owners.get(entry.owner) !== entry) return;
    // Retain the attempt before calling an owner that could reenter us.
    const task = Promise.resolve().then(async () => { await entry.owner.releaseCustody(); });
    entry.release = task;
    void task.then(() => {
      if (this.#owners.get(entry.owner) === entry) this.#owners.delete(entry.owner);
      this.#notify();
    }, () => {
      if (entry.release === task) entry.release = null;
      this.#notify();
    });
  }

  #notify(): void {
    const previous = this.#changed;
    this.#changed = notification();
    previous.resolve();
  }

  #retainUnknownCleanup(): void {
    this.#unprovedCleanup = true;
    if (this.#closeSucceeded) { this.#closeTask = null; this.#closeSucceeded = false; }
    this.closeAdmission();
    this.#notify();
  }

  #empty(): boolean { return !this.#unprovedCleanup && this.#owners.size === 0 && this.#launches.size === 0; }

  async #settlesWithin(durationMs: number): Promise<boolean> {
    if (this.#empty()) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"expired">(done => { timer = setTimeout(() => { done("expired"); }, durationMs); });
    try {
      for (;;) {
        if (this.#empty()) return true;
        if (await Promise.race([this.#changed.promise, timeout]) === "expired") return this.#empty();
      }
    } finally { clearTimeout(timer); }
  }

  async #closeOwned(): Promise<void> {
    for (const entry of this.#owners.values()) { this.#stop(entry); this.#release(entry); }
    if (await this.#settlesWithin(this.#termGraceMs)) return;
    this.#forceClosing = true;
    for (const entry of this.#owners.values()) { this.#stop(entry); this.#release(entry); }
    if (!await this.#settlesWithin(this.#settlementMs)) throw new NativeProviderCompositionCleanupError();
  }
}

/** Trusted daemon composition. The runtime manager keeps its provider protocol
 * and authority policy; the shared package receives only its launch contract.
 * There is no raw executable path or process-factory option on a public RPC. */
export function createNativeCodexComposition(input: NativeCodexComposition): Readonly<{
  launchClient: (scope: "managed" | "personal") => typeof launchPinnedCodexAppServer;
  closeAdmission: () => void;
  close: () => Promise<void>;
}> {
  const composition = Object.freeze({ ...input });
  const artifactIdentity = nativeArtifactIdentity(composition.artifact);
  const registry = new NativeProviderProcessRegistry();
  const launchClient = (runtimeScope: "managed" | "personal"): typeof launchPinnedCodexAppServer => {
    if (!["managed", "personal"].includes(runtimeScope)) throw Error("PROVIDER_PROCESS_SCOPE_INVALID");
    return (options: LaunchPinnedCodexOptions) => registry.runLaunch(async retain => {
      if (options.processFactory !== undefined) throw Error("PROVIDER_PROCESS_FACTORY_ALREADY_COMPOSED");
      const authority = validateAuthority(options.authority);
      const providerAuthority = codexProviderAccountAuthoritySchema.parse({ provider: "codex", profileId: authority.profileId,
        providerAccountId: authority.providerAccountId, bindingGeneration: authority.bindingGeneration,
        processGeneration: authority.processGeneration });
      return await launchPinnedCodexAppServer({ ...options, authority,
        processFactory: async runtimeInput => await spawnNativeCodexProcess({ ...runtimeInput, cwd: composition.cwd,
          launchProcess: async launch => {
            registry.assertAdmission();
            const owner = await NativeProviderProcess.launch({
              store: composition.store, lock: composition.lock, fence: composition.fence,
              helperExecutable: () => { registry.assertAdmission(); return nativeArtifactExecutable(composition.artifact); },
              reservation: { providerAuthority, profileGeneration: authority.processGeneration,
                runtimeScope, artifactDigest: artifactIdentity.artifact.sha256,
                runtimeDigest: nativeCodexRuntimeContractDigest(runtimeInput.runtime) },
              launch,
            });
            retain(owner);
            return owner;
          },
        }),
      });
    }, async client => { await client.close(); });
  };
  return Object.freeze({ launchClient, closeAdmission: () => { registry.closeAdmission(); }, close: () => registry.close() });
}
