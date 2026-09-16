import { ClaudeError } from "./errors.ts";

export type ClaudeProcessIdentity = Readonly<{
  readonly pid: number;
  readonly pidDomain: "darwin" | "linux";
  /** Exact trimmed output of `ps -p <pid> -o lstart=` under the C/UTC locale. */
  readonly procStart: string;
}>;

export type ClaudeProcessIdentityInspection = Readonly<{
  exited: Promise<number>;
  stdout: AsyncIterable<Uint8Array>;
  forceTerminate(): void;
}>;

export type ClaudeProcessIdentityInspectionSpawner = (input: Readonly<{
  argv: readonly [string, ...string[]];
  environment: Readonly<Record<string, string>>;
}>) => ClaudeProcessIdentityInspection;

export type ClaudeLaunchIntentLiveness = "live" | "not_live" | "unknown";

export type ClaudeLaunchIntentProbeOptions = Readonly<{
  /** Absolute wall-clock deadline for this observation. */
  deadlineAt: number;
  signal: AbortSignal;
}>;

export interface ClaudeProcess {
  /** Exact child identity, proven from the local process table after spawn. */
  readonly identity: Promise<ClaudeProcessIdentity>;
  readonly stdout: AsyncIterable<Uint8Array>;
  readonly stderr: AsyncIterable<Uint8Array>;
  readonly exited: Promise<number>;
  write(bytes: Uint8Array): Promise<void>;
  terminate(): void;
  forceTerminate(): void;
}

export interface SpawnClaudeProcessOptions {
  readonly argv: readonly [string, ...string[]];
  /** Absolute reviewed location of the Claude configuration/session home. */
  readonly configDir: string;
  /**
   * Isolated homes are selected explicitly with `CLAUDE_CONFIG_DIR`. The
   * current user's personal home must use Claude's default-home semantics:
   * exporting `CLAUDE_CONFIG_DIR=~/.claude` would instead select the nested
   * and unrelated `~/.claude/.claude.json` account document.
   */
  readonly configHome?: "isolated" | "personal";
  readonly projectRoot?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  /** Test seam. Production always uses the bounded non-shell `ps` inspector. */
  readonly inspectIdentity?: (pid: number) => Promise<ClaudeProcessIdentity>;
}

const PROCESS_IDENTITY_TIMEOUT_MS = 1_000;
const PROCESS_IDENTITY_STDOUT_BYTES = 256;
const PROCESS_START_BYTES = 128;
const LAUNCH_INTENT_TIMEOUT_MS = 1_000;
const LAUNCH_INTENT_STDOUT_BYTES = 4 * 1_024 * 1_024;
const LAUNCH_INTENT_LINE_BYTES = 256 * 1_024;
const LAUNCH_INTENT_ID_BYTES = 200;
const LAUNCH_INTENT_ID_LIMIT = 4_096;
const encoder = new TextEncoder();

type ClaudeLaunchIntentSnapshot = ReadonlySet<string> | null;

/**
 * The same allowlist the Codex spawner uses. Nothing else from the parent
 * environment crosses the boundary, so no ambient API key, proxy, or provider
 * credential can reach the Claude runtime.
 */
export const SAFE_ENVIRONMENT_KEYS: ReadonlySet<string> = new Set([
  "HOME",
  "HRANESS_SUPPORT",
  "HRANESS_SUPPORT_AUDIENCE",
  "HRANESS_SUPPORT_EMAIL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOGNAME",
  "PATH",
  "SHELL",
  "TMPDIR",
  "USER",
]);

export function allowlistedEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  extraKeys: ReadonlySet<string> = new Set(),
): Record<string, string> {
  const env: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [key, value] of Object.entries(environment)) {
    if ((SAFE_ENVIRONMENT_KEYS.has(key) || extraKeys.has(key)) && value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}

/**
 * Takes at most one bounded local process-table snapshot and answers every
 * session lookup from the redacted set of launch ids extracted from it.
 * Raw command lines are never retained, returned, or included in an error.
 */
export class ClaudeLaunchIntentLivenessProbe {
  readonly #platform: NodeJS.Platform;
  readonly #spawn: ClaudeProcessIdentityInspectionSpawner;
  readonly #now: () => number;
  #snapshot: Promise<ClaudeLaunchIntentSnapshot> | undefined;

  constructor(options: Readonly<{
    platform?: NodeJS.Platform;
    spawn?: ClaudeProcessIdentityInspectionSpawner;
    now?: () => number;
  }> = {}) {
    this.#platform = options.platform ?? process.platform;
    this.#spawn = options.spawn ?? spawnProcessIdentityInspection;
    this.#now = options.now ?? Date.now;
  }

  async probe(
    providerThreadId: string,
    options: ClaudeLaunchIntentProbeOptions,
  ): Promise<ClaudeLaunchIntentLiveness> {
    if (!validLaunchIntentId(providerThreadId) || !validProbeOptions(options, this.#now)) {
      return "unknown";
    }
    this.#snapshot ??= this.#captureSnapshot(options).catch(() => null);
    try {
      const snapshot = await awaitSnapshot(this.#snapshot, options, this.#now);
      if (snapshot === null) return "unknown";
      return snapshot.has(providerThreadId) ? "live" : "not_live";
    } catch {
      return "unknown";
    }
  }

  async #captureSnapshot(
    options: ClaudeLaunchIntentProbeOptions,
  ): Promise<ClaudeLaunchIntentSnapshot> {
    if (this.#platform !== "darwin" && this.#platform !== "linux") return null;
    let remaining: number;
    try {
      remaining = options.deadlineAt - this.#now();
    } catch {
      return null;
    }
    if (!Number.isFinite(remaining) || remaining <= 0 || options.signal.aborted) return null;

    let inspection: ClaudeProcessIdentityInspection;
    try {
      inspection = this.#spawn({
        argv: ["/bin/ps", "-axww", "-o", "command="],
        environment: {
          LANG: "C",
          LC_ALL: "C",
          PATH: "/usr/bin:/bin",
          TZ: "UTC",
        },
      });
    } catch {
      return null;
    }

    const output = readBoundedLaunchIntentOutput(inspection.stdout);
    const completed = Promise.all([inspection.exited, output]);
    // An abort/timeout can win the race before a malformed stream rejects.
    // Own that later rejection without exposing process-table content.
    void completed.catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stop!: () => void;
    let stoppedOnce = false;
    const stopped = new Promise<null>((resolve) => {
      stop = () => {
        if (stoppedOnce) return;
        stoppedOnce = true;
        try {
          inspection.forceTerminate();
        } catch {
          // The conservative unknown result remains authoritative.
        }
        resolve(null);
      };
      options.signal.addEventListener("abort", stop, { once: true });
      timer = setTimeout(stop, Math.min(LAUNCH_INTENT_TIMEOUT_MS, Math.max(1, remaining)));
      timer.unref();
      if (options.signal.aborted) stop();
    });

    try {
      const completedOrStopped = await Promise.race([completed, stopped]);
      if (completedOrStopped === null) return null;
      const [exitCode, stdout] = completedOrStopped;
      if (exitCode !== 0) return null;
      return parseLaunchIntentSnapshot(stdout);
    } catch {
      try {
        inspection.forceTerminate();
      } catch {
        // The inspection failure still maps to one closed unknown result.
      }
      return null;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      options.signal.removeEventListener("abort", stop);
    }
  }
}

export function spawnBunClaudeProcess(options: SpawnClaudeProcessOptions): ClaudeProcess {
  if (!options.configDir.startsWith("/")) {
    throw new ClaudeError("INVALID_INPUT", "CLAUDE_CONFIG_DIR must be an absolute path");
  }
  const env = allowlistedEnvironment(options.environment ?? process.env);
  if ((options.configHome ?? "isolated") === "isolated") {
    env.CLAUDE_CONFIG_DIR = options.configDir;
  }
  env.NO_COLOR = "1";

  const child = Bun.spawn([...options.argv], {
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    ...(options.projectRoot === undefined ? {} : { cwd: options.projectRoot }),
  });

  if (typeof child.stdin === "number") {
    child.kill();
    throw new ClaudeError("PROCESS_EXITED", "Claude did not expose a writable stdin pipe");
  }

  const stdin = child.stdin;
  const identity = Promise.resolve()
    .then(async () => await (options.inspectIdentity ?? inspectSpawnedClaudeProcessIdentity)(child.pid))
    .catch((cause: unknown) => {
      // A child whose exact process identity is unknown can never be admitted
      // as Oompa's exclusive writer. Reap it even if a caller forgets to await
      // the identity promise itself.
      try {
        child.kill("SIGKILL");
      } catch {
        // The manager still performs and verifies its own bounded close.
      }
      throw cause instanceof ClaudeError
        ? cause
        : new ClaudeError(
            "AUTHORITY_STALE",
            "Claude child process identity could not be proven.",
            { cause },
          );
    });
  // The manager awaits this during admission. Own an earlier rejection so a
  // very short-lived child cannot create an unhandled promise in the gap.
  void identity.catch(() => undefined);
  return {
    exited: child.exited,
    forceTerminate(): void {
      child.kill("SIGKILL");
    },
    stderr: readableStreamChunks(child.stderr),
    identity,
    stdout: readableStreamChunks(child.stdout),
    terminate(): void {
      child.kill("SIGTERM");
    },
    async write(bytes: Uint8Array): Promise<void> {
      const written = stdin.write(bytes);
      const count = written instanceof Promise ? await written : written;
      if (count !== bytes.byteLength) {
        throw new ClaudeError("PROCESS_EXITED", "Claude stdin accepted a partial frame");
      }
      const flushed = stdin.flush();
      if (flushed instanceof Promise) await flushed;
    },
  };
}

/**
 * Read one bounded host process-start token for the newly spawned child. The
 * command is fixed, non-shell, C-locale, UTC, byte bounded, and deadline
 * bounded so authority admission cannot hang on process inspection.
 */
export async function inspectSpawnedClaudeProcessIdentity(
  pid: number,
  options: Readonly<{
    platform?: NodeJS.Platform;
    spawn?: ClaudeProcessIdentityInspectionSpawner;
  }> = {},
): Promise<ClaudeProcessIdentity> {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new ClaudeError("AUTHORITY_STALE", "Claude returned an invalid child process id.");
  }
  const platform = options.platform ?? process.platform;
  const pidDomain = platform === "darwin"
    ? "darwin"
    : platform === "linux"
      ? "linux"
      : null;
  if (pidDomain === null) {
    throw new ClaudeError(
      "AUTHORITY_STALE",
      "Claude child process identity is unsupported on this platform.",
    );
  }
  const inspection = (options.spawn ?? spawnProcessIdentityInspection)({
    argv: ["/bin/ps", "-p", String(pid), "-o", "lstart="],
    environment: {
      LANG: "C",
      LC_ALL: "C",
      PATH: "/usr/bin:/bin",
      TZ: "UTC",
    },
  });
  const output = readBoundedInspectionOutput(inspection.stdout);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      try {
        inspection.forceTerminate();
      } catch {
        // The timeout rejection is the authority result; a failed best-effort
        // inspector kill must not escape the timer callback.
      }
      reject(new ClaudeError("TIMEOUT", "Claude child process identity inspection timed out."));
    }, PROCESS_IDENTITY_TIMEOUT_MS);
    timer.unref();
  });
  try {
    const [exitCode, stdout] = await Promise.race([
      Promise.all([inspection.exited, output]),
      timeout,
    ]);
    if (exitCode !== 0) {
      throw new ClaudeError(
        "AUTHORITY_STALE",
        "Claude child process identity was absent from the local process table.",
      );
    }
    const lines = stdout
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const procStart = lines[0];
    if (
      lines.length !== 1
      || procStart === undefined
      || procStart.length === 0
      || encoder.encode(procStart).byteLength > PROCESS_START_BYTES
      || !/^[\x20-\x7e]+$/u.test(procStart)
    ) {
      throw new ClaudeError(
        "AUTHORITY_STALE",
        "Claude child process start identity was malformed.",
      );
    }
    return Object.freeze({ pid, pidDomain, procStart });
  } catch (error: unknown) {
    try {
      inspection.forceTerminate();
    } catch {
      // Preserve the inspection failure as the actionable authority result.
    }
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function spawnProcessIdentityInspection(
  input: Parameters<ClaudeProcessIdentityInspectionSpawner>[0],
): ClaudeProcessIdentityInspection {
  const child = Bun.spawn([...input.argv], {
    env: { ...input.environment },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  return {
    exited: child.exited,
    forceTerminate: () => { child.kill("SIGKILL"); },
    stdout: readableStreamChunks(child.stdout),
  };
}

export function parseClaudeProcessIdentity(value: unknown): ClaudeProcessIdentity {
  if (typeof value !== "object" || value === null) {
    throw new ClaudeError("AUTHORITY_STALE", "Claude child process identity was missing.");
  }
  const candidate = value as Readonly<Record<string, unknown>>;
  const pid = candidate.pid;
  const pidDomain = candidate.pidDomain;
  const procStart = candidate.procStart;
  if (
    typeof pid !== "number"
    || !Number.isSafeInteger(pid)
    || pid <= 0
    || (pidDomain !== "darwin" && pidDomain !== "linux")
    || typeof procStart !== "string"
    || procStart.length === 0
    || encoder.encode(procStart).byteLength > PROCESS_START_BYTES
    || !/^[\x20-\x7e]+$/u.test(procStart)
  ) {
    throw new ClaudeError("AUTHORITY_STALE", "Claude child process identity was malformed.");
  }
  return Object.freeze({ pid, pidDomain, procStart });
}

function validLaunchIntentId(value: unknown): value is string {
  return typeof value === "string"
    && encoder.encode(value).byteLength >= 1
    && encoder.encode(value).byteLength <= LAUNCH_INTENT_ID_BYTES
    && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value);
}

function validProbeOptions(
  options: unknown,
  now: () => number,
): options is ClaudeLaunchIntentProbeOptions {
  if (typeof options !== "object" || options === null) return false;
  const candidate = options as Readonly<Record<string, unknown>>;
  const deadlineAt = candidate.deadlineAt;
  const signal = candidate.signal;
  if (
    typeof deadlineAt !== "number"
    || typeof signal !== "object"
    || signal === null
  ) return false;
  const abortSignal = signal as Readonly<Record<string, unknown>>;
  if (
    typeof abortSignal.aborted !== "boolean"
    || typeof abortSignal.addEventListener !== "function"
    || typeof abortSignal.removeEventListener !== "function"
  ) return false;
  try {
    return Number.isSafeInteger(deadlineAt)
      && deadlineAt >= 0
      && deadlineAt > now()
      && !abortSignal.aborted;
  } catch {
    return false;
  }
}

async function awaitSnapshot(
  snapshot: Promise<ClaudeLaunchIntentSnapshot>,
  options: ClaudeLaunchIntentProbeOptions,
  now: () => number,
): Promise<ClaudeLaunchIntentSnapshot> {
  let remaining: number;
  try {
    remaining = options.deadlineAt - now();
  } catch {
    return null;
  }
  if (!Number.isFinite(remaining) || remaining <= 0 || options.signal.aborted) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stop!: () => void;
  const stopped = new Promise<null>((resolve) => {
    stop = () => { resolve(null); };
    options.signal.addEventListener("abort", stop, { once: true });
    timer = setTimeout(
      stop,
      Math.min(LAUNCH_INTENT_TIMEOUT_MS, Math.max(1, remaining)),
    );
    timer.unref();
    if (options.signal.aborted) stop();
  });
  try {
    return await Promise.race([snapshot, stopped]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    options.signal.removeEventListener("abort", stop);
  }
}

function parseLaunchIntentSnapshot(output: string): ReadonlySet<string> | null {
  const ids = new Set<string>();
  for (const rawLine of output.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (
      encoder.encode(line).byteLength > LAUNCH_INTENT_LINE_BYTES
      || containsUnsafeProcessControl(line)
    ) return null;
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const argv = trimmed.split(/[ \t]+/u);
    for (let index = 0; index < argv.length; index += 1) {
      const token = argv[index];
      if (token !== "--session-id" && token !== "--resume") continue;
      const providerThreadId = argv[index + 1];
      if (!validLaunchIntentId(providerThreadId)) return null;
      ids.add(providerThreadId);
      if (ids.size > LAUNCH_INTENT_ID_LIMIT) return null;
      index += 1;
    }
  }
  return ids;
}

function containsUnsafeProcessControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 8 || (code >= 11 && code <= 31) || code === 127) return true;
  }
  return false;
}

async function readBoundedLaunchIntentOutput(
  stream: AsyncIterable<Uint8Array>,
): Promise<string> {
  const chunks: Uint8Array[] = [];
  let observed = 0;
  for await (const chunk of stream) {
    observed += chunk.byteLength;
    if (observed > LAUNCH_INTENT_STDOUT_BYTES) {
      throw new Error("Claude launch-intent process snapshot exceeded its byte bound.");
    }
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(observed);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Claude launch-intent process snapshot was malformed.");
  }
}

async function readBoundedInspectionOutput(
  stream: AsyncIterable<Uint8Array>,
): Promise<string> {
  const chunks: Uint8Array[] = [];
  let observed = 0;
  for await (const chunk of stream) {
    observed += chunk.byteLength;
    if (observed > PROCESS_IDENTITY_STDOUT_BYTES) {
      throw new ClaudeError("PROTOCOL_LIMIT", "Process identity output exceeded its bound.");
    }
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(observed);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (cause: unknown) {
    throw new ClaudeError("AUTHORITY_STALE", "Process identity output was not UTF-8.", { cause });
  }
}

async function* readableStreamChunks(
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
}
