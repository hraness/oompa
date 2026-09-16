import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import { canonical39DevinDatabaseBytes, canonical39DevinFixture, canonical39DevinGeneratorSource } from "../../scripts/fixtures/canonical39-devin";
import { reviewedRuntimeProfileV1Schema } from "../domain/runtime-profile";
import { readHistoricalRuntimeProfileAuthorityRows } from "./historical-runtime-profile-authority";
import { initializeStatePaths, resolveStatePaths } from "./paths";
import { StateStore } from "./state-store";

const archived = canonical39DevinFixture;
const subject = archived.cases[0];
const sibling = archived.cases[1];
const migratedAt = 60_000;
const highGeneration = 41;
const rowSchema = z.record(z.string(), z.unknown());
const hash = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
const quote = (value: string): string => `"${value.replaceAll('"', '""')}"`;

function snapshot(database: Database) {
  const tables = z.object({ name: z.string() }).strict().array().parse(
    database.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all(),
  );
  const rows = Object.fromEntries(tables.map(({ name }) => {
    const columns = z.object({ name: z.string() }).array().parse(database.query(`PRAGMA table_info(${quote(name)})`).all());
    const projection = columns.map(({ name: column }, index) => `typeof(${quote(column)}) AS t${index},
      CASE WHEN typeof(${quote(column)}) IN ('text','blob') THEN hex(CAST(${quote(column)} AS BLOB))
      ELSE ${quote(column)} END AS v${index}`).join(",");
    const values = database.query(`SELECT ${projection} FROM ${quote(name)}`).all().map((row) => JSON.stringify(row)).sort();
    return [name, hash(JSON.stringify(values))];
  }));
  return {
    rows,
    schema: database.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all(),
    version: database.query("PRAGMA user_version").get(),
    ledger: database.query("SELECT version,applied_at FROM migrations ORDER BY version").all(),
    foreignKeys: database.query("PRAGMA foreign_key_check").all(),
  };
}

const rawRuntime = (database: Database) => rowSchema.array().parse(database.query(`SELECT
  session_id,revision,source_kind,source_id,profile_id,process_generation,observed_at,
  typeof(profile_json) AS storage_type,hex(CAST(profile_json AS BLOB)) AS raw_hex,recorded_at
  FROM session_runtime_profiles ORDER BY session_id,revision`).all());

function claudeProfile() {
  return reviewedRuntimeProfileV1Schema.parse({ profileId: subject.profile.id, processGeneration: highGeneration,
    observedAt: archived.fixedTime, preset: "fable-max", model: "claude-fable-5-1", reasoningEffort: "max",
    claudeVersion: "2.1.260", permissionMode: "default", configHome: "isolated",
    outputFormat: "stream-json", inputFormat: "stream-json" });
}

const variants = ["fallback_unavailable", "fallback_armed", "duplicate_key", "invalid_utf8",
  "generation_mismatch", "observation_mismatch", "profile_mismatch"] as const;
type Variant = (typeof variants)[number];
function corruption(variant: Variant) {
  const profile = claudeProfile();
  let json = JSON.stringify(profile);
  let generation = highGeneration;
  let observedAt = archived.fixedTime;
  if (variant === "fallback_unavailable" || variant === "fallback_armed") {
    const nativeFallback = variant === "fallback_unavailable"
      ? { model: "claude-opus-5", reason: "live_acceptance_required", status: "unavailable" }
      : { evidenceDigest: "a".repeat(64), model: "claude-opus-5", status: "armed" };
    // A later frozen codec accepts these shapes. That cannot widen canonical39
    // provenance or make the synthetic high generation historical authority.
    const later = reviewedRuntimeProfileV1Schema.parse({ ...profile, nativeFallback });
    json = JSON.stringify(later);
  } else if (variant === "duplicate_key") {
    json = '{"processGeneration":0,' + json.slice(1);
    expect(JSON.parse(json)).toEqual(profile);
  } else if (variant === "generation_mismatch") generation += 1;
  else if (variant === "observation_mismatch") observedAt += 1;
  else if (variant === "profile_mismatch") json = JSON.stringify({ ...profile, profileId: sibling.profile.id });
  const bytes = variant === "invalid_utf8"
    ? Buffer.concat([Buffer.from('{"model":"'), Buffer.from([255]), Buffer.from('",' + json.slice(1))])
    : Buffer.from(json);
  if (variant === "invalid_utf8") {
    // A permissive decoder plus last-key JSON parsing recovers an otherwise
    // accepted profile; only the original-byte boundary makes this opaque.
    expect(JSON.parse(new TextDecoder().decode(bytes))).toEqual(profile);
    expect(() => new TextDecoder("utf-8", { fatal: true }).decode(bytes)).toThrow();
  }
  expect(reviewedRuntimeProfileV1Schema.safeParse(JSON.parse(new TextDecoder().decode(bytes))).success).toBe(true);
  return { bytes, generation, observedAt };
}

async function fixture(run: (database: Database, paths: ReturnType<typeof resolveStatePaths>) => void | Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "oompa-historical-runtime-migration-")));
  let database: Database | undefined;
  try {
    const bytes = canonical39DevinDatabaseBytes();
    expect(archived.sourceCommit).toBe("5f2735191640037c86d9949bc1d7f04b2ef09ffe");
    expect(archived.schemaVersion).toBe(39);
    expect(hash(bytes)).toBe(archived.databaseSha256);
    expect(bytes.byteLength).toBe(archived.databaseBytes);
    expect(hash(canonical39DevinGeneratorSource)).toBe(archived.generatorSha256);
    const paths = resolveStatePaths({ rootDirectory: root });
    await initializeStatePaths(paths);
    await writeFile(paths.database, bytes, { mode: 0o600, flag: "wx" });
    database = new Database(paths.database, { create: false, strict: true });
    database.exec("PRAGMA foreign_keys=ON");
    expect(database.query("PRAGMA user_version").get()).toEqual({ user_version: 39 });
    expect(database.query("SELECT name FROM sqlite_master WHERE name IN ('provider_accounts','runtime_profile_provider_authorities')").all()).toEqual([]);
    expect(rawRuntime(database)).toHaveLength(2);
    for (const source of archived.cases) {
      expect(rawRuntime(database).find((row) => row.session_id === source.session.id)).toMatchObject({
        revision: source.runtime.revision, process_generation: source.generation,
        raw_hex: Buffer.from(JSON.stringify(source.runtimeProfile)).toString("hex").toUpperCase(), storage_type: "text",
      });
    }
    await run(database, paths);
  } finally { database?.close(false); await rm(root, { recursive: true, force: true }); }
}

function assertOriginalGenerations(store: StateStore): void {
  for (const source of archived.cases) {
    expect(store.requireProfileById(source.profile.id).processGeneration).toBe(source.generation);
    expect(store.requireProviderAccountAuthority(source.profile.id, "codex").processGeneration).toBe(source.generation);
    expect(store.requireProviderAccountAuthority(source.profile.id, "claude").processGeneration).toBe(0);
    // Independent original login evidence still proves the retired generation;
    // opacity must not erase it or turn it into authority for another provider.
    expect(store.requireProviderAccountAuthority(source.profile.id, "devin").processGeneration).toBe(source.generation);
  }
}

test("authentic canonical39 runtime rows remain a positive migration authority control", async () => {
  await fixture((database, paths) => {
    const originalRuntime = rawRuntime(database);
    const ledger = snapshot(database).ledger;
    const store = new StateStore(paths, { now: () => migratedAt, resolveMachineTimeZone: () => "UTC" });
    try {
      assertOriginalGenerations(store);
      for (const source of archived.cases) {
        expect(store.latestSessionRuntimeProfile(source.session.id)?.profile).toEqual(source.runtimeProfile);
        expect(store.requireCapturedSessionProviderAuthority(source.session.id)).toMatchObject({
          provider: "devin", profileId: source.profile.id, processGeneration: source.generation,
        });
        expect(database.query("SELECT provider,process_generation,provenance FROM runtime_profile_provider_authorities WHERE session_id=? AND revision=?")
          .get(source.session.id, source.runtime.revision)).toEqual({
          provider: "devin", process_generation: source.generation, provenance: "legacy_runtime_profile",
        });
      }
      expect(rawRuntime(database)).toEqual(originalRuntime);
      expect(database.query("SELECT version,applied_at FROM migrations WHERE version<=39 ORDER BY version").all()).toEqual(ledger);
    } finally { store.close(); }
  });
});

for (const variant of variants) test(`canonical39 migration retains opaque ${variant} runtime bytes without new authority`, async () => {
  await fixture(async (database, paths) => {
    const original = snapshot(database);
    const originalRuntime = rawRuntime(database);
    const replacement = corruption(variant);
    const guard = z.object({ sql: z.string() }).strict().parse(database.query(
      "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='session_runtime_profiles_immutable_update'",
    ).get());
    // Only this existing archived row is adversarially changed. No historical
    // row is inserted, source stamp rewritten, or current schema downgraded.
    database.transaction(() => {
      database.exec("DROP TRIGGER session_runtime_profiles_immutable_update");
      try {
        expect(database.query(`UPDATE session_runtime_profiles SET profile_json=CAST(? AS TEXT),process_generation=?,observed_at=?
          WHERE session_id=? AND revision=?`).run(replacement.bytes, replacement.generation, replacement.observedAt,
          subject.session.id, subject.runtime.revision).changes).toBe(1);
      } finally { database.exec(guard.sql); }
    }).immediate();
    const corrupted = snapshot(database);
    const expectedRuntime = originalRuntime.map((row) => row.session_id === subject.session.id
      ? { ...row, process_generation: replacement.generation, observed_at: replacement.observedAt,
          raw_hex: replacement.bytes.toString("hex").toUpperCase() } : row);
    expect(rawRuntime(database)).toEqual(expectedRuntime);
    const corruptedRuntimeHash = corrupted.rows.session_runtime_profiles;
    if (corruptedRuntimeHash === undefined) throw new Error("Missing corrupted runtime table snapshot.");
    expect(corrupted).toEqual({ ...original, rows: { ...original.rows,
      session_runtime_profiles: corruptedRuntimeHash } });
    expect(() => database.query("UPDATE session_runtime_profiles SET profile_json=profile_json WHERE session_id=?")
      .run(subject.session.id)).toThrow("session runtime profile is immutable");
    const selected = database.transaction(() => [...readHistoricalRuntimeProfileAuthorityRows(database, "canonical40_v1")]).deferred();
    expect(selected.find((row) => row.sessionId === subject.session.id)).toEqual({
      sessionId: subject.session.id, revision: subject.runtime.revision, kind: "opaque",
    });
    expect(selected.find((row) => row.sessionId === sibling.session.id)?.kind).toBe("parsed");
    expect(snapshot(database)).toEqual(corrupted);
    const beforeReadonly = hash(await readFile(paths.database));
    expect(() => new StateStore(paths, { readonly: true })).toThrow("STATE_SCHEMA_MIGRATION_REQUIRED:39:61");
    expect(snapshot(database)).toEqual(corrupted);
    expect(hash(await readFile(paths.database))).toBe(beforeReadonly);

    const assertOpaque = (store: StateStore): void => {
      assertOriginalGenerations(store);
      expect(rawRuntime(database)).toEqual(expectedRuntime);
      expect(database.query("SELECT version,applied_at FROM migrations WHERE version<=39 ORDER BY version").all()).toEqual(original.ledger);
      expect(database.query("SELECT * FROM runtime_profile_provider_authorities WHERE session_id=?").all(subject.session.id)).toEqual([]);
      expect(database.query("SELECT * FROM session_provider_authorities WHERE session_id=?").all(subject.session.id)).toEqual([]);
      expect(database.query(`SELECT scope_kind,scope_id,reason FROM legacy_provider_authority_quarantines
        WHERE (scope_kind='runtime_profile' AND scope_id=?) OR (scope_kind='session' AND scope_id=?) ORDER BY scope_kind`)
        .all(`${subject.session.id}:${subject.runtime.revision}`, subject.session.id)).toEqual([
        { scope_kind: "runtime_profile", scope_id: `${subject.session.id}:${subject.runtime.revision}`, reason: "missing_immutable_runtime_authority" },
        { scope_kind: "session", scope_id: subject.session.id, reason: "missing_immutable_runtime_authority" },
      ]);
      expect(store.latestSessionRuntimeProfile(sibling.session.id)?.profile).toEqual(sibling.runtimeProfile);
      expect(store.requireCapturedSessionProviderAuthority(sibling.session.id)).toMatchObject({ provider: "devin", processGeneration: sibling.generation });
    };
    const upgraded = new StateStore(paths, { now: () => migratedAt, resolveMachineTimeZone: () => "UTC" });
    try { assertOpaque(upgraded); } finally { upgraded.close(); }
    const joined = snapshot(database);
    expect(joined.version).toEqual({ user_version: 61 });
    expect(joined.foreignKeys).toEqual([]);
    for (const readonly of [false, true]) {
      const beforeBytes = hash(await readFile(paths.database));
      const reopened = new StateStore(paths, { readonly, now: () => migratedAt + 1, resolveMachineTimeZone: () => "UTC" });
      try { assertOpaque(reopened); expect(snapshot(database)).toEqual(joined); }
      finally { reopened.close(); }
      expect(snapshot(database)).toEqual(joined);
      if (readonly) expect(hash(await readFile(paths.database))).toBe(beforeBytes);
    }
  });
});
