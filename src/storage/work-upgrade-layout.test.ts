import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { canonical30WorkDatabaseBytes, canonical30WorkFixture } from "../../scripts/fixtures/canonical30-work";
import { combined49DatabaseBytes } from "../../scripts/fixtures/combined49";
import { initializeStatePaths, resolveStatePaths } from "./paths";
import { normalizeSchemaSql } from "./schema-cohort";
import { StateStore } from "./state-store";

const snapshot = (database: Database) => ({
  schema: database.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all(),
  version: database.query("PRAGMA user_version").get(),
  ledger: database.query("SELECT version,applied_at FROM migrations ORDER BY version").all(),
  rows: Object.fromEntries(database.query<{ name: string }, []>(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
  ).all().map(({ name }) => {
    if (!/^[A-Za-z0-9_]+$/u.test(name)) throw new Error("Unexpected fixture table name.");
    return [name, database.query(`SELECT * FROM "${name}"`).all()
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))];
  })),
  foreignKeys: database.query("PRAGMA foreign_key_check").all(),
});

test("retains the exact Work table layout produced by a canonical30 upgrade", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "oompa-work-upgrade-layout-")));
  let store: StateStore | undefined;
  let actual: Database | undefined;
  let reference: Database | undefined;
  try {
    const paths = resolveStatePaths({ rootDirectory: join(root, "upgrade") });
    await initializeStatePaths(paths);
    await writeFile(paths.database, canonical30WorkDatabaseBytes(), { mode: 0o600, flag: "wx" });
    const referencePath = join(root, "reference.sqlite");
    await writeFile(referencePath, combined49DatabaseBytes(), { mode: 0o600, flag: "wx" });
    reference = new Database(referencePath, { strict: true });
    store = new StateStore(paths, { now: () => 2_000, resolveMachineTimeZone: () => "UTC" });
    actual = new Database(paths.database, { readonly: true, strict: true });
    const tables = (database: Database) => database.query<{ name: string; sql: string }, []>(
      "SELECT name,sql FROM sqlite_master WHERE type='table' AND (name='works' OR name GLOB 'work_*') ORDER BY name",
    ).all().map((row) => ({ ...row, sql: normalizeSchemaSql(row.sql) }));
    const expected = tables(reference);
    const changed = tables(actual).filter((row) => expected.find((value) => value.name === row.name)?.sql !== row.sql);
    expect(changed.map((row) => row.name)).toEqual(["work_attempts", "work_routes", "work_tasks", "works"]);
    const originalWorks = canonical30WorkFixture.workObjects.find((row) => row.name === "works");
    if (originalWorks === undefined) throw new Error("Missing archived canonical30 Work table.");
    const expectedUpgrade = new Database(":memory:");
    try {
      // Start from archived table declarations, not the current writer. The
      // canonical30 works ALTER layout and canonical50 companion columns are
      // the only allowed differences from the captured combined49 Work tables.
      for (const row of reference.query<{ name: string; sql: string }, []>(
        "SELECT name,sql FROM sqlite_master WHERE type='table' AND (name='works' OR name GLOB 'work_*') ORDER BY name",
      ).all()) expectedUpgrade.exec(row.name === "works" ? originalWorks.sql : row.sql);
      expectedUpgrade.exec("ALTER TABLE works ADD COLUMN preset_contract INTEGER NOT NULL DEFAULT 1 CHECK(preset_contract IN (1,2))");
      for (const table of ["work_routes", "work_tasks", "work_attempts"]) {
        expectedUpgrade.exec(`ALTER TABLE ${table} ADD COLUMN canonical_profile_key TEXT`);
      }
      // Compare the complete table inventory too: a removed or extra table
      // must not disappear behind a comparison of only changed declarations.
      expect(tables(actual)).toEqual(tables(expectedUpgrade));
    } finally { expectedUpgrade.close(); }
    for (const table of ["sessions", "work_routes", "work_tasks", "work_attempts"]) {
      expect(actual.query(`SELECT name,type,"notnull",dflt_value,pk FROM pragma_table_info('${table}')
        WHERE name='canonical_profile_key'`).all()).toEqual([
        { name: "canonical_profile_key", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      ]);
    }
    expect(actual.query("SELECT version,applied_at FROM migrations WHERE version<=30 ORDER BY version").all())
      .toEqual([...canonical30WorkFixture.migrations]);
    const before = snapshot(actual);
    expect(before.version).toEqual({ user_version: 61 });
    expect(before.foreignKeys).toEqual([]);
    store.close();
    store = undefined;
    for (const readonly of [false, true, false, true]) {
      store = new StateStore(paths, { readonly, now: () => 2_001, resolveMachineTimeZone: () => "UTC" });
      expect(snapshot(actual)).toEqual(before);
      store.close();
      store = undefined;
      expect(snapshot(actual)).toEqual(before);
    }
  } finally {
    actual?.close();
    reference?.close();
    store?.close();
    await rm(root, { recursive: true, force: true });
  }
});
