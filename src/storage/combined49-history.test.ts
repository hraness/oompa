import { expect, setDefaultTimeout, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import { combined49DatabaseBytes, combined49Fixture, combined49GeneratorSource } from "../../scripts/fixtures/combined49";
import { combined49RetiredDatabaseBytes, combined49RetiredFixture, combined49RetiredGeneratorSource } from "../../scripts/fixtures/combined49-retired";
import { combined49SwitchDatabaseBytes, combined49SwitchFixture, combined49SwitchGeneratorSource } from "../../scripts/fixtures/combined49-switch";
import { fingerprintSessionSendRequest } from "../domain/session-send-request";
import { initializeStatePaths, resolveStatePaths } from "./paths";
import { StateStore } from "./state-store";

setDefaultTimeout(30_000);

const sourceRevision = "0ae317793d5ff694b4d333effe25f85f7e7f1491";
const sourceTree = "8d66385130378febb9be4358dc40fe84de4d0591";
const recordedAt = 1_900_000_000_000;
const migratedAt = recordedAt + 1_000;
const rowSchema = z.record(z.string(), z.unknown());
type Row = z.infer<typeof rowSchema>;
const hash = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
const expectCapturedEqual = (actual: unknown, expected: unknown): void => { expect(actual).toEqual(expected); };

const snapshot = (path: string) => {
  // Fresh inspectors never carry cached SELECT * column metadata across an open.
  const database = new Database(path, { readonly: true, strict: true });
  try {
    const tables = z.array(z.object({ name: z.string().regex(/^[A-Za-z0-9_]+$/) }).strict()).parse(
      database.query("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name LIMIT 513").all(),
    );
    expect(tables.length).toBeLessThanOrEqual(512);
    const rows: Record<string, Row[]> = {};
    const columns: Record<string, string[]> = {};
    const cells: Record<string, Row[]> = {};
    for (const { name } of tables) {
      const names = z.array(z.object({ name: z.string().regex(/^[A-Za-z0-9_]+$/) })).parse(
        database.query(`PRAGMA table_info("${name}")`).all(),
      ).map((column) => column.name);
      columns[name] = names;
      // Compare SQLite storage classes and raw TEXT/BLOB bytes, not merely
      // strings returned by the driver's UTF-8 decoder.
      const projection = names.map((column) => `json_array(typeof("${column}"),
        CASE WHEN typeof("${column}") IN ('text','blob') THEN hex(CAST("${column}" AS BLOB))
        ELSE "${column}" END) AS "${column}"`).join(",");
      cells[name] = z.array(rowSchema).parse(database.query(`SELECT ${projection} FROM "${name}" LIMIT 4097`).all())
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      expect(cells[name].length).toBeLessThanOrEqual(4096);
      const statement = database.prepare(`SELECT * FROM "${name}" LIMIT 4097`);
      try {
        const values = z.array(rowSchema).parse(statement.all());
        expect(values.length).toBeLessThanOrEqual(4096);
        rows[name] = values.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      } finally {
        statement.finalize();
      }
    }
    const result = {
      version: database.query("PRAGMA user_version").get(),
      schema: database.query("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name").all(),
      ledger: database.query("SELECT version,applied_at FROM migrations ORDER BY version").all(),
      rows,
      columns,
      cells,
      foreignKeys: database.query("PRAGMA foreign_key_check").all(),
      inspectionChanges: database.query("SELECT total_changes() AS count").get(),
    };
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(16 * 1024 * 1024);
    expect(result.foreignKeys).toEqual([]);
    expect(result.inspectionChanges).toEqual({ count: 0 });
    return result;
  } finally {
    database.close(false);
  }
};
type Snapshot = ReturnType<typeof snapshot>;
const tableRows = (value: Snapshot, table: string): Row[] => {
  const rows = value.rows[table];
  if (rows === undefined) throw new Error(`Missing captured fixture table: ${table}`);
  return rows;
};
const exactRow = (value: Snapshot, table: string, key: string, expected: string | number): Row => {
  const matches = tableRows(value, table).filter((row) => row[key] === expected);
  expect(matches).toHaveLength(1);
  const row = matches[0];
  if (row === undefined) throw new Error(`Missing captured fixture row: ${table}`);
  return row;
};

const assertMigratedHistory = (original: Snapshot, migrated: Snapshot): void => {
  expect(migrated.version).toEqual({ user_version: 60 });
  const ledger = z.array(z.object({ version: z.number(), applied_at: z.number() }).strict()).parse(original.ledger);
  expect(migrated.ledger).toEqual([
    ...ledger.filter((row) => row.version <= 40),
    ...Array.from({ length: 10 }, (_, index) => ({ version: index + 41, applied_at: migratedAt })),
    ...ledger.filter((row) => row.version >= 41).map((row) => ({ ...row, version: row.version + 10 })),
    { version: 60, applied_at: migratedAt },
  ]);
  for (const [table, names] of Object.entries(original.columns)) {
    for (const name of names) expect(migrated.columns[table]).toContain(name);
    if (table === "migrations" || table === "session_autorespond_counters") continue;
    let actual = migrated.cells[table];
    if (actual === undefined) throw new Error(`Missing migrated fixture table: ${table}`);
    const expected = original.cells[table];
    if (expected === undefined) throw new Error(`Missing original fixture table: ${table}`);
    if (table === "sqlite_sequence") {
      // New tables may allocate their own sequences; every old sequence stays.
      const retainedNames = new Set(original.cells[table]?.map((row) => row.name));
      actual = actual.filter((row) => retainedNames.has(row.name));
    }
    expect(actual.map((row) => Object.fromEntries(names.map((name) => [name, row[name]])))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))).toEqual(expected);
  }
  // Canonical44 deliberately installs a conservative autorespond floor. Pin
  // this exact metadata change instead of exempting all old counter contents.
  const counters = new Map(tableRows(original, "session_autorespond_counters").map((row) => {
    const value = z.object({ session_id: z.string(), consecutive_count: z.number(), updated_at: z.number() }).strict().parse(row);
    return [value.session_id, value] as const;
  }));
  for (const session of tableRows(original, "sessions")) {
    const id = z.string().parse(session.id);
    const previous = counters.get(id);
    counters.set(id, { session_id: id, consecutive_count: Math.max(previous?.consecutive_count ?? 0, 3),
      updated_at: Math.max(previous?.updated_at ?? 0, migratedAt) });
  }
  expect(tableRows(migrated, "session_autorespond_counters")).toEqual([...counters.values()]
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
};

type FixtureIdentity = Readonly<{
  sourceRevision: string; sourceTree: string; schemaVersion: number;
  databaseBytes: number; databaseSha256: string; generatorSha256: string;
  syntheticControlPlaneOnly: boolean; nativeProviderAcceptance: boolean; nativeOsCustodyProved: boolean;
}>;
const preserveHistory = async (
  bytes: Uint8Array,
  fixture: FixtureIdentity,
  generator: string,
  assertHistory: (store: StateStore, captured: Snapshot) => void,
  reopenModes: readonly boolean[] = [true, false, false, true],
): Promise<void> => {
  expect(fixture.sourceRevision).toBe(sourceRevision);
  expect(fixture.sourceTree).toBe(sourceTree);
  expect(fixture.schemaVersion).toBe(49);
  expect(fixture.syntheticControlPlaneOnly).toBe(true);
  expect(fixture.nativeProviderAcceptance).toBe(false);
  expect(fixture.nativeOsCustodyProved).toBe(false);
  expect(bytes.byteLength).toBe(fixture.databaseBytes);
  expect(hash(bytes)).toBe(fixture.databaseSha256);
  expect(hash(generator)).toBe(fixture.generatorSha256);
  // Inspect the full decoded artifact, not merely its public TypeScript wrapper.
  for (const prefix of ["/Users/", "/home/", "/private/", "/tmp/", "/Volumes/"]) {
    expect(Buffer.from(bytes).includes(Buffer.from(prefix))).toBe(false);
  }
  expect(/[A-Za-z]:\\Users\\/u.test(Buffer.from(bytes).toString("latin1"))).toBe(false);

  const root = await realpath(await mkdtemp(join(tmpdir(), "oompa-combined49-history-")));
  let initializer: Database | undefined;
  try {
    const paths = resolveStatePaths({ rootDirectory: root });
    await initializeStatePaths(paths);
    await writeFile(paths.database, bytes, { mode: 0o600, flag: "wx" });
    await chmod(paths.database, 0o600);
    // Retained WAL-mode images need sidecars before the first read-only open.
    // Keep a query-only holder alive; it does not mutate any historical row.
    initializer = new Database(paths.database, { create: false, strict: true });
    initializer.exec("PRAGMA query_only=ON");
    initializer.query("SELECT name FROM sqlite_master LIMIT 1").all();
    const original = snapshot(paths.database);
    expect(original.version).toEqual({ user_version: 49 });
    expect(original.ledger).toEqual(Array.from({ length: 49 }, (_, index) => ({ version: index + 1, applied_at: recordedAt })));
    expect(exactRow(original, "notification_hours", "singleton", 1).time_zone).toBe("UTC");
    const originalBytes = hash(await readFile(paths.database));
    expect(() => new StateStore(paths, { readonly: true }))
      .toThrow("STATE_SCHEMA_MIGRATION_REQUIRED:49:60");
    expectCapturedEqual(snapshot(paths.database), original);
    expect(hash(await readFile(paths.database))).toBe(originalBytes);
    const upgrading = new StateStore(paths, { now: () => migratedAt, resolveMachineTimeZone: () => "UTC" });
    let migrated: Snapshot;
    try {
      migrated = snapshot(paths.database);
      assertMigratedHistory(original, migrated);
      assertHistory(upgrading, original);
    } finally { upgrading.close(); }
    expectCapturedEqual(snapshot(paths.database), migrated);
    // Opening a store is deliberately not a daemon boot, provider observation,
    // attachment read, or native process join. In particular it cannot consume
    // the retired fixture's unused synthetic joined-close receipt.
    for (const readonly of reopenModes) {
      const beforeBytes = hash(await readFile(paths.database));
      const store = new StateStore(paths, { readonly, now: () => migratedAt + 1, resolveMachineTimeZone: () => "UTC" });
      try {
        assertHistory(store, original);
        expectCapturedEqual(snapshot(paths.database), migrated);
      } finally {
        store.close();
      }
      expectCapturedEqual(snapshot(paths.database), migrated);
      if (readonly) expect(hash(await readFile(paths.database))).toBe(beforeBytes);
    }
  } finally {
    initializer?.close(false);
    await rm(root, { recursive: true, force: true });
  }
};

const assertPinnedParent = (captured: Snapshot, attemptId: string, queueId: string, digest: string): void => {
  expect(tableRows(captured, "session_send_owners")).toHaveLength(1);
  expect(tableRows(captured, "session_send_owner_anchors")).toHaveLength(1);
  expect(tableRows(captured, "session_send_execution_claims")).toEqual([]);
  expect(tableRows(captured, "session_send_owner_outcomes")).toEqual([]);
  const parent = exactRow(captured, "mutation_attempts", "id", attemptId);
  expect(parent).toMatchObject({ kind: "session.send", state: "prepared", result_json: null,
    request_format: "original_send_v1", attachment_input_format: "retained_v1", attachment_cleanup_terminal_digest: null });
  const live = tableRows(captured, "attachment_custody_sets").filter((row) => row.released_by === null);
  expect(live).toHaveLength(1);
  expect(live[0]?.id).toBe(parent.attachment_custody_id);
  expect(tableRows(captured, "attachment_custody_sets")).toHaveLength(2);
  expect(tableRows(captured, "attachment_custody_slots")).toHaveLength(1);
  expect(tableRows(captured, "attachment_custody_slots")[0]?.custody_id).toBe(parent.attachment_custody_id);
  expect(tableRows(captured, "attachment_custody_members").map((row) => row.digest)).toEqual([digest, digest]);
  expect(tableRows(captured, "attachment_custody_dispositions").map((row) => row.kind).sort())
    .toEqual(["mutation_owned", "queue_transferred"]);
  expect(exactRow(captured, "queue_entries", "id", queueId).state).toBe("pending");
  expect(tableRows(captured, "queue_attachment_identities")).toHaveLength(1);
  expect(tableRows(captured, "queue_attachment_identity_anchors")).toHaveLength(1);
  expect(tableRows(captured, "message_attachments")).toHaveLength(1);
  expect(tableRows(captured, "queue_effect_evidence")).toEqual([]);
  expect(tableRows(captured, "mutation_effect_evidence")).toEqual([]);
  expect(tableRows(captured, "mutation_resolutions")).toEqual([]);
};

// Each bounded case starts from the original archive and proves the complete
// upgrade and unchanged-history oracle. Together these adjacent pairs retain
// every transition in RO -> RW -> RW -> RO, including repeated writable opens.
const adjacentReopenModes = {
  "RO -> RW": [true, false],
  "RW -> RW": [false, false],
  "RW -> RO": [false, true],
} as const;

test.each(["RO -> RW", "RW -> RW", "RW -> RO"] as const)("authentic combined49 preserves retained pins, a sealed queue, divergent Claude custody and exact usage through current RW/RO opens (%s)", async (reopenPair) => {
  const archived = combined49Fixture;
  await preserveHistory(combined49DatabaseBytes(), archived, combined49GeneratorSource, (store, captured) => {
    const owner = store.readOwnedSessionSend(archived.ownerRequest.idempotencyKey);
    expect(owner).toMatchObject({ state: "input_required", ownerDigest: archived.ownerDigest,
      claim: null, claimDigest: null, outcomes: [] });
    expectCapturedEqual(owner?.owner.sourceAuthority, archived.sourceAuthority);
    expectCapturedEqual(owner?.owner.fingerprint, fingerprintSessionSendRequest(archived.ownerRequest));
    expect(owner?.owner.attemptId).toBe(archived.ownerAttemptId);
    expect(() => store.readMutation(archived.ownerRequest.idempotencyKey)).toThrow("SESSION_SEND_OWNED_API_REQUIRED");
    expect(store.requireSessionProviderAuthority(archived.sessionId)).toMatchObject(archived.sourceAuthority);
    expect(store.requireQueue(archived.queueId).state).toBe("pending");
    expectCapturedEqual(store.queueAttachmentManifest(archived.queueId), [archived.attachment.reference]);
    expect(hash(Buffer.from(archived.attachment.bytesBase64, "base64"))).toBe(archived.attachment.reference.digest);
    assertPinnedParent(captured, archived.ownerAttemptId, archived.queueId, archived.attachment.reference.digest);

    expectCapturedEqual(store.readClaudeProcessAuthority(archived.claude.key), archived.claude.released);
    expect(archived.claude.identityIsSynthetic).toBe(true);
    expect(archived.claude.released.profileGeneration).toBe(0);
    expect(store.requireProfileById(archived.claude.key.profileId).processGeneration).toBe(1);
    expectCapturedEqual(store.requireProviderAccountAuthority(archived.claude.key.profileId, "claude"), archived.claude.released.providerAuthority);
    expect(archived.claude.released.providerAuthority.processGeneration).toBe(2);
    expect(exactRow(captured, "usage_revision_authority", "profile_id", archived.claude.key.profileId).next_revision).toBe(2);
    for (const table of ["usage_snapshots", "usage_poll_failures", "usage_cloud_upload_anchors"]) {
      expect(tableRows(captured, table).filter((row) => row.profile_id === archived.claude.key.profileId)).toEqual([]);
    }
    expect(tableRows(captured, "usage_snapshots")).toHaveLength(2);
    expect(tableRows(captured, "usage_poll_failures")).toHaveLength(1);
    expect(tableRows(captured, "usage_cloud_upload_anchors")).toHaveLength(1);
    for (const { scope, revision, value } of archived.usage.metadata) {
      expect(value.mode).toBe("mutation_authoritative");
      expectCapturedEqual(value.authority, archived.sourceAuthority);
      expectCapturedEqual(store.readCodexUsageAuthorityMetadata(scope, archived.sourceProfileId, revision), value);
    }
    expectCapturedEqual(store.latestProviderUsage(archived.sourceAuthority.providerAccountId), archived.usage.projection);
  }, adjacentReopenModes[reopenPair]);
});

test.each(["RO -> RW", "RW -> RW", "RW -> RO"] as const)("authentic combined49 preserves a prepared exact switch capsule without creating target, release or seed effects (%s)", async (reopenPair) => {
  const archived = combined49SwitchFixture;
  await preserveHistory(combined49SwitchDatabaseBytes(), archived, combined49SwitchGeneratorSource, (store, captured) => {
    expectCapturedEqual(store.readSessionSwitchByIdempotencyKey(archived.input.idempotencyKey), archived.prepared.switch);
    expectCapturedEqual(store.requireSession(archived.session.id), archived.session);
    expectCapturedEqual(store.requireProviderAccountAuthority(archived.source.profile.id, "codex"), archived.source.authority);
    expectCapturedEqual(store.requireProviderAccountAuthority(archived.target.profile.id, "codex"), archived.target.authority);
    expect(archived.prepared.switch).toMatchObject({ phase: "prepared", targetStart: null, sourceRelease: null,
      rebind: null, seedAuthority: null, seed: null, abandonment: null });
    expect(store.readMutation(archived.input.idempotencyKey)?.state).toBe("prepared");
    expect(tableRows(captured, "session_switch_attempts")).toHaveLength(1);
    expect(tableRows(captured, "session_switch_adoption_capsules")).toHaveLength(1);
    expect(tableRows(captured, "session_switch_adoption_anchors")).toHaveLength(1);
    const capsule = exactRow(captured, "session_switch_adoption_capsules", "attempt_id", archived.prepared.switch.attemptId);
    expect(capsule.kind).toBe("exact_v1");
    expect(typeof capsule.capsule_json).toBe("string");
    expect(exactRow(captured, "session_switch_adoption_anchors", "attempt_id", archived.prepared.switch.attemptId).digest).toBe(capsule.digest);
    expect(tableRows(captured, "session_provider_authorities")).toHaveLength(1);
    expect(tableRows(captured, "session_provider_account_authorities")).toHaveLength(1);
    expect(tableRows(captured, "mutation_effect_evidence")).toEqual([]);
    expect(tableRows(captured, "mutation_resolutions")).toEqual([]);
    for (const [name, rows] of Object.entries(captured.rows)) {
      if (name.startsWith("session_switch_") && name.endsWith("_receipts")) expect(rows).toEqual([]);
    }
    expect(archived.transcriptEvidence).toEqual({ retainedWarningEvent: true, conversationRecords: 0, headerOnlySeed: true });
    expect(archived.prepared.switch.transcript.seedIncludedRecords).toBe(0);
    expect(tableRows(captured, "session_events")).toHaveLength(1);
    for (const side of [archived.source, archived.target]) {
      expect(exactRow(captured, "usage_revision_authority", "profile_id", side.profile.id).next_revision).toBe(2);
    }
    expect(tableRows(captured, "usage_snapshots")).toEqual([]);
    expect(tableRows(captured, "usage_poll_failures")).toEqual([]);
  }, adjacentReopenModes[reopenPair]);
});

test.each(["RO -> RW", "RW -> RW", "RW -> RO"] as const)("authentic combined49 preserves Devin owner and login history plus unused synthetic close permission without booting (%s)", async (reopenPair) => {
  const archived = combined49RetiredFixture;
  await preserveHistory(combined49RetiredDatabaseBytes(), archived, combined49RetiredGeneratorSource, (store, captured) => {
    expectCapturedEqual(store.readOwnedSessionSend(archived.owner.request.idempotencyKey), archived.owner.history);
    expect(archived.owner.history).toMatchObject({ state: "input_required", claim: null, claimDigest: null, outcomes: [] });
    expectCapturedEqual(store.requireCapturedSessionProviderAuthority(archived.owner.session.id), archived.owner.capturedAuthority);
    expectCapturedEqual(store.requireSessionProviderAuthority(archived.owner.session.id), archived.owner.capturedAuthority);
    expectCapturedEqual(exactRow(captured, "mutation_attempts", "id", archived.owner.history.owner.attemptId), archived.owner.originalParentMutationRow);
    expectCapturedEqual(store.requireQueue(archived.queue.result.queued.id), {
      ...archived.queue.result.queued, messageActor: "human",
    });
    expectCapturedEqual(store.queueAttachmentManifest(archived.queue.result.queued.id), [archived.attachment.reference]);
    assertPinnedParent(captured, archived.owner.history.owner.attemptId, archived.queue.result.queued.id, archived.attachment.reference.digest);
    expectCapturedEqual(store.readMutation(archived.login.idempotencyKey), archived.login.originalMutation);
    expect(archived.login.originalMutation.state).toBe("prepared");
    expectCapturedEqual(store.requireCapturedSessionProviderAuthority(archived.close.session.id), archived.close.capturedAuthority);
    expectCapturedEqual(store.requireSession(archived.close.session.id), archived.close.session);
    expectCapturedEqual(store.latestSessionRuntimeProfile(archived.close.session.id), archived.close.runtime);
    expect(() => store.requireSessionProviderAuthority(archived.close.session.id)).toThrow("SESSION_PROVIDER_AUTHORITY_STALE");
    expectCapturedEqual(store.requireProviderAccountAuthority(archived.close.session.profileId, "devin"), archived.close.receipt.retiredAuthority);
    expectCapturedEqual(archived.close.receipt.retiredAuthority.processGeneration, archived.close.capturedAuthority.processGeneration + 1);
    expectCapturedEqual(store.readProviderAccountState("devin"), archived.activated);
    expectCapturedEqual(store.listProviderAccounts("devin").map((account) => account.id), archived.orderedIds);
    for (const profile of archived.profiles) {
      expectCapturedEqual(store.requireProfileById(profile.id), profile);
      expect(store.requireProviderAccountAuthority(profile.id, "codex").processGeneration).toBe(0);
      expect(store.requireProviderAccountAuthority(profile.id, "claude").processGeneration).toBe(0);
      expect(exactRow(captured, "usage_revision_authority", "profile_id", profile.id).next_revision).toBe(2);
    }
    for (const table of ["devin_joined_close_intents", "devin_joined_close_snapshots", "devin_joined_close_receipts"]) {
      expect(tableRows(captured, table)).toHaveLength(1);
    }
    expect(tableRows(captured, "devin_joined_close_anchors").map((row) => row.kind).sort()).toEqual(["intent", "joined"]);
    expect(tableRows(captured, "devin_joined_close_consumptions")).toEqual([]);
    expect(tableRows(captured, "session_provider_authority_successors")).toEqual([]);
    expect(tableRows(captured, "session_switch_attempts")).toEqual([]);
    expect(tableRows(captured, "usage_snapshots")).toEqual([]);
    expect(tableRows(captured, "usage_poll_failures")).toEqual([]);
    // The captured close witness was supplied to storage synthetically. These
    // preservation reads neither validate OS custody nor consume its permission.
    expect(archived.joinedCloseNotice).toContain("synthetic");
  }, adjacentReopenModes[reopenPair]);
});
