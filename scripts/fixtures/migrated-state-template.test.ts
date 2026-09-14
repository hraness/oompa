import { Database } from "bun:sqlite";
import { beforeAll, describe, expect, test } from "bun:test";
import { lstat, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initializeStatePaths, resolveStatePaths, type StatePaths } from "../../src/storage/paths";
import { StateStore } from "../../src/storage/state-store";
import { provisionMigratedStateTemplate } from "./migrated-state-template";

const timeZone = "America/Puerto_Rico";

async function freshRoot(): Promise<{ home: string; paths: StatePaths }> {
  const home = await realpath(await mkdtemp(join(tmpdir(), "oompa-template-contract-")));
  const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
  await initializeStatePaths(paths);
  return { home, paths };
}

// Every table's rows plus the schema and version stamp, in a stable order.
function snapshot(path: string): unknown {
  const database = new Database(path, { readonly: true, strict: true });
  try {
    database.exec("PRAGMA query_only=ON");
    const tables = database.query<{ name: string }, []>(
      "SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name",
    ).all().map(({ name }) => {
      if (!/^[A-Za-z0-9_]+$/u.test(name)) throw new Error("Unexpected table name.");
      return { name, rows: database.query(`SELECT * FROM "${name}"`).all().map((row) => JSON.stringify(row)).sort() };
    });
    return {
      version: database.query("PRAGMA user_version").get(),
      schema: database.query("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name").all(),
      tables,
    };
  } finally {
    // A closing reader tries a checkpoint that the open store can hold off;
    // the throwing close reports that as a lock. Nothing was written.
    database.close(false);
  }
}

describe("migrated state template", () => {
  // Build the reusable template in its own bounded setup. The comparison still
  // migrates a separate empty database and retains its five-second body limit.
  beforeAll(async () => {
    const { home, paths } = await freshRoot();
    try {
      await provisionMigratedStateTemplate(paths, { resolveMachineTimeZone: () => timeZone });
    } finally {
      await rm(home, { force: true, recursive: true });
    }
  }, 5_000);

  test("provisions a store identical to a real migration under the same clock and time zone", async () => {
    const real = await freshRoot();
    const templated = await freshRoot();
    try {
      let realReads = 1_000;
      const realStore = new StateStore(real.paths, {
        now: () => realReads++, resolveMachineTimeZone: () => timeZone,
      });
      // Read both databases while their stores are open: a closed store may
      // still be settling its WAL, and an open WAL reader sees committed rows.
      const realSnapshot = snapshot(real.paths.database);
      realStore.close();

      let templatedReads = 1_000;
      const now = (): number => templatedReads++;
      await provisionMigratedStateTemplate(templated.paths, { now, resolveMachineTimeZone: () => timeZone });
      const metadata = await lstat(templated.paths.database);
      expect(metadata.isFile()).toBeTrue();
      expect(metadata.nlink).toBe(1);
      expect(metadata.mode & 0o777).toBe(0o600);
      // The template open must not read the clock; the replayed reads already
      // moved a counter clock exactly as far as the real chain did.
      const beforeOpen = templatedReads;
      const templatedStore = new StateStore(templated.paths, { now, resolveMachineTimeZone: () => timeZone });
      expect(templatedReads).toBe(beforeOpen);
      const templatedSnapshot = snapshot(templated.paths.database);
      templatedStore.close();

      expect(templatedReads).toBe(realReads);
      expect(templatedSnapshot).toEqual(realSnapshot);
    } finally {
      await Promise.all([real.home, templated.home].map(async (home) => rm(home, { force: true, recursive: true })));
    }
  });

  test("refuses to overlay an existing database file", async () => {
    const { home, paths } = await freshRoot();
    try {
      await writeFile(paths.database, "not a template", { mode: 0o600 });
      await expect(provisionMigratedStateTemplate(paths, { resolveMachineTimeZone: () => timeZone }))
        .rejects.toThrow("requires an absent database");
      expect(await Bun.file(paths.database).text()).toBe("not a template");
    } finally {
      await rm(home, { force: true, recursive: true });
    }
  });
});
