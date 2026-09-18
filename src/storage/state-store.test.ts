import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { Database } from "bun:sqlite";
import { initialAutomaticUsagePolicyConfiguration, type AutomaticUsagePolicyConfigurationUpdate } from "../domain/usage-policy";
import { resolveStatePaths } from "./paths";
import { StateStore } from "./state-store";
import {
  completeCodexAccountMutationAuthorityRetirement,
  drainStateStoreCasesAndClose,
  fixture,
  ownedStateStoreCase,
  ownedStateStoreCaseDrains,
  recordUsageForTest,
  resetAccountFingerprint,
  signInProfile,
  stores,
} from "../../scripts/fixtures/state-store-testkit";

setDefaultTimeout(60_000);

describe("owned StateStore case lifecycle", () => {
  test("registers before deferred setup and cancels before opening a store", async () => {
    const drains: Array<() => Promise<void>> = [];
    let opened = false;
    const caseTask = ownedStateStoreCase(async () => { opened = true; }, drains);
    expect(drains).toHaveLength(1);
    expect(opened).toBe(false);
    await drainStateStoreCasesAndClose(drains, () => []);
    await expect(caseTask).rejects.toThrow("Owned StateStore case is closing.");
    expect(opened).toBe(false);
    expect(drains).toHaveLength(0);
  });

  test("joins a paused raw callback before closing initial and reopened stores", async () => {
    const drains: Array<() => Promise<void>> = [];
    const entered = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    const events: string[] = [];
    const closeTargets = [{ close: () => { events.push("close-initial"); } }];
    const caseTask = ownedStateStoreCase(async ({ request }) => {
      await request(async () => {
        entered.resolve(undefined);
        await release.promise;
        events.push("raw-settled");
        closeTargets.push({ close: () => { events.push("close-reopened"); } });
      });
      events.push("continued-after-abort");
    }, drains);
    await entered.promise;
    let closed = false;
    const teardown = drainStateStoreCasesAndClose(drains, () => {
      closed = true;
      return closeTargets;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(events).toEqual([]);
    release.resolve(undefined);
    await teardown;
    await expect(caseTask).rejects.toThrow("Owned StateStore case is closing.");
    expect(events).toEqual(["raw-settled", "close-initial", "close-reopened"]);
  });

  test("retains every late raw failure and closes every store after all drains settle", async () => {
    const drains: Array<() => Promise<void>> = [];
    const entered = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    const lateFailure = new Error("late createProject failure");
    const otherFailure = new Error("another raw callback failure");
    const closeFailure = new Error("first store close failed");
    const events: string[] = [];
    const lateCase = ownedStateStoreCase(async ({ request }) => {
      await request(async () => {
        entered.resolve(undefined);
        await release.promise;
        events.push("late-raw-settled");
        throw lateFailure;
      });
    }, drains);
    const otherCase = ownedStateStoreCase(async () => { throw otherFailure; }, drains);
    await entered.promise;
    const teardown = drainStateStoreCasesAndClose(drains, () => [
      { close: () => { events.push("close-first"); throw closeFailure; } },
      { close: () => { events.push("close-second"); } },
    ]);
    const observedTeardown = teardown.catch((error: unknown) => error);
    await Promise.resolve();
    expect(events).toEqual([]);
    release.resolve(undefined);
    const error = await observedTeardown;
    expect(error).toBeInstanceOf(AggregateError);
    if (!(error instanceof AggregateError)) throw new Error("Expected every teardown failure.");
    expect(error.errors).toEqual([lateFailure, otherFailure, closeFailure]);
    expect(error.errors[0]).toBe(lateFailure);
    await expect(lateCase).rejects.toBe(lateFailure);
    await expect(otherCase).rejects.toBe(otherFailure);
    expect(events).toEqual(["late-raw-settled", "close-first", "close-second"]);
  });
});

describe("automatic usage policy configuration", () => {
  const command = (expectedAutomaticPolicyRevision = 1): AutomaticUsagePolicyConfigurationUpdate => ({
    idempotencyKey: randomUUID(), expectedAutomaticPolicyRevision,
    change: { kind: "set_default", enabled: false },
  });
  const pathsFor = (home: string) => resolveStatePaths({ homeDirectory: home, platform: "darwin" });
  const inspect = (home: string) => new Database(pathsFor(home).database, { create: false, strict: true });
  const reopen = (home: string, readonly = false) => {
    const store = new StateStore(pathsFor(home), { readonly, now: () => 50 });
    stores.push(store);
    return store;
  };
  const unrelatedRows = (database: Database) => {
    const names = database.query(`SELECT name FROM sqlite_master WHERE type='table'
      AND name NOT LIKE 'sqlite_%' AND name NOT IN ('migrations','automatic_usage_policy_revisions','mutation_attempts') ORDER BY name`)
      .all() as Array<{ name: string }>;
    return names.map(({ name }) => {
      if (!/^[a-z_][a-z0-9_]*$/u.test(name)) throw new Error("Unexpected fixture table");
      return [name, database.query(`SELECT * FROM ${name}`).all()];
    });
  };
  const policyAdmissionSnapshot = (database: Database) => ({
    schema: database.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all(),
    version: database.query("PRAGMA user_version").get(),
    migrations: database.query("SELECT * FROM migrations ORDER BY version").all(),
    mutations: database.query("SELECT * FROM mutation_attempts ORDER BY id").all(),
    policy: database.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='automatic_usage_policy_revisions'").get() === null
      ? null : database.query("SELECT * FROM automatic_usage_policy_revisions ORDER BY automatic_policy_revision").all(),
    unrelated: unrelatedRows(database),
  });
  const seedUnrelatedState = (store: StateStore) => {
    const primary = signInProfile(store, "Policy primary", "policy-primary@example.com");
    const secondary = signInProfile(store, "Policy secondary", "policy-secondary@example.com");
    for (const profile of [primary, secondary]) store.allocateNextUsageRevision(profile.id);
    recordUsageForTest(store, primary.id, 1, 1_000, { sentinel: "configuration must preserve usage" });
    store.updateNotificationHours({ version: 1, expectedRevision: 1, startMinute: 480, endMinute: 1_200, timeZone: "UTC" });
    store.updateNotificationEmailPolicy({ enabled: true, expectedRevision: store.readNotificationEmailPolicy().revision });
    for (const provider of ["codex", "claude"] as const) {
      const accounts = store.listProviderAccounts(provider);
      const first = accounts[0];
      if (first === undefined) throw new Error("Missing fixture provider");
      store.replaceProviderAccountOrder({ provider, expectedOrderRevision: store.readProviderAccountState(provider).orderRevision,
        providerAccountIds: accounts.toReversed().map((account) => account.id) });
      store.activateProviderAccount({ provider, expectedPointerRevision: store.readProviderAccountState(provider).pointerRevision, providerAccountId: first.id });
    }
    const session = store.createSession({ profileId: primary.id, provider: "codex", preset: "high", fastEnabled: false });
    store.bindSession({ sessionId: session.id, expectedRevision: session.revision, providerThreadId: "policy-preserved-thread", state: "idle" });
    store.authorizeAccountRateLimitResetPolicy({ profileId: primary.id, processGeneration: primary.processGeneration,
      accountFingerprint: resetAccountFingerprint("policy-primary@example.com"), weeklyWindowDurationMinutes: 10_080, weeklyWindowResetsAt: 500_000_000 });
    store.prepareAccountRateLimitReset({ profileId: primary.id, processGeneration: primary.processGeneration,
      accountFingerprint: resetAccountFingerprint("policy-primary@example.com"), weeklyWindowResetsAt: 500_000_000, observedUsedPercent: 99 });
  };

  test("starts at the domain default and changes only configuration and its global receipt", async () => {
    const { store, home } = await fixture({ provision: "migrate" });
    seedUnrelatedState(store);
    const database = inspect(home);
    try {
      const baseline = unrelatedRows(database);
      expect(store.readAutomaticUsagePolicyConfiguration()).toEqual(initialAutomaticUsagePolicyConfiguration());
      expect(database.query("PRAGMA user_version").get()).toEqual({ user_version: 61 });
      const request = command();
      expect(store.updateAutomaticUsagePolicyConfiguration(request)).toEqual({
        ...initialAutomaticUsagePolicyConfiguration(), defaultEnabled: false, automaticPolicyRevision: 2,
      });
      expect(store.readMutation(request.idempotencyKey)).toMatchObject({
        kind: "usage.auto.configure", authorityId: "automatic-usage-policy", authorityGeneration: 1, state: "applied",
        result: { version: 1, automaticPolicyRevision: 2 },
      });
      expect(unrelatedRows(database)).toEqual(baseline);
      expect(reopen(home, true).readAutomaticUsagePolicyConfiguration()).toEqual(store.readAutomaticUsagePolicyConfiguration());
    } finally { database.close(false); }
  });

  test("preserves unaddressed overrides, no-op revisions, ABA fences and historical replay after reopen", async () => {
    const { store, home } = await fixture();
    const initial = { ...command(), change: { kind: "set_default", enabled: true } as const };
    const original = store.updateAutomaticUsagePolicyConfiguration(initial);
    expect(original.automaticPolicyRevision).toBe(2);
    const off = store.updateAutomaticUsagePolicyConfiguration(command(2));
    expect(off.automaticPolicyRevision).toBe(3);
    for (const provider of ["codex", "claude"] as const) {
      for (const override of ["on", "off", "inherit"] as const) {
        const before = store.readAutomaticUsagePolicyConfiguration();
        const next = store.updateAutomaticUsagePolicyConfiguration({
          ...command(before.automaticPolicyRevision), change: { kind: "set_override", provider, override },
        });
        expect(next.defaultEnabled).toBe(false);
        expect(next.overrides[provider]).toBe(override);
        expect(next.overrides[provider === "codex" ? "claude" : "codex"]).toBe(before.overrides[provider === "codex" ? "claude" : "codex"]);
      }
    }
    const before = store.readAutomaticUsagePolicyConfiguration();
    const head = store.updateAutomaticUsagePolicyConfiguration({
      ...command(before.automaticPolicyRevision), change: { kind: "set_default", enabled: true },
    });
    expect(head).toEqual({ ...initialAutomaticUsagePolicyConfiguration(), automaticPolicyRevision: 10 });
    expect(() => store.updateAutomaticUsagePolicyConfiguration(command(1))).toThrow("AUTOMATIC_USAGE_POLICY_REVISION_CONFLICT");
    expect(store.updateAutomaticUsagePolicyConfiguration(initial)).toEqual(original);
    const opened = reopen(home);
    expect(opened.updateAutomaticUsagePolicyConfiguration(initial)).toEqual(original);
    expect(opened.readAutomaticUsagePolicyConfiguration()).toEqual(head);
  });

  test("uses the global idempotency namespace and never reinterprets a key", async () => {
    const { store } = await fixture();
    const collision = command();
    store.prepareMutation({ idempotencyKey: collision.idempotencyKey, kind: "test.other", authorityId: "test", authorityGeneration: 1, request: {} });
    expect(() => store.updateAutomaticUsagePolicyConfiguration(collision)).toThrow("IDEMPOTENCY_CONFLICT");
    const accepted = command();
    store.updateAutomaticUsagePolicyConfiguration(accepted);
    expect(() => store.updateAutomaticUsagePolicyConfiguration({ ...accepted, expectedAutomaticPolicyRevision: 2 })).toThrow("IDEMPOTENCY_CONFLICT");
    expect(() => store.updateAutomaticUsagePolicyConfiguration({ ...accepted, change: { kind: "set_default", enabled: true } })).toThrow("IDEMPOTENCY_CONFLICT");
    expect(() => store.prepareMutation({ idempotencyKey: accepted.idempotencyKey, kind: "test.other", authorityId: "test", authorityGeneration: 1, request: {} })).toThrow("IDEMPOTENCY_CONFLICT");
    expect(() => store.prepareMutation({ kind: "usage.auto.configure", authorityId: "automatic-usage-policy", authorityGeneration: 2, request: {} })).toThrow("AUTOMATIC_USAGE_POLICY_CLOSED_API_REQUIRED");
  });

  test("one current CAS wins across independent stores and a backwards clock cannot regress evidence", async () => {
    const { store, home } = await fixture();
    const contender = reopen(home);
    expect(contender.readAutomaticUsagePolicyConfiguration().automaticPolicyRevision).toBe(1);
    store.updateAutomaticUsagePolicyConfiguration(command());
    const rejected = command();
    expect(() => contender.updateAutomaticUsagePolicyConfiguration(rejected)).toThrow("AUTOMATIC_USAGE_POLICY_REVISION_CONFLICT");
    expect(contender.readMutation(rejected.idempotencyKey)).toBeNull();
    expect(contender.updateAutomaticUsagePolicyConfiguration(command(2)).automaticPolicyRevision).toBe(3);
    const database = inspect(home);
    try {
      const times = database.query("SELECT recorded_at FROM automatic_usage_policy_revisions ORDER BY automatic_policy_revision").all() as Array<{ recorded_at: number }>;
      expect(times[2]?.recorded_at).toBe(times[1]?.recorded_at);
    } finally { database.close(false); }
  });


  test.each([
    { extra: true }, { expectedAutomaticPolicyRevision: 0 }, { expectedAutomaticPolicyRevision: Number.MAX_SAFE_INTEGER + 1 },
    { idempotencyKey: "not-a-uuid" }, { change: { kind: "set_default", enabled: 1 } },
    { change: { kind: "set_default", enabled: false, threshold: 99 } },
    { change: { kind: "set_override", provider: "other", override: "on" } },
    { change: { kind: "set_override", provider: "codex", override: "enabled" } },
  ])("rejects a non-closed command without claiming its key: %j", async (invalid) => {
    const { store, home } = await fixture();
    const request = { ...command(), ...invalid };
    expect(() => store.updateAutomaticUsagePolicyConfiguration(request as AutomaticUsagePolicyConfigurationUpdate)).toThrow();
    expect(store.readAutomaticUsagePolicyConfiguration()).toEqual(initialAutomaticUsagePolicyConfiguration());
    const database = inspect(home);
    try {
      expect(database.query("SELECT 1 FROM mutation_attempts WHERE idempotency_key=?").get(request.idempotencyKey)).toBeNull();
    } finally { database.close(false); }
  });

  test.each(["before_intent", "after_intent", "after_revision", "before_receipt", "after_receipt"])("rolls back every row and key after %s failure", async (point) => {
    const { store, home } = await fixture();
    const database = inspect(home);
    const request = command();
    const boundary = point === "before_intent" ? "BEFORE INSERT ON mutation_attempts WHEN NEW.kind='usage.auto.configure'"
      : point === "after_intent" ? "AFTER UPDATE ON mutation_attempts WHEN NEW.kind='usage.auto.configure' AND NEW.state='effect_started'"
        : point === "after_revision" ? "AFTER INSERT ON automatic_usage_policy_revisions WHEN NEW.automatic_policy_revision>1"
          : `${point === "before_receipt" ? "BEFORE" : "AFTER"} UPDATE ON mutation_attempts WHEN NEW.kind='usage.auto.configure' AND NEW.state='applied'`;
    try {
      database.exec(`CREATE TRIGGER test_policy_fault ${boundary} BEGIN SELECT RAISE(ABORT,'test policy fault'); END`);
      expect(() => store.updateAutomaticUsagePolicyConfiguration(request)).toThrow("test policy fault");
      expect(store.readMutation(request.idempotencyKey)).toBeNull();
      expect(store.readAutomaticUsagePolicyConfiguration()).toEqual(initialAutomaticUsagePolicyConfiguration());
      expect(database.query("SELECT COUNT(*) AS count FROM automatic_usage_policy_revisions").get()).toEqual({ count: 1 });
      database.exec("DROP TRIGGER test_policy_fault");
      expect(store.updateAutomaticUsagePolicyConfiguration(request).automaticPolicyRevision).toBe(2);
      expect(store.updateAutomaticUsagePolicyConfiguration(request).automaticPolicyRevision).toBe(2);
    } finally { database.close(false); }
  });

  test("guards immutable revisions and receipts against direct SQL and generic transitions", async () => {
    const { store, home } = await fixture();
    const request = command();
    store.updateAutomaticUsagePolicyConfiguration(request);
    const attempt = store.readMutation(request.idempotencyKey);
    if (attempt === null) throw new Error("Missing fixture attempt");
    const database = inspect(home);
    try {
      for (const sql of [
        "UPDATE automatic_usage_policy_revisions SET default_enabled=1 WHERE automatic_policy_revision=2",
        "DELETE FROM automatic_usage_policy_revisions WHERE automatic_policy_revision=2",
        "UPDATE mutation_attempts SET result_json='{}' WHERE kind='usage.auto.configure'",
        "UPDATE mutation_attempts SET request_digest='" + "f".repeat(64) + "' WHERE kind='usage.auto.configure'",
        "DELETE FROM mutation_attempts WHERE kind='usage.auto.configure'",
        "INSERT INTO automatic_usage_policy_revisions SELECT 3,version,default_enabled,codex_override,claude_override,attempt_id,idempotency_key,change_kind,change_provider,change_value,request_digest,configuration_digest,recorded_at FROM automatic_usage_policy_revisions WHERE automatic_policy_revision=2",
      ]) expect(() => database.exec(sql)).toThrow();
      expect(() => store.transitionMutation(attempt.id, "applied", "applied", {})).toThrow("receipt-backed");
      expect(store.updateAutomaticUsagePolicyConfiguration(request).automaticPolicyRevision).toBe(2);
    } finally { database.close(false); }
  });

  test.each(["missing_table", "missing_initial", "weakened_guard", "digest", "receipt", "request"])("fails closed on current-schema corruption: %s", async (damage) => {
    const { store, home } = await fixture({ provision: "migrate" });
    const request = command();
    store.updateAutomaticUsagePolicyConfiguration(request);
    const database = inspect(home);
    try {
      if (damage === "missing_table") database.exec("DROP TABLE automatic_usage_policy_revisions");
      else if (damage === "weakened_guard") database.exec(`DROP TRIGGER automatic_usage_policy_immutable_update;
        CREATE TRIGGER automatic_usage_policy_immutable_update BEFORE UPDATE ON automatic_usage_policy_revisions BEGIN SELECT 1; END`);
      else if (damage === "missing_initial") {
        const original = (database.query("SELECT sql FROM sqlite_master WHERE name='automatic_usage_policy_immutable_delete'").get() as { sql: string }).sql;
        database.exec("DROP TRIGGER automatic_usage_policy_immutable_delete; DELETE FROM automatic_usage_policy_revisions");
        database.exec(original);
      } else if (damage === "digest") {
        const original = (database.query("SELECT sql FROM sqlite_master WHERE name='automatic_usage_policy_immutable_update'").get() as { sql: string }).sql;
        database.exec("DROP TRIGGER automatic_usage_policy_immutable_update");
        database.query("UPDATE automatic_usage_policy_revisions SET configuration_digest=? WHERE automatic_policy_revision=2").run("f".repeat(64));
        database.exec(original);
      } else {
        const original = (database.query("SELECT sql FROM sqlite_master WHERE name='automatic_usage_policy_mutation_update_guard'").get() as { sql: string }).sql;
        database.exec("DROP TRIGGER automatic_usage_policy_mutation_update_guard");
        if (damage === "receipt") database.exec("UPDATE mutation_attempts SET result_json='{}' WHERE kind='usage.auto.configure'");
        else database.query("UPDATE mutation_attempts SET request_digest=? WHERE kind='usage.auto.configure'").run("f".repeat(64));
        database.exec(original);
      }
      const beforeAdmission = policyAdmissionSnapshot(database);
      expect(() => store.readAutomaticUsagePolicyConfiguration()).toThrow();
      expect(() => store.updateAutomaticUsagePolicyConfiguration(request)).toThrow();
      for (const readonly of [true, false]) {
        expect(() => { new StateStore(pathsFor(home), { readonly }).close(); }).toThrow();
        expect(policyAdmissionSnapshot(database)).toEqual(beforeAdmission);
      }
      expect(database.query("PRAGMA user_version").get()).toEqual({ user_version: 61 });
    } finally { database.close(false); }
  });

  test("rejects SQL null-intent, wrong authority, changed sibling fields and unsafe revisions", async () => {
    const { store, home } = await fixture();
    const database = inspect(home);
    try {
      for (const violation of ["null_value", "generation", "sibling", "gap", "unsafe"] as const) {
        expect(() => database.transaction(() => {
          const id = `attempt_${"b".repeat(32)}`;
          const key = randomUUID();
          const timestamp = (database.query("SELECT recorded_at FROM automatic_usage_policy_revisions").get() as { recorded_at: number }).recorded_at;
          database.query(`INSERT INTO mutation_attempts(id,idempotency_key,kind,authority_id,authority_generation,request_digest,state,created_at,updated_at)
            VALUES(?,?,'usage.auto.configure','automatic-usage-policy',?,?,'prepared',?,?)`)
            .run(id, key, violation === "generation" ? 2 : 1, "a".repeat(64), timestamp, timestamp);
          database.query("UPDATE mutation_attempts SET state='effect_started' WHERE id=?").run(id);
          expect(() => database.query(`INSERT INTO automatic_usage_policy_revisions(
            automatic_policy_revision,version,default_enabled,codex_override,claude_override,attempt_id,idempotency_key,
            change_kind,change_provider,change_value,request_digest,configuration_digest,recorded_at
          ) VALUES(?,1,0,?,'inherit',?,?,'set_default',NULL,?,?,?,?)`)
            .run(violation === "unsafe" ? Number.MAX_SAFE_INTEGER + 1 : violation === "gap" ? 3 : 2,
              violation === "sibling" ? "on" : "inherit", id, key, violation === "null_value" ? null : "off",
              "a".repeat(64), "b".repeat(64), timestamp)).toThrow();
          throw new Error("rollback fixture intent");
        })()).toThrow("rollback fixture intent");
      }
      expect(store.readAutomaticUsagePolicyConfiguration()).toEqual(initialAutomaticUsagePolicyConfiguration());
      expect(database.query("SELECT COUNT(*) AS count FROM mutation_attempts WHERE kind='usage.auto.configure'").get()).toEqual({ count: 0 });
    } finally { database.close(false); }
  });

  test("refuses relocation of a historical receipt to a different global mutation key", async () => {
    const { store, home } = await fixture();
    const request = command();
    store.updateAutomaticUsagePolicyConfiguration(request);
    const reassignedKey = randomUUID();
    const database = inspect(home);
    try {
      const guard = (database.query("SELECT sql FROM sqlite_master WHERE name='automatic_usage_policy_mutation_update_guard'").get() as { sql: string }).sql;
      database.exec("DROP TRIGGER automatic_usage_policy_mutation_update_guard");
      database.query("UPDATE mutation_attempts SET idempotency_key=? WHERE idempotency_key=?").run(reassignedKey, request.idempotencyKey);
      database.exec(guard);
      expect(() => store.updateAutomaticUsagePolicyConfiguration({ ...request, idempotencyKey: reassignedKey })).toThrow("AUTOMATIC_USAGE_POLICY_INVALID");
      expect(() => store.updateAutomaticUsagePolicyConfiguration(request)).toThrow("AUTOMATIC_USAGE_POLICY_INVALID");
      expect(() => reopen(home, true)).toThrow("AUTOMATIC_USAGE_POLICY_INVALID");
      expect(() => reopen(home)).toThrow("AUTOMATIC_USAGE_POLICY_INVALID");
      expect(database.query("SELECT COUNT(*) AS count FROM automatic_usage_policy_revisions").get()).toEqual({ count: 2 });
      expect(database.query("SELECT 1 FROM mutation_attempts WHERE idempotency_key=?").get(request.idempotencyKey)).toBeNull();
    } finally { database.close(false); }
  });

  test("audits more than two history pages on reopen and rejects tampered old receipts", async () => {
    const { store, home } = await fixture();
    const first = command();
    store.updateAutomaticUsagePolicyConfiguration(first);
    for (let revision = 2; revision <= 205; revision++) store.updateAutomaticUsagePolicyConfiguration(command(revision));
    expect(reopen(home, true).readAutomaticUsagePolicyConfiguration().automaticPolicyRevision).toBe(206);
    expect(store.updateAutomaticUsagePolicyConfiguration(first).automaticPolicyRevision).toBe(2);
    const database = inspect(home);
    try {
      const firstAttempt = store.readMutation(first.idempotencyKey);
      if (firstAttempt === null) throw new Error("Missing fixture attempt");
      const plan = database.query("EXPLAIN QUERY PLAN SELECT * FROM automatic_usage_policy_revisions WHERE attempt_id=?")
        .all(firstAttempt.id) as Array<{ detail: string }>;
      expect(plan.some((step) => step.detail.includes("INDEX"))).toBe(true);
      const original = (database.query("SELECT sql FROM sqlite_master WHERE name='automatic_usage_policy_mutation_update_guard'").get() as { sql: string }).sql;
      database.exec("DROP TRIGGER automatic_usage_policy_mutation_update_guard");
      database.query("UPDATE mutation_attempts SET result_json='{}' WHERE idempotency_key=?").run(first.idempotencyKey);
      database.exec(original);
      expect(() => store.updateAutomaticUsagePolicyConfiguration(first)).toThrow("AUTOMATIC_USAGE_POLICY_INVALID");
      expect(() => new StateStore(pathsFor(home), { readonly: true })).toThrow("AUTOMATIC_USAGE_POLICY_INVALID");
      expect(() => new StateStore(pathsFor(home))).toThrow("AUTOMATIC_USAGE_POLICY_INVALID");
    } finally { database.close(false); }
  });

  test.each([false, true])("refuses an adversarial joined-schema v43 restamp with missing or partial policy without writes (partial=%s)", async (partial) => {
    const { store, home } = await fixture({ provision: "migrate" });
    seedUnrelatedState(store);
    if (partial) store.updateAutomaticUsagePolicyConfiguration(command());
    const database = inspect(home);
    try {
      const beforeDamage = unrelatedRows(database);
      // Deliberately inconsistent current input, not archived43/44 producer
      // evidence. Retain all joined custody and change only the named policy
      // surface and claimed ledger/version; a lower stamp grants no repair.
      if (!partial) database.exec("DROP TABLE automatic_usage_policy_revisions");
      else database.exec("DROP TRIGGER automatic_usage_policy_immutable_update");
      database.exec("DELETE FROM migrations WHERE version>=44; PRAGMA user_version=43");
      const baseline = unrelatedRows(database);
      expect(baseline.filter(([, rows]) => Array.isArray(rows) && rows.length > 0))
        .toEqual(beforeDamage.filter(([, rows]) => Array.isArray(rows) && rows.length > 0));
      const beforeAdmission = {
        schema: database.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all(),
        migrations: database.query("SELECT * FROM migrations ORDER BY version").all(),
        policy: partial ? database.query("SELECT * FROM automatic_usage_policy_revisions ORDER BY automatic_policy_revision").all() : null,
      };
      expect(() => new StateStore(pathsFor(home), { readonly: true })).toThrow("STATE_SCHEMA_MIGRATION_REQUIRED:43:61");
      // Only the archived private48 checkpoint is admitted by the bridge.
      // An intermediate restamp must not gain repair authority from its number.
      expect(() => reopen(home)).toThrow("STATE_SCHEMA_COHORT_UNSUPPORTED:43");
      expect(unrelatedRows(database)).toEqual(baseline);
      expect(database.query("SELECT COUNT(*) AS count FROM migrations WHERE version=44").get()).toEqual({ count: 0 });
      expect(() => reopen(home)).toThrow("STATE_SCHEMA_COHORT_UNSUPPORTED:43");
      expect({
        schema: database.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all(),
        migrations: database.query("SELECT * FROM migrations ORDER BY version").all(),
        policy: partial ? database.query("SELECT * FROM automatic_usage_policy_revisions ORDER BY automatic_policy_revision").all() : null,
      }).toEqual(beforeAdmission);
    } finally { database.close(false); }
  });

  test("refuses an adversarial joined-schema v43 restamp with a malformed policy table without writes", async () => {
    const { home } = await fixture({ provision: "migrate" });
    const database = inspect(home);
    try {
      database.exec("DROP TABLE automatic_usage_policy_revisions");
      database.exec(`CREATE TABLE automatic_usage_policy_revisions(automatic_policy_revision INTEGER PRIMARY KEY);
        DELETE FROM migrations WHERE version>=44; PRAGMA user_version=43`);
      const beforeAdmission = policyAdmissionSnapshot(database);
      expect(() => new StateStore(pathsFor(home))).toThrow();
      expect(policyAdmissionSnapshot(database)).toEqual(beforeAdmission);
      expect(database.query("PRAGMA user_version").get()).toEqual({ user_version: 43 });
      expect(database.query("SELECT COUNT(*) AS count FROM migrations WHERE version=44").get()).toEqual({ count: 0 });
      expect(database.query("SELECT COUNT(*) AS count FROM automatic_usage_policy_revisions").get()).toEqual({ count: 0 });
    } finally { database.close(false); }
  });

  test.each([false, true])("refuses an adversarial joined-schema v43 restamp with empty policy history without repair (retained receipt=%s)", async (retainedReceipt) => {
    const { store, home } = await fixture({ provision: "migrate" });
    if (retainedReceipt) store.updateAutomaticUsagePolicyConfiguration(command());
    const database = inspect(home);
    try {
      const original = (database.query("SELECT sql FROM sqlite_master WHERE name='automatic_usage_policy_immutable_delete'").get() as { sql: string }).sql;
      database.exec("DROP TRIGGER automatic_usage_policy_immutable_delete; DELETE FROM automatic_usage_policy_revisions");
      database.exec(original);
      // This is damaged current state, not an authentic interrupted43 source.
      // Keep all unrelated ownership, custody, and provenance objects intact.
      database.exec("DELETE FROM migrations WHERE version>=44; PRAGMA user_version=43");
      if (!retainedReceipt) database.exec(`CREATE TRIGGER test_policy_migration_fault AFTER INSERT ON automatic_usage_policy_revisions
        BEGIN SELECT RAISE(ABORT,'migration fixture fault'); END`);
      const snapshot = () => ({
        schema: database.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all(),
        rows: unrelatedRows(database),
        mutations: database.query("SELECT * FROM mutation_attempts ORDER BY id").all(),
        policy: database.query("SELECT * FROM automatic_usage_policy_revisions ORDER BY automatic_policy_revision").all(),
        migrations: database.query("SELECT * FROM migrations ORDER BY version").all(),
      });
      const beforeAdmission = snapshot();
      expect(() => new StateStore(pathsFor(home))).toThrow("STATE_SCHEMA_COHORT_UNSUPPORTED:43");
      expect(snapshot()).toEqual(beforeAdmission);
      expect(database.query("PRAGMA user_version").get()).toEqual({ user_version: 43 });
      expect(database.query("SELECT COUNT(*) AS count FROM automatic_usage_policy_revisions").get()).toEqual({ count: 0 });
      expect(database.query("SELECT COUNT(*) AS count FROM migrations WHERE version=44").get()).toEqual({ count: 0 });
      if (!retainedReceipt) {
        database.exec("DROP TRIGGER test_policy_migration_fault");
        const withoutInjectedFault = snapshot();
        expect(() => reopen(home)).toThrow("STATE_SCHEMA_COHORT_UNSUPPORTED:43");
        expect(snapshot()).toEqual(withoutInjectedFault);
      }
    } finally { database.close(false); }
  });

  test("refuses an orphan current-schema configuration intent on writable and readonly reopen", async () => {
    const { home } = await fixture({ provision: "migrate" });
    const database = inspect(home);
    try {
      database.query(`INSERT INTO mutation_attempts(id,idempotency_key,kind,authority_id,authority_generation,request_digest,state,created_at,updated_at)
        VALUES(?,?,'usage.auto.configure','automatic-usage-policy',1,?,'prepared',1000,1000)`)
        .run(`attempt_${"c".repeat(32)}`, randomUUID(), "a".repeat(64));
      const beforeAdmission = policyAdmissionSnapshot(database);
      for (const readonly of [true, false]) {
        expect(() => { new StateStore(pathsFor(home), { readonly }).close(); }).toThrow("AUTOMATIC_USAGE_POLICY_INVALID");
        expect(policyAdmissionSnapshot(database)).toEqual(beforeAdmission);
      }
      expect(database.query("SELECT COUNT(*) AS count FROM automatic_usage_policy_revisions").get()).toEqual({ count: 1 });
    } finally { database.close(false); }
  });
});

describe("account mutation successor authority", () => {
  const seed = async (kind: "account.login" | "account.logout" | "account.login-cancel") => {
    const { store } = await fixture();
    const profile = store.createProfile(`Recovery ${kind}`);
    const loginKey = crypto.randomUUID();
    const login = store.prepareMutation({
      kind: "account.login", authorityId: profile.id, authorityGeneration: 1,
      request: { deviceCode: true }, idempotencyKey: loginKey,
    });
    completeCodexAccountMutationAuthorityRetirement(store, profile.id, 0);
    store.beginAccountMutationEffect({
      providerAuthority: store.requireProviderAccountAuthority(profile.id, "codex"),
      attemptId: login.id, profileId: profile.id, profileGeneration: 1,
      evidence: { kind: "account.login", method: "device_code" },
    });
    if (kind === "account.login") return { store, profile, key: loginKey, attempt: login };
    store.completeAccountLoginMutation({
      attemptId: login.id, profileId: profile.id, processGeneration: 1,
      receipt: kind === "account.logout"
        ? { status: "signed_in", account: { signedIn: true, email: "recovery@example.com" } }
        : { status: "pending", loginId: "exact-recovery-login" },
    });
    const key = crypto.randomUUID();
    const attempt = store.prepareMutation({
      kind, authorityId: profile.id, authorityGeneration: 1,
      request: kind === "account.logout" ? {} : { loginId: "exact-recovery-login" },
      idempotencyKey: key,
    });
    if (kind === "account.logout") {
      completeCodexAccountMutationAuthorityRetirement(store, profile.id, 1);
      store.beginAccountMutationEffect({
        providerAuthority: store.requireProviderAccountAuthority(profile.id, "codex"),
        attemptId: attempt.id, profileId: profile.id, profileGeneration: 1,
        evidence: { kind, baselineSignedIn: true },
      });
    } else {
      store.beginLoginCancelMutationEffect({
        providerAuthority: store.requireProviderAccountAuthority(profile.id, "codex"),
        attemptId: attempt.id, profileId: profile.id, processGeneration: 1,
        loginId: "exact-recovery-login",
      });
    }
    return { store, profile, key, attempt };
  };

  for (const kind of ["account.login", "account.logout", "account.login-cancel"] as const) {
    test(`preserves immutable ${kind} through repeated exact daemon rollovers`, async () => {
      const { store, profile, key, attempt } = await seed(kind);
      const inspector = new Database(store.paths.database, { strict: true });
      try {
        const original = store.readMutation(key);
        const bytes = inspector.query("SELECT evidence_json,evidence_digest FROM mutation_effect_evidence WHERE attempt_id=?").get(attempt.id);
        for (let restart = 1; restart <= 4; restart += 1) {
          store.nextDaemonGeneration(`boot_${String(restart).repeat(32)}`);
          expect(store.recoverEffectStartedMutations().unresolved).toEqual([]);
          expect(store.isAccountMutationAuthorityCurrent({
            attemptId: attempt.id, profileId: profile.id, originGeneration: 1,
          })).toBe(true);
          expect(store.requireProfileById(profile.id)).toMatchObject({ state: "recovery_required", processGeneration: restart + 1 });
          expect(store.readMutation(key)).toMatchObject({ authorityGeneration: 1, state: "ambiguous", evidence: original?.evidence });
          expect(inspector.query("SELECT evidence_json,evidence_digest FROM mutation_effect_evidence WHERE attempt_id=?").get(attempt.id)).toEqual(bytes);
        }
        expect(inspector.query("SELECT from_generation,to_generation FROM account_mutation_authority_rebinds WHERE attempt_id=? ORDER BY from_generation").all(attempt.id))
          .toEqual([1, 2, 3, 4].map((generation) => ({ from_generation: generation, to_generation: generation + 1 })));
        if (kind === "account.login-cancel") {
          store.resolveLoginCancelMutation({ attemptId: attempt.id, expectedOriginalState: "ambiguous",
            expectedProviderAuthority: store.requireProviderAccountAuthority(profile.id, "codex"), provider: { signedIn: false } });
          store.reconcileProfileRecoveryFromAccountRead({ profileId: profile.id, expectedGeneration: 5,
            expectedProviderAuthority: store.requireProviderAccountAuthority(profile.id, "codex"), provider: { signedIn: false } });
          expect(store.requireProfileById(profile.id).state).toBe("login_pending");
          expect(store.readPendingLoginAuthority(profile.id, 5)?.loginId).toBe("exact-recovery-login");
        } else {
          if (original?.evidence === undefined) throw new Error("Expected exact account evidence.");
          store.resolveAccountMutation({
            expectedProviderAuthority: store.requireProviderAccountAuthority(profile.id, "codex"),
            attemptId: attempt.id, expectedOriginalState: "ambiguous", expectedEvidenceDigest: original.evidence.digest,
            resolution: "proven_applied", resolutionEvidence: { source: "account/read", signedIn: kind === "account.login" },
            receipt: kind === "account.login"
              ? { status: "signed_in", account: { signedIn: true, email: "recovery@example.com" } }
              : { loggedOut: true },
            provider: kind === "account.login" ? { signedIn: true, email: "recovery@example.com" } : { signedIn: false },
          });
        }
        expect(store.readMutation(key)?.state).toBe("reconciled");
      } finally { inspector.close(false); }
    });
  }

  // Enumerate the complete finite domain instead of sampling 12 combinations.
  // Each case owns its fixture cleanup and default timeout; this increases
  // coverage, not a claim that the total suite performs less work.
  for (const kind of ["account.login", "account.logout", "account.login-cancel"] as const) {
    for (const rollovers of [1, 2, 3, 4, 5, 6, 7, 8] as const) {
      test(`keeps ${kind} origin and effect invariant for ${rollovers} bounded successors`, async () => {
        const { store, profile, attempt, key } = await seed(kind);
        const original = store.readMutation(key)?.evidence;
        for (let index = 0; index < rollovers; index += 1) {
          store.nextDaemonGeneration(`boot_${String(index).repeat(32)}`);
          store.recoverEffectStartedMutations();
          expect(store.isAccountMutationAuthorityCurrent({ attemptId: attempt.id, profileId: profile.id, originGeneration: 1 })).toBe(true);
          expect(store.readMutation(key)).toMatchObject({ authorityGeneration: 1, evidence: original });
        }
        // A single unrecorded +1 rollover cannot be mistaken for this chain.
        store.nextProfileGeneration(profile.id);
        expect(store.isAccountMutationAuthorityCurrent({ attemptId: attempt.id, profileId: profile.id, originGeneration: 1 })).toBe(false);
      });
    }
  }

  test("quarantines missing legacy chains without clearing account recovery or granting a fresh attempt", async () => {
    const { store, profile, attempt, key } = await seed("account.login");
    store.transitionMutation(attempt.id, "effect_started", "ambiguous");
    store.nextProfileGeneration(profile.id);
    expect(store.isAccountMutationAuthorityCurrent({ attemptId: attempt.id, profileId: profile.id, originGeneration: 1 })).toBe(false);
    store.nextDaemonGeneration(`boot_${"f".repeat(32)}`);
    expect(store.requireProfileById(profile.id)).toMatchObject({ processGeneration: 3, state: "recovery_required" });
    expect(store.isAccountMutationAuthorityCurrent({ attemptId: attempt.id, profileId: profile.id, originGeneration: 1 })).toBe(false);
    expect(() => store.reconcileProfileRecoveryFromAccountRead({ profileId: profile.id, expectedGeneration: 3,
      expectedProviderAuthority: store.requireProviderAccountAuthority(profile.id, "codex"), provider: { signedIn: false } }))
      .toThrow("ACCOUNT_MUTATION_RECOVERY_AUTHORITY_MISMATCH");
    expect(() => store.prepareMutation({ kind: "account.login", authorityId: profile.id, authorityGeneration: 4, request: { deviceCode: true } }))
      .toThrow("UNSETTLED_MUTATION_AUTHORITY");
    expect(store.readMutation(key)?.state).toBe("ambiguous");
  });

  test("refuses a broken partial successor chain without inventing legacy authority", async () => {
    const { store, profile, attempt } = await seed("account.login");
    store.nextDaemonGeneration(`boot_${"b".repeat(32)}`);
    store.recoverEffectStartedMutations();
    store.nextProfileGeneration(profile.id);
    const before = store.requireProfileById(profile.id);
    expect(() => store.nextDaemonGeneration(`boot_${"c".repeat(32)}`)).toThrow("ACCOUNT_MUTATION_SUCCESSOR_AUTHORITY_MISMATCH");
    expect(store.requireProfileById(profile.id)).toEqual(before);
    expect(store.isAccountMutationAuthorityCurrent({ attemptId: attempt.id, profileId: profile.id, originGeneration: 1 })).toBe(false);
  });

  test("rejects forged successor fields, skipped generations, and immutable-ledger rewrites", async () => {
    const { store, profile, attempt, key } = await seed("account.login");
    const inspector = new Database(store.paths.database, { strict: true });
    const other = store.createProfile("Other recovery authority");
    const digest = store.readMutation(key)?.evidence?.digest;
    if (digest === undefined) throw new Error("Expected effect digest.");
    try {
      const insert = inspector.query("INSERT INTO account_mutation_authority_rebinds(attempt_id,profile_id,kind,evidence_digest,from_generation,to_generation,recorded_at) VALUES (?,?,?,?,?,?,1000)");
      for (const [profileId, kind, evidenceDigest, from, to] of [
        [other.id, "account.login", digest, 1, 2],
        [profile.id, "account.logout", digest, 1, 2],
        [profile.id, "account.login", "0".repeat(64), 1, 2],
        [profile.id, "account.login", digest, 1, 3],
        [profile.id, "account.login", digest, 2, 3],
      ] as const) {
        expect(() => insert.run(attempt.id, profileId, kind, evidenceDigest, from, to)).toThrow();
      }
      store.nextDaemonGeneration(`boot_${"e".repeat(32)}`);
      expect(() => inspector.query("UPDATE account_mutation_authority_rebinds SET recorded_at=2000 WHERE attempt_id=?").run(attempt.id)).toThrow("immutable");
      expect(() => inspector.query("DELETE FROM account_mutation_authority_rebinds WHERE attempt_id=?").run(attempt.id)).toThrow("immutable");
    } finally { inspector.close(false); }
  });

  test("rejects changed effect bytes instead of blessing them with a successor", async () => {
    const { store, profile, attempt } = await seed("account.login");
    const inspector = new Database(store.paths.database, { strict: true });
    try {
      inspector.exec("DROP TRIGGER mutation_effect_evidence_immutable_update");
      inspector.query("UPDATE mutation_effect_evidence SET evidence_json=? WHERE attempt_id=?")
        .run(JSON.stringify({ kind: "account.login", method: "browser" }), attempt.id);
      expect(store.isAccountMutationAuthorityCurrent({ attemptId: attempt.id, profileId: profile.id, originGeneration: 1 })).toBe(false);
      expect(() => store.nextDaemonGeneration(`boot_${"a".repeat(32)}`)).toThrow("EFFECT_EVIDENCE_PROVENANCE_CORRUPT");
      expect(inspector.query("SELECT COUNT(*) AS count FROM account_mutation_authority_rebinds").get()).toEqual({ count: 0 });
      const changed = JSON.stringify({ kind: "account.login", method: "browser" });
      inspector.query("UPDATE mutation_effect_evidence SET evidence_digest=? WHERE attempt_id=?")
        .run(createHash("sha256").update(changed).digest("hex"), attempt.id);
      // Updating the old raw digest cannot replace the independently anchored
      // source-selected evidence. The changed method remains unauthorized.
      expect(store.isAccountMutationAuthorityCurrent({ attemptId: attempt.id, profileId: profile.id, originGeneration: 1 })).toBe(false);
      expect(() => store.nextDaemonGeneration(`boot_${"a".repeat(32)}`)).toThrow("EFFECT_EVIDENCE_PROVENANCE_CORRUPT");
    } finally { inspector.close(false); }
  });
});

afterEach(async () => {
  await drainStateStoreCasesAndClose(ownedStateStoreCaseDrains, () => stores.splice(0));
});
