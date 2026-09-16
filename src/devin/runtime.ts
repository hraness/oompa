import { lstat, realpath } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";

import { DevinError } from "./errors.ts";
import { DEVIN_PIN, DEVIN_VERSION_OUTPUT_PATTERN } from "./pin.ts";

/** Environment keys a Devin child may inherit. Nothing else crosses the boundary. */
export const DEVIN_SAFE_ENVIRONMENT_KEYS: ReadonlySet<string> = new Set([
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOGNAME",
  "PATH",
  "SHELL",
  "TMPDIR",
  "USER",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
]);

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
}

export interface DevinVersionProbeProcess {
  readonly exited: Promise<number>;
  readonly stdout: AsyncIterable<Uint8Array>;
  terminate(): void;
  forceTerminate(): void;
}

export type DevinVersionProbeProcessFactory = (input: Readonly<{
  argv: readonly [string, "--version"];
  environment: Readonly<Record<string, string>>;
}>) => DevinVersionProbeProcess;

export interface ResolvePinnedDevinRuntimeOptions {
  /** Absolute path to the `devin` executable. Located on PATH when omitted. */
  readonly executablePath?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly signal?: AbortSignal;
  /** Whole-probe deadline, 1 to 60000 milliseconds. */
  readonly versionProbeDeadlineMs?: number;
  readonly processFactory?: DevinVersionProbeProcessFactory;
}

const VERSION_PROBE_DEADLINE_MS = 10_000;
const VERSION_PROBE_STDOUT_MAX_BYTES = 4_096;
const VERSION_PROBE_FORCE_GRACE_MS = 1_000;

const defaultVersionProbeProcess: DevinVersionProbeProcessFactory = (input) => {
  const child = Bun.spawn([...input.argv], {
    env: input.environment,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  return {
    exited: child.exited,
    stdout: child.stdout,
    terminate: () => { child.kill("SIGTERM"); },
    forceTerminate: () => { child.kill("SIGKILL"); },
  };
};

const wait = (ms: number): Promise<"timeout"> =>
  new Promise((resolve) => { setTimeout(() => resolve("timeout"), ms); });

async function collectBounded(stream: AsyncIterable<Uint8Array>, maximumBytes: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stream) {
    total += chunk.byteLength;
    if (total > maximumBytes) throw new DevinError("PROTOCOL_LIMIT", "Devin version output exceeded its byte limit.");
    chunks.push(chunk);
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

async function stopProbe(child: DevinVersionProbeProcess, exit: Promise<number>, exited: () => boolean): Promise<void> {
  if (exited()) return;
  child.terminate();
  const settled = await Promise.race([exit.then(() => "exited" as const, () => "exited" as const), wait(VERSION_PROBE_FORCE_GRACE_MS)]);
  if (settled === "timeout") {
    child.forceTerminate();
    await exit.catch(() => undefined);
  }
}

/** Reads `devin --version`, bounded and non-interactive. */
export async function spawnDevinVersionProbe(input: Readonly<{
  executablePath: string;
  environment: Readonly<Record<string, string | undefined>>;
  signal: AbortSignal;
  deadlineMs: number;
  processFactory?: DevinVersionProbeProcessFactory;
}>): Promise<string> {
  input.signal.throwIfAborted();
  const env = devinEnvironment(input.environment);
  env.NO_COLOR = "1";
  let child: DevinVersionProbeProcess;
  try {
    child = (input.processFactory ?? defaultVersionProbeProcess)({
      argv: [input.executablePath, "--version"],
      environment: env,
    });
  } catch (error: unknown) {
    throw new DevinError("RUNTIME_MISMATCH", "the Devin version probe could not be started", { cause: error });
  }
  let exitResolved = false;
  const exit = child.exited.then((code) => { exitResolved = true; return code; });
  const output = collectBounded(child.stdout, VERSION_PROBE_STDOUT_MAX_BYTES);
  const completion = Promise.all([output, exit]);
  let abort!: () => void;
  const aborted = new Promise<"aborted">((resolve) => { abort = () => resolve("aborted"); });
  input.signal.addEventListener("abort", abort, { once: true });
  let stopped = false;
  let outcome: Awaited<typeof completion>;
  try {
    const settled = await Promise.race([completion, aborted, wait(input.deadlineMs)]);
    if (settled === "aborted" || settled === "timeout") {
      await stopProbe(child, exit, () => exitResolved);
      stopped = true;
      output.catch(() => undefined);
      throw new DevinError(
        settled === "timeout" ? "TIMEOUT" : "PROCESS_EXITED",
        settled === "timeout" ? "Devin version probe exceeded its bounded deadline." : "Devin version probe was canceled.",
      );
    }
    outcome = settled;
  } catch (error: unknown) {
    if (!stopped) await stopProbe(child, exit, () => exitResolved);
    if (error instanceof DevinError) throw error;
    throw new DevinError("RUNTIME_MISMATCH", "the Devin version probe failed", { cause: error });
  } finally {
    input.signal.removeEventListener("abort", abort);
  }
  const [bytes, code] = outcome;
  if (code !== 0) throw new DevinError("RUNTIME_MISMATCH", "the Devin executable did not report a version");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error: unknown) {
    throw new DevinError("RUNTIME_MISMATCH", "the Devin version output is not UTF-8", { cause: error });
  }
  return text.split("\n")[0] ?? "";
}

/** Finds `devin` on the allowlisted PATH. No shell is involved. */
export async function locateDevinExecutable(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<string> {
  const path = environment.PATH ?? "";
  for (const entry of path.split(delimiter)) {
    if (entry.length === 0 || !isAbsolute(entry)) continue;
    const candidate = join(entry, "devin");
    const stat = await lstat(candidate).catch(() => null);
    if (stat === null) continue;
    if (stat.isFile() || stat.isSymbolicLink()) return candidate;
  }
  throw new DevinError("RUNTIME_MISMATCH", "the pinned Devin CLI is not installed");
}

/**
 * Resolves the Devin executable and admits only the pinned self-reported
 * version. This is a compatibility assertion, not executable provenance: the
 * usage panel is not a published contract, so any other reported version fails
 * closed here rather than being parsed hopefully.
 */
export async function resolvePinnedDevinRuntime(
  options: ResolvePinnedDevinRuntimeOptions = {},
): Promise<PinnedDevinRuntime> {
  const signal = options.signal ?? new AbortController().signal;
  signal.throwIfAborted();
  const environment = options.environment ?? process.env;
  const requested = options.executablePath ?? (await locateDevinExecutable(environment));
  signal.throwIfAborted();
  if (!isAbsolute(requested)) throw new DevinError("INVALID_INPUT", "the Devin executable path must be absolute");
  const executablePath = await realpath(requested).catch((error: unknown) => {
    throw new DevinError("RUNTIME_MISMATCH", "the pinned Devin CLI executable is unavailable", { cause: error });
  });
  signal.throwIfAborted();
  const stat = await lstat(executablePath);
  if (!stat.isFile()) throw new DevinError("RUNTIME_MISMATCH", "the Devin executable is not a regular file");
  const deadlineMs = options.versionProbeDeadlineMs ?? VERSION_PROBE_DEADLINE_MS;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 60_000) {
    throw new DevinError("INVALID_INPUT", "Devin version probe deadline is invalid");
  }
  const reported = await spawnDevinVersionProbe({
    executablePath,
    environment,
    signal,
    deadlineMs,
    ...(options.processFactory === undefined ? {} : { processFactory: options.processFactory }),
  });
  signal.throwIfAborted();
  const match = DEVIN_VERSION_OUTPUT_PATTERN.exec(reported);
  if (match === null) throw new DevinError("RUNTIME_MISMATCH", "the Devin executable reported no exact version");
  const [, version, build] = match;
  if (version !== DEVIN_PIN || build === undefined) {
    throw new DevinError("RUNTIME_MISMATCH", `Oompa requires Devin CLI ${DEVIN_PIN}`);
  }
  return { executablePath, version: DEVIN_PIN, build, versionOutput: reported.trim() };
}
