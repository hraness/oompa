import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import { privateTask48DatabaseBytes, privateTask48FixtureDatabaseIdentity } from "../../scripts/fixtures/private-task48";
import { initializeStatePaths, resolveStatePaths } from "./paths";
import { normalizeSchemaSql } from "./schema-cohort";
import { StateStore } from "./state-store";
import { canonicalWorkJson } from "./work-store";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const options = { now: () => 2_000_000_000_000, resolveMachineTimeZone: () => "UTC" };
type Paths = ReturnType<typeof resolveStatePaths>;
const open = (paths: Paths, readonly = false) => {
  const store = new StateStore(paths, { ...options, readonly });
  store.close();
};
const read = <T>(paths: Paths, operation: (database: Database) => T): T => {
  // The archived WAL-mode image initially has no sidecars. This connection may
  // initialize local WAL bookkeeping, but query_only prohibits durable writes.
  const database = new Database(paths.database, { create: false, strict: true });
  database.exec("PRAGMA query_only=ON");
  try {
    const result = operation(database);
    expect(database.query("SELECT total_changes() AS changes").get()).toEqual({ changes: 0 });
    return result;
  } finally { database.close(false); }
};
const snapshot = (paths: Paths) => read(paths, (database) => {
  const tables = z.object({ name: z.string().regex(/^[A-Za-z0-9_]+$/u) }).strict().array().parse(
    database.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all(),
  );
  return {
    version: database.query("PRAGMA user_version").get(),
    schema: database.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all(),
    rows: Object.fromEntries(tables.map(({ name }) => [name, database.query(`SELECT * FROM "${name}"`).all()
      .sort((left, right) => canonicalWorkJson(left).localeCompare(canonicalWorkJson(right)))])),
    foreignKeys: database.query("PRAGMA foreign_key_check").all(),
  };
});
const ledgerSchema = z.object({ version: z.number().int(), applied_at: z.number().int() }).strict().array();
const guardSchema = z.object({ type: z.literal("trigger"), name: z.string(), tbl_name: z.string(), sql: z.string() }).strict();

// Independent frozen digests from canonical49-schema.ts's actual archived7ab
// sqlite_schema manifest (image cbeec09f729b95aad1d1101a3b9eaa723ca10497a3ed7bba9cdf0bdd40b4d812).
// Never accept a predecessor merely because this migration happened to emit it.
const predecessors = [
  { name: "queue_transcript_finalization_guard", table: "queue_entries",
    digest: "ecb4399f80980dfba880341d03d9321218e3700130a8dc5fc7eb6957a30ab4ab" },
  { name: "peer_session_direct_message_source_delete_guard", table: "peer_session_direct_message_sources",
    digest: "48d1575451bd8866a0bba472f46f98f11bf162f2045d0c0cd50906588363207c" },
  { name: "peer_session_action_transition_guard", table: "peer_session_actions",
    digest: "2996d0ce6e6c12d03a01524a7aca2361d040f9282d3ec751a22afdde1d93df2f" },
] as const;

async function upgrade() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "oompa-canonical-waypoint-")));
  roots.push(root);
  const paths = resolveStatePaths({ homeDirectory: root, platform: "darwin" });
  await initializeStatePaths(paths);
  const bytes = privateTask48DatabaseBytes();
  expect(bytes.byteLength).toBe(privateTask48FixtureDatabaseIdentity.byteLength);
  expect(hash(bytes)).toBe(privateTask48FixtureDatabaseIdentity.sha256);
  await writeFile(paths.database, bytes, { flag: "wx", mode: 0o600 });
  const before = snapshot(paths);
  expect(before.version).toEqual({ user_version: 48 });
  const oldGuards = new Map<string, string>();
  const originalExec = z.custom<Database["exec"]>((value) => typeof value === "function")
    .parse(Object.getOwnPropertyDescriptor(Database.prototype, "exec")?.value);
  const exec = spyOn(Database.prototype, "exec").mockImplementation(function (
    this: Database, ...args: Parameters<Database["exec"]>
  ) {
    const expected = predecessors.find((entry) => args[0] === `DROP TRIGGER ${entry.name}`);
    if (this.filename === paths.database && expected !== undefined) {
      expect(this.inTransaction).toBe(true);
      const observed = guardSchema.parse(this.query(
        "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name=?",
      ).get(expected.name));
      expect(observed.name).toBe(expected.name);
      expect(observed.tbl_name).toBe(expected.table);
      expect(hash(normalizeSchemaSql(observed.sql))).toBe(expected.digest);
      expect(oldGuards.has(expected.name)).toBe(false);
      oldGuards.set(expected.name, observed.sql);
    }
    return originalExec.apply(this, args);
  });
  // No await while the spy is installed. These are uncommitted predecessor
  // guard observations, not a new captured or committed canonical50 database.
  try { open(paths); } finally { exec.mockRestore(); }
  expect(Object.getOwnPropertyDescriptor(Database.prototype, "exec")?.value).toBe(originalExec);
  expect([...oldGuards.keys()].sort()).toEqual(predecessors.map(({ name }) => name).sort());
  const after = snapshot(paths);
  expect(after.version).toEqual({ user_version: 61 });
  expect(after.foreignKeys).toEqual([]);
  const finalLedger = ledgerSchema.parse(after.rows.migrations).sort((left, right) => left.version - right.version);
  expect(finalLedger.map(({ version }) => version)).toEqual(Array.from({ length: 61 }, (_, index) => index + 1));
  for (const entry of ledgerSchema.parse(before.rows.migrations)) {
    const version = entry.version < 40 ? entry.version : entry.version + 11;
    expect(finalLedger.find((candidate) => candidate.version === version)).toEqual({ ...entry, version });
  }
  for (const name of ["mutation_effect_evidence", "queue_effect_evidence", "session_send_owners",
    "session_send_execution_claims", "session_send_owner_anchors", "session_send_owner_outcomes",
    "queue_attachment_identities", "queue_attachment_identity_anchors"]) {
    const original = before.rows[name];
    if (original === undefined) throw new Error("Expected the authentic sealed evidence table.");
    expect(after.rows[name]).toEqual(original);
  }
  for (const expected of predecessors) {
    const current = read(paths, (database) => guardSchema.parse(database.query(
      "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name=?",
    ).get(expected.name)));
    expect(hash(normalizeSchemaSql(current.sql))).not.toBe(expected.digest);
  }
  return { paths, after, oldGuards };
}

describe("retained private48 canonical waypoints and strict joined successors", () => {
  test("upgrades authentic private48 through historical guards and reopens exact joined61 without writes", async () => {
    const { paths, after } = await upgrade();
    for (const readonly of [true, false]) {
      open(paths, readonly);
      expect(hash(canonicalWorkJson(snapshot(paths)))).toBe(hash(canonicalWorkJson(after)));
    }
  });

  const damageCases = [
    { name: "queue_transcript_finalization_guard", damage: "missing", code: "JOINED_QUEUE_TRANSCRIPT_GUARD_INVALID" },
    { name: "queue_transcript_finalization_guard", damage: "reverted", code: "JOINED_QUEUE_TRANSCRIPT_GUARD_INVALID" },
    { name: "peer_session_direct_message_source_delete_guard", damage: "missing", code: "PEER_SESSION_CANCELLATION_UNPROVEN" },
    { name: "peer_session_direct_message_source_delete_guard", damage: "reverted", code: "PEER_SESSION_CANCELLATION_UNPROVEN" },
    { name: "peer_session_action_transition_guard", damage: "missing", code: "PEER_SESSION_CANCELLATION_UNPROVEN" },
    { name: "peer_session_action_transition_guard", damage: "reverted", code: "PEER_SESSION_CANCELLATION_UNPROVEN" },
    { name: "peer_session_cancellation_insert", damage: "missing", code: "PEER_SESSION_CANCELLATION_UNPROVEN" },
  ] as const;
  for (const { name, damage, code } of damageCases) {
    test(`current61 refuses ${damage} ${name} on both opens without repair or row changes`, async () => {
      const { paths, oldGuards } = await upgrade();
      const database = new Database(paths.database, { create: false, strict: true });
      try {
        // Deliberately corrupt only this disposable, already-upgraded image.
        // The original archived bytes and all row/ledger values stay untouched.
        database.transaction(() => {
          const present = guardSchema.parse(database.query(
            "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name=?",
          ).get(name));
          expect(present.name).toBe(name);
          database.exec(`DROP TRIGGER ${name}`);
          if (damage === "reverted") {
            const oldSql = oldGuards.get(name);
            if (oldSql === undefined) throw new Error("Expected the independently proved predecessor.");
            database.exec(oldSql);
          }
        }).immediate();
        expect(database.query("SELECT total_changes() AS changes").get()).toEqual({ changes: 0 });
      } finally { database.close(false); }
      const damaged = hash(canonicalWorkJson(snapshot(paths)));
      for (const readonly of [true, false]) {
        expect(() => open(paths, readonly)).toThrow(code);
        expect(hash(canonicalWorkJson(snapshot(paths)))).toBe(damaged);
      }
    });
  }
});
