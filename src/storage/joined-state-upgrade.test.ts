import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import { canonicalBudgetDatabaseBytes } from "../../scripts/fixtures/canonical-budget-history";
import { canonical39DevinDatabaseBytes } from "../../scripts/fixtures/canonical39-devin";
import { canonical40QueuesDatabaseBytes } from "../../scripts/fixtures/canonical40-queues";
import { canonical49WorkDatabaseBytes } from "../../scripts/fixtures/canonical49-work";
import { combined49DatabaseBytes } from "../../scripts/fixtures/combined49";
import { combined49SwitchDatabaseBytes } from "../../scripts/fixtures/combined49-switch";
import { privateTask48DatabaseBytes } from "../../scripts/fixtures/private-task48";
import { initializeStatePaths, resolveStatePaths } from "./paths";
import { StateStore } from "./state-store";

setDefaultTimeout(30_000);

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
const snapshot = (path: string) => {
  // Archived WAL-mode images have no sidecars yet. A query-only connection
  // initializes local WAL bookkeeping without running migrations or row writes.
  const database = new Database(path, { create: false, strict: true });
  database.exec("PRAGMA query_only=ON");
  try {
    const names = z.object({ name: z.string().regex(/^[a-zA-Z0-9_]+$/u) }).strict().array().parse(
      database.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all(),
    );
    return {
      version: database.query("PRAGMA user_version").get(),
      schema: database.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all(),
      rows: Object.fromEntries(names.map(({ name }) => [name,
        database.query(`SELECT * FROM "${name}"`).all()
          .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
      ])),
      foreignKeys: database.query("PRAGMA foreign_key_check").all(),
    };
  } finally { database.close(false); }
};
const pathsFor = async (bytes?: Uint8Array) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "oompa-joined-state-upgrade-")));
  directories.push(directory);
  const paths = resolveStatePaths({ homeDirectory: directory, platform: "darwin" });
  await initializeStatePaths(paths);
  if (bytes !== undefined) await writeFile(paths.database, bytes, { mode: 0o600, flag: "wx" });
  return paths;
};
const open = (paths: ReturnType<typeof resolveStatePaths>, readonly = false) => {
  const store = new StateStore(paths, { readonly, now: () => 2_000_000_000_000,
    resolveMachineTimeZone: () => "UTC" });
  store.close();
};
const ledger = (rows: unknown) => z.object({ version: z.number().int(), applied_at: z.number().int() })
  .strict().array().parse(rows).sort((left, right) => left.version - right.version);

// These tests execute the actual joined migration on byte-identified archived
// producers. They do not start a provider, exercise native custody, allocate a
// governed migration version or establish release/deployment acceptance.
describe("private joined migration candidate", () => {
  test("creates and reopens the complete fresh schema without replay writes", async () => {
    const paths = await pathsFor();
    open(paths);
    const before = snapshot(paths.database);
    expect(before.version).toEqual({ user_version: 60 });
    expect(ledger(before.rows.migrations).map(({ version }) => version))
      .toEqual(Array.from({ length: 60 }, (_, index) => index + 1));
    expect(before.foreignKeys).toEqual([]);
    open(paths);
    expect(snapshot(paths.database)).toEqual(before);
    open(paths, true);
    expect(snapshot(paths.database)).toEqual(before);
  });

  for (const damage of ["joined guard", "provenance anchor guard", "ledger"] as const) {
    test(`current schema refuses a missing ${damage} without reconstructing authority`, async () => {
      const paths = await pathsFor();
      open(paths);
      const database = new Database(paths.database, { create: false, strict: true });
      try {
        if (damage === "joined guard") database.exec("DROP TRIGGER joined_evidence_boundary_message_source_insert");
        else if (damage === "provenance anchor guard") {
          const guard = z.object({ name: z.string().regex(/^[a-z_]+$/u) }).strict().parse(database.query(
            `SELECT name FROM sqlite_master WHERE type='trigger'
             AND tbl_name='mutation_effect_evidence_provenance_anchors' ORDER BY name LIMIT 1`,
          ).get());
          database.exec(`DROP TRIGGER ${guard.name}`);
        } else database.query("DELETE FROM migrations WHERE version=?").run(60);
      } finally { database.close(false); }
      const damaged = snapshot(paths.database);
      for (const readonly of [false, true]) {
        expect(() => open(paths, readonly)).toThrow();
        expect(snapshot(paths.database)).toEqual(damaged);
      }
    });
  }

  const sources = [
    { name: "canonical39", bytes: canonical39DevinDatabaseBytes, mapVersion: (value: number) => value },
    { name: "canonical40", bytes: canonical40QueuesDatabaseBytes, mapVersion: (value: number) => value },
    { name: "canonical43", bytes: () => canonicalBudgetDatabaseBytes(43), mapVersion: (value: number) => value },
    { name: "canonical45", bytes: () => canonicalBudgetDatabaseBytes(45), mapVersion: (value: number) => value },
    { name: "canonical49", bytes: canonical49WorkDatabaseBytes, mapVersion: (value: number) => value },
    { name: "private48", bytes: privateTask48DatabaseBytes, mapVersion: (value: number) => value < 40 ? value : value + 11 },
    { name: "combined49", bytes: combined49DatabaseBytes, mapVersion: (value: number) => value < 41 ? value : value + 10 },
    { name: "combined49 prepared switch", bytes: combined49SwitchDatabaseBytes, mapVersion: (value: number) => value < 41 ? value : value + 10 },
  ] as const;
  for (const source of sources) test(`upgrades authentic ${source.name} without changing sealed evidence or migration times`, async () => {
    const paths = await pathsFor(source.bytes());
    const before = snapshot(paths.database);
    open(paths);
    const after = snapshot(paths.database);
    expect(after.version).toEqual({ user_version: 60 });
    expect(after.foreignKeys).toEqual([]);
    const migrated = ledger(after.rows.migrations);
    expect(migrated.map(({ version }) => version)).toEqual(Array.from({ length: 60 }, (_, index) => index + 1));
    for (const entry of ledger(before.rows.migrations)) {
      expect(migrated.find(({ version }) => version === source.mapVersion(entry.version)))
        .toEqual({ version: source.mapVersion(entry.version), applied_at: entry.applied_at });
    }
    for (const name of ["mutation_effect_evidence", "queue_effect_evidence", "session_send_owners",
      "session_send_execution_claims", "session_send_owner_anchors", "session_send_owner_outcomes",
      "queue_attachment_identities", "queue_attachment_identity_anchors"]) {
      if (before.rows[name] !== undefined) expect(after.rows[name]).toEqual(before.rows[name]);
    }
    open(paths);
    expect(snapshot(paths.database)).toEqual(after);
    open(paths, true);
    expect(snapshot(paths.database)).toEqual(after);
  });
});
