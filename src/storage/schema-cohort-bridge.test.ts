import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { privateTask48DatabaseBytes, privateTask48Fixture } from "../../scripts/fixtures/private-task48";
import { canonicalAdoption40DatabaseBytes } from "../../scripts/fixtures/canonical-adoption40";
import { privateTask48PinnedDatabaseBytes, privateTask48PinnedFixture } from "../../scripts/fixtures/private-task48-pinned";
import { privateTask48UsageDatabaseBytes, privateTask48UsageFixture } from "../../scripts/fixtures/private-task48-usage";
import { canonical40UsageDatabaseBytes, canonical40UsageFixture } from "../../scripts/fixtures/canonical40-usage";
import { initializeStatePaths, resolveStatePaths } from "./paths";
import { StateStore } from "./state-store";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });
const fixture = async (bytes = privateTask48DatabaseBytes()) => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "oompa-cohort-bridge-")));
  const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
  await initializeStatePaths(paths);
  await writeFile(paths.database, bytes);
  await chmod(paths.database, 0o600);
  // The authentic checkpoint retains WAL mode. A query-only writable handle
  // initializes its auxiliary files without modifying any historical row.
  const database = new Database(paths.database);
  database.exec("PRAGMA query_only=ON");
  cleanup.push(async () => { database.close(); await rm(home, { recursive: true, force: true }); });
  return { paths, database };
};
const immutableTables = ["session_send_owners", "session_send_owner_anchors", "session_send_execution_claims",
  "session_send_owner_outcomes", "queue_attachment_identities", "queue_attachment_identity_anchors",
  "attachment_custody_sets", "attachment_custody_members", "attachment_custody_anchors",
  "attachment_custody_dispositions", "attachment_custody_slots", "mutation_effect_evidence",
  "mutation_attempts", "mutation_provider_authorities", "queue_entries", "queue_effect_evidence", "queue_effect_resolutions", "message_attachments",
  "session_provider_authorities", "runtime_profile_provider_authorities",
  "session_runtime_profiles", "session_event_provider_authorities"] as const;
const snapshots = (database: Database) => Object.fromEntries(immutableTables.map((table) =>
  [table, database.query(`SELECT * FROM ${table} ORDER BY 1`).all()]));

test("an authentic private48 checkpoint bridges once without rewriting immutable custody or migration times", async () => {
  const { paths, database } = await fixture();
  const old = snapshots(database);
  expect(() => new StateStore(paths, { readonly: true })).toThrow();
  const now = 1_900_000_001_000;
  const store = new StateStore(paths, { now: () => now });
  cleanup.push(async () => { store.close(); });
  expect(database.query("PRAGMA user_version").get()).toEqual({ user_version: 62 });
  expect(snapshots(database)).toEqual(old);
  expect(database.query("SELECT version,applied_at FROM migrations WHERE version>=40 ORDER BY version").all())
    .toEqual([
      ...Array.from({ length: 11 }, (_, index) => ({ version: index + 40, applied_at: now })),
      // Private usage slots 40–48 retain their original times at joined slots 51–59.
      ...privateTask48Fixture.migrations.filter((row) => row.version >= 40)
        .map((row) => ({ version: row.version + 11, applied_at: row.applied_at })),
      { version: 60, applied_at: now },
      { version: 61, applied_at: now },
      { version: 62, applied_at: now },
    ]);
  expect(database.query("SELECT message,state FROM queue_entries WHERE id=?").get(privateTask48Fixture.queueId))
    .toEqual({ message: "Private sealed queue remains pending.", state: "pending" });
  const reopened = new StateStore(paths, { readonly: true });
  reopened.close();
  const reopenedWritable = new StateStore(paths, { now: () => now + 1000 });
  reopenedWritable.close();
  expect(snapshots(database)).toEqual(old);
  expect(database.query("SELECT applied_at FROM migrations WHERE version=40").get()).toEqual({ applied_at: now });
});

test("a private48 lookalike with a missing frozen authority guard is rejected before repair", async () => {
  const { paths, database } = await fixture();
  database.exec("PRAGMA query_only=OFF");
  const guard = database.query("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='provider_accounts' ORDER BY name LIMIT 1")
    .get() as { name: string };
  database.exec(`DROP TRIGGER ${guard.name}`);
  const before = database.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY name").all();
  const beforeRows = snapshots(database);
  expect(() => new StateStore(paths)).toThrow();
  expect(database.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY name").all()).toEqual(before);
  expect(snapshots(database)).toEqual(beforeRows);
  expect(database.query("PRAGMA user_version").get()).toEqual({ user_version: 48 });
});

test("an unsupported private intermediate stamp cannot be reclassified as canonical adoption", async () => {
  const { paths, database } = await fixture();
  database.exec("PRAGMA query_only=OFF; PRAGMA user_version=43");
  const before = snapshots(database);
  const migrations = database.query("SELECT * FROM migrations ORDER BY version").all();
  expect(() => new StateStore(paths)).toThrow("STATE_SCHEMA_COHORT_UNSUPPORTED:43");
  expect(snapshots(database)).toEqual(before);
  expect(database.query("SELECT * FROM migrations ORDER BY version").all()).toEqual(migrations);
  expect(database.query("PRAGMA user_version").get()).toEqual({ user_version: 43 });
});

test("a standalone task custody trigger prevents repair of an otherwise authentic canonical40 cohort", async () => {
  const { paths, database } = await fixture(canonicalAdoption40DatabaseBytes());
  database.exec("PRAGMA query_only=OFF");
  database.exec("CREATE TRIGGER attachment_unknown_capture AFTER INSERT ON mutation_attempts BEGIN SELECT 1; END");
  const schema = database.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY name").all();
  const mutations = database.query("SELECT * FROM mutation_attempts ORDER BY id").all();
  expect(() => new StateStore(paths)).toThrow("STATE_SCHEMA_COHORT_MIXED");
  expect(database.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY name").all()).toEqual(schema);
  expect(database.query("SELECT * FROM mutation_attempts ORDER BY id").all()).toEqual(mutations);
  expect(database.query("PRAGMA user_version").get()).toEqual({ user_version: 40 });
});

test("a combined current cohort does not repair a missing exact process guard", async () => {
  const { paths, database } = await fixture();
  const store = new StateStore(paths);
  store.close();
  database.exec("PRAGMA query_only=OFF; DROP TRIGGER claude_process_restart_successor_guard");
  const before = snapshots(database);
  const schema = database.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY name").all();
  expect(() => new StateStore(paths)).toThrow();
  expect(snapshots(database)).toEqual(before);
  expect(database.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY name").all()).toEqual(schema);
});

test("an authentic private48 attached owner retains its pins and sealed queue manifest through the bridge", async () => {
  const { paths, database } = await fixture(privateTask48PinnedDatabaseBytes());
  const before = snapshots(database);
  expect(database.query("SELECT COUNT(*) AS count FROM attachment_custody_sets WHERE released_by IS NULL").get()).toEqual({ count: 1 });
  expect(database.query("SELECT COUNT(*) AS count FROM attachment_custody_slots").get()).toEqual({ count: 1 });
  expect(database.query("SELECT COUNT(*) AS count FROM attachment_custody_members").get()).toEqual({ count: 2 });
  expect(database.query("SELECT COUNT(*) AS count FROM message_attachments WHERE source_id=?").get(privateTask48PinnedFixture.queueId)).toEqual({ count: 1 });
  const store = new StateStore(paths, { now: () => 1_900_000_001_000 });
  cleanup.push(async () => { store.close(); });
  expect(snapshots(database)).toEqual(before);
  expect(database.query("SELECT state FROM mutation_attempts WHERE id=?").get(privateTask48PinnedFixture.ownerAttemptId)).toEqual({ state: "prepared" });
  expect(database.query("SELECT state FROM queue_entries WHERE id=?").get(privateTask48PinnedFixture.queueId)).toEqual({ state: "pending" });
  const reopened = new StateStore(paths, { readonly: true });
  reopened.close();
  expect(snapshots(database)).toEqual(before);
});

test("authentic private48 usage preserves exact authority across the bridge while canonical40 stays display-only", async () => {
  const archived = privateTask48UsageFixture;
  const { paths, database } = await fixture(privateTask48UsageDatabaseBytes());
  // Archived values are deeply readonly; compare without current-schema
  // coercion or normalization, including fields unknown to typed projections.
  const expectCapturedEqual = (actual: unknown, expected: unknown): void => {
    expect(actual).toEqual(expected);
  };
  const usageRows = (path: string) => {
    // A new inspector avoids caching released column metadata across schema migration.
    const inspector = new Database(path, { readonly: true, strict: true });
    try {
      return {
        snapshots: inspector.query("SELECT * FROM usage_snapshots ORDER BY profile_id,source_revision").all(),
        failures: inspector.query("SELECT * FROM usage_poll_failures ORDER BY profile_id,source_revision").all(),
        anchors: inspector.query("SELECT * FROM usage_cloud_upload_anchors ORDER BY profile_id,source_revision").all(),
        revisions: inspector.query("SELECT * FROM usage_revision_authority ORDER BY profile_id").all(),
        authorities: inspector.query(`SELECT * FROM account_scoped_provider_authorities
          WHERE scope_kind IN ('usage_snapshot','usage_poll_failure','usage_upload_anchor')
          ORDER BY scope_kind,scope_id`).all(),
      };
    } finally {
      inspector.close();
    }
  };
  const ledger = (path: string) => {
    const inspector = new Database(path, { readonly: true, strict: true });
    try {
      return inspector.query("SELECT version,applied_at FROM migrations ORDER BY version").all();
    } finally {
      inspector.close();
    }
  };
  expect(archived.sourceRevision).toBe("3f6ac733dc17b3eec881ad98f2d65faadbcbaf37");
  expect(database.query("PRAGMA user_version").get()).toEqual({ user_version: 48 });
  expectCapturedEqual(usageRows(paths.database), archived.rows);
  expectCapturedEqual(ledger(paths.database), archived.migrations);
  expect(archived.rows.snapshots).toHaveLength(2);
  expect(archived.rows.failures).toHaveLength(1);
  expect(archived.rows.anchors).toHaveLength(1);
  expect(archived.rows.authorities).toHaveLength(4);
  expect(archived.metadata.map(({ scope, revision }) => [scope, revision])).toEqual([
    ["usage_snapshot", 1], ["usage_snapshot", 3],
    ["usage_poll_failure", 2], ["usage_upload_anchor", 1],
  ]);
  expect(archived.authority.processGeneration).toBeGreaterThan(0);
  for (const row of archived.rows.snapshots) {
    expect(createHash("sha256").update(row.payload_json).digest("hex")).toBe(row.digest);
    expect(JSON.parse(row.payload_json)).toEqual(row.source_revision === 1 ? archived.first : archived.third);
  }
  for (const { scope, revision, value } of archived.metadata) {
    // These observations came from the archived API before any bridge ran.
    // Exact identity is not itself proof that quota remains fresh for dispatch.
    expect(value).toMatchObject({
      authority: archived.authority,
      mode: "mutation_authoritative",
      canAuthorizeQuota: scope === "usage_snapshot",
      binding: { ...archived.authority, provenance: `${scope}_v36` },
    });
    expectCapturedEqual(archived.rows.authorities.find((row) =>
      row.scope_kind === scope && row.scope_id === `${archived.profileId}:${revision}`), {
        scope_kind: scope,
        scope_id: `${archived.profileId}:${revision}`,
        provider_account_id: archived.authority.providerAccountId,
        profile_id: archived.profileId,
        provider: "codex",
        binding_generation: archived.authority.bindingGeneration,
        process_generation: archived.authority.processGeneration,
        provenance: `${scope}_v36`,
        recorded_at: value.binding.recordedAt,
      });
  }
  const now = 40_000;
  const expectedLedger = [
    ...archived.migrations.filter((row) => row.version < 40),
    ...Array.from({ length: 11 }, (_, index) => ({ version: index + 40, applied_at: now })),
    // Only the nine proved private usage slots move; their timestamps do not.
    ...archived.migrations.filter((row) => row.version >= 40)
      .map((row) => ({ version: row.version + 11, applied_at: row.applied_at })),
    { version: 60, applied_at: now },
    { version: 61, applied_at: now },
      { version: 62, applied_at: now },
  ];
  const assertExact = (store: StateStore) => {
    expect(store.requireProviderAccountAuthority(archived.profileId, "codex")).toEqual(archived.authority);
    for (const { scope, revision, value } of archived.metadata) {
      expect(store.readCodexUsageAuthorityMetadata(scope, archived.profileId, revision)).toEqual(value);
    }
    // Includes original source digest and derived quota/accounting component digests.
    expectCapturedEqual(store.latestProviderUsage(archived.authority.providerAccountId), archived.projection);
    expectCapturedEqual(usageRows(paths.database), archived.rows);
    expect(ledger(paths.database)).toEqual(expectedLedger);
  };
  const migrated = new StateStore(paths, { now: () => now });
  cleanup.push(async () => { migrated.close(); });
  expect(database.query("PRAGMA user_version").get()).toEqual({ user_version: 62 });
  assertExact(migrated);
  migrated.recordUsage(archived.profileId, 1, 10_000, archived.first, archived.authority);
  migrated.recordUsagePollFailure(archived.profileId, archived.fingerprint, 2, 20_000, archived.authority);
  expect(() => migrated.recordUsage(archived.profileId, 1, 10_000, archived.first, {
    ...archived.authority, bindingGeneration: archived.authority.bindingGeneration + 1,
  })).toThrow("CODEX_USAGE_AUTHORITY_REPLAY_CONFLICT");
  expect(() => migrated.recordUsagePollFailure(archived.profileId, archived.fingerprint, 2, 20_000, {
    ...archived.authority, processGeneration: archived.authority.processGeneration + 1,
  })).toThrow("CODEX_USAGE_FAILURE_AUTHORITY_REPLAY_CONFLICT");
  assertExact(migrated);
  migrated.close();
  const writable = new StateStore(paths, { now: () => now + 1 });
  cleanup.push(async () => { writable.close(); });
  assertExact(writable);
  writable.close();
  const readonly = new StateStore(paths, { readonly: true });
  cleanup.push(async () => { readonly.close(); });
  assertExact(readonly);
  readonly.close();

  // Independently absent canonical40 sidecars must not inherit the private48 proof.
  const legacy = await fixture(canonical40UsageDatabaseBytes());
  expect(legacy.database.query("PRAGMA user_version").get()).toEqual({ user_version: 40 });
  expect(legacy.database.query("SELECT name FROM sqlite_master WHERE name='account_scoped_provider_authorities'").get())
    .toBeNull();
  const compatibility = new StateStore(legacy.paths, { now: () => now });
  cleanup.push(async () => { compatibility.close(); });
  for (const { scope, revision } of archived.metadata) {
    expect(compatibility.readCodexUsageAuthorityMetadata(scope, canonical40UsageFixture.profileId, revision))
      .toMatchObject({
        binding: { processGeneration: null, provenance: "legacy_codex_compatibility" },
        canAuthorizeQuota: false,
        mode: "compatibility_display_only",
      });
  }
  expect(usageRows(legacy.paths.database)).toMatchObject({
    snapshots: canonical40UsageFixture.snapshots,
    failures: canonical40UsageFixture.failures,
    anchors: canonical40UsageFixture.anchors,
  });
  expectCapturedEqual(ledger(legacy.paths.database).slice(0, 40), canonical40UsageFixture.migrations);
}, 15_000);
