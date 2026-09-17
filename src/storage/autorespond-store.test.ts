import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { z } from "zod";

import { AUTORESPOND_DAY_MS, AUTORESPOND_HOUR_MS } from "../domain/autorespond-budget";
import { canonicalBudgetDatabaseBytes, canonicalBudgetFixtures } from "../../scripts/fixtures/canonical-budget-history";
import { canonicalBudgetRuntimeDatabaseBytes, canonicalBudgetRuntimeFixtures, canonicalBudgetRuntimeGeneratorSource } from "../../scripts/fixtures/canonical-budget-runtime";
import { canonical49WorkDatabaseBytes, canonical49WorkFixture } from "../../scripts/fixtures/canonical49-work";
import { effectiveRuntimeProfileSchema } from "../domain/runtime-profile";

import { deriveLegacySessionProfileKey } from "./canonical-profile-storage";
import { initializeStatePaths, resolveStatePaths } from "./paths";
import { StateStore } from "./state-store";

const stores: StateStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

async function fixture(): Promise<{ store: StateStore; sessionId: string; clock: { now: number } }> {
  const home = await realpath(await mkdtemp(join(tmpdir(), "oompa-autorespond-store-")));
  const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
  await initializeStatePaths(paths);
  const clock = { now: 1_000_000 };
  const store = new StateStore(paths, { now: () => clock.now });
  stores.push(store);
  store.nextDaemonGeneration(`boot_${crypto.randomUUID().replaceAll("-", "")}`);
  const profile = store.nextProfileGeneration(store.createProfile("Personal").id);
  store.setProfileState(profile.id, profile.processGeneration, "signed_in", { email: "autorespond@example.com" });
  const session = provenSession(store, profile.id, "Autorespond");
  return { store, sessionId: session.id, clock };
}

async function canonicalBudgetArchive(version: 43 | 45) {
  const home = await realpath(await mkdtemp(join(tmpdir(), "oompa-autorespond-canonical-budget-")));
  const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
  await initializeStatePaths(paths);
  const bytes = canonicalBudgetDatabaseBytes(version);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(canonicalBudgetFixtures[version].databaseSha256);
  await writeFile(paths.database, bytes, { mode: 0o600, flag: "wx" });
  const clock = { now: version === 43 ? 45_000 : canonicalBudgetFixtures[45].fixedTime };
  return { paths, clock, sessionId: canonicalBudgetFixtures[version].retained.budgetSession.id };
}

async function canonicalBudgetRuntimeArchive(version: 43 | 45) {
  const home = await realpath(await mkdtemp(join(tmpdir(), "oompa-autorespond-canonical-runtime-")));
  const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
  await initializeStatePaths(paths);
  const bytes = canonicalBudgetRuntimeDatabaseBytes(version);
  const archived = canonicalBudgetRuntimeFixtures[version];
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(archived.databaseSha256);
  expect(bytes.byteLength).toBe(archived.databaseBytes);
  expect(createHash("sha256").update(canonicalBudgetRuntimeGeneratorSource).digest("hex")).toBe(archived.generatorSha256);
  expect(archived.sourceCommit).toBe(canonicalBudgetFixtures[version].sourceCommit);
  expect(archived.schemaVersion).toBe(version);
  expect(archived.provenance.rawSqlRowOrSchemaWrites).toBe(false);
  expect(archived.provenance.providerRuntimeObservationClaim).toBe(false);
  if (version === 45) expect(archived.predecessorDatabaseSha256).toBe(canonicalBudgetRuntimeFixtures[43].databaseSha256);
  await writeFile(paths.database, bytes, { mode: 0o600, flag: "wx" });
  const clock = { now: version === 43 ? 45_000 : archived.fixedTime };
  return { paths, clock, sessionId: archived.retained.budgetSession.id };
}

function capturedDatabaseSnapshot(database: Database) {
  return {
    schema: database.query("SELECT * FROM sqlite_master ORDER BY type,name").all(),
    version: database.query("PRAGMA user_version").get(),
    tables: z.array(z.object({ name: z.string().regex(/^[a-z_0-9]+$/u) }).strict()).parse(
      database.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all(),
    ).map(({ name }) => ({ name, rows: database.query(`SELECT * FROM "${name}"`).all() })),
  };
}

function provenSession(store: StateStore, profileId: string, title: string) {
  const email = store.requireProfile(profileId).providerEmail;
  if (email === undefined) throw new Error("missing fixture account authority");
  return store.upsertProviderSession({
    profileId, title, provider: "codex", providerThreadId: `thread-${crypto.randomUUID()}`,
    providerAuthority: store.requireProviderAccountAuthority(profileId, "codex"),
    providerAccountKey: `v1:codex:${createHash("sha256").update(email).digest("hex")}`,
    preset: "high", fastEnabled: false, state: "idle",
  });
}

function protocolSource(store: StateStore, sessionId: string, hasOnce = true): string {
  const session = store.requireSession(sessionId);
  const { providerAccountId, profileId, provider, bindingGeneration, processGeneration } =
    store.requireCapturedSessionProviderAuthority(sessionId);
  const publicId = crypto.randomUUID();
  store.admitInteraction({
    publicId,
    sessionId,
    authority: {
      providerAccountId, profileId, provider, bindingGeneration, processGeneration,
      connectionId: "44000000-0000-4000-8000-999999999999",
      requestId: { type: "string", value: publicId },
      method: "item/commandExecution/requestApproval",
      requestDigest: "a".repeat(64),
      threadId: session.providerThreadId ?? null,
      turnId: null,
      itemId: null,
      approvalId: null,
    },
    kind: "command_approval",
    blocking: true,
    display: {
      kind: "command_approval",
      summary: "Review command",
      reason: null,
      commandClass: "test",
      workingDirectory: null,
      availableDecisions: hasOnce ? ["once", "decline", "cancel"] : ["decline", "cancel"],
    },
  });
  return publicId;
}

function reserveProtocol(store: StateStore, sessionId: string, sourceId = protocolSource(store, sessionId)) {
  return store.reserveAutorespondBudget({ sessionId, sourceId, sourceKind: "protocol", expectedMode: "auto:all" });
}

describe("autorespond store", () => {
  test("defaults to auto:all, supports session overrides, and clears them", async () => {
    const { store, sessionId } = await fixture();
    expect(store.readDefaultApprovalMode()).toBe("auto:all");
    expect(store.readSessionApprovalMode(sessionId)).toEqual({ mode: "auto:all", source: "default" });
    store.setSessionApprovalMode(sessionId, "manual");
    expect(store.readSessionApprovalMode(sessionId)).toEqual({ mode: "manual", source: "session" });
    store.setDefaultApprovalMode("auto:workspace");
    expect(store.readSessionApprovalMode(sessionId)).toEqual({ mode: "manual", source: "session" });
    store.setSessionApprovalMode(sessionId, null);
    expect(store.readSessionApprovalMode(sessionId)).toEqual({ mode: "auto:workspace", source: "default" });
    expect(() => store.setSessionApprovalMode("sess_00000000000000000000000000000000", "manual")).toThrow();
  });

  test("counts consecutive admission until a human reset and windows reservations independently of evidence", async () => {
    const { store, sessionId, clock } = await fixture();
    expect(store.bumpAutorespondCounter(sessionId)).toBe(1);
    expect(store.bumpAutorespondCounter(sessionId)).toBe(2);
    expect(store.readAutorespondBudgets(sessionId).consecutive).toBe(2);
    store.resetAutorespondCounter(sessionId);
    expect(store.readAutorespondBudgets(sessionId).consecutive).toBe(0);

    const record = (outcome: "accepted" | "refused") => store.recordAutorespondEvidence({
      approvalClass: "command:bun test",
      decision: outcome === "accepted" ? "once" : "hourly_budget",
      interactionId: crypto.randomUUID(),
      kind: "command_approval",
      latencyMs: 12,
      mode: "auto:all",
      outcome,
      sessionId,
      subagent: false,
    });
    record("accepted");
    expect(reserveProtocol(store, sessionId)).toEqual({ state: "reserved" });
    clock.now += 2 * 60 * 60 * 1_000;
    record("accepted");
    expect(reserveProtocol(store, sessionId)).toEqual({ state: "reserved" });
    record("refused");
    const budgets = store.readAutorespondBudgets(sessionId);
    expect(budgets.lastHour).toBe(1);
    expect(budgets.lastDay).toBe(2);
    expect(store.countAutorespondEvidence({ sessionId })).toEqual({ accepted: 2, refused: 1, unknown: 0 });
    const recent = store.listAutorespondEvidence({ sessionId, limit: 2 });
    expect(recent).toHaveLength(2);
    expect(recent[0]?.outcome).toBe("refused");
    expect(recent[0]?.approvalClass).toBe("command:bun test");
    expect(store.listAutorespondEvidence({ limit: 5 })).toHaveLength(3);
  });
});

describe("prose autorespond evidence", () => {
  test("records prose rows with the rule, the model, and a bounded gate outcome", async () => {
    const { store, sessionId, clock } = await fixture();
    store.recordProseAutorespondEvidence({
      decision: "send",
      latencyMs: 41,
      mode: "auto:all",
      model: "openai/gpt-5-nano",
      outcome: "sent",
      rule: "approval_cue",
      sessionId,
    });
    clock.now += 1_000;
    store.recordProseAutorespondEvidence({
      decision: "refuse",
      latencyMs: 3,
      mode: "auto:all",
      model: null,
      outcome: "gate_failed:human_action_cue",
      rule: "approval_cue",
      sessionId,
    });

    const rows = store.listAutorespondEvidence({ sessionId, limit: 10 });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      decision: "refuse",
      interactionId: null,
      kind: "prose_approval",
      model: null,
      outcome: "gate_failed:human_action_cue",
      path: "prose",
      rule: "approval_cue",
    });
    expect(rows[1]).toMatchObject({
      kind: "prose_approval",
      model: "openai/gpt-5-nano",
      outcome: "sent",
      path: "prose",
    });
    // Display evidence has no admission authority. Actual sends reserve first.
    expect(store.readAutorespondBudgets(sessionId)).toMatchObject({ lastDay: 0, lastHour: 0 });
    expect(store.countAutorespondEvidence({ sessionId })).toEqual({ accepted: 1, refused: 1, unknown: 0 });
  });

  test("refuses an outcome outside the closed vocabulary", async () => {
    const { store, sessionId } = await fixture();
    expect(() => store.recordProseAutorespondEvidence({
      decision: "send",
      latencyMs: 1,
      mode: "auto:all",
      model: null,
      outcome: "gate_failed:NOT ALLOWED" as never,
      rule: "approval_cue",
      sessionId,
    })).toThrow();
    expect(store.listAutorespondEvidence({ sessionId })).toHaveLength(0);
  });

  test("labels autorespond-authored message sources per session", async () => {
    const { store, sessionId } = await fixture();
    expect(store.isAutorespondMessageSource(sessionId, "attempt_one")).toBe(false);
    store.recordAutorespondMessageSource(sessionId, "attempt_one");
    store.recordAutorespondMessageSource(sessionId, "attempt_one");
    expect(store.isAutorespondMessageSource(sessionId, "attempt_one")).toBe(true);
    expect(store.isAutorespondMessageSource(sessionId, "attempt_two")).toBe(false);
    expect(store.isAutorespondMessageSource(sessionId, "")).toBe(false);
  });
});

describe("durable autorespond admission", () => {
  test("serializes competing stores and exact-key replay before any success is recorded", async () => {
    const { store, sessionId, clock } = await fixture();
    const other = new StateStore(store.paths, { now: () => clock.now });
    stores.push(other);
    const sourceId = protocolSource(store, sessionId);
    expect(reserveProtocol(store, sessionId, sourceId)).toEqual({ state: "reserved" });
    expect(reserveProtocol(other, sessionId, sourceId)).toEqual({ state: "existing" });
    expect(reserveProtocol(other, sessionId)).toEqual({ state: "reserved" });
    expect(reserveProtocol(store, sessionId)).toEqual({ state: "reserved" });
    expect(reserveProtocol(other, sessionId)).toEqual({ state: "refused", code: "consecutive_limit" });
    expect(store.readAutorespondBudgets(sessionId)).toEqual({ consecutive: 3, lastHour: 3, lastDay: 3 });
  });

  test("rechecks mode and source authority without charging refusals", async () => {
    const { store, sessionId } = await fixture();
    const sourceId = protocolSource(store, sessionId);
    store.setSessionApprovalMode(sessionId, "manual");
    expect(reserveProtocol(store, sessionId, sourceId)).toEqual({ state: "refused", code: "manual_mode" });
    store.setSessionApprovalMode(sessionId, "auto:workspace");
    expect(reserveProtocol(store, sessionId, sourceId)).toEqual({ state: "refused", code: "policy_changed" });
    store.setSessionApprovalMode(sessionId, "auto:all");
    expect(() => reserveProtocol(store, sessionId, crypto.randomUUID())).toThrow("AUTORESPOND_BUDGET_SOURCE_AUTHORITY_INVALID");
    expect(store.readAutorespondBudgets(sessionId)).toEqual({ consecutive: 0, lastHour: 0, lastDay: 0 });
  });

  test("refusal churn and unknown outcomes cannot erase charged rolling budgets", async () => {
    const { store, sessionId, clock } = await fixture();
    for (let index = 0; index < 10; index += 1) {
      store.resetAutorespondCounter(sessionId);
      expect(reserveProtocol(store, sessionId)).toEqual({ state: "reserved" });
    }
    store.resetAutorespondCounter(sessionId);
    for (let index = 0; index < 501; index += 1) {
      store.recordAutorespondEvidence({
        sessionId, interactionId: crypto.randomUUID(), kind: "command_approval",
        approvalClass: "command:test", mode: "auto:all", decision: "unavailable",
        outcome: index === 500 ? "unknown" : "refused", latencyMs: 0, subagent: false,
      });
    }
    expect(store.countAutorespondEvidence({ sessionId })).toEqual({ accepted: 0, refused: 499, unknown: 1 });
    expect(reserveProtocol(store, sessionId)).toEqual({ state: "refused", code: "hourly_budget" });
    clock.now += AUTORESPOND_HOUR_MS;
    expect(reserveProtocol(store, sessionId)).toEqual({ state: "refused", code: "hourly_budget" });
    clock.now += 1;
    expect(reserveProtocol(store, sessionId)).toEqual({ state: "reserved" });
    expect(store.readAutorespondBudgets(sessionId)).toEqual({ consecutive: 1, lastHour: 1, lastDay: 11 });
  });

  test("enforces the shared daily ceiling and releases only expired rolling reservations", async () => {
    const { store, sessionId, clock } = await fixture();
    const start = clock.now;
    for (let hour = 0; hour < 4; hour += 1) {
      clock.now = start + hour * (AUTORESPOND_HOUR_MS + 1);
      for (let index = 0; index < 10; index += 1) {
        store.resetAutorespondCounter(sessionId);
        expect(reserveProtocol(store, sessionId)).toEqual({ state: "reserved" });
      }
    }
    clock.now += AUTORESPOND_HOUR_MS + 1;
    store.resetAutorespondCounter(sessionId);
    expect(reserveProtocol(store, sessionId)).toEqual({ state: "refused", code: "daily_budget" });
    clock.now = start + AUTORESPOND_DAY_MS;
    expect(reserveProtocol(store, sessionId)).toEqual({ state: "refused", code: "daily_budget" });
    clock.now += 1;
    expect(reserveProtocol(store, sessionId)).toEqual({ state: "reserved" });
    expect(store.readAutorespondBudgets(sessionId).lastDay).toBe(31);
    const inspector = new Database(store.paths.database, { readonly: true });
    try {
      expect(inspector.query("SELECT COUNT(*) AS total FROM autorespond_budget_reservations").get()).toEqual({ total: 31 });
    } finally { inspector.close(false); }
  });

  test("clock rewind cannot reopen spend after a successful or refused retention attempt", async () => {
    const { store, sessionId, clock } = await fixture();
    const start = clock.now;
    for (let index = 0; index < 10; index += 1) {
      store.resetAutorespondCounter(sessionId);
      expect(reserveProtocol(store, sessionId)).toEqual({ state: "reserved" });
    }
    store.bumpAutorespondCounter(sessionId);
    store.bumpAutorespondCounter(sessionId);
    clock.now += AUTORESPOND_DAY_MS + 1;
    expect(reserveProtocol(store, sessionId)).toEqual({ state: "refused", code: "consecutive_limit" });
    clock.now = start;
    store.resetAutorespondCounter(sessionId);
    expect(reserveProtocol(store, sessionId)).toEqual({ state: "refused", code: "hourly_budget" });
    clock.now += AUTORESPOND_DAY_MS + 1;
    expect(reserveProtocol(store, sessionId)).toEqual({ state: "reserved" });
    clock.now = start;
    store.resetAutorespondCounter(sessionId);
    expect(reserveProtocol(store, sessionId)).toEqual({ state: "refused", code: "history_unavailable" });
  });

  test("holds only preexisting sessions for a full day after v43 migration and keeps the hold on reopen", async () => {
    const { paths, sessionId, clock } = await canonicalBudgetRuntimeArchive(43);
    const alreadyLimited = canonicalBudgetRuntimeFixtures[43].retained.limitedSession;
    const predecessor = new Database(paths.database, { create: false, strict: true });
    predecessor.exec("PRAGMA query_only=ON");
    try {
      const before = capturedDatabaseSnapshot(predecessor);
      expect(() => new StateStore(paths, { readonly: true })).toThrow("STATE_SCHEMA_MIGRATION_REQUIRED:43:62");
      expect(capturedDatabaseSnapshot(predecessor)).toEqual(before);
    } finally { predecessor.close(false); }
    const migrated = new StateStore(paths, { now: () => clock.now });
    stores.push(migrated);
    const availableAt = clock.now + AUTORESPOND_DAY_MS;
    expect(migrated.readAutorespondBudgets(sessionId).consecutive).toBe(3);
    expect(migrated.readAutorespondBudgets(alreadyLimited.id).consecutive).toBe(4);
    expect(migrated.readAutorespondBudgetHistoryAvailableAt(sessionId)).toBe(availableAt);
    expect(reserveProtocol(migrated, sessionId)).toEqual({ state: "refused", code: "history_unavailable" });
    const session = migrated.requireSession(sessionId);
    const fresh = provenSession(migrated, session.profileId, "New after migration");
    expect(migrated.readAutorespondBudgetHistoryAvailableAt(fresh.id)).toBeNull();
    expect(reserveProtocol(migrated, fresh.id)).toEqual({ state: "reserved" });
    // The normal human-message reset may happen during the hold. Reopening
    // must not reinstall the migration floor after that reset.
    migrated.resetAutorespondCounter(sessionId);
    clock.now = availableAt - 1;
    const reopened = new StateStore(paths, { now: () => clock.now });
    stores.push(reopened);
    expect(reopened.readAutorespondBudgets(sessionId).consecutive).toBe(0);
    expect(reopened.readAutorespondBudgetHistoryAvailableAt(sessionId)).toBe(availableAt);
    expect(reserveProtocol(reopened, sessionId)).toEqual({ state: "refused", code: "history_unavailable" });
    clock.now = availableAt;
    expect(reopened.readAutorespondBudgetHistoryAvailableAt(sessionId)).toBeNull();
    expect(reserveProtocol(reopened, sessionId)).toEqual({ state: "reserved" });
  });

  test("rejects a current-version missing admission guard without repairing it", async () => {
    const { store } = await fixture();
    const paths = store.paths;
    stores.splice(stores.indexOf(store), 1);
    store.close();
    const damaged = new Database(paths.database);
    damaged.exec("DROP TRIGGER autorespond_budget_reservations_immutable");
    damaged.close(false);
    expect(() => new StateStore(paths)).toThrow("STATE_SCHEMA_V44_AUTORESPOND_BUDGET_AUTHORITY_INVALID");
    expect(() => new StateStore(paths, { readonly: true })).toThrow("STATE_SCHEMA_V44_AUTORESPOND_BUDGET_AUTHORITY_INVALID");
  });

  test("rejects predecessor budget-object collisions instead of blessing zero history holds", async () => {
    const { paths, sessionId } = await canonicalBudgetArchive(43);
    const damaged = new Database(paths.database, { create: false, strict: true });
    try {
      // Deliberate collision on authentic43, not current rows relabelled as old.
      expect(damaged.query("SELECT 1 FROM sqlite_master WHERE name='autorespond_budget_history'").get()).toBeNull();
      damaged.exec("CREATE TABLE autorespond_budget_history(session_id TEXT PRIMARY KEY,available_at INTEGER NOT NULL) STRICT");
      damaged.query("INSERT INTO autorespond_budget_history(session_id,available_at) VALUES(?,0)").run(sessionId);
      const before = capturedDatabaseSnapshot(damaged);
      expect(() => new StateStore(paths)).toThrow("STATE_SCHEMA_V44_AUTORESPOND_BUDGET_PREDECESSOR_COLLISION");
      expect(capturedDatabaseSnapshot(damaged)).toEqual(before);
      expect(() => new StateStore(paths, { readonly: true })).toThrow("STATE_SCHEMA_MIGRATION_REQUIRED:43:62");
      expect(capturedDatabaseSnapshot(damaged)).toEqual(before);
    } finally { damaged.close(false); }
  });

  // Exact45, exact49 and current62 exercise the post43 refusal branch. These
  // controls do not claim unavailable archived44/46/47/48 producer coverage.
  for (const version of [45, 49, 62] as const) test(`never applies pre-release v43 trigger repair to ${version === 62 ? "current" : "authentic canonical"} v${String(version)}`, async () => {
    let paths: StateStore["paths"];
    if (version === 45) ({ paths } = await canonicalBudgetArchive(45));
    else if (version === 49) {
      const home = await realpath(await mkdtemp(join(tmpdir(), "oompa-autorespond-canonical49-")));
      paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
      await initializeStatePaths(paths);
      const bytes = canonical49WorkDatabaseBytes();
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(canonical49WorkFixture.databaseSha256);
      await writeFile(paths.database, bytes, { mode: 0o600, flag: "wx" });
    } else {
      const { store } = await fixture();
      paths = store.paths;
      stores.splice(stores.indexOf(store), 1);
      store.close();
    }
    const damaged = new Database(paths.database, { create: false, strict: true });
    try {
      expect(damaged.query("PRAGMA user_version").get()).toEqual({ user_version: version });
      damaged.exec("DROP TRIGGER queue_transcript_cancellation_settlement");
      const before = capturedDatabaseSnapshot(damaged);
      expect(() => new StateStore(paths)).toThrow("STATE_SCHEMA_V43_QUEUE_CANCELLATION_GUARD_INVALID");
      expect(capturedDatabaseSnapshot(damaged)).toEqual(before);
      expect(() => new StateStore(paths, { readonly: true })).toThrow(version === 62
        ? "STATE_SCHEMA_V43_QUEUE_CANCELLATION_GUARD_INVALID" : `STATE_SCHEMA_MIGRATION_REQUIRED:${String(version)}:62`);
      expect(capturedDatabaseSnapshot(damaged)).toEqual(before);
    } finally { damaged.close(false); }
  });
});

function enableAfterHours(store: StateStore): void {
  const hours = store.readNotificationHours();
  store.updateNotificationHours({
    version: 1, startMinute: 480, endMinute: 1080, timeZone: "UTC", expectedRevision: hours.revision,
  });
  const policy = store.readAutorespondAfterHoursPolicy();
  store.updateAutorespondAfterHoursPolicy({ enabled: true, expectedRevision: policy.revision });
}

function provisional(store: StateStore, sessionId: string) {
  return store.readAutorespondAfterHoursSelection(sessionId, "protocol", "eligible");
}

function effectContext(store: StateStore, sessionId: string) {
  const session = store.requireSession(sessionId);
  const { providerAccountId, profileId, provider, bindingGeneration, processGeneration } = store.requireSessionProviderAuthority(sessionId);
  const providerAuthority = { providerAccountId, profileId, provider, bindingGeneration, processGeneration };
  if (provider !== "codex" || session.providerThreadId === undefined) throw new Error("Expected the fixture's exact Codex source.");
  const { preset, requirement } = store.requireSessionPresetRequirement(sessionId);
  const runtimeProfile = effectiveRuntimeProfileSchema.parse({
    profileId, processGeneration, observedAt: session.updatedAt, preset,
    model: requirement.model, reasoningEffort: requirement.effort, serviceTier: null, fast: session.fastEnabled,
    approvalPolicy: "on-request", reviewMode: "auto_review", permissionProfile: ":workspace",
    computerUse: true, pluginCapability: true, enabledApps: [],
  });
  return { session, providerAuthority, runtimeProfile, providerThreadId: session.providerThreadId,
    providerConnectionId: crypto.randomUUID() };
}

function prepareSyntheticSend(store: StateStore, sessionId: string, message: string, actor: "human" | "autorespond") {
  const context = effectContext(store, sessionId);
  const inspector = new Database(store.paths.database, { readonly: true, strict: true });
  let daemon: { daemonGeneration: number; bootId: string };
  try {
    // Capture already-existing custody. A new daemon boot here would retire
    // the archived source; it is not a fixture shortcut to dispatch authority.
    daemon = z.object({ daemonGeneration: z.number().int().positive(), bootId: z.string().regex(/^boot_[a-f0-9]{32}$/u) }).strict().parse(
      inspector.query("SELECT generation AS daemonGeneration,boot_id AS bootId FROM daemon_state WHERE singleton=1").get(),
    );
  } finally { inspector.close(false); }
  const sourceId = crypto.randomUUID();
  const { attempt, custody } = store.prepareSessionInputMutation({
    ...daemon, kind: "session.send", sessionId, idempotencyKey: sourceId,
    message, attachments: [], providerAuthority: context.providerAuthority,
  });
  expect(custody).toEqual({ kind: "empty" });
  if (actor === "autorespond") store.recordAutorespondMessageSource(sessionId, attempt.id);
  store.beginSessionMutationEffect({
    ...daemon, attemptId: attempt.id, sessionId, profileGeneration: context.providerAuthority.processGeneration,
    providerAuthority: context.providerAuthority, message, attachments: [],
    transcript: { accountId: context.providerAuthority.profileId, providerGeneration: context.providerAuthority.processGeneration,
      providerConnectionId: context.providerConnectionId, actor, message },
    evidence: { kind: "session.send", providerThreadId: context.providerThreadId,
      baseline: { providerUpdatedAt: context.session.providerUpdatedAt ?? null, status: "idle", activeTurnId: null },
      clientMessageId: attempt.id, messageDigest: createHash("sha256").update(message).digest("hex"),
      runtimeProfile: context.runtimeProfile, messageActor: actor },
  });
  return { ...context, attempt, sourceId, message };
}

function finishQueueSource(store: StateStore, sessionId: string, actor: "human" | "autorespond" | "automation" | "provider_switch" = "human") {
  const { session, providerAuthority, runtimeProfile, providerThreadId, providerConnectionId } = effectContext(store, sessionId);
  const message = "Synthetic approved continuation";
  const queued = store.enqueueIdempotent({
    sessionId, profileGeneration: providerAuthority.processGeneration, providerAuthority,
    message, actor, providerConnectionId, idempotencyKey: crypto.randomUUID(),
  });
  const evidence = store.beginQueueEffect({
    queueId: queued.id, sessionId, profileGeneration: providerAuthority.processGeneration, providerAuthority, providerConnectionId,
    evidence: { kind: "queue.dispatch", queueId: queued.id, sessionId, providerThreadId,
      profileGeneration: providerAuthority.processGeneration,
      baseline: { providerUpdatedAt: session.providerUpdatedAt ?? null, status: "idle", activeTurnId: null },
      clientMessageId: queued.id, messageDigest: createHash("sha256").update(message).digest("hex"), runtimeProfile },
  });
  const turnId = `synthetic-turn-${crypto.randomUUID()}`;
  let completed = false;
  return () => {
    if (completed) return store.finalizeSessionUserMessageSource({ sessionId, sourceKind: "queue", sourceId: queued.id, turnId });
    const result = store.completeQueueEffect({
      queueId: queued.id, accountId: providerAuthority.profileId, providerGeneration: providerAuthority.processGeneration,
      providerAuthority, providerConnectionId, expectedEvidenceDigest: evidence.digest,
      expectedSessionRevision: session.revision, applyResponseState: true, turnId, turnStatus: "completed",
      runtimeProfile, message, receipt: { turnId },
    });
    completed = true;
    return result.event;
  };
}

async function legacyAfterHoursFixture() {
  const { paths, sessionId, clock } = await canonicalBudgetRuntimeArchive(45);
  // Real canonical43->45 API capture: positive history marker, expired hold,
  // historical human receipt, and released API counter reset are retained.
  // Its archived session_start runtime and pre-session daemon boot separately
  // prove the migration source. They are not provider/native IO acceptance.
  // No current rows are restamped and no immutable marker is manufactured.
  const migrated = new StateStore(paths, { now: () => clock.now });
  stores.push(migrated);
  enableAfterHours(migrated);
  return { store: migrated, sessionId, clock };
}

describe("after-hours autorespond storage authority", () => {
  test("migrates exact v45 preserving accounting objects, old row columns, counters, and reservation history", async () => {
    const { paths, clock } = await canonicalBudgetRuntimeArchive(45);
    const sessionId = canonicalBudgetRuntimeFixtures[45].retained.freshSession.id;
    const inspector = new Database(paths.database, { create: false, strict: true });
    inspector.exec("PRAGMA query_only=ON");
    const original = capturedDatabaseSnapshot(inspector);
    const canonicalColumns = ["sessions", "work_routes", "work_tasks", "work_attempts"].map((table) => ({
      table,
      columns: z.record(z.string(), z.unknown()).array().parse(inspector.query(`PRAGMA table_xinfo('${table}')`).all()),
    }));
    for (const { columns } of canonicalColumns) {
      expect(columns.some((column) => column.name === "canonical_profile_key")).toBe(false);
    }
    const ledger = inspector.query("SELECT * FROM migrations ORDER BY version").all();
    const retained = canonicalBudgetRuntimeFixtures[45].retained;
    const originalQueue = z.record(z.string().regex(/^[a-z_0-9]+$/u), z.unknown()).parse(
      inspector.query("SELECT * FROM queue_entries WHERE id=?").get(retained.queues.pending.id),
    );
    const queueColumns = Object.keys(originalQueue).map((column) => `"${column}"`).join(",");
    const originalManifest = inspector.query("SELECT * FROM message_attachments WHERE session_id=? AND source_id=? ORDER BY position")
      .all(retained.session.id, retained.queues.pending.id);
    expect(originalQueue).toMatchObject({ session_id: retained.session.id, state: "pending", message: retained.queues.pending.message });
    expect(inspector.query("SELECT state,revision,updated_at FROM sessions WHERE id=?").get(retained.session.id))
      .toEqual({ state: "idle", revision: retained.session.revision, updated_at: retained.session.updatedAt });
    const rows = ["sessions", "profiles", "autorespond_budget_history", "autorespond_budget_reservations", "session_autorespond_counters", "account_mutation_authority_rebinds"]
      .map((name) => {
        const columns = z.array(z.object({ name: z.string().regex(/^[a-z_0-9]+$/u) }).passthrough()).parse(
          inspector.query(`PRAGMA table_info("${name}")`).all(),
        ).map(({ name: column }) => `"${column}"`).join(",");
        return { name, columns, rows: inspector.query(`SELECT ${columns} FROM "${name}"`).all() };
      });
    expect(() => new StateStore(paths, { readonly: true })).toThrow("STATE_SCHEMA_MIGRATION_REQUIRED:45:62");
    expect(capturedDatabaseSnapshot(inspector)).toEqual(original);
    const migrated = new StateStore(paths, { now: () => clock.now });
    stores.push(migrated);
    expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: 62 });
    for (const { table, columns } of canonicalColumns) {
      // Preserve main's new canonical50 column oracle on the authentic45
      // source. Joined60 may append other columns; every old column stays exact.
      const after = z.record(z.string(), z.unknown()).array().parse(inspector.query(`PRAGMA table_xinfo('${table}')`).all());
      expect(after.slice(0, columns.length)).toEqual(columns);
      expect(after.filter((column) => column.name === "canonical_profile_key")).toHaveLength(1);
    }
    // Later canonical and usage migrations append authority columns and
    // strengthen guards. The archived pending queue has no immutable enqueue
    // identity, so its one session must acquire the exact quarantine projection.
    // Preserve every other predecessor cell; the joined migration matrix owns
    // the complete new schema.
    for (const object of original.schema) {
      const parsed = z.object({ name: z.string(), sql: z.string().nullable(), type: z.string() }).parse(object);
      if (/^autorespond_budget_|^session_autorespond_counters$/u.test(parsed.name)) {
        expect(inspector.query("SELECT name,sql,type FROM sqlite_master WHERE name=?").get(parsed.name)).toEqual(parsed);
      }
    }
    expect(inspector.query("SELECT * FROM migrations WHERE version<46 ORDER BY version").all()).toEqual(ledger);
    expect(inspector.query("SELECT * FROM queue_attachment_quarantines WHERE queue_id=? ORDER BY ordinal").all(retained.queues.pending.id)).toEqual([{
      queue_id: retained.queues.pending.id, ordinal: 1, session_id: retained.session.id, kind: "quarantined",
      predecessor: null, expected_session_revision: null, reason: "legacy_identity_unproved", recorded_at: clock.now,
    }]);
    expect(inspector.query("SELECT enqueue_identity_format,enqueue_identity_attempt_id FROM queue_entries WHERE id=?").get(retained.queues.pending.id))
      .toEqual({ enqueue_identity_format: null, enqueue_identity_attempt_id: null });
    expect(inspector.query("SELECT 1 FROM queue_attachment_identities WHERE queue_id=?").all(retained.queues.pending.id)).toEqual([]);
    expect(inspector.query("SELECT 1 FROM queue_attachment_identity_anchors WHERE queue_id=?").all(retained.queues.pending.id)).toEqual([]);
    expect(inspector.query(`SELECT ${queueColumns} FROM queue_entries WHERE id=?`).get(retained.queues.pending.id)).toEqual(originalQueue);
    expect(inspector.query("SELECT * FROM message_attachments WHERE session_id=? AND source_id=? ORDER BY position")
      .all(retained.session.id, retained.queues.pending.id)).toEqual(originalManifest);
    for (const row of rows) {
      const expected = row.name === "sessions" ? row.rows.map((value) => {
        const session = z.record(z.string(), z.unknown()).parse(value);
        return session.id === retained.session.id
          ? { ...session, state: "recovery_required", revision: retained.session.revision + 1, updated_at: clock.now }
          : session;
      }) : row.rows;
      expect(inspector.query(`SELECT ${row.columns} FROM "${row.name}"`).all()).toEqual(expected);
      if (row.name === "sessions") {
        for (const value of row.rows) {
          const session = z.record(z.string(), z.unknown()).parse(value);
          const key = deriveLegacySessionProfileKey(session.provider_v39, session.preset, session.preset_contract);
          expect(key).not.toBeNull();
          expect(inspector.query("SELECT canonical_profile_key FROM sessions WHERE id=?")
            .get(z.string().parse(session.id))).toEqual({ canonical_profile_key: key });
        }
      }
    }
    enableAfterHours(migrated);
    expect(provisional(migrated, sessionId).tier).toBe("after_hours");
    expect(migrated.readAutorespondBudgets(sessionId)).toEqual({ consecutive: 1, lastHour: 1, lastDay: 1 });
    const fresh = provenSession(migrated, migrated.requireSession(sessionId).profileId, "Fresh after v46");
    expect(provisional(migrated, fresh.id).tier).toBe("after_hours");
    inspector.close(false);
  });

  test("rejects missing v45 history or predecessor ledger and rolls failed v46 migration back without partial authority", async () => {
    for (const damage of ["missing_history", "predecessor_ledger", "ledger_failure"] as const) {
      const { paths, sessionId, clock } = await canonicalBudgetArchive(45);
      const inspector = new Database(paths.database);
      // Explicit adversarial mutations of an authentic45 capture; no version
      // relabeling or counterfeit predecessor schema construction occurs.
      if (damage === "missing_history") inspector.query("DELETE FROM autorespond_budget_history WHERE session_id=?").run(sessionId);
      else if (damage === "predecessor_ledger") inspector.exec("DELETE FROM migrations WHERE version=45");
      else inspector.exec(`CREATE TRIGGER reject_v46_ledger BEFORE INSERT ON migrations WHEN NEW.version=46
        BEGIN SELECT RAISE(ABORT,'synthetic migration failure'); END;`);
      const before = capturedDatabaseSnapshot(inspector);
      expect(() => new StateStore(paths, { now: () => clock.now })).toThrow(damage === "missing_history"
        ? "STATE_SCHEMA_V46_AUTORESPOND_BUDGET_HISTORY_INVALID"
        : damage === "predecessor_ledger" ? "STATE_SCHEMA_V45_MIGRATION_LEDGER_INVALID" : "synthetic migration failure");
      expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: 45 });
      expect(capturedDatabaseSnapshot(inspector)).toEqual(before);
      inspector.close(false);
    }
  });

  test.each([
    "collision", "missing_guard", "weak_guard", "extra_trigger", "extra_index",
    "missing_policy", "bad_policy", "missing_barrier", "missing_ledger", "future_ledger",
  ] as const)(
    "rejects predecessor collisions and damaged current authority without repair on writable or readonly reopen: %s",
    async (damage) => {
      let paths: StateStore["paths"];
      let sessionId: string;
      if (damage === "collision") {
        ({ paths, sessionId } = await canonicalBudgetArchive(45));
      } else {
        const current = await fixture();
        paths = current.store.paths;
        sessionId = current.sessionId;
        stores.splice(stores.indexOf(current.store), 1);
        current.store.close();
      }
      const inspector = new Database(paths.database);
      if (damage === "collision") {
        // A deliberately unproved reserved-name collision on actual45, not
        // current authority misrepresented by an old version stamp.
        inspector.exec("CREATE TABLE autorespond_after_hours_policy(unproved INTEGER) STRICT");
      } else if (damage === "missing_guard" || damage === "weak_guard") {
        inspector.exec("DROP TRIGGER autorespond_after_hours_history_update_guard");
        if (damage === "weak_guard") inspector.exec(`CREATE TRIGGER autorespond_after_hours_history_update_guard
          BEFORE UPDATE ON autorespond_after_hours_history BEGIN SELECT 1; END;`);
      } else if (damage === "extra_trigger") {
        inspector.exec("CREATE TRIGGER unrelated_name AFTER UPDATE ON autorespond_after_hours_policy BEGIN SELECT 1; END");
      } else if (damage === "extra_index") {
        inspector.exec("CREATE INDEX unrelated_name ON autorespond_after_hours_history(human_reset_required)");
      } else if (damage === "missing_policy") {
        const sql = (inspector.query("SELECT sql FROM sqlite_master WHERE name='autorespond_after_hours_policy_delete_guard'").get() as { sql: string }).sql;
        inspector.exec("DROP TRIGGER autorespond_after_hours_policy_delete_guard; DELETE FROM autorespond_after_hours_policy");
        inspector.exec(sql);
      } else if (damage === "bad_policy") {
        const sql = (inspector.query("SELECT sql FROM sqlite_master WHERE name='autorespond_after_hours_policy_update_guard'").get() as { sql: string }).sql;
        inspector.exec("DROP TRIGGER autorespond_after_hours_policy_update_guard; PRAGMA ignore_check_constraints=ON; UPDATE autorespond_after_hours_policy SET enabled=2; PRAGMA ignore_check_constraints=OFF");
        inspector.exec(sql);
      } else if (damage === "missing_barrier") {
        const sql = (inspector.query("SELECT sql FROM sqlite_master WHERE name='autorespond_after_hours_history_delete_guard'").get() as { sql: string }).sql;
        inspector.exec("DROP TRIGGER autorespond_after_hours_history_delete_guard");
        inspector.query("DELETE FROM autorespond_after_hours_history WHERE session_id=?").run(sessionId);
        inspector.exec(sql);
      } else if (damage === "missing_ledger") inspector.exec("DELETE FROM migrations WHERE version=46");
      else inspector.exec("INSERT INTO migrations(version,applied_at) VALUES (63,1000000)");
      const before = inspector.query("SELECT * FROM sqlite_master ORDER BY type,name").all();
      const ledger = inspector.query("SELECT * FROM migrations ORDER BY version").all();
      for (const readonly of [true, false]) {
        expect(() => new StateStore(paths, { readonly })).toThrow();
        expect(inspector.query("SELECT * FROM sqlite_master ORDER BY type,name").all()).toEqual(before);
        expect(inspector.query("SELECT * FROM migrations ORDER BY version").all()).toEqual(ledger);
      }
      inspector.close(false);
    },
  );

  test("guards replacement, unproved barrier clearing and exhausted consent revision", async () => {
    const { store, sessionId } = await legacyAfterHoursFixture();
    const inspector = new Database(store.paths.database);
    expect(() => inspector.exec("INSERT OR REPLACE INTO autorespond_after_hours_policy VALUES (1,'autorespond_after_hours',1,1,0,0,0)")).toThrow();
    expect(() => inspector.query("INSERT OR REPLACE INTO autorespond_after_hours_history(session_id,human_reset_required) VALUES (?,0)").run(sessionId)).toThrow();
    expect(() => inspector.query("UPDATE autorespond_after_hours_history SET human_reset_required=0 WHERE session_id=?").run(sessionId)).toThrow();
    const guard = (inspector.query("SELECT sql FROM sqlite_master WHERE name='autorespond_after_hours_policy_update_guard'").get() as { sql: string }).sql;
    inspector.exec("DROP TRIGGER autorespond_after_hours_policy_update_guard");
    inspector.query("UPDATE autorespond_after_hours_policy SET revision=?").run(Number.MAX_SAFE_INTEGER);
    inspector.exec(guard);
    expect(() => store.updateAutorespondAfterHoursPolicy({ enabled: false, expectedRevision: Number.MAX_SAFE_INTEGER }))
      .toThrow("AUTORESPOND_AFTER_HOURS_REVISION_EXHAUSTED");
    expect(store.readAutorespondAfterHoursPolicy()).toMatchObject({ revision: Number.MAX_SAFE_INTEGER, enabled: true });
    inspector.close(false);
  });

  test("keeps strict default-off consent independent of notification consent and schedule revision", async () => {
    const { store, sessionId, clock } = await fixture();
    const original = store.readAutorespondAfterHoursPolicy();
    expect(original).toEqual({ kind: "autorespond_after_hours", version: 1, revision: 1, enabled: false });
    expect(Object.isFrozen(original)).toBe(true);
    const notification = store.readNotificationEmailPolicy();
    store.updateNotificationEmailPolicy({ enabled: true, expectedRevision: notification.revision });
    expect(provisional(store, sessionId).reason).toBe("policy_disabled");
    expect(store.readAutorespondAfterHoursPolicy()).toEqual(original);
    const hours = store.readNotificationHours();
    const email = store.readNotificationEmailPolicy();
    const other = new StateStore(store.paths, { now: () => clock.now });
    stores.push(other);
    expect(other.updateAutorespondAfterHoursPolicy({ enabled: true, expectedRevision: 1 })).toMatchObject({ revision: 2, enabled: true });
    expect(() => store.updateAutorespondAfterHoursPolicy({ enabled: false, expectedRevision: 1 }))
      .toThrow("AUTORESPOND_AFTER_HOURS_POLICY_CONFLICT");
    expect(() => store.updateAutorespondAfterHoursPolicy({ enabled: 1, expectedRevision: 2 } as never)).toThrow();
    expect(() => store.updateAutorespondAfterHoursPolicy({ enabled: false, expectedRevision: 2, limits: 999 } as never)).toThrow();
    expect(store.readNotificationHours()).toEqual(hours);
    expect(store.readNotificationEmailPolicy()).toEqual(email);
    expect(original.enabled).toBe(false);
    const readonly = new StateStore(store.paths, { readonly: true });
    stores.push(readonly);
    expect(readonly.readAutorespondAfterHoursPolicy()).toMatchObject({ revision: 2, enabled: true });
  });

  test("selects one coherent snapshot despite a concurrent schedule and consent writer", async () => {
    const { store, sessionId, clock } = await fixture();
    enableAfterHours(store);
    const other = new StateStore(store.paths, { now: () => clock.now });
    stores.push(other);
    const original = store.readAutorespondAfterHoursPolicy.bind(store);
    store.readAutorespondAfterHoursPolicy = () => {
      const policy = original();
      other.updateAutorespondAfterHoursPolicy({ enabled: false, expectedRevision: policy.revision });
      const hours = other.readNotificationHours();
      other.updateNotificationHours({ version: 1, startMinute: 0, endMinute: 60, timeZone: "UTC", expectedRevision: hours.revision });
      return policy;
    };
    const selected = provisional(store, sessionId);
    store.readAutorespondAfterHoursPolicy = original;
    expect(selected).toMatchObject({ tier: "after_hours", snapshot: { policy: { revision: 2, enabled: true }, schedule: { startMinute: 480, endMinute: 1080 } } });
    expect(provisional(store, sessionId)).toMatchObject({ tier: "baseline", reason: "policy_disabled" });
    expect(store.readAutorespondBudgets(sessionId)).toEqual({ consecutive: 0, lastHour: 0, lastDay: 0 });
  });

  test("reserves six protocol admissions across stores and never resets spend at a schedule crossing", async () => {
    const { store, sessionId, clock } = await fixture();
    enableAfterHours(store);
    clock.now = 9 * AUTORESPOND_HOUR_MS;
    for (let count = 0; count < 3; count += 1) expect(reserveProtocol(store, sessionId)).toEqual({ state: "reserved" });
    expect(reserveProtocol(store, sessionId)).toEqual({ state: "refused", code: "consecutive_limit" });
    clock.now = 18 * AUTORESPOND_HOUR_MS;
    const other = new StateStore(store.paths, { now: () => clock.now });
    stores.push(other);
    for (let count = 0; count < 3; count += 1) expect(reserveProtocol(other, sessionId)).toEqual({ state: "reserved" });
    expect(reserveProtocol(store, sessionId)).toEqual({ state: "refused", code: "consecutive_limit" });
    clock.now = 32 * AUTORESPOND_HOUR_MS;
    expect(provisional(store, sessionId)).toMatchObject({ tier: "baseline", reason: "within_hours" });
    expect(store.readAutorespondBudgets(sessionId).consecutive).toBe(6);
    expect(reserveProtocol(other, sessionId)).toEqual({ state: "refused", code: "consecutive_limit" });
  });

  test("enforces elevated rolling 20/80 ceilings and returns to baseline without refund", async () => {
    const { store, sessionId, clock } = await fixture();
    enableAfterHours(store);
    const start = clock.now;
    for (let hour = 0; hour < 4; hour += 1) {
      clock.now = start + hour * (AUTORESPOND_HOUR_MS + 1);
      for (let count = 0; count < 20; count += 1) {
        store.resetAutorespondCounter(sessionId);
        expect(reserveProtocol(store, sessionId)).toEqual({ state: "reserved" });
      }
      store.resetAutorespondCounter(sessionId);
      expect(reserveProtocol(store, sessionId)).toEqual({ state: "refused", code: "hourly_budget" });
    }
    clock.now += AUTORESPOND_HOUR_MS + 1;
    expect(reserveProtocol(store, sessionId)).toEqual({ state: "refused", code: "daily_budget" });
    const policy = store.readAutorespondAfterHoursPolicy();
    store.updateAutorespondAfterHoursPolicy({ enabled: false, expectedRevision: policy.revision });
    expect(store.readAutorespondBudgets(sessionId).lastDay).toBe(80);
    expect(reserveProtocol(store, sessionId)).toEqual({ state: "refused", code: "daily_budget" });
  });

  test("rederives protocol eligibility from stored display and current mode, not a provisional eligible flag", async () => {
    const { store, sessionId } = await fixture();
    enableAfterHours(store);
    expect(provisional(store, sessionId).tier).toBe("after_hours");
    const sourceId = protocolSource(store, sessionId);
    store.setSessionApprovalMode(sessionId, "auto:workspace");
    expect(store.reserveAutorespondBudget({ sessionId, sourceId, sourceKind: "protocol", expectedMode: "auto:workspace" }))
      .toEqual({ state: "refused", code: "protected_authority_required" });
    store.setSessionApprovalMode(sessionId, "auto:all");
    const unavailable = protocolSource(store, sessionId, false);
    expect(reserveProtocol(store, sessionId, unavailable)).toEqual({ state: "refused", code: "decision_unavailable" });
    expect(store.readAutorespondBudgets(sessionId)).toEqual({ consecutive: 0, lastHour: 0, lastDay: 0 });
  });

  test("keeps prose at baseline and refuses invalid accounting clocks instead of using fallback limits", async () => {
    const { store, sessionId, clock } = await fixture();
    enableAfterHours(store);
    expect(store.readAutorespondAfterHoursSelection(sessionId, "prose", "eligible")).toMatchObject({ tier: "baseline", reason: "prose_baseline", limits: { consecutive: 3, lastHour: 10, lastDay: 40 } });
    expect(store.readAutorespondAfterHoursSelection(sessionId, "protocol", "eligible", Number.NaN)).toMatchObject({ tier: "baseline" });
    const sourceId = protocolSource(store, sessionId);
    for (const invalidTime of [Number.NaN, Number.POSITIVE_INFINITY, -1, 8_640_000_000_000_001]) {
      clock.now = invalidTime;
      expect(() => reserveProtocol(store, sessionId, sourceId)).toThrow();
    }
    clock.now = 1_000_000;
    expect(store.readAutorespondBudgets(sessionId)).toEqual({ consecutive: 0, lastHour: 0, lastDay: 0 });
    expect(reserveProtocol(store, sessionId, sourceId)).toEqual({ state: "reserved" });
    clock.now -= 1;
    expect(provisional(store, sessionId)).toMatchObject({ tier: "baseline", reason: "history_unproven" });
    expect(reserveProtocol(store, sessionId)).toEqual({ state: "refused", code: "history_unavailable" });
    expect(store.readAutorespondBudgets(sessionId)).toEqual({ consecutive: 1, lastHour: 1, lastDay: 1 });
  });

  test("charges prose against the lower tier even when protocol is enabled outside hours", async () => {
    const { store, sessionId } = await fixture();
    enableAfterHours(store);
    for (let count = 0; count < 3; count += 1) expect(reserveProtocol(store, sessionId)).toEqual({ state: "reserved" });
    const { sourceId } = prepareSyntheticSend(store, sessionId, "Synthetic approved continuation", "autorespond");
    expect(store.reserveAutorespondBudget({ sessionId, sourceId, sourceKind: "prose", expectedMode: "auto:all" }))
      .toEqual({ state: "refused", code: "consecutive_limit" });
    expect(reserveProtocol(store, sessionId)).toEqual({ state: "reserved" });
    expect(store.readAutorespondBudgets(sessionId)).toEqual({ consecutive: 4, lastHour: 4, lastDay: 4 });
  });

  test("schedule read failure selects baseline but missing policy or barrier cannot become approval authority", async () => {
    const { store, sessionId } = await fixture();
    enableAfterHours(store);
    const readHours = store.readNotificationHours.bind(store);
    store.readNotificationHours = () => { throw new Error("Synthetic schedule read failure"); };
    expect(provisional(store, sessionId)).toMatchObject({ tier: "baseline", reason: "schedule_invalid" });
    for (let count = 0; count < 3; count += 1) expect(reserveProtocol(store, sessionId)).toEqual({ state: "reserved" });
    expect(reserveProtocol(store, sessionId)).toEqual({ state: "refused", code: "consecutive_limit" });
    store.readNotificationHours = readHours;
    const inspector = new Database(store.paths.database);
    inspector.exec("PRAGMA ignore_check_constraints=ON");
    inspector.query("UPDATE notification_hours SET revision=revision+1,end_minute=start_minute").run();
    inspector.query("UPDATE attention_email_policy SET revision=revision+1").run();
    inspector.exec("PRAGMA ignore_check_constraints=OFF");
    expect(provisional(store, sessionId)).toMatchObject({ tier: "baseline", reason: "schedule_invalid" });
    const readPolicy = store.readAutorespondAfterHoursPolicy.bind(store);
    store.readAutorespondAfterHoursPolicy = () => { throw new Error("Synthetic missing approval consent"); };
    expect(() => provisional(store, sessionId)).toThrow("Synthetic missing approval consent");
    expect(() => reserveProtocol(store, sessionId)).toThrow("Synthetic missing approval consent");
    store.readAutorespondAfterHoursPolicy = readPolicy;
    inspector.exec("DROP TRIGGER autorespond_after_hours_history_delete_guard");
    inspector.query("DELETE FROM autorespond_after_hours_history WHERE session_id=?").run(sessionId);
    expect(() => provisional(store, sessionId)).toThrow();
    expect(() => reserveProtocol(store, sessionId)).toThrow();
    expect(store.readAutorespondBudgets(sessionId)).toEqual({ consecutive: 3, lastHour: 3, lastDay: 3 });
    inspector.close(false);
  });

  test("neither historical human replay nor its exact old receipt clears a newly migrated barrier", async () => {
    const { store, sessionId } = await legacyAfterHoursFixture();
    const historicalSourceId = canonicalBudgetRuntimeFixtures[45].retained.historicalSourceId;
    expect(store.finalizeSessionUserMessageSource({ sessionId, sourceKind: "queue", sourceId: historicalSourceId, turnId: "synthetic-turn" })).toBeNull();
    expect(provisional(store, sessionId).reason).toBe("human_reset_required");
    const inspector = new Database(store.paths.database);
    expect(() => inspector.query(`UPDATE autorespond_after_hours_history
      SET human_reset_required=0,reset_source_kind='queue',reset_source_id=? WHERE session_id=?`)
      .run(historicalSourceId, sessionId)).toThrow("autorespond after-hours history requires exact human finalization");
    inspector.close(false);
    expect(provisional(store, sessionId).reason).toBe("human_reset_required");
  });

  test("legacy positive history requires a new human finalization, not clock expiry, generic reset, or autorespond", async () => {
    const { store, sessionId, clock } = await legacyAfterHoursFixture();
    expect(provisional(store, sessionId)).toMatchObject({ tier: "baseline", reason: "human_reset_required" });
    store.resetAutorespondCounter(sessionId);
    finishQueueSource(store, sessionId, "autorespond")();
    finishQueueSource(store, sessionId, "automation")();
    finishQueueSource(store, sessionId, "provider_switch")();
    expect(provisional(store, sessionId).reason).toBe("human_reset_required");
    for (let count = 0; count < 2; count += 1) expect(reserveProtocol(store, sessionId)).toEqual({ state: "reserved" });
    expect(reserveProtocol(store, sessionId)).toEqual({ state: "refused", code: "consecutive_limit" });
    const humanFinalize = finishQueueSource(store, sessionId);
    expect(humanFinalize()?.body).toMatchObject({ type: "user_message", actor: "human" });
    expect(provisional(store, sessionId).tier).toBe("after_hours");
    expect(store.readAutorespondBudgets(sessionId).consecutive).toBe(0);
    expect(humanFinalize()).toBeNull();
    // Cleared history is durable proof, not a foreign key to retained events.
    store.maintainSessionEventRetention(sessionId, clock.now + 365 * AUTORESPOND_DAY_MS);
    expect(store.listSessionEvents({ sessionId, afterSequence: 0 }).events).toHaveLength(0);
    const reopened = new StateStore(store.paths, { now: () => clock.now });
    stores.push(reopened);
    expect(provisional(reopened, sessionId).tier).toBe("after_hours");
  });

  test("clears a legacy barrier on exact direct human mutation finalization", async () => {
    const { store, sessionId } = await legacyAfterHoursFixture();
    const { session, sourceId, attempt, providerAuthority, providerConnectionId, runtimeProfile, message } =
      prepareSyntheticSend(store, sessionId, "Synthetic human reset", "human");
    expect(provisional(store, sessionId).reason).toBe("human_reset_required");
    const completed = store.completeSessionTurnEffect({
      attemptId: attempt.id, sessionId, accountId: providerAuthority.profileId, providerGeneration: providerAuthority.processGeneration,
      providerAuthority, providerConnectionId, expectedSessionRevision: session.revision, applyResponseState: true,
      runtimeProfile, message, turnId: "synthetic-human-turn", turnStatus: "completed", receipt: { turnId: "synthetic-human-turn" },
    });
    expect(completed.event.body)
      .toMatchObject({ type: "user_message", actor: "human" });
    expect(provisional(store, sessionId).tier).toBe("after_hours");
    expect(store.finalizeSessionUserMessageSource({ sessionId, sourceKind: "mutation", sourceId, turnId: "synthetic-human-turn" })).toBeNull();
  });

  test("rolls barrier, counter, source and event back if finalization fails after the human reset", async () => {
    const { store, sessionId } = await legacyAfterHoursFixture();
    const originalEvents = store.listSessionEvents({ sessionId, afterSequence: 0 }).events;
    store.bumpAutorespondCounter(sessionId);
    const finalize = finishQueueSource(store, sessionId);
    const inspector = new Database(store.paths.database);
    inspector.exec(`CREATE TRIGGER reject_after_hours_stream_advance BEFORE UPDATE OF next_sequence ON session_event_streams
      BEGIN SELECT RAISE(ABORT,'synthetic stream failure'); END;`);
    expect(finalize).toThrow("synthetic stream failure");
    expect(provisional(store, sessionId).reason).toBe("human_reset_required");
    expect(store.readAutorespondBudgets(sessionId).consecutive).toBe(1);
    expect(store.listSessionEvents({ sessionId, afterSequence: 0 }).events).toEqual(originalEvents);
    inspector.exec("DROP TRIGGER reject_after_hours_stream_advance");
    expect(finalize()?.body).toMatchObject({ actor: "human" });
    expect(provisional(store, sessionId).tier).toBe("after_hours");
    inspector.close(false);
  });
});
