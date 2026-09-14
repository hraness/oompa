import { accessSync, constants, lstatSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { z } from "zod";

import { ClaudeError } from "./errors.ts";
import { allowlistedEnvironment } from "./process.ts";
import {
  resolvePinnedClaudeRuntime,
  type PinnedClaudeRuntime,
  type ResolvePinnedClaudeRuntimeOptions,
} from "./runtime.ts";

const AUTH_STATUS_STDOUT_MAX_BYTES = 16 * 1024;
const AUTH_STATUS_STDERR_MAX_BYTES = 4 * 1024;
const AUTH_STATUS_DEADLINE_MS = 5_000;
const PROCESS_TERMINATION_GRACE_MS = 250;
const PROCESS_FORCE_JOIN_DEADLINE_MS = 1_000;
const LOGIN_SIGNAL_GRACE_MS = 1_000;

const boundedStatusToken = z.string().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/u);
const nullableBoundedText = (maximum: number) => z.string().max(maximum).nullable().optional();

/*
 * Exact keys emitted by `claude auth status --json` in the pinned build. The
 * identity-bearing values are admitted only so an authenticated response can
 * be validated; they are never returned by this module.
 */
const claudeAuthStatusDocumentSchema = z.object({
  loggedIn: z.boolean(),
  authMethod: boundedStatusToken,
  apiProvider: z.literal("firstParty"),
  analyticsDisabled: z.boolean(),
  projectsDirectory: z.string().min(1).max(4_096),
  forcedLoginMethod: nullableBoundedText(64),
  apiKeySource: nullableBoundedText(128),
  email: nullableBoundedText(320),
  orgId: nullableBoundedText(256),
  orgName: nullableBoundedText(256),
  subscriptionType: nullableBoundedText(128),
}).strict();

export type ClaudeAuthAccountProjection = Readonly<{ signedIn: boolean }>;

/** Private authority evidence, never an account identity or credential. */
export type ClaudeAuthenticationObservation = Readonly<{
  signedIn: boolean;
  authentication: "claude_ai" | "other" | "none";
}>;

export type ClaudeAuthStatusReader = (input: Readonly<{
  configDir: string;
  signal: AbortSignal;
  /** A just-admitted runtime closes the version-probe-to-status launch gap. */
  runtime?: PinnedClaudeRuntime;
}>) => Promise<ClaudeAuthAccountProjection>;

export interface ClaudeAuthStatusProcess {
  readonly exited: Promise<number>;
  readonly stdout: AsyncIterable<Uint8Array>;
  readonly stderr: AsyncIterable<Uint8Array>;
  terminate(): void;
  forceTerminate(): void;
}

export type ClaudeAuthStatusProcessFactory = (input: Readonly<{
  argv: readonly [string, ...string[]];
  environment: Readonly<Record<string, string>>;
}>) => ClaudeAuthStatusProcess;

export interface ReadClaudeAuthStatusOptions {
  readonly configDir: string;
  /** Personal homes must retain Claude's canonical default-home resolution. */
  readonly configHome?: "isolated" | "personal";
  readonly signal: AbortSignal;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly deadlineMs?: number;
  /** A just-admitted runtime may be reused immediately for the status launch. */
  readonly runtime?: PinnedClaudeRuntime;
  readonly resolveRuntime?: (options: ResolvePinnedClaudeRuntimeOptions) => Promise<PinnedClaudeRuntime>;
  readonly processFactory?: ClaudeAuthStatusProcessFactory;
}

export interface ClaudeForegroundLoginProcess {
  readonly exited: Promise<number>;
  sendSignal(signal: ClaudeLoginSignal): void;
  forceTerminate(): void;
}

export type ClaudeForegroundLoginProcessFactory = (input: Readonly<{
  argv: readonly [string, ...string[]];
  environment: Readonly<Record<string, string>>;
  stderr: number;
  stdin: number;
  stdout: number;
}>) => ClaudeForegroundLoginProcess;

export type ClaudeLoginSignal = "SIGINT" | "SIGTERM";

export interface ClaudeLoginSignalSource {
  add(signal: ClaudeLoginSignal, listener: () => void): void;
  remove(signal: ClaudeLoginSignal, listener: () => void): void;
}

export type ClaudeLoginBrowserMode = "provider_default" | "owner_manual";

/** Local presentation only; this does not admit an account, child or recovery attempt. */
export function resolveClaudeLoginBrowserMode(
  value: unknown,
  platform: NodeJS.Platform = process.platform,
): ClaudeLoginBrowserMode {
  const mode = value === undefined ? "provider_default" : value;
  if (mode !== "provider_default" && mode !== "owner_manual") {
    throw new ClaudeError("INVALID_INPUT", "Claude login browser mode is invalid.");
  }
  if (mode === "owner_manual") {
    if (platform !== "darwin" && platform !== "linux") {
      throw new ClaudeError("INVALID_INPUT", "Claude manual-browser login requires a supported POSIX host.");
    }
    try {
      if (!lstatSync("/usr/bin/true").isFile()) throw new Error("Fixed opener is not a regular file.");
      accessSync("/usr/bin/true", constants.X_OK);
    } catch {
      throw new ClaudeError("INVALID_INPUT", "Claude manual-browser login requires the fixed system opener.");
    }
  }
  return mode;
}

export interface RunClaudeForegroundLoginOptions {
  readonly configDir: string;
  readonly browserMode?: ClaudeLoginBrowserMode;
  readonly signal: AbortSignal;
  readonly stdio: Readonly<{ stderr: number; stdin: number; stdout: number }>;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly signalGraceMs?: number;
  /** Bounded join after forced termination, never a login-ceremony timeout. */
  readonly forceJoinDeadlineMs?: number;
  readonly resolveRuntime?: (options: ResolvePinnedClaudeRuntimeOptions) => Promise<PinnedClaudeRuntime>;
  /** A just-preflighted runtime may be reused across the daemon launch grant. */
  readonly runtime?: PinnedClaudeRuntime;
  readonly processFactory?: ClaudeForegroundLoginProcessFactory;
  readonly signalSource?: ClaudeLoginSignalSource;
  /**
   * A caller that already owns a daemon launch grant installs this custody
   * before doing any further fallible or asynchronous work and keeps it until
   * the exact completion RPC settles.
   */
  readonly signalCustody?: ClaudeLoginSignalCustody;
}

export type ClaudeForegroundLoginResult =
  | Readonly<{ state: "joined"; exitCode: number; interruptedBy: ClaudeLoginSignal | null }>
  | Readonly<{ state: "not_started"; reason: "spawn_failed" }>
  | Readonly<{ state: "not_started"; reason: "preflight_stale" }>
  | Readonly<{
      state: "not_started";
      reason: "interrupted_before_spawn";
      interruptedBy: ClaudeLoginSignal;
    }>;

const processSignalSource: ClaudeLoginSignalSource = {
  add: (signal, listener) => { process.on(signal, listener); },
  remove: (signal, listener) => { process.off(signal, listener); },
};

export interface ClaudeLoginSignalCustody {
  readonly interruptedBy: ClaudeLoginSignal | null;
  /** Resolves after force was attempted, not as proof that the child exited. */
  readonly forceBoundary: Promise<void>;
  attachChild(child: ClaudeForegroundLoginProcess): void;
  close(): void;
}

export function createClaudeLoginSignalCustody(options: Readonly<{
  signal: AbortSignal;
  signalGraceMs?: number;
  signalSource?: ClaudeLoginSignalSource;
}>): ClaudeLoginSignalCustody {
  const signalGraceMs = boundedMilliseconds(
    options.signalGraceMs ?? LOGIN_SIGNAL_GRACE_MS,
    "Claude foreground login signal grace",
    10_000,
  );
  const signalSource = options.signalSource ?? processSignalSource;
  let child: ClaudeForegroundLoginProcess | undefined;
  let interruptedBy: ClaudeLoginSignal | null = null;
  let abortObserved = false;
  let abortForwarded = false;
  let closed = false;
  let resolveForceBoundary!: () => void;
  const forceBoundary = new Promise<void>((resolve) => { resolveForceBoundary = resolve; });
  let forceTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleForce = (): void => {
    if (child === undefined || forceTimer !== undefined) return;
    forceTimer = setTimeout(() => {
      try { child?.forceTerminate(); } catch { /* Awaiting `exited` remains authoritative. */ }
      resolveForceBoundary();
    }, signalGraceMs);
    forceTimer.unref();
  };
  const observeTerminalSignal = (signal: ClaudeLoginSignal): void => {
    interruptedBy ??= signal;
    // The terminal delivered this signal to the foreground process group. The
    // parent only suppresses its own default exit so it can join and complete.
    scheduleForce();
  };
  const onInterrupt = () => { observeTerminalSignal("SIGINT"); };
  const onTerminate = () => { observeTerminalSignal("SIGTERM"); };
  const onAbort = () => {
    interruptedBy ??= "SIGTERM";
    abortObserved = true;
    if (child !== undefined && !abortForwarded) {
      abortForwarded = true;
      try { child.sendSignal("SIGTERM"); } catch { /* The force boundary still owns the child. */ }
    }
    scheduleForce();
  };
  signalSource.add("SIGINT", onInterrupt);
  signalSource.add("SIGTERM", onTerminate);
  options.signal.addEventListener("abort", onAbort, { once: true });
  if (abortRequested(options.signal)) onAbort();
  return {
    get interruptedBy() { return interruptedBy; },
    forceBoundary,
    attachChild: (next) => {
      if (closed || child !== undefined) {
        throw new ClaudeError("INVALID_INPUT", "Claude login signal custody cannot be rebound.");
      }
      child = next;
      if (abortObserved && !abortForwarded) {
        abortForwarded = true;
        try { child.sendSignal("SIGTERM"); } catch { /* The force boundary still owns the child. */ }
      }
      if (interruptedBy !== null) scheduleForce();
    },
    close: () => {
      if (closed) return;
      closed = true;
      signalSource.remove("SIGINT", onInterrupt);
      signalSource.remove("SIGTERM", onTerminate);
      options.signal.removeEventListener("abort", onAbort);
      if (forceTimer !== undefined) clearTimeout(forceTimer);
    },
  };
}

const readableStreamChunks = async function* (
  stream: ReadableStream<Uint8Array> | number | undefined,
): AsyncIterable<Uint8Array> {
  if (stream === undefined || typeof stream === "number") return;
  const reader = stream.getReader();
  try {
    let result = await reader.read();
    while (!result.done) {
      if (result.value.byteLength > 0) yield result.value;
      result = await reader.read();
    }
  } finally {
    reader.releaseLock();
  }
};

const spawnAuthStatusProcess: ClaudeAuthStatusProcessFactory = (input) => {
  const child = Bun.spawn([...input.argv], {
    env: input.environment,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exited: child.exited,
    forceTerminate: () => { child.kill("SIGKILL"); },
    stderr: readableStreamChunks(child.stderr),
    stdout: readableStreamChunks(child.stdout),
    terminate: () => { child.kill("SIGTERM"); },
  };
};

const spawnForegroundLoginProcess: ClaudeForegroundLoginProcessFactory = (input) => {
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

const boundedMilliseconds = (value: number, name: string, maximum: number): number => {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new ClaudeError("INVALID_INPUT", `${name} must be a bounded positive integer`);
  }
  return value;
};

const canceledError = (operation = "Claude authentication status read"): ClaudeError =>
  new ClaudeError("PROCESS_EXITED", `${operation} was canceled.`);

const assertNotAborted = (signal: AbortSignal, operation?: string): void => {
  if (signal.aborted) throw canceledError(operation);
};

const abortRequested = (signal: AbortSignal): boolean => signal.aborted;

const deadlineError = (): ClaudeError =>
  new ClaudeError("TIMEOUT", "Claude authentication status did not settle within its bounded deadline.");

const collectBoundedOutput = async (
  source: AsyncIterable<Uint8Array>,
  maximumBytes: number,
): Promise<Uint8Array> => {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of source) {
    total += chunk.byteLength;
    if (total > maximumBytes) {
      throw new ClaudeError("PROTOCOL_LIMIT", "Claude authentication status exceeded its output limit.");
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

const waitForPromise = async (promise: Promise<unknown>, milliseconds: number): Promise<boolean> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true, () => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), milliseconds);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

const stopAndJoinStatusProcess = async (input: Readonly<{
  process: ClaudeAuthStatusProcess;
  exit: Promise<number>;
  exitResolved: () => boolean;
  stdout: Promise<Uint8Array>;
  stderr: Promise<Uint8Array>;
}>): Promise<void> => {
  const joined = Promise.allSettled([input.exit, input.stdout, input.stderr]);
  if (!input.exitResolved()) {
    try { input.process.terminate(); } catch { /* Continue to the exact force boundary. */ }
    await waitForPromise(input.exit, PROCESS_TERMINATION_GRACE_MS);
    // A rejected `exited` promise is not proof that the process exited. Force
    // the exact child unless the promise fulfilled and recorded that fact.
    if (!input.exitResolved()) {
      try { input.process.forceTerminate(); } catch { /* The join below remains authoritative. */ }
    }
  }
  if (!(await waitForPromise(joined, PROCESS_FORCE_JOIN_DEADLINE_MS))) {
    throw new ClaudeError(
      "TIMEOUT",
      "Claude authentication status could not be joined after forced termination.",
    );
  }
};

const parseStatusJson = (bytes: Uint8Array): unknown => {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text) as unknown;
  } catch {
    throw new ClaudeError("PROTOCOL_ERROR", "Claude returned an invalid authentication status document.");
  }
};

/**
 * Parses the pinned CLI's status result and projects only the authentication
 * fact. Exit 1 is Claude's documented signed-out observation, not a process
 * fault; every other exit/status pairing fails closed.
 */
export function parseClaudeAuthStatus(input: Readonly<{
  configDir: string;
  exitCode: number;
  stdout: Uint8Array;
}>): ClaudeAuthAccountProjection {
  return { signedIn: parseClaudeAuthenticationObservation(input).signedIn };
}

function parseClaudeAuthenticationObservation(input: Readonly<{
  configDir: string;
  exitCode: number;
  stdout: Uint8Array;
}>): ClaudeAuthenticationObservation {
  if (!isAbsolute(input.configDir)) {
    throw new ClaudeError("INVALID_INPUT", "CLAUDE_CONFIG_DIR must be an absolute path");
  }
  if (input.exitCode !== 0 && input.exitCode !== 1) {
    throw new ClaudeError("PROCESS_EXITED", "Claude authentication status exited without a status result.");
  }
  const parsed = claudeAuthStatusDocumentSchema.safeParse(parseStatusJson(input.stdout));
  if (!parsed.success) {
    throw new ClaudeError("PROTOCOL_ERROR", "Claude returned an invalid authentication status document.");
  }
  const status = parsed.data;
  if (status.projectsDirectory !== join(input.configDir, "projects")) {
    throw new ClaudeError("CONFIG_DIR_MISMATCH", "Claude authentication status did not use the isolated profile directory.");
  }
  const coherentSignedIn = input.exitCode === 0 && status.loggedIn && status.authMethod !== "none";
  const coherentSignedOut = input.exitCode === 1 && !status.loggedIn && status.authMethod === "none";
  if (!coherentSignedIn && !coherentSignedOut) {
    throw new ClaudeError("PROTOCOL_ERROR", "Claude returned an incoherent authentication status.");
  }
  return {
    signedIn: coherentSignedIn,
    authentication: !coherentSignedIn
      ? "none"
      : status.authMethod === "claude.ai"
        ? "claude_ai"
        : "other",
  };
}

/** Projects only sign-in state for the managed account surface. */
export async function readClaudeAuthStatus(
  options: ReadClaudeAuthStatusOptions,
): Promise<ClaudeAuthAccountProjection> {
  return { signedIn: (await readClaudeAuthenticationObservation(options)).signedIn };
}

/** Runs one bounded, joined status process in the exact reviewed home mode. */
export async function readClaudeAuthenticationObservation(
  options: ReadClaudeAuthStatusOptions,
): Promise<ClaudeAuthenticationObservation> {
  assertNotAborted(options.signal);
  const deadlineMs = boundedMilliseconds(
    options.deadlineMs ?? AUTH_STATUS_DEADLINE_MS,
    "Claude authentication status deadline",
    60_000,
  );
  const environment = options.environment ?? process.env;
  const configHome = options.configHome ?? "isolated";
  const runtime = options.runtime ?? await (options.resolveRuntime ?? resolvePinnedClaudeRuntime)({
      configDir: options.configDir,
      configHome,
      environment,
      signal: options.signal,
      versionProbeDeadlineMs: deadlineMs,
    });
  assertNotAborted(options.signal);

  const childEnvironment = allowlistedEnvironment(environment);
  if (configHome === "isolated") childEnvironment.CLAUDE_CONFIG_DIR = options.configDir;
  childEnvironment.NO_COLOR = "1";
  let child: ClaudeAuthStatusProcess;
  try {
    child = (options.processFactory ?? spawnAuthStatusProcess)({
      argv: [runtime.executablePath, "auth", "status", "--json"],
      environment: childEnvironment,
    });
  } catch (error: unknown) {
    throw new ClaudeError("PROCESS_EXITED", "Claude authentication status could not be started.", { cause: error });
  }

  let exitResolved = false;
  const exit = child.exited.then(
    (exitCode) => { exitResolved = true; return exitCode; },
    (error: unknown) => { throw error; },
  );
  const stdout = collectBoundedOutput(child.stdout, AUTH_STATUS_STDOUT_MAX_BYTES);
  const stderr = collectBoundedOutput(child.stderr, AUTH_STATUS_STDERR_MAX_BYTES);
  const completion = Promise.all([stdout, stderr, exit]).then(
    ([output, diagnostic, exitCode]) => ({ kind: "completed" as const, output, diagnostic, exitCode }),
    (error: unknown) => ({ kind: "failed" as const, error }),
  );
  let cancel: ((reason: "aborted" | "deadline") => void) | undefined;
  const cancellation = new Promise<"aborted" | "deadline">((resolve) => { cancel = resolve; });
  const onAbort = () => { cancel?.("aborted"); };
  options.signal.addEventListener("abort", onAbort, { once: true });
  if (abortRequested(options.signal)) onAbort();
  const deadline = setTimeout(() => { cancel?.("deadline"); }, deadlineMs);
  deadline.unref();

  try {
    const outcome = await Promise.race([
      completion,
      cancellation.then((reason) => ({ kind: "canceled" as const, reason })),
    ]);
    if (outcome.kind === "canceled") {
      await stopAndJoinStatusProcess({ process: child, exit, exitResolved: () => exitResolved, stdout, stderr });
      throw outcome.reason === "deadline" ? deadlineError() : canceledError();
    }
    if (outcome.kind === "failed") {
      await stopAndJoinStatusProcess({ process: child, exit, exitResolved: () => exitResolved, stdout, stderr });
      if (outcome.error instanceof ClaudeError) throw outcome.error;
      throw new ClaudeError("PROCESS_EXITED", "Claude authentication status did not settle safely.", {
        cause: outcome.error,
      });
    }
    // Draining stderr is a required bounded process join, never a diagnostic
    // source: provider output is not copied into an Oompa result or log.
    void outcome.diagnostic;
    return parseClaudeAuthenticationObservation({
      configDir: options.configDir,
      exitCode: outcome.exitCode,
      stdout: outcome.output,
    });
  } finally {
    options.signal.removeEventListener("abort", onAbort);
    clearTimeout(deadline);
    cancel = undefined;
  }
}

const descriptor = (value: number): number => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ClaudeError("INVALID_INPUT", "Claude foreground login requires valid terminal descriptors.");
  }
  return value;
};

/**
 * Runs Claude's own subscription login in the foreground. Oompa supplies only
 * the isolated directory, terminal descriptors and optional fixed browser
 * suppression; Claude owns every prompt,
 * URL, code, and credential write. The result is deliberately only a process
 * outcome—callers re-read `auth status` before claiming sign-in.
 */
export async function runClaudeForegroundLogin(
  options: RunClaudeForegroundLoginOptions,
): Promise<ClaudeForegroundLoginResult> {
  // Capture presentation and profile before any resolver await. The browser mode
  // cannot change the already selected account or acquire a new launch grant.
  const browserMode = resolveClaudeLoginBrowserMode(options.browserMode);
  const configDir = options.configDir;
  const forceJoinDeadlineMs = boundedMilliseconds(
    options.forceJoinDeadlineMs ?? PROCESS_FORCE_JOIN_DEADLINE_MS,
    "Claude foreground login forced join deadline",
    10_000,
  );
  const ownsSignalCustody = options.signalCustody === undefined;
  const signalCustody = options.signalCustody ?? createClaudeLoginSignalCustody({
    signal: options.signal,
    ...(options.signalGraceMs === undefined ? {} : { signalGraceMs: options.signalGraceMs }),
    ...(options.signalSource === undefined ? {} : { signalSource: options.signalSource }),
  });
  const currentInterruption = (): ClaudeLoginSignal | null => signalCustody.interruptedBy;
  try {
    const initialInterruption = currentInterruption();
    if (initialInterruption !== null) {
      return {
        state: "not_started",
        reason: "interrupted_before_spawn",
        interruptedBy: initialInterruption,
      };
    }
    const stdin = descriptor(options.stdio.stdin);
    const stdout = descriptor(options.stdio.stdout);
    const stderr = descriptor(options.stdio.stderr);
    const environment = options.environment ?? process.env;
    let runtime: PinnedClaudeRuntime;
    try {
      runtime = options.runtime ?? await (options.resolveRuntime ?? resolvePinnedClaudeRuntime)({
        configDir,
        environment,
        signal: options.signal,
      });
    } catch (error: unknown) {
      const resolutionInterruption = currentInterruption();
      if (resolutionInterruption !== null) {
        return {
          state: "not_started",
          reason: "interrupted_before_spawn",
          interruptedBy: resolutionInterruption,
        };
      }
      throw error;
    }
    const resolvedInterruption = currentInterruption();
    if (resolvedInterruption !== null) {
      return {
        state: "not_started",
        reason: "interrupted_before_spawn",
        interruptedBy: resolvedInterruption,
      };
    }
    const childEnvironment = allowlistedEnvironment(environment);
    childEnvironment.CLAUDE_CONFIG_DIR = configDir;
    childEnvironment.NO_COLOR = "1";
    if (browserMode === "owner_manual") childEnvironment.BROWSER = "/usr/bin/true";
    let child: ClaudeForegroundLoginProcess;
    try {
      child = (options.processFactory ?? spawnForegroundLoginProcess)({
        argv: [runtime.executablePath, "auth", "login", "--claudeai"],
        environment: childEnvironment,
        stderr,
        stdin,
        stdout,
      });
    } catch (error: unknown) {
      void error;
      const spawnInterruption = currentInterruption();
      return spawnInterruption === null
        ? { state: "not_started", reason: "spawn_failed" }
        : {
            state: "not_started",
            reason: "interrupted_before_spawn",
            interruptedBy: spawnInterruption,
          };
    }
    signalCustody.attachChild(child);
    const exit = child.exited.catch((error: unknown) => {
      // A rejected wait is not proof of exit. Force the exact child before
      // returning control; this port has no stronger post-rejection join.
      try { child.forceTerminate(); } catch { /* Preserve the original wait failure. */ }
      throw new ClaudeError("PROCESS_EXITED", "Claude foreground login did not settle safely.", {
        cause: error,
      });
    });
    let settled = false;
    let exitCode: number;
    try {
      exitCode = await Promise.race([
        exit,
        signalCustody.forceBoundary.then(async () => {
          // Ordinary provider interaction has no artificial deadline. Only
          // interruption followed by the force boundary starts this final
          // join. A timeout preserves the caller's durable launch fence.
          if (!settled && !(await waitForPromise(exit, forceJoinDeadlineMs))) {
            throw new ClaudeError(
              "TIMEOUT",
              "Claude foreground login could not be joined after forced termination.",
            );
          }
          return await exit;
        }),
      ]);
    } finally {
      settled = true;
    }
    return {
      state: "joined",
      exitCode,
      interruptedBy: currentInterruption()
        ?? (exitCode === 130 ? "SIGINT" : exitCode === 143 ? "SIGTERM" : null),
    };
  } finally {
    if (ownsSignalCustody) signalCustody.close();
  }
}
