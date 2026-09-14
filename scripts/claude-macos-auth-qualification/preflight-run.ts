import { randomUUID } from "node:crypto";
import { opendir } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { z } from "zod";

import { bindDarwinQualificationEnvironment } from "../claude-macos-auth-process/binding";
import { assertPrivateDirectoryIdentity } from "../live-acceptance-private-custody";
import { captureNativeClaudeMacosAdmission } from "./admission";
import { QualificationCustody, QualificationCustodyError, type QualificationCustodySource } from "./custody";
import { containsAsciiControl } from "./identity";
import { ClaudeMacosPreflightError, collectNativeClaudeMacosPreflight } from "./preflight";
import { encodeNativeQualificationCheckpoint, encodeQualificationCheckpoint } from "./receipt";
import { nativeQualificationBindingSchema, observeQualification, qualificationBindingSchema, QUALIFICATION_CLEANUP_ROOTS,
  type QualificationEvent, type QualificationState } from "./state";

type Cleanup = "not_started" | "joined" | "uncertain";
type Reason = "invalid_input" | "admission_refused" | "custody_refused" | "fresh_roots_refused" | "aborted" | "persistence_uncertain"
  | "authority_refused" | "preflight_refused" | "login_help_unverified";
type Diagnostic = Omit<Awaited<ReturnType<typeof collectNativeClaudeMacosPreflight>>, "source"> & Readonly<{ source: "native_process" | "credential_free_fixture" }>;
type Recovery = Readonly<{ runId: string | null; runRoot: string; receiptPath: string | null }>;
type Outcome = Readonly<{ admitted: false; step: 0; status: "blocked" | "recovery_required" | "refused"; reason: Reason;
  cleanup: Cleanup; ownerRelease: "not_acquired" | "released" | "uncertain"; recovery: Recovery | null;
  diagnostic: Diagnostic | null; freshRootsObserved: boolean; checkpoint: "none" | "initial" | "intent" | "persisted" | "dispatched" | "uncertain" }>;
export class ClaudeMacosPreflightRunError extends Error {
  constructor(readonly code: Reason) { super(`CLAUDE_MACOS_PREFLIGHT_RUN_${code}`); this.name = "ClaudeMacosPreflightRunError"; }
}
const path = z.string().refine((value) => value.length >= 2 && value.length <= 4096 && isAbsolute(value) && resolve(value) === value && !containsAsciiControl(value));
const inputSchema = z.strictObject({ repositoryRoot: path, sourceCommit: z.string().refine((value) => value.length === 40 && /^[0-9a-f]{40}$/u.test(value)), executablePath: path,
  environment: z.record(z.string().min(1).max(128), z.string().refine((value) => value.length <= 4096 && !value.includes("\0")).optional())
    .refine((value) => Object.keys(value).length <= 256), signal: z.instanceof(AbortSignal) });
type Input = z.infer<typeof inputSchema>;
type CustodyPort = Readonly<{ runId: string; recoveryRoot: string; receiptPath: string; state(): QualificationState;
  assertCurrent(): Promise<void>; withProofKey<T>(observe: (key: Uint8Array) => Promise<T>): Promise<T>;
  persist(bytes: Uint8Array): Promise<void>; releasePreserving(): Promise<void> }>;
type AdmissionPort = Readonly<{ source: QualificationCustodySource; assertCurrent(): void }>;
type Ports = Readonly<{ capture(input: Input): AdmissionPort; create(source: QualificationCustodySource): Promise<CustodyPort>;
  assertFresh(custody: CustodyPort): Promise<void>;
  assertEnvironment(custody: CustodyPort, input: Input, admission: AdmissionPort): Promise<void>;
  collect(custody: CustodyPort, input: Input, admission: AdmissionPort): Promise<Diagnostic> }>;
const portsSchema = z.strictObject({
  capture: z.custom<Ports["capture"]>((value) => typeof value === "function"),
  create: z.custom<Ports["create"]>((value) => typeof value === "function"),
  assertFresh: z.custom<Ports["assertFresh"]>((value) => typeof value === "function"),
  assertEnvironment: z.custom<Ports["assertEnvironment"]>((value) => typeof value === "function"),
  collect: z.custom<Ports["collect"]>((value) => typeof value === "function"),
});
// The fixed collector owns each probe's native parsing and joins. This closed
// envelope check binds its returned diagnostic to this run and attempt.
const diagnosticEnvelopeSchema = z.strictObject({ source: z.enum(["native_process", "credential_free_fixture"]), admitted: z.literal(false),
  reason: z.literal("login_help_unverified"), runId: z.string().max(36), attemptId: z.string().max(36),
  exactVersionBoth: z.literal(true), logoutHelpBoth: z.literal(true), loginHelpBoth: z.literal(false), probes: z.array(z.unknown()).length(6) });
const initialOutcome = (): Outcome => ({ admitted: false, step: 0, status: "refused", reason: "admission_refused", cleanup: "not_started",
  ownerRelease: "not_acquired", recovery: null, diagnostic: null, freshRootsObserved: false, checkpoint: "none" });

/** Fixed first attempt only. No restore, effect replay, settlement, login/logout or root removal. */
async function run(input: Input, mode: "native_process" | "credential_free_fixture", ports: Ports): Promise<Outcome> {
  let outcome = initialOutcome(); let custody: CustodyPort | null = null;
  let phase: Reason = "admission_refused";
  const checkAbort = (): void => { if (input.signal.aborted) throw new ClaudeMacosPreflightRunError("aborted"); };
  const save = async (event: QualificationEvent): Promise<void> => {
    if (custody === null) throw new ClaudeMacosPreflightRunError("custody_refused");
    const held = custody;
    const next = observeQualification(held.state(), event);
    if (next.failure !== null || next.step !== 0) throw new ClaudeMacosPreflightRunError("custody_refused");
    phase = "persistence_uncertain";
    outcome = { ...outcome, checkpoint: "uncertain" };
    await held.withProofKey(async (key) => {
      const bytes = mode === "native_process" ? encodeNativeQualificationCheckpoint(next, key) : encodeQualificationCheckpoint(next, key);
      try { await held.persist(bytes); } finally { bytes.fill(0); }
    });
    const stage = held.state().pending?.stage;
    if (stage !== "intent" && stage !== "persisted" && stage !== "dispatched") throw new ClaudeMacosPreflightRunError("persistence_uncertain");
    outcome = { ...outcome, checkpoint: stage };
  };
  try {
    checkAbort(); const admission = ports.capture(input);
    phase = "custody_refused"; checkAbort(); custody = await ports.create(admission.source);
    outcome = { ...outcome, status: "recovery_required", ownerRelease: "uncertain", checkpoint: "initial",
      recovery: Object.freeze({ runId: custody.runId, runRoot: custody.recoveryRoot, receiptPath: custody.receiptPath }) };
    const state = custody.state();
    const binding = mode === "native_process" ? nativeQualificationBindingSchema.safeParse(state.binding) : qualificationBindingSchema.safeParse(state.binding);
    if (!binding.success || state.step !== 0 || state.pending !== null || state.failure !== null || state.needsRecovery
      || state.events.length !== 0 || state.binding.runId !== custody.runId
      || JSON.stringify({ sourceSha: state.binding.sourceSha, sourceTree: state.binding.sourceTree, executable: state.binding.executable }) !== JSON.stringify(admission.source)) {
      throw new ClaudeMacosPreflightRunError("custody_refused");
    }
    phase = "fresh_roots_refused"; checkAbort(); await ports.assertFresh(custody); checkAbort();
    outcome = { ...outcome, freshRootsObserved: true };
    const attemptId = randomUUID();
    await save({ type: "intent", step: 0, attemptId }); checkAbort();
    await save({ type: "persisted", attemptId }); checkAbort();
    phase = "authority_refused";
    await ports.assertEnvironment(custody, input, admission); checkAbort(); await custody.assertCurrent(); admission.assertCurrent(); checkAbort();
    await save({ type: "dispatch", attemptId, bindingTag: custody.state().bindingTag,
      sourceAndExecutableRevalidated: true, privateCustodyRevalidated: true, environmentRevalidated: true });
    checkAbort(); phase = "preflight_refused";
    outcome = { ...outcome, cleanup: "uncertain" };
    const diagnostic = await ports.collect(custody, input, admission);
    // All real children are collected by the fixed preflight adapter. There is
    // intentionally no step-0 settled result while login help is unverified.
    const observed: unknown = diagnostic;
    const envelope = diagnosticEnvelopeSchema.safeParse(observed);
    if (!envelope.success || envelope.data.source !== mode || envelope.data.runId !== custody.runId || envelope.data.attemptId !== attemptId) {
      throw new ClaudeMacosPreflightRunError("preflight_refused");
    }
    outcome = { ...outcome, status: "blocked", reason: "login_help_unverified", cleanup: "joined", diagnostic };
    checkAbort();
  } catch (error: unknown) {
    let reason: Reason = error instanceof ClaudeMacosPreflightRunError ? error.code : phase;
    let cleanup = outcome.cleanup;
    if (error instanceof ClaudeMacosPreflightError) { cleanup = error.cleanup; reason = error.code === "aborted" ? "aborted" : "preflight_refused"; }
    let recovery = outcome.recovery;
    if (recovery === null && error instanceof QualificationCustodyError && error.recoveryRoot !== undefined) {
      recovery = Object.freeze({ runId: null, runRoot: error.recoveryRoot, receiptPath: null });
    }
    outcome = { ...outcome, status: recovery === null ? "refused" : "recovery_required", reason, cleanup, recovery,
      ownerRelease: custody === null && recovery !== null ? "uncertain" : outcome.ownerRelease };
  } finally {
    if (custody !== null) {
      try { await custody.releasePreserving(); outcome = { ...outcome, ownerRelease: "released" }; }
      catch { outcome = { ...outcome, status: "recovery_required", ownerRelease: "uncertain" }; }
    }
  }
  return Object.freeze(outcome);
}

function parseInput(input: unknown): Input {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) throw new ClaudeMacosPreflightRunError("invalid_input");
  return Object.freeze({ ...parsed.data, environment: Object.freeze({ ...parsed.data.environment }) });
}

/** No CLI. Creates and retains one real native run, then stops at unverified help. */
export async function runNativeClaudeMacosPreflight(input: unknown): Promise<Outcome & Readonly<{ source: "native_process" }>> {
  const parsed = parseInput(input);
  let native: QualificationCustody | null = null;
  let admission: ReturnType<typeof captureNativeClaudeMacosAdmission> | null = null;
  const value = await run(parsed, "native_process", {
    capture(request) { admission = captureNativeClaudeMacosAdmission({ repositoryRoot: request.repositoryRoot, sourceCommit: request.sourceCommit, executablePath: request.executablePath }); return admission; },
    async create(source) {
      native = await QualificationCustody.createNative(source);
      const held = native;
      return Object.freeze({ runId: held.runId, recoveryRoot: held.recoveryRoot, receiptPath: held.receiptPath,
        state: () => Reflect.get(QualificationCustody.prototype, "state", held),
        assertCurrent: QualificationCustody.prototype.assertCurrent.bind(held),
        withProofKey<T>(observe: (key: Uint8Array) => Promise<T>): Promise<T> { return held.withProofKey(observe); },
        persist: QualificationCustody.prototype.persist.bind(held), releasePreserving: QualificationCustody.prototype.releasePreserving.bind(held) });
    },
    async assertFresh(custody) {
      await custody.assertCurrent();
      const binding = custody.state().binding;
      for (const root of QUALIFICATION_CLEANUP_ROOTS) {
        const identity = { ...binding[root], owner: binding.ownerUid };
        const invalid = () => new ClaudeMacosPreflightRunError("fresh_roots_refused");
        await assertPrivateDirectoryIdentity(identity, invalid);
        const directory = await opendir(identity.path, { bufferSize: 1 });
        try { if (await directory.read() !== null) throw invalid(); } finally { await directory.close(); }
        await assertPrivateDirectoryIdentity(identity, invalid);
      }
      await custody.assertCurrent();
    },
    async assertEnvironment(custody, request, captured) {
      const binding = custody.state().binding;
      for (const profile of ["A", "B"] as const) {
        const environment = bindDarwinQualificationEnvironment({ executablePath: captured.source.executable.path, executableSha256: binding.executableDigest,
          configDir: (profile === "A" ? binding.profileA : binding.profileB).path,
          temporaryDirectory: (profile === "A" ? binding.temporaryA : binding.temporaryB).path, environment: request.environment });
        environment.assertCurrent();
      }
      await custody.assertCurrent(); captured.assertCurrent();
    },
    async collect(_custody, request) {
      if (native === null || admission === null) throw new ClaudeMacosPreflightRunError("custody_refused");
      return await collectNativeClaudeMacosPreflight({ custody: native, environment: request.environment, signal: request.signal, authority: admission.preflightAuthority });
    },
  });
  return Object.freeze({ ...value, source: "native_process" });
}

/** Explicit synthetic composition; injected ports cannot acquire a native result or native checkpoint mode. */
export async function runCredentialFreeClaudeMacosPreflight(input: unknown, ports: Ports): Promise<Outcome & Readonly<{ source: "credential_free_fixture" }>> {
  const parsed = parseInput(input);
  const parsedPorts = portsSchema.safeParse(ports);
  if (!parsedPorts.success) throw new ClaudeMacosPreflightRunError("invalid_input");
  return Object.freeze({ ...await run(parsed, "credential_free_fixture", parsedPorts.data), source: "credential_free_fixture" });
}
