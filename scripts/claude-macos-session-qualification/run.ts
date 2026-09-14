import { isAbsolute, resolve } from "node:path";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";

import { z } from "zod";

import { IndeterminateClaudeEffectError } from "../../src/claude/errors";
import type { PinnedClaudeRuntime } from "../../src/claude/runtime";
import { captureNativeClaudeMacosAdmission } from "../claude-macos-auth-qualification/admission";
import type { QualificationCustodySource } from "../claude-macos-auth-qualification/custody";
import { containsAsciiControl } from "../claude-macos-auth-qualification/identity";
import { createQualificationTerminalSignals } from "../claude-macos-auth-qualification/owner-terminal";
import { SessionAuthentication, type SessionAdmission, type SessionSignals } from "./authentication";
import { DarwinSessionCustody, DarwinSessionCustodyError, JOURNAL_OPERATIONS, type DarwinSessionScope,
  type JournalAttempt, type JournalOperation, type SessionFailure, type SessionSummary } from "./custody";
import { DarwinQualificationSession } from "./session-runtime";
import { DarwinSessionQualificationError, type SessionTurnScenario } from "./turn";

const path = z.string().refine((value) => value.length >= 2 && value.length <= 4096 && isAbsolute(value)
  && resolve(value) === value && !containsAsciiControl(value));
const inputSchema = z.strictObject({ repositoryRoot: path, sourceCommit: z.string().regex(/^[0-9a-f]{40}$/u), executablePath: path,
  environment: z.record(z.string().min(1).max(128), z.string().max(4096).refine((value) => !value.includes("\0")).optional())
    .refine((value) => Object.keys(value).length <= 256), signal: z.instanceof(AbortSignal) });
type Input = z.infer<typeof inputSchema>;
type Cleanup = "not_started" | "joined" | "uncertain";
type CustodyPort = Readonly<{ scope: DarwinSessionScope; begin(operation: JournalOperation): Promise<JournalAttempt>;
  settle(attempt: JournalAttempt, summary: SessionSummary): Promise<void>; fail(reason: SessionFailure): Promise<void>;
  assertCurrent(): Promise<void>; releasePreserving(): Promise<void> }>;
type AuthPort = Pick<SessionAuthentication, "capability" | "status" | "login" | "logout" | "cleanup">;
type SessionPort = Pick<DarwinQualificationSession, "start" | "turn" | "closeSession" | "close" | "cleanup">;
type AdmissionPort = Readonly<{ source: QualificationCustodySource; assertCurrent(): void }>;
type Ports = Readonly<{ capture(input: Input): AdmissionPort; create(source: AdmissionPort): Promise<CustodyPort>;
  authentication(custody: CustodyPort, source: AdmissionPort): AuthPort;
  session(custody: CustodyPort, source: AdmissionPort, runtime: PinnedClaudeRuntime): SessionPort;
  closeSignals(): "joined" | "uncertain" }>;
export type DarwinSessionQualificationOutcome = Readonly<{
  sessionSequenceComplete: boolean; activationAuthorized: false; managedMacAdmission: false;
  daemonRestartQualified: false; ambiguousRecoveryQualified: false; privateRootsRemoved: false;
  status: "refused" | "recovery_required" | "sequence_complete_retained";
  reason: "invalid_input" | "admission_refused" | "custody_refused" | "inherited_authentication" | "identity_refused"
    | "effect_uncertain" | "operation_refused" | "persistence_uncertain" | "aborted" | "sequence_complete";
  completedOperations: number; checkpoint: "none" | "initial" | "dispatched" | "settled" | "uncertain";
  processCleanup: Cleanup; ownerRelease: "not_acquired" | "released" | "uncertain";
  recovery: Readonly<{ runId: string | null; runRoot: string; receiptPath: string | null }> | null;
}>;
const initial = (): DarwinSessionQualificationOutcome => ({ sessionSequenceComplete: false, activationAuthorized: false,
  managedMacAdmission: false, daemonRestartQualified: false, ambiguousRecoveryQualified: false, privateRootsRemoved: false,
  status: "refused", reason: "admission_refused", completedOperations: 0, checkpoint: "none", processCleanup: "not_started",
  ownerRelease: "not_acquired", recovery: null });
function refuse(): never { throw new DarwinSessionQualificationError("observation_refused"); }
const turnScenario = (operation: JournalOperation): SessionTurnScenario | null => {
  switch (operation) {
    case "stream_turn": return "stream";
    case "approve_turn": return "approve";
    case "deny_turn": return "deny";
    case "interrupt_turn": return "interrupt";
    case "resumed_turn": return "resumed";
    case "version": case "login_help": case "logout_help": case "initial_status": case "login": case "signed_in":
    case "start": case "close": case "resume": case "close_final": case "logout": case "signed_out": return null;
  }
};

async function run(input: Input, ports: Ports): Promise<DarwinSessionQualificationOutcome> {
  let outcome = initial(); let custody: CustodyPort | null = null; let auth: AuthPort | null = null; let session: SessionPort | null = null;
  let phase: DarwinSessionQualificationOutcome["reason"] = "admission_refused"; let runtime: PinnedClaudeRuntime | null = null;
  const check = (): void => { if (input.signal.aborted) throw new DarwinSessionQualificationError("aborted"); };
  try {
    check(); const source = ports.capture(input); phase = "custody_refused";
    custody = await ports.create(source);
    outcome = { ...outcome, checkpoint: "initial", recovery: { runId: custody.scope.runId, runRoot: custody.scope.runRoot, receiptPath: custody.scope.receiptPath } };
    auth = ports.authentication(custody, source);
    for (const operation of JOURNAL_OPERATIONS) {
      check(); await custody.assertCurrent(); source.assertCurrent();
      phase = "persistence_uncertain"; outcome = { ...outcome, checkpoint: "uncertain" };
      const attempt = await custody.begin(operation);
      outcome = { ...outcome, checkpoint: "dispatched", processCleanup: "uncertain" }; phase = "operation_refused";
      let summary: SessionSummary;
      if (operation === "version" || operation === "login_help" || operation === "logout_help") {
        const observed = await auth.capability(attempt, operation);
        if (operation === "version") { if (observed.runtime === null) refuse(); runtime = observed.runtime; }
        summary = { kind: "capability", digest: observed.digest };
      } else if (operation === "initial_status" || operation === "signed_in" || operation === "signed_out") {
        const observed = await auth.status(attempt);
        if (operation === "initial_status" && observed.signedIn) { phase = "inherited_authentication"; refuse(); }
        if (observed.signedIn !== (operation === "signed_in") || (observed.identityTag !== null) !== observed.signedIn) { phase = "identity_refused"; refuse(); }
        summary = { kind: "status", ...observed };
      } else if (operation === "login") {
        if (runtime === null) refuse(); await auth.login(attempt, runtime); summary = { kind: "login", childJoined: true };
      } else if (operation === "start" || operation === "resume") {
        if (runtime === null) refuse(); session ??= ports.session(custody, source, runtime);
        summary = await session.start(attempt, operation === "resume");
      } else if (operation === "close" || operation === "close_final") {
        if (session === null) refuse(); summary = await session.closeSession(attempt, operation === "close_final");
      } else if (operation === "logout") {
        if (session?.cleanup !== "joined") refuse(); await auth.logout(attempt); summary = { kind: "logout", childJoined: true };
      } else {
        const scenario = turnScenario(operation); if (session === null || scenario === null) refuse(); summary = await session.turn(attempt, scenario);
      }
      check(); phase = "persistence_uncertain"; outcome = { ...outcome, checkpoint: "uncertain" };
      await custody.settle(attempt, summary);
      outcome = { ...outcome, checkpoint: "settled", completedOperations: outcome.completedOperations + 1 };
    }
    if (auth.cleanup !== "joined" || session?.cleanup !== "joined") refuse();
    outcome = { ...outcome, status: "sequence_complete_retained", reason: "sequence_complete", sessionSequenceComplete: true, processCleanup: "joined" };
  } catch (error: unknown) {
    if (error instanceof DarwinSessionCustodyError && error.recoveryRoot !== undefined && outcome.recovery === null) {
      outcome = { ...outcome, recovery: { runId: null, runRoot: error.recoveryRoot, receiptPath: null },
        ownerRelease: error.ownerRelease === "released" ? "released" : error.ownerRelease === "uncertain" ? "uncertain" : "not_acquired" };
    }
    const ambiguous = error instanceof IndeterminateClaudeEffectError;
    const reason = input.signal.aborted ? "aborted" : ambiguous ? "effect_uncertain" : phase;
    outcome = { ...outcome, status: outcome.recovery === null ? "refused" : "recovery_required", reason, sessionSequenceComplete: false };
    // An uncertain dispatched operation is terminal for this run. No restart,
    // second turn, opportunistic logout, or credential-root removal follows it.
    if (custody !== null) {
      try { await custody.fail(ambiguous ? "effect_uncertain" : reason === "persistence_uncertain" ? "persistence_uncertain" : reason === "aborted" ? "aborted" : "native_refused"); }
      catch { outcome = { ...outcome, checkpoint: "uncertain" }; }
    }
  } finally {
    if (session !== null && session.cleanup !== "joined") {
      try { await session.close(); } catch { /* Only the retained exact children are closed; missing joins remain uncertain. */ }
    }
    let signalCleanup: "joined" | "uncertain" = "uncertain";
    try { signalCleanup = ports.closeSignals(); } catch { /* A failed signal join remains distinct from child settlement. */ }
    const joined = (auth === null || auth.cleanup === "joined") && (session === null || session.cleanup === "joined") && signalCleanup === "joined";
    if (outcome.processCleanup !== "not_started") outcome = { ...outcome, processCleanup: joined ? "joined" : "uncertain" };
    if (!joined) outcome = { ...outcome, sessionSequenceComplete: false, status: "recovery_required" };
    if (custody !== null) {
      outcome = { ...outcome, ownerRelease: "uncertain" };
      try { await custody.releasePreserving(); outcome = { ...outcome, ownerRelease: "released" }; }
      catch { outcome = { ...outcome, sessionSequenceComplete: false, status: "recovery_required" }; }
    }
  }
  return Object.freeze(outcome);
}

let nativeActive = false;
/** The only native entry accepts no operation, profile, credential, runtime or process override. */
export async function runNativeDarwinSessionQualification(input: unknown): Promise<DarwinSessionQualificationOutcome & Readonly<{ source: "native_process" }>> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success || nativeActive || parsed.data.repositoryRoot !== resolve(import.meta.dir, "../..")) {
    throw new DarwinSessionQualificationError("scope_refused");
  }
  nativeActive = true;
  let signals: SessionSignals;
  try { signals = createQualificationTerminalSignals(parsed.data.signal, {
    add(signal, listener) { process.on(signal, listener); }, remove(signal, listener) { process.off(signal, listener); },
  }); } catch (error: unknown) { nativeActive = false; throw error; }
  const request = Object.freeze({ ...parsed.data, signal: signals.signal, environment: Object.freeze({ ...parsed.data.environment }) });
  let held: DarwinSessionCustody | null = null; let authentication: SessionAuthentication | null = null;
  let admission: SessionAdmission | null = null;
  const currentCustody = (): DarwinSessionCustody | null => held;
  const currentAdmission = (): SessionAdmission | null => admission;
  const currentAuthentication = (): SessionAuthentication | null => authentication;
  const outcome = await run(request, {
    capture: (actual) => {
      // The reviewed auth binder requires profiles beneath the owner's real
      // temporary root. The short socket namespace is fixed, so refuse before
      // creating custody unless the outer caller explicitly selected it.
      if (realpathSync(tmpdir()) !== "/private/tmp") return refuse();
      admission = captureNativeClaudeMacosAdmission({ repositoryRoot: actual.repositoryRoot,
      sourceCommit: actual.sourceCommit, executablePath: actual.executablePath }); return admission; },
    create: async (source) => { held = await DarwinSessionCustody.createNative(source.source); return held; },
    authentication: (custody, source) => {
      const owner = currentCustody(); const admitted = currentAdmission();
      if (owner === null || admitted === null || custody !== owner || source !== admitted) return refuse();
      authentication = new SessionAuthentication(owner, admitted, signals, request.environment); return authentication;
    },
    session: (custody, source, runtime) => {
      const owner = currentCustody(); const admitted = currentAdmission(); const auth = currentAuthentication();
      if (owner === null || admitted === null || auth === null || custody !== owner || source !== admitted) return refuse();
      return new DarwinQualificationSession(owner, admitted, auth.binding, runtime, request.signal);
    }, closeSignals: () => signals.close(),
  });
  if (outcome.status !== "recovery_required" && outcome.processCleanup !== "uncertain" && outcome.ownerRelease !== "uncertain") nativeActive = false;
  return Object.freeze({ ...outcome, source: "native_process" });
}

/** Synthetic orchestration only; fixture callbacks can never select native provenance. */
export async function runCredentialFreeDarwinSessionQualification(input: unknown, ports: Ports): Promise<DarwinSessionQualificationOutcome & Readonly<{ source: "credential_free_fixture" }>> {
  const parsed = inputSchema.safeParse(input);
  const functions: readonly (keyof Ports)[] = ["capture", "create", "authentication", "session", "closeSignals"];
  const foreign: unknown = ports;
  if (!parsed.success || typeof foreign !== "object" || foreign === null || Object.keys(foreign).length !== functions.length
    || functions.some((key) => typeof Reflect.get(foreign, key) !== "function")) throw new DarwinSessionQualificationError("scope_refused");
  const outcome = await run(Object.freeze({ ...parsed.data, environment: Object.freeze({ ...parsed.data.environment }) }), ports);
  return Object.freeze({ ...outcome, source: "credential_free_fixture" });
}
