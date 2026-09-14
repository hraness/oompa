import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { isAbsolute } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { nativePreparedOfReady } from "../domain/native-process-identity.ts";
import { NativeByteQueue } from "./byte-queue.ts";
import {
  encodeNativeFrame, encodeNativeLaunch, encodeNativeWrite, NativeCommandKind,
  NativeFrameDecoder, NativeProtocolError, parseNativeEvent,
  type NativeBinding, type NativeEvent, type NativeFailureReason, type NativeLaunch,
  type NativePrepared, type NativeReady, type NativeRootExit, type NativeWriteResult,
} from "./protocol.ts";

export class NativeProcessError extends Error {
  constructor(readonly reason: NativeFailureReason | "not-ready" | "not-writable" | "write-in-flight" | "admission-failed") {
    super(`Native process failed: ${reason}.`);
    this.name = "NativeProcessError";
  }
}

type Deferred<T> = Readonly<{
  promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void;
}>;
function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {};
  let reject: (reason: unknown) => void = () => {};
  const promise = new Promise<T>((accept, refuse) => { resolve = accept; reject = refuse; });
  // This owner observes rejection even before the consumer reaches readiness.
  void promise.catch(() => {});
  return { promise, resolve, reject };
}

export type NativeCustodySettlement = Readonly<{
  kind: "joined" | "not-started";
  binding: NativeBinding;
  prepared: NativePrepared | null;
  ready: NativeReady | null;
}>;

export interface NativeProcessOptions {
  /** The product artifact resolver must admit this exact executable first. */
  readonly helperExecutable: string;
  readonly launch: NativeLaunch;
  /** Commit the exact prepared scope before activation can be transmitted. */
  readonly onPrepared: (prepared: NativePrepared) => Promise<void>;
  /** Last synchronous product authority check immediately before Activate. */
  readonly beforeActivate: () => void;
  /** Commit actual root identity before the public ready promise resolves. */
  readonly onReady: (ready: NativeReady) => Promise<void>;
}

type PendingWrite = Readonly<{ id: number; bytes: number; result: Deferred<NativeWriteResult> }>;

/** Physical process/pipe transport. Product RPC, authority and journals remain
 * outside this owner. Construction starts one already-reserved invocation. */
export class NativeProcessTransport {
  readonly #options: NativeProcessOptions;
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #ready = deferred<NativeReady>();
  readonly #rootExited = deferred<NativeRootExit>();
  readonly #joined = deferred<NativeCustodySettlement>();
  readonly #transportCompleted = deferred<undefined>();
  readonly #stdout: NativeByteQueue;
  readonly #stderr: NativeByteQueue;
  readonly #inputClosed = deferred<undefined>();
  #prepared: NativePrepared | null = null;
  #readyValue: NativeReady | null = null;
  #terminal: "joined" | "not-started" | null = null;
  #rootExitSeen = false;
  #providerEvidenceSeen = false;
  #stdinEndSeen = false;
  #activated = false;
  #admissionOpen = false;
  #stopping = false;
  #inputClosing = false;
  #protocolFailed = false;
  #finished = false;
  #helperExited = false;
  #readyCommitted = false;
  #pending: PendingWrite | null = null;
  #nextWriteId = 1;
  #operationFailure: NativeProcessError | null = null;
  #startupTimer: ReturnType<typeof setTimeout> | undefined;
  #cleanupTimer: ReturnType<typeof setTimeout> | undefined;
  #writeTimer: ReturnType<typeof setTimeout> | undefined;
  #inputTimer: ReturnType<typeof setTimeout> | undefined;

  readonly ready: Promise<NativeReady>;
  readonly rootExited: Promise<NativeRootExit>;
  readonly joined: Promise<NativeCustodySettlement>;
  /** Successful physical cleanup does not erase a failed transport operation. */
  readonly transportCompleted: Promise<undefined>;
  readonly stdout: AsyncIterable<Uint8Array>;
  readonly stderr: AsyncIterable<Uint8Array>;

  constructor(options: NativeProcessOptions) {
    if (!isAbsolute(options.helperExecutable)) throw new NativeProtocolError();
    const launchFrame = encodeNativeLaunch(options.launch);
    // Retain an independent immutable launch snapshot; caller mutation cannot
    // change the binding used to admit later native observations.
    this.#options = { ...options, launch: structuredClone(options.launch) };
    this.#stdout = new NativeByteQueue(1024 * 1024, () => { this.#operationFailed("output-failed"); });
    this.#stderr = new NativeByteQueue(1024 * 1024, () => { this.#operationFailed("output-failed"); });
    this.ready = this.#ready.promise;
    this.rootExited = this.#rootExited.promise;
    this.joined = this.#joined.promise;
    this.transportCompleted = this.#transportCompleted.promise;
    this.stdout = this.#stdout;
    this.stderr = this.#stderr;
    void Promise.all([this.#joined.promise, this.#stdout.delivered, this.#stderr.delivered]).then(() => {
      if (this.#operationFailure === null) this.#transportCompleted.resolve(undefined);
    }).catch((error: unknown) => { this.#transportCompleted.reject(error); });
    this.#child = spawn(options.helperExecutable, [], {
      cwd: options.launch.cwd, env: {}, shell: false, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    });
    this.#child.stdin.on("error", () => {
      if (!this.#stopping) { this.#operationFailed("controller-lost"); this.forceStop(); }
    });
    this.#child.on("error", () => { this.#refuseTransport("spawn-failed"); });
    // Observe process exit independently of a backpressured output pump or a
    // product persistence callback. Neither can indefinitely hold final join.
    this.#child.once("exit", () => { this.#helperExited = true; this.#admissionOpen = false; this.#armCleanupDeadline(); });
    const closed = new Promise<Readonly<{ code: number | null; signal: NodeJS.Signals | null }>>(resolve => {
      this.#child.once("close", (code, signal) => { this.#armCleanupDeadline(); resolve({ code, signal }); });
    });
    const output = this.#consumeOutput();
    const diagnostics = this.#consumeDiagnostics();
    void Promise.all([closed, output, diagnostics]).then(([exit]) => {
      this.#finish(exit.code, exit.signal);
    }).catch(() => { this.#refuseTransport("cleanup-unproven"); });
    this.#startupTimer = setTimeout(() => {
      if (!this.#readyCommitted && this.#terminal === null) {
        this.#operationFailed("deadline");
        this.forceStop();
      }
    }, 30_000);
    this.#send(launchFrame);
  }

  write(bytes: Uint8Array): Promise<NativeWriteResult> {
    // No await before admission: readiness and queue availability must already
    // be true when the product reaches its final authority-checked call.
    if (this.#readyValue === null) return Promise.reject(new NativeProcessError("not-ready"));
    if (!this.#admissionOpen || this.#inputClosing) return Promise.reject(new NativeProcessError("not-writable"));
    if (this.#pending !== null) return Promise.reject(new NativeProcessError("write-in-flight"));
    const id = this.#nextWriteId;
    const frame = encodeNativeWrite(id, bytes);
    this.#nextWriteId += 1;
    const result = deferred<NativeWriteResult>();
    this.#pending = { id, bytes: bytes.byteLength, result };
    // The helper's deadline cannot advance while it is stopped. Keep a host
    // bound as well; missing acknowledgement means unknown dispatch, not zero.
    this.#writeTimer = setTimeout(() => {
      this.#operationFailed("deadline");
      this.#pending?.result.resolve({ id, outcome: "indeterminate", acceptedBytes: 0 });
      this.forceStop();
    }, this.#options.launch.writeTimeoutMs + 1000);
    this.#send(frame);
    return result.promise;
  }

  closeInput(): Promise<void> {
    this.#admissionOpen = false;
    if (!this.#inputClosing && !this.#finished && !this.#stdinEndSeen) {
      this.#inputClosing = true;
      this.#inputTimer = setTimeout(() => {
        this.#operationFailed("deadline");
        this.#inputClosed.reject(new NativeProcessError("deadline"));
        this.forceStop();
      }, this.#options.launch.writeTimeoutMs + 1000);
      if (this.#pending !== null) this.forceStop();
      else this.#sendCommand(NativeCommandKind.closeInput);
    }
    return this.#inputClosed.promise;
  }

  requestStop(): void {
    this.#admissionOpen = false;
    if (this.#stopping || this.#finished) return;
    this.#stopping = true;
    this.#unblockDrain();
    this.#armCleanupDeadline();
    if (this.#pending !== null || !this.#activated) this.#child.stdin.destroy();
    else this.#sendCommand(NativeCommandKind.stop);
  }

  forceStop(): void {
    this.#admissionOpen = false;
    if (this.#finished) return;
    this.#stopping = true;
    this.#unblockDrain();
    this.#armCleanupDeadline();
    // Closing the exact controller writer is independent of a queued large
    // frame. The native scope anchor observes hangup even if its supervisor is
    // stopped. No saved PID or group number is signaled here.
    this.#child.stdin.destroy();
  }

  stopAndJoin(): Promise<NativeCustodySettlement> {
    this.requestStop();
    return this.joined;
  }

  async #consumeOutput(): Promise<void> {
    const parser = new NativeFrameDecoder("events");
    try {
      for await (const value of this.#child.stdout) {
        if (!(value instanceof Uint8Array)) throw new NativeProtocolError();
        for (let offset = 0; offset < value.byteLength; offset += 64 * 1024) {
          for (const frame of parser.push(value.subarray(offset, offset + 64 * 1024))) {
            await this.#observe(parseNativeEvent(frame));
          }
        }
      }
      parser.finish();
    } catch {
      this.#protocolFailed = true;
      this.#operationFailed("invalid-frame");
      this.forceStop();
      throw new NativeProtocolError();
    }
  }

  async #consumeDiagnostics(): Promise<void> {
    let bytes = 0;
    for await (const value of this.#child.stderr) {
      if (!(value instanceof Uint8Array)) throw new NativeProtocolError();
      bytes += value.byteLength;
      if (bytes > 4096) {
        this.#protocolFailed = true;
        this.forceStop();
        throw new NativeProtocolError();
      }
      // Native diagnostics are deliberately not retained or forwarded.
    }
  }

  async #observe(event: NativeEvent): Promise<void> {
    if (this.#terminal !== null) throw new NativeProtocolError();
    switch (event.kind) {
      case "prepared": {
        if (this.#prepared !== null || this.#activated || this.#rootExitSeen) throw new NativeProtocolError();
        this.#assertBinding(event.value);
        if (event.value.supervisor.pid !== this.#child.pid) throw new NativeProtocolError();
        this.#prepared = structuredClone(event.value);
        // Persistence can be slow or fail. Keep reading native observations
        // independently, but never activate until that exact commit succeeds.
        void this.#prepareAndActivate(event.value);
        return;
      }
      case "ready": {
        if (!this.#activated || this.#prepared === null || this.#readyValue !== null || this.#providerEvidenceSeen
          || !isDeepStrictEqual(nativePreparedOfReady(event.value), this.#prepared)) throw new NativeProtocolError();
        this.#readyValue = structuredClone(event.value);
        void this.#commitReady(event.value);
        return;
      }
      case "stdout":
      case "stderr": {
        if (!this.#activated) throw new NativeProtocolError();
        this.#providerEvidenceSeen = true;
        await (event.kind === "stdout" ? this.#stdout : this.#stderr).push(event.bytes);
        return;
      }
      case "writeResult": {
        const pending = this.#pending;
        if (pending === null || event.value.id !== pending.id || event.value.acceptedBytes > pending.bytes
          || (event.value.outcome === "accepted-full" && event.value.acceptedBytes !== pending.bytes)
          || (event.value.outcome === "partial-known" && event.value.acceptedBytes >= pending.bytes)) throw new NativeProtocolError();
        this.#pending = null;
        clearTimeout(this.#writeTimer);
        pending.result.resolve(event.value);
        if (event.value.outcome !== "accepted-full") this.#admissionOpen = false;
        return;
      }
      case "rootExit": {
        if (!this.#activated || this.#rootExitSeen) throw new NativeProtocolError();
        this.#rootExitSeen = true;
        this.#providerEvidenceSeen = true;
        this.#admissionOpen = false;
        this.#rootExited.resolve(event.value);
        this.#armCleanupDeadline();
        return;
      }
      case "streamEnd": {
        if (!this.#activated) throw new NativeProtocolError();
        this.#providerEvidenceSeen = true;
        if (event.stream === "stdin") {
          if (this.#stdinEndSeen) throw new NativeProtocolError();
          if (this.#pending !== null) {
            // Controller loss can truncate a Write before native decoding, so
            // there may be no receipt ID. Closed native stdin fences its future
            // delivery, but cannot retroactively prove zero bytes dispatched.
            this.#pending.result.resolve({ id: this.#pending.id, outcome: "indeterminate", acceptedBytes: 0 });
            this.#pending = null;
            clearTimeout(this.#writeTimer);
            this.#operationFailed("write-failed");
          }
          this.#stdinEndSeen = true;
          this.#admissionOpen = false;
          clearTimeout(this.#inputTimer);
          this.#inputClosed.resolve(undefined);
        } else (event.stream === "stdout" ? this.#stdout : this.#stderr).end();
        return;
      }
      case "failure": this.#operationFailed(event.reason); return;
      case "joined": {
        this.#assertBinding(event.value);
        if (this.#prepared === null || !this.#activated || !this.#rootExitSeen || !this.#stdinEndSeen
          || !this.#stdout.nativeEofObserved || !this.#stderr.nativeEofObserved || this.#pending !== null) throw new NativeProtocolError();
        this.#terminal = "joined";
        this.#armCleanupDeadline();
        return;
      }
      case "notStarted": {
        this.#assertBinding(event.value);
        if (this.#readyValue !== null || this.#providerEvidenceSeen || this.#pending !== null) throw new NativeProtocolError();
        this.#terminal = "not-started";
        this.#armCleanupDeadline();
        return;
      }
    }
  }

  async #prepareAndActivate(prepared: NativePrepared): Promise<void> {
    try {
      await this.#options.onPrepared(structuredClone(prepared));
      if (!this.#canActivate()) return;
      this.#options.beforeActivate();
      if (!this.#canActivate()) return;
      this.#activated = true;
      this.#sendCommand(NativeCommandKind.activate);
    } catch { this.#operationFailed("admission-failed"); this.forceStop(); }
  }

  #canActivate(): boolean {
    return !this.#stopping && !this.#finished && !this.#helperExited && this.#terminal === null && this.#operationFailure === null;
  }

  async #commitReady(ready: NativeReady): Promise<void> {
    try {
      await this.#options.onReady(structuredClone(ready));
      if (!this.#canActivate() || this.#rootExitSeen || this.#stdinEndSeen || this.#inputClosing) {
        this.#ready.reject(this.#operationFailure ?? new NativeProcessError("not-writable"));
        return;
      }
      clearTimeout(this.#startupTimer);
      this.#readyCommitted = true;
      this.#admissionOpen = true;
      this.#ready.resolve(structuredClone(ready));
    } catch { this.#operationFailed("admission-failed"); this.forceStop(); }
  }

  #assertBinding(binding: NativeBinding): void {
    if (binding.nonce !== this.#options.launch.nonce || binding.scope !== this.#options.launch.scope) throw new NativeProtocolError();
  }

  #sendCommand(kind: number): void { this.#send(encodeNativeFrame(kind, new Uint8Array(), "commands")); }

  #send(frame: Uint8Array): void {
    if (this.#child.stdin.destroyed) {
      if (!this.#stopping) { this.#operationFailed("controller-lost"); this.forceStop(); }
      return;
    }
    this.#child.stdin.write(frame, error => {
      if (error !== null && error !== undefined && !this.#stopping) {
        this.#operationFailed("controller-lost");
        this.forceStop();
      }
    });
  }

  #operationFailed(reason: NativeFailureReason | "admission-failed"): void {
    this.#operationFailure ??= new NativeProcessError(reason);
    this.#admissionOpen = false;
    this.#ready.reject(this.#operationFailure);
    this.#transportCompleted.reject(this.#operationFailure);
    this.#stdout.fail(this.#operationFailure);
    this.#stderr.fail(this.#operationFailure);
    this.#armCleanupDeadline();
  }

  #unblockDrain(): void {
    const error = this.#operationFailure ?? new NativeProcessError("not-writable");
    this.#stdout.fail(error);
    this.#stderr.fail(error);
  }

  #armCleanupDeadline(): void {
    if (this.#cleanupTimer !== undefined || this.#finished) return;
    this.#cleanupTimer = setTimeout(() => {
      this.forceStop();
      this.#refuseTransport("cleanup-unproven");
    }, this.#options.launch.termGraceMs + this.#options.launch.settlementMs + 1000);
  }

  #finish(code: number | null, signal: NodeJS.Signals | null): void {
    clearTimeout(this.#startupTimer);
    clearTimeout(this.#cleanupTimer);
    clearTimeout(this.#writeTimer);
    clearTimeout(this.#inputTimer);
    this.#admissionOpen = false;
    if (this.#protocolFailed || code !== 0 || signal !== null || this.#terminal === null) {
      this.#refuseTransport("cleanup-unproven");
      return;
    }
    this.#finished = true;
    // A provider that retires while readiness persistence is unresolved cannot
    // report a successful operation. Its native scope may still be fully joined;
    // a later callback cannot upgrade this already failed admission.
    if (this.#terminal === "joined" && !this.#readyCommitted) this.#operationFailed("admission-failed");
    const error = this.#operationFailure ?? new NativeProcessError("spawn-failed");
    this.#ready.reject(error);
    if (!this.#rootExitSeen) this.#rootExited.reject(error);
    if (!this.#stdinEndSeen) this.#inputClosed.reject(error);
    if (this.#terminal === "not-started") {
      this.#operationFailed("spawn-failed");
    }
    this.#joined.resolve({ kind: this.#terminal,
      binding: { version: 1, nonce: this.#options.launch.nonce, scope: this.#options.launch.scope },
      prepared: this.#prepared === null ? null : structuredClone(this.#prepared),
      ready: this.#readyValue === null ? null : structuredClone(this.#readyValue),
    });
  }

  #refuseTransport(reason: NativeFailureReason): void {
    this.#finished = true;
    clearTimeout(this.#startupTimer);
    clearTimeout(this.#cleanupTimer);
    clearTimeout(this.#writeTimer);
    clearTimeout(this.#inputTimer);
    this.#operationFailed(reason);
    this.#protocolFailed = true;
    const error = new NativeProcessError(reason);
    this.#rootExited.reject(error);
    this.#joined.reject(error);
    this.#inputClosed.reject(error);
    if (this.#pending !== null) this.#pending.result.resolve({ id: this.#pending.id, outcome: "indeterminate", acceptedBytes: 0 });
    this.#pending = null;
    this.#stdout.fail(error);
    this.#stderr.fail(error);
    this.#child.stdin.destroy();
  }
}
