import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { z } from "zod";
import { DaemonLock, readDaemonAuthorityReceipt } from "../../src/daemon/daemon-lock";
import { daemonStatusIdentity, identityFromReceipt, sameDaemonIdentity, waitForDaemonReady, type DaemonIdentity } from "../../src/daemon/daemon-startup";
import { callLocalDaemon } from "../../src/daemon/local-transport";
import type { LocalCommand } from "../../src/domain/contracts";
import { resolveStatePaths, type StatePaths } from "../../src/storage/paths";
import { daemonQualificationChildResultSchema, daemonQualificationPaths, type DaemonQualificationDescriptor } from "./contract";
import type { DaemonQualificationCustody } from "./custody";

const invalid = (): Error => new Error("DARWIN_DAEMON_CHILD_COLLECTION_UNPROVEN");
const writesSchema = z.strictObject({ userWriteAttempts: z.number().int().min(0).max(3),
  acceptedUserWrites: z.number().int().min(0).max(2), acknowledgmentWithheld: z.boolean() });
async function bounded<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(invalid()), milliseconds); })]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}
function collect(stream: Readable, maximum: number, retain: boolean, overflow: () => void) {
  return new Promise<Readonly<{ eof: boolean; failed: boolean; bytes: number; text: string }>>((resolvePromise) => {
    let eof = false; let failed = false; let bytes = 0; const parts: Buffer[] = [];
    stream.on("data", (value: Buffer) => { bytes += value.byteLength;
      if (bytes > maximum) { failed = true; overflow(); }
      else if (retain) parts.push(Buffer.from(value)); });
    stream.once("end", () => { eof = true; }); stream.once("error", () => { failed = true; overflow(); });
    stream.once("close", () => { const joined = Buffer.concat(parts); let text = "";
      try { if (retain) text = new TextDecoder("utf-8", { fatal: true }).decode(joined); }
      catch { failed = true; }
      finally { joined.fill(0); for (const part of parts) part.fill(0); }
      resolvePromise({ eof, failed, bytes, text }); });
  });
}

/** Synchronous withdrawal also cancels transport work queued behind filesystem
 * admission. This is cancellation ownership, never a no-effect receipt. */
export class QualificationDaemonAdmission {
  readonly #controller = new AbortController();
  assertOpen(): void { if (this.#controller.signal.aborted) throw invalid(); }
  signal(caller?: AbortSignal): AbortSignal {
    this.assertOpen(); caller?.throwIfAborted();
    return caller === undefined ? this.#controller.signal : AbortSignal.any([this.#controller.signal, caller]);
  }
  close(): void { this.#controller.abort(invalid()); }
}

/** Exact child-handle ownership. No descendant or saved-PID recovery claim. */
export class QualificationDaemonProcess {
  readonly #admission = new QualificationDaemonAdmission();
  readonly #descriptor: DaemonQualificationDescriptor;
  readonly #custody: DaemonQualificationCustody;
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #stdout;
  readonly #stderr;
  readonly #closed;
  readonly #inputClosed;
  readonly paths: StatePaths;
  #inputFailed = false;
  #spawnFailed = false;
  #inputEnding = false;
  #identity: DaemonIdentity | null = null;
  #joined = false;
  private constructor(descriptor: DaemonQualificationDescriptor, custody: DaemonQualificationCustody,
    retain: (owner: QualificationDaemonProcess) => void) {
    this.#descriptor = descriptor; this.#custody = custody;
    this.paths = resolveStatePaths({ rootDirectory: daemonQualificationPaths(descriptor.runRoot).state });
    custody.assertCurrent();
    this.#child = spawn(process.execPath, ["--no-env-file", "--no-install", "--config=/dev/null",
      join(descriptor.repositoryRoot, "scripts/claude-macos-daemon-qualification/daemon-child.ts")], {
      cwd: daemonQualificationPaths(descriptor.runRoot).project, stdio: ["pipe", "pipe", "pipe"],
      env: { HOME: descriptor.ownerHome, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C", TMPDIR: "/private/tmp" },
    });
    this.#stdout = collect(this.#child.stdout, 4096, true, () => this.closeAdmission()); this.#stderr = collect(this.#child.stderr, 4096, false, () => this.closeAdmission());
    this.#inputClosed = new Promise<void>((resolvePromise) => { this.#child.stdin.once("close", resolvePromise); });
    this.#child.stdin.on("error", () => { this.#inputFailed = true; this.closeAdmission(); });
    this.#child.once("error", () => { this.#spawnFailed = true; this.closeAdmission(); });
    this.#closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolvePromise) => {
      this.#child.once("close", (code, signal) => resolvePromise({ code, signal }));
    });
    // The registry receives this exact handle before descriptor delivery or any
    // readiness await can fail. It remains retained after an unknown outcome.
    retain(this);
  }
  static async start(descriptor: DaemonQualificationDescriptor, custody: DaemonQualificationCustody,
    signal: AbortSignal, retain: (owner: QualificationDaemonProcess) => void): Promise<QualificationDaemonProcess> {
    await custody.childIntent(descriptor); signal.throwIfAborted(); custody.assertCurrent();
    const child = new QualificationDaemonProcess(descriptor, custody, retain);
    const body = Buffer.from(`${JSON.stringify(descriptor)}\n`);
    try {
      if (body.byteLength > 16384) throw invalid();
      child.#assertOpen(); signal.throwIfAborted();
      await bounded(new Promise<void>((resolvePromise, reject) => {
        child.#child.stdin.write(body, (error) => { if (error) reject(invalid()); else resolvePromise(); });
      }), 5000);
    } finally { body.fill(0); }
    child.#assertOpen(); signal.throwIfAborted();
    child.#identity = await waitForDaemonReady({ paths: child.paths, deadlineMs: 30_000,
      queryStatus: async () => await child.#request({ kind: "daemon.status" }, 750, signal),
      observeChild: () => ({ pid: child.#child.pid ?? 0, exited: child.#child.exitCode !== null || child.#child.signalCode !== null,
        ...(child.#child.exitCode === null ? {} : { exitCode: child.#child.exitCode }) }),
    });
    if (child.#identity.pid !== child.#child.pid || child.#spawnFailed || child.#inputFailed) throw invalid();
    await child.assertCurrent(); child.#assertOpen(); signal.throwIfAborted(); return child;
  }
  get identity(): DaemonIdentity { return this.#identity ?? (() => { throw invalid(); })(); }
  get joined(): boolean { return this.#joined; }
  #assertOpen(): void {
    this.#admission.assertOpen(); this.#custody.assertCurrent();
    if (this.#inputEnding || this.#inputFailed || this.#spawnFailed
      || this.#child.exitCode !== null || this.#child.signalCode !== null) throw invalid();
  }
  async #request(command: LocalCommand, deadlineMs: number, caller?: AbortSignal) {
    this.#assertOpen();
    const signal = this.#admission.signal(caller);
    const response = await callLocalDaemon({ paths: this.paths, command, deadlineMs, signal });
    this.#assertOpen(); signal.throwIfAborted(); return response;
  }
  async assertCurrent(): Promise<void> {
    const status = await this.#request({ kind: "daemon.status" }, 1000);
    this.#assertOpen();
    if (!sameDaemonIdentity(this.identity, daemonStatusIdentity(status))) throw invalid();
  }
  async observeWrites() {
    await this.assertCurrent(); this.#assertOpen();
    const response = await this.#request({ kind: "daemon.status" }, 1000);
    if (!sameDaemonIdentity(this.identity, daemonStatusIdentity(response)) || !response.ok
      || typeof response.data !== "object" || response.data === null || !("liveAcceptancePersonalClaude" in response.data)) throw invalid();
    return writesSchema.parse(response.data.liveAcceptancePersonalClaude);
  }
  async command(command: LocalCommand, signal: AbortSignal, deadlineMs = 90_000) {
    await this.assertCurrent(); this.#assertOpen(); signal.throwIfAborted();
    return await this.#request(command, deadlineMs, signal);
  }
  closeAdmission(): void {
    this.#admission.close();
    if (this.#inputEnding) return; this.#inputEnding = true;
    // This exact pipe is the child's independent parent-lifetime signal.
    try { this.#child.stdin.end(); } catch { this.#inputFailed = true; }
  }
  async stop() {
    await this.assertCurrent(); this.#assertOpen();
    // A successful stop may exit the child before the response continuation.
    // Its exact pre-dispatch cancellation signal remains active; collection
    // below is independent of ordinary post-response admission.
    const response = await callLocalDaemon({ paths: this.paths, command: { kind: "daemon.stop", expected: this.identity },
      deadlineMs: 5000, signal: this.#admission.signal() });
    if (!response.ok) throw invalid(); this.closeAdmission();
    const [exit, stdout, stderr] = await bounded(Promise.all([this.#closed, this.#stdout, this.#stderr, this.#inputClosed]), 15_000);
    if (exit.code !== 0 || exit.signal !== null || this.#spawnFailed || this.#inputFailed
      || !stdout.eof || stdout.failed || !stderr.eof || stderr.failed) throw invalid();
    const result = daemonQualificationChildResultSchema.parse(JSON.parse(stdout.text) as unknown);
    if (result.runId !== this.#descriptor.runId || result.stage !== this.#descriptor.stage || result.outcome !== "stopped"
      || result.process.daemonGeneration !== this.identity.generation || result.process.collection !== "joined"
      || result.process.observationViolation || (this.#descriptor.stage === "C"
        && (result.process.runtimeRequestAttempts !== 0 || result.process.providerLaunchAttempts !== 0))) throw invalid();
    const receipt = await readDaemonAuthorityReceipt(this.paths);
    const identity = receipt === null ? null : identityFromReceipt(receipt);
    if (receipt?.state !== "stopped" || identity === null || !sameDaemonIdentity(identity, this.identity)
      || await DaemonLock.isAuthorityHeld(this.paths)) throw invalid();
    this.#custody.assertCurrent(); this.#joined = true; return result.process;
  }
  async collectAfterFailure(): Promise<void> {
    if (this.#joined) return;
    this.closeAdmission();
    const stopped = await bounded(this.#closed, 15_000).then(() => true, () => false);
    if (!stopped && this.#child.exitCode === null && this.#child.signalCode === null) this.#child.kill("SIGKILL");
    await bounded(Promise.all([this.#closed, this.#stdout, this.#stderr, this.#inputClosed]), 5000);
    // Even a collected daemon root cannot replace a missing provider collector
    // or an unknown mutation. This never sets ordinary joined=true.
  }
}
