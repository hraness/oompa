import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { isAbsolute } from "node:path";

import {
  encodeNativeObservationRequest, NativeObservationDecoder, nativeHostRequestSchema,
  nativeScopeRequestSchema, parseNativeHostObservation, parseNativeScopeObservation,
  type NativeHostObservation, type NativeScopeObservation, type NativeScopeRequest,
} from "./observation-protocol.ts";

export class NativeObservationError extends Error {
  constructor(readonly reason: "invalid-request" | "observation-unproved" | "cleanup-unproven") {
    super(`Native observation failed: ${reason}.`);
    this.name = "NativeObservationError";
  }
}
export interface NativeObserverOptions {
  /** The product owns immutable artifact admission for this executable. */
  readonly helperExecutable: string;
  readonly signal?: AbortSignal;
  readonly deadlineMs?: number;
}

/** This mode spawns no provider or descendants. The exact owned observer child
 * may be killed on its independent deadline; no persisted PID is signaled. */
function exchange(mode: "host" | "scopes", frame: Uint8Array, options: NativeObserverOptions): Promise<unknown> {
  const deadlineMs = options.deadlineMs ?? 3000;
  if (!isAbsolute(options.helperExecutable) || !Number.isSafeInteger(deadlineMs)
    || deadlineMs < 1 || deadlineMs > 5000 || options.signal?.aborted === true) {
    return Promise.reject(new NativeObservationError("invalid-request"));
  }
  return new Promise((resolve, reject) => {
    const decoder = new NativeObservationDecoder(mode);
    const child = spawn(options.helperExecutable, [mode === "host" ? "--host-context" : "--observe-custody"], {
      cwd: "/", env: {}, shell: false, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    });
    let failed = false;
    let exited = false;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let stdoutEnded = false;
    let stderrEnded = false;
    let finished = false;
    let stopping = false;
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    const deadlineTimer = setTimeout(() => { stop(); }, deadlineMs);
    const finish = (reason?: "observation-unproved" | "cleanup-unproven", value?: unknown): void => {
      if (finished) return;
      finished = true;
      clearTimeout(deadlineTimer);
      clearTimeout(cleanupTimer);
      options.signal?.removeEventListener("abort", stop);
      if (reason !== undefined) reject(new NativeObservationError(reason));
      else resolve(value);
    };
    const stop = (): void => {
      failed = true;
      if (stopping || finished) return;
      stopping = true;
      // A killed observer is never successful observation evidence. Keep its
      // listeners to drain and collect the actual close event after timeout.
      cleanupTimer = setTimeout(() => { finish("cleanup-unproven"); }, 1000);
      child.stdin.destroy();
      try { if (!exited) child.kill("SIGKILL"); } catch { /* Retain the independent close deadline. */ }
    };
    options.signal?.addEventListener("abort", stop, { once: true });
    child.once("error", stop);
    child.stdin.on("error", stop);
    child.stdout.on("error", stop);
    child.stderr.on("error", stop);
    child.stdout.on("data", (bytes: Uint8Array) => {
      if (failed) return;
      try { decoder.push(bytes); } catch { stop(); }
    });
    // No native diagnostic text crosses the observation boundary, including
    // errors containing paths or OS details. Success requires an empty stream.
    child.stderr.on("data", (bytes: Uint8Array) => { if (bytes.byteLength !== 0) stop(); });
    child.stdout.once("end", () => { stdoutEnded = true; });
    child.stderr.once("end", () => { stderrEnded = true; });
    child.once("exit", (code, signal) => { exited = true; exitCode = code; exitSignal = signal; });
    child.once("close", (code, signal) => {
      if (failed || !exited || code !== 0 || exitCode !== 0 || signal !== null || exitSignal !== null
        || !stdoutEnded || !stderrEnded) { finish("observation-unproved"); return; }
      try { finish(undefined, decoder.finish()); } catch { finish("observation-unproved"); }
    });
    if (options.signal?.aborted === true) stop();
    else {
      try { child.stdin.end(frame); } catch { stop(); }
    }
  }).catch((error: unknown) => {
    if (error instanceof NativeObservationError) throw error;
    throw new NativeObservationError("observation-unproved");
  });
}

export async function observeNativeHost(options: NativeObserverOptions): Promise<NativeHostObservation> {
  const request = nativeHostRequestSchema.parse({ version: 1, requestId: randomBytes(16).toString("hex") });
  const value = await exchange("host", encodeNativeObservationRequest("host", request), options);
  return parseNativeHostObservation(value, request);
}

export async function observeNativeScopes(
  input: Omit<NativeScopeRequest, "version" | "requestId">,
  options: NativeObserverOptions,
): Promise<NativeScopeObservation> {
  // Parse into an independent snapshot before dispatch. A caller cannot change
  // the expected binding while the native request is in flight.
  let request: NativeScopeRequest;
  try { request = nativeScopeRequestSchema.parse({ ...input, version: 1, requestId: randomBytes(16).toString("hex") }); }
  catch { throw new NativeObservationError("invalid-request"); }
  const value = await exchange("scopes", encodeNativeObservationRequest("scopes", request), options);
  return parseNativeScopeObservation(value, request);
}
