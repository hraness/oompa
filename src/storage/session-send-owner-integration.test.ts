import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { effectiveRuntimeProfileSchema } from "../domain/runtime-profile";
import { initializeStatePaths, resolveStatePaths } from "./paths";
import { StateStore } from "./state-store";

const stores = new Set<StateStore>();
const directories: string[] = [];

afterEach(async () => {
  for (const store of stores) store.close();
  stores.clear();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "oompa-send-owner-integration-")));
  directories.push(directory);
  const paths = resolveStatePaths({ homeDirectory: directory, platform: "darwin" });
  await initializeStatePaths(paths);
  let time = 10_000;
  const now = () => ++time;
  const open = (readonly = false) => {
    const store = new StateStore(paths, { now, readonly, resolveMachineTimeZone: () => "UTC" });
    stores.add(store);
    return store;
  };
  const store = open();
  const bootId = `boot_${"a".repeat(32)}`;
  const daemonGeneration = store.nextDaemonGeneration(bootId);
  const createdProfile = store.createProfile("Original owner source");
  const profile = store.nextProfileGeneration(createdProfile.id);
  expect(store.setProfileState(profile.id, profile.processGeneration, "signed_in", {
    email: "send-owner@example.com", plan: "Plus",
  })).toBe(true);
  const created = store.createSession({ profileId: profile.id, preset: "high", fastEnabled: false });
  store.bindSession({ sessionId: created.id, expectedRevision: created.revision,
    providerThreadId: "original-send-thread", state: "idle" });
  const session = store.reconcileSessionFromProvider({ sessionId: created.id, title: "Original send label" });
  const request = { kind: "session.send" as const, session: session.title, message: "Exact original caller input",
    attachments: [], idempotencyKey: randomUUID() };
  const prepared = store.prepareOwnedSessionSend(request);
  const runtimeProfile = effectiveRuntimeProfileSchema.parse({
    profileId: profile.id, processGeneration: profile.processGeneration, observedAt: now(), preset: "high",
    model: "gpt-6-astra", reasoningEffort: "max", serviceTier: null, fast: false,
    approvalPolicy: "on-request", reviewMode: "auto_review", permissionProfile: ":workspace",
    computerUse: true, pluginCapability: true, enabledApps: [],
  });
  const claimInput = {
    attemptId: prepared.owner.attemptId, ownerDigest: prepared.ownerDigest,
    requestFingerprint: prepared.owner.fingerprint, daemonGeneration, bootId,
    expectedSessionRevision: prepared.owner.sourceSessionRevision, executionAuthority: prepared.owner.sourceAuthority,
    evidence: { kind: "session.send" as const, providerThreadId: prepared.owner.sourceThreadId,
      baseline: { providerUpdatedAt: null, status: "idle" as const, activeTurnId: null },
      clientMessageId: prepared.owner.attemptId, messageDigest: prepared.owner.fingerprint.inputDigest, runtimeProfile },
  };
  const accepted = { kind: "accepted" as const, receipt: {
    turnId: "original-send-turn", status: "completed" as const, sourceId: prepared.owner.attemptId,
    effectiveRuntimeProfile: runtimeProfile,
  } };
  return { store, paths, open, profile, session, request, prepared, claimInput, accepted, bootId, daemonGeneration };
}

function claimedDigest(claim: ReturnType<StateStore["beginOwnedDirectSendEffect"]>): string {
  if (claim.claimDigest === null) throw new Error("The successful claim has no digest.");
  return claim.claimDigest;
}

describe("original send ownership cross-boundary integration", () => {
  test.each([false, true])("two independent connections cannot grant the same stale claim twice (reverse=%s)", async (reverse) => {
    const value = await fixture();
    const other = value.open();
    // Both connections observe the unclaimed owner before either competes for
    // the immediate write boundary. Exercise both possible admission orders.
    expect(other.readOwnedSessionSend(value.request.idempotencyKey)?.state).toBe("input_required");
    const [first, second] = reverse ? [other, value.store] : [value.store, other];
    const claimed = first.beginOwnedDirectSendEffect(value.claimInput);
    expect(claimed.dispatchGranted).toBe(true);
    expect(() => second.beginOwnedDirectSendEffect(value.claimInput)).toThrow("SESSION_SEND_CLAIM_CONFLICT");
    expect(second.readOwnedSessionSend(value.request.idempotencyKey)?.claimDigest).toBe(claimed.claimDigest);
    const inspector = new Database(value.paths.database, { readonly: true, strict: true });
    try {
      for (const table of ["session_send_execution_claims", "mutation_effect_evidence"] as const) {
        expect(inspector.query(`SELECT COUNT(*) AS count FROM ${table} WHERE attempt_id=?`)
          .get(value.prepared.owner.attemptId)).toEqual({ count: 1 });
      }
    } finally { inspector.close(false); }
  });

  test.each([false, true])("cancellation and dispatch are mutually exclusive across connections (cancelFirst=%s)", async (cancelFirst) => {
    const value = await fixture();
    const other = value.open();
    const cancel = { attemptId: value.prepared.owner.attemptId, ownerDigest: value.prepared.ownerDigest };
    if (cancelFirst) {
      expect(other.cancelOwnedSessionSend(cancel).state).toBe("cancelled");
      expect(() => value.store.beginOwnedDirectSendEffect(value.claimInput)).toThrow("SESSION_SEND_CLAIM_CONFLICT");
      expect(value.store.cancelOwnedSessionSend(cancel).state).toBe("cancelled");
      expect(value.store.readOwnedSessionSend(value.request.idempotencyKey)?.claim).toBeNull();
    } else {
      const claim = value.store.beginOwnedDirectSendEffect(value.claimInput);
      expect(() => other.cancelOwnedSessionSend(cancel)).toThrow("SESSION_SEND_CLAIM_CONFLICT");
      expect(other.readOwnedSessionSend(value.request.idempotencyKey)?.claimDigest).toBe(claim.claimDigest);
    }
  });

  test("accepted history survives provider facts and a renamed original selector without mutating the current session", async () => {
    const value = await fixture();
    const claim = value.store.beginOwnedDirectSendEffect(value.claimInput);
    const current = value.store.reconcileSessionFromProvider({ sessionId: value.session.id, title: "Provider changed the title" });
    expect(current.revision).toBeGreaterThan(value.prepared.owner.sourceSessionRevision);
    expect(() => value.store.requireSession(value.request.session)).toThrow();
    const settlement = { attemptId: value.prepared.owner.attemptId, ownerDigest: value.prepared.ownerDigest,
      claimDigest: claimedDigest(claim), outcome: value.accepted };
    const accepted = value.store.settleOwnedDirectSend(settlement);
    expect(accepted.state).toBe("accepted");
    expect(accepted.owner).toEqual(value.prepared.owner);
    expect(value.store.requireSession(value.session.id)).toEqual(current);
    expect(value.store.settleOwnedDirectSend(settlement)).toEqual(accepted);
    expect(value.store.prepareOwnedSessionSend(value.request)).toEqual({ ...accepted, replayed: true });
    expect(value.open(true).readOwnedSessionSend(value.request.idempotencyKey)).toEqual(accepted);
    expect(() => value.store.readMutation(value.request.idempotencyKey)).toThrow("SESSION_SEND_OWNED_API_REQUIRED");
    expect(() => value.store.beginOwnedDirectSendEffect(value.claimInput)).toThrow("SESSION_SEND_CLAIM_CONFLICT");
  });

  test("replaying the same ambiguous settlement does not append or fail, and final history never branches", async () => {
    const value = await fixture();
    const claim = value.store.beginOwnedDirectSendEffect(value.claimInput);
    const identity = { attemptId: value.prepared.owner.attemptId, ownerDigest: value.prepared.ownerDigest,
      claimDigest: claimedDigest(claim) };
    const ambiguous = { ...identity, outcome: { kind: "ambiguous" as const, reason: "provider_outcome_unknown" as const } };
    const first = value.store.settleOwnedDirectSend(ambiguous);
    expect(first.state).toBe("ambiguous");
    expect(value.store.settleOwnedDirectSend(ambiguous)).toEqual(first);
    const accepted = value.store.settleOwnedDirectSend({ ...identity, outcome: value.accepted });
    expect(accepted.state).toBe("accepted");
    expect(accepted.outcomes).toHaveLength(2);
    expect(value.store.settleOwnedDirectSend({ ...identity, outcome: value.accepted })).toEqual(accepted);
    expect(() => value.store.settleOwnedDirectSend({ ...identity,
      outcome: { kind: "abandoned", acknowledgeOutcomeUnknown: true } })).toThrow("SESSION_SEND_CLAIM_CONFLICT");
    expect(() => value.store.beginOwnedDirectSendEffect(value.claimInput)).toThrow("SESSION_SEND_CLAIM_CONFLICT");
  });

  test("an unclaimed owner survives a new boot without gaining an execution lease or accepting changed input", async () => {
    const value = await fixture();
    const original = value.store.readOwnedSessionSend(value.request.idempotencyKey);
    value.store.nextDaemonGeneration(`boot_${"b".repeat(32)}`);
    value.store.recoverEffectStartedMutations();
    expect(value.store.readOwnedSessionSend(value.request.idempotencyKey)).toEqual(original);
    expect(value.open(true).readOwnedSessionSend(value.request.idempotencyKey)?.state).toBe("input_required");
    expect(() => value.store.beginOwnedDirectSendEffect(value.claimInput)).toThrow();
    expect(() => value.store.prepareOwnedSessionSend({ ...value.request, message: "Changed caller input" }))
      .toThrow("SESSION_SEND_REQUEST_CONFLICT");
    expect(value.store.readOwnedSessionSend(value.request.idempotencyKey)?.claim).toBeNull();
  });

  test("restart ambiguity accepts a late exact receipt without reviving the old writer or rewriting its authority", async () => {
    const value = await fixture();
    const claim = value.store.beginOwnedDirectSendEffect(value.claimInput);
    value.store.nextDaemonGeneration(`boot_${"c".repeat(32)}`);
    value.store.recoverEffectStartedMutations();
    const currentSession = value.store.requireSession(value.session.id);
    const currentAuthority = value.store.requireProviderAccountAuthority(value.profile.id, "codex");
    const recovered = value.store.readOwnedSessionSend(value.request.idempotencyKey);
    expect(recovered?.state).toBe("ambiguous");
    expect(currentAuthority.processGeneration).toBeGreaterThan(value.prepared.owner.sourceAuthority.processGeneration);
    expect(recovered?.owner).toEqual(value.prepared.owner);
    expect(recovered?.claim).toEqual(claim.claim);
    const accepted = value.store.settleOwnedDirectSend({ attemptId: value.prepared.owner.attemptId,
      ownerDigest: value.prepared.ownerDigest, claimDigest: claimedDigest(claim), outcome: value.accepted });
    expect(accepted.state).toBe("accepted");
    expect(accepted.outcomes).toHaveLength(2);
    expect(value.store.requireSession(value.session.id)).toEqual(currentSession);
    expect(value.store.requireProviderAccountAuthority(value.profile.id, "codex")).toEqual(currentAuthority);
    expect(value.store.prepareOwnedSessionSend(value.request)).toEqual({ ...accepted, replayed: true });
    expect(value.open(true).readOwnedSessionSend(value.request.idempotencyKey)).toEqual(accepted);
    expect(() => value.store.beginOwnedDirectSendEffect(value.claimInput)).toThrow("SESSION_SEND_CLAIM_CONFLICT");
  });
});
