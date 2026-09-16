import { createHash } from "node:crypto";

import { Database } from "bun:sqlite";
import { z } from "zod";

import {
  SESSION_TASK_LIMIT,
  sessionTaskDeleteResultSchema,
  sessionTaskIntervalMinutesSchema,
  sessionTaskListSchema,
  sessionTaskNameSchema,
  sessionTaskOccurrenceSchema,
  sessionTaskPatchSchema,
  sessionTaskPromptSchema,
  sessionTaskRecordSchema,
  sessionTaskStatusSchema,
  summarizeSessionTask,
  type SessionTaskDeleteResult,
  type SessionTaskList,
  type SessionTaskOccurrence,
  type SessionTaskPatch,
  type SessionTaskRecord,
  type SessionTaskStatus,
  type SessionTaskSummary,
} from "../domain/session-tasks";
import {
  createSessionTaskId,
  MESSAGE_MAX_BYTES,
  positiveRevisionSchema,
  profileIdSchema,
  queueIdSchema,
  sessionIdSchema,
  sessionTaskIdSchema,
  unixMillisecondsSchema,
  type QueueId,
  type SessionId,
  type SessionTaskId,
} from "../domain/values";
import { providerSchema } from "../domain/presets";
import type { QueueState } from "../domain/transitions";
import { resolveUsableCanonicalProjectDirectory } from "./project-directory";
import { SESSION_SWITCH_BLOCKING_PREDICATE, SESSION_SWITCH_FENCE_SOURCE } from "./session-switch-fence";
import { normalizeSchemaSql } from "./schema-cohort";

const maximumSafeInteger = 9_007_199_254_740_991;
const SESSION_TASK_RECEIPT_RESULT_MAX_BYTES = MESSAGE_MAX_BYTES * 6 + 16_384;
const safeTimestampSchema = unixMillisecondsSchema.safe();
const idempotencyKeySchema = z.string().uuid();
const requestDigestSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const createInputSchema = z.object({
  sessionId: sessionIdSchema,
  name: sessionTaskNameSchema,
  prompt: sessionTaskPromptSchema,
  minutes: sessionTaskIntervalMinutesSchema,
  status: sessionTaskStatusSchema,
  idempotencyKey: idempotencyKeySchema,
  receiptDigest: requestDigestSchema.optional(),
}).strict();
const editInputSchema = z.object({
  sessionId: sessionIdSchema,
  taskId: sessionTaskIdSchema,
  expectedRevision: positiveRevisionSchema.safe(),
  patch: sessionTaskPatchSchema,
  idempotencyKey: idempotencyKeySchema,
  receiptDigest: requestDigestSchema.optional(),
}).strict();
const deleteInputSchema = z.object({
  sessionId: sessionIdSchema,
  taskId: sessionTaskIdSchema,
  expectedRevision: positiveRevisionSchema.safe(),
  idempotencyKey: idempotencyKeySchema,
  receiptDigest: requestDigestSchema.optional(),
}).strict();
const materializeInputSchema = z.object({
  now: safeTimestampSchema,
  daemonGeneration: z.number().int().safe().nonnegative().optional(),
}).strict();

export const SESSION_TASK_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS session_conversation_automation (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  provider_thread_id TEXT NOT NULL CHECK(length(CAST(provider_thread_id AS BLOB)) BETWEEN 1 AND 200),
  enabled_at INTEGER NOT NULL CHECK(enabled_at BETWEEN 0 AND 9007199254740991)
) STRICT;
CREATE TABLE IF NOT EXISTS session_tasks (
  id TEXT PRIMARY KEY CHECK(id GLOB 'stask_[0-9a-f]*' AND length(id)=38),
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK(length(CAST(name AS BLOB)) BETWEEN 1 AND 160),
  prompt TEXT NOT NULL CHECK(length(CAST(prompt AS BLOB)) BETWEEN 1 AND 262144),
  schedule_kind TEXT NOT NULL CHECK(schedule_kind='interval_minutes'),
  interval_minutes INTEGER NOT NULL CHECK(interval_minutes BETWEEN 15 AND 10080),
  status TEXT NOT NULL CHECK(status IN ('active','paused')),
  revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740990),
  next_due_at INTEGER CHECK(next_due_at IS NULL OR next_due_at BETWEEN 0 AND 9007199254740991),
  created_at INTEGER NOT NULL CHECK(created_at BETWEEN 0 AND 9007199254740991),
  updated_at INTEGER NOT NULL CHECK(updated_at BETWEEN created_at AND 9007199254740991),
  deleted_at INTEGER CHECK(deleted_at IS NULL OR deleted_at BETWEEN created_at AND 9007199254740991),
  UNIQUE(id,session_id),
  CHECK(
    (deleted_at IS NULL AND status='active' AND next_due_at IS NOT NULL) OR
    (deleted_at IS NULL AND status='paused' AND next_due_at IS NULL) OR
    (deleted_at IS NOT NULL AND status='paused' AND next_due_at IS NULL)
  )
) STRICT;
CREATE INDEX IF NOT EXISTS session_tasks_by_session
  ON session_tasks(session_id,created_at,id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS session_tasks_due
  ON session_tasks(next_due_at,id) WHERE deleted_at IS NULL AND status='active';
CREATE TRIGGER IF NOT EXISTS session_tasks_limit_guard
BEFORE INSERT ON session_tasks
WHEN (SELECT COUNT(*) FROM session_tasks WHERE session_id=NEW.session_id AND deleted_at IS NULL) >= 32
BEGIN SELECT RAISE(ABORT,'SESSION_TASK_LIMIT'); END;
CREATE TRIGGER IF NOT EXISTS session_tasks_update_guard
BEFORE UPDATE ON session_tasks
WHEN NEW.id != OLD.id
  OR NEW.session_id != OLD.session_id
  OR NEW.schedule_kind != OLD.schedule_kind
  OR NEW.created_at != OLD.created_at
  OR NOT (
    (
      OLD.deleted_at IS NULL
      AND NEW.revision=OLD.revision+1
      AND NEW.updated_at>OLD.updated_at
    ) OR (
      OLD.deleted_at IS NULL
      AND NEW.deleted_at IS NULL
      AND OLD.status='active'
      AND NEW.status='active'
      AND NEW.revision=OLD.revision
      AND NEW.name=OLD.name
      AND NEW.prompt=OLD.prompt
      AND NEW.interval_minutes=OLD.interval_minutes
      AND NEW.updated_at=OLD.updated_at
      AND OLD.next_due_at IS NOT NULL
      AND NEW.next_due_at>OLD.next_due_at
    )
  )
BEGIN SELECT RAISE(ABORT,'SESSION_TASK_UPDATE_INVALID'); END;

CREATE TABLE IF NOT EXISTS session_task_occurrences (
  task_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  task_revision INTEGER NOT NULL CHECK(task_revision BETWEEN 1 AND 9007199254740990),
  scheduled_for INTEGER NOT NULL CHECK(scheduled_for BETWEEN 0 AND 9007199254740991),
  coalesced_intervals INTEGER NOT NULL CHECK(coalesced_intervals BETWEEN 0 AND 9007199254740991),
  queue_id TEXT NOT NULL UNIQUE REFERENCES queue_entries(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL CHECK(created_at BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY(task_id,scheduled_for),
  FOREIGN KEY(task_id,session_id) REFERENCES session_tasks(id,session_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX IF NOT EXISTS session_task_occurrences_by_session
  ON session_task_occurrences(session_id,created_at,task_id,scheduled_for);
CREATE TRIGGER IF NOT EXISTS session_task_occurrences_insert_guard
BEFORE INSERT ON session_task_occurrences
WHEN NOT EXISTS(
  SELECT 1 FROM session_tasks t
  WHERE t.id=NEW.task_id
    AND t.session_id=NEW.session_id
    AND t.revision=NEW.task_revision
    AND t.status='active'
    AND t.deleted_at IS NULL
    AND t.next_due_at=NEW.scheduled_for
) OR NOT EXISTS(
  SELECT 1 FROM queue_entries q
  WHERE q.id=NEW.queue_id
    AND q.session_id=NEW.session_id
    AND q.state='pending'
) OR EXISTS(
  SELECT 1
  FROM session_task_occurrences o
  JOIN queue_entries q ON q.id=o.queue_id
  WHERE o.task_id=NEW.task_id
    AND q.state IN ('pending','dispatching','ambiguous')
)
BEGIN SELECT RAISE(ABORT,'SESSION_TASK_OCCURRENCE_AUTHORITY_INVALID'); END;
CREATE TRIGGER IF NOT EXISTS session_task_occurrences_no_update
BEFORE UPDATE ON session_task_occurrences
BEGIN SELECT RAISE(ABORT,'SESSION_TASK_OCCURRENCE_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS session_tasks_due_advance_guard
BEFORE UPDATE OF next_due_at ON session_tasks
WHEN NEW.revision=OLD.revision AND NOT EXISTS(
  SELECT 1 FROM session_task_occurrences o
  WHERE o.task_id=OLD.id
    AND o.session_id=OLD.session_id
    AND o.task_revision=OLD.revision
    AND o.scheduled_for=OLD.next_due_at
)
BEGIN SELECT RAISE(ABORT,'SESSION_TASK_DUE_ADVANCE_WITHOUT_OCCURRENCE'); END;

CREATE TABLE IF NOT EXISTS session_task_receipts (
  idempotency_key TEXT PRIMARY KEY CHECK(length(idempotency_key)=36),
  request_digest TEXT NOT NULL CHECK(length(request_digest)=64 AND request_digest NOT GLOB '*[^0-9a-f]*'),
  operation TEXT NOT NULL CHECK(operation IN ('list','view','create','edit','delete')),
  session_id TEXT NOT NULL,
  task_id TEXT,
  result_revision INTEGER CHECK(result_revision IS NULL OR result_revision BETWEEN 1 AND 9007199254740991),
  result_updated_at INTEGER CHECK(result_updated_at IS NULL OR result_updated_at BETWEEN 0 AND 9007199254740991),
  result_next_due_at INTEGER CHECK(result_next_due_at IS NULL OR result_next_due_at BETWEEN 0 AND 9007199254740991),
  result_deleted_at INTEGER CHECK(result_deleted_at IS NULL OR result_deleted_at BETWEEN 0 AND 9007199254740991),
  result_json TEXT CHECK(
    result_json IS NULL OR (
      json_valid(result_json)
      AND length(CAST(result_json AS BLOB)) BETWEEN 2 AND ${SESSION_TASK_RECEIPT_RESULT_MAX_BYTES}
    )
  ),
  created_at INTEGER NOT NULL CHECK(created_at BETWEEN 0 AND 9007199254740991),
  CHECK(
    (
      operation='list'
      AND task_id IS NULL
      AND result_revision IS NULL
      AND result_updated_at IS NULL
      AND result_next_due_at IS NULL
      AND result_deleted_at IS NULL
      AND result_json IS NOT NULL
    ) OR (
      operation='view'
      AND task_id IS NOT NULL
      AND result_revision IS NULL
      AND result_updated_at IS NULL
      AND result_next_due_at IS NULL
      AND result_deleted_at IS NULL
      AND result_json IS NOT NULL
    ) OR (
      operation='delete'
      AND task_id IS NOT NULL
      AND result_revision IS NOT NULL
      AND result_updated_at IS NOT NULL
      AND result_next_due_at IS NULL
      AND result_deleted_at IS NOT NULL
      AND result_json IS NOT NULL
    ) OR (
      operation IN ('create','edit')
      AND task_id IS NOT NULL
      AND result_revision IS NOT NULL
      AND result_updated_at IS NOT NULL
      AND result_deleted_at IS NULL
      AND result_json IS NOT NULL
    )
  ),
  FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  FOREIGN KEY(task_id,session_id) REFERENCES session_tasks(id,session_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX IF NOT EXISTS session_task_receipts_by_task
  ON session_task_receipts(session_id,task_id,created_at);
CREATE TRIGGER IF NOT EXISTS session_task_receipts_no_update
BEFORE UPDATE ON session_task_receipts
BEGIN SELECT RAISE(ABORT,'SESSION_TASK_RECEIPT_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS session_task_receipts_capacity_guard
BEFORE INSERT ON session_task_receipts
WHEN (
  SELECT COUNT(*) FROM session_task_receipts WHERE session_id=NEW.session_id
) >= CASE WHEN NEW.operation='delete' THEN 4096 ELSE 4064 END
BEGIN SELECT RAISE(ABORT,'SESSION_TASK_RECEIPT_CAPACITY'); END;
`;

const requiredSchemaObjects = [
  "session_conversation_automation",
  "session_tasks",
  "session_tasks_by_session",
  "session_tasks_due",
  "session_tasks_limit_guard",
  "session_tasks_update_guard",
  "session_task_occurrences",
  "session_task_occurrences_by_session",
  "session_task_occurrences_insert_guard",
  "session_task_occurrences_no_update",
  "session_tasks_due_advance_guard",
  "session_task_receipts",
  "session_task_receipts_by_task",
  "session_task_receipts_no_update",
  "session_task_receipts_capacity_guard",
] as const;

const requiredSchemaTables = [
  "session_conversation_automation",
  "session_tasks",
  "session_task_occurrences",
  "session_task_receipts",
] as const;

const schemaObjectRowSchema = z.object({
  name: z.string(),
  type: z.enum(["index", "table", "trigger"]),
  sql: z.string(),
}).strict();
const foreignKeyRowSchema = z.object({
  id: z.number().int().nonnegative(),
  seq: z.number().int().nonnegative(),
  table: z.string(),
  from: z.string(),
  to: z.string(),
  on_update: z.string(),
  on_delete: z.string(),
  match: z.string(),
}).strict();

const sessionTaskSchemaSignature = (database: Database): string => {
  const objects = database.query(
    `SELECT name,type,sql FROM sqlite_schema
     WHERE name IN (${requiredSchemaObjects.map(() => "?").join(",")})
     ORDER BY name`,
  ).all(...requiredSchemaObjects).map((row) => {
    const parsed = schemaObjectRowSchema.parse(row);
    return { ...parsed, sql: normalizeSchemaSql(parsed.sql) };
  });
  const tables = database.query("PRAGMA table_list").all().map((row) =>
    z.object({
      name: z.string(),
      type: z.string(),
      strict: z.number().int().min(0).max(1),
    }).passthrough().parse(row)).filter((row) =>
    requiredSchemaTables.some((table) => table === row.name)).map((row) => ({
      name: row.name,
      strict: row.strict,
      type: row.type,
    })).sort((left, right) => left.name.localeCompare(right.name));
  const foreignKeys = requiredSchemaTables.map((table) => ({
    table,
    rows: database.query(`PRAGMA foreign_key_list('${table}')`).all().map((row) =>
      foreignKeyRowSchema.parse(row)).sort((left, right) =>
      left.id - right.id || left.seq - right.seq),
  }));
  return canonicalJson({ foreignKeys, objects, tables });
};

let expectedSessionTaskSchemaSignature: string | undefined;

const expectedSchemaSignature = (): string => {
  if (expectedSessionTaskSchemaSignature !== undefined) {
    return expectedSessionTaskSchemaSignature;
  }
  const reference = new Database(":memory:", { strict: true });
  try {
    reference.exec("PRAGMA foreign_keys=ON;");
    reference.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY) STRICT;
      CREATE TABLE queue_entries (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        state TEXT NOT NULL
      ) STRICT;
    `);
    reference.exec(SESSION_TASK_SCHEMA_SQL);
    expectedSessionTaskSchemaSignature = sessionTaskSchemaSignature(reference);
    return expectedSessionTaskSchemaSignature;
  } finally {
    reference.close(false);
  }
};

export const assertSessionTaskSchema = (database: Database): void => {
  const foreignKeys = z.object({ foreign_keys: z.literal(1) }).strict().safeParse(
    database.query("PRAGMA foreign_keys").get(),
  );
  if (
    !foreignKeys.success
    || sessionTaskSchemaSignature(database) !== expectedSchemaSignature()
  ) {
    throw new Error("STATE_SESSION_TASK_SCHEMA_INVALID");
  }
  database.query(
    `SELECT id,session_id,name,prompt,schedule_kind,interval_minutes,status,revision,
            next_due_at,created_at,updated_at,deleted_at
     FROM session_tasks LIMIT 0`,
  ).all();
  database.query(
    `SELECT task_id,session_id,task_revision,scheduled_for,coalesced_intervals,queue_id,created_at
     FROM session_task_occurrences LIMIT 0`,
  ).all();
  database.query(
    `SELECT idempotency_key,request_digest,operation,session_id,task_id,
            result_revision,result_updated_at,result_next_due_at,result_deleted_at,
            result_json,created_at
     FROM session_task_receipts LIMIT 0`,
  ).all();
};

const taskRowSchema = z.object({
  id: sessionTaskIdSchema,
  session_id: sessionIdSchema,
  name: sessionTaskNameSchema,
  prompt: sessionTaskPromptSchema,
  schedule_kind: z.literal("interval_minutes"),
  interval_minutes: sessionTaskIntervalMinutesSchema,
  status: sessionTaskStatusSchema,
  revision: positiveRevisionSchema,
  next_due_at: safeTimestampSchema.nullable(),
  created_at: safeTimestampSchema,
  updated_at: safeTimestampSchema,
  deleted_at: safeTimestampSchema.nullable(),
}).strict();

const occurrenceRowSchema = z.object({
  task_id: sessionTaskIdSchema,
  session_id: sessionIdSchema,
  task_revision: positiveRevisionSchema,
  scheduled_for: safeTimestampSchema,
  coalesced_intervals: z.number().int().safe().nonnegative(),
  queue_id: queueIdSchema,
  created_at: safeTimestampSchema,
}).strict();

const receiptRowSchema = z.object({
  request_digest: requestDigestSchema,
  operation: z.enum(["list", "view", "create", "edit", "delete"]),
  session_id: sessionIdSchema,
  task_id: sessionTaskIdSchema.nullable(),
  result_revision: positiveRevisionSchema.safe().nullable(),
  result_updated_at: safeTimestampSchema.nullable(),
  result_next_due_at: safeTimestampSchema.nullable(),
  result_deleted_at: safeTimestampSchema.nullable(),
  result_json: z.string().min(2).max(SESSION_TASK_RECEIPT_RESULT_MAX_BYTES).nullable(),
}).strict();

type ReceiptOperation = z.infer<typeof receiptRowSchema>["operation"];
type ReceiptRow = z.infer<typeof receiptRowSchema>;

// Keep the preliminary wake-up query, bounded candidate scan, and transactional
// recheck on one provider-scoped authority definition. Provider additions must
// extend the explicit final branch; an unknown provider never inherits Codex.
const currentSessionTaskAuthorityJoins = `
JOIN profiles a ON a.id=s.profile_id
JOIN session_provider_authorities captured
  ON captured.session_id=s.id AND captured.profile_id=s.profile_id AND captured.provider=s.provider_v39
JOIN provider_accounts exact_account
  ON exact_account.id=captured.provider_account_id AND exact_account.profile_id=captured.profile_id
    AND exact_account.provider=captured.provider AND exact_account.binding_generation=captured.binding_generation
    AND exact_account.process_generation=captured.process_generation
LEFT JOIN session_provider_account_authorities pa
  ON pa.session_id=s.id AND pa.provider=s.provider_v39`;

const currentSessionTaskAuthorityPredicate = `
AND a.state!='removed'
AND (exact_account.readiness='signed_in' OR (
  captured.provider IN ('claude','devin') AND exact_account.readiness='unverified'
  AND captured.routing_provenance='explicit'
))
AND NOT EXISTS(
  SELECT 1 FROM provider_runtime_account_revocations r
  WHERE r.profile_id=s.profile_id
    AND (r.provider='claude' OR r.profile_generation=captured.process_generation)
    AND r.provider=s.provider_v39
    AND r.runtime_scope=pa.runtime_scope
    AND (r.state='releasing' OR r.current_account_key IS NULL
      OR r.current_account_key!=pa.account_key)
)
AND (
  (pa.runtime_scope='personal' AND EXISTS(
    SELECT 1 FROM session_personal_runtime_bindings b
    WHERE b.session_id=s.id
      AND b.provider=s.provider_v39
      AND b.provider_thread_id=s.provider_thread_id
      AND b.state='active'
  ))
  OR (pa.runtime_scope='managed' AND NOT EXISTS(
    SELECT 1 FROM session_personal_runtime_bindings b
    WHERE b.session_id=s.id AND b.state IN ('active','detaching')
  ))
  OR (s.provider_v39='devin' AND NOT EXISTS(
    SELECT 1 FROM session_personal_runtime_bindings b
    WHERE b.session_id=s.id AND b.state IN ('active','detaching')
  ))
)
AND (
  (s.provider_v39='claude' AND a.state!='removed')
  OR (s.provider_v39='codex' AND a.state='signed_in'
    AND a.provider_email IS NOT NULL
    AND a.codex_account_key=pa.account_key
    AND EXISTS(
      SELECT 1 FROM session_account_authorities legacy
      WHERE legacy.session_id=s.id
        AND legacy.profile_id=s.profile_id
        AND legacy.account_key IS NOT NULL
        AND legacy.account_key=lower(trim(a.provider_email))
    ))
  OR (s.provider_v39='devin' AND a.state!='removed')
)`;

const dueCandidateRowSchema = taskRowSchema.extend({
  process_generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  profile_id: profileIdSchema,
  project_root: z.string().min(1),
  provider: providerSchema,
  provider_thread_id: z.string().min(1),
});

const eligibleDueTaskRowSchema = dueCandidateRowSchema.extend({
  profile_state: z.enum([
    "signed_out",
    "login_pending",
    "signed_in",
    "recovery_required",
    "removed",
  ]),
  session_state: z.enum(["starting", "active", "idle"]),
  provider_thread_id: z.string().min(1),
});

export type SessionTaskQueueRecord = Readonly<{
  id: QueueId;
  sessionId: SessionId;
  message: string;
  state: "pending";
  createdAt: number;
  updatedAt: number;
}>;

/** The owning StateStore's synchronous, sealed queue admission on this database. */
export type SessionTaskEnqueue = (sessionId: SessionId, message: string) => Readonly<{
  id: QueueId;
  sessionId: SessionId;
  message: string;
  state: QueueState;
  createdAt: number;
  updatedAt: number;
}>;

const pendingQueueSchema = z.object({
  id: queueIdSchema,
  sessionId: sessionIdSchema,
  message: z.string().min(1).max(MESSAGE_MAX_BYTES),
  state: z.literal("pending"),
  createdAt: safeTimestampSchema,
  updatedAt: safeTimestampSchema,
}).strict();

export type SessionTaskMaterialization = Readonly<{
  task: SessionTaskRecord;
  occurrence: SessionTaskOccurrence;
  queue: SessionTaskQueueRecord;
}>;

export type SessionTaskExecutionAuthority = Readonly<{
  processGeneration: number;
  profileId: z.infer<typeof profileIdSchema>;
  provider: z.infer<typeof providerSchema>;
  providerThreadId: string;
  sessionId: SessionId;
}>;

export type SessionTaskStoreErrorCode =
  | "DAEMON_AUTHORITY_CHANGED"
  | "ENQUEUE_INVALID"
  | "ENQUEUE_UNAVAILABLE"
  | "IDEMPOTENCY_CONFLICT"
  | "IDEMPOTENCY_REPLAY_SUPERSEDED"
  | "NO_CHANGES"
  | "NOT_FOUND"
  | "RECEIPT_CAPACITY_EXHAUSTED"
  | "REVISION_CONFLICT"
  | "SCHEDULE_OVERFLOW"
  | "SESSION_NOT_FOUND"
  | "TASK_LIMIT"
  | "TIMESTAMP_OVERFLOW";

export class SessionTaskStoreError extends Error {
  constructor(readonly code: SessionTaskStoreErrorCode) {
    super(`SESSION_TASK_${code}`);
    this.name = "SessionTaskStoreError";
  }
}

type JsonPrimitive = boolean | null | number | string;
type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

const normalizeJson = (value: unknown): JsonValue => {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("SESSION_TASK_JSON_NONFINITE");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const normalized: Record<string, JsonValue> = {};
    for (const key of Object.keys(record).sort()) {
      const child = record[key];
      if (child === undefined) throw new Error("SESSION_TASK_JSON_UNDEFINED");
      normalized[key] = normalizeJson(child);
    }
    return normalized;
  }
  throw new Error("SESSION_TASK_JSON_UNSUPPORTED");
};

const canonicalJson = (value: unknown): string => JSON.stringify(normalizeJson(value));
const requestDigest = (value: unknown): string =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");

const mapTask = (row: unknown): SessionTaskRecord => {
  const parsed = taskRowSchema.parse(row);
  if (parsed.deleted_at !== null) throw new SessionTaskStoreError("NOT_FOUND");
  return sessionTaskRecordSchema.parse({
    scope: "conversation",
    id: parsed.id,
    sessionId: parsed.session_id,
    name: parsed.name,
    prompt: parsed.prompt,
    status: parsed.status,
    schedule: { kind: parsed.schedule_kind, minutes: parsed.interval_minutes },
    revision: parsed.revision,
    nextDueAt: parsed.next_due_at,
    createdAt: parsed.created_at,
    updatedAt: parsed.updated_at,
  });
};

const mapOccurrence = (row: unknown): SessionTaskOccurrence => {
  const parsed = occurrenceRowSchema.parse(row);
  return sessionTaskOccurrenceSchema.parse({
    sessionId: parsed.session_id,
    taskId: parsed.task_id,
    taskRevision: parsed.task_revision,
    scheduledFor: parsed.scheduled_for,
    coalescedIntervals: parsed.coalesced_intervals,
    queueId: parsed.queue_id,
    createdAt: parsed.created_at,
  });
};

const addInterval = (now: number, minutes: number): number => {
  const dueAt = now + minutes * 60_000;
  if (!Number.isSafeInteger(dueAt) || dueAt > maximumSafeInteger) {
    throw new SessionTaskStoreError("SCHEDULE_OVERFLOW");
  }
  return dueAt;
};

const timestampAfter = (observedNow: number, previousUpdatedAt: number): number => {
  if (previousUpdatedAt >= maximumSafeInteger) {
    throw new SessionTaskStoreError("TIMESTAMP_OVERFLOW");
  }
  return safeTimestampSchema.parse(Math.max(observedNow, previousUpdatedAt + 1));
};

const nextSlotAfter = (
  scheduledFor: number,
  now: number,
  intervalMinutes: number,
): Readonly<{ coalescedIntervals: number; nextDueAt: number }> => {
  const intervalMilliseconds = intervalMinutes * 60_000;
  const coalescedIntervals = Math.floor((now - scheduledFor) / intervalMilliseconds);
  const nextDueAt = scheduledFor + (coalescedIntervals + 1) * intervalMilliseconds;
  if (
    coalescedIntervals < 0
    || !Number.isSafeInteger(coalescedIntervals)
    || !Number.isSafeInteger(nextDueAt)
    || nextDueAt > maximumSafeInteger
  ) {
    throw new SessionTaskStoreError("SCHEDULE_OVERFLOW");
  }
  return { coalescedIntervals, nextDueAt };
};

export class SessionTaskStore {
  readonly #database: Database;
  readonly #now: () => number;
  readonly #resolveProjectDirectory: (root: string) => Promise<string | null>;
  readonly #enqueue: SessionTaskEnqueue | undefined;
  readonly #isExecutionAuthorityLive: (authority: SessionTaskExecutionAuthority) => boolean;
  #dueScanCursor: Readonly<{ nextDueAt: number; taskId: SessionTaskId }> | null = null;

  constructor(database: Database, options: Readonly<{
    now?: () => number;
    resolveProjectDirectory?: (root: string) => Promise<string | null>;
    enqueue?: SessionTaskEnqueue;
    isExecutionAuthorityLive?: (authority: SessionTaskExecutionAuthority) => boolean;
  }> = {}) {
    this.#database = database;
    this.#now = options.now ?? Date.now;
    this.#resolveProjectDirectory = options.resolveProjectDirectory
      ?? resolveUsableCanonicalProjectDirectory;
    this.#enqueue = options.enqueue;
    // Codex owns a durable reconnect path outside this store. Every other
    // provider needs a positive, process-local proof from the runtime layer;
    // a persisted thread id alone is never execution authority.
    this.#isExecutionAuthorityLive = options.isExecutionAuthorityLive
      ?? ((authority) => authority.provider === "codex");
    this.#database.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    assertSessionTaskSchema(this.#database);
  }

  #nowTimestamp(): number {
    return safeTimestampSchema.parse(this.#now());
  }

  #taskRow(sessionId: SessionId, taskId: SessionTaskId): unknown {
    return this.#database.query(
      `SELECT id,session_id,name,prompt,schedule_kind,interval_minutes,status,revision,
              next_due_at,created_at,updated_at,deleted_at
       FROM session_tasks
       WHERE session_id=? AND id=? AND deleted_at IS NULL`,
    ).get(sessionId, taskId);
  }

  #requireTask(sessionId: SessionId, taskId: SessionTaskId): SessionTaskRecord {
    const row = this.#taskRow(sessionId, taskId);
    if (row === null) throw new SessionTaskStoreError("NOT_FOUND");
    return mapTask(row);
  }

  #receipt(input: Readonly<{
    idempotencyKey: string;
    digest: string;
    operation: ReceiptOperation;
    sessionId: SessionId;
    taskId?: SessionTaskId;
  }>): ReceiptRow | null {
    const row = this.#database.query(
      `SELECT request_digest,operation,session_id,task_id,result_revision,
              result_updated_at,result_next_due_at,result_deleted_at,result_json
       FROM session_task_receipts WHERE idempotency_key=?`,
    ).get(input.idempotencyKey);
    if (row === null) return null;
    const parsed = receiptRowSchema.parse(row);
    const taskMatches = input.operation === "list"
      ? parsed.task_id === null
      : input.operation === "create"
        ? parsed.task_id !== null
        : input.taskId !== undefined && parsed.task_id === input.taskId;
    if (
      parsed.request_digest !== input.digest
      || parsed.operation !== input.operation
      || parsed.session_id !== input.sessionId
      || !taskMatches
    ) {
      throw new SessionTaskStoreError("IDEMPOTENCY_CONFLICT");
    }
    return parsed;
  }

  #replayTask(receipt: ReceiptRow): SessionTaskRecord {
    if (
      (receipt.operation !== "create" && receipt.operation !== "edit")
      || receipt.task_id === null
      || receipt.result_revision === null
      || receipt.result_updated_at === null
      || receipt.result_deleted_at !== null
      || receipt.result_json === null
    ) throw new Error("SESSION_TASK_MUTATION_RECEIPT_INVALID");
    const result = sessionTaskRecordSchema.parse(JSON.parse(receipt.result_json));
    if (
      result.sessionId !== receipt.session_id
      || result.id !== receipt.task_id
      || result.revision !== receipt.result_revision
      || result.updatedAt !== receipt.result_updated_at
      || result.nextDueAt !== receipt.result_next_due_at
      || canonicalJson(result) !== receipt.result_json
    ) {
      throw new Error("SESSION_TASK_MUTATION_RECEIPT_INVALID");
    }
    return result;
  }

  #replayDelete(receipt: ReceiptRow): SessionTaskDeleteResult {
    if (
      receipt.operation !== "delete"
      || receipt.task_id === null
      || receipt.result_revision === null
      || receipt.result_updated_at === null
      || receipt.result_next_due_at !== null
      || receipt.result_deleted_at === null
      || receipt.result_json === null
    ) throw new Error("SESSION_TASK_DELETE_RECEIPT_INVALID");
    const result = sessionTaskDeleteResultSchema.parse(JSON.parse(receipt.result_json));
    if (
      result.sessionId !== receipt.session_id
      || result.taskId !== receipt.task_id
      || result.revision !== receipt.result_revision
      || result.deletedAt !== receipt.result_updated_at
      || result.deletedAt !== receipt.result_deleted_at
      || canonicalJson(result) !== receipt.result_json
    ) throw new Error("SESSION_TASK_DELETE_RECEIPT_INVALID");
    return result;
  }

  #replayList(receipt: ReceiptRow): SessionTaskList {
    if (
      receipt.operation !== "list"
      || receipt.task_id !== null
      || receipt.result_json === null
    ) throw new Error("SESSION_TASK_LIST_RECEIPT_INVALID");
    const result = sessionTaskListSchema.parse(JSON.parse(receipt.result_json));
    if (
      result.sessionId !== receipt.session_id
      || result.tasks.some((task) => task.sessionId !== receipt.session_id)
      || canonicalJson(result) !== receipt.result_json
    ) throw new Error("SESSION_TASK_LIST_RECEIPT_INVALID");
    return result;
  }

  #replayView(receipt: ReceiptRow): SessionTaskRecord {
    if (
      receipt.operation !== "view"
      || receipt.task_id === null
      || receipt.result_json === null
    ) throw new Error("SESSION_TASK_VIEW_RECEIPT_INVALID");
    const result = sessionTaskRecordSchema.parse(JSON.parse(receipt.result_json));
    if (
      result.sessionId !== receipt.session_id
      || result.id !== receipt.task_id
      || canonicalJson(result) !== receipt.result_json
    ) throw new Error("SESSION_TASK_VIEW_RECEIPT_INVALID");
    return result;
  }

  #insertReadReceipt(input: Readonly<{
    idempotencyKey: string;
    digest: string;
    operation: "list" | "view";
    sessionId: SessionId;
    taskId?: SessionTaskId;
    result: SessionTaskList | SessionTaskRecord;
    now: number;
  }>): void {
    this.#database.query(
      `INSERT INTO session_task_receipts(
         idempotency_key,request_digest,operation,session_id,task_id,
         result_revision,result_updated_at,result_next_due_at,result_deleted_at,
         result_json,created_at
       ) VALUES (?,?,?,?,?,NULL,NULL,NULL,NULL,?,?)`,
    ).run(
      input.idempotencyKey,
      input.digest,
      input.operation,
      input.sessionId,
      input.taskId ?? null,
      canonicalJson(input.result),
      input.now,
    );
  }

  #insertReceipt(input: Readonly<{
    idempotencyKey: string;
    digest: string;
    operation: "create" | "edit" | "delete";
    sessionId: SessionId;
    taskId: SessionTaskId;
    result: SessionTaskRecord | SessionTaskDeleteResult;
    now: number;
  }>): void {
    const stored = input.operation === "delete"
      ? (() => {
          const result = sessionTaskDeleteResultSchema.parse(input.result);
          return {
            revision: result.revision,
            updatedAt: result.deletedAt,
            nextDueAt: null,
            deletedAt: result.deletedAt,
          };
        })()
      : (() => {
          const result = sessionTaskRecordSchema.parse(input.result);
          return {
            revision: result.revision,
            updatedAt: result.updatedAt,
            nextDueAt: result.nextDueAt,
            deletedAt: null,
          };
        })();
    this.#database.query(
      `INSERT INTO session_task_receipts(
         idempotency_key,request_digest,operation,session_id,task_id,
         result_revision,result_updated_at,result_next_due_at,result_deleted_at,
         result_json,created_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      input.idempotencyKey,
      input.digest,
      input.operation,
      input.sessionId,
      input.taskId,
      stored.revision,
      stored.updatedAt,
      stored.nextDueAt,
      stored.deletedAt,
      canonicalJson(input.result),
      input.now,
    );
  }

  list(sessionId: SessionId): readonly SessionTaskSummary[] {
    const parsedSessionId = sessionIdSchema.parse(sessionId);
    const exists = this.#database.query("SELECT 1 FROM sessions WHERE id=?").get(parsedSessionId);
    if (exists === null) throw new SessionTaskStoreError("SESSION_NOT_FOUND");
    return this.#database.query(
      `SELECT id,session_id,name,prompt,schedule_kind,interval_minutes,status,revision,
              next_due_at,created_at,updated_at,deleted_at
       FROM session_tasks
       WHERE session_id=? AND deleted_at IS NULL
       ORDER BY created_at,id`,
    ).all(parsedSessionId).map((row) => summarizeSessionTask(mapTask(row)));
  }

  /**
   * Every live conversation scheduled task across sessions, bounded, for the
   * device settings projection. This is a read-only listing: it takes no
   * idempotency receipt because it changes nothing.
   */
  listAll(limit: number): readonly SessionTaskSummary[] {
    const bounded = Math.max(1, Math.min(SESSION_TASK_LIMIT * 32, Math.trunc(limit)));
    return this.#database.query(
      `SELECT id,session_id,name,prompt,schedule_kind,interval_minutes,status,revision,
              next_due_at,created_at,updated_at,deleted_at
       FROM session_tasks
       WHERE deleted_at IS NULL
       ORDER BY created_at,id
       LIMIT ?`,
    ).all(bounded).map((row) => summarizeSessionTask(mapTask(row)));
  }

  listIdempotent(
    sessionId: SessionId,
    idempotencyKey: string,
    receiptDigest: string,
  ): SessionTaskList {
    const parsedSessionId = sessionIdSchema.parse(sessionId);
    const parsedIdempotencyKey = idempotencyKeySchema.parse(idempotencyKey);
    const digest = requestDigestSchema.parse(receiptDigest);
    let result: SessionTaskList | undefined;
    const read = this.#database.transaction(() => {
      const replay = this.#receipt({
        idempotencyKey: parsedIdempotencyKey,
        digest,
        operation: "list",
        sessionId: parsedSessionId,
      });
      if (replay !== null) {
        result = this.#replayList(replay);
        return;
      }
      const now = this.#nowTimestamp();
      result = sessionTaskListSchema.parse({
        scope: "conversation",
        sessionId: parsedSessionId,
        tasks: this.list(parsedSessionId),
      });
      this.#insertReadReceipt({
        idempotencyKey: parsedIdempotencyKey,
        digest,
        operation: "list",
        sessionId: parsedSessionId,
        result,
        now,
      });
    });
    try {
      read.immediate();
    } catch (error: unknown) {
      if (
        error instanceof Error
        && error.message.includes("SESSION_TASK_RECEIPT_CAPACITY")
      ) {
        throw new SessionTaskStoreError("RECEIPT_CAPACITY_EXHAUSTED");
      }
      throw error;
    }
    if (result === undefined) throw new Error("SESSION_TASK_LIST_RESULT_MISSING");
    return result;
  }

  require(sessionId: SessionId, taskId: SessionTaskId): SessionTaskRecord {
    return this.#requireTask(
      sessionIdSchema.parse(sessionId),
      sessionTaskIdSchema.parse(taskId),
    );
  }

  requireIdempotent(
    sessionId: SessionId,
    taskId: SessionTaskId,
    idempotencyKey: string,
    receiptDigest: string,
  ): SessionTaskRecord {
    const parsedSessionId = sessionIdSchema.parse(sessionId);
    const parsedTaskId = sessionTaskIdSchema.parse(taskId);
    const parsedIdempotencyKey = idempotencyKeySchema.parse(idempotencyKey);
    const digest = requestDigestSchema.parse(receiptDigest);
    let result: SessionTaskRecord | undefined;
    const read = this.#database.transaction(() => {
      const replay = this.#receipt({
        idempotencyKey: parsedIdempotencyKey,
        digest,
        operation: "view",
        sessionId: parsedSessionId,
        taskId: parsedTaskId,
      });
      if (replay !== null) {
        result = this.#replayView(replay);
        return;
      }
      const now = this.#nowTimestamp();
      result = this.#requireTask(parsedSessionId, parsedTaskId);
      this.#insertReadReceipt({
        idempotencyKey: parsedIdempotencyKey,
        digest,
        operation: "view",
        sessionId: parsedSessionId,
        taskId: parsedTaskId,
        result,
        now,
      });
    });
    try {
      read.immediate();
    } catch (error: unknown) {
      if (
        error instanceof Error
        && error.message.includes("SESSION_TASK_RECEIPT_CAPACITY")
      ) {
        throw new SessionTaskStoreError("RECEIPT_CAPACITY_EXHAUSTED");
      }
      throw error;
    }
    if (result === undefined) throw new Error("SESSION_TASK_VIEW_RESULT_MISSING");
    return result;
  }

  create(input: Readonly<{
    sessionId: SessionId;
    name: string;
    prompt: string;
    minutes: number;
    status: SessionTaskStatus;
    idempotencyKey: string;
    receiptDigest?: string;
  }>): SessionTaskRecord {
    const parsedInput = createInputSchema.parse(input);
    const { sessionId, name, prompt, minutes, status, idempotencyKey, receiptDigest } = parsedInput;
    const digest = receiptDigest
      ?? requestDigest({ operation: "create", sessionId, name, prompt, minutes, status });
    const taskId = createSessionTaskId();
    let result: SessionTaskRecord | undefined;
    const create = this.#database.transaction(() => {
      const replay = this.#receipt({
        idempotencyKey,
        digest,
        operation: "create",
        sessionId,
      });
      if (replay !== null) {
        result = this.#replayTask(replay);
        return;
      }
      if (this.#database.query("SELECT 1 FROM sessions WHERE id=?").get(sessionId) === null) {
        throw new SessionTaskStoreError("SESSION_NOT_FOUND");
      }
      const now = this.#nowTimestamp();
      const nextDueAt = status === "active" ? addInterval(now, minutes) : null;
      this.#database.query(
        `INSERT INTO session_tasks(
           id,session_id,name,prompt,schedule_kind,interval_minutes,status,revision,
           next_due_at,created_at,updated_at,deleted_at
         ) VALUES (?,?,?,?,'interval_minutes',?,?,1,?,?,?,NULL)`,
      ).run(taskId, sessionId, name, prompt, minutes, status, nextDueAt, now, now);
      result = this.#requireTask(sessionId, taskId);
      this.#insertReceipt({
        idempotencyKey,
        digest,
        operation: "create",
        sessionId,
        taskId,
        result,
        now,
      });
    });
    try {
      create.immediate();
    } catch (error: unknown) {
      if (error instanceof SessionTaskStoreError) throw error;
      if (error instanceof Error && error.message.includes("SESSION_TASK_LIMIT")) {
        throw new SessionTaskStoreError("TASK_LIMIT");
      }
      if (error instanceof Error && error.message.includes("SESSION_TASK_RECEIPT_CAPACITY")) {
        throw new SessionTaskStoreError("RECEIPT_CAPACITY_EXHAUSTED");
      }
      throw error;
    }
    if (result === undefined) throw new Error("SESSION_TASK_CREATE_RESULT_MISSING");
    return result;
  }

  edit(input: Readonly<{
    sessionId: SessionId;
    taskId: SessionTaskId;
    expectedRevision: number;
    patch: SessionTaskPatch;
    idempotencyKey: string;
    receiptDigest?: string;
  }>): SessionTaskRecord {
    const parsedInput = editInputSchema.parse(input);
    const {
      sessionId,
      taskId,
      expectedRevision,
      patch,
      idempotencyKey,
      receiptDigest,
    } = parsedInput;
    const digest = receiptDigest ?? requestDigest({
      operation: "edit", sessionId, taskId, expectedRevision, patch,
    });
    let result: SessionTaskRecord | undefined;
    const edit = this.#database.transaction(() => {
      const replay = this.#receipt({
        idempotencyKey,
        digest,
        operation: "edit",
        sessionId,
        taskId,
      });
      if (replay !== null) {
        result = this.#replayTask(replay);
        return;
      }
      const current = this.#requireTask(sessionId, taskId);
      if (current.revision !== expectedRevision) {
        throw new SessionTaskStoreError("REVISION_CONFLICT");
      }
      const name = patch.name ?? current.name;
      const prompt = patch.prompt ?? current.prompt;
      const minutes = patch.minutes ?? current.schedule.minutes;
      const status = patch.status ?? current.status;
      const changed = name !== current.name
        || prompt !== current.prompt
        || minutes !== current.schedule.minutes
        || status !== current.status;
      if (!changed) throw new SessionTaskStoreError("NO_CHANGES");
      const now = timestampAfter(this.#nowTimestamp(), current.updatedAt);
      const lastOccurrence = z.object({
        scheduled_for: safeTimestampSchema.nullable(),
      }).strict().parse(this.#database.query(
        `SELECT MAX(scheduled_for) AS scheduled_for
         FROM session_task_occurrences
         WHERE session_id=? AND task_id=?`,
      ).get(sessionId, taskId)).scheduled_for;
      const nextDueAt = status === "paused"
        ? null
        : current.status === "paused" || minutes !== current.schedule.minutes
          ? addInterval(Math.max(now, lastOccurrence ?? now), minutes)
          : current.nextDueAt;
      const updated = this.#database.query(
        `UPDATE session_tasks
         SET name=?,prompt=?,interval_minutes=?,status=?,revision=revision+1,
             next_due_at=?,updated_at=?
         WHERE id=? AND session_id=? AND deleted_at IS NULL AND revision=?`,
      ).run(
        name,
        prompt,
        minutes,
        status,
        nextDueAt,
        now,
        taskId,
        sessionId,
        expectedRevision,
      );
      if (updated.changes !== 1) throw new SessionTaskStoreError("REVISION_CONFLICT");
      result = this.#requireTask(sessionId, taskId);
      this.#insertReceipt({
        idempotencyKey,
        digest,
        operation: "edit",
        sessionId,
        taskId,
        result,
        now,
      });
    });
    try {
      edit.immediate();
    } catch (error: unknown) {
      if (
        error instanceof Error
        && error.message.includes("SESSION_TASK_RECEIPT_CAPACITY")
      ) {
        throw new SessionTaskStoreError("RECEIPT_CAPACITY_EXHAUSTED");
      }
      throw error;
    }
    if (result === undefined) throw new Error("SESSION_TASK_EDIT_RESULT_MISSING");
    return result;
  }

  delete(input: Readonly<{
    sessionId: SessionId;
    taskId: SessionTaskId;
    expectedRevision: number;
    idempotencyKey: string;
    receiptDigest?: string;
  }>): SessionTaskDeleteResult {
    const parsedInput = deleteInputSchema.parse(input);
    const { sessionId, taskId, expectedRevision, idempotencyKey, receiptDigest } = parsedInput;
    const digest = receiptDigest
      ?? requestDigest({ operation: "delete", sessionId, taskId, expectedRevision });
    let result: SessionTaskDeleteResult | undefined;
    const remove = this.#database.transaction(() => {
      const replay = this.#receipt({
        idempotencyKey,
        digest,
        operation: "delete",
        sessionId,
        taskId,
      });
      if (replay !== null) {
        result = this.#replayDelete(replay);
        return;
      }
      const current = this.#requireTask(sessionId, taskId);
      if (current.revision !== expectedRevision) {
        throw new SessionTaskStoreError("REVISION_CONFLICT");
      }
      const now = timestampAfter(this.#nowTimestamp(), current.updatedAt);
      const updated = this.#database.query(
        `UPDATE session_tasks
         SET status='paused',revision=revision+1,next_due_at=NULL,updated_at=?,deleted_at=?
         WHERE id=? AND session_id=? AND deleted_at IS NULL AND revision=?`,
      ).run(now, now, taskId, sessionId, expectedRevision);
      if (updated.changes !== 1) throw new SessionTaskStoreError("REVISION_CONFLICT");
      result = sessionTaskDeleteResultSchema.parse({
        scope: "conversation",
        sessionId,
        taskId,
        deleted: true,
        revision: expectedRevision + 1,
        deletedAt: now,
      });
      this.#insertReceipt({
        idempotencyKey,
        digest,
        operation: "delete",
        sessionId,
        taskId,
        result,
        now,
      });
    });
    try {
      remove.immediate();
    } catch (error: unknown) {
      if (
        error instanceof Error
        && error.message.includes("SESSION_TASK_RECEIPT_CAPACITY")
      ) {
        throw new SessionTaskStoreError("RECEIPT_CAPACITY_EXHAUSTED");
      }
      throw error;
    }
    if (result === undefined) throw new Error("SESSION_TASK_DELETE_RESULT_MISSING");
    return result;
  }

  nextDueAt(): number | null {
    const row = this.#database.query(
      `SELECT MIN(t.next_due_at) AS next_due_at
       FROM session_tasks t
       JOIN sessions s ON s.id=t.session_id
       ${currentSessionTaskAuthorityJoins}
       JOIN projects p ON p.id=s.project_id
       WHERE t.deleted_at IS NULL
         AND t.status='active'
         AND s.provider_thread_id IS NOT NULL
         AND s.state NOT IN ('terminal','recovery_required')
         ${currentSessionTaskAuthorityPredicate}
         AND NOT EXISTS(
           SELECT 1 FROM ${SESSION_SWITCH_FENCE_SOURCE} switch
           WHERE switch.session_id=t.session_id
             AND ${SESSION_SWITCH_BLOCKING_PREDICATE}
         )
         AND NOT EXISTS(
           SELECT 1
           FROM session_task_occurrences o
           JOIN queue_entries q ON q.id=o.queue_id
           WHERE o.task_id=t.id AND q.state IN ('pending','dispatching','ambiguous')
         )`,
    ).get();
    const parsed = z.object({ next_due_at: safeTimestampSchema.nullable() }).strict().parse(row);
    return parsed.next_due_at;
  }

  listOccurrences(
    sessionId: SessionId,
    taskId: SessionTaskId,
  ): readonly SessionTaskOccurrence[] {
    const parsedSessionId = sessionIdSchema.parse(sessionId);
    const parsedTaskId = sessionTaskIdSchema.parse(taskId);
    if (this.#database.query(
      "SELECT 1 FROM session_tasks WHERE session_id=? AND id=?",
    ).get(parsedSessionId, parsedTaskId) === null) {
      throw new SessionTaskStoreError("NOT_FOUND");
    }
    return this.#database.query(
      `SELECT task_id,session_id,task_revision,scheduled_for,coalesced_intervals,queue_id,created_at
       FROM session_task_occurrences
       WHERE session_id=? AND task_id=?
       ORDER BY scheduled_for`,
    ).all(parsedSessionId, parsedTaskId).map(mapOccurrence);
  }

  /**
   * Commits and returns at most one due occurrence. The caller must hand that
   * queue entry to the dispatcher before requesting another occurrence.
   */
  async materializeDue(input: Readonly<{
    now: number;
    daemonGeneration?: number;
  }>): Promise<readonly SessionTaskMaterialization[]> {
    const { now, daemonGeneration } = materializeInputSchema.parse(input);
    const enqueue = this.#enqueue;
    if (enqueue === undefined) throw new SessionTaskStoreError("ENQUEUE_UNAVAILABLE");
    const scanLimit = SESSION_TASK_LIMIT * 4;
    const cursor = this.#dueScanCursor;
    const candidates = this.#database.query(
      `SELECT
         t.id,t.session_id,t.name,t.prompt,t.schedule_kind,t.interval_minutes,t.status,
         t.revision,t.next_due_at,t.created_at,t.updated_at,t.deleted_at,
         p.root_path AS project_root,a.id AS profile_id,exact_account.process_generation,
         s.provider_v39 AS provider,s.provider_thread_id
       FROM session_tasks t
       JOIN sessions s ON s.id=t.session_id
       ${currentSessionTaskAuthorityJoins}
       JOIN projects p ON p.id=s.project_id
       WHERE t.deleted_at IS NULL
         AND t.status='active'
         AND t.next_due_at<=?
         AND s.provider_thread_id IS NOT NULL
         AND s.state NOT IN ('terminal','recovery_required')
         ${currentSessionTaskAuthorityPredicate}
         AND NOT EXISTS(
           SELECT 1 FROM ${SESSION_SWITCH_FENCE_SOURCE} switch
           WHERE switch.session_id=t.session_id
             AND ${SESSION_SWITCH_BLOCKING_PREDICATE}
         )
         AND (
           ? IS NULL
           OR t.next_due_at>?
           OR (t.next_due_at=? AND t.id>?)
         )
         AND NOT EXISTS(
           SELECT 1
           FROM session_task_occurrences o
           JOIN queue_entries q ON q.id=o.queue_id
           WHERE o.task_id=t.id AND q.state IN ('pending','dispatching','ambiguous')
         )
       ORDER BY t.next_due_at,t.id
       LIMIT ?`,
    ).all(
      now,
      cursor?.nextDueAt ?? null,
      cursor?.nextDueAt ?? null,
      cursor?.nextDueAt ?? null,
      cursor?.taskId ?? "",
      scanLimit,
    ).map((row) => dueCandidateRowSchema.parse(row));
    const materialized: SessionTaskMaterialization[] = [];
    let scanned = 0;
    for (const candidate of candidates) {
      if (materialized.length >= 1) break;
      scanned += 1;
      if (candidate.next_due_at === null) {
        throw new Error("SESSION_TASK_DUE_CANDIDATE_MISSING_DEADLINE");
      }
      const previousCursor = this.#dueScanCursor;
      const candidateCursor = {
        nextDueAt: candidate.next_due_at,
        taskId: candidate.id,
      };
      this.#dueScanCursor = candidateCursor;
      let executionAuthorityLive: boolean;
      try {
        executionAuthorityLive = this.#isExecutionAuthorityLive({
          processGeneration: candidate.process_generation,
          profileId: candidate.profile_id,
          provider: candidate.provider,
          providerThreadId: candidate.provider_thread_id,
          sessionId: candidate.session_id,
        });
      } catch (error: unknown) {
        if (this.#dueScanCursor === candidateCursor) this.#dueScanCursor = previousCursor;
        throw error;
      }
      if (!executionAuthorityLive) continue;
      let canonicalProject: string | null;
      try {
        canonicalProject = await this.#resolveProjectDirectory(candidate.project_root);
      } catch (error) {
        if (this.#dueScanCursor === candidateCursor) this.#dueScanCursor = previousCursor;
        throw error;
      }
      if (canonicalProject !== candidate.project_root) continue;
      let result: SessionTaskMaterialization | undefined;
      const materialize = this.#database.transaction(() => {
        if (daemonGeneration !== undefined) {
          const authority = z.object({
            generation: z.number().int().safe().nonnegative(),
          }).strict().parse(this.#database.query(
            "SELECT generation FROM daemon_state WHERE singleton=1",
          ).get());
          if (authority.generation !== daemonGeneration) {
            throw new SessionTaskStoreError("DAEMON_AUTHORITY_CHANGED");
          }
        }
        const authoritativeRow = this.#database.query(
          `SELECT
             t.id,t.session_id,t.name,t.prompt,t.schedule_kind,t.interval_minutes,t.status,
             t.revision,t.next_due_at,t.created_at,t.updated_at,t.deleted_at,
             p.root_path AS project_root,a.state AS profile_state,s.state AS session_state,
             a.id AS profile_id,exact_account.process_generation,s.provider_v39 AS provider,
             s.provider_thread_id
           FROM session_tasks t
           JOIN sessions s ON s.id=t.session_id
           ${currentSessionTaskAuthorityJoins}
           JOIN projects p ON p.id=s.project_id
           WHERE t.id=?
             AND t.session_id=?
             AND t.deleted_at IS NULL
             AND t.status='active'
             AND t.next_due_at<=?
             AND s.provider_thread_id IS NOT NULL
             AND s.state NOT IN ('terminal','recovery_required')
             ${currentSessionTaskAuthorityPredicate}
             AND NOT EXISTS(
               SELECT 1 FROM ${SESSION_SWITCH_FENCE_SOURCE} switch
               WHERE switch.session_id=t.session_id
                 AND ${SESSION_SWITCH_BLOCKING_PREDICATE}
             )
             AND NOT EXISTS(
               SELECT 1
               FROM session_task_occurrences o
               JOIN queue_entries q ON q.id=o.queue_id
               WHERE o.task_id=t.id AND q.state IN ('pending','dispatching','ambiguous')
             )`,
        ).get(candidate.id, candidate.session_id, now);
        if (authoritativeRow === null) return;
        const authoritative = eligibleDueTaskRowSchema.parse(authoritativeRow);
        if (
          authoritative.revision !== candidate.revision
          || authoritative.next_due_at !== candidate.next_due_at
          || authoritative.project_root !== canonicalProject
        ) return;
        if (!this.#isExecutionAuthorityLive({
          processGeneration: authoritative.process_generation,
          profileId: authoritative.profile_id,
          provider: authoritative.provider,
          providerThreadId: authoritative.provider_thread_id,
          sessionId: authoritative.session_id,
        })) return;
        const scheduledFor = authoritative.next_due_at;
        if (scheduledFor === null) return;
        const { coalescedIntervals, nextDueAt } = nextSlotAfter(
          scheduledFor,
          now,
          authoritative.interval_minutes,
        );
        // Queue sequence, mutation ownership, provider authority and empty
        // attachment identity belong to StateStore, in this same transaction.
        const enqueued = pendingQueueSchema.safeParse(enqueue(authoritative.session_id, authoritative.prompt));
        if (!enqueued.success) throw new SessionTaskStoreError("ENQUEUE_INVALID");
        const queue = enqueued.data;
        const durable = pendingQueueSchema.safeParse(this.#database.query(
          `SELECT id,session_id AS sessionId,message,state,created_at AS createdAt,updated_at AS updatedAt
           FROM queue_entries WHERE id=?`,
        ).get(queue.id));
        if (queue.sessionId !== authoritative.session_id || queue.message !== authoritative.prompt
          || !durable.success || JSON.stringify(durable.data) !== JSON.stringify(queue)) {
          throw new SessionTaskStoreError("ENQUEUE_INVALID");
        }
        const queueId = queue.id;
        this.#database.query(
          `INSERT INTO session_task_occurrences(
             task_id,session_id,task_revision,scheduled_for,coalesced_intervals,queue_id,created_at
           ) VALUES (?,?,?,?,?,?,?)`,
        ).run(
          authoritative.id,
          authoritative.session_id,
          authoritative.revision,
          scheduledFor,
          coalescedIntervals,
          queueId,
          queue.createdAt,
        );
        const advanced = this.#database.query(
          `UPDATE session_tasks
           SET next_due_at=?
           WHERE id=? AND session_id=? AND deleted_at IS NULL AND status='active'
             AND revision=? AND next_due_at=?`,
        ).run(
          nextDueAt,
          authoritative.id,
          authoritative.session_id,
          authoritative.revision,
          scheduledFor,
        );
        if (advanced.changes !== 1) throw new Error("SESSION_TASK_DUE_ADVANCE_CAS_CONFLICT");
        result = {
          task: this.#requireTask(authoritative.session_id, authoritative.id),
          occurrence: sessionTaskOccurrenceSchema.parse({
            sessionId: authoritative.session_id,
            taskId: authoritative.id,
            taskRevision: authoritative.revision,
            scheduledFor,
            coalescedIntervals,
            queueId,
            createdAt: queue.createdAt,
          }),
          queue,
        };
      });
      try {
        materialize.immediate();
      } catch (error) {
        if (this.#dueScanCursor === candidateCursor) this.#dueScanCursor = previousCursor;
        throw error;
      }
      if (result !== undefined) materialized.push(result);
    }
    if (scanned === candidates.length && candidates.length < scanLimit) {
      this.#dueScanCursor = null;
    }
    return materialized;
  }
}
