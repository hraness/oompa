import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import {
  createProfileId,
  createProjectId,
  createQueueId,
  createSessionId,
  type ProfileId,
  type SessionId,
} from "../domain/values";
import {
  SESSION_TASK_LIMIT,
  SESSION_TASK_MAX_INTERVAL_MINUTES,
} from "../domain/session-tasks";
import {
  SESSION_TASK_SCHEMA_SQL,
  SessionTaskStore,
  SessionTaskStoreError,
  assertSessionTaskSchema,
  type SessionTaskQueueRecord,
  type SessionTaskExecutionAuthority,
  type SessionTaskStoreErrorCode,
} from "./session-task-store";

const databases: Database[] = [];
const codexAccountKey = `v1:codex:${"a".repeat(64)}`;
const claudeAccountKey = `v1:claude:${"b".repeat(64)}`;

afterEach(() => {
  for (const database of databases.splice(0)) database.close(false);
});

const parentSchema = `
CREATE TABLE daemon_state (
  singleton INTEGER PRIMARY KEY,
  generation INTEGER NOT NULL
) STRICT;
INSERT INTO daemon_state(singleton,generation) VALUES (1,7);
CREATE TABLE profiles (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  process_generation INTEGER NOT NULL,
  provider_email TEXT,
  codex_account_key TEXT DEFAULT '${codexAccountKey}'
) STRICT;
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  root_path TEXT NOT NULL
) STRICT;
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  project_id TEXT REFERENCES projects(id),
  provider TEXT NOT NULL DEFAULT 'codex',
  provider_v39 TEXT NOT NULL DEFAULT 'codex',
  provider_thread_id TEXT,
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
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
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
CREATE TABLE session_account_authorities (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  account_key TEXT,
  recorded_at INTEGER NOT NULL
) STRICT;
CREATE TABLE provider_runtime_account_revocations (
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  profile_generation INTEGER NOT NULL,
  provider TEXT NOT NULL,
  runtime_scope TEXT NOT NULL,
  current_account_key TEXT,
  state TEXT NOT NULL,
  PRIMARY KEY(profile_id,provider,runtime_scope)
) STRICT;
CREATE TABLE session_provider_account_authorities (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  runtime_scope TEXT NOT NULL,
  account_key TEXT NOT NULL,
  recorded_at INTEGER NOT NULL
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
  SELECT NEW.id,NEW.provider_v39,'managed',p.codex_account_key,0
  FROM profiles p
  WHERE p.id=NEW.profile_id AND p.codex_account_key IS NOT NULL;
END;
CREATE TABLE session_personal_runtime_bindings (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_thread_id TEXT NOT NULL,
  state TEXT NOT NULL
) STRICT;
CREATE TABLE queue_sequence_authority (
  singleton INTEGER PRIMARY KEY,
  next_sequence INTEGER NOT NULL
) STRICT;
INSERT INTO queue_sequence_authority(singleton,next_sequence) VALUES (1,1);
CREATE TABLE queue_entries (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  message TEXT NOT NULL,
  state TEXT NOT NULL,
  enqueue_sequence INTEGER NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE TABLE session_switch_attempts (
  journal_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  attempt_id TEXT,
  request_key TEXT,
  request_digest TEXT,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  phase TEXT NOT NULL,
  original_session_revision INTEGER,
  original_authority_revision INTEGER,
  source_preset TEXT,
  target_preset TEXT,
  source_preset_contract INTEGER,
  target_preset_contract INTEGER,
  stream_epoch TEXT,
  transcript_digest TEXT,
  seed_digest TEXT,
  seed_omitted_records INTEGER,
  seed_client_message_id TEXT,
  source_provider_thread_id TEXT,
  after_sequence_exclusive INTEGER,
  source_provider_account_id TEXT,
  source_profile_id TEXT,
  source_provider TEXT,
  source_binding_generation INTEGER,
  source_process_generation INTEGER,
  target_provider_account_id TEXT,
  target_profile_id TEXT,
  target_provider TEXT,
  target_binding_generation INTEGER,
  target_process_generation INTEGER
) STRICT;
CREATE TABLE session_switch_malformed_dispositions (
  journal_sequence INTEGER PRIMARY KEY REFERENCES session_switch_attempts(journal_sequence),
  mutation_request_key TEXT,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  terminal_phase TEXT NOT NULL
) STRICT;
CREATE TABLE mutation_attempts (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT,
  request_digest TEXT
) STRICT;
CREATE TABLE mutation_provider_authorities (
  attempt_id TEXT NOT NULL REFERENCES mutation_attempts(id),
  role TEXT NOT NULL,
  provider_account_id TEXT,
  profile_id TEXT,
  provider TEXT,
  binding_generation INTEGER,
  process_generation INTEGER,
  PRIMARY KEY(attempt_id,role)
) STRICT;
CREATE TABLE session_switch_plan_anchors (
  attempt_id TEXT PRIMARY KEY,
  source_provider_thread_id TEXT
) STRICT;
`;

let uuidSequence = 0;
const idempotencyKey = (): string =>
  `123e4567-e89b-42d3-a456-${(++uuidSequence).toString(16).padStart(12, "0")}`;

type Fixture = Readonly<{
  accountId: ProfileId;
  database: Database;
  now: { value: number };
  otherSessionId: SessionId;
  sessionId: SessionId;
  store: SessionTaskStore;
  enqueueCalls: Readonly<{ sessionId: SessionId; message: string; inTransaction: boolean }>[];
}>;

function fixture(input: Readonly<{
  isExecutionAuthorityLive?: (authority: SessionTaskExecutionAuthority) => boolean;
  resolveProjectDirectory?: (root: string) => Promise<string | null>;
  enqueue?: false;
  afterEnqueue?: (queue: SessionTaskQueueRecord) => SessionTaskQueueRecord;
}> = {}): Fixture {
  const database = new Database(":memory:", { strict: true });
  databases.push(database);
  database.exec("PRAGMA foreign_keys=ON;");
  database.exec(parentSchema);
  database.exec(SESSION_TASK_SCHEMA_SQL);
  assertSessionTaskSchema(database);
  const accountId = createProfileId();
  const projectId = createProjectId();
  const sessionId = createSessionId();
  const otherSessionId = createSessionId();
  database.query(
    `INSERT INTO profiles(id,state,process_generation,provider_email)
     VALUES (?,'signed_in',1,'scheduler@example.com')`,
  ).run(accountId);
  database.query("INSERT INTO projects(id,root_path) VALUES (?,?)").run(projectId, "/project");
  for (const id of [sessionId, otherSessionId]) {
    database.query(
      `INSERT INTO sessions(id,profile_id,project_id,provider_thread_id,state)
       VALUES (?,?,? ,?,'idle')`,
    ).run(id, accountId, projectId, `thread-${id}`);
  }
  const now = { value: 1_000 };
  const enqueueCalls: Fixture["enqueueCalls"] = [];
  // The leaf suite supplies an explicit synchronous queue-writer double.
  // StateStore integration separately proves the real callback's sealed owner.
  const enqueue = (sessionId: SessionId, message: string): SessionTaskQueueRecord => {
    enqueueCalls.push({ sessionId, message, inTransaction: database.inTransaction });
    const allocated = database.query(`UPDATE queue_sequence_authority
      SET next_sequence=next_sequence+1 WHERE singleton=1 AND next_sequence<9007199254740991
      RETURNING next_sequence-1 AS sequence`).get() as { sequence: number } | null;
    if (allocated === null) throw new Error("QUEUE_SEQUENCE_EXHAUSTED");
    const queue: SessionTaskQueueRecord = { id: createQueueId(), sessionId, message, state: "pending",
      createdAt: now.value, updatedAt: now.value };
    database.query(`INSERT INTO queue_entries(id,session_id,message,state,enqueue_sequence,created_at,updated_at)
      VALUES (?,?,?,'pending',?,?,?)`).run(queue.id, sessionId, message, allocated.sequence, queue.createdAt, queue.updatedAt);
    return input.afterEnqueue?.(queue) ?? queue;
  };
  const options = {
    now: () => now.value,
    ...(input.isExecutionAuthorityLive === undefined
      ? {}
      : { isExecutionAuthorityLive: input.isExecutionAuthorityLive }),
    resolveProjectDirectory: input.resolveProjectDirectory ?? (async (root) => root),
    ...(input.enqueue === false ? {} : { enqueue }),
  };
  const store = new SessionTaskStore(database, options);
  return { accountId, database, now, otherSessionId, sessionId, store, enqueueCalls };
}

const createTask = (
  value: Fixture,
  input: Readonly<{
    idempotencyKey?: string;
    name?: string;
    prompt?: string;
    status?: "active" | "paused";
  }> = {},
) => value.store.create({
  sessionId: value.sessionId,
  name: input.name ?? "Conversation review",
  prompt: input.prompt ?? "Review this conversation.",
  minutes: 15,
  status: input.status ?? "active",
  idempotencyKey: input.idempotencyKey ?? idempotencyKey(),
});

const adoptPersonalClaudeSession = (
  value: Fixture,
  bindingState: "active" | "detaching" | "detached" = "active",
): void => {
  value.database.query(
    "UPDATE profiles SET state='signed_out',provider_email=NULL,codex_account_key=NULL WHERE id=?",
  ).run(value.accountId);
  value.database.query("UPDATE sessions SET provider='claude',provider_v39='claude' WHERE id=?")
    .run(value.sessionId);
  value.database.query(
    "DELETE FROM session_provider_account_authorities WHERE session_id=?",
  ).run(value.sessionId);
  value.database.query(
    `INSERT INTO session_provider_account_authorities(
       session_id,provider,runtime_scope,account_key,recorded_at
     ) VALUES (?,'claude','personal',?,0)`,
  ).run(value.sessionId, claudeAccountKey);
  value.database.query(
    `INSERT INTO session_personal_runtime_bindings(
       session_id,provider,provider_thread_id,state
     ) SELECT id,provider,provider_thread_id,?
       FROM sessions WHERE id=?`,
  ).run(bindingState, value.sessionId);
};

const expectStoreCode = (
  callback: () => unknown,
  code: SessionTaskStoreErrorCode,
): void => {
  try {
    callback();
    throw new Error("Expected SessionTaskStoreError.");
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(SessionTaskStoreError);
    expect((error as SessionTaskStoreError).code).toBe(code);
  }
};

describe("SessionTaskStore schema authority", () => {
  const databaseWithSchema = (schema: string): Database => {
    const database = new Database(":memory:", { strict: true });
    databases.push(database);
    database.exec("PRAGMA foreign_keys=ON;");
    database.exec(parentSchema);
    database.exec(schema);
    return database;
  };

  test("session task schema audit preserves IF NOT EXISTS inside a digest GLOB", () => {
    const original = "*[^0-9a-f]*";
    const altered = "*[IF NOT EXISTS^0-9a-f]*";
    const database = databaseWithSchema(SESSION_TASK_SCHEMA_SQL.replace(original, altered));
    expect(database.query("SELECT ?1 NOT GLOB ?2 AS valid, ?1 NOT GLOB ?3 AS weakened")
      .get("g".repeat(64), original, altered)).toEqual({ valid: 0, weakened: 1 });
    const before = database.query("SELECT type,name,sql FROM sqlite_master ORDER BY name").all();
    const changes = database.query("SELECT total_changes() AS count").get();
    expect(() => assertSessionTaskSchema(database)).toThrow("STATE_SESSION_TASK_SCHEMA_INVALID");
    expect(database.query("SELECT type,name,sql FROM sqlite_master ORDER BY name").all()).toEqual(before);
    expect(database.query("SELECT total_changes() AS count").get()).toEqual(changes);
  });

  test("rejects wrong object types, non-STRICT tables, foreign-key drift, and invariant drift", () => {
    const wrongType = databaseWithSchema(SESSION_TASK_SCHEMA_SQL);
    wrongType.exec(`
      DROP INDEX session_tasks_due;
      CREATE TABLE session_tasks_due (value INTEGER) STRICT;
    `);
    expect(() => assertSessionTaskSchema(wrongType)).toThrow(
      "STATE_SESSION_TASK_SCHEMA_INVALID",
    );

    const nonStrict = databaseWithSchema(SESSION_TASK_SCHEMA_SQL.replace(
      ") STRICT;\nCREATE TABLE IF NOT EXISTS session_tasks",
      ");\nCREATE TABLE IF NOT EXISTS session_tasks",
    ));
    expect(() => assertSessionTaskSchema(nonStrict)).toThrow(
      "STATE_SESSION_TASK_SCHEMA_INVALID",
    );

    const foreignKeyDrift = databaseWithSchema(SESSION_TASK_SCHEMA_SQL.replace(
      "session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,",
      "session_id TEXT PRIMARY KEY REFERENCES sessions(id),",
    ));
    expect(() => assertSessionTaskSchema(foreignKeyDrift)).toThrow(
      "STATE_SESSION_TASK_SCHEMA_INVALID",
    );

    const invariantDrift = databaseWithSchema(SESSION_TASK_SCHEMA_SQL.replace(
      "BEGIN SELECT RAISE(ABORT,'SESSION_TASK_LIMIT'); END;",
      "BEGIN SELECT RAISE(ABORT,'SESSION_TASK_LIMIT_TAMPERED'); END;",
    ));
    expect(() => assertSessionTaskSchema(invariantDrift)).toThrow(
      "STATE_SESSION_TASK_SCHEMA_INVALID",
    );
  });
});

describe("SessionTaskStore mutation authority", () => {
  test("cascades list receipts when their conversation is removed", () => {
    const value = fixture();
    const key = idempotencyKey();
    value.store.listIdempotent(value.sessionId, key, "0".repeat(64));
    expect(value.database.query(
      "SELECT COUNT(*) AS count FROM session_task_receipts WHERE session_id=?",
    ).get(value.sessionId)).toEqual({ count: 1 });

    value.database.query("DELETE FROM sessions WHERE id=?").run(value.sessionId);

    expect(value.database.query(
      "SELECT COUNT(*) AS count FROM session_task_receipts WHERE session_id=?",
    ).get(value.sessionId)).toEqual({ count: 0 });
  });

  test("replays immutable list and view snapshots and globally fences receipt keys", () => {
    const value = fixture();
    const created = createTask(value);
    const listKey = idempotencyKey();
    const listDigest = "1".repeat(64);
    const listed = value.store.listIdempotent(
      value.sessionId,
      listKey,
      listDigest,
    );

    value.now.value = 2_000;
    const edited = value.store.edit({
      sessionId: value.sessionId,
      taskId: created.id,
      expectedRevision: 1,
      patch: { name: "Updated after list" },
      idempotencyKey: idempotencyKey(),
    });
    expect(value.store.listIdempotent(
      value.sessionId,
      listKey,
      listDigest,
    )).toEqual(listed);
    expect(listed.tasks[0]).toMatchObject({
      id: created.id,
      name: "Conversation review",
      revision: 1,
    });
    expect(value.store.list(value.sessionId)[0]).toMatchObject({
      id: created.id,
      name: "Updated after list",
      revision: 2,
    });

    const beforeCrossMode = value.store.require(value.sessionId, created.id);
    expectStoreCode(() => value.store.requireIdempotent(
      value.sessionId,
      created.id,
      listKey,
      listDigest,
    ), "IDEMPOTENCY_CONFLICT");
    expectStoreCode(() => value.store.listIdempotent(
      value.otherSessionId,
      listKey,
      "3".repeat(64),
    ), "IDEMPOTENCY_CONFLICT");
    expectStoreCode(() => value.store.create({
      sessionId: value.sessionId,
      name: "Must not be created",
      prompt: "A cross-mode receipt replay cannot mutate state.",
      minutes: 15,
      status: "active",
      idempotencyKey: listKey,
      receiptDigest: listDigest,
    }), "IDEMPOTENCY_CONFLICT");
    expect(value.store.require(value.sessionId, created.id)).toEqual(beforeCrossMode);
    expect(value.store.list(value.sessionId)).toHaveLength(1);

    const viewKey = idempotencyKey();
    const viewDigest = "2".repeat(64);
    const viewed = value.store.requireIdempotent(
      value.sessionId,
      created.id,
      viewKey,
      viewDigest,
    );
    value.now.value = 3_000;
    const editedAgain = value.store.edit({
      sessionId: value.sessionId,
      taskId: created.id,
      expectedRevision: edited.revision,
      patch: { prompt: "Updated after view" },
      idempotencyKey: idempotencyKey(),
    });
    expect(value.store.requireIdempotent(
      value.sessionId,
      created.id,
      viewKey,
      viewDigest,
    )).toEqual(viewed);
    expect(viewed).toMatchObject({
      id: created.id,
      prompt: "Review this conversation.",
      revision: 2,
    });
    expectStoreCode(() => value.store.listIdempotent(
      value.sessionId,
      viewKey,
      viewDigest,
    ), "IDEMPOTENCY_CONFLICT");
    expect(value.store.require(value.sessionId, created.id)).toEqual(editedAgain);
    expect(value.database.query(
      `SELECT operation,request_digest
       FROM session_task_receipts
       WHERE idempotency_key IN (?,?)
       ORDER BY operation`,
    ).all(listKey, viewKey)).toEqual([
      {
        operation: "list",
        request_digest: listDigest,
      },
      {
        operation: "view",
        request_digest: viewDigest,
      },
    ]);
  });

  test("fences same-operation digest and task drift while replaying a deleted task snapshot", () => {
    const value = fixture();
    const first = createTask(value, { name: "First task" });
    const second = createTask(value, { name: "Second task" });
    const listKey = idempotencyKey();
    value.store.listIdempotent(value.sessionId, listKey, "4".repeat(64));
    expectStoreCode(() => value.store.listIdempotent(
      value.sessionId,
      listKey,
      "5".repeat(64),
    ), "IDEMPOTENCY_CONFLICT");

    const viewKey = idempotencyKey();
    const digest = "6".repeat(64);
    const viewed = value.store.requireIdempotent(
      value.sessionId,
      first.id,
      viewKey,
      digest,
    );
    expectStoreCode(() => value.store.requireIdempotent(
      value.sessionId,
      second.id,
      viewKey,
      digest,
    ), "IDEMPOTENCY_CONFLICT");

    value.now.value = 2_000;
    value.store.delete({
      sessionId: value.sessionId,
      taskId: first.id,
      expectedRevision: first.revision,
      idempotencyKey: idempotencyKey(),
    });
    expect(value.store.requireIdempotent(
      value.sessionId,
      first.id,
      viewKey,
      digest,
    )).toEqual(viewed);
    expectStoreCode(() => value.store.require(value.sessionId, first.id), "NOT_FOUND");
  });

  test("fails closed on noncanonical or authority-mismatched stored read snapshots", () => {
    const value = fixture();
    const noncanonicalKey = idempotencyKey();
    const noncanonicalDigest = "7".repeat(64);
    const noncanonical = JSON.stringify({
      scope: "conversation",
      sessionId: value.sessionId,
      tasks: [],
    }, null, 1);
    value.database.query(
      `INSERT INTO session_task_receipts(
         idempotency_key,request_digest,operation,session_id,task_id,
         result_revision,result_updated_at,result_next_due_at,result_deleted_at,
         result_json,created_at
       ) VALUES (?,?,'list',?,NULL,NULL,NULL,NULL,NULL,?,?)`,
    ).run(
      noncanonicalKey,
      noncanonicalDigest,
      value.sessionId,
      noncanonical,
      value.now.value,
    );
    expect(() => value.store.listIdempotent(
      value.sessionId,
      noncanonicalKey,
      noncanonicalDigest,
    )).toThrow("SESSION_TASK_LIST_RECEIPT_INVALID");

    const mismatchedKey = idempotencyKey();
    const mismatchedDigest = "8".repeat(64);
    value.database.query(
      `INSERT INTO session_task_receipts(
         idempotency_key,request_digest,operation,session_id,task_id,
         result_revision,result_updated_at,result_next_due_at,result_deleted_at,
         result_json,created_at
       ) VALUES (?,?,'list',?,NULL,NULL,NULL,NULL,NULL,?,?)`,
    ).run(
      mismatchedKey,
      mismatchedDigest,
      value.sessionId,
      JSON.stringify({
        scope: "conversation",
        sessionId: value.otherSessionId,
        tasks: [],
      }),
      value.now.value,
    );
    expect(() => value.store.listIdempotent(
      value.sessionId,
      mismatchedKey,
      mismatchedDigest,
    )).toThrow("SESSION_TASK_LIST_RECEIPT_INVALID");
    expect(() => value.database.query(
      "UPDATE session_task_receipts SET created_at=created_at+1 WHERE idempotency_key=?",
    ).run(mismatchedKey)).toThrow("SESSION_TASK_RECEIPT_IMMUTABLE");
  });

  test("rejects a changed dynamic digest for normalization-equivalent create input", () => {
    const value = fixture();
    const key = idempotencyKey();
    const originalDigest = "a".repeat(64);
    const changedDigest = "b".repeat(64);
    const created = value.store.create({
      sessionId: value.sessionId,
      name: "Canonical name",
      prompt: "Canonical prompt",
      minutes: 15,
      status: "active",
      idempotencyKey: key,
      receiptDigest: originalDigest,
    });

    expectStoreCode(() => value.store.create({
      sessionId: value.sessionId,
      name: "  Canonical name  ",
      prompt: "  Canonical prompt  ",
      minutes: 15,
      status: "active",
      idempotencyKey: key,
      receiptDigest: changedDigest,
    }), "IDEMPOTENCY_CONFLICT");
    expect(value.store.require(value.sessionId, created.id)).toEqual(created);
    expect(value.store.list(value.sessionId)).toHaveLength(1);
    expect(value.database.query(
      `SELECT request_digest,operation
       FROM session_task_receipts WHERE idempotency_key=?`,
    ).get(key)).toEqual({
      request_digest: originalDigest,
      operation: "create",
    });
  });

  test("replays lost create, edit, and delete responses and rejects changed key reuse", () => {
    const value = fixture();
    const createKey = idempotencyKey();
    const created = createTask(value, { idempotencyKey: createKey });
    expect(createTask(value, { idempotencyKey: createKey })).toEqual(created);
    expect(value.store.list(value.sessionId)).toHaveLength(1);
    expectStoreCode(() => createTask(value, {
      idempotencyKey: createKey,
      prompt: "Changed reuse must fail.",
    }), "IDEMPOTENCY_CONFLICT");
    expect(value.store.require(value.sessionId, created.id).prompt).toBe("Review this conversation.");

    value.now.value = 2_000;
    const editKey = idempotencyKey();
    const edited = value.store.edit({
      sessionId: value.sessionId,
      taskId: created.id,
      expectedRevision: 1,
      patch: { name: "Updated review" },
      idempotencyKey: editKey,
    });
    expect(createTask(value, { idempotencyKey: createKey })).toEqual(created);
    expect(value.store.edit({
      sessionId: value.sessionId,
      taskId: created.id,
      expectedRevision: 1,
      patch: { name: "Updated review" },
      idempotencyKey: editKey,
    })).toEqual(edited);
    expectStoreCode(() => value.store.edit({
      sessionId: value.sessionId,
      taskId: created.id,
      expectedRevision: 2,
      patch: { name: "Changed reuse" },
      idempotencyKey: editKey,
    }), "IDEMPOTENCY_CONFLICT");

    value.now.value = 3_000;
    const deleteKey = idempotencyKey();
    const deleted = value.store.delete({
      sessionId: value.sessionId,
      taskId: created.id,
      expectedRevision: 2,
      idempotencyKey: deleteKey,
    });
    expect(value.store.delete({
      sessionId: value.sessionId,
      taskId: created.id,
      expectedRevision: 2,
      idempotencyKey: deleteKey,
    })).toEqual(deleted);
    expect(createTask(value, { idempotencyKey: createKey })).toEqual(created);
    expect(value.store.edit({
      sessionId: value.sessionId,
      taskId: created.id,
      expectedRevision: 1,
      patch: { name: "Updated review" },
      idempotencyKey: editKey,
    })).toEqual(edited);
    expect(value.store.list(value.sessionId)).toEqual([]);
    expectStoreCode(
      () => value.store.require(value.sessionId, created.id),
      "NOT_FOUND",
    );
  });

  test("fences cross-session IDs, stale revisions, no-op edits, and the per-session quota", () => {
    const value = fixture();
    const smuggledCreate = {
      sessionId: value.sessionId,
      name: "Standalone smuggling",
      prompt: "Must fail.",
      minutes: 15,
      status: "active" as const,
      idempotencyKey: idempotencyKey(),
      destination: "local",
    };
    expect(() => value.store.create(smuggledCreate)).toThrow();
    const created = createTask(value);
    expectStoreCode(
      () => value.store.require(value.otherSessionId, created.id),
      "NOT_FOUND",
    );
    expectStoreCode(() => value.store.edit({
      sessionId: value.otherSessionId,
      taskId: created.id,
      expectedRevision: 1,
      patch: { name: "Cross-session" },
      idempotencyKey: idempotencyKey(),
    }), "NOT_FOUND");
    expectStoreCode(() => value.store.edit({
      sessionId: value.sessionId,
      taskId: created.id,
      expectedRevision: 2,
      patch: { name: "Stale" },
      idempotencyKey: idempotencyKey(),
    }), "REVISION_CONFLICT");
    expectStoreCode(() => value.store.edit({
      sessionId: value.sessionId,
      taskId: created.id,
      expectedRevision: 1,
      patch: { name: created.name },
      idempotencyKey: idempotencyKey(),
    }), "NO_CHANGES");

    for (let index = 1; index < SESSION_TASK_LIMIT; index += 1) {
      createTask(value, { name: `Task ${String(index)}`, status: "paused" });
    }
    expectStoreCode(
      () => createTask(value, { name: "Overflow", status: "paused" }),
      "TASK_LIMIT",
    );
    value.store.delete({
      sessionId: value.sessionId,
      taskId: created.id,
      expectedRevision: 1,
      idempotencyKey: idempotencyKey(),
    });
    expect(() => createTask(value, { name: "Replacement", status: "paused" })).not.toThrow();
  });

  test("anchors resume and active interval edits while preserving due time for prompt edits", () => {
    const value = fixture();
    const created = createTask(value);
    expect(created.nextDueAt).toBe(901_000);
    value.now.value = 2_000;
    const promptEdited = value.store.edit({
      sessionId: value.sessionId,
      taskId: created.id,
      expectedRevision: 1,
      patch: { prompt: "Replacement prompt" },
      idempotencyKey: idempotencyKey(),
    });
    expect(promptEdited.nextDueAt).toBe(901_000);
    value.now.value = 3_000;
    const paused = value.store.edit({
      sessionId: value.sessionId,
      taskId: created.id,
      expectedRevision: 2,
      patch: { status: "paused" },
      idempotencyKey: idempotencyKey(),
    });
    expect(paused.nextDueAt).toBeNull();
    value.now.value = 4_000;
    const resumed = value.store.edit({
      sessionId: value.sessionId,
      taskId: created.id,
      expectedRevision: 3,
      patch: { status: "active" },
      idempotencyKey: idempotencyKey(),
    });
    expect(resumed.nextDueAt).toBe(904_000);
    value.now.value = 5_000;
    const rescheduled = value.store.edit({
      sessionId: value.sessionId,
      taskId: created.id,
      expectedRevision: 4,
      patch: { minutes: SESSION_TASK_MAX_INTERVAL_MINUTES },
      idempotencyKey: idempotencyKey(),
    });
    expect(rescheduled.nextDueAt).toBe(604_805_000);
  });
});

describe("SessionTaskStore due materialization", () => {
  test("materialization requires a queue owner while leaf reads and edits remain available", async () => {
    let projectReads = 0;
    const value = fixture({ enqueue: false, resolveProjectDirectory: async (root) => {
      projectReads += 1;
      return root;
    } });
    const created = createTask(value);
    const edited = value.store.edit({ sessionId: value.sessionId, taskId: created.id, expectedRevision: created.revision,
      patch: { name: "Read and edit without execution authority" }, idempotencyKey: idempotencyKey() });
    expect(value.store.require(value.sessionId, created.id)).toEqual(edited);
    await expect(value.store.materializeDue({ now: edited.nextDueAt ?? 0 })).rejects.toThrow("SESSION_TASK_ENQUEUE_UNAVAILABLE");
    expect(projectReads).toBe(0);
    expect(value.database.query("SELECT * FROM queue_entries").all()).toEqual([]);
    expect(value.store.listOccurrences(value.sessionId, created.id)).toEqual([]);
    expect(value.store.require(value.sessionId, created.id)).toEqual(edited);
  });

  test("materialization calls the queue owner once inside the transaction and retains its id and timestamps", async () => {
    const value = fixture();
    const created = createTask(value, { prompt: "Keep this exact task prompt.\n" });
    value.now.value = 910_123;
    const result = await value.store.materializeDue({ now: created.nextDueAt ?? 0, daemonGeneration: 7 });
    expect(value.enqueueCalls).toEqual([{ sessionId: value.sessionId, message: created.prompt, inTransaction: true }]);
    const item = result[0];
    if (item === undefined) throw new Error("Missing callback materialization.");
    expect(item.queue).toMatchObject({ createdAt: value.now.value, updatedAt: value.now.value });
    expect(item.occurrence).toMatchObject({ queueId: item.queue.id, createdAt: value.now.value });
    expect(value.database.query("SELECT id,created_at,updated_at FROM queue_entries").all())
      .toEqual([{ id: item.queue.id, created_at: value.now.value, updated_at: value.now.value }]);
    expect(await value.store.materializeDue({ now: (created.nextDueAt ?? 0) + 900_000 })).toEqual([]);
    expect(value.enqueueCalls).toHaveLength(1);
  });

  test("queue owner failure rolls back its allocation and retries the unchanged due slot", async () => {
    let refuse = true;
    const value = fixture({ afterEnqueue: (queue) => {
      if (refuse) throw new Error("injected queue owner failure");
      return queue;
    } });
    const created = createTask(value);
    const sequence = value.database.query("SELECT * FROM queue_sequence_authority").get();
    await expect(value.store.materializeDue({ now: created.nextDueAt ?? 0 })).rejects.toThrow("injected queue owner failure");
    expect(value.database.query("SELECT * FROM queue_entries").all()).toEqual([]);
    expect(value.database.query("SELECT * FROM queue_sequence_authority").get()).toEqual(sequence);
    expect(value.store.listOccurrences(value.sessionId, created.id)).toEqual([]);
    expect(value.store.require(value.sessionId, created.id)).toEqual(created);
    refuse = false;
    expect(await value.store.materializeDue({ now: created.nextDueAt ?? 0 })).toHaveLength(1);
    expect(value.enqueueCalls).toHaveLength(2);
  });

  test.each(["queue id", "session", "message", "timestamp"] as const)("refuses a queue owner result with a different durable %s", async (field) => {
    const value = fixture({ afterEnqueue: (queue) => {
      switch (field) {
        case "queue id": return { ...queue, id: createQueueId() };
        case "session": return { ...queue, sessionId: createSessionId() };
        case "message": return { ...queue, message: "A different queue body." };
        case "timestamp": return { ...queue, createdAt: queue.createdAt + 1 };
      }
    } });
    const created = createTask(value);
    const sequence = value.database.query("SELECT * FROM queue_sequence_authority").get();
    await expect(value.store.materializeDue({ now: created.nextDueAt ?? 0 })).rejects.toThrow("SESSION_TASK_ENQUEUE_INVALID");
    expect(value.enqueueCalls).toHaveLength(1);
    expect(value.database.query("SELECT * FROM queue_entries").all()).toEqual([]);
    expect(value.database.query("SELECT * FROM queue_sequence_authority").get()).toEqual(sequence);
    expect(value.store.listOccurrences(value.sessionId, created.id)).toEqual([]);
    expect(value.store.require(value.sessionId, created.id)).toEqual(created);
  });

  test("excludes open and reconciled provider switches at both due-scan boundaries", async () => {
    const blocked = fixture();
    const blockedTask = createTask(blocked);
    blocked.database.query(
      "INSERT INTO session_switch_attempts(session_id,phase) VALUES (?,'prepared')",
    ).run(blocked.sessionId);
    expect(blocked.store.nextDueAt()).toBeNull();
    expect(await blocked.store.materializeDue({ now: blockedTask.nextDueAt ?? 0 })).toEqual([]);
    expect(blocked.database.query("SELECT COUNT(*) AS count FROM queue_entries").get())
      .toEqual({ count: 0 });

    const raceReference: { value?: Fixture } = {};
    const raced = fixture({
      resolveProjectDirectory: async (root) => {
        const value = raceReference.value;
        if (value === undefined) throw new Error("Missing provider-switch race fixture.");
        value.database.query(
          "INSERT INTO session_switch_attempts(session_id,phase) VALUES (?,'reconciliation_required')",
        ).run(value.sessionId);
        return root;
      },
    });
    raceReference.value = raced;
    const racedTask = createTask(raced);
    expect(await raced.store.materializeDue({ now: racedTask.nextDueAt ?? 0 })).toEqual([]);
    expect(raced.database.query("SELECT COUNT(*) AS count FROM session_task_occurrences").get())
      .toEqual({ count: 0 });
    expect(raced.database.query("SELECT COUNT(*) AS count FROM queue_entries").get())
      .toEqual({ count: 0 });
  });

  test("excludes malformed terminal switches while valid terminal histories remain schedulable", async () => {
    for (const phase of ["failed", "seed_settled", "cancelled", "abandoned"]) {
      const value = fixture();
      const task = createTask(value);
      const journal = value.database.query(
        `INSERT INTO session_switch_attempts(session_id,phase) VALUES (?,?)
         RETURNING journal_sequence`,
      ).get(value.sessionId, phase) as { journal_sequence: number };
      expect(value.store.nextDueAt()).toBe(task.nextDueAt);
      value.database.query(
        `INSERT INTO session_switch_malformed_dispositions(journal_sequence,session_id,terminal_phase)
         VALUES (?,?,'reconciliation_required')`,
      ).run(journal.journal_sequence, value.sessionId);
      value.database.query(
        "UPDATE session_switch_attempts SET session_id=? WHERE journal_sequence=?",
      ).run(value.otherSessionId, journal.journal_sequence);
      expect(value.store.nextDueAt()).toBeNull();
      expect(await value.store.materializeDue({ now: task.nextDueAt ?? 0 })).toEqual([]);
      expect(value.database.query("SELECT COUNT(*) AS count FROM queue_entries").get())
        .toEqual({ count: 0 });
    }

    const raceReference: { value?: Fixture } = {};
    const raced = fixture({
      resolveProjectDirectory: async (root) => {
        const value = raceReference.value;
        if (value === undefined) throw new Error("Missing terminal-switch race fixture.");
        value.database.query(
          `INSERT INTO session_switch_malformed_dispositions(journal_sequence,session_id,terminal_phase)
           SELECT journal_sequence,session_id,'reconciliation_required' FROM session_switch_attempts
           WHERE session_id=?`,
        ).run(value.sessionId);
        return root;
      },
    });
    raceReference.value = raced;
    const task = createTask(raced);
    raced.database.query(
      "INSERT INTO session_switch_attempts(session_id,phase) VALUES (?,'cancelled')",
    ).run(raced.sessionId);
    expect(await raced.store.materializeDue({ now: task.nextDueAt ?? 0 })).toEqual([]);
    expect(raced.database.query("SELECT COUNT(*) AS count FROM session_task_occurrences").get())
      .toEqual({ count: 0 });
    expect(raced.database.query("SELECT COUNT(*) AS count FROM queue_entries").get())
      .toEqual({ count: 0 });
  });


  test("retains an inert managed Devin task while its durable provider account is signed out", async () => {
    const value = fixture();
    const created = createTask(value, {
      name: "Managed Devin follow-up",
      prompt: "Continue the native Devin conversation.",
    });
    value.database.query(
      "UPDATE profiles SET state='signed_out',provider_email=NULL,codex_account_key=NULL WHERE id=?",
    ).run(value.accountId);
    value.database.query(
      "UPDATE provider_accounts SET readiness='signed_out' WHERE profile_id=? AND provider='devin'",
    ).run(value.accountId);
    value.database.query(
      "UPDATE sessions SET provider='codex',provider_v39='devin' WHERE id=?",
    ).run(value.sessionId);
    value.database.query(
      "DELETE FROM session_provider_account_authorities WHERE session_id=?",
    ).run(value.sessionId);
    const dueAt = created.nextDueAt ?? 0;

    expect(value.store.nextDueAt()).toBeNull();
    expect(await value.store.materializeDue({ now: dueAt })).toEqual([]);
    expect(value.store.listOccurrences(value.sessionId, created.id)).toEqual([]);
    expect(value.store.require(value.sessionId, created.id)).toEqual(created);
    expect(value.database.query("SELECT * FROM queue_entries").all()).toEqual([]);
  });

  test("materializes a managed Devin task once while its durable profile is signed out", async () => {
    const value = fixture({
      isExecutionAuthorityLive: (authority) => authority.provider === "devin",
    });
    value.database.query(
      "UPDATE profiles SET state='signed_out',provider_email=NULL,codex_account_key=NULL WHERE id=?",
    ).run(value.accountId);
    value.database.query(
      "UPDATE sessions SET provider='codex',provider_v39='devin' WHERE id=?",
    ).run(value.sessionId);
    value.database.query(
      "DELETE FROM session_provider_account_authorities WHERE session_id=?",
    ).run(value.sessionId);
    const created = createTask(value, {
      name: "Managed Devin follow-up",
      prompt: "Continue the native Devin conversation.",
    });
    const dueAt = created.nextDueAt ?? 0;

    expect(value.store.nextDueAt()).toBe(dueAt);
    expect(await value.store.materializeDue({ now: dueAt })).toMatchObject([{
      task: { id: created.id, sessionId: value.sessionId },
      occurrence: { taskId: created.id, sessionId: value.sessionId },
      queue: {
        message: "Continue the native Devin conversation.",
        sessionId: value.sessionId,
        state: "pending",
      },
    }]);
    expect(await value.store.materializeDue({ now: dueAt })).toEqual([]);
    expect(value.store.listOccurrences(value.sessionId, created.id)).toHaveLength(1);
  });

  test("materializes an adopted personal Claude task while its profile is signed out", async () => {
    const value = fixture({
      isExecutionAuthorityLive: (authority) => authority.provider === "claude",
    });
    adoptPersonalClaudeSession(value);
    const created = createTask(value, {
      name: "Personal Claude follow-up",
      prompt: "Continue the adopted Claude conversation.",
    });
    const dueAt = created.nextDueAt ?? 0;

    expect(value.store.nextDueAt()).toBe(dueAt);
    expect(await value.store.materializeDue({ now: dueAt })).toMatchObject([{
      task: { id: created.id, sessionId: value.sessionId },
      occurrence: { taskId: created.id, sessionId: value.sessionId },
      queue: {
        message: "Continue the adopted Claude conversation.",
        sessionId: value.sessionId,
        state: "pending",
      },
    }]);
    expect(await value.store.materializeDue({ now: dueAt })).toEqual([]);
    expect(value.database.query(
      `SELECT q.state,s.provider,pa.runtime_scope,b.state AS binding_state
       FROM queue_entries q
       JOIN sessions s ON s.id=q.session_id
       JOIN session_provider_account_authorities pa ON pa.session_id=s.id
       JOIN session_personal_runtime_bindings b ON b.session_id=s.id
       WHERE q.session_id=?`,
    ).all(value.sessionId)).toEqual([{
      state: "pending",
      provider: "claude",
      runtime_scope: "personal",
      binding_state: "active",
    }]);
  });

  test("withholds detached, releasing, or mismatched personal Claude task authority", async () => {
    for (const authorityLoss of ["detached", "releasing", "mismatched"] as const) {
      const value = fixture();
      adoptPersonalClaudeSession(value);
      const created = createTask(value, {
        name: `Personal Claude ${authorityLoss}`,
      });
      const dueAt = created.nextDueAt ?? 0;
      if (authorityLoss === "detached") {
        value.database.query(
          "UPDATE session_personal_runtime_bindings SET state='detached' WHERE session_id=?",
        ).run(value.sessionId);
      } else {
        value.database.query(
          `INSERT INTO provider_runtime_account_revocations(
             profile_id,profile_generation,provider,runtime_scope,current_account_key,state
           ) VALUES (?,1,'claude','personal',?,?)`,
        ).run(
          value.accountId,
          authorityLoss === "mismatched"
            ? `v1:claude:${"c".repeat(64)}`
            : claudeAccountKey,
          authorityLoss === "mismatched" ? "completed" : "releasing",
        );
      }

      expect(value.store.nextDueAt()).toBeNull();
      expect(await value.store.materializeDue({ now: dueAt })).toEqual([]);
      expect(value.store.listOccurrences(value.sessionId, created.id)).toEqual([]);
      expect(value.database.query(
        "SELECT COUNT(*) AS count FROM queue_entries WHERE session_id=?",
      ).get(value.sessionId)).toEqual({ count: 0 });
    }
  });

  test("withholds revoked Claude tasks when its own generation differs from the Codex shadow", async () => {
    for (const state of ["releasing", "completed"] as const) {
      const value = fixture();
      value.database.query("UPDATE provider_accounts SET process_generation=2 WHERE profile_id=? AND provider='claude'")
        .run(value.accountId);
      adoptPersonalClaudeSession(value);
      const created = createTask(value);
      const dueAt = created.nextDueAt ?? 0;
      expect(value.store.nextDueAt()).toBe(dueAt);
      value.database.query(`INSERT INTO provider_runtime_account_revocations(
        profile_id,profile_generation,provider,runtime_scope,current_account_key,state
      ) VALUES (?,1,'claude','personal',?,?)`).run(value.accountId,
        state === "releasing" ? claudeAccountKey : `v1:claude:${"c".repeat(64)}`, state);
      expect(value.store.nextDueAt()).toBeNull();
      expect(await value.store.materializeDue({ now: dueAt })).toEqual([]);
      expect(value.store.listOccurrences(value.sessionId, created.id)).toEqual([]);
      expect(value.database.query("SELECT COUNT(*) AS count FROM queue_entries WHERE session_id=?")
        .get(value.sessionId)).toEqual({ count: 0 });
    }
  });

  test("checks Claude runtime liveness with its captured provider generation rather than the Codex shadow", async () => {
    const seen: SessionTaskExecutionAuthority[] = [];
    const value = fixture({
      isExecutionAuthorityLive: (authority) => {
        seen.push(authority);
        return authority.provider === "claude" && authority.processGeneration === 7;
      },
    });
    value.database.query(
      "UPDATE provider_accounts SET process_generation=7 WHERE profile_id=? AND provider='claude'",
    ).run(value.accountId);
    adoptPersonalClaudeSession(value);
    const created = createTask(value);
    expect(value.database.query("SELECT process_generation FROM profiles WHERE id=?").get(value.accountId))
      .toEqual({ process_generation: 1 });
    expect(await value.store.materializeDue({ now: created.nextDueAt ?? 0 })).toMatchObject([{
      task: { id: created.id },
      queue: { sessionId: value.sessionId },
    }]);
    expect(seen).toEqual([0, 1].map(() => ({
      processGeneration: 7,
      profileId: value.accountId,
      provider: "claude",
      providerThreadId: `thread-${value.sessionId}`,
      sessionId: value.sessionId,
    })));
  });

  test("rechecks personal Claude binding authority after project validation", async () => {
    const fixtureReference: { value?: Fixture } = {};
    const current = fixture({
      resolveProjectDirectory: async (root) => {
        const value = fixtureReference.value;
        if (value === undefined) throw new Error("Missing task fixture.");
        value.database.query(
          "UPDATE session_personal_runtime_bindings SET state='detached' WHERE session_id=?",
        ).run(value.sessionId);
        return root;
      },
    });
    fixtureReference.value = current;
    adoptPersonalClaudeSession(current);
    const created = createTask(current);
    const dueAt = created.nextDueAt ?? 0;
    expect(current.store.nextDueAt()).toBe(dueAt);

    expect(await current.store.materializeDue({ now: dueAt })).toEqual([]);
    expect(current.store.listOccurrences(current.sessionId, created.id)).toEqual([]);
    expect(current.database.query(
      "SELECT COUNT(*) AS count FROM queue_entries WHERE session_id=?",
    ).get(current.sessionId)).toEqual({ count: 0 });
  });

  test("does not advertise or retry a native task under stale account identity", async () => {
    const value = fixture();
    const created = createTask(value);
    const dueAt = created.nextDueAt ?? 0;
    expect(value.store.nextDueAt()).toBe(dueAt);

    value.database.query(
      "UPDATE profiles SET provider_email='replacement@example.com' WHERE id=?",
    ).run(value.accountId);
    expect(value.store.nextDueAt()).toBeNull();
    expect(await value.store.materializeDue({ now: dueAt })).toEqual([]);
    expect(await value.store.materializeDue({ now: dueAt })).toEqual([]);
    expect(value.database.query(
      "SELECT COUNT(*) AS count FROM session_task_occurrences",
    ).get()).toEqual({ count: 0 });
    expect(value.database.query("SELECT COUNT(*) AS count FROM queue_entries").get())
      .toEqual({ count: 0 });

    value.database.query(
      "UPDATE profiles SET provider_email='scheduler@example.com' WHERE id=?",
    ).run(value.accountId);
    expect(await value.store.materializeDue({ now: dueAt })).toMatchObject([{
      task: { id: created.id, sessionId: value.sessionId },
      occurrence: { taskId: created.id, sessionId: value.sessionId },
      queue: { sessionId: value.sessionId },
    }]);
  });

  test("returns after one atomic handoff before resolving the next candidate", async () => {
    let rejectSecond = true;
    const resolvedRoots: string[] = [];
    const value = fixture({
      resolveProjectDirectory: async (root) => {
        resolvedRoots.push(root);
        if (root === "/second" && rejectSecond) {
          throw new Error("The second candidate must remain untouched on this pass.");
        }
        return root;
      },
    });
    value.database.query("UPDATE projects SET root_path='/first'").run();
    const secondProjectId = createProjectId();
    value.database.query("INSERT INTO projects(id,root_path) VALUES (?,?)")
      .run(secondProjectId, "/second");
    value.database.query("UPDATE sessions SET project_id=? WHERE id=?")
      .run(secondProjectId, value.otherSessionId);

    const first = createTask(value, {
      name: "First due task",
      prompt: "Materialize first.",
    });
    value.now.value = 2_000;
    const second = value.store.create({
      sessionId: value.otherSessionId,
      name: "Second due task",
      prompt: "Materialize on the next pass.",
      minutes: 15,
      status: "active",
      idempotencyKey: idempotencyKey(),
    });
    const dueAt = second.nextDueAt ?? 0;

    expect(await value.store.materializeDue({ now: dueAt }))
      .toMatchObject([{
        task: { id: first.id },
        occurrence: { taskId: first.id },
        queue: { message: "Materialize first." },
      }]);
    expect(resolvedRoots).toEqual(["/first"]);

    rejectSecond = false;
    expect(await value.store.materializeDue({ now: dueAt }))
      .toMatchObject([{
        task: { id: second.id },
        occurrence: { taskId: second.id },
        queue: { message: "Materialize on the next pass." },
      }]);
    expect(resolvedRoots).toEqual(["/first", "/second"]);
    expect(value.store.listOccurrences(value.sessionId, first.id)).toHaveLength(1);
    expect(value.store.listOccurrences(value.otherSessionId, second.id)).toHaveLength(1);
  });

  test("advances its bounded scan past more than 128 unusable tasks", async () => {
    const value = fixture({
      resolveProjectDirectory: async (root) => root === "/valid" ? root : null,
    });
    const accountId = createProfileId();
    const invalidProjectId = createProjectId();
    const validProjectId = createProjectId();
    value.database.query(
      `INSERT INTO profiles(id,state,process_generation,provider_email)
       VALUES (?,'signed_in',1,'other-scheduler@example.com')`,
    ).run(accountId);
    value.database.query("INSERT INTO projects(id,root_path) VALUES (?,?)")
      .run(invalidProjectId, "/invalid");
    value.database.query("INSERT INTO projects(id,root_path) VALUES (?,?)")
      .run(validProjectId, "/valid");

    const invalidSessionIds = Array.from({ length: 5 }, () => createSessionId());
    for (const sessionId of invalidSessionIds) {
      value.database.query(
        `INSERT INTO sessions(id,profile_id,project_id,provider_thread_id,state)
         VALUES (?,?,?,?,'idle')`,
      ).run(sessionId, accountId, invalidProjectId, `thread-${sessionId}`);
    }
    for (const [sessionIndex, sessionId] of invalidSessionIds.entries()) {
      const taskCount = sessionIndex < 4 ? SESSION_TASK_LIMIT : 1;
      for (let taskIndex = 0; taskIndex < taskCount; taskIndex += 1) {
        value.store.create({
          sessionId,
          name: `Unusable ${String(sessionIndex)}-${String(taskIndex)}`,
          prompt: "This task has no usable canonical project directory.",
          minutes: 15,
          status: "active",
          idempotencyKey: idempotencyKey(),
        });
      }
    }

    value.now.value = 2_000;
    const validSessionId = createSessionId();
    value.database.query(
      `INSERT INTO sessions(id,profile_id,project_id,provider_thread_id,state)
       VALUES (?,?,?,?,'idle')`,
    ).run(validSessionId, accountId, validProjectId, `thread-${validSessionId}`);
    const valid = value.store.create({
      sessionId: validSessionId,
      name: "Eligible after bounded scan",
      prompt: "Materialize this later eligible task.",
      minutes: 15,
      status: "active",
      idempotencyKey: idempotencyKey(),
    });
    const dueAt = valid.nextDueAt ?? 0;

    expect(await value.store.materializeDue({
      now: dueAt,
    })).toEqual([]);
    expect(await value.store.materializeDue({
      now: dueAt,
    })).toMatchObject([{
      task: { id: valid.id, sessionId: validSessionId },
      occurrence: { taskId: valid.id, sessionId: validSessionId },
      queue: {
        sessionId: validSessionId,
        message: "Materialize this later eligible task.",
      },
    }]);
    expect(value.database.query(
      "SELECT COUNT(*) AS count FROM session_task_occurrences",
    ).get()).toEqual({ count: 1 });
    expect(value.database.query(
      "SELECT COUNT(*) AS count FROM queue_entries",
    ).get()).toEqual({ count: 1 });
  });

  test("atomically coalesces downtime into one ordinary queue entry", async () => {
    const value = fixture();
    const created = createTask(value);
    const scheduledFor = created.nextDueAt ?? 0;
    const dueNow = scheduledFor + 3 * 15 * 60_000;
    const materialized = await value.store.materializeDue({ now: dueNow });
    expect(materialized).toHaveLength(1);
    expect(materialized[0]).toMatchObject({
      task: {
        id: created.id,
        sessionId: value.sessionId,
        nextDueAt: scheduledFor + 4 * 15 * 60_000,
      },
      occurrence: {
        taskId: created.id,
        sessionId: value.sessionId,
        taskRevision: 1,
        scheduledFor,
        coalescedIntervals: 3,
      },
      queue: {
        sessionId: value.sessionId,
        message: "Review this conversation.",
        state: "pending",
      },
    });
    expect(value.store.listOccurrences(value.sessionId, created.id)).toHaveLength(1);
    expect(await value.store.materializeDue({
      now: scheduledFor + 8 * 15 * 60_000,
    })).toEqual([]);
    expect(await value.store.materializeDue({ now: scheduledFor - 1 })).toEqual([]);
  });

  test("never rewrites an already queued prompt and permits one later run after settlement", async () => {
    const value = fixture();
    const created = createTask(value);
    const first = await value.store.materializeDue({ now: created.nextDueAt ?? 0 });
    const firstRun = first[0];
    if (firstRun === undefined) throw new Error("Expected first materialization.");
    value.now.value = 902_000;
    const edited = value.store.edit({
      sessionId: value.sessionId,
      taskId: created.id,
      expectedRevision: 1,
      patch: { prompt: "Use the new prompt." },
      idempotencyKey: idempotencyKey(),
    });
    const storedFirst = value.database.query(
      "SELECT message FROM queue_entries WHERE id=?",
    ).get(firstRun.queue.id);
    expect(storedFirst).toEqual({ message: "Review this conversation." });
    value.database.query("UPDATE queue_entries SET state='applied' WHERE id=?").run(firstRun.queue.id);
    const second = await value.store.materializeDue({ now: edited.nextDueAt ?? 0 });
    expect(second).toHaveLength(1);
    expect(second[0]?.queue.message).toBe("Use the new prompt.");
    expect(value.store.listOccurrences(value.sessionId, created.id)).toHaveLength(2);
  });

  test("rechecks revision after project validation so edit-versus-due cannot hybridize", async () => {
    const fixtureReference: { value?: Fixture } = {};
    let intervened = false;
    const createdFixture = fixture({
      resolveProjectDirectory: async (root) => {
        if (!intervened) {
          intervened = true;
          const value = fixtureReference.value;
          const current = value?.store.list(value.sessionId)[0];
          if (value === undefined || current === undefined) throw new Error("Missing race fixture.");
          value.store.edit({
            sessionId: value.sessionId,
            taskId: current.id,
            expectedRevision: current.revision,
            patch: { prompt: "Revision two prompt" },
            idempotencyKey: idempotencyKey(),
          });
        }
        return root;
      },
    });
    fixtureReference.value = createdFixture;
    const value = createdFixture;
    const created = createTask(value);
    expect(await value.store.materializeDue({ now: created.nextDueAt ?? 0 })).toEqual([]);
    const retried = await value.store.materializeDue({ now: created.nextDueAt ?? 0 });
    expect(retried).toHaveLength(1);
    expect(retried[0]).toMatchObject({
      task: { revision: 2 },
      occurrence: { taskRevision: 2 },
      queue: { message: "Revision two prompt" },
    });
  });

  test("linearizes pause and delete before the due transaction without leaving a queue half", async () => {
    for (const operation of ["pause", "delete"] as const) {
      const fixtureReference: { value?: Fixture } = {};
      let intervened = false;
      const value = fixture({
        resolveProjectDirectory: async (root) => {
          if (!intervened) {
            intervened = true;
            const currentFixture = fixtureReference.value;
            const current = currentFixture?.store.list(currentFixture.sessionId)[0];
            if (currentFixture === undefined || current === undefined) {
              throw new Error("Missing race fixture.");
            }
            if (operation === "pause") {
              currentFixture.store.edit({
                sessionId: currentFixture.sessionId,
                taskId: current.id,
                expectedRevision: current.revision,
                patch: { status: "paused" },
                idempotencyKey: idempotencyKey(),
              });
            } else {
              currentFixture.store.delete({
                sessionId: currentFixture.sessionId,
                taskId: current.id,
                expectedRevision: current.revision,
                idempotencyKey: idempotencyKey(),
              });
            }
          }
          return root;
        },
      });
      fixtureReference.value = value;
      const created = createTask(value);
      expect(await value.store.materializeDue({
        now: created.nextDueAt ?? 0,
      })).toEqual([]);
      expect(value.database.query("SELECT COUNT(*) AS count FROM queue_entries").get()).toEqual({ count: 0 });
      expect(value.store.listOccurrences(value.sessionId, created.id)).toEqual([]);
    }
  });

  test("leaves due tasks untouched while any local execution authority is ineligible", async () => {
    const value = fixture();
    const created = createTask(value);
    const dueAt = created.nextDueAt ?? 0;
    const cases = [
      "UPDATE profiles SET state='signed_out'",
      "UPDATE sessions SET provider_thread_id=NULL",
      "UPDATE sessions SET state='recovery_required'",
      "UPDATE sessions SET state='terminal'",
      "UPDATE sessions SET project_id=NULL",
    ];
    for (const statement of cases) {
      const isolated = fixture();
      const task = createTask(isolated);
      isolated.database.exec(statement);
      expect(await isolated.store.materializeDue({ now: task.nextDueAt ?? dueAt })).toEqual([]);
      expect(isolated.store.listOccurrences(isolated.sessionId, task.id)).toEqual([]);
    }
    const unusable = fixture({ resolveProjectDirectory: async () => null });
    const unusableTask = createTask(unusable);
    expect(await unusable.store.materializeDue({
      now: unusableTask.nextDueAt ?? dueAt,
    })).toEqual([]);
  });

  test("uses provider-specific readiness for signed-out Codex and adopted Claude sessions", async () => {
    const codex = fixture();
    const codexTask = createTask(codex);
    codex.database.query("UPDATE profiles SET state='signed_out'").run();
    expect(codex.store.nextDueAt()).toBeNull();
    expect(await codex.store.materializeDue({ now: codexTask.nextDueAt ?? 0 })).toEqual([]);

    const claude = fixture({ isExecutionAuthorityLive: () => true });
    const claudeTask = createTask(claude);
    adoptPersonalClaudeSession(claude);
    expect(claude.store.nextDueAt()).toBe(claudeTask.nextDueAt);
    await expect(claude.store.materializeDue({
      now: claudeTask.nextDueAt ?? 0,
    })).resolves.toMatchObject([{
      task: { id: claudeTask.id },
      queue: { sessionId: claude.sessionId },
    }]);

    const loginPending = fixture({ isExecutionAuthorityLive: () => true });
    const loginPendingTask = createTask(loginPending);
    adoptPersonalClaudeSession(loginPending);
    loginPending.database.query("UPDATE profiles SET state='login_pending'").run();
    expect(loginPending.store.nextDueAt()).toBe(loginPendingTask.nextDueAt);
    expect(await loginPending.store.materializeDue({
      now: loginPendingTask.nextDueAt ?? 0,
    })).toMatchObject([{
      task: { id: loginPendingTask.id },
      queue: { sessionId: loginPending.sessionId },
    }]);
  });

  test("does not commit a due Claude occurrence without this daemon's exact live binding", async () => {
    const unproven = fixture();
    const unprovenTask = createTask(unproven);
    unproven.database.query("UPDATE sessions SET provider_v39='claude'").run();
    expect(await unproven.store.materializeDue({
      now: unprovenTask.nextDueAt ?? 0,
    })).toEqual([]);
    expect(unproven.store.listOccurrences(unproven.sessionId, unprovenTask.id)).toEqual([]);

    let authorityState: "error" | "closed" | "live" = "error";
    const seen: SessionTaskExecutionAuthority[] = [];
    const value = fixture({
      isExecutionAuthorityLive: (authority) => {
        seen.push(authority);
        if (authorityState === "error") throw new Error("authority proof unavailable");
        return authority.provider !== "claude" || authorityState === "live";
      },
    });
    const created = createTask(value);
    adoptPersonalClaudeSession(value);
    const dueAt = created.nextDueAt ?? 0;

    await expect(value.store.materializeDue({ now: dueAt }))
      .rejects.toThrow("authority proof unavailable");
    authorityState = "closed";
    expect(await value.store.materializeDue({ now: dueAt })).toEqual([]);
    expect(value.store.listOccurrences(value.sessionId, created.id)).toEqual([]);
    expect(value.store.require(value.sessionId, created.id).nextDueAt).toBe(dueAt);
    expect(value.database.query("SELECT COUNT(*) AS count FROM queue_entries").get())
      .toEqual({ count: 0 });
    expect(seen.at(-1)).toMatchObject({
      processGeneration: 1,
      provider: "claude",
      providerThreadId: `thread-${value.sessionId}`,
      sessionId: value.sessionId,
    });

    authorityState = "live";
    await expect(value.store.materializeDue({ now: dueAt })).resolves.toMatchObject([{
      occurrence: { taskId: created.id },
      queue: { sessionId: value.sessionId },
    }]);
  });

  test("rolls back queue allocation, occurrence, and due advance as one unit", async () => {
    const value = fixture();
    const created = createTask(value);
    value.database.query(
      "UPDATE queue_sequence_authority SET next_sequence=9007199254740991 WHERE singleton=1",
    ).run();
    await expect(value.store.materializeDue({
      now: created.nextDueAt ?? 0,
    })).rejects.toThrow("QUEUE_SEQUENCE_EXHAUSTED");
    expect(value.database.query("SELECT COUNT(*) AS count FROM queue_entries").get()).toEqual({ count: 0 });
    expect(value.store.listOccurrences(value.sessionId, created.id)).toEqual([]);
    expect(value.store.require(value.sessionId, created.id).nextDueAt).toBe(created.nextDueAt);
  });

  test("fences the materialization commit with daemon generation authority", async () => {
    const value = fixture();
    const created = createTask(value);
    await expect(value.store.materializeDue({
      now: created.nextDueAt ?? 0,
      daemonGeneration: 6,
    })).rejects.toMatchObject({ code: "DAEMON_AUTHORITY_CHANGED" });
    expect(value.database.query("SELECT COUNT(*) AS count FROM queue_entries").get()).toEqual({ count: 0 });
    expect(value.store.listOccurrences(value.sessionId, created.id)).toEqual([]);
    expect(await value.store.materializeDue({
      now: created.nextDueAt ?? 0,
      daemonGeneration: 7,
    })).toHaveLength(1);
  });
});
