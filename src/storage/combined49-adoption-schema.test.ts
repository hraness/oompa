import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import { combined49DatabaseBytes } from "../../scripts/fixtures/combined49";
import { combined49RetiredDatabaseBytes } from "../../scripts/fixtures/combined49-retired";
import { combined49SwitchDatabaseBytes } from "../../scripts/fixtures/combined49-switch";
import { assertCombined49AdoptionSchema } from "./combined49-adoption-schema";

setDefaultTimeout(30_000);

const roots: string[] = [];
const databases: Database[] = [];
afterEach(async () => {
  for (const database of databases.splice(0).reverse()) database.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const captures = [
  { name: "original owner and released Claude custody", bytes: combined49DatabaseBytes },
  { name: "prepared switch capsule", bytes: combined49SwitchDatabaseBytes },
  { name: "retired-provider retained authority", bytes: combined49RetiredDatabaseBytes },
] as const;
const openFixture = async (bytes: Uint8Array, readonly = false): Promise<Database> => {
  const root = await mkdtemp(join(tmpdir(), "oompa-combined49-adoption-schema-"));
  roots.push(root);
  const path = join(root, "state.sqlite");
  await writeFile(path, bytes, { mode: 0o600 });
  if (readonly) {
    // Archived WAL databases need sidecars prepared before a real RO open.
    // Keep this query-only initializer alive until the reader is closed.
    const initializer = new Database(path, { create: false, strict: true });
    databases.push(initializer);
    initializer.exec("PRAGMA query_only=ON");
    initializer.query("SELECT name FROM sqlite_master LIMIT 1").all();
  }
  const database = new Database(path, { create: false, strict: true, readonly });
  databases.push(database);
  database.exec("PRAGMA foreign_keys=ON");
  return database;
};
const snapshot = (database: Database) => {
  const tables = z.object({ name: z.string().regex(/^[a-z][a-z0-9_]*$/u) }).strict().array().parse(
    database.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all(),
  );
  return {
    schema: database.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all(),
    version: database.query("PRAGMA user_version").get(),
    ledger: database.query("SELECT version,applied_at FROM migrations ORDER BY version").all(),
    changes: database.query("SELECT total_changes() AS count").get(),
    foreignKeys: database.query("PRAGMA foreign_keys").get(),
    violations: database.query("PRAGMA foreign_key_check").all(),
    rows: Object.fromEntries(tables.map(({ name }) => {
      const statement = database.prepare(`SELECT * FROM "${name}"`);
      try {
        return [name, statement.all().map((row) => JSON.stringify(row)).sort()];
      } finally {
        statement.finalize();
      }
    })),
  };
};
const expectRefusalWithoutMutation = (
  database: Database,
  error = "STATE_COMBINED49_ADOPTION_SCHEMA_INVALID",
): void => {
  const before = snapshot(database);
  expect(() => assertCombined49AdoptionSchema(database)).toThrow(error);
  expect(snapshot(database)).toEqual(before);
};

// Independent, literal historical compatibility input: the earliest launch
// table appended the nullable key after updated_at. This is not a captured
// combined49 image. Exercise SQLite's real ALTER placement of the later marker.
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
const replaceEmptyLaunchTable = (database: Database, sql: string, appendMarker: boolean): void => {
  expect(database.query("SELECT count(*) AS count FROM session_claude_process_launch_intents").get()).toEqual({ count: 0 });
  const dependents = z.object({ sql: z.string() }).strict().array().parse(database.query(
    `SELECT sql FROM sqlite_master WHERE tbl_name='session_claude_process_launch_intents'
      AND type IN ('index','trigger') AND sql IS NOT NULL ORDER BY type,name`,
  ).all());
  database.exec("PRAGMA foreign_keys=OFF");
  try {
    database.transaction(() => {
      database.exec("DROP TABLE session_claude_process_launch_intents");
      database.exec(sql);
      if (appendMarker) database.exec(`ALTER TABLE session_claude_process_launch_intents ADD COLUMN ${custodyMarker}`);
      for (const dependent of dependents) database.exec(dependent.sql);
    }).immediate();
  } finally {
    database.exec("PRAGMA foreign_keys=ON");
  }
};

describe("frozen combined49 adoption schema", () => {
  for (const capture of captures) {
    for (const readonly of [false, true]) {
      test(`accepts archived ${capture.name} on ${readonly ? "readonly" : "writable"} SQLite without mutation`, async () => {
        const database = await openFixture(capture.bytes(), readonly);
        const before = snapshot(database);
        expect(() => assertCombined49AdoptionSchema(database)).not.toThrow();
        expect(snapshot(database)).toEqual(before);
      });
    }

    test(`retains exact nullable-key launch DDL compatibility for ${capture.name}, not NULL-row custody authority`, async () => {
      const database = await openFixture(capture.bytes());
      replaceEmptyLaunchTable(database, legacyLaunchTable, true);
      const before = snapshot(database);
      expect(() => assertCombined49AdoptionSchema(database)).not.toThrow();
      expect(snapshot(database)).toEqual(before);
    });
  }

  for (const name of [
    "session_adoption_candidates_claude_reprobe",
    "session_adoption_profile_generation_guard",
    "profile_controller_authority_recovery_guard",
    "claude_process_custody_bind",
    "session_switch_adoption_parent_update",
  ]) {
    test(`refuses missing ${name} without recreating it`, async () => {
      const database = await openFixture(combined49DatabaseBytes());
      const object = z.object({ type: z.enum(["index", "trigger"]) }).strict().parse(
        database.query("SELECT type FROM sqlite_master WHERE name=?").get(name),
      );
      database.exec(`DROP ${object.type.toUpperCase()} ${name}`);
      expectRefusalWithoutMutation(database,
        name === "claude_process_custody_bind" || name === "session_switch_adoption_parent_update"
          ? "STATE_SCHEMA_V39_ADOPTION_SURFACE_INVALID" : `STATE_SCHEMA_V39_OBJECT_MISSING:${name}`);
    });
  }

  for (const [name, table] of [
    ["session_adoption_profile_generation_guard", "profiles"],
    ["profile_controller_authority_recovery_guard", "profiles"],
    ["work_attempt_account_authority_guard", "work_attempts"],
    ["work_coordinator_account_authority_guard", "works"],
    ["work_member_account_authority_guard", "work_members"],
    ["work_review_account_authority_guard", "work_reviews"],
    ["work_signal_account_authority_guard", "work_signals"],
    ["work_signal_ack_account_authority_guard", "work_signal_receipts"],
  ] as const) {
    test(`refuses altered historical guard ${name} even with its name retained`, async () => {
      const database = await openFixture(combined49DatabaseBytes());
      database.exec(`DROP TRIGGER ${name}; CREATE TRIGGER ${name} BEFORE INSERT ON ${table} BEGIN SELECT 1; END`);
      expectRefusalWithoutMutation(database, name.startsWith("work_")
        ? "STATE_SCHEMA_V39_ADOPTION_WORK_INVALID" : `STATE_SCHEMA_V39_OBJECT_INVALID:${name}`);
    });
  }

  for (const [name, sql] of [
    ["an extra index on an adoption table", "CREATE INDEX unrecognized_adoption_lookup ON session_adoption_candidates(provider)"],
    ["an extra guard referencing adoption authority from a host table", "CREATE TRIGGER unrecognized_authority_guard BEFORE INSERT ON sessions BEGIN SELECT 1 FROM session_account_authorities; END"],
    ["an extra guard referencing the profile key", "CREATE TRIGGER unrecognized_profile_key_guard BEFORE INSERT ON profiles BEGIN SELECT NEW.codex_account_key; END"],
    ["an adoption-prefixed table", "CREATE TABLE session_adoption_unrecognized (id TEXT PRIMARY KEY) STRICT"],
    ["a personal-runtime-prefixed table", "CREATE TABLE session_personal_runtime_unrecognized (id TEXT PRIMARY KEY) STRICT"],
    ["a process-prefixed table", "CREATE TABLE session_claude_process_unrecognized (id TEXT PRIMARY KEY) STRICT"],
    ["a runtime-account-prefixed table", "CREATE TABLE provider_runtime_account_unrecognized (id TEXT PRIMARY KEY) STRICT"],
    ["a revocation-prefixed table", "CREATE TABLE profile_personal_authority_unrecognized (id TEXT PRIMARY KEY) STRICT"],
  ] as const) {
    test(`refuses ${name}`, async () => {
      const database = await openFixture(combined49DatabaseBytes());
      database.exec(sql);
      expectRefusalWithoutMutation(database, "STATE_SCHEMA_V39_LEGACY_ADOPTION_OBJECT_INVALID:");
    });
  }

  test("refuses disabled foreign keys without enabling them", async () => {
    const database = await openFixture(combined49DatabaseBytes());
    database.exec("PRAGMA foreign_keys=OFF");
    expectRefusalWithoutMutation(database);
  });

  test("refuses a launch key made nullable in the authentic column position", async () => {
    const database = await openFixture(combined49DatabaseBytes());
    const { sql } = z.object({ sql: z.string() }).strict().parse(database.query(
      "SELECT sql FROM sqlite_master WHERE name='session_claude_process_launch_intents'",
    ).get());
    replaceEmptyLaunchTable(database, sql.replace("provider_account_key TEXT NOT NULL", "provider_account_key TEXT"), false);
    expectRefusalWithoutMutation(database, "STATE_SCHEMA_V39_OBJECT_INVALID:session_claude_process_launch_intents");
  });

  test("refuses changed nullable-key compatibility constraints", async () => {
    const database = await openFixture(combined49DatabaseBytes());
    replaceEmptyLaunchTable(database, legacyLaunchTable.replace("length(provider_account_key)=74", "length(provider_account_key)=75"), true);
    expectRefusalWithoutMutation(database, "STATE_SCHEMA_V39_OBJECT_INVALID:session_claude_process_launch_intents");
  });

  test("refuses the nullable launch variant with its marker before the account key", async () => {
    const database = await openFixture(combined49DatabaseBytes());
    replaceEmptyLaunchTable(database, legacyLaunchTable.replace("provider_account_key TEXT CHECK(", `${custodyMarker}, provider_account_key TEXT CHECK(`), false);
    expectRefusalWithoutMutation(database, "STATE_SCHEMA_V39_OBJECT_INVALID:session_claude_process_launch_intents");
  });

  test("reports the altered index before a later altered guard in the historical object order", async () => {
    const database = await openFixture(combined49DatabaseBytes());
    database.exec(`
      DROP INDEX session_claude_process_authorities_live_identity;
      CREATE INDEX session_claude_process_authorities_live_identity
        ON session_claude_process_authorities(pid_domain,pid,proc_start)
        WHERE state!='released';
      DROP TRIGGER session_adoption_candidate_revision_guard;
      CREATE TRIGGER session_adoption_candidate_revision_guard
        BEFORE UPDATE ON session_adoption_candidates BEGIN SELECT 1; END;
    `);
    expectRefusalWithoutMutation(database, "STATE_SCHEMA_V39_OBJECT_INVALID:session_claude_process_authorities_live_identity");
  });

  test("refuses a renamed authority index represented by a same-name table", async () => {
    const database = await openFixture(combined49DatabaseBytes());
    database.exec(`DROP INDEX session_adoption_candidates_claude_reprobe;
      CREATE TABLE session_adoption_candidates_claude_reprobe(id TEXT PRIMARY KEY) STRICT`);
    expectRefusalWithoutMutation(database, "STATE_SCHEMA_V39_OBJECT_INVALID:session_adoption_candidates_claude_reprobe");
  });
});
