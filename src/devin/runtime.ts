import { lstat, realpath } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";

import { DevinError } from "./errors.ts";
import { DEVIN_MODEL, DEVIN_PIN, DEVIN_VERSION_OUTPUT_PATTERN } from "./pin.ts";
import {
  DEVIN_SAFE_ENVIRONMENT_KEYS,
  isolatedDevinEnvironment,
  validateDevinDirectories,
  type DevinDirectories,
} from "./process.ts";

/**
 * Filters an ambient environment to the reviewed allowlist without imposing an
 * isolated profile boundary. The version probe and the `/usage` panel driver
 * run in the caller's real Devin login boundary, so HOME and the XDG keys stay
 * ambient here; ACP session launches use `isolatedDevinEnvironment` instead.
 */
export function devinEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const env: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [key, value] of Object.entries(environment)) {
    if (DEVIN_SAFE_ENVIRONMENT_KEYS.has(key) && value !== undefined) env[key] = value;
  }
  return env;
}

export interface PinnedDevinRuntime {
  readonly executablePath: string;
  readonly version: typeof DEVIN_PIN;
  /** The build hash the pinned executable reported, for example `bcbe88c7`. */
  readonly build: string;
  /** The exact first line of `devin --version`, retained as observation evidence. */
  readonly versionOutput: string;
  readonly model: typeof DEVIN_MODEL;
  readonly argv: readonly [string, "acp", "--model", typeof DEVIN_MODEL];
}

export interface DevinVersionProbeProcess {
  readonly exited: Promise<number>;
  readonly stdout: AsyncIterable<Uint8Array>;
  readonly stderr: AsyncIterable<Uint8Array>;
  terminate(): void;
  forceTerminate(): void;
}

export type DevinVersionProbeProcessFactory = (input: Readonly<{
  argv: readonly [string, "--version"];
  environment: Readonly<Record<string, string>>;
}>) => DevinVersionProbeProcess;

export type DevinVersionProbe = (input: Readonly<{
  executablePath: string;
  directories?: DevinDirectories;
  environment: Readonly<Record<string, string | undefined>>;
  signal: AbortSignal;
  deadlineMs: number;
  processFactory?: DevinVersionProbeProcessFactory;
}>) => Promise<string>;

export interface ResolvePinnedDevinRuntimeOptions {
  /** Absolute path to `devin`; located on the allowlisted PATH when omitted. */
  readonly executablePath?: string;
  /**
   * Isolated profile boundary for the version probe. When omitted the probe
   * runs with the ambient allowlisted environment, which is the boundary the
   * `/usage` panel driver uses; ACP admission always passes the profile dirs.
   */
  readonly directories?: DevinDirectories;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly probeVersion?: DevinVersionProbe;
  readonly processFactory?: DevinVersionProbeProcessFactory;
  readonly signal?: AbortSignal;
  readonly versionProbeDeadlineMs?: number;
}

const VERSION_PROBE_DEADLINE_MS = 5_000;
const VERSION_STDOUT_MAX_BYTES = 4 * 1024;
const VERSION_STDERR_MAX_BYTES = 4 * 1024;
const TERMINATION_GRACE_MS = 250;
const FORCE_JOIN_MS = 1_000;

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

const defaultProcessFactory: DevinVersionProbeProcessFactory = (input) => {
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

const collect = async (
  source: AsyncIterable<Uint8Array>,
  maximumBytes: number,
): Promise<Uint8Array> => {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of source) {
    total += chunk.byteLength;
    if (total > maximumBytes) {
      throw new DevinError("PROTOCOL_LIMIT", "Devin version output exceeded its bounded limit");
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

const stopAndJoin = async (
  child: DevinVersionProbeProcess,
  exit: Promise<number>,
  exitResolved: () => boolean,
  drains: readonly Promise<unknown>[],
): Promise<void> => {
  if (!exitResolved()) {
    try { child.terminate(); } catch { /* The force boundary remains authoritative. */ }
    await waitFor(exit, TERMINATION_GRACE_MS);
  }
  if (!exitResolved()) {
    try { child.forceTerminate(); } catch { /* The bounded join below remains authoritative. */ }
    await waitFor(exit, FORCE_JOIN_MS);
  }
  if (!exitResolved()) {
    throw new DevinError(
      "PROCESS_EXITED",
      "Devin version probe could not be joined after forced termination",
    );
  }
  if (!await waitFor(Promise.allSettled(drains), FORCE_JOIN_MS)) {
    throw new DevinError("PROCESS_EXITED", "Devin version output could not be drained");
  }
};

/** Parses the exact `devin <version> (<build>)` line into version and build evidence. */
const parseDevinVersionEvidence = (output: string): { version: string; build: string } => {
  const match = DEVIN_VERSION_OUTPUT_PATTERN.exec(output);
  if (match?.[1] === undefined || match[2] === undefined) {
    throw new DevinError("RUNTIME_MISMATCH", "Devin reported no exact version");
  }
  return { version: match[1], build: match[2] };
};

export function parseDevinVersionOutput(output: string): string {
  if (new TextEncoder().encode(output).byteLength > VERSION_STDOUT_MAX_BYTES) {
    throw new DevinError("PROTOCOL_LIMIT", "Devin version output exceeded its bounded limit");
  }
  return parseDevinVersionEvidence(output).version;
}

export function assertPinnedDevinVersion(version: string): asserts version is typeof DEVIN_PIN {
  if (version !== DEVIN_PIN) {
    throw new DevinError("RUNTIME_MISMATCH", `Oompa requires Devin CLI ${DEVIN_PIN}`);
  }
}

/** Reads `devin --version` with bounded output and lifetime. */
export const spawnDevinVersionProbe: DevinVersionProbe = async (input) => {
  let child: DevinVersionProbeProcess;
  try {
    child = (input.processFactory ?? defaultProcessFactory)({
      argv: [input.executablePath, "--version"],
      environment: input.directories === undefined
        ? { ...devinEnvironment(input.environment), NO_COLOR: "1" }
        : isolatedDevinEnvironment(input.environment, input.directories),
    });
  } catch (error: unknown) {
    throw new DevinError("RUNTIME_MISMATCH", "the Devin version probe could not be started", {
      cause: error,
    });
  }
  const stdout = collect(child.stdout, VERSION_STDOUT_MAX_BYTES);
  const stderr = collect(child.stderr, VERSION_STDERR_MAX_BYTES);
  let exitResolved = false;
  const exit = child.exited.then(
    (code) => { exitResolved = true; return code; },
    (error: unknown) => { throw error; },
  );
  const completion = Promise.all([stdout, stderr, exit]);
  let markAborted!: () => void;
  const aborted = new Promise<"aborted">((resolve) => { markAborted = () => resolve("aborted"); });
  input.signal.addEventListener("abort", markAborted, { once: true });
  if (input.signal.aborted) markAborted();
  let outcome: Awaited<typeof completion>;
  let stopped = false;
  try {
    const settled = await Promise.race([completion, aborted, wait(input.deadlineMs)]);
    if (settled === "aborted" || settled === false) {
      await stopAndJoin(child, exit, () => exitResolved, [stdout, stderr]);
      stopped = true;
      throw new DevinError(
        settled === false ? "TIMEOUT" : "PROCESS_EXITED",
        settled === false
          ? "Devin version probe exceeded its bounded deadline"
          : "Devin version probe was canceled",
      );
    }
    outcome = settled;
  } catch (error: unknown) {
    if (!stopped) await stopAndJoin(child, exit, () => exitResolved, [stdout, stderr]);
    if (error instanceof DevinError) throw error;
    throw new DevinError("RUNTIME_MISMATCH", "the Devin version probe failed", { cause: error });
  } finally {
    input.signal.removeEventListener("abort", markAborted);
  }
  const [output, diagnostic, code] = outcome;
  void diagnostic;
  if (code !== 0) {
    throw new DevinError("RUNTIME_MISMATCH", "the Devin executable did not report a version");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(output);
  } catch (error: unknown) {
    throw new DevinError("RUNTIME_MISMATCH", "Devin version output was not valid UTF-8", {
      cause: error,
    });
  }
};

export async function locateDevinExecutable(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<string> {
  const path = environment.PATH ?? "";
  if (new TextEncoder().encode(path).byteLength > 64 * 1024 || path.includes("\0")) {
    throw new DevinError("INVALID_INPUT", "the Devin executable PATH is invalid");
  }
  const entries = path.split(delimiter);
  if (entries.length > 1_024) {
    throw new DevinError("INVALID_INPUT", "the Devin executable PATH has too many entries");
  }
  for (const entry of entries) {
    if (entry.length === 0 || !isAbsolute(entry)) continue;
    if (new TextEncoder().encode(entry).byteLength > 4 * 1024) continue;
    const candidate = join(entry, "devin");
    const stat = await lstat(candidate).catch(() => null);
    if (stat !== null && (stat.isFile() || stat.isSymbolicLink())) return candidate;
  }
  throw new DevinError("RUNTIME_MISMATCH", "the pinned Devin CLI executable is not installed");
}

/**
 * Resolves the Devin executable and admits only the pinned self-reported
 * version. This is a compatibility assertion, not executable provenance: the
 * `/usage` panel is not a published contract, so any other reported version
 * fails closed here rather than being parsed hopefully.
 */
export async function resolvePinnedDevinRuntime(
  options: ResolvePinnedDevinRuntimeOptions,
): Promise<PinnedDevinRuntime> {
  const directories = options.directories === undefined
    ? undefined
    : validateDevinDirectories(options.directories);
  const environment = options.environment ?? process.env;
  const requested = options.executablePath ?? await locateDevinExecutable(environment);
  if (!isAbsolute(requested)) {
    throw new DevinError("INVALID_INPUT", "the Devin executable path must be absolute");
  }
  const executablePath = await realpath(requested).catch((error: unknown) => {
    throw new DevinError("RUNTIME_MISMATCH", "the pinned Devin CLI executable is unavailable", {
      cause: error,
    });
  });
  const stat = await lstat(executablePath);
  if (!stat.isFile()) {
    throw new DevinError("RUNTIME_MISMATCH", "the Devin executable is not a regular file");
  }
  const deadlineMs = options.versionProbeDeadlineMs ?? VERSION_PROBE_DEADLINE_MS;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 60_000) {
    throw new DevinError("INVALID_INPUT", "Devin version probe deadline is invalid");
  }
  const output = await (options.probeVersion ?? spawnDevinVersionProbe)({
    deadlineMs,
    ...(directories === undefined ? {} : { directories }),
    environment,
    executablePath,
    signal: options.signal ?? new AbortController().signal,
    ...(options.processFactory === undefined ? {} : { processFactory: options.processFactory }),
  });
  const line = output.split("\n")[0]?.trim() ?? "";
  const { version, build } = parseDevinVersionEvidence(line);
  assertPinnedDevinVersion(version);
  const argv: PinnedDevinRuntime["argv"] = [
    executablePath,
    "acp",
    "--model",
    DEVIN_MODEL,
  ];
  Object.freeze(argv);
  return Object.freeze({
    argv,
    build,
    executablePath,
    model: DEVIN_MODEL,
    version,
    versionOutput: line,
  });
}
