import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initializeStatePaths, resolveStatePaths } from "./paths";
import { StateStore } from "./state-store";

test.each(["provider_accounts", "automatic_usage_policy_revisions"])(
  "readonly admission rejects a literal-altered %s constraint without changing retained evidence",
  async (tableName) => {
    const scratch = await realpath(await mkdtemp(join(tmpdir(), "oompa-schema-sql-admission-")));
    const paths = resolveStatePaths({ homeDirectory: scratch, platform: "darwin" });
    try {
      await initializeStatePaths(paths);
      const store = new StateStore(paths);
      store.close();
      const database = new Database(paths.database, { create: false, strict: true });
      try {
        const row = database.query("SELECT sql FROM sqlite_master WHERE type='table' AND name=?")
          .get(tableName) as { sql: string };
        const original = "*[^0-9a-f]*";
        const changed = "IF NOT EXISTS*[^0-9a-f]*";
        expect(row.sql).toContain(original);
        expect(database.query("SELECT ?1 NOT GLOB ?2 AS valid, ?1 NOT GLOB ?3 AS weakened")
          .get("g".repeat(64), original, changed)).toEqual({ valid: 0, weakened: 1 });
        // Rebuild only this disposable fixture's table through real DDL.
        // Restore its rows and owned objects without changing their evidence.
        const ownedObjects = database.query(
          "SELECT sql FROM sqlite_master WHERE tbl_name=? AND type IN ('index','trigger') AND sql IS NOT NULL ORDER BY name",
        ).all(tableName) as Array<{ sql: string }>;
        database.exec("PRAGMA foreign_keys=OFF");
        database.exec(`CREATE TEMP TABLE saved_rows AS SELECT * FROM ${tableName}`);
        database.exec(`DROP TABLE ${tableName}`);
        database.exec(row.sql.replaceAll(original, changed));
        database.exec(`INSERT INTO ${tableName} SELECT * FROM saved_rows`);
        for (const object of ownedObjects) database.exec(object.sql);
        database.exec("DROP TABLE saved_rows");
      } finally { database.close(); }
      const before = new Database(paths.database, { readonly: true, strict: true });
      try {
        const schema = before.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY name").all();
        const migrations = before.query("SELECT * FROM migrations ORDER BY version").all();
        const rows = before.query(`SELECT * FROM ${tableName} ORDER BY 1`).all();
        let reopened: StateStore | undefined;
        try {
          expect(() => { reopened = new StateStore(paths, { readonly: true }); }).toThrow();
        } finally { reopened?.close(); }
        expect(before.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY name").all()).toEqual(schema);
        expect(before.query("SELECT * FROM migrations ORDER BY version").all()).toEqual(migrations);
        expect(before.query(`SELECT * FROM ${tableName} ORDER BY 1`).all()).toEqual(rows);
      } finally { before.close(); }
    } finally { await rm(scratch, { recursive: true, force: true }); }
  },
);

test("readonly current-schema admission requires the complete migration ledger without filling a gap", async () => {
  const scratch = await realpath(await mkdtemp(join(tmpdir(), "oompa-schema-ledger-admission-")));
  const paths = resolveStatePaths({ homeDirectory: scratch, platform: "darwin" });
  try {
    await initializeStatePaths(paths);
    const store = new StateStore(paths);
    store.close();
    const database = new Database(paths.database, { create: false, strict: true });
    try {
      database.exec("DELETE FROM migrations WHERE version=49");
      const migrations = database.query("SELECT * FROM migrations ORDER BY version").all();
      let reopened: StateStore | undefined;
      try {
        expect(() => { reopened = new StateStore(paths, { readonly: true }); })
          .toThrow("STATE_SCHEMA_JOIN_LEDGER_INVALID");
      } finally { reopened?.close(); }
      expect(database.query("SELECT * FROM migrations ORDER BY version").all()).toEqual(migrations);
      expect(database.query("PRAGMA user_version").get()).toEqual({ user_version: 61 });
    } finally { database.close(); }
  } finally { await rm(scratch, { recursive: true, force: true }); }
});
