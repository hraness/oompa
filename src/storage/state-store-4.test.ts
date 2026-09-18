import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import fc from "fast-check";
import { z } from "zod";
import { canonical40QueuesFixture } from "../../scripts/fixtures/canonical40-queues";
import { canonical50CollisionDatabaseBytes, canonical50CollisionFixture } from "../../scripts/fixtures/canonical50-collision";
import { canonicalBudgetRuntimeDatabaseBytes, canonicalBudgetRuntimeFixtures } from "../../scripts/fixtures/canonical-budget-runtime";
import { canonical30WorkDatabaseBytes, canonical30WorkFixture } from "../../scripts/fixtures/canonical30-work";
import { canonical34StorageFixture } from "../../scripts/fixtures/canonical34-storage";
import { canonical35To38Fixture } from "../../scripts/fixtures/canonical35-38";
import { observed2DatabaseBytes, observed2Fixture } from "../../scripts/fixtures/observed2-stage";
import { canonicalAdoption35Fixture } from "../../scripts/fixtures/canonical-adoption35";
import { canonicalEarlyMigrationFixture } from "../../scripts/fixtures/canonical-early-migration";
import { canonicalLabelPresetFixture } from "../../scripts/fixtures/canonical-label-preset";
import { canonical39RetiredFixtures } from "../../scripts/fixtures/canonical39-retired-effects";
import { canonical39RetiredRecoveryDatabaseBytes, canonical39RetiredRecoveryFixtures } from "../../scripts/fixtures/canonical39-retired-recovery";
import { AUTORESPOND_DAY_MS } from "../domain/autorespond-budget";
import { devinPresetContract, legacyPresetContract } from "../domain/presets";
import { createPortableProjectMemoryCanonicalIdentity, deriveProjectMemoryCanonicalIdentity, legacyProjectMemorySpaceId, PROJECT_MEMORY_EMPTY_HEAD } from "../domain/project-memory";
import { SESSION_EVENT_RETAIN_AGE_MS } from "../domain/session-events";
import type { ProjectId } from "../domain/values";
import { initializeStatePaths, resolveStatePaths } from "./paths";
import { CONTROL_PLANE_RECONCILIATION_BATCH_LIMIT, MEMORY_SUBMISSION_RETAIN_AGE_MS, PEER_SESSION_ACTION_RETAIN_AGE_MS, PEER_SESSION_HOP_LIMIT, PEER_SESSION_HOURLY_ACTION_LIMIT, PEER_SESSION_HOURLY_DISTINCT_TARGET_LIMIT, PEER_SESSION_PROJECT_HOURLY_ACTION_LIMIT, PEER_SESSION_RATE_WINDOW_MS, PEER_SESSION_RETAINED_ACTION_LIMIT, PEER_SESSION_TURN_ORIGIN_LIMIT, StateStore, type ProjectRecord, type SessionRecord } from "./state-store";
import {
  admitRestartCommandInteraction,
  canonical30AutorespondArchive,
  canonical34StorageArchive,
  canonical35To38Archive,
  canonical39DevinArchive,
  canonical39RetiredArchive,
  canonical40QueueArchive,
  canonicalAdoption35Archive,
  canonicalAuthBudgetRows,
  canonicalAuthBudgetSnapshot,
  canonicalEarlyMigrationArchive,
  canonicalLabelPresetArchive,
  canonicalTimestampArchiveForTest,
  capturedProviderAuthorityForTest,
  codexRuntimeProfile,
  createAuthorizedStartingTestSession,
  createProvenTestSession,
  createRevocationWorkStore,
  drainStateStoreCasesAndClose,
  dropProviderV39SessionColumn,
  enqueueAttachedTestQueue,
  expectCanonical35To38InertReopens,
  expectHistoricalValue,
  expectInertSchemaRefusal,
  fixture,
  ownedStateStoreCase,
  ownedStateStoreCaseDrains,
  peerAbandonmentFenceFixture,
  peerIdempotencyKey,
  peerOriginBoundaryFixture,
  providerSwitchSchemaObjectCount,
  reserveTestProjectMemoryAuthority,
  retiredSuccessorArchive,
  shortScrubCheckpoint,
  signInProfile,
  snapshotSwitchContainmentForTest,
  startInputFixtureDaemon,
  stateFileSuffixesContaining,
  stores,
  testCanonicalMemoryEnvelope,
  testCanonicalMemoryHostedCreateRequest,
  testDigest,
  withRemovedTestGuards,
} from "../../scripts/fixtures/state-store-testkit";

setDefaultTimeout(60_000);

afterEach(async () => {
  await drainStateStoreCasesAndClose(ownedStateStoreCaseDrains, () => stores.splice(0));
});

describe("StateStore", () => {
test("rolls back the whole v43 migration when its ledger stamp is refused", async () => {
    const paths = await retiredSuccessorArchive(42);
    const predecessor = new Database(paths.database, { create: false, strict: true });
    let accountAuthorityGuardBefore: unknown;
    try {
      expect(predecessor.query("PRAGMA user_version").get()).toEqual({ user_version: 42 });
      accountAuthorityGuardBefore = predecessor.query(
        `SELECT type,name,tbl_name,sql FROM sqlite_master
         WHERE type='trigger' AND name='session_events_account_authority_guard'`,
      ).get();
      predecessor.exec(`
        CREATE TRIGGER reject_v43_migration_stamp
        BEFORE INSERT ON migrations WHEN NEW.version=43
        BEGIN SELECT RAISE(ABORT,'reject v43 migration stamp'); END;
      `);
    } finally {
      predecessor.close(false);
    }

    expect(() => new StateStore(paths)).toThrow("reject v43 migration stamp");
    const inspector = new Database(paths.database, { readonly: true, strict: true });
    try {
      expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: 42 });
      expect(inspector.query("SELECT 1 FROM migrations WHERE version=43").get()).toBeNull();
      expect(inspector.query(
        `SELECT name FROM pragma_table_info('mutation_attempts')
         WHERE name='transcript_finalized'`,
      ).get()).toBeNull();
      expect(inspector.query(
        `SELECT name FROM pragma_table_info('mutation_attempts')
         WHERE name IN ('transcript_status','transcript_intent_json')`,
      ).all()).toEqual([]);
      expect(inspector.query(
        `SELECT name FROM pragma_table_info('queue_entries')
         WHERE name='transcript_finalized'`,
      ).get()).toBeNull();
      expect(inspector.query(
        `SELECT name FROM pragma_table_info('queue_entries')
         WHERE name IN ('transcript_status','transcript_intent_json')`,
      ).all()).toEqual([]);
      expect(inspector.query(
        `SELECT name FROM sqlite_master WHERE type='trigger'
         AND name IN ('mutation_transcript_finalization_guard','queue_transcript_finalization_guard')`,
      ).all()).toEqual([]);
      expect(inspector.query(
        `SELECT type,name,tbl_name,sql FROM sqlite_master
         WHERE type='trigger' AND name='session_events_account_authority_guard'`,
      ).get()).toEqual(accountAuthorityGuardBefore);
    } finally {
      inspector.close(false);
    }
    expect(() => new StateStore(paths, { readonly: true }))
      .toThrow("STATE_SCHEMA_MIGRATION_REQUIRED:42:61");
  });
test("refuses a missing or weakened current60 transcript authority guard without repair", async () => {
    for (const damage of ["missing", "weakened"] as const) {
      const { store } = await fixture({ provision: "migrate" });
      const paths = store.paths;
      store.close();
      stores.splice(stores.indexOf(store), 1);
      const malformed = new Database(paths.database, { create: false, strict: true });
      try {
        malformed.exec("DROP TRIGGER session_events_account_authority_guard");
        if (damage === "weakened") {
          malformed.exec(`
            CREATE TRIGGER session_events_account_authority_guard
            BEFORE INSERT ON session_events BEGIN SELECT 1; END;
          `);
        }
        const schemaBefore = malformed.query(
          "SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name",
        ).all();
        const ledgerBefore = malformed.query(
          "SELECT * FROM migrations ORDER BY version",
        ).all();
        for (const readonly of [true, false]) {
          expect(() => new StateStore(paths, readonly ? { readonly: true } : {}))
            .toThrow("JOINED_EVIDENCE_BOUNDARY_SCHEMA_INVALID");
          expect(malformed.query(
            "SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name",
          ).all()).toEqual(schemaBefore);
          expect(malformed.query("SELECT * FROM migrations ORDER BY version").all())
            .toEqual(ledgerBefore);
        }
      } finally {
        malformed.close(false);
      }
    }
  });
test("refuses to begin a direct user-message effect without exact connection provenance", async () => {
    const { store } = await fixture();
    const daemon = startInputFixtureDaemon(store);
    const profile = signInProfile(
      store,
      "Transcript connection authority",
      "transcript-connection@example.com",
    );
    const session = createProvenTestSession(store, {
      profileId: profile.id,
      preset: "high",
      fastEnabled: false,
      state: "active",
      activeTurnId: "turn-transcript-connection",
    });
    const key = "43000000-0000-4000-8000-000000000014";
    const { attempt } = store.prepareSessionInputMutation({
      ...daemon, kind: "session.steer", sessionId: session.id,
      providerAuthority: capturedProviderAuthorityForTest(store, session.id),
      message: "must retain exact connection provenance", attachments: [],
      idempotencyKey: key,
    });

    expect(() => store.beginSessionMutationEffect({
      ...daemon, attachments: [],
      providerAuthority: capturedProviderAuthorityForTest(store, session.id),
      message: "must retain exact connection provenance",
      attemptId: attempt.id,
      sessionId: session.id,
      profileGeneration: profile.processGeneration,
      transcript: {
        accountId: profile.id,
        providerGeneration: profile.processGeneration,
        providerConnectionId: null as unknown as string,
        actor: "human",
        message: "must retain exact connection provenance",
      },
      evidence: {
        kind: "session.steer",
        providerThreadId: session.providerThreadId ?? "",
        baseline: {
          providerUpdatedAt: null,
          status: "active",
          activeTurnId: "turn-transcript-connection",
        },
        activeTurnId: "turn-transcript-connection",
        clientMessageId: attempt.id,
        messageDigest: createHash("sha256")
          .update("must retain exact connection provenance")
          .digest("hex"),
      },
    })).toThrow();

    expect(store.readMutation(key)).toMatchObject({ state: "prepared" });
    expect(store.readMutation(key)?.evidence).toBeUndefined();
    expect(store.readSessionUserMessageSource(session.id, "mutation", key))
      .toEqual({ status: "none" });
  });
test("refuses a new colliding non-UUID mutation key without disturbing an admitted queue", async () => {
    const { store } = await fixture();
    const paths = store.paths;
    const daemon = startInputFixtureDaemon(store);
    const profile = signInProfile(store, "Current source collision", "current-collision@example.com");
    const session = createProvenTestSession(store, {
      profileId: profile.id, preset: "high", fastEnabled: false, state: "idle",
    });
    const providerAuthority = capturedProviderAuthorityForTest(store, session.id);
    const queued = store.enqueueIdempotent({ providerAuthority, sessionId: session.id,
      profileGeneration: providerAuthority.processGeneration, message: "independent current queue",
      idempotencyKey: "43000000-0000-4000-8000-000000000017" });
    const description = { ...daemon, kind: "session.steer" as const, sessionId: session.id,
      providerAuthority, message: "independent current mutation", attachments: [] };
    const snapshot = () => {
      const database = new Database(paths.database, { readonly: true, strict: true });
      try { return snapshotSwitchContainmentForTest(database); }
      finally { database.close(false); }
    };
    const before = snapshot();
    expect(() => store.prepareSessionInputMutation({ ...description, idempotencyKey: queued.id }))
      .toThrow("ATTACHMENT_CUSTODY_INVALID_INPUT");
    expect(snapshot()).toEqual(before);
    expect(store.requireQueue(queued.id)).toEqual(queued);

    // Change only the rejected key. The same current input now acquires its
    // own prepared authority without changing the separately admitted queue.
    const key = "43000000-0000-4000-8000-000000000018";
    const prepared = store.prepareSessionInputMutation({ ...description, idempotencyKey: key });
    expect(prepared.attempt.state).toBe("prepared");
    expect(store.readMutation(key)).toMatchObject({ id: prepared.attempt.id, kind: "session.steer" });
    expect(store.requireQueue(queued.id)).toEqual(queued);
    expect(store.readQueueEffect(queued.id)).toBeNull();
    expect(store.listSessionEvents({ sessionId: session.id, afterSequence: 0 }).events
      .filter((event) => event.body.type === "user_message")).toEqual([]);
  });
test("preserves authentic canonical50 colliding mutation and queue finalizations independently", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "oompa-canonical50-source-collision-")));
    const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
    await initializeStatePaths(paths);
    const bytes = canonical50CollisionDatabaseBytes();
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(canonical50CollisionFixture.databaseSha256);
    await writeFile(paths.database, bytes, { mode: 0o600, flag: "wx" });
    const retained = canonical50CollisionFixture.retained;
    const sessionId = retained.session.id;
    const sourceId = retained.queued.id;
    const inspector = new Database(paths.database, { create: false, strict: true });
    inspector.exec("PRAGMA query_only=ON");
    try {
      expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: 50 });
      expect(retained.mutation.idempotencyKey).toBe(sourceId);
      expect(retained.mutation.authorityGeneration).toBe(1);
      expect(retained.profile.processGeneration).toBe(2);
      // Bind original columns before migration; new authority sidecars cannot
      // substitute for either actual archived effect or its finalized source.
      const originals = ["mutation_attempts", "mutation_effect_evidence", "queue_entries", "queue_effect_evidence",
        "session_runtime_profiles", "session_turn_runtime_profiles", "session_events", "session_message_event_sources"]
        .map((table) => {
          const columns = z.object({ name: z.string().regex(/^[a-z0-9_]+$/u) }).passthrough().array()
            .parse(inspector.query(`PRAGMA table_info(${table})`).all()).map((column) => column.name);
          const query = `SELECT ${columns.join(",")} FROM ${table} ORDER BY rowid LIMIT 201`;
          const rows = inspector.query(query).all();
          expect(rows.length).toBeLessThanOrEqual(200);
          return { query, rows };
        });
      expect(inspector.query("SELECT count(*) AS n FROM mutation_effect_evidence").get()).toEqual({ n: 1 });
      expect(inspector.query("SELECT count(*) AS n FROM queue_effect_evidence").get()).toEqual({ n: 1 });
      expect(inspector.query("SELECT count(*) AS n FROM session_turn_runtime_profiles").get()).toEqual({ n: 1 });
      expect(inspector.query("SELECT source_id,source_kind FROM session_message_event_sources ORDER BY source_kind").all())
        .toEqual([{ source_id: retained.mutation.id, source_kind: "mutation" }, { source_id: sourceId, source_kind: "queue" }]);
      const migrated = new StateStore(paths, { now: () => 60_000 });
      stores.push(migrated);
      expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: 61 });
      for (const original of originals) expect(inspector.query(original.query).all()).toEqual(original.rows);
      const before = snapshotSwitchContainmentForTest(inspector);
      for (const sourceKind of ["mutation", "queue"] as const) {
        expect(migrated.hasSessionUserMessageSource(sessionId, sourceKind, sourceId)).toBe(true);
        expect(migrated.readSessionUserMessageSource(sessionId, sourceKind, sourceId)).toMatchObject({ status: "finalized" });
        expect(migrated.finalizeSessionUserMessageSource({ sessionId, sourceKind, sourceId, turnId: retained.turnId })).toBeNull();
      }
      expect(migrated.listSessionEvents({ sessionId, afterSequence: 0 }).events
        .filter((event) => event.body.type === "user_message")).toEqual([...retained.messages]);
      expect(snapshotSwitchContainmentForTest(inspector)).toEqual(before);
      migrated.close();
      stores.splice(stores.indexOf(migrated), 1);
      for (const readonly of [false, true]) {
        const reopened = new StateStore(paths, { readonly, now: () => 60_000 });
        try {
          expect(reopened.hasSessionUserMessageSource(sessionId, "mutation", sourceId)).toBe(true);
          expect(reopened.hasSessionUserMessageSource(sessionId, "queue", sourceId)).toBe(true);
          expect(snapshotSwitchContainmentForTest(inspector)).toEqual(before);
        } finally { reopened.close(); }
      }
    } finally { inspector.close(false); }
  });
test("rolls a settled-source transcript append and source finalization back together", async () => {
    const { store } = await fixture();
    const daemon = startInputFixtureDaemon(store);
    const profile = signInProfile(store, "Transcript retry", "transcript-retry@example.com");
    const session = createProvenTestSession(store, {
      profileId: profile.id,
      preset: "high",
      fastEnabled: false,
      state: "active",
      activeTurnId: "turn-transcript-retry",
    });
    const key = "43000000-0000-4000-8000-000000000009";
    const { attempt } = store.prepareSessionInputMutation({
      ...daemon, kind: "session.steer", sessionId: session.id,
      providerAuthority: capturedProviderAuthorityForTest(store, session.id),
      message: "retry this transcript append", attachments: [],
      idempotencyKey: key,
    });
    store.beginSessionMutationEffect({
      ...daemon, attachments: [],
      providerAuthority: capturedProviderAuthorityForTest(store, session.id),
      message: "retry this transcript append",
      attemptId: attempt.id,
      sessionId: session.id,
      profileGeneration: profile.processGeneration,
      transcript: {
        accountId: profile.id,
        providerGeneration: profile.processGeneration,
        providerConnectionId: "10000000-0000-4000-8000-000000000010",
        actor: "human",
        message: "retry this transcript append",
      },
      evidence: {
        kind: "session.steer",
        providerThreadId: session.providerThreadId ?? "",
        baseline: {
          providerUpdatedAt: null,
          status: "active",
          activeTurnId: "turn-transcript-retry",
        },
        activeTurnId: "turn-transcript-retry",
        clientMessageId: attempt.id,
        messageDigest: createHash("sha256")
          .update("retry this transcript append")
          .digest("hex"),
      },
    });
    expect(store.transitionMutation(attempt.id, "effect_started", "applied", {
      steered: true,
      activeTurnId: "turn-transcript-retry",
    })).toBe(true);

    const inspector = new Database(store.paths.database, { create: false, strict: true });
    inspector.exec(`CREATE TRIGGER reject_transcript_append
      BEFORE INSERT ON session_events
      BEGIN SELECT RAISE(ABORT,'reject transcript append'); END;`);
    expect(() => store.finalizeSessionUserMessageSource({
      sessionId: session.id,
      sourceKind: "mutation",
      sourceId: key,
      turnId: "turn-transcript-retry",
    })).toThrow("reject transcript append");
    expect(store.readSessionUserMessageSource(session.id, "mutation", key))
      .toMatchObject({ status: "pending", intent: { text: "retry this transcript append" } });
    expect(store.listSessionEvents({ sessionId: session.id, afterSequence: 0 }).events)
      .toHaveLength(0);

    inspector.exec("DROP TRIGGER reject_transcript_append");
    const finalized = store.finalizeSessionUserMessageSource({
      sessionId: session.id,
      sourceKind: "mutation",
      sourceId: key,
      turnId: "turn-transcript-retry",
    });
    expect(finalized?.body).toMatchObject({
      type: "user_message",
      sourceId: key,
      text: "retry this transcript append",
    });
    expect(store.readSessionUserMessageSource(session.id, "mutation", key)).toEqual({
      status: "finalized",
      intent: { version: 1, actor: "human", hadAttachments: false },
    });
    expect(store.finalizeSessionUserMessageSource({
      sessionId: session.id,
      sourceKind: "mutation",
      sourceId: key,
      turnId: "turn-transcript-retry",
    })).toBeNull();
    inspector.close(false);
  });
for (const rawMessage of [false, true]) test(`retains charged prose through delayed ambiguous recovery without double-counting finalization (${rawMessage ? "raw message" : "durable intent"})`, async () => {
    let now = 10_000;
    const { store } = await fixture({ now: () => now });
    const daemon = startInputFixtureDaemon(store);
    const profile = signInProfile(store, "Budget recovery", "budget-recovery@example.com");
    const session = createProvenTestSession(store, {
      profileId: profile.id, preset: "high", fastEnabled: false, providerUpdatedAt: 10, state: "idle",
    });
    const runtime = {
      profileId: profile.id, processGeneration: profile.processGeneration, observedAt: now,
      preset: "high" as const, model: "gpt-6-astra", reasoningEffort: "max" as const,
      serviceTier: null, fast: false, approvalPolicy: "on-request" as const,
      reviewMode: "auto_review" as const, permissionProfile: ":workspace" as const,
      computerUse: true as const, pluginCapability: true as const, enabledApps: [],
    };
    const key = "44000000-0000-4000-8000-000000000001";
    const message = "continue approved work";
    const { attempt } = store.prepareSessionInputMutation({
      ...daemon, kind: "session.send", sessionId: session.id,
      providerAuthority: capturedProviderAuthorityForTest(store, session.id),
      message, attachments: [], idempotencyKey: key,
    });
    store.recordAutorespondMessageSource(session.id, attempt.id);
    const effect = store.beginSessionMutationEffect({
      ...daemon, attachments: [],
      providerAuthority: capturedProviderAuthorityForTest(store, session.id),
      message,
      attemptId: attempt.id, sessionId: session.id, profileGeneration: profile.processGeneration,
      transcript: {
        accountId: profile.id, providerGeneration: profile.processGeneration,
        providerConnectionId: "44000000-0000-4000-8000-000000000002", actor: "autorespond", message,
      },
      evidence: {
        kind: "session.send", providerThreadId: session.providerThreadId ?? "",
        baseline: { providerUpdatedAt: 10, status: "idle", activeTurnId: null },
        clientMessageId: attempt.id, messageDigest: createHash("sha256").update(message).digest("hex"),
        runtimeProfile: runtime,
      },
    });
    const admission = { sessionId: session.id, sourceKind: "prose" as const, sourceId: key, expectedMode: "auto:all" as const };
    expect(() => store.reserveAutorespondBudget({ ...admission, sourceId: attempt.id }))
      .toThrow("AUTORESPOND_BUDGET_SOURCE_AUTHORITY_INVALID");
    expect(store.reserveAutorespondBudget(admission)).toEqual({ state: "reserved" });
    expect(store.transitionMutation(attempt.id, "effect_started", "ambiguous", { code: "LOST_RESPONSE" })).toBe(true);
    expect(store.readAutorespondBudgets(session.id)).toEqual({ consecutive: 1, lastHour: 1, lastDay: 1 });
    now += AUTORESPOND_DAY_MS + 1;
    const protocol = admitRestartCommandInteraction(store, {
      index: 44, processGeneration: profile.processGeneration, profileId: profile.id,
      sessionId: session.id, threadId: session.providerThreadId ?? "", turnId: null,
    });
    expect(store.reserveAutorespondBudget({ ...admission, sourceKind: "protocol", sourceId: protocol.publicId }))
      .toEqual({ state: "reserved" });
    expect(store.reserveAutorespondBudget(admission)).toEqual({ state: "existing" });
    expect(store.readAutorespondBudgets(session.id)).toEqual({ consecutive: 2, lastHour: 1, lastDay: 1 });
    store.quarantineSession(session.id);
    store.resolveSessionMutation({
      attemptId: attempt.id, expectedOriginalState: "ambiguous", expectedEvidenceDigest: effect.digest,
      resolution: "proven_applied", resolutionEvidence: { source: "exact_provider_projection" },
      ...(rawMessage ? { message } : {}),
      receipt: { turnId: "turn-budget-recovery" },
      provider: {
        providerThreadId: session.providerThreadId ?? "", title: "Budget recovered", status: "active",
        activeTurnId: "turn-budget-recovery", providerUpdatedAt: 20,
      },
    });
    expect(store.readSessionUserMessageSource(session.id, "mutation", key)).toMatchObject({ status: "finalized" });
    const messages = store.listSessionEvents({ sessionId: session.id, afterSequence: 0 }).events
      .filter((event) => event.body.type === "user_message");
    expect(messages).toHaveLength(1);
    expect(messages[0]?.body).toMatchObject({
      type: "user_message", actor: "autorespond", sourceId: key, text: message,
    });
    expect(store.readAutorespondBudgets(session.id)).toEqual({ consecutive: 2, lastHour: 1, lastDay: 1 });
    expect(store.finalizeSessionUserMessageSource({
      sessionId: session.id, sourceKind: "mutation", sourceId: key, turnId: "turn-budget-recovery",
    })).toBeNull();
    expect(store.readAutorespondBudgets(session.id).consecutive).toBe(2);
  });
test("rolls proven-applied mutation recovery back when transcript finalization fails", async () => {
    let currentTime = 1_000;
    const { store } = await fixture({ now: () => currentTime });
    const daemon = startInputFixtureDaemon(store);
    const profile = signInProfile(
      store,
      "Transcript mutation recovery",
      "transcript-mutation-recovery@example.com",
    );
    const session = createProvenTestSession(store, {
      profileId: profile.id,
      preset: "high",
      fastEnabled: false,
      providerUpdatedAt: 10,
      state: "idle",
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
    const key = "43000000-0000-4000-8000-00000000000a";
    const message = "recover this accepted send";
    const { attempt } = store.prepareSessionInputMutation({
      ...daemon, kind: "session.send", sessionId: session.id,
      providerAuthority: capturedProviderAuthorityForTest(store, session.id),
      message, attachments: [],
      idempotencyKey: key,
    });
    const effect = store.beginSessionMutationEffect({
      ...daemon, attachments: [],
      providerAuthority: capturedProviderAuthorityForTest(store, session.id),
      message,
      attemptId: attempt.id,
      sessionId: session.id,
      profileGeneration: profile.processGeneration,
      transcript: {
        accountId: profile.id,
        providerGeneration: profile.processGeneration,
        providerConnectionId: "10000000-0000-4000-8000-000000000011",
        actor: "human",
        message,
      },
      evidence: {
        kind: "session.send",
        providerThreadId: session.providerThreadId ?? "",
        baseline: { providerUpdatedAt: 10, status: "idle", activeTurnId: null },
        clientMessageId: attempt.id,
        messageDigest: createHash("sha256").update(message).digest("hex"),
        runtimeProfile: runtime,
      },
    });
    expect(store.transitionMutation(attempt.id, "effect_started", "ambiguous", {
      code: "commit_error",
    })).toBe(true);
    const quarantined = store.quarantineSession(session.id);
    const recovery = {
      attemptId: attempt.id,
      expectedOriginalState: "ambiguous" as const,
      expectedEvidenceDigest: effect.digest,
      resolution: "proven_applied" as const,
      resolutionEvidence: { source: "exact_provider_projection" },
      receipt: { turnId: "turn-transcript-mutation-recovery" },
      provider: {
        providerThreadId: session.providerThreadId ?? "",
        title: "Recovered mutation transcript",
        status: "active" as const,
        activeTurnId: "turn-transcript-mutation-recovery",
        providerUpdatedAt: 20,
      },
    };
    const inspector = new Database(store.paths.database, { create: false, strict: true });
    inspector.exec(`CREATE TRIGGER reject_recovered_mutation_transcript
      BEFORE INSERT ON session_events
      BEGIN SELECT RAISE(ABORT,'reject recovered mutation transcript'); END;`);

    expect(() => store.resolveSessionMutation(recovery))
      .toThrow("reject recovered mutation transcript");
    expect(store.requireSession(session.id)).toEqual(quarantined);
    expect(store.readMutation(key)).toMatchObject({ state: "ambiguous" });
    expect(store.readMutation(key)?.resolution).toBeUndefined();
    expect(store.readSessionUserMessageSource(session.id, "mutation", key))
      .toMatchObject({ status: "pending", intent: { text: message } });
    expect(store.latestSessionRuntimeProfile(session.id)).toBeNull();
    expect(store.listSessionEvents({ sessionId: session.id, afterSequence: 0 }).events)
      .toHaveLength(0);

    inspector.exec("DROP TRIGGER reject_recovered_mutation_transcript");
    expect(() => store.resolveSessionMutation({ ...recovery, message: `${message} changed` }))
      .toThrow("SESSION_MESSAGE_DIGEST_MISMATCH");
    expect(store.requireSession(session.id)).toEqual(quarantined);
    expect(store.readMutation(key)?.resolution).toBeUndefined();
    expect(store.resolveSessionMutation(recovery)).toMatchObject({
      state: "active",
      activeTurnId: "turn-transcript-mutation-recovery",
    });
    expect(store.readMutation(key)).toMatchObject({
      state: "reconciled",
      resolution: { kind: "proven_applied" },
      result: { turnId: "turn-transcript-mutation-recovery" },
    });
    expect(store.readSessionUserMessageSource(session.id, "mutation", key))
      .toMatchObject({ status: "finalized", intent: { hadAttachments: false } });
    expect(store.listSessionEvents({ sessionId: session.id, afterSequence: 0 }).events
      .filter((event) => event.body.type === "user_message")).toHaveLength(1);
    expect(store.readSessionMessageEventSource(session.id, attempt.id)).toMatchObject({
      actor: "human",
      sourceKind: "mutation",
    });
    const settled = store.readMutation(key);
    currentTime += SESSION_EVENT_RETAIN_AGE_MS + 1;
    expect(store.listSessionEvents({ sessionId: session.id, afterSequence: 0 }).events)
      .toEqual([]);
    expect(store.readSessionMessageEventSource(session.id, attempt.id)).toBeNull();
    for (const replayMessage of [message, `${message} changed`]) {
      expect(() => store.resolveSessionMutation({ ...recovery, message: replayMessage })).toThrow();
    }
    expect(store.readMutation(key)).toEqual(settled);
    expect(store.finalizeSessionUserMessageSource({
      sessionId: session.id,
      sourceKind: "mutation",
      sourceId: key,
      turnId: "turn-transcript-mutation-recovery",
    })).toBeNull();
    expect(store.listSessionEvents({ sessionId: session.id, afterSequence: 0 }).events)
      .toEqual([]);
    inspector.close(false);
  });
test("rolls proven-applied queue recovery back when transcript finalization fails", async () => {
    const { store } = await fixture();
    const profile = signInProfile(
      store,
      "Transcript queue recovery",
      "transcript-queue-recovery@example.com",
    );
    const session = createProvenTestSession(store, {
      profileId: profile.id,
      preset: "high",
      fastEnabled: false,
      providerUpdatedAt: 10,
      state: "idle",
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
    const queued = store.enqueueIdempotent({
      providerAuthority: capturedProviderAuthorityForTest(store, session.id),
      sessionId: session.id,
      profileGeneration: profile.processGeneration,
      message: "recover this accepted queue dispatch",
      idempotencyKey: "43000000-0000-4000-8000-00000000000b",
    });
    const effect = store.beginQueueEffect({
      providerAuthority: capturedProviderAuthorityForTest(store, session.id),
      queueId: queued.id,
      sessionId: session.id,
      profileGeneration: profile.processGeneration,
      providerConnectionId: "10000000-0000-4000-8000-000000000009",
      evidence: {
        kind: "queue.dispatch",
        queueId: queued.id,
        sessionId: session.id,
        providerThreadId: session.providerThreadId ?? "",
        profileGeneration: profile.processGeneration,
        baseline: { providerUpdatedAt: 10, status: "idle", activeTurnId: null },
        clientMessageId: queued.id,
        messageDigest: createHash("sha256")
          .update("recover this accepted queue dispatch")
          .digest("hex"),
        runtimeProfile: runtime,
      },
    });
    const quarantined = store.markQueueEffectAmbiguous(queued.id, effect.digest);
    const recovery = {
      queueId: queued.id,
      expectedEvidenceDigest: effect.digest,
      resolution: "proven_applied" as const,
      resolutionEvidence: { source: "exact_provider_projection" },
      receipt: { turnId: "turn-transcript-queue-recovery" },
      provider: {
        providerThreadId: session.providerThreadId ?? "",
        title: "Recovered queue transcript",
        status: "idle" as const,
        providerUpdatedAt: 20,
      },
    };
    const inspector = new Database(store.paths.database, { create: false, strict: true });
    inspector.exec(`CREATE TRIGGER reject_recovered_queue_transcript
      BEFORE INSERT ON session_events
      BEGIN SELECT RAISE(ABORT,'reject recovered queue transcript'); END;`);

    expect(() => store.resolveQueueEffect(recovery))
      .toThrow("reject recovered queue transcript");
    expect(store.requireSession(session.id)).toEqual(quarantined);
    expect(store.readQueueEffect(queued.id)?.resolution).toBeUndefined();
    expect(store.listUnsettledQueueEffects(session.id)).toHaveLength(1);
    expect(store.readSessionUserMessageSource(session.id, "queue", queued.id))
      .toMatchObject({ status: "pending", intent: { text: "recover this accepted queue dispatch" } });
    expect(store.latestSessionRuntimeProfile(session.id)).toBeNull();
    expect(store.listSessionEvents({ sessionId: session.id, afterSequence: 0 }).events)
      .toHaveLength(0);

    inspector.exec("DROP TRIGGER reject_recovered_queue_transcript");
    expect(store.resolveQueueEffect(recovery)).toMatchObject({
      state: "idle",
      title: "Recovered queue transcript",
    });
    expect(store.readQueueEffect(queued.id)).toMatchObject({
      resolution: { kind: "proven_applied" },
    });
    expect(store.listUnsettledQueueEffects(session.id)).toEqual([]);
    expect(store.readSessionUserMessageSource(session.id, "queue", queued.id))
      .toMatchObject({ status: "finalized", intent: { hadAttachments: false } });
    expect(store.listSessionEvents({ sessionId: session.id, afterSequence: 0 }).events
      .filter((event) => event.body.type === "user_message")).toHaveLength(1);
    inspector.close(false);
  });
test("retains sealed queue provenance instead of dispatching it under a later process generation", async () => {
    const { store } = await fixture();
    const profile = signInProfile(store, "Queue provenance", "queue-provenance@example.com");
    const session = createProvenTestSession(store, {
      fastEnabled: false,
      preset: "high",
      profileId: profile.id,
      providerUpdatedAt: 10,
      state: "idle",
    });
    const queued = store.enqueueIdempotent({
      providerAuthority: capturedProviderAuthorityForTest(store, session.id),
      idempotencyKey: "43000000-0000-4000-8000-00000000000c",
      message: "dispatch after reconnect",
      profileGeneration: profile.processGeneration,
      providerConnectionId: "10000000-0000-4000-8000-000000000211",
      sessionId: session.id,
    });
    const originalAuthority = store.readQueueProviderAuthority(queued.id);
    const originalIntent = store.readSessionUserMessageSource(session.id, "queue", queued.id);
    const originalEvents = store.listSessionEvents({ sessionId: session.id, afterSequence: 0 });
    expect(originalAuthority).not.toBeNull();
    const restarted = store.nextProfileGeneration(profile.id);
    const connectionId = "10000000-0000-4000-8000-000000000212";
    const runtime = {
      approvalPolicy: "on-request" as const,
      computerUse: true as const,
      enabledApps: [],
      fast: false,
      model: "gpt-6-astra",
      observedAt: 2_100,
      permissionProfile: ":workspace" as const,
      pluginCapability: true as const,
      preset: "high" as const,
      processGeneration: restarted.processGeneration,
      profileId: restarted.id,
      reasoningEffort: "max" as const,
      reviewMode: "auto_review" as const,
      serviceTier: null,
    };
    const queueEffectInput = {
      providerAuthority: store.requireProviderAccountAuthority(profile.id, "codex"),
      evidence: {
        baseline: { activeTurnId: null, providerUpdatedAt: 10, status: "idle" },
        clientMessageId: queued.id,
        kind: "queue.dispatch",
        messageDigest: createHash("sha256").update("dispatch after reconnect").digest("hex"),
        profileGeneration: restarted.processGeneration,
        providerThreadId: session.providerThreadId ?? "",
        queueId: queued.id,
        runtimeProfile: runtime,
        sessionId: session.id,
      },
      profileGeneration: restarted.processGeneration,
      queueId: queued.id,
      sessionId: session.id,
    } satisfies Omit<
      Parameters<StateStore["beginQueueEffect"]>[0],
      "providerConnectionId"
    >;
    expect(() => store.beginQueueEffect({
      ...queueEffectInput,
      providerConnectionId: null as unknown as string,
    })).toThrow();
    expect(store.requireQueue(queued.id)).toMatchObject({ state: "pending" });
    expect(store.readQueueEffect(queued.id)).toBeNull();
    expect(() => store.beginQueueEffect({
      ...queueEffectInput,
      providerConnectionId: connectionId,
    })).toThrow();
    expect(store.readQueueEffect(queued.id)).toBeNull();
    expect(store.requireQueue(queued.id)).toMatchObject({ state: "pending", message: queued.message });
    expect(store.readQueueProviderAuthority(queued.id)).toEqual(originalAuthority);
    expect(store.readSessionUserMessageSource(session.id, "queue", queued.id))
      .toEqual(originalIntent);
    expect(store.listSessionEvents({ sessionId: session.id, afterSequence: 0 })).toEqual(originalEvents);
  });
test("rolls attachment custody back with direct message intent and effect evidence", async () => {
    const { store } = await fixture();
    const daemon = startInputFixtureDaemon(store);
    const profile = signInProfile(store, "Transcript attachment", "transcript-attachment@example.com");
    const session = createProvenTestSession(store, {
      profileId: profile.id,
      preset: "high",
      fastEnabled: false,
      state: "active",
      activeTurnId: "turn-atomic",
    });
    const key = "43000000-0000-4000-8000-000000000010";
    const stored = {
      byteLength: 4,
      canonicalMediaType: "text/plain" as const,
      digest: "d".repeat(64),
      mediaType: "text/plain" as const,
      name: "proof.txt",
    };
    const input = { ...daemon, kind: "session.steer" as const, sessionId: session.id,
      idempotencyKey: key, message: "attached",
      providerAuthority: capturedProviderAuthorityForTest(store, session.id),
      attachments: [{ byteLength: stored.byteLength, digest: stored.digest,
        mediaType: stored.mediaType, name: stored.name }] };
    const reservation = store.reserveAttachmentIngress(input);
    if (reservation.kind !== "reserved") throw new Error("Expected an attached input reservation.");
    const { attempt, custody } = store.prepareSessionInputMutation({ ...input, reservation });
    if (custody.kind !== "mutation_owned") throw new Error("Expected retained mutation attachment custody.");
    const inspector = new Database(store.paths.database, { create: false, strict: true });
    inspector.exec(`CREATE TRIGGER reject_atomic_message_attachment
      BEFORE INSERT ON message_attachments
      BEGIN SELECT RAISE(ABORT,'reject atomic attachment'); END;`);
    const before = snapshotSwitchContainmentForTest(inspector);
    const begin = () => store.beginSessionMutationEffect({
      ...daemon, attachments: [stored],
      custody: { custodyId: custody.custodyId, custodyDigest: custody.custodyDigest },
      providerAuthority: capturedProviderAuthorityForTest(store, session.id),
      message: "attached",
      attemptId: attempt.id,
      sessionId: session.id,
      profileGeneration: profile.processGeneration,
      transcript: {
        accountId: profile.id,
        providerGeneration: profile.processGeneration,
        providerConnectionId: "10000000-0000-4000-8000-000000000012",
        actor: "human",
        message: "attached",
        attachments: [{
          byteLength: stored.byteLength,
          digest: stored.digest,
          mediaType: stored.mediaType,
          name: stored.name,
        }],
        storedAttachments: [stored],
      },
      evidence: {
        kind: "session.steer",
        providerThreadId: session.providerThreadId ?? "",
        baseline: { providerUpdatedAt: null, status: "active", activeTurnId: "turn-atomic" },
        activeTurnId: "turn-atomic",
        clientMessageId: attempt.id,
        messageDigest: createHash("sha256").update("attached").digest("hex"),
      },
    });
    expect(begin).toThrow("reject atomic attachment");
    expect(snapshotSwitchContainmentForTest(inspector)).toEqual(before);
    expect(store.readMutation(key)).toMatchObject({ state: "prepared" });
    expect(store.readMutation(key)?.evidence).toBeUndefined();
    expect(store.readSessionUserMessageSource(session.id, "mutation", key))
      .toEqual({ status: "none" });
    expect(store.messageAttachmentManifest(session.id, attempt.id)).toEqual([]);
    expect(store.attachmentCustody(stored.digest)).toBeNull();
    inspector.exec("DROP TRIGGER reject_atomic_message_attachment");
    expect(begin()).toMatchObject({ attemptId: attempt.id, evidence: { kind: "session.steer" } });
    expect(store.messageAttachmentManifest(session.id, attempt.id)).toEqual(input.attachments);
    expect(store.attachmentCustody(stored.digest)?.referenceCount).toBe(1);
    inspector.close(false);
  });
test("refuses a deceptive attachment name before durable message effect authority", async () => {
    const { store } = await fixture();
    const daemon = startInputFixtureDaemon(store);
    const profile = signInProfile(
      store,
      "Transcript attachment control",
      "transcript-attachment-control@example.com",
    );
    const session = createProvenTestSession(store, {
      profileId: profile.id,
      preset: "high",
      fastEnabled: false,
      state: "idle",
    });
    const key = "43000000-0000-4000-8000-00000000001f";
    const name = `report${String.fromCodePoint(0x202e)}fdp.exe`;
    const attachment = {
      byteLength: 4,
      digest: "9".repeat(64),
      mediaType: "text/plain" as const,
      name,
    };
    const input = { ...daemon, kind: "session.steer" as const, sessionId: session.id,
      idempotencyKey: key, message: "attached",
      providerAuthority: capturedProviderAuthorityForTest(store, session.id),
      attachments: [attachment] };
    // Changing only the name makes the same ingress reservable. No missing
    // reservation or later digest conflict may satisfy the refusal oracle.
    const valid = store.reserveAttachmentIngress({ ...input,
      attachments: [{ ...attachment, name: "report.pdf" }] });
    if (valid.kind !== "reserved") throw new Error("Expected the safe-name reservation control.");
    store.releaseAttachmentIngress({ ...daemon, ...valid });
    const inspector = new Database(store.paths.database, { create: false, strict: true });
    try {
      const before = snapshotSwitchContainmentForTest(inspector);
      expect(() => store.reserveAttachmentIngress(input)).toThrow("ATTACHMENT_CUSTODY_INVALID_INPUT");
      expect(() => store.prepareSessionInputMutation(input)).toThrow("ATTACHMENT_CUSTODY_INVALID_INPUT");
      expect(snapshotSwitchContainmentForTest(inspector)).toEqual(before);
      expect(store.readMutation(key)).toBeNull();
      expect(() => store.readSessionUserMessageSource(session.id, "mutation", key))
        .toThrow("SESSION_USER_MESSAGE_SOURCE_AUTHORITY_INVALID");
      expect(store.attachmentCustody(attachment.digest)).toBeNull();
      expect(store.listSessionEvents({ sessionId: session.id, afterSequence: 0 }).events).toHaveLength(0);
    } finally { inspector.close(false); }
  });
test("rolls queue source, mutation receipt, intent, and attachments back together", async () => {
    const { store } = await fixture();
    const daemon = startInputFixtureDaemon(store);
    const profile = signInProfile(store, "Queue attachment", "queue-attachment@example.com");
    const session = createProvenTestSession(store, {
      profileId: profile.id,
      preset: "high",
      fastEnabled: false,
      state: "idle",
    });
    const key = "43000000-0000-4000-8000-000000000011";
    const stored = {
      byteLength: 4,
      canonicalMediaType: "text/plain" as const,
      digest: "e".repeat(64),
      mediaType: "text/plain" as const,
      name: "queued.txt",
    };
    const inspector = new Database(store.paths.database, { create: false, strict: true });
    inspector.exec(`CREATE TRIGGER reject_atomic_queue_attachment
      BEFORE INSERT ON message_attachments
      BEGIN SELECT RAISE(ABORT,'reject queue attachment'); END;`);
    expect(() => enqueueAttachedTestQueue(store, daemon, {
      providerAuthority: capturedProviderAuthorityForTest(store, session.id),
      sessionId: session.id,
      profileGeneration: profile.processGeneration,
      message: "queued attached",
      actor: "automation",
      attachments: [{
        byteLength: stored.byteLength,
        digest: stored.digest,
        mediaType: stored.mediaType,
        name: stored.name,
      }],
      storedAttachments: [stored],
      idempotencyKey: key,
    })).toThrow("reject queue attachment");
    expect(store.readMutation(key)).toBeNull();
    expect(store.listQueue(session.id)).toEqual([]);
    expect(store.attachmentCustody(stored.digest)).toBeNull();
    inspector.exec("DROP TRIGGER reject_atomic_queue_attachment");
    inspector.close(false);
  });
test("replays a finalized attachment queue from sealed identity after display manifest pruning", async () => {
    const { store } = await fixture({ provision: "migrate" });
    const daemon = startInputFixtureDaemon(store);
    const profile = signInProfile(
      store,
      "Queue attachment replay",
      "queue-attachment-replay@example.com",
    );
    const session = createProvenTestSession(store, {
      profileId: profile.id,
      preset: "high",
      fastEnabled: false,
      state: "idle",
    });
    const key = "43000000-0000-4000-8000-000000000012";
    const stored = {
      byteLength: 4,
      canonicalMediaType: "text/plain" as const,
      digest: "f".repeat(64),
      mediaType: "text/plain" as const,
      name: "queued-replay.txt",
    };
    const attachments = [{
      byteLength: stored.byteLength,
      digest: stored.digest,
      mediaType: stored.mediaType,
      name: stored.name,
    }];
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
    const queued = enqueueAttachedTestQueue(store, daemon, {
      providerAuthority: capturedProviderAuthorityForTest(store, session.id),
      sessionId: session.id,
      profileGeneration: profile.processGeneration,
      message: "queued attached replay",
      actor: "automation",
      attachments,
      storedAttachments: [stored],
      idempotencyKey: key,
    });
    const guardInspector = new Database(store.paths.database, {
      create: false,
      strict: true,
    });
    try {
      expect(() => guardInspector.query(
        `UPDATE queue_entries
         SET transcript_finalized=1,transcript_status='finalized',
             transcript_intent_json=? WHERE id=?`,
      ).run(
        JSON.stringify({ version: 1, actor: "automation", hadAttachments: false }),
        queued.id,
      )).toThrow("queue transcript intent/status transition invalid");
    } finally {
      guardInspector.close(false);
    }
    for (let index = 0; index < 200; index += 1) {
      store.recordMessageAttachments({
        sessionId: session.id,
        sourceId: `newer-settled-source-${String(index).padStart(3, "0")}`,
        attachments: [stored],
      });
    }
    const laterPending = enqueueAttachedTestQueue(store, daemon, {
      providerAuthority: capturedProviderAuthorityForTest(store, session.id),
      sessionId: session.id,
      profileGeneration: profile.processGeneration,
      message: "later pending attached queue",
      actor: "automation",
      attachments,
      storedAttachments: [stored],
      idempotencyKey: "43000000-0000-4000-8000-000000000013",
    });
    // Pending provider work is custody, not retention history: it may take the
    // bounded settled projection temporarily over its cap, but may not lose
    // the only manifest that the eventual dispatch consumes.
    expect(store.messageAttachmentManifest(session.id, queued.id)).toEqual(attachments);
    expect(store.messageAttachmentManifest(
      session.id,
      "newer-settled-source-000",
    )).toEqual(attachments);
    expect(store.messageAttachmentManifest(session.id, laterPending.id)).toEqual(attachments);
    const effect = store.beginQueueEffect({
      providerAuthority: capturedProviderAuthorityForTest(store, session.id),
      queueId: queued.id,
      sessionId: session.id,
      profileGeneration: profile.processGeneration,
      providerConnectionId: "10000000-0000-4000-8000-00000000000a",
      evidence: {
        kind: "queue.dispatch",
        queueId: queued.id,
        sessionId: session.id,
        providerThreadId: session.providerThreadId ?? "",
        profileGeneration: profile.processGeneration,
        baseline: { providerUpdatedAt: null, status: "idle", activeTurnId: null },
        clientMessageId: queued.id,
        messageDigest: createHash("sha256").update("queued attached replay").digest("hex"),
        runtimeProfile: runtime,
      },
    });
    store.completeQueueEffect({
      providerAuthority: capturedProviderAuthorityForTest(store, store.requireQueue(queued.id).sessionId),
      queueId: queued.id,
      accountId: profile.id,
      providerGeneration: profile.processGeneration,
      providerConnectionId: "10000000-0000-4000-8000-00000000000a",
      message: "queued attached replay",
      expectedEvidenceDigest: effect.digest,
      expectedSessionRevision: session.revision,
      applyResponseState: false,
      turnId: "turn-queue-attachment-replay",
      turnStatus: "completed",
      runtimeProfile: runtime,
      receipt: { turnId: "turn-queue-attachment-replay" },
    });

    expect(store.readSessionUserMessageSource(session.id, "queue", queued.id))
      .toEqual({
        status: "finalized",
        intent: { version: 1, actor: "automation", hadAttachments: true },
      });
    expect(store.enqueueIdempotent({
      providerAuthority: capturedProviderAuthorityForTest(store, session.id),
      sessionId: session.id,
      profileGeneration: profile.processGeneration,
      message: "queued attached replay",
      actor: "automation",
      attachments,
      idempotencyKey: key,
    })).toEqual(store.requireQueue(queued.id));
    expect(() => store.enqueueIdempotent({
      providerAuthority: capturedProviderAuthorityForTest(store, session.id),
      sessionId: session.id,
      profileGeneration: profile.processGeneration,
      message: "queued attached replay",
      actor: "automation",
      attachments: [{ ...attachments[0]!, digest: "a".repeat(64) }],
      idempotencyKey: key,
    })).toThrow("QUEUE_ATTACHMENT_REQUEST_CONFLICT");

    store.recordMessageAttachments({
      sessionId: session.id,
      sourceId: "newest-settled-source",
      attachments: [stored],
    });
    expect(store.messageAttachmentManifest(session.id, queued.id)).toEqual([]);
    const inspector = new Database(store.paths.database, { create: false, strict: true });
    try {
    // This fixture intentionally admits over 200 display sources to prove
    // pruning. Keep its all-table oracle bounded independently of tiny fixtures.
    const snapshotReplay = () => ({
      schema: inspector.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all(),
      version: inspector.query("PRAGMA user_version").get(),
      rows: z.object({ name: z.string().regex(/^[a-z0-9_]+$/u) }).strict().array().parse(
        inspector.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all(),
      ).map(({ name }) => {
        const rows = inspector.query(`SELECT * FROM ${name} ORDER BY rowid LIMIT 1025`).all();
        if (rows.length > 1024) throw new Error("Attachment replay fixture exceeded its row bound.");
        return { name, rows };
      }),
    });
    const beforeReplay = snapshotReplay();
    expect(store.readQueueEnqueueReplay({ sessionId: session.id, message: "queued attached replay",
      actor: "automation", attachments, idempotencyKey: key }))
      .toEqual({ queued: store.requireQueue(queued.id), verification: "sealed" });
    expect(store.enqueueIdempotent({
      providerAuthority: capturedProviderAuthorityForTest(store, session.id),
      sessionId: session.id,
      profileGeneration: profile.processGeneration,
      message: "queued attached replay",
      actor: "automation",
      attachments,
      idempotencyKey: key,
    })).toEqual(store.requireQueue(queued.id));
    expect(() => store.readQueueEnqueueReplay({ sessionId: session.id, message: "queued attached replay",
      actor: "automation", attachments: [{ ...attachments[0]!, digest: "a".repeat(64) }], idempotencyKey: key }))
      .toThrow("QUEUE_ATTACHMENT_REQUEST_CONFLICT");
    expect(snapshotReplay()).toEqual(beforeReplay);
    } finally { inspector.close(false); }
  });
for (const drift of [
    {
      name: "work_devin_preset_contract_guard",
      sql: `CREATE TRIGGER work_devin_preset_contract_guard
        BEFORE INSERT ON works
        WHEN NEW.preset_contract NOT IN (1,2)
        BEGIN SELECT RAISE(ABORT,'WORK_DEVIN_PRESET_CONTRACT_MISMATCH'); END`,
    },
    {
      name: "work_session_devin_contract_guard",
      sql: `CREATE TRIGGER work_session_devin_contract_guard
        BEFORE UPDATE OF provider_v39,preset_contract ON sessions
        WHEN NEW.provider_v39='devin' AND NEW.preset_contract NOT IN (1,2)
        BEGIN SELECT RAISE(ABORT,'WORK_DEVIN_PRESET_CONTRACT_MISMATCH'); END`,
    },
  ] as const) {
    for (const predecessorVersion of [40, 41] as const) test(
      `rejects drifted schema-v${predecessorVersion} Work guard before migration: ${drift.name}`,
      async () => {
      const paths = await canonicalTimestampArchiveForTest(predecessorVersion);

      const predecessor = new Database(paths.database, { create: false, strict: true });
      try {
        predecessor.exec(`DROP TRIGGER ${drift.name}; ${drift.sql};`);
      } finally {
        predecessor.close(false);
      }

      expect(() => new StateStore(paths, { now: () => 2_000 }))
        .toThrow(predecessorVersion === 40 ? "WORK_SCHEMA_COHORT_INVALID:canonical40"
          : `WORK_SCHEMA_STALE_TRIGGER:${drift.name}`);
      const inspector = new Database(paths.database, { readonly: true, strict: true });
      try {
        expect(inspector.query("PRAGMA user_version").get())
          .toEqual({ user_version: predecessorVersion });
        expect(inspector.query(
          "SELECT version FROM migrations WHERE version>=40 ORDER BY version",
        ).all()).toEqual(predecessorVersion === 40
          ? [{ version: 40 }]
          : [{ version: 40 }, { version: 41 }]);
        expect(inspector.query(
          "SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?",
        ).get(drift.name)).toEqual(expect.objectContaining({
          sql: expect.stringContaining("NOT IN (1,2)"),
        }));
      } finally {
        inspector.close(false);
      }
    });
  }
test("rejects a drifted provider-v39 predecessor before adding adoption authority", async () => {
    const paths = await canonical39DevinArchive();
    const predecessor = new Database(paths.database, { create: false, strict: true });
    try {
      expect(predecessor.query("PRAGMA user_version").get()).toEqual({ user_version: 39 });
      const before = canonicalAuthBudgetSnapshot(predecessor);
      // One adversarial trigger replacement on the authentic old image.
      // No session, effect, provider tuple, or migration stamp is restaged.
      predecessor.exec(`
        DROP TRIGGER session_mutation_authority_rebinds_v39_immutable_delete;
        CREATE TRIGGER session_mutation_authority_rebinds_v39_immutable_delete
        BEFORE DELETE ON session_mutation_authority_rebinds_v39
        WHEN OLD.recorded_at>=0
        BEGIN SELECT RAISE(ABORT, 'session mutation authority rebind v39 is immutable'); END;
      `);
      expect(canonicalAuthBudgetSnapshot(predecessor).rows).toEqual(before.rows);
    } finally {
      predecessor.close(false);
    }

    expectInertSchemaRefusal(paths,
      "STATE_SCHEMA_V39_OBJECT_INVALID:session_mutation_authority_rebinds_v39_immutable_delete",
      "STATE_SCHEMA_MIGRATION_REQUIRED:39:61");
    const inspector = new Database(paths.database, { readonly: true, strict: true });
    try {
      expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: 39 });
      expect(inspector.query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='session_adoption_policies'",
      ).get()).toBeNull();
      expect(inspector.query(
        `SELECT sql FROM sqlite_master
         WHERE type='trigger'
           AND name='session_mutation_authority_rebinds_v39_immutable_delete'`,
      ).get()).toEqual(expect.objectContaining({
        sql: expect.stringContaining("WHEN OLD.recorded_at>=0"),
      }));
    } finally {
      inspector.close(false);
    }
  });
test("migrates the captured 42c4235 adoption-v35 writer and preserves original candidate cells", async () => {
    const paths = await canonicalAdoption35Archive();
    const captured = canonicalAdoption35Fixture;
    const inspector = new Database(paths.database, { create: false, strict: true });
    try {
      const before = canonicalAuthBudgetSnapshot(inspector);
      expect(before.version).toEqual({ user_version: 35 });
      expect(inspector.query("SELECT * FROM migrations ORDER BY version").all()).toEqual([...captured.ledger]);
      const schema = inspector.query("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
      expect(createHash("sha256").update(JSON.stringify(schema)).digest("hex")).toBe(captured.schemaSha256);
      expect(inspector.query("SELECT * FROM session_adoption_candidates").all()).toEqual([captured.rawCandidate]);
      expect(inspector.query("SELECT name FROM pragma_table_info('profiles') WHERE name='codex_account_key'").get()).toBeNull();
      const oldRows = canonicalAuthBudgetRows(inspector, Object.keys(before.rows).filter((table) => table !== "migrations"));
      expect(() => { new StateStore(paths, { readonly: true }).close(); }).toThrow("STATE_SCHEMA_MIGRATION_REQUIRED:35:61");
      expect(canonicalAuthBudgetSnapshot(inspector)).toEqual(before);
      const migrated = new StateStore(paths, { now: () => 2_000, resolveMachineTimeZone: () => "UTC" });
      stores.push(migrated);
      expect(oldRows.read()).toEqual(oldRows.before);
      expect(migrated.readSessionAdoptionCandidate(captured.request.provider, captured.request.providerThreadId))
        .toMatchObject({ ...captured.candidate, lastLiveObservedAt: null, providerProjectRoot: null });
      expect(inspector.query("SELECT last_live_observed_at,provider_project_root FROM session_adoption_candidates").get())
        .toEqual({ last_live_observed_at: null, provider_project_root: null });
      expect(inspector.query("SELECT * FROM migrations WHERE version<=35 ORDER BY version").all()).toEqual([...captured.ledger]);
      expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: 61 });
      expect(inspector.query("PRAGMA foreign_key_check").all()).toEqual([]);
      expectCanonical35To38InertReopens(paths, inspector);
    } finally { inspector.close(false); }
  });
for (const damage of ["extra_object", "weakened_guard"] as const) {
    test("refuses an adversarial captured adoption-v35 derivative without writes: " + damage, async () => {
      const paths = await canonicalAdoption35Archive();
      const inspector = new Database(paths.database, { create: false, strict: true });
      try {
        const before = canonicalAuthBudgetSnapshot(inspector);
        expect(before.version).toEqual({ user_version: 35 });
        expect(inspector.query("SELECT * FROM session_adoption_candidates").all()).toEqual([canonicalAdoption35Fixture.rawCandidate]);
        // One explicitly adversarial alteration of an authentic independent
        // copy. The captured writer, original cells and ledger stay unchanged.
        if (damage === "extra_object") {
          inspector.exec("CREATE TABLE session_adoption_unrecognized_authority (id TEXT PRIMARY KEY) STRICT");
        } else {
          expect(inspector.query("SELECT name FROM sqlite_master WHERE name='session_adoption_candidate_revision_guard'").get())
            .toEqual({ name: "session_adoption_candidate_revision_guard" });
          inspector.exec("DROP TRIGGER session_adoption_candidate_revision_guard");
          inspector.exec("CREATE TRIGGER session_adoption_candidate_revision_guard BEFORE UPDATE ON session_adoption_candidates BEGIN SELECT 1; END");
        }
        const damaged = canonicalAuthBudgetSnapshot(inspector);
        expect(damaged.version).toEqual(before.version);
        for (const [table, rows] of Object.entries(before.rows)) expect(damaged.rows[table]).toEqual(rows);
        const changedName = damage === "extra_object" ? "session_adoption_unrecognized_authority" : "session_adoption_candidate_revision_guard";
        const objects = z.array(z.object({ name: z.string() }).passthrough());
        const addedIndex = "sqlite_autoindex_session_adoption_unrecognized_authority_1";
        if (damage === "extra_object") expect(damaged.schema).toContainEqual({
          type: "index", name: addedIndex, tbl_name: changedName, sql: null,
        });
        expect(objects.parse(damaged.schema).filter(({ name }) => name !== changedName && name !== addedIndex))
          .toEqual(objects.parse(before.schema).filter(({ name }) => name !== changedName));
        expect(() => { new StateStore(paths, { now: () => 2_000 }).close(); }).toThrow(
          damage === "extra_object"
            ? "STATE_SCHEMA_V39_LEGACY_ADOPTION_OBJECT_INVALID:session_adoption_unrecognized_authority"
            : "STATE_SCHEMA_V39_LEGACY_ADOPTION_V35_INVALID",
        );
        expect(canonicalAuthBudgetSnapshot(inspector)).toEqual(damaged);
        expect(() => { new StateStore(paths, { readonly: true }).close(); }).toThrow("STATE_SCHEMA_MIGRATION_REQUIRED:35:61");
        expect(canonicalAuthBudgetSnapshot(inspector)).toEqual(damaged);
      } finally { inspector.close(false); }
    });
  }
test("rejects stale same-name v39 provider-revocation policy guards", async () => {
    const value = await fixture({ provision: "migrate" });
    const store = value.store;
    const profile = signInProfile(
      store,
      "Stale v36 policy guards",
      "stale-v36-policy-guards@example.com",
    );
    const begun = store.beginProviderRuntimeAccountRevocation({
      profileId: profile.id,
      expectedGeneration: profile.processGeneration,
      provider: "codex",
      runtimeScope: "personal",
      currentAccountKey: null,
      workStore: createRevocationWorkStore(store),
    });
    store.completeProviderRuntimeAccountRevocation({
      profileId: profile.id,
      expectedGeneration: profile.processGeneration,
      provider: "codex",
      runtimeScope: "personal",
      expectedRevision: begun.revocation.revision,
    });
    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);

    const stale = new Database(paths.database, { create: false, strict: true });
    try {
      stale.exec(`
        DROP TRIGGER session_adoption_policy_provider_revocation_guard_insert;
        DROP TRIGGER session_adoption_policy_provider_revocation_guard_update;
        CREATE TRIGGER session_adoption_policy_provider_revocation_guard_insert
        BEFORE INSERT ON session_adoption_policies BEGIN SELECT 1; END;
        CREATE TRIGGER session_adoption_policy_provider_revocation_guard_update
        BEFORE UPDATE ON session_adoption_policies BEGIN SELECT 1; END;
      `);
    } finally {
      stale.close(false);
    }

    expect(() => new StateStore(paths))
      .toThrow("STATE_SCHEMA_V39_OBJECT_INVALID:session_adoption_policy_provider_revocation_guard_insert");
  });
test("readonly open rejects a malformed same-name v39 authority trigger", async () => {
    const { store } = await fixture({ provision: "migrate" });
    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const damaged = new Database(paths.database, { create: false, strict: true });
    try {
      damaged.exec(`
        DROP TRIGGER session_adoption_candidate_revision_guard;
        CREATE TRIGGER session_adoption_candidate_revision_guard
        BEFORE UPDATE ON session_adoption_candidates BEGIN SELECT 1; END;
      `);
    } finally {
      damaged.close(false);
    }

    expect(() => new StateStore(paths, { readonly: true }))
      .toThrow("STATE_SCHEMA_V39_OBJECT_INVALID:session_adoption_candidate_revision_guard");
  });
test.each([
    "last_live_observed_at",
    "provider_project_root",
  ] as const)("current v39 opens never repair a missing candidate retention column: %s", async (column) => {
    const { store } = await fixture({ provision: "migrate" });
    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const malformed = new Database(paths.database, { create: false, strict: true });
    try {
      malformed.exec(`ALTER TABLE session_adoption_candidates DROP COLUMN ${column}`);
    } finally {
      malformed.close(false);
    }

    expect(() => new StateStore(paths, { readonly: true }))
      .toThrow("STATE_SCHEMA_V39_OBJECT_INVALID:session_adoption_candidates");
    expect(() => new StateStore(paths))
      .toThrow("STATE_SCHEMA_V39_OBJECT_INVALID:session_adoption_candidates");
    const inspector = new Database(paths.database, { readonly: true, strict: true });
    try {
      expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: 61 });
      expect(inspector.query(
        "SELECT name FROM pragma_table_info('session_adoption_candidates') WHERE name=?",
      ).get(column)).toBeNull();
    } finally {
      inspector.close(false);
    }
  });
test("current60 never recreates missing provider-v39 authority", async () => {
    const { store } = await fixture({ provision: "migrate" });
    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const malformed = new Database(paths.database, { create: false, strict: true });
    try {
      malformed.exec("DROP TABLE session_mutation_authority_rebinds_v39");
    } finally {
      malformed.close(false);
    }

    // The joined login successor guard refers to this missing historical
    // table, so its structural proof fails before any row or repair path.
    expectInertSchemaRefusal(paths, "PROVIDER_LOGIN_BINDING_PROOF_INVALID");
    const inspector = new Database(paths.database, { readonly: true, strict: true });
    try {
      expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: 61 });
      expect(inspector.query(
        "SELECT name FROM sqlite_master WHERE name='session_mutation_authority_rebinds_v39'",
      ).get()).toBeNull();
      expect(inspector.query(
        `SELECT COUNT(*) AS count FROM sqlite_master
         WHERE name LIKE 'session_mutation_authority_rebinds_v39_%'`,
      ).get()).toEqual({ count: 0 });
    } finally {
      inspector.close(false);
    }
  });
test("current v60 rejects a weakened same-name provider-v39 authority trigger without repair", async () => {
    const { store } = await fixture({ provision: "migrate" });
    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const malformed = new Database(paths.database, { create: false, strict: true });
    try {
      malformed.exec(`
        DROP TRIGGER session_mutation_authority_rebinds_v39_immutable_update;
        CREATE TRIGGER session_mutation_authority_rebinds_v39_immutable_update
        BEFORE UPDATE ON session_mutation_authority_rebinds_v39
        WHEN NEW.recorded_at=OLD.recorded_at
        BEGIN SELECT RAISE(ABORT, 'session mutation authority rebind v39 is immutable'); END;
      `);
    } finally {
      malformed.close(false);
    }

    for (const readonly of [true, false]) {
      expect(() => new StateStore(paths, readonly ? { readonly: true } : {}))
        .toThrow(
          "STATE_SCHEMA_V39_OBJECT_INVALID:session_mutation_authority_rebinds_v39_immutable_update",
        );
    }
    const inspector = new Database(paths.database, { readonly: true, strict: true });
    try {
      expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: 61 });
      expect(inspector.query(
        `SELECT sql FROM sqlite_master
         WHERE type='trigger'
           AND name='session_mutation_authority_rebinds_v39_immutable_update'`,
      ).get()).toEqual(expect.objectContaining({
        sql: expect.stringContaining("WHEN NEW.recorded_at=OLD.recorded_at"),
      }));
    } finally {
      inspector.close(false);
    }
  });
test("current60 never backfills a missing provider-v39 column", async () => {
    const { store } = await fixture({ provision: "migrate" });
    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const malformed = new Database(paths.database, { create: false, strict: true });
    try {
      const removedTriggers = dropProviderV39SessionColumn(malformed);
      expect(removedTriggers.length).toBeGreaterThan(0);
    } finally {
      malformed.close(false);
    }

    // Removing the column also removes the canonical guard that references
    // it. Current admission checks that exact guard before provider rows.
    expectInertSchemaRefusal(paths, "CANONICAL_PROFILE_SCHEMA_TRIGGER:canonical_profile_session_insert_guard");
    const inspector = new Database(paths.database, { readonly: true, strict: true });
    try {
      expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: 61 });
      expect(inspector.query(
        "SELECT name FROM pragma_table_info('sessions') WHERE name='provider_v39'",
      ).get()).toBeNull();
      expect(inspector.query(
        "SELECT name FROM sqlite_master WHERE type='trigger' AND name='work_attempt_route_guard'",
      ).get()).toBeNull();
    } finally {
      inspector.close(false);
    }
  });
test("writable open rejects malformed v39 identity uniqueness and revision guards", async () => {
    const { store } = await fixture({ provision: "migrate" });
    const first = store.createProfile("First repaired Claude identity");
    const second = store.createProfile("Second repaired Claude identity");
    const identity = {
      pid: 52_101,
      pidDomain: "darwin" as const,
      procStart: "repaired-shared-Claude-process",
    };
    store.recordClaimedClaudeProcessAuthority({
      providerAuthority: store.requireProviderAccountAuthority(first.id, "claude"),
      providerThreadId: "repaired-Claude-identity-first",
      profileId: first.id,
      profileGeneration: first.processGeneration,
      runtimeScope: "personal",
      identity,
    });
    const candidate = store.upsertSessionAdoptionCandidate({
      provider: "claude",
      providerThreadId: "repaired-Claude-revision-candidate",
      title: "Repaired Claude revision candidate",
      state: "idle",
      providerUpdatedAt: 10,
      liveness: "not_live",
    });
    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const damaged = new Database(paths.database, { create: false, strict: true });
    try {
      damaged.exec(`
        DROP INDEX session_claude_process_authorities_live_identity;
        CREATE INDEX session_claude_process_authorities_live_identity
          ON session_claude_process_authorities(pid_domain,pid,proc_start)
          WHERE state!='released';
        DROP TRIGGER session_adoption_candidate_revision_guard;
        CREATE TRIGGER session_adoption_candidate_revision_guard
        BEFORE UPDATE ON session_adoption_candidates BEGIN SELECT 1; END;
      `);
    } finally {
      damaged.close(false);
    }

    expect(() => new StateStore(paths))
      .toThrow("STATE_SCHEMA_V39_OBJECT_INVALID:session_claude_process_authorities_live_identity");
    const inspector = new Database(paths.database, { create: false, strict: true });
    try {
      expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: 61 });
      expect(inspector.query(
        "SELECT sql FROM sqlite_master WHERE name='session_adoption_candidate_revision_guard'",
      ).get()).toEqual(expect.objectContaining({ sql: expect.stringContaining("SELECT 1") }));
      expect(inspector.query("SELECT id FROM profiles WHERE id=?").get(second.id))
        .toEqual({ id: second.id });
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
test("pre-applies v38 preset contracts before replaying the current work schema from authentic v25", async () => {
    const captured = canonicalLabelPresetFixture.captures["canonical25-preset"];
    const { session, originalPresetRequirement } = captured.retained;
    const paths = await canonicalLabelPresetArchive("canonical25-preset");
    const legacy = new Database(paths.database, { create: false, strict: true });
    try {
      legacy.exec("PRAGMA query_only=ON");
      expect(legacy.query("PRAGMA table_info(sessions)").all())
        .not.toContainEqual(expect.objectContaining({ name: "preset_contract" }));
      expect(legacy.query("SELECT name FROM sqlite_master WHERE type='table' AND name='works'").get()).toBeNull();
      expect(legacy.query("SELECT id,preset,state FROM sessions").all()).toEqual([
        { id: session.id, preset: "high", state: "starting" },
      ]);
    } finally { legacy.close(false); }

    const migratedAt = 25_060;
    // The authentic starting placeholder has no provider-account adoption
    // proof. The joined migration preserves its preset and payload, but must
    // quarantine it instead of inventing live execution authority.
    const expectedSession = {
      ...session,
      state: "recovery_required" as const,
      revision: session.revision + 1,
      updatedAt: migratedAt,
    };
    const migrated = new StateStore(paths, { now: () => migratedAt });
    stores.push(migrated);
    expect(migrated.requireSessionPresetRequirement(session.id)).toEqual({
      preset: "high",
      requirement: originalPresetRequirement,
    });
    expect(migrated.requireSession(session.id)).toMatchObject(expectedSession);
    const inspector = new Database(paths.database, { readonly: true, strict: true });
    try {
      expect(inspector.query("PRAGMA table_info(sessions)").all())
        .toContainEqual(expect.objectContaining({ name: "preset_contract", notnull: 1 }));
      expect(inspector.query("PRAGMA table_info(works)").all())
        .toContainEqual(expect.objectContaining({ name: "preset_contract", notnull: 1 }));
      expect(inspector.query("SELECT preset_contract FROM sessions WHERE id=?").get(session.id))
        .toEqual({ preset_contract: legacyPresetContract });
      expect(inspector.query("SELECT * FROM session_provider_account_authorities WHERE session_id=?").get(session.id)).toBeNull();
      expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: 61 });
      expect(inspector.query("SELECT version FROM migrations WHERE version=38").get())
        .toEqual({ version: 38 });
      expect(inspector.query("SELECT * FROM migrations WHERE version<=25 ORDER BY version").all())
        .toEqual([...captured.ledger]);
    } finally {
      inspector.close(false);
    }
    migrated.close();
    stores.splice(stores.indexOf(migrated), 1);
    const stable = new Database(paths.database, { create: false, strict: true });
    try {
      stable.exec("PRAGMA query_only=ON");
      const before = canonicalAuthBudgetSnapshot(stable);
      for (const readonly of [false, true]) {
        const reopened = new StateStore(paths, { readonly, now: () => 25_061 });
        try {
          expect(reopened.requireSessionPresetRequirement(session.id)).toEqual({
            preset: "high", requirement: originalPresetRequirement,
          });
          expect(reopened.requireSession(session.id)).toMatchObject(expectedSession);
        } finally { reopened.close(); }
        expect(canonicalAuthBudgetSnapshot(stable)).toEqual(before);
      }
    } finally { stable.close(false); }
  });
test("captures the fresh notification-hours default from the machine zone exactly once", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "oompa-hours-fresh-")));
    const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
    await initializeStatePaths(paths);
    let resolutions = 0;
    const store = new StateStore(paths, {
      now: () => 4_000,
      resolveMachineTimeZone: () => {
        resolutions += 1;
        return "america/puerto_rico";
      },
    });
    stores.push(store);
    expect(store.readNotificationHours()).toEqual({
      version: 1,
      revision: 1,
      startMinute: 600,
      endMinute: 1_320,
      timeZone: "America/Puerto_Rico",
    });
    expect(store.readNotificationEmailPolicy()).toEqual({
      enabled: false,
      revision: 1,
      version: 1,
    });
    expect(resolutions).toBe(1);

    const inspector = new Database(paths.database, { readonly: true, strict: true });
    try {
      expect(inspector.query(
        `SELECT singleton,version,revision,start_minute,end_minute,time_zone,created_at,updated_at
         FROM notification_hours`,
      ).get()).toEqual({
        singleton: 1,
        version: 1,
        revision: 1,
        start_minute: 600,
        end_minute: 1_320,
        time_zone: "America/Puerto_Rico",
        created_at: 4_000,
        updated_at: 4_000,
      });
      expect(inspector.query(
        `SELECT singleton,version,enabled,revision,created_at,updated_at
         FROM attention_email_policy`,
      ).get()).toEqual({
        singleton: 1,
        version: 1,
        enabled: 0,
        revision: 1,
        created_at: 4_000,
        updated_at: 4_000,
      });
    } finally {
      inspector.close(false);
    }
  });
test("migrates captured main35 provider-switch evidence without rewriting its original bytes or digests", async () => {
    const paths = await canonical35To38Archive("main35");
    const captured = canonical35To38Fixture.captures.main35;
    const original = captured.metadata.caseState;
    const database = new Database(paths.database, { create: false, strict: true });
    try {
      database.exec("PRAGMA query_only=ON");
      const history = canonicalAuthBudgetRows(database, [
        "mutation_effect_evidence", "session_provider_switch_targets",
        "session_provider_switch_seed_intents", "session_provider_switch_seed_results",
        "session_provider_switch_source_releases", "session_provider_switch_target_releases",
      ]);
      const readRequest = () => database.query(
        "SELECT id,idempotency_key,kind,authority_id,authority_generation,request_digest,created_at FROM mutation_attempts WHERE id=?",
      ).get(original.attempt.id);
      const request = readRequest();
      expect(database.query("SELECT evidence_json,evidence_digest,recorded_at FROM mutation_effect_evidence WHERE attempt_id=?")
        .get(original.attempt.id)).toEqual({ evidence_json: JSON.stringify(original.effect.evidence),
          evidence_digest: original.effect.digest, recorded_at: original.effect.recordedAt });
      expect(database.query("SELECT provider_thread_id,recorded_at FROM session_provider_switch_targets WHERE attempt_id=?")
        .get(original.attempt.id)).toEqual({ provider_thread_id: original.progress.targetProviderThreadId,
          recorded_at: captured.metadata.fixedTime });
      const before = canonicalAuthBudgetSnapshot(database);
      expect(() => new StateStore(paths, { readonly: true }))
        .toThrow("STATE_SCHEMA_MIGRATION_REQUIRED:35:61");
      expect(canonicalAuthBudgetSnapshot(database)).toEqual(before);
      const migrated = new StateStore(paths, { now: () => 90_000_000, resolveMachineTimeZone: () => "UTC" });
      stores.push(migrated);
      expect(migrated.readNotificationHours()).toMatchObject({ revision: 1, timeZone: "UTC" });
      expect(migrated.readNotificationEmailPolicy()).toEqual({ enabled: false, revision: 1, version: 1 });
      expect(history.read()).toEqual(history.before);
      expect(readRequest()).toEqual(request);
      // A captured old target observation is retained evidence, not proof of
      // a current native account binding or permission to resume provider IO.
      expect(database.query("SELECT * FROM session_provider_account_authorities").all()).toEqual([]);
      expect(database.query("PRAGMA foreign_key_check").all()).toEqual([]);
      expectCanonical35To38InertReopens(paths, database);
    } finally { database.close(false); }
  });
test("converges captured feature35 hours authority without resolving the zone", async () => {
    const paths = await canonical35To38Archive("feature35");
    const captured = canonical35To38Fixture.captures.feature35;
    const database = new Database(paths.database, { create: false, strict: true });
    try {
      database.exec("PRAGMA query_only=ON");
      const history = canonicalAuthBudgetRows(database, ["notification_hours", "profiles", "session_runtime_profiles", "queue_entries"]);
      expect(providerSwitchSchemaObjectCount(database)).toBe(0);
      const before = canonicalAuthBudgetSnapshot(database);
      expect(() => new StateStore(paths, { readonly: true }))
        .toThrow("STATE_SCHEMA_MIGRATION_REQUIRED:35:61");
      expect(canonicalAuthBudgetSnapshot(database)).toEqual(before);
      const migrated = new StateStore(paths, { now: () => 90_000_000,
        resolveMachineTimeZone: () => { throw new Error("CAPTURED_FEATURE35_MUST_RETAIN_ITS_ZONE"); },
      });
      stores.push(migrated);
      expect(migrated.readNotificationHours()).toEqual(captured.metadata.caseState.hours);
      expect(migrated.readNotificationEmailPolicy()).toEqual({ enabled: false, revision: 2, version: 1 });
      expect(history.read()).toEqual(history.before);
      expect(providerSwitchSchemaObjectCount(database)).toBe(21);
      expect(database.query("PRAGMA user_version").get()).toEqual({ user_version: 61 });
      expect(database.query("PRAGMA foreign_key_check").all()).toEqual([]);
      expectCanonical35To38InertReopens(paths, database);
    } finally { database.close(false); }
  });
test("refuses adversarial enabled email on an observed canonical36 stage without changing original rows", async () => {
    const captured = canonical35To38Fixture.captures["observed-canonical36-stage"];
    expect(captured.metadata).toMatchObject({
      kind: "uncommitted_archived_migration_stage", releasedWriterImage: false,
      observedBeforeOuterCommit: true, observerRowOrSchemaWrites: false,
    });
    // Positive control: the serialized stage is source-derived, not a
    // released36 writer, and its unchanged bytes can migrate on their own.
    const controlPaths = await canonical35To38Archive("observed-canonical36-stage");
    const control = new StateStore(controlPaths, { now: () => 90_000_000,
      resolveMachineTimeZone: () => { throw new Error("OBSERVED36_ZONE_MUST_NOT_BE_REPLACED"); },
    });
    stores.push(control);
    expect(control.readNotificationEmailPolicy()).toEqual({ enabled: false, revision: 1, version: 1 });

    const paths = await canonical35To38Archive("observed-canonical36-stage");
    const declarationPaths = await canonical35To38Archive("canonical37");
    const declarations = new Database(declarationPaths.database, { create: false, strict: true });
    declarations.exec("PRAGMA query_only=ON");
    const database = new Database(paths.database, { create: false, strict: true });
    try {
      const before = canonicalAuthBudgetSnapshot(database);
      expect(database.query("SELECT name FROM sqlite_master WHERE name='attention_email_policy'").get()).toBeNull();
      const objects = z.array(z.object({ type: z.enum(["table", "trigger"]), name: z.string(), sql: z.string() }).strict()).parse(
        declarations.query(`SELECT type,name,sql FROM sqlite_master WHERE tbl_name='attention_email_policy'
          ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END,name`).all(),
      );
      expect(objects.map(({ name }) => name)).toEqual([
        "attention_email_policy", "attention_email_policy_delete_guard",
        "attention_email_policy_insert_guard", "attention_email_policy_update_guard",
      ]);
      // Explicit adversarial extension only: exact source37 declarations
      // plus one invented opt-in. No captured old cell/version is edited.
      database.transaction(() => {
        for (const object of objects) database.exec(object.sql);
        database.query(`INSERT INTO attention_email_policy(
          singleton,version,enabled,revision,created_at,updated_at) VALUES(1,1,1,1,37001,37001)`).run();
      }).immediate();
      const after = canonicalAuthBudgetSnapshot(database);
      for (const [table, rows] of Object.entries(before.rows)) expect(after.rows[table]).toEqual(rows);
      expect(after.version).toEqual(before.version);
      expect(database.query("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally { database.close(false); declarations.close(false); }
    expectInertSchemaRefusal(paths, "ATTENTION_EMAIL_POLICY_MIGRATION_OPT_IN_REFUSED",
      "STATE_SCHEMA_MIGRATION_REQUIRED:36:61");
  });
test("preserves captured feature36 explicit email opt-in and its original policy rows", async () => {
    const paths = await canonical35To38Archive("feature36");
    const captured = canonical35To38Fixture.captures.feature36;
    const database = new Database(paths.database, { create: false, strict: true });
    try {
      database.exec("PRAGMA query_only=ON");
      const history = canonicalAuthBudgetRows(database, [
        "notification_hours", "attention_email_policy", "profiles", "session_runtime_profiles", "queue_entries",
      ]);
      expect(providerSwitchSchemaObjectCount(database)).toBe(0);
      const before = canonicalAuthBudgetSnapshot(database);
      expect(() => new StateStore(paths, { readonly: true }))
        .toThrow("STATE_SCHEMA_MIGRATION_REQUIRED:36:61");
      expect(canonicalAuthBudgetSnapshot(database)).toEqual(before);
      const migrated = new StateStore(paths, { now: () => 90_000_000,
        resolveMachineTimeZone: () => { throw new Error("CAPTURED_FEATURE36_MUST_RETAIN_ITS_ZONE"); },
      });
      stores.push(migrated);
      expect(migrated.readNotificationHours()).toEqual(captured.metadata.caseState.hours);
      expect(migrated.readNotificationEmailPolicy()).toEqual(captured.metadata.caseState.email);
      expect(history.read()).toEqual(history.before);
      expect(providerSwitchSchemaObjectCount(database)).toBe(21);
      expect(database.query("PRAGMA user_version").get()).toEqual({ user_version: 61 });
      expect(database.query("PRAGMA foreign_key_check").all()).toEqual([]);
      expectCanonical35To38InertReopens(paths, database);
    } finally { database.close(false); }
  });
test("rejects an adversarial captured feature36 extra policy object without migration writes", async () => {
    const paths = await canonical35To38Archive("feature36");
    const database = new Database(paths.database, { create: false, strict: true });
    try {
      const before = canonicalAuthBudgetSnapshot(database);
      // One explicitly adversarial additive object on an exact old image;
      // no current database is restamped and no old source row is rewritten.
      database.exec("CREATE INDEX attention_email_policy_untrusted ON attention_email_policy(enabled)");
      expect(canonicalAuthBudgetSnapshot(database).rows).toEqual(before.rows);
      expect(database.query("PRAGMA user_version").get()).toEqual(before.version);
    } finally { database.close(false); }
    expectInertSchemaRefusal(paths, "ATTENTION_EMAIL_POLICY_MIGRATION_OPT_IN_REFUSED",
      "STATE_SCHEMA_MIGRATION_REQUIRED:36:61");
  });
test("shares one immediate CAS revision across email opt-in and hours", async () => {
    const { store } = await fixture();
    const contender = new StateStore(store.paths, {
      now: () => 3_000,
      resolveMachineTimeZone: () => {
        throw new Error("CURRENT_SCHEMA_MUST_NOT_RESOLVE_MACHINE_ZONE");
      },
    });
    stores.push(contender);

    expect(store.updateNotificationEmailPolicy({
      enabled: true,
      expectedRevision: 1,
    })).toEqual({ enabled: true, revision: 2, version: 1 });
    expect(store.readNotificationHours()).toMatchObject({ revision: 2 });
    expect(() => contender.updateNotificationHours({
      expectedRevision: 1,
      version: 1,
      startMinute: 0,
      endMinute: 60,
      timeZone: "UTC",
    })).toThrow("NOTIFICATION_HOURS_REVISION_CONFLICT");
    expect(store.updateNotificationHours({
      expectedRevision: 2,
      version: 1,
      startMinute: 0,
      endMinute: 60,
      timeZone: "UTC",
    })).toMatchObject({ revision: 3 });
    expect(store.readNotificationEmailPolicy()).toEqual({
      enabled: true,
      revision: 3,
      version: 1,
    });
    expect(store.updateNotificationEmailPolicy({
      enabled: false,
      expectedRevision: 3,
    })).toEqual({ enabled: false, revision: 4, version: 1 });
    expect(store.readNotificationHours()).toMatchObject({ revision: 4 });
    const inspector = new Database(store.paths.database, { create: false, strict: true });
    try {
      expect(inspector.query(
        `SELECT h.revision AS hours_revision,e.revision AS email_revision,e.enabled
         FROM notification_hours h JOIN attention_email_policy e
         ON h.singleton=e.singleton`,
      ).get()).toEqual({ hours_revision: 4, email_revision: 4, enabled: 0 });
      expect(() => inspector.query(
        "UPDATE attention_email_policy SET enabled=1 WHERE singleton=1",
      ).run()).toThrow("invalid attention email policy transition");
      expect(() => inspector.query(
        "DELETE FROM attention_email_policy WHERE singleton=1",
      ).run()).toThrow("attention email policy cannot be deleted");
      expect(() => inspector.query(
        `INSERT OR REPLACE INTO attention_email_policy(
           singleton,version,enabled,revision,created_at,updated_at
         ) VALUES (1,1,0,1,1,1)`,
      ).run()).toThrow("attention email policy already exists");
    } finally {
      inspector.close(false);
    }
  });
test("fails closed when the composite notification revision diverges", async () => {
    const { store } = await fixture();
    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const tampered = new Database(paths.database, { create: false, strict: true });
    tampered.query(
      `UPDATE attention_email_policy
       SET revision=revision+1,updated_at=updated_at+1 WHERE singleton=1`,
    ).run();
    tampered.close(false);

    expect(() => new StateStore(paths, { readonly: true }))
      .toThrow("NOTIFICATION_POLICY_REVISION_DIVERGED");
    expect(() => new StateStore(paths))
      .toThrow("NOTIFICATION_POLICY_REVISION_DIVERGED");
  });
test("migrates a populated v34 database once and preserves its authority", async () => {
    const paths = await canonical34StorageArchive();
    const source = canonical34StorageFixture.retained;
    const inspector = new Database(paths.database, { create: false, strict: true });
    inspector.exec("PRAGMA query_only=ON");
    try {
      const before = canonicalAuthBudgetSnapshot(inspector);
      const retained = canonicalAuthBudgetRows(inspector, [
        "profiles", "projects", "session_runtime_profiles", "queue_entries",
        "desktop_switches", "desktop_switch_resolutions", "desktop_switch_authority",
        "usage_revision_authority", "usage_snapshots", "usage_poll_failures",
      ]);
      expect(before.version).toEqual({ user_version: 34 });
      expect(() => new StateStore(paths, { readonly: true }))
        .toThrow("STATE_SCHEMA_MIGRATION_REQUIRED:34:61");
      expect(canonicalAuthBudgetSnapshot(inspector)).toEqual(before);
      expect(inspector.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='notification_hours'")
        .get()).toBeNull();

      let resolutions = 0;
      const migrated = new StateStore(paths, {
        now: () => 50_000,
        resolveMachineTimeZone: () => { resolutions += 1; return "Asia/Tokyo"; },
      });
      stores.push(migrated);
      expect(migrated.requireProfile(source.profile.id)).toMatchObject(source.profile);
      expect(migrated.readNotificationHours()).toEqual({
        version: 1, revision: 1, startMinute: 600, endMinute: 1_320, timeZone: "Asia/Tokyo",
      });
      expect(resolutions).toBe(1);
      expect(retained.read()).toEqual(retained.before);
      expect(migrated.requireQueue(source.unboundQueue.id)).toMatchObject(source.unboundQueue);
      expect(migrated.hasUnsettledQueueAttachmentQuarantineForSession(source.unboundSession.id)).toBe(true);
      expect(inspector.query("SELECT * FROM session_provider_account_authorities WHERE session_id=?")
        .all(source.unboundSession.id)).toEqual([]);
      expect(providerSwitchSchemaObjectCount(inspector)).toBe(21);
      expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: 61 });
      expect(inspector.query("PRAGMA foreign_key_check").all()).toEqual([]);
      const joined = canonicalAuthBudgetSnapshot(inspector);
      migrated.close();
      stores.splice(stores.indexOf(migrated), 1);
      for (const readonly of [false, true]) {
        const reopened = new StateStore(paths, {
          readonly, now: () => 60_000,
          resolveMachineTimeZone: () => { throw new Error("CURRENT_SCHEMA_MUST_NOT_RESOLVE_MACHINE_ZONE"); },
        });
        try {
          expect(reopened.readNotificationHours().timeZone).toBe("Asia/Tokyo");
          expect(reopened.requireProfile(source.profile.id)).toMatchObject(source.profile);
          expect(retained.read()).toEqual(retained.before);
          expect(canonicalAuthBudgetSnapshot(inspector)).toEqual(joined);
        } finally { reopened.close(); }
      }
    } finally { inspector.close(false); }
  });
test("rolls a failed v34 notification-hours migration back without a UTC fallback", async () => {
    const paths = await canonical34StorageArchive();
    const inspector = new Database(paths.database, { create: false, strict: true });
    inspector.exec("PRAGMA query_only=ON");
    try {
      const before = canonicalAuthBudgetSnapshot(inspector);
      expect(before.version).toEqual({ user_version: 34 });
      expect(() => new StateStore(paths, {
        now: () => 70_000, resolveMachineTimeZone: () => "+00:00",
      })).toThrow();
      expect(canonicalAuthBudgetSnapshot(inspector)).toEqual(before);
      expect(inspector.query("SELECT 1 FROM migrations WHERE version=35").get()).toBeNull();
      expect(inspector.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='notification_hours'")
        .get()).toBeNull();
      expect(providerSwitchSchemaObjectCount(inspector)).toBe(0);
      const recovered = new StateStore(paths, {
        now: () => 80_000, resolveMachineTimeZone: () => "UTC",
      });
      stores.push(recovered);
      expect(recovered.readNotificationHours()).toMatchObject({ revision: 1, timeZone: "UTC" });
      expectHistoricalValue(recovered.latestSessionRuntimeProfile(canonical34StorageFixture.retained.session.id),
        canonical34StorageFixture.retained.runtimeRecord);
      expect(inspector.query("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally { inspector.close(false); }
  });
test("updates notification hours by independent revision CAS across clock rollback", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "oompa-hours-cas-")));
    const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
    await initializeStatePaths(paths);
    let now = 10_000;
    const store = new StateStore(paths, {
      now: () => now,
      resolveMachineTimeZone: () => "UTC",
    });
    stores.push(store);
    const contender = new StateStore(paths, {
      now: () => 13_000,
      resolveMachineTimeZone: () => {
        throw new Error("CURRENT_SCHEMA_MUST_NOT_RESOLVE_MACHINE_ZONE");
      },
    });
    stores.push(contender);

    now = 12_000;
    expect(store.updateNotificationHours({
      expectedRevision: 1,
      version: 1,
      startMinute: 1_320,
      endMinute: 600,
      timeZone: "asia/tokyo",
    })).toEqual({
      version: 1,
      revision: 2,
      startMinute: 1_320,
      endMinute: 600,
      timeZone: "Asia/Tokyo",
    });
    store.setDefaultShowThinking(true);
    expect(store.readNotificationHours().revision).toBe(2);
    expect(() => contender.updateNotificationHours({
      expectedRevision: 1,
      version: 1,
      startMinute: 0,
      endMinute: 60,
      timeZone: "UTC",
    })).toThrow("NOTIFICATION_HOURS_REVISION_CONFLICT");
    expect(() => store.updateNotificationHours({
      expectedRevision: 2,
      version: 1,
      startMinute: 60,
      endMinute: 60,
      timeZone: "UTC",
    })).toThrow();
    expect(() => store.updateNotificationHours({
      expectedRevision: 2,
      version: 1,
      startMinute: 0,
      endMinute: 60,
      timeZone: "+00:00",
    })).toThrow();
    expect(store.readNotificationHours()).toMatchObject({
      revision: 2,
      startMinute: 1_320,
      timeZone: "Asia/Tokyo",
    });

    now = 9_000;
    expect(store.updateNotificationHours({
      expectedRevision: 2,
      version: 1,
      startMinute: 0,
      endMinute: 60,
      timeZone: "UTC",
    })).toMatchObject({ revision: 3, timeZone: "UTC" });
    const inspector = new Database(paths.database, { create: false, strict: true });
    try {
      expect(inspector.query(
        "SELECT revision,created_at,updated_at FROM notification_hours WHERE singleton=1",
      ).get()).toEqual({ revision: 3, created_at: 10_000, updated_at: 12_000 });
      expect(() => inspector.query(
        `INSERT OR REPLACE INTO notification_hours(
           singleton,version,revision,start_minute,end_minute,time_zone,created_at,updated_at
         ) VALUES (1,1,1,600,1320,'UTC',1,1)`,
      ).run()).toThrow("notification hours already exists");
      expect(inspector.query(
        "SELECT revision,created_at,updated_at FROM notification_hours WHERE singleton=1",
      ).get()).toEqual({ revision: 3, created_at: 10_000, updated_at: 12_000 });
      expect(() => inspector.query(
        "UPDATE notification_hours SET start_minute=120 WHERE singleton=1",
      ).run()).toThrow("invalid notification hours transition");
      expect(() => inspector.query(
        "DELETE FROM notification_hours WHERE singleton=1",
      ).run()).toThrow("notification hours cannot be deleted");
    } finally {
      inspector.close(false);
    }
  });
test("refuses notification-hours revision exhaustion", async () => {
    const { store } = await fixture();
    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const authority = new Database(paths.database, { create: false, strict: true });
    withRemovedTestGuards(authority, ["notification_hours_update_guard", "attention_email_policy_update_guard"], () => {
      authority.exec(`
        UPDATE notification_hours SET revision=9007199254740991 WHERE singleton=1;
        UPDATE attention_email_policy SET revision=9007199254740991 WHERE singleton=1;
      `);
    });
    authority.close(false);

    const reopened = new StateStore(paths, {
      now: () => 20_000,
      resolveMachineTimeZone: () => {
        throw new Error("CURRENT_SCHEMA_MUST_NOT_RESOLVE_MACHINE_ZONE");
      },
    });
    stores.push(reopened);
    expect(() => reopened.updateNotificationHours({
      expectedRevision: Number.MAX_SAFE_INTEGER,
      version: 1,
      startMinute: 0,
      endMinute: 60,
      timeZone: "UTC",
    })).toThrow("NOTIFICATION_HOURS_REVISION_EXHAUSTED");
    expect(() => reopened.updateNotificationEmailPolicy({
      enabled: true,
      expectedRevision: Number.MAX_SAFE_INTEGER,
    })).toThrow("ATTENTION_EMAIL_POLICY_REVISION_EXHAUSTED");
    expect(reopened.readNotificationHours().revision).toBe(Number.MAX_SAFE_INTEGER);
    expect(reopened.readNotificationEmailPolicy().revision)
      .toBe(Number.MAX_SAFE_INTEGER);
  });
test("refuses missing and noncanonical notification-hours authority: missing singleton", async () => {
    const missingFixture = await fixture();
    const missingPaths = missingFixture.store.paths;
    missingFixture.store.close();
    stores.splice(stores.indexOf(missingFixture.store), 1);
    const missing = new Database(missingPaths.database, { create: false, strict: true });
    missing.exec(`
      DROP TRIGGER notification_hours_delete_guard;
      DELETE FROM notification_hours WHERE singleton=1;
      CREATE TRIGGER notification_hours_delete_guard
      BEFORE DELETE ON notification_hours
      BEGIN SELECT RAISE(ABORT, 'notification hours cannot be deleted'); END;
    `);
    missing.close(false);
    expect(() => new StateStore(missingPaths, { readonly: true }))
      .toThrow("NOTIFICATION_HOURS_POLICY_MISSING");
    expect(() => new StateStore(missingPaths, {
      resolveMachineTimeZone: () => "UTC",
    })).toThrow("NOTIFICATION_HOURS_POLICY_MISSING");
  });
test("refuses missing and noncanonical notification-hours authority: noncanonical time zone", async () => {
    const corruptFixture = await fixture();
    const corruptPaths = corruptFixture.store.paths;
    corruptFixture.store.close();
    stores.splice(stores.indexOf(corruptFixture.store), 1);
    const corrupt = new Database(corruptPaths.database, { create: false, strict: true });
    corrupt.exec(`
      DROP TRIGGER notification_hours_update_guard;
      UPDATE notification_hours
      SET revision=revision+1,time_zone='america/puerto_rico'
      WHERE singleton=1;
      CREATE TRIGGER notification_hours_update_guard
      BEFORE UPDATE ON notification_hours
      WHEN NEW.singleton != OLD.singleton
        OR NEW.version != OLD.version
        OR NEW.created_at != OLD.created_at
        OR NEW.revision != OLD.revision + 1
        OR NEW.updated_at < OLD.updated_at
      BEGIN SELECT RAISE(ABORT, 'invalid notification hours transition'); END;
    `);
    corrupt.close(false);
    expect(() => new StateStore(corruptPaths, { readonly: true }))
      .toThrow("NOTIFICATION_HOURS_POLICY_INVALID");
    expect(() => new StateStore(corruptPaths, {
      resolveMachineTimeZone: () => "UTC",
    })).toThrow("NOTIFICATION_HOURS_POLICY_INVALID");
  });
test("refuses missing and noncanonical notification-hours authority: weakened update guard", async () => {
    const weakenedFixture = await fixture({ provision: "migrate" });
    const weakenedPaths = weakenedFixture.store.paths;
    weakenedFixture.store.close();
    stores.splice(stores.indexOf(weakenedFixture.store), 1);
    const weakened = new Database(weakenedPaths.database, { create: false, strict: true });
    weakened.exec(`
      DROP TRIGGER notification_hours_update_guard;
      CREATE TRIGGER notification_hours_update_guard
      BEFORE UPDATE ON notification_hours
      BEGIN SELECT 1; END;
      UPDATE notification_hours SET start_minute=601 WHERE singleton=1;
    `);
    weakened.close(false);
    expect(() => new StateStore(weakenedPaths, { readonly: true }))
      .toThrow("STATE_SCHEMA_V36_NOTIFICATION_HOURS_STRUCTURE_INVALID");
    expect(() => new StateStore(weakenedPaths, {
      resolveMachineTimeZone: () => "UTC",
    })).toThrow("STATE_SCHEMA_V36_NOTIFICATION_HOURS_STRUCTURE_INVALID");
  });
test("refuses missing and noncanonical notification-hours authority: weakened insert guard", async () => {
    const weakenedInsertFixture = await fixture({ provision: "migrate" });
    const weakenedInsertPaths = weakenedInsertFixture.store.paths;
    weakenedInsertFixture.store.close();
    stores.splice(stores.indexOf(weakenedInsertFixture.store), 1);
    const weakenedInsert = new Database(
      weakenedInsertPaths.database,
      { create: false, strict: true },
    );
    weakenedInsert.exec(`
      DROP TRIGGER notification_hours_insert_guard;
      CREATE TRIGGER notification_hours_insert_guard
      BEFORE INSERT ON notification_hours
      BEGIN SELECT 1; END;
    `);
    weakenedInsert.close(false);
    expect(() => new StateStore(weakenedInsertPaths, { readonly: true }))
      .toThrow("STATE_SCHEMA_V36_NOTIFICATION_HOURS_STRUCTURE_INVALID");
    expect(() => new StateStore(weakenedInsertPaths, {
      resolveMachineTimeZone: () => "UTC",
    })).toThrow("STATE_SCHEMA_V36_NOTIFICATION_HOURS_STRUCTURE_INVALID");
  });
test("migrates authentic canonical30 Work and protocol autorespond history before reopening current49", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "oompa-store-canonical30-work-")));
    const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
    await initializeStatePaths(paths);
    await writeFile(paths.database, canonical30WorkDatabaseBytes(), { mode: 0o600 });
    let inspector = new Database(paths.database, { create: false, strict: true });
    try {
      expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: 30 });
      expect(inspector.query(
        "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name='works' OR name GLOB 'work_*' OR name GLOB 'works_*' ORDER BY name",
      ).all()).toEqual([...canonical30WorkFixture.workObjects]);
      expect(inspector.query("SELECT * FROM autorespond_evidence ORDER BY id").all())
        .toEqual([...canonical30WorkFixture.evidence]);
      expect(inspector.query("SELECT * FROM sessions WHERE id=?").get(canonical30WorkFixture.sessionId))
        .toEqual(canonical30WorkFixture.sessionRow);
      expect(inspector.query("SELECT name FROM pragma_table_info('sessions') WHERE name='provider'").get()).toBeNull();
      expect(inspector.query("SELECT name FROM pragma_table_info('autorespond_evidence') WHERE name='path'").get()).toBeNull();

      inspector.close(false);
      const migrated = new StateStore(paths, { now: () => 2_000 });
      stores.push(migrated);
      // Rebuilds change column positions. Reopen the inspector so Bun cannot
      // reuse SELECT * result metadata prepared against the archived schema.
      inspector = new Database(paths.database, { readonly: true, strict: true });
      expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: 61 });
      expect(inspector.query("SELECT name,dflt_value FROM pragma_table_info('sessions') WHERE name='provider'").get())
        .toEqual({ name: "provider", dflt_value: "'codex'" });
      expect(inspector.query("SELECT name FROM pragma_table_info('autorespond_evidence') WHERE name='path'").get())
        .toEqual({ name: "path" });
      const evidence = inspector.query("SELECT * FROM autorespond_evidence ORDER BY id").all();
      expect(evidence).toEqual(canonical30WorkFixture.evidence.map((row) => ({
        ...row, path: "protocol", rule: null, model: null,
      })));
      expect(inspector.query(
        "SELECT id,session_id,interaction_id,kind,class,decision,mode,outcome,latency_ms,subagent,occurred_at FROM autorespond_evidence ORDER BY id",
      ).all()).toEqual([...canonical30WorkFixture.evidence]);
      expect(inspector.query("SELECT version,applied_at FROM migrations WHERE version<=30 ORDER BY version").all())
        .toEqual([...canonical30WorkFixture.migrations]);
      expect(inspector.query("SELECT version FROM migrations WHERE version>30 ORDER BY version").all())
        .toEqual(Array.from({ length: 31 }, (_, index) => ({ version: index + 31 })));
      const retained = migrated.requireSession(canonical30WorkFixture.sessionId);
      expect(retained.providerThreadId).toBe(canonical30WorkFixture.sessionRow.provider_thread_id);
      expect(retained.preset).toBe(canonical30WorkFixture.sessionRow.preset);
      const schema = inspector.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY name").all();
      const ledger = inspector.query("SELECT * FROM migrations ORDER BY version").all();
      const session = inspector.query("SELECT * FROM sessions WHERE id=?").get(retained.id);
      inspector.close(false);
      migrated.close();
      stores.splice(stores.indexOf(migrated), 1);
      const reopened = new StateStore(paths, { now: () => 2_001 });
      stores.push(reopened);
      const readonly = new StateStore(paths, { readonly: true });
      readonly.close();
      inspector = new Database(paths.database, { readonly: true, strict: true });
      expect(inspector.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY name").all()).toEqual(schema);
      expect(inspector.query("SELECT * FROM migrations ORDER BY version").all()).toEqual(ledger);
      expect(inspector.query("SELECT * FROM autorespond_evidence ORDER BY id").all()).toEqual(evidence);
      expect(inspector.query("SELECT * FROM sessions WHERE id=?").get(retained.id)).toEqual(session);
    } finally {
      inspector.close(false);
    }
  });
test("current v60 opens reject a missing v35 authority object without repairing it", async () => {
    const { store } = await fixture({ provision: "migrate" });
    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const damaged = new Database(paths.database, { create: false, strict: true });
    try {
      damaged.exec("DROP TRIGGER session_provider_switch_targets_immutable_delete");
    } finally {
      damaged.close(false);
    }

    for (const readonly of [true, false]) {
      expect(() => new StateStore(paths, readonly ? { readonly: true } : {}))
        .toThrow("STATE_SCHEMA_V35_OBJECT_MISSING:session_provider_switch_targets_immutable_delete");
    }
    const unchanged = new Database(paths.database, { readonly: true, strict: true });
    try {
      expect(unchanged.query(
        "SELECT name FROM sqlite_master WHERE name='session_provider_switch_targets_immutable_delete'",
      ).get()).toBeNull();
      expect(unchanged.query("PRAGMA user_version").get()).toEqual({ user_version: 61 });
    } finally {
      unchanged.close(false);
    }
  });
test("current60 refuses a missing provider-switch object without recreating evidence", async () => {
    const { store } = await fixture({ provision: "migrate" });
    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const damaged = new Database(paths.database, { create: false, strict: true });
    try {
      damaged.exec("DROP TABLE session_provider_switch_target_releases");
    } finally {
      damaged.close(false);
    }

    expectInertSchemaRefusal(paths, "STATE_SCHEMA_V35_OBJECT_MISSING:session_provider_switch_target_releases");
  });
test("rejects a same-name no-op v35 immutable trigger as invalid", async () => {
    const { store } = await fixture({ provision: "migrate" });
    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const damaged = new Database(paths.database, { create: false, strict: true });
    try {
      damaged.exec(`
        DROP TRIGGER session_mutation_authority_rebinds_immutable_update;
        CREATE TRIGGER session_mutation_authority_rebinds_immutable_update
        BEFORE UPDATE ON session_mutation_authority_rebinds
        BEGIN SELECT 1; END;
      `);
    } finally {
      damaged.close(false);
    }

    expect(() => new StateStore(paths, { now: () => 2_000 }))
      .toThrow("STATE_SCHEMA_V35_OBJECT_INVALID:session_mutation_authority_rebinds_immutable_update");
  });
test("rejects a same-name v35 immutable trigger attached to the wrong table", async () => {
    const { store } = await fixture({ provision: "migrate" });
    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const damaged = new Database(paths.database, { create: false, strict: true });
    try {
      damaged.exec(`
        DROP TRIGGER session_provider_switch_targets_immutable_delete;
        CREATE TRIGGER session_provider_switch_targets_immutable_delete
        BEFORE DELETE ON session_provider_switch_seed_intents
        BEGIN SELECT RAISE(ABORT, 'session provider switch target is immutable'); END;
      `);
    } finally {
      damaged.close(false);
    }

    expect(() => new StateStore(paths, { readonly: true }))
      .toThrow("STATE_SCHEMA_V35_OBJECT_INVALID:session_provider_switch_targets_immutable_delete");
  });
test("current49 refuses a nonunique Unicode label index without changing state", async () => {
    const { store } = await fixture({ provision: "migrate" });
    const paths = store.paths;
    store.createProfile("Équipe");
    store.close();
    stores.splice(stores.indexOf(store), 1);

    const stale = new Database(paths.database, { create: false, strict: true });
    stale.exec(`
      DROP INDEX profiles_label_key_active;
      CREATE INDEX profiles_label_key_active
        ON profiles(label_key) WHERE state!='removed';
    `);
    stale.close(false);

    expectInertSchemaRefusal(paths, "STATE_SCHEMA_V24_STRUCTURE_INVALID");
  });
test("current49 refuses a stale label guard without rewriting authority", async () => {
    const { store } = await fixture({ provision: "migrate" });
    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);

    const stale = new Database(paths.database, { create: false, strict: true });
    stale.exec(`
      DROP TRIGGER profiles_label_key_insert_guard;
      CREATE TRIGGER profiles_label_key_insert_guard
      BEFORE INSERT ON profiles
      BEGIN SELECT 1; END;
    `);
    stale.close(false);

    expectInertSchemaRefusal(paths, "STATE_SCHEMA_V24_STRUCTURE_INVALID");
  });
test("fails closed without writes when authentic v17 account labels collide during Unicode migration", async () => {
    const captured = canonicalLabelPresetFixture.captures["canonical17-account-collision"];
    const paths = await canonicalLabelPresetArchive("canonical17-account-collision");
    const inspector = new Database(paths.database, { create: false, strict: true });
    try {
      inspector.exec("PRAGMA query_only=ON");
      expect(inspector.query("PRAGMA table_info(profiles)").all())
        .not.toContainEqual(expect.objectContaining({ name: "label_key" }));
      expect(inspector.query("SELECT id,label FROM profiles ORDER BY id").all())
        .toEqual(captured.retained.profiles.map(({ id, label }) => ({ id, label })).sort((a, b) => a.id.localeCompare(b.id)));
      expect(captured.retained.profiles.map(({ label }) => label)).toEqual(["Équipe", "équipe"]);
      expect(new Set(captured.retained.profiles.map(({ label }) => label.normalize("NFKC").toLowerCase())).size).toBe(1);
    } finally {
      inspector.close(false);
    }
    // These two rows were accepted by the actual17 public writer. Neither
    // current SQL corruption nor a fabricated23 cohort supplies this input.
    expectInertSchemaRefusal(paths, "STATE_ACCOUNT_LABEL_COLLISION", "STATE_SCHEMA_MIGRATION_REQUIRED:17:61");
  });
test("fails closed without writes when authentic v17 project labels collide during Unicode migration", async () => {
    const captured = canonicalLabelPresetFixture.captures["canonical17-project-collision"];
    const paths = await canonicalLabelPresetArchive("canonical17-project-collision");
    const inspector = new Database(paths.database, { create: false, strict: true });
    try {
      inspector.exec("PRAGMA query_only=ON");
      expect(inspector.query("PRAGMA table_info(projects)").all())
        .not.toContainEqual(expect.objectContaining({ name: "label_key" }));
      expect(inspector.query("SELECT id,label,root_path FROM projects ORDER BY id").all())
        .toEqual(captured.retained.projects.map(({ id, label, rootPath }) => ({ id, label, root_path: rootPath }))
          .sort((a, b) => a.id.localeCompare(b.id)));
      expect(captured.retained.projects.map(({ label }) => label)).toEqual(["Café", "Cafe\u0301"]);
      expect(new Set(captured.retained.projects.map(({ label }) => label.normalize("NFKC").toLowerCase())).size).toBe(1);
      expect(captured.retained.projectDirectoriesInspectedOnly).toBe(true);
    } finally {
      inspector.close(false);
    }
    // The archive contains directory metadata only; this test never opens or
    // grants execution authority to either captured public project root.
    expectInertSchemaRefusal(paths, "STATE_PROJECT_LABEL_COLLISION", "STATE_SCHEMA_MIGRATION_REQUIRED:17:61");
  });
test("migrates an exact v17 writer to the current prepared-response supersession guards", async () => {
    const paths = await canonicalLabelPresetArchive("canonical17-approval-controls");
    const { store: reference } = await fixture({ provision: "migrate" });
    const selectGuards = (database: Database) => database.query(
      `SELECT name,tbl_name,sql FROM sqlite_master WHERE type='trigger' AND name IN (
         'provider_interactions_intent_immutable','provider_interactions_response_fields_guard',
         'provider_interactions_revision_guard') ORDER BY name`,
    ).all();
    const referenceReader = new Database(reference.paths.database, { readonly: true, strict: true });
    const expectedGuards = selectGuards(referenceReader);
    referenceReader.close(false);
    expect(expectedGuards).toHaveLength(3);
    const inspector = new Database(paths.database, { create: false, strict: true });
    inspector.exec("PRAGMA query_only=ON");
    try {
      expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: 17 });
      const original = canonicalAuthBudgetSnapshot(inspector);
      expect(() => new StateStore(paths, { readonly: true })).toThrow("STATE_SCHEMA_MIGRATION_REQUIRED:17:61");
      expect(canonicalAuthBudgetSnapshot(inspector)).toEqual(original);
      const migrated = new StateStore(paths, { now: () => 26_000 });
      stores.push(migrated);
      expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: 61 });
      expect(selectGuards(inspector)).toEqual(expectedGuards);
      expect(inspector.query("PRAGMA foreign_key_check").all()).toEqual([]);
      const after = canonicalAuthBudgetSnapshot(inspector);
      for (const readonly of [false, true]) {
        const reopened = new StateStore(paths, { readonly, now: () => 26_001 });
        try {
          expect(selectGuards(inspector)).toEqual(expectedGuards);
          expect(canonicalAuthBudgetSnapshot(inspector)).toEqual(after);
        } finally { reopened.close(); }
      }
    } finally { inspector.close(false); }
  });
test("migrates exact v17 approval scope booleans into ordered decisions without provider authority", async () => {
    const paths = await canonicalLabelPresetArchive("canonical17-approval-controls");
    const retained = canonicalLabelPresetFixture.captures["canonical17-approval-controls"].retained;
    const command = retained.command.record;
    const files = retained.fileChange.record;
    const cases = [
      { interaction: command, decisions: ["once", "session", "decline", "cancel"] },
      { interaction: files, decisions: ["once", "decline", "cancel"] },
    ];
    const inspector = new Database(paths.database, { create: false, strict: true });
    inspector.exec("PRAGMA query_only=ON");
    try {
      expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: 17 });
      const originalRows = canonicalAuthBudgetRows(inspector, ["provider_interactions", "provider_interaction_transitions"]);
      const expected = new Map(cases.map(({ interaction, decisions }) => {
        expect(inspector.query("SELECT display_json FROM provider_interactions WHERE public_id=?").get(interaction.publicId))
          .toEqual({ display_json: JSON.stringify(interaction.display) });
        const { allowsSessionApproval, ...display } = interaction.display;
        expect(allowsSessionApproval).toBe(interaction.kind === "command_approval");
        const publicId: string = interaction.publicId;
        return [publicId, { ...display, availableDecisions: decisions }];
      }));
      const migrated = new StateStore(paths, { now: () => 26_000 });
      stores.push(migrated);
      for (const { interaction } of cases) {
        expect(() => migrated.requireInteraction(interaction.publicId)).toThrow("INTERACTION_PROVIDER_AUTHORITY_MISSING");
        const row = z.object({ display_json: z.string() }).strict().parse(inspector.query(
          "SELECT display_json FROM provider_interactions WHERE public_id=?",
        ).get(interaction.publicId));
        expect(JSON.parse(row.display_json)).toEqual(expected.get(interaction.publicId));
        expect(inspector.query("SELECT * FROM interaction_provider_authorities WHERE public_id=?").all(interaction.publicId))
          .toEqual([]);
      }
      const originalInteractions = z.array(z.record(z.string(), z.unknown())).parse(originalRows.before.provider_interactions);
      expect(originalRows.read()).toEqual({
        ...originalRows.before,
        provider_interactions: originalInteractions.map((row) => ({
          ...row,
          display_json: JSON.stringify(expected.get(z.string().parse(row.public_id))),
        })),
      });
      expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: 61 });
      expect(inspector.query("PRAGMA foreign_key_check").all()).toEqual([]);
      const after = canonicalAuthBudgetSnapshot(inspector);
      for (const readonly of [false, true]) {
        const reopened = new StateStore(paths, { readonly, now: () => 26_001 });
        try {
          expect(() => reopened.requireInteraction(command.publicId)).toThrow("INTERACTION_PROVIDER_AUTHORITY_MISSING");
          expect(canonicalAuthBudgetSnapshot(inspector)).toEqual(after);
        } finally { reopened.close(); }
      }
    } finally { inspector.close(false); }
  });
test("migrates an observed v16 stage pending login without a provider login ID to fresh-login state", async () => {
    const paths = await canonicalEarlyMigrationArchive(16);
    const { pendingProfile: profile, pendingLogin: attempt, loginKey } = canonicalEarlyMigrationFixture.retained;
    expect(canonicalEarlyMigrationFixture.images[16].provenance.kind)
      .toBe("uncommitted_archived_migration_stage");
    const inspector = new Database(paths.database, { create: false, strict: true });
    inspector.exec("PRAGMA query_only=ON");
    try {
      expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: 16 });
      const original = canonicalAuthBudgetRows(inspector, ["mutation_attempts", "mutation_effect_evidence"]);
      expect(inspector.query("SELECT result_json FROM mutation_attempts WHERE id=?").get(attempt.id))
        .toEqual({ result_json: JSON.stringify(attempt.result) });
      const before = canonicalAuthBudgetSnapshot(inspector);
      expect(() => new StateStore(paths, { readonly: true })).toThrow("STATE_SCHEMA_MIGRATION_REQUIRED:16:61");
      expect(canonicalAuthBudgetSnapshot(inspector)).toEqual(before);

      const migrated = new StateStore(paths, { now: () => 20_000 });
      stores.push(migrated);
      expect(migrated.requireProfile(profile.id)).toMatchObject({ processGeneration: 1, state: "signed_out" });
      expect(migrated.readMutation(loginKey)).toMatchObject({
        originalState: "applied",
        resolution: { kind: "abandoned", evidence: { source: "schema17", reason: "missing_provider_login_id" } },
        state: "reconciled",
      });
      expect(migrated.readPendingLoginAuthority(profile.id, 1)).toBeNull();
      expect(original.read()).toEqual(original.before);
      expect(inspector.query("SELECT * FROM provider_login_authorities WHERE profile_id=?").all(profile.id))
        .toEqual([]);
      expect(inspector.query("PRAGMA foreign_key_check").all()).toEqual([]);
      const migratedSnapshot = canonicalAuthBudgetSnapshot(inspector);
      for (const readonly of [false, true]) {
        const reopened = new StateStore(paths, { readonly, now: () => 21_000 });
        try {
          expect(reopened.readMutation(loginKey)?.state).toBe("reconciled");
          expect(canonicalAuthBudgetSnapshot(inspector)).toEqual(migratedSnapshot);
        } finally { reopened.close(); }
      }
      expect(migrated.prepareMutation({
        kind: "account.login",
        authorityId: profile.id,
        authorityGeneration: 2,
        request: { deviceCode: false },
        idempotencyKey: "00000000-0000-4000-8000-000000000982",
      })).toMatchObject({ replay: false, state: "prepared" });
    } finally { inspector.close(false); }
  });
test("redacts and terminalizes secret-bearing MCP URL interactions from an exact v10 writer", async () => {
    const paths = await canonicalEarlyMigrationArchive(10);
    const { mcp, mcpSentinel: sentinel, session } = canonicalEarlyMigrationFixture.retained;
    const interactionId = mcp.record.publicId;
    const inspector = new Database(paths.database, { create: false, strict: true });
    inspector.exec("PRAGMA query_only=ON");
    try {
      expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: 10 });
      expect(inspector.query("SELECT display_json FROM provider_interactions WHERE public_id=?").get(interactionId))
        .toEqual({ display_json: JSON.stringify(mcp.record.display) });
      expect(await stateFileSuffixesContaining(paths.database, sentinel)).toContain("");
      const before = canonicalAuthBudgetSnapshot(inspector);
      expect(() => new StateStore(paths, { readonly: true })).toThrow("STATE_SCHEMA_MIGRATION_REQUIRED:10:61");
      expect(canonicalAuthBudgetSnapshot(inspector)).toEqual(before);
    } finally { inspector.close(false); }

    const migrated = new StateStore(paths, { now: () => 20_000 });
    stores.push(migrated);
    expect(() => migrated.requireInteraction(interactionId)).toThrow("INTERACTION_PROVIDER_AUTHORITY_MISSING");
    expect(() => migrated.listInteractions({ sessionId: session.id })).toThrow("INTERACTION_PROVIDER_AUTHORITY_MISSING");
    // This genuine image also retains two other pending approvals. They lack
    // immutable session authority, so a pending-page read must refuse them.
    expect(() => migrated.listInteractions({ sessionId: session.id, pendingOnly: true }))
      .toThrow("INTERACTION_PROVIDER_AUTHORITY_MISSING");
    migrated.close();
    stores.splice(stores.indexOf(migrated), 1);

    const after = new Database(paths.database, { readonly: true, strict: true });
    try {
      expect(after.query("PRAGMA user_version").get()).toEqual({ user_version: 61 });
      expect(after.query(
        "SELECT revision,state FROM provider_interaction_transitions WHERE public_id=? ORDER BY revision",
      ).all(interactionId)).toEqual([{ revision: 1, state: "pending" }, { revision: 2, state: "resolution_unknown" }]);
      expect(after.query(
        "SELECT reason FROM legacy_provider_authority_quarantines WHERE scope_kind='interaction' AND scope_id=?",
      ).get(interactionId)).toEqual({ reason: "unknown_provider_method" });
      expect(JSON.stringify(after.query(
        "SELECT display_json FROM provider_interactions WHERE public_id=?",
      ).get(interactionId))).not.toContain(sentinel);
      expect(after.query("SELECT * FROM interaction_provider_authorities WHERE public_id=?").all(interactionId)).toEqual([]);
      expect(after.query("SELECT public_id FROM provider_interactions WHERE session_id=? AND state='pending' ORDER BY public_id")
        .all(session.id)).toEqual([
          { public_id: canonicalEarlyMigrationFixture.retained.permission.record.publicId },
          { public_id: canonicalEarlyMigrationFixture.retained.approval.record.publicId },
        ]);
      expect(after.query("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally { after.close(false); }
    expect(await stateFileSuffixesContaining(paths.database, sentinel)).toEqual([]);
  });
test("redacts and physically scrubs permission values from an observed v14 migration stage", async () => {
    const paths = await canonicalEarlyMigrationArchive(14);
    const { permission, permissionSentinel: sentinel } = canonicalEarlyMigrationFixture.retained;
    const interactionId = permission.record.publicId;
    expect(canonicalEarlyMigrationFixture.images[14].provenance.kind).toBe("uncommitted_archived_migration_stage");
    const before = new Database(paths.database, { create: false, strict: true });
    before.exec("PRAGMA query_only=ON");
    try {
      expect(before.query("PRAGMA user_version").get()).toEqual({ user_version: 14 });
      expect(before.query("SELECT display_json FROM provider_interactions WHERE public_id=?").get(interactionId))
        .toEqual({ display_json: JSON.stringify(permission.record.display) });
    } finally { before.close(false); }
    expect(await stateFileSuffixesContaining(paths.database, sentinel)).toContain("");

    const migrated = new StateStore(paths, { now: () => 20_000 });
    stores.push(migrated);
    expect(() => migrated.requireInteraction(interactionId)).toThrow("INTERACTION_PROVIDER_AUTHORITY_MISSING");
    migrated.close();
    stores.splice(stores.indexOf(migrated), 1);

    const inspector = new Database(paths.database, { readonly: true, strict: true });
    try {
      expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: 61 });
      expect(inspector.query(
        "SELECT revision,state FROM provider_interaction_transitions WHERE public_id=? ORDER BY revision",
      ).all(interactionId)).toEqual([{ revision: 1, state: "pending" }]);
      expect(inspector.query(
        "SELECT reason FROM legacy_provider_authority_quarantines WHERE scope_kind='interaction' AND scope_id=?",
      ).get(interactionId)).toEqual({ reason: "unsettled_provider_authority_unproved" });
      expect(JSON.stringify(inspector.query(
        "SELECT display_json FROM provider_interactions WHERE public_id=?",
      ).get(interactionId))).not.toContain(sentinel);
      expect(inspector.query("SELECT * FROM interaction_provider_authorities WHERE public_id=?").all(interactionId)).toEqual([]);
      expect(inspector.query("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally { inspector.close(false); }
    expect(await stateFileSuffixesContaining(paths.database, sentinel)).toEqual([]);
  });
for (const targetVersion of [11, 12, 13] as const) {
    test(`physically scrubs retained note bytes from observed v${targetVersion} stage without changing queue FIFO`, async () => {
      const paths = await canonicalEarlyMigrationArchive(targetVersion);
      const { mcp, session, queue, staleNoteSentinel: sentinel } = canonicalEarlyMigrationFixture.retained;
      expect(canonicalEarlyMigrationFixture.images[targetVersion].provenance).toMatchObject({
        kind: "uncommitted_archived_migration_stage",
        oldNoteSentinelPresent: true,
        oldNoteSentinelIsNotMcpErasureProvenance: true,
      });
      // The unchanged archived writer cleared this note through its public API.
      // These bytes prove a physical scrub, not the provenance of erased MCP bytes.
      // All three queue rows were genuinely inserted; no deleted-row hole is claimed.
      const inspector = new Database(paths.database, { create: false, strict: true });
      inspector.exec("PRAGMA query_only=ON");
      try {
        expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: targetVersion });
        expect(JSON.stringify(inspector.query("SELECT note FROM sessions").all())).not.toContain(sentinel);
        expect(inspector.query("SELECT id FROM queue_entries ORDER BY rowid").all())
          .toEqual(queue.map(({ id }) => ({ id })));
        const originalQueue = canonicalAuthBudgetRows(inspector, ["queue_entries"]);
        expect(await stateFileSuffixesContaining(paths.database, sentinel)).toEqual([""]);

        const migrated = new StateStore(paths, { now: () => 20_000 });
        stores.push(migrated);
        expect(migrated.listQueue(session.id).map(({ id }) => id)).toEqual(queue.map(({ id }) => id));
        expect(migrated.listQueue(session.id).map(({ state }) => state)).toEqual(["pending", "pending", "pending"]);
        expect(migrated.listQueue(session.id).map(({ message }) => message)).toEqual(["first", "third", "fourth"]);
        expect(migrated.hasUnsettledQueueAttachmentQuarantineForSession(session.id)).toBe(true);
        expect(migrated.nextPendingQueue(session.id)).toBeNull();
        expect(migrated.listRecoverableQueue()).toEqual(migrated.listQueue(session.id));
        migrated.close();
        stores.splice(stores.indexOf(migrated), 1);

        expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: 61 });
        expect(originalQueue.read()).toEqual(originalQueue.before);
        expect(inspector.query("SELECT enqueue_sequence FROM queue_entries ORDER BY enqueue_sequence").all())
          .toEqual([{ enqueue_sequence: 1 }, { enqueue_sequence: 2 }, { enqueue_sequence: 3 }]);
        expect(inspector.query("SELECT reason,required_at FROM security_scrub_authority WHERE singleton=1").get()).toBeNull();
        expect(inspector.query("SELECT * FROM queue_attachment_identities").all()).toEqual([]);
        expect(inspector.query("SELECT id FROM queue_entries WHERE enqueue_identity_format IS NOT NULL OR enqueue_identity_attempt_id IS NOT NULL").all()).toEqual([]);
        expect(inspector.query(
          "SELECT revision,state FROM provider_interaction_transitions WHERE public_id=? ORDER BY revision",
        ).all(mcp.record.publicId)).toEqual([{ revision: 1, state: "pending" }, { revision: 2, state: "resolution_unknown" }]);
        expect(inspector.query("PRAGMA foreign_key_check").all()).toEqual([]);
        const snapshot = canonicalAuthBudgetSnapshot(inspector);
        for (const readonly of [false, true]) {
          const reopened = new StateStore(paths, { readonly, now: () => 21_000 });
          try {
            expect(reopened.nextPendingQueue(session.id)).toBeNull();
            expect(canonicalAuthBudgetSnapshot(inspector)).toEqual(snapshot);
          } finally { reopened.close(); }
        }
      } finally { inspector.close(false); }
      expect(await stateFileSuffixesContaining(paths.database, sentinel)).toEqual([]);
    });
  }
test("keeps an exact v10 busy-reader MCP scrub unavailable until WAL truncation can finish", async () => {
    const paths = await canonicalEarlyMigrationArchive(10);
    const { mcp, mcpSentinel: sentinel } = canonicalEarlyMigrationFixture.retained;
    const interactionId = mcp.record.publicId;
    // Query-only permits WAL sidecar setup but forbids database writes. Keep
    // this genuine read snapshot open across the migration and checkpoint.
    const pinnedReader = new Database(paths.database, { create: false, strict: true });
    pinnedReader.exec("PRAGMA query_only=ON; BEGIN");
    expect(pinnedReader.query("SELECT display_json FROM provider_interactions WHERE public_id=?").get(interactionId))
      .toEqual({ display_json: JSON.stringify(mcp.record.display) });
    try {
      // The real current migration runs against the untouched v10 writer image.
      // A reader pins its original secret-bearing page across the committed migration.
      expect(() => {
        const unexpectedlyOpened = new StateStore(paths, {
          now: () => 20_000,
          securityScrubCheckpoint: shortScrubCheckpoint,
        });
        unexpectedlyOpened.close();
      }).toThrow("STATE_SECURITY_SCRUB_REQUIRED");
      const inspector = new Database(paths.database, { readonly: true, strict: true });
      try {
        expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: 61 });
        expect(inspector.query(
          "SELECT reason,required_at FROM security_scrub_authority WHERE singleton=1",
        ).get()).toEqual({ reason: "mcp_url_redaction", required_at: 20_000 });
        expect(inspector.query(
          "SELECT revision,state FROM provider_interaction_transitions WHERE public_id=? ORDER BY revision",
        ).all(interactionId)).toEqual([{ revision: 1, state: "pending" }, { revision: 2, state: "resolution_unknown" }]);
      } finally { inspector.close(false); }
      expect(pinnedReader.query("SELECT display_json FROM provider_interactions WHERE public_id=?").get(interactionId))
        .toEqual({ display_json: JSON.stringify(mcp.record.display) });
      expect(() => new StateStore(paths, { readonly: true })).toThrow("STATE_SECURITY_SCRUB_REQUIRED");
      expect(await stateFileSuffixesContaining(paths.database, sentinel)).not.toEqual([]);
    } finally {
      expect(pinnedReader.query("SELECT total_changes() AS changes").get()).toEqual({ changes: 0 });
      pinnedReader.exec("COMMIT");
      pinnedReader.close(false);
    }

    const recovered = new StateStore(paths, { now: () => 21_000 });
    stores.push(recovered);
    expect(() => recovered.requireInteraction(interactionId)).toThrow("INTERACTION_PROVIDER_AUTHORITY_MISSING");
    recovered.close();
    stores.splice(stores.indexOf(recovered), 1);
    const inspector = new Database(paths.database, { readonly: true, strict: true });
    try {
      expect(inspector.query("SELECT reason,required_at FROM security_scrub_authority WHERE singleton=1").get()).toBeNull();
      expect(inspector.query(
        "SELECT revision,state FROM provider_interaction_transitions WHERE public_id=? ORDER BY revision",
      ).all(interactionId)).toEqual([{ revision: 1, state: "pending" }, { revision: 2, state: "resolution_unknown" }]);
      expect(inspector.query(
        "SELECT reason FROM legacy_provider_authority_quarantines WHERE scope_kind='interaction' AND scope_id=?",
      ).get(interactionId)).toEqual({ reason: "unknown_provider_method" });
    } finally { inspector.close(false); }
    expect(await stateFileSuffixesContaining(paths.database, sentinel)).toEqual([]);
  }, 20_000);
test("transactionally rebuilds v30 autorespond evidence and preserves rows across reopen", async () => {
    const paths = await canonical30AutorespondArchive();
    const sessionId = canonical30WorkFixture.sessionId;
    const legacy = new Database(paths.database, { create: false, strict: true });
    expect(legacy.query("PRAGMA user_version").get()).toEqual({ user_version: 30 });
    expect(legacy.query("SELECT * FROM autorespond_evidence ORDER BY id").all())
      .toEqual([...canonical30WorkFixture.evidence]);
    legacy.close(false);
    const expectedEvidence = canonical30WorkFixture.evidence.map((row) => ({
      approvalClass: row.class,
      decision: row.decision,
      interactionId: row.interaction_id,
      kind: row.kind,
      latencyMs: row.latency_ms,
      mode: row.mode,
      model: null,
      occurredAt: row.occurred_at,
      outcome: row.outcome,
      path: "protocol" as const,
      rule: null,
      sessionId: row.session_id,
      subagent: Boolean(row.subagent),
    }));
    const migrated = new StateStore(paths, { now: () => 2_000 });
    stores.push(migrated);
    expect(migrated.listAutorespondEvidence({ sessionId })).toEqual(expectedEvidence);
    migrated.close();
    stores.splice(stores.indexOf(migrated), 1);
    const inspector = new Database(paths.database, { readonly: true, strict: true });
    try {
      expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: 61 });
      expect(inspector.query("SELECT * FROM autorespond_evidence ORDER BY id").all())
        .toEqual(canonical30WorkFixture.evidence.map((row) => ({ ...row, path: "protocol", rule: null, model: null })));
      const beforeReopen = canonicalAuthBudgetSnapshot(inspector);
      for (const readonly of [false, true]) {
        const reopened = new StateStore(paths, { readonly, now: () => 3_000 });
        try {
          expect(reopened.listAutorespondEvidence({ sessionId })).toEqual(expectedEvidence);
          expect(canonicalAuthBudgetSnapshot(inspector)).toEqual(beforeReopen);
        } finally { reopened.close(); }
      }
    } finally {
      inspector.close(false);
    }
  });
test("rolls back the v31 rebuild when an intermediate schema statement fails", async () => {
    const paths = await canonical30AutorespondArchive();
    const legacy = new Database(paths.database, { create: false, strict: true });
    expect(legacy.query("PRAGMA user_version").get()).toEqual({ user_version: 30 });
    expect(legacy.query("SELECT * FROM autorespond_evidence ORDER BY id").all())
      .toEqual([...canonical30WorkFixture.evidence]);
    // This one collision is adversarial input on a real archived30 image,
    // not a current database with removed authority and a historical stamp.
    legacy.query("CREATE TABLE autorespond_evidence_next (blocked TEXT) STRICT").run();
    const before = canonicalAuthBudgetSnapshot(legacy);
    legacy.close(false);

    expect(() => new StateStore(paths, { now: () => 2_000 })).toThrow();
    const inspector = new Database(paths.database, { readonly: true, strict: true });
    try {
      expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: 30 });
      expect(inspector.query("SELECT version FROM migrations WHERE version=31").get()).toBeNull();
      expect(canonicalAuthBudgetSnapshot(inspector)).toEqual(before);
      expect(inspector.query("SELECT * FROM autorespond_evidence ORDER BY id").all())
        .toEqual([...canonical30WorkFixture.evidence]);
      expect(inspector.query("PRAGMA table_info(autorespond_evidence)").all())
        .not.toContainEqual(expect.objectContaining({ name: "path" }));
    } finally {
      inspector.close(false);
    }
  });
test("opens and transactionally migrates a real v1 database without losing sessions", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "hra-store-v1-")));
    const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
    await initializeStatePaths(paths);
    const legacy = new Database(paths.database, { create: true, strict: true });
    legacy.exec(`
      CREATE TABLE migrations (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL CHECK(applied_at >= 0)
      ) STRICT;
      INSERT INTO migrations(version, applied_at) VALUES (1, 1000);
      CREATE TABLE profiles (
        id TEXT PRIMARY KEY CHECK(id GLOB 'acct_[0-9a-f]*' AND length(id) = 37),
        label TEXT NOT NULL CHECK(length(label) BETWEEN 1 AND 160),
        state TEXT NOT NULL CHECK(state IN ('signed_out','login_pending','signed_in','recovery_required','removed')),
        process_generation INTEGER NOT NULL CHECK(process_generation >= 0),
        provider_email TEXT,
        provider_plan TEXT,
        created_at INTEGER NOT NULL CHECK(created_at >= 0),
        updated_at INTEGER NOT NULL CHECK(updated_at >= created_at)
      ) STRICT;
      CREATE TABLE projects (
        id TEXT PRIMARY KEY CHECK(id GLOB 'proj_[0-9a-f]*' AND length(id) = 37),
        label TEXT NOT NULL CHECK(length(label) BETWEEN 1 AND 160),
        root_path TEXT NOT NULL UNIQUE,
        is_default INTEGER NOT NULL CHECK(is_default IN (0,1)),
        created_at INTEGER NOT NULL CHECK(created_at >= 0),
        updated_at INTEGER NOT NULL CHECK(updated_at >= created_at)
      ) STRICT;
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY CHECK(id GLOB 'sess_[0-9a-f]*' AND length(id) = 37),
        profile_id TEXT NOT NULL REFERENCES profiles(id),
        project_id TEXT REFERENCES projects(id),
        provider_thread_id TEXT,
        title TEXT NOT NULL CHECK(length(title) <= 320),
        note TEXT NOT NULL DEFAULT '' CHECK(length(CAST(note AS BLOB)) <= 16384),
        preset TEXT NOT NULL CHECK(preset IN ('low','high','ultra')),
        fast_enabled INTEGER NOT NULL CHECK(fast_enabled IN (0,1)),
        state TEXT NOT NULL CHECK(state IN ('starting','active','idle','terminal','recovery_required')),
        active_turn_id TEXT,
        revision INTEGER NOT NULL CHECK(revision > 0),
        created_at INTEGER NOT NULL CHECK(created_at >= 0),
        updated_at INTEGER NOT NULL CHECK(updated_at >= created_at),
        UNIQUE(profile_id, provider_thread_id)
      ) STRICT;
      INSERT INTO profiles(id,label,state,process_generation,created_at,updated_at)
        VALUES ('acct_00000000000000000000000000000000','Legacy','signed_in',3,1000,1000);
      INSERT INTO sessions(id,profile_id,title,note,preset,fast_enabled,state,revision,created_at,updated_at)
        VALUES ('sess_00000000000000000000000000000000','acct_00000000000000000000000000000000','Preserved','','high',0,'idle',1,1000,1000);
      DROP TRIGGER IF EXISTS mutation_resolutions_timestamp_proof_insert; DROP TRIGGER IF EXISTS sessions_autorespond_after_hours_history; DROP TABLE IF EXISTS autorespond_after_hours_history; DROP TABLE IF EXISTS autorespond_after_hours_policy; DROP TABLE IF EXISTS account_mutation_authority_rebinds; DROP TRIGGER IF EXISTS sessions_autorespond_budget_history; DROP TABLE IF EXISTS autorespond_budget_history; DROP TABLE IF EXISTS autorespond_budget_reservations; PRAGMA user_version = 1;
    `);
    legacy.close(false);
    await chmod(paths.database, 0o600);

    const store = new StateStore(paths, { now: () => 2000 });
    stores.push(store);
    const preserved = store.requireSession("sess_00000000000000000000000000000000");
    expect(preserved).toMatchObject({
      title: "Preserved",
      revision: 2,
      state: "recovery_required",
    });
    expect("providerUpdatedAt" in preserved).toBe(false);
    const inspector = new Database(paths.database, { readonly: true, strict: true });
    try {
      expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: 61 });
      expect(inspector.query("SELECT version, applied_at FROM migrations ORDER BY version").all()).toEqual([
        { version: 1, applied_at: 1000 },
        { version: 2, applied_at: 2000 },
        { version: 3, applied_at: 2000 },
        { version: 4, applied_at: 2000 },
        { version: 5, applied_at: 2000 },
        { version: 6, applied_at: 2000 },
        { version: 7, applied_at: 2000 },
        { version: 8, applied_at: 2000 },
        { version: 9, applied_at: 2000 },
        { version: 10, applied_at: 2000 },
        { version: 11, applied_at: 2000 },
        { version: 12, applied_at: 2000 },
        { version: 13, applied_at: 2000 },
        { version: 14, applied_at: 2000 },
        { version: 15, applied_at: 2000 },
        { version: 16, applied_at: 2000 },
        { version: 17, applied_at: 2000 },
        { version: 18, applied_at: 2000 },
        { version: 19, applied_at: 2000 },
        { version: 20, applied_at: 2000 },
        { version: 21, applied_at: 2000 },
        { version: 22, applied_at: 2000 },
        { version: 23, applied_at: 2000 },
        { version: 24, applied_at: 2000 },
        { version: 25, applied_at: 2000 },
        { version: 26, applied_at: 2000 },
        { version: 27, applied_at: 2000 },
        { version: 28, applied_at: 2000 },
        { version: 29, applied_at: 2000 },
        { version: 30, applied_at: 2000 },
        { version: 31, applied_at: 2000 },
        { version: 32, applied_at: 2000 },
        { version: 33, applied_at: 2000 },
        { version: 34, applied_at: 2000 },
        { version: 35, applied_at: 2000 },
        { version: 36, applied_at: 2000 },
        { version: 37, applied_at: 2000 },
        { version: 38, applied_at: 2000 },
        { version: 39, applied_at: 2000 },
        { version: 40, applied_at: 2000 },
        { version: 41, applied_at: 2000 },
        { version: 42, applied_at: 2000 },
        { version: 43, applied_at: 2000 },
        { version: 44, applied_at: 2000 },
        { version: 45, applied_at: 2000 },
        { version: 46, applied_at: 2000 },
        { version: 47, applied_at: 2000 },
        { version: 48, applied_at: 2000 },
        { version: 49, applied_at: 2000 },
        ...Array.from({ length: 12 }, (_, index) => ({ version: index + 50, applied_at: 2000 })),
      ]);
      expect(inspector.query("PRAGMA table_info(sessions)").all()).toContainEqual(expect.objectContaining({ name: "provider_updated_at" }));
      expect(inspector.query("SELECT label,label_key FROM profiles").get()).toEqual({
        label: "Legacy",
        label_key: "legacy",
      });
    } finally {
      inspector.close(false);
    }
  });
test("upgrades a synthetically populated archived v2 migration stage without losing authority data", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "oompa-store-observed2-")));
    const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
    await initializeStatePaths(paths);
    const bytes = observed2DatabaseBytes();
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(observed2Fixture.databaseSha256);
    await writeFile(paths.database, bytes, { mode: 0o600, flag: "wx" });
    expect(observed2Fixture.provenance).toMatchObject({
      kind: "uncommitted_archived_migration_stage",
      releasedWriterImage: false,
      observerRowOrSchemaWrites: false,
      originalProfilesAndSessionsEmpty: true,
    });
    const profileId = "acct_22222222222222222222222222222222";
    const sessionId = "sess_22222222222222222222222222222222";
    const inspector = new Database(paths.database, { create: false, strict: true });
    try {
      inspector.exec("PRAGMA foreign_keys=ON");
      const empty = canonicalAuthBudgetSnapshot(inspector);
      expect(empty.version).toEqual({ user_version: 2 });
      expect(empty.rows.profiles).toEqual([]);
      expect(empty.rows.sessions).toEqual([]);
      expect(createHash("sha256").update(JSON.stringify(empty.schema)).digest("hex")).toBe(observed2Fixture.snapshot.schemaSha256);
      expect(inspector.query("SELECT * FROM migrations ORDER BY version").all()).toEqual([...observed2Fixture.snapshot.ledger]);
      // These two rows are explicitly synthetic test inputs under the captured
      // original constraints, not claimed to be emitted by an archived writer.
      inspector.transaction(() => {
        inspector.query("INSERT INTO profiles(id,label,state,process_generation,provider_email,provider_plan,created_at,updated_at) VALUES (?,?,'signed_in',1,?,'Plus',10001,10001)")
          .run(profileId, "V2 profile", "v2@example.com");
        inspector.query("INSERT INTO sessions(id,profile_id,title,preset,fast_enabled,state,revision,created_at,updated_at) VALUES (?,?,'V2 retained','high',0,'starting',1,10001,10001)")
          .run(sessionId, profileId);
      }).immediate();
      const populated = canonicalAuthBudgetSnapshot(inspector);
      expect(populated.schema).toEqual(empty.schema);
      expect(populated.version).toEqual(empty.version);
      for (const [table, rows] of Object.entries(empty.rows)) {
        if (table !== "profiles" && table !== "sessions") expect(populated.rows[table]).toEqual(rows);
      }
      expect(inspector.query("PRAGMA foreign_key_check").all()).toEqual([]);
      const originalProfile = canonicalAuthBudgetRows(inspector, ["profiles"]);
      expect(() => { new StateStore(paths, { readonly: true }).close(); }).toThrow("STATE_SCHEMA_MIGRATION_REQUIRED:2:61");
      expect(canonicalAuthBudgetSnapshot(inspector)).toEqual(populated);

      const migrated = new StateStore(paths, { now: () => 90_000, resolveMachineTimeZone: () => "UTC" });
      stores.push(migrated);
      expect(originalProfile.read()).toEqual(originalProfile.before);
      expect(migrated.requireProfile(profileId)).toMatchObject({
        id: profileId, label: "V2 profile", providerEmail: "v2@example.com", processGeneration: 1,
      });
      expect(migrated.requireSession(sessionId)).toMatchObject({
        id: sessionId, profileId, title: "V2 retained", preset: "high", state: "recovery_required", revision: 2,
      });
      expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: 61 });
      expect(inspector.query("SELECT * FROM migrations WHERE version<=2 ORDER BY version").all()).toEqual([...observed2Fixture.snapshot.ledger]);
      expect(inspector.query("SELECT applied_at FROM migrations WHERE version=3").get()).toEqual({ applied_at: 90_000 });
      expect(inspector.query("SELECT * FROM desktop_switch_authority").get()).toEqual({
        singleton: 1, current_generation: 0, current_attempt_id: null, released_generation: 0,
      });
      expect(inspector.query("PRAGMA foreign_key_check").all()).toEqual([]);
      const joined = canonicalAuthBudgetSnapshot(inspector);
      for (const readonly of [false, true]) {
        const reopened = new StateStore(paths, { readonly, now: () => 90_001, resolveMachineTimeZone: () => "UTC" });
        try { expect(reopened.requireSession(sessionId).title).toBe("V2 retained"); }
        finally { reopened.close(); }
        expect(canonicalAuthBudgetSnapshot(inspector)).toEqual(joined);
      }
    } finally { inspector.close(false); }
  });
test("binds immutable host capabilities and keeps project memory authority content-free", async () => {
    const { store, home } = await fixture();
    const root = join(home, "memory-project");
    await mkdir(root);
    const project = await store.createProject("Memory project", root);
    const profile = signInProfile(store, "Memory account", "memory@example.com");
    const session = store.createSession({
      profileId: profile.id,
      projectId: project.id,
      preset: "high",
      fastEnabled: false,
    });

    expect(store.requirePeerSessionPolicy(session.id)).toMatchObject({
      mode: "coordinate",
      revision: 1,
    });
    expect(store.setPeerSessionPolicy({
      sessionId: session.id,
      expectedRevision: 1,
      mode: "inspect",
    })).toMatchObject({ mode: "inspect", revision: 2 });
    expect(() => store.setPeerSessionPolicy({
      sessionId: session.id,
      expectedRevision: 1,
      mode: "off",
    })).toThrow("PEER_SESSION_POLICY_REVISION_CONFLICT");

    expect(() => store.bindSessionHostCapabilities({
      sessionId: session.id,
      preambleVersion: 1,
      preambleDigest: "a".repeat(64),
      manifestVersion: 1,
      manifestDigest: "b".repeat(64),
    })).toThrow("SESSION_HOST_CAPABILITY_ADOPTION_MID_TURN");
    const idleSession = store.bindSession({
      sessionId: session.id,
      expectedRevision: session.revision,
      providerThreadId: "thread-capability-idle",
      state: "idle",
    });
    const capability = store.bindSessionHostCapabilities({
      sessionId: idleSession.id,
      preambleVersion: 1,
      preambleDigest: "a".repeat(64),
      manifestVersion: 1,
      manifestDigest: "b".repeat(64),
    });
    expect(store.bindSessionHostCapabilities({
      sessionId: session.id,
      preambleVersion: 1,
      preambleDigest: "a".repeat(64),
      manifestVersion: 1,
      manifestDigest: "b".repeat(64),
    })).toEqual(capability);
    expect(() => store.bindSessionHostCapabilities({
      sessionId: session.id,
      preambleVersion: 2,
      preambleDigest: "a".repeat(64),
      manifestVersion: 1,
      manifestDigest: "b".repeat(64),
    })).toThrow("SESSION_HOST_CAPABILITY_BINDING_CONFLICT");
    const active = createAuthorizedStartingTestSession(store, {
      profileId: profile.id,
      projectId: project.id,
      preset: "high",
      fastEnabled: false,
    });
    store.setSessionTurnState({
      sessionId: active.id,
      expectedRevision: active.revision,
      state: "active",
      activeTurnId: "turn-mid-adoption",
    });
    expect(() => store.bindSessionHostCapabilities({
      sessionId: active.id,
      preambleVersion: 1,
      preambleDigest: "a".repeat(64),
      manifestVersion: 1,
      manifestDigest: "b".repeat(64),
    })).toThrow("SESSION_HOST_CAPABILITY_ADOPTION_MID_TURN");

    const emptyHead = PROJECT_MEMORY_EMPTY_HEAD;
    const invalidIdentity = createPortableProjectMemoryCanonicalIdentity(project.id);
    expect(() => store.reserveProjectMemoryAuthority({
      canonicalSpaceId: invalidIdentity.canonicalSpaceId,
      head: { ...emptyHead, headDigest: "c".repeat(64) },
      identityContract: invalidIdentity.identityContract,
      projectId: project.id,
    })).toThrow("PROJECT_MEMORY_AUTHORITY_RESERVATION_INVALID");
    expect(store.readProjectMemoryAuthority(project.id)).toBeNull();
    const identity = createPortableProjectMemoryCanonicalIdentity(project.id);
    const reserved = store.reserveProjectMemoryAuthority({
      canonicalSpaceId: identity.canonicalSpaceId,
      head: emptyHead,
      identityContract: identity.identityContract,
      projectId: project.id,
    });
    expect(reserved).toMatchObject({
      physicalState: "reserved",
      revision: 1,
    });
    expect(reserved.initializedAt).toBeUndefined();
    expect(() => store.compareAndSwapProjectMemoryHead({
      projectId: project.id,
      expectedRevision: reserved.revision,
      expectedHead: emptyHead,
      nextHead: {
        sequence: 1,
        operationSha256: "e".repeat(64),
        headDigest: "2".repeat(64),
      },
    })).toThrow("PROJECT_MEMORY_AUTHORITY_NOT_INITIALIZED");
    const initialized = store.markProjectMemoryAuthorityInitialized({
      expectedHead: reserved.head,
      expectedRevision: reserved.revision,
      projectId: project.id,
    });
    expect(initialized).toMatchObject({
      initializedAt: expect.any(Number),
      physicalState: "initialized",
      revision: 2,
    });
    expect(store.markProjectMemoryAuthorityInitialized({
      expectedHead: reserved.head,
      expectedRevision: reserved.revision,
      projectId: project.id,
    })).toEqual(initialized);
    const losingIdentity = createPortableProjectMemoryCanonicalIdentity(project.id);
    expect(store.reserveProjectMemoryAuthority({
      canonicalSpaceId: losingIdentity.canonicalSpaceId,
      head: emptyHead,
      identityContract: losingIdentity.identityContract,
      projectId: project.id,
    })).toEqual(initialized);
    const nextHead = {
      sequence: 1,
      operationSha256: "f".repeat(64),
      headDigest: "1".repeat(64),
    } as const;
    const advanced = store.compareAndSwapProjectMemoryHead({
      projectId: project.id,
      expectedRevision: initialized.revision,
      expectedHead: emptyHead,
      nextHead,
    });
    expect(advanced).toMatchObject({ head: nextHead, revision: 3, syncState: "local_only" });
    const settled = store.recordProjectMemorySyncObservation({
      projectId: project.id,
      expectedRevision: advanced.revision,
      expectedHead: nextHead,
      state: "settled",
      exchangeHead: nextHead,
    });
    expect(settled).toMatchObject({
      revision: 4,
      syncState: "settled",
      lastExchangeHead: nextHead,
    });

    const memoryRequestDigest = testDigest("memory request");
    const memoryContentDigest = testDigest("PRIVATE MEMORY CONTENT");
    const memoryKeyDigest = testDigest("private:key");
    const memoryWorkingBindingDigest = testDigest("private working binding");
    const memoryRecordDigest = testDigest("private memory record");
    const memoryAttestationDigest = testDigest("private memory attestation");
    const workingRemember = store.prepareMemorySubmission({
      actorSessionId: session.id,
      projectId: project.id,
      kind: "remember",
      requestDigest: memoryRequestDigest,
      contentDigest: memoryContentDigest,
      keyDigest: memoryKeyDigest,
      workingBindingDigest: memoryWorkingBindingDigest,
      workingEpoch: 1,
      expectedHead: emptyHead,
      idempotencyKey: peerIdempotencyKey(7_999),
    }).record;
    store.bindMemorySubmissionEffect({
      submissionId: workingRemember.id,
      effectRecordSha256: memoryRecordDigest,
      attestationSha256: memoryAttestationDigest,
      operationId: "memory_remember_private",
    });
    store.beginMemorySubmission(workingRemember.id);
    store.settleMemorySubmission({
      submissionId: workingRemember.id,
      expectedState: "effect_started",
      state: "applied",
      outcomeCode: "remember_committed",
      resultHead: nextHead,
      receiptDigest: testDigest("private remember receipt"),
    });

    const prepared = store.prepareMemorySubmission({
      actorSessionId: session.id,
      projectId: project.id,
      kind: "share",
      requestDigest: memoryRequestDigest,
      contentDigest: memoryContentDigest,
      keyDigest: memoryKeyDigest,
      workingBindingDigest: memoryWorkingBindingDigest,
      workingEpoch: 1,
      expectedHead: nextHead,
      idempotencyKey: peerIdempotencyKey(8_000),
    });
    expect(store.prepareMemorySubmission({
      actorSessionId: session.id,
      projectId: project.id,
      kind: "share",
      requestDigest: memoryRequestDigest,
      contentDigest: memoryContentDigest,
      keyDigest: memoryKeyDigest,
      workingBindingDigest: memoryWorkingBindingDigest,
      workingEpoch: 1,
      expectedHead: nextHead,
      idempotencyKey: peerIdempotencyKey(8_000),
    })).toMatchObject({ replay: true, record: { id: prepared.record.id } });
    const invariantWriter = new Database(store.paths.database, { create: false, strict: true });
    invariantWriter.exec("PRAGMA foreign_keys=ON");
    expect(() => invariantWriter.query(
      `UPDATE memory_submissions
       SET result_head_operation_sha256=? WHERE id=?`,
    ).run("9".repeat(64), prepared.record.id)).toThrow();
    expect(() => invariantWriter.query(
      `UPDATE project_memory_authorities
       SET head_sequence=0,head_operation_sha256=NULL,head_digest=?,revision=revision+1
       WHERE project_id=?`,
    ).run(emptyHead.headDigest, project.id)).toThrow();
    expect(() => invariantWriter.query(
      "DELETE FROM session_host_capability_bindings WHERE session_id=?",
    ).run(idleSession.id)).toThrow();
    invariantWriter.close(false);
    store.bindMemorySubmissionEffect({
      submissionId: prepared.record.id,
      effectRecordSha256: memoryRecordDigest,
      attestationSha256: memoryAttestationDigest,
      operationId: "memory_adopt_private",
      sourceHead: nextHead,
      nominationSha256: testDigest("private memory nomination"),
    });
    store.beginMemorySubmission(prepared.record.id);
    const resultHead = {
      sequence: 2,
      operationSha256: "2".repeat(64),
      headDigest: "3".repeat(64),
    } as const;
    expect(store.settleMemorySubmission({
      submissionId: prepared.record.id,
      expectedState: "effect_started",
      state: "applied",
      outcomeCode: "share_adopted",
      resultHead,
      receiptDigest: "4".repeat(64),
    })).toMatchObject({ state: "applied", resultHead });
    expect(store.readProjectMemoryAuthority(project.id)).toMatchObject({
      head: resultHead,
      lastExchangeHead: nextHead,
      syncState: "local_only",
    });

    const inspector = new Database(store.paths.database, { readonly: true, strict: true });
    try {
      const retained = JSON.stringify({
        authority: inspector.query("SELECT * FROM project_memory_authorities").get(),
        capability: inspector.query("SELECT * FROM session_host_capability_bindings").get(),
        submission: inspector.query("SELECT * FROM memory_submissions").get(),
      });
      expect(retained).not.toContain("PRIVATE MEMORY CONTENT");
      expect(retained).not.toContain("private:key");
      expect(retained).not.toContain(root);
    } finally {
      inspector.close(false);
    }

    const currentAuthority = store.readProjectMemoryAuthority(project.id);
    if (currentAuthority === null) throw new Error("Expected project memory authority.");
    const frozen = store.recordProjectMemorySyncObservation({
      projectId: project.id,
      expectedRevision: currentAuthority.revision,
      expectedHead: currentAuthority.head,
      state: "error",
      diagnosticCode: "MEMORY_CANONICAL_DIVERGED",
    });
    expect(() => store.recordProjectMemorySyncObservation({
      projectId: project.id,
      expectedRevision: frozen.revision,
      expectedHead: frozen.head,
      state: "local_only",
    })).toThrow("PROJECT_MEMORY_SYNC_FROZEN");
    const thawWriter = new Database(store.paths.database, { create: false, strict: true });
    thawWriter.exec("PRAGMA foreign_keys=ON");
    expect(() => thawWriter.query(
      `UPDATE project_memory_authorities
       SET sync_state='local_only',diagnostic_code=NULL,revision=revision+1
       WHERE project_id=?`,
    ).run(project.id)).toThrow();
    thawWriter.close(false);
  });
test("journals hosted canonical create through crash recovery and exact replay", async () => {
    let now = 20_000;
    const { store, home } = await fixture({ now: () => now++ });
    const root = join(home, "hosted-memory-create-journal");
    await mkdir(root);
    const project = await store.createProject("Hosted memory create journal", root);
    const authority = reserveTestProjectMemoryAuthority(
      store,
      project.id,
      PROJECT_MEMORY_EMPTY_HEAD,
    );
    const accountBindingDigest = testDigest("hosted create account binding");
    const remoteSpaceId = `memory_${"c".repeat(32)}`;
    const idempotencyKey = peerIdempotencyKey(87_501);
    const allocated = store.allocateCanonicalMemoryHostedCreate({
      accountBindingDigest,
      idempotencyKey,
      projectId: project.id,
      remoteSpaceId,
    });
    expect(allocated).toMatchObject({
      replay: false,
      record: {
        accountBindingDigest,
        authorityHead: authority.head,
        authorityRevision: authority.revision,
        canonicalBindingDigest: authority.bindingDigest,
        projectId: project.id,
        remoteSpaceId,
        state: "allocating",
      },
    });
    expect(store.isCanonicalMemoryMutationFenced(project.id)).toBe(true);
    expect(store.allocateCanonicalMemoryHostedCreate({
      accountBindingDigest,
      idempotencyKey,
      projectId: project.id,
      remoteSpaceId,
    })).toMatchObject({ replay: true, record: { id: allocated.record.id } });
    expect(() => store.allocateCanonicalMemoryHostedCreate({
      accountBindingDigest: testDigest("different hosted create account"),
      idempotencyKey,
      projectId: project.id,
      remoteSpaceId,
    })).toThrow("CANONICAL_MEMORY_HOSTED_CREATE_IDEMPOTENCY_CONFLICT");
    expect(() => store.allocateCanonicalMemoryHostedCreate({
      accountBindingDigest,
      idempotencyKey: peerIdempotencyKey(87_502),
      projectId: project.id,
      remoteSpaceId,
    })).toThrow("CANONICAL_MEMORY_HOSTED_CREATE_RECOVERY_REQUIRED");
    const unreconciledGenesisToken = testDigest("unjournaled create genesis");
    expect(() => store.attachCanonicalMemoryHostedSpace({
      accountBindingDigest,
      canonicalSpaceId: authority.canonicalSpaceId,
      projectId: project.id,
      remote: {
        genesisToken: unreconciledGenesisToken,
        head: PROJECT_MEMORY_EMPTY_HEAD,
        headProofDigest: testDigest("unreconciled create proof"),
        headToken: unreconciledGenesisToken,
        keyVersion: 7,
        revision: 1,
      },
      remoteSpaceId,
    })).toThrow("CANONICAL_MEMORY_HOSTED_CREATE_RECOVERY_REQUIRED");
    expect(() => store.compareAndSwapProjectMemoryHead({
      expectedHead: authority.head,
      expectedRevision: authority.revision,
      nextHead: {
        sequence: 1,
        operationSha256: testDigest("create fenced operation"),
        headDigest: testDigest("create fenced head"),
      },
      projectId: project.id,
    })).toThrow("canonical memory mutation fenced by hosted create");

    const request = testCanonicalMemoryHostedCreateRequest(remoteSpaceId);
    expect(store.stageCanonicalMemoryHostedCreateKey({
      intentId: allocated.record.id,
      keyVersion: request.keyVersion,
      wrappedSpaceKey: request.wrappedSpaceKey,
    })).toMatchObject({
      keyVersion: request.keyVersion,
      state: "key_staged",
      wrappedSpaceKey: request.wrappedSpaceKey,
    });
    expect(store.stageCanonicalMemoryHostedCreateKey({
      intentId: allocated.record.id,
      keyVersion: request.keyVersion,
      wrappedSpaceKey: request.wrappedSpaceKey,
    })).toMatchObject({ state: "key_staged" });
    expect(() => store.stageCanonicalMemoryHostedCreateKey({
      intentId: allocated.record.id,
      keyVersion: request.keyVersion,
      wrappedSpaceKey: testCanonicalMemoryEnvelope("different wrapped key", 3),
    })).toThrow("CANONICAL_MEMORY_HOSTED_CREATE_KEY_CONFLICT");
    expect(store.prepareCanonicalMemoryHostedCreate({
      intentId: allocated.record.id,
      request,
    })).toMatchObject({ request, requestDigest: expect.any(String), state: "prepared" });
    expect(store.prepareCanonicalMemoryHostedCreate({
      intentId: allocated.record.id,
      request,
    })).toMatchObject({ state: "prepared" });
    expect(() => store.prepareCanonicalMemoryHostedCreate({
      intentId: allocated.record.id,
      request: {
        ...request,
        encryptedDescriptor: testCanonicalMemoryEnvelope("different descriptor", 7),
      },
    })).toThrow("CANONICAL_MEMORY_HOSTED_CREATE_REQUEST_CONFLICT");
    expect(store.markCanonicalMemoryHostedCreateEffectStarted(allocated.record.id))
      .toMatchObject({ effectStartedAt: expect.any(Number), state: "effect_started" });

    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);
    now += 1_000;
    const recovered = new StateStore(paths, { now: () => now++ });
    stores.push(recovered);
    expect(recovered.readUnresolvedCanonicalMemoryHostedCreateIntent(project.id))
      .toMatchObject({
        id: allocated.record.id,
        request,
        state: "effect_started",
      });
    const winner = { ...request, replay: false, revision: 1 } as const;
    expect(recovered.recordCanonicalMemoryHostedCreateWinner({
      intentId: allocated.record.id,
      winner,
    })).toMatchObject({
      state: "winner_observed",
      winnerReplay: false,
      winnerRevision: 1,
    });
    expect(recovered.recordCanonicalMemoryHostedCreateWinner({
      intentId: allocated.record.id,
      winner,
    })).toMatchObject({ state: "winner_observed" });
    expect(recovered.settleCanonicalMemoryHostedCreate(allocated.record.id))
      .toMatchObject({ state: "settled" });
    expect(recovered.settleCanonicalMemoryHostedCreate(allocated.record.id))
      .toMatchObject({ state: "settled" });
    expect(recovered.readCanonicalMemoryHostedAttachment(project.id)).toMatchObject({
      accountBindingDigest,
      canonicalBindingDigest: authority.bindingDigest,
      generation: 1,
      remote: {
        genesisToken: request.genesisToken,
        head: PROJECT_MEMORY_EMPTY_HEAD,
        headProofDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
        headToken: request.genesisToken,
        keyVersion: request.keyVersion,
        revision: 1,
      },
      remoteSpaceId,
      revision: 1,
      state: "attached",
    });
    expect(recovered.readUnresolvedCanonicalMemoryHostedCreateIntent(project.id)).toBeNull();
    expect(recovered.isCanonicalMemoryMutationFenced(project.id)).toBe(false);
    expect(recovered.allocateCanonicalMemoryHostedCreate({
      accountBindingDigest,
      idempotencyKey,
      projectId: project.id,
      remoteSpaceId,
    })).toMatchObject({ replay: true, record: { state: "settled" } });
    expect(recovered.stageCanonicalMemoryHostedCreateKey({
      intentId: allocated.record.id,
      keyVersion: request.keyVersion,
      wrappedSpaceKey: request.wrappedSpaceKey,
    })).toMatchObject({ state: "settled" });
    expect(recovered.prepareCanonicalMemoryHostedCreate({
      intentId: allocated.record.id,
      request,
    })).toMatchObject({ state: "settled" });
    expect(recovered.markCanonicalMemoryHostedCreateEffectStarted(allocated.record.id))
      .toMatchObject({ state: "settled" });
    const settledAuthority = recovered.readProjectMemoryAuthority(project.id);
    if (settledAuthority === null) throw new Error("Expected settled create authority.");
    const laterLocalHead = {
      sequence: 1,
      operationSha256: testDigest("post-create local operation"),
      headDigest: testDigest("post-create local head"),
    } as const;
    recovered.compareAndSwapProjectMemoryHead({
      expectedHead: settledAuthority.head,
      expectedRevision: settledAuthority.revision,
      nextHead: laterLocalHead,
      projectId: project.id,
    });
    expect(recovered.detachCanonicalMemoryHostedSpace({
      expectedGeneration: 1,
      projectId: project.id,
    })).toMatchObject({ generation: 2, state: "detached" });
    recovered.close();
    stores.splice(stores.indexOf(recovered), 1);
    const afterLifecycleAdvance = new StateStore(paths, { now: () => now++ });
    stores.push(afterLifecycleAdvance);
    expect(afterLifecycleAdvance.readCanonicalMemoryHostedCreateIntent(allocated.record.id))
      .toMatchObject({ state: "settled" });
    expect(afterLifecycleAdvance.readCanonicalMemoryHostedAttachment(project.id))
      .toMatchObject({ generation: 2, state: "detached" });
    expect(afterLifecycleAdvance.settleCanonicalMemoryHostedCreate(allocated.record.id))
      .toMatchObject({ state: "settled" });

    const inspector = new Database(paths.database, { readonly: true, strict: true });
    try {
      const persisted = inspector.query(
        "SELECT * FROM project_memory_hosted_create_intents WHERE id=?",
      ).get(allocated.record.id);
      expect(persisted).toMatchObject({
        descriptor_ciphertext: request.encryptedDescriptor.ciphertext,
        genesis_proof_ciphertext: request.genesisHeadProof.ciphertext,
        wrapped_key_ciphertext: request.wrappedSpaceKey.ciphertext,
      });
      const retained = JSON.stringify(persisted);
      expect(retained).not.toContain("PRIVATE HOSTED CREATE DESCRIPTOR");
      expect(retained).not.toContain("PRIVATE HOSTED CREATE GENESIS PROOF");
      expect(retained).not.toContain("PRIVATE HOSTED CREATE WRAPPED KEY");
      expect(retained).not.toContain(root);
    } finally {
      inspector.close(false);
    }
  });
test("keeps an uncertain hosted create fenced and freezes a proven failure", async () => {
    const { store, home } = await fixture();
    const root = join(home, "hosted-memory-create-uncertain");
    await mkdir(root);
    const project = await store.createProject("Hosted memory create uncertain", root);
    reserveTestProjectMemoryAuthority(store, project.id, PROJECT_MEMORY_EMPTY_HEAD);
    const accountBindingDigest = testDigest("uncertain hosted create account");
    const remoteSpaceId = `memory_${"d".repeat(32)}`;
    const allocated = store.allocateCanonicalMemoryHostedCreate({
      accountBindingDigest,
      idempotencyKey: peerIdempotencyKey(87_503),
      projectId: project.id,
      remoteSpaceId,
    }).record;
    const request = testCanonicalMemoryHostedCreateRequest(remoteSpaceId, 11, 5);
    store.stageCanonicalMemoryHostedCreateKey({
      intentId: allocated.id,
      keyVersion: request.keyVersion,
      wrappedSpaceKey: request.wrappedSpaceKey,
    });
    store.prepareCanonicalMemoryHostedCreate({ intentId: allocated.id, request });
    store.markCanonicalMemoryHostedCreateEffectStarted(allocated.id);
    expect(() => store.recordCanonicalMemoryHostedCreateWinner({
      intentId: allocated.id,
      winner: {
        ...request,
        encryptedDescriptor: testCanonicalMemoryEnvelope("hostile descriptor", 11),
        replay: true,
        revision: 1,
      },
    })).toThrow("CANONICAL_MEMORY_HOSTED_CREATE_WINNER_INVALID");
    expect(store.readUnresolvedCanonicalMemoryHostedCreateIntent(project.id))
      .toMatchObject({ id: allocated.id, state: "effect_started" });

    const guarded = new Database(store.paths.database, { create: false, strict: true });
    guarded.exec("PRAGMA foreign_keys=ON");
    try {
      expect(() => guarded.query(
        `UPDATE project_memory_authorities
         SET revision=revision+1 WHERE project_id=?`,
      ).run(project.id)).toThrow("canonical memory mutation fenced by hosted create");
      expect(() => guarded.query(
        "DELETE FROM project_memory_hosted_create_intents WHERE id=?",
      ).run(allocated.id)).toThrow("canonical memory hosted create intent is immutable");
    } finally {
      guarded.close(false);
    }

    expect(store.failCanonicalMemoryHostedCreate({
      diagnosticCode: "REMOTE_MEMORY_CREATE_CONFLICT",
      intentId: allocated.id,
      state: "conflict",
    })).toMatchObject({
      diagnosticCode: "REMOTE_MEMORY_CREATE_CONFLICT",
      state: "conflict",
    });
    expect(store.failCanonicalMemoryHostedCreate({
      diagnosticCode: "REMOTE_MEMORY_CREATE_CONFLICT",
      intentId: allocated.id,
      state: "conflict",
    })).toMatchObject({ state: "conflict" });
    expect(() => store.failCanonicalMemoryHostedCreate({
      diagnosticCode: "REMOTE_MEMORY_CREATE_ERROR",
      intentId: allocated.id,
      state: "error",
    })).toThrow("CANONICAL_MEMORY_HOSTED_CREATE_FAILURE_CONFLICT");
    expect(store.readUnresolvedCanonicalMemoryHostedCreateIntent(project.id)).toBeNull();
    expect(store.isCanonicalMemoryMutationFenced(project.id)).toBe(true);
    expect(store.readProjectMemoryAuthority(project.id)).toMatchObject({
      diagnosticCode: "REMOTE_MEMORY_CREATE_CONFLICT",
      syncState: "conflict",
    });
    expect(() => store.recordCanonicalMemoryHostedCreateWinner({
      intentId: allocated.id,
      winner: { ...request, replay: false, revision: 1 },
    })).toThrow("CANONICAL_MEMORY_HOSTED_CREATE_STATE_CONFLICT");
  });
test("journals hosted canonical push before effect and preserves exact replay", async () => {
    let now = 10_000;
    const { store, home } = await fixture({ now: () => now });
    const root = join(home, "hosted-memory-journal");
    await mkdir(root);
    const project = await store.createProject("Hosted memory journal", root);
    const profile = signInProfile(
      store,
      "Hosted memory journal",
      "hosted-memory-journal@example.com",
    );
    const actor = createAuthorizedStartingTestSession(store, {
      profileId: profile.id,
      projectId: project.id,
      preset: "high",
      fastEnabled: false,
    });
    const identity = createPortableProjectMemoryCanonicalIdentity(project.id);
    const genesisToken = testDigest("hosted genesis token");
    const initialRemote = {
      genesisToken,
      head: PROJECT_MEMORY_EMPTY_HEAD,
      headProofDigest: testDigest("hosted genesis proof"),
      headToken: genesisToken,
      keyVersion: 1,
      revision: 1,
    } as const;
    const attached = store.attachCanonicalMemoryHostedSpace({
      accountBindingDigest: testDigest("hosted owner account"),
      canonicalSpaceId: identity.canonicalSpaceId,
      projectId: project.id,
      remote: initialRemote,
      remoteSpaceId: `memory_${"a".repeat(32)}`,
    });
    expect(attached).toMatchObject({ generation: 1, revision: 1, state: "attached" });
    const reserved = store.readProjectMemoryAuthority(project.id);
    if (reserved === null) throw new Error("Expected hosted attach to reserve memory authority.");
    expect(reserved).toMatchObject({
      canonicalSpaceId: identity.canonicalSpaceId,
      physicalState: "reserved",
    });
    const initialized = store.markProjectMemoryAuthorityInitialized({
      expectedHead: reserved.head,
      expectedRevision: reserved.revision,
      projectId: project.id,
    });
    const localHead = {
      sequence: 1,
      operationSha256: testDigest("hosted local operation"),
      headDigest: testDigest("hosted local head"),
    } as const;
    const advanced = store.compareAndSwapProjectMemoryHead({
      expectedHead: initialized.head,
      expectedRevision: initialized.revision,
      nextHead: localHead,
      projectId: project.id,
    });
    const terminalShareInput = {
      actorSessionId: actor.id,
      projectId: project.id,
      kind: "share" as const,
      requestDigest: testDigest("terminal hosted share request"),
      contentDigest: testDigest("terminal hosted share content"),
      keyDigest: testDigest("terminal hosted share key"),
      workingBindingDigest: testDigest("terminal hosted share working binding"),
      workingEpoch: 1,
      expectedHead: localHead,
      idempotencyKey: peerIdempotencyKey(87_999),
    };
    const cancelledShare = store.cancelPreparedMemorySubmission(
      store.prepareMemorySubmission(terminalShareInput).record.id,
    );
    expect(cancelledShare.state).toBe("cancelled");
    const localHeadToken = testDigest("hosted local head token");
    const requestOperation = {
      adoptionProof: testCanonicalMemoryEnvelope("PRIVATE HOSTED ADOPTION PROOF"),
      genesisToken,
      headToken: localHeadToken,
      operation: testCanonicalMemoryEnvelope("PRIVATE HOSTED OPERATION"),
      priorToken: genesisToken,
      sequence: 1,
      terminalHeadProof: testCanonicalMemoryEnvelope("PRIVATE HOSTED HEAD PROOF"),
    } as const;
    const idempotencyKey = peerIdempotencyKey(88_001);
    const prepared = store.prepareCanonicalMemorySync({
      direction: "push",
      idempotencyKey,
      localHeadToken,
      projectId: project.id,
      requestOperation,
    });
    expect(prepared).toMatchObject({
      replay: false,
      record: {
        attachmentGeneration: attached.generation,
        attachmentRevision: attached.revision,
        authorityRevision: advanced.revision,
        requestOperation,
        state: "prepared",
      },
    });
    expect(store.isCanonicalMemoryMutationFenced(project.id)).toBe(true);
    expect(store.prepareMemorySubmission(terminalShareInput)).toMatchObject({
      record: { id: cancelledShare.id, state: "cancelled" },
      replay: true,
    });
    expect(() => store.prepareMemorySubmission({
      ...terminalShareInput,
      idempotencyKey: peerIdempotencyKey(88_099),
      requestDigest: testDigest("new fenced hosted share request"),
    })).toThrow("CANONICAL_MEMORY_SYNC_RECOVERY_REQUIRED");
    const fencedWriter = new Database(store.paths.database, { create: false, strict: true });
    fencedWriter.exec("PRAGMA foreign_keys=ON");
    try {
      expect(() => fencedWriter.query(
        `INSERT INTO memory_submissions
         SELECT ?,?,kind,actor_session_id,project_id,request_digest,content_digest,
           key_digest,working_binding_digest,working_epoch,effect_record_sha256,
           attestation_sha256,operation_id,source_head_sequence,
           source_head_operation_sha256,source_head_digest,nomination_sha256,
           expected_head_sequence,expected_head_operation_sha256,expected_head_digest,
           result_head_sequence,result_head_operation_sha256,result_head_digest,
           receipt_digest,outcome_code,conflict_actual_head_sequence,
           conflict_actual_head_operation_sha256,conflict_actual_head_digest,
           conflict_canonical_record_sha256,conflict_nominated_record_sha256,
           'prepared',created_at,updated_at
         FROM memory_submissions WHERE id=?`,
      ).run(
        `memsub_${"f".repeat(32)}`,
        peerIdempotencyKey(88_100),
        cancelledShare.id,
      )).toThrow("canonical memory mutation fenced by hosted sync");
    } finally {
      fencedWriter.close(false);
    }
    expect(() => store.detachCanonicalMemoryHostedSpace({
      expectedGeneration: attached.generation,
      projectId: project.id,
    })).toThrow("CANONICAL_MEMORY_SYNC_RECOVERY_REQUIRED");
    expect(() => store.compareAndSwapProjectMemoryHead({
      expectedHead: localHead,
      expectedRevision: advanced.revision,
      nextHead: {
        sequence: 2,
        operationSha256: testDigest("fenced operation"),
        headDigest: testDigest("fenced head"),
      },
      projectId: project.id,
    })).toThrow("canonical memory mutation fenced by hosted sync");

    const begun = store.markCanonicalMemorySyncEffectStarted(prepared.record.id);
    expect(begun).toMatchObject({ effectStartedAt: expect.any(Number), state: "effect_started" });
    const responseRemote = {
      genesisToken,
      head: localHead,
      headProofDigest: testDigest("hosted accepted proof"),
      headToken: localHeadToken,
      keyVersion: 1,
      revision: 1,
    } as const;
    const observed = store.recordCanonicalMemorySyncResponse({
      intentId: prepared.record.id,
      remote: responseRemote,
    });
    expect(observed).toMatchObject({
      responseObservation: responseRemote,
      state: "response_observed",
    });
    const settled = store.settleCanonicalMemorySync({
      intentId: prepared.record.id,
      resultHead: localHead,
    });
    expect(settled).toMatchObject({ resultHead: localHead, state: "settled" });
    expect(store.isCanonicalMemoryMutationFenced(project.id)).toBe(false);
    expect(store.readProjectMemoryAuthority(project.id)).toMatchObject({
      head: localHead,
      lastExchangeHead: localHead,
      syncState: "settled",
    });
    expect(store.prepareCanonicalMemorySync({
      direction: "push",
      idempotencyKey,
      localHeadToken,
      projectId: project.id,
      requestOperation,
    })).toMatchObject({ replay: true, record: { id: prepared.record.id } });
    expect(() => store.prepareCanonicalMemorySync({
      direction: "push",
      idempotencyKey,
      localHeadToken,
      projectId: project.id,
      requestOperation: {
        ...requestOperation,
        adoptionProof: testCanonicalMemoryEnvelope("DIFFERENT HOSTED ADOPTION PROOF"),
      },
    })).toThrow("CANONICAL_MEMORY_SYNC_IDEMPOTENCY_CONFLICT");

    const inspector = new Database(store.paths.database, { readonly: true, strict: true });
    try {
      const retained = JSON.stringify({
        attachment: inspector.query("SELECT * FROM project_memory_hosted_attachments").get(),
        intent: inspector.query("SELECT * FROM project_memory_sync_intents").get(),
        spool: inspector.query("SELECT * FROM project_memory_sync_spool").get(),
      });
      expect(retained).not.toContain(root);
      expect(retained).not.toContain("PRIVATE HOSTED OPERATION");
      expect(retained).not.toContain("PRIVATE HOSTED HEAD PROOF");
      expect(retained).not.toContain("PRIVATE HOSTED ADOPTION PROOF");
    } finally {
      inspector.close(false);
    }
    const settledAuthority = store.readProjectMemoryAuthority(project.id);
    if (settledAuthority === null) throw new Error("Expected settled hosted authority.");
    const secondLocalHead = {
      sequence: 2,
      operationSha256: testDigest("second hosted local operation"),
      headDigest: testDigest("second hosted local head"),
    } as const;
    store.compareAndSwapProjectMemoryHead({
      expectedHead: settledAuthority.head,
      expectedRevision: settledAuthority.revision,
      nextHead: secondLocalHead,
      projectId: project.id,
    });
    now += 30 * 24 * 60 * 60_000 + 1;
    const retainedPreparation = store.prepareCanonicalMemorySync({
      direction: "push",
      idempotencyKey: peerIdempotencyKey(88_101),
      localHeadToken: testDigest("second hosted local head token"),
      projectId: project.id,
      requestOperation: {
        adoptionProof: null,
        genesisToken,
        headToken: testDigest("second hosted local head token"),
        operation: testCanonicalMemoryEnvelope("SECOND PRIVATE HOSTED OPERATION"),
        priorToken: localHeadToken,
        sequence: 2,
        terminalHeadProof: testCanonicalMemoryEnvelope("SECOND PRIVATE HOSTED HEAD PROOF"),
      },
    });
    expect(store.readCanonicalMemorySyncIntent(prepared.record.id)).toBeNull();
    const retentionInspector = new Database(
      store.paths.database,
      { readonly: true, strict: true },
    );
    try {
      expect(retentionInspector.query(
        "SELECT COUNT(*) AS count FROM project_memory_sync_spool WHERE intent_id=?",
      ).get(prepared.record.id)).toEqual({ count: 0 });
    } finally {
      retentionInspector.close(false);
    }
    const tamperWriter = new Database(store.paths.database, { create: false, strict: true });
    try {
      const guard = z.object({ sql: z.string() }).strict().parse(tamperWriter.query(
        `SELECT sql FROM sqlite_master
         WHERE type='trigger' AND name='project_memory_sync_spool_update_guard'`,
      ).get());
      tamperWriter.exec("DROP TRIGGER project_memory_sync_spool_update_guard");
      expect(() => tamperWriter.query(
        `UPDATE project_memory_sync_spool SET adoption_proof_algorithm='A256GCM'
         WHERE intent_id=? AND phase='request'`,
      ).run(retainedPreparation.record.id)).toThrow();
      tamperWriter.query(
        `UPDATE project_memory_sync_spool SET operation_digest=?
         WHERE intent_id=? AND phase='request'`,
      ).run("f".repeat(64), retainedPreparation.record.id);
      tamperWriter.exec(guard.sql);
    } finally {
      tamperWriter.close(false);
    }
    expect(() => store.readCanonicalMemorySyncIntent(retainedPreparation.record.id))
      .toThrow("CANONICAL_MEMORY_SYNC_SPOOL_INVALID");
  });
test("structurally identifies upstream adoption v40 before adding peer and hosted memory", async () => {
    const paths = await canonical40QueueArchive();
    const captured = canonical40QueuesFixture.queues.find((entry) => entry.state === "cancelled");
    if (captured === undefined) throw new Error("Missing archived cancelled queue");
    const upstream = new Database(paths.database, { create: false, strict: true });
    let originalSession: Record<string, unknown>;
    let originalQueue: Record<string, unknown>;
    try {
      upstream.exec("PRAGMA query_only=ON");
      expect(upstream.query("PRAGMA user_version").get()).toEqual({ user_version: 40 });
      originalSession = z.record(z.string(), z.unknown()).parse(upstream.query("SELECT * FROM sessions WHERE id=?").get(captured.sessionId));
      originalQueue = z.record(z.string(), z.unknown()).parse(upstream.query("SELECT * FROM queue_entries WHERE id=?").get(captured.queueId));
      expect(originalSession).toMatchObject({ state: "idle" });
      expect(originalQueue).toMatchObject({ state: "cancelled", message: captured.queued.message });
      expect(upstream.query(
        "SELECT name FROM sqlite_master WHERE name='session_adoption_policies'",
      ).get()).toEqual({ name: "session_adoption_policies" });
      expect(upstream.query(
        "SELECT name FROM sqlite_master WHERE name='session_peer_policies'",
      ).get()).toBeNull();
      const before = canonicalAuthBudgetSnapshot(upstream);
      expect(() => new StateStore(paths, { readonly: true }))
        .toThrow("STATE_SCHEMA_MIGRATION_REQUIRED:40:61");
      expect(canonicalAuthBudgetSnapshot(upstream)).toEqual(before);
    } finally {
      upstream.close(false);
    }

    const migrated = new StateStore(paths, { now: () => 5_050 });
    stores.push(migrated);
    const inspector = new Database(paths.database, { readonly: true, strict: true });
    try {
      // This genuine source had a settled queue and a native account-key
      // observation, but no immutable runtime. Preserve its old cells without
      // promoting that observation to a captured execution tuple.
      expect(inspector.query("SELECT * FROM sessions WHERE id=?").get(captured.sessionId)).toMatchObject(originalSession);
      expect(inspector.query("SELECT * FROM queue_entries WHERE id=?").get(captured.queueId)).toMatchObject(originalQueue);
      expect(inspector.query("SELECT * FROM session_provider_authorities WHERE session_id=?").all(captured.sessionId)).toEqual([]);
      expect(() => migrated.requireSessionProviderAuthority(captured.sessionId))
        .toThrow("SESSION_PROVIDER_AUTHORITY_QUARANTINED:missing_immutable_runtime_authority");
      expect(migrated.requirePeerSessionPolicy(captured.sessionId)).toMatchObject({ mode: "coordinate", revision: 1 });
      expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: 61 });
      expect(inspector.query("SELECT * FROM migrations WHERE version<=40 ORDER BY version").all())
        .toEqual([...canonical40QueuesFixture.migrations]);
      expect(inspector.query(
        "SELECT version,applied_at FROM migrations WHERE version>=41 ORDER BY version",
      ).all()).toEqual([
        { applied_at: 5_050, version: 41 },
        { applied_at: 5_050, version: 42 },
        { applied_at: 5_050, version: 43 },
        { applied_at: 5_050, version: 44 },
        { applied_at: 5_050, version: 45 },
        { applied_at: 5_050, version: 46 }, { applied_at: 5_050, version: 47 }, { applied_at: 5_050, version: 48 }, { applied_at: 5_050, version: 49 },
        ...Array.from({ length: 12 }, (_, index) => ({ version: index + 50, applied_at: 5_050 })),
      ]);
      const after = canonicalAuthBudgetSnapshot(inspector);
      migrated.close();
      stores.splice(stores.indexOf(migrated), 1);
      for (const readonly of [false, true]) {
        const reopened = new StateStore(paths, { readonly, now: () => 5_051 });
        try { expect(canonicalAuthBudgetSnapshot(inspector)).toEqual(after); }
        finally { reopened.close(); }
      }
    } finally {
      inspector.close(false);
    }
  });
test("refuses a missing guard on an authoritative v41 predecessor without writes", async () => {
    const paths = await canonicalTimestampArchiveForTest(41);
    const damaged = new Database(paths.database, { create: false, strict: true });
    try {
      expect(damaged.query("PRAGMA user_version").get()).toEqual({ user_version: 41 });
      // Deliberately damage only the exact archived guard; this is not a
      // newly asserted historical producer or a current-schema downgrade.
      damaged.exec("DROP TRIGGER mutation_resolutions_timestamp_proof_insert");
      const before = canonicalAuthBudgetSnapshot(damaged);
      for (const readonly of [true, false]) {
        expect(() => new StateStore(paths, readonly ? { readonly: true } : {}))
          .toThrow(readonly ? "STATE_SCHEMA_MIGRATION_REQUIRED:41:61" : "STATE_SCHEMA_V41_TIMESTAMP_PROOF_GUARD_INVALID");
        expect(canonicalAuthBudgetSnapshot(damaged)).toEqual(before);
      }
    } finally {
      damaged.close(false);
    }
  });
test("imports one encrypted pull operation and settles only after pinned revalidation", async () => {
    const { store, home } = await fixture();
    const root = join(home, "hosted-memory-pull");
    await mkdir(root);
    const project = await store.createProject("Hosted memory pull", root);
    const identity = createPortableProjectMemoryCanonicalIdentity(project.id);
    const genesisToken = testDigest("pull genesis");
    const remoteHead = {
      sequence: 1,
      operationSha256: testDigest("pull operation sha"),
      headDigest: testDigest("pull raw head"),
    } as const;
    const initialRemote = {
      genesisToken,
      head: PROJECT_MEMORY_EMPTY_HEAD,
      headProofDigest: testDigest("pull genesis proof"),
      headToken: genesisToken,
      keyVersion: 3,
      revision: 7,
    } as const;
    const remote = {
      genesisToken,
      head: remoteHead,
      headProofDigest: testDigest("pull terminal proof"),
      headToken: testDigest("pull terminal token"),
      keyVersion: 3,
      revision: 7,
    } as const;
    const attached = store.attachCanonicalMemoryHostedSpace({
      accountBindingDigest: testDigest("pull account"),
      canonicalSpaceId: identity.canonicalSpaceId,
      projectId: project.id,
      remote: initialRemote,
      remoteSpaceId: `memory_${"b".repeat(32)}`,
    });
    const reserved = store.readProjectMemoryAuthority(project.id);
    if (reserved === null) throw new Error("Expected pull authority reservation.");
    store.markProjectMemoryAuthorityInitialized({
      expectedHead: reserved.head,
      expectedRevision: reserved.revision,
      projectId: project.id,
    });
    const observedRemoteAdvance = store.recordCanonicalMemoryHostedObservation({
      expectedGeneration: attached.generation,
      expectedRevision: attached.revision,
      projectId: project.id,
      remote,
    });
    expect(observedRemoteAdvance).toMatchObject({
      generation: attached.generation,
      remote,
      revision: attached.revision + 1,
      state: "attached",
    });
    expect(() => store.recordCanonicalMemoryHostedObservation({
      expectedGeneration: attached.generation,
      expectedRevision: attached.revision,
      projectId: project.id,
      remote,
    })).toThrow("CANONICAL_MEMORY_HOSTED_OBSERVATION_CONFLICT");
    const prepared = store.prepareCanonicalMemorySync({
      direction: "pull",
      idempotencyKey: peerIdempotencyKey(88_002),
      localHeadToken: genesisToken,
      projectId: project.id,
    }).record;
    expect(() => store.recordCanonicalMemoryHostedObservation({
      expectedGeneration: observedRemoteAdvance.generation,
      expectedRevision: observedRemoteAdvance.revision,
      projectId: project.id,
      remote: {
        ...remote,
        head: {
          sequence: 2,
          operationSha256: testDigest("later pull operation sha"),
          headDigest: testDigest("later pull raw head"),
        },
        headProofDigest: testDigest("later pull terminal proof"),
        headToken: testDigest("later pull terminal token"),
      },
    })).toThrow("CANONICAL_MEMORY_SYNC_RECOVERY_REQUIRED");
    store.markCanonicalMemorySyncEffectStarted(prepared.id);
    const operation = {
      adoptionProof: testCanonicalMemoryEnvelope("PULL ADOPTION PROOF CIPHERTEXT", 3),
      genesisToken,
      headToken: remote.headToken,
      operation: testCanonicalMemoryEnvelope("PULL OPERATION CIPHERTEXT", 3),
      priorToken: genesisToken,
      sequence: 1,
      terminalHeadProof: testCanonicalMemoryEnvelope("PULL HEAD CIPHERTEXT", 3),
    } as const;
    expect(store.recordCanonicalMemorySyncResponse({
      intentId: prepared.id,
      operation,
      remote,
    })).toMatchObject({ responseOperation: operation, state: "response_observed" });
    expect(store.recordCanonicalMemorySyncResponse({
      intentId: prepared.id,
      operation,
      remote,
    })).toMatchObject({ responseOperation: operation, state: "response_observed" });
    expect(() => store.recordCanonicalMemorySyncResponse({
      intentId: prepared.id,
      operation: {
        ...operation,
        adoptionProof: testCanonicalMemoryEnvelope("DIFFERENT PULL ADOPTION PROOF", 3),
      },
      remote,
    })).toThrow("CANONICAL_MEMORY_SYNC_RESPONSE_CONFLICT");
    expect(store.isCanonicalMemoryPhysicalHeadAuthorized({
      canonicalBindingDigest: identity.bindingDigest,
      controlHead: PROJECT_MEMORY_EMPTY_HEAD,
      observedHead: remoteHead,
      projectId: project.id,
    })).toBe(false);
    expect(() => store.settleCanonicalMemorySync({
      intentId: prepared.id,
      resultHead: remoteHead,
    })).toThrow("CANONICAL_MEMORY_SYNC_SETTLEMENT_INVALID");
    const authorized = store.authorizeCanonicalMemoryPullResult({
      intentId: prepared.id,
      resultHead: remoteHead,
    });
    expect(authorized).toMatchObject({
      resultHead: remoteHead,
      state: "response_observed",
    });
    expect(store.isCanonicalMemoryPhysicalHeadAuthorized({
      canonicalBindingDigest: identity.bindingDigest,
      controlHead: PROJECT_MEMORY_EMPTY_HEAD,
      observedHead: remoteHead,
      projectId: project.id,
    })).toBe(true);
    expect(store.isCanonicalMemoryPhysicalHeadAuthorized({
      canonicalBindingDigest: testDigest("hostile pull binding"),
      controlHead: PROJECT_MEMORY_EMPTY_HEAD,
      observedHead: remoteHead,
      projectId: project.id,
    })).toBe(false);
    expect(store.isCanonicalMemoryPhysicalHeadAuthorized({
      canonicalBindingDigest: identity.bindingDigest,
      controlHead: {
        sequence: 1,
        operationSha256: testDigest("hostile stale control operation"),
        headDigest: testDigest("hostile stale control head"),
      },
      observedHead: remoteHead,
      projectId: project.id,
    })).toBe(false);
    expect(store.isCanonicalMemoryPhysicalHeadAuthorized({
      canonicalBindingDigest: identity.bindingDigest,
      controlHead: PROJECT_MEMORY_EMPTY_HEAD,
      observedHead: {
        ...remoteHead,
        headDigest: testDigest("hostile observed pull head"),
      },
      projectId: project.id,
    })).toBe(false);
    expect(store.authorizeCanonicalMemoryPullResult({
      intentId: prepared.id,
      resultHead: remoteHead,
    })).toEqual(authorized);
    expect(() => store.authorizeCanonicalMemoryPullResult({
      intentId: prepared.id,
      resultHead: {
        ...remoteHead,
        headDigest: testDigest("different authorized pull result"),
      },
    })).toThrow("CANONICAL_MEMORY_SYNC_RESULT_AUTHORIZATION_CONFLICT");
    expect(store.settleCanonicalMemorySync({
      intentId: prepared.id,
      resultHead: remoteHead,
    })).toMatchObject({ resultHead: remoteHead, state: "settled" });
    expect(store.readProjectMemoryAuthority(project.id)).toMatchObject({
      head: remoteHead,
      lastExchangeHead: remoteHead,
      syncState: "settled",
    });
    expect(store.isCanonicalMemoryPhysicalHeadAuthorized({
      canonicalBindingDigest: identity.bindingDigest,
      controlHead: PROJECT_MEMORY_EMPTY_HEAD,
      observedHead: remoteHead,
      projectId: project.id,
    })).toBe(true);
  });
test("freezes equal-sequence pull disagreement before preparing an effect", async () => {
    const { store, home } = await fixture();
    for (const [index, disagreement] of ["token", "raw-head"].entries()) {
      const root = join(home, `hosted-memory-equal-${disagreement}`);
      await mkdir(root);
      const project = await store.createProject(`Hosted equal ${disagreement}`, root);
      const identity = createPortableProjectMemoryCanonicalIdentity(project.id);
      const genesisToken = testDigest(`equal ${disagreement} genesis`);
      const remoteHead = {
        sequence: 1,
        operationSha256: testDigest(`equal ${disagreement} remote operation`),
        headDigest: testDigest(`equal ${disagreement} remote head`),
      } as const;
      const remote = {
        genesisToken,
        head: remoteHead,
        headProofDigest: testDigest(`equal ${disagreement} proof`),
        headToken: testDigest(`equal ${disagreement} remote token`),
        keyVersion: 1,
        revision: 1,
      } as const;
      store.attachCanonicalMemoryHostedSpace({
        accountBindingDigest: testDigest(`equal ${disagreement} account`),
        canonicalSpaceId: identity.canonicalSpaceId,
        projectId: project.id,
        remote,
        remoteSpaceId: `memory_${String(index + 4).repeat(32)}`,
      });
      const reserved = store.readProjectMemoryAuthority(project.id);
      if (reserved === null) throw new Error("Expected equal-sequence authority reservation.");
      const initialized = store.markProjectMemoryAuthorityInitialized({
        expectedHead: reserved.head,
        expectedRevision: reserved.revision,
        projectId: project.id,
      });
      const localHead = disagreement === "raw-head"
        ? {
            sequence: 1,
            operationSha256: testDigest("different equal-sequence local operation"),
            headDigest: testDigest("different equal-sequence local head"),
          }
        : remoteHead;
      store.compareAndSwapProjectMemoryHead({
        expectedHead: initialized.head,
        expectedRevision: initialized.revision,
        nextHead: localHead,
        projectId: project.id,
      });
      expect(() => store.prepareCanonicalMemorySync({
        direction: "pull",
        idempotencyKey: peerIdempotencyKey(88_020 + index),
        localHeadToken: disagreement === "token"
          ? testDigest("different equal-sequence local token")
          : remote.headToken,
        projectId: project.id,
      })).toThrow("CANONICAL_MEMORY_SYNC_EQUAL_SEQUENCE_CONFLICT");
      expect(store.readUnresolvedCanonicalMemorySyncIntent(project.id)).toBeNull();
      expect(store.readCanonicalMemoryHostedAttachment(project.id)).toMatchObject({
        diagnosticCode: "REMOTE_MEMORY_EQUAL_SEQUENCE_CONFLICT",
        state: "conflict",
      });
      expect(store.readProjectMemoryAuthority(project.id)).toMatchObject({
        diagnosticCode: "REMOTE_MEMORY_EQUAL_SEQUENCE_CONFLICT",
        lastExchangeHead: remoteHead,
        syncState: "conflict",
      });
      expect(store.isCanonicalMemoryMutationFenced(project.id)).toBe(true);
    }
  });
test("freezes hosted configuration drift and same-sequence observation divergence", async () => {
    const { store, home } = await fixture();
    const variants = ["genesis", "revision", "key", "same-sequence"] as const;
    for (const [index, variant] of variants.entries()) {
      const root = join(home, `hosted-memory-observation-${variant}`);
      await mkdir(root);
      const project = await store.createProject(`Hosted observation ${variant}`, root);
      const identity = createPortableProjectMemoryCanonicalIdentity(project.id);
      const genesisToken = testDigest(`observation ${variant} genesis`);
      const remote = {
        genesisToken,
        head: PROJECT_MEMORY_EMPTY_HEAD,
        headProofDigest: testDigest(`observation ${variant} proof`),
        headToken: genesisToken,
        keyVersion: 1,
        revision: 1,
      } as const;
      const attached = store.attachCanonicalMemoryHostedSpace({
        accountBindingDigest: testDigest(`observation ${variant} account`),
        canonicalSpaceId: identity.canonicalSpaceId,
        projectId: project.id,
        remote,
        remoteSpaceId: `memory_${String(index + 6).repeat(32)}`,
      });
      const reserved = store.readProjectMemoryAuthority(project.id);
      if (reserved === null) throw new Error("Expected observation authority reservation.");
      store.markProjectMemoryAuthorityInitialized({
        expectedHead: reserved.head,
        expectedRevision: reserved.revision,
        projectId: project.id,
      });
      const differentGenesis = testDigest(`different observation ${variant} genesis`);
      const changedRemote = variant === "genesis"
        ? { ...remote, genesisToken: differentGenesis, headToken: differentGenesis }
        : variant === "revision"
          ? { ...remote, revision: 2 }
          : variant === "key"
            ? { ...remote, keyVersion: 2 }
            : {
                ...remote,
                headProofDigest: testDigest("divergent same-sequence observation proof"),
              };
      expect(() => store.recordCanonicalMemoryHostedObservation({
        expectedGeneration: attached.generation,
        expectedRevision: attached.revision,
        projectId: project.id,
        remote: changedRemote,
      })).toThrow("CANONICAL_MEMORY_HOSTED_OBSERVATION_CONFLICT");
      const diagnosticCode = variant === "same-sequence"
        ? "REMOTE_MEMORY_HEAD_CONFLICT"
        : "REMOTE_MEMORY_CONFIGURATION_CONFLICT";
      expect(store.readCanonicalMemoryHostedAttachment(project.id)).toMatchObject({
        diagnosticCode,
        state: "conflict",
      });
      expect(store.readProjectMemoryAuthority(project.id)).toMatchObject({
        diagnosticCode,
        syncState: "conflict",
      });
      expect(store.isCanonicalMemoryMutationFenced(project.id)).toBe(true);
    }
  });
test("preserves permanent hosted identity across detach and freezes sticky failure", async () => {
    const { store, home } = await fixture();
    const root = join(home, "hosted-memory-detach");
    await mkdir(root);
    const project = await store.createProject("Hosted memory detach", root);
    const identity = createPortableProjectMemoryCanonicalIdentity(project.id);
    const genesisToken = testDigest("detach genesis");
    const remote = {
      genesisToken,
      head: PROJECT_MEMORY_EMPTY_HEAD,
      headProofDigest: testDigest("detach proof"),
      headToken: genesisToken,
      keyVersion: 1,
      revision: 1,
    } as const;
    expect(() => store.attachCanonicalMemoryHostedSpace({
      accountBindingDigest: testDigest("detach account"),
      canonicalSpaceId: identity.canonicalSpaceId,
      projectId: project.id,
      remote,
      remoteSpaceId: "memory_short",
    })).toThrow();
    const attached = store.attachCanonicalMemoryHostedSpace({
      accountBindingDigest: testDigest("detach account"),
      canonicalSpaceId: identity.canonicalSpaceId,
      projectId: project.id,
      remote,
      remoteSpaceId: `memory_${"c".repeat(32)}`,
    });
    const detached = store.detachCanonicalMemoryHostedSpace({
      expectedGeneration: attached.generation,
      projectId: project.id,
    });
    expect(detached).toMatchObject({ generation: 2, state: "detached" });
    expect(() => store.attachCanonicalMemoryHostedSpace({
      accountBindingDigest: testDigest("detach account"),
      canonicalSpaceId: identity.canonicalSpaceId,
      projectId: project.id,
      remote,
      remoteSpaceId: `memory_${"d".repeat(32)}`,
    })).toThrow("CANONICAL_MEMORY_HOSTED_REBIND_REFUSED");
    const reattached = store.attachCanonicalMemoryHostedSpace({
      accountBindingDigest: testDigest("detach account"),
      canonicalSpaceId: identity.canonicalSpaceId,
      projectId: project.id,
      remote,
      remoteSpaceId: `memory_${"c".repeat(32)}`,
    });
    expect(reattached).toMatchObject({ generation: 3, state: "attached" });
    const reserved = store.readProjectMemoryAuthority(project.id);
    if (reserved === null) throw new Error("Expected detached identity authority.");
    store.markProjectMemoryAuthorityInitialized({
      expectedHead: reserved.head,
      expectedRevision: reserved.revision,
      projectId: project.id,
    });
    const intent = store.prepareCanonicalMemorySync({
      direction: "pull",
      idempotencyKey: peerIdempotencyKey(88_003),
      localHeadToken: genesisToken,
      projectId: project.id,
    }).record;
    const failed = store.failCanonicalMemorySync({
      diagnosticCode: "REMOTE_MEMORY_ERASED",
      intentId: intent.id,
      state: "error",
    });
    expect(failed).toMatchObject({
      diagnosticCode: "REMOTE_MEMORY_ERASED",
      state: "error",
    });
    expect(store.failCanonicalMemorySync({
      diagnosticCode: "REMOTE_MEMORY_ERASED",
      intentId: intent.id,
      state: "error",
    })).toEqual(failed);
    expect(store.isCanonicalMemoryMutationFenced(project.id)).toBe(true);
    expect(store.readCanonicalMemoryHostedAttachment(project.id)).toMatchObject({
      diagnosticCode: "REMOTE_MEMORY_ERASED",
      remoteSpaceId: `memory_${"c".repeat(32)}`,
      state: "error",
    });
    expect(() => store.detachCanonicalMemoryHostedSpace({
      expectedGeneration: reattached.generation,
      projectId: project.id,
    })).toThrow("CANONICAL_MEMORY_HOSTED_ATTACHMENT_FROZEN");
    expect(() => store.prepareCanonicalMemorySync({
      direction: "pull",
      idempotencyKey: peerIdempotencyKey(88_004),
      localHeadToken: genesisToken,
      projectId: project.id,
    })).toThrow("CANONICAL_MEMORY_HOSTED_ATTACHMENT_NOT_ACTIVE");

    const writer = new Database(store.paths.database, { create: false, strict: true });
    writer.exec("PRAGMA foreign_keys=ON");
    expect(() => writer.query(
      "DELETE FROM project_memory_hosted_attachments WHERE project_id=?",
    ).run(project.id)).toThrow();
    expect(() => writer.query(
      `UPDATE project_memory_hosted_attachments
       SET state='attached',diagnostic_code=NULL,revision=revision+1 WHERE project_id=?`,
    ).run(project.id)).toThrow();
    writer.close(false);
  });
test("freezes a missing hosted attachment before any sync intent exists", async () => {
    const { store, home } = await fixture();
    const root = join(home, "hosted-memory-pre-intent-failure");
    await mkdir(root);
    const project = await store.createProject("Hosted memory pre-intent failure", root);
    const identity = createPortableProjectMemoryCanonicalIdentity(project.id);
    const genesisToken = testDigest("pre-intent failure genesis");
    const remote = {
      genesisToken,
      head: PROJECT_MEMORY_EMPTY_HEAD,
      headProofDigest: testDigest("pre-intent failure proof"),
      headToken: genesisToken,
      keyVersion: 1,
      revision: 1,
    } as const;
    const attached = store.attachCanonicalMemoryHostedSpace({
      accountBindingDigest: testDigest("pre-intent failure account"),
      canonicalSpaceId: identity.canonicalSpaceId,
      projectId: project.id,
      remote,
      remoteSpaceId: `memory_${"e".repeat(32)}`,
    });
    const reserved = store.readProjectMemoryAuthority(project.id);
    if (reserved === null) throw new Error("Expected a reserved project authority.");
    store.markProjectMemoryAuthorityInitialized({
      expectedHead: reserved.head,
      expectedRevision: reserved.revision,
      projectId: project.id,
    });

    const failed = store.failCanonicalMemoryHostedAttachment({
      diagnosticCode: "REMOTE_MEMORY_ERASED",
      expectedGeneration: attached.generation,
      expectedRevision: attached.revision,
      projectId: project.id,
      state: "error",
    });
    expect(failed).toMatchObject({
      diagnosticCode: "REMOTE_MEMORY_ERASED",
      revision: attached.revision + 1,
      state: "error",
    });
    expect(store.failCanonicalMemoryHostedAttachment({
      diagnosticCode: "REMOTE_MEMORY_ERASED",
      expectedGeneration: attached.generation,
      expectedRevision: attached.revision,
      projectId: project.id,
      state: "error",
    })).toEqual(failed);
    expect(store.readProjectMemoryAuthority(project.id)).toMatchObject({
      diagnosticCode: "REMOTE_MEMORY_ERASED",
      syncState: "error",
    });
    expect(store.isCanonicalMemoryMutationFenced(project.id)).toBe(true);
  });
test("proves the sole retained memory submission without ignoring other states or actors", async () => {
    const { store, home } = await fixture({ now: () => 10_000 });
    const root = join(home, "memory-submission-cardinality");
    await mkdir(root);
    const project = await store.createProject("Memory submission cardinality", root);
    const profile = signInProfile(store, "Memory cardinality", "cardinality@example.com");
    const actor = createAuthorizedStartingTestSession(store, {
      profileId: profile.id,
      projectId: project.id,
      preset: "high",
      fastEnabled: false,
    });
    const other = createAuthorizedStartingTestSession(store, {
      profileId: profile.id,
      projectId: project.id,
      preset: "high",
      fastEnabled: false,
    });
    const absentId = `memsub_${"0".repeat(32)}`;
    expect(store.isSoleMemorySubmissionForSession(actor.id, absentId)).toBe(false);
    const prepare = (sessionId: typeof actor.id, index: number) => store.prepareMemorySubmission({
      actorSessionId: sessionId,
      projectId: project.id,
      kind: "remember",
      requestDigest: testDigest(`cardinality request ${String(index)}`),
      contentDigest: testDigest(`cardinality content ${String(index)}`),
      keyDigest: testDigest(`cardinality key ${String(index)}`),
      workingBindingDigest: testDigest(`cardinality binding ${sessionId}`),
      workingEpoch: 1,
      expectedHead: PROJECT_MEMORY_EMPTY_HEAD,
      idempotencyKey: peerIdempotencyKey(61_000 + index),
    }).record;
    const first = prepare(actor.id, 0);
    expect(store.isSoleMemorySubmissionForSession(actor.id, first.id)).toBe(true);
    expect(store.isSoleMemorySubmissionForSession(actor.id, absentId)).toBe(false);
    expect(store.isSoleMemorySubmissionForSession(other.id, first.id)).toBe(false);
    store.cancelPreparedMemorySubmission(first.id);
    expect(store.isSoleMemorySubmissionForSession(actor.id, first.id)).toBe(true);
    const otherSubmission = prepare(other.id, 1);
    expect(store.isSoleMemorySubmissionForSession(other.id, otherSubmission.id)).toBe(true);
    expect(store.isSoleMemorySubmissionForSession(actor.id, first.id)).toBe(true);
    store.bindMemorySubmissionEffect({
      submissionId: otherSubmission.id,
      effectRecordSha256: testDigest("cardinality applied record"),
      attestationSha256: testDigest("cardinality applied attestation"),
      operationId: "memory_cardinality_applied",
    });
    store.beginMemorySubmission(otherSubmission.id);
    store.settleMemorySubmission({
      submissionId: otherSubmission.id,
      expectedState: "effect_started",
      state: "applied",
      outcomeCode: "remember_committed",
      resultHead: {
        sequence: 1,
        operationSha256: testDigest("cardinality applied operation"),
        headDigest: testDigest("cardinality applied head"),
      },
      receiptDigest: testDigest("cardinality applied receipt"),
    });
    expect(store.isSoleMemorySubmissionForSession(other.id, otherSubmission.id)).toBe(true);
    const second = prepare(actor.id, 2);
    expect(store.isSoleMemorySubmissionForSession(actor.id, first.id)).toBe(false);
    expect(store.isSoleMemorySubmissionForSession(actor.id, second.id)).toBe(false);
    expect(() => store.isSoleMemorySubmissionForSession("invalid" as typeof actor.id, first.id))
      .toThrow();
    expect(() => store.isSoleMemorySubmissionForSession(actor.id, "invalid")).toThrow();
    const reader = new StateStore(store.paths, { readonly: true });
    try {
      expect(reader.isSoleMemorySubmissionForSession(actor.id, first.id)).toBe(false);
      expect(reader.isSoleMemorySubmissionForSession(other.id, otherSubmission.id)).toBe(true);
      expect(reader.requireMemorySubmission(first.id).state).toBe("cancelled");
      expect(reader.requireMemorySubmission(second.id).state).toBe("prepared");
      expect(reader.requireMemorySubmission(otherSubmission.id).state).toBe("applied");
    } finally {
      reader.close();
    }
  });
test("keeps compact page attestations across journal GC and releases them with exact lane refs", async () => {
    let now = 10_000;
    const { store, home } = await fixture({ now: () => now });
    const root = join(home, "memory-attestation-retention");
    await mkdir(root);
    const project = await store.createProject("Memory attestation retention", root);
    const profile = signInProfile(store, "Memory attestation retention", "attest@example.com");
    const actor = createAuthorizedStartingTestSession(store, {
      profileId: profile.id,
      projectId: project.id,
      preset: "high",
      fastEnabled: false,
    });
    const emptyHead = PROJECT_MEMORY_EMPTY_HEAD;
    const authorityDigest = reserveTestProjectMemoryAuthority(
      store,
      project.id,
      emptyHead,
    ).authorityDigest;
    const workingBindingDigest = testDigest("attestation working binding");
    const remember = (
      index: number,
      expectedHead: typeof emptyHead | Readonly<{
        sequence: number;
        operationSha256: string;
        headDigest: string;
      }>,
    ) => {
      const keyDigest = testDigest(`attestation key ${String(index)}`);
      const contentDigest = testDigest(`attestation content ${String(index)}`);
      const effectRecordSha256 = testDigest(`attestation record ${String(index)}`);
      const attestationSha256 = testDigest(`attestation evidence ${String(index)}`);
      const record = store.prepareMemorySubmission({
        actorSessionId: actor.id,
        projectId: project.id,
        kind: "remember",
        requestDigest: testDigest(`attestation request ${String(index)}`),
        contentDigest,
        keyDigest,
        workingBindingDigest,
        workingEpoch: 1,
        expectedHead,
        idempotencyKey: peerIdempotencyKey(60_000 + index),
      }).record;
      store.bindMemorySubmissionEffect({
        submissionId: record.id,
        effectRecordSha256,
        attestationSha256,
        operationId: `memory_attestation_${String(index)}`,
      });
      store.beginMemorySubmission(record.id);
      const resultHead = {
        sequence: expectedHead.sequence + 1,
        operationSha256: testDigest(`attestation operation ${String(index)}`),
        headDigest: testDigest(`attestation head ${String(index)}`),
      };
      store.settleMemorySubmission({
        submissionId: record.id,
        expectedState: "effect_started",
        state: "applied",
        outcomeCode: "remember_committed",
        resultHead,
        receiptDigest: testDigest(`attestation receipt ${String(index)}`),
      });
      return {
        attestationSha256,
        contentDigest,
        effectRecordSha256,
        idempotencyKey: record.idempotencyKey,
        keyDigest,
        resultHead,
      };
    };
    const first = remember(0, emptyHead);
    const second = remember(1, first.resultHead);
    expect(store.findMemoryPageAttestation(first.attestationSha256)).toMatchObject({
      actorSessionId: actor.id,
      projectId: project.id,
      keyDigest: first.keyDigest,
    });
    expect(store.isMemoryPageAttestationReferenced({
      attestationSha256: first.attestationSha256,
      authorityDigest: workingBindingDigest,
      keyDigest: first.keyDigest,
      lane: "working",
      projectId: project.id,
    })).toBe(true);

    const share = store.prepareMemorySubmission({
      actorSessionId: actor.id,
      projectId: project.id,
      kind: "share",
      requestDigest: testDigest("attestation share request"),
      contentDigest: first.contentDigest,
      keyDigest: first.keyDigest,
      workingBindingDigest,
      workingEpoch: 1,
      expectedHead: emptyHead,
      idempotencyKey: peerIdempotencyKey(60_100),
    }).record;
    store.bindMemorySubmissionEffect({
      submissionId: share.id,
      effectRecordSha256: first.effectRecordSha256,
      attestationSha256: first.attestationSha256,
      operationId: "memory_adopt_attestation",
      sourceHead: second.resultHead,
      nominationSha256: testDigest("attestation nomination"),
    });
    store.beginMemorySubmission(share.id);
    const canonicalHead = {
      sequence: 1,
      operationSha256: testDigest("attestation canonical operation"),
      headDigest: testDigest("attestation canonical head"),
    } as const;
    store.settleMemorySubmission({
      submissionId: share.id,
      expectedState: "effect_started",
      state: "applied",
      outcomeCode: "share_adopted",
      resultHead: canonicalHead,
      receiptDigest: testDigest("attestation share receipt"),
    });
    expect(store.isMemoryPageAttestationReferenced({
      attestationSha256: first.attestationSha256,
      authorityDigest,
      keyDigest: first.keyDigest,
      lane: "canonical",
      projectId: project.id,
    })).toBe(true);
    const portableProof = store.readCanonicalMemoryPortableAdoptionProof({
      operationSha256: canonicalHead.operationSha256,
      projectId: project.id,
      sequence: canonicalHead.sequence,
    });
    expect(portableProof).toMatchObject({
      bindingDigest: store.readProjectMemoryAuthority(project.id)?.bindingDigest,
      canonicalSpaceId: store.readProjectMemoryAuthority(project.id)?.canonicalSpaceId,
      contentDigest: first.contentDigest,
      keyDigest: first.keyDigest,
      operationSha256: canonicalHead.operationSha256,
      projectId: project.id,
      recordSha256: first.effectRecordSha256,
      sequence: canonicalHead.sequence,
      sourceReceiptSha256: testDigest("attestation share receipt"),
    });
    expect(store.isCanonicalMemoryPortableAdoptionProofReferenced({
      bindingDigest: portableProof?.bindingDigest ?? "",
      contentDigest: first.contentDigest,
      keyDigest: first.keyDigest,
      projectId: project.id,
      recordSha256: first.effectRecordSha256,
    })).toBe(true);
    const proofWriter = new Database(store.paths.database, { create: false, strict: true });
    proofWriter.exec("PRAGMA foreign_keys=ON");
    expect(() => proofWriter.query(
      `UPDATE project_memory_portable_adoption_proofs
       SET source_receipt_sha256=? WHERE project_id=? AND sequence=?`,
    ).run(testDigest("forged receipt"), project.id, canonicalHead.sequence)).toThrow();
    expect(() => proofWriter.query(
      `DELETE FROM project_memory_portable_adoption_proofs
       WHERE project_id=? AND sequence=?`,
    ).run(project.id, canonicalHead.sequence)).toThrow();
    proofWriter.close(false);

    const childBindingDigest = testDigest("attestation child binding");
    const childSessionId = `sess_${"f".repeat(32)}`;
    const childHead = {
      sequence: 1,
      operationSha256: testDigest("attestation child fork operation"),
      digest: testDigest("attestation child fork head"),
    } as const;
    const parentHead = {
      sequence: second.resultHead.sequence,
      operationSha256: second.resultHead.operationSha256,
      digest: second.resultHead.headDigest,
    } as const;
    expect(store.reserveMemoryWorkingPageAttestationFork({
      childBindingDigest,
      childSessionId,
      parentBindingDigest: workingBindingDigest,
      parentHead,
    })).toEqual({ references: 2, state: "reserved" });
    expect(store.hasMemoryWorkingAttestationForkFromParent(workingBindingDigest)).toBe(true);
    const third = remember(2, second.resultHead);
    expect(store.reserveMemoryWorkingPageAttestationFork({
      childBindingDigest,
      childSessionId,
      parentBindingDigest: workingBindingDigest,
      parentHead,
    })).toEqual({ references: 0, state: "reserved" });
    expect(store.finalizeMemoryWorkingPageAttestationFork({
      childBindingDigest,
      childHead,
      parentBindingDigest: workingBindingDigest,
      parentHead,
    })).toBe(0);
    expect(store.hasMemoryWorkingAttestationForkFromParent(workingBindingDigest)).toBe(false);
    expect(store.reserveMemoryWorkingPageAttestationFork({
      childBindingDigest,
      childSessionId,
      parentBindingDigest: workingBindingDigest,
      parentHead,
    })).toEqual({ references: 0, state: "finalized" });
    expect(store.finalizeMemoryWorkingPageAttestationFork({
      childBindingDigest,
      childHead,
      parentBindingDigest: workingBindingDigest,
      parentHead,
    })).toBe(0);
    expect(store.readMemoryWorkingAttestationHead(childBindingDigest)).toMatchObject({
      authorityDigest: childBindingDigest,
      forkParentAuthorityDigest: workingBindingDigest,
      forkParentHead: second.resultHead,
      head: {
        sequence: childHead.sequence,
        operationSha256: childHead.operationSha256,
        headDigest: childHead.digest,
      },
      origin: "fork",
    });
    now += MEMORY_SUBMISSION_RETAIN_AGE_MS + 1;
    const pruningAdmission = store.prepareMemorySubmission({
      actorSessionId: actor.id,
      projectId: project.id,
      kind: "remember",
      requestDigest: testDigest("attestation pruning request"),
      contentDigest: testDigest("attestation pruning content"),
      keyDigest: testDigest("attestation pruning key"),
      workingBindingDigest,
      workingEpoch: 1,
      expectedHead: third.resultHead,
      idempotencyKey: peerIdempotencyKey(60_200),
    }).record;
    store.cancelPreparedMemorySubmission(pruningAdmission.id);
    expect(store.readMemorySubmissionByIdempotencyKey(first.idempotencyKey)).toBeNull();
    expect(store.findMemoryPageAttestation(first.attestationSha256)).not.toBeNull();
    expect(store.findMemoryPageAttestation(second.attestationSha256)).not.toBeNull();
    expect(store.findMemoryPageAttestation(third.attestationSha256)).not.toBeNull();

    expect(store.purgeMemoryWorkingPageAttestations({
      bindingDigest: workingBindingDigest,
    })).toBe(3);
    expect(store.findMemoryPageAttestation(second.attestationSha256)).not.toBeNull();
    expect(store.findMemoryPageAttestation(third.attestationSha256)).toBeNull();
    expect(store.purgeMemoryWorkingPageAttestations({
      bindingDigest: childBindingDigest,
    })).toBe(2);
    expect(store.findMemoryPageAttestation(second.attestationSha256)).toBeNull();
    expect(store.findMemoryPageAttestation(first.attestationSha256)).not.toBeNull();
  });
test("pages only actor-authorized visible same-project peers in stable creation order", async () => {
    const captured = canonical39RetiredRecoveryFixtures.inflight_start;
    const home = await realpath(await mkdtemp(join(tmpdir(), "oompa-peer-directory-history-")));
    const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
    await initializeStatePaths(paths);
    const bytes = canonical39RetiredRecoveryDatabaseBytes("inflight_start");
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(captured.databaseSha256);
    await writeFile(paths.database, bytes, { mode: 0o600, flag: "wx" });
    const store = new StateStore(paths, { now: () => 40_000 });
    stores.push(store);
    // The retained /opt/homebrew project is public metadata only. This test
    // creates control-plane records, never directories or provider work there.
    const firstProject = store.requireProject(captured.retained.project.id);
    const retired = store.requireSession(captured.retained.session.id);
    expect(retired).toMatchObject({
      provider: "devin", profileId: captured.retained.profile.id, projectId: firstProject.id,
    });
    const secondRoot = join(home, "peer-directory-b");
    await mkdir(secondRoot);
    const secondProject = await store.createProject("Peer directory B", secondRoot);
    const profile = signInProfile(store, "Peer directory account", "directory@example.com");
    const create = (projectId: typeof firstProject.id, title: string) =>
      createAuthorizedStartingTestSession(store, {
      profileId: profile.id,
      projectId,
      title,
      preset: "high",
      fastEnabled: false,
    });
    const actorBase = create(firstProject.id, "Actor private note never projected");
    const actor = store.setSessionTurnState({
      sessionId: actorBase.id,
      expectedRevision: actorBase.revision,
      state: "active",
      activeTurnId: "peer-directory-turn",
    });
    const visible = [
      create(firstProject.id, "Visible one"),
      create(firstProject.id, "Visible two"),
    ];
    const off = create(firstProject.id, "Hidden by policy");
    store.setPeerSessionPolicy({
      sessionId: off.id,
      expectedRevision: 1,
      mode: "off",
    });
    const archived = create(firstProject.id, "Hidden by archive");
    store.setSessionArchived(archived.id, true);
    create(secondProject.id, "Hidden by project");

    expect(() => store.listPeerProjectSessionPage({
      actorSessionId: actor.id,
      actorTurnId: "wrong-turn",
      after: null,
      limit: 1,
    })).toThrow("PEER_SESSION_ACTOR_TURN_REFUSED");

    const expected = visible.map((session) => session.id).sort();
    const first = store.listPeerProjectSessionPage({
      actorSessionId: actor.id,
      actorTurnId: actor.activeTurnId!,
      after: null,
      limit: 1,
    });
    expect(first.sessions.map((session) => session.id)).toEqual(expected.slice(0, 1));
    expect(first.nextPosition).not.toBeNull();
    expect(Object.keys(first.sessions[0] ?? {}).sort()).toEqual([
      "active",
      "createdAt",
      "id",
      "policy",
      "policyRevision",
      "preset",
      "provider",
      "revision",
      "state",
      "title",
      "updatedAt",
    ]);
    const second = store.listPeerProjectSessionPage({
      actorSessionId: actor.id,
      actorTurnId: actor.activeTurnId!,
      after: first.nextPosition,
      limit: 1,
    });
    expect(second.sessions.map((session) => session.id)).toEqual(expected.slice(1));
    expect(second.nextPosition).toBeNull();
    // The migrated Devin session is an ordinary peer target now; a direct
    // send is still refused because the retained session is not idle.
    expect(store.assertPeerSessionInspection({
      actorSessionId: actor.id,
      actorTurnId: actor.activeTurnId!,
      targetSessionId: retired.id,
      expectedTargetRevision: retired.revision,
    }).provider).toBe("devin");
    expect(() => store.admitPeerSessionAction({
      actorSessionId: actor.id,
      actorTurnId: actor.activeTurnId!,
      targetSessionId: retired.id,
      expectedTargetRevision: retired.revision,
      delivery: "send",
      requestDigest: testDigest("archived retired peer admission"),
      messageDigest: testDigest("archived retired peer message"),
      reasonDigest: testDigest("archived retired peer reason"),
      idempotencyKey: peerIdempotencyKey(8_969),
    })).toThrow("PEER_SESSION_TARGET_STATE_REFUSED");
    expect(store.requireSession(retired.id)).toEqual(retired);

    const policy = store.requirePeerSessionPolicy(actor.id);
    store.setPeerSessionPolicy({
      sessionId: actor.id,
      expectedRevision: policy.revision,
      mode: "off",
    });
    expect(() => store.listPeerProjectSessionPage({
      actorSessionId: actor.id,
      actorTurnId: actor.activeTurnId!,
      after: null,
      limit: 50,
    })).toThrow("PEER_SESSION_POLICY_REFUSED");
    expect(() => store.listPeerProjectSessionPage({
      actorSessionId: actor.id,
      actorTurnId: actor.activeTurnId!,
      after: null,
      limit: 51,
    })).toThrow();
    // The authentic retired source has no current actor authority. Do not
    // fabricate an active retired turn merely to select a later gate.
    expect(() => store.listPeerProjectSessionPage({
      actorSessionId: retired.id,
      actorTurnId: "unproved-retired-turn",
      after: null,
      limit: 50,
    })).toThrow("PEER_SESSION_ACTOR_TURN_REFUSED");
    expect(() => store.assertPeerSessionInspection({
      actorSessionId: retired.id,
      actorTurnId: "unproved-retired-turn",
      targetSessionId: visible[0]!.id,
      expectedTargetRevision: visible[0]!.revision,
    })).toThrow("PEER_SESSION_ACTOR_TURN_REFUSED");
  });
test("refuses current peer replay and begin after adversarial provider-column corruption", async () => {
    const { store, home } = await fixture();
    const root = join(home, "peer-retired-target");
    await mkdir(root);
    const project = await store.createProject("Peer retired target", root);
    const profile = signInProfile(store, "Peer retired account", "peer-retired@example.com");
    const actorBase = createAuthorizedStartingTestSession(store, {
      profileId: profile.id,
      projectId: project.id,
      preset: "high",
      fastEnabled: false,
    });
    const actor = store.setSessionTurnState({
      sessionId: actorBase.id,
      expectedRevision: actorBase.revision,
      state: "active",
      activeTurnId: "peer-retired-actor-turn",
    });
    const targetBase = createAuthorizedStartingTestSession(store, {
      profileId: profile.id,
      projectId: project.id,
      preset: "high",
      fastEnabled: false,
    });
    const target = store.bindSession({
      sessionId: targetBase.id,
      expectedRevision: targetBase.revision,
      providerThreadId: "peer-retired-target-thread",
      state: "idle",
    });
    const directRequest = {
      actorSessionId: actor.id,
      actorTurnId: actor.activeTurnId!,
      targetSessionId: target.id,
      expectedTargetRevision: target.revision,
      delivery: "send" as const,
      requestDigest: testDigest("retired target direct request"),
      messageDigest: testDigest("retired target direct message"),
      reasonDigest: testDigest("retired target direct reason"),
      idempotencyKey: peerIdempotencyKey(8_970),
    };
    const direct = store.admitPeerSessionAction(directRequest);
    const queuedMessage = "retired target queued message";
    const queueRequest = {
      ...directRequest,
      delivery: "queue" as const,
      requestDigest: testDigest("retired target queue request"),
      messageDigest: testDigest(queuedMessage),
      reasonDigest: testDigest("retired target queue reason"),
      idempotencyKey: peerIdempotencyKey(8_971),
      message: queuedMessage,
    };
    const queued = store.admitPeerSessionAction(queueRequest);
    const targetAuthority = capturedProviderAuthorityForTest(store, target.id);

    const retire = new Database(store.paths.database, { create: false, strict: true });
    let corrupted: ReturnType<typeof canonicalAuthBudgetSnapshot>;
    try {
      const intact = canonicalAuthBudgetSnapshot(retire);
      // Deliberately corrupt a current supported row, not historical provider
      // evidence. The ordinary authority model must refuse the retagged row.
      retire.query("UPDATE sessions SET provider_v39='devin',preset='ultra',preset_contract=?,canonical_profile_key='devin:gpt-6-astra:provider-default' WHERE id=?")
        .run(devinPresetContract, target.id);
      expect(canonicalAuthBudgetSnapshot(retire)).not.toEqual(intact);
      corrupted = canonicalAuthBudgetSnapshot(retire);
    } finally {
      retire.close(false);
    }

    // The retagged row now reads as a Devin session, so inspection and
    // policy bookkeeping still see it; every authority-bearing path refuses
    // it through the ordinary session/authority consistency join.
    expect(store.assertPeerSessionInspection({
      actorSessionId: actor.id,
      actorTurnId: actor.activeTurnId!,
      targetSessionId: target.id,
      expectedTargetRevision: target.revision,
    }).provider).toBe("devin");
    expect(store.requirePeerSessionPolicy(target.id).mode).toBe("coordinate");
    expect(() => store.admitPeerSessionAction(directRequest))
      .toThrow("SESSION_PROVIDER_AUTHORITY_INCONSISTENT");
    expect(() => store.admitPeerSessionAction(queueRequest))
      .toThrow("SESSION_PROVIDER_AUTHORITY_INCONSISTENT");
    expect(() => store.admitPeerSessionAction({
      ...directRequest,
      idempotencyKey: peerIdempotencyKey(8_972),
    })).toThrow("SESSION_PROVIDER_AUTHORITY_INCONSISTENT");
    expect(() => store.admitPeerSessionAction({
      ...queueRequest,
      idempotencyKey: peerIdempotencyKey(8_973),
    })).toThrow("SESSION_PROVIDER_AUTHORITY_INCONSISTENT");
    expect(() => store.beginPeerSessionActionEffect(direct.action.id))
      .toThrow("SESSION_PROVIDER_AUTHORITY_INCONSISTENT");
    expect(() => store.beginQueueEffect({
      providerAuthority: targetAuthority,
      queueId: queued.queue!.id,
      sessionId: target.id,
      profileGeneration: profile.processGeneration,
      providerConnectionId: "10000000-0000-4000-8000-000000000099",
      evidence: {
        kind: "queue.dispatch",
        queueId: queued.queue!.id,
        sessionId: target.id,
        providerThreadId: "peer-retired-target-thread",
        profileGeneration: profile.processGeneration,
        baseline: { providerUpdatedAt: null, status: "idle", activeTurnId: null },
        clientMessageId: queued.queue!.id,
        messageDigest: testDigest(queuedMessage),
        runtimeProfile: codexRuntimeProfile(profile),
      },
    })).toThrow("SESSION_PROVIDER_AUTHORITY_INCONSISTENT");
    expect(store.requirePeerSessionAction(direct.action.id).state).toBe("prepared");
    expect(store.requirePeerSessionAction(queued.action.id).state).toBe("queued");
    expect(store.requireQueue(queued.queue!.id).state).toBe("pending");
    expect(store.readQueueEffect(queued.queue!.id)).toBeNull();
    const inspector = new Database(store.paths.database, { create: false, strict: true });
    try { expect(canonicalAuthBudgetSnapshot(inspector)).toEqual(corrupted); }
    finally { inspector.close(false); }
  });
test("admits peer queues idempotently and preserves attributed provenance across restart", async () => {
    const { store, home } = await fixture();
    const root = join(home, "peer-project");
    await mkdir(root);
    const project = await store.createProject("Peer project", root);
    const profile = signInProfile(store, "Peer account", "peer@example.com");
    const actor = createAuthorizedStartingTestSession(store, {
      profileId: profile.id,
      projectId: project.id,
      preset: "high",
      fastEnabled: false,
    });
    const activeActor = store.setSessionTurnState({
      sessionId: actor.id,
      expectedRevision: actor.revision,
      state: "active",
      activeTurnId: "actor-turn-without-sensitive-bytes",
    });
    const targetBase = createAuthorizedStartingTestSession(store, {
      profileId: profile.id,
      projectId: project.id,
      preset: "high",
      fastEnabled: false,
    });
    const target = store.bindSession({
      sessionId: targetBase.id,
      expectedRevision: targetBase.revision,
      providerThreadId: "thread-peer-begin-authority",
      state: "idle",
    });
    const message = "PRIVATE PEER MESSAGE BODY";
    const request = {
      actorSessionId: activeActor.id,
      actorTurnId: activeActor.activeTurnId!,
      targetSessionId: target.id,
      expectedTargetRevision: target.revision,
      delivery: "queue" as const,
      requestDigest: testDigest("PRIVATE PEER REQUEST AND REASON"),
      messageDigest: testDigest(message),
      reasonDigest: testDigest("PRIVATE PEER REASON"),
      idempotencyKey: peerIdempotencyKey(9_000),
      message,
    };
    const admitted = store.admitPeerSessionAction(request);
    expect(admitted).toMatchObject({
      replay: false,
      action: {
        actorPolicyRevision: 1,
        delivery: "queue",
        hop: 1,
        projectId: project.id,
        state: "queued",
        targetPolicyRevision: 1,
      },
      queue: {
        messageActor: "peer_session",
        peerActionId: admitted.action.id,
        state: "pending",
      },
    });
    expect(store.admitPeerSessionAction(request)).toMatchObject({
      replay: true,
      action: { id: admitted.action.id },
      queue: { id: admitted.queue?.id },
    });
    expect(() => store.admitPeerSessionAction({
      ...request,
      reasonDigest: testDigest("changed reason"),
    })).toThrow("PEER_SESSION_IDEMPOTENCY_CONFLICT");
    const inspector = new Database(store.paths.database, { readonly: true, strict: true });
    try {
      const peerLedger = JSON.stringify(
        inspector.query("SELECT * FROM peer_session_actions WHERE id=?").get(admitted.action.id),
      );
      expect(peerLedger).not.toContain(message);
      expect(peerLedger).not.toContain("PRIVATE PEER REASON");
      expect(peerLedger).not.toContain("actor-turn-without-sensitive-bytes");
      expect(peerLedger).not.toContain(root);
    } finally {
      inspector.close(false);
    }

    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const restarted = new StateStore(paths);
    stores.push(restarted);
    expect(restarted.requireQueue(admitted.queue!.id)).toMatchObject({
      message,
      messageActor: "peer_session",
      peerActionId: admitted.action.id,
      state: "pending",
    });
    expect(restarted.transitionQueue(admitted.queue!.id, "pending", "cancelled")).toBe(true);
    expect(restarted.requirePeerSessionAction(admitted.action.id)).toMatchObject({
      state: "cancelled",
    });
  });
test("revokes a queued peer dispatch when its actor policy or project changes", async () => {
    const { store, home } = await fixture();
    const firstRoot = join(home, "peer-queue-actor-authority-a");
    const secondRoot = join(home, "peer-queue-actor-authority-b");
    await mkdir(firstRoot);
    await mkdir(secondRoot);
    const firstProject = await store.createProject("Peer queue actor authority A", firstRoot);
    const secondProject = await store.createProject("Peer queue actor authority B", secondRoot);
    const profile = signInProfile(
      store,
      "Peer queue actor authority",
      "peer-queue-actor@example.com",
    );
    const admitQueue = (index: number) => {
      const actorBase = createAuthorizedStartingTestSession(store, {
        profileId: profile.id,
        projectId: firstProject.id,
        preset: "high",
        fastEnabled: false,
      });
      const actor = store.setSessionTurnState({
        sessionId: actorBase.id,
        expectedRevision: actorBase.revision,
        state: "active",
        activeTurnId: `turn-peer-queue-actor-${String(index)}`,
      });
      const targetBase = createAuthorizedStartingTestSession(store, {
        profileId: profile.id,
        projectId: firstProject.id,
        preset: "high",
        fastEnabled: false,
      });
      const providerThreadId = `thread-peer-queue-actor-${String(index)}`;
      const target = store.bindSession({
        sessionId: targetBase.id,
        expectedRevision: targetBase.revision,
        providerThreadId,
        state: "idle",
      });
      const message = `queued actor authority ${String(index)}`;
      const admitted = store.admitPeerSessionAction({
        actorSessionId: actor.id,
        actorTurnId: actor.activeTurnId!,
        targetSessionId: target.id,
        expectedTargetRevision: target.revision,
        delivery: "queue",
        requestDigest: testDigest(`queued actor request ${String(index)}`),
        messageDigest: testDigest(message),
        reasonDigest: testDigest(`queued actor reason ${String(index)}`),
        idempotencyKey: peerIdempotencyKey(9_050 + index),
        message,
      });
      const begin = () => store.beginQueueEffect({
        providerAuthority: capturedProviderAuthorityForTest(store, target.id),
        queueId: admitted.queue!.id,
        sessionId: target.id,
        profileGeneration: profile.processGeneration,
        providerConnectionId: "10000000-0000-4000-8000-000000000099",
        evidence: {
          kind: "queue.dispatch" as const,
          queueId: admitted.queue!.id,
          sessionId: target.id,
          providerThreadId,
          profileGeneration: profile.processGeneration,
          baseline: { providerUpdatedAt: null, status: "idle" as const, activeTurnId: null },
          clientMessageId: admitted.queue!.id,
          messageDigest: testDigest(message),
          runtimeProfile: codexRuntimeProfile(profile),
        },
      });
      return { actor, admitted, begin, target };
    };

    const policyRevoked = admitQueue(0);
    const actorPolicy = store.requirePeerSessionPolicy(policyRevoked.actor.id);
    store.setPeerSessionPolicy({
      sessionId: policyRevoked.actor.id,
      expectedRevision: actorPolicy.revision,
      mode: "off",
    });
    const laterHuman = store.enqueue(
      policyRevoked.target.id,
      "human work after revoked peer queue",
    );
    expect(policyRevoked.begin).toThrow("PEER_SESSION_POLICY_REVISION_CONFLICT");
    expect(store.nextPendingQueue(policyRevoked.target.id)?.id)
      .toBe(policyRevoked.admitted.queue!.id);
    expect(store.readQueueEffect(policyRevoked.admitted.queue!.id)).toBeNull();
    expect(store.cancelRevokedPendingPeerQueue(policyRevoked.admitted.queue!.id))
      .toMatchObject({ state: "cancelled" });
    expect(store.requirePeerSessionAction(policyRevoked.admitted.action.id).state)
      .toBe("cancelled");
    expect(store.nextPendingQueue(policyRevoked.target.id)?.id).toBe(laterHuman.id);
    expect(store.cancelRevokedPendingPeerQueue(policyRevoked.admitted.queue!.id)).toBeNull();

    const projectRevoked = admitQueue(1);
    const idleActor = store.setSessionTurnState({
      sessionId: projectRevoked.actor.id,
      expectedRevision: projectRevoked.actor.revision,
      state: "idle",
    });
    const movedActor = store.updateSessionMetadata({
      sessionId: idleActor.id,
      expectedRevision: idleActor.revision,
      projectId: secondProject.id,
    });
    store.setSessionTurnState({
      sessionId: movedActor.id,
      expectedRevision: movedActor.revision,
      state: "active",
      activeTurnId: projectRevoked.actor.activeTurnId!,
    });
    expect(projectRevoked.begin).toThrow("PEER_SESSION_PROJECT_REFUSED");
    expect(store.readQueueEffect(projectRevoked.admitted.queue!.id)).toBeNull();
    expect(store.cancelRevokedPendingPeerQueue(projectRevoked.admitted.queue!.id))
      .toMatchObject({ state: "cancelled" });
    expect(store.requirePeerSessionAction(projectRevoked.admitted.action.id).state)
      .toBe("cancelled");
  });
test("attaches a queued peer action to the accepted target turn transactionally", async () => {
    const { store, home } = await fixture();
    const root = join(home, "peer-queue-effect");
    await mkdir(root);
    const project = await store.createProject("Peer queue effect", root);
    const profile = signInProfile(store, "Peer queue effect", "peer-queue@example.com");
    const actorBase = createAuthorizedStartingTestSession(store, {
      profileId: profile.id,
      projectId: project.id,
      preset: "high",
      fastEnabled: false,
    });
    const actor = store.setSessionTurnState({
      sessionId: actorBase.id,
      expectedRevision: actorBase.revision,
      state: "active",
      activeTurnId: "turn-peer-source",
    });
    const targetBase = createAuthorizedStartingTestSession(store, {
      profileId: profile.id,
      projectId: project.id,
      preset: "high",
      fastEnabled: false,
    });
    const target = store.bindSession({
      sessionId: targetBase.id,
      expectedRevision: targetBase.revision,
      providerThreadId: "thread-peer-target",
      state: "idle",
    });
    const message = "queued attributed coordination";
    const admitted = store.admitPeerSessionAction({
      actorSessionId: actor.id,
      actorTurnId: actor.activeTurnId!,
      targetSessionId: target.id,
      expectedTargetRevision: target.revision,
      delivery: "queue",
      requestDigest: testDigest("queue effect request"),
      messageDigest: testDigest(message),
      reasonDigest: testDigest("queue effect reason"),
      idempotencyKey: peerIdempotencyKey(9_100),
      message,
    });
    const runtime = codexRuntimeProfile(profile);
    const evidence = store.beginQueueEffect({
      providerAuthority: capturedProviderAuthorityForTest(store, target.id),
      queueId: admitted.queue!.id,
      sessionId: target.id,
      profileGeneration: profile.processGeneration,
      providerConnectionId: "10000000-0000-4000-8000-000000000099",
      evidence: {
        kind: "queue.dispatch",
        queueId: admitted.queue!.id,
        sessionId: target.id,
        providerThreadId: "thread-peer-target",
        profileGeneration: profile.processGeneration,
        baseline: { providerUpdatedAt: null, status: "idle", activeTurnId: null },
        clientMessageId: admitted.queue!.id,
        messageDigest: testDigest(message),
        runtimeProfile: runtime,
      },
    });
    expect(store.requirePeerSessionAction(admitted.action.id).state).toBe("effect_started");
    store.completeQueueEffect({
      providerAuthority: capturedProviderAuthorityForTest(store, store.requireQueue(admitted.queue!.id).sessionId),
      queueId: admitted.queue!.id,
      accountId: profile.id,
      providerGeneration: profile.processGeneration,
      providerConnectionId: null,
      expectedEvidenceDigest: evidence.digest,
      expectedSessionRevision: target.revision,
      applyResponseState: true,
      turnId: "turn-peer-target",
      turnStatus: "inProgress",
      runtimeProfile: runtime,
      message,
      receipt: { turnId: "turn-peer-target" },
    });
    expect(store.requirePeerSessionAction(admitted.action.id)).toMatchObject({
      state: "applied",
      targetTurnDigest: testDigest("turn-peer-target"),
      resultDigest: testDigest(JSON.stringify({ turnId: "turn-peer-target" })),
    });
    expect(store.readPeerSessionTurnOrigins({
      sessionId: target.id,
      turnId: "turn-peer-target",
    }).map((action) => action.id)).toEqual([admitted.action.id]);
  });
test("peer finalization on a pre-v44 session preserves the human-only after-hours barrier and counter", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "oompa-peer-canonical43-runtime-")));
    const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
    await initializeStatePaths(paths);
    const bytes = canonicalBudgetRuntimeDatabaseBytes(43);
    expect(createHash("sha256").update(bytes).digest("hex"))
      .toBe(canonicalBudgetRuntimeFixtures[43].databaseSha256);
    await writeFile(paths.database, bytes, { mode: 0o600, flag: "wx" });
    const captured = canonicalBudgetRuntimeFixtures[43].retained;
    const original = new Database(paths.database, { create: false, strict: true });
    original.exec("PRAGMA query_only=ON");
    let runtimeRows: unknown[];
    try {
      expect(original.query("PRAGMA user_version").get()).toEqual({ user_version: 43 });
      runtimeRows = original.query("SELECT * FROM session_runtime_profiles ORDER BY session_id,revision").all();
      expect(runtimeRows).toHaveLength(3);
    } finally { original.close(false); }
    const migrated = new StateStore(paths, { now: () => 50_000 });
    stores.push(migrated);
    // These two sessions and their immutable runtime records really predate
    // v44. Project association and peer execution are current public-API
    // operations after real migration, not forged historical authority.
    const inspector = new Database(paths.database, { readonly: true, strict: true });
    expect(inspector.query("SELECT * FROM session_runtime_profiles ORDER BY session_id,revision").all()).toEqual(runtimeRows);
    const root = await realpath(await mkdtemp(join(tmpdir(), "oompa-peer-after-hours-history-")));
    const project = await migrated.createProject("Peer after-hours history", root);
    const profile = migrated.requireProfile(captured.profile.id);
    const actorBase = migrated.requireSession(captured.limitedSession.id);
    const target = migrated.requireSession(captured.budgetSession.id);
    for (const session of [actorBase, target]) migrated.updateSessionMetadata({
      sessionId: session.id, expectedRevision: session.revision, projectId: project.id,
    });
    const actor = migrated.setSessionTurnState({
      sessionId: actorBase.id,
      expectedRevision: migrated.requireSession(actorBase.id).revision,
      state: "active",
      activeTurnId: "turn-peer-after-hours-source",
    });
    const currentTarget = migrated.requireSession(target.id);
    const message = "peer coordination does not establish human history";
    const admitted = migrated.admitPeerSessionAction({
      actorSessionId: actor.id,
      actorTurnId: actor.activeTurnId!,
      targetSessionId: currentTarget.id,
      expectedTargetRevision: currentTarget.revision,
      delivery: "queue",
      requestDigest: testDigest("peer after-hours request"),
      messageDigest: testDigest(message),
      reasonDigest: testDigest("peer after-hours reason"),
      idempotencyKey: peerIdempotencyKey(9_101),
      message,
    });
    // The retained pre-v44 session keeps its contract 1 (Sol) route; only new
    // sessions take the active Astra binding.
    const runtime = { ...codexRuntimeProfile(profile, 50_000), model: "gpt-5.6-sol" };
    expect(migrated.requireSessionPresetRequirement(currentTarget.id)).toEqual({
      preset: runtime.preset, requirement: { model: runtime.model, effort: runtime.reasoningEffort },
    });
    const evidence = migrated.beginQueueEffect({
      providerAuthority: capturedProviderAuthorityForTest(migrated, currentTarget.id),
      queueId: admitted.queue!.id,
      sessionId: currentTarget.id,
      profileGeneration: profile.processGeneration,
      providerConnectionId: "10000000-0000-4000-8000-000000000098",
      evidence: {
        kind: "queue.dispatch",
        queueId: admitted.queue!.id,
        sessionId: currentTarget.id,
        providerThreadId: captured.budgetSession.providerThreadId,
        profileGeneration: profile.processGeneration,
        baseline: { providerUpdatedAt: null, status: "idle", activeTurnId: null },
        clientMessageId: admitted.queue!.id,
        messageDigest: testDigest(message),
        runtimeProfile: runtime,
      },
    });
    const beforeHistory = inspector.query(
      "SELECT * FROM autorespond_after_hours_history WHERE session_id=?",
    ).get(currentTarget.id);
    expect(beforeHistory).toMatchObject({ human_reset_required: 1 });
    const beforeCounter = migrated.readAutorespondBudgets(currentTarget.id).consecutive;
    expect(beforeCounter).toBe(3);
    const completed = migrated.completeQueueEffect({
      providerAuthority: capturedProviderAuthorityForTest(migrated, migrated.requireQueue(admitted.queue!.id).sessionId),
      queueId: admitted.queue!.id,
      accountId: profile.id,
      providerGeneration: profile.processGeneration,
      providerConnectionId: null,
      expectedEvidenceDigest: evidence.digest,
      expectedSessionRevision: currentTarget.revision,
      applyResponseState: true,
      turnId: "turn-peer-after-hours-target",
      turnStatus: "inProgress",
      runtimeProfile: runtime,
      message,
      receipt: { turnId: "turn-peer-after-hours-target" },
    });
    expect(completed.event.body).toMatchObject({ type: "user_message", actor: "peer_session" });
    expect(migrated.readAutorespondBudgets(currentTarget.id).consecutive).toBe(beforeCounter);
    expect(inspector.query(
      "SELECT * FROM autorespond_after_hours_history WHERE session_id=?",
    ).get(currentTarget.id)).toEqual(beforeHistory);
    inspector.close(false);
  });
test("reconciles ambiguous peer queues as proven applied or abandoned across restart", async () => {
    const { store, home } = await fixture();
    const root = join(home, "peer-queue-recovery");
    await mkdir(root);
    const project = await store.createProject("Peer queue recovery", root);
    const profile = signInProfile(store, "Peer queue recovery", "peer-recovery@example.com");
    const actorBase = createAuthorizedStartingTestSession(store, {
      profileId: profile.id,
      projectId: project.id,
      preset: "high",
      fastEnabled: false,
    });
    const actor = store.setSessionTurnState({
      sessionId: actorBase.id,
      expectedRevision: actorBase.revision,
      state: "active",
      activeTurnId: "turn-peer-recovery-source",
    });
    const runtime = codexRuntimeProfile(profile);
    const prepare = (index: number) => {
      const providerThreadId = `thread-peer-recovery-${String(index)}`;
      const targetBase = createAuthorizedStartingTestSession(store, {
        profileId: profile.id,
        projectId: project.id,
        preset: "high",
        fastEnabled: false,
      });
      const target = store.bindSession({
        sessionId: targetBase.id,
        expectedRevision: targetBase.revision,
        providerThreadId,
        state: "idle",
      });
      const message = `peer recovery message ${String(index)}`;
      const admitted = store.admitPeerSessionAction({
        actorSessionId: actor.id,
        actorTurnId: actor.activeTurnId!,
        targetSessionId: target.id,
        expectedTargetRevision: target.revision,
        delivery: "queue",
        requestDigest: testDigest(`peer recovery request ${String(index)}`),
        messageDigest: testDigest(message),
        reasonDigest: testDigest(`peer recovery reason ${String(index)}`),
        idempotencyKey: peerIdempotencyKey(45_000 + index),
        message,
      });
      const evidence = store.beginQueueEffect({
        providerAuthority: capturedProviderAuthorityForTest(store, target.id),
        queueId: admitted.queue!.id,
        sessionId: target.id,
        profileGeneration: profile.processGeneration,
        providerConnectionId: "10000000-0000-4000-8000-000000000099",
        evidence: {
          kind: "queue.dispatch",
          queueId: admitted.queue!.id,
          sessionId: target.id,
          providerThreadId,
          profileGeneration: profile.processGeneration,
          baseline: { providerUpdatedAt: null, status: "idle", activeTurnId: null },
          clientMessageId: admitted.queue!.id,
          messageDigest: testDigest(message),
          runtimeProfile: runtime,
        },
      });
      expect(store.requirePeerSessionAction(admitted.action.id).state).toBe("effect_started");
      return { action: admitted.action, evidence, providerThreadId, queue: admitted.queue!, target };
    };

    const proven = prepare(0);
    store.markQueueEffectAmbiguous(proven.queue.id, proven.evidence.digest);
    expect(store.requirePeerSessionAction(proven.action.id).state).toBe("ambiguous");
    const recovered = store.resolveQueueEffect({
      queueId: proven.queue.id,
      expectedEvidenceDigest: proven.evidence.digest,
      resolution: "proven_applied",
      resolutionEvidence: { source: "exact_provider_turn" },
      receipt: { turnId: "turn-peer-recovered" },
      provider: {
        providerThreadId: proven.providerThreadId,
        title: "Recovered applied peer queue",
        status: "idle",
      },
    });
    expect(recovered.messageEvent).toMatchObject({
      appended: true,
      event: {
        body: {
          type: "user_message",
          actor: "peer_session",
          text: "peer recovery message 0",
        },
      },
    });
    expect(store.requirePeerSessionAction(proven.action.id)).toMatchObject({
      state: "applied",
      targetTurnDigest: testDigest("turn-peer-recovered"),
      resultDigest: testDigest(JSON.stringify({ turnId: "turn-peer-recovered" })),
    });
    expect(store.readPeerSessionTurnOrigins({
      sessionId: proven.target.id,
      turnId: "turn-peer-recovered",
    }).map((action) => action.id)).toEqual([proven.action.id]);

    const abandoned = prepare(1);
    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const restarted = new StateStore(paths);
    stores.push(restarted);
    expect(restarted.recoverDispatchingQueueEffects()).toEqual({
      recovered: [abandoned.queue.id],
      unresolved: [],
    });
    expect(restarted.requirePeerSessionAction(abandoned.action.id).state).toBe("ambiguous");
    restarted.resolveQueueEffect({
      queueId: abandoned.queue.id,
      expectedEvidenceDigest: abandoned.evidence.digest,
      resolution: "abandoned",
      resolutionEvidence: { source: "exact_provider_absence" },
      provider: {
        providerThreadId: abandoned.providerThreadId,
        title: "Recovered abandoned peer queue",
        status: "idle",
      },
    });
    const storedResolution = restarted.readQueueEffect(abandoned.queue.id)?.resolution;
    if (storedResolution === undefined) throw new Error("Missing normalized peer queue resolution");
    expect(storedResolution.evidence).toEqual({
      source: "exact_provider_absence",
      peerCausalFence: {
        version: 1,
        providerThreadId: abandoned.providerThreadId,
        activeTurnId: null,
      },
    });
    expect(restarted.requirePeerSessionAction(abandoned.action.id)).toMatchObject({
      state: "failed",
      resultDigest: testDigest(JSON.stringify(storedResolution.evidence)),
    });
  });
test.each(["send", "steer", "queue"] as const)(
    "peer abandonment fence persists for %s across restart and action pruning",
    async (delivery) => {
      const f = await peerAbandonmentFenceFixture(delivery);
      expect(f.abandon()).toMatchObject({ state: "active", activeTurnId: f.targetTurnId });
      const expectedEvidence = {
        ...f.baseResolutionEvidence,
        peerCausalFence: {
          version: 1,
          providerThreadId: f.target.providerThreadId,
          activeTurnId: f.targetTurnId,
        },
      };
      expect(f.resolutionEvidence()).toEqual(expectedEvidence);
      expect(f.store.requirePeerSessionAction(f.incoming.action.id).state).toBe("failed");
      if (delivery === "queue") {
        expect(f.store.requirePeerSessionAction(f.incoming.action.id).resultDigest)
          .toBe(testDigest(JSON.stringify(f.resolutionEvidence())));
      }
      expect(f.store.readPeerSessionTurnOrigins({
        sessionId: f.target.id,
        turnId: f.targetTurnId,
      })).toEqual([]);
      const denied = f.returnRequest();
      expect(() => f.store.admitPeerSessionAction(denied)).toThrow("PEER_SESSION_ACTOR_TURN_REFUSED");
      expect(f.store.readPeerSessionActionByIdempotencyKey(denied.idempotencyKey)).toBeNull();
      expect(() => f.store.beginPeerSessionActionEffect(f.pending.id))
        .toThrow("PEER_SESSION_ACTOR_TURN_REFUSED");
      expect(f.store.requirePeerSessionAction(f.pending.id).state).toBe("prepared");
      expect(f.store.admitPeerSessionAction(f.completedRequest)).toMatchObject({
        replay: true, action: { id: f.completed.id, state: "applied" },
      });
      expect(f.store.assertPeerSessionInspection({
        actorSessionId: f.target.id,
        actorTurnId: f.targetTurnId,
        targetSessionId: f.source.id,
        expectedTargetRevision: f.store.requireSession(f.source.id).revision,
      }).id).toBe(f.source.id);

      f.reopen();
      expect(f.resolutionEvidence()).toEqual(expectedEvidence);
      expect(() => f.store.admitPeerSessionAction(f.returnRequest()))
        .toThrow("PEER_SESSION_ACTOR_TURN_REFUSED");
      expect(f.store.admitPeerSessionAction(f.completedRequest).replay).toBeTrue();
      f.prune();
      expect(f.resolutionEvidence()).toEqual(expectedEvidence);
      expect(() => f.store.admitPeerSessionAction(f.returnRequest()))
        .toThrow("PEER_SESSION_ACTOR_TURN_REFUSED");
      f.reopen();
      expect(() => f.store.admitPeerSessionAction(f.returnRequest()))
        .toThrow("PEER_SESSION_ACTOR_TURN_REFUSED");
      f.changeTurn(f.target.id, "turn-peer-fence-next");
      expect(f.store.admitPeerSessionAction(f.returnRequest()).action.state).toBe("prepared");
    },
  );
test.each(["send", "queue"] as const)(
    "peer abandonment fence retains a conservative legacy %s thread fence",
    async (delivery) => {
      const f = await peerAbandonmentFenceFixture(delivery);
      f.abandon();
      f.prune();
      f.rewriteLegacyMarker(undefined);
      expect(f.resolutionEvidence()).toEqual(f.baseResolutionEvidence);
      expect(() => f.store.admitPeerSessionAction(f.returnRequest()))
        .toThrow("PEER_SESSION_ACTOR_TURN_REFUSED");
      f.changeTurn(f.target.id, "turn-peer-fence-legacy-next");
      expect(() => f.store.admitPeerSessionAction(f.returnRequest()))
        .toThrow("PEER_SESSION_ACTOR_TURN_REFUSED");
    },
  );
test("peer abandonment fence reaches an affected receipt beyond one candidate page", async () => {
    const f = await peerAbandonmentFenceFixture("steer");
    f.abandon(f.baseResolutionEvidence, false);
    const receipts = f.appendAbandonedSteers(17).sort((left, right) =>
      left.attemptId < right.attemptId ? -1 : left.attemptId > right.attemptId ? 1 : 0);
    expect(receipts).toHaveLength(18);
    const affected = receipts.at(-1)!;
    expect(receipts.slice(0, -1).every((receipt) => receipt.turnId !== affected.turnId)).toBeTrue();
    f.prune();
    for (const receipt of receipts) {
      expect(() => f.store.requirePeerSessionAction(receipt.actionId)).toThrow("PEER_SESSION_NOT_FOUND");
    }
    f.reopen();
    // UUID order, not creation time, is the immutable resolution cursor. Only
    // its final row targets this turn; the preceding 17 rows are valid and safe.
    f.changeTurn(f.target.id, affected.turnId);
    const refused = f.returnRequest();
    expect(() => f.store.admitPeerSessionAction(refused)).toThrow("PEER_SESSION_ACTOR_TURN_REFUSED");
    expect(f.store.readPeerSessionActionByIdempotencyKey(refused.idempotencyKey)).toBeNull();
    f.changeTurn(f.target.id, "turn-peer-fence-after-all-pages");
    expect(f.store.admitPeerSessionAction(f.returnRequest()).action.state).toBe("prepared");
  });
test("peer abandonment fence retains the exact legacy steer turn without guessing later turns", async () => {
    const f = await peerAbandonmentFenceFixture("steer");
    f.abandon();
    f.prune();
    f.rewriteLegacyMarker(undefined);
    expect(() => f.store.admitPeerSessionAction(f.returnRequest()))
      .toThrow("PEER_SESSION_ACTOR_TURN_REFUSED");
    f.changeTurn(f.target.id, "turn-peer-fence-legacy-steer-next");
    expect(f.store.admitPeerSessionAction(f.returnRequest()).action.state).toBe("prepared");
    // Joined evidence is source-selected and sealed. Rewriting only the raw
    // effect cannot manufacture a historical null-turn source or matching
    // provenance; the next open refuses it before any peer admission.
    expect(() => f.rewriteLegacyMarker(undefined, { legacySteerTurnNull: true }))
      .toThrow("EFFECT_EVIDENCE_PROVENANCE_CORRUPT");
  });
test.each(["send", "steer", "queue"] as const)(
    "peer abandonment fence rejects caller markers and malformed retained authority for %s",
    async (delivery) => {
      const f = await peerAbandonmentFenceFixture(delivery);
      for (const reserved of [undefined, null, { version: 1 }]) {
        expect(() => f.abandon({ ...f.baseResolutionEvidence, peerCausalFence: reserved }))
          .toThrow("PEER_SESSION_CAUSAL_FENCE_RESERVED");
        expect(f.resolutionEvidence()).toBeUndefined();
        expect(f.store.requireSession(f.target.id).state).toBe("recovery_required");
        expect(f.store.requirePeerSessionAction(f.incoming.action.id).state).toBe("ambiguous");
      }
      expect(() => f.abandon(f.baseResolutionEvidence, true, null)).toThrow();
      expect(f.resolutionEvidence()).toBeUndefined();
      expect(f.store.requireSession(f.target.id).state).toBe("recovery_required");
      expect(f.store.requirePeerSessionAction(f.incoming.action.id).state).toBe("ambiguous");
      f.abandon();
      f.prune();
      // A valid marker for the old turn would allow this actor. A refusal now
      // demonstrates malformed authority, not an incidental turn match.
      f.changeTurn(f.target.id, "turn-peer-fence-malformed-control");
      expect(f.store.admitPeerSessionAction(f.returnRequest()).action.state).toBe("prepared");
      // Provider identifiers use JavaScript string bounds, not UTF-8 bytes or
      // SQLite's Unicode-scalar/NUL-terminated length interpretation.
      for (const activeTurnId of ["x".repeat(200), "é".repeat(200), "😀".repeat(100), `x\u0000${"x".repeat(198)}`]) {
        f.rewriteLegacyMarker({ version: 1, providerThreadId: f.target.providerThreadId, activeTurnId });
        expect(
          f.store.admitPeerSessionAction(f.returnRequest()).action.state,
          `Valid ${delivery} fence turn: ${JSON.stringify(activeTurnId)}`,
        ).toBe("prepared");
      }
      for (const malformed of [
        null,
        {},
        { version: 2, providerThreadId: f.target.providerThreadId, activeTurnId: f.targetTurnId },
        { version: "1", providerThreadId: f.target.providerThreadId, activeTurnId: f.targetTurnId },
        { version: 1, providerThreadId: "different-thread", activeTurnId: f.targetTurnId },
        { version: 1, providerThreadId: "", activeTurnId: f.targetTurnId },
        { version: 1, providerThreadId: "x".repeat(201), activeTurnId: f.targetTurnId },
        { version: 1, providerThreadId: f.target.providerThreadId, activeTurnId: "" },
        { version: 1, providerThreadId: f.target.providerThreadId, activeTurnId: "x".repeat(201) },
        { version: 1, providerThreadId: f.target.providerThreadId, activeTurnId: "😀".repeat(101) },
        { version: 1, providerThreadId: f.target.providerThreadId, activeTurnId: `x\u0000${"x".repeat(200)}` },
        { version: 1, providerThreadId: f.target.providerThreadId },
        { version: 1, providerThreadId: f.target.providerThreadId, activeTurnId: f.targetTurnId, extra: true },
      ]) {
        f.rewriteLegacyMarker(malformed);
        expect(
          () => f.store.admitPeerSessionAction(f.returnRequest()),
          `Malformed ${delivery} fence: ${JSON.stringify(malformed)}`,
        ).toThrow("PEER_SESSION_ACTOR_TURN_REFUSED");
      }
      for (const duplicateVersion of [1, 2]) {
        f.rewriteLegacyMarker(undefined, {
          rawMarkerJson: `{"version":1,"version":${String(duplicateVersion)},"providerThreadId":${JSON.stringify(f.target.providerThreadId)},"activeTurnId":${JSON.stringify(f.targetTurnId)}}`,
        });
        expect(() => f.store.admitPeerSessionAction(f.returnRequest()))
          .toThrow("PEER_SESSION_ACTOR_TURN_REFUSED");
      }
      const duplicateMarker = { version: 1, providerThreadId: f.target.providerThreadId, activeTurnId: null };
      f.rewriteLegacyMarker(duplicateMarker, { rawMarkerJson: JSON.stringify(duplicateMarker) });
      expect(() => f.store.admitPeerSessionAction(f.returnRequest()))
        .toThrow("PEER_SESSION_ACTOR_TURN_REFUSED");
      fc.assert(fc.property(fc.integer({ min: 2, max: 1_000 }), (version) => {
        f.rewriteLegacyMarker({ version, providerThreadId: f.target.providerThreadId, activeTurnId: null });
        expect(() => f.store.admitPeerSessionAction(f.returnRequest()))
          .toThrow("PEER_SESSION_ACTOR_TURN_REFUSED");
      }), { numRuns: 5 });
    },
  );
test.each(["send", "steer", "queue"] as const)(
    "peer abandonment fence distinguishes a new inactive observation from missing legacy evidence for %s",
    (delivery) => ownedStateStoreCase(async ({ request }) => {
      const f = await request(() => peerAbandonmentFenceFixture(delivery));
      expect(f.abandon(f.baseResolutionEvidence, false)).toMatchObject({ state: "idle" });
      expect(f.resolutionEvidence()).toEqual({
        ...f.baseResolutionEvidence,
        peerCausalFence: {
          version: 1,
          providerThreadId: f.target.providerThreadId,
          activeTurnId: null,
        },
      });
      f.reopen();
      if (delivery === "steer") {
        f.changeTurn(f.target.id, f.targetTurnId);
        expect(() => f.store.admitPeerSessionAction(f.returnRequest()))
          .toThrow("PEER_SESSION_ACTOR_TURN_REFUSED");
      }
      f.changeTurn(f.target.id, "turn-peer-fence-after-idle");
      expect(f.store.admitPeerSessionAction(f.returnRequest()).action.state).toBe("prepared");
    }),
  );
test("refuses peer self, scope, policy, stale revision, and target-state violations distinctly", async () => {
    const { store, home } = await fixture();
    const firstRoot = join(home, "peer-refusal-a");
    const secondRoot = join(home, "peer-refusal-b");
    await mkdir(firstRoot);
    await mkdir(secondRoot);
    const firstProject = await store.createProject("Peer refusal A", firstRoot);
    const secondProject = await store.createProject("Peer refusal B", secondRoot);
    const profile = signInProfile(store, "Peer refusal", "peer-refusal@example.com");
    const create = (projectId: typeof firstProject.id) =>
      createAuthorizedStartingTestSession(store, {
      profileId: profile.id,
      projectId,
      preset: "high",
      fastEnabled: false,
    });
    const actorBase = create(firstProject.id);
    const actor = store.setSessionTurnState({
      sessionId: actorBase.id,
      expectedRevision: actorBase.revision,
      state: "active",
      activeTurnId: "turn-refusal-actor",
    });
    const target = create(firstProject.id);
    const otherProject = create(secondProject.id);
    let key = 10_000;
    const attempt = (overrides: Partial<Parameters<StateStore["admitPeerSessionAction"]>[0]> = {}) =>
      store.admitPeerSessionAction({
        actorSessionId: actor.id,
        actorTurnId: actor.activeTurnId!,
        targetSessionId: target.id,
        expectedTargetRevision: target.revision,
        delivery: "queue",
        requestDigest: testDigest(`refusal request ${String(key)}`),
        messageDigest: testDigest("refusal message"),
        reasonDigest: testDigest("refusal reason"),
        idempotencyKey: peerIdempotencyKey(key++),
        message: "refusal message",
        ...overrides,
      });
    expect(() => attempt({ targetSessionId: actor.id, expectedTargetRevision: actor.revision }))
      .toThrow("PEER_SESSION_SELF_REFUSED");
    expect(() => attempt({
      targetSessionId: otherProject.id,
      expectedTargetRevision: otherProject.revision,
    })).toThrow("PEER_SESSION_PROJECT_REFUSED");
    store.setPeerSessionPolicy({ sessionId: target.id, expectedRevision: 1, mode: "off" });
    expect(() => attempt()).toThrow("PEER_SESSION_POLICY_REFUSED");
    store.setPeerSessionPolicy({ sessionId: target.id, expectedRevision: 2, mode: "coordinate" });
    expect(() => attempt({ expectedTargetRevision: target.revision + 1 }))
      .toThrow("PEER_SESSION_REVISION_CONFLICT");
    expect(() => attempt({ actorTurnId: "not-the-active-turn" }))
      .toThrow("PEER_SESSION_ACTOR_TURN_REFUSED");
    const activeTarget = store.setSessionTurnState({
      sessionId: target.id,
      expectedRevision: target.revision,
      state: "active",
      activeTurnId: "turn-refusal-target",
    });
    expect(() => store.admitPeerSessionAction({
      actorSessionId: actor.id,
      actorTurnId: actor.activeTurnId!,
      targetSessionId: activeTarget.id,
      expectedTargetRevision: activeTarget.revision,
      delivery: "send",
      requestDigest: testDigest("active target request"),
      messageDigest: testDigest("active target message"),
      reasonDigest: testDigest("active target reason"),
      idempotencyKey: peerIdempotencyKey(key++),
    })).toThrow("PEER_SESSION_TARGET_STATE_REFUSED");
  });
test("unions every turn origin and refuses cycles and the ninth peer hop", async () => {
    const { store, home } = await fixture();
    const root = join(home, "peer-causal");
    await mkdir(root);
    const project = await store.createProject("Peer causal", root);
    const profile = signInProfile(store, "Peer causal", "peer-causal@example.com");
    const sessions = Array.from({ length: 11 }, (_, index) => {
      const created = createAuthorizedStartingTestSession(store, {
        profileId: profile.id,
        projectId: project.id,
        preset: "high",
        fastEnabled: false,
      });
      return store.setSessionTurnState({
        sessionId: created.id,
        expectedRevision: created.revision,
        state: "active",
        activeTurnId: `turn-causal-${String(index)}`,
      });
    });
    let key = 20_000;
    const steer = (from: number, to: number) => {
      const actor = sessions[from]!;
      const target = sessions[to]!;
      const action = store.admitPeerSessionAction({
        actorSessionId: actor.id,
        actorTurnId: actor.activeTurnId!,
        targetSessionId: target.id,
        expectedTargetRevision: target.revision,
        delivery: "steer",
        requestDigest: testDigest(`causal request ${String(key)}`),
        messageDigest: testDigest(`causal message ${String(key)}`),
        reasonDigest: testDigest(`causal reason ${String(key)}`),
        idempotencyKey: peerIdempotencyKey(key++),
      }).action;
      store.beginPeerSessionActionEffect(action.id);
      return store.settlePeerSessionAction({
        actionId: action.id,
        expectedState: "effect_started",
        state: "applied",
        targetTurnId: target.activeTurnId!,
        resultDigest: testDigest(`causal receipt ${String(key)}`),
      });
    };
    const chain = [];
    for (let index = 0; index < PEER_SESSION_HOP_LIMIT; index += 1) {
      chain.push(steer(index, index + 1));
    }
    expect(chain.map((action) => action.hop)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(() => steer(8, 9)).toThrow("PEER_SESSION_HOP_LIMIT_REFUSED");
    expect(() => steer(1, 0)).toThrow("PEER_SESSION_CYCLE_REFUSED");

    const independent = steer(9, 2);
    expect(store.readPeerSessionTurnOrigins({
      sessionId: sessions[2]!.id,
      turnId: sessions[2]!.activeTurnId!,
    })).toHaveLength(2);
    expect(() => steer(2, 9)).toThrow("PEER_SESSION_CYCLE_REFUSED");
    const unioned = steer(2, 10);
    expect(unioned).toMatchObject({
      hop: 3,
      parentActionIds: expect.arrayContaining([chain[1]!.id, independent.id]),
      rootActionIds: expect.arrayContaining([chain[0]!.id, independent.id]),
    });
  });
test("peer storage boundary refuses a new thirty-third steer at origin admission", async () => {
    const { applySteer, origins, requestFor, store } = await peerOriginBoundaryFixture();
    for (let index = 0; index < PEER_SESSION_TURN_ORIGIN_LIMIT; index += 1) {
      expect(applySteer(index).state).toBe("applied");
    }
    const accepted = origins();
    expect(accepted).toHaveLength(PEER_SESSION_TURN_ORIGIN_LIMIT);
    const request = requestFor(PEER_SESSION_TURN_ORIGIN_LIMIT);

    expect(() => store.admitPeerSessionAction(request))
      .toThrow("PEER_SESSION_CAUSAL_LIMIT_REFUSED");
    expect(store.readPeerSessionActionByIdempotencyKey(request.idempotencyKey)).toBeNull();
    expect(store.readPeerSessionDirectMessageSource(request.idempotencyKey)).toBeNull();
    expect(store.listUnsettledPeerSessionActions(10)).toEqual([]);
    expect(origins()).toEqual(accepted);
  });
test("peer storage boundary rechecks prepared steer origin capacity before effect", async () => {
    const { applySteer, origins, requestFor, store } = await peerOriginBoundaryFixture();
    for (let index = 0; index < PEER_SESSION_TURN_ORIGIN_LIMIT - 1; index += 1) {
      expect(applySteer(index).state).toBe("applied");
    }
    const prepared = store.admitPeerSessionAction(
      requestFor(PEER_SESSION_TURN_ORIGIN_LIMIT - 1),
    ).action;
    expect(prepared.state).toBe("prepared");
    expect(applySteer(PEER_SESSION_TURN_ORIGIN_LIMIT).state).toBe("applied");
    const accepted = origins();
    expect(accepted).toHaveLength(PEER_SESSION_TURN_ORIGIN_LIMIT);

    expect(() => store.beginPeerSessionActionEffect(prepared.id))
      .toThrow("PEER_SESSION_CAUSAL_LIMIT_REFUSED");
    expect(store.requirePeerSessionAction(prepared.id)).toEqual(prepared);
    expect(store.readMutation(prepared.idempotencyKey)).toBeNull();
    expect(origins()).toEqual(accepted);
  });
test("peer storage boundary preserves exact origin attachment replay at capacity", async () => {
    const { actor, applySteer, origins, requestFor, store, target } =
      await peerOriginBoundaryFixture();
    // An already-begun effect exercises the immutable database backstop,
    // independently of the pre-effect admission checks.
    const pending = store.admitPeerSessionAction(
      requestFor(PEER_SESSION_TURN_ORIGIN_LIMIT),
    ).action;
    const begun = store.beginPeerSessionActionEffect(pending.id);
    for (let index = 0; index < PEER_SESSION_TURN_ORIGIN_LIMIT; index += 1) {
      expect(applySteer(index).state).toBe("applied");
    }
    const accepted = origins();
    expect(accepted).toHaveLength(PEER_SESSION_TURN_ORIGIN_LIMIT);
    const action = accepted[0];
    if (action === undefined) throw new Error("Expected an accepted peer origin.");
    const attachment = {
      actionId: action.id,
      targetSessionId: target.id,
      turnId: target.activeTurnId!,
    };

    expect(() => store.attachPeerSessionActionToTurn({
      ...attachment,
      targetSessionId: actor.id,
    })).toThrow("PEER_SESSION_TARGET_STATE_REFUSED");
    expect(() => store.attachPeerSessionActionToTurn({
      ...attachment,
      turnId: "turn-peer-origin-wrong",
    })).toThrow("PEER_SESSION_TARGET_STATE_REFUSED");
    expect(() => store.attachPeerSessionActionToTurn({
      ...attachment,
      actionId: pending.id,
    })).toThrow("PEER_SESSION_TARGET_STATE_REFUSED");
    expect(() => store.settlePeerSessionAction({
      actionId: pending.id,
      expectedState: "effect_started",
      state: "applied",
      targetTurnId: target.activeTurnId!,
      resultDigest: testDigest("unadmitted thirty-third origin receipt"),
    })).toThrow("peer session turn origin quota exceeded");
    expect(store.requirePeerSessionAction(pending.id)).toEqual(begun);
    expect(origins()).toEqual(accepted);

    expect(store.attachPeerSessionActionToTurn(attachment)).toEqual(action);
    expect(store.attachPeerSessionActionToTurn(attachment)).toEqual(action);
    expect(store.admitPeerSessionAction(requestFor(0)))
      .toMatchObject({ replay: true, action: { state: "applied" } });
    expect(origins()).toEqual(accepted);
  });
test("peer storage boundary preserves arbitrary ambiguous result digests", async () => {
    const { origins, requestFor, store, target } = await peerOriginBoundaryFixture();
    const action = store.admitPeerSessionAction(requestFor(0)).action;
    store.beginPeerSessionActionEffect(action.id);
    const originalDigest = testDigest("unrelated immutable ambiguous observation");
    const ambiguous = store.settlePeerSessionAction({
      actionId: action.id,
      expectedState: "effect_started",
      state: "ambiguous",
      resultDigest: originalDigest,
    });

    for (const state of ["applied", "failed"] as const) {
      expect(() => store.settlePeerSessionAction({
        actionId: action.id,
        expectedState: "ambiguous",
        state,
        ...(state === "applied" ? { targetTurnId: target.activeTurnId! } : {}),
        resultDigest: testDigest(`replacement ${state} receipt`),
      })).toThrow("illegal peer session action transition");
      expect(store.requirePeerSessionAction(action.id)).toEqual(ambiguous);
      expect(origins()).toEqual([]);
    }
  });
test("enforces atomic hourly peer action and distinct-target boundaries without charging replay", () => ownedStateStoreCase(async ({ request }) => {
    let now = 1_000;
    const { store, home } = await request(() => fixture({ now: () => now }));
    const root = join(home, "peer-budgets");
    await request(() => mkdir(root));
    const project = await request(() => store.createProject("Peer budgets", root));
    const profile = signInProfile(store, "Peer budgets", "peer-budgets@example.com");
    const actorBase = createAuthorizedStartingTestSession(store, {
      profileId: profile.id,
      projectId: project.id,
      preset: "high",
      fastEnabled: false,
    });
    const actor = store.setSessionTurnState({
      sessionId: actorBase.id,
      expectedRevision: actorBase.revision,
      state: "active",
      activeTurnId: "turn-budget-actor",
    });
    const targetBase = createAuthorizedStartingTestSession(store, {
      profileId: profile.id,
      projectId: project.id,
      preset: "high",
      fastEnabled: false,
    });
    const target = store.setSessionTurnState({
      sessionId: targetBase.id,
      expectedRevision: targetBase.revision,
      state: "idle",
    });
    const send = (index: number, targetSession = target) => store.admitPeerSessionAction({
      actorSessionId: actor.id,
      actorTurnId: actor.activeTurnId!,
      targetSessionId: targetSession.id,
      expectedTargetRevision: targetSession.revision,
      delivery: "send",
      requestDigest: testDigest(`rate request ${String(index)}`),
      messageDigest: testDigest(`rate message ${String(index)}`),
      reasonDigest: testDigest("rate reason"),
      idempotencyKey: peerIdempotencyKey(30_000 + index),
    });
    const first = send(0);
    expect(send(0)).toMatchObject({ replay: true, action: { id: first.action.id } });
    for (let index = 1; index < PEER_SESSION_HOURLY_ACTION_LIMIT; index += 1) send(index);
    expect(() => send(PEER_SESSION_HOURLY_ACTION_LIMIT))
      .toThrow("PEER_SESSION_RATE_LIMIT_REFUSED");

    const fanoutActorBase = createAuthorizedStartingTestSession(store, {
      profileId: profile.id,
      projectId: project.id,
      preset: "high",
      fastEnabled: false,
    });
    const fanoutActor = store.setSessionTurnState({
      sessionId: fanoutActorBase.id,
      expectedRevision: fanoutActorBase.revision,
      state: "active",
      activeTurnId: "turn-fanout-actor",
    });
    expect(() => store.admitPeerSessionAction({
      actorSessionId: fanoutActor.id,
      actorTurnId: fanoutActor.activeTurnId!,
      targetSessionId: target.id,
      expectedTargetRevision: target.revision,
      delivery: "send",
      requestDigest: testDigest("aggregate project rate request"),
      messageDigest: testDigest("aggregate project rate message"),
      reasonDigest: testDigest("aggregate project rate reason"),
      idempotencyKey: peerIdempotencyKey(39_999),
    })).toThrow("PEER_SESSION_RATE_LIMIT_REFUSED");
    expect(PEER_SESSION_PROJECT_HOURLY_ACTION_LIMIT).toBe(PEER_SESSION_HOURLY_ACTION_LIMIT);
    const isolatedRoot = join(home, "peer-budgets-isolated");
    await request(() => mkdir(isolatedRoot));
    const isolatedProject = await request(() => store.createProject("Peer budgets isolated", isolatedRoot));
    const isolatedActorBase = createAuthorizedStartingTestSession(store, {
      profileId: profile.id,
      projectId: isolatedProject.id,
      preset: "high",
      fastEnabled: false,
    });
    const isolatedActor = store.setSessionTurnState({
      sessionId: isolatedActorBase.id,
      expectedRevision: isolatedActorBase.revision,
      state: "active",
      activeTurnId: "turn-isolated-budget-actor",
    });
    const isolatedTarget = createAuthorizedStartingTestSession(store, {
      profileId: profile.id,
      projectId: isolatedProject.id,
      preset: "high",
      fastEnabled: false,
    });
    expect(store.admitPeerSessionAction({
      actorSessionId: isolatedActor.id,
      actorTurnId: isolatedActor.activeTurnId!,
      targetSessionId: isolatedTarget.id,
      expectedTargetRevision: isolatedTarget.revision,
      delivery: "queue",
      requestDigest: testDigest("isolated aggregate rate request"),
      messageDigest: testDigest("isolated aggregate rate message"),
      reasonDigest: testDigest("isolated aggregate rate reason"),
      idempotencyKey: peerIdempotencyKey(39_998),
      message: "isolated aggregate rate message",
    })).toMatchObject({ replay: false });
    now += PEER_SESSION_RATE_WINDOW_MS + 1;
    const targets = Array.from(
      { length: PEER_SESSION_HOURLY_DISTINCT_TARGET_LIMIT + 1 },
      () => createAuthorizedStartingTestSession(store, {
        profileId: profile.id,
        projectId: project.id,
        preset: "high",
        fastEnabled: false,
      }),
    );
    const queue = (index: number) => {
      const message = `fanout message ${String(index)}`;
      return store.admitPeerSessionAction({
        actorSessionId: fanoutActor.id,
        actorTurnId: fanoutActor.activeTurnId!,
        targetSessionId: targets[index]!.id,
        expectedTargetRevision: targets[index]!.revision,
        delivery: "queue",
        requestDigest: testDigest(`fanout request ${String(index)}`),
        messageDigest: testDigest(message),
        reasonDigest: testDigest("fanout reason"),
        idempotencyKey: peerIdempotencyKey(40_000 + index),
        message,
      });
    };
    for (let index = 0; index < PEER_SESSION_HOURLY_DISTINCT_TARGET_LIMIT; index += 1) {
      queue(index);
    }
    expect(() => queue(PEER_SESSION_HOURLY_DISTINCT_TARGET_LIMIT))
      .toThrow("PEER_SESSION_FANOUT_LIMIT_REFUSED");
  }));
test("retains exact peer replay for seven days then atomically compacts terminal queue provenance", async () => {
    let now = 10_000;
    const { store, home } = await fixture({ now: () => now });
    const root = join(home, "peer-retention-terminal");
    await mkdir(root);
    const project = await store.createProject("Peer retention terminal", root);
    const profile = signInProfile(store, "Peer retention terminal", "peer-retention@example.com");
    const actorBase = createAuthorizedStartingTestSession(store, {
      profileId: profile.id,
      projectId: project.id,
      preset: "high",
      fastEnabled: false,
    });
    const actor = store.setSessionTurnState({
      sessionId: actorBase.id,
      expectedRevision: actorBase.revision,
      state: "active",
      activeTurnId: "turn-peer-retention-old",
    });
    const targetBase = createAuthorizedStartingTestSession(store, {
      profileId: profile.id,
      projectId: project.id,
      preset: "high",
      fastEnabled: false,
    });
    const target = store.setSessionTurnState({
      sessionId: targetBase.id,
      expectedRevision: targetBase.revision,
      state: "idle",
    });
    const message = "terminal peer retention message";
    const oldRequest = {
      actorSessionId: actor.id,
      actorTurnId: actor.activeTurnId!,
      targetSessionId: target.id,
      expectedTargetRevision: target.revision,
      delivery: "queue" as const,
      requestDigest: testDigest("terminal peer retention request"),
      messageDigest: testDigest(message),
      reasonDigest: testDigest("terminal peer retention reason"),
      idempotencyKey: peerIdempotencyKey(54_000),
      message,
    };
    const old = store.admitPeerSessionAction(oldRequest);
    expect(store.transitionQueue(old.queue!.id, "pending", "cancelled")).toBe(true);
    const idleActor = store.setSessionTurnState({
      sessionId: actor.id,
      expectedRevision: actor.revision,
      state: "idle",
    });

    now += PEER_SESSION_ACTION_RETAIN_AGE_MS;
    const currentActor = store.setSessionTurnState({
      sessionId: idleActor.id,
      expectedRevision: idleActor.revision,
      state: "active",
      activeTurnId: "turn-peer-retention-current",
    });
    expect(store.admitPeerSessionAction(oldRequest)).toMatchObject({
      replay: true,
      action: { id: old.action.id },
      queue: { id: old.queue!.id },
    });
    const admitFresh = (index: number) => store.admitPeerSessionAction({
      actorSessionId: currentActor.id,
      actorTurnId: currentActor.activeTurnId!,
      targetSessionId: target.id,
      expectedTargetRevision: target.revision,
      delivery: "send",
      requestDigest: testDigest(`terminal retention fresh request ${String(index)}`),
      messageDigest: testDigest(`terminal retention fresh message ${String(index)}`),
      reasonDigest: testDigest("terminal retention fresh reason"),
      idempotencyKey: peerIdempotencyKey(54_001 + index),
    });
    admitFresh(0);
    expect(store.requirePeerSessionAction(old.action.id).state).toBe("cancelled");

    now += 1;
    const injector = new Database(store.paths.database, { create: false, strict: true });
    injector.exec(`
      CREATE TRIGGER peer_retention_test_abort
      BEFORE DELETE ON peer_session_actions
      BEGIN SELECT RAISE(ABORT, 'test peer retention abort'); END;
    `);
    injector.close(false);
    expect(() => admitFresh(1)).toThrow("test peer retention abort");
    expect(store.requireQueue(old.queue!.id)).toMatchObject({
      messageActor: "peer_session",
      peerActionId: old.action.id,
      state: "cancelled",
    });
    expect(store.readPeerSessionActionByIdempotencyKey(peerIdempotencyKey(54_002))).toBeNull();
    const repair = new Database(store.paths.database, { create: false, strict: true });
    repair.exec("DROP TRIGGER peer_retention_test_abort;");
    repair.close(false);

    expect(admitFresh(1)).toMatchObject({ replay: false });
    expect(() => store.requirePeerSessionAction(old.action.id)).toThrow("PEER_SESSION_NOT_FOUND");
    expect(store.requireQueue(old.queue!.id)).toMatchObject({
      messageActor: "peer_session",
      state: "cancelled",
    });
    expect(store.requireQueue(old.queue!.id)).not.toHaveProperty("peerActionId");
    expect(store.isPeerSessionMessageSource(target.id, old.queue!.id)).toBe(true);
    const inspector = new Database(store.paths.database, { readonly: true, strict: true });
    try {
      expect(inspector.query("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      inspector.close(false);
    }

    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const restarted = new StateStore(paths, { now: () => now });
    stores.push(restarted);
    expect(restarted.requireQueue(old.queue!.id)).toMatchObject({
      messageActor: "peer_session",
      state: "cancelled",
    });
    expect(restarted.requireQueue(old.queue!.id)).not.toHaveProperty("peerActionId");
    expect(restarted.isPeerSessionMessageSource(target.id, old.queue!.id)).toBe(true);
  });
test("pins unsettled actions and recursively required causal roots beyond the retention window", async () => {
    let now = 20_000;
    const { store, home } = await fixture({ now: () => now });
    const daemon = startInputFixtureDaemon(store);
    const root = join(home, "peer-retention-pins");
    await mkdir(root);
    const project = await store.createProject("Peer retention pins", root);
    const profile = signInProfile(store, "Peer retention pins", "peer-retention-pins@example.com");
    const createActive = (turnId: string) => {
      const created = createAuthorizedStartingTestSession(store, {
        profileId: profile.id,
        projectId: project.id,
        preset: "high",
        fastEnabled: false,
      });
      return store.setSessionTurnState({
        sessionId: created.id,
        expectedRevision: created.revision,
        state: "active",
        activeTurnId: turnId,
      });
    };
    const first = createActive("turn-peer-retention-first");
    const second = createActive("turn-peer-retention-second");
    const third = createActive("turn-peer-retention-third");
    const maintainer = createActive("turn-peer-retention-maintainer");
    const pendingTargetBase = createAuthorizedStartingTestSession(store, {
      profileId: profile.id,
      projectId: project.id,
      preset: "high",
      fastEnabled: false,
    });
    const pendingTarget = store.setSessionTurnState({
      sessionId: pendingTargetBase.id,
      expectedRevision: pendingTargetBase.revision,
      state: "idle",
    });
    let key = 55_000;
    const steer = (actor: typeof first, target: typeof first) => {
      const action = store.admitPeerSessionAction({
        actorSessionId: actor.id,
        actorTurnId: actor.activeTurnId!,
        targetSessionId: target.id,
        expectedTargetRevision: target.revision,
        delivery: "steer",
        requestDigest: testDigest(`retention causal request ${String(key)}`),
        messageDigest: testDigest(`retention causal message ${String(key)}`),
        reasonDigest: testDigest("retention causal reason"),
        idempotencyKey: peerIdempotencyKey(key++),
      }).action;
      store.beginPeerSessionActionEffect(action.id);
      return store.settlePeerSessionAction({
        actionId: action.id,
        expectedState: "effect_started",
        state: "applied",
        targetTurnId: target.activeTurnId!,
        resultDigest: testDigest(`retention causal result ${action.id}`),
      });
    };
    const rootAction = steer(first, second);
    const descendant = steer(second, third);
    expect(descendant.parentActionIds).toContain(rootAction.id);
    const actorPinned = store.admitPeerSessionAction({
      actorSessionId: maintainer.id,
      actorTurnId: maintainer.activeTurnId!,
      targetSessionId: pendingTarget.id,
      expectedTargetRevision: pendingTarget.revision,
      delivery: "send",
      requestDigest: testDigest("active actor retention request"),
      messageDigest: testDigest("active actor retention message"),
      reasonDigest: testDigest("active actor retention reason"),
      idempotencyKey: peerIdempotencyKey(key++),
    }).action;
    store.beginPeerSessionActionEffect(actorPinned.id);
    store.settlePeerSessionAction({
      actionId: actorPinned.id,
      expectedState: "effect_started",
      state: "failed",
      resultDigest: testDigest("active actor retention failed result"),
    });
    const unresolvedKey = peerIdempotencyKey(key++);
    const unresolvedMessage = "unresolved evidence retention message";
    const unresolvedPinned = store.admitPeerSessionAction({
      actorSessionId: first.id,
      actorTurnId: first.activeTurnId!,
      targetSessionId: pendingTarget.id,
      expectedTargetRevision: pendingTarget.revision,
      delivery: "send",
      requestDigest: testDigest("unresolved evidence retention request"),
      messageDigest: testDigest(unresolvedMessage),
      reasonDigest: testDigest("unresolved evidence retention reason"),
      idempotencyKey: unresolvedKey,
    }).action;
    store.prepareSessionInputMutation({
      ...daemon,
      kind: "session.send",
      sessionId: pendingTarget.id,
      providerAuthority: capturedProviderAuthorityForTest(store, pendingTarget.id),
      message: unresolvedMessage,
      attachments: [],
      idempotencyKey: unresolvedKey,
    });
    store.beginPeerSessionActionEffect(unresolvedPinned.id);
    store.settlePeerSessionAction({
      actionId: unresolvedPinned.id,
      expectedState: "effect_started",
      state: "failed",
      resultDigest: testDigest("unresolved evidence outer result"),
    });
    const pendingMessage = "unsettled retention queue";
    const pending = store.admitPeerSessionAction({
      actorSessionId: first.id,
      actorTurnId: first.activeTurnId!,
      targetSessionId: pendingTarget.id,
      expectedTargetRevision: pendingTarget.revision,
      delivery: "queue",
      requestDigest: testDigest("unsettled retention request"),
      messageDigest: testDigest(pendingMessage),
      reasonDigest: testDigest("unsettled retention reason"),
      idempotencyKey: peerIdempotencyKey(key++),
      message: pendingMessage,
    });
    const idleFirst = store.setSessionTurnState({
      sessionId: first.id,
      expectedRevision: first.revision,
      state: "idle",
    });
    store.setSessionTurnState({
      sessionId: second.id,
      expectedRevision: second.revision,
      state: "idle",
    });

    now += PEER_SESSION_ACTION_RETAIN_AGE_MS + 1;
    store.admitPeerSessionAction({
      actorSessionId: maintainer.id,
      actorTurnId: maintainer.activeTurnId!,
      targetSessionId: idleFirst.id,
      expectedTargetRevision: idleFirst.revision,
      delivery: "send",
      requestDigest: testDigest("retention maintenance request"),
      messageDigest: testDigest("retention maintenance message"),
      reasonDigest: testDigest("retention maintenance reason"),
      idempotencyKey: peerIdempotencyKey(key++),
    });
    expect(store.requirePeerSessionAction(rootAction.id).state).toBe("applied");
    expect(store.requirePeerSessionAction(descendant.id)).toMatchObject({
      state: "applied",
      parentActionIds: [rootAction.id],
      rootActionIds: [rootAction.id],
    });
    expect(store.requirePeerSessionAction(pending.action.id).state).toBe("queued");
    expect(store.requirePeerSessionAction(actorPinned.id).state).toBe("failed");
    expect(store.requirePeerSessionAction(unresolvedPinned.id).state).toBe("failed");
    expect(store.readMutation(unresolvedKey)).toMatchObject({ state: "prepared" });
    expect(() => store.admitPeerSessionAction({
      actorSessionId: third.id,
      actorTurnId: third.activeTurnId!,
      targetSessionId: idleFirst.id,
      expectedTargetRevision: idleFirst.revision,
      delivery: "send",
      requestDigest: testDigest("retention cycle request"),
      messageDigest: testDigest("retention cycle message"),
      reasonDigest: testDigest("retention cycle reason"),
      idempotencyKey: peerIdempotencyKey(key++),
    })).toThrow("PEER_SESSION_CYCLE_REFUSED");

    const idleThird = store.setSessionTurnState({
      sessionId: third.id,
      expectedRevision: third.revision,
      state: "idle",
    });
    store.admitPeerSessionAction({
      actorSessionId: maintainer.id,
      actorTurnId: maintainer.activeTurnId!,
      targetSessionId: idleThird.id,
      expectedTargetRevision: idleThird.revision,
      delivery: "send",
      requestDigest: testDigest("retention closed-subgraph maintenance request"),
      messageDigest: testDigest("retention closed-subgraph maintenance message"),
      reasonDigest: testDigest("retention closed-subgraph maintenance reason"),
      idempotencyKey: peerIdempotencyKey(key++),
    });
    expect(() => store.requirePeerSessionAction(rootAction.id)).toThrow("PEER_SESSION_NOT_FOUND");
    expect(() => store.requirePeerSessionAction(descendant.id)).toThrow("PEER_SESSION_NOT_FOUND");

    const reactivatedThird = store.setSessionTurnState({
      sessionId: idleThird.id,
      expectedRevision: idleThird.revision,
      state: "active",
      activeTurnId: third.activeTurnId!,
    });
    const postCompaction = store.admitPeerSessionAction({
      actorSessionId: reactivatedThird.id,
      actorTurnId: reactivatedThird.activeTurnId!,
      targetSessionId: idleFirst.id,
      expectedTargetRevision: idleFirst.revision,
      delivery: "send",
      requestDigest: testDigest("retention post-compaction request"),
      messageDigest: testDigest("retention post-compaction message"),
      reasonDigest: testDigest("retention post-compaction reason"),
      idempotencyKey: peerIdempotencyKey(key++),
    }).action;
    expect(postCompaction).toMatchObject({
      hop: 1,
      parentActionIds: [],
      rootActionIds: [postCompaction.id],
    });

    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const restarted = new StateStore(paths, { now: () => now });
    stores.push(restarted);
    expect(restarted.listUnsettledPeerSessionActions(10).map((action) => action.id))
      .toContain(pending.action.id);
    expect(restarted.requireQueue(pending.queue!.id)).toMatchObject({
      messageActor: "peer_session",
      peerActionId: pending.action.id,
      state: "pending",
    });
    expect(restarted.requirePeerSessionAction(unresolvedPinned.id).state).toBe("failed");
    expect(restarted.readMutation(unresolvedKey)).toMatchObject({ state: "prepared" });
  });
test("never carries peer causal parents across a project boundary", async () => {
    let now = 40_000;
    const { store, home } = await fixture({ now: () => now });
    const firstRoot = join(home, "peer-causal-project-a");
    const secondRoot = join(home, "peer-causal-project-b");
    await mkdir(firstRoot);
    await mkdir(secondRoot);
    const firstProject = await store.createProject("Peer causal project A", firstRoot);
    const secondProject = await store.createProject("Peer causal project B", secondRoot);
    const profile = signInProfile(store, "Peer causal account", "peer-causal@example.com");
    const createSession = (
      projectId: ProjectId,
      state: "active" | "idle",
      activeTurnId?: string,
    ) => {
      const created = createAuthorizedStartingTestSession(store, {
        profileId: profile.id,
        projectId,
        preset: "high",
        fastEnabled: false,
      });
      return store.setSessionTurnState({
        sessionId: created.id,
        expectedRevision: created.revision,
        state,
        ...(activeTurnId === undefined ? {} : { activeTurnId }),
      });
    };
    const source = createSession(firstProject.id, "active", "turn-peer-project-source");
    const movingBase = createSession(firstProject.id, "idle");
    const firstAction = store.admitPeerSessionAction({
      actorSessionId: source.id,
      actorTurnId: source.activeTurnId!,
      targetSessionId: movingBase.id,
      expectedTargetRevision: movingBase.revision,
      delivery: "send",
      requestDigest: testDigest("first project causal request"),
      messageDigest: testDigest("first project causal message"),
      reasonDigest: testDigest("first project causal reason"),
      idempotencyKey: peerIdempotencyKey(56_000),
    }).action;
    store.beginPeerSessionActionEffect(firstAction.id);
    store.settlePeerSessionAction({
      actionId: firstAction.id,
      expectedState: "effect_started",
      state: "applied",
      targetTurnId: "turn-peer-project-moving",
      resultDigest: testDigest("first project causal result"),
    });
    const movingActive = store.setSessionTurnState({
      sessionId: movingBase.id,
      expectedRevision: movingBase.revision,
      state: "active",
      activeTurnId: "turn-peer-project-moving",
    });
    expect(() => store.updateSessionMetadata({
      sessionId: movingActive.id,
      expectedRevision: movingActive.revision,
      projectId: secondProject.id,
    })).toThrow("SESSION_PROJECT_REQUIRES_IDLE");
    const movingIdle = store.setSessionTurnState({
      sessionId: movingActive.id,
      expectedRevision: movingActive.revision,
      state: "idle",
    });
    const moved = store.updateSessionMetadata({
      sessionId: movingIdle.id,
      expectedRevision: movingIdle.revision,
      projectId: secondProject.id,
    });
    const reactivated = store.setSessionTurnState({
      sessionId: moved.id,
      expectedRevision: moved.revision,
      state: "active",
      activeTurnId: "turn-peer-project-moving",
    });
    const secondTarget = createSession(secondProject.id, "idle");
    const secondAction = store.admitPeerSessionAction({
      actorSessionId: reactivated.id,
      actorTurnId: reactivated.activeTurnId!,
      targetSessionId: secondTarget.id,
      expectedTargetRevision: secondTarget.revision,
      delivery: "send",
      requestDigest: testDigest("second project causal request"),
      messageDigest: testDigest("second project causal message"),
      reasonDigest: testDigest("second project causal reason"),
      idempotencyKey: peerIdempotencyKey(56_001),
    }).action;
    expect(secondAction).toMatchObject({
      hop: 1,
      parentActionIds: [],
      projectId: secondProject.id,
      rootActionIds: [secondAction.id],
    });
    store.beginPeerSessionActionEffect(secondAction.id);
    store.settlePeerSessionAction({
      actionId: secondAction.id,
      expectedState: "effect_started",
      state: "failed",
      resultDigest: testDigest("second project causal result"),
    });
    store.setSessionTurnState({
      sessionId: source.id,
      expectedRevision: source.revision,
      state: "idle",
    });
    store.setSessionTurnState({
      sessionId: reactivated.id,
      expectedRevision: reactivated.revision,
      state: "idle",
    });

    now += PEER_SESSION_ACTION_RETAIN_AGE_MS + 1;
    const maintainer = createSession(firstProject.id, "active", "turn-peer-project-maintainer");
    const maintenanceTarget = createSession(firstProject.id, "idle");
    store.admitPeerSessionAction({
      actorSessionId: maintainer.id,
      actorTurnId: maintainer.activeTurnId!,
      targetSessionId: maintenanceTarget.id,
      expectedTargetRevision: maintenanceTarget.revision,
      delivery: "send",
      requestDigest: testDigest("first project maintenance request"),
      messageDigest: testDigest("first project maintenance message"),
      reasonDigest: testDigest("first project maintenance reason"),
      idempotencyKey: peerIdempotencyKey(56_002),
    });
    expect(() => store.requirePeerSessionAction(firstAction.id))
      .toThrow("PEER_SESSION_NOT_FOUND");
    expect(store.requirePeerSessionAction(secondAction.id)).toMatchObject({
      parentActionIds: [],
      projectId: secondProject.id,
      rootActionIds: [secondAction.id],
      state: "failed",
    });
  });
test("keeps protected peer capacity fail-closed with a seven-day aggregate-rate envelope", async () => {
    expect(PEER_SESSION_PROJECT_HOURLY_ACTION_LIMIT * 24 * 7).toBe(20_160);
    expect(
      PEER_SESSION_RETAINED_ACTION_LIMIT
        - PEER_SESSION_PROJECT_HOURLY_ACTION_LIMIT * 24 * 7,
    ).toBe(4_840);

    const { store, home } = await fixture({ now: () => 30_000 });
    const root = join(home, "peer-retention-capacity");
    await mkdir(root);
    const project = await store.createProject("Peer retention capacity", root);
    const profile = signInProfile(store, "Peer retention capacity", "peer-retention-capacity@example.com");
    const actorBase = createAuthorizedStartingTestSession(store, {
      profileId: profile.id,
      projectId: project.id,
      preset: "high",
      fastEnabled: false,
    });
    const actor = store.setSessionTurnState({
      sessionId: actorBase.id,
      expectedRevision: actorBase.revision,
      state: "active",
      activeTurnId: "turn-peer-retention-capacity",
    });
    const targetBase = createAuthorizedStartingTestSession(store, {
      profileId: profile.id,
      projectId: project.id,
      preset: "high",
      fastEnabled: false,
    });
    const target = store.setSessionTurnState({
      sessionId: targetBase.id,
      expectedRevision: targetBase.revision,
      state: "idle",
    });
    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const seed = new Database(paths.database, { create: false, strict: true });
    const retainedQuotaSql = seed.query(
      "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='peer_session_action_retained_quota'",
    ).get() as { sql: string } | null;
    expect(retainedQuotaSql?.sql).toBeString();
    seed.exec(`
      PRAGMA foreign_keys=ON;
      DROP TRIGGER peer_session_action_retained_quota;
      WITH RECURSIVE counter(value) AS (
        SELECT 1
        UNION ALL
        SELECT value+1 FROM counter WHERE value<${String(PEER_SESSION_RETAINED_ACTION_LIMIT)}
      )
      INSERT INTO peer_session_actions(
        id,idempotency_key,actor_session_id,actor_turn_digest,project_id,
        actor_policy_revision,target_session_id,target_expected_revision,
        target_policy_revision,delivery,request_digest,message_digest,reason_digest,
        state,hop,target_turn_digest,result_digest,created_at,updated_at
      )
      SELECT
        'peer_' || printf('%032x',value),
        '30000000-0000-4000-8000-' || printf('%012x',value),
        '${actor.id}','${testDigest(actor.activeTurnId!)}','${project.id}',
        1,'${target.id}',${String(target.revision)},1,'send',
        '${testDigest("capacity request")}',
        '${testDigest("capacity message")}',
        '${testDigest("capacity reason")}',
        'prepared',1,NULL,NULL,1,1
      FROM counter;
    `);
    seed.exec(retainedQuotaSql!.sql);
    seed.close(false);
    const filled = new StateStore(paths, { now: () => 30_000 });
    stores.push(filled);
    expect(() => filled.admitPeerSessionAction({
      actorSessionId: actor.id,
      actorTurnId: actor.activeTurnId!,
      targetSessionId: target.id,
      expectedTargetRevision: target.revision,
      delivery: "send",
      requestDigest: testDigest("capacity refused request"),
      messageDigest: testDigest("capacity refused message"),
      reasonDigest: testDigest("capacity refused reason"),
      idempotencyKey: peerIdempotencyKey(56_000),
    })).toThrow("PEER_SESSION_RETENTION_LIMIT_REFUSED");
  });
test("lists bounded unsettled peer and memory effects across restart for reconciliation", async () => {
    const { store, home } = await fixture();
    const root = join(home, "control-plane-reconciliation");
    await mkdir(root);
    const project = await store.createProject("Control plane reconciliation", root);
    const profile = signInProfile(store, "Control plane reconciliation", "reconcile@example.com");
    const actorBase = createAuthorizedStartingTestSession(store, {
      profileId: profile.id,
      projectId: project.id,
      preset: "high",
      fastEnabled: false,
    });
    const actor = store.setSessionTurnState({
      sessionId: actorBase.id,
      expectedRevision: actorBase.revision,
      state: "active",
      activeTurnId: "turn-reconciliation-actor",
    });
    const secondRoot = join(home, "control-plane-reconciliation-second");
    await mkdir(secondRoot);
    const secondProject = await store.createProject(
      "Control plane reconciliation second",
      secondRoot,
    );
    const secondActor = createAuthorizedStartingTestSession(store, {
      profileId: profile.id,
      projectId: secondProject.id,
      preset: "high",
      fastEnabled: false,
    });
    const targetBase = createAuthorizedStartingTestSession(store, {
      profileId: profile.id,
      projectId: project.id,
      preset: "high",
      fastEnabled: false,
    });
    const target = store.setSessionTurnState({
      sessionId: targetBase.id,
      expectedRevision: targetBase.revision,
      state: "idle",
    });
    const admit = (index: number, delivery: "send" | "queue") => {
      const message = `reconciliation message ${String(index)}`;
      return store.admitPeerSessionAction({
        actorSessionId: actor.id,
        actorTurnId: actor.activeTurnId!,
        targetSessionId: target.id,
        expectedTargetRevision: target.revision,
        delivery,
        requestDigest: testDigest(`reconciliation request ${String(index)}`),
        messageDigest: testDigest(message),
        reasonDigest: testDigest(`reconciliation reason ${String(index)}`),
        idempotencyKey: peerIdempotencyKey(50_000 + index),
        ...(delivery === "queue" ? { message } : {}),
      });
    };
    const ambiguousPeer = admit(0, "send").action;
    store.beginPeerSessionActionEffect(ambiguousPeer.id);
    store.settlePeerSessionAction({
      actionId: ambiguousPeer.id,
      expectedState: "effect_started",
      state: "ambiguous",
      resultDigest: testDigest("crash observation peer"),
    });
    const preparedPeer = admit(1, "send").action;
    const queuedPeer = admit(2, "queue").action;
    const appliedPeer = admit(3, "send").action;
    store.beginPeerSessionActionEffect(appliedPeer.id);
    store.settlePeerSessionAction({
      actionId: appliedPeer.id,
      expectedState: "effect_started",
      state: "applied",
      targetTurnId: "turn-reconciliation-applied",
      resultDigest: testDigest("applied peer receipt"),
    });

    const emptyHead = PROJECT_MEMORY_EMPTY_HEAD;
    reserveTestProjectMemoryAuthority(store, project.id, emptyHead);
    reserveTestProjectMemoryAuthority(store, secondProject.id, emptyHead);
    const prepareMemory = (
      index: number,
      memoryActor = actor,
      memoryProject = project,
    ) => {
      const record = store.prepareMemorySubmission({
        actorSessionId: memoryActor.id,
        projectId: memoryProject.id,
        kind: "remember",
        requestDigest: testDigest(`memory reconciliation request ${String(index)}`),
        contentDigest: testDigest(`memory reconciliation content ${String(index)}`),
        keyDigest: testDigest(`memory reconciliation key ${String(index)}`),
        workingBindingDigest: testDigest("memory reconciliation working binding"),
        workingEpoch: 1,
        expectedHead: emptyHead,
        idempotencyKey: peerIdempotencyKey(51_000 + index),
      }).record;
      return store.bindMemorySubmissionEffect({
        submissionId: record.id,
        effectRecordSha256: testDigest(`memory reconciliation record ${String(index)}`),
        attestationSha256: testDigest(`memory reconciliation attestation ${String(index)}`),
        operationId: `memory_reconciliation_${String(index)}`,
      });
    };
    const ambiguousMemory = prepareMemory(0);
    store.beginMemorySubmission(ambiguousMemory.id);
    store.settleMemorySubmission({
      submissionId: ambiguousMemory.id,
      expectedState: "effect_started",
      state: "ambiguous",
    });
    expect(() => prepareMemory(1)).toThrow("MEMORY_RECOVERY_REQUIRED");
    const preparedMemory = prepareMemory(1, secondActor, secondProject);

    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const restarted = new StateStore(paths);
    stores.push(restarted);
    expect(restarted.listUnsettledPeerSessionActions(1).map((action) => action.id))
      .toEqual([ambiguousPeer.id]);
    expect(restarted.listUnsettledPeerSessionActions(3).map((action) => action.id))
      .toEqual([ambiguousPeer.id, preparedPeer.id, queuedPeer.id]);
    expect(restarted.listUnsettledMemorySubmissions(1).map((submission) => submission.id))
      .toEqual([ambiguousMemory.id]);
    expect(restarted.listUnsettledMemorySubmissions(2).map((submission) => submission.id))
      .toEqual([ambiguousMemory.id, preparedMemory.id]);
    expect(restarted.settlePeerSessionAction({
      actionId: ambiguousPeer.id,
      expectedState: "ambiguous",
      state: "failed",
    }).state).toBe("failed");
    expect(restarted.settleMemorySubmission({
      submissionId: ambiguousMemory.id,
      expectedState: "ambiguous",
      state: "failed",
      outcomeCode: "remember_not_applied",
    }).state).toBe("failed");
    expect(() => restarted.listUnsettledPeerSessionActions(0)).toThrow();
    expect(() => restarted.listUnsettledMemorySubmissions(
      CONTROL_PLANE_RECONCILIATION_BATCH_LIMIT + 1,
    )).toThrow();
  });
test("revalidates direct peer authority at replay and begin and joins its nested mutation exactly", async () => {
    const { store, home } = await fixture();
    const daemon = startInputFixtureDaemon(store);
    const root = join(home, "peer-begin-authority");
    await mkdir(root);
    const project = await store.createProject("Peer begin authority", root);
    const profile = signInProfile(store, "Peer begin authority", "peer-begin@example.com");
    const actorBase = createAuthorizedStartingTestSession(store, {
      profileId: profile.id,
      projectId: project.id,
      preset: "high",
      fastEnabled: false,
    });
    const actor = store.setSessionTurnState({
      sessionId: actorBase.id,
      expectedRevision: actorBase.revision,
      state: "active",
      activeTurnId: "turn-peer-begin",
    });
    const targetBase = createAuthorizedStartingTestSession(store, {
      profileId: profile.id,
      projectId: project.id,
      preset: "high",
      fastEnabled: false,
    });
    const target = store.bindSession({
      sessionId: targetBase.id,
      expectedRevision: targetBase.revision,
      providerThreadId: "thread-peer-begin-authority",
      state: "idle",
    });
    const key = peerIdempotencyKey(52_000);
    const request = {
      actorSessionId: actor.id,
      actorTurnId: actor.activeTurnId!,
      targetSessionId: target.id,
      expectedTargetRevision: target.revision,
      delivery: "send" as const,
      requestDigest: testDigest("peer begin request"),
      messageDigest: testDigest("peer begin message"),
      reasonDigest: testDigest("peer begin reason"),
      idempotencyKey: key,
    };
    const action = store.admitPeerSessionAction(request).action;
    expect(() => store.prepareSessionInputMutation({
      ...daemon,
      kind: "session.send",
      sessionId: target.id,
      providerAuthority: capturedProviderAuthorityForTest(store, target.id),
      message: "different peer begin message",
      attachments: [],
      idempotencyKey: key,
    })).toThrow("PEER_SESSION_MESSAGE_DIGEST_MISMATCH");
    expect(store.readMutation(key)).toBeNull();
    expect(store.requirePeerSessionAction(action.id).state).toBe("prepared");
    const { attempt } = store.prepareSessionInputMutation({
      ...daemon,
      kind: "session.send",
      sessionId: target.id,
      providerAuthority: capturedProviderAuthorityForTest(store, target.id),
      message: "peer begin message",
      attachments: [],
      idempotencyKey: key,
    });
    expect(() => store.beginSessionMutationEffect({
      ...daemon,
      attachments: [],
      providerAuthority: capturedProviderAuthorityForTest(store, target.id),
      transcript: {
        accountId: store.requireSession(target.id).profileId,
        providerGeneration: profile.processGeneration,
        providerConnectionId: "10000000-0000-4000-8000-000000000099",
        actor: "peer_session",
        message: "different peer begin message",
      },
      attemptId: attempt.id,
      sessionId: target.id,
      profileGeneration: profile.processGeneration,
      message: "different peer begin message",
      evidence: {
        kind: "session.send",
        providerThreadId: "thread-peer-begin-authority",
        baseline: { providerUpdatedAt: null, status: "idle", activeTurnId: null },
        clientMessageId: attempt.id,
        messageDigest: testDigest("different peer begin message"),
        runtimeProfile: codexRuntimeProfile(profile),
        messageActor: "peer_session",
      },
    })).toThrow("PEER_SESSION_MESSAGE_DIGEST_MISMATCH");
    expect(store.readMutation(key)?.state).toBe("prepared");
    expect(store.readMutation(key)?.evidence).toBeUndefined();
    expect(store.requirePeerSessionAction(action.id).state).toBe("prepared");
    expect(store.readPeerSessionDirectMessageSource(key)).not.toBeNull();
    expect(store.readPeerSessionMutationJoin(key)).toMatchObject({
      action: { id: action.id },
      attempt: { id: attempt.id },
    });

    const steerTargetBase = createAuthorizedStartingTestSession(store, {
      profileId: profile.id,
      projectId: project.id,
      preset: "high",
      fastEnabled: false,
    });
    const steerTarget = store.bindSession({
      sessionId: steerTargetBase.id,
      expectedRevision: steerTargetBase.revision,
      providerThreadId: "thread-peer-begin-steer",
      state: "active",
      activeTurnId: "turn-peer-begin-steer",
    });
    const steerMessage = "peer steer message";
    const steerMismatch = "different peer steer message";
    const steerKey = peerIdempotencyKey(52_002);
    const steerAction = store.admitPeerSessionAction({
      actorSessionId: actor.id,
      actorTurnId: actor.activeTurnId!,
      targetSessionId: steerTarget.id,
      expectedTargetRevision: steerTarget.revision,
      delivery: "steer",
      requestDigest: testDigest("peer steer request"),
      messageDigest: testDigest(steerMessage),
      reasonDigest: testDigest("peer steer reason"),
      idempotencyKey: steerKey,
    }).action;
    expect(() => store.prepareSessionInputMutation({
      ...daemon,
      kind: "session.steer",
      sessionId: steerTarget.id,
      providerAuthority: capturedProviderAuthorityForTest(store, steerTarget.id),
      message: steerMismatch,
      attachments: [],
      idempotencyKey: steerKey,
    })).toThrow("PEER_SESSION_MESSAGE_DIGEST_MISMATCH");
    const { attempt: steerAttempt } = store.prepareSessionInputMutation({
      ...daemon,
      kind: "session.steer",
      sessionId: steerTarget.id,
      providerAuthority: capturedProviderAuthorityForTest(store, steerTarget.id),
      message: steerMessage,
      attachments: [],
      idempotencyKey: steerKey,
    });
    expect(() => store.beginSessionMutationEffect({
      ...daemon,
      attachments: [],
      providerAuthority: capturedProviderAuthorityForTest(store, steerTarget.id),
      transcript: {
        accountId: store.requireSession(steerTarget.id).profileId,
        providerGeneration: profile.processGeneration,
        providerConnectionId: "10000000-0000-4000-8000-000000000099",
        actor: "peer_session",
        message: steerMismatch,
      },
      attemptId: steerAttempt.id,
      sessionId: steerTarget.id,
      profileGeneration: profile.processGeneration,
      message: steerMismatch,
      evidence: {
        kind: "session.steer",
        providerThreadId: "thread-peer-begin-steer",
        baseline: {
          providerUpdatedAt: null,
          status: "active",
          activeTurnId: "turn-peer-begin-steer",
        },
        activeTurnId: "turn-peer-begin-steer",
        clientMessageId: steerAttempt.id,
        messageDigest: testDigest(steerMismatch),
        messageActor: "peer_session",
      },
    })).toThrow("PEER_SESSION_MESSAGE_DIGEST_MISMATCH");
    expect(store.readMutation(steerKey)?.state).toBe("prepared");
    expect(store.readMutation(steerKey)?.evidence).toBeUndefined();
    expect(store.requirePeerSessionAction(steerAction.id).state).toBe("prepared");

    const queueTargetBase = createAuthorizedStartingTestSession(store, {
      profileId: profile.id,
      projectId: project.id,
      preset: "high",
      fastEnabled: false,
    });
    const queueTarget = store.bindSession({
      sessionId: queueTargetBase.id,
      expectedRevision: queueTargetBase.revision,
      providerThreadId: "thread-peer-begin-queue",
      state: "idle",
    });
    const queueMessage = "peer queue message";
    const queueMismatch = "different peer queue message";
    const queued = store.admitPeerSessionAction({
      actorSessionId: actor.id,
      actorTurnId: actor.activeTurnId!,
      targetSessionId: queueTarget.id,
      expectedTargetRevision: queueTarget.revision,
      delivery: "queue",
      requestDigest: testDigest("peer queue request"),
      messageDigest: testDigest(queueMessage),
      reasonDigest: testDigest("peer queue reason"),
      idempotencyKey: peerIdempotencyKey(52_003),
      message: queueMessage,
    });
    expect(() => store.beginQueueEffect({
      providerAuthority: capturedProviderAuthorityForTest(store, queueTarget.id),
      queueId: queued.queue!.id,
      sessionId: queueTarget.id,
      profileGeneration: profile.processGeneration,
      providerConnectionId: "10000000-0000-4000-8000-000000000099",
      evidence: {
        kind: "queue.dispatch",
        queueId: queued.queue!.id,
        sessionId: queueTarget.id,
        providerThreadId: "thread-peer-begin-queue",
        profileGeneration: profile.processGeneration,
        baseline: { providerUpdatedAt: null, status: "idle", activeTurnId: null },
        clientMessageId: queued.queue!.id,
        messageDigest: testDigest(queueMismatch),
        runtimeProfile: codexRuntimeProfile(profile),
      },
    })).toThrow("QUEUE_EFFECT_AUTHORITY_CHANGED");
    expect(store.requireQueue(queued.queue!.id).state).toBe("pending");
    expect(store.readQueueEffect(queued.queue!.id)).toBeNull();
    expect(store.requirePeerSessionAction(queued.action.id).state).toBe("queued");

    // Model a pre-fix/corrupt join whose queue still holds A but whose action
    // digest claims B. The action/evidence comparison must fail independently
    // of the queue/body comparison and roll the evidence insert back.
    const queueCorruptor = new Database(store.paths.database, { create: false, strict: true });
    const transitionTrigger = z.object({ sql: z.string() }).strict().parse(
      queueCorruptor.query(
        "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='peer_session_action_transition_guard'",
      ).get(),
    );
    queueCorruptor.exec("DROP TRIGGER peer_session_action_transition_guard");
    queueCorruptor.query(
      "UPDATE peer_session_actions SET message_digest=? WHERE id=?",
    ).run(testDigest(queueMismatch), queued.action.id);
    queueCorruptor.exec(transitionTrigger.sql);
    queueCorruptor.close(false);
    expect(() => store.beginQueueEffect({
      providerAuthority: capturedProviderAuthorityForTest(store, queueTarget.id),
      queueId: queued.queue!.id,
      sessionId: queueTarget.id,
      profileGeneration: profile.processGeneration,
      providerConnectionId: "10000000-0000-4000-8000-000000000099",
      evidence: {
        kind: "queue.dispatch",
        queueId: queued.queue!.id,
        sessionId: queueTarget.id,
        providerThreadId: "thread-peer-begin-queue",
        profileGeneration: profile.processGeneration,
        baseline: { providerUpdatedAt: null, status: "idle", activeTurnId: null },
        clientMessageId: queued.queue!.id,
        messageDigest: testDigest(queueMessage),
        runtimeProfile: codexRuntimeProfile(profile),
      },
    })).toThrow("QUEUE_PEER_ACTION_AUTHORITY_CHANGED");
    expect(store.requireQueue(queued.queue!.id).state).toBe("pending");
    expect(store.readQueueEffect(queued.queue!.id)).toBeNull();
    expect(store.requirePeerSessionAction(queued.action.id).state).toBe("queued");

    const mismatchedSteerEvidence = {
      kind: "session.steer" as const,
      providerThreadId: "thread-peer-begin-steer",
      baseline: {
        providerUpdatedAt: null,
        status: "active" as const,
        activeTurnId: "turn-peer-begin-steer",
      },
      activeTurnId: "turn-peer-begin-steer",
      clientMessageId: steerAttempt.id,
      messageDigest: testDigest(steerMismatch),
      messageActor: "peer_session" as const,
    };
    const mismatchedCanonical = JSON.stringify(mismatchedSteerEvidence);
    const joinInjector = new Database(store.paths.database, { create: false, strict: true });
    // Current joined SQL rejects an invented evidence row before it can become
    // a readable historical join. This is a current admission negative, not
    // an archived writer receipt with fabricated provenance.
    expect(() => joinInjector.query(
      `INSERT INTO mutation_effect_evidence(
         attempt_id,kind,evidence_json,evidence_digest,recorded_at
       ) VALUES (?,?,?,?,?)`,
    ).run(
      steerAttempt.id,
      "session.steer",
      mismatchedCanonical,
      testDigest(mismatchedCanonical),
      2_000,
    )).toThrow("EFFECT_EVIDENCE_PROVENANCE_CORRUPT");
    joinInjector.close(false);
    expect(store.readPeerSessionMutationJoin(steerKey)).toMatchObject({
      action: { id: steerAction.id }, attempt: { id: steerAttempt.id, state: "prepared" },
    });
    expect(store.readMutation(steerKey)?.evidence).toBeUndefined();
    expect(store.requirePeerSessionAction(steerAction.id).state).toBe("prepared");

    expect(store.beginPeerSessionActionEffect(action.id).state).toBe("effect_started");
    // A crash after the outer begin but before the exact same-key nested begin
    // is resumable without rewriting either ledger.
    expect(store.beginPeerSessionActionEffect(action.id).state).toBe("effect_started");
    store.settlePeerSessionAction({
      actionId: action.id,
      expectedState: "effect_started",
      state: "ambiguous",
    });
    expect(store.beginPeerSessionActionEffect(action.id).state).toBe("ambiguous");
    store.beginSessionMutationEffect({
      ...daemon,
      attachments: [],
      providerAuthority: capturedProviderAuthorityForTest(store, target.id),
      attemptId: attempt.id,
      sessionId: target.id,
      profileGeneration: profile.processGeneration,
      message: "peer begin message",
      transcript: {
        accountId: profile.id, providerGeneration: profile.processGeneration,
        providerConnectionId: "10000000-0000-4000-8000-000000000099",
        actor: "peer_session", message: "peer begin message",
      },
      evidence: {
        kind: "session.send", providerThreadId: "thread-peer-begin-authority",
        baseline: { providerUpdatedAt: null, status: "idle", activeTurnId: null },
        clientMessageId: attempt.id, messageDigest: testDigest("peer begin message"),
        runtimeProfile: codexRuntimeProfile(profile), messageActor: "peer_session",
      },
    });
    expect(() => store.beginPeerSessionActionEffect(action.id))
      .toThrow("PEER_SESSION_NESTED_MUTATION_NOT_RESUMABLE");
    store.setPeerSessionPolicy({
      sessionId: target.id,
      expectedRevision: 1,
      mode: "inspect",
    });
    expect(() => store.admitPeerSessionAction(request))
      .toThrow("PEER_SESSION_POLICY_REVISION_CONFLICT");
    expect(() => store.beginPeerSessionActionEffect(action.id))
      .toThrow("PEER_SESSION_POLICY_REVISION_CONFLICT");
    expect(store.requirePeerSessionAction(action.id).state).toBe("ambiguous");
  });
test("retains direct peer attribution through compaction and cancels provably unstarted joins", async () => {
    let now = 40_000;
    const { store, home } = await fixture({ now: () => now++ });
    const daemon = startInputFixtureDaemon(store);
    const root = join(home, "peer-direct-retention");
    await mkdir(root);
    const project = await store.createProject("Peer direct retention", root);
    const profile = signInProfile(store, "Peer direct retention", "peer-direct@example.com");
    const actorBase = createAuthorizedStartingTestSession(store, {
      profileId: profile.id,
      projectId: project.id,
      preset: "high",
      fastEnabled: false,
    });
    let actor: SessionRecord = store.setSessionTurnState({
      sessionId: actorBase.id,
      expectedRevision: actorBase.revision,
      state: "active",
      activeTurnId: "turn-peer-direct-origin",
    });
    const createTarget = (thread: string) => {
      const created = createAuthorizedStartingTestSession(store, {
        profileId: profile.id,
        projectId: project.id,
        preset: "high",
        fastEnabled: false,
      });
      return store.bindSession({
        sessionId: created.id,
        expectedRevision: created.revision,
        providerThreadId: thread,
        state: "idle",
      });
    };
    const target = createTarget("thread-peer-direct-retained");
    const message = "retained peer message";
    const key = peerIdempotencyKey(72_000);
    const request = {
      actorSessionId: actor.id,
      actorTurnId: actor.activeTurnId!,
      targetSessionId: target.id,
      expectedTargetRevision: target.revision,
      delivery: "send" as const,
      requestDigest: testDigest("retained peer request"),
      messageDigest: testDigest(message),
      reasonDigest: testDigest("retained peer reason"),
      idempotencyKey: key,
    };
    const action = store.admitPeerSessionAction(request).action;
    const { attempt } = store.prepareSessionInputMutation({
      ...daemon,
      kind: "session.send",
      sessionId: target.id,
      providerAuthority: capturedProviderAuthorityForTest(store, target.id),
      message,
      attachments: [],
      idempotencyKey: key,
    });
    const runtime = codexRuntimeProfile(profile);
    const evidence = store.beginSessionMutationEffect({
      ...daemon,
      attachments: [],
      providerAuthority: capturedProviderAuthorityForTest(store, target.id),
      transcript: {
        accountId: store.requireSession(target.id).profileId,
        providerGeneration: profile.processGeneration,
        providerConnectionId: "10000000-0000-4000-8000-000000000099",
        actor: store.sessionMessageActorForSource(target.id, attempt.id) ?? "human",
        message: message,
      },
      attemptId: attempt.id,
      sessionId: target.id,
      profileGeneration: profile.processGeneration,
      message,
      evidence: {
        kind: "session.send",
        providerThreadId: "thread-peer-direct-retained",
        baseline: { providerUpdatedAt: null, status: "idle", activeTurnId: null },
        clientMessageId: attempt.id,
        messageDigest: testDigest(message),
        runtimeProfile: runtime,
      },
    });
    expect(evidence.evidence).toMatchObject({ messageActor: "peer_session" });
    expect(store.requirePeerSessionAction(action.id).state).toBe("effect_started");
    expect(store.readPeerSessionDirectMessageSource(key)).toBeNull();
    const appended = store.completeSessionTurnEffect({
      providerAuthority: capturedProviderAuthorityForTest(store, target.id),
      attemptId: attempt.id,
      sessionId: target.id,
      accountId: profile.id,
      providerGeneration: profile.processGeneration,
      providerConnectionId: "10000000-0000-4000-8000-000000000099",
      expectedSessionRevision: target.revision,
      applyResponseState: false,
      turnId: "turn-peer-direct-target",
      turnStatus: "completed",
      runtimeProfile: runtime,
      message,
      receipt: { turnId: "turn-peer-direct-target" },
    });
    expect(appended.event.body).toMatchObject({
      type: "user_message",
      actor: "peer_session",
      text: message,
    });
    store.settlePeerSessionAction({
      actionId: action.id,
      expectedState: "effect_started",
      state: "applied",
      targetTurnId: "turn-peer-direct-target",
      resultDigest: testDigest("retained peer result"),
    });

    actor = store.setSessionTurnState({
      sessionId: actor.id,
      expectedRevision: actor.revision,
      state: "idle",
    });
    actor = store.setSessionTurnState({
      sessionId: actor.id,
      expectedRevision: actor.revision,
      state: "active",
      activeTurnId: "turn-peer-direct-next",
    });
    now += PEER_SESSION_ACTION_RETAIN_AGE_MS + 1;
    const cleanupMessage = "new peer message";
    store.admitPeerSessionAction({
      actorSessionId: actor.id,
      actorTurnId: actor.activeTurnId!,
      targetSessionId: target.id,
      expectedTargetRevision: target.revision,
      delivery: "send",
      requestDigest: testDigest("new peer request"),
      messageDigest: testDigest(cleanupMessage),
      reasonDigest: testDigest("new peer reason"),
      idempotencyKey: peerIdempotencyKey(72_001),
    });
    expect(() => store.requirePeerSessionAction(action.id)).toThrow("PEER_SESSION_NOT_FOUND");
    expect(store.sessionMessageActorForSource(target.id, attempt.id)).toBe("peer_session");
    expect(store.readPeerSessionMutationJoin(key)).toMatchObject({
      action: null,
      attempt: { id: attempt.id, state: "applied" },
    });
    expect(() => store.admitPeerSessionAction(request))
      .toThrow("PEER_SESSION_IDEMPOTENCY_CONFLICT");

    const crashTarget = createTarget("thread-peer-direct-crash");
    const crashKey = peerIdempotencyKey(72_002);
    const crashAction = store.admitPeerSessionAction({
      actorSessionId: actor.id,
      actorTurnId: actor.activeTurnId!,
      targetSessionId: crashTarget.id,
      expectedTargetRevision: crashTarget.revision,
      delivery: "send",
      requestDigest: testDigest("crash peer request"),
      messageDigest: testDigest("crash peer message"),
      reasonDigest: testDigest("crash peer reason"),
      idempotencyKey: crashKey,
    }).action;
    store.beginPeerSessionActionEffect(crashAction.id);
    store.settlePeerSessionAction({
      actionId: crashAction.id,
      expectedState: "effect_started",
      state: "ambiguous",
    });
    store.updateSessionMetadata({
      sessionId: crashTarget.id,
      expectedRevision: crashTarget.revision,
      note: "revision moved before provider dispatch",
    });

    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const restarted = new StateStore(paths, { now: () => now++ });
    stores.push(restarted);
    const cancelled = restarted.cancelUnstartedPeerSessionDirectAction({
      actionId: crashAction.id,
      diagnosticCode: "PEER_SESSION_PROVIDER_EFFECT_NOT_STARTED",
    });
    expect(cancelled.state).toBe("cancelled");
    expect(restarted.readMutation(crashKey)).toMatchObject({
      kind: "peer.session.cancel",
      authorityGeneration: 0,
      state: "cancelled",
    });
    expect(restarted.readMutation(crashKey)?.result).toMatchObject({
      version: 1, peerActionId: crashAction.id, providerEffectStarted: false,
    });
    expect(restarted.readPeerSessionDirectMessageSource(crashKey)).toBeNull();
    expect(restarted.cancelUnstartedPeerSessionDirectAction({
      actionId: crashAction.id,
      diagnosticCode: "PEER_SESSION_PROVIDER_EFFECT_NOT_STARTED",
    })).toEqual(cancelled);

    const preparedBase = createAuthorizedStartingTestSession(restarted, {
      profileId: profile.id,
      projectId: project.id,
      preset: "high",
      fastEnabled: false,
    });
    const preparedTarget = restarted.bindSession({
      sessionId: preparedBase.id,
      expectedRevision: preparedBase.revision,
      providerThreadId: "thread-peer-direct-prepared",
      state: "idle",
    });
    const preparedKey = peerIdempotencyKey(72_003);
    const preparedAction = restarted.admitPeerSessionAction({
      actorSessionId: actor.id,
      actorTurnId: actor.activeTurnId!,
      targetSessionId: preparedTarget.id,
      expectedTargetRevision: preparedTarget.revision,
      delivery: "send",
      requestDigest: testDigest("prepared peer envelope"),
      messageDigest: testDigest("prepared peer message"),
      reasonDigest: testDigest("prepared peer reason"),
      idempotencyKey: preparedKey,
    }).action;
    restarted.prepareSessionInputMutation({
      ...daemon,
      kind: "session.send",
      sessionId: preparedTarget.id,
      providerAuthority: capturedProviderAuthorityForTest(restarted, preparedTarget.id),
      message: "prepared peer message",
      attachments: [],
      idempotencyKey: preparedKey,
    });
    restarted.beginPeerSessionActionEffect(preparedAction.id);
    expect(restarted.cancelUnstartedPeerSessionDirectAction({
      actionId: preparedAction.id,
      diagnosticCode: "PEER_SESSION_PROVIDER_EFFECT_NOT_STARTED",
    }).state).toBe("cancelled");
    expect(restarted.readMutation(preparedKey)?.state).toBe("cancelled");
  });
test("requires peer queue evidence and preserves unresolved current corruption without inventing recovery proof", async () => {
    const { store, home } = await fixture();
    const root = join(home, "peer-queue-evidence");
    await mkdir(root);
    const project = await store.createProject("Peer queue evidence", root);
    const profile = signInProfile(store, "Peer queue evidence", "peer-queue-evidence@example.com");
    const actorBase = createAuthorizedStartingTestSession(store, {
      profileId: profile.id,
      projectId: project.id,
      preset: "high",
      fastEnabled: false,
    });
    const actor = store.setSessionTurnState({
      sessionId: actorBase.id,
      expectedRevision: actorBase.revision,
      state: "active",
      activeTurnId: "turn-peer-queue-evidence",
    });
    const targetBase = createAuthorizedStartingTestSession(store, {
      profileId: profile.id,
      projectId: project.id,
      preset: "high",
      fastEnabled: false,
    });
    const target = store.bindSession({
      sessionId: targetBase.id,
      expectedRevision: targetBase.revision,
      providerThreadId: "thread-peer-queue-evidence",
      state: "idle",
    });
    const message = "evidence must precede dispatch";
    const admitted = store.admitPeerSessionAction({
      actorSessionId: actor.id,
      actorTurnId: actor.activeTurnId!,
      targetSessionId: target.id,
      expectedTargetRevision: target.revision,
      delivery: "queue",
      requestDigest: testDigest("peer queue evidence request"),
      messageDigest: testDigest(message),
      reasonDigest: testDigest("peer queue evidence reason"),
      idempotencyKey: peerIdempotencyKey(52_001),
      message,
    });
    expect(() => store.transitionQueue(admitted.queue!.id, "pending", "dispatching"))
      .toThrow("PEER_QUEUE_EFFECT_EVIDENCE_REQUIRED");
    const provedBase = createAuthorizedStartingTestSession(store, {
      profileId: profile.id, projectId: project.id, preset: "high", fastEnabled: false,
    });
    const provedTarget = store.bindSession({
      sessionId: provedBase.id, expectedRevision: provedBase.revision,
      providerThreadId: "thread-peer-proved-queue-evidence", state: "idle",
    });
    const proved = store.admitPeerSessionAction({
      actorSessionId: actor.id, actorTurnId: actor.activeTurnId!,
      targetSessionId: provedTarget.id, expectedTargetRevision: provedTarget.revision,
      delivery: "queue", requestDigest: testDigest("proved peer queue request"),
      messageDigest: testDigest(message), reasonDigest: testDigest("proved peer queue reason"),
      idempotencyKey: peerIdempotencyKey(52_004), message,
    });
    store.beginQueueEffect({
      providerAuthority: capturedProviderAuthorityForTest(store, provedTarget.id),
      queueId: proved.queue!.id, sessionId: provedTarget.id,
      profileGeneration: profile.processGeneration,
      providerConnectionId: "10000000-0000-4000-8000-000000000099",
      evidence: {
        kind: "queue.dispatch", queueId: proved.queue!.id, sessionId: provedTarget.id,
        providerThreadId: "thread-peer-proved-queue-evidence", profileGeneration: profile.processGeneration,
        baseline: { providerUpdatedAt: null, status: "idle", activeTurnId: null },
        clientMessageId: proved.queue!.id, messageDigest: testDigest(message),
        runtimeProfile: codexRuntimeProfile(profile),
      },
    });
    expect(store.recoverDispatchingQueueEffects()).toEqual({ recovered: [proved.queue!.id], unresolved: [] });
    expect(store.requireQueue(proved.queue!.id).state).toBe("ambiguous");
    expect(store.requireSession(provedTarget.id).state).toBe("recovery_required");
    expect(store.readQueueEffect(proved.queue!.id)).not.toBeNull();
    const injector = new Database(store.paths.database, { create: false, strict: true });
    const beforeRefusal = canonicalAuthBudgetSnapshot(injector);
    expect(() => injector.query("UPDATE queue_entries SET state='dispatching' WHERE id=?")
      .run(admitted.queue!.id)).toThrow("peer queue effect evidence required");
    expect(canonicalAuthBudgetSnapshot(injector)).toEqual(beforeRefusal);
    const evidenceGuardSql = z.object({ sql: z.string() }).strict().parse(injector.query(
      "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='queue_peer_effect_evidence_guard'",
    ).get());
    // Explicit current-row corruption, not a historical producer or a claim
    // that opening an already-current store runs daemon recovery.
    injector.transaction(() => {
      injector.exec("DROP TRIGGER queue_peer_effect_evidence_guard");
      injector.query("UPDATE queue_entries SET state='dispatching' WHERE id=?")
        .run(admitted.queue!.id);
      injector.exec(evidenceGuardSql.sql);
    }).immediate();
    expect(injector.query(
      "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='queue_peer_effect_evidence_guard'",
    ).get()).toEqual(evidenceGuardSql);
    const corrupted = canonicalAuthBudgetSnapshot(injector);
    injector.close(false);
    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const restarted = new StateStore(paths);
    stores.push(restarted);
    expect(restarted.recoverDispatchingQueueEffects()).toEqual({
      recovered: [],
      unresolved: [admitted.queue!.id],
    });
    expect(restarted.requireQueue(admitted.queue!.id).state).toBe("dispatching");
    // The intact queue transition projection marked the outer action started
    // during the deliberate corruption; recovery must not invent inner proof.
    expect(restarted.requirePeerSessionAction(admitted.action.id).state).toBe("effect_started");
    expect(restarted.requireSession(target.id)).toEqual(target);
    expect(restarted.readQueueEffect(admitted.queue!.id)).toBeNull();
    const inspector = new Database(paths.database, { create: false, strict: true });
    try { expect(canonicalAuthBudgetSnapshot(inspector)).toEqual(corrupted); }
    finally { inspector.close(false); }
  });
test("atomically advances only share memory heads and recovers started control effects with cursors", async () => {
    const { store, home } = await fixture({ now: () => 7_000 });
    const root = join(home, "memory-control-cas");
    await mkdir(root);
    const project = await store.createProject("Memory control CAS", root);
    const profile = signInProfile(store, "Memory control CAS", "memory-control@example.com");
    const actorBase = createAuthorizedStartingTestSession(store, {
      profileId: profile.id,
      projectId: project.id,
      preset: "high",
      fastEnabled: false,
    });
    const actor = store.setSessionTurnState({
      sessionId: actorBase.id,
      expectedRevision: actorBase.revision,
      state: "active",
      activeTurnId: "turn-memory-control",
    });
    const head = PROJECT_MEMORY_EMPTY_HEAD;
    reserveTestProjectMemoryAuthority(store, project.id, head);
    const remember = store.prepareMemorySubmission({
      actorSessionId: actor.id,
      projectId: project.id,
      kind: "remember",
      requestDigest: testDigest("remember request"),
      contentDigest: testDigest("remember content"),
      keyDigest: testDigest("remember key"),
      workingBindingDigest: testDigest("memory control working binding"),
      workingEpoch: 1,
      expectedHead: head,
      idempotencyKey: peerIdempotencyKey(52_002),
    }).record;
    store.bindMemorySubmissionEffect({
      submissionId: remember.id,
      effectRecordSha256: testDigest("memory control remember record"),
      attestationSha256: testDigest("memory control remember attestation"),
      operationId: "memory_control_remember",
    });
    store.beginMemorySubmission(remember.id);
    const advancedHead = {
      sequence: 1,
      operationSha256: testDigest("share operation"),
      headDigest: testDigest("share head"),
    } as const;
    const skippedHead = {
      sequence: 2,
      operationSha256: testDigest("skipped remember operation"),
      headDigest: testDigest("skipped remember head"),
    } as const;
    expect(() => store.settleMemorySubmission({
      submissionId: remember.id,
      expectedState: "effect_started",
      state: "applied",
      outcomeCode: "remember_committed",
      resultHead: skippedHead,
      receiptDigest: testDigest("remember receipt"),
    })).toThrow("MEMORY_SUBMISSION_OUTCOME_STATE_MISMATCH");
    expect(store.readProjectMemoryAuthority(project.id)?.head).toEqual(head);
    expect(store.settleMemorySubmission({
      submissionId: remember.id,
      expectedState: "effect_started",
      state: "applied",
      outcomeCode: "remember_committed",
      resultHead: advancedHead,
      receiptDigest: testDigest("remember receipt"),
    })).toMatchObject({ state: "applied", resultHead: advancedHead });
    expect(store.readProjectMemoryAuthority(project.id)?.head).toEqual(head);
    const share = store.prepareMemorySubmission({
      actorSessionId: actor.id,
      projectId: project.id,
      kind: "share",
      requestDigest: testDigest("share request"),
      contentDigest: remember.contentDigest,
      keyDigest: remember.keyDigest,
      workingBindingDigest: testDigest("memory control working binding"),
      workingEpoch: 1,
      expectedHead: head,
      idempotencyKey: peerIdempotencyKey(52_003),
    }).record;
    store.bindMemorySubmissionEffect({
      submissionId: share.id,
      effectRecordSha256: testDigest("memory control remember record"),
      attestationSha256: testDigest("memory control remember attestation"),
      operationId: "memory_adopt_control_share",
      sourceHead: advancedHead,
      nominationSha256: testDigest("memory control nomination"),
    });
    store.beginMemorySubmission(share.id);
    expect(store.recoverStartedControlPlaneEffects()).toEqual({
      peerActionIds: [],
      memorySubmissionIds: [share.id],
    });
    expect(() => store.beginMemorySubmission(
      share.id,
      peerIdempotencyKey(99_999),
    )).toThrow("MEMORY_SUBMISSION_IDEMPOTENCY_CONFLICT");
    expect(store.beginMemorySubmission(share.id, share.idempotencyKey).state)
      .toBe("ambiguous");
    expect(store.listUnsettledMemorySubmissionsPage({ limit: 1 }).records).toHaveLength(1);
    store.settleMemorySubmission({
      submissionId: share.id,
      expectedState: "ambiguous",
      state: "applied",
      outcomeCode: "share_adopted",
      resultHead: advancedHead,
      receiptDigest: testDigest("share receipt"),
    });
    expect(store.readProjectMemoryAuthority(project.id)).toMatchObject({
      head: advancedHead,
      syncState: "local_only",
    });
  });
test("transactionally fences memory preparation and effect start by actor lifecycle", async () => {
    const { store, home } = await fixture({ now: () => 7_100 });
    const profile = signInProfile(store, "Memory actor lifecycle", "memory-lifecycle@example.com");
    let key = 53_000;
    const actorFor = async (
      label: string,
      state: "idle" | "recovery_required" | "terminal",
    ) => {
      const root = join(home, `memory-actor-${label}`);
      await mkdir(root);
      const project = await store.createProject(`Memory actor ${label}`, root);
      const created = createAuthorizedStartingTestSession(store, {
        fastEnabled: false,
        preset: "high",
        profileId: profile.id,
        projectId: project.id,
      });
      const actor = state === "recovery_required"
        ? store.quarantineSession(created.id)
        : store.setSessionTurnState({
            expectedRevision: created.revision,
            sessionId: created.id,
            state,
          });
      return { actor, project };
    };
    const submissionInput = (
      actor: SessionRecord,
      project: ProjectRecord,
      label: string,
    ) => ({
      actorSessionId: actor.id,
      contentDigest: testDigest(`${label} content`),
      expectedHead: PROJECT_MEMORY_EMPTY_HEAD,
      idempotencyKey: peerIdempotencyKey(key++),
      keyDigest: testDigest(`${label} key`),
      kind: "remember" as const,
      projectId: project.id,
      requestDigest: testDigest(`${label} request`),
      workingBindingDigest: testDigest(`${label} working binding`),
      workingEpoch: 1,
    });

    const terminalPrepare = await actorFor("terminal-prepare", "terminal");
    expect(() => store.prepareMemorySubmission(submissionInput(
      terminalPrepare.actor,
      terminalPrepare.project,
      "terminal prepare",
    ))).toThrow("MEMORY_SUBMISSION_ACTOR_TERMINAL");

    const recoveryPrepare = await actorFor("recovery-prepare", "recovery_required");
    expect(() => store.prepareMemorySubmission(submissionInput(
      recoveryPrepare.actor,
      recoveryPrepare.project,
      "recovery prepare",
    ))).toThrow("MEMORY_SUBMISSION_ACTOR_RECOVERY_REQUIRED");

    for (const terminalState of ["terminal", "recovery_required"] as const) {
      const selected = await actorFor(`${terminalState}-begin`, "idle");
      const prepared = store.prepareMemorySubmission(submissionInput(
        selected.actor,
        selected.project,
        `${terminalState} begin`,
      )).record;
      store.bindMemorySubmissionEffect({
        attestationSha256: testDigest(`${terminalState} begin attestation`),
        effectRecordSha256: testDigest(`${terminalState} begin record`),
        operationId: `${terminalState}_begin_operation`,
        submissionId: prepared.id,
      });
      const current = store.requireSession(selected.actor.id);
      if (terminalState === "terminal") {
        store.setSessionTurnState({
          expectedRevision: current.revision,
          sessionId: current.id,
          state: "terminal",
        });
      } else {
        store.quarantineSession(current.id);
      }
      expect(() => store.beginMemorySubmission(prepared.id, prepared.idempotencyKey))
        .toThrow(terminalState === "terminal"
          ? "MEMORY_SUBMISSION_ACTOR_TERMINAL"
          : "MEMORY_SUBMISSION_ACTOR_RECOVERY_REQUIRED");
      expect(store.requireMemorySubmission(prepared.id).state).toBe("prepared");
    }
  });
test("makes a rejected project-memory reservation durable and terminal", async () => {
    const { store, home } = await fixture();
    const root = join(home, "rejected-project-memory");
    await mkdir(root);
    const project = await store.createProject("Rejected memory", root);
    const identity = createPortableProjectMemoryCanonicalIdentity(project.id);
    const reserved = store.reserveProjectMemoryAuthority({
      canonicalSpaceId: identity.canonicalSpaceId,
      head: PROJECT_MEMORY_EMPTY_HEAD,
      identityContract: identity.identityContract,
      projectId: project.id,
    });
    const rejected = store.rejectReservedProjectMemoryAuthority({
      diagnosticCode: "MEMORY_CANONICAL_DIVERGED",
      expectedHead: reserved.head,
      expectedRevision: reserved.revision,
      projectId: project.id,
    });
    expect(rejected).toMatchObject({
      diagnosticCode: "MEMORY_CANONICAL_DIVERGED",
      physicalState: "rejected",
      revision: 2,
      syncState: "error",
    });
    expect(store.rejectReservedProjectMemoryAuthority({
      diagnosticCode: "MEMORY_CANONICAL_DIVERGED",
      expectedHead: reserved.head,
      expectedRevision: reserved.revision,
      projectId: project.id,
    })).toEqual(rejected);
    expect(() => store.markProjectMemoryAuthorityInitialized({
      expectedHead: reserved.head,
      expectedRevision: rejected.revision,
      projectId: project.id,
    })).toThrow("PROJECT_MEMORY_REVISION_CONFLICT");

    const writer = new Database(store.paths.database, { create: false, strict: true });
    try {
      expect(() => writer.query(
        `UPDATE project_memory_authorities
         SET physical_state='initialized',initialized_at=updated_at,
             sync_state='local_only',diagnostic_code=NULL,revision=revision+1
         WHERE project_id=?`,
      ).run(project.id)).toThrow();
    } finally {
      writer.close(false);
    }
    expect(store.readProjectMemoryAuthority(project.id)).toEqual(rejected);
  });
test("rejects a pre-portable memory lookalike stamped as current without repairing it", async () => {
    const { store, home } = await fixture({ provision: "migrate" });
    const root = join(home, "legacy-project-memory-identity");
    await mkdir(root);
    const project = await store.createProject("Legacy memory identity", root);
    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);

    const legacyIdentity = deriveProjectMemoryCanonicalIdentity({
      canonicalSpaceId: legacyProjectMemorySpaceId(project.id),
      identityContract: 1,
      projectId: project.id,
    });
    const emptyHead = PROJECT_MEMORY_EMPTY_HEAD;
    const legacy = new Database(paths.database, { create: false, strict: true });
    const currentSql = z.object({ sql: z.string() }).strict().parse(legacy.query(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='project_memory_authorities'",
    ).get()).sql;
    const identityStart = currentSql.indexOf(",\n  identity_contract");
    const authorityStart = currentSql.indexOf(",\n  authority_digest", identityStart);
    if (identityStart < 0 || authorityStart < 0) {
      throw new Error("Expected the portable identity columns in the current fixture.");
    }
    const legacySql = (currentSql.slice(0, identityStart) + currentSql.slice(authorityStart))
      .replace(
        ",\n  CHECK((physical_state='initialized') = (initialized_at IS NOT NULL))",
        "",
      )
      .replace(
        ",\n  CHECK(initialized_at IS NULL OR (initialized_at >= created_at AND initialized_at <= updated_at))",
        "",
      )
      .replace(
        `,\n  CHECK(head_sequence != 0 OR head_digest = '${PROJECT_MEMORY_EMPTY_HEAD.headDigest}')`,
        "",
      )
      .replace(
        `,\n  CHECK(\n    last_exchange_sequence IS NULL\n    OR last_exchange_sequence != 0\n    OR last_exchange_head_digest = '${PROJECT_MEMORY_EMPTY_HEAD.headDigest}'\n  )`,
        "",
      )
      .replace(
        `,\n  CHECK(\n    physical_state!='reserved'\n    OR (\n      head_sequence=0\n      AND head_operation_sha256 IS NULL\n      AND head_digest='${PROJECT_MEMORY_EMPTY_HEAD.headDigest}'\n      AND sync_state='local_only'\n      AND last_exchange_at IS NULL\n      AND last_exchange_sequence IS NULL\n      AND last_exchange_operation_sha256 IS NULL\n      AND last_exchange_head_digest IS NULL\n      AND diagnostic_code IS NULL\n    )\n  )`,
        "",
      )
      .replace(
        `,\n  CHECK(\n    physical_state!='rejected'\n    OR (\n      initialized_at IS NULL\n      AND head_sequence=0\n      AND head_operation_sha256 IS NULL\n      AND head_digest='${PROJECT_MEMORY_EMPTY_HEAD.headDigest}'\n      AND sync_state='error'\n      AND last_exchange_at IS NULL\n      AND last_exchange_sequence IS NULL\n      AND last_exchange_operation_sha256 IS NULL\n      AND last_exchange_head_digest IS NULL\n      AND diagnostic_code IS NOT NULL\n    )\n  )`,
        "",
      );
    legacy.exec(`
      PRAGMA foreign_keys=OFF;
      DROP TRIGGER IF EXISTS memory_page_attestation_ref_insert_guard;
      DROP TRIGGER IF EXISTS memory_page_attestation_ref_update_guard;
      DROP TRIGGER IF EXISTS project_memory_authority_delete_guard;
      DROP TRIGGER IF EXISTS project_memory_authority_insert_guard;
      DROP TRIGGER IF EXISTS project_memory_authority_transition_guard;
      DROP INDEX IF EXISTS project_memory_authorities_space_unique;
      DROP TABLE project_memory_authorities;
    `);
    legacy.exec(legacySql);
    legacy.query(
      `INSERT INTO project_memory_authorities(
         project_id,authority_digest,binding_digest,head_sequence,
         head_operation_sha256,head_digest,revision,sync_state,
         last_exchange_at,last_exchange_sequence,last_exchange_operation_sha256,
         last_exchange_head_digest,diagnostic_code,created_at,updated_at
       ) VALUES (?,?,?,?,?,?,1,'local_only',NULL,NULL,NULL,NULL,NULL,?,?)`,
    ).run(
      project.id,
      legacyIdentity.authorityDigest,
      legacyIdentity.bindingDigest,
      emptyHead.sequence,
      emptyHead.operationSha256,
      emptyHead.headDigest,
      4_000,
      4_000,
    );
    legacy.exec("PRAGMA foreign_keys=ON");
    legacy.close(false);

    const corrupted = new Database(paths.database, { create: false, strict: true });
    corrupted.query(
      "UPDATE project_memory_authorities SET head_digest=? WHERE project_id=?",
    ).run("c".repeat(64), project.id);
    corrupted.close(false);
    expectInertSchemaRefusal(paths, "STATE_SCHEMA_V41_STRUCTURE_INVALID");
    const unchanged = new Database(paths.database, { create: false, readonly: true, strict: true });
    expect(unchanged.query<{ name: string }, []>(
      "SELECT name FROM pragma_table_info('project_memory_authorities') WHERE name='identity_contract'",
    ).get()).toBeNull();
    expect(unchanged.query(
      "SELECT head_digest FROM project_memory_authorities WHERE project_id=?",
    ).get(project.id)).toEqual({ head_digest: "c".repeat(64) });
    unchanged.close(false);
  });
test("upgrades an exact released v39 schema through adoption, timestamp proof, peer, and hosted state", async () => {
    const paths = await canonical39RetiredArchive("mixed_history");
    const source = canonical39RetiredFixtures.mixed_history.retained;
    const migratedAt = 40_000;
    const inspector = new Database(paths.database, { create: false, strict: true });
    try {
      const before = canonicalAuthBudgetSnapshot(inspector);
      expect(before.version).toEqual({ user_version: 39 });
      const ledger = inspector.query("SELECT * FROM migrations ORDER BY version").all();
      const retained = canonicalAuthBudgetRows(inspector, [
        "queue_entries", "session_runtime_profiles", "mutation_attempts",
        "mutation_effect_evidence", "queue_effect_evidence", "session_events",
      ]);
      expect(() => new StateStore(paths, { readonly: true }))
        .toThrow("STATE_SCHEMA_MIGRATION_REQUIRED:39:61");
      expect(canonicalAuthBudgetSnapshot(inspector)).toEqual(before);
      const migrated = new StateStore(paths, { now: () => migratedAt });
      stores.push(migrated);
      // The real old writer retained pending input without sealed attachment
      // identity. Migration quarantines it; it cannot invent cancellation.
      expect(migrated.requireQueue(source.queue.id)).toMatchObject({
        ...source.queue, messageActor: "human",
      });
      expect(migrated.requireQueue(source.queue.id)).not.toHaveProperty("peerActionId");
      expect(migrated.hasUnsettledQueueAttachmentQuarantineForSession(source.session.id)).toBe(true);
      expect(inspector.query("SELECT * FROM queue_attachment_identities").all()).toEqual([]);
      expect(inspector.query("SELECT * FROM queue_attachment_identity_anchors").all()).toEqual([]);
      expect(retained.read()).toEqual(retained.before);
      for (const session of [source.session, source.codex, source.claude]) {
        expect(migrated.requireSession(session.id)).toMatchObject({
          provider: session.provider, preset: session.preset, fastEnabled: session.fastEnabled,
        });
        expect(migrated.requirePeerSessionPolicy(session.id)).toMatchObject({
          mode: "coordinate", revision: 1,
        });
      }
      // The Devin session's migrated authority is current like any provider;
      // the unproven codex/claude sessions stay fenced by ordinary authority.
      expect(migrated.sessionAccountAuthorityMatches(source.session.id, source.profile.id)).toBe(true);
      for (const session of [source.codex, source.claude]) {
        expect(migrated.sessionAccountAuthorityMatches(session.id, source.profile.id)).toBe(false);
      }
      expect(migrated.latestSessionRuntimeProfile(source.session.id)).toEqual(source.runtime);
      expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: 61 });
      expect(inspector.query("SELECT * FROM migrations WHERE version<=39 ORDER BY version").all()).toEqual(ledger);
      expect(inspector.query(
        "SELECT version,applied_at FROM migrations WHERE version>=40 ORDER BY version",
      ).all()).toEqual(Array.from({ length: 22 }, (_, index) => ({ version: index + 40, applied_at: migratedAt })));
      expect(inspector.query("PRAGMA foreign_key_check").all()).toEqual([]);
      const joined = canonicalAuthBudgetSnapshot(inspector);
      expect(() => migrated.transitionQueue(source.queue.id, "pending", "dispatching")).toThrow();
      expect(canonicalAuthBudgetSnapshot(inspector)).toEqual(joined);
      migrated.close();
      stores.splice(stores.indexOf(migrated), 1);
      for (const readonly of [false, true]) {
        const reopened = new StateStore(paths, { readonly, now: () => migratedAt + 1 });
        try {
          expect(reopened.requireQueue(source.queue.id)).toMatchObject(source.queue);
          expect(reopened.latestSessionRuntimeProfile(source.session.id)).toEqual(source.runtime);
          expect(canonicalAuthBudgetSnapshot(inspector)).toEqual(joined);
        } finally { reopened.close(); }
      }
    } finally {
      inspector.close(false);
    }
  });
test("current v60 refuses missing or changed hosted-memory triggers without repair", async () => {
    for (const damage of ["missing", "changed"] as const) {
      const { store } = await fixture({ provision: "migrate" });
      const paths = store.paths;
      store.close();
      stores.splice(stores.indexOf(store), 1);
      const damaged = new Database(paths.database, { create: false, strict: true });
      try {
        damaged.exec("DROP TRIGGER project_memory_sync_intent_transition_guard");
        if (damage === "changed") {
          damaged.exec(`
            CREATE TRIGGER project_memory_sync_intent_transition_guard
            BEFORE UPDATE ON project_memory_sync_intents
            BEGIN SELECT 1; END;
          `);
        }
      } finally {
        damaged.close(false);
      }
      const before = new Database(paths.database, { create: false, readonly: true, strict: true });
      const schemaBefore = before.query(
        "SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name",
      ).all();
      const ledgerBefore = before.query("SELECT * FROM migrations ORDER BY version").all();
      before.close(false);

      for (const readonly of [true, false]) {
        expect(() => new StateStore(paths, readonly ? { readonly: true } : {}))
          .toThrow("STATE_SCHEMA_V41_STRUCTURE_INVALID");
      }
      const unchanged = new Database(paths.database, { create: false, readonly: true, strict: true });
      try {
        expect(unchanged.query(
          "SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name",
        ).all()).toEqual(schemaBefore);
        expect(unchanged.query("SELECT * FROM migrations ORDER BY version").all())
          .toEqual(ledgerBefore);
        expect(unchanged.query("PRAGMA user_version").get()).toEqual({ user_version: 61 });
      } finally {
        unchanged.close(false);
      }
    }
  });
test("current v60 opens require the exact peer and local-memory guards", async () => {
    const { store } = await fixture({ provision: "migrate" });
    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const weakened = new Database(paths.database, { create: false, strict: true });
    weakened.exec(`
      DROP TRIGGER queue_peer_effect_evidence_guard;
      CREATE TRIGGER queue_peer_effect_evidence_guard
      BEFORE UPDATE OF state ON queue_entries
      BEGIN SELECT 1; END;
    `);
    weakened.close(false);
    expect(() => new StateStore(paths, { readonly: true }))
      .toThrow("STATE_SCHEMA_V40_STRUCTURE_INVALID");
    expect(() => new StateStore(paths))
      .toThrow("STATE_SCHEMA_V40_STRUCTURE_INVALID");
    const inspector = new Database(paths.database, { readonly: true, strict: true });
    try {
      expect(inspector.query(
        "SELECT sql FROM sqlite_master WHERE name='queue_peer_effect_evidence_guard'",
      ).get()).toEqual(expect.objectContaining({ sql: expect.stringContaining("SELECT 1") }));
    } finally {
      inspector.close(false);
    }
  });
test("current v60 rejects widened peer queue columns and non-peer actor vocabulary without writes", async () => {
    for (const damage of ["widened_column", "invalid_row"] as const) {
      const { store } = await fixture({ provision: "migrate" });
      const profile = signInProfile(store, "Queue provenance column", "queue-column@example.com");
      const session = createProvenTestSession(store, {
        profileId: profile.id,
        preset: "high",
        fastEnabled: false,
        state: "idle",
      });
      const queued = store.enqueue(session.id, "closed peer queue metadata");
      const paths = store.paths;
      store.close();
      stores.splice(stores.indexOf(store), 1);
      const damaged = new Database(paths.database, { create: false, strict: true });
      try {
        if (damage === "widened_column") {
          const table = z.object({ sql: z.string() }).strict().parse(damaged.query(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='queue_entries'",
          ).get());
          const widened = table.sql.replace(
            "CHECK(message_actor IN ('human','peer_session'))",
            "CHECK(message_actor IN ('human','peer_session','automation'))",
          );
          expect(widened).not.toBe(table.sql);
          // Use supported DDL: the platform SQLite may prohibit writable_schema.
          // Restore every trigger byte-for-byte after replacing only this column.
          const triggers = damaged.query(
            "SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name",
          ).all().map((row) => z.object({ name: z.string(), sql: z.string() }).strict().parse(row));
          // Commit the adversarial fixture once, then prove both real opens
          // refuse the same completed schema under the original test deadline.
          damaged.transaction(() => {
            for (const trigger of triggers) {
              damaged.exec(`DROP TRIGGER "${trigger.name.replaceAll('"', '""')}"`);
            }
            damaged.exec("ALTER TABLE queue_entries DROP COLUMN message_actor");
            damaged.exec(`ALTER TABLE queue_entries ADD COLUMN message_actor TEXT NOT NULL
              DEFAULT 'human' CHECK(message_actor IN ('human','peer_session','automation'))`);
            for (const trigger of triggers) damaged.exec(trigger.sql);
          }).immediate();
        } else {
          const guard = z.object({ sql: z.string() }).strict().parse(damaged.query(
            "SELECT sql FROM sqlite_master WHERE name='queue_peer_provenance_immutable'",
          ).get());
          damaged.exec("DROP TRIGGER queue_peer_provenance_immutable; PRAGMA ignore_check_constraints=ON");
          damaged.query("UPDATE queue_entries SET message_actor='automation' WHERE id=?").run(queued.id);
          damaged.exec("PRAGMA ignore_check_constraints=OFF");
          damaged.exec(guard.sql);
        }
      } finally {
        damaged.close(false);
      }
      const inspector = new Database(paths.database, { readonly: true, strict: true });
      try {
        const schemaBefore = inspector.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all();
        const queueBefore = inspector.query("SELECT * FROM queue_entries WHERE id=?").get(queued.id);
        for (const readonly of [true, false]) {
          expect(() => new StateStore(paths, { readonly })).toThrow("STATE_SCHEMA_V40_STRUCTURE_INVALID");
        }
        expect(inspector.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all()).toEqual(schemaBefore);
        expect(inspector.query("SELECT * FROM queue_entries WHERE id=?").get(queued.id)).toEqual(queueBefore);
        expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: 61 });
      } finally {
        inspector.close(false);
      }
    }
  });
test("current v60 opens never recreate a missing peer authority trigger or index", async () => {
    const { store } = await fixture({ provision: "migrate" });
    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const weakened = new Database(paths.database, { create: false, strict: true });
    weakened.exec(`
      DROP TRIGGER session_host_capability_binding_immutable;
      DROP INDEX memory_submissions_project_recent;
    `);
    weakened.close(false);
    expect(() => new StateStore(paths, { readonly: true }))
      .toThrow("STATE_SCHEMA_V40_STRUCTURE_INVALID");
    expect(() => new StateStore(paths))
      .toThrow("STATE_SCHEMA_V40_STRUCTURE_INVALID");
    const inspector = new Database(paths.database, { readonly: true, strict: true });
    try {
      expect(inspector.query(
        `SELECT name FROM sqlite_master
         WHERE name IN ('session_host_capability_binding_immutable',
           'memory_submissions_project_recent')`,
      ).all()).toEqual([]);
    } finally {
      inspector.close(false);
    }
  });
test("readonly open rejects a weakened previously unaudited v40 guard", async () => {
    const { store } = await fixture({ provision: "migrate" });
    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const weakened = new Database(paths.database, { create: false, strict: true });
    weakened.exec(`
      DROP TRIGGER session_peer_policy_transition_guard;
      CREATE TRIGGER session_peer_policy_transition_guard
      BEFORE UPDATE ON session_peer_policies
      BEGIN SELECT 1; END;
    `);
    weakened.close(false);
    expect(() => new StateStore(paths, { readonly: true }))
      .toThrow("STATE_SCHEMA_V40_STRUCTURE_INVALID");
  });
test("rejects databases written by a newer schema version", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "oompa-store-newer-")));
    const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
    await initializeStatePaths(paths);
    const newer = new Database(paths.database, { create: true, strict: true });
    newer.exec("PRAGMA user_version = 62");
    newer.close(false);
    await chmod(paths.database, 0o600);
    expect(() => new StateStore(paths)).toThrow("STATE_SCHEMA_NEWER:62:61");
  });
});
