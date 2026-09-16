import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import { combined49SwitchDatabaseBytes, combined49SwitchFixture, combined49SwitchGeneratorSource } from "../../scripts/fixtures/combined49-switch";
import { initializeStatePaths, resolveStatePaths } from "./paths";
import { StateStore } from "./state-store";

const archived = combined49SwitchFixture;
const migratedAt = 1_900_000_001_000;
const guardName = "session_switch_session_update_guard";
const canonicalKey = "codex:gpt-5.6-sol:max";
const hash = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
const quote = (value: string): string => `"${value.replaceAll('"', '""')}"`;
const literal = (value: string): string => `'${value.replaceAll("'", "''")}'`;
const rowSchema = z.record(z.string(), z.unknown());

function tableColumns(database: Database, table: string): string[] {
  return z.object({ name: z.string(), hidden: z.literal(0) }).strict().array().max(2000).parse(
    database.query("SELECT name,hidden FROM pragma_table_xinfo(?,'main') ORDER BY cid").all(table),
  ).map(({ name }) => name);
}

function rawCells(database: Database, table: string, columns: readonly string[]) {
  const projection = columns.map((column) => `json_array(typeof(${quote(column)}),
    CASE WHEN typeof(${quote(column)}) IN ('text','blob') THEN hex(CAST(${quote(column)} AS BLOB))
    ELSE ${quote(column)} END) AS ${quote(column)}`).join(",");
  return rowSchema.array().max(4096).parse(database.query(`SELECT ${projection} FROM ${quote(table)} LIMIT 4097`).all())
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

function inspect<T>(path: string, read: (database: Database) => T): T {
  // A fresh connection avoids stale prepared SELECT metadata after ALTER TABLE.
  const database = new Database(path, { readonly: true, strict: true });
  try { return read(database); } finally { database.close(false); }
}

function snapshot(path: string) {
  return inspect(path, (database) => {
    const tables = z.object({ name: z.string() }).strict().array().max(512).parse(database.query(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name LIMIT 513",
    ).all());
    const columns = Object.fromEntries(tables.map(({ name }) => [name, tableColumns(database, name)]));
    const cells = Object.fromEntries(tables.map(({ name }) => {
      const names = columns[name];
      if (names === undefined) throw new Error("Missing original table column capture.");
      return [name, rawCells(database, name, names)];
    }));
    return {
      columns,
      cells,
      schema: database.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all(),
      schemaVersion: database.query("PRAGMA schema_version").get(),
      version: database.query("PRAGMA user_version").get(),
      ledger: database.query("SELECT version,applied_at FROM migrations ORDER BY version").all(),
      foreignKeys: database.query("PRAGMA foreign_key_check").all(),
    };
  });
}

function readGuard(database: Database): string {
  return z.object({ sql: z.string() }).strict().parse(database.query(
    "SELECT sql FROM sqlite_master WHERE type='trigger' AND name=? AND tbl_name='sessions'",
  ).get(guardName)).sql;
}

async function fixture(run: (database: Database, paths: ReturnType<typeof resolveStatePaths>) => void) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "oompa-retained-profile-migration-")));
  let database: Database | undefined;
  try {
    const bytes = combined49SwitchDatabaseBytes();
    expect(archived.sourceRevision).toBe("0ae317793d5ff694b4d333effe25f85f7e7f1491");
    expect(archived.sourceTree).toBe("8d66385130378febb9be4358dc40fe84de4d0591");
    expect(archived.schemaVersion).toBe(49);
    expect(hash(bytes)).toBe(archived.databaseSha256);
    expect(bytes.byteLength).toBe(archived.databaseBytes);
    expect(hash(combined49SwitchGeneratorSource)).toBe(archived.generatorSha256);
    expect(archived.syntheticControlPlaneOnly).toBe(true);
    expect(archived.nativeProviderAcceptance).toBe(false);
    expect(archived.nativeOsCustodyProved).toBe(false);
    const paths = resolveStatePaths({ rootDirectory: root });
    await initializeStatePaths(paths);
    await writeFile(paths.database, bytes, { mode: 0o600, flag: "wx" });
    database = new Database(paths.database, { create: false, strict: true });
    database.exec("PRAGMA foreign_keys=ON");
    expect(database.query("PRAGMA user_version").get()).toEqual({ user_version: 49 });
    expect(tableColumns(database, "sessions")).not.toContain("canonical_profile_key");
    expect(database.query("SELECT id,title,revision,provider_thread_id,preset,preset_contract FROM sessions WHERE id=?")
      .get(archived.session.id)).toEqual({ id: archived.session.id, title: archived.session.title,
      revision: archived.session.revision, provider_thread_id: archived.prepared.switch.sourceProviderThreadId,
      preset: "high", preset_contract: 1 });
    expect(archived.prepared.switch.phase).toBe("prepared");
    expect(database.query("PRAGMA foreign_key_check").all()).toEqual([]);
    run(database, paths);
  } finally { database?.close(false); await rm(root, { recursive: true, force: true }); }
}

test("retained combined49 prepared switch preserves original cells and installs only the exact joined fence successor", async () => {
  await fixture((database, paths) => {
    const originalGuard = readGuard(database);
    const original = snapshot(paths.database);
    const sessionColumns = original.columns.sessions;
    if (sessionColumns === undefined) throw new Error("Missing original session columns.");
    const sessionCells = original.cells.sessions;
    if (sessionCells === undefined) throw new Error("Missing original session cells.");
    database.exec("PRAGMA query_only=ON");
    expect(() => new StateStore(paths, { readonly: true })).toThrow("STATE_SCHEMA_MIGRATION_REQUIRED:49:61");
    expect(snapshot(paths.database)).toEqual(original);
    const store = new StateStore(paths, { now: () => migratedAt, resolveMachineTimeZone: () => "UTC" });
    try {
      expect(store.requireSession(archived.session.id)).toEqual(archived.session);
      expect(store.readSessionSwitchByIdempotencyKey(archived.input.idempotencyKey)?.phase).toBe("prepared");
      inspect(paths.database, (joined) => {
        expect(joined.query("SELECT canonical_profile_key FROM sessions WHERE id=?").get(archived.session.id))
          .toEqual({ canonical_profile_key: canonicalKey });
        expect(rawCells(joined, "sessions", sessionColumns)).toEqual(sessionCells);
        // Version 50 restores the exact historical fence (proved by the late
        // ledger fault below). The final join deliberately replaces only its
        // target-contract comparison with immutable execution-context proof.
        const historicalTarget = "AND NEW.preset_contract=switch.target_preset_contract";
        expect(originalGuard.split(historicalTarget)).toHaveLength(2);
        const joinedTarget = `AND NEW.preset_contract IS (
        SELECT context.target_preset_contract FROM session_switch_execution_contexts context
        JOIN session_switch_execution_context_anchors anchor
          ON anchor.attempt_id=context.attempt_id AND anchor.context_digest=context.context_digest
        JOIN session_switch_plan_anchors plan
          ON plan.attempt_id=context.attempt_id AND plan.plan_digest=context.plan_digest
          AND plan.recorded_at=context.created_at
        JOIN session_switch_attempts parent
          ON parent.attempt_id=context.attempt_id AND parent.journal_sequence=switch.journal_sequence
        WHERE context.attempt_id=switch.attempt_id AND context.request_digest=switch.request_digest
          AND context.target_provider_account_id=switch.target_provider_account_id
          AND context.target_profile_id=switch.target_profile_id AND context.target_provider=switch.target_provider
          AND context.target_binding_generation=switch.target_binding_generation
          AND context.target_process_generation=switch.target_process_generation
          AND context.renderer_version=parent.renderer_version AND context.created_at=parent.created_at
      )`;
        expect(readGuard(joined)).toBe(originalGuard.replace(historicalTarget, joinedTarget));
        for (const [table, names] of Object.entries(original.columns)) {
          const cells = original.cells[table];
          if (cells === undefined) throw new Error("Missing original switch cells.");
          if (table.startsWith("session_switch_")) expect(rawCells(joined, table, names)).toEqual(cells);
        }
      });
    } finally { store.close(); }
    const migrated = snapshot(paths.database);
    expect(migrated.version).toEqual({ user_version: 61 });
    expect(migrated.foreignKeys).toEqual([]);
    for (const readonly of [false, true]) {
      const reopened = new StateStore(paths, { readonly, now: () => migratedAt + 1, resolveMachineTimeZone: () => "UTC" });
      try { expect(snapshot(paths.database)).toEqual(migrated); } finally { reopened.close(); }
      expect(snapshot(paths.database)).toEqual(migrated);
    }
  });
});

const originalCellFaults = [
  { name: "title", update: "title=title||' [synthetic probe]',revision=revision+1" },
  { name: "revision", update: "revision=revision+1" },
  { name: "native_thread", update: "provider_thread_id=NULL,revision=revision+1" },
] as const;

for (const fault of originalCellFaults) test(`retained canonical key migration rolls back a synthetic ${fault.name} write to an original session cell`, async () => {
  await fixture((database, paths) => {
    const originalGuard = readGuard(database);
    // Deliberate fault injection on the genuine capture, not an archived writer
    // claim. SQLite allows UPDATE OF to name the not-yet-added key column.
    database.exec(`CREATE TRIGGER test_profile_cell_fault AFTER UPDATE OF canonical_profile_key ON sessions
      BEGIN UPDATE sessions SET ${fault.update} WHERE id=NEW.id; END`);
    const original = snapshot(paths.database);
    database.exec("PRAGMA query_only=ON");
    // The frozen multi-statement installer surfaces the aborted backfill at
    // its populated-key audit. The full snapshot below must still prove the
    // nested original-cell write and all prior migration work rolled back.
    expect(() => new StateStore(paths, { now: () => migratedAt, resolveMachineTimeZone: () => "UTC" }))
      .toThrow("CANONICAL_PROFILE_ROWS_SESSIONS");
    // Includes the injected trigger, every original TEXT/BLOB byte and storage
    // class, all old columns, the ledger, and the schema/user version stamps.
    expect(snapshot(paths.database)).toEqual(original);
    expect(inspect(paths.database, readGuard)).toBe(originalGuard);
    expect(snapshot(paths.database).columns.sessions).not.toContain("canonical_profile_key");
  });
});

test("retained canonical profile migration restores its fence before a later ledger failure and rolls the whole join back", async () => {
  await fixture((database, paths) => {
    const originalGuard = readGuard(database);
    // This injected failure is later than the key backfill. Its distinct
    // diagnostics prove both the populated key and exact restored guard first.
    database.exec(`CREATE TRIGGER test_profile_late_failure BEFORE INSERT ON migrations WHEN NEW.version=50
      BEGIN
        SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM sessions WHERE id=${literal(archived.session.id)}
          AND canonical_profile_key=${literal(canonicalKey)})
          THEN RAISE(ABORT,'TEST_PROFILE_BACKFILL_MISSING') END;
        SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM sqlite_master WHERE type='trigger'
          AND name=${literal(guardName)} AND tbl_name='sessions'
          AND CAST(sql AS BLOB)=X'${Buffer.from(originalGuard).toString("hex")}')
          THEN RAISE(ABORT,'TEST_PROFILE_FENCE_NOT_RESTORED') END;
        SELECT RAISE(ABORT,'TEST_PROFILE_LATE_LEDGER_FAILURE');
      END`);
    const original = snapshot(paths.database);
    database.exec("PRAGMA query_only=ON");
    expect(() => new StateStore(paths, { now: () => migratedAt, resolveMachineTimeZone: () => "UTC" }))
      .toThrow("TEST_PROFILE_LATE_LEDGER_FAILURE");
    expect(snapshot(paths.database)).toEqual(original);
    expect(inspect(paths.database, readGuard)).toBe(originalGuard);
    expect(snapshot(paths.database).columns.sessions).not.toContain("canonical_profile_key");
  });
});
