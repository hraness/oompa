import { Database } from "bun:sqlite";
import { chmodSync, constants, copyFileSync, existsSync, lstatSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import { initializeStatePaths, resolveStatePaths, type StatePaths } from "../../src/storage/paths";
import { type MachineTimeZoneResolver, StateStore } from "../../src/storage/state-store";

// Test-only. A fresh control-plane store replays the complete append-only
// migration chain, which dominates the wall time of suites that open one
// store per test. This helper migrates an empty database once per test
// process, closes it, checkpoints its WAL, and copies the resulting current-
// schema file into each opted-in test root before the test opens its own
// store. Production code never imports it and no migration changes.
//
// The template is not evidence about migrations. Tests that inspect the
// migration ledger, the schema version stamp, cohort classification, schema
// refusal on reopen, or first-open behaviour must open an empty file and run
// the real chain. Historical fixtures (canonical and released archives) write
// their own database bytes first; this helper refuses an existing file so it
// can never overlay one of them.

export type MigratedStateTemplateOptions = Readonly<{
  /** The clock the test passes to its `StateStore`. */
  now?: () => number;
  /** The resolver the test passes to its `StateStore`; the template is keyed by its value. */
  resolveMachineTimeZone?: MachineTimeZoneResolver;
}>;

type MigratedStateTemplate = Readonly<{
  /** The checkpointed current-schema database file. */
  database: string;
  /** Clock reads the real migration chain consumed while building this template. */
  clockReads: number;
}>;

// Mirrors the storage suite's default counter clock so that suite's default
// fixture sees byte-identical migrated rows on both paths.
const TEMPLATE_CLOCK_START = 1_000;
const TEMPLATE_DIRECTORY_PREFIX = "oompa-migrated-state-template-";

const walCheckpointSchema = z.object({
  busy: z.literal(0),
  log: z.literal(0),
  checkpointed: z.literal(0),
}).strict();

// The same resolution `StateStore` applies when a caller passes no resolver.
const machineTimeZone: MachineTimeZoneResolver = () => {
  const timeZone: unknown = new Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (typeof timeZone !== "string" || timeZone.length === 0) {
    throw new Error("MACHINE_TIME_ZONE_UNAVAILABLE");
  }
  return timeZone;
};

const templates = new Map<string, Promise<MigratedStateTemplate>>();

async function buildMigratedStateTemplate(timeZone: string): Promise<MigratedStateTemplate> {
  // The state paths require a canonical root; the platform temp directory may be a symbolic link.
  const directory = realpathSync(mkdtempSync(join(tmpdir(), TEMPLATE_DIRECTORY_PREFIX)));
  process.once("exit", () => { rmSync(directory, { force: true, recursive: true }); });
  const paths = resolveStatePaths({ rootDirectory: join(directory, "state") });
  await initializeStatePaths(paths);
  let clockReads = 0;
  const store = new StateStore(paths, {
    now: () => TEMPLATE_CLOCK_START + clockReads++,
    resolveMachineTimeZone: () => timeZone,
  });
  store.close();
  // The store's close does not finalize its cached statements immediately, so
  // its pages can remain in the WAL. Move every page into the database file
  // through a separate connection before the file is treated as a template.
  const database = new Database(paths.database);
  try {
    walCheckpointSchema.parse(database.query("PRAGMA wal_checkpoint(TRUNCATE)").get());
  } finally {
    database.close(true);
  }
  // A truncating checkpoint leaves the WAL empty, and SQLite may remove the
  // -wal and -shm files once the last connection closes (it does on Linux).
  // Only the main database file is the template; each opened copy recreates
  // its own sidecars.
  const wal = `${paths.database}-wal`;
  if (existsSync(wal) && lstatSync(wal).size !== 0) {
    throw new Error("The migrated state template still has WAL frames after its checkpoint.");
  }
  return { database: paths.database, clockReads };
}

/**
 * Copies the current-schema template into `paths.database` (which must not
 * exist yet) and replays, on the caller's clock, the exact number of reads
 * the real migration chain consumed. A counter clock therefore observes the
 * same sequence after open as it would on the real path.
 */
export async function provisionMigratedStateTemplate(
  paths: StatePaths,
  options: MigratedStateTemplateOptions = {},
): Promise<void> {
  if (existsSync(paths.database)) {
    throw new Error("The migrated state template requires an absent database; historical fixtures keep the real migration path.");
  }
  const timeZone = (options.resolveMachineTimeZone ?? machineTimeZone)();
  let template = templates.get(timeZone);
  if (template === undefined) {
    template = buildMigratedStateTemplate(timeZone);
    templates.set(timeZone, template);
    template.catch(() => { templates.delete(timeZone); });
  }
  const { database, clockReads } = await template;
  copyFileSync(database, paths.database, constants.COPYFILE_EXCL);
  chmodSync(paths.database, 0o600);
  for (let read = 0; read < clockReads; read += 1) options.now?.();
}
