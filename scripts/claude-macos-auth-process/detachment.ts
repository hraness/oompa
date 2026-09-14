import { dlopen } from "bun:ffi";
import type { ClaudeProcessIdentity } from "../../src/claude/process";
const inspectionEnvironment = { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C", TZ: "UTC" };
type SessionLibrary = Readonly<{ symbols: Readonly<{
  getsid(pid: number): number;
  getpgid(pid: number): number;
}> }>;
let library: SessionLibrary | undefined;

export type DarwinDetachedIdentity = Readonly<{
  identity: ClaudeProcessIdentity;
  setsidChecked: true;
  newSession: true;
  controllingTty: false;
}>;
export type DarwinDetachmentInspection = Readonly<{
  witness: DarwinDetachedIdentity | null;
  cleanup: "joined" | "uncertain";
  inspectorsStarted: number;
  inspectorsJoined: number;
}>;

export const detachedProcessError = (code: string): Error => new Error(`claude_macos_auth_process_${code}`);

/** Apple ps tdev prints ?? only for NODEV; tty also conflates lookup failure. */
export function parseDarwinTerminalDevice(value: unknown): Readonly<{ pid: number; procStart: string }> {
  if (typeof value !== "string" || Buffer.byteLength(value) > 384) throw detachedProcessError("identity_refused");
  const match = /^ *([1-9][0-9]{0,9}) +((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) +(?:[1-9]|[12][0-9]|3[01]) (?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9] [0-9]{4}) +\?\? *\n?$/u.exec(value);
  if (match?.[1] === undefined || match[2] === undefined) throw detachedProcessError("identity_refused");
  const pid = Number(match[1]);
  if (pid > 2_147_483_647) throw detachedProcessError("identity_refused");
  return Object.freeze({ pid, procStart: match[2] });
}

/** A separate pair snapshot rejects zombie, exiting and unknown process states. */
export function parseDarwinLiveSnapshot(value: unknown): Readonly<{ pid: number; procStart: string }> {
  if (typeof value !== "string" || value.length > 384 || Buffer.byteLength(value) > 384) throw detachedProcessError("lifetime_refused");
  // Apple ps uses Z for zombies, E for exiting, and ? for unknown state. Only
  // ordinary running/sleeping/idle states and documented harmless flags count.
  const match = /^(.* \?\?) +[RSIU][<N]?s? *\n?$/u.exec(value);
  if (match?.[1] === undefined) throw detachedProcessError("lifetime_refused");
  try { return parseDarwinTerminalDevice(match[1]); }
  catch { throw detachedProcessError("lifetime_refused"); }
}

function sessionLibrary(): SessionLibrary {
  if (process.platform !== "darwin") throw detachedProcessError("platform_refused");
  library ??= dlopen("/usr/lib/libSystem.B.dylib", {
    getsid: { args: ["i32"], returns: "i32" },
    getpgid: { args: ["i32"], returns: "i32" },
  });
  return library;
}

type InspectorChild = Bun.Subprocess<"ignore", "pipe", "pipe">;
type InspectorCapture = { reader: ReadableStreamDefaultReader<Uint8Array>; bytes: Uint8Array; complete: boolean; eof: boolean; cancelled: boolean };
async function inspectorOutput(value: InspectorCapture): Promise<void> {
  let length = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const next = await value.reader.read();
      if (next.done) { value.eof = !value.cancelled; break; }
      length += next.value.byteLength;
      if (length > 384) throw detachedProcessError("inspector_output_refused");
      chunks.push(next.value.slice());
    }
    value.bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { value.bytes.set(chunk, offset); offset += chunk.byteLength; }
  } finally {
    if (!value.eof) { value.cancelled = true; await value.reader.cancel(); }
    value.reader.releaseLock(); value.complete = true;
  }
}

/** Collects an already-owned inspector handle. It grants no command or spawn capability. */
export async function collectOwnedDarwinInspector(child: InspectorChild, deadlineMs = 1000): Promise<Readonly<{
  cleanup: "joined" | "uncertain";
  output: string | null;
}>> {
  const validDeadline = Number.isSafeInteger(deadlineMs) && deadlineMs >= 100 && deadlineMs <= 1000;
  const stdout: InspectorCapture = { reader: child.stdout.getReader(), bytes: new Uint8Array(), complete: false, eof: false, cancelled: false };
  const stderr: InspectorCapture = { reader: child.stderr.getReader(), bytes: new Uint8Array(), complete: false, eof: false, cancelled: false };
  let exitCode: number | null = null;
  let exited = false;
  const exit = child.exited.then((code) => { exitCode = code; exited = true; });
  const output = inspectorOutput(stdout);
  const diagnostic = inspectorOutput(stderr);
  let admitted = false;
  const exitSeen = (): boolean => exited;
  try {
    const result = await Promise.race([Promise.all([exit, output, diagnostic]), Bun.sleep(validDeadline ? deadlineMs : 100).then(() => "deadline")]);
    admitted = validDeadline && result !== "deadline";
  } catch { /* The exact child and both streams must still be collected. */ }
  if (!admitted) {
    if (!exitSeen()) { try { child.kill("SIGTERM"); } catch { /* Collection below remains authoritative. */ } }
    await Promise.race([exit.catch(() => undefined), Bun.sleep(100)]);
    if (!exitSeen()) { try { child.kill("SIGKILL"); } catch { /* Missing exit remains uncertain. */ } }
    await Promise.race([Promise.allSettled([exit, output, diagnostic]), Bun.sleep(500)]);
    for (const stream of [stdout, stderr]) {
      if (!stream.complete) { stream.cancelled = true; await Promise.race([stream.reader.cancel().catch(() => undefined), Bun.sleep(100)]); }
    }
    await Promise.race([Promise.allSettled([exit, output, diagnostic]), Bun.sleep(100)]);
  }
  const joined = exitSeen() && stdout.complete && stderr.complete;
  const exitSucceeded = (): boolean => exitCode === 0;
  const successful = joined && admitted && exitSucceeded() && stdout.eof && stderr.eof && stderr.bytes.byteLength === 0;
  let text: string | null = null;
  if (successful) {
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(stdout.bytes); } catch { /* Invalid bytes never become identity evidence. */ }
  }
  return Object.freeze({ cleanup: joined ? "joined" : "uncertain", output: text });
}

/** Observation only: this module never launches a target or signals a PID. */
export async function inspectDarwinDetachedChild(
  pid: number,
  childExited: () => boolean,
): Promise<DarwinDetachmentInspection> {
  let started = 0;
  let joined = 0;
  let witness: DarwinDetachedIdentity | null = null;
  let cleanupUnknown = false;
  const inspectionCleanupKnown = (): boolean => !cleanupUnknown;
  const snapshot = async (): Promise<Readonly<{ pid: number; procStart: string }>> => {
    let child: InspectorChild;
    try {
      child = Bun.spawn(["/bin/ps", "-p", String(pid), "-o", "pid=,lstart=,tdev="], {
        env: inspectionEnvironment, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      });
    } catch { cleanupUnknown = true; throw detachedProcessError("inspector_spawn_unproven"); }
    started += 1;
    const result = await collectOwnedDarwinInspector(child);
    if (result.cleanup === "joined") joined += 1;
    else cleanupUnknown = true;
    if (result.output === null) throw detachedProcessError("inspection_refused");
    return parseDarwinTerminalDevice(result.output);
  };
  try {
    if (!Number.isSafeInteger(pid) || pid < 1 || pid > 2_147_483_647 || childExited()) throw detachedProcessError("identity_refused");
    const native = sessionLibrary().symbols;
    const sessionMatches = (): boolean => !childExited() && native.getsid(pid) === pid && native.getpgid(pid) === pid;
    if (!sessionMatches()) throw detachedProcessError("detachment_refused");
    const before = await snapshot();
    if (!sessionMatches()) throw detachedProcessError("detachment_refused");
    const after = await snapshot();
    if (!sessionMatches() || before.pid !== pid || after.pid !== pid || before.procStart !== after.procStart) throw detachedProcessError("detachment_refused");
    witness = Object.freeze({ identity: Object.freeze({ pid, pidDomain: "darwin" as const, procStart: before.procStart }), setsidChecked: true, newSession: true, controllingTty: false });
  } catch { /* No inspector rejection or child disappearance creates a witness. */ }
  return Object.freeze({ witness, cleanup: inspectionCleanupKnown() && joined === started ? "joined" : "uncertain", inspectorsStarted: started, inspectorsJoined: joined });
}
