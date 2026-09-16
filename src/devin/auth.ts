import { isAbsolute, join, normalize, relative } from "node:path";

import { DevinError } from "./errors.ts";
import { isolatedDevinEnvironment, type DevinDirectories } from "./process.ts";
import {
  resolvePinnedDevinRuntime,
  type PinnedDevinRuntime,
  type ResolvePinnedDevinRuntimeOptions,
} from "./runtime.ts";

const AUTH_STATUS_STDOUT_MAX_BYTES = 16 * 1024;
const AUTH_STATUS_STDERR_MAX_BYTES = 4 * 1024;
const AUTH_STATUS_DEADLINE_MS = 5_000;
const TERMINATION_GRACE_MS = 250;
const FORCE_JOIN_MS = 1_000;
const LOGIN_SIGNAL_GRACE_MS = 1_000;

export type DevinAuthAccountProjection = Readonly<{ signedIn: boolean }>;

export type DevinAuthStatusReader = (input: Readonly<{
  directories: DevinDirectories;
  signal: AbortSignal;
  runtime?: PinnedDevinRuntime;
}>) => Promise<DevinAuthAccountProjection>;

export interface DevinAuthStatusProcess {
  readonly exited: Promise<number>;
  readonly stdout: AsyncIterable<Uint8Array>;
  readonly stderr: AsyncIterable<Uint8Array>;
  terminate(): void;
  forceTerminate(): void;
}

export type DevinAuthStatusProcessFactory = (input: Readonly<{
  argv: readonly [string, "auth", "status"];
  environment: Readonly<Record<string, string>>;
}>) => DevinAuthStatusProcess;

export interface ReadDevinAuthStatusOptions {
  readonly directories: DevinDirectories;
  readonly signal: AbortSignal;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly deadlineMs?: number;
  /** Reuse a just-admitted runtime to close the probe-to-status launch gap. */
  readonly runtime?: PinnedDevinRuntime;
  readonly resolveRuntime?: (
    options: ResolvePinnedDevinRuntimeOptions,
  ) => Promise<PinnedDevinRuntime>;
  readonly processFactory?: DevinAuthStatusProcessFactory;
}

export interface DevinForegroundLoginProcess {
  readonly exited: Promise<number>;
  sendSignal(signal: DevinLoginSignal): void;
  forceTerminate(): void;
}

export type DevinForegroundLoginProcessFactory = (input: Readonly<{
  argv:
    | readonly [string, "auth", "login"]
    | readonly [string, "auth", "login", "--force-manual-token-flow"];
  environment: Readonly<Record<string, string>>;
  stdin: number;
  stdout: number;
  stderr: number;
}>) => DevinForegroundLoginProcess;

export type DevinLoginSignal = "SIGINT" | "SIGTERM";

export interface DevinLoginSignalSource {
  add(signal: DevinLoginSignal, listener: () => void): void;
  remove(signal: DevinLoginSignal, listener: () => void): void;
}

export interface DevinLoginSignalCustody {
  readonly interruptedBy: DevinLoginSignal | null;
  attachChild(child: DevinForegroundLoginProcess): void;
  close(): void;
}

export interface RunDevinForegroundLoginOptions {
  readonly directories: DevinDirectories;
  readonly signal: AbortSignal;
  readonly stdio: Readonly<{ stdin: number; stdout: number; stderr: number }>;
  readonly manualTokenFlow?: boolean;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly signalGraceMs?: number;
  readonly runtime?: PinnedDevinRuntime;
  readonly resolveRuntime?: (
    options: ResolvePinnedDevinRuntimeOptions,
  ) => Promise<PinnedDevinRuntime>;
  readonly processFactory?: DevinForegroundLoginProcessFactory;
  readonly signalSource?: DevinLoginSignalSource;
  readonly signalCustody?: DevinLoginSignalCustody;
}

export type DevinForegroundLoginResult =
  | Readonly<{ state: "joined"; exitCode: number; interruptedBy: DevinLoginSignal | null }>
  | Readonly<{ state: "not_started"; reason: "spawn_failed" }>
  | Readonly<{ state: "not_started"; reason: "preflight_stale" }>
  | Readonly<{
      state: "not_started";
      reason: "interrupted_before_spawn";
      interruptedBy: DevinLoginSignal;
    }>;

const processSignalSource: DevinLoginSignalSource = {
  add: (signal, listener) => { process.on(signal, listener); },
  remove: (signal, listener) => { process.off(signal, listener); },
};

const boundedMilliseconds = (value: number, label: string, maximum: number): number => {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new DevinError("INVALID_INPUT", `${label} must be a bounded positive integer`);
  }
  return value;
};

export function createDevinLoginSignalCustody(options: Readonly<{
  signal: AbortSignal;
  signalGraceMs?: number;
  signalSource?: DevinLoginSignalSource;
}>): DevinLoginSignalCustody {
  const signalGraceMs = boundedMilliseconds(
    options.signalGraceMs ?? LOGIN_SIGNAL_GRACE_MS,
    "Devin foreground login signal grace",
    10_000,
  );
  const source = options.signalSource ?? processSignalSource;
  let child: DevinForegroundLoginProcess | undefined;
  let interruptedBy: DevinLoginSignal | null = null;
  let abortObserved = false;
  let abortForwarded = false;
  let closed = false;
  let forceTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleForce = (): void => {
    if (child === undefined || forceTimer !== undefined) return;
    forceTimer = setTimeout(() => {
      try { child?.forceTerminate(); } catch { /* Joining `exited` remains authoritative. */ }
    }, signalGraceMs);
    forceTimer.unref();
  };
  const terminalSignal = (signal: DevinLoginSignal): void => {
    interruptedBy ??= signal;
    // The terminal already signalled the foreground process group. HRA keeps
    // custody only so its parent can join the child and return a coherent RPC.
    scheduleForce();
  };
  const onInterrupt = (): void => { terminalSignal("SIGINT"); };
  const onTerminate = (): void => { terminalSignal("SIGTERM"); };
  const onAbort = (): void => {
    interruptedBy ??= "SIGTERM";
    abortObserved = true;
    if (child !== undefined && !abortForwarded) {
      abortForwarded = true;
      try { child.sendSignal("SIGTERM"); } catch { /* The force boundary remains. */ }
    }
    scheduleForce();
  };
  source.add("SIGINT", onInterrupt);
  source.add("SIGTERM", onTerminate);
  options.signal.addEventListener("abort", onAbort, { once: true });
  if (options.signal.aborted) onAbort();
  return {
    get interruptedBy() { return interruptedBy; },
    attachChild(next) {
      if (closed || child !== undefined) {
        throw new DevinError("INVALID_INPUT", "Devin login signal custody cannot be rebound");
      }
      child = next;
      if (abortObserved && !abortForwarded) {
        abortForwarded = true;
        try { child.sendSignal("SIGTERM"); } catch { /* The force boundary remains. */ }
      }
      if (interruptedBy !== null) scheduleForce();
    },
    close() {
      if (closed) return;
      closed = true;
      source.remove("SIGINT", onInterrupt);
      source.remove("SIGTERM", onTerminate);
      options.signal.removeEventListener("abort", onAbort);
      if (forceTimer !== undefined) clearTimeout(forceTimer);
    },
  };
}

const streamChunks = async function* (
  stream: ReadableStream<Uint8Array> | number | undefined,
): AsyncIterable<Uint8Array> {
  if (stream === undefined || typeof stream === "number") return;
  const reader = stream.getReader();
  try {
    let next = await reader.read();
    while (!next.done) {
      if (next.value.byteLength > 0) yield next.value;
      next = await reader.read();
    }
  } finally {
    reader.releaseLock();
  }
};

const defaultStatusProcessFactory: DevinAuthStatusProcessFactory = (input) => {
  const child = Bun.spawn([...input.argv], {
    env: input.environment,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exited: child.exited,
    forceTerminate: () => { child.kill("SIGKILL"); },
    stderr: streamChunks(child.stderr),
    stdout: streamChunks(child.stdout),
    terminate: () => { child.kill("SIGTERM"); },
  };
};

const defaultLoginProcessFactory: DevinForegroundLoginProcessFactory = (input) => {
  const child = Bun.spawn([...input.argv], {
    env: input.environment,
    stdin: input.stdin,
    stdout: input.stdout,
    stderr: input.stderr,
  });
  return {
    exited: child.exited,
    forceTerminate: () => { child.kill("SIGKILL"); },
    sendSignal: (signal) => { child.kill(signal); },
  };
};

const collect = async (
  source: AsyncIterable<Uint8Array>,
  maximumBytes: number,
): Promise<Uint8Array> => {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of source) {
    total += chunk.byteLength;
    if (total > maximumBytes) {
      throw new DevinError("PROTOCOL_LIMIT", "Devin authentication status exceeded its output limit");
    }
    chunks.push(chunk);
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
};

const wait = (milliseconds: number): Promise<false> => new Promise((resolve) => {
  const timer = setTimeout(() => resolve(false), milliseconds);
  timer.unref();
});

const waitFor = async (promise: Promise<unknown>, milliseconds: number): Promise<boolean> =>
  Promise.race([promise.then(() => true, () => true), wait(milliseconds)]);

const stopAndJoinStatus = async (input: Readonly<{
  process: DevinAuthStatusProcess;
  exit: Promise<number>;
  exitResolved: () => boolean;
  stdout: Promise<Uint8Array>;
  stderr: Promise<Uint8Array>;
}>): Promise<void> => {
  if (!input.exitResolved()) {
    try { input.process.terminate(); } catch { /* The force boundary remains. */ }
    await waitFor(input.exit, TERMINATION_GRACE_MS);
  }
  if (!input.exitResolved()) {
    try { input.process.forceTerminate(); } catch { /* The bounded join remains. */ }
    await waitFor(input.exit, FORCE_JOIN_MS);
  }
  if (!input.exitResolved()) {
    throw new DevinError(
      "PROCESS_EXITED",
      "Devin authentication status could not be joined after forced termination",
    );
  }
  if (!await waitFor(Promise.allSettled([input.stdout, input.stderr]), FORCE_JOIN_MS)) {
    throw new DevinError("PROCESS_EXITED", "Devin authentication output could not be drained");
  }
};

/**
 * Projects the pinned command's human output to one non-identifying bit. The
 * complete output is admitted only here and is never returned or embedded in
 * an error.
 */
export function parseDevinAuthStatus(input: Readonly<{
  dataHome?: string;
  exitCode: number;
  stdout: Uint8Array;
}>): DevinAuthAccountProjection {
  if (input.stdout.byteLength > AUTH_STATUS_STDOUT_MAX_BYTES) {
    throw new DevinError("PROTOCOL_LIMIT", "Devin authentication status exceeded its output limit");
  }
  if (input.exitCode !== 0) {
    throw new DevinError("PROCESS_EXITED", "Devin auth status exited without a status result");
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(input.stdout);
  } catch (error: unknown) {
    throw new DevinError("PROTOCOL_ERROR", "Devin returned an invalid authentication status", {
      cause: error,
    });
  }
  for (const scalar of text) {
    if (scalar !== "\r" && scalar !== "\n" && /[\p{Cc}\p{Cf}\p{Cs}]/u.test(scalar)) {
      throw new DevinError("PROTOCOL_ERROR", "Devin returned an invalid authentication status");
    }
  }
  const validCredentialsPath = (credentialsPath: string): boolean => {
    if (
      !isAbsolute(credentialsPath)
      || normalize(credentialsPath) !== credentialsPath
      || !credentialsPath.endsWith(join("devin", "credentials.toml"))
    ) return false;
    if (input.dataHome === undefined) return true;
    return isAbsolute(input.dataHome)
      && normalize(input.dataHome) === input.dataHome
      && relative(input.dataHome, credentialsPath) === join("devin", "credentials.toml");
  };
  const signedOut = /^Not logged in\.\r?\n {2}Credentials path: ([^\r\n]{1,4096})\r?\nRun `devin auth login` to authenticate\.\r?\n?$/u.exec(text);
  if (signedOut?.[1] !== undefined) {
    if (!validCredentialsPath(signedOut[1])) {
      throw new DevinError("PROTOCOL_ERROR", "Devin returned an invalid authentication status");
    }
    return { signedIn: false };
  }
  if (/^Logged in \(via [^)\r\n]{1,128}\)\.(?:\r?\n[^\0]{0,15360})?\r?\n?$/u.test(text)) {
    const credentialLines = text.split(/\r?\n/u)
      .filter((line) => line.startsWith("  Credentials path: "));
    if (
      credentialLines.length > 1
      || (credentialLines[0] !== undefined
        && !validCredentialsPath(credentialLines[0].slice("  Credentials path: ".length)))
    ) {
      throw new DevinError("PROTOCOL_ERROR", "Devin returned an invalid authentication status");
    }
    return { signedIn: true };
  }
  throw new DevinError("PROTOCOL_ERROR", "Devin returned an invalid authentication status");
}

export async function readDevinAuthStatus(
  options: ReadDevinAuthStatusOptions,
): Promise<DevinAuthAccountProjection> {
  const isAborted = (): boolean => options.signal.aborted;
  if (isAborted()) {
    throw new DevinError("PROCESS_EXITED", "Devin authentication status read was canceled");
  }
  const environment = options.environment ?? process.env;
  const runtime = options.runtime ?? await (options.resolveRuntime ?? resolvePinnedDevinRuntime)({
    directories: options.directories,
    environment,
    signal: options.signal,
  });
  const deadlineMs = boundedMilliseconds(
    options.deadlineMs ?? AUTH_STATUS_DEADLINE_MS,
    "Devin authentication status deadline",
    60_000,
  );
  if (isAborted()) {
    throw new DevinError("PROCESS_EXITED", "Devin authentication status read was canceled");
  }
  let child: DevinAuthStatusProcess;
  try {
    child = (options.processFactory ?? defaultStatusProcessFactory)({
      argv: [runtime.executablePath, "auth", "status"],
      environment: isolatedDevinEnvironment(environment, options.directories),
    });
  } catch (error: unknown) {
    throw new DevinError("PROCESS_EXITED", "Devin authentication status could not be started", {
      cause: error,
    });
  }
  const stdout = collect(child.stdout, AUTH_STATUS_STDOUT_MAX_BYTES);
  const stderr = collect(child.stderr, AUTH_STATUS_STDERR_MAX_BYTES);
  let exitResolved = false;
  const exit = child.exited.then(
    (code) => { exitResolved = true; return code; },
    (error: unknown) => { throw error; },
  );
  const completion = Promise.all([stdout, stderr, exit]);
  let markAborted!: () => void;
  const aborted = new Promise<"aborted">((resolve) => { markAborted = () => resolve("aborted"); });
  options.signal.addEventListener("abort", markAborted, { once: true });
  if (isAborted()) markAborted();
  let outcome: Awaited<typeof completion>;
  let stopped = false;
  try {
    const settled = await Promise.race([completion, aborted, wait(deadlineMs)]);
    if (settled === "aborted" || settled === false) {
      await stopAndJoinStatus({
        exit,
        exitResolved: () => exitResolved,
        process: child,
        stderr,
        stdout,
      });
      stopped = true;
      throw new DevinError(
        settled === false ? "TIMEOUT" : "PROCESS_EXITED",
        settled === false
          ? "Devin authentication status exceeded its bounded deadline"
          : "Devin authentication status read was canceled",
      );
    }
    outcome = settled;
  } catch (error: unknown) {
    if (!stopped) {
      await stopAndJoinStatus({
        exit,
        exitResolved: () => exitResolved,
        process: child,
        stderr,
        stdout,
      });
    }
    if (error instanceof DevinError) throw error;
    throw new DevinError("PROCESS_EXITED", "Devin authentication status failed", { cause: error });
  } finally {
    options.signal.removeEventListener("abort", markAborted);
  }
  const [output, diagnostic, code] = outcome;
  void diagnostic;
  return parseDevinAuthStatus({
    dataHome: options.directories.dataHome,
    exitCode: code,
    stdout: output,
  });
}

export async function runDevinForegroundLogin(
  options: RunDevinForegroundLoginOptions,
): Promise<DevinForegroundLoginResult> {
  const ownedCustody = options.signalCustody === undefined;
  const custody = options.signalCustody ?? createDevinLoginSignalCustody({
    signal: options.signal,
    ...(options.signalGraceMs === undefined ? {} : { signalGraceMs: options.signalGraceMs }),
    ...(options.signalSource === undefined ? {} : { signalSource: options.signalSource }),
  });
  const currentInterruption = (): DevinLoginSignal | null => custody.interruptedBy;
  try {
    for (const [name, descriptor] of Object.entries(options.stdio)) {
      if (!Number.isSafeInteger(descriptor) || descriptor < 0 || descriptor > 2_147_483_647) {
        throw new DevinError("INVALID_INPUT", `Devin foreground login ${name} fd is invalid`);
      }
    }
    const interruptedBeforePreflight = currentInterruption();
    if (interruptedBeforePreflight !== null) {
      return {
        interruptedBy: interruptedBeforePreflight,
        reason: "interrupted_before_spawn",
        state: "not_started",
      };
    }
    const environment = options.environment ?? process.env;
    let runtime: PinnedDevinRuntime;
    try {
      runtime = options.runtime ?? await (options.resolveRuntime ?? resolvePinnedDevinRuntime)({
        directories: options.directories,
        environment,
        signal: options.signal,
      });
    } catch (error: unknown) {
      const interruptedDuringPreflight = currentInterruption();
      if (interruptedDuringPreflight !== null) {
        return {
          interruptedBy: interruptedDuringPreflight,
          reason: "interrupted_before_spawn",
          state: "not_started",
        };
      }
      if (error instanceof DevinError && error.code === "RUNTIME_MISMATCH") {
        return { reason: "preflight_stale", state: "not_started" };
      }
      throw error;
    }
    const interruptedAfterPreflight = currentInterruption();
    if (interruptedAfterPreflight !== null) {
      return {
        interruptedBy: interruptedAfterPreflight,
        reason: "interrupted_before_spawn",
        state: "not_started",
      };
    }
    let child: DevinForegroundLoginProcess;
    try {
      child = (options.processFactory ?? defaultLoginProcessFactory)({
        argv: options.manualTokenFlow === true
          ? [runtime.executablePath, "auth", "login", "--force-manual-token-flow"]
          : [runtime.executablePath, "auth", "login"],
        environment: isolatedDevinEnvironment(environment, options.directories),
        stderr: options.stdio.stderr,
        stdin: options.stdio.stdin,
        stdout: options.stdio.stdout,
      });
    } catch {
      return { reason: "spawn_failed", state: "not_started" };
    }
    custody.attachChild(child);
    let exitCode: number;
    try {
      exitCode = await child.exited;
    } catch (error: unknown) {
      try { child.forceTerminate(); } catch { /* The rejected wait is still surfaced. */ }
      throw new DevinError("PROCESS_EXITED", "Devin foreground login could not be joined", {
        cause: error,
      });
    }
    if (!Number.isSafeInteger(exitCode) || exitCode < 0 || exitCode > 255) {
      throw new DevinError("PROCESS_EXITED", "Devin foreground login returned an invalid exit code");
    }
    return { exitCode, interruptedBy: custody.interruptedBy, state: "joined" };
  } finally {
    if (ownedCustody) custody.close();
  }
}
