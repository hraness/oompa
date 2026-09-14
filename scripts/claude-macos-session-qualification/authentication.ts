import { createHash, randomUUID } from "node:crypto";

import { runClaudeForegroundLogin } from "../../src/claude/auth";
import { resolvePinnedClaudeRuntime, type PinnedClaudeRuntime } from "../../src/claude/runtime";
import { parseClaudeAuthLoginHelp, parseClaudeAuthLogoutHelp } from "../claude-auth-help";
import { bindDarwinQualificationEnvironment, type ClaudeQualificationBindingInput } from "../claude-macos-auth-process/binding";
import { bindDarwinForegroundLogin } from "../claude-macos-auth-process/foreground";
import { bindDarwinDetachedAuthProcess } from "../claude-macos-auth-process/process";
import type { captureNativeClaudeMacosAdmission } from "../claude-macos-auth-qualification/admission";
import { observeNativePrivateClaudeIdentity } from "../claude-macos-auth-qualification/native-observer";
import { OwnerTerminalError, readOwnerTerminalResponse, type createQualificationTerminalSignals } from "../claude-macos-auth-qualification/owner-terminal";
import type { JournalAttempt } from "./custody";
import type { QualificationSessionCustody } from "./custody-port";
import { DarwinSessionQualificationError } from "./turn";

export type SessionAdmission = ReturnType<typeof captureNativeClaudeMacosAdmission>;
export type SessionSignals = ReturnType<typeof createQualificationTerminalSignals>;
const refuse = (): never => { throw new DarwinSessionQualificationError("recovery_required"); };

async function collect(source: AsyncIterable<Uint8Array>, maximum: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []; let total = 0;
  try {
    for await (const bytes of source) {
      if (!(bytes instanceof Uint8Array) || bytes.byteLength > maximum - total) return refuse();
      total += bytes.byteLength; chunks.push(bytes.slice()); bytes.fill(0);
    }
    const result = new Uint8Array(total); let offset = 0;
    for (const bytes of chunks) { result.set(bytes, offset); offset += bytes.byteLength; }
    return result;
  } finally { for (const bytes of chunks) bytes.fill(0); }
}

/** Internal native composition; the sole public runner constructs all of these authorities. */
export class SessionAuthentication {
  readonly binding: ClaudeQualificationBindingInput;
  readonly #custody: QualificationSessionCustody;
  readonly #admission: SessionAdmission;
  readonly #signals: SessionSignals;
  #uncertain = false;
  #loginStarted = false;
  #loginJoined = false;
  constructor(custody: QualificationSessionCustody, admission: SessionAdmission, signals: SessionSignals,
    environment: Readonly<Record<string, string | undefined>>) {
    this.#custody = custody; this.#admission = admission; this.#signals = signals;
    this.binding = Object.freeze({ executablePath: admission.source.executable.path,
      executableSha256: admission.artifactProvenance.executableSha256, configDir: custody.scope.profileRoot,
      temporaryDirectory: custody.scope.temporaryRoot, environment: Object.freeze({ ...environment }) });
  }
  get cleanup(): "joined" | "uncertain" { return this.#uncertain || (this.#loginStarted && !this.#loginJoined) ? "uncertain" : "joined"; }
  assertCurrent(): void { this.#admission.assertCurrent(); if (this.#signals.signal.aborted) refuse(); }

  async capability(attempt: JournalAttempt, operation: "version" | "login_help" | "logout_help"): Promise<Readonly<{ digest: string; runtime: PinnedClaudeRuntime | null }>> {
    let version: string | null = null; let called = false;
    const wasCalled = (): boolean => called; const reportedVersion = (): string | null => version;
    const probe = async (): Promise<string> => {
      if (called) return refuse(); called = true;
      const result = await this.#detached(attempt, operation);
      try {
        const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(result);
        if (operation === "login_help") parseClaudeAuthLoginHelp({ stdout: text, stderr: "", exitCode: 0 });
        if (operation === "logout_help") parseClaudeAuthLogoutHelp({ stdout: text, stderr: "", exitCode: 0 });
        return text;
      } finally { result.fill(0); }
    };
    let runtime: PinnedClaudeRuntime | null = null;
    if (operation === "version") {
      const environment = this.binding.environment;
      runtime = await resolvePinnedClaudeRuntime({ executablePath: this.binding.executablePath, configDir: this.binding.configDir,
        configHome: "isolated", environment, signal: this.#signals.signal, versionProbeDeadlineMs: 5000,
        probeVersion: async (actual) => {
          if (actual.executablePath !== this.binding.executablePath || actual.configDir !== this.binding.configDir
            || actual.configHome !== "isolated" || actual.signal !== this.#signals.signal || actual.deadlineMs !== 5000
            || actual.processFactory !== undefined || JSON.stringify(actual.environment) !== JSON.stringify(environment)) return refuse();
          version = await probe(); return version;
        } });
    } else version = await probe();
    const reported = reportedVersion();
    if (!wasCalled() || reported === null) return refuse();
    return Object.freeze({ digest: createHash("sha256").update(reported).digest("hex"), runtime });
  }

  async #detached(attempt: JournalAttempt, operation: "version" | "login_help" | "logout_help" | "logout"): Promise<Uint8Array> {
    await this.#custody.assertCurrent();
    const native = bindDarwinDetachedAuthProcess({ ...this.binding, deadlineMs: 5000 });
    const ticket = await this.#custody.prepareDispatch(attempt, { kind: "process" });
    this.assertCurrent(); ticket.assertCurrent();
    this.#uncertain = true;
    const child = native.start(operation);
    const abort = (): void => { try { child.terminate(); } catch { /* Native settlement remains authoritative. */ } };
    this.#signals.signal.addEventListener("abort", abort, { once: true });
    if (this.#signals.signal.aborted) abort();
    const raw: Uint8Array[] = [];
    try {
      const results = await Promise.allSettled([collect(child.stdout, 16_384), collect(child.stderr, 4096), child.exited, native.settled()]);
      for (const result of [results[0], results[1]]) if (result.status === "fulfilled") raw.push(result.value);
      const settled = results[3].status === "fulfilled" ? results[3].value : null;
      if (settled?.cleanup === "joined" && settled.childJoined && settled.inspectionComplete
        && settled.inspectorsStarted === settled.inspectorsJoined) this.#uncertain = false;
      if (results[0].status !== "fulfilled" || results[1].status !== "fulfilled" || results[2].status !== "fulfilled"
        || settled === null || !settled.admitted || settled.operation !== operation || settled.exitCode !== 0 || results[2].value !== 0
        || !settled.childJoined || !settled.stdoutEof || !settled.stderrEof || settled.cleanup !== "joined"
        || !settled.inspectionComplete || settled.inspectorsStarted !== 2 || settled.inspectorsJoined !== 2
        || settled.stderrBytes !== 0 || results[1].value.byteLength !== 0 || settled.stdoutBytes !== results[0].value.byteLength
        || settled.detachment === null) return refuse();
      await this.#custody.recordChild(attempt, settled.detachment.identity);
      await this.#custody.acknowledgeDispatch(attempt, ticket.dispatchId);
      this.assertCurrent(); return results[0].value.slice();
    } finally { this.#signals.signal.removeEventListener("abort", abort); for (const bytes of raw) bytes.fill(0); }
  }

  async status(attempt: JournalAttempt): Promise<Readonly<{ signedIn: boolean; identityTag: string | null }>> {
    const probeId = randomUUID(); let dispatchId: string | null = null;
    const observedDispatchId = (): string | null => dispatchId;
    this.#uncertain = true;
    const observed = await this.#custody.withProofKey(async (key) => {
      const copy = Uint8Array.from(key);
      try { return await observeNativePrivateClaudeIdentity({
        request: { runId: this.#custody.scope.runId, attemptId: attempt.attemptId, probeId, profile: "A", key: copy,
          configDir: this.binding.configDir, deadlineMs: 5000, signal: this.#signals.signal }, runtime: this.binding,
        authority: { revalidate: async (scope) => {
          if (scope.runId !== this.#custody.scope.runId || scope.attemptId !== attempt.attemptId || scope.probeId !== probeId
            || scope.profile !== "A" || scope.configDir !== this.binding.configDir || scope.signal !== this.#signals.signal
            || scope.deadlineMs !== 5000 || JSON.stringify(scope.runtime) !== JSON.stringify(this.binding)) return refuse();
          const bound = bindDarwinQualificationEnvironment(this.binding);
          const ticket = await this.#custody.prepareDispatch(attempt, { kind: "process" }); dispatchId = ticket.dispatchId;
          return { assertCurrent: (actual) => { if (actual !== scope) refuse(); bound.assertCurrent(); this.assertCurrent(); ticket.assertCurrent(); } };
        } },
      }); } finally { copy.fill(0); }
    });
    this.#uncertain = false;
    const dispatched = observedDispatchId(); if (dispatched === null) return refuse();
    await this.#custody.recordChild(attempt, observed.native.detachment.identity);
    await this.#custody.acknowledgeDispatch(attempt, dispatched);
    return Object.freeze({ signedIn: observed.identity.signedIn, identityTag: observed.identity.accountTag });
  }

  async login(attempt: JournalAttempt, runtime: PinnedClaudeRuntime): Promise<void> {
    const ownerScope = { runId: this.#custody.scope.runId, attemptId: attempt.attemptId, step: 1 };
    const signals = this.#signals.beginLogin(ownerScope);
    const native = bindDarwinForegroundLogin(this.binding);
    const ticket = await this.#custody.prepareDispatch(attempt, { kind: "process" });
    const result = await runClaudeForegroundLogin({ configDir: this.binding.configDir, runtime, environment: native.environment,
      stdio: native.stdio, signal: this.#signals.signal, signalCustody: signals,
      processFactory: (actual) => {
        this.assertCurrent(); ticket.assertCurrent(); this.#loginStarted = true;
        return native.processFactory(actual);
      } });
    if (result.state !== "joined") return refuse();
    const settled = await native.settled();
    if (settled?.cleanup !== "joined" || !settled.childJoined || settled.exitCode !== result.exitCode) return refuse();
    this.#loginJoined = true;
    await this.#signals.finishLogin(signals);
    if (result.exitCode !== 0 || result.interruptedBy !== null) return refuse();
    await this.#custody.acknowledgeDispatch(attempt, ticket.dispatchId);
    await this.#custody.assertCurrent();
    try { await readOwnerTerminalResponse({ input: process.stdin, output: process.stderr,
      assertCurrent: () => { this.assertCurrent(); native.assertOwnerTerminalCurrent(); } }, this.#signals.signal, ownerScope); }
    catch (error: unknown) {
      if (error instanceof OwnerTerminalError && error.cleanup === "uncertain") this.#uncertain = true;
      throw error;
    }
    await this.#custody.assertCurrent(); this.assertCurrent();
  }
  async logout(attempt: JournalAttempt): Promise<void> { const bytes = await this.#detached(attempt, "logout"); bytes.fill(0); }
}
