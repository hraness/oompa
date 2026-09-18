import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { z } from "zod";
import { canonical41TimestampsFixture } from "../../scripts/fixtures/canonical41-timestamps";
import { canonical49WorkDatabaseBytes, canonical49WorkFixture } from "../../scripts/fixtures/canonical49-work";
import { canonical48WorkFixture } from "../../scripts/fixtures/canonical48-work";
import { canonicalLoginLedgerFixtures } from "../../scripts/fixtures/canonical-login-ledger";
import { canonicalAuthBudgetFixtures } from "../../scripts/fixtures/canonical-auth-budget";
import { canonical34StorageFixture } from "../../scripts/fixtures/canonical34-storage";
import { canonicalIdentityAttentionFixtures } from "../../scripts/fixtures/canonical-identity-attention";
import { canonical20To40Fixture } from "../../scripts/fixtures/canonical20-40";
import { syntheticAdoption36 } from "../../scripts/fixtures/synthetic-adoption36";
import { canonical39DevinFixture } from "../../scripts/fixtures/canonical39-devin";
import { canonical39RetiredFixtures } from "../../scripts/fixtures/canonical39-retired-effects";
import { deriveDesktopProfilePaths } from "./desktop-profile-paths";
import { currentPresetContract, presetRequirements } from "../domain/presets";
import { SESSION_CONVERSATION_AUTOMATION_CAPABILITY } from "../domain/session-tasks";
import { createAttemptId, createQueueId } from "../domain/values";
import { canTransitionQueue, queueStateSchema } from "../domain/transitions";
import { effectiveClaudeRuntimeProfileSchema, effectiveDevinRuntimeProfileSchema, effectiveRuntimeProfileSchema } from "../domain/runtime-profile";
import { initializeProfilePaths, initializeStatePaths, resolveStatePaths } from "./paths";
import { SelectionError, sessionProviderSwitchMutationRequest, sessionStartMutationRequest, StateSecurityScrubRequiredError, StateStore } from "./state-store";
import {
  adoptPersonalClaudeTestSession,
  advanceDedicatedSessionSwitch,
  canonical20To40Archive,
  canonical34StorageArchive,
  canonical39DevinArchive,
  canonical39RetiredArchive,
  canonical48WorkArchive,
  canonical50LedgerArchive,
  canonicalAuthBudgetArchive,
  canonicalAuthBudgetFrozenSchema,
  canonicalAuthBudgetPendingQuarantine,
  canonicalAuthBudgetRows,
  canonicalAuthBudgetSnapshot,
  canonicalIdentityAttentionArchive,
  canonicalTimestampArchiveForTest,
  capturedProviderAuthorityForTest,
  claudeAdoptionRuntimeProfile,
  codexAdoptionRuntimeProfile,
  codexAuthorityFor,
  completeCodexAccountMutationAuthorityRetirement,
  createProvenTestSession,
  createRevocationWorkStore,
  desktopSwitchBinding,
  drainStateStoreCasesAndClose,
  enqueueAttachedTestQueue,
  expectCanonical35To38InertReopens,
  expectHistoricalValue,
  expectInertSchemaRefusal,
  expectSyntheticAdoption36Maintenance,
  fixture,
  moveQueueTo,
  namedProviderAccountKey,
  ownedStateStoreCase,
  ownedStateStoreCaseDrains,
  pinnedReaderSource,
  prepareDedicatedSessionSwitch,
  prepareSignedOutSessionStart,
  providerAccountKeyForProfile,
  reviewedClaudeProfile,
  reviewedCodexProfile,
  shortScrubCheckpoint,
  signInProfile,
  snapshotSwitchContainmentForTest,
  spawnReaderProcess,
  stagedCanonical47Archive,
  startInputFixtureDaemon,
  stateFileSuffixesContaining,
  statusReaderReportSchema,
  statusReaderSource,
  stores,
  syntheticAdoption36ContractFixture,
  syntheticAdoption36MaintenanceTables,
  testDigest,
  testProviderAccountKey,
  testSwitchHostCapabilities,
  upsertProvenTestSession,
  withRemovedTestGuards,
} from "../../scripts/fixtures/state-store-testkit";

setDefaultTimeout(60_000);

afterEach(async () => {
  await drainStateStoreCasesAndClose(ownedStateStoreCaseDrains, () => stores.splice(0));
});

describe("StateStore", () => {
test("preserves an ambiguous cross-profile switch across sibling Codex revocation without granting Claude restart authority", async () => {
    const { store } = await fixture();
    const sourceProfile = signInProfile(
      store,
      "Revoked switch source",
      "revoked-switch-source@example.com",
    );
    const targetProfile = signInProfile(
      store,
      "Revoked switch target",
      "revoked-switch-target@example.com",
    );
    const source = upsertProvenTestSession(store, {
      profileId: sourceProfile.id,
      provider: "codex",
      providerThreadId: "revoked-switch-source-thread",
      preset: "high",
      fastEnabled: false,
      state: "idle",
    });
    store.advanceProviderAccountProcessGeneration({ profileId: targetProfile.id, provider: "claude", expectedProcessGeneration: 0 });
    const targetAuthority = store.advanceProviderAccountProcessGeneration({ profileId: targetProfile.id, provider: "claude", expectedProcessGeneration: 1 });
    expect(targetAuthority.processGeneration).not.toBe(targetProfile.processGeneration);
    const attempt = store.prepareMutation({
      authorityGeneration: targetAuthority.processGeneration,
      authorityId: source.id,
      idempotencyKey: "00000000-0000-4000-8000-000000000879",
      kind: "session.switch",
      request: sessionProviderSwitchMutationRequest({
        provider: "claude",
        preset: "fable-max",
        targetProfileId: targetProfile.id,
        seedDigest: "8".repeat(64),
      }),
      providerAuthorities: [
        { role: "source", authority: store.requireProviderAccountAuthority(sourceProfile.id, "codex"), provenance: "legacy_switch_source" },
        { role: "target", authority: targetAuthority, provenance: "legacy_switch_target" },
      ],
    });
    const targetRuntimeProfile = claudeAdoptionRuntimeProfile(store.requireProviderAccountAuthority(targetProfile.id, "claude"));
    store.beginSessionProviderSwitchEffect({
      attemptId: attempt.id,
      sessionId: source.id,
      providerAuthentication: {
        profileId: targetProfile.id,
        processGeneration: targetAuthority.processGeneration,
        provider: "claude",
        signedIn: true,
      },
      evidence: {
        kind: "session.switch",
        daemonGeneration: 0,
        requestedAccountId: null,
        requestedPreset: "fable-max",
        runtimeProfile: targetRuntimeProfile,
        seedDigest: "8".repeat(64),
        seedIncludedRecords: 1,
        seedOmittedRecords: 0,
        sourcePreset: "high",
        sourceProcessGeneration: sourceProfile.processGeneration,
        sourceProfileId: sourceProfile.id,
        sourceProvider: "codex",
        sourceProviderThreadId: source.providerThreadId ?? "",
        targetPreset: "fable-max",
        targetProcessGeneration: targetAuthority.processGeneration,
        targetProfileId: targetProfile.id,
        targetProvider: "claude",
        targetProviderAccountKey: testProviderAccountKey("claude"),
        targetHostCapabilities: testSwitchHostCapabilities,
        transcriptDigest: "9".repeat(64),
      },
    });

    store.beginProfilePersonalAuthorityRevocation({
      profileId: targetProfile.id,
      expectedGeneration: targetProfile.processGeneration,
      workStore: createRevocationWorkStore(store),
    });
    const released = store.completeProfilePersonalAuthorityRevocation({
      profileId: targetProfile.id,
      expectedGeneration: targetProfile.processGeneration,
    });
    expect(released).toMatchObject({
      processGeneration: targetProfile.processGeneration + 1,
      state: "signed_out",
    });
    expect(store.isSessionMutationProviderAuthorityCurrent({
      attemptId: attempt.id,
      profileId: targetProfile.id,
      provider: "claude",
      originGeneration: targetAuthority.processGeneration,
    })).toBe(true);
    expect(store.requireProviderAccountAuthority(targetProfile.id, "claude")).toEqual(targetAuthority);
    const frozenEvidence = store.readMutation("00000000-0000-4000-8000-000000000879")?.evidence;

    expect(store.nextDaemonGeneration(`boot_${"w".repeat(32)}`)).toBe(1);
    expect(store.isSessionMutationProviderAuthorityCurrent({
      attemptId: attempt.id,
      profileId: targetProfile.id,
      provider: "claude",
      originGeneration: targetAuthority.processGeneration,
    })).toBe(false);
    expect(store.readMutation("00000000-0000-4000-8000-000000000879")).toMatchObject({ state: "ambiguous", evidence: frozenEvidence });
    expect(store.requireSession(source.id).state).toBe("recovery_required");
  });
test("stages scoped recovery before releasing exact managed Claude custody", async () => {
    const { store } = await fixture();
    const profile = signInProfile(
      store,
      "Managed Claude recovery",
      "managed-claude-recovery@example.com",
    );
    const authority = store.recordClaimedClaudeProcessAuthority({
      providerAuthority: store.requireProviderAccountAuthority(profile.id, "claude"),
      providerThreadId: "managed-recovery-thread",
      profileId: profile.id,
      profileGeneration: profile.processGeneration,
      runtimeScope: "managed",
      identity: {
        pid: 51_102,
        pidDomain: "darwin",
        procStart: "managed-controller-recovery",
      },
    });

    expect(store.setProfileState(
      profile.id,
      profile.processGeneration,
      "recovery_required",
      { email: "managed-claude-recovery@example.com", plan: "Plus" },
    )).toBe(true);
    const { revocation } = store.beginProviderRuntimeAccountRevocation({
      profileId: profile.id,
      expectedGeneration: profile.processGeneration,
      provider: "claude", runtimeScope: "managed", currentAccountKey: null,
      workStore: createRevocationWorkStore(store),
    });
    expect(revocation).toMatchObject({
      profileGeneration: profile.processGeneration,
      state: "releasing",
    });
    expect(store.setProfileState(
      profile.id,
      profile.processGeneration,
      "recovery_required",
      { email: "managed-claude-recovery@example.com", plan: "Plus" },
    )).toBe(true);
    expect(() => store.completeProviderRuntimeAccountRevocation({
      profileId: profile.id,
      expectedGeneration: profile.processGeneration,
      provider: "claude", runtimeScope: "managed", expectedRevision: revocation.revision,
    })).toThrow("PROVIDER_ACCOUNT_AUTHORITY_REVOCATION_CLAUDE_PROCESS_LIVE");

    expect(() => store.beginClaudeProcessAuthorityRelease({
      providerThreadId: authority.providerThreadId,
      profileId: authority.profileId,
      runtimeScope: authority.runtimeScope,
      expectedRevision: authority.revision,
      identity: { ...authority.identity, procStart: "wrong-controller-identity" },
    })).toThrow("SESSION_CLAUDE_PROCESS_AUTHORITY_IDENTITY_MISMATCH");
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
    expect(store.completeProviderRuntimeAccountRevocation({
      profileId: profile.id,
      expectedGeneration: profile.processGeneration,
      provider: "claude", runtimeScope: "managed", expectedRevision: revocation.revision,
    })).toMatchObject({
      profileGeneration: profile.processGeneration,
      state: "completed",
    });
    expect(store.readProviderRuntimeAccountRevocation({ profileId: profile.id,
      provider: "claude", runtimeScope: "managed" })).toMatchObject({
      profileGeneration: profile.processGeneration,
      state: "completed",
    });
    expect(authority.providerAuthority).toEqual(store.requireProviderAccountAuthority(profile.id, "claude"));
  });
test("keeps exact managed Claude release identity across Codex daemon retirement", async () => {
    const { store } = await fixture();
    const profile = signInProfile(
      store,
      "Managed Claude restart",
      "managed-claude-restart@example.com",
    );
    const authority = store.recordClaimedClaudeProcessAuthority({
      providerAuthority: store.requireProviderAccountAuthority(profile.id, "claude"),
      providerThreadId: "managed-restart-thread",
      profileId: profile.id,
      profileGeneration: profile.processGeneration,
      runtimeScope: "managed",
      identity: {
        pid: 51_103,
        pidDomain: "darwin",
        procStart: "managed-controller-before-restart",
      },
    });
    const workStore = store.createWorkStore(
      9,
      () => "unused-test-cursor",
      {
        issue: () => `hrac1_${"A".repeat(43)}`,
        verify: () => true,
      },
    );

    const rolled = store.advanceProfileGenerationForDaemonShutdown(
      profile.id,
      profile.processGeneration,
      workStore,
    ).profile;
    expect(store.requireProfileById(profile.id)).toMatchObject({
      processGeneration: profile.processGeneration + 1,
      state: "signed_in",
    });
    expect(authority.providerAuthority).toEqual(store.requireProviderAccountAuthority(profile.id, "claude"));
    expect(store.readClaudeProcessAuthority({
      providerThreadId: authority.providerThreadId,
      profileId: authority.profileId,
      runtimeScope: authority.runtimeScope,
    })).toEqual(authority);
    expect(() => store.beginClaudeProcessAuthorityRelease({ providerThreadId: authority.providerThreadId,
      profileId: authority.profileId, runtimeScope: authority.runtimeScope, expectedRevision: authority.revision,
      identity: { ...authority.identity, procStart: "unproved-after-codex-retirement" } }))
      .toThrow("SESSION_CLAUDE_PROCESS_AUTHORITY_IDENTITY_MISMATCH");

    const releasing = store.beginClaudeProcessAuthorityRelease({
      providerThreadId: authority.providerThreadId,
      profileId: authority.profileId,
      runtimeScope: authority.runtimeScope,
      expectedRevision: authority.revision,
      identity: authority.identity,
    });
    const released = store.completeClaudeProcessAuthorityRelease({
      providerThreadId: releasing.providerThreadId,
      profileId: releasing.profileId,
      runtimeScope: releasing.runtimeScope,
      expectedRevision: releasing.revision,
      identity: releasing.identity,
    });
    expect(store.advanceProfileGenerationForDaemonShutdown(
      profile.id,
      rolled.processGeneration,
      workStore,
    )).toMatchObject({
      affectedWorkIds: [],
      profile: {
        processGeneration: rolled.processGeneration + 1,
        state: "signed_in",
      },
    });
    expect(store.readClaudeProcessAuthority({
      providerThreadId: authority.providerThreadId,
      profileId: authority.profileId,
      runtimeScope: authority.runtimeScope,
    })).toEqual(released);
    expect(store.listUnreleasedClaudeProcessAuthorities()).not.toContainEqual(released);
    expect(authority.providerAuthority).toEqual(store.requireProviderAccountAuthority(profile.id, "claude"));
  });
test("carries releasing revocations through clean daemon retirement atomically", async () => {
    const { store } = await fixture();
    const workStore = createRevocationWorkStore(store);
    const globalProfile = signInProfile(
      store,
      "Clean global revocation rollover",
      "clean-global-revocation@example.com",
    );
    const scopedProfile = signInProfile(
      store,
      "Clean scoped revocation rollover",
      "clean-scoped-revocation@example.com",
    );
    const global = store.beginProfilePersonalAuthorityRevocation({
      profileId: globalProfile.id,
      expectedGeneration: globalProfile.processGeneration,
      workStore,
    });
    const scoped = store.beginProviderRuntimeAccountRevocation({
      profileId: scopedProfile.id,
      expectedGeneration: scopedProfile.processGeneration,
      provider: "claude",
      runtimeScope: "personal",
      currentAccountKey: null,
      workStore,
    });

    const rolledGlobal = store.advanceProfileGenerationForDaemonShutdown(
      globalProfile.id,
      globalProfile.processGeneration,
      workStore,
    ).profile;
    const rolledScoped = store.advanceProfileGenerationForDaemonShutdown(
      scopedProfile.id,
      scopedProfile.processGeneration,
      workStore,
    ).profile;
    expect(store.readProfilePersonalAuthorityRevocation(globalProfile.id)).toMatchObject({
      profileGeneration: rolledGlobal.processGeneration,
      revision: global.revocation.revision + 1,
      state: "releasing",
    });
    expect(store.readProviderRuntimeAccountRevocation({
      profileId: scopedProfile.id,
      provider: "claude",
      runtimeScope: "personal",
    })).toMatchObject({
      profileGeneration: rolledScoped.processGeneration,
      revision: scoped.revocation.revision + 1,
      state: "releasing",
    });
    expect(store.completeProfilePersonalAuthorityRevocation({
      profileId: globalProfile.id,
      expectedGeneration: rolledGlobal.processGeneration,
    })).toMatchObject({
      processGeneration: rolledGlobal.processGeneration + 1,
      state: "signed_out",
    });
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
    })).toMatchObject({
      profileGeneration: rolledScoped.processGeneration,
      state: "completed",
    });

    const blockedProfile = signInProfile(
      store,
      "Blocked clean revocation rollover",
      "blocked-clean-revocation@example.com",
    );
    const retainedProcess = store.recordClaimedClaudeProcessAuthority({
      providerAuthority: store.requireProviderAccountAuthority(blockedProfile.id, "claude"),
      providerThreadId: "blocked-clean-revocation-process",
      profileId: blockedProfile.id,
      profileGeneration: blockedProfile.processGeneration,
      runtimeScope: "managed",
      identity: {
        pid: 51_104,
        pidDomain: "darwin",
        procStart: "blocked-clean-revocation-process",
      },
    });
    const blocked = store.beginProviderRuntimeAccountRevocation({
      profileId: blockedProfile.id,
      expectedGeneration: blockedProfile.processGeneration,
      provider: "claude",
      runtimeScope: "managed",
      currentAccountKey: null,
      workStore,
    });
    expect(() => store.advanceProfileGeneration(
      blockedProfile.id, blockedProfile.processGeneration,
    )).toThrow("CLAUDE_REVOCATION_PROFILE_ROLLOVER_BLOCKED");
    const carriedProfile = store.advanceProfileGenerationForDaemonShutdown(
      blockedProfile.id,
      blockedProfile.processGeneration,
      workStore,
    ).profile;
    expect(store.requireProfileById(blockedProfile.id).processGeneration)
      .toBe(blockedProfile.processGeneration + 1);
    const carriedRevocation = store.readProviderRuntimeAccountRevocation({
      profileId: blockedProfile.id,
      provider: "claude",
      runtimeScope: "managed",
    });
    expect(carriedRevocation).toMatchObject({ profileGeneration: carriedProfile.processGeneration,
      revision: blocked.revocation.revision + 1, state: "releasing" });
    expect(store.readClaudeProcessAuthority({ profileId: retainedProcess.profileId,
      providerThreadId: retainedProcess.providerThreadId, runtimeScope: retainedProcess.runtimeScope })).toEqual(retainedProcess);
    if (carriedRevocation === null) throw new Error("Expected carried Claude revocation.");
    expect(() => store.completeProviderRuntimeAccountRevocation({ profileId: blockedProfile.id,
      expectedGeneration: carriedProfile.processGeneration, provider: "claude", runtimeScope: "managed",
      expectedRevision: carriedRevocation.revision })).toThrow("PROVIDER_ACCOUNT_AUTHORITY_REVOCATION_CLAUDE_PROCESS_LIVE");
  });
test("rejects a malformed current Claude authority table without rewriting custody", async () => {
    const { store } = await fixture({ provision: "migrate" });
    const profile = signInProfile(store, "Legacy Claude authority", "legacy-claude@example.com");
    const identities = [
      { pid: 52_001, pidDomain: "darwin" as const, procStart: "legacy-claimed" },
      { pid: 52_002, pidDomain: "darwin" as const, procStart: "legacy-releasing" },
      { pid: 52_003, pidDomain: "darwin" as const, procStart: "legacy-released" },
    ];
    const claimed = identities.map((identity, index) =>
      store.recordClaimedClaudeProcessAuthority({
        providerAuthority: store.requireProviderAccountAuthority(profile.id, "claude"),
        providerThreadId: `legacy-thread-${index}`,
        profileId: profile.id,
        profileGeneration: profile.processGeneration,
        runtimeScope: "managed",
        identity,
      }));
    const releasing = store.beginClaudeProcessAuthorityRelease({
      providerThreadId: claimed[1]?.providerThreadId ?? "",
      profileId: profile.id,
      runtimeScope: "managed",
      expectedRevision: claimed[1]?.revision ?? 0,
      identity: identities[1] ?? identities[0]!,
    });
    const releasedBegin = store.beginClaudeProcessAuthorityRelease({
      providerThreadId: claimed[2]?.providerThreadId ?? "",
      profileId: profile.id,
      runtimeScope: "managed",
      expectedRevision: claimed[2]?.revision ?? 0,
      identity: identities[2] ?? identities[0]!,
    });
    store.completeClaudeProcessAuthorityRelease({
      providerThreadId: releasedBegin.providerThreadId,
      profileId: releasedBegin.profileId,
      runtimeScope: releasedBegin.runtimeScope,
      expectedRevision: releasedBegin.revision,
      identity: releasedBegin.identity,
    });
    expect(releasing.state).toBe("releasing");
    const databasePath = store.paths.database;
    store.close();
    stores.splice(stores.indexOf(store), 1);

    const legacy = new Database(databasePath, { create: false, strict: true });
    try {
      const pristine = snapshotSwitchContainmentForTest(legacy);
      const changedObjects = new Set([
        "session_claude_process_authorities",
        "session_claude_process_authority_session_guard_insert",
        "session_claude_process_authority_session_guard_update",
        "session_claude_process_authority_revision_guard",
        "sessions_claude_process_authority_rebind_guard",
        "session_claude_process_authorities_live_identity",
        "session_claude_process_authorities_session",
        "claude_process_custody_parent",
        "claude_process_unreleased_profile_scope",
        "claude_process_custody_bind",
        "claude_process_custody_delete",
        "claude_process_custody_insert",
        "claude_process_custody_update",
      ]);
      const unrelatedSchema = (schema: typeof pristine.schema) => schema.filter((row) =>
        !changedObjects.has(z.object({ name: z.string() }).parse(row).name));
      // This derivative damages only Claude custody. Platform SQLite defaults
      // must not rename references in unrelated switch guards or foreign keys.
      legacy.exec(`
        PRAGMA foreign_keys=OFF;
        PRAGMA legacy_alter_table=ON;
        BEGIN IMMEDIATE;
        DROP TRIGGER IF EXISTS session_claude_process_authority_session_guard_insert;
        DROP TRIGGER IF EXISTS session_claude_process_authority_session_guard_update;
        DROP TRIGGER IF EXISTS session_claude_process_authority_revision_guard;
        DROP TRIGGER IF EXISTS sessions_claude_process_authority_rebind_guard;
        DROP INDEX IF EXISTS session_claude_process_authorities_live_identity;
        DROP INDEX IF EXISTS session_claude_process_authorities_session;
        DROP INDEX claude_process_custody_parent;
        DROP INDEX claude_process_unreleased_profile_scope;
        DROP TRIGGER claude_process_custody_bind;
        DROP TRIGGER claude_process_custody_delete;
        DROP TRIGGER claude_process_custody_insert;
        DROP TRIGGER claude_process_custody_update;
        ALTER TABLE session_claude_process_authorities
          RENAME TO session_claude_process_authorities_scoped_backup;
        CREATE TABLE session_claude_process_authorities (
          provider_thread_id TEXT PRIMARY KEY,
          profile_id TEXT NOT NULL,
          profile_generation INTEGER NOT NULL,
          runtime_scope TEXT NOT NULL,
          session_id TEXT,
          pid INTEGER NOT NULL,
          pid_domain TEXT NOT NULL,
          proc_start TEXT NOT NULL,
          state TEXT NOT NULL,
          revision INTEGER NOT NULL,
          recorded_at INTEGER NOT NULL,
          released_at INTEGER
        ) STRICT;
        INSERT INTO session_claude_process_authorities
          SELECT provider_thread_id,profile_id,profile_generation,runtime_scope,
            session_id,pid,pid_domain,proc_start,state,revision,recorded_at,released_at
          FROM session_claude_process_authorities_scoped_backup;
        DROP TABLE session_claude_process_authorities_scoped_backup;
        COMMIT;
        PRAGMA legacy_alter_table=OFF;
      `);
      const corrupted = snapshotSwitchContainmentForTest(legacy);
      expect(unrelatedSchema(corrupted.schema)).toEqual(unrelatedSchema(pristine.schema));
      expect(corrupted.version).toEqual(pristine.version);
      const unrelatedRows = (rows: typeof pristine.rows) => rows.filter(({ name }) =>
        name !== "session_claude_process_authorities");
      expect(unrelatedRows(corrupted.rows)).toEqual(unrelatedRows(pristine.rows));
    } finally {
      legacy.close(false);
    }

    expectInertSchemaRefusal(store.paths,
      "STATE_SCHEMA_V39_OBJECT_MISSING:session_claude_process_authorities_live_identity");
    const primaryKey = new Database(databasePath, { readonly: true, strict: true });
    try {
      expect((primaryKey.query(
        "PRAGMA table_info(session_claude_process_authorities)",
      ).all() as { name: string; pk: number }[])
        .filter((column) => column.pk > 0)
        .sort((left, right) => left.pk - right.pk)
        .map((column) => column.name)).toEqual(["provider_thread_id"]);
      expect(primaryKey.query(
        "SELECT state FROM session_claude_process_authorities ORDER BY provider_thread_id",
      ).all()).toEqual([
        { state: "claimed" },
        { state: "releasing" },
        { state: "released" },
      ]);
    } finally {
      primaryKey.close(false);
    }
  });
test.each([false, true])("migrates authentic v40 mixed owners without rewriting history with mismatched identity=%s", async (mismatchedIdentity) => {
    const source = canonicalIdentityAttentionFixtures["canonical40-mixed-owners"];
    const { profile, proven, partial, project, queue, prepared, mutationKey, interaction, workClaim, workTask } = source.retained;
    const migratedAt = 42_000;
      const paths = await canonicalIdentityAttentionArchive("canonical40-mixed-owners");
      const database = new Database(paths.database, { create: false, strict: true });
      try {
        const pristine = canonicalAuthBudgetSnapshot(database);
        expect(database.query("SELECT account_key FROM session_provider_account_authorities WHERE session_id=?")
          .get(partial.id)).toEqual({ account_key: source.retained.providerAccountKey });
        expect(database.query("SELECT state FROM work_attempts WHERE id=?").get(workClaim.attempt.id))
          .toEqual({ state: "claimed" });
        if (mismatchedIdentity) {
          // A labeled adversarial derivative, never claimed to be old writer
          // output. The intact original guard refuses this one-cell edit.
          const corruptKey = `v1:codex:${"f".repeat(64)}`;
          expect(() => database.query("UPDATE session_provider_account_authorities SET account_key=? WHERE session_id=?")
            .run(corruptKey, partial.id)).toThrow("session provider account authority is immutable");
          expect(canonicalAuthBudgetSnapshot(database)).toEqual(pristine);
          withRemovedTestGuards(database, ["session_provider_account_authority_update_guard"], () => {
            database.query("UPDATE session_provider_account_authorities SET account_key=? WHERE session_id=?")
              .run(corruptKey, partial.id);
          });
          const corrupted = canonicalAuthBudgetSnapshot(database);
          expect(corrupted.schema).toEqual(pristine.schema);
          expect(corrupted.version).toEqual(pristine.version);
          expectHistoricalValue({ ...corrupted.rows, session_provider_account_authorities: pristine.rows.session_provider_account_authorities },
            pristine.rows);
          const originalProofs = z.array(z.record(z.string(), z.unknown())).parse(pristine.rows.session_provider_account_authorities);
          expect(corrupted.rows.session_provider_account_authorities).toEqual(originalProofs
            .map((row) => row.session_id === partial.id ? { ...row, account_key: corruptKey } : row));

          // The authentic v40 writer predates the v49 project update guard.
          // Contradictory active-claim project authority must fail before any
          // migration, including quarantine or Work release, can conceal it.
          expect(database.query("SELECT name FROM sqlite_master WHERE name='work_session_project_authority_guard'").get()).toBeNull();
          database.query("UPDATE sessions SET project_id=NULL WHERE id=?").run(partial.id);
          const contradictory = canonicalAuthBudgetSnapshot(database);
          expect(() => new StateStore(paths, { now: () => migratedAt }))
            .toThrow("STATE_SCHEMA_V49_WORK_PROJECT_AUTHORITY_INVALID");
          expect(canonicalAuthBudgetSnapshot(database)).toEqual(contradictory);
          expect(() => new StateStore(paths, { readonly: true }))
            .toThrow("STATE_SCHEMA_MIGRATION_REQUIRED:40:61");
          expect(canonicalAuthBudgetSnapshot(database)).toEqual(contradictory);
          database.query("UPDATE sessions SET project_id=? WHERE id=?").run(project.id, partial.id);
          expect(canonicalAuthBudgetSnapshot(database)).toEqual(corrupted);
        }
        const before = canonicalAuthBudgetSnapshot(database);
        expect(() => new StateStore(paths, { readonly: true })).toThrow("STATE_SCHEMA_MIGRATION_REQUIRED:40:61");
        expect(canonicalAuthBudgetSnapshot(database)).toEqual(before);
        const retained = canonicalAuthBudgetRows(database, Object.keys(before.rows)
          .filter((table) => !["migrations", "sessions", "session_autorespond_counters"].includes(table)));
        const sessions = canonicalAuthBudgetRows(database, ["sessions"]);
        const expectedSessions = z.array(z.record(z.string(), z.unknown())).parse(sessions.before.sessions)
          .map((row) => row.id === partial.id ? { ...row, state: "recovery_required",
            revision: z.number().parse(row.revision) + 1, updated_at: migratedAt } : row);
        const store = new StateStore(paths, { now: () => migratedAt });
        stores.push(store);
        expect(retained.read()).toEqual(retained.before);
        expect(sessions.read().sessions).toEqual(expectedSessions);
        expect(before.rows.session_autorespond_counters).toEqual([]);
        expect(database.query("SELECT * FROM session_autorespond_counters ORDER BY session_id").all())
          .toEqual([proven.id, partial.id].sort().map((session_id) =>
            ({ session_id, consecutive_count: 3, updated_at: migratedAt })));
        expect(store.sessionAccountAuthorityMatches(proven.id, profile.id)).toBe(true);
        expect(store.sessionAccountAuthorityMatches(partial.id, profile.id)).toBe(!mismatchedIdentity);
        expect(store.readSessionProviderAccountAuthority(partial.id)?.accountKey)
          .toBe(mismatchedIdentity ? `v1:codex:${"f".repeat(64)}` : source.retained.providerAccountKey);
        expect(store.requireCapturedSessionProviderAuthority(proven.id)).toMatchObject({
          profileId: profile.id, provider: "codex", processGeneration: profile.processGeneration,
        });
        expect(() => store.requireCapturedSessionProviderAuthority(partial.id))
          .toThrow("SESSION_PROVIDER_AUTHORITY_QUARANTINED:missing_immutable_runtime_authority");
        expect(store.requireQueue(queue.id)).toMatchObject({ state: "pending", message: queue.message });
        expect(store.hasUnsettledQueueAttachmentQuarantineForSession(partial.id)).toBe(true);
        expect(store.nextPendingQueue(partial.id)).toBeNull();
        expect(store.readMutation(mutationKey)?.state).toBe("prepared");
        expect(database.query("SELECT status FROM session_tasks WHERE id=?").get(source.retained.sessionTask.id))
          .toEqual({ status: "active" });
        expect(() => store.requireInteraction(interaction.publicId)).toThrow("INTERACTION_PROVIDER_AUTHORITY_MISSING");
        expect(database.query("SELECT * FROM interaction_provider_authorities").all()).toEqual([]);
        expect(database.query("SELECT * FROM mutation_provider_authorities WHERE attempt_id=?").all(prepared.id)).toEqual([]);
        expect(database.query("SELECT * FROM session_provider_authorities WHERE session_id=?").all(partial.id)).toEqual([]);
        expect(database.query("SELECT * FROM migrations WHERE version<=40 ORDER BY version").all()).toEqual([...source.ledger]);
        expect(database.query("SELECT version FROM migrations ORDER BY version").all())
          .toEqual(Array.from({ length: 61 }, (_, index) => ({ version: index + 1 })));
        expect(database.query("PRAGMA user_version").get()).toEqual({ user_version: 61 });
        const joined = canonicalAuthBudgetSnapshot(database);
        expect(() => store.requireSessionProviderAuthority(partial.id))
          .toThrow("SESSION_PROVIDER_AUTHORITY_QUARANTINED:missing_immutable_runtime_authority");
        expect(() => store.transitionQueue(queue.id, "pending", "dispatching")).toThrow();
        expect(canonicalAuthBudgetSnapshot(database)).toEqual(joined);
        expectCanonical35To38InertReopens(paths, database);

        // A later live Work read owns its documented recovery sweep. It is
        // separate from migration, and may release the old claim without
        // dispatching it or inventing a receipt.
        const workStore = store.createWorkStore(source.retained.daemonGeneration, () => "unused-history-cursor", {
          issue: () => { throw new Error("HISTORICAL_WORK_READ_MUST_NOT_ISSUE_CAPABILITY"); },
          verify: () => false,
        });
        const beforeWorkRead = canonicalAuthBudgetRows(database, ["queue_entries", "mutation_attempts",
          "mutation_effect_evidence", "mutation_resolutions", "session_tasks", "provider_interactions",
          "session_provider_account_authorities", "session_runtime_profiles", "work_prepared_effects",
          "work_nested_effect_settlements", "work_effect_resolutions", "work_idempotency_intents"]);
        expect(workStore.task(workTask.id).activeAttempt).toBeNull();
        expect(database.query("SELECT state,revision FROM work_attempts WHERE id=?").get(workClaim.attempt.id))
          .toEqual({ state: "released", revision: workClaim.attempt.revision + 1 });
        expect(beforeWorkRead.read()).toEqual(beforeWorkRead.before);
        expect(database.query("SELECT * FROM work_prepared_effects").all()).toEqual([]);
        expect(database.query("SELECT * FROM mutation_effect_evidence").all()).toEqual([]);
        expect(database.query("PRAGMA foreign_key_check").all()).toEqual([]);
        expectCanonical35To38InertReopens(paths, database);
      } finally { database.close(false); }
  });
test("authentic v34 unbound session remains without native account proof", async () => {
    // The separate real v34 image proves pre-adoption sessions do not acquire
    // native account proof just because their profile was signed in.
    const legacyPaths = await canonical34StorageArchive();
    const legacySource = canonical34StorageFixture.retained;
    const migrated = new StateStore(legacyPaths, { now: () => 42_000 });
    stores.push(migrated);
    expect(migrated.sessionAccountAuthorityMatches(legacySource.unboundSession.id, legacySource.profile.id)).toBe(false);
    expect(migrated.requireSession(legacySource.unboundSession.id).state).toBe("recovery_required");
    expect(migrated.readSessionProviderAccountAuthority(legacySource.unboundSession.id)).toBeNull();
    expect(() => migrated.requireCapturedSessionProviderAuthority(legacySource.unboundSession.id))
      .toThrow("SESSION_PROVIDER_AUTHORITY_QUARANTINED:missing_immutable_runtime_authority");
    const legacyInspector = new Database(legacyPaths.database, { readonly: true, strict: true });
    try {
      expect(legacyInspector.query("PRAGMA foreign_key_check").all()).toEqual([]);
      expectCanonical35To38InertReopens(legacyPaths, legacyInspector);
    } finally { legacyInspector.close(false); }
  });
test("synthetic adoption-v36 contract quarantines malformed Claude scope and revoked authority without inventing effects", async () => {
    const paths = await syntheticAdoption36ContractFixture("quarantine");
    const source = syntheticAdoption36;
    const database = new Database(paths.database, { create: false, strict: true });
    try {
      const pristine = canonicalAuthBudgetSnapshot(database);
      const guard = z.object({ sql: z.string() }).strict().parse(database.query(
        "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='session_provider_account_authority_update_guard'",
      ).get());
      expect(() => database.query(
        "UPDATE session_provider_account_authorities SET runtime_scope='personal' WHERE session_id=?",
      ).run(source.malformedSessionId)).toThrow("session provider account authority is immutable");
      expect(canonicalAuthBudgetSnapshot(database)).toEqual(pristine);

      // Explicit adversarial mutation of synthetic recognizer input, NOT a
      // historical writer output. Restore the exact guard before admission.
      database.exec("DROP TRIGGER session_provider_account_authority_update_guard");
      database.query(
        "UPDATE session_provider_account_authorities SET runtime_scope='personal' WHERE session_id=?",
      ).run(source.malformedSessionId);
      database.exec(guard.sql);
      database.query(`INSERT INTO provider_runtime_account_revocations(
        profile_id,profile_generation,provider,runtime_scope,current_account_key,
        state,revision,created_at,updated_at,completed_at
      ) VALUES (?,1,'claude','managed',NULL,'completed',1,?,?,?)`)
        .run(source.invalidProfileId, source.fixedTime, source.fixedTime, source.fixedTime);
      const damaged = canonicalAuthBudgetSnapshot(database);
      expect(damaged.schema).toEqual(pristine.schema);
      expect(damaged.version).toEqual(pristine.version);
      expect(database.query("PRAGMA foreign_key_check").all()).toEqual([]);
      const changedTables = new Set(["session_provider_account_authorities", "provider_runtime_account_revocations"]);
      for (const [table, rows] of Object.entries(pristine.rows)) {
        if (!changedTables.has(table)) expect(damaged.rows[table]).toEqual(rows);
      }
      expect(database.query("SELECT session_id,runtime_scope FROM session_provider_account_authorities ORDER BY session_id").all())
        .toEqual([
          { session_id: source.malformedSessionId, runtime_scope: "personal" },
          { session_id: source.revokedSessionId, runtime_scope: "managed" },
          { session_id: source.unaffectedSessionId, runtime_scope: "managed" },
        ]);
      const mutableTables = new Set(["migrations", "sessions", "session_provider_account_authorities",
        "session_account_authorities", "mutation_attempts", "session_tasks"]);
      const unchanged = canonicalAuthBudgetRows(database, Object.keys(damaged.rows)
        .filter((table) => !mutableTables.has(table) && !syntheticAdoption36MaintenanceTables.has(table)));
      const oldRows = canonicalAuthBudgetRows(database,
        ["session_provider_account_authorities", "session_account_authorities", "mutation_attempts", "session_tasks"]);
      const oldSessions = z.array(z.record(z.string(), z.unknown())).parse(database.query("SELECT * FROM sessions ORDER BY id").all());
      expect(() => { new StateStore(paths, { readonly: true }).close(); })
        .toThrow("STATE_SCHEMA_MIGRATION_REQUIRED:36:61");
      expect(canonicalAuthBudgetSnapshot(database)).toEqual(damaged);

      const repaired = new StateStore(paths, { now: () => source.migratedAt, resolveMachineTimeZone: () => "UTC" });
      stores.push(repaired);
      expect(repaired.sessionAccountAuthorityMatches(source.unaffectedSessionId, source.unaffectedProfileId)).toBe(true);
      expect(repaired.readSessionProviderAccountAuthority(source.unaffectedSessionId)).not.toBeNull();
      expect(repaired.requireSession(source.unaffectedSessionId).state).toBe("idle");
      for (const id of [source.malformedSessionId, source.revokedSessionId]) {
        expect(repaired.sessionAccountAuthorityMatches(id, source.invalidProfileId)).toBe(false);
        expect(repaired.readSessionProviderAccountAuthority(id)).toBeNull();
        expect(repaired.requireSession(id).state).toBe("recovery_required");
      }
      expect(repaired.requireQueue(source.queueId)).toMatchObject({ state: "pending", message: source.queueMessage });
      expect(repaired.hasUnsettledQueueAttachmentQuarantineForSession(source.malformedSessionId)).toBe(true);
      expect(repaired.nextPendingQueue(source.malformedSessionId)).toBeNull();
      expect(repaired.readMutation(source.mutationKey)?.state).toBe("cancelled");
      expect(database.query("SELECT result_json FROM mutation_attempts WHERE id=?").get(source.mutationId))
        .toEqual({ result_json: null });
      expect(repaired.createSessionTaskStore().list(source.malformedSessionId)
        .find((task) => task.id === source.taskId)).toMatchObject({ status: "paused", nextDueAt: null, revision: 2 });
      expect(() => repaired.requireInteraction(source.interactionId))
        .toThrow("INTERACTION_PROVIDER_AUTHORITY_MISSING");
      expect(database.query("SELECT state,display_json FROM provider_interactions WHERE public_id=?")
        .get(source.interactionId)).toEqual({ state: "pending", display_json: JSON.stringify(source.display) });
      expect(database.query("SELECT * FROM interaction_provider_authorities").all()).toEqual([]);
      expect(database.query("SELECT reason FROM legacy_provider_authority_quarantines WHERE scope_kind='interaction' AND scope_id=?")
        .get(source.interactionId)).toEqual({ reason: "unsettled_provider_authority_unproved" });

      // Exact old-column accounting: only the documented invalid-native-proof
      // removal and quarantine transitions may change these synthetic rows.
      expect(unchanged.read()).toEqual(unchanged.before);
      expectSyntheticAdoption36Maintenance(database, damaged,
        [source.malformedSessionId, source.revokedSessionId, source.unaffectedSessionId],
        [source.invalidProfileId, source.unaffectedProfileId]);
      const recordRows = (table: string) => z.array(z.record(z.string(), z.unknown())).parse(oldRows.before[table]);
      expect(oldRows.read()).toEqual({
        session_provider_account_authorities: recordRows("session_provider_account_authorities")
          .filter((row) => row.session_id === source.unaffectedSessionId),
        session_account_authorities: recordRows("session_account_authorities")
          .map((row) => row.session_id === source.unaffectedSessionId ? row : { ...row, account_key: null }),
        mutation_attempts: recordRows("mutation_attempts")
          .map((row) => ({ ...row, state: "cancelled", updated_at: source.migratedAt })),
        session_tasks: recordRows("session_tasks")
          .map((row) => ({ ...row, status: "paused", revision: 2, next_due_at: null, updated_at: source.migratedAt })),
      });
      const currentSessions = z.array(z.record(z.string(), z.unknown())).parse(database.query("SELECT * FROM sessions ORDER BY id").all());
      expect(currentSessions.map((row, index) => Object.fromEntries(Object.keys(oldSessions[index] ?? {}).map((key) =>
        [key, row[key === "provider" ? "provider_v39" : key]]))))
        .toEqual(oldSessions.map((row) => row.id === source.unaffectedSessionId ? row
          : { ...row, state: "recovery_required", revision: 2, updated_at: source.migratedAt }));
      expect(database.query("SELECT * FROM migrations WHERE version<=36 ORDER BY version").all())
        .toEqual(Array.from({ length: 36 }, (_, index) => ({ version: index + 1, applied_at: source.fixedTime })));
      expect(database.query("PRAGMA user_version").get()).toEqual({ user_version: 61 });
      // Even the unaffected legacy account row is not a new execution proof.
      const beforeAuthorityRead = canonicalAuthBudgetSnapshot(database);
      expect(database.query("SELECT * FROM session_provider_authorities").all()).toEqual([]);
      for (const id of [source.malformedSessionId, source.revokedSessionId, source.unaffectedSessionId]) {
        expect(() => repaired.requireSessionProviderAuthority(id))
          .toThrow("SESSION_PROVIDER_AUTHORITY_QUARANTINED:missing_immutable_runtime_authority");
      }
      expect(canonicalAuthBudgetSnapshot(database)).toEqual(beforeAuthorityRead);
      for (const table of ["session_runtime_profiles", "mutation_effect_evidence", "queue_effect_evidence",
        "session_claude_process_authorities", "session_personal_runtime_bindings"]) {
        expect(database.query(`SELECT * FROM ${table}`).all()).toEqual([]);
      }
      expectCanonical35To38InertReopens(paths, database);
    } finally { database.close(false); }
  });
test("rejects a malformed current adoption candidate table without releasing fences", async () => {
    const { store } = await fixture({ provision: "migrate" });
    const candidate = store.upsertSessionAdoptionCandidate({
      provider: "claude",
      providerThreadId: "legacy-v35-candidate",
      title: "Legacy v35 candidate",
      state: "terminal",
      providerUpdatedAt: 10,
      liveness: "not_live",
    });
    const databasePath = store.paths.database;
    store.close();
    stores.splice(stores.indexOf(store), 1);

    const legacy = new Database(databasePath, { create: false, strict: true });
    try {
      legacy.query(
        `UPDATE session_adoption_candidates
         SET claim_status='fenced',fenced_fingerprint=candidate_fingerprint,
           revision=revision+1
         WHERE provider=? AND provider_thread_id=?`,
      ).run(candidate.provider, candidate.providerThreadId);
      legacy.exec(`
        PRAGMA foreign_keys=OFF;
        PRAGMA legacy_alter_table=ON;
        BEGIN IMMEDIATE;
        DROP TRIGGER IF EXISTS session_adoption_candidate_identity_immutable;
        DROP TRIGGER IF EXISTS session_adoption_candidate_revision_guard;
        DROP TRIGGER IF EXISTS session_adoption_candidate_source_identity_guard_insert;
        DROP TRIGGER IF EXISTS session_adoption_candidate_source_identity_guard_update;
        DROP INDEX IF EXISTS session_adoption_candidates_pending;
        DROP INDEX IF EXISTS session_adoption_candidates_claude_reprobe;
        ALTER TABLE session_adoption_candidates
          RENAME TO session_adoption_candidates_v35_early;
        CREATE TABLE session_adoption_candidates (
          provider TEXT NOT NULL CHECK(provider IN ('codex','claude')),
          provider_thread_id TEXT NOT NULL CHECK(length(provider_thread_id) BETWEEN 1 AND 200),
          project_id TEXT,
          title TEXT NOT NULL CHECK(length(CAST(title AS BLOB)) BETWEEN 1 AND 320),
          provider_state TEXT NOT NULL CHECK(provider_state IN ('active','idle','terminal')),
          active_turn_id TEXT CHECK(active_turn_id IS NULL OR length(active_turn_id) BETWEEN 1 AND 2048),
          provider_updated_at REAL CHECK(provider_updated_at IS NULL OR provider_updated_at >= 0),
          liveness TEXT NOT NULL CHECK(liveness IN ('live','not_live','unknown')),
          claim_status TEXT NOT NULL CHECK(claim_status IN ('pending','claiming','adopted','fenced')),
          candidate_fingerprint TEXT NOT NULL CHECK(length(candidate_fingerprint)=64 AND candidate_fingerprint GLOB '[0-9a-f]*'),
          fenced_fingerprint TEXT CHECK(fenced_fingerprint IS NULL OR (length(fenced_fingerprint)=64 AND fenced_fingerprint GLOB '[0-9a-f]*')),
          revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
          first_discovered_at INTEGER NOT NULL CHECK(first_discovered_at >= 0),
          last_observed_at INTEGER NOT NULL CHECK(last_observed_at >= first_discovered_at),
          last_changed_at INTEGER NOT NULL CHECK(last_changed_at BETWEEN first_discovered_at AND last_observed_at),
          last_attempt_at INTEGER CHECK(last_attempt_at IS NULL OR last_attempt_at >= first_discovered_at),
          PRIMARY KEY(provider,provider_thread_id),
          CHECK(
            (claim_status='fenced' AND fenced_fingerprint IS NOT NULL)
            OR (claim_status!='fenced' AND fenced_fingerprint IS NULL)
          )
        ) STRICT;
        INSERT INTO session_adoption_candidates(
          provider,provider_thread_id,project_id,title,provider_state,
          active_turn_id,provider_updated_at,liveness,claim_status,
          candidate_fingerprint,fenced_fingerprint,revision,
          first_discovered_at,last_observed_at,last_changed_at,last_attempt_at
        )
        SELECT provider,provider_thread_id,project_id,title,provider_state,
          active_turn_id,provider_updated_at,liveness,claim_status,
          candidate_fingerprint,fenced_fingerprint,revision,
          first_discovered_at,last_observed_at,last_changed_at,last_attempt_at
        FROM session_adoption_candidates_v35_early;
        DROP TABLE session_adoption_candidates_v35_early;
        COMMIT;
        PRAGMA legacy_alter_table=OFF;
      `);
    } finally {
      legacy.close(false);
    }

    expect(() => new StateStore(store.paths))
      .toThrow("STATE_SCHEMA_V39_OBJECT_MISSING:session_adoption_candidates_claude_reprobe");
    const inspector = new Database(databasePath, { readonly: true, strict: true });
    try {
      const candidateColumns = inspector.query(
        "PRAGMA table_info(session_adoption_candidates)",
      ).all() as Array<{ name: string }>;
      const candidateColumnNames = candidateColumns.map((column) => column.name);
      for (const name of [
        "source_pid",
        "source_pid_domain",
        "source_proc_start",
        "last_live_observed_at",
        "provider_project_root",
      ]) {
        expect(candidateColumnNames.includes(name)).toBe(false);
      }
      expect(inspector.query(
        `SELECT claim_status,fenced_fingerprint FROM session_adoption_candidates
         WHERE provider=? AND provider_thread_id=?`,
      ).get(candidate.provider, candidate.providerThreadId)).toMatchObject({
        claim_status: "fenced",
      });
    } finally {
      inspector.close(false);
    }
  });
test("keeps session recovery absorbing across passive and exact-state reconciliation", async () => {
    const { store } = await fixture();
    const profile = signInProfile(store, "Recovery", "recovery@example.com");
    const local = store.createSession({ profileId: profile.id, preset: "high", fastEnabled: false });
    const bound = store.bindSession({
      sessionId: local.id,
      expectedRevision: local.revision,
      providerThreadId: "thread-recovery",
      state: "idle",
      providerUpdatedAt: 10,
    });
    const quarantined = store.quarantineSession(bound.id);
    expect(quarantined).toMatchObject({ state: "recovery_required", providerUpdatedAt: 10 });

    const passive = store.upsertProviderSession({
      providerAuthority: store.requireProviderAccountAuthority(profile.id, "codex"),
      profileId: profile.id,
      provider: "codex",
      providerThreadId: "thread-recovery",
      preset: "high",
      fastEnabled: false,
      title: "Passive projection",
      state: "active",
      activeTurnId: "turn-passive",
      providerUpdatedAt: 11,
      providerAccountKey: providerAccountKeyForProfile(store, profile.id, "codex"),
    });
    expect(passive).toMatchObject({ state: "recovery_required", title: "Untitled session", revision: quarantined.revision });

    expect(store.reconcileSessionFromProvider({ sessionId: quarantined.id, state: "active", activeTurnId: "turn-exact", title: "Exact projection" })).toEqual(quarantined);
    expect(() => store.resolveSessionStatusRecovery({
      sessionId: quarantined.id,
      expectedRevision: quarantined.revision,
      resolution: "provider_state_reconciled",
      provider: {
        providerThreadId: "thread-recovery",
        title: "Missing active turn",
        status: "active",
        providerUpdatedAt: 12,
      },
    })).toThrow("SESSION_STATUS_RECOVERY_ACTIVE_TURN_MISSING");
    expect(store.requireSession(quarantined.id)).toEqual(quarantined);
  });
test("explicit session abandonment settles pending queue transcript and attachment custody", async () => {
    const { store } = await fixture();
    const daemon = startInputFixtureDaemon(store);
    const profile = signInProfile(store, "Recovery abandonment", "recovery-abandon@example.com");
    const session = createProvenTestSession(store, {
      fastEnabled: false,
      preset: "high",
      profileId: profile.id,
      state: "idle",
    });
    const attachment = {
      byteLength: 4,
      canonicalMediaType: "text/plain" as const,
      digest: "b".repeat(64),
      mediaType: "text/plain" as const,
      name: "recovery-abandon.txt",
    };
    const queued = enqueueAttachedTestQueue(store, daemon, {
      providerAuthority: capturedProviderAuthorityForTest(store, session.id),
      attachments: [{
        byteLength: attachment.byteLength,
        digest: attachment.digest,
        mediaType: attachment.mediaType,
        name: attachment.name,
      }],
      idempotencyKey: "00000000-0000-4000-8000-00000000060a",
      message: "do not dispatch after explicit abandonment",
      profileGeneration: profile.processGeneration,
      sessionId: session.id,
      storedAttachments: [attachment],
    });
    const quarantined = store.quarantineSession(session.id);
    expect(store.hasPendingSessionUserMessageFinalization(session.id)).toBe(false);
    expect(store.readSessionUserMessageSource(session.id, "queue", queued.id))
      .toMatchObject({ status: "pending" });

    expect(store.resolveSessionStatusRecovery({
      expectedRevision: quarantined.revision,
      resolution: "abandoned",
      sessionId: session.id,
    })).toMatchObject({ state: "terminal" });

    expect(store.requireQueue(queued.id)).toMatchObject({ state: "cancelled" });
    expect(store.readSessionUserMessageSource(session.id, "queue", queued.id)).toEqual({
      status: "abandoned",
      intent: { version: 1, actor: "human", hadAttachments: true },
    });
    expect(store.hasPendingSessionUserMessageFinalization(session.id)).toBe(false);
    expect(store.messageAttachmentManifest(session.id, queued.id)).toEqual([]);
    expect(store.attachmentCustody(attachment.digest)).toMatchObject({ referenceCount: 0 });
  });
test("deletes only exact unbound and evidence-free starting sessions", async () => {
    const { store, home } = await fixture();
    const profile = signInProfile(store, "Cleanup", "cleanup@example.com");
    const removable = store.createSession({
      profileId: profile.id,
      preset: "high",
      fastEnabled: false,
    });
    expect(store.deleteUnboundStartingSession(removable.id, removable.revision + 1)).toBe(false);
    expect(store.deleteUnboundStartingSession(removable.id, removable.revision)).toBe(true);
    expect(() => store.requireSession(removable.id)).toThrow(SelectionError);

    const bound = store.createSession({ profileId: profile.id, preset: "high", fastEnabled: false });
    store.bindSession({
      sessionId: bound.id,
      expectedRevision: bound.revision,
      providerThreadId: "thread-bound",
      state: "idle",
    });
    expect(store.deleteUnboundStartingSession(bound.id, bound.revision)).toBe(false);

    const projectRoot = join(home, "starting-queue-evidence");
    await mkdir(projectRoot);
    const project = await store.createProject("Starting queue evidence", projectRoot);
    const startAttempt = store.prepareMutation({
      kind: "session.start",
      authorityId: profile.id,
      authorityGeneration: profile.processGeneration,
      request: sessionStartMutationRequest({
        projectId: project.id,
        provider: "codex",
        preset: "high",
        presetContract: currentPresetContract,
        fast: false,
      }),
      idempotencyKey: "00000000-0000-4000-8000-0000000006c0",
    });
    const queued = store.beginSessionStartEffect({
      provider: "codex",
      providerAuthority: store.requireProviderAccountAuthority(profile.id, "codex"),
      attemptId: startAttempt.id,
      profileId: profile.id,
      profileGeneration: profile.processGeneration,
      projectId: project.id,
      preset: "high",
      fastEnabled: false,
      providerAccountKey: providerAccountKeyForProfile(store, profile.id, "codex"),
      evidence: {
        kind: "session.start",
        projectId: project.id,
        clientMessageId: null,
        messageDigest: null,
        presetContract: currentPresetContract,
      },
    });
    store.enqueue(queued.id, "retained queue evidence");
    expect(store.deleteUnboundStartingSession(queued.id, queued.revision)).toBe(false);

    const summarized = store.createSession({ profileId: profile.id, preset: "high", fastEnabled: false });
    const database = new Database(store.paths.database, { create: false, strict: true });
    try {
      database
        .query("INSERT INTO turn_summaries(session_id,turn_id,sequence,summary_json,created_at) VALUES (?,?,?,?,?)")
        .run(summarized.id, "turn-1", 0, "{}", 1_000);
    } finally {
      database.close(false);
    }
    expect(store.deleteUnboundStartingSession(summarized.id, summarized.revision)).toBe(false);
  });
test("persists idempotent mutation receipts and rejects changed reuse", async () => {
    const { store } = await fixture();
    const key = "b83efca6-d731-498e-ac2c-876555a4ae2d";
    const first = store.prepareMutation({ kind: "turn.start", authorityId: "session", authorityGeneration: 1, request: { message: "hello" }, idempotencyKey: key });
    expect(first.replay).toBe(false);
    expect(store.transitionMutation(first.id, "prepared", "effect_started")).toBe(true);
    expect(store.transitionMutation(first.id, "effect_started", "applied", { turnId: "turn-1" })).toBe(true);
    expect(store.prepareMutation({ kind: "turn.start", authorityId: "session", authorityGeneration: 1, request: { message: "hello" }, idempotencyKey: key })).toMatchObject({ replay: true, state: "applied", result: { turnId: "turn-1" } });
    expect(() => store.prepareMutation({ kind: "turn.start", authorityId: "session", authorityGeneration: 1, request: { message: "changed" }, idempotencyKey: key })).toThrow("IDEMPOTENCY_CONFLICT");
  });
test("leaves a crash before effect dispatch replayable without quarantining its authority", async () => {
    const { store } = await fixture();
    const daemon = startInputFixtureDaemon(store);
    const profile = signInProfile(store, "Prepared crash", "prepared@example.com");
    const local = store.createSession({ profileId: profile.id, preset: "high", fastEnabled: false });
    const session = store.bindSession({ sessionId: local.id, expectedRevision: local.revision, providerThreadId: "thread-prepared", state: "idle", providerUpdatedAt: 5 });
    const input = { kind: "session.send", sessionId: session.id, providerAuthority: store.requireProviderAccountAuthority(profile.id, "codex"),
      ...daemon, message: "prepared", attachments: [], idempotencyKey: "00000000-0000-4000-8000-000000000609" } as const;
    const { attempt } = store.prepareSessionInputMutation(input);
    expect(attempt).toMatchObject({ state: "prepared", replay: false });
    expect(store.recoverEffectStartedMutations()).toEqual({ recovered: [], unresolved: [] });
    expect(store.requireSession(session.id)).toMatchObject({ state: "idle" });
    expect(store.prepareSessionInputMutation(input).attempt).toMatchObject({ id: attempt.id, state: "prepared", replay: true });
  });
test("fences one-shot Claude login grants and settles the exact joined outcome", async () => {
    const { store } = await fixture();
    const created = store.createProfile("Claude auth");
    const profile = store.nextProfileGeneration(created.id);
    const claude = store.requireProviderAccountAuthority(profile.id, "claude");
    const key = "00000000-0000-4000-8000-000000000611";
    const attempt = store.prepareMutation({
      kind: "account.claude-login",
      authorityId: profile.id,
      authorityGeneration: claude.processGeneration,
      request: { provider: "claude" },
      providerAuthorities: [{ role: "primary", authority: claude, provenance: "account_claude_login" }],
      idempotencyKey: key,
    });
    store.beginClaudeLoginMutationEffect({
      attemptId: attempt.id,
      profileId: profile.id,
      profileGeneration: claude.processGeneration,
      evidence: { kind: "account.claude-login", provider: "claude", baselineSignedIn: false },
    });
    expect(store.readMutation(key)).toMatchObject({
      id: attempt.id,
      state: "effect_started",
      evidence: { evidence: { kind: "account.claude-login", provider: "claude" } },
    });
    expect(store.providerAuthorityAdvanceBlocker(profile.id, "claude"))
      .toBe("unsettled_authority");
    expect(store.nextProfileGeneration(profile.id).processGeneration)
      .toBe(profile.processGeneration + 1);
    expect(store.requireProviderAccountAuthority(profile.id, "claude")).toEqual(claude);
    expect(() => store.prepareMutation({
      kind: "account.claude-login",
      authorityId: profile.id,
      authorityGeneration: claude.processGeneration,
      request: { provider: "claude" },
      providerAuthorities: [{ role: "primary", authority: claude, provenance: "account_claude_login" }],
      idempotencyKey: "00000000-0000-4000-8000-000000000612",
    })).toThrow("UNSETTLED_MUTATION_AUTHORITY");

    expect(() => store.settleClaudeLoginMutation({
      attemptId: attempt.id,
      idempotencyKey: key,
      profileId: profile.id,
      profileGeneration: claude.processGeneration,
      signedIn: true,
      outcome: { state: "joined", exitCode: 0, interruptedBy: null },
    })).not.toThrow();
    expect(store.readMutation(key)).toMatchObject({ state: "applied" });
    expect(store.providerAuthorityAdvanceBlocker(profile.id, "claude")).toBeNull();
  });
test("restart preserves a generation-zero CLI-owned Claude child launch and keeps its one-time grant", async () => {
    const { store, home } = await fixture();
    const profile = store.createProfile("Claude crash");
    const pristine = store.createProfile("Pristine signed out");
    const claude = store.requireProviderAccountAuthority(profile.id, "claude");
    const key = "00000000-0000-4000-8000-000000000613";
    const attempt = store.prepareMutation({
      kind: "account.claude-login",
      authorityId: profile.id,
      authorityGeneration: claude.processGeneration,
      request: { provider: "claude" },
      providerAuthorities: [{ role: "primary", authority: claude, provenance: "account_claude_login" }],
      idempotencyKey: key,
    });
    store.beginClaudeLoginMutationEffect({
      attemptId: attempt.id,
      profileId: profile.id,
      profileGeneration: claude.processGeneration,
      evidence: { kind: "account.claude-login", provider: "claude", baselineSignedIn: false },
    });
    store.close();

    const restarted = new StateStore(
      resolveStatePaths({ homeDirectory: home, platform: "darwin" }),
      { now: () => 2_000 },
    );
    stores.push(restarted);
    expect(restarted.nextDaemonGeneration(`boot_${"0".repeat(32)}`)).toBe(1);
    expect(restarted.requireProfile(profile.id)).toMatchObject({
      state: "signed_out",
      processGeneration: 0,
    });
    expect(restarted.requireProviderAccountAuthority(profile.id, "claude").processGeneration)
      .toBe(0);
    expect(restarted.requireProfile(pristine.id)).toMatchObject({
      state: "signed_out",
      processGeneration: 0,
    });
    expect(restarted.recoverEffectStartedMutations()).toEqual({ recovered: [attempt.id], unresolved: [] });
    expect(restarted.readMutation(key)).toMatchObject({ state: "ambiguous" });
    expect(restarted.providerAuthorityAdvanceBlocker(profile.id, "claude"))
      .toBe("unsettled_authority");
    expect(restarted.settleClaudeLoginMutation({
      attemptId: attempt.id,
      idempotencyKey: key,
      profileId: profile.id,
      profileGeneration: 0,
      signedIn: false,
      outcome: { state: "joined", exitCode: 1, interruptedBy: null },
    })).toMatchObject({ providerGeneration: 0, signedIn: false });
    expect(restarted.providerAuthorityAdvanceBlocker(profile.id, "claude")).toBeNull();
  });
test("reopens across daemon generation advance and resolves the exact historical Claude launch", async () => {
    const { store, home } = await fixture();
    const created = store.createProfile("Claude historical child");
    const profile = store.nextProfileGeneration(created.id);
    const claude = store.requireProviderAccountAuthority(profile.id, "claude");
    const key = "00000000-0000-4000-8000-000000000614";
    const attempt = store.prepareMutation({
      kind: "account.claude-login",
      authorityId: profile.id,
      authorityGeneration: claude.processGeneration,
      request: { provider: "claude" },
      providerAuthorities: [{ role: "primary", authority: claude, provenance: "account_claude_login" }],
      idempotencyKey: key,
    });
    store.beginClaudeLoginMutationEffect({
      attemptId: attempt.id,
      profileId: profile.id,
      profileGeneration: claude.processGeneration,
      evidence: { kind: "account.claude-login", provider: "claude", baselineSignedIn: false },
    });
    store.close();

    const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
    const firstRestart = new StateStore(paths, { now: () => 2_000 });
    stores.push(firstRestart);
    expect(firstRestart.nextDaemonGeneration(`boot_${"e".repeat(32)}`)).toBe(1);
    expect(firstRestart.requireProfileById(profile.id).processGeneration)
      .toBe(profile.processGeneration + 1);
    expect(firstRestart.recoverEffectStartedMutations()).toEqual({
      recovered: [attempt.id],
      unresolved: [],
    });
    expect(firstRestart.readMutation(key)).toMatchObject({ state: "ambiguous" });
    firstRestart.close();

    const restarted = new StateStore(paths, { now: () => 3_000 });
    stores.push(restarted);
    expect(restarted.nextDaemonGeneration(`boot_${"f".repeat(32)}`)).toBe(2);
    expect(restarted.requireProfileById(profile.id).processGeneration)
      .toBe(profile.processGeneration + 2);
    expect(restarted.recoverEffectStartedMutations()).toEqual({ recovered: [], unresolved: [] });
    expect(restarted.readMutation(key)).toMatchObject({ state: "ambiguous" });
    expect(restarted.providerAuthorityAdvanceBlocker(profile.id, "claude"))
      .toBe("unsettled_authority");
    const completion = {
      attemptId: attempt.id,
      idempotencyKey: key,
      profileId: profile.id,
      profileGeneration: claude.processGeneration,
      signedIn: true,
      outcome: { state: "joined" as const, exitCode: 0, interruptedBy: null },
    };
    expect(restarted.settleClaudeLoginMutation(completion)).toMatchObject({
      accountId: profile.id,
      providerGeneration: claude.processGeneration,
      signedIn: true,
    });
    expect(restarted.readMutation(key)).toMatchObject({
      state: "reconciled",
      originalState: "ambiguous",
      resolution: { kind: "proven_applied" },
    });
    expect(restarted.settleClaudeLoginMutation(completion)).toMatchObject({
      signedIn: true,
    });
    expect(restarted.providerAuthorityAdvanceBlocker(profile.id, "claude")).toBeNull();
  });
test("requires exact live Claude authority for idempotent acknowledged local abandon", async () => {
    const { store } = await fixture();
    const profile = store.createProfile("Claude local abandon");
    const claude = store.requireProviderAccountAuthority(profile.id, "claude");
    const key = "00000000-0000-4000-8000-000000000615";
    const attempt = store.prepareMutation({
      kind: "account.claude-login",
      authorityId: profile.id,
      authorityGeneration: claude.processGeneration,
      request: { provider: "claude" },
      providerAuthorities: [{ role: "primary", authority: claude, provenance: "account_claude_login" }],
      idempotencyKey: key,
    });
    store.beginClaudeLoginMutationEffect({
      attemptId: attempt.id,
      profileId: profile.id,
      profileGeneration: claude.processGeneration,
      evidence: { kind: "account.claude-login", provider: "claude", baselineSignedIn: false },
    });
    const abandon = {
      attemptId: attempt.id,
      idempotencyKey: key,
      profileId: profile.id,
      profileGeneration: claude.processGeneration,
      acknowledgeChildExited: true as const,
    };
    expect(() => store.abandonClaudeLoginMutation({
      ...abandon,
      profileGeneration: claude.processGeneration + 1,
    })).toThrow("CLAUDE_LOGIN_AUTHORITY_MISMATCH");
    expect(store.abandonClaudeLoginMutation(abandon)).toMatchObject({
      acknowledgedChildExited: true,
      accountId: profile.id,
    });
    expect(store.abandonClaudeLoginMutation(abandon)).toMatchObject({
      acknowledgedChildExited: true,
    });
    expect(store.readMutation(key)).toMatchObject({
      state: "reconciled",
      resolution: { kind: "abandoned" },
    });
    expect(() => store.settleClaudeLoginMutation({
      attemptId: attempt.id,
      idempotencyKey: key,
      profileId: profile.id,
      profileGeneration: claude.processGeneration,
      signedIn: false,
      outcome: { state: "joined", exitCode: 1, interruptedBy: null },
    })).toThrow("CLAUDE_LOGIN_TERMINAL_OUTCOME_CONFLICT");

    const settledKey = "00000000-0000-4000-8000-000000000616";
    const settled = store.prepareMutation({
      kind: "account.claude-login",
      authorityId: profile.id,
      authorityGeneration: claude.processGeneration,
      request: { provider: "claude" },
      providerAuthorities: [{ role: "primary", authority: claude, provenance: "account_claude_login" }],
      idempotencyKey: settledKey,
    });
    store.beginClaudeLoginMutationEffect({
      attemptId: settled.id,
      profileId: profile.id,
      profileGeneration: claude.processGeneration,
      evidence: { kind: "account.claude-login", provider: "claude", baselineSignedIn: false },
    });
    store.settleClaudeLoginMutation({
      attemptId: settled.id,
      idempotencyKey: settledKey,
      profileId: profile.id,
      profileGeneration: claude.processGeneration,
      signedIn: false,
      outcome: { state: "not_started", reason: "spawn_failed" },
    });
    expect(() => store.abandonClaudeLoginMutation({
      attemptId: settled.id,
      idempotencyKey: settledKey,
      profileId: profile.id,
      profileGeneration: claude.processGeneration,
      acknowledgeChildExited: true,
    })).toThrow("CLAUDE_LOGIN_NOT_UNSETTLED");
  });
test.each(["claude"] as const)("atomically preserves %s foreground grants across process retirement while siblings and historical receipts remain independent", async (provider) => {
    const { store } = await fixture();
    const profile = store.createProfile(`${provider} foreground custody`);
    const authority = store.advanceProviderAccountProcessGeneration({ profileId: profile.id, provider, expectedProcessGeneration: 0 });
    const idempotencyKey = randomUUID();
    const attempt = store.prepareMutation({
      authorityId: profile.id, authorityGeneration: authority.processGeneration,
      idempotencyKey, kind: `account.${provider}-login`, request: { provider },
      providerAuthorities: [{ role: "primary", authority, provenance: `account_${provider}_login` }],
    });
    const assertBlocked = () => {
      const before = store.requireProviderAccountForProfile(profile.id, provider);
      expect(() => store.advanceProviderAccountProcessGeneration({
        profileId: profile.id, provider, expectedProcessGeneration: authority.processGeneration,
      })).toThrow(`${provider.toUpperCase()}_LOGIN_AUTHORITY_UNSETTLED`);
      expect(store.requireProviderAccountForProfile(profile.id, provider)).toEqual(before);
    };
    assertBlocked();
    expect(store.nextProfileGeneration(profile.id).processGeneration).toBe(1);
    const begin = { attemptId: attempt.id, profileId: profile.id, profileGeneration: authority.processGeneration };
    store.beginClaudeLoginMutationEffect({
      ...begin, evidence: { kind: "account.claude-login", provider, baselineSignedIn: false },
    });
    assertBlocked();
    store.recoverEffectStartedMutations();
    expect(store.readMutation(idempotencyKey)?.state).toBe("ambiguous");
    assertBlocked();
    const settle = store.settleClaudeLoginMutation.bind(store);
    const completion = { ...begin, idempotencyKey, signedIn: false, outcome: { state: "joined", exitCode: 1, interruptedBy: null } as const };
    settle(completion);
    const next = store.advanceProviderAccountProcessGeneration({ profileId: profile.id, provider, expectedProcessGeneration: 1 });
    expect(next.processGeneration).toBe(2);
    expect(settle(completion)).toMatchObject({ providerGeneration: 1, signedIn: false });

    // A generic lookalike is not a foreground launch grant: begin still
    // requires the exact provider-login provenance before consuming it.
    store.prepareMutation({
      authorityId: profile.id, authorityGeneration: next.processGeneration,
      idempotencyKey: randomUUID(), kind: `account.${provider}-login`, request: { provider },
      providerAuthorities: [{ role: "primary", authority: next, provenance: "unrelated_prepared_intent" }],
    });
    expect(store.advanceProviderAccountProcessGeneration({
      profileId: profile.id, provider, expectedProcessGeneration: 2,
    }).processGeneration).toBe(3);
  });
test.each(["claude"] as const)("rejects joined %s login completion after its exact process authority changes but preserves no-effect release", async (provider) => {
    const { store } = await fixture();
    const profile = store.createProfile(`Stale ${provider} login`);
    const authority = store.requireProviderAccountAuthority(profile.id, provider);
    const idempotencyKey = randomUUID();
    const attempt = store.prepareMutation({
      authorityId: profile.id,
      authorityGeneration: authority.processGeneration,
      idempotencyKey,
      kind: `account.${provider}-login`,
      request: { provider },
      providerAuthorities: [{ role: "primary", authority, provenance: `account_${provider}_login` }],
    });
    const begin = { attemptId: attempt.id, profileId: profile.id, profileGeneration: authority.processGeneration };
    store.beginClaudeLoginMutationEffect({
      ...begin, evidence: { kind: "account.claude-login", provider, baselineSignedIn: false },
    });
    const database = new Database(store.paths.database, { create: false, strict: true });
    try {
      database.query("UPDATE provider_accounts SET process_generation=process_generation+1 WHERE id=?")
        .run(authority.providerAccountId);
    } finally { database.close(false); }
    const settle = store.settleClaudeLoginMutation.bind(store);
    expect(() => settle({
      ...begin, idempotencyKey, signedIn: true,
      outcome: { state: "joined", exitCode: 0, interruptedBy: null },
    })).toThrow("PROVIDER_ACCOUNT_AUTHORITY_STALE");
    expect(store.readMutation(idempotencyKey)?.state).toBe("effect_started");
    const noEffect = {
      ...begin, idempotencyKey, signedIn: false,
      outcome: { state: "not_started", reason: "preflight_stale" } as const,
    };
    expect(settle(noEffect)).toMatchObject({ providerGeneration: authority.processGeneration, signedIn: false });
    expect(settle(noEffect)).toMatchObject({ providerGeneration: authority.processGeneration, signedIn: false });
  });
test("preserves authentic generation-zero Devin history without granting a new process at daemon retirement", async () => {
    const paths = await canonical39DevinArchive();
    const source = canonical39DevinFixture.cases.find((entry) => entry.generation === 0);
    if (source === undefined) throw new Error("Expected archived generation-zero Devin session.");
    const store = new StateStore(paths);
    stores.push(store);
    const authority = store.requireProviderAccountAuthority(source.profile.id, "devin");
    const captured = store.requireCapturedSessionProviderAuthority(source.session.id);
    const session = store.requireSession(source.session.id);
    const runtime = store.latestSessionRuntimeProfile(source.session.id);
    store.nextDaemonGeneration(`boot_${"3".repeat(32)}`);
    // Retiring supported provider processes cannot invent a discontinuity for
    // this inert historical provider or grant it a new process generation.
    expect(store.requireSession(source.session.id)).toEqual(session);
    expect(session).toMatchObject({ provider: "devin", state: "idle" });
    expect(store.requireProviderAccountAuthority(source.profile.id, "devin")).toEqual(authority);
    expect(store.requireCapturedSessionProviderAuthority(source.session.id)).toEqual(captured);
    expect(captured.processGeneration).toBe(0);
    expect(store.latestSessionRuntimeProfile(source.session.id)).toEqual(runtime);
    expect(store.latestSessionRuntimeProfile(source.session.id)?.profile).toEqual(source.runtimeProfile);
  });
test.each([0, 2])("retains authentic canonical39 Devin generation %i login only for exact acknowledged abandonment", async (generation) => {
    const paths = await canonical39DevinArchive();
    const source = canonical39DevinFixture.cases.find((entry) => entry.generation === generation);
    if (source === undefined) throw new Error("Expected archived canonical39 login.");
    const store = new StateStore(paths);
    stores.push(store);
    const authority = store.requireProviderAccountAuthority(source.profile.id, "devin");
    const database = new Database(paths.database, { readonly: true, strict: true });
    try {
      const effectBefore = database.query("SELECT * FROM mutation_effect_evidence WHERE attempt_id=?").get(source.mutation.id);
      expect(store.readMutation(source.idempotencyKey)).toMatchObject({
        state: "effect_started", evidence: source.mutation.evidence,
      });
      expect(store.providerAuthorityAdvanceBlocker(source.profile.id, "devin")).toBe("unsettled_authority");
      expect(store.providerAuthorityAdvanceBlocker(source.profile.id, "codex")).toBeNull();
      store.nextProfileGeneration(source.profile.id);
      expect(store.requireProviderAccountAuthority(source.profile.id, "devin")).toEqual(authority);
      store.nextDaemonGeneration(`boot_${"d".repeat(32)}`);
      const recovery = store.recoverEffectStartedMutations();
      expect(recovery.unresolved).toEqual([]);
      expect(recovery.recovered).toContain(source.mutation.id);
      const abandon = { attemptId: source.mutation.id, idempotencyKey: source.idempotencyKey,
        profileId: source.profile.id, profileGeneration: generation, acknowledgeChildExited: true as const };
      const resolutionBefore = database.query("SELECT * FROM mutation_resolutions").all();
      expect(() => store.abandonDevinLoginMutation({ ...abandon, profileGeneration: generation + 1 }))
        .toThrow("DEVIN_LOGIN_AUTHORITY_MISMATCH");
      expect(database.query("SELECT * FROM mutation_resolutions").all()).toEqual(resolutionBefore);
      const receipt = store.abandonDevinLoginMutation(abandon);
      expect(receipt).toMatchObject({ acknowledgedChildExited: true, providerGeneration: generation });
      expect(store.abandonDevinLoginMutation(abandon)).toEqual(receipt);
      expect(store.readMutation(source.idempotencyKey)).toMatchObject({
        state: "reconciled", originalState: "ambiguous", resolution: { kind: "abandoned" },
        evidence: source.mutation.evidence,
      });
      expect(database.query("SELECT * FROM mutation_effect_evidence WHERE attempt_id=?").get(source.mutation.id)).toEqual(effectBefore);
      expect(store.providerAuthorityAdvanceBlocker(source.profile.id, "devin")).toBeNull();
      // With the abandoned login settled, a fresh Devin login prepares under
      // ordinary authority like any provider.
      expect(store.prepareMutation({ kind: "account.devin-login", authorityId: source.profile.id,
        authorityGeneration: generation, request: { provider: "devin" }, idempotencyKey: randomUUID() }))
        .toMatchObject({ state: "prepared", replay: false });
    } finally { database.close(false); }
  });
test("classifies effect-started authorities at restart and rejects new keys", async () => {
    const { store } = await fixture();
    const daemon = startInputFixtureDaemon(store);
    const profile = signInProfile(store, "Restart recovery", "restart@example.com");
    const local = store.createSession({ profileId: profile.id, preset: "high", fastEnabled: false });
    const session = store.bindSession({ sessionId: local.id, expectedRevision: local.revision, providerThreadId: "thread-restart", state: "idle" });
    const { attempt: send } = store.prepareSessionInputMutation({
      ...daemon,
      kind: "session.send",
      sessionId: session.id,
      providerAuthority: store.requireProviderAccountAuthority(profile.id, "codex"),
      message: "uncertain", attachments: [],
      idempotencyKey: "00000000-0000-4000-8000-000000000601",
    });
    store.beginSessionMutationEffect({
      ...daemon,
      attachments: [],
      attemptId: send.id,
      sessionId: session.id,
      profileGeneration: profile.processGeneration,
      providerAuthority: store.requireProviderAccountAuthority(profile.id, "codex"),
      message: "uncertain",
      transcript: {
        accountId: profile.id,
        providerGeneration: profile.processGeneration,
        providerConnectionId: "10000000-0000-4000-8000-00000000000c",
        actor: "human",
        message: "uncertain",
      },
      evidence: {
        kind: "session.send",
        providerThreadId: "thread-restart",
        baseline: { providerUpdatedAt: 10, status: "idle", activeTurnId: null },
        clientMessageId: send.id,
        messageDigest: createHash("sha256").update("uncertain").digest("hex"),
      },
    });
    expect(() => store.prepareSessionInputMutation({
      ...daemon,
      kind: "session.send",
      sessionId: session.id,
      providerAuthority: store.requireProviderAccountAuthority(profile.id, "codex"),
      message: "different", attachments: [],
      idempotencyKey: "00000000-0000-4000-8000-000000000602",
    })).toThrow("UNSETTLED_MUTATION_AUTHORITY");

    store.nextDaemonGeneration(`boot_${"m".repeat(32)}`);
    expect(store.requireSessionProviderAuthority(session.id)).toMatchObject({
      processGeneration: profile.processGeneration + 1,
    });
    expect(store.recoverEffectStartedMutations()).toEqual({ recovered: [send.id], unresolved: [] });
    expect(store.readMutation("00000000-0000-4000-8000-000000000601")).toMatchObject({ state: "ambiguous" });
    expect(store.requireSession(session.id)).toMatchObject({ state: "recovery_required" });
  });
test("classifies every effect-started account mutation from its retired immutable authority after restart", async () => {
    const { store } = await fixture();

    const loginProfile = store.createProfile("Restarted login");
    const loginSource = store.requireProviderAccountAuthority(loginProfile.id, "codex");
    completeCodexAccountMutationAuthorityRetirement(store, loginProfile.id, loginSource.processGeneration);
    const login = store.prepareMutation({
      kind: "account.login",
      authorityId: loginProfile.id,
      authorityGeneration: 1,
      request: { deviceCode: false },
      idempotencyKey: "00000000-0000-4000-8000-000000000621",
      providerAuthorities: [{ role: "source", authority: loginSource, provenance: "account_login_source" }],
    });
    store.beginAccountMutationEffect({
      attemptId: login.id,
      profileId: loginProfile.id,
      profileGeneration: 1,
      providerAuthority: loginSource,
      evidence: { kind: "account.login", method: "browser" },
    });

    const logoutProfile = signInProfile(store, "Restarted logout", "logout-restart@example.com");
    const logoutAuthority = store.requireProviderAccountAuthority(logoutProfile.id, "codex");
    completeCodexAccountMutationAuthorityRetirement(store, logoutProfile.id, logoutAuthority.processGeneration);
    const logout = store.prepareMutation({
      kind: "account.logout",
      authorityId: logoutProfile.id,
      authorityGeneration: logoutAuthority.processGeneration,
      request: {},
      idempotencyKey: "00000000-0000-4000-8000-000000000622",
      providerAuthorities: [{ role: "primary", authority: logoutAuthority, provenance: "account_logout" }],
    });
    store.beginAccountMutationEffect({
      attemptId: logout.id,
      profileId: logoutProfile.id,
      profileGeneration: logoutAuthority.processGeneration,
      providerAuthority: logoutAuthority,
      evidence: { kind: "account.logout", baselineSignedIn: true },
    });

    const cancelProfile = store.createProfile("Restarted login cancellation");
    const pendingSource = store.requireProviderAccountAuthority(cancelProfile.id, "codex");
    completeCodexAccountMutationAuthorityRetirement(store, cancelProfile.id, pendingSource.processGeneration);
    const pendingLogin = store.prepareMutation({
      kind: "account.login",
      authorityId: cancelProfile.id,
      authorityGeneration: 1,
      request: { deviceCode: false },
      idempotencyKey: "00000000-0000-4000-8000-000000000623",
      providerAuthorities: [{ role: "source", authority: pendingSource, provenance: "account_login_source" }],
    });
    store.beginAccountMutationEffect({
      attemptId: pendingLogin.id,
      profileId: cancelProfile.id,
      profileGeneration: 1,
      providerAuthority: pendingSource,
      evidence: { kind: "account.login", method: "browser" },
    });
    store.completeAccountLoginMutation({
      attemptId: pendingLogin.id,
      profileId: cancelProfile.id,
      processGeneration: 1,
      receipt: { status: "pending", loginId: "restart-login-authority" },
    });
    const cancelAuthority = store.requireProviderAccountAuthority(cancelProfile.id, "codex");
    const cancel = store.prepareMutation({
      kind: "account.login-cancel",
      authorityId: cancelProfile.id,
      authorityGeneration: cancelAuthority.processGeneration,
      request: { loginId: "restart-login-authority" },
      idempotencyKey: "00000000-0000-4000-8000-000000000624",
      providerAuthorities: [{ role: "primary", authority: cancelAuthority, provenance: "account_login_cancel" }],
    });
    store.beginLoginCancelMutationEffect({
      attemptId: cancel.id,
      profileId: cancelProfile.id,
      processGeneration: cancelAuthority.processGeneration,
      providerAuthority: cancelAuthority,
      loginId: "restart-login-authority",
    });

    const unrelated = signInProfile(store, "Unrelated restart account", "unrelated-restart@example.com");
    const unrelatedLocal = store.createSession({ profileId: unrelated.id, preset: "high", fastEnabled: false });
    const unrelatedSession = store.bindSession({
      sessionId: unrelatedLocal.id,
      expectedRevision: unrelatedLocal.revision,
      providerThreadId: "thread-unrelated-restart",
      state: "idle",
    });
    const sidecars = new Map([
      [login.id, store.readMutationProviderAuthorities(login.id)],
      [logout.id, store.readMutationProviderAuthorities(logout.id)],
      [cancel.id, store.readMutationProviderAuthorities(cancel.id)],
    ]);

    store.nextDaemonGeneration(`boot_${"a".repeat(32)}`);
    const recovered = store.recoverEffectStartedMutations();
    expect([...recovered.recovered].sort()).toEqual([cancel.id, login.id, logout.id].sort());
    expect(recovered.unresolved).toEqual([]);
    for (const [attempt, key] of [
      [login, "00000000-0000-4000-8000-000000000621"],
      [logout, "00000000-0000-4000-8000-000000000622"],
      [cancel, "00000000-0000-4000-8000-000000000624"],
    ] as const) {
      expect(store.readMutationProviderAuthorities(attempt.id)).toEqual(sidecars.get(attempt.id)!);
      expect(store.readMutation(key)).toMatchObject({
        state: "ambiguous",
        result: { code: "DAEMON_RESTART" },
      });
    }
    expect(store.requireProfile(loginProfile.id)).toMatchObject({ state: "recovery_required", processGeneration: 2 });
    expect(store.requireProfile(logoutProfile.id)).toMatchObject({ state: "recovery_required", processGeneration: 2 });
    expect(store.requireProfile(cancelProfile.id)).toMatchObject({ state: "recovery_required", processGeneration: 2 });
    expect(store.requireProfile(unrelated.id)).toMatchObject({ state: "signed_in", processGeneration: 2 });
    expect(store.requireSessionProviderAuthority(unrelatedSession.id)).toMatchObject({ processGeneration: 2 });
    expect(store.recoverEffectStartedMutations()).toEqual({ recovered: [], unresolved: [] });
  });
test.each([false, true])("preserves pending Codex login origin authority across graceful close and restarts before signed-in=%s settlement", async (signedIn) => {
    const { store } = await fixture();
    const profile = store.createProfile("Pending login origin");
    const source = store.requireProviderAccountAuthority(profile.id, "codex");
    completeCodexAccountMutationAuthorityRetirement(store, profile.id, source.processGeneration);
    const key = "00000000-0000-4000-8000-000000000627";
    const attempt = store.prepareMutation({
      kind: "account.login",
      authorityId: profile.id,
      authorityGeneration: 1,
      request: { deviceCode: false },
      idempotencyKey: key,
      providerAuthorities: [{ role: "source", authority: source, provenance: "account_login_source" }],
    });
    store.beginAccountMutationEffect({
      attemptId: attempt.id,
      profileId: profile.id,
      profileGeneration: 1,
      providerAuthority: source,
      evidence: { kind: "account.login", method: "browser" },
    });
    store.completeAccountLoginMutation({
      attemptId: attempt.id,
      profileId: profile.id,
      processGeneration: 1,
      receipt: { status: "pending", loginId: "pending-origin-login" },
    });
    const origin = store.requireProviderAccountAuthority(profile.id, "codex");
    const paths = store.paths;
    const inspector = new Database(paths.database, { readonly: true, strict: true });
    const originalSidecar = inspector.query(
      "SELECT * FROM account_scoped_provider_authorities WHERE scope_kind='provider_login' AND scope_id=?",
    ).get(attempt.id);
    inspector.close(false);
    expect(store.advanceProfileGeneration(profile.id, origin.processGeneration).processGeneration).toBe(2);
    expect(store.readPendingLoginAuthority(profile.id, 2))
      .toMatchObject({ attemptId: attempt.id, loginId: "pending-origin-login", processGeneration: 2 });
    expect(store.requireProfile(profile.id).state).toBe("login_pending");
    store.close();
    stores.splice(stores.indexOf(store), 1);

    for (const restart of [1, 2]) {
      const reopened = new StateStore(paths, { now: () => 10_000 + restart });
      stores.push(reopened);
      expect(reopened.nextDaemonGeneration(`boot_${String(restart).repeat(32)}`)).toBe(restart);
      const current = reopened.requireProviderAccountAuthority(profile.id, "codex");
      expect(current).toEqual({ ...origin, processGeneration: 2 + restart });
      expect(reopened.readPendingLoginAuthority(profile.id, current.processGeneration))
        .toMatchObject({ attemptId: attempt.id, idempotencyKey: key,
          loginId: "pending-origin-login", processGeneration: 2 + restart });
      expect(reopened.requireProfile(profile.id).state).toBe("login_pending");
      const proof = new Database(paths.database, { readonly: true, strict: true });
      expect(proof.query(
        "SELECT * FROM account_scoped_provider_authorities WHERE scope_kind='provider_login' AND scope_id=?",
      ).get(attempt.id)).toEqual(originalSidecar);
      expect(proof.query(
        `SELECT from_generation,to_generation FROM session_mutation_authority_rebinds
         WHERE attempt_id=? ORDER BY from_generation`,
      ).all(attempt.id)).toEqual(Array.from({ length: restart + 1 }, (_, index) => ({
        from_generation: index + 1, to_generation: index + 2,
      })));
      proof.close(false);
      reopened.close();
      stores.splice(stores.indexOf(reopened), 1);
    }
    const final = new StateStore(paths, { now: () => 10_003 });
    stores.push(final);
    expect(final.readPendingLoginAuthority(profile.id, 4))
      .toMatchObject({ loginId: "pending-origin-login", processGeneration: 4 });
    const current = final.requireProviderAccountAuthority(profile.id, "codex");
    expect(() => final.settlePendingLogin({
      profileId: profile.id, processGeneration: origin.processGeneration,
      loginId: "pending-origin-login", providerStatus: "canceled", provider: { signedIn },
    })).toThrow("LOGIN_CANCEL_GENERATION_MISMATCH");
    expect(() => final.settlePendingLogin({
      profileId: profile.id, processGeneration: current.processGeneration,
      loginId: "different-login", providerStatus: "canceled", provider: { signedIn },
    })).toThrow("LOGIN_CANCEL_AUTHORITY_MISMATCH");
    const cancel = final.prepareMutation({
      kind: "account.login-cancel", authorityId: profile.id,
      authorityGeneration: current.processGeneration,
      request: { loginId: "pending-origin-login" },
      idempotencyKey: "00000000-0000-4000-8000-000000000628",
      providerAuthorities: [{ role: "primary", authority: current, provenance: "account_login_cancel" }],
    });
    expect(() => final.beginLoginCancelMutationEffect({
      attemptId: cancel.id, profileId: profile.id, processGeneration: current.processGeneration,
      loginId: "pending-origin-login", providerAuthority: origin,
    })).toThrow("MUTATION_PROVIDER_AUTHORITY_MISMATCH");
    final.beginLoginCancelMutationEffect({
      attemptId: cancel.id, profileId: profile.id, processGeneration: current.processGeneration,
      loginId: "pending-origin-login", providerAuthority: current,
    });
    expect(final.settlePendingLogin({
      profileId: profile.id, processGeneration: current.processGeneration,
      loginId: "pending-origin-login", providerStatus: signedIn ? "not_found" : "canceled",
      provider: signedIn ? { signedIn, email: "settled-origin@example.com" } : { signedIn },
    }).state).toBe(signedIn ? "signed_in" : "signed_out");
    expect(final.readPendingLoginAuthority(profile.id, current.processGeneration)).toBeNull();
    expect(final.requireProviderAccountAuthority(profile.id, "codex"))
      .toEqual({ ...current, bindingGeneration: current.bindingGeneration + 1 });
    const settled = new Database(paths.database, { readonly: true, strict: true });
    expect(settled.query(
      "SELECT * FROM account_scoped_provider_authorities WHERE scope_kind='provider_login' AND scope_id=?",
    ).get(attempt.id)).toEqual(originalSidecar);
    settled.close(false);
  });
test("keeps an unbound session-start authority frozen and quarantines it without a fabricated restart gap", async () => {
    const { store, home } = await fixture();
    const profile = signInProfile(store, "Unbound restart start", "unbound-restart@example.com");
    const projectRoot = join(home, "unbound-restart-project");
    await mkdir(projectRoot);
    const project = await store.createProject("Unbound restart project", projectRoot, true);
    const providerAuthority = store.requireProviderAccountAuthority(profile.id, "codex");
    const attempt = store.prepareMutation({
      kind: "session.start",
      authorityId: profile.id,
      authorityGeneration: providerAuthority.processGeneration,
      request: sessionStartMutationRequest({ projectId: project.id, provider: "codex", preset: "high",
        presetContract: currentPresetContract, fast: false }),
      idempotencyKey: "00000000-0000-4000-8000-000000000625",
      providerAuthorities: [{ role: "primary", authority: providerAuthority, provenance: "session_start" }],
    });
    const started = store.beginSessionStartEffect({
      attemptId: attempt.id,
      profileId: profile.id,
      profileGeneration: providerAuthority.processGeneration,
      projectId: project.id,
      preset: "high",
      fastEnabled: false,
      provider: "codex",
      providerAuthority,
      providerAccountKey: providerAccountKeyForProfile(store, profile.id, "codex"),
      evidence: {
        kind: "session.start",
        projectId: project.id,
        clientMessageId: null,
        messageDigest: null,
        presetContract: currentPresetContract,
        runtimeProfile: reviewedCodexProfile(profile),
      },
    });
    const captured = store.requireCapturedSessionProviderAuthority(started.id);

    store.nextDaemonGeneration(`boot_${"b".repeat(32)}`);
    expect(store.requireCapturedSessionProviderAuthority(started.id)).toEqual(captured);
    expect(() => store.requireSessionProviderAuthority(started.id)).toThrow("SESSION_PROVIDER_AUTHORITY_STALE");
    expect(store.listSessionEvents({ sessionId: started.id, afterSequence: 0 }).events
      .filter((event) => event.body.type === "gap" && event.body.reason === "provider_restart"))
      .toHaveLength(0);
    expect(store.recoverEffectStartedMutations()).toEqual({ recovered: [attempt.id], unresolved: [] });
    expect(store.requireSession(started.id)).toMatchObject({ state: "recovery_required" });
    expect(store.requireSession(started.id)).not.toHaveProperty("providerThreadId");
    expect(store.readMutationProviderAuthorities(attempt.id)).toEqual([
      { role: "primary", authority: providerAuthority, provenance: "session_start" },
    ]);
  });
test("quarantines an effect-started queue under retired restart authority", async () => {
    const { store } = await fixture();
    const profile = signInProfile(store, "Queue restart", "queue-restart@example.com");
    const session = upsertProvenTestSession(store, {
      profileId: profile.id,
      preset: "high",
      fastEnabled: false,
      providerThreadId: "thread-queue-restart",
      state: "idle",
      providerUpdatedAt: 10,
    });
    const providerAuthority = store.requireProviderAccountAuthority(profile.id, "codex");
    const queued = store.enqueue(session.id, "possibly accepted before restart");
    const evidence = store.beginQueueEffect({
      queueId: queued.id,
      sessionId: session.id,
      profileGeneration: providerAuthority.processGeneration,
      providerAuthority,
      providerConnectionId: "10000000-0000-4000-8000-000000000232",
      evidence: {
        kind: "queue.dispatch",
        queueId: queued.id,
        sessionId: session.id,
        providerThreadId: "thread-queue-restart",
        profileGeneration: providerAuthority.processGeneration,
        baseline: {
          providerUpdatedAt: 10,
          status: "idle",
          activeTurnId: null,
        },
        clientMessageId: queued.id,
        messageDigest: new Bun.CryptoHasher("sha256")
          .update("possibly accepted before restart")
          .digest("hex"),
        runtimeProfile: {
          ...reviewedCodexProfile(profile),
          model: store.requireSessionPresetRequirement(session.id).requirement.model,
        },
      },
    });

    store.nextDaemonGeneration(`boot_${"q".repeat(32)}`);
    expect(store.requireSessionProviderAuthority(session.id)).toMatchObject({
      providerAccountId: providerAuthority.providerAccountId,
      bindingGeneration: providerAuthority.bindingGeneration,
      processGeneration: providerAuthority.processGeneration + 1,
    });
    expect(store.readQueueProviderAuthority(queued.id)).toEqual(providerAuthority);
    expect(store.recoverDispatchingQueueEffects()).toEqual({
      recovered: [queued.id],
      unresolved: [],
    });
    expect(store.requireQueue(queued.id)).toMatchObject({ state: "ambiguous" });
    expect(store.requireSession(session.id)).toMatchObject({ state: "recovery_required" });
    const recoveredEffect = store.readQueueEffect(queued.id);
    expect(recoveredEffect).toMatchObject({ digest: evidence.digest });
    expect(recoveredEffect?.resolution).toBeUndefined();
  });
test("terminalizes only exact quiescent idle Claude authority for account login", async () => {
    const { store } = await fixture();
    const profile = signInProfile(store, "Claude relink", "claude-relink@example.com");
    const providerAuthority = store.requireProviderAccountAuthority(profile.id, "claude");
    let session = upsertProvenTestSession(store, {
      fastEnabled: false,
      preset: "fable-max",
      profileId: profile.id,
      provider: "claude",
      providerThreadId: "claude-thread-relink",
      state: "idle",
    });
    const input = {
      accountId: profile.id,
      providerAuthority,
      providerConnectionId: null,
      providerGeneration: providerAuthority.processGeneration,
      sessionId: session.id,
    } as const;

    expect(store.canReleaseIdleClaudeSessionForAccountLogin({
      profileId: profile.id,
      profileGeneration: providerAuthority.processGeneration,
      sessionId: session.id,
    })).toBe(true);
    session = store.setSessionTurnState({
      activeTurnId: "claude-turn-relink",
      expectedRevision: session.revision,
      sessionId: session.id,
      state: "active",
    });
    expect(store.canReleaseIdleClaudeSessionForAccountLogin({
      profileId: profile.id,
      profileGeneration: providerAuthority.processGeneration,
      sessionId: session.id,
    })).toBe(false);
    expect(() => store.terminalizeIdleClaudeSessionForAccountLogin(input))
      .toThrow("CLAUDE_LOGIN_SESSION_NOT_QUIESCENT");
    session = store.setSessionTurnState({
      expectedRevision: session.revision,
      sessionId: session.id,
      state: "idle",
    });
    const queued = store.enqueue(session.id, "preserve this queued send");
    expect(store.canReleaseIdleClaudeSessionForAccountLogin({
      profileId: profile.id,
      profileGeneration: providerAuthority.processGeneration,
      sessionId: session.id,
    })).toBe(false);
    expect(() => store.terminalizeIdleClaudeSessionForAccountLogin(input))
      .toThrow("CLAUDE_LOGIN_SESSION_NOT_QUIESCENT");
    expect(store.requireSession(session.id)).toMatchObject({ state: "idle" });
    expect(store.requireQueue(queued.id)).toMatchObject({ state: "pending" });

    expect(store.transitionQueue(queued.id, "pending", "cancelled")).toBe(true);
    expect(store.terminalizeIdleClaudeSessionForAccountLogin(input)).toMatchObject({
      changed: true,
      event: {
        body: { activeTurnId: null, status: "terminal", type: "session_status" },
      },
      interactions: [],
      session: { provider: "claude", state: "terminal" },
    });
  });
test("fences managed Claude login retirement with its own captured tuple, not the Codex shadow", async () => {
    const { store } = await fixture();
    const profile = signInProfile(store, "Claude login tuple", "claude-login-tuple@example.com");
    const authority = store.advanceProviderAccountProcessGeneration({
      profileId: profile.id, provider: "claude", expectedProcessGeneration: 0,
    });
    const session = upsertProvenTestSession(store, {
      profileId: profile.id, provider: "claude", preset: "fable-max", fastEnabled: false,
      providerThreadId: "claude-login-tuple-thread", state: "idle",
    });
    store.nextProfileGeneration(profile.id);
    const input = { profileId: profile.id, profileGeneration: authority.processGeneration, sessionId: session.id };
    expect(store.requireProviderAccountAuthority(profile.id, "claude")).toEqual(authority);
    expect(store.canReleaseIdleManagedClaudeSessionForAccountLogin(input)).toBe(true);
    expect(store.canReleaseIdleManagedClaudeSessionForAccountLogin({
      ...input, profileGeneration: store.requireProfileById(profile.id).processGeneration,
    })).toBe(false);
    store.advanceProviderAccountProcessGeneration({
      profileId: profile.id, provider: "claude", expectedProcessGeneration: authority.processGeneration,
    });
    expect(store.canReleaseIdleManagedClaudeSessionForAccountLogin(input)).toBe(false);
    expect(store.canReleaseIdleManagedClaudeSessionForAccountLogin({
      ...input, profileGeneration: authority.processGeneration + 1,
    })).toBe(false);
    expect(store.requireSession(session.id)).toEqual(session);
  });
test("scopes managed Claude login sessions and activity away from personal custody", async () => {
    const { store } = await fixture();
    const profile = signInProfile(
      store,
      "Managed Claude login scope",
      "managed-claude-login-scope@example.com",
    );
    store.setSessionAdoptionPolicy({ provider: "claude", profileId: profile.id });

    const personalIdle = adoptPersonalClaudeTestSession(store, profile);
    const personalActive = adoptPersonalClaudeTestSession(store, profile);
    const personalUnsettled = adoptPersonalClaudeTestSession(store, profile);
    store.setSessionTurnState({
      activeTurnId: "personal-active-turn",
      expectedRevision: personalActive.revision,
      sessionId: personalActive.id,
      state: "active",
    });
    const personalMutation = store.prepareMutation({
      authorityGeneration: profile.processGeneration,
      authorityId: personalUnsettled.id,
      idempotencyKey: "00000000-0000-4000-8000-000000000617",
      kind: "session.rename",
      request: { name: "Personal unsettled rename" },
    });
    expect(store.transitionMutation(
      personalMutation.id,
      "prepared",
      "effect_started",
    )).toBe(true);

    expect(store.listNonterminalManagedClaudeSessions(profile.id)).toEqual([]);
    expect(store.managedClaudeLoginAuthorityBlocker(profile.id)).toBeNull();
    expect(store.canReleaseIdleManagedClaudeSessionForAccountLogin({
      profileId: profile.id,
      profileGeneration: profile.processGeneration,
      sessionId: personalIdle.id,
    })).toBe(false);
    expect(store.canReleaseIdleClaudeSessionForAccountLogin({
      profileId: profile.id,
      profileGeneration: profile.processGeneration,
      sessionId: personalIdle.id,
    })).toBe(false);
    expect(() => store.terminalizeIdleClaudeSessionForAccountLogin({
      providerAuthority: store.requireProviderAccountAuthority(profile.id, "claude"),
      accountId: profile.id,
      providerConnectionId: null,
      providerGeneration: store.requireProviderAccountAuthority(profile.id, "claude").processGeneration,
      sessionId: personalIdle.id,
    })).toThrow("CLAUDE_LOGIN_SESSION_NOT_QUIESCENT");
    expect(store.beginPersonalSessionDetach({ sessionId: personalIdle.id }).binding.state)
      .toBe("detaching");
    expect(store.canReleaseIdleManagedClaudeSessionForAccountLogin({
      profileId: profile.id,
      profileGeneration: profile.processGeneration,
      sessionId: personalIdle.id,
    })).toBe(false);
    expect(store.listNonterminalManagedClaudeSessions(profile.id)).toEqual([]);
    expect(store.managedClaudeLoginAuthorityBlocker(profile.id)).toBeNull();
    const personalIdleProcess = store.readSessionClaudeProcessAuthority(personalIdle.id);
    if (personalIdleProcess === null) throw new Error("Expected detached personal Claude custody.");
    const personalIdleReleasing = store.beginClaudeProcessAuthorityRelease({
      providerThreadId: personalIdleProcess.providerThreadId,
      profileId: personalIdleProcess.profileId,
      runtimeScope: personalIdleProcess.runtimeScope,
      expectedRevision: personalIdleProcess.revision,
      identity: personalIdleProcess.identity,
    });
    store.completeClaudeProcessAuthorityRelease({
      providerThreadId: personalIdleReleasing.providerThreadId,
      profileId: personalIdleReleasing.profileId,
      runtimeScope: personalIdleReleasing.runtimeScope,
      expectedRevision: personalIdleReleasing.revision,
      identity: personalIdleReleasing.identity,
    });
    expect(store.completePersonalSessionDetach({
      sessionId: personalIdle.id,
      archive: false,
    }).binding.state).toBe("detached");
    expect(store.requireSession(personalIdle.id).state).toBe("idle");
    expect(store.listNonterminalManagedClaudeSessions(profile.id)).toEqual([]);
    expect(store.managedClaudeLoginAuthorityBlocker(profile.id)).toBeNull();
    expect(store.quarantineSession(personalIdle.id).state).toBe("recovery_required");
    expect(store.listNonterminalManagedClaudeSessions(profile.id)).toEqual([]);
    expect(store.managedClaudeLoginAuthorityBlocker(profile.id)).toBeNull();

    let managed = upsertProvenTestSession(store, {
      fastEnabled: false,
      preset: "fable-max",
      profileId: profile.id,
      provider: "claude",
      providerThreadId: "managed-claude-login-thread",
      state: "idle",
    });
    expect(store.listNonterminalManagedClaudeSessions(profile.id).map((session) => session.id))
      .toEqual([managed.id]);
    expect(store.canReleaseIdleManagedClaudeSessionForAccountLogin({
      profileId: profile.id,
      profileGeneration: store.requireCapturedSessionProviderAuthority(managed.id).processGeneration,
      sessionId: managed.id,
    })).toBe(true);

    managed = store.setSessionTurnState({
      activeTurnId: "managed-active-turn",
      expectedRevision: managed.revision,
      sessionId: managed.id,
      state: "active",
    });
    expect(store.managedClaudeLoginAuthorityBlocker(profile.id)).toBe("active_session");
    managed = store.setSessionTurnState({
      expectedRevision: managed.revision,
      sessionId: managed.id,
      state: "idle",
    });
    const managedMutation = store.prepareMutation({
      authorityGeneration: profile.processGeneration,
      authorityId: managed.id,
      idempotencyKey: "00000000-0000-4000-8000-000000000618",
      kind: "session.rename",
      request: { name: "Managed unsettled rename" },
    });
    expect(store.transitionMutation(
      managedMutation.id,
      "prepared",
      "effect_started",
    )).toBe(true);
    expect(store.managedClaudeLoginAuthorityBlocker(profile.id))
      .toBe("unsettled_authority");
    expect(store.transitionMutation(
      managedMutation.id,
      "effect_started",
      "applied",
      { renamed: true },
    )).toBe(true);
    expect(store.managedClaudeLoginAuthorityBlocker(profile.id)).toBeNull();

    const mismatchedCandidate = store.upsertSessionAdoptionCandidate({
      provider: "claude",
      providerThreadId: "mismatched-personal-claude-thread",
      title: "Mismatched personal Claude authority",
      state: "idle",
      providerUpdatedAt: 10,
      liveness: "not_live",
    });
    const direct = new Database(store.paths.database, { create: false, strict: true });
    try {
      direct.exec("DROP TRIGGER session_personal_runtime_binding_identity_immutable");
      direct.query(
        `UPDATE session_personal_runtime_bindings
         SET provider_thread_id=?,revision=revision+1,updated_at=updated_at+1
         WHERE session_id=?`,
      ).run(mismatchedCandidate.providerThreadId, personalActive.id);
    } finally {
      direct.close(false);
    }
    expect(store.listNonterminalManagedClaudeSessions(profile.id).map((session) => session.id))
      .toEqual([managed.id]);
    expect(store.managedClaudeLoginAuthorityBlocker(profile.id))
      .toBe("unsettled_authority");
  });
test("scopes managed Claude login provider-switch authority by source and target", async () => {
    const { store } = await fixture();
    const claudeProfile = signInProfile(
      store,
      "Claude switch login scope",
      "claude-switch-login-scope@example.com",
    );
    const codexProfile = signInProfile(
      store,
      "Codex switch login scope",
      "codex-switch-login-scope@example.com",
    );
    const claudeAuthority = store.advanceProviderAccountProcessGeneration({
      profileId: claudeProfile.id, provider: "claude", expectedProcessGeneration: 0,
    });
    const codexAuthority = store.requireProviderAccountAuthority(codexProfile.id, "codex");
    store.setSessionAdoptionPolicy({ provider: "claude", profileId: claudeProfile.id });
    const personalSource = adoptPersonalClaudeTestSession(store, claudeProfile);
    if (personalSource.providerThreadId === undefined) {
      throw new Error("Expected the personal Claude source provider thread.");
    }
    const personalSourceSeedText = "personal Claude source seed";
    const personalSourceSeed = createHash("sha256")
      .update("hra:session-transcript-seed:v1\0", "utf8")
      .update(personalSourceSeedText, "utf8")
      .digest("hex");
    const sourceSwitch = store.prepareMutation({
      authorityGeneration: codexProfile.processGeneration,
      authorityId: personalSource.id,
      idempotencyKey: "00000000-0000-4000-8000-000000000619",
      kind: "session.switch",
      request: sessionProviderSwitchMutationRequest({
        provider: "codex",
        preset: "high",
        presetContract: currentPresetContract,
        targetProfileId: codexProfile.id,
        seedDigest: personalSourceSeed,
      }),
      providerAuthorities: [
        { role: "source", authority: claudeAuthority, provenance: "legacy_switch_source" },
        { role: "target", authority: codexAuthority, provenance: "legacy_switch_target" },
      ],
    });
    const personalSourceTranscript = createHash("sha256")
      .update("personal Claude source transcript")
      .digest("hex");
    const sourceSwitchEvidence = store.beginSessionProviderSwitchEffect({
      attemptId: sourceSwitch.id,
      sessionId: personalSource.id,
      evidence: {
        kind: "session.switch",
        daemonGeneration: 0,
        requestedAccountId: null,
        requestedPreset: "high",
        runtimeProfile: codexAdoptionRuntimeProfile(codexProfile, "high", false),
        seedDigest: personalSourceSeed,
        seedIncludedRecords: 1,
        seedOmittedRecords: 0,
        sourcePreset: "fable-max",
        sourceProcessGeneration: claudeAuthority.processGeneration,
        sourceProfileId: claudeProfile.id,
        sourceProvider: "claude",
        sourceProviderThreadId: personalSource.providerThreadId,
        targetPreset: "high",
        targetProcessGeneration: codexProfile.processGeneration,
        targetProfileId: codexProfile.id,
        targetProvider: "codex",
        targetProviderAccountKey: providerAccountKeyForProfile(store, codexProfile.id, "codex"),
        targetHostCapabilities: testSwitchHostCapabilities,
        presetContract: currentPresetContract,
        transcriptDigest: personalSourceTranscript,
      },
    });
    expect(store.managedClaudeLoginAuthorityBlocker(claudeProfile.id)).toBeNull();

    const recoveredTargetThreadId = "recovered-codex-switch-target";
    store.recordSessionProviderSwitchTarget({
      attemptId: sourceSwitch.id,
      sessionId: personalSource.id,
      providerThreadId: recoveredTargetThreadId,
    });
    store.recordSessionProviderSwitchSeedIntent({
      attemptId: sourceSwitch.id,
      sessionId: personalSource.id,
      providerThreadId: recoveredTargetThreadId,
      runtimeProfile: codexAdoptionRuntimeProfile(codexProfile, "high", false),
      seedText: personalSourceSeedText,
    });
    store.recordSessionProviderSwitchSeedResult({
      attemptId: sourceSwitch.id,
      sessionId: personalSource.id,
      providerThreadId: recoveredTargetThreadId,
      runtimeProfile: codexAdoptionRuntimeProfile(codexProfile, "high", false),
      turnId: "recovered-codex-seed-turn",
      turnStatus: "completed",
    });
    const sourceProcess = store.readClaudeProcessAuthority({
      providerThreadId: personalSource.providerThreadId,
      profileId: claudeProfile.id,
      runtimeScope: "personal",
    });
    if (sourceProcess === null) throw new Error("Expected personal Claude source process.");
    const releasingSource = store.beginClaudeProcessAuthorityRelease({
      providerThreadId: sourceProcess.providerThreadId,
      profileId: sourceProcess.profileId,
      runtimeScope: sourceProcess.runtimeScope,
      expectedRevision: sourceProcess.revision,
      identity: sourceProcess.identity,
    });
    store.completeClaudeProcessAuthorityRelease({
      providerThreadId: releasingSource.providerThreadId,
      profileId: releasingSource.profileId,
      runtimeScope: releasingSource.runtimeScope,
      expectedRevision: releasingSource.revision,
      identity: releasingSource.identity,
    });
    store.recordSessionProviderSwitchSourceReleased({
      attemptId: sourceSwitch.id,
      sessionId: personalSource.id,
    });
    expect(store.readSessionProviderSwitchProgress(sourceSwitch.id)).toMatchObject({
      targetProviderAccountKey: providerAccountKeyForProfile(store, codexProfile.id, "codex"),
      targetProviderThreadId: recoveredTargetThreadId,
    });
    expect(() => store.bindSessionProviderSwitchRecoveryTarget({
      attemptId: sourceSwitch.id,
      sessionId: personalSource.id,
      expectedSessionRevision: personalSource.revision,
      providerAccountKey: `v1:codex:${"f".repeat(64)}`,
      title: "Wrong-account Codex target",
      providerUpdatedAt: 20,
    })).toThrow("SESSION_PROVIDER_SWITCH_RECOVERY_TARGET_MISMATCH");
    const recoveredTarget = store.bindSessionProviderSwitchRecoveryTarget({
      attemptId: sourceSwitch.id,
      sessionId: personalSource.id,
      expectedSessionRevision: personalSource.revision,
      providerAccountKey: providerAccountKeyForProfile(store, codexProfile.id, "codex"),
      title: "Recovered Codex target",
      providerUpdatedAt: 20,
    });
    expect(store.requireSessionPresetContract(recoveredTarget.id)).toBe(currentPresetContract);
    expect(recoveredTarget).toMatchObject({
      profileId: codexProfile.id,
      provider: "codex",
      providerThreadId: recoveredTargetThreadId,
      state: "recovery_required",
    });
    expect(store.readSessionPersonalRuntimeBinding(personalSource.id, true))
      .toMatchObject({ state: "detached" });
    expect(store.readSessionProviderAccountAuthority(personalSource.id)).toEqual({
      sessionId: personalSource.id,
      provider: "codex",
      runtimeScope: "managed",
      accountKey: providerAccountKeyForProfile(store, codexProfile.id, "codex"),
      recordedAt: expect.any(Number),
    });
    const inspector = new Database(store.paths.database, { create: false, strict: true });
    try {
      inspector.query(
        `INSERT INTO provider_runtime_account_revocations(
           profile_id,profile_generation,provider,runtime_scope,current_account_key,
           state,revision,created_at,updated_at,completed_at
         ) VALUES (?,?,'codex','managed',NULL,'completed',1,?,?,?)`,
      ).run(
        codexProfile.id,
        codexProfile.processGeneration,
        3_000,
        3_000,
        3_000,
      );
      expect(() => store.bindSessionProviderSwitchRecoveryTarget({
        attemptId: sourceSwitch.id,
        sessionId: personalSource.id,
        expectedSessionRevision: recoveredTarget.revision,
        providerAccountKey: providerAccountKeyForProfile(store, codexProfile.id, "codex"),
        title: "Revoked Codex target",
        providerUpdatedAt: 20,
      })).toThrow("SESSION_PROVIDER_SWITCH_RECOVERY_TARGET_ACCOUNT_AUTHORITY_MISMATCH");
      expect(() => store.resolveSessionMutation({
        attemptId: sourceSwitch.id,
        expectedOriginalState: "effect_started",
        expectedEvidenceDigest: sourceSwitchEvidence.digest,
        resolution: "proven_applied",
        resolutionEvidence: { source: "revoked_target_read" },
        receipt: { revoked: true },
        provider: {
          providerThreadId: recoveredTargetThreadId,
          title: "Recovered Codex target",
          status: "idle",
          providerUpdatedAt: 20,
        },
      })).toThrow("SESSION_PROVIDER_SWITCH_RECOVERY_BINDING_MISMATCH");
      inspector.query(
        `DELETE FROM provider_runtime_account_revocations
         WHERE profile_id=? AND provider='codex' AND runtime_scope='managed'`,
      ).run(codexProfile.id);
      const storedEvidence = inspector.query(
        "SELECT evidence_json,evidence_digest FROM mutation_effect_evidence WHERE attempt_id=?",
      ).get(sourceSwitch.id) as { evidence_json: string; evidence_digest: string };
      const alteredEvidence = JSON.parse(storedEvidence.evidence_json) as Record<string, unknown>;
      delete alteredEvidence.targetProviderAccountKey;
      const alteredEvidenceJson = JSON.stringify(alteredEvidence);
      const alteredEvidenceDigest = createHash("sha256").update(alteredEvidenceJson).digest("hex");
      withRemovedTestGuards(inspector, ["mutation_effect_evidence_immutable_update"], () => inspector.query(
        "UPDATE mutation_effect_evidence SET evidence_json=?,evidence_digest=? WHERE attempt_id=?",
      ).run(alteredEvidenceJson, alteredEvidenceDigest, sourceSwitch.id));
      const altered = snapshotSwitchContainmentForTest(inspector);
      expect(() => store.resolveSessionMutation({
        attemptId: sourceSwitch.id,
        expectedOriginalState: "effect_started",
        expectedEvidenceDigest: alteredEvidenceDigest,
        resolution: "proven_applied",
        resolutionEvidence: { source: "altered_target_read" },
        receipt: { altered: true },
        provider: {
          providerThreadId: recoveredTargetThreadId,
          title: "Recovered Codex target",
          status: "idle",
          providerUpdatedAt: 20,
        },
      })).toThrow("EFFECT_EVIDENCE_PROVENANCE_CORRUPT");
      expect(snapshotSwitchContainmentForTest(inspector)).toEqual(altered);
      withRemovedTestGuards(inspector, ["mutation_effect_evidence_immutable_update"], () => inspector.query(
        "UPDATE mutation_effect_evidence SET evidence_json=?,evidence_digest=? WHERE attempt_id=?",
      ).run(storedEvidence.evidence_json, storedEvidence.evidence_digest, sourceSwitch.id));
      withRemovedTestGuards(inspector, ["session_provider_account_authority_update_guard"], () => inspector.query(
        "UPDATE session_provider_account_authorities SET account_key=? WHERE session_id=?",
      ).run(`v1:codex:${"f".repeat(64)}`, personalSource.id));
      expect(() => store.resolveSessionMutation({
        attemptId: sourceSwitch.id,
        expectedOriginalState: "effect_started",
        expectedEvidenceDigest: sourceSwitchEvidence.digest,
        resolution: "proven_applied",
        resolutionEvidence: { source: "mismatched_target_read" },
        receipt: { mismatch: true },
        provider: {
          providerThreadId: recoveredTargetThreadId,
          title: "Recovered Codex target",
          status: "idle",
          providerUpdatedAt: 20,
        },
      })).toThrow("SESSION_PROVIDER_SWITCH_RECOVERY_BINDING_MISMATCH");
      withRemovedTestGuards(inspector, ["session_provider_account_authority_update_guard"], () => inspector.query(
        "UPDATE session_provider_account_authorities SET account_key=? WHERE session_id=?",
      ).run(providerAccountKeyForProfile(store, codexProfile.id, "codex"), personalSource.id));
    } finally {
      inspector.close(false);
    }
    const sourceSwitchReceipt = {
      from: {
        account: claudeProfile.id,
        preset: "fable-max" as const,
        provider: "claude" as const,
      },
      providerThreadId: recoveredTargetThreadId,
      request: {
        accountId: null,
        preset: "high" as const,
        presetContract: currentPresetContract,
        provider: "codex" as const,
      },
      seed: {
        digest: personalSourceSeed,
        includedRecords: 1,
        omittedRecords: 0,
        status: "completed" as const,
      },
      sessionId: personalSource.id,
      to: {
        account: codexProfile.id,
        preset: "high" as const,
        provider: "codex" as const,
      },
      transcriptDigest: personalSourceTranscript,
      turnId: "recovered-codex-seed-turn",
    };
    expect(store.resolveSessionMutation({
      attemptId: sourceSwitch.id,
      expectedOriginalState: "effect_started",
      expectedEvidenceDigest: sourceSwitchEvidence.digest,
      resolution: "proven_applied",
      resolutionEvidence: { source: "target_read_after_source_release" },
      receipt: sourceSwitchReceipt,
      provider: {
        providerThreadId: recoveredTargetThreadId,
        title: "Recovered Codex target",
        status: "idle",
        providerUpdatedAt: 20,
      },
    })).toMatchObject({
      profileId: codexProfile.id,
      provider: "codex",
      providerThreadId: recoveredTargetThreadId,
      state: "idle",
    });
    expect(store.managedClaudeLoginAuthorityBlocker(claudeProfile.id)).toBeNull();

    const managedCodexSource = upsertProvenTestSession(store, {
      fastEnabled: false,
      preset: "high",
      profileId: codexProfile.id,
      provider: "codex",
      providerThreadId: "managed-codex-source-for-claude",
      state: "idle",
    });
    const managedClaudeSeedDigest = createHash("sha256")
      .update("managed Claude target seed")
      .digest("hex");
    const targetSwitch = store.prepareMutation({
      authorityGeneration: claudeAuthority.processGeneration,
      authorityId: managedCodexSource.id,
      idempotencyKey: "00000000-0000-4000-8000-000000000620",
      kind: "session.switch",
      request: sessionProviderSwitchMutationRequest({
        provider: "claude",
        preset: "fable-max",
        targetProfileId: claudeProfile.id,
        seedDigest: managedClaudeSeedDigest,
      }),
      providerAuthorities: [
        { role: "source", authority: codexAuthority, provenance: "legacy_switch_source" },
        { role: "target", authority: claudeAuthority, provenance: "legacy_switch_target" },
      ],
    });
    store.beginSessionProviderSwitchEffect({
      attemptId: targetSwitch.id,
      sessionId: managedCodexSource.id,
      providerAuthentication: {
        profileId: claudeProfile.id,
        processGeneration: claudeAuthority.processGeneration,
        provider: "claude",
        signedIn: true,
      },
      evidence: {
        kind: "session.switch",
        daemonGeneration: 0,
        requestedAccountId: null,
        requestedPreset: "fable-max",
        runtimeProfile: {
          ...claudeAdoptionRuntimeProfile(store.requireProviderAccountAuthority(claudeProfile.id, "claude")),
          configHome: "isolated",
        },
        seedDigest: managedClaudeSeedDigest,
        seedIncludedRecords: 1,
        seedOmittedRecords: 0,
        sourcePreset: "high",
        sourceProcessGeneration: codexProfile.processGeneration,
        sourceProfileId: codexProfile.id,
        sourceProvider: "codex",
        sourceProviderThreadId: managedCodexSource.providerThreadId ?? "",
        targetPreset: "fable-max",
        targetProcessGeneration: claudeAuthority.processGeneration,
        targetProfileId: claudeProfile.id,
        targetProvider: "claude",
        targetProviderAccountKey: testProviderAccountKey("claude"),
        targetHostCapabilities: testSwitchHostCapabilities,
        transcriptDigest: createHash("sha256")
          .update("managed Claude target transcript")
          .digest("hex"),
      },
    });
    const switchTargetLaunchInput = {
      providerAuthority: store.requireProviderAccountAuthority(claudeProfile.id, "claude"),
      providerThreadId: "00000000-0000-4000-8000-000000000922",
      profileId: claudeProfile.id,
      profileGeneration: claudeProfile.processGeneration,
      runtimeScope: "managed" as const,
      providerAccountKey: testProviderAccountKey("claude"),
      sessionId: managedCodexSource.id,
    };
    expect(() => store.stageClaudeProcessLaunchIntent({
      ...switchTargetLaunchInput,
      providerAuthority: store.requireProviderAccountAuthority(codexProfile.id, "claude"),
      profileId: codexProfile.id,
      profileGeneration: codexProfile.processGeneration,
    })).toThrow("SESSION_CLAUDE_PROCESS_LAUNCH_INTENT_SESSION_AUTHORITY_MISMATCH");
    expect(() => store.stageClaudeProcessLaunchIntent({
      ...switchTargetLaunchInput,
      providerAccountKey: namedProviderAccountKey("claude", "wrong-switch-target-account"),
    })).toThrow("SESSION_CLAUDE_PROCESS_LAUNCH_INTENT_SESSION_AUTHORITY_MISMATCH");
    expect(() => store.stageClaudeProcessLaunchIntent({
      ...switchTargetLaunchInput,
      runtimeScope: "personal",
    })).toThrow("SESSION_CLAUDE_PROCESS_LAUNCH_INTENT_SESSION_AUTHORITY_MISMATCH");
    const switchTargetLaunch = store.stageClaudeProcessLaunchIntent(
      switchTargetLaunchInput,
    );
    expect(switchTargetLaunch).toMatchObject({
      providerThreadId: switchTargetLaunchInput.providerThreadId,
      profileId: claudeProfile.id,
      profileGeneration: claudeProfile.processGeneration,
      runtimeScope: "managed",
      sessionId: managedCodexSource.id,
    });
    store.cancelClaudeProcessLaunchIntent({
      providerThreadId: switchTargetLaunch.providerThreadId,
      profileId: switchTargetLaunch.profileId,
      profileGeneration: switchTargetLaunch.profileGeneration,
      runtimeScope: switchTargetLaunch.runtimeScope,
      intentId: switchTargetLaunch.intentId,
      expectedRevision: switchTargetLaunch.revision,
    });
    expect(store.managedClaudeLoginAuthorityBlocker(claudeProfile.id))
      .toBe("unsettled_authority");
  });
test("provider deletion atomically terminalizes pending and in-flight session authority", async () => {
    const { store } = await fixture();
    const daemon = startInputFixtureDaemon(store);
    const profile = signInProfile(store, "Provider deletion", "deleted@example.com");
    const importedSession = upsertProvenTestSession(store, {
      fastEnabled: false,
      preset: "high",
      profileId: profile.id,
      providerThreadId: "thread-provider-deleted",
      state: "idle",
    });
    const session = store.updateSessionMetadata({
      sessionId: importedSession.id,
      expectedRevision: importedSession.revision,
      preset: "high",
    });
    store.prepareMutation({
      authorityGeneration: profile.processGeneration,
      authorityId: session.id,
      idempotencyKey: "00000000-0000-4000-8000-000000000603",
      kind: "session.rename",
      request: { name: "never dispatched" },
    });
    const effect = store.prepareMutation({
      authorityGeneration: profile.processGeneration,
      authorityId: session.id,
      idempotencyKey: "00000000-0000-4000-8000-000000000604",
      kind: "session.rename",
      request: { name: "possibly dispatched" },
    });
    const runtime = {
      approvalPolicy: "on-request" as const,
      computerUse: true as const,
      enabledApps: [],
      fast: false,
      model: "gpt-6-astra",
      permissionProfile: ":workspace" as const,
      pluginCapability: true as const,
      preset: "high" as const,
      processGeneration: profile.processGeneration,
      profileId: profile.id,
      reasoningEffort: "max" as const,
      reviewMode: "auto_review" as const,
      serviceTier: null,
      observedAt: 2_000,
    };
    const storedAttachment = {
      byteLength: 4,
      canonicalMediaType: "text/plain" as const,
      digest: "6".repeat(64),
      mediaType: "text/plain" as const,
      name: "terminalized.txt",
    };
    const providerAuthority = store.requireProviderAccountAuthority(profile.id, "codex");
    const queueKey = "00000000-0000-4000-8000-000000000606";
    const reservation = store.reserveAttachmentIngress({
      ...daemon,
      kind: "session.queue",
      sessionId: session.id,
      idempotencyKey: queueKey,
      message: "possibly dispatched queue",
      attachments: [{ digest: storedAttachment.digest, name: storedAttachment.name,
        mediaType: storedAttachment.mediaType, byteLength: storedAttachment.byteLength }],
      providerAuthority,
    });
    if (reservation.kind !== "reserved") throw new Error("Expected attached queue reservation.");
    const attachmentReservation = { ...daemon, reservationId: reservation.reservationId,
      reservationDigest: reservation.reservationDigest };
    const queued = (() => {
      try {
        return store.enqueueIdempotent({
          sessionId: session.id,
          profileGeneration: providerAuthority.processGeneration,
          providerAuthority,
          idempotencyKey: queueKey,
          message: "possibly dispatched queue",
          attachments: [{ digest: storedAttachment.digest, name: storedAttachment.name,
            mediaType: storedAttachment.mediaType, byteLength: storedAttachment.byteLength }],
          storedAttachments: [storedAttachment],
          attachmentReservation,
        });
      } finally {
        store.releaseAttachmentIngress(attachmentReservation);
      }
    })();
    // The legacy follow-up writer is now an exact replay of atomic admission.
    store.recordMessageAttachments({
      attachments: [storedAttachment],
      sessionId: session.id,
      sourceId: queued.id,
    });
    // Admit queued intent before a distinct provider effect becomes unsettled.
    // New queue admission must not bypass the current mutation fence.
    store.beginSessionMutationEffect({
      attemptId: effect.id,
      evidence: {
        baseline: { activeTurnId: null, providerUpdatedAt: 10, status: "idle" },
        kind: "session.rename",
        providerThreadId: "thread-provider-deleted",
        requestedName: "possibly dispatched",
      },
      profileGeneration: profile.processGeneration,
      providerAuthority,
      sessionId: session.id,
    });
    store.beginQueueEffect({
      queueId: queued.id,
      sessionId: session.id,
      profileGeneration: profile.processGeneration,
      providerAuthority: store.requireProviderAccountAuthority(profile.id, "codex"),
      providerConnectionId: "10000000-0000-4000-8000-000000000004",
      evidence: {
        baseline: { activeTurnId: null, providerUpdatedAt: 10, status: "idle" },
        clientMessageId: queued.id,
        kind: "queue.dispatch",
        messageDigest: new Bun.CryptoHasher("sha256")
          .update("possibly dispatched queue")
          .digest("hex"),
        profileGeneration: profile.processGeneration,
        providerThreadId: "thread-provider-deleted",
        queueId: queued.id,
        runtimeProfile: runtime,
        sessionId: session.id,
      },
    });
    const taskStore = store.createSessionTaskStore();
    const activeTask = taskStore.create({
      sessionId: session.id,
      name: "Provider-deleted task",
      prompt: "Must not run after the provider deletes this session.",
      minutes: 15,
      status: "active",
      idempotencyKey: "00000000-0000-4000-8000-000000000605",
    });
    const readTask = () => taskStore.list(session.id).find((task) =>
      task.id === activeTask.id);

    expect(() => store.terminalizeSessionFromProviderDeletion({
      accountId: profile.id,
      providerConnectionId: null,
      providerGeneration: profile.processGeneration + 1,
      providerAuthority: store.requireProviderAccountAuthority(profile.id, "codex"),
      sessionId: session.id,
    })).toThrow("SESSION_PROVIDER_DELETION_AUTHORITY_MISMATCH");
    expect(store.requireSession(session.id)).toMatchObject({ state: "idle" });
    expect(store.readMutation("00000000-0000-4000-8000-000000000603"))
      .toMatchObject({ state: "prepared" });
    expect(store.readMutation("00000000-0000-4000-8000-000000000604"))
      .toMatchObject({ state: "effect_started" });
    expect(store.requireQueue(queued.id)).toMatchObject({ state: "dispatching" });
    expect(store.readSessionUserMessageSource(session.id, "queue", queued.id))
      .toMatchObject({ status: "pending" });
    expect(store.attachmentCustody(storedAttachment.digest))
      .toMatchObject({ referenceCount: 1 });
    expect(readTask()).toMatchObject({
      status: "active",
      revision: activeTask.revision,
      nextDueAt: activeTask.nextDueAt,
      updatedAt: activeTask.updatedAt,
    });

    const terminal = store.terminalizeSessionFromProviderDeletion({
      accountId: profile.id,
      providerConnectionId: null,
      providerGeneration: profile.processGeneration,
      providerAuthority: store.requireProviderAccountAuthority(profile.id, "codex"),
      sessionId: session.id,
    });
    expect(terminal).toMatchObject({
      changed: true,
      event: {
        body: { activeTurnId: null, status: "terminal", type: "session_status" },
      },
      session: { state: "terminal" },
    });
    expect(store.readMutation("00000000-0000-4000-8000-000000000603"))
      .toMatchObject({ state: "cancelled" });
    expect(store.readMutation("00000000-0000-4000-8000-000000000604"))
      .toMatchObject({
      originalState: "effect_started",
      resolution: {
        evidence: { source: "provider_thread_deleted" },
        kind: "abandoned",
      },
      state: "reconciled",
      });
    expect(store.requireQueue(queued.id)).toMatchObject({ state: "ambiguous" });
    expect(store.readQueueEffect(queued.id)).toMatchObject({
      resolution: {
        evidence: { source: "provider_thread_deleted" },
        kind: "abandoned",
      },
    });
    expect(store.readSessionUserMessageSource(session.id, "queue", queued.id))
      .toEqual({
        status: "abandoned",
        intent: { version: 1, actor: "human", hadAttachments: true },
      });
    expect(store.hasPendingSessionUserMessageFinalization(session.id)).toBe(false);
    expect(store.messageAttachmentManifest(session.id, queued.id)).toEqual([]);
    expect(store.attachmentCustody(storedAttachment.digest))
      .toMatchObject({ referenceCount: 0 });
    expect(store.listUnreferencedAttachments().some((candidate) =>
      candidate.digest === storedAttachment.digest && candidate.referenceCount === 0))
      .toBe(true);
    expect(store.listUnsettledMutations({ sessionId: session.id })).toEqual([]);
    expect(store.listUnsettledQueueEffects(session.id)).toEqual([]);
    const pausedTask = readTask();
    expect(pausedTask).toMatchObject({
      status: "paused",
      revision: activeTask.revision + 1,
      nextDueAt: null,
    });
    expect(store.terminalizeSessionFromProviderDeletion({
      accountId: profile.id,
      providerConnectionId: null,
      providerGeneration: profile.processGeneration,
      providerAuthority: store.requireProviderAccountAuthority(profile.id, "codex"),
      sessionId: session.id,
    })).toMatchObject({
      changed: false,
      interactions: [],
      session: { state: "terminal" },
    });
    expect(readTask()).toEqual(pausedTask);
    expect(store.listSessionEvents({
      afterSequence: 0,
      sessionId: session.id,
    }).events.filter((event) =>
      event.body.type === "session_status" && event.body.status === "terminal"))
      .toHaveLength(1);
  });
test("provider deletion abandons direct-message transcript but retains custody until explicit acknowledgment", async () => {
    const { store } = await fixture();
    const daemon = startInputFixtureDaemon(store);
    const profile = signInProfile(store, "Provider deletion send", "deleted-send@example.com");
    const session = createProvenTestSession(store, {
      fastEnabled: false,
      preset: "high",
      profileId: profile.id,
      providerThreadId: "thread-provider-deleted-send",
      state: "idle",
    });
    const runtime = {
      approvalPolicy: "on-request" as const,
      computerUse: true as const,
      enabledApps: [],
      fast: false,
      model: "gpt-6-astra",
      permissionProfile: ":workspace" as const,
      pluginCapability: true as const,
      preset: "high" as const,
      processGeneration: profile.processGeneration,
      profileId: profile.id,
      reasoningEffort: "max" as const,
      reviewMode: "auto_review" as const,
      serviceTier: null,
      observedAt: 2_000,
    };
    const attachment = {
      byteLength: 4,
      canonicalMediaType: "text/plain" as const,
      digest: "7".repeat(64),
      mediaType: "text/plain" as const,
      name: "terminalized-send.txt",
    };
    const reference = {
      byteLength: attachment.byteLength,
      digest: attachment.digest,
      mediaType: attachment.mediaType,
      name: attachment.name,
    };
    const message = "possibly dispatched direct message";
    const key = "00000000-0000-4000-8000-000000000607";
    const input = {
      ...daemon,
      sessionId: session.id,
      providerAuthority: capturedProviderAuthorityForTest(store, session.id),
      idempotencyKey: key,
      kind: "session.send" as const,
      message,
      attachments: [reference],
    };
    const reservation = store.reserveAttachmentIngress(input);
    if (reservation.kind !== "reserved") throw new Error("Expected direct input reservation.");
    const { attempt, custody } = store.prepareSessionInputMutation({ ...input,
      reservation: { reservationId: reservation.reservationId, reservationDigest: reservation.reservationDigest } });
    if (custody.kind !== "mutation_owned") throw new Error("Expected retained input custody.");
    store.beginSessionMutationEffect({
      ...daemon,
      attachments: [attachment],
      custody,
      providerAuthority: capturedProviderAuthorityForTest(store, session.id),
      message,
      attemptId: attempt.id,
      evidence: {
        baseline: { activeTurnId: null, providerUpdatedAt: null, status: "idle" },
        clientMessageId: attempt.id,
        kind: "session.send",
        messageDigest: createHash("sha256").update(message).digest("hex"),
        providerThreadId: session.providerThreadId ?? "",
        runtimeProfile: runtime,
      },
      profileGeneration: profile.processGeneration,
      sessionId: session.id,
      transcript: {
        accountId: profile.id,
        actor: "human",
        attachments: [reference],
        message,
        providerGeneration: profile.processGeneration,
        providerConnectionId: "10000000-0000-4000-8000-00000000000d",
        storedAttachments: [attachment],
      },
    });
    expect(store.hasPendingSessionUserMessageFinalization(session.id)).toBe(true);
    expect(store.attachmentCustody(attachment.digest)).toMatchObject({ referenceCount: 1 });

    store.terminalizeSessionFromProviderDeletion({
      providerAuthority: capturedProviderAuthorityForTest(store, session.id),
      accountId: profile.id,
      providerConnectionId: null,
      providerGeneration: profile.processGeneration,
      sessionId: session.id,
    });

    expect(store.readMutation(key)).toMatchObject({
      resolution: { kind: "abandoned" },
      state: "reconciled",
    });
    expect(store.readSessionUserMessageSource(session.id, "mutation", key)).toEqual({
      status: "abandoned",
      intent: { version: 1, actor: "human", hadAttachments: true },
    });
    expect(store.hasPendingSessionUserMessageFinalization(session.id)).toBe(false);
    expect(store.messageAttachmentManifest(session.id, attempt.id)).toEqual([reference]);
    expect(store.attachmentCustody(attachment.digest)).toMatchObject({ referenceCount: 1 });
    const retainedMutation = store.readMutation(key);
    const terminalSession = store.requireSession(session.id);
    const inspector = new Database(store.paths.database, { readonly: true, strict: true });
    try {
      const retained = canonicalAuthBudgetRows(inspector, [
        "mutation_effect_evidence", "mutation_effect_evidence_provenance",
        "mutation_effect_evidence_provenance_anchors", "mutation_resolutions", "sessions", "session_events",
      ]);
      expect(store.acknowledgeTerminalSessionInputCustody({
        sessionId: session.id, expectedRevision: terminalSession.revision,
      })).toEqual({ session: terminalSession, releasedInputCount: 1, alreadyAcknowledgedInputCount: 0 });
      expect(retained.read()).toEqual(retained.before);
      expect(store.readMutation(key)).toEqual(retainedMutation);
      const acknowledged = canonicalAuthBudgetSnapshot(inspector);
      expect(store.acknowledgeTerminalSessionInputCustody({
        sessionId: session.id, expectedRevision: terminalSession.revision,
      })).toEqual({ session: terminalSession, releasedInputCount: 0, alreadyAcknowledgedInputCount: 1 });
      expect(canonicalAuthBudgetSnapshot(inspector)).toEqual(acknowledged);
    } finally { inspector.close(false); }
    expect(store.messageAttachmentManifest(session.id, attempt.id)).toEqual([]);
    expect(store.attachmentCustody(attachment.digest)).toMatchObject({ referenceCount: 0 });
    expect(store.listUnreferencedAttachments().some((candidate) =>
      candidate.digest === attachment.digest && candidate.referenceCount === 0))
      .toBe(true);
  });
test("late accepted Work dispatch stays in recovery after provider deletion and restart", async () => {
    const { store, home } = await fixture();
    const profile = signInProfile(
      store,
      "Provider-deleted Work authority",
      "provider-deleted-work@example.com",
    );
    const projectRoot = join(home, "provider-deleted-work");
    await mkdir(projectRoot);
    const project = await store.createProject(
      "Provider-deleted Work",
      projectRoot,
      true,
    );
    store.setSessionAdoptionPolicy({ provider: "codex", profileId: profile.id });
    const candidate = store.upsertSessionAdoptionCandidate({
      provider: "codex",
      providerThreadId: "provider-deleted-work-thread",
      title: "Provider-deleted Work",
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
    const session = store.updateSessionMetadata({
      sessionId: adopted.session.id,
      expectedRevision: adopted.session.revision,
      projectId: project.id,
    });
    const workCapability = `hrac1_${"A".repeat(43)}`;
    const encodeWorkCursor = (payload: unknown) =>
      `hra1.${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}.${"A".repeat(43)}`;
    const createWorkStore = (generation: number) => store.createWorkStore(
      generation,
      encodeWorkCursor,
      {
        issue: () => workCapability,
        verify: (candidateCapability) => candidateCapability === workCapability,
      },
    );
    const workStore = createWorkStore(17);
    const created = workStore.apply({
      kind: "work.create",
      idempotencyKey: "01890f31-a123-7000-8000-000000000951",
      clientRef: "provider-deleted-work",
      coordinatorSessionId: session.id,
      objective: "Keep late provider receipts from resurrecting deleted session authority.",
      routes: [{
        accountId: profile.id,
        projectId: project.id,
        preset: "high",
        fast: false,
      }],
      tasks: [{
        clientRef: "provider-deleted-work-task",
        dependsOnRefs: [],
        dependsOnTaskIds: [],
        objective: "Hold one dispatch across provider deletion.",
        instructions: "Remain fail-closed when the accepted receipt arrives late.",
        criteria: ["The attempt never returns to running."],
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
      idempotencyKey: "01890f31-a123-7000-8000-000000000952",
      workId: created.work.id,
      taskId: task.id,
      expectedTaskRevision: task.revision,
      actorSessionId: session.id,
      actorCapability: workCapability,
      leaseMs: 50_000,
    });
    if (claimed.kind !== "task.claim") throw new Error("Expected a claimed work task.");
    const dispatchKey = "01890f31-a123-7000-8000-000000000953";
    const prepared = workStore.apply({
      kind: "attempt.dispatch",
      idempotencyKey: dispatchKey,
      workId: created.work.id,
      attemptId: claimed.attempt.id,
      expectedAttemptRevision: claimed.attempt.revision,
      fence: claimed.attempt.fence,
      actorSessionId: session.id,
      attemptCapability: workCapability,
      targetSessionId: session.id,
      mode: "send",
    });
    if (prepared.kind !== "attempt.dispatch") throw new Error("Expected a dispatch effect.");
    expect(workStore.authorizePreparedEffect(dispatchKey)).toMatchObject({
      executable: true,
      status: { state: "effect_started" },
    });

    expect(store.terminalizeSessionFromProviderDeletion({
      providerAuthority: store.requireProviderAccountAuthority(profile.id, "codex"),
      accountId: profile.id,
      providerConnectionId: null,
      providerGeneration: profile.processGeneration,
      sessionId: session.id,
    })).toMatchObject({
      changed: true,
      session: { state: "terminal" },
    });
    const acceptedReceipt = {
      kind: "turn_started" as const,
      turnId: `opaque_v2_${"d".repeat(64)}`,
      runtimeProfileDigest: "e".repeat(64),
      mutationAttemptId: createAttemptId(),
      accountGeneration: profile.processGeneration,
    };
    const recovered = workStore.finalizeDispatch(dispatchKey, {
      kind: "accepted",
      receipt: acceptedReceipt,
    });
    expect(recovered).toMatchObject({
      id: claimed.attempt.id,
      status: "unknown",
      dispatchReceipt: acceptedReceipt,
    });
    const rawAttempt = () => {
      const inspector = new Database(store.paths.database, { readonly: true, strict: true });
      try {
        return inspector.query(
          "SELECT state,revision FROM work_attempts WHERE id=?",
        ).get(claimed.attempt.id);
      } finally {
        inspector.close(false);
      }
    };
    expect(rawAttempt()).toEqual({
      state: "recovery_required",
      revision: recovered.revision,
    });
    expect(workStore.task(task.id)).toMatchObject({
      task: { status: "blocked" },
      activeAttempt: { id: claimed.attempt.id, status: "unknown" },
    });
    const afterFinalization = workStore.events(created.work.id, 0, 50);
    expect(afterFinalization.events.at(-1)?.body).toEqual({
      type: "attempt.dispatch_finalized",
      attemptId: claimed.attempt.id,
      outcome: "accepted",
    });

    expect(workStore.finalizeDispatch(dispatchKey, {
      kind: "accepted",
      receipt: acceptedReceipt,
    })).toEqual(recovered);
    expect(workStore.snapshot(created.work.id).tasks[0]).toMatchObject({
      id: task.id,
      status: "blocked",
    });
    expect(workStore.events(created.work.id, 0, 50)).toEqual(afterFinalization);

    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const restarted = new StateStore(paths);
    stores.push(restarted);
    const restartedWork = restarted.createWorkStore(
      18,
      encodeWorkCursor,
      {
        issue: () => workCapability,
        verify: (candidateCapability) => candidateCapability === workCapability,
      },
    );
    expect(restartedWork.authorizePreparedEffect(dispatchKey)).toMatchObject({
      executable: false,
      disposition: "settled",
      status: { state: "accepted" },
    });
    expect(restartedWork.finalizeDispatch(dispatchKey, {
      kind: "accepted",
      receipt: acceptedReceipt,
    })).toEqual(recovered);
    expect(restartedWork.snapshot(created.work.id).tasks[0]).toMatchObject({
      id: task.id,
      status: "blocked",
    });
    expect(restartedWork.events(created.work.id, 0, 50)).toEqual(afterFinalization);
    const restartedInspector = new Database(paths.database, { readonly: true, strict: true });
    try {
      expect(restartedInspector.query(
        "SELECT state,revision FROM work_attempts WHERE id=?",
      ).get(claimed.attempt.id)).toEqual({
        state: "recovery_required",
        revision: recovered.revision,
      });
    } finally {
      restartedInspector.close(false);
    }
  });
test("atomically binds a session-start placeholder before its provider effect is admitted", async () => {
    const { store, home } = await fixture();
    const profile = signInProfile(store, "Bound start", "bound-start@example.com");
    const projectRoot = join(home, "bound-start-project");
    await mkdir(projectRoot);
    const project = await store.createProject("Bound start project", projectRoot, true);
    const key = "00000000-0000-4000-8000-000000000610";
    const attempt = store.prepareMutation({
      kind: "session.start",
      authorityId: profile.id,
      authorityGeneration: profile.processGeneration,
      request: sessionStartMutationRequest({
        projectId: project.id,
        provider: "codex",
        preset: "high",
        presetContract: currentPresetContract,
        fast: false,
      }),
      idempotencyKey: key,
    });
    const session = store.beginSessionStartEffect({
      attemptId: attempt.id,
      profileId: profile.id,
      profileGeneration: profile.processGeneration,
      projectId: project.id,
      preset: "high",
      fastEnabled: false,
      provider: "codex",
      providerAuthority: store.requireProviderAccountAuthority(profile.id, "codex"),
      providerAccountKey: providerAccountKeyForProfile(store, profile.id, "codex"),
      evidence: { kind: "session.start", projectId: project.id, clientMessageId: null, messageDigest: null, presetContract: currentPresetContract },
      hostCapabilities: {
        preambleVersion: 1,
        preambleDigest: "a".repeat(64),
        manifestVersion: 1,
        manifestDigest: "b".repeat(64),
      },
    });
    expect(store.requireSessionHostCapabilityBinding(session.id)).toMatchObject({
      preambleVersion: 1,
      preambleDigest: "a".repeat(64),
      manifestVersion: 1,
      manifestDigest: "b".repeat(64),
    });
    expect(store.readMutation(key)).toMatchObject({
      state: "effect_started",
      sessionStartId: session.id,
      evidence: {
        evidence: {
          kind: "session.start",
          presetContract: currentPresetContract,
          projectId: project.id,
        },
      },
    });

    const originalMutation = store.readMutation(key);
    const originalCapabilities = store.requireSessionHostCapabilityBinding(session.id);
    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const inspector = new Database(paths.database, { create: false, strict: true });
    try {
      const before = snapshotSwitchContainmentForTest(inspector);
      for (const readonly of [true, false]) {
        const stable = new StateStore(paths, { readonly });
        try {
          expect(stable.readMutation(key)).toEqual(originalMutation);
          expect(stable.requireSession(session.id)).toEqual(session);
          expect(stable.requireSessionHostCapabilityBinding(session.id)).toEqual(originalCapabilities);
        } finally { stable.close(); }
        expect(snapshotSwitchContainmentForTest(inspector)).toEqual(before);
      }
    } finally { inspector.close(false); }
    const reopened = new StateStore(paths);
    stores.push(reopened);
    expect(reopened.recoverEffectStartedMutations())
      .toEqual({ recovered: [attempt.id], unresolved: [] });
    expect(reopened.requireSession(session.id)).toMatchObject({ state: "recovery_required" });
    expect(reopened.requireSession(session.id).providerThreadId).toBeUndefined();
    expect(reopened.readMutation(key)?.evidence).toEqual(originalMutation?.evidence);
    expect(reopened.readMutation(key)?.evidence?.evidence)
      .toMatchObject({ presetContract: currentPresetContract });
    expect(reopened.requireSessionHostCapabilityBinding(session.id)).toEqual(originalCapabilities);
  });
test("refuses current session-start evidence contract deletion at readonly selection and writable startup", async () => {
    const { store, home } = await fixture();
    const profile = signInProfile(store, "Tampered start", "tampered-start@example.com");
    const projectRoot = join(home, "tampered-start-project");
    await mkdir(projectRoot);
    const project = await store.createProject("Tampered start project", projectRoot, true);
    const key = "00000000-0000-4000-8000-000000000611";
    const attempt = store.prepareMutation({
      kind: "session.start", authorityId: profile.id, authorityGeneration: profile.processGeneration,
      request: sessionStartMutationRequest({ projectId: project.id, provider: "codex", preset: "high",
        presetContract: currentPresetContract, fast: false }),
      idempotencyKey: key,
    });
    const session = store.beginSessionStartEffect({
      attemptId: attempt.id, profileId: profile.id, profileGeneration: profile.processGeneration,
      projectId: project.id, preset: "high", fastEnabled: false, provider: "codex",
      providerAuthority: store.requireProviderAccountAuthority(profile.id, "codex"),
      providerAccountKey: providerAccountKeyForProfile(store, profile.id, "codex"),
      evidence: { kind: "session.start", projectId: project.id, clientMessageId: null,
        messageDigest: null, presetContract: currentPresetContract },
      hostCapabilities: { preambleVersion: 1, preambleDigest: "a".repeat(64),
        manifestVersion: 1, manifestDigest: "b".repeat(64) },
    });
    expect(store.readMutation(key)).toMatchObject({
      state: "effect_started", sessionStartId: session.id,
      evidence: { evidence: { presetContract: currentPresetContract } },
    });
    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const inspector = new Database(paths.database, { create: false, strict: true });
    try {
      const original = snapshotSwitchContainmentForTest(inspector);
      const stored = z.object({ evidence_json: z.string() }).strict().parse(inspector.query(
        "SELECT evidence_json FROM mutation_effect_evidence WHERE attempt_id=?",
      ).get(attempt.id));
      const alteredEvidence = z.record(z.string(), z.unknown()).parse(JSON.parse(stored.evidence_json));
      delete alteredEvidence.presetContract;
      const evidenceJson = JSON.stringify(alteredEvidence);
      const evidenceDigest = createHash("sha256").update(evidenceJson).digest("hex");
      // This is deliberately damaged current evidence, not an old-format
      // producer row. Its independent provenance and anchor stay untouched.
      inspector.transaction(() => withRemovedTestGuards(inspector,
        ["mutation_effect_evidence_immutable_update"], () => {
          inspector.query("UPDATE mutation_effect_evidence SET evidence_json=?,evidence_digest=? WHERE attempt_id=?")
            .run(evidenceJson, evidenceDigest, attempt.id);
        })).immediate();
      const corrupted = snapshotSwitchContainmentForTest(inspector);
      expect(corrupted.schema).toEqual(original.schema);
      expect(corrupted.version).toEqual(original.version);
      expect(corrupted.rows.filter(({ name }) => name !== "mutation_effect_evidence"))
        .toEqual(original.rows.filter(({ name }) => name !== "mutation_effect_evidence"));
      expect(inspector.query("SELECT evidence_json,evidence_digest FROM mutation_effect_evidence WHERE attempt_id=?")
        .get(attempt.id)).toEqual({ evidence_json: evidenceJson, evidence_digest: evidenceDigest });
      // Readonly startup does not sweep every generic effect. Selecting this
      // row still refuses authority; writable startup audits it before writes.
      const readonly = new StateStore(paths, { readonly: true });
      try {
        expect(snapshotSwitchContainmentForTest(inspector)).toEqual(corrupted);
        expect(() => readonly.readMutation(key)).toThrow("EFFECT_EVIDENCE_PROVENANCE_CORRUPT");
      } finally { readonly.close(); }
      expect(snapshotSwitchContainmentForTest(inspector)).toEqual(corrupted);
      expect(() => new StateStore(paths)).toThrow("EFFECT_EVIDENCE_PROVENANCE_CORRUPT");
      expect(snapshotSwitchContainmentForTest(inspector)).toEqual(corrupted);
    } finally { inspector.close(false); }
  });
test("rejects a legacy rebound session-start digest before writing any effect state", async () => {
    const { store, home } = await fixture();
    const profile = signInProfile(store, "Legacy rebound start", "legacy-start@example.com");
    const projectRoot = join(home, "legacy-rebound-start-project");
    await mkdir(projectRoot);
    const project = await store.createProject("Legacy rebound start", projectRoot, true);
    const key = "00000000-0000-4000-8000-000000000611";
    const attempt = store.prepareMutation({
      authorityGeneration: profile.processGeneration,
      authorityId: profile.id,
      idempotencyKey: key,
      kind: "session.start",
      // Exact request shape from the preceding build, before the rebound
      // contract became part of the durable mutation identity.
      request: {
        projectId: project.id,
        provider: "codex",
        preset: "high",
        fast: false,
      },
    });

    expect(() => store.beginSessionStartEffect({
      providerAuthority: store.requireProviderAccountAuthority(profile.id, "codex"),
      attemptId: attempt.id,
      evidence: {
        clientMessageId: null,
        kind: "session.start",
        messageDigest: null,
        presetContract: currentPresetContract,
        projectId: project.id,
      },
      fastEnabled: false,
      preset: "high",
      profileGeneration: profile.processGeneration,
      profileId: profile.id,
      projectId: project.id,
      provider: "codex",
      providerAccountKey: providerAccountKeyForProfile(store, profile.id, "codex"),
    })).toThrow("MUTATION_EFFECT_AUTHORITY_CHANGED");
    expect(store.readMutation(key)).toMatchObject({ state: "prepared" });
    expect(store.listSessions()).toEqual([]);
    expect(store.readMutation(key)?.evidence).toBeUndefined();

    const stableKey = "00000000-0000-4000-8000-000000000612";
    const stableAttempt = store.prepareMutation({
      authorityGeneration: profile.processGeneration,
      authorityId: profile.id,
      idempotencyKey: stableKey,
      kind: "session.start",
      request: {
        projectId: project.id,
        provider: "codex",
        preset: "low",
        fast: false,
      },
    });
    const stableSession = store.beginSessionStartEffect({
      providerAuthority: store.requireProviderAccountAuthority(profile.id, "codex"),
      attemptId: stableAttempt.id,
      evidence: {
        clientMessageId: null,
        kind: "session.start",
        messageDigest: null,
        projectId: project.id,
      },
      fastEnabled: false,
      preset: "low",
      profileGeneration: profile.processGeneration,
      profileId: profile.id,
      projectId: project.id,
      provider: "codex",
      providerAccountKey: providerAccountKeyForProfile(store, profile.id, "codex"),
    });
    expect(store.readMutation(stableKey)).toMatchObject({ state: "effect_started" });
    expect(store.requireSessionPresetRequirement(stableSession.id)).toEqual({
      preset: "low",
      requirement: { model: "gpt-5.6-luna", effort: "max" },
    });
  });
test("rolls back idle Codex start completion after identifiable authority is lost", async () => {
    const { store, home } = await fixture();
    const profile = signInProfile(
      store,
      "Start completion identity loss",
      "start-completion-identity-loss@example.com",
    );
    const projectRoot = join(home, "start-completion-identity-loss");
    await mkdir(projectRoot);
    const project = await store.createProject(
      "Start completion identity loss",
      projectRoot,
      true,
    );
    const runtimeProfile = codexAdoptionRuntimeProfile(profile, "high", false);
    const providerAuthority = store.requireProviderAccountAuthority(profile.id, "codex");
    const attempt = store.prepareMutation({
      authorityGeneration: profile.processGeneration,
      authorityId: profile.id,
      idempotencyKey: "00000000-0000-4000-8000-0000000006c9",
      kind: "session.start",
      request: sessionStartMutationRequest({
        projectId: project.id,
        provider: "codex",
        preset: "high",
        presetContract: currentPresetContract,
        fast: false,
      }),
    });
    const starting = store.beginSessionStartEffect({
      providerAuthority: store.requireProviderAccountAuthority(profile.id, "codex"),
      attemptId: attempt.id,
      evidence: {
        clientMessageId: null,
        kind: "session.start",
        messageDigest: null,
        presetContract: currentPresetContract,
        projectId: project.id,
        runtimeProfile,
      },
      fastEnabled: false,
      preset: "high",
      profileGeneration: profile.processGeneration,
      profileId: profile.id,
      projectId: project.id,
      provider: "codex",
      providerAccountKey: providerAccountKeyForProfile(store, profile.id, "codex"),
    });
    expect(store.setProfileState(
      profile.id,
      profile.processGeneration,
      "signed_in",
      { plan: "apiKey" },
    )).toBe(true);
    expect(() => store.completeSessionStartEffect({
      providerAuthority,
      attemptId: attempt.id,
      sessionId: starting.id,
      expectedSessionRevision: starting.revision,
      providerThreadId: "identity-lost-completed-thread",
      state: "idle",
      runtimeProfile,
      receipt: { sessionId: starting.id },
    })).toThrow("SESSION_START_ACCOUNT_AUTHORITY_MISMATCH");
    expect(store.requireSession(starting.id).state).toBe("starting");
    expect(store.requireSession(starting.id).providerThreadId).toBeUndefined();
    expect(store.readMutation("00000000-0000-4000-8000-0000000006c9"))
      .toMatchObject({ state: "effect_started" });
  });
test("keeps a bound unresolved session-start authority current across close and restart advances", async () => {
    const { store, home } = await fixture();
    const profile = signInProfile(store, "Successor lineage", "successor-lineage@example.com");
    const projectRoot = join(home, "successor-lineage-project");
    await mkdir(projectRoot);
    const project = await store.createProject("Successor lineage project", projectRoot, true);
    const runtimeProfile = {
      approvalPolicy: "on-request" as const,
      computerUse: true as const,
      enabledApps: [],
      fast: false,
      model: "gpt-6-astra",
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
    const key = "00000000-0000-4000-8000-0000000006c0";
    const attempt = store.prepareMutation({
      authorityGeneration: profile.processGeneration,
      authorityId: profile.id,
      idempotencyKey: key,
      kind: "session.start",
      request: sessionStartMutationRequest({
        projectId: project.id,
        provider: "codex",
        preset: "high",
        presetContract: currentPresetContract,
        fast: false,
      }),
    });
    const starting = store.beginSessionStartEffect({
      providerAuthority: store.requireProviderAccountAuthority(profile.id, "codex"),
      attemptId: attempt.id,
      evidence: {
        clientMessageId: null,
        kind: "session.start",
        messageDigest: null,
        presetContract: currentPresetContract,
        projectId: project.id,
        runtimeProfile,
      },
      fastEnabled: false,
      preset: "high",
      profileGeneration: profile.processGeneration,
      profileId: profile.id,
      projectId: project.id,
      provider: "codex",
      providerAccountKey: providerAccountKeyForProfile(store, profile.id, "codex"),
    });
    const bound = store.bindSessionStartRecoveryTarget({
      attemptId: attempt.id,
      expectedSessionRevision: starting.revision,
      providerThreadId: "thread-successor-lineage",
      runtimeProfile,
      sessionId: starting.id,
      title: "Successor lineage",
    });
    expect(bound).toMatchObject({
      providerThreadId: "thread-successor-lineage",
      state: "recovery_required",
    });

    const workStore = {
      prepareProfileAuthorityChange: () => [],
    } as unknown as Parameters<StateStore["advanceProfileGenerationWithWorkRetirement"]>[2];
    const closed = store.advanceProfileGenerationWithWorkRetirement(
      profile.id,
      profile.processGeneration,
      workStore,
      { preserveSessionMutationAuthorities: true },
    );
    expect(closed.profile.processGeneration).toBe(profile.processGeneration + 1);
    expect(store.isSessionMutationProviderAuthorityCurrent({
      attemptId: attempt.id,
      originGeneration: profile.processGeneration,
      profileId: profile.id,
      provider: "codex",
    })).toBe(true);

    expect(store.nextDaemonGeneration(`boot_${"c".repeat(32)}`)).toBe(1);
    expect(store.requireProfileById(profile.id).processGeneration)
      .toBe(profile.processGeneration + 2);
    expect(store.isSessionMutationProviderAuthorityCurrent({
      attemptId: attempt.id,
      originGeneration: profile.processGeneration,
      profileId: profile.id,
      provider: "codex",
    })).toBe(true);
    expect(store.readMutation(key)).toMatchObject({ state: "effect_started" });
    expect(store.requireSession(starting.id)).toMatchObject({
      providerThreadId: "thread-successor-lineage",
      state: "recovery_required",
    });
  });
test("preserves an unresolved terminal generation-zero Claude start without fabricating restart successors", async () => {
    const { store, home } = await fixture();
    const key = "00000000-0000-4000-8000-0000000006c1";
    const profile = signInProfile(store, "Terminal Claude start", "terminal-claude@example.com");
    const claudeAuthority = store.requireProviderAccountAuthority(profile.id, "claude");
    expect(claudeAuthority.processGeneration).toBe(0);
    const projectRoot = join(home, "terminal-claude-start-project");
    await mkdir(projectRoot);
    const project = await store.createProject("Terminal Claude start project", projectRoot, true);
    const attempt = store.prepareMutation({
      authorityGeneration: claudeAuthority.processGeneration,
      authorityId: profile.id,
      idempotencyKey: key,
      kind: "session.start",
      request: sessionStartMutationRequest({
        projectId: project.id,
        provider: "claude",
        preset: "fable-max",
        fast: false,
      }),
    });
    const starting = store.beginSessionStartEffect({
      providerAuthority: claudeAuthority,
      attemptId: attempt.id,
      evidence: {
        clientMessageId: null,
        kind: "session.start",
        messageDigest: null,
        projectId: project.id,
      },
      fastEnabled: false,
      preset: "fable-max",
      profileGeneration: claudeAuthority.processGeneration,
      profileId: profile.id,
      projectId: project.id,
      provider: "claude",
      providerAccountKey: testProviderAccountKey("claude"),
      providerAuthentication: {
        profileId: profile.id,
        processGeneration: claudeAuthority.processGeneration,
        provider: "claude",
        signedIn: true,
      },
    });
    expect(store.reconcileSessionFromProvider({
      activeTurnId: null,
      sessionId: starting.id,
      state: "terminal",
    })).toMatchObject({ state: "terminal" });
    const original = store.readMutation(key);
    const frozenAuthorities = store.readMutationProviderAuthorities(attempt.id);
    const captured = store.requireCapturedSessionProviderAuthority(starting.id);
    expect(captured).toMatchObject(claudeAuthority);
    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);

    const firstRestart = new StateStore(paths, { now: () => 2_000 });
    stores.push(firstRestart);
    expect(firstRestart.nextDaemonGeneration(`boot_${"d".repeat(32)}`)).toBe(1);
    expect(firstRestart.requireProfileById(profile.id).processGeneration).toBe(profile.processGeneration + 1);
    expect(firstRestart.requireSession(starting.id).state).toBe("terminal");
    expect(firstRestart.readMutation(key)).toMatchObject({
      state: "ambiguous", authorityGeneration: claudeAuthority.processGeneration,
      evidence: original?.evidence,
    });
    const firstMutation = firstRestart.readMutation(key);
    expect(firstMutation?.resolution).toBeUndefined();
    expect(firstRestart.requireCapturedSessionProviderAuthority(starting.id)).toEqual(captured);
    expect(firstRestart.readMutationProviderAuthorities(attempt.id)).toEqual(frozenAuthorities);
    firstRestart.close();
    stores.splice(stores.indexOf(firstRestart), 1);

    const secondRestart = new StateStore(paths, { now: () => 3_000 });
    stores.push(secondRestart);
    expect(secondRestart.nextDaemonGeneration(`boot_${"e".repeat(32)}`)).toBe(2);
    expect(secondRestart.requireProfileById(profile.id).processGeneration).toBe(profile.processGeneration + 2);
    expect(secondRestart.readMutation(key)).toEqual(firstMutation);
    expect(secondRestart.requireCapturedSessionProviderAuthority(starting.id)).toEqual(captured);
    expect(secondRestart.readMutationProviderAuthorities(attempt.id)).toEqual(frozenAuthorities);
    const inspector = new Database(paths.database, { readonly: true, strict: true });
    try {
      expect(inspector.query(
        `SELECT provider,from_generation,to_generation
         FROM session_mutation_authority_rebinds
         WHERE attempt_id=? AND profile_id=?
         ORDER BY from_generation`,
      ).all(attempt.id, profile.id)).toEqual([]);
      expect(inspector.query(
        "SELECT resolution_kind,evidence_json FROM mutation_resolutions WHERE attempt_id=?",
      ).get(attempt.id)).toBeNull();
      expect(inspector.query("SELECT * FROM session_provider_authority_successors WHERE session_id=?")
        .all(starting.id)).toEqual([]);
    } finally {
      inspector.close(false);
    }
  });
test("direct account effect admission separates sibling providers but refuses same-provider unsettled authority", async () => {
    const loginFixture = await fixture();
    const loginStart = await prepareSignedOutSessionStart(
      loginFixture.store,
      loginFixture.home,
      {
        idempotencyKey: "00000000-0000-4000-8000-0000000006c2",
        label: "Blocked login",
        preset: "fable-max",
        provider: "claude",
      },
    );
    const loginKey = "00000000-0000-4000-8000-0000000006c3";
    const loginAttempt = loginFixture.store.prepareMutation({
      authorityGeneration: loginStart.profile.processGeneration + 1,
      authorityId: loginStart.profile.id,
      idempotencyKey: loginKey,
      kind: "account.login",
      request: { deviceCode: true },
    });
    loginFixture.store.beginSessionStartEffect({
      providerAuthority: loginFixture.store.requireProviderAccountAuthority(loginStart.profile.id, "claude"),
      attemptId: loginStart.attempt.id,
      evidence: {
        clientMessageId: null,
        kind: "session.start",
        messageDigest: null,
        projectId: loginStart.project.id,
      },
      fastEnabled: false,
      preset: "fable-max",
      profileGeneration: loginStart.profile.processGeneration,
      profileId: loginStart.profile.id,
      projectId: loginStart.project.id,
      provider: "claude",
      providerAccountKey: testProviderAccountKey("claude"),
      providerAuthentication: {
        profileId: loginStart.profile.id,
        processGeneration: loginStart.profile.processGeneration,
        provider: "claude",
        signedIn: true,
      },
    });
    const claudeAuthority = loginFixture.store.requireProviderAccountAuthority(loginStart.profile.id, "claude");
    completeCodexAccountMutationAuthorityRetirement(loginFixture.store, loginStart.profile.id,
      loginFixture.store.requireProviderAccountAuthority(loginStart.profile.id, "codex").processGeneration);
    expect(loginFixture.store.beginAccountMutationEffect({
      providerAuthority: loginFixture.store.requireProviderAccountAuthority(loginStart.profile.id, "codex"),
      attemptId: loginAttempt.id,
      evidence: { kind: "account.login", method: "device_code" },
      profileGeneration: loginStart.profile.processGeneration + 1,
      profileId: loginStart.profile.id,
    })).toMatchObject({ retiredSessionIds: [], profile: { state: "login_pending" } });
    expect(loginFixture.store.readMutation(loginKey)).toMatchObject({ state: "effect_started" });
    expect(loginFixture.store.requireProfileById(loginStart.profile.id)).toMatchObject({
      processGeneration: 1,
      state: "login_pending",
    });
    expect(loginFixture.store.requireProviderAccountAuthority(loginStart.profile.id, "claude"))
      .toEqual(claudeAuthority);
    expect(loginFixture.store.hasUnsettledSessionMutationAuthority(loginStart.profile.id, "claude"))
      .toBe(true);
    const logoutFixture = await fixture();
    const logoutProfile = signInProfile(
      logoutFixture.store,
      "Blocked logout",
      "blocked-logout@example.com",
    );
    const logoutProjectRoot = join(logoutFixture.home, "blocked-logout-project");
    await mkdir(logoutProjectRoot);
    const logoutProject = await logoutFixture.store.createProject(
      "Blocked logout project",
      logoutProjectRoot,
      true,
    );
    const logoutStartAttempt = logoutFixture.store.prepareMutation({
      authorityGeneration: logoutProfile.processGeneration,
      authorityId: logoutProfile.id,
      idempotencyKey: "00000000-0000-4000-8000-0000000006c4",
      kind: "session.start",
      request: sessionStartMutationRequest({
        projectId: logoutProject.id,
        provider: "codex",
        preset: "high",
        presetContract: currentPresetContract,
        fast: false,
      }),
    });
    const logoutKey = "00000000-0000-4000-8000-0000000006c5";
    const logoutAttempt = logoutFixture.store.prepareMutation({
      authorityGeneration: logoutProfile.processGeneration,
      authorityId: logoutProfile.id,
      idempotencyKey: logoutKey,
      kind: "account.logout",
      request: {},
    });
    logoutFixture.store.beginSessionStartEffect({
      providerAuthority: logoutFixture.store.requireProviderAccountAuthority(logoutProfile.id, "codex"),
      attemptId: logoutStartAttempt.id,
      evidence: {
        clientMessageId: null,
        kind: "session.start",
        messageDigest: null,
        presetContract: currentPresetContract,
        projectId: logoutProject.id,
      },
      fastEnabled: false,
      preset: "high",
      profileGeneration: logoutProfile.processGeneration,
      profileId: logoutProfile.id,
      projectId: logoutProject.id,
      provider: "codex",
      providerAccountKey: providerAccountKeyForProfile(
        logoutFixture.store,
        logoutProfile.id,
        "codex",
      ),
    });
    expect(() => logoutFixture.store.beginAccountMutationEffect({
      providerAuthority: logoutFixture.store.requireProviderAccountAuthority(logoutProfile.id, "codex"),
      attemptId: logoutAttempt.id,
      evidence: { baselineSignedIn: true, kind: "account.logout" },
      profileGeneration: logoutProfile.processGeneration,
      profileId: logoutProfile.id,
    })).toThrow("SESSION_MUTATION_AUTHORITY_UNSETTLED");
    expect(logoutFixture.store.readMutation(logoutKey)).toMatchObject({ state: "prepared" });
    expect(logoutFixture.store.requireProfileById(logoutProfile.id)).toMatchObject({
      processGeneration: logoutProfile.processGeneration,
      state: "signed_in",
    });
  });
test("starts Claude under exact provider authority while Codex remains signed out", async () => {
    const { store, home } = await fixture();
    const { attempt, profile, project } = await prepareSignedOutSessionStart(
      store,
      home,
      {
        idempotencyKey: "00000000-0000-4000-8000-0000000006a3",
        label: "Claude proof",
        preset: "fable-max",
        provider: "claude",
      },
    );

    const session = store.beginSessionStartEffect({
      providerAuthority: store.requireProviderAccountAuthority(profile.id, "claude"),
      attemptId: attempt.id,
      evidence: {
        clientMessageId: null,
        kind: "session.start",
        messageDigest: null,
        projectId: project.id,
      },
      fastEnabled: false,
      preset: "fable-max",
      profileGeneration: profile.processGeneration,
      profileId: profile.id,
      projectId: project.id,
      provider: "claude",
      providerAccountKey: testProviderAccountKey("claude"),
      providerAuthentication: {
        profileId: profile.id,
        processGeneration: profile.processGeneration,
        provider: "claude",
        signedIn: true,
      },
    });

    expect(store.requireProfileById(profile.id)).toMatchObject({
      processGeneration: 0,
      state: "signed_out",
    });
    expect(session).toMatchObject({
      profileId: profile.id,
      provider: "claude",
      state: "starting",
    });
    expect(store.sessionAccountAuthorityMatches(session.id, profile.id)).toBe(true);
    expect(store.readMutation("00000000-0000-4000-8000-0000000006a3"))
      .toMatchObject({ state: "effect_started" });
  });
test("refuses missing or mismatched Claude session-start authentication proof", async () => {
    const { store, home } = await fixture();
    const { attempt, profile, project } = await prepareSignedOutSessionStart(
      store,
      home,
      {
        idempotencyKey: "00000000-0000-4000-8000-0000000006a4",
        label: "Claude proof refusal",
        preset: "fable-max",
        provider: "claude",
      },
    );
    const start = (providerAuthentication?: Readonly<{
      profileId: typeof profile.id;
      processGeneration: number;
      provider: "codex" | "claude";
      signedIn: true;
    }>) => store.beginSessionStartEffect({
      providerAuthority: store.requireProviderAccountAuthority(profile.id, "claude"),
      attemptId: attempt.id,
      evidence: {
        clientMessageId: null,
        kind: "session.start" as const,
        messageDigest: null,
        projectId: project.id,
      },
      fastEnabled: false,
      preset: "fable-max",
      profileGeneration: profile.processGeneration,
      profileId: profile.id,
      projectId: project.id,
      provider: "claude",
      providerAccountKey: testProviderAccountKey("claude"),
      ...(providerAuthentication === undefined ? {} : { providerAuthentication }),
    });

    expect(() => start()).toThrow("SESSION_START_PROVIDER_AUTHENTICATION_REQUIRED");
    expect(() => start({
      profileId: profile.id,
      processGeneration: profile.processGeneration,
      provider: "codex",
      signedIn: true,
    }))
      .toThrow("SESSION_START_PROVIDER_AUTHENTICATION_MISMATCH");
    expect(() => start({
      profileId: profile.id,
      processGeneration: profile.processGeneration + 1,
      provider: "claude",
      signedIn: true,
    })).toThrow("SESSION_START_PROVIDER_AUTHENTICATION_MISMATCH");
    expect(store.readMutation("00000000-0000-4000-8000-0000000006a4"))
      .toMatchObject({ state: "prepared" });
  });
test("does not let provider authentication proof bypass the Codex profile-state gate", async () => {
    const { store, home } = await fixture();
    const { attempt, profile, project } = await prepareSignedOutSessionStart(
      store,
      home,
      {
        idempotencyKey: "00000000-0000-4000-8000-0000000006a5",
        label: "Codex proof refusal",
        preset: "high",
        provider: "codex",
      },
    );
    expect(store.setProfileState(
      profile.id,
      profile.processGeneration,
      "signed_out",
      { email: "codex-proof-refusal@example.com", plan: "Plus" },
    )).toBe(true);
    const identifiableAccountKey = providerAccountKeyForProfile(store, profile.id, "codex");

    expect(() => store.beginSessionStartEffect({
      providerAuthority: store.requireProviderAccountAuthority(profile.id, "codex"),
      attemptId: attempt.id,
      evidence: {
        clientMessageId: null,
        kind: "session.start",
        messageDigest: null,
        presetContract: currentPresetContract,
        projectId: project.id,
      },
      fastEnabled: false,
      preset: "high",
      profileGeneration: profile.processGeneration,
      profileId: profile.id,
      projectId: project.id,
      provider: "codex",
      providerAccountKey: identifiableAccountKey,
      providerAuthentication: {
        profileId: profile.id,
        processGeneration: profile.processGeneration,
        provider: "codex",
        signedIn: true,
      },
    })).toThrow("MUTATION_EFFECT_AUTHORITY_CHANGED");
    expect(store.setProfileState(
      profile.id,
      profile.processGeneration,
      "signed_in",
      { plan: "apiKey" },
    )).toBe(true);
    expect(() => store.beginSessionStartEffect({
      providerAuthority: store.requireProviderAccountAuthority(profile.id, "codex"),
      attemptId: attempt.id,
      evidence: {
        clientMessageId: null,
        kind: "session.start",
        messageDigest: null,
        presetContract: currentPresetContract,
        projectId: project.id,
      },
      fastEnabled: false,
      preset: "high",
      profileGeneration: profile.processGeneration,
      profileId: profile.id,
      projectId: project.id,
      provider: "codex",
      providerAccountKey: identifiableAccountKey,
    })).toThrow("MUTATION_EFFECT_AUTHORITY_CHANGED");
    expect(store.readMutation("00000000-0000-4000-8000-0000000006a5"))
      .toMatchObject({ state: "prepared" });
  });
test("carries either provider's reviewed runtime profile through one session-start evidence row", async () => {
    const { store, home } = await fixture();
    const profile = signInProfile(store, "Both providers", "both-providers@example.com");
    const projectRoot = join(home, "both-providers-project");
    await mkdir(projectRoot);
    const project = await store.createProject("Both providers project", projectRoot, true);
    const initialClaudeAuthority = store.advanceProviderAccountProcessGeneration({
      profileId: profile.id,
      provider: "claude",
      expectedProcessGeneration: 0,
    });
    const claudeAuthority = store.advanceProviderAccountProcessGeneration({
      profileId: profile.id,
      provider: "claude",
      expectedProcessGeneration: initialClaudeAuthority.processGeneration,
    });
    const codexProfile = {
      approvalPolicy: "on-request" as const,
      computerUse: true as const,
      enabledApps: [],
      fast: false,
      model: "gpt-6-astra",
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
    // The Claude document has none of the Codex fields and is stored exactly
    // as the Claude port reviewed it.
    const claudeProfile = {
      claudeVersion: "2.1.260",
      inputFormat: "stream-json" as const,
      isolatedConfigDir: true as const,
      model: "claude-fable-5-1",
      nativeFallback: {
        model: "claude-opus-5" as const,
        reason: "live_acceptance_required" as const,
        status: "unavailable" as const,
      },
      observedAt: 2_100,
      outputFormat: "stream-json" as const,
      permissionMode: "default" as const,
      preset: "fable-max" as const,
      processGeneration: claudeAuthority.processGeneration,
      profileId: profile.id,
      reasoningEffort: "max" as const,
    } as const;
    const start = (
      idempotencyKey: string,
      provider: "codex" | "claude",
      preset: "high" | "fable-max",
      runtimeProfile: typeof codexProfile | typeof claudeProfile,
    ) => {
      const providerThreadId = `thread-${provider}`;
      const claudeProcessIdentity = provider === "claude"
        ? {
            pid: 42_101,
            pidDomain: "darwin" as const,
            procStart: "Fri Sep  4 12:01:00 2026",
          }
        : undefined;
      const attempt = store.prepareMutation({
        authorityGeneration: runtimeProfile.processGeneration,
        authorityId: profile.id,
        idempotencyKey,
        kind: "session.start",
        request: sessionStartMutationRequest({
          projectId: project.id,
          provider,
          preset,
          ...(preset === "high" ? { presetContract: currentPresetContract } : {}),
          fast: false,
        }),
      });
      const session = store.beginSessionStartEffect({
        attemptId: attempt.id,
        evidence: {
          clientMessageId: null,
          kind: "session.start",
          messageDigest: null,
          ...(preset === "high" ? { presetContract: currentPresetContract } : {}),
          projectId: project.id,
          runtimeProfile,
        },
        fastEnabled: false,
        preset,
        profileGeneration: runtimeProfile.processGeneration,
        profileId: profile.id,
        projectId: project.id,
        provider,
        providerAuthority: store.requireProviderAccountAuthority(profile.id, provider),
        providerAccountKey: providerAccountKeyForProfile(store, profile.id, provider),
        ...(provider !== "codex"
          ? {
              providerAuthentication: {
                profileId: profile.id,
                processGeneration: runtimeProfile.processGeneration,
                provider,
                signedIn: true as const,
              },
            }
          : {}),
      });
      const providerAuthority = store.requireProviderAccountAuthority(profile.id, provider);
      if (claudeProcessIdentity !== undefined) {
        store.recordClaimedClaudeProcessAuthority({
          providerThreadId,
          profileId: profile.id,
          profileGeneration: profile.processGeneration,
          providerAuthority,
          runtimeScope: "managed",
          sessionId: session.id,
          identity: claudeProcessIdentity,
        });
      }
      const conflictingAuthority = provider === "codex"
        ? claudeAuthority
        : store.requireProviderAccountAuthority(profile.id, "codex");
      expect(() => store.completeSessionStartEffect({
        attemptId: attempt.id,
        expectedSessionRevision: session.revision,
        providerAuthority: conflictingAuthority,
        providerThreadId: `thread-${provider}`,
        receipt: { effectiveRuntimeProfile: runtimeProfile, sessionId: session.id },
        runtimeProfile,
        sessionId: session.id,
        state: "idle",
      })).toThrow("SESSION_START_PROVIDER_AUTHORITY_MISMATCH");
      expect(store.readMutation(idempotencyKey)).toMatchObject({ state: "effect_started" });
      store.completeSessionStartEffect({
        attemptId: attempt.id,
        expectedSessionRevision: session.revision,
        providerAuthority,
        providerThreadId: `thread-${provider}`,
        receipt: { effectiveRuntimeProfile: runtimeProfile, sessionId: session.id },
        runtimeProfile,
        ...(claudeProcessIdentity === undefined ? {} : { claudeProcessIdentity }),
        sessionId: session.id,
        state: "idle",
      });
      return { attempt, session };
    };

    const codex = start("00000000-0000-4000-8000-0000000006a0", "codex", "high", codexProfile);
    const claude = start("00000000-0000-4000-8000-0000000006a1", "claude", "fable-max", claudeProfile);

    expect(store.requireSession(codex.session.id)).toMatchObject({ preset: "high", provider: "codex" });
    expect(store.requireSession(claude.session.id))
      .toMatchObject({ preset: "fable-max", provider: "claude" });
    expect(store.latestSessionRuntimeProfile(codex.session.id))
      .toMatchObject({ profile: codexProfile, sourceKind: "session_start" });
    expect(store.latestSessionRuntimeProfile(claude.session.id))
      .toMatchObject({ profile: claudeProfile, sourceKind: "session_start" });
    expect(store.readMutation("00000000-0000-4000-8000-0000000006a1")).toMatchObject({
      evidence: { evidence: { kind: "session.start", runtimeProfile: claudeProfile } },
      result: { effectiveRuntimeProfile: claudeProfile },
      state: "applied",
    });

    // Current supported rows retain each provider's canonical codec bytes.
    // Genuine retired-provider history is covered by the archived39 fixtures;
    // a current process generation must never fabricate another such row.
    const inspector = new Database(store.paths.database, { create: false, strict: true });
    try {
      const rows = inspector.query(
        "SELECT session_id,profile_json FROM session_runtime_profiles ORDER BY session_id",
      ).all() as { profile_json: string; session_id: string }[];
      const stored = new Map(rows.map((row) => [row.session_id, row.profile_json]));
      expect(stored.get(codex.session.id))
        .toBe(JSON.stringify(effectiveRuntimeProfileSchema.parse(codexProfile)));
      expect(stored.get(claude.session.id))
        .toBe(JSON.stringify(effectiveClaudeRuntimeProfileSchema.parse(claudeProfile)));
      // Devin re-admission only advances ordinary account authority; it never
      // fabricates a runtime-profile row.
      expect(store.advanceProviderAccountProcessGeneration({
        profileId: profile.id, provider: "devin", expectedProcessGeneration: 0,
      })).toMatchObject({ provider: "devin", processGeneration: 1 });
      expect(inspector.query("SELECT COUNT(*) AS count FROM session_runtime_profiles").get())
        .toEqual({ count: 2 });
    } finally {
      inspector.close(false);
    }

    // A store holding both providers' evidence opens again with no migration.
    const reopened = new StateStore(store.paths);
    stores.push(reopened);
    expect(reopened.latestSessionRuntimeProfile(codex.session.id))
      .toMatchObject({ profile: codexProfile });
    expect(reopened.latestSessionRuntimeProfile(claude.session.id))
      .toMatchObject({ profile: claudeProfile });
  });
test("rejects only exact same-home provider-switch target aliases", async () => {
    const { store } = await fixture();
    const sourceProfile = signInProfile(
      store,
      "Switch alias source",
      "switch-alias-source@example.com",
    );
    const otherProfile = signInProfile(
      store,
      "Switch alias other home",
      "switch-alias-other@example.com",
    );
    const stageSwitch = (
      session: ReturnType<StateStore["upsertProviderSession"]>,
      targetProfile: typeof sourceProfile,
      idempotencyKey: string,
      seedName: string,
    ) => {
      if (session.providerThreadId === undefined) {
        throw new Error("Expected a provider thread for switch alias testing.");
      }
      const seedDigest = createHash("sha256")
        .update("hra:session-transcript-seed:v1\0", "utf8")
        .update(seedName, "utf8")
        .digest("hex");
      const mutation = store.prepareMutation({
        authorityGeneration: targetProfile.processGeneration,
        authorityId: session.id,
        idempotencyKey,
        kind: "session.switch",
        request: sessionProviderSwitchMutationRequest({
          provider: "codex",
          preset: "high",
          presetContract: currentPresetContract,
          targetProfileId: targetProfile.id,
          seedDigest,
        }),
      providerAuthorities: [
          { role: "source", authority: store.requireProviderAccountAuthority(sourceProfile.id, "codex"), provenance: "legacy_switch_source" },
          { role: "target", authority: store.requireProviderAccountAuthority(targetProfile.id, "codex"), provenance: "legacy_switch_target" },
        ],
      });
      return store.beginSessionProviderSwitchEffect({
        attemptId: mutation.id,
        sessionId: session.id,
        evidence: {
          kind: "session.switch",
          daemonGeneration: 0,
          requestedAccountId: targetProfile.id,
          requestedPreset: "high",
          runtimeProfile: codexAdoptionRuntimeProfile(targetProfile, "high", false),
          seedDigest,
          seedIncludedRecords: 1,
          seedOmittedRecords: 0,
          sourcePreset: "high",
          sourceProcessGeneration: sourceProfile.processGeneration,
          sourceProfileId: sourceProfile.id,
          sourceProvider: "codex",
          sourceProviderThreadId: session.providerThreadId,
          targetPreset: "high",
          targetProcessGeneration: targetProfile.processGeneration,
          targetProfileId: targetProfile.id,
          targetProvider: "codex",
          targetProviderAccountKey: providerAccountKeyForProfile(
            store,
            targetProfile.id,
            "codex",
          ),
          targetHostCapabilities: testSwitchHostCapabilities,
          presetContract: currentPresetContract,
          transcriptDigest: createHash("sha256").update(seedName).digest("hex"),
        },
      });
    };

    const sameHome = upsertProvenTestSession(store, {
      profileId: sourceProfile.id,
      provider: "codex",
      providerThreadId: "same-home-switch-alias",
      preset: "high",
      fastEnabled: false,
      state: "idle",
    });
    const sameHomeEvidence = stageSwitch(
      sameHome,
      sourceProfile,
      "00000000-0000-4000-8000-0000000006a8",
      "same-home-switch-alias-seed",
    );
    expect(() => store.recordSessionProviderSwitchTarget({
      attemptId: sameHomeEvidence.attemptId,
      sessionId: sameHome.id,
      providerThreadId: sameHome.providerThreadId ?? "",
    })).toThrow("SESSION_PROVIDER_SWITCH_TARGET_AUTHORITY_MISMATCH");
    expect(store.readSessionProviderSwitchProgress(sameHomeEvidence.attemptId))
      .toMatchObject({ sourceReleased: false, targetReleased: false });

    const crossHome = upsertProvenTestSession(store, {
      profileId: sourceProfile.id,
      provider: "codex",
      providerThreadId: "cross-home-switch-alias",
      preset: "high",
      fastEnabled: false,
      state: "idle",
    });
    const crossHomeEvidence = stageSwitch(
      crossHome,
      otherProfile,
      "00000000-0000-4000-8000-0000000006a9",
      "cross-home-switch-alias-seed",
    );
    store.recordSessionProviderSwitchTarget({
      attemptId: crossHomeEvidence.attemptId,
      sessionId: crossHome.id,
      providerThreadId: crossHome.providerThreadId ?? "",
    });
    expect(store.readSessionProviderSwitchProgress(crossHomeEvidence.attemptId))
      .toMatchObject({ targetProviderThreadId: crossHome.providerThreadId });
  });
test.each(["current", "source_binding_changed", "target_binding_changed", "target_removed"] as const)(
    "quarantines a current generic switch without retiring its evidence when exact authorities remain: %s",
    async (authorityState) => {
      const { store } = await fixture();
      const source = signInProfile(store, "Legacy recovery source", "legacy-source@example.com");
      const target = store.createProfile("Legacy recovery target");
      store.advanceProviderAccountProcessGeneration({
        profileId: target.id,
        provider: "claude",
        expectedProcessGeneration: 0,
      });
      const initialTarget = store.requireProviderAccountAuthority(target.id, "claude");
      store.observeProviderAccountReadiness({
        profileId: target.id,
        provider: "claude",
        expectedBindingGeneration: initialTarget.bindingGeneration,
        readiness: "signed_in",
      });
      const sourceAuthority = store.requireProviderAccountAuthority(source.id, "codex");
      const targetAuthority = store.requireProviderAccountAuthority(target.id, "claude");
      const session = upsertProvenTestSession(store, {
        profileId: source.id, provider: "codex", preset: "high", fastEnabled: false,
        providerThreadId: "legacy-recovery-source-thread",
        state: "idle",
      });
      const key = "00000000-0000-4000-8000-0000000006d0";
      const attempt = store.prepareMutation({
        kind: "session.switch",
        authorityId: session.id,
        authorityGeneration: targetAuthority.processGeneration,
        idempotencyKey: key,
        request: sessionProviderSwitchMutationRequest({ provider: "claude", preset: "fable-max",
          targetProfileId: target.id, seedDigest: "a".repeat(64) }),
        providerAuthorities: [
          { role: "source", authority: sourceAuthority, provenance: "legacy_switch_source" },
          { role: "target", authority: targetAuthority, provenance: "legacy_switch_target" },
        ],
      });
      store.beginSessionProviderSwitchEffect({
        attemptId: attempt.id,
        sessionId: session.id,
        providerAuthentication: {
          profileId: target.id,
          processGeneration: targetAuthority.processGeneration,
          provider: "claude",
          signedIn: true,
        },
        evidence: {
          kind: "session.switch",
          daemonGeneration: 0,
          requestedAccountId: target.id,
          requestedPreset: "fable-max",
          runtimeProfile: reviewedClaudeProfile({
            id: target.id, processGeneration: targetAuthority.processGeneration,
          }),
          seedDigest: "a".repeat(64),
          seedIncludedRecords: 0,
          seedOmittedRecords: 0,
          sourcePreset: "high",
          sourceProcessGeneration: sourceAuthority.processGeneration,
          sourceProfileId: source.id,
          sourceProvider: "codex",
          sourceProviderThreadId: "legacy-recovery-source-thread",
          targetPreset: "fable-max",
          targetProcessGeneration: targetAuthority.processGeneration,
          targetProfileId: target.id,
          targetProvider: "claude",
          targetHostCapabilities: testSwitchHostCapabilities,
          targetProviderAccountKey: testProviderAccountKey("claude"),
          transcriptDigest: "b".repeat(64),
        },
      });
      const original = store.readMutation(key);
      const frozenAuthorities = store.readMutationProviderAuthorities(attempt.id);
      const dedicated = prepareDedicatedSessionSwitch(store, 781);
      const dedicatedBefore = advanceDedicatedSessionSwitch(store, dedicated, "target_starting");

      if (authorityState === "source_binding_changed") {
        expect(store.setProfileState(source.id, sourceAuthority.processGeneration, "signed_out"))
          .toBe(true);
      } else if (authorityState === "target_binding_changed") {
        store.observeProviderAccountReadiness({
          profileId: target.id,
          provider: "claude",
          expectedBindingGeneration: targetAuthority.bindingGeneration,
          readiness: "signed_out",
        });
      } else if (authorityState === "target_removed") {
        store.removeProfile(target.id);
      }

      // Do not retire daemon generations first: that separately quarantines
      // Claude effects and would hide a broken generic evidence reader.
      expect(store.recoverEffectStartedMutations()).toEqual(authorityState === "current"
        ? { recovered: [], unresolved: [] }
        : {
            recovered: [],
            unresolved: [{ id: attempt.id, kind: "session.switch", authorityId: session.id }],
          });
      expect(store.readMutation(key)).toMatchObject({
        state: "effect_started",
        evidence: original?.evidence,
      });
      expect(store.requireSession(session.id).state)
        .toBe(authorityState === "current" ? "recovery_required" : "idle");
      expect(store.readMutationProviderAuthorities(attempt.id)).toEqual(frozenAuthorities);
      expect(store.requireProviderAccountAuthority(source.id, "codex").processGeneration)
        .toBe(sourceAuthority.processGeneration);
      expect(store.requireProviderAccountForProfile(target.id, "claude", { includeRemoved: true }).processGeneration)
        .toBe(targetAuthority.processGeneration);
      expect(store.requireSessionSwitch(dedicated.switch.attemptId)).toEqual(dedicatedBefore);
      expect(store.readMutation(dedicated.switch.idempotencyKey)).toMatchObject({ state: "effect_started" });
    },
  );
test.each(["claimed", "bound", "own_tuple_changed"] as const)(
    "retains exact Claude switch recovery custody across sibling rollover: %s",
    async (processState) => {
      const { store } = await fixture();
      const source = signInProfile(store, "Retained source", "retained-source@example.com");
      const target = signInProfile(store, "Retained target", "retained-target@example.com");
      const targetAuthority = store.advanceProviderAccountProcessGeneration({
        profileId: target.id, provider: "claude", expectedProcessGeneration: 0,
      });
      const sourceAuthority = store.requireProviderAccountAuthority(source.id, "codex");
      const session = upsertProvenTestSession(store, {
        profileId: source.id, provider: "codex", preset: "high", fastEnabled: false,
        providerThreadId: "retained-source-thread", state: "idle",
      });
      const runtimeProfile = reviewedClaudeProfile({ id: target.id, processGeneration: targetAuthority.processGeneration });
      const key = "00000000-0000-4000-8000-0000000006e0";
      const seedText = "Continue the retained switch.";
      const seedDigest = createHash("sha256").update("hra:session-transcript-seed:v1\0")
        .update(seedText).digest("hex");
      const attempt = store.prepareMutation({
        kind: "session.switch", authorityId: session.id,
        authorityGeneration: targetAuthority.processGeneration,
        idempotencyKey: key, request: sessionProviderSwitchMutationRequest({ provider: "claude",
          preset: "fable-max", targetProfileId: target.id, seedDigest }),
        providerAuthorities: [
          { role: "source", authority: sourceAuthority, provenance: "legacy_switch_source" },
          { role: "target", authority: targetAuthority, provenance: "legacy_switch_target" },
        ],
      });
      store.beginSessionProviderSwitchEffect({
        attemptId: attempt.id, sessionId: session.id,
        providerAuthentication: {
          profileId: target.id, provider: "claude", signedIn: true,
          processGeneration: targetAuthority.processGeneration,
        },
        evidence: {
          kind: "session.switch", daemonGeneration: 0, requestedAccountId: target.id,
          requestedPreset: "fable-max", runtimeProfile, seedDigest,
          seedIncludedRecords: 1, seedOmittedRecords: 0,
          sourcePreset: "high", sourceProcessGeneration: sourceAuthority.processGeneration,
          sourceProfileId: source.id, sourceProvider: "codex",
          sourceProviderThreadId: "retained-source-thread", targetPreset: "fable-max",
          targetProcessGeneration: targetAuthority.processGeneration,
          targetProfileId: target.id, targetProvider: "claude",
          targetHostCapabilities: testSwitchHostCapabilities,
          targetProviderAccountKey: testProviderAccountKey("claude"), transcriptDigest: "b".repeat(64),
        },
      });
      const targetInput = { attemptId: attempt.id, sessionId: session.id, providerThreadId: "retained-target-thread" };
      store.recordSessionProviderSwitchTarget(targetInput);
      store.recordSessionProviderSwitchSeedIntent({ ...targetInput, runtimeProfile, seedText });
      store.recordSessionProviderSwitchSeedResult({ ...targetInput, runtimeProfile, turnId: "retained-seed-turn", turnStatus: "completed" });
      store.recordSessionProviderSwitchSourceReleased({ attemptId: attempt.id, sessionId: session.id });
      const processInput = { profileId: target.id, providerThreadId: targetInput.providerThreadId, runtimeScope: "managed" as const };
      store.recordClaimedClaudeProcessAuthority({
        ...processInput, profileGeneration: target.processGeneration, providerAuthority: targetAuthority,
        sessionId: session.id, identity: { pid: 43_201, pidDomain: "darwin", procStart: "Fri Sep  4 12:03:01 2026" },
      });
      const bind = () => store.bindSessionProviderSwitchRecoveryTarget({
        attemptId: attempt.id, sessionId: session.id,
        expectedSessionRevision: store.requireSession(session.id).revision,
        providerAccountKey: testProviderAccountKey("claude"), title: "Retained target", providerUpdatedAt: 2_200,
      });
      if (processState === "bound") expect(bind().provider).toBe("claude");
      store.nextProfileGeneration(target.id);
      expect(store.requireProviderAccountAuthority(target.id, "claude")).toEqual(targetAuthority);
      expect(store.requireProfileById(target.id).processGeneration).not.toBe(target.processGeneration);
      if (processState === "own_tuple_changed") {
        store.advanceProviderAccountProcessGeneration({
          profileId: target.id, provider: "claude", expectedProcessGeneration: targetAuthority.processGeneration,
        });
      }
      const beforeSession = store.requireSession(session.id);
      const beforeMutation = store.readMutation(key);
      const beforeProcess = store.readClaudeProcessAuthority(processInput);
      if (processState === "own_tuple_changed") {
        expect(bind).toThrow("SESSION_PROVIDER_SWITCH_RECOVERY_TARGET_MISMATCH");
        expect(store.requireSession(session.id)).toEqual(beforeSession);
        expect(store.readClaudeProcessAuthority(processInput)).toEqual(beforeProcess);
      } else {
        expect(bind()).toMatchObject({ provider: "claude", profileId: target.id, state: "recovery_required" });
        // Fable's model/effort pair exists in both historical contracts.
        // Legacy recovery retains the shipped [2,1] precedence, not a future default.
        expect(store.requireSessionPresetContract(session.id)).toBe(2);
        expect(store.readClaudeProcessAuthority(processInput)).toMatchObject({
          state: "bound", providerAuthority: targetAuthority, profileGeneration: target.processGeneration,
        });
        expect(store.requireCapturedSessionProviderAuthority(session.id)).toMatchObject(targetAuthority);
        if (processState === "bound") expect(store.requireSession(session.id)).toEqual(beforeSession);
      }
      expect(store.readMutation(key)).toEqual(beforeMutation);
    },
  );
test("rebinds a session to another provider and account in one transaction", async () => {
    const { store, home } = await fixture();
    const codexAccount = signInProfile(store, "Codex account", "codex@example.com");
    const claudeAccount = signInProfile(store, "Claude account", "claude@example.com");
    const initialClaudeAuthority = store.advanceProviderAccountProcessGeneration({
      profileId: claudeAccount.id,
      provider: "claude",
      expectedProcessGeneration: 0,
    });
    const claudeAuthority = store.advanceProviderAccountProcessGeneration({
      profileId: claudeAccount.id,
      provider: "claude",
      expectedProcessGeneration: initialClaudeAuthority.processGeneration,
    });
    const projectRoot = join(home, "switch-project");
    await mkdir(projectRoot);
    const project = await store.createProject("Switch project", projectRoot, true);
    const codexProfile = {
      approvalPolicy: "on-request" as const,
      computerUse: true as const,
      enabledApps: [],
      fast: false,
      model: "gpt-6-astra",
      observedAt: 2_000,
      permissionProfile: ":workspace" as const,
      pluginCapability: true as const,
      preset: "high" as const,
      processGeneration: codexAccount.processGeneration,
      profileId: codexAccount.id,
      reasoningEffort: "max" as const,
      reviewMode: "auto_review" as const,
      serviceTier: null,
    };
    const claudeProfile = {
      claudeVersion: "2.1.260",
      inputFormat: "stream-json" as const,
      isolatedConfigDir: true as const,
      model: "claude-fable-5-1",
      nativeFallback: {
        model: "claude-opus-5" as const,
        reason: "live_acceptance_required" as const,
        status: "unavailable" as const,
      },
      observedAt: 2_100,
      outputFormat: "stream-json" as const,
      permissionMode: "default" as const,
      preset: "fable-max" as const,
      processGeneration: claudeAuthority.processGeneration,
      profileId: claudeAccount.id,
      reasoningEffort: "max" as const,
    };
    const startAttempt = store.prepareMutation({
      authorityGeneration: codexAccount.processGeneration,
      authorityId: codexAccount.id,
      idempotencyKey: "00000000-0000-4000-8000-0000000006b0",
      kind: "session.start",
      request: sessionStartMutationRequest({
        projectId: project.id,
        provider: "codex",
        preset: "high",
        presetContract: currentPresetContract,
        fast: false,
      }),
    });
    const started = store.beginSessionStartEffect({
      attemptId: startAttempt.id,
      evidence: {
        clientMessageId: null,
        conversationAutomationCapability: SESSION_CONVERSATION_AUTOMATION_CAPABILITY,
        kind: "session.start",
        messageDigest: null,
        presetContract: currentPresetContract,
        projectId: project.id,
        runtimeProfile: codexProfile,
      },
      fastEnabled: false,
      preset: "high",
      profileGeneration: codexAccount.processGeneration,
      profileId: codexAccount.id,
      projectId: project.id,
      provider: "codex",
      providerAuthority: store.requireProviderAccountAuthority(codexAccount.id, "codex"),
      providerAccountKey: providerAccountKeyForProfile(store, codexAccount.id, "codex"),
    });
    store.completeSessionStartEffect({
      attemptId: startAttempt.id,
      expectedSessionRevision: started.revision,
      providerAuthority: store.requireProviderAccountAuthority(codexAccount.id, "codex"),
      providerThreadId: "codex-thread",
      receipt: { effectiveRuntimeProfile: codexProfile, sessionId: started.id },
      runtimeProfile: codexProfile,
      sessionId: started.id,
      state: "idle",
    });
    expect(store.hasNativeConversationAutomationAuthority(
      started.id,
      "codex-thread",
    )).toBe(true);

    const seedText = "Continue this session after switching providers.";
    const seedDigest = createHash("sha256")
      .update("hra:session-transcript-seed:v1\0", "utf8")
      .update(seedText, "utf8")
      .digest("hex");
    const switchAttempt = store.prepareMutation({
      authorityGeneration: claudeAuthority.processGeneration,
      authorityId: started.id,
      idempotencyKey: "00000000-0000-4000-8000-0000000006b1",
      kind: "session.switch",
      request: sessionProviderSwitchMutationRequest({
        provider: "claude",
        preset: "fable-max",
        targetProfileId: claudeAccount.id,
        seedDigest,
      }),
      providerAuthorities: [
        { role: "source", authority: store.requireProviderAccountAuthority(codexAccount.id, "codex"),
          provenance: "session_switch_source" },
        { role: "target", authority: claudeAuthority, provenance: "session_switch_target" },
      ],
    });
    const transcriptDigest = createHash("sha256").update("switch transcript").digest("hex");
    const immutableSwitchEvidence = {
      kind: "session.switch" as const,
      daemonGeneration: 0,
      requestedAccountId: null,
      requestedPreset: "fable-max" as const,
      runtimeProfile: claudeProfile,
      seedDigest,
      seedIncludedRecords: 1,
      seedOmittedRecords: 0,
      sourcePreset: "high" as const,
      sourceProcessGeneration: codexAccount.processGeneration,
      sourceProfileId: codexAccount.id,
      sourceProvider: "codex" as const,
      sourceProviderThreadId: "codex-thread",
      targetPreset: "fable-max" as const,
      targetProcessGeneration: claudeAuthority.processGeneration,
      targetProfileId: claudeAccount.id,
      targetProvider: "claude" as const,
      targetProviderAccountKey: testProviderAccountKey("claude"),
      targetHostCapabilities: testSwitchHostCapabilities,
      transcriptDigest,
    };
    expect(() => store.beginSessionProviderSwitchEffect({
      attemptId: switchAttempt.id,
      sessionId: started.id,
      providerAuthentication: {
        profileId: claudeAccount.id,
        processGeneration: claudeAuthority.processGeneration,
        provider: "claude",
        signedIn: true,
      },
      evidence: { ...immutableSwitchEvidence, targetHostCapabilities: undefined },
    })).toThrow("SESSION_PROVIDER_SWITCH_HOST_CAPABILITY_MISMATCH");
    expect(() => store.beginSessionProviderSwitchEffect({
      attemptId: switchAttempt.id,
      sessionId: started.id,
      providerAuthentication: {
        profileId: claudeAccount.id,
        processGeneration: claudeAccount.processGeneration,
        provider: "claude",
        signedIn: true,
      },
      evidence: immutableSwitchEvidence,
    })).toThrow("SESSION_PROVIDER_SWITCH_AUTHENTICATION_MISMATCH");
    expect(() => store.beginSessionProviderSwitchEffect({
      attemptId: switchAttempt.id,
      sessionId: started.id,
      providerAuthentication: {
        profileId: claudeAccount.id,
        processGeneration: claudeAuthority.processGeneration,
        provider: "claude",
        signedIn: true,
      },
      evidence: { ...immutableSwitchEvidence, daemonGeneration: 1 },
    })).toThrow("SESSION_PROVIDER_SWITCH_AUTHORITY_CHANGED");
    expect(store.readMutation("00000000-0000-4000-8000-0000000006b1"))
      .toMatchObject({ state: "prepared" });
    const switchEvidence = store.beginSessionProviderSwitchEffect({
      attemptId: switchAttempt.id,
      sessionId: started.id,
      providerAuthentication: {
        profileId: claudeAccount.id,
        processGeneration: claudeAuthority.processGeneration,
        provider: "claude",
        signedIn: true,
      },
      evidence: immutableSwitchEvidence,
    });
    expect(() => store.resolveSessionMutation({
      attemptId: switchAttempt.id,
      expectedEvidenceDigest: switchEvidence.digest,
      expectedOriginalState: "effect_started",
      receipt: { forged: true },
      resolution: "abandoned",
      resolutionEvidence: { localOnly: true },
    })).toThrow("SESSION_PROVIDER_SWITCH_RECOVERY_RECEIPT_UNEXPECTED");
    expect(() => store.resolveSessionMutation({
      attemptId: switchAttempt.id,
      expectedEvidenceDigest: switchEvidence.digest,
      expectedOriginalState: "effect_started",
      resolution: "proven_applied",
      resolutionEvidence: { exact: false },
    })).toThrow("SESSION_PROVIDER_SWITCH_RECOVERY_RECEIPT_REQUIRED");
    expect(store.readMutation("00000000-0000-4000-8000-0000000006b1"))
      .toMatchObject({ state: "effect_started" });
    store.recordSessionProviderSwitchTarget({
      attemptId: switchAttempt.id,
      sessionId: started.id,
      providerThreadId: "claude-thread",
    });
    expect(() => store.recordSessionProviderSwitchTargetReleased({
      attemptId: switchAttempt.id,
      sessionId: started.id,
      providerThreadId: "claude-thread",
      providerAccountKey: `v1:claude:${"f".repeat(64)}`,
    })).toThrow("SESSION_PROVIDER_SWITCH_TARGET_RELEASE_AUTHORITY_MISMATCH");
    store.recordSessionProviderSwitchSeedIntent({
      attemptId: switchAttempt.id,
      sessionId: started.id,
      providerThreadId: "claude-thread",
      runtimeProfile: claudeProfile,
      seedText,
    });
    store.recordSessionProviderSwitchSeedResult({
      attemptId: switchAttempt.id,
      sessionId: started.id,
      providerThreadId: "claude-thread",
      runtimeProfile: claudeProfile,
      turnId: "claude-turn",
      turnStatus: "completed",
    });
    store.recordSessionProviderSwitchSourceReleased({
      attemptId: switchAttempt.id,
      sessionId: started.id,
    });
    const before = store.requireSession(started.id);
    const claudeProcessIdentity = {
      pid: 42_102,
      pidDomain: "darwin" as const,
      procStart: "Fri Sep  4 12:01:01 2026",
    };
    store.recordClaimedClaudeProcessAuthority({
      providerAuthority: store.requireProviderAccountAuthority(claudeAccount.id, "claude"),
      providerThreadId: "claude-thread",
      profileId: claudeAccount.id,
      profileGeneration: claudeAccount.processGeneration,
      runtimeScope: "managed",
      sessionId: started.id,
      identity: claudeProcessIdentity,
    });
    const switchReceipt = {
      from: { account: codexAccount.id, preset: "high" as const, provider: "codex" as const },
      providerThreadId: "claude-thread",
      request: { accountId: null, preset: "fable-max" as const, provider: "claude" as const },
      seed: {
        digest: seedDigest,
        includedRecords: 1,
        omittedRecords: 0,
        status: "completed" as const,
      },
      sessionId: started.id,
      to: { account: claudeAccount.id, preset: "fable-max" as const, provider: "claude" as const },
      transcriptDigest,
      turnId: "claude-turn",
    };
    const targetHostCapabilities = {
      preambleVersion: 1,
      preambleDigest: "a".repeat(64),
      manifestVersion: 1,
      manifestDigest: "b".repeat(64),
    };
    expect(() => store.completeSessionProviderSwitch({
      providerAuthority: store.requireProviderAccountAuthority(claudeAccount.id, "claude"),
      attemptId: switchAttempt.id,
      expectedSessionRevision: before.revision,
      expectedTargetProfileGeneration: claudeAccount.processGeneration,
      preset: "fable-max",
      profileId: claudeAccount.id,
      provider: "claude",
      providerThreadId: "claude-thread",
      providerAccountKey: testProviderAccountKey("claude"),
      claudeProcessIdentity,
      hostCapabilities: targetHostCapabilities,
      receipt: { ...switchReceipt, turnId: "wrong-turn" },
      runtimeProfile: claudeProfile,
      seedTurnId: "claude-turn",
      sessionId: started.id,
      state: "idle",
    })).toThrow("SESSION_PROVIDER_SWITCH_RECEIPT_MISMATCH");
    expect(store.requireSession(started.id).provider).toBe("codex");
    expect(() => store.completeSessionProviderSwitch({
      providerAuthority: store.requireProviderAccountAuthority(claudeAccount.id, "claude"),
      attemptId: switchAttempt.id,
      expectedSessionRevision: before.revision - 1,
      expectedTargetProfileGeneration: claudeAccount.processGeneration,
      preset: "fable-max",
      profileId: claudeAccount.id,
      provider: "claude",
      providerThreadId: "claude-thread",
      providerAccountKey: testProviderAccountKey("claude"),
      claudeProcessIdentity,
      hostCapabilities: targetHostCapabilities,
      receipt: switchReceipt,
      runtimeProfile: claudeProfile,
      seedTurnId: "claude-turn",
      sessionId: started.id,
      state: "idle",
    })).toThrow("SESSION_PROVIDER_SWITCH_CAS_CONFLICT");
    expect(() => store.completeSessionProviderSwitch({
      providerAuthority: store.requireProviderAccountAuthority(claudeAccount.id, "claude"),
      attemptId: switchAttempt.id,
      expectedSessionRevision: before.revision,
      expectedTargetProfileGeneration: claudeAccount.processGeneration,
      preset: "fable-max",
      profileId: claudeAccount.id,
      provider: "claude",
      providerThreadId: "claude-thread",
      providerAccountKey: testProviderAccountKey("claude"),
      claudeProcessIdentity,
      hostCapabilities: {
        ...targetHostCapabilities,
        manifestDigest: "c".repeat(64),
      },
      receipt: switchReceipt,
      runtimeProfile: claudeProfile,
      seedTurnId: "claude-turn",
      sessionId: started.id,
      state: "idle",
    })).toThrow("SESSION_PROVIDER_SWITCH_EFFECT_EVIDENCE_MISMATCH");
    const switched = store.completeSessionProviderSwitch({
      attemptId: switchAttempt.id,
      expectedSessionRevision: before.revision,
      expectedTargetProfileGeneration: claudeAccount.processGeneration,
      preset: "fable-max",
      profileId: claudeAccount.id,
      provider: "claude",
      providerThreadId: "claude-thread",
      hostCapabilities: targetHostCapabilities,
      receipt: switchReceipt,
      runtimeProfile: claudeProfile,
      providerAuthority: claudeAuthority,
      providerAccountKey: testProviderAccountKey("claude"),
      claudeProcessIdentity,
      seedTurnId: "claude-turn",
      sessionId: started.id,
      state: "idle",
    });
    // The provider, the account, the preset, and the thread are one binding.
    expect(switched).toMatchObject({
      preset: "fable-max",
      profileId: claudeAccount.id,
      provider: "claude",
      providerThreadId: "claude-thread",
    });
    // The runtime-profile authority guard requires the row's account to equal
    // the session's, so the rebind must land before the profile is inserted.
    expect(store.latestSessionRuntimeProfile(started.id)).toMatchObject({
      profile: { ...claudeProfile, profileId: claudeAccount.id },
      sourceKind: "turn_start",
    });
    expect(store.readMutation("00000000-0000-4000-8000-0000000006b1")).toMatchObject({
      result: {
        session: {
          id: started.id,
          profileId: claudeAccount.id,
          provider: "claude",
          providerThreadId: "claude-thread",
        },
      },
      state: "applied",
    });
    expect(store.requireSessionHostCapabilityBinding(started.id)).toMatchObject({
      preambleVersion: 1,
      preambleDigest: "a".repeat(64),
      manifestVersion: 1,
      manifestDigest: "b".repeat(64),
    });
    expect(store.hasNativeConversationAutomationAuthority(
      started.id,
      "codex-thread",
    )).toBe(false);
    expect(store.hasNativeConversationAutomationAuthority(
      started.id,
      "claude-thread",
    )).toBe(false);
    expect(store.isConversationAutomationEnabled(
      started.id,
      "claude-thread",
    )).toBe(true);

    // A stale revision never rebinds, and a preset the target cannot run is
    // refused before anything is written.
    const sourceProcess = store.readClaudeProcessAuthority({
      providerThreadId: "claude-thread",
      profileId: claudeAccount.id,
      runtimeScope: "managed",
    });
    if (sourceProcess === null) throw new Error("Expected the bound Claude process authority.");
    const releasingSource = store.beginClaudeProcessAuthorityRelease({
      providerThreadId: sourceProcess.providerThreadId,
      profileId: sourceProcess.profileId,
      runtimeScope: sourceProcess.runtimeScope,
      expectedRevision: sourceProcess.revision,
      identity: sourceProcess.identity,
    });
    store.completeClaudeProcessAuthorityRelease({
      providerThreadId: releasingSource.providerThreadId,
      profileId: releasingSource.profileId,
      runtimeScope: releasingSource.runtimeScope,
      expectedRevision: releasingSource.revision,
      identity: releasingSource.identity,
    });
    const replacementProcessIdentity = {
      pid: 42_103,
      pidDomain: "darwin" as const,
      procStart: "Fri Sep  4 12:01:02 2026",
    };
    store.recordClaimedClaudeProcessAuthority({
      providerAuthority: store.requireProviderAccountAuthority(claudeAccount.id, "claude"),
      providerThreadId: "claude-thread-2",
      profileId: claudeAccount.id,
      profileGeneration: claudeAccount.processGeneration,
      runtimeScope: "managed",
      sessionId: started.id,
      identity: replacementProcessIdentity,
    });
    expect(() => store.completeSessionProviderSwitch({
      providerAuthority: store.requireProviderAccountAuthority(claudeAccount.id, "claude"),
      attemptId: switchAttempt.id,
      expectedSessionRevision: before.revision,
      expectedTargetProfileGeneration: claudeAccount.processGeneration,
      preset: "fable-max",
      profileId: claudeAccount.id,
      provider: "claude",
      providerThreadId: "claude-thread-2",
      receipt: {},
      runtimeProfile: claudeProfile,
      providerAccountKey: testProviderAccountKey("claude"),
      claudeProcessIdentity: replacementProcessIdentity,
      hostCapabilities: testSwitchHostCapabilities,
      seedTurnId: "claude-turn",
      sessionId: started.id,
      state: "idle",
    })).toThrow("SESSION_PROVIDER_SWITCH_CAS_CONFLICT");
    expect(() => store.completeSessionProviderSwitch({
      attemptId: switchAttempt.id,
      expectedSessionRevision: switched.revision,
      expectedTargetProfileGeneration: claudeAccount.processGeneration,
      preset: "high",
      profileId: claudeAccount.id,
      provider: "claude",
      providerThreadId: "claude-thread-2",
      receipt: {},
      runtimeProfile: claudeProfile,
      providerAuthority: claudeAuthority,
      providerAccountKey: testProviderAccountKey("claude"),
      seedTurnId: "claude-turn",
      sessionId: started.id,
      state: "idle",
    })).toThrow("does not support the `high` model preset");
    expect(store.requireSession(started.id).providerThreadId).toBe("claude-thread");
  });
test("rejects provider-switch completion after the captured target profile generation changes without rebinding", async () => {
    const scenarios: readonly ("signed_out" | "new_generation")[] = ["new_generation"];
    for (const scenario of scenarios) {
      const { store } = await fixture();
      const sourceAccount = signInProfile(
        store,
        `Switch source ${scenario}`,
        `source-${scenario}@example.com`,
      );
      const targetAccount = signInProfile(
        store,
        `Switch target ${scenario}`,
        `target-${scenario}@example.com`,
      );
      const targetAuthority = store.requireProviderAccountAuthority(targetAccount.id, "claude");
      const session = upsertProvenTestSession(store, {
        profileId: sourceAccount.id,
        provider: "codex",
        preset: "high",
        fastEnabled: false,
        providerThreadId: `source-thread-${scenario}`,
        state: "idle",
      });
      const idempotencyKey = scenario === "signed_out"
        ? "00000000-0000-4000-8000-0000000006b3"
        : "00000000-0000-4000-8000-0000000006b4";
      const sourceAuthority = capturedProviderAuthorityForTest(store, session.id);
      const runtimeProfile = reviewedClaudeProfile({ id: targetAccount.id,
        processGeneration: targetAuthority.processGeneration });
      const seedText = "Keep the captured target profile generation fenced.";
      const seedDigest = createHash("sha256").update("hra:session-transcript-seed:v1\0")
        .update(seedText).digest("hex");
      const attempt = store.prepareMutation({
        authorityGeneration: targetAuthority.processGeneration,
        authorityId: session.id,
        idempotencyKey,
        kind: "session.switch",
        request: sessionProviderSwitchMutationRequest({ preset: "fable-max", provider: "claude",
          targetProfileId: targetAccount.id, seedDigest }),
        providerAuthorities: [
          { role: "source", authority: sourceAuthority, provenance: "session_switch_source" },
          { role: "target", authority: targetAuthority, provenance: "session_switch_target" },
        ],
      });
      store.beginSessionProviderSwitchEffect({ attemptId: attempt.id, sessionId: session.id,
        providerAuthentication: { profileId: targetAccount.id, provider: "claude", signedIn: true,
          processGeneration: targetAuthority.processGeneration },
        evidence: { kind: "session.switch", daemonGeneration: 0, requestedAccountId: targetAccount.id,
          requestedPreset: "fable-max", runtimeProfile, seedDigest, seedIncludedRecords: 1, seedOmittedRecords: 0,
          sourcePreset: "high", sourceProcessGeneration: sourceAuthority.processGeneration,
          sourceProfileId: sourceAccount.id, sourceProvider: "codex", sourceProviderThreadId: `source-thread-${scenario}`,
          targetPreset: "fable-max", targetProcessGeneration: targetAuthority.processGeneration,
          targetProfileId: targetAccount.id, targetProvider: "claude",
          targetProviderAccountKey: testProviderAccountKey("claude"), targetHostCapabilities: testSwitchHostCapabilities,
          transcriptDigest: "7".repeat(64) },
      });
      const processIdentity = {
        pid: scenario === "signed_out" ? 42_104 : 42_105,
        pidDomain: "darwin" as const,
        procStart: scenario === "signed_out"
          ? "Fri Sep  4 12:01:03 2026"
          : "Fri Sep  4 12:01:04 2026",
      };
      const providerThreadId = `target-thread-${scenario}`;
      const targetInput = { attemptId: attempt.id, sessionId: session.id, providerThreadId };
      store.recordSessionProviderSwitchTarget(targetInput);
      store.recordSessionProviderSwitchSeedIntent({ ...targetInput, runtimeProfile, seedText });
      store.recordSessionProviderSwitchSeedResult({ ...targetInput, runtimeProfile,
        turnId: "unused-target-drift-turn", turnStatus: "completed" });
      store.recordSessionProviderSwitchSourceReleased({ attemptId: attempt.id, sessionId: session.id });
      store.recordClaimedClaudeProcessAuthority({ profileId: targetAccount.id,
        profileGeneration: targetAccount.processGeneration, providerAuthority: targetAuthority,
        sessionId: session.id, providerThreadId, runtimeScope: "managed", identity: processIdentity });

      if (scenario === "signed_out") {
        expect(store.setProfileState(
          targetAccount.id,
          targetAccount.processGeneration,
          "signed_out",
        )).toBe(true);
        expect(store.requireProfileById(targetAccount.id)).toMatchObject({
          state: "signed_out",
          processGeneration: targetAccount.processGeneration,
        });
      } else {
        // The independent Codex/profile counter can advance normally. It is
        // not a fabricated Claude process successor; completion still owns
        // the separate captured target-profile CAS supplied below.
        store.nextProfileGeneration(targetAccount.id);
        expect(store.requireProviderAccountAuthority(targetAccount.id, "claude")).toEqual(targetAuthority);
        expect(store.requireProfileById(targetAccount.id)).toMatchObject({
          state: "signed_in",
          processGeneration: targetAccount.processGeneration + 1,
        });
      }
      const beforeSession = store.requireSession(session.id);
      const beforeMutation = store.readMutation(idempotencyKey);
      expect(beforeMutation).toMatchObject({
        authorityGeneration: targetAuthority.processGeneration,
        authorityId: session.id,
        state: "effect_started",
      });

      expect(() => store.completeSessionProviderSwitch({
        providerAuthority: targetAuthority,
        attemptId: attempt.id,
        expectedSessionRevision: session.revision,
        expectedTargetProfileGeneration: targetAccount.processGeneration,
        preset: "fable-max",
        profileId: targetAccount.id,
        provider: "claude",
        providerThreadId,
        receipt: { providerThreadId, sessionId: session.id, toProvider: "claude" },
        providerAccountKey: testProviderAccountKey("claude"),
        hostCapabilities: testSwitchHostCapabilities,
        runtimeProfile,
        claudeProcessIdentity: processIdentity,
        seedTurnId: "unused-target-drift-turn",
        sessionId: session.id,
        state: "idle",
      })).toThrow("SESSION_PROVIDER_SWITCH_TARGET_AUTHORITY_CHANGED");

      expect(store.requireSession(session.id)).toEqual(beforeSession);
      expect(store.readMutation(idempotencyKey)).toEqual(beforeMutation);
      expect(store.latestSessionRuntimeProfile(session.id)).toBeNull();
    }
  });
test("retires personal runtime custody while preserving an inert original-authority queue after a provider switch", async () => {
    const { store } = await fixture();
    const codexAccount = signInProfile(store, "Adopted Codex", "adopted-codex@example.com");
    const claudeAccount = signInProfile(store, "Adopted Claude", "adopted-claude@example.com");
    const claudeAuthority = store.advanceProviderAccountProcessGeneration({ profileId: claudeAccount.id,
      provider: "claude", expectedProcessGeneration: 0 });
    store.setSessionAdoptionPolicy({ provider: "codex", profileId: codexAccount.id });
    const candidate = store.upsertSessionAdoptionCandidate({
      provider: "codex",
      providerThreadId: "adopted-switch-thread",
      title: "Adopted switch",
      state: "idle",
      providerUpdatedAt: 10,
      liveness: "not_live",
    });
    const claimed = store.fenceSessionAdoptionCandidateForClaim({
      provider: "codex",
      providerThreadId: candidate.providerThreadId,
      expectedRevision: candidate.revision,
    });
    const adopted = store.adoptSessionCandidate({
      providerAuthority: store.requireProviderAccountAuthority(codexAccount.id, "codex"),
      provider: "codex",
      providerThreadId: candidate.providerThreadId,
      expectedCandidateRevision: claimed.revision,
      profileId: codexAccount.id,
      profileGeneration: codexAccount.processGeneration,
      preset: "high",
      requirement: presetRequirements.high,
      fastEnabled: false,
      runtimeProfile: codexAdoptionRuntimeProfile(codexAccount, "high", false),
      providerAccountKey: providerAccountKeyForProfile(store, codexAccount.id, "codex"),
    });
    const oldConnectionId = "10000000-0000-4000-8000-000000000201";
    const queuedAcrossSwitch = store.enqueueIdempotent({
      idempotencyKey: "00000000-0000-4000-8000-0000000006b1",
      message: "preserve this message across the provider switch",
      profileGeneration: codexAccount.processGeneration,
      providerConnectionId: oldConnectionId,
      providerAuthority: store.requireProviderAccountAuthority(codexAccount.id, "codex"),
      sessionId: adopted.session.id,
    });
    const originalQueueAuthority = store.readQueueProviderAuthority(queuedAcrossSwitch.id);
    expect(originalQueueAuthority).toEqual(
      store.requireProviderAccountAuthority(codexAccount.id, "codex"),
    );
    const originalQueueManifest = store.messageAttachmentManifest(adopted.session.id, queuedAcrossSwitch.id);
    expect(originalQueueManifest).toEqual([]);

    const direct = new Database(store.paths.database, { create: false, strict: true });
    try {
      expect(() => direct.query(
        "UPDATE sessions SET provider_thread_id=? WHERE id=?",
      ).run("unfenced-thread", adopted.session.id))
        .toThrow("active personal runtime binding must be retired before session rebind");
    } finally {
      direct.close(false);
    }

    const claudeProfile = reviewedClaudeProfile({ id: claudeAccount.id, processGeneration: claudeAuthority.processGeneration });
    const seedText = "Continue the adopted session on Claude.";
    const seedDigest = createHash("sha256")
      .update("hra:session-transcript-seed:v1\0", "utf8")
      .update(seedText, "utf8")
      .digest("hex");
    const transcriptDigest = createHash("sha256")
      .update("adopted provider-switch transcript")
      .digest("hex");
    const switchAttempt = store.prepareMutation({
      authorityGeneration: claudeAuthority.processGeneration,
      authorityId: adopted.session.id,
      idempotencyKey: "00000000-0000-4000-8000-0000000006b2",
      kind: "session.switch",
      request: sessionProviderSwitchMutationRequest({
        provider: "claude",
        preset: "fable-max",
        targetProfileId: claudeAccount.id,
        seedDigest,
      }),
      providerAuthorities: [
        { role: "source", authority: store.requireProviderAccountAuthority(codexAccount.id, "codex"), provenance: "legacy_switch_source" },
        { role: "target", authority: claudeAuthority, provenance: "legacy_switch_target" },
      ],
    });
    store.beginSessionProviderSwitchEffect({
      attemptId: switchAttempt.id,
      sessionId: adopted.session.id,
      providerAuthentication: {
        profileId: claudeAccount.id,
        processGeneration: claudeAuthority.processGeneration,
        provider: "claude",
        signedIn: true,
      },
      evidence: {
        kind: "session.switch",
        daemonGeneration: 0,
        requestedAccountId: null,
        requestedPreset: "fable-max",
        runtimeProfile: claudeProfile,
        seedDigest,
        seedIncludedRecords: 1,
        seedOmittedRecords: 0,
        sourcePreset: "high",
        sourceProcessGeneration: codexAccount.processGeneration,
        sourceProfileId: codexAccount.id,
        sourceProvider: "codex",
        sourceProviderThreadId: candidate.providerThreadId,
        targetPreset: "fable-max",
        targetProcessGeneration: claudeAuthority.processGeneration,
        targetProfileId: claudeAccount.id,
        targetProvider: "claude",
        targetProviderAccountKey: testProviderAccountKey("claude"),
        targetHostCapabilities: testSwitchHostCapabilities,
        transcriptDigest,
      },
    });
    store.recordSessionProviderSwitchTarget({
      attemptId: switchAttempt.id,
      sessionId: adopted.session.id,
      providerThreadId: "claimed-claude-thread",
    });
    store.recordSessionProviderSwitchSeedIntent({
      attemptId: switchAttempt.id,
      sessionId: adopted.session.id,
      providerThreadId: "claimed-claude-thread",
      runtimeProfile: claudeProfile,
      seedText,
    });
    store.recordSessionProviderSwitchSeedResult({
      attemptId: switchAttempt.id,
      sessionId: adopted.session.id,
      providerThreadId: "claimed-claude-thread",
      runtimeProfile: claudeProfile,
      turnId: "claimed-claude-turn",
      turnStatus: "inProgress",
    });
    store.recordSessionProviderSwitchSourceReleased({
      attemptId: switchAttempt.id,
      sessionId: adopted.session.id,
    });
    const switchReceipt = {
      from: { account: codexAccount.id, preset: "high" as const, provider: "codex" as const },
      providerThreadId: "claimed-claude-thread",
      request: { accountId: null, preset: "fable-max" as const, provider: "claude" as const },
      seed: {
        digest: seedDigest,
        includedRecords: 1,
        omittedRecords: 0,
        status: "inProgress" as const,
      },
      sessionId: adopted.session.id,
      to: {
        account: claudeAccount.id,
        preset: "fable-max" as const,
        provider: "claude" as const,
      },
      transcriptDigest,
      turnId: "claimed-claude-turn",
    };
    const targetProcessIdentity = {
      pid: 42_002,
      pidDomain: "darwin" as const,
      procStart: "Fri Sep  4 12:00:01 2026",
    };
    store.recordClaimedClaudeProcessAuthority({
      providerAuthority: store.requireProviderAccountAuthority(claudeAccount.id, "claude"),
      providerThreadId: "claimed-claude-thread",
      profileId: claudeAccount.id,
      profileGeneration: claudeAuthority.processGeneration,
      runtimeScope: "managed",
      sessionId: adopted.session.id,
      identity: targetProcessIdentity,
    });
    let switched = store.completeSessionProviderSwitch({
      providerAuthority: store.requireProviderAccountAuthority(claudeAccount.id, "claude"),
      attemptId: switchAttempt.id,
      expectedSessionRevision: adopted.session.revision,
      expectedTargetProfileGeneration: claudeAuthority.processGeneration,
      preset: "fable-max",
      profileId: claudeAccount.id,
      provider: "claude",
      providerThreadId: "claimed-claude-thread",
      receipt: switchReceipt,
      runtimeProfile: claudeProfile,
      providerAccountKey: testProviderAccountKey("claude"),
      claudeProcessIdentity: targetProcessIdentity,
      hostCapabilities: testSwitchHostCapabilities,
      seedTurnId: "claimed-claude-turn",
      sessionId: adopted.session.id,
      state: "active",
      activeTurnId: "claimed-claude-turn",
    });
    expect(switched).toMatchObject({
      activeTurnId: "claimed-claude-turn",
      profileId: claudeAccount.id,
      provider: "claude",
      providerThreadId: "claimed-claude-thread",
      revision: adopted.session.revision + 2,
      state: "active",
    });
    switched = store.reconcileSessionFromProvider({
      sessionId: switched.id,
      state: "idle",
      activeTurnId: null,
    });
    expect(store.readSessionPersonalRuntimeBinding(switched.id)).toBeNull();
    expect(store.readSessionPersonalRuntimeBinding(switched.id, true)).toMatchObject({
      provider: "codex",
      providerThreadId: "adopted-switch-thread",
      state: "detached",
    });
    expect(store.canReleaseIdleManagedClaudeSessionForAccountLogin({
      profileId: claudeAccount.id,
      profileGeneration: claudeAuthority.processGeneration,
      sessionId: switched.id,
    })).toBe(false);
    expect(store.listNonterminalManagedClaudeSessions(claudeAccount.id))
      .toEqual([switched]);
    expect(store.listLocalSessionPage({
      profileId: claudeAccount.id,
      after: null,
      limit: 1,
    })).toEqual({ sessions: [switched], nextPosition: null });
    expect(store.listSessionAdoptionCandidates({ provider: "codex" })[0]?.status)
      .toBe("fenced");

    const switchEvents = store.listSessionEvents({
      sessionId: switched.id,
      afterSequence: 0,
    }).events;
    expect(switchEvents).toEqual([
      expect.objectContaining({
        body: expect.objectContaining({
          type: "provider_switched",
          fromProvider: "codex",
          toProvider: "claude",
          transcriptDigest,
          seedDigest,
        }),
      }),
      expect.objectContaining({
        body: expect.objectContaining({
          type: "user_message",
          actor: "provider_switch",
          text: seedText,
        }),
      }),
    ]);

    const newConnectionId = "10000000-0000-4000-8000-000000000202";
    expect(store.requireQueue(queuedAcrossSwitch.id)).toEqual(queuedAcrossSwitch);
    expect(store.readQueueProviderAuthority(queuedAcrossSwitch.id)).toEqual(originalQueueAuthority);
    expect(store.messageAttachmentManifest(switched.id, queuedAcrossSwitch.id)).toEqual(originalQueueManifest);
    const queueMutationBeforeDispatch = store.readMutation("00000000-0000-4000-8000-0000000006b1");
    expect(() => store.beginQueueEffect({
      evidence: {
        baseline: { activeTurnId: null, providerUpdatedAt: null, status: "idle" },
        clientMessageId: queuedAcrossSwitch.id,
        kind: "queue.dispatch",
        messageDigest: createHash("sha256")
          .update("preserve this message across the provider switch")
          .digest("hex"),
        profileGeneration: claudeAuthority.processGeneration,
        providerThreadId: "claimed-claude-thread",
        queueId: queuedAcrossSwitch.id,
        runtimeProfile: claudeProfile,
        sessionId: switched.id,
      },
      profileGeneration: claudeAuthority.processGeneration,
      providerConnectionId: newConnectionId,
      providerAuthority: claudeAuthority,
      queueId: queuedAcrossSwitch.id,
      sessionId: switched.id,
    })).toThrow("QUEUE_PROVIDER_AUTHORITY_MISMATCH");
    expect(store.requireQueue(queuedAcrossSwitch.id)).toEqual(queuedAcrossSwitch);
    expect(store.readQueueProviderAuthority(queuedAcrossSwitch.id)).toEqual(originalQueueAuthority);
    expect(store.messageAttachmentManifest(switched.id, queuedAcrossSwitch.id)).toEqual(originalQueueManifest);
    expect(store.readQueueEffect(queuedAcrossSwitch.id)).toBeNull();
    expect(store.readMutation("00000000-0000-4000-8000-0000000006b1"))
      .toEqual(queueMutationBeforeDispatch);
    expect(store.canReleaseIdleManagedClaudeSessionForAccountLogin({
      profileId: claudeAccount.id,
      profileGeneration: claudeAuthority.processGeneration,
      sessionId: switched.id,
    })).toBe(false);

    store.setSessionAdoptionPolicy({ provider: "codex", profileId: null });
    store.setSessionAdoptionPolicy({ provider: "codex", profileId: codexAccount.id });
    const pendingAgain = store.listSessionAdoptionCandidates({
      provider: "codex",
      status: "pending",
    })[0];
    if (pendingAgain === undefined) throw new Error("Expected the switched identity to be pending again.");
    const claimedAgain = store.fenceSessionAdoptionCandidateForClaim({
      provider: "codex",
      providerThreadId: pendingAgain.providerThreadId,
      expectedRevision: pendingAgain.revision,
    });
    const readopted = store.adoptSessionCandidate({
      providerAuthority: store.requireProviderAccountAuthority(codexAccount.id, "codex"),
      provider: "codex",
      providerThreadId: pendingAgain.providerThreadId,
      expectedCandidateRevision: claimedAgain.revision,
      profileId: codexAccount.id,
      profileGeneration: codexAccount.processGeneration,
      preset: "ultra",
      requirement: presetRequirements.ultra,
      fastEnabled: true,
      runtimeProfile: codexAdoptionRuntimeProfile(codexAccount, "ultra", true),
      providerAccountKey: providerAccountKeyForProfile(store, codexAccount.id, "codex"),
    });

    expect(readopted.session).toMatchObject({
      profileId: codexAccount.id,
      provider: "codex",
      providerThreadId: "adopted-switch-thread",
      preset: "ultra",
      fastEnabled: true,
    });
    expect(readopted.session.id).not.toBe(switched.id);
    expect(readopted.binding).toMatchObject({
      sessionId: readopted.session.id,
      provider: "codex",
      providerThreadId: "adopted-switch-thread",
      state: "active",
    });
    expect(store.requireSession(switched.id)).toMatchObject({
      profileId: claudeAccount.id,
      provider: "claude",
      providerThreadId: "claimed-claude-thread",
      preset: "fable-max",
    });
    expect(store.readSessionPersonalRuntimeBinding(switched.id, true)).toBeNull();
    expect(store.latestSessionRuntimeProfile(switched.id)).toMatchObject({
      sourceId: switchAttempt.id,
      sourceKind: "turn_start",
      profile: claudeProfile,
    });
    expect(store.listSessionEvents({
      sessionId: switched.id,
      afterSequence: 0,
    }).events).toEqual(switchEvents);
  });
test("rejects a legacy rebound provider-switch digest before writing effect evidence", async () => {
    const { store } = await fixture();
    const sourceProfile = signInProfile(store, "Legacy switch source", "legacy-source@example.com");
    const targetProfile = signInProfile(store, "Legacy switch target", "legacy-target@example.com");
    const session = upsertProvenTestSession(store, {
      fastEnabled: false,
      preset: "fable-max",
      profileId: sourceProfile.id,
      provider: "claude",
      providerThreadId: "legacy-switch-source-thread",
      state: "idle",
    });
    expect(store.sessionAccountAuthorityMatches(session.id, sourceProfile.id)).toBe(true);
    const seedDigest = createHash("sha256").update("legacy switch seed").digest("hex");
    const key = "00000000-0000-4000-8000-0000000006b4";
    const attempt = store.prepareMutation({
      authorityGeneration: targetProfile.processGeneration,
      authorityId: session.id,
      idempotencyKey: key,
      kind: "session.switch",
      request: {
        provider: "codex",
        preset: "high",
        targetProfileId: targetProfile.id,
        seedDigest,
      },
    });
    const runtimeProfile = {
      approvalPolicy: "on-request" as const,
      computerUse: true as const,
      enabledApps: [],
      fast: false,
      model: "gpt-6-astra",
      observedAt: 2_000,
      permissionProfile: ":workspace" as const,
      pluginCapability: true as const,
      preset: "high" as const,
      processGeneration: targetProfile.processGeneration,
      profileId: targetProfile.id,
      reasoningEffort: "max" as const,
      reviewMode: "auto_review" as const,
      serviceTier: null,
    };

    expect(() => store.beginSessionProviderSwitchEffect({
      attemptId: attempt.id,
      evidence: {
        daemonGeneration: 0,
        kind: "session.switch",
        requestedAccountId: targetProfile.id,
        requestedPreset: "high",
        runtimeProfile,
        seedDigest,
        seedIncludedRecords: 0,
        seedOmittedRecords: 0,
        sourcePreset: "fable-max",
        sourceProcessGeneration: sourceProfile.processGeneration,
        sourceProfileId: sourceProfile.id,
        sourceProvider: "claude",
        sourceProviderThreadId: "legacy-switch-source-thread",
        targetHostCapabilities: testSwitchHostCapabilities,
        targetPreset: "high",
        targetProcessGeneration: targetProfile.processGeneration,
        targetProfileId: targetProfile.id,
        targetProvider: "codex",
        targetProviderAccountKey: providerAccountKeyForProfile(
          store,
          targetProfile.id,
          "codex",
        ),
        presetContract: currentPresetContract,
        transcriptDigest: createHash("sha256").update("legacy switch transcript").digest("hex"),
      },
      sessionId: session.id,
    })).toThrow("SESSION_PROVIDER_SWITCH_AUTHORITY_CHANGED");
    expect(store.readMutation(key)).toMatchObject({ state: "prepared" });
    expect(store.readMutation(key)?.evidence).toBeUndefined();
    expect(store.requireSession(session.id)).toEqual(session);
  });
test("fences current provider-switch seed reviews and refuses sealed runtime tampering", async () => {
    const { store } = await fixture();
    const sourceProfile = signInProfile(store, "Seed source", "seed-source@example.com");
    const targetProfile = signInProfile(store, "Seed target", "seed-target@example.com");
    const sourceAuthority = store.requireProviderAccountAuthority(sourceProfile.id, "claude");
    const targetAuthority = store.requireProviderAccountAuthority(targetProfile.id, "codex");
    const solProfile = {
      approvalPolicy: "on-request" as const,
      computerUse: true as const,
      enabledApps: [],
      fast: false,
      model: "gpt-5.6-sol",
      observedAt: 2_200,
      permissionProfile: ":workspace" as const,
      pluginCapability: true as const,
      preset: "high" as const,
      processGeneration: targetProfile.processGeneration,
      profileId: targetProfile.id,
      reasoningEffort: "max" as const,
      reviewMode: "auto_review" as const,
      serviceTier: null,
    };
    const astraProfile = { ...solProfile, model: "gpt-6-astra" };
    const stageSwitch = (suffix: string, seedText: string) => {
      const session = upsertProvenTestSession(store, {
        fastEnabled: false,
        preset: "fable-max",
        profileId: sourceProfile.id,
        provider: "claude",
        providerThreadId: `source-${suffix}`,
        state: "idle",
      });
      const seedDigest = createHash("sha256")
        .update("hra:session-transcript-seed:v1\0", "utf8")
        .update(seedText, "utf8")
        .digest("hex");
      const attempt = store.prepareMutation({
        authorityGeneration: targetProfile.processGeneration,
        authorityId: session.id,
        idempotencyKey: `00000000-0000-4000-8000-000000000${suffix}`,
        kind: "session.switch",
        request: sessionProviderSwitchMutationRequest({
          provider: "codex",
          preset: "high",
          presetContract: currentPresetContract,
          targetProfileId: targetProfile.id,
          seedDigest,
        }),
      providerAuthorities: [
          { role: "source", authority: sourceAuthority, provenance: "session_switch_source" },
          { role: "target", authority: targetAuthority, provenance: "session_switch_target" },
        ],
      });
      const evidence = {
        kind: "session.switch" as const,
        daemonGeneration: 0,
        requestedAccountId: targetProfile.id,
        requestedPreset: "high" as const,
        runtimeProfile: astraProfile,
        seedDigest,
        seedIncludedRecords: 1,
        seedOmittedRecords: 0,
        sourcePreset: "fable-max" as const,
        sourceProcessGeneration: sourceAuthority.processGeneration,
        sourceProfileId: sourceProfile.id,
        sourceProvider: "claude" as const,
        sourceProviderThreadId: `source-${suffix}`,
        targetPreset: "high" as const,
        targetProviderAccountKey: providerAccountKeyForProfile(
          store,
          targetProfile.id,
          "codex",
        ),
        targetHostCapabilities: testSwitchHostCapabilities,
        targetProcessGeneration: targetProfile.processGeneration,
        targetProfileId: targetProfile.id,
        targetProvider: "codex" as const,
        presetContract: currentPresetContract,
        transcriptDigest: createHash("sha256").update(`transcript-${suffix}`).digest("hex"),
      };
      store.beginSessionProviderSwitchEffect({
        attemptId: attempt.id,
        evidence,
        sessionId: session.id,
      });
      store.recordSessionProviderSwitchTarget({
        attemptId: attempt.id,
        providerThreadId: `target-${suffix}`,
        sessionId: session.id,
      });
      return { attempt, seedText, session };
    };

    const current = stageSwitch("6b2", "Seed the active Astra target.");
    // A Sol runtime profile no longer matches the active Astra target.
    expect(() => store.recordSessionProviderSwitchSeedIntent({
      attemptId: current.attempt.id,
      providerThreadId: "target-6b2",
      runtimeProfile: solProfile,
      seedText: current.seedText,
      sessionId: current.session.id,
    })).toThrow("SESSION_PROVIDER_SWITCH_SEED_INTENT_AUTHORITY_MISMATCH");
    expect(store.readSessionProviderSwitchProgress(current.attempt.id).seed).toBeUndefined();
    store.recordSessionProviderSwitchSeedIntent({
      attemptId: current.attempt.id,
      providerThreadId: "target-6b2",
      runtimeProfile: astraProfile,
      seedText: current.seedText,
      sessionId: current.session.id,
    });
    expect(store.readSessionProviderSwitchProgress(current.attempt.id).seed?.runtimeProfile.model)
      .toBe("gpt-6-astra");

    const tampered = stageSwitch("6b3", "Keep the second admitted Astra target unchanged.");
    const inspector = new Database(store.paths.database, { create: false, strict: true });
    try {
      // Deliberate current-row corruption is not historical contract-1 proof.
      // Authentic canonical fixtures separately retain the old runtime bytes.
      const before = snapshotSwitchContainmentForTest(inspector);
      const stored = inspector.query(
        "SELECT evidence_json FROM mutation_effect_evidence WHERE attempt_id=?",
      ).get(tampered.attempt.id) as { evidence_json: string };
      const alteredEvidence = JSON.parse(stored.evidence_json) as {
        runtimeProfile: { model: string };
      };
      alteredEvidence.runtimeProfile.model = "gpt-5.6-sol";
      const alteredEvidenceJson = JSON.stringify(alteredEvidence);
      withRemovedTestGuards(inspector, ["mutation_effect_evidence_immutable_update"], () => inspector.query(
        `UPDATE mutation_effect_evidence SET evidence_json=?,evidence_digest=?
         WHERE attempt_id=?`,
      ).run(
        alteredEvidenceJson,
        createHash("sha256").update(alteredEvidenceJson).digest("hex"),
        tampered.attempt.id,
      ));
      const corrupted = snapshotSwitchContainmentForTest(inspector);
      expect(corrupted.schema).toEqual(before.schema);
      expect(corrupted.rows.filter(({ name }) => name !== "mutation_effect_evidence"))
        .toEqual(before.rows.filter(({ name }) => name !== "mutation_effect_evidence"));
      expect(() => store.readMutation("00000000-0000-4000-8000-0000000006b3"))
        .toThrow("EFFECT_EVIDENCE_PROVENANCE_CORRUPT");
      expect(() => store.recordSessionProviderSwitchSeedIntent({
        attemptId: tampered.attempt.id,
        providerThreadId: "target-6b3",
        runtimeProfile: astraProfile,
        seedText: tampered.seedText,
        sessionId: tampered.session.id,
      })).toThrow("EFFECT_EVIDENCE_PROVENANCE_CORRUPT");
      expect(snapshotSwitchContainmentForTest(inspector)).toEqual(corrupted);
    } finally {
      inspector.close(false);
    }
  });
test("refuses to redispatch an authentic historical Devin switch without mutating its readable history", async () => {
    const paths = await canonical39RetiredArchive("source_switch");
    const source = canonical39RetiredFixtures.source_switch.retained;
    const store = new StateStore(paths);
    stores.push(store);
    const session = store.requireSession(source.session.id);
    const mutation = store.readMutation(source.idempotencyKey);
    if (mutation?.evidence?.evidence.kind !== "session.switch") throw new Error("Expected archived switch evidence.");
    const evidence = mutation.evidence.evidence;
    expect(mutation).toMatchObject({ state: "effect_started", evidence: source.mutation.evidence });
    expect(() => store.beginSessionProviderSwitchEffect({ attemptId: mutation.id,
      evidence, sessionId: session.id })).toThrow("SESSION_PROVIDER_SWITCH_TARGET_ACCOUNT_AUTHORITY_REQUIRED");
    expect(store.readMutation(source.idempotencyKey)).toEqual(mutation);
    expect(store.requireSession(session.id)).toEqual(session);
  });
test.each([
    ["source", "valid"], ["target", "valid"],
    ["source", "digest"], ["target", "binding"],
    ["source", "runtime_profile"], ["target", "runtime_profile"],
  ] as const)(
    "preserves retired Devin %s switch quarantine and refuses current %s evidence tampering",
    async (side, variant) => {
      const kind = side === "source" ? "source_switch" : "target_switch";
      const paths = await canonical39RetiredArchive(kind);
      const source = canonical39RetiredFixtures[kind].retained;
      const store = new StateStore(paths);
      stores.push(store);
      const profile = store.requireProfile(source.profile.id);
      const session = store.requireSession(source.session.id);
      const originalMutation = store.readMutation(source.idempotencyKey);
      if (originalMutation?.evidence?.evidence.kind !== "session.switch") throw new Error("Expected archived switch.");
      const attemptId = originalMutation.id;
      const evidence = structuredClone(originalMutation.evidence.evidence);
      if (variant === "binding") evidence.sourceProviderThreadId = "unmatched-legacy-source";
      if (variant === "runtime_profile") evidence.runtimeProfile.processGeneration += 1;
      const evidenceJson = JSON.stringify(evidence);
      const database = new Database(paths.database, { create: false, strict: true });
      try {
        // Deliberate damage is applied only after the authentic source has been
        // admitted and sealed. It is current corruption, not another old format.
        const schemaBefore = database.query("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name").all();
        if (variant !== "valid") {
          const intact = snapshotSwitchContainmentForTest(database);
          const corrupt = () => database.query("UPDATE mutation_effect_evidence SET evidence_json=?,evidence_digest=? WHERE attempt_id=?")
            .run(evidenceJson, variant === "digest" ? "f".repeat(64) : testDigest(evidenceJson), attemptId);
          expect(corrupt).toThrow("mutation effect evidence is immutable");
          expect(snapshotSwitchContainmentForTest(database)).toEqual(intact);
          withRemovedTestGuards(database, ["mutation_effect_evidence_immutable_update"], corrupt);
        }
        expect(database.query("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name").all()).toEqual(schemaBefore);
        const before = database.query("SELECT * FROM mutation_effect_evidence WHERE attempt_id=?").get(attemptId);
        if (variant !== "valid") {
          const corrupted = snapshotSwitchContainmentForTest(database);
          // The sealed original, not a rehashed mutable document, determines
          // admissible history. Both selected reads and writable open refuse.
          expect(() => store.readMutation(source.idempotencyKey)).toThrow("EFFECT_EVIDENCE_PROVENANCE_CORRUPT");
          expect(() => new StateStore(paths)).toThrow("EFFECT_EVIDENCE_PROVENANCE_CORRUPT");
          expect(snapshotSwitchContainmentForTest(database)).toEqual(corrupted);
          return;
        }
        const devinAuthority = store.requireProviderAccountAuthority(profile.id, "devin");
        for (const boot of ["a", "b"] as const) {
          expect(() => store.nextDaemonGeneration("boot_" + boot.repeat(32))).not.toThrow();
          expect(store.recoverEffectStartedMutations()).toEqual({
            // The unproved Codex source was already contained by migration.
            recovered: boot === "a" && side === "source" ? [attemptId] : [], unresolved: [],
          });
          expect(store.requireSession(session.id).state).toBe("recovery_required");
          expect(store.readMutation(source.idempotencyKey)?.state).toBe("ambiguous");
          expect(store.requireProviderAccountAuthority(profile.id, "devin")).toEqual(devinAuthority);
          expect(store.isSessionMutationProviderAuthorityCurrent({ attemptId,
            profileId: profile.id, provider: "devin", originGeneration: source.profile.processGeneration })).toBe(false);
          expect(store.isSessionMutationProviderAuthorityCurrent({ attemptId,
            profileId: profile.id, provider: "codex", originGeneration: source.profile.processGeneration })).toBe(false);
          expect(store.readMutation(source.idempotencyKey)?.result).toEqual(side === "source"
            ? { code: "LEGACY_PROVIDER_AUTHORITY_QUARANTINED" } : undefined);
        }
        expect(database.query("SELECT provider,from_generation,to_generation FROM session_mutation_authority_rebinds_v39 WHERE attempt_id=? ORDER BY from_generation").all(attemptId))
          .toEqual([]);
        expect(database.query("SELECT * FROM mutation_effect_evidence WHERE attempt_id=?").get(attemptId)).toEqual(before);
        expect(JSON.stringify(store.readMutation(source.idempotencyKey)?.evidence?.evidence)).toBe(evidenceJson);
      } finally { database.close(false); }
    },
  );
test.each(["valid", "digest", "binding", "runtime_profile"] as const)(
    "quarantines authentic retired Devin dispatch and refuses current %s evidence tampering",
    async (variant) => {
      const paths = await canonical39RetiredArchive("queue_dispatch");
      const source = canonical39RetiredFixtures.queue_dispatch.retained;
      const store = new StateStore(paths);
      stores.push(store);
      const session = store.requireSession(source.session.id);
      const queue = store.requireQueue(source.queue.id);
      const originalEffect = store.readQueueEffect(queue.id);
      if (originalEffect === null) throw new Error("Expected archived queue effect.");
      const evidence = structuredClone(originalEffect.evidence);
      if (variant === "binding") evidence.providerThreadId = "unmatched-thread";
      if (variant === "runtime_profile") evidence.runtimeProfile.processGeneration += 1;
      const evidenceJson = JSON.stringify(evidence);
      const database = new Database(paths.database, { create: false, strict: true });
      try {
        const schemaBefore = database.query("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name").all();
        if (variant !== "valid") {
          const intact = snapshotSwitchContainmentForTest(database);
          const corrupt = () => database.query("UPDATE queue_effect_evidence SET evidence_json=?,evidence_digest=? WHERE queue_id=?")
            .run(evidenceJson, variant === "digest" ? "f".repeat(64) : testDigest(evidenceJson), queue.id);
          expect(corrupt).toThrow("queue effect evidence is immutable");
          expect(snapshotSwitchContainmentForTest(database)).toEqual(intact);
          withRemovedTestGuards(database, ["queue_effect_evidence_immutable_update"], corrupt);
        }
        expect(database.query("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name").all()).toEqual(schemaBefore);
        const before = database.query("SELECT * FROM queue_effect_evidence WHERE queue_id=?").get(queue.id);
        if (variant !== "valid") {
          const corrupted = snapshotSwitchContainmentForTest(database);
          expect(() => store.readQueueEffect(queue.id)).toThrow("EFFECT_EVIDENCE_PROVENANCE_CORRUPT");
          expect(() => store.recoverDispatchingQueueEffects()).toThrow("EFFECT_EVIDENCE_PROVENANCE_CORRUPT");
          expect(() => new StateStore(paths)).toThrow("EFFECT_EVIDENCE_PROVENANCE_CORRUPT");
          expect(snapshotSwitchContainmentForTest(database)).toEqual(corrupted);
          return;
        }
        const devinAuthority = store.requireProviderAccountAuthority(source.profile.id, "devin");
        store.nextDaemonGeneration("boot_" + "c".repeat(32));
        expect(store.requireProviderAccountAuthority(source.profile.id, "devin")).toEqual(devinAuthority);
        expect(store.recoverDispatchingQueueEffects()).toEqual({ recovered: [queue.id], unresolved: [] });
        expect(store.requireQueue(queue.id).state).toBe("ambiguous");
        expect(store.requireQueue(queue.id).message).toBe(queue.message);
        expect(store.requireSession(session.id).state).toBe("recovery_required");
        expect(store.recoverDispatchingQueueEffects()).toEqual({ recovered: [], unresolved: [] });
        expect(store.sessionAccountAuthorityMatches(session.id, source.profile.id)).toBe(true);
        expect(database.query("SELECT * FROM queue_effect_evidence WHERE queue_id=?").get(queue.id)).toEqual(before);
      } finally { database.close(false); }
    },
  );
test("refuses generic abandonment of authentic Devin history with unproved pending queue identity without writes", async () => {
    const paths = await canonical39RetiredArchive("mixed_history");
    const source = canonical39RetiredFixtures.mixed_history.retained;
    const store = new StateStore(paths);
    stores.push(store);
    const bound = store.requireSession(source.session.id);
    const queue = store.requireQueue(source.queue.id);
    const recovery = store.quarantineSession(bound.id);
    const database = new Database(paths.database, { readonly: true, strict: true });
    try {
    const before = snapshotSwitchContainmentForTest(database);
    // The archived enqueue predates immutable attachment identity. Generic
    // status recovery cannot bypass its separate abandonment receipt guard.
    expect(() => store.resolveSessionStatusRecovery({ sessionId: recovery.id,
      expectedRevision: recovery.revision, resolution: "abandoned" }))
      .toThrow("QUEUE_ATTACHMENT_IDENTITY_UNPROVED");
    expect(snapshotSwitchContainmentForTest(database)).toEqual(before);
    expect(store.requireSession(recovery.id)).toEqual(recovery);
    expect(store.requireQueue(queue.id).state).toBe("pending");
    // A provider-reported reconcile restores the live Devin session like any
    // provider; the pending queue debt is untouched.
    expect(store.resolveSessionStatusRecovery({ sessionId: recovery.id,
      expectedRevision: recovery.revision, resolution: "provider_state_reconciled",
      provider: { providerThreadId: source.session.providerThreadId,
        title: source.session.title, status: "idle" },
    })).toMatchObject({ provider: "devin", state: "idle" });
    expect(store.requireQueue(queue.id).state).toBe("pending");
    expect(store.latestSessionRuntimeProfile(bound.id)).toEqual(source.runtime);
    } finally { database.close(false); }
  });
test("allows storage-only abandonment of authentic idle Devin history without pending queue debt", async () => {
    const paths = await canonical39DevinArchive();
    const source = canonical39DevinFixture.cases.find((entry) => entry.generation === 0);
    if (source === undefined) throw new Error("Expected archived generation-zero Devin session.");
    const store = new StateStore(paths);
    stores.push(store);
    const runtime = store.latestSessionRuntimeProfile(source.session.id);
    const login = store.readMutation(source.idempotencyKey);
    const authority = store.requireCapturedSessionProviderAuthority(source.session.id);
    const recovery = store.quarantineSession(source.session.id);
    expect(store.resolveSessionStatusRecovery({ sessionId: recovery.id,
      expectedRevision: recovery.revision, resolution: "abandoned" }))
      .toMatchObject({ provider: "devin", state: "terminal" });
    expect(store.latestSessionRuntimeProfile(source.session.id)).toEqual(runtime);
    expect(store.readMutation(source.idempotencyKey)).toEqual(login);
    expect(store.requireCapturedSessionProviderAuthority(source.session.id)).toEqual(authority);
  });
test("keeps authentic v39 Devin history readable and admits its migrated authority until account identity changes", async () => {
    const paths = await canonical39RetiredArchive("mixed_history");
    const source = canonical39RetiredFixtures.mixed_history.retained;
    const store = new StateStore(paths);
    stores.push(store);
    const account = store.requireProfile(source.profile.id);
    const codex = store.upsertProviderSession({
      providerAuthority: store.requireProviderAccountAuthority(account.id, "codex"), profileId: account.id, provider: "codex",
      providerThreadId: "current-codex-history-thread", providerAccountKey: providerAccountKeyForProfile(store, account.id, "codex"),
      title: "Current supported history", preset: "high", fastEnabled: false, state: "idle" });
    const devin = store.requireSession(source.session.id);
    const unprovenCodex = store.requireSession(source.codex.id);
    const unprovenClaude = store.requireSession(source.claude.id);
    const input = { profileId: account.id, after: null, limit: 10, requireCurrentAccountAuthority: true } as const;
    expect(store.listLocalSessionPage(input).sessions).toEqual([codex, devin]);
    expect(store.listLocalSessionPage({ ...input, excludedProvider: "devin" }).sessions).toEqual([codex]);
    for (const session of [unprovenCodex, unprovenClaude]) {
      expect(store.sessionAccountAuthorityMatches(session.id, account.id)).toBe(false);
      expect(store.requireSession(session.id)).toEqual(session);
    }
    expect(store.sessionAccountAuthorityMatches(devin.id, account.id)).toBe(true);
    // A Codex sign-in only advances the Codex authority generation; the Devin
    // binding is fenced per provider and stays current.
    expect(store.setProfileState(account.id, account.processGeneration, "signed_in", {
      email: "replacement-history@example.com", plan: "Plus",
    })).toBe(true);
    expect(store.listLocalSessionPage(input).sessions).toEqual([devin]);
    expect(store.sessionAccountAuthorityMatches(codex.id, account.id)).toBe(false);
    expect(store.sessionAccountAuthorityMatches(devin.id, account.id)).toBe(true);
    const database = new Database(paths.database, { readonly: true, strict: true });
    try {
      const before = snapshotSwitchContainmentForTest(database);
      // The recovery_required state precheck fences dispatch before provider
      // admission, without any provider-name check.
      expect(() => store.enqueue(devin.id, "history is not executable")).toThrow("MUTATION_EFFECT_AUTHORITY_CHANGED");
      expect(snapshotSwitchContainmentForTest(database)).toEqual(before);
    } finally { database.close(false); }
  });
test("keeps authentic mixed v39 history readable while admitting current Devin effects under migrated authority", async () => {
    const paths = await canonical39RetiredArchive("mixed_history");
    const source = canonical39RetiredFixtures.mixed_history.retained;
    const store = new StateStore(paths);
    stores.push(store);
    const account = store.requireProfile(source.profile.id);
    const codex = store.requireSession(source.codex.id);
    const claude = store.requireSession(source.claude.id);
    const devin = store.requireSession(source.session.id);
    const runtimeProfile = effectiveDevinRuntimeProfileSchema.parse(source.runtimeProfile);
    const archivedProfile = store.latestSessionRuntimeProfile(devin.id);
    expect(archivedProfile).toEqual(source.runtime);
    const queue = store.requireQueue(source.queue.id);
    const mutation = store.readMutation(source.idempotencyKey);
    if (mutation === null) throw new Error("Expected archived prepared send.");
    const snapshot = () => {
      const database = new Database(paths.database, { readonly: true, strict: true });
      try { return snapshotSwitchContainmentForTest(database); }
      finally { database.close(false); }
    };
    expect(store.sessionAccountAuthorityMatches(devin.id, account.id)).toBe(true);
    expect(store.listLocalSessionPage({ profileId: account.id, after: null, limit: 10,
      requireCurrentAccountAuthority: true }).sessions).toContainEqual(devin);
    expect(store.listLocalSessionPage({ profileId: account.id, after: null, limit: 10 }).sessions).toContainEqual(devin);
    // The archived send predates the provider-authority model; its stale
    // authority proof fences it without any provider-name check.
    expect(store.isSessionMutationProviderAuthorityCurrent({ attemptId: mutation.id,
      profileId: account.id, provider: "devin", originGeneration: source.profile.processGeneration })).toBe(false);
    const created = store.createSession({ profileId: account.id, provider: "devin", preset: "astra", fastEnabled: false });
    expect(created.provider).toBe("devin");
    const imported = store.upsertProviderSession({
      providerAuthority: store.requireProviderAccountAuthority(account.id, "devin"), profileId: account.id, provider: "devin",
      providerThreadId: "admitted-import", title: "Admitted import", preset: "astra",
      fastEnabled: false, state: "idle" });
    expect(imported.provider).toBe("devin");
    store.setDefaultPreset("astra");
    // The archived session is recovery_required: the state prechecks fence
    // dispatch and preset reinterpretation before provider admission.
    expect(() => store.enqueue(devin.id, "admitted")).toThrow("MUTATION_EFFECT_AUTHORITY_CHANGED");
    expect(() => store.updateSessionMetadata({ sessionId: devin.id, expectedRevision: devin.revision, preset: "ultra" }))
      .toThrow("SESSION_PRESET_RECOVERY_REQUIRED");
    const beforeRefusals = snapshot();
    expect(() => store.beginSessionMutationEffect({
      providerAuthority: capturedProviderAuthorityForTest(store, devin.id), transcript: {
      accountId: account.id, providerGeneration: source.profile.processGeneration,
      providerConnectionId: "10000000-0000-4000-8000-000000000099", actor: "human", message: "rejected",
    }, attemptId: mutation.id, sessionId: devin.id, profileGeneration: source.profile.processGeneration, message: "rejected",
    evidence: { kind: "session.send", providerThreadId: source.session.providerThreadId,
      baseline: { providerUpdatedAt: null, status: "idle", activeTurnId: null },
      clientMessageId: mutation.id, messageDigest: testDigest("rejected"), runtimeProfile },
    })).toThrow("MUTATION_EFFECT_AUTHORITY_CHANGED");
    expect(() => store.beginQueueEffect({
      providerAuthority: capturedProviderAuthorityForTest(store, devin.id), queueId: queue.id, sessionId: devin.id,
      profileGeneration: source.profile.processGeneration, providerConnectionId: "10000000-0000-4000-8000-000000000005",
      evidence: { kind: "queue.dispatch", queueId: queue.id, sessionId: devin.id,
        providerThreadId: source.session.providerThreadId, profileGeneration: source.profile.processGeneration,
        baseline: { providerUpdatedAt: null, status: "idle", activeTurnId: null },
        clientMessageId: queue.id, messageDigest: testDigest(queue.message), runtimeProfile },
    // The immutable attachment-identity precheck precedes provider admission.
    })).toThrow("QUEUE_ATTACHMENT_IDENTITY_UNPROVED");
    expect(snapshot()).toEqual(beforeRefusals);
    expect(store.readMutation(source.idempotencyKey)).toEqual(mutation);
    expect(store.requireQueue(queue.id)).toMatchObject({ state: "pending", message: "legacy pending send" });
    const inspect = () => {
      const database = new Database(paths.database, { readonly: true, strict: true });
      try { return {
        version: database.query("PRAGMA user_version").get(),
        sessions: database.query("SELECT * FROM sessions ORDER BY id").all(),
        profiles: database.query("SELECT * FROM session_runtime_profiles ORDER BY session_id,revision").all(),
        events: database.query("SELECT * FROM session_events WHERE session_id=? ORDER BY sequence").all(devin.id),
        mutations: database.query("SELECT * FROM mutation_attempts ORDER BY id").all(),
        queue: database.query("SELECT * FROM queue_entries ORDER BY id").all(),
      }; } finally { database.close(false); }
    };
    const before = inspect();
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const reopened = new StateStore(paths, { now: () => 40_000 });
    stores.push(reopened);
    expect(reopened.requireSession(codex.id).provider).toBe("codex");
    expect(reopened.requireSession(claude.id).provider).toBe("claude");
    expect(reopened.requireSession(devin.id)).toMatchObject({ provider: "devin", preset: "astra" });
    expect(reopened.latestSessionRuntimeProfile(devin.id)).toEqual(archivedProfile);
    expect(reopened.listSessionEvents({ sessionId: devin.id, afterSequence: null, limit: 10, now: 40_000 }).events).toContainEqual(source.usage);
    expect(inspect()).toEqual(before);
    const readonly = new StateStore(paths, { readonly: true });
    stores.push(readonly);
    expect(readonly.requireSession(devin.id).provider).toBe("devin");
    expect(readonly.latestSessionRuntimeProfile(devin.id)?.profile).toEqual(runtimeProfile);
    expect(inspect()).toEqual(before);
  });
test("refuses a session-start evidence row whose profile names another provider", async () => {
    const { store, home } = await fixture();
    const profile = signInProfile(store, "Mismatch", "mismatch@example.com");
    const projectRoot = join(home, "mismatch-project");
    await mkdir(projectRoot);
    const project = await store.createProject("Mismatch project", projectRoot, true);
    const initialClaudeAuthority = store.advanceProviderAccountProcessGeneration({
      profileId: profile.id,
      provider: "claude",
      expectedProcessGeneration: 0,
    });
    const claudeAuthority = store.advanceProviderAccountProcessGeneration({
      profileId: profile.id,
      provider: "claude",
      expectedProcessGeneration: initialClaudeAuthority.processGeneration,
    });
    const attempt = store.prepareMutation({
      authorityGeneration: claudeAuthority.processGeneration,
      authorityId: profile.id,
      idempotencyKey: "00000000-0000-4000-8000-0000000006a2",
      kind: "session.start",
      request: { fast: false, preset: "fable-max", projectId: project.id },
    });
    expect(() => store.beginSessionStartEffect({
      attemptId: attempt.id,
      evidence: {
        clientMessageId: null,
        kind: "session.start",
        messageDigest: null,
        projectId: project.id,
        runtimeProfile: {
          claudeVersion: "2.1.260",
          inputFormat: "stream-json",
          isolatedConfigDir: true,
          model: "claude-fable-5-1",
          nativeFallback: {
            model: "claude-opus-5", reason: "live_acceptance_required", status: "unavailable",
          },
          observedAt: 2_100,
          outputFormat: "stream-json",
          permissionMode: "default",
          preset: "fable-max",
          processGeneration: claudeAuthority.processGeneration,
          profileId: profile.id,
          reasoningEffort: "max",
        },
      },
      fastEnabled: true,
      preset: "fable-max",
      profileGeneration: claudeAuthority.processGeneration,
      profileId: profile.id,
      projectId: project.id,
      provider: "claude",
      providerAuthority: claudeAuthority,
      providerAccountKey: testProviderAccountKey("claude"),
      providerAuthentication: {
        profileId: profile.id,
        processGeneration: claudeAuthority.processGeneration,
        provider: "claude",
        signedIn: true,
      },
    })).toThrow("MUTATION_EFFECT_RUNTIME_PROFILE_MISMATCH");
  });
test("appends an immutable resolution with stale-CAS rejection and releases only the exact authority", async () => {
    const { store } = await fixture();
    const profile = signInProfile(store, "Resolution", "resolution@example.com");
    const local = store.createSession({ profileId: profile.id, preset: "high", fastEnabled: false });
    const session = store.bindSession({ sessionId: local.id, expectedRevision: local.revision, providerThreadId: "thread-resolution", state: "idle", providerUpdatedAt: 10 });
    const key = "00000000-0000-4000-8000-000000000611";
    const attempt = store.prepareMutation({ kind: "session.rename", authorityId: session.id, authorityGeneration: profile.processGeneration, request: { name: "Resolved" }, idempotencyKey: key });
    const evidence = store.beginSessionMutationEffect({
      attemptId: attempt.id,
      sessionId: session.id,
      profileGeneration: profile.processGeneration,
      providerAuthority: store.requireProviderAccountAuthority(profile.id, "codex"),
      evidence: { kind: "session.rename", providerThreadId: "thread-resolution", providerTimestampUnit: "unix_milliseconds_v1", baseline: { providerUpdatedAt: 10, status: "idle", activeTurnId: null }, requestedName: "Resolved" },
    });
    expect(store.transitionMutation(attempt.id, "effect_started", "ambiguous", { code: "LOST_RESPONSE" })).toBe(true);
    store.quarantineSession(session.id);
    expect(() => store.prepareMutation({ kind: "session.rename", authorityId: session.id, authorityGeneration: profile.processGeneration, request: { name: "Other" }, idempotencyKey: "00000000-0000-4000-8000-000000000612" })).toThrow("UNSETTLED_MUTATION_AUTHORITY");

    expect(store.resolveSessionMutation({
      attemptId: attempt.id,
      expectedOriginalState: "ambiguous",
      expectedEvidenceDigest: evidence.digest,
      resolution: "proven_applied",
      resolutionEvidence: { kind: "session.rename", providerThreadId: "thread-resolution", providerTimestampUnit: "unix_milliseconds_v1", requestedName: "Resolved", providerUpdatedAt: 11 },
      receipt: { renamed: true },
      provider: { providerThreadId: "thread-resolution", title: "Resolved", status: "idle", providerUpdatedAt: 11 },
    })).toMatchObject({ state: "idle", title: "Resolved", providerUpdatedAt: 11 });
    expect(store.readMutation(key)).toMatchObject({ state: "reconciled", originalState: "ambiguous", result: { renamed: true }, resolution: { kind: "proven_applied" } });
    expect(() => store.resolveSessionMutation({
      attemptId: attempt.id,
      expectedOriginalState: "ambiguous",
      expectedEvidenceDigest: evidence.digest,
      resolution: "proven_applied",
      resolutionEvidence: { stale: true },
      receipt: { renamed: true },
      provider: { providerThreadId: "thread-resolution", title: "Resolved", status: "idle", providerUpdatedAt: 11 },
    })).toThrow();
    expect(store.prepareMutation({ kind: "session.rename", authorityId: session.id, authorityGeneration: profile.processGeneration, request: { name: "Other" }, idempotencyKey: "00000000-0000-4000-8000-000000000612" })).toMatchObject({ replay: false, state: "prepared" });

    const inspector = new Database(store.paths.database, { create: false, strict: true });
    try {
      expect(() => inspector.query("UPDATE mutation_effect_evidence SET evidence_digest=? WHERE attempt_id=?").run("b".repeat(64), attempt.id)).toThrow("immutable");
      expect(() => inspector.query("UPDATE mutation_resolutions SET resolution_kind='abandoned' WHERE attempt_id=?").run(attempt.id)).toThrow("immutable");
    } finally {
      inspector.close(false);
    }
  });
test("atomically rejects invalid timestamp recovery proofs through typed and raw SQL boundaries", async () => {
    for (const kind of ["session.stop", "session.rename"] as const) {
      const { store } = await fixture();
      const profile = signInProfile(store, "Timestamp guard", "timestamp@example.com");
      const session = upsertProvenTestSession(store, {
        profileId: profile.id, preset: "high", fastEnabled: false,
        providerThreadId: "thread-timestamp", state: "idle", providerUpdatedAt: 10,
      });
      const key = crypto.randomUUID();
      const attempt = store.prepareMutation({ kind, authorityId: session.id, authorityGeneration: profile.processGeneration, request: {}, idempotencyKey: key });
      const effect = store.beginSessionMutationEffect({
        providerAuthority: capturedProviderAuthorityForTest(store, session.id),
        attemptId: attempt.id, sessionId: session.id, profileGeneration: profile.processGeneration,
        evidence: { providerThreadId: "thread-timestamp", providerTimestampUnit: "unix_milliseconds_v1",
          baseline: { providerUpdatedAt: 10, status: "active", activeTurnId: "turn-old" },
          ...(kind === "session.stop" ? { kind, activeTurnId: "turn-old" } : { kind, requestedName: "Resolved" }),
        },
      });
      store.transitionMutation(attempt.id, "effect_started", "ambiguous");
      store.quarantineSession(session.id);
      const before = store.requireSession(session.id);
      const proof = { kind, providerThreadId: "thread-timestamp", providerTimestampUnit: "unix_milliseconds_v1", providerUpdatedAt: 11,
        ...(kind === "session.stop" ? { activeTurnId: "turn-old", observedStatus: "interrupted" } : { requestedName: "Resolved" }),
      };
      const receipt = kind === "session.stop" ? { stopped: true, activeTurnId: "turn-old" } : { renamed: true };
      const provider = { providerThreadId: "thread-timestamp", title: "Resolved", status: "idle" as const, providerUpdatedAt: 11 };
      const resolve = { attemptId: attempt.id, expectedOriginalState: "ambiguous" as const, expectedEvidenceDigest: effect.digest,
        resolution: "proven_applied" as const, resolutionEvidence: proof, receipt, provider };
      const inspector = new Database(store.paths.database, { create: false, strict: true });
      try {
        const insert = (evidence: unknown, actualReceipt: unknown, resolution = "proven_applied") => inspector.transaction(() => {
          // Match the typed store's update-before-receipt ordering, so an
          // invalid proof cannot be hidden by an unrelated snapshot mismatch.
          inspector.query("UPDATE sessions SET title=?,provider_updated_at=?,active_turn_id=NULL WHERE id=?").run(provider.title, provider.providerUpdatedAt, session.id);
          return inspector.query(
            "INSERT INTO mutation_resolutions(attempt_id,resolution_kind,evidence_json,receipt_json,created_at) VALUES (?,?,?,?,?)",
          ).run(attempt.id, resolution, JSON.stringify(evidence), actualReceipt === undefined ? null : JSON.stringify(actualReceipt), 1_000);
        }).immediate();
        for (const invalid of [
          { providerUpdatedAt: 10 }, { providerUpdatedAt: 9 }, { providerUpdatedAt: -1 },
          { providerUpdatedAt: 10.5 }, { providerUpdatedAt: Number.MAX_SAFE_INTEGER + 1 },
          { providerUpdatedAt: null }, { providerUpdatedAt: undefined },
          { providerTimestampUnit: undefined }, { providerTimestampUnit: "unix_seconds" },
          { providerThreadId: "wrong-thread" }, { kind: "session.send" },
          ...(kind === "session.stop" ? [{ activeTurnId: "wrong-turn" }, { observedStatus: "inProgress" }] : [{ requestedName: "Wrong" }, { requestedName: " Resolved " }]),
        ]) {
          const invalidProof = { ...proof, ...invalid };
          expect(() => store.resolveSessionMutation({ ...resolve, resolutionEvidence: invalidProof })).toThrow();
          expect(() => insert(invalidProof, receipt)).toThrow("MUTATION_RECOVERY_TIMESTAMP_PROOF_INVALID");
          expect(store.requireSession(session.id)).toEqual(before);
          expect(store.readMutation(key)?.state).toBe("ambiguous");
          expect(inspector.query("SELECT count(*) AS count FROM mutation_resolutions WHERE attempt_id=?").get(attempt.id)).toEqual({ count: 0 });
        }
        for (const invalidReceipt of [undefined, null, {}, { ...receipt, extra: true }, { renamed: false }, { stopped: true, activeTurnId: "wrong-turn" }]) {
          expect(() => store.resolveSessionMutation({ ...resolve, receipt: invalidReceipt })).toThrow();
          expect(() => insert(proof, invalidReceipt)).toThrow("MUTATION_RECOVERY_TIMESTAMP_PROOF_INVALID");
        }
        expect(() => store.resolveSessionMutation({ ...resolve, provider: { ...provider, providerUpdatedAt: 12 } })).toThrow();
        if (kind === "session.stop") {
          expect(() => store.resolveSessionMutation({ ...resolve, provider: { ...provider, activeTurnId: "turn-old" } })).toThrow();
        } else {
          expect(() => store.resolveSessionMutation({ ...resolve, provider: { ...provider, title: "Wrong" } })).toThrow();
        }
        for (const snapshot of [
          { title: provider.title, updatedAt: 12, activeTurnId: null },
          ...(kind === "session.stop"
            ? [{ title: provider.title, updatedAt: 11, activeTurnId: "turn-old" }]
            : [{ title: "Wrong", updatedAt: 11, activeTurnId: null }]),
        ]) {
          expect(() => inspector.transaction(() => {
            inspector.query("UPDATE sessions SET title=?,provider_updated_at=?,active_turn_id=? WHERE id=?")
              .run(snapshot.title, snapshot.updatedAt, snapshot.activeTurnId, session.id);
            inspector.query("INSERT INTO mutation_resolutions(attempt_id,resolution_kind,evidence_json,receipt_json,created_at) VALUES (?,'proven_applied',?,?,1000)")
              .run(attempt.id, JSON.stringify(proof), JSON.stringify(receipt));
          }).immediate()).toThrow("MUTATION_RECOVERY_TIMESTAMP_PROOF_INVALID");
          expect(store.requireSession(session.id)).toEqual(before);
        }
        for (const resolution of ["abandoned", "provider_state_reconciled"] as const) {
          for (const unexpectedReceipt of [null, receipt]) {
            expect(() => store.resolveSessionMutation({ ...resolve, resolution, receipt: unexpectedReceipt })).toThrow("MUTATION_RECOVERY_TIMESTAMP_RECEIPT_UNEXPECTED");
            expect(() => insert({}, unexpectedReceipt, resolution)).toThrow("MUTATION_RECOVERY_TIMESTAMP_RECEIPT_UNEXPECTED");
          }
        }
        expect(store.requireSession(session.id)).toEqual(before);
        expect(store.resolveSessionMutation(resolve).state).toBe("idle");
        expect(store.readMutation(key)?.result).toEqual(receipt);
      } finally { inspector.close(false); }
    }
  });
for (const kind of ["session.stop", "session.rename"] as const) {
    for (const baselineTime of [null, 10, 10.5, Number.MAX_SAFE_INTEGER + 1]) {
      test(`requires unit-marked safe baseline timestamps without rewriting admitted unitless evidence: ${kind}, ${String(baselineTime)}`, async () => {
        const { store } = await fixture();
        const profile = signInProfile(store, "Legacy timestamp", "legacy-timestamp@example.com");
        const local = store.createSession({ profileId: profile.id, preset: "high", fastEnabled: false });
        const session = store.bindSession({ sessionId: local.id, expectedRevision: local.revision, providerThreadId: "thread-legacy-time", state: "idle" });
        const key = crypto.randomUUID();
        const attempt = store.prepareMutation({ kind, authorityId: session.id, authorityGeneration: profile.processGeneration, request: {}, idempotencyKey: key });
        const evidence = { providerThreadId: "thread-legacy-time", baseline: { providerUpdatedAt: baselineTime, status: "idle" as const, activeTurnId: null },
          ...(kind === "session.stop" ? { kind, activeTurnId: "turn-old" } : { kind, requestedName: "Resolved" }) };
        if (baselineTime !== 10) {
          expect(() => store.beginSessionMutationEffect({
            providerAuthority: capturedProviderAuthorityForTest(store, session.id), attemptId: attempt.id, sessionId: session.id,
            profileGeneration: profile.processGeneration, evidence: { ...evidence, providerTimestampUnit: "unix_milliseconds_v1" } })).toThrow();
          expect(store.readMutation(key)?.state).toBe("prepared");
          expect(store.readMutation(key)?.evidence).toBeUndefined();
        }
        const original = store.beginSessionMutationEffect({
          providerAuthority: capturedProviderAuthorityForTest(store, session.id), attemptId: attempt.id, sessionId: session.id, profileGeneration: profile.processGeneration, evidence });
        store.transitionMutation(attempt.id, "effect_started", "ambiguous");
        store.quarantineSession(session.id);
        const proof = { kind, providerThreadId: evidence.providerThreadId, providerTimestampUnit: "unix_milliseconds_v1", providerUpdatedAt: 10_000,
          ...(kind === "session.stop" ? { activeTurnId: "turn-old", observedStatus: "absent" } : { requestedName: "Resolved" }) };
        const receipt = kind === "session.stop" ? { stopped: true, activeTurnId: "turn-old" } : { renamed: true };
        const inspector = new Database(store.paths.database, { create: false, strict: true });
        try {
          const bytes = inspector.query("SELECT evidence_json,evidence_digest FROM mutation_effect_evidence WHERE attempt_id=?").get(attempt.id);
          const beforeRefusal = snapshotSwitchContainmentForTest(inspector);
          expect(() => store.resolveSessionMutation({ attemptId: attempt.id, expectedOriginalState: "ambiguous", expectedEvidenceDigest: original.digest,
            resolution: "proven_applied", resolutionEvidence: proof, receipt,
            provider: { providerThreadId: evidence.providerThreadId, title: "Resolved", status: "idle", providerUpdatedAt: 10_000 } })).toThrow("MUTATION_RECOVERY_TIMESTAMP_PROOF_INVALID");
          expect(() => inspector.query("INSERT INTO mutation_resolutions(attempt_id,resolution_kind,evidence_json,receipt_json,created_at) VALUES (?,'proven_applied',?,?,1000)")
            .run(attempt.id, JSON.stringify(proof), JSON.stringify(receipt))).toThrow("JOINED_EVIDENCE_BOUNDARY_REFUSED");
          expect(snapshotSwitchContainmentForTest(inspector)).toEqual(beforeRefusal);
          expect(store.readMutation(key)?.evidence).toEqual(original);
          expect(inspector.query("SELECT evidence_json,evidence_digest FROM mutation_effect_evidence WHERE attempt_id=?").get(attempt.id)).toEqual(bytes);
          store.resolveSessionMutation({ attemptId: attempt.id, expectedOriginalState: "ambiguous", expectedEvidenceDigest: original.digest,
            resolution: "abandoned", resolutionEvidence: { action: "user_abandon" },
            provider: { providerThreadId: evidence.providerThreadId, title: "Resolved", status: "idle", providerUpdatedAt: 10_000 } });
          expect(inspector.query("SELECT receipt_json FROM mutation_resolutions WHERE attempt_id=?").get(attempt.id)).toEqual({ receipt_json: null });
        } finally { inspector.close(false); }
      });
    }
  }
test("migrates an authentic schema 40 unmarked resolution while preserving legacy bytes and digests", async () => {
    const paths = await canonical20To40Archive("canonical40-unmarked-resolution");
    const capture = canonical20To40Fixture.captures["canonical40-unmarked-resolution"];
    const source = capture.retained;
    const inspector = new Database(paths.database, { create: false, strict: true });
    const resolutionBytes = '{"source":"thread/read","providerUpdatedAt":10000}';
    try {
      const before = canonicalAuthBudgetSnapshot(inspector);
      const retained = canonicalAuthBudgetRows(inspector, [
        "profiles", "mutation_attempts", "mutation_effect_evidence", "mutation_resolutions",
      ]);
      expect(before.version).toEqual({ user_version: 40 });
      expect(inspector.query("SELECT * FROM migrations ORDER BY version").all()).toEqual([...capture.snapshot.ledger]);
      expect(createHash("sha256").update(JSON.stringify(before.schema)).digest("hex")).toBe(capture.snapshot.schemaSha256);
      expect(inspector.query("SELECT name FROM sqlite_master WHERE name='mutation_resolutions_timestamp_proof_insert'").get()).toBeNull();
      const original = z.object({ evidence_json: z.string(), evidence_digest: z.string() }).parse(
        inspector.query("SELECT evidence_json,evidence_digest FROM mutation_effect_evidence WHERE attempt_id=?").get(source.effect.attemptId),
      );
      expect(createHash("sha256").update(original.evidence_json).digest("hex")).toBe(original.evidence_digest);
      expect(original.evidence_digest).toBe(source.effect.digest);
      expect(inspector.query("SELECT evidence_json FROM mutation_resolutions WHERE attempt_id=?").get(source.effect.attemptId))
        .toEqual({ evidence_json: resolutionBytes });
      expect(() => { new StateStore(paths, { readonly: true }).close(); }).toThrow("STATE_SCHEMA_MIGRATION_REQUIRED:40:61");
      expect(canonicalAuthBudgetSnapshot(inspector)).toEqual(before);

      const migrated = new StateStore(paths, { now: () => 50_000, resolveMachineTimeZone: () => "UTC" });
      stores.push(migrated);
      expect(retained.read()).toEqual(retained.before);
      expect(migrated.readMutation(source.key)?.evidence).toEqual(source.effect);
      expect(migrated.readMutation(source.key)?.resolution?.evidence).toEqual(source.resolutionEvidence);
      expect(inspector.query("SELECT evidence_json,evidence_digest FROM mutation_effect_evidence WHERE attempt_id=?").get(source.effect.attemptId)).toEqual(original);
      expect(inspector.query("SELECT evidence_json FROM mutation_resolutions WHERE attempt_id=?").get(source.effect.attemptId))
        .toEqual({ evidence_json: resolutionBytes });
      expect(inspector.query("SELECT * FROM migrations WHERE version<=40 ORDER BY version").all()).toEqual([...capture.snapshot.ledger]);
      expect(inspector.query("SELECT * FROM migrations WHERE version>40 ORDER BY version").all()).toEqual(
        Array.from({ length: 21 }, (_, index) => ({ version: index + 41, applied_at: 50_000 })),
      );
      expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: 61 });
      expect(inspector.query("PRAGMA foreign_key_check").all()).toEqual([]);
      for (const name of ["mutation_resolutions_timestamp_proof_insert", "session_peer_policies", "project_memory_sync_intents"]) {
        expect(inspector.query("SELECT name FROM sqlite_master WHERE name=?").get(name)).toEqual({ name });
      }
      const joined = canonicalAuthBudgetSnapshot(inspector);
      for (const readonly of [false, true]) {
        const reopened = new StateStore(paths, { readonly, now: () => 50_001, resolveMachineTimeZone: () => "UTC" });
        try { expect(reopened.readMutation(source.key)?.evidence).toEqual(source.effect); }
        finally { reopened.close(); }
        expect(canonicalAuthBudgetSnapshot(inspector)).toEqual(joined);
      }
    } finally { inspector.close(false); }
  });
test("refuses missing or changed current timestamp guards before maintenance without repairing them", async () => {
    for (const definition of ["missing", "weaker", "changed_literal"] as const) {
      const { store } = await fixture({ provision: "migrate" });
      const inspector = new Database(store.paths.database, { create: false, strict: true });
      try {
        const original = z.object({ sql: z.string() }).parse(inspector.query("SELECT sql FROM sqlite_master WHERE name='mutation_resolutions_timestamp_proof_insert'").get()).sql;
        inspector.exec("DROP TRIGGER mutation_resolutions_timestamp_proof_insert");
        if (definition === "weaker") {
          inspector.exec("CREATE TRIGGER mutation_resolutions_timestamp_proof_insert BEFORE INSERT ON mutation_resolutions BEGIN SELECT 1; END");
        } else if (definition === "changed_literal") {
          inspector.exec(original.replace("'unix_milliseconds_v1'", "'unix_milliseconds_v1  '"));
        }
        const schemaBefore = inspector.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all();
        const ledgerBefore = inspector.query("SELECT * FROM migrations ORDER BY version").all();
        for (const readonly of [false, true]) {
          expect(() => new StateStore(store.paths, { readonly })).toThrow("STATE_SCHEMA_V41_TIMESTAMP_PROOF_GUARD_INVALID");
          expect(inspector.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all()).toEqual(schemaBefore);
          expect(inspector.query("SELECT * FROM migrations ORDER BY version").all()).toEqual(ledgerBefore);
          expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: 61 });
        }
      } finally { inspector.close(false); }
    }
  });
for (const definition of ["missing", "weaker", "changed_literal"] as const) {
    test(`refuses a damaged timestamp guard on exact schema 41 before Work v42 migration: ${definition}`, async () => {
      const paths = await canonicalTimestampArchiveForTest(41);
      const inspector = new Database(paths.database, { create: false, strict: true });
      try {
        const original = z.object({ sql: z.string() }).parse(inspector.query(
          "SELECT sql FROM sqlite_master WHERE name='mutation_resolutions_timestamp_proof_insert'",
        ).get()).sql;
        inspector.exec("DROP TRIGGER mutation_resolutions_timestamp_proof_insert");
        if (definition === "weaker") {
          inspector.exec("CREATE TRIGGER mutation_resolutions_timestamp_proof_insert BEFORE INSERT ON mutation_resolutions BEGIN SELECT 1; END");
        } else if (definition === "changed_literal") {
          inspector.exec(original.replace("'unix_milliseconds_v1'", "'unix_milliseconds_v1  '"));
        }
        const schemaBefore = inspector.query(
          "SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name",
        ).all();
        const ledgerBefore = inspector.query("SELECT * FROM migrations ORDER BY version").all();

        expect(() => { new StateStore(paths).close(); }).toThrow(
          "STATE_SCHEMA_V41_TIMESTAMP_PROOF_GUARD_INVALID",
        );
        expect(() => { new StateStore(paths, { readonly: true }).close(); }).toThrow(
          "STATE_SCHEMA_MIGRATION_REQUIRED:41:61",
        );
        expect(inspector.query(
          "SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name",
        ).all()).toEqual(schemaBefore);
        expect(inspector.query("SELECT * FROM migrations ORDER BY version").all())
          .toEqual(ledgerBefore);
        expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: 41 });
      } finally { inspector.close(false); }
    });
  }
test.each(["missing", "negative_time", "unsafe_time", "later_version"] as const)(
    "refuses an invalid authentic schema 40 ledger without changing retained rows or schema: %s",
    async (damage) => {
      const paths = await canonicalTimestampArchiveForTest(40);
      const inspector = new Database(paths.database, { create: false, strict: true });
      try {
        if (damage === "missing") inspector.exec("DELETE FROM migrations WHERE version=40");
        else if (damage === "negative_time") {
          inspector.exec("PRAGMA ignore_check_constraints=ON; UPDATE migrations SET applied_at=-1 WHERE version=40; PRAGMA ignore_check_constraints=OFF;");
        } else if (damage === "unsafe_time") {
          inspector.query("UPDATE migrations SET applied_at=? WHERE version=40")
            .run(Number.MAX_SAFE_INTEGER + 1);
        } else inspector.exec("INSERT INTO migrations(version,applied_at) VALUES (41,1000)");
        const schemaBefore = inspector.query(
          "SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name",
        ).all();
        const ledgerBefore = inspector.query("SELECT * FROM migrations ORDER BY version").all();

        expect(() => { new StateStore(paths).close(); }).toThrow(
          damage === "negative_time" ? "Too small: expected number to be >=0"
            : damage === "unsafe_time" ? "Integers must be within the safe integer range."
              : "STATE_SCHEMA_COHORT_LEDGER_INVALID",
        );
        expect(() => { new StateStore(paths, { readonly: true }).close(); }).toThrow(
          "STATE_SCHEMA_MIGRATION_REQUIRED:40:61",
        );
        expect(inspector.query(
          "SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name",
        ).all()).toEqual(schemaBefore);
        expect(inspector.query("SELECT * FROM migrations ORDER BY version").all())
          .toEqual(ledgerBefore);
        expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: 40 });
      } finally { inspector.close(false); }
    },
  );
test.each([
    "missing_40",
    "missing_41",
    "negative_time",
    "unsafe_time",
    "later_version",
  ] as const)(
    "refuses an invalid schema 41 migration ledger without changing retained rows or schema: %s",
    async (damage) => {
      const paths = await canonicalTimestampArchiveForTest(41);
      const profile = canonical41TimestampsFixture.profiles[0];
      const session = canonical41TimestampsFixture.queueSession;
      const inspector = new Database(paths.database, { create: false, strict: true });
      try {
        if (damage === "missing_40") inspector.exec("DELETE FROM migrations WHERE version=40");
        else if (damage === "missing_41") inspector.exec("DELETE FROM migrations WHERE version=41");
        else if (damage === "negative_time") {
          // Model an already malformed database; restore constraint enforcement
          // before asking either admission path to inspect it.
          inspector.exec("PRAGMA ignore_check_constraints=ON; UPDATE migrations SET applied_at=-1 WHERE version=41; PRAGMA ignore_check_constraints=OFF;");
        } else if (damage === "unsafe_time") {
          inspector.query("UPDATE migrations SET applied_at=? WHERE version=41").run(Number.MAX_SAFE_INTEGER + 1);
        } else inspector.exec("INSERT INTO migrations(version,applied_at) VALUES (44,1000)");
        const schemaBefore = inspector.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all();
        const ledgerBefore = inspector.query("SELECT * FROM migrations ORDER BY version").all();
        const sessionBefore = inspector.query("SELECT * FROM sessions WHERE id=?").get(session.id);
        const profileBefore = inspector.query("SELECT * FROM profiles WHERE id=?").get(profile.id);
        expect(() => { new StateStore(paths).close(); }).toThrow(
          "STATE_SCHEMA_V41_MIGRATION_LEDGER_INVALID",
        );
        expect(() => { new StateStore(paths, { readonly: true }).close(); }).toThrow(
          "STATE_SCHEMA_MIGRATION_REQUIRED:41:61",
        );
        expect(inspector.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all()).toEqual(schemaBefore);
        expect(inspector.query("SELECT * FROM migrations ORDER BY version").all()).toEqual(ledgerBefore);
        expect(inspector.query("SELECT * FROM sessions WHERE id=?").get(session.id)).toEqual(sessionBefore);
        expect(inspector.query("SELECT * FROM profiles WHERE id=?").get(profile.id)).toEqual(profileBefore);
        expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: 41 });
      } finally { inspector.close(false); }
    },
  );
for (const version of [45, 46, 47, 48, 61] as const) test.each([
    "missing_table", "missing_guard", "weaker_guard", "wrong_table_guard", "extra_index",
  ] as const)(
    `auth45 authority refuses DDL drift at ${version === 47 ? "source-derived staged schema 47" : `schema ${String(version)}`} without writes: %s`,
    async (damage) => {
      const paths = await (async () => {
        if (version === 45 || version === 46) return canonicalAuthBudgetArchive(version);
        if (version === 47) return stagedCanonical47Archive();
        if (version === 48) return canonical48WorkArchive();
        const { store } = await fixture({ provision: "migrate" });
        signInProfile(store, "Auth schema drift", "auth-schema@example.com");
        return store.paths;
      })();
      const inspector = new Database(paths.database, { create: false, strict: true });
      try {
        // Versions45/46/48 begin at authentic archived bytes. The following
        // DDL damage is intentional adversarial input, not producer output;
        // stage47 separately removes only an exact empty source48 component.
        if (damage === "missing_table") inspector.exec("DROP TABLE account_mutation_authority_rebinds");
        else if (damage === "extra_index") inspector.exec("CREATE INDEX unreviewed_auth_index ON account_mutation_authority_rebinds(profile_id)");
        else {
          inspector.exec("DROP TRIGGER account_mutation_authority_rebinds_insert_guard");
          if (damage === "weaker_guard") inspector.exec("CREATE TRIGGER account_mutation_authority_rebinds_insert_guard BEFORE INSERT ON account_mutation_authority_rebinds BEGIN SELECT 1; END");
          if (damage === "wrong_table_guard") inspector.exec("CREATE TRIGGER account_mutation_authority_rebinds_insert_guard BEFORE INSERT ON profiles BEGIN SELECT 1; END");
        }
        const before = canonicalAuthBudgetSnapshot(inspector);
        for (const readonly of [false, true]) {
          expect(() => new StateStore(paths, { readonly })).toThrow(
            readonly && version < 61
              ? `STATE_SCHEMA_MIGRATION_REQUIRED:${String(version)}:61`
              : "STATE_SCHEMA_V45_ACCOUNT_MUTATION_AUTHORITY_INVALID",
          );
          expect(canonicalAuthBudgetSnapshot(inspector)).toEqual(before);
          expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: version });
        }
      } finally { inspector.close(false); }
    },
  );
for (const version of [45, 46, 47, 48] as const) test(`${version === 47 ? "source-derived staged schema 47" : `schema ${String(version)}`} refuses a missing auth45 ledger entry before migration`, async () => {
    const paths = version === 45 || version === 46
      ? await canonicalAuthBudgetArchive(version)
      : version === 48 ? await canonical48WorkArchive() : await stagedCanonical47Archive();
    const inspector = new Database(paths.database, { create: false, strict: true });
    try {
      inspector.exec("DELETE FROM migrations WHERE version=45");
      const before = canonicalAuthBudgetSnapshot(inspector);
      for (const readonly of [false, true]) {
        expect(() => new StateStore(paths, { readonly })).toThrow(
          readonly ? `STATE_SCHEMA_MIGRATION_REQUIRED:${String(version)}:61`
            : `STATE_SCHEMA_V${String(version)}_MIGRATION_LEDGER_INVALID`,
        );
        expect(canonicalAuthBudgetSnapshot(inspector)).toEqual(before);
        expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: version });
      }
    } finally { inspector.close(false); }
  });
test("migrates source-derived staged schema 47 without rewriting prior rows or minting runtime authority", async () => {
    const paths = await stagedCanonical47Archive();
    const database = new Database(paths.database, { create: false, strict: true });
    try {
      const before = canonicalAuthBudgetSnapshot(database);
      const oldRows = canonicalAuthBudgetRows(database, Object.keys(before.rows).filter((table) => table !== "migrations"));
      const ledgerBefore = database.query("SELECT * FROM migrations ORDER BY version").all();
      expect(() => new StateStore(paths, { readonly: true })).toThrow("STATE_SCHEMA_MIGRATION_REQUIRED:47:61");
      expect(canonicalAuthBudgetSnapshot(database)).toEqual(before);
      const now = canonical48WorkFixture.fixedTime + 1_000;
      const store = new StateStore(paths, { now: () => now });
      try {
        expect(oldRows.read()).toEqual(oldRows.before);
        expect(database.query("SELECT * FROM migrations WHERE version<=47 ORDER BY version").all()).toEqual(ledgerBefore);
        expect(database.query("SELECT * FROM migrations WHERE version>47 ORDER BY version").all())
          .toEqual(Array.from({ length: 14 }, (_, index) => ({ version: index + 48, applied_at: now })));
        expect(database.query("SELECT * FROM session_provider_authorities").all()).toEqual([]);
        expect(database.query("SELECT * FROM legacy_provider_authority_quarantines ORDER BY scope_id").all())
          .toEqual(canonical48WorkFixture.retained.cases.map((entry) => ({ scope_kind: "session", scope_id: entry.session.id,
            reason: "missing_immutable_runtime_authority", recorded_at: now }))
            .sort((left, right) => left.scope_id.localeCompare(right.scope_id)));
      } finally { store.close(); }
      const after = canonicalAuthBudgetSnapshot(database);
      for (const readonly of [false, true]) {
        const reopened = new StateStore(paths, { readonly });
        try { expect(canonicalAuthBudgetSnapshot(database)).toEqual(after); } finally { reopened.close(); }
      }
    } finally { database.close(false); }
  });
test("auth45 schema rejects colliding predecessor objects and rolls back the whole migration", async () => {
    for (const collision of ["table", "trigger"] as const) {
      const paths = await canonicalAuthBudgetArchive(44);
      const inspector = new Database(paths.database, { create: false, strict: true });
      try {
        // Only this named collision is synthetic; the predecessor schema,
        // ledger, pending auth origin and budget history are archived44.
        if (collision === "table") inspector.exec("CREATE TABLE account_mutation_authority_rebinds(unreviewed TEXT) STRICT");
        else inspector.exec("CREATE TRIGGER account_mutation_authority_rebinds_insert_guard BEFORE INSERT ON profiles BEGIN SELECT 1; END");
        const before = canonicalAuthBudgetSnapshot(inspector);
        expect(() => new StateStore(paths, { readonly: true })).toThrow("STATE_SCHEMA_MIGRATION_REQUIRED:44:61");
        expect(() => new StateStore(paths)).toThrow("already exists");
        expect(canonicalAuthBudgetSnapshot(inspector)).toEqual(before);
        expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: 44 });
      } finally { inspector.close(false); }
    }
  });
test("auth45 migration preserves exact v44 auth origins, autorespond policy, budgets, evidence, and guards", async () => {
    const paths = await canonicalAuthBudgetArchive(44);
    const captured = canonicalAuthBudgetFixtures[44].retained;
    const profile = captured.loginProfile;
    const sibling = captured.sibling;
    const siblingSession = captured.claude.session;
    const attempt = captured.login;
    const inspector = new Database(paths.database, { create: false, strict: true });
    try {
      expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: 44 });
      const quarantine = canonicalAuthBudgetPendingQuarantine(inspector, 50_000);
      const stable = canonicalAuthBudgetRows(inspector, [
        "profiles", "sessions", "session_runtime_profiles", "usage_snapshots", "usage_revision_authority",
        "mutation_attempts", "mutation_effect_evidence", "daemon_state", "session_approval_modes",
        "session_autorespond_counters", "autorespond_budget_history", "autorespond_budget_reservations",
        "autorespond_evidence",
      ]);
      const oldLedger = inspector.query("SELECT * FROM migrations ORDER BY version").all();
      const stableSchema = canonicalAuthBudgetFrozenSchema(inspector);
      expect(inspector.query("SELECT kind,state,authority_generation FROM mutation_attempts WHERE id=?").get(attempt.id))
        .toEqual({ kind: "account.login", state: "effect_started", authority_generation: 1 });
      expect(inspector.query("SELECT state,process_generation FROM profiles WHERE id=?").get(profile.id))
        .toEqual({ state: "login_pending", process_generation: 1 });
      const beforeReadonly = canonicalAuthBudgetSnapshot(inspector);
      expect(() => new StateStore(paths, { readonly: true })).toThrow("STATE_SCHEMA_MIGRATION_REQUIRED:44:61");
      expect(canonicalAuthBudgetSnapshot(inspector)).toEqual(beforeReadonly);
      const reopened = new StateStore(paths, { now: () => 50_000 });
      stores.push(reopened);
      for (const row of stableSchema) expect(canonicalAuthBudgetFrozenSchema(inspector)).toContainEqual(row);
      expect(inspector.query("SELECT * FROM migrations WHERE version<45 ORDER BY version").all()).toEqual(oldLedger);
      expect(inspector.query("SELECT version,applied_at FROM migrations WHERE version=45").get())
        .toEqual({ version: 45, applied_at: 50_000 });
      expect(stable.read()).toEqual({ ...stable.before, sessions: quarantine.sessions });
      quarantine.assertInstalled(reopened);
      expect(reopened.latestUsage(sibling.id)).toEqual(captured.usage);
      expect(reopened.readMutation(captured.loginKey)).toMatchObject({
        id: attempt.id, authorityId: profile.id, authorityGeneration: 1, kind: "account.login", state: "effect_started",
      });
      expect(reopened.readDefaultApprovalMode()).toBe("auto:workspace");
      expect(reopened.readSessionApprovalMode(siblingSession.id)).toEqual({ mode: "auto:all", source: "session" });
      expect(reopened.readAutorespondBudgets(siblingSession.id)).toEqual({ consecutive: 1, lastHour: 1, lastDay: 1 });
      expect(() => inspector.query("UPDATE autorespond_budget_reservations SET reserved_at=reserved_at+1 WHERE session_id=?")
        .run(siblingSession.id)).toThrow("autorespond budget reservation is immutable");
      expect(() => inspector.query("UPDATE autorespond_budget_history SET available_at=available_at+1 WHERE session_id=?")
        .run(siblingSession.id)).toThrow("autorespond budget history is immutable");
      expect(inspector.query("SELECT count(*) AS count FROM account_mutation_authority_rebinds").get()).toEqual({ count: 0 });
      expect(inspector.query("SELECT count(*) AS count FROM mutation_resolutions WHERE attempt_id=?").get(attempt.id)).toEqual({ count: 0 });
      expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: 61 });
      const after = canonicalAuthBudgetSnapshot(inspector);
      for (const readonly of [false, true]) {
        const again = new StateStore(paths, { readonly, now: () => 50_001 });
        stores.push(again);
        expect(again.readMutation(captured.loginKey)).toEqual(reopened.readMutation(captured.loginKey));
        expect(canonicalAuthBudgetSnapshot(inspector)).toEqual(after);
      }
    } finally { inspector.close(false); }
  });
test("migrates authentic canonical50 ledger and preserves old bytes without inventing session runtime authority", async () => {
    const paths = await canonical50LedgerArchive();
    const captured = canonicalLoginLedgerFixtures[50].retained;
    const migratedAt = 70_000;
    const inspector = new Database(paths.database, { create: false, strict: true });
    try {
      expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: 50 });
      const tables = z.array(z.object({ name: z.string().regex(/^[a-z_0-9]+$/u) }).strict()).parse(
        inspector.query("SELECT name FROM sqlite_master WHERE type='table' AND name!='migrations' ORDER BY name LIMIT 257").all(),
      );
      expect(tables.length).toBeLessThanOrEqual(256);
      // Freeze the archived column names before ALTER TABLE. Compare storage
      // types and original cell bytes, not decoded or newly added projections.
      const reads = tables.map(({ name }) => {
        const columns = z.array(z.object({ name: z.string().regex(/^[a-z_0-9]+$/u) })).parse(
          inspector.query(`PRAGMA table_info("${name}")`).all(),
        );
        expect(columns.length).toBeGreaterThan(0);
        expect(columns.length).toBeLessThanOrEqual(64);
        const fields = columns.map(({ name: column }) =>
          `typeof("${column}") || ':' || hex(CAST("${column}" AS BLOB)) AS "${column}"`);
        return { name, sql: `SELECT ${fields.join(",")} FROM "${name}" LIMIT 4097` };
      });
      const originalCells = () => Object.fromEntries(reads.map(({ name, sql }) => {
        const statement = inspector.prepare(sql);
        try {
          const rows = statement.all().sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
          expect(rows.length).toBeLessThanOrEqual(4096);
          return [name, rows];
        } finally { statement.finalize(); }
      }));
      const oldCells = originalCells();
      const oldLedger = inspector.query("SELECT * FROM migrations ORDER BY version").all();
      expect(oldLedger).toHaveLength(50);
      expect(inspector.query("SELECT * FROM session_runtime_profiles").all()).toEqual([]);
      const beforeReadonly = canonicalAuthBudgetSnapshot(inspector);
      expect(() => new StateStore(paths, { readonly: true }))
        .toThrow("STATE_SCHEMA_MIGRATION_REQUIRED:50:61");
      expect(canonicalAuthBudgetSnapshot(inspector)).toEqual(beforeReadonly);

      const migrated = new StateStore(paths, { now: () => migratedAt });
      stores.push(migrated);
      expect(originalCells()).toEqual(oldCells);
      expect(inspector.query("SELECT * FROM migrations WHERE version<=50 ORDER BY version").all()).toEqual(oldLedger);
      expect(inspector.query("SELECT * FROM migrations WHERE version>50 ORDER BY version").all())
        .toEqual(Array.from({ length: 11 }, (_, index) => ({ version: index + 51, applied_at: migratedAt })));
      expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: 61 });
      expect(inspector.query("SELECT scope_kind,scope_id,reason,recorded_at FROM legacy_provider_authority_quarantines ORDER BY scope_kind,scope_id").all())
        .toEqual([{ scope_kind: "session", scope_id: captured.session.id,
          reason: "missing_immutable_runtime_authority", recorded_at: migratedAt }]);
      expect(inspector.query("SELECT * FROM session_provider_authorities").all()).toEqual([]);
      expect(inspector.query("SELECT * FROM runtime_profile_provider_authorities").all()).toEqual([]);
      expect(inspector.query("SELECT * FROM session_runtime_profiles").all()).toEqual([]);
      expect(migrated.requireProfileById(captured.profile.id)).toEqual(captured.profile);
      expect(migrated.requireSession(captured.session.id)).toMatchObject(captured.session);
      expect(() => migrated.requireCapturedSessionProviderAuthority(captured.session.id))
        .toThrow("SESSION_PROVIDER_AUTHORITY_QUARANTINED:missing_immutable_runtime_authority");
      const after = canonicalAuthBudgetSnapshot(inspector);
      for (const readonly of [false, true]) {
        const reopened = new StateStore(paths, { readonly, now: () => migratedAt + 1 });
        stores.push(reopened);
        expect(reopened.requireProfileById(captured.profile.id)).toEqual(captured.profile);
        expect(reopened.requireSession(captured.session.id)).toMatchObject(captured.session);
        expect(() => reopened.requireCapturedSessionProviderAuthority(captured.session.id))
          .toThrow("SESSION_PROVIDER_AUTHORITY_QUARANTINED:missing_immutable_runtime_authority");
        expect(originalCells()).toEqual(oldCells);
        expect(canonicalAuthBudgetSnapshot(inspector)).toEqual(after);
      }
    } finally { inspector.close(false); }
  });
for (const version of [49, 50, 61] as const) test.each([
    "missing_40",
    "missing_41",
    "missing_42",
    "missing_43",
    "missing_44",
    "missing_45",
    "missing_46",
    "missing_47",
    "missing_48",
    "missing_49",
    ...(version >= 50 ? ["missing_50" as const] : []),
    "negative_time",
    "unsafe_time",
    "later_version",
  ] as const)(
    `refuses an invalid ${version === 61 ? "current" : "authentic predecessor"} schema ${String(version)} migration ledger without writes: %s`,
    async (damage) => {
      let paths: ReturnType<typeof resolveStatePaths>;
      let profileId: string;
      let sessionId: string;
      if (version === 49) {
        const home = await realpath(await mkdtemp(join(tmpdir(), "oompa-ledger-canonical49-")));
        paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
        await initializeStatePaths(paths);
        await writeFile(paths.database, canonical49WorkDatabaseBytes(), { mode: 0o600 });
        profileId = canonical49WorkFixture.profileId;
        sessionId = canonical49WorkFixture.actorSessionId;
      } else if (version === 50) {
        paths = await canonical50LedgerArchive();
        profileId = canonicalLoginLedgerFixtures[50].retained.profile.id;
        sessionId = canonicalLoginLedgerFixtures[50].retained.session.id;
      } else {
        const { store } = await fixture();
        paths = store.paths;
        const profile = signInProfile(store, "Current ledger", "current-ledger@example.com");
        profileId = profile.id;
        sessionId = upsertProvenTestSession(store, {
          profileId,
          preset: "high",
          fastEnabled: false,
          providerThreadId: "current-ledger-thread",
          state: "idle",
          providerUpdatedAt: 10,
        }).id;
      }
      const inspector = new Database(paths.database, { create: false, strict: true });
      try {
        expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: version });
        if (damage === "missing_40") inspector.exec("DELETE FROM migrations WHERE version=40");
        else if (damage === "missing_41") inspector.exec("DELETE FROM migrations WHERE version=41");
        else if (damage === "missing_42") inspector.exec("DELETE FROM migrations WHERE version=42");
        else if (damage === "missing_43") inspector.exec("DELETE FROM migrations WHERE version=43");
        else if (damage === "missing_44") inspector.exec("DELETE FROM migrations WHERE version=44");
        else if (damage === "missing_45") inspector.exec("DELETE FROM migrations WHERE version=45");
        else if (damage === "missing_46") inspector.exec("DELETE FROM migrations WHERE version=46");
        else if (damage === "missing_47") inspector.exec("DELETE FROM migrations WHERE version=47");
        else if (damage === "missing_48") inspector.exec("DELETE FROM migrations WHERE version=48");
        else if (damage === "missing_49") inspector.exec("DELETE FROM migrations WHERE version=49");
        else if (damage === "missing_50") inspector.exec("DELETE FROM migrations WHERE version=50");
        else if (damage === "negative_time") {
          inspector.exec("PRAGMA ignore_check_constraints=ON; UPDATE migrations SET applied_at=-1 WHERE version=45; PRAGMA ignore_check_constraints=OFF;");
        } else if (damage === "unsafe_time") {
          inspector.query("UPDATE migrations SET applied_at=? WHERE version=45")
            .run(Number.MAX_SAFE_INTEGER + 1);
        } else inspector.query("INSERT INTO migrations(version,applied_at) VALUES (?,1000)").run(version + 1);
        const schemaBefore = inspector.query(
          "SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name",
        ).all();
        const ledgerBefore = inspector.query("SELECT * FROM migrations ORDER BY version").all();
        const sessionBefore = inspector.query("SELECT * FROM sessions WHERE id=?").get(sessionId);
        const profileBefore = inspector.query("SELECT * FROM profiles WHERE id=?").get(profileId);
        const allBefore = version === 50 ? canonicalAuthBudgetSnapshot(inspector) : undefined;

        for (const readonly of [false, true]) {
          expect(() => new StateStore(paths, { readonly })).toThrow(
            readonly && version < 61
              ? `STATE_SCHEMA_MIGRATION_REQUIRED:${String(version)}:61`
              : version === 61 ? "STATE_SCHEMA_JOIN_LEDGER_INVALID"
                : `STATE_SCHEMA_V${String(version)}_MIGRATION_LEDGER_INVALID`,
          );
          expect(inspector.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all()).toEqual(schemaBefore);
          expect(inspector.query("SELECT * FROM migrations ORDER BY version").all()).toEqual(ledgerBefore);
          expect(inspector.query("SELECT * FROM sessions WHERE id=?").get(sessionId)).toEqual(sessionBefore);
          expect(inspector.query("SELECT * FROM profiles WHERE id=?").get(profileId)).toEqual(profileBefore);
          expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: version });
          if (allBefore !== undefined) expect(canonicalAuthBudgetSnapshot(inspector)).toEqual(allBefore);
        }
      } finally { inspector.close(false); }
    },
  );
test("rejects an unbound legacy effect-started session creation at daemon admission", async () => {
    const { store } = await fixture();
    const profile = signInProfile(store, "Legacy start", "legacy-start@example.com");
    const starting = store.createSession({ profileId: profile.id, preset: "high", fastEnabled: false });
    const attempt = store.prepareMutation({
      kind: "session.start",
      authorityId: profile.id,
      authorityGeneration: profile.processGeneration,
      request: { message: null },
      idempotencyKey: "00000000-0000-4000-8000-000000000603",
    });
    expect(store.transitionMutation(attempt.id, "prepared", "effect_started")).toBe(true);

    expect(store.recoverEffectStartedMutations()).toEqual({
      recovered: [],
      unresolved: [{ id: attempt.id, kind: "session.start", authorityId: profile.id }],
    });
    expect(store.requireProfile(profile.id)).toMatchObject({ state: "signed_in" });
    expect(store.requireSession(starting.id)).toMatchObject({ state: "starting" });
  });
test("leaves unknown effect-started authorities unresolved so daemon admission can fail", async () => {
    const { store } = await fixture();
    const attempt = store.prepareMutation({
      kind: "unknown.effect",
      authorityId: "unknown-authority",
      authorityGeneration: 1,
      request: {},
      idempotencyKey: "00000000-0000-4000-8000-000000000604",
    });
    expect(store.transitionMutation(attempt.id, "prepared", "effect_started")).toBe(true);
    expect(store.recoverEffectStartedMutations()).toEqual({
      recovered: [],
      unresolved: [{ id: attempt.id, kind: "unknown.effect", authorityId: "unknown-authority" }],
    });
    expect(store.readMutation("00000000-0000-4000-8000-000000000604")).toMatchObject({ state: "effect_started" });
  });
test("rejects symlinked project roots", async () => {
    const { store, home } = await fixture();
    const actual = join(home, "actual");
    const link = join(home, "link");
    await mkdir(actual);
    await symlink(actual, link);
    await expect(store.createProject("Unsafe", link)).rejects.toThrow("without symbolic links");
  });
test("creates user-only profile directories", async () => {
    const { store } = await fixture();
    const profile = store.createProfile("Isolated");
    const owned = await initializeProfilePaths(store.paths, profile.id);
    expect(owned.codexHome).toContain(profile.id);
    expect(owned.desktopUserData).toContain(profile.id);
  });
test("exact session IDs remain selectable beyond the recent-list page", async () => {
    const { store } = await fixture();
    const profile = store.createProfile("Many");
    const first = store.createSession({ profileId: profile.id, title: "First", preset: "high", fastEnabled: false });
    for (let index = 0; index < 101; index += 1) store.createSession({ profileId: profile.id, title: `Session ${index}`, preset: "high", fastEnabled: false });
    expect(store.requireSession(first.id).id).toBe(first.id);
  });
test("pages every cloud session by stable identifier beyond the recent-list bound", async () => {
    const { store } = await fixture();
    const profile = store.createProfile("Cloud pages");
    const created = Array.from({ length: 53 }, (_, index) => store.createSession({
      fastEnabled: false,
      preset: "high",
      profileId: profile.id,
      title: `Cloud session ${index}`,
    }));
    const observed: string[] = [];
    let afterId: string | null = null;
    for (let pageNumber = 0; pageNumber < 4; pageNumber += 1) {
      const page = store.listCloudSessionPage({ afterId, limit: 25 });
      expect(page.sessions.length).toBeLessThanOrEqual(25);
      observed.push(...page.sessions.map((session) => session.id));
      afterId = page.continueAfterId;
      if (page.isDone) break;
    }
    expect(observed).toEqual(created.map((session) => session.id).sort());
    expect(afterId).toBeNull();
    expect(() => store.listCloudSessionPage({
      afterId: "not-a-session-id",
      limit: 25,
    })).toThrow();
  });
test("tombstones profiles while preserving exact historical session reads", async () => {
    const { store } = await fixture();
    const profile = signInProfile(store, "Archived", "archive@example.com");
    const session = store.createSession({
      profileId: profile.id,
      title: "Retained history",
      preset: "high",
      fastEnabled: false,
    });
    store.setSessionTurnState({
      sessionId: session.id,
      expectedRevision: session.revision,
      state: "terminal",
    });

    store.removeProfile(profile.id);

    expect(() => store.requireProfile(profile.id)).toThrow(SelectionError);
    expect(store.requireProfileById(profile.id, { includeRemoved: true })).toMatchObject({
      id: profile.id,
      state: "removed",
    });
    expect(store.requireSession(session.id)).toMatchObject({
      id: session.id,
      title: "Retained history",
      profileId: profile.id,
    });
    expect(() => store.requireAccountRateLimitResetPolicy(profile.id))
      .toThrow("ACCOUNT_RATE_LIMIT_RESET_POLICY_MISSING");
  });
test("enforces every queue transition at both the store and SQLite boundaries", async () => {
    const { store } = await fixture();
    const profile = signInProfile(store, "Queue graph", "queue-graph@example.com");
    const session = createProvenTestSession(store, {
      profileId: profile.id,
      preset: "high",
      fastEnabled: false,
    });
    const database = new Database(store.paths.database, { create: false, strict: true });
    try {
      for (const from of queueStateSchema.options) {
        for (const to of queueStateSchema.options) {
          const throughStore = store.enqueue(session.id, `${from} to ${to} through store`);
          moveQueueTo(store, throughStore.id, from);
          if (canTransitionQueue(from, to)) {
            expect(store.transitionQueue(throughStore.id, from, to)).toBe(true);
          } else {
            expect(() => store.transitionQueue(throughStore.id, from, to)).toThrow(
              `Illegal queue transition: ${from} -> ${to}`,
            );
          }

          const throughSql = store.enqueue(session.id, `${from} to ${to} through sqlite`);
          moveQueueTo(store, throughSql.id, from);
          const direct = () =>
            database
              .query("UPDATE queue_entries SET state=? WHERE id=? AND state=?")
              .run(to, throughSql.id, from);
          if (canTransitionQueue(from, to)) {
            expect(direct).not.toThrow();
          } else {
            expect(direct).toThrow("illegal queue transition");
          }
        }
      }
    } finally {
      database.close(false);
    }
  });
test("preserves enqueue FIFO when queue timestamps are identical", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "oompa-store-fifo-")));
    const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
    await initializeStatePaths(paths);
    const store = new StateStore(paths, { now: () => 1_000 });
    stores.push(store);
    const profile = signInProfile(store, "Queue FIFO", "queue-fifo@example.com");
    const session = createProvenTestSession(store, {
      profileId: profile.id,
      preset: "high",
      fastEnabled: false,
    });
    const first = store.enqueue(session.id, "first");
    const second = store.enqueue(session.id, "second");

    expect(first.createdAt).toBe(second.createdAt);
    expect(store.listQueue(session.id).map((entry) => entry.id)).toEqual([first.id, second.id]);
    expect(store.nextPendingQueue(session.id)?.id).toBe(first.id);
    expect(store.transitionQueue(first.id, "pending", "dispatching")).toBe(true);
    expect(store.transitionQueue(first.id, "dispatching", "failed")).toBe(true);
    expect(store.nextPendingQueue(session.id)?.id).toBe(second.id);
    expect(() => store.enqueue(`sess_${"f".repeat(32)}`, "must roll back"))
      .toThrow("SESSION_PROVIDER_AUTHORITY_MISSING");
    const third = store.enqueue(session.id, "third");

    const inspector = new Database(paths.database, { create: false, strict: true });
    try {
      expect(inspector.query(
        "SELECT id,enqueue_sequence FROM queue_entries ORDER BY enqueue_sequence",
      ).all()).toEqual([
        { enqueue_sequence: 1, id: first.id },
        { enqueue_sequence: 2, id: second.id },
        { enqueue_sequence: 3, id: third.id },
      ]);
      expect(() => inspector.query(
        "UPDATE queue_entries SET enqueue_sequence=enqueue_sequence+100 WHERE id=?",
      ).run(second.id)).toThrow("QUEUE_ATTACHMENT_IDENTITY_CORRUPT");
      expect(() => inspector.query(
        `INSERT OR REPLACE INTO queue_entries(
           id,session_id,message,state,created_at,updated_at,enqueue_sequence
         ) VALUES(?,?,?,?,?,?,?)`,
      ).run(second.id, session.id, "replace existing id", "pending", 1_000, 1_000, 100))
        .toThrow("queue enqueue identity already exists");
      expect(() => inspector.query(
        `INSERT OR REPLACE INTO queue_entries(
           id,session_id,message,state,created_at,updated_at,enqueue_sequence
         ) VALUES(?,?,?,?,?,?,?)`,
      ).run(`queue_${"f".repeat(32)}`, session.id, "steal sequence", "pending", 1_000, 1_000, 2))
        .toThrow("queue enqueue identity already exists");
      expect(inspector.query(
        "SELECT id,enqueue_sequence FROM queue_entries ORDER BY enqueue_sequence",
      ).all()).toEqual([
        { enqueue_sequence: 1, id: first.id },
        { enqueue_sequence: 2, id: second.id },
        { enqueue_sequence: 3, id: third.id },
      ]);
      expect(() => inspector.query(
        "UPDATE queue_sequence_authority SET next_sequence=1 WHERE singleton=1",
      ).run()).toThrow("queue sequence authority cannot regress");
      expect(() => inspector.query(
        "INSERT OR REPLACE INTO queue_sequence_authority(singleton,next_sequence) VALUES(1,1)",
      ).run()).toThrow("queue sequence authority already exists");
    } finally {
      inspector.close(false);
    }
  });
test("selects the oldest pending queue row without scanning terminal history", async () => {
    const { store } = await fixture();
    const profile = signInProfile(store, "Bounded queue lookup", "bounded-queue@example.com");
    const session = createProvenTestSession(store, {
      profileId: profile.id,
      preset: "high",
      fastEnabled: false,
    });
    const terminal = store.enqueue(session.id, "terminal control");
    expect(store.transitionQueue(terminal.id, "pending", "cancelled")).toBe(true);
    expect(store.requireQueue(terminal.id)).toMatchObject({
      message: "[queue message removed after settlement]",
      state: "cancelled",
    });

    // This test measures pending lookup over history, not 2,000 physical scrub
    // checkpoints. Clone one genuinely settled row with every guard enabled.
    const history = new Database(store.paths.database, { create: false, strict: true });
    try {
      history.exec("PRAGMA foreign_keys=ON");
      expect(history.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
      const allocateSequence = history.query(
        `UPDATE queue_sequence_authority SET next_sequence=next_sequence+1
         WHERE singleton=1 AND next_sequence<9007199254740991
         RETURNING next_sequence-1 AS enqueue_sequence`,
      );
      const sequenceSchema = z.object({
        enqueue_sequence: z.number().int().positive().safe(),
      }).strict();
      const insertedIdSchema = z.object({ id: z.string() }).strict();
      const insertTerminal = history.query(
        `INSERT INTO queue_entries(
           id,session_id,message,state,created_at,updated_at,message_actor,peer_action_id,
           transcript_finalized,transcript_status,transcript_intent_json,enqueue_sequence
         ) SELECT ?,session_id,message,state,created_at,updated_at,message_actor,peer_action_id,
                  transcript_finalized,transcript_status,transcript_intent_json,?
           FROM queue_entries WHERE id=? RETURNING id`,
      );
      history.transaction(() => {
        for (let index = 1; index < 2_000; index += 1) {
          const { enqueue_sequence: sequence } = sequenceSchema.parse(allocateSequence.get());
          const id = createQueueId();
          if (insertedIdSchema.parse(insertTerminal.get(id, sequence, terminal.id)).id !== id) {
            throw new Error("Terminal queue history fixture lost its template.");
          }
        }
      }).immediate();
      expect(history.query(
        `SELECT COUNT(*) AS total,COUNT(DISTINCT id) AS ids,
                COUNT(DISTINCT enqueue_sequence) AS sequences,
                MIN(enqueue_sequence) AS first,MAX(enqueue_sequence) AS last
         FROM queue_entries`,
      ).get()).toEqual({ total: 2_000, ids: 2_000, sequences: 2_000, first: 1, last: 2_000 });
      expect(history.query(
        "SELECT next_sequence FROM queue_sequence_authority WHERE singleton=1",
      ).get()).toEqual({ next_sequence: 2_001 });
      const terminalShapeColumns = `session_id,message,state,created_at,updated_at,
        message_actor,peer_action_id,transcript_finalized,transcript_status,transcript_intent_json`;
      expect(history.query(
        `SELECT DISTINCT ${terminalShapeColumns} FROM queue_entries`,
      ).all()).toEqual([history.query(
        `SELECT ${terminalShapeColumns} FROM queue_entries WHERE id=?`,
      ).get(terminal.id)]);
      // Even already-scrubbed terminal inserts must create real scrub debt.
      expect(history.query(
        "SELECT generation,requires_vacuum FROM queue_message_scrub_authority WHERE singleton=1",
      ).get()).toEqual({ generation: 1_999, requires_vacuum: 0 });
    } finally {
      history.close(false);
    }
    // The public transition owns the pending scrub before its CAS. The control
    // is already cancelled, so this drains debt without creating another row.
    expect(store.transitionQueue(terminal.id, "pending", "cancelled")).toBe(false);
    const scrubInspector = new Database(store.paths.database, { readonly: true, strict: true });
    try {
      expect(scrubInspector.query(
        "SELECT singleton FROM queue_message_scrub_authority",
      ).all()).toEqual([]);
      expect(scrubInspector.query("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      scrubInspector.close(false);
    }
    const expected = store.enqueue(session.id, "bounded pending work");
    const later = store.enqueue(session.id, "later pending work");

    const originalListQueue = store.listQueue.bind(store);
    (store as unknown as { listQueue: StateStore["listQueue"] }).listQueue = () => {
      throw new Error("nextPendingQueue must not materialize terminal history");
    };
    try {
      expect(store.nextPendingQueue(session.id)).toMatchObject({
        id: expected.id,
        message: "bounded pending work",
        state: "pending",
      });
    } finally {
      (store as unknown as { listQueue: StateStore["listQueue"] }).listQueue = originalListQueue;
    }
    expect(store.nextPendingQueue(session.id)?.id).not.toBe(later.id);

    const inspector = new Database(store.paths.database, { create: false, strict: true });
    try {
      const plan = inspector.query(
        `EXPLAIN QUERY PLAN
         SELECT id,session_id,message,state,created_at,updated_at
         FROM queue_entries
         WHERE session_id=? AND state='pending'
         ORDER BY enqueue_sequence LIMIT 1`,
      ).all(session.id) as Array<{ detail: string }>;
      expect(plan.map((entry) => entry.detail).join(" ")).toContain("queue_pending_sequence");
    } finally {
      inspector.close(false);
    }
  });
test("removes settled queue bodies without losing replay or recovery authority", async () => {
    const { store } = await fixture();
    const profile = signInProfile(store, "Queue body custody", "queue-body@example.com");
    const importedSession = upsertProvenTestSession(store, {
      profileId: profile.id,
      preset: "high",
      fastEnabled: false,
      providerThreadId: "thread-queue-body-custody",
      state: "idle",
      providerUpdatedAt: 10,
    });
    const session = store.updateSessionMetadata({
      sessionId: importedSession.id,
      expectedRevision: importedSession.revision,
      preset: "high",
    });
    const runtime = {
      profileId: profile.id,
      processGeneration: profile.processGeneration,
      observedAt: 2_000,
      preset: "high" as const,
      model: "gpt-6-astra",
      reasoningEffort: "max" as const,
      serviceTier: null,
      fast: false,
      approvalPolicy: "on-request" as const,
      reviewMode: "auto_review" as const,
      permissionProfile: ":workspace" as const,
      computerUse: true as const,
      pluginCapability: true as const,
      enabledApps: [],
    };
    const removed = "[queue message removed after settlement]";
    const pending = store.enqueue(session.id, "pending body remains available");
    const providerAuthority = store.requireProviderAccountAuthority(profile.id, "codex");
    expect(store.requireQueue(pending.id).message).toBe("pending body remains available");

    const replayKey = "00000000-0000-4000-8000-000000000801";
    const sentinel = "QUEUE_TERMINAL_BODY_SENTINEL";
    const maximumBody = `${sentinel}${"x".repeat(262_144 - sentinel.length)}`;
    const cancelled = store.enqueueIdempotent({
      sessionId: session.id,
      profileGeneration: profile.processGeneration,
      providerAuthority,
      message: maximumBody,
      idempotencyKey: replayKey,
    });
    expect(store.transitionQueue(cancelled.id, "pending", "cancelled")).toBe(true);
    expect(store.requireQueue(cancelled.id)).toMatchObject({
      id: cancelled.id,
      message: removed,
      state: "cancelled",
    });
    expect(store.enqueueIdempotent({
      sessionId: session.id,
      profileGeneration: profile.processGeneration,
      providerAuthority,
      message: maximumBody,
      idempotencyKey: replayKey,
    })).toMatchObject({
      id: cancelled.id,
      message: removed,
      state: "cancelled",
    });
    expect(store.listQueue(session.id).filter((entry) => entry.id === cancelled.id))
      .toHaveLength(1);
    expect(await stateFileSuffixesContaining(store.paths.database, sentinel)).toEqual([]);

    const begin = (message: string) => {
      const queued = store.enqueue(session.id, message);
      const evidence = store.beginQueueEffect({
        queueId: queued.id,
        sessionId: session.id,
        profileGeneration: profile.processGeneration,
        providerAuthority,
        providerConnectionId: "10000000-0000-4000-8000-000000000006",
        evidence: {
          kind: "queue.dispatch",
          queueId: queued.id,
          sessionId: session.id,
          providerThreadId: "thread-queue-body-custody",
          profileGeneration: profile.processGeneration,
          baseline: { providerUpdatedAt: 10, status: "idle" as const, activeTurnId: null },
          clientMessageId: queued.id,
          messageDigest: new Bun.CryptoHasher("sha256").update(message).digest("hex"),
          runtimeProfile: runtime,
        },
      });
      return { evidence, queued };
    };

    const applied = begin("applied queue body sentinel");
    const invalidDispatchResolution = new Database(store.paths.database, { create: false, strict: true });
    try {
      expect(() => invalidDispatchResolution.query(
        `INSERT INTO queue_effect_resolutions(
           queue_id,resolution_kind,evidence_json,receipt_json,created_at
         ) VALUES (?,?,?,?,?)`,
      ).run(
        applied.queued.id,
        "abandoned",
        JSON.stringify({ source: "invalid_dispatch_resolution" }),
        null,
        2_000,
      )).toThrow("queue effect resolution authority mismatch");
      expect(invalidDispatchResolution.query(
        "SELECT message,state FROM queue_entries WHERE id=?",
      ).get(applied.queued.id)).toEqual({
        message: "applied queue body sentinel",
        state: "dispatching",
      });
    } finally {
      invalidDispatchResolution.close(false);
    }
    store.completeQueueEffect({
      queueId: applied.queued.id,
      accountId: profile.id,
      providerGeneration: profile.processGeneration,
      providerConnectionId: null,
      expectedEvidenceDigest: applied.evidence.digest,
      expectedSessionRevision: session.revision,
      applyResponseState: false,
      providerAuthority,
      turnId: "turn-queue-body-custody",
      turnStatus: "completed",
      runtimeProfile: runtime,
      message: "applied queue body sentinel",
      receipt: { turnId: "turn-queue-body-custody" },
    });
    expect(store.requireQueue(applied.queued.id)).toMatchObject({
      message: removed,
      state: "applied",
    });

    const failed = begin("failed queue body sentinel");
    expect(store.failQueueEffect(failed.queued.id)).toBe(true);
    expect(store.requireQueue(failed.queued.id)).toMatchObject({
      message: removed,
      state: "failed",
    });

    const ambiguous = begin("ambiguous body retained until exact recovery");
    store.markQueueEffectAmbiguous(ambiguous.queued.id, ambiguous.evidence.digest);
    expect(store.requireQueue(ambiguous.queued.id)).toMatchObject({
      message: "ambiguous body retained until exact recovery",
      state: "ambiguous",
    });
    const invalidAmbiguousResolution = new Database(store.paths.database, { create: false, strict: true });
    try {
      const insert = (kind: "abandoned" | "proven_applied", evidence: string, receipt: string | null) =>
        invalidAmbiguousResolution.query(
          `INSERT INTO queue_effect_resolutions(
             queue_id,resolution_kind,evidence_json,receipt_json,created_at
           ) VALUES (?,?,?,?,?)`,
        ).run(ambiguous.queued.id, kind, evidence, receipt, 2_000);
      expect(() => insert(
        "proven_applied",
        JSON.stringify({ source: "missing_receipt" }),
        null,
      )).toThrow("queue effect resolution authority mismatch");
      expect(() => insert(
        "abandoned",
        JSON.stringify({ source: "unexpected_receipt" }),
        JSON.stringify({ turnId: "turn-should-not-exist" }),
      )).toThrow("queue effect resolution authority mismatch");
      expect(() => insert("abandoned", "not-json", null))
        .toThrow("queue effect resolution authority mismatch");
      expect(() => insert(
        "abandoned",
        JSON.stringify({ source: "syntactically_valid_but_unauthorized" }),
        null,
      )).toThrow("queue effect resolution authority mismatch");
      invalidAmbiguousResolution.exec("BEGIN IMMEDIATE");
      try {
        invalidAmbiguousResolution.query(
          "UPDATE sessions SET state='idle',revision=revision+1,updated_at=updated_at+1 WHERE id=?",
        ).run(session.id);
        expect(() => insert(
          "proven_applied",
          JSON.stringify({ source: "missing_exact_turn_binding" }),
          JSON.stringify({ turnId: "turn-without-queue-binding" }),
        )).toThrow("queue effect resolution authority mismatch");
      } finally {
        invalidAmbiguousResolution.exec("ROLLBACK");
      }
      expect(invalidAmbiguousResolution.query(
        "SELECT message,state FROM queue_entries WHERE id=?",
      ).get(ambiguous.queued.id)).toEqual({
        message: "ambiguous body retained until exact recovery",
        state: "ambiguous",
      });
    } finally {
      invalidAmbiguousResolution.close(false);
    }
    store.resolveQueueEffect({
      queueId: ambiguous.queued.id,
      expectedEvidenceDigest: ambiguous.evidence.digest,
      resolution: "abandoned",
      resolutionEvidence: { source: "test_provider_observation" },
      provider: {
        providerThreadId: "thread-queue-body-custody",
        title: "Recovered queue body custody",
        status: "idle",
        providerUpdatedAt: 20,
      },
    });
    expect(store.requireQueue(ambiguous.queued.id)).toMatchObject({
      message: removed,
      state: "ambiguous",
    });
    expect(store.readQueueEffect(ambiguous.queued.id)).toMatchObject({
      digest: ambiguous.evidence.digest,
      resolution: {
        evidence: { source: "test_provider_observation" },
        kind: "abandoned",
      },
    });
    expect(store.listUnsettledQueueEffects(session.id)).toEqual([]);

    const directTransitionSentinel = "DIRECT_SQL_TERMINAL_BODY_SENTINEL";
    const terminalInsertSentinel = "DIRECT_SQL_TERMINAL_INSERT_SENTINEL";
    const insertedId = `queue_${"e".repeat(32)}`;
    const directTransition = store.enqueue(session.id, directTransitionSentinel);
    const inspector = new Database(store.paths.database, { create: false, strict: true });
    try {
      inspector.query(
        "UPDATE queue_entries SET state='cancelled',updated_at=updated_at+1 WHERE id=?",
      ).run(directTransition.id);
      expect(inspector.query("SELECT message,state FROM queue_entries WHERE id=?").get(
        directTransition.id,
      )).toEqual({ message: directTransitionSentinel, state: "cancelled" });
      expect(() => inspector.query(
        "UPDATE queue_entries SET message='restored raw body' WHERE id=?",
      ).run(directTransition.id)).toThrow(
        "queue message is immutable except for settlement removal",
      );
      expect(() => inspector.query(
        "UPDATE queue_entries SET message='rewritten pending body' WHERE id=?",
      ).run(pending.id)).toThrow(
        "QUEUE_ATTACHMENT_IDENTITY_CORRUPT",
      );

      inspector.query(
        `INSERT INTO queue_entries(
           id,session_id,message,state,created_at,updated_at,enqueue_sequence
         ) VALUES(?,?,?,?,?,?,?)`,
      ).run(
        insertedId,
        session.id,
        terminalInsertSentinel,
        "cancelled",
        1_000,
        1_000,
        900_000,
      );
      expect(inspector.query("SELECT message,state FROM queue_entries WHERE id=?").get(
        insertedId,
      )).toEqual({ message: terminalInsertSentinel, state: "cancelled" });
      expect(JSON.stringify(inspector.query(
        "SELECT message FROM queue_entries WHERE id IN (?,?) ORDER BY id",
      ).all(directTransition.id, insertedId)))
        .toContain(directTransitionSentinel);
      expect(inspector.query(
        "SELECT requires_vacuum FROM queue_message_scrub_authority WHERE singleton=1",
      ).get()).toEqual({ requires_vacuum: 0 });
    } finally {
      inspector.close(false);
    }
    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const reopened = new StateStore(paths, { now: () => 3_000 });
    stores.push(reopened);
    expect(reopened.requireQueue(directTransition.id)).toMatchObject({
      message: removed,
      state: "cancelled",
    });
    expect(reopened.requireQueue(insertedId as `queue_${string}`)).toMatchObject({
      message: removed,
      state: "cancelled",
    });
    expect(await stateFileSuffixesContaining(paths.database, directTransitionSentinel)).toEqual([]);
    expect(await stateFileSuffixesContaining(paths.database, terminalInsertSentinel)).toEqual([]);
    const scrubInspector = new Database(paths.database, { readonly: true, strict: true });
    try {
      expect(scrubInspector.query(
        "SELECT required_at,requires_vacuum FROM queue_message_scrub_authority WHERE singleton=1",
      ).get()).toBeNull();
    } finally {
      scrubInspector.close(false);
    }
  });
test("physically scrubs authentic settled queue bodies from an observed archived v20 stage", () => ownedStateStoreCase(async ({ request }) => {
    const paths = await request(() => canonical20To40Archive("observed20-settled-queues"));
    const capture = canonical20To40Fixture.captures["observed20-settled-queues"];
    const source = capture.retained;
    expect(capture.provenance).toMatchObject({
      kind: "uncommitted_archived_migration_stage",
      releasedWriterImage: false,
      observerRowOrSchemaWrites: false,
      observedBeforeOuterCommit: true,
    });
    const legacy = new Database(paths.database, { create: false, strict: true });
    // Retain the original column projections across closing the predecessor
    // connection, so additive joined columns cannot hide old-cell rewrites.
    const projections = ["queue_effect_evidence", "queue_effect_resolutions"].map((table) => {
      const columns = z.array(z.object({ name: z.string().regex(/^[a-z_0-9]+$/u) })).parse(
        legacy.query("PRAGMA table_info(" + table + ")").all(),
      ).map(({ name }) => name);
      expect(columns.length).toBeGreaterThan(0);
      const sql = "SELECT " + columns.join(",") + " FROM " + table + " ORDER BY queue_id";
      return { sql, rows: legacy.query(sql).all() };
    });
    try {
      const before = canonicalAuthBudgetSnapshot(legacy);
      expect(before.version).toEqual({ user_version: 20 });
      expect(createHash("sha256").update(JSON.stringify(before.schema)).digest("hex")).toBe(capture.snapshot.schemaSha256);
      expect(legacy.query("SELECT * FROM migrations ORDER BY version").all()).toEqual([...capture.snapshot.ledger]);
      expect(legacy.query("SELECT message,state FROM queue_entries WHERE id=?").get(source.terminal.id))
        .toEqual({ message: source.terminalMessage, state: "cancelled" });
      expect(legacy.query("SELECT message,state FROM queue_entries WHERE id=?").get(source.ambiguous.id))
        .toEqual({ message: source.ambiguousMessage, state: "ambiguous" });
      expect(legacy.query("SELECT name FROM sqlite_master WHERE name='queue_message_scrub_authority'").get()).toBeNull();
      expect(() => { new StateStore(paths, { readonly: true }).close(); }).toThrow("STATE_SCHEMA_MIGRATION_REQUIRED:20:61");
      expect(canonicalAuthBudgetSnapshot(legacy)).toEqual(before);
    } finally { legacy.close(false); }
    for (const message of [source.terminalMessage, source.ambiguousMessage]) {
      expect(await request(() => stateFileSuffixesContaining(paths.database, message))).toEqual([""]);
    }

    const migrated = new StateStore(paths, { now: () => 30_000, resolveMachineTimeZone: () => "UTC" });
    stores.push(migrated);
    const removed = "[queue message removed after settlement]";
    expect(migrated.requireQueue(source.terminal.id)).toMatchObject({ ...source.terminal, message: removed });
    expect(migrated.requireQueue(source.ambiguous.id)).toMatchObject({ ...source.ambiguous, message: removed });
    expectHistoricalValue(migrated.readQueueEffect(source.ambiguous.id), source.effect);
    expect(migrated.listUnsettledQueueEffects(source.session.id)).toEqual([]);
    const inspector = new Database(paths.database, { readonly: true, strict: true });
    try {
      for (const projection of projections) expect(inspector.query(projection.sql).all()).toEqual(projection.rows);
      expect(inspector.query("SELECT * FROM migrations WHERE version<=20 ORDER BY version").all()).toEqual([...capture.snapshot.ledger]);
      expect(inspector.query("SELECT applied_at FROM migrations WHERE version=23").get()).toEqual({ applied_at: 30_000 });
      expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: 61 });
      expect(inspector.query("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(inspector.query("SELECT required_at,requires_vacuum FROM queue_message_scrub_authority WHERE singleton=1").get()).toBeNull();
      const joined = canonicalAuthBudgetSnapshot(inspector);
      for (const readonly of [false, true]) {
        const reopened = new StateStore(paths, { readonly, now: () => 30_001, resolveMachineTimeZone: () => "UTC" });
        try { expectHistoricalValue(reopened.readQueueEffect(source.ambiguous.id), source.effect); }
        finally { reopened.close(); }
        expect(canonicalAuthBudgetSnapshot(inspector)).toEqual(joined);
      }
    } finally { inspector.close(false); }
    for (const message of [source.terminalMessage, source.ambiguousMessage]) {
      expect(await request(() => stateFileSuffixesContaining(paths.database, message))).toEqual([]);
    }
  }));
test("keeps a pinned-reader queue scrub unavailable until restart can truncate its WAL", async () => {
    const { store } = await fixture({ securityScrubCheckpoint: shortScrubCheckpoint });
    const profile = signInProfile(store, "Pinned queue scrub", "pinned-queue@example.com");
    const session = createProvenTestSession(store, {
      profileId: profile.id,
      preset: "high",
      fastEnabled: false,
    });
    const sentinel = `PINNED_QUEUE_BODY_SENTINEL_${"x".repeat(8_192)}`;
    const queued = store.enqueue(session.id, sentinel);
    const paths = store.paths;
    const pinnedReader = new Database(paths.database, { readonly: true, strict: true });
    pinnedReader.exec("BEGIN");
    expect(pinnedReader.query("SELECT message FROM queue_entries WHERE id=?").get(queued.id))
      .toEqual({ message: sentinel });
    try {
      let failure: unknown;
      try {
        store.transitionQueue(queued.id, "pending", "cancelled");
      } catch (error: unknown) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(StateSecurityScrubRequiredError);
      expect(failure).toMatchObject({
        message: "STATE_SECURITY_SCRUB_REQUIRED",
        operationCommitted: true,
      });
      expect(store.requireQueue(queued.id)).toMatchObject({
        message: "[queue message removed after settlement]",
        state: "cancelled",
      });
      const inspector = new Database(paths.database, { readonly: true, strict: true });
      try {
        expect(inspector.query(
          "SELECT requires_vacuum FROM queue_message_scrub_authority WHERE singleton=1",
        ).get()).toEqual({ requires_vacuum: 0 });
      } finally {
        inspector.close(false);
      }
      expect(() => {
        const unexpectedlyReadable = new StateStore(paths, { readonly: true });
        unexpectedlyReadable.close();
      }).toThrow("STATE_SECURITY_SCRUB_REQUIRED");
      expect(await stateFileSuffixesContaining(paths.database, "PINNED_QUEUE_BODY_SENTINEL"))
        .not.toEqual([]);
    } finally {
      pinnedReader.exec("COMMIT");
      pinnedReader.close(false);
    }

    // The same exact call first resumes the durable scrub. Its false result
    // preserves CAS ownership instead of pretending the retry performed the
    // already-committed transition.
    expect(store.transitionQueue(queued.id, "pending", "cancelled")).toBe(false);
    expect(await stateFileSuffixesContaining(paths.database, "PINNED_QUEUE_BODY_SENTINEL"))
      .toEqual([]);

    store.close();
    stores.splice(stores.indexOf(store), 1);
    const recovered = new StateStore(paths, { now: () => 4_000 });
    stores.push(recovered);
    expect(recovered.requireQueue(queued.id)).toMatchObject({
      message: "[queue message removed after settlement]",
      state: "cancelled",
    });
    expect(await stateFileSuffixesContaining(paths.database, "PINNED_QUEUE_BODY_SENTINEL"))
      .toEqual([]);
  }, 20_000);
test("completes a queue scrub after a brief reader releases its WAL snapshot", async () => {
    const { store, home } = await fixture();
    const profile = signInProfile(store, "Brief reader queue scrub", "brief-reader@example.com");
    const session = createProvenTestSession(store, {
      profileId: profile.id,
      preset: "high",
      fastEnabled: false,
    });
    const sentinel = `BRIEF_READER_QUEUE_BODY_SENTINEL_${"x".repeat(8_192)}`;
    const queued = store.enqueue(session.id, sentinel);
    const paths = store.paths;
    // 750 ms outlives the retired 250 ms single attempt and sits well inside
    // one 5 s attempt of the production policy.
    const reader = await spawnReaderProcess(home, "pinned-reader", pinnedReaderSource, [
      paths.database,
      "750",
    ]);
    try {
      expect(await reader.nextLine()).toBe("pinned");
      const startedAt = performance.now();
      expect(store.transitionQueue(queued.id, "pending", "cancelled")).toBe(true);
      // The checkpoint waited on the pinned snapshot rather than passing vacuously.
      expect(performance.now() - startedAt).toBeGreaterThanOrEqual(400);
      expect(await reader.nextLine()).toBe("released");
      expect(await reader.exited).toBe(0);
    } finally {
      reader.kill();
    }
    expect(store.requireQueue(queued.id)).toMatchObject({
      message: "[queue message removed after settlement]",
      state: "cancelled",
    });
    const inspector = new Database(paths.database, { readonly: true, strict: true });
    try {
      expect(inspector.query(
        "SELECT required_at FROM queue_message_scrub_authority WHERE singleton=1",
      ).get()).toBeNull();
    } finally {
      inspector.close(false);
    }
    expect(await stateFileSuffixesContaining(paths.database, "BRIEF_READER_QUEUE_BODY_SENTINEL"))
      .toEqual([]);
    const readonly = new StateStore(paths, { readonly: true });
    stores.push(readonly);
    expect(readonly.requireQueue(queued.id).state).toBe("cancelled");
  }, 20_000);
test("settles queue messages while a readonly status reader reopens the same state directory", async () => {
    const { store, home } = await fixture();
    const profile = signInProfile(store, "Status reader settlement", "status-reader@example.com");
    const session = createProvenTestSession(store, {
      profileId: profile.id,
      preset: "high",
      fastEnabled: false,
    });
    const paths = store.paths;
    const stopFile = join(home, "stop-status-reader");
    const reader = await spawnReaderProcess(home, "status-reader", statusReaderSource, [
      home,
      stopFile,
    ]);
    let settled = 0;
    try {
      expect(await reader.nextLine()).toBe("started");
      const deadline = performance.now() + 1_500;
      while ((settled < 25 || performance.now() < deadline) && settled < 200) {
        const queued = store.enqueue(
          session.id,
          `STATUS_READER_QUEUE_BODY_${settled}_${"y".repeat(4_096)}`,
        );
        expect(store.transitionQueue(queued.id, "pending", "cancelled")).toBe(true);
        settled += 1;
      }
      await writeFile(stopFile, "stop\n", { mode: 0o600 });
      const report = statusReaderReportSchema.parse(JSON.parse(await reader.nextLine()));
      expect(report.opens).toBeGreaterThanOrEqual(2);
      expect(await reader.exited).toBe(0);
    } finally {
      reader.kill();
    }
    expect(settled).toBeGreaterThanOrEqual(25);
    expect(await stateFileSuffixesContaining(paths.database, "STATUS_READER_QUEUE_BODY_"))
      .toEqual([]);
  }, 30_000);
test("skips the foreign key scan on readonly opens and keeps it on writable opens", async () => {
    const { store } = await fixture();
    signInProfile(store, "Readonly integrity", "readonly-integrity@example.com");
    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);
    // This legacy revision cursor is outside the v36 usage-evidence audits but
    // still owns a profile foreign key, so only PRAGMA foreign_key_check sees
    // the dangling child and separates the two open paths exactly.
    const raw = new Database(paths.database, { strict: true });
    try {
      raw.exec("PRAGMA foreign_keys=OFF");
      raw.query(
        "INSERT INTO usage_revision_authority(profile_id,next_revision) VALUES (?,1)",
      ).run(`acct_${"f".repeat(32)}`);
      expect(raw.query("PRAGMA foreign_key_check").all()).toHaveLength(1);
    } finally {
      raw.close(false);
    }
    const readonly = new StateStore(paths, { readonly: true });
    stores.push(readonly);
    expect(readonly.listProfiles()).toHaveLength(1);
    expect(() => {
      const writable = new StateStore(paths);
      writable.close();
    }).toThrow("WORK_SCHEMA_FOREIGN_KEY_VIOLATION");
  });
test.each([
    "queue_message_terminal_insert_scrub", "queue_message_terminal_transition_scrub",
    "queue_message_resolution_scrub", "queue_message_settlement_guard",
  ])("refuses a damaged current queue scrub guard without repairing history: %s", async (guard) => {
    for (const damage of ["missing", "weakened", "wrong_table"] as const) {
    const { store } = await fixture({ provision: "migrate" });
    const profile = signInProfile(store, "Stale queue trigger", "stale-trigger@example.com");
    const session = createProvenTestSession(store, {
      profileId: profile.id,
      preset: "high",
      fastEnabled: false,
    });
    const sentinel = "STALE_TRIGGER_QUEUE_BODY_SENTINEL";
    const queued = store.enqueue(session.id, sentinel);
    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);

    const stale = new Database(paths.database, { create: false, strict: true });
    try {
      const original = z.object({ tbl_name: z.string(), sql: z.string() }).strict().parse(
        stale.query("SELECT tbl_name,sql FROM sqlite_schema WHERE type='trigger' AND name=?").get(guard),
      );
      stale.exec(`DROP TRIGGER "${guard}"`);
      if (damage === "weakened") {
        stale.exec(`CREATE TRIGGER "${guard}" AFTER UPDATE ON "${original.tbl_name}" BEGIN SELECT 1; END;`);
      } else if (damage === "wrong_table") {
        stale.exec(original.sql.replace(new RegExp(`\\bON ${original.tbl_name}\\b`, "u"), "ON profiles"));
      }
      if (guard === "queue_message_terminal_transition_scrub") {
        // Reproduces the privacy failure: without this trigger a settlement
        // retains the raw body and never records a physical-scrub obligation.
        stale.query("UPDATE queue_entries SET state='cancelled',updated_at=updated_at+1 WHERE id=?").run(queued.id);
        expect(stale.query("SELECT message,state FROM queue_entries WHERE id=?").get(queued.id))
          .toEqual({ message: sentinel, state: "cancelled" });
      }
      expect(stale.query(
        "SELECT generation FROM queue_message_scrub_authority WHERE singleton=1",
      ).get()).toBeNull();
      const corrupted = snapshotSwitchContainmentForTest(stale);
      for (const readonly of [false, true]) {
        expect(() => { const opened = new StateStore(paths, { readonly, now: () => 5_000 }); opened.close(); })
          .toThrow("STATE_SCHEMA_COHORT_INVALID:joined60:" + guard);
        expect(snapshotSwitchContainmentForTest(stale)).toEqual(corrupted);
      }
    } finally { stale.close(false); }
    }
  });
test("retains a newer scrub generation when a settlement follows a checkpoint snapshot", async () => {
    const { store } = await fixture();
    const profile = signInProfile(store, "Scrub generation", "scrub-generation@example.com");
    const session = createProvenTestSession(store, {
      profileId: profile.id,
      preset: "high",
      fastEnabled: false,
    });
    const firstSentinel = "SCRUB_GENERATION_FIRST_SENTINEL";
    const secondSentinel = "SCRUB_GENERATION_SECOND_SENTINEL";
    const first = store.enqueue(session.id, firstSentinel);
    const second = store.enqueue(session.id, secondSentinel);
    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);

    const writer = new Database(paths.database, { create: false, strict: true });
    // Emulate the owned writer configured by migrateWritableDatabase instead
    // of inheriting platform defaults. A raw writer with secure_delete=OFF can
    // checkpoint stale body bytes before the owned scrubber gets custody.
    writer.exec("PRAGMA secure_delete=ON");
    expect(writer.query("PRAGMA secure_delete").get()).toEqual({ secure_delete: 1 });
    writer.query(
      "UPDATE queue_entries SET state='cancelled',updated_at=updated_at+1 WHERE id=?",
    ).run(first.id);
    const firstAuthority = z.object({ generation: z.number().int().positive() }).parse(
      writer.query(
        "SELECT generation FROM queue_message_scrub_authority WHERE singleton=1",
      ).get(),
    );
    expect(writer.query("PRAGMA wal_checkpoint(TRUNCATE)").get()).toEqual(
      expect.objectContaining({ busy: 0 }),
    );
    writer.query(
      "UPDATE queue_entries SET state='cancelled',updated_at=updated_at+1 WHERE id=?",
    ).run(second.id);
    expect(writer.query(
      "DELETE FROM queue_message_scrub_authority WHERE singleton=1 AND generation=?",
    ).run(firstAuthority.generation).changes).toBe(0);
    expect(writer.query(
      "SELECT generation FROM queue_message_scrub_authority WHERE singleton=1",
    ).get()).toEqual({ generation: firstAuthority.generation + 1 });
    writer.close(false);

    const recovered = new StateStore(paths, { now: () => 6_000 });
    stores.push(recovered);
    expect(recovered.requireQueue(first.id).message).toBe("[queue message removed after settlement]");
    expect(recovered.requireQueue(second.id).message).toBe("[queue message removed after settlement]");
    expect(await stateFileSuffixesContaining(paths.database, firstSentinel)).toEqual([]);
    expect(await stateFileSuffixesContaining(paths.database, secondSentinel)).toEqual([]);
  });
test("binds, journals, applies, and exactly replays a desktop switch", async () => {
    const { store } = await fixture();
    const source = signInProfile(store, "Source", "source@example.com");
    const target = signInProfile(store, "Target", "Target@Example.com");
    const key = "11111111-1111-4111-8111-111111111111";
    const plan = await store.beginDesktopSwitch({
      idempotencyKey: key,
      requestedSource: codexAuthorityFor(store, source),
      target: codexAuthorityFor(store, target),
    });
    expect(plan).toMatchObject({
      status: "ready",
      journalStage: "new",
      expectedAccountKey: "target@example.com",
    });
    if (plan.status !== "ready") throw new Error("Expected a ready desktop switch plan.");
    const targetPaths = deriveDesktopProfilePaths(store.paths.root, target.id);
    const journal = {
      idempotencyKey: key,
      switchGeneration: plan.switchGeneration,
      sourceProfileId: source.id,
      sourceProcessGeneration: source.processGeneration,
      sourceProviderAuthority: codexAuthorityFor(store, source),
      targetProfileId: target.id,
      targetProcessGeneration: target.processGeneration,
      targetProviderAuthority: codexAuthorityFor(store, target),
      bundleCdHash: "a".repeat(40),
      sourcePid: 101,
      targetPaths,
      expectedAccountKey: "target@example.com",
    } as const;
    await store.prepareDesktopSwitchJournal(journal);
    await store.prepareDesktopSwitchJournal(journal);
    expect(await store.beginDesktopSwitch({
      idempotencyKey: key,
      requestedSource: codexAuthorityFor(store, source),
      target: codexAuthorityFor(store, target),
    })).toMatchObject({ status: "ready", journalStage: "prepared" });
    await store.assertDesktopEffectsSettled(plan);
    await store.advanceDesktopSwitchJournal({
      idempotencyKey: key,
      ...desktopSwitchBinding(plan),
      stage: "quit-requested",
    });
    await store.advanceDesktopSwitchJournal({
      idempotencyKey: key,
      ...desktopSwitchBinding(plan),
      stage: "source-quiesced",
    });
    await store.advanceDesktopSwitchJournal({
      idempotencyKey: key,
      ...desktopSwitchBinding(plan),
      stage: "launch-requested",
    });
    await store.advanceDesktopSwitchJournal({
      idempotencyKey: key,
      ...desktopSwitchBinding(plan),
      stage: "target-observed",
      launchedPid: 202,
    });
    await store.advanceDesktopSwitchJournal({
      idempotencyKey: key,
      ...desktopSwitchBinding(plan),
      stage: "verified",
      launchedPid: 202,
    });

    expect(await store.beginDesktopSwitch({
      idempotencyKey: key,
      requestedSource: codexAuthorityFor(store, source),
      target: codexAuthorityFor(store, target),
    })).toEqual({
      status: "applied",
      idempotencyKey: key,
      switchGeneration: plan.switchGeneration,
      sourceProfileId: source.id,
      sourceProcessGeneration: source.processGeneration,
      sourceProviderAuthority: codexAuthorityFor(store, source),
      targetProfileId: target.id,
      targetProcessGeneration: target.processGeneration,
      targetProviderAuthority: codexAuthorityFor(store, target),
      expectedAccountKey: "target@example.com",
      activeAccount: {
        signedIn: true,
        email: "target@example.com",
        plan: "Plus",
      },
    });
  });
test("rejects desktop idempotency and journal binding changes", async () => {
    const { store } = await fixture();
    const target = signInProfile(store, "Target", "target@example.com");
    const other = signInProfile(store, "Other", "other@example.com");
    const key = "22222222-2222-4222-8222-222222222222";
    const plan = await store.beginDesktopSwitch({
      idempotencyKey: key,
      target: codexAuthorityFor(store, target),
    });
    if (plan.status !== "ready") throw new Error("Expected a ready desktop switch plan.");
    await expect(store.beginDesktopSwitch({
      idempotencyKey: key,
      target: codexAuthorityFor(store, other),
    })).rejects.toThrow("IDEMPOTENCY_CONFLICT");
    const journal = {
      idempotencyKey: key,
      switchGeneration: plan.switchGeneration,
      sourceProfileId: null,
      sourceProcessGeneration: null,
      sourceProviderAuthority: null,
      targetProfileId: target.id,
      targetProcessGeneration: target.processGeneration,
      targetProviderAuthority: codexAuthorityFor(store, target),
      bundleCdHash: "b".repeat(40),
      sourcePid: null,
      targetPaths: deriveDesktopProfilePaths(store.paths.root, target.id),
      expectedAccountKey: "target@example.com",
    } as const;
    await store.prepareDesktopSwitchJournal(journal);
    await expect(store.prepareDesktopSwitchJournal({
      ...journal,
      bundleCdHash: "c".repeat(40),
    })).rejects.toThrow("DESKTOP_JOURNAL_BINDING_CONFLICT");
  });
test("fences exact desktop source and target provider authorities at every durable boundary", async () => {
    const { store } = await fixture();
    const source = signInProfile(store, "Exact source", "exact-source@example.com");
    const target = signInProfile(store, "Exact target", "exact-target@example.com");
    const other = signInProfile(store, "Exact other", "exact-other@example.com");
    const sourceAuthority = codexAuthorityFor(store, source);
    const targetAuthority = codexAuthorityFor(store, target);
    const wrongSource = { ...sourceAuthority, bindingGeneration: sourceAuthority.bindingGeneration + 1 };
    const wrongTarget = {
      ...targetAuthority,
      providerAccountId: codexAuthorityFor(store, other).providerAccountId,
    };
    await expect(store.beginDesktopSwitch({
      idempotencyKey: "a1111111-1111-4111-8111-111111111111",
      requestedSource: sourceAuthority,
      target: wrongTarget,
    })).rejects.toThrow("PROVIDER_ACCOUNT_AUTHORITY_STALE");

    const key = "a2222222-2222-4222-8222-222222222222";
    const plan = await store.beginDesktopSwitch({
      idempotencyKey: key,
      requestedSource: sourceAuthority,
      target: targetAuthority,
    });
    if (plan.status !== "ready") throw new Error("Expected a ready desktop switch plan.");
    expect(() => store.readDesktopSwitchReplay({
      idempotencyKey: key,
      requestedSource: wrongSource,
      target: targetAuthority,
    })).toThrow("IDEMPOTENCY_CONFLICT");

    const journal = {
      idempotencyKey: key,
      ...desktopSwitchBinding(plan),
      bundleCdHash: "c".repeat(40),
      sourcePid: 101,
      targetPaths: deriveDesktopProfilePaths(store.paths.root, target.id),
      expectedAccountKey: "exact-target@example.com",
    } as const;
    await expect(store.prepareDesktopSwitchJournal({
      ...journal,
      targetProviderAuthority: wrongTarget,
    })).rejects.toThrow("DESKTOP_SWITCH_BINDING_CONFLICT");
    await store.prepareDesktopSwitchJournal(journal);
    await expect(store.advanceDesktopSwitchJournal({
      idempotencyKey: key,
      ...desktopSwitchBinding(plan),
      sourceProviderAuthority: wrongSource,
      stage: "launch-requested",
    })).rejects.toThrow("DESKTOP_SWITCH_BINDING_CONFLICT");
    expect(store.readMutation(key)).toMatchObject({ state: "prepared" });

    await store.advanceDesktopSwitchJournal({
      idempotencyKey: key,
      ...desktopSwitchBinding(plan),
      stage: "launch-requested",
    });
    await store.advanceDesktopSwitchJournal({
      idempotencyKey: key,
      ...desktopSwitchBinding(plan),
      stage: "recovery-required",
    });
    const recovery = store.readCurrentDesktopSwitchRecovery() as {
      attemptId: string;
    };
    expect(() => store.resolveDesktopSwitchRecovery({
      attemptId: recovery.attemptId,
      idempotencyKey: key,
      ...desktopSwitchBinding(plan),
      targetProviderAuthority: wrongTarget,
      resolution: "resolved_applied",
      diagnostic: "STABLE_TARGET_ACCOUNT_VERIFIED",
      observationDigest: "d".repeat(64),
      activeAccount: { signedIn: true, email: "exact-target@example.com" },
    })).toThrow("DESKTOP_RECOVERY_BINDING_CONFLICT");
  });
test("collapses an effect-adjacent desktop restart to durable recovery", async () => {
    const { store } = await fixture();
    const target = signInProfile(store, "Crash target", "crash@example.com");
    const key = "33333333-3333-4333-8333-333333333333";
    const plan = await store.beginDesktopSwitch({
      idempotencyKey: key,
      target: codexAuthorityFor(store, target),
    });
    if (plan.status !== "ready") throw new Error("Expected a ready desktop switch plan.");
    await store.prepareDesktopSwitchJournal({
      idempotencyKey: key,
      switchGeneration: plan.switchGeneration,
      sourceProfileId: null,
      sourceProcessGeneration: null,
      sourceProviderAuthority: null,
      targetProfileId: target.id,
      targetProcessGeneration: target.processGeneration,
      targetProviderAuthority: codexAuthorityFor(store, target),
      bundleCdHash: "d".repeat(40),
      sourcePid: null,
      targetPaths: deriveDesktopProfilePaths(store.paths.root, target.id),
      expectedAccountKey: "crash@example.com",
    });
    await store.advanceDesktopSwitchJournal({
      idempotencyKey: key,
      ...desktopSwitchBinding(plan),
      stage: "launch-requested",
    });

    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const restarted = new StateStore(paths, { now: () => 7_000 });
    stores.push(restarted);

    expect(await restarted.beginDesktopSwitch({
      idempotencyKey: key,
      target: codexAuthorityFor(restarted, target),
    })).toMatchObject({
      status: "recovery_required",
      diagnostic: "EFFECT_ADJACENT_RESTART",
    });
    expect(restarted.readMutation(key)).toMatchObject({ state: "ambiguous" });
    expect(await restarted.beginDesktopSwitch({
      idempotencyKey: key,
      target: codexAuthorityFor(restarted, target),
    })).toMatchObject({
      status: "recovery_required",
      diagnostic: "EFFECT_ADJACENT_RESTART",
    });
  });
test("fences desktop authority when a bound profile generation advances", async () => {
    const { store } = await fixture();
    const target = signInProfile(store, "Fence target", "fence@example.com");
    const plan = await store.beginDesktopSwitch({
      idempotencyKey: "44444444-4444-4444-8444-444444444444",
      target: codexAuthorityFor(store, target),
    });
    if (plan.status !== "ready") throw new Error("Expected a ready desktop switch plan.");
    await store.prepareDesktopSwitchJournal({
      idempotencyKey: plan.idempotencyKey,
      switchGeneration: plan.switchGeneration,
      sourceProfileId: null,
      sourceProcessGeneration: null,
      sourceProviderAuthority: null,
      targetProfileId: target.id,
      targetProcessGeneration: target.processGeneration,
      targetProviderAuthority: codexAuthorityFor(store, target),
      bundleCdHash: "e".repeat(40),
      sourcePid: null,
      targetPaths: deriveDesktopProfilePaths(store.paths.root, target.id),
      expectedAccountKey: "fence@example.com",
    });
    expect(store.isDesktopSwitchCurrent(plan)).toBe(true);
    expect(store.isDesktopSwitchCurrent({
      ...plan,
      targetProcessGeneration: target.processGeneration + 1,
    })).toBe(false);
    store.nextProfileGeneration(target.id);
    expect(store.isDesktopSwitchCurrent(plan)).toBe(false);
    await expect(store.assertDesktopEffectsSettled(plan)).rejects.toThrow(
      "DESKTOP_SWITCH_GENERATION_STALE",
    );
  });
test("atomically cancels and releases a reserved switch after a no-effect failure", async () => {
    const { store } = await fixture();
    const target = signInProfile(store, "Prepared target", "prepared@example.com");
    const key = "55555555-5555-4555-8555-555555555555";
    const plan = await store.beginDesktopSwitch({
      idempotencyKey: key,
      target: codexAuthorityFor(store, target),
    });
    if (plan.status !== "ready") throw new Error("Expected a ready desktop switch plan.");
    expect(store.settlePreparedDesktopSwitch({
      idempotencyKey: key,
      switchGeneration: plan.switchGeneration,
      sourceProfileId: plan.sourceProfileId,
      sourceProcessGeneration: plan.sourceProcessGeneration,
      sourceProviderAuthority: plan.sourceProviderAuthority,
      targetProfileId: plan.targetProfileId,
      targetProcessGeneration: plan.targetProcessGeneration,
      targetProviderAuthority: plan.targetProviderAuthority,
      diagnostic: "PRE_EFFECT_FAILURE",
    })).toBe(true);
    expect(store.readMutation(key)).toMatchObject({ state: "cancelled" });
    expect(store.readCurrentDesktopSwitchRecovery()).toEqual({ status: "none" });
    expect(store.settlePreparedDesktopSwitch({
      idempotencyKey: key,
      switchGeneration: plan.switchGeneration,
      sourceProfileId: plan.sourceProfileId,
      sourceProcessGeneration: plan.sourceProcessGeneration,
      sourceProviderAuthority: plan.sourceProviderAuthority,
      targetProfileId: plan.targetProfileId,
      targetProcessGeneration: plan.targetProcessGeneration,
      targetProviderAuthority: plan.targetProviderAuthority,
      diagnostic: "PRE_EFFECT_FAILURE",
    })).toBe(false);
    expect(await store.beginDesktopSwitch({
      idempotencyKey: "66666666-6666-4666-8666-666666666666",
      target: codexAuthorityFor(store, target),
    })).toMatchObject({ status: "ready", switchGeneration: plan.switchGeneration + 1 });
  });
test("appends a byte-stable desktop resolution without rewriting ambiguous evidence", async () => {
    const { store } = await fixture();
    const target = signInProfile(store, "Recovered target", "recover@example.com");
    const key = "77777777-7777-4777-8777-777777777777";
    const plan = await store.beginDesktopSwitch({
      idempotencyKey: key,
      target: codexAuthorityFor(store, target),
    });
    if (plan.status !== "ready") throw new Error("Expected a ready desktop switch plan.");
    await store.prepareDesktopSwitchJournal({
      idempotencyKey: key,
      switchGeneration: plan.switchGeneration,
      sourceProfileId: null,
      sourceProcessGeneration: null,
      sourceProviderAuthority: null,
      targetProfileId: target.id,
      targetProcessGeneration: target.processGeneration,
      targetProviderAuthority: codexAuthorityFor(store, target),
      bundleCdHash: "f".repeat(40),
      sourcePid: null,
      targetPaths: deriveDesktopProfilePaths(store.paths.root, target.id),
      expectedAccountKey: "recover@example.com",
    });
    await store.advanceDesktopSwitchJournal({
      idempotencyKey: key,
      ...desktopSwitchBinding(plan),
      stage: "launch-requested",
    });
    await store.advanceDesktopSwitchJournal({
      idempotencyKey: key,
      ...desktopSwitchBinding(plan),
      stage: "recovery-required",
      diagnostic: "LAUNCH_REQUESTED_INDETERMINATE",
    });
    const recovery = store.readCurrentDesktopSwitchRecovery() as {
      status: string;
      attemptId: string;
      originalPhase: string;
    } & Record<string, unknown>;
    expect(recovery).toMatchObject({
      status: "recovery_required",
      originalPhase: "launch_started",
      diagnostic: "LAUNCH_REQUESTED_INDETERMINATE",
    });
    const inspector = new Database(store.paths.database, { readonly: true, strict: true });
    const before = inspector.query("SELECT d.phase,d.ambiguous_from_phase,d.diagnostic_code,m.state AS mutation_state FROM desktop_switches d JOIN mutation_attempts m ON m.id=d.attempt_id WHERE d.attempt_id=?").get(recovery.attemptId);
    inspector.close(false);

    const resolutionInput = {
      attemptId: recovery.attemptId,
      idempotencyKey: key,
      switchGeneration: plan.switchGeneration,
      sourceProfileId: null,
      sourceProcessGeneration: null,
      sourceProviderAuthority: null,
      targetProfileId: target.id,
      targetProcessGeneration: target.processGeneration,
      targetProviderAuthority: codexAuthorityFor(store, target),
      resolution: "resolved_applied" as const,
      diagnostic: "STABLE_TARGET_ACCOUNT_VERIFIED",
      observationDigest: "a".repeat(64),
      activeAccount: { signedIn: true, email: "Recover@Example.com", plan: "Plus" },
    };
    const receipt = store.resolveDesktopSwitchRecovery(resolutionInput);
    expect(store.resolveDesktopSwitchRecovery(resolutionInput)).toEqual(receipt);
    expect(store.readCurrentDesktopSwitchRecovery()).toEqual(receipt);
    expect(store.readDesktopSwitchReplay({
      idempotencyKey: key,
      target: codexAuthorityFor(store, target),
    })).toMatchObject({
      status: "applied",
      activeAccount: { signedIn: true, email: "recover@example.com" },
    });
    const afterInspector = new Database(store.paths.database, { create: false, strict: true });
    try {
      expect(afterInspector.query("SELECT d.phase,d.ambiguous_from_phase,d.diagnostic_code,m.state AS mutation_state FROM desktop_switches d JOIN mutation_attempts m ON m.id=d.attempt_id WHERE d.attempt_id=?").get(recovery.attemptId)).toEqual(before);
      expect(afterInspector.query("UPDATE desktop_switch_resolutions SET diagnostic_code='CHANGED' WHERE attempt_id=?").run.bind(
        afterInspector.query("UPDATE desktop_switch_resolutions SET diagnostic_code='CHANGED' WHERE attempt_id=?"),
        recovery.attemptId,
      )).toThrow("desktop switch resolution is immutable");
    } finally {
      afterInspector.close(false);
    }

    const next = await store.beginDesktopSwitch({
      idempotencyKey: "88888888-8888-4888-8888-888888888888",
      target: codexAuthorityFor(store, target),
    });
    expect(next).toMatchObject({ status: "ready", switchGeneration: plan.switchGeneration + 1 });
    expect(() => store.resolveDesktopSwitchRecovery(resolutionInput)).toThrow("DESKTOP_RECOVERY_CAS_CONFLICT");
    if (next.status !== "ready") throw new Error("Expected a ready second switch.");
    expect(store.isDesktopSwitchCurrent(next)).toBe(true);
  });
test("hydrates an immutable v34 desktop recovery receipt from migrated exact authority", async () => {
    const paths = await canonical34StorageArchive();
    const source = canonical34StorageFixture.retained;
    const inspector = new Database(paths.database, { create: false, strict: true });
    inspector.exec("PRAGMA query_only=ON");
    try {
      const original = canonicalAuthBudgetSnapshot(inspector);
      const history = canonicalAuthBudgetRows(inspector, [
        "desktop_switches", "desktop_switch_resolutions", "desktop_switch_authority",
      ]);
      expect(original.version).toEqual({ user_version: 34 });
      expect(inspector.query("SELECT * FROM desktop_switch_resolutions WHERE attempt_id=?")
        .get(source.receipt.attemptId)).toEqual(source.immutableDesktop);
      expect(() => new StateStore(paths, { readonly: true }))
        .toThrow("STATE_SCHEMA_MIGRATION_REQUIRED:34:61");
      expect(canonicalAuthBudgetSnapshot(inspector)).toEqual(original);

      const migrated = new StateStore(paths, { now: () => 40_000 });
      stores.push(migrated);
      const targetAuthority = codexAuthorityFor(migrated, source.profile);
      const hydratedReceipt = {
        ...source.receipt, sourceProviderAuthority: null, targetProviderAuthority: targetAuthority,
      };
      expect(migrated.readCurrentDesktopSwitchRecovery()).toEqual(hydratedReceipt);
      const joined = canonicalAuthBudgetSnapshot(inspector);
      expect(migrated.resolveDesktopSwitchRecovery({
        ...source.resolutionInput, sourceProviderAuthority: null, targetProviderAuthority: targetAuthority,
      })).toEqual(hydratedReceipt);
      expect(migrated.readDesktopSwitchReplay({
        idempotencyKey: source.plan.idempotencyKey, target: targetAuthority,
      })).toMatchObject({ status: "applied", targetProviderAuthority: targetAuthority });
      expect(history.read()).toEqual(history.before);
      expect(canonicalAuthBudgetSnapshot(inspector)).toEqual(joined);
      migrated.close();
      stores.splice(stores.indexOf(migrated), 1);
      for (const readonly of [false, true]) {
        const reopened = new StateStore(paths, { readonly, now: () => 40_001 });
        try {
          expect(reopened.readCurrentDesktopSwitchRecovery()).toEqual(hydratedReceipt);
          expect(history.read()).toEqual(history.before);
          expect(canonicalAuthBudgetSnapshot(inspector)).toEqual(joined);
        } finally { reopened.close(); }
      }
    } finally { inspector.close(false); }
  });
test("enforces the original deadline before resolving a switch as not applied", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "oompa-desktop-deadline-")));
    const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
    await initializeStatePaths(paths);
    let now = 10_000;
    const store = new StateStore(paths, { now: () => now });
    stores.push(store);
    const target = signInProfile(store, "Deadline target", "deadline@example.com");
    const key = "99999999-9999-4999-8999-999999999999";
    const plan = await store.beginDesktopSwitch({
      idempotencyKey: key,
      target: codexAuthorityFor(store, target),
    });
    if (plan.status !== "ready") throw new Error("Expected a ready desktop switch plan.");
    await store.prepareDesktopSwitchJournal({
      idempotencyKey: key,
      switchGeneration: plan.switchGeneration,
      sourceProfileId: null,
      sourceProcessGeneration: null,
      sourceProviderAuthority: null,
      targetProfileId: target.id,
      targetProcessGeneration: target.processGeneration,
      targetProviderAuthority: codexAuthorityFor(store, target),
      bundleCdHash: "e".repeat(40),
      sourcePid: null,
      targetPaths: deriveDesktopProfilePaths(store.paths.root, target.id),
      expectedAccountKey: "deadline@example.com",
    });
    await store.advanceDesktopSwitchJournal({ idempotencyKey: key, ...desktopSwitchBinding(plan), stage: "launch-requested" });
    await store.advanceDesktopSwitchJournal({ idempotencyKey: key, ...desktopSwitchBinding(plan), stage: "recovery-required" });
    const recovery = store.readCurrentDesktopSwitchRecovery() as { attemptId: string };
    const input = {
      attemptId: recovery.attemptId,
      idempotencyKey: key,
      switchGeneration: plan.switchGeneration,
      sourceProfileId: null,
      sourceProcessGeneration: null,
      sourceProviderAuthority: null,
      targetProfileId: target.id,
      targetProcessGeneration: target.processGeneration,
      targetProviderAuthority: codexAuthorityFor(store, target),
      resolution: "resolved_not_applied" as const,
      diagnostic: "ZERO_EXACT_PROCESSES",
      observationDigest: "b".repeat(64),
    };
    expect(() => store.resolveDesktopSwitchRecovery(input)).toThrow("DESKTOP_RECOVERY_DEADLINE_PENDING");
    now += 30_001;
    expect(store.resolveDesktopSwitchRecovery(input)).toMatchObject({ status: "resolved_not_applied" });
  });
test("records immutable effective runtime profiles under exact session authority", async () => {
    const { store } = await fixture();
    const profile = signInProfile(store, "Runtime profile", "runtime@example.com");
    const other = signInProfile(store, "Other runtime", "other-runtime@example.com");
    const session = store.createSession({ profileId: profile.id, preset: "high", fastEnabled: true });
    const providerAuthority = store.requireProviderAccountAuthority(profile.id, "codex");
    const firstProfile = {
      profileId: profile.id,
      processGeneration: profile.processGeneration,
      observedAt: 2_000,
      preset: "high" as const,
      model: "gpt-6-astra",
      reasoningEffort: "max" as const,
      serviceTier: null,
      fast: false,
      approvalPolicy: "on-request" as const,
      reviewMode: "auto_review" as const,
      permissionProfile: ":workspace" as const,
      computerUse: true as const,
      pluginCapability: true as const,
      enabledApps: [{ id: "app.alpha", name: "Alpha", pluginDisplayNames: ["Alpha plugin"] }],
    };
    const first = store.recordSessionRuntimeProfile({ sessionId: session.id, sourceKind: "session_start", sourceId: "attempt-one", profile: firstProfile, providerAuthority });
    expect(first).toMatchObject({ revision: 1, sourceKind: "session_start", profile: firstProfile });
    expect(store.recordSessionRuntimeProfile({ sessionId: session.id, sourceKind: "session_start", sourceId: "attempt-one", profile: firstProfile, providerAuthority })).toEqual(first);

    const secondProfile = { ...firstProfile, observedAt: 2_001, enabledApps: [] };
    expect(store.recordSessionRuntimeProfile({ sessionId: session.id, sourceKind: "turn_start", sourceId: "attempt-two", profile: secondProfile, providerAuthority })).toMatchObject({ revision: 2 });
    expect(store.latestSessionRuntimeProfile(session.id)).toMatchObject({ revision: 2, profile: secondProfile });
    expect(() => store.recordSessionRuntimeProfile({ sessionId: session.id, sourceKind: "session_start", sourceId: "attempt-one", profile: secondProfile, providerAuthority })).toThrow("source authority changed");
    expect(() => store.recordSessionRuntimeProfile({ sessionId: session.id, sourceKind: "queue_start", sourceId: "queue-one", profile: { ...secondProfile, profileId: other.id }, providerAuthority })).toThrow("runtime profile session authority mismatch");

    const inspector = new Database(store.paths.database, { create: false, strict: true });
    try {
      expect(() => inspector.query("UPDATE session_runtime_profiles SET observed_at=observed_at+1 WHERE session_id=?").run(session.id)).toThrow("immutable");
      expect(() => inspector.query("DELETE FROM session_runtime_profiles WHERE session_id=?").run(session.id)).toThrow("immutable");
    } finally {
      inspector.close(false);
    }
  });
test("requires immutable provider authority on runtime-profile reads", async () => {
    const { store } = await fixture();
    const daemon = startInputFixtureDaemon(store);
    const profile = signInProfile(store, "Runtime read authority", "runtime-read@example.com");
    const providerAuthority = store.requireProviderAccountAuthority(profile.id, "codex");
    const created = store.createSession({
      fastEnabled: false,
      preset: "high",
      profileId: profile.id,
    });
    const session = store.bindSession({
      expectedRevision: created.revision,
      providerThreadId: "thread-runtime-read-authority",
      providerUpdatedAt: 10,
      sessionId: created.id,
      state: "idle",
    });
    const runtime = reviewedCodexProfile(profile);
    const { attempt } = store.prepareSessionInputMutation({
      ...daemon,
      sessionId: session.id,
      idempotencyKey: "00000000-0000-4000-8000-00000000070a",
      kind: "session.send",
      providerAuthority,
      message: "bind runtime authority", attachments: [],
    });
    store.beginSessionMutationEffect({
      ...daemon,
      attachments: [],
      attemptId: attempt.id,
      message: "bind runtime authority",
      transcript: { accountId: profile.id, providerGeneration: providerAuthority.processGeneration,
        providerConnectionId: "10000000-0000-4000-8000-000000000233", actor: "human", message: "bind runtime authority" },
      evidence: {
        baseline: { activeTurnId: null, providerUpdatedAt: 10, status: "idle" },
        clientMessageId: attempt.id,
        kind: "session.send",
        messageDigest: createHash("sha256").update("bind runtime authority").digest("hex"),
        providerThreadId: "thread-runtime-read-authority",
        runtimeProfile: runtime,
      },
      profileGeneration: providerAuthority.processGeneration,
      providerAuthority,
      sessionId: session.id,
    });
    store.completeSessionTurnEffect({
      applyResponseState: false,
      attemptId: attempt.id,
      accountId: profile.id,
      providerGeneration: providerAuthority.processGeneration,
      providerConnectionId: "10000000-0000-4000-8000-000000000233",
      message: "bind runtime authority",
      expectedSessionRevision: session.revision,
      providerAuthority,
      receipt: { turnId: "turn-runtime-read-authority" },
      runtimeProfile: runtime,
      sessionId: session.id,
      turnId: "turn-runtime-read-authority",
      turnStatus: "completed",
    });
    expect(store.latestSessionRuntimeProfile(session.id)?.profile).toEqual(runtime);
    expect(store.runtimeProfileForTurn(session.id, "turn-runtime-read-authority"))
      .toEqual(runtime);

    const inspector = new Database(store.paths.database, { create: false, strict: true });
    try {
      expect(inspector.query(
        "DELETE FROM runtime_profile_provider_authorities WHERE session_id=?",
      ).run(session.id).changes).toBe(1);
    } finally {
      inspector.close(false);
    }
    expect(() => store.latestSessionRuntimeProfile(session.id))
      .toThrow("RUNTIME_PROVIDER_AUTHORITY_MISSING");
    expect(() => store.runtimeProfileForTurn(session.id, "turn-runtime-read-authority"))
      .toThrow("RUNTIME_PROVIDER_AUTHORITY_MISSING");
  });
});
