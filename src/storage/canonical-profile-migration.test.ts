import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Database, type SQLQueryBindings } from "bun:sqlite";
import { z } from "zod";

import { createAttemptId } from "../domain/values";
import {
  workApplyResultSchema, workEventPageSchema, workOperationSchema, workSnapshotSchema,
  workTaskDetailSchema, workTaskHistoryPageSchema,
} from "../domain/work";
import { LEGACY_CANONICAL_PROFILE_GUARDS_SQL } from "./canonical-profile-storage";
import { initializeStatePaths, resolveStatePaths } from "./paths";
import { StateStore } from "./state-store";
import { WorkCapabilityCodec } from "./work-capability";
import { canonicalWorkJson, type WorkDispatchOutcome } from "./work-store";

// These are real current StateStore integration fixtures, not reconstructed
// historical releases. Authentic predecessor fixtures require their own frozen
// source-bound capture; never stamp this current database with an older version.
const roots: string[] = [];
const stores = new Set<StateStore>();
const fixedNow = () => 10_000;
const storeOptions = { now: fixedNow, resolveMachineTimeZone: () => "UTC" };
const capabilityCodec = new WorkCapabilityCodec(new Uint8Array(32).fill(7));
const astraUltra = "codex:gpt-6-astra:ultra";
// Archived contract-1 fixtures retain Sol; current fixtures select Astra.
const solUltra = "codex:gpt-5.6-sol:ultra";
const lunaMax = "codex:gpt-5.6-luna:max";
const identityTables = ["sessions", "work_routes", "work_tasks", "work_attempts"] as const;
type IdentityTable = (typeof identityTables)[number];
const liveStates = ["claimed", "dispatching", "running", "recovery_required"] as const;
type AttemptState = (typeof liveStates)[number] | "released" | "submitted";

afterEach(async () => {
  for (const store of stores) store.close();
  stores.clear();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const closeStore = (store: StateStore) => {
  store.close();
  stores.delete(store);
};

const openStore = (paths: ReturnType<typeof resolveStatePaths>, readonly = false) => {
  const store = new StateStore(paths, { ...storeOptions, readonly });
  stores.add(store);
  return store;
};

function query(database: Database, sql: string, ...bindings: SQLQueryBindings[]) {
  const statement = database.prepare(sql);
  try { return statement.all(...bindings) as Record<string, unknown>[]; }
  finally { statement.finalize(); }
}

function inspect<T>(store: Pick<StateStore, "paths">, read: (database: Database) => T): T {
  const database = new Database(store.paths.database, { readonly: true, strict: true });
  try { return read(database); } finally { database.close(false); }
}

function snapshotDatabase(database: Database): string {
    const schema = query(database, "SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name");
    const rows = Object.fromEntries(schema.filter((row) => row.type === "table").map((row) => {
      const name = z.string().parse(row.name);
      return [name, query(database, `SELECT * FROM "${name.replaceAll('"', '""')}"`)
        .sort((left, right) => canonicalWorkJson(left).localeCompare(canonicalWorkJson(right)))];
    }));
    return canonicalWorkJson({ schema, rows, version: query(database, "PRAGMA user_version") });
}

function snapshot(store: Pick<StateStore, "paths">): string {
  return inspect(store, snapshotDatabase);
}

const createWorkStore = (store: StateStore) => store.createWorkStore(1,
  (payload) => `hra1.${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}.${"A".repeat(43)}`,
  {
    issue: (authority) => authority.scope === "attempt"
      ? capabilityCodec.issue({ scope: "attempt", workId: authority.workId,
          sessionId: authority.sessionId, subjectId: authority.attemptId, fence: authority.fence })
      : capabilityCodec.issue(authority),
    verify: (capability, authority) => authority.scope === "attempt"
      ? capabilityCodec.verify({ capability, scope: "attempt", workId: authority.workId,
          sessionId: authority.sessionId, subjectId: authority.attemptId, fence: authority.fence })
      : capabilityCodec.verify({ ...authority, capability }),
  });

async function fixture(state: AttemptState) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "oompa-canonical-migration-")));
  roots.push(root);
  const paths = resolveStatePaths({ homeDirectory: root, platform: "linux", rootDirectory: join(root, "state") });
  await initializeStatePaths(paths);
  const store = openStore(paths);
  store.nextDaemonGeneration(`boot_${"1".repeat(32)}`);
  const createdProfile = store.createProfile("Synthetic canonical authority");
  const profile = store.nextProfileGeneration(createdProfile.id);
  const email = "canonical-fixture@example.invalid";
  expect(store.setProfileState(profile.id, profile.processGeneration, "signed_in", { email, plan: "Plus" })).toBe(true);
  const providerAuthority = store.requireProviderAccountAuthority(profile.id, "codex");
  const projectPath = join(root, "synthetic-project");
  await mkdir(projectPath);
  const project = await store.createProject("Synthetic canonical project", projectPath, true);
  const session = store.upsertProviderSession({
    profileId: profile.id, projectId: project.id, provider: "codex", providerAuthority,
    providerThreadId: "synthetic-canonical-worker", title: "Synthetic canonical worker",
    providerAccountKey: `v1:codex:${createHash("sha256").update(email).digest("hex")}`,
    preset: "ultra", fastEnabled: false, state: "idle",
  });
  // Stabilize the existing v9 usage-authority maintenance before row comparisons.
  // This is an actual semantic reopen, not a manually inserted authority row.
  closeStore(store);
  const owner = openStore(paths);
  const work = createWorkStore(owner);
  let keySequence = 0;
  const nextKey = () => `01890f31-a123-7000-8000-${(++keySequence).toString(16).padStart(12, "0")}`;
  const created = work.apply({
    kind: "work.create", idempotencyKey: nextKey(), clientRef: "canonical-work",
    coordinatorSessionId: session.id, objective: "Keep exact persisted profile identity.",
    routes: [{ accountId: profile.id, projectId: project.id, preset: "ultra", fast: false }],
    tasks: [{ clientRef: "canonical-task", dependsOnRefs: [], dependsOnTaskIds: [],
      objective: "Preserve authority through migration and history reads.",
      instructions: "Perform no provider effect in this storage fixture.",
      criteria: ["Profile identity remains coherent."], route: { accountId: profile.id, projectId: project.id },
      preset: "ultra", fast: false, priority: 0, maxAttempts: 3, requiredReviews: 1,
      resultKind: "text", minEvidence: 0 }],
  });
  if (created.kind !== "work.create") throw new Error("Expected one created Work.");
  const task = created.tasks[0];
  if (task === undefined) throw new Error("Expected one created task.");
  const claimOperation = { kind: "task.claim", idempotencyKey: nextKey(),
    workId: created.work.id, taskId: task.id, expectedTaskRevision: task.revision,
    actorSessionId: session.id, actorCapability: created.memberCapability, leaseMs: 50_000 } as const;
  const claimed = work.apply(claimOperation);
  if (claimed.kind !== "task.claim") throw new Error("Expected one claimed attempt.");
  let dispatch: { key: string; outcome: WorkDispatchOutcome | null } | null = null;
  if (state === "released") {
    work.apply({ kind: "attempt.release", idempotencyKey: nextKey(), workId: created.work.id,
      attemptId: claimed.attempt.id, expectedAttemptRevision: claimed.attempt.revision,
      fence: claimed.attempt.fence, actorSessionId: session.id,
      attemptCapability: claimed.attemptCapability, reason: "Synthetic undispatched release." });
  } else if (state !== "claimed") {
    const key = nextKey();
    work.apply({ kind: "attempt.dispatch", idempotencyKey: key, workId: created.work.id,
      attemptId: claimed.attempt.id, expectedAttemptRevision: claimed.attempt.revision,
      fence: claimed.attempt.fence, actorSessionId: session.id,
      attemptCapability: claimed.attemptCapability, targetSessionId: session.id, mode: "send" });
    dispatch = { key, outcome: null };
    if (state !== "dispatching") {
      expect(work.authorizePreparedEffect(key).executable).toBe(true);
      const outcome: WorkDispatchOutcome = state === "recovery_required"
        ? { kind: "unknown", code: "custodian_restart" }
        : { kind: "accepted", receipt: { kind: "turn_started", turnId: `opaque_v2_${"a".repeat(64)}`,
            runtimeProfileDigest: "b".repeat(64), mutationAttemptId: createAttemptId(),
            accountGeneration: profile.processGeneration } };
      dispatch = { key, outcome };
      const settled = work.finalizeDispatch(key, outcome);
      if (state === "submitted") work.apply({ kind: "attempt.report", idempotencyKey: nextKey(),
        workId: created.work.id, attemptId: settled.id, expectedAttemptRevision: settled.revision,
        fence: settled.fence, actorSessionId: session.id, attemptCapability: claimed.attemptCapability,
        report: { kind: "submit", summary: "Synthetic result awaiting review.",
          result: { kind: "text", text: "complete" }, evidence: [] } });
    }
  }
  expect(inspect(owner, (database) => query(database, "SELECT state FROM work_attempts WHERE id=?", claimed.attempt.id)))
    .toEqual([{ state }]);
  return { store: owner, paths, project, session, workId: created.work.id,
    taskId: task.id, attemptId: claimed.attempt.id, claimOperation, dispatch };
}

function keys(store: StateStore) {
  return inspect(store, (database) => Object.fromEntries(identityTables.map((table) => [table,
    query(database, `SELECT canonical_profile_key FROM ${table}`),
  ])));
}

function workEvidence(store: StateStore): string {
  return inspect(store, (database) => {
    const tables = query(database, "SELECT name FROM sqlite_master WHERE type='table' AND (name='works' OR name GLOB 'work_*') ORDER BY name");
    return canonicalWorkJson(Object.fromEntries(tables.map((row) => {
      const table = z.string().regex(/^work[a-z_]*$/u).parse(row.name);
      return [table, query(database, `SELECT * FROM ${table}`)
        .sort((left, right) => canonicalWorkJson(left).localeCompare(canonicalWorkJson(right)))];
    })));
  });
}

function projections(store: StateStore, value: Awaited<ReturnType<typeof fixture>>) {
  const work = createWorkStore(store);
  return { task: work.task(value.taskId), history: work.taskHistory(value.taskId),
    events: work.events(value.workId), snapshot: work.snapshot(value.workId) };
}

// Negative fixtures remove and restore the exact existing trigger bytes only
// to model already-corrupt durable input. Production writers never use this.
function corruptKey(store: StateStore, table: IdentityTable, value: string | null): void {
  const database = new Database(store.paths.database, { create: false, strict: true });
  try {
    database.exec("PRAGMA foreign_keys=ON");
    const mutate = database.transaction(() => {
      const triggers = query(database, "SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name=? ORDER BY name", table);
      for (const trigger of triggers) {
        const name = z.string().regex(/^[a-z0-9_]+$/u).parse(trigger.name);
        database.exec(`DROP TRIGGER ${name}`);
      }
      const statement = database.prepare(`UPDATE ${table} SET canonical_profile_key=?`);
      try { expect(statement.run(value).changes).toBe(1); } finally { statement.finalize(); }
      for (const trigger of triggers) database.exec(z.string().parse(trigger.sql));
    });
    mutate.immediate();
  } finally { database.close(false); }
}

describe("canonical profile real-StateStore integration", () => {
  test.each(["archive", "bind", "turn", "quarantine"] as const)(
    "session projection keeps %s mutation atomic on canonical corruption", async (operation) => {
      for (const corrupt of [false, true]) {
        const root = await realpath(await mkdtemp(join(tmpdir(), "oompa-canonical-writer-")));
        roots.push(root);
        const paths = resolveStatePaths({ homeDirectory: root, platform: "linux", rootDirectory: join(root, "state") });
        await initializeStatePaths(paths);
        const store = openStore(paths);
        const profile = store.createProfile("Synthetic atomic writer");
        const session = store.createSession({ profileId: profile.id, preset: "ultra", fastEnabled: false });
        const apply = () => {
          switch (operation) {
            case "archive": return store.setSessionArchived(session.id, true);
            case "bind": return store.bindSession({ sessionId: session.id, expectedRevision: session.revision,
              providerThreadId: "synthetic-bound-thread", state: "idle" });
            case "turn": return store.setSessionTurnState({ sessionId: session.id,
              expectedRevision: session.revision, state: "idle" });
            case "quarantine": return store.quarantineSession(session.id);
          }
        };
        if (corrupt) {
          corruptKey(store, "sessions", null);
          const before = createHash("sha256").update(snapshot(store)).digest("hex");
          expect(apply).toThrow("SESSION_CANONICAL_PROFILE_CORRUPT");
          expect(createHash("sha256").update(snapshot(store)).digest("hex")).toBe(before);
        } else {
          const updated = apply();
          expect(updated.id).toBe(session.id);
          expect(updated.state).toBe(operation === "archive" ? "starting" : operation === "quarantine" ? "recovery_required" : "idle");
          expect(updated.revision).toBe(session.revision + (operation === "archive" ? 0 : 1));
          if (operation === "archive") expect(updated.archivedAt).toBe(fixedNow());
          if (operation === "bind") expect(updated.providerThreadId).toBe("synthetic-bound-thread");
          expect(inspect(store, (database) => query(database, "SELECT canonical_profile_key FROM sessions")))
            .toEqual([{ canonical_profile_key: astraUltra }]);
        }
        closeStore(store);
      }
    },
  );

  for (const state of liveStates) {
    test(`persists exact four-row keys and atomically fences ${state} session reselection`, async () => {
      const value = await fixture(state);
      expect(keys(value.store)).toEqual(Object.fromEntries(identityTables.map((table) => [table, [{ canonical_profile_key: astraUltra }]])));
      expect(inspect(value.store, (database) => query(database,
        "SELECT name,type,\"notnull\",dflt_value,hidden FROM pragma_table_xinfo('sessions') WHERE name='canonical_profile_key'")))
        .toEqual([{ name: "canonical_profile_key", type: "TEXT", notnull: 0, dflt_value: null, hidden: 0 }]);
      const before = snapshot(value.store);
      expect(() => value.store.updateSessionMetadata({ sessionId: value.session.id,
        expectedRevision: value.session.revision, preset: "low", title: "Must not commit" }))
        .toThrow("WORK_SESSION_ATTEMPT_AUTHORITY");
      expect(snapshot(value.store)).toBe(before);
      const updated = value.store.updateSessionMetadata({ sessionId: value.session.id,
        expectedRevision: value.session.revision, title: "Allowed metadata", note: "Identity unchanged." });
      expect(updated.revision).toBe(value.session.revision + 1);
      expect(keys(value.store)).toEqual(Object.fromEntries(identityTables.map((table) => [table, [{ canonical_profile_key: astraUltra }]])));
    });
  }

  for (const state of ["released", "submitted"] as const) {
    test(`retains every ${state} Work row, JSON and replay across session reselection and reopen`, async () => {
      const value = await fixture(state);
      const before = workEvidence(value.store);
      const publicBytes = canonicalWorkJson(projections(value.store, value));
      const replayBytes = canonicalWorkJson(createWorkStore(value.store).apply(value.claimOperation));
      expect(publicBytes).not.toContain("canonical_profile_key");
      expect(publicBytes).not.toContain("canonicalProfileKey");
      const selected = value.store.updateSessionMetadata({ sessionId: value.session.id,
        expectedRevision: value.session.revision, preset: "low" });
      expect(keys(value.store)).toEqual({ sessions: [{ canonical_profile_key: lunaMax }],
        work_routes: [{ canonical_profile_key: astraUltra }], work_tasks: [{ canonical_profile_key: astraUltra }],
        work_attempts: [{ canonical_profile_key: astraUltra }] });
      expect(workEvidence(value.store)).toBe(before);
      expect(canonicalWorkJson(projections(value.store, value))).toBe(publicBytes);
      expect(canonicalWorkJson(createWorkStore(value.store).apply(value.claimOperation))).toBe(replayBytes);
      closeStore(value.store);
      for (const readonly of [true, false]) {
        const reopened = openStore(value.paths, readonly);
        expect(reopened.requireSession(selected.id)).toEqual(selected);
        expect(canonicalWorkJson(projections(reopened, value))).toBe(publicBytes);
        if (!readonly) expect(canonicalWorkJson(createWorkStore(reopened).apply(value.claimOperation))).toBe(replayBytes);
        expect(workEvidence(reopened)).toBe(before);
        closeStore(reopened);
      }
    });
  }

  for (const table of identityTables) {
    for (const invalid of [null, "claude:claude-fable-5-1:max", astraUltra.toUpperCase()] as const) {
      test(`refuses ${table} ${invalid === null ? "NULL" : invalid.startsWith("claude") ? "foreign" : "case-variant"} stored identity without repairing data`, async () => {
        const value = await fixture("claimed");
        corruptKey(value.store, table, invalid);
        const before = snapshot(value.store);
        closeStore(value.store);
        const readonly = openStore(value.paths, true);
        // Exact metadata remains admissible; the bounded row reader owns debt.
        if (table === "sessions") {
          expect(() => readonly.requireSession(value.session.id)).toThrow("SESSION_CANONICAL_PROFILE_CORRUPT");
          expect(() => readonly.listSessions()).toThrow("SESSION_CANONICAL_PROFILE_CORRUPT");
          expect(() => readonly.requireSessionPresetRequirement(value.session.id)).toThrow("SESSION_CANONICAL_PROFILE_CORRUPT");
        } else {
          const work = createWorkStore(readonly);
          expect(() => work.task(value.taskId)).toThrow("WORK_CANONICAL_PROFILE_CORRUPT");
          expect(() => work.taskHistory(value.taskId)).toThrow("WORK_CANONICAL_PROFILE_CORRUPT");
          expect(() => work.snapshot(value.workId)).toThrow("WORK_CANONICAL_PROFILE_CORRUPT");
        }
        expect(snapshot(readonly)).toBe(before);
        closeStore(readonly);
        expect(() => openStore(value.paths)).toThrow(`CANONICAL_PROFILE_ROWS_${table.toUpperCase()}`);
        expect(snapshot(value.store)).toBe(before);
      });
    }
  }

  for (const damage of ["missing companion", "missing column"] as const) {
    test(`current schema refuses ${damage} on readonly and writable open without reconstruction`, async () => {
      const value = await fixture("released");
      const database = new Database(value.paths.database, { create: false, strict: true });
      try {
        if (damage === "missing companion") database.exec("DROP TRIGGER canonical_profile_session_insert_guard");
        else {
          const guards = query(database, "SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name GLOB 'canonical_profile_*' ORDER BY name");
          expect(guards).toHaveLength(7);
          const remove = database.transaction(() => {
            for (const guard of guards) database.exec(`DROP TRIGGER ${z.string().regex(/^[a-z_]+$/u).parse(guard.name)}`);
            database.exec("ALTER TABLE sessions DROP COLUMN canonical_profile_key");
            for (const guard of guards) database.exec(z.string().parse(guard.sql));
          });
          remove.immediate();
        }
      } finally { database.close(false); }
      const before = snapshot(value.store);
      closeStore(value.store);
      for (const readonly of [true, false]) {
        expect(() => openStore(value.paths, readonly)).toThrow(damage === "missing companion"
          ? "CANONICAL_PROFILE_SCHEMA_TRIGGER:canonical_profile_session_insert_guard"
          : "CANONICAL_PROFILE_SCHEMA_COLUMN:sessions");
        expect(snapshot(value.store)).toBe(before);
      }
    });
  }
});

const sqlValueSchema = z.union([z.string(), z.number().finite(), z.null()]);
const storedSnapshotSchema = z.object({
  version: z.array(z.object({ user_version: z.number().int().nonnegative() }).strict()).length(1),
  schema: z.array(z.object({ type: z.enum(["table", "index", "view", "trigger"]),
    name: z.string().regex(/^[A-Za-z0-9_]+$/u), tbl_name: z.string(), sql: z.string().nullable() }).strict()).max(1_024),
  rows: z.record(z.string().regex(/^[A-Za-z0-9_]+$/u), z.array(z.record(z.string(), sqlValueSchema)).max(512)),
}).strict();
const fixture49Schema = z.object({
  format: z.literal("hra-source-created-state49-v1"), description: z.string(),
  source: z.object({ commit: z.literal("7ab347813f8d7e4f31e9584752c801dd1ca0cda0"),
    equivalentCommit: z.literal("0787b6d9e503b831d657c495e923fae734ec998f"),
    tree: z.literal("978bdc30b6fb9d259c92d0ca91335a854227d6f4"), runtimeFiles: z.literal(180),
    runtimeManifestSha256: z.string(), stateStoreSha256: z.string(), workStoreSha256: z.string(),
    lockSha256: z.string(), packageSha256: z.string(), bunVersion: z.literal("1.3.14") }).strict(),
  generatorSha256: z.string(), fixedNow: z.literal(10_000), daemonGeneration: z.literal(1),
  publicSyntheticProject: z.literal("/private/tmp/hra-public-canonical49-profile-fixture/project"),
  usageV9Maintenance: z.string(), logicalRestoration: z.string(), payloadSha256: z.string(),
  cases: z.array(z.object({ state: z.enum(["claimed", "released", "submitted"]), sessionId: z.string(),
    workId: z.string(), taskId: z.string(), attemptId: z.string(), claim: workOperationSchema,
    replay: workApplyResultSchema, projection: z.unknown() }).strict()).length(3),
  payload: storedSnapshotSchema,
}).strict();
const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const archivedWorkProjectionSchema = z.object({
  task: workTaskDetailSchema, history: workTaskHistoryPageSchema,
  events: workEventPageSchema, snapshot: workSnapshotSchema,
}).strict();

async function source49Fixture() {
  const bytes = await readFile(join(import.meta.dir, "canonical-profile-v49.fixture.json"));
  expect(bytes.byteLength).toBe(481_688);
  expect(sha256(bytes)).toBe("ac96da7af133d3980438991a36b6051de2dfcfd764d03343f47f5f75d7f0e887");
  const fixture = fixture49Schema.parse(JSON.parse(bytes.toString("utf8")) as unknown);
  const originalRecipe = await readFile(join(import.meta.dir,
    "../../scripts/fixtures/canonical-profile-v49-generator.original.ts.txt"), "utf8");
  const currentRecipe = await readFile(join(import.meta.dir,
    "../../scripts/fixtures/canonical-profile-v49-generator.ts"), "utf8");
  // The fixture is bound to its exact archived recipe. Current type-only API
  // adaptations must preserve that recipe's emitted runtime, without importing
  // or executing either generator and without rewriting captured evidence.
  expect(sha256(originalRecipe)).toBe(fixture.generatorSha256);
  const transpiler = new Bun.Transpiler({ loader: "ts", minifyWhitespace: true });
  const originalRuntime = transpiler.transformSync(originalRecipe);
  expect(sha256(originalRuntime)).toBe("f03c5a3feaca15e037d636fe08cf5db866313a869170cb6cf0f7b8ec829ba3af");
  expect(transpiler.transformSync(currentRecipe)).toBe(originalRuntime);
  expect(sha256(canonicalWorkJson(fixture.payload))).toBe(fixture.payloadSha256);
  expect(fixture.payload.version).toEqual([{ user_version: 49 }]);
  const root = await realpath(await mkdtemp(join(tmpdir(), "oompa-source49-migration-")));
  roots.push(root);
  const paths = resolveStatePaths({ homeDirectory: root, platform: "linux", rootDirectory: join(root, "state") });
  await initializeStatePaths(paths);
  const database = new Database(paths.database, { create: true, strict: true });
  const identifier = (name: string) => `"${name.replaceAll('"', '""')}"`;
  try {
    database.exec("PRAGMA foreign_keys=OFF");
    const restore = database.transaction(() => {
      for (const object of fixture.payload.schema) {
        if (object.type === "table" && object.sql !== null && !object.name.startsWith("sqlite_")) database.exec(object.sql);
      }
      database.exec("DELETE FROM sqlite_sequence");
      for (const [table, rows] of Object.entries(fixture.payload.rows)) {
        for (const row of rows) {
          const columns = Object.keys(row);
          const statement = database.prepare(`INSERT INTO ${identifier(table)}(${columns.map(identifier).join(",")}) VALUES(${columns.map(() => "?").join(",")})`);
          try { statement.run(...columns.map((column) => sqlValueSchema.parse(row[column]))); }
          finally { statement.finalize(); }
        }
      }
      for (const object of fixture.payload.schema) {
        if (object.type !== "table" && object.sql !== null) database.exec(object.sql);
      }
      database.exec("PRAGMA user_version=49");
    });
    restore.immediate();
    expect(query(database, "PRAGMA foreign_key_check")).toEqual([]);
    expect(query(database, "PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
  } finally { database.close(false); }
  await chmod(paths.database, 0o600);
  // Full source-created schema and every row must materialize exactly before
  // invoking the new constructor. The synthetic project is never accessed.
  expect(snapshot({ paths })).toBe(canonicalWorkJson(fixture.payload));
  return { paths, fixture };
}

describe("canonical migration from authentic source-created schema49", () => {
  test("proves the additive canonical-key substep before joined60 preserves history and quarantines unproved runtime", async () => {
    const { paths, fixture } = await source49Fixture();
    const predecessor = snapshot({ paths });
    const previousColumns = inspect({ paths }, (database) => Object.fromEntries(identityTables.map((table) => [table,
      query(database, `PRAGMA table_xinfo(${table})`),
    ])));
    expect(() => openStore(paths, true)).toThrow("STATE_SCHEMA_MIGRATION_REQUIRED:49:60");
    expect(snapshot({ paths })).toBe(predecessor);
    let keyOnlySnapshot: string | undefined;
    let keyOnlyColumns: Record<string, Record<string, unknown>[]> | undefined;
    let substeps = 0;
    const originalExec = z.custom<Database["exec"]>((value) => typeof value === "function")
      .parse(Object.getOwnPropertyDescriptor(Database.prototype, "exec")?.value);
    const exec = spyOn(Database.prototype, "exec").mockImplementation(function (
      this: Database, ...args: Parameters<Database["exec"]>
    ) {
      const result = originalExec.apply(this, args);
      if (this.filename === paths.database && args[0] === LEGACY_CANONICAL_PROFILE_GUARDS_SQL) {
        expect(this.inTransaction).toBe(true);
        keyOnlySnapshot = snapshotDatabase(this);
        keyOnlyColumns = Object.fromEntries(identityTables.map((table) => [table, query(this, `PRAGMA table_xinfo(${table})`)]));
        substeps += 1;
      }
      return result;
    });
    let store: StateStore;
    try { store = openStore(paths); } finally { exec.mockRestore(); }
    expect(Object.getOwnPropertyDescriptor(Database.prototype, "exec")?.value).toBe(originalExec);
    expect(substeps).toBe(1);
    if (keyOnlySnapshot === undefined || keyOnlyColumns === undefined) throw new Error("Expected the exact canonical key substep.");
    // This is an uncommitted key-only substep, not a schema50 endpoint or a
    // claim that the complete joined60 upgrade adds only these four columns.
    const current = storedSnapshotSchema.parse(JSON.parse(keyOnlySnapshot) as unknown);
    expect(current.version).toEqual([{ user_version: 49 }]);
    expect(current.rows.migrations).toEqual(fixture.payload.rows.migrations);
    expect(current.schema).toHaveLength(fixture.payload.schema.length + 7);
    expect(keys(store)).toEqual(Object.fromEntries(identityTables.map((table) => [table,
      Array.from({ length: 3 }, () => ({ canonical_profile_key: solUltra })),
    ])));
    const originalColumns = Object.fromEntries(Object.entries(current.rows).map(([table, rows]) => [table,
      identityTables.includes(table as IdentityTable)
          ? rows.map((row) => Object.fromEntries(Object.entries(row).filter(([name]) => name !== "canonical_profile_key"))) : rows,
    ]));
    expect(canonicalWorkJson(originalColumns)).toBe(canonicalWorkJson(fixture.payload.rows));
    for (const object of fixture.payload.schema) {
      const after = current.schema.find((candidate) => candidate.name === object.name && candidate.type === object.type);
      if (object.type === "table" && identityTables.includes(object.name as IdentityTable)) {
        const sql = z.string().parse(after?.sql);
        expect(sql.split(", canonical_profile_key TEXT")).toHaveLength(2);
        expect({ ...after, sql: sql.replace(", canonical_profile_key TEXT", "") })
          .toEqual({ ...object, sql: z.string().parse(object.sql) });
        const columns = keyOnlyColumns[object.name];
        const previous = previousColumns[object.name];
        if (previous === undefined || columns === undefined) throw new Error("Expected the exact predecessor column metadata.");
        expect(columns.filter((column) => column.name !== "canonical_profile_key")).toEqual(previous);
        expect(columns.filter((column) => column.name === "canonical_profile_key")).toHaveLength(1);
      } else {
        expect(after).toEqual(object);
      }
    }
    expect(inspect(store, (database) => query(database, "PRAGMA user_version"))).toEqual([{ user_version: 60 }]);
    expect(inspect(store, (database) => query(database, "SELECT version FROM migrations ORDER BY version")))
      .toEqual(Array.from({ length: 60 }, (_, index) => ({ version: index + 1 })));
    for (const [table, rows] of Object.entries(fixture.payload.rows)) {
      const first = rows[0];
      const columns = first === undefined ? "*" : Object.keys(first).map((column) => `"${column.replaceAll('"', '""')}"`).join(",");
      const after = inspect(store, (database) => query(database,
        `SELECT ${columns} FROM "${table}"${table === "migrations" ? " WHERE version<50" : ""}`)
        .sort((left, right) => canonicalWorkJson(left).localeCompare(canonicalWorkJson(right))));
      expect(after).toEqual(rows);
    }
    // Archived adoption proof remains intact, so no session or Work row is
    // retired. Missing immutable runtime permits only these quarantine facts,
    // never a newly invented captured provider tuple or dispatch authority.
    expect(fixture.payload.rows.session_runtime_profiles).toEqual([]);
    expect(fixture.payload.rows.mutation_effect_evidence).toEqual([]);
    expect(inspect(store, (database) => query(database, "SELECT * FROM legacy_provider_authority_quarantines ORDER BY scope_id")))
      .toEqual(fixture.cases.map((entry) => ({ scope_kind: "session", scope_id: entry.sessionId,
        reason: "missing_immutable_runtime_authority", recorded_at: fixture.fixedNow }))
        .sort((left, right) => left.scope_id.localeCompare(right.scope_id)));
    expect(inspect(store, (database) => query(database, "SELECT * FROM session_provider_authorities"))).toEqual([]);
    for (const entry of fixture.cases) {
      expect(() => store.requireSessionProviderAuthority(entry.sessionId))
        .toThrow("SESSION_PROVIDER_AUTHORITY_QUARANTINED:missing_immutable_runtime_authority");
    }
    const preserved = snapshot(store);
    for (const entry of fixture.cases) {
      const work = createWorkStore(store);
      const projection = archivedWorkProjectionSchema.parse(entry.projection);
      expect(canonicalWorkJson(work.events(entry.workId))).toBe(canonicalWorkJson(projection.events));
      expect(canonicalWorkJson(work.apply(entry.claim))).toBe(canonicalWorkJson(entry.replay));
      if (entry.state !== "claimed") {
        expect(canonicalWorkJson({ task: work.task(entry.taskId), history: work.taskHistory(entry.taskId),
          events: work.events(entry.workId), snapshot: work.snapshot(entry.workId) })).toBe(canonicalWorkJson(entry.projection));
      }
    }
    expect(snapshot(store)).toBe(preserved);
    closeStore(store);
    for (const readonly of [true, false]) {
      const reopened = openStore(paths, readonly);
      expect(snapshot(reopened)).toBe(preserved);
      closeStore(reopened);
    }

    // Live task access is not a passive archive read: it sweeps unproved
    // controller authority. Prove that later transition separately from the
    // exact migration/reopen preservation above, without inventing a runtime.
    const claimed = fixture.cases.find((entry) => entry.state === "claimed");
    if (claimed === undefined) throw new Error("Expected the archived claimed case.");
    const beforeRead = archivedWorkProjectionSchema.parse(claimed.projection);
    const priorAttempt = beforeRead.task.latestAttempt;
    if (priorAttempt === null) throw new Error("Expected the original claimed attempt.");
    expect(beforeRead.task.activeAttempt).toEqual(priorAttempt);
    expect(priorAttempt.status).toBe("claimed");
    expect(beforeRead.history.items).toEqual([{ kind: "attempt", value: priorAttempt }]);
    expect(beforeRead.snapshot.tasks).toEqual([beforeRead.task.task]);
    const currentStore = openStore(paths);
    const work = createWorkStore(currentStore);
    const releasedAttempt = { ...priorAttempt, status: "released", revision: priorAttempt.revision + 1,
      leaseExpiresAt: null };
    const readyTask = { ...beforeRead.task.task, activeAttemptId: null, status: "ready",
      revision: beforeRead.task.task.revision + 1 };
    expect(canonicalWorkJson(work.task(claimed.taskId))).toBe(canonicalWorkJson({ ...beforeRead.task,
      activeAttempt: null, latestAttempt: releasedAttempt, task: readyTask }));
    const releaseReason = "Pinned session or account authority changed before dispatch.";
    const releaseDigest = sha256(canonicalWorkJson(releaseReason));
    expect(releaseDigest).toBe("2f811f5c6f8fc0f23acaee8ad4447323aa1a144226acd0999e1ab3725566a484");
    const sequence = beforeRead.events.events.length + 1;
    const cursor = `hra1.${Buffer.from(JSON.stringify({ version: 1, type: "work", workId: claimed.workId,
      streamEpoch: beforeRead.events.streamEpoch, sequence }), "utf8").toString("base64url")}.${"A".repeat(43)}`;
    const releaseEvent = { version: 1, workId: claimed.workId, streamEpoch: beforeRead.events.streamEpoch,
      sequence, occurredAt: fixture.fixedNow, actorSessionId: claimed.sessionId,
      body: { type: "attempt.released", attemptId: claimed.attemptId, summaryDigest: releaseDigest } };
    expect(canonicalWorkJson(work.events(claimed.workId))).toBe(canonicalWorkJson({ ...beforeRead.events,
      events: [...beforeRead.events.events, releaseEvent], nextCursor: cursor, observedThroughCursor: cursor }));
    expect(canonicalWorkJson(work.taskHistory(claimed.taskId))).toBe(canonicalWorkJson({ ...beforeRead.history,
      items: [{ kind: "attempt", value: releasedAttempt }], taskRevision: readyTask.revision,
      observedThroughCursor: cursor }));
    expect(canonicalWorkJson(work.snapshot(claimed.workId))).toBe(canonicalWorkJson({ ...beforeRead.snapshot,
      cursor, tasks: [readyTask], work: { ...beforeRead.snapshot.work,
        revision: beforeRead.snapshot.work.revision + 1, activeTaskCount: 0, readyTaskCount: 1 } }));
    // Terminal projection removes live lease authority, while the durable
    // attempt retains its original deadline as historical evidence.
    expect(inspect(currentStore, (database) => query(database,
      "SELECT state,revision,lease_expires_at,terminal_at FROM work_attempts WHERE id=?", claimed.attemptId)))
      .toEqual([{ state: "released", revision: priorAttempt.revision + 1, lease_expires_at: priorAttempt.leaseExpiresAt,
        terminal_at: fixture.fixedNow }]);
    expect(inspect(currentStore, (database) => query(database,
      "SELECT state,revision,retry_not_before FROM work_task_states WHERE task_id=?", claimed.taskId)))
      .toEqual([{ state: "pending", revision: readyTask.revision, retry_not_before: null }]);
    for (const table of ["work_idempotency_intents", "work_prepared_effects", "mutation_attempts",
      "mutation_effect_evidence", "queue_effect_evidence"]) {
      const original = fixture.payload.rows[table];
      if (original === undefined) throw new Error("Expected the original effect/receipt table.");
      expect(inspect(currentStore, (database) => query(database, `SELECT * FROM ${table}`)
        .sort((left, right) => canonicalWorkJson(left).localeCompare(canonicalWorkJson(right)))))
        .toEqual(original);
    }
    const afterRelease = snapshot(currentStore);
    // Stored intent JSON/digests above remain immutable. Public replay overlays
    // current liveness, so it must not revive the original claimed projection.
    expect(canonicalWorkJson(work.apply(claimed.claim))).toBe(canonicalWorkJson({ ...claimed.replay,
      attempt: releasedAttempt, task: readyTask, workRevision: beforeRead.snapshot.work.revision + 1 }));
    expect(snapshot(currentStore)).toBe(afterRelease);
    closeStore(currentStore);
    for (const readonly of [true, false]) {
      const reopened = openStore(paths, readonly);
      expect(snapshot(reopened)).toBe(afterRelease);
      closeStore(reopened);
    }
  });

  for (const table of identityTables) {
    for (const declaration of ["canonical_profile_key TEXT", "CANONICAL_PROFILE_KEY TEXT", "canonical_profile_key TEXT GENERATED ALWAYS AS ('collision') VIRTUAL"] as const) {
      test(`refuses ${table} predecessor column collision ${declaration} before changing any evidence`, async () => {
        const { paths } = await source49Fixture();
        const database = new Database(paths.database, { create: false, strict: true });
        try { database.exec(`ALTER TABLE ${table} ADD COLUMN ${declaration}`); } finally { database.close(false); }
        const before = snapshot({ paths });
        expect(() => openStore(paths)).toThrow("CANONICAL_PROFILE_PREDECESSOR_COLUMN_COLLISION");
        expect(snapshot({ paths })).toBe(before);
      });
    }
  }

  for (const sql of [
    "CREATE TABLE Canonical_Profile_Session_Insert_Guard(value TEXT) STRICT",
    "CREATE VIEW canonical_profile_work_task_insert_guard AS SELECT 1 AS value",
    "CREATE INDEX canonical_profile_work_attempt_immutable_guard ON sessions(title)",
    "CREATE TRIGGER canonical_profile_session_live_attempt_guard AFTER UPDATE ON sessions BEGIN SELECT 1; END",
  ]) {
    test(`refuses predecessor object collision ${sql.split(" ").slice(0, 3).join(" ")}`, async () => {
      const { paths } = await source49Fixture();
      const database = new Database(paths.database, { create: false, strict: true });
      try { database.exec(sql); } finally { database.close(false); }
      const before = snapshot({ paths });
      expect(() => openStore(paths)).toThrow("CANONICAL_PROFILE_PREDECESSOR_OBJECT_COLLISION");
      expect(snapshot({ paths })).toBe(before);
    });
  }

  test("rolls back a partially installed companion and permits an intact schema49 retry", async () => {
    const { paths, fixture } = await source49Fixture();
    const before = snapshot({ paths });
    const allColumns = () => inspect({ paths }, (database) => canonicalWorkJson(Object.fromEntries(
      query(database, "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").map((row) => {
        const name = z.string().regex(/^[A-Za-z0-9_]+$/u).parse(row.name);
        return [name, query(database, `PRAGMA table_xinfo("${name}")`)];
      }),
    )));
    const beforeColumns = allColumns();
    const nextGuard = LEGACY_CANONICAL_PROFILE_GUARDS_SQL.indexOf("\nCREATE TRIGGER canonical_profile_session_update_guard");
    expect(nextGuard).toBeGreaterThan(0);
    const firstGuard = LEGACY_CANONICAL_PROFILE_GUARDS_SQL.slice(0, nextGuard);
    const marker = "FIXTURE_CANONICAL_PARTIAL_GUARD_REFUSAL";
    const originalExec = z.custom<Database["exec"]>((value) => typeof value === "function")
      .parse(Object.getOwnPropertyDescriptor(Database.prototype, "exec")?.value);
    let partialInstalls = 0;
    // Intercept only this constructor's exact companion batch. Execute its
    // real first statement before throwing, so rollback must undo actual DDL
    // and the already completed key backfill, not merely a pre-install fault.
    const exec = spyOn(Database.prototype, "exec").mockImplementation(function (
      this: Database, ...args: Parameters<Database["exec"]>
    ) {
      if (this.filename !== paths.database || args[0] !== LEGACY_CANONICAL_PROFILE_GUARDS_SQL) {
        return originalExec.apply(this, args);
      }
      originalExec.call(this, firstGuard);
      expect(this.inTransaction).toBe(true);
      expect(query(this, "SELECT name FROM main.sqlite_master WHERE name GLOB 'canonical_profile_*' ORDER BY name"))
        .toEqual([{ name: "canonical_profile_session_insert_guard" }]);
      expect(query(this, "PRAGMA user_version")).toEqual([{ user_version: 49 }]);
      expect(query(this, "SELECT MAX(version) AS version FROM migrations")).toEqual([{ version: 49 }]);
      for (const table of identityTables) {
        expect(query(this, `SELECT canonical_profile_key FROM ${table}`))
          .toEqual(fixture.cases.map(() => ({ canonical_profile_key: solUltra })));
      }
      partialInstalls += 1;
      throw new Error(marker);
    });
    try {
      // No await occurs while the prototype spy is installed.
      expect(() => openStore(paths)).toThrow(marker);
    } finally { exec.mockRestore(); }
    expect(Object.getOwnPropertyDescriptor(Database.prototype, "exec")?.value).toBe(originalExec);
    expect(partialInstalls).toBe(1);
    // Includes every table, immutable Work JSON/digest, original guard, ledger
    // row and user_version; xinfo separately proves no column metadata leaked.
    expect(snapshot({ paths })).toBe(before);
    expect(allColumns()).toBe(beforeColumns);
    const store = openStore(paths);
    expect(inspect(store, (database) => query(database, "PRAGMA user_version"))).toEqual([{ user_version: 60 }]);
    expect(inspect(store, (database) => query(database,
      "SELECT name FROM main.sqlite_master WHERE type='trigger' AND name GLOB 'canonical_profile_*'"))).toHaveLength(7);
    expect(keys(store)).toEqual(Object.fromEntries(identityTables.map((table) => [table,
      fixture.cases.map(() => ({ canonical_profile_key: solUltra })),
    ])));
  });

  for (const stage of ["backfill", "ledger"] as const) {
    test(`rolls back every row, column and exact guard after ${stage} failure`, async () => {
      const { paths } = await source49Fixture();
      const database = new Database(paths.database, { create: false, strict: true });
      const marker = stage === "backfill" ? "FIXTURE_CANONICAL_BACKFILL_REFUSAL" : "FIXTURE_CANONICAL_LEDGER_REFUSAL";
      try {
        database.exec(stage === "backfill"
          ? `CREATE TRIGGER fixture_canonical_backfill_abort BEFORE UPDATE ON work_routes BEGIN SELECT RAISE(ABORT,'${marker}'); END`
          : `CREATE TRIGGER fixture_canonical_ledger_abort BEFORE INSERT ON migrations WHEN NEW.version=50 BEGIN SELECT RAISE(ABORT,'${marker}'); END`);
      } finally { database.close(false); }
      const before = snapshot({ paths });
      // Bun's multi-statement backfill reaches the mandatory row proof after
      // the injected route UPDATE aborts. That fixed boundary error, not raw
      // SQLite text, is the observable refusal. Ledger failure is single-step.
      expect(() => openStore(paths)).toThrow(stage === "backfill" ? "CANONICAL_PROFILE_ROWS_WORK_ROUTES" : marker);
      expect(snapshot({ paths })).toBe(before);
    });
  }
});
