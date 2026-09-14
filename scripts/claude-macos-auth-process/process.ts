import { isAbsolute, resolve } from "node:path";

import type { ClaudeAuthStatusProcess, ClaudeAuthStatusProcessFactory } from "../../src/claude/auth";
import type { ClaudeVersionProbeProcessFactory } from "../../src/claude/runtime";
import { bindDarwinQualificationEnvironment } from "./binding";
import { collectOwnedDarwinInspector, detachedProcessError, inspectDarwinDetachedChild, parseDarwinLiveSnapshot,
  type DarwinDetachedIdentity, type DarwinDetachmentInspection } from "./detachment";

export type DetachedAuthOperation = "status" | "version" | "login_help" | "logout_help" | "logout";
const argumentsByOperation = {
  status: ["auth", "status", "--json"],
  version: ["--version"],
  login_help: ["auth", "login", "--help"],
  logout_help: ["auth", "logout", "--help"],
  logout: ["auth", "logout"],
} as const;

export function detachedAuthArguments(executable: unknown, operation: unknown): readonly [string, ...string[]] {
  if (typeof operation !== "string" || !Object.hasOwn(argumentsByOperation, operation)
    || typeof executable !== "string" || !isAbsolute(executable) || resolve(executable) !== executable || executable.length > 4096 || executable.includes("\0")) {
    throw detachedProcessError("operation_refused");
  }
  return Object.freeze([executable, ...argumentsByOperation[operation as DetachedAuthOperation]]);
}

export type DetachedAuthSettlement = Readonly<{
  operation: DetachedAuthOperation;
  cleanup: "joined" | "uncertain";
  admitted: boolean;
  exitCode: number | null;
  childJoined: boolean;
  stdoutEof: boolean;
  stderrEof: boolean;
  stdoutBytes: number;
  stderrBytes: number;
  detachment: (DarwinDetachedIdentity & Readonly<{ stdinClosed: true }>) | null;
  deadlineMs: number;
  elapsedMs: number;
  inspectionComplete: boolean;
  inspectorsStarted: number;
  inspectorsJoined: number;
}>;
export interface DetachedAuthProcess extends ClaudeAuthStatusProcess {
  readonly settlement: Promise<DetachedAuthSettlement>;
}

export type DetachedStatusOverlap = Readonly<{
  admitted: boolean;
  cleanup: "joined" | "uncertain";
  reason: "observed" | "lifetime_unproven" | "aborted" | "target_unproved" | "inspector_unjoined";
  observationDeadlineMs: number;
  observationElapsedMs: number;
  inspectorsStarted: number;
  inspectorsJoined: number;
  targetsJoined: number;
  witness: Readonly<{ order: "A1_B_A2"; first: DarwinDetachedIdentity["identity"]; second: DarwinDetachedIdentity["identity"] }> | null;
}>;

const wait = async (milliseconds: number): Promise<"deadline"> => {
  await Bun.sleep(milliseconds); return "deadline";
};
type Capture = { readonly reader: ReadableStreamDefaultReader<Uint8Array>; eof: boolean; settled: boolean; cancelled: boolean; total: number; output: Uint8Array };
async function capture(value: Capture, maximum: number): Promise<void> {
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const next = await value.reader.read();
      if (next.done) { value.eof = !value.cancelled; break; }
      value.total += next.value.byteLength;
      if (value.total > maximum) throw detachedProcessError("output_limit");
      chunks.push(next.value.slice());
    }
    value.output = new Uint8Array(value.total);
    let offset = 0;
    for (const chunk of chunks) { value.output.set(chunk, offset); offset += chunk.byteLength; }
  } finally {
    if (!value.eof) {
      value.cancelled = true;
      await value.reader.cancel();
    }
    value.settled = true;
    value.reader.releaseLock();
  }
}

class OwnedDetachedProcess implements DetachedAuthProcess {
  readonly settlement: Promise<DetachedAuthSettlement>;
  readonly #ownedSettlement: Promise<DetachedAuthSettlement>;
  readonly exited: Promise<number>;
  readonly stdout: AsyncIterable<Uint8Array>;
  readonly stderr: AsyncIterable<Uint8Array>;
  readonly #child: Bun.Subprocess<"ignore", "pipe", "pipe">;
  readonly #operation: DetachedAuthOperation;
  readonly #release: (joined: boolean, admitted: boolean) => void;
  #baseOutcome: Readonly<{ joined: boolean; admitted: boolean }> | null = null;
  #released = false;
  #pairClaimed = false;
  #pairPending = false;
  #pairAdmitted = true;
  #pairJoined = true;
  #childJoined = false;
  #exitCode: number | null = null;
  #interrupted = false;

  constructor(operation: DetachedAuthOperation, argv: readonly [string, ...string[]], environment: Readonly<Record<string, string>>, cwd: string,
    deadlineMs: number, release: (joined: boolean, admitted: boolean) => void) {
    const startedAt = Math.floor(performance.now());
    this.#operation = operation;
    this.#release = release;
    this.#child = Bun.spawn([...argv], { cwd, env: environment, detached: true, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const exit = this.#child.exited.then((code) => { this.#childJoined = true; this.#exitCode = code; });
    const stdout: Capture = { reader: this.#child.stdout.getReader(), eof: false, settled: false, cancelled: false, total: 0, output: new Uint8Array() };
    const stderr: Capture = { reader: this.#child.stderr.getReader(), eof: false, settled: false, cancelled: false, total: 0, output: new Uint8Array() };
    const output = capture(stdout, 16 * 1024);
    const diagnostic = capture(stderr, 4 * 1024);
    let inspection: DarwinDetachmentInspection | null = null;
    const readInspection = (): DarwinDetachmentInspection | null => inspection;
    const detachment = inspectDarwinDetachedChild(this.#child.pid, () => this.#childJoined).then(
      (value) => { inspection = value; if (value.witness === null || value.cleanup !== "joined") throw detachedProcessError("detachment_unproven"); return value.witness; },
    );
    this.settlement = (async () => {
      let witness: DarwinDetachedIdentity | null = null;
      let successful = false;
      try {
        const result = await Promise.race([Promise.all([exit, output, diagnostic, detachment]), wait(deadlineMs)]);
        if (result === "deadline") throw detachedProcessError("deadline");
        witness = result[3]; successful = !this.#interrupted;
      } catch {
        this.terminate();
        await Promise.race([exit.catch(() => undefined), wait(100)]);
        this.forceTerminate();
        await Promise.race([Promise.allSettled([exit, output, diagnostic, detachment]), wait(500)]);
        if (!stdout.settled) { stdout.cancelled = true; await Promise.race([stdout.reader.cancel().catch(() => undefined), wait(100)]); }
        if (!stderr.settled) { stderr.cancelled = true; await Promise.race([stderr.reader.cancel().catch(() => undefined), wait(100)]); }
        await Promise.race([Promise.allSettled([exit, output, diagnostic, detachment]), wait(100)]);
      }
      const observedInspection = readInspection();
      const joined = this.#childJoined && stdout.settled && stderr.settled && observedInspection?.cleanup === "joined";
      const admitted = successful && joined && stdout.eof && stderr.eof && witness !== null;
      this.#baseOutcome = { joined, admitted };
      this.#releaseIfComplete();
      return Object.freeze({ operation, cleanup: joined ? "joined" : "uncertain", admitted,
        exitCode: this.#exitCode, childJoined: this.#childJoined, stdoutEof: stdout.eof, stderrEof: stderr.eof,
        stdoutBytes: stdout.total, stderrBytes: stderr.total,
        detachment: witness === null ? null : Object.freeze({ ...witness, stdinClosed: true as const }),
        deadlineMs, elapsedMs: Math.floor(performance.now()) - startedAt,
        inspectionComplete: observedInspection !== null,
        inspectorsStarted: observedInspection?.inspectorsStarted ?? 0, inspectorsJoined: observedInspection?.inspectorsJoined ?? 0,
      });
    })();
    this.#ownedSettlement = this.settlement;
    const completion = this.#ownedSettlement.then((settlement) => {
      if (!settlement.admitted || settlement.exitCode === null) throw detachedProcessError("observation_unproven");
      return settlement.exitCode;
    });
    void completion.catch(() => undefined);
    this.exited = completion;
    this.stdout = { async *[Symbol.asyncIterator]() { await completion; if (stdout.output.byteLength > 0) yield stdout.output; } };
    this.stderr = { async *[Symbol.asyncIterator]() { await completion; if (stderr.output.byteLength > 0) yield stderr.output; } };
  }

  #releaseIfComplete(): void {
    if (this.#baseOutcome === null || this.#pairPending || this.#released) return;
    this.#released = true;
    this.#release(this.#baseOutcome.joined && this.#pairJoined, this.#baseOutcome.admitted && this.#pairAdmitted);
  }

  static #actual(value: unknown): value is OwnedDetachedProcess {
    return typeof value === "object" && value !== null && #child in value;
  }

  static async overlap(firstInput: unknown, secondInput: unknown, options: Readonly<{ signal: AbortSignal; deadlineMs: number }>): Promise<DetachedStatusOverlap> {
    if (!OwnedDetachedProcess.#actual(firstInput) || !OwnedDetachedProcess.#actual(secondInput)
      || firstInput === secondInput || !(options.signal instanceof AbortSignal) || !Number.isSafeInteger(options.deadlineMs)
      || options.deadlineMs < 100 || options.deadlineMs > 1000) throw detachedProcessError("overlap_pair_refused");
    const first = firstInput; const second = secondInput;
    const participants = [first, second] as const;
    if (first.#child.pid === second.#child.pid || participants.some((value) => value.#operation !== "status" || value.#childJoined
      || value.#interrupted || value.#pairClaimed || value.#baseOutcome !== null)) throw detachedProcessError("overlap_pair_refused");
    const signal = options.signal; const deadlineMs = options.deadlineMs;
    const startedAt = performance.now();
    const deadline = startedAt + deadlineMs;
    for (const value of participants) { value.#pairClaimed = true; value.#pairPending = true; }
    let inspectorsStarted = 0; let inspectorsJoined = 0;
    let inspectorUnknown = false;
    const inspectorCleanupKnown = (): boolean => !inspectorUnknown;
    let observation: Readonly<{ first: ReturnType<typeof parseDarwinLiveSnapshot>; second: ReturnType<typeof parseDarwinLiveSnapshot> }> | null = null;
    let reason: DetachedStatusOverlap["reason"] = "lifetime_unproven";
    const readObservation = () => observation;
    const abort = (): void => { first.#interrupt("SIGTERM"); second.#interrupt("SIGTERM"); };
    const active = (): boolean => !signal.aborted && participants.every((value) => !value.#childJoined && !value.#interrupted && value.#baseOutcome === null);
    const snapshot = async (value: OwnedDetachedProcess): Promise<ReturnType<typeof parseDarwinLiveSnapshot>> => {
      const remaining = Math.floor(deadline - performance.now());
      if (!active() || remaining < 100) throw detachedProcessError("lifetime_unproven");
      let inspector: Bun.Subprocess<"ignore", "pipe", "pipe">;
      try {
        inspector = Bun.spawn(["/bin/ps", "-p", String(value.#child.pid), "-o", "pid=,lstart=,tdev=,state="], {
          env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C", TZ: "UTC" }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
        });
      } catch { inspectorUnknown = true; throw detachedProcessError("inspector_spawn_unproven"); }
      inspectorsStarted += 1;
      const result = await collectOwnedDarwinInspector(inspector, Math.min(1000, remaining));
      if (result.cleanup === "joined") inspectorsJoined += 1;
      else inspectorUnknown = true;
      if (result.output === null || !active() || performance.now() >= deadline) throw detachedProcessError("lifetime_unproven");
      const point = parseDarwinLiveSnapshot(result.output);
      if (point.pid !== value.#child.pid) throw detachedProcessError("lifetime_unproven");
      return point;
    };
    signal.addEventListener("abort", abort);
    try {
      if (signal.aborted) abort();
      const before = await snapshot(first);
      const middle = await snapshot(second);
      const after = await snapshot(first);
      if (before.pid !== after.pid || before.procStart !== after.procStart) throw detachedProcessError("lifetime_unproven");
      observation = { first: before, second: middle };
    } catch { /* Every started inspector and both target settlements remain required. */ }
    const observationElapsedMs = Math.floor(performance.now() - startedAt);
    const settled = await Promise.allSettled(participants.map((value) => value.#ownedSettlement));
    signal.removeEventListener("abort", abort);
    const targetsJoined = settled.filter((value) => value.status === "fulfilled" && value.value.cleanup === "joined" && value.value.childJoined).length;
    const inspectorsComplete = inspectorCleanupKnown() && inspectorsStarted === inspectorsJoined;
    const joined = targetsJoined === 2 && inspectorsComplete;
    const points = readObservation();
    let targetIdentitiesMatch = points !== null;
    for (const [index, result] of settled.entries()) {
      const expected = index === 0 ? points?.first : points?.second;
      if (result.status !== "fulfilled" || !result.value.admitted || result.value.operation !== "status"
        || (result.value.exitCode !== 0 && result.value.exitCode !== 1) || result.value.detachment === null
        || expected === undefined || result.value.detachment.identity.pid !== expected.pid
        || result.value.detachment.identity.procStart !== expected.procStart) targetIdentitiesMatch = false;
    }
    const admitted = joined && targetIdentitiesMatch && !signal.aborted;
    if (signal.aborted) reason = "aborted";
    else if (!inspectorsComplete) reason = "inspector_unjoined";
    else if (points !== null && !targetIdentitiesMatch) reason = "target_unproved";
    else if (admitted) reason = "observed";
    for (const value of participants) {
      value.#pairPending = false; value.#pairJoined = joined; value.#pairAdmitted = admitted; value.#releaseIfComplete();
    }
    return Object.freeze({ admitted, cleanup: joined ? "joined" : "uncertain", reason, observationDeadlineMs: deadlineMs,
      observationElapsedMs, inspectorsStarted, inspectorsJoined, targetsJoined,
      witness: !admitted || points === null ? null : Object.freeze({ order: "A1_B_A2" as const,
        first: Object.freeze({ ...points.first, pidDomain: "darwin" as const }), second: Object.freeze({ ...points.second, pidDomain: "darwin" as const }) }),
    });
  }

  terminate(): void {
    this.#interrupt("SIGTERM");
  }
  forceTerminate(): void {
    this.#interrupt("SIGKILL");
  }
  #interrupt(signal: "SIGTERM" | "SIGKILL"): void {
    this.#interrupted = true;
    if (!this.#childJoined) { try { this.#child.kill(signal); } catch { /* Missing native collection stays uncertain. */ } }
  }
}

/** One observation over two real retained status instances, never caller PIDs or fixture facts. */
export async function observeDarwinDetachedStatusOverlap(first: DetachedAuthProcess, second: DetachedAuthProcess,
  options: Readonly<{ signal: AbortSignal; deadlineMs: number }>): Promise<DetachedStatusOverlap> {
  return await OwnedDetachedProcess.overlap(first, second, options);
}

/** No CLI or production capability. The caller separately owns source, provider and authentication admission. */
export function bindDarwinDetachedAuthProcess(input: Readonly<{
  executablePath: string;
  executableSha256: string;
  configDir: string;
  temporaryDirectory: string;
  environment: Readonly<Record<string, string | undefined>>;
  deadlineMs: number;
}>): Readonly<{
  environment: Readonly<Record<string, string>>;
  statusFactory: ClaudeAuthStatusProcessFactory;
  versionFactory: ClaudeVersionProbeProcessFactory;
  start(operation: DetachedAuthOperation): DetachedAuthProcess;
  settled(): Promise<DetachedAuthSettlement | null>;
}> {
  input = Object.freeze({ ...input, environment: Object.freeze({ ...input.environment }) });
  if (process.platform !== "darwin" || Bun.version !== "1.3.14") throw detachedProcessError("platform_refused");
  if (!/^[0-9a-f]{64}$/u.test(input.executableSha256) || !Number.isSafeInteger(input.deadlineMs) || input.deadlineMs < 100 || input.deadlineMs > 5_000) throw detachedProcessError("binding_refused");
  const binding = bindDarwinQualificationEnvironment(input);
  const environment = binding.environment;
  let active = false;
  let uncertain = false;
  let last: DetachedAuthProcess | null = null;
  const start = (operation: DetachedAuthOperation): DetachedAuthProcess => {
    const argv = detachedAuthArguments(input.executablePath, operation);
    if (active || uncertain) throw detachedProcessError("owner_busy");
    binding.assertCurrent();
    active = true;
    try {
      last = new OwnedDetachedProcess(operation, argv, environment, input.configDir, input.deadlineMs, (joined, admitted) => { active = false; uncertain ||= !joined || !admitted; });
      return last;
    } catch (error: unknown) { active = false; uncertain = true; throw error; }
  };
  const factory = (operation: "status" | "version", actual: Readonly<{ argv: readonly string[]; environment: Readonly<Record<string, string>> }>): DetachedAuthProcess => {
    const expected = detachedAuthArguments(input.executablePath, operation);
    if (actual.argv.length !== expected.length || actual.argv.some((value, index) => value !== expected[index])
      || Object.keys(actual.environment).length !== Object.keys(environment).length
      || Object.entries(environment).some(([key, value]) => actual.environment[key] !== value)) throw detachedProcessError("factory_refused");
    return start(operation);
  };
  return Object.freeze({ environment, start, statusFactory: (actual) => factory("status", actual), versionFactory: (actual) => factory("version", actual),
    async settled() { return last === null ? null : await last.settlement; },
  });
}
