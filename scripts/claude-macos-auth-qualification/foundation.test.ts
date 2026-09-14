import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { CLAUDE_PIN, PINNED_CLAUDE_ARTIFACT_DIGESTS } from "../../src/claude/pin.ts";
import { capturePrivateClaudeMetadataIdentity, projectPrivateClaudeIdentity, qualificationTag } from "./identity.ts";
import { createQualification, observeQualification, publicQualificationReceipt, QUALIFICATION_CLEANUP_ROOTS, QUALIFICATION_STEPS, type QualificationBinding, type QualificationResult, type QualificationState } from "./state.ts";
import { encodeQualificationCheckpoint, restoreQualificationCheckpoint } from "./receipt.ts";
import { driveCredentialFreeFixtureStep, LIVE_QUALIFICATION_CAPABILITY, reconcileCredentialFreeFixtureAttempt } from "./orchestration.ts";

const key = new Uint8Array(32).fill(37);
const id = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const directory = (name: string, inode: number) => ({ path: `/private/synthetic/run/${name}`, device: 1, inode, mode: 0o700 as const });
const binding: QualificationBinding = {
  version: 1, runId: id(1), sourceSha: "a".repeat(40), sourceTree: "b".repeat(40), pin: CLAUDE_PIN,
  executableDigest: PINNED_CLAUDE_ARTIFACT_DIGESTS.nativeExecutable,
  executable: { path: "/private/synthetic/claude-immutable", device: 1, inode: 100 }, ownerUid: 501,
  realHome: "/Users/synthetic", forbiddenRoots: ["/Users/synthetic", "/private/production"],
  runRoot: { path: "/private/synthetic/run", device: 1, inode: 2, mode: 0o700 },
  profileA: directory("A", 3), profileB: directory("B", 4), temporaryA: directory("tmp-A", 5), temporaryB: directory("tmp-B", 6),
  proofKey: { path: "/private/synthetic/run/proof-key", device: 1, inode: 7, mode: 0o600 },
};
const bytes = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));
function privateInput(profile: "A" | "B", signedIn: boolean, attemptId = id(2), probeId = id(3)) {
  const account = profile.toLowerCase();
  const configDir = profile === "A" ? binding.profileA.path : binding.profileB.path;
  const metadata = { accountUuid: `synthetic-${account}`, email: `${account}@example.invalid`, organizationUuid: "synthetic-org" };
  const status = { loggedIn: signedIn, authMethod: signedIn ? "claude.ai" : "none", apiProvider: "firstParty", analyticsDisabled: true,
    projectsDirectory: `${configDir}/projects`, ...(signedIn ? { email: `${account}@example.invalid`, orgId: "synthetic-org" } : {}) };
  return { key, runId: binding.runId, attemptId, probeId, profile, configDir, before: signedIn ? metadata : null, after: signedIn ? metadata : null,
    status: { stdout: bytes(status), stderrBytes: 0, exitCode: signedIn ? 0 : 1, joined: true, stdoutEof: true, stderrEof: true, deadlineMs: 4_000, elapsedMs: 25 } };
}
const joined = { childJoined: true, stdoutJoined: true, stderrJoined: true } as const;
const detached = { setsidChecked: true, newSession: true, controllingTty: false, stdinClosed: true } as const;
// Independently stated acceptance sequence: profile + expected signed-in state.
const observations: Readonly<Record<number, readonly (readonly ["A" | "B", boolean])[]>> = {
  0: [["A", false], ["B", false]], 2: [["A", true]], 3: [["B", false]], 5: [["B", true]],
  6: [["A", true]], 7: [["B", true]], 8: [["A", true]], 9: [["A", true], ["B", true]],
  10: [["A", true], ["B", true]], 12: [["A", false], ["B", true]], 14: [["A", false], ["B", true]],
  16: [["A", true]], 18: [["A", true], ["B", false]], 20: [["A", false], ["B", false]],
};
function resultFor(step: number, attemptId: string): QualificationResult {
  if (step === 1 || step === 4 || step === 13 || step === 15) return { kind: "login", ...joined, transcriptsRetained: false,
    ownerObservation: step === 1 ? "signed_in_A" : step === 4 ? "signed_in_B_distinct" : step === 13 ? "interrupted_before_browser_completion" : "recovered_A" };
  if (step === 11 || step === 17 || step === 19) return { kind: "logout", ...joined, nativeLogoutExitZero: true };
  if (step === 21) return { kind: "cleanup", ...joined, profileAndTemporaryRootsRemoved: true, protectedEvidenceRetained: true,
    rootDeletions: [
      { root: "profileA", intentPersisted: true, removalReconciled: true },
      { root: "profileB", intentPersisted: true, removalReconciled: true },
      { root: "temporaryA", intentPersisted: true, removalReconciled: true },
      { root: "temporaryB", intentPersisted: true, removalReconciled: true },
    ], custodyRevalidated: true };
  const expected = observations[step];
  if (expected === undefined) throw new Error("invalid synthetic step");
  const probes = expected.map(([profile, signedIn], index) => ({ identity: projectPrivateClaudeIdentity(privateInput(profile, signedIn, attemptId, id(1_000 + step * 2 + index))), detached: step >= 6 ? detached : null }));
  if (step === 0) return { kind: "preflight", ...joined, probes, freshEmptyRoots: true, keyPrivate: true, ownerHeld: true,
    exactVersionBoth: true, loginHelpBoth: true, logoutHelpBoth: true, signatureRevalidated: true, realHomePreserved: true, environmentAllowlisted: true };
  return { kind: "probe", ...joined, probes, concurrentOverlapObserved: step === 9, ownerObservedNoGraphicalPrompt: true };
}
const revalidation = (state: QualificationState) => ({ bindingTag: state.bindingTag, sourceAndExecutableRevalidated: true, privateCustodyRevalidated: true, environmentRevalidated: true });
function dispatch(state: QualificationState): QualificationState {
  const attemptId = id(100 + state.step);
  let next = observeQualification(state, { type: "intent", attemptId, step: state.step });
  next = observeQualification(next, { type: "persisted", attemptId });
  return observeQualification(next, { type: "dispatch", attemptId, ...revalidation(next) });
}
function advance(state: QualificationState): QualificationState {
  let next = dispatch(state);
  if (state.step === 21) next = recordCleanup(next);
  return observeQualification(next, { type: "settled", attemptId: id(100 + state.step), result: resultFor(state.step, id(100 + state.step)) });
}
function recordCleanup(state: QualificationState): QualificationState {
  let next = state;
  for (const root of QUALIFICATION_CLEANUP_ROOTS) {
    next = observeQualification(next, { type: "cleanup_root_intent", attemptId: id(121), root });
    next = observeQualification(next, { type: "cleanup_root_removed", attemptId: id(121), root });
  }
  return next;
}
function atStep(step: number): QualificationState {
  let state = createQualification(binding, key, id(10));
  for (let index = 0; index < step; index += 1) state = advance(state);
  expect(state.failure).toBeNull();
  expect(state.step).toBe(step);
  return state;
}
function changeProbeResult(step: number, transform: (result: Extract<QualificationResult, { kind: "probe" }>) => unknown): QualificationState {
  const state = dispatch(atStep(step));
  const result = resultFor(step, id(100 + step));
  if (result.kind !== "probe") throw new Error("expected probe fixture");
  return observeQualification(state, { type: "settled", attemptId: id(100 + step), result: transform(result) });
}

describe("private reported identity projector", () => {
  test("compares normalized tuples with normalized active fields and exposes only run-local tags", () => {
    const input = privateInput("A", true);
    const status = { ...input.status, stdout: bytes({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", analyticsDisabled: true, projectsDirectory: `${input.configDir}/projects`, email: " A@EXAMPLE.INVALID ", orgId: " SYNTHETIC-ORG " }) };
    const a = projectPrivateClaudeIdentity({ ...input, status });
    expect(a.signedIn).toBe(true);
    expect(a.evidence).toBe("reported_identity_only");
    expect(a).toEqual(projectPrivateClaudeIdentity(input));
    expect(JSON.stringify(a)).not.toContain("example.invalid");
    expect(JSON.stringify(a)).not.toContain("synthetic-org");
    expect(qualificationTag(key, id(99), "account", "synthetic-a")).not.toBe(a.accountTag);
    expect(qualificationTag(new Uint8Array(32).fill(38), binding.runId, "account", "synthetic-a")).not.toBe(a.accountTag);
  });
  test("rejects cached A with active B rather than accepting signed-in plus cached UUID", () => {
    const a = privateInput("A", true);
    const b = privateInput("B", true);
    expect(() => projectPrivateClaudeIdentity({ ...a, status: { ...b.status, stdout: bytes({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", analyticsDisabled: true, projectsDirectory: `${a.configDir}/projects`, email: "b@example.invalid", orgId: "synthetic-org" }) } })).toThrow("identity_mismatch");
  });
  test("refuses missing, changed, malformed and non-Claude.ai identity", () => {
    const a = privateInput("A", true);
    const missing = { accountUuid: "synthetic-a", email: null, organizationUuid: null };
    expect(() => projectPrivateClaudeIdentity({ ...a, before: missing, after: missing })).toThrow("identity_missing");
    expect(() => projectPrivateClaudeIdentity({ ...a, after: privateInput("B", true).after })).toThrow("metadata_changed");
    for (const patch of [{ authMethod: "api_key" }, { orgId: "other-org" }, { email: null }, { configDirectory: a.configDir }, { projectsDirectory: "/wrong/projects" }, { loggedIn: false }]) {
      const status = { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", analyticsDisabled: true, projectsDirectory: `${a.configDir}/projects`, email: "a@example.invalid", orgId: "synthetic-org", ...patch };
      expect(() => projectPrivateClaudeIdentity({ ...a, status: { ...a.status, stdout: bytes(status) } })).toThrow();
    }
    const invalidMetadata = { accountUuid: "synthetic-a", email: "a\u0000@example.invalid", organizationUuid: "synthetic-org" };
    expect(() => projectPrivateClaudeIdentity({ ...a, before: invalidMetadata, after: invalidMetadata })).toThrow("status_invalid");
  });
  test("requires a closed already-normalized metadata tuple without raw document parsing", () => {
    for (const invalid of [new Uint8Array(131_073), { oauthAccount: {} }, { accountUuid: "a" },
      { accountUuid: "a", email: "a@example.invalid", organizationUuid: "o", extra: true },
      { accountUuid: " A ", email: "a@example.invalid", organizationUuid: "o" },
      { accountUuid: "a", email: "A@example.invalid", organizationUuid: "o" },
      { accountUuid: "a".repeat(321), email: "a@example.invalid", organizationUuid: "o" },
      { accountUuid: "a", email: `${"a".repeat(321)}@example.invalid`, organizationUuid: "o" },
      { accountUuid: "a", email: "missing-at", organizationUuid: "o" }]) expect(() => capturePrivateClaudeMetadataIdentity(invalid)).toThrow("status_invalid");
    expect(capturePrivateClaudeMetadataIdentity(null)).toBeNull();
    expect(capturePrivateClaudeMetadataIdentity({ accountUuid: null, email: null, organizationUuid: null })).toEqual({ accountUuid: null, email: null, organizationUuid: null });
  });
  test("requires bounded bytes, exact joined streams and declared deadline", () => {
    const input = privateInput("A", true);
    for (const status of [{ joined: false }, { stdoutEof: false }, { stderrEof: false }, { deadlineMs: 2_999 }, { deadlineMs: 5_001 }, { elapsedMs: 4_000 }, { elapsedMs: -1 }, { stderrBytes: 4_097 }, { stdout: new Uint8Array(16_385) }, { stdout: new Uint8Array([0xff, 0xff]) }, { exitCode: 7 }]) {
      expect(() => projectPrivateClaudeIdentity({ ...input, status: { ...input.status, ...status } })).toThrow();
    }
    expect(() => projectPrivateClaudeIdentity({ ...input, key: new Uint8Array(31) })).toThrow();
    expect(projectPrivateClaudeIdentity(privateInput("A", false)).accountTag).toBeNull();
  });
});

describe("six-phase closed qualification", () => {
  test("completes the synthetic sequence without live or activation authority", () => {
    const state = atStep(22);
    expect(state.attempts).toHaveLength(22);
    expect(state.probes).toHaveLength(21);
    expect(state.events).toHaveLength(96);
    expect(publicQualificationReceipt(state)).toMatchObject({ phase: "cleanup", syntheticSequenceComplete: true, liveQualificationProven: false,
      activationAuthorized: false, automatedCredentialPrincipalProven: false, interruptionReconciled: true, ownerAttestedDistinctSignIns: true });
    expect(LIVE_QUALIFICATION_CAPABILITY.status).toBe("unavailable");
    const publicText = JSON.stringify(publicQualificationReceipt(state));
    for (const privateValue of [binding.runId, binding.profileA.path, state.bindingTag, state.profileTags.A, state.baselineA?.accountTag ?? "absent", "example.invalid"]) expect(publicText).not.toContain(privateValue);
    expect(QUALIFICATION_STEPS.filter((step) => step.kind === "login")).toHaveLength(4);
    expect(QUALIFICATION_STEPS.filter((step) => step.kind === "logout")).toHaveLength(3);
  });
  test("binds exact pin, private modes and disjoint path/inode identities", () => {
    for (const bad of [ { ...binding, version: 2 }, { ...binding, pin: "2.1.268" }, { ...binding, executableDigest: "c".repeat(64) }, { ...binding, unknown: true },
      { ...binding, profileB: binding.profileA }, { ...binding, profileA: { ...binding.profileA, mode: 0o755 } },
      { ...binding, profileB: { ...binding.profileB, inode: binding.profileA.inode } }, { ...binding, proofKey: { ...binding.proofKey, mode: 0o644 } },
      { ...binding, realHome: "/private/synthetic" }, { ...binding, profileA: { ...binding.profileA, path: "/private/production/A" } },
      { ...binding, temporaryA: { ...binding.temporaryA, path: `${binding.profileA.path}/tmp` } }, { ...binding, forbiddenRoots: ["/private/synthetic"] } ]) expect(() => createQualification(bad, key, id(10))).toThrow("binding_invalid");
  });
  test("stops inherited authentication before any login or logout intent", () => {
    const state = dispatch(atStep(0));
    const result = resultFor(0, id(100));
    if (result.kind !== "preflight") throw new Error("expected preflight fixture");
    const bad = { ...result, probes: result.probes.map((probe, i) => i === 0 ? { ...probe, identity: projectPrivateClaudeIdentity(privateInput("A", true, id(100), id(1_000))) } : probe) };
    const failed = observeQualification(state, { type: "settled", attemptId: id(100), result: bad });
    expect(failed.failure).toBe("inherited_authentication");
    expect(observeQualification(failed, { type: "intent", attemptId: id(101), step: 1 })).toBe(failed);
  });
  test("refuses account or active-email aliasing even with a different organization", () => {
    const baseline = atStep(5).baselineA;
    if (baseline === null) throw new Error("expected A baseline");
    for (const patch of [{ accountTag: baseline.accountTag }, { emailTag: baseline.emailTag }]) {
      expect(changeProbeResult(5, (result) => ({ ...result, probes: result.probes.map((probe) => ({ ...probe, identity: { ...probe.identity, ...patch, organizationTag: "f".repeat(64) } })) })).failure).toBe("identity_crossover");
    }
  });
  test("requires genuine detached facts and explicit no-prompt observations", () => {
    for (const step of [6, 7, 8, 9, 10, 12, 14, 16, 18, 20]) {
      expect(changeProbeResult(step, (result) => ({ ...result, probes: result.probes.map((probe) => ({ ...probe, detached: null })) })).failure).toBe("observation_invalid");
      expect(changeProbeResult(step, (result) => ({ ...result, ownerObservedNoGraphicalPrompt: false })).failure).toBe("observation_invalid");
    }
    expect(changeProbeResult(9, (result) => ({ ...result, concurrentOverlapObserved: false })).failure).toBe("observation_invalid");
    expect(changeProbeResult(6, (result) => ({ ...result, probes: result.probes.map((probe) => ({ ...probe, detached: { ...detached, setsidChecked: false } })) })).failure).toBe("invalid_input");
  });
  test("refuses stale, cross-run, wrong-profile and changed identity observations", () => {
    for (const patch of [{ runId: id(999) }, { attemptId: id(999) }, { profileTag: "f".repeat(64) }, { probeId: id(1_004) }, { accountTag: "f".repeat(64) }, { signedIn: false }, { evidence: "credential_principal" }]) {
      expect(changeProbeResult(6, (result) => ({ ...result, probes: result.probes.map((probe) => ({ ...probe, identity: { ...probe.identity, ...patch } })) })).failure).not.toBeNull();
    }
    expect(changeProbeResult(9, (result) => ({ ...result, probes: [...result.probes].reverse() })).failure).toBe("observation_invalid");
  });
  test("records authenticated interrupt race distinctly and prevents blind recovery login", () => {
    const state = changeProbeResult(14, (result) => ({ ...result, probes: result.probes.map((probe) => probe.identity.profile === "A" ? { ...probe, identity: projectPrivateClaudeIdentity(privateInput("A", true, id(114), id(1_028))) } : probe) }));
    expect(state.interruptionOutcome).toBe("joined_authenticated");
    expect(state.failure).toBe("joined_authenticated");
    expect(state.pending).toBeNull();
    expect(publicQualificationReceipt(state)).toMatchObject({ interruptionReconciled: false, joinedAuthenticatedRace: true, recoveryRequired: true, syntheticSequenceComplete: false });
    expect(observeQualification(state, { type: "intent", attemptId: id(115), step: 15 })).toBe(state);
  });
  test("enforces persistence and exact attempts, refuses duplicate and future events", () => {
    const initial = atStep(0);
    for (const event of [ { type: "dispatch", attemptId: id(100), ...revalidation(initial) }, { type: "intent", attemptId: id(100), step: 1 },
      { type: "future" }, { type: "intent", attemptId: id(100), step: 0, unknown: true } ]) expect(observeQualification(initial, event).failure).not.toBeNull();
    const prepared = observeQualification(initial, { type: "intent", attemptId: id(100), step: 0 });
    expect(observeQualification(prepared, { type: "dispatch", attemptId: id(100), ...revalidation(prepared) }).failure).toBe("order_invalid");
    const running = dispatch(initial);
    expect(observeQualification(running, { type: "settled", attemptId: id(999), result: resultFor(0, id(100)) }).failure).toBe("order_invalid");
    expect(observeQualification(running, { type: "dispatch", attemptId: id(100), ...revalidation(running) }).failure).toBe("order_invalid");
    expect(observeQualification(atStep(1), { type: "intent", attemptId: id(100), step: 1 }).failure).toBe("order_invalid");
  });
  test("cleanup requires four exact reconciled removals and retains protected evidence", () => {
    const state = dispatch(atStep(21));
    const result = resultFor(21, id(121));
    if (result.kind !== "cleanup") throw new Error("expected cleanup fixture");
    const invalidResults = [
      { kind: "cleanup", ...joined, exactOwnedRootsRemoved: true, proofKeyRemoved: true, custodyRevalidated: true },
      { ...result, exactOwnedRootsRemoved: true }, { ...result, proofKeyRemoved: true }, { ...result, protectedEvidenceRetained: false },
      { ...result, rootDeletions: result.rootDeletions.slice(0, 3) },
      ...["runRoot", "proofKey", "profileB"].map((root) => ({ ...result, rootDeletions: result.rootDeletions.map((entry, index) => index === 0 ? { ...entry, root } : entry) })),
      ...["intentPersisted", "removalReconciled"].map((field) => ({ ...result, rootDeletions: result.rootDeletions.map((entry) => ({ ...entry, [field]: false })) })),
    ];
    for (const invalidResult of invalidResults) {
      const failed = observeQualification(state, { type: "settled", attemptId: id(121), result: invalidResult });
      expect(failed.failure).toBe("invalid_input");
      expect(publicQualificationReceipt(failed).syntheticSequenceComplete).toBe(false);
    }
    expect(observeQualification(state, { type: "settled", attemptId: id(121), result }).failure).toBe("order_invalid");
    const completed = observeQualification(recordCleanup(state), { type: "settled", attemptId: id(121), result });
    expect(completed.binding).toEqual(binding);
    const restored = restoreQualificationCheckpoint(encodeQualificationCheckpoint(completed, key), key);
    expect(restored.binding).toEqual(binding);
    expect(publicQualificationReceipt(restored)).toMatchObject({ syntheticSequenceComplete: true, liveQualificationProven: false, activationAuthorized: false });
    expect(observeQualification(restored, { type: "intent", step: 0, attemptId: id(999) }).failure).toBe("order_invalid");
  });
  test("cleanup journal binds every removal to its exact dispatched attempt and order", () => {
    const state = dispatch(atStep(21));
    for (const event of [
      { type: "cleanup_root_intent", attemptId: id(999), root: "profileA" },
      { type: "cleanup_root_intent", attemptId: id(121), root: "profileB" },
      { type: "cleanup_root_removed", attemptId: id(121), root: "profileA" },
      { type: "cleanup_root_intent", attemptId: id(121), root: "runRoot" },
    ]) expect(observeQualification(state, event).failure).not.toBeNull();
    const planned = observeQualification(state, { type: "cleanup_root_intent", attemptId: id(121), root: "profileA" });
    expect(observeQualification(planned, { type: "cleanup_root_intent", attemptId: id(121), root: "profileB" }).failure).toBe("order_invalid");
    const restored = restoreQualificationCheckpoint(encodeQualificationCheckpoint(planned, key), key);
    expect(restored.cleanupRoots).toEqual([{ root: "profileA", stage: "intent" }]);
    expect(observeQualification(restored, { type: "cleanup_root_removed", attemptId: id(121), root: "profileA" }).failure).not.toBeNull();
    const resumed = observeQualification(restored, { type: "resume", ownerEpoch: id(12), ...revalidation(restored) });
    const removed = observeQualification(resumed, { type: "cleanup_root_removed", attemptId: id(121), root: "profileA" });
    expect(removed.cleanupRoots).toEqual([{ root: "profileA", stage: "removed" }]);
    expect(removed.failure).toBeNull();
    expect(observeQualification(removed, { type: "cleanup_root_removed", attemptId: id(121), root: "profileA" }).failure).toBe("order_invalid");
  });
  test("cleanup event permutations cannot skip a root and partial journals preserve recovery position", () => {
    const initial = dispatch(atStep(21));
    const events = QUALIFICATION_CLEANUP_ROOTS.flatMap((root) => [
      { type: "cleanup_root_intent", attemptId: id(121), root } as const,
      { type: "cleanup_root_removed", attemptId: id(121), root } as const,
    ]);
    fc.assert(fc.property(fc.shuffledSubarray(events, { minLength: 0, maxLength: 8 }), (sequence) => {
      const observed = sequence.reduce((state, event) => observeQualification(state, event), initial);
      const completed = observeQualification(observed, { type: "settled", attemptId: id(121), result: resultFor(21, id(121)) });
      const canonical = JSON.stringify(sequence) === JSON.stringify(events);
      expect(publicQualificationReceipt(completed).syntheticSequenceComplete).toBe(canonical);
    }), { numRuns: 100, seed: 20260911 });
    fc.assert(fc.property(fc.integer({ min: 0, max: 8 }), (length) => {
      const partial = events.slice(0, length).reduce((state, event) => observeQualification(state, event), initial);
      const restored = restoreQualificationCheckpoint(encodeQualificationCheckpoint(partial, key), key);
      expect(restored.cleanupRoots).toEqual(partial.cleanupRoots);
      expect(restored.pending).toEqual(partial.pending);
      expect(restored.needsRecovery).toBe(true);
    }), { numRuns: 100, seed: 20260911 });
  });
});

describe("private checkpoints and fixture orchestration", () => {
  test("per-root fixture observations follow persisted intent and failures retain the exact pending root", async () => {
    const persisted: QualificationState[] = [];
    const observed: string[] = [];
    const state = await driveCredentialFreeFixtureStep(atStep(21), key, id(121), {
      mode: "credential_free_fixture", revalidate: async () => revalidation(atStep(21)),
      persist: async (checkpoint) => { persisted.push(restoreQualificationCheckpoint(checkpoint, key)); },
      observeCleanupRoot: async ({ root }) => {
        expect(persisted.at(-1)?.cleanupRoots.at(-1)).toEqual({ root, stage: "intent" });
        observed.push(root); return { root, removalReconciled: true };
      },
      observe: async () => resultFor(21, id(121)),
    });
    expect(observed).toEqual([...QUALIFICATION_CLEANUP_ROOTS]);
    expect(publicQualificationReceipt(state).syntheticSequenceComplete).toBe(true);
    const failed = await driveCredentialFreeFixtureStep(atStep(21), key, id(121), {
      mode: "credential_free_fixture", revalidate: async () => revalidation(atStep(21)), persist: async () => {},
      observeCleanupRoot: async () => { throw new Error("synthetic uncertain removal"); }, observe: async () => resultFor(21, id(121)),
    });
    expect(failed.failure).toBe("uncertain_effect");
    expect(failed.cleanupRoots).toEqual([{ root: "profileA", stage: "intent" }]);
  });
  test("authenticates exact journals and refuses tampering, wrong keys, versions and oversize", () => {
    const checkpoint = encodeQualificationCheckpoint(atStep(8), key);
    const restored = restoreQualificationCheckpoint(checkpoint, key);
    expect(restored.step).toBe(8);
    expect(restored.needsRecovery).toBe(true);
    expect(restored.baselineA).toEqual(atStep(8).baselineA);
    expect(() => restoreQualificationCheckpoint(checkpoint, new Uint8Array(32).fill(3))).toThrow("invalid_input");
    const changed = checkpoint.slice();
    changed[40] = 88;
    expect(() => restoreQualificationCheckpoint(changed, key)).toThrow("invalid_input");
    for (const invalid of [new Uint8Array(131_073), new Uint8Array([0xff, 0xff]), bytes({ version: 2 }), bytes({ version: 1, payload: "{}", mac: "a".repeat(64), unknown: true })]) expect(() => restoreQualificationCheckpoint(invalid, key)).toThrow("invalid_input");
    expect(JSON.stringify(new TextDecoder().decode(checkpoint))).not.toContain("example.invalid");
  });
  test("whole-harness recovery preserves the attempt and requires fresh owner plus reconciliation", () => {
    const pending = dispatch(atStep(1));
    const restored = restoreQualificationCheckpoint(encodeQualificationCheckpoint(pending, key), key);
    expect(restored.pending).toEqual(pending.pending);
    expect(observeQualification(restored, { type: "dispatch", attemptId: id(101), ...revalidation(restored) }).failure).toBe("order_invalid");
    expect(observeQualification(restored, { type: "resume", ownerEpoch: id(10), ...revalidation(restored) }).failure).toBe("binding_invalid");
    expect(observeQualification(restored, { type: "resume", ownerEpoch: id(11), ...revalidation(restored), bindingTag: "f".repeat(64) }).failure).toBe("binding_invalid");
    const resumed = observeQualification(restored, { type: "resume", ownerEpoch: id(11), ...revalidation(restored) });
    expect(resumed.needsRecovery).toBe(true);
    expect(observeQualification(resumed, { type: "intent", attemptId: id(999), step: 1 }).failure).toBe("order_invalid");
    const reconciled = observeQualification(resumed, { type: "reconciled", attemptId: id(101), result: resultFor(1, id(101)) });
    expect(reconciled.failure).toBeNull();
    expect(reconciled.step).toBe(2);
    expect(reconciled.pending).toBeNull();
    const again = restoreQualificationCheckpoint(encodeQualificationCheckpoint(reconciled, key), key);
    expect(again.step).toBe(2);
    expect(again.needsRecovery).toBe(true);
    expect(again.ownerEpochs).toEqual([id(10), id(11)]);
  });
  test("persists the exact dispatch intent before observing and saves settlement", async () => {
    const order: string[] = [];
    const persisted: Uint8Array[] = [];
    const state = await driveCredentialFreeFixtureStep(atStep(0), key, id(100), { mode: "credential_free_fixture", revalidate: async () => revalidation(createQualification(binding, key, id(10))),
      persist: async (checkpoint) => { persisted.push(checkpoint); order.push("persist"); },
      observe: async ({ step, attemptId }) => { order.push("observe"); return resultFor(step, attemptId); } });
    expect(order).toEqual(["persist", "persist", "persist", "observe", "persist"]);
    expect(state.step).toBe(1);
    const dispatched = persisted[2];
    if (dispatched === undefined) throw new Error("missing dispatch checkpoint");
    expect(restoreQualificationCheckpoint(dispatched, key).pending).toEqual({ stage: "dispatched", attemptId: id(100) });
  });
  test("every persistence failure or ambiguous effect prevents automatic replay", async () => {
    for (let failureAt = 0; failureAt < 4; failureAt += 1) {
      let saves = 0;
      let effects = 0;
      const state = await driveCredentialFreeFixtureStep(atStep(1), key, id(101), { mode: "credential_free_fixture", revalidate: async () => revalidation(createQualification(binding, key, id(10))),
        persist: async () => { if (saves++ === failureAt) throw new Error("synthetic persistence uncertainty"); },
        observe: async ({ step, attemptId }) => { effects += 1; return resultFor(step, attemptId); } });
      expect(state.failure).toBe("persistence_uncertain");
      expect(effects).toBe(failureAt === 3 ? 1 : 0);
      await expect(driveCredentialFreeFixtureStep(state, key, id(999), { mode: "credential_free_fixture", revalidate: async () => revalidation(createQualification(binding, key, id(10))), persist: async () => {}, observe: async () => resultFor(1, id(999)) })).rejects.toThrow("order_invalid");
    }
    const uncertain = await driveCredentialFreeFixtureStep(atStep(1), key, id(101), { mode: "credential_free_fixture", revalidate: async () => revalidation(createQualification(binding, key, id(10))), persist: async () => {}, observe: async () => { throw new Error("synthetic unknown result"); } });
    expect(uncertain.failure).toBe("uncertain_effect");
    expect(uncertain.pending?.attemptId).toBe(id(101));
    const resumed = observeQualification(uncertain, { type: "resume", ownerEpoch: id(11), ...revalidation(uncertain) });
    const reconciled = await reconcileCredentialFreeFixtureAttempt(resumed, key, id(101), resultFor(1, id(101)), async () => {});
    expect(reconciled.step).toBe(2);
    expect(reconciled.failure).toBeNull();
  });
  test("refused fresh binding validation never reaches the fixture observation port", async () => {
    let observations = 0;
    for (const patch of [{ bindingTag: "f".repeat(64) }, { sourceAndExecutableRevalidated: false }, { privateCustodyRevalidated: false }, { environmentRevalidated: false }]) {
      const state = await driveCredentialFreeFixtureStep(atStep(1), key, id(101), { mode: "credential_free_fixture",
        revalidate: async () => ({ ...revalidation(createQualification(binding, key, id(10))), ...patch }), persist: async () => {},
        observe: async () => { observations += 1; return resultFor(1, id(101)); } });
      expect(state.failure).not.toBeNull();
      expect(state.pending?.attemptId).toBe(id(101));
    }
    expect(observations).toBe(0);
  });
  test("bounded mutation sweep cannot skip a phase or falsely admit a completion", () => {
    for (let step = 0; step < 22; step += 1) {
      const state = dispatch(atStep(step));
      const result = resultFor(step, id(100 + step));
      for (const patch of [{ childJoined: false }, { stdoutJoined: false }, { stderrJoined: false }, { extra: true }]) {
        const failed = observeQualification(state, { type: "settled", attemptId: id(100 + step), result: { ...result, ...patch } });
        expect(failed.failure).toBe("invalid_input");
        expect(publicQualificationReceipt(failed).syntheticSequenceComplete).toBe(false);
        expect(publicQualificationReceipt(failed).activationAuthorized).toBe(false);
      }
    }
  });
});
