import { posix } from "node:path";
import { z } from "zod";
import { CLAUDE_PIN, PINNED_CLAUDE_ARTIFACT_DIGESTS } from "../../src/claude/pin.ts";
import { containsAsciiControl, qualificationTag } from "./identity.ts";

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
const tag = z.string().regex(/^[0-9a-f]{64}$/u);
const sha = z.string().regex(/^[0-9a-f]{40}$/u);
const path = z.string().min(2).max(4_096).refine((value) => value.startsWith("/") && posix.normalize(value) === value && !containsAsciiControl(value));
const directory = z.strictObject({ path, device: z.number().int().nonnegative().safe(), inode: z.number().int().positive().safe(), mode: z.literal(0o700) });
export const qualificationBindingSchema = z.strictObject({
  version: z.literal(1), runId: uuid, sourceSha: sha, sourceTree: sha,
  pin: z.literal(CLAUDE_PIN), executableDigest: z.literal(PINNED_CLAUDE_ARTIFACT_DIGESTS.nativeExecutable),
  executable: z.strictObject({ path, device: z.number().int().nonnegative().safe(), inode: z.number().int().positive().safe() }),
  ownerUid: z.number().int().nonnegative().safe(), realHome: path, forbiddenRoots: z.array(path).min(1).max(16),
  runRoot: directory, profileA: directory, profileB: directory, temporaryA: directory, temporaryB: directory,
  proofKey: z.strictObject({ path, device: z.number().int().nonnegative().safe(), inode: z.number().int().positive().safe(), mode: z.literal(0o600) }),
});
/** Native provenance is a distinct authenticated binding, never a fixture-mode toggle. */
export const nativeQualificationBindingSchema = qualificationBindingSchema.extend({ version: z.literal(2), mode: z.literal("native_qualification"),
  // Absence preserves historical checkpoint bytes, never new manual-browser admission.
  browserMode: z.literal("owner_manual").optional() });
export function assertManualBrowserQualificationBinding(value: unknown): void {
  const parsed = nativeQualificationBindingSchema.safeParse(value);
  if (!parsed.success || parsed.data.browserMode !== "owner_manual") throw new QualificationStateError("binding_invalid");
}
export type QualificationBinding = z.infer<typeof qualificationBindingSchema> | z.infer<typeof nativeQualificationBindingSchema>;
const identity = z.strictObject({ runId: uuid, attemptId: uuid, probeId: uuid, profile: z.enum(["A", "B"]), profileTag: tag,
  signedIn: z.boolean(), accountTag: tag.nullable(), emailTag: tag.nullable(), organizationTag: tag.nullable(), evidence: z.literal("reported_identity_only") });
const detached = z.strictObject({ setsidChecked: z.literal(true), newSession: z.literal(true), controllingTty: z.literal(false), stdinClosed: z.literal(true) });
const probe = z.strictObject({ identity, detached: detached.nullable() });
const joined = { childJoined: z.literal(true), stdoutJoined: z.literal(true), stderrJoined: z.literal(true) };
export const QUALIFICATION_CLEANUP_ROOTS = ["profileA", "profileB", "temporaryA", "temporaryB"] as const;
export type QualificationCleanupRoot = typeof QUALIFICATION_CLEANUP_ROOTS[number];
const cleanupRoot = z.enum(QUALIFICATION_CLEANUP_ROOTS);
const rootDeletion = (root: "profileA" | "profileB" | "temporaryA" | "temporaryB") => z.strictObject({ root: z.literal(root), intentPersisted: z.literal(true), removalReconciled: z.literal(true) });
const rootDeletions = z.tuple([rootDeletion("profileA"), rootDeletion("profileB"), rootDeletion("temporaryA"), rootDeletion("temporaryB")]);
const result = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("preflight"), ...joined, probes: z.array(probe).length(2),
    freshEmptyRoots: z.literal(true), keyPrivate: z.literal(true), ownerHeld: z.literal(true),
    exactVersionBoth: z.literal(true), loginHelpBoth: z.literal(true), logoutHelpBoth: z.literal(true),
    signatureRevalidated: z.literal(true), realHomePreserved: z.literal(true), environmentAllowlisted: z.literal(true) }),
  z.strictObject({ kind: z.literal("login"), ...joined, ownerObservation: z.enum(["signed_in_A", "signed_in_B_distinct", "interrupted_before_browser_completion", "recovered_A"]), transcriptsRetained: z.literal(false) }),
  z.strictObject({ kind: z.literal("logout"), ...joined, nativeLogoutExitZero: z.literal(true) }),
  z.strictObject({ kind: z.literal("probe"), ...joined, probes: z.array(probe).min(1).max(2), concurrentOverlapObserved: z.boolean(), ownerObservedNoGraphicalPrompt: z.boolean() }),
  z.strictObject({ kind: z.literal("cleanup"), ...joined, profileAndTemporaryRootsRemoved: z.literal(true), protectedEvidenceRetained: z.literal(true),
    rootDeletions, custodyRevalidated: z.literal(true) }),
]);
export type QualificationResult = z.infer<typeof result>;
const validation = { bindingTag: tag, sourceAndExecutableRevalidated: z.literal(true), privateCustodyRevalidated: z.literal(true), environmentRevalidated: z.literal(true) };
export const qualificationEventSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("intent"), attemptId: uuid, step: z.number().int().min(0).max(21) }),
  z.strictObject({ type: z.literal("persisted"), attemptId: uuid }),
  z.strictObject({ type: z.literal("dispatch"), attemptId: uuid, ...validation }),
  z.strictObject({ type: z.literal("settled"), attemptId: uuid, result }),
  z.strictObject({ type: z.literal("suspend"), reason: z.enum(["owner_lost", "uncertain_effect", "persistence_uncertain"]) }),
  z.strictObject({ type: z.literal("resume"), ownerEpoch: uuid, ...validation }),
  z.strictObject({ type: z.literal("reconciled"), attemptId: uuid, result }),
  z.strictObject({ type: z.literal("cleanup_root_intent"), attemptId: uuid, root: cleanupRoot }),
  z.strictObject({ type: z.literal("cleanup_root_removed"), attemptId: uuid, root: cleanupRoot }),
]);
export type QualificationEvent = z.infer<typeof qualificationEventSchema>;
export type QualificationFailure = "invalid_input" | "binding_invalid" | "order_invalid" | "observation_invalid" | "identity_crossover" | "inherited_authentication" | "joined_authenticated" | "owner_lost" | "uncertain_effect" | "persistence_uncertain";
export class QualificationStateError extends Error {
  constructor(readonly code: QualificationFailure) { super(`CLAUDE_MACOS_QUALIFICATION_${code}`); this.name = "QualificationStateError"; }
}
const refuse = (code: QualificationFailure): never => { throw new QualificationStateError(code); };

const phases = ["preflight", "first_login", "second_login_detached", "logout_A_interrupt", "recover_A_logout_B", "cleanup"] as const;
export const QUALIFICATION_STEPS = [
  { name: "preflight_A_B_out", phase: 0, kind: "preflight", expectation: "out_out" },
  { name: "login_A", phase: 1, kind: "login", owner: "signed_in_A" },
  { name: "A_identity", phase: 1, kind: "probe", expectation: "new_A" },
  { name: "B_unchanged_out", phase: 1, kind: "probe", expectation: "out_B" },
  { name: "login_B", phase: 2, kind: "login", owner: "signed_in_B_distinct" },
  { name: "B_distinct_identity", phase: 2, kind: "probe", expectation: "new_B" },
  { name: "detached_A", phase: 2, kind: "probe", expectation: "same_A" },
  { name: "detached_B", phase: 2, kind: "probe", expectation: "same_B" },
  { name: "detached_A_again", phase: 2, kind: "probe", expectation: "same_A" },
  { name: "concurrent_A_B", phase: 2, kind: "probe", expectation: "same_both" },
  { name: "verify_A_B_before_logout", phase: 3, kind: "probe", expectation: "same_both" },
  { name: "logout_A", phase: 3, kind: "logout" },
  { name: "A_out_B_unchanged", phase: 3, kind: "probe", expectation: "out_A_same_B" },
  { name: "interrupt_login_A", phase: 3, kind: "login", owner: "interrupted_before_browser_completion" },
  { name: "reconcile_interrupted_A_B", phase: 3, kind: "probe", expectation: "interrupted_A_same_B" },
  { name: "recover_login_A", phase: 4, kind: "login", owner: "recovered_A" },
  { name: "A_recovered_identity", phase: 4, kind: "probe", expectation: "same_A" },
  { name: "logout_B", phase: 4, kind: "logout" },
  { name: "A_unchanged_B_out", phase: 4, kind: "probe", expectation: "same_A_out_B" },
  { name: "cleanup_logout_A", phase: 5, kind: "logout" },
  { name: "both_out_before_cleanup", phase: 5, kind: "probe", expectation: "out_out" },
  { name: "remove_owned_roots", phase: 5, kind: "cleanup" },
] as const;
type Identity = z.infer<typeof identity>;
type Baseline = Readonly<Pick<Identity, "accountTag" | "emailTag" | "organizationTag">>;
export type QualificationState = Readonly<{
  binding: QualificationBinding; bindingTag: string; profileTags: Readonly<{ A: string; B: string }>;
  initialOwnerEpoch: string; ownerEpoch: string; ownerEpochs: readonly string[];
  step: number; pending: Readonly<{ attemptId: string; stage: "intent" | "persisted" | "dispatched" }> | null;
  baselineA: Baseline | null; baselineB: Baseline | null;
  attempts: readonly string[]; probes: readonly string[]; events: readonly QualificationEvent[];
  failure: QualificationFailure | null; needsRecovery: boolean; recoveryValidated: boolean;
  interruptionOutcome: "preauthentication_interrupted" | "joined_authenticated" | null;
  cleanupRoots: readonly Readonly<{ root: QualificationCleanupRoot; stage: "intent" | "removed" }>[];
}>;
const overlaps = (a: string, b: string): boolean => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
export function createQualification(bindingInput: unknown, key: Uint8Array, ownerEpoch: string): QualificationState {
  const parsed = qualificationBindingSchema.safeParse(bindingInput);
  if (!parsed.success || !uuid.safeParse(ownerEpoch).success) return refuse("binding_invalid");
  return createBoundQualification(parsed.data, key, ownerEpoch);
}
/** Selects native evidence provenance only; it proves no source, process or authentication fact. */
export function createNativeQualification(bindingInput: unknown, key: Uint8Array, ownerEpoch: string): QualificationState {
  const parsed = nativeQualificationBindingSchema.safeParse(bindingInput);
  if (!parsed.success || !uuid.safeParse(ownerEpoch).success) return refuse("binding_invalid");
  return createBoundQualification(parsed.data, key, ownerEpoch);
}
function createBoundQualification(binding: QualificationBinding, key: Uint8Array, ownerEpoch: string): QualificationState {
  const owned = [binding.profileA, binding.profileB, binding.temporaryA, binding.temporaryB, binding.proofKey];
  if (binding.forbiddenRoots.some((root) => overlaps(root, binding.runRoot.path)) || overlaps(binding.realHome, binding.runRoot.path)
    || owned.some((entry) => !entry.path.startsWith(`${binding.runRoot.path}/`) || (entry.device === binding.runRoot.device && entry.inode === binding.runRoot.inode))
    || owned.some((entry, index) => owned.some((other, otherIndex) => index !== otherIndex && (overlaps(entry.path, other.path) || (entry.device === other.device && entry.inode === other.inode))))) return refuse("binding_invalid");
  return { binding, bindingTag: qualificationTag(key, binding.runId, "binding", JSON.stringify(binding)),
    profileTags: { A: qualificationTag(key, binding.runId, "profile", binding.profileA.path), B: qualificationTag(key, binding.runId, "profile", binding.profileB.path) },
    initialOwnerEpoch: ownerEpoch, ownerEpoch, ownerEpochs: [ownerEpoch], step: 0, pending: null,
    baselineA: null, baselineB: null, attempts: [], probes: [], events: [], failure: null, needsRecovery: false, recoveryValidated: false, interruptionOutcome: null, cleanupRoots: [] };
}
const sameIdentity = (a: Baseline | null, b: Baseline): boolean => a !== null && a.accountTag === b.accountTag && a.emailTag === b.emailTag && a.organizationTag === b.organizationTag;
function acceptResult(state: QualificationState, observation: QualificationResult): QualificationState {
  const step = QUALIFICATION_STEPS[state.step];
  if (step === undefined || observation.kind !== step.kind || state.pending === null) return refuse("order_invalid");
  let next = state;
  if (observation.kind === "cleanup" && (state.cleanupRoots.length !== QUALIFICATION_CLEANUP_ROOTS.length
    || state.cleanupRoots.some((entry, index) => entry.root !== QUALIFICATION_CLEANUP_ROOTS[index] || entry.stage !== "removed"))) return refuse("order_invalid");
  if (observation.kind === "login") {
    if (!("owner" in step) || observation.ownerObservation !== step.owner) return refuse("observation_invalid");
  }
  if (observation.kind === "probe" || observation.kind === "preflight") {
    if (!("expectation" in step)) return refuse("order_invalid");
    const expected = step.expectation;
    const wantsBoth = ["out_out", "same_both", "out_A_same_B", "interrupted_A_same_B", "same_A_out_B"].includes(expected);
    const expectedProfiles = wantsBoth ? ["A", "B"] : [expected.endsWith("_B") ? "B" : "A"];
    if (observation.probes.length !== expectedProfiles.length) return refuse("observation_invalid");
    if (observation.kind === "probe" && (observation.concurrentOverlapObserved !== (state.step === 9)
      || (state.step >= 6 && !observation.ownerObservedNoGraphicalPrompt))) return refuse("observation_invalid");
    const seen = [...state.probes];
    const observed: Partial<Record<"A" | "B", Identity>> = {};
    for (const [index, item] of observation.probes.entries()) {
      const value = item.identity;
      if (value.profile !== expectedProfiles[index] || value.runId !== state.binding.runId || value.attemptId !== state.pending.attemptId
        || value.profileTag !== state.profileTags[value.profile] || seen.includes(value.probeId)
        || (state.step >= 6 && item.detached === null)
        || (value.signedIn ? value.accountTag === null || value.emailTag === null || value.organizationTag === null : value.accountTag !== null || value.emailTag !== null || value.organizationTag !== null)) return refuse("observation_invalid");
      seen.push(value.probeId);
      observed[value.profile] = value;
    }
    next = { ...next, probes: seen };
    for (const profile of expectedProfiles) {
      if (profile !== "A" && profile !== "B") return refuse("observation_invalid");
      const value = observed[profile];
      if (value === undefined) return refuse("observation_invalid");
      const out = expected === "out_out" || expected === "out_B" || (expected === "out_A_same_B" && profile === "A") || (expected === "same_A_out_B" && profile === "B");
      if (out) {
        if (value.signedIn) return refuse(state.step === 0 ? "inherited_authentication" : "identity_crossover");
      } else if (expected === "interrupted_A_same_B" && profile === "A" && !value.signedIn) {
        next = { ...next, interruptionOutcome: "preauthentication_interrupted" };
      } else {
        if (!value.signedIn) return refuse("identity_crossover");
        if (expected === "new_A") next = { ...next, baselineA: { accountTag: value.accountTag, emailTag: value.emailTag, organizationTag: value.organizationTag } };
        else if (expected === "new_B") {
          if (state.baselineA === null || value.accountTag === state.baselineA.accountTag || value.emailTag === state.baselineA.emailTag) return refuse("identity_crossover");
          next = { ...next, baselineB: { accountTag: value.accountTag, emailTag: value.emailTag, organizationTag: value.organizationTag } };
        } else if (!sameIdentity(profile === "A" ? state.baselineA : state.baselineB, value)) return refuse("identity_crossover");
        if (expected === "interrupted_A_same_B" && profile === "A") next = { ...next, interruptionOutcome: "joined_authenticated", failure: "joined_authenticated" };
      }
    }
  }
  return { ...next, step: state.step + 1, pending: null, needsRecovery: false, recoveryValidated: false };
}

/** Closed observations only. This reducer never launches a child or grants native authority. */
export function observeQualification(state: QualificationState, input: unknown): QualificationState {
  const parsed = qualificationEventSchema.safeParse(input);
  if (!parsed.success) return { ...state, failure: "invalid_input" };
  const event = parsed.data;
  if (state.events.length >= 160 || state.step >= QUALIFICATION_STEPS.length) return { ...state, failure: "order_invalid" };
  const recoverable = state.failure === "owner_lost" || state.failure === "uncertain_effect" || state.failure === "persistence_uncertain";
  if (state.failure !== null && !recoverable) return state;
  try {
    let next = state;
    switch (event.type) {
      case "intent":
        if (state.needsRecovery || state.failure !== null || state.pending !== null || event.step !== state.step || state.attempts.includes(event.attemptId)) return refuse("order_invalid");
        next = { ...state, pending: { attemptId: event.attemptId, stage: "intent" }, attempts: [...state.attempts, event.attemptId] };
        break;
      case "persisted":
        if (state.needsRecovery || state.failure !== null || state.pending?.stage !== "intent" || state.pending.attemptId !== event.attemptId) return refuse("order_invalid");
        next = { ...state, pending: { attemptId: event.attemptId, stage: "persisted" } };
        break;
      case "dispatch":
        if (state.needsRecovery || state.failure !== null || state.pending?.stage !== "persisted" || state.pending.attemptId !== event.attemptId || event.bindingTag !== state.bindingTag) return refuse("order_invalid");
        next = { ...state, pending: { attemptId: event.attemptId, stage: "dispatched" } };
        break;
      case "settled":
        if (state.needsRecovery || state.failure !== null || state.pending?.stage !== "dispatched" || state.pending.attemptId !== event.attemptId) return refuse("order_invalid");
        next = acceptResult(state, event.result);
        break;
      case "suspend":
        next = { ...state, failure: event.reason, needsRecovery: true, recoveryValidated: false };
        break;
      case "resume":
        if (!state.needsRecovery || event.bindingTag !== state.bindingTag || state.ownerEpochs.includes(event.ownerEpoch)) return refuse("binding_invalid");
        next = { ...state, ownerEpoch: event.ownerEpoch, ownerEpochs: [...state.ownerEpochs, event.ownerEpoch], failure: null,
          needsRecovery: state.pending !== null, recoveryValidated: state.pending !== null };
        break;
      case "reconciled":
        if (!state.needsRecovery || !state.recoveryValidated || state.failure !== null || state.pending?.attemptId !== event.attemptId) return refuse("order_invalid");
        next = acceptResult(state, event.result);
        break;
      case "cleanup_root_intent":
      case "cleanup_root_removed": {
        if (state.step !== 21 || state.failure !== null || (state.needsRecovery && !state.recoveryValidated)
          || state.pending?.stage !== "dispatched" || state.pending.attemptId !== event.attemptId) return refuse("order_invalid");
        const previous = state.cleanupRoots.at(-1);
        if (event.type === "cleanup_root_intent") {
          if ((previous !== undefined && previous.stage !== "removed") || QUALIFICATION_CLEANUP_ROOTS[state.cleanupRoots.length] !== event.root) return refuse("order_invalid");
          next = { ...state, cleanupRoots: [...state.cleanupRoots, { root: event.root, stage: "intent" }] };
        } else {
          if (previous?.root !== event.root || previous.stage !== "intent") return refuse("order_invalid");
          next = { ...state, cleanupRoots: [...state.cleanupRoots.slice(0, -1), { root: event.root, stage: "removed" }] };
        }
        break;
      }
    }
    return { ...next, events: [...state.events, event] };
  } catch (error) {
    if (!(error instanceof QualificationStateError)) throw error;
    return { ...state, failure: error.code, events: [...state.events, event] };
  }
}

export function publicQualificationReceipt(state: QualificationState) {
  return { schemaVersion: 1 as const, sourceSha: state.binding.sourceSha, sourceTree: state.binding.sourceTree, pin: state.binding.pin,
    phase: phases[QUALIFICATION_STEPS[Math.min(state.step, 21)]?.phase ?? 5],
    syntheticSequenceComplete: state.binding.version === 1 && state.step === QUALIFICATION_STEPS.length && state.failure === null && !state.needsRecovery,
    liveQualificationProven: false as const, activationAuthorized: false as const, automatedCredentialPrincipalProven: false as const,
    interruptionReconciled: state.interruptionOutcome === "preauthentication_interrupted", joinedAuthenticatedRace: state.interruptionOutcome === "joined_authenticated",
    pendingAttempt: state.pending !== null, recoveryRequired: state.needsRecovery || state.failure !== null,
    ownerAttestedDistinctSignIns: state.baselineB !== null, reportedIdentityConsistencyObserved: state.baselineB !== null,
    failure: state.failure };
}
