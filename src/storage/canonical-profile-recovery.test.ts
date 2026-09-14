import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Database, type SQLQueryBindings } from "bun:sqlite";
import { z } from "zod";

import { currentPresetContract } from "../domain/presets";
import { initializeStatePaths, resolveStatePaths } from "./paths";
import { sessionStartMutationRequest, StateStore } from "./state-store";
import { canonicalWorkJson } from "./work-store";

// Current, public-synthetic semantic fixtures. No historical release, provider
// process, or real authentication is represented by these storage-only tests.
const roots: string[] = [];
const stores = new Set<StateStore>();
const canonicalKey = "codex:gpt-6-astra:max";
const corruptKeys = [null, "foreign:profile", "CODEX:gpt-6-astra:max"] as const;

afterEach(async () => {
  for (const store of stores) store.close();
  stores.clear();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function query(database: Database, sql: string, ...bindings: SQLQueryBindings[]) {
  const statement = database.prepare(sql);
  try { return statement.all(...bindings) as Record<string, unknown>[]; }
  finally { statement.finalize(); }
}

function inspect<T>(store: StateStore, read: (database: Database) => T): T {
  const database = new Database(store.paths.database, { readonly: true, strict: true });
  try { return read(database); } finally { database.close(false); }
}

// Hash the complete logical database, not just the session row: failed recovery
// must also preserve queue/evidence/profile/ledger rows and every schema object.
function snapshot(store: StateStore): string {
  return inspect(store, (database) => {
    const schema = query(database, "SELECT type,name,tbl_name,sql FROM main.sqlite_master ORDER BY type,name");
    const rows = Object.fromEntries(schema.filter((row) => row.type === "table").map((row) => {
      const name = z.string().regex(/^[a-z0-9_]+$/u).parse(row.name);
      return [name, query(database, `SELECT * FROM main.${name}`)
        .sort((left, right) => canonicalWorkJson(left).localeCompare(canonicalWorkJson(right)))];
    }));
    return createHash("sha256").update(canonicalWorkJson({ schema, rows,
      version: query(database, "PRAGMA user_version") })).digest("hex");
  });
}

function corruptSessionKey(store: StateStore, sessionId: string, key: string | null): void {
  const database = new Database(store.paths.database, { create: false, strict: true });
  try {
    database.exec("PRAGMA foreign_keys=ON");
    const schemaBefore = query(database, "SELECT type,name,tbl_name,sql FROM main.sqlite_master ORDER BY type,name");
    const guard = z.object({ sql: z.string() }).strict().parse(database.query(
      "SELECT sql FROM main.sqlite_master WHERE type='trigger' AND name='canonical_profile_session_update_guard' AND tbl_name='sessions'",
    ).get());
    const damage = database.transaction(() => {
      database.exec("DROP TRIGGER canonical_profile_session_update_guard");
      try {
        expect(database.query("UPDATE sessions SET canonical_profile_key=? WHERE id=?")
          .run(key, sessionId).changes).toBe(1);
      } finally { database.exec(guard.sql); }
    });
    damage.immediate();
    expect(query(database, "SELECT type,name,tbl_name,sql FROM main.sqlite_master ORDER BY type,name"))
      .toEqual(schemaBefore);
    expect(query(database, "PRAGMA foreign_key_check")).toEqual([]);
  } finally { database.close(false); }
}

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "oompa-canonical-recovery-")));
  roots.push(root);
  const paths = resolveStatePaths({ homeDirectory: root, platform: "linux", rootDirectory: join(root, "state") });
  await initializeStatePaths(paths);
  const store = new StateStore(paths, { now: () => 10_000, resolveMachineTimeZone: () => "UTC" });
  stores.add(store);
  store.nextDaemonGeneration(`boot_${"1".repeat(32)}`);
  const created = store.createProfile("Synthetic recovery authority");
  const profile = store.nextProfileGeneration(created.id);
  const email = "canonical-recovery@example.invalid";
  expect(store.setProfileState(profile.id, profile.processGeneration, "signed_in", { email, plan: "Plus" })).toBe(true);
  const providerAuthority = store.requireProviderAccountAuthority(profile.id, "codex");
  const providerAccountKey = `v1:codex:${createHash("sha256").update(email).digest("hex")}`;
  const projectPath = join(root, "synthetic-project");
  await mkdir(projectPath);
  const project = await store.createProject("Synthetic recovery project", projectPath, true);
  const runtimeProfile = {
    profileId: profile.id, processGeneration: profile.processGeneration, observedAt: 2_000,
    preset: "high" as const, model: "gpt-6-astra", reasoningEffort: "max" as const,
    serviceTier: null, fast: false, approvalPolicy: "on-request" as const,
    reviewMode: "auto_review" as const, permissionProfile: ":workspace" as const,
    computerUse: true as const, pluginCapability: true as const, enabledApps: [],
  };
  return { store, profile, project, providerAccountKey, runtimeProfile, providerAuthority };
}

async function queueFixture() {
  const value = await fixture();
  const { store, profile, project, providerAccountKey, runtimeProfile, providerAuthority } = value;
  const session = store.upsertProviderSession({
    profileId: profile.id, projectId: project.id, provider: "codex",
    providerThreadId: "synthetic-queue-thread", title: "Synthetic queue session",
    providerAccountKey, providerAuthority, preset: "high", fastEnabled: false, state: "idle", providerUpdatedAt: 10,
  });
  const message = "Synthetic uncertain queue dispatch.";
  const providerConnectionId = "10000000-0000-4000-8000-000000000009";
  const queue = store.enqueueIdempotent({ sessionId: session.id, message, idempotencyKey: crypto.randomUUID(),
    profileGeneration: providerAuthority.processGeneration, providerAuthority, providerConnectionId });
  const evidence = store.beginQueueEffect({
    queueId: queue.id, sessionId: session.id, profileGeneration: profile.processGeneration,
    providerAuthority, providerConnectionId,
    evidence: {
      kind: "queue.dispatch", queueId: queue.id, sessionId: session.id,
      providerThreadId: "synthetic-queue-thread", profileGeneration: profile.processGeneration,
      baseline: { providerUpdatedAt: 10, status: "idle", activeTurnId: null },
      clientMessageId: queue.id, messageDigest: createHash("sha256").update(message).digest("hex"),
      runtimeProfile,
    },
  });
  expect(store.requireQueue(queue.id).state).toBe("dispatching");
  return { ...value, session, queue, evidence };
}

async function startFixture() {
  const value = await fixture();
  const { store, profile, project, providerAccountKey, runtimeProfile, providerAuthority } = value;
  const attempt = store.prepareMutation({
    authorityGeneration: profile.processGeneration, authorityId: profile.id,
    idempotencyKey: "00000000-0000-4000-8000-0000000006c0", kind: "session.start",
    request: sessionStartMutationRequest({ projectId: project.id, provider: "codex",
      preset: "high", presetContract: currentPresetContract, fast: false }),
    providerAuthorities: [{ role: "primary", authority: providerAuthority, provenance: "session_start" }],
  });
  const session = store.beginSessionStartEffect({
    attemptId: attempt.id, profileId: profile.id, profileGeneration: profile.processGeneration,
    projectId: project.id, provider: "codex", providerAccountKey, providerAuthority, preset: "high", fastEnabled: false,
    evidence: { clientMessageId: null, kind: "session.start", messageDigest: null,
      presetContract: currentPresetContract, projectId: project.id, runtimeProfile },
  });
  // A real, already-retained source record takes #insertSessionRuntimeProfile's
  // historical replay branch. Do not fabricate its row, JSON, or digest.
  const recordInput = { sessionId: session.id, sourceKind: "session_start" as const,
    sourceId: attempt.id, profile: runtimeProfile, providerAuthority };
  const retained = store.recordSessionRuntimeProfile(recordInput);
  expect(store.recordSessionRuntimeProfile(recordInput)).toEqual(retained);
  const bind = { attemptId: attempt.id, sessionId: session.id,
    expectedSessionRevision: session.revision, providerThreadId: "synthetic-start-recovery-thread",
    title: "Synthetic recovery target", runtimeProfile };
  return { ...value, attempt, session, retained, recordInput, bind };
}

describe("canonical session recovery writes", () => {
  test.each([...corruptKeys])("queue ambiguity refuses corrupt key %s without committing any rows", async (key) => {
    const { store, session, queue, evidence } = await queueFixture();
    corruptSessionKey(store, session.id, key);
    const before = snapshot(store);
    expect(() => store.markQueueEffectAmbiguous(queue.id, evidence.digest))
      .toThrow("SESSION_CANONICAL_PROFILE_CORRUPT");
    expect(snapshot(store)).toBe(before);
    expect(store.requireQueue(queue.id).state).toBe("dispatching");
  });

  test("queue ambiguity preserves its exact evidence refusal before corrupt projection", async () => {
    const { store, session, queue, evidence } = await queueFixture();
    corruptSessionKey(store, session.id, null);
    const before = snapshot(store);
    const wrongDigest = "0".repeat(64);
    expect(wrongDigest).not.toBe(evidence.digest);
    expect(() => store.markQueueEffectAmbiguous(queue.id, wrongDigest))
      .toThrow("QUEUE_EFFECT_EVIDENCE_MISMATCH");
    expect(snapshot(store)).toBe(before);
  });

  test("healthy queue ambiguity still commits recovery and preserves evidence bytes", async () => {
    const { store, session, queue, evidence } = await queueFixture();
    const evidenceBefore = inspect(store, (database) => query(database, "SELECT * FROM queue_effect_evidence"));
    const result = store.markQueueEffectAmbiguous(queue.id, evidence.digest);
    expect(result).toMatchObject({ id: session.id, state: "recovery_required", revision: session.revision + 1 });
    expect(store.requireQueue(queue.id).state).toBe("ambiguous");
    expect(inspect(store, (database) => query(database, "SELECT * FROM queue_effect_evidence"))).toEqual(evidenceBefore);
    expect(inspect(store, (database) => query(database, "SELECT canonical_profile_key FROM sessions")))
      .toEqual([{ canonical_profile_key: canonicalKey }]);
  });

  test.each([...corruptKeys])("start recovery with retained runtime replay refuses corrupt key %s atomically", async (key) => {
    const { store, session, bind } = await startFixture();
    corruptSessionKey(store, session.id, key);
    const before = snapshot(store);
    expect(() => store.bindSessionStartRecoveryTarget(bind)).toThrow("SESSION_CANONICAL_PROFILE_CORRUPT");
    expect(snapshot(store)).toBe(before);
    expect(inspect(store, (database) => query(database,
      "SELECT state,provider_thread_id,revision FROM sessions WHERE id=?", session.id)))
      .toEqual([{ state: "starting", provider_thread_id: null, revision: session.revision }]);
  });

  test.each(["revision", "evidence"] as const)("start recovery keeps exact %s refusal ahead of corrupt projection", async (damage) => {
    const { store, session, bind } = await startFixture();
    corruptSessionKey(store, session.id, null);
    const before = snapshot(store);
    const operation = damage === "revision"
      ? { ...bind, expectedSessionRevision: bind.expectedSessionRevision + 1 }
      : { ...bind, runtimeProfile: { ...bind.runtimeProfile, observedAt: bind.runtimeProfile.observedAt + 1 } };
    expect(() => store.bindSessionStartRecoveryTarget(operation)).toThrow(damage === "revision"
      ? "SESSION_START_RECOVERY_TARGET_CAS_CONFLICT" : "SESSION_START_RECOVERY_TARGET_MISMATCH");
    expect(snapshot(store)).toBe(before);
  });

  test("healthy start recovery reuses retained runtime bytes without creating a second profile", async () => {
    const { store, session, bind, retained, recordInput } = await startFixture();
    const profileBefore = inspect(store, (database) => query(database, "SELECT * FROM session_runtime_profiles"));
    const evidenceBefore = inspect(store, (database) => query(database, "SELECT * FROM mutation_effect_evidence"));
    const result = store.bindSessionStartRecoveryTarget(bind);
    expect(result).toMatchObject({ id: session.id, state: "recovery_required",
      revision: session.revision + 1, providerThreadId: bind.providerThreadId });
    expect(store.recordSessionRuntimeProfile(recordInput)).toEqual(retained);
    expect(inspect(store, (database) => query(database, "SELECT * FROM session_runtime_profiles"))).toEqual(profileBefore);
    expect(inspect(store, (database) => query(database, "SELECT * FROM mutation_effect_evidence"))).toEqual(evidenceBefore);
    expect(inspect(store, (database) => query(database, "SELECT canonical_profile_key FROM sessions")))
      .toEqual([{ canonical_profile_key: canonicalKey }]);
  });
});
