import { randomUUID } from "node:crypto";
import { opendir } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { z } from "zod";

import { createClaudeLoginSignalCustody, runClaudeForegroundLogin, type ClaudeForegroundLoginResult, type ClaudeLoginSignalCustody, type ClaudeLoginSignalSource } from "../../src/claude/auth";
import { CLAUDE_PIN } from "../../src/claude/pin";
import type { PinnedClaudeRuntime } from "../../src/claude/runtime";
import { bindDarwinQualificationEnvironment } from "../claude-macos-auth-process/binding";
import { bindDarwinForegroundLogin, type ForegroundQualificationSettlement } from "../claude-macos-auth-process/foreground";
import { assertPrivateDirectoryIdentity } from "../live-acceptance-private-custody";
import { captureNativeClaudeMacosAdmission } from "./admission";
import { QualificationCustody, QualificationCustodyError, type QualificationCustodySource, type QualificationDispatchScope } from "./custody";
import { containsAsciiControl } from "./identity";
import { NativeIdentityObserverError, observeNativePrivateClaudeIdentity, type NativeIdentityAuthorityScope } from "./native-observer";
import { OwnerTerminalError, readOwnerTerminalResponse, type OwnerTerminalStreams } from "./owner-terminal";
import { ClaudeMacosPreflightError, collectNativeClaudeMacosCapabilities, type ClaudeMacosCapabilities } from "./preflight";
import { encodeNativeQualificationCheckpoint, encodeQualificationCheckpoint } from "./receipt";
import { nativeQualificationBindingSchema, observeQualification, qualificationBindingSchema, QUALIFICATION_CLEANUP_ROOTS,
  type QualificationEvent, type QualificationResult, type QualificationState } from "./state";

const path = z.string().refine((value) => value.length >= 2 && value.length <= 4096 && isAbsolute(value) && resolve(value) === value && !containsAsciiControl(value));
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
const inputSchema = z.strictObject({ repositoryRoot: path, sourceCommit: z.string().regex(/^[0-9a-f]{40}$/u), executablePath: path,
  environment: z.record(z.string().min(1).max(128), z.string().max(4096).refine((value) => !value.includes("\0")).optional())
    .refine((value) => Object.keys(value).length <= 256), signal: z.instanceof(AbortSignal) });
type Input = Readonly<z.infer<typeof inputSchema>>;
type Cleanup = "not_started" | "joined" | "uncertain";
type Reason = "invalid_input" | "busy" | "admission_refused" | "custody_refused" | "fresh_roots_refused" | "authority_refused"
  | "capability_refused" | "identity_refused" | "inherited_authentication" | "persistence_uncertain" | "login_refused" | "owner_refused" | "aborted" | "first_login_joined";
export class ClaudeMacosFirstLoginError extends Error {
  constructor(readonly code: Reason, readonly cleanup?: Cleanup) { super(`CLAUDE_MACOS_FIRST_LOGIN_${code}`); this.name = "ClaudeMacosFirstLoginError"; }
}
const refused = (code: Reason): never => { throw new ClaudeMacosFirstLoginError(code); };
type Outcome = Readonly<{ firstLoginJoined: boolean; qualificationComplete: false; activationAuthorized: false; step: 0 | 1 | 2;
  status: "refused" | "recovery_required" | "first_login_joined"; reason: Reason; cleanup: Cleanup;
  ownerRelease: "not_acquired" | "released" | "uncertain"; checkpoint: "none" | "initial" | "intent" | "persisted" | "dispatched" | "settled" | "uncertain";
  recovery: Readonly<{ runId: string | null; runRoot: string; receiptPath: string | null }> | null }>;
type CustodyPort = Readonly<{ runId: string; recoveryRoot: string; receiptPath: string; state(): QualificationState;
  assertCurrent(): Promise<void>; withProofKey<T>(observe: (key: Uint8Array) => Promise<T>): Promise<T>;
  persist(bytes: Uint8Array): Promise<void>; releasePreserving(): Promise<void> }>;
type AdmissionPort = Readonly<{ source: QualificationCustodySource; assertCurrent(): void }>;
type Capabilities = ClaudeMacosCapabilities & Readonly<{ source: "native_process" | "credential_free_fixture" }>;
type Probe = Awaited<ReturnType<typeof observeNativePrivateClaudeIdentity>>;
type LoginPort = Readonly<{ run(scope: QualificationDispatchScope): Promise<ClaudeForegroundLoginResult>;
  settled(): Promise<ForegroundQualificationSettlement | null>; attest(scope: QualificationDispatchScope): Promise<void>; close(): void }>;
type Ports = Readonly<{ capture(input: Input): AdmissionPort; create(source: QualificationCustodySource): Promise<CustodyPort>;
  assertFresh(custody: CustodyPort): Promise<void>; assertEnvironment(custody: CustodyPort, input: Input, admission: AdmissionPort): Promise<void>;
  capabilities(custody: CustodyPort, input: Input): Promise<Capabilities>;
  status(custody: CustodyPort, input: Input, profile: "A" | "B", scope: QualificationDispatchScope): Promise<Omit<Probe, "source"> & Readonly<{ source: "native_process" | "credential_free_fixture" }>>;
  prepareLogin(custody: CustodyPort, input: Input, admission: AdmissionPort, runtime: PinnedClaudeRuntime): LoginPort }>;
const portsSchema = z.strictObject({ capture: z.custom<Ports["capture"]>((v) => typeof v === "function"), create: z.custom<Ports["create"]>((v) => typeof v === "function"),
  assertFresh: z.custom<Ports["assertFresh"]>((v) => typeof v === "function"), assertEnvironment: z.custom<Ports["assertEnvironment"]>((v) => typeof v === "function"),
  capabilities: z.custom<Ports["capabilities"]>((v) => typeof v === "function"), status: z.custom<Ports["status"]>((v) => typeof v === "function"),
  prepareLogin: z.custom<Ports["prepareLogin"]>((v) => typeof v === "function") });
const capabilitiesSchema = z.strictObject({ source: z.enum(["native_process", "credential_free_fixture"]), kind: z.literal("capabilities_only"),
  runId: uuid, attemptId: uuid, exactVersionBoth: z.literal(true), loginHelpBoth: z.literal(true), logoutHelpBoth: z.literal(true),
  probes: z.array(z.unknown()).length(6), runtimes: z.strictObject({ A: z.object({ executablePath: path, version: z.literal(CLAUDE_PIN) }), B: z.object({ executablePath: path, version: z.literal(CLAUDE_PIN) }) }) });
const settlementSchema = z.strictObject({ cleanup: z.literal("joined"), childJoined: z.literal(true), exitCode: z.number().int(),
  ownerTerminalVerified: z.literal(true), stdin: z.literal(0), stdout: z.literal(1), stderr: z.literal(2),
  requestedSignals: z.strictObject({ SIGINT: z.number().int().nonnegative(), SIGTERM: z.number().int().nonnegative(), SIGKILL: z.number().int().nonnegative() }) });
const joined = Object.freeze({ childJoined: true, stdoutJoined: true, stderrJoined: true } as const);
const initial = (): Outcome => ({ firstLoginJoined: false, qualificationComplete: false, activationAuthorized: false, step: 0,
  status: "refused", reason: "admission_refused", cleanup: "not_started", ownerRelease: "not_acquired", checkpoint: "none", recovery: null });

/** A finite observation after the auth runner's own force-join bound, not a ceremony timeout. */
async function collectLogin(login: LoginPort): Promise<ForegroundQualificationSettlement | null | "uncertain"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([login.settled().catch(() => "uncertain" as const), new Promise<"uncertain">((done) => { timer = setTimeout(() => { done("uncertain"); }, 1000); })]); }
  catch { return "uncertain"; }
  finally { clearTimeout(timer); }
}
const retainedUncertainLogins = new Set<LoginPort>();

/** Private one-way handoff; the same cancellation signal survives both phases. */
function firstLoginSignals(external: AbortSignal, source: ClaudeLoginSignalSource): Readonly<{
  signal: AbortSignal; beginLogin(): ClaudeLoginSignalCustody; close(): void;
}> {
  const controller = new AbortController(); let login: ClaudeLoginSignalCustody | null = null; let closed = false;
  const preflightInstalled = new Set<"SIGINT" | "SIGTERM">();
  const abort = (): void => { controller.abort(); };
  const removePreflight = (): void => {
    for (const signal of preflightInstalled) source.remove(signal, abort);
    preflightInstalled.clear();
  };
  const close = (): void => {
    if (closed) return; closed = true;
    removePreflight(); login?.close(); external.removeEventListener("abort", abort);
  };
  try {
    for (const signal of ["SIGINT", "SIGTERM"] as const) { source.add(signal, abort); preflightInstalled.add(signal); }
    external.addEventListener("abort", abort, { once: true }); if (external.aborted) abort();
  } catch { close(); return refused("authority_refused"); }
  return Object.freeze({ signal: controller.signal,
    beginLogin() {
      if (closed || login !== null || controller.signal.aborted) return refused("aborted");
      // Install the no-forward foreground policy before removing preflight's
      // abort listeners. No await or child launch separates this handoff.
      login = createClaudeLoginSignalCustody({ signal: controller.signal, signalSource: source, signalGraceMs: 1000 });
      removePreflight(); return login;
    }, close });
}

async function run(input: Input, mode: "native_process" | "credential_free_fixture", ports: Ports): Promise<Outcome> {
  let outcome = initial(); let custody: CustodyPort | null = null; let login: LoginPort | null = null;
  let phase: Reason = "admission_refused"; let loginCollected = false;
  const checkAbort = (): void => { if (input.signal.aborted) refused("aborted"); };
  const save = async (event: QualificationEvent): Promise<void> => {
    if (custody === null) return refused("custody_refused");
    const held = custody; const next = observeQualification(held.state(), event);
    if (next.step < 0 || next.step > 2) return refused("custody_refused");
    phase = "persistence_uncertain"; outcome = { ...outcome, checkpoint: "uncertain" };
    await held.withProofKey(async (key) => {
      const bytes = mode === "native_process" ? encodeNativeQualificationCheckpoint(next, key) : encodeQualificationCheckpoint(next, key);
      try { await held.persist(bytes); } finally { bytes.fill(0); }
    });
    const actual = held.state();
    if (JSON.stringify(actual) !== JSON.stringify(next)) return refused("persistence_uncertain");
    outcome = { ...outcome, step: next.step === 2 ? 2 : next.step === 1 ? 1 : 0, checkpoint: next.pending?.stage ?? "settled" };
    if (next.failure !== null) return refused(next.failure === "inherited_authentication" ? "inherited_authentication" : "custody_refused");
  };
  const dispatch = async (step: 0 | 1, admission: AdmissionPort): Promise<string> => {
    if (custody === null) return refused("custody_refused");
    const attemptId = randomUUID();
    await save({ type: "intent", step, attemptId }); checkAbort();
    await save({ type: "persisted", attemptId }); checkAbort();
    phase = "authority_refused"; await ports.assertEnvironment(custody, input, admission); await custody.assertCurrent(); admission.assertCurrent(); checkAbort();
    await save({ type: "dispatch", attemptId, bindingTag: custody.state().bindingTag,
      sourceAndExecutableRevalidated: true, privateCustodyRevalidated: true, environmentRevalidated: true }); checkAbort();
    return attemptId;
  };
  try {
    checkAbort(); const admission = ports.capture(input); phase = "custody_refused"; custody = await ports.create(admission.source);
    outcome = { ...outcome, status: "recovery_required", ownerRelease: "uncertain", checkpoint: "initial",
      recovery: { runId: custody.runId, runRoot: custody.recoveryRoot, receiptPath: custody.receiptPath } };
    const state = custody.state(); const schema = mode === "native_process" ? nativeQualificationBindingSchema : qualificationBindingSchema;
    if (!schema.safeParse(state.binding).success || state.step !== 0 || state.pending !== null || state.failure !== null || state.needsRecovery || state.events.length !== 0
      || state.binding.runId !== custody.runId || JSON.stringify({ sourceSha: state.binding.sourceSha, sourceTree: state.binding.sourceTree, executable: state.binding.executable }) !== JSON.stringify(admission.source)) refused("custody_refused");
    phase = "fresh_roots_refused"; checkAbort(); await ports.assertFresh(custody); checkAbort();
    const preflightAttempt = await dispatch(0, admission);
    phase = "capability_refused"; outcome = { ...outcome, cleanup: "uncertain" };
    const capabilities = await ports.capabilities(custody, input); outcome = { ...outcome, cleanup: "joined" };
    const cap = capabilitiesSchema.safeParse(capabilities);
    if (!cap.success || cap.data.source !== mode || cap.data.runId !== custody.runId || cap.data.attemptId !== preflightAttempt
      || cap.data.runtimes.A.executablePath !== state.binding.executable.path || cap.data.runtimes.B.executablePath !== state.binding.executable.path) refused("capability_refused");
    checkAbort(); phase = "identity_refused";
    const probes: Extract<QualificationResult, { kind: "preflight" }>["probes"] = [];
    for (const profile of ["A", "B"] as const) {
      const scope = { runId: custody.runId, attemptId: preflightAttempt, profile, probeId: randomUUID() };
      outcome = { ...outcome, cleanup: "uncertain" };
      const observed = await ports.status(custody, input, profile, scope); outcome = { ...outcome, cleanup: "joined" };
      if (observed.source !== mode || observed.identity.runId !== scope.runId || observed.identity.attemptId !== scope.attemptId
        || observed.identity.probeId !== scope.probeId || observed.identity.profile !== profile) refused("identity_refused");
      const native = observed.native.detachment;
      const detached = { setsidChecked: native.setsidChecked, newSession: native.newSession, controllingTty: native.controllingTty, stdinClosed: native.stdinClosed };
      probes.push({ identity: observed.identity, detached }); checkAbort();
    }
    // These fields describe actual creation/binding obligations, not a scan of
    // private HOME/Keychain contents or a new signature/revocation operation.
    await save({ type: "settled", attemptId: preflightAttempt, result: { kind: "preflight", ...joined, probes,
      freshEmptyRoots: true, keyPrivate: true, ownerHeld: true, exactVersionBoth: true, loginHelpBoth: true, logoutHelpBoth: true,
      signatureRevalidated: true, realHomePreserved: true, environmentAllowlisted: true } }); checkAbort();
    phase = "login_refused";
    login = ports.prepareLogin(custody, input, admission, capabilities.runtimes.A);
    const attemptId = await dispatch(1, admission);
    const scope = Object.freeze({ runId: custody.runId, attemptId, profile: "A" as const, probeId: randomUUID() });
    phase = "login_refused"; outcome = { ...outcome, cleanup: "uncertain" };
    let result: ClaudeForegroundLoginResult | null = null;
    try { result = await login.run(scope); }
    finally {
      const collected = await collectLogin(login); loginCollected = true;
      if (collected !== "uncertain" && collected !== null && settlementSchema.safeParse(collected).success) {
        outcome = { ...outcome, cleanup: "joined" };
        if (result?.state !== "joined" || result.exitCode !== collected.exitCode) refused("login_refused");
      } else if (collected === null && result?.state === "not_started") outcome = { ...outcome, cleanup: "joined" };
      else { retainedUncertainLogins.add(login); refused("login_refused"); }
    }
    checkAbort();
    if (result.state !== "joined" || result.exitCode !== 0 || result.interruptedBy !== null) refused("login_refused");
    phase = "owner_refused"; await login.attest(scope); checkAbort();
    await save({ type: "settled", attemptId, result: { kind: "login", ...joined, ownerObservation: "signed_in_A", transcriptsRetained: false } });
    outcome = { ...outcome, firstLoginJoined: true, status: "first_login_joined", reason: "first_login_joined" };
  } catch (error: unknown) {
    let cleanup = outcome.cleanup;
    if (error instanceof ClaudeMacosPreflightError || error instanceof NativeIdentityObserverError) cleanup = error.cleanup;
    if (error instanceof ClaudeMacosFirstLoginError && error.cleanup !== undefined) cleanup = error.cleanup;
    let recovery = outcome.recovery;
    if (recovery === null && error instanceof QualificationCustodyError && error.recoveryRoot !== undefined) recovery = { runId: null, runRoot: error.recoveryRoot, receiptPath: null };
    outcome = { ...outcome, firstLoginJoined: false, status: recovery === null ? "refused" : "recovery_required", cleanup, recovery,
      reason: input.signal.aborted ? "aborted" : error instanceof ClaudeMacosFirstLoginError ? error.code : phase,
      ownerRelease: custody === null && recovery !== null ? "uncertain" : outcome.ownerRelease };
  } finally {
    if (login !== null) {
      if (!loginCollected) { const collected = await collectLogin(login); if (collected !== null) { outcome = { ...outcome, cleanup: "uncertain" }; retainedUncertainLogins.add(login); } }
      try { login.close(); } catch { outcome = { ...outcome, status: "recovery_required", cleanup: "uncertain" }; retainedUncertainLogins.add(login); }
    }
    if (custody !== null) {
      try { await custody.releasePreserving(); outcome = { ...outcome, ownerRelease: "released" }; }
      catch { outcome = { ...outcome, status: "recovery_required", ownerRelease: "uncertain" }; }
    }
  }
  return Object.freeze(outcome);
}

type PromptStreams = OwnerTerminalStreams;
async function promptOwner(streams: PromptStreams, signal: AbortSignal, scope: QualificationDispatchScope): Promise<void> {
  try { await readOwnerTerminalResponse(streams, signal, { runId: scope.runId, attemptId: scope.attemptId, step: 1 }); }
  catch (error: unknown) {
    if (error instanceof OwnerTerminalError) throw new ClaudeMacosFirstLoginError(error.code === "order_refused" ? "authority_refused" : error.code, error.cleanup);
    throw error;
  }
}

let nativeActive = false;
/** Fixed fresh steps 0 and 1 only. No restore, operation selector, owner boolean, logout or cleanup. */
export async function runNativeClaudeMacosFirstLogin(input: unknown): Promise<Outcome & Readonly<{ source: "native_process" }>> {
  const parsed = inputSchema.safeParse(input); if (!parsed.success) return refused("invalid_input");
  if (nativeActive) return refused("busy"); nativeActive = true;
  const signals = firstLoginSignals(parsed.data.signal, {
    add(signal, listener) { process.on(signal, listener); }, remove(signal, listener) { process.off(signal, listener); },
  });
  try {
  const request = Object.freeze({ ...parsed.data, signal: signals.signal, environment: Object.freeze({ ...parsed.data.environment }) });
  let native: QualificationCustody | null = null; let admission: ReturnType<typeof captureNativeClaudeMacosAdmission> | null = null;
  const held = (): QualificationCustody => { if (native === null) return refused("custody_refused"); return native; };
  const captured = (): ReturnType<typeof captureNativeClaudeMacosAdmission> => { if (admission === null) return refused("admission_refused"); return admission; };
  const runtimeBinding = (profile: "A" | "B") => {
    const binding = held().state.binding;
    return { executablePath: binding.executable.path, executableSha256: binding.executableDigest,
      configDir: (profile === "A" ? binding.profileA : binding.profileB).path,
      temporaryDirectory: (profile === "A" ? binding.temporaryA : binding.temporaryB).path, environment: request.environment };
  };
  const value = await run(request, "native_process", {
    capture(actual) { admission = captureNativeClaudeMacosAdmission({ repositoryRoot: actual.repositoryRoot, sourceCommit: actual.sourceCommit, executablePath: actual.executablePath }); return admission; },
    async create(source) {
      native = await QualificationCustody.createNative(source); const custody = native;
      return { runId: custody.runId, recoveryRoot: custody.recoveryRoot, receiptPath: custody.receiptPath,
        state: () => Reflect.get(QualificationCustody.prototype, "state", custody), assertCurrent: QualificationCustody.prototype.assertCurrent.bind(custody),
        withProofKey<T>(observe: (key: Uint8Array) => Promise<T>): Promise<T> { return custody.withProofKey(observe); }, persist: QualificationCustody.prototype.persist.bind(custody),
        releasePreserving: QualificationCustody.prototype.releasePreserving.bind(custody) };
    },
    async assertFresh(custody) {
      await custody.assertCurrent(); const binding = custody.state().binding;
      for (const root of QUALIFICATION_CLEANUP_ROOTS) {
        const identity = { ...binding[root], owner: binding.ownerUid }; const invalid = () => new ClaudeMacosFirstLoginError("fresh_roots_refused");
        await assertPrivateDirectoryIdentity(identity, invalid); const directory = await opendir(identity.path, { bufferSize: 1 });
        try { if (await directory.read() !== null) throw invalid(); } finally { await directory.close(); }
        await assertPrivateDirectoryIdentity(identity, invalid);
      }
      await custody.assertCurrent();
    },
    async assertEnvironment(custody, _input, source) {
      for (const profile of ["A", "B"] as const) bindDarwinQualificationEnvironment(runtimeBinding(profile)).assertCurrent();
      await custody.assertCurrent(); source.assertCurrent();
    },
    async capabilities() { return await collectNativeClaudeMacosCapabilities({ custody: held(), environment: request.environment, signal: request.signal, authority: captured().preflightAuthority }); },
    async status(_custody, _input, profile, scope) {
      const runtime = Object.freeze(runtimeBinding(profile));
      return await held().withProofKey(async (key) => {
        const probeKey = Uint8Array.from(key);
        try { return await observeNativePrivateClaudeIdentity({ request: { ...scope, key: probeKey, configDir: runtime.configDir, deadlineMs: 5000, signal: request.signal }, runtime,
        authority: { async revalidate(actual: NativeIdentityAuthorityScope) {
          if (actual.runId !== scope.runId || actual.attemptId !== scope.attemptId || actual.profile !== profile || actual.probeId !== scope.probeId
            || actual.configDir !== runtime.configDir || actual.signal !== request.signal || actual.deadlineMs !== 5000 || JSON.stringify(actual.runtime) !== JSON.stringify(runtime)) return refused("authority_refused");
          const binding = bindDarwinQualificationEnvironment(runtime); const ticket = await held().prepareDispatchAuthority(scope);
          return { assertCurrent(now) {
            if (now !== actual || held().state.step !== 0) return refused("authority_refused");
            binding.assertCurrent(); captured().assertCurrent(); ticket.assertCurrent(scope);
          } };
        } } }); } finally { probeKey.fill(0); }
      });
    },
    prepareLogin(_custody, _input, source, runtime) {
      const loginSignals = signals.beginLogin();
        const binding = bindDarwinForegroundLogin(runtimeBinding("A")); let used = false;
        const assertScope = (scope: QualificationDispatchScope): void => {
          const state = held().state;
          if (scope.runId !== held().runId || scope.profile !== "A" || state.step !== 1 || state.pending?.stage !== "dispatched"
            || state.pending.attemptId !== scope.attemptId || state.failure !== null || state.needsRecovery || request.signal.aborted || loginSignals.interruptedBy !== null) return refused("authority_refused");
        };
        return {
          async run(scope) {
            if (used) return refused("authority_refused"); used = true;
            assertScope(scope); const ticket = await held().prepareDispatchAuthority(scope); assertScope(scope);
            return await runClaudeForegroundLogin({ configDir: held().state.binding.profileA.path, runtime, environment: binding.environment,
              signal: request.signal, signalCustody: loginSignals, forceJoinDeadlineMs: 1000, stdio: binding.stdio,
              processFactory(actual) { assertScope(scope); source.assertCurrent(); ticket.assertCurrent(scope); return binding.processFactory(actual); } });
          },
          settled: binding.settled,
          async attest(scope) {
            assertScope(scope); await held().assertCurrent(); source.assertCurrent(); assertScope(scope);
            await promptOwner({ input: process.stdin, output: process.stderr, assertCurrent() { assertScope(scope); binding.assertOwnerTerminalCurrent(); } }, request.signal, scope);
            await held().assertCurrent(); source.assertCurrent(); assertScope(scope); binding.assertOwnerTerminalCurrent();
          },
          // The outer runner keeps terminal-signal ownership through the final
          // awaited checkpoint and custody release. No provider is started here.
          close() {},
        };
    },
  });
  if (value.cleanup !== "uncertain" && value.ownerRelease !== "uncertain") nativeActive = false;
  return Object.freeze({ ...value, source: "native_process" });
  } finally { signals.close(); }
}

/** Fixture-only composition cannot provide native owner/process authority. */
export async function runCredentialFreeClaudeMacosFirstLogin(input: unknown, ports: Ports): Promise<Outcome & Readonly<{ source: "credential_free_fixture" }>> {
  const parsed = inputSchema.safeParse(input); const parsedPorts = portsSchema.safeParse(ports);
  if (!parsed.success || !parsedPorts.success) return refused("invalid_input");
  const request = Object.freeze({ ...parsed.data, environment: Object.freeze({ ...parsed.data.environment }) });
  return Object.freeze({ ...await run(request, "credential_free_fixture", parsedPorts.data), source: "credential_free_fixture" });
}

/** Exercises only the bounded synthetic input reader; never a native attestation receipt. */
export async function readCredentialFreeFirstLoginAttestation(streams: PromptStreams, signal: AbortSignal): Promise<Readonly<{ source: "credential_free_fixture" }>> {
  await promptOwner(streams, signal, { runId: randomUUID(), attemptId: randomUUID(), profile: "A", probeId: randomUUID() });
  return Object.freeze({ source: "credential_free_fixture" });
}

/** Fixed signal-policy fixture only; it owns no terminal, native child or account. */
export function createCredentialFreeFirstLoginSignals(signal: AbortSignal, source: ClaudeLoginSignalSource) {
  return Object.freeze({ ...firstLoginSignals(signal, source), source: "credential_free_fixture" as const });
}
