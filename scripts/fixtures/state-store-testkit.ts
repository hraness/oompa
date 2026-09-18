import { expect } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdtemp, mkdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { z } from "zod";
import { canonical40QueuesDatabaseBytes } from "./canonical40-queues";
import { canonical40UsageDatabaseBytes, canonical40UsageFixture } from "./canonical40-usage";
import { canonical41TimestampsDatabaseBytes, canonical41TimestampsFixture } from "./canonical41-timestamps";
import { canonical48WorkDatabaseBytes, canonical48WorkFixture } from "./canonical48-work";
import { canonicalLoginLedgerDatabaseBytes, canonicalLoginLedgerFixtures } from "./canonical-login-ledger";
import { canonicalBudgetDatabaseBytes, canonicalBudgetFixtures } from "./canonical-budget-history";
import { canonicalAuthBudgetDatabaseBytes, canonicalAuthBudgetFixtures } from "./canonical-auth-budget";
import { canonical30WorkDatabaseBytes } from "./canonical30-work";
import { canonical34StorageDatabaseBytes } from "./canonical34-storage";
import { canonicalIdentityAttentionDatabaseBytes, canonicalIdentityAttentionFixtures, type CanonicalIdentityAttentionScenario } from "./canonical-identity-attention";
import { canonical35To38DatabaseBytes, canonical35To38Fixture, type Canonical35To38Scenario } from "./canonical35-38";
import { canonical38RuntimeDatabaseBytes, canonical38RuntimeFixture } from "./canonical38-runtime";
import { canonical20To40DatabaseBytes, canonical20To40Fixture, type Canonical20To40Scenario } from "./canonical20-40";
import { canonicalAdoption35DatabaseBytes, canonicalAdoption35Fixture } from "./canonical-adoption35";
import { installSyntheticAdoption36Fixture, syntheticAdoption36 } from "./synthetic-adoption36";
import { canonicalEarlyMigrationDatabaseBytes } from "./canonical-early-migration";
import { canonicalResetPolicyDatabaseBytes } from "./canonical-reset-policy";
import { canonicalLabelPresetDatabaseBytes, canonicalLabelPresetFixture, type CanonicalLabelPresetScenario } from "./canonical-label-preset";
import { combined49RetiredDatabaseBytes } from "./combined49-retired";
import { combined49SwitchDatabaseBytes, combined49SwitchFixture } from "./combined49-switch";
import { canonical39DevinDatabaseBytes } from "./canonical39-devin";
import { canonical39RetiredDatabaseBytes, type Canonical39RetiredKind } from "./canonical39-retired-effects";
import { retiredSuccessorDatabaseBytes } from "./retired-successors";
import { provisionMigratedStateTemplate } from "./migrated-state-template";
import { activePresetBinding, currentPresetContract, presetRequirements } from "../../src/domain/presets";
import { createPortableProjectMemoryCanonicalIdentity } from "../../src/domain/project-memory";
import { canonicalProviderUsageJson, createClaudeAccountingUsageComponent, createClaudeQuotaUsageComponent, providerUsageDigest, usageProviderAccountAuthoritySchema, type ClaudeProviderUsageAccountingComponent, type ClaudeProviderUsageQuotaComponent, type ProviderUsageComponent } from "../../src/domain/provider-usage";
import { createStoredAccountUsageSnapshot, storedAccountUsageSnapshotSchema, type StoredAccountUsageSnapshot } from "../../src/domain/usage-metrics";
import type { ProfileId, ProjectId } from "../../src/domain/values";
import { providerAccountAuthoritySchema } from "../../src/domain/provider-accounts";
import type { QueueState } from "../../src/domain/transitions";
import { projectPublicProviderIdentifier } from "../../src/public-provider-identifier";
import { effectiveClaudeRuntimeProfileSchema, effectiveRuntimeProfileSchema } from "../../src/domain/runtime-profile";
import { initializeStatePaths, resolveStatePaths } from "../../src/storage/paths";
import { PEER_SESSION_ACTION_RETAIN_AGE_MS, sessionStartMutationRequest, StateStore, type MachineTimeZoneResolver, type ProjectMemoryHeadRef, type SecurityScrubCheckpointPolicy, type SessionRecord } from "../../src/storage/state-store";
import { deriveLegacySessionProfileKey } from "../../src/storage/canonical-profile-storage";

export const stores: StateStore[] = [];

export const expectHistoricalValue = (actual: unknown, expected: unknown): void => {
  expect(actual).toEqual(expected);
};

export const privateUserPathRoot = ["", "Users", "private"].join("/");

export const publicProviderIdentifierKey = new Uint8Array(32).fill(19);

export const publicProviderIdentifier = (value: string) =>
  projectPublicProviderIdentifier(value, publicProviderIdentifierKey);

export const testProviderAccountKey = (provider: "codex" | "claude"): string =>
  `v1:${provider}:${createHash("sha256").update(`test-${provider}-account`).digest("hex")}`;

export const namedProviderAccountKey = (
  provider: "codex" | "claude",
  name: string,
): string => `v1:${provider}:${createHash("sha256").update(name).digest("hex")}`;

export const providerAccountKeyForProfile = (
  store: StateStore,
  profileId: string,
  provider: "codex" | "claude",
): string => {
  if (provider === "claude") return testProviderAccountKey("claude");
  const email = store.requireProfileById(profileId).providerEmail;
  if (email === undefined) throw new Error("Expected identifiable Codex profile authority.");
  return namedProviderAccountKey("codex", email.trim().toLowerCase());
};

export const capturedProviderAuthorityForTest = (store: StateStore, sessionId: string) => {
  const captured = store.requireCapturedSessionProviderAuthority(sessionId);
  return providerAccountAuthoritySchema.parse({
    providerAccountId: captured.providerAccountId,
    profileId: captured.profileId,
    provider: captured.provider,
    bindingGeneration: captured.bindingGeneration,
    processGeneration: captured.processGeneration,
  });
};

export type ProviderSessionInput = Parameters<StateStore["upsertProviderSession"]>[0];

export type ProvenProviderSessionInput = Omit<ProviderSessionInput, "provider" | "providerAuthority" | "providerAccountKey" | "title"> &
  Partial<Pick<ProviderSessionInput, "provider" | "providerAuthority" | "providerAccountKey" | "title">>;

export const upsertProvenTestSession = (
  store: StateStore,
  input: ProvenProviderSessionInput,
) => {
  const provider = input.provider ?? "codex";
  return store.upsertProviderSession({
    ...input,
    provider,
    providerAuthority: input.providerAuthority ?? store.requireProviderAccountAuthority(input.profileId, provider),
    title: input.title ?? "Untitled session",
    ...(provider === "devin"
      ? (input.providerAccountKey === undefined
          ? {}
          : { providerAccountKey: input.providerAccountKey })
      : {
          providerAccountKey: input.providerAccountKey
            ?? providerAccountKeyForProfile(store, input.profileId, provider),
        }),
  });
};

export let provenTestSessionSequence = 0;

export type CreateProvenTestSessionInput =
  & Omit<ProvenProviderSessionInput, "provider" | "providerThreadId" | "providerAccountKey" | "state" | "title">
  & Partial<Pick<
    ProviderSessionInput,
    "provider" | "providerThreadId" | "providerAccountKey" | "state" | "title"
  >>;

export const createProvenTestSession = (
  store: StateStore,
  input: CreateProvenTestSessionInput,
) => {
  const { providerThreadId, state, ...rest } = input;
  provenTestSessionSequence += 1;
  return upsertProvenTestSession(store, {
    ...rest,
    providerThreadId: providerThreadId ?? `test-provider-thread-${provenTestSessionSequence}`,
    state: state ?? "idle",
  });
};

export type CreateSessionInput = Parameters<StateStore["createSession"]>[0];

export const createAuthorizedStartingTestSession = (
  store: StateStore,
  input: CreateSessionInput,
) => {
  const session = store.createSession(input);
  const provider = input.provider ?? "codex";
  if (provider !== "devin") {
    store.bindSessionProviderAccountAuthority({
      sessionId: session.id,
      provider,
      runtimeScope: "managed",
      accountKey: providerAccountKeyForProfile(store, session.profileId, provider),
    });
  }
  return session;
};

export const createRevocationWorkStore = (store: StateStore, generation = 1) =>
  store.createWorkStore(
    generation,
    () => "unused-revocation-cursor",
    {
      issue: () => `hrac1_${"A".repeat(43)}`,
      verify: () => true,
    },
  );

export const completeCodexRuntimeAccountAuthorityRetirement = (
  store: StateStore,
  profileId: string,
  profileGeneration: number,
  runtimeScope: "personal" | "managed",
): void => {
  const workStore = createRevocationWorkStore(store);
  const begun = store.beginProviderRuntimeAccountRevocation({
    profileId,
    expectedGeneration: profileGeneration,
    provider: "codex",
    runtimeScope,
    currentAccountKey: null,
    workStore,
  });
  store.completeProviderRuntimeAccountRevocation({
    profileId,
    expectedGeneration: profileGeneration,
    provider: "codex",
    runtimeScope,
    expectedRevision: begun.revocation.revision,
  });
};

export const completeCodexAccountMutationAuthorityRetirement = (
  store: StateStore,
  profileId: string,
  profileGeneration: number,
): void => {
  for (const runtimeScope of ["personal", "managed"] as const) {
    completeCodexRuntimeAccountAuthorityRetirement(
      store,
      profileId,
      profileGeneration,
      runtimeScope,
    );
  }
};

export const ownedStateStoreCaseDrains: Array<() => Promise<void>> = [];

export function ownedStateStoreCase(
  runCase: (context: Readonly<{
    request: <T>(operation: () => Promise<T>) => Promise<T>;
  }>) => Promise<void>,
  drains = ownedStateStoreCaseDrains,
): Promise<void> {
  const controller = new AbortController();
  const cancellation = new Error("Owned StateStore case is closing.");
  // The owner is registered synchronously before deferred fixture setup or the
  // raw callback can run. Bun's test timeout still owns the test outcome.
  const caseTask = Promise.resolve().then(async () => {
    controller.signal.throwIfAborted();
    await runCase({
      request: async <T>(operation: () => Promise<T>): Promise<T> => {
        controller.signal.throwIfAborted();
        const result = await operation();
        controller.signal.throwIfAborted();
        return result;
      },
    });
    controller.signal.throwIfAborted();
  });
  // Observe rejection immediately and join this raw task, never a promise
  // whose finally callback would wait for its own teardown to complete.
  const settled = caseTask.then(
    () => ({ status: "fulfilled" } as const),
    (reason: unknown) => ({ status: "rejected", reason } as const),
  );
  drains.push(async () => {
    controller.abort(cancellation);
    const result = await settled;
    // Only our exact cooperative cancellation is cleanup, not a late storage
    // failure (including one thrown by an operation after abort was requested).
    if (result.status === "rejected" && result.reason !== cancellation) {
      return Promise.reject(result.reason);
    }
  });
  return caseTask;
}

export async function drainStateStoreCasesAndClose(
  drains: Array<() => Promise<void>>,
  takeStores: () => readonly Readonly<{ close: () => void }>[],
): Promise<void> {
  const settled = await Promise.allSettled(drains.splice(0).map(async (drain) => await drain()));
  const failures: unknown[] = [];
  for (const result of settled) {
    if (result.status === "rejected") failures.push(result.reason);
  }
  // A draining fixture may still open or reopen a store. Take the close list
  // only after every raw task settles, and attempt every close despite errors.
  for (const store of takeStores()) {
    try {
      store.close();
    } catch (error: unknown) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, "Owned StateStore teardown failed.");
}

export async function fixture(
  options: Readonly<{
    now?: () => number;
    resolveMachineTimeZone?: MachineTimeZoneResolver;
    securityScrubCheckpoint?: SecurityScrubCheckpointPolicy;
    /**
     * `template`, this file's default, copies the process-wide migrated
     * template before the open so the store starts at the current schema
     * without replaying the migration chain. `migrate` opens an empty file
     * and runs the real chain; a test that inspects the migration ledger, the
     * schema version stamp, cohort classification, schema refusal on reopen,
     * or first-open behaviour chooses it explicitly.
     */
    provision?: "template" | "migrate";
  }> = {},
): Promise<{ store: StateStore; home: string }> {
  const home = await realpath(await mkdtemp(join(tmpdir(), "oompa-store-")));
  const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
  await initializeStatePaths(paths);
  const { provision = "template", ...storeOptions } = options;
  const now = storeOptions.now ?? (() => { let value = 1_000; return () => value++; })();
  const resolveMachineTimeZone = storeOptions.resolveMachineTimeZone ?? (() => "America/Puerto_Rico");
  if (provision === "template") {
    await provisionMigratedStateTemplate(paths, { now, resolveMachineTimeZone });
  }
  const store = new StateStore(paths, { ...storeOptions, now, resolveMachineTimeZone });
  stores.push(store);
  return { store, home };
}

export async function canonical40QueueArchive() {
  const home = await realpath(await mkdtemp(join(tmpdir(), "oompa-store-canonical40-")));
  const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
  await initializeStatePaths(paths);
  await writeFile(paths.database, canonical40QueuesDatabaseBytes(), { mode: 0o600 });
  return paths;
}

export async function canonical34StorageArchive() {
  const home = await realpath(await mkdtemp(join(tmpdir(), "oompa-store-canonical34-storage-")));
  const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
  await initializeStatePaths(paths);
  await writeFile(paths.database, canonical34StorageDatabaseBytes(), { mode: 0o600, flag: "wx" });
  return paths;
}

export async function syntheticAdoption36ContractFixture(scenario: "launch" | "quarantine") {
  const home = await realpath(await mkdtemp(join(tmpdir(), "oompa-synthetic-adoption36-")));
  const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
  await initializeStatePaths(paths);
  const database = new Database(paths.database, { create: true, strict: true });
  try {
    // Batch only fixture construction; the tested v36 migration remains a
    // separate real first open. Foreign keys must be enabled before BEGIN.
    database.exec("PRAGMA foreign_keys=ON");
    database.transaction(() => installSyntheticAdoption36Fixture(database, scenario)).immediate();
  }
  finally { database.close(false); }
  await chmod(paths.database, 0o600);
  return paths;
}

export const syntheticAdoption36MaintenanceTables = new Set([
  "session_autorespond_counters", "session_event_streams", "usage_revision_authority", "sqlite_sequence",
]);

export function expectSyntheticAdoption36Maintenance(
  database: Database,
  before: { readonly rows: Readonly<Record<string, unknown>> },
  sessionIds: readonly string[],
  profileIds: readonly string[],
): void {
  const source = syntheticAdoption36;
  for (const table of ["session_autorespond_counters", "session_event_streams", "sqlite_sequence"]) {
    expect(before.rows[table]).toEqual([]);
  }
  expect(before.rows.usage_revision_authority)
    .toEqual(profileIds.map((profile_id) => ({ profile_id, next_revision: 0 })));
  // v9/v10 fill missing local stream bookkeeping and advance the unused
  // allocator floor. A fresh opaque stream epoch is not provider evidence.
  const streams = z.array(z.object({
    session_id: z.string(), stream_epoch: z.string().uuid(), next_sequence: z.number(),
    floor_sequence: z.number(), observed_through_sequence: z.number(), retained_count: z.number(),
    retained_bytes: z.number(), retention_gap_reason: z.string().nullable(),
    created_at: z.number(), updated_at: z.number(),
  }).strict()).parse(database.query("SELECT * FROM session_event_streams ORDER BY session_id").all());
  expect(new Set(streams.map(({ stream_epoch }) => stream_epoch)).size).toBe(sessionIds.length);
  expect(streams.map((stream) => Object.fromEntries(Object.entries(stream)
    .filter(([key]) => key !== "stream_epoch")))).toEqual(sessionIds.map((session_id) => ({
    session_id, next_sequence: 1, floor_sequence: 1, observed_through_sequence: 0,
    retained_count: 0, retained_bytes: 0, retention_gap_reason: null,
    created_at: source.migratedAt, updated_at: source.migratedAt,
  })));
  expect(database.query("SELECT * FROM usage_revision_authority ORDER BY profile_id").all())
    .toEqual(profileIds.map((profile_id) => ({ profile_id, next_revision: 1 })));
  // Canonical44 imposes the conservative consecutive floor on every older
  // session; its empty evidence-table rebuild creates SQLite's zero sequence.
  expect(database.query("SELECT * FROM session_autorespond_counters ORDER BY session_id").all())
    .toEqual(sessionIds.map((session_id) => ({ session_id, consecutive_count: 3, updated_at: source.migratedAt })));
  expect(database.query("SELECT * FROM sqlite_sequence").all()).toEqual([{ name: "autorespond_evidence", seq: 0 }]);
}

export async function canonicalEarlyMigrationArchive(version: 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17) {
  const home = await realpath(await mkdtemp(join(tmpdir(), `oompa-store-canonical-early-${version}-`)));
  const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
  await initializeStatePaths(paths);
  await writeFile(paths.database, canonicalEarlyMigrationDatabaseBytes(version), { mode: 0o600, flag: "wx" });
  return paths;
}

export async function canonical35To38Archive(scenario: Canonical35To38Scenario) {
  const home = await realpath(await mkdtemp(join(tmpdir(), "oompa-store-canonical35-38-")));
  const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
  await initializeStatePaths(paths);
  const bytes = canonical35To38DatabaseBytes(scenario);
  const captured = canonical35To38Fixture.captures[scenario];
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(captured.databaseSha256);
  await writeFile(paths.database, bytes, { mode: 0o600, flag: "wx" });
  const database = new Database(paths.database, { create: false, strict: true });
  try {
    database.exec("PRAGMA query_only=ON");
    database.transaction(() => {
      expect(database.query("PRAGMA user_version").get()).toEqual({ user_version: captured.schemaVersion });
      expect(database.query("SELECT * FROM migrations ORDER BY version").all()).toEqual([...captured.snapshot.ledger]);
      const schema = database.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all();
      expect(createHash("sha256").update(JSON.stringify(schema)).digest("hex")).toBe(captured.snapshot.schemaSha256);
      expect(database.query("PRAGMA foreign_key_check").all()).toEqual([]);
    }).deferred();
    expect(database.query("SELECT total_changes() AS count").get()).toEqual({ count: 0 });
  } finally { database.close(false); }
  return paths;
}

export function expectCanonical35To38InertReopens(paths: StateStore["paths"], database: Database) {
  const before = canonicalAuthBudgetSnapshot(database);
  for (const readonly of [false, true]) {
    const reopened = new StateStore(paths, { readonly,
      resolveMachineTimeZone: () => { throw new Error("CAPTURED_POLICY_REOPEN_MUST_NOT_RESOLVE_ZONE"); },
    });
    reopened.close();
    expect(canonicalAuthBudgetSnapshot(database)).toEqual(before);
  }
}

export async function canonicalAdoption35Archive() {
  const home = await realpath(await mkdtemp(join(tmpdir(), "oompa-store-adoption35-")));
  const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
  await initializeStatePaths(paths);
  const bytes = canonicalAdoption35DatabaseBytes();
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(canonicalAdoption35Fixture.databaseSha256);
  await writeFile(paths.database, bytes, { mode: 0o600, flag: "wx" });
  return paths;
}

export async function canonicalIdentityAttentionArchive(scenario: CanonicalIdentityAttentionScenario) {
  const home = await realpath(await mkdtemp(join(tmpdir(), "oompa-store-identity-attention-")));
  const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
  await initializeStatePaths(paths);
  const source = canonicalIdentityAttentionFixtures[scenario];
  const bytes = canonicalIdentityAttentionDatabaseBytes(scenario);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(source.databaseSha256);
  await writeFile(paths.database, bytes, { mode: 0o600, flag: "wx" });
  const database = new Database(paths.database, { create: false, strict: true });
  try {
    database.exec("PRAGMA query_only=ON");
    database.transaction(() => {
      expect(database.query("PRAGMA user_version").get()).toEqual({ user_version: source.source.version });
      expect(database.query("SELECT * FROM migrations ORDER BY version").all()).toEqual([...source.ledger]);
      const schema = database.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all();
      expect(createHash("sha256").update(JSON.stringify(schema)).digest("hex")).toBe(source.schemaSha256);
      for (const [table, count] of Object.entries(source.rowCounts)) {
        expect(table).toMatch(/^[a-z_0-9]+$/u);
        expect(database.query(`SELECT COUNT(*) AS count FROM "${table}"`).get()).toEqual({ count });
      }
      expect(database.query("PRAGMA foreign_key_check").all()).toEqual([]);
    }).deferred();
    expect(database.query("SELECT total_changes() AS count").get()).toEqual({ count: 0 });
  } finally { database.close(false); }
  return paths;
}

export async function canonical38RuntimeArchive() {
  const home = await realpath(await mkdtemp(join(tmpdir(), "oompa-store-canonical38-runtime-")));
  const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
  await initializeStatePaths(paths);
  const bytes = canonical38RuntimeDatabaseBytes();
  const captured = canonical38RuntimeFixture;
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(captured.databaseSha256);
  await writeFile(paths.database, bytes, { mode: 0o600, flag: "wx" });
  const database = new Database(paths.database, { create: false, strict: true });
  try {
    database.exec("PRAGMA query_only=ON");
    database.transaction(() => {
      expect(database.query("PRAGMA user_version").get()).toEqual({ user_version: 38 });
      expect(database.query("SELECT * FROM migrations ORDER BY version").all()).toEqual([...captured.snapshot.ledger]);
      const schema = database.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all();
      expect(createHash("sha256").update(JSON.stringify(schema)).digest("hex")).toBe(captured.snapshot.schemaSha256);
      expect(database.query("PRAGMA foreign_key_check").all()).toEqual([]);
    }).deferred();
    expect(database.query("SELECT total_changes() AS count").get()).toEqual({ count: 0 });
  } finally { database.close(false); }
  return paths;
}

export async function canonicalResetPolicyArchive(version: 27 | 28) {
  const home = await realpath(await mkdtemp(join(tmpdir(), `oompa-store-reset-policy-${version}-`)));
  const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
  await initializeStatePaths(paths);
  await writeFile(paths.database, canonicalResetPolicyDatabaseBytes(version), { mode: 0o600, flag: "wx" });
  return paths;
}

export async function canonicalLabelPresetArchive(scenario: CanonicalLabelPresetScenario) {
  const home = await realpath(await mkdtemp(join(tmpdir(), "oompa-store-canonical-label-preset-")));
  const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
  await initializeStatePaths(paths);
  const bytes = canonicalLabelPresetDatabaseBytes(scenario);
  const captured = canonicalLabelPresetFixture.captures[scenario];
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(captured.databaseSha256);
  await writeFile(paths.database, bytes, { mode: 0o600, flag: "wx" });
  const database = new Database(paths.database, { create: false, strict: true });
  try {
    database.exec("PRAGMA query_only=ON");
    expect(database.query("PRAGMA user_version").get()).toEqual({ user_version: captured.schemaVersion });
    expect(database.query("SELECT * FROM migrations ORDER BY version").all()).toEqual([...captured.ledger]);
    const schema = database.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all();
    expect(createHash("sha256").update(JSON.stringify(schema)).digest("hex")).toBe(captured.schemaSha256);
    expect(database.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(database.query("SELECT total_changes() AS count").get()).toEqual({ count: 0 });
  } finally { database.close(false); }
  return paths;
}

export async function canonical39DevinArchive() {
  const home = await realpath(await mkdtemp(join(tmpdir(), "oompa-store-canonical39-devin-")));
  const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
  await initializeStatePaths(paths);
  await writeFile(paths.database, canonical39DevinDatabaseBytes(), { mode: 0o600 });
  return paths;
}

export async function canonical39RetiredArchive(kind: Canonical39RetiredKind) {
  const home = await realpath(await mkdtemp(join(tmpdir(), "oompa-store-canonical39-retired-")));
  const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
  await initializeStatePaths(paths);
  await writeFile(paths.database, canonical39RetiredDatabaseBytes(kind), { mode: 0o600 });
  return paths;
}

export async function retiredSuccessorArchive(version: 41 | 42) {
  const home = await realpath(await mkdtemp(join(tmpdir(), "oompa-store-retired-successor-")));
  const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
  await initializeStatePaths(paths);
  await writeFile(paths.database, retiredSuccessorDatabaseBytes(version), { mode: 0o600 });
  return paths;
}

export async function canonicalBudgetArchive(version: 43 | 45) {
  const home = await realpath(await mkdtemp(join(tmpdir(), "oompa-store-canonical-budget-")));
  const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
  await initializeStatePaths(paths);
  const bytes = canonicalBudgetDatabaseBytes(version);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(canonicalBudgetFixtures[version].databaseSha256);
  await writeFile(paths.database, bytes, { mode: 0o600, flag: "wx" });
  return paths;
}

export async function canonicalAuthBudgetArchive(version: 44 | 45 | 46) {
  const home = await realpath(await mkdtemp(join(tmpdir(), "oompa-store-canonical-auth-budget-")));
  const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
  await initializeStatePaths(paths);
  const bytes = canonicalAuthBudgetDatabaseBytes(version);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(canonicalAuthBudgetFixtures[version].databaseSha256);
  await writeFile(paths.database, bytes, { mode: 0o600, flag: "wx" });
  return paths;
}

export async function canonical50LedgerArchive() {
  const home = await realpath(await mkdtemp(join(tmpdir(), "oompa-ledger-canonical50-")));
  const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
  await initializeStatePaths(paths);
  const bytes = canonicalLoginLedgerDatabaseBytes(50);
  expect(createHash("sha256").update(bytes).digest("hex"))
    .toBe(canonicalLoginLedgerFixtures[50].databaseSha256);
  await writeFile(paths.database, bytes, { mode: 0o600, flag: "wx" });
  return paths;
}

export async function canonical20To40Archive(scenario: Canonical20To40Scenario) {
  const home = await realpath(await mkdtemp(join(tmpdir(), "oompa-store-canonical20-40-")));
  const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
  await initializeStatePaths(paths);
  const bytes = canonical20To40DatabaseBytes(scenario);
  expect(createHash("sha256").update(bytes).digest("hex"))
    .toBe(canonical20To40Fixture.captures[scenario].databaseSha256);
  await writeFile(paths.database, bytes, { mode: 0o600, flag: "wx" });
  return paths;
}

export function canonicalAuthBudgetRows(database: Database, tables: readonly string[]) {
  const readers = tables.map((table) => {
    expect(table).toMatch(/^[A-Za-z_0-9]+$/u);
    const columns = z.array(z.object({ name: z.string().regex(/^[a-z_0-9]+$/u) })).parse(
      database.query(`PRAGMA table_info("${table}")`).all(),
    ).map(({ name }) => name);
    expect(columns.length).toBeGreaterThan(0);
    expect(columns.length).toBeLessThanOrEqual(64);
    const sql = `SELECT ${columns.map((column) => `"${column}"`).join(",")} FROM "${table}" LIMIT 4097`;
    return { table, sql };
  });
  const read = () => Object.fromEntries(readers.map(({ table, sql }) => {
    const statement = database.prepare(sql);
    try {
      const rows = statement.all().sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
      expect(rows.length).toBeLessThanOrEqual(4096);
      return [table, rows];
    } finally { statement.finalize(); }
  }));
  return { before: read(), read };
}

export function canonicalAuthBudgetSnapshot(database: Database) {
  const tables = z.array(z.object({ name: z.string().regex(/^[A-Za-z_0-9]+$/u) }).strict()).parse(
    database.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name LIMIT 257").all(),
  );
  expect(tables.length).toBeLessThanOrEqual(256);
  return {
    schema: database.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all(),
    version: database.query("PRAGMA user_version").get(),
    rows: canonicalAuthBudgetRows(database, tables.map(({ name }) => name)).before,
  };
}

export function canonicalAuthBudgetFrozenSchema(database: Database) {
  return database.query(`SELECT type,name,tbl_name,sql FROM sqlite_master
    WHERE tbl_name IN ('account_mutation_authority_rebinds','provider_login_authorities',
      'autorespond_budget_history','autorespond_budget_reservations','autorespond_evidence',
      'autorespond_after_hours_policy','autorespond_after_hours_history')
      OR name IN ('sessions_autorespond_budget_history','sessions_autorespond_after_hours_history')
    ORDER BY type,name`).all();
}

export function canonicalAuthBudgetPendingQuarantine(database: Database, migratedAt: number) {
  const pending = z.array(z.object({ id: z.string(), session_id: z.string() }).strict()).parse(
    database.query("SELECT id,session_id FROM queue_entries WHERE state='pending' ORDER BY id").all(),
  );
  expect(pending.length).toBeGreaterThan(0);
  const affected = new Set(pending.map((queue) => queue.session_id));
  const sessions = z.array(z.record(z.string(), z.unknown())).parse(database.query("SELECT * FROM sessions").all())
    .map((row) => {
      if (!affected.has(z.string().parse(row.id))) return row;
      expect(row.state).toBe("idle");
      expect(row.active_turn_id).toBeNull();
      return { ...row, state: "recovery_required", revision: z.number().parse(row.revision) + 1,
        updated_at: Math.max(z.number().parse(row.updated_at), migratedAt) };
    }).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return {
    sessions,
    assertInstalled(store: StateStore) {
      expect(database.query("SELECT * FROM queue_attachment_quarantines ORDER BY queue_id,ordinal").all())
        .toEqual(pending.map((queue) => ({ queue_id: queue.id, ordinal: 1, session_id: queue.session_id,
          kind: "quarantined", predecessor: null, expected_session_revision: null,
          reason: "legacy_identity_unproved", recorded_at: migratedAt })));
      expect(database.query("SELECT * FROM queue_attachment_identities").all()).toEqual([]);
      expect(database.query("SELECT * FROM queue_attachment_identity_anchors").all()).toEqual([]);
      // Old pending input stays readable, but an old receipt or retained
      // manifest is never promoted into a new sealed dispatch identity.
      const before = canonicalAuthBudgetSnapshot(database);
      for (const queue of pending) {
        expect(() => store.transitionQueue(queue.id, "pending", "dispatching")).toThrow();
      }
      expect(canonicalAuthBudgetSnapshot(database)).toEqual(before);
    },
  };
}

export function corruptCanonical43Rows(database: Database, tables: readonly string[], guards: readonly string[], change: () => void) {
  const schema = database.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all();
  const rows = z.array(z.object({ name: z.string().regex(/^[a-z_0-9]+$/u) }).strict()).parse(
    database.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all(),
  ).filter(({ name }) => !tables.includes(name)).map(({ name }) => ({ name, rows: database.query(`SELECT * FROM "${name}"`).all() }));
  expect(database.query("PRAGMA user_version").get()).toEqual({ user_version: 43 });
  database.transaction(() => withRemovedTestGuards(database, guards, change)).immediate();
  expect(database.query("PRAGMA user_version").get()).toEqual({ user_version: 43 });
  expect(database.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all()).toEqual(schema);
  for (const row of rows) expect(database.query(`SELECT * FROM "${row.name}"`).all()).toEqual(row.rows);
  expect(database.query("PRAGMA foreign_key_check").all()).toEqual([]);
}

export function expectCanonical43ReadonlyRefusal(paths: StateStore["paths"]) {
  const database = new Database(paths.database, { readonly: true, strict: true });
  const snapshot = () => ({
    schema: database.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all(),
    version: database.query("PRAGMA user_version").get(),
    rows: z.array(z.object({ name: z.string().regex(/^[a-z_0-9]+$/u) }).strict()).parse(
      database.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all(),
    ).map(({ name }) => ({ name, rows: database.query(`SELECT * FROM "${name}"`).all() })),
  });
  try {
    const before = snapshot();
    expect(() => new StateStore(paths, { readonly: true })).toThrow("STATE_SCHEMA_MIGRATION_REQUIRED:43:61");
    expect(snapshot()).toEqual(before);
  } finally { database.close(false); }
}

export function withRemovedTestGuards(database: Database, names: readonly string[], corrupt: () => void): void {
  const guards = names.map((name) => {
    if (!/^[a-z_0-9]+$/u.test(name)) throw new Error("Unsafe test guard name.");
    const guard = z.object({ sql: z.string() }).parse(database.query(
      "SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?",
    ).get(name));
    return { name, sql: guard.sql };
  });
  for (const guard of guards) database.exec(`DROP TRIGGER ${guard.name}`);
  try { corrupt(); } finally { for (const guard of guards) database.exec(guard.sql); }
}

export function expectInertSchemaRefusal(paths: StateStore["paths"], code: string, readonlyCode = code): void {
  const database = new Database(paths.database, { readonly: true, strict: true });
  try {
    const snapshot = () => ({
      version: database.query("PRAGMA user_version").get(),
      schema: database.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all(),
      tables: database.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((row) => {
        const { name } = z.object({ name: z.string() }).parse(row);
        return { name, rows: database.query(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all() };
      }),
    });
    const before = snapshot();
    for (const readonly of [true, false]) {
      expect(() => new StateStore(paths, { readonly })).toThrow(readonly ? readonlyCode : code);
      expect(snapshot()).toEqual(before);
    }
  } finally { database.close(false); }
}

export const withCanonicalSessionKey = (value: unknown): Record<string, unknown> => {
  const row = z.record(z.string(), z.unknown()).parse(value);
  const key = deriveLegacySessionProfileKey(row.provider_v39, row.preset, row.preset_contract);
  expect(key).not.toBeNull();
  return { ...row, canonical_profile_key: key };
};

export const dropProviderV39SessionColumn = (database: Database): readonly Readonly<{
  name: string;
  sql: string;
}>[] => {
  if (database.query(
    "SELECT 1 FROM pragma_table_info('sessions') WHERE name='provider_v39'",
  ).get() === null) return [];
  const triggers = z.object({
    name: z.string().regex(/^[a-z0-9_]+$/u),
    sql: z.string().min(1),
  }).strict().array().parse(database.query(
    `SELECT name,sql FROM sqlite_master
     WHERE type='trigger' AND sql LIKE '%provider_v39%'
     ORDER BY name`,
  ).all());
  for (const trigger of triggers) {
    database.exec(`DROP TRIGGER "${trigger.name}"`);
  }
  database.exec("ALTER TABLE sessions DROP COLUMN provider_v39");
  return triggers;
};

export const codexAdoptionRuntimeProfile = (
  profile: Readonly<{ id: string; processGeneration: number }>,
  preset: "low" | "high" | "ultra",
  fast: boolean,
) => ({
  approvalPolicy: "on-request" as const,
  computerUse: true as const,
  enabledApps: [],
  fast,
  model: presetRequirements[preset].model,
  observedAt: 2_000,
  permissionProfile: ":workspace" as const,
  pluginCapability: true as const,
  preset,
  processGeneration: profile.processGeneration,
  profileId: profile.id,
  reasoningEffort: presetRequirements[preset].effort,
  reviewMode: "auto_review" as const,
  serviceTier: fast ? "priority" as const : null,
});

export const claudeAdoptionRuntimeProfile = (
  authority: Readonly<{ profileId: string; processGeneration: number }>,
) => ({
  claudeVersion: "2.1.260",
  configHome: "personal" as const,
  inputFormat: "stream-json" as const,
  model: presetRequirements["fable-max"].model,
  observedAt: 2_000,
  outputFormat: "stream-json" as const,
  permissionMode: "default" as const,
  preset: "fable-max" as const,
  processGeneration: authority.processGeneration,
  profileId: authority.profileId,
  reasoningEffort: "max" as const,
});

export const managedClaudeRuntimeProfile = (
  authority: Readonly<{ profileId: string; processGeneration: number }>,
) => ({
  ...claudeAdoptionRuntimeProfile(authority),
  configHome: "isolated" as const,
});

export const testUnexpectedAdoptionHostCapabilities = {
  preambleVersion: 1,
  preambleDigest: "a".repeat(64),
  manifestVersion: 1,
  manifestDigest: "b".repeat(64),
} as const;

export let personalClaudeSessionSequence = 0;

export const adoptPersonalClaudeTestSession = (
  store: StateStore,
  profile: Readonly<{ id: string; processGeneration: number }>,
) => {
  personalClaudeSessionSequence += 1;
  const providerThreadId = `personal-claude-thread-${personalClaudeSessionSequence}`;
  const processIdentity = {
    pid: 60_000 + personalClaudeSessionSequence,
    pidDomain: "darwin" as const,
    procStart: `personal-claude-process-${personalClaudeSessionSequence}`,
  };
  const candidate = store.upsertSessionAdoptionCandidate({
    provider: "claude",
    providerThreadId,
    title: `Personal Claude session ${personalClaudeSessionSequence}`,
    state: "idle",
    providerUpdatedAt: 10,
    liveness: "not_live",
    sourceProcessIdentity: processIdentity,
  });
  store.fenceSessionAdoptionCandidateForClaim({
    provider: "claude",
    providerThreadId,
    expectedRevision: candidate.revision,
  });
  store.recordClaimedClaudeProcessAuthority({
    providerAuthority: store.requireProviderAccountAuthority(profile.id, "claude"),
    providerThreadId,
    profileId: profile.id,
    profileGeneration: profile.processGeneration,
    runtimeScope: "personal",
    identity: processIdentity,
  });
  const claimed = store.listSessionAdoptionCandidates({ provider: "claude" })
    .find((current) => current.providerThreadId === providerThreadId);
  if (claimed === undefined) throw new Error("Expected claimed personal Claude candidate.");
  return store.adoptSessionCandidate({
    providerAuthority: store.requireProviderAccountAuthority(profile.id, "claude"),
    provider: "claude",
    providerThreadId,
    expectedCandidateRevision: claimed.revision,
    profileId: profile.id,
    profileGeneration: profile.processGeneration,
    preset: "fable-max",
    requirement: presetRequirements["fable-max"],
    fastEnabled: false,
    runtimeProfile: claudeAdoptionRuntimeProfile(store.requireProviderAccountAuthority(profile.id, "claude")),
    providerAccountKey: testProviderAccountKey("claude"),
    claudeProcessIdentity: processIdentity,
  }).session;
};

export const startInputFixtureDaemon = (store: StateStore) => {
  const bootId = `boot_${randomUUID().replaceAll("-", "")}`;
  return { bootId, daemonGeneration: store.nextDaemonGeneration(bootId) };
};

export const enqueueAttachedTestQueue = (
  store: StateStore,
  daemon: ReturnType<typeof startInputFixtureDaemon>,
  input: Parameters<StateStore["enqueueIdempotent"]>[0] & {
    idempotencyKey: string;
    attachments: NonNullable<Parameters<StateStore["enqueueIdempotent"]>[0]["attachments"]>;
  },
) => {
  const reserved = store.reserveAttachmentIngress({
    ...daemon, kind: "session.queue", sessionId: input.sessionId,
    idempotencyKey: input.idempotencyKey, message: input.message,
    attachments: input.attachments, providerAuthority: input.providerAuthority,
  });
  if (reserved.kind !== "reserved") throw new Error("Expected a real attached queue reservation.");
  const reservation = { ...daemon, reservationId: reserved.reservationId, reservationDigest: reserved.reservationDigest };
  try { return store.enqueueIdempotent({ ...input, attachmentReservation: reservation }); }
  finally { store.releaseAttachmentIngress(reservation); }
};

export const providerSwitchSchemaObjectCount = (database: Database): number =>
  z.object({ count: z.number().int().nonnegative() }).strict().parse(database.query(
    `SELECT COUNT(*) AS count FROM sqlite_master
     WHERE name LIKE 'session_provider_switch_%'
        OR name LIKE 'session_mutation_authority_rebinds%'`,
  ).get()).count;

export async function canonical30AutorespondArchive() {
  const home = await realpath(await mkdtemp(join(tmpdir(), "oompa-store-canonical30-autorespond-")));
  const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
  await initializeStatePaths(paths);
  await writeFile(paths.database, canonical30WorkDatabaseBytes(), { mode: 0o600, flag: "wx" });
  return paths;
}

export async function canonical48WorkArchive() {
  const home = await realpath(await mkdtemp(join(tmpdir(), "oompa-store-canonical48-work-")));
  const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
  await initializeStatePaths(paths);
  await writeFile(paths.database, canonical48WorkDatabaseBytes(), { mode: 0o600, flag: "wx" });
  return paths;
}

export async function stagedCanonical47Archive() {
  const paths = await canonical48WorkArchive();
  const names = [
    "project_memory_hosted_attachments", "project_memory_hosted_create_intents",
    "project_memory_sync_intents", "project_memory_sync_spool", "project_memory_portable_adoption_proofs",
    "project_memory_hosted_create_intents_project_recent", "project_memory_hosted_create_intents_remote_space",
    "project_memory_hosted_create_intents_one_unresolved_project", "project_memory_sync_intents_project_recent",
    "project_memory_sync_intents_project_settled", "project_memory_sync_intents_one_unresolved_project",
    "project_memory_portable_adoption_proofs_record", "project_memory_portable_adoption_proof_insert_guard",
    "project_memory_portable_adoption_proof_update_guard", "project_memory_portable_adoption_proof_delete_guard",
    "project_memory_hosted_create_intent_insert_guard", "project_memory_hosted_create_intent_transition_guard",
    "project_memory_hosted_create_intent_delete_guard", "project_memory_hosted_attachment_insert_guard",
    "project_memory_hosted_attachment_transition_guard", "project_memory_hosted_attachment_delete_guard",
    "project_memory_sync_spool_insert_guard", "project_memory_sync_spool_update_guard",
    "project_memory_sync_spool_delete_guard", "project_memory_sync_intent_insert_guard",
    "project_memory_sync_intent_transition_guard", "project_memory_sync_intent_delete_guard",
    "project_memory_sync_intent_retained_quota", "project_memory_hosted_create_authority_fence",
    "project_memory_sync_authority_fence", "canonical_memory_sync_share_fence",
  ];
  const database = new Database(paths.database, { create: false, strict: true });
  try {
    database.exec("PRAGMA foreign_keys=ON");
    database.transaction(() => {
      const before = canonicalAuthBudgetSnapshot(database);
      expect(before.version).toEqual({ user_version: 48 });
      expect(database.query("SELECT * FROM migrations WHERE version=48").get())
        .toEqual({ version: 48, applied_at: canonical48WorkFixture.fixedTime });
      const objects = z.array(z.object({
        type: z.enum(["table", "index", "trigger", "view"]), name: z.string(), tbl_name: z.string(), sql: z.string().nullable(),
      }).strict()).parse(before.schema);
      const component = objects.filter((object) => names.includes(object.name));
      expect(component).toHaveLength(31);
      // Exact sqlite_schema metadata from5838's aliased physical48 component,
      // not a digest of the current implementation's dynamically derived DDL.
      expect(createHash("sha256").update(JSON.stringify(component)).digest("hex"))
        .toBe("9583125a8741583e8f98290021f49f808d4b6c66508399285022c21b0dfb5490");
      const tables = component.filter((object) => object.type === "table").map((object) => object.name);
      expect(tables).toHaveLength(5);
      for (const table of tables) expect(before.rows[table]).toEqual([]);
      const isOwned = (object: (typeof objects)[number]) => names.includes(object.name)
        || (object.type === "index" && object.sql === null && object.name.startsWith("sqlite_autoindex_") && tables.includes(object.tbl_name));
      for (const object of objects.filter((entry) => !isOwned(entry))) {
        expect(tables).not.toContain(object.tbl_name);
        for (const table of tables) expect(object.sql ?? "").not.toMatch(new RegExp(`\\b${table}\\b`, "iu"));
      }
      for (const object of component.filter((entry) => entry.type === "trigger" || entry.type === "index")) {
        database.exec(`DROP ${object.type.toUpperCase()} "${object.name}"`);
      }
      for (const table of [...tables].reverse()) database.exec(`DROP TABLE "${table}"`);
      expect(database.query("DELETE FROM migrations WHERE version=48 AND applied_at=?")
        .run(canonical48WorkFixture.fixedTime).changes).toBe(1);
      database.exec("PRAGMA user_version=47");
      const after = canonicalAuthBudgetSnapshot(database);
      expect(after.schema).toEqual(objects.filter((object) => !isOwned(object)));
      expect(after.rows).toEqual(Object.fromEntries(Object.entries(before.rows)
        .filter(([table]) => !tables.includes(table))
        .map(([table, rows]) => [table, table === "migrations"
          ? rows.filter((row) => z.object({ version: z.number() }).parse(row).version !== 48) : rows])));
      expect(after.version).toEqual({ user_version: 47 });
      expect(database.query("PRAGMA foreign_key_check").all()).toEqual([]);
    }).immediate();
  } finally { database.close(false); }
  return paths;
}

export const shortScrubCheckpoint: SecurityScrubCheckpointPolicy = {
  busyTimeoutMs: 50,
  attempts: 2,
  backoffMs: 10,
};

export type ReaderProcess = Readonly<{
  nextLine: () => Promise<string>;
  exited: Promise<number>;
  kill: () => void;
}>;

export async function spawnReaderProcess(
  home: string,
  name: string,
  source: string,
  args: readonly string[],
): Promise<ReaderProcess> {
  const script = join(home, `${name}.ts`);
  await writeFile(script, source, { mode: 0o600 });
  const child = Bun.spawn([process.execPath, script, ...args], {
    env: process.env,
    stderr: "pipe",
    stdin: "ignore",
    stdout: "pipe",
  });
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  const lines: string[] = [];
  let buffered = "";
  const nextLine = async (): Promise<string> => {
    for (;;) {
      const line = lines.shift();
      if (line !== undefined) return line;
      const chunk = await reader.read();
      if (chunk.done) {
        throw new Error(`reader process ended early: ${await new Response(child.stderr).text()}`);
      }
      buffered += decoder.decode(chunk.value, { stream: true });
      const parts = buffered.split("\n");
      buffered = parts.pop() ?? "";
      lines.push(...parts.filter((part) => part.length > 0));
    }
  };
  return { nextLine, exited: child.exited, kill: () => child.kill() };
}

export const pinnedReaderSource = `
import { writeSync } from "node:fs";
import { Database } from "bun:sqlite";
const [databasePath, holdMs] = Bun.argv.slice(2);
const reader = new Database(databasePath, { readonly: true, strict: true });
reader.exec("BEGIN");
reader.query("SELECT count(*) AS total FROM queue_entries").get();
writeSync(1, "pinned\\n");
Bun.sleepSync(Number(holdMs));
reader.exec("COMMIT");
reader.close(false);
writeSync(1, "released\\n");
`;

export const statusReaderSource = `
import { existsSync, writeSync } from "node:fs";
import { resolveStatePaths } from ${JSON.stringify(join(import.meta.dir, "../../src/storage/paths.ts"))};
import { StateStore } from ${JSON.stringify(join(import.meta.dir, "../../src/storage/state-store.ts"))};
const [homeDirectory, stopFile] = Bun.argv.slice(2);
const paths = resolveStatePaths({ homeDirectory, platform: "darwin" });
let opens = 0;
let scrubBlockedOpens = 0;
let started = false;
while (!existsSync(stopFile) && opens + scrubBlockedOpens < 10_000) {
  try {
    const store = new StateStore(paths, { readonly: true });
    try {
      store.listProjects();
      store.listProfiles();
      store.listSessions();
    } finally {
      store.close();
    }
    opens += 1;
  } catch (error) {
    if (error instanceof Error && error.message === "STATE_SECURITY_SCRUB_REQUIRED") {
      scrubBlockedOpens += 1;
    } else {
      writeSync(1, JSON.stringify({ error: error instanceof Error ? error.message : "UNKNOWN" }) + "\\n");
      process.exit(1);
    }
  }
  if (!started) {
    started = true;
    writeSync(1, "started\\n");
  }
}
writeSync(1, JSON.stringify({ opens, scrubBlockedOpens }) + "\\n");
`;

export const statusReaderReportSchema = z.object({
  opens: z.number().int().nonnegative(),
  scrubBlockedOpens: z.number().int().nonnegative(),
}).strict();

export function signInProfile(store: StateStore, label: string, email: string) {
  const created = store.createProfile(label);
  const current = store.nextProfileGeneration(created.id);
  expect(
    store.setProfileState(current.id, current.processGeneration, "signed_in", {
      email,
      plan: "Plus",
    }),
  ).toBe(true);
  return store.requireProfile(current.id);
}

export const reviewedCodexProfile = (
  profile: Readonly<{ id: string; processGeneration: number }>,
  observedAt = 2_000,
) => effectiveRuntimeProfileSchema.parse({
  approvalPolicy: "on-request",
  computerUse: true,
  enabledApps: [],
  fast: false,
  model: presetRequirements.high.model,
  observedAt,
  permissionProfile: ":workspace",
  pluginCapability: true,
  preset: "high",
  processGeneration: profile.processGeneration,
  profileId: profile.id,
  reasoningEffort: "max",
  reviewMode: "auto_review",
  serviceTier: null,
});

export const reviewedClaudeProfile = (
  profile: Readonly<{ id: string; processGeneration: number }>,
  observedAt = 2_000,
) => effectiveClaudeRuntimeProfileSchema.parse({
  claudeVersion: "2.1.260",
  inputFormat: "stream-json",
  isolatedConfigDir: true,
  model: "claude-fable-5-1",
  nativeFallback: {
    model: "claude-opus-5",
    reason: "live_acceptance_required",
    status: "unavailable",
  },
  observedAt,
  outputFormat: "stream-json",
  permissionMode: "default",
  preset: "fable-max",
  processGeneration: profile.processGeneration,
  profileId: profile.id,
  reasoningEffort: "max",
});

export const sessionSwitchDigest = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

export const restoreSwitchGuardsForTest = (database: Database, names: readonly string[]) => {
  const definitions = names.map((name) => z.object({ sql: z.string() }).strict().parse(
    database.query("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(name),
  ).sql);
  return () => {
    for (const definition of definitions) database.exec(definition);
  };
};

export const snapshotSwitchContainmentForTest = (database: Database) => {
  const tables = z.object({ name: z.string().regex(/^[a-z0-9_]+$/u) }).strict().array().parse(
    database.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all(),
  );
  return {
    schema: database.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all(),
    version: database.query("PRAGMA user_version").get(),
    rows: tables.map(({ name }) => {
      const rows = database.query(`SELECT * FROM ${name} ORDER BY rowid LIMIT 201`).all();
      if (rows.length > 200) throw new Error("Containment refusal fixture exceeded its row bound.");
      return { name, rows };
    }),
  };
};

export const combined49SwitchArchiveForTest = async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "oompa-combined49-switch-history-")));
  const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
  await initializeStatePaths(paths);
  const bytes = combined49SwitchDatabaseBytes();
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(combined49SwitchFixture.databaseSha256);
  await writeFile(paths.database, bytes, { mode: 0o600, flag: "wx" });
  return paths;
};

export const expectInertSwitchReopenForTest = (
  paths: StateStore["paths"],
  expected: ReturnType<StateStore["requireSessionSwitch"]>,
): void => {
  const inspector = new Database(paths.database, { create: false, strict: true });
  try {
    const before = snapshotSwitchContainmentForTest(inspector);
    for (const readonly of [false, true]) {
      const reopened = new StateStore(paths, { readonly });
      try { expect(reopened.requireSessionSwitch(expected.attemptId)).toEqual(expected); }
      finally { reopened.close(); }
      expect(snapshotSwitchContainmentForTest(inspector)).toEqual(before);
    }
  } finally { inspector.close(false); }
};

export const canonicalTimestampArchiveForTest = async (version: 40 | 41) => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "oompa-canonical-timestamp-history-")));
  const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
  await initializeStatePaths(paths);
  const bytes = version === 40 ? canonical40UsageDatabaseBytes() : canonical41TimestampsDatabaseBytes();
  const captured = version === 40 ? canonical40UsageFixture : canonical41TimestampsFixture;
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(captured.databaseSha256);
  await writeFile(paths.database, bytes, { mode: 0o600, flag: "wx" });
  return paths;
};

export const corruptCombined49SwitchRowsForTest = (
  database: Database,
  changedTables: readonly string[],
  removedGuards: readonly string[],
  change: () => void,
) => {
  const before = snapshotSwitchContainmentForTest(database);
  expect(before.version).toEqual({ user_version: 49 });
  expect(database.query("SELECT 1 FROM sqlite_schema WHERE name LIKE 'session_switch_execution_%' LIMIT 1").get()).toBeNull();
  database.exec("PRAGMA foreign_keys=OFF; PRAGMA ignore_check_constraints=ON");
  try {
    database.transaction(() => withRemovedTestGuards(database, removedGuards, change)).immediate();
  } finally {
    database.exec("PRAGMA ignore_check_constraints=OFF; PRAGMA foreign_keys=ON");
  }
  const after = snapshotSwitchContainmentForTest(database);
  expect(after.schema).toEqual(before.schema);
  expect(after.version).toEqual(before.version);
  expect(after.rows.filter(({ name }) => !changedTables.includes(name)))
    .toEqual(before.rows.filter(({ name }) => !changedTables.includes(name)));
};

export type SignedInTestProfile = ReturnType<typeof signInProfile>;

export const prepareDedicatedSessionSwitch = (
  store: StateStore,
  sequence: number,
  options: Readonly<{
    sourceProfile?: SignedInTestProfile;
    targetProfile?: SignedInTestProfile;
    targetPreset?: "low" | "high";
    targetThreadId?: string;
    pinSourceEvent?: boolean;
    pendingQueueMessage?: string;
  }> = {},
) => {
  const suffix = String(sequence).padStart(12, "0");
  const sourceProfile = options.sourceProfile
    ?? signInProfile(store, `Switch source ${sequence}`, `switch-source-${sequence}@example.com`);
  const targetProfile = options.targetProfile
    ?? signInProfile(store, `Switch target ${sequence}`, `switch-target-${sequence}@example.com`);
  const targetPreset = options.targetPreset ?? "low";
  const sourceAuthority = store.requireProviderAccountAuthority(sourceProfile.id, "codex");
  const targetAuthority = store.requireProviderAccountAuthority(targetProfile.id, "codex");
  const targetAccountKey = providerAccountKeyForProfile(store, targetProfile.id, "codex");
  const session = upsertProvenTestSession(store, {
    profileId: sourceProfile.id,
    provider: "codex",
    preset: "high",
    fastEnabled: false,
    title: `Switch ${sequence}`,
    providerThreadId: `source-thread-${sequence}`,
    providerUpdatedAt: 10 + sequence,
    state: "idle",
  });
  const sourceRuntime = store.recordSessionRuntimeProfile({
    sessionId: session.id,
    sourceKind: "session_start",
    sourceId: `10000000-0000-4000-8000-${suffix}`,
    // Provider import deliberately preserves the released preset contract.
    // The source observation must describe that exact model; only the new
    // switch target selects the current preset contract below.
    profile: effectiveRuntimeProfileSchema.parse({
      ...reviewedCodexProfile({
        id: sourceProfile.id,
        processGeneration: sourceAuthority.processGeneration,
      }, 2_000 + sequence),
      model: store.requireSessionPresetRequirement(session.id).requirement.model,
    }),
    providerAuthority: sourceAuthority,
  });
  if (options.pinSourceEvent === true) {
    store.appendSessionEvent({
      sessionId: session.id,
      accountId: sourceAuthority.profileId,
      providerGeneration: sourceAuthority.processGeneration,
      providerAuthority: sourceAuthority,
      providerConnectionId: null,
      body: {
        type: "warning",
        code: "SWITCH_PIN",
        message: `Pinned switch event ${sequence}`,
      },
    });
  }
  const position = store.readSessionSnapshotWithEventPosition(session.id);
  const pendingQueue = options.pendingQueueMessage === undefined ? null : store.enqueue(session.id, options.pendingQueueMessage);
  const seedText = `Provider switch seed ${sequence}`;
  const seedDigest = createHash("sha256")
    .update("hra:session-transcript-seed:v1\0", "utf8")
    .update(seedText, "utf8")
    .digest("hex");
  const prepared = store.prepareSessionSwitch({
    targetAccountKey,
    targetHostCapabilities: testSwitchHostCapabilities,
    idempotencyKey: `20000000-0000-4000-8000-${suffix}`,
    rawRequest: {
      version: 2,
      session: session.id,
      provider: "codex",
      account: targetProfile.id,
      preset: targetPreset,
      presetContract: null,
    },
    sessionId: session.id,
    sourceAuthority,
    targetAuthority,
    expectedSessionRevision: session.revision,
    expectedAuthorityRevision: store.requireSessionProviderAuthority(session.id).authorityRevision,
    sourcePreset: "high",
    sourcePresetContract: store.requireSessionPresetContract(session.id),
    targetPreset,
    targetPresetContract: activePresetBinding(targetPreset).contract,
    sourceRuntimeProfileRevision: sourceRuntime.revision,
    transcript: {
      streamEpoch: position.streamEpoch,
      floorSequence: position.floorSequence,
      afterSequenceExclusive: options.pinSourceEvent === true
        ? position.floorSequence - 1
        : position.observedThroughSequence,
      throughSequenceInclusive: position.observedThroughSequence,
      acceptedHeadSequence: position.observedThroughSequence,
      rendererVersion: 2,
      rendererLimit: 400,
      transcriptDigest: createHash("sha256").update(`transcript-${sequence}`).digest("hex"),
      seedDigest,
      seedIncludedRecords: options.pinSourceEvent === true ? 1 : 0,
      seedOmittedRecords: 0,
      seedClientMessageId: `switch-seed-${sequence}`,
    },
  });
  const cas = {
    attemptId: prepared.switch.attemptId,
    requestDigest: prepared.switch.requestDigest,
    sourceAuthority,
    targetAuthority,
    originalSessionRevision: prepared.switch.originalSessionRevision,
    originalAuthorityRevision: prepared.switch.originalAuthorityRevision,
  } as const;
  return {
    ...prepared,
    targetAccountKey,
    cas,
    pendingQueue,
    seedText,
    session,
    sourceProfile,
    targetProfile,
    targetRuntime: effectiveRuntimeProfileSchema.parse({
      ...reviewedCodexProfile({
        id: targetProfile.id,
        processGeneration: targetAuthority.processGeneration,
      }, 3_000 + sequence),
      preset: targetPreset,
      model: presetRequirements[targetPreset].model,
    }),
    targetThreadId: options.targetThreadId ?? `target-thread-${sequence}`,
  };
};

export const advanceDedicatedSessionSwitch = (
  store: StateStore,
  prepared: ReturnType<typeof prepareDedicatedSessionSwitch>,
  through: "target_starting" | "target_started" | "source_releasing"
    | "source_released" | "rebound" | "seed_dispatching",
) => {
  let record = store.beginSessionSwitchTargetStart(prepared.cas);
  if (through === "target_starting") return record;
  record = store.completeSessionSwitchTargetStart({
    ...prepared.cas,
    providerThreadId: prepared.targetThreadId,
    state: "idle",
    providerUpdatedAt: 20,
    runtimeProfile: prepared.targetRuntime,
  });
  if (through === "target_started") return record;
  record = store.beginSessionSwitchSourceRelease(prepared.cas);
  if (through === "source_releasing") return record;
  record = store.completeSessionSwitchSourceRelease({ ...prepared.cas, status: "released" });
  if (through === "source_released") return record;
  record = store.rebindSessionSwitch(prepared.cas);
  if (through === "rebound") return record;
  const authority = store.requireSessionProviderAuthority(prepared.session.id);
  return store.beginSessionSwitchSeedDispatch({
    ...prepared.cas,
    seedAuthority: prepared.cas.targetAuthority,
    seedAuthorityRevision: authority.authorityRevision,
    seedDigest: prepared.switch.transcript.seedDigest,
    clientMessageId: prepared.switch.transcript.seedClientMessageId,
  });
};

export const installSessionAuthoritySuccessorForTest = (
  store: StateStore,
  prepared: ReturnType<typeof prepareDedicatedSessionSwitch>,
  targetAuthority: ReturnType<StateStore["requireProviderAccountAuthority"]>,
  routingProvenance: "managed" | "explicit" = "explicit",
) => {
  const previous = store.requireCapturedSessionProviderAuthority(prepared.session.id);
  const targetAppliedPointerRevision = routingProvenance === "managed"
    ? store.readProviderAccountState(targetAuthority.provider).pointerRevision
    : null;
  const database = new Database(store.paths.database, { create: false, strict: true });
  try {
    const transition = database.transaction(() => {
      database.query(
        `INSERT INTO session_provider_authority_successors(
           session_id,from_authority_revision,to_authority_revision,
           from_provider_account_id,from_profile_id,from_provider,
           from_binding_generation,from_process_generation,
           from_routing_provenance,from_applied_pointer_revision,
           to_provider_account_id,to_profile_id,to_provider,
           to_binding_generation,to_process_generation,
           to_routing_provenance,to_applied_pointer_revision,
           transition_kind,transition_id,recorded_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        prepared.session.id,
        previous.authorityRevision,
        previous.authorityRevision + 1,
        previous.providerAccountId,
        previous.profileId,
        previous.provider,
        previous.bindingGeneration,
        previous.processGeneration,
        previous.routingProvenance,
        previous.appliedPointerRevision,
        targetAuthority.providerAccountId,
        targetAuthority.profileId,
        targetAuthority.provider,
        targetAuthority.bindingGeneration,
        targetAuthority.processGeneration,
        routingProvenance,
        targetAppliedPointerRevision,
        "provider_restart",
        `same-daemon-successor-${prepared.switch.attemptId}`,
        9_000,
      );
      const changed = database.query(
        `UPDATE session_provider_authorities
         SET provider_account_id=?,profile_id=?,provider=?,binding_generation=?,
             process_generation=?,authority_revision=authority_revision+1,
             routing_provenance=?,applied_pointer_revision=?
         WHERE session_id=? AND authority_revision=?`,
      ).run(
        targetAuthority.providerAccountId,
        targetAuthority.profileId,
        targetAuthority.provider,
        targetAuthority.bindingGeneration,
        targetAuthority.processGeneration,
        routingProvenance,
        targetAppliedPointerRevision,
        prepared.session.id,
        previous.authorityRevision,
      );
      expect(changed.changes).toBe(1);
    });
    transition.immediate();
  } finally {
    database.close(false);
  }
  return store.requireSessionProviderAuthority(prepared.session.id);
};

export const codexInteractionBinding = (
  store: StateStore,
  profileId: ProfileId,
) => {
  const authority = store.requireProviderAccountAuthority(profileId, "codex");
  return {
    provider: authority.provider,
    providerAccountId: authority.providerAccountId,
    bindingGeneration: authority.bindingGeneration,
  } as const;
};

export const codexAuthorityFor = (
  store: StateStore,
  profile: Readonly<{ id: ProfileId }>,
) => store.requireProviderAccountAuthority(profile.id, "codex");

export const desktopSwitchBinding = (plan: Readonly<{
  switchGeneration: number;
  sourceProfileId: ProfileId | null;
  sourceProcessGeneration: number | null;
  sourceProviderAuthority: ReturnType<StateStore["requireProviderAccountAuthority"]> | null;
  targetProfileId: ProfileId;
  targetProcessGeneration: number;
  targetProviderAuthority: ReturnType<StateStore["requireProviderAccountAuthority"]>;
}>) => ({
  switchGeneration: plan.switchGeneration,
  sourceProfileId: plan.sourceProfileId,
  sourceProcessGeneration: plan.sourceProcessGeneration,
  sourceProviderAuthority: plan.sourceProviderAuthority,
  targetProfileId: plan.targetProfileId,
  targetProcessGeneration: plan.targetProcessGeneration,
  targetProviderAuthority: plan.targetProviderAuthority,
});

export function admitRestartCommandInteraction(
  store: StateStore,
  input: Readonly<{
    index: number;
    processGeneration: number;
    profileId: string;
    sessionId: string;
    threadId: string;
    turnId: string | null;
  }>,
) {
  const suffix = String(input.index).padStart(12, "0");
  const captured = store.requireCapturedSessionProviderAuthority(input.sessionId);
  return store.admitInteraction({
    publicId: `39000000-0000-4000-8000-${suffix}`,
    sessionId: input.sessionId,
    authority: {
      provider: captured.provider,
      providerAccountId: captured.providerAccountId,
      bindingGeneration: captured.bindingGeneration,
      profileId: input.profileId,
      processGeneration: input.processGeneration,
      connectionId: "39000000-0000-4000-8000-999999999999",
      requestId: { type: "number", value: input.index },
      method: captured.provider === "claude" ? "claude/control_request/can_use_tool"
        : captured.provider === "devin" ? "session/request_permission" : "item/commandExecution/requestApproval",
      requestDigest: input.index.toString(16).padStart(64, "0"),
      threadId: input.threadId,
      turnId: input.turnId,
      itemId: `item-restart-${String(input.index)}`,
      approvalId: null,
    },
    kind: "command_approval",
    blocking: true,
    display: {
      kind: "command_approval",
      summary: "Review restart handling",
      reason: null,
      commandClass: "test",
      workingDirectory: null,
      availableDecisions: ["once", "decline", "cancel"],
    },
    requestedAt: 1_000,
    deadlineAt: 100_000,
  }).record;
}

export async function prepareSignedOutSessionStart(
  store: StateStore,
  home: string,
  input: Readonly<{
    idempotencyKey: string;
    label: string;
    preset: "high" | "fable-max";
    provider: "codex" | "claude";
  }>,
) {
  const profile = store.createProfile(input.label);
  const projectRoot = join(home, `${input.label.toLowerCase().replaceAll(" ", "-")}-project`);
  await mkdir(projectRoot);
  const project = await store.createProject(`${input.label} project`, projectRoot, true);
  const attempt = store.prepareMutation({
    authorityGeneration: profile.processGeneration,
    authorityId: profile.id,
    idempotencyKey: input.idempotencyKey,
    kind: "session.start",
    request: sessionStartMutationRequest({
      projectId: project.id,
      provider: input.provider,
      preset: input.preset,
      ...(input.preset === "high" ? { presetContract: currentPresetContract } : {}),
      fast: false,
    }),
  });
  return { attempt, profile, project };
}

export const usageFingerprint = "a".repeat(64);

export const resetAccountFingerprint = (email: string): string =>
  createHash("sha256").update(email.trim().toLowerCase()).digest("hex");

export const testDigest = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

export const testSwitchHostCapabilities = {
  preambleVersion: 1,
  preambleDigest: "a".repeat(64),
  manifestVersion: 1,
  manifestDigest: "b".repeat(64),
} as const;

export const testCanonicalMemoryEnvelope = (value: string, keyVersion = 1) => ({
  algorithm: "A256GCM" as const,
  ciphertext: testDigest(`ciphertext:${value}`),
  keyVersion,
  nonce: testDigest(`nonce:${value}`).slice(0, 16),
});

export const testCanonicalMemoryHostedCreateRequest = (
  remoteSpaceId: string,
  keyVersion = 7,
  accountKeyVersion = 3,
) => ({
  bindingPolicy: "one_project_one_space" as const,
  encryptedDescriptor: testCanonicalMemoryEnvelope(
    "PRIVATE HOSTED CREATE DESCRIPTOR",
    keyVersion,
  ),
  genesisHeadProof: testCanonicalMemoryEnvelope(
    "PRIVATE HOSTED CREATE GENESIS PROOF",
    keyVersion,
  ),
  genesisToken: testDigest("hosted create genesis token"),
  identityContract: 2 as const,
  keyVersion,
  spaceId: remoteSpaceId,
  wrappedSpaceKey: testCanonicalMemoryEnvelope(
    "PRIVATE HOSTED CREATE WRAPPED KEY",
    accountKeyVersion,
  ),
});

export const reserveTestProjectMemoryAuthority = (
  store: StateStore,
  projectId: ProjectId,
  head: ProjectMemoryHeadRef,
) => {
  const identity = createPortableProjectMemoryCanonicalIdentity(projectId);
  const reserved = store.reserveProjectMemoryAuthority({
    canonicalSpaceId: identity.canonicalSpaceId,
    head,
    identityContract: identity.identityContract,
    projectId,
  });
  return store.markProjectMemoryAuthorityInitialized({
    expectedHead: reserved.head,
    expectedRevision: reserved.revision,
    projectId,
  });
};

export const peerIdempotencyKey = (index: number): string =>
  `20000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;

export const peerOriginBoundaryFixture = async () => {
  const { store, home } = await fixture();
  const root = join(home, "peer-origin-boundary");
  await mkdir(root);
  const project = await store.createProject("Peer origin boundary", root);
  const profile = signInProfile(store, "Peer origin boundary", "peer-origin@example.com");
  const activeSession = (turnId: string) => {
    const created = createAuthorizedStartingTestSession(store, {
      profileId: profile.id,
      projectId: project.id,
      preset: "high",
      fastEnabled: false,
    });
    return store.setSessionTurnState({
      sessionId: created.id,
      expectedRevision: created.revision,
      state: "active",
      activeTurnId: turnId,
    });
  };
  const actor = activeSession("turn-peer-origin-actor");
  const target = activeSession("turn-peer-origin-target");
  const requestFor = (index: number): Parameters<StateStore["admitPeerSessionAction"]>[0] => ({
    actorSessionId: actor.id,
    actorTurnId: actor.activeTurnId!,
    targetSessionId: target.id,
    expectedTargetRevision: target.revision,
    delivery: "steer",
    requestDigest: testDigest(`peer origin request ${String(index)}`),
    messageDigest: testDigest(`peer origin message ${String(index)}`),
    reasonDigest: testDigest(`peer origin reason ${String(index)}`),
    idempotencyKey: peerIdempotencyKey(91_000 + index),
  });
  const applySteer = (index: number) => {
    const action = store.admitPeerSessionAction(requestFor(index)).action;
    store.beginPeerSessionActionEffect(action.id);
    return store.settlePeerSessionAction({
      actionId: action.id,
      expectedState: "effect_started",
      state: "applied",
      targetTurnId: target.activeTurnId!,
      resultDigest: testDigest(`peer origin receipt ${String(index)}`),
    });
  };
  const origins = () => store.readPeerSessionTurnOrigins({
    sessionId: target.id,
    turnId: target.activeTurnId!,
  });
  return { actor, applySteer, origins, requestFor, store, target };
};

export const codexRuntimeProfile = (
  profile: Readonly<{ id: string; processGeneration: number }>,
  observedAt = 2_000,
) => ({
  profileId: profile.id,
  processGeneration: profile.processGeneration,
  observedAt,
  preset: "high" as const,
  model: "gpt-6-astra",
  reasoningEffort: "max" as const,
  serviceTier: null,
  fast: false,
  approvalPolicy: "on-request" as const,
  reviewMode: "auto_review" as const,
  permissionProfile: ":workspace" as const,
  computerUse: true as const,
  pluginCapability: true as const,
  enabledApps: [],
});

export const recordUsageForTest = (
  store: StateStore,
  profileId: ProfileId,
  sourceRevision: number,
  observedAt: number,
  payload: unknown,
): StoredAccountUsageSnapshot => {
  const authority = store.requireProviderAccountAuthority(profileId, "codex");
  const existing = storedAccountUsageSnapshotSchema.safeParse(payload);
  const stored = existing.success
    ? payload as StoredAccountUsageSnapshot
    : storedAccountUsageSnapshotSchema.parse({
        version: 1,
        providerPayload: payload,
        observation: {
          version: 1,
          sourceSequence: sourceRevision,
          accountFingerprint: usageFingerprint,
          usageEpoch: "00000000-0000-4000-8000-000000000001",
          schemaDigest: "a".repeat(64),
          counterName: "lifetimeTokens",
          clock: "received",
          observedAt,
          receivedAt: observedAt,
          lifetimeTokens: null,
          gapBefore: false,
          providerGeneration: authority.processGeneration,
          daemonGeneration: 1,
        },
      });
  store.recordUsage(profileId, sourceRevision, observedAt, stored, authority);
  return stored;
};

export const recordUsagePollFailureForTest = (
  store: StateStore,
  profileId: ProfileId,
  accountFingerprint: string | null,
  sourceRevision: number,
  observedAt: number,
): void => store.recordUsagePollFailure(
  profileId,
  accountFingerprint,
  sourceRevision,
  observedAt,
  store.requireProviderAccountAuthority(profileId, "codex"),
);

export const bindClaudeTurnForUsageTest = (
  store: StateStore,
  profileId: ProfileId,
  turnId: string,
  daemon: ReturnType<typeof startInputFixtureDaemon>,
) => {
  const authority = store.requireProviderAccountAuthority(profileId, "claude");
  const created = store.createSession({
    fastEnabled: false,
    preset: "fable-max",
    profileId,
    provider: "claude",
  });
  const session = store.bindSession({
    expectedRevision: created.revision,
    providerThreadId: `thread-${turnId}`,
    providerUpdatedAt: 10,
    sessionId: created.id,
    state: "idle",
  });
  const runtimeProfile = reviewedClaudeProfile({
    id: profileId,
    processGeneration: authority.processGeneration,
  });
  const message = `observe ${turnId}`;
  const { attempt } = store.prepareSessionInputMutation({
    ...daemon,
    sessionId: session.id,
    idempotencyKey: crypto.randomUUID(),
    kind: "session.send",
    providerAuthority: authority,
    message,
    attachments: [],
  });
  store.beginSessionMutationEffect({
    ...daemon,
    attachments: [],
    attemptId: attempt.id,
    message,
    transcript: { accountId: profileId, providerGeneration: authority.processGeneration,
      providerConnectionId: "10000000-0000-4000-8000-000000000231", actor: "human", message },
    evidence: {
      baseline: { activeTurnId: null, providerUpdatedAt: 10, status: "idle" },
      clientMessageId: attempt.id,
      kind: "session.send",
      messageDigest: createHash("sha256").update(message).digest("hex"),
      providerThreadId: `thread-${turnId}`,
      runtimeProfile,
    },
    profileGeneration: authority.processGeneration,
    providerAuthority: authority,
    sessionId: session.id,
  });
  store.completeSessionTurnEffect({
    applyResponseState: false,
    attemptId: attempt.id,
    accountId: profileId,
    providerGeneration: authority.processGeneration,
    providerConnectionId: "10000000-0000-4000-8000-000000000231",
    message,
    expectedSessionRevision: session.revision,
    providerAuthority: authority,
    receipt: { turnId },
    runtimeProfile,
    sessionId: session.id,
    turnId,
    turnStatus: "completed",
  });
  return { authority, sessionId: session.id, turnId };
};

export const claudeQuotaForUsageTest = (input: Readonly<{
  authority: ReturnType<StateStore["requireProviderAccountAuthority"]>;
  event?: number;
  observedAt: number;
  revision: number;
  sessionId: string;
  turnId: string;
  usedPercent?: number;
}>): ClaudeProviderUsageQuotaComponent => createClaudeQuotaUsageComponent({
  authority: usageProviderAccountAuthoritySchema.parse(input.authority),
  observationRevision: input.revision,
  observedAt: input.observedAt,
  quota: {
    isUsingOverage: null,
    overageDisabledReason: null,
    overageStatus: null,
    rateLimitType: "five_hour",
    resetsAtMs: input.observedAt + 10_000,
    status: { state: "known", value: "allowed" },
    windows: [{
      id: "five_hour",
      resetsAtMs: input.observedAt + 10_000,
      scope: "account",
      usedPercent: input.usedPercent ?? 25,
    }],
  },
  receivedAt: input.observedAt,
  sessionId: input.sessionId,
  sourceEventDigest: providerUsageDigest({ event: input.event ?? input.revision, kind: "quota" }),
  sourceEventId: `00000000-0000-4000-8000-${String(input.event ?? input.revision).padStart(12, "0")}`,
  turnId: input.turnId,
});

export const claudeAccountingForUsageTest = (input: Readonly<{
  authority: ReturnType<StateStore["requireProviderAccountAuthority"]>;
  event?: number;
  observedAt: number;
  revision: number;
  sessionId: string;
  turnId: string;
}>): ClaudeProviderUsageAccountingComponent => createClaudeAccountingUsageComponent({
  accounting: {
    cacheCreationInputTokens: null,
    cacheReadInputTokens: 3,
    inputTokens: 2,
    models: [{
      cacheCreationInputTokens: null,
      cacheReadInputTokens: 3,
      contextWindow: null,
      costUsd: null,
      inputTokens: 2,
      maxOutputTokens: null,
      model: "claude-fable-5-1",
      outputTokens: 1,
      thinkingTokens: null,
    }],
    outputTokens: 1,
    thinkingTokens: null,
    totalCostUsd: null,
  },
  authority: usageProviderAccountAuthoritySchema.parse(input.authority),
  observationRevision: input.revision,
  observedAt: input.observedAt,
  receivedAt: input.observedAt,
  sessionId: input.sessionId,
  sourceEventDigest: providerUsageDigest({
    event: input.event ?? input.revision,
    kind: "accounting",
  }),
  sourceEventId: `10000000-0000-4000-8000-${String(input.event ?? input.revision).padStart(12, "0")}`,
  turnId: input.turnId,
});

export const seedProviderUsageForTest = (
  databasePath: string,
  count: number,
  observation: (revision: number) => ProviderUsageComponent,
): void => {
  const database = new Database(databasePath, { create: false, strict: true });
  try {
    const insertReceipt = database.query(
      `INSERT INTO provider_usage_observation_receipts(
         idempotency_key,component,provider_account_id,profile_id,provider,
         binding_generation,process_generation,session_id,turn_id,
         observation_revision,source,source_event_digest,component_digest,
         observed_at,received_at,recorded_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    const insertComponent = database.query(
      `INSERT INTO provider_usage_observation_components(
         idempotency_key,component_digest,component_json
       ) VALUES (?,?,?)`,
    );
    database.transaction(() => {
      for (let revision = 1; revision <= count; revision += 1) {
        const value = observation(revision);
        if (value.turn === null || value.authority.provider !== "claude") {
          throw new Error("Test provider usage seed must be Claude turn evidence.");
        }
        insertReceipt.run(
          value.idempotencyKey,
          value.component,
          value.authority.providerAccountId,
          value.authority.profileId,
          value.authority.provider,
          value.authority.bindingGeneration,
          value.authority.processGeneration,
          value.turn.sessionId,
          value.turn.turnId,
          value.observationRevision,
          value.source,
          value.sourceEventDigest,
          value.componentDigest,
          value.observedAt,
          value.receivedAt,
          value.receivedAt,
        );
        insertComponent.run(
          value.idempotencyKey,
          value.componentDigest,
          canonicalProviderUsageJson(value),
        );
      }
    }).immediate();
  } finally {
    database.close(false);
  }
};

export const peerAbandonmentFenceFixture = async (delivery: "send" | "steer" | "queue") => {
  let now = 50_000;
  const created = await fixture({ now: () => now });
  let store = created.store;
  const daemon = startInputFixtureDaemon(store);
  const root = join(created.home, "peer-abandonment-fence");
  await mkdir(root);
  const project = await store.createProject("Peer abandonment fence", root);
  const profile = signInProfile(store, "Peer abandonment fence", "peer-fence@example.com");
  const providerAuthority = store.requireProviderAccountAuthority(profile.id, "codex");
  const createSession = (name: string, active: boolean) => {
    const initial = createAuthorizedStartingTestSession(store, {
      profileId: profile.id,
      projectId: project.id,
      preset: "high",
      fastEnabled: false,
    });
    return store.bindSession({
      sessionId: initial.id,
      expectedRevision: initial.revision,
      providerThreadId: `thread-peer-fence-${name}`,
      state: active ? "active" : "idle",
      ...(active ? { activeTurnId: `turn-peer-fence-${name}` } : {}),
    });
  };
  const source = createSession("source", true);
  const target = createSession("target", delivery === "steer");
  const spare = createSession("spare", true);
  const targetTurnId = "turn-peer-fence-target";
  let nextKey = 94_000;
  const request = (
    actorId: SessionRecord["id"],
    targetId: SessionRecord["id"],
    kind: "send" | "steer" | "queue",
    message: string,
  ): Parameters<StateStore["admitPeerSessionAction"]>[0] => ({
    actorSessionId: actorId,
    actorTurnId: store.requireSession(actorId).activeTurnId!,
    targetSessionId: targetId,
    expectedTargetRevision: store.requireSession(targetId).revision,
    delivery: kind,
    requestDigest: testDigest(`fence request ${String(nextKey)}`),
    messageDigest: testDigest(message),
    reasonDigest: testDigest("fence reason"),
    idempotencyKey: peerIdempotencyKey(nextKey++),
    ...(kind === "queue" ? { message } : {}),
  });
  const message = "uncertain peer message with durable abandonment authority";
  const incomingRequest = request(source.id, target.id, delivery, message);
  const incoming = store.admitPeerSessionAction(incomingRequest);
  const runtime = codexRuntimeProfile(profile);
  const direct = delivery === "queue" ? undefined : store.prepareSessionInputMutation({
    ...daemon,
    kind: delivery === "send" ? "session.send" : "session.steer",
    sessionId: target.id,
    providerAuthority,
    message,
    attachments: [],
    idempotencyKey: incomingRequest.idempotencyKey,
  }).attempt;
  let effectDigest: string;
  if (delivery === "queue") {
    const queue = incoming.queue;
    if (queue === undefined) throw new Error("Missing peer fence queue");
    effectDigest = store.beginQueueEffect({
      queueId: queue.id,
      sessionId: target.id,
      providerAuthority,
      profileGeneration: profile.processGeneration,
      providerConnectionId: "10000000-0000-4000-8000-000000000099",
      evidence: {
        kind: "queue.dispatch",
        queueId: queue.id,
        sessionId: target.id,
        providerThreadId: target.providerThreadId!,
        profileGeneration: profile.processGeneration,
        baseline: { providerUpdatedAt: null, status: "idle", activeTurnId: null },
        clientMessageId: queue.id,
        messageDigest: testDigest(message),
        runtimeProfile: runtime,
      },
    }).digest;
  } else {
    if (direct === undefined) throw new Error("Missing peer fence mutation");
    const common = {
      providerThreadId: target.providerThreadId!,
      clientMessageId: direct.id,
      messageDigest: testDigest(message),
      messageActor: "peer_session" as const,
    };
    effectDigest = store.beginSessionMutationEffect({
      ...daemon,
      attemptId: direct.id,
      sessionId: target.id,
      providerAuthority,
      attachments: [],
      profileGeneration: profile.processGeneration,
      message,
      transcript: {
        accountId: profile.id,
        providerGeneration: profile.processGeneration,
        providerConnectionId: "10000000-0000-4000-8000-000000000099",
        actor: "peer_session",
        message,
      },
      evidence: delivery === "send" ? {
        ...common,
        kind: "session.send",
        baseline: { providerUpdatedAt: null, status: "idle", activeTurnId: null },
        runtimeProfile: runtime,
      } : {
        ...common,
        kind: "session.steer",
        baseline: { providerUpdatedAt: null, status: "active", activeTurnId: targetTurnId },
        activeTurnId: targetTurnId,
      },
    }).digest;
  }

  // An observed active target can admit work before the original response is
  // classified as uncertain. Effect begin must recheck the later fence.
  if (delivery !== "steer") {
    store.setSessionTurnState({
      sessionId: target.id,
      expectedRevision: store.requireSession(target.id).revision,
      state: "active",
      activeTurnId: targetTurnId,
    });
  }
  const completedRequest = request(target.id, spare.id, "steer", "already completed peer work");
  const completed = store.admitPeerSessionAction(completedRequest).action;
  store.beginPeerSessionActionEffect(completed.id);
  store.settlePeerSessionAction({
    actionId: completed.id,
    expectedState: "effect_started",
    state: "applied",
    targetTurnId: spare.activeTurnId!,
    resultDigest: testDigest("completed fence fixture receipt"),
  });
  const pending = store.admitPeerSessionAction(
    request(target.id, source.id, "steer", "preadmitted peer return"),
  ).action;
  if (incoming.queue !== undefined) {
    store.markQueueEffectAmbiguous(incoming.queue.id, effectDigest);
  } else {
    if (direct === undefined) throw new Error("Missing direct peer ambiguity authority");
    expect(store.transitionMutation(direct.id, "effect_started", "ambiguous")).toBeTrue();
    store.quarantineSession(target.id);
    store.settlePeerSessionAction({
      actionId: incoming.action.id,
      expectedState: "effect_started",
      state: "ambiguous",
    });
  }
  const baseResolutionEvidence = { action: "user_abandon", providerEffectRetried: false };
  const abandon = (
    resolutionEvidence: unknown = baseResolutionEvidence,
    active = true,
    activeTurnId: string | null = targetTurnId,
  ) => {
    const provider = {
      providerThreadId: target.providerThreadId!,
      title: "Abandoned uncertain peer target",
      status: active ? "active" as const : "idle" as const,
      ...(active && activeTurnId !== null ? { activeTurnId } : {}),
    };
    if (incoming.queue !== undefined) {
      return store.resolveQueueEffect({
        queueId: incoming.queue.id,
        expectedEvidenceDigest: effectDigest,
        resolution: "abandoned",
        resolutionEvidence,
        provider,
      });
    }
    if (direct === undefined) throw new Error("Missing direct peer recovery authority");
    const resolved = store.resolveSessionMutation({
      attemptId: direct.id,
      expectedOriginalState: "ambiguous",
      expectedEvidenceDigest: effectDigest,
      resolution: "abandoned",
      resolutionEvidence,
      provider,
    });
    store.settlePeerSessionAction({
      actionId: incoming.action.id,
      expectedState: "ambiguous",
      state: "failed",
      resultDigest: testDigest("abandoned peer nested resolution"),
    });
    return resolved;
  };
  const resolutionEvidence = () => incoming.queue === undefined
    ? store.readMutation(incomingRequest.idempotencyKey)?.resolution?.evidence
    : store.readQueueEffect(incoming.queue.id)?.resolution?.evidence;
  const changeTurn = (sessionId: SessionRecord["id"], turnId: string | null) =>
    store.setSessionTurnState({
      sessionId,
      expectedRevision: store.requireSession(sessionId).revision,
      state: turnId === null ? "idle" : "active",
      ...(turnId === null ? {} : { activeTurnId: turnId }),
    });
  const appendAbandonedSteers = (count: number) => {
    if (delivery !== "steer" || direct === undefined) throw new Error("Steer receipt corpus required");
    const receipts = [{ attemptId: direct.id, actionId: incoming.action.id, turnId: targetTurnId }];
    for (let index = 0; index < count; index += 1) {
      const turnId = `turn-peer-fence-page-${String(index)}`;
      changeTurn(target.id, turnId);
      const nextRequest = request(source.id, target.id, "steer", message);
      const action = store.admitPeerSessionAction(nextRequest).action;
      const attempt = store.prepareSessionInputMutation({
        ...daemon,
        kind: "session.steer",
        sessionId: target.id,
        providerAuthority,
        message,
        attachments: [],
        idempotencyKey: nextRequest.idempotencyKey,
      }).attempt;
      const effect = store.beginSessionMutationEffect({
        ...daemon,
        attemptId: attempt.id,
        sessionId: target.id,
        providerAuthority,
        attachments: [],
        profileGeneration: profile.processGeneration,
        message,
        transcript: {
          accountId: profile.id,
          providerGeneration: profile.processGeneration,
          providerConnectionId: "10000000-0000-4000-8000-000000000099",
          actor: "peer_session",
          message,
        },
        evidence: {
          kind: "session.steer",
          providerThreadId: target.providerThreadId!,
          clientMessageId: attempt.id,
          messageDigest: testDigest(message),
          messageActor: "peer_session",
          baseline: { providerUpdatedAt: null, status: "active", activeTurnId: turnId },
          activeTurnId: turnId,
        },
      });
      expect(store.transitionMutation(attempt.id, "effect_started", "ambiguous")).toBeTrue();
      store.quarantineSession(target.id);
      store.settlePeerSessionAction({ actionId: action.id, expectedState: "effect_started", state: "ambiguous" });
      store.resolveSessionMutation({
        attemptId: attempt.id,
        expectedOriginalState: "ambiguous",
        expectedEvidenceDigest: effect.digest,
        resolution: "abandoned",
        resolutionEvidence: baseResolutionEvidence,
        provider: {
          providerThreadId: target.providerThreadId!,
          title: "Independent historical peer turn",
          status: "idle",
        },
      });
      store.settlePeerSessionAction({
        actionId: action.id,
        expectedState: "ambiguous",
        state: "failed",
        resultDigest: testDigest("abandoned peer pagination receipt"),
      });
      receipts.push({ attemptId: attempt.id, actionId: action.id, turnId });
    }
    return receipts;
  };
  const close = () => {
    store.close();
    stores.splice(stores.indexOf(store), 1);
  };
  const reopen = () => {
    const paths = store.paths;
    close();
    store = new StateStore(paths, { now: () => now });
    stores.push(store);
  };
  const prune = () => {
    changeTurn(source.id, null);
    changeTurn(spare.id, "turn-peer-fence-maintainer");
    now += PEER_SESSION_ACTION_RETAIN_AGE_MS + 1;
    store.admitPeerSessionAction(request(spare.id, source.id, "send", "retention maintenance"));
    expect(() => store.requirePeerSessionAction(incoming.action.id)).toThrow("PEER_SESSION_NOT_FOUND");
  };
  const rewriteLegacyMarker = (marker: unknown, options: Readonly<{
    rawMarkerJson?: string;
    legacySteerTurnNull?: boolean;
  }> = {}) => {
    const paths = store.paths;
    close();
    const writer = new Database(paths.database, { create: false, strict: true });
    const table = incoming.queue === undefined ? "mutation_resolutions" : "queue_effect_resolutions";
    const identity = incoming.queue?.id ?? direct?.id;
    const column = incoming.queue === undefined ? "attempt_id" : "queue_id";
    const triggerName = `${table}_immutable_update`;
    try {
      const trigger = z.object({ sql: z.string() }).strict().parse(writer.query(
        "SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?",
      ).get(triggerName));
      const row = z.object({ evidence_json: z.string() }).strict().parse(
        writer.query(`SELECT evidence_json FROM ${table} WHERE ${column}=?`).get(identity!),
      );
      const evidence = z.record(z.string(), z.unknown()).parse(JSON.parse(row.evidence_json) as unknown);
      if (marker === undefined) delete evidence.peerCausalFence;
      else evidence.peerCausalFence = marker;
      const resolutionJson = options.rawMarkerJson === undefined
        ? JSON.stringify(evidence)
        : `${JSON.stringify(evidence).slice(0, -1)},"peerCausalFence":${options.rawMarkerJson}}`;
      // Represent a pre-fence immutable receipt or corrupt legacy value. Restore
      // the exact guard before reopening; production never rewrites a receipt.
      writer.exec(`DROP TRIGGER ${triggerName}`);
      try {
        writer.query(`UPDATE ${table} SET evidence_json=? WHERE ${column}=?`)
          .run(resolutionJson, identity!);
      } finally {
        writer.exec(trigger.sql);
      }
      if (options.legacySteerTurnNull === true) {
        if (delivery !== "steer" || direct === undefined) throw new Error("Legacy steer fixture required");
        const effectTrigger = z.object({ sql: z.string() }).strict().parse(writer.query(
          "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='mutation_effect_evidence_immutable_update'",
        ).get());
        const effectRow = z.object({ evidence_json: z.string() }).strict().parse(writer.query(
          "SELECT evidence_json FROM mutation_effect_evidence WHERE attempt_id=?",
        ).get(direct.id));
        const effect = z.record(z.string(), z.unknown()).parse(JSON.parse(effectRow.evidence_json) as unknown);
        effect.activeTurnId = null;
        const effectJson = JSON.stringify(effect);
        writer.exec("DROP TRIGGER mutation_effect_evidence_immutable_update");
        try {
          writer.query("UPDATE mutation_effect_evidence SET evidence_json=?,evidence_digest=? WHERE attempt_id=?")
            .run(effectJson, testDigest(effectJson), direct.id);
        } finally {
          writer.exec(effectTrigger.sql);
        }
      }
    } finally {
      writer.close(false);
      store = new StateStore(paths, { now: () => now });
      stores.push(store);
    }
  };
  const returnRequest = () => request(
    target.id,
    source.id,
    store.requireSession(source.id).state === "idle" ? "send" : "steer",
    "new peer return after abandonment",
  );
  return {
    abandon, appendAbandonedSteers, baseResolutionEvidence, changeTurn, completed, completedRequest,
    incoming, pending, prune, reopen, resolutionEvidence, returnRequest,
    rewriteLegacyMarker, source, spare, target, targetTurnId,
    get store() { return store; },
  };
};

export const prepareAuthorizedReset = (
  store: StateStore,
  input: Parameters<StateStore["prepareAccountRateLimitReset"]>[0],
) => {
  expect(store.authorizeAccountRateLimitResetPolicy({
    profileId: input.profileId,
    processGeneration: input.processGeneration,
    accountFingerprint: input.accountFingerprint,
    weeklyWindowDurationMinutes: 10_080,
    weeklyWindowResetsAt: input.weeklyWindowResetsAt,
  }).decision).toBe("allow");
  return store.prepareAccountRateLimitReset(input);
};

export const beginAuthorizedReset = (
  store: StateStore,
  attempt: ReturnType<StateStore["prepareAccountRateLimitReset"]>,
) => store.beginAccountRateLimitReset(
  attempt.idempotencyKey,
  store.requireProviderAccountAuthority(attempt.profileId, "codex"),
);

export function usageSnapshot(input: Readonly<{
  accountFingerprint?: string;
  fillerBytes?: number;
  lifetimeTokens: number;
  observedAt: number;
  previous: StoredAccountUsageSnapshot | null;
  providerGeneration: number;
  receivedAt: number;
  sourceSequence: number;
}>): StoredAccountUsageSnapshot {
  return createStoredAccountUsageSnapshot({
    accountFingerprint: input.accountFingerprint ?? usageFingerprint,
    daemonGeneration: 1,
    observedAt: input.observedAt,
    previousPayload: input.previous,
    providerGeneration: input.providerGeneration,
    providerPayload: {
      usage: { summary: { lifetimeTokens: input.lifetimeTokens } },
      ...(input.fillerBytes === undefined ? {} : { filler: "x".repeat(input.fillerBytes) }),
    },
    receivedAt: input.receivedAt,
    sourceSequence: input.sourceSequence,
  });
}

export async function stateFileSuffixesContaining(databasePath: string, value: string): Promise<string[]> {
  const matches: string[] = [];
  for (const suffix of ["", "-wal", "-shm"] as const) {
    const file = Bun.file(`${databasePath}${suffix}`);
    if (
      await file.exists()
      && Buffer.from(await file.arrayBuffer()).includes(Buffer.from(value))
    ) matches.push(suffix);
  }
  return matches;
}

export function moveQueueTo(store: StateStore, queueId: ReturnType<StateStore["enqueue"]>["id"], state: QueueState): void {
  if (state === "pending") return;
  if (state === "cancelled") {
    expect(store.transitionQueue(queueId, "pending", "cancelled")).toBe(true);
    return;
  }
  expect(store.transitionQueue(queueId, "pending", "dispatching")).toBe(true);
  if (state !== "dispatching") {
    expect(store.transitionQueue(queueId, "dispatching", state)).toBe(true);
  }
}

export const ownedSendFixture = async (provider: "codex" | "claude" = "codex", generation = 1) => {
  const value = await fixture();
  const { store } = value;
  const bootId = `boot_${"f".repeat(32)}`;
  const daemonGeneration = store.nextDaemonGeneration(bootId);
  const profile = store.createProfile("Original send authority");
  for (let index = 0; index < generation; index += 1) store.advanceProviderAccountProcessGeneration({
    profileId: profile.id, provider, expectedProcessGeneration: index,
  });
  if (provider === "codex" && generation > 0) store.setProfileState(profile.id, generation, "signed_in", { email: "owner@example.com", plan: "Plus" });
  const authority = store.requireProviderAccountAuthority(profile.id, provider);
  const created = store.createSession({ profileId: profile.id, provider, preset: provider === "codex" ? "high" : "fable-max", fastEnabled: false });
  const session = store.bindSession({ sessionId: created.id, expectedRevision: created.revision, providerThreadId: "owned-native-thread", state: "idle" });
  const request = { kind: "session.send" as const, session: session.id, message: "bounded original input", attachments: [], idempotencyKey: randomUUID() };
  const prepared = store.prepareOwnedSessionSend(request);
  const runtimeProfile = provider === "codex" ? reviewedCodexProfile({ id: profile.id, processGeneration: generation })
    : reviewedClaudeProfile({ id: profile.id, processGeneration: generation });
  const begin = { attemptId: prepared.owner.attemptId, ownerDigest: prepared.ownerDigest, requestFingerprint: prepared.owner.fingerprint,
    daemonGeneration, bootId, expectedSessionRevision: prepared.owner.sourceSessionRevision, executionAuthority: authority,
    evidence: { kind: "session.send" as const, providerThreadId: session.providerThreadId!, baseline: { providerUpdatedAt: null, status: "idle" as const, activeTurnId: null },
      clientMessageId: prepared.owner.attemptId, messageDigest: prepared.owner.fingerprint.inputDigest, runtimeProfile } };
  return { ...value, profile, session, authority, request, prepared, begin, runtimeProfile };
};

export const archivedRetired49 = async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "oompa-store-retired49-")));
  const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
  await initializeStatePaths(paths);
  await writeFile(paths.database, combined49RetiredDatabaseBytes(), { mode: 0o600 });
  return paths;
};

export const retiredCloseHistory = (database: Database) => {
  const tables = [
    "devin_joined_close_intents", "devin_joined_close_snapshots",
    "devin_joined_close_receipts", "devin_joined_close_anchors",
    "devin_joined_close_consumptions", "session_provider_authority_successors",
    "session_runtime_profiles",
  ] as const;
  return Object.fromEntries(tables.map((name) => [name,
    database.query(`SELECT * FROM "${name}"`).all(),
  ]));
};
