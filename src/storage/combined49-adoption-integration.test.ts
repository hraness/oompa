import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import { combined49DatabaseBytes, combined49Fixture } from "../../scripts/fixtures/combined49";
import { combined49RetiredDatabaseBytes, combined49RetiredFixture } from "../../scripts/fixtures/combined49-retired";
import { combined49SwitchDatabaseBytes, combined49SwitchFixture } from "../../scripts/fixtures/combined49-switch";
import { assertCombined49AdoptionSchema } from "./combined49-adoption-schema";
import { initializeStatePaths, resolveStatePaths, type StatePaths } from "./paths";
import { StateStore } from "./state-store";

const captures = [
  { name: "retained owner, queue, usage and released Claude custody", bytes: combined49DatabaseBytes, identity: combined49Fixture },
  { name: "prepared switch capsule", bytes: combined49SwitchDatabaseBytes, identity: combined49SwitchFixture },
  { name: "retired-provider retained authority", bytes: combined49RetiredDatabaseBytes, identity: combined49RetiredFixture },
] as const;
const recordedAt = 1_900_000_000_000;
const migratedAt = recordedAt + 1_000;
const launchTableName = "session_claude_process_launch_intents";
const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const schemaObject = z.object({ type: z.string(), name: z.string(), tbl_name: z.string(), sql: z.string().nullable() }).strict();
const rowSchema = z.record(z.string(), z.unknown());

// Literal legacy DDL plus a real SQLite ALTER forms a synthetic compatibility
// input. The source images are authentic49; this nullable-launch variant is
// not an authentic captured database and adds no historical provenance.
const legacyLaunchTable = `CREATE TABLE session_claude_process_launch_intents (
  intent_id TEXT NOT NULL UNIQUE CHECK(length(intent_id)=36),
  provider_thread_id TEXT NOT NULL CHECK(length(provider_thread_id) BETWEEN 1 AND 200),
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  profile_generation INTEGER NOT NULL CHECK(profile_generation BETWEEN 0 AND 9007199254740991),
  runtime_scope TEXT NOT NULL CHECK(runtime_scope IN ('managed','personal')),
  session_id TEXT REFERENCES sessions(id),
  revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
  staged_at INTEGER NOT NULL CHECK(staged_at >= 0),
  updated_at INTEGER NOT NULL CHECK(updated_at >= staged_at),
  provider_account_key TEXT CHECK(
    provider_account_key IS NULL OR (
      length(provider_account_key)=74
      AND substr(provider_account_key,1,10)='v1:claude:'
      AND substr(provider_account_key,11) NOT GLOB '*[^0-9a-f]*'
    )
  ),
  PRIMARY KEY(runtime_scope,profile_id,provider_thread_id)
) STRICT`;
const custodyMarker = "provider_authority_digest TEXT REFERENCES session_claude_process_provider_authorities(digest) DEFERRABLE INITIALLY DEFERRED CHECK(provider_authority_digest IS NULL OR (length(provider_authority_digest)=64 AND provider_authority_digest NOT GLOB '*[^a-f0-9]*'))";

const snapshot = (database: Database) => {
  const tables = z.object({ name: z.string().regex(/^[a-z][a-z0-9_]*$/u) }).strict().array().parse(
    database.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name LIMIT 513").all(),
  );
  expect(tables.length).toBeLessThanOrEqual(512);
  const rows: Record<string, z.infer<typeof rowSchema>[]> = {};
  const columns: Record<string, string[]> = {};
  const cells: Record<string, z.infer<typeof rowSchema>[]> = {};
  for (const { name } of tables) {
    const names = z.object({ name: z.string().regex(/^[a-z][a-z0-9_]*$/u) }).array().parse(
      database.query(`PRAGMA table_info("${name}")`).all(),
    ).map((column) => column.name);
    columns[name] = names;
    const projection = names.map((column) => `json_array(typeof("${column}"),
      CASE WHEN typeof("${column}") IN ('text','blob') THEN hex(CAST("${column}" AS BLOB))
      ELSE "${column}" END) AS "${column}"`).join(",");
    cells[name] = rowSchema.array().parse(database.query(`SELECT ${projection} FROM "${name}" LIMIT 4097`).all())
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    expect(cells[name].length).toBeLessThanOrEqual(4096);
    // Fresh prepared statements avoid stale SELECT * metadata after ALTER.
    const statement = database.prepare(`SELECT * FROM "${name}" LIMIT 4097`);
    try {
      const values = rowSchema.array().parse(statement.all());
      expect(values.length).toBeLessThanOrEqual(4096);
      rows[name] = values.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    } finally {
      statement.finalize();
    }
  }
  const value = {
    version: database.query("PRAGMA user_version").get(),
    ledger: database.query("SELECT version,applied_at FROM migrations ORDER BY version").all(),
    schema: schemaObject.array().parse(database.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all()),
    foreignKeys: database.query("PRAGMA foreign_key_check").all(),
    rows,
    columns,
    cells,
  };
  expect(Buffer.byteLength(JSON.stringify(value), "utf8")).toBeLessThanOrEqual(16 * 1024 * 1024);
  expect(value.foreignKeys).toEqual([]);
  return value;
};
const inspect = (path: string) => {
  const database = new Database(path, { readonly: true, strict: true });
  try {
    const value = snapshot(database);
    expect(database.query("SELECT total_changes() AS count").get()).toEqual({ count: 0 });
    return value;
  } finally {
    database.close(false);
  }
};

const assertMigratedHistory = (original: ReturnType<typeof snapshot>, migrated: ReturnType<typeof snapshot>): void => {
  expect(migrated.version).toEqual({ user_version: 61 });
  const ledger = z.object({ version: z.number(), applied_at: z.number() }).strict().array().parse(original.ledger);
  expect(migrated.ledger).toEqual([
    ...ledger.filter((row) => row.version <= 40),
    ...Array.from({ length: 10 }, (_, index) => ({ version: index + 41, applied_at: migratedAt })),
    ...ledger.filter((row) => row.version >= 41).map((row) => ({ ...row, version: row.version + 10 })),
    { version: 60, applied_at: migratedAt },
    { version: 61, applied_at: migratedAt },
  ]);
  for (const [table, names] of Object.entries(original.columns)) {
    for (const name of names) expect(migrated.columns[table]).toContain(name);
    if (table === "migrations" || table === "session_autorespond_counters") continue;
    const actual = migrated.cells[table];
    if (actual === undefined) throw new Error(`Missing migrated fixture table: ${table}`);
    const expected = original.cells[table];
    if (expected === undefined) throw new Error(`Missing original fixture table: ${table}`);
    // Adding columns cannot authorize changes to any observed original cell,
    // including the exact UTF-8 bytes of retained JSON/digest preimages.
    expect(actual.map((row) => Object.fromEntries(names.map((name) => [name, row[name]])))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))).toEqual(expected);
  }
  const counters = new Map(z.object({ session_id: z.string(), consecutive_count: z.number(), updated_at: z.number() })
    .strict().array().parse(original.rows.session_autorespond_counters).map((row) => [row.session_id, row] as const));
  for (const session of rowSchema.array().parse(original.rows.sessions)) {
    const id = z.string().parse(session.id);
    const previous = counters.get(id);
    // Canonical44's frozen conservative floor is the sole old-row metadata
    // exception; do not turn it into permission to ignore this whole table.
    counters.set(id, { session_id: id, consecutive_count: Math.max(previous?.consecutive_count ?? 0, 3),
      updated_at: Math.max(previous?.updated_at ?? 0, migratedAt) });
  }
  expect(migrated.rows.session_autorespond_counters).toEqual([...counters.values()]
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
  // This compatibility variant must remain nullable; the join must not
  // silently replace its admitted historical declaration with current DDL.
  expect(migrated.schema.find((object) => object.name === launchTableName))
    .toEqual(original.schema.find((object) => object.name === launchTableName));
};

const withNullableLaunchFixture = async (
  capture: (typeof captures)[number],
  unprovedLaunch: boolean,
  run: (paths: StatePaths, expected: ReturnType<typeof snapshot>) => Promise<void>,
): Promise<void> => {
  const bytes = capture.bytes();
  expect(hash(bytes)).toBe(capture.identity.databaseSha256);
  expect(capture.identity.schemaVersion).toBe(49);
  const root = await realpath(await mkdtemp(join(tmpdir(), "oompa-combined49-nullable-launch-")));
  let holder: Database | undefined;
  try {
    const paths = resolveStatePaths({ rootDirectory: root });
    await initializeStatePaths(paths);
    await writeFile(paths.database, bytes, { mode: 0o600, flag: "wx" });
    holder = new Database(paths.database, { create: false, strict: true });
    holder.exec("PRAGMA foreign_keys=ON");
    const original = snapshot(holder);
    expect(original.version).toEqual({ user_version: 49 });
    expect(original.ledger).toEqual(Array.from({ length: 49 }, (_, index) => ({ version: index + 1, applied_at: recordedAt })));
    expect(original.rows[launchTableName]).toEqual([]);
    for (const table of ["profiles", "provider_accounts", "sessions", "mutation_attempts"]) {
      expect(original.rows[table]?.length).toBeGreaterThan(0);
    }
    const dependentObjects = original.schema.filter((object) => object.tbl_name === launchTableName
      && (object.type === "index" || object.type === "trigger") && object.sql !== null);
    const builder = holder;
    builder.exec("PRAGMA foreign_keys=OFF");
    try {
      builder.transaction(() => {
        builder.exec(`DROP TABLE ${launchTableName}`);
        builder.exec(legacyLaunchTable);
        builder.exec(`ALTER TABLE ${launchTableName} ADD COLUMN ${custodyMarker}`);
        if (unprovedLaunch) {
          // Deliberate corruption, not a claimed historical or runnable child.
          // No proof, account key or process authority is invented. Construct
          // it before restoring every exact guard, without writable_schema.
          const profile = z.object({ id: z.string(), process_generation: z.number().int() }).strict().parse(
            builder.query("SELECT id,process_generation FROM profiles ORDER BY id LIMIT 1").get(),
          );
          builder.query(`INSERT INTO session_claude_process_launch_intents(
            intent_id,provider_thread_id,profile_id,profile_generation,runtime_scope,
            session_id,revision,staged_at,updated_at,provider_account_key,provider_authority_digest
          ) VALUES(?,?,?,?, 'managed',NULL,1,?,?,NULL,NULL)`).run(
            "49000000-0000-4000-8000-000000000099", "synthetic-unproved-null-key-launch",
            profile.id, profile.process_generation, recordedAt, recordedAt,
          );
        }
        for (const object of dependentObjects) builder.exec(z.string().parse(object.sql));
      }).immediate();
    } finally {
      builder.exec("PRAGMA foreign_keys=ON");
    }
    const variant = snapshot(builder);
    expect(variant.ledger).toEqual(original.ledger);
    expect(variant.version).toEqual(original.version);
    expect(variant.schema.filter((object) => object.name !== launchTableName))
      .toEqual(original.schema.filter((object) => object.name !== launchTableName));
    expect(Object.fromEntries(Object.entries(variant.rows).filter(([name]) => name !== launchTableName)))
      .toEqual(Object.fromEntries(Object.entries(original.rows).filter(([name]) => name !== launchTableName)));
    expect(variant.rows[launchTableName]).toHaveLength(unprovedLaunch ? 1 : 0);
    // Schema compatibility cannot grant authority to the unproved row. Its
    // refusal below must come from the full StateStore row/custody audit.
    expect(() => assertCombined49AdoptionSchema(builder)).not.toThrow();
    expect(builder.query("PRAGMA wal_checkpoint(TRUNCATE)").get()).toEqual({ busy: 0, log: 0, checkpointed: 0 });
    // Retain a query-only WAL holder across genuine read-only StateStore and
    // inspector opens. No readonly reader is silently upgraded to writable.
    builder.exec("PRAGMA query_only=ON");
    builder.query("SELECT name FROM sqlite_master LIMIT 1").all();
    expect(inspect(paths.database)).toEqual(variant);
    await run(paths, variant);
  } finally {
    holder?.close(false);
    await rm(root, { recursive: true, force: true });
  }
};

for (const capture of captures) {
  for (const firstReadonly of [true, false]) {
    test(`synthetic nullable-launch DDL preserves ${capture.name} through 49-to-61 migration and ${firstReadonly ? "RO/RW" : "RW/RO"} reopens`, async () => {
      await withNullableLaunchFixture(capture, false, async (paths, expected) => {
        const originalBytes = hash(await readFile(paths.database));
        expect(() => new StateStore(paths, { readonly: true }))
          .toThrow("STATE_SCHEMA_MIGRATION_REQUIRED:49:61");
        expect(inspect(paths.database)).toEqual(expected);
        expect(hash(await readFile(paths.database))).toBe(originalBytes);
        const upgrading = new StateStore(paths, { now: () => migratedAt, resolveMachineTimeZone: () => "UTC" });
        let migrated: ReturnType<typeof snapshot>;
        try {
          expect(upgrading.listClaudeProcessLaunchIntents()).toEqual([]);
          migrated = inspect(paths.database);
          assertMigratedHistory(expected, migrated);
        } finally { upgrading.close(); }
        expect(inspect(paths.database)).toEqual(migrated);
        for (const readonly of [firstReadonly, !firstReadonly]) {
          const beforeBytes = hash(await readFile(paths.database));
          const store = new StateStore(paths, { readonly, now: () => migratedAt + 1, resolveMachineTimeZone: () => "UTC" });
          try {
            expect(store.listClaudeProcessLaunchIntents()).toEqual([]);
            expect(inspect(paths.database)).toEqual(migrated);
          } finally {
            store.close();
          }
          expect(inspect(paths.database)).toEqual(migrated);
          if (readonly) expect(hash(await readFile(paths.database))).toBe(beforeBytes);
        }
      });
    });
  }
}

test("nullable launch DDL keeps RO migration refusal distinct from the RW unproved NULL-key/NULL-marker row refusal", async () => {
  await withNullableLaunchFixture(captures[0], true, async (paths, expected) => {
    for (const readonly of [true, false]) {
      const beforeBytes = hash(await readFile(paths.database));
      expect(() => new StateStore(paths, { readonly, now: () => recordedAt, resolveMachineTimeZone: () => "UTC" }))
        .toThrow(readonly ? "STATE_SCHEMA_MIGRATION_REQUIRED:49:61" : "CLAUDE_PROCESS_CUSTODY_CORRUPT");
      expect(inspect(paths.database)).toEqual(expected);
      expect(hash(await readFile(paths.database))).toBe(beforeBytes);
    }
  });
});
