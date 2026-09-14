import { randomUUID } from "node:crypto";
import { opendir } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { z } from "zod";

import { runClaudeForegroundLogin, type ClaudeForegroundLoginResult } from "../../src/claude/auth";
import { CLAUDE_PIN } from "../../src/claude/pin";
import type { PinnedClaudeRuntime } from "../../src/claude/runtime";
import { bindDarwinQualificationEnvironment } from "../claude-macos-auth-process/binding";
import { bindDarwinForegroundLogin, bindDarwinManualBrowserForegroundLogin, type ForegroundQualificationSettlement } from "../claude-macos-auth-process/foreground";
import { assertPrivateDirectoryIdentity } from "../live-acceptance-private-custody";
import { captureNativeClaudeMacosAdmission } from "./admission";
import { QualificationCustody, QualificationCustodyError, type QualificationCustodySource, type QualificationDispatchScope } from "./custody";
import { containsAsciiControl } from "./identity";
import { ClaudeMacosLogoutError, collectNativeClaudeMacosLogout } from "./native-effects";
import { NativeIdentityObserverError, observeNativePrivateClaudeIdentity, observeNativePrivateClaudeIdentityPair,
  type NativeIdentityAuthorityScope, type NativeIdentityProbeInput } from "./native-observer";
import { OwnerTerminalError, armOwnerTerminalInterruption, armOwnerTerminalNoPromptWindow,
  createQualificationTerminalSignals, prepareOwnerManualBrowserLogin, readOwnerTerminalResponse, type OwnerTerminalScope } from "./owner-terminal";
import { ClaudeMacosPreflightError, collectNativeClaudeMacosCapabilities, type ClaudeMacosCapabilities } from "./preflight";
import { encodeNativeQualificationCheckpoint, encodeQualificationCheckpoint } from "./receipt";
import { assertManualBrowserQualificationBinding, nativeQualificationBindingSchema, observeQualification, qualificationBindingSchema, QUALIFICATION_CLEANUP_ROOTS,
  type QualificationCleanupRoot, type QualificationEvent, type QualificationResult, type QualificationState } from "./state";

const path = z.string().refine((value) => value.length >= 2 && value.length <= 4096 && isAbsolute(value)
  && resolve(value) === value && !containsAsciiControl(value));
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
const inputSchema = z.strictObject({ repositoryRoot: path, sourceCommit: z.string().regex(/^[0-9a-f]{40}$/u), executablePath: path,
  environment: z.record(z.string().min(1).max(128), z.string().max(4096).refine((value) => !value.includes("\0")).optional())
    .refine((value) => Object.keys(value).length <= 256), signal: z.instanceof(AbortSignal) });
type Input = Readonly<z.infer<typeof inputSchema>>;
type Mode = "native_process" | "credential_free_fixture";
type Cleanup = "not_started" | "joined" | "uncertain";
type LoginStep = 1 | 4 | 13 | 15;
type Reason = "invalid_input" | "busy" | "admission_refused" | "custody_refused" | "fresh_roots_refused" | "authority_refused"
  | "capability_refused" | "identity_refused" | "inherited_authentication" | "joined_authenticated" | "persistence_uncertain"
  | "login_refused" | "owner_refused" | "logout_refused" | "cleanup_refused" | "aborted" | "sequence_complete";
export class ClaudeMacosQualificationRunError extends Error {
  constructor(readonly code: Reason, readonly cleanup?: Cleanup) { super(`CLAUDE_MACOS_QUALIFICATION_RUN_${code}`); this.name = "ClaudeMacosQualificationRunError"; }
}
const refuse = (code: Reason): never => { throw new ClaudeMacosQualificationRunError(code); };
export type ClaudeMacosQualificationOutcome = Readonly<{ sequenceComplete: boolean; activationAuthorized: false; step: number;
  status: "refused" | "recovery_required" | "sequence_complete"; reason: Reason; cleanup: Cleanup;
  ownerRelease: "not_acquired" | "released" | "uncertain";
  checkpoint: "none" | "initial" | "intent" | "persisted" | "dispatched" | "settled" | "uncertain";
  interruptionReconciled: boolean; ownedRootsRemoved: boolean;
  recovery: Readonly<{ runId: string | null; runRoot: string; receiptPath: string | null }> | null }>;
type CustodyPort = Readonly<{ runId: string; recoveryRoot: string; receiptPath: string; state(): QualificationState;
  assertCurrent(): Promise<void>; withProofKey<T>(observe: (key: Uint8Array) => Promise<T>): Promise<T>;
  persist(bytes: Uint8Array): Promise<void>; removeRoot(root: QualificationCleanupRoot): Promise<Readonly<{ root: QualificationCleanupRoot; removalReconciled: true }>>;
  releasePreserving(): Promise<void> }>;
type AdmissionPort = Readonly<{ source: QualificationCustodySource; assertCurrent(): void }>;
type Capabilities = ClaudeMacosCapabilities & Readonly<{ source: Mode }>;
type Probe = Omit<Awaited<ReturnType<typeof observeNativePrivateClaudeIdentity>>, "source">;
type Pair = Omit<Awaited<ReturnType<typeof observeNativePrivateClaudeIdentityPair>>, "source"> & Readonly<{ source: Mode }>;
type Logout = Omit<Awaited<ReturnType<typeof collectNativeClaudeMacosLogout>>, "source"> & Readonly<{ source: Mode }>;
type LoginPort = Readonly<{ run(): Promise<ClaudeForegroundLoginResult>; settled(): Promise<ForegroundQualificationSettlement | null>;
  finish(): Promise<void>; attest(): Promise<void> }>;
type WindowPort = Readonly<{ finish(): Promise<void>; close(): void }>;
type Ports = Readonly<{ capture(input: Input): AdmissionPort; create(source: QualificationCustodySource): Promise<CustodyPort>;
  assertFresh(custody: CustodyPort): Promise<void>; assertEnvironment(custody: CustodyPort, admission: AdmissionPort): Promise<void>;
  capabilities(): Promise<Capabilities>;
  status(profile: "A" | "B", scope: QualificationDispatchScope): Promise<Probe & Readonly<{ source: Mode }>>;
  pair(first: QualificationDispatchScope, second: QualificationDispatchScope): Promise<Pair>;
  prepareLogin(step: LoginStep, scope: QualificationDispatchScope, runtime: PinnedClaudeRuntime): Promise<LoginPort>;
  armWindow(scope: OwnerTerminalScope): Promise<WindowPort>; logout(): Promise<Logout> }>;
const functionPort = <T>() => z.custom<T>((value) => typeof value === "function");
const portsSchema = z.strictObject({ capture: functionPort<Ports["capture"]>(), create: functionPort<Ports["create"]>(),
  assertFresh: functionPort<Ports["assertFresh"]>(), assertEnvironment: functionPort<Ports["assertEnvironment"]>(),
  capabilities: functionPort<Ports["capabilities"]>(), status: functionPort<Ports["status"]>(), pair: functionPort<Ports["pair"]>(),
  prepareLogin: functionPort<Ports["prepareLogin"]>(), armWindow: functionPort<Ports["armWindow"]>(), logout: functionPort<Ports["logout"]>() });
const capabilitiesSchema = z.strictObject({ source: z.enum(["native_process", "credential_free_fixture"]), kind: z.literal("capabilities_only"),
  runId: uuid, attemptId: uuid, exactVersionBoth: z.literal(true), loginHelpBoth: z.literal(true), logoutHelpBoth: z.literal(true),
  probes: z.array(z.unknown()).length(6), runtimes: z.strictObject({ A: z.object({ executablePath: path, version: z.literal(CLAUDE_PIN) }),
    B: z.object({ executablePath: path, version: z.literal(CLAUDE_PIN) }) }) });
const settlementSchema = z.strictObject({ cleanup: z.literal("joined"), childJoined: z.literal(true), exitCode: z.number().int().safe(),
  browserMode: z.literal("owner_manual").optional(),
  ownerTerminalVerified: z.literal(true), stdin: z.literal(0), stdout: z.literal(1), stderr: z.literal(2),
  requestedSignals: z.strictObject({ SIGINT: z.number().int().nonnegative(), SIGTERM: z.number().int().nonnegative(), SIGKILL: z.number().int().nonnegative() }) });
const logoutEvidenceSchema = z.object({ source: z.enum(["native_process", "credential_free_fixture"]), kind: z.literal("logout_process_joined"),
  runId: uuid, attemptId: uuid, step: z.union([z.literal(11), z.literal(17), z.literal(19)]), profile: z.enum(["A", "B"]),
  nativeLogoutExitZero: z.literal(true), cleanup: z.literal("joined"), childJoined: z.literal(true), stdoutEof: z.literal(true), stderrEof: z.literal(true),
  inspectionComplete: z.literal(true), inspectorsStarted: z.literal(2), inspectorsJoined: z.literal(2) });
const removalEvidenceSchema = z.strictObject({ root: z.enum(QUALIFICATION_CLEANUP_ROOTS), removalReconciled: z.literal(true) });
const overlapOrder = (value: unknown): boolean => value === "A1_B_A2";
const joined = Object.freeze({ childJoined: true, stdoutJoined: true, stderrJoined: true } as const);
const initial = (): ClaudeMacosQualificationOutcome => ({ sequenceComplete: false, activationAuthorized: false, step: 0,
  status: "refused", reason: "admission_refused", cleanup: "not_started", ownerRelease: "not_acquired", checkpoint: "none",
  interruptionReconciled: false, ownedRootsRemoved: false, recovery: null });
const retainedUncertainLogins = new Set<LoginPort>();
/** Only collection after the existing interrupted auth runner; never an ordinary ceremony deadline. */
async function collectLogin(login: LoginPort): Promise<ForegroundQualificationSettlement | null | "uncertain"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([login.settled().catch(() => "uncertain" as const),
    new Promise<"uncertain">((done) => { timer = setTimeout(() => { done("uncertain"); }, 1000); })]); }
  catch { return "uncertain"; } finally { clearTimeout(timer); }
}
const loginStep = (step: number): step is LoginStep => step === 1 || step === 4 || step === 13 || step === 15;
function profiles(step: number): readonly ("A" | "B")[] {
  switch (step) {
    case 0: case 9: case 10: case 12: case 14: case 18: case 20: return ["A", "B"];
    case 3: case 5: case 7: return ["B"];
    case 2: case 6: case 8: case 16: return ["A"];
    default: return refuse("custody_refused");
  }
}

/** Private fixed sequence. Supplied ports are only reachable through the explicit fixture entry. */
async function run(input: Input, mode: Mode, ports: Ports): Promise<ClaudeMacosQualificationOutcome> {
  let outcome = initial(); let custody: CustodyPort | null = null; let phase: Reason = "admission_refused";
  const checkAbort = (): void => { if (input.signal.aborted) refuse("aborted"); };
  const held = (): CustodyPort => custody ?? refuse("custody_refused");
  const current = (step: number, attemptId?: string): QualificationState => {
    const state = held().state();
    if (state.step !== step || state.failure !== null || state.needsRecovery || (attemptId !== undefined
      && (state.pending?.stage !== "dispatched" || state.pending.attemptId !== attemptId))) refuse("custody_refused");
    return state;
  };
  const save = async (event: QualificationEvent): Promise<void> => {
    const owner = held(); const next = observeQualification(owner.state(), event);
    if (next.step < 0 || next.step > 22) refuse("custody_refused");
    phase = "persistence_uncertain"; outcome = { ...outcome, checkpoint: "uncertain" };
    await owner.withProofKey(async (key) => {
      const bytes = mode === "native_process" ? encodeNativeQualificationCheckpoint(next, key) : encodeQualificationCheckpoint(next, key);
      try { await owner.persist(bytes); } finally { bytes.fill(0); }
    });
    if (JSON.stringify(owner.state()) !== JSON.stringify(next)) refuse("persistence_uncertain");
    outcome = { ...outcome, step: next.step, checkpoint: next.pending?.stage ?? "settled",
      interruptionReconciled: next.interruptionOutcome === "preauthentication_interrupted" };
    if (next.failure !== null) refuse(next.failure === "inherited_authentication" || next.failure === "joined_authenticated" ? next.failure : "identity_refused");
  };
  const dispatch = async (step: number, admission: AdmissionPort): Promise<string> => {
    current(step); checkAbort(); const attemptId = randomUUID();
    await save({ type: "intent", step, attemptId }); checkAbort();
    await save({ type: "persisted", attemptId }); checkAbort();
    phase = "authority_refused"; await ports.assertEnvironment(held(), admission); await held().assertCurrent(); admission.assertCurrent(); checkAbort();
    await save({ type: "dispatch", attemptId, bindingTag: held().state().bindingTag,
      sourceAndExecutableRevalidated: true, privateCustodyRevalidated: true, environmentRevalidated: true }); checkAbort();
    return attemptId;
  };
  const scopeFor = (attemptId: string, profile: "A" | "B"): QualificationDispatchScope => Object.freeze({ runId: held().runId, attemptId, profile, probeId: randomUUID() });
  const project = (observed: Probe, scope: QualificationDispatchScope): Extract<QualificationResult, { kind: "probe" }>["probes"][number] => {
    if (observed.identity.runId !== scope.runId || observed.identity.attemptId !== scope.attemptId || observed.identity.probeId !== scope.probeId
      || observed.identity.profile !== scope.profile || observed.native.runId !== scope.runId || observed.native.attemptId !== scope.attemptId
      || observed.native.probeId !== scope.probeId || observed.native.profile !== scope.profile) refuse("identity_refused");
    const native = observed.native.detachment;
    return { identity: observed.identity, detached: { setsidChecked: native.setsidChecked, newSession: native.newSession,
      controllingTty: native.controllingTty, stdinClosed: native.stdinClosed } };
  };
  const observe = async (step: number, attemptId: string): Promise<Extract<QualificationResult, { kind: "probe" }>["probes"]> => {
    phase = "identity_refused"; current(step, attemptId); checkAbort();
    if (step === 9) {
      const a = scopeFor(attemptId, "A"); const b = scopeFor(attemptId, "B"); outcome = { ...outcome, cleanup: "uncertain" };
      const pair = await ports.pair(a, b); outcome = { ...outcome, cleanup: "joined" };
      if (pair.source !== mode || !pair.overlap.admitted || pair.overlap.cleanup !== "joined" || pair.overlap.reason !== "observed"
        || pair.overlap.targetsJoined !== 2 || pair.overlap.inspectorsStarted !== 3 || pair.overlap.inspectorsJoined !== 3
        || pair.overlap.witness === null || !overlapOrder(pair.overlap.witness.order)
        || JSON.stringify(pair.overlap.witness.first) !== JSON.stringify(pair.first.native.detachment.identity)
        || JSON.stringify(pair.overlap.witness.second) !== JSON.stringify(pair.second.native.detachment.identity)) refuse("identity_refused");
      checkAbort(); return [project(pair.first, a), project(pair.second, b)];
    }
    const observations: Extract<QualificationResult, { kind: "probe" }>["probes"] = [];
    for (const profile of profiles(step)) {
      const scope = scopeFor(attemptId, profile); outcome = { ...outcome, cleanup: "uncertain" };
      const observed = await ports.status(profile, scope); outcome = { ...outcome, cleanup: "joined" };
      if (observed.source !== mode) refuse("identity_refused"); observations.push(project(observed, scope)); checkAbort();
    }
    return observations;
  };
  try {
    checkAbort(); const admission = ports.capture(input); phase = "custody_refused"; custody = await ports.create(admission.source);
    outcome = { ...outcome, status: "recovery_required", ownerRelease: "uncertain", checkpoint: "initial",
      recovery: { runId: custody.runId, runRoot: custody.recoveryRoot, receiptPath: custody.receiptPath } };
    const state = custody.state(); const schema = mode === "native_process" ? nativeQualificationBindingSchema : qualificationBindingSchema;
    if (mode === "native_process") assertManualBrowserQualificationBinding(state.binding);
    if (!schema.safeParse(state.binding).success || state.step !== 0 || state.pending !== null || state.failure !== null || state.needsRecovery || state.events.length !== 0
      || state.binding.runId !== custody.runId || JSON.stringify({ sourceSha: state.binding.sourceSha, sourceTree: state.binding.sourceTree, executable: state.binding.executable }) !== JSON.stringify(admission.source)) refuse("custody_refused");
    phase = "fresh_roots_refused"; checkAbort(); await ports.assertFresh(custody); checkAbort();
    const preflightAttempt = await dispatch(0, admission);
    phase = "capability_refused"; outcome = { ...outcome, cleanup: "uncertain" };
    const capabilities = await ports.capabilities(); outcome = { ...outcome, cleanup: "joined" };
    const cap = capabilitiesSchema.safeParse(capabilities);
    if (!cap.success || cap.data.source !== mode || cap.data.runId !== custody.runId || cap.data.attemptId !== preflightAttempt
      || cap.data.runtimes.A.executablePath !== state.binding.executable.path || cap.data.runtimes.B.executablePath !== state.binding.executable.path) refuse("capability_refused");
    const preflight = await observe(0, preflightAttempt);
    await save({ type: "settled", attemptId: preflightAttempt, result: { kind: "preflight", ...joined, probes: preflight,
      freshEmptyRoots: true, keyPrivate: true, ownerHeld: true, exactVersionBoth: true, loginHelpBoth: true, logoutHelpBoth: true,
      signatureRevalidated: true, realHomePreserved: true, environmentAllowlisted: true } });
    // Keep the actual resolver objects for this owner invocation. No later resolution,
    // recovered receipt or pin string can substitute a runtime before another login.
    const runtimes = capabilities.runtimes;
    for (let step = 1; step <= 21; step += 1) {
      const attemptId = await dispatch(step, admission);
      if (loginStep(step)) {
        phase = "login_refused"; const profile = step === 4 ? "B" : "A"; const scope = scopeFor(attemptId, profile);
        const login = await ports.prepareLogin(step, scope, runtimes[profile]);
        let result: ClaudeForegroundLoginResult | null = null;
        outcome = { ...outcome, cleanup: "uncertain" };
        try { result = await login.run(); }
        finally {
          const collected = await collectLogin(login);
          if (collected !== "uncertain" && collected !== null && settlementSchema.safeParse(collected).success) {
            outcome = { ...outcome, cleanup: "joined" };
            if (mode === "native_process" && collected.browserMode !== "owner_manual") refuse("login_refused");
            if (result?.state !== "joined" || result.exitCode !== collected.exitCode) refuse("login_refused");
          } else if (collected === null && result?.state === "not_started") outcome = { ...outcome, cleanup: "joined" };
          else { retainedUncertainLogins.add(login); refuse("login_refused"); }
        }
        if (result.state !== "joined" || (step === 13 ? result.interruptedBy !== "SIGINT" : result.exitCode !== 0 || result.interruptedBy !== null)) refuse("login_refused");
        await login.finish(); checkAbort(); phase = "owner_refused"; await login.attest(); checkAbort();
        await custody.assertCurrent(); admission.assertCurrent(); current(step, attemptId); checkAbort();
        await save({ type: "settled", attemptId, result: { kind: "login", ...joined, transcriptsRetained: false,
          ownerObservation: step === 1 ? "signed_in_A" : step === 4 ? "signed_in_B_distinct" : step === 13 ? "interrupted_before_browser_completion" : "recovered_A" } });
      } else if (step === 11 || step === 17 || step === 19) {
        phase = "logout_refused"; outcome = { ...outcome, cleanup: "uncertain" };
        const logout = await ports.logout(); outcome = { ...outcome, cleanup: "joined" };
        const accepted = logoutEvidenceSchema.safeParse(logout);
        if (!accepted.success || accepted.data.source !== mode || accepted.data.runId !== custody.runId || accepted.data.attemptId !== attemptId
          || accepted.data.step !== step || accepted.data.profile !== (step === 17 ? "B" : "A")) refuse("logout_refused");
        checkAbort(); await save({ type: "settled", attemptId, result: { kind: "logout", ...joined, nativeLogoutExitZero: true } });
      } else if (step === 21) {
        phase = "cleanup_refused";
        // All preceding process/input obligations are joined and step20 proved both
        // roots signed out. Filesystem reconciliation grants no process authority.
        if (outcome.cleanup !== "joined" || !outcome.interruptionReconciled) refuse("cleanup_refused");
        // Filesystem effects now join the cleanup obligation. A partial removal
        // or uncertain final checkpoint must keep this invocation unavailable.
        outcome = { ...outcome, cleanup: "uncertain" };
        for (const root of QUALIFICATION_CLEANUP_ROOTS) {
          await save({ type: "cleanup_root_intent", attemptId, root }); checkAbort();
          phase = "cleanup_refused"; await custody.assertCurrent(); admission.assertCurrent(); current(21, attemptId); checkAbort();
          const removed = await custody.removeRoot(root);
          const accepted = removalEvidenceSchema.safeParse(removed);
          if (!accepted.success || accepted.data.root !== root) refuse("cleanup_refused");
          await save({ type: "cleanup_root_removed", attemptId, root }); checkAbort();
        }
        await custody.assertCurrent(); admission.assertCurrent(); checkAbort();
        await save({ type: "settled", attemptId, result: { kind: "cleanup", ...joined, profileAndTemporaryRootsRemoved: true,
          protectedEvidenceRetained: true, custodyRevalidated: true, rootDeletions: [
            { root: "profileA", intentPersisted: true, removalReconciled: true }, { root: "profileB", intentPersisted: true, removalReconciled: true },
            { root: "temporaryA", intentPersisted: true, removalReconciled: true }, { root: "temporaryB", intentPersisted: true, removalReconciled: true }] } });
        outcome = { ...outcome, cleanup: "joined", ownedRootsRemoved: true };
      } else {
        phase = "owner_refused";
        const window = step >= 6 ? await ports.armWindow({ runId: custody.runId, attemptId, step }) : null;
        try {
          const probes = await observe(step, attemptId);
          if (window !== null) { phase = "owner_refused"; await window.finish(); checkAbort(); }
          await custody.assertCurrent(); admission.assertCurrent(); current(step, attemptId); checkAbort();
          await save({ type: "settled", attemptId, result: { kind: "probe", ...joined, probes,
            concurrentOverlapObserved: step === 9, ownerObservedNoGraphicalPrompt: window !== null } });
        } finally { window?.close(); }
      }
    }
    current(22); checkAbort();
    outcome = { ...outcome, sequenceComplete: true, status: "sequence_complete", reason: "sequence_complete" };
  } catch (error: unknown) {
    let cleanup = outcome.cleanup;
    if (error instanceof ClaudeMacosPreflightError || error instanceof NativeIdentityObserverError || error instanceof ClaudeMacosLogoutError) cleanup = error.cleanup;
    if ((error instanceof ClaudeMacosQualificationRunError || error instanceof OwnerTerminalError) && error.cleanup !== undefined) cleanup = error.cleanup;
    let recovery = outcome.recovery;
    if (recovery === null && error instanceof QualificationCustodyError && error.recoveryRoot !== undefined) recovery = { runId: null, runRoot: error.recoveryRoot, receiptPath: null };
    outcome = { ...outcome, sequenceComplete: false, status: recovery === null ? "refused" : "recovery_required", cleanup, recovery,
      reason: input.signal.aborted ? "aborted" : error instanceof ClaudeMacosQualificationRunError ? error.code : phase,
      ownerRelease: custody === null && recovery !== null ? "uncertain" : outcome.ownerRelease };
    // Never replay, issue a recovery logout, fabricate settlement, or remove roots
    // on a failed/pending effect. The exact authenticated journal remains the fence.
  } finally {
    if (custody !== null) {
      try { await custody.releasePreserving(); outcome = { ...outcome, ownerRelease: "released" }; }
      catch { outcome = { ...outcome, sequenceComplete: false, status: "recovery_required", ownerRelease: "uncertain" }; }
    }
  }
  return Object.freeze(outcome);
}

let nativeActive = false;
/** Fixed fresh normal sequence only. No restore, hooks, step selector or activation. */
export async function runNativeClaudeMacosQualification(input: unknown): Promise<ClaudeMacosQualificationOutcome & Readonly<{ source: "native_process" }>> {
  const parsed = inputSchema.safeParse(input); if (!parsed.success) return refuse("invalid_input");
  if (nativeActive) return refuse("busy"); nativeActive = true;
  const signals = createQualificationTerminalSignals(parsed.data.signal, {
    add(signal, listener) { process.on(signal, listener); }, remove(signal, listener) { process.off(signal, listener); },
  });
  let outcome: ClaudeMacosQualificationOutcome | null = null;
  try {
    const request = Object.freeze({ ...parsed.data, signal: signals.signal, environment: Object.freeze({ ...parsed.data.environment }) });
    let native: QualificationCustody | null = null; let admission: ReturnType<typeof captureNativeClaudeMacosAdmission> | null = null;
    const held = (): QualificationCustody => native ?? refuse("custody_refused");
    const captured = (): ReturnType<typeof captureNativeClaudeMacosAdmission> => admission ?? refuse("admission_refused");
    const state = (): QualificationState => Reflect.get(QualificationCustody.prototype, "state", held());
    const assertScope = (step: number, scope: QualificationDispatchScope | OwnerTerminalScope): void => {
      const value = state();
      if (request.signal.aborted) refuse("aborted");
      if (scope.runId !== held().runId || value.step !== step || value.pending?.stage !== "dispatched" || value.pending.attemptId !== scope.attemptId
        || value.failure !== null || value.needsRecovery) refuse("authority_refused");
    };
    const runtimeBinding = (profile: "A" | "B") => {
      const binding = state().binding;
      return Object.freeze({ executablePath: binding.executable.path, executableSha256: binding.executableDigest,
        configDir: (profile === "A" ? binding.profileA : binding.profileB).path,
        temporaryDirectory: (profile === "A" ? binding.temporaryA : binding.temporaryB).path, environment: request.environment });
    };
    const identityInput = (scope: QualificationDispatchScope, key: Uint8Array<ArrayBuffer>): NativeIdentityProbeInput => {
      const step = state().step; const runtime = runtimeBinding(scope.profile);
      return { request: { ...scope, key, configDir: runtime.configDir, deadlineMs: 5000, signal: request.signal }, runtime,
        authority: { async revalidate(actual: NativeIdentityAuthorityScope) {
          assertScope(step, scope);
          if (actual.runId !== scope.runId || actual.attemptId !== scope.attemptId || actual.profile !== scope.profile || actual.probeId !== scope.probeId
            || actual.configDir !== runtime.configDir || actual.signal !== request.signal || actual.deadlineMs !== 5000 || JSON.stringify(actual.runtime) !== JSON.stringify(runtime)) refuse("authority_refused");
          const bound = bindDarwinQualificationEnvironment(runtime); const ticket = await held().prepareDispatchAuthority(scope);
          return { assertCurrent(now) { if (now !== actual) refuse("authority_refused"); assertScope(step, scope);
            bound.assertCurrent(); captured().assertCurrent(); ticket.assertCurrent(scope); } };
        } } };
    };
    const ownerStreams = (scope: OwnerTerminalScope, bound: ReturnType<typeof bindDarwinForegroundLogin>) => ({ input: process.stdin, output: process.stderr,
      assertCurrent() { assertScope(scope.step, scope); captured().assertCurrent(); bound.assertOwnerTerminalCurrent(); } });
    outcome = await run(request, "native_process", {
      capture(actual) { admission = captureNativeClaudeMacosAdmission({ repositoryRoot: actual.repositoryRoot, sourceCommit: actual.sourceCommit, executablePath: actual.executablePath }); return admission; },
      async create(source) {
        native = await QualificationCustody.createNativeManualBrowser(source); const custody = native;
        return { runId: custody.runId, recoveryRoot: custody.recoveryRoot, receiptPath: custody.receiptPath, state,
          assertCurrent: QualificationCustody.prototype.assertCurrent.bind(custody),
          withProofKey<T>(observe: (key: Uint8Array) => Promise<T>): Promise<T> { return custody.withProofKey(observe); },
          persist: QualificationCustody.prototype.persist.bind(custody), removeRoot: QualificationCustody.prototype.removeRoot.bind(custody),
          releasePreserving: QualificationCustody.prototype.releasePreserving.bind(custody) };
      },
      async assertFresh(custody) {
        await custody.assertCurrent(); const binding = custody.state().binding;
        for (const root of QUALIFICATION_CLEANUP_ROOTS) {
          const identity = { ...binding[root], owner: binding.ownerUid }; const invalid = () => new ClaudeMacosQualificationRunError("fresh_roots_refused");
          await assertPrivateDirectoryIdentity(identity, invalid); const directory = await opendir(identity.path, { bufferSize: 1 });
          try { if (await directory.read() !== null) throw invalid(); } finally { await directory.close(); }
          await assertPrivateDirectoryIdentity(identity, invalid);
        }
        await custody.assertCurrent();
      },
      async assertEnvironment(custody, source) { for (const profile of ["A", "B"] as const) bindDarwinQualificationEnvironment(runtimeBinding(profile)).assertCurrent();
        await custody.assertCurrent(); source.assertCurrent(); },
      async capabilities() { return await collectNativeClaudeMacosCapabilities({ custody: held(), environment: request.environment,
        signal: request.signal, authority: captured().preflightAuthority }); },
      async status(_profile, scope) {
        return await held().withProofKey(async (key) => {
          const copy = Uint8Array.from(key);
          try { return await observeNativePrivateClaudeIdentity(identityInput(scope, copy)); } finally { copy.fill(0); }
        });
      },
      async pair(a, b) {
        return await held().withProofKey(async (key) => {
          const first = Uint8Array.from(key); const second = Uint8Array.from(key);
          try { return await observeNativePrivateClaudeIdentityPair({ first: identityInput(a, first), second: identityInput(b, second), overlapDeadlineMs: 1000 }); }
          finally { first.fill(0); second.fill(0); }
        });
      },
      async prepareLogin(step, scope, runtime) {
        assertScope(step, scope); const profile = step === 4 ? "B" : "A";
        if (scope.profile !== profile) refuse("authority_refused");
        assertManualBrowserQualificationBinding(state().binding);
        const bound = bindDarwinManualBrowserForegroundLogin(runtimeBinding(profile)); const ownerScope = { runId: scope.runId, attemptId: scope.attemptId, step };
        const streams = ownerStreams(ownerScope, bound); await held().assertCurrent(); streams.assertCurrent();
        await prepareOwnerManualBrowserLogin(streams, request.signal, ownerScope);
        const arm = step === 13 ? await armOwnerTerminalInterruption(streams, request.signal, ownerScope) : undefined;
        await held().assertCurrent(); streams.assertCurrent();
        const loginSignals = signals.beginLogin(ownerScope, arm); let used = false;
        return {
          async run() {
            if (used) refuse("authority_refused"); used = true; assertScope(step, scope);
            const ticket = await held().prepareDispatchAuthority(scope); assertScope(step, scope);
            return await runClaudeForegroundLogin({ configDir: runtimeBinding(profile).configDir, runtime, environment: bound.environment,
              signal: request.signal, signalCustody: loginSignals, forceJoinDeadlineMs: 1000, stdio: bound.stdio,
              processFactory(actual) { assertScope(step, scope); captured().assertCurrent(); ticket.assertCurrent(scope); return bound.processFactory(actual); } });
          },
          settled: bound.settled,
          async finish() { await signals.finishLogin(loginSignals); },
          async attest() {
            await held().assertCurrent(); streams.assertCurrent();
            await readOwnerTerminalResponse(streams, request.signal, ownerScope);
            await held().assertCurrent(); streams.assertCurrent();
          },
        };
      },
      async armWindow(scope) {
        assertScope(scope.step, scope); const bound = bindDarwinForegroundLogin(runtimeBinding("A"));
        const streams = ownerStreams(scope, bound); await held().assertCurrent(); streams.assertCurrent();
        const window = await armOwnerTerminalNoPromptWindow(streams, request.signal, scope);
        return { async finish() { await held().assertCurrent(); streams.assertCurrent(); await window.finish(scope);
          await held().assertCurrent(); streams.assertCurrent(); }, close: window.close };
      },
      async logout() { return await collectNativeClaudeMacosLogout({ ...request, custody: held() }); },
    });
  } finally {
    const signalCleanup = signals.close();
    if (outcome !== null && signalCleanup === "uncertain") outcome = { ...outcome, sequenceComplete: false, status: "recovery_required", cleanup: "uncertain" };
    if (outcome !== null && outcome.cleanup !== "uncertain" && outcome.ownerRelease !== "uncertain" && signalCleanup === "joined") nativeActive = false;
  }
  return Object.freeze({ ...outcome, source: "native_process" });
}

/** Explicit synthetic composition: no native authority can be supplied through this entry. */
export async function runCredentialFreeClaudeMacosQualification(input: unknown, ports: Ports): Promise<ClaudeMacosQualificationOutcome & Readonly<{ source: "credential_free_fixture" }>> {
  const parsed = inputSchema.safeParse(input); const parsedPorts = portsSchema.safeParse(ports);
  if (!parsed.success || !parsedPorts.success) return refuse("invalid_input");
  const request = Object.freeze({ ...parsed.data, environment: Object.freeze({ ...parsed.data.environment }) });
  return Object.freeze({ ...await run(request, "credential_free_fixture", parsedPorts.data), source: "credential_free_fixture" });
}
