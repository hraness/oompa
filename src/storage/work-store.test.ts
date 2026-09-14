import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";

import {
  createAttemptId,
  createProfileId,
  createProjectId,
  createQueueId,
  createSessionId,
  type ProfileId,
  type ProjectId,
  type SessionId,
} from "../domain/values";
import {
  WORK_APPLY_REQUEST_LEGACY_VERSION,
  WORK_APPLY_REQUEST_VERSION,
  WORK_HISTORY_EVENT_LIMIT,
  WORK_HISTORY_RECOVERY_RESERVE,
  WORK_INLINE_RESULT_MAX_BYTES,
  WORK_OPERATION_BATCH_LIMIT,
  WORK_SIGNAL_MAX_BYTES,
  WORK_SNAPSHOT_MAX_BYTES,
  WORK_TASK_DETAIL_MAX_BYTES,
  WORK_TASK_HISTORY_PAGE_MAX_BYTES,
  WORK_TASK_HISTORY_TOTAL_ITEM_LIMIT,
  WORK_TOMBSTONE_LIMIT,
  workTaskHistoryPageSchema,
  type WorkActionCursorPayload,
  type WorkOperation,
  type WorkPreparedEffect,
  type WorkTaskHistoryCursorPayload,
  type WorkTaskSpec,
} from "../domain/work";
import { workReadSuccessWireBytes } from "../domain/terminal-json";
import { presetRequirements } from "../domain/presets";
import { effectiveRuntimeProfileSchema } from "../domain/runtime-profile";
import {
  LEGACY_CANONICAL_PROFILE_COLUMNS_SQL,
  LEGACY_CANONICAL_PROFILE_GUARDS_SQL,
  assertLegacyCanonicalProfileRows,
  deriveLegacySessionProfileKey,
  deriveLegacyWorkProfileKey,
} from "./canonical-profile-storage";
import { initializeStatePaths, resolveStatePaths } from "./paths";
import { applySessionSendOwnerSchema, SESSION_SEND_REQUEST_FORMAT } from "./session-send-owner";
import { StateStore } from "./state-store";
import {
  WORK_PROJECT_AUTHORITY_SCHEMA_SQL,
  WORK_SCHEMA_SQL,
  WORK_SIGNAL_PROVIDER_AUTHORITY_SCHEMA_SQL,
  WorkStore,
  WorkStoreError,
  assertProviderVersion40WorkSchema,
  assertReadonlyWorkSchema,
  assertWorkSignalProviderAuthorities,
  assertWorkSchema,
  backfillLegacyWorkSignalProviderAuthorities,
  canonicalWorkJson,
  installProviderVersion40WorkAuthoritySchema,
  workPreparedEffectMessage,
} from "./work-store";

const databases: Database[] = [];
const stateStores: StateStore[] = [];
const capability = `hrac1_${"A".repeat(43)}`;
const codexAccountKey = (email: string): string =>
  `v1:codex:${createHash("sha256").update(email.trim().toLowerCase()).digest("hex")}`;
const claudeAccountKey = (identity: string): string =>
  `v1:claude:${createHash("sha256").update(identity).digest("hex")}`;

let uuidV7Sequence = 0;

function randomUUID(): string {
  const timestamp = "01890f31a123";
  const suffix = (++uuidV7Sequence).toString(16).padStart(12, "0").slice(-12);
  return `${timestamp.slice(0, 8)}-${timestamp.slice(8)}-7000-8000-${suffix}`;
}

const requestDigest = (value: unknown): string => createHash("sha256")
  .update(canonicalWorkJson(value))
  .digest("hex");

function rewriteIntentDigest(
  value: Fixture,
  idempotencyKey: string,
  digest: string,
): void {
  value.database.exec("DROP TRIGGER work_intents_no_update;");
  try {
    value.database.query(
      "UPDATE work_idempotency_intents SET request_digest=? WHERE idempotency_key=?",
    ).run(digest, idempotencyKey);
  } finally {
    value.database.exec(WORK_SCHEMA_SQL);
  }
}

function rewriteWorkPresetContract(value: Fixture, workId: string, contract: 1 | 2): void {
  // A reduced historical fixture, not an untouched old-release artifact.
  // Change only immutable identity before attempts exist, atomically restoring
  // every exact legacy guard. Existing JSON, revisions and digests stay frozen.
  value.database.transaction(() => {
    expect(value.database.query(
      "SELECT COUNT(*) AS count FROM work_attempts WHERE work_id=?",
    ).get(workId)).toEqual({ count: 0 });
    const guards = ["works_identity_immutable", "work_routes_no_update", "work_tasks_no_update"]
      .map((name) => {
        const row = value.database.query(
          "SELECT sql FROM sqlite_schema WHERE type='trigger' AND name=?",
        ).get(name) as { sql: string } | null;
        if (row === null) throw new Error("fixture guard missing");
        return { name, sql: row.sql };
      });
    for (const guard of guards) value.database.exec(`DROP TRIGGER ${guard.name}`);
    value.database.query("UPDATE works SET preset_contract=? WHERE id=?")
      .run(contract, workId);
    for (const table of ["work_routes", "work_tasks"] as const) {
      const rows = value.database.query(
        `SELECT DISTINCT preset FROM ${table} WHERE work_id=?`,
      ).all(workId) as Array<{ preset: unknown }>;
      for (const row of rows) {
        const key = deriveLegacyWorkProfileKey(row.preset, contract);
        if (key === null || typeof row.preset !== "string") throw new Error("fixture profile invalid");
        value.database.query(
          `UPDATE ${table} SET canonical_profile_key=? WHERE work_id=? AND preset=?`,
        ).run(key, workId, row.preset);
      }
    }
    for (const guard of guards) value.database.exec(guard.sql);
    assertLegacyCanonicalProfileRows(value.database);
  }).immediate();
}

function setSessionProfile(
  value: Fixture,
  sessionId: string,
  next: Readonly<{ provider?: "codex" | "claude" | "devin"; preset?: "low" | "high" | "ultra"; contract?: 1 | 2 }>,
): void {
  const prior = value.database.query(
    "SELECT provider_v39,preset,preset_contract FROM sessions WHERE id=?",
  ).get(sessionId) as { provider_v39: string; preset: string; preset_contract: number } | null;
  if (prior === null) throw new Error("fixture session missing");
  const provider = next.provider ?? prior.provider_v39;
  const preset = next.preset ?? prior.preset;
  const contract = next.contract ?? prior.preset_contract;
  const key = deriveLegacySessionProfileKey(provider, preset, contract);
  if (key === null) throw new Error("fixture session profile invalid");
  value.database.query(
    `UPDATE sessions SET provider_v39=?,preset=?,preset_contract=?,canonical_profile_key=? WHERE id=?`,
  ).run(provider, preset, contract, key, sessionId);
}

function withFixtureGuardsRemoved(value: Fixture, names: readonly string[], action: () => void): void {
  value.database.transaction(() => {
    const guards = names.map((name) => {
      const row = value.database.query(
        "SELECT sql FROM sqlite_schema WHERE type='trigger' AND name=?",
      ).get(name) as { sql: string } | null;
      if (row === null) throw new Error("fixture guard missing");
      return { name, sql: row.sql };
    });
    for (const guard of guards) value.database.exec(`DROP TRIGGER ${guard.name}`);
    try {
      action();
    } finally {
      for (const guard of guards) value.database.exec(guard.sql);
    }
  }).immediate();
}

function queueReceipt(accountGeneration = 1) {
  return {
    kind: "queue_created" as const,
    queueId: createQueueId(),
    mutationAttemptId: createAttemptId(),
    accountGeneration,
  };
}

function turnStartedReceipt(accountGeneration = 1) {
  return {
    kind: "turn_started" as const,
    turnId: `opaque_v2_${"a".repeat(64)}`,
    runtimeProfileDigest: "b".repeat(64),
    mutationAttemptId: createAttemptId(),
    accountGeneration,
  };
}

afterEach(() => {
  for (const store of stateStores.splice(0)) store.close();
  for (const database of databases.splice(0)) database.close(false);
});

type Fixture = Readonly<{
  accountId: ProfileId;
  actorSessionId: SessionId;
  database: Database;
  now: { value: number };
  projectId: ProjectId;
  reviewerSessionId: SessionId;
  store: WorkStore;
}>;

const parentSchema = `
CREATE TABLE profiles(
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  process_generation INTEGER NOT NULL,
  provider_email TEXT,
  codex_account_key TEXT
) STRICT;
CREATE TABLE projects(
  id TEXT PRIMARY KEY
) STRICT;
CREATE TABLE sessions(
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  provider TEXT NOT NULL DEFAULT 'codex',
  provider_v39 TEXT NOT NULL DEFAULT 'codex',
  provider_thread_id TEXT,
  preset TEXT NOT NULL,
  preset_contract INTEGER NOT NULL DEFAULT 1 CHECK(preset_contract IN (1,2)),
  fast_enabled INTEGER NOT NULL,
  state TEXT NOT NULL
) STRICT;
CREATE TABLE provider_accounts(
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  provider TEXT NOT NULL,
  binding_generation INTEGER NOT NULL,
  process_generation INTEGER NOT NULL,
  readiness TEXT NOT NULL,
  UNIQUE(profile_id,provider)
) STRICT;
CREATE TABLE session_provider_authorities(
  session_id TEXT PRIMARY KEY REFERENCES sessions(id),
  provider_account_id TEXT NOT NULL REFERENCES provider_accounts(id),
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  provider TEXT NOT NULL,
  binding_generation INTEGER NOT NULL,
  process_generation INTEGER NOT NULL,
  authority_revision INTEGER NOT NULL,
  routing_provenance TEXT NOT NULL DEFAULT 'explicit'
) STRICT;
CREATE TRIGGER fixture_session_authority_insert AFTER INSERT ON sessions BEGIN
  INSERT OR IGNORE INTO provider_accounts
    SELECT NEW.profile_id,NEW.profile_id,'codex',1,p.process_generation,'signed_in'
    FROM profiles p WHERE p.id=NEW.profile_id;
  INSERT OR IGNORE INTO provider_accounts
    SELECT 'pact_'||substr(p.id,6),p.id,'claude',1,1,'signed_in'
    FROM profiles p WHERE p.id=NEW.profile_id;
  INSERT OR IGNORE INTO provider_accounts
    SELECT 'dact_'||substr(p.id,6),p.id,'devin',1,1,'signed_in'
    FROM profiles p WHERE p.id=NEW.profile_id;
  INSERT INTO session_provider_authorities
    SELECT NEW.id,a.id,a.profile_id,a.provider,a.binding_generation,a.process_generation,1,'explicit'
    FROM provider_accounts a WHERE a.profile_id=NEW.profile_id AND a.provider=NEW.provider_v39;
END;
CREATE TRIGGER fixture_session_authority_update AFTER UPDATE OF provider_v39 ON sessions
WHEN NEW.provider_v39!=OLD.provider_v39 BEGIN
  UPDATE session_provider_authorities SET
    provider_account_id=(SELECT id FROM provider_accounts WHERE profile_id=NEW.profile_id AND provider=NEW.provider_v39),
    provider=NEW.provider_v39,
    binding_generation=(SELECT binding_generation FROM provider_accounts WHERE profile_id=NEW.profile_id AND provider=NEW.provider_v39),
    process_generation=(SELECT process_generation FROM provider_accounts WHERE profile_id=NEW.profile_id AND provider=NEW.provider_v39),
    authority_revision=authority_revision+1
  WHERE session_id=NEW.id;
END;
CREATE TRIGGER fixture_codex_process_mirror AFTER UPDATE OF process_generation ON profiles BEGIN
  UPDATE provider_accounts SET process_generation=NEW.process_generation WHERE profile_id=NEW.id AND provider='codex';
  UPDATE session_provider_authorities SET process_generation=NEW.process_generation,authority_revision=authority_revision+1
    WHERE profile_id=NEW.id AND provider='codex';
END;
CREATE TABLE session_account_authorities(
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  account_key TEXT,
  recorded_at INTEGER NOT NULL
) STRICT;
CREATE TABLE provider_runtime_account_revocations(
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  profile_generation INTEGER NOT NULL,
  provider TEXT NOT NULL,
  runtime_scope TEXT NOT NULL,
  current_account_key TEXT,
  state TEXT NOT NULL,
  PRIMARY KEY(profile_id,provider,runtime_scope)
) STRICT;
CREATE TABLE session_provider_account_authorities(
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  runtime_scope TEXT NOT NULL,
  account_key TEXT NOT NULL,
  recorded_at INTEGER NOT NULL
) STRICT;
CREATE TABLE session_personal_runtime_bindings(
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_thread_id TEXT NOT NULL,
  state TEXT NOT NULL
) STRICT;
CREATE TRIGGER session_account_authority_insert
AFTER INSERT ON sessions
BEGIN
  INSERT INTO session_account_authorities(session_id,profile_id,account_key,recorded_at)
  SELECT NEW.id,NEW.profile_id,
    CASE WHEN p.provider_email IS NULL THEN NULL ELSE lower(trim(p.provider_email)) END,
    0
  FROM profiles p WHERE p.id=NEW.profile_id;
END;
CREATE TRIGGER session_provider_account_authority_insert
AFTER INSERT ON sessions
WHEN NEW.provider_v39='codex'
BEGIN
  INSERT INTO session_provider_account_authorities(
    session_id,provider,runtime_scope,account_key,recorded_at
  )
  SELECT NEW.id,'codex','managed',p.codex_account_key,0
  FROM profiles p WHERE p.id=NEW.profile_id AND p.codex_account_key IS NOT NULL;
END;
CREATE TABLE session_events(
  session_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  recorded_at INTEGER NOT NULL,
  account_id TEXT NOT NULL,
  provider_generation INTEGER NOT NULL,
  event_json TEXT NOT NULL,
  PRIMARY KEY(session_id,sequence)
) STRICT;
CREATE TABLE mutation_attempts(
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  authority_id TEXT NOT NULL,
  authority_generation INTEGER NOT NULL,
  request_digest TEXT NOT NULL,
  state TEXT NOT NULL,
  result_json TEXT,
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE TABLE mutation_effect_evidence(
  attempt_id TEXT PRIMARY KEY,
  kind TEXT,
  evidence_json TEXT,
  evidence_digest TEXT,
  recorded_at INTEGER
) STRICT;
CREATE TABLE mutation_resolutions(
  attempt_id TEXT PRIMARY KEY,
  resolution_kind TEXT,
  receipt_json TEXT,
  evidence_json TEXT,
  created_at INTEGER
) STRICT;
CREATE TABLE session_runtime_profiles(source_id TEXT) STRICT;
CREATE TABLE session_turn_runtime_profiles(source_id TEXT) STRICT;
CREATE TABLE legacy_provider_authority_quarantines(
  scope_kind TEXT NOT NULL,scope_id TEXT NOT NULL,reason TEXT NOT NULL,recorded_at INTEGER NOT NULL,
  PRIMARY KEY(scope_kind,scope_id)
) STRICT;
CREATE TABLE mutation_provider_authorities(
  attempt_id TEXT NOT NULL REFERENCES mutation_attempts(id),role TEXT NOT NULL,
  provider_account_id TEXT NOT NULL,profile_id TEXT NOT NULL,provider TEXT NOT NULL,
  binding_generation INTEGER NOT NULL,process_generation INTEGER NOT NULL,provenance TEXT NOT NULL,
  PRIMARY KEY(attempt_id,role)
) STRICT;
`;

const encodeCursor = (payload: unknown): string =>
  `hra1.${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}.${"A".repeat(43)}`;

const decodeTaskHistoryCursor = (cursor: string): WorkTaskHistoryCursorPayload => {
  const encoded = cursor.split(".")[1];
  if (encoded === undefined) throw new Error("history cursor payload missing");
  return JSON.parse(
    Buffer.from(encoded, "base64url").toString("utf8"),
  ) as WorkTaskHistoryCursorPayload;
};
const issueCapability = (): string => capability;
const verifyCapability = (candidate: string): boolean => candidate === capability;
const projectProviderIdentifier = (raw: string): string =>
  raw.startsWith("opaque_v2_") ? raw : `opaque_v2_${"a".repeat(64)}`;

function fixture(): Fixture {
  const database = new Database(":memory:", { strict: true });
  databases.push(database);
  database.exec("PRAGMA foreign_keys=ON;");
  database.exec(parentSchema);
  applySessionSendOwnerSchema(database);
  database.exec(WORK_SCHEMA_SQL);
  database.exec(WORK_SIGNAL_PROVIDER_AUTHORITY_SCHEMA_SQL);
  database.exec(WORK_PROJECT_AUTHORITY_SCHEMA_SQL);
  database.exec(LEGACY_CANONICAL_PROFILE_COLUMNS_SQL);
  assertWorkSchema(database);
  const accountId = createProfileId();
  const projectId = createProjectId();
  const actorSessionId = createSessionId();
  const reviewerSessionId = createSessionId();
  database.query(
    `INSERT INTO profiles(id,state,process_generation,provider_email,codex_account_key)
     VALUES (?,'signed_in',1,'worker@example.com',?)`,
  ).run(accountId, codexAccountKey("worker@example.com"));
  database.query("INSERT INTO projects(id) VALUES (?)").run(projectId);
  for (const sessionId of [actorSessionId, reviewerSessionId]) {
    database.query(
      `INSERT INTO sessions(id,profile_id,project_id,preset,fast_enabled,state,preset_contract,canonical_profile_key)
       VALUES (?,?,?,'high',0,'active',2,'codex:gpt-6-astra:max')`,
    ).run(sessionId, accountId, projectId);
  }
  database.exec(LEGACY_CANONICAL_PROFILE_GUARDS_SQL);
  assertLegacyCanonicalProfileRows(database);
  const now = { value: 10_000 };
  const store = new WorkStore(database, {
    daemonGeneration: 7,
    now: () => now.value,
    encodeCursor,
    issueCapability,
    verifyCapability,
    projectProviderIdentifier,
  });
  return {
    accountId,
    actorSessionId,
    database,
    now,
    projectId,
    reviewerSessionId,
    store,
  };
}

async function originalSendOwnerFixture(): Promise<Fixture & Readonly<{
  stateStore: StateStore;
  daemonGeneration: number;
  bootId: string;
}>> {
  const home = await realpath(await mkdtemp(joinPath(tmpdir(), "oompa-work-send-owner-")));
  const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
  await initializeStatePaths(paths);
  const now = { value: 10_000 };
  const stateStore = new StateStore(paths, {
    now: () => now.value,
    resolveMachineTimeZone: () => "America/Puerto_Rico",
    publicProviderIdentifierProjector: projectProviderIdentifier,
  });
  stateStores.push(stateStore);
  const bootId = `boot_${randomUUID().replaceAll("-", "")}`;
  const daemonGeneration = stateStore.nextDaemonGeneration(bootId);
  const profile = stateStore.createProfile("Original send owner");
  const account = stateStore.nextProfileGeneration(profile.id);
  if (!stateStore.setProfileState(account.id, account.processGeneration, "signed_in", {
    email: "work-owner@example.com",
    plan: "Plus",
  })) throw new Error("work owner fixture account was not admitted");
  const projectRoot = joinPath(home, "project");
  await mkdir(projectRoot);
  const project = await stateStore.createProject("Owner fixture", projectRoot, true);
  const bindSession = (thread: string): SessionId => {
    const created = stateStore.createSession({
      profileId: account.id,
      projectId: project.id,
      provider: "codex",
      preset: "high",
      fastEnabled: false,
    });
    const bound = stateStore.bindSession({
      sessionId: created.id,
      expectedRevision: created.revision,
      providerThreadId: thread,
      state: "idle",
    });
    stateStore.bindSessionProviderAccountAuthority({
      sessionId: bound.id,
      provider: "codex",
      runtimeScope: "managed",
      accountKey: `v1:codex:${createHash("sha256").update("work-owner@example.com").digest("hex")}`,
    });
    return bound.id;
  };
  const actorSessionId = bindSession("work-owner-actor");
  const reviewerSessionId = bindSession("work-owner-reviewer");
  const database = new Database(paths.database, { strict: true });
  databases.push(database);
  database.exec("PRAGMA foreign_keys=ON");
  const store = stateStore.createWorkStore(7, encodeCursor, {
    issue: issueCapability,
    verify: verifyCapability,
  });
  return {
    accountId: account.id,
    actorSessionId,
    database,
    now,
    projectId: project.id,
    reviewerSessionId,
    stateStore,
    store,
    daemonGeneration,
    bootId,
  };
}

function prepareOriginalSendOwner(
  value: Awaited<ReturnType<typeof originalSendOwnerFixture>>,
  key: string,
  message = "One original human request.",
) {
  return value.stateStore.prepareOwnedSessionSend({
    kind: "session.send",
    idempotencyKey: key,
    session: value.actorSessionId,
    message,
    attachments: [],
  });
}

function claimOriginalSendOwner(
  value: Awaited<ReturnType<typeof originalSendOwnerFixture>>,
  prepared: ReturnType<typeof prepareOriginalSendOwner>,
) {
  const authority = prepared.owner.sourceAuthority;
  const runtimeProfile = effectiveRuntimeProfileSchema.parse({
    approvalPolicy: "on-request",
    computerUse: true,
    enabledApps: [],
    fast: false,
    model: presetRequirements.high.model,
    observedAt: value.now.value,
    permissionProfile: ":workspace",
    pluginCapability: true,
    preset: "high",
    processGeneration: authority.processGeneration,
    profileId: authority.profileId,
    reasoningEffort: "max",
    reviewMode: "auto_review",
    serviceTier: null,
  });
  return value.stateStore.beginOwnedDirectSendEffect({
    attemptId: prepared.owner.attemptId,
    ownerDigest: prepared.ownerDigest,
    requestFingerprint: prepared.owner.fingerprint,
    daemonGeneration: value.daemonGeneration,
    bootId: value.bootId,
    expectedSessionRevision: prepared.owner.sourceSessionRevision,
    executionAuthority: authority,
    evidence: {
      kind: "session.send",
      providerThreadId: prepared.owner.sourceThreadId,
      baseline: { providerUpdatedAt: null, status: "idle", activeTurnId: null },
      clientMessageId: prepared.owner.attemptId,
      messageDigest: prepared.owner.fingerprint.inputDigest,
      runtimeProfile,
    },
  });
}

function bindPersonalProviderAuthority(
  value: Fixture,
  sessionId: SessionId,
  provider: "claude" | "codex",
  providerThreadId: string,
  accountKey: string,
): void {
  value.database.query(
    "DELETE FROM session_personal_runtime_bindings WHERE session_id=?",
  ).run(sessionId);
  value.database.query(
    "DELETE FROM session_provider_account_authorities WHERE session_id=?",
  ).run(sessionId);
  value.database.query(
    "UPDATE sessions SET provider=?,provider_thread_id=? WHERE id=?",
  ).run(provider, providerThreadId, sessionId);
  setSessionProfile(value, sessionId, {
    provider,
    ...(provider === "claude" ? { preset: "ultra" } : {}),
  });
  value.database.query(
    `INSERT INTO session_provider_account_authorities(
       session_id,provider,runtime_scope,account_key,recorded_at
     ) VALUES (?,?, 'personal',?,0)`,
  ).run(sessionId, provider, accountKey);
  value.database.query(
    `INSERT INTO session_personal_runtime_bindings(
       session_id,provider,provider_thread_id,state
     ) VALUES (?,?,?,'active')`,
  ).run(sessionId, provider, providerThreadId);
}

function addSignedOutPersonalClaudeSession(
  value: Fixture,
  label: string,
): Readonly<{
  accountKey: string;
  profileId: ProfileId;
  sessionId: SessionId;
}> {
  const profileId = createProfileId();
  const sessionId = createSessionId();
  const providerThreadId = `personal-claude-${label}`;
  const accountKey = claudeAccountKey(label);
  value.database.query(
    `INSERT INTO profiles(id,state,process_generation,provider_email,codex_account_key)
     VALUES (?,'signed_out',1,NULL,NULL)`,
  ).run(profileId);
  value.database.query(
    `INSERT INTO sessions(
       id,profile_id,project_id,provider,provider_v39,provider_thread_id,preset,fast_enabled,state,canonical_profile_key
     ) VALUES (?,?,?,'claude','claude',?,'ultra',0,'active','claude:claude-fable-5-1:max')`,
  ).run(sessionId, profileId, value.projectId, providerThreadId);
  bindPersonalProviderAuthority(
    value,
    sessionId,
    "claude",
    providerThreadId,
    accountKey,
  );
  return { accountKey, profileId, sessionId };
}

function addSignedOutManagedDevinSession(
  value: Fixture,
  label: string,
): Readonly<{
  profileId: ProfileId;
  sessionId: SessionId;
}> {
  const profileId = createProfileId();
  const sessionId = createSessionId();
  value.database.query(
    `INSERT INTO profiles(id,state,process_generation,provider_email,codex_account_key)
     VALUES (?,'signed_out',1,NULL,NULL)`,
  ).run(profileId);
  value.database.query(
    `INSERT INTO sessions(
       id,profile_id,project_id,provider,provider_v39,provider_thread_id,preset,
       preset_contract,fast_enabled,state,canonical_profile_key
     ) VALUES (?,?,?,'codex','devin',?,'ultra',2,0,'active','devin:gpt-6-astra:provider-default')`,
  ).run(sessionId, profileId, value.projectId, `devin-${label}`);
  value.database.query(
    "DELETE FROM session_account_authorities WHERE session_id=?",
  ).run(sessionId);
  return { profileId, sessionId };
}

function fillWorkEventCapacity(
  value: Fixture,
  workId: string,
  targetCount: number,
): void {
  const head = value.database.query(
    `SELECT revision,next_sequence,head_hash,stream_epoch
     FROM works WHERE id=?`,
  ).get(workId) as {
    revision: number;
    next_sequence: number;
    head_hash: string;
    stream_epoch: string;
  };
  const currentCount = head.next_sequence - 1;
  if (targetCount < currentCount || targetCount > WORK_HISTORY_EVENT_LIMIT) {
    throw new Error("invalid capacity fixture target");
  }
  if (targetCount === currentCount) return;
  value.database.exec(`
    DROP TRIGGER work_event_chain_guard;
    DROP TRIGGER work_event_capacity_guard;
    DROP TRIGGER works_stream_advance_guard;
  `);
  try {
    value.database.query(
      `WITH RECURSIVE event_numbers(sequence) AS (
         SELECT ?
         UNION ALL
         SELECT sequence+1 FROM event_numbers WHERE sequence<?
       )
       INSERT INTO work_events(
         work_id,sequence,revision,stream_epoch,kind,actor_session_id,payload_json,
         payload_digest,previous_hash,event_hash,daemon_generation,recorded_at
       )
       SELECT ?,sequence,?+(sequence-?+1),?,'test.capacity',NULL,'{}',?,
              CASE WHEN sequence=? THEN ? ELSE printf('%064x',sequence-1) END,
              printf('%064x',sequence),7,?
       FROM event_numbers ORDER BY sequence`,
    ).run(
      head.next_sequence,
      targetCount,
      workId,
      head.revision,
      head.next_sequence,
      head.stream_epoch,
      "0".repeat(64),
      head.next_sequence,
      head.head_hash,
      value.now.value,
    );
    const added = targetCount - currentCount;
    value.database.query(
      `UPDATE works SET revision=?,next_sequence=?,head_hash=? WHERE id=?`,
    ).run(
      head.revision + added,
      targetCount + 1,
      targetCount.toString(16).padStart(64, "0"),
      workId,
    );
  } finally {
    value.database.exec(WORK_SCHEMA_SQL);
  }
}

function fillReleaseTombstoneCapacity(value: Fixture): Readonly<{
  oldestWorkId: string;
  secondWorkId: string;
}> {
  value.database.query(
    `WITH RECURSIVE tombstones(sequence) AS (
       SELECT 1
       UNION ALL
       SELECT sequence+1 FROM tombstones WHERE sequence<?
     )
     INSERT INTO work_release_tombstones(
       work_id,release_idempotency_key,release_request_digest,client_ref_digest,
       coordinator_session_id,terminal_kind,terminal_request_digest,final_revision,
       final_head_hash,discarded_counts_json,discarded_records_digest,released_at,
       retention_upper_bound_at,result_json
     )
     SELECT 'wrk_'||printf('%032x',sequence),
            printf('ffffffff-ffff-7000-8000-%012x',sequence),
            printf('%064x',sequence),printf('%064x',sequence),
            'ses_tombstone','work.fail',?,1,?,'{}',?,5000,1000000,'{}'
     FROM tombstones ORDER BY sequence`,
  ).run(
    WORK_TOMBSTONE_LIMIT,
    "a".repeat(64),
    "b".repeat(64),
    "c".repeat(64),
  );
  return {
    oldestWorkId: `wrk_${"1".padStart(32, "0")}`,
    secondWorkId: `wrk_${"2".padStart(32, "0")}`,
  };
}

function taskSpec(
  input: Pick<Fixture, "accountId" | "projectId">,
  clientRef = "task-a",
  overrides: Partial<WorkTaskSpec> = {},
): WorkTaskSpec {
  return {
    clientRef,
    dependsOnRefs: [],
    dependsOnTaskIds: [],
    objective: `Complete ${clientRef}`,
    instructions: `Implement and verify ${clientRef}.`,
    criteria: ["Verification passes"],
    route: { accountId: input.accountId, projectId: input.projectId },
    preset: "high",
    fast: false,
    priority: 0,
    maxAttempts: 3,
    requiredReviews: 0,
    resultKind: "text",
    minEvidence: 0,
    ...overrides,
  };
}

function createWork(
  value: Fixture,
  tasks: readonly WorkTaskSpec[] = [taskSpec(value)],
  idempotencyKey = randomUUID(),
) {
  const routes = [...new Map(tasks.map((task) => {
    const route = { ...task.route, preset: task.preset, fast: task.fast };
    return [JSON.stringify(route), route] as const;
  })).values()];
  const result = value.store.apply({
    kind: "work.create",
    idempotencyKey,
    clientRef: `plan-${idempotencyKey}`,
    coordinatorSessionId: value.actorSessionId,
    objective: "Coordinate a bounded implementation.",
    routes,
    tasks,
  });
  if (result.kind !== "work.create") throw new Error("unexpected result");
  return result;
}

function join(value: Fixture, workId: string, revision: number, actorSessionId: SessionId) {
  void revision;
  const result = value.store.apply({
    kind: "work.join",
    idempotencyKey: randomUUID(),
    workId,
    coordinatorSessionId: value.actorSessionId,
    coordinatorCapability: capability,
    actorSessionId,
  });
  if (result.kind !== "work.join") throw new Error("unexpected result");
  return result;
}

function claim(
  value: Fixture,
  input: Readonly<{ workId: string; taskId: string; revision: number; actorSessionId?: SessionId }>,
) {
  const result = value.store.apply({
    kind: "task.claim",
    idempotencyKey: randomUUID(),
    workId: input.workId,
    taskId: input.taskId,
    expectedTaskRevision: input.revision,
    actorSessionId: input.actorSessionId ?? value.actorSessionId,
    actorCapability: capability,
    leaseMs: 5_000,
  });
  if (result.kind !== "task.claim") throw new Error("unexpected result");
  return result;
}

function prepareOwnerGuardDispatch(value: Fixture, idempotencyKey = randomUUID()) {
  const created = createWork(value);
  join(value, created.work.id, created.work.revision, value.actorSessionId);
  const task = created.tasks[0];
  if (task === undefined) throw new Error("owner guard task missing");
  const claimed = claim(value, {
    workId: created.work.id,
    taskId: task.id,
    revision: task.revision,
  });
  const operation = {
    kind: "attempt.dispatch" as const,
    idempotencyKey,
    workId: created.work.id,
    attemptId: claimed.attempt.id,
    expectedAttemptRevision: claimed.attempt.revision,
    fence: claimed.attempt.fence,
    actorSessionId: value.actorSessionId,
    attemptCapability: capability,
    targetSessionId: value.actorSessionId,
    mode: "send" as const,
  };
  value.store.apply(operation);
  const effect = value.store.preparedEffect(idempotencyKey)?.effect;
  if (effect?.kind !== "dispatch") throw new Error("owner guard dispatch missing");
  return { created, claimed, operation, effect };
}

function markNestedRequestAsOwned(value: Fixture, effect: WorkPreparedEffect): void {
  value.database.exec("DROP TRIGGER session_send_format_immutable; DROP TRIGGER session_send_mutation_guard");
  value.database.query("UPDATE mutation_attempts SET request_format=? WHERE idempotency_key=?")
    .run(SESSION_SEND_REQUEST_FORMAT, effect.nestedMutationKey);
  applySessionSendOwnerSchema(value.database);
}

function insertNestedDispatchMutation(
  value: Fixture,
  effect: Extract<WorkPreparedEffect, { kind: "dispatch" }>,
  state: "ambiguous" | "failed",
): void {
  const requestDigest = createHash("sha256").update(JSON.stringify({
    kind: "session.send",
    authorityId: effect.targetSessionId,
    authorityGeneration: effect.accountGeneration,
    request: { message: workPreparedEffectMessage(effect) },
  })).digest("hex");
  value.database.query(
    `INSERT INTO mutation_attempts(
       id,idempotency_key,kind,authority_id,authority_generation,request_digest,state,result_json
     ) VALUES (?,?,?,?,?,?,?,?)`,
  ).run(
    createAttemptId(),
    effect.nestedMutationKey,
    "session.send",
    effect.targetSessionId,
    effect.accountGeneration,
    requestDigest,
    state,
    state === "ambiguous" ? JSON.stringify({ code: "provider_unknown" }) : null,
  );
}

function insertAppliedNestedMutation(
  value: Fixture,
  effect: WorkPreparedEffect,
): void {
  const generation = nestedMutationGeneration(value, effect);
  const kind = effect.kind === "dispatch"
    ? "session.send"
    : effect.mode === "queue" ? "session.queue" : "session.steer";
  const requestDigest = createHash("sha256").update(JSON.stringify({
    kind,
    authorityId: effect.targetSessionId,
    authorityGeneration: generation,
    request: { message: workPreparedEffectMessage(effect) },
  })).digest("hex");
  const result = effect.kind === "dispatch"
    ? { turnId: "provider-turn", effectiveRuntimeProfile: { preset: "high" } }
    : effect.mode === "queue"
      ? { queueId: createQueueId() }
      : { activeTurnId: "provider-turn" };
  value.database.query(
    `INSERT INTO mutation_attempts(
       id,idempotency_key,kind,authority_id,authority_generation,request_digest,state,result_json
     ) VALUES (?,?,?,?,?,?,'applied',?)`,
  ).run(
    createAttemptId(),
    effect.nestedMutationKey,
    kind,
    effect.targetSessionId,
    generation,
    requestDigest,
    JSON.stringify(result),
  );
  insertNestedSignalAuthority(value, effect);
}

function nestedMutationGeneration(value: Fixture, effect: WorkPreparedEffect): number {
  if (effect.kind !== "signal") return effect.accountGeneration;
  const authority = value.database.query(
    "SELECT process_generation FROM work_signal_provider_authorities WHERE signal_id=?",
  ).get(effect.signalId) as { process_generation: number } | null;
  if (authority === null) throw new Error("signal authority missing");
  return authority.process_generation;
}

function insertNestedSignalAuthority(value: Fixture, effect: WorkPreparedEffect): void {
  if (effect.kind !== "signal") return;
  value.database.query(`INSERT INTO mutation_provider_authorities
    SELECT mutation.id,'primary',authority.provider_account_id,authority.profile_id,
      authority.provider,authority.binding_generation,authority.process_generation,
      CASE WHEN mutation.kind='session.queue' THEN 'session_queue' ELSE 'session_steer' END
    FROM mutation_attempts mutation JOIN work_signal_provider_authorities authority
      ON authority.signal_id=? WHERE mutation.idempotency_key=?`)
    .run(effect.signalId, effect.nestedMutationKey);
}

function insertFailedNestedMutation(
  value: Fixture,
  effect: WorkPreparedEffect,
): void {
  const generation = nestedMutationGeneration(value, effect);
  const kind = effect.kind === "dispatch"
    ? "session.send"
    : effect.mode === "queue" ? "session.queue" : "session.steer";
  const requestDigest = createHash("sha256").update(JSON.stringify({
    kind,
    authorityId: effect.targetSessionId,
    authorityGeneration: generation,
    request: { message: workPreparedEffectMessage(effect) },
  })).digest("hex");
  value.database.query(
    `INSERT INTO mutation_attempts(
       id,idempotency_key,kind,authority_id,authority_generation,request_digest,state,result_json
     ) VALUES (?,?,?,?,?,?,'failed',NULL)`,
  ).run(
    createAttemptId(),
    effect.nestedMutationKey,
    kind,
    effect.targetSessionId,
    generation,
    requestDigest,
  );
  insertNestedSignalAuthority(value, effect);
}

function prepareSignal(value: Fixture, provider: "codex" | "claude" = "codex") {
  if (provider !== "codex") {
    setSessionProfile(value, value.reviewerSessionId, { provider, preset: "ultra" });
    value.database.query("DELETE FROM session_provider_account_authorities WHERE session_id=?")
      .run(value.reviewerSessionId);
    value.database.query(`INSERT INTO session_provider_account_authorities(
      session_id,provider,runtime_scope,account_key,recorded_at
    ) VALUES (?,'claude','managed',?,0)`).run(value.reviewerSessionId, `v1:claude:${"c".repeat(64)}`);
  }
  const created = createWork(value);
  join(value, created.work.id, created.work.revision, value.reviewerSessionId);
  const key = randomUUID();
  value.store.apply({
    kind: "signal.send", idempotencyKey: key, workId: created.work.id,
    senderSessionId: value.actorSessionId, senderCapability: capability,
    targetSessionId: value.reviewerSessionId, mode: "queue", body: "Keep this exact authority.",
  });
  const effect = value.store.preparedEffect(key)?.effect;
  if (effect?.kind !== "signal") throw new Error("signal effect missing");
  return { key, effect, workId: created.work.id };
}

describe("WorkStore canonical profile runtime", () => {
  for (const contract of [1, 2] as const) {
    for (const preset of ["low", "high", "ultra"] as const) {
      test(`writes own Work ${contract}/${preset} identity without a public field`, () => {
        const value = fixture();
        const created = createWork(value, [taskSpec(value, "canonical", { preset })]);
        if (contract === 1) rewriteWorkPresetContract(value, created.work.id, contract);
        setSessionProfile(value, value.actorSessionId, { preset, contract });
        const claimed = claim(value, {
          workId: created.work.id, taskId: created.tasks[0]!.id, revision: created.tasks[0]!.revision,
        });
        const expected = preset === "low" ? "codex:gpt-5.6-luna:max"
          : `codex:${contract === 1 ? "gpt-5.6-sol" : "gpt-6-astra"}:${preset === "high" ? "max" : "ultra"}`;
        for (const table of ["work_routes", "work_tasks", "work_attempts"] as const) {
          expect(value.database.query(
            `SELECT canonical_profile_key FROM ${table} WHERE work_id=?`,
          ).all(created.work.id)).toEqual([{ canonical_profile_key: expected }]);
        }
        expect(JSON.stringify(claimed)).not.toContain("canonical_profile_key");
        expect(JSON.stringify(claimed)).not.toContain("canonicalProfileKey");
        expect(() => assertLegacyCanonicalProfileRows(value.database)).not.toThrow();
      });
    }
  }

  for (const owner of ["work_routes", "work_tasks", "work_attempts", "sessions"] as const) {
    for (const key of [null, "foreign-key", "CODEX:GPT-5.6-SOL:MAX"] as const) {
      test(`refuses ${owner} ${key ?? "NULL"} key across reads and late authority without mutation`, () => {
        const value = fixture();
        const created = createWork(value);
        const taskId = created.tasks[0]!.id;
        const claimed = claim(value, { workId: created.work.id, taskId, revision: created.tasks[0]!.revision });
        const dispatchKey = randomUUID();
        value.store.apply({
          kind: "attempt.dispatch", idempotencyKey: dispatchKey,
          workId: created.work.id, attemptId: claimed.attempt.id,
          expectedAttemptRevision: claimed.attempt.revision, fence: claimed.attempt.fence,
          actorSessionId: value.actorSessionId, attemptCapability: capability,
          targetSessionId: value.actorSessionId, mode: "send",
        });
        const guards = owner === "sessions"
          ? ["canonical_profile_session_update_guard", "canonical_profile_session_live_attempt_guard"]
          : owner === "work_attempts"
            ? ["work_attempt_revision_guard", "canonical_profile_work_attempt_immutable_guard"]
            : [owner === "work_routes" ? "work_routes_no_update" : "work_tasks_no_update"];
        withFixtureGuardsRemoved(value, guards, () => {
          value.database.query(
            `UPDATE ${owner} SET canonical_profile_key=? WHERE ${owner === "sessions" ? "id" : "work_id"}=?`,
          ).run(key, owner === "sessions" ? value.actorSessionId : created.work.id);
        });
        const before = value.database.serialize();
        const readers = [
          () => value.store.task(taskId),
          () => value.store.taskHistory(taskId),
          () => value.store.snapshot(created.work.id),
          () => value.store.poll(created.work.id, value.actorSessionId),
          () => value.store.events(created.work.id),
          () => value.store.preparedEffect(dispatchKey),
          () => value.store.authorizePreparedEffect(dispatchKey),
          () => value.store.prepareProfileAuthorityChange(value.accountId, 1),
        ];
        for (const read of readers) {
          expect(read).toThrow("WORK_CANONICAL_PROFILE_CORRUPT");
          expect(value.database.serialize()).toEqual(before);
        }
      });
    }
  }

  test("rejects a coherently forged route/task/attempt key under the wrong own Work contract", () => {
    const value = fixture();
    const created = createWork(value);
    const claimed = claim(value, {
      workId: created.work.id, taskId: created.tasks[0]!.id, revision: created.tasks[0]!.revision,
    });
    withFixtureGuardsRemoved(value, [
      "work_routes_no_update", "work_tasks_no_update", "work_attempt_revision_guard",
      "canonical_profile_work_attempt_immutable_guard",
    ], () => {
      for (const table of ["work_routes", "work_tasks", "work_attempts"] as const) {
        value.database.query(
          `UPDATE ${table} SET canonical_profile_key='codex:gpt-5.6-sol:max' WHERE work_id=?`,
        ).run(created.work.id);
      }
    });
    const before = value.database.serialize();
    expect(() => value.store.task(claimed.task.id)).toThrow("WORK_CANONICAL_PROFILE_CORRUPT");
    expect(value.database.serialize()).toEqual(before);
  });

  for (const owner of ["work_routes", "work_tasks", "sessions"] as const) {
    test(`refuses ${owner} corruption on task-bound signal effect reads and late authority`, () => {
      const value = fixture();
      const created = createWork(value);
      const taskId = created.tasks[0]!.id;
      claim(value, { workId: created.work.id, taskId, revision: created.tasks[0]!.revision });
      const key = randomUUID();
      value.store.apply({
        kind: "signal.send", idempotencyKey: key, workId: created.work.id,
        senderSessionId: value.actorSessionId, senderCapability: capability,
        targetSessionId: value.actorSessionId, taskId, mode: "queue", body: "A task-bound signal.",
      });
      const guards = owner === "sessions"
        ? ["canonical_profile_session_update_guard", "canonical_profile_session_live_attempt_guard"]
        : [owner === "work_routes" ? "work_routes_no_update" : "work_tasks_no_update"];
      withFixtureGuardsRemoved(value, guards, () => {
        value.database.query(
          `UPDATE ${owner} SET canonical_profile_key=NULL WHERE ${owner === "sessions" ? "id" : "work_id"}=?`,
        ).run(owner === "sessions" ? value.actorSessionId : created.work.id);
      });
      const before = value.database.serialize();
      for (const read of [
        () => value.store.effectStatus(key),
        () => value.store.preparedEffect(key),
        () => value.store.recoverablePreparedEffects(),
        () => value.store.authorizePreparedEffect(key),
        () => value.store.reprojectPreparedEffect(key),
        () => value.store.settlePreparedEffectNoEffect(key, "canonical_test"),
      ]) {
        expect(read).toThrow("WORK_CANONICAL_PROFILE_CORRUPT");
        expect(value.database.serialize()).toEqual(before);
      }
    });
  }

  for (const column of ["account_id", "project_id"] as const) {
    test(`refuses an orphaned route ${column} even when task and attempt agree`, () => {
      const value = fixture();
      const created = createWork(value);
      const taskId = created.tasks[0]!.id;
      claim(value, { workId: created.work.id, taskId, revision: created.tasks[0]!.revision });
      const orphanId = column === "account_id" ? createProfileId() : createProjectId();
      value.database.exec("PRAGMA foreign_keys=OFF");
      try {
        withFixtureGuardsRemoved(value, [
          "work_routes_no_update", "work_tasks_no_update", "work_attempt_authority_immutable",
          "work_attempt_revision_guard",
        ], () => {
          for (const table of ["work_routes", "work_tasks", "work_attempts"] as const) {
            value.database.query(`UPDATE ${table} SET ${column}=? WHERE work_id=?`)
              .run(orphanId, created.work.id);
          }
        });
      } finally {
        value.database.exec("PRAGMA foreign_keys=ON");
      }
      const before = value.database.serialize();
      expect(() => value.store.task(taskId)).toThrow("WORK_CANONICAL_PROFILE_CORRUPT");
      expect(value.database.serialize()).toEqual(before);
    });
  }

  for (const kind of ["task.addBatch", "work.fail"] as const) {
    test(`refuses corrupt ${kind} sources before durably expiring a different valid claim`, () => {
      const value = fixture();
      const created = createWork(value, [taskSpec(value, "valid-expiring"), taskSpec(value, "damaged")]);
      const claimed = claim(value, {
        workId: created.work.id, taskId: created.tasks[0]!.id, revision: created.tasks[0]!.revision,
      });
      withFixtureGuardsRemoved(value, ["work_tasks_no_update"], () => {
        value.database.query("UPDATE work_tasks SET canonical_profile_key=NULL WHERE id=?")
          .run(created.tasks[1]!.id);
      });
      value.now.value = claimed.attempt.leaseExpiresAt! + 10;
      const before = createHash("sha256").update(value.database.serialize()).digest("hex");
      const shared = {
        idempotencyKey: randomUUID(), workId: created.work.id,
        expectedWorkRevision: claimed.workRevision, coordinatorCapability: capability,
      };
      let failure: unknown;
      try {
        value.store.apply(kind === "task.addBatch"
          ? { ...shared, kind, coordinatorSessionId: value.actorSessionId, tasks: [taskSpec(value, "added")] }
          : { ...shared, kind, actorSessionId: value.actorSessionId, summary: "Stop this work.", evidence: [] });
      } catch (error) {
        failure = error;
      }
      expect(value.database.query("SELECT state FROM work_attempts WHERE id=?").get(claimed.attempt.id))
        .toEqual({ state: "claimed" });
      expect(failure).toEqual(new Error("WORK_CANONICAL_PROFILE_CORRUPT"));
      expect(createHash("sha256").update(value.database.serialize()).digest("hex")).toBe(before);
    });
  }

  test("validates dependency identity even when a task's not-before time prevents readiness", () => {
    const value = fixture();
    const created = createWork(value, [
      taskSpec(value, "dependency"),
      taskSpec(value, "waiting", { dependsOnRefs: ["dependency"], notBefore: value.now.value + 60_000 }),
    ]);
    const taskId = created.tasks[1]!.id;
    expect(value.store.task(taskId).task.status).toBe("waiting");
    withFixtureGuardsRemoved(value, ["work_tasks_no_update"], () => {
      value.database.query("UPDATE work_tasks SET canonical_profile_key=NULL WHERE id=?")
        .run(created.tasks[0]!.id);
    });
    const before = value.database.serialize();
    expect(() => value.store.task(taskId)).toThrow("WORK_CANONICAL_PROFILE_CORRUPT");
    expect(value.database.serialize()).toEqual(before);
  });

  test("checks a claim target's dependency before a different valid claim can expire", () => {
    const value = fixture();
    const created = createWork(value, [
      taskSpec(value, "valid-expiring"), taskSpec(value, "dependency"),
      taskSpec(value, "dependent", { dependsOnRefs: ["dependency"] }),
    ]);
    const claimed = claim(value, {
      workId: created.work.id, taskId: created.tasks[0]!.id, revision: created.tasks[0]!.revision,
    });
    withFixtureGuardsRemoved(value, ["work_tasks_no_update"], () => {
      value.database.query("UPDATE work_tasks SET canonical_profile_key=NULL WHERE id=?")
        .run(created.tasks[1]!.id);
    });
    value.now.value = claimed.attempt.leaseExpiresAt! + 10;
    const before = value.database.serialize();
    expect(() => claim(value, {
      workId: created.work.id, taskId: created.tasks[2]!.id, revision: created.tasks[2]!.revision,
    })).toThrow("WORK_CANONICAL_PROFILE_CORRUPT");
    expect(value.database.serialize()).toEqual(before);
    expect(value.database.query("SELECT state FROM work_attempts WHERE id=?").get(claimed.attempt.id))
      .toEqual({ state: "claimed" });
  });

  test("checks settled signal-ownership evidence before a different valid claim can expire", () => {
    const value = fixture();
    const created = createWork(value, [taskSpec(value, "historical"), taskSpec(value, "valid-expiring")]);
    const historical = claim(value, {
      workId: created.work.id, taskId: created.tasks[0]!.id, revision: created.tasks[0]!.revision,
    });
    value.store.apply({
      kind: "attempt.release", idempotencyKey: randomUUID(), workId: created.work.id,
      attemptId: historical.attempt.id, expectedAttemptRevision: historical.attempt.revision,
      fence: historical.attempt.fence, actorSessionId: value.actorSessionId,
      attemptCapability: capability, reason: "No provider effect.",
    });
    const claimed = claim(value, {
      workId: created.work.id, taskId: created.tasks[1]!.id, revision: created.tasks[1]!.revision,
    });
    withFixtureGuardsRemoved(value, [
      "work_attempt_revision_guard", "canonical_profile_work_attempt_immutable_guard",
    ], () => {
      value.database.query("UPDATE work_attempts SET canonical_profile_key=NULL WHERE id=?")
        .run(historical.attempt.id);
    });
    value.now.value = claimed.attempt.leaseExpiresAt! + 10;
    const before = value.database.serialize();
    expect(() => value.store.apply({
      kind: "signal.send", idempotencyKey: randomUUID(), workId: created.work.id,
      senderSessionId: value.actorSessionId, senderCapability: capability,
      targetSessionId: value.actorSessionId, taskId: historical.task.id,
      mode: "queue", body: "Use the retained ownership evidence.",
    })).toThrow("WORK_CANONICAL_PROFILE_CORRUPT");
    expect(value.database.serialize()).toEqual(before);
    expect(value.database.query("SELECT state FROM work_attempts WHERE id=?").get(claimed.attempt.id))
      .toEqual({ state: "claimed" });
  });

  test("rejects cached signal history whose current source no longer belongs to the task", () => {
    const value = fixture();
    const created = createWork(value);
    const taskId = created.tasks[0]!.id;
    claim(value, { workId: created.work.id, taskId, revision: created.tasks[0]!.revision });
    const send = () => {
      const result = value.store.apply({
        kind: "signal.send", idempotencyKey: randomUUID(), workId: created.work.id,
        senderSessionId: value.actorSessionId, senderCapability: capability,
        targetSessionId: value.actorSessionId, taskId, mode: "queue", body: "A bounded history marker.",
      });
      if (result.kind !== "signal.send") throw new Error("unexpected signal result");
      return result.signal.id;
    };
    const firstSignal = send();
    send();
    const first = value.store.taskHistory(taskId, 1);
    if (first.nextCursor === null) throw new Error("signal history continuation missing");
    const cursor = decodeTaskHistoryCursor(first.nextCursor);
    expect(value.store.taskHistory(taskId, 1, cursor).items)
      .toMatchObject([{ kind: "signal", value: { id: firstSignal } }]);
    // Keep the task's current source count equal to the older cut's count: the
    // regression must prove source identity, not merely a count mismatch.
    send();
    withFixtureGuardsRemoved(value, ["work_signals_no_update"], () => {
      value.database.query("UPDATE work_signals SET task_id=NULL WHERE id=?").run(firstSignal);
    });
    expect(value.database.query("SELECT COUNT(*) AS count FROM work_signals WHERE task_id=?").get(taskId))
      .toEqual({ count: 2 });
    const before = value.database.serialize();
    expect(() => value.store.taskHistory(taskId, 1, cursor)).toThrow("WORK_CANONICAL_PROFILE_CORRUPT");
    expect(value.database.serialize()).toEqual(before);
  });

  for (const phase of ["claimed", "dispatching", "running", "recovery_required"] as const) {
    test(`refuses a valid but different worker key in live ${phase} state`, () => {
      const value = fixture();
      const created = createWork(value);
      const taskId = created.tasks[0]!.id;
      const claimed = claim(value, { workId: created.work.id, taskId, revision: created.tasks[0]!.revision });
      if (phase !== "claimed") {
        const key = randomUUID();
        value.store.apply({
          kind: "attempt.dispatch", idempotencyKey: key, workId: created.work.id,
          attemptId: claimed.attempt.id, expectedAttemptRevision: claimed.attempt.revision,
          fence: claimed.attempt.fence, actorSessionId: value.actorSessionId,
          attemptCapability: capability, targetSessionId: value.actorSessionId, mode: "send",
        });
        if (phase !== "dispatching") {
          value.store.authorizePreparedEffect(key);
          value.store.finalizeDispatch(key, phase === "running"
            ? { kind: "accepted", receipt: turnStartedReceipt() }
            : { kind: "unknown", code: "canonical_test_unknown" });
        }
      }
      expect(value.database.query("SELECT state FROM work_attempts WHERE id=?").get(claimed.attempt.id))
        .toEqual({ state: phase });
      withFixtureGuardsRemoved(value, [
        "work_session_attempt_authority_guard", "canonical_profile_session_live_attempt_guard",
      ], () => setSessionProfile(value, value.actorSessionId, { preset: "low" }));
      const before = value.database.serialize();
      expect(() => value.store.taskHistory(taskId)).toThrow("WORK_CANONICAL_PROFILE_CORRUPT");
      expect(() => value.store.snapshot(created.work.id)).toThrow("WORK_CANONICAL_PROFILE_CORRUPT");
      expect(() => value.store.assertSessionCanChangeRoute(value.actorSessionId))
        .toThrow("WORK_CANONICAL_PROFILE_CORRUPT");
      expect(value.database.serialize()).toEqual(before);
    });
  }

  for (const settled of ["released", "submitted"] as const) {
    test(`retains cached claimed history and immutable ${settled} evidence after worker reselection`, () => {
      const value = fixture();
      const created = createWork(value, [taskSpec(value, "settled-canonical", { requiredReviews: 1 })]);
      const taskId = created.tasks[0]!.id;
      join(value, created.work.id, created.workRevision, value.reviewerSessionId);
      const claimed = claim(value, { workId: created.work.id, taskId, revision: created.tasks[0]!.revision });
      value.store.apply({
        kind: "signal.send", idempotencyKey: randomUUID(), workId: created.work.id,
        senderSessionId: value.actorSessionId, senderCapability: capability,
        targetSessionId: value.actorSessionId, taskId, mode: "queue", body: "Bounded history marker.",
      });
      const first = value.store.taskHistory(taskId, 1);
      if (first.nextCursor === null) throw new Error("claimed history continuation missing");
      const cursor = decodeTaskHistoryCursor(first.nextCursor);
      const frozen = value.store.taskHistory(taskId, 1, cursor);
      expect(frozen.items).toMatchObject([{ kind: "attempt", value: { status: "claimed" } }]);
      if (settled === "released") {
        value.store.apply({
          kind: "attempt.release", idempotencyKey: randomUUID(), workId: created.work.id,
          attemptId: claimed.attempt.id, expectedAttemptRevision: claimed.attempt.revision,
          fence: claimed.attempt.fence, actorSessionId: value.actorSessionId,
          attemptCapability: capability, reason: "No provider effect.",
        });
      } else {
        const key = randomUUID();
        value.store.apply({
          kind: "attempt.dispatch", idempotencyKey: key, workId: created.work.id,
          attemptId: claimed.attempt.id, expectedAttemptRevision: claimed.attempt.revision,
          fence: claimed.attempt.fence, actorSessionId: value.actorSessionId,
          attemptCapability: capability, targetSessionId: value.actorSessionId, mode: "send",
        });
        value.store.authorizePreparedEffect(key);
        const running = value.store.finalizeDispatch(key, { kind: "accepted", receipt: turnStartedReceipt() });
        value.store.apply({
          kind: "attempt.report", idempotencyKey: randomUUID(), workId: created.work.id,
          attemptId: running.id, expectedAttemptRevision: running.revision, fence: running.fence,
          actorSessionId: value.actorSessionId, attemptCapability: capability,
          report: { kind: "submit", summary: "Ready for review.", result: { kind: "text", text: "done" }, evidence: [] },
        });
      }
      expect(value.database.query("SELECT state FROM work_attempts WHERE id=?").get(claimed.attempt.id))
        .toEqual({ state: settled });
      const persisted = () => [
        "work_routes", "work_tasks", "work_attempts", "work_events", "work_idempotency_intents",
        "work_prepared_effects", "work_task_history_versions",
      ].map((table) => value.database.query(`SELECT * FROM ${table} ORDER BY rowid`).all());
      const before = persisted();
      const publicBefore = [value.store.task(taskId), value.store.taskHistory(taskId), value.store.events(created.work.id)];
      setSessionProfile(value, value.actorSessionId, { preset: "low" });
      expect(persisted()).toEqual(before);
      expect([value.store.task(taskId), value.store.taskHistory(taskId), value.store.events(created.work.id)])
        .toEqual(publicBefore);
      expect(value.store.taskHistory(taskId, 1, cursor)).toEqual(frozen);
      const reopened = new WorkStore(value.database, {
        daemonGeneration: 7, now: () => value.now.value, encodeCursor,
        issueCapability, verifyCapability, projectProviderIdentifier,
      });
      expect(reopened.taskHistory(taskId, 1, cursor)).toEqual(frozen);
      expect(persisted()).toEqual(before);
    });
  }
});

describe("WorkStore schema and atomic plans", () => {
  test("fences Claude Work signals under scoped revocation despite a different Codex shadow", () => {
    for (const state of ["releasing", "completed"] as const) {
      const value = fixture();
      value.database.query("UPDATE provider_accounts SET process_generation=2 WHERE profile_id=? AND provider='claude'")
        .run(value.accountId);
      const { key, workId } = prepareSignal(value, "claude");
      expect(value.store.authorizePreparedEffect(key).executable).toBe(true);
      value.database.query(`INSERT INTO provider_runtime_account_revocations(
        profile_id,profile_generation,provider,runtime_scope,current_account_key,state
      ) VALUES (?,1,'claude','managed',?,?)`).run(value.accountId,
        `v1:claude:${(state === "releasing" ? "c" : "d").repeat(64)}`, state);
      expect(value.store.authorizePreparedEffect(key)).toMatchObject({ executable: false });
      expect(() => value.store.apply({
        kind: "signal.send", idempotencyKey: randomUUID(), workId,
        senderSessionId: value.actorSessionId, senderCapability: capability,
        targetSessionId: value.reviewerSessionId, mode: "queue", body: "Must not reach revoked Claude.",
      })).toThrow(new WorkStoreError("ROUTE_MISMATCH"));
    }
  });

  test("work signal authority survives a sibling process restart but rejects its own provider generation", () => {
    for (const changedProvider of ["codex", "claude"] as const) {
      const value = fixture();
      const { key } = prepareSignal(value, "claude");
      if (changedProvider === "codex") {
        value.database.query("UPDATE profiles SET process_generation=2 WHERE id=?").run(value.accountId);
      } else {
        value.database.query("UPDATE provider_accounts SET process_generation=2 WHERE profile_id=? AND provider='claude'").run(value.accountId);
      }
      expect(value.store.authorizePreparedEffect(key).executable).toBe(changedProvider === "codex");
    }
  });

  test("work signal authority rejects a same-counter provider switch after preparation", () => {
    const value = fixture();
    const created = createWork(value);
    join(value, created.work.id, created.work.revision, value.reviewerSessionId);
    const key = randomUUID();
    value.store.apply({
      kind: "signal.send", idempotencyKey: key, workId: created.work.id,
      senderSessionId: value.actorSessionId, senderCapability: capability,
      targetSessionId: value.reviewerSessionId, mode: "queue", body: "Keep this provider binding.",
    });
    setSessionProfile(value, value.reviewerSessionId, { provider: "claude", preset: "ultra" });
    value.database.query(`UPDATE session_provider_account_authorities
      SET provider='claude',runtime_scope='managed',account_key=? WHERE session_id=?`)
      .run(claudeAccountKey("same-counter-switch"), value.reviewerSessionId);
    expect(value.store.authorizePreparedEffect(key).executable).toBe(false);
  });

  test("work signal authority rejects a replaced binding or session revision with unchanged process counters", () => {
    for (const changed of ["binding", "revision", "account"] as const) {
      const value = fixture();
      const { key } = prepareSignal(value, "claude");
      if (changed === "binding") {
        value.database.query("UPDATE provider_accounts SET binding_generation=2 WHERE profile_id=? AND provider='claude'")
          .run(value.accountId);
        value.database.query("UPDATE session_provider_authorities SET binding_generation=2 WHERE session_id=?")
          .run(value.reviewerSessionId);
      } else if (changed === "revision") {
        value.database.query("UPDATE session_provider_authorities SET authority_revision=authority_revision+1 WHERE session_id=?")
          .run(value.reviewerSessionId);
      } else {
        value.database.query("UPDATE provider_accounts SET readiness='removed' WHERE profile_id=? AND provider='claude'")
          .run(value.accountId);
      }
      expect(value.store.authorizePreparedEffect(key).executable).toBe(false);
    }
  });

  test("work signal authority is immutable and current-format missing or altered rows fail closed", () => {
    for (const corruption of ["missing", "generation", "digest"] as const) {
      const value = fixture();
      const { key, effect } = prepareSignal(value, "claude");
      expect(() => value.database.query("UPDATE work_signal_provider_authorities SET process_generation=2 WHERE signal_id=?")
        .run(effect.signalId)).toThrow("WORK_SIGNAL_PROVIDER_AUTHORITY_IMMUTABLE");
      expect(() => value.database.query("DELETE FROM work_signal_provider_authorities WHERE signal_id=?")
        .run(effect.signalId)).toThrow("WORK_SIGNAL_PROVIDER_AUTHORITY_IMMUTABLE");
      value.database.exec("DROP TRIGGER work_signal_provider_authority_no_delete; DROP TRIGGER work_signal_provider_authority_no_update");
      if (corruption === "missing") {
        value.database.query("DELETE FROM work_signal_provider_authorities WHERE signal_id=?").run(effect.signalId);
      } else if (corruption === "generation") {
        value.database.query("UPDATE work_signal_provider_authorities SET process_generation=2 WHERE signal_id=?").run(effect.signalId);
      } else {
        value.database.query("UPDATE work_signal_provider_authorities SET authority_digest=? WHERE signal_id=?")
          .run("0".repeat(64), effect.signalId);
      }
      value.database.exec(WORK_SIGNAL_PROVIDER_AUTHORITY_SCHEMA_SQL);
      expect(() => assertWorkSignalProviderAuthorities(value.database)).toThrow(
        corruption === "missing" ? "WORK_SIGNAL_PROVIDER_AUTHORITY_MISSING" : "WORK_SIGNAL_PROVIDER_AUTHORITY_CORRUPT",
      );
      expect(value.store.authorizePreparedEffect(key).executable).toBe(false);
    }
  });

  test("work signal authority audit refuses altered guard structure without repairing it", () => {
    const value = fixture();
    prepareSignal(value);
    value.database.exec(`DROP TRIGGER work_signal_provider_authority_no_update;
      CREATE TRIGGER work_signal_provider_authority_no_update
      BEFORE UPDATE ON work_signal_provider_authorities BEGIN SELECT 1; END;`);
    expect(() => assertWorkSignalProviderAuthorities(value.database)).toThrow("WORK_SIGNAL_PROVIDER_AUTHORITY_SCHEMA_INVALID");
    expect(value.database.query("SELECT sql FROM sqlite_master WHERE name='work_signal_provider_authority_no_update'").get())
      .toEqual({ sql: expect.stringContaining("SELECT 1") });
  });

  test("work signal schema audit preserves IF NOT EXISTS inside a digest GLOB", () => {
    const value = fixture();
    const original = "*[^a-f0-9]*";
    const altered = "*[IF NOT EXISTS^a-f0-9]*";
    value.database.exec("DROP TABLE work_signal_provider_authorities");
    value.database.exec(WORK_SIGNAL_PROVIDER_AUTHORITY_SCHEMA_SQL.replace(original, altered));
    expect(value.database.query("SELECT ?1 NOT GLOB ?2 AS valid, ?1 NOT GLOB ?3 AS weakened")
      .get("g".repeat(64), original, altered)).toEqual({ valid: 0, weakened: 1 });
    const before = value.database.query("SELECT sql FROM sqlite_master WHERE name='work_signal_provider_authorities'").get();
    const changes = value.database.query("SELECT total_changes() AS count").get();
    expect(() => assertWorkSignalProviderAuthorities(value.database)).toThrow("WORK_SIGNAL_PROVIDER_AUTHORITY_SCHEMA_INVALID");
    expect(value.database.query("SELECT sql FROM sqlite_master WHERE name='work_signal_provider_authorities'").get()).toEqual(before);
    expect(value.database.query("SELECT total_changes() AS count").get()).toEqual(changes);
  });

  test("work authority schema audit preserves phrase bytes inside frozen comments", () => {
    const value = fixture();
    const original = value.database.query<{ sql: string }, []>(
      "SELECT sql FROM sqlite_master WHERE name='work_attempt_route_guard'",
    ).get();
    if (original === null) throw new Error("Expected the current route guard.");
    const altered = original.sql.replace("the exact Luna/max tuple.", "the exact IF NOT EXISTS Luna/max tuple.");
    expect(altered).not.toBe(original.sql);
    value.database.exec("DROP TRIGGER work_attempt_route_guard");
    value.database.exec(altered);
    const changes = value.database.query("SELECT total_changes() AS count").get();
    expect(() => assertWorkSchema(value.database)).toThrow("WORK_SCHEMA_STALE_TRIGGER:work_attempt_route_guard");
    expect(() => assertReadonlyWorkSchema(value.database)).toThrow("WORK_SCHEMA_STALE_TRIGGER:work_attempt_route_guard");
    expect(value.database.query("SELECT sql FROM sqlite_master WHERE name='work_attempt_route_guard'").get()).toEqual({ sql: altered });
    expect(value.database.query("SELECT total_changes() AS count").get()).toEqual(changes);
  });

  test("legacy work signals retain their instruction bytes and quarantine without inferring current authority", () => {
    const value = fixture();
    const { key, effect } = prepareSignal(value);
    const instruction = value.database.query("SELECT instruction_json,instruction_digest FROM work_prepared_effects WHERE idempotency_key=?").get(key);
    value.database.exec("DROP TRIGGER work_signal_provider_authority_no_delete");
    value.database.query("DELETE FROM work_signal_provider_authorities WHERE signal_id=?").run(effect.signalId);
    value.database.exec(WORK_SIGNAL_PROVIDER_AUTHORITY_SCHEMA_SQL);
    setSessionProfile(value, value.reviewerSessionId, { provider: "devin", preset: "ultra", contract: 2 });
    expect(() => assertWorkSignalProviderAuthorities(value.database)).toThrow("WORK_SIGNAL_PROVIDER_AUTHORITY_MISSING");
    backfillLegacyWorkSignalProviderAuthorities(value.database, 12_000);
    backfillLegacyWorkSignalProviderAuthorities(value.database, 13_000);
    expect(() => assertWorkSignalProviderAuthorities(value.database)).not.toThrow();
    expect(value.database.query("SELECT * FROM work_signal_provider_authorities WHERE signal_id=?").get(effect.signalId)).toBeNull();
    expect(value.database.query("SELECT reason,recorded_at FROM legacy_provider_authority_quarantines WHERE scope_kind='work_signal' AND scope_id=?")
      .get(effect.signalId)).toEqual({ reason: "missing_immutable_runtime_authority", recorded_at: 12_000 });
    expect(value.database.query("SELECT instruction_json,instruction_digest FROM work_prepared_effects WHERE idempotency_key=?").get(key)).toEqual(instruction);
    expect(value.store.authorizePreparedEffect(key).executable).toBe(false);
  });

  test("work signal preparation rolls back the entire operation if authority capture fails", () => {
    const value = fixture();
    const created = createWork(value);
    join(value, created.work.id, created.work.revision, value.reviewerSessionId);
    const before = value.database.query("SELECT revision,next_sequence,head_hash FROM works WHERE id=?").get(created.work.id);
    value.database.exec(`CREATE TRIGGER test_refuse_signal_authority BEFORE INSERT ON work_signal_provider_authorities
      BEGIN SELECT RAISE(ABORT,'TEST_AUTHORITY_CAPTURE_FAILURE'); END;`);
    const key = randomUUID();
    expect(() => value.store.apply({
      kind: "signal.send", idempotencyKey: key, workId: created.work.id,
      senderSessionId: value.actorSessionId, senderCapability: capability,
      targetSessionId: value.reviewerSessionId, mode: "queue", body: "Do not leave an unbound signal.",
    })).toThrow("TEST_AUTHORITY_CAPTURE_FAILURE");
    expect(value.database.query("SELECT revision,next_sequence,head_hash FROM works WHERE id=?").get(created.work.id)).toEqual(before);
    expect(value.database.query("SELECT * FROM work_signals WHERE work_id=?").all(created.work.id)).toEqual([]);
    expect(value.store.preparedEffect(key)).toBeNull();
  });

  test("work signal receipts use frozen provider generation while released wire retains the Codex mirror", () => {
    for (const useNestedReceipt of [false, true]) {
      const value = fixture();
      value.database.query("UPDATE provider_accounts SET process_generation=3 WHERE profile_id=? AND provider='claude'").run(value.accountId);
      const { key, effect } = prepareSignal(value, "claude");
      expect(effect.accountGeneration).toBe(1);
      expect(value.database.query("SELECT process_generation FROM work_signal_provider_authorities WHERE signal_id=?").get(effect.signalId))
        .toEqual({ process_generation: 3 });
      if (useNestedReceipt) {
        insertAppliedNestedMutation(value, effect);
        expect(value.store.authorizePreparedEffect(key).status.state).toBe("accepted");
      } else {
        expect(value.store.authorizePreparedEffect(key).executable).toBe(true);
        expect(() => value.store.finalizeSignal(key, { kind: "accepted", receipt: queueReceipt(1) })).toThrow("ROUTE_MISMATCH");
        expect(value.store.finalizeSignal(key, { kind: "accepted", receipt: queueReceipt(3) }).deliveryState).toBe("accepted");
      }
    }
  });

  test("work signal reconciliation rejects a borrowed same-counter nested provider authority", () => {
    for (const corruption of ["provider", "provenance", "missing"] as const) {
      const value = fixture();
      const { key, effect } = prepareSignal(value, "claude");
      insertAppliedNestedMutation(value, effect);
      if (corruption === "provider") {
        value.database.query(`UPDATE mutation_provider_authorities SET provider='codex',provider_account_id=?
          WHERE attempt_id=(SELECT id FROM mutation_attempts WHERE idempotency_key=?)`)
          .run(value.accountId, effect.nestedMutationKey);
      } else if (corruption === "provenance") {
        value.database.query("UPDATE mutation_provider_authorities SET provenance='legacy_runtime' WHERE attempt_id=(SELECT id FROM mutation_attempts WHERE idempotency_key=?)")
          .run(effect.nestedMutationKey);
      } else {
        value.database.query("DELETE FROM mutation_provider_authorities WHERE attempt_id=(SELECT id FROM mutation_attempts WHERE idempotency_key=?)")
          .run(effect.nestedMutationKey);
      }
      const result = value.store.authorizePreparedEffect(key);
      expect(result.executable).toBe(false);
      expect(result.status.state).toBe("unknown");
    }
  });

  test("legacy work signal settled receipt replay remains historical after execution quarantine", () => {
    const value = fixture();
    const { key, effect } = prepareSignal(value);
    expect(value.store.authorizePreparedEffect(key).executable).toBe(true);
    const outcome = { kind: "accepted" as const, receipt: queueReceipt() };
    const accepted = value.store.finalizeSignal(key, outcome);
    value.database.exec("DROP TRIGGER work_signal_provider_authority_no_delete");
    value.database.query("DELETE FROM work_signal_provider_authorities WHERE signal_id=?").run(effect.signalId);
    value.database.exec(WORK_SIGNAL_PROVIDER_AUTHORITY_SCHEMA_SQL);
    backfillLegacyWorkSignalProviderAuthorities(value.database, 12_000);
    expect(() => assertWorkSignalProviderAuthorities(value.database)).not.toThrow();
    expect(value.store.finalizeSignal(key, outcome)).toEqual(accepted);
    expect(value.store.authorizePreparedEffect(key).executable).toBe(false);
    expect(() => value.store.finalizeSignal(key, { kind: "accepted", receipt: queueReceipt(2) }))
      .toThrow("IDEMPOTENCY_CONFLICT");
  });

  test("creates strict append-only state with a verified event hash chain", () => {
    const value = fixture();
    const created = createWork(value);
    expect(value.database.query(
      "SELECT preset_contract FROM works WHERE id=?",
    ).get(created.work.id)).toEqual({ preset_contract: 2 });
    const page = value.store.events(created.work.id, 0, 20);
    expect(page.events.map((event) => event.body.type)).toEqual(["work.created"]);
    expect(page.events[0]?.sequence).toBe(1);
    expect(() => value.database.query(
      "UPDATE work_events SET payload_json='{}' WHERE work_id=? AND sequence=1",
    ).run(created.work.id)).toThrow("WORK_EVENT_APPEND_ONLY");
    expect(() => value.database.query(
      "UPDATE work_tasks SET objective='changed' WHERE work_id=?",
    ).run(created.work.id)).toThrow("WORK_TASK_IMMUTABLE");
    expect(() => value.database.query(
      "DELETE FROM works WHERE id=?",
    ).run(created.work.id)).toThrow("WORK_IMMUTABLE");
    const eventRow = value.database.query(
      "SELECT event_hash,previous_hash FROM work_events WHERE work_id=? AND sequence=1",
    ).get(created.work.id) as { event_hash: string; previous_hash: string | null };
    expect(eventRow.event_hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(eventRow.previous_hash).toBeNull();
    value.database.exec("DROP TRIGGER work_events_no_update");
    expect(() => assertWorkSchema(value.database)).toThrow(
      "WORK_SCHEMA_MISSING_TRIGGER:work_events_no_update",
    );
    expect(() => assertReadonlyWorkSchema(value.database)).toThrow(
      "WORK_SCHEMA_MISSING_TRIGGER:work_events_no_update",
    );
    value.database.query(
      "UPDATE work_events SET payload_json='{}' WHERE work_id=? AND sequence=1",
    ).run(created.work.id);
    expect(() => value.store.events(created.work.id, 0, 20)).toThrow(
      "WORK_EVENT_CHAIN_CORRUPT",
    );
  });

  test("rejects a weakened same-name non-authority Work trigger", () => {
    const weakenEventAppendOnlyGuard = (database: Database): void => {
      database.exec(`
        DROP TRIGGER work_events_no_update;
        CREATE TRIGGER work_events_no_update
        BEFORE UPDATE ON work_events
        WHEN OLD.sequence < 0
        BEGIN SELECT RAISE(ABORT,'WORK_EVENT_APPEND_ONLY'); END;
      `);
    };

    const current = fixture();
    weakenEventAppendOnlyGuard(current.database);
    expect(() => assertWorkSchema(current.database)).toThrow(
      "WORK_SCHEMA_STALE_TRIGGER:work_events_no_update",
    );
    expect(() => assertReadonlyWorkSchema(current.database)).toThrow(
      "WORK_SCHEMA_STALE_TRIGGER:work_events_no_update",
    );

    const predecessor = fixture();
    predecessor.database.exec("DROP TRIGGER work_session_project_authority_guard");
    installProviderVersion40WorkAuthoritySchema(predecessor.database);
    weakenEventAppendOnlyGuard(predecessor.database);
    expect(() => assertProviderVersion40WorkSchema(predecessor.database)).toThrow(
      "WORK_SCHEMA_STALE_TRIGGER:work_events_no_update",
    );
  });

  test("scans foreign keys on writable schema checks and skips the scan on readonly ones", () => {
    const value = fixture();
    expect(() => assertWorkSchema(value.database)).not.toThrow();
    expect(() => assertReadonlyWorkSchema(value.database)).not.toThrow();
    value.database.exec("PRAGMA foreign_keys=OFF");
    value.database.query(
      `INSERT INTO sessions(id,profile_id,project_id,preset,fast_enabled,state,preset_contract,canonical_profile_key)
       VALUES (?,?,?,'high',0,'active',2,'codex:gpt-6-astra:max')`,
    ).run(createSessionId(), createProfileId(), value.projectId);
    value.database.exec("PRAGMA foreign_keys=ON");
    expect(value.database.query("PRAGMA foreign_key_check").all()).toHaveLength(1);
    expect(() => assertWorkSchema(value.database)).toThrow("WORK_SCHEMA_FOREIGN_KEY_VIOLATION");
    expect(() => assertReadonlyWorkSchema(value.database)).not.toThrow();
    value.database.exec("PRAGMA foreign_keys=OFF");
    expect(() => assertReadonlyWorkSchema(value.database)).toThrow(
      "WORK_SCHEMA_FOREIGN_KEYS_DISABLED",
    );
  });

  test("rejects stale or unidentified session account authority for create, join, and claim", () => {
    const value = fixture();
    const original = createWork(value);
    value.database.query(
      `UPDATE profiles
       SET provider_email='replacement@example.com',codex_account_key=?
       WHERE id=?`,
    ).run(codexAccountKey("replacement@example.com"), value.accountId);

    expect(() => createWork(value)).toThrow(new WorkStoreError("MEMBER_NOT_FOUND"));
    expect(value.database.query("SELECT COUNT(*) AS count FROM works").get()).toEqual({ count: 1 });

    const freshCoordinatorSessionId = createSessionId();
    value.database.query(
      `INSERT INTO sessions(id,profile_id,project_id,preset,fast_enabled,state,preset_contract,canonical_profile_key)
       VALUES (?,?,?,'high',0,'active',2,'codex:gpt-6-astra:max')`,
    ).run(freshCoordinatorSessionId, value.accountId, value.projectId);
    const freshKey = randomUUID();
    const fresh = value.store.apply({
      kind: "work.create",
      idempotencyKey: freshKey,
      clientRef: `plan-${freshKey}`,
      coordinatorSessionId: freshCoordinatorSessionId,
      objective: "Use only the replacement account authority.",
      routes: [{
        accountId: value.accountId,
        projectId: value.projectId,
        preset: "high",
        fast: false,
      }],
      tasks: [taskSpec(value, "replacement")],
    });
    if (fresh.kind !== "work.create") throw new Error("unexpected result");
    expect(() => value.store.apply({
      kind: "work.join",
      idempotencyKey: randomUUID(),
      workId: fresh.work.id,
      coordinatorSessionId: freshCoordinatorSessionId,
      coordinatorCapability: capability,
      actorSessionId: value.reviewerSessionId,
    })).toThrow(new WorkStoreError("MEMBER_NOT_FOUND"));
    expect(value.database.query(
      "SELECT COUNT(*) AS count FROM work_members WHERE work_id=?",
    ).get(fresh.work.id)).toEqual({ count: 1 });
    value.database.query(
      "UPDATE sessions SET state='recovery_required' WHERE id=?",
    ).run(freshCoordinatorSessionId);
    expect(() => value.store.apply({
      kind: "task.addBatch",
      idempotencyKey: randomUUID(),
      workId: fresh.work.id,
      expectedWorkRevision: fresh.work.revision,
      coordinatorSessionId: freshCoordinatorSessionId,
      coordinatorCapability: capability,
      tasks: [taskSpec(value, "recovery-fenced")],
    })).toThrow(new WorkStoreError("ATTEMPT_NOT_OWNER"));
    expect(value.database.query(
      "SELECT COUNT(*) AS count FROM work_tasks WHERE work_id=?",
    ).get(fresh.work.id)).toEqual({ count: 1 });

    expect(() => claim(value, {
      workId: original.work.id,
      taskId: original.tasks[0]!.id,
      revision: original.tasks[0]!.revision,
    })).toThrow(new WorkStoreError("ROUTE_MISMATCH"));
    expect(value.database.query(
      "SELECT COUNT(*) AS count FROM work_attempts WHERE work_id=?",
    ).get(original.work.id)).toEqual({ count: 0 });

    const unidentified = fixture();
    unidentified.database.query(
      "UPDATE profiles SET provider_email=NULL WHERE id=?",
    ).run(unidentified.accountId);
    expect(() => createWork(unidentified)).toThrow(new WorkStoreError("MEMBER_NOT_FOUND"));
    expect(unidentified.database.query("SELECT COUNT(*) AS count FROM works").get())
      .toEqual({ count: 0 });
  });

  test("rejects current work guards against a pre-provider session schema", () => {
    const database = new Database(":memory:", { strict: true });
    databases.push(database);
    database.exec("PRAGMA foreign_keys=ON;");
    const legacyParentSchema = parentSchema.replace(
      "  provider_v39 TEXT NOT NULL DEFAULT 'codex',\n",
      "",
    );
    expect(legacyParentSchema).not.toBe(parentSchema);
    database.exec(legacyParentSchema);
    database.exec(WORK_SCHEMA_SQL);
    database.exec(WORK_PROJECT_AUTHORITY_SCHEMA_SQL);

    expect(() => assertWorkSchema(database)).toThrow(
      "WORK_SCHEMA_STALE:sessions.provider_v39",
    );
    expect(() => assertReadonlyWorkSchema(database)).toThrow(
      "WORK_SCHEMA_STALE:sessions.provider_v39",
    );
  });

  test("rejects current work guards against a pre-contract session schema", () => {
    const database = new Database(":memory:", { strict: true });
    databases.push(database);
    database.exec("PRAGMA foreign_keys=ON;");
    const legacyParentSchema = parentSchema.replace(
      "  preset_contract INTEGER NOT NULL DEFAULT 1 CHECK(preset_contract IN (1,2)),\n",
      "",
    );
    expect(legacyParentSchema).not.toBe(parentSchema);
    database.exec(legacyParentSchema);
    database.exec(WORK_SCHEMA_SQL);
    database.exec(WORK_PROJECT_AUTHORITY_SCHEMA_SQL);
    expect(() => assertWorkSchema(database)).toThrow(
      "WORK_SCHEMA_STALE:sessions.preset_contract",
    );
    expect(() => assertReadonlyWorkSchema(database)).toThrow(
      "WORK_SCHEMA_STALE:sessions.preset_contract",
    );
  });

  test("rejects a Sol-bound Work row owned by a historical Devin coordinator", () => {
    const value = fixture();
    const created = createWork(value);
    // A reduced contract 1 (Sol) Work, not an untouched old-release artifact.
    rewriteWorkPresetContract(value, created.work.id, 1);
    value.database.exec("DROP TRIGGER work_session_devin_contract_guard");
    setSessionProfile(value, value.actorSessionId, { provider: "devin", preset: "ultra", contract: 2 });
    value.database.exec(WORK_SCHEMA_SQL);

    expect(() => assertWorkSchema(value.database)).toThrow(
      "WORK_SCHEMA_DEVIN_WORK_PRESET_CONTRACT_INVALID",
    );
    expect(() => assertReadonlyWorkSchema(value.database)).toThrow(
      "WORK_SCHEMA_DEVIN_WORK_PRESET_CONTRACT_INVALID",
    );
  });

  test("replays an exact UUID result and rejects changed semantic intent", () => {
    const value = fixture();
    const key = randomUUID();
    const operation = {
      kind: "work.create",
      idempotencyKey: key,
      clientRef: "semantic-replay",
      coordinatorSessionId: value.actorSessionId,
      objective: "Do the exact requested work.",
      routes: [{
        accountId: value.accountId,
        projectId: value.projectId,
        preset: "high",
        fast: false,
      }],
      tasks: [taskSpec(value)],
    } satisfies WorkOperation;
    const first = value.store.apply(operation);
    expect(value.store.apply(structuredClone(operation))).toEqual(first);
    const reordered = {
      tasks: operation.tasks.map((task) => ({
        minEvidence: task.minEvidence,
        resultKind: task.resultKind,
        requiredReviews: task.requiredReviews,
        maxAttempts: task.maxAttempts,
        priority: task.priority,
        fast: task.fast,
        preset: task.preset,
        route: {
          projectId: task.route.projectId,
          accountId: task.route.accountId,
        },
        criteria: [...task.criteria],
        instructions: task.instructions,
        objective: task.objective,
        dependsOnTaskIds: [...task.dependsOnTaskIds],
        dependsOnRefs: [...task.dependsOnRefs],
        clientRef: task.clientRef,
      })),
      routes: operation.routes.map((route) => ({
        fast: route.fast,
        preset: route.preset,
        projectId: route.projectId,
        accountId: route.accountId,
      })),
      objective: operation.objective,
      coordinatorSessionId: operation.coordinatorSessionId,
      clientRef: operation.clientRef,
      idempotencyKey: operation.idempotencyKey,
      kind: operation.kind,
    } satisfies WorkOperation;
    expect(value.store.apply(reordered)).toEqual(first);
    expect(() => value.store.apply({ ...operation, objective: "Changed meaning." })).toThrow(
      new WorkStoreError("IDEMPOTENCY_CONFLICT"),
    );
    expect(value.database.query("SELECT COUNT(*) AS count FROM works").get()).toEqual({ count: 1 });
  });

  test("admits fresh Work creation only from a current v2 source and replays historical sources", () => {
    const value = fixture();
    const operation = {
      kind: "work.create",
      idempotencyKey: randomUUID(),
      clientRef: "source-bound-create",
      coordinatorSessionId: value.actorSessionId,
      objective: "Bind the caller-authored Work source.",
      routes: [{
        accountId: value.accountId,
        projectId: value.projectId,
        preset: "high",
        fast: false,
      }],
      tasks: [taskSpec(value, "source-bound-high")],
    } satisfies WorkOperation;
    const counts = (): Readonly<{ intents: number; works: number }> => ({
      intents: (value.database.query(
        "SELECT COUNT(*) AS count FROM work_idempotency_intents",
      ).get() as { count: number }).count,
      works: (value.database.query("SELECT COUNT(*) AS count FROM works").get() as {
        count: number;
      }).count,
    });

    expect(() => value.store.apply(operation, operation.idempotencyKey, {
      version: WORK_APPLY_REQUEST_LEGACY_VERSION,
    })).toThrow(new WorkStoreError("ROUTE_MISMATCH"));
    expect(() => value.store.apply(operation, operation.idempotencyKey, {
      version: WORK_APPLY_REQUEST_VERSION,
      presetContract: 1,
    })).toThrow(new WorkStoreError("ROUTE_MISMATCH"));
    expect(counts()).toEqual({ intents: 0, works: 0 });

    const applied = value.store.apply(operation, operation.idempotencyKey, {
      version: WORK_APPLY_REQUEST_VERSION,
      presetContract: 2,
    });
    if (applied.kind !== "work.create") throw new Error("unexpected result");
    expect(value.store.apply(structuredClone(operation), operation.idempotencyKey, {
      version: WORK_APPLY_REQUEST_VERSION,
      presetContract: 2,
    })).toEqual(applied);
    expect(() => value.store.apply(operation, operation.idempotencyKey, {
      version: WORK_APPLY_REQUEST_LEGACY_VERSION,
    })).toThrow(new WorkStoreError("IDEMPOTENCY_CONFLICT"));
    expect(() => value.store.apply(operation, operation.idempotencyKey, {
      version: WORK_APPLY_REQUEST_VERSION,
      presetContract: 1,
    })).toThrow(new WorkStoreError("IDEMPOTENCY_CONFLICT"));

    rewriteIntentDigest(value, operation.idempotencyKey, requestDigest(operation));
    rewriteWorkPresetContract(value, applied.work.id, 1);
    expect(value.store.apply(operation, operation.idempotencyKey, {
      version: WORK_APPLY_REQUEST_LEGACY_VERSION,
    })).toEqual(applied);
    expect(() => value.store.apply(operation, operation.idempotencyKey, {
      version: WORK_APPLY_REQUEST_VERSION,
      presetContract: 1,
    })).toThrow(new WorkStoreError("IDEMPOTENCY_CONFLICT"));

    const historicalV2 = {
      ...operation,
      idempotencyKey: randomUUID(),
      clientRef: "source-bound-historical-v2",
    } satisfies WorkOperation;
    const historicalResult = value.store.apply(historicalV2, historicalV2.idempotencyKey, {
      version: WORK_APPLY_REQUEST_VERSION,
      presetContract: 2,
    });
    if (historicalResult.kind !== "work.create") throw new Error("unexpected result");
    rewriteIntentDigest(value, historicalV2.idempotencyKey, requestDigest({
      requestVersion: WORK_APPLY_REQUEST_VERSION,
      presetContract: 1,
      operation: historicalV2,
    }));
    rewriteWorkPresetContract(value, historicalResult.work.id, 1);
    expect(value.store.apply(historicalV2, historicalV2.idempotencyKey, {
      version: WORK_APPLY_REQUEST_VERSION,
      presetContract: 1,
    })).toEqual(historicalResult);

    const beforeFreshStale = counts();
    expect(() => value.store.apply({
      ...historicalV2,
      idempotencyKey: randomUUID(),
      clientRef: "source-bound-fresh-stale-v2",
    }, undefined, {
      version: WORK_APPLY_REQUEST_VERSION,
      presetContract: 1,
    })).toThrow(new WorkStoreError("ROUTE_MISMATCH"));
    expect(counts()).toEqual(beforeFreshStale);
  });

  test("rejects unresolved graph references and route failures without partial admission", () => {
    const value = fixture();
    const created = createWork(value);
    const revision = created.work.revision;
    expect(() => value.store.apply({
      kind: "task.addBatch",
      idempotencyKey: randomUUID(),
      workId: created.work.id,
      expectedWorkRevision: revision,
      coordinatorSessionId: value.actorSessionId,
      coordinatorCapability: capability,
      tasks: [taskSpec(value, "bad-dependency", { dependsOnRefs: ["missing"] })],
    })).toThrow(new WorkStoreError("UNKNOWN_DEPENDENCY"));
    expect(value.store.snapshot(created.work.id).work.revision).toBe(revision);
    expect(value.store.snapshot(created.work.id).tasks).toHaveLength(1);

    const missingProject = createProjectId();
    expect(() => value.store.apply({
      kind: "task.addBatch",
      idempotencyKey: randomUUID(),
      workId: created.work.id,
      expectedWorkRevision: revision,
      coordinatorSessionId: value.actorSessionId,
      coordinatorCapability: capability,
      tasks: [taskSpec(value, "bad-route", {
        route: { accountId: value.accountId, projectId: missingProject },
      })],
    })).toThrow(new WorkStoreError("ROUTE_MISMATCH"));
    expect(value.database.query(
      "SELECT COUNT(*) AS count FROM work_tasks WHERE work_id=?",
    ).get(created.work.id)).toEqual({ count: 1 });
  });

  test("keeps coordination provider-neutral while attempts remain Codex-only", () => {
    const value = fixture();
    expect(() => value.store.assertSessionProviderSwitchAllowed(value.actorSessionId))
      .not.toThrow();

    for (const sessionId of [value.actorSessionId, value.reviewerSessionId]) {
      setSessionProfile(value, sessionId, { provider: "claude", preset: "ultra" });
      value.database.query(
        `UPDATE session_provider_account_authorities
         SET provider='claude',runtime_scope='managed',account_key=?
         WHERE session_id=?`,
      ).run(claudeAccountKey("managed-work-account"), sessionId);
    }

    const created = createWork(value, [
      taskSpec(value, "claude-attempt-a", { preset: "ultra" }),
      taskSpec(value, "claude-attempt-b", { preset: "ultra" }),
    ]);
    join(value, created.work.id, created.work.revision, value.reviewerSessionId);

    // Membership and coordination are transport-neutral, but entering or
    // leaving either provider is fenced while the session belongs to live Work.
    expect(() => value.store.assertSessionProviderSwitchAllowed(value.actorSessionId))
      .toThrow(new WorkStoreError("SESSION_PROVIDER_SWITCH_BLOCKED"));
    expect(() => value.store.assertSessionProviderSwitchAllowed(value.reviewerSessionId))
      .toThrow(new WorkStoreError("SESSION_PROVIDER_SWITCH_BLOCKED"));

    expect(() => claim(value, {
      workId: created.work.id,
      taskId: created.tasks[0]!.id,
      revision: created.tasks[0]!.revision,
    })).toThrow(new WorkStoreError("ROUTE_MISMATCH"));
    expect(() => claim(value, {
      workId: created.work.id,
      taskId: created.tasks[1]!.id,
      revision: created.tasks[1]!.revision,
      actorSessionId: value.reviewerSessionId,
    })).toThrow(new WorkStoreError("ROUTE_MISMATCH"));
    expect(value.database.query("SELECT COUNT(*) AS count FROM work_attempts").get())
      .toEqual({ count: 0 });
    expect(() => assertWorkSchema(value.database)).not.toThrow();
  });

  test("rejects fresh rebound tasks on a legacy Work while preserving exact replay and stable additions", () => {
    const value = fixture();
    const created = createWork(value, [
      taskSpec(value, "existing-high"),
      taskSpec(value, "existing-low", { preset: "low" }),
    ]);
    const reboundOperation = {
      kind: "task.addBatch",
      idempotencyKey: randomUUID(),
      workId: created.work.id,
      expectedWorkRevision: created.work.revision,
      coordinatorSessionId: value.actorSessionId,
      coordinatorCapability: capability,
      tasks: [taskSpec(value, "added-high")],
    } satisfies WorkOperation;
    const applied = value.store.apply(
      reboundOperation,
      reboundOperation.idempotencyKey,
      { version: WORK_APPLY_REQUEST_VERSION, presetContract: 2 },
    );
    if (applied.kind !== "task.addBatch") throw new Error("unexpected result");
    expect(() => value.store.apply(
      reboundOperation,
      reboundOperation.idempotencyKey,
      { version: WORK_APPLY_REQUEST_VERSION, presetContract: 1 },
    )).toThrow(new WorkStoreError("IDEMPOTENCY_CONFLICT"));

    // Recreate an immutable Work written by the preceding contract. The exact
    // applied intent remains historical, while any new rebound task must be
    // admitted under the active Work contract.
    rewriteWorkPresetContract(value, created.work.id, 1);
    assertWorkSchema(value.database);
    expect(value.store.apply(
      structuredClone(reboundOperation),
      reboundOperation.idempotencyKey,
      { version: WORK_APPLY_REQUEST_VERSION, presetContract: 2 },
    )).toEqual(applied);
    rewriteIntentDigest(value, reboundOperation.idempotencyKey, requestDigest({
      requestVersion: WORK_APPLY_REQUEST_VERSION,
      presetContract: 1,
      operation: reboundOperation,
    }));
    expect(value.store.apply(
      structuredClone(reboundOperation),
      reboundOperation.idempotencyKey,
      { version: WORK_APPLY_REQUEST_VERSION, presetContract: 1 },
    )).toEqual(applied);

    const taskCount = value.database.query(
      "SELECT COUNT(*) AS count FROM work_tasks WHERE work_id=?",
    ).get(created.work.id);
    const intentCount = value.database.query(
      "SELECT COUNT(*) AS count FROM work_idempotency_intents WHERE work_id=?",
    ).get(created.work.id);
    const freshHigh = {
      ...reboundOperation,
      idempotencyKey: randomUUID(),
      expectedWorkRevision: applied.workRevision,
      tasks: [taskSpec(value, "fresh-high")],
    } satisfies WorkOperation;
    expect(() => value.store.apply(freshHigh, undefined, {
      version: WORK_APPLY_REQUEST_LEGACY_VERSION,
    })).toThrow(new WorkStoreError("ROUTE_MISMATCH"));
    expect(() => value.store.apply(freshHigh, undefined, {
      version: WORK_APPLY_REQUEST_VERSION,
      presetContract: 1,
    })).toThrow(new WorkStoreError("ROUTE_MISMATCH"));
    expect(() => value.store.apply(freshHigh, undefined, {
      version: WORK_APPLY_REQUEST_VERSION,
      presetContract: 2,
    })).toThrow(new WorkStoreError("ROUTE_MISMATCH"));
    expect(value.database.query(
      "SELECT COUNT(*) AS count FROM work_tasks WHERE work_id=?",
    ).get(created.work.id)).toEqual(taskCount);
    expect(value.database.query(
      "SELECT COUNT(*) AS count FROM work_idempotency_intents WHERE work_id=?",
    ).get(created.work.id)).toEqual(intentCount);

    const stableV1 = value.store.apply({
      ...reboundOperation,
      idempotencyKey: randomUUID(),
      expectedWorkRevision: applied.workRevision,
      tasks: [taskSpec(value, "fresh-low", { preset: "low" })],
    }, undefined, { version: WORK_APPLY_REQUEST_LEGACY_VERSION });
    expect(stableV1).toMatchObject({ kind: "task.addBatch" });
    const stableV2 = value.store.apply({
      ...reboundOperation,
      idempotencyKey: randomUUID(),
      expectedWorkRevision: stableV1.workRevision,
      tasks: [taskSpec(value, "fresh-low-v2", { preset: "low" })],
    }, undefined, { version: WORK_APPLY_REQUEST_VERSION });
    expect(stableV2).toMatchObject({ kind: "task.addBatch" });
  });
});

describe("WorkStore original send ownership", () => {
  test.each(["input_required", "effect_started", "accepted", "ambiguous", "abandoned", "cancelled"] as const)("original send ownership: rejects coherent %s owner without changing either journal", async (stage) => {
    const value = await originalSendOwnerFixture();
    const prepared = prepareOwnerGuardDispatch(value);
    const owner = prepareOriginalSendOwner(value, prepared.effect.nestedMutationKey, workPreparedEffectMessage(prepared.effect));
    if (stage === "cancelled") {
      value.stateStore.cancelOwnedSessionSend({ attemptId: owner.owner.attemptId, ownerDigest: owner.ownerDigest });
    } else if (stage !== "input_required") {
      const claim = claimOriginalSendOwner(value, owner);
      if (claim.claim === null || claim.claimDigest === null) throw new Error("owned direct claim missing");
      const settlement = {
        attemptId: owner.owner.attemptId,
        ownerDigest: owner.ownerDigest,
        claimDigest: claim.claimDigest,
      };
      if (stage === "accepted") {
        value.stateStore.settleOwnedDirectSend({
          ...settlement,
          outcome: { kind: "accepted", receipt: {
            sourceId: owner.owner.attemptId,
            turnId: "original-owned-turn",
            status: "completed",
            effectiveRuntimeProfile: claim.claim.evidence.runtimeProfile,
          } },
        });
      } else if (stage === "ambiguous" || stage === "abandoned") {
        value.stateStore.settleOwnedDirectSend({ ...settlement, outcome: { kind: "ambiguous", reason: "provider_outcome_unknown" } });
        if (stage === "abandoned") {
          value.stateStore.settleOwnedDirectSend({ ...settlement, outcome: { kind: "abandoned", acknowledgeOutcomeUnknown: true } });
        }
      }
    }
    const before = value.stateStore.readOwnedSessionSend(prepared.effect.nestedMutationKey);
    expect(before?.state).toBe(stage);
    const workBefore = value.store.snapshot(prepared.created.work.id);
    const rejected = new WorkStoreError("ATTEMPT_RECOVERY_REQUIRED");
    expect(() => value.store.authorizePreparedEffect(prepared.operation.idempotencyKey)).toThrow(rejected);
    expect(() => value.store.reprojectPreparedEffect(prepared.operation.idempotencyKey)).toThrow(rejected);
    expect(() => value.store.settlePreparedEffectNoEffect(prepared.operation.idempotencyKey, "not_dispatched")).toThrow(rejected);
    expect(() => value.store.apply(prepared.operation)).toThrow(rejected);
    expect(value.stateStore.readOwnedSessionSend(prepared.effect.nestedMutationKey)).toEqual(before);
    expect(value.store.snapshot(prepared.created.work.id)).toEqual(workBefore);
    expect(value.store.effectStatus(prepared.operation.idempotencyKey)?.state).toBe("prepared");
    expect(value.database.query("SELECT COUNT(*) AS count FROM work_nested_effect_settlements").get()).toEqual({ count: 0 });
  });

  test("original send ownership: keeps the independent top-level Work intent namespace usable", async () => {
    const value = await originalSendOwnerFixture();
    const key = randomUUID();
    const owner = prepareOriginalSendOwner(value, key);
    const prepared = prepareOwnerGuardDispatch(value, key);
    expect(prepared.effect.nestedMutationKey).not.toBe(key);
    expect(value.store.authorizePreparedEffect(key).executable).toBe(true);
    expect(value.store.apply(prepared.operation).kind).toBe("attempt.dispatch");
    expect(value.stateStore.readOwnedSessionSend(key)).toEqual({
      kind: owner.kind,
      owner: owner.owner,
      ownerDigest: owner.ownerDigest,
      claim: null,
      claimDigest: null,
      outcomes: [],
      state: "input_required",
    });
    expect(value.stateStore.readMutation(prepared.effect.nestedMutationKey)).toBeNull();
  });

  test.each(["marker", "owner", "anchor", "orphan", "relocated"] as const)(
    "original send ownership: rejects %s ownership corruption without legacy fallback",
    async (corruption) => {
      const value = await originalSendOwnerFixture();
      const prepared = prepareOwnerGuardDispatch(value);
      const owner = prepareOriginalSendOwner(value, prepared.effect.nestedMutationKey, workPreparedEffectMessage(prepared.effect));
      value.database.exec("PRAGMA foreign_keys=OFF");
      try {
        if (corruption === "marker") {
          value.database.exec("DROP TRIGGER session_send_format_immutable; DROP TRIGGER session_send_mutation_guard");
          value.database.query("UPDATE mutation_attempts SET request_format=NULL WHERE id=?").run(owner.owner.attemptId);
        } else if (corruption === "owner") {
          value.database.exec("DROP TRIGGER session_send_owners_immutable_delete");
          value.database.query("DELETE FROM session_send_owners WHERE attempt_id=?").run(owner.owner.attemptId);
        } else if (corruption === "anchor") {
          value.database.exec("DROP TRIGGER session_send_owner_anchors_immutable_delete");
          value.database.query("DELETE FROM session_send_owner_anchors WHERE attempt_id=?").run(owner.owner.attemptId);
        } else if (corruption === "orphan") {
          const attachmentGuard = value.database.query("SELECT sql FROM sqlite_master WHERE name='attachment_parent_delete_guard'").get() as { sql: string };
          value.database.exec("DROP TRIGGER session_send_mutation_delete_guard; DROP TRIGGER attachment_parent_delete_guard");
          try {
            value.database.query("DELETE FROM mutation_attempts WHERE id=?").run(owner.owner.attemptId);
          } finally {
            value.database.exec(attachmentGuard.sql);
          }
        } else {
          const attachmentGuard = value.database.query("SELECT sql FROM sqlite_master WHERE name='attachment_parent_immutable'").get() as { sql: string };
          value.database.exec("DROP TRIGGER session_send_mutation_guard; DROP TRIGGER attachment_parent_immutable");
          try {
            value.database.query("UPDATE mutation_attempts SET idempotency_key=? WHERE id=?")
              .run(randomUUID(), owner.owner.attemptId);
          } finally {
            value.database.exec(attachmentGuard.sql);
          }
        }
        applySessionSendOwnerSchema(value.database);
      } finally {
        value.database.exec("PRAGMA foreign_keys=ON");
      }
      const workBefore = value.store.snapshot(prepared.created.work.id);
      const mutationBefore = value.database.query("SELECT * FROM mutation_attempts WHERE id=?").get(owner.owner.attemptId);
      const rejected = new WorkStoreError("ATTEMPT_RECOVERY_REQUIRED");
      expect(() => value.store.authorizePreparedEffect(prepared.operation.idempotencyKey)).toThrow(rejected);
      expect(() => value.store.reprojectPreparedEffect(prepared.operation.idempotencyKey)).toThrow(rejected);
      expect(() => value.store.settlePreparedEffectNoEffect(prepared.operation.idempotencyKey, "not_dispatched")).toThrow(rejected);
      expect(() => value.store.apply(prepared.operation)).toThrow(rejected);
      expect(value.store.snapshot(prepared.created.work.id)).toEqual(workBefore);
      expect(value.database.query("SELECT * FROM mutation_attempts WHERE id=?").get(owner.owner.attemptId)).toEqual(mutationBefore);
      expect(value.database.query("SELECT COUNT(*) AS count FROM work_nested_effect_settlements").get()).toEqual({ count: 0 });
    },
  );

  test("original send ownership: rejects marker-only nested receipts without accepting Work effects", () => {
    const value = fixture();
    const prepared = prepareOwnerGuardDispatch(value);
    insertAppliedNestedMutation(value, prepared.effect);
    markNestedRequestAsOwned(value, prepared.effect);
    const before = value.database.query("SELECT * FROM mutation_attempts WHERE idempotency_key=?")
      .get(prepared.effect.nestedMutationKey);

    expect(() => value.store.authorizePreparedEffect(prepared.operation.idempotencyKey))
      .toThrow(new WorkStoreError("ATTEMPT_RECOVERY_REQUIRED"));
    expect(() => value.store.reprojectPreparedEffect(prepared.operation.idempotencyKey))
      .toThrow(new WorkStoreError("ATTEMPT_RECOVERY_REQUIRED"));
    expect(value.store.effectStatus(prepared.operation.idempotencyKey)?.state).toBe("prepared");
    expect(value.store.snapshot(prepared.created.work.id).tasks).toHaveLength(1);
    expect(value.database.query("SELECT * FROM mutation_attempts WHERE idempotency_key=?")
      .get(prepared.effect.nestedMutationKey)).toEqual(before);
    expect(value.database.query("SELECT COUNT(*) AS count FROM work_nested_effect_settlements").get())
      .toEqual({ count: 0 });
  });

  test("original send ownership: rejects settled Work dispatch and signal replay while retaining history", () => {
    for (const kind of ["dispatch", "signal"] as const) {
      const value = fixture();
      const dispatch = kind === "dispatch" ? prepareOwnerGuardDispatch(value) : null;
      const signal = kind === "signal" ? prepareSignal(value) : null;
      const effect = dispatch?.effect ?? signal?.effect;
      const key = dispatch?.operation.idempotencyKey ?? signal?.key;
      const workId = dispatch?.created.work.id ?? signal?.workId;
      if (effect === undefined || key === undefined || workId === undefined) {
        throw new Error("settled owner guard fixture missing");
      }
      expect(value.store.authorizePreparedEffect(key).executable).toBe(true);
      const dispatchOutcome = { kind: "accepted" as const, receipt: turnStartedReceipt() };
      const signalOutcome = { kind: "accepted" as const, receipt: queueReceipt() };
      const finalize = () => kind === "dispatch"
        ? value.store.finalizeDispatch(key, dispatchOutcome)
        : value.store.finalizeSignal(key, signalOutcome);
      finalize();
      insertAppliedNestedMutation(value, effect);
      markNestedRequestAsOwned(value, effect);
      const history = value.store.snapshot(workId);

      expect(() => finalize()).toThrow(new WorkStoreError("ATTEMPT_RECOVERY_REQUIRED"));
      expect(() => value.store.authorizePreparedEffect(key))
        .toThrow(new WorkStoreError("ATTEMPT_RECOVERY_REQUIRED"));
      expect(() => value.store.reprojectPreparedEffect(key))
        .toThrow(new WorkStoreError("ATTEMPT_RECOVERY_REQUIRED"));
      expect(value.store.effectStatus(key)?.state).toBe("accepted");
      expect(value.store.snapshot(workId)).toEqual(history);
    }
  });

  test("original send ownership: rejects redirected settled instruction keys even with a replaced digest", () => {
    for (const kind of ["dispatch", "signal"] as const) {
      for (const replaceDigest of [false, true]) {
        const value = fixture();
        const dispatch = kind === "dispatch" ? prepareOwnerGuardDispatch(value) : null;
        const signal = kind === "signal" ? prepareSignal(value) : null;
        const effect = dispatch?.effect ?? signal?.effect;
        const key = dispatch?.operation.idempotencyKey ?? signal?.key;
        if (effect === undefined || key === undefined) throw new Error("redirected owner fixture missing");
        value.store.authorizePreparedEffect(key);
        const dispatchOutcome = { kind: "accepted" as const, receipt: turnStartedReceipt() };
        const signalOutcome = { kind: "accepted" as const, receipt: queueReceipt() };
        const finalize = () => kind === "dispatch"
          ? value.store.finalizeDispatch(key, dispatchOutcome)
          : value.store.finalizeSignal(key, signalOutcome);
        finalize();
        insertAppliedNestedMutation(value, effect);
        markNestedRequestAsOwned(value, effect);
        const redirected = JSON.stringify({ ...effect, nestedMutationKey: randomUUID() });
        value.database.exec("DROP TRIGGER work_effect_identity_immutable");
        value.database.query(`UPDATE work_prepared_effects SET instruction_json=?,
          instruction_digest=CASE WHEN ? THEN ? ELSE instruction_digest END WHERE idempotency_key=?`)
          .run(redirected, replaceDigest ? 1 : 0, createHash("sha256").update(redirected).digest("hex"), key);
        value.database.exec(WORK_SCHEMA_SQL);

        expect(() => finalize()).toThrow("WORK_EFFECT_INSTRUCTION_CORRUPT");
        expect(() => value.store.authorizePreparedEffect(key)).toThrow("WORK_EFFECT_INSTRUCTION_CORRUPT");
        expect(() => value.store.reprojectPreparedEffect(key)).toThrow("WORK_EFFECT_INSTRUCTION_CORRUPT");
        expect(value.store.effectStatus(key)?.state).toBe("accepted");
      }
    }
  });
});

describe("WorkStore claims, fences, and prepared effects", () => {
  test("requires signed-in Oompa account authority for established Claude work", () => {
    const value = fixture();
    value.database.query("UPDATE sessions SET provider='claude' WHERE profile_id=?")
      .run(value.accountId);
    value.database.query("UPDATE profiles SET state='signed_out',process_generation=0 WHERE id=?")
      .run(value.accountId);

    expect(() => createWork(value)).toThrow(new WorkStoreError("MEMBER_NOT_FOUND"));
    expect(value.database.query("SELECT COUNT(*) AS count FROM works").get()).toEqual({ count: 0 });
  });

  test("refuses a claim when the session and immutable work preset contracts differ", () => {
    const value = fixture();
    const created = createWork(value);
    setSessionProfile(value, value.actorSessionId, { contract: 1 });
    expect(() => claim(value, {
      workId: created.work.id,
      taskId: created.tasks[0]!.id,
      revision: created.tasks[0]!.revision,
    })).toThrow(new WorkStoreError("ROUTE_MISMATCH"));

    setSessionProfile(value, value.actorSessionId, { contract: 2 });
    expect(claim(value, {
      workId: created.work.id,
      taskId: created.tasks[0]!.id,
      revision: created.tasks[0]!.revision,
    }).attempt.fence).toBe(1);
    expect(() => setSessionProfile(value, value.actorSessionId, { contract: 1 }))
      .toThrow("WORK_SESSION_ATTEMPT_AUTHORITY");
  });

  test("reopens, authorizes, and settles an established contract-1 Codex Work dispatch", () => {
    const value = fixture();
    const created = createWork(value);

    // Shape the preceding contract and its matching canonical provenance.
    // This remains a reduced fixture, not an untouched historical artifact.
    rewriteWorkPresetContract(value, created.work.id, 1);
    setSessionProfile(value, value.actorSessionId, { provider: "codex", preset: "high", contract: 1 });
    assertWorkSchema(value.database);

    const reopened = new WorkStore(value.database, {
      daemonGeneration: 8,
      now: () => value.now.value,
      encodeCursor,
      issueCapability,
      verifyCapability,
      projectProviderIdentifier,
    });
    const reopenedValue: Fixture = { ...value, store: reopened };
    expect(reopened.snapshot(created.work.id).work.id).toBe(created.work.id);
    expect(value.database.query(
      "SELECT preset_contract FROM works WHERE id=?",
    ).get(created.work.id)).toEqual({ preset_contract: 1 });

    const claimed = claim(reopenedValue, {
      workId: created.work.id,
      taskId: created.tasks[0]!.id,
      revision: created.tasks[0]!.revision,
    });
    const dispatchKey = randomUUID();
    const prepared = reopened.apply({
      kind: "attempt.dispatch",
      idempotencyKey: dispatchKey,
      workId: created.work.id,
      attemptId: claimed.attempt.id,
      expectedAttemptRevision: claimed.attempt.revision,
      fence: claimed.attempt.fence,
      actorSessionId: value.actorSessionId,
      attemptCapability: capability,
      targetSessionId: value.actorSessionId,
      mode: "send",
    });
    expect(prepared.kind).toBe("attempt.dispatch");
    expect(reopened.authorizePreparedEffect(dispatchKey)).toMatchObject({
      executable: true,
      status: { state: "effect_started" },
    });
    const running = reopened.finalizeDispatch(dispatchKey, {
      kind: "accepted",
      receipt: turnStartedReceipt(),
    });
    expect(running.status).toBe("active");
    expect(reopened.effectStatus(dispatchKey)).toMatchObject({ state: "accepted" });
  });

  test("rejects a retired Devin coordinator without weakening its historical session binding", () => {
    const value = fixture();
    setSessionProfile(value, value.actorSessionId, { provider: "devin", preset: "ultra", contract: 2 });

    expect(() => createWork(value)).toThrow(new WorkStoreError("MEMBER_NOT_FOUND"));
    expect(value.database.query(
      "SELECT preset_contract,provider_v39 FROM sessions WHERE id=?",
    ).get(value.actorSessionId)).toEqual({
      preset_contract: 2,
      provider_v39: "devin",
    });
    // Preserve the independent frozen Devin guard control. There is no valid
    // canonical Devin contract-1 key with which to reach that older guard.
    withFixtureGuardsRemoved(value, ["canonical_profile_session_update_guard"], () => {
      expect(() => value.database.query(
        "UPDATE sessions SET preset_contract=1 WHERE id=?",
      ).run(value.actorSessionId)).toThrow("WORK_DEVIN_PRESET_CONTRACT_MISMATCH");
    });
  });

  test("treats the byte-identical low route as compatible across contracts", () => {
    const value = fixture();
    const created = createWork(value, [taskSpec(value, "low-contract", {
      preset: "low",
    })]);
    setSessionProfile(value, value.actorSessionId, { preset: "low", contract: 1 });

    setSessionProfile(value, value.actorSessionId, { provider: "claude", preset: "ultra" });
    expect(() => claim(value, {
      workId: created.work.id,
      taskId: created.tasks[0]!.id,
      revision: created.tasks[0]!.revision,
    })).toThrow(new WorkStoreError("ROUTE_MISMATCH"));
    setSessionProfile(value, value.actorSessionId, { provider: "codex", preset: "low" });
    const claimed = claim(value, {
      workId: created.work.id,
      taskId: created.tasks[0]!.id,
      revision: created.tasks[0]!.revision,
    });
    expect(() => setSessionProfile(value, value.actorSessionId, { contract: 2 })).not.toThrow();

    const dispatchKey = randomUUID();
    value.store.apply({
      kind: "attempt.dispatch",
      idempotencyKey: dispatchKey,
      workId: created.work.id,
      attemptId: claimed.attempt.id,
      expectedAttemptRevision: claimed.attempt.revision,
      fence: claimed.attempt.fence,
      actorSessionId: value.actorSessionId,
      attemptCapability: capability,
      targetSessionId: value.actorSessionId,
      mode: "send",
    });
    expect(value.store.authorizePreparedEffect(dispatchKey)).toMatchObject({
      executable: true,
    });
  });

  test("gives signed-out adopted Claude coordinator, member, signal, and ack authority", () => {
    const value = fixture();
    const accountKey = claudeAccountKey("personal-work-signals");
    bindPersonalProviderAuthority(
      value,
      value.actorSessionId,
      "claude",
      "personal-claude-work-actor",
      accountKey,
    );
    bindPersonalProviderAuthority(
      value,
      value.reviewerSessionId,
      "claude",
      "personal-claude-work-reviewer",
      accountKey,
    );
    value.database.query(
      `UPDATE profiles
       SET state='signed_out',provider_email=NULL,codex_account_key=NULL
       WHERE id=?`,
    ).run(value.accountId);
    for (const sessionId of [value.actorSessionId, value.reviewerSessionId]) {
      setSessionProfile(value, sessionId, { preset: "ultra" });
    }

    const created = createWork(value, [taskSpec(value, "claude-tier-collision", {
      preset: "ultra",
    })]);
    join(value, created.work.id, created.work.revision, value.actorSessionId);
    join(value, created.work.id, created.work.revision, value.reviewerSessionId);
    expect(() => claim(value, {
      workId: created.work.id,
      taskId: created.tasks[0]!.id,
      revision: created.tasks[0]!.revision,
    })).toThrow(new WorkStoreError("ROUTE_MISMATCH"));

    const signalKey = randomUUID();
    const signal = value.store.apply({
      kind: "signal.send",
      idempotencyKey: signalKey,
      workId: created.work.id,
      senderSessionId: value.actorSessionId,
      senderCapability: capability,
      targetSessionId: value.reviewerSessionId,
      mode: "queue",
      body: "Claude remains reachable through the provider-neutral signal lane.",
    });
    if (signal.kind !== "signal.send") throw new Error("unexpected result");
    expect(signal.signal.accountGeneration).toBe(1);
    expect(value.store.authorizePreparedEffect(signalKey)).toMatchObject({ executable: true });
    const delivered = value.store.finalizeSignal(signalKey, {
      kind: "failed",
      code: "queue_closed",
    });
    const acknowledged = value.store.apply({
      kind: "signal.ack",
      idempotencyKey: randomUUID(),
      workId: created.work.id,
      signalId: signal.signal.id,
      expectedSignalRevision: delivered.revision,
      actorSessionId: value.reviewerSessionId,
      actorCapability: capability,
    });
    if (acknowledged.kind !== "signal.ack") throw new Error("unexpected result");
    expect(acknowledged.signal.acknowledgedAt).not.toBeNull();

    const detachedKey = randomUUID();
    const beforeDetach = value.store.apply({
      kind: "signal.send",
      idempotencyKey: detachedKey,
      workId: created.work.id,
      senderSessionId: value.actorSessionId,
      senderCapability: capability,
      targetSessionId: value.reviewerSessionId,
      mode: "queue",
      body: "This delivery is fenced if the adopted target detaches.",
    });
    if (beforeDetach.kind !== "signal.send") throw new Error("unexpected result");
    value.database.query(
      "UPDATE session_personal_runtime_bindings SET state='detaching' WHERE session_id=?",
    ).run(value.reviewerSessionId);
    expect(value.store.authorizePreparedEffect(detachedKey)).toMatchObject({
      disposition: "settled",
      executable: false,
      status: { state: "failed" },
    });
    expect(() => value.store.apply({
      kind: "signal.send",
      idempotencyKey: randomUUID(),
      workId: created.work.id,
      senderSessionId: value.actorSessionId,
      senderCapability: capability,
      targetSessionId: value.reviewerSessionId,
      mode: "queue",
      body: "A detached target is no longer a valid delivery authority.",
    })).toThrow(new WorkStoreError("ROUTE_MISMATCH"));
    value.database.query(
      "UPDATE session_personal_runtime_bindings SET state='active' WHERE session_id=?",
    ).run(value.reviewerSessionId);

    value.database.query(
      `INSERT INTO provider_runtime_account_revocations(
         profile_id,profile_generation,provider,runtime_scope,current_account_key,state
       ) VALUES (?,1,'claude','personal',?,'releasing')`,
    ).run(value.accountId, accountKey);
    expect(() => createWork(value)).toThrow(new WorkStoreError("MEMBER_NOT_FOUND"));
    value.database.query(
      `UPDATE provider_runtime_account_revocations
       SET state='completed',current_account_key=?
       WHERE profile_id=? AND provider='claude' AND runtime_scope='personal'`,
    ).run(claudeAccountKey("replacement-work-signals"), value.accountId);
    expect(() => join(
      value,
      created.work.id,
      created.work.revision,
      value.reviewerSessionId,
    )).toThrow(new WorkStoreError("ATTEMPT_NOT_OWNER"));
    value.database.query(
      `UPDATE provider_runtime_account_revocations
       SET current_account_key=?
       WHERE profile_id=? AND provider='claude' AND runtime_scope='personal'`,
    ).run(accountKey, value.accountId);
    expect(() => createWork(value)).not.toThrow();
  });

  test("rejects keyless signed-out retired Devin control-plane authority", () => {
    const value = fixture();
    const coordinator = addSignedOutManagedDevinSession(value, "coordinator");
    const member = addSignedOutManagedDevinSession(value, "member");
    const createKey = randomUUID();
    expect(() => value.store.apply({
      kind: "work.create", idempotencyKey: createKey, clientRef: "retired-control",
      coordinatorSessionId: coordinator.sessionId, objective: "Must remain retired.",
      routes: [{ accountId: coordinator.profileId, projectId: value.projectId, preset: "ultra", fast: false }],
      tasks: [taskSpec({ accountId: coordinator.profileId, projectId: value.projectId }, "retired-control", { preset: "ultra" })],
    })).toThrow(new WorkStoreError("MEMBER_NOT_FOUND"));
    const created = createWork(value);
    expect(() => join(value, created.work.id, created.work.revision, member.sessionId))
      .toThrow(new WorkStoreError("MEMBER_NOT_FOUND"));
    expect(value.database.query("SELECT COUNT(*) AS count FROM work_attempts").get()).toEqual({ count: 0 });
    expect(value.database.query("SELECT COUNT(*) AS count FROM work_signals").get()).toEqual({ count: 0 });
  });

  test("refuses contradictory live Devin identity without retiring the claimed attempt", () => {
    const value = fixture();
    const created = createWork(value);
    const claimed = claim(value, {
      workId: created.work.id,
      taskId: created.tasks[0]!.id,
      revision: created.tasks[0]!.revision,
    });
    withFixtureGuardsRemoved(value, [
      "work_session_attempt_authority_guard", "work_session_devin_contract_guard",
      "canonical_profile_session_live_attempt_guard",
    ], () => {
      setSessionProfile(value, value.actorSessionId, { provider: "devin", preset: "ultra", contract: 2 });
    });
    const before = value.database.serialize();

    expect(() => value.store.apply({
      kind: "attempt.dispatch",
      idempotencyKey: randomUUID(),
      workId: created.work.id,
      attemptId: claimed.attempt.id,
      expectedAttemptRevision: claimed.attempt.revision,
      fence: claimed.attempt.fence,
      actorSessionId: value.actorSessionId,
      attemptCapability: capability,
      targetSessionId: value.actorSessionId,
      mode: "send",
    })).toThrow("WORK_CANONICAL_PROFILE_CORRUPT");
    expect(value.database.serialize()).toEqual(before);
    expect(value.database.query(
      "SELECT state,target_session_id FROM work_attempts WHERE id=?",
    ).get(claimed.attempt.id)).toEqual({ state: "claimed", target_session_id: null });
  });

  test("allows adopted Codex claims and rejects detached or revoked personal authority", () => {
    const valid = fixture();
    const validAccountKey = codexAccountKey("worker@example.com");
    bindPersonalProviderAuthority(
      valid,
      valid.actorSessionId,
      "codex",
      "personal-codex-valid-worker",
      validAccountKey,
    );
    const validWork = createWork(valid);
    expect(claim(valid, {
      workId: validWork.work.id,
      taskId: validWork.tasks[0]!.id,
      revision: validWork.tasks[0]!.revision,
    }).attempt.fence).toBe(1);

    const detached = fixture();
    bindPersonalProviderAuthority(
      detached,
      detached.actorSessionId,
      "codex",
      "personal-codex-detached-worker",
      validAccountKey,
    );
    const detachedWork = createWork(detached);
    detached.database.query(
      "UPDATE session_personal_runtime_bindings SET state='detached' WHERE session_id=?",
    ).run(detached.actorSessionId);
    expect(() => claim(detached, {
      workId: detachedWork.work.id,
      taskId: detachedWork.tasks[0]!.id,
      revision: detachedWork.tasks[0]!.revision,
    })).toThrow(new WorkStoreError("ROUTE_MISMATCH"));

    const revoked = fixture();
    bindPersonalProviderAuthority(
      revoked,
      revoked.actorSessionId,
      "codex",
      "personal-codex-revoked-worker",
      validAccountKey,
    );
    const revokedWork = createWork(revoked);
    revoked.database.query(
      `INSERT INTO provider_runtime_account_revocations(
         profile_id,profile_generation,provider,runtime_scope,current_account_key,state
       ) VALUES (?,1,'codex','personal',?,'releasing')`,
    ).run(revoked.accountId, validAccountKey);
    expect(() => claim(revoked, {
      workId: revokedWork.work.id,
      taskId: revokedWork.tasks[0]!.id,
      revision: revokedWork.tasks[0]!.revision,
    })).toThrow(new WorkStoreError("ROUTE_MISMATCH"));

    revoked.database.query(
      `UPDATE provider_runtime_account_revocations
       SET state='completed',current_account_key=?
       WHERE profile_id=? AND provider='codex' AND runtime_scope='personal'`,
    ).run(codexAccountKey("replacement@example.com"), revoked.accountId);
    expect(() => claim(revoked, {
      workId: revokedWork.work.id,
      taskId: revokedWork.tasks[0]!.id,
      revision: revokedWork.tasks[0]!.revision,
    })).toThrow(new WorkStoreError("ROUTE_MISMATCH"));
  });

  test("rejects retired Devin membership and signals despite its signed-in Codex shadow", () => {
    const value = fixture();
    const created = createWork(value);
    join(value, created.work.id, created.work.revision, value.actorSessionId);
    join(value, created.work.id, created.work.revision, value.reviewerSessionId);
    const signalKey = randomUUID();
    const command = {
      kind: "signal.send" as const,
      idempotencyKey: signalKey,
      workId: created.work.id,
      senderSessionId: value.actorSessionId,
      senderCapability: capability,
      targetSessionId: value.reviewerSessionId,
      mode: "queue" as const,
      body: "Prepared before this provider was retired.",
    };
    value.store.apply(command);
    setSessionProfile(value, value.reviewerSessionId, { provider: "devin", preset: "ultra", contract: 2 });
    expect(value.store.authorizePreparedEffect(signalKey)).toMatchObject({ executable: false });
    expect(() => value.store.apply({ ...command, idempotencyKey: randomUUID() }))
      .toThrow(new WorkStoreError("ROUTE_MISMATCH"));
    expect(() => join(value, created.work.id, created.work.revision, value.reviewerSessionId))
      .toThrow(new WorkStoreError("MEMBER_NOT_FOUND"));
    expect(value.database.query("SELECT COUNT(*) AS count FROM work_signals").get())
      .toEqual({ count: 1 });
    // The frozen Devin contract is 2; only a contract-1 Work contradicts it.
    // Keep that independent storage guard covered with a reduced historical Work.
    const historical = fixture();
    const historicalWork = createWork(historical);
    rewriteWorkPresetContract(historical, historicalWork.work.id, 1);
    expect(() => setSessionProfile(historical, historical.actorSessionId, { provider: "devin", preset: "ultra", contract: 2 }))
      .toThrow("WORK_DEVIN_PRESET_CONTRACT_MISMATCH");
    expect(historical.database.query(
      "SELECT provider_v39,preset_contract FROM sessions WHERE id=?",
    ).get(historical.actorSessionId)).toEqual({ provider_v39: "codex", preset_contract: 2 });
  });

  test("fences provider identity and rechecks it before Codex task dispatch", () => {
    const value = fixture();
    const created = createWork(value);
    const claimed = claim(value, {
      workId: created.work.id,
      taskId: created.tasks[0]!.id,
      revision: created.tasks[0]!.revision,
    });

    expect(() => setSessionProfile(value, value.actorSessionId, { provider: "claude", preset: "ultra" }))
      .toThrow("WORK_SESSION_ATTEMPT_AUTHORITY");

    const dispatchKey = randomUUID();
    value.store.apply({
      kind: "attempt.dispatch",
      idempotencyKey: dispatchKey,
      workId: created.work.id,
      attemptId: claimed.attempt.id,
      expectedAttemptRevision: claimed.attempt.revision,
      fence: claimed.attempt.fence,
      actorSessionId: value.actorSessionId,
      attemptCapability: capability,
      targetSessionId: value.actorSessionId,
      mode: "send",
    });
    withFixtureGuardsRemoved(value, [
      "work_session_attempt_authority_guard", "canonical_profile_session_live_attempt_guard",
    ], () => {
      setSessionProfile(value, value.actorSessionId, { provider: "claude", preset: "ultra" });
    });
    const before = value.database.serialize();
    expect(() => value.store.authorizePreparedEffect(dispatchKey))
      .toThrow("WORK_CANONICAL_PROFILE_CORRUPT");
    expect(value.database.serialize()).toEqual(before);
  });

  test("retains a late accepted receipt without reviving swept provider authority", () => {
    const value = fixture();
    const created = createWork(value);
    const claimed = claim(value, {
      workId: created.work.id,
      taskId: created.tasks[0]!.id,
      revision: created.tasks[0]!.revision,
    });
    const dispatchKey = randomUUID();
    value.store.apply({
      kind: "attempt.dispatch",
      idempotencyKey: dispatchKey,
      workId: created.work.id,
      attemptId: claimed.attempt.id,
      expectedAttemptRevision: claimed.attempt.revision,
      fence: claimed.attempt.fence,
      actorSessionId: value.actorSessionId,
      attemptCapability: capability,
      targetSessionId: value.actorSessionId,
      mode: "send",
    });
    expect(value.store.authorizePreparedEffect(dispatchKey).executable).toBe(true);

    value.database.query("UPDATE sessions SET state='terminal' WHERE id=?")
      .run(value.actorSessionId);
    expect(value.store.snapshot(created.work.id).tasks[0]).toMatchObject({
      status: "blocked",
    });
    expect(value.database.query(
      "SELECT state FROM work_attempts WHERE id=?",
    ).get(claimed.attempt.id)).toEqual({ state: "recovery_required" });
    expect(value.store.events(created.work.id, 0, 50).events.at(-1)?.body).toEqual({
      type: "attempt.recovery_required",
      attemptId: claimed.attempt.id,
      fence: claimed.attempt.fence,
      reason: "custodian_restart",
    });

    const receipt = turnStartedReceipt();
    const recovered = value.store.finalizeDispatch(dispatchKey, {
      kind: "accepted",
      receipt,
    });
    expect(recovered).toMatchObject({
      status: "unknown",
      dispatchReceipt: receipt,
    });
    const afterFinalization = value.store.events(created.work.id, 0, 50);
    expect(afterFinalization.events.at(-1)?.body).toEqual({
      type: "attempt.dispatch_finalized",
      attemptId: claimed.attempt.id,
      outcome: "accepted",
    });

    const restarted = new WorkStore(value.database, {
      daemonGeneration: 8,
      now: () => value.now.value,
      encodeCursor,
      issueCapability,
      verifyCapability,
      projectProviderIdentifier,
    });
    expect(restarted.authorizePreparedEffect(dispatchKey)).toMatchObject({
      executable: false,
      disposition: "settled",
      status: { state: "accepted" },
    });
    expect(restarted.finalizeDispatch(dispatchKey, {
      kind: "accepted",
      receipt,
    })).toEqual(recovered);
    expect(restarted.snapshot(created.work.id).tasks[0]).toMatchObject({
      status: "blocked",
    });
    expect(restarted.events(created.work.id, 0, 50)).toEqual(afterFinalization);
    expect(value.database.query(
      "SELECT state,revision FROM work_attempts WHERE id=?",
    ).get(claimed.attempt.id)).toEqual({
      state: "recovery_required",
      revision: recovered.revision,
    });
  });

  test("lets a Work claim win before a provider-switch effect starts", () => {
    const value = fixture();
    const created = createWork(value);
    const switchAttemptId = createAttemptId();
    value.database.query(
      `INSERT INTO mutation_attempts(
         id,idempotency_key,kind,authority_id,authority_generation,request_digest,state
       ) VALUES (?,?,?,?,?,?,'prepared')`,
    ).run(
      switchAttemptId,
      randomUUID(),
      "session.switch",
      value.actorSessionId,
      1,
      "a".repeat(64),
    );

    claim(value, {
      workId: created.work.id,
      taskId: created.tasks[0]!.id,
      revision: created.tasks[0]!.revision,
    });
    expect(() => value.store.assertSessionCanChangeRoute(value.actorSessionId))
      .toThrow(new WorkStoreError("ATTEMPT_RECOVERY_REQUIRED"));
    expect(() => value.database.query(
      "UPDATE mutation_attempts SET state='effect_started' WHERE id=? AND state='prepared'",
    ).run(switchAttemptId)).toThrow("WORK_SESSION_SWITCH_ATTEMPT_AUTHORITY");
    expect(value.database.query(
      "SELECT state FROM mutation_attempts WHERE id=?",
    ).get(switchAttemptId)).toEqual({ state: "prepared" });
  });

  test("fences Work claims behind an unresolved provider-switch effect", () => {
    const value = fixture();
    const created = createWork(value);
    const switchAttemptId = createAttemptId();
    value.database.query(
      `INSERT INTO mutation_attempts(
         id,idempotency_key,kind,authority_id,authority_generation,request_digest,state
       ) VALUES (?,?,?,?,?,?,'effect_started')`,
    ).run(
      switchAttemptId,
      randomUUID(),
      "session.switch",
      value.actorSessionId,
      1,
      "b".repeat(64),
    );

    const claimTask = (): unknown => claim(value, {
      workId: created.work.id,
      taskId: created.tasks[0]!.id,
      revision: created.tasks[0]!.revision,
    });
    const next = value.store.apply({
      kind: "task.claimNext",
      idempotencyKey: randomUUID(),
      workId: created.work.id,
      actorSessionId: value.actorSessionId,
      actorCapability: capability,
      route: { accountId: value.accountId, projectId: value.projectId },
      leaseMs: 5_000,
    });
    expect(next).toMatchObject({ kind: "task.claimNext", task: null, attempt: null });
    expect(claimTask).toThrow(new WorkStoreError("ROUTE_MISMATCH"));
    value.database.query(
      "UPDATE mutation_attempts SET state='ambiguous' WHERE id=?",
    ).run(switchAttemptId);
    expect(claimTask).toThrow(new WorkStoreError("ROUTE_MISMATCH"));
    expect(value.database.query(
      "SELECT COUNT(*) AS count FROM work_attempts WHERE work_id=?",
    ).get(created.work.id)).toEqual({ count: 0 });

    value.database.query(
      `INSERT INTO mutation_resolutions(attempt_id,resolution_kind,receipt_json)
       VALUES (?,'abandoned',NULL)`,
    ).run(switchAttemptId);
    expect(claimTask()).toMatchObject({ kind: "task.claim" });
  });

  test("refuses Codex work admission while the Oompa profile is signed out", () => {
    const value = fixture();
    value.database.query("UPDATE profiles SET state='signed_out',process_generation=0 WHERE id=?")
      .run(value.accountId);
    expect(() => createWork(value)).toThrow(new WorkStoreError("MEMBER_NOT_FOUND"));
  });

  test("CAS claims a ready task once and increments its committed fence", () => {
    const value = fixture();
    const created = createWork(value);
    join(value, created.work.id, created.work.revision, value.actorSessionId);
    const first = claim(value, {
      workId: created.work.id,
      taskId: created.tasks[0]!.id,
      revision: created.tasks[0]!.revision,
    });
    expect(first.attempt.fence).toBe(1);
    const staleRevision = created.tasks[0]!.revision;
    expect(() => value.store.apply({
      kind: "task.claim",
      idempotencyKey: randomUUID(),
      workId: created.work.id,
      taskId: created.tasks[0]!.id,
      expectedTaskRevision: staleRevision,
      actorSessionId: value.actorSessionId,
      actorCapability: capability,
      leaseMs: 5_000,
    })).toThrow(new WorkStoreError("REVISION_CONFLICT"));
    expect(value.database.query(
      "SELECT COUNT(*) AS count FROM work_attempts WHERE task_id=?",
    ).get(created.tasks[0]!.id)).toEqual({ count: 1 });
  });

  test("durably expires a pre-dispatch claim before rejecting the stale caller", () => {
    const value = fixture();
    const created = createWork(value);
    join(value, created.work.id, created.work.revision, value.actorSessionId);
    const first = claim(value, {
      workId: created.work.id,
      taskId: created.tasks[0]!.id,
      revision: created.tasks[0]!.revision,
    });
    const revisionBeforeExpiry = value.store.snapshot(created.work.id).tasks[0]!.revision;
    value.now.value = first.attempt.leaseExpiresAt! + 10;
    expect(() => value.store.apply({
      kind: "task.claim",
      idempotencyKey: randomUUID(),
      workId: created.work.id,
      taskId: created.tasks[0]!.id,
      expectedTaskRevision: revisionBeforeExpiry,
      actorSessionId: value.actorSessionId,
      actorCapability: capability,
      leaseMs: 5_000,
    })).toThrow(new WorkStoreError("REVISION_CONFLICT"));
    const afterExpiry = value.store.snapshot(created.work.id);
    expect(afterExpiry.tasks[0]?.status).toBe("ready");
    const second = claim(value, {
      workId: created.work.id,
      taskId: created.tasks[0]!.id,
      revision: afterExpiry.tasks[0]!.revision,
    });
    expect(second.attempt.fence).toBe(2);
  });

  test("serializes competing claim-next callers and journals an empty result", () => {
    const value = fixture();
    const created = createWork(value);
    const actorJoined = join(
      value,
      created.work.id,
      created.work.revision,
      value.actorSessionId,
    );
    join(
      value,
      created.work.id,
      actorJoined.workRevision,
      value.reviewerSessionId,
    );
    const first = value.store.apply({
      kind: "task.claimNext",
      idempotencyKey: randomUUID(),
      workId: created.work.id,
      actorSessionId: value.actorSessionId,
      actorCapability: capability,
      route: { accountId: value.accountId, projectId: value.projectId },
      leaseMs: 5_000,
    });
    if (first.kind !== "task.claimNext" || first.task === null) {
      throw new Error("claim-next failed");
    }
    const competing = value.store.apply({
      kind: "task.claimNext",
      idempotencyKey: randomUUID(),
      workId: created.work.id,
      actorSessionId: value.reviewerSessionId,
      actorCapability: capability,
      route: { accountId: value.accountId, projectId: value.projectId },
      leaseMs: 5_000,
    });
    if (competing.kind !== "task.claimNext") throw new Error("unexpected result");
    expect(competing.task).toBeNull();
    expect(competing.attempt).toBeNull();
    expect(value.database.query(
      "SELECT COUNT(*) AS count FROM work_attempts WHERE task_id=?",
    ).get(first.task.id)).toEqual({ count: 1 });

    const emptyKey = randomUUID();
    const emptyOperation = {
      kind: "task.claimNext",
      idempotencyKey: emptyKey,
      workId: created.work.id,
      actorSessionId: value.reviewerSessionId,
      actorCapability: capability,
      route: { accountId: value.accountId, projectId: value.projectId },
      leaseMs: 5_000,
    } satisfies WorkOperation;
    const beforeMisses = value.database.query(
      "SELECT revision,next_sequence,head_hash FROM works WHERE id=?",
    ).get(created.work.id);
    const intentCountBefore = (value.database.query(
      "SELECT COUNT(*) AS count FROM work_idempotency_intents WHERE work_id=?",
    ).get(created.work.id) as { count: number }).count;
    const empty = value.store.apply(emptyOperation);
    if (empty.kind !== "task.claimNext") throw new Error("unexpected result");
    expect(empty.workId).toBe(created.work.id);
    expect(empty.workRevision).toBe(value.store.snapshot(created.work.id).work.revision);
    expect(empty.task).toBeNull();
    expect(empty.attempt).toBeNull();
    expect(value.store.apply(emptyOperation)).toEqual(empty);
    for (let index = 0; index < 128; index += 1) {
      const miss = value.store.apply({ ...emptyOperation, idempotencyKey: randomUUID() });
      expect(miss.kind).toBe("task.claimNext");
      if (miss.kind === "task.claimNext") expect(miss.task).toBeNull();
    }
    expect(value.database.query(
      "SELECT revision,next_sequence,head_hash FROM works WHERE id=?",
    ).get(created.work.id)).toEqual(beforeMisses);
    expect((value.database.query(
      "SELECT COUNT(*) AS count FROM work_idempotency_intents WHERE work_id=?",
    ).get(created.work.id) as { count: number }).count).toBe(intentCountBefore + 129);
  });

  test("keeps empty claim-next stream-neutral while reserving successful claims", () => {
    const value = fixture();
    const created = createWork(value, [taskSpec(value, "capacity-claim", {
      notBefore: value.now.value + 1_000,
    })]);
    fillWorkEventCapacity(
      value,
      created.work.id,
      WORK_HISTORY_EVENT_LIMIT - WORK_HISTORY_RECOVERY_RESERVE,
    );
    const missOperation = {
      kind: "task.claimNext",
      idempotencyKey: randomUUID(),
      workId: created.work.id,
      actorSessionId: value.actorSessionId,
      actorCapability: capability,
      route: { accountId: value.accountId, projectId: value.projectId },
      leaseMs: 5_000,
    } satisfies WorkOperation;
    const beforeMiss = value.database.query(
      "SELECT revision,next_sequence,head_hash FROM works WHERE id=?",
    ).get(created.work.id);
    const miss = value.store.apply(missOperation);
    if (miss.kind !== "task.claimNext") throw new Error("unexpected result");
    expect(miss.task).toBeNull();
    expect(value.store.apply(missOperation)).toEqual(miss);
    expect(value.database.query(
      "SELECT revision,next_sequence,head_hash FROM works WHERE id=?",
    ).get(created.work.id)).toEqual(beforeMiss);

    value.now.value += 1_000;
    const claimKey = randomUUID();
    expect(() => value.store.apply({
      ...missOperation,
      idempotencyKey: claimKey,
    })).toThrow(new WorkStoreError("WORK_CAPACITY_EXCEEDED"));
    expect(value.database.query(
      "SELECT state,attempt_count FROM work_task_states WHERE task_id=?",
    ).get(created.tasks[0]!.id)).toEqual({ state: "pending", attempt_count: 0 });
    expect(value.database.query(
      "SELECT COUNT(*) AS count FROM work_attempts WHERE work_id=?",
    ).get(created.work.id)).toEqual({ count: 0 });
    expect(value.database.query(
      "SELECT 1 AS present FROM work_idempotency_intents WHERE idempotency_key=?",
    ).get(claimKey)).toBeNull();
    expect(value.database.query(
      "SELECT revision,next_sequence,head_hash FROM works WHERE id=?",
    ).get(created.work.id)).toEqual(beforeMiss);

    const failed = value.store.apply({
      kind: "work.fail",
      idempotencyKey: randomUUID(),
      workId: created.work.id,
      expectedWorkRevision: (beforeMiss as { revision: number }).revision,
      actorSessionId: value.actorSessionId,
      coordinatorCapability: capability,
      summary: "The recovery reserve remains available for terminalization.",
      evidence: [],
    });
    if (failed.kind !== "work.fail") throw new Error("unexpected result");
    expect(failed.work.status).toBe("failed");
    expect(failed.workRevision).toBe((beforeMiss as { revision: number }).revision + 1);
  });

  test("fails closed at the per-work intent ceiling without consuming terminal reserve", () => {
    const value = fixture();
    const created = createWork(value, [taskSpec(value, "intent-capacity", {
      notBefore: value.now.value + 1_000,
    })]);
    const generalLimit = WORK_HISTORY_EVENT_LIMIT - WORK_HISTORY_RECOVERY_RESERVE;
    const present = (value.database.query(
      "SELECT COUNT(*) AS count FROM work_idempotency_intents WHERE work_id=?",
    ).get(created.work.id) as { count: number }).count;
    const needed = generalLimit - present;
    value.database.query(
      `WITH RECURSIVE n(value) AS (
         VALUES(0) UNION ALL SELECT value+1 FROM n WHERE value<255
       ), numbered(sequence) AS (
         SELECT a.value*256+b.value+1 FROM n AS a,n AS b
         WHERE a.value*256+b.value+1<=?
       )
       INSERT INTO work_idempotency_intents(
         idempotency_key,operation_kind,work_id,request_digest,result_json,created_at
       )
       SELECT printf('01890f32-a123-7000-8000-%012x',sequence),
              'test.capacity',?,?,'{}',sequence
       FROM numbered`,
    ).run(needed, created.work.id, "a".repeat(64));
    expect(value.database.query(
      "SELECT COUNT(*) AS count FROM work_idempotency_intents WHERE work_id=?",
    ).get(created.work.id)).toEqual({ count: generalLimit });
    const key = randomUUID();
    const before = value.database.query(
      `SELECT revision,next_sequence,head_hash,
        (SELECT COUNT(*) FROM work_attempts WHERE work_id=works.id) AS attempts,
        (SELECT COUNT(*) FROM work_prepared_effects WHERE work_id=works.id) AS effects
       FROM works WHERE id=?`,
    ).get(created.work.id);
    expect(() => value.store.apply({
      kind: "task.claimNext",
      idempotencyKey: key,
      workId: created.work.id,
      actorSessionId: value.actorSessionId,
      actorCapability: capability,
      route: { accountId: value.accountId, projectId: value.projectId },
      leaseMs: 5_000,
    })).toThrow(new WorkStoreError("WORK_CAPACITY_EXCEEDED"));
    expect(value.database.query(
      "SELECT 1 AS present FROM work_idempotency_intents WHERE idempotency_key=?",
    ).get(key)).toBeNull();
    expect(value.database.query(
      `SELECT revision,next_sequence,head_hash,
        (SELECT COUNT(*) FROM work_attempts WHERE work_id=works.id) AS attempts,
        (SELECT COUNT(*) FROM work_prepared_effects WHERE work_id=works.id) AS effects
       FROM works WHERE id=?`,
    ).get(created.work.id)).toEqual(before);

    const terminal = value.store.apply({
      kind: "work.cancel",
      idempotencyKey: randomUUID(),
      workId: created.work.id,
      expectedWorkRevision: created.workRevision,
      actorSessionId: value.actorSessionId,
      coordinatorCapability: capability,
      summary: "The recovery reserve remains usable.",
      evidence: [],
    });
    expect(terminal.kind).toBe("work.cancel");
  });

  test("rejects a two-event release atomically with one general slot left", () => {
    const value = fixture();
    const created = createWork(value, [taskSpec(value, "release-capacity", {
      maxAttempts: 1,
    })]);
    const claimed = claim(value, {
      workId: created.work.id,
      taskId: created.tasks[0]!.id,
      revision: created.tasks[0]!.revision,
    });
    fillWorkEventCapacity(
      value,
      created.work.id,
      WORK_HISTORY_EVENT_LIMIT - WORK_HISTORY_RECOVERY_RESERVE - 1,
    );
    const releaseKey = randomUUID();
    const before = value.database.query(
      "SELECT revision,next_sequence,head_hash FROM works WHERE id=?",
    ).get(created.work.id);
    expect(() => value.store.apply({
      kind: "attempt.release",
      idempotencyKey: releaseKey,
      workId: created.work.id,
      attemptId: claimed.attempt.id,
      expectedAttemptRevision: claimed.attempt.revision,
      fence: claimed.attempt.fence,
      actorSessionId: value.actorSessionId,
      attemptCapability: capability,
      reason: "This would emit released and attempts_exhausted.",
    })).toThrow(new WorkStoreError("WORK_CAPACITY_EXCEEDED"));
    expect(value.database.query(
      "SELECT state,revision FROM work_attempts WHERE id=?",
    ).get(claimed.attempt.id)).toEqual({
      state: "claimed",
      revision: claimed.attempt.revision,
    });
    expect(value.database.query(
      "SELECT state,attempt_count FROM work_task_states WHERE task_id=?",
    ).get(claimed.task.id)).toEqual({ state: "claimed", attempt_count: 1 });
    expect(value.database.query(
      "SELECT 1 AS present FROM work_idempotency_intents WHERE idempotency_key=?",
    ).get(releaseKey)).toBeNull();
    expect(value.database.query(
      "SELECT revision,next_sequence,head_hash FROM works WHERE id=?",
    ).get(created.work.id)).toEqual(before);
  });

  test("rejects a two-event report atomically with one general slot left", () => {
    const value = fixture();
    const created = createWork(value, [taskSpec(value, "report-capacity", {
      maxAttempts: 1,
    })]);
    const claimed = claim(value, {
      workId: created.work.id,
      taskId: created.tasks[0]!.id,
      revision: created.tasks[0]!.revision,
    });
    const dispatchKey = randomUUID();
    value.store.apply({
      kind: "attempt.dispatch",
      idempotencyKey: dispatchKey,
      workId: created.work.id,
      attemptId: claimed.attempt.id,
      expectedAttemptRevision: claimed.attempt.revision,
      fence: claimed.attempt.fence,
      actorSessionId: value.actorSessionId,
      attemptCapability: capability,
      targetSessionId: value.actorSessionId,
      mode: "send",
    });
    expect(value.store.authorizePreparedEffect(dispatchKey).executable).toBe(true);
    const running = value.store.finalizeDispatch(dispatchKey, {
      kind: "accepted",
      receipt: turnStartedReceipt(),
    });
    fillWorkEventCapacity(
      value,
      created.work.id,
      WORK_HISTORY_EVENT_LIMIT - WORK_HISTORY_RECOVERY_RESERVE - 1,
    );
    const reportKey = randomUUID();
    const before = value.database.query(
      "SELECT revision,next_sequence,head_hash FROM works WHERE id=?",
    ).get(created.work.id);
    expect(() => value.store.apply({
      kind: "attempt.report",
      idempotencyKey: reportKey,
      workId: created.work.id,
      attemptId: running.id,
      expectedAttemptRevision: running.revision,
      fence: running.fence,
      actorSessionId: value.actorSessionId,
      attemptCapability: capability,
      report: {
        kind: "blocked",
        summary: "This would emit reported and attempts_exhausted.",
        evidence: [],
      },
    })).toThrow(new WorkStoreError("WORK_CAPACITY_EXCEEDED"));
    expect(value.database.query(
      "SELECT state,revision FROM work_attempts WHERE id=?",
    ).get(running.id)).toEqual({ state: "running", revision: running.revision });
    expect(value.database.query(
      "SELECT state FROM work_task_states WHERE task_id=?",
    ).get(claimed.task.id)).toEqual({ state: "running" });
    expect(value.database.query(
      "SELECT COUNT(*) AS count FROM work_attempt_reports WHERE attempt_id=?",
    ).get(running.id)).toEqual({ count: 0 });
    expect(value.database.query(
      "SELECT 1 AS present FROM work_idempotency_intents WHERE idempotency_key=?",
    ).get(reportKey)).toBeNull();
    expect(value.database.query(
      "SELECT revision,next_sequence,head_hash FROM works WHERE id=?",
    ).get(created.work.id)).toEqual(before);
  });

  test("rolls back an atomic claim batch and replays the committed identities in input order", () => {
    const value = fixture();
    const created = createWork(value, [taskSpec(value, "first"), taskSpec(value, "second")]);
    join(value, created.work.id, created.work.revision, value.actorSessionId);
    join(value, created.work.id, created.work.revision, value.reviewerSessionId);
    const [firstTask, secondTask] = created.tasks;
    if (firstTask === undefined || secondTask === undefined) throw new Error("tasks missing");

    expect(() => value.store.apply({
      kind: "task.claimBatch",
      idempotencyKey: randomUUID(),
      workId: created.work.id,
      claims: [
        {
          taskId: firstTask.id,
          expectedTaskRevision: firstTask.revision,
          actorSessionId: value.actorSessionId,
          actorCapability: capability,
          leaseMs: 5_000,
        },
        {
          taskId: secondTask.id,
          expectedTaskRevision: secondTask.revision + 1,
          actorSessionId: value.reviewerSessionId,
          actorCapability: capability,
          leaseMs: 5_000,
        },
      ],
    })).toThrow(new WorkStoreError("REVISION_CONFLICT"));
    expect(value.database.query(
      "SELECT COUNT(*) AS count FROM work_attempts WHERE work_id=?",
    ).get(created.work.id)).toEqual({ count: 0 });

    const operation = {
      kind: "task.claimBatch",
      idempotencyKey: randomUUID(),
      workId: created.work.id,
      claims: [
        {
          taskId: secondTask.id,
          expectedTaskRevision: secondTask.revision,
          actorSessionId: value.reviewerSessionId,
          actorCapability: capability,
          leaseMs: 5_000,
        },
        {
          taskId: firstTask.id,
          expectedTaskRevision: firstTask.revision,
          actorSessionId: value.actorSessionId,
          actorCapability: capability,
          leaseMs: 5_000,
        },
      ],
    } satisfies WorkOperation;
    const claimed = value.store.apply(operation);
    if (claimed.kind !== "task.claimBatch") throw new Error("unexpected result");
    expect(claimed.claims.map((entry) => entry.task.id)).toEqual([
      secondTask.id,
      firstTask.id,
    ]);
    expect(value.store.apply(structuredClone(operation))).toEqual(claimed);
  });

  test("does not age a minimum lease through rapid read polling", () => {
    const value = fixture();
    const created = createWork(value);
    join(value, created.work.id, created.work.revision, value.actorSessionId);
    const claimed = claim(value, {
      workId: created.work.id,
      taskId: created.tasks[0]!.id,
      revision: created.tasks[0]!.revision,
    });
    const eventCount = value.store.events(created.work.id, 0, 50).events.length;
    const clockBefore = value.database.query(
      "SELECT logical_time FROM work_clock WHERE singleton=1",
    ).get();

    for (let index = 0; index < 100; index += 1) {
      expect(value.store.poll(created.work.id, value.actorSessionId).ownedAttempts[0]?.id).toBe(
        claimed.attempt.id,
      );
    }

    const after = value.store.task(created.tasks[0]!.id);
    expect(after.activeAttempt?.status).toBe("claimed");
    expect(after.activeAttempt?.leaseExpiresAt).toBe(claimed.attempt.leaseExpiresAt);
    expect(value.store.events(created.work.id, 0, 50).events).toHaveLength(eventCount);
    expect(value.database.query(
      "SELECT logical_time FROM work_clock WHERE singleton=1",
    ).get()).toEqual(clockBefore);
  });

  test("never shortens an existing lease when a worker requests a shorter renewal", () => {
    const value = fixture();
    const created = createWork(value);
    join(value, created.work.id, created.work.revision, value.actorSessionId);
    const claimed = value.store.apply({
      kind: "task.claim",
      idempotencyKey: randomUUID(),
      workId: created.work.id,
      taskId: created.tasks[0]!.id,
      expectedTaskRevision: created.tasks[0]!.revision,
      actorSessionId: value.actorSessionId,
      actorCapability: capability,
      leaseMs: 60_000,
    });
    if (claimed.kind !== "task.claim") throw new Error("unexpected result");
    const renewed = value.store.apply({
      kind: "attempt.renew",
      idempotencyKey: randomUUID(),
      workId: created.work.id,
      attemptId: claimed.attempt.id,
      expectedAttemptRevision: claimed.attempt.revision,
      fence: claimed.attempt.fence,
      actorSessionId: value.actorSessionId,
      attemptCapability: capability,
      leaseMs: 5_000,
    });
    if (renewed.kind !== "attempt.renew") throw new Error("unexpected result");
    expect(renewed.attempt.leaseExpiresAt).toBe(claimed.attempt.leaseExpiresAt);
  });

  test("freezes readiness time across signed action continuation pages", () => {
    const value = fixture();
    const created = createWork(value, [
      taskSpec(value, "ready-one"),
      taskSpec(value, "ready-two"),
      taskSpec(value, "future", { notBefore: value.now.value + 10_000 }),
    ]);
    const first = value.store.poll(created.work.id, value.actorSessionId, 0, 1);
    expect(first.readyTasks).toHaveLength(1);
    expect(first.requestedActionCursor).toBeNull();
    if (first.nextActionCursor === null) throw new Error("action cursor missing");
    const encodedPayload = first.nextActionCursor.split(".")[1];
    if (encodedPayload === undefined) throw new Error("cursor payload missing");
    const actionCursor = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8"),
    ) as WorkActionCursorPayload;
    expect(actionCursor.projectionAt).toBe(value.now.value);

    value.now.value += 20_000;
    const second = value.store.poll(
      created.work.id,
      value.actorSessionId,
      0,
      1,
      actionCursor,
    );
    expect(second.requestedActionCursor).toBe(first.nextActionCursor);
    expect(second.readyTasks.map((task) => task.clientRef)).toEqual(["ready-two"]);
    expect(second.nextActionCursor).toBeNull();
    expect(value.store.poll(created.work.id, value.actorSessionId).readyTasks.map(
      (task) => task.clientRef,
    )).toContain("future");
  });

  test("replays dispatch preparation and never steals an uncertain provider effect", () => {
    const value = fixture();
    const created = createWork(value);
    join(value, created.work.id, created.work.revision, value.actorSessionId);
    const claimed = claim(value, {
      workId: created.work.id,
      taskId: created.tasks[0]!.id,
      revision: created.tasks[0]!.revision,
    });
    const key = randomUUID();
    const operation = {
      kind: "attempt.dispatch",
      idempotencyKey: key,
      workId: created.work.id,
      attemptId: claimed.attempt.id,
      expectedAttemptRevision: claimed.attempt.revision,
      fence: claimed.attempt.fence,
      actorSessionId: value.actorSessionId,
      attemptCapability: capability,
      targetSessionId: value.actorSessionId,
      mode: "send",
    } satisfies WorkOperation;
    const prepared = value.store.apply(operation);
    expect(prepared.kind).toBe("attempt.dispatch");
    const recoveryPage = value.store.recoverablePreparedEffects(undefined, 1);
    expect(recoveryPage.effects).toHaveLength(1);
    expect(recoveryPage.effects[0]?.idempotencyKey).toBe(key);
    expect(recoveryPage.effects[0]?.status.state).toBe("prepared");
    expect(recoveryPage.nextCursor).toBeNull();
    const restarted = new WorkStore(value.database, {
      daemonGeneration: 8,
      now: () => value.now.value,
      encodeCursor,
      issueCapability,
      verifyCapability,
      projectProviderIdentifier,
    });
    expect(restarted.apply(operation)).toEqual(prepared);
    const pendingEffects = value.store.poll(
      created.work.id,
      value.actorSessionId,
    ).preparedEffects;
    expect(pendingEffects).toHaveLength(1);
    const pendingEffect = pendingEffects[0];
    if (pendingEffect === undefined) throw new Error("prepared effect missing");
    expect(pendingEffect.idempotencyKey).toBe(key);
    expect(pendingEffect.state).toBe("prepared");
    expect(restarted.effectStatus(key)).toEqual(pendingEffect);
    expect(JSON.stringify(restarted.effectStatus(key))).not.toContain("Implement and verify");
    const authorization = restarted.authorizePreparedEffect(key);
    expect(authorization.executable).toBe(true);
    expect(authorization.status.state).toBe("effect_started");
    expect(restarted.recoverablePreparedEffects().effects[0]?.status.state).toBe(
      "effect_started",
    );
    if (!authorization.executable) throw new Error("effect authorization failed");
    expect(authorization.effect.accountGeneration).toBe(1);
    const unknown = restarted.finalizeDispatch(key, { kind: "unknown", code: "custodian_restart" });
    expect(unknown.status).toBe("unknown");
    expect(restarted.recoverablePreparedEffects().effects[0]?.status.state).toBe("unknown");
    expect(value.store.effectStatus(key)?.state).toBe("unknown");
    expect(value.store.finalizeDispatch(key, { kind: "unknown", code: "custodian_restart" })).toEqual(
      unknown,
    );
    expect(() => value.store.finalizeDispatch(key, {
      kind: "accepted",
      receipt: turnStartedReceipt(),
    })).toThrow(
      new WorkStoreError("IDEMPOTENCY_CONFLICT"),
    );
    expect(value.store.poll(created.work.id, value.actorSessionId).readyTasks).toHaveLength(0);
    expect(() => value.store.apply({
      kind: "work.complete",
      idempotencyKey: randomUUID(),
      workId: created.work.id,
      expectedWorkRevision: value.store.snapshot(created.work.id).work.revision,
      actorSessionId: value.actorSessionId,
      coordinatorCapability: capability,
      summary: "An unresolved attempt effect blocks completion.",
      evidence: [],
    })).toThrow(new WorkStoreError("ATTEMPT_RECOVERY_REQUIRED"));
  });
});

describe("WorkStore submissions, reviews, and signals", () => {
  test("allows a signed-out adopted Claude member to review a Codex submission", () => {
    const value = fixture();
    const reviewer = addSignedOutPersonalClaudeSession(value, "reviewer");
    const created = createWork(value, [taskSpec(value, "adopted-claude-review", {
      requiredReviews: 1,
    })]);
    join(
      value,
      created.work.id,
      created.work.revision,
      reviewer.sessionId,
    );
    const claimed = claim(value, {
      workId: created.work.id,
      taskId: created.tasks[0]!.id,
      revision: created.tasks[0]!.revision,
    });
    const dispatchKey = randomUUID();
    value.store.apply({
      kind: "attempt.dispatch",
      idempotencyKey: dispatchKey,
      workId: created.work.id,
      attemptId: claimed.attempt.id,
      expectedAttemptRevision: claimed.attempt.revision,
      fence: claimed.attempt.fence,
      actorSessionId: value.actorSessionId,
      attemptCapability: capability,
      targetSessionId: value.actorSessionId,
      mode: "send",
    });
    expect(value.store.authorizePreparedEffect(dispatchKey).executable).toBe(true);
    const running = value.store.finalizeDispatch(dispatchKey, {
      kind: "accepted",
      receipt: turnStartedReceipt(),
    });
    const reported = value.store.apply({
      kind: "attempt.report",
      idempotencyKey: randomUUID(),
      workId: created.work.id,
      attemptId: running.id,
      expectedAttemptRevision: running.revision,
      fence: running.fence,
      actorSessionId: value.actorSessionId,
      attemptCapability: capability,
      report: {
        kind: "submit",
        summary: "Ready for the adopted Claude reviewer.",
        result: { kind: "text", text: "complete" },
        evidence: [],
      },
    });
    if (reported.kind !== "attempt.report" || reported.submission === null) {
      throw new Error("submission missing");
    }
    const submission = reported.submission;

    value.database.query(
      "UPDATE session_personal_runtime_bindings SET state='detaching' WHERE session_id=?",
    ).run(reviewer.sessionId);
    expect(() => value.store.apply({
      kind: "submission.review",
      idempotencyKey: randomUUID(),
      workId: created.work.id,
      submissionId: submission.id,
      expectedSubmissionRevision: submission.revision,
      expectedContentDigest: submission.contentDigest,
      reviewerSessionId: reviewer.sessionId,
      reviewerCapability: capability,
      review: { decision: "accept", summary: "Authority must be current.", evidence: [] },
    })).toThrow(new WorkStoreError("ROUTE_MISMATCH"));
    value.database.query(
      "UPDATE session_personal_runtime_bindings SET state='active' WHERE session_id=?",
    ).run(reviewer.sessionId);
    const reviewed = value.store.apply({
      kind: "submission.review",
      idempotencyKey: randomUUID(),
      workId: created.work.id,
      submissionId: submission.id,
      expectedSubmissionRevision: submission.revision,
      expectedContentDigest: submission.contentDigest,
      reviewerSessionId: reviewer.sessionId,
      reviewerCapability: capability,
      review: { decision: "accept", summary: "Independent review passed.", evidence: [] },
    });
    if (reviewed.kind !== "submission.review") throw new Error("unexpected result");
    expect(reviewed.submission.status).toBe("accepted");
  });

  test("preserves revisions and requires an independent reviewer before completion", () => {
    const value = fixture();
    const created = createWork(value, [taskSpec(value, "reviewed", { requiredReviews: 1 })]);
    const actorJoined = join(
      value,
      created.work.id,
      created.work.revision,
      value.actorSessionId,
    );
    join(value, created.work.id, actorJoined.workRevision, value.reviewerSessionId);
    const claimed = claim(value, {
      workId: created.work.id,
      taskId: created.tasks[0]!.id,
      revision: value.store.snapshot(created.work.id).tasks[0]!.revision,
    });
    const dispatchKey = randomUUID();
    const dispatched = value.store.apply({
      kind: "attempt.dispatch",
      idempotencyKey: dispatchKey,
      workId: created.work.id,
      attemptId: claimed.attempt.id,
      expectedAttemptRevision: claimed.attempt.revision,
      fence: claimed.attempt.fence,
      actorSessionId: value.actorSessionId,
      attemptCapability: capability,
      targetSessionId: value.actorSessionId,
      mode: "send",
    });
    if (dispatched.kind !== "attempt.dispatch") throw new Error("unexpected result");
    const internalDispatch = value.store.preparedEffect(dispatchKey);
    if (internalDispatch?.effect.kind !== "dispatch") throw new Error("dispatch effect missing");
    expect(internalDispatch.effect.accountGeneration).toBe(1);
    expect(JSON.stringify(dispatched)).not.toContain(capability);
    expect(JSON.stringify(dispatched)).not.toContain("Implement and verify");
    expect(value.store.authorizePreparedEffect(dispatchKey).executable).toBe(true);
    const running = value.store.finalizeDispatch(dispatchKey, {
      kind: "accepted",
      receipt: turnStartedReceipt(),
    });
    expect(running.status).toBe("active");
    const report = value.store.apply({
      kind: "attempt.report",
      idempotencyKey: randomUUID(),
      workId: created.work.id,
      attemptId: claimed.attempt.id,
      expectedAttemptRevision: running.revision,
      fence: claimed.attempt.fence,
      actorSessionId: value.actorSessionId,
      attemptCapability: capability,
      report: {
        kind: "submit",
        summary: "The implementation and verification are complete.",
        result: { kind: "text", text: "completed" },
        evidence: [],
      },
    });
    if (report.kind !== "attempt.report" || report.submission === null) {
      throw new Error("submission missing");
    }
    const reportedDetail = value.store.task(created.tasks[0]!.id);
    expect(reportedDetail.latestAttempt?.id).toBe(claimed.attempt.id);
    expect(reportedDetail.latestAttemptReport).toMatchObject({
      attemptId: claimed.attempt.id,
      reportKind: "submit",
      report: {
        kind: "submit",
        summary: "The implementation and verification are complete.",
      },
    });
    const submission = report.submission;
    expect(submission.status).toBe("pending_review");
    const beforeSelfReview = value.store.snapshot(created.work.id).work.revision;
    expect(() => value.store.apply({
      kind: "submission.review",
      idempotencyKey: randomUUID(),
      workId: created.work.id,
      submissionId: submission.id,
      expectedSubmissionRevision: submission.revision,
      expectedContentDigest: submission.contentDigest,
      reviewerSessionId: value.actorSessionId,
      reviewerCapability: capability,
      review: { decision: "accept", summary: "Self acceptance.", evidence: [] },
    })).toThrow(new WorkStoreError("SELF_REVIEW"));
    expect(value.store.snapshot(created.work.id).work.revision).toBe(beforeSelfReview);

    const revised = value.store.apply({
      kind: "submission.review",
      idempotencyKey: randomUUID(),
      workId: created.work.id,
      submissionId: submission.id,
      expectedSubmissionRevision: submission.revision,
      expectedContentDigest: submission.contentDigest,
      reviewerSessionId: value.reviewerSessionId,
      reviewerCapability: capability,
      review: { decision: "revise", feedback: "Add the missing regression case.", evidence: [] },
    });
    if (revised.kind !== "submission.review") throw new Error("unexpected result");
    expect(revised.submission.status).toBe("revision_requested");
    expect(value.store.snapshot(created.work.id).tasks[0]?.status).toBe("ready");

    const secondClaim = claim(value, {
      workId: created.work.id,
      taskId: created.tasks[0]!.id,
      revision: value.store.snapshot(created.work.id).tasks[0]!.revision,
      actorSessionId: value.reviewerSessionId,
    });
    expect(secondClaim.attempt.id).not.toBe(claimed.attempt.id);
    expect(secondClaim.attempt.fence).toBe(2);
    expect(value.database.query(
      "SELECT COUNT(*) AS count FROM work_submissions WHERE task_id=?",
    ).get(created.tasks[0]!.id)).toEqual({ count: 1 });
    const taskSignalKey = randomUUID();
    const taskSignal = value.store.apply({
      kind: "signal.send",
      idempotencyKey: taskSignalKey,
      workId: created.work.id,
      senderSessionId: value.actorSessionId,
      senderCapability: capability,
      targetSessionId: value.reviewerSessionId,
      taskId: created.tasks[0]!.id,
      mode: "queue",
      body: "This signal remains readable after delivery failure.",
    });
    if (taskSignal.kind !== "signal.send") throw new Error("unexpected result");
    expect(value.store.authorizePreparedEffect(taskSignalKey).executable).toBe(true);
    const failedSignal = value.store.finalizeSignal(
      taskSignalKey,
      { kind: "failed", code: "queue_closed" },
    );
    const failedAcknowledgement = value.store.apply({
      kind: "signal.ack",
      idempotencyKey: randomUUID(),
      workId: created.work.id,
      signalId: taskSignal.signal.id,
      expectedSignalRevision: failedSignal.revision,
      actorSessionId: value.reviewerSessionId,
      actorCapability: capability,
    });
    if (failedAcknowledgement.kind !== "signal.ack") throw new Error("unexpected result");
    expect(failedAcknowledgement.signal.deliveryState).toBe("failed");
    expect(failedAcknowledgement.signal.acknowledgedAt).not.toBeNull();
    const detailWithSignal = value.store.task(created.tasks[0]!.id);
    expect(detailWithSignal.recentSignals).toHaveLength(1);
    expect(detailWithSignal.recentSignals[0]).toMatchObject({
      id: taskSignal.signal.id,
      taskId: created.tasks[0]!.id,
      deliveryState: "failed",
      body: "This signal remains readable after delivery failure.",
    });
    expect(detailWithSignal.omittedSignals).toBe(0);
  });

  test("pages complete revised task history exactly once at a fixed work cut", () => {
    const value = fixture();
    const created = createWork(value, [taskSpec(value, "history", { requiredReviews: 1 })]);
    join(value, created.work.id, created.workRevision, value.reviewerSessionId);
    const firstClaim = claim(value, {
      workId: created.work.id,
      taskId: created.tasks[0]!.id,
      revision: created.tasks[0]!.revision,
    });
    const firstDispatchKey = randomUUID();
    value.store.apply({
      kind: "attempt.dispatch",
      idempotencyKey: firstDispatchKey,
      workId: created.work.id,
      attemptId: firstClaim.attempt.id,
      expectedAttemptRevision: firstClaim.attempt.revision,
      fence: firstClaim.attempt.fence,
      actorSessionId: value.actorSessionId,
      attemptCapability: capability,
      targetSessionId: value.actorSessionId,
      mode: "send",
    });
    expect(value.store.authorizePreparedEffect(firstDispatchKey).executable).toBe(true);
    const firstRunning = value.store.finalizeDispatch(firstDispatchKey, {
      kind: "accepted",
      receipt: turnStartedReceipt(),
    });
    const firstReport = value.store.apply({
      kind: "attempt.report",
      idempotencyKey: randomUUID(),
      workId: created.work.id,
      attemptId: firstRunning.id,
      expectedAttemptRevision: firstRunning.revision,
      fence: firstRunning.fence,
      actorSessionId: value.actorSessionId,
      attemptCapability: capability,
      report: {
        kind: "submit",
        summary: "First exact submission.",
        result: { kind: "text", text: "first-result" },
        evidence: [],
      },
    });
    if (firstReport.kind !== "attempt.report" || firstReport.submission === null) {
      throw new Error("first submission missing");
    }
    value.store.apply({
      kind: "submission.review",
      idempotencyKey: randomUUID(),
      workId: created.work.id,
      submissionId: firstReport.submission.id,
      expectedSubmissionRevision: firstReport.submission.revision,
      expectedContentDigest: firstReport.submission.contentDigest,
      reviewerSessionId: value.reviewerSessionId,
      reviewerCapability: capability,
      review: {
        decision: "revise",
        feedback: "exact-revision-feedback",
        evidence: [],
      },
    });
    const ready = value.store.task(created.tasks[0]!.id).task;
    const secondClaim = claim(value, {
      workId: created.work.id,
      taskId: ready.id,
      revision: ready.revision,
      actorSessionId: value.reviewerSessionId,
    });
    const signalKey = randomUUID();
    value.store.apply({
      kind: "signal.send",
      idempotencyKey: signalKey,
      workId: created.work.id,
      senderSessionId: value.actorSessionId,
      senderCapability: capability,
      targetSessionId: value.reviewerSessionId,
      taskId: ready.id,
      mode: "queue",
      body: "Exact task-history signal body.",
    });
    expect(value.store.authorizePreparedEffect(signalKey).executable).toBe(true);
    value.store.finalizeSignal(signalKey, { kind: "failed", code: "history_delivery_failed" });
    const secondDispatchKey = randomUUID();
    value.store.apply({
      kind: "attempt.dispatch",
      idempotencyKey: secondDispatchKey,
      workId: created.work.id,
      attemptId: secondClaim.attempt.id,
      expectedAttemptRevision: secondClaim.attempt.revision,
      fence: secondClaim.attempt.fence,
      actorSessionId: value.reviewerSessionId,
      attemptCapability: capability,
      targetSessionId: value.reviewerSessionId,
      mode: "send",
    });
    expect(value.store.authorizePreparedEffect(secondDispatchKey).executable).toBe(true);
    const secondRunning = value.store.finalizeDispatch(secondDispatchKey, {
      kind: "accepted",
      receipt: turnStartedReceipt(),
    });
    const secondReport = value.store.apply({
      kind: "attempt.report",
      idempotencyKey: randomUUID(),
      workId: created.work.id,
      attemptId: secondRunning.id,
      expectedAttemptRevision: secondRunning.revision,
      fence: secondRunning.fence,
      actorSessionId: value.reviewerSessionId,
      attemptCapability: capability,
      report: {
        kind: "submit",
        summary: "Replacement exact submission.",
        result: { kind: "text", text: "replacement-result" },
        evidence: [],
      },
    });
    if (secondReport.kind !== "attempt.report" || secondReport.submission === null) {
      throw new Error("replacement submission missing");
    }

    const pages = [];
    let page = value.store.taskHistory(ready.id, 2);
    const firstContinuation = page.nextCursor;
    const observed = page.observedThroughCursor;
    for (;;) {
      pages.push(page);
      expect(workReadSuccessWireBytes("work.task", page))
        .toBeLessThanOrEqual(WORK_TASK_HISTORY_PAGE_MAX_BYTES);
      expect(page.observedThroughCursor).toBe(observed);
      if (page.nextCursor === null) break;
      const requested = page.nextCursor;
      page = value.store.taskHistory(ready.id, 2, decodeTaskHistoryCursor(requested));
      expect(page.requestedCursor).toBe(requested);
    }
    expect(pages.map((candidate) => candidate.offset)).toEqual([0, 2, 4, 6]);
    expect(pages[0]?.counts).toEqual({
      attempts: 2,
      attemptReports: 2,
      submissions: 2,
      reviews: 1,
      signals: 1,
    });
    expect(pages.at(-1)?.remainingItems).toBe(0);
    expect(pages.at(-1)?.nextCursor).toBeNull();
    const items = pages.flatMap((candidate) => candidate.items);
    const identities = items.map((item) => {
      if (item.kind === "attempt") return `${item.kind}:${item.value.id}`;
      if (item.kind === "attempt_report") return `${item.kind}:${item.value.idempotencyKey}`;
      return `${item.kind}:${item.value.id}`;
    });
    expect(new Set(identities).size).toBe(items.length);
    const submissionResults = items.flatMap((item) =>
      item.kind === "submission" ? [item.value.result] : []);
    expect(submissionResults).toContainEqual({ kind: "text", text: "first-result" });
    expect(submissionResults).toContainEqual({ kind: "text", text: "replacement-result" });
    expect(items.find((item) => item.kind === "review")).toMatchObject({
      kind: "review",
      taskId: ready.id,
      value: { summary: "exact-revision-feedback" },
    });
    expect(JSON.stringify(pages)).not.toContain(capability);
    expect(() => value.store.taskHistory(ready.id, 0)).toThrow(
      new WorkStoreError("BAD_CURSOR"),
    );
    expect(() => value.store.taskHistory(ready.id, 51)).toThrow(
      new WorkStoreError("BAD_CURSOR"),
    );
    if (firstContinuation === null) throw new Error("history continuation missing");
    const continued = decodeTaskHistoryCursor(firstContinuation);
    const unrelated = createWork(value);
    expect(() => value.store.taskHistory(ready.id, 2, {
      ...continued,
      workId: unrelated.work.id,
    })).toThrow(new WorkStoreError("BAD_CURSOR"));
    expect(() => value.store.taskHistory(unrelated.tasks[0]!.id, 2, continued)).toThrow(
      new WorkStoreError("BAD_CURSOR"),
    );
    expect(() => value.store.taskHistory(ready.id, 2, {
      ...continued,
      offset: continued.offset + 100,
    })).toThrow(new WorkStoreError("BAD_CURSOR"));
    expect(() => value.store.taskHistory(ready.id, 2, {
      ...continued,
      highWaterOrdinal: continued.highWaterOrdinal + 100,
    })).toThrow(new WorkStoreError("BAD_CURSOR"));
    expect(() => value.store.taskHistory(ready.id, 2, {
      ...continued,
      taskRevision: continued.taskRevision + 100,
    })).toThrow(new WorkStoreError("BAD_CURSOR"));

    value.store.apply({
      kind: "signal.send",
      idempotencyKey: randomUUID(),
      workId: created.work.id,
      senderSessionId: value.actorSessionId,
      senderCapability: capability,
      targetSessionId: value.reviewerSessionId,
      mode: "queue",
      body: "Later work-level coordination must not invalidate the task cut.",
    });
    value.store.apply({
      kind: "submission.review",
      idempotencyKey: randomUUID(),
      workId: created.work.id,
      submissionId: secondReport.submission.id,
      expectedSubmissionRevision: secondReport.submission.revision,
      expectedContentDigest: secondReport.submission.contentDigest,
      reviewerSessionId: value.actorSessionId,
      reviewerCapability: capability,
      review: { decision: "accept", summary: "Replacement accepted.", evidence: [] },
    });
    const originalFirstPage = pages[0];
    if (originalFirstPage === undefined) throw new Error("initial history page missing");
    const resumedPages = [];
    let resumed = value.store.taskHistory(ready.id, 2, continued);
    for (;;) {
      resumedPages.push(resumed);
      expect(resumed.counts).toEqual(originalFirstPage.counts);
      expect(resumed.taskRevision).toBe(originalFirstPage.taskRevision);
      expect(resumed.observedThroughCursor).toBe(observed);
      if (resumed.nextCursor === null) break;
      resumed = value.store.taskHistory(
        ready.id,
        2,
        decodeTaskHistoryCursor(resumed.nextCursor),
      );
    }
    const resumedItems = resumedPages.flatMap((candidate) => candidate.items);
    const resumedIdentities = resumedItems.map((item) => {
      if (item.kind === "attempt") return `${item.kind}:${item.value.id}`;
      if (item.kind === "attempt_report") return `${item.kind}:${item.value.idempotencyKey}`;
      return `${item.kind}:${item.value.id}`;
    });
    expect(resumedIdentities).toEqual(identities.slice(continued.offset));
    expect(JSON.stringify(resumedPages)).not.toContain("Replacement accepted.");
    const beforeComplete = value.store.snapshot(created.work.id);
    const completed = value.store.apply({
      kind: "work.complete",
      idempotencyKey: randomUUID(),
      workId: created.work.id,
      expectedWorkRevision: beforeComplete.work.revision,
      actorSessionId: value.actorSessionId,
      coordinatorCapability: capability,
      summary: "History scenario complete.",
      evidence: [],
      result: { kind: "text", text: "done" },
    });
    if (completed.kind !== "work.complete") throw new Error("unexpected result");
    value.store.apply({
      kind: "work.release",
      idempotencyKey: randomUUID(),
      workId: created.work.id,
      expectedWorkRevision: completed.workRevision,
      actorSessionId: value.actorSessionId,
      coordinatorCapability: capability,
      acknowledgeDataLoss: true,
    });
    expect(() => value.store.taskHistory(ready.id, 2, continued)).toThrow(
      new WorkStoreError("WORK_RELEASED"),
    );
  });

  test("freezes public record versions as of the signed history cut", () => {
    const value = fixture();
    const created = createWork(value);
    join(value, created.work.id, created.workRevision, value.reviewerSessionId);
    const claimed = claim(value, {
      workId: created.work.id,
      taskId: created.tasks[0]!.id,
      revision: created.tasks[0]!.revision,
    });
    for (let index = 0; index < 2; index += 1) {
      const key = randomUUID();
      value.now.value += 1;
      value.store.apply({
        kind: "signal.send",
        idempotencyKey: key,
        workId: created.work.id,
        senderSessionId: value.actorSessionId,
        senderCapability: capability,
        targetSessionId: value.actorSessionId,
        taskId: created.tasks[0]!.id,
        mode: "queue",
        body: `Pre-cut signal ${index}`,
      });
      expect(value.store.authorizePreparedEffect(key).executable).toBe(true);
      value.store.finalizeSignal(key, { kind: "failed", code: `pre_cut_${index}` });
    }
    const first = value.store.taskHistory(created.tasks[0]!.id, 1);
    expect(first.totalItems).toBe(3);
    expect(first.items[0]?.kind).toBe("signal");
    if (first.nextCursor === null) throw new Error("expected frozen continuation");
    const cutSequence = first.observedThroughCursor;
    const cutRevision = first.taskRevision;

    const dispatchKey = randomUUID();
    value.store.apply({
      kind: "attempt.dispatch",
      idempotencyKey: dispatchKey,
      workId: created.work.id,
      attemptId: claimed.attempt.id,
      expectedAttemptRevision: claimed.attempt.revision,
      fence: claimed.attempt.fence,
      actorSessionId: value.actorSessionId,
      attemptCapability: capability,
      targetSessionId: value.actorSessionId,
      mode: "send",
    });
    expect(value.store.authorizePreparedEffect(dispatchKey).executable).toBe(true);
    const running = value.store.finalizeDispatch(dispatchKey, {
      kind: "accepted",
      receipt: turnStartedReceipt(),
    });
    value.store.apply({
      kind: "attempt.report",
      idempotencyKey: randomUUID(),
      workId: created.work.id,
      attemptId: running.id,
      expectedAttemptRevision: running.revision,
      fence: running.fence,
      actorSessionId: value.actorSessionId,
      attemptCapability: capability,
      report: { kind: "checkpoint", summary: "Post-cut checkpoint", evidence: [] },
    });

    const frozen = [];
    let page = value.store.taskHistory(
      created.tasks[0]!.id,
      1,
      decodeTaskHistoryCursor(first.nextCursor),
    );
    for (;;) {
      frozen.push(...page.items);
      expect(page.totalItems).toBe(3);
      expect(page.taskRevision).toBe(cutRevision);
      expect(page.observedThroughCursor).toBe(cutSequence);
      if (page.nextCursor === null) break;
      page = value.store.taskHistory(
        created.tasks[0]!.id,
        1,
        decodeTaskHistoryCursor(page.nextCursor),
      );
    }
    expect(frozen.map((item) => item.kind)).toEqual(["signal", "attempt"]);
    const frozenAttempt = frozen.find((item) => item.kind === "attempt");
    expect(frozenAttempt).toMatchObject({
      kind: "attempt",
      value: { id: claimed.attempt.id, status: "claimed", revision: claimed.attempt.revision },
    });
    expect(JSON.stringify(frozen)).not.toContain("Post-cut checkpoint");
    expect(value.store.task(created.tasks[0]!.id).latestAttempt).toMatchObject({
      id: claimed.attempt.id,
      status: "active",
    });
  });

  test("keeps byte-identical same-time reports distinctly identifiable across replayed pages", () => {
    const value = fixture();
    const created = createWork(value);
    const claimed = claim(value, {
      workId: created.work.id,
      taskId: created.tasks[0]!.id,
      revision: created.tasks[0]!.revision,
    });
    const dispatchKey = randomUUID();
    value.store.apply({
      kind: "attempt.dispatch",
      idempotencyKey: dispatchKey,
      workId: created.work.id,
      attemptId: claimed.attempt.id,
      expectedAttemptRevision: claimed.attempt.revision,
      fence: claimed.attempt.fence,
      actorSessionId: value.actorSessionId,
      attemptCapability: capability,
      targetSessionId: value.actorSessionId,
      mode: "send",
    });
    expect(value.store.authorizePreparedEffect(dispatchKey).executable).toBe(true);
    let attempt = value.store.finalizeDispatch(dispatchKey, {
      kind: "accepted",
      receipt: turnStartedReceipt(),
    });
    const reportKeys = [randomUUID(), randomUUID()] as const;
    for (const idempotencyKey of reportKeys) {
      const reported = value.store.apply({
        kind: "attempt.report",
        idempotencyKey,
        workId: created.work.id,
        attemptId: attempt.id,
        expectedAttemptRevision: attempt.revision,
        fence: attempt.fence,
        actorSessionId: value.actorSessionId,
        attemptCapability: capability,
        report: {
          kind: "checkpoint",
          summary: "Byte-identical checkpoint",
          evidence: [],
        },
      });
      if (reported.kind !== "attempt.report") throw new Error("checkpoint report missing");
      attempt = reported.attempt;
    }

    const first = value.store.taskHistory(created.tasks[0]!.id, 1);
    expect(value.store.taskHistory(created.tasks[0]!.id, 1)).toEqual(first);
    if (first.nextCursor === null) throw new Error("first report continuation missing");
    const secondCursor = decodeTaskHistoryCursor(first.nextCursor);
    const second = value.store.taskHistory(created.tasks[0]!.id, 1, secondCursor);
    expect(value.store.taskHistory(created.tasks[0]!.id, 1, secondCursor)).toEqual(second);
    const reports = [...first.items, ...second.items].filter(
      (item) => item.kind === "attempt_report",
    );
    expect(reports).toHaveLength(2);
    expect(reports.map((item) => item.value.idempotencyKey)).toEqual([
      reportKeys[1],
      reportKeys[0],
    ]);
    expect(new Set(reports.map((item) => item.value.idempotencyKey)).size).toBe(2);
    expect(new Set(reports.map((item) => item.value.reportDigest)).size).toBe(1);
    expect(new Set(reports.map((item) => item.value.createdAt)).size).toBe(1);
  });

  test("trims only explicit history tails to each whole-response byte cap", () => {
    const value = fixture();
    // U+0080 remains compact in ordinary JSON.stringify but the terminal-safe
    // wire serializer must expand it to an explicit Unicode escape.
    const body = "\u0080".repeat(WORK_SIGNAL_MAX_BYTES / 2);

    const workLevel = createWork(value);
    join(value, workLevel.work.id, workLevel.workRevision, value.reviewerSessionId);
    for (let index = 0; index < 16; index += 1) {
      value.now.value += 1;
      const key = randomUUID();
      value.store.apply({
        kind: "signal.send",
        idempotencyKey: key,
        workId: workLevel.work.id,
        senderSessionId: value.actorSessionId,
        senderCapability: capability,
        targetSessionId: value.reviewerSessionId,
        mode: "queue",
        body,
      });
      expect(value.store.authorizePreparedEffect(key).executable).toBe(true);
      value.store.finalizeSignal(key, { kind: "failed", code: `snapshot_${index}` });
    }
    const snapshot = value.store.snapshot(workLevel.work.id);
    expect(workReadSuccessWireBytes("work.snapshot", snapshot))
      .toBeLessThanOrEqual(WORK_SNAPSHOT_MAX_BYTES);
    expect(snapshot.recentSignals.length).toBeGreaterThan(0);
    expect(snapshot.recentSignals.length).toBeLessThan(16);
    expect(snapshot.omittedSignals).toBe(16 - snapshot.recentSignals.length);

    const taskValue = fixture();
    const taskLevel = createWork(taskValue);
    join(
      taskValue,
      taskLevel.work.id,
      taskLevel.workRevision,
      taskValue.reviewerSessionId,
    );
    claim(taskValue, {
      workId: taskLevel.work.id,
      taskId: taskLevel.tasks[0]!.id,
      revision: taskLevel.tasks[0]!.revision,
      actorSessionId: taskValue.reviewerSessionId,
    });
    for (let index = 0; index < 16; index += 1) {
      taskValue.now.value += 1;
      const key = randomUUID();
      taskValue.store.apply({
        kind: "signal.send",
        idempotencyKey: key,
        workId: taskLevel.work.id,
        senderSessionId: taskValue.actorSessionId,
        senderCapability: capability,
        targetSessionId: taskValue.reviewerSessionId,
        taskId: taskLevel.tasks[0]!.id,
        mode: "queue",
        body,
      });
      expect(taskValue.store.authorizePreparedEffect(key).executable).toBe(true);
      taskValue.store.finalizeSignal(key, { kind: "failed", code: `detail_${index}` });
    }
    const detail = taskValue.store.task(taskLevel.tasks[0]!.id);
    expect(workReadSuccessWireBytes("work.task", detail))
      .toBeLessThanOrEqual(WORK_TASK_DETAIL_MAX_BYTES);
    expect(detail.recentSignals.length).toBeGreaterThan(0);
    expect(detail.recentSignals.length).toBeLessThan(16);
    expect(detail.omittedSignals).toBe(16 - detail.recentSignals.length);
    expect(detail.omittedLatestSubmissionReviews).toBe(0);

    const history = taskValue.store.taskHistory(taskLevel.tasks[0]!.id, 50);
    expect(workReadSuccessWireBytes("work.task", history))
      .toBeLessThanOrEqual(WORK_TASK_HISTORY_PAGE_MAX_BYTES);
    expect(history.items.length).toBeGreaterThan(0);
    expect(history.items.length).toBeLessThan(17);
    expect(history.remainingItems).toBe(history.totalItems - history.items.length);
    expect(history.nextCursor).not.toBeNull();
    expect(JSON.stringify({ snapshot, detail, history })).not.toContain(capability);
  });

  test("fails closed on an oversized immutable detail core but still pages its history", () => {
    const value = fixture();
    const created = createWork(value);
    const claimed = claim(value, {
      workId: created.work.id,
      taskId: created.tasks[0]!.id,
      revision: created.tasks[0]!.revision,
    });
    const dispatchKey = randomUUID();
    value.store.apply({
      kind: "attempt.dispatch",
      idempotencyKey: dispatchKey,
      workId: created.work.id,
      attemptId: claimed.attempt.id,
      expectedAttemptRevision: claimed.attempt.revision,
      fence: claimed.attempt.fence,
      actorSessionId: value.actorSessionId,
      attemptCapability: capability,
      targetSessionId: value.actorSessionId,
      mode: "send",
    });
    expect(value.store.authorizePreparedEffect(dispatchKey).executable).toBe(true);
    const running = value.store.finalizeDispatch(dispatchKey, {
      kind: "accepted",
      receipt: turnStartedReceipt(),
    });
    value.store.apply({
      kind: "attempt.report",
      idempotencyKey: randomUUID(),
      workId: created.work.id,
      attemptId: running.id,
      expectedAttemptRevision: running.revision,
      fence: running.fence,
      actorSessionId: value.actorSessionId,
      attemptCapability: capability,
      report: {
        kind: "submit",
        summary: "\0".repeat(8 * 1024),
        result: { kind: "text", text: "\0".repeat(WORK_INLINE_RESULT_MAX_BYTES) },
        evidence: [],
      },
    });
    expect(() => value.store.task(created.tasks[0]!.id)).toThrow(
      new WorkStoreError("WORK_CAPACITY_EXCEEDED"),
    );
    let page = value.store.taskHistory(created.tasks[0]!.id, 1);
    const nearLimitItem = page.items[0];
    const firstContinuation = page.nextCursor;
    if (nearLimitItem?.kind !== "submission" || firstContinuation === null) {
      throw new Error("Expected the accepted near-limit submission to lead task history.");
    }
    const cursorCut = decodeTaskHistoryCursor(firstContinuation);
    const maximumCounter = Number.MAX_SAFE_INTEGER;
    const maximumOffset = WORK_TASK_HISTORY_TOTAL_ITEM_LIMIT - 2;
    const maximumCursor = (offset: number): string => encodeCursor({
      version: 1,
      type: "work_task_history",
      workId: created.work.id,
      taskId: created.tasks[0]!.id,
      streamEpoch: cursorCut.streamEpoch,
      sequence: WORK_HISTORY_EVENT_LIMIT,
      projectionAt: maximumCounter,
      highWaterOrdinal: maximumCounter,
      taskRevision: maximumCounter,
      offset,
    });
    const maximumMetadataPage = workTaskHistoryPageSchema.parse({
      version: 1,
      kind: "history",
      workId: created.work.id,
      taskId: created.tasks[0]!.id,
      taskRevision: maximumCounter,
      projectionAt: maximumCounter,
      requestedCursor: maximumCursor(maximumOffset),
      observedThroughCursor: encodeCursor({
        version: 1,
        type: "work",
        workId: created.work.id,
        streamEpoch: cursorCut.streamEpoch,
        sequence: WORK_HISTORY_EVENT_LIMIT,
      }),
      offset: maximumOffset,
      totalItems: WORK_TASK_HISTORY_TOTAL_ITEM_LIMIT,
      counts: {
        attempts: WORK_OPERATION_BATCH_LIMIT,
        attemptReports: 0,
        submissions: WORK_HISTORY_EVENT_LIMIT,
        reviews: 0,
        signals: 0,
      },
      items: [nearLimitItem],
      remainingItems: 1,
      remainingCounts: {
        attempts: 0,
        attemptReports: 0,
        submissions: 1,
        reviews: 0,
        signals: 0,
      },
      nextCursor: maximumCursor(maximumOffset + 1),
    });
    expect(workReadSuccessWireBytes("work.task", maximumMetadataPage))
      .toBeLessThanOrEqual(WORK_TASK_HISTORY_PAGE_MAX_BYTES);
    let returned = 0;
    for (;;) {
      expect(page.items).toHaveLength(1);
      expect(workReadSuccessWireBytes("work.task", page))
        .toBeLessThanOrEqual(WORK_TASK_HISTORY_PAGE_MAX_BYTES);
      returned += page.items.length;
      if (page.nextCursor === null) break;
      page = value.store.taskHistory(
        created.tasks[0]!.id,
        1,
        decodeTaskHistoryCursor(page.nextCursor),
      );
    }
    expect(returned).toBe(3);
  });

  test("fails closed when immutable task-history membership is missing", () => {
    const value = fixture();
    const created = createWork(value);
    claim(value, {
      workId: created.work.id,
      taskId: created.tasks[0]!.id,
      revision: created.tasks[0]!.revision,
    });
    expect(value.database.query(
      "SELECT COUNT(*) AS count FROM work_task_history_index WHERE task_id=?",
    ).get(created.tasks[0]!.id)).toEqual({ count: 1 });
    value.database.exec("DROP TRIGGER work_task_history_index_no_delete;");
    value.database.exec("DROP TRIGGER work_task_history_versions_no_delete;");
    value.database.query("DELETE FROM work_task_history_index WHERE task_id=?")
      .run(created.tasks[0]!.id);
    value.database.exec(WORK_SCHEMA_SQL);
    expect(() => value.store.taskHistory(created.tasks[0]!.id)).toThrow(
      "WORK_TASK_HISTORY_INDEX_CORRUPT",
    );
  });

  test("fails closed when an immutable task-history projection version is missing", () => {
    const value = fixture();
    const created = createWork(value);
    claim(value, {
      workId: created.work.id,
      taskId: created.tasks[0]!.id,
      revision: created.tasks[0]!.revision,
    });
    value.database.exec("DROP TRIGGER work_task_history_versions_no_delete;");
    value.database.query("DELETE FROM work_task_history_versions WHERE task_id=?")
      .run(created.tasks[0]!.id);
    value.database.exec(WORK_SCHEMA_SQL);
    expect(() => value.store.taskHistory(created.tasks[0]!.id)).toThrow(
      "WORK_TASK_HISTORY_VERSION_CORRUPT",
    );
  });

  test("rolls back an entity transition when its immutable history projection cannot append", () => {
    const value = fixture();
    const created = createWork(value);
    const claimed = claim(value, {
      workId: created.work.id,
      taskId: created.tasks[0]!.id,
      revision: created.tasks[0]!.revision,
    });
    const before = {
      attempt: value.store.task(created.tasks[0]!.id).latestAttempt,
      events: value.database.query(
        "SELECT COUNT(*) AS count FROM work_events WHERE work_id=?",
      ).get(created.work.id),
      versions: value.database.query(
        "SELECT COUNT(*) AS count FROM work_task_history_versions WHERE work_id=?",
      ).get(created.work.id),
    };
    value.database.exec(`
      CREATE TRIGGER injected_history_version_failure
      BEFORE INSERT ON work_task_history_versions
      BEGIN SELECT RAISE(ABORT,'INJECTED_HISTORY_VERSION_FAILURE'); END;
    `);
    value.now.value += 1;
    const idempotencyKey = randomUUID();
    expect(() => value.store.apply({
      kind: "attempt.renew",
      idempotencyKey,
      workId: created.work.id,
      attemptId: claimed.attempt.id,
      expectedAttemptRevision: claimed.attempt.revision,
      fence: claimed.attempt.fence,
      actorSessionId: value.actorSessionId,
      attemptCapability: capability,
      leaseMs: 6_000,
    })).toThrow("INJECTED_HISTORY_VERSION_FAILURE");
    value.database.exec("DROP TRIGGER injected_history_version_failure;");
    expect(value.store.task(created.tasks[0]!.id).latestAttempt).toEqual(before.attempt);
    expect(value.database.query(
      "SELECT COUNT(*) AS count FROM work_events WHERE work_id=?",
    ).get(created.work.id)).toEqual(before.events);
    expect(value.database.query(
      "SELECT COUNT(*) AS count FROM work_task_history_versions WHERE work_id=?",
    ).get(created.work.id)).toEqual(before.versions);
    expect(value.database.query(
      "SELECT 1 AS present FROM work_idempotency_intents WHERE idempotency_key=?",
    ).get(idempotencyKey)).toBeNull();
  });

  test("rejects a two-event review atomically with one general slot left", () => {
    const value = fixture();
    const created = createWork(value, [taskSpec(value, "review-capacity", {
      maxAttempts: 1,
      requiredReviews: 1,
    })]);
    join(value, created.work.id, created.workRevision, value.reviewerSessionId);
    const claimed = claim(value, {
      workId: created.work.id,
      taskId: created.tasks[0]!.id,
      revision: created.tasks[0]!.revision,
    });
    const dispatchKey = randomUUID();
    value.store.apply({
      kind: "attempt.dispatch",
      idempotencyKey: dispatchKey,
      workId: created.work.id,
      attemptId: claimed.attempt.id,
      expectedAttemptRevision: claimed.attempt.revision,
      fence: claimed.attempt.fence,
      actorSessionId: value.actorSessionId,
      attemptCapability: capability,
      targetSessionId: value.actorSessionId,
      mode: "send",
    });
    expect(value.store.authorizePreparedEffect(dispatchKey).executable).toBe(true);
    const running = value.store.finalizeDispatch(dispatchKey, {
      kind: "accepted",
      receipt: turnStartedReceipt(),
    });
    const reported = value.store.apply({
      kind: "attempt.report",
      idempotencyKey: randomUUID(),
      workId: created.work.id,
      attemptId: running.id,
      expectedAttemptRevision: running.revision,
      fence: running.fence,
      actorSessionId: value.actorSessionId,
      attemptCapability: capability,
      report: {
        kind: "submit",
        summary: "Awaiting a capacity-bound review.",
        result: { kind: "text", text: "done" },
        evidence: [],
      },
    });
    if (reported.kind !== "attempt.report" || reported.submission === null) {
      throw new Error("submission missing");
    }
    const submission = reported.submission;
    fillWorkEventCapacity(
      value,
      created.work.id,
      WORK_HISTORY_EVENT_LIMIT - WORK_HISTORY_RECOVERY_RESERVE - 1,
    );
    const reviewKey = randomUUID();
    const before = value.database.query(
      "SELECT revision,next_sequence,head_hash FROM works WHERE id=?",
    ).get(created.work.id);
    expect(() => value.store.apply({
      kind: "submission.review",
      idempotencyKey: reviewKey,
      workId: created.work.id,
      submissionId: submission.id,
      expectedSubmissionRevision: submission.revision,
      expectedContentDigest: submission.contentDigest,
      reviewerSessionId: value.reviewerSessionId,
      reviewerCapability: capability,
      review: {
        decision: "revise",
        feedback: "This would emit reviewed and attempts_exhausted.",
        evidence: [],
      },
    })).toThrow(new WorkStoreError("WORK_CAPACITY_EXCEEDED"));
    expect(value.database.query(
      "SELECT state,revision FROM work_attempts WHERE id=?",
    ).get(running.id)).toEqual({ state: "submitted", revision: running.revision + 1 });
    expect(value.database.query(
      "SELECT state FROM work_task_states WHERE task_id=?",
    ).get(claimed.task.id)).toEqual({ state: "submitted" });
    expect(value.database.query(
      "SELECT COUNT(*) AS count FROM work_reviews WHERE submission_id=?",
    ).get(submission.id)).toEqual({ count: 0 });
    expect(value.database.query(
      "SELECT 1 AS present FROM work_idempotency_intents WHERE idempotency_key=?",
    ).get(reviewKey)).toBeNull();
    expect(value.database.query(
      "SELECT revision,next_sequence,head_hash FROM works WHERE id=?",
    ).get(created.work.id)).toEqual(before);
  });

  test("tracks provider delivery independently from recipient acknowledgement", () => {
    const value = fixture();
    const created = createWork(value);
    const actorJoined = join(
      value,
      created.work.id,
      created.work.revision,
      value.actorSessionId,
    );
    join(value, created.work.id, actorJoined.workRevision, value.reviewerSessionId);
    const unknownKey = randomUUID();
    const preparedUnknown = value.store.apply({
      kind: "signal.send",
      idempotencyKey: unknownKey,
      workId: created.work.id,
      senderSessionId: value.actorSessionId,
      senderCapability: capability,
      targetSessionId: value.reviewerSessionId,
      mode: "steer",
      body: "Check the failure boundary before reviewing.",
    });
    if (preparedUnknown.kind !== "signal.send") throw new Error("unexpected result");
    expect(preparedUnknown.signal.deliveryState).toBe("pending");
    expect(preparedUnknown.signal.accountGeneration).toBe(1);
    const internalSignal = value.store.preparedEffect(unknownKey);
    if (internalSignal?.effect.kind !== "signal") throw new Error("signal effect missing");
    expect(internalSignal.effect.accountGeneration).toBe(1);
    expect(JSON.stringify(preparedUnknown.effect)).not.toContain(capability);
    expect(JSON.stringify(preparedUnknown.effect)).not.toContain(
      "Check the failure boundary before reviewing.",
    );
    expect(value.store.authorizePreparedEffect(unknownKey).executable).toBe(true);
    const unknown = value.store.finalizeSignal(unknownKey, {
      kind: "unknown",
      code: "custodian_restart",
    });
    expect(unknown.deliveryState).toBe("unknown");
    expect(() => value.store.apply({
      kind: "signal.ack",
      idempotencyKey: randomUUID(),
      workId: created.work.id,
      signalId: preparedUnknown.signal.id,
      expectedSignalRevision: unknown.revision,
      actorSessionId: value.actorSessionId,
      actorCapability: capability,
    })).toThrow(new WorkStoreError("MEMBER_NOT_FOUND"));
    expect(() => value.store.apply({
      kind: "signal.ack",
      idempotencyKey: randomUUID(),
      workId: created.work.id,
      signalId: preparedUnknown.signal.id,
      expectedSignalRevision: unknown.revision + 1,
      actorSessionId: value.reviewerSessionId,
      actorCapability: capability,
    })).toThrow(new WorkStoreError("REVISION_CONFLICT"));
    const acknowledgedUnknown = value.store.apply({
      kind: "signal.ack",
      idempotencyKey: randomUUID(),
      workId: created.work.id,
      signalId: preparedUnknown.signal.id,
      expectedSignalRevision: unknown.revision,
      actorSessionId: value.reviewerSessionId,
      actorCapability: capability,
    });
    if (acknowledgedUnknown.kind !== "signal.ack") throw new Error("unexpected result");
    expect(acknowledgedUnknown.signal.deliveryState).toBe("unknown");
    expect(acknowledgedUnknown.signal.acknowledgedAt).not.toBeNull();

    value.now.value += 1;
    const acceptedKey = randomUUID();
    const preparedAccepted = value.store.apply({
      kind: "signal.send",
      idempotencyKey: acceptedKey,
      workId: created.work.id,
      senderSessionId: value.actorSessionId,
      senderCapability: capability,
      targetSessionId: value.reviewerSessionId,
      mode: "queue",
      body: "The bounded result is ready for review.",
    });
    if (preparedAccepted.kind !== "signal.send") throw new Error("unexpected result");
    const acknowledgedPending = value.store.apply({
      kind: "signal.ack",
      idempotencyKey: randomUUID(),
      workId: created.work.id,
      signalId: preparedAccepted.signal.id,
      expectedSignalRevision: preparedAccepted.signal.revision,
      actorSessionId: value.reviewerSessionId,
      actorCapability: capability,
    });
    if (acknowledgedPending.kind !== "signal.ack") throw new Error("unexpected result");
    expect(acknowledgedPending.signal.deliveryState).toBe("pending");
    expect(acknowledgedPending.signal.acknowledgedAt).not.toBeNull();
    expect(value.store.authorizePreparedEffect(acceptedKey).executable).toBe(true);
    const accepted = value.store.finalizeSignal(acceptedKey, {
      kind: "accepted",
      receipt: queueReceipt(),
    });
    expect(accepted.deliveryState).toBe("accepted");
    expect(accepted.acknowledgedAt).not.toBeNull();
    expect(value.database.query(
      "SELECT kind FROM work_signal_receipts WHERE signal_id=? ORDER BY sequence",
    ).all(preparedAccepted.signal.id)).toEqual([{ kind: "ack" }, { kind: "accepted" }]);
    const signalHistory = value.store.snapshot(created.work.id);
    expect(signalHistory.recentSignals.map((signal) => ({
      id: signal.id,
      deliveryState: signal.deliveryState,
      acknowledged: signal.acknowledgedAt !== null,
    }))).toEqual([
      {
        id: preparedAccepted.signal.id,
        deliveryState: "accepted" as const,
        acknowledged: true,
      },
      {
        id: preparedUnknown.signal.id,
        deliveryState: "unknown" as const,
        acknowledged: true,
      },
    ]);
    expect(signalHistory.omittedSignals).toBe(0);
  });

  test("releases completed work with an unknown signal without replaying delivery", () => {
    const value = fixture();
    const created = createWork(value);
    join(value, created.work.id, created.work.revision, value.reviewerSessionId);
    const claimed = claim(value, {
      workId: created.work.id,
      taskId: created.tasks[0]!.id,
      revision: created.tasks[0]!.revision,
    });
    const dispatchKey = randomUUID();
    value.store.apply({
      kind: "attempt.dispatch",
      idempotencyKey: dispatchKey,
      workId: created.work.id,
      attemptId: claimed.attempt.id,
      expectedAttemptRevision: claimed.attempt.revision,
      fence: claimed.attempt.fence,
      actorSessionId: value.actorSessionId,
      attemptCapability: capability,
      targetSessionId: value.actorSessionId,
      mode: "send",
    });
    expect(value.store.authorizePreparedEffect(dispatchKey).executable).toBe(true);
    const running = value.store.finalizeDispatch(dispatchKey, {
      kind: "accepted",
      receipt: turnStartedReceipt(),
    });
    const report = value.store.apply({
      kind: "attempt.report",
      idempotencyKey: randomUUID(),
      workId: created.work.id,
      attemptId: claimed.attempt.id,
      expectedAttemptRevision: running.revision,
      fence: claimed.attempt.fence,
      actorSessionId: value.actorSessionId,
      attemptCapability: capability,
      report: {
        kind: "submit",
        summary: "The task is complete.",
        result: { kind: "text", text: "done" },
        evidence: [],
      },
    });
    if (report.kind !== "attempt.report") throw new Error("unexpected result");
    const signalKey = randomUUID();
    value.store.apply({
      kind: "signal.send",
      idempotencyKey: signalKey,
      workId: created.work.id,
      senderSessionId: value.actorSessionId,
      senderCapability: capability,
      targetSessionId: value.reviewerSessionId,
      mode: "queue",
      body: "UNKNOWN_SIGNAL_BODY_SENTINEL",
    });
    expect(value.store.authorizePreparedEffect(signalKey).executable).toBe(true);
    const unknown = value.store.finalizeSignal(signalKey, {
      kind: "unknown",
      code: "queue_recovery_unknown",
    });
    expect(unknown.deliveryState).toBe("unknown");
    const beforeComplete = value.store.snapshot(created.work.id);
    expect(beforeComplete.tasks[0]?.status).toBe("completed");
    const completed = value.store.apply({
      kind: "work.complete",
      idempotencyKey: randomUUID(),
      workId: created.work.id,
      expectedWorkRevision: beforeComplete.work.revision,
      actorSessionId: value.actorSessionId,
      coordinatorCapability: capability,
      summary: "All task work is accepted.",
      evidence: [],
      result: { kind: "text", text: "done" },
    });
    if (completed.kind !== "work.complete") throw new Error("unexpected result");
    expect(completed.work.status).toBe("completed");
    expect(value.store.effectStatus(signalKey)?.state).toBe("unknown");
    expect(value.store.snapshot(created.work.id).recentSignals[0]?.deliveryState).toBe("unknown");
    const nestedMutationCount = value.database.query(
      "SELECT COUNT(*) AS count FROM mutation_attempts",
    ).get() as { count: number };
    const released = value.store.apply({
      kind: "work.release",
      idempotencyKey: randomUUID(),
      workId: created.work.id,
      expectedWorkRevision: completed.workRevision,
      actorSessionId: value.actorSessionId,
      coordinatorCapability: capability,
      acknowledgeDataLoss: true,
    });
    if (released.kind !== "work.release") throw new Error("unexpected result");
    expect(released.tombstone.discardedRecordCounts).toMatchObject({
      signals: 1,
      effects: 2,
      unresolvedSignalEffects: 1,
    });
    expect(value.database.query(
      "SELECT COUNT(*) AS count FROM mutation_attempts",
    ).get()).toEqual(nestedMutationCount);
    expect(value.store.recoverablePreparedEffects().effects).toHaveLength(0);
    const serializedResult = JSON.stringify(released);
    const storedTombstone = value.database.query(
      "SELECT result_json FROM work_release_tombstones WHERE work_id=?",
    ).get(created.work.id) as { result_json: string };
    for (const protectedValue of ["UNKNOWN_SIGNAL_BODY_SENTINEL", capability]) {
      expect(serializedResult).not.toContain(protectedValue);
      expect(storedTombstone.result_json).not.toContain(protectedValue);
    }
  });

  test("releases settled coordination history behind a bounded replay tombstone", () => {
    const value = fixture();
    const createKey = randomUUID();
    const created = value.store.apply({
      kind: "work.create",
      idempotencyKey: createKey,
      clientRef: "release-sentinel-plan",
      coordinatorSessionId: value.actorSessionId,
      objective: "WORK_OBJECTIVE_SENTINEL",
      routes: [{
        accountId: value.accountId,
        projectId: value.projectId,
        preset: "high",
        fast: false,
      }],
      tasks: [taskSpec(value, "release-task", {
        objective: "TASK_OBJECTIVE_SENTINEL",
        instructions: "TASK_INSTRUCTIONS_SENTINEL",
      })],
    });
    if (created.kind !== "work.create") throw new Error("unexpected result");
    join(value, created.work.id, created.workRevision, value.reviewerSessionId);

    const claimed = claim(value, {
      workId: created.work.id,
      taskId: created.tasks[0]!.id,
      revision: created.tasks[0]!.revision,
    });
    const dispatchKey = randomUUID();
    value.store.apply({
      kind: "attempt.dispatch",
      idempotencyKey: dispatchKey,
      workId: created.work.id,
      attemptId: claimed.attempt.id,
      expectedAttemptRevision: claimed.attempt.revision,
      fence: claimed.attempt.fence,
      actorSessionId: value.actorSessionId,
      attemptCapability: capability,
      targetSessionId: value.actorSessionId,
      mode: "send",
    });
    const dispatch = value.store.preparedEffect(dispatchKey)?.effect;
    if (dispatch?.kind !== "dispatch") throw new Error("dispatch effect missing");
    insertAppliedNestedMutation(value, dispatch);
    const acceptedDispatch = value.store.authorizePreparedEffect(dispatchKey);
    expect(acceptedDispatch.executable).toBe(false);
    expect(acceptedDispatch.status.state).toBe("accepted");
    const runningAttempt = value.store.task(created.tasks[0]!.id).latestAttempt;
    if (runningAttempt === null) throw new Error("running attempt missing");
    value.store.apply({
      kind: "attempt.report",
      idempotencyKey: randomUUID(),
      workId: created.work.id,
      attemptId: runningAttempt.id,
      expectedAttemptRevision: runningAttempt.revision,
      fence: runningAttempt.fence,
      actorSessionId: value.actorSessionId,
      attemptCapability: capability,
      report: {
        kind: "submit",
        summary: "Release-ready accepted result.",
        result: { kind: "text", text: "done" },
        evidence: [],
      },
    });

    const failedSignalKey = randomUUID();
    value.store.apply({
      kind: "signal.send",
      idempotencyKey: failedSignalKey,
      workId: created.work.id,
      senderSessionId: value.actorSessionId,
      senderCapability: capability,
      targetSessionId: value.reviewerSessionId,
      mode: "queue",
      body: "FAILED_SIGNAL_BODY_SENTINEL",
    });
    const failedSignal = value.store.preparedEffect(failedSignalKey)?.effect;
    if (failedSignal?.kind !== "signal") throw new Error("signal effect missing");
    insertFailedNestedMutation(value, failedSignal);
    const failedDelivery = value.store.authorizePreparedEffect(failedSignalKey);
    expect(failedDelivery.executable).toBe(false);
    expect(failedDelivery.status.state).toBe("failed");

    const acceptedSignalKey = randomUUID();
    value.store.apply({
      kind: "signal.send",
      idempotencyKey: acceptedSignalKey,
      workId: created.work.id,
      senderSessionId: value.actorSessionId,
      senderCapability: capability,
      targetSessionId: value.reviewerSessionId,
      mode: "queue",
      body: "ACCEPTED_SIGNAL_BODY_SENTINEL",
    });
    const acceptedSignal = value.store.preparedEffect(acceptedSignalKey)?.effect;
    if (acceptedSignal?.kind !== "signal") throw new Error("signal effect missing");
    insertAppliedNestedMutation(value, acceptedSignal);
    const acceptedDelivery = value.store.authorizePreparedEffect(acceptedSignalKey);
    expect(acceptedDelivery.executable).toBe(false);
    expect(acceptedDelivery.status.state).toBe("accepted");

    expect(value.database.query(
      "SELECT COUNT(*) AS count FROM work_nested_effect_settlements",
    ).get()).toEqual({ count: 3 });
    const beforeComplete = value.store.snapshot(created.work.id);
    const completed = value.store.apply({
      kind: "work.complete",
      idempotencyKey: randomUUID(),
      workId: created.work.id,
      expectedWorkRevision: beforeComplete.work.revision,
      actorSessionId: value.actorSessionId,
      coordinatorCapability: capability,
      summary: "Release the settled plan.",
      evidence: [],
      result: { kind: "text", text: "done" },
    });
    if (completed.kind !== "work.complete") throw new Error("unexpected result");
    const releaseOperation = {
      kind: "work.release",
      idempotencyKey: randomUUID(),
      workId: created.work.id,
      expectedWorkRevision: completed.workRevision,
      actorSessionId: value.actorSessionId,
      coordinatorCapability: capability,
      acknowledgeDataLoss: true,
    } satisfies WorkOperation;
    const historyIndexCount = (value.database.query(
      "SELECT COUNT(*) AS count FROM work_task_history_index WHERE work_id=?",
    ).get(created.work.id) as { count: number }).count;
    const historyVersionCount = (value.database.query(
      "SELECT COUNT(*) AS count FROM work_task_history_versions WHERE work_id=?",
    ).get(created.work.id) as { count: number }).count;
    expect(historyIndexCount).toBeGreaterThan(0);
    expect(historyVersionCount).toBeGreaterThanOrEqual(historyIndexCount);
    expect(value.database.query("SELECT revision FROM works WHERE id=?").get(created.work.id))
      .toEqual({ revision: completed.workRevision });
    const released = value.store.apply(releaseOperation);
    if (released.kind !== "work.release") throw new Error("unexpected result");
    expect(released.tombstone).toMatchObject({
      workId: created.work.id,
      terminalKind: "work.complete",
      priorOperationReplayGuaranteesEnded: true,
      releaseReplayPolicy: "retained_tombstone_only",
      discardedRecordCounts: {
        routes: 1,
        members: 2,
        tasks: 1,
        signals: 2,
        effects: 3,
        unresolvedSignalEffects: 0,
        effectResolutions: 3,
        historyIndex: historyIndexCount,
        historyVersions: historyVersionCount,
      },
    });
    expect(released.tombstone.retentionUpperBoundAt).toBeGreaterThan(
      released.tombstone.releasedAt,
    );
    expect(value.store.apply(releaseOperation)).toEqual(released);
    expect(() => value.store.apply({
      ...releaseOperation,
      expectedWorkRevision: releaseOperation.expectedWorkRevision + 1,
    })).toThrow(new WorkStoreError("IDEMPOTENCY_CONFLICT"));
    expect(() => value.store.snapshot(created.work.id)).toThrow(
      new WorkStoreError("WORK_RELEASED"),
    );
    expect(() => value.store.apply({
      kind: "work.create",
      idempotencyKey: randomUUID(),
      clientRef: created.work.clientRef,
      coordinatorSessionId: value.actorSessionId,
      objective: created.work.objective,
      routes: [{
        accountId: value.accountId,
        projectId: value.projectId,
        preset: "high",
        fast: false,
      }],
      tasks: [taskSpec(value)],
    })).toThrow(new WorkStoreError("WORK_RELEASED"));
    expect(value.database.query("SELECT COUNT(*) AS count FROM works").get()).toEqual({ count: 0 });
    expect(value.database.query("SELECT COUNT(*) AS count FROM work_tasks").get()).toEqual({ count: 0 });
    expect(value.database.query("SELECT COUNT(*) AS count FROM work_task_history_index").get())
      .toEqual({ count: 0 });
    expect(value.database.query("SELECT COUNT(*) AS count FROM work_task_history_versions").get())
      .toEqual({ count: 0 });
    expect(value.database.query("SELECT COUNT(*) AS count FROM work_events").get()).toEqual({ count: 0 });
    expect(value.database.query("SELECT COUNT(*) AS count FROM work_signal_provider_authorities").get()).toEqual({ count: 0 });
    expect(() => assertWorkSignalProviderAuthorities(value.database)).not.toThrow();
    expect(value.database.query("SELECT COUNT(*) AS count FROM work_idempotency_intents").get())
      .toEqual({ count: 0 });
    expect(value.database.query(
      "SELECT COUNT(*) AS count FROM work_nested_effect_settlements",
    ).get()).toEqual({ count: 0 });
    expect(value.database.query("SELECT COUNT(*) AS count FROM work_purge_authority").get())
      .toEqual({ count: 0 });
    expect(value.database.query("SELECT COUNT(*) AS count FROM work_release_tombstones").get())
      .toEqual({ count: 1 });
    expect(value.database.query("PRAGMA foreign_key_check").all()).toEqual([]);
    const retainedJson = (value.database.query(
      "SELECT result_json FROM work_release_tombstones WHERE work_id=?",
    ).get(created.work.id) as { result_json: string }).result_json;
    for (const sentinel of [
      "WORK_OBJECTIVE_SENTINEL",
      "TASK_OBJECTIVE_SENTINEL",
      "TASK_INSTRUCTIONS_SENTINEL",
      "FAILED_SIGNAL_BODY_SENTINEL",
      "ACCEPTED_SIGNAL_BODY_SENTINEL",
      capability,
    ]) {
      expect(retainedJson).not.toContain(sentinel);
      expect(JSON.stringify(released)).not.toContain(sentinel);
    }
  });

  test("prunes release tombstones only for expiry or an incoming release", () => {
    const value = fixture();
    const releasable = createWork(value);
    const failed = value.store.apply({
      kind: "work.fail",
      idempotencyKey: randomUUID(),
      workId: releasable.work.id,
      expectedWorkRevision: releasable.workRevision,
      actorSessionId: value.actorSessionId,
      coordinatorCapability: capability,
      summary: "Prepare one real release at the retention boundary.",
      evidence: [],
    });
    if (failed.kind !== "work.fail") throw new Error("unexpected result");
    const { oldestWorkId, secondWorkId } = fillReleaseTombstoneCapacity(value);
    expect(value.database.query(
      "SELECT COUNT(*) AS count FROM work_release_tombstones",
    ).get()).toEqual({ count: WORK_TOMBSTONE_LIMIT });

    const unrelated = value.store.apply({
      kind: "work.create",
      idempotencyKey: randomUUID(),
      clientRef: "retention-unrelated-work",
      coordinatorSessionId: value.actorSessionId,
      objective: "An unrelated mutation must not evict a live tombstone.",
      routes: [{
        accountId: value.accountId,
        projectId: value.projectId,
        preset: "high",
        fast: false,
      }],
      tasks: [taskSpec(value, "retention-unrelated-task")],
    });
    if (unrelated.kind !== "work.create") throw new Error("unexpected result");
    expect(value.database.query(
      "SELECT COUNT(*) AS count FROM work_release_tombstones",
    ).get()).toEqual({ count: WORK_TOMBSTONE_LIMIT });
    expect(value.database.query(
      "SELECT 1 AS present FROM work_release_tombstones WHERE work_id=?",
    ).get(oldestWorkId)).toEqual({ present: 1 });

    const released = value.store.apply({
      kind: "work.release",
      idempotencyKey: randomUUID(),
      workId: releasable.work.id,
      expectedWorkRevision: failed.workRevision,
      actorSessionId: value.actorSessionId,
      coordinatorCapability: capability,
      acknowledgeDataLoss: true,
    });
    if (released.kind !== "work.release") throw new Error("unexpected result");
    expect(value.database.query(
      "SELECT COUNT(*) AS count FROM work_release_tombstones",
    ).get()).toEqual({ count: WORK_TOMBSTONE_LIMIT });
    expect(value.database.query(
      "SELECT 1 AS present FROM work_release_tombstones WHERE work_id=?",
    ).get(oldestWorkId)).toBeNull();
    expect(value.database.query(
      "SELECT 1 AS present FROM work_release_tombstones WHERE work_id=?",
    ).get(secondWorkId)).toEqual({ present: 1 });
    expect(value.database.query(
      "SELECT 1 AS present FROM work_release_tombstones WHERE work_id=?",
    ).get(releasable.work.id)).toEqual({ present: 1 });

    const expiredWorkId = `wrk_${"f".repeat(32)}`;
    value.database.query(
      `INSERT INTO work_release_tombstones(
         work_id,release_idempotency_key,release_request_digest,client_ref_digest,
         coordinator_session_id,terminal_kind,terminal_request_digest,final_revision,
         final_head_hash,discarded_counts_json,discarded_records_digest,released_at,
         retention_upper_bound_at,result_json
       ) VALUES (?,?,?,?,?,'work.fail',?,1,?,'{}',?,0,9999,'{}')`,
    ).run(
      expiredWorkId,
      "ffffffff-ffff-7000-8001-ffffffffffff",
      "d".repeat(64),
      "e".repeat(64),
      "ses_expired",
      "f".repeat(64),
      "1".repeat(64),
      "2".repeat(64),
    );
    join(value, unrelated.work.id, unrelated.workRevision, value.reviewerSessionId);
    expect(value.database.query(
      "SELECT 1 AS present FROM work_release_tombstones WHERE work_id=?",
    ).get(expiredWorkId)).toBeNull();
    expect(value.database.query(
      "SELECT COUNT(*) AS count FROM work_release_tombstones",
    ).get()).toEqual({ count: WORK_TOMBSTONE_LIMIT });
    expect(value.database.query(
      "SELECT 1 AS present FROM work_release_tombstones WHERE work_id=?",
    ).get(secondWorkId)).toEqual({ present: 1 });
  });

  test("rejects unauthorized, stale, and nonterminal history release without deleting data", () => {
    const value = fixture();
    const created = createWork(value);
    const activeRelease = {
      kind: "work.release",
      idempotencyKey: randomUUID(),
      workId: created.work.id,
      expectedWorkRevision: created.workRevision,
      actorSessionId: value.actorSessionId,
      coordinatorCapability: capability,
      acknowledgeDataLoss: true,
    } satisfies WorkOperation;
    expect(() => value.store.apply({
      ...activeRelease,
      coordinatorCapability: `hrac1_${"A".repeat(42)}Q`,
    })).toThrow(new WorkStoreError("ATTEMPT_NOT_OWNER"));
    expect(() => value.store.apply(activeRelease)).toThrow(
      new WorkStoreError("WORK_NOT_ACTIVE"),
    );
    expect(value.database.query("SELECT COUNT(*) AS count FROM works").get()).toEqual({ count: 1 });
    expect(value.database.query("SELECT COUNT(*) AS count FROM work_release_tombstones").get())
      .toEqual({ count: 0 });

    const failed = value.store.apply({
      kind: "work.fail",
      idempotencyKey: randomUUID(),
      workId: created.work.id,
      expectedWorkRevision: created.workRevision,
      actorSessionId: value.actorSessionId,
      coordinatorCapability: capability,
      summary: "Close before release.",
      evidence: [],
    });
    if (failed.kind !== "work.fail") throw new Error("unexpected result");
    expect(() => value.store.apply({
      ...activeRelease,
      idempotencyKey: randomUUID(),
      expectedWorkRevision: failed.workRevision - 1,
    })).toThrow(new WorkStoreError("REVISION_CONFLICT"));
    expect(value.database.query("SELECT COUNT(*) AS count FROM works").get()).toEqual({ count: 1 });
    expect(value.database.query("SELECT COUNT(*) AS count FROM work_tasks").get()).toEqual({ count: 1 });
    expect(value.database.query("SELECT COUNT(*) AS count FROM work_release_tombstones").get())
      .toEqual({ count: 0 });
  });

  test("rolls back the tombstone, purge guard, and graph when a guarded delete fails", () => {
    const value = fixture();
    const created = createWork(value);
    claim(value, {
      workId: created.work.id,
      taskId: created.tasks[0]!.id,
      revision: created.tasks[0]!.revision,
    });
    const failed = value.store.apply({
      kind: "work.fail",
      idempotencyKey: randomUUID(),
      workId: created.work.id,
      expectedWorkRevision: value.store.snapshot(created.work.id).work.revision,
      actorSessionId: value.actorSessionId,
      coordinatorCapability: capability,
      summary: "Close before release.",
      evidence: [],
    });
    if (failed.kind !== "work.fail") throw new Error("unexpected result");
    const releaseOperation = {
      kind: "work.release",
      idempotencyKey: randomUUID(),
      workId: created.work.id,
      expectedWorkRevision: failed.workRevision,
      actorSessionId: value.actorSessionId,
      coordinatorCapability: capability,
      acknowledgeDataLoss: true,
    } satisfies WorkOperation;
    value.database.exec(`
      CREATE TRIGGER injected_work_purge_failure
      BEFORE DELETE ON work_tasks
      WHEN OLD.work_id='${created.work.id}'
      BEGIN SELECT RAISE(ABORT,'INJECTED_WORK_PURGE_FAILURE'); END;
    `);
    expect(() => value.store.apply(releaseOperation)).toThrow("INJECTED_WORK_PURGE_FAILURE");
    expect(value.database.query("SELECT COUNT(*) AS count FROM works").get()).toEqual({ count: 1 });
    expect(value.database.query("SELECT COUNT(*) AS count FROM work_tasks").get()).toEqual({ count: 1 });
    expect(value.database.query("SELECT COUNT(*) AS count FROM work_task_history_index").get())
      .toEqual({ count: 1 });
    expect((value.database.query(
      "SELECT COUNT(*) AS count FROM work_task_history_versions",
    ).get() as { count: number }).count).toBeGreaterThan(0);
    expect(value.database.query("SELECT COUNT(*) AS count FROM work_release_tombstones").get())
      .toEqual({ count: 0 });
    expect(value.database.query("SELECT COUNT(*) AS count FROM work_purge_authority").get())
      .toEqual({ count: 0 });
    expect(value.database.query("PRAGMA foreign_key_check").all()).toEqual([]);
    value.database.exec("DROP TRIGGER injected_work_purge_failure");
    const released = value.store.apply(releaseOperation);
    expect(released.kind).toBe("work.release");
    expect(value.database.query("SELECT COUNT(*) AS count FROM work_task_history_index").get())
      .toEqual({ count: 0 });
    expect(value.database.query("SELECT COUNT(*) AS count FROM work_task_history_versions").get())
      .toEqual({ count: 0 });
    expect(value.database.query("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  test("rejects release atomically when the durable event head is corrupt", () => {
    const value = fixture();
    const created = createWork(value);
    const failed = value.store.apply({
      kind: "work.fail",
      idempotencyKey: randomUUID(),
      workId: created.work.id,
      expectedWorkRevision: created.workRevision,
      actorSessionId: value.actorSessionId,
      coordinatorCapability: capability,
      summary: "Terminal work with a subsequently corrupted head.",
      evidence: [],
    });
    if (failed.kind !== "work.fail") throw new Error("unexpected result");
    const eventCount = value.database.query(
      "SELECT COUNT(*) AS count FROM work_events WHERE work_id=?",
    ).get(created.work.id);
    value.database.exec("DROP TRIGGER works_stream_advance_guard;");
    value.database.query("UPDATE works SET head_hash=? WHERE id=?")
      .run("f".repeat(64), created.work.id);
    value.database.exec(WORK_SCHEMA_SQL);

    expect(() => value.store.apply({
      kind: "work.release",
      idempotencyKey: randomUUID(),
      workId: created.work.id,
      expectedWorkRevision: failed.workRevision,
      actorSessionId: value.actorSessionId,
      coordinatorCapability: capability,
      acknowledgeDataLoss: true,
    })).toThrow("WORK_EVENT_CHAIN_CORRUPT");
    expect(value.database.query(
      "SELECT COUNT(*) AS count FROM works WHERE id=?",
    ).get(created.work.id)).toEqual({ count: 1 });
    expect(value.database.query(
      "SELECT COUNT(*) AS count FROM work_tasks WHERE work_id=?",
    ).get(created.work.id)).toEqual({ count: 1 });
    expect(value.database.query(
      "SELECT COUNT(*) AS count FROM work_events WHERE work_id=?",
    ).get(created.work.id)).toEqual(eventCount);
    expect(value.database.query(
      "SELECT COUNT(*) AS count FROM work_release_tombstones",
    ).get()).toEqual({ count: 0 });
    expect(value.database.query(
      "SELECT COUNT(*) AS count FROM work_purge_authority",
    ).get()).toEqual({ count: 0 });
  });
});

describe("WorkStore cancellation and recovery", () => {
  test("session retirement uses the captured provider process and never the sibling mirror", () => {
    const value = fixture();
    setSessionProfile(value, value.reviewerSessionId, { provider: "claude", preset: "ultra" });
    value.database.query("UPDATE provider_accounts SET process_generation=3 WHERE profile_id=? AND provider='claude'")
      .run(value.accountId);
    value.database.query("UPDATE session_provider_authorities SET process_generation=3 WHERE session_id=?")
      .run(value.reviewerSessionId);
    expect(value.store.prepareSessionAuthorityChange([value.reviewerSessionId], 3)).toEqual([]);
    expect(() => value.store.prepareSessionAuthorityChange([value.reviewerSessionId], 1))
      .toThrow("REVISION_CONFLICT");
    value.database.query("UPDATE provider_accounts SET process_generation=4 WHERE profile_id=? AND provider='claude'")
      .run(value.accountId);
    expect(value.store.prepareSessionAuthorityChange([value.reviewerSessionId], 3)).toEqual([]);
    value.database.query("DELETE FROM session_provider_authorities WHERE session_id=?")
      .run(value.reviewerSessionId);
    expect(() => value.store.prepareSessionAuthorityChange([value.reviewerSessionId], 3))
      .toThrow("REVISION_CONFLICT");
  });

  test("retires only attempts owned by the exact bounded session set", () => {
    const value = fixture();
    const created = createWork(value, [
      taskSpec(value, "actor-task"),
      taskSpec(value, "reviewer-task"),
    ]);
    join(value, created.work.id, created.work.revision, value.reviewerSessionId);
    const actorTask = created.tasks.find((task) => task.clientRef === "actor-task")!;
    const reviewerTask = created.tasks.find((task) => task.clientRef === "reviewer-task")!;
    const actorClaim = claim(value, {
      workId: created.work.id,
      taskId: actorTask.id,
      revision: actorTask.revision,
    });
    const reviewerClaim = claim(value, {
      workId: created.work.id,
      taskId: reviewerTask.id,
      revision: reviewerTask.revision,
      actorSessionId: value.reviewerSessionId,
    });

    expect(() => value.store.prepareSessionAuthorityChange(
      [value.reviewerSessionId],
      2,
    )).toThrow(new WorkStoreError("REVISION_CONFLICT"));
    expect(value.store.task(actorTask.id).activeAttempt?.status).toBe("claimed");
    expect(value.store.task(reviewerTask.id).activeAttempt?.status).toBe("claimed");
    expect(() => value.store.prepareSessionAuthorityChange(
      Array.from({ length: 501 }, () => value.reviewerSessionId),
      1,
    )).toThrow(new WorkStoreError("WORK_CAPACITY_EXCEEDED"));
    expect(value.store.task(reviewerTask.id).activeAttempt?.status).toBe("claimed");

    expect(value.store.prepareSessionAuthorityChange(
      [value.reviewerSessionId, value.reviewerSessionId],
      1,
    )).toEqual([created.work.id]);
    expect(value.store.task(actorTask.id).activeAttempt).toMatchObject({
      id: actorClaim.attempt.id,
      status: "claimed",
    });
    expect(value.store.task(reviewerTask.id).activeAttempt).toBeNull();
    expect(value.store.task(reviewerTask.id).task.status).toBe("ready");
    expect(value.database.query(
      "SELECT state FROM work_attempts WHERE id=?",
    ).get(reviewerClaim.attempt.id)).toEqual({ state: "released" });
    expect(value.store.prepareSessionAuthorityChange([], 1)).toEqual([]);
  });

  test("reconciles no-effect only from a determinate failed nested mutation", () => {
    const prepareRecovery = (nestedState: "ambiguous" | "failed") => {
      const value = fixture();
      const created = createWork(value);
      const claimed = claim(value, {
        workId: created.work.id,
        taskId: created.tasks[0]!.id,
        revision: created.tasks[0]!.revision,
      });
      const dispatchKey = randomUUID();
      const prepared = value.store.apply({
        kind: "attempt.dispatch",
        idempotencyKey: dispatchKey,
        workId: created.work.id,
        attemptId: claimed.attempt.id,
        expectedAttemptRevision: claimed.attempt.revision,
        fence: claimed.attempt.fence,
        actorSessionId: value.actorSessionId,
        attemptCapability: capability,
        targetSessionId: value.actorSessionId,
        mode: "send",
      });
      if (prepared.kind !== "attempt.dispatch") throw new Error("unexpected result");
      expect(value.store.authorizePreparedEffect(dispatchKey).executable).toBe(true);
      const internal = value.store.preparedEffect(dispatchKey);
      if (internal?.effect.kind !== "dispatch") throw new Error("dispatch effect missing");
      insertNestedDispatchMutation(value, internal.effect, nestedState);
      const unknown = value.store.finalizeDispatch(dispatchKey, {
        kind: "unknown",
        code: "provider_unknown",
      });
      return { value, created, claimed, unknown, dispatchKey };
    };

    const ambiguous = prepareRecovery("ambiguous");
    const rejectedKey = randomUUID();
    expect(() => ambiguous.value.store.apply({
      kind: "attempt.reconcile",
      idempotencyKey: rejectedKey,
      workId: ambiguous.created.work.id,
      attemptId: ambiguous.claimed.attempt.id,
      expectedAttemptRevision: ambiguous.unknown.revision,
      fence: ambiguous.claimed.attempt.fence,
      actorSessionId: ambiguous.value.actorSessionId,
      attemptCapability: capability,
      outcome: {
        kind: "no_effect",
        summary: "Caller evidence cannot prove an ambiguous effect absent.",
        evidence: [],
      },
    })).toThrow(new WorkStoreError("ATTEMPT_RECOVERY_REQUIRED"));
    expect(ambiguous.value.store.task(ambiguous.created.tasks[0]!.id).activeAttempt?.status).toBe(
      "unknown",
    );
    expect(ambiguous.value.store.effectStatus(ambiguous.dispatchKey)?.state).toBe("unknown");
    expect(ambiguous.value.database.query(
      "SELECT 1 AS present FROM work_idempotency_intents WHERE idempotency_key=?",
    ).get(rejectedKey)).toBeNull();
    const rejectedFailureKey = randomUUID();
    expect(() => ambiguous.value.store.apply({
      kind: "attempt.reconcile",
      idempotencyKey: rejectedFailureKey,
      workId: ambiguous.created.work.id,
      attemptId: ambiguous.claimed.attempt.id,
      expectedAttemptRevision: ambiguous.unknown.revision,
      fence: ambiguous.claimed.attempt.fence,
      actorSessionId: ambiguous.value.actorSessionId,
      attemptCapability: capability,
      outcome: {
        kind: "failed",
        summary: "An ambiguous nested effect cannot be rewritten as failed.",
        evidence: [],
      },
    })).toThrow(new WorkStoreError("ATTEMPT_RECOVERY_REQUIRED"));
    expect(ambiguous.value.database.query(
      "SELECT 1 AS present FROM work_idempotency_intents WHERE idempotency_key=?",
    ).get(rejectedFailureKey)).toBeNull();

    const failed = prepareRecovery("failed");
    const reconciled = failed.value.store.apply({
      kind: "attempt.reconcile",
      idempotencyKey: randomUUID(),
      workId: failed.created.work.id,
      attemptId: failed.claimed.attempt.id,
      expectedAttemptRevision: failed.unknown.revision,
      fence: failed.claimed.attempt.fence,
      actorSessionId: failed.value.actorSessionId,
      attemptCapability: capability,
      outcome: {
        kind: "no_effect",
        summary: "The nested mutation journal proves no provider effect survived.",
        evidence: [],
      },
    });
    if (reconciled.kind !== "attempt.reconcile") throw new Error("unexpected result");
    expect(reconciled.attempt.status).toBe("released");
    expect(failed.value.store.effectStatus(failed.dispatchKey)?.state).toBe("failed");
    expect(failed.value.store.snapshot(failed.created.work.id).tasks[0]?.status).toBe("ready");
    expect(failed.value.database.query(
      `SELECT
         (SELECT COUNT(*) FROM work_nested_effect_settlements
          WHERE effect_idempotency_key=?) AS nested,
         (SELECT COUNT(*) FROM work_effect_resolutions
          WHERE effect_idempotency_key=?) AS resolved`,
    ).get(failed.dispatchKey, failed.dispatchKey)).toEqual({ nested: 1, resolved: 1 });

    const failedOutcome = prepareRecovery("failed");
    const closed = failedOutcome.value.store.apply({
      kind: "attempt.reconcile",
      idempotencyKey: randomUUID(),
      workId: failedOutcome.created.work.id,
      attemptId: failedOutcome.claimed.attempt.id,
      expectedAttemptRevision: failedOutcome.unknown.revision,
      fence: failedOutcome.claimed.attempt.fence,
      actorSessionId: failedOutcome.value.actorSessionId,
      attemptCapability: capability,
      outcome: {
        kind: "failed",
        summary: "The exact nested mutation failed before applying provider work.",
        evidence: [],
      },
    });
    if (closed.kind !== "attempt.reconcile") throw new Error("unexpected result");
    expect(closed.attempt.status).toBe("failed");
    expect(failedOutcome.value.store.effectStatus(failedOutcome.dispatchKey)?.state).toBe("failed");
  });

  test("keeps dispatch accepted when an exact provider turn later fails", () => {
    const value = fixture();
    const created = createWork(value);
    const claimed = claim(value, {
      workId: created.work.id,
      taskId: created.tasks[0]!.id,
      revision: created.tasks[0]!.revision,
    });
    const dispatchKey = randomUUID();
    const prepared = value.store.apply({
      kind: "attempt.dispatch",
      idempotencyKey: dispatchKey,
      workId: created.work.id,
      attemptId: claimed.attempt.id,
      expectedAttemptRevision: claimed.attempt.revision,
      fence: claimed.attempt.fence,
      actorSessionId: value.actorSessionId,
      attemptCapability: capability,
      targetSessionId: value.actorSessionId,
      mode: "send",
    });
    if (prepared.kind !== "attempt.dispatch") throw new Error("unexpected result");
    expect(value.store.authorizePreparedEffect(dispatchKey).executable).toBe(true);
    const receipt = turnStartedReceipt();
    value.store.finalizeDispatch(dispatchKey, { kind: "accepted", receipt });
    value.store.prepareProfileAuthorityChange(value.accountId, 1);
    const recovery = value.store.task(created.tasks[0]!.id).activeAttempt;
    if (recovery === null) throw new Error("recovery attempt missing");
    value.database.query(
      `INSERT INTO session_events(
         session_id,sequence,recorded_at,account_id,provider_generation,event_json
       ) VALUES (?,?,?,?,?,?)`,
    ).run(
      value.actorSessionId,
      1,
      value.now.value,
      value.accountId,
      receipt.accountGeneration,
      JSON.stringify({
        body: {
          type: "turn_completed",
          turnId: receipt.turnId,
          status: "failed",
        },
      }),
    );
    const reconciled = value.store.apply({
      kind: "attempt.reconcile",
      idempotencyKey: randomUUID(),
      workId: created.work.id,
      attemptId: claimed.attempt.id,
      expectedAttemptRevision: recovery.revision,
      fence: claimed.attempt.fence,
      actorSessionId: value.actorSessionId,
      attemptCapability: capability,
      outcome: {
        kind: "failed",
        summary: "The exact accepted provider turn failed.",
        evidence: [{
          kind: "turn",
          sessionId: value.actorSessionId,
          turnId: receipt.turnId,
        }],
      },
    });
    if (reconciled.kind !== "attempt.reconcile") throw new Error("unexpected result");
    expect(reconciled.attempt.status).toBe("failed");
    expect(value.store.effectStatus(dispatchKey)?.state).toBe("accepted");
    expect(value.store.snapshot(created.work.id).tasks[0]?.status).toBe("failed");
  });

  test("cancels leaf-first but keeps a dispatched attempt in recovery_required", () => {
    const value = fixture();
    const created = createWork(value, [
      taskSpec(value, "root"),
      taskSpec(value, "child", { parentRef: "root" }),
    ]);
    const actorJoined = join(
      value,
      created.work.id,
      created.work.revision,
      value.actorSessionId,
    );
    join(value, created.work.id, actorJoined.workRevision, value.reviewerSessionId);
    const root = created.tasks.find((task) => task.clientRef === "root")!;
    const child = created.tasks.find((task) => task.clientRef === "child")!;
    const rootClaim = claim(value, {
      workId: created.work.id,
      taskId: root.id,
      revision: root.revision,
    });
    const childClaim = claim(value, {
      workId: created.work.id,
      taskId: child.id,
      revision: child.revision,
      actorSessionId: value.reviewerSessionId,
    });
    const dispatchKey = randomUUID();
    value.store.apply({
      kind: "attempt.dispatch",
      idempotencyKey: dispatchKey,
      workId: created.work.id,
      attemptId: rootClaim.attempt.id,
      expectedAttemptRevision: rootClaim.attempt.revision,
      fence: rootClaim.attempt.fence,
      actorSessionId: value.actorSessionId,
      attemptCapability: capability,
      targetSessionId: value.actorSessionId,
      mode: "send",
    });
    expect(value.store.authorizePreparedEffect(dispatchKey).executable).toBe(true);
    const dispatchReceipt = turnStartedReceipt();
    value.store.finalizeDispatch(dispatchKey, {
      kind: "accepted",
      receipt: dispatchReceipt,
    });
    const cancelled = value.store.apply({
      kind: "work.cancel",
      idempotencyKey: randomUUID(),
      workId: created.work.id,
      expectedWorkRevision: value.store.snapshot(created.work.id).work.revision,
      actorSessionId: value.actorSessionId,
      coordinatorCapability: capability,
      summary: "Stop all remaining work.",
      evidence: [],
    });
    if (cancelled.kind !== "work.cancel") throw new Error("unexpected result");
    expect(cancelled.work.status).toBe("cancel_pending");
    const pendingSnapshot = value.store.snapshot(created.work.id);
    expect(pendingSnapshot.terminal).toMatchObject({
      kind: "work.cancel",
      state: "requested",
      actorSessionId: value.actorSessionId,
      summary: "Stop all remaining work.",
      result: null,
      evidence: [],
      settledAt: null,
    });
    expect(() => value.store.apply({
      kind: "work.fail",
      idempotencyKey: randomUUID(),
      workId: created.work.id,
      expectedWorkRevision: pendingSnapshot.work.revision,
      actorSessionId: value.actorSessionId,
      coordinatorCapability: capability,
      summary: "Do not override the original terminal intent.",
      evidence: [],
    })).toThrow(new WorkStoreError("WORK_NOT_ACTIVE"));
    expect(value.store.snapshot(created.work.id).terminal).toEqual(pendingSnapshot.terminal);
    const tasks = new Map(pendingSnapshot.tasks.map((task) => [task.id, task]));
    expect(tasks.get(root.id)?.status).toBe("blocked");
    expect(tasks.get(child.id)?.status).toBe("cancelled");
    const childAttempt = value.database.query(
      "SELECT state FROM work_attempts WHERE id=?",
    ).get(childClaim.attempt.id) as { state: string };
    expect(childAttempt.state).toBe("cancelled");

    const recoveryAttempt = value.store.task(root.id).activeAttempt;
    if (recoveryAttempt === null) throw new Error("recovery attempt missing");

    value.database.query(
      `INSERT INTO session_events(
         session_id,sequence,recorded_at,account_id,provider_generation,event_json
       ) VALUES (?,?,?,?,?,?)`,
    ).run(
      value.actorSessionId,
      1,
      value.now.value,
      value.accountId,
      dispatchReceipt.accountGeneration,
      JSON.stringify({
        body: {
          type: "turn_completed",
          turnId: dispatchReceipt.turnId,
          status: "completed",
        },
      }),
    );

    const reconciled = value.store.apply({
      kind: "attempt.reconcile",
      idempotencyKey: randomUUID(),
      workId: created.work.id,
      attemptId: rootClaim.attempt.id,
      expectedAttemptRevision: recoveryAttempt.revision,
      fence: rootClaim.attempt.fence,
      actorSessionId: value.actorSessionId,
      attemptCapability: capability,
      outcome: {
        kind: "completed",
        summary: "The accepted provider effect completed before cancellation settled.",
        result: { kind: "text", text: "completed" },
        evidence: [{
          kind: "turn",
          sessionId: value.actorSessionId,
          turnId: dispatchReceipt.turnId,
        }],
      },
    });
    if (reconciled.kind !== "attempt.reconcile") throw new Error("unexpected result");
    const settledSnapshot = value.store.snapshot(created.work.id);
    expect(settledSnapshot.work.status).toBe("cancelled");
    expect(settledSnapshot.terminal).toMatchObject({
      kind: "work.cancel",
      state: "settled",
      actorSessionId: value.actorSessionId,
      summary: "Stop all remaining work.",
    });
    expect(settledSnapshot.terminal?.settledAt).not.toBeNull();
    expect(reconciled.attempt.status).toBe("reconciled");
  });

  test("keeps the logical clock monotonic across a lower wall-clock restart", () => {
    const value = fixture();
    const created = createWork(value);
    const firstEvent = value.database.query(
      "SELECT recorded_at FROM work_events WHERE work_id=? ORDER BY sequence DESC LIMIT 1",
    ).get(created.work.id) as { recorded_at: number };
    const restarted = new WorkStore(value.database, {
      daemonGeneration: 8,
      now: () => 1,
      encodeCursor,
      issueCapability,
      verifyCapability,
      projectProviderIdentifier,
    });
    const joined = restarted.apply({
      kind: "work.join",
      idempotencyKey: randomUUID(),
      workId: created.work.id,
      coordinatorSessionId: value.actorSessionId,
      coordinatorCapability: capability,
      actorSessionId: value.actorSessionId,
    });
    if (joined.kind !== "work.join") throw new Error("unexpected result");
    const secondEvent = value.database.query(
      "SELECT recorded_at FROM work_events WHERE work_id=? ORDER BY sequence DESC LIMIT 1",
    ).get(created.work.id) as { recorded_at: number };
    expect(secondEvent.recorded_at).toBeGreaterThanOrEqual(firstEvent.recorded_at);
  });
});
