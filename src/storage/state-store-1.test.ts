import { afterEach, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { renameSync, symlinkSync } from "node:fs";
import { chmod, lstat, mkdtemp, mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database, constants as sqliteConstants } from "bun:sqlite";
import { z } from "zod";
import { canonical40QueuesFixture } from "../../scripts/fixtures/canonical40-queues";
import { canonical48WorkFixture, type Canonical48WorkState } from "../../scripts/fixtures/canonical48-work";
import { syntheticAdoption36, syntheticAdoption36CandidateFingerprint } from "../../scripts/fixtures/synthetic-adoption36";
import { combined49RetiredFixture } from "../../scripts/fixtures/combined49-retired";
import { combined49SwitchFixture } from "../../scripts/fixtures/combined49-switch";
import { activePresetBinding, currentPresetContract, legacyPresetContract, presetRequirements } from "../domain/presets";
import { SESSION_EVENT_RETAIN_AGE_MS } from "../domain/session-events";
import { createAttemptId, utf8Bytes } from "../domain/values";
import { effectiveRuntimeProfileSchema } from "../domain/runtime-profile";
import { initializeStatePaths, resolveStatePaths } from "./paths";
import { SelectionError, SessionSwitchStoreError, sessionProviderSwitchMutationRequest, StateStore } from "./state-store";
import { canonicalWorkJson, WORK_PROJECT_AUTHORITY_SCHEMA_SQL, type WorkDispatchOutcome } from "./work-store";
import { deriveLegacySessionProfileKey, deriveLegacyWorkProfileKey } from "./canonical-profile-storage";
import {
  adoptPersonalClaudeTestSession,
  advanceDedicatedSessionSwitch,
  archivedRetired49,
  canonical40QueueArchive,
  canonical48WorkArchive,
  canonicalAuthBudgetRows,
  canonicalAuthBudgetSnapshot,
  claudeAdoptionRuntimeProfile,
  codexAdoptionRuntimeProfile,
  codexInteractionBinding,
  combined49SwitchArchiveForTest,
  completeCodexAccountMutationAuthorityRetirement,
  corruptCombined49SwitchRowsForTest,
  createProvenTestSession,
  createRevocationWorkStore,
  drainStateStoreCasesAndClose,
  expectCanonical35To38InertReopens,
  expectInertSchemaRefusal,
  expectInertSwitchReopenForTest,
  expectSyntheticAdoption36Maintenance,
  fixture,
  installSessionAuthoritySuccessorForTest,
  managedClaudeRuntimeProfile,
  namedProviderAccountKey,
  ownedSendFixture,
  ownedStateStoreCaseDrains,
  prepareDedicatedSessionSwitch,
  providerAccountKeyForProfile,
  publicProviderIdentifier,
  restoreSwitchGuardsForTest,
  retiredCloseHistory,
  sessionSwitchDigest,
  signInProfile,
  snapshotSwitchContainmentForTest,
  startInputFixtureDaemon,
  stores,
  syntheticAdoption36ContractFixture,
  syntheticAdoption36MaintenanceTables,
  testProviderAccountKey,
  testSwitchHostCapabilities,
  testUnexpectedAdoptionHostCapabilities,
  upsertProvenTestSession,
  withRemovedTestGuards,
} from "../../scripts/fixtures/state-store-testkit";

setDefaultTimeout(60_000);

afterEach(async () => {
  await drainStateStoreCasesAndClose(ownedStateStoreCaseDrains, () => stores.splice(0));
});

describe("StateStore", () => {
test("original send ownership accepts a legal large runtime profile and non-mutation runtime source namespaces", async () => {
    const value = await ownedSendFixture();
    const runtimeProfile = effectiveRuntimeProfileSchema.parse({ ...value.runtimeProfile,
      enabledApps: Array.from({ length: 100 }, (_, index) => ({ id: `app-${String(index).padStart(3, "0")}`,
        name: "n".repeat(320), pluginDisplayNames: ["p".repeat(320)] })) });
    expect(utf8Bytes(JSON.stringify(runtimeProfile))).toBeGreaterThan(32 * 1024);
    const runtime = value.store.recordSessionRuntimeProfile({ sessionId: value.session.id, sourceKind: "session_start",
      sourceId: randomUUID(), profile: runtimeProfile, providerAuthority: value.authority });
    expect(runtime.profile).toEqual(runtimeProfile);
    expect(value.store.runtimeProfileSourceRequiresSettlement(value.session.id, randomUUID())).toBe(false);
    const claim = value.store.beginOwnedDirectSendEffect({ ...value.begin, evidence: { ...value.begin.evidence, runtimeProfile } });
    expect(claim.dispatchGranted).toBe(true);
    expect(value.store.settleOwnedDirectSend({ attemptId: claim.owner.attemptId, ownerDigest: claim.ownerDigest,
      claimDigest: claim.claimDigest!, outcome: { kind: "accepted", receipt: { turnId: "large-profile-turn", status: "completed",
        sourceId: claim.owner.attemptId, effectiveRuntimeProfile: runtimeProfile } } }).state).toBe("accepted");
  });
test.each(["codex", "claude"] as const)("original send ownership refuses a generation-zero %s dispatch", async (provider) => {
    const value = await ownedSendFixture(provider, 0);
    expect(() => value.store.beginOwnedDirectSendEffect(value.begin)).toThrow("SESSION_SEND_SOURCE_CHANGED");
    expect(value.store.readOwnedSessionSend(value.request.idempotencyKey)?.claim).toBeNull();
  });
test("original send ownership requires a real exact daemon boot before claiming", async () => {
    const value = await ownedSendFixture();
    for (const bootId of ["arbitrary", `boot_${"z".repeat(32)}`, `boot_${"a".repeat(32)}`]) {
      expect(() => value.store.beginOwnedDirectSendEffect({ ...value.begin, bootId })).toThrow();
      expect(value.store.readOwnedSessionSend(value.request.idempotencyKey)?.claim).toBeNull();
    }
    expect(value.store.beginOwnedDirectSendEffect(value.begin).dispatchGranted).toBe(true);
  });
test.each([true, false])("original send ownership scopes foreground login exclusion exactly (same provider=%s)", async (sameProvider) => {
    const value = await ownedSendFixture(sameProvider ? "claude" : "codex");
    const authority = value.store.requireProviderAccountAuthority(value.profile.id, "claude");
    const login = value.store.prepareMutation({ kind: "account.claude-login", authorityId: value.profile.id,
      authorityGeneration: authority.processGeneration, request: { provider: "claude" },
      providerAuthorities: [{ role: "primary", authority, provenance: "account_claude_login" }] });
    value.store.beginClaudeLoginMutationEffect({ attemptId: login.id, profileId: value.profile.id,
      profileGeneration: authority.processGeneration, evidence: { kind: "account.claude-login", provider: "claude", baselineSignedIn: false } });
    if (sameProvider) {
      expect(() => value.store.beginOwnedDirectSendEffect(value.begin)).toThrow("SESSION_SEND_CLAIM_CONFLICT");
      expect(value.store.readOwnedSessionSend(value.request.idempotencyKey)?.claim).toBeNull();
    } else expect(value.store.beginOwnedDirectSendEffect(value.begin).dispatchGranted).toBe(true);
  });
test.each(["missing", "replaced"] as const)("original send ownership refuses a foreground login with %s primary evidence", async (corruption) => {
    const value = await ownedSendFixture("claude");
    const login = value.store.prepareMutation({ kind: "account.claude-login", authorityId: value.profile.id,
      authorityGeneration: value.authority.processGeneration, request: { provider: "claude" },
      providerAuthorities: [{ role: "primary", authority: value.authority, provenance: "account_claude_login" }] });
    value.store.beginClaudeLoginMutationEffect({ attemptId: login.id, profileId: value.profile.id,
      profileGeneration: value.authority.processGeneration, evidence: { kind: "account.claude-login", provider: "claude", baselineSignedIn: false } });
    const database = new Database(value.store.paths.database, { strict: true });
    try {
      const name = `mutation_provider_authorities_immutable_${corruption === "missing" ? "delete" : "update"}`;
      const guard = (database.query("SELECT sql FROM sqlite_master WHERE name=?").get(name) as { sql: string }).sql;
      database.exec(`DROP TRIGGER ${name}`);
      if (corruption === "missing") database.query("DELETE FROM mutation_provider_authorities WHERE attempt_id=?").run(login.id);
      else database.query("UPDATE mutation_provider_authorities SET process_generation=process_generation+1 WHERE attempt_id=?").run(login.id);
      database.exec(guard);
      expect(() => value.store.beginOwnedDirectSendEffect(value.begin)).toThrow("SESSION_SEND_CLAIM_CONFLICT");
      expect(value.store.readOwnedSessionSend(value.request.idempotencyKey)?.claim).toBeNull();
      expect(database.query("SELECT 1 FROM mutation_effect_evidence WHERE attempt_id=?").get(value.prepared.owner.attemptId)).toBeNull();
    } finally { database.close(false); }
  });
test.each([true, false])("original send ownership binds unbound permissions to the exact native authority (same account=%s)", async (sameAccount) => {
    const value = await ownedSendFixture();
    const authority = sameAccount ? value.authority : value.store.requireProviderAccountAuthority(
      signInProfile(value.store, "Independent permission", "independent@example.com").id, "codex");
    value.store.admitInteraction({ publicId: randomUUID(), sessionId: null,
      authority: { ...authority, connectionId: randomUUID(), requestId: { type: "string", value: "owned-permission" },
        method: "item/commandExecution/requestApproval", requestDigest: "d".repeat(64), threadId: value.prepared.owner.sourceThreadId,
        turnId: "permission-turn", itemId: "permission-item", approvalId: null }, kind: "command_approval", blocking: true,
      display: { kind: "command_approval", summary: "Approve exact native request", reason: null, commandClass: "test",
        workingDirectory: null, availableDecisions: ["once", "decline"] } });
    if (sameAccount) {
      expect(() => value.store.beginOwnedDirectSendEffect(value.begin)).toThrow("SESSION_SEND_CLAIM_CONFLICT");
      expect(value.store.readOwnedSessionSend(value.request.idempotencyKey)?.claim).toBeNull();
    } else expect(value.store.beginOwnedDirectSendEffect(value.begin).dispatchGranted).toBe(true);
  });
test("original send ownership refuses missing unbound permission authority without inferring a provider", async () => {
    const value = await ownedSendFixture();
    const publicId = randomUUID();
    value.store.admitInteraction({ publicId, sessionId: null,
      authority: { ...value.authority, connectionId: randomUUID(), requestId: { type: "string", value: "missing-permission" },
        method: "item/commandExecution/requestApproval", requestDigest: "e".repeat(64), threadId: value.prepared.owner.sourceThreadId,
        turnId: "permission-turn", itemId: "permission-item", approvalId: null }, kind: "command_approval", blocking: true,
      display: { kind: "command_approval", summary: "Approve exact native request", reason: null, commandClass: "test",
        workingDirectory: null, availableDecisions: ["once", "decline"] } });
    const database = new Database(value.store.paths.database, { strict: true });
    try {
      database.query("DELETE FROM interaction_provider_authorities WHERE public_id=?").run(publicId);
      expect(() => value.store.beginOwnedDirectSendEffect(value.begin)).toThrow("SESSION_SEND_CLAIM_CONFLICT");
      expect(value.store.readOwnedSessionSend(value.request.idempotencyKey)?.claim).toBeNull();
      expect(database.query("SELECT 1 FROM mutation_effect_evidence WHERE attempt_id=?").get(value.prepared.owner.attemptId)).toBeNull();
    } finally { database.close(false); }
  });
test("original send ownership bounds unclaimed requests without making them account execution blockers", async () => {
    const value = await ownedSendFixture("claude");
    value.store.bindSessionProviderAccountAuthority({
      sessionId: value.session.id, provider: "claude", runtimeScope: "managed",
      accountKey: testProviderAccountKey("claude"),
    });
    for (let index = 1; index < 64; index += 1) value.store.prepareOwnedSessionSend({ ...value.request, idempotencyKey: randomUUID() });
    expect(() => value.store.prepareOwnedSessionSend({ ...value.request, idempotencyKey: randomUUID() })).toThrow("SESSION_SEND_OWNER_LIMIT");
    expect(value.store.listUnsettledMutations({ sessionId: value.session.id })).toEqual([]);
    expect(value.store.canReleaseIdleClaudeSessionForAccountLogin({ profileId: value.profile.id,
      profileGeneration: value.authority.processGeneration, sessionId: value.session.id })).toBe(true);
    value.store.cancelOwnedSessionSend({ attemptId: value.prepared.owner.attemptId, ownerDigest: value.prepared.ownerDigest });
    expect(value.store.prepareOwnedSessionSend({ ...value.request, idempotencyKey: randomUUID() }).state).toBe("input_required");
  });
test("original send ownership terminalization preserves an unclaimed request and records claimed uncertainty without legacy abandonment", async () => {
    for (const claimed of [false, true]) {
      const value = await ownedSendFixture();
      if (claimed) value.store.beginOwnedDirectSendEffect(value.begin);
      value.store.terminalizeSessionFromProviderDeletion({ accountId: value.profile.id, providerConnectionId: null,
        providerGeneration: value.authority.processGeneration, providerAuthority: value.authority, sessionId: value.session.id });
      expect(value.store.readOwnedSessionSend(value.request.idempotencyKey)?.state).toBe(claimed ? "ambiguous" : "input_required");
      expect(value.store.requireSession(value.session.id).state).toBe("terminal");
      if (claimed) expect(value.store.listUnsettledMutations({ sessionId: value.session.id })).toMatchObject([{ format: "original_send_v1", state: "ambiguous" }]);
    }
  });
test("original send ownership admits unverified native authority only under explicit routing", async () => {
    const value = await ownedSendFixture("claude");
    const state = value.store.readProviderAccountState("claude");
    value.store.activateProviderAccount({ provider: "claude", expectedPointerRevision: state.pointerRevision,
      providerAccountId: value.authority.providerAccountId });
    const created = value.store.createSession({ provider: "claude", preset: "fable-max", fastEnabled: false, routing: "managed" });
    const session = value.store.bindSession({ sessionId: created.id, expectedRevision: created.revision,
      providerThreadId: "managed-unverified-native", state: "idle" });
    const owner = value.store.prepareOwnedSessionSend({ ...value.request, session: session.id, idempotencyKey: randomUUID() });
    expect(() => value.store.beginOwnedDirectSendEffect({ ...value.begin, attemptId: owner.owner.attemptId, ownerDigest: owner.ownerDigest,
      requestFingerprint: owner.owner.fingerprint, expectedSessionRevision: owner.owner.sourceSessionRevision,
      evidence: { ...value.begin.evidence, providerThreadId: owner.owner.sourceThreadId, clientMessageId: owner.owner.attemptId } }))
      .toThrow("SESSION_SEND_SOURCE_CHANGED");
    expect(value.store.readOwnedSessionSend(owner.owner.idempotencyKey)?.claim).toBeNull();
    expect(value.store.beginOwnedDirectSendEffect(value.begin).dispatchGranted).toBe(true);
  });
test.each(["owner", "claim", "outcome_1"] as const)("original send ownership rolls back every write when the final %s anchor fails", async (kind) => {
    const value = await ownedSendFixture();
    const database = new Database(value.store.paths.database, { strict: true });
    try {
      if (kind === "outcome_1") value.store.beginOwnedDirectSendEffect(value.begin);
      const request = { ...value.request, idempotencyKey: randomUUID() };
      const before = value.store.readOwnedSessionSend(value.request.idempotencyKey);
      database.exec(`CREATE TRIGGER reject_owned_anchor BEFORE INSERT ON session_send_owner_anchors
        WHEN NEW.kind='${kind}' BEGIN SELECT RAISE(ABORT,'injected final owner anchor failure'); END;`);
      expect(() => kind === "owner" ? value.store.prepareOwnedSessionSend(request)
        : kind === "claim" ? value.store.beginOwnedDirectSendEffect(value.begin)
          : value.store.settleOwnedDirectSend({ attemptId: before!.owner.attemptId, ownerDigest: before!.ownerDigest,
            claimDigest: before!.claimDigest!, outcome: { kind: "ambiguous", reason: "provider_outcome_unknown" } }))
        .toThrow("injected final owner anchor failure");
      expect(value.store.readOwnedSessionSend(value.request.idempotencyKey)).toEqual(before);
      expect(value.store.readOwnedSessionSend(request.idempotencyKey)).toBeNull();
      database.exec("DROP TRIGGER reject_owned_anchor");
      const reopened = new StateStore(value.store.paths, { readonly: true });
      stores.push(reopened);
      expect(reopened.readOwnedSessionSend(value.request.idempotencyKey)).toEqual(before);
    } finally { database.close(false); }
  });
test("original send ownership preserves authentic canonical40 receipt bytes without fabricating ownership", async () => {
    const paths = await canonical40QueueArchive();
    const { mutation, request, receipt } = canonical40QueuesFixture.legacy;
    const database = new Database(paths.database, { strict: true });
    try {
      const readLegacy = () => database.query("SELECT id,idempotency_key,kind,authority_id,authority_generation,request_digest,state,result_json,created_at,updated_at FROM mutation_attempts WHERE id=?").get(mutation.id);
      expect(database.query("PRAGMA user_version").get()).toEqual({ user_version: 40 });
      expect(readLegacy()).toEqual(mutation);
      const ledger = database.query("SELECT * FROM migrations ORDER BY version").all();
      const upgraded = new StateStore(paths);
      stores.push(upgraded);
      expect(database.query("PRAGMA user_version").get()).toEqual({ user_version: 61 });
      expect(database.query("SELECT * FROM migrations WHERE version<=40 ORDER BY version").all()).toEqual(ledger);
      expect(readLegacy()).toEqual(mutation);
      expect(upgraded.prepareMutation({ kind: mutation.kind, authorityId: mutation.authority_id,
        authorityGeneration: mutation.authority_generation, request, idempotencyKey: mutation.idempotency_key }))
        .toMatchObject({ replay: true, state: "applied", result: receipt });
      expect(database.query("SELECT COUNT(*) AS count FROM session_send_owners").get()).toEqual({ count: 0 });
    } finally { database.close(false); }
  });
test.each(["missing_guard", "missing_owner", "changed_anchor"] as const)("original send ownership refuses current-schema %s before repair and on hot reads", async (kind) => {
    const value = await ownedSendFixture();
    const database = new Database(value.store.paths.database, { strict: true });
    try {
      if (kind === "missing_guard") database.exec("DROP TRIGGER session_send_format_immutable");
      else {
        const name = kind === "missing_owner" ? "session_send_owners_immutable_delete" : "session_send_owner_anchors_immutable_update";
        const guard = (database.query("SELECT sql FROM sqlite_master WHERE name=?").get(name) as { sql: string }).sql;
        database.exec(`DROP TRIGGER ${name}`);
        if (kind === "missing_owner") database.query("DELETE FROM session_send_owners WHERE attempt_id=?").run(value.prepared.owner.attemptId);
        else database.query("UPDATE session_send_owner_anchors SET digest=? WHERE attempt_id=?").run("a".repeat(64), value.prepared.owner.attemptId);
        database.exec(guard);
      }
      expect(() => value.store.readOwnedSessionSend(value.request.idempotencyKey)).toThrow("SESSION_SEND_OWNER_CORRUPT");
      expect(() => new StateStore(value.store.paths, { readonly: true })).toThrow("SESSION_SEND_OWNER_CORRUPT");
      expect(() => new StateStore(value.store.paths)).toThrow("SESSION_SEND_OWNER_CORRUPT");
      if (kind === "missing_guard") expect(database.query("SELECT 1 FROM sqlite_master WHERE name='session_send_format_immutable'").get()).toBeNull();
    } finally { database.close(false); }
  });
test("original send ownership claims one original request without granting an execution lease", async () => {
    const { store } = await fixture();
    const profile = store.createProfile("Owned unavailable source");
    const created = store.createSession({ profileId: profile.id, preset: "high", fastEnabled: false });
    const session = store.bindSession({ sessionId: created.id, expectedRevision: created.revision,
      providerThreadId: "owned-unavailable-thread", state: "idle" });
    const request = { kind: "session.send" as const, session: session.id, message: "exact original input",
      attachments: [], idempotencyKey: randomUUID() };
    const prepared = store.prepareOwnedSessionSend(request);
    expect(prepared.state).toBe("input_required");
    expect(prepared.claim).toBeNull();
    expect(store.prepareOwnedSessionSend(request)).toEqual({ ...prepared, replayed: true });
    expect(() => store.prepareOwnedSessionSend({ ...request, message: "changed input" })).toThrow("SESSION_SEND_REQUEST_CONFLICT");
    expect(() => store.readMutation(request.idempotencyKey)).toThrow("SESSION_SEND_OWNED_API_REQUIRED");
  });
test("retains authentic combined49 unused Devin close, sealed input and runtime history without new execution", async () => {
    const paths = await archivedRetired49();
    // A fresh archived WAL database has no local WAL/SHM files yet. A raw
    // writable handle may initialize them without running any Oompa migration;
    // query_only then keeps the baseline inspector nonmutating.
    const database = new Database(paths.database, { create: false, strict: true });
    database.exec("PRAGMA query_only=ON");
    try {
      const originalHistory = retiredCloseHistory(database);
      expect(database.query("PRAGMA user_version").get()).toEqual({ user_version: 49 });
      expect(database.query("SELECT COUNT(*) AS count FROM devin_joined_close_receipts").get()).toEqual({ count: 1 });
      expect(database.query("SELECT COUNT(*) AS count FROM devin_joined_close_consumptions").get()).toEqual({ count: 0 });
      const store = new StateStore(paths);
      stores.push(store);
      expect(retiredCloseHistory(database)).toEqual(originalHistory);
      const archived = combined49RetiredFixture;
      expect(store.readOwnedSessionSend(archived.owner.request.idempotencyKey)).toEqual(archived.owner.history);
      expect(store.readMutation(archived.login.idempotencyKey)).toEqual(archived.login.originalMutation);
      expect(store.latestSessionRuntimeProfile(archived.close.session.id)).toEqual(archived.close.runtime);
      expect(store.requireCapturedSessionProviderAuthority(archived.close.session.id)).toEqual(archived.close.capturedAuthority);
      expect(store.requireProviderAccountAuthority(archived.close.session.profileId, "devin"))
        .toEqual(archived.close.receipt.retiredAuthority);
      const reader = new StateStore(paths, { readonly: true });
      stores.push(reader);
      expect(reader.latestSessionRuntimeProfile(archived.close.session.id)).toEqual(archived.close.runtime);
      expect(reader.readOwnedSessionSend(archived.owner.request.idempotencyKey)).toEqual(archived.owner.history);
      expect(retiredCloseHistory(database)).toEqual(originalHistory);
    } finally { database.close(false); }
  });
test("retired Devin close receipts never grant a fresh process successor or revive a session at boot", async () => {
    const paths = await archivedRetired49();
    const store = new StateStore(paths);
    stores.push(store);
    const archived = combined49RetiredFixture;
    const database = new Database(paths.database, { readonly: true, strict: true });
    try {
      const originalHistory = retiredCloseHistory(database);
      const originalSession = store.requireSession(archived.close.session.id);
      const originalAuthority = store.requireCapturedSessionProviderAuthority(archived.close.session.id);
      const originalAccount = store.requireProviderAccountAuthority(archived.close.session.profileId, "devin");
      for (const boot of ["e", "f"]) {
        store.nextDaemonGeneration(`boot_${boot.repeat(32)}`);
        // Retirement preserves the historical display state; idle is not
        // current execution authority and cannot consume the old close proof.
        expect(store.requireSession(archived.close.session.id)).toEqual(originalSession);
        expect(store.requireCapturedSessionProviderAuthority(archived.close.session.id)).toEqual(originalAuthority);
        expect(store.requireProviderAccountAuthority(archived.close.session.profileId, "devin")).toEqual(originalAccount);
        expect(retiredCloseHistory(database)).toEqual(originalHistory);
        expect(database.query("SELECT COUNT(*) AS count FROM devin_joined_close_consumptions").get()).toEqual({ count: 0 });
        expect(database.query("SELECT COUNT(*) AS count FROM session_provider_authority_successors WHERE from_provider='devin' OR to_provider='devin'").get()).toEqual({ count: 0 });
        const beforeDispatch = canonicalAuthBudgetSnapshot(database);
        // The old close leaves a stale captured generation, so the exact
        // session-authority fence refuses before generic provider admission.
        expect(() => store.enqueue(archived.close.session.id, "No retired provider dispatch"))
          .toThrow("SESSION_PROVIDER_AUTHORITY_STALE");
        expect(canonicalAuthBudgetSnapshot(database)).toEqual(beforeDispatch);
      }
    } finally { database.close(false); }
  });
test("current Devin admission admits new sessions and queued sends while keeping archived receipts untouched", async () => {
    const paths = await archivedRetired49();
    const store = new StateStore(paths);
    stores.push(store);
    const archived = combined49RetiredFixture;
    const database = new Database(paths.database, { readonly: true, strict: true });
    try {
      const before = retiredCloseHistory(database);
      const loginBefore = store.readMutation(archived.login.idempotencyKey);
      const session = store.createSession({ profileId: archived.owner.history.owner.sourceAuthority.profileId,
        provider: "devin", preset: "astra", fastEnabled: false });
      expect(session.provider).toBe("devin");
      // A fresh Devin login prepares under ordinary authority; the archived
      // login's own attempt and receipts stay untouched.
      expect(store.prepareMutation({ kind: "account.devin-login",
        authorityId: archived.login.originalMutation.authorityId,
        authorityGeneration: archived.login.originalMutation.authorityGeneration,
        idempotencyKey: randomUUID(), request: { provider: "devin" } }))
        .toMatchObject({ state: "prepared", replay: false });
      expect(store.enqueue(archived.owner.history.owner.sessionId, "No retired provider dispatch"))
        .toMatchObject({ sessionId: archived.owner.history.owner.sessionId, state: "pending" });
      expect("prepareDevinJoinedClose" in StateStore.prototype).toBe(false);
      expect("recordDevinJoinedClose" in StateStore.prototype).toBe(false);
      expect(retiredCloseHistory(database)).toEqual(before);
      expect(store.readMutation(archived.login.idempotencyKey)).toEqual(loginBefore);
      expect(store.readOwnedSessionSend(archived.owner.request.idempotencyKey)).toEqual(archived.owner.history);
    } finally { database.close(false); }
  });
test.each(["snapshots", "receipts", "anchors", "guard", "substitution", "anchor_value"] as const)(
    "refuses damaged authentic retired Devin close history without repairing it: %s", async (damage) => {
      const paths = await archivedRetired49();
      const store = new StateStore(paths);
      store.close();
      const database = new Database(paths.database, { create: false, strict: true });
      try {
        const guards = z.array(z.object({ name: z.string(), sql: z.string() }).strict()).parse(database.query(
          "SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name LIKE 'devin_joined_close_%' ORDER BY name",
        ).all());
        database.exec("PRAGMA foreign_keys=OFF");
        database.transaction(() => {
          for (const guard of guards) database.exec(`DROP TRIGGER "${guard.name.replaceAll('"', '""')}"`);
          if (damage === "anchor_value") {
            expect(database.query("UPDATE devin_joined_close_anchors SET digest=? WHERE close_id=? AND kind='joined'")
              .run("0".repeat(64), combined49RetiredFixture.close.capture.closeId).changes).toBe(1);
          } else if (damage === "substitution") {
            expect(database.query("UPDATE devin_joined_close_snapshots SET snapshot_json=json_set(snapshot_json,'$.connectionId',?) WHERE close_id=?")
              .run(randomUUID(), combined49RetiredFixture.close.capture.closeId).changes).toBe(1);
          } else if (damage !== "guard") {
            expect(database.query(`DELETE FROM devin_joined_close_${damage}`).run().changes).toBeGreaterThan(0);
          }
          for (const guard of guards) {
            if (damage !== "guard" || guard.name !== "devin_joined_close_successor_guard") database.exec(guard.sql);
          }
        }).immediate();
        for (const guard of guards) {
          if (damage !== "guard" || guard.name !== "devin_joined_close_successor_guard") {
            expect(database.query("SELECT sql FROM sqlite_master WHERE name=?").get(guard.name)).toEqual({ sql: guard.sql });
          }
        }
        // All-row/schema comparison belongs to the refusal oracle, not to a
        // fabricated predecessor or a regenerated current-schema capture.
        expectInertSchemaRefusal(paths, damage === "guard" ? "STATE_" : "DEVIN_JOINED_CLOSE_CORRUPT");
      } finally { database.close(false); }
    },
  );
test("Devin joined close preserves authentic canonical40 history without manufacturing a close receipt", async () => {
    const paths = await canonical40QueueArchive();
    const session = canonical40QueuesFixture.devin;
    const migrated = new StateStore(paths);
    stores.push(migrated);
    expect(migrated.requireSession(session.id)).toEqual(session);
    expect(() => migrated.requireCapturedSessionProviderAuthority(session.id))
      .toThrow("SESSION_PROVIDER_AUTHORITY_QUARANTINED:missing_immutable_runtime_authority");
    const authority = migrated.requireProviderAccountAuthority(session.profileId, "devin");
    expect(migrated.latestSessionRuntimeProfile(session.id)).toBeNull();
    const inspector = new Database(migrated.paths.database, { readonly: true, strict: true });
    try {
      expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: 61 });
      expect(inspector.query("SELECT COUNT(*) AS count FROM devin_joined_close_intents").get()).toEqual({ count: 0 });
      expect(inspector.query("SELECT COUNT(*) AS count FROM devin_joined_close_receipts").get()).toEqual({ count: 0 });
      expect(inspector.query("SELECT * FROM session_provider_authorities WHERE session_id=?").all(session.id)).toEqual([]);
      expect(inspector.query("SELECT * FROM session_provider_authority_successors WHERE session_id=?").all(session.id)).toEqual([]);
    } finally { inspector.close(false); }
    migrated.nextDaemonGeneration(`boot_${"6".repeat(32)}`);
    expect(migrated.requireSession(session.id)).toEqual(session);
    expect(() => migrated.requireCapturedSessionProviderAuthority(session.id))
      .toThrow("SESSION_PROVIDER_AUTHORITY_QUARANTINED:missing_immutable_runtime_authority");
    expect(migrated.requireProviderAccountAuthority(session.profileId, "devin")).toEqual(authority);
    const afterBoot = new Database(migrated.paths.database, { readonly: true, strict: true });
    try {
      const beforeDispatch = canonicalAuthBudgetSnapshot(afterBoot);
      expect(() => migrated.enqueue(session.id, "No retired provider dispatch"))
        .toThrow("SESSION_PROVIDER_AUTHORITY_QUARANTINED:missing_immutable_runtime_authority");
      expect(canonicalAuthBudgetSnapshot(afterBoot)).toEqual(beforeDispatch);
      expect(afterBoot.query("SELECT * FROM session_provider_authority_successors WHERE session_id=?").all(session.id)).toEqual([]);
      expect(afterBoot.query("SELECT * FROM devin_joined_close_consumptions").all()).toEqual([]);
    } finally { afterBoot.close(false); }
  });
test.each([
    "WORK_SESSION_SWITCH_ATTEMPT_AUTHORITY",
    "WORK_SESSION_SWITCH_ATTEMPT_AUTHORITY_UNEXPECTED",
  ] as const)("maps only the exact Work switch refusal after atomic rollback: %s", async (triggerMessage) => {
    const { store } = await fixture();
    const prepared = prepareDedicatedSessionSwitch(store, 890);
    const originalMutation = store.readMutation(prepared.switch.idempotencyKey);
    const originalSession = store.requireSession(prepared.session.id);
    const database = new Database(store.paths.database, { create: false, strict: true });
    try {
      // Inject the SQLite boundary used by the real Work reverse-authority
      // guard. The service suite covers admission of the actual Work attempt.
      database.exec(`
        CREATE TRIGGER test_work_switch_refusal
        BEFORE UPDATE OF state ON mutation_attempts
        WHEN OLD.id='${prepared.switch.attemptId}'
          AND OLD.state='prepared' AND NEW.state='effect_started'
        BEGIN SELECT RAISE(ABORT,'${triggerMessage}'); END;
      `);
      let failure: unknown;
      try {
        store.beginSessionSwitchTargetStart(prepared.cas);
      } catch (error: unknown) {
        failure = error;
      }
      expect(store.requireSessionSwitch(prepared.switch.attemptId)).toEqual(prepared.switch);
      expect(store.readMutation(prepared.switch.idempotencyKey)).toEqual(originalMutation);
      expect(store.requireSession(prepared.session.id)).toEqual(originalSession);
      if (triggerMessage === "WORK_SESSION_SWITCH_ATTEMPT_AUTHORITY") {
        expect(failure).toBeInstanceOf(SessionSwitchStoreError);
        expect(failure).toMatchObject({
          code: "SESSION_SWITCH_STORAGE_FENCED",
          cause: { message: triggerMessage },
        });
      } else {
        expect(failure).toBeInstanceOf(Error);
        expect(failure).not.toBeInstanceOf(SessionSwitchStoreError);
        expect(failure).toMatchObject({ message: triggerMessage });
      }
      database.exec("DROP TRIGGER test_work_switch_refusal");
      expect(store.beginSessionSwitchTargetStart(prepared.cas).phase).toBe("target_starting");
    } finally {
      database.close(false);
    }
  });
test.each(["low", "high"] as const)("rebinds the exact sealed current switch preset contract for %s", async (targetPreset) => {
    const { store } = await fixture();
    const prepared = prepareDedicatedSessionSwitch(store, targetPreset === "low" ? 894 : 895, { targetPreset });
    const contract = activePresetBinding(targetPreset).contract;
    const database = new Database(store.paths.database, { create: false, strict: true });
    try {
      expect(prepared.switch.targetPresetContract).toBe(contract);
      expect(database.query("SELECT target_preset_contract FROM session_switch_attempts WHERE attempt_id=?")
        .get(prepared.switch.attemptId)).toEqual({ target_preset_contract: 2 });
      expect(database.query("SELECT target_preset_contract FROM session_switch_execution_contexts WHERE attempt_id=?")
        .get(prepared.switch.attemptId)).toEqual({ target_preset_contract: contract });
      const rebound = advanceDedicatedSessionSwitch(store, prepared, "rebound");
      expect(rebound.phase).toBe("rebound");
      expect(rebound.targetPresetContract).toBe(contract);
      expect(store.requireSessionPresetRequirement(prepared.session.id).requirement)
        .toEqual(presetRequirements[targetPreset]);
      expect(store.requireSessionPresetContract(prepared.session.id)).toBe(contract);
      const before = snapshotSwitchContainmentForTest(database);
      for (const readonly of [false, true]) {
        const reopened = new StateStore(store.paths, { readonly });
        stores.push(reopened);
        expect(reopened.requireSessionSwitch(prepared.switch.attemptId)).toEqual(rebound);
        expect(snapshotSwitchContainmentForTest(database)).toEqual(before);
      }
    } finally { database.close(false); }
  });
test("a missing joined contract anchor cannot turn SQL NULL into permission to rebind", async () => {
    const { store } = await fixture();
    const prepared = prepareDedicatedSessionSwitch(store, 896, { targetPreset: "high" });
    advanceDedicatedSessionSwitch(store, prepared, "source_released");
    const database = new Database(store.paths.database, { create: false, strict: true });
    try {
      const guard = z.object({ sql: z.string() }).strict().parse(database.query(
        "SELECT sql FROM sqlite_master WHERE name='session_switch_execution_context_anchors_delete'",
      ).get()).sql;
      database.exec("DROP TRIGGER session_switch_execution_context_anchors_delete");
      // The typed reader first sees a complete context. Remove only its anchor
      // after rebind intent is written, so the session SQL guard itself must
      // refuse the missing proof and roll the complete transaction back.
      database.exec(`CREATE TRIGGER test_switch_contract_anchor_loss
        AFTER INSERT ON session_switch_rebind_receipts
        WHEN NEW.attempt_id='${prepared.switch.attemptId}'
        BEGIN DELETE FROM session_switch_execution_context_anchors WHERE attempt_id=NEW.attempt_id; END;`);
      const before = snapshotSwitchContainmentForTest(database);
      expect(() => store.rebindSessionSwitch(prepared.cas)).toThrow("session switch blocks session mutation");
      expect(snapshotSwitchContainmentForTest(database)).toEqual(before);
      database.exec("DROP TRIGGER test_switch_contract_anchor_loss");
      database.exec(guard);
      expect(store.rebindSessionSwitch(prepared.cas).phase).toBe("rebound");
    } finally { database.close(false); }
  });
test("a provider switch preserves an existing exact host capability binding byte for byte", async () => {
    const { store } = await fixture();
    const prepared = prepareDedicatedSessionSwitch(store, 897, { targetPreset: "high" });
    const binding = store.bindSessionHostCapabilities({ sessionId: prepared.session.id, ...testSwitchHostCapabilities });
    const database = new Database(store.paths.database, { create: false, strict: true });
    try {
      const before = database.query("SELECT * FROM session_host_capability_bindings WHERE session_id=?")
        .get(prepared.session.id);
      expect(advanceDedicatedSessionSwitch(store, prepared, "rebound").phase).toBe("rebound");
      expect(store.requireSessionHostCapabilityBinding(prepared.session.id)).toEqual(binding);
      expect(database.query("SELECT * FROM session_host_capability_bindings WHERE session_id=?")
        .get(prepared.session.id)).toEqual(before);
      expect(() => database.query("DELETE FROM session_host_capability_bindings WHERE session_id=?")
        .run(prepared.session.id)).toThrow("session host capability binding is immutable");
    } finally { database.close(false); }
  });
test.each([
    { preambleVersion: 2 }, { preambleDigest: "c".repeat(64) },
    { manifestVersion: 2 }, { manifestDigest: "c".repeat(64) },
  ])("a conflicting host capability binding refuses target dispatch without rewriting authority: %j", async (change) => {
    const { store } = await fixture();
    const prepared = prepareDedicatedSessionSwitch(store, 898);
    store.bindSessionHostCapabilities({ sessionId: prepared.session.id, ...testSwitchHostCapabilities, ...change });
    const database = new Database(store.paths.database, { create: false, strict: true });
    try {
      const before = snapshotSwitchContainmentForTest(database);
      expect(() => store.beginSessionSwitchTargetStart(prepared.cas)).toThrow("SESSION_SWITCH_REQUEST_CONFLICT");
      expect(snapshotSwitchContainmentForTest(database)).toEqual(before);
      expect(store.requireSessionSwitch(prepared.switch.attemptId).phase).toBe("prepared");
    } finally { database.close(false); }
  });
test.each([
    { preambleVersion: 2 }, { preambleDigest: "c".repeat(64) },
    { manifestVersion: 2 }, { manifestDigest: "c".repeat(64) },
  ])("a conflicting host binding admitted after source release refuses rebind without writes: %j", async (change) => {
    const { store } = await fixture();
    const prepared = prepareDedicatedSessionSwitch(store, 899);
    expect(store.readSessionHostCapabilityBinding(prepared.session.id)).toBeNull();
    const released = advanceDedicatedSessionSwitch(store, prepared, "source_released");
    expect(released.phase).toBe("source_released");
    // This source has no host-capability binding. First adoption through
    // the public API after source release must not rewrite the switch's
    // already-sealed target capability contract or authorize rebind.
    const binding = store.bindSessionHostCapabilities({
      sessionId: prepared.session.id, ...testSwitchHostCapabilities, ...change,
    });
    const database = new Database(store.paths.database, { create: false, strict: true });
    try {
      const before = snapshotSwitchContainmentForTest(database);
      expect(() => store.rebindSessionSwitch(prepared.cas)).toThrow("SESSION_SWITCH_REQUEST_CONFLICT");
      expect(snapshotSwitchContainmentForTest(database)).toEqual(before);
      expect(store.requireSessionSwitch(prepared.switch.attemptId)).toEqual(released);
      expect(store.requireSessionHostCapabilityBinding(prepared.session.id)).toEqual(binding);
    } finally { database.close(false); }
  });
test("rejects an unverified Claude switch target and requires the fresh signed-in binding", async () => {
    const { store } = await fixture();
    const baseline = prepareDedicatedSessionSwitch(store, 780);
    store.cancelPreparedSessionSwitch(baseline.cas);
    const targetAuthority = store.advanceProviderAccountProcessGeneration({
      profileId: baseline.targetProfile.id, provider: "claude", expectedProcessGeneration: 0,
    });
    const input = {
      idempotencyKey: "20000000-0000-4000-8000-000000000781",
      rawRequest: { version: 2, session: baseline.session.id, provider: "claude",
        account: baseline.targetProfile.id, preset: "fable-max", presetContract: null },
      sessionId: baseline.session.id,
      sourceAuthority: baseline.cas.sourceAuthority,
      targetAuthority,
      expectedSessionRevision: baseline.cas.originalSessionRevision,
      expectedAuthorityRevision: baseline.cas.originalAuthorityRevision,
      sourcePreset: baseline.switch.sourcePreset,
      sourcePresetContract: baseline.switch.sourcePresetContract,
      targetPreset: "fable-max",
      targetAccountKey: testProviderAccountKey("claude"),
      targetHostCapabilities: testSwitchHostCapabilities,
      targetPresetContract: activePresetBinding("fable-max").contract,
      sourceRuntimeProfileRevision: baseline.switch.sourceRuntimeProfileRevision,
      transcript: baseline.switch.transcript,
    } as const;
    expect(() => store.prepareSessionSwitch(input)).toThrow("SESSION_SWITCH_TARGET_AUTHORITY_STALE");
    expect(store.readMutation(input.idempotencyKey)).toBeNull();
    store.observeProviderAccountReadiness({
      expectedBindingGeneration: targetAuthority.bindingGeneration,
      profileId: targetAuthority.profileId, provider: "claude", readiness: "signed_in", observedAt: 5_000,
    });
    expect(() => store.prepareSessionSwitch(input)).toThrow("SESSION_SWITCH_TARGET_AUTHORITY_STALE");
    const fresh = store.prepareSessionSwitch({ ...input,
      targetAuthority: store.requireProviderAccountAuthority(targetAuthority.profileId, "claude"),
    });
    expect(fresh.status).toBe("prepared");
    expect(fresh.switch.targetPresetContract).toBe(currentPresetContract);
  });
test("journals a provider switch through accepted seed settlement and replays its immutable receipt", async () => {
    const { store } = await fixture();
    const prepared = prepareDedicatedSessionSwitch(store, 701);
    expect(prepared.status).toBe("prepared");
    expect(prepared.switch.sourcePresetContract).toBe(currentPresetContract);
    expect(store.latestSessionRuntimeProfile(prepared.session.id)?.profile.model).toBe("gpt-6-astra");
    expect(prepared.switch.targetPresetContract).toBe(currentPresetContract);
    expect(store.prepareSessionSwitch({
      targetAccountKey: prepared.targetAccountKey,
      targetHostCapabilities: testSwitchHostCapabilities,
      idempotencyKey: prepared.switch.idempotencyKey,
      rawRequest: prepared.switch.rawRequest,
      sessionId: prepared.switch.sessionId,
      sourceAuthority: prepared.cas.sourceAuthority,
      targetAuthority: prepared.cas.targetAuthority,
      expectedSessionRevision: prepared.cas.originalSessionRevision,
      expectedAuthorityRevision: prepared.cas.originalAuthorityRevision,
      sourcePreset: prepared.switch.sourcePreset,
      sourcePresetContract: prepared.switch.sourcePresetContract,
      targetPreset: prepared.switch.targetPreset,
      targetPresetContract: prepared.switch.targetPresetContract,
      sourceRuntimeProfileRevision: prepared.switch.sourceRuntimeProfileRevision,
      transcript: prepared.switch.transcript,
    })).toMatchObject({ status: "replayed", switch: { attemptId: prepared.switch.attemptId } });

    const dispatching = advanceDedicatedSessionSwitch(store, prepared, "seed_dispatching");
    const seedAuthority = store.requireSessionProviderAuthority(prepared.session.id);
    const receiptInput = {
      domain: "hra:session-switch-seed-accepted:v1",
      turnId: "seed-turn-701",
      turnStatus: "completed",
      runtimeProfile: prepared.targetRuntime,
    } as const;
    const direct = new Database(store.paths.database, { create: false, strict: true });
    try {
      const forgedReceipt = {
        session: { ...store.requireSession(prepared.session.id), id: "session_wrong_receipt" },
        from: {
          provider: prepared.cas.sourceAuthority.provider,
          preset: prepared.switch.sourcePreset,
          account: prepared.cas.sourceAuthority.profileId,
        },
        to: {
          provider: prepared.cas.targetAuthority.provider,
          preset: prepared.switch.targetPreset,
          account: prepared.cas.targetAuthority.profileId,
        },
        seed: {
          delivered: true,
          digest: prepared.switch.transcript.seedDigest,
          includedRecords: prepared.switch.transcript.seedIncludedRecords,
          omittedRecords: prepared.switch.transcript.seedOmittedRecords,
        },
        transcriptDigest: prepared.switch.transcript.transcriptDigest,
        turnId: receiptInput.turnId,
        idempotencyKey: prepared.switch.idempotencyKey,
      };
      expect(() => direct.query(
        `INSERT INTO session_switch_seed_receipts(
           attempt_id,outcome,failure_code,turn_id,turn_status,
           runtime_profile_revision,receipt_digest,public_receipt_json,recorded_at
         ) VALUES (?,'accepted',NULL,?,'completed',1,?,?,50000)`,
      ).run(
        prepared.switch.attemptId,
        receiptInput.turnId,
        sessionSwitchDigest(receiptInput),
        JSON.stringify(forgedReceipt),
      )).toThrow("session switch seed receipt mismatch");
    } finally {
      direct.close(false);
    }
    expect(() => store.completeSessionSwitchSeed({
      ...prepared.cas,
      seedAuthority: prepared.cas.targetAuthority,
      seedAuthorityRevision: seedAuthority.authorityRevision,
      settlement: {
        outcome: "accepted",
        turnId: receiptInput.turnId,
        turnStatus: receiptInput.turnStatus,
        runtimeProfile: receiptInput.runtimeProfile,
        receiptDigest: "f".repeat(64),
        seedText: prepared.seedText,
      },
    })).toThrow("SESSION_SWITCH_REQUEST_CONFLICT");
    expect(store.requireSessionSwitch(dispatching.attemptId).phase).toBe("seed_dispatching");

    const eventsBeforeSettlement = store.listSessionEvents({
      sessionId: prepared.session.id,
      afterSequence: 0,
    }).events;
    for (const body of [
      { type: "warning", code: "LATE_CALLBACK", message: "Must remain fenced" },
      {
        type: "user_message",
        turnId: publicProviderIdentifier(receiptInput.turnId),
        actor: "human",
        text: prepared.seedText,
        omittedCharacters: 0,
      },
      {
        type: "user_message",
        turnId: publicProviderIdentifier("wrong-seed-turn"),
        actor: "provider_switch",
        text: prepared.seedText,
        omittedCharacters: 0,
      },
      {
        type: "user_message",
        turnId: publicProviderIdentifier(receiptInput.turnId),
        actor: "provider_switch",
        text: "Forged seed contents",
        omittedCharacters: 0,
      },
      {
        type: "user_message",
        turnId: publicProviderIdentifier(receiptInput.turnId),
        actor: "provider_switch",
        text: prepared.seedText,
        omittedCharacters: 0,
      },
    ] as const) {
      expect(() => store.appendSessionEvent({
        sessionId: prepared.session.id,
        accountId: prepared.cas.targetAuthority.profileId,
        providerGeneration: prepared.cas.targetAuthority.processGeneration,
        providerAuthority: prepared.cas.targetAuthority,
        providerConnectionId: null,
        body,
      })).toThrow("session switch blocks callback event admission");
    }
    expect(store.listSessionEvents({
      sessionId: prepared.session.id,
      afterSequence: 0,
    }).events).toEqual(eventsBeforeSettlement);

    const settled = store.completeSessionSwitchSeed({
      ...prepared.cas,
      seedAuthority: prepared.cas.targetAuthority,
      seedAuthorityRevision: seedAuthority.authorityRevision,
      settlement: {
        outcome: "accepted",
        turnId: receiptInput.turnId,
        turnStatus: receiptInput.turnStatus,
        runtimeProfile: receiptInput.runtimeProfile,
        receiptDigest: sessionSwitchDigest(receiptInput),
        seedText: prepared.seedText,
      },
    });
    expect(settled).toMatchObject({
      phase: "seed_settled",
      seed: {
        outcome: "accepted",
        turnId: "seed-turn-701",
        publicReceipt: {
          idempotencyKey: prepared.switch.idempotencyKey,
          seed: { delivered: true },
        },
      },
    });
    const immutablePublicReceipt = JSON.stringify(settled.seed?.publicReceipt);
    expect(() => store.transitionMutation(
      prepared.switch.attemptId,
      "applied",
      "applied",
      { forged: "replacement receipt" },
    )).toThrow("SESSION_SWITCH_STORAGE_FENCED");
    const replayed = store.readSessionSwitchByIdempotencyKey(
      prepared.switch.idempotencyKey,
    );
    expect(JSON.stringify(replayed?.seed?.publicReceipt)).toBe(immutablePublicReceipt);
    expect(store.requireSession(prepared.session.id)).toMatchObject({
      profileId: prepared.targetProfile.id,
      providerThreadId: prepared.targetThreadId,
      preset: "low",
      state: "idle",
    });
    const events = store.listSessionEvents({
      sessionId: prepared.session.id,
      afterSequence: 0,
    }).events;
    expect(events.filter((event) => event.body.type === "provider_switched")).toHaveLength(1);
    expect(events.filter((event) =>
      event.body.type === "user_message" && event.body.actor === "provider_switch"))
      .toHaveLength(1);
    const inspector = new Database(store.paths.database, { create: false, strict: true });
    try {
      const journal = inspector.query(
        `SELECT raw_request_json,runtime_profile_json,public_receipt_json
         FROM session_switch_attempts switch
         LEFT JOIN session_switch_target_start_receipts target USING(attempt_id)
         LEFT JOIN session_switch_seed_receipts seed USING(attempt_id)
         WHERE switch.attempt_id=?`,
      ).get(prepared.switch.attemptId) as Record<string, string>;
      expect(JSON.stringify(journal)).not.toContain(prepared.seedText);
      expect(JSON.stringify(journal)).not.toContain("Provider switch seed");
    } finally {
      inspector.close(false);
    }
  });
test("rejects raw near-miss seed events while accepted settlement custody is live", async () => {
    const { store } = await fixture();
    const prepared = prepareDedicatedSessionSwitch(store, 763);
    advanceDedicatedSessionSwitch(store, prepared, "seed_dispatching");
    const authority = store.requireCapturedSessionProviderAuthority(prepared.session.id);
    const eventsBefore = store.listSessionEvents({
      sessionId: prepared.session.id,
      afterSequence: 0,
    }).events;
    const settle = () => store.completeSessionSwitchSeed({
      ...prepared.cas,
      seedAuthority: prepared.cas.targetAuthority,
      seedAuthorityRevision: authority.authorityRevision,
      settlement: {
        outcome: "accepted",
        turnId: "seed-turn-763",
        turnStatus: "completed",
        runtimeProfile: prepared.targetRuntime,
        receiptDigest: sessionSwitchDigest({
          domain: "hra:session-switch-seed-accepted:v1",
          turnId: "seed-turn-763",
          turnStatus: "completed",
          runtimeProfile: prepared.targetRuntime,
        }),
        seedText: prepared.seedText,
      },
    });
    const injectedText = "json_set(NEW.event_json,'$.body.text','Injected seed callback')";
    const probes = [
      {
        eventJson: `json_remove(${injectedText},'$.body.actor')`,
        sequence: "NEW.sequence",
        accountId: "NEW.account_id",
        refusal: "session switch blocks callback event admission",
      },
      {
        eventJson: `json_set(${injectedText},'$.body.actor','human')`,
        sequence: "NEW.sequence",
        accountId: "NEW.account_id",
        refusal: "session switch blocks callback event admission",
      },
      {
        eventJson: `json_set(${injectedText},'$.sequence',NEW.sequence+1)`,
        sequence: "NEW.sequence+1",
        accountId: "NEW.account_id",
        refusal: "session switch blocks callback event admission",
      },
      {
        eventJson: `json_set(${injectedText},'$.accountId','${prepared.sourceProfile.id}')`,
        sequence: "NEW.sequence",
        accountId: `'${prepared.sourceProfile.id}'`,
        refusal: "JOINED_EVIDENCE_BOUNDARY_REFUSED",
      },
    ];
    const database = new Database(store.paths.database, { create: false, strict: true });
    try {
      const beforeSettlement = canonicalAuthBudgetSnapshot(database);
      for (const probe of probes) {
        database.exec(`
          CREATE TRIGGER session_switch_test_seed_callback BEFORE INSERT ON session_events
          WHEN NEW.session_id='${prepared.session.id}'
            AND json_extract(NEW.event_json,'$.body.text')='Provider switch seed 763'
          BEGIN
            INSERT INTO session_events(
              session_id,stream_epoch,sequence,recorded_at,account_id,
              provider_generation,provider_connection_id,event_json,event_bytes,projection_version
            ) VALUES (
              NEW.session_id,NEW.stream_epoch,${probe.sequence},NEW.recorded_at,${probe.accountId},
              NEW.provider_generation,NEW.provider_connection_id,${probe.eventJson},
              length(CAST(${probe.eventJson} AS BLOB)),NEW.projection_version
            );
          END;
        `);
        try {
          expect(settle).toThrow(probe.refusal);
        } finally {
          database.exec("DROP TRIGGER session_switch_test_seed_callback");
        }
        expect(store.requireSessionSwitch(prepared.switch.attemptId).phase).toBe("seed_dispatching");
        expect(store.listSessionEvents({
          sessionId: prepared.session.id,
          afterSequence: 0,
        }).events).toEqual(eventsBefore);
        expect(canonicalAuthBudgetSnapshot(database)).toEqual(beforeSettlement);
      }
    } finally {
      database.close(false);
    }
    expect(settle().phase).toBe("seed_settled");
    const messages = store.listSessionEvents({
      sessionId: prepared.session.id,
      afterSequence: 0,
    }).events.filter((event) => event.body.type === "user_message");
    expect(messages).toHaveLength(1);
    expect(messages[0]?.body).toMatchObject({ actor: "provider_switch", text: prepared.seedText });
  });
test("accepts only canonical no-effect and rejected-seed receipts", async () => {
    const { store } = await fixture();
    const noEffect = prepareDedicatedSessionSwitch(store, 708);
    store.beginSessionSwitchTargetStart(noEffect.cas);
    expect(store.failSessionSwitchTargetStartNoEffect({
      ...noEffect.cas,
      expectedPhase: "target_starting",
      diagnosticCode: "TARGET_START_REJECTED",
    }).phase).toBe("failed");

    const rejected = prepareDedicatedSessionSwitch(store, 709);
    advanceDedicatedSessionSwitch(store, rejected, "seed_dispatching");
    const seedAuthority = store.requireSessionProviderAuthority(rejected.session.id);
    expect(() => store.completeSessionSwitchSeed({
      ...rejected.cas,
      seedAuthority: rejected.cas.targetAuthority,
      seedAuthorityRevision: seedAuthority.authorityRevision,
      settlement: {
        outcome: "rejected",
        failureCode: "SEED_REJECTED",
        receiptDigest: createHash("sha256")
          .update("hra:session-switch-seed-rejected:v1\0DIFFERENT_REJECTION")
          .digest("hex"),
      },
    })).toThrow("SESSION_SWITCH_REQUEST_CONFLICT");
    expect(store.requireSessionSwitch(rejected.switch.attemptId).phase).toBe("seed_dispatching");
    const rejectedDigest = createHash("sha256")
      .update("hra:session-switch-seed-rejected:v1\0SEED_REJECTED")
      .digest("hex");
    const settled = store.completeSessionSwitchSeed({
      ...rejected.cas,
      seedAuthority: rejected.cas.targetAuthority,
      seedAuthorityRevision: seedAuthority.authorityRevision,
      settlement: {
        outcome: "rejected",
        failureCode: "SEED_REJECTED",
        receiptDigest: rejectedDigest,
      },
    });
    expect(settled).toMatchObject({
      phase: "seed_settled",
      seed: { outcome: "rejected", failureCode: "SEED_REJECTED" },
    });
    expect(store.listSessionEvents({
      sessionId: rejected.session.id,
      afterSequence: 0,
    }).events.filter((event) =>
      event.body.type === "user_message" && event.body.actor === "provider_switch"))
      .toEqual([]);

    const stale = prepareDedicatedSessionSwitch(store, 712);
    advanceDedicatedSessionSwitch(store, stale, "seed_dispatching");
    const staleSeedAuthority = store.requireSessionProviderAuthority(stale.session.id);
    store.advanceProviderAccountProcessGeneration({
      profileId: stale.targetProfile.id,
      provider: "codex",
      expectedProcessGeneration: stale.cas.targetAuthority.processGeneration,
    });
    expect(() => store.completeSessionSwitchSeed({
      ...stale.cas,
      seedAuthority: stale.cas.targetAuthority,
      seedAuthorityRevision: staleSeedAuthority.authorityRevision,
      settlement: {
        outcome: "rejected",
        failureCode: "SEED_REJECTED",
        receiptDigest: rejectedDigest,
      },
    })).toThrow("SESSION_SWITCH_SEED_AUTHORITY_UNPROVED");
    expect(store.requireSessionSwitch(stale.switch.attemptId).phase).toBe("seed_dispatching");
  });
test("admits only contiguous explicit same-binding seed successor lineage", async () => {
    const { store } = await fixture();
    const prepared = prepareDedicatedSessionSwitch(store, 715);
    advanceDedicatedSessionSwitch(store, prepared, "rebound");
    const previous = store.requireSessionProviderAuthority(prepared.session.id);
    const successorAuthority = store.advanceProviderAccountProcessGeneration({
      profileId: prepared.targetProfile.id,
      provider: "codex",
      expectedProcessGeneration: prepared.cas.targetAuthority.processGeneration,
    });
    expect(() => store.beginSessionSwitchSeedDispatch({
      ...prepared.cas,
      seedAuthority: successorAuthority,
      seedAuthorityRevision: previous.authorityRevision + 1,
      seedDigest: prepared.switch.transcript.seedDigest,
      clientMessageId: prepared.switch.transcript.seedClientMessageId,
    })).toThrow("SESSION_SWITCH_SEED_AUTHORITY_UNPROVED");

    const successor = installSessionAuthoritySuccessorForTest(
      store,
      prepared,
      successorAuthority,
    );
    const interactionId = "30000000-0000-4000-8000-000000000719";
    store.admitInteraction({
      publicId: interactionId,
      sessionId: null,
      authority: {
        ...successorAuthority,
        connectionId: "30000000-0000-4000-8000-000000000720",
        requestId: { type: "string", value: "successor-interaction" },
        method: "item/commandExecution/requestApproval",
        requestDigest: "d".repeat(64),
        threadId: prepared.targetThreadId,
        turnId: "successor-turn",
        itemId: "successor-item",
        approvalId: null,
      },
      kind: "command_approval",
      blocking: true,
      display: {
        kind: "command_approval",
        summary: "Interaction under proved successor authority",
        reason: null,
        commandClass: "test",
        workingDirectory: null,
        availableDecisions: ["once", "session", "decline", "cancel"],
      },
    });
    const dispatching = store.beginSessionSwitchSeedDispatch({
      ...prepared.cas,
      seedAuthority: successorAuthority,
      seedAuthorityRevision: successor.authorityRevision,
      seedDigest: prepared.switch.transcript.seedDigest,
      clientMessageId: prepared.switch.transcript.seedClientMessageId,
    });
    expect(dispatching.seedAuthority).toMatchObject({
      authority: successorAuthority,
      provenance: "successor_lineage",
    });
    expect(() => store.prepareInteractionResponse({
      id: interactionId,
      expectedRevision: 1,
      responseDigest: "e".repeat(64),
    })).toThrow("session switch blocks seed interaction transition");
    store.markSessionSwitchReconciliationRequired({
      ...prepared.cas,
      expectedPhase: "seed_dispatching",
      diagnosticCode: "SEED_DISPATCH_OUTCOME_UNKNOWN",
    });
    const quarantined = store.requireSession(prepared.session.id);
    const abandoned = store.abandonReconciledSessionSwitch({
      ...prepared.cas,
      expectedSessionRevision: quarantined.revision,
      expectedSessionAuthority: successorAuthority,
      expectedSessionAuthorityRevision: successor.authorityRevision,
    });
    expect(abandoned.interactions).toEqual([
      expect.objectContaining({ publicId: interactionId, state: "expired" }),
    ]);

    const wrongRouting = prepareDedicatedSessionSwitch(store, 716);
    advanceDedicatedSessionSwitch(store, wrongRouting, "rebound");
    const wrongRoutingAuthority = store.advanceProviderAccountProcessGeneration({
      profileId: wrongRouting.targetProfile.id,
      provider: "codex",
      expectedProcessGeneration: wrongRouting.cas.targetAuthority.processGeneration,
    });
    const wrongRoutingCaptured = installSessionAuthoritySuccessorForTest(
      store,
      wrongRouting,
      wrongRoutingAuthority,
      "managed",
    );
    expect(() => store.beginSessionSwitchSeedDispatch({
      ...wrongRouting.cas,
      seedAuthority: wrongRoutingAuthority,
      seedAuthorityRevision: wrongRoutingCaptured.authorityRevision,
      seedDigest: wrongRouting.switch.transcript.seedDigest,
      clientMessageId: wrongRouting.switch.transcript.seedClientMessageId,
    })).toThrow("SESSION_SWITCH_SEED_AUTHORITY_UNPROVED");

    const wrongBinding = prepareDedicatedSessionSwitch(store, 717);
    advanceDedicatedSessionSwitch(store, wrongBinding, "rebound");
    const database = new Database(store.paths.database, { create: false, strict: true });
    try {
      const changed = database.query(
        `UPDATE provider_accounts
         SET binding_generation=binding_generation+1,provider_email=?,updated_at=MAX(updated_at,?)
         WHERE id=? AND binding_generation=?`,
      ).run(
        "changed-binding@example.com",
        9_100,
        wrongBinding.cas.targetAuthority.providerAccountId,
        wrongBinding.cas.targetAuthority.bindingGeneration,
      );
      expect(changed.changes).toBe(1);
    } finally {
      database.close(false);
    }
    const wrongBindingAuthority = store.requireProviderAccountAuthority(
      wrongBinding.targetProfile.id,
      "codex",
    );
    const wrongBindingCaptured = installSessionAuthoritySuccessorForTest(
      store,
      wrongBinding,
      wrongBindingAuthority,
    );
    expect(() => store.beginSessionSwitchSeedDispatch({
      ...wrongBinding.cas,
      seedAuthority: wrongBindingAuthority,
      seedAuthorityRevision: wrongBindingCaptured.authorityRevision,
      seedDigest: wrongBinding.switch.transcript.seedDigest,
      clientMessageId: wrongBinding.switch.transcript.seedClientMessageId,
    })).toThrow("SESSION_SWITCH_SEED_AUTHORITY_UNPROVED");
  });
test("keeps exact seed-successor interactions under dedicated restart custody", async () => {
    const { store } = await fixture();
    const prepared = prepareDedicatedSessionSwitch(store, 728);
    advanceDedicatedSessionSwitch(store, prepared, "rebound");
    const successorAuthority = store.advanceProviderAccountProcessGeneration({
      profileId: prepared.targetProfile.id,
      provider: "codex",
      expectedProcessGeneration: prepared.cas.targetAuthority.processGeneration,
    });
    const successor = installSessionAuthoritySuccessorForTest(
      store,
      prepared,
      successorAuthority,
    );
    const admit = (
      publicId: string,
      connectionId: string,
      requestId: string,
      threadId: string,
      authority: ReturnType<StateStore["requireProviderAccountAuthority"]>,
    ) => store.admitInteraction({
      publicId,
      sessionId: null,
      authority: {
        ...authority,
        connectionId,
        requestId: { type: "string", value: requestId },
        method: "item/commandExecution/requestApproval",
        requestDigest: createHash("sha256").update(requestId).digest("hex"),
        threadId,
        turnId: `${requestId}-turn`,
        itemId: `${requestId}-item`,
        approvalId: null,
      },
      kind: "command_approval",
      blocking: true,
      display: {
        kind: "command_approval",
        summary: requestId,
        reason: null,
        commandClass: "test",
        workingDirectory: null,
        availableDecisions: ["once", "session", "decline", "cancel"],
      },
    });
    const dedicatedInteractionId = "30000000-0000-4000-8000-000000000728";
    admit(
      dedicatedInteractionId,
      "30000000-0000-4000-8000-000000000729",
      "dedicated-seed-successor",
      prepared.targetThreadId,
      successorAuthority,
    );
    store.beginSessionSwitchSeedDispatch({
      ...prepared.cas,
      seedAuthority: successorAuthority,
      seedAuthorityRevision: successor.authorityRevision,
      seedDigest: prepared.switch.transcript.seedDigest,
      clientMessageId: prepared.switch.transcript.seedClientMessageId,
    });

    const unrelatedInteractionId = "30000000-0000-4000-8000-000000000730";
    admit(
      unrelatedInteractionId,
      "30000000-0000-4000-8000-000000000731",
      "unrelated-successor-thread",
      "unrelated-thread-728",
      successorAuthority,
    );
    const otherProfile = signInProfile(
      store,
      "Restart cross-authority",
      "restart-cross-authority@example.com",
    );
    const otherAuthority = store.requireProviderAccountAuthority(otherProfile.id, "codex");
    const crossAuthorityInteractionId = "30000000-0000-4000-8000-000000000732";
    admit(
      crossAuthorityInteractionId,
      "30000000-0000-4000-8000-000000000733",
      "same-thread-cross-authority",
      prepared.targetThreadId,
      otherAuthority,
    );

    expect(store.nextDaemonGeneration("seed-successor-restart")).toBe(1);
    expect(store.requireSessionSwitch(prepared.switch.attemptId)).toMatchObject({
      phase: "reconciliation_required",
      diagnosticCode: "DAEMON_RESTART_AUTHORITY_RETIRED",
    });
    expect(store.requireInteraction(dedicatedInteractionId)).toMatchObject({
      state: "pending",
      revision: 1,
    });
    expect(store.requireInteraction(unrelatedInteractionId)).toMatchObject({
      state: "expired",
      revision: 2,
    });
    expect(store.requireInteraction(crossAuthorityInteractionId)).toMatchObject({
      state: "expired",
      revision: 2,
    });
  });
test("fails closed when immutable switch evidence is tampered on disk", async () => {
    const first = await fixture();
    const noEffect = prepareDedicatedSessionSwitch(first.store, 718);
    first.store.beginSessionSwitchTargetStart(noEffect.cas);
    const diagnosticCode = "TARGET_START_REJECTED";
    first.store.failSessionSwitchTargetStartNoEffect({
      ...noEffect.cas,
      expectedPhase: "target_starting",
      diagnosticCode,
    });
    const firstDatabase = new Database(first.store.paths.database, {
      create: false,
      strict: true,
    });
    try {
      firstDatabase.exec("DROP TRIGGER session_switch_no_effect_receipts_immutable_update");
      firstDatabase.query(
        "UPDATE session_switch_no_effect_receipts SET evidence_digest=? WHERE attempt_id=?",
      ).run("f".repeat(64), noEffect.switch.attemptId);
    } finally {
      firstDatabase.close(false);
    }
    expect(() => first.store.requireSessionSwitch(noEffect.switch.attemptId))
      .toThrow("SESSION_SWITCH_RECOVERY_CORRUPT");

    const second = await fixture();
    const rejected = prepareDedicatedSessionSwitch(second.store, 719);
    advanceDedicatedSessionSwitch(second.store, rejected, "seed_dispatching");
    const seedAuthority = second.store.requireSessionProviderAuthority(rejected.session.id);
    const failureCode = "SEED_REJECTED";
    second.store.completeSessionSwitchSeed({
      ...rejected.cas,
      seedAuthority: rejected.cas.targetAuthority,
      seedAuthorityRevision: seedAuthority.authorityRevision,
      settlement: {
        outcome: "rejected",
        failureCode,
        receiptDigest: createHash("sha256")
          .update(`hra:session-switch-seed-rejected:v1\0${failureCode}`)
          .digest("hex"),
      },
    });
    const secondDatabase = new Database(second.store.paths.database, {
      create: false,
      strict: true,
    });
    try {
      secondDatabase.exec("DROP TRIGGER session_switch_seed_receipts_immutable_update");
      secondDatabase.query(
        `UPDATE session_switch_seed_receipts
         SET public_receipt_json=' '||public_receipt_json WHERE attempt_id=?`,
      ).run(rejected.switch.attemptId);
    } finally {
      secondDatabase.close(false);
    }
    expect(() => second.store.requireSessionSwitch(rejected.switch.attemptId))
      .toThrow("SESSION_SWITCH_RECOVERY_CORRUPT");
  });
test("rejects altered source-release evidence before it can authorize rebind", async () => {
    const { store } = await fixture();
    const prepared = prepareDedicatedSessionSwitch(store, 752);
    advanceDedicatedSessionSwitch(store, prepared, "source_released");
    const before = store.requireSession(prepared.session.id);
    const eventsBefore = store.listSessionEvents({
      sessionId: prepared.session.id,
      afterSequence: 0,
    }).events;
    const database = new Database(store.paths.database, { create: false, strict: true });
    try {
      database.exec("DROP TRIGGER session_switch_source_release_receipts_immutable_update");
      database.query(
        `UPDATE session_switch_source_release_receipts
         SET status='already_released' WHERE attempt_id=?`,
      ).run(prepared.switch.attemptId);
    } finally {
      database.close(false);
    }
    expect(() => store.requireSessionSwitch(prepared.switch.attemptId))
      .toThrow("SESSION_SWITCH_RECOVERY_CORRUPT");
    expect(() => store.rebindSessionSwitch(prepared.cas))
      .toThrow("SESSION_SWITCH_RECOVERY_CORRUPT");
    expect(store.requireSession(prepared.session.id)).toEqual(before);
    expect(store.listSessionEvents({
      sessionId: prepared.session.id,
      afterSequence: 0,
    }).events).toEqual(eventsBefore);
  });
test("rejects a no-effect receipt with altered time despite a matching inline digest", async () => {
    const { store } = await fixture();
    const prepared = prepareDedicatedSessionSwitch(store, 753);
    advanceDedicatedSessionSwitch(store, prepared, "target_starting");
    store.failSessionSwitchTargetStartNoEffect({
      ...prepared.cas,
      expectedPhase: "target_starting",
      diagnosticCode: "TARGET_START_REJECTED",
    });
    const before = store.requireSession(prepared.session.id);
    const database = new Database(store.paths.database, { create: false, strict: true });
    try {
      database.exec("DROP TRIGGER session_switch_no_effect_receipts_immutable_update");
      database.query(
        `UPDATE session_switch_no_effect_receipts
         SET recorded_at=recorded_at+1 WHERE attempt_id=?`,
      ).run(prepared.switch.attemptId);
    } finally {
      database.close(false);
    }
    expect(() => store.requireSessionSwitch(prepared.switch.attemptId))
      .toThrow("SESSION_SWITCH_RECOVERY_CORRUPT");
    expect(() => store.readSessionSwitchByIdempotencyKey(prepared.switch.idempotencyKey))
      .toThrow("SESSION_SWITCH_RECOVERY_CORRUPT");
    expect(store.requireSession(prepared.session.id)).toEqual(before);
  });
test("rejects altered reconciliation evidence before it can authorize abandonment", async () => {
    const { store } = await fixture();
    const prepared = prepareDedicatedSessionSwitch(store, 754);
    advanceDedicatedSessionSwitch(store, prepared, "target_started");
    store.markSessionSwitchReconciliationRequired({
      ...prepared.cas,
      expectedPhase: "target_started",
      diagnosticCode: "TARGET_STATE_UNEXPECTED",
    });
    const before = store.requireSession(prepared.session.id);
    const authority = store.requireCapturedSessionProviderAuthority(prepared.session.id);
    const database = new Database(store.paths.database, { create: false, strict: true });
    try {
      database.exec("DROP TRIGGER session_switch_reconciliation_receipts_immutable_update");
      database.query(
        `UPDATE session_switch_reconciliation_receipts
         SET recorded_at=recorded_at+1 WHERE attempt_id=?`,
      ).run(prepared.switch.attemptId);
    } finally {
      database.close(false);
    }
    expect(() => store.requireSessionSwitch(prepared.switch.attemptId))
      .toThrow("SESSION_SWITCH_RECOVERY_CORRUPT");
    expect(() => store.abandonReconciledSessionSwitch({
      ...prepared.cas,
      expectedSessionRevision: before.revision,
      expectedSessionAuthority: authority,
      expectedSessionAuthorityRevision: authority.authorityRevision,
    })).toThrow("SESSION_SWITCH_RECOVERY_CORRUPT");
    expect(store.requireSession(prepared.session.id)).toEqual(before);
  });
for (const [index, phase] of ["failed", "seed_settled", "abandoned", "cancelled"].entries()) {
    test(`refuses corrupt current ${phase} switch evidence on reopen without repair`, async () => {
      const { store } = await fixture();
      const prepared = prepareDedicatedSessionSwitch(store, 755 + index);
      if (phase === "failed") {
        advanceDedicatedSessionSwitch(store, prepared, "target_starting");
        store.failSessionSwitchTargetStartNoEffect({
          ...prepared.cas,
          expectedPhase: "target_starting",
          diagnosticCode: "TARGET_START_REJECTED",
        });
      } else if (phase === "seed_settled") {
        advanceDedicatedSessionSwitch(store, prepared, "seed_dispatching");
        const authority = store.requireCapturedSessionProviderAuthority(prepared.session.id);
        store.completeSessionSwitchSeed({
          ...prepared.cas,
          seedAuthority: prepared.cas.targetAuthority,
          seedAuthorityRevision: authority.authorityRevision,
          settlement: {
            outcome: "accepted",
            turnId: "terminal-seed-turn",
            turnStatus: "completed",
            runtimeProfile: prepared.targetRuntime,
            receiptDigest: sessionSwitchDigest({
              domain: "hra:session-switch-seed-accepted:v1",
              turnId: "terminal-seed-turn",
              turnStatus: "completed",
              runtimeProfile: prepared.targetRuntime,
            }),
            seedText: prepared.seedText,
          },
        });
      } else if (phase === "abandoned") {
        advanceDedicatedSessionSwitch(store, prepared, "target_started");
        store.markSessionSwitchReconciliationRequired({
          ...prepared.cas,
          expectedPhase: "target_started",
          diagnosticCode: "TARGET_STATE_UNEXPECTED",
        });
        const session = store.requireSession(prepared.session.id);
        const authority = store.requireCapturedSessionProviderAuthority(prepared.session.id);
        store.abandonReconciledSessionSwitch({
          ...prepared.cas,
          expectedSessionRevision: session.revision,
          expectedSessionAuthority: authority,
          expectedSessionAuthorityRevision: authority.authorityRevision,
        });
      } else {
        store.cancelPreparedSessionSwitch(prepared.cas);
      }
      const unrelated = prepareDedicatedSessionSwitch(store, 759 + index);
      store.cancelPreparedSessionSwitch(unrelated.cas);
      const expectedTerminal = store.requireSessionSwitch(prepared.switch.attemptId);
      // Startup admission proves retained evidence, not present-day liveness.
      store.nextDaemonGeneration(`boot_${"d".repeat(32)}`);
      expect(store.requireSessionSwitch(prepared.switch.attemptId)).toEqual(expectedTerminal);
      const paths = store.paths;
      store.close();
      stores.splice(stores.indexOf(store), 1);

      expectInertSwitchReopenForTest(paths, expectedTerminal);

      const corrupt = new Database(paths.database, { create: false, strict: true });
      const restoreGuard = restoreSwitchGuardsForTest(corrupt, [
        phase === "failed" ? "session_switch_no_effect_receipts_immutable_update"
          : phase === "seed_settled" ? "session_switch_seed_receipts_immutable_update"
            : phase === "abandoned" ? "session_switch_abandon_receipts_immutable_update"
              : "session_switch_plan_anchors_immutable_update",
      ]);
      try {
        if (phase === "failed") {
          corrupt.exec("DROP TRIGGER session_switch_no_effect_receipts_immutable_update");
          corrupt.query(
            "UPDATE session_switch_no_effect_receipts SET recorded_at=recorded_at+1 WHERE attempt_id=?",
          ).run(prepared.switch.attemptId);
        } else if (phase === "seed_settled") {
          corrupt.exec("DROP TRIGGER session_switch_seed_receipts_immutable_update");
          corrupt.query(
            `UPDATE session_switch_seed_receipts
             SET public_receipt_json=' '||public_receipt_json WHERE attempt_id=?`,
          ).run(prepared.switch.attemptId);
        } else if (phase === "abandoned") {
          corrupt.exec("DROP TRIGGER session_switch_abandon_receipts_immutable_update");
          corrupt.query(
            `UPDATE session_switch_abandon_receipts
             SET session_json=json_set(session_json,'$.title','forged') WHERE attempt_id=?`,
          ).run(prepared.switch.attemptId);
        } else {
          corrupt.exec("DROP TRIGGER session_switch_plan_anchors_immutable_update");
          corrupt.query(
            "UPDATE session_switch_plan_anchors SET plan_digest=? WHERE attempt_id=?",
          ).run("f".repeat(64), prepared.switch.attemptId);
        }
      } finally {
        restoreGuard();
        corrupt.close(false);
      }

      // Current sealed evidence is never rewritten into a historical disposition.
      // Admission fails before this handle can admit callbacks or other work.
      expectInertSchemaRefusal(paths, phase === "cancelled"
        ? "SESSION_SWITCH_EXECUTION_CONTEXT_CORRUPT" : "SESSION_SWITCH_RECOVERY_CORRUPT");
    });
  }
for (const [index, changedField] of [
    "source_process_generation",
    "target_process_generation",
  ].entries()) {
    test(`refuses current switch admission when ${changedField} is corrupt`, async () => {
      const { store } = await fixture();
      const prepared = prepareDedicatedSessionSwitch(store, 767 + index);
      advanceDedicatedSessionSwitch(store, prepared, "target_started");
      const unrelated = prepareDedicatedSessionSwitch(store, 769 + index);
      store.cancelPreparedSessionSwitch(unrelated.cas);
      const paths = store.paths;
      store.close();
      stores.splice(stores.indexOf(store), 1);
      const corrupt = new Database(paths.database, { create: false, strict: true });
      const restoreGuard = restoreSwitchGuardsForTest(corrupt, [
        "session_switch_attempts_immutable_update", "session_switch_adoption_parent_update",
        "session_switch_execution_parent_advance",
      ]);
      try {
        corrupt.exec("DROP TRIGGER session_switch_attempts_immutable_update; DROP TRIGGER session_switch_adoption_parent_update; DROP TRIGGER session_switch_execution_parent_advance");
        corrupt.query(
          `UPDATE session_switch_attempts SET ${changedField}=${changedField}+1 WHERE attempt_id=?`,
        ).run(prepared.switch.attemptId);
        expect(corrupt.query("PRAGMA foreign_key_check").all()).toEqual([]);
      } finally {
        restoreGuard();
        corrupt.close(false);
      }

      expectInertSchemaRefusal(paths, "SESSION_SWITCH_MALFORMED_DISPOSITION_UNPROVABLE",
        "SESSION_SWITCH_ADOPTION_CUSTODY_CORRUPT");
    });
  }
test("refuses current switch admission when its journal session identity is corrupt", async () => {
    const { store } = await fixture();
    const prepared = prepareDedicatedSessionSwitch(store, 771, { pendingQueueMessage: "Must retain original session custody" });
    advanceDedicatedSessionSwitch(store, prepared, "target_started");
    const unrelated = prepareDedicatedSessionSwitch(store, 772);
    store.cancelPreparedSessionSwitch(unrelated.cas);
    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const corrupt = new Database(paths.database, { create: false, strict: true });
    const restoreGuard = restoreSwitchGuardsForTest(corrupt, [
      "session_switch_attempts_immutable_update", "session_switch_adoption_parent_update",
    ]);
    try {
      corrupt.exec("DROP TRIGGER session_switch_attempts_immutable_update; DROP TRIGGER session_switch_adoption_parent_update");
      corrupt.query(
        "UPDATE session_switch_attempts SET session_id=? WHERE attempt_id=?",
      ).run(unrelated.session.id, prepared.switch.attemptId);
      expect(corrupt.query("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      restoreGuard();
      corrupt.close(false);
    }

    expectInertSchemaRefusal(paths, "SESSION_SWITCH_MALFORMED_DISPOSITION_UNPROVABLE",
        "SESSION_SWITCH_ADOPTION_CUSTODY_CORRUPT");
  });
test("refuses current anchored plan tampering without startup repair", async () => {
    const { store } = await fixture({ provision: "migrate" });
    const prepared = prepareDedicatedSessionSwitch(store, 773);
    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const inspector = new Database(paths.database, { create: false, strict: true });
    try {
      const schema = snapshotSwitchContainmentForTest(inspector).schema;
      withRemovedTestGuards(inspector, ["session_switch_plan_anchors_immutable_update"], () => {
        inspector.query("UPDATE session_switch_plan_anchors SET plan_digest=? WHERE attempt_id=?")
          .run("f".repeat(64), prepared.switch.attemptId);
      });
      expect(snapshotSwitchContainmentForTest(inspector).schema).toEqual(schema);
      const corrupted = snapshotSwitchContainmentForTest(inspector);
      expect(corrupted.version).toEqual({ user_version: 61 });
      for (const readonly of [true, false]) {
        expect(() => new StateStore(paths, { readonly, now: () => 9_570 }))
          .toThrow("SESSION_SWITCH_EXECUTION_CONTEXT_CORRUPT");
        expect(snapshotSwitchContainmentForTest(inspector)).toEqual(corrupted);
      }
    } finally { inspector.close(false); }
  });
test("allows a new V2 switch after authentic combined49 prepared corruption is safely cancelled", async () => {
    const paths = await combined49SwitchArchiveForTest();
    const captured = combined49SwitchFixture;
    const originalSwitch = captured.prepared.switch;
    const corrupt = new Database(paths.database, { create: false, strict: true });
    try {
      corruptCombined49SwitchRowsForTest(corrupt, ["session_switch_plan_anchors"],
        ["session_switch_plan_anchors_immutable_update"], () => {
          corrupt.query("UPDATE session_switch_plan_anchors SET plan_digest=? WHERE attempt_id=?")
            .run("f".repeat(64), originalSwitch.attemptId);
        });
      expect(corrupt.query("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally { corrupt.close(false); }

    const reopened = new StateStore(paths, { now: () => originalSwitch.createdAt + 1 });
    stores.push(reopened);
    const sourceSession = reopened.requireSession(captured.session.id);
    expect(sourceSession).toMatchObject(captured.session);
    expect(() => reopened.readSessionSwitchByIdempotencyKey(originalSwitch.idempotencyKey))
      .toThrow("SESSION_SWITCH_RECOVERY_CORRUPT");
    expect(reopened.readSessionSwitchForRecovery(sourceSession.id)).toBeNull();
    const inspector = new Database(paths.database, { readonly: true, strict: true });
    try {
      expect(inspector.query("SELECT phase,diagnostic_code FROM session_switch_attempts WHERE attempt_id=?")
        .get(originalSwitch.attemptId)).toEqual({ phase: "cancelled", diagnostic_code: "MALFORMED_SWITCH_RECORD" });
      expect(inspector.query("SELECT state FROM mutation_attempts WHERE id=?")
        .get(originalSwitch.attemptId)).toEqual({ state: "cancelled" });
      expect(inspector.query("SELECT 1 FROM session_switch_execution_contexts WHERE attempt_id=?")
        .get(originalSwitch.attemptId)).toBeNull();
    } finally { inspector.close(false); }
    const readonlyAfterContainment = new StateStore(paths, { readonly: true });
    readonlyAfterContainment.close();

    // A new current request gets its own V2 context and synthetic empty-range
    // transcript digests. Do not retag or reuse the archived V1 request/seed.
    const sourceAuthority = reopened.requireProviderAccountAuthority(captured.source.profile.id, "codex");
    const targetAuthority = reopened.requireProviderAccountAuthority(captured.target.profile.id, "codex");
    const sourceBinding = reopened.requireSessionProviderAuthority(sourceSession.id);
    const position = reopened.readSessionSnapshotWithEventPosition(sourceSession.id);
    const next = reopened.prepareSessionSwitch({
      targetAccountKey: captured.target.accountKey,
      targetHostCapabilities: testSwitchHostCapabilities,
      idempotencyKey: "20000000-0000-4000-8000-000000000774",
      rawRequest: { version: 2, session: sourceSession.id, provider: "codex",
        account: targetAuthority.profileId, preset: "low", presetContract: null },
      sessionId: sourceSession.id,
      sourceAuthority,
      targetAuthority,
      expectedSessionRevision: sourceSession.revision,
      expectedAuthorityRevision: sourceBinding.authorityRevision,
      sourcePreset: sourceSession.preset,
      sourcePresetContract: reopened.requireSessionPresetContract(sourceSession.id),
      targetPreset: "low",
      targetPresetContract: activePresetBinding("low").contract,
      sourceRuntimeProfileRevision: originalSwitch.sourceRuntimeProfileRevision,
      transcript: {
        streamEpoch: position.streamEpoch,
        floorSequence: position.floorSequence,
        afterSequenceExclusive: position.observedThroughSequence,
        throughSequenceInclusive: position.observedThroughSequence,
        acceptedHeadSequence: position.observedThroughSequence,
        rendererVersion: 2,
        rendererLimit: 400,
        transcriptDigest: sessionSwitchDigest(["synthetic-current-v2-empty-transcript", position]),
        seedDigest: sessionSwitchDigest(["synthetic-current-v2-empty-seed", position]),
        seedIncludedRecords: 0,
        seedOmittedRecords: 0,
        seedClientMessageId: "switch-seed-after-historical-cancellation",
      },
    });
    const nextCas = {
      sourceAuthority, targetAuthority,
      originalSessionRevision: next.switch.originalSessionRevision,
      originalAuthorityRevision: next.switch.originalAuthorityRevision,
      attemptId: next.switch.attemptId,
      requestDigest: next.switch.requestDigest,
    };
    reopened.beginSessionSwitchTargetStart(nextCas);
    reopened.markSessionSwitchReconciliationRequired({
      ...nextCas,
      expectedPhase: "target_starting",
      diagnosticCode: "TARGET_START_OUTCOME_UNKNOWN",
    });
    expect(reopened.readSessionSwitchForRecovery(sourceSession.id)).toMatchObject({
      attemptId: next.switch.attemptId,
      phase: "reconciliation_required",
    });
    const session = reopened.requireSession(sourceSession.id);
    const authority = reopened.requireCapturedSessionProviderAuthority(sourceSession.id);
    const abandoned = reopened.abandonReconciledSessionSwitch({
      ...nextCas,
      expectedSessionRevision: session.revision,
      expectedSessionAuthority: authority,
      expectedSessionAuthorityRevision: authority.authorityRevision,
    });
    expect(abandoned.session.state).toBe("terminal");
    expect(abandoned.switch.phase).toBe("abandoned");
    expect(reopened.readSessionSwitchForRecovery(sourceSession.id)).toBeNull();
    expect(() => reopened.readSessionSwitchByIdempotencyKey(originalSwitch.idempotencyKey))
      .toThrow("SESSION_SWITCH_RECOVERY_CORRUPT");
    const readonlyAfterCurrentRecovery = new StateStore(paths, { readonly: true });
    readonlyAfterCurrentRecovery.close();
  });
test("refuses multiple corrupt current terminal journals without blessing a valid latest journal", async () => {
    const { store } = await fixture();
    const prepared = prepareDedicatedSessionSwitch(store, 764);
    store.cancelPreparedSessionSwitch(prepared.cas);
    const repeat = (idempotencyKey: string) => {
      const repeated = store.prepareSessionSwitch({
        targetAccountKey: prepared.targetAccountKey,
        targetHostCapabilities: testSwitchHostCapabilities,
        idempotencyKey,
        rawRequest: prepared.switch.rawRequest,
        sessionId: prepared.switch.sessionId,
        sourceAuthority: prepared.cas.sourceAuthority,
        targetAuthority: prepared.cas.targetAuthority,
        expectedSessionRevision: prepared.cas.originalSessionRevision,
        expectedAuthorityRevision: prepared.cas.originalAuthorityRevision,
        sourcePreset: prepared.switch.sourcePreset,
        sourcePresetContract: prepared.switch.sourcePresetContract,
        targetPreset: prepared.switch.targetPreset,
        targetPresetContract: prepared.switch.targetPresetContract,
        sourceRuntimeProfileRevision: prepared.switch.sourceRuntimeProfileRevision,
        transcript: prepared.switch.transcript,
      });
      store.cancelPreparedSessionSwitch({
        ...prepared.cas,
        attemptId: repeated.switch.attemptId,
        requestDigest: repeated.switch.requestDigest,
      });
      return repeated.switch;
    };
    const second = repeat("20000000-0000-4000-8000-000000000765");
    repeat("20000000-0000-4000-8000-000000000766");
    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const corrupt = new Database(paths.database, { create: false, strict: true });
    const restoreGuard = restoreSwitchGuardsForTest(corrupt, [
      "session_switch_attempts_immutable_update", "session_switch_plan_anchors_immutable_update",
      "session_switch_adoption_parent_update",
    ]);
    try {
      corrupt.exec(`
        DROP TRIGGER session_switch_attempts_immutable_update;
        DROP TRIGGER session_switch_plan_anchors_immutable_update;
        DROP TRIGGER session_switch_adoption_parent_update;
      `);
      corrupt.query(
        "UPDATE session_switch_attempts SET request_digest=? WHERE attempt_id=?",
      ).run("e".repeat(64), prepared.switch.attemptId);
      corrupt.query(
        "UPDATE session_switch_plan_anchors SET plan_digest=? WHERE attempt_id=?",
      ).run("f".repeat(64), second.attemptId);
    } finally {
      restoreGuard();
      corrupt.close(false);
    }
    expectInertSchemaRefusal(paths, "SESSION_SWITCH_MALFORMED_DISPOSITION_UNPROVABLE",
        "SESSION_SWITCH_ADOPTION_CUSTODY_CORRUPT");
  });
test("admits older settled switch receipts after another switch, account removal, and restart", async () => {
    const { store } = await fixture();
    const first = prepareDedicatedSessionSwitch(store, 974);
    advanceDedicatedSessionSwitch(store, first, "seed_dispatching");
    const reject = (prepared: ReturnType<typeof prepareDedicatedSessionSwitch>) => store.completeSessionSwitchSeed({
      ...prepared.cas,
      seedAuthority: prepared.cas.targetAuthority,
      seedAuthorityRevision: store.requireCapturedSessionProviderAuthority(prepared.session.id).authorityRevision,
      settlement: { outcome: "rejected", failureCode: "SEED_REJECTED",
        receiptDigest: createHash("sha256").update("hra:session-switch-seed-rejected:v1\0SEED_REJECTED").digest("hex") },
    });
    const firstTerminal = reject(first);
    const session = store.requireSession(first.session.id);
    const capturedSource = store.requireCapturedSessionProviderAuthority(session.id);
    const source = { providerAccountId: capturedSource.providerAccountId,
      profileId: capturedSource.profileId, provider: capturedSource.provider,
      bindingGeneration: capturedSource.bindingGeneration, processGeneration: capturedSource.processGeneration };
    const targetProfile = signInProfile(store, "Later terminal switch target", "later-terminal-switch@example.com");
    const target = store.requireProviderAccountAuthority(targetProfile.id, "codex");
    const runtime = store.latestSessionRuntimeProfile(session.id);
    if (runtime === null) throw new Error("missing current switch runtime");
    const position = store.readSessionSnapshotWithEventPosition(session.id);
    const next = store.prepareSessionSwitch({
      targetAccountKey: providerAccountKeyForProfile(store, targetProfile.id, "codex"),
      targetHostCapabilities: testSwitchHostCapabilities,
      idempotencyKey: "20000000-0000-4000-8000-000000000975",
      rawRequest: { version: 2, session: session.id, provider: "codex",
        account: targetProfile.id, preset: "low", presetContract: null },
      sessionId: session.id, sourceAuthority: source, targetAuthority: target,
      expectedSessionRevision: session.revision, expectedAuthorityRevision: capturedSource.authorityRevision,
      sourcePreset: session.preset, sourcePresetContract: store.requireSessionPresetContract(session.id),
      targetPreset: "low", targetPresetContract: activePresetBinding("low").contract,
      sourceRuntimeProfileRevision: runtime.revision,
      transcript: { ...first.switch.transcript,
        streamEpoch: position.streamEpoch, floorSequence: position.floorSequence,
        afterSequenceExclusive: position.observedThroughSequence,
        throughSequenceInclusive: position.observedThroughSequence,
        acceptedHeadSequence: position.observedThroughSequence,
        seedClientMessageId: "later-terminal-switch-seed" },
    });
    const second = { ...first, ...next, session, targetProfile,
      targetThreadId: "later-terminal-switch-thread",
      targetRuntime: effectiveRuntimeProfileSchema.parse({ ...first.targetRuntime,
        profileId: target.profileId, processGeneration: target.processGeneration }),
      cas: { attemptId: next.switch.attemptId, requestDigest: next.switch.requestDigest,
        sourceAuthority: source, targetAuthority: target,
        originalSessionRevision: next.switch.originalSessionRevision,
        originalAuthorityRevision: next.switch.originalAuthorityRevision },
    };
    advanceDedicatedSessionSwitch(store, second, "seed_dispatching");
    const secondTerminal = reject(second);
    store.removeProfile(first.sourceProfile.id);
    store.removeProfile(first.targetProfile.id);
    store.nextDaemonGeneration(`boot_${"e".repeat(32)}`);
    expect(store.requireSessionSwitch(firstTerminal.attemptId)).toEqual(firstTerminal);
    expect(store.requireSessionSwitch(secondTerminal.attemptId)).toEqual(secondTerminal);
    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);
    expectInertSwitchReopenForTest(paths, firstTerminal);
    expectInertSwitchReopenForTest(paths, secondTerminal);
  });
test("audits terminal switch receipts beyond the first one hundred raw journal rows", async () => {
    const { store } = await fixture();
    const prepared = prepareDedicatedSessionSwitch(store, 976);
    store.cancelPreparedSessionSwitch(prepared.cas);
    const records = [store.requireSessionSwitch(prepared.switch.attemptId)];
    for (let index = 0; index < 100; index++) {
      const repeated = store.prepareSessionSwitch({
        targetAccountKey: prepared.targetAccountKey,
        targetHostCapabilities: testSwitchHostCapabilities,
        idempotencyKey: `21000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        rawRequest: prepared.switch.rawRequest,
        sessionId: prepared.switch.sessionId,
        sourceAuthority: prepared.cas.sourceAuthority,
        targetAuthority: prepared.cas.targetAuthority,
        expectedSessionRevision: prepared.cas.originalSessionRevision,
        expectedAuthorityRevision: prepared.cas.originalAuthorityRevision,
        sourcePreset: prepared.switch.sourcePreset,
        sourcePresetContract: prepared.switch.sourcePresetContract,
        targetPreset: prepared.switch.targetPreset,
        targetPresetContract: prepared.switch.targetPresetContract,
        sourceRuntimeProfileRevision: prepared.switch.sourceRuntimeProfileRevision,
        transcript: prepared.switch.transcript,
      });
      const cas = { ...prepared.cas, attemptId: repeated.switch.attemptId,
        requestDigest: repeated.switch.requestDigest };
      store.beginSessionSwitchTargetStart(cas);
      store.failSessionSwitchTargetStartNoEffect({ ...cas, expectedPhase: "target_starting",
        diagnosticCode: "TARGET_START_REJECTED" });
      records.push(store.requireSessionSwitch(cas.attemptId));
    }
    const last = records.at(-1);
    if (last === undefined) throw new Error("missing terminal journal fixture");
    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);
    for (const readonly of [false, true]) {
      const reopened = new StateStore(paths, { readonly });
      try {
        for (const record of records) expect(reopened.requireSessionSwitch(record.attemptId)).toEqual(record);
      } finally { reopened.close(); }
    }
    const inspector = new Database(paths.database, { create: false, strict: true });
    try {
      expect(inspector.query("SELECT COUNT(*) AS count FROM session_switch_attempts").get()).toEqual({ count: 101 });
      // Leave the request/plan/context intact: only the full terminal mapper
      // detects this mismatched receipt time on the second keyset page.
      withRemovedTestGuards(inspector, ["session_switch_no_effect_receipts_immutable_update"], () => {
        inspector.query("UPDATE session_switch_no_effect_receipts SET recorded_at=recorded_at+1 WHERE attempt_id=?")
          .run(last.attemptId);
      });
    } finally { inspector.close(false); }
    expectInertSchemaRefusal(paths, "SESSION_SWITCH_RECOVERY_CORRUPT");
  });
test("requires the cumulative receipt chain and independent action anchors on every read", async () => {
    const { store } = await fixture();
    const sourceProfile = signInProfile(store, "Evidence source", "evidence-source@example.com");
    const targetProfile = signInProfile(store, "Evidence target", "evidence-target@example.com");
    const options = { sourceProfile, targetProfile } as const;
    const target = prepareDedicatedSessionSwitch(store, 740, options);
    advanceDedicatedSessionSwitch(store, target, "target_started");
    const release = prepareDedicatedSessionSwitch(store, 741, options);
    advanceDedicatedSessionSwitch(store, release, "source_released");
    const rebind = prepareDedicatedSessionSwitch(store, 742, options);
    advanceDedicatedSessionSwitch(store, rebind, "rebound");
    const seedAuthority = prepareDedicatedSessionSwitch(store, 743, options);
    advanceDedicatedSessionSwitch(store, seedAuthority, "seed_dispatching");
    const seed = prepareDedicatedSessionSwitch(store, 744, options);
    advanceDedicatedSessionSwitch(store, seed, "seed_dispatching");
    const capturedSeed = store.requireSessionProviderAuthority(seed.session.id);
    store.completeSessionSwitchSeed({
      ...seed.cas,
      seedAuthority: seed.cas.targetAuthority,
      seedAuthorityRevision: capturedSeed.authorityRevision,
      settlement: {
        outcome: "rejected",
        failureCode: "SEED_REJECTED",
        receiptDigest: createHash("sha256")
          .update("hra:session-switch-seed-rejected:v1\0SEED_REJECTED")
          .digest("hex"),
      },
    });
    const reconciliation = prepareDedicatedSessionSwitch(store, 745, options);
    advanceDedicatedSessionSwitch(store, reconciliation, "target_started");
    store.markSessionSwitchReconciliationRequired({
      ...reconciliation.cas,
      expectedPhase: "target_started",
      diagnosticCode: "TARGET_STATE_UNEXPECTED",
    });
    const noEffect = prepareDedicatedSessionSwitch(store, 746, options);
    store.beginSessionSwitchTargetStart(noEffect.cas);
    store.failSessionSwitchTargetStartNoEffect({
      ...noEffect.cas,
      expectedPhase: "target_starting",
      diagnosticCode: "TARGET_START_REJECTED",
    });
    const abandoned = prepareDedicatedSessionSwitch(store, 747, options);
    advanceDedicatedSessionSwitch(store, abandoned, "target_started");
    store.markSessionSwitchReconciliationRequired({
      ...abandoned.cas,
      expectedPhase: "target_started",
      diagnosticCode: "TARGET_STATE_UNEXPECTED",
    });
    const abandonSession = store.requireSession(abandoned.session.id);
    const abandonAuthority = store.requireSessionProviderAuthority(abandoned.session.id);
    store.abandonReconciledSessionSwitch({
      ...abandoned.cas,
      expectedSessionRevision: abandonSession.revision,
      expectedSessionAuthority: abandonAuthority,
      expectedSessionAuthorityRevision: abandonAuthority.authorityRevision,
    });
    const plan = prepareDedicatedSessionSwitch(store, 748, options);
    const targetResult = prepareDedicatedSessionSwitch(store, 749, options);
    advanceDedicatedSessionSwitch(store, targetResult, "target_started");
    const sourceResult = prepareDedicatedSessionSwitch(store, 750, options);
    advanceDedicatedSessionSwitch(store, sourceResult, "source_released");
    const sourceRuntime = prepareDedicatedSessionSwitch(store, 751, options);

    const database = new Database(store.paths.database, { create: false, strict: true });
    try {
      database.exec(`
        PRAGMA foreign_keys=OFF;
        DROP TRIGGER session_switch_target_start_receipts_immutable_delete;
        DROP TRIGGER session_switch_source_release_receipts_immutable_delete;
        DROP TRIGGER session_switch_rebind_receipts_immutable_delete;
        DROP TRIGGER session_switch_seed_authorities_immutable_delete;
        DROP TRIGGER session_switch_seed_receipts_immutable_delete;
        DROP TRIGGER session_switch_reconciliation_receipts_immutable_delete;
        DROP TRIGGER session_switch_no_effect_receipts_immutable_delete;
        DROP TRIGGER session_switch_abandon_receipts_immutable_update;
        DROP TRIGGER session_switch_attempts_immutable_update;
        DROP TRIGGER session_switch_target_start_receipts_immutable_update;
        DROP TRIGGER session_switch_source_release_receipts_immutable_update;
        DROP TRIGGER session_runtime_profiles_immutable_update;
      `);
      database.query("DELETE FROM session_switch_target_start_receipts WHERE attempt_id=?")
        .run(target.switch.attemptId);
      database.query("DELETE FROM session_switch_source_release_receipts WHERE attempt_id=?")
        .run(release.switch.attemptId);
      database.query("DELETE FROM session_switch_rebind_receipts WHERE attempt_id=?")
        .run(rebind.switch.attemptId);
      database.query("DELETE FROM session_switch_seed_authorities WHERE attempt_id=?")
        .run(seedAuthority.switch.attemptId);
      database.query("DELETE FROM session_switch_seed_receipts WHERE attempt_id=?")
        .run(seed.switch.attemptId);
      database.query("DELETE FROM session_switch_reconciliation_receipts WHERE attempt_id=?")
        .run(reconciliation.switch.attemptId);
      database.query("DELETE FROM session_switch_no_effect_receipts WHERE attempt_id=?")
        .run(noEffect.switch.attemptId);
      database.query(
        `UPDATE session_switch_abandon_receipts
         SET session_json=json_set(session_json,'$.title','forged') WHERE attempt_id=?`,
      ).run(abandoned.switch.attemptId);
      database.query(
        "UPDATE session_switch_attempts SET target_preset='high' WHERE attempt_id=?",
      ).run(plan.switch.attemptId);
      database.query(
        `UPDATE session_switch_target_start_receipts
         SET state='active',active_turn_id='forged-turn' WHERE attempt_id=?`,
      ).run(targetResult.switch.attemptId);
      database.query(
        `UPDATE session_switch_source_release_receipts
         SET provider_thread_id='forged-source-thread' WHERE attempt_id=?`,
      ).run(sourceResult.switch.attemptId);
      database.query(
        `UPDATE session_runtime_profiles SET source_id='forged-source-runtime'
         WHERE session_id=? AND revision=?`,
      ).run(sourceRuntime.session.id, sourceRuntime.switch.sourceRuntimeProfileRevision);
      database.exec("PRAGMA foreign_keys=ON");
    } finally {
      database.close(false);
    }

    for (const value of [
      target,
      release,
      rebind,
      seedAuthority,
      seed,
      reconciliation,
      noEffect,
      abandoned,
      plan,
      targetResult,
      sourceResult,
      sourceRuntime,
    ]) {
      expect(() => store.requireSessionSwitch(value.switch.attemptId)).toThrow();
    }
  });
test("pins the exact transcript range without retaining plaintext in the switch journal", async () => {
    const { store } = await fixture();
    const prepared = prepareDedicatedSessionSwitch(store, 711, { pinSourceEvent: true });
    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);

    const aged = new StateStore(paths, { now: () => SESSION_EVENT_RETAIN_AGE_MS + 50_000 });
    stores.push(aged);
    expect(aged.listSessionEvents({
      sessionId: prepared.session.id,
      afterSequence: 0,
    }).events).toMatchObject([{ sequence: prepared.switch.transcript.throughSequenceInclusive }]);
    aged.cancelPreparedSessionSwitch(prepared.cas);
    expect(aged.listSessionEvents({
      sessionId: prepared.session.id,
      afterSequence: 0,
    }).events).toEqual([]);
  });
test("refuses source release unless target ownership and both interaction authorities are quiescent", async () => {
    const { store } = await fixture();

    const active = prepareDedicatedSessionSwitch(store, 702);
    store.beginSessionSwitchTargetStart(active.cas);
    store.completeSessionSwitchTargetStart({
      ...active.cas,
      providerThreadId: active.targetThreadId,
      state: "active",
      activeTurnId: "target-active-turn",
      runtimeProfile: active.targetRuntime,
    });
    expect(() => store.beginSessionSwitchSourceRelease(active.cas))
      .toThrow("SESSION_SWITCH_REQUEST_CONFLICT");

    const staleTarget = prepareDedicatedSessionSwitch(store, 710);
    advanceDedicatedSessionSwitch(store, staleTarget, "target_started");
    store.advanceProviderAccountProcessGeneration({
      profileId: staleTarget.targetProfile.id,
      provider: "codex",
      expectedProcessGeneration: staleTarget.cas.targetAuthority.processGeneration,
    });
    expect(() => store.beginSessionSwitchSourceRelease(staleTarget.cas))
      .toThrow("SESSION_SWITCH_TARGET_AUTHORITY_STALE");
    expect(store.requireSessionSwitch(staleTarget.switch.attemptId).phase).toBe("target_started");

    const sameProfile = signInProfile(store, "Same profile switch", "same-profile-switch@example.com");
    const selfCollision = prepareDedicatedSessionSwitch(store, 703, {
      sourceProfile: sameProfile,
      targetProfile: sameProfile,
      targetPreset: "low",
      targetThreadId: "source-thread-703",
    });
    advanceDedicatedSessionSwitch(store, selfCollision, "target_started");
    expect(() => store.beginSessionSwitchSourceRelease(selfCollision.cas))
      .toThrow("SESSION_SWITCH_REQUEST_CONFLICT");

    const terminalCollision = prepareDedicatedSessionSwitch(store, 704);
    const ownerCreated = store.createSession({
      profileId: terminalCollision.targetProfile.id,
      provider: "claude",
      preset: "fable-max",
      fastEnabled: false,
    });
    const ownerBound = store.bindSession({
      sessionId: ownerCreated.id,
      expectedRevision: ownerCreated.revision,
      providerThreadId: terminalCollision.targetThreadId,
      state: "idle",
    });
    store.setSessionTurnState({
      sessionId: ownerBound.id,
      expectedRevision: ownerBound.revision,
      state: "terminal",
    });
    advanceDedicatedSessionSwitch(store, terminalCollision, "target_started");
    expect(() => store.beginSessionSwitchSourceRelease(terminalCollision.cas))
      .toThrow("SESSION_SWITCH_REQUEST_CONFLICT");

    const staleOwnerProfile = signInProfile(
      store,
      "Stale terminal owner",
      "stale-terminal-owner@example.com",
    );
    const staleOwnerCreated = store.createSession({
      profileId: staleOwnerProfile.id,
      provider: "codex",
      preset: "high",
      fastEnabled: false,
    });
    const staleOwnerBound = store.bindSession({
      sessionId: staleOwnerCreated.id,
      expectedRevision: staleOwnerCreated.revision,
      providerThreadId: "stale-owned-target-thread",
      state: "idle",
    });
    store.setSessionTurnState({
      sessionId: staleOwnerBound.id,
      expectedRevision: staleOwnerBound.revision,
      state: "terminal",
    });
    store.advanceProviderAccountProcessGeneration({
      profileId: staleOwnerProfile.id,
      provider: "codex",
      expectedProcessGeneration: store.requireProviderAccountAuthority(
        staleOwnerProfile.id,
        "codex",
      ).processGeneration,
    });
    const staleOwnerCollision = prepareDedicatedSessionSwitch(store, 713, {
      targetProfile: staleOwnerProfile,
      targetThreadId: "stale-owned-target-thread",
    });
    advanceDedicatedSessionSwitch(store, staleOwnerCollision, "target_started");
    expect(() => store.beginSessionSwitchSourceRelease(staleOwnerCollision.cas))
      .toThrow("SESSION_SWITCH_REQUEST_CONFLICT");

    const interactionRace = prepareDedicatedSessionSwitch(store, 705);
    store.beginSessionSwitchTargetStart(interactionRace.cas);
    store.admitInteraction({
      publicId: "30000000-0000-4000-8000-000000000705",
      sessionId: null,
      authority: {
        ...interactionRace.cas.targetAuthority,
        connectionId: "30000000-0000-4000-8000-000000000706",
        requestId: { type: "string", value: "target-interaction-705" },
        method: "item/commandExecution/requestApproval",
        requestDigest: "a".repeat(64),
        threadId: interactionRace.targetThreadId,
        turnId: "target-turn-705",
        itemId: "target-item-705",
        approvalId: null,
      },
      kind: "command_approval",
      blocking: true,
      requestedAt: 1_000,
      deadlineAt: 1_001,
      display: {
        kind: "command_approval",
        summary: "Target interaction before receipt",
        reason: null,
        commandClass: "test",
        workingDirectory: null,
        availableDecisions: ["once", "session", "decline", "cancel"],
      },
    });
    store.completeSessionSwitchTargetStart({
      ...interactionRace.cas,
      providerThreadId: interactionRace.targetThreadId,
      state: "idle",
      runtimeProfile: interactionRace.targetRuntime,
    });
    expect(() => store.beginSessionSwitchSourceRelease(interactionRace.cas))
      .toThrow("SESSION_SWITCH_INTERACTION_UNSETTLED");

    const importRace = prepareDedicatedSessionSwitch(store, 714);
    advanceDedicatedSessionSwitch(store, importRace, "target_started");
    expect(() => store.upsertProviderSession({
      providerAuthority: importRace.cas.targetAuthority,
      providerAccountKey: importRace.targetAccountKey,
      profileId: importRace.cas.targetAuthority.profileId,
      provider: importRace.cas.targetAuthority.provider,
      preset: importRace.switch.targetPreset,
      fastEnabled: false,
      providerThreadId: importRace.targetThreadId,
      title: "Imported while target is reserved",
      state: "idle",
      providerUpdatedAt: 30,
    })).toThrow("SESSION_SWITCH_STORAGE_FENCED");
    expect(store.findSessionByProviderThread(
      importRace.cas.targetAuthority.profileId,
      importRace.targetThreadId,
    )).toBeNull();
    const importDatabase = new Database(store.paths.database, { create: false, strict: true });
    try {
      expect(() => importDatabase.query(
        `INSERT INTO sessions(
           id,profile_id,project_id,provider_thread_id,title,note,provider,preset,
           fast_enabled,state,active_turn_id,provider_updated_at,archived_at,
           revision,created_at,updated_at
         ) VALUES (?, ?, NULL, ?, 'Reserved import', '', 'codex', 'low',
                   0, 'idle', NULL, 30, NULL, 1, 50000, 50000)`,
      ).run(
        `sess_${"f".repeat(32)}`,
        importRace.cas.targetAuthority.profileId,
        importRace.targetThreadId,
      )).toThrow("session switch reserves provider session identity");
    } finally {
      importDatabase.close(false);
    }
  });
test("keeps reconciliation fenced until an exact receipt-backed abandonment", async () => {
    const { store } = await fixture();
    const prepared = prepareDedicatedSessionSwitch(store, 706, { pendingQueueMessage: "May remain pending while fenced" });
    store.beginSessionSwitchTargetStart(prepared.cas);
    const targetInteractionId = "30000000-0000-4000-8000-000000000716";
    store.admitInteraction({
      publicId: targetInteractionId,
      sessionId: null,
      authority: {
        ...prepared.cas.targetAuthority,
        connectionId: "30000000-0000-4000-8000-000000000717",
        requestId: { type: "string", value: "abandon-target-interaction" },
        method: "item/commandExecution/requestApproval",
        requestDigest: "b".repeat(64),
        threadId: prepared.targetThreadId,
        turnId: "abandon-target-turn",
        itemId: "abandon-target-item",
        approvalId: null,
      },
      kind: "command_approval",
      blocking: true,
      requestedAt: 1_000,
      deadlineAt: 1_001,
      display: {
        kind: "command_approval",
        summary: "Target interaction owned by abandoned switch",
        reason: null,
        commandClass: "test",
        workingDirectory: null,
        availableDecisions: ["once", "session", "decline", "cancel"],
      },
    });
    store.completeSessionSwitchTargetStart({
      ...prepared.cas,
      providerThreadId: prepared.targetThreadId,
      state: "idle",
      runtimeProfile: prepared.targetRuntime,
    });
    const reconciled = store.markSessionSwitchReconciliationRequired({
      ...prepared.cas,
      expectedPhase: "target_started",
      diagnosticCode: "TARGET_STATE_UNEXPECTED",
    });
    expect(reconciled.phase).toBe("reconciliation_required");
    const unrelatedInteractionId = "30000000-0000-4000-8000-000000000718";
    store.admitInteraction({
      publicId: unrelatedInteractionId,
      sessionId: null,
      authority: {
        ...prepared.cas.targetAuthority,
        connectionId: "30000000-0000-4000-8000-000000000717",
        requestId: { type: "string", value: "unrelated-generation-interaction" },
        method: "item/commandExecution/requestApproval",
        requestDigest: "c".repeat(64),
        threadId: "unrelated-target-thread",
        turnId: "unrelated-target-turn",
        itemId: "unrelated-target-item",
        approvalId: null,
      },
      kind: "command_approval",
      blocking: true,
      requestedAt: 1_000,
      deadlineAt: 1_002,
      display: {
        kind: "command_approval",
        summary: "Unrelated generation interaction",
        reason: null,
        commandClass: "test",
        workingDirectory: null,
        availableDecisions: ["once", "session", "decline", "cancel"],
      },
    });
    expect(store.listDueInteractions({ now: 2_000 }).map((value) => value.publicId))
      .toEqual([unrelatedInteractionId]);
    expect(store.nextInteractionDeadlineAt()).toBe(1_002);
    expect(store.expireGenerationInteractions({
      profileId: prepared.cas.targetAuthority.profileId,
      processGeneration: prepared.cas.targetAuthority.processGeneration,
      connectionId: "30000000-0000-4000-8000-000000000717",
      providerAuthority: prepared.cas.targetAuthority,
      excludeSessionSwitchBlocked: true,
    })).toEqual([
      expect.objectContaining({ publicId: unrelatedInteractionId, state: "expired" }),
    ]);
    expect(store.requireInteraction(targetInteractionId).state).toBe("pending");
    expect(store.nextInteractionDeadlineAt()).toBeNull();
    const quarantined = store.requireSession(prepared.session.id);
    expect(quarantined).toMatchObject({ state: "recovery_required" });
    expect(store.sessionSwitchAdmissionBlocked({
      sessionId: prepared.session.id,
      providerThreadId: prepared.session.providerThreadId ?? null,
      providerAuthority: prepared.cas.sourceAuthority,
    })).toMatchObject({ blocked: true, attemptId: prepared.switch.attemptId });
    expect(() => store.updateSessionMetadata({
      sessionId: prepared.session.id,
      expectedRevision: quarantined.revision,
      note: "must remain inert",
    })).toThrow("session switch blocks session mutation");
    const pendingQueue = prepared.pendingQueue;
    if (pendingQueue === null) throw new Error("fixture pending queue missing");
    expect(() => store.transitionQueue(pendingQueue.id, "pending", "dispatching"))
      .toThrow("session switch blocks queue dispatch");
    expect(() => store.appendSessionEvent({
      sessionId: prepared.session.id,
      accountId: prepared.cas.sourceAuthority.profileId,
      providerGeneration: prepared.cas.sourceAuthority.processGeneration,
      providerAuthority: prepared.cas.sourceAuthority,
      providerConnectionId: null,
      body: { type: "warning", code: "LATE_FACT", message: "must stay inert" },
    })).toThrow("session switch blocks callback event admission");
    expect(() => store.terminalizeSessionFromProviderDeletion({
      accountId: prepared.cas.sourceAuthority.profileId,
      providerConnectionId: null,
      providerGeneration: prepared.cas.sourceAuthority.processGeneration,
      providerAuthority: prepared.cas.sourceAuthority,
      sessionId: prepared.session.id,
    })).toThrow("SESSION_SWITCH_STORAGE_FENCED");
    expect(store.requireSession(prepared.session.id)).toEqual(quarantined);

    const captured = store.requireCapturedSessionProviderAuthority(prepared.session.id);
    const abandoned = store.abandonReconciledSessionSwitch({
      ...prepared.cas,
      expectedSessionRevision: quarantined.revision,
      expectedSessionAuthority: captured,
      expectedSessionAuthorityRevision: captured.authorityRevision,
    });
    expect(abandoned).toMatchObject({
      switch: { phase: "abandoned", abandonment: { terminalSessionRevision: quarantined.revision + 1 } },
      session: { state: "terminal", revision: quarantined.revision + 1 },
      interactions: [{ publicId: targetInteractionId, state: "expired", revision: 2 }],
    });
    expect(store.requireQueue(pendingQueue.id).state).toBe("cancelled");
    expect(store.requireInteraction(targetInteractionId)).toMatchObject({
      state: "expired",
      revision: 2,
    });
    const inspector = new Database(store.paths.database, { create: false, strict: true });
    try {
      expect(inspector.query(
        `SELECT revision,state FROM provider_interaction_transitions
         WHERE public_id=? ORDER BY revision`,
      ).all(targetInteractionId)).toEqual([
        { revision: 1, state: "pending" },
        { revision: 2, state: "expired" },
      ]);
    } finally {
      inspector.close(false);
    }
    expect(store.readSessionSwitchForRecovery(prepared.session.id)).toBeNull();
    expect(store.sessionSwitchAdmissionBlocked({
      sessionId: prepared.session.id,
      providerThreadId: prepared.session.providerThreadId ?? null,
      providerAuthority: prepared.cas.sourceAuthority,
    })).toEqual({ blocked: false, attemptId: null, role: null });
  });
test("requires both abandon evidence tables before the reconciliation phase can terminalize", async () => {
    const { store } = await fixture();
    const prepared = prepareDedicatedSessionSwitch(store, 707);
    advanceDedicatedSessionSwitch(store, prepared, "target_started");
    store.markSessionSwitchReconciliationRequired({
      ...prepared.cas,
      expectedPhase: "target_started",
      diagnosticCode: "TARGET_STATE_UNEXPECTED",
    });
    const session = store.requireSession(prepared.session.id);
    const captured = store.requireCapturedSessionProviderAuthority(prepared.session.id);
    const terminal = { ...session, state: "terminal", revision: session.revision + 1 };
    const inspector = new Database(store.paths.database, { create: false, strict: true });
    try {
      inspector.query(
        `INSERT INTO session_switch_abandon_receipts(
           attempt_id,provider_account_id,profile_id,provider,binding_generation,
           process_generation,authority_revision,expected_session_revision,
           terminal_session_revision,session_json,recorded_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        prepared.switch.attemptId,
        captured.providerAccountId,
        captured.profileId,
        captured.provider,
        captured.bindingGeneration,
        captured.processGeneration,
        captured.authorityRevision,
        session.revision,
        terminal.revision,
        JSON.stringify(terminal),
        50_000,
      );
      expect(() => inspector.query(
        "UPDATE session_switch_attempts SET phase='abandoned' WHERE attempt_id=?",
      ).run(prepared.switch.attemptId)).toThrow("illegal session switch transition");
    } finally {
      inspector.close(false);
    }
    expect(() => store.requireSessionSwitch(prepared.switch.attemptId))
      .toThrow("SESSION_SWITCH_RECOVERY_CORRUPT");
  });
test("dispositions every dedicated switch crash phase before daemon authority retirement", async () => {
    const { store } = await fixture();
    const sourceProfile = signInProfile(store, "Restart source", "restart-source@example.com");
    const targetProfile = signInProfile(store, "Restart target", "restart-target@example.com");
    const phases = [
      "prepared",
      "target_starting",
      "target_started",
      "source_releasing",
      "source_released",
      "rebound",
      "seed_dispatching",
    ] as const;
    const attempts = phases.map((phase, index) => {
      const prepared = prepareDedicatedSessionSwitch(store, 720 + index, {
        sourceProfile,
        targetProfile,
      });
      if (phase !== "prepared") advanceDedicatedSessionSwitch(store, prepared, phase);
      return { phase, prepared };
    });

    expect(store.nextDaemonGeneration("phase4-restart-boot")).toBe(1);
    for (const { phase, prepared } of attempts) {
      const record = store.requireSessionSwitch(prepared.switch.attemptId);
      if (phase === "prepared") {
        expect(record.phase).toBe("cancelled");
      } else {
        expect(record).toMatchObject({
          phase: "reconciliation_required",
          diagnosticCode: "DAEMON_RESTART_AUTHORITY_RETIRED",
        });
        expect(store.requireSession(prepared.session.id).state).toBe("recovery_required");
        if (phase === "rebound") {
          const captured = store.requireCapturedSessionProviderAuthority(prepared.session.id);
          expect(() => store.beginSessionSwitchSeedDispatch({
            ...prepared.cas,
            seedAuthority: prepared.cas.targetAuthority,
            seedAuthorityRevision: captured.authorityRevision,
            seedDigest: prepared.switch.transcript.seedDigest,
            clientMessageId: prepared.switch.transcript.seedClientMessageId,
          })).toThrow("SESSION_SWITCH_PHASE_CONFLICT");
        }
      }
    }
    expect(store.recoverSessionSwitchesPage().switches).toEqual([]);
  });
test("contains a malformed current prepared locator through explicit daemon recovery", async () => {
    const { store } = await fixture();
    const prepared = prepareDedicatedSessionSwitch(store, 727);
    const malformedAttemptId = `attempt_${"a".repeat(31)}g`;
    const database = new Database(store.paths.database, { create: false, strict: true });
    const restoreGuard = restoreSwitchGuardsForTest(database, [
      "session_switch_attempt_id_repair_guard", "session_switch_adoption_parent_update",
    ]);
    const before = snapshotSwitchContainmentForTest(database);
    try {
      database.exec(`
        PRAGMA foreign_keys=OFF;
        PRAGMA ignore_check_constraints=ON;
        DROP TRIGGER session_switch_attempt_id_repair_guard;
        DROP TRIGGER session_switch_adoption_parent_update;
      `);
      database.query(
        "UPDATE session_switch_attempts SET attempt_id=? WHERE attempt_id=?",
      ).run(malformedAttemptId, prepared.switch.attemptId);
      database.exec("PRAGMA ignore_check_constraints=OFF; PRAGMA foreign_keys=ON;");
    } finally {
      restoreGuard();
      const after = snapshotSwitchContainmentForTest(database);
      expect(after.schema).toEqual(before.schema);
      expect(after.rows.filter(({ name }) => name !== "session_switch_attempts"))
        .toEqual(before.rows.filter(({ name }) => name !== "session_switch_attempts"));
      database.close(false);
    }

    expect(store.nextDaemonGeneration("malformed-switch-boot")).toBe(1);
    const inspector = new Database(store.paths.database, { create: false, strict: true });
    try {
      expect(inspector.query(
        `SELECT switch.attempt_id,switch.phase,mutation.state,
                malformed.mutation_request_key
         FROM session_switch_attempts switch
         JOIN mutation_attempts mutation ON mutation.id=switch.attempt_id
         JOIN session_switch_malformed_dispositions malformed
           ON malformed.journal_sequence=switch.journal_sequence
         WHERE switch.session_id=?`,
      ).get(prepared.session.id)).toEqual({
        attempt_id: prepared.switch.attemptId,
        phase: "cancelled",
        state: "cancelled",
        mutation_request_key: prepared.switch.idempotencyKey,
      });
    } finally {
      inspector.close(false);
    }
  });
test("rejects current active switch id relocation without blocking unrelated recovery", async () => {
    const { store } = await fixture();
    const targeted = prepareDedicatedSessionSwitch(store, 734);
    advanceDedicatedSessionSwitch(store, targeted, "target_starting");
    const unrelated = prepareDedicatedSessionSwitch(store, 735);
    advanceDedicatedSessionSwitch(store, unrelated, "target_starting");
    const inspector = new Database(store.paths.database, { create: false, strict: true });
    try {
      const before = snapshotSwitchContainmentForTest(inspector);
      inspector.exec("PRAGMA foreign_keys=OFF; PRAGMA ignore_check_constraints=ON");
      try {
        // Keep the new execution-context guard installed. Even bypassing the
        // older locator/adoption guards cannot move an active anchored parent.
        withRemovedTestGuards(inspector, [
          "session_switch_attempt_id_repair_guard", "session_switch_adoption_parent_update",
        ], () => {
          expect(() => inspector.query("UPDATE session_switch_attempts SET attempt_id=? WHERE attempt_id=?")
            .run("attempt_" + "a".repeat(4096), targeted.switch.attemptId))
            .toThrow("SESSION_SWITCH_EXECUTION_CONTEXT_CORRUPT");
        });
      } finally { inspector.exec("PRAGMA ignore_check_constraints=OFF; PRAGMA foreign_keys=ON"); }
      expect(snapshotSwitchContainmentForTest(inspector)).toEqual(before);
      expect(inspector.query("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally { inspector.close(false); }

    const recovery = store.recoverSessionSwitchesPage();
    expect(recovery.malformedAttemptIds).toEqual([]);
    expect(recovery.switches.map(({ attemptId }) => attemptId).sort())
      .toEqual([targeted.switch.attemptId, unrelated.switch.attemptId].sort());
    for (const prepared of [targeted, unrelated]) {
      expect(store.requireSessionSwitch(prepared.switch.attemptId)).toMatchObject({
        phase: "reconciliation_required", diagnosticCode: "TARGET_START_OUTCOME_UNKNOWN",
      });
      expect(store.requireSession(prepared.session.id).state).toBe("recovery_required");
    }
  });
test("contains an oversized prepared id from authentic combined49 without fabricating an effect", async () => {
    const paths = await combined49SwitchArchiveForTest();
    const captured = combined49SwitchFixture;
    const originalSwitch = captured.prepared.switch;
    const oversizedAttemptId = "attempt_" + "b".repeat(4096);
    const corrupt = new Database(paths.database, { create: false, strict: true });
    let journalSequence: number;
    try {
      journalSequence = z.object({ journal_sequence: z.number().int().positive() }).strict().parse(
        corrupt.query("SELECT journal_sequence FROM session_switch_attempts WHERE attempt_id=?").get(originalSwitch.attemptId),
      ).journal_sequence;
      corruptCombined49SwitchRowsForTest(corrupt, ["session_switch_attempts"], [
        "session_switch_attempt_id_repair_guard", "session_switch_adoption_parent_update",
      ], () => {
        corrupt.query("UPDATE session_switch_attempts SET attempt_id=? WHERE attempt_id=?")
          .run(oversizedAttemptId, originalSwitch.attemptId);
      });
      expect(corrupt.query("SELECT phase FROM session_switch_attempts").get()).toEqual({ phase: "prepared" });
      const before = snapshotSwitchContainmentForTest(corrupt);
      expect(() => new StateStore(paths, { readonly: true })).toThrow("STATE_SCHEMA_MIGRATION_REQUIRED:49:61");
      expect(snapshotSwitchContainmentForTest(corrupt)).toEqual(before);
    } finally { corrupt.close(false); }

    const store = new StateStore(paths, { now: () => originalSwitch.createdAt + 1 });
    stores.push(store);
    expect(store.requireSession(captured.session.id)).toMatchObject(captured.session);
    const inspector = new Database(paths.database, { create: false, strict: true });
    try {
      expect(inspector.query("SELECT journal_sequence,attempt_id,phase,diagnostic_code FROM session_switch_attempts").get())
        .toEqual({ journal_sequence: journalSequence, attempt_id: originalSwitch.attemptId,
          phase: "cancelled", diagnostic_code: "MALFORMED_SWITCH_RECORD" });
      expect(inspector.query("SELECT state FROM mutation_attempts WHERE id=?").get(originalSwitch.attemptId))
        .toEqual({ state: "cancelled" });
      expect(inspector.query("SELECT journal_sequence,mutation_request_key,terminal_phase FROM session_switch_malformed_dispositions").all())
        .toEqual([{ journal_sequence: journalSequence, mutation_request_key: originalSwitch.idempotencyKey, terminal_phase: "cancelled" }]);
      expect(inspector.query("SELECT * FROM session_switch_execution_contexts").all()).toEqual([]);
      expect(inspector.query("SELECT * FROM session_switch_target_start_receipts").all()).toEqual([]);
      expect(inspector.query("SELECT * FROM session_switch_target_start_anchors").all()).toEqual([]);
      expect(inspector.query("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(() => store.readSessionSwitchByIdempotencyKey(originalSwitch.idempotencyKey))
        .toThrow("SESSION_SWITCH_RECOVERY_CORRUPT");
      expect(store.readSessionSwitchForRecovery(captured.session.id)).toBeNull();
      // Startup already contained this historical prepared row; no later
      // recovery page should publish its attacker-controlled oversized id.
      expect(store.recoverSessionSwitchesPage()).toEqual({ switches: [], malformedAttemptIds: [], nextJournalSequence: null });
      store.close();
      stores.splice(stores.indexOf(store), 1);
      inspector.exec("VACUUM");
      const before = snapshotSwitchContainmentForTest(inspector);
      for (const readonly of [true, false]) {
        const reopened = new StateStore(paths, { readonly, now: () => originalSwitch.createdAt + 2 });
        try {
          expect(reopened.readSessionSwitchForRecovery(captured.session.id)).toBeNull();
          expect(() => reopened.readSessionSwitchByIdempotencyKey(originalSwitch.idempotencyKey))
            .toThrow("SESSION_SWITCH_RECOVERY_CORRUPT");
        } finally { reopened.close(); }
        expect(snapshotSwitchContainmentForTest(inspector)).toEqual(before);
      }
    } finally { inspector.close(false); }
  });
test.each(["intact", "missing_context", "missing_context_anchor", "context_digest", "plan_digest"] as const)(
    "refuses a current prepared switch with an orphan effect anchor without startup writes: %s", async (damage) => {
    const { store } = await fixture();
    const prepared = prepareDedicatedSessionSwitch(store, 777);
    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);
    expectInertSwitchReopenForTest(paths, prepared.switch);
    const inspector = new Database(paths.database, { create: false, strict: true });
    try {
      const readOriginalProof = () => ({
        capsule: inspector.query("SELECT * FROM session_switch_adoption_capsules WHERE attempt_id=?").get(prepared.switch.attemptId),
        anchor: inspector.query("SELECT * FROM session_switch_adoption_anchors WHERE attempt_id=?").get(prepared.switch.attemptId),
        context: inspector.query("SELECT * FROM session_switch_execution_contexts WHERE attempt_id=?").get(prepared.switch.attemptId),
        contextAnchor: inspector.query("SELECT * FROM session_switch_execution_context_anchors WHERE attempt_id=?").get(prepared.switch.attemptId),
        authorities: inspector.query("SELECT * FROM mutation_provider_authorities WHERE attempt_id=? ORDER BY role").all(prepared.switch.attemptId),
      });
      const originalProof = readOriginalProof();
      expect(originalProof.capsule).toMatchObject({ kind: "exact_v1" });
      expect(originalProof.authorities).toHaveLength(2);
      const originalMutation = inspector.query("SELECT * FROM mutation_attempts WHERE id=?").get(prepared.switch.attemptId);
      const originalJournal = inspector.query("SELECT * FROM session_switch_attempts WHERE attempt_id=?").get(prepared.switch.attemptId);
      const restore = restoreSwitchGuardsForTest(inspector, ["session_switch_target_start_anchors_insert_guard"]);
      inspector.exec("DROP TRIGGER session_switch_target_start_anchors_insert_guard");
      try {
        // Deliberate single-table corruption: the effect receipt is absent,
        // but an independent anchor remains. Its FK only names the journal;
        // neither that FK nor the missing receipt proves no dispatch occurred.
        inspector.query("INSERT INTO session_switch_target_start_anchors(attempt_id,result_digest,recorded_at) VALUES(?,?,?)")
          .run(prepared.switch.attemptId, "a".repeat(64), 9_000);
      } finally { restore(); }
      expect(inspector.query("PRAGMA foreign_key_check").all()).toEqual([]);
      const orphanAnchor = inspector.query("SELECT * FROM session_switch_target_start_anchors WHERE attempt_id=?").get(prepared.switch.attemptId);
      const retained = () => ({
        proof: readOriginalProof(),
        mutation: inspector.query("SELECT * FROM mutation_attempts WHERE id=?").get(prepared.switch.attemptId),
        journal: inspector.query("SELECT * FROM session_switch_attempts WHERE attempt_id=?").get(prepared.switch.attemptId),
        effectAnchor: inspector.query("SELECT * FROM session_switch_target_start_anchors WHERE attempt_id=?").get(prepared.switch.attemptId),
        targetReceipts: inspector.query("SELECT * FROM session_switch_target_start_receipts").all(),
        noEffectReceipts: inspector.query("SELECT * FROM session_switch_no_effect_receipts").all(),
        seedAuthorities: inspector.query("SELECT * FROM session_switch_seed_authorities").all(),
        seedReceipts: inspector.query("SELECT * FROM session_switch_seed_receipts").all(),
      });
      expect(retained()).toEqual({ proof: originalProof, mutation: originalMutation, journal: originalJournal,
        effectAnchor: orphanAnchor, targetReceipts: [], noEffectReceipts: [], seedAuthorities: [], seedReceipts: [] });
      if (damage !== "intact") {
        const guard = damage === "missing_context" ? "session_switch_execution_contexts_delete"
          : damage === "missing_context_anchor" ? "session_switch_execution_context_anchors_delete"
          : damage === "context_digest" ? "session_switch_execution_contexts_update"
          : "session_switch_plan_anchors_immutable_update";
        const restore = restoreSwitchGuardsForTest(inspector, [guard]);
        inspector.exec(`PRAGMA foreign_keys=OFF; DROP TRIGGER ${guard}`);
        try {
          if (damage === "missing_context") inspector.query(
            "DELETE FROM session_switch_execution_contexts WHERE attempt_id=?").run(prepared.switch.attemptId);
          else if (damage === "missing_context_anchor") inspector.query(
            "DELETE FROM session_switch_execution_context_anchors WHERE attempt_id=?").run(prepared.switch.attemptId);
          else if (damage === "context_digest") inspector.query(
            "UPDATE session_switch_execution_contexts SET context_digest=? WHERE attempt_id=?")
            .run("f".repeat(64), prepared.switch.attemptId);
          else inspector.query("UPDATE session_switch_plan_anchors SET plan_digest=? WHERE attempt_id=?")
            .run("f".repeat(64), prepared.switch.attemptId);
        } finally { restore(); inspector.exec("PRAGMA foreign_keys=ON"); }
      }
      // Current sealed journals refuse before recovery can manufacture a
      // disposition or no-effect receipt. Context damage is an earlier fence;
      // only the intact-context case reaches the orphan-anchor mapper check.
      expect(inspector.query("SELECT * FROM session_switch_malformed_dispositions").all()).toEqual([]);
      const corrupted = snapshotSwitchContainmentForTest(inspector);
      for (const readonly of [true, false]) {
        expect(() => new StateStore(paths, { readonly, now: () => 9_300 }))
          .toThrow(damage === "intact"
            ? "SESSION_SWITCH_RECOVERY_CORRUPT" : "SESSION_SWITCH_EXECUTION_CONTEXT_CORRUPT");
        expect(snapshotSwitchContainmentForTest(inspector)).toEqual(corrupted);
      }
    } finally { inspector.close(false); }
  });
test.each(["missing_anchor", "ambiguous_association", "wrong_disposition"] as const)(
    "refuses unproved switch containment without writes: %s", async (scenario) => {
      const { store } = await fixture();
      const prepared = prepareDedicatedSessionSwitch(store, 776);
      const alternateKey = "40000000-0000-4000-8000-000000000776";
      if (scenario === "ambiguous_association") {
        // A second real mutation is an independent key owner, not a fabricated
        // replacement receipt or a reason to choose the journal's other ID.
        store.prepareMutation({ kind: "test.containment-conflict", authorityId: "independent-containment-key-owner",
          authorityGeneration: prepared.cas.sourceAuthority.processGeneration,
          idempotencyKey: alternateKey, request: { purpose: "independent-key-owner" } });
      }
      const paths = store.paths;
      store.close();
      stores.splice(stores.indexOf(store), 1);
      const corrupt = new Database(paths.database, { create: false, strict: true });
      try {
        if (scenario === "missing_anchor") {
          const restore = restoreSwitchGuardsForTest(corrupt, ["session_switch_adoption_anchors_delete"]);
          corrupt.exec("PRAGMA foreign_keys=OFF; DROP TRIGGER session_switch_adoption_anchors_delete");
          try { corrupt.query("DELETE FROM session_switch_adoption_anchors WHERE attempt_id=?").run(prepared.switch.attemptId); }
          finally { restore(); }
        } else if (scenario === "ambiguous_association") {
          const restore = restoreSwitchGuardsForTest(corrupt, [
            "session_switch_attempts_immutable_update", "session_switch_adoption_parent_update",
          ]);
          corrupt.exec("DROP TRIGGER session_switch_attempts_immutable_update; DROP TRIGGER session_switch_adoption_parent_update");
          try { corrupt.query("UPDATE session_switch_attempts SET request_key=?,source_process_generation=source_process_generation+1 WHERE attempt_id=?")
            .run(alternateKey, prepared.switch.attemptId); }
          finally { restore(); }
        } else {
          // The old insertion guard allows this shape, but the prepared
          // mutation is not cancelled and the original session is not fenced.
          // Mere presence of a disposition cannot authorize final recognition.
          corrupt.query(`INSERT INTO session_switch_malformed_dispositions(
            journal_sequence,mutation_request_key,session_id,from_phase,terminal_phase,
            diagnostic_code,evidence_depth,recorded_at)
            SELECT journal_sequence,request_key,session_id,'prepared','reconciliation_required',
              'MALFORMED_SWITCH_RECORD',0,9000 FROM session_switch_attempts WHERE attempt_id=?`)
            .run(prepared.switch.attemptId);
        }
      } finally { corrupt.close(false); }
      const inspector = new Database(paths.database, { create: false, strict: true });
      try {
        const before = snapshotSwitchContainmentForTest(inspector);
        for (const readonly of [true, false]) {
          expect(() => new StateStore(paths, { now: () => 9_200, readonly })).toThrow();
          expect(snapshotSwitchContainmentForTest(inspector)).toEqual(before);
        }
      } finally { inspector.close(false); }
    },
  );
test("refuses a relocated authentic combined49 prepared parent without rewriting adoption proof", async () => {
    const paths = await combined49SwitchArchiveForTest();
    const prepared = combined49SwitchFixture.prepared;
    const oversizedAttemptId = "attempt_" + "c".repeat(4096);
    const corrupt = new Database(paths.database, { create: false, strict: true });
    try {
      corruptCombined49SwitchRowsForTest(corrupt, [
        "session_switch_attempts", "session_switch_plan_anchors", "mutation_provider_authorities", "mutation_attempts",
      ], [
        "session_switch_attempt_id_repair_guard", "session_switch_plan_anchors_immutable_update",
        "mutation_provider_authorities_immutable_update", "session_switch_adoption_parent_update",
      ], () => {
        for (const table of ["session_switch_attempts", "session_switch_plan_anchors", "mutation_provider_authorities"]) {
          corrupt.query("UPDATE " + table + " SET attempt_id=? WHERE attempt_id=?")
            .run(oversizedAttemptId, prepared.switch.attemptId);
        }
        corrupt.query("UPDATE mutation_attempts SET id=? WHERE id=?").run(oversizedAttemptId, prepared.switch.attemptId);
      });
      // This is explicit adversarial row relocation, not output of the old
      // writer. Its genuine independent capsule still binds the ORIGINAL id.
      expect(corrupt.query("SELECT attempt_id FROM session_switch_adoption_capsules").all())
        .toEqual([{ attempt_id: prepared.switch.attemptId }]);
      expect(corrupt.query("SELECT phase FROM session_switch_attempts").get()).toEqual({ phase: "prepared" });
      expect(corrupt.query("PRAGMA foreign_key_check").all()).toHaveLength(1);
    } finally { corrupt.close(false); }

    const inspect = new Database(paths.database, { create: false, strict: true });
    try {
      const before = snapshotSwitchContainmentForTest(inspect);
      for (const readonly of [true, false]) {
        expect(() => new StateStore(paths, { now: () => prepared.switch.createdAt + 1, readonly })).toThrow();
        expect(snapshotSwitchContainmentForTest(inspect)).toEqual(before);
      }
      inspect.exec("VACUUM");
      const afterVacuum = snapshotSwitchContainmentForTest(inspect);
      expect(afterVacuum).toEqual(before);
      expect(() => new StateStore(paths, { now: () => prepared.switch.createdAt + 2 })).toThrow();
      expect(snapshotSwitchContainmentForTest(inspect)).toEqual(afterVacuum);
    } finally { inspect.close(false); }
  });
test("refuses an adversarial joined-schema v42 restamp without rewriting switch evidence", async () => {
    const value = await fixture({ provision: "migrate" });
    const prepared = prepareDedicatedSessionSwitch(value.store, 739);
    advanceDedicatedSessionSwitch(value.store, prepared, "target_starting");
    const paths = value.store.paths;
    value.store.close();
    stores.splice(stores.indexOf(value.store), 1);
    const corrupt = new Database(paths.database, { create: false, strict: true });
    try {
      // This is not an archived v42 producer: retain all joined proof objects.
      // The context guard independently rejects a forged parent identifier.
      const before = snapshotSwitchContainmentForTest(corrupt);
      expect(() => corrupt.query("UPDATE session_switch_attempts SET attempt_id=? WHERE attempt_id=?")
        .run(`attempt_${"e".repeat(4096)}`, prepared.switch.attemptId))
        .toThrow("SESSION_SWITCH_EXECUTION_CONTEXT_CORRUPT");
      expect(snapshotSwitchContainmentForTest(corrupt)).toEqual(before);
      corrupt.exec("DELETE FROM migrations WHERE version>42; PRAGMA user_version=42");
    } finally { corrupt.close(false); }
    expectInertSchemaRefusal(paths, "STATE_SCHEMA_COHORT_UNSUPPORTED:42", "STATE_SCHEMA_MIGRATION_REQUIRED:42:61");
  });
test("keeps the switch journal sequence bounded and immutable", async () => {
    const { store } = await fixture();
    const prepared = prepareDedicatedSessionSwitch(store, 738);
    const database = new Database(store.paths.database, { create: false, strict: true });
    try {
      expect(() => database.query(
        `UPDATE session_switch_attempts
         SET journal_sequence=journal_sequence+100 WHERE attempt_id=?`,
      ).run(prepared.switch.attemptId)).toThrow("session switch immutable plan changed");
      database.exec("DROP TRIGGER session_switch_attempts_immutable_update");
      expect(() => database.query(
        "UPDATE session_switch_attempts SET journal_sequence=0 WHERE attempt_id=?",
      ).run(prepared.switch.attemptId)).toThrow();
    } finally {
      database.close(false);
    }
  });
test("paginates more than one hundred malformed switch journals by stable sequence", async () => {
    const { store } = await fixture();
    const sourceProfile = signInProfile(store, "Malformed page source", "malformed-page-source@example.com");
    const targetProfile = signInProfile(store, "Malformed page target", "malformed-page-target@example.com");
    const prepared = Array.from({ length: 101 }, (_, index) =>
      prepareDedicatedSessionSwitch(store, 800 + index, { sourceProfile, targetProfile }));
    const database = new Database(store.paths.database, { create: false, strict: true });
    const restoreGuard = restoreSwitchGuardsForTest(database, [
      "session_switch_attempt_id_repair_guard", "session_switch_adoption_parent_update",
    ]);
    try {
      database.exec(`
        PRAGMA foreign_keys=OFF;
        PRAGMA ignore_check_constraints=ON;
        DROP TRIGGER session_switch_attempt_id_repair_guard;
        DROP TRIGGER session_switch_adoption_parent_update;
      `);
      const corrupt = database.query(
        "UPDATE session_switch_attempts SET attempt_id=? WHERE attempt_id=?",
      );
      database.transaction(() => {
        for (const [index, value] of prepared.entries()) {
          corrupt.run(`malformed-switch-${String(index).padStart(3, "0")}`, value.switch.attemptId);
        }
      }).immediate();
      database.exec("PRAGMA ignore_check_constraints=OFF; PRAGMA foreign_keys=ON;");
    } finally {
      restoreGuard();
      database.close(false);
    }

    const first = store.recoverSessionSwitchesPage({ limit: 100 });
    expect(first.switches).toEqual([]);
    expect(first.malformedAttemptIds).toHaveLength(100);
    expect(first.nextJournalSequence).not.toBeNull();
    const second = store.recoverSessionSwitchesPage({
      afterJournalSequence: first.nextJournalSequence!,
      limit: 100,
    });
    expect(second.switches).toEqual([]);
    expect(second.malformedAttemptIds).toHaveLength(1);
    expect(second.nextJournalSequence).toBeNull();
    const inspector = new Database(store.paths.database, { create: false, strict: true });
    try {
      expect(inspector.query(
        "SELECT COUNT(*) AS count FROM session_switch_malformed_dispositions",
      ).get()).toEqual({ count: 101 });
      expect(inspector.query(
        `SELECT COUNT(*) AS count FROM session_switch_attempts
         WHERE phase NOT IN ('seed_settled','reconciliation_required','failed','cancelled','abandoned')`,
      ).get()).toEqual({ count: 0 });
      expect(inspector.query("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      inspector.close(false);
    }
  });
test("creates the main database as an exact private single-link file", async () => {
    const { store } = await fixture();
    const metadata = await lstat(store.paths.database);

    expect(metadata.isFile()).toBe(true);
    expect(metadata.isSymbolicLink()).toBe(false);
    expect(metadata.nlink).toBe(1);
    expect(metadata.mode & 0o777).toBe(0o600);
    const owner = process.getuid?.();
    if (owner !== undefined) expect(metadata.uid).toBe(owner);
  });
test("fails closed without chmod when an existing database is permission-unsafe", async () => {
    const { store } = await fixture();
    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);
    await chmod(paths.database, 0o644);

    expect(() => new StateStore(paths)).toThrow("STATE_DATABASE_FILE_UNSAFE");
    expect(() => new StateStore(paths, { readonly: true }))
      .toThrow("STATE_DATABASE_FILE_UNSAFE");
    expect((await lstat(paths.database)).mode & 0o777).toBe(0o644);
  });
test("refuses a symlink at the main database boundary before SQLite opens it", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "oompa-store-link-")));
    const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
    await initializeStatePaths(paths);
    const target = join(paths.root, "database-target");
    await writeFile(target, "not-a-database", { mode: 0o600 });
    await symlink(target, paths.database);

    expect(() => new StateStore(paths)).toThrow("STATE_DATABASE_FILE_UNSAFE");
    expect(await Bun.file(target).text()).toBe("not-a-database");
  });
test("refuses a symlink swapped in after the main database precheck", async () => {
    const { store } = await fixture();
    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const original = `${paths.database}.validated`;
    const target = `${paths.database}.target`;
    await writeFile(target, "target-must-remain-untouched", { mode: 0o600 });
    let observedFlags = 0;

    let failure: unknown;
    try {
      new StateStore(paths, {
        beforeDatabaseOpen: ({ flags, path }) => {
          observedFlags = flags;
          renameSync(path, original);
          symlinkSync(target, path);
        },
      });
    } catch (error: unknown) {
      failure = error;
    }

    expect(observedFlags).toBe(
      sqliteConstants.SQLITE_OPEN_READWRITE
        | sqliteConstants.SQLITE_OPEN_CREATE
        | sqliteConstants.SQLITE_OPEN_NOFOLLOW,
    );
    expect(failure).toMatchObject({
      code: "SQLITE_CANTOPEN_SYMLINK",
      errno: 1_550,
    });
    expect(await Bun.file(target).text()).toBe("target-must-remain-untouched");
    const originalMetadata = await lstat(original);
    expect(originalMetadata.isFile()).toBe(true);
    expect(originalMetadata.nlink).toBe(1);
    expect(originalMetadata.mode & 0o777).toBe(0o600);
  });
test("isolates profiles and fences process generations", async () => {
    const { store } = await fixture();
    const work = store.createProfile("Work");
    const personal = store.createProfile("Personal");
    expect(work.id).not.toBe(personal.id);
    expect(store.nextProfileGeneration(work.id).processGeneration).toBe(1);
    expect(store.setProfileState(work.id, 0, "signed_in")).toBe(false);
    expect(store.setProfileState(work.id, 1, "signed_in", { email: "work@example.com", plan: "Plus" })).toBe(true);
    expect(store.requireProfile("work").providerEmail).toBe("work@example.com");
  });
test("drives Devin binding routing, readiness, and session authority like any provider", async () => {
    const { store } = await fixture();
    const first = store.createProfile("Devin first route");
    const second = store.createProfile("Devin second route");
    const firstDevin = store.requireProviderAccountForProfile(first.id, "devin");
    const secondDevin = store.requireProviderAccountForProfile(second.id, "devin");
    expect(firstDevin.id).toMatch(/^dact_[0-9a-f]{32}$/u);
    expect(secondDevin.id).not.toBe(firstDevin.id);
    for (const account of [firstDevin, secondDevin]) {
      expect(account).toMatchObject({ readiness: "unverified", bindingGeneration: 1, processGeneration: 0 });
    }
    let state = store.readProviderAccountState("devin");
    store.replaceProviderAccountOrder({
      provider: "devin", expectedOrderRevision: state.orderRevision,
      providerAccountIds: [secondDevin.id, firstDevin.id],
    });
    state = store.readProviderAccountState("devin");
    store.activateProviderAccount({
      provider: "devin", expectedPointerRevision: state.pointerRevision,
      providerAccountId: secondDevin.id,
    });
    expect(store.readProviderAccountState("devin").activeProviderAccountId).toBe(secondDevin.id);
    store.observeProviderAccountReadiness({
      profileId: second.id, provider: "devin", expectedBindingGeneration: secondDevin.bindingGeneration,
      readiness: "signed_in",
    });
    const session = store.createSession({ provider: "devin", preset: "astra", fastEnabled: false, routing: "managed" });
    expect(session.provider).toBe("devin");
    expect(() => store.latestProviderUsage(secondDevin.id)).toThrow();
    expect(() => store.providerUsageObservations({ providerAccountId: secondDevin.id })).toThrow();
    expect(store.requireProviderAccountForProfile(first.id, "devin"))
      .toMatchObject({ id: firstDevin.id, orderPosition: 2 });
  });
test("refuses compatibility-shadow confusion on authentic retired Devin session history", async () => {
    const paths = await archivedRetired49();
    const store = new StateStore(paths);
    stores.push(store);
    const session = store.requireSession(combined49RetiredFixture.close.session.id);
    expect(session.provider).toBe("devin");
    const database = new Database(paths.database, { create: false, strict: true });
    try {
      const beforeGuardedUpdate = canonicalAuthBudgetSnapshot(database);
      expect(() => database.query("UPDATE sessions SET provider='claude' WHERE id=?").run(session.id))
        .toThrow("session provider compatibility shadow mismatch");
      expect(canonicalAuthBudgetSnapshot(database)).toEqual(beforeGuardedUpdate);
      const guard = (database.query("SELECT sql FROM sqlite_schema WHERE name='session_provider_compatibility_update_guard'").get() as { sql: string }).sql;
      // Adversarial row damage follows real archived admission; it is never
      // presented as a new historical capture or as provider execution.
      withRemovedTestGuards(database, ["session_provider_compatibility_update_guard"], () => {
        database.query("UPDATE sessions SET provider='claude' WHERE id=?").run(session.id);
      });
      expect(database.query("SELECT sql FROM sqlite_schema WHERE name='session_provider_compatibility_update_guard'").get())
        .toEqual({ sql: guard });
      const beforeRefusal = canonicalAuthBudgetSnapshot(database);
      expect(() => store.requireSession(session.id)).toThrow("SESSION_PROVIDER_COMPATIBILITY_SHADOW_MISMATCH");
      for (const readonly of [true, false]) {
        expect(() => new StateStore(paths, { readonly })).toThrow("SESSION_PROVIDER_COMPATIBILITY_SHADOW_MISMATCH");
        expect(canonicalAuthBudgetSnapshot(database)).toEqual(beforeRefusal);
      }
    } finally { database.close(false); }
  });
test("keeps provider bindings independent across login, ordering, routing, and removal", async () => {
    const { store } = await fixture();
    const first = store.createProfile("First binding");
    const second = store.createProfile("Second binding");
    const removable = store.createProfile("Removable binding");

    const firstCodex = store.requireProviderAccountForProfile(first.id, "codex");
    const firstClaude = store.requireProviderAccountForProfile(first.id, "claude");
    const secondCodex = store.requireProviderAccountForProfile(second.id, "codex");
    const secondClaude = store.requireProviderAccountForProfile(second.id, "claude");
    const removableCodex = store.requireProviderAccountForProfile(removable.id, "codex");
    const removableClaude = store.requireProviderAccountForProfile(removable.id, "claude");
    expect(firstCodex).toMatchObject({
      id: first.id,
      bindingGeneration: 1,
      orderPosition: 1,
      readiness: "signed_out",
    });
    expect(firstClaude).toMatchObject({
      bindingGeneration: 1,
      orderPosition: 1,
      profileId: first.id,
      readiness: "unverified",
    });
    expect(firstClaude.id).not.toBe(first.id);

    const source = store.requireProviderAccountAuthority(second.id, "codex");
    completeCodexAccountMutationAuthorityRetirement(store, second.id, source.processGeneration);
    const login = store.prepareMutation({
      authorityGeneration: 1,
      authorityId: second.id,
      idempotencyKey: "00000000-0000-4000-8000-00000000035a",
      kind: "account.login",
      providerAuthorities: [{
        authority: source,
        provenance: "account_login_source",
        role: "source",
      }],
      request: { deviceCode: false },
    });
    store.beginAccountMutationEffect({
      attemptId: login.id,
      evidence: { kind: "account.login", method: "browser" },
      profileGeneration: 1,
      profileId: second.id,
      providerAuthority: source,
    });
    const pending = store.requireProviderAccountAuthority(second.id, "codex");
    expect(pending).toMatchObject({ bindingGeneration: 2, processGeneration: 1 });
    expect(() => store.assertProviderAccountAuthorityCurrent(source))
      .toThrow("PROVIDER_ACCOUNT_AUTHORITY_STALE");
    store.completeAccountLoginMutation({
      attemptId: login.id,
      processGeneration: 1,
      profileId: second.id,
      receipt: {
        account: { email: "second@example.com", plan: "Plus", signedIn: true },
        status: "signed_in",
      },
    });
    const signedInCodex = store.requireProviderAccountAuthority(second.id, "codex");
    expect(signedInCodex).toMatchObject({ bindingGeneration: 3, processGeneration: 1 });
    expect(store.readMutationProviderAuthorities(login.id).map((value) => ({
      bindingGeneration: value.authority.bindingGeneration,
      role: value.role,
    }))).toEqual([
      { bindingGeneration: 2, role: "primary" },
      { bindingGeneration: 1, role: "source" },
    ]);

    const codexBeforeClaudeObservation = store.requireProviderAccountAuthority(second.id, "codex");
    const observedClaude = store.observeProviderAccountReadiness({
      expectedBindingGeneration: secondClaude.bindingGeneration,
      observedAt: 5_000,
      profileId: second.id,
      provider: "claude",
      readiness: "signed_in",
    });
    expect(observedClaude).toMatchObject({ bindingGeneration: 2, readiness: "signed_in" });
    expect(() => store.observeProviderAccountReadiness({
      expectedBindingGeneration: observedClaude.bindingGeneration,
      observedAt: 4_999,
      profileId: second.id,
      provider: "claude",
      readiness: "signed_in",
    })).toThrow("PROVIDER_READINESS_OBSERVATION_STALE");
    expect(store.requireProviderAccountForProfile(second.id, "claude")).toMatchObject({
      bindingGeneration: observedClaude.bindingGeneration,
      readiness: "signed_in",
      readinessObservedAt: 5_000,
    });
    expect(store.requireProviderAccountAuthority(second.id, "codex"))
      .toEqual(codexBeforeClaudeObservation);

    const codexOrderBefore = store.listProviderAccounts("codex");
    const codexStateBefore = store.readProviderAccountState("codex");
    expect(() => store.replaceProviderAccountOrder({
      expectedOrderRevision: codexStateBefore.orderRevision,
      provider: "codex",
      providerAccountIds: [firstCodex.id, secondCodex.id],
    })).toThrow("PROVIDER_ACCOUNT_ORDER_INVALID");
    expect(() => store.replaceProviderAccountOrder({
      expectedOrderRevision: codexStateBefore.orderRevision,
      provider: "codex",
      providerAccountIds: [firstCodex.id, secondCodex.id, secondCodex.id],
    })).toThrow("PROVIDER_ACCOUNT_ORDER_INVALID");
    expect(() => store.replaceProviderAccountOrder({
      expectedOrderRevision: codexStateBefore.orderRevision,
      provider: "codex",
      providerAccountIds: [firstCodex.id, secondCodex.id, firstClaude.id],
    })).toThrow("PROVIDER_ACCOUNT_ORDER_INVALID");
    expect(store.listProviderAccounts("codex")).toEqual(codexOrderBefore);
    expect(store.readProviderAccountState("codex")).toEqual(codexStateBefore);
    const reorderedCodex = store.replaceProviderAccountOrder({
      expectedOrderRevision: codexStateBefore.orderRevision,
      provider: "codex",
      providerAccountIds: [secondCodex.id, removableCodex.id, firstCodex.id],
    });
    const activeCodex = store.activateProviderAccount({
      expectedPointerRevision: reorderedCodex.pointerRevision,
      provider: "codex",
      providerAccountId: secondCodex.id,
    });
    expect(() => store.activateProviderAccount({
      expectedPointerRevision: reorderedCodex.pointerRevision,
      provider: "codex",
      providerAccountId: firstCodex.id,
    })).toThrow("PROVIDER_ACTIVE_ACCOUNT_CONFLICT");
    const managed = store.createSession({
      fastEnabled: false,
      preset: "high",
      provider: "codex",
      routing: "managed",
    });
    expect(store.requireSessionProviderAuthority(managed.id)).toMatchObject({
      appliedPointerRevision: activeCodex.pointerRevision,
      profileId: second.id,
      providerAccountId: secondCodex.id,
      routingProvenance: "managed",
    });
    const explicit = store.createSession({
      fastEnabled: false,
      preset: "high",
      profileId: first.id,
      provider: "codex",
      routing: "explicit",
    });
    expect(store.requireSessionProviderAuthority(explicit.id)).toMatchObject({
      appliedPointerRevision: null,
      profileId: first.id,
      routingProvenance: "explicit",
    });
    expect(() => store.admitInteraction({
      authority: {
        approvalId: null,
        bindingGeneration: firstClaude.bindingGeneration,
        connectionId: "35000000-0000-4000-8000-000000000010",
        itemId: "provider-mismatch-item",
        method: "item/commandExecution/requestApproval",
        processGeneration: first.processGeneration,
        profileId: first.id,
        provider: "claude",
        providerAccountId: firstClaude.id,
        requestDigest: "8".repeat(64),
        requestId: { type: "string", value: "provider-mismatch-request" },
        threadId: "provider-mismatch-thread",
        turnId: "provider-mismatch-turn",
      },
      blocking: true,
      display: {
        availableDecisions: ["once", "session", "decline", "cancel"],
        commandClass: "test",
        kind: "command_approval",
        reason: null,
        summary: "Reject mismatched provider authority",
        workingDirectory: null,
      },
      kind: "command_approval",
      publicId: "35000000-0000-4000-8000-000000000011",
      sessionId: explicit.id,
    })).toThrow("INTERACTION_PROVIDER_AUTHORITY_MISMATCH");

    const codexBeforeRemoval = store.activateProviderAccount({
      expectedPointerRevision: activeCodex.pointerRevision,
      provider: "codex",
      providerAccountId: removableCodex.id,
    });
    const claudeState = store.readProviderAccountState("claude");
    const claudeBeforeRemoval = store.activateProviderAccount({
      expectedPointerRevision: claudeState.pointerRevision,
      provider: "claude",
      providerAccountId: removableClaude.id,
    });
    store.removeProfile(removable.id);
    expect(store.readProviderAccountState("codex")).toMatchObject({
      activeProviderAccountId: firstCodex.id,
      pointerRevision: codexBeforeRemoval.pointerRevision + 1,
    });
    expect(store.readProviderAccountState("claude")).toMatchObject({
      activeProviderAccountId: firstClaude.id,
      pointerRevision: claudeBeforeRemoval.pointerRevision + 1,
    });
    expect(store.requireProviderAccountForProfile(
      removable.id,
      "codex",
      { includeRemoved: true },
    )).toMatchObject({ orderPosition: null, readiness: "removed" });
    expect(store.requireProviderAccountForProfile(
      removable.id,
      "claude",
      { includeRemoved: true },
    )).toMatchObject({ orderPosition: null, readiness: "removed" });
    expect(store.listProviderAccounts("codex").map((account) => account.orderPosition))
      .toEqual([1, 2]);
  });
test("a new daemon boot fences every prior provider process and terminalizes callbacks", async () => {
    const { store } = await fixture();
    const profile = signInProfile(store, "Daemon restart", "restart@example.com");
    const session = upsertProvenTestSession(store, {
      profileId: profile.id,
      providerThreadId: "thread-restart",
      preset: "high",
      fastEnabled: false,
      state: "idle",
    });
    const sessionAuthorityBeforeRestart = store.requireSessionProviderAuthority(session.id);
    const admit = (publicId: string, requestId: string) => store.admitInteraction({
      publicId,
      sessionId: session.id,
      authority: {
        ...codexInteractionBinding(store, profile.id),
        profileId: profile.id,
        processGeneration: profile.processGeneration,
        connectionId: "10000000-0000-4000-8000-000000000001",
        requestId: { type: "string" as const, value: requestId },
        method: "item/fileChange/requestApproval",
        requestDigest: requestId.repeat(64).slice(0, 64),
        threadId: "thread-restart",
        turnId: "turn-restart",
        itemId: `item-${requestId}`,
        approvalId: null,
      },
      kind: "file_change_approval" as const,
      blocking: true,
      display: {
        kind: "file_change_approval" as const,
        summary: "Apply bounded changes",
        reason: null,
        grantRoot: null,
        availableDecisions: ["once" as const, "decline" as const, "cancel" as const],
      },
    }).record;
    const pending = admit("10000000-0000-4000-8000-000000000002", "a");
    const prepared = store.prepareInteractionResponse({
      id: admit("10000000-0000-4000-8000-000000000003", "b").publicId,
      expectedRevision: 1,
      responseDigest: "c".repeat(64),
    });

    expect(store.nextDaemonGeneration(`boot_${"d".repeat(32)}`)).toBe(1);
    expect(store.requireProfileById(profile.id).processGeneration).toBe(2);
    expect(store.requireSessionProviderAuthority(session.id)).toMatchObject({
      provider: "codex",
      providerAccountId: sessionAuthorityBeforeRestart.providerAccountId,
      profileId: sessionAuthorityBeforeRestart.profileId,
      bindingGeneration: sessionAuthorityBeforeRestart.bindingGeneration,
      processGeneration: 2,
    });
    const authorityRevision = new Database(store.paths.database, {
      create: false,
      readonly: true,
      strict: true,
    });
    try {
      expect(authorityRevision.query(
        "SELECT authority_revision FROM session_provider_authorities WHERE session_id=?",
      ).get(session.id)).toEqual({ authority_revision: 2 });
    } finally {
      authorityRevision.close(false);
    }
    expect(store.requireInteraction(pending.publicId)).toMatchObject({
      state: "expired",
      revision: 2,
    });
    expect(store.requireInteraction(prepared.publicId)).toMatchObject({
      state: "resolution_unknown",
      revision: 3,
    });
    expect(store.listSessionEvents({
      sessionId: session.id,
      afterSequence: null,
      limit: 10,
    }).events.map((event) => ({
      body: event.body,
      providerConnectionId: event.providerConnectionId,
      providerGeneration: event.providerGeneration,
    }))).toEqual([{
      body: {
        type: "gap",
        reason: "provider_restart",
        fromSequence: 1,
        throughSequence: 1,
      },
      providerConnectionId: null,
      providerGeneration: profile.processGeneration,
    }, {
      body: {
        type: "interaction_state",
        interactionId: pending.publicId,
        state: "expired",
        revision: 2,
      },
      providerConnectionId: pending.authority.connectionId,
      providerGeneration: profile.processGeneration,
    }, {
      body: {
        type: "interaction_state",
        interactionId: prepared.publicId,
        state: "resolution_unknown",
        revision: 3,
      },
      providerConnectionId: prepared.authority.connectionId,
      providerGeneration: profile.processGeneration,
    }]);
    expect(store.nextDaemonGeneration(`boot_${"e".repeat(32)}`)).toBe(2);
    expect(store.requireProfileById(profile.id).processGeneration).toBe(3);
    expect(store.requireSessionProviderAuthority(session.id)).toMatchObject({
      bindingGeneration: sessionAuthorityBeforeRestart.bindingGeneration,
      processGeneration: 3,
    });
  });
test("quarantines a generation-zero Claude session without inventing released-process authority on restart", async () => {
    const { store } = await fixture();
    const profile = store.createProfile("Unverified Claude restart");
    const session = store.createSession({
      fastEnabled: false,
      preset: "fable-max",
      profileId: profile.id,
      provider: "claude",
    });
    expect(store.requireSessionProviderAuthority(session.id)).toMatchObject({
      processGeneration: 0,
      provider: "claude",
    });

    const captured = store.requireCapturedSessionProviderAuthority(session.id);
    const bootId = `boot_${"c".repeat(32)}`;
    expect(store.nextDaemonGeneration(bootId)).toBe(1);
    expect(store.requireSession(session.id)).toMatchObject({ state: "recovery_required" });
    expect(store.requireCapturedSessionProviderAuthority(session.id)).toEqual(captured);
    expect(store.readSessionClaudeProcessAuthority(session.id, true)).toBeNull();
    const inspector = new Database(store.paths.database, { readonly: true });
    try {
      expect(inspector.query("SELECT * FROM session_provider_authority_successors WHERE session_id=?").all(session.id)).toEqual([]);
    } finally { inspector.close(false); }
    expect(store.listSessionEvents({
      afterSequence: 0,
      sessionId: session.id,
    }).events.map((event) => ({
      body: event.body,
      providerGeneration: event.providerGeneration,
    }))).toEqual([{
      body: {
        reason: "daemon_restart",
        state: "disconnected",
        type: "connection",
      },
      providerGeneration: 0,
    }, {
      body: {
        fromSequence: 2,
        reason: "provider_restart",
        throughSequence: 2,
        type: "gap",
      },
      providerGeneration: 0,
    }]);

    expect(store.nextDaemonGeneration(bootId)).toBe(1);
    expect(store.eventStreamPosition(session.id).observedThroughSequence).toBe(2);
    expect(store.requireCapturedSessionProviderAuthority(session.id)).toEqual(captured);
  });
test("adopts one exact graceful-close plus restart lineage once per boot identity", async () => {
    const { store } = await fixture();
    const profile = signInProfile(store, "Graceful restart", "graceful-restart@example.com");
    const created = store.createSession({
      profileId: profile.id,
      preset: "high",
      fastEnabled: false,
    });
    const session = store.bindSession({
      sessionId: created.id,
      expectedRevision: created.revision,
      providerThreadId: "thread-graceful-restart",
      state: "idle",
    });
    const captured = store.requireSessionProviderAuthority(session.id);
    store.appendSessionEvent({
      sessionId: session.id,
      accountId: captured.profileId,
      providerGeneration: captured.processGeneration,
      providerAuthority: {
        providerAccountId: captured.providerAccountId,
        profileId: captured.profileId,
        provider: captured.provider,
        bindingGeneration: captured.bindingGeneration,
        processGeneration: captured.processGeneration,
      },
      providerConnectionId: null,
      body: {
        type: "gap",
        reason: "provider_disconnect",
        fromSequence: 1,
        throughSequence: 1,
      },
    });
    store.advanceProfileGeneration(profile.id, captured.processGeneration);
    expect(() => store.requireSessionProviderAuthority(session.id))
      .toThrow("SESSION_PROVIDER_AUTHORITY_STALE");

    const bootId = `boot_${"c".repeat(32)}`;
    expect(store.nextDaemonGeneration(bootId)).toBe(1);
    const adopted = store.requireSessionProviderAuthority(session.id);
    expect(adopted).toMatchObject({
      providerAccountId: captured.providerAccountId,
      profileId: captured.profileId,
      provider: captured.provider,
      bindingGeneration: captured.bindingGeneration,
      processGeneration: captured.processGeneration + 2,
    });
    const beforeReplay = store.listSessionEvents({
      sessionId: session.id,
      afterSequence: 0,
    }).events;
    const inspector = new Database(store.paths.database, {
      create: false,
      readonly: true,
      strict: true,
    });
    let authorityRevision: number;
    try {
      authorityRevision = z.object({
        authority_revision: z.number().int().positive(),
      }).strict().parse(inspector.query(
        "SELECT authority_revision FROM session_provider_authorities WHERE session_id=?",
      ).get(session.id)).authority_revision;
    } finally {
      inspector.close(false);
    }

    expect(store.nextDaemonGeneration(bootId)).toBe(1);
    expect(store.requireProfileById(profile.id).processGeneration)
      .toBe(captured.processGeneration + 2);
    expect(store.requireSessionProviderAuthority(session.id)).toEqual(adopted);
    expect(store.listSessionEvents({ sessionId: session.id, afterSequence: 0 }).events)
      .toEqual(beforeReplay);
    const replayInspector = new Database(store.paths.database, {
      create: false,
      readonly: true,
      strict: true,
    });
    try {
      expect(replayInspector.query(
        "SELECT authority_revision FROM session_provider_authorities WHERE session_id=?",
      ).get(session.id)).toEqual({ authority_revision: authorityRevision });
    } finally {
      replayInspector.close(false);
    }
  });
test("rejects a two-generation restart adoption without graceful-close lineage", async () => {
    const { store } = await fixture();
    const profile = signInProfile(store, "False graceful restart", "false-graceful@example.com");
    const created = store.createSession({
      profileId: profile.id,
      preset: "high",
      fastEnabled: false,
    });
    const session = store.bindSession({
      sessionId: created.id,
      expectedRevision: created.revision,
      providerThreadId: "thread-false-graceful-restart",
      state: "idle",
    });
    const captured = store.requireSessionProviderAuthority(session.id);
    store.appendSessionEvent({
      sessionId: session.id,
      accountId: captured.profileId,
      providerGeneration: captured.processGeneration,
      providerAuthority: {
        providerAccountId: captured.providerAccountId,
        profileId: captured.profileId,
        provider: captured.provider,
        bindingGeneration: captured.bindingGeneration,
        processGeneration: captured.processGeneration,
      },
      providerConnectionId: null,
      body: {
        type: "gap",
        reason: "provider_restart",
        fromSequence: 1,
        throughSequence: 1,
      },
    });
    store.advanceProfileGeneration(profile.id, captured.processGeneration);

    expect(store.nextDaemonGeneration(`boot_${"f".repeat(32)}`)).toBe(1);
    expect(store.requireProfileById(profile.id).processGeneration)
      .toBe(captured.processGeneration + 2);
    expect(store.requireCapturedSessionProviderAuthority(session.id)).toEqual(captured);
    expect(() => store.requireSessionProviderAuthority(session.id))
      .toThrow("SESSION_PROVIDER_AUTHORITY_STALE");
  });
test("keeps profile recovery absorbing", async () => {
    const { store } = await fixture();
    const profile = signInProfile(store, "Profile recovery", "profile@example.com");
    expect(store.setProfileState(profile.id, profile.processGeneration, "recovery_required", {
      ...(profile.providerEmail === undefined ? {} : { email: profile.providerEmail }),
      ...(profile.providerPlan === undefined ? {} : { plan: profile.providerPlan }),
    })).toBe(true);
    expect(store.setProfileState(profile.id, profile.processGeneration, "signed_in", { email: "notification@example.com" })).toBe(false);
    expect(store.requireProfile(profile.id)).toMatchObject({ state: "recovery_required", providerEmail: "profile@example.com" });
  });
test("enforces the selector's Unicode label identity without effects", async () => {
    const { store, home } = await fixture();
    const account = store.createProfile("Équipe");
    expect(() => store.createProfile("équipe")).toThrow();
    expect(store.requireProfile("e\u0301QUIPE").id).toBe(account.id);

    const firstRoot = join(home, "Café");
    const secondRoot = join(home, "Cafe-decomposed");
    await mkdir(firstRoot);
    await mkdir(secondRoot);
    const project = await store.createProject("Café", firstRoot);
    await expect(store.createProject("Cafe\u0301", secondRoot)).rejects.toThrow();
    expect(store.requireProject("CAFE\u0301").id).toBe(project.id);
    expect(() => store.requireProfile("missing")).toThrow(SelectionError);
  });
test("holds the two device-command switches with their shipped defaults", async () => {
    const { store } = await fixture();
    // Commands are allowed because a browser is already an enrolled key holder;
    // account linking is denied because relaying a login is the one command that
    // hands a credential path to another surface.
    expect(store.readDeviceCommandPolicy()).toEqual({
      accountLinkingAllowed: false,
      deviceCommandsAllowed: true,
    });
    store.setDeviceCommandsAllowed(false);
    store.setAccountLinkingAllowed(true);
    expect(store.readDeviceCommandPolicy()).toEqual({
      accountLinkingAllowed: true,
      deviceCommandsAllowed: false,
    });
    store.setDeviceCommandsAllowed(true);
    expect(store.readDeviceCommandPolicy().deviceCommandsAllowed).toBe(true);
  });
test("counts device commands per requesting device and notifies once", async () => {
    const { store } = await fixture();
    expect(store.readDeviceCommandLedger("device_browser1")).toEqual({
      dayCount: 0,
      dayKey: 0,
      firstSessionStartNotifiedAt: null,
    });
    store.recordDeviceCommandAdmission({
      dayCount: 1,
      dayKey: 20_000,
      devicePublicId: "device_browser1",
      notifiedFirstSessionStart: true,
    });
    const first = store.readDeviceCommandLedger("device_browser1");
    expect(first).toMatchObject({ dayCount: 1, dayKey: 20_000 });
    expect(first.firstSessionStartNotifiedAt).not.toBeNull();
    // The notice timestamp is written once and never cleared, so the desktop
    // notice fires exactly once for a given device.
    store.recordDeviceCommandAdmission({
      dayCount: 2,
      dayKey: 20_001,
      devicePublicId: "device_browser1",
      notifiedFirstSessionStart: false,
    });
    expect(store.readDeviceCommandLedger("device_browser1")).toMatchObject({
      dayCount: 2,
      dayKey: 20_001,
      firstSessionStartNotifiedAt: first.firstSessionStartNotifiedAt,
    });
    // A second device keeps its own bucket and its own first notice.
    expect(store.readDeviceCommandLedger("device_browser2").firstSessionStartNotifiedAt)
      .toBeNull();
    expect(() => store.readDeviceCommandLedger("no")).toThrow();
  });
test("a browser-started session inherits the project's approval mode", async () => {
    const { store, home } = await fixture();
    const repository = join(home, "Inherit");
    await mkdir(repository);
    const project = await store.createProject("Inherit", repository, true);
    expect(store.readProjectApprovalMode(project.id))
      .toEqual({ mode: "auto:all", source: "default" });
    store.setDefaultApprovalMode("manual");
    expect(store.readProjectApprovalMode(project.id))
      .toEqual({ mode: "manual", source: "default" });
    store.setProjectApprovalMode(project.id, "auto:workspace");
    expect(store.readProjectApprovalMode(project.id))
      .toEqual({ mode: "auto:workspace", source: "project" });
    store.setProjectApprovalMode(project.id, null);
    expect(store.readProjectApprovalMode(project.id))
      .toEqual({ mode: "manual", source: "default" });
    expect(() => store.setProjectApprovalMode("proj_missing00000000", "manual")).toThrow();
  });
test("creates a project and session with CAS metadata", async () => {
    const { store, home } = await fixture({ provision: "migrate" });
    const repository = join(home, "Documents");
    await mkdir(repository);
    const profile = store.createProfile("Main");
    const project = await store.createProject("Documents", repository, true);
    const session = store.createSession({ profileId: profile.id, projectId: project.id, preset: "high", fastEnabled: true });
    const bound = store.bindSession({ sessionId: session.id, expectedRevision: 1, providerThreadId: "thread-provider", state: "idle" });
    const updated = store.updateSessionMetadata({ sessionId: session.id, expectedRevision: bound.revision, title: "Release work", note: "Check the package." });
    expect(updated.title).toBe("Release work");
    expect(updated.note).toBe("Check the package.");
    expect(updated.fastEnabled).toBe(true);
  });
describe("Work project metadata authority", () => {
    const liveStates = ["claimed", "dispatching", "running", "recovery_required"] as const;
    type FixtureState = (typeof liveStates)[number] | "released" | "submitted";
    const capability = `hrac1_${"A".repeat(43)}`;
    let keySequence = 0;
    const nextKey = () => `01890f31-a123-7000-8000-${(++keySequence).toString(16).padStart(12, "0")}`;

    async function historicalWorkFixture(state: Canonical48WorkState) {
      const paths = await canonical48WorkArchive();
      const captured = canonical48WorkFixture.retained.cases.find((entry) => entry.state === state);
      if (captured === undefined) throw new Error("Missing exact archived48 Work state.");
      const snapshot = () => {
        const database = new Database(paths.database, { create: false, strict: true });
        database.exec("PRAGMA query_only=ON");
        try { return canonicalAuthBudgetSnapshot(database); } finally { database.close(false); }
      };
      const original = snapshot();
      expect(original.version).toEqual({ user_version: 48 });
      expect(original.rows.session_runtime_profiles).toEqual([]);
      expect(original.rows.work_attempts).toHaveLength(4);
      expect(original.rows.work_attempts).toContainEqual(expect.objectContaining({ id: captured.attemptId, state }));
      return { paths, session: captured.session, snapshot };
    }

    async function workFixture(state: FixtureState, options: Parameters<typeof fixture>[0] = {}) {
      const { store, home } = await fixture(options);
      const profile = signInProfile(store, "Project authority", "project-authority@example.com");
      const repository = join(home, "project-authority");
      await mkdir(repository);
      const project = await store.createProject("Project authority", repository, true);
      const session = createProvenTestSession(store, {
        profileId: profile.id,
        projectId: project.id,
        preset: "ultra",
        fastEnabled: false,
      });
      const work = store.createWorkStore(1, () => "unused-project-authority-cursor", {
        issue: () => capability,
        verify: (value) => value === capability,
      });
      const created = work.apply({
        kind: "work.create",
        idempotencyKey: nextKey(),
        clientRef: "project-authority",
        coordinatorSessionId: session.id,
        objective: "Preserve a claimed session's exact project authority.",
        routes: [{ accountId: profile.id, projectId: project.id, preset: "ultra", fast: false }],
        tasks: [{
          clientRef: "project-authority-task",
          dependsOnRefs: [],
          dependsOnTaskIds: [],
          objective: "Keep project authority stable until the attempt settles.",
          instructions: "Perform no provider effect in this storage fixture.",
          criteria: ["Project changes cannot invalidate a live attempt."],
          route: { accountId: profile.id, projectId: project.id },
          preset: "ultra",
          fast: false,
          priority: 0,
          maxAttempts: 3,
          requiredReviews: 1,
          resultKind: "text",
          minEvidence: 0,
        }],
      });
      if (created.kind !== "work.create") throw new Error("Expected created project-authority work.");
      const task = created.tasks[0];
      if (task === undefined) throw new Error("Expected one project-authority task.");
      const claimOperation = {
        kind: "task.claim",
        idempotencyKey: nextKey(),
        workId: created.work.id,
        taskId: task.id,
        expectedTaskRevision: task.revision,
        actorSessionId: session.id,
        actorCapability: capability,
        leaseMs: 50_000,
      } as const;
      const claimed = work.apply(claimOperation);
      if (claimed.kind !== "task.claim") throw new Error("Expected claimed project-authority task.");
      let dispatchSettlement: Readonly<{ key: string; outcome: WorkDispatchOutcome }> | null = null;
      if (state === "released") {
        work.apply({
          kind: "attempt.release",
          idempotencyKey: nextKey(),
          workId: created.work.id,
          attemptId: claimed.attempt.id,
          expectedAttemptRevision: claimed.attempt.revision,
          fence: claimed.attempt.fence,
          actorSessionId: session.id,
          attemptCapability: capability,
          reason: "Return the session's project authority.",
        });
      } else if (state !== "claimed") {
        const dispatchKey = nextKey();
        work.apply({
          kind: "attempt.dispatch",
          idempotencyKey: dispatchKey,
          workId: created.work.id,
          attemptId: claimed.attempt.id,
          expectedAttemptRevision: claimed.attempt.revision,
          fence: claimed.attempt.fence,
          actorSessionId: session.id,
          attemptCapability: capability,
          targetSessionId: session.id,
          mode: "send",
        });
        if (state !== "dispatching") {
          expect(work.authorizePreparedEffect(dispatchKey).executable).toBe(true);
          const outcome: WorkDispatchOutcome = state === "recovery_required"
            ? { kind: "unknown", code: "custodian_restart" }
            : {
                kind: "accepted",
                receipt: {
                  kind: "turn_started",
                  turnId: `opaque_v2_${"a".repeat(64)}`,
                  runtimeProfileDigest: "b".repeat(64),
                  mutationAttemptId: createAttemptId(),
                  accountGeneration: profile.processGeneration,
                },
              };
          dispatchSettlement = { key: dispatchKey, outcome };
          const settled = work.finalizeDispatch(dispatchKey, outcome);
          if (state === "submitted") {
            work.apply({
              kind: "attempt.report",
              idempotencyKey: nextKey(),
              workId: created.work.id,
              attemptId: settled.id,
              expectedAttemptRevision: settled.revision,
              fence: settled.fence,
              actorSessionId: session.id,
              attemptCapability: capability,
              report: { kind: "submit", summary: "Ready for independent review.", result: { kind: "text", text: "complete" }, evidence: [] },
            });
          }
        }
      }
      const inspect = <T>(read: (database: Database) => T): T => {
        const database = new Database(store.paths.database, { readonly: true, strict: true });
        try { return read(database); } finally { database.close(false); }
      };
      expect(inspect((database) => database.query(
        "SELECT [notnull] FROM pragma_table_info('sessions') WHERE name='project_id'",
      ).get())).toEqual({ notnull: 0 });
      expect(inspect((database) => database.query(
        "SELECT state FROM work_attempts WHERE id=?",
      ).get(claimed.attempt.id))).toEqual({ state });
      const snapshot = () => inspect((database) => ({
        session: database.query("SELECT * FROM sessions WHERE id=?").get(session.id),
        attempt: database.query("SELECT * FROM work_attempts WHERE id=?").get(claimed.attempt.id),
        taskState: database.query("SELECT * FROM work_task_states WHERE task_id=?").get(task.id),
        events: database.query("SELECT * FROM work_events WHERE work_id=? ORDER BY sequence").all(created.work.id),
        stream: database.query("SELECT * FROM session_event_streams WHERE session_id=?").get(session.id),
        schema: database.query("SELECT name,sql FROM sqlite_master ORDER BY name").all(),
        migrations: database.query("SELECT * FROM migrations ORDER BY version").all(),
        effects: database.query("SELECT * FROM work_prepared_effects WHERE work_id=? ORDER BY idempotency_key").all(created.work.id),
        intents: database.query("SELECT * FROM work_idempotency_intents WHERE work_id=? ORDER BY idempotency_key").all(created.work.id),
        version: database.query("PRAGMA user_version").get(),
      }));
      return {
        store, home, project, session, snapshot, inspect,
        workId: created.work.id, taskId: task.id, attemptId: claimed.attempt.id,
        claimOperation, dispatchSettlement,
      };
    }

    for (const state of ["released", "submitted"] as const) {
      test(`preserves ${state} Work history and replay across canonical profile reselection and reopen`, async () => {
        // Real current StateStore schema and semantic writers throughout. This
        // compatibility contract remains useful when canonical persistence is
        // integrated; it does not install or pretend to prove that migration.
        const now = () => 10_000;
        const value = await workFixture(state, { now });
        const encodeCursor = (payload: unknown) =>
          `hra1.${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}.${"A".repeat(43)}`;
        const createWorkStore = (owner: StateStore) => owner.createWorkStore(1, encodeCursor, {
          issue: () => capability,
          verify: (candidate) => candidate === capability,
        });
        const work = createWorkStore(value.store);
        const historicalKeys = () => value.inspect((database) => {
          const rows = database.query(`
            SELECT s.provider_v39,s.preset AS session_preset,s.preset_contract AS session_contract,
              w.preset_contract AS work_contract,r.preset AS route_preset,
              t.preset AS task_preset,a.preset AS attempt_preset
            FROM work_attempts a
            JOIN work_tasks t ON t.id=a.task_id AND t.work_id=a.work_id
            JOIN works w ON w.id=t.work_id
            JOIN work_routes r ON r.work_id=t.work_id AND r.account_id=t.account_id
              AND r.project_id=t.project_id AND r.preset=t.preset AND r.fast=t.fast
            JOIN sessions s ON s.id=a.worker_session_id
            WHERE a.id=?
          `).all(value.attemptId);
          expect(rows).toHaveLength(1);
          const row = z.object({
            provider_v39: z.literal("codex"),
            session_preset: z.enum(["low", "ultra"]),
            session_contract: z.union([z.literal(1), z.literal(2)]),
            work_contract: z.literal(2),
            route_preset: z.literal("ultra"),
            task_preset: z.literal("ultra"),
            attempt_preset: z.literal("ultra"),
          }).strict().parse(rows[0]);
          return {
            session: deriveLegacySessionProfileKey(row.provider_v39, row.session_preset, row.session_contract),
            route: deriveLegacyWorkProfileKey(row.route_preset, row.work_contract),
            task: deriveLegacyWorkProfileKey(row.task_preset, row.work_contract),
            attempt: deriveLegacyWorkProfileKey(row.attempt_preset, row.work_contract),
          };
        });
        const persistedHistory = () => value.inspect((database) => canonicalWorkJson({
          work: database.query("SELECT * FROM works WHERE id=?").get(value.workId),
          routes: database.query("SELECT * FROM work_routes WHERE work_id=? ORDER BY ordinal").all(value.workId),
          tasks: database.query("SELECT * FROM work_tasks WHERE work_id=? ORDER BY ordinal").all(value.workId),
          attempts: database.query("SELECT * FROM work_attempts WHERE work_id=? ORDER BY id").all(value.workId),
          taskStates: database.query("SELECT * FROM work_task_states WHERE work_id=? ORDER BY task_id").all(value.workId),
          intents: database.query("SELECT * FROM work_idempotency_intents WHERE work_id=? ORDER BY idempotency_key").all(value.workId),
          effects: database.query("SELECT * FROM work_prepared_effects WHERE work_id=? ORDER BY idempotency_key").all(value.workId),
          reports: database.query("SELECT * FROM work_attempt_reports WHERE work_id=? ORDER BY idempotency_key").all(value.workId),
          submissions: database.query("SELECT * FROM work_submissions WHERE work_id=? ORDER BY id").all(value.workId),
          events: database.query("SELECT * FROM work_events WHERE work_id=? ORDER BY sequence").all(value.workId),
          historyIndex: database.query("SELECT * FROM work_task_history_index WHERE work_id=? ORDER BY ordinal").all(value.workId),
          historyVersions: database.query("SELECT * FROM work_task_history_versions WHERE work_id=? ORDER BY ordinal").all(value.workId),
          clock: database.query("SELECT * FROM work_clock").all(),
        }));
        const publicHistory = (owner: ReturnType<typeof createWorkStore>) => ({
          task: owner.task(value.taskId),
          history: owner.taskHistory(value.taskId),
          events: owner.events(value.workId),
          snapshot: owner.snapshot(value.workId),
          effect: value.dispatchSettlement === null ? null : owner.preparedEffect(value.dispatchSettlement.key),
        });
        const settledReplay = (owner: ReturnType<typeof createWorkStore>) => ({
          // Intent replay reprojects settled state; the original claim result
          // is deliberately not the byte oracle for these later reads.
          claim: owner.apply(value.claimOperation),
          dispatch: value.dispatchSettlement === null ? null
            : owner.finalizeDispatch(value.dispatchSettlement.key, value.dispatchSettlement.outcome),
        });
        const solUltra = "codex:gpt-6-astra:ultra";
        expect(historicalKeys()).toEqual({ session: solUltra, route: solUltra, task: solUltra, attempt: solUltra });
        expect(value.store.requireSessionPresetRequirement(value.session.id)).toEqual({
          preset: "ultra", requirement: { model: "gpt-6-astra", effort: "ultra" },
        });
        const retained = persistedHistory();
        const before = publicHistory(work);
        const replayBytes = canonicalWorkJson(settledReplay(work));
        expect(before.task.latestAttempt).toMatchObject({ id: value.attemptId, status: state });
        expect(before.history.items.length).toBeGreaterThan(0);
        expect(before.events.events.length).toBeGreaterThan(0);
        if (state === "submitted") {
          expect(value.dispatchSettlement?.outcome.kind).toBe("accepted");
          expect(before.effect?.status.state).toBe("accepted");
          expect(before.task.latestAttemptReport?.reportKind).toBe("submit");
          expect(before.task.latestSubmission).not.toBeNull();
        } else {
          expect(before.effect).toBeNull();
        }
        const publicBytes = canonicalWorkJson(before);
        expect(publicBytes).not.toContain('"canonical_profile_key":');
        expect(publicBytes).not.toContain('"canonicalProfileKey":');
        expect(persistedHistory()).toBe(retained);

        const selected = value.store.updateSessionMetadata({
          sessionId: value.session.id,
          expectedRevision: value.session.revision,
          preset: "low",
        });
        expect(selected.preset).toBe("low");
        expect(selected.revision).toBe(value.session.revision + 1);
        const keysAfter = {
          session: "codex:gpt-5.6-luna:max", route: solUltra, task: solUltra, attempt: solUltra,
        } as const;
        expect(historicalKeys()).toEqual(keysAfter);
        expect(value.store.requireSessionPresetRequirement(selected.id)).toEqual({
          preset: "low", requirement: { model: "gpt-5.6-luna", effort: "max" },
        });
        expect(canonicalWorkJson(publicHistory(work))).toBe(publicBytes);
        expect(canonicalWorkJson(settledReplay(work))).toBe(replayBytes);
        expect(() => work.apply({ ...value.claimOperation, leaseMs: value.claimOperation.leaseMs + 1 }))
          .toThrow("IDEMPOTENCY_CONFLICT");
        expect(persistedHistory()).toBe(retained);

        const paths = value.store.paths;
        value.store.close();
        stores.splice(stores.indexOf(value.store), 1);
        for (const readonly of [true, false]) {
          const reopened = new StateStore(paths, { readonly, now });
          try {
            expect(reopened.requireSession(selected.id)).toEqual(selected);
            expect(historicalKeys()).toEqual(keysAfter);
            const reopenedWork = createWorkStore(reopened);
            expect(canonicalWorkJson(publicHistory(reopenedWork))).toBe(publicBytes);
            // Replay APIs own immediate transactions, not the readonly surface.
            if (!readonly) expect(canonicalWorkJson(settledReplay(reopenedWork))).toBe(replayBytes);
            expect(persistedHistory()).toBe(retained);
          } finally { reopened.close(); }
        }
      });
    }

    for (const state of liveStates) {
      test(`SQL Work project authority refuses clearing a real nullable project during ${state}`, async () => {
        const { store, home, project, session, snapshot } = await workFixture(state);
        const otherDirectory = join(home, "sql-other-project");
        await mkdir(otherDirectory);
        const otherProject = await store.createProject("SQL other project", otherDirectory, true);
        const before = snapshot();
        const database = new Database(store.paths.database, { create: false, strict: true });
        try {
          database.exec("PRAGMA foreign_keys=ON");
          expect(() => database.query(`UPDATE sessions
            SET project_id=NULL,title='Must not commit',note='Nor this',
              revision=revision+1,updated_at=updated_at+1
            WHERE id=?`).run(session.id)).toThrow("WORK_SESSION_ATTEMPT_AUTHORITY");
          expect(snapshot()).toEqual(before);
          expect(() => database.query("UPDATE sessions SET project_id=? WHERE id=?")
            .run(otherProject.id, session.id)).toThrow("WORK_SESSION_ATTEMPT_AUTHORITY");
          expect(snapshot()).toEqual(before);
          database.query("UPDATE sessions SET project_id=? WHERE id=?").run(project.id, session.id);
          database.query("UPDATE sessions SET note='Unrelated SQL metadata' WHERE id=?").run(session.id);
          expect(database.query("SELECT project_id,note FROM sessions WHERE id=?").get(session.id))
            .toEqual({ project_id: project.id, note: "Unrelated SQL metadata" });
        } finally { database.close(false); }
      });

      test(`SQL Work project authority upgrades populated v48 ${state} attempts without rewriting evidence`, async () => {
        const { paths, session, snapshot } = await historicalWorkFixture(state);
        const database = new Database(paths.database, { create: false, strict: true });
        try {
          database.exec("PRAGMA foreign_keys=ON");
          const before = snapshot();
          const oldRows = canonicalAuthBudgetRows(database, Object.keys(before.rows).filter((table) => table !== "migrations"));
          const ledgerBefore = database.query("SELECT * FROM migrations ORDER BY version").all();
          expect(() => new StateStore(paths, { readonly: true })).toThrow("STATE_SCHEMA_MIGRATION_REQUIRED:48:61");
          expect(snapshot()).toEqual(before);
          const originalExec = z.custom<Database["exec"]>((value) => typeof value === "function")
            .parse(Object.getOwnPropertyDescriptor(Database.prototype, "exec")?.value);
          let preapplications = 0;
          const exec = spyOn(Database.prototype, "exec").mockImplementation(function (
            this: Database, ...args: Parameters<Database["exec"]>
          ) {
            const result = originalExec.apply(this, args);
            if (this.filename === paths.database && args[0] === WORK_PROJECT_AUTHORITY_SCHEMA_SQL) {
              expect(this.inTransaction).toBe(true);
              const intermediate = canonicalAuthBudgetSnapshot(this);
              expect(intermediate.version).toEqual(before.version);
              expect(intermediate.rows).toEqual(before.rows);
              expect(intermediate.schema).toHaveLength(before.schema.length + 1);
              for (const object of before.schema) expect(intermediate.schema).toContainEqual(object);
              expect(() => this.query("UPDATE sessions SET project_id=NULL WHERE id=?").run(session.id))
                .toThrow("WORK_SESSION_ATTEMPT_AUTHORITY");
              expect(canonicalAuthBudgetSnapshot(this)).toEqual(intermediate);
              preapplications += 1;
            }
            return result;
          });
          const migratedAt = canonical48WorkFixture.fixedTime + 1_000;
          let reopened: StateStore;
          try { reopened = new StateStore(paths, { now: () => migratedAt }); } finally { exec.mockRestore(); }
          expect(Object.getOwnPropertyDescriptor(Database.prototype, "exec")?.value).toBe(originalExec);
          expect(preapplications).toBe(1);
          stores.push(reopened);
          const after = snapshot();
          // The one-guard preapplication above is an uncommitted48 substep,
          // not a claim that the full joined migration installs only a guard.
          expect(oldRows.read()).toEqual(oldRows.before);
          expect(database.query("PRAGMA user_version").get()).toEqual({ user_version: 61 });
          expect(database.query("SELECT * FROM migrations WHERE version<=48 ORDER BY version").all()).toEqual(ledgerBefore);
          expect(database.query("SELECT * FROM migrations WHERE version>48 ORDER BY version").all())
            .toEqual(Array.from({ length: 13 }, (_, index) => ({ version: index + 49, applied_at: migratedAt })));
          expect(database.query("SELECT * FROM legacy_provider_authority_quarantines ORDER BY scope_id").all())
            .toEqual(canonical48WorkFixture.retained.cases.map((entry) => ({ scope_kind: "session", scope_id: entry.session.id,
              reason: "missing_immutable_runtime_authority", recorded_at: migratedAt }))
              .sort((left, right) => left.scope_id.localeCompare(right.scope_id)));
          expect(database.query("SELECT * FROM session_provider_authorities").all()).toEqual([]);
          for (const entry of canonical48WorkFixture.retained.cases) {
            expect(() => reopened.requireSessionProviderAuthority(entry.session.id))
              .toThrow("SESSION_PROVIDER_AUTHORITY_QUARANTINED:missing_immutable_runtime_authority");
          }
          expect(() => database.query("UPDATE sessions SET project_id=NULL WHERE id=?").run(session.id))
            .toThrow("WORK_SESSION_ATTEMPT_AUTHORITY");
          expect(database.query("PRAGMA foreign_key_check").all()).toEqual([]);
          reopened.close();
          stores.splice(stores.indexOf(reopened), 1);
          for (const readonly of [false, true]) {
            const second = new StateStore(paths, { readonly, now: () => migratedAt + 1 });
            try { expect(snapshot()).toEqual(after); } finally { second.close(); }
          }
        } finally { database.close(false); }
      });

      test(`SQL Work project authority refuses contradictory v48 ${state} project debt atomically`, async () => {
        const { paths, session, snapshot } = await historicalWorkFixture(state);
        const database = new Database(paths.database, { create: false, strict: true });
        try {
          database.exec("PRAGMA foreign_keys=ON");
          // This adversarial row edit demonstrates the authentic v48 hole,
          // with every source-produced schema object and old guard intact.
          database.query("UPDATE sessions SET project_id=NULL WHERE id=?").run(session.id);
          const before = snapshot();
          expect(() => new StateStore(paths, { now: () => 10_000 }))
            .toThrow("STATE_SCHEMA_V49_WORK_PROJECT_AUTHORITY_INVALID");
          expect(snapshot()).toEqual(before);
        } finally { database.close(false); }
      });

      test(`refuses clearing a real nullable project during ${state} without changing metadata or Work`, async () => {
        const { store, session, snapshot } = await workFixture(state);
        const before = snapshot();
        expect(() => store.updateSessionMetadata({
          sessionId: session.id,
          expectedRevision: session.revision,
          projectId: null,
          title: "Must not commit",
          note: "Must not commit either",
        })).toThrow("WORK_SESSION_ATTEMPT_AUTHORITY");
        expect(snapshot()).toEqual(before);
      });

      test(`preserves same-project and unrelated metadata updates during ${state}`, async () => {
        const { store, project, session } = await workFixture(state);
        const renamed = store.updateSessionMetadata({
          sessionId: session.id,
          expectedRevision: session.revision,
          title: "Renamed without changing authority",
        });
        const updated = store.updateSessionMetadata({
          sessionId: session.id,
          expectedRevision: renamed.revision,
          projectId: project.id,
          note: "Same project is not a route change",
        });
        expect(updated).toMatchObject({
          projectId: project.id,
          title: renamed.title,
          note: "Same project is not a route change",
          revision: session.revision + 2,
        });
        expect(updated.updatedAt).toBeGreaterThan(renamed.updatedAt);
      });
    }

    for (const state of ["released", "submitted"] as const) {
      test(`SQL Work project authority allows nullable and unrelated updates after ${state}`, async () => {
        const { store, project, session } = await workFixture(state);
        const database = new Database(store.paths.database, { create: false, strict: true });
        try {
          database.exec("PRAGMA foreign_keys=ON");
          database.query("UPDATE sessions SET project_id=NULL WHERE id=?").run(session.id);
          database.query("UPDATE sessions SET project_id=NULL,note='Unchanged nullable project' WHERE id=?")
            .run(session.id);
          database.query("UPDATE sessions SET project_id=? WHERE id=?").run(project.id, session.id);
          expect(database.query("SELECT project_id,note FROM sessions WHERE id=?").get(session.id))
            .toEqual({ project_id: project.id, note: "Unchanged nullable project" });
        } finally { database.close(false); }
      });

      test(`allows clearing a project after the attempt is ${state}`, async () => {
        const { store, session } = await workFixture(state);
        const updated = store.updateSessionMetadata({
          sessionId: session.id,
          expectedRevision: session.revision,
          projectId: null,
        });
        expect(updated.projectId).toBeUndefined();
        expect(updated.revision).toBe(session.revision + 1);
      });
    }

    for (const collision of [
      "CREATE TABLE work_session_project_authority_guard(value TEXT) STRICT",
      "CREATE VIEW work_session_project_authority_guard AS SELECT 1 AS value",
      "CREATE INDEX work_session_project_authority_guard ON sessions(project_id)",
      "CREATE TRIGGER work_session_project_authority_guard BEFORE UPDATE ON sessions BEGIN SELECT 1; END",
      "CREATE TABLE Work_Session_Project_Authority_Guard(value TEXT) STRICT",
    ]) {
      test(`SQL Work project authority refuses a predecessor object collision: ${collision.split(" ")[1]}`, async () => {
        const { paths, snapshot } = await historicalWorkFixture("claimed");
        const database = new Database(paths.database, { create: false, strict: true });
        try {
          database.exec(collision);
          const before = snapshot();
          expect(() => new StateStore(paths))
            .toThrow("STATE_SCHEMA_V49_WORK_PROJECT_PREDECESSOR_COLLISION");
          expect(snapshot()).toEqual(before);
        } finally { database.close(false); }
      });
    }

    test("SQL Work project authority rolls back its preapplied trigger when the ledger stamp fails", async () => {
      const { paths, snapshot } = await historicalWorkFixture("claimed");
      const database = new Database(paths.database, { create: false, strict: true });
      try {
        database.exec(`CREATE TRIGGER refuse_work_project_migration BEFORE INSERT ON migrations
          WHEN NEW.version=49 BEGIN SELECT RAISE(ABORT,'refused Work project stamp'); END`);
        const before = snapshot();
        expect(() => new StateStore(paths)).toThrow("refused Work project stamp");
        expect(snapshot()).toEqual(before);
        database.exec("DROP TRIGGER refuse_work_project_migration");
        const reopened = new StateStore(paths);
        stores.push(reopened);
        expect(database.query("PRAGMA user_version").get()).toEqual({ user_version: 61 });
      } finally { database.close(false); }
    });

    test("SQL Work project authority never adopts an exact-looking predecessor companion", async () => {
      const { paths, snapshot } = await historicalWorkFixture("claimed");
      const database = new Database(paths.database, { create: false, strict: true });
      try {
        database.exec(WORK_PROJECT_AUTHORITY_SCHEMA_SQL);
        const before = snapshot();
        expect(() => new StateStore(paths)).toThrow("STATE_SCHEMA_V49_WORK_PROJECT_PREDECESSOR_COLLISION");
        expect(snapshot()).toEqual(before);
      } finally { database.close(false); }
    });

    for (const damage of ["missing", "weakened"] as const) {
      test(`SQL Work project authority refuses a ${damage} released v48 route guard before preapplication`, async () => {
        const { paths, snapshot } = await historicalWorkFixture("claimed");
        const database = new Database(paths.database, { create: false, strict: true });
        try {
          database.exec("DROP TRIGGER work_session_attempt_authority_guard");
          if (damage === "weakened") database.exec(`CREATE TRIGGER work_session_attempt_authority_guard
            BEFORE UPDATE ON sessions BEGIN SELECT 1; END`);
          const before = snapshot();
          expect(() => new StateStore(paths)).toThrow(
            `WORK_SCHEMA_${damage === "missing" ? "MISSING" : "STALE"}_TRIGGER:work_session_attempt_authority_guard`,
          );
          expect(snapshot()).toEqual(before);
        } finally { database.close(false); }
      });
    }

    test("SQL Work project authority serializes migration proof and rolls back an interrupted clock", async () => {
      const { paths, session, snapshot } = await historicalWorkFixture("claimed");
      const contender = new Database(paths.database, { create: false, strict: true });
      try {
        contender.exec("PRAGMA busy_timeout=0");
        const before = snapshot();
        let observedFence = false;
        expect(() => new StateStore(paths, { now: () => {
          expect(() => contender.transaction(() => {
            contender.query("UPDATE sessions SET note='Must not race migration' WHERE id=?").run(session.id);
          }).immediate()).toThrow("database is locked");
          observedFence = true;
          // The new authority is still uncommitted to another connection.
          expect(contender.query("SELECT 1 FROM sqlite_master WHERE name='work_session_project_authority_guard'").get())
            .toBeNull();
          throw new Error("Interrupted migration timestamp");
        } })).toThrow("Interrupted migration timestamp");
        expect(observedFence).toBe(true);
        expect(snapshot()).toEqual(before);
      } finally { contender.close(false); }
    });

    for (const damage of ["missing", "weakened", "wrong_table", "shadow_table"] as const) {
      test(`SQL Work project authority rejects ${damage} current guards in both opens and WorkStore construction`, async () => {
        const { store, snapshot } = await workFixture("claimed");
        const database = new Database(store.paths.database, { create: false, strict: true });
        try {
          const original = z.object({ sql: z.string() }).parse(database.query(
            "SELECT sql FROM sqlite_master WHERE name='work_session_project_authority_guard'",
          ).get()).sql;
          if (damage === "shadow_table") {
            database.exec("CREATE TABLE Work_Session_Project_Authority_Guard(value TEXT) STRICT");
          } else {
            database.exec("DROP TRIGGER work_session_project_authority_guard");
            if (damage === "weakened") {
              const weakened = original.replace("NEW.project_id IS NOT a.project_id", "NEW.project_id!=a.project_id");
              expect(weakened).not.toBe(original);
              database.exec(weakened);
            } else if (damage === "wrong_table") {
              database.exec(`CREATE TRIGGER work_session_project_authority_guard
                BEFORE UPDATE ON profiles BEGIN SELECT 1; END`);
            }
          }
          const before = snapshot();
          const expected = `WORK_SCHEMA_${damage === "missing" ? "MISSING" : "STALE"}_TRIGGER:work_session_project_authority_guard`;
          expect(() => new StateStore(store.paths, { readonly: true })).toThrow(expected);
          expect(() => new StateStore(store.paths)).toThrow(expected);
          expect(() => store.createWorkStore(1, () => "unused-current-guard-cursor", {
            issue: () => capability, verify: () => false,
          })).toThrow(expected);
          expect(snapshot()).toEqual(before);
        } finally { database.close(false); }
      });
    }

    test("allows clearing without a Work attempt and preserves the nullable result on reopen", async () => {
      const { store, home } = await fixture();
      const profile = signInProfile(store, "No Work attempt", "no-work-attempt@example.com");
      const repository = join(home, "no-work-attempt");
      await mkdir(repository);
      const project = await store.createProject("No Work attempt", repository, true);
      const session = createProvenTestSession(store, {
        profileId: profile.id,
        projectId: project.id,
        preset: "ultra",
        fastEnabled: false,
      });
      const cleared = store.updateSessionMetadata({
        sessionId: session.id,
        expectedRevision: session.revision,
        projectId: null,
      });
      expect(cleared.projectId).toBeUndefined();
      const unchanged = store.updateSessionMetadata({
        sessionId: session.id,
        expectedRevision: cleared.revision,
        projectId: null,
        note: "An already-null project is not a route change",
      });
      expect(unchanged.projectId).toBeUndefined();
      expect(unchanged.revision).toBe(session.revision + 2);
      const paths = store.paths;
      store.close();
      stores.splice(stores.indexOf(store), 1);
      const reopened = new StateStore(paths);
      stores.push(reopened);
      expect(reopened.requireSession(session.id)).toEqual(unchanged);
    });

    test("preserves wrong-project, malformed-project, stale-revision, and unknown-session refusals", async () => {
      const { store, home, session, snapshot } = await workFixture("claimed");
      const otherRepository = join(home, "different-work-project");
      await mkdir(otherRepository);
      const otherProject = await store.createProject("Different Work project", otherRepository, true);
      const before = snapshot();
      for (const projectId of [otherProject.id, "proj_ffffffffffffffffffffffffffffffff", "malformed-project"]) {
        expect(() => store.updateSessionMetadata({
          sessionId: session.id,
          expectedRevision: session.revision,
          projectId,
        })).toThrow("WORK_SESSION_ATTEMPT_AUTHORITY");
        expect(snapshot()).toEqual(before);
      }
      expect(() => store.updateSessionMetadata({
        sessionId: session.id,
        expectedRevision: session.revision - 1,
        projectId: null,
      })).toThrow("Session metadata revision conflict.");
      expect(() => store.updateSessionMetadata({
        sessionId: "sess_ffffffffffffffffffffffffffffffff",
        expectedRevision: session.revision,
        projectId: null,
      })).toThrow(SelectionError);
      expect(snapshot()).toEqual(before);
    });

    test("preserves the memory project idle gate before checking Work authority", async () => {
      const { store, project, session, snapshot } = await workFixture("claimed");
      const active = store.setSessionTurnState({
        sessionId: session.id,
        expectedRevision: session.revision,
        state: "active",
        activeTurnId: "project-authority-active-turn",
      });
      const before = snapshot();
      expect(() => store.updateSessionMetadata({
        sessionId: active.id,
        expectedRevision: active.revision,
        projectId: null,
        note: "Neither gate may commit partial metadata",
      })).toThrow("SESSION_PROJECT_REQUIRES_IDLE");
      expect(snapshot()).toEqual(before);
      const unchangedProject = store.updateSessionMetadata({
        sessionId: active.id,
        expectedRevision: active.revision,
        projectId: project.id,
        title: "The same project remains valid during a turn",
      });
      expect(unchangedProject.projectId).toBe(project.id);
      const idle = store.setSessionTurnState({
        sessionId: active.id,
        expectedRevision: unchangedProject.revision,
        state: "idle",
      });
      expect(() => store.updateSessionMetadata({
        sessionId: idle.id,
        expectedRevision: idle.revision,
        projectId: null,
      })).toThrow("WORK_SESSION_ATTEMPT_AUTHORITY");
    });

    test("holds the SQLite write fence across metadata observation and timestamp sampling", async () => {
      let tick = 1_000;
      let onClock: (() => void) | undefined;
      const { store, session, snapshot } = await workFixture("claimed", {
        now: () => { onClock?.(); return tick++; },
      });
      const contender = new Database(store.paths.database, { create: false, strict: true });
      contender.exec("PRAGMA busy_timeout=0");
      let observedFence = false;
      try {
        onClock = () => {
          onClock = undefined;
          expect(() => contender.transaction(() => {
            contender.query("UPDATE sessions SET note=?,revision=revision+1 WHERE id=?")
              .run("Competing writer must not commit", session.id);
          }).immediate()).toThrow("database is locked");
          observedFence = true;
        };
        const renamed = store.updateSessionMetadata({
          sessionId: session.id,
          expectedRevision: session.revision,
          title: "One atomic metadata observation",
        });
        expect(observedFence).toBe(true);
        expect(renamed).toMatchObject({ title: "One atomic metadata observation", note: session.note });
        const before = snapshot();
        onClock = () => { throw new Error("Injected unavailable timestamp"); };
        expect(() => store.updateSessionMetadata({
          sessionId: session.id,
          expectedRevision: renamed.revision,
          note: "No partial update on clock failure",
        })).toThrow("Injected unavailable timestamp");
        expect(snapshot()).toEqual(before);
      } finally {
        onClock = undefined;
        contender.close(false);
      }
    });
  });
test("uses active Astra bindings while preserving established contract 1", async () => {
    const { store } = await fixture();
    const profile = signInProfile(store, "Preset contracts", "preset-contracts@example.com");
    const created = store.createSession({
      profileId: profile.id,
      preset: "high",
      fastEnabled: false,
    });
    expect(store.requireSessionPresetRequirement(created.id)).toEqual({
      preset: "high",
      requirement: { model: "gpt-6-astra", effort: "max" },
    });

    const imported = store.upsertProviderSession({
      providerAuthority: store.requireProviderAccountAuthority(profile.id, "codex"),
      profileId: profile.id,
      provider: "codex",
      providerThreadId: "thread-imported-contract",
      title: "Imported",
      preset: "high",
      fastEnabled: false,
      state: "idle",
      providerAccountKey: providerAccountKeyForProfile(store, profile.id, "codex"),
    });
    expect(store.requireSessionPresetRequirement(imported.id)).toEqual({
      preset: "high",
      requirement: { model: "gpt-6-astra", effort: "max" },
    });
    const database = new Database(store.paths.database, { strict: true });
    // Synthetic historical binding, not a source-authentic release fixture.
    database.query("UPDATE sessions SET preset_contract=?,canonical_profile_key='codex:gpt-5.6-sol:max' WHERE id=?")
      .run(legacyPresetContract, created.id);
    database.close(false);
    expect(store.requireSessionPresetRequirement(created.id)).toEqual({
      preset: "high",
      requirement: { model: "gpt-5.6-sol", effort: "max" },
    });
    const renamed = store.updateSessionMetadata({
      sessionId: created.id,
      expectedRevision: created.revision,
      title: "Established Sol",
    });
    expect(store.requireSessionPresetRequirement(created.id).requirement.model)
      .toBe("gpt-5.6-sol");
    store.updateSessionMetadata({
      sessionId: created.id,
      expectedRevision: renamed.revision,
      preset: "high",
    });
    expect(store.requireSessionPresetRequirement(created.id).requirement.model)
      .toBe("gpt-6-astra");
  });
test("settles immutable Sol evidence before permitting an Astra reselection", async () => {
    let { store } = await fixture();
    const daemon = startInputFixtureDaemon(store);
    const profile = signInProfile(store, "Legacy recovery preset", "legacy-recovery@example.com");
    const session = store.upsertProviderSession({
      providerAuthority: store.requireProviderAccountAuthority(profile.id, "codex"),
      profileId: profile.id,
      provider: "codex",
      providerThreadId: "thread-legacy-recovery-preset",
      title: "Legacy recovery preset",
      preset: "high",
      fastEnabled: false,
      state: "idle",
      providerUpdatedAt: 10,
      providerAccountKey: providerAccountKeyForProfile(store, profile.id, "codex"),
    });
    const database = new Database(store.paths.database, { strict: true });
    // Retain the legacy binding coherently before authoring its recovery evidence.
    database.query("UPDATE sessions SET preset_contract=?,canonical_profile_key='codex:gpt-5.6-sol:max' WHERE id=?")
      .run(legacyPresetContract, session.id);
    database.close(false);
    const runtimeProfile = {
      approvalPolicy: "on-request" as const,
      computerUse: true as const,
      enabledApps: [],
      fast: false,
      model: "gpt-5.6-sol",
      observedAt: 2_000,
      permissionProfile: ":workspace" as const,
      pluginCapability: true as const,
      preset: "high" as const,
      processGeneration: profile.processGeneration,
      profileId: profile.id,
      reasoningEffort: "max" as const,
      reviewMode: "auto_review" as const,
      serviceTier: null,
    };
    const idempotencyKey = "00000000-0000-4000-8000-0000000006c0";
    const providerAuthority = store.requireProviderAccountAuthority(profile.id, "codex");
    const { attempt } = store.prepareSessionInputMutation({
      ...daemon, kind: "session.send", sessionId: session.id, idempotencyKey,
      message: "legacy recovery", attachments: [], providerAuthority,
    });
    const evidence = store.beginSessionMutationEffect({
      ...daemon, attemptId: attempt.id, sessionId: session.id,
      profileGeneration: providerAuthority.processGeneration, providerAuthority, attachments: [],
      message: "legacy recovery",
      transcript: {
        accountId: profile.id,
        providerGeneration: profile.processGeneration,
        providerConnectionId: "10000000-0000-4000-8000-00000000000b",
        actor: "human",
        message: "legacy recovery",
      },
      evidence: {
        kind: "session.send", providerThreadId: "thread-legacy-recovery-preset",
        baseline: { providerUpdatedAt: 10, status: "idle", activeTurnId: null },
        clientMessageId: attempt.id,
        messageDigest: createHash("sha256").update("legacy recovery").digest("hex"),
        runtimeProfile: effectiveRuntimeProfileSchema.parse(runtimeProfile),
      },
    });
    const frozen = store.readMutation(idempotencyKey);
    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);
    store = new StateStore(paths, { now: () => 3_000 });
    stores.push(store);
    expect(store.readMutation(idempotencyKey)).toEqual(frozen);
    expect(store.readMutation(idempotencyKey)?.evidence?.digest).toBe(evidence.digest);
    expect(store.transitionMutation(attempt.id, "effect_started", "ambiguous", {
      code: "LOST_RESPONSE",
    })).toBe(true);
    const quarantined = store.quarantineSession(session.id);
    expect(() => store.updateSessionMetadata({
      expectedRevision: quarantined.revision,
      preset: "high",
      sessionId: session.id,
    })).toThrow("SESSION_PRESET_RECOVERY_REQUIRED");

    const recovered = store.resolveSessionMutation({
      attemptId: attempt.id,
      expectedEvidenceDigest: evidence.digest,
      expectedOriginalState: "ambiguous",
      provider: {
        providerThreadId: "thread-legacy-recovery-preset",
        providerUpdatedAt: 11,
        status: "idle",
        title: "Legacy recovery preset",
      },
      receipt: { turnId: "turn-legacy-recovery-preset" },
      message: "legacy recovery",
      resolution: "proven_applied",
      resolutionEvidence: { providerUpdatedAt: 11, source: "thread/read" },
    });
    expect(recovered.state).toBe("idle");
    expect(recovered.messageEvent).toMatchObject({
      appended: true,
      event: {
        body: {
          type: "user_message",
          actor: "human",
          text: "legacy recovery",
        },
      },
    });
    expect(store.readSessionMessageEventSource(session.id, attempt.id))
      .toMatchObject({ actor: "human", sourceKind: "mutation" });
    expect(store.runtimeProfileForTurn(session.id, "turn-legacy-recovery-preset"))
      .toEqual(runtimeProfile);
    expect(store.requireSessionPresetRequirement(session.id).requirement)
      .toEqual({ model: "gpt-5.6-sol", effort: "max" });

    store.updateSessionMetadata({
      expectedRevision: recovered.revision,
      preset: "high",
      sessionId: session.id,
    });
    expect(store.requireSessionPresetRequirement(session.id).requirement)
      .toEqual({ model: "gpt-6-astra", effort: "max" });
  });
test("records the session provider and refuses another provider's preset", async () => {
    const { store } = await fixture();
    const profile = store.createProfile("Providers");

    // Every existing path is unchanged: no provider named means Codex.
    const codex = store.createSession({ profileId: profile.id, preset: "high", fastEnabled: false });
    expect(codex.provider).toBe("codex");
    expect(codex.preset).toBe("high");

    const claude = store.createSession({
      profileId: profile.id,
      preset: "fable-max",
      provider: "claude",
      fastEnabled: false,
    });
    expect(claude.provider).toBe("claude");
    expect(claude.preset).toBe("fable-max");
    expect(store.requireSession(claude.id).preset).toBe("fable-max");

    expect(() => store.createSession({
      profileId: profile.id,
      preset: "fable-max",
      fastEnabled: false,
    })).toThrow("does not support the `fable-max` model preset");
    expect(() => store.createSession({
      profileId: profile.id,
      preset: "ultra",
      provider: "claude",
      fastEnabled: false,
    })).toThrow("does not support the `ultra` model preset");

    // A preset change is refused, never silently ignored.
    expect(() => store.updateSessionMetadata({
      sessionId: claude.id,
      expectedRevision: claude.revision,
      preset: "ultra",
    })).toThrow("does not support the `ultra` model preset");
    expect(() => store.updateSessionMetadata({
      sessionId: codex.id,
      expectedRevision: codex.revision,
      preset: "fable-max",
    })).toThrow("does not support the `fable-max` model preset");
    expect(store.requireSession(claude.id).preset).toBe("fable-max");
  });
test("reads the daemon default preset against the named provider", async () => {
    const { store } = await fixture();
    expect(store.readDefaultPreset()).toBe("ultra");
    expect(store.readDefaultPreset("claude")).toBe("fable-max");
    store.setDefaultPreset("fable-max");
    expect(store.readDefaultPreset()).toBe("ultra");
    expect(store.readDefaultPreset("claude")).toBe("fable-max");
    store.setDefaultPreset("low");
    expect(store.readDefaultPreset()).toBe("low");
    expect(() => store.readDefaultPreset("claude")).toThrow("No claude model preset exists");
  });
test("archives sessions out of the default listing and keeps them readable", async () => {
    const { store } = await fixture();
    const profile = store.createProfile("Archive");
    const kept = store.createSession({ profileId: profile.id, preset: "high", fastEnabled: false });
    const archived = store.createSession({ profileId: profile.id, preset: "high", fastEnabled: false });
    expect(store.requireSession(archived.id).archivedAt).toBeUndefined();

    const marked = store.setSessionArchived(archived.id, true);
    expect(marked.archivedAt).toBeGreaterThan(0);
    // Archive is presentation state, not session authority: the revision is
    // untouched so an in-flight optimistic update still applies.
    expect(marked.revision).toBe(archived.revision);
    expect(store.listSessions(50).map((session) => session.id)).toEqual([kept.id]);
    expect(store.listSessions(50, profile.id).map((session) => session.id)).toEqual([kept.id]);
    expect(store.listSessions(50, undefined, true).map((session) => session.id).sort())
      .toEqual([kept.id, archived.id].sort());
    expect(store.listLocalSessionPage({ profileId: profile.id, after: null, limit: 50 })
      .sessions.map((session) => session.id)).toEqual([kept.id]);
    expect(store.listLocalSessionPage({ profileId: profile.id, after: null, includeArchived: true, limit: 50 })
      .sessions).toHaveLength(2);
    // The session itself is never hidden from a direct read.
    expect(store.requireSession(archived.id).id).toBe(archived.id);

    expect(store.setSessionArchived(archived.id, false).archivedAt).toBeUndefined();
    expect(store.listSessions(50)).toHaveLength(2);
    expect(() => store.setSessionArchived("sess_00000000000000000000000000000001", true))
      .toThrow(SelectionError);
  });
test("keeps show-thinking and the default preset as daemon settings with session overrides", async () => {
    const { store } = await fixture();
    const profile = store.createProfile("Settings");
    const session = store.createSession({
      profileId: profile.id,
      preset: "high",
      fastEnabled: false,
    });

    expect(store.readDefaultShowThinking()).toBe(false);
    expect(store.readSessionShowThinking(session.id)).toEqual({ enabled: false, source: "default" });
    store.setSessionShowThinking(session.id, true);
    expect(store.readSessionShowThinking(session.id)).toEqual({ enabled: true, source: "session" });
    store.setDefaultShowThinking(true);
    store.setSessionShowThinking(session.id, false);
    expect(store.readSessionShowThinking(session.id)).toEqual({ enabled: false, source: "session" });
    store.setSessionShowThinking(session.id, null);
    expect(store.readSessionShowThinking(session.id)).toEqual({ enabled: true, source: "default" });
    expect(() => store.setSessionShowThinking("sess_00000000000000000000000000000001", true))
      .toThrow(SelectionError);

    expect(store.readDefaultPreset()).toBe("ultra");
    store.setDefaultPreset("low");
    expect(store.readDefaultPreset()).toBe("low");
    expect(() => store.setDefaultPreset("max" as "low")).toThrow();
  });
test("adopts personal-home candidates atomically and keeps provenance private", async () => {
    const { store } = await fixture();
    const profile = signInProfile(store, "Personal runtime", "personal-runtime@example.com");
    expect(store.readSessionAdoptionPolicy("codex")).toBeNull();
    expect(store.setSessionAdoptionPolicy({
      provider: "codex",
      profileId: profile.id,
    })).toMatchObject({
      enabled: true,
      profileId: profile.id,
      provider: "codex",
      revision: 1,
    });

    const providerProjectRoot = "/private/provider-project/alias/..";
    const candidate = store.upsertSessionAdoptionCandidate({
      provider: "codex",
      providerThreadId: "personal-thread",
      providerProjectRoot,
      title: "Personal terminal session",
      state: "idle",
      providerUpdatedAt: 10,
      liveness: "not_live",
    });
    expect(candidate).toMatchObject({
      provider: "codex",
      providerThreadId: "personal-thread",
      providerProjectRoot,
      status: "pending",
    });
    const refreshedCandidate = store.upsertSessionAdoptionCandidate({
      provider: "codex",
      providerThreadId: "personal-thread",
      providerProjectRoot,
      title: "Personal terminal session",
      state: "idle",
      providerUpdatedAt: 10,
      liveness: "not_live",
    });
    expect(() => store.adoptSessionCandidate({
      providerAuthority: store.requireProviderAccountAuthority(profile.id, "codex"),
      provider: "codex",
      providerThreadId: candidate.providerThreadId,
      expectedCandidateRevision: candidate.revision,
      profileId: profile.id,
      profileGeneration: profile.processGeneration,
      preset: "ultra",
      requirement: presetRequirements.ultra,
      fastEnabled: true,
      runtimeProfile: codexAdoptionRuntimeProfile(profile, "ultra", true),
      providerAccountKey: providerAccountKeyForProfile(store, profile.id, "codex"),
    })).toThrow("SESSION_ADOPTION_CANDIDATE_STALE");
    expect(() => store.adoptSessionCandidate({
      providerAuthority: store.requireProviderAccountAuthority(profile.id, "codex"),
      provider: "codex",
      providerThreadId: candidate.providerThreadId,
      expectedCandidateRevision: refreshedCandidate.revision,
      profileId: profile.id,
      profileGeneration: profile.processGeneration,
      preset: "ultra",
      requirement: presetRequirements.ultra,
      fastEnabled: true,
      runtimeProfile: codexAdoptionRuntimeProfile(profile, "ultra", true),
      providerAccountKey: providerAccountKeyForProfile(store, profile.id, "codex"),
    })).toThrow("SESSION_ADOPTION_CANDIDATE_NOT_CLAIMED");
    const firstPreflight = store.recordSessionAdoptionCandidatePreflightAttempt({
      provider: "codex",
      providerThreadId: candidate.providerThreadId,
      expectedRevision: refreshedCandidate.revision,
    });
    expect(firstPreflight).toMatchObject({ status: "pending" });
    expect(firstPreflight.lastAttemptAt).not.toBeNull();
    const secondPreflight = store.recordSessionAdoptionCandidatePreflightAttempt({
      provider: "codex",
      providerThreadId: candidate.providerThreadId,
      expectedRevision: firstPreflight.revision,
    });
    expect(secondPreflight.lastAttemptAt).toBeGreaterThan(firstPreflight.lastAttemptAt ?? 0);
    expect(() => store.recordSessionAdoptionCandidatePreflightAttempt({
      provider: "codex",
      providerThreadId: candidate.providerThreadId,
      expectedRevision: firstPreflight.revision,
    })).toThrow("SESSION_ADOPTION_CANDIDATE_PREFLIGHT_CONFLICT");
    const claimedCandidate = store.fenceSessionAdoptionCandidateForClaim({
      provider: "codex",
      providerThreadId: candidate.providerThreadId,
      expectedRevision: secondPreflight.revision,
    });
    const adopted = store.adoptSessionCandidate({
      providerAuthority: store.requireProviderAccountAuthority(profile.id, "codex"),
      provider: "codex",
      providerThreadId: candidate.providerThreadId,
      expectedCandidateRevision: claimedCandidate.revision,
      profileId: profile.id,
      profileGeneration: profile.processGeneration,
      preset: "ultra",
      requirement: presetRequirements.ultra,
      fastEnabled: true,
      runtimeProfile: codexAdoptionRuntimeProfile(profile, "ultra", true),
      providerAccountKey: providerAccountKeyForProfile(store, profile.id, "codex"),
    });
    expect(adopted.session).toMatchObject({
      profileId: profile.id,
      provider: "codex",
      providerThreadId: "personal-thread",
      preset: "ultra",
      fastEnabled: true,
      state: "idle",
    });
    expect(adopted.candidate.status).toBe("adopted");
    expect(adopted.binding).toMatchObject({
      sessionId: adopted.session.id,
      state: "active",
    });
    expect(store.readSessionHostCapabilityBinding(adopted.session.id)).toBeNull();
    expect(store.latestSessionRuntimeProfile(adopted.session.id)).toMatchObject({
      sourceKind: "session_start",
      profile: codexAdoptionRuntimeProfile(profile, "ultra", true),
    });
    expect(Object.keys(adopted.session)).not.toContain("origin");
    expect(Object.keys(adopted.session)).not.toContain("adopted");
    expect(Object.keys(adopted.session)).not.toContain("providerProjectRoot");
    expect(store.isConversationAutomationEnabled(
      adopted.session.id,
      adopted.session.providerThreadId ?? "",
    )).toBe(false);
    expect(store.hasNativeConversationAutomationAuthority(
      adopted.session.id,
      adopted.session.providerThreadId ?? "",
    )).toBe(false);
    expect(store.listLocalSessionPage({
      profileId: profile.id,
      after: null,
      limit: 1,
    })).toEqual({ sessions: [adopted.session], nextPosition: null });
    store.setSessionArchived(adopted.session.id, true);
    expect(store.listLocalSessionPage({
      profileId: profile.id,
      after: null,
      limit: 1,
    }).sessions).toEqual([]);
    expect(store.listLocalSessionPage({
      profileId: profile.id,
      after: null,
      includeArchived: true,
      limit: 1,
    }).sessions).toEqual([store.requireSession(adopted.session.id)]);
    store.setSessionArchived(adopted.session.id, false);

    const detached = store.detachPersonalSession({ sessionId: adopted.session.id });
    expect(detached.binding.state).toBe("detached");
    expect(detached.candidate.status).toBe("fenced");
    expect(detached.session.archivedAt).toBeDefined();
    expect(store.readSessionPersonalRuntimeBinding(adopted.session.id)).toBeNull();
    expect(store.readSessionPersonalRuntimeBinding(adopted.session.id, true)?.state)
      .toBe("detached");
    expect(store.listLocalSessionPage({
      profileId: profile.id,
      after: null,
      includeArchived: true,
      limit: 1,
    }).sessions).toEqual([store.requireSession(adopted.session.id)]);

    // A liveness-only observation does not invent conversation activity and
    // therefore cannot defeat an explicit detach fence.
    expect(store.upsertSessionAdoptionCandidate({
      provider: "codex",
      providerThreadId: "personal-thread",
      providerProjectRoot,
      title: "Personal terminal session",
      state: "idle",
      providerUpdatedAt: 10,
      liveness: "not_live",
    }).status).toBe("fenced");
    const changedProviderProjectRoot = "/private/provider-project/changed/..";
    expect(store.upsertSessionAdoptionCandidate({
      provider: "codex",
      providerThreadId: "personal-thread",
      providerProjectRoot: changedProviderProjectRoot,
      title: "Personal terminal session",
      state: "idle",
      providerUpdatedAt: 10,
      liveness: "not_live",
    })).toMatchObject({
      providerProjectRoot: changedProviderProjectRoot,
      status: "pending",
    });

    store.setSessionAdoptionPolicy({ provider: "codex", profileId: null });
    store.setSessionAdoptionPolicy({ provider: "codex", profileId: profile.id });
    const pendingAgain = store.listSessionAdoptionCandidates({ provider: "codex" })[0];
    expect(pendingAgain?.status).toBe("pending");
    if (pendingAgain === undefined) throw new Error("Expected the candidate to be pending again.");
    const claimedAgain = store.fenceSessionAdoptionCandidateForClaim({
      provider: "codex",
      providerThreadId: pendingAgain.providerThreadId,
      expectedRevision: pendingAgain.revision,
    });
    const readopted = store.adoptSessionCandidate({
      providerAuthority: store.requireProviderAccountAuthority(profile.id, "codex"),
      provider: "codex",
      providerThreadId: "personal-thread",
      expectedCandidateRevision: claimedAgain.revision,
      profileId: profile.id,
      profileGeneration: profile.processGeneration,
      preset: "high",
      requirement: presetRequirements.high,
      fastEnabled: false,
      runtimeProfile: codexAdoptionRuntimeProfile(profile, "high", false),
      providerAccountKey: providerAccountKeyForProfile(store, profile.id, "codex"),
    });
    expect(readopted.session).toMatchObject({
      id: adopted.session.id,
      preset: "high",
      fastEnabled: false,
    });
    expect("archivedAt" in readopted.session).toBe(false);
    expect(readopted.binding).toMatchObject({ state: "active", revision: 4 });
    expect(store.readSessionHostCapabilityBinding(readopted.session.id)).toBeNull();
    expect(store.isConversationAutomationEnabled(
      readopted.session.id,
      readopted.session.providerThreadId ?? "",
    )).toBe(false);
    expect(store.hasNativeConversationAutomationAuthority(
      readopted.session.id,
      readopted.session.providerThreadId ?? "",
    )).toBe(false);

    store.detachPersonalSession({ sessionId: adopted.session.id, archive: false });
    const conflictingCandidate = store.upsertSessionAdoptionCandidate({
      provider: "codex",
      providerThreadId: "personal-thread",
      providerProjectRoot,
      title: "Personal terminal session",
      state: "idle",
      providerUpdatedAt: 11,
      liveness: "not_live",
    });
    expect(conflictingCandidate.status).toBe("pending");
    const conflictingClaim = store.fenceSessionAdoptionCandidateForClaim({
      provider: "codex",
      providerThreadId: conflictingCandidate.providerThreadId,
      expectedRevision: conflictingCandidate.revision,
    });
    const unexpectedHostCapabilityBinding = store.bindSessionHostCapabilities({
      sessionId: adopted.session.id,
      ...testUnexpectedAdoptionHostCapabilities,
    });
    expect(() => store.adoptSessionCandidate({
      provider: "codex",
      providerThreadId: "personal-thread",
      expectedCandidateRevision: conflictingClaim.revision,
      profileId: profile.id,
      providerAuthority: store.requireProviderAccountAuthority(profile.id, "codex"),
      profileGeneration: profile.processGeneration,
      preset: "high",
      requirement: presetRequirements.high,
      fastEnabled: false,
      runtimeProfile: codexAdoptionRuntimeProfile(profile, "high", false),
      providerAccountKey: providerAccountKeyForProfile(store, profile.id, "codex"),
    })).toThrow("SESSION_ADOPTION_HOST_CAPABILITY_BINDING_CONFLICT");
    expect(store.readSessionHostCapabilityBinding(adopted.session.id))
      .toEqual(unexpectedHostCapabilityBinding);
    expect(store.readSessionPersonalRuntimeBinding(adopted.session.id, true))
      .toMatchObject({ state: "detached" });
    expect(store.listSessionAdoptionCandidates({ provider: "codex" })[0])
      .toMatchObject({ status: "claiming" });
    const managedLegacy = store.upsertProviderSession({
      providerAuthority: store.requireProviderAccountAuthority(profile.id, "codex"),
      profileId: profile.id,
      provider: "codex",
      providerThreadId: "managed-legacy-automation-thread",
      title: "Managed legacy automation",
      preset: "high",
      fastEnabled: false,
      state: "idle",
      providerAccountKey: providerAccountKeyForProfile(store, profile.id, "codex"),
      conversationAutomationEnabled: true,
    });
    expect(store.hasNativeConversationAutomationAuthority(
      managedLegacy.id,
      managedLegacy.providerThreadId ?? "",
    )).toBe(false);
  });
test("records candidate preflight fairness across wall-clock rollback", async () => {
    let now = 2_000;
    const { store } = await fixture({ now: () => now });
    const candidate = store.upsertSessionAdoptionCandidate({
      provider: "codex",
      providerThreadId: "rollback-preflight-candidate",
      title: "Rollback preflight candidate",
      state: "idle",
      liveness: "not_live",
    });
    now = 3_000;
    const laterCandidate = store.upsertSessionAdoptionCandidate({
      provider: "codex",
      providerThreadId: "later-rollback-preflight-candidate",
      title: "Later rollback preflight candidate",
      state: "idle",
      liveness: "not_live",
    });

    now = 1_000;
    const firstAttempt = store.recordSessionAdoptionCandidatePreflightAttempt({
      provider: candidate.provider,
      providerThreadId: candidate.providerThreadId,
      expectedRevision: candidate.revision,
    });
    const laterAttempt = store.recordSessionAdoptionCandidatePreflightAttempt({
      provider: laterCandidate.provider,
      providerThreadId: laterCandidate.providerThreadId,
      expectedRevision: laterCandidate.revision,
    });
    const retriedFirst = store.recordSessionAdoptionCandidatePreflightAttempt({
      provider: firstAttempt.provider,
      providerThreadId: firstAttempt.providerThreadId,
      expectedRevision: firstAttempt.revision,
    });

    expect(firstAttempt.lastAttemptAt).toBe(candidate.lastObservedAt);
    expect(laterAttempt.lastAttemptAt).toBe(laterCandidate.lastObservedAt);
    expect(retriedFirst.lastAttemptAt).toBe((laterAttempt.lastAttemptAt ?? 0) + 1);
    expect(retriedFirst.revision).toBe(candidate.revision + 2);
    expect(retriedFirst.status).toBe("pending");
  });
test("stores truthful provider configuration and refuses adoption collisions", async () => {
    const { store } = await fixture();
    const first = signInProfile(store, "First adopter", "first-adopter@example.com");
    const second = signInProfile(store, "Second adopter", "second-adopter@example.com");
    const claude = store.upsertProviderSession({
      providerAuthority: store.requireProviderAccountAuthority(first.id, "claude"),
      profileId: first.id,
      provider: "claude",
      providerThreadId: "truthful-thread",
      title: "Truthful provider",
      preset: "fable-max",
      fastEnabled: false,
      state: "idle",
      providerUpdatedAt: 1,
      providerAccountKey: testProviderAccountKey("claude"),
    });
    expect(claude).toMatchObject({
      provider: "claude",
      preset: "fable-max",
      fastEnabled: false,
    });
    expect(() => store.upsertProviderSession({
      providerAuthority: store.requireProviderAccountAuthority(first.id, "codex"),
      profileId: first.id,
      provider: "codex",
      providerThreadId: "truthful-thread",
      title: "Conflicting provider",
      preset: "high",
      fastEnabled: false,
      state: "idle",
      providerUpdatedAt: 2,
      providerAccountKey: providerAccountKeyForProfile(store, first.id, "codex"),
    })).toThrow("PROVIDER_SESSION_IMPORT_AUTHORITY_MISMATCH");

    store.setSessionAdoptionPolicy({ provider: "codex", profileId: first.id });
    const ownerCandidate = store.upsertSessionAdoptionCandidate({
      provider: "codex",
      providerThreadId: "one-owner-thread",
      title: "One owner",
      state: "idle",
      liveness: "not_live",
    });
    const claimedOwner = store.fenceSessionAdoptionCandidateForClaim({
      provider: "codex",
      providerThreadId: ownerCandidate.providerThreadId,
      expectedRevision: ownerCandidate.revision,
    });
    const adopted = store.adoptSessionCandidate({
      providerAuthority: store.requireProviderAccountAuthority(first.id, "codex"),
      provider: "codex",
      providerThreadId: "one-owner-thread",
      expectedCandidateRevision: claimedOwner.revision,
      profileId: first.id,
      profileGeneration: first.processGeneration,
      preset: "high",
      requirement: presetRequirements.high,
      fastEnabled: false,
      runtimeProfile: codexAdoptionRuntimeProfile(first, "high", false),
      providerAccountKey: providerAccountKeyForProfile(store, first.id, "codex"),
    });
    expect(() => store.setSessionAdoptionPolicy({
      provider: "codex",
      profileId: second.id,
    })).toThrow("SESSION_ADOPTION_POLICY_ACTIVE_BINDINGS");
    expect(store.readSessionAdoptionPolicy("codex")?.profileId).toBe(first.id);
    store.detachPersonalSession({ sessionId: adopted.session.id, archive: false });
    store.setSessionAdoptionPolicy({ provider: "codex", profileId: second.id });
    const reassignedCandidate = store.listSessionAdoptionCandidates({
      provider: "codex",
      status: "pending",
    })[0];
    if (reassignedCandidate === undefined) throw new Error("Expected a reassigned candidate.");
    const claimedReassignment = store.fenceSessionAdoptionCandidateForClaim({
      provider: "codex",
      providerThreadId: reassignedCandidate.providerThreadId,
      expectedRevision: reassignedCandidate.revision,
    });
    expect(() => store.adoptSessionCandidate({
      providerAuthority: store.requireProviderAccountAuthority(second.id, "codex"),
      provider: "codex",
      providerThreadId: "one-owner-thread",
      expectedCandidateRevision: claimedReassignment.revision,
      profileId: second.id,
      profileGeneration: second.processGeneration,
      preset: "high",
      requirement: presetRequirements.high,
      fastEnabled: false,
      runtimeProfile: codexAdoptionRuntimeProfile(second, "high", false),
      providerAccountKey: providerAccountKeyForProfile(store, second.id, "codex"),
    })).toThrow("SESSION_ADOPTION_BINDING_COLLISION");
    expect(store.requireSession(adopted.session.id).profileId).toBe(first.id);
  });
test("cannot adopt Codex after the selected profile loses identifiable authority", async () => {
    const { store } = await fixture();
    const profile = signInProfile(
      store,
      "Codex identity loss",
      "codex-identity-loss@example.com",
    );
    store.setSessionAdoptionPolicy({ provider: "codex", profileId: profile.id });
    expect(store.setProfileState(
      profile.id,
      profile.processGeneration,
      "signed_in",
      { plan: "apiKey" },
    )).toBe(true);
    expect(store.requireProfileById(profile.id).providerEmail).toBeUndefined();
    expect(store.readSessionAdoptionPolicy("codex")).toMatchObject({
      enabled: false,
      profileId: null,
    });

    const candidate = store.upsertSessionAdoptionCandidate({
      provider: "codex",
      providerThreadId: "codex-identity-loss-thread",
      title: "Codex identity loss candidate",
      state: "idle",
      providerUpdatedAt: 10,
      liveness: "not_live",
    });
    const claiming = store.fenceSessionAdoptionCandidateForClaim({
      provider: "codex",
      providerThreadId: candidate.providerThreadId,
      expectedRevision: candidate.revision,
    });

    // Simulate a damaged pre-release database in which stale policy authority
    // survived identity loss. The adoption transaction must still fail closed.
    const raw = new Database(store.paths.database, { create: false, strict: true });
    try {
      raw.exec("DROP TRIGGER session_adoption_policy_profile_guard_update");
      raw.exec("DROP TRIGGER session_adoption_policy_unsettled_claim_guard");
      raw.query(
        `UPDATE session_adoption_policies
         SET profile_id=?,state='enabled',revision=revision+1,updated_at=updated_at+1
         WHERE provider='codex'`,
      ).run(profile.id);
    } finally {
      raw.close(false);
    }
    expect(() => store.adoptSessionCandidate({
      providerAuthority: store.requireProviderAccountAuthority(profile.id, "codex"),
      provider: "codex",
      providerThreadId: claiming.providerThreadId,
      expectedCandidateRevision: claiming.revision,
      profileId: profile.id,
      profileGeneration: profile.processGeneration,
      preset: "high",
      requirement: presetRequirements.high,
      fastEnabled: false,
      runtimeProfile: codexAdoptionRuntimeProfile(profile, "high", false),
      providerAccountKey: testProviderAccountKey("codex"),
    })).toThrow("SESSION_ADOPTION_PROFILE_NOT_SIGNED_IN");
    expect(store.findSessionPersonalRuntimeBinding(
      "codex",
      candidate.providerThreadId,
    )).toBeNull();
  });
test("recovers an interrupted claim only after a later quiet observation", async () => {
    const { store } = await fixture();
    const profile = signInProfile(store, "Interrupted adopter", "interrupted-adopter@example.com");
    const otherProfile = signInProfile(
      store,
      "Other interrupted adopter",
      "other-interrupted-adopter@example.com",
    );
    store.setSessionAdoptionPolicy({ provider: "codex", profileId: profile.id });
    const candidate = store.upsertSessionAdoptionCandidate({
      provider: "codex",
      providerThreadId: "interrupted-claim-thread",
      title: "Interrupted claim",
      state: "idle",
      providerUpdatedAt: 10,
      liveness: "not_live",
    });
    const claiming = store.fenceSessionAdoptionCandidateForClaim({
      provider: "codex",
      providerThreadId: candidate.providerThreadId,
      expectedRevision: candidate.revision,
    });

    expect(() => store.recoverSessionAdoptionClaimAfterObservation({
      provider: "codex",
      providerThreadId: claiming.providerThreadId,
      profileId: profile.id,
      expectedRevision: claiming.revision,
    })).toThrow("SESSION_ADOPTION_CLAIM_RECOVERY_NOT_PROVEN");
    expect(() => store.setSessionAdoptionPolicy({
      provider: "codex",
      profileId: null,
    })).toThrow("SESSION_ADOPTION_POLICY_UNSETTLED_CLAIM");
    expect(() => store.setSessionAdoptionPolicy({
      provider: "codex",
      profileId: otherProfile.id,
    })).toThrow("SESSION_ADOPTION_POLICY_UNSETTLED_CLAIM");
    expect(store.readSessionAdoptionPolicy("codex")?.profileId).toBe(profile.id);
    expect(store.listSessionAdoptionCandidates({ provider: "codex" })[0]?.status)
      .toBe("claiming");

    const observedAgain = store.upsertSessionAdoptionCandidate({
      provider: "codex",
      providerThreadId: claiming.providerThreadId,
      title: "Interrupted claim",
      state: "idle",
      providerUpdatedAt: 10,
      liveness: "not_live",
    });
    expect(store.recoverSessionAdoptionClaimAfterObservation({
      provider: "codex",
      providerThreadId: claiming.providerThreadId,
      profileId: profile.id,
      expectedRevision: observedAgain.revision,
    }).status).toBe("pending");
  });
test("round-trips Claude source identity and applies exact-probe liveness with a strict CAS", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "oompa-store-claude-probe-")));
    const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
    await initializeStatePaths(paths);
    const store = new StateStore(paths, { now: () => 1_000 });
    stores.push(store);
    const profile = signInProfile(store, "Claude probe", "claude-probe@example.com");
    store.setSessionAdoptionPolicy({ provider: "claude", profileId: profile.id });
    const identity = {
      pid: 41_001,
      pidDomain: "darwin" as const,
      procStart: "Fri Sep  4 11:00:00 2026",
    };
    const replacementIdentity = {
      pid: 41_002,
      pidDomain: "darwin" as const,
      procStart: "Fri Sep  4 11:01:00 2026",
    };
    const observed = store.upsertSessionAdoptionCandidate({
      provider: "claude",
      providerThreadId: "claude-retained-probe",
      title: "Retained Claude candidate",
      state: "terminal",
      providerUpdatedAt: 10,
      liveness: "live",
      sourceProcessIdentity: identity,
      trustedLiveObservation: true,
    });
    expect(observed.sourceProcessIdentity).toEqual(identity);
    const preserved = store.upsertSessionAdoptionCandidate({
      provider: "claude",
      providerThreadId: observed.providerThreadId,
      title: observed.title,
      state: observed.providerState,
      ...(observed.providerUpdatedAt === null
        ? {}
        : { providerUpdatedAt: observed.providerUpdatedAt }),
      liveness: observed.liveness,
    });
    expect(preserved.sourceProcessIdentity).toEqual(identity);

    const claiming = store.fenceSessionAdoptionCandidateForClaim({
      provider: "claude",
      providerThreadId: preserved.providerThreadId,
      expectedRevision: preserved.revision,
    });
    const probed = store.updateClaudeSessionAdoptionCandidateLivenessAfterExactProbe({
      providerThreadId: claiming.providerThreadId,
      expectedRevision: claiming.revision,
      expectedSourceProcessIdentity: identity,
      liveness: "not_live",
    });
    expect(probed).toMatchObject({
      liveness: "not_live",
      sourceProcessIdentity: identity,
      status: "claiming",
    });
    expect(probed.lastObservedAt).toBeGreaterThan(probed.lastAttemptAt ?? Number.MAX_VALUE);
    expect(() => store.updateClaudeSessionAdoptionCandidateLivenessAfterExactProbe({
      providerThreadId: probed.providerThreadId,
      expectedRevision: claiming.revision,
      expectedSourceProcessIdentity: identity,
      liveness: "live",
    })).toThrow("SESSION_ADOPTION_CANDIDATE_PROBE_CONFLICT");
    expect(() => store.updateClaudeSessionAdoptionCandidateLivenessAfterExactProbe({
      providerThreadId: probed.providerThreadId,
      expectedRevision: probed.revision,
      expectedSourceProcessIdentity: replacementIdentity,
      liveness: "live",
    })).toThrow("SESSION_ADOPTION_CANDIDATE_PROBE_CONFLICT");

    const recovered = store.recoverSessionAdoptionClaimAfterObservation({
      provider: "claude",
      providerThreadId: probed.providerThreadId,
      profileId: profile.id,
      expectedRevision: probed.revision,
    });
    const reclaimed = store.fenceSessionAdoptionCandidateForClaim({
      provider: "claude",
      providerThreadId: recovered.providerThreadId,
      expectedRevision: recovered.revision,
    });
    store.recordClaimedClaudeProcessAuthority({
      providerAuthority: store.requireProviderAccountAuthority(profile.id, "claude"),
      providerThreadId: reclaimed.providerThreadId,
      profileId: profile.id,
      profileGeneration: profile.processGeneration,
      runtimeScope: "personal",
      identity,
    });
    const claimedWithAuthority = store.listSessionAdoptionCandidates({
      provider: "claude",
    }).find((candidate) => candidate.providerThreadId === reclaimed.providerThreadId);
    if (claimedWithAuthority === undefined) {
      throw new Error("Expected the claimed candidate after process custody was recorded.");
    }
    const adopted = store.adoptSessionCandidate({
      providerAuthority: store.requireProviderAccountAuthority(profile.id, "claude"),
      provider: "claude",
      providerThreadId: reclaimed.providerThreadId,
      expectedCandidateRevision: claimedWithAuthority.revision,
      profileId: profile.id,
      profileGeneration: profile.processGeneration,
      preset: "fable-max",
      requirement: presetRequirements["fable-max"],
      fastEnabled: false,
      runtimeProfile: claudeAdoptionRuntimeProfile(store.requireProviderAccountAuthority(profile.id, "claude")),
      providerAccountKey: testProviderAccountKey("claude"),
      claudeProcessIdentity: identity,
    });
    expect(() => store.updateClaudeSessionAdoptionCandidateLivenessAfterExactProbe({
      providerThreadId: adopted.candidate.providerThreadId,
      expectedRevision: adopted.candidate.revision,
      expectedSourceProcessIdentity: identity,
      liveness: "live",
    })).toThrow("SESSION_ADOPTION_CANDIDATE_PROBE_CONFLICT");

    const authority = store.readClaudeProcessAuthority({
      providerThreadId: adopted.candidate.providerThreadId,
      profileId: profile.id,
      runtimeScope: "personal",
    });
    if (authority === null) throw new Error("Expected retained Claude process authority.");
    const releasing = store.beginClaudeProcessAuthorityRelease({
      providerThreadId: authority.providerThreadId,
      profileId: authority.profileId,
      runtimeScope: authority.runtimeScope,
      expectedRevision: authority.revision,
      identity: authority.identity,
    });
    store.completeClaudeProcessAuthorityRelease({
      providerThreadId: releasing.providerThreadId,
      profileId: releasing.profileId,
      runtimeScope: releasing.runtimeScope,
      expectedRevision: releasing.revision,
      identity: releasing.identity,
    });
    const detached = store.detachPersonalSession({
      sessionId: adopted.session.id,
      archive: false,
    });
    expect(detached.candidate.status).toBe("fenced");
    expect(() => store.updateClaudeSessionAdoptionCandidateLivenessAfterExactProbe({
      providerThreadId: detached.candidate.providerThreadId,
      expectedRevision: detached.candidate.revision,
      expectedSourceProcessIdentity: identity,
      liveness: "live",
    })).toThrow("SESSION_ADOPTION_CANDIDATE_PROBE_CONFLICT");

    const sameIdentity = store.upsertSessionAdoptionCandidate({
      provider: "claude",
      providerThreadId: detached.candidate.providerThreadId,
      title: detached.candidate.title,
      state: detached.candidate.providerState,
      ...(detached.candidate.providerUpdatedAt === null
        ? {}
        : { providerUpdatedAt: detached.candidate.providerUpdatedAt }),
      liveness: detached.candidate.liveness,
    });
    expect(sameIdentity).toMatchObject({
      sourceProcessIdentity: identity,
      status: "fenced",
    });
    const changedIdentity = store.upsertSessionAdoptionCandidate({
      provider: "claude",
      providerThreadId: detached.candidate.providerThreadId,
      title: detached.candidate.title,
      state: detached.candidate.providerState,
      ...(detached.candidate.providerUpdatedAt === null
        ? {}
        : { providerUpdatedAt: detached.candidate.providerUpdatedAt }),
      liveness: detached.candidate.liveness,
      sourceProcessIdentity: replacementIdentity,
    });
    expect(changedIdentity).toMatchObject({
      sourceProcessIdentity: replacementIdentity,
      status: "pending",
    });
    expect(store.listRecentClaudeSessionAdoptionCandidatesWithSourceIdentity({
      providerUpdatedAfter: 10,
    }).map((candidate) => candidate.providerThreadId)).toContain(
      changedIdentity.providerThreadId,
    );
    const detachedBindingProbed = store
      .updateClaudeSessionAdoptionCandidateLivenessAfterExactProbe({
        providerThreadId: changedIdentity.providerThreadId,
        expectedRevision: changedIdentity.revision,
        expectedSourceProcessIdentity: replacementIdentity,
        liveness: "not_live",
      });
    expect(detachedBindingProbed.status).toBe("pending");
    expect(store.upsertSessionAdoptionCandidate({
      provider: "claude",
      providerThreadId: detached.candidate.providerThreadId,
      title: detached.candidate.title,
      state: detached.candidate.providerState,
      ...(detached.candidate.providerUpdatedAt === null
        ? {}
        : { providerUpdatedAt: detached.candidate.providerUpdatedAt }),
      liveness: detached.candidate.liveness,
      sourceProcessIdentity: null,
    }).sourceProcessIdentity).toBeNull();
    expect(() => store.upsertSessionAdoptionCandidate({
      provider: "codex",
      providerThreadId: "codex-cannot-own-source-pid",
      title: "Invalid Codex source",
      state: "idle",
      providerUpdatedAt: 10,
      liveness: "not_live",
      sourceProcessIdentity: identity,
    })).toThrow("SESSION_ADOPTION_SOURCE_PROCESS_PROVIDER_INVALID");
  });
test("rejects unsafe private provider project roots without disclosing them", async () => {
    const { store } = await fixture();
    const invalidRoots = [
      "relative/provider-root",
      `/private/${"x".repeat(8_192)}`,
      "/private/unsafe\u0000provider-root",
    ] as const;
    for (const [index, providerProjectRoot] of invalidRoots.entries()) {
      let failure: unknown;
      try {
        store.upsertSessionAdoptionCandidate({
          provider: "codex",
          providerThreadId: `invalid-provider-root-${index}`,
          providerProjectRoot,
          title: "Invalid provider root",
          state: "idle",
          liveness: "not_live",
        });
      } catch (error: unknown) {
        failure = error;
      }
      expect(String(failure)).toContain("Provider project root is invalid.");
      expect(String(failure)).not.toContain(providerProjectRoot);
    }
  });
test("fairly bounds recent retained Claude candidates eligible for exact reprobe", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "oompa-store-claude-fair-")));
    const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
    await initializeStatePaths(paths);
    const store = new StateStore(paths, { now: () => 1_000 });
    stores.push(store);
    const identity = (pid: number) => ({
      pid,
      pidDomain: "darwin" as const,
      procStart: `claude-process-${pid}`,
    });
    const first = store.upsertSessionAdoptionCandidate({
      provider: "claude",
      providerThreadId: "a-retained-claude",
      title: "First retained Claude candidate",
      state: "terminal",
      providerUpdatedAt: 10,
      liveness: "live",
      sourceProcessIdentity: identity(43_001),
    });
    const second = store.upsertSessionAdoptionCandidate({
      provider: "claude",
      providerThreadId: "b-retained-claude",
      title: "Second retained Claude candidate",
      state: "terminal",
      providerUpdatedAt: 10,
      liveness: "live",
      sourceProcessIdentity: identity(43_002),
    });
    store.upsertSessionAdoptionCandidate({
      provider: "claude",
      providerThreadId: "c-old-claude",
      title: "Old Claude candidate",
      state: "terminal",
      providerUpdatedAt: 9,
      liveness: "live",
      sourceProcessIdentity: identity(43_003),
    });
    store.upsertSessionAdoptionCandidate({
      provider: "claude",
      providerThreadId: "d-identity-free-claude",
      title: "Identity-free Claude candidate",
      state: "terminal",
      providerUpdatedAt: 10,
      liveness: "unknown",
      sourceProcessIdentity: null,
    });
    expect(store.listRecentClaudeSessionAdoptionCandidatesWithSourceIdentity({
      providerUpdatedAfter: 10,
      limit: 1,
    }).map((candidate) => candidate.providerThreadId)).toEqual([first.providerThreadId]);
    store.updateClaudeSessionAdoptionCandidateLivenessAfterExactProbe({
      providerThreadId: first.providerThreadId,
      expectedRevision: first.revision,
      expectedSourceProcessIdentity: identity(43_001),
      liveness: "live",
    });
    expect(store.listRecentClaudeSessionAdoptionCandidatesWithSourceIdentity({
      providerUpdatedAfter: 10,
      limit: 2,
    }).map((candidate) => candidate.providerThreadId)).toEqual([
      second.providerThreadId,
      first.providerThreadId,
    ]);
  });
test("retains Oompa live time only for an exact-pinned Claude process identity", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "oompa-store-claude-live-time-")));
    const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
    await initializeStatePaths(paths);
    let now = 1_000;
    const store = new StateStore(paths, { now: () => now });
    stores.push(store);
    const identity = {
      pid: 44_001,
      pidDomain: "darwin" as const,
      procStart: "claude-live-time-original",
    };
    const first = store.upsertSessionAdoptionCandidate({
      provider: "claude",
      providerThreadId: "claude-live-time",
      title: "Claude live time",
      state: "terminal",
      providerUpdatedAt: 10,
      liveness: "live",
      sourceProcessIdentity: identity,
      trustedLiveObservation: true,
    });
    expect(first.lastLiveObservedAt).toBe(1_000);

    now = 1_100;
    const nonLiveObservation = store.upsertSessionAdoptionCandidate({
      provider: "claude",
      providerThreadId: first.providerThreadId,
      title: first.title,
      state: first.providerState,
      providerUpdatedAt: 10,
      liveness: "not_live",
    });
    expect(nonLiveObservation.lastLiveObservedAt).toBe(1_000);

    now = 1_200;
    const nonLiveProbe = store.updateClaudeSessionAdoptionCandidateLivenessAfterExactProbe({
      providerThreadId: first.providerThreadId,
      expectedRevision: nonLiveObservation.revision,
      expectedSourceProcessIdentity: identity,
      liveness: "not_live",
    });
    expect(nonLiveProbe.lastLiveObservedAt).toBe(1_000);

    now = 1_300;
    const unpinnedLiveObservation = store.upsertSessionAdoptionCandidate({
      provider: "claude",
      providerThreadId: first.providerThreadId,
      title: first.title,
      state: first.providerState,
      providerUpdatedAt: 10,
      liveness: "live",
    });
    expect(unpinnedLiveObservation.lastLiveObservedAt).toBe(1_000);

    now = 1_400;
    const liveProbe = store.updateClaudeSessionAdoptionCandidateLivenessAfterExactProbe({
      providerThreadId: first.providerThreadId,
      expectedRevision: unpinnedLiveObservation.revision,
      expectedSourceProcessIdentity: identity,
      liveness: "live",
    });
    expect(liveProbe.lastLiveObservedAt).toBe(1_400);

    now = 1_500;
    const replacement = store.upsertSessionAdoptionCandidate({
      provider: "claude",
      providerThreadId: first.providerThreadId,
      title: first.title,
      state: first.providerState,
      providerUpdatedAt: 10,
      liveness: "not_live",
      sourceProcessIdentity: {
        pid: 44_002,
        pidDomain: "darwin",
        procStart: "claude-live-time-replacement",
      },
    });
    expect(replacement.lastLiveObservedAt).toBeNull();

    expect(() => store.upsertSessionAdoptionCandidate({
      provider: "claude",
      providerThreadId: "claude-unpinned-trusted-live",
      title: "Claude unpinned trusted live",
      state: "active",
      liveness: "live",
      trustedLiveObservation: true,
    })).toThrow("SESSION_ADOPTION_TRUSTED_LIVE_OBSERVATION_INVALID");
    expect(() => store.upsertSessionAdoptionCandidate({
      provider: "codex",
      providerThreadId: "codex-non-live-trusted-observation",
      title: "Codex non-live trusted observation",
      state: "idle",
      liveness: "not_live",
      trustedLiveObservation: true,
    })).toThrow("SESSION_ADOPTION_TRUSTED_LIVE_OBSERVATION_INVALID");

    now = 1_600;
    const codexLive = store.upsertSessionAdoptionCandidate({
      provider: "codex",
      providerThreadId: "codex-trusted-live-time",
      title: "Codex trusted live time",
      state: "active",
      activeTurnId: "codex-active-turn",
      liveness: "live",
      trustedLiveObservation: true,
    });
    expect(codexLive.lastLiveObservedAt).toBe(1_600);
    now = 1_700;
    const codexQuiet = store.upsertSessionAdoptionCandidate({
      provider: "codex",
      providerThreadId: codexLive.providerThreadId,
      title: codexLive.title,
      state: "idle",
      liveness: "not_live",
    });
    expect(codexQuiet.lastLiveObservedAt).toBe(1_600);
    const codexClaiming = store.fenceSessionAdoptionCandidateForClaim({
      provider: "codex",
      providerThreadId: codexQuiet.providerThreadId,
      expectedRevision: codexQuiet.revision,
    });
    now = 1_800;
    expect(store.updateCodexSessionAdoptionCandidateLivenessAfterExactRead({
      providerThreadId: codexClaiming.providerThreadId,
      expectedRevision: codexClaiming.revision,
      liveness: "live",
      trustedLiveObservation: true,
    }).lastLiveObservedAt).toBe(1_800);
  });
test("excludes current Claude discoveries before bounding retained reprobes", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "oompa-store-claude-retained-")));
    const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
    await initializeStatePaths(paths);
    const store = new StateStore(paths, { now: () => 2_000 });
    stores.push(store);
    const identity = (pid: number) => ({
      pid,
      pidDomain: "darwin" as const,
      procStart: `claude-retained-${pid}`,
    });
    const vanished = store.upsertSessionAdoptionCandidate({
      provider: "claude",
      providerThreadId: "z-vanished-retained-claude",
      title: "Vanished retained Claude",
      state: "terminal",
      providerUpdatedAt: 10,
      liveness: "live",
      sourceProcessIdentity: identity(45_000),
      trustedLiveObservation: true,
    });
    const vanishedNonLive = store.upsertSessionAdoptionCandidate({
      provider: "claude",
      providerThreadId: vanished.providerThreadId,
      title: vanished.title,
      state: vanished.providerState,
      providerUpdatedAt: 10,
      liveness: "not_live",
    });
    expect(vanishedNonLive.lastLiveObservedAt).toBe(2_000);

    const currentProviderThreadIds: string[] = [];
    for (let index = 0; index < 125; index += 1) {
      const providerThreadId = `a-current-claude-${String(index).padStart(3, "0")}`;
      currentProviderThreadIds.push(providerThreadId);
      store.upsertSessionAdoptionCandidate({
        provider: "claude",
        providerThreadId,
        title: `Current Claude ${index}`,
        state: "terminal",
        providerUpdatedAt: 10,
        liveness: "live",
        sourceProcessIdentity: identity(45_001 + index),
        trustedLiveObservation: true,
      });
    }
    store.upsertSessionAdoptionCandidate({
      provider: "claude",
      providerThreadId: "a-no-exact-live-proof",
      title: "No exact live proof",
      state: "terminal",
      providerUpdatedAt: 10,
      liveness: "live",
    });

    expect(store.listRetainedClaudeSessionAdoptionCandidatesWithSourceIdentity({
      excludeProviderThreadIds: currentProviderThreadIds,
      liveObservedAfter: 2_000,
      limit: 1,
    }).map((candidate) => candidate.providerThreadId)).toEqual([
      vanished.providerThreadId,
    ]);
    expect(store.listRetainedClaudeSessionAdoptionCandidatesWithSourceIdentity({
      excludeProviderThreadIds: currentProviderThreadIds,
      liveObservedAfter: 2_001,
    })).toEqual([]);
    expect(() => store.listRetainedClaudeSessionAdoptionCandidatesWithSourceIdentity({
      excludeProviderThreadIds: Array.from({ length: 201 }, () => "duplicate-thread"),
      liveObservedAfter: 0,
    })).toThrow();
    expect(() => store.listRetainedClaudeSessionAdoptionCandidatesWithSourceIdentity({
      excludeProviderThreadIds: [],
      liveObservedAfter: 0,
      limit: 201,
    })).toThrow();
  });
test("orders retained Claude reprobes by attempt age then Oompa live age", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "oompa-store-claude-order-")));
    const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
    await initializeStatePaths(paths);
    let now = 1_000;
    const store = new StateStore(paths, { now: () => now });
    stores.push(store);
    const observe = (providerThreadId: string, pid: number) =>
      store.upsertSessionAdoptionCandidate({
        provider: "claude",
        providerThreadId,
        title: providerThreadId,
        state: "terminal",
        liveness: "live",
        sourceProcessIdentity: {
          pid,
          pidDomain: "darwin",
          procStart: `retained-order-${pid}`,
        },
        trustedLiveObservation: true,
      });
    const neverAttemptedOld = observe("z-never-attempted-old", 47_001);
    now = 2_000;
    const neverAttemptedNew = observe("a-never-attempted-new", 47_002);
    now = 3_000;
    const attemptedOld = observe("a-attempted-old", 47_003);
    now = 4_000;
    const attemptedNew = observe("z-attempted-new", 47_004);
    now = 5_000;
    store.fenceSessionAdoptionCandidateForClaim({
      provider: "claude",
      providerThreadId: attemptedOld.providerThreadId,
      expectedRevision: attemptedOld.revision,
    });
    now = 6_000;
    store.fenceSessionAdoptionCandidateForClaim({
      provider: "claude",
      providerThreadId: attemptedNew.providerThreadId,
      expectedRevision: attemptedNew.revision,
    });

    expect(store.listRetainedClaudeSessionAdoptionCandidatesWithSourceIdentity({
      excludeProviderThreadIds: [],
      liveObservedAfter: 0,
      limit: 4,
    }).map((candidate) => candidate.providerThreadId)).toEqual([
      neverAttemptedOld.providerThreadId,
      neverAttemptedNew.providerThreadId,
      attemptedOld.providerThreadId,
      attemptedNew.providerThreadId,
    ]);
  });
test("claims Claude only after liveness ends and fences profile removal", async () => {
    const { store } = await fixture();
    const profile = signInProfile(store, "Claude adopter", "claude-adopter@example.com");
    store.setSessionAdoptionPolicy({ provider: "claude", profileId: profile.id });
    const live = store.upsertSessionAdoptionCandidate({
      provider: "claude",
      providerThreadId: "claude-personal-thread",
      title: "Claude terminal session",
      state: "terminal",
      providerUpdatedAt: 10,
      liveness: "live",
    });
    const processIdentity = {
      pid: 42_001,
      pidDomain: "darwin" as const,
      procStart: "Fri Sep  4 12:00:00 2026",
    };
    store.fenceSessionAdoptionCandidateForClaim({
      provider: "claude",
      providerThreadId: live.providerThreadId,
      expectedRevision: live.revision,
    });
    store.recordClaimedClaudeProcessAuthority({
      providerAuthority: store.requireProviderAccountAuthority(profile.id, "claude"),
      providerThreadId: live.providerThreadId,
      profileId: profile.id,
      profileGeneration: profile.processGeneration,
      runtimeScope: "personal",
      identity: processIdentity,
    });
    const claimedLive = store.listSessionAdoptionCandidates({ provider: "claude" })[0];
    if (claimedLive === undefined) throw new Error("Expected the claimed Claude candidate.");
    expect(() => store.adoptSessionCandidate({
      providerAuthority: store.requireProviderAccountAuthority(profile.id, "claude"),
      provider: "claude",
      providerThreadId: live.providerThreadId,
      expectedCandidateRevision: claimedLive.revision,
      profileId: profile.id,
      profileGeneration: profile.processGeneration,
      preset: "fable-max",
      requirement: presetRequirements["fable-max"],
      fastEnabled: false,
      runtimeProfile: claudeAdoptionRuntimeProfile(store.requireProviderAccountAuthority(profile.id, "claude")),
      providerAccountKey: testProviderAccountKey("claude"),
      claudeProcessIdentity: processIdentity,
    })).toThrow("SESSION_ADOPTION_SOURCE_STILL_LIVE");

    const stopped = store.upsertSessionAdoptionCandidate({
      provider: "claude",
      providerThreadId: "claude-personal-thread",
      title: "Claude terminal session",
      state: "terminal",
      providerUpdatedAt: 10,
      liveness: "not_live",
    });
    const adopted = store.adoptSessionCandidate({
      providerAuthority: store.requireProviderAccountAuthority(profile.id, "claude"),
      provider: "claude",
      providerThreadId: stopped.providerThreadId,
      expectedCandidateRevision: stopped.revision,
      profileId: profile.id,
      profileGeneration: profile.processGeneration,
      preset: "fable-max",
      requirement: presetRequirements["fable-max"],
      fastEnabled: false,
      runtimeProfile: claudeAdoptionRuntimeProfile(store.requireProviderAccountAuthority(profile.id, "claude")),
      providerAccountKey: testProviderAccountKey("claude"),
      claudeProcessIdentity: processIdentity,
    });
    expect(adopted.session.state).toBe("terminal");
    expect(() => store.removeProfile(profile.id))
      .toThrow("SESSION_ADOPTION_PROFILE_ACTIVE_BINDINGS");

    expect(store.setSessionAdoptionPolicy({
      provider: "claude",
      profileId: null,
    })).toMatchObject({ enabled: false, profileId: null });
    expect(store.readSessionPersonalRuntimeBinding(adopted.session.id)).toMatchObject({
      state: "active",
    });
    expect(store.readClaudeProcessAuthority({
      providerThreadId: live.providerThreadId,
      profileId: profile.id,
      runtimeScope: "personal",
    })).toMatchObject({ state: "bound", sessionId: adopted.session.id });

    const claimedProcess = store.readClaudeProcessAuthority({
      providerThreadId: live.providerThreadId,
      profileId: profile.id,
      runtimeScope: "personal",
    });
    if (claimedProcess === null) throw new Error("Expected Claude process custody.");
    const releasingProcess = store.beginClaudeProcessAuthorityRelease({
      providerThreadId: claimedProcess.providerThreadId,
      profileId: claimedProcess.profileId,
      runtimeScope: claimedProcess.runtimeScope,
      expectedRevision: claimedProcess.revision,
      identity: claimedProcess.identity,
    });
    store.completeClaudeProcessAuthorityRelease({
      providerThreadId: releasingProcess.providerThreadId,
      profileId: releasingProcess.profileId,
      runtimeScope: releasingProcess.runtimeScope,
      expectedRevision: releasingProcess.revision,
      identity: releasingProcess.identity,
    });
    store.detachPersonalSession({ sessionId: adopted.session.id });
    store.removeProfile(profile.id);
    expect(store.requireProfileById(profile.id, { includeRemoved: true }).state).toBe("removed");
    expect(store.readSessionAdoptionPolicy("claude")).toMatchObject({
      enabled: false,
      profileId: null,
    });
  });
test("adopts and queues personal Claude while the sibling Codex profile is signed out", async () => {
    const { store } = await fixture();
    const profile = store.createProfile("Signed-out Codex Claude adopter");
    expect(profile).toMatchObject({ processGeneration: 0, state: "signed_out" });
    const unproven = store.createSession({
      profileId: profile.id,
      provider: "claude",
      preset: "fable-max",
      fastEnabled: false,
    });
    expect(() => store.bindSessionProviderAccountAuthority({
      sessionId: unproven.id,
      provider: "claude",
      runtimeScope: "managed",
      accountKey: testProviderAccountKey("codex"),
    })).toThrow("SESSION_PROVIDER_ACCOUNT_AUTHORITY_KEY_MISMATCH");
    expect(store.setSessionAdoptionPolicy({
      provider: "claude",
      profileId: profile.id,
    })).toMatchObject({ enabled: true, profileId: profile.id, provider: "claude" });
    const candidate = store.upsertSessionAdoptionCandidate({
      provider: "claude",
      providerThreadId: "signed-out-codex-claude-personal-thread",
      title: "Claude remains authoritative",
      state: "idle",
      providerUpdatedAt: 10,
      liveness: "not_live",
    });
    store.fenceSessionAdoptionCandidateForClaim({
      provider: "claude",
      providerThreadId: "signed-out-codex-claude-personal-thread",
      expectedRevision: candidate.revision,
    });
    const processIdentity = {
      pid: 42_099,
      pidDomain: "darwin" as const,
      procStart: "Fri Sep  4 12:09:00 2026",
    };
    store.recordClaimedClaudeProcessAuthority({
      providerAuthority: store.requireProviderAccountAuthority(profile.id, "claude"),
      providerThreadId: candidate.providerThreadId,
      profileId: profile.id,
      profileGeneration: profile.processGeneration,
      runtimeScope: "personal",
      identity: processIdentity,
    });
    const claimed = store.listSessionAdoptionCandidates({ provider: "claude" })
      .find((entry) => entry.providerThreadId === candidate.providerThreadId);
    if (claimed === undefined) throw new Error("Expected the claimed Claude candidate.");
    const adopted = store.adoptSessionCandidate({
      providerAuthority: store.requireProviderAccountAuthority(profile.id, "claude"),
      provider: "claude",
      providerThreadId: candidate.providerThreadId,
      expectedCandidateRevision: claimed.revision,
      profileId: profile.id,
      profileGeneration: profile.processGeneration,
      preset: "fable-max",
      requirement: presetRequirements["fable-max"],
      fastEnabled: false,
      runtimeProfile: claudeAdoptionRuntimeProfile(store.requireProviderAccountAuthority(profile.id, "claude")),
      providerAccountKey: testProviderAccountKey("claude"),
      claudeProcessIdentity: processIdentity,
    });
    expect(store.sessionAccountAuthorityMatches(adopted.session.id, profile.id)).toBe(true);
    expect(store.listLocalSessionPage({
      profileId: profile.id,
      after: null,
      limit: 10,
      requireCurrentAccountAuthority: true,
    }).sessions.map((session) => session.id)).toEqual([adopted.session.id]);
    expect(store.enqueue(adopted.session.id, "Continue from the schedule")).toMatchObject({
      sessionId: adopted.session.id,
      state: "pending",
    });
  });
test("restarts a generation-zero adopted Claude session after exact process release", async () => {
    const { store } = await fixture();
    const profile = store.createProfile("Generation-zero Claude restart");
    store.setSessionAdoptionPolicy({ provider: "claude", profileId: profile.id });
    const session = adoptPersonalClaudeTestSession(store, profile);
    const authority = store.readClaudeProcessAuthority({
      providerThreadId: session.providerThreadId as string,
      profileId: profile.id,
      runtimeScope: "personal",
    });
    if (authority === null) throw new Error("Expected Claude process authority.");
    const releasing = store.beginClaudeProcessAuthorityRelease({
      providerThreadId: authority.providerThreadId,
      profileId: authority.profileId,
      runtimeScope: authority.runtimeScope,
      expectedRevision: authority.revision,
      identity: authority.identity,
    });
    store.completeClaudeProcessAuthorityRelease({
      providerThreadId: releasing.providerThreadId,
      profileId: releasing.profileId,
      runtimeScope: releasing.runtimeScope,
      expectedRevision: releasing.revision,
      identity: releasing.identity,
    });

    expect(store.nextDaemonGeneration(`boot_${"0".repeat(32)}`)).toBe(1);
    expect(store.requireProfileById(profile.id)).toMatchObject({
      processGeneration: 1,
      state: "signed_out",
    });
    expect(store.requireSession(session.id)).toMatchObject({ state: "idle" });
    expect(store.readSessionPersonalRuntimeBinding(session.id)).toMatchObject({
      state: "active",
    });
  });
test("carries generation-zero personal and scoped revocations through restart", async () => {
    const { store } = await fixture();
    const globalProfile = store.createProfile("Generation-zero global revocation");
    store.setSessionAdoptionPolicy({ provider: "claude", profileId: globalProfile.id });
    const globalSession = adoptPersonalClaudeTestSession(store, globalProfile);
    const global = store.beginProfilePersonalAuthorityRevocation({
      profileId: globalProfile.id,
      expectedGeneration: globalProfile.processGeneration,
      workStore: createRevocationWorkStore(store),
    });
    const releasePersonalClaudeAuthority = (
      targetStore: StateStore,
      profile: Readonly<{ id: string }>,
      session: Readonly<{ providerThreadId?: string | null }>,
    ): void => {
      const authority = targetStore.readClaudeProcessAuthority({
        providerThreadId: session.providerThreadId as string,
        profileId: profile.id,
        runtimeScope: "personal",
      });
      if (authority === null) throw new Error("Expected Claude process authority.");
      const releasing = targetStore.beginClaudeProcessAuthorityRelease({
        providerThreadId: authority.providerThreadId,
        profileId: authority.profileId,
        runtimeScope: authority.runtimeScope,
        expectedRevision: authority.revision,
        identity: authority.identity,
      });
      targetStore.completeClaudeProcessAuthorityRelease({
        providerThreadId: releasing.providerThreadId,
        profileId: releasing.profileId,
        runtimeScope: releasing.runtimeScope,
        expectedRevision: releasing.revision,
        identity: releasing.identity,
      });
    };
    releasePersonalClaudeAuthority(store, globalProfile, globalSession);

    expect(store.nextDaemonGeneration(`boot_${"1".repeat(32)}`)).toBe(1);
    const rolledGlobal = store.requireProfileById(globalProfile.id);
    expect(store.readProfilePersonalAuthorityRevocation(globalProfile.id)).toMatchObject({
      profileGeneration: rolledGlobal.processGeneration,
      revision: global.revocation.revision + 1,
      state: "releasing",
    });
    expect(rolledGlobal.processGeneration).toBe(1);
    // This is Codex-only revocation. The separate Claude binding was never
    // detached, and a proved process release is not permission to detach it.
    expect(global.bindings).toEqual([]);
    expect(global.sessionIds).toEqual([]);
    const retainedClaude = store.requireCapturedSessionProviderAuthority(globalSession.id);
    expect(store.readSessionPersonalRuntimeBinding(globalSession.id)?.state).toBe("active");
    expect(store.completeProfilePersonalAuthorityRevocation({
      profileId: globalProfile.id,
      expectedGeneration: rolledGlobal.processGeneration,
    })).toMatchObject({ processGeneration: 2, state: "signed_out" });
    expect(store.requireCapturedSessionProviderAuthority(globalSession.id)).toEqual(retainedClaude);
    expect(store.readSessionPersonalRuntimeBinding(globalSession.id)?.state).toBe("active");

    const { store: scopedStore } = await fixture();
    const scopedProfile = scopedStore.createProfile("Generation-zero scoped revocation");
    scopedStore.setSessionAdoptionPolicy({ provider: "claude", profileId: scopedProfile.id });
    const scopedSession = adoptPersonalClaudeTestSession(scopedStore, scopedProfile);
    const scoped = scopedStore.beginProviderRuntimeAccountRevocation({
      profileId: scopedProfile.id,
      expectedGeneration: scopedProfile.processGeneration,
      provider: "claude",
      runtimeScope: "personal",
      currentAccountKey: null,
      workStore: createRevocationWorkStore(scopedStore),
    });
    releasePersonalClaudeAuthority(scopedStore, scopedProfile, scopedSession);

    expect(scopedStore.nextDaemonGeneration(`boot_${"2".repeat(32)}`)).toBe(1);
    const rolledScoped = scopedStore.requireProfileById(scopedProfile.id);
    expect(scopedStore.readProviderRuntimeAccountRevocation({
      profileId: scopedProfile.id,
      provider: "claude",
      runtimeScope: "personal",
    })).toMatchObject({
      profileGeneration: rolledScoped.processGeneration,
      revision: scoped.revocation.revision + 1,
      state: "releasing",
    });
    expect(rolledScoped.processGeneration).toBe(1);

    scopedStore.completePersonalSessionDetach({ sessionId: scopedSession.id, archive: false });
    const rolledScopedRevocation = scopedStore.readProviderRuntimeAccountRevocation({
      profileId: scopedProfile.id,
      provider: "claude",
      runtimeScope: "personal",
    });
    if (rolledScopedRevocation === null) throw new Error("Expected scoped revocation.");
    expect(scopedStore.completeProviderRuntimeAccountRevocation({
      profileId: scopedProfile.id,
      expectedGeneration: rolledScoped.processGeneration,
      provider: "claude",
      runtimeScope: "personal",
      expectedRevision: rolledScopedRevocation.revision,
    })).toMatchObject({ state: "completed" });
  });
test("advances generation-zero revocations even before a session exists", async () => {
    const { store } = await fixture();
    const globalProfile = store.createProfile("Generation-zero empty global revocation");
    const scopedProfile = store.createProfile("Generation-zero empty scoped revocation");
    const global = store.beginProfilePersonalAuthorityRevocation({
      profileId: globalProfile.id,
      expectedGeneration: globalProfile.processGeneration,
      workStore: createRevocationWorkStore(store),
    });
    const scoped = store.beginProviderRuntimeAccountRevocation({
      profileId: scopedProfile.id,
      expectedGeneration: scopedProfile.processGeneration,
      provider: "claude",
      runtimeScope: "personal",
      currentAccountKey: null,
      workStore: createRevocationWorkStore(store),
    });
    expect(global.sessionIds).toEqual([]);
    expect(scoped.sessionIds).toEqual([]);

    expect(store.nextDaemonGeneration(`boot_${"3".repeat(32)}`)).toBe(1);
    const rolledGlobal = store.requireProfileById(globalProfile.id);
    const rolledScoped = store.requireProfileById(scopedProfile.id);
    expect(rolledGlobal.processGeneration).toBe(1);
    expect(rolledScoped.processGeneration).toBe(1);
    expect(store.readProfilePersonalAuthorityRevocation(globalProfile.id)).toMatchObject({
      profileGeneration: 1,
      revision: global.revocation.revision + 1,
      state: "releasing",
    });
    expect(store.readProviderRuntimeAccountRevocation({
      profileId: scopedProfile.id,
      provider: "claude",
      runtimeScope: "personal",
    })).toMatchObject({
      profileGeneration: 1,
      revision: scoped.revocation.revision + 1,
      state: "releasing",
    });

    expect(store.completeProfilePersonalAuthorityRevocation({
      profileId: globalProfile.id,
      expectedGeneration: rolledGlobal.processGeneration,
    })).toMatchObject({ processGeneration: 2, state: "signed_out" });
    const rolledScopedRevocation = store.readProviderRuntimeAccountRevocation({
      profileId: scopedProfile.id,
      provider: "claude",
      runtimeScope: "personal",
    });
    if (rolledScopedRevocation === null) throw new Error("Expected scoped revocation.");
    expect(store.completeProviderRuntimeAccountRevocation({
      profileId: scopedProfile.id,
      expectedGeneration: rolledScoped.processGeneration,
      provider: "claude",
      runtimeScope: "personal",
      expectedRevision: rolledScopedRevocation.revision,
    })).toMatchObject({ profileGeneration: 1, state: "completed" });
  });
test("scopes Claude process authority by provider home and releases only the exact row", async () => {
    const { store } = await fixture();
    const first = signInProfile(store, "First Claude home", "first-claude-home@example.com");
    const second = signInProfile(store, "Second Claude home", "second-claude-home@example.com");
    const sharedThreadId = "same-opaque-claude-thread";
    const records = [
      store.recordClaimedClaudeProcessAuthority({
        providerAuthority: store.requireProviderAccountAuthority(first.id, "claude"),
        providerThreadId: sharedThreadId,
        profileId: first.id,
        profileGeneration: first.processGeneration,
        runtimeScope: "managed",
        identity: { pid: 51_001, pidDomain: "darwin", procStart: "managed-first" },
      }),
      store.recordClaimedClaudeProcessAuthority({
        providerAuthority: store.requireProviderAccountAuthority(first.id, "claude"),
        providerThreadId: sharedThreadId,
        profileId: first.id,
        profileGeneration: first.processGeneration,
        runtimeScope: "personal",
        identity: { pid: 51_002, pidDomain: "darwin", procStart: "personal-first" },
      }),
      store.recordClaimedClaudeProcessAuthority({
        providerAuthority: store.requireProviderAccountAuthority(second.id, "claude"),
        providerThreadId: sharedThreadId,
        profileId: second.id,
        profileGeneration: second.processGeneration,
        runtimeScope: "personal",
        identity: { pid: 51_003, pidDomain: "darwin", procStart: "personal-second" },
      }),
    ];
    expect(records.map((record) => [record.runtimeScope, record.profileId])).toEqual([
      ["managed", first.id],
      ["personal", first.id],
      ["personal", second.id],
    ]);

    const selected = records[2];
    if (selected === undefined) throw new Error("Expected a selected authority row.");
    const releasing = store.beginClaudeProcessAuthorityRelease({
      providerThreadId: selected.providerThreadId,
      profileId: selected.profileId,
      runtimeScope: selected.runtimeScope,
      expectedRevision: selected.revision,
      identity: selected.identity,
    });
    store.completeClaudeProcessAuthorityRelease({
      providerThreadId: releasing.providerThreadId,
      profileId: releasing.profileId,
      runtimeScope: releasing.runtimeScope,
      expectedRevision: releasing.revision,
      identity: releasing.identity,
    });
    expect(store.readClaudeProcessAuthority({
      providerThreadId: sharedThreadId,
      profileId: second.id,
      runtimeScope: "personal",
    })?.state).toBe("released");
    expect(store.readClaudeProcessAuthority({
      providerThreadId: sharedThreadId,
      profileId: first.id,
      runtimeScope: "managed",
    })?.state).toBe("claimed");
    expect(store.readClaudeProcessAuthority({
      providerThreadId: sharedThreadId,
      profileId: first.id,
      runtimeScope: "personal",
    })?.state).toBe("claimed");
  });
test("stages one-shot Claude launch intent authority and fences restaging ABA", async () => {
    const { store } = await fixture();
    const profile = signInProfile(
      store,
      "Claude launch intent",
      "claude-launch-intent@example.com",
    );
    const firstSession = upsertProvenTestSession(store, {
      profileId: profile.id,
      provider: "claude",
      providerThreadId: "launch-intent-thread",
      preset: "fable-max",
      fastEnabled: false,
      state: "idle",
    });
    const secondSession = upsertProvenTestSession(store, {
      profileId: profile.id,
      provider: "claude",
      providerThreadId: "second-launch-for-same-session",
      preset: "fable-max",
      fastEnabled: false,
      state: "idle",
    });
    const staged = store.stageClaudeProcessLaunchIntent({
      providerAuthority: store.requireProviderAccountAuthority(profile.id, "claude"),
      providerThreadId: "launch-intent-thread",
      profileId: profile.id,
      profileGeneration: profile.processGeneration,
      runtimeScope: "managed",
      providerAccountKey: testProviderAccountKey("claude"),
      sessionId: firstSession.id,
    });
    expect(staged).toMatchObject({
      profileId: profile.id,
      profileGeneration: profile.processGeneration,
      providerThreadId: "launch-intent-thread",
      revision: 1,
      runtimeScope: "managed",
      sessionId: firstSession.id,
    });
    expect(staged.intentId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
    );
    expect(() => store.stageClaudeProcessLaunchIntent({
      providerAuthority: store.requireProviderAccountAuthority(staged.profileId, "claude"),
      providerThreadId: staged.providerThreadId,
      profileId: staged.profileId,
      profileGeneration: staged.profileGeneration,
      runtimeScope: staged.runtimeScope,
      providerAccountKey: testProviderAccountKey("claude"),
      sessionId: firstSession.id,
    })).toThrow("SESSION_CLAUDE_PROCESS_LAUNCH_INTENT_CONFLICT");
    expect(store.readClaudeProcessLaunchIntent({
      providerThreadId: staged.providerThreadId,
      profileId: staged.profileId,
      runtimeScope: staged.runtimeScope,
    })).toEqual(staged);
    expect(store.listClaudeProcessLaunchIntents()).toEqual([staged]);
    expect(store.profileHasClaudeProcessLaunchIntents(
      profile.id,
      profile.processGeneration,
    )).toBe(true);

    expect(() => store.stageClaudeProcessLaunchIntent({
      providerAuthority: store.requireProviderAccountAuthority(staged.profileId, "claude"),
      providerThreadId: staged.providerThreadId,
      profileId: staged.profileId,
      profileGeneration: staged.profileGeneration,
      runtimeScope: staged.runtimeScope,
      providerAccountKey: testProviderAccountKey("claude"),
      sessionId: secondSession.id,
    })).toThrow("SESSION_CLAUDE_PROCESS_LAUNCH_INTENT_SESSION_AUTHORITY_MISMATCH");
    expect(() => store.stageClaudeProcessLaunchIntent({
      providerAuthority: store.requireProviderAccountAuthority(staged.profileId, "claude"),
      providerThreadId: "second-launch-for-same-session",
      profileId: staged.profileId,
      profileGeneration: staged.profileGeneration,
      runtimeScope: staged.runtimeScope,
      providerAccountKey: testProviderAccountKey("claude"),
      sessionId: firstSession.id,
    })).toThrow("SESSION_CLAUDE_PROCESS_LAUNCH_INTENT_SESSION_AUTHORITY_MISMATCH");
    expect(() => store.stageClaudeProcessLaunchIntent({
      providerAuthority: store.requireProviderAccountAuthority(profile.id, "claude"),
      providerThreadId: "stale-launch-intent",
      profileId: profile.id,
      profileGeneration: profile.processGeneration + 1,
      runtimeScope: "managed",
      providerAccountKey: testProviderAccountKey("claude"),
    })).toThrow("SESSION_CLAUDE_PROCESS_LAUNCH_INTENT_PROFILE_STALE");
    const signedOut = store.createProfile("Signed-out Claude launch");
    expect(() => store.stageClaudeProcessLaunchIntent({
      providerAuthority: store.requireProviderAccountAuthority(signedOut.id, "claude"),
      providerThreadId: "signed-out-launch-intent",
      profileId: signedOut.id,
      profileGeneration: signedOut.processGeneration,
      runtimeScope: "managed",
      providerAccountKey: testProviderAccountKey("claude"),
    })).toThrow("SESSION_CLAUDE_PROCESS_LAUNCH_INTENT_ADOPTION_AUTHORITY_MISMATCH");
    expect(() => store.stageClaudeProcessLaunchIntent({
      providerAuthority: store.requireProviderAccountAuthority(profile.id, "claude"),
      providerThreadId: "missing-personal-adoption-candidate",
      profileId: profile.id,
      profileGeneration: profile.processGeneration,
      runtimeScope: "personal",
      providerAccountKey: testProviderAccountKey("claude"),
    })).toThrow("SESSION_CLAUDE_PROCESS_LAUNCH_INTENT_ADOPTION_AUTHORITY_MISMATCH");
    store.setSessionAdoptionPolicy({ provider: "claude", profileId: profile.id });
    const adoptionCandidate = store.upsertSessionAdoptionCandidate({
      provider: "claude",
      providerThreadId: "personal-adoption-launch-intent",
      title: "Personal adoption launch intent",
      state: "idle",
      providerUpdatedAt: 10,
      liveness: "not_live",
    });
    store.fenceSessionAdoptionCandidateForClaim({
      provider: "claude",
      providerThreadId: adoptionCandidate.providerThreadId,
      expectedRevision: adoptionCandidate.revision,
    });
    const adoptionIntent = store.stageClaudeProcessLaunchIntent({
      providerAuthority: store.requireProviderAccountAuthority(profile.id, "claude"),
      providerThreadId: adoptionCandidate.providerThreadId,
      profileId: profile.id,
      profileGeneration: profile.processGeneration,
      runtimeScope: "personal",
      providerAccountKey: testProviderAccountKey("claude"),
    });
    expect(adoptionIntent.sessionId).toBeNull();
    store.cancelClaudeProcessLaunchIntent({
      providerThreadId: adoptionIntent.providerThreadId,
      profileId: adoptionIntent.profileId,
      profileGeneration: adoptionIntent.profileGeneration,
      runtimeScope: adoptionIntent.runtimeScope,
      intentId: adoptionIntent.intentId,
      expectedRevision: adoptionIntent.revision,
    });

    expect(() => store.cancelClaudeProcessLaunchIntent({
      providerThreadId: staged.providerThreadId,
      profileId: staged.profileId,
      profileGeneration: staged.profileGeneration,
      runtimeScope: staged.runtimeScope,
      intentId: "00000000-0000-4000-8000-000000000001",
      expectedRevision: staged.revision,
    })).toThrow("SESSION_CLAUDE_PROCESS_LAUNCH_INTENT_CONFLICT");
    expect(store.cancelClaudeProcessLaunchIntent({
      providerThreadId: staged.providerThreadId,
      profileId: staged.profileId,
      profileGeneration: staged.profileGeneration,
      runtimeScope: staged.runtimeScope,
      intentId: staged.intentId,
      expectedRevision: staged.revision,
    })).toEqual(staged);
    const restaged = store.stageClaudeProcessLaunchIntent({
      providerAuthority: store.requireProviderAccountAuthority(staged.profileId, "claude"),
      providerThreadId: staged.providerThreadId,
      profileId: staged.profileId,
      profileGeneration: staged.profileGeneration,
      runtimeScope: staged.runtimeScope,
      providerAccountKey: testProviderAccountKey("claude"),
      sessionId: firstSession.id,
    });
    expect(restaged.intentId).not.toBe(staged.intentId);
    expect(() => store.cancelClaudeProcessLaunchIntent({
      providerThreadId: staged.providerThreadId,
      profileId: staged.profileId,
      profileGeneration: staged.profileGeneration,
      runtimeScope: staged.runtimeScope,
      intentId: staged.intentId,
      expectedRevision: staged.revision,
    })).toThrow("SESSION_CLAUDE_PROCESS_LAUNCH_INTENT_CONFLICT");
    expect(store.readClaudeProcessLaunchIntent({
      providerThreadId: restaged.providerThreadId,
      profileId: restaged.profileId,
      runtimeScope: restaged.runtimeScope,
    })).toEqual(restaged);

    const liveSession = upsertProvenTestSession(store, {
      profileId: profile.id,
      provider: "claude",
      providerThreadId: "already-live-launch-intent",
      preset: "fable-max",
      fastEnabled: false,
      state: "idle",
    });
    const process = store.recordClaimedClaudeProcessAuthority({
      providerAuthority: store.requireProviderAccountAuthority(profile.id, "claude"),
      providerThreadId: "already-live-launch-intent",
      profileId: profile.id,
      profileGeneration: profile.processGeneration,
      runtimeScope: "managed",
      sessionId: liveSession.id,
      identity: {
        pid: 51_050,
        pidDomain: "darwin",
        procStart: "already-live-before-launch-intent",
      },
    });
    expect(() => store.stageClaudeProcessLaunchIntent({
      providerAuthority: store.requireProviderAccountAuthority(process.profileId, "claude"),
      providerThreadId: process.providerThreadId,
      profileId: process.profileId,
      profileGeneration: process.profileGeneration,
      runtimeScope: process.runtimeScope,
      providerAccountKey: testProviderAccountKey("claude"),
      sessionId: liveSession.id,
    })).toThrow("SESSION_CLAUDE_PROCESS_LAUNCH_INTENT_PROCESS_LIVE");
  });
test("atomically hands exact Claude launch intent authority to exact process custody", async () => {
    const { store } = await fixture();
    const profile = signInProfile(
      store,
      "Claude launch handoff",
      "claude-launch-handoff@example.com",
    );
    const session = upsertProvenTestSession(store, {
      profileId: profile.id,
      provider: "claude",
      providerThreadId: "launch-handoff-thread",
      preset: "fable-max",
      fastEnabled: false,
      state: "idle",
    });
    const otherSession = store.createSession({
      profileId: profile.id,
      provider: "claude",
      preset: "fable-max",
      fastEnabled: false,
    });
    const intent = store.stageClaudeProcessLaunchIntent({
      providerAuthority: store.requireProviderAccountAuthority(profile.id, "claude"),
      providerThreadId: "launch-handoff-thread",
      profileId: profile.id,
      profileGeneration: profile.processGeneration,
      runtimeScope: "managed",
      providerAccountKey: testProviderAccountKey("claude"),
      sessionId: session.id,
    });
    const collidingIdentity = {
      pid: 51_051,
      pidDomain: "darwin" as const,
      procStart: "launch-handoff-collision",
    };
    store.recordClaimedClaudeProcessAuthority({
      providerAuthority: store.requireProviderAccountAuthority(profile.id, "claude"),
      providerThreadId: "launch-handoff-existing-process",
      profileId: profile.id,
      profileGeneration: profile.processGeneration,
      runtimeScope: "managed",
      identity: collidingIdentity,
    });
    const claim = (overrides: Partial<Parameters<
      StateStore["recordClaimedClaudeProcessAuthority"]
    >[0]> = {}) => store.recordClaimedClaudeProcessAuthority({
      providerAuthority: store.requireProviderAccountAuthority(intent.profileId, "claude"),
      providerThreadId: intent.providerThreadId,
      profileId: intent.profileId,
      profileGeneration: intent.profileGeneration,
      runtimeScope: intent.runtimeScope,
      ...(intent.sessionId === null ? {} : { sessionId: intent.sessionId }),
      identity: {
        pid: 51_052,
        pidDomain: "darwin",
        procStart: "launch-handoff-exact-process",
      },
      expectedLaunchIntentId: intent.intentId,
      expectedLaunchIntentRevision: intent.revision,
      ...overrides,
    });

    expect(() => claim({
      expectedLaunchIntentId: "00000000-0000-4000-8000-000000000002",
    })).toThrow("SESSION_CLAUDE_PROCESS_LAUNCH_INTENT_CONFLICT");
    expect(() => claim({ sessionId: otherSession.id }))
      .toThrow("SESSION_CLAUDE_PROCESS_LAUNCH_INTENT_CONFLICT");
    expect(() => claim({ identity: collidingIdentity })).toThrow();
    expect(store.readClaudeProcessAuthority({
      providerThreadId: intent.providerThreadId,
      profileId: intent.profileId,
      runtimeScope: intent.runtimeScope,
    })).toBeNull();
    expect(store.readClaudeProcessLaunchIntent({
      providerThreadId: intent.providerThreadId,
      profileId: intent.profileId,
      runtimeScope: intent.runtimeScope,
    })).toEqual(intent);

    const claimed = claim();
    expect(claimed).toMatchObject({
      providerThreadId: intent.providerThreadId,
      profileId: intent.profileId,
      profileGeneration: intent.profileGeneration,
      runtimeScope: intent.runtimeScope,
      sessionId: session.id,
      state: "claimed",
      identity: {
        pid: 51_052,
        pidDomain: "darwin",
        procStart: "launch-handoff-exact-process",
      },
    });
    expect(store.readClaudeProcessLaunchIntent({
      providerThreadId: intent.providerThreadId,
      profileId: intent.profileId,
      runtimeScope: intent.runtimeScope,
    })).toBeNull();
    expect(() => claim()).toThrow("SESSION_CLAUDE_PROCESS_LAUNCH_INTENT_CONFLICT");
    expect(store.readClaudeProcessAuthority({
      providerThreadId: intent.providerThreadId,
      profileId: intent.profileId,
      runtimeScope: intent.runtimeScope,
    })).toEqual(claimed);
  });
test("fences Claude launch intents across completed scoped account revocations", async () => {
    const { store } = await fixture();
    const profile = signInProfile(
      store,
      "Claude launch account fence",
      "claude-launch-account-fence@example.com",
    );
    const accountKey = testProviderAccountKey("claude");
    const replacementKey = namedProviderAccountKey("claude", "replacement-launch-account");
    const selector = {
      profileId: profile.id,
      provider: "claude" as const,
      runtimeScope: "managed" as const,
    };

    const unavailable = store.beginProviderRuntimeAccountRevocation({
      ...selector,
      expectedGeneration: profile.processGeneration,
      currentAccountKey: null,
      workStore: createRevocationWorkStore(store),
    });
    store.completeProviderRuntimeAccountRevocation({
      ...selector,
      expectedGeneration: profile.processGeneration,
      expectedRevision: unavailable.revocation.revision,
    });
    expect(() => store.stageClaudeProcessLaunchIntent({
      providerAuthority: store.requireProviderAccountAuthority(profile.id, "claude"),
      providerThreadId: "completed-null-launch",
      profileId: profile.id,
      profileGeneration: profile.processGeneration,
      runtimeScope: "managed",
      providerAccountKey: accountKey,
    })).toThrow("SESSION_CLAUDE_PROCESS_LAUNCH_INTENT_ACCOUNT_STALE");
    expect(() => store.clearCompletedProviderRuntimeAccountRevocation({
      ...selector,
      expectedGeneration: profile.processGeneration,
      currentAccountKey: accountKey,
    })).toThrow("PROVIDER_ACCOUNT_AUTHORITY_REVOCATION_NOT_RECONCILED");

    const reconciled = store.beginProviderRuntimeAccountRevocation({
      ...selector,
      expectedGeneration: profile.processGeneration,
      currentAccountKey: accountKey,
      workStore: createRevocationWorkStore(store),
    });
    store.completeProviderRuntimeAccountRevocation({
      ...selector,
      expectedGeneration: profile.processGeneration,
      expectedRevision: reconciled.revocation.revision,
    });
    store.clearCompletedProviderRuntimeAccountRevocation({
      ...selector,
      expectedGeneration: profile.processGeneration,
      currentAccountKey: accountKey,
    });
    expect(store.readProviderRuntimeAccountRevocation(selector)).toBeNull();

    const exactSession = upsertProvenTestSession(store, {
      profileId: profile.id,
      provider: "claude",
      providerThreadId: "completed-mismatch-launch",
      preset: "fable-max",
      fastEnabled: false,
      state: "idle",
      providerAccountKey: accountKey,
    });
    const intent = store.stageClaudeProcessLaunchIntent({
      providerAuthority: store.requireProviderAccountAuthority(profile.id, "claude"),
      providerThreadId: "completed-mismatch-launch",
      profileId: profile.id,
      profileGeneration: profile.processGeneration,
      runtimeScope: "managed",
      providerAccountKey: accountKey,
      sessionId: exactSession.id,
    });
    const mismatched = store.beginProviderRuntimeAccountRevocation({
      ...selector,
      expectedGeneration: profile.processGeneration,
      currentAccountKey: replacementKey,
      workStore: createRevocationWorkStore(store),
    });
    // Simulate a pre-fix crash state that incorrectly marked the fence complete
    // while the launch intent survived. Both stage and claim must still fail.
    const raw = new Database(store.paths.database, { create: false, strict: true });
    try {
      raw.query(
        `UPDATE provider_runtime_account_revocations
         SET state='completed',revision=revision+1,
           updated_at=updated_at+1,completed_at=updated_at+1
         WHERE profile_id=? AND provider='claude' AND runtime_scope='managed'
           AND revision=? AND state='releasing'`,
      ).run(profile.id, mismatched.revocation.revision);
    } finally {
      raw.close(false);
    }
    expect(() => store.stageClaudeProcessLaunchIntent({
      providerAuthority: store.requireProviderAccountAuthority(profile.id, "claude"),
      providerThreadId: "second-completed-mismatch-launch",
      profileId: profile.id,
      profileGeneration: profile.processGeneration,
      runtimeScope: "managed",
      providerAccountKey: accountKey,
    })).toThrow("SESSION_CLAUDE_PROCESS_LAUNCH_INTENT_ACCOUNT_STALE");
    expect(() => store.recordClaimedClaudeProcessAuthority({
      providerAuthority: store.requireProviderAccountAuthority(intent.profileId, "claude"),
      providerThreadId: intent.providerThreadId,
      profileId: intent.profileId,
      profileGeneration: intent.profileGeneration,
      runtimeScope: intent.runtimeScope,
      sessionId: exactSession.id,
      identity: {
        pid: 51_053,
        pidDomain: "darwin",
        procStart: "completed-mismatch-launch-process",
      },
      expectedLaunchIntentId: intent.intentId,
      expectedLaunchIntentRevision: intent.revision,
    })).toThrow("SESSION_CLAUDE_PROCESS_LAUNCH_INTENT_ACCOUNT_STALE");
    expect(store.readClaudeProcessAuthority({
      providerThreadId: intent.providerThreadId,
      profileId: intent.profileId,
      runtimeScope: intent.runtimeScope,
    })).toBeNull();
    expect(store.readClaudeProcessLaunchIntent({
      providerThreadId: intent.providerThreadId,
      profileId: intent.profileId,
      runtimeScope: intent.runtimeScope,
    })).toEqual(intent);
  });
test("launch intents isolate Claude authority from Codex state and identity changes", async () => {
    const { store } = await fixture();
    const profile = signInProfile(
      store,
      "Claude launch guards",
      "claude-launch-guards@example.com",
    );
    const otherProfile = signInProfile(
      store,
      "Other Claude launch guards",
      "other-claude-launch-guards@example.com",
    );
    store.setSessionAdoptionPolicy({ provider: "claude", profileId: profile.id });
    const candidate = store.upsertSessionAdoptionCandidate({
      provider: "claude",
      providerThreadId: "launch-guard-thread",
      title: "Claude launch guard candidate",
      state: "idle",
      providerUpdatedAt: 10,
      liveness: "not_live",
    });
    store.fenceSessionAdoptionCandidateForClaim({
      provider: "claude",
      providerThreadId: candidate.providerThreadId,
      expectedRevision: candidate.revision,
    });
    const intent = store.stageClaudeProcessLaunchIntent({
      providerAuthority: store.requireProviderAccountAuthority(profile.id, "claude"),
      providerThreadId: "launch-guard-thread",
      profileId: profile.id,
      profileGeneration: profile.processGeneration,
      runtimeScope: "personal",
      providerAccountKey: testProviderAccountKey("claude"),
    });

    expect(() => store.setSessionAdoptionPolicy({
      provider: "claude",
      profileId: null,
    })).toThrow("SESSION_ADOPTION_POLICY_UNSETTLED_CLAIM");
    expect(() => store.setSessionAdoptionPolicy({
      provider: "claude",
      profileId: otherProfile.id,
    })).toThrow("SESSION_ADOPTION_POLICY_UNSETTLED_CLAIM");
    expect(store.readSessionAdoptionPolicy("claude")?.profileId).toBe(profile.id);

    expect(store.setProfileState(
      profile.id,
      profile.processGeneration,
      "signed_out",
    )).toBe(true);
    expect(() => store.removeProfile(profile.id)).toThrow();
    const rolled = store.advanceProfileGeneration(
      profile.id,
      profile.processGeneration,
    );
    expect(rolled.processGeneration).toBe(profile.processGeneration + 1);
    expect(intent.providerAuthority).toEqual(store.requireProviderAccountAuthority(profile.id, "claude"));
    expect(store.readClaudeProcessLaunchIntent({ providerThreadId: intent.providerThreadId,
      profileId: intent.profileId, runtimeScope: intent.runtimeScope })).toEqual(intent);
    expect(store.setProfileState(
      profile.id,
      rolled.processGeneration,
      "signed_in",
    )).toBe(true);
    expect(store.setProfileState(
      profile.id,
      rolled.processGeneration,
      "signed_in",
      { email: "replacement-launch-identity@example.com", plan: "Plus" },
    )).toBe(true);
    expect(store.setProfileState(
      profile.id,
      rolled.processGeneration,
      "recovery_required",
      { email: "claude-launch-guards@example.com", plan: "Plus" },
    )).toBe(true);
    const retainedPolicy = store.readSessionAdoptionPolicy("claude");
    expect(retainedPolicy).toMatchObject({ enabled: true, profileId: profile.id });

    const { revocation } = store.beginProviderRuntimeAccountRevocation({
      profileId: profile.id,
      expectedGeneration: rolled.processGeneration,
      provider: "claude", runtimeScope: "personal", currentAccountKey: null,
      workStore: createRevocationWorkStore(store),
    });
    expect(store.setProfileState(
      profile.id,
      rolled.processGeneration,
      "recovery_required",
      { email: "claude-launch-guards@example.com", plan: "Plus" },
    )).toBe(true);
    expect(() => store.completeProviderRuntimeAccountRevocation({
      profileId: profile.id,
      expectedGeneration: rolled.processGeneration,
      provider: "claude", runtimeScope: "personal", expectedRevision: revocation.revision,
    })).toThrow("PROVIDER_ACCOUNT_AUTHORITY_REVOCATION_CLAUDE_LAUNCH_INTENT_LIVE");
    expect(store.readProviderRuntimeAccountRevocation({ profileId: profile.id,
      provider: "claude", runtimeScope: "personal" })).toEqual(revocation);
    store.cancelClaudeProcessLaunchIntent({
      providerThreadId: intent.providerThreadId,
      profileId: intent.profileId,
      profileGeneration: intent.profileGeneration,
      runtimeScope: intent.runtimeScope,
      intentId: intent.intentId,
      expectedRevision: intent.revision,
    });
    expect(store.requireProfileById(profile.id)).toMatchObject({
      processGeneration: rolled.processGeneration,
      state: "recovery_required",
    });
    expect(store.readSessionAdoptionPolicy("claude")).toMatchObject({
      enabled: false,
      profileId: null,
      revision: (retainedPolicy?.revision ?? 0) + 1,
    });
    expect(store.completeProviderRuntimeAccountRevocation({
      profileId: profile.id,
      expectedGeneration: rolled.processGeneration,
      provider: "claude", runtimeScope: "personal", expectedRevision: revocation.revision,
    }).state).toBe("completed");
    expect(intent.providerAuthority).toEqual(store.requireProviderAccountAuthority(profile.id, "claude"));
  });
test("launch intents fence session rebind and personal detach", async () => {
    const { store, home } = await fixture();
    const profile = signInProfile(
      store,
      "Claude launch session fences",
      "claude-launch-session-fences@example.com",
    );
    const projectRoot = join(home, "claude-launch-session-fences");
    await mkdir(projectRoot);
    const project = await store.createProject(
      "Claude launch session fences",
      projectRoot,
      true,
    );
    store.advanceProviderAccountProcessGeneration({ profileId: profile.id, provider: "claude", expectedProcessGeneration: 0 });
    const startAuthority = store.advanceProviderAccountProcessGeneration({ profileId: profile.id, provider: "claude", expectedProcessGeneration: 1 });
    expect(startAuthority.processGeneration).not.toBe(profile.processGeneration);
    const startAttempt = store.prepareMutation({
      kind: "session.start",
      authorityId: profile.id,
      authorityGeneration: startAuthority.processGeneration,
      request: {
        projectId: project.id,
        provider: "claude",
        preset: "fable-max",
        fast: false,
      },
      idempotencyKey: "00000000-0000-4000-8000-000000000920",
    });
    const starting = store.beginSessionStartEffect({
      providerAuthority: store.requireProviderAccountAuthority(profile.id, "claude"),
      attemptId: startAttempt.id,
      profileId: profile.id,
      profileGeneration: startAuthority.processGeneration,
      projectId: project.id,
      provider: "claude",
      preset: "fable-max",
      fastEnabled: false,
      providerAccountKey: testProviderAccountKey("claude"),
      providerAuthentication: {
        profileId: profile.id,
        processGeneration: startAuthority.processGeneration,
        provider: "claude",
        signedIn: true,
      },
      evidence: {
        kind: "session.start",
        projectId: project.id,
        clientMessageId: null,
        messageDigest: null,
        runtimeProfile: managedClaudeRuntimeProfile(store.requireProviderAccountAuthority(profile.id, "claude")),
      },
    });
    const stageStartIntent = (overrides: Partial<Parameters<
      StateStore["stageClaudeProcessLaunchIntent"]
    >[0]> = {}) => store.stageClaudeProcessLaunchIntent({
      providerAuthority: store.requireProviderAccountAuthority(profile.id, "claude"),
      providerThreadId: "00000000-0000-4000-8000-000000000921",
      profileId: profile.id,
      profileGeneration: profile.processGeneration,
      runtimeScope: "managed",
      providerAccountKey: testProviderAccountKey("claude"),
      sessionId: starting.id,
      ...overrides,
    });
    expect(() => stageStartIntent({
      providerThreadId: "not-a-reserved-start-thread",
    })).toThrow("SESSION_CLAUDE_PROCESS_LAUNCH_INTENT_SESSION_AUTHORITY_MISMATCH");
    expect(() => stageStartIntent({
      providerAccountKey: namedProviderAccountKey("claude", "wrong-start-account"),
    })).toThrow("SESSION_CLAUDE_PROCESS_LAUNCH_INTENT_SESSION_AUTHORITY_MISMATCH");
    expect(() => stageStartIntent({
      runtimeScope: "personal",
    })).toThrow("SESSION_CLAUDE_PROCESS_LAUNCH_INTENT_SESSION_AUTHORITY_MISMATCH");
    const startIntent = stageStartIntent();
    expect(() => store.bindSession({
      sessionId: starting.id,
      expectedRevision: starting.revision,
      providerThreadId: startIntent.providerThreadId,
      state: "idle",
    })).toThrow("live Claude process authority must be released before session rebind");
    store.cancelClaudeProcessLaunchIntent({
      providerThreadId: startIntent.providerThreadId,
      profileId: startIntent.profileId,
      profileGeneration: startIntent.profileGeneration,
      runtimeScope: startIntent.runtimeScope,
      intentId: startIntent.intentId,
      expectedRevision: startIntent.revision,
    });

    store.setSessionAdoptionPolicy({ provider: "claude", profileId: profile.id });
    const adopted = adoptPersonalClaudeTestSession(store, profile);
    if (adopted.providerThreadId === undefined) {
      throw new Error("Expected an adopted Claude provider thread.");
    }
    const adoptedProcess = store.readClaudeProcessAuthority({
      providerThreadId: adopted.providerThreadId,
      profileId: profile.id,
      runtimeScope: "personal",
    });
    if (adoptedProcess === null) throw new Error("Expected adopted Claude process custody.");
    const releasing = store.beginClaudeProcessAuthorityRelease({
      providerThreadId: adoptedProcess.providerThreadId,
      profileId: adoptedProcess.profileId,
      runtimeScope: adoptedProcess.runtimeScope,
      expectedRevision: adoptedProcess.revision,
      identity: adoptedProcess.identity,
    });
    store.completeClaudeProcessAuthorityRelease({
      providerThreadId: releasing.providerThreadId,
      profileId: releasing.profileId,
      runtimeScope: releasing.runtimeScope,
      expectedRevision: releasing.revision,
      identity: releasing.identity,
    });
    const detachIntent = store.stageClaudeProcessLaunchIntent({
      providerAuthority: store.requireProviderAccountAuthority(profile.id, "claude"),
      providerThreadId: adopted.providerThreadId,
      profileId: profile.id,
      profileGeneration: profile.processGeneration,
      runtimeScope: "personal",
      providerAccountKey: testProviderAccountKey("claude"),
      sessionId: adopted.id,
    });
    expect(() => store.beginPersonalSessionDetach({
      sessionId: adopted.id,
    })).toThrow("Claude process launch intent must be cancelled before personal session detach");
    store.cancelClaudeProcessLaunchIntent({
      providerThreadId: detachIntent.providerThreadId,
      profileId: detachIntent.profileId,
      profileGeneration: detachIntent.profileGeneration,
      runtimeScope: detachIntent.runtimeScope,
      intentId: detachIntent.intentId,
      expectedRevision: detachIntent.revision,
    });
    expect(store.detachPersonalSession({
      sessionId: adopted.id,
      archive: false,
    }).binding.state).toBe("detached");
  });
test("reopens durable Claude launch intents without changing their authority", async () => {
    const { store } = await fixture();
    const profile = signInProfile(
      store,
      "Claude launch reopen",
      "claude-launch-reopen@example.com",
    );
    store.setSessionAdoptionPolicy({ provider: "claude", profileId: profile.id });
    const candidate = store.upsertSessionAdoptionCandidate({
      provider: "claude",
      providerThreadId: "launch-reopen-thread",
      title: "Claude launch reopen candidate",
      state: "idle",
      providerUpdatedAt: 10,
      liveness: "not_live",
    });
    store.fenceSessionAdoptionCandidateForClaim({
      provider: "claude",
      providerThreadId: candidate.providerThreadId,
      expectedRevision: candidate.revision,
    });
    const intent = store.stageClaudeProcessLaunchIntent({
      providerAuthority: store.requireProviderAccountAuthority(profile.id, "claude"),
      providerThreadId: "launch-reopen-thread",
      profileId: profile.id,
      profileGeneration: profile.processGeneration,
      runtimeScope: "personal",
      providerAccountKey: testProviderAccountKey("claude"),
    });
    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);

    const reopened = new StateStore(paths);
    stores.push(reopened);
    expect(reopened.readClaudeProcessLaunchIntent({
      providerThreadId: intent.providerThreadId,
      profileId: intent.profileId,
      runtimeScope: intent.runtimeScope,
    })).toEqual(intent);
    expect(reopened.listClaudeProcessLaunchIntents()).toEqual([intent]);
    expect(reopened.profileHasClaudeProcessLaunchIntents(
      profile.id,
      profile.processGeneration,
    )).toBe(true);
    const rolled = reopened.advanceProfileGeneration(
      profile.id,
      profile.processGeneration,
    );
    expect(rolled.processGeneration).toBe(profile.processGeneration + 1);
    expect(intent.providerAuthority).toEqual(reopened.requireProviderAccountAuthority(profile.id, "claude"));
    const bootId = `boot_${"b".repeat(32)}`;
    expect(reopened.nextDaemonGeneration(bootId)).toBe(1);
    expect(reopened.nextDaemonGeneration(bootId)).toBe(1);
    expect(reopened.requireProfileById(profile.id)).toMatchObject({
      processGeneration: rolled.processGeneration + 1,
      state: "signed_in",
    });
    expect(reopened.readClaudeProcessLaunchIntent({
      providerThreadId: intent.providerThreadId,
      profileId: intent.profileId,
      runtimeScope: intent.runtimeScope,
    })).toEqual(intent);
    expect(() => reopened.removeProfile(profile.id)).toThrow();
  });
test("synthetic adoption-v36 contract preserves supplied launch fields without execution authority", async () => {
    const paths = await syntheticAdoption36ContractFixture("launch");
    const source = syntheticAdoption36;
    const database = new Database(paths.database, { create: false, strict: true });
    try {
      const before = canonicalAuthBudgetSnapshot(database);
      expect(before.version).toEqual({ user_version: 36 });
      const original = canonicalAuthBudgetRows(database,
        Object.keys(before.rows).filter((table) => table !== "migrations" && table !== "sessions"
          && !syntheticAdoption36MaintenanceTables.has(table)));
      const oldSession = z.record(z.string(), z.unknown()).parse(
        database.query("SELECT * FROM sessions WHERE id=?").get(source.launchSessionId));
      // The constrained synthetic source itself refuses mutation of retained
      // launch identity. No native launch or historical writer is implied.
      expect(() => database.query("UPDATE session_claude_process_launch_intents SET provider_account_key=? WHERE intent_id=?")
        .run(`v1:claude:${"d".repeat(64)}`, source.launchId))
        .toThrow("Claude process launch intent is immutable");
      expect(canonicalAuthBudgetSnapshot(database)).toEqual(before);
      expect(() => { new StateStore(paths, { readonly: true }).close(); })
        .toThrow("STATE_SCHEMA_MIGRATION_REQUIRED:36:61");
      expect(canonicalAuthBudgetSnapshot(database)).toEqual(before);

      const migrated = new StateStore(paths, { now: () => source.migratedAt, resolveMachineTimeZone: () => "UTC" });
      stores.push(migrated);
      expect(migrated.readClaudeProcessLaunchIntent({
        providerThreadId: "synthetic-adoption36-launch", profileId: source.launchProfileId, runtimeScope: "managed",
      })).toEqual({
        intentId: source.launchId, providerThreadId: "synthetic-adoption36-launch",
        profileId: source.launchProfileId, profileGeneration: 1, runtimeScope: "managed",
        providerAccountKey: source.accountKey, sessionId: source.launchSessionId, revision: 1,
        stagedAt: source.fixedTime, updatedAt: source.fixedTime, providerAuthority: null,
      });
      expect(migrated.requireSession(source.launchSessionId)).toMatchObject({
        id: source.launchSessionId, provider: "claude", providerThreadId: "synthetic-adoption36-launch",
      });
      expect(migrated.readSessionAdoptionCandidate("claude", source.candidateThread)).toMatchObject({
        provider: "claude", providerThreadId: source.candidateThread, sourceProcessIdentity: source.sourceProcessIdentity,
        status: "pending", revision: 1, lastLiveObservedAt: null, providerProjectRoot: null,
      });
      expect(database.query("SELECT candidate_fingerprint FROM session_adoption_candidates").get())
        .toEqual({ candidate_fingerprint: syntheticAdoption36CandidateFingerprint });
      expect(original.read()).toEqual(original.before);
      expectSyntheticAdoption36Maintenance(database, before, [source.launchSessionId], [source.launchProfileId]);
      const currentSession = z.record(z.string(), z.unknown()).parse(
        database.query("SELECT * FROM sessions WHERE id=?").get(source.launchSessionId));
      expect(Object.fromEntries(Object.keys(oldSession).map((key) =>
        [key, currentSession[key === "provider" ? "provider_v39" : key]]))).toEqual(oldSession);
      expect(database.query("SELECT * FROM migrations WHERE version<=36 ORDER BY version").all())
        .toEqual(Array.from({ length: 36 }, (_, index) => ({ version: index + 1, applied_at: source.fixedTime })));
      expect(database.query("SELECT version FROM migrations ORDER BY version").all())
        .toEqual(Array.from({ length: 61 }, (_, index) => ({ version: index + 1 })));
      expect(database.query("PRAGMA user_version").get()).toEqual({ user_version: 61 });
      expect(database.query("SELECT * FROM session_provider_authorities").all()).toEqual([]);
      const beforeRefusal = canonicalAuthBudgetSnapshot(database);
      expect(() => migrated.requireSessionProviderAuthority(source.launchSessionId))
        .toThrow("SESSION_PROVIDER_AUTHORITY_QUARANTINED:missing_immutable_runtime_authority");
      expect(canonicalAuthBudgetSnapshot(database)).toEqual(beforeRefusal);
      expectCanonical35To38InertReopens(paths, database);
    } finally { database.close(false); }
  });
test("synthetic adoption-v36 contract refuses one weakened Work guard without writes", async () => {
    // The paired launch case proves this independently frozen schema admits;
    // this input differs by exactly one deliberately weakened trigger.
    const paths = await syntheticAdoption36ContractFixture("launch");
    const database = new Database(paths.database, { create: false, strict: true });
    try {
      const before = canonicalAuthBudgetSnapshot(database);
      database.exec("DROP TRIGGER work_member_account_authority_guard");
      database.exec("CREATE TRIGGER work_member_account_authority_guard BEFORE INSERT ON work_members BEGIN SELECT 1; END");
      const damaged = canonicalAuthBudgetSnapshot(database);
      expect(damaged.rows).toEqual(before.rows);
      expect(damaged.version).toEqual(before.version);
      const objects = z.array(z.object({ name: z.string() }).passthrough());
      expect(objects.parse(damaged.schema).filter(({ name }) => name !== "work_member_account_authority_guard"))
        .toEqual(objects.parse(before.schema).filter(({ name }) => name !== "work_member_account_authority_guard"));
      for (const readonly of [true, false]) {
        expect(() => { new StateStore(paths, { readonly, now: () => syntheticAdoption36.migratedAt }).close(); })
          .toThrow(readonly ? "STATE_SCHEMA_MIGRATION_REQUIRED:36:61" : "STATE_SCHEMA_V39_LEGACY_ADOPTION_WORK_INVALID");
        expect(canonicalAuthBudgetSnapshot(database)).toEqual(damaged);
      }
      expect(database.query("SELECT revision,claim_status FROM session_adoption_candidates").get())
        .toEqual({ revision: 1, claim_status: "pending" });
      expect(database.query("SELECT name FROM sqlite_master WHERE name='notification_hours'").get()).toBeNull();
    } finally { database.close(false); }
  });
test("rejects a weakened same-name Work authority guard in current adoption-v39", async () => {
    const { store } = await fixture({ provision: "migrate" });
    const candidate = store.upsertSessionAdoptionCandidate({
      provider: "codex",
      providerThreadId: "current-v39-weakened-work-guard",
      title: "Current v39 weakened Work guard",
      state: "idle",
      providerUpdatedAt: 10,
      liveness: "unknown",
    });
    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);

    const weakened = new Database(paths.database, { create: false, strict: true });
    try {
      weakened.exec(`
        DROP TRIGGER work_member_account_authority_guard;
        CREATE TRIGGER work_member_account_authority_guard
        BEFORE INSERT ON work_members BEGIN SELECT 1; END;
      `);
    } finally {
      weakened.close(false);
    }

    expect(() => new StateStore(paths))
      .toThrow("STATE_SCHEMA_V39_ADOPTION_WORK_INVALID");
    const inspector = new Database(paths.database, { readonly: true, strict: true });
    try {
      expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: 61 });
      expect(inspector.query(
        `SELECT revision,claim_status FROM session_adoption_candidates
         WHERE provider=? AND provider_thread_id=?`,
      ).get(candidate.provider, candidate.providerThreadId)).toEqual({
        claim_status: "pending",
        revision: candidate.revision,
      });
    } finally {
      inspector.close(false);
    }
  });
test("carries an interrupted personal revocation across daemon generation rollover", async () => {
    const { store } = await fixture();
    const profile = signInProfile(
      store,
      "Restarted personal revocation",
      "restarted-personal-revocation@example.com",
    );
    store.setSessionAdoptionPolicy({ provider: "codex", profileId: profile.id });
    const candidate = store.upsertSessionAdoptionCandidate({
      provider: "codex",
      providerThreadId: "restarted-personal-revocation-thread",
      title: "Restarted personal revocation",
      state: "idle",
      providerUpdatedAt: 10,
      liveness: "not_live",
    });
    const claiming = store.fenceSessionAdoptionCandidateForClaim({
      provider: "codex",
      providerThreadId: candidate.providerThreadId,
      expectedRevision: candidate.revision,
    });
    const adopted = store.adoptSessionCandidate({
      providerAuthority: store.requireProviderAccountAuthority(profile.id, "codex"),
      provider: "codex",
      providerThreadId: claiming.providerThreadId,
      expectedCandidateRevision: claiming.revision,
      profileId: profile.id,
      profileGeneration: profile.processGeneration,
      preset: "high",
      requirement: presetRequirements.high,
      fastEnabled: false,
      runtimeProfile: codexAdoptionRuntimeProfile(profile, "high", false),
      providerAccountKey: providerAccountKeyForProfile(store, profile.id, "codex"),
    });
    const workStore = store.createWorkStore(
      11,
      () => "unused-revocation-rollover-cursor",
      {
        issue: () => `hrac1_${"B".repeat(43)}`,
        verify: () => true,
      },
    );
    const begun = store.beginProfilePersonalAuthorityRevocation({
      profileId: profile.id,
      expectedGeneration: profile.processGeneration,
      workStore,
    });
    expect(begun.revocation).toMatchObject({
      profileGeneration: profile.processGeneration,
      state: "releasing",
    });
    expect(begun.bindings).toEqual([
      expect.objectContaining({ sessionId: adopted.session.id, state: "detaching" }),
    ]);

    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const restarted = new StateStore(paths, { now: () => 2_000 });
    stores.push(restarted);

    expect(restarted.nextDaemonGeneration(`boot_${"v".repeat(32)}`)).toBe(1);
    const rolledProfile = restarted.requireProfileById(profile.id);
    const rolledRevocation = restarted.readProfilePersonalAuthorityRevocation(profile.id);
    expect(rolledProfile).toMatchObject({
      processGeneration: profile.processGeneration + 1,
      state: "recovery_required",
    });
    expect(rolledRevocation).toMatchObject({
      profileGeneration: rolledProfile.processGeneration,
      revision: begun.revocation.revision + 1,
      state: "releasing",
    });
    expect(rolledRevocation?.updatedAt).toBeGreaterThanOrEqual(begun.revocation.updatedAt);

    expect(restarted.completePersonalSessionDetach({
      sessionId: adopted.session.id,
      archive: true,
    }).binding.state).toBe("detached");
    expect(restarted.completeProfilePersonalAuthorityRevocation({
      profileId: profile.id,
      expectedGeneration: rolledProfile.processGeneration,
    })).toMatchObject({
      processGeneration: rolledProfile.processGeneration + 1,
      state: "signed_out",
    });
  });
test("allows Codex sign-out and rollover without releasing managed Claude custody", async () => {
    const { store } = await fixture();
    const profile = signInProfile(
      store,
      "Managed Claude controller",
      "managed-claude-controller@example.com",
    );
    const authority = store.recordClaimedClaudeProcessAuthority({
      providerAuthority: store.requireProviderAccountAuthority(profile.id, "claude"),
      providerThreadId: "managed-controller-thread",
      profileId: profile.id,
      profileGeneration: profile.processGeneration,
      runtimeScope: "managed",
      identity: {
        pid: 51_101,
        pidDomain: "darwin",
        procStart: "managed-controller-current-generation",
      },
    });

    expect(store.setProfileState(
      profile.id,
      profile.processGeneration,
      "signed_out",
    )).toBe(true);
    const rolled = store.advanceProfileGeneration(
      profile.id,
      profile.processGeneration,
    );
    expect(rolled.processGeneration).toBe(profile.processGeneration + 1);
    expect(authority.providerAuthority).toEqual(store.requireProviderAccountAuthority(profile.id, "claude"));
    expect(() => store.removeProfile(profile.id)).toThrow();

    expect(store.requireProfileById(profile.id)).toMatchObject({
      processGeneration: rolled.processGeneration,
      state: "signed_out",
    });
    expect(store.readClaudeProcessAuthority({
      providerThreadId: authority.providerThreadId,
      profileId: authority.profileId,
      runtimeScope: authority.runtimeScope,
    })).toEqual(authority);
  });
test("pages unbound Claude custody by exact profile generation and scope", async () => {
    const { store } = await fixture();
    const profile = signInProfile(
      store,
      "Paged Claude custody",
      "paged-claude-custody@example.com",
    );
    for (const [index, providerThreadId] of ["custody-a", "custody-b"].entries()) {
      store.recordClaimedClaudeProcessAuthority({
        providerAuthority: store.requireProviderAccountAuthority(profile.id, "claude"),
        providerThreadId,
        profileId: profile.id,
        profileGeneration: profile.processGeneration,
        runtimeScope: "managed",
        identity: {
          pid: 53_000 + index,
          pidDomain: "darwin",
          procStart: `paged-custody-${index}`,
        },
      });
    }
    const first = store.listUnreleasedClaudeProcessAuthorityPage({
      profileId: profile.id,
      profileGeneration: profile.processGeneration,
      runtimeScope: "managed",
      afterProviderThreadId: null,
      limit: 1,
    });
    expect(first.authorities).toEqual([
      expect.objectContaining({ providerThreadId: "custody-a", sessionId: null }),
    ]);
    expect(first.continueAfterProviderThreadId).toBe("custody-a");
    const second = store.listUnreleasedClaudeProcessAuthorityPage({
      profileId: profile.id,
      profileGeneration: profile.processGeneration,
      runtimeScope: "managed",
      afterProviderThreadId: first.continueAfterProviderThreadId,
      limit: 1,
    });
    expect(second.authorities).toEqual([
      expect.objectContaining({ providerThreadId: "custody-b", sessionId: null }),
    ]);
  });
test("binds native and adopted-neutral session authority to the original account identity", async () => {
    const { store } = await fixture();
    const snapshot = () => {
      const inspector = new Database(store.paths.database, { readonly: true, strict: true });
      try {
        return Object.fromEntries([
          "profiles", "provider_accounts", "sessions", "session_provider_authorities",
          "session_provider_account_authorities", "queue_entries", "queue_provider_authorities",
          "queue_attachment_identities", "queue_attachment_identity_anchors",
          "mutation_attempts", "mutation_provider_authorities", "sqlite_sequence",
        ].map((table) => [table, inspector.query(`SELECT * FROM ${table} ORDER BY 1`).all()]));
      } finally {
        inspector.close(false);
      }
    };
    const profile = signInProfile(
      store,
      "Session identity binding",
      "original-session-owner@example.com",
    );
    const originalAccountKey = providerAccountKeyForProfile(store, profile.id, "codex");
    const unproven = store.createSession({
      profileId: profile.id,
      provider: "codex",
      preset: "high",
      fastEnabled: false,
    });
    expect(store.sessionAccountAuthorityMatches(unproven.id, profile.id)).toBe(false);
    expect(store.readSessionProviderAccountAuthority(unproven.id)).toBeNull();
    const merelyBound = store.bindSession({
      sessionId: unproven.id,
      expectedRevision: unproven.revision,
      providerThreadId: "account-unproven-native-thread",
      state: "idle",
    });
    expect(store.sessionAccountAuthorityMatches(merelyBound.id, profile.id)).toBe(false);
    const unprovenBefore = snapshot();
    expect(() => store.enqueue(merelyBound.id, "must have provider identity proof"))
      .toThrow("session provider account authority is not current");
    expect(snapshot()).toEqual(unprovenBefore);

    const originalAuthority = store.requireProviderAccountAuthority(profile.id, "codex");
    const session = store.upsertProviderSession({
      providerAuthority: originalAuthority,
      profileId: profile.id,
      provider: "codex",
      providerThreadId: "account-bound-native-thread",
      title: "Provider-proven session",
      preset: "high",
      fastEnabled: false,
      state: "idle",
      providerAccountKey: originalAccountKey,
    });
    expect(store.sessionAccountAuthorityMatches(session.id, profile.id)).toBe(true);
    expect(store.readSessionProviderAccountAuthority(session.id)).toMatchObject({
      accountKey: originalAccountKey,
      provider: "codex",
      runtimeScope: "managed",
    });
    const capturedAuthority = store.requireCapturedSessionProviderAuthority(session.id);
    const capturedScope = store.readSessionProviderAccountAuthority(session.id);
    expect(store.requireSessionProviderAuthority(session.id)).toEqual(capturedAuthority);
    expect(store.listLocalSessionPage({
      profileId: profile.id,
      after: null,
      limit: 10,
      requireCurrentAccountAuthority: true,
    }).sessions).toEqual([session]);

    expect(store.setProfileState(
      profile.id,
      profile.processGeneration,
      "signed_in",
      { email: "replacement-session-owner@example.com", plan: "Plus" },
    )).toBe(true);
    expect(store.sessionAccountAuthorityMatches(session.id, profile.id)).toBe(false);
    expect(store.requireProviderAccountAuthority(profile.id, "codex")).toEqual({
      ...originalAuthority, bindingGeneration: originalAuthority.bindingGeneration + 1,
    });
    expect(store.requireCapturedSessionProviderAuthority(session.id)).toEqual(capturedAuthority);
    expect(store.readSessionProviderAccountAuthority(session.id)).toEqual(capturedScope);
    expect(store.listLocalSessionPage({
      profileId: profile.id,
      after: null,
      limit: 10,
      requireCurrentAccountAuthority: true,
    }).sessions).toEqual([]);
    const replacementBefore = snapshot();
    expect(() => store.enqueue(session.id, "must not cross account identities"))
      .toThrow("SESSION_PROVIDER_AUTHORITY_STALE");
    expect(() => store.setSessionTurnState({
      sessionId: session.id,
      expectedRevision: session.revision,
      state: "active",
      activeTurnId: "replacement-account-turn",
    })).toThrow("session provider account authority is not current");
    expect(snapshot()).toEqual(replacementBefore);

    expect(store.setProfileState(
      profile.id,
      profile.processGeneration,
      "signed_in",
      { email: "ORIGINAL-SESSION-OWNER@example.com", plan: "Plus" },
    )).toBe(true);
    expect(store.sessionAccountAuthorityMatches(session.id, profile.id)).toBe(true);
    expect(store.readSessionProviderAccountAuthority(session.id)).toEqual(capturedScope);
    expect(store.requireCapturedSessionProviderAuthority(session.id)).toEqual(capturedAuthority);
    expect(store.requireProviderAccountAuthority(profile.id, "codex")).toEqual({
      ...originalAuthority, bindingGeneration: originalAuthority.bindingGeneration + 2,
    });
    expect(store.listLocalSessionPage({
      profileId: profile.id,
      after: null,
      limit: 10,
      requireCurrentAccountAuthority: true,
    }).sessions).toEqual([store.requireSession(session.id)]);
    // Matching account metadata is not a successor for the original captured
    // execution tuple. A -> B -> A must not revive the old binding.
    const returnedBefore = snapshot();
    expect(() => store.requireSessionProviderAuthority(session.id))
      .toThrow("SESSION_PROVIDER_AUTHORITY_STALE");
    expect(() => store.enqueue(session.id, "same identity still needs current execution authority"))
      .toThrow("SESSION_PROVIDER_AUTHORITY_STALE");
    expect(store.listQueue(session.id)).toEqual([]);
    expect(snapshot()).toEqual(returnedBefore);

    expect(store.setProfileState(
      profile.id,
      profile.processGeneration,
      "signed_in",
      { plan: "apiKey" },
    )).toBe(true);
    expect(store.sessionAccountAuthorityMatches(session.id, profile.id)).toBe(false);
    expect(store.listLocalSessionPage({
      profileId: profile.id,
      after: null,
      limit: 10,
      requireCurrentAccountAuthority: true,
    }).sessions).toEqual([]);
    const unprovableBefore = snapshot();
    expect(() => store.enqueue(session.id, "unprovable credentials stay fenced"))
      .toThrow("SESSION_PROVIDER_AUTHORITY_STALE");
    expect(() => store.upsertProviderSession({
      providerAuthority: store.requireProviderAccountAuthority(profile.id, "codex"),
      profileId: profile.id,
      provider: "codex",
      providerThreadId: "unprovable-imported-thread",
      title: "Unprovable imported thread",
      preset: "high",
      fastEnabled: false,
      state: "idle",
      providerAccountKey: originalAccountKey,
    })).toThrow("SESSION_PROVIDER_ACCOUNT_AUTHORITY_ACCOUNT_MISMATCH");
    expect(store.requireCapturedSessionProviderAuthority(session.id)).toEqual(capturedAuthority);
    expect(store.readSessionProviderAccountAuthority(session.id)).toEqual(capturedScope);
    expect(snapshot()).toEqual(unprovableBefore);
  });
test("durably pages a scoped account fence and supersedes dirty observations", async () => {
    const value = await fixture();
    let store = value.store;
    const profile = signInProfile(
      store,
      "Paged scoped revocation",
      "paged-scoped-revocation@example.com",
    );
    const accountA = providerAccountKeyForProfile(store, profile.id, "codex");
    const replacementEmail = "paged-scoped-replacement@example.com";
    const accountB = namedProviderAccountKey("codex", replacementEmail);
    const accountC = namedProviderAccountKey("codex", "scoped-account-c");
    const affected = Array.from({ length: 502 }, (_, index) =>
      store.upsertProviderSession({
        providerAuthority: store.requireProviderAccountAuthority(profile.id, "codex"),
        profileId: profile.id,
        provider: "codex",
        providerThreadId: `paged-scoped-${String(index).padStart(4, "0")}`,
        title: `Paged scoped ${index}`,
        preset: "high",
        fastEnabled: false,
        state: "idle",
        providerAccountKey: accountA,
      }));
    expect(store.setProfileState(
      profile.id,
      profile.processGeneration,
      "signed_in",
      { email: replacementEmail, plan: "Plus" },
    )).toBe(true);
    const safe = store.upsertProviderSession({
      providerAuthority: store.requireProviderAccountAuthority(profile.id, "codex"),
      profileId: profile.id,
      provider: "codex",
      providerThreadId: "paged-scoped-safe",
      title: "Paged scoped safe",
      preset: "high",
      fastEnabled: false,
      state: "idle",
      providerAccountKey: accountB,
    });

    // Missing and falsely scoped provider rows must not disappear from the
    // selection merely because the old implementation used an inner join.
    const raw = new Database(store.paths.database, { create: false, strict: true });
    try {
      const guard = z.object({ sql: z.string() }).strict().parse(raw.query(
        `SELECT sql FROM sqlite_master
         WHERE type='trigger' AND name='session_provider_account_authority_update_guard'`,
      ).get());
      raw.exec("DROP TRIGGER session_provider_account_authority_update_guard");
      raw.query(
        "DELETE FROM session_provider_account_authorities WHERE session_id=?",
      ).run(affected[0]?.id ?? "");
      raw.query(
        `UPDATE session_provider_account_authorities SET runtime_scope='personal'
         WHERE session_id=?`,
      ).run(affected[1]?.id ?? "");
      raw.exec(guard.sql);
    } finally {
      raw.close(false);
    }

    const begun = store.beginProviderRuntimeAccountRevocation({
      profileId: profile.id,
      expectedGeneration: profile.processGeneration,
      provider: "codex",
      runtimeScope: "managed",
      currentAccountKey: accountB,
      workStore: createRevocationWorkStore(store),
    });
    expect(begun.revocation).toMatchObject({
      currentAccountKey: accountB,
      revision: 1,
      state: "releasing",
    });
    expect(begun.sessionIds).toHaveLength(502);
    expect(new Set(begun.sessionIds)).toEqual(new Set(affected.map((session) => session.id)));
    expect(store.requireSession(safe.id).state).toBe("idle");
    const fencedRevision = store.requireSession(affected[0]?.id ?? "").revision;
    for (const session of affected) {
      expect(store.requireSession(session.id).state).toBe("recovery_required");
    }

    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);
    store = new StateStore(paths, { now: () => 5_000 });
    stores.push(store);
    expect(store.listReleasingProviderRuntimeAccountRevocations()).toEqual([
      expect.objectContaining({
        profileId: profile.id,
        currentAccountKey: accountB,
        revision: begun.revocation.revision,
      }),
    ]);

    expect(store.nextDaemonGeneration(`boot_${"r".repeat(32)}`)).toBe(1);
    const rolledProfile = store.requireProfileById(profile.id);
    const rolled = store.readProviderRuntimeAccountRevocation({
      profileId: profile.id,
      provider: "codex",
      runtimeScope: "managed",
    });
    expect(rolled).toMatchObject({
      profileGeneration: rolledProfile.processGeneration,
      revision: begun.revocation.revision + 1,
      state: "releasing",
    });
    if (rolled === null) throw new Error("Expected the scoped revocation after restart.");
    const repeated = store.beginProviderRuntimeAccountRevocation({
      profileId: profile.id,
      expectedGeneration: rolledProfile.processGeneration,
      provider: "codex",
      runtimeScope: "managed",
      currentAccountKey: accountB,
      workStore: createRevocationWorkStore(store),
    });
    expect(repeated.revocation.revision).toBe(rolled.revision);
    expect(store.requireSession(affected[0]?.id ?? "").revision).toBe(fencedRevision);

    const superseding = store.beginProviderRuntimeAccountRevocation({
      profileId: profile.id,
      expectedGeneration: rolledProfile.processGeneration,
      provider: "codex",
      runtimeScope: "managed",
      currentAccountKey: accountC,
      workStore: createRevocationWorkStore(store),
    });
    expect(superseding.revocation).toMatchObject({
      currentAccountKey: accountC,
      revision: rolled.revision + 1,
      state: "releasing",
    });
    expect(() => store.completeProviderRuntimeAccountRevocation({
      profileId: profile.id,
      expectedGeneration: rolledProfile.processGeneration,
      provider: "codex",
      runtimeScope: "managed",
      expectedRevision: rolled.revision,
    })).toThrow("PROVIDER_ACCOUNT_AUTHORITY_REVOCATION_CONFLICT");
    const completed = store.completeProviderRuntimeAccountRevocation({
      profileId: profile.id,
      expectedGeneration: rolledProfile.processGeneration,
      provider: "codex",
      runtimeScope: "managed",
      expectedRevision: superseding.revocation.revision,
    });
    expect(completed.state).toBe("completed");
    expect(store.completeProviderRuntimeAccountRevocation({
      profileId: profile.id,
      expectedGeneration: rolledProfile.processGeneration,
      provider: "codex",
      runtimeScope: "managed",
      expectedRevision: superseding.revocation.revision,
    })).toEqual(completed);
  });
test("keeps completed scoped revocations closed over every stale session authority guard", async () => {
    const { store } = await fixture();
    const profile = signInProfile(
      store,
      "Completed scoped revocation",
      "completed-scoped-revocation@example.com",
    );
    const staleAccountKey = providerAccountKeyForProfile(store, profile.id, "codex");
    const currentEmail = "completed-current-account@example.com";
    const currentAccountKey = namedProviderAccountKey("codex", currentEmail);
    const stale = store.upsertProviderSession({
      providerAuthority: store.requireProviderAccountAuthority(profile.id, "codex"),
      profileId: profile.id,
      provider: "codex",
      providerThreadId: "completed-scoped-stale",
      title: "Completed scoped stale",
      preset: "high",
      fastEnabled: false,
      state: "idle",
      providerAccountKey: staleAccountKey,
    });
    expect(store.setProfileState(
      profile.id,
      profile.processGeneration,
      "signed_in",
      { email: currentEmail, plan: "Plus" },
    )).toBe(true);
    const current = store.upsertProviderSession({
      providerAuthority: store.requireProviderAccountAuthority(profile.id, "codex"),
      profileId: profile.id,
      provider: "codex",
      providerThreadId: "completed-scoped-current",
      title: "Completed scoped current",
      preset: "high",
      fastEnabled: false,
      state: "idle",
      providerAccountKey: currentAccountKey,
    });
    const tasks = store.createSessionTaskStore();
    const stalePausedTask = tasks.create({
      sessionId: stale.id,
      name: "Stale paused task",
      prompt: "Must stay paused",
      minutes: 15,
      status: "paused",
      idempotencyKey: "00000000-0000-4000-8000-000000000871",
    });
    const currentPausedTask = tasks.create({
      sessionId: current.id,
      name: "Current paused task",
      prompt: "May resume",
      minutes: 15,
      status: "paused",
      idempotencyKey: "00000000-0000-4000-8000-000000000872",
    });

    const begun = store.beginProviderRuntimeAccountRevocation({
      profileId: profile.id,
      expectedGeneration: profile.processGeneration,
      provider: "codex",
      runtimeScope: "managed",
      currentAccountKey,
      workStore: createRevocationWorkStore(store),
    });
    expect(begun.sessionIds).toEqual([stale.id]);
    const completed = store.completeProviderRuntimeAccountRevocation({
      profileId: profile.id,
      expectedGeneration: profile.processGeneration,
      provider: "codex",
      runtimeScope: "managed",
      expectedRevision: begun.revocation.revision,
    });
    expect(completed).toMatchObject({
      currentAccountKey,
      state: "completed",
    });
    expect(() => store.upsertProviderSession({
      providerAuthority: store.requireProviderAccountAuthority(profile.id, "codex"),
      profileId: profile.id,
      provider: "codex",
      providerThreadId: "completed-scoped-new-stale",
      title: "Completed scoped new stale",
      preset: "high",
      fastEnabled: false,
      state: "idle",
      providerAccountKey: staleAccountKey,
    })).toThrow("SESSION_PROVIDER_ACCOUNT_AUTHORITY_ACCOUNT_MISMATCH");
    const postCompletionCurrent = store.upsertProviderSession({
      providerAuthority: store.requireProviderAccountAuthority(profile.id, "codex"),
      profileId: profile.id,
      provider: "codex",
      providerThreadId: "completed-scoped-new-current",
      title: "Completed scoped new current",
      preset: "high",
      fastEnabled: false,
      state: "idle",
      providerAccountKey: currentAccountKey,
    });

    expect(store.nextDaemonGeneration(`boot_${"s".repeat(32)}`)).toBe(1);
    const currentProfile = store.requireProfileById(profile.id);

    expect(store.sessionAccountAuthorityMatches(stale.id, profile.id)).toBe(false);
    expect(store.sessionAccountAuthorityMatches(current.id, profile.id)).toBe(true);
    expect(new Set(store.listLocalSessionPage({
      profileId: profile.id,
      after: null,
      limit: 10,
      requireCurrentAccountAuthority: true,
    }).sessions.map((session) => session.id))).toEqual(new Set([
      current.id,
      postCompletionCurrent.id,
    ]));
    const staleAuthority = store.requireCapturedSessionProviderAuthority(stale.id);
    const staleScope = store.readSessionProviderAccountAuthority(stale.id);
    const inspector = new Database(store.paths.database, { readonly: true, strict: true });
    try {
      const snapshot = () => Object.fromEntries([
        "provider_accounts", "sessions", "session_provider_authorities",
        "session_provider_account_authorities", "queue_entries", "queue_provider_authorities",
        "queue_attachment_identities", "queue_attachment_identity_anchors",
        "mutation_attempts", "mutation_provider_authorities", "sqlite_sequence",
      ].map((table) => [table, inspector.query(`SELECT * FROM ${table} ORDER BY 1`).all()]));
      const before = snapshot();
      expect(() => store.enqueue(stale.id, "stale queue authority"))
        .toThrow("SESSION_PROVIDER_AUTHORITY_STALE");
      expect(store.requireCapturedSessionProviderAuthority(stale.id)).toEqual(staleAuthority);
      expect(store.readSessionProviderAccountAuthority(stale.id)).toEqual(staleScope);
      expect(store.listQueue(stale.id)).toEqual([]);
      expect(snapshot()).toEqual(before);
    } finally {
      inspector.close(false);
    }
    expect(store.enqueue(current.id, "current queue authority")).toMatchObject({
      sessionId: current.id,
      state: "pending",
    });

    const staleAfterFence = store.requireSession(stale.id);
    expect(() => store.setSessionTurnState({
      sessionId: stale.id,
      expectedRevision: staleAfterFence.revision,
      state: "active",
      activeTurnId: "stale-revocation-turn",
    })).toThrow("session provider account authority is not current");
    expect(store.setSessionTurnState({
      sessionId: current.id,
      expectedRevision: store.requireSession(current.id).revision,
      state: "active",
      activeTurnId: "current-revocation-turn",
    })).toMatchObject({ state: "active", activeTurnId: "current-revocation-turn" });

    const admit = (session: typeof stale, suffix: string) => store.admitInteraction({
      publicId: `00000000-0000-4000-8000-000000000${suffix}`,
      sessionId: session.id,
      authority: {
        profileId: profile.id,
        processGeneration: currentProfile.processGeneration,
        connectionId: `00000000-0000-4000-8000-000000001${suffix}`,
        ...codexInteractionBinding(store, profile.id),
        requestId: { type: "string" as const, value: `completed-${suffix}` },
        method: "item/fileChange/requestApproval",
        requestDigest: suffix.repeat(64).slice(0, 64),
        threadId: session.providerThreadId ?? "",
        turnId: `completed-turn-${suffix}`,
        itemId: `completed-item-${suffix}`,
        approvalId: null,
      },
      kind: "file_change_approval" as const,
      blocking: true,
      display: {
        kind: "file_change_approval" as const,
        summary: "Completed revocation guard",
        reason: null,
        grantRoot: null,
        availableDecisions: ["once", "decline", "cancel"] as const,
      },
    });
    expect(() => admit(stale, "873"))
      .toThrow("provider interaction authority mismatch");
    expect(store.readInteractionProviderAuthority("00000000-0000-4000-8000-000000000873"))
      .toBeNull();
    expect(admit(current, "874").record.sessionId).toBe(current.id);

    expect(() => tasks.create({
      sessionId: stale.id,
      name: "Stale active task",
      prompt: "Must not activate",
      minutes: 15,
      status: "active",
      idempotencyKey: "00000000-0000-4000-8000-000000000875",
    })).toThrow("session provider account authority is not current");
    expect(tasks.create({
      sessionId: current.id,
      name: "Current active task",
      prompt: "May activate",
      minutes: 15,
      status: "active",
      idempotencyKey: "00000000-0000-4000-8000-000000000876",
    }).status).toBe("active");
    expect(() => tasks.edit({
      sessionId: stale.id,
      taskId: stalePausedTask.id,
      expectedRevision: stalePausedTask.revision,
      patch: { status: "active" },
      idempotencyKey: "00000000-0000-4000-8000-000000000877",
    })).toThrow("session provider account authority is not current");
    expect(tasks.edit({
      sessionId: current.id,
      taskId: currentPausedTask.id,
      expectedRevision: currentPausedTask.revision,
      patch: { status: "active" },
      idempotencyKey: "00000000-0000-4000-8000-000000000878",
    }).status).toBe("active");
  });
test("a personal scoped revocation fences an overlapping claim before disabling adoption", async () => {
    const { store } = await fixture();
    const profile = signInProfile(
      store,
      "Overlapping adoption claim",
      "overlapping-adoption-claim@example.com",
    );
    store.setSessionAdoptionPolicy({ provider: "codex", profileId: profile.id });
    const candidate = store.upsertSessionAdoptionCandidate({
      provider: "codex",
      providerThreadId: "overlapping-adoption-claim",
      title: "Overlapping adoption claim",
      state: "idle",
      liveness: "not_live",
    });
    const claiming = store.fenceSessionAdoptionCandidateForClaim({
      provider: "codex",
      providerThreadId: candidate.providerThreadId,
      expectedRevision: candidate.revision,
    });
    expect(claiming.status).toBe("claiming");

    const begun = store.beginProviderRuntimeAccountRevocation({
      profileId: profile.id,
      expectedGeneration: profile.processGeneration,
      provider: "codex",
      runtimeScope: "personal",
      currentAccountKey: namedProviderAccountKey("codex", "replacement-personal-home"),
      workStore: createRevocationWorkStore(store),
    });
    expect(begun.sessionIds).toEqual([]);
    expect(store.readSessionAdoptionPolicy("codex")).toMatchObject({
      enabled: false,
      profileId: null,
    });
    expect(store.listSessionAdoptionCandidates({ provider: "codex" })).toEqual([
      expect.objectContaining({
        providerThreadId: candidate.providerThreadId,
        status: "fenced",
      }),
    ]);
    expect(() => store.setSessionAdoptionPolicy({
      provider: "codex",
      profileId: profile.id,
    })).toThrow("provider runtime account revocation must complete before adoption is enabled");
    store.completeProviderRuntimeAccountRevocation({
      profileId: profile.id,
      expectedGeneration: profile.processGeneration,
      provider: "codex",
      runtimeScope: "personal",
      expectedRevision: begun.revocation.revision,
    });
    expect(() => store.setSessionAdoptionPolicy({
      provider: "codex",
      profileId: profile.id,
    })).toThrow("provider runtime account revocation must complete before adoption is enabled");
  });
test("refuses a foreign WorkStore before staging a scoped fence", async () => {
    const { store } = await fixture();
    const other = await fixture();
    const profile = signInProfile(
      store,
      "Scoped work transaction",
      "scoped-work-transaction@example.com",
    );
    const session = store.upsertProviderSession({
      providerAuthority: store.requireProviderAccountAuthority(profile.id, "codex"),
      profileId: profile.id,
      provider: "codex",
      providerThreadId: "scoped-work-transaction",
      title: "Scoped work transaction",
      preset: "high",
      fastEnabled: false,
      state: "idle",
      providerAccountKey: providerAccountKeyForProfile(store, profile.id, "codex"),
    });
    expect(() => store.beginProviderRuntimeAccountRevocation({
      profileId: profile.id,
      expectedGeneration: profile.processGeneration,
      provider: "codex",
      runtimeScope: "managed",
      currentAccountKey: namedProviderAccountKey("codex", "scoped-work-b"),
      workStore: createRevocationWorkStore(other.store),
    })).toThrow("PROVIDER_ACCOUNT_AUTHORITY_REVOCATION_WORK_STORE_MISMATCH");
    expect(store.readProviderRuntimeAccountRevocation({
      profileId: profile.id,
      provider: "codex",
      runtimeScope: "managed",
    })).toBeNull();
    expect(store.requireSession(session.id).state).toBe("idle");
  });
test("rolls back work retirement with a failed scoped session fence", async () => {
    const { store, home } = await fixture();
    const profile = signInProfile(
      store,
      "Atomic scoped work fence",
      "atomic-scoped-work-fence@example.com",
    );
    const projectRoot = join(home, "atomic-scoped-work-fence");
    await mkdir(projectRoot);
    const project = await store.createProject(
      "Atomic scoped work fence",
      projectRoot,
      true,
    );
    const accountA = providerAccountKeyForProfile(store, profile.id, "codex");
    const importedSession = store.upsertProviderSession({
      providerAuthority: store.requireProviderAccountAuthority(profile.id, "codex"),
      profileId: profile.id,
      provider: "codex",
      providerThreadId: "atomic-scoped-work-fence",
      projectId: project.id,
      title: "Atomic scoped work fence",
      preset: "high",
      fastEnabled: false,
      state: "idle",
      providerAccountKey: accountA,
    });
    const session = store.updateSessionMetadata({
      sessionId: importedSession.id,
      expectedRevision: importedSession.revision,
      preset: "high",
    });
    const workStore = createRevocationWorkStore(store);
    const created = workStore.apply({
      kind: "work.create",
      idempotencyKey: "01890f31-a123-7000-8000-000000000901",
      clientRef: "atomic-scoped-work-fence",
      coordinatorSessionId: session.id,
      objective: "Prove the shared authority transaction.",
      routes: [{
        accountId: profile.id,
        projectId: project.id,
        preset: "high",
        fast: false,
      }],
      tasks: [{
        clientRef: "atomic-scoped-work-task",
        dependsOnRefs: [],
        dependsOnTaskIds: [],
        objective: "Hold one claimed task.",
        instructions: "Remain claimed until authority is fenced.",
        criteria: ["The authority fence retires the claim."],
        route: { accountId: profile.id, projectId: project.id },
        preset: "high",
        fast: false,
        priority: 0,
        maxAttempts: 3,
        requiredReviews: 0,
        resultKind: "text",
        minEvidence: 0,
      }],
    });
    if (created.kind !== "work.create") throw new Error("Expected a created work item.");
    const task = created.tasks[0];
    if (task === undefined) throw new Error("Expected one work task.");
    const claimed = workStore.apply({
      kind: "task.claim",
      idempotencyKey: "01890f31-a123-7000-8000-000000000902",
      workId: created.work.id,
      taskId: task.id,
      expectedTaskRevision: task.revision,
      actorSessionId: session.id,
      actorCapability: `hrac1_${"A".repeat(43)}`,
      leaseMs: 5_000,
    });
    if (claimed.kind !== "task.claim") throw new Error("Expected a claimed work task.");

    const raw = new Database(store.paths.database, { create: false, strict: true });
    try {
      raw.exec(`
        CREATE TRIGGER injected_scoped_session_fence_failure
        BEFORE UPDATE OF state ON sessions
        WHEN OLD.id='${session.id}' AND NEW.state='recovery_required'
        BEGIN SELECT RAISE(ABORT,'INJECTED_SCOPED_SESSION_FENCE_FAILURE'); END;
      `);
      expect(() => store.beginProviderRuntimeAccountRevocation({
        profileId: profile.id,
        expectedGeneration: profile.processGeneration,
        provider: "codex",
        runtimeScope: "managed",
        currentAccountKey: namedProviderAccountKey("codex", "atomic-scoped-work-b"),
        workStore,
      })).toThrow("INJECTED_SCOPED_SESSION_FENCE_FAILURE");
      expect(store.readProviderRuntimeAccountRevocation({
        profileId: profile.id,
        provider: "codex",
        runtimeScope: "managed",
      })).toBeNull();
      expect(store.requireSession(session.id).state).toBe("idle");
      expect(workStore.task(task.id).activeAttempt).toMatchObject({
        id: claimed.attempt.id,
        status: "claimed",
      });
      raw.exec("DROP TRIGGER injected_scoped_session_fence_failure");
    } finally {
      raw.close(false);
    }

    const begun = store.beginProviderRuntimeAccountRevocation({
      profileId: profile.id,
      expectedGeneration: profile.processGeneration,
      provider: "codex",
      runtimeScope: "managed",
      currentAccountKey: namedProviderAccountKey("codex", "atomic-scoped-work-b"),
      workStore,
    });
    expect(begun.affectedWorkIds).toEqual([created.work.id]);
    expect(store.requireSession(session.id).state).toBe("recovery_required");
    expect(workStore.task(task.id).activeAttempt).toBeNull();
  });
test("scoped revocation preserves an unresolved Claude launch and its fence through restart", async () => {
    const { store } = await fixture();
    const profile = signInProfile(
      store,
      "Revoked Claude launch",
      "revoked-claude-launch@example.com",
    );
    const session = upsertProvenTestSession(store, {
      profileId: profile.id,
      provider: "claude",
      providerThreadId: "revoked-claude-launch",
      preset: "fable-max",
      fastEnabled: false,
      state: "idle",
    });
    const intent = store.stageClaudeProcessLaunchIntent({
      providerAuthority: store.requireProviderAccountAuthority(profile.id, "claude"),
      providerThreadId: "revoked-claude-launch",
      profileId: profile.id,
      profileGeneration: profile.processGeneration,
      runtimeScope: "managed",
      providerAccountKey: testProviderAccountKey("claude"),
      sessionId: session.id,
    });
    const begun = store.beginProviderRuntimeAccountRevocation({
      profileId: profile.id,
      expectedGeneration: profile.processGeneration,
      provider: "claude",
      runtimeScope: "managed",
      currentAccountKey: null,
      workStore: createRevocationWorkStore(store),
    });
    expect(begun.sessionIds).toEqual([session.id]);
    expect(store.requireSession(session.id).state).toBe("recovery_required");
    expect(store.readClaudeProcessLaunchIntent({
      providerThreadId: intent.providerThreadId,
      profileId: intent.profileId,
      runtimeScope: intent.runtimeScope,
    })).toEqual(intent);
    expect(() => store.completeProviderRuntimeAccountRevocation({
      profileId: profile.id,
      expectedGeneration: profile.processGeneration,
      provider: "claude",
      runtimeScope: "managed",
      expectedRevision: begun.revocation.revision,
    })).toThrow("PROVIDER_ACCOUNT_AUTHORITY_REVOCATION_CLAUDE_LAUNCH_INTENT_LIVE");
    const captured = store.requireCapturedSessionProviderAuthority(session.id);
    expect(store.nextDaemonGeneration(`boot_${"d".repeat(32)}`)).toBe(1);
    expect(store.readClaudeProcessLaunchIntent({
      providerThreadId: intent.providerThreadId,
      profileId: intent.profileId,
      runtimeScope: intent.runtimeScope,
    })).toEqual(intent);
    const carried = store.readProviderRuntimeAccountRevocation({
      profileId: profile.id,
      provider: "claude",
      runtimeScope: "managed",
    });
    expect(carried).toMatchObject({ profileGeneration: profile.processGeneration + 1,
      revision: begun.revocation.revision + 1, state: "releasing", currentAccountKey: null });
    expect(store.requireCapturedSessionProviderAuthority(session.id)).toEqual(captured);
    expect(store.requireSession(session.id).state).toBe("recovery_required");
    if (carried === null) throw new Error("Expected retained Claude revocation.");
    expect(() => store.completeProviderRuntimeAccountRevocation({ profileId: profile.id,
      expectedGeneration: carried.profileGeneration, provider: "claude", runtimeScope: "managed",
      expectedRevision: carried.revision })).toThrow("PROVIDER_ACCOUNT_AUTHORITY_REVOCATION_CLAUDE_LAUNCH_INTENT_LIVE");
    const inspector = new Database(store.paths.database, { readonly: true });
    try {
      expect(inspector.query("SELECT * FROM session_provider_authority_successors WHERE session_id=?").all(session.id)).toEqual([]);
      expect(inspector.query("SELECT * FROM session_claude_launch_dispositions").all()).toEqual([]);
    } finally { inspector.close(false); }
  });
test("global account replacement retires native and adopted sessions identically", async () => {
    const { store } = await fixture();
    const profile = signInProfile(
      store,
      "Native adopted parity",
      "native-adopted-parity@example.com",
    );
    const accountKey = providerAccountKeyForProfile(store, profile.id, "codex");
    const native = store.upsertProviderSession({
      providerAuthority: store.requireProviderAccountAuthority(profile.id, "codex"),
      profileId: profile.id,
      provider: "codex",
      providerThreadId: "native-parity-thread",
      title: "Native parity",
      preset: "high",
      fastEnabled: false,
      state: "idle",
      providerAccountKey: accountKey,
    });
    store.setSessionAdoptionPolicy({ provider: "codex", profileId: profile.id });
    const candidate = store.upsertSessionAdoptionCandidate({
      provider: "codex",
      providerThreadId: "adopted-parity-thread",
      title: "Adopted parity",
      state: "idle",
      liveness: "not_live",
    });
    const claiming = store.fenceSessionAdoptionCandidateForClaim({
      provider: "codex",
      providerThreadId: candidate.providerThreadId,
      expectedRevision: candidate.revision,
    });
    const adopted = store.adoptSessionCandidate({
      providerAuthority: store.requireProviderAccountAuthority(profile.id, "codex"),
      provider: "codex",
      providerThreadId: candidate.providerThreadId,
      expectedCandidateRevision: claiming.revision,
      profileId: profile.id,
      profileGeneration: profile.processGeneration,
      preset: "high",
      requirement: presetRequirements.high,
      fastEnabled: false,
      runtimeProfile: codexAdoptionRuntimeProfile(profile, "high", false),
      providerAccountKey: accountKey,
    }).session;
    const queueIds = [native, adopted].map((session, index) =>
      store.enqueue(session.id, `parity queue ${index}`).id);
    const mutationKeys = [native, adopted].map((session, index) => {
      const idempotencyKey = `00000000-0000-4000-8000-${String(820 + index).padStart(12, "0")}`;
      store.prepareMutation({
        kind: "session.rename",
        authorityId: session.id,
        authorityGeneration: profile.processGeneration,
        request: { name: `parity ${index}` },
        idempotencyKey,
      });
      return idempotencyKey;
    });
    const taskStore = store.createSessionTaskStore();
    const taskIds = [native, adopted].map((session, index) =>
      taskStore.create({
        sessionId: session.id,
        name: `Parity task ${index}`,
        prompt: `Run parity task ${index}`,
        minutes: 15,
        status: "active",
        idempotencyKey: `00000000-0000-4000-8000-${String(830 + index).padStart(12, "0")}`,
      }).id);
    const interactions = [native, adopted].map((session, index) =>
      store.admitInteraction({
        publicId: `00000000-0000-4000-8000-${String(840 + index).padStart(12, "0")}`,
        sessionId: session.id,
        authority: {

          ...codexInteractionBinding(store, profile.id),
          profileId: profile.id,
          processGeneration: profile.processGeneration,
          connectionId: `00000000-0000-4000-8000-${String(850 + index).padStart(12, "0")}`,
          requestId: { type: "string", value: `parity-${index}` },
          method: "item/fileChange/requestApproval",
          requestDigest: String(index + 1).repeat(64),
          threadId: session.providerThreadId ?? "",
          turnId: `parity-turn-${index}`,
          itemId: `parity-item-${index}`,
          approvalId: null,
        },
        kind: "file_change_approval",
        blocking: true,
        display: {
          kind: "file_change_approval",
          summary: "Approve parity change",
          reason: null,
          grantRoot: null,
          availableDecisions: ["once", "decline", "cancel"],
        },
      }).record);

    const begun = store.beginProfilePersonalAuthorityRevocation({
      profileId: profile.id,
      expectedGeneration: profile.processGeneration,
      workStore: createRevocationWorkStore(store),
    });
    expect(new Set(begun.sessionIds)).toEqual(new Set([native.id, adopted.id]));
    for (const session of [native, adopted]) {
      const fenced = store.requireSession(session.id);
      expect(fenced.state).toBe("recovery_required");
      expect(fenced.activeTurnId).toBeUndefined();
    }
    for (const queueId of queueIds) {
      expect(store.requireQueue(queueId).state).toBe("cancelled");
    }
    for (const mutationKey of mutationKeys) {
      expect(store.readMutation(mutationKey)?.state).toBe("cancelled");
    }
    for (const [index, taskId] of taskIds.entries()) {
      const sessionId = [native, adopted][index]?.id ?? "";
      expect(taskStore.list(sessionId).find((task) => task.id === taskId)).toMatchObject({
        status: "paused",
        nextDueAt: null,
      });
    }
    for (const interaction of interactions) {
      expect(store.requireInteraction(interaction.publicId).state).toBe("expired");
    }

    store.completePersonalSessionDetach({ sessionId: adopted.id, archive: false });
    store.completeProfilePersonalAuthorityRevocation({
      profileId: profile.id,
      expectedGeneration: profile.processGeneration,
    });
    for (const session of [native, adopted]) {
      const retired = store.requireSession(session.id);
      expect(retired.state).toBe("recovery_required");
      expect(retired.archivedAt).toBeUndefined();
    }
  });
test.each(["releasing", "completed_after_rollover"] as const)(
    "refuses a current generic switch into a releasing Claude scope with a divergent own generation: %s",
    async (disposition) => {
    const { store } = await fixture();
    const sourceProfile = signInProfile(store, "Scope switch source", "scope-source@example.com");
    const targetProfile = signInProfile(store, "Scope switch target", "scope-target@example.com");
    const source = upsertProvenTestSession(store, {
      profileId: sourceProfile.id, provider: "codex", providerThreadId: "scope-switch-source",
      preset: "high", fastEnabled: false, state: "idle",
    });
    const sourceProviderThreadId = source.providerThreadId;
    if (sourceProviderThreadId === undefined) throw new Error("Expected a bound source thread.");
    const sourceAuthority = store.requireProviderAccountAuthority(sourceProfile.id, "codex");
    store.advanceProviderAccountProcessGeneration({
      profileId: targetProfile.id, provider: "claude", expectedProcessGeneration: 0,
    });
    const targetAuthority = store.advanceProviderAccountProcessGeneration({
      profileId: targetProfile.id, provider: "claude", expectedProcessGeneration: 1,
    });
    expect(targetAuthority.processGeneration).not.toBe(targetProfile.processGeneration);
    const key = crypto.randomUUID();
    const attempt = store.prepareMutation({
      authorityGeneration: targetAuthority.processGeneration, authorityId: source.id,
      idempotencyKey: key, kind: "session.switch",
      request: sessionProviderSwitchMutationRequest({ preset: "fable-max", provider: "claude",
        targetProfileId: targetProfile.id, seedDigest: "8".repeat(64) }),
      providerAuthorities: [
        { role: "source", authority: sourceAuthority, provenance: "legacy_switch_source" },
        { role: "target", authority: targetAuthority, provenance: "legacy_switch_target" },
      ],
    });
    const { revocation } = store.beginProviderRuntimeAccountRevocation({
      profileId: targetProfile.id, expectedGeneration: targetProfile.processGeneration,
      provider: "claude", runtimeScope: "managed", currentAccountKey: null,
      workStore: createRevocationWorkStore(store),
    });
    if (disposition === "completed_after_rollover") {
      store.completeProviderRuntimeAccountRevocation({
        profileId: targetProfile.id, expectedGeneration: targetProfile.processGeneration,
        provider: "claude", runtimeScope: "managed", expectedRevision: revocation.revision,
      });
      store.advanceProfileGeneration(targetProfile.id, targetProfile.processGeneration);
      expect(store.requireProfileById(targetProfile.id).processGeneration).toBe(targetProfile.processGeneration + 1);
    }
    const retainedRevocation = store.readProviderRuntimeAccountRevocation({
      profileId: targetProfile.id, provider: "claude", runtimeScope: "managed",
    });
    const before = store.readMutation(key);
    expect(before).toMatchObject({ state: "prepared" });
    expect(() => store.beginSessionProviderSwitchEffect({
      attemptId: attempt.id, sessionId: source.id,
      providerAuthentication: {
        profileId: targetProfile.id, provider: "claude", signedIn: true,
        processGeneration: targetAuthority.processGeneration,
      },
      evidence: {
        kind: "session.switch", daemonGeneration: 0, requestedAccountId: null,
        requestedPreset: "fable-max", runtimeProfile: claudeAdoptionRuntimeProfile(targetAuthority),
        seedDigest: "8".repeat(64), seedIncludedRecords: 1, seedOmittedRecords: 0,
        sourcePreset: "high", sourceProcessGeneration: sourceAuthority.processGeneration,
        sourceProfileId: sourceProfile.id, sourceProvider: "codex",
        sourceProviderThreadId,
        targetPreset: "fable-max", targetProcessGeneration: targetAuthority.processGeneration,
        targetProfileId: targetProfile.id, targetProvider: "claude",
        targetHostCapabilities: testSwitchHostCapabilities,
        targetProviderAccountKey: testProviderAccountKey("claude"), transcriptDigest: "9".repeat(64),
      },
    })).toThrow("SESSION_PROVIDER_SWITCH_AUTHORITY_CHANGED");
    expect(store.readMutation(key)).toEqual(before);
    expect(store.requireProviderAccountAuthority(targetProfile.id, "claude")).toEqual(targetAuthority);
    expect(store.readProviderRuntimeAccountRevocation({
      profileId: targetProfile.id, provider: "claude", runtimeScope: "managed",
    })).toEqual(retainedRevocation);
    expect(store.requireSession(source.id)).toEqual(source);
    expect(store.profileHasClaudeProcessLaunchIntents(targetProfile.id)).toBe(false);
  });
test("refuses a Claude launch into a completed accountless scope after sibling Codex rollover", async () => {
    const { store } = await fixture();
    const profile = signInProfile(store, "Accountless launch", "accountless-launch@example.com");
    store.advanceProviderAccountProcessGeneration({
      profileId: profile.id, provider: "claude", expectedProcessGeneration: 0,
    });
    const authority = store.advanceProviderAccountProcessGeneration({
      profileId: profile.id, provider: "claude", expectedProcessGeneration: 1,
    });
    const { revocation } = store.beginProviderRuntimeAccountRevocation({
      profileId: profile.id, expectedGeneration: profile.processGeneration,
      provider: "claude", runtimeScope: "personal", currentAccountKey: null,
      workStore: createRevocationWorkStore(store),
    });
    const completed = store.completeProviderRuntimeAccountRevocation({
      profileId: profile.id, expectedGeneration: profile.processGeneration,
      provider: "claude", runtimeScope: "personal", expectedRevision: revocation.revision,
    });
    const rolled = store.advanceProfileGeneration(profile.id, profile.processGeneration);
    expect(rolled.processGeneration).not.toBe(completed.profileGeneration);
    expect(store.requireProviderAccountAuthority(profile.id, "claude")).toEqual(authority);
    store.setSessionAdoptionPolicy({ provider: "claude", profileId: profile.id });
    const candidate = store.upsertSessionAdoptionCandidate({
      provider: "claude", providerThreadId: "accountless-scope-launch",
      title: "Accountless scope launch candidate", state: "idle",
      providerUpdatedAt: 10, liveness: "not_live",
    });
    const claiming = store.fenceSessionAdoptionCandidateForClaim({
      provider: "claude", providerThreadId: candidate.providerThreadId,
      expectedRevision: candidate.revision,
    });
    const input = {
      profileId: profile.id, profileGeneration: rolled.processGeneration,
      providerAuthority: authority, providerThreadId: "accountless-scope-launch",
      runtimeScope: "personal" as const, providerAccountKey: testProviderAccountKey("claude"),
    };
    expect(() => store.stageClaudeProcessLaunchIntent(input))
      .toThrow("SESSION_CLAUDE_PROCESS_LAUNCH_INTENT_ACCOUNT_STALE");
    expect(store.readClaudeProcessLaunchIntent({
      profileId: profile.id, runtimeScope: "personal", providerThreadId: input.providerThreadId,
    })).toBeNull();
    expect(store.readSessionAdoptionCandidate("claude", input.providerThreadId)).toEqual(claiming);
    expect(store.readProviderRuntimeAccountRevocation({
      profileId: profile.id, provider: "claude", runtimeScope: "personal",
    })).toEqual(completed);
    expect(store.requireProviderAccountAuthority(profile.id, "claude")).toEqual(authority);
  });
});
