import { createHash, randomUUID } from "node:crypto";

import type { Database } from "bun:sqlite";
import { z } from "zod";

import {
  assertLegacyCanonicalProfileStorageSchema,
  deriveLegacySessionProfileKey,
  deriveLegacyWorkProfileKey,
} from "./canonical-profile-storage";

import {
  devinPresetContract,
  isReboundCodexPreset,
  sharedActiveCodexPresetContract,
  type Provider,
} from "../domain/presets";
import { isUuidV7 } from "../domain/uuid-v7";
import { providerAccountAuthoritySchema } from "../domain/provider-accounts";
import { workReadSuccessWireBytes } from "../domain/terminal-json";
import { workPreparedEffectMessage } from "../domain/work-message";
import { MESSAGE_MAX_BYTES, sessionIdSchema } from "../domain/values";
import { assertLegacyMutationOwnership, SessionSendOwnershipError } from "./session-send-owner";
import { normalizeSchemaSql } from "./schema-cohort";
import {
  CANONICAL_40_WORK_AUTHORITY_TRIGGER_DEFINITIONS,
  CANONICAL_49_WORK_PRESET_GUARD_DEFINITIONS,
  CANONICAL_WORK_NON_AUTHORITY_TRIGGER_DEFINITIONS,
} from "./canonical49-work-schema";
import {
  CANONICAL_WORK_CLOCK_SEED_SQL,
  CANONICAL_WORK_CORE_DEFINITIONS,
} from "./canonical-work-core-schema";
import {
  verifyWorkEvidence,
  WorkEvidenceVerificationError,
} from "./work-evidence";

import {
  WORK_ACTIVE_LIMIT,
  WORK_APPLY_REQUEST_LEGACY_VERSION,
  WORK_APPLY_REQUEST_VERSION,
  WORK_EVIDENCE_LIMIT,
  WORK_EVENT_PAGE_LIMIT,
  WORK_EVENT_PAGE_MAX_BYTES,
  WORK_HISTORY_EVENT_LIMIT,
  WORK_HISTORY_RECOVERY_RESERVE,
  WORK_MEMBER_LIMIT,
  WORK_OPERATION_BATCH_LIMIT,
  WORK_OPERATION_MAX_BYTES,
  WORK_PLAN_TASK_LIMIT,
  WORK_POLL_ITEM_LIMIT,
  WORK_POLL_MAX_BYTES,
  WORK_PREPARED_EFFECT_MAX_BYTES,
  WORK_PROTOCOL_DESCRIPTION,
  WORK_READ_HISTORY_LIMIT,
  WORK_RETAINED_LIMIT,
  WORK_ROUTE_LIMIT,
  WORK_SNAPSHOT_MAX_BYTES,
  WORK_TASK_DETAIL_MAX_BYTES,
  WORK_TASK_HISTORY_ITEM_LIMIT,
  WORK_TASK_HISTORY_PAGE_MAX_BYTES,
  WORK_TASK_HISTORY_TOTAL_ITEM_LIMIT,
  WORK_TASK_HISTORY_VERSION_LIMIT,
  WORK_TOMBSTONE_LIMIT,
  WORK_TOMBSTONE_MAX_AGE_MS,
  WORK_TOMBSTONE_MAX_BYTES,
  WORK_TASK_DEPTH_LIMIT as DOMAIN_WORK_TASK_DEPTH_LIMIT,
  createWorkAttemptId,
  createWorkId,
  createWorkReviewId,
  createWorkSignalId,
  createWorkSubmissionId,
  createWorkTaskId,
  currentWorkApplyRequestSource,
  workEventBodySchema,
  workEventSchema,
  workEventPageSchema,
  workActionCursorPayloadSchema,
  workCapabilitySchema,
  workIdSchema,
  workSignalIdSchema,
  workNestedEffectReceiptSchema,
  workOperationResultSchema,
  workOperationSchema,
  workOperationRequiresPresetContract,
  workPollSchema,
  workPreparedEffectSchema,
  workPreparedEffectStatusSchema,
  workReleaseTombstoneSchema,
  workSnapshotSchema,
  workTaskDetailSchema,
  workTaskHistoryCursorPayloadSchema,
  workTaskHistoryPageSchema,
  workTaskHistoryItemSchema,
  type WorkEvent,
  type WorkEventBody,
  type WorkActionCursorPayload,
  type WorkEvidence,
  type WorkEventPage as DomainWorkEventPage,
  type WorkOperation,
  type WorkOperationResult,
  type WorkApplyRequestSource,
  type WorkAttemptRecord,
  type WorkAttemptReportRecord,
  type WorkPoll,
  type WorkPreparedEffect,
  type WorkPreparedEffectStatus,
  type WorkNestedEffectReceipt,
  type WORK_PROTOCOL,
  type WORK_PROTOCOL_VERSION,
  type WorkProtocolDescription,
  type WorkRecord,
  type WorkReleaseTombstone,
  type WorkReviewRecord,
  type WorkSignalRecord,
  type WorkSnapshot,
  type WorkSubmissionRecord,
  type WorkTaskDetail,
  type WorkTaskHistoryCounts,
  type WorkTaskHistoryCursorPayload,
  type WorkTaskHistoryItem,
  type WorkTaskHistoryPage,
  type WorkTaskSummary,
  type WorkTaskSpec,
  type WorkTerminalProjection,
} from "../domain/work";

const WORK_TASK_BATCH_LIMIT = WORK_OPERATION_BATCH_LIMIT;
const WORK_TASK_TOTAL_LIMIT = WORK_PLAN_TASK_LIMIT;
const WORK_TASK_DEPTH_LIMIT = DOMAIN_WORK_TASK_DEPTH_LIMIT;
const WORK_PAGE_LIMIT = WORK_EVENT_PAGE_LIMIT;
const WORK_POLL_DEFAULT_LIMIT = 50;
const WORK_POLL_LIMIT = WORK_POLL_ITEM_LIMIT;
const WORK_SESSION_AUTHORITY_CHANGE_LIMIT = 500;

/**
 * One closed provider-authority predicate for every Work admission and
 * recheck. The optional expression is a SQL boolean such as an exact captured
 * profile-generation match. Provider additions must extend the final branch;
 * an unknown provider never inherits Codex or Claude authority.
 */
const currentWorkSessionAuthorityExistsSql = (
  sessionIdExpression: string,
  generationPredicate = "",
): string => `EXISTS (
  SELECT 1
  FROM sessions AS authority_session
  JOIN profiles AS authority_profile ON authority_profile.id=authority_session.profile_id
  JOIN session_provider_authorities AS captured_authority
    ON captured_authority.session_id=authority_session.id
      AND captured_authority.profile_id=authority_session.profile_id
      AND captured_authority.provider=authority_session.provider_v39
  JOIN provider_accounts AS exact_account
    ON exact_account.id=captured_authority.provider_account_id
      AND exact_account.profile_id=captured_authority.profile_id
      AND exact_account.provider=captured_authority.provider
      AND exact_account.binding_generation=captured_authority.binding_generation
      AND exact_account.process_generation=captured_authority.process_generation
  LEFT JOIN session_provider_account_authorities AS provider_authority
    ON provider_authority.session_id=authority_session.id
      AND provider_authority.provider=authority_session.provider_v39
  WHERE authority_session.id=${sessionIdExpression}
    AND authority_session.state IN ('active','idle')
    AND authority_profile.state!='removed'
    AND (exact_account.readiness='signed_in' OR (
      captured_authority.provider IN ('claude','devin')
      AND exact_account.readiness='unverified'
      AND captured_authority.routing_provenance='explicit'
    ))
    ${generationPredicate.length === 0 ? "" : `AND (${generationPredicate})`}
    AND NOT EXISTS (
      SELECT 1 FROM provider_runtime_account_revocations AS authority_revocation
      WHERE authority_revocation.profile_id=authority_session.profile_id
        AND (authority_revocation.provider='claude'
          OR authority_revocation.profile_generation=captured_authority.process_generation)
        AND authority_revocation.provider=authority_session.provider_v39
        AND authority_revocation.runtime_scope=provider_authority.runtime_scope
        AND (
          authority_revocation.state='releasing'
          OR authority_revocation.current_account_key IS NULL
          OR authority_revocation.current_account_key!=provider_authority.account_key
        )
    )
    AND (
      (provider_authority.runtime_scope='personal' AND EXISTS (
        SELECT 1 FROM session_personal_runtime_bindings AS authority_binding
        WHERE authority_binding.session_id=authority_session.id
          AND authority_binding.provider=authority_session.provider_v39
          AND authority_binding.provider_thread_id=authority_session.provider_thread_id
          AND authority_binding.state='active'
      ))
      OR (provider_authority.runtime_scope='managed' AND NOT EXISTS (
        SELECT 1 FROM session_personal_runtime_bindings AS authority_binding
        WHERE authority_binding.session_id=authority_session.id
          AND authority_binding.state IN ('active','detaching')
      ))
      OR (authority_session.provider_v39='devin' AND NOT EXISTS (
        SELECT 1 FROM session_personal_runtime_bindings AS authority_binding
        WHERE authority_binding.session_id=authority_session.id
          AND authority_binding.state IN ('active','detaching')
      ))
    )
    AND (
      (authority_session.provider_v39='claude'
        AND authority_profile.state!='removed')
      OR (authority_session.provider_v39='codex'
        AND authority_profile.state='signed_in'
        AND authority_profile.provider_email IS NOT NULL
        AND authority_profile.codex_account_key=provider_authority.account_key
        AND EXISTS (
          SELECT 1 FROM session_account_authorities AS legacy_authority
          WHERE legacy_authority.session_id=authority_session.id
            AND legacy_authority.profile_id=authority_session.profile_id
            AND legacy_authority.account_key IS NOT NULL
            AND legacy_authority.account_key=lower(trim(authority_profile.provider_email))
        ))
      OR (authority_session.provider_v39='devin'
        AND authority_profile.state!='removed')
    )
)`;

const workSignalProviderAuthorityObjects = [
  { name: "work_signal_provider_authorities", type: "table", sql: `CREATE TABLE IF NOT EXISTS work_signal_provider_authorities (
    signal_id TEXT PRIMARY KEY REFERENCES work_signals(id) ON DELETE CASCADE,
    work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
    target_session_id TEXT NOT NULL REFERENCES sessions(id),
    provider_account_id TEXT NOT NULL REFERENCES provider_accounts(id),
    profile_id TEXT NOT NULL REFERENCES profiles(id),
    provider TEXT NOT NULL CHECK(provider IN ('codex','claude','devin')),
    binding_generation INTEGER NOT NULL CHECK(binding_generation BETWEEN 1 AND 9007199254740991),
    process_generation INTEGER NOT NULL CHECK(process_generation BETWEEN 0 AND 9007199254740991),
    session_authority_revision INTEGER NOT NULL CHECK(session_authority_revision BETWEEN 1 AND 9007199254740991),
    authority_digest TEXT NOT NULL CHECK(length(authority_digest)=64 AND authority_digest NOT GLOB '*[^a-f0-9]*'),
    provenance TEXT NOT NULL CHECK(provenance='signal_prepare'),
    recorded_at INTEGER NOT NULL CHECK(recorded_at BETWEEN 0 AND 9007199254740991)
  ) STRICT;` },
  { name: "work_signal_provider_authority_insert_guard", type: "trigger", sql: `CREATE TRIGGER IF NOT EXISTS work_signal_provider_authority_insert_guard
    BEFORE INSERT ON work_signal_provider_authorities
    WHEN NOT EXISTS (
      SELECT 1 FROM work_signals signal
      JOIN sessions session ON session.id=signal.to_session_id
      JOIN session_provider_authorities captured ON captured.session_id=session.id
      JOIN provider_accounts account ON account.id=captured.provider_account_id
      JOIN profiles profile ON profile.id=session.profile_id
      WHERE signal.id=NEW.signal_id AND signal.work_id=NEW.work_id
        AND signal.to_session_id=NEW.target_session_id
        AND session.profile_id=NEW.profile_id AND session.provider_v39=NEW.provider
        AND session.state IN ('active','idle') AND profile.state!='removed'
        AND captured.provider_account_id=NEW.provider_account_id
        AND captured.profile_id=NEW.profile_id AND captured.provider=NEW.provider
        AND captured.binding_generation=NEW.binding_generation
        AND captured.process_generation=NEW.process_generation
        AND captured.authority_revision=NEW.session_authority_revision
        AND account.profile_id=NEW.profile_id AND account.provider=NEW.provider
        AND account.binding_generation=NEW.binding_generation
        AND account.process_generation=NEW.process_generation AND account.readiness!='removed'
    )
    BEGIN SELECT RAISE(ABORT,'WORK_SIGNAL_PROVIDER_AUTHORITY_MISMATCH'); END;` },
  { name: "work_signal_provider_authority_no_update", type: "trigger", sql: `CREATE TRIGGER IF NOT EXISTS work_signal_provider_authority_no_update
    BEFORE UPDATE ON work_signal_provider_authorities
    BEGIN SELECT RAISE(ABORT,'WORK_SIGNAL_PROVIDER_AUTHORITY_IMMUTABLE'); END;` },
  { name: "work_signal_provider_authority_no_delete", type: "trigger", sql: `CREATE TRIGGER IF NOT EXISTS work_signal_provider_authority_no_delete
    BEFORE DELETE ON work_signal_provider_authorities
    WHEN NOT EXISTS (SELECT 1 FROM work_purge_authority WHERE work_id=OLD.work_id)
    BEGIN SELECT RAISE(ABORT,'WORK_SIGNAL_PROVIDER_AUTHORITY_IMMUTABLE'); END;` },
] as const;

/** Additive provider-account migration objects; never part of the released Work v1 wire. */
export const WORK_SIGNAL_PROVIDER_AUTHORITY_SCHEMA_SQL = workSignalProviderAuthorityObjects
  .map((object) => object.sql).join("\n");

const workSignalProviderAuthorityRowSchema = z.object({
  signal_id: workSignalIdSchema,
  work_id: workIdSchema,
  target_session_id: sessionIdSchema,
  provider_account_id: z.string(),
  profile_id: z.string(),
  provider: z.enum(["codex", "claude", "devin"]),
  binding_generation: z.number().int().positive().safe(),
  process_generation: z.number().int().nonnegative().safe(),
  session_authority_revision: z.number().int().positive().safe(),
  authority_digest: z.string().regex(/^[a-f0-9]{64}$/u),
  provenance: z.literal("signal_prepare"),
  recorded_at: z.number().int().nonnegative().safe(),
}).strict();
type WorkSignalProviderAuthorityRow = z.infer<typeof workSignalProviderAuthorityRowSchema>;
const signalProviderAuthorityDigest = (row: Omit<WorkSignalProviderAuthorityRow, "authority_digest">): string =>
  createHash("sha256").update(JSON.stringify({
    domain: "hra:work-signal-provider-authority:v1",
    signalId: row.signal_id,
    workId: row.work_id,
    targetSessionId: row.target_session_id,
    authority: providerAccountAuthoritySchema.parse({
      providerAccountId: row.provider_account_id,
      profileId: row.profile_id,
      provider: row.provider,
      bindingGeneration: row.binding_generation,
      processGeneration: row.process_generation,
    }),
    sessionAuthorityRevision: row.session_authority_revision,
    provenance: row.provenance,
    recordedAt: row.recorded_at,
  })).digest("hex");

const parseWorkSignalProviderAuthority = (value: unknown): WorkSignalProviderAuthorityRow => {
  const row = workSignalProviderAuthorityRowSchema.parse(value);
  if (row.authority_digest !== signalProviderAuthorityDigest(row)) {
    throw new Error("WORK_SIGNAL_PROVIDER_AUTHORITY_CORRUPT");
  }
  return row;
};

export function backfillLegacyWorkSignalProviderAuthorities(database: Database, migratedAt: number): void {
  // Released signals did not freeze a session authority revision. Even a
  // nested runtime document cannot prove that missing binding: retain the
  // instruction bytes and quarantine execution instead of guessing a route.
  database.query(`INSERT OR IGNORE INTO legacy_provider_authority_quarantines(
    scope_kind,scope_id,reason,recorded_at
  ) SELECT 'work_signal',signal.id,'missing_immutable_runtime_authority',?
    FROM work_signals signal
    WHERE NOT EXISTS(SELECT 1 FROM work_signal_provider_authorities authority WHERE authority.signal_id=signal.id)`)
    .run(z.number().int().nonnegative().safe().parse(migratedAt));
}

export function assertWorkSignalProviderAuthorities(database: Database): void {
  for (const object of workSignalProviderAuthorityObjects) {
    const actual = database.query("SELECT sql FROM sqlite_master WHERE type=? AND name=?")
      .get(object.type, object.name) as { sql: string } | null;
    if (actual === null || normalizeSchemaSql(actual.sql) !== normalizeSchemaSql(object.sql)) {
      throw new Error("WORK_SIGNAL_PROVIDER_AUTHORITY_SCHEMA_INVALID");
    }
  }
  if (database.query(`SELECT 1 FROM work_signals signal
    WHERE NOT EXISTS(SELECT 1 FROM work_signal_provider_authorities authority WHERE authority.signal_id=signal.id)
      AND NOT EXISTS(SELECT 1 FROM legacy_provider_authority_quarantines quarantine
        WHERE quarantine.scope_kind='work_signal' AND quarantine.scope_id=signal.id)
    LIMIT 1`).get() !== null) throw new Error("WORK_SIGNAL_PROVIDER_AUTHORITY_MISSING");
  let after = "";
  for (;;) {
    const rows = database.query("SELECT * FROM work_signal_provider_authorities WHERE signal_id>? ORDER BY signal_id LIMIT 100")
      .all(after);
    if (rows.length === 0) break;
    for (const value of rows) {
      const row = parseWorkSignalProviderAuthority(value);
      if (database.query("SELECT 1 FROM work_signals WHERE id=? AND work_id=? AND to_session_id=?")
        .get(row.signal_id, row.work_id, row.target_session_id) === null) {
        throw new Error("WORK_SIGNAL_PROVIDER_AUTHORITY_MISMATCH");
      }
      after = row.signal_id;
    }
  }
}
/** Runtime admission is narrower than the immutable v40 schema's historical identities. */
// Work routes are Codex low/high/ultra. High and Ultra share this active
// contract, while Low is byte-identical across both frozen contracts.
const ACTIVE_WORK_PRESET_CONTRACT = sharedActiveCodexPresetContract();

const normalizeWorkApplyRequestSource = (
  operation: WorkOperation,
  source: WorkApplyRequestSource | undefined,
): WorkApplyRequestSource => {
  const candidate: unknown = source ?? currentWorkApplyRequestSource(operation);
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new WorkStoreError("ROUTE_MISMATCH");
  }
  const record = candidate as Readonly<Record<string, unknown>>;
  if (record.version === WORK_APPLY_REQUEST_LEGACY_VERSION) {
    if (Object.keys(record).length !== 1) throw new WorkStoreError("ROUTE_MISMATCH");
    return { version: WORK_APPLY_REQUEST_LEGACY_VERSION };
  }
  if (
    record.version !== WORK_APPLY_REQUEST_VERSION
    || Object.keys(record).some((key) => key !== "version" && key !== "presetContract")
    || (record.presetContract !== undefined
      && record.presetContract !== 1
      && record.presetContract !== 2)
  ) {
    throw new WorkStoreError("ROUTE_MISMATCH");
  }
  return {
    version: WORK_APPLY_REQUEST_VERSION,
    ...(record.presetContract === undefined
      ? {}
      : { presetContract: record.presetContract }),
  };
};

const workApplyRequestDigest = (
  operation: WorkOperation,
  source: WorkApplyRequestSource,
): string => source.version === WORK_APPLY_REQUEST_LEGACY_VERSION
  ? digestJson(operation)
  : digestJson({
      requestVersion: source.version,
      ...(source.presetContract === undefined
        ? {}
        : { presetContract: source.presetContract }),
      operation,
    });

export const WORK_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS work_clock (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  logical_time INTEGER NOT NULL CHECK(logical_time >= 0)
) STRICT;
INSERT OR IGNORE INTO work_clock(singleton,logical_time) VALUES (1,0);

CREATE TABLE IF NOT EXISTS work_purge_authority (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  work_id TEXT NOT NULL UNIQUE CHECK(length(work_id) BETWEEN 6 AND 80),
  idempotency_key TEXT NOT NULL UNIQUE CHECK(length(idempotency_key)=36),
  created_at INTEGER NOT NULL CHECK(created_at>=0)
) STRICT;

CREATE TABLE IF NOT EXISTS work_release_tombstones (
  work_id TEXT PRIMARY KEY CHECK(length(work_id) BETWEEN 6 AND 80),
  release_idempotency_key TEXT NOT NULL UNIQUE CHECK(length(release_idempotency_key)=36),
  release_request_digest TEXT NOT NULL CHECK(length(release_request_digest)=64 AND release_request_digest NOT GLOB '*[^0-9a-f]*'),
  client_ref_digest TEXT NOT NULL UNIQUE CHECK(length(client_ref_digest)=64 AND client_ref_digest NOT GLOB '*[^0-9a-f]*'),
  coordinator_session_id TEXT NOT NULL CHECK(length(coordinator_session_id) BETWEEN 6 AND 80),
  terminal_kind TEXT NOT NULL CHECK(terminal_kind IN ('work.complete','work.fail','work.cancel')),
  terminal_request_digest TEXT NOT NULL CHECK(length(terminal_request_digest)=64 AND terminal_request_digest NOT GLOB '*[^0-9a-f]*'),
  final_revision INTEGER NOT NULL CHECK(final_revision>0),
  final_head_hash TEXT NOT NULL CHECK(length(final_head_hash)=64 AND final_head_hash NOT GLOB '*[^0-9a-f]*'),
  discarded_counts_json TEXT NOT NULL CHECK(json_valid(discarded_counts_json) AND length(CAST(discarded_counts_json AS BLOB))<=4096),
  discarded_records_digest TEXT NOT NULL CHECK(length(discarded_records_digest)=64 AND discarded_records_digest NOT GLOB '*[^0-9a-f]*'),
  released_at INTEGER NOT NULL CHECK(released_at>=0),
  retention_upper_bound_at INTEGER NOT NULL CHECK(retention_upper_bound_at>=released_at),
  result_json TEXT NOT NULL CHECK(json_valid(result_json) AND length(CAST(result_json AS BLOB))<=65536)
) STRICT;
CREATE INDEX IF NOT EXISTS work_release_tombstones_retention
  ON work_release_tombstones(released_at,work_id);
CREATE TRIGGER IF NOT EXISTS work_release_tombstones_no_update
BEFORE UPDATE ON work_release_tombstones
BEGIN SELECT RAISE(ABORT,'WORK_RELEASE_TOMBSTONE_IMMUTABLE'); END;

CREATE TABLE IF NOT EXISTS works (
  id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 6 AND 80),
  client_ref TEXT NOT NULL UNIQUE CHECK(length(CAST(client_ref AS BLOB)) BETWEEN 1 AND 256),
  coordinator_session_id TEXT NOT NULL REFERENCES sessions(id),
  objective TEXT NOT NULL CHECK(length(CAST(objective AS BLOB)) BETWEEN 1 AND 16384),
  preset_contract INTEGER NOT NULL DEFAULT 1 CHECK(preset_contract IN (1,2)),
  state TEXT NOT NULL CHECK(state IN ('active','cancel_pending','fail_pending','completed','failed','cancelled')),
  revision INTEGER NOT NULL CHECK(revision >= 0),
  stream_epoch TEXT NOT NULL CHECK(length(stream_epoch) = 36),
  next_sequence INTEGER NOT NULL CHECK(next_sequence > 0),
  head_hash TEXT CHECK(head_hash IS NULL OR (length(head_hash) = 64 AND head_hash NOT GLOB '*[^0-9a-f]*')),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  updated_at INTEGER NOT NULL CHECK(updated_at >= created_at),
  CHECK((next_sequence = 1 AND head_hash IS NULL) OR (next_sequence > 1 AND head_hash IS NOT NULL))
) STRICT;
CREATE TRIGGER IF NOT EXISTS work_active_limit_guard
BEFORE INSERT ON works
WHEN NEW.state IN ('active','cancel_pending','fail_pending') AND (
  SELECT COUNT(*) FROM works WHERE state IN ('active','cancel_pending','fail_pending')
) >= ${WORK_ACTIVE_LIMIT}
BEGIN SELECT RAISE(ABORT,'WORK_ACTIVE_LIMIT'); END;
CREATE TRIGGER IF NOT EXISTS work_retained_limit_guard
BEFORE INSERT ON works
WHEN (SELECT COUNT(*) FROM works) >= ${WORK_RETAINED_LIMIT}
BEGIN SELECT RAISE(ABORT,'WORK_RETAINED_LIMIT'); END;
DROP TRIGGER IF EXISTS work_devin_preset_contract_guard;
CREATE TRIGGER work_devin_preset_contract_guard
BEFORE INSERT ON works
WHEN NEW.preset_contract!=${ACTIVE_WORK_PRESET_CONTRACT}
BEGIN SELECT RAISE(ABORT,'WORK_PRESET_CONTRACT_MISMATCH'); END;
DROP TRIGGER IF EXISTS work_session_devin_contract_guard;
CREATE TRIGGER work_session_devin_contract_guard
BEFORE UPDATE OF provider_v39,preset_contract ON sessions
WHEN NEW.provider_v39='devin' AND (
  NEW.preset_contract!=${devinPresetContract}
  OR EXISTS (
    SELECT 1 FROM works AS w
    WHERE w.coordinator_session_id=NEW.id
      AND w.preset_contract!=${devinPresetContract}
  )
)
BEGIN SELECT RAISE(ABORT,'WORK_DEVIN_PRESET_CONTRACT_MISMATCH'); END;
DROP TRIGGER IF EXISTS work_coordinator_account_authority_guard;
CREATE TRIGGER work_coordinator_account_authority_guard
BEFORE INSERT ON works
WHEN NOT ${currentWorkSessionAuthorityExistsSql("NEW.coordinator_session_id")}
BEGIN SELECT RAISE(ABORT,'WORK_COORDINATOR_AUTHORITY_MISMATCH'); END;

CREATE TABLE IF NOT EXISTS work_routes (
  work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0 AND ordinal < ${WORK_ROUTE_LIMIT}),
  account_id TEXT NOT NULL REFERENCES profiles(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  preset TEXT NOT NULL CHECK(preset IN ('low','high','ultra')),
  fast INTEGER NOT NULL CHECK(fast IN (0,1)),
  PRIMARY KEY(work_id,account_id,project_id,preset,fast),
  UNIQUE(work_id,ordinal)
) STRICT;

CREATE TABLE IF NOT EXISTS work_members (
  work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  joined_at INTEGER NOT NULL CHECK(joined_at >= 0),
  PRIMARY KEY(work_id,session_id)
) STRICT;

CREATE TABLE IF NOT EXISTS work_tasks (
  id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 6 AND 80),
  work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  client_ref TEXT NOT NULL CHECK(length(CAST(client_ref AS BLOB)) BETWEEN 1 AND 256),
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0 AND ordinal < ${WORK_PLAN_TASK_LIMIT}),
  parent_task_id TEXT,
  depth INTEGER NOT NULL CHECK(depth BETWEEN 1 AND ${DOMAIN_WORK_TASK_DEPTH_LIMIT}),
  objective TEXT NOT NULL CHECK(length(CAST(objective AS BLOB)) BETWEEN 1 AND 16384),
  instructions TEXT NOT NULL CHECK(length(CAST(instructions AS BLOB)) BETWEEN 1 AND 32768),
  criteria_json TEXT NOT NULL CHECK(json_valid(criteria_json) AND length(CAST(criteria_json AS BLOB)) <= 32768),
  account_id TEXT NOT NULL REFERENCES profiles(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  preset TEXT NOT NULL CHECK(preset IN ('low','high','ultra')),
  fast INTEGER NOT NULL CHECK(fast IN (0,1)),
  priority INTEGER NOT NULL CHECK(priority BETWEEN -100 AND 100),
  not_before INTEGER CHECK(not_before IS NULL OR not_before >= 0),
  claim_by INTEGER CHECK(claim_by IS NULL OR claim_by >= 0),
  deadline INTEGER CHECK(deadline IS NULL OR deadline >= 0),
  max_attempts INTEGER NOT NULL CHECK(max_attempts BETWEEN 1 AND ${WORK_OPERATION_BATCH_LIMIT}),
  required_reviews INTEGER NOT NULL CHECK(required_reviews BETWEEN 0 AND ${WORK_EVIDENCE_LIMIT}),
  result_kind TEXT NOT NULL CHECK(result_kind IN ('text','json')),
  min_evidence INTEGER NOT NULL CHECK(min_evidence BETWEEN 0 AND ${WORK_EVIDENCE_LIMIT}),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  UNIQUE(work_id,id),
  UNIQUE(work_id,client_ref),
  FOREIGN KEY(work_id,parent_task_id) REFERENCES work_tasks(work_id,id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(work_id,account_id,project_id,preset,fast)
    REFERENCES work_routes(work_id,account_id,project_id,preset,fast) ON DELETE CASCADE,
  CHECK(parent_task_id IS NULL OR parent_task_id != id),
  CHECK(claim_by IS NULL OR not_before IS NULL OR claim_by > not_before),
  CHECK(deadline IS NULL OR not_before IS NULL OR deadline > not_before),
  CHECK(deadline IS NULL OR claim_by IS NULL OR deadline >= claim_by)
) STRICT;
CREATE INDEX IF NOT EXISTS work_tasks_order ON work_tasks(work_id,priority DESC,ordinal,id);
CREATE INDEX IF NOT EXISTS work_tasks_parent ON work_tasks(work_id,parent_task_id,ordinal,id);

CREATE TABLE IF NOT EXISTS work_task_dependencies (
  work_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  dependency_task_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0 AND ordinal < 16),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  PRIMARY KEY(work_id,task_id,dependency_task_id),
  UNIQUE(work_id,task_id,ordinal),
  FOREIGN KEY(work_id,task_id) REFERENCES work_tasks(work_id,id) ON DELETE CASCADE,
  FOREIGN KEY(work_id,dependency_task_id) REFERENCES work_tasks(work_id,id) ON DELETE CASCADE,
  CHECK(task_id != dependency_task_id)
) STRICT;
CREATE INDEX IF NOT EXISTS work_task_dependencies_reverse
  ON work_task_dependencies(work_id,dependency_task_id,task_id);

CREATE TABLE IF NOT EXISTS work_task_states (
  task_id TEXT PRIMARY KEY REFERENCES work_tasks(id) ON DELETE CASCADE,
  work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK(state IN ('pending','claimed','dispatching','running','submitted','completed','failed','recovery_required','cancelled')),
  revision INTEGER NOT NULL CHECK(revision > 0),
  next_fence INTEGER NOT NULL CHECK(next_fence > 0),
  attempt_count INTEGER NOT NULL CHECK(attempt_count >= 0),
  accepted_submission_id TEXT REFERENCES work_submissions(id) DEFERRABLE INITIALLY DEFERRED,
  retry_not_before INTEGER CHECK(retry_not_before IS NULL OR retry_not_before >= 0),
  updated_at INTEGER NOT NULL CHECK(updated_at >= 0),
  UNIQUE(work_id,task_id),
  CHECK((state = 'completed' AND accepted_submission_id IS NOT NULL) OR state != 'completed')
) STRICT;
CREATE INDEX IF NOT EXISTS work_task_states_ready ON work_task_states(work_id,state,updated_at,task_id);

CREATE TABLE IF NOT EXISTS work_attempts (
  id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 6 AND 80),
  work_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  worker_session_id TEXT NOT NULL REFERENCES sessions(id),
  account_id TEXT NOT NULL REFERENCES profiles(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  preset TEXT NOT NULL CHECK(preset IN ('low','high','ultra')),
  fast INTEGER NOT NULL CHECK(fast IN (0,1)),
  fence INTEGER NOT NULL CHECK(fence > 0),
  revision INTEGER NOT NULL CHECK(revision > 0),
  state TEXT NOT NULL CHECK(state IN ('claimed','dispatching','running','submitted','completed','blocked','failed','released','expired','recovery_required','cancelled')),
  lease_expires_at INTEGER NOT NULL CHECK(lease_expires_at >= 0),
  target_session_id TEXT REFERENCES sessions(id),
  dispatch_mode TEXT CHECK(dispatch_mode IS NULL OR dispatch_mode='send'),
  submission_id TEXT REFERENCES work_submissions(id) DEFERRABLE INITIALLY DEFERRED,
  account_generation INTEGER NOT NULL CHECK(account_generation >= 0),
  daemon_generation INTEGER NOT NULL CHECK(daemon_generation >= 0),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  updated_at INTEGER NOT NULL CHECK(updated_at >= created_at),
  terminal_at INTEGER CHECK(terminal_at IS NULL OR terminal_at >= created_at),
  UNIQUE(task_id,fence),
  UNIQUE(work_id,id),
  FOREIGN KEY(work_id,task_id) REFERENCES work_tasks(work_id,id) ON DELETE CASCADE,
  CHECK((target_session_id IS NULL AND dispatch_mode IS NULL) OR (target_session_id IS NOT NULL AND dispatch_mode IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS work_attempts_one_live
  ON work_attempts(task_id)
  WHERE state IN ('claimed','dispatching','running','submitted','recovery_required');
CREATE INDEX IF NOT EXISTS work_attempts_actor ON work_attempts(work_id,worker_session_id,state,updated_at,id);
CREATE INDEX IF NOT EXISTS work_attempts_lease ON work_attempts(work_id,state,lease_expires_at,id);

CREATE TABLE IF NOT EXISTS work_attempt_reports (
  idempotency_key TEXT PRIMARY KEY CHECK(length(idempotency_key) = 36),
  work_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('checkpoint','submit','blocked','failed','unknown')),
  report_json TEXT NOT NULL CHECK(json_valid(report_json) AND length(CAST(report_json AS BLOB)) <= ${WORK_OPERATION_MAX_BYTES}),
  report_digest TEXT NOT NULL CHECK(length(report_digest) = 64 AND report_digest NOT GLOB '*[^0-9a-f]*'),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  FOREIGN KEY(work_id,attempt_id) REFERENCES work_attempts(work_id,id) ON DELETE CASCADE
) STRICT;
CREATE INDEX IF NOT EXISTS work_attempt_reports_attempt ON work_attempt_reports(attempt_id,created_at,idempotency_key);

CREATE TABLE IF NOT EXISTS work_submissions (
  id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 6 AND 80),
  work_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  worker_session_id TEXT NOT NULL REFERENCES sessions(id),
  summary TEXT NOT NULL CHECK(length(CAST(summary AS BLOB)) BETWEEN 1 AND 16384),
  result_json TEXT NOT NULL CHECK(json_valid(result_json) AND length(CAST(result_json AS BLOB)) <= ${WORK_OPERATION_MAX_BYTES}),
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json) AND length(CAST(evidence_json AS BLOB)) <= ${WORK_OPERATION_MAX_BYTES}),
  content_digest TEXT NOT NULL CHECK(length(content_digest) = 64 AND content_digest NOT GLOB '*[^0-9a-f]*'),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  UNIQUE(work_id,id),
  UNIQUE(attempt_id),
  FOREIGN KEY(work_id,task_id) REFERENCES work_tasks(work_id,id) ON DELETE CASCADE,
  FOREIGN KEY(work_id,attempt_id) REFERENCES work_attempts(work_id,id) ON DELETE CASCADE
) STRICT;
CREATE INDEX IF NOT EXISTS work_submissions_task ON work_submissions(task_id,created_at,id);

CREATE TABLE IF NOT EXISTS work_reviews (
  id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 6 AND 80),
  work_id TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  reviewer_session_id TEXT NOT NULL REFERENCES sessions(id),
  decision TEXT NOT NULL CHECK(decision IN ('accept','revise','reject')),
  review_json TEXT NOT NULL CHECK(json_valid(review_json) AND length(CAST(review_json AS BLOB)) <= ${WORK_OPERATION_MAX_BYTES}),
  review_digest TEXT NOT NULL CHECK(length(review_digest) = 64 AND review_digest NOT GLOB '*[^0-9a-f]*'),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  UNIQUE(submission_id,reviewer_session_id),
  UNIQUE(work_id,id),
  FOREIGN KEY(work_id,submission_id) REFERENCES work_submissions(work_id,id) ON DELETE CASCADE
) STRICT;
CREATE INDEX IF NOT EXISTS work_reviews_submission ON work_reviews(submission_id,created_at,id);

CREATE TABLE IF NOT EXISTS work_signals (
  id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 6 AND 80),
  work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  from_session_id TEXT NOT NULL REFERENCES sessions(id),
  to_session_id TEXT NOT NULL REFERENCES sessions(id),
  target_account_generation INTEGER NOT NULL CHECK(target_account_generation >= 0),
  task_id TEXT,
  reply_to_signal_id TEXT,
  mode TEXT NOT NULL CHECK(mode IN ('queue','steer')),
  body TEXT NOT NULL CHECK(length(CAST(body AS BLOB)) BETWEEN 1 AND 32768),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  UNIQUE(work_id,id),
  FOREIGN KEY(work_id,task_id) REFERENCES work_tasks(work_id,id) ON DELETE CASCADE,
  FOREIGN KEY(work_id,reply_to_signal_id) REFERENCES work_signals(work_id,id) ON DELETE CASCADE
) STRICT;
CREATE INDEX IF NOT EXISTS work_signals_recipient ON work_signals(work_id,to_session_id,created_at,id);

CREATE TABLE IF NOT EXISTS work_task_history_index (
  ordinal INTEGER PRIMARY KEY AUTOINCREMENT CHECK(ordinal > 0 AND ordinal <= ${Number.MAX_SAFE_INTEGER}),
  work_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('attempt','attempt_report','submission','review','signal')),
  stable_key TEXT NOT NULL CHECK(length(CAST(stable_key AS BLOB)) BETWEEN 6 AND 80),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  UNIQUE(kind,stable_key),
  FOREIGN KEY(work_id,task_id) REFERENCES work_tasks(work_id,id) ON DELETE CASCADE
) STRICT;
CREATE INDEX IF NOT EXISTS work_task_history_index_page
  ON work_task_history_index(work_id,task_id,ordinal DESC);
CREATE TABLE IF NOT EXISTS work_task_history_versions (
  ordinal INTEGER PRIMARY KEY AUTOINCREMENT CHECK(ordinal > 0 AND ordinal <= ${Number.MAX_SAFE_INTEGER}),
  history_ordinal INTEGER NOT NULL REFERENCES work_task_history_index(ordinal) ON DELETE CASCADE,
  work_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  event_sequence INTEGER NOT NULL CHECK(event_sequence > 0),
  record_json TEXT NOT NULL CHECK(
    json_valid(record_json)
    AND length(CAST(record_json AS BLOB)) <= ${WORK_PREPARED_EFFECT_MAX_BYTES}
  ),
  record_digest TEXT NOT NULL CHECK(
    length(record_digest)=64 AND record_digest NOT GLOB '*[^0-9a-f]*'
  ),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  UNIQUE(history_ordinal,event_sequence),
  FOREIGN KEY(work_id,task_id) REFERENCES work_tasks(work_id,id) ON DELETE CASCADE,
  FOREIGN KEY(work_id,event_sequence) REFERENCES work_events(work_id,sequence)
    ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE INDEX IF NOT EXISTS work_task_history_versions_cut
  ON work_task_history_versions(history_ordinal,event_sequence DESC,ordinal DESC);
CREATE INDEX IF NOT EXISTS work_task_history_versions_work
  ON work_task_history_versions(work_id,task_id,ordinal);
CREATE TRIGGER IF NOT EXISTS work_task_history_versions_capacity
BEFORE INSERT ON work_task_history_versions
WHEN (SELECT COUNT(*) FROM work_task_history_versions WHERE work_id=NEW.work_id)
  >= ${WORK_TASK_HISTORY_VERSION_LIMIT}
BEGIN SELECT RAISE(ABORT,'WORK_TASK_HISTORY_VERSION_LIMIT'); END;
CREATE TRIGGER IF NOT EXISTS work_task_history_versions_no_update
BEFORE UPDATE ON work_task_history_versions
BEGIN SELECT RAISE(ABORT,'WORK_TASK_HISTORY_VERSION_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS work_task_history_versions_no_delete
BEFORE DELETE ON work_task_history_versions
WHEN NOT EXISTS (SELECT 1 FROM work_purge_authority WHERE work_id=OLD.work_id)
BEGIN SELECT RAISE(ABORT,'WORK_TASK_HISTORY_VERSION_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS work_task_history_index_attempt
AFTER INSERT ON work_attempts
BEGIN
  INSERT INTO work_task_history_index(work_id,task_id,kind,stable_key,created_at)
  VALUES (NEW.work_id,NEW.task_id,'attempt',NEW.id,NEW.created_at);
END;
CREATE TRIGGER IF NOT EXISTS work_task_history_index_attempt_report
AFTER INSERT ON work_attempt_reports
BEGIN
  INSERT INTO work_task_history_index(work_id,task_id,kind,stable_key,created_at)
  SELECT NEW.work_id,a.task_id,'attempt_report',NEW.idempotency_key,NEW.created_at
  FROM work_attempts AS a
  WHERE a.work_id=NEW.work_id AND a.id=NEW.attempt_id;
END;
CREATE TRIGGER IF NOT EXISTS work_task_history_index_submission
AFTER INSERT ON work_submissions
BEGIN
  INSERT INTO work_task_history_index(work_id,task_id,kind,stable_key,created_at)
  VALUES (NEW.work_id,NEW.task_id,'submission',NEW.id,NEW.created_at);
END;
CREATE TRIGGER IF NOT EXISTS work_task_history_index_review
AFTER INSERT ON work_reviews
BEGIN
  INSERT INTO work_task_history_index(work_id,task_id,kind,stable_key,created_at)
  SELECT NEW.work_id,s.task_id,'review',NEW.id,NEW.created_at
  FROM work_submissions AS s
  WHERE s.work_id=NEW.work_id AND s.id=NEW.submission_id;
END;
CREATE TRIGGER IF NOT EXISTS work_task_history_index_signal
AFTER INSERT ON work_signals
WHEN NEW.task_id IS NOT NULL
BEGIN
  INSERT INTO work_task_history_index(work_id,task_id,kind,stable_key,created_at)
  VALUES (NEW.work_id,NEW.task_id,'signal',NEW.id,NEW.created_at);
END;
CREATE TRIGGER IF NOT EXISTS work_task_history_index_no_update
BEFORE UPDATE ON work_task_history_index
BEGIN SELECT RAISE(ABORT,'WORK_TASK_HISTORY_INDEX_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS work_task_history_index_no_delete
BEFORE DELETE ON work_task_history_index
WHEN NOT EXISTS (SELECT 1 FROM work_purge_authority WHERE work_id=OLD.work_id)
BEGIN SELECT RAISE(ABORT,'WORK_TASK_HISTORY_INDEX_IMMUTABLE'); END;

CREATE TABLE IF NOT EXISTS work_signal_receipts (
  signal_id TEXT NOT NULL REFERENCES work_signals(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK(sequence > 0),
  kind TEXT NOT NULL CHECK(kind IN ('accepted','ack','unknown','failed')),
  actor_session_id TEXT REFERENCES sessions(id),
  detail_code TEXT CHECK(detail_code IS NULL OR length(CAST(detail_code AS BLOB)) BETWEEN 1 AND 120),
  recorded_at INTEGER NOT NULL CHECK(recorded_at >= 0),
  PRIMARY KEY(signal_id,sequence)
) STRICT;
CREATE INDEX IF NOT EXISTS work_signal_receipts_kind ON work_signal_receipts(signal_id,kind,sequence);

CREATE TABLE IF NOT EXISTS work_events (
  work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK(sequence > 0),
  revision INTEGER NOT NULL CHECK(revision > 0),
  stream_epoch TEXT NOT NULL CHECK(length(stream_epoch) = 36),
  kind TEXT NOT NULL CHECK(length(CAST(kind AS BLOB)) BETWEEN 1 AND 120),
  actor_session_id TEXT REFERENCES sessions(id),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json) AND length(CAST(payload_json AS BLOB)) <= 131072),
  payload_digest TEXT NOT NULL CHECK(length(payload_digest) = 64 AND payload_digest NOT GLOB '*[^0-9a-f]*'),
  previous_hash TEXT CHECK(previous_hash IS NULL OR (length(previous_hash) = 64 AND previous_hash NOT GLOB '*[^0-9a-f]*')),
  event_hash TEXT NOT NULL CHECK(length(event_hash) = 64 AND event_hash NOT GLOB '*[^0-9a-f]*'),
  daemon_generation INTEGER NOT NULL CHECK(daemon_generation >= 0),
  recorded_at INTEGER NOT NULL CHECK(recorded_at >= 0),
  PRIMARY KEY(work_id,sequence),
  UNIQUE(work_id,revision),
  UNIQUE(work_id,event_hash),
  CHECK((sequence = 1 AND previous_hash IS NULL) OR (sequence > 1 AND previous_hash IS NOT NULL))
) STRICT;
CREATE INDEX IF NOT EXISTS work_events_revision ON work_events(work_id,revision);

CREATE TABLE IF NOT EXISTS work_idempotency_intents (
  idempotency_key TEXT PRIMARY KEY CHECK(length(idempotency_key) = 36),
  operation_kind TEXT NOT NULL CHECK(length(CAST(operation_kind AS BLOB)) BETWEEN 1 AND 120),
  work_id TEXT REFERENCES works(id) ON DELETE CASCADE,
  request_digest TEXT NOT NULL CHECK(length(request_digest) = 64 AND request_digest NOT GLOB '*[^0-9a-f]*'),
  result_json TEXT NOT NULL CHECK(json_valid(result_json) AND length(CAST(result_json AS BLOB)) <= ${WORK_PREPARED_EFFECT_MAX_BYTES}),
  created_at INTEGER NOT NULL CHECK(created_at >= 0)
) STRICT;
CREATE INDEX IF NOT EXISTS work_idempotency_work ON work_idempotency_intents(work_id,created_at,idempotency_key);

CREATE TABLE IF NOT EXISTS work_terminal_requests (
  work_id TEXT PRIMARY KEY REFERENCES works(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL UNIQUE CHECK(length(idempotency_key)=36),
  kind TEXT NOT NULL CHECK(kind IN ('work.complete','work.fail','work.cancel')),
  state TEXT NOT NULL CHECK(state IN ('requested','settled')),
  actor_session_id TEXT NOT NULL REFERENCES sessions(id),
  summary TEXT NOT NULL CHECK(length(CAST(summary AS BLOB)) BETWEEN 1 AND 16384),
  result_json TEXT CHECK(result_json IS NULL OR (
    json_valid(result_json) AND length(CAST(result_json AS BLOB))<=${WORK_OPERATION_MAX_BYTES}
  )),
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json) AND length(CAST(evidence_json AS BLOB))<=${WORK_OPERATION_MAX_BYTES}),
  request_digest TEXT NOT NULL CHECK(length(request_digest)=64 AND request_digest NOT GLOB '*[^0-9a-f]*'),
  requested_at INTEGER NOT NULL CHECK(requested_at>=0),
  settled_at INTEGER CHECK(settled_at IS NULL OR settled_at>=requested_at),
  CHECK((state='requested' AND settled_at IS NULL) OR (state='settled' AND settled_at IS NOT NULL)),
  CHECK((kind='work.complete' AND (result_json IS NULL OR json_valid(result_json)))
     OR (kind!='work.complete' AND result_json IS NULL))
) STRICT;

CREATE TABLE IF NOT EXISTS work_prepared_effects (
  idempotency_key TEXT PRIMARY KEY REFERENCES work_idempotency_intents(idempotency_key) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  effect_kind TEXT NOT NULL CHECK(effect_kind IN ('attempt_dispatch','signal_send')),
  subject_id TEXT NOT NULL CHECK(length(subject_id) BETWEEN 6 AND 80),
  instruction_json TEXT NOT NULL CHECK(json_valid(instruction_json) AND length(CAST(instruction_json AS BLOB)) <= ${WORK_PREPARED_EFFECT_MAX_BYTES}),
  instruction_digest TEXT NOT NULL CHECK(length(instruction_digest) = 64 AND instruction_digest NOT GLOB '*[^0-9a-f]*'),
  daemon_generation INTEGER NOT NULL CHECK(daemon_generation >= 0),
  state TEXT NOT NULL CHECK(state IN ('prepared','effect_started','accepted','failed','unknown')),
  outcome_digest TEXT CHECK(outcome_digest IS NULL OR (length(outcome_digest) = 64 AND outcome_digest NOT GLOB '*[^0-9a-f]*')),
  outcome_json TEXT CHECK(outcome_json IS NULL OR (json_valid(outcome_json) AND length(CAST(outcome_json AS BLOB)) <= 65536)),
  prepared_at INTEGER NOT NULL CHECK(prepared_at >= 0),
  finalized_at INTEGER CHECK(finalized_at IS NULL OR finalized_at >= prepared_at),
  CHECK((state IN ('prepared','effect_started') AND outcome_digest IS NULL AND outcome_json IS NULL AND finalized_at IS NULL)
     OR (state NOT IN ('prepared','effect_started') AND outcome_digest IS NOT NULL AND outcome_json IS NOT NULL AND finalized_at IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS work_effect_subject_unique
  ON work_prepared_effects(effect_kind,subject_id);
CREATE INDEX IF NOT EXISTS work_prepared_effects_pending ON work_prepared_effects(prepared_at,idempotency_key)
  WHERE state IN ('prepared','effect_started');

CREATE TABLE IF NOT EXISTS work_effect_resolutions (
  effect_idempotency_key TEXT PRIMARY KEY REFERENCES work_prepared_effects(idempotency_key) ON DELETE CASCADE,
  work_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  instruction_digest TEXT NOT NULL CHECK(length(instruction_digest) = 64 AND instruction_digest NOT GLOB '*[^0-9a-f]*'),
  outcome TEXT NOT NULL CHECK(outcome IN ('proven_applied','no_effect','failed')),
  evidence_digest TEXT NOT NULL CHECK(length(evidence_digest) = 64 AND evidence_digest NOT GLOB '*[^0-9a-f]*'),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  FOREIGN KEY(work_id,attempt_id) REFERENCES work_attempts(work_id,id) ON DELETE CASCADE
) STRICT;
CREATE TABLE IF NOT EXISTS work_nested_effect_settlements (
  effect_idempotency_key TEXT PRIMARY KEY REFERENCES work_prepared_effects(idempotency_key) ON DELETE CASCADE,
  nested_mutation_key TEXT NOT NULL UNIQUE CHECK(length(nested_mutation_key) = 36),
  outcome TEXT NOT NULL CHECK(outcome IN ('accepted','failed')),
  receipt_json TEXT CHECK(receipt_json IS NULL OR (json_valid(receipt_json) AND length(CAST(receipt_json AS BLOB)) <= 65536)),
  receipt_digest TEXT NOT NULL CHECK(length(receipt_digest) = 64 AND receipt_digest NOT GLOB '*[^0-9a-f]*'),
  created_at INTEGER NOT NULL CHECK(created_at >= 0)
) STRICT;

DROP TRIGGER IF EXISTS works_identity_immutable;
CREATE TRIGGER works_identity_immutable
BEFORE UPDATE OF id,client_ref,coordinator_session_id,objective,preset_contract,stream_epoch,created_at ON works
BEGIN SELECT RAISE(ABORT,'WORK_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS works_no_delete
BEFORE DELETE ON works
WHEN NOT EXISTS (SELECT 1 FROM work_purge_authority WHERE work_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'WORK_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS works_state_guard
BEFORE UPDATE OF state ON works
WHEN NOT (
  OLD.state = NEW.state OR
  (OLD.state = 'active' AND NEW.state IN ('cancel_pending','fail_pending','completed','failed','cancelled')) OR
  (OLD.state = 'cancel_pending' AND NEW.state='cancelled') OR
  (OLD.state = 'fail_pending' AND NEW.state='failed')
)
BEGIN SELECT RAISE(ABORT,'WORK_STATE_TRANSITION'); END;
CREATE TRIGGER IF NOT EXISTS works_stream_advance_guard
BEFORE UPDATE OF revision,next_sequence,head_hash ON works
WHEN NEW.revision != OLD.revision + 1
  OR NEW.next_sequence != OLD.next_sequence + 1
  OR NOT EXISTS (
    SELECT 1 FROM work_events AS e
    WHERE e.work_id=OLD.id
      AND e.sequence=OLD.next_sequence
      AND e.revision=NEW.revision
      AND e.previous_hash IS OLD.head_hash
      AND e.event_hash=NEW.head_hash
  )
BEGIN SELECT RAISE(ABORT,'WORK_STREAM_ADVANCE_INVALID'); END;
CREATE TRIGGER IF NOT EXISTS work_routes_no_update
BEFORE UPDATE ON work_routes BEGIN SELECT RAISE(ABORT,'WORK_ROUTE_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS work_routes_no_delete
BEFORE DELETE ON work_routes
WHEN NOT EXISTS (SELECT 1 FROM work_purge_authority WHERE work_id=OLD.work_id)
BEGIN SELECT RAISE(ABORT,'WORK_ROUTE_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS work_route_limit_guard
BEFORE INSERT ON work_routes
WHEN (SELECT COUNT(*) FROM work_routes WHERE work_id=NEW.work_id) >= ${WORK_ROUTE_LIMIT}
BEGIN SELECT RAISE(ABORT,'WORK_ROUTE_LIMIT'); END;
CREATE TRIGGER IF NOT EXISTS work_route_authority_guard
BEFORE INSERT ON work_routes
WHEN NOT EXISTS (SELECT 1 FROM profiles WHERE id=NEW.account_id AND state!='removed')
  OR NOT EXISTS (SELECT 1 FROM projects WHERE id=NEW.project_id)
BEGIN SELECT RAISE(ABORT,'WORK_ROUTE_MISMATCH'); END;

CREATE TRIGGER IF NOT EXISTS work_members_no_update
BEFORE UPDATE ON work_members BEGIN SELECT RAISE(ABORT,'WORK_MEMBER_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS work_members_no_delete
BEFORE DELETE ON work_members
WHEN NOT EXISTS (SELECT 1 FROM work_purge_authority WHERE work_id=OLD.work_id)
BEGIN SELECT RAISE(ABORT,'WORK_MEMBER_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS work_member_limit_guard
BEFORE INSERT ON work_members
WHEN (SELECT COUNT(*) FROM work_members WHERE work_id=NEW.work_id) >= ${WORK_MEMBER_LIMIT}
BEGIN SELECT RAISE(ABORT,'WORK_MEMBER_LIMIT'); END;
DROP TRIGGER IF EXISTS work_member_account_authority_guard;
CREATE TRIGGER work_member_account_authority_guard
BEFORE INSERT ON work_members
WHEN NOT ${currentWorkSessionAuthorityExistsSql("NEW.session_id")}
BEGIN SELECT RAISE(ABORT,'WORK_MEMBER_AUTHORITY_MISMATCH'); END;

CREATE TRIGGER IF NOT EXISTS work_tasks_no_update
BEFORE UPDATE ON work_tasks BEGIN SELECT RAISE(ABORT,'WORK_TASK_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS work_tasks_no_delete
BEFORE DELETE ON work_tasks
WHEN NOT EXISTS (SELECT 1 FROM work_purge_authority WHERE work_id=OLD.work_id)
BEGIN SELECT RAISE(ABORT,'WORK_TASK_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS work_dependencies_no_update
BEFORE UPDATE ON work_task_dependencies BEGIN SELECT RAISE(ABORT,'WORK_DEPENDENCY_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS work_dependencies_no_delete
BEFORE DELETE ON work_task_dependencies
WHEN NOT EXISTS (SELECT 1 FROM work_purge_authority WHERE work_id=OLD.work_id)
BEGIN SELECT RAISE(ABORT,'WORK_DEPENDENCY_IMMUTABLE'); END;

CREATE TRIGGER IF NOT EXISTS work_task_state_identity_immutable
BEFORE UPDATE OF task_id,work_id,next_fence,attempt_count ON work_task_states
WHEN NEW.next_fence < OLD.next_fence OR NEW.attempt_count < OLD.attempt_count OR NEW.task_id != OLD.task_id OR NEW.work_id != OLD.work_id
BEGIN SELECT RAISE(ABORT,'WORK_TASK_STATE_MONOTONIC'); END;
CREATE TRIGGER IF NOT EXISTS work_task_state_revision_guard
BEFORE UPDATE ON work_task_states
WHEN NEW.revision != OLD.revision + 1
BEGIN SELECT RAISE(ABORT,'WORK_TASK_STATE_REVISION'); END;

CREATE TRIGGER IF NOT EXISTS work_attempt_fence_monotonic
BEFORE INSERT ON work_attempts
WHEN NEW.fence <= COALESCE((SELECT MAX(fence) FROM work_attempts WHERE task_id=NEW.task_id),0)
BEGIN SELECT RAISE(ABORT,'WORK_ATTEMPT_FENCE_NOT_MONOTONIC'); END;
CREATE TRIGGER IF NOT EXISTS work_attempt_authority_immutable
BEFORE UPDATE OF id,work_id,task_id,worker_session_id,account_id,project_id,preset,fast,fence,account_generation,daemon_generation,created_at ON work_attempts
BEGIN SELECT RAISE(ABORT,'WORK_ATTEMPT_AUTHORITY_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS work_attempt_dispatch_binding_guard
BEFORE UPDATE OF target_session_id,dispatch_mode ON work_attempts
WHEN (OLD.target_session_id IS NOT NULL OR OLD.dispatch_mode IS NOT NULL)
  AND (NEW.target_session_id IS NOT OLD.target_session_id OR NEW.dispatch_mode IS NOT OLD.dispatch_mode)
BEGIN SELECT RAISE(ABORT,'WORK_ATTEMPT_DISPATCH_BINDING_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS work_attempt_submission_guard
BEFORE UPDATE OF submission_id ON work_attempts
WHEN OLD.submission_id IS NOT NULL AND NEW.submission_id IS NOT OLD.submission_id
BEGIN SELECT RAISE(ABORT,'WORK_ATTEMPT_SUBMISSION_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS work_attempt_revision_guard
BEFORE UPDATE ON work_attempts
WHEN NEW.revision != OLD.revision + 1
BEGIN SELECT RAISE(ABORT,'WORK_ATTEMPT_REVISION'); END;
CREATE TRIGGER IF NOT EXISTS work_attempt_no_delete
BEFORE DELETE ON work_attempts
WHEN NOT EXISTS (SELECT 1 FROM work_purge_authority WHERE work_id=OLD.work_id)
BEGIN SELECT RAISE(ABORT,'WORK_ATTEMPT_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS work_attempt_state_guard
BEFORE UPDATE OF state ON work_attempts
WHEN NOT (
  OLD.state = NEW.state OR
  (OLD.state = 'claimed' AND NEW.state IN ('dispatching','failed','released','expired','cancelled')) OR
  (OLD.state = 'dispatching' AND NEW.state IN ('running','failed','recovery_required','cancelled')) OR
  (OLD.state = 'running' AND NEW.state IN ('submitted','blocked','failed','recovery_required','cancelled')) OR
  (OLD.state = 'submitted' AND NEW.state IN ('completed','failed','cancelled')) OR
  (OLD.state = 'recovery_required' AND NEW.state IN ('running','submitted','completed','failed','released','cancelled'))
)
BEGIN SELECT RAISE(ABORT,'WORK_ATTEMPT_STATE_TRANSITION'); END;
DROP TRIGGER IF EXISTS work_attempt_route_guard;
CREATE TRIGGER work_attempt_route_guard
BEFORE INSERT ON work_attempts
WHEN NOT EXISTS (
  -- Contract 1 and 2 both resolve Codex low to the exact Luna/max tuple.
  -- High and ultra changed model and therefore remain version-fenced.
  SELECT 1
  FROM work_tasks AS t
  JOIN works AS w ON w.id=t.work_id
  JOIN sessions AS s ON s.id=NEW.worker_session_id
  JOIN work_members AS m ON m.work_id=NEW.work_id AND m.session_id=s.id
  WHERE t.id=NEW.task_id AND t.work_id=NEW.work_id
    AND t.account_id=NEW.account_id AND t.project_id=NEW.project_id
    AND t.preset=NEW.preset AND t.fast=NEW.fast
    AND s.profile_id=NEW.account_id AND s.project_id=NEW.project_id
    AND s.preset=NEW.preset AND s.fast_enabled=NEW.fast
    AND s.provider_v39='codex'
    AND (
      s.preset_contract=w.preset_contract
      OR NEW.preset='low'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM mutation_attempts AS sm
      LEFT JOIN mutation_resolutions AS sr ON sr.attempt_id=sm.id
      WHERE sm.authority_id=s.id AND sm.kind='session.switch'
        AND sm.state IN ('effect_started','ambiguous')
        AND sr.attempt_id IS NULL
    )
)
BEGIN SELECT RAISE(ABORT,'WORK_ATTEMPT_ROUTE_MISMATCH'); END;
DROP TRIGGER IF EXISTS work_attempt_account_authority_guard;
CREATE TRIGGER work_attempt_account_authority_guard
BEFORE INSERT ON work_attempts
WHEN NOT ${currentWorkSessionAuthorityExistsSql(
    "NEW.worker_session_id",
    "authority_session.provider_v39='codex' AND authority_session.profile_id=NEW.account_id AND authority_profile.process_generation=NEW.account_generation",
  )}
BEGIN SELECT RAISE(ABORT,'WORK_ATTEMPT_ACCOUNT_AUTHORITY_MISMATCH'); END;
DROP TRIGGER IF EXISTS work_session_switch_attempt_authority_guard;
CREATE TRIGGER work_session_switch_attempt_authority_guard
BEFORE UPDATE OF state ON mutation_attempts
WHEN OLD.kind='session.switch'
  AND OLD.state='prepared'
  AND NEW.state='effect_started'
  AND EXISTS (
    SELECT 1 FROM work_attempts AS a
    WHERE a.worker_session_id=OLD.authority_id
      AND a.state IN ('claimed','dispatching','running','recovery_required')
  )
BEGIN SELECT RAISE(ABORT,'WORK_SESSION_SWITCH_ATTEMPT_AUTHORITY'); END;
DROP TRIGGER IF EXISTS work_session_attempt_authority_guard;
CREATE TRIGGER work_session_attempt_authority_guard
BEFORE UPDATE OF profile_id,project_id,provider_v39,preset,fast_enabled,preset_contract ON sessions
WHEN EXISTS (
  SELECT 1 FROM work_attempts AS a
  JOIN works AS w ON w.id=a.work_id
  WHERE a.worker_session_id=OLD.id
    AND a.state IN ('claimed','dispatching','running','recovery_required')
    AND (
      NEW.profile_id!=a.account_id OR NEW.project_id!=a.project_id
      OR NEW.provider_v39!='codex' OR NEW.preset!=a.preset OR NEW.fast_enabled!=a.fast
      OR (
        NEW.preset_contract!=w.preset_contract
        AND a.preset!='low'
      )
    )
)
BEGIN SELECT RAISE(ABORT,'WORK_SESSION_ATTEMPT_AUTHORITY'); END;
DROP TRIGGER IF EXISTS work_profile_attempt_authority_guard;
CREATE TRIGGER IF NOT EXISTS work_profile_attempt_authority_guard
BEFORE UPDATE OF state,process_generation ON profiles
WHEN EXISTS (
  SELECT 1 FROM work_attempts AS a
  JOIN sessions AS s ON s.id=a.worker_session_id
  WHERE a.account_id=OLD.id
    AND a.state IN ('claimed','dispatching','running')
    AND (
      NEW.process_generation!=a.account_generation
      OR (NEW.state!='signed_in' AND s.provider_v39='codex')
    )
)
BEGIN SELECT RAISE(ABORT,'WORK_PROFILE_ATTEMPT_AUTHORITY'); END;
CREATE TRIGGER IF NOT EXISTS work_profile_attempt_identity_guard
BEFORE UPDATE OF provider_email ON profiles
WHEN lower(trim(NEW.provider_email)) IS NOT lower(trim(OLD.provider_email)) AND EXISTS (
  SELECT 1 FROM work_attempts AS a
  WHERE a.account_id=OLD.id
    AND a.state IN ('claimed','dispatching','running')
)
BEGIN SELECT RAISE(ABORT,'WORK_PROFILE_ATTEMPT_AUTHORITY'); END;

CREATE TRIGGER IF NOT EXISTS work_attempt_reports_no_update
BEFORE UPDATE ON work_attempt_reports BEGIN SELECT RAISE(ABORT,'WORK_REPORT_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS work_attempt_reports_no_delete
BEFORE DELETE ON work_attempt_reports
WHEN NOT EXISTS (SELECT 1 FROM work_purge_authority WHERE work_id=OLD.work_id)
BEGIN SELECT RAISE(ABORT,'WORK_REPORT_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS work_submissions_no_update
BEFORE UPDATE ON work_submissions BEGIN SELECT RAISE(ABORT,'WORK_SUBMISSION_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS work_submissions_no_delete
BEFORE DELETE ON work_submissions
WHEN NOT EXISTS (SELECT 1 FROM work_purge_authority WHERE work_id=OLD.work_id)
BEGIN SELECT RAISE(ABORT,'WORK_SUBMISSION_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS work_reviews_no_update
BEFORE UPDATE ON work_reviews BEGIN SELECT RAISE(ABORT,'WORK_REVIEW_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS work_reviews_no_delete
BEFORE DELETE ON work_reviews
WHEN NOT EXISTS (SELECT 1 FROM work_purge_authority WHERE work_id=OLD.work_id)
BEGIN SELECT RAISE(ABORT,'WORK_REVIEW_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS work_review_member_guard
BEFORE INSERT ON work_reviews
WHEN NOT EXISTS (SELECT 1 FROM work_members WHERE work_id=NEW.work_id AND session_id=NEW.reviewer_session_id)
  OR EXISTS (
    SELECT 1 FROM work_submissions AS s
    WHERE s.id=NEW.submission_id AND s.worker_session_id=NEW.reviewer_session_id
  )
BEGIN SELECT RAISE(ABORT,'WORK_REVIEWER_INVALID'); END;
DROP TRIGGER IF EXISTS work_review_account_authority_guard;
CREATE TRIGGER work_review_account_authority_guard
BEFORE INSERT ON work_reviews
WHEN NOT ${currentWorkSessionAuthorityExistsSql("NEW.reviewer_session_id")}
BEGIN SELECT RAISE(ABORT,'WORK_REVIEWER_AUTHORITY_MISMATCH'); END;

CREATE TRIGGER IF NOT EXISTS work_signals_no_update
BEFORE UPDATE ON work_signals BEGIN SELECT RAISE(ABORT,'WORK_SIGNAL_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS work_signals_no_delete
BEFORE DELETE ON work_signals
WHEN NOT EXISTS (SELECT 1 FROM work_purge_authority WHERE work_id=OLD.work_id)
BEGIN SELECT RAISE(ABORT,'WORK_SIGNAL_IMMUTABLE'); END;
DROP TRIGGER IF EXISTS work_signal_member_guard;
CREATE TRIGGER IF NOT EXISTS work_signal_member_guard
BEFORE INSERT ON work_signals
WHEN NOT EXISTS (SELECT 1 FROM work_members WHERE work_id=NEW.work_id AND session_id=NEW.from_session_id)
  OR NOT EXISTS (SELECT 1 FROM work_members WHERE work_id=NEW.work_id AND session_id=NEW.to_session_id)
  OR NOT EXISTS (
    SELECT 1 FROM sessions AS s JOIN profiles AS p ON p.id=s.profile_id
    WHERE s.id=NEW.to_session_id
      AND p.process_generation=NEW.target_account_generation
  )
BEGIN SELECT RAISE(ABORT,'WORK_SIGNAL_MEMBER_INVALID'); END;
DROP TRIGGER IF EXISTS work_signal_account_authority_guard;
CREATE TRIGGER work_signal_account_authority_guard
BEFORE INSERT ON work_signals
WHEN NOT ${currentWorkSessionAuthorityExistsSql("NEW.from_session_id")}
OR NOT ${currentWorkSessionAuthorityExistsSql(
    "NEW.to_session_id",
    "authority_profile.process_generation=NEW.target_account_generation",
  )}
BEGIN SELECT RAISE(ABORT,'WORK_SIGNAL_ACCOUNT_AUTHORITY_MISMATCH'); END;
CREATE TRIGGER IF NOT EXISTS work_receipts_no_update
BEFORE UPDATE ON work_signal_receipts BEGIN SELECT RAISE(ABORT,'WORK_SIGNAL_RECEIPT_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS work_receipts_no_delete
BEFORE DELETE ON work_signal_receipts
WHEN NOT EXISTS (
  SELECT 1 FROM work_signals AS s
  JOIN work_purge_authority AS p ON p.work_id=s.work_id
  WHERE s.id=OLD.signal_id
)
BEGIN SELECT RAISE(ABORT,'WORK_SIGNAL_RECEIPT_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS work_signal_ack_guard
BEFORE INSERT ON work_signal_receipts
WHEN NEW.kind='ack' AND NOT EXISTS (
  SELECT 1 FROM work_signals AS s
  WHERE s.id=NEW.signal_id AND s.to_session_id=NEW.actor_session_id
)
BEGIN SELECT RAISE(ABORT,'WORK_SIGNAL_ACK_ACTOR_INVALID'); END;
DROP TRIGGER IF EXISTS work_signal_ack_account_authority_guard;
CREATE TRIGGER work_signal_ack_account_authority_guard
BEFORE INSERT ON work_signal_receipts
WHEN NEW.kind='ack' AND NOT EXISTS (
  SELECT 1 FROM work_signals AS signal
  WHERE signal.id=NEW.signal_id
    AND signal.to_session_id=NEW.actor_session_id
    AND ${currentWorkSessionAuthorityExistsSql(
      "signal.to_session_id",
      "authority_profile.process_generation=signal.target_account_generation",
    )}
)
BEGIN SELECT RAISE(ABORT,'WORK_SIGNAL_ACK_ACCOUNT_AUTHORITY_MISMATCH'); END;
CREATE TRIGGER IF NOT EXISTS work_receipt_chain_guard
BEFORE INSERT ON work_signal_receipts
WHEN NEW.sequence != COALESCE((
  SELECT MAX(sequence)+1 FROM work_signal_receipts WHERE signal_id=NEW.signal_id
),1)
BEGIN SELECT RAISE(ABORT,'WORK_SIGNAL_RECEIPT_SEQUENCE'); END;

CREATE TRIGGER IF NOT EXISTS work_events_no_update
BEFORE UPDATE ON work_events BEGIN SELECT RAISE(ABORT,'WORK_EVENT_APPEND_ONLY'); END;
CREATE TRIGGER IF NOT EXISTS work_events_no_delete
BEFORE DELETE ON work_events
WHEN NOT EXISTS (SELECT 1 FROM work_purge_authority WHERE work_id=OLD.work_id)
BEGIN SELECT RAISE(ABORT,'WORK_EVENT_APPEND_ONLY'); END;
CREATE TRIGGER IF NOT EXISTS work_event_chain_guard
BEFORE INSERT ON work_events
WHEN NEW.sequence != COALESCE((SELECT MAX(sequence)+1 FROM work_events WHERE work_id=NEW.work_id),1)
  OR NEW.previous_hash IS NOT (SELECT event_hash FROM work_events WHERE work_id=NEW.work_id ORDER BY sequence DESC LIMIT 1)
BEGIN SELECT RAISE(ABORT,'WORK_EVENT_CHAIN_INVALID'); END;
CREATE TRIGGER IF NOT EXISTS work_event_capacity_guard
BEFORE INSERT ON work_events
WHEN (SELECT COUNT(*) FROM work_events WHERE work_id=NEW.work_id)
   + (SELECT COALESCE(SUM(CASE state WHEN 'prepared' THEN 2 WHEN 'effect_started' THEN 1 ELSE 0 END),0)
      FROM work_prepared_effects WHERE work_id=NEW.work_id)
   + 1 > ${WORK_HISTORY_EVENT_LIMIT}
BEGIN SELECT RAISE(ABORT,'WORK_HISTORY_EVENT_LIMIT'); END;

CREATE TRIGGER IF NOT EXISTS work_intents_no_update
BEFORE UPDATE ON work_idempotency_intents BEGIN SELECT RAISE(ABORT,'WORK_INTENT_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS work_intents_no_delete
BEFORE DELETE ON work_idempotency_intents
WHEN OLD.work_id IS NULL OR NOT EXISTS (
  SELECT 1 FROM work_purge_authority WHERE work_id=OLD.work_id
)
BEGIN SELECT RAISE(ABORT,'WORK_INTENT_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS work_terminal_requests_no_update
BEFORE UPDATE ON work_terminal_requests
WHEN NOT (
  OLD.state='requested' AND NEW.state='settled'
  AND OLD.settled_at IS NULL AND NEW.settled_at IS NOT NULL
  AND NEW.work_id=OLD.work_id
  AND NEW.idempotency_key=OLD.idempotency_key
  AND NEW.kind=OLD.kind
  AND NEW.actor_session_id=OLD.actor_session_id
  AND NEW.summary=OLD.summary
  AND NEW.result_json IS OLD.result_json
  AND NEW.evidence_json=OLD.evidence_json
  AND NEW.request_digest=OLD.request_digest
  AND NEW.requested_at=OLD.requested_at
)
BEGIN SELECT RAISE(ABORT,'WORK_TERMINAL_REQUEST_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS work_terminal_requests_no_delete
BEFORE DELETE ON work_terminal_requests
WHEN NOT EXISTS (SELECT 1 FROM work_purge_authority WHERE work_id=OLD.work_id)
BEGIN SELECT RAISE(ABORT,'WORK_TERMINAL_REQUEST_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS work_effect_identity_immutable
BEFORE UPDATE OF idempotency_key,work_id,effect_kind,subject_id,instruction_json,instruction_digest,daemon_generation,prepared_at ON work_prepared_effects
BEGIN SELECT RAISE(ABORT,'WORK_EFFECT_IDENTITY_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS work_effect_no_delete
BEFORE DELETE ON work_prepared_effects
WHEN NOT EXISTS (SELECT 1 FROM work_purge_authority WHERE work_id=OLD.work_id)
BEGIN SELECT RAISE(ABORT,'WORK_EFFECT_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS work_effect_state_guard
BEFORE UPDATE OF state ON work_prepared_effects
WHEN NOT (
  OLD.state=NEW.state
  OR (OLD.state='prepared' AND NEW.state IN ('effect_started','accepted','failed','unknown'))
  OR (OLD.state='effect_started' AND NEW.state IN ('accepted','failed','unknown'))
  OR (OLD.state='unknown' AND NEW.state IN ('accepted','failed') AND EXISTS (
    SELECT 1 FROM work_effect_resolutions AS r
    WHERE r.effect_idempotency_key=OLD.idempotency_key
      AND ((r.outcome='proven_applied' AND NEW.state='accepted')
        OR (r.outcome IN ('no_effect','failed') AND NEW.state='failed'))
  ))
  OR (OLD.state='unknown' AND NEW.state IN ('accepted','failed') AND EXISTS (
    SELECT 1 FROM work_nested_effect_settlements AS n
    WHERE n.effect_idempotency_key=OLD.idempotency_key AND n.outcome=NEW.state
  ))
)
BEGIN SELECT RAISE(ABORT,'WORK_EFFECT_STATE_TRANSITION'); END;
CREATE TRIGGER IF NOT EXISTS work_effect_outcome_guard
BEFORE UPDATE OF outcome_digest,outcome_json,finalized_at ON work_prepared_effects
WHEN OLD.state NOT IN ('prepared','effect_started')
  AND NOT (OLD.state='unknown' AND NEW.state IN ('accepted','failed') AND EXISTS (
    SELECT 1 FROM work_effect_resolutions AS r
    WHERE r.effect_idempotency_key=OLD.idempotency_key
  ))
  AND NOT (OLD.state='unknown' AND NEW.state IN ('accepted','failed') AND EXISTS (
    SELECT 1 FROM work_nested_effect_settlements AS n
    WHERE n.effect_idempotency_key=OLD.idempotency_key AND n.outcome=NEW.state
  ))
  AND (
  NEW.outcome_digest IS NOT OLD.outcome_digest OR
  NEW.outcome_json IS NOT OLD.outcome_json OR
  NEW.finalized_at IS NOT OLD.finalized_at
)
BEGIN SELECT RAISE(ABORT,'WORK_EFFECT_OUTCOME_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS work_effect_capacity_guard
BEFORE INSERT ON work_prepared_effects
WHEN NEW.state='prepared'
 AND (SELECT COUNT(*) FROM work_events WHERE work_id=NEW.work_id)
   + (SELECT COALESCE(SUM(CASE state WHEN 'prepared' THEN 2 WHEN 'effect_started' THEN 1 ELSE 0 END),0)
      FROM work_prepared_effects WHERE work_id=NEW.work_id)
   + 3 > ${WORK_HISTORY_EVENT_LIMIT}
BEGIN SELECT RAISE(ABORT,'WORK_HISTORY_EVENT_LIMIT'); END;
CREATE TRIGGER IF NOT EXISTS work_effect_resolutions_insert_guard
BEFORE INSERT ON work_effect_resolutions
WHEN NOT EXISTS (
  SELECT 1 FROM work_prepared_effects AS e
  WHERE e.idempotency_key=NEW.effect_idempotency_key
    AND e.work_id=NEW.work_id AND e.effect_kind='attempt_dispatch'
    AND e.subject_id=NEW.attempt_id AND e.instruction_digest=NEW.instruction_digest
)
BEGIN SELECT RAISE(ABORT,'WORK_EFFECT_RESOLUTION_MISMATCH'); END;
CREATE TRIGGER IF NOT EXISTS work_effect_resolutions_no_update
BEFORE UPDATE ON work_effect_resolutions
BEGIN SELECT RAISE(ABORT,'WORK_EFFECT_RESOLUTION_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS work_effect_resolutions_no_delete
BEFORE DELETE ON work_effect_resolutions
WHEN NOT EXISTS (SELECT 1 FROM work_purge_authority WHERE work_id=OLD.work_id)
BEGIN SELECT RAISE(ABORT,'WORK_EFFECT_RESOLUTION_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS work_nested_effect_settlements_insert_guard
BEFORE INSERT ON work_nested_effect_settlements
WHEN NOT EXISTS (
  SELECT 1 FROM work_prepared_effects AS e
  WHERE e.idempotency_key=NEW.effect_idempotency_key
    AND json_extract(e.instruction_json,'$.nestedMutationKey')=NEW.nested_mutation_key
)
BEGIN SELECT RAISE(ABORT,'WORK_NESTED_EFFECT_SETTLEMENT_MISMATCH'); END;
CREATE TRIGGER IF NOT EXISTS work_nested_effect_settlements_no_update
BEFORE UPDATE ON work_nested_effect_settlements
BEGIN SELECT RAISE(ABORT,'WORK_NESTED_EFFECT_SETTLEMENT_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS work_nested_effect_settlements_no_delete
BEFORE DELETE ON work_nested_effect_settlements
WHEN NOT EXISTS (
  SELECT 1 FROM work_prepared_effects AS e
  JOIN work_purge_authority AS p ON p.work_id=e.work_id
  WHERE e.idempotency_key=OLD.effect_idempotency_key
)
BEGIN SELECT RAISE(ABORT,'WORK_NESTED_EFFECT_SETTLEMENT_IMMUTABLE'); END;
`;

// These guards jointly bind Work to the session's provider, preset contract,
// and immutable account authority. They have changed across schema versions,
// so presence alone is not enough: a same-name legacy body would silently
// weaken the current route fence.
const exactWorkAuthorityTriggerNames = [
  "works_identity_immutable",
  "work_devin_preset_contract_guard",
  "work_session_devin_contract_guard",
  "work_coordinator_account_authority_guard",
  "work_member_account_authority_guard",
  "work_attempt_route_guard",
  "work_attempt_account_authority_guard",
  "work_session_switch_attempt_authority_guard",
  "work_session_attempt_authority_guard",
  "work_review_account_authority_guard",
  "work_signal_member_guard",
  "work_signal_account_authority_guard",
  "work_signal_ack_account_authority_guard",
] as const;
const exactWorkAuthorityTriggerNameSet: ReadonlySet<string> = new Set(
  exactWorkAuthorityTriggerNames,
);

const normalizeWorkSchemaSql = normalizeSchemaSql;

// Schema v49 adds this companion without changing the released Work SQL or
// its frozen v39/v40 authority and non-authority digest preimages.
export const WORK_PROJECT_AUTHORITY_SCHEMA_SQL = `
CREATE TRIGGER work_session_project_authority_guard
BEFORE UPDATE OF project_id ON sessions
WHEN NEW.project_id IS NOT OLD.project_id
  AND EXISTS (
    SELECT 1 FROM work_attempts AS a
    WHERE a.worker_session_id=OLD.id
      AND a.state IN ('claimed','dispatching','running','recovery_required')
      AND NEW.project_id IS NOT a.project_id
  )
BEGIN SELECT RAISE(ABORT,'WORK_SESSION_ATTEMPT_AUTHORITY'); END;
`;

export function assertWorkProjectAuthoritySchema(database: Database): void {
  const rows = database.query(
    "SELECT name,type,tbl_name,sql FROM sqlite_master WHERE name='work_session_project_authority_guard' COLLATE NOCASE",
  ).all() as Array<{ name?: unknown; type?: unknown; tbl_name?: unknown; sql?: unknown }>;
  if (rows.length === 0) throw new Error("WORK_SCHEMA_MISSING_TRIGGER:work_session_project_authority_guard");
  const row = rows[0];
  if (
    rows.length !== 1
    || row?.name !== "work_session_project_authority_guard"
    || row.type !== "trigger"
    || row.tbl_name !== "sessions"
    || typeof row.sql !== "string"
    || normalizeWorkSchemaSql(row.sql) !== normalizeWorkSchemaSql(WORK_PROJECT_AUTHORITY_SCHEMA_SQL)
  ) throw new Error("WORK_SCHEMA_STALE_TRIGGER:work_session_project_authority_guard");
}

const workTriggerDefinitionSql = (name: string): string => {
  const markers = [`CREATE TRIGGER ${name}\n`, `CREATE TRIGGER IF NOT EXISTS ${name}\n`];
  const start = markers
    .map((marker) => WORK_SCHEMA_SQL.indexOf(marker))
    .find((offset) => offset >= 0) ?? -1;
  const end = WORK_SCHEMA_SQL.indexOf("END;", start);
  if (start < 0 || end < 0) throw new Error(`WORK_SCHEMA_DEFINITION_INVALID:${name}`);
  return WORK_SCHEMA_SQL.slice(start, end + 4);
};

const exactWorkAuthorityTriggerDefinitionSql = new Map(
  exactWorkAuthorityTriggerNames.map((name) => [
    name,
    workTriggerDefinitionSql(name),
  ] as const),
);
const exactWorkAuthorityTriggerSql = new Map(
  [...exactWorkAuthorityTriggerDefinitionSql]
    .map(([name, sql]) => [name, normalizeWorkSchemaSql(sql)] as const),
);

// Historical Work admission is closed over archived literals, not the stronger
// current provider-account/captured-authority predicates.
const providerVersion40WorkAuthorityDefinitionEntries =
  CANONICAL_40_WORK_AUTHORITY_TRIGGER_DEFINITIONS;
const providerVersion40WorkAuthorityTriggerSql = new Map<string, string>(
  providerVersion40WorkAuthorityDefinitionEntries
    .map(([name, sql]) => [name, normalizeSchemaSql(sql)] as const),
);
const canonical49WorkAuthorityTriggerSql = new Map(providerVersion40WorkAuthorityTriggerSql);
for (const [name, sql] of CANONICAL_49_WORK_PRESET_GUARD_DEFINITIONS) {
  canonical49WorkAuthorityTriggerSql.set(name, normalizeSchemaSql(sql));
}
const canonicalNonAuthorityWorkTriggerSql = new Map<string, string>(
  CANONICAL_WORK_NON_AUTHORITY_TRIGGER_DEFINITIONS
    .map(([name, sql]) => [name, normalizeSchemaSql(sql)] as const),
);

const providerVersion39AddedAuthorityTriggerNames = new Set([
  "work_coordinator_account_authority_guard",
  "work_member_account_authority_guard",
  "work_attempt_account_authority_guard",
  "work_profile_attempt_identity_guard",
  "work_review_account_authority_guard",
  "work_signal_account_authority_guard",
  "work_signal_ack_account_authority_guard",
]);

const providerVersion39SignalMemberGuardSql = normalizeSchemaSql(`
CREATE TRIGGER work_signal_member_guard
BEFORE INSERT ON work_signals
WHEN NOT EXISTS (SELECT 1 FROM work_members WHERE work_id=NEW.work_id AND session_id=NEW.from_session_id)
  OR NOT EXISTS (SELECT 1 FROM work_members WHERE work_id=NEW.work_id AND session_id=NEW.to_session_id)
  OR NOT EXISTS (
    SELECT 1 FROM sessions AS s JOIN profiles AS p ON p.id=s.profile_id
    WHERE s.id=NEW.to_session_id AND s.state IN ('active','idle')
      AND p.state!='removed' AND (s.provider_v39 IN ('claude','devin') OR p.state='signed_in')
      AND p.process_generation=NEW.target_account_generation
  )
BEGIN SELECT RAISE(ABORT,'WORK_SIGNAL_MEMBER_INVALID'); END
`);

const requiredWorkTables = [
  "work_clock",
  "work_purge_authority",
  "work_release_tombstones",
  "works",
  "work_routes",
  "work_members",
  "work_tasks",
  "work_task_dependencies",
  "work_task_states",
  "work_attempts",
  "work_attempt_reports",
  "work_submissions",
  "work_reviews",
  "work_signals",
  "work_task_history_index",
  "work_task_history_versions",
  "work_signal_receipts",
  "work_events",
  "work_idempotency_intents",
  "work_terminal_requests",
  "work_prepared_effects",
  "work_effect_resolutions",
  "work_nested_effect_settlements",
] as const;

const requiredWorkTriggers = [
  "work_release_tombstones_no_update",
  "works_identity_immutable",
  "work_active_limit_guard",
  "work_retained_limit_guard",
  "work_devin_preset_contract_guard",
  "work_session_devin_contract_guard",
  "work_coordinator_account_authority_guard",
  "works_no_delete",
  "works_state_guard",
  "works_stream_advance_guard",
  "work_routes_no_update",
  "work_routes_no_delete",
  "work_route_limit_guard",
  "work_route_authority_guard",
  "work_members_no_update",
  "work_members_no_delete",
  "work_member_limit_guard",
  "work_member_account_authority_guard",
  "work_tasks_no_update",
  "work_tasks_no_delete",
  "work_dependencies_no_update",
  "work_dependencies_no_delete",
  "work_task_state_identity_immutable",
  "work_task_state_revision_guard",
  "work_attempt_fence_monotonic",
  "work_attempt_authority_immutable",
  "work_attempt_dispatch_binding_guard",
  "work_attempt_submission_guard",
  "work_attempt_revision_guard",
  "work_attempt_no_delete",
  "work_attempt_state_guard",
  "work_attempt_route_guard",
  "work_attempt_account_authority_guard",
  "work_session_switch_attempt_authority_guard",
  "work_session_attempt_authority_guard",
  "work_profile_attempt_authority_guard",
  "work_profile_attempt_identity_guard",
  "work_attempt_reports_no_update",
  "work_attempt_reports_no_delete",
  "work_submissions_no_update",
  "work_submissions_no_delete",
  "work_reviews_no_update",
  "work_reviews_no_delete",
  "work_review_member_guard",
  "work_review_account_authority_guard",
  "work_signals_no_update",
  "work_signals_no_delete",
  "work_signal_member_guard",
  "work_signal_account_authority_guard",
  "work_task_history_index_attempt",
  "work_task_history_index_attempt_report",
  "work_task_history_index_submission",
  "work_task_history_index_review",
  "work_task_history_index_signal",
  "work_task_history_index_no_update",
  "work_task_history_index_no_delete",
  "work_task_history_versions_capacity",
  "work_task_history_versions_no_update",
  "work_task_history_versions_no_delete",
  "work_receipts_no_update",
  "work_receipts_no_delete",
  "work_signal_ack_guard",
  "work_signal_ack_account_authority_guard",
  "work_receipt_chain_guard",
  "work_events_no_update",
  "work_events_no_delete",
  "work_event_chain_guard",
  "work_event_capacity_guard",
  "work_intents_no_update",
  "work_intents_no_delete",
  "work_terminal_requests_no_update",
  "work_terminal_requests_no_delete",
  "work_effect_identity_immutable",
  "work_effect_no_delete",
  "work_effect_state_guard",
  "work_effect_outcome_guard",
  "work_effect_capacity_guard",
  "work_effect_resolutions_insert_guard",
  "work_effect_resolutions_no_update",
  "work_effect_resolutions_no_delete",
  "work_nested_effect_settlements_insert_guard",
  "work_nested_effect_settlements_no_update",
  "work_nested_effect_settlements_no_delete",
] as const;

// Current runtime definitions are distinct from the literal historical map.
// Check every required body, not only its name.
const exactNonAuthorityWorkTriggerEntries = requiredWorkTriggers
  .filter((name) => !exactWorkAuthorityTriggerNameSet.has(name))
  .map((name) => [
    name,
    normalizeWorkSchemaSql(workTriggerDefinitionSql(name)),
  ] as const);
const exactNonAuthorityWorkTriggerSql: ReadonlyMap<string, string> = new Map(
  exactNonAuthorityWorkTriggerEntries,
);
const assertWorkSchemaShape = (
  database: Database,
  expectedAuthorityTriggerSql: ReadonlyMap<string, string> = exactWorkAuthorityTriggerSql,
  expectedNonAuthorityTriggerSql: ReadonlyMap<string, string> = exactNonAuthorityWorkTriggerSql,
): void => {
  const foreignKeys = database.query("PRAGMA foreign_keys").get() as { foreign_keys?: unknown } | null;
  if (foreignKeys?.foreign_keys !== 1) throw new Error("WORK_SCHEMA_FOREIGN_KEYS_DISABLED");
  const rows = database.query("PRAGMA table_list").all() as Array<{
    name?: unknown;
    strict?: unknown;
    type?: unknown;
  }>;
  const tables = new Map(
    rows
      .filter((row) => row.type === "table" && typeof row.name === "string")
      .map((row) => [row.name as string, row.strict]),
  );
  for (const name of requiredWorkTables) {
    if (!tables.has(name)) throw new Error(`WORK_SCHEMA_MISSING:${name}`);
    if (tables.get(name) !== 1) throw new Error(`WORK_SCHEMA_NOT_STRICT:${name}`);
  }
  const sessionColumns = new Set((database.query("PRAGMA table_info(sessions)").all() as Array<{
    name?: unknown;
  }>).flatMap((row) => typeof row.name === "string" ? [row.name] : []));
  for (const column of ["provider", "preset_contract"] as const) {
    if (!sessionColumns.has(column)) throw new Error(`WORK_SCHEMA_STALE:sessions.${column}`);
  }
  const triggerRows = database.query(
    "SELECT name,type,tbl_name,sql FROM sqlite_master WHERE type='trigger'",
  ).all() as Array<{
    name?: unknown;
    type?: unknown;
    tbl_name?: unknown;
    sql?: unknown;
  }>;
  const triggers = new Map(triggerRows.flatMap((row) =>
    typeof row.name === "string" ? [[row.name, row] as const] : []));
  for (const name of requiredWorkTriggers) {
    if (!triggers.has(name)) throw new Error(`WORK_SCHEMA_MISSING_TRIGGER:${name}`);
  }
  for (const name of exactWorkAuthorityTriggerNames) {
    const row = triggers.get(name);
    if (
      row?.type !== "trigger"
      || typeof row.tbl_name !== "string"
      || typeof row.sql !== "string"
      || normalizeWorkSchemaSql(row.sql) !== expectedAuthorityTriggerSql.get(name)
    ) throw new Error(`WORK_SCHEMA_STALE_TRIGGER:${name}`);
  }
  for (const [name, expected] of expectedNonAuthorityTriggerSql) {
    const row = triggers.get(name);
    if (
      row?.type !== "trigger"
      || typeof row.tbl_name !== "string"
      || typeof row.sql !== "string"
      || normalizeWorkSchemaSql(row.sql) !== expected
    ) throw new Error(`WORK_SCHEMA_STALE_TRIGGER:${name}`);
  }
  const requiredColumns: Readonly<Record<string, readonly string[]>> = {
    // Current work authority guards inspect the provider on their parent
    // session, so a merely present trigger is not a usable work schema.
    profiles: ["state", "process_generation", "provider_email", "codex_account_key"],
    sessions: ["provider_v39", "provider_thread_id", "preset_contract"],
    session_account_authorities: ["session_id", "profile_id", "account_key"],
    session_provider_account_authorities: [
      "session_id", "provider", "runtime_scope", "account_key",
    ],
    session_personal_runtime_bindings: [
      "session_id", "provider", "provider_thread_id", "state",
    ],
    provider_runtime_account_revocations: [
      "profile_id", "profile_generation", "provider", "runtime_scope",
      "current_account_key", "state",
    ],
    work_release_tombstones: [
      "work_id", "release_idempotency_key", "release_request_digest", "client_ref_digest",
      "terminal_kind", "final_revision", "final_head_hash", "discarded_counts_json",
      "discarded_records_digest", "released_at", "retention_upper_bound_at", "result_json",
    ],
    works: [
      "id", "coordinator_session_id", "preset_contract", "state", "revision",
      "stream_epoch", "next_sequence",
    ],
    work_tasks: [
      "id", "work_id", "account_id", "project_id", "preset", "fast", "not_before",
      "claim_by", "deadline", "max_attempts", "required_reviews",
    ],
    work_attempts: [
      "id", "work_id", "task_id", "worker_session_id", "account_generation", "fence",
      "revision", "state", "target_session_id", "dispatch_mode",
    ],
    work_signals: ["id", "work_id", "to_session_id", "target_account_generation", "mode"],
    work_task_history_index: [
      "ordinal", "work_id", "task_id", "kind", "stable_key", "created_at",
    ],
    work_task_history_versions: [
      "ordinal", "history_ordinal", "work_id", "task_id", "event_sequence",
      "record_json", "record_digest", "created_at",
    ],
    work_prepared_effects: [
      "idempotency_key", "effect_kind", "instruction_digest", "state", "outcome_json",
    ],
  };
  for (const [table, columns] of Object.entries(requiredColumns)) {
    const present = new Set((database.query(`PRAGMA table_info(${table})`).all() as Array<{
      name?: unknown;
    }>).flatMap((row) => typeof row.name === "string" ? [row.name] : []));
    for (const column of columns) {
      if (!present.has(column)) throw new Error(`WORK_SCHEMA_STALE:${table}.${column}`);
    }
  }
  if (database.query(
    `SELECT 1
     FROM sessions AS s
     WHERE s.provider_v39='devin' AND s.preset_contract!=${devinPresetContract}
     LIMIT 1`,
  ).get() !== null) {
    throw new Error("WORK_SCHEMA_DEVIN_SESSION_PRESET_CONTRACT_INVALID");
  }
  if (database.query(
    `SELECT 1
     FROM works AS w
     JOIN sessions AS s ON s.id=w.coordinator_session_id
     WHERE s.provider_v39='devin' AND w.preset_contract!=${devinPresetContract}
     LIMIT 1`,
  ).get() !== null) {
    throw new Error("WORK_SCHEMA_DEVIN_WORK_PRESET_CONTRACT_INVALID");
  }
  const clock = database.query(
    "SELECT logical_time FROM work_clock WHERE singleton=1",
  ).get() as { logical_time?: unknown } | null;
  if (!Number.isSafeInteger(clock?.logical_time) || (clock?.logical_time as number) < 0) {
    throw new Error("WORK_SCHEMA_CLOCK_MISSING");
  }
};

// Writable opens verify schema identity and row-level referential integrity.
// The foreign_key_check scans every child row, so it belongs only on the
// connection that can repair or refuse the database.
export function assertLegacyVersion42WorkSchema(database: Database): void {
  assertWorkSchemaShape(database, canonical49WorkAuthorityTriggerSql, canonicalNonAuthorityWorkTriggerSql);
  const integrity = database.query("PRAGMA foreign_key_check").all();
  if (integrity.length !== 0) throw new Error("WORK_SCHEMA_FOREIGN_KEY_VIOLATION");
}

export function assertWorkSchema(database: Database): void {
  assertWorkSchemaShape(database);
  const integrity = database.query("PRAGMA foreign_key_check").all();
  if (integrity.length !== 0) throw new Error("WORK_SCHEMA_FOREIGN_KEY_VIOLATION");
  assertWorkProjectAuthoritySchema(database);
}

const installCanonicalWorkSchema = (database: Database, version: 40 | 42): void => {
  const install = database.transaction(() => {
    // CREATE IF NOT EXISTS preserves admitted legacy ALTER placement. Do not
    // rebuild an existing Work table or import the evolving runtime SQL here.
    for (const [, , sql] of CANONICAL_WORK_CORE_DEFINITIONS) database.exec(sql);
    database.exec(CANONICAL_WORK_CLOCK_SEED_SQL);
    const authority = new Map<string, string>(CANONICAL_40_WORK_AUTHORITY_TRIGGER_DEFINITIONS);
    if (version === 42) {
      for (const [name, sql] of CANONICAL_49_WORK_PRESET_GUARD_DEFINITIONS) authority.set(name, sql);
    }
    for (const [name, sql] of [...authority, ...CANONICAL_WORK_NON_AUTHORITY_TRIGGER_DEFINITIONS]) {
      database.exec(`DROP TRIGGER IF EXISTS ${name}`);
      database.exec(sql);
    }
    if (version === 40) assertProviderVersion40WorkSchema(database);
    else assertLegacyVersion42WorkSchema(database);
  });
  install.immediate();
};

/**
 * Migration-only canonical40/41 installer. The caller must first admit the
 * predecessor and install its parent authority tables. This does not install
 * usage registry predicates or allocate a migration/ledger version.
 */
export function installCanonicalVersion40WorkSchema(database: Database): void {
  installCanonicalWorkSchema(database, 40);
}

/**
 * Migration-only canonical42–49 installer. The v49 nullable-project companion
 * remains a separate append-only step. Existing rows and table DDL stay intact;
 * parent/custody/full-cohort safety is the surrounding admission's concern.
 */
export function installCanonicalVersion42WorkSchema(database: Database): void {
  installCanonicalWorkSchema(database, 42);
}

/**
 * Restore the complete frozen Work authority surface owned by provider schema
 * v40/v41. Callers first install the additive Work objects, then use this
 * bounded replacement before the v40 migration waypoint can commit.
 */
export function installProviderVersion40WorkAuthoritySchema(database: Database): void {
  for (const name of exactWorkAuthorityTriggerNames) {
    database.exec(`DROP TRIGGER IF EXISTS ${name}`);
  }
  for (const [, sql] of providerVersion40WorkAuthorityDefinitionEntries) {
    database.exec(sql);
  }
  assertProviderVersion40WorkSchema(database);
}

/** Exact Work authority surface shipped with adoption schema v40. */
export function assertProviderVersion40WorkSchema(database: Database): void {
  assertWorkSchemaShape(database, providerVersion40WorkAuthorityTriggerSql, canonicalNonAuthorityWorkTriggerSql);
  const integrity = database.query("PRAGMA foreign_key_check").all();
  if (integrity.length !== 0) throw new Error("WORK_SCHEMA_V40_FOREIGN_KEY_VIOLATION");
}

/**
 * Exact authority surface shipped by provider schema v39 immediately before
 * adoption v40. This is deliberately narrower than a repair: it proves the
 * only predecessor whose Work guards may be replaced during the migration.
 */
export function assertProviderVersion39WorkSchema(database: Database): void {
  const tableRows = database.query("PRAGMA table_list").all() as Array<{
    name?: unknown;
    strict?: unknown;
    type?: unknown;
  }>;
  const tables = new Map(
    tableRows
      .filter((row) => row.type === "table" && typeof row.name === "string")
      .map((row) => [row.name as string, row.strict]),
  );
  for (const name of requiredWorkTables) {
    if (!tables.has(name)) throw new Error(`WORK_SCHEMA_V39_MISSING:${name}`);
    if (tables.get(name) !== 1) throw new Error(`WORK_SCHEMA_V39_NOT_STRICT:${name}`);
  }

  const triggerRows = database.query(
    "SELECT name,type,tbl_name,sql FROM sqlite_master WHERE type='trigger'",
  ).all() as Array<{
    name?: unknown;
    type?: unknown;
    tbl_name?: unknown;
    sql?: unknown;
  }>;
  const triggers = new Map(triggerRows.flatMap((row) =>
    typeof row.name === "string" ? [[row.name, row] as const] : []));
  for (const name of requiredWorkTriggers) {
    if (providerVersion39AddedAuthorityTriggerNames.has(name)) {
      if (triggers.has(name)) throw new Error(`WORK_SCHEMA_V39_UNEXPECTED_TRIGGER:${name}`);
    } else if (!triggers.has(name)) {
      throw new Error(`WORK_SCHEMA_V39_MISSING_TRIGGER:${name}`);
    }
  }
  for (const name of exactWorkAuthorityTriggerNames) {
    if (providerVersion39AddedAuthorityTriggerNames.has(name)) continue;
    const row = triggers.get(name);
    const expected = name === "work_signal_member_guard"
      ? providerVersion39SignalMemberGuardSql
      : providerVersion40WorkAuthorityTriggerSql.get(name);
    if (
      row?.type !== "trigger"
      || typeof row.tbl_name !== "string"
      || typeof row.sql !== "string"
      || normalizeWorkSchemaSql(row.sql) !== expected
    ) throw new Error(`WORK_SCHEMA_V39_STALE_TRIGGER:${name}`);
  }
  for (const [name, expected] of canonicalNonAuthorityWorkTriggerSql) {
    if (providerVersion39AddedAuthorityTriggerNames.has(name)) continue;
    const row = triggers.get(name);
    if (
      row?.type !== "trigger"
      || typeof row.tbl_name !== "string"
      || typeof row.sql !== "string"
      || normalizeSchemaSql(row.sql) !== expected
    ) throw new Error(`WORK_SCHEMA_V39_STALE_TRIGGER:${name}`);
  }
  const requiredColumns: Readonly<Record<string, readonly string[]>> = {
    profiles: ["state", "process_generation", "provider_email"],
    sessions: ["provider_v39", "provider_thread_id", "preset_contract"],
    works: ["preset_contract"],
  };
  for (const [table, columns] of Object.entries(requiredColumns)) {
    const present = new Set((database.query(`PRAGMA table_info(${table})`).all() as Array<{
      name?: unknown;
    }>).flatMap((row) => typeof row.name === "string" ? [row.name] : []));
    for (const name of columns) {
      if (!present.has(name)) throw new Error(`WORK_SCHEMA_V39_MISSING_COLUMN:${table}.${name}`);
    }
  }
  const clock = database.query(
    "SELECT logical_time FROM work_clock WHERE singleton=1",
  ).get() as { logical_time?: unknown } | null;
  if (!Number.isSafeInteger(clock?.logical_time) || (clock?.logical_time as number) < 0) {
    throw new Error("WORK_SCHEMA_V39_CLOCK_MISSING");
  }
}

// Readonly opens (`oompa status`, `oompa doctor --offline`) verify the same table,
// trigger, column, and clock identity but skip the O(rows) foreign_key_check.
// A long readonly scan pins a WAL snapshot, and the writer's queue scrub
// checkpoint must wait for that snapshot before it can truncate the WAL.
export function assertReadonlyWorkSchema(database: Database): void {
  assertWorkSchemaShape(database);
  assertWorkProjectAuthoritySchema(database);
}

export type WorkStoreErrorCode =
  | "ATTEMPT_EXHAUSTED"
  | "ATTEMPT_NOT_OWNER"
  | "ATTEMPT_NOT_CLAIMABLE"
  | "ATTEMPT_NOT_FOUND"
  | "ATTEMPT_RECOVERY_REQUIRED"
  | "BAD_CURSOR"
  | "BAD_IDEMPOTENCY_KEY"
  | "DEPENDENCY_CYCLE"
  | "DEPENDENCY_INCOMPLETE"
  | "EVIDENCE_INVALID"
  | "FENCE_MISMATCH"
  | "IDEMPOTENCY_CONFLICT"
  | "LEASE_EXPIRED"
  | "MEMBER_NOT_FOUND"
  | "NO_READY_TASK"
  | "NOT_REVIEWABLE"
  | "REVISION_CONFLICT"
  | "ROUTE_MISMATCH"
  | "SESSION_PROVIDER_SWITCH_BLOCKED"
  | "SELF_REVIEW"
  | "SIGNAL_NOT_FOUND"
  | "TASK_DEPTH_EXCEEDED"
  | "TASK_LIMIT_EXCEEDED"
  | "TASK_NOT_FOUND"
  | "UNKNOWN_DEPENDENCY"
  | "UNKNOWN_PARENT"
  | "WORK_CAPACITY_EXCEEDED"
  | "WORK_NOT_ACTIVE"
  | "WORK_RELEASED"
  | "WORK_NOT_FOUND";

export class WorkStoreError extends Error {
  constructor(readonly code: WorkStoreErrorCode) {
    super(code);
    this.name = "WorkStoreError";
  }
}

type JsonPrimitive = boolean | null | number | string;
type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

function normalizeJson(value: unknown): JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("WORK_JSON_NONFINITE");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const normalized: Record<string, JsonValue> = {};
    for (const key of Object.keys(record).sort()) {
      const child = record[key];
      if (child === undefined) throw new Error("WORK_JSON_UNDEFINED");
      normalized[key] = normalizeJson(child);
    }
    return normalized;
  }
  throw new Error("WORK_JSON_UNSUPPORTED");
}

export function canonicalWorkJson(value: unknown): string {
  return JSON.stringify(normalizeJson(value));
}

export { workPreparedEffectMessage };

function digestText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function digestJson(value: unknown): string {
  return digestText(canonicalWorkJson(value));
}

function deriveNestedMutationKey(idempotencyKey: string): string {
  if (!isUuidV7(idempotencyKey)) throw new WorkStoreError("BAD_IDEMPOTENCY_KEY");
  const compact = idempotencyKey.replaceAll("-", "");
  const entropy = digestText(`hra-work-nested-mutation-v1\0${idempotencyKey}`);
  const variant = ((Number.parseInt(entropy[3] ?? "0", 16) & 0x3) | 0x8).toString(16);
  const nested = `${compact.slice(0, 12)}7${entropy.slice(0, 3)}${variant}${entropy.slice(4, 19)}`;
  const formatted = `${nested.slice(0, 8)}-${nested.slice(8, 12)}-${nested.slice(12, 16)}-${nested.slice(16, 20)}-${nested.slice(20)}`;
  if (!isUuidV7(formatted) || formatted === idempotencyKey) {
    throw new Error("WORK_NESTED_IDEMPOTENCY_DERIVATION_INVALID");
  }
  return formatted;
}

function parseStoredJson(value: unknown): unknown {
  if (typeof value !== "string") throw new Error("WORK_STORED_JSON_INVALID");
  return JSON.parse(value) as unknown;
}

function boundedLimit(value: number | undefined, maximum = WORK_PAGE_LIMIT): number {
  if (value === undefined) return Math.min(50, maximum);
  if (!Number.isInteger(value) || value < 1) throw new WorkStoreError("BAD_CURSOR");
  return Math.min(value, maximum);
}

type WorkRow = Readonly<{
  id: string;
  client_ref: string;
  coordinator_session_id: string;
  objective: string;
  preset_contract: 1 | 2;
  state: "active" | "cancel_pending" | "fail_pending" | "completed" | "failed" | "cancelled";
  revision: number;
  stream_epoch: string;
  next_sequence: number;
  head_hash: string | null;
  created_at: number;
  updated_at: number;
}>;

type TaskRow = Readonly<{
  id: string;
  work_id: string;
  client_ref: string;
  ordinal: number;
  parent_task_id: string | null;
  depth: number;
  objective: string;
  instructions: string;
  criteria_json: string;
  account_id: string;
  project_id: string;
  preset: "low" | "high" | "ultra";
  canonical_profile_key: unknown;
  fast: 0 | 1;
  priority: number;
  not_before: number | null;
  claim_by: number | null;
  deadline: number | null;
  max_attempts: number;
  required_reviews: number;
  result_kind: "text" | "json";
  min_evidence: number;
  created_at: number;
}>;

type TaskState =
  | "pending"
  | "claimed"
  | "dispatching"
  | "running"
  | "submitted"
  | "completed"
  | "failed"
  | "recovery_required"
  | "cancelled";

type TaskStateRow = Readonly<{
  task_id: string;
  work_id: string;
  state: TaskState;
  revision: number;
  next_fence: number;
  attempt_count: number;
  accepted_submission_id: string | null;
  retry_not_before: number | null;
  updated_at: number;
}>;

type AttemptState =
  | "claimed"
  | "dispatching"
  | "running"
  | "submitted"
  | "completed"
  | "blocked"
  | "failed"
  | "released"
  | "expired"
  | "recovery_required"
  | "cancelled";

type AttemptRow = Readonly<{
  id: string;
  work_id: string;
  task_id: string;
  worker_session_id: string;
  account_id: string;
  project_id: string;
  preset: "low" | "high" | "ultra";
  canonical_profile_key: unknown;
  fast: 0 | 1;
  fence: number;
  revision: number;
  state: AttemptState;
  lease_expires_at: number;
  target_session_id: string | null;
  dispatch_mode: "send" | null;
  submission_id: string | null;
  account_generation: number;
  daemon_generation: number;
  created_at: number;
  updated_at: number;
  terminal_at: number | null;
}>;

type AttemptReportRow = Readonly<{
  idempotency_key: string;
  work_id: string;
  attempt_id: string;
  kind: WorkAttemptReportRecord["reportKind"];
  report_json: string;
  report_digest: string;
  created_at: number;
  task_id: string;
}>;

type ReleaseTombstoneRow = Readonly<{
  work_id: string;
  release_idempotency_key: string;
  release_request_digest: string;
  client_ref_digest: string;
  coordinator_session_id: string;
  terminal_kind: "work.complete" | "work.fail" | "work.cancel";
  terminal_request_digest: string;
  final_revision: number;
  final_head_hash: string;
  discarded_counts_json: string;
  discarded_records_digest: string;
  released_at: number;
  retention_upper_bound_at: number;
  result_json: string;
}>;

type SubmissionRow = Readonly<{
  id: string;
  work_id: string;
  task_id: string;
  attempt_id: string;
  worker_session_id: string;
  summary: string;
  result_json: string;
  evidence_json: string;
  content_digest: string;
  created_at: number;
}>;

type ReviewRow = Readonly<{
  id: string;
  work_id: string;
  submission_id: string;
  reviewer_session_id: string;
  decision: "accept" | "revise" | "reject";
  review_json: string;
  created_at: number;
}>;

type PreparedEffectRow = Readonly<{
  idempotency_key: string;
  work_id: string;
  effect_kind: "attempt_dispatch" | "signal_send";
  subject_id: string;
  instruction_json: string;
  instruction_digest: string;
  daemon_generation: number;
  state: "prepared" | "effect_started" | "accepted" | "failed" | "unknown";
  outcome_digest: string | null;
  outcome_json: string | null;
  prepared_at: number;
  finalized_at: number | null;
}>;

type StoredWorkEventRow = Readonly<{
  work_id: string;
  sequence: number;
  revision: number;
  stream_epoch: string;
  kind: string;
  actor_session_id: string | null;
  payload_json: string;
  payload_digest: string;
  previous_hash: string | null;
  event_hash: string;
  daemon_generation: number;
  recorded_at: number;
}>;

type WorkTaskHistoryKind = WorkTaskHistoryItem["kind"];
type WorkTaskHistoryMetadataRow = Readonly<{
  kind: WorkTaskHistoryKind;
  ordinal: number;
  stable_key: string;
  created_at: number;
  through_attempts: number;
  through_attempt_reports: number;
  through_submissions: number;
  through_reviews: number;
  through_signals: number;
}>;
type WorkTaskHistoryVersionCandidate = Readonly<{
  historyOrdinal: number;
  workId: string;
  taskId: string;
  recordJson: string;
  recordDigest: string;
}>;

type NestedMutationRow = Readonly<{
  id: string;
  kind: string;
  authority_id: string;
  authority_generation: number;
  request_digest: string;
  state: "prepared" | "effect_started" | "applied" | "failed" | "ambiguous" | "cancelled";
  result_json: string | null;
  resolution_kind: "proven_applied" | "provider_state_reconciled" | "abandoned" | null;
  receipt_json: string | null;
  evidence_json: string | null;
}>;

export type WorkDispatchInstruction = Extract<WorkPreparedEffect, { kind: "dispatch" }>;
export type WorkSignalInstruction = Extract<WorkPreparedEffect, { kind: "signal" }>;

export type WorkPreparedEffectAuthorization =
  | Readonly<{
      executable: true;
      disposition: "execute";
      status: WorkPreparedEffectStatus;
      effect: WorkPreparedEffect;
    }>
  | Readonly<{
      executable: false;
      disposition: "settled";
      status: WorkPreparedEffectStatus;
    }>;

export type WorkRecoverablePreparedEffectCursor = Readonly<{
  preparedAt: number;
  idempotencyKey: string;
}>;

export type WorkRecoverablePreparedEffectPage = Readonly<{
  effects: readonly Readonly<{
    idempotencyKey: string;
    preparedAt: number;
    status: WorkPreparedEffectStatus;
    effect: WorkPreparedEffect;
  }>[];
  nextCursor: WorkRecoverablePreparedEffectCursor | null;
}>;

export type WorkPreparedEffectRecord = Readonly<{
  status: WorkPreparedEffectStatus;
  effect: WorkPreparedEffect;
}>;

export type WorkDispatchOutcome =
  | Readonly<{ kind: "accepted"; receipt: WorkNestedEffectReceipt }>
  | Readonly<{ kind: "failed"; code: string }>
  | Readonly<{ kind: "unknown"; code: string }>;

export type WorkSignalOutcome =
  | Readonly<{ kind: "accepted"; receipt: WorkNestedEffectReceipt }>
  | Readonly<{ kind: "failed"; code: string }>
  | Readonly<{ kind: "unknown"; code: string }>;

export type WorkCursorEncoder = (payload:
  | Readonly<{
      version: 1;
      type: "work";
      workId: string;
      streamEpoch: string;
      sequence: number;
    }>
  | WorkActionCursorPayload
  | WorkTaskHistoryCursorPayload
) => string;

export type WorkCapabilityAuthority =
  | Readonly<{ scope: "coordinator"; workId: string; sessionId: string }>
  | Readonly<{ scope: "member"; workId: string; sessionId: string }>
  | Readonly<{
      scope: "attempt";
      workId: string;
      sessionId: string;
      attemptId: string;
      fence: number;
    }>;

export type WorkCapabilityIssuer = (authority: WorkCapabilityAuthority) => string;
export type WorkCapabilityVerifier = (
  capability: string,
  authority: WorkCapabilityAuthority,
) => boolean;
export type WorkProviderIdentifierProjector = (rawProviderIdentifier: string) => string;

export type WorkEventRecord = Readonly<{
  workId: string;
  streamEpoch: string;
  sequence: number;
  revision: number;
  kind: string;
  actorSessionId?: string;
  payload: unknown;
  payloadDigest: string;
  previousHash?: string;
  eventHash: string;
  daemonGeneration: number;
  recordedAt: number;
}>;

export type WorkEventPage = Readonly<{
  protocol: typeof WORK_PROTOCOL;
  version: typeof WORK_PROTOCOL_VERSION;
  workId: string;
  streamEpoch: string;
  afterSequence: number;
  observedThroughSequence: number;
  events: readonly WorkEventRecord[];
  nextSequence: number | null;
}>;

export type WorkApplyResult = WorkOperationResult;

function assertOutcomeCode(code: string): string {
  if (!/^[a-z][a-z0-9_]{0,119}$/u.test(code)) throw new Error("WORK_OUTCOME_CODE_INVALID");
  return code;
}

function parseDispatchOutcome(input: unknown): WorkDispatchOutcome {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("WORK_DISPATCH_OUTCOME_INVALID");
  }
  const candidate = input as Record<string, unknown>;
  const keys = Object.keys(candidate).sort();
  if (candidate.kind === "accepted") {
    if (
      keys.length !== 2 || keys[0] !== "kind" || keys[1] !== "receipt"
    ) throw new Error("WORK_DISPATCH_OUTCOME_INVALID");
    return { kind: "accepted", receipt: workNestedEffectReceiptSchema.parse(candidate.receipt) };
  }
  if (
    (candidate.kind !== "failed" && candidate.kind !== "unknown")
    || typeof candidate.code !== "string"
    ||
    keys.length !== 2
    || keys[0] !== "code"
    || keys[1] !== "kind"
  ) throw new Error("WORK_DISPATCH_OUTCOME_INVALID");
  return { kind: candidate.kind, code: assertOutcomeCode(candidate.code) };
}

function parseSignalOutcome(input: unknown): WorkSignalOutcome {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("WORK_SIGNAL_OUTCOME_INVALID");
  }
  const candidate = input as Record<string, unknown>;
  const keys = Object.keys(candidate).sort();
  if (candidate.kind === "accepted") {
    if (
      keys.length !== 2 || keys[0] !== "kind" || keys[1] !== "receipt"
    ) throw new Error("WORK_SIGNAL_OUTCOME_INVALID");
    return {
      kind: candidate.kind,
      receipt: workNestedEffectReceiptSchema.parse(candidate.receipt),
    };
  }
  if (
    (candidate.kind !== "failed" && candidate.kind !== "unknown")
    || typeof candidate.code !== "string"
    ||
    keys.length !== 2
    || keys[0] !== "code"
    || keys[1] !== "kind"
  ) throw new Error("WORK_SIGNAL_OUTCOME_INVALID");
  return { kind: candidate.kind, code: assertOutcomeCode(candidate.code) };
}

function mapEvent(row: Readonly<{
  work_id: string;
  sequence: number;
  revision: number;
  stream_epoch: string;
  kind: string;
  actor_session_id: string | null;
  payload_json: string;
  payload_digest: string;
  previous_hash: string | null;
  event_hash: string;
  daemon_generation: number;
  recorded_at: number;
}>): WorkEventRecord {
  return {
    workId: row.work_id,
    streamEpoch: row.stream_epoch,
    sequence: row.sequence,
    revision: row.revision,
    kind: row.kind,
    ...(row.actor_session_id === null ? {} : { actorSessionId: row.actor_session_id }),
    payload: parseStoredJson(row.payload_json),
    payloadDigest: row.payload_digest,
    ...(row.previous_hash === null ? {} : { previousHash: row.previous_hash }),
    eventHash: row.event_hash,
    daemonGeneration: row.daemon_generation,
    recordedAt: row.recorded_at,
  };
}

const canonicalRouteIdentitySchema = z.object({
  work_id: z.string(),
  account_id: z.string(),
  project_id: z.string(),
  preset: z.enum(["low", "high", "ultra"]),
  fast: z.union([z.literal(0), z.literal(1)]),
  canonical_profile_key: z.unknown(),
});
const canonicalTaskIdentitySchema = canonicalRouteIdentitySchema.extend({ id: z.string() });
const canonicalAttemptIdentitySchema = canonicalRouteIdentitySchema.extend({
  id: z.string(),
  task_id: z.string(),
  worker_session_id: z.string(),
  state: z.enum([
    "claimed", "dispatching", "running", "recovery_required", "submitted",
    "blocked", "completed", "failed", "released", "expired", "cancelled",
  ]),
});
const canonicalSessionIdentitySchema = z.object({
  provider_v39: z.unknown(),
  preset: z.unknown(),
  preset_contract: z.unknown(),
  canonical_profile_key: z.unknown(),
}).strict();

export class WorkStore {
  readonly #database: Database;
  readonly #now: () => number;
  readonly #daemonGeneration: number;
  readonly #encodeCursor: WorkCursorEncoder;
  readonly #issueCapability: WorkCapabilityIssuer;
  readonly #verifyCapability: WorkCapabilityVerifier;
  readonly #projectProviderIdentifier: WorkProviderIdentifierProjector;
  readonly #verifiedEvidence = new Map<string, Readonly<{
    taskId: string | null;
    evidenceDigest: string;
    authorityFingerprint: string;
  }>>();

  constructor(
    database: Database,
    options: Readonly<{
      now?: () => number;
      daemonGeneration: number;
      encodeCursor: WorkCursorEncoder;
      issueCapability: WorkCapabilityIssuer;
      verifyCapability: WorkCapabilityVerifier;
      projectProviderIdentifier: WorkProviderIdentifierProjector;
    }>,
  ) {
    if (!Number.isSafeInteger(options.daemonGeneration) || options.daemonGeneration < 0) {
      throw new Error("WORK_DAEMON_GENERATION_INVALID");
    }
    this.#database = database;
    this.#now = options.now ?? Date.now;
    this.#daemonGeneration = options.daemonGeneration;
    this.#encodeCursor = options.encodeCursor;
    this.#issueCapability = options.issueCapability;
    this.#verifyCapability = options.verifyCapability;
    this.#projectProviderIdentifier = options.projectProviderIdentifier;
    this.#database.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    assertWorkSchema(this.#database);
    assertWorkSignalProviderAuthorities(this.#database);
    assertLegacyCanonicalProfileStorageSchema(this.#database);
  }

  // These are bounded source-row checks, not a migration-wide scan. Do not
  // cache their results: settled history and current worker identity can
  // legitimately diverge, while corruption must never become stale authority.
  #canonicalWorkKey(workId: string, preset: unknown): string {
    const source: unknown = this.#database.query(
      "SELECT preset_contract FROM main.works WHERE id COLLATE BINARY=?",
    ).get(workId);
    const parsed = z.object({ preset_contract: z.unknown() }).strict().safeParse(source);
    const key = parsed.success
      ? deriveLegacyWorkProfileKey(preset, parsed.data.preset_contract)
      : null;
    if (key === null) throw new Error("WORK_CANONICAL_PROFILE_CORRUPT");
    return key;
  }

  #canonicalSessionKey(sessionId: string): string | null {
    const source: unknown = this.#database.query(
      `SELECT provider_v39,preset,preset_contract,canonical_profile_key
       FROM main.sessions WHERE id COLLATE BINARY=?`,
    ).get(sessionId);
    if (source === null) return null;
    const parsed = canonicalSessionIdentitySchema.safeParse(source);
    if (!parsed.success) throw new Error("WORK_CANONICAL_PROFILE_CORRUPT");
    const key = deriveLegacySessionProfileKey(
      parsed.data.provider_v39, parsed.data.preset, parsed.data.preset_contract,
    );
    if (key === null || parsed.data.canonical_profile_key !== key) {
      throw new Error("WORK_CANONICAL_PROFILE_CORRUPT");
    }
    return key;
  }

  #assertCanonicalRoute(source: unknown): string {
    const parsed = canonicalRouteIdentitySchema.safeParse(source);
    if (!parsed.success) throw new Error("WORK_CANONICAL_PROFILE_CORRUPT");
    const route = parsed.data;
    const key = this.#canonicalWorkKey(route.work_id, route.preset);
    if (route.canonical_profile_key !== key) {
      throw new Error("WORK_CANONICAL_PROFILE_CORRUPT");
    }
    const parents: unknown = this.#database.query(
      `SELECT (
         EXISTS (SELECT 1 FROM main.profiles WHERE id COLLATE BINARY=?)
         AND EXISTS (SELECT 1 FROM main.projects WHERE id COLLATE BINARY=?)
       ) AS valid`,
    ).get(route.account_id, route.project_id);
    if (!z.object({ valid: z.literal(1) }).strict().safeParse(parents).success) {
      throw new Error("WORK_CANONICAL_PROFILE_CORRUPT");
    }
    return key;
  }

  #assertCanonicalTask(source: unknown): string {
    const parsed = canonicalTaskIdentitySchema.safeParse(source);
    if (!parsed.success) throw new Error("WORK_CANONICAL_PROFILE_CORRUPT");
    const task = parsed.data;
    const key = this.#canonicalWorkKey(task.work_id, task.preset);
    if (task.canonical_profile_key !== key) {
      throw new Error("WORK_CANONICAL_PROFILE_CORRUPT");
    }
    const route: unknown = this.#database.query(
      `SELECT work_id,account_id,project_id,preset,fast,canonical_profile_key
       FROM main.work_routes WHERE work_id COLLATE BINARY=?
         AND account_id COLLATE BINARY=? AND project_id COLLATE BINARY=?
         AND preset COLLATE BINARY=? AND fast=?`,
    ).get(task.work_id, task.account_id, task.project_id, task.preset, task.fast);
    if (this.#assertCanonicalRoute(route) !== key) {
      throw new Error("WORK_CANONICAL_PROFILE_CORRUPT");
    }
    return key;
  }

  #canonicalTaskIdentity(taskId: string, workId: string) {
    const source: unknown = this.#database.query(
      `SELECT id,work_id,account_id,project_id,preset,fast,canonical_profile_key
       FROM main.work_tasks WHERE id COLLATE BINARY=? AND work_id COLLATE BINARY=?`,
    ).get(taskId, workId);
    const parsed = canonicalTaskIdentitySchema.safeParse(source);
    if (!parsed.success) throw new Error("WORK_CANONICAL_PROFILE_CORRUPT");
    this.#assertCanonicalTask(parsed.data);
    return parsed.data;
  }

  #assertCanonicalTaskReferences(taskId: string, workId: string): void {
    // Validate only direct parent/dependency sources; different task routes are
    // valid, and damaged ancestry must not induce a recursive traversal.
    const references = this.#database.query(
      `SELECT parent_task_id AS related_task_id FROM main.work_tasks
       WHERE id COLLATE BINARY=? AND work_id COLLATE BINARY=? AND parent_task_id IS NOT NULL
       UNION ALL
       SELECT dependency_task_id AS related_task_id FROM main.work_task_dependencies
       WHERE work_id COLLATE BINARY=? AND task_id COLLATE BINARY=?`,
    ).all(taskId, workId, workId, taskId);
    for (const source of references) {
      const parsed = z.object({ related_task_id: z.string() }).strict().safeParse(source);
      if (!parsed.success) throw new Error("WORK_CANONICAL_PROFILE_CORRUPT");
      this.#canonicalTaskIdentity(parsed.data.related_task_id, workId);
    }
  }

  #assertCanonicalAttempt(source: unknown): void {
    const parsed = canonicalAttemptIdentitySchema.safeParse(source);
    if (!parsed.success) throw new Error("WORK_CANONICAL_PROFILE_CORRUPT");
    const attempt = parsed.data;
    const task = this.#canonicalTaskIdentity(attempt.task_id, attempt.work_id);
    if (
      attempt.account_id !== task.account_id || attempt.project_id !== task.project_id
      || attempt.preset !== task.preset || attempt.fast !== task.fast
      || attempt.canonical_profile_key !== task.canonical_profile_key
    ) throw new Error("WORK_CANONICAL_PROFILE_CORRUPT");
    const workerKey = this.#canonicalSessionKey(attempt.worker_session_id);
    if (workerKey === null || (
      ["claimed", "dispatching", "running", "recovery_required"].includes(attempt.state)
      && workerKey !== attempt.canonical_profile_key
    )) throw new Error("WORK_CANONICAL_PROFILE_CORRUPT");
  }

  #canonicalAttemptIdentity(attemptId: string, workId: string, taskId?: string): void {
    const source: unknown = this.#database.query(
      `SELECT id,work_id,task_id,worker_session_id,account_id,project_id,preset,
              fast,canonical_profile_key,state
       FROM main.work_attempts WHERE id COLLATE BINARY=? AND work_id COLLATE BINARY=?`,
    ).get(attemptId, workId);
    const parsed = canonicalAttemptIdentitySchema.safeParse(source);
    if (!parsed.success || (taskId !== undefined && parsed.data.task_id !== taskId)) {
      throw new Error("WORK_CANONICAL_PROFILE_CORRUPT");
    }
    this.#assertCanonicalAttempt(parsed.data);
  }

  #canonicalSubmissionIdentity(submissionId: string, workId?: string, taskId?: string): void {
    const source: unknown = this.#database.query(
      `SELECT work_id,task_id,attempt_id FROM main.work_submissions
       WHERE id COLLATE BINARY=?`,
    ).get(submissionId);
    const parsed = z.object({
      work_id: z.string(), task_id: z.string(), attempt_id: z.string(),
    }).strict().safeParse(source);
    if (!parsed.success || (workId !== undefined && parsed.data.work_id !== workId)
      || (taskId !== undefined && parsed.data.task_id !== taskId)) {
      throw new Error("WORK_CANONICAL_PROFILE_CORRUPT");
    }
    this.#canonicalAttemptIdentity(
      parsed.data.attempt_id, parsed.data.work_id, parsed.data.task_id,
    );
  }

  #canonicalSignalIdentity(signalId: string, workId: string, taskId?: string): void {
    const source: unknown = this.#database.query(
      `SELECT s.task_id,s.to_session_id,w.preset_contract
       FROM main.work_signals AS s
       JOIN main.works AS w ON w.id COLLATE BINARY=s.work_id COLLATE BINARY
       WHERE s.id COLLATE BINARY=? AND s.work_id COLLATE BINARY=?`,
    ).get(signalId, workId);
    const parsed = z.object({
      task_id: z.string().nullable(), to_session_id: z.string(),
      preset_contract: z.union([z.literal(1), z.literal(2)]),
    }).strict().safeParse(source);
    if (!parsed.success || (taskId !== undefined && parsed.data.task_id !== taskId)) {
      throw new Error("WORK_CANONICAL_PROFILE_CORRUPT");
    }
    if (parsed.data.task_id !== null) this.#canonicalTaskIdentity(parsed.data.task_id, workId);
    if (this.#canonicalSessionKey(parsed.data.to_session_id) === null) {
      throw new Error("WORK_CANONICAL_PROFILE_CORRUPT");
    }
  }

  #assertCanonicalHistorySource(
    workId: string, taskId: string, kind: WorkTaskHistoryKind, stableKey: string,
  ): void {
    this.#canonicalTaskIdentity(taskId, workId);
    switch (kind) {
      case "attempt":
        this.#canonicalAttemptIdentity(stableKey, workId, taskId);
        return;
      case "submission":
        this.#canonicalSubmissionIdentity(stableKey, workId, taskId);
        return;
      case "attempt_report": {
        const source: unknown = this.#database.query(
          `SELECT attempt_id FROM main.work_attempt_reports
           WHERE idempotency_key COLLATE BINARY=? AND work_id COLLATE BINARY=?`,
        ).get(stableKey, workId);
        const parsed = z.object({ attempt_id: z.string() }).strict().safeParse(source);
        if (!parsed.success) throw new Error("WORK_CANONICAL_PROFILE_CORRUPT");
        this.#canonicalAttemptIdentity(parsed.data.attempt_id, workId, taskId);
        return;
      }
      case "review": {
        const source: unknown = this.#database.query(
          `SELECT submission_id FROM main.work_reviews
           WHERE id COLLATE BINARY=? AND work_id COLLATE BINARY=?`,
        ).get(stableKey, workId);
        const parsed = z.object({ submission_id: z.string() }).strict().safeParse(source);
        if (!parsed.success) throw new Error("WORK_CANONICAL_PROFILE_CORRUPT");
        this.#canonicalSubmissionIdentity(parsed.data.submission_id, workId, taskId);
        return;
      }
      case "signal": {
        this.#canonicalSignalIdentity(stableKey, workId, taskId);
        return;
      }
    }
  }

  protocol(): WorkProtocolDescription {
    return structuredClone(WORK_PROTOCOL_DESCRIPTION);
  }

  /**
   * StateStore authority changes call into WorkStore from an enclosing SQLite
   * transaction.  Identity, rather than a matching pathname, proves those
   * writes participate in that same transaction.
   */
  isBackedByDatabase(database: Database): boolean {
    return this.#database === database;
  }

  #capability(authority: WorkCapabilityAuthority): string {
    return workCapabilitySchema.parse(this.#issueCapability(authority));
  }

  #assertCapability(capability: string, authority: WorkCapabilityAuthority): void {
    let valid = false;
    try {
      valid = this.#verifyCapability(capability, authority);
    } catch {
      valid = false;
    }
    if (!valid) throw new WorkStoreError("ATTEMPT_NOT_OWNER");
  }

  #authorizeOperation(operation: WorkOperation): void {
    const member = (sessionId: string, capability: string): void =>
      this.#assertCapability(capability, {
        scope: "member",
        workId: operation.kind === "work.create" ? "" : operation.workId,
        sessionId,
      });
    switch (operation.kind) {
      case "work.create": return;
      case "task.addBatch":
      case "work.join":
        this.#assertCapability(operation.coordinatorCapability, {
          scope: "coordinator",
          workId: operation.workId,
          sessionId: operation.coordinatorSessionId,
        });
        return;
      case "work.complete":
      case "work.fail":
      case "work.cancel":
      case "work.release":
        this.#assertCapability(operation.coordinatorCapability, {
          scope: "coordinator",
          workId: operation.workId,
          sessionId: operation.actorSessionId,
        });
        return;
      case "task.claim":
      case "task.claimNext":
        member(operation.actorSessionId, operation.actorCapability);
        return;
      case "task.claimBatch":
        for (const claim of operation.claims) member(claim.actorSessionId, claim.actorCapability);
        return;
      case "attempt.renew":
      case "attempt.release":
      case "attempt.dispatch":
      case "attempt.report":
      case "attempt.reconcile":
        this.#assertCapability(operation.attemptCapability, {
          scope: "attempt",
          workId: operation.workId,
          sessionId: operation.actorSessionId,
          attemptId: operation.attemptId,
          fence: operation.fence,
        });
        return;
      case "submission.review":
        member(operation.reviewerSessionId, operation.reviewerCapability);
        return;
      case "signal.send":
        member(operation.senderSessionId, operation.senderCapability);
        return;
      case "signal.ack":
        member(operation.actorSessionId, operation.actorCapability);
        return;
    }
  }

  #effectStatusFromRow(effect: PreparedEffectRow): WorkPreparedEffectStatus {
    if (effect.effect_kind === "attempt_dispatch") {
      this.#canonicalAttemptIdentity(effect.subject_id, effect.work_id);
    } else {
      this.#canonicalSignalIdentity(effect.subject_id, effect.work_id);
    }
    const target = effect.effect_kind === "attempt_dispatch"
      ? this.#database.query(
        "SELECT target_session_id AS target FROM work_attempts WHERE id=?",
      ).get(effect.subject_id) as { target: string | null } | null
      : this.#database.query(
        "SELECT to_session_id AS target FROM work_signals WHERE id=?",
      ).get(effect.subject_id) as { target: string | null } | null;
    if (target?.target === null || target?.target === undefined) {
      throw new Error("WORK_EFFECT_TARGET_MISSING");
    }
    return workPreparedEffectStatusSchema.parse({
      kind: effect.effect_kind === "attempt_dispatch" ? "dispatch" : "signal",
      idempotencyKey: effect.idempotency_key,
      subjectId: effect.subject_id,
      targetSessionId: target.target,
      instructionDigest: effect.instruction_digest,
      state: effect.state,
    });
  }

  effectStatus(idempotencyKey: string): WorkPreparedEffectStatus | null {
    if (!isUuidV7(idempotencyKey)) throw new WorkStoreError("BAD_IDEMPOTENCY_KEY");
    const effect = this.#database.query(
      "SELECT * FROM work_prepared_effects WHERE idempotency_key=?",
    ).get(idempotencyKey) as PreparedEffectRow | null;
    return effect === null ? null : this.#effectStatusFromRow(effect);
  }

  #preparedEffectFromRow(row: PreparedEffectRow): WorkPreparedEffectRecord {
    const effect = workPreparedEffectSchema.parse(parseStoredJson(row.instruction_json));
    if (
      digestText(row.instruction_json) !== row.instruction_digest
      || effect.workId !== row.work_id
      || (effect.kind === "dispatch" ? effect.attemptId : effect.signalId) !== row.subject_id
    ) throw new Error("WORK_EFFECT_INSTRUCTION_CORRUPT");
    return { status: this.#effectStatusFromRow(row), effect };
  }

  preparedEffect(idempotencyKey: string): WorkPreparedEffectRecord | null {
    if (!isUuidV7(idempotencyKey)) throw new WorkStoreError("BAD_IDEMPOTENCY_KEY");
    const row = this.#database.query(
      "SELECT * FROM work_prepared_effects WHERE idempotency_key=?",
    ).get(idempotencyKey) as PreparedEffectRow | null;
    return row === null ? null : this.#preparedEffectFromRow(row);
  }

  recoverablePreparedEffects(
    after?: WorkRecoverablePreparedEffectCursor,
    limit = 32,
  ): WorkRecoverablePreparedEffectPage {
    if (
      after !== undefined
      && (
        !Number.isSafeInteger(after.preparedAt)
        || after.preparedAt < 0
        || !isUuidV7(after.idempotencyKey)
      )
    ) throw new WorkStoreError("BAD_CURSOR");
    const bounded = boundedLimit(limit, 64);
    const read = this.#database.transaction((): WorkRecoverablePreparedEffectPage => {
      const rows = this.#database.query(
        `SELECT * FROM work_prepared_effects
         WHERE state IN ('prepared','effect_started','unknown')
           AND (? IS NULL OR prepared_at>? OR (prepared_at=? AND idempotency_key>?))
         ORDER BY prepared_at,idempotency_key LIMIT ?`,
      ).all(
        after?.idempotencyKey ?? null,
        after?.preparedAt ?? 0,
        after?.preparedAt ?? 0,
        after?.idempotencyKey ?? "",
        bounded + 1,
      ) as PreparedEffectRow[];
      const more = rows.length > bounded;
      const pageRows = more ? rows.slice(0, bounded) : rows;
      const effects = pageRows.map((row) => {
        const prepared = this.#preparedEffectFromRow(row);
        return {
          idempotencyKey: row.idempotency_key,
          preparedAt: row.prepared_at,
          ...prepared,
        };
      });
      const last = more ? pageRows.at(-1) : undefined;
      return {
        effects,
        nextCursor: last === undefined
          ? null
          : { preparedAt: last.prepared_at, idempotencyKey: last.idempotency_key },
      };
    });
    return read.deferred();
  }

  #assertLegacyNestedMutationKey(idempotencyKey: string): void {
    try {
      assertLegacyMutationOwnership(this.#database, { idempotencyKey });
    } catch (error) {
      if (error instanceof SessionSendOwnershipError) {
        throw new WorkStoreError("ATTEMPT_RECOVERY_REQUIRED");
      }
      throw error;
    }
  }

  #assertLegacyPreparedInstruction(row: PreparedEffectRow, instruction: WorkPreparedEffect): void {
    if (
      digestText(row.instruction_json) !== row.instruction_digest
      || instruction.workId !== row.work_id
      || (instruction.kind === "dispatch" ? instruction.attemptId : instruction.signalId) !== row.subject_id
      || instruction.kind !== (row.effect_kind === "attempt_dispatch" ? "dispatch" : "signal")
      || instruction.nestedMutationKey !== deriveNestedMutationKey(row.idempotency_key)
    ) throw new Error("WORK_EFFECT_INSTRUCTION_CORRUPT");
    this.#assertLegacyNestedMutationKey(instruction.nestedMutationKey);
  }

  #nestedMutation(effect: WorkPreparedEffect):
    | Readonly<{ state: "absent" | "prepared" | "failed" | "unknown" }>
    | Readonly<{ state: "accepted"; receipt: WorkNestedEffectReceipt }> {
    this.#assertLegacyNestedMutationKey(effect.nestedMutationKey);
    const table = this.#database.query(
      "SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='mutation_attempts'",
    ).get() as { present: number } | null;
    if (table === null) return { state: "absent" };
    const resolutionTable = this.#database.query(
      "SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='mutation_resolutions'",
    ).get() as { present: number } | null;
    const row = (resolutionTable === null
      ? this.#database.query(
        `SELECT m.id,m.kind,m.authority_id,m.authority_generation,m.request_digest,m.state,m.result_json,
                NULL AS resolution_kind,NULL AS receipt_json,e.evidence_json
         FROM mutation_attempts AS m
         LEFT JOIN mutation_effect_evidence AS e ON e.attempt_id=m.id
         WHERE m.idempotency_key=?`,
      ).get(effect.nestedMutationKey)
      : this.#database.query(
        `SELECT m.id,m.kind,m.authority_id,m.authority_generation,m.request_digest,m.state,m.result_json,
                r.resolution_kind,r.receipt_json,e.evidence_json
         FROM mutation_attempts AS m
         LEFT JOIN mutation_effect_evidence AS e ON e.attempt_id=m.id
         LEFT JOIN mutation_resolutions AS r ON r.attempt_id=m.id
         WHERE m.idempotency_key=?`,
      ).get(effect.nestedMutationKey)) as NestedMutationRow | null;
    if (row === null) return { state: "absent" };
    const expectedKind = effect.kind === "signal"
      ? effect.mode === "queue" ? "session.queue" : "session.steer"
      : "session.send";
    const signalAuthority = effect.kind === "signal" ? this.#signalProviderAuthority(effect) : null;
    if (effect.kind === "signal" && signalAuthority === null) return { state: "unknown" };
    const expectedGeneration = signalAuthority?.process_generation ?? effect.accountGeneration;
    const requestDigest = digestText(JSON.stringify({
      kind: expectedKind,
      authorityId: effect.targetSessionId,
      authorityGeneration: expectedGeneration,
      request: { message: workPreparedEffectMessage(effect) },
    }));
    if (
      row.kind !== expectedKind
      || row.authority_id !== effect.targetSessionId
      || row.authority_generation !== expectedGeneration
      || row.request_digest !== requestDigest
    ) return { state: "unknown" };
    if (signalAuthority !== null && this.#database.query(`SELECT 1 FROM mutation_provider_authorities authority
      WHERE authority.attempt_id=? AND authority.role='primary'
        AND authority.provider_account_id=? AND authority.profile_id=? AND authority.provider=?
        AND authority.binding_generation=? AND authority.process_generation=? AND authority.provenance=?
        AND (SELECT COUNT(*) FROM mutation_provider_authorities captured WHERE captured.attempt_id=authority.attempt_id)=1`)
      .get(row.id, signalAuthority.provider_account_id, signalAuthority.profile_id, signalAuthority.provider,
        signalAuthority.binding_generation, signalAuthority.process_generation,
        effect.kind === "signal" && effect.mode === "queue" ? "session_queue" : "session_steer") === null) {
      return { state: "unknown" };
    }
    if (
      (row.state === "applied" && row.result_json !== null)
      || (
        (row.resolution_kind === "proven_applied"
          || row.resolution_kind === "provider_state_reconciled")
        && row.receipt_json !== null
      )
    ) {
      try {
        const rawSource = row.resolution_kind === "proven_applied"
          || row.resolution_kind === "provider_state_reconciled"
          ? row.receipt_json
          : row.result_json;
        const raw = parseStoredJson(rawSource);
        if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
          return { state: "unknown" };
        }
        const value = raw as Record<string, unknown>;
        const base = {
          mutationAttemptId: row.id,
          accountGeneration: row.authority_generation,
        };
        const rawTurnId = typeof value.activeTurnId === "string"
          ? value.activeTurnId
          : typeof value.turnId === "string" ? value.turnId : "";
        let runtimeProfileDigest: string | null = null;
        if (effect.kind === "dispatch") {
          const effectiveRuntimeProfile = value.effectiveRuntimeProfile;
          if (effectiveRuntimeProfile !== undefined) {
            runtimeProfileDigest = digestJson(effectiveRuntimeProfile);
          } else if (row.evidence_json !== null) {
            const evidence = parseStoredJson(row.evidence_json);
            if (typeof evidence === "object" && evidence !== null && !Array.isArray(evidence)) {
              const runtimeProfile = (evidence as Record<string, unknown>).runtimeProfile;
              if (runtimeProfile !== undefined) runtimeProfileDigest = digestJson(runtimeProfile);
            }
          }
          if (runtimeProfileDigest === null && rawTurnId !== "") {
            const binding = this.#database.query(
              `SELECT profile_digest FROM session_turn_runtime_profiles
               WHERE session_id=? AND turn_id=? AND source_kind='turn_start' AND source_id=?
                 AND process_generation=?`,
            ).get(
              effect.targetSessionId,
              rawTurnId,
              row.id,
              row.authority_generation,
            ) as { profile_digest: string } | null;
            runtimeProfileDigest = binding?.profile_digest ?? null;
          }
          if (runtimeProfileDigest === null) return { state: "unknown" };
        }
        const receipt = effect.kind === "signal" && effect.mode === "queue"
          ? workNestedEffectReceiptSchema.parse({
              ...base,
              kind: "queue_created",
              queueId: value.queueId,
            })
          : effect.kind === "signal"
            ? workNestedEffectReceiptSchema.parse({
                ...base,
                kind: "turn_steered",
                turnId: this.#projectProviderIdentifier(rawTurnId),
              })
            : workNestedEffectReceiptSchema.parse({
                ...base,
                kind: "turn_started",
                turnId: this.#projectProviderIdentifier(rawTurnId),
                runtimeProfileDigest,
              });
        return { state: "accepted", receipt };
      } catch {
        return { state: "unknown" };
      }
    }
    if (row.state === "failed" || row.state === "cancelled" || row.resolution_kind === "abandoned") {
      return { state: "failed" };
    }
    if (row.state === "effect_started" || row.state === "ambiguous" || row.state === "applied") {
      return { state: "unknown" };
    }
    return { state: "prepared" };
  }

  #cancelNestedPrepared(effect: WorkPreparedEffect): void {
    this.#assertLegacyNestedMutationKey(effect.nestedMutationKey);
    const table = this.#database.query(
      "SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='mutation_attempts'",
    ).get() as { present: number } | null;
    if (table === null) return;
    const expectedKind = effect.kind === "signal"
      ? effect.mode === "queue" ? "session.queue" : "session.steer"
      : "session.send";
    const signalAuthority = effect.kind === "signal" ? this.#signalProviderAuthority(effect) : null;
    if (effect.kind === "signal" && signalAuthority === null) return;
    const expectedGeneration = signalAuthority?.process_generation ?? effect.accountGeneration;
    const requestDigest = digestText(JSON.stringify({
      kind: expectedKind,
      authorityId: effect.targetSessionId,
      authorityGeneration: expectedGeneration,
      request: { message: workPreparedEffectMessage(effect) },
    }));
    if (signalAuthority !== null && this.#database.query(`SELECT 1 FROM mutation_attempts mutation
      JOIN mutation_provider_authorities authority ON authority.attempt_id=mutation.id
      WHERE mutation.idempotency_key=? AND authority.role='primary'
        AND authority.provider_account_id=? AND authority.profile_id=? AND authority.provider=?
        AND authority.binding_generation=? AND authority.process_generation=? AND authority.provenance=?
        AND (SELECT COUNT(*) FROM mutation_provider_authorities captured WHERE captured.attempt_id=mutation.id)=1`)
      .get(effect.nestedMutationKey, signalAuthority.provider_account_id, signalAuthority.profile_id,
        signalAuthority.provider, signalAuthority.binding_generation, signalAuthority.process_generation,
        effect.kind === "signal" && effect.mode === "queue" ? "session_queue" : "session_steer") === null) return;
    this.#database.query(
      `UPDATE mutation_attempts SET state='cancelled',updated_at=?
       WHERE idempotency_key=? AND kind=? AND authority_id=? AND authority_generation=?
         AND request_digest=? AND state='prepared'`,
    ).run(
      this.#tick(),
      effect.nestedMutationKey,
      expectedKind,
      effect.targetSessionId,
      expectedGeneration,
      requestDigest,
    );
  }

  #dispatchAuthorityValid(effect: WorkDispatchInstruction, now: number): boolean {
    this.#canonicalAttemptIdentity(effect.attemptId, effect.workId, effect.taskId);
    const attempt = this.#database.query(
      "SELECT * FROM work_attempts WHERE id=? AND work_id=?",
    ).get(effect.attemptId, effect.workId) as AttemptRow | null;
    if (attempt !== null) this.#assertCanonicalAttempt(attempt);
    if (
      attempt === null
      || attempt.task_id !== effect.taskId
      || attempt.worker_session_id !== effect.targetSessionId
      || attempt.target_session_id !== effect.targetSessionId
      || attempt.fence !== effect.fence
      || attempt.account_generation !== effect.accountGeneration
      || attempt.state !== "dispatching"
      || attempt.lease_expires_at <= now
      || this.#requireWork(effect.workId).state !== "active"
    ) return false;
    const authority = this.#database.query(
      `SELECT 1 AS present
       FROM work_tasks AS t
       JOIN work_members AS m ON m.work_id=t.work_id AND m.session_id=?
       JOIN works AS w ON w.id=t.work_id
       JOIN sessions AS s ON s.id=m.session_id
       WHERE t.id=? AND t.work_id=?
         AND t.account_id=s.profile_id AND t.project_id=s.project_id
         AND t.preset=s.preset AND t.fast=s.fast_enabled
         AND s.provider_v39='codex'
         AND (s.preset_contract=w.preset_contract OR s.preset='low')
         AND ${currentWorkSessionAuthorityExistsSql(
           "s.id",
           "authority_profile.process_generation=?",
         )}`,
    ).get(
      effect.targetSessionId,
      effect.taskId,
      effect.workId,
      effect.accountGeneration,
    ) as { present: number } | null;
    return authority !== null;
  }

  #signalProviderAuthority(effect: WorkSignalInstruction): WorkSignalProviderAuthorityRow | null {
    try {
      const row = parseWorkSignalProviderAuthority(this.#database.query(
        "SELECT * FROM work_signal_provider_authorities WHERE signal_id=?",
      ).get(effect.signalId));
      return row.work_id === effect.workId && row.target_session_id === effect.targetSessionId ? row : null;
    } catch {
      return null;
    }
  }

  #signalAuthorityValid(effect: WorkSignalInstruction): boolean {
    this.#canonicalSignalIdentity(effect.signalId, effect.workId);
    this.#canonicalSessionKey(effect.targetSessionId);
    if (this.#requireWork(effect.workId).state !== "active") return false;
    const frozen = this.#signalProviderAuthority(effect);
    if (frozen === null) return false;
    const authority = this.#database.query(
      `SELECT 1 AS present
       FROM work_signals AS w
       JOIN work_members AS m ON m.work_id=w.work_id AND m.session_id=w.to_session_id
       JOIN sessions AS s ON s.id=m.session_id
       JOIN profiles AS p ON p.id=s.profile_id
       JOIN session_provider_authorities captured ON captured.session_id=s.id
       JOIN provider_accounts account ON account.id=captured.provider_account_id
       WHERE w.id=? AND w.work_id=? AND w.to_session_id=? AND w.mode=?
         AND w.target_account_generation=?
         AND s.profile_id=? AND s.provider_v39=?
         AND captured.provider_account_id=? AND captured.profile_id=s.profile_id
         AND captured.provider=s.provider_v39 AND captured.binding_generation=?
         AND captured.process_generation=? AND captured.authority_revision=?
         AND account.profile_id=captured.profile_id AND account.provider=captured.provider
         AND account.binding_generation=captured.binding_generation
         AND account.process_generation=captured.process_generation AND account.readiness!='removed'
         AND s.state IN ('active','idle') AND p.state!='removed'
         AND ${currentWorkSessionAuthorityExistsSql("s.id")}`,
    ).get(
      effect.signalId,
      effect.workId,
      effect.targetSessionId,
      effect.mode,
      effect.accountGeneration,
      frozen.profile_id,
      frozen.provider,
      frozen.provider_account_id,
      frozen.binding_generation,
      frozen.process_generation,
      frozen.session_authority_revision,
    ) as {
      present: number;
    } | null;
    return authority !== null;
  }

  #recordNestedEffectSettlement(
    effect: PreparedEffectRow,
    instruction: WorkPreparedEffect,
    outcome: "accepted" | "failed",
    receipt?: WorkNestedEffectReceipt,
  ): void {
    const receiptJson = receipt === undefined ? null : canonicalWorkJson(receipt);
    const receiptDigest = digestJson({ outcome, receipt: receipt ?? null });
    const existing = this.#database.query(
      `SELECT nested_mutation_key,outcome,receipt_json,receipt_digest
       FROM work_nested_effect_settlements WHERE effect_idempotency_key=?`,
    ).get(effect.idempotency_key) as {
      nested_mutation_key: string;
      outcome: "accepted" | "failed";
      receipt_json: string | null;
      receipt_digest: string;
    } | null;
    if (existing !== null) {
      if (
        existing.nested_mutation_key !== instruction.nestedMutationKey
        || existing.outcome !== outcome
        || existing.receipt_json !== receiptJson
        || existing.receipt_digest !== receiptDigest
      ) throw new WorkStoreError("IDEMPOTENCY_CONFLICT");
      return;
    }
    this.#database.query(
      `INSERT INTO work_nested_effect_settlements(
         effect_idempotency_key,nested_mutation_key,outcome,receipt_json,receipt_digest,created_at
       ) VALUES (?,?,?,?,?,?)`,
    ).run(
      effect.idempotency_key,
      instruction.nestedMutationKey,
      outcome,
      receiptJson,
      receiptDigest,
      this.#tick(),
    );
  }

  #settleAuthorizedDispatch(
    effect: PreparedEffectRow,
    outcome: WorkDispatchOutcome,
  ): WorkPreparedEffectStatus {
    const attempt = this.#requireAttempt(effect.subject_id, effect.work_id);
    const work = this.#requireWork(effect.work_id);
    const now = this.#tick();
    if (outcome.kind === "accepted") {
      const task = this.#requireTask(attempt.task_id, effect.work_id);
      const mayResume = work.state === "active"
        && attempt.lease_expires_at > now
        && (task.task.deadline === null || task.task.deadline > now)
        && this.#attemptAuthorityCurrent(attempt);
      if (
        (attempt.state === "dispatching" || attempt.state === "recovery_required")
        && mayResume
      ) {
        this.#database.query(
          "UPDATE work_attempts SET state='running',revision=revision+1,updated_at=? WHERE id=?",
        ).run(now, attempt.id);
        this.#database.query(
          "UPDATE work_task_states SET state='running',revision=revision+1,updated_at=? WHERE task_id=?",
        ).run(now, attempt.task_id);
      } else if (attempt.state === "dispatching") {
        this.#database.query(
          `UPDATE work_attempts
           SET state='recovery_required',revision=revision+1,updated_at=? WHERE id=?`,
        ).run(now, attempt.id);
        this.#database.query(
          `UPDATE work_task_states
           SET state='recovery_required',revision=revision+1,updated_at=? WHERE task_id=?`,
        ).run(now, attempt.task_id);
      }
    } else if (outcome.kind === "unknown") {
      if (attempt.state === "dispatching" || attempt.state === "running") {
        this.#database.query(
          `UPDATE work_attempts
           SET state='recovery_required',revision=revision+1,updated_at=? WHERE id=?`,
        ).run(now, attempt.id);
        this.#database.query(
          `UPDATE work_task_states
           SET state='recovery_required',revision=revision+1,updated_at=? WHERE task_id=?`,
        ).run(now, attempt.task_id);
      }
    } else if (attempt.state === "dispatching" || attempt.state === "recovery_required") {
      this.#database.query(
        `UPDATE work_attempts
         SET state='failed',revision=revision+1,updated_at=?,terminal_at=? WHERE id=?`,
      ).run(now, now, attempt.id);
      const task = this.#requireTask(attempt.task_id, effect.work_id);
      const taskState = work.state === "cancel_pending"
        ? "cancelled"
        : work.state === "fail_pending"
          ? "failed"
          : task.state.attempt_count < task.task.max_attempts ? "pending" : "failed";
      this.#database.query(
        `UPDATE work_task_states
         SET state=?,revision=revision+1,accepted_submission_id=NULL,updated_at=? WHERE task_id=?`,
      ).run(taskState, now, attempt.task_id);
    }
    const outcomeJson = canonicalWorkJson(outcome);
    this.#database.query(
      `UPDATE work_prepared_effects
       SET state=?,outcome_digest=?,outcome_json=?,finalized_at=?
       WHERE idempotency_key=? AND state IN ('prepared','effect_started','unknown')`,
    ).run(outcome.kind, digestText(outcomeJson), outcomeJson, now, effect.idempotency_key);
    const body = {
      type: "attempt.dispatch_finalized" as const,
      attemptId: attempt.id,
      outcome: outcome.kind,
    };
    this.#appendEvent(effect.work_id, body.type, attempt.worker_session_id, body);
    this.#tryFinalizePendingWork(effect.work_id);
    const settled = this.#database.query(
      "SELECT * FROM work_prepared_effects WHERE idempotency_key=?",
    ).get(effect.idempotency_key) as PreparedEffectRow;
    return this.#effectStatusFromRow(settled);
  }

  #settleAuthorizedSignal(
    effect: PreparedEffectRow,
    outcome: WorkSignalOutcome,
  ): WorkPreparedEffectStatus {
    const signal = this.#database.query(
      "SELECT to_session_id FROM work_signals WHERE id=? AND work_id=?",
    ).get(effect.subject_id, effect.work_id) as { to_session_id: string } | null;
    if (signal === null) throw new WorkStoreError("SIGNAL_NOT_FOUND");
    const now = this.#tick();
    const outcomeJson = canonicalWorkJson(outcome);
    this.#database.query(
      `UPDATE work_prepared_effects
       SET state=?,outcome_digest=?,outcome_json=?,finalized_at=?
       WHERE idempotency_key=? AND state IN ('prepared','effect_started','unknown')`,
    ).run(outcome.kind, digestText(outcomeJson), outcomeJson, now, effect.idempotency_key);
    this.#database.query(
      `INSERT INTO work_signal_receipts(
         signal_id,sequence,kind,actor_session_id,detail_code,recorded_at
       ) VALUES (?,?,?,?,?,?)`,
    ).run(
      effect.subject_id,
      this.#nextReceiptSequence(effect.subject_id),
      outcome.kind,
      signal.to_session_id,
      outcome.kind === "failed" || outcome.kind === "unknown" ? outcome.code : null,
      now,
    );
    const body = {
      type: "signal.delivery_updated" as const,
      signalId: effect.subject_id,
      outcome: outcome.kind,
    };
    this.#appendEvent(effect.work_id, body.type, signal.to_session_id, body);
    this.#tryFinalizePendingWork(effect.work_id);
    const settled = this.#database.query(
      "SELECT * FROM work_prepared_effects WHERE idempotency_key=?",
    ).get(effect.idempotency_key) as PreparedEffectRow;
    return this.#effectStatusFromRow(settled);
  }

  #authorizeOrReprojectPreparedEffect(
    idempotencyKey: string,
    allowExecute: boolean,
  ): WorkPreparedEffectAuthorization {
    if (!isUuidV7(idempotencyKey)) throw new WorkStoreError("BAD_IDEMPOTENCY_KEY");
    const authorize = this.#database.transaction((): WorkPreparedEffectAuthorization => {
      const effect = this.#database.query(
        "SELECT * FROM work_prepared_effects WHERE idempotency_key=?",
      ).get(idempotencyKey) as PreparedEffectRow | null;
      if (effect === null) throw new WorkStoreError("ATTEMPT_NOT_FOUND");
      const instruction = workPreparedEffectSchema.parse(parseStoredJson(effect.instruction_json));
      if (
        digestText(effect.instruction_json) !== effect.instruction_digest
        || instruction.workId !== effect.work_id
        || (instruction.kind === "dispatch" ? instruction.attemptId : instruction.signalId)
          !== effect.subject_id
      ) throw new Error("WORK_EFFECT_INSTRUCTION_CORRUPT");
      this.#assertLegacyPreparedInstruction(effect, instruction);
      if (effect.state === "accepted" || effect.state === "failed") {
        return {
          executable: false,
          disposition: "settled",
          status: this.#effectStatusFromRow(effect),
        };
      }
      const nested = this.#nestedMutation(instruction);
      if (nested.state === "accepted") {
        this.#recordNestedEffectSettlement(effect, instruction, "accepted", nested.receipt);
        const status = instruction.kind === "dispatch"
          ? this.#settleAuthorizedDispatch(
            effect,
            { kind: "accepted", receipt: nested.receipt },
          )
          : this.#settleAuthorizedSignal(
            effect,
            { kind: "accepted", receipt: nested.receipt },
          );
        return { executable: false, disposition: "settled", status };
      }
      if (nested.state === "unknown") {
        if (effect.state === "unknown") {
          return {
            executable: false,
            disposition: "settled",
            status: this.#effectStatusFromRow(effect),
          };
        }
        const status = instruction.kind === "dispatch"
          ? this.#settleAuthorizedDispatch(
            effect,
            { kind: "unknown", code: "nested_effect_unknown" },
          )
          : this.#settleAuthorizedSignal(
            effect,
            { kind: "unknown", code: "nested_effect_unknown" },
          );
        return { executable: false, disposition: "settled", status };
      }
      if (nested.state === "failed") {
        this.#recordNestedEffectSettlement(effect, instruction, "failed");
        const status = instruction.kind === "dispatch"
          ? this.#settleAuthorizedDispatch(
            effect,
            { kind: "failed", code: "nested_effect_failed" },
          )
          : this.#settleAuthorizedSignal(
            effect,
            { kind: "failed", code: "nested_effect_failed" },
          );
        return { executable: false, disposition: "settled", status };
      }
      if (effect.state === "unknown") {
        return {
          executable: false,
          disposition: "settled",
          status: this.#effectStatusFromRow(effect),
        };
      }
      if (effect.state === "effect_started") {
        this.#cancelNestedPrepared(instruction);
        const status = instruction.kind === "dispatch"
          ? this.#settleAuthorizedDispatch(
            effect,
            { kind: "failed", code: "nested_effect_not_started" },
          )
          : this.#settleAuthorizedSignal(
            effect,
            { kind: "failed", code: "nested_effect_not_started" },
          );
        return { executable: false, disposition: "settled", status };
      }
      if (!allowExecute) {
        return {
          executable: false,
          disposition: "settled",
          status: this.#effectStatusFromRow(effect),
        };
      }
      const now = this.#projectionTime();
      const valid = instruction.kind === "dispatch"
        ? this.#dispatchAuthorityValid(instruction, now)
        : this.#signalAuthorityValid(instruction);
      if (!valid) {
        this.#cancelNestedPrepared(instruction);
        const status = instruction.kind === "dispatch"
          ? this.#settleAuthorizedDispatch(
            effect,
            { kind: "failed", code: "authority_expired_no_effect" },
          )
          : this.#settleAuthorizedSignal(
            effect,
            { kind: "failed", code: "authority_expired_no_effect" },
          );
        return { executable: false, disposition: "settled", status };
      }
      const started = this.#database.query(
        `UPDATE work_prepared_effects SET state='effect_started'
         WHERE idempotency_key=? AND state='prepared'`,
      ).run(idempotencyKey);
      if (started.changes !== 1) throw new WorkStoreError("IDEMPOTENCY_CONFLICT");
      const startBody = instruction.kind === "dispatch"
        ? { type: "attempt.dispatch_started" as const, attemptId: instruction.attemptId }
        : { type: "signal.delivery_started" as const, signalId: instruction.signalId };
      this.#appendEvent(
        effect.work_id,
        startBody.type,
        instruction.targetSessionId,
        startBody,
      );
      const startedEffect = this.#database.query(
        "SELECT * FROM work_prepared_effects WHERE idempotency_key=?",
      ).get(idempotencyKey) as PreparedEffectRow;
      return {
        executable: true,
        disposition: "execute",
        status: this.#effectStatusFromRow(startedEffect),
        effect: instruction,
      };
    });
    return authorize.immediate();
  }

  authorizePreparedEffect(idempotencyKey: string): WorkPreparedEffectAuthorization {
    return this.#authorizeOrReprojectPreparedEffect(idempotencyKey, true);
  }

  reprojectPreparedEffect(idempotencyKey: string): WorkPreparedEffectStatus {
    return this.#authorizeOrReprojectPreparedEffect(idempotencyKey, false).status;
  }

  settlePreparedEffectNoEffect(
    idempotencyKey: string,
    code: string,
  ): WorkPreparedEffectStatus {
    if (!isUuidV7(idempotencyKey)) throw new WorkStoreError("BAD_IDEMPOTENCY_KEY");
    const failureCode = assertOutcomeCode(code);
    const settle = this.#database.transaction((): WorkPreparedEffectStatus => {
      const effect = this.#database.query(
        "SELECT * FROM work_prepared_effects WHERE idempotency_key=?",
      ).get(idempotencyKey) as PreparedEffectRow | null;
      if (effect === null) throw new WorkStoreError("ATTEMPT_NOT_FOUND");
      const instruction = workPreparedEffectSchema.parse(parseStoredJson(effect.instruction_json));
      if (
        digestText(effect.instruction_json) !== effect.instruction_digest
        || instruction.workId !== effect.work_id
        || (instruction.kind === "dispatch" ? instruction.attemptId : instruction.signalId)
          !== effect.subject_id
      ) throw new Error("WORK_EFFECT_INSTRUCTION_CORRUPT");
      this.#assertLegacyPreparedInstruction(effect, instruction);
      const outcome = { kind: "failed" as const, code: failureCode };
      const outcomeDigest = digestText(canonicalWorkJson(outcome));
      if (effect.state === "failed" && effect.outcome_digest === outcomeDigest) {
        return this.#effectStatusFromRow(effect);
      }
      if (effect.state !== "prepared") throw new WorkStoreError("ATTEMPT_RECOVERY_REQUIRED");
      const nested = this.#nestedMutation(instruction);
      if (nested.state === "accepted" || nested.state === "unknown") {
        throw new WorkStoreError("ATTEMPT_RECOVERY_REQUIRED");
      }
      this.#cancelNestedPrepared(instruction);
      return instruction.kind === "dispatch"
        ? this.#settleAuthorizedDispatch(effect, outcome)
        : this.#settleAuthorizedSignal(effect, outcome);
    });
    return settle.immediate();
  }

  #tick(): number {
    const observed = this.#now();
    if (!Number.isSafeInteger(observed) || observed < 0) throw new Error("WORK_CLOCK_INVALID");
    const row = this.#database.query(
      `UPDATE work_clock
       SET logical_time=MAX(logical_time,?)
       WHERE singleton=1
       RETURNING logical_time`,
    ).get(observed) as { logical_time?: unknown } | null;
    if (!Number.isSafeInteger(row?.logical_time) || (row?.logical_time as number) < 0) {
      throw new Error("WORK_CLOCK_CORRUPT");
    }
    return row?.logical_time as number;
  }

  #releaseTombstoneBytes(row: Omit<ReleaseTombstoneRow, "result_json"> & {
    result_json: string;
  }): number {
    let total = 0;
    for (const value of Object.values(row)) {
      total += Buffer.byteLength(String(value), "utf8");
    }
    return total;
  }

  #pruneReleaseTombstones(
    now: number,
    incomingRows = 0,
    incomingBytes = 0,
  ): void {
    this.#database.query(
      "DELETE FROM work_release_tombstones WHERE retention_upper_bound_at<=?",
    ).run(now);
    for (;;) {
      const retained = this.#database.query(
        `SELECT COUNT(*) AS count,COALESCE(SUM(
           length(CAST(work_id AS BLOB))
           + length(CAST(release_idempotency_key AS BLOB))
           + length(CAST(release_request_digest AS BLOB))
           + length(CAST(client_ref_digest AS BLOB))
           + length(CAST(coordinator_session_id AS BLOB))
           + length(CAST(terminal_kind AS BLOB))
           + length(CAST(terminal_request_digest AS BLOB))
           + length(CAST(final_revision AS BLOB))
           + length(CAST(final_head_hash AS BLOB))
           + length(CAST(discarded_counts_json AS BLOB))
           + length(CAST(discarded_records_digest AS BLOB))
           + length(CAST(released_at AS BLOB))
           + length(CAST(retention_upper_bound_at AS BLOB))
           + length(CAST(result_json AS BLOB))
         ),0) AS bytes FROM work_release_tombstones`,
      ).get() as { count: number; bytes: number } | null;
      if (
        (retained?.count ?? 0) + incomingRows <= WORK_TOMBSTONE_LIMIT
        && (retained?.bytes ?? 0) + incomingBytes <= WORK_TOMBSTONE_MAX_BYTES
      ) return;
      const oldest = this.#database.query(
        `SELECT work_id FROM work_release_tombstones
         ORDER BY released_at,work_id LIMIT 1`,
      ).get() as { work_id: string } | null;
      if (oldest === null) {
        if (incomingBytes > WORK_TOMBSTONE_MAX_BYTES) {
          throw new WorkStoreError("WORK_CAPACITY_EXCEEDED");
        }
        return;
      }
      this.#database.query("DELETE FROM work_release_tombstones WHERE work_id=?")
        .run(oldest.work_id);
    }
  }

  #liveReleaseTombstoneByKey(idempotencyKey: string, now: number): ReleaseTombstoneRow | null {
    return this.#database.query(
      `SELECT * FROM work_release_tombstones
       WHERE release_idempotency_key=? AND retention_upper_bound_at>?`,
    ).get(idempotencyKey, now) as ReleaseTombstoneRow | null;
  }

  #replayReleaseTombstone(
    operation: WorkOperation,
    requestDigest: string,
  ): WorkApplyResult | null {
    const row = this.#liveReleaseTombstoneByKey(operation.idempotencyKey, this.#projectionTime());
    if (row === null) return null;
    if (operation.kind !== "work.release" || row.release_request_digest !== requestDigest) {
      throw new WorkStoreError("IDEMPOTENCY_CONFLICT");
    }
    return workOperationResultSchema.parse(parseStoredJson(row.result_json));
  }

  #assertOperationNotReleased(operation: WorkOperation): void {
    const now = this.#projectionTime();
    const row = operation.kind === "work.create"
      ? this.#database.query(
        `SELECT 1 AS present FROM work_release_tombstones
         WHERE client_ref_digest=? AND retention_upper_bound_at>?`,
      ).get(digestJson(operation.clientRef), now)
      : this.#database.query(
        `SELECT 1 AS present FROM work_release_tombstones
         WHERE work_id=? AND retention_upper_bound_at>?`,
      ).get(operation.workId, now);
    if (row !== null) throw new WorkStoreError("WORK_RELEASED");
  }

  #requireWork(workId: string): WorkRow {
    const row = this.#database.query("SELECT * FROM works WHERE id=?").get(workId) as WorkRow | null;
    if (row === null) {
      const released = this.#database.query(
        `SELECT 1 AS present FROM work_release_tombstones
         WHERE work_id=? AND retention_upper_bound_at>?`,
      ).get(workId, this.#projectionTime());
      if (released !== null) throw new WorkStoreError("WORK_RELEASED");
      throw new WorkStoreError("WORK_NOT_FOUND");
    }
    return row;
  }

  #requireActiveWork(workId: string): WorkRow {
    const work = this.#requireWork(workId);
    if (work.state !== "active") throw new WorkStoreError("WORK_NOT_ACTIVE");
    return work;
  }

  #assertRevision(workId: string, expectedRevision: number): WorkRow {
    const work = this.#requireWork(workId);
    if (work.revision !== expectedRevision) throw new WorkStoreError("REVISION_CONFLICT");
    return work;
  }

  #requireTask(taskId: string, workId?: string): { task: TaskRow; state: TaskStateRow } {
    const row = this.#database.query(
      `SELECT t.*,s.state AS state,s.revision AS revision,s.next_fence AS next_fence,
              s.attempt_count AS attempt_count,s.accepted_submission_id AS accepted_submission_id,
              s.retry_not_before AS retry_not_before,
              s.updated_at AS updated_at
       FROM work_tasks AS t
       JOIN work_task_states AS s ON s.task_id=t.id
       WHERE t.id=?`,
    ).get(taskId) as (TaskRow & TaskStateRow) | null;
    if (row === null || (workId !== undefined && row.work_id !== workId)) {
      throw new WorkStoreError("TASK_NOT_FOUND");
    }
    this.#assertCanonicalTask(row);
    const task: TaskRow = {
      id: row.id,
      work_id: row.work_id,
      client_ref: row.client_ref,
      ordinal: row.ordinal,
      parent_task_id: row.parent_task_id,
      depth: row.depth,
      objective: row.objective,
      instructions: row.instructions,
      criteria_json: row.criteria_json,
      account_id: row.account_id,
      project_id: row.project_id,
      preset: row.preset,
      canonical_profile_key: row.canonical_profile_key,
      fast: row.fast,
      priority: row.priority,
      not_before: row.not_before,
      claim_by: row.claim_by,
      deadline: row.deadline,
      max_attempts: row.max_attempts,
      required_reviews: row.required_reviews,
      result_kind: row.result_kind,
      min_evidence: row.min_evidence,
      created_at: row.created_at,
    };
    const state: TaskStateRow = {
      task_id: row.id,
      work_id: row.work_id,
      state: row.state,
      revision: row.revision,
      next_fence: row.next_fence,
      attempt_count: row.attempt_count,
      accepted_submission_id: row.accepted_submission_id,
      retry_not_before: row.retry_not_before,
      updated_at: row.updated_at,
    };
    return { task, state };
  }

  #requireAttempt(attemptId: string, workId: string): AttemptRow {
    const row = this.#database.query(
      "SELECT * FROM work_attempts WHERE id=? AND work_id=?",
    ).get(attemptId, workId) as AttemptRow | null;
    if (row === null) throw new WorkStoreError("ATTEMPT_NOT_FOUND");
    this.#assertCanonicalAttempt(row);
    return row;
  }

  #requireMember(workId: string, sessionId: string): void {
    const row = this.#database.query(
      "SELECT 1 AS present FROM work_members WHERE work_id=? AND session_id=?",
    ).get(workId, sessionId) as { present: number } | null;
    if (row === null) throw new WorkStoreError("MEMBER_NOT_FOUND");
  }

  #sessionAccountAuthorityCurrent(
    sessionId: string,
    expectedGeneration?: number,
  ): boolean {
    this.#canonicalSessionKey(sessionId);
    const authority = this.#database.query(
      `SELECT 1 AS present
       WHERE ${currentWorkSessionAuthorityExistsSql(
         "?",
         "? IS NULL OR authority_profile.process_generation=?",
       )}`,
    ).get(
      sessionId,
      expectedGeneration ?? null,
      expectedGeneration ?? null,
    ) as { present: number } | null;
    return authority !== null;
  }

  #requireSessionAccountAuthority(
    sessionId: string,
    code: WorkStoreErrorCode,
    expectedGeneration?: number,
  ): void {
    if (!this.#sessionAccountAuthorityCurrent(sessionId, expectedGeneration)) {
      throw new WorkStoreError(code);
    }
  }

  #assertCoordinator(workId: string, coordinatorSessionId: string): WorkRow {
    const work = this.#requireWork(workId);
    if (
      work.coordinator_session_id !== coordinatorSessionId
      || !this.#sessionAccountAuthorityCurrent(coordinatorSessionId)
    ) {
      throw new WorkStoreError("ATTEMPT_NOT_OWNER");
    }
    return work;
  }

  #routes(workId: string): WorkSnapshot["routes"] {
    return this.#database.query(
      `SELECT work_id,account_id,project_id,preset,fast,canonical_profile_key FROM work_routes
       WHERE work_id=? ORDER BY ordinal`,
    ).all(workId).map((row) => {
      this.#assertCanonicalRoute(row);
      const route = row as {
        account_id: string;
        project_id: string;
        preset: "low" | "high" | "ultra";
        fast: 0 | 1;
      };
      return {
        accountId: route.account_id,
        projectId: route.project_id,
        preset: route.preset,
        fast: route.fast === 1,
      };
    });
  }

  #evidenceAuthorityFingerprint(
    workId: string,
    evidence: readonly WorkEvidence[],
    taskId?: string,
  ): string {
    const taskProjectId = taskId === undefined
      ? null
      : (this.#database.query(
        "SELECT project_id FROM work_tasks WHERE id=? AND work_id=?",
      ).get(taskId, workId) as { project_id: string } | null)?.project_id;
    if (taskId !== undefined && taskProjectId === undefined) {
      throw new WorkStoreError("ROUTE_MISMATCH");
    }
    if (taskId !== undefined) this.#canonicalTaskIdentity(taskId, workId);
    const bindings = evidence.map((item) => {
      if (item.kind === "session" || item.kind === "turn") {
        this.#requireMember(workId, item.sessionId);
        if (item.kind === "turn") {
          const event = this.#database.query(
            `SELECT 1 AS present FROM session_events
             WHERE session_id=? AND json_extract(event_json,'$.body.turnId')=? LIMIT 1`,
          ).get(item.sessionId, item.turnId) as { present: number } | null;
          if (event === null) throw new WorkStoreError("EVIDENCE_INVALID");
        }
        return item;
      }
      if (taskProjectId !== null && item.projectId !== taskProjectId) {
        throw new WorkStoreError("ROUTE_MISMATCH");
      }
      if (taskProjectId === null) {
        const route = this.#database.query(
          `SELECT * FROM work_routes
           WHERE work_id=? AND project_id=? LIMIT 1`,
        ).get(workId, item.projectId);
        if (route === null) throw new WorkStoreError("ROUTE_MISMATCH");
        this.#assertCanonicalRoute(route);
      }
      const project = this.#database.query(
        "SELECT root_path FROM projects WHERE id=?",
      ).get(item.projectId) as { root_path: string } | null;
      if (project === null) throw new WorkStoreError("ROUTE_MISMATCH");
      return { ...item, projectRoot: project.root_path };
    });
    return digestJson({ workId, taskId: taskId ?? null, bindings });
  }

  #preverifyOperationEvidence(operation: WorkOperation): void {
    let evidence: readonly WorkEvidence[];
    let taskId: string | undefined;
    switch (operation.kind) {
      case "attempt.report": {
        evidence = operation.report.evidence;
        taskId = (this.#database.query(
          "SELECT task_id FROM work_attempts WHERE id=? AND work_id=?",
        ).get(operation.attemptId, operation.workId) as { task_id: string } | null)?.task_id;
        break;
      }
      case "submission.review": {
        evidence = operation.review.evidence;
        taskId = (this.#database.query(
          "SELECT task_id FROM work_submissions WHERE id=? AND work_id=?",
        ).get(operation.submissionId, operation.workId) as { task_id: string } | null)?.task_id;
        break;
      }
      case "attempt.reconcile": {
        evidence = operation.outcome.evidence;
        taskId = (this.#database.query(
          "SELECT task_id FROM work_attempts WHERE id=? AND work_id=?",
        ).get(operation.attemptId, operation.workId) as { task_id: string } | null)?.task_id;
        break;
      }
      case "work.complete":
      case "work.fail":
      case "work.cancel":
        evidence = operation.evidence;
        break;
      case "work.create":
      case "work.release":
      case "task.addBatch":
      case "work.join":
      case "task.claim":
      case "task.claimNext":
      case "task.claimBatch":
      case "attempt.renew":
      case "attempt.release":
      case "attempt.dispatch":
      case "signal.send":
      case "signal.ack":
        return;
    }
    if (
      taskId === undefined
      && (
        operation.kind === "attempt.report"
        || operation.kind === "submission.review"
        || operation.kind === "attempt.reconcile"
      )
    ) {
      return;
    }
    if (taskId !== undefined) {
      if (operation.kind === "attempt.report" || operation.kind === "attempt.reconcile") {
        this.#canonicalAttemptIdentity(operation.attemptId, operation.workId, taskId);
      } else if (operation.kind === "submission.review") {
        this.#canonicalSubmissionIdentity(operation.submissionId, operation.workId, taskId);
      }
    }
    const before = this.#evidenceAuthorityFingerprint(operation.workId, evidence, taskId);
    try {
      verifyWorkEvidence(this.#database, operation.workId, evidence, taskId);
    } catch (error: unknown) {
      if (error instanceof WorkEvidenceVerificationError) {
        throw new WorkStoreError(error.code);
      }
      throw error;
    }
    const after = this.#evidenceAuthorityFingerprint(operation.workId, evidence, taskId);
    if (before !== after) throw new WorkStoreError("REVISION_CONFLICT");
    this.#verifiedEvidence.set(operation.idempotencyKey, {
      taskId: taskId ?? null,
      evidenceDigest: digestJson(evidence),
      authorityFingerprint: after,
    });
  }

  #assertEvidenceAuthority(
    idempotencyKey: string,
    workId: string,
    evidence: readonly WorkEvidence[],
    taskId?: string,
  ): void {
    const intent = this.#verifiedEvidence.get(idempotencyKey);
    if (
      intent === undefined
      || intent.taskId !== (taskId ?? null)
      || intent.evidenceDigest !== digestJson(evidence)
    ) throw new WorkStoreError("EVIDENCE_INVALID");
    if (intent.authorityFingerprint !== this.#evidenceAuthorityFingerprint(workId, evidence, taskId)) {
      throw new WorkStoreError("REVISION_CONFLICT");
    }
  }

  #assertEventCapacity(workId: string, additional: number): void {
    const work = this.#requireWork(workId);
    const prepared = this.#database.query(
      `SELECT COALESCE(SUM(
         CASE state WHEN 'prepared' THEN 2 WHEN 'effect_started' THEN 1 ELSE 0 END
       ),0) AS count FROM work_prepared_effects WHERE work_id=?`,
    ).get(workId) as { count: number } | null;
    const eventCount = work.next_sequence - 1;
    const preparedCount = prepared?.count ?? 0;
    if (eventCount + preparedCount + additional > WORK_HISTORY_EVENT_LIMIT) {
      throw new WorkStoreError("WORK_CAPACITY_EXCEEDED");
    }
  }

  #assertGeneralEventCapacity(workId: string, additional: number): void {
    const work = this.#requireWork(workId);
    const prepared = this.#database.query(
      `SELECT COALESCE(SUM(
         CASE state WHEN 'prepared' THEN 2 WHEN 'effect_started' THEN 1 ELSE 0 END
       ),0) AS count FROM work_prepared_effects WHERE work_id=?`,
    ).get(workId) as { count: number } | null;
    if (
      work.next_sequence - 1
      + (prepared?.count ?? 0)
      + additional
      > WORK_HISTORY_EVENT_LIMIT - WORK_HISTORY_RECOVERY_RESERVE
    ) throw new WorkStoreError("WORK_CAPACITY_EXCEEDED");
  }

  #assertIntentCapacity(workId: string, general: boolean): void {
    const row = this.#database.query(
      "SELECT COUNT(*) AS count FROM work_idempotency_intents WHERE work_id=?",
    ).get(workId) as { count: number } | null;
    const limit = general
      ? WORK_HISTORY_EVENT_LIMIT - WORK_HISTORY_RECOVERY_RESERVE
      : WORK_HISTORY_EVENT_LIMIT;
    if ((row?.count ?? 0) + 1 > limit) {
      throw new WorkStoreError("WORK_CAPACITY_EXCEEDED");
    }
  }

  #isRecoveryReserveOperation(operation: WorkOperation): boolean {
    if (["work.complete", "work.fail", "work.cancel", "work.release"].includes(operation.kind)) return true;
    return operation.kind === "attempt.reconcile" && operation.outcome.kind !== "still_unknown";
  }

  #generalEventCost(operation: WorkOperation): number {
    switch (operation.kind) {
      case "work.complete":
      case "work.fail":
      case "work.cancel":
      case "work.release":
        return 0;
      case "attempt.reconcile":
        return operation.outcome.kind === "still_unknown" ? 1 : 0;
      case "task.claimBatch":
        return operation.claims.length;
      case "attempt.dispatch":
      case "signal.send":
        return 3;
      case "work.join": {
        const joined = this.#database.query(
          "SELECT 1 AS present FROM work_members WHERE work_id=? AND session_id=?",
        ).get(operation.workId, operation.actorSessionId) as { present: number } | null;
        return joined === null ? 1 : 0;
      }
      case "work.create":
      case "task.addBatch":
      case "task.claim":
      case "attempt.renew":
      case "signal.ack":
        return 1;
      case "attempt.release":
      case "attempt.report":
      case "submission.review":
        // Retry terminalization can append task.failed after the primary
        // operation event. Reserve both slots before making any mutation.
        return 2;
      case "task.claimNext":
        return 0;
    }
  }

  #assertMemberCapacity(workId: string): void {
    const row = this.#database.query(
      "SELECT COUNT(*) AS count FROM work_members WHERE work_id=?",
    ).get(workId) as { count: number } | null;
    if ((row?.count ?? 0) >= WORK_MEMBER_LIMIT) {
      throw new WorkStoreError("WORK_CAPACITY_EXCEEDED");
    }
  }

  #taskHistoryVersionCandidate(
    kind: WorkTaskHistoryKind,
    stableKey: string,
    optional = false,
  ): WorkTaskHistoryVersionCandidate | null {
    const membership = this.#database.query(
      `SELECT ordinal,work_id,task_id FROM work_task_history_index
       WHERE kind=? AND stable_key=?`,
    ).get(kind, stableKey) as {
      ordinal: number;
      work_id: string;
      task_id: string;
    } | null;
    if (membership === null) {
      if (optional) return null;
      throw new Error("WORK_TASK_HISTORY_INDEX_CORRUPT");
    }
    this.#assertCanonicalHistorySource(membership.work_id, membership.task_id, kind, stableKey);
    const item: WorkTaskHistoryItem = (() => {
      switch (kind) {
        case "attempt": {
          const row = this.#database.query(
            "SELECT * FROM work_attempts WHERE id=? AND work_id=? AND task_id=?",
          ).get(stableKey, membership.work_id, membership.task_id) as AttemptRow | null;
          if (row === null) throw new Error("WORK_TASK_HISTORY_SOURCE_CORRUPT");
          return { kind, value: this.#attemptRecord(row) };
        }
        case "attempt_report": {
          const row = this.#database.query(
            `SELECT r.*,a.task_id AS task_id FROM work_attempt_reports AS r
             JOIN work_attempts AS a ON a.id=r.attempt_id
             WHERE r.idempotency_key=? AND r.work_id=? AND a.task_id=?`,
          ).get(stableKey, membership.work_id, membership.task_id) as AttemptReportRow | null;
          if (row === null) throw new Error("WORK_TASK_HISTORY_SOURCE_CORRUPT");
          return { kind, value: this.#attemptReportRecord(row) };
        }
        case "submission": {
          const row = this.#database.query(
            "SELECT * FROM work_submissions WHERE id=? AND work_id=? AND task_id=?",
          ).get(stableKey, membership.work_id, membership.task_id) as SubmissionRow | null;
          if (row === null) throw new Error("WORK_TASK_HISTORY_SOURCE_CORRUPT");
          return { kind, value: this.#submissionRecord(row) };
        }
        case "review": {
          const row = this.#database.query(
            `SELECT r.* FROM work_reviews AS r
             JOIN work_submissions AS s ON s.id=r.submission_id
             WHERE r.id=? AND r.work_id=? AND s.task_id=?`,
          ).get(stableKey, membership.work_id, membership.task_id) as ReviewRow | null;
          if (row === null) throw new Error("WORK_TASK_HISTORY_SOURCE_CORRUPT");
          return { kind, taskId: membership.task_id, value: this.#reviewRecord(row) };
        }
        case "signal": {
          const value = this.#signalRecord(stableKey);
          if (value.taskId !== membership.task_id) {
            throw new Error("WORK_TASK_HISTORY_SOURCE_CORRUPT");
          }
          return { kind, value };
        }
      }
    })();
    const parsed = workTaskHistoryItemSchema.parse(item);
    const recordJson = canonicalWorkJson(parsed);
    return {
      historyOrdinal: membership.ordinal,
      workId: membership.work_id,
      taskId: membership.task_id,
      recordJson,
      recordDigest: digestText(recordJson),
    };
  }

  #latestAttemptHistoryVersionCandidate(
    taskId: string,
  ): WorkTaskHistoryVersionCandidate | null {
    const latest = this.#database.query(
      "SELECT id FROM work_attempts WHERE task_id=? ORDER BY fence DESC,id DESC LIMIT 1",
    ).get(taskId) as { id: string } | null;
    return latest === null
      ? null
      : this.#taskHistoryVersionCandidate("attempt", latest.id);
  }

  #assertTaskHistoryVersionPageable(
    candidate: WorkTaskHistoryVersionCandidate,
  ): void {
    const item = workTaskHistoryItemSchema.parse(parseStoredJson(candidate.recordJson));
    const counts: WorkTaskHistoryCounts = {
      attempts: item.kind === "attempt"
        ? WORK_HISTORY_EVENT_LIMIT
        : WORK_OPERATION_BATCH_LIMIT,
      attemptReports: item.kind === "attempt_report"
        ? WORK_HISTORY_EVENT_LIMIT
        : item.kind === "attempt"
          ? WORK_OPERATION_BATCH_LIMIT
          : 0,
      submissions: item.kind === "submission" ? WORK_HISTORY_EVENT_LIMIT : 0,
      reviews: item.kind === "review" ? WORK_HISTORY_EVENT_LIMIT : 0,
      signals: item.kind === "signal" ? WORK_HISTORY_EVENT_LIMIT : 0,
    };
    const remainingCounts: WorkTaskHistoryCounts = {
      attempts: item.kind === "attempt" ? 1 : 0,
      attemptReports: item.kind === "attempt_report" ? 1 : 0,
      submissions: item.kind === "submission" ? 1 : 0,
      reviews: item.kind === "review" ? 1 : 0,
      signals: item.kind === "signal" ? 1 : 0,
    };
    const work = this.#requireWork(candidate.workId);
    const maximumCounter = Number.MAX_SAFE_INTEGER;
    const cursor = (offset: number): string => this.#encodeCursor({
      version: 1,
      type: "work_task_history",
      workId: candidate.workId,
      taskId: candidate.taskId,
      streamEpoch: work.stream_epoch,
      sequence: WORK_HISTORY_EVENT_LIMIT,
      projectionAt: maximumCounter,
      highWaterOrdinal: maximumCounter,
      taskRevision: maximumCounter,
      offset,
    });
    const offset = WORK_TASK_HISTORY_TOTAL_ITEM_LIMIT - 2;
    const page: WorkTaskHistoryPage = {
      version: 1,
      kind: "history",
      workId: candidate.workId,
      taskId: candidate.taskId,
      taskRevision: maximumCounter,
      projectionAt: maximumCounter,
      requestedCursor: cursor(offset),
      observedThroughCursor: this.#cursor(work, WORK_HISTORY_EVENT_LIMIT),
      offset,
      totalItems: WORK_TASK_HISTORY_TOTAL_ITEM_LIMIT,
      counts,
      items: [item],
      remainingItems: 1,
      remainingCounts,
      nextCursor: cursor(offset + 1),
    };
    if (workReadSuccessWireBytes("work.task", page) > WORK_TASK_HISTORY_PAGE_MAX_BYTES) {
      throw new WorkStoreError("WORK_CAPACITY_EXCEEDED");
    }
  }

  #appendTaskHistoryVersionsForEvent(
    workId: string,
    event: WorkEventBody,
    eventSequence: number,
    createdAt: number,
    affectedAttemptIds: readonly string[] = [],
  ): void {
    const candidates = new Map<number, WorkTaskHistoryVersionCandidate>();
    const add = (candidate: WorkTaskHistoryVersionCandidate | null): void => {
      if (candidate === null) return;
      if (candidate.workId !== workId) throw new Error("WORK_TASK_HISTORY_SOURCE_CORRUPT");
      candidates.set(candidate.historyOrdinal, candidate);
    };
    if ("attemptId" in event) {
      add(this.#taskHistoryVersionCandidate("attempt", event.attemptId));
    }
    if (event.type === "attempt.reported") {
      const report = this.#database.query(
        `SELECT i.stable_key FROM work_task_history_index AS i
         JOIN work_attempt_reports AS r ON r.idempotency_key=i.stable_key
         WHERE i.work_id=? AND i.kind='attempt_report'
           AND r.attempt_id=? AND r.report_digest=?
         ORDER BY i.ordinal DESC LIMIT 1`,
      ).get(workId, event.attemptId, event.reportDigest) as { stable_key: string } | null;
      if (report === null) throw new Error("WORK_TASK_HISTORY_INDEX_CORRUPT");
      add(this.#taskHistoryVersionCandidate("attempt_report", report.stable_key));
      if (event.submissionId !== null) {
        add(this.#taskHistoryVersionCandidate("submission", event.submissionId));
      }
    }
    if (event.type === "attempt.reconciled" && event.submissionId !== null) {
      add(this.#taskHistoryVersionCandidate("submission", event.submissionId));
    }
    if (event.type === "submission.reviewed") {
      add(this.#taskHistoryVersionCandidate("review", event.reviewId));
      add(this.#taskHistoryVersionCandidate("submission", event.submissionId));
      const affected = this.#database.query(
        "SELECT attempt_id FROM work_submissions WHERE id=? AND work_id=?",
      ).get(event.submissionId, workId) as { attempt_id: string } | null;
      if (affected === null) throw new Error("WORK_TASK_HISTORY_SOURCE_CORRUPT");
      add(this.#taskHistoryVersionCandidate("attempt", affected.attempt_id));
    }
    if ("signalId" in event) {
      add(this.#taskHistoryVersionCandidate("signal", event.signalId, true));
    }
    if (event.type === "task.failed" || event.type === "task.state_changed") {
      add(this.#latestAttemptHistoryVersionCandidate(event.taskId));
    }
    for (const attemptId of new Set(affectedAttemptIds)) {
      add(this.#taskHistoryVersionCandidate("attempt", attemptId));
    }
    const changed = [...candidates.values()].filter((candidate) => {
      const prior = this.#database.query(
        `SELECT record_digest FROM work_task_history_versions
         WHERE history_ordinal=? ORDER BY event_sequence DESC,ordinal DESC LIMIT 1`,
      ).get(candidate.historyOrdinal) as { record_digest: string } | null;
      return prior?.record_digest !== candidate.recordDigest;
    });
    for (const candidate of changed) {
      this.#assertTaskHistoryVersionPageable(candidate);
    }
    const capacity = this.#database.query(
      "SELECT COUNT(*) AS count FROM work_task_history_versions WHERE work_id=?",
    ).get(workId) as { count: number } | null;
    if ((capacity?.count ?? 0) + changed.length > WORK_TASK_HISTORY_VERSION_LIMIT) {
      throw new WorkStoreError("WORK_CAPACITY_EXCEEDED");
    }
    for (const candidate of changed) {
      this.#database.query(
        `INSERT INTO work_task_history_versions(
           history_ordinal,work_id,task_id,event_sequence,record_json,record_digest,created_at
         ) VALUES (?,?,?,?,?,?,?)`,
      ).run(
        candidate.historyOrdinal,
        candidate.workId,
        candidate.taskId,
        eventSequence,
        candidate.recordJson,
        candidate.recordDigest,
        createdAt,
      );
    }
  }

  #appendEvent(
    workId: string,
    kind: string,
    actorSessionId: string | undefined,
    payload: unknown,
    affectedAttemptIds: readonly string[] = [],
  ): WorkEventRecord {
    this.#assertEventCapacity(workId, 1);
    const work = this.#requireWork(workId);
    const sequence = work.next_sequence;
    const revision = work.revision + 1;
    const recordedAt = this.#tick();
    const eventBody = workEventBodySchema.parse(payload);
    workEventSchema.parse({
      version: 1,
      workId,
      streamEpoch: work.stream_epoch,
      sequence,
      occurredAt: recordedAt,
      actorSessionId: actorSessionId ?? null,
      body: eventBody,
    });
    this.#appendTaskHistoryVersionsForEvent(
      workId,
      eventBody,
      sequence,
      recordedAt,
      affectedAttemptIds,
    );
    const payloadJson = canonicalWorkJson(eventBody);
    const payloadDigest = digestText(payloadJson);
    const eventHash = digestJson({
      actorSessionId: actorSessionId ?? null,
      daemonGeneration: this.#daemonGeneration,
      kind,
      payloadDigest,
      previousHash: work.head_hash,
      recordedAt,
      revision,
      sequence,
      streamEpoch: work.stream_epoch,
      workId,
    });
    this.#database.query(
      `INSERT INTO work_events(
         work_id,sequence,revision,stream_epoch,kind,actor_session_id,payload_json,
         payload_digest,previous_hash,event_hash,daemon_generation,recorded_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      workId,
      sequence,
      revision,
      work.stream_epoch,
      kind,
      actorSessionId ?? null,
      payloadJson,
      payloadDigest,
      work.head_hash,
      eventHash,
      this.#daemonGeneration,
      recordedAt,
    );
    const changed = this.#database.query(
      `UPDATE works SET revision=?,next_sequence=?,head_hash=?,updated_at=?
       WHERE id=? AND revision=? AND next_sequence=?`,
    ).run(revision, sequence + 1, eventHash, recordedAt, workId, work.revision, sequence);
    if (changed.changes !== 1) throw new WorkStoreError("REVISION_CONFLICT");
    return mapEvent({
      work_id: workId,
      sequence,
      revision,
      stream_epoch: work.stream_epoch,
      kind,
      actor_session_id: actorSessionId ?? null,
      payload_json: payloadJson,
      payload_digest: payloadDigest,
      previous_hash: work.head_hash,
      event_hash: eventHash,
      daemon_generation: this.#daemonGeneration,
      recorded_at: recordedAt,
    });
  }

  #storeIntent(
    operation: WorkOperation,
    workId: string | null,
    requestDigest: string,
    result: WorkApplyResult,
  ): WorkApplyResult {
    if (workId !== null) this.#assertIntentCapacity(workId, false);
    const parsedResult = workOperationResultSchema.parse(result);
    const resultJson = canonicalWorkJson(parsedResult);
    const now = this.#tick();
    this.#database.query(
      `INSERT INTO work_idempotency_intents(
         idempotency_key,operation_kind,work_id,request_digest,result_json,created_at
       ) VALUES (?,?,?,?,?,?)`,
    ).run(operation.idempotencyKey, operation.kind, workId, requestDigest, resultJson, now);
    return workOperationResultSchema.parse(parseStoredJson(resultJson));
  }

  #projectionTime(): number {
    const observed = this.#now();
    if (!Number.isSafeInteger(observed) || observed < 0) throw new Error("WORK_CLOCK_INVALID");
    const clock = this.#database.query(
      "SELECT logical_time FROM work_clock WHERE singleton=1",
    ).get() as { logical_time: number } | null;
    if (!Number.isSafeInteger(clock?.logical_time) || (clock?.logical_time ?? -1) < 0) {
      throw new Error("WORK_CLOCK_CORRUPT");
    }
    return Math.max(observed, clock?.logical_time ?? 0);
  }

  #reprojectResult(stored: WorkApplyResult): WorkApplyResult {
    const now = this.#projectionTime();
    const workRevision = this.#requireWork(stored.workId).revision;
    const attempt = (attemptId: string, workId: string): WorkAttemptRecord =>
      this.#attemptRecord(this.#requireAttempt(attemptId, workId));
    const task = (taskId: string, workId: string): WorkTaskSummary => {
      const found = this.#requireTask(taskId, workId);
      return this.#taskSummary(found.task, found.state, now);
    };
    const submission = (submissionId: string, workId: string): WorkSubmissionRecord => {
      const row = this.#database.query(
        "SELECT * FROM work_submissions WHERE id=? AND work_id=?",
      ).get(submissionId, workId) as SubmissionRow | null;
      if (row === null) throw new WorkStoreError("NOT_REVIEWABLE");
      return this.#submissionRecord(row);
    };
    switch (stored.kind) {
      case "work.create":
        return workOperationResultSchema.parse({
          ...stored,
          workRevision,
          work: this.#workRecord(stored.work.id, now),
          routes: this.#routes(stored.work.id),
          tasks: stored.tasks.map((row) => task(row.id, stored.work.id)),
        });
      case "task.addBatch":
        return workOperationResultSchema.parse({
          ...stored,
          workRevision,
          tasks: stored.tasks.map((row) => task(row.id, stored.workId)),
        });
      case "work.join":
        return workOperationResultSchema.parse({
          ...stored,
          workRevision,
        });
      case "task.claim":
        return workOperationResultSchema.parse({
          ...stored,
          workRevision,
          task: task(stored.task.id, stored.workId),
          attempt: attempt(stored.attempt.id, stored.workId),
        });
      case "task.claimNext":
        return stored.task === null || stored.attempt === null
          ? workOperationResultSchema.parse({ ...stored, workRevision })
          : workOperationResultSchema.parse({
              ...stored,
              workRevision,
              task: task(stored.task.id, stored.workId),
              attempt: attempt(stored.attempt.id, stored.workId),
            });
      case "task.claimBatch":
        return workOperationResultSchema.parse({
          ...stored,
          workRevision,
          claims: stored.claims.map((claim) => ({
            ...claim,
            task: task(claim.task.id, stored.workId),
            attempt: attempt(claim.attempt.id, stored.workId),
          })),
        });
      case "attempt.renew":
      case "attempt.release":
        return workOperationResultSchema.parse({
          ...stored,
          workRevision,
          attempt: attempt(stored.attempt.id, stored.workId),
        });
      case "attempt.dispatch": {
        const effect = this.effectStatus(stored.effect.idempotencyKey);
        if (effect === null) throw new Error("WORK_EFFECT_MISSING");
        return workOperationResultSchema.parse({
          ...stored,
          workRevision,
          attempt: attempt(stored.attempt.id, stored.workId),
          effect,
        });
      }
      case "attempt.report":
      case "attempt.reconcile":
        return workOperationResultSchema.parse({
          ...stored,
          workRevision,
          attempt: attempt(stored.attempt.id, stored.workId),
          submission: stored.submission === null
            ? null
            : submission(stored.submission.id, stored.workId),
        });
      case "submission.review": {
        const review = this.#database.query(
          "SELECT * FROM work_reviews WHERE id=? AND work_id=?",
        ).get(stored.review.id, stored.workId) as ReviewRow | null;
        if (review === null) throw new WorkStoreError("NOT_REVIEWABLE");
        return workOperationResultSchema.parse({
          ...stored,
          workRevision,
          submission: submission(stored.submission.id, stored.workId),
          review: this.#reviewRecord(review),
        });
      }
      case "signal.send": {
        const effect = this.effectStatus(stored.effect.idempotencyKey);
        if (effect === null) throw new Error("WORK_EFFECT_MISSING");
        return workOperationResultSchema.parse({
          ...stored,
          workRevision,
          signal: this.#signalRecord(stored.signal.id),
          effect,
        });
      }
      case "signal.ack":
        return workOperationResultSchema.parse({
          ...stored,
          workRevision,
          signal: this.#signalRecord(stored.signal.id),
        });
      case "work.complete":
      case "work.fail":
      case "work.cancel":
        return workOperationResultSchema.parse({
          ...stored,
          workRevision,
          work: this.#workRecord(stored.work.id, now),
        });
      case "work.release":
        return stored;
    }
  }

  #replayIntent(operation: WorkOperation, requestDigest: string): WorkApplyResult | null {
    const row = this.#database.query(
      `SELECT operation_kind,request_digest,result_json
       FROM work_idempotency_intents WHERE idempotency_key=?`,
    ).get(operation.idempotencyKey) as {
      operation_kind: string;
      request_digest: string;
      result_json: string;
    } | null;
    if (row === null) return null;
    if (row.operation_kind !== operation.kind || row.request_digest !== requestDigest) {
      throw new WorkStoreError("IDEMPOTENCY_CONFLICT");
    }
    const stored = workOperationResultSchema.parse(parseStoredJson(row.result_json));
    return this.#reprojectResult(stored);
  }

  #prepareTaskAdmission(
    workId: string,
    specs: readonly WorkTaskSpec[],
  ): readonly Readonly<{
    id: string;
    spec: WorkTaskSpec;
    parentTaskId: string | null;
    dependencyTaskIds: readonly string[];
    depth: number;
    ordinal: number;
  }>[] {
    if (specs.length < 1 || specs.length > WORK_TASK_BATCH_LIMIT) {
      throw new WorkStoreError("TASK_LIMIT_EXCEEDED");
    }
    const existing = this.#database.query(
      "SELECT id,client_ref,depth,ordinal FROM work_tasks WHERE work_id=? ORDER BY ordinal,id",
    ).all(workId) as Array<{ id: string; client_ref: string; depth: number; ordinal: number }>;
    for (const task of existing) this.#canonicalTaskIdentity(task.id, workId);
    this.#routes(workId);
    if (existing.length + specs.length > WORK_TASK_TOTAL_LIMIT) {
      throw new WorkStoreError("TASK_LIMIT_EXCEEDED");
    }

    const existingById = new Map(existing.map((task) => [task.id, task]));
    const existingByRef = new Map(existing.map((task) => [task.client_ref, task]));
    const generated = specs.map((spec, index) => ({
      id: createWorkTaskId(),
      spec,
      ordinal: existing.length + index,
    }));
    const generatedById = new Map(generated.map((task) => [task.id, task]));
    const generatedByRef = new Map(generated.map((task) => [task.spec.clientRef, task]));
    if (generatedByRef.size !== generated.length) throw new WorkStoreError("DEPENDENCY_CYCLE");
    for (const task of generated) {
      if (existingByRef.has(task.spec.clientRef)) throw new WorkStoreError("TASK_LIMIT_EXCEEDED");
      const account = this.#database.query(
        "SELECT 1 AS present FROM profiles WHERE id=? AND state!='removed'",
      ).get(task.spec.route.accountId) as { present: number } | null;
      const project = this.#database.query(
        "SELECT 1 AS present FROM projects WHERE id=?",
      ).get(task.spec.route.projectId) as { present: number } | null;
      if (account === null || project === null) throw new WorkStoreError("ROUTE_MISMATCH");
      const declared = this.#database.query(
        `SELECT 1 AS present FROM work_routes
         WHERE work_id=? AND account_id=? AND project_id=? AND preset=? AND fast=?`,
      ).get(
        workId,
        task.spec.route.accountId,
        task.spec.route.projectId,
        task.spec.preset,
        task.spec.fast ? 1 : 0,
      ) as { present: number } | null;
      if (declared === null) throw new WorkStoreError("ROUTE_MISMATCH");
    }

    const resolveRef = (reference: string): string => {
      const local = generatedByRef.get(reference);
      if (local !== undefined) return local.id;
      const prior = existingByRef.get(reference);
      if (prior !== undefined) return prior.id;
      throw new WorkStoreError("UNKNOWN_DEPENDENCY");
    };
    const resolveId = (taskId: string): string => {
      if (generatedById.has(taskId) || existingById.has(taskId)) return taskId;
      throw new WorkStoreError("UNKNOWN_DEPENDENCY");
    };
    const edges = new Map<string, string[]>();
    const explicitDependencies = new Map<string, string[]>();
    const parents = new Map<string, string | null>();
    for (const task of generated) {
      let parentTaskId: string | null = null;
      if (task.spec.parentRef !== undefined) {
        try {
          parentTaskId = resolveRef(task.spec.parentRef);
        } catch (error) {
          if (error instanceof WorkStoreError && error.code === "UNKNOWN_DEPENDENCY") {
            throw new WorkStoreError("UNKNOWN_PARENT");
          }
          throw error;
        }
      } else if (task.spec.parentTaskId !== undefined) {
        try {
          parentTaskId = resolveId(task.spec.parentTaskId);
        } catch (error) {
          if (error instanceof WorkStoreError && error.code === "UNKNOWN_DEPENDENCY") {
            throw new WorkStoreError("UNKNOWN_PARENT");
          }
          throw error;
        }
      }
      const dependencyIds = [
        ...task.spec.dependsOnRefs.map(resolveRef),
        ...task.spec.dependsOnTaskIds.map(resolveId),
      ];
      const uniqueDependencies = [...new Set(dependencyIds)];
      if (uniqueDependencies.includes(task.id) || parentTaskId === task.id) {
        throw new WorkStoreError("DEPENDENCY_CYCLE");
      }
      explicitDependencies.set(task.id, uniqueDependencies);
      edges.set(task.id, [...new Set([
        ...(parentTaskId === null ? [] : [parentTaskId]),
        ...uniqueDependencies,
      ])]);
      parents.set(task.id, parentTaskId);
    }

    const visiting = new Set<string>();
    const depths = new Map(existing.map((task) => [task.id, task.depth]));
    const depthOf = (taskId: string): number => {
      const known = depths.get(taskId);
      if (known !== undefined) return known;
      if (visiting.has(taskId)) throw new WorkStoreError("DEPENDENCY_CYCLE");
      visiting.add(taskId);
      let depth = 1;
      for (const dependencyId of edges.get(taskId) ?? []) {
        depth = Math.max(depth, depthOf(dependencyId) + 1);
      }
      visiting.delete(taskId);
      if (depth > WORK_TASK_DEPTH_LIMIT) throw new WorkStoreError("TASK_DEPTH_EXCEEDED");
      depths.set(taskId, depth);
      return depth;
    };

    return generated.map((task) => {
      const parentTaskId = parents.get(task.id) ?? null;
      const dependencyTaskIds = explicitDependencies.get(task.id) ?? [];
      return {
        ...task,
        parentTaskId,
        dependencyTaskIds,
        depth: depthOf(task.id),
      };
    });
  }

  #insertTasks(
    workId: string,
    specs: readonly WorkTaskSpec[],
    createdAt: number,
  ): readonly string[] {
    const prepared = this.#prepareTaskAdmission(workId, specs);
    for (const task of prepared) {
      const spec = task.spec;
      this.#database.query(
        `INSERT INTO work_tasks(
           id,work_id,client_ref,ordinal,parent_task_id,depth,objective,instructions,
           criteria_json,account_id,project_id,preset,fast,priority,not_before,claim_by,deadline,
           max_attempts,required_reviews,result_kind,min_evidence,created_at,canonical_profile_key
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        task.id,
        workId,
        spec.clientRef,
        task.ordinal,
        task.parentTaskId,
        task.depth,
        spec.objective,
        spec.instructions,
        canonicalWorkJson(spec.criteria),
        spec.route.accountId,
        spec.route.projectId,
        spec.preset,
        spec.fast ? 1 : 0,
        spec.priority,
        spec.notBefore ?? null,
        spec.claimBy ?? null,
        spec.deadline ?? null,
        spec.maxAttempts,
        spec.requiredReviews,
        spec.resultKind,
        spec.minEvidence,
        createdAt,
        this.#canonicalWorkKey(workId, spec.preset),
      );
      this.#database.query(
        `INSERT INTO work_task_states(
           task_id,work_id,state,revision,next_fence,attempt_count,accepted_submission_id,
           retry_not_before,updated_at
         ) VALUES (?,?,'pending',1,1,0,NULL,NULL,?)`,
      ).run(task.id, workId, createdAt);
      for (const [ordinal, dependencyTaskId] of task.dependencyTaskIds.entries()) {
        this.#database.query(
          `INSERT INTO work_task_dependencies(
             work_id,task_id,dependency_task_id,ordinal,created_at
           ) VALUES (?,?,?,?,?)`,
        ).run(workId, task.id, dependencyTaskId, ordinal, createdAt);
      }
    }
    return prepared.map((task) => task.id);
  }

  #activeActorAttempt(workId: string, actorSessionId: string): AttemptRow | null {
    const attempt = this.#database.query(
      `SELECT * FROM work_attempts
       WHERE work_id=? AND worker_session_id=?
         AND state IN ('claimed','dispatching','running','submitted','recovery_required')
       ORDER BY created_at,id LIMIT 1`,
    ).get(workId, actorSessionId) as AttemptRow | null;
    if (attempt !== null) this.#assertCanonicalAttempt(attempt);
    return attempt;
  }

  #taskReady(task: TaskRow, state: TaskStateRow, now: number): boolean {
    this.#assertCanonicalTask(task);
    if (state.state !== "pending") return false;
    if (task.not_before !== null && task.not_before > now) return false;
    if (state.retry_not_before !== null && state.retry_not_before > now) return false;
    if (task.claim_by !== null && task.claim_by <= now) return false;
    if (task.deadline !== null && task.deadline <= now) return false;
    if (state.attempt_count >= task.max_attempts) return false;
    this.#assertCanonicalTaskReferences(task.id, task.work_id);
    const unmet = this.#database.query(
      `SELECT 1 AS present
       FROM work_task_dependencies AS d
       JOIN work_task_states AS s ON s.task_id=d.dependency_task_id
       WHERE d.work_id=? AND d.task_id=? AND s.state!='completed'
       LIMIT 1`,
    ).get(task.work_id, task.id) as { present: number } | null;
    return unmet === null;
  }

  #retryFailureReason(
    task: TaskRow,
    state: TaskStateRow,
    now: number,
  ): "claim_window_elapsed" | "completion_deadline_elapsed" | "attempts_exhausted" | null {
    if (task.deadline !== null && task.deadline <= now) return "completion_deadline_elapsed";
    if (task.claim_by !== null && task.claim_by <= now) return "claim_window_elapsed";
    if (state.attempt_count >= task.max_attempts) return "attempts_exhausted";
    return null;
  }

  #appendTaskFailure(
    workId: string,
    taskId: string,
    reason: "claim_window_elapsed" | "completion_deadline_elapsed" | "attempts_exhausted",
    actorSessionId?: string,
  ): void {
    const body = { type: "task.failed" as const, taskId, reason };
    this.#appendEvent(workId, body.type, actorSessionId, body);
  }

  #assertSessionRoute(task: TaskRow, actorSessionId: string): number {
    const taskKey = this.#assertCanonicalTask(task);
    const sessionKey = this.#canonicalSessionKey(actorSessionId);
    this.#requireMember(task.work_id, actorSessionId);
    if (sessionKey !== taskKey) throw new WorkStoreError("ROUTE_MISMATCH");
    const session = this.#database.query(
      `SELECT p.process_generation AS account_generation
       FROM sessions AS s
       JOIN profiles AS p ON p.id=s.profile_id
       JOIN works AS w ON w.id=?
       WHERE s.id=? AND s.profile_id=? AND s.project_id=? AND s.preset=? AND s.fast_enabled=?
         AND s.provider_v39='codex'
         AND (
           s.preset_contract=w.preset_contract
           OR s.preset='low'
         )
         AND NOT EXISTS (
           SELECT 1
           FROM mutation_attempts AS sm
           LEFT JOIN mutation_resolutions AS sr ON sr.attempt_id=sm.id
           WHERE sm.authority_id=s.id AND sm.kind='session.switch'
             AND sm.state IN ('effect_started','ambiguous')
             AND sr.attempt_id IS NULL
         )
         AND ${currentWorkSessionAuthorityExistsSql("s.id")}`,
    ).get(
      task.work_id,
      actorSessionId,
      task.account_id,
      task.project_id,
      task.preset,
      task.fast,
    ) as { account_generation: number } | null;
    if (session === null) throw new WorkStoreError("ROUTE_MISMATCH");
    if (!Number.isSafeInteger(session.account_generation) || session.account_generation < 0) {
      throw new WorkStoreError("ROUTE_MISMATCH");
    }
    return session.account_generation;
  }

  #attemptAuthorityCurrent(attempt: AttemptRow): boolean {
    this.#assertCanonicalAttempt(attempt);
    const authority = this.#database.query(
       `SELECT 1 AS present
       FROM sessions AS s
       JOIN work_members AS m ON m.work_id=? AND m.session_id=s.id
       JOIN works AS w ON w.id=m.work_id
       WHERE s.id=? AND s.profile_id=? AND s.project_id=? AND s.preset=? AND s.fast_enabled=?
         AND s.provider_v39='codex'
         AND (
           s.preset_contract=w.preset_contract
           OR s.preset='low'
         )
         AND ${currentWorkSessionAuthorityExistsSql(
           "s.id",
           "authority_profile.process_generation=?",
         )}`,
    ).get(
      attempt.work_id,
      attempt.worker_session_id,
      attempt.account_id,
      attempt.project_id,
      attempt.preset,
      attempt.fast,
      attempt.account_generation,
    ) as { present: number } | null;
    return authority !== null;
  }

  #retireAttemptAuthority(
    attempts: readonly AttemptRow[],
    expectedGeneration: number,
    claimedSummary: string,
  ): readonly string[] {
    for (const attempt of attempts) this.#assertCanonicalAttempt(attempt);
    const workIds = [...new Set(attempts.map((attempt) => attempt.work_id))].sort();
    const now = this.#tick();
    for (const attempt of attempts) {
      if (attempt.state === "claimed") {
        const task = this.#requireTask(attempt.task_id, attempt.work_id);
        const failureReason = this.#retryFailureReason(task.task, task.state, now);
        this.#database.query(
          `UPDATE work_attempts
           SET state='released',revision=revision+1,updated_at=?,terminal_at=?
           WHERE id=? AND state='claimed' AND account_generation=?`,
        ).run(now, now, attempt.id, expectedGeneration);
        this.#database.query(
          `UPDATE work_task_states
           SET state=?,revision=revision+1,retry_not_before=NULL,updated_at=?
           WHERE task_id=? AND state='claimed'`,
        ).run(failureReason === null ? "pending" : "failed", now, attempt.task_id);
        const released = {
          type: "attempt.released" as const,
          attemptId: attempt.id,
          summaryDigest: digestJson(claimedSummary),
        };
        this.#appendEvent(
          attempt.work_id,
          released.type,
          attempt.worker_session_id,
          released,
        );
        if (failureReason !== null) {
          this.#appendTaskFailure(
            attempt.work_id,
            attempt.task_id,
            failureReason,
            attempt.worker_session_id,
          );
        }
        continue;
      }
      this.#database.query(
        `UPDATE work_attempts
         SET state='recovery_required',revision=revision+1,updated_at=?
         WHERE id=? AND state=? AND account_generation=?`,
      ).run(now, attempt.id, attempt.state, expectedGeneration);
      this.#database.query(
        `UPDATE work_task_states
         SET state='recovery_required',revision=revision+1,updated_at=?
         WHERE task_id=?`,
      ).run(now, attempt.task_id);
      const recovery = {
        type: "attempt.recovery_required" as const,
        attemptId: attempt.id,
        fence: attempt.fence,
        reason: "custodian_restart" as const,
      };
      this.#appendEvent(
        attempt.work_id,
        recovery.type,
        attempt.worker_session_id,
        recovery,
      );
    }
    return workIds;
  }

  prepareProfileAuthorityChange(
    profileId: string,
    expectedGeneration: number,
    provider?: Provider,
  ): readonly string[] {
    const prepare = this.#database.transaction((): readonly string[] => {
      const profile = this.#database.query(
        "SELECT process_generation FROM profiles WHERE id=?",
      ).get(profileId) as { process_generation: number } | null;
      if (profile === null || profile.process_generation !== expectedGeneration) {
        throw new WorkStoreError("REVISION_CONFLICT");
      }
      const attempts = this.#database.query(
        `SELECT a.* FROM work_attempts AS a
         JOIN sessions AS s ON s.id=a.worker_session_id
         WHERE a.account_id=? AND a.account_generation=?
           AND a.state IN ('claimed','dispatching','running')
           AND (? IS NULL OR s.provider_v39=?)
         ORDER BY a.work_id,a.created_at,a.id`,
      ).all(profileId, expectedGeneration, provider ?? null, provider ?? null) as AttemptRow[];
      return this.#retireAttemptAuthority(
        attempts,
        expectedGeneration,
        "Profile authority retired before dispatch.",
      );
    });
    return prepare.immediate();
  }

  prepareSessionAuthorityChange(
    sessionIds: readonly string[],
    expectedProfileGeneration: number,
  ): readonly string[] {
    if (sessionIds.length > WORK_SESSION_AUTHORITY_CHANGE_LIMIT) {
      throw new WorkStoreError("WORK_CAPACITY_EXCEEDED");
    }
    if (
      !Number.isSafeInteger(expectedProfileGeneration)
      || expectedProfileGeneration < 0
    ) throw new WorkStoreError("REVISION_CONFLICT");
    const uniqueSessionIds = [...new Set(sessionIds)];
    if (uniqueSessionIds.some((sessionId) => !sessionIdSchema.safeParse(sessionId).success)) {
      throw new WorkStoreError("REVISION_CONFLICT");
    }
    if (uniqueSessionIds.length === 0) return [];
    uniqueSessionIds.sort();
    const prepare = this.#database.transaction((): readonly string[] => {
      let profileId: string | null = null;
      for (const sessionId of uniqueSessionIds) {
        const session = this.#database.query(
          `SELECT s.profile_id,captured.process_generation,captured.provider
           FROM sessions AS s
           JOIN session_provider_authorities AS captured
             ON captured.session_id=s.id AND captured.profile_id=s.profile_id
               AND captured.provider=s.provider_v39
           JOIN provider_accounts AS account
             ON account.id=captured.provider_account_id
               AND account.profile_id=captured.profile_id
               AND account.provider=captured.provider
           WHERE s.id=?`,
        ).get(sessionId) as {
          process_generation: number;
          profile_id: string;
          provider: Provider;
        } | null;
        if (
          session === null
          || session.process_generation !== expectedProfileGeneration
          || (profileId !== null && session.profile_id !== profileId)
        ) throw new WorkStoreError("REVISION_CONFLICT");
        profileId = session.profile_id;
      }
      const attemptsById = new Map<string, AttemptRow>();
      for (const sessionId of uniqueSessionIds) {
        const attempts = this.#database.query(
          `SELECT * FROM work_attempts
           WHERE worker_session_id=? AND account_generation=?
             AND state IN ('claimed','dispatching','running')
           ORDER BY work_id,created_at,id`,
        ).all(sessionId, expectedProfileGeneration) as AttemptRow[];
        for (const attempt of attempts) {
          // Retirement may consume an old captured process after its account
          // has advanced. It never grants a current provider dispatch. Work
          // task execution remains Codex-only under its original route.
          const session = this.#database.query(
            "SELECT profile_id,provider_v39 FROM sessions WHERE id=?",
          ).get(sessionId) as { profile_id: string; provider_v39: Provider } | null;
          if (session?.provider_v39 !== "codex" || attempt.account_id !== session.profile_id) {
            throw new WorkStoreError("REVISION_CONFLICT");
          }
          attemptsById.set(attempt.id, attempt);
        }
      }
      const attempts = [...attemptsById.values()].sort((left, right) =>
        left.work_id.localeCompare(right.work_id)
        || left.created_at - right.created_at
        || left.id.localeCompare(right.id));
      return this.#retireAttemptAuthority(
        attempts,
        expectedProfileGeneration,
        "Session controller authority retired before dispatch.",
      );
    });
    return prepare.immediate();
  }

  assertProfileCanChangeAuthority(
    profileId: string,
    provider?: Provider,
  ): void {
    const live = this.#database.query(
      `SELECT a.* FROM work_attempts AS a
       JOIN sessions AS s ON s.id=a.worker_session_id
       WHERE a.account_id=? AND a.state IN ('claimed','dispatching','running')
         AND (? IS NULL OR s.provider_v39=?)
       LIMIT 1`,
    ).get(profileId, provider ?? null, provider ?? null) as AttemptRow | null;
    if (live !== null) this.#assertCanonicalAttempt(live);
    if (live !== null) throw new WorkStoreError("ATTEMPT_RECOVERY_REQUIRED");
  }

  assertSessionCanChangeRoute(sessionId: string): void {
    const live = this.#database.query(
      `SELECT * FROM work_attempts
       WHERE worker_session_id=?
         AND state IN ('claimed','dispatching','running','recovery_required')
       LIMIT 1`,
    ).get(sessionId) as AttemptRow | null;
    if (live !== null) this.#assertCanonicalAttempt(live);
    if (live !== null) throw new WorkStoreError("ATTEMPT_RECOVERY_REQUIRED");
  }

  assertSessionProviderSwitchAllowed(sessionId: string): void {
    const blocked = this.#database.query(
      `SELECT 1 AS present
       FROM works AS w
       WHERE w.state IN ('active','cancel_pending','fail_pending')
         AND (
           w.coordinator_session_id=?
           OR EXISTS (
             SELECT 1 FROM work_members AS m
             WHERE m.work_id=w.id AND m.session_id=?
           )
         )
       UNION ALL
       SELECT 1 AS present
       FROM work_attempts AS a
       WHERE a.worker_session_id=?
         AND a.state IN ('claimed','dispatching','running','recovery_required')
       LIMIT 1`,
    ).get(sessionId, sessionId, sessionId) as { present: number } | null;
    if (blocked !== null) throw new WorkStoreError("SESSION_PROVIDER_SWITCH_BLOCKED");
  }

  #sweepStaleAttemptAuthority(workId: string, now: number): void {
    const attempts = this.#database.query(
      `SELECT * FROM work_attempts
       WHERE work_id=? AND state IN ('claimed','dispatching','running')
       ORDER BY created_at,id`,
    ).all(workId) as AttemptRow[];
    for (const attempt of attempts) {
      if (this.#attemptAuthorityCurrent(attempt)) continue;
      const at = this.#tick();
      if (attempt.state !== "claimed") {
        this.#database.query(
          `UPDATE work_attempts SET state='recovery_required',revision=revision+1,updated_at=?
           WHERE id=? AND state=?`,
        ).run(at, attempt.id, attempt.state);
        this.#database.query(
          `UPDATE work_task_states SET state='recovery_required',revision=revision+1,updated_at=?
           WHERE task_id=?`,
        ).run(at, attempt.task_id);
        const recovery = {
          type: "attempt.recovery_required" as const,
          attemptId: attempt.id,
          fence: attempt.fence,
          reason: "custodian_restart" as const,
        };
        this.#appendEvent(workId, recovery.type, attempt.worker_session_id, recovery);
        continue;
      }
      const task = this.#requireTask(attempt.task_id, workId);
      const failureReason = this.#retryFailureReason(task.task, task.state, now);
      this.#database.query(
        `UPDATE work_attempts SET state='released',revision=revision+1,updated_at=?,terminal_at=?
         WHERE id=? AND state='claimed'`,
      ).run(at, at, attempt.id);
      this.#database.query(
        `UPDATE work_task_states SET state=?,revision=revision+1,retry_not_before=NULL,updated_at=?
         WHERE task_id=? AND state='claimed'`,
      ).run(failureReason === null ? "pending" : "failed", at, attempt.task_id);
      const released = {
        type: "attempt.released" as const,
        attemptId: attempt.id,
        summaryDigest: digestJson("Pinned session or account authority changed before dispatch."),
      };
      this.#appendEvent(workId, released.type, attempt.worker_session_id, released);
      if (failureReason !== null) {
        this.#appendTaskFailure(workId, attempt.task_id, failureReason, attempt.worker_session_id);
      }
    }
  }

  #sweepExpired(workId: string, now: number): void {
    this.#sweepStaleAttemptAuthority(workId, now);
    const elapsedTasks = this.#database.query(
      `SELECT t.id,t.claim_by,t.deadline FROM work_tasks AS t
       JOIN work_task_states AS s ON s.task_id=t.id
       WHERE t.work_id=? AND s.state='pending' AND (
         (t.claim_by IS NOT NULL AND t.claim_by<=?)
         OR (t.deadline IS NOT NULL AND t.deadline<=?)
       )
       ORDER BY t.ordinal,t.id`,
    ).all(workId, now, now) as Array<{
      id: string;
      claim_by: number | null;
      deadline: number | null;
    }>;
    for (const task of elapsedTasks) {
      this.#canonicalTaskIdentity(task.id, workId);
      const at = this.#tick();
      const changed = this.#database.query(
        `UPDATE work_task_states SET state='failed',revision=revision+1,updated_at=?
         WHERE task_id=? AND state='pending'`,
      ).run(at, task.id);
      if (changed.changes !== 1) continue;
      this.#appendTaskFailure(
        workId,
        task.id,
        task.claim_by !== null && task.claim_by <= now
          ? "claim_window_elapsed"
          : "completion_deadline_elapsed",
      );
    }
    const deadlineAttempts = this.#database.query(
      `SELECT a.* FROM work_attempts AS a
       JOIN work_tasks AS t ON t.id=a.task_id
       WHERE a.work_id=? AND t.deadline IS NOT NULL AND t.deadline<=?
         AND a.state IN ('claimed','dispatching','running','submitted','recovery_required')
       ORDER BY a.created_at,a.id`,
    ).all(workId, now) as AttemptRow[];
    for (const attempt of deadlineAttempts) {
      this.#assertCanonicalAttempt(attempt);
      if (attempt.state === "recovery_required") continue;
      const at = this.#tick();
      if (attempt.state === "dispatching" || attempt.state === "running") {
        this.#database.query(
          `UPDATE work_attempts SET state='recovery_required',revision=revision+1,updated_at=?
           WHERE id=? AND state=?`,
        ).run(at, attempt.id, attempt.state);
        this.#database.query(
          `UPDATE work_task_states SET state='recovery_required',revision=revision+1,updated_at=?
           WHERE task_id=?`,
        ).run(at, attempt.task_id);
        const recovery = {
          type: "attempt.recovery_required" as const,
          attemptId: attempt.id,
          fence: attempt.fence,
          reason: "effect_unknown" as const,
        };
        this.#appendEvent(workId, recovery.type, attempt.worker_session_id, recovery);
        continue;
      }
      this.#database.query(
        `UPDATE work_attempts SET state=?,revision=revision+1,updated_at=?,terminal_at=?
         WHERE id=? AND state=?`,
      ).run(attempt.state === "claimed" ? "expired" : "failed", at, at, attempt.id, attempt.state);
      this.#database.query(
        `UPDATE work_task_states
         SET state='failed',revision=revision+1,accepted_submission_id=NULL,updated_at=?
         WHERE task_id=?`,
      ).run(at, attempt.task_id);
      if (attempt.state === "claimed") {
        const expired = {
          type: "attempt.expired" as const,
          attemptId: attempt.id,
          fence: attempt.fence,
        };
        this.#appendEvent(workId, expired.type, attempt.worker_session_id, expired);
      }
      this.#appendTaskFailure(
        workId,
        attempt.task_id,
        "completion_deadline_elapsed",
        attempt.worker_session_id,
      );
    }
    const attempts = this.#database.query(
      `SELECT * FROM work_attempts
       WHERE work_id=? AND lease_expires_at<=?
         AND state IN ('claimed','dispatching','running')
       ORDER BY created_at,id`,
    ).all(workId, now) as AttemptRow[];
    for (const attempt of attempts) {
      const terminal = attempt.state === "claimed" ? "expired" : "recovery_required";
      this.#assertCanonicalAttempt(attempt);
      const task = this.#requireTask(attempt.task_id, workId);
      const attemptsExhausted = attempt.state === "claimed"
        && task.state.attempt_count >= task.task.max_attempts;
      const taskState = attempt.state === "claimed"
        ? attemptsExhausted ? "failed" : "pending"
        : "recovery_required";
      const at = this.#tick();
      this.#database.query(
        `UPDATE work_attempts
         SET state=?,revision=revision+1,updated_at=?,terminal_at=?
         WHERE id=? AND state=? AND fence=?`,
      ).run(
        terminal,
        at,
        terminal === "expired" ? at : null,
        attempt.id,
        attempt.state,
        attempt.fence,
      );
      this.#database.query(
        `UPDATE work_task_states
         SET state=?,revision=revision+1,updated_at=?
         WHERE task_id=?`,
      ).run(taskState, at, attempt.task_id);
      const body = terminal === "expired"
        ? { type: "attempt.expired" as const, attemptId: attempt.id, fence: attempt.fence }
        : {
            type: "attempt.recovery_required" as const,
            attemptId: attempt.id,
            fence: attempt.fence,
            reason: "lease_expired_after_dispatch" as const,
          };
      this.#appendEvent(workId, body.type, attempt.worker_session_id, body);
      if (attemptsExhausted) {
        const failed = {
          type: "task.failed" as const,
          taskId: attempt.task_id,
          reason: "attempts_exhausted" as const,
        };
        this.#appendEvent(workId, failed.type, attempt.worker_session_id, failed);
      }
    }
  }

  #claimTask(
    workId: string,
    taskId: string,
    actorSessionId: string,
    leaseMs: number,
    now: number,
    expectedTaskRevision?: number,
  ): { attempt: AttemptRow; task: TaskRow } {
    const { task, state } = this.#requireTask(taskId, workId);
    if (expectedTaskRevision !== undefined && state.revision !== expectedTaskRevision) {
      throw new WorkStoreError("REVISION_CONFLICT");
    }
    const accountGeneration = this.#assertSessionRoute(task, actorSessionId);
    if (this.#activeActorAttempt(workId, actorSessionId) !== null) {
      throw new WorkStoreError("ATTEMPT_NOT_CLAIMABLE");
    }
    if (state.attempt_count >= task.max_attempts) throw new WorkStoreError("ATTEMPT_EXHAUSTED");
    if (!this.#taskReady(task, state, now)) {
      const unmet = this.#database.query(
        `SELECT 1 AS present FROM work_task_dependencies AS d
         JOIN work_task_states AS s ON s.task_id=d.dependency_task_id
         WHERE d.work_id=? AND d.task_id=? AND s.state!='completed' LIMIT 1`,
      ).get(workId, taskId) as { present: number } | null;
      if (unmet !== null) throw new WorkStoreError("DEPENDENCY_INCOMPLETE");
      throw new WorkStoreError("ATTEMPT_NOT_CLAIMABLE");
    }
    const attemptId = createWorkAttemptId();
    const fence = state.next_fence;
    const expiresAt = now + leaseMs;
    this.#database.query(
      `INSERT INTO work_attempts(
         id,work_id,task_id,worker_session_id,account_id,project_id,preset,fast,
         fence,revision,state,lease_expires_at,target_session_id,dispatch_mode,submission_id,
         account_generation,daemon_generation,created_at,updated_at,terminal_at,canonical_profile_key
       ) VALUES (?,?,?,?,?,?,?,?,?,1,'claimed',?,NULL,NULL,NULL,?,?,?,?,NULL,?)`,
    ).run(
      attemptId,
      workId,
      taskId,
      actorSessionId,
      task.account_id,
      task.project_id,
      task.preset,
      task.fast,
      fence,
      expiresAt,
      accountGeneration,
      this.#daemonGeneration,
      now,
      now,
      this.#assertCanonicalTask(task),
    );
    this.#database.query(
      `UPDATE work_task_states
       SET state='claimed',revision=revision+1,next_fence=next_fence+1,
           attempt_count=attempt_count+1,updated_at=?
       WHERE task_id=? AND state='pending' AND next_fence=?`,
    ).run(now, taskId, fence);
    return { attempt: this.#requireAttempt(attemptId, workId), task };
  }

  #taskStatus(task: TaskRow, state: TaskStateRow, now: number): WorkTaskSummary["status"] {
    this.#assertCanonicalTask(task);
    switch (state.state) {
      case "pending":
        return this.#taskReady(task, state, now) ? "ready" : "waiting";
      case "claimed":
        return "claimed";
      case "dispatching":
      case "running":
        return "dispatched";
      case "submitted":
        return "submitted";
      case "recovery_required":
        return "blocked";
      case "completed":
      case "failed":
      case "cancelled":
        return state.state;
    }
  }

  #taskSummary(task: TaskRow, state: TaskStateRow, now: number): WorkTaskSummary {
    const active = this.#database.query(
      `SELECT id FROM work_attempts
       WHERE task_id=? AND state IN ('claimed','dispatching','running','submitted','recovery_required')
       ORDER BY created_at DESC,id DESC LIMIT 1`,
    ).get(task.id) as { id: string } | null;
    if (active !== null) this.#canonicalAttemptIdentity(active.id, task.work_id, task.id);
    const latestSubmission = this.#database.query(
      `SELECT id FROM work_submissions WHERE task_id=? ORDER BY created_at DESC,id DESC LIMIT 1`,
    ).get(task.id) as { id: string } | null;
    if (latestSubmission !== null) {
      this.#canonicalSubmissionIdentity(latestSubmission.id, task.work_id, task.id);
    }
    return {
      id: task.id,
      clientRef: task.client_ref,
      status: this.#taskStatus(task, state, now),
      revision: state.revision,
      route: {
        accountId: task.account_id,
        projectId: task.project_id,
      },
      preset: task.preset,
      fast: task.fast === 1,
      priority: task.priority,
      depth: task.depth,
      attemptCount: state.attempt_count,
      activeAttemptId: (active?.id ?? null),
      latestSubmissionId: (latestSubmission?.id ?? null),
    };
  }

  #effectReceipt(
    effectKind: PreparedEffectRow["effect_kind"],
    subjectId: string,
  ): WorkNestedEffectReceipt | null {
    const row = this.#database.query(
      `SELECT outcome_json FROM work_prepared_effects
       WHERE effect_kind=? AND subject_id=? AND state='accepted'`,
    ).get(effectKind, subjectId) as { outcome_json: string | null } | null;
    if (row?.outcome_json === null || row?.outcome_json === undefined) return null;
    const outcome = parseStoredJson(row.outcome_json);
    if (typeof outcome !== "object" || outcome === null || Array.isArray(outcome)) return null;
    const receipt = (outcome as Record<string, unknown>).receipt;
    return receipt === undefined ? null : workNestedEffectReceiptSchema.parse(receipt);
  }

  #attemptRecord(attempt: AttemptRow): WorkAttemptRecord {
    this.#assertCanonicalAttempt(attempt);
    const status: WorkAttemptRecord["status"] = (() => {
      switch (attempt.state) {
        case "claimed": return "claimed";
        case "dispatching": return "dispatching";
        case "running": return "active";
        case "submitted": return "submitted";
        case "blocked": return "blocked";
        case "failed": return "failed";
        case "recovery_required": return "unknown";
        case "released":
        case "cancelled": return "released";
        case "expired": return "expired";
        case "completed": return "reconciled";
      }
    })();
    const terminal = ["completed", "blocked", "failed", "released", "expired", "cancelled"]
      .includes(attempt.state);
    return {
      id: attempt.id,
      taskId: attempt.task_id,
      actorSessionId: attempt.worker_session_id,
      accountGeneration: attempt.account_generation,
      status,
      revision: attempt.revision,
      fence: attempt.fence,
      leaseExpiresAt: terminal ? null : attempt.lease_expires_at,
      targetSessionId: attempt.target_session_id,
      dispatchMode: attempt.dispatch_mode,
      dispatchReceipt: this.#effectReceipt("attempt_dispatch", attempt.id),
      submissionId: attempt.submission_id,
      createdAt: attempt.created_at,
      updatedAt: attempt.updated_at,
    };
  }

  #attemptReportRecord(report: AttemptReportRow): WorkAttemptReportRecord {
    this.#canonicalAttemptIdentity(report.attempt_id, report.work_id, report.task_id);
    return {
      idempotencyKey: report.idempotency_key,
      taskId: report.task_id,
      attemptId: report.attempt_id,
      reportKind: report.kind,
      report: parseStoredJson(report.report_json) as WorkAttemptReportRecord["report"],
      reportDigest: report.report_digest,
      createdAt: report.created_at,
    };
  }

  #submissionRecord(submission: SubmissionRow): WorkSubmissionRecord {
    this.#canonicalAttemptIdentity(submission.attempt_id, submission.work_id, submission.task_id);
    const task = this.#requireTask(submission.task_id, submission.work_id).task;
    const reviews = this.#database.query(
      "SELECT decision,created_at FROM work_reviews WHERE submission_id=? ORDER BY created_at,id",
    ).all(submission.id) as Array<{ decision: "accept" | "revise" | "reject"; created_at: number }>;
    const accepted = reviews.filter((review) => review.decision === "accept").length;
    const status: WorkSubmissionRecord["status"] = reviews.some((review) => review.decision === "revise")
      ? "revision_requested"
      : reviews.some((review) => review.decision === "reject")
        ? "rejected"
        : accepted >= task.required_reviews
          ? "accepted"
          : "pending_review";
    return {
      id: submission.id,
      taskId: submission.task_id,
      attemptId: submission.attempt_id,
      status,
      revision: 1 + reviews.length,
      summary: submission.summary,
      result: parseStoredJson(submission.result_json) as WorkSubmissionRecord["result"],
      evidence: parseStoredJson(submission.evidence_json) as WorkSubmissionRecord["evidence"],
      contentDigest: submission.content_digest,
      requiredReviews: task.required_reviews,
      acceptedReviews: Math.min(accepted, task.required_reviews),
      createdAt: submission.created_at,
      updatedAt: reviews.at(-1)?.created_at ?? submission.created_at,
    };
  }

  #reviewRecord(row: ReviewRow): WorkReviewRecord {
    this.#canonicalSubmissionIdentity(row.submission_id, row.work_id);
    const review = parseStoredJson(row.review_json) as Record<string, unknown>;
    const summary = row.decision === "revise" ? review.feedback : review.summary;
    if (typeof summary !== "string") throw new Error("WORK_REVIEW_CORRUPT");
    return {
      id: row.id,
      submissionId: row.submission_id,
      reviewerSessionId: row.reviewer_session_id,
      decision: row.decision,
      summary,
      evidence: review.evidence as WorkReviewRecord["evidence"],
      createdAt: row.created_at,
    };
  }

  #signalRecord(signalId: string): WorkSignalRecord {
    const row = this.#database.query(
      "SELECT * FROM work_signals WHERE id=?",
    ).get(signalId) as {
      id: string;
      work_id: string;
      from_session_id: string;
      to_session_id: string;
      target_account_generation: number;
      task_id: string | null;
      reply_to_signal_id: string | null;
      mode: "queue" | "steer";
      body: string;
      created_at: number;
    } | null;
    if (row === null) throw new WorkStoreError("SIGNAL_NOT_FOUND");
    if (row.task_id !== null) this.#canonicalTaskIdentity(row.task_id, row.work_id);
    const receipts = this.#database.query(
      `SELECT kind,recorded_at FROM work_signal_receipts
       WHERE signal_id=? ORDER BY sequence`,
    ).all(signalId) as Array<{
      kind: "accepted" | "ack" | "unknown" | "failed";
      recorded_at: number;
    }>;
    const latestDelivery = receipts.findLast((receipt) => receipt.kind !== "ack")?.kind;
    const deliveryState: WorkSignalRecord["deliveryState"] = latestDelivery === "failed"
        ? "failed"
        : latestDelivery === "unknown"
          ? "unknown"
          : latestDelivery === "accepted"
            ? "accepted"
            : "pending";
    return {
      id: row.id,
      senderSessionId: row.from_session_id,
      targetSessionId: row.to_session_id,
      accountGeneration: row.target_account_generation,
      taskId: row.task_id,
      replyToSignalId: row.reply_to_signal_id,
      mode: row.mode,
      deliveryState,
      deliveryReceipt: this.#effectReceipt("signal_send", row.id),
      body: row.body,
      revision: 1 + receipts.length,
      createdAt: row.created_at,
      acknowledgedAt: receipts.findLast((receipt) => receipt.kind === "ack")?.recorded_at ?? null,
    };
  }

  #workRecord(workId: string, now: number): WorkRecord {
    const work = this.#requireWork(workId);
    this.#routes(workId);
    const tasks = this.#database.query(
      `SELECT t.*,s.state AS state,s.revision AS revision,s.next_fence AS next_fence,
              s.attempt_count AS attempt_count,s.accepted_submission_id AS accepted_submission_id,
              s.retry_not_before AS retry_not_before,s.updated_at AS updated_at
       FROM work_tasks AS t JOIN work_task_states AS s ON s.task_id=t.id
       WHERE t.work_id=? ORDER BY t.ordinal,t.id`,
    ).all(workId) as Array<TaskRow & TaskStateRow>;
    const statuses = tasks.map((row) => this.#taskStatus(row, row, now));
    return {
      id: work.id,
      clientRef: work.client_ref,
      coordinatorSessionId: work.coordinator_session_id,
      objective: work.objective,
      status: work.state === "active" ? "open" : work.state,
      revision: work.revision,
      taskCount: tasks.length,
      waitingTaskCount: statuses.filter((status) => status === "waiting").length,
      readyTaskCount: statuses.filter((status) => status === "ready").length,
      activeTaskCount: statuses.filter((status) =>
        ["claimed", "dispatched", "submitted", "blocked"].includes(status)).length,
      completedTaskCount: statuses.filter((status) => status === "completed").length,
      failedTaskCount: statuses.filter((status) => status === "failed").length,
      cancelledTaskCount: statuses.filter((status) => status === "cancelled").length,
      createdAt: work.created_at,
      updatedAt: work.updated_at,
      terminalAt: ["active", "cancel_pending", "fail_pending"].includes(work.state)
        ? null
        : work.updated_at,
    };
  }

  #taskSpec(task: TaskRow): WorkTaskSpec {
    this.#assertCanonicalTask(task);
    this.#assertCanonicalTaskReferences(task.id, task.work_id);
    const dependencies = this.#database.query(
      `SELECT dependency_task_id FROM work_task_dependencies
       WHERE work_id=? AND task_id=? ORDER BY ordinal`,
    ).all(task.work_id, task.id) as Array<{ dependency_task_id: string }>;
    return {
      clientRef: task.client_ref,
      ...(task.parent_task_id === null
        ? {}
        : { parentTaskId: task.parent_task_id }),
      dependsOnRefs: [],
      dependsOnTaskIds: dependencies.map((row) => row.dependency_task_id),
      objective: task.objective,
      instructions: task.instructions,
      criteria: parseStoredJson(task.criteria_json) as WorkTaskSpec["criteria"],
      route: {
        accountId: task.account_id,
        projectId: task.project_id,
      },
      preset: task.preset,
      fast: task.fast === 1,
      priority: task.priority,
      ...(task.not_before === null ? {} : { notBefore: task.not_before }),
      ...(task.claim_by === null ? {} : { claimBy: task.claim_by }),
      ...(task.deadline === null ? {} : { deadline: task.deadline }),
      maxAttempts: task.max_attempts,
      requiredReviews: task.required_reviews,
      resultKind: task.result_kind,
      minEvidence: task.min_evidence,
    };
  }

  #assertFreshApplySource(
    operation: WorkOperation,
    source: WorkApplyRequestSource,
  ): void {
    const requiresPresetContract = workOperationRequiresPresetContract(operation);
    if (!requiresPresetContract) {
      if (source.version === WORK_APPLY_REQUEST_VERSION && source.presetContract !== undefined) {
        throw new WorkStoreError("ROUTE_MISMATCH");
      }
      return;
    }
    if (
      source.version !== WORK_APPLY_REQUEST_VERSION
      || source.presetContract !== ACTIVE_WORK_PRESET_CONTRACT
    ) {
      throw new WorkStoreError("ROUTE_MISMATCH");
    }
  }

  #assertFreshWorkContract(operation: WorkOperation): void {
    if (
      operation.kind === "task.addBatch"
      && operation.tasks.some((task) => isReboundCodexPreset(task.preset))
      && this.#requireWork(operation.workId).preset_contract !== ACTIVE_WORK_PRESET_CONTRACT
    ) {
      throw new WorkStoreError("ROUTE_MISMATCH");
    }
  }

  #assertCanonicalOperationSources(operation: WorkOperation): void {
    // Recovery deliberately commits before ordinary command refusal. Prove
    // already-present identity debt in the operation's bounded source set
    // before that first commit, without changing ordinary recovery semantics.
    if (operation.kind === "work.create") {
      this.#canonicalSessionKey(operation.coordinatorSessionId);
      return;
    }
    const work = this.#requireWork(operation.workId);
    if (this.#canonicalSessionKey(work.coordinator_session_id) === null) {
      throw new Error("WORK_CANONICAL_PROFILE_CORRUPT");
    }
    this.#routes(work.id);
    if ("actorSessionId" in operation) this.#canonicalSessionKey(operation.actorSessionId);
    if ("coordinatorSessionId" in operation) this.#canonicalSessionKey(operation.coordinatorSessionId);
    if ("reviewerSessionId" in operation) this.#canonicalSessionKey(operation.reviewerSessionId);
    if ("senderSessionId" in operation) this.#canonicalSessionKey(operation.senderSessionId);
    if ("targetSessionId" in operation) this.#canonicalSessionKey(operation.targetSessionId);
    const task = (taskId: string): void => {
      const row: unknown = this.#database.query(
        "SELECT * FROM main.work_tasks WHERE id COLLATE BINARY=? AND work_id COLLATE BINARY=?",
      ).get(taskId, work.id);
      // A missing user-supplied subject keeps its established operation error.
      if (row !== null) {
        this.#assertCanonicalTask(row);
        this.#assertCanonicalTaskReferences(taskId, work.id);
      }
    };
    const attempt = (attemptId: string): void => {
      const row: unknown = this.#database.query(
        "SELECT * FROM main.work_attempts WHERE id COLLATE BINARY=? AND work_id COLLATE BINARY=?",
      ).get(attemptId, work.id);
      if (row !== null) {
        const parsed = canonicalAttemptIdentitySchema.safeParse(row);
        if (!parsed.success) throw new Error("WORK_CANONICAL_PROFILE_CORRUPT");
        this.#assertCanonicalAttempt(parsed.data);
        this.#assertCanonicalTaskReferences(parsed.data.task_id, work.id);
      }
    };
    if ("taskId" in operation && operation.taskId !== undefined) task(operation.taskId);
    if ("attemptId" in operation) attempt(operation.attemptId);
    if (operation.kind === "task.claimBatch") {
      for (const claim of operation.claims) {
        task(claim.taskId);
        this.#canonicalSessionKey(claim.actorSessionId);
      }
    }
    if (operation.kind === "signal.send" && operation.taskId !== undefined) {
      // Preserve ordinary governance refusal after recovery, but validate the
      // exact related ownership witnesses that governance would consume.
      this.#sessionOwnsRelatedTask(work.id, operation.senderSessionId, operation.taskId);
      this.#sessionOwnsRelatedTask(work.id, operation.targetSessionId, operation.taskId);
    }
    if (operation.kind === "submission.review") {
      const row = this.#database.query(
        "SELECT id FROM main.work_submissions WHERE id COLLATE BINARY=? AND work_id COLLATE BINARY=?",
      ).get(operation.submissionId, work.id);
      if (row !== null) this.#canonicalSubmissionIdentity(operation.submissionId, work.id);
    }
    if (operation.kind === "signal.ack") {
      const source: unknown = this.#database.query(
        "SELECT task_id FROM main.work_signals WHERE id COLLATE BINARY=? AND work_id COLLATE BINARY=?",
      ).get(operation.signalId, work.id);
      if (source !== null) {
        const row = z.object({ task_id: z.string().nullable() }).strict().safeParse(source);
        if (!row.success) throw new Error("WORK_CANONICAL_PROFILE_CORRUPT");
        if (row.data.task_id !== null) this.#canonicalTaskIdentity(row.data.task_id, work.id);
      }
    }
    const allTasks = operation.kind === "task.addBatch"
      || operation.kind === "work.complete" || operation.kind === "work.fail"
      || operation.kind === "work.cancel" || operation.kind === "work.release";
    if (allTasks || operation.kind === "task.claimNext") {
      const rows = this.#database.query(
        allTasks
          ? "SELECT * FROM main.work_tasks WHERE work_id COLLATE BINARY=? ORDER BY ordinal,id"
          : `SELECT t.* FROM main.work_tasks AS t
         JOIN main.work_task_states AS s ON s.task_id=t.id
         WHERE t.work_id COLLATE BINARY=? AND s.state='pending'
         ORDER BY t.ordinal,t.id`,
      ).all(work.id);
      for (const row of rows) {
        const parsed = canonicalTaskIdentitySchema.safeParse(row);
        if (!parsed.success) throw new Error("WORK_CANONICAL_PROFILE_CORRUPT");
        this.#assertCanonicalTask(parsed.data);
        this.#assertCanonicalTaskReferences(parsed.data.id, work.id);
      }
    }
    if (operation.kind === "work.complete" || operation.kind === "work.fail"
      || operation.kind === "work.cancel" || operation.kind === "work.release") {
      const rows = this.#database.query(
        "SELECT * FROM main.work_attempts WHERE work_id COLLATE BINARY=? ORDER BY created_at,id",
      ).all(work.id);
      for (const row of rows) this.#assertCanonicalAttempt(row);
    }
  }

  apply(
    operationInput: unknown,
    idempotencyKey?: string,
    sourceInput?: WorkApplyRequestSource,
  ): WorkApplyResult {
    const operation = workOperationSchema.parse(operationInput);
    if (idempotencyKey !== undefined && idempotencyKey !== operation.idempotencyKey) {
      throw new WorkStoreError("BAD_IDEMPOTENCY_KEY");
    }
    const source = normalizeWorkApplyRequestSource(operation, sourceInput);
    this.#authorizeOperation(operation);
    if (operation.kind === "attempt.dispatch" || operation.kind === "signal.send") {
      this.#assertLegacyNestedMutationKey(deriveNestedMutationKey(operation.idempotencyKey));
    }
    const requestDigest = workApplyRequestDigest(operation, source);
    const releaseReplay = this.#replayReleaseTombstone(operation, requestDigest);
    if (releaseReplay !== null) return releaseReplay;
    this.#assertOperationNotReleased(operation);
    const earlyReplay = this.#replayIntent(operation, requestDigest);
    if (earlyReplay !== null) return earlyReplay;
    this.#assertFreshApplySource(operation, source);
    // The immutable Work contract is part of fresh rebound-task admission.
    // Check it before the recovery sweep so a rejected source cannot expire
    // leases or otherwise change durable state on its way to rejection.
    this.#assertFreshWorkContract(operation);
    this.#preverifyOperationEvidence(operation);
    try {
      if (operation.kind !== "work.create") {
        const recover = this.#database.transaction((): WorkApplyResult | null => {
          this.#pruneReleaseTombstones(this.#projectionTime());
          const released = this.#replayReleaseTombstone(operation, requestDigest);
          if (released !== null) return released;
          this.#assertOperationNotReleased(operation);
          const replayed = this.#replayIntent(operation, requestDigest);
          if (replayed !== null) return replayed;
          this.#assertCanonicalOperationSources(operation);
          const work = this.#requireWork(operation.workId);
          if (["active", "cancel_pending", "fail_pending"].includes(work.state)) {
            this.#sweepExpired(operation.workId, this.#tick());
          }
          return null;
        });
        const recovered = recover.immediate();
        if (recovered !== null) return recovered;
      }
      const execute = this.#database.transaction((): WorkApplyResult => {
        this.#pruneReleaseTombstones(this.#projectionTime());
        const released = this.#replayReleaseTombstone(operation, requestDigest);
        if (released !== null) return released;
        this.#assertOperationNotReleased(operation);
        const replayed = this.#replayIntent(operation, requestDigest);
        if (replayed !== null) return replayed;
        this.#assertCanonicalOperationSources(operation);
        if (operation.kind !== "work.create") {
          if ("expectedWorkRevision" in operation) {
            this.#assertRevision(operation.workId, operation.expectedWorkRevision);
          }
          const generalEventCost = this.#generalEventCost(operation);
          if (generalEventCost > 0) {
            this.#assertGeneralEventCapacity(operation.workId, generalEventCost);
          }
          if (!this.#isRecoveryReserveOperation(operation)) {
            this.#assertIntentCapacity(operation.workId, true);
          }
        }
        const result = this.#applyFresh(operation, requestDigest);
        if (operation.kind === "work.release") return result;
        const workId = operation.kind === "work.create"
          ? (result as Extract<WorkApplyResult, { kind: "work.create" }>).work.id
          : operation.workId;
        return this.#storeIntent(operation, workId, requestDigest, result);
      });
      return execute.immediate();
    } finally {
      this.#verifiedEvidence.delete(operation.idempotencyKey);
    }
  }

  #applyFresh(operation: WorkOperation, requestDigest: string): WorkApplyResult {
    switch (operation.kind) {
      case "work.create": {
        const duplicate = this.#database.query(
          "SELECT 1 AS present FROM works WHERE client_ref=?",
        ).get(operation.clientRef) as { present: number } | null;
        if (duplicate !== null) throw new WorkStoreError("REVISION_CONFLICT");
        const activeCount = (this.#database.query(
          `SELECT COUNT(*) AS count FROM works
           WHERE state IN ('active','cancel_pending','fail_pending')`,
        ).get() as { count: number } | null)?.count ?? 0;
        if (activeCount >= WORK_ACTIVE_LIMIT) {
          throw new WorkStoreError("WORK_CAPACITY_EXCEEDED");
        }
        const retainedCount = (this.#database.query(
          "SELECT COUNT(*) AS count FROM works",
        ).get() as { count: number } | null)?.count ?? 0;
        if (retainedCount >= WORK_RETAINED_LIMIT) {
          throw new WorkStoreError("WORK_CAPACITY_EXCEEDED");
        }
        this.#requireSessionAccountAuthority(
          operation.coordinatorSessionId,
          "MEMBER_NOT_FOUND",
        );
        const workId = createWorkId();
        const now = this.#tick();
        this.#database.query(
          `INSERT INTO works(
             id,client_ref,coordinator_session_id,objective,preset_contract,state,revision,stream_epoch,next_sequence,head_hash,
             created_at,updated_at
           ) VALUES (?,?,?,?,?,'active',0,?,1,NULL,?,?)`,
        ).run(
          workId,
          operation.clientRef,
          operation.coordinatorSessionId,
          operation.objective,
          ACTIVE_WORK_PRESET_CONTRACT,
          randomUUID(),
          now,
          now,
        );
        for (const [ordinal, route] of operation.routes.entries()) {
          this.#database.query(
            `INSERT INTO work_routes(work_id,ordinal,account_id,project_id,preset,fast,canonical_profile_key)
             VALUES (?,?,?,?,?,?,?)`,
          ).run(
            workId,
            ordinal,
            route.accountId,
            route.projectId,
            route.preset,
            route.fast ? 1 : 0,
            this.#canonicalWorkKey(workId, route.preset),
          );
        }
        this.#database.query(
          "INSERT INTO work_members(work_id,session_id,joined_at) VALUES (?,?,?)",
        ).run(workId, operation.coordinatorSessionId, now);
        const taskIds = this.#insertTasks(workId, operation.tasks, now);
        const body = {
          type: "work.created" as const,
          coordinatorSessionId: operation.coordinatorSessionId,
          routeCount: operation.routes.length,
          routesDigest: digestJson(operation.routes),
          taskIds,
        };
        this.#appendEvent(workId, body.type, operation.coordinatorSessionId, body);
        const at = this.#tick();
        const tasks = taskIds.map((taskId) => {
          const found = this.#requireTask(taskId, workId);
          return this.#taskSummary(found.task, found.state, at);
        });
        return workOperationResultSchema.parse({
          kind: "work.create",
          workId,
          workRevision: this.#requireWork(workId).revision,
          work: this.#workRecord(workId, at),
          coordinatorCapability: this.#capability({
            scope: "coordinator",
            workId,
            sessionId: operation.coordinatorSessionId,
          }),
          memberCapability: this.#capability({
            scope: "member",
            workId,
            sessionId: operation.coordinatorSessionId,
          }),
          routes: this.#routes(workId),
          tasks,
        });
      }
      case "task.addBatch": {
        this.#requireActiveWork(operation.workId);
        this.#assertCoordinator(operation.workId, operation.coordinatorSessionId);
        const now = this.#tick();
        const taskIds = this.#insertTasks(operation.workId, operation.tasks, now);
        const body = { type: "task.batch_added" as const, taskIds };
        const event = this.#appendEvent(operation.workId, body.type, undefined, body);
        const tasks = taskIds.map((taskId) => {
          const found = this.#requireTask(taskId, operation.workId);
          return this.#taskSummary(found.task, found.state, now);
        });
        return workOperationResultSchema.parse({
          kind: operation.kind,
          workId: operation.workId,
          workRevision: event.revision,
          tasks,
        });
      }
      case "work.join": {
        this.#requireActiveWork(operation.workId);
        this.#assertCoordinator(operation.workId, operation.coordinatorSessionId);
        this.#requireSessionAccountAuthority(operation.actorSessionId, "MEMBER_NOT_FOUND");
        const joined = this.#database.query(
          "SELECT 1 AS present FROM work_members WHERE work_id=? AND session_id=?",
        ).get(operation.workId, operation.actorSessionId) as { present: number } | null;
        if (joined !== null) {
          return workOperationResultSchema.parse({
            kind: operation.kind,
            workId: operation.workId,
            workRevision: this.#requireWork(operation.workId).revision,
            actorSessionId: operation.actorSessionId,
            memberCapability: this.#capability({
              scope: "member",
              workId: operation.workId,
              sessionId: operation.actorSessionId,
            }),
          });
        }
        this.#assertMemberCapacity(operation.workId);
        const now = this.#tick();
        this.#database.query(
          "INSERT INTO work_members(work_id,session_id,joined_at) VALUES (?,?,?)",
        ).run(operation.workId, operation.actorSessionId, now);
        const body = {
          type: "work.joined" as const,
          coordinatorSessionId: operation.coordinatorSessionId,
          actorSessionId: operation.actorSessionId,
        };
        const event = this.#appendEvent(
          operation.workId,
          body.type,
          operation.actorSessionId,
          body,
        );
        return workOperationResultSchema.parse({
          kind: operation.kind,
          workId: operation.workId,
          workRevision: event.revision,
          actorSessionId: operation.actorSessionId,
          memberCapability: this.#capability({
            scope: "member",
            workId: operation.workId,
            sessionId: operation.actorSessionId,
          }),
        });
      }
      case "task.claim": {
        this.#requireActiveWork(operation.workId);
        const now = this.#tick();
        const claimed = this.#claimTask(
          operation.workId,
          operation.taskId,
          operation.actorSessionId,
          operation.leaseMs,
          now,
          operation.expectedTaskRevision,
        );
        const body = {
          type: "task.claimed" as const,
          taskId: claimed.task.id,
          attemptId: claimed.attempt.id,
          actorSessionId: operation.actorSessionId,
          fence: claimed.attempt.fence,
          leaseExpiresAt: claimed.attempt.lease_expires_at,
        };
        this.#appendEvent(operation.workId, body.type, operation.actorSessionId, body);
        const current = this.#requireTask(claimed.task.id, operation.workId);
        return workOperationResultSchema.parse({
          kind: operation.kind,
          workId: operation.workId,
          workRevision: this.#requireWork(operation.workId).revision,
          task: this.#taskSummary(current.task, current.state, now),
          attempt: this.#attemptRecord(this.#requireAttempt(claimed.attempt.id, operation.workId)),
          attemptCapability: this.#capability({
            scope: "attempt",
            workId: operation.workId,
            sessionId: claimed.attempt.worker_session_id,
            attemptId: claimed.attempt.id,
            fence: claimed.attempt.fence,
          }),
        });
      }
      case "task.claimNext": {
        this.#requireActiveWork(operation.workId);
        this.#requireMember(operation.workId, operation.actorSessionId);
        const now = this.#tick();
        if (this.#activeActorAttempt(operation.workId, operation.actorSessionId) !== null) {
          throw new WorkStoreError("ATTEMPT_NOT_CLAIMABLE");
        }
        const candidates = this.#database.query(
          `SELECT t.id FROM work_tasks AS t
           JOIN work_task_states AS s ON s.task_id=t.id
           WHERE t.work_id=? AND t.account_id=? AND t.project_id=? AND s.state='pending'
           ORDER BY t.priority DESC,t.ordinal,t.id`,
        ).all(
          operation.workId,
          operation.route.accountId,
          operation.route.projectId,
        ) as Array<{ id: string }>;
        const candidate = candidates.find(({ id }) => {
          const found = this.#requireTask(id, operation.workId);
          try {
            this.#assertSessionRoute(found.task, operation.actorSessionId);
          } catch (error) {
            if (error instanceof WorkStoreError && error.code === "ROUTE_MISMATCH") return false;
            throw error;
          }
          return this.#taskReady(found.task, found.state, now);
        });
        if (candidate === undefined) {
          return workOperationResultSchema.parse({
            kind: operation.kind,
            workId: operation.workId,
            workRevision: this.#requireWork(operation.workId).revision,
            task: null,
            attempt: null,
            attemptCapability: null,
          });
        }
        // Empty claim-next is intentionally stream-neutral, so its capacity
        // cannot be known until selection. A successful claim always emits
        // task.claimed and must consume normal (not recovery) history.
        this.#assertGeneralEventCapacity(operation.workId, 1);
        const claimed = this.#claimTask(
          operation.workId,
          candidate.id,
          operation.actorSessionId,
          operation.leaseMs,
          now,
        );
        const body = {
          type: "task.claimed" as const,
          taskId: claimed.task.id,
          attemptId: claimed.attempt.id,
          actorSessionId: operation.actorSessionId,
          fence: claimed.attempt.fence,
          leaseExpiresAt: claimed.attempt.lease_expires_at,
        };
        this.#appendEvent(operation.workId, body.type, operation.actorSessionId, body);
        const current = this.#requireTask(claimed.task.id, operation.workId);
        return workOperationResultSchema.parse({
          kind: operation.kind,
          workId: operation.workId,
          workRevision: this.#requireWork(operation.workId).revision,
          task: this.#taskSummary(current.task, current.state, now),
          attempt: this.#attemptRecord(this.#requireAttempt(claimed.attempt.id, operation.workId)),
          attemptCapability: this.#capability({
            scope: "attempt",
            workId: operation.workId,
            sessionId: claimed.attempt.worker_session_id,
            attemptId: claimed.attempt.id,
            fence: claimed.attempt.fence,
          }),
        });
      }
      case "task.claimBatch": {
        this.#requireActiveWork(operation.workId);
        const now = this.#tick();
        const claimed = operation.claims.map((claimRequest) => {
          const claim = this.#claimTask(
            operation.workId,
            claimRequest.taskId,
            claimRequest.actorSessionId,
            claimRequest.leaseMs,
            now,
            claimRequest.expectedTaskRevision,
          );
          const body = {
            type: "task.claimed" as const,
            taskId: claim.task.id,
            attemptId: claim.attempt.id,
            actorSessionId: claimRequest.actorSessionId,
            fence: claim.attempt.fence,
            leaseExpiresAt: claim.attempt.lease_expires_at,
          };
          this.#appendEvent(operation.workId, body.type, claimRequest.actorSessionId, body);
          return claim;
        });
        const workRevision = this.#requireWork(operation.workId).revision;
        return workOperationResultSchema.parse({
          kind: operation.kind,
          workId: operation.workId,
          workRevision,
          claims: claimed.map(({ attempt, task }) => {
            const current = this.#requireTask(task.id, operation.workId);
            return {
              task: this.#taskSummary(current.task, current.state, now),
              attempt: this.#attemptRecord(this.#requireAttempt(attempt.id, operation.workId)),
              attemptCapability: this.#capability({
                scope: "attempt",
                workId: operation.workId,
                sessionId: attempt.worker_session_id,
                attemptId: attempt.id,
                fence: attempt.fence,
              }),
            };
          }),
        });
      }
      case "attempt.renew":
        return this.#renew(operation);
      case "attempt.release":
        return this.#release(operation);
      case "attempt.dispatch":
        return this.#prepareDispatch(operation);
      case "attempt.report":
        return this.#report(operation);
      case "submission.review":
        return this.#review(operation);
      case "signal.send":
        return this.#prepareSignal(operation);
      case "signal.ack":
        return this.#ackSignal(operation);
      case "work.complete":
      case "work.fail":
      case "work.cancel":
        return this.#terminalWork(operation);
      case "work.release":
        return this.#releaseWork(operation, requestDigest);
      case "attempt.reconcile":
        return this.#reconcile(operation);
    }
  }

  #assertFence(attempt: AttemptRow, fence: number): void {
    if (attempt.fence !== fence) throw new WorkStoreError("FENCE_MISMATCH");
  }

  #assertAttemptOwner(attempt: AttemptRow, actorSessionId: string): void {
    if (attempt.worker_session_id !== actorSessionId) {
      throw new WorkStoreError("ATTEMPT_NOT_OWNER");
    }
  }

  #assertAttemptRevision(attempt: AttemptRow, expectedAttemptRevision: number): void {
    if (attempt.revision !== expectedAttemptRevision) {
      throw new WorkStoreError("REVISION_CONFLICT");
    }
  }

  #renew(operation: Extract<WorkOperation, { kind: "attempt.renew" }>): WorkApplyResult {
    this.#requireActiveWork(operation.workId);
    const attempt = this.#requireAttempt(operation.attemptId, operation.workId);
    this.#assertFence(attempt, operation.fence);
    this.#assertAttemptOwner(attempt, operation.actorSessionId);
    this.#assertAttemptRevision(attempt, operation.expectedAttemptRevision);
    if (!["claimed", "dispatching", "running"].includes(attempt.state)) {
      if (attempt.state === "recovery_required") {
        throw new WorkStoreError("ATTEMPT_RECOVERY_REQUIRED");
      }
      throw new WorkStoreError("ATTEMPT_NOT_CLAIMABLE");
    }
    const now = this.#tick();
    if (attempt.lease_expires_at <= now) throw new WorkStoreError("LEASE_EXPIRED");
    const leaseExpiresAt = Math.max(attempt.lease_expires_at, now + operation.leaseMs);
    const changed = this.#database.query(
      `UPDATE work_attempts
       SET lease_expires_at=?,revision=revision+1,updated_at=?
       WHERE id=? AND fence=? AND revision=?`,
    ).run(leaseExpiresAt, now, attempt.id, attempt.fence, attempt.revision);
    if (changed.changes !== 1) throw new WorkStoreError("REVISION_CONFLICT");
    const body = {
      type: "attempt.renewed" as const,
      attemptId: attempt.id,
      fence: attempt.fence,
      leaseExpiresAt,
    };
    this.#appendEvent(operation.workId, body.type, attempt.worker_session_id, body);
    return workOperationResultSchema.parse({
      kind: operation.kind,
      workId: operation.workId,
      workRevision: this.#requireWork(operation.workId).revision,
      attempt: this.#attemptRecord(this.#requireAttempt(attempt.id, operation.workId)),
    });
  }

  #release(operation: Extract<WorkOperation, { kind: "attempt.release" }>): WorkApplyResult {
    this.#requireActiveWork(operation.workId);
    const attempt = this.#requireAttempt(operation.attemptId, operation.workId);
    this.#assertFence(attempt, operation.fence);
    this.#assertAttemptOwner(attempt, operation.actorSessionId);
    this.#assertAttemptRevision(attempt, operation.expectedAttemptRevision);
    if (attempt.state !== "claimed") {
      if (["dispatching", "running", "recovery_required"].includes(attempt.state)) {
        throw new WorkStoreError("ATTEMPT_RECOVERY_REQUIRED");
      }
      throw new WorkStoreError("ATTEMPT_NOT_CLAIMABLE");
    }
    const now = this.#tick();
    if (attempt.lease_expires_at <= now) throw new WorkStoreError("LEASE_EXPIRED");
    const task = this.#requireTask(attempt.task_id, operation.workId);
    const failureReason = this.#retryFailureReason(task.task, task.state, now);
    this.#database.query(
      `UPDATE work_attempts
       SET state='released',revision=revision+1,updated_at=?,terminal_at=?
       WHERE id=? AND state='claimed' AND fence=?`,
    ).run(now, now, attempt.id, attempt.fence);
    this.#database.query(
      `UPDATE work_task_states
       SET state=?,revision=revision+1,retry_not_before=NULL,updated_at=?
       WHERE task_id=? AND state='claimed'`,
    ).run(failureReason === null ? "pending" : "failed", now, attempt.task_id);
    const body = {
      type: "attempt.released" as const,
      attemptId: attempt.id,
      summaryDigest: digestJson(operation.reason),
    };
    this.#appendEvent(operation.workId, body.type, attempt.worker_session_id, body);
    if (failureReason !== null) {
      this.#appendTaskFailure(
        operation.workId,
        attempt.task_id,
        failureReason,
        attempt.worker_session_id,
      );
    }
    return workOperationResultSchema.parse({
      kind: operation.kind,
      workId: operation.workId,
      workRevision: this.#requireWork(operation.workId).revision,
      attempt: this.#attemptRecord(this.#requireAttempt(attempt.id, operation.workId)),
    });
  }

  #prepareDispatch(
    operation: Extract<WorkOperation, { kind: "attempt.dispatch" }>,
  ): WorkApplyResult {
    this.#requireActiveWork(operation.workId);
    const attempt = this.#requireAttempt(operation.attemptId, operation.workId);
    this.#assertFence(attempt, operation.fence);
    this.#assertAttemptOwner(attempt, operation.actorSessionId);
    this.#assertAttemptRevision(attempt, operation.expectedAttemptRevision);
    if (operation.targetSessionId !== attempt.worker_session_id) {
      throw new WorkStoreError("ROUTE_MISMATCH");
    }
    if (attempt.state !== "claimed") throw new WorkStoreError("ATTEMPT_NOT_CLAIMABLE");
    const now = this.#tick();
    if (attempt.lease_expires_at <= now) throw new WorkStoreError("LEASE_EXPIRED");
    const task = this.#requireTask(attempt.task_id, operation.workId).task;
    const currentGeneration = this.#assertSessionRoute(task, operation.targetSessionId);
    if (currentGeneration !== attempt.account_generation) {
      throw new WorkStoreError("ROUTE_MISMATCH");
    }
    const dependencies = this.#database.query(
      `SELECT d.dependency_task_id AS task_id,t.client_ref,s.accepted_submission_id,
              sub.summary,sub.content_digest
       FROM work_task_dependencies AS d
       JOIN work_tasks AS t ON t.id=d.dependency_task_id
       JOIN work_task_states AS s ON s.task_id=d.dependency_task_id AND s.state='completed'
       JOIN work_submissions AS sub ON sub.id=s.accepted_submission_id
       WHERE d.work_id=? AND d.task_id=? ORDER BY d.ordinal`,
    ).all(operation.workId, task.id) as Array<{
      task_id: string;
      client_ref: string;
      accepted_submission_id: string;
      summary: string;
      content_digest: string;
    }>;
    const dependencyCount = (this.#database.query(
      `SELECT COUNT(*) AS count FROM work_task_dependencies WHERE work_id=? AND task_id=?`,
    ).get(operation.workId, task.id) as { count: number } | null)?.count ?? 0;
    if (dependencies.length !== dependencyCount) {
      throw new WorkStoreError("DEPENDENCY_INCOMPLETE");
    }
    for (const dependency of dependencies) {
      this.#canonicalTaskIdentity(dependency.task_id, operation.workId);
      this.#canonicalSubmissionIdentity(
        dependency.accepted_submission_id, operation.workId, dependency.task_id,
      );
    }
    const effect: WorkDispatchInstruction = {
      kind: "dispatch",
      workId: operation.workId,
      nestedMutationKey: deriveNestedMutationKey(operation.idempotencyKey),
      taskId: task.id,
      attemptId: attempt.id,
      attemptCapability: this.#capability({
        scope: "attempt",
        workId: operation.workId,
        sessionId: attempt.worker_session_id,
        attemptId: attempt.id,
        fence: attempt.fence,
      }),
      fence: attempt.fence,
      accountGeneration: attempt.account_generation,
      targetSessionId: operation.targetSessionId,
      mode: operation.mode,
      spec: this.#taskSpec(task),
      dependencies: dependencies.map((dependency) => ({
        taskId: dependency.task_id,
        clientRef: dependency.client_ref,
        submissionId: dependency.accepted_submission_id,
        summary: dependency.summary,
        contentDigest: dependency.content_digest,
      })),
    };
    const parsedEffect = workPreparedEffectSchema.parse(effect);
    if (Buffer.byteLength(workPreparedEffectMessage(parsedEffect), "utf8") > MESSAGE_MAX_BYTES) {
      throw new WorkStoreError("WORK_CAPACITY_EXCEEDED");
    }
    const instructionJson = canonicalWorkJson(parsedEffect);
    this.#assertEventCapacity(operation.workId, 3);
    this.#database.query(
      `UPDATE work_attempts
       SET state='dispatching',revision=revision+1,target_session_id=?,dispatch_mode=?,updated_at=?
       WHERE id=? AND state='claimed' AND fence=?`,
    ).run(operation.targetSessionId, operation.mode, now, attempt.id, attempt.fence);
    this.#database.query(
      `UPDATE work_task_states SET state='dispatching',revision=revision+1,updated_at=?
       WHERE task_id=? AND state='claimed'`,
    ).run(now, attempt.task_id);
    this.#database.query(
      `INSERT INTO work_prepared_effects(
         idempotency_key,work_id,effect_kind,subject_id,instruction_json,instruction_digest,
         daemon_generation,state,outcome_digest,outcome_json,prepared_at,finalized_at
       ) VALUES (?,?, 'attempt_dispatch',?,?,?,?, 'prepared',NULL,NULL,?,NULL)`,
    ).run(
      operation.idempotencyKey,
      operation.workId,
      attempt.id,
      instructionJson,
      digestText(instructionJson),
      this.#daemonGeneration,
      now,
    );
    const body = {
      type: "attempt.dispatch_requested" as const,
      attemptId: attempt.id,
      targetSessionId: operation.targetSessionId,
      mode: operation.mode,
    };
    this.#appendEvent(operation.workId, body.type, attempt.worker_session_id, body);
    const effectStatus = this.effectStatus(operation.idempotencyKey);
    if (effectStatus === null) throw new Error("WORK_EFFECT_MISSING");
    return workOperationResultSchema.parse({
      kind: operation.kind,
      workId: operation.workId,
      workRevision: this.#requireWork(operation.workId).revision,
      attempt: this.#attemptRecord(this.#requireAttempt(attempt.id, operation.workId)),
      effect: effectStatus,
    });
  }

  #createSubmission(
    attempt: AttemptRow,
    summary: string,
    result: unknown,
    evidence: readonly unknown[],
    now: number,
  ): SubmissionRow {
    const { task } = this.#requireTask(attempt.task_id, attempt.work_id);
    if (
      typeof result !== "object"
      || result === null
      || (result as { kind?: unknown }).kind !== task.result_kind
    ) throw new WorkStoreError("NOT_REVIEWABLE");
    if (evidence.length < task.min_evidence) throw new WorkStoreError("NOT_REVIEWABLE");
    const submissionId = createWorkSubmissionId();
    const resultJson = canonicalWorkJson(result);
    const evidenceJson = canonicalWorkJson(evidence);
    const contentDigest = digestJson({ evidence, result, summary });
    this.#database.query(
      `INSERT INTO work_submissions(
         id,work_id,task_id,attempt_id,worker_session_id,summary,result_json,evidence_json,
         content_digest,created_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      submissionId,
      attempt.work_id,
      attempt.task_id,
      attempt.id,
      attempt.worker_session_id,
      summary,
      resultJson,
      evidenceJson,
      contentDigest,
      now,
    );
    this.#database.query(
      `UPDATE work_attempts
       SET state='submitted',submission_id=?,revision=revision+1,updated_at=?
       WHERE id=? AND state IN ('running','recovery_required')`,
    ).run(submissionId, now, attempt.id);
    this.#database.query(
      `UPDATE work_task_states
       SET state='submitted',revision=revision+1,retry_not_before=NULL,updated_at=?
       WHERE task_id=?`,
    ).run(now, attempt.task_id);
    if (task.required_reviews === 0) {
      this.#database.query(
        `UPDATE work_attempts
         SET state='completed',revision=revision+1,updated_at=?,terminal_at=?
         WHERE id=? AND state='submitted'`,
      ).run(now, now, attempt.id);
      this.#database.query(
        `UPDATE work_task_states
         SET state='completed',accepted_submission_id=?,revision=revision+1,updated_at=?
         WHERE task_id=? AND state='submitted'`,
      ).run(submissionId, now, attempt.task_id);
    }
    return this.#database.query(
      "SELECT * FROM work_submissions WHERE id=?",
    ).get(submissionId) as SubmissionRow;
  }

  #report(operation: Extract<WorkOperation, { kind: "attempt.report" }>): WorkApplyResult {
    this.#requireActiveWork(operation.workId);
    const attempt = this.#requireAttempt(operation.attemptId, operation.workId);
    this.#assertFence(attempt, operation.fence);
    this.#assertAttemptOwner(attempt, operation.actorSessionId);
    this.#assertAttemptRevision(attempt, operation.expectedAttemptRevision);
    if (attempt.state !== "running") {
      if (attempt.state === "recovery_required") throw new WorkStoreError("ATTEMPT_RECOVERY_REQUIRED");
      throw new WorkStoreError("ATTEMPT_NOT_CLAIMABLE");
    }
    this.#assertEvidenceAuthority(
      operation.idempotencyKey,
      operation.workId,
      operation.report.evidence,
      attempt.task_id,
    );
    const now = this.#tick();
    const reportJson = canonicalWorkJson(operation.report);
    this.#database.query(
      `INSERT INTO work_attempt_reports(
         idempotency_key,work_id,attempt_id,kind,report_json,report_digest,created_at
       ) VALUES (?,?,?,?,?,?,?)`,
    ).run(
      operation.idempotencyKey,
      operation.workId,
      attempt.id,
      operation.report.kind,
      reportJson,
      digestText(reportJson),
      now,
    );
    let submission: SubmissionRow | null = null;
    let taskFailureReason:
      | "claim_window_elapsed"
      | "completion_deadline_elapsed"
      | "attempts_exhausted"
      | null = null;
    switch (operation.report.kind) {
      case "checkpoint":
        this.#database.query(
          "UPDATE work_attempts SET revision=revision+1,updated_at=? WHERE id=?",
        ).run(now, attempt.id);
        break;
      case "submit":
        submission = this.#createSubmission(
          attempt,
          operation.report.summary,
          operation.report.result,
          operation.report.evidence,
          now,
        );
        break;
      case "blocked":
        {
          const task = this.#requireTask(attempt.task_id, operation.workId);
          taskFailureReason = this.#retryFailureReason(task.task, task.state, now);
        this.#database.query(
          `UPDATE work_attempts
           SET state='blocked',revision=revision+1,updated_at=?,terminal_at=?
           WHERE id=? AND state='running'`,
        ).run(now, now, attempt.id);
        this.#database.query(
          `UPDATE work_task_states
           SET state=?,retry_not_before=?,revision=revision+1,updated_at=?
           WHERE task_id=?`,
        ).run(
          taskFailureReason === null ? "pending" : "failed",
          taskFailureReason === null ? operation.report.retryAt ?? null : null,
          now,
          attempt.task_id,
        );
        break;
        }
      case "failed": {
        const task = this.#requireTask(attempt.task_id, operation.workId);
        taskFailureReason = operation.report.retryable
          ? this.#retryFailureReason(task.task, task.state, now)
          : null;
        const retryable = operation.report.retryable && taskFailureReason === null;
        this.#database.query(
          `UPDATE work_attempts
           SET state='failed',revision=revision+1,updated_at=?,terminal_at=?
           WHERE id=? AND state='running'`,
        ).run(now, now, attempt.id);
        this.#database.query(
          `UPDATE work_task_states
           SET state=?,revision=revision+1,updated_at=? WHERE task_id=?`,
        ).run(retryable ? "pending" : "failed", now, attempt.task_id);
        break;
      }
      case "unknown":
        this.#database.query(
          `UPDATE work_attempts
           SET state='recovery_required',revision=revision+1,updated_at=?
           WHERE id=? AND state='running'`,
        ).run(now, attempt.id);
        this.#database.query(
          `UPDATE work_task_states
           SET state='recovery_required',revision=revision+1,updated_at=? WHERE task_id=?`,
        ).run(now, attempt.task_id);
        break;
    }
    const body = {
      type: "attempt.reported" as const,
      attemptId: attempt.id,
      reportKind: operation.report.kind,
      submissionId: submission?.id ?? null,
      reportDigest: digestJson(operation.report),
      evidenceCount: operation.report.evidence.length,
    };
    this.#appendEvent(operation.workId, body.type, attempt.worker_session_id, body);
    if (taskFailureReason !== null) {
      this.#appendTaskFailure(
        operation.workId,
        attempt.task_id,
        taskFailureReason,
        attempt.worker_session_id,
      );
    }
    return workOperationResultSchema.parse({
      kind: operation.kind,
      workId: operation.workId,
      workRevision: this.#requireWork(operation.workId).revision,
      attempt: this.#attemptRecord(this.#requireAttempt(attempt.id, operation.workId)),
      submission: submission === null ? null : this.#submissionRecord(submission),
    });
  }

  #review(operation: Extract<WorkOperation, { kind: "submission.review" }>): WorkApplyResult {
    this.#requireActiveWork(operation.workId);
    this.#requireMember(operation.workId, operation.reviewerSessionId);
    this.#requireSessionAccountAuthority(operation.reviewerSessionId, "ROUTE_MISMATCH");
    const submission = this.#database.query(
      "SELECT * FROM work_submissions WHERE id=? AND work_id=?",
    ).get(operation.submissionId, operation.workId) as SubmissionRow | null;
    if (submission === null) throw new WorkStoreError("NOT_REVIEWABLE");
    if (submission.worker_session_id === operation.reviewerSessionId) {
      throw new WorkStoreError("SELF_REVIEW");
    }
    const submissionBefore = this.#submissionRecord(submission);
    if (
      submissionBefore.revision !== operation.expectedSubmissionRevision
      || submissionBefore.contentDigest !== operation.expectedContentDigest
    ) throw new WorkStoreError("REVISION_CONFLICT");
    if (submissionBefore.status !== "pending_review") {
      throw new WorkStoreError("NOT_REVIEWABLE");
    }
    const duplicateReview = this.#database.query(
      "SELECT 1 AS present FROM work_reviews WHERE submission_id=? AND reviewer_session_id=?",
    ).get(submission.id, operation.reviewerSessionId) as { present: number } | null;
    if (duplicateReview !== null) throw new WorkStoreError("REVISION_CONFLICT");
    this.#assertEvidenceAuthority(
      operation.idempotencyKey,
      operation.workId,
      operation.review.evidence,
      submission.task_id,
    );
    const now = this.#tick();
    const reviewId = createWorkReviewId();
    const reviewJson = canonicalWorkJson(operation.review);
    this.#database.query(
      `INSERT INTO work_reviews(
         id,work_id,submission_id,reviewer_session_id,decision,review_json,review_digest,created_at
       ) VALUES (?,?,?,?,?,?,?,?)`,
    ).run(
      reviewId,
      operation.workId,
      submission.id,
      operation.reviewerSessionId,
      operation.review.decision,
      reviewJson,
      digestText(reviewJson),
      now,
    );
    const taskDetail = this.#requireTask(submission.task_id, operation.workId);
    const task = taskDetail.task;
    if (taskDetail.state.state !== "submitted") throw new WorkStoreError("NOT_REVIEWABLE");
    let taskFailureReason:
      | "claim_window_elapsed"
      | "completion_deadline_elapsed"
      | "attempts_exhausted"
      | null = null;
    if (operation.review.decision === "accept") {
      const accepted = this.#database.query(
        "SELECT COUNT(*) AS count FROM work_reviews WHERE submission_id=? AND decision='accept'",
      ).get(submission.id) as { count: number } | null;
      if ((accepted?.count ?? 0) >= task.required_reviews) {
        this.#database.query(
          `UPDATE work_attempts
           SET state='completed',revision=revision+1,updated_at=?,terminal_at=?
           WHERE id=? AND state='submitted'`,
        ).run(now, now, submission.attempt_id);
        this.#database.query(
          `UPDATE work_task_states
           SET state='completed',accepted_submission_id=?,revision=revision+1,updated_at=?
           WHERE task_id=? AND state='submitted'`,
        ).run(submission.id, now, submission.task_id);
      }
    } else if (operation.review.decision === "revise") {
      taskFailureReason = this.#retryFailureReason(task, taskDetail.state, now);
      this.#database.query(
        `UPDATE work_attempts
         SET state='failed',revision=revision+1,updated_at=?,terminal_at=?
         WHERE id=? AND state='submitted'`,
      ).run(now, now, submission.attempt_id);
      this.#database.query(
        `UPDATE work_task_states
         SET state=?,revision=revision+1,accepted_submission_id=NULL,updated_at=?
         WHERE task_id=? AND state='submitted'`,
      ).run(taskFailureReason === null ? "pending" : "failed", now, submission.task_id);
    } else {
      this.#database.query(
        `UPDATE work_attempts
         SET state='failed',revision=revision+1,updated_at=?,terminal_at=?
         WHERE id=? AND state='submitted'`,
      ).run(now, now, submission.attempt_id);
      this.#database.query(
        `UPDATE work_task_states
         SET state='failed',revision=revision+1,accepted_submission_id=NULL,updated_at=?
         WHERE task_id=? AND state='submitted'`,
      ).run(now, submission.task_id);
    }
    const body = {
      type: "submission.reviewed" as const,
      submissionId: submission.id,
      reviewId,
      reviewerSessionId: operation.reviewerSessionId,
      decision: operation.review.decision,
      reviewDigest: digestJson(operation.review),
      evidenceCount: operation.review.evidence.length,
    };
    this.#appendEvent(operation.workId, body.type, operation.reviewerSessionId, body);
    if (taskFailureReason !== null) {
      this.#appendTaskFailure(
        operation.workId,
        submission.task_id,
        taskFailureReason,
        operation.reviewerSessionId,
      );
    }
    const review = this.#database.query(
      "SELECT * FROM work_reviews WHERE id=?",
    ).get(reviewId) as ReviewRow;
    return workOperationResultSchema.parse({
      kind: operation.kind,
      workId: operation.workId,
      workRevision: this.#requireWork(operation.workId).revision,
      submission: this.#submissionRecord(submission),
      review: this.#reviewRecord(review),
    });
  }

  #sessionOwnsRelatedTask(
    workId: string,
    sessionId: string,
    taskId: string,
  ): boolean {
    const owned = this.#database.query(
      `WITH target AS (
         SELECT id,parent_task_id FROM work_tasks WHERE id=? AND work_id=?
       ), related AS (
         SELECT t.id
         FROM work_tasks AS t,target
         WHERE t.work_id=? AND (
           t.id=target.id
           OR t.id=target.parent_task_id
           OR t.parent_task_id=target.id
           OR (target.parent_task_id IS NOT NULL AND t.parent_task_id=target.parent_task_id)
         )
       )
       SELECT a.*
       FROM work_attempts AS a
       JOIN related AS r ON r.id=a.task_id
       WHERE a.work_id=? AND a.worker_session_id=?
         AND NOT EXISTS (
           SELECT 1 FROM work_attempts AS newer
           WHERE newer.task_id=a.task_id
             AND newer.worker_session_id=a.worker_session_id
             AND (newer.created_at>a.created_at OR (newer.created_at=a.created_at AND newer.id>a.id))
         )
       LIMIT 1`,
    ).get(taskId, workId, workId, workId, sessionId) as AttemptRow | null;
    if (owned !== null) this.#assertCanonicalAttempt(owned);
    return owned !== null;
  }

  #assertSignalGovernance(
    workId: string,
    senderSessionId: string,
    targetSessionId: string,
    taskId?: string,
    replyToSignalId?: string,
  ): void {
    const work = this.#requireWork(workId);
    if (taskId === undefined) {
      if (
        senderSessionId !== work.coordinator_session_id
        && targetSessionId !== work.coordinator_session_id
      ) throw new WorkStoreError("ATTEMPT_NOT_OWNER");
    } else {
      this.#requireTask(taskId, workId);
      const senderOwns = this.#sessionOwnsRelatedTask(workId, senderSessionId, taskId);
      const targetOwns = this.#sessionOwnsRelatedTask(workId, targetSessionId, taskId);
      if (senderSessionId === work.coordinator_session_id) {
        if (!targetOwns) throw new WorkStoreError("ATTEMPT_NOT_OWNER");
      } else if (targetSessionId === work.coordinator_session_id) {
        if (!senderOwns) throw new WorkStoreError("ATTEMPT_NOT_OWNER");
      } else if (!senderOwns || !targetOwns) {
        throw new WorkStoreError("ATTEMPT_NOT_OWNER");
      }
    }
    if (replyToSignalId !== undefined) {
      const reply = this.#database.query(
        `SELECT from_session_id,to_session_id,task_id FROM work_signals
         WHERE id=? AND work_id=?`,
      ).get(replyToSignalId, workId) as {
        from_session_id: string;
        to_session_id: string;
        task_id: string | null;
      } | null;
      if (
        reply === null
        || reply.from_session_id !== targetSessionId
        || reply.to_session_id !== senderSessionId
        || reply.task_id !== (taskId ?? null)
      ) throw new WorkStoreError("SIGNAL_NOT_FOUND");
    }
  }

  #prepareSignal(operation: Extract<WorkOperation, { kind: "signal.send" }>): WorkApplyResult {
    this.#requireActiveWork(operation.workId);
    this.#requireMember(operation.workId, operation.senderSessionId);
    this.#requireMember(operation.workId, operation.targetSessionId);
    this.#requireSessionAccountAuthority(operation.senderSessionId, "ROUTE_MISMATCH");
    this.#assertSignalGovernance(
      operation.workId,
      operation.senderSessionId,
      operation.targetSessionId,
      operation.taskId,
      operation.replyToSignalId,
    );
    const targetAuthority = this.#database.query(
      `SELECT p.process_generation AS account_generation
       FROM sessions AS s
       JOIN profiles AS p ON p.id=s.profile_id
       WHERE s.id=? AND ${currentWorkSessionAuthorityExistsSql("s.id")}`,
    ).get(operation.targetSessionId) as { account_generation: number } | null;
    if (
      targetAuthority === null
      || !Number.isSafeInteger(targetAuthority.account_generation)
      || targetAuthority.account_generation < 0
    ) throw new WorkStoreError("ROUTE_MISMATCH");
    const accountGeneration = targetAuthority.account_generation;
    const signalId = createWorkSignalId();
    const now = this.#tick();
    this.#database.query(
      `INSERT INTO work_signals(
         id,work_id,from_session_id,to_session_id,target_account_generation,
         task_id,reply_to_signal_id,mode,body,created_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      signalId,
      operation.workId,
      operation.senderSessionId,
      operation.targetSessionId,
      accountGeneration,
      operation.taskId ?? null,
      operation.replyToSignalId ?? null,
      operation.mode,
      operation.body,
      now,
    );
    // The released v1 generation stays a compatibility shadow in the signal
    // and instruction. Only this independently frozen tuple admits execution.
    const captured = this.#database.query(`SELECT provider_account_id,profile_id,provider,
      binding_generation,process_generation,authority_revision
      FROM session_provider_authorities WHERE session_id=?`).get(operation.targetSessionId);
    const parsedAuthority = z.object({
      provider_account_id: z.string(), profile_id: z.string(), provider: z.enum(["codex", "claude", "devin"]),
      binding_generation: z.number().int().positive().safe(), process_generation: z.number().int().nonnegative().safe(),
      authority_revision: z.number().int().positive().safe(),
    }).strict().parse(captured);
    const frozen = {
      signal_id: signalId,
      work_id: operation.workId,
      target_session_id: operation.targetSessionId,
      provider_account_id: parsedAuthority.provider_account_id,
      profile_id: parsedAuthority.profile_id,
      provider: parsedAuthority.provider,
      binding_generation: parsedAuthority.binding_generation,
      process_generation: parsedAuthority.process_generation,
      session_authority_revision: parsedAuthority.authority_revision,
      provenance: "signal_prepare" as const,
      recorded_at: now,
    };
    this.#database.query(`INSERT INTO work_signal_provider_authorities(
      signal_id,work_id,target_session_id,provider_account_id,profile_id,provider,binding_generation,
      process_generation,session_authority_revision,authority_digest,provenance,recorded_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      frozen.signal_id,frozen.work_id,frozen.target_session_id,frozen.provider_account_id,frozen.profile_id,
      frozen.provider,frozen.binding_generation,frozen.process_generation,frozen.session_authority_revision,
      signalProviderAuthorityDigest(frozen),frozen.provenance,frozen.recorded_at,
    );
    const effect: WorkSignalInstruction = {
      kind: "signal",
      workId: operation.workId,
      nestedMutationKey: deriveNestedMutationKey(operation.idempotencyKey),
      signalId,
      targetMemberCapability: this.#capability({
        scope: "member",
        workId: operation.workId,
        sessionId: operation.targetSessionId,
      }),
      targetSessionId: operation.targetSessionId,
      accountGeneration,
      mode: operation.mode,
      body: operation.body,
    };
    const instructionJson = canonicalWorkJson(workPreparedEffectSchema.parse(effect));
    this.#assertEventCapacity(operation.workId, 3);
    this.#database.query(
      `INSERT INTO work_prepared_effects(
         idempotency_key,work_id,effect_kind,subject_id,instruction_json,instruction_digest,
         daemon_generation,state,outcome_digest,outcome_json,prepared_at,finalized_at
       ) VALUES (?,?,'signal_send',?,?,?,?, 'prepared',NULL,NULL,?,NULL)`,
    ).run(
      operation.idempotencyKey,
      operation.workId,
      signalId,
      instructionJson,
      digestText(instructionJson),
      this.#daemonGeneration,
      now,
    );
    const signal = this.#signalRecord(signalId);
    const body = {
      type: "signal.delivery_requested" as const,
      signalId: signal.id,
      senderSessionId: signal.senderSessionId,
      targetSessionId: signal.targetSessionId,
      taskId: signal.taskId,
      replyToSignalId: signal.replyToSignalId,
      mode: signal.mode,
      bodyDigest: digestJson(signal.body),
    };
    this.#appendEvent(operation.workId, body.type, operation.senderSessionId, body);
    const effectStatus = this.effectStatus(operation.idempotencyKey);
    if (effectStatus === null) throw new Error("WORK_EFFECT_MISSING");
    return workOperationResultSchema.parse({
      kind: operation.kind,
      workId: operation.workId,
      workRevision: this.#requireWork(operation.workId).revision,
      signal,
      effect: effectStatus,
    });
  }

  #ackSignal(operation: Extract<WorkOperation, { kind: "signal.ack" }>): WorkApplyResult {
    this.#requireWork(operation.workId);
    this.#requireMember(operation.workId, operation.actorSessionId);
    const signal = this.#database.query(
      `SELECT id,to_session_id,target_account_generation
       FROM work_signals WHERE id=? AND work_id=?`,
    ).get(operation.signalId, operation.workId) as {
      id: string;
      target_account_generation: number;
      to_session_id: string;
    } | null;
    if (signal === null) throw new WorkStoreError("SIGNAL_NOT_FOUND");
    if (signal.to_session_id !== operation.actorSessionId) {
      throw new WorkStoreError("MEMBER_NOT_FOUND");
    }
    this.#requireSessionAccountAuthority(
      operation.actorSessionId,
      "ROUTE_MISMATCH",
      signal.target_account_generation,
    );
    const signalBefore = this.#signalRecord(signal.id);
    if (signalBefore.revision !== operation.expectedSignalRevision) {
      throw new WorkStoreError("REVISION_CONFLICT");
    }
    const duplicate = this.#database.query(
      "SELECT 1 AS present FROM work_signal_receipts WHERE signal_id=? AND kind='ack'",
    ).get(signal.id) as { present: number } | null;
    if (duplicate !== null) throw new WorkStoreError("REVISION_CONFLICT");
    const now = this.#tick();
    const sequence = this.#nextReceiptSequence(signal.id);
    this.#database.query(
      `INSERT INTO work_signal_receipts(
         signal_id,sequence,kind,actor_session_id,detail_code,recorded_at
       ) VALUES (?,?,'ack',?,NULL,?)`,
    ).run(signal.id, sequence, operation.actorSessionId, now);
    const body = {
      type: "signal.acknowledged" as const,
      signalId: signal.id,
      actorSessionId: operation.actorSessionId,
    };
    this.#appendEvent(operation.workId, body.type, operation.actorSessionId, body);
    return workOperationResultSchema.parse({
      kind: operation.kind,
      workId: operation.workId,
      workRevision: this.#requireWork(operation.workId).revision,
      signal: this.#signalRecord(signal.id),
    });
  }

  #nextReceiptSequence(signalId: string): number {
    const row = this.#database.query(
      "SELECT COALESCE(MAX(sequence),0)+1 AS sequence FROM work_signal_receipts WHERE signal_id=?",
    ).get(signalId) as { sequence: number } | null;
    if (!Number.isSafeInteger(row?.sequence) || (row?.sequence ?? 0) < 1) {
      throw new Error("WORK_SIGNAL_RECEIPT_SEQUENCE_INVALID");
    }
    return row?.sequence ?? 1;
  }

  #tryFinalizePendingWork(workId: string): boolean {
    const work = this.#requireWork(workId);
    if (work.state !== "cancel_pending" && work.state !== "fail_pending") return false;
    const uncertain = this.#database.query(
      `SELECT * FROM work_attempts
       WHERE work_id=? AND state IN ('dispatching','running','recovery_required') LIMIT 1`,
    ).get(workId) as AttemptRow | null;
    if (uncertain !== null) this.#assertCanonicalAttempt(uncertain);
    if (uncertain !== null) return false;
    const request = this.#database.query(
      `SELECT kind,actor_session_id,summary,evidence_json,request_digest
       FROM work_terminal_requests WHERE work_id=?`,
    ).get(workId) as {
      kind: "work.fail" | "work.cancel";
      actor_session_id: string;
      summary: string;
      evidence_json: string;
      request_digest: string;
    } | null;
    if (request === null) throw new Error("WORK_TERMINAL_REQUEST_MISSING");
    const now = this.#tick();
    const cancelling = work.state === "cancel_pending";
    const attempts = this.#database.query(
      `SELECT * FROM work_attempts
       WHERE work_id=? AND state IN ('claimed','submitted') ORDER BY created_at,id`,
    ).all(workId) as AttemptRow[];
    for (const attempt of attempts) {
      this.#assertCanonicalAttempt(attempt);
      this.#database.query(
        `UPDATE work_attempts SET state=?,revision=revision+1,updated_at=?,terminal_at=?
         WHERE id=? AND state=?`,
      ).run(cancelling ? "cancelled" : "failed", now, now, attempt.id, attempt.state);
    }
    const taskRows = this.#database.query(
      `SELECT task_id,state FROM work_task_states WHERE work_id=? ORDER BY task_id`,
    ).all(workId) as Array<{ task_id: string; state: TaskState }>;
    for (const task of taskRows) {
      this.#canonicalTaskIdentity(task.task_id, workId);
      if (task.state === "completed") continue;
      if (cancelling && (task.state === "failed" || task.state === "cancelled")) continue;
      if (!cancelling && task.state === "failed") continue;
      this.#database.query(
        `UPDATE work_task_states
         SET state=?,revision=revision+1,accepted_submission_id=NULL,updated_at=?
         WHERE task_id=? AND state=?`,
      ).run(cancelling ? "cancelled" : "failed", now, task.task_id, task.state);
    }
    const terminalState = cancelling ? "cancelled" : "failed";
    const changed = this.#database.query(
      `UPDATE works SET state=?,updated_at=? WHERE id=? AND state=?`,
    ).run(terminalState, now, workId, work.state);
    if (changed.changes !== 1) throw new WorkStoreError("REVISION_CONFLICT");
    const evidence = parseStoredJson(request.evidence_json) as WorkEvidence[];
    const body = cancelling
      ? {
          type: "work.cancelled" as const,
          requestDigest: request.request_digest,
          evidenceCount: evidence.length,
        }
      : {
          type: "work.failed" as const,
          requestDigest: request.request_digest,
          evidenceCount: evidence.length,
        };
    const settled = this.#database.query(
      `UPDATE work_terminal_requests SET state='settled',settled_at=?
       WHERE work_id=? AND state='requested' AND settled_at IS NULL`,
    ).run(now, workId);
    if (settled.changes !== 1) throw new WorkStoreError("REVISION_CONFLICT");
    this.#appendEvent(
      workId,
      body.type,
      request.actor_session_id,
      body,
      attempts.map((attempt) => attempt.id),
    );
    return true;
  }

  #discardedRecordCounts(workId: string): WorkReleaseTombstone["discardedRecordCounts"] {
    const count = (table: string, where = "work_id=?"): number => {
      const row = this.#database.query(
        `SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`,
      ).get(workId) as { count: number } | null;
      return row?.count ?? 0;
    };
    const receipts = (this.#database.query(
      `SELECT COUNT(*) AS count FROM work_signal_receipts AS r
       JOIN work_signals AS s ON s.id=r.signal_id WHERE s.work_id=?`,
    ).get(workId) as { count: number } | null)?.count ?? 0;
    const nestedResolutions = (this.#database.query(
      `SELECT COUNT(*) AS count FROM work_nested_effect_settlements AS n
       JOIN work_prepared_effects AS e ON e.idempotency_key=n.effect_idempotency_key
       WHERE e.work_id=?`,
    ).get(workId) as { count: number } | null)?.count ?? 0;
    return {
      routes: count("work_routes"),
      members: count("work_members"),
      tasks: count("work_tasks"),
      dependencies: count("work_task_dependencies"),
      attempts: count("work_attempts"),
      reports: count("work_attempt_reports"),
      submissions: count("work_submissions"),
      reviews: count("work_reviews"),
      signals: count("work_signals"),
      receipts,
      events: count("work_events"),
      intents: count("work_idempotency_intents"),
      effects: count("work_prepared_effects"),
      unresolvedSignalEffects: (this.#database.query(
        `SELECT COUNT(*) AS count FROM work_prepared_effects
         WHERE work_id=? AND effect_kind='signal_send'
           AND state IN ('prepared','effect_started','unknown')`,
      ).get(workId) as { count: number } | null)?.count ?? 0,
      effectResolutions: count("work_effect_resolutions") + nestedResolutions,
      historyIndex: count("work_task_history_index"),
      historyVersions: count("work_task_history_versions"),
    };
  }

  #releaseWork(
    operation: Extract<WorkOperation, { kind: "work.release" }>,
    releaseRequestDigest: string,
  ): WorkApplyResult {
    const work = this.#requireWork(operation.workId);
    if (!["completed", "failed", "cancelled"].includes(work.state)) {
      throw new WorkStoreError("WORK_NOT_ACTIVE");
    }
    this.#requireMember(operation.workId, operation.actorSessionId);
    this.#assertCoordinator(operation.workId, operation.actorSessionId);
    const terminal = this.#database.query(
      `SELECT kind,state,request_digest FROM work_terminal_requests WHERE work_id=?`,
    ).get(operation.workId) as {
      kind: "work.complete" | "work.fail" | "work.cancel";
      state: "requested" | "settled";
      request_digest: string;
    } | null;
    if (terminal === null || terminal.state !== "settled") {
      throw new WorkStoreError("WORK_NOT_ACTIVE");
    }
    const unresolved = this.#database.query(
      `SELECT 1 AS present FROM work_prepared_effects
       WHERE work_id=? AND effect_kind='attempt_dispatch'
         AND state IN ('prepared','effect_started','unknown') LIMIT 1`,
    ).get(operation.workId) as { present: number } | null;
    if (unresolved !== null) throw new WorkStoreError("ATTEMPT_RECOVERY_REQUIRED");
    this.#verifyWorkEventHead(work);
    if (work.head_hash === null || work.revision < 1) throw new Error("WORK_STREAM_HEAD_MISSING");

    const now = this.#tick();
    const discardedRecordCounts = this.#discardedRecordCounts(operation.workId);
    const discardedRecordsDigest = digestJson({
      discardedRecordCounts,
      finalHeadHash: work.head_hash,
      finalRevision: work.revision,
      terminalRequestDigest: terminal.request_digest,
      workId: work.id,
    });
    const tombstone = workReleaseTombstoneSchema.parse({
      version: 1,
      workId: work.id,
      clientRefDigest: digestJson(work.client_ref),
      coordinatorSessionId: work.coordinator_session_id,
      terminalKind: terminal.kind,
      terminalRequestDigest: terminal.request_digest,
      releaseRequestDigest,
      finalRevision: work.revision,
      finalHeadHash: work.head_hash,
      discardedRecordCounts,
      discardedRecordsDigest,
      releasedAt: now,
      retentionUpperBoundAt: now + WORK_TOMBSTONE_MAX_AGE_MS,
      priorOperationReplayGuaranteesEnded: true,
      releaseReplayPolicy: "retained_tombstone_only",
    });
    const result = workOperationResultSchema.parse({
      kind: operation.kind,
      workId: work.id,
      workRevision: work.revision,
      tombstone,
    });
    const resultJson = canonicalWorkJson(result);
    const discardedCountsJson = canonicalWorkJson(discardedRecordCounts);
    const row: ReleaseTombstoneRow = {
      work_id: work.id,
      release_idempotency_key: operation.idempotencyKey,
      release_request_digest: releaseRequestDigest,
      client_ref_digest: tombstone.clientRefDigest,
      coordinator_session_id: work.coordinator_session_id,
      terminal_kind: terminal.kind,
      terminal_request_digest: terminal.request_digest,
      final_revision: work.revision,
      final_head_hash: work.head_hash,
      discarded_counts_json: discardedCountsJson,
      discarded_records_digest: discardedRecordsDigest,
      released_at: now,
      retention_upper_bound_at: tombstone.retentionUpperBoundAt,
      result_json: resultJson,
    };
    const rowBytes = this.#releaseTombstoneBytes(row);
    this.#pruneReleaseTombstones(now, 1, rowBytes);
    this.#database.query(
      `INSERT INTO work_release_tombstones(
         work_id,release_idempotency_key,release_request_digest,client_ref_digest,
         coordinator_session_id,terminal_kind,terminal_request_digest,final_revision,
         final_head_hash,discarded_counts_json,discarded_records_digest,released_at,
         retention_upper_bound_at,result_json
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      row.work_id,
      row.release_idempotency_key,
      row.release_request_digest,
      row.client_ref_digest,
      row.coordinator_session_id,
      row.terminal_kind,
      row.terminal_request_digest,
      row.final_revision,
      row.final_head_hash,
      row.discarded_counts_json,
      row.discarded_records_digest,
      row.released_at,
      row.retention_upper_bound_at,
      row.result_json,
    );
    this.#database.query(
      `INSERT INTO work_purge_authority(singleton,work_id,idempotency_key,created_at)
       VALUES (1,?,?,?)`,
    ).run(work.id, operation.idempotencyKey, now);
    this.#database.exec("PRAGMA defer_foreign_keys=ON;");
    // Nested settlement rows bind purge authority through their immutable
    // parent effect. Delete them before the works cascade can remove that
    // parent and make the guarded child deletion unverifiable.
    this.#database.query(
      `DELETE FROM work_nested_effect_settlements
       WHERE effect_idempotency_key IN (
         SELECT idempotency_key FROM work_prepared_effects WHERE work_id=?
       )`,
    ).run(work.id);
    // Keep the parent signal available while the immutable receipt trigger
    // verifies that this destructive delete is covered by the exact work
    // purge authority. SQLite may otherwise cascade sibling tables in an
    // order that removes the signal before its receipts.
    this.#database.query(
      `DELETE FROM work_signal_receipts
       WHERE signal_id IN (SELECT id FROM work_signals WHERE work_id=?)`,
    ).run(work.id);
    const deleted = this.#database.query(
      "DELETE FROM works WHERE id=? RETURNING id",
    ).get(work.id) as { id: string } | null;
    if (deleted?.id !== work.id) throw new WorkStoreError("REVISION_CONFLICT");
    this.#database.query(
      "DELETE FROM work_purge_authority WHERE singleton=1 AND work_id=? AND idempotency_key=?",
    ).run(work.id, operation.idempotencyKey);
    return workOperationResultSchema.parse(parseStoredJson(resultJson));
  }

  #terminalWork(
    operation: Extract<WorkOperation, { kind: "work.complete" | "work.fail" | "work.cancel" }>,
  ): WorkApplyResult {
    const work = this.#requireWork(operation.workId);
    if (work.state !== "active") throw new WorkStoreError("WORK_NOT_ACTIVE");
    this.#requireMember(operation.workId, operation.actorSessionId);
    this.#assertCoordinator(operation.workId, operation.actorSessionId);
    this.#assertEvidenceAuthority(
      operation.idempotencyKey,
      operation.workId,
      operation.evidence,
    );
    const now = this.#tick();
    const terminalRequestDigest = operation.kind === "work.complete"
      ? digestJson({
          summary: operation.summary,
          evidence: operation.evidence,
          result: operation.result ?? null,
        })
      : digestJson({ summary: operation.summary, evidence: operation.evidence });
    this.#database.query(
      `INSERT INTO work_terminal_requests(
         work_id,idempotency_key,kind,state,actor_session_id,summary,result_json,
         evidence_json,request_digest,requested_at,settled_at
       ) VALUES (?,? ,?,'requested',?,?,?,?,?,?,NULL)`,
    ).run(
      operation.workId,
      operation.idempotencyKey,
      operation.kind,
      operation.actorSessionId,
      operation.summary,
      operation.kind === "work.complete" && operation.result !== undefined
        ? canonicalWorkJson(operation.result)
        : null,
      canonicalWorkJson(operation.evidence),
      terminalRequestDigest,
      now,
    );
    if (operation.kind === "work.complete") {
      const unresolvedEffect = this.#database.query(
        `SELECT 1 AS present FROM work_prepared_effects
         WHERE work_id=? AND effect_kind='attempt_dispatch'
           AND state IN ('prepared','effect_started','unknown') LIMIT 1`,
      ).get(operation.workId) as { present: number } | null;
      if (unresolvedEffect !== null) throw new WorkStoreError("ATTEMPT_RECOVERY_REQUIRED");
      const incomplete = this.#database.query(
        "SELECT 1 AS present FROM work_task_states WHERE work_id=? AND state!='completed' LIMIT 1",
      ).get(operation.workId) as { present: number } | null;
      if (incomplete !== null) throw new WorkStoreError("DEPENDENCY_INCOMPLETE");
      this.#database.query(
        "UPDATE works SET state='completed',updated_at=? WHERE id=? AND state='active'",
      ).run(now, operation.workId);
      const body = {
        type: "work.completed" as const,
        requestDigest: terminalRequestDigest,
        evidenceCount: operation.evidence.length,
        resultKind: operation.result?.kind ?? null,
      };
      this.#appendEvent(operation.workId, body.type, operation.actorSessionId, body);
    } else if (operation.kind === "work.fail") {
      let uncertain = false;
      const affectedAttemptIds: string[] = [];
      const tasks = this.#database.query(
        `SELECT task_id,state FROM work_task_states
         WHERE work_id=? ORDER BY (
           SELECT depth FROM work_tasks WHERE id=work_task_states.task_id
         ) DESC,task_id`,
      ).all(operation.workId) as Array<{ task_id: string; state: TaskState }>;
      for (const task of tasks) {
        this.#canonicalTaskIdentity(task.task_id, operation.workId);
        if (task.state === "completed" || task.state === "failed") continue;
        const attempt = this.#database.query(
          `SELECT * FROM work_attempts WHERE task_id=?
           AND state IN ('claimed','dispatching','running','submitted','recovery_required')
           ORDER BY created_at DESC,id DESC LIMIT 1`,
        ).get(task.task_id) as AttemptRow | null;
        if (attempt !== null) this.#assertCanonicalAttempt(attempt);
        if (
          attempt !== null
          && ["dispatching", "running", "recovery_required"].includes(attempt.state)
        ) {
          uncertain = true;
          if (attempt.state !== "recovery_required") {
            this.#database.query(
              `UPDATE work_attempts SET state='recovery_required',revision=revision+1,updated_at=?
               WHERE id=?`,
            ).run(now, attempt.id);
            const recovery = {
              type: "attempt.recovery_required" as const,
              attemptId: attempt.id,
              fence: attempt.fence,
              reason: "effect_unknown" as const,
            };
            this.#appendEvent(operation.workId, recovery.type, operation.actorSessionId, recovery);
          }
          if (task.state !== "recovery_required") {
            this.#database.query(
              `UPDATE work_task_states
               SET state='recovery_required',revision=revision+1,updated_at=? WHERE task_id=?`,
            ).run(now, task.task_id);
          }
          continue;
        }
        if (attempt !== null && ["claimed", "submitted"].includes(attempt.state)) {
          this.#database.query(
            `UPDATE work_attempts
             SET state='failed',revision=revision+1,updated_at=?,terminal_at=? WHERE id=?`,
          ).run(now, now, attempt.id);
          affectedAttemptIds.push(attempt.id);
        }
        this.#database.query(
          `UPDATE work_task_states
           SET state='failed',revision=revision+1,accepted_submission_id=NULL,updated_at=?
           WHERE task_id=?`,
        ).run(now, task.task_id);
      }
      const nextState = uncertain ? "fail_pending" : "failed";
      this.#database.query(
        `UPDATE works SET state=?,updated_at=? WHERE id=? AND state='active'`,
      ).run(nextState, now, operation.workId);
      const body = uncertain
        ? {
            type: "work.failure_requested" as const,
            requestDigest: terminalRequestDigest,
            evidenceCount: operation.evidence.length,
          }
        : {
            type: "work.failed" as const,
            requestDigest: terminalRequestDigest,
            evidenceCount: operation.evidence.length,
          };
      this.#appendEvent(
        operation.workId,
        body.type,
        operation.actorSessionId,
        body,
        affectedAttemptIds,
      );
    } else {
      let uncertain = false;
      const affectedAttemptIds: string[] = [];
      const tasks = this.#database.query(
        `SELECT task_id,state FROM work_task_states
         WHERE work_id=? ORDER BY (
           SELECT depth FROM work_tasks WHERE id=work_task_states.task_id
         ) DESC,task_id`,
      ).all(operation.workId) as Array<{ task_id: string; state: TaskState }>;
      for (const task of tasks) {
        this.#canonicalTaskIdentity(task.task_id, operation.workId);
        if (["completed", "failed", "cancelled"].includes(task.state)) continue;
        const attempt = this.#database.query(
          `SELECT * FROM work_attempts WHERE task_id=?
           AND state IN ('claimed','dispatching','running','submitted','recovery_required')
           ORDER BY created_at DESC,id DESC LIMIT 1`,
        ).get(task.task_id) as AttemptRow | null;
        if (attempt !== null) this.#assertCanonicalAttempt(attempt);
        if (
          attempt !== null
          && ["dispatching", "running", "recovery_required"].includes(attempt.state)
        ) {
          uncertain = true;
          if (attempt.state !== "recovery_required") {
            this.#database.query(
              `UPDATE work_attempts SET state='recovery_required',revision=revision+1,updated_at=?
               WHERE id=?`,
            ).run(now, attempt.id);
            const recovery = {
              type: "attempt.recovery_required" as const,
              attemptId: attempt.id,
              fence: attempt.fence,
              reason: "effect_unknown" as const,
            };
            this.#appendEvent(operation.workId, recovery.type, operation.actorSessionId, recovery);
          }
          if (task.state !== "recovery_required") {
            this.#database.query(
              `UPDATE work_task_states
               SET state='recovery_required',revision=revision+1,updated_at=? WHERE task_id=?`,
            ).run(now, task.task_id);
          }
          continue;
        }
        if (attempt !== null && ["claimed", "submitted"].includes(attempt.state)) {
          this.#database.query(
            `UPDATE work_attempts
             SET state='cancelled',revision=revision+1,updated_at=?,terminal_at=? WHERE id=?`,
          ).run(now, now, attempt.id);
          affectedAttemptIds.push(attempt.id);
        }
        this.#database.query(
          `UPDATE work_task_states
           SET state='cancelled',revision=revision+1,updated_at=? WHERE task_id=?`,
        ).run(now, task.task_id);
      }
      const state = uncertain ? "cancel_pending" : "cancelled";
      this.#database.query(
        "UPDATE works SET state=?,updated_at=? WHERE id=? AND state='active'",
      ).run(state, now, operation.workId);
      const body = uncertain
        ? {
            type: "work.cancellation_requested" as const,
            requestDigest: terminalRequestDigest,
            evidenceCount: operation.evidence.length,
          }
        : {
            type: "work.cancelled" as const,
            requestDigest: terminalRequestDigest,
            evidenceCount: operation.evidence.length,
          };
      this.#appendEvent(
        operation.workId,
        body.type,
        operation.actorSessionId,
        body,
        affectedAttemptIds,
      );
    }
    const terminal = this.#requireWork(operation.workId);
    if (["completed", "failed", "cancelled"].includes(terminal.state)) {
      const settled = this.#database.query(
        `UPDATE work_terminal_requests SET state='settled',settled_at=?
         WHERE work_id=? AND state='requested' AND settled_at IS NULL`,
      ).run(now, operation.workId);
      if (settled.changes !== 1) throw new WorkStoreError("REVISION_CONFLICT");
    }
    return workOperationResultSchema.parse({
      kind: operation.kind,
      workId: operation.workId,
      workRevision: this.#requireWork(operation.workId).revision,
      work: this.#workRecord(operation.workId, now),
    });
  }

  #resolveDispatchEffect(
    attempt: AttemptRow,
    resolution: "proven_applied" | "no_effect" | "failed",
    evidence: readonly WorkEvidence[],
    now: number,
    verifiedAppliedReceipt?: WorkNestedEffectReceipt,
  ): void {
    const effect = this.#database.query(
      `SELECT * FROM work_prepared_effects
       WHERE work_id=? AND effect_kind='attempt_dispatch' AND subject_id=?`,
    ).get(attempt.work_id, attempt.id) as PreparedEffectRow | null;
    if (effect === null) throw new WorkStoreError("ATTEMPT_RECOVERY_REQUIRED");
    const instruction = workPreparedEffectSchema.parse(parseStoredJson(effect.instruction_json));
    if (
      instruction.kind !== "dispatch"
      || instruction.attemptId !== attempt.id
      || instruction.workId !== attempt.work_id
      || digestText(effect.instruction_json) !== effect.instruction_digest
    ) throw new Error("WORK_EFFECT_INSTRUCTION_CORRUPT");
    this.#assertLegacyPreparedInstruction(effect, instruction);
    const projectedState = resolution === "proven_applied" ? "accepted" : "failed";
    if (
      (effect.state === "accepted" && projectedState !== "accepted")
      || (effect.state === "failed" && projectedState !== "failed")
    ) throw new WorkStoreError("IDEMPOTENCY_CONFLICT");
    if (projectedState === "failed") {
      // Reconciliation normalizes the exact nested-journal proof as well as
      // the task-level resolution. Both immutable rows are intentionally
      // retained and independently auditable until explicit work release.
      this.#recordNestedEffectSettlement(effect, instruction, "failed");
    }
    this.#database.query(
      `INSERT INTO work_effect_resolutions(
         effect_idempotency_key,work_id,attempt_id,instruction_digest,outcome,evidence_digest,created_at
       ) VALUES (?,?,?,?,?,?,?)`,
    ).run(
      effect.idempotency_key,
      effect.work_id,
      attempt.id,
      effect.instruction_digest,
      resolution,
      digestJson(evidence),
      now,
    );
    if (effect.state === projectedState) return;
    let acceptedReceipt: WorkNestedEffectReceipt | null = null;
    if (projectedState === "accepted") {
      if (verifiedAppliedReceipt !== undefined) {
        acceptedReceipt = verifiedAppliedReceipt;
      } else if (effect.state === "accepted" && effect.outcome_json !== null) {
        const storedOutcome = parseDispatchOutcome(parseStoredJson(effect.outcome_json));
        if (storedOutcome.kind === "accepted") acceptedReceipt = storedOutcome.receipt;
      } else {
        const nested = this.#nestedMutation(instruction);
        if (nested.state === "accepted" && nested.receipt.kind === "turn_started") {
          acceptedReceipt = nested.receipt;
        }
      }
      if (acceptedReceipt === null || acceptedReceipt.accountGeneration !== attempt.account_generation) {
        throw new WorkStoreError("ATTEMPT_RECOVERY_REQUIRED");
      }
    }
    const projectedOutcome = projectedState === "accepted"
      ? { kind: "accepted" as const, receipt: acceptedReceipt }
      : {
          kind: "failed" as const,
          code: resolution === "no_effect" ? "reconciled_no_effect" : "reconciled_failed",
        };
    const outcomeJson = canonicalWorkJson(projectedOutcome);
    const changed = this.#database.query(
      `UPDATE work_prepared_effects
       SET state=?,outcome_digest=?,outcome_json=?,finalized_at=?
       WHERE idempotency_key=? AND state IN ('prepared','effect_started','unknown')`,
    ).run(
      projectedState,
      digestText(outcomeJson),
      outcomeJson,
      now,
      effect.idempotency_key,
    );
    if (changed.changes !== 1) throw new WorkStoreError("IDEMPOTENCY_CONFLICT");
  }

  #reconciledAppliedReceipt(
    attempt: AttemptRow,
    evidence: readonly WorkEvidence[],
    deadline: number | null,
    acceptedStatuses: readonly ("completed" | "failed" | "interrupted")[],
  ): WorkNestedEffectReceipt {
    const effect = this.#database.query(
      `SELECT * FROM work_prepared_effects
       WHERE work_id=? AND effect_kind='attempt_dispatch' AND subject_id=?`,
    ).get(attempt.work_id, attempt.id) as PreparedEffectRow | null;
    if (effect === null) throw new WorkStoreError("ATTEMPT_RECOVERY_REQUIRED");
    const instruction = workPreparedEffectSchema.parse(parseStoredJson(effect.instruction_json));
    if (
      instruction.kind !== "dispatch"
      || instruction.attemptId !== attempt.id
      || instruction.workId !== attempt.work_id
      || instruction.targetSessionId !== attempt.worker_session_id
      || instruction.accountGeneration !== attempt.account_generation
      || digestText(effect.instruction_json) !== effect.instruction_digest
    ) throw new Error("WORK_EFFECT_INSTRUCTION_CORRUPT");
    this.#assertLegacyPreparedInstruction(effect, instruction);
    let receipt: WorkNestedEffectReceipt | null = null;
    if (effect.state === "accepted" && effect.outcome_json !== null) {
      const outcome = parseDispatchOutcome(parseStoredJson(effect.outcome_json));
      if (outcome.kind === "accepted") receipt = outcome.receipt;
    }
    if (receipt === null) {
      const nested = this.#nestedMutation(instruction);
      if (nested.state === "accepted") receipt = nested.receipt;
    }
    if (
      receipt === null
      || receipt.kind !== "turn_started"
      || receipt.accountGeneration !== attempt.account_generation
    ) throw new WorkStoreError("ATTEMPT_RECOVERY_REQUIRED");
    const receiptTurnId = receipt.turnId;
    if (!evidence.some((item) =>
      item.kind === "turn"
      && item.sessionId === instruction.targetSessionId
      && item.turnId === receiptTurnId
    )) throw new WorkStoreError("ATTEMPT_RECOVERY_REQUIRED");
    const completed = this.#database.query(
      `SELECT recorded_at,json_extract(event_json,'$.body.status') AS status
       FROM session_events
       WHERE session_id=? AND account_id=? AND provider_generation=?
         AND json_extract(event_json,'$.body.type')='turn_completed'
         AND json_extract(event_json,'$.body.turnId')=?
       ORDER BY sequence LIMIT 2`,
    ).all(
      instruction.targetSessionId,
      attempt.account_id,
      attempt.account_generation,
      receipt.turnId,
    ) as Array<{
      recorded_at: number;
      status: "completed" | "failed" | "interrupted";
    }>;
    if (
      completed.length !== 1
      || !acceptedStatuses.includes(completed[0]?.status ?? "completed")
    ) throw new WorkStoreError("ATTEMPT_RECOVERY_REQUIRED");
    if (deadline !== null && (completed[0]?.recorded_at ?? deadline) >= deadline) {
      throw new WorkStoreError("NOT_REVIEWABLE");
    }
    return receipt;
  }

  #reconciledNestedState(
    attempt: AttemptRow,
  ): "absent" | "prepared" | "failed" | "unknown" | "accepted" {
    const effect = this.#database.query(
      `SELECT * FROM work_prepared_effects
       WHERE work_id=? AND effect_kind='attempt_dispatch' AND subject_id=?`,
    ).get(attempt.work_id, attempt.id) as PreparedEffectRow | null;
    if (effect === null) throw new WorkStoreError("ATTEMPT_RECOVERY_REQUIRED");
    const instruction = workPreparedEffectSchema.parse(parseStoredJson(effect.instruction_json));
    if (
      instruction.kind !== "dispatch"
      || instruction.attemptId !== attempt.id
      || instruction.workId !== attempt.work_id
      || instruction.nestedMutationKey.length !== 36
      || digestText(effect.instruction_json) !== effect.instruction_digest
    ) throw new Error("WORK_EFFECT_INSTRUCTION_CORRUPT");
    this.#assertLegacyPreparedInstruction(effect, instruction);
    return this.#nestedMutation(instruction).state;
  }

  #reconcile(operation: Extract<WorkOperation, { kind: "attempt.reconcile" }>): WorkApplyResult {
    const work = this.#requireWork(operation.workId);
    if (!["active", "cancel_pending", "fail_pending"].includes(work.state)) {
      throw new WorkStoreError("WORK_NOT_ACTIVE");
    }
    this.#requireMember(operation.workId, operation.actorSessionId);
    const attempt = this.#requireAttempt(operation.attemptId, operation.workId);
    this.#assertFence(attempt, operation.fence);
    this.#assertAttemptOwner(attempt, operation.actorSessionId);
    this.#assertAttemptRevision(attempt, operation.expectedAttemptRevision);
    if (attempt.state !== "recovery_required") {
      throw new WorkStoreError("ATTEMPT_NOT_CLAIMABLE");
    }
    this.#assertEvidenceAuthority(
      operation.idempotencyKey,
      operation.workId,
      operation.outcome.evidence,
      attempt.task_id,
    );
    const now = this.#tick();
    const taskDetail = this.#requireTask(attempt.task_id, operation.workId);
    let dispatchResolution: "proven_applied" | "no_effect" | "failed" | null = null;
    let appliedReceipt: WorkNestedEffectReceipt | undefined;
    switch (operation.outcome.kind) {
      case "completed":
        dispatchResolution = "proven_applied";
        appliedReceipt = this.#reconciledAppliedReceipt(
          attempt,
          operation.outcome.evidence,
          taskDetail.task.deadline,
          ["completed"],
        );
        break;
      case "no_effect":
        if (this.#reconciledNestedState(attempt) !== "failed") {
          throw new WorkStoreError("ATTEMPT_RECOVERY_REQUIRED");
        }
        dispatchResolution = "no_effect";
        break;
      case "failed":
        if (this.#reconciledNestedState(attempt) === "failed") {
          dispatchResolution = "failed";
        } else {
          dispatchResolution = "proven_applied";
          appliedReceipt = this.#reconciledAppliedReceipt(
            attempt,
            operation.outcome.evidence,
            null,
            ["failed", "interrupted"],
          );
        }
        break;
      case "still_unknown":
        break;
    }
    let taskFailureReason:
      | "claim_window_elapsed"
      | "completion_deadline_elapsed"
      | "attempts_exhausted"
      | null = null;
    if (dispatchResolution !== null) {
      this.#resolveDispatchEffect(
        attempt,
        dispatchResolution,
        operation.outcome.evidence,
        now,
        appliedReceipt,
      );
    }
    let submission: SubmissionRow | null = null;
    switch (operation.outcome.kind) {
      case "completed":
        submission = this.#createSubmission(
          attempt,
          operation.outcome.summary,
          operation.outcome.result,
          operation.outcome.evidence,
          now,
        );
        break;
      case "failed":
        this.#database.query(
          `UPDATE work_attempts
           SET state='failed',revision=revision+1,updated_at=?,terminal_at=? WHERE id=?`,
        ).run(now, now, attempt.id);
        this.#database.query(
          `UPDATE work_task_states
           SET state='failed',revision=revision+1,updated_at=? WHERE task_id=?`,
        ).run(now, attempt.task_id);
        break;
      case "no_effect":
        if (work.state === "active") {
          taskFailureReason = this.#retryFailureReason(taskDetail.task, taskDetail.state, now);
        }
        this.#database.query(
          `UPDATE work_attempts
           SET state='released',revision=revision+1,updated_at=?,terminal_at=? WHERE id=?`,
        ).run(now, now, attempt.id);
        this.#database.query(
          `UPDATE work_task_states
           SET state=?,revision=revision+1,updated_at=? WHERE task_id=?`,
        ).run(
          work.state === "cancel_pending"
            ? "cancelled"
            : work.state === "fail_pending"
              ? "failed"
              : taskFailureReason === null ? "pending" : "failed",
          now,
          attempt.task_id,
        );
        break;
      case "still_unknown":
        this.#database.query(
          "UPDATE work_attempts SET revision=revision+1,updated_at=? WHERE id=?",
        ).run(now, attempt.id);
        break;
    }
    const body = {
      type: "attempt.reconciled" as const,
      attemptId: attempt.id,
      outcome: operation.outcome.kind,
      submissionId: submission?.id ?? null,
      outcomeDigest: digestJson(operation.outcome),
      evidenceCount: operation.outcome.evidence.length,
    };
    this.#appendEvent(operation.workId, body.type, operation.actorSessionId, body);
    if (taskFailureReason !== null) {
      this.#appendTaskFailure(
        operation.workId,
        attempt.task_id,
        taskFailureReason,
        operation.actorSessionId,
      );
    }
    if (operation.outcome.kind !== "still_unknown") {
      this.#tryFinalizePendingWork(operation.workId);
    }
    return workOperationResultSchema.parse({
      kind: operation.kind,
      workId: operation.workId,
      workRevision: this.#requireWork(operation.workId).revision,
      attempt: this.#attemptRecord(this.#requireAttempt(attempt.id, operation.workId)),
      submission: submission === null ? null : this.#submissionRecord(submission),
    });
  }

  finalizeDispatch(idempotencyKey: string, outcome: WorkDispatchOutcome): WorkAttemptRecord {
    if (!isUuidV7(idempotencyKey)) throw new WorkStoreError("BAD_IDEMPOTENCY_KEY");
    const parsedOutcome = parseDispatchOutcome(outcome);
    const outcomeJson = canonicalWorkJson(parsedOutcome);
    const outcomeDigest = digestText(outcomeJson);
    const finalize = this.#database.transaction((): WorkAttemptRecord => {
      const effect = this.#database.query(
        "SELECT * FROM work_prepared_effects WHERE idempotency_key=?",
      ).get(idempotencyKey) as PreparedEffectRow | null;
      if (effect === null || effect.effect_kind !== "attempt_dispatch") {
        throw new WorkStoreError("ATTEMPT_NOT_FOUND");
      }
      const instruction = workPreparedEffectSchema.parse(parseStoredJson(effect.instruction_json));
      if (instruction.kind !== "dispatch") throw new Error("WORK_EFFECT_INSTRUCTION_CORRUPT");
      this.#assertLegacyPreparedInstruction(effect, instruction);
      if (
        parsedOutcome.kind === "accepted"
        && (
          parsedOutcome.receipt.kind !== "turn_started"
          || parsedOutcome.receipt.accountGeneration !== instruction.accountGeneration
        )
      ) throw new WorkStoreError("ROUTE_MISMATCH");
      const attempt = this.#requireAttempt(effect.subject_id, effect.work_id);
      if (effect.state !== "prepared" && effect.state !== "effect_started") {
        if (effect.outcome_digest !== outcomeDigest) {
          throw new WorkStoreError("IDEMPOTENCY_CONFLICT");
        }
        return this.#attemptRecord(attempt);
      }
      if (effect.state === "prepared") throw new WorkStoreError("ATTEMPT_RECOVERY_REQUIRED");
      const work = this.#requireWork(effect.work_id);
      if (
        attempt.state === "recovery_required"
        && ["cancel_pending", "fail_pending"].includes(work.state)
      ) {
        const now = this.#tick();
        if (parsedOutcome.kind === "failed") {
          this.#database.query(
            `UPDATE work_attempts
             SET state='failed',revision=revision+1,updated_at=?,terminal_at=? WHERE id=?`,
          ).run(now, now, attempt.id);
          this.#database.query(
            `UPDATE work_task_states
             SET state=?,revision=revision+1,accepted_submission_id=NULL,updated_at=?
             WHERE task_id=?`,
          ).run(work.state === "cancel_pending" ? "cancelled" : "failed", now, attempt.task_id);
        }
        const settled = this.#database.query(
          `UPDATE work_prepared_effects
           SET state=?,outcome_digest=?,outcome_json=?,finalized_at=?
           WHERE idempotency_key=? AND state='effect_started'`,
        ).run(parsedOutcome.kind, outcomeDigest, outcomeJson, now, idempotencyKey);
        if (settled.changes !== 1) throw new WorkStoreError("IDEMPOTENCY_CONFLICT");
        const body = {
          type: "attempt.dispatch_finalized" as const,
          attemptId: attempt.id,
          outcome: parsedOutcome.kind,
        };
        this.#appendEvent(effect.work_id, body.type, attempt.worker_session_id, body);
        this.#tryFinalizePendingWork(effect.work_id);
        return this.#attemptRecord(this.#requireAttempt(attempt.id, effect.work_id));
      }
      if (
        attempt.state !== "dispatching"
        && !(attempt.state === "recovery_required" && parsedOutcome.kind === "accepted")
      ) throw new WorkStoreError("ATTEMPT_RECOVERY_REQUIRED");
      // Use the same full resume predicate as restart recovery: active Work,
      // live lease, open task deadline, and exact current provider authority.
      // A late accepted receipt is still retained after an intervening stale-
      // authority sweep, but that receipt cannot reactivate a fenced attempt.
      this.#settleAuthorizedDispatch(effect, parsedOutcome);
      return this.#attemptRecord(this.#requireAttempt(attempt.id, effect.work_id));
    });
    return finalize.immediate();
  }

  finalizeSignal(idempotencyKey: string, outcome: WorkSignalOutcome): WorkSignalRecord {
    if (!isUuidV7(idempotencyKey)) throw new WorkStoreError("BAD_IDEMPOTENCY_KEY");
    const parsedOutcome = parseSignalOutcome(outcome);
    const outcomeJson = canonicalWorkJson(parsedOutcome);
    const outcomeDigest = digestText(outcomeJson);
    const finalize = this.#database.transaction((): WorkSignalRecord => {
      const effect = this.#database.query(
        "SELECT * FROM work_prepared_effects WHERE idempotency_key=?",
      ).get(idempotencyKey) as PreparedEffectRow | null;
      if (effect === null || effect.effect_kind !== "signal_send") {
        throw new WorkStoreError("SIGNAL_NOT_FOUND");
      }
      const instruction = workPreparedEffectSchema.parse(parseStoredJson(effect.instruction_json));
      if (instruction.kind !== "signal") throw new Error("WORK_EFFECT_INSTRUCTION_CORRUPT");
      this.#assertLegacyPreparedInstruction(effect, instruction);
      // Exact settled replay is historical evidence, not permission to execute.
      // In particular, legacy accepted signals remain readable after quarantine.
      if (effect.state !== "prepared" && effect.state !== "effect_started") {
        if (effect.outcome_digest !== outcomeDigest) {
          throw new WorkStoreError("IDEMPOTENCY_CONFLICT");
        }
        return this.#signalRecord(effect.subject_id);
      }
      const providerAuthority = this.#signalProviderAuthority(instruction);
      if (
        parsedOutcome.kind === "accepted"
        && (
          providerAuthority === null
          || parsedOutcome.receipt.accountGeneration !== providerAuthority.process_generation
          || (instruction.mode === "queue" && parsedOutcome.receipt.kind !== "queue_created")
          || (instruction.mode === "steer" && parsedOutcome.receipt.kind !== "turn_steered")
        )
      ) throw new WorkStoreError("ROUTE_MISMATCH");
      if (effect.state === "prepared") throw new WorkStoreError("ATTEMPT_RECOVERY_REQUIRED");
      const signal = this.#database.query(
        "SELECT to_session_id FROM work_signals WHERE id=? AND work_id=?",
      ).get(effect.subject_id, effect.work_id) as { to_session_id: string } | null;
      if (signal === null) throw new WorkStoreError("SIGNAL_NOT_FOUND");
      const now = this.#tick();
      const settled = this.#database.query(
        `UPDATE work_prepared_effects
         SET state=?,outcome_digest=?,outcome_json=?,finalized_at=?
         WHERE idempotency_key=? AND state='effect_started'`,
      ).run(parsedOutcome.kind, outcomeDigest, outcomeJson, now, idempotencyKey);
      if (settled.changes !== 1) throw new WorkStoreError("IDEMPOTENCY_CONFLICT");
      this.#database.query(
        `INSERT INTO work_signal_receipts(
           signal_id,sequence,kind,actor_session_id,detail_code,recorded_at
         ) VALUES (?,?,?,?,?,?)`,
      ).run(
        effect.subject_id,
        this.#nextReceiptSequence(effect.subject_id),
        parsedOutcome.kind,
        signal.to_session_id,
        parsedOutcome.kind === "failed" || parsedOutcome.kind === "unknown"
          ? parsedOutcome.code
          : null,
        now,
      );
      const body = {
        type: "signal.delivery_updated" as const,
        signalId: effect.subject_id,
        outcome: parsedOutcome.kind,
      };
      this.#appendEvent(effect.work_id, body.type, signal.to_session_id, body);
      this.#tryFinalizePendingWork(effect.work_id);
      return this.#signalRecord(effect.subject_id);
    });
    return finalize.immediate();
  }

  #cursor(work: WorkRow, sequence: number): string {
    return this.#encodeCursor({
      version: 1,
      type: "work",
      workId: work.id,
      streamEpoch: work.stream_epoch,
      sequence,
    });
  }

  #verifyStoredEvent(row: StoredWorkEventRow, expectedPreviousHash: string | null): void {
    let body: WorkEvent["body"];
    try {
      body = workEventBodySchema.parse(parseStoredJson(row.payload_json));
    } catch {
      throw new Error("WORK_EVENT_CHAIN_CORRUPT");
    }
    const payloadDigest = digestText(row.payload_json);
    const eventHash = digestJson({
      actorSessionId: row.actor_session_id,
      daemonGeneration: row.daemon_generation,
      kind: row.kind,
      payloadDigest,
      previousHash: row.previous_hash,
      recordedAt: row.recorded_at,
      revision: row.revision,
      sequence: row.sequence,
      streamEpoch: row.stream_epoch,
      workId: row.work_id,
    });
    if (
      body.type !== row.kind
      || payloadDigest !== row.payload_digest
      || row.previous_hash !== expectedPreviousHash
      || eventHash !== row.event_hash
    ) throw new Error("WORK_EVENT_CHAIN_CORRUPT");
    // Validate only the bounded entities referenced by this selected event.
    // Historical event state is never the source of present-day liveness.
    if ("taskIds" in body) {
      for (const taskId of body.taskIds) this.#canonicalTaskIdentity(taskId, row.work_id);
    }
    if ("taskId" in body && body.taskId !== null) {
      this.#canonicalTaskIdentity(body.taskId, row.work_id);
    }
    if ("attemptId" in body) this.#canonicalAttemptIdentity(body.attemptId, row.work_id);
    if ("submissionId" in body && body.submissionId !== null) {
      this.#canonicalSubmissionIdentity(body.submissionId, row.work_id);
    }
  }

  #verifyWorkEventHead(work: WorkRow): void {
    const head = this.#database.query(
      `SELECT * FROM work_events WHERE work_id=? ORDER BY sequence DESC LIMIT 1`,
    ).get(work.id) as StoredWorkEventRow | null;
    if (work.next_sequence === 1) {
      if (head !== null || work.head_hash !== null || work.revision !== 0) {
        throw new Error("WORK_EVENT_CHAIN_CORRUPT");
      }
      return;
    }
    if (
      head === null
      || head.sequence !== work.next_sequence - 1
      || head.revision !== work.revision
      || head.event_hash !== work.head_hash
      || head.stream_epoch !== work.stream_epoch
    ) throw new Error("WORK_EVENT_CHAIN_CORRUPT");
    let previousHash: string | null = null;
    if (head.sequence > 1) {
      const previous = this.#database.query(
        "SELECT event_hash FROM work_events WHERE work_id=? AND sequence=?",
      ).get(work.id, head.sequence - 1) as { event_hash: string } | null;
      if (previous === null) throw new Error("WORK_EVENT_CHAIN_CORRUPT");
      previousHash = previous.event_hash;
    }
    this.#verifyStoredEvent(head, previousHash);
  }

  #domainEvent(row: StoredWorkEventRow): WorkEvent {
    return {
      version: 1,
      workId: row.work_id,
      streamEpoch: row.stream_epoch,
      sequence: row.sequence,
      occurredAt: row.recorded_at,
      actorSessionId: row.actor_session_id,
      body: parseStoredJson(row.payload_json) as WorkEvent["body"],
    };
  }

  #eventPage(workId: string, afterSequence: number, limit: number): DomainWorkEventPage {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      throw new WorkStoreError("BAD_CURSOR");
    }
    const bounded = boundedLimit(limit, WORK_PAGE_LIMIT);
    const work = this.#requireWork(workId);
    this.#routes(workId);
    const rows = this.#database.query(
      `SELECT *
       FROM work_events WHERE work_id=? AND sequence>?
       ORDER BY sequence LIMIT ?`,
    ).all(workId, afterSequence, bounded) as StoredWorkEventRow[];
    this.#verifyWorkEventHead(work);
    let previousHash: string | null = null;
    const firstRow = rows.at(0);
    if (firstRow !== undefined && firstRow.sequence > 1) {
      const previous = this.#database.query(
        "SELECT event_hash FROM work_events WHERE work_id=? AND sequence=?",
      ).get(workId, firstRow.sequence - 1) as { event_hash: string } | null;
      if (previous === null) throw new Error("WORK_EVENT_CHAIN_CORRUPT");
      previousHash = previous.event_hash;
    }
    const requestedCursor = afterSequence === 0 ? null : this.#cursor(work, afterSequence);
    const page = (events: readonly WorkEvent[]): DomainWorkEventPage => {
      const nextSequence = events.at(-1)?.sequence ?? afterSequence;
      return {
        version: 1,
        workId,
        streamEpoch: work.stream_epoch,
        requestedCursor,
        retentionFloorCursor: this.#cursor(work, 0),
        observedThroughCursor: this.#cursor(work, work.next_sequence - 1),
        nextCursor: this.#cursor(work, nextSequence),
        gap: null,
        events: [...events],
      };
    };
    const events: WorkEvent[] = [];
    let priorSequence: number | null = null;
    for (const row of rows) {
      if (
        row.work_id !== workId
        || row.stream_epoch !== work.stream_epoch
        || (priorSequence !== null && row.sequence !== priorSequence + 1)
      ) throw new Error("WORK_EVENT_CHAIN_CORRUPT");
      this.#verifyStoredEvent(row, previousHash);
      previousHash = row.event_hash;
      priorSequence = row.sequence;
      const event = this.#domainEvent(row);
      if (
        workReadSuccessWireBytes("work.events", page([...events, event]))
        > WORK_EVENT_PAGE_MAX_BYTES
      ) break;
      events.push(event);
    }
    if (events.length === 0 && rows.length > 0) {
      throw new WorkStoreError("WORK_CAPACITY_EXCEEDED");
    }
    return workEventPageSchema.parse(page(events));
  }

  events(workId: string, afterSequence = 0, limit = 50): DomainWorkEventPage {
    const read = this.#database.transaction(
      () => this.#eventPage(workId, afterSequence, limit),
    );
    return read.deferred();
  }

  #terminalProjection(workId: string): WorkTerminalProjection | null {
    const row = this.#database.query(
      `SELECT kind,state,actor_session_id,summary,result_json,evidence_json,
              request_digest,requested_at,settled_at
       FROM work_terminal_requests WHERE work_id=?`,
    ).get(workId) as {
      kind: WorkTerminalProjection["kind"];
      state: WorkTerminalProjection["state"];
      actor_session_id: string;
      summary: string;
      result_json: string | null;
      evidence_json: string;
      request_digest: string;
      requested_at: number;
      settled_at: number | null;
    } | null;
    if (row === null) return null;
    return {
      kind: row.kind,
      state: row.state,
      actorSessionId: row.actor_session_id,
      summary: row.summary,
      result: row.result_json === null
        ? null
        : parseStoredJson(row.result_json) as WorkTerminalProjection["result"],
      evidence: parseStoredJson(row.evidence_json) as WorkEvidence[],
      requestDigest: row.request_digest,
      requestedAt: row.requested_at,
      settledAt: row.settled_at,
    };
  }

  snapshot(workId: string, actorSessionId?: string): WorkSnapshot {
    const read = this.#database.transaction((): WorkSnapshot => {
      const before = this.#requireWork(workId);
      if (actorSessionId !== undefined) this.#requireMember(workId, actorSessionId);
      const now = this.#projectionTime();
      if (["active", "cancel_pending", "fail_pending"].includes(before.state)) {
        this.#sweepExpired(workId, now);
      }
      const work = this.#requireWork(workId);
      this.#verifyWorkEventHead(work);
      const taskRows = this.#database.query(
        `SELECT t.*,s.state AS state,s.revision AS revision,s.next_fence AS next_fence,
                s.attempt_count AS attempt_count,s.accepted_submission_id AS accepted_submission_id,
                s.retry_not_before AS retry_not_before,s.updated_at AS updated_at
         FROM work_tasks AS t JOIN work_task_states AS s ON s.task_id=t.id
         WHERE t.work_id=? ORDER BY t.ordinal,t.id`,
      ).all(workId) as Array<TaskRow & TaskStateRow>;
      const joined = this.#database.query(
        "SELECT session_id FROM work_members WHERE work_id=? ORDER BY joined_at,session_id",
      ).all(workId) as Array<{ session_id: string }>;
      const recentSignalRows = this.#database.query(
        `SELECT id FROM work_signals WHERE work_id=? AND task_id IS NULL
         ORDER BY created_at DESC,id DESC LIMIT ?`,
      ).all(workId, WORK_READ_HISTORY_LIMIT) as Array<{ id: string }>;
      const signalCount = (this.#database.query(
        "SELECT COUNT(*) AS count FROM work_signals WHERE work_id=? AND task_id IS NULL",
      ).get(workId) as { count: number } | null)?.count ?? 0;
      const recentSignals = recentSignalRows.map((row) => this.#signalRecord(row.id));
      const projectedWork = this.#workRecord(workId, now);
      const routes = this.#routes(workId);
      const cursor = this.#cursor(work, work.next_sequence - 1);
      const tasks = taskRows.map((row) => this.#taskSummary(row, row, now));
      const joinedSessionIds = joined.map((row) => row.session_id);
      const terminal = this.#terminalProjection(workId);
      const candidate = (): WorkSnapshot => ({
        version: 1,
        work: projectedWork,
        routes,
        cursor,
        tasks,
        joinedSessionIds,
        recentSignals,
        omittedSignals: Math.max(0, signalCount - recentSignals.length),
        terminal,
      });
      while (
        workReadSuccessWireBytes("work.snapshot", candidate()) > WORK_SNAPSHOT_MAX_BYTES
        && recentSignals.length > 0
      ) recentSignals.pop();
      const bounded = candidate();
      if (workReadSuccessWireBytes("work.snapshot", bounded) > WORK_SNAPSHOT_MAX_BYTES) {
        throw new WorkStoreError("WORK_CAPACITY_EXCEEDED");
      }
      return workSnapshotSchema.parse(bounded);
    });
    return read.deferred();
  }

  task(taskId: string): WorkTaskDetail {
    const initial = this.#requireTask(taskId);
    const read = this.#database.transaction((): WorkTaskDetail => {
      const work = this.#requireWork(initial.task.work_id);
      const now = this.#projectionTime();
      if (["active", "cancel_pending", "fail_pending"].includes(work.state)) {
        this.#sweepExpired(work.id, now);
      }
      this.#verifyWorkEventHead(this.#requireWork(work.id));
      const found = this.#requireTask(taskId, work.id);
      const dependencies = this.#database.query(
        `SELECT d.dependency_task_id,s.state
         FROM work_task_dependencies AS d
         JOIN work_task_states AS s ON s.task_id=d.dependency_task_id
         WHERE d.work_id=? AND d.task_id=? ORDER BY d.dependency_task_id`,
      ).all(work.id, taskId) as Array<{ dependency_task_id: string; state: TaskState }>;
      const active = this.#database.query(
        `SELECT * FROM work_attempts WHERE task_id=?
         AND state IN ('claimed','dispatching','running','submitted','recovery_required')
         ORDER BY created_at DESC,id DESC LIMIT 1`,
      ).get(taskId) as AttemptRow | null;
      const latestAttempt = this.#database.query(
        `SELECT * FROM work_attempts WHERE task_id=?
         ORDER BY fence DESC LIMIT 1`,
      ).get(taskId) as AttemptRow | null;
      const latestAttemptReport = this.#database.query(
        `SELECT r.*,a.task_id AS task_id FROM work_attempt_reports AS r
         JOIN work_attempts AS a ON a.id=r.attempt_id
         WHERE a.task_id=?
         ORDER BY r.created_at DESC,r.idempotency_key DESC LIMIT 1`,
      ).get(taskId) as AttemptReportRow | null;
      const latest = this.#database.query(
        "SELECT * FROM work_submissions WHERE task_id=? ORDER BY created_at DESC,id DESC LIMIT 1",
      ).get(taskId) as SubmissionRow | null;
      const latestReviews = latest === null
        ? []
        : this.#database.query(
          `SELECT * FROM work_reviews WHERE submission_id=? ORDER BY created_at,id`,
        ).all(latest.id) as ReviewRow[];
      const recentSignalRows = this.#database.query(
        `SELECT id FROM work_signals WHERE work_id=? AND task_id=?
         ORDER BY created_at DESC,id DESC LIMIT ?`,
      ).all(work.id, taskId, WORK_READ_HISTORY_LIMIT) as Array<{ id: string }>;
      const signalCount = (this.#database.query(
        "SELECT COUNT(*) AS count FROM work_signals WHERE work_id=? AND task_id=?",
      ).get(work.id, taskId) as { count: number } | null)?.count ?? 0;
      const reviews = latestReviews.map((review) => this.#reviewRecord(review));
      const recentSignals = recentSignalRows.map((row) => this.#signalRecord(row.id));
      const task = this.#taskSummary(found.task, found.state, now);
      const spec = this.#taskSpec(found.task);
      const parentTaskId = found.task.parent_task_id;
      const dependencyTaskIds = dependencies.map((row) => row.dependency_task_id);
      const unmetDependencyTaskIds = dependencies
        .filter((row) => row.state !== "completed")
        .map((row) => row.dependency_task_id);
      const activeAttempt = active === null ? null : this.#attemptRecord(active);
      const projectedLatestAttempt = latestAttempt === null
        ? null
        : this.#attemptRecord(latestAttempt);
      const projectedLatestAttemptReport = latestAttemptReport === null
        ? null
        : this.#attemptReportRecord(latestAttemptReport);
      const latestSubmission = latest === null ? null : this.#submissionRecord(latest);
      const candidate = (): WorkTaskDetail => ({
        version: 1,
        workId: work.id,
        task,
        spec,
        parentTaskId,
        dependencyTaskIds,
        unmetDependencyTaskIds,
        activeAttempt,
        latestAttempt: projectedLatestAttempt,
        latestAttemptReport: projectedLatestAttemptReport,
        latestSubmission,
        latestSubmissionReviews: reviews,
        omittedLatestSubmissionReviews: Math.max(0, latestReviews.length - reviews.length),
        recentSignals,
        omittedSignals: Math.max(0, signalCount - recentSignals.length),
        createdAt: found.task.created_at,
        updatedAt: found.state.updated_at,
      });
      while (
        workReadSuccessWireBytes("work.task", candidate()) > WORK_TASK_DETAIL_MAX_BYTES
        && (reviews.length > 0 || recentSignals.length > 0)
      ) {
        const oldestReview = reviews.at(0);
        const oldestSignal = recentSignals.at(-1);
        if (
          oldestReview !== undefined
          && (
            oldestSignal === undefined
            || oldestReview.createdAt <= oldestSignal.createdAt
          )
        ) reviews.shift();
        else recentSignals.pop();
      }
      const bounded = candidate();
      if (workReadSuccessWireBytes("work.task", bounded) > WORK_TASK_DETAIL_MAX_BYTES) {
        throw new WorkStoreError("WORK_CAPACITY_EXCEEDED");
      }
      return workTaskDetailSchema.parse(bounded);
    });
    return read.deferred();
  }

  taskPosition(taskId: string): Readonly<{ workId: string; sequence: number }> {
    const read = this.#database.transaction(() => {
      const found = this.#requireTask(taskId);
      const work = this.#requireWork(found.task.work_id);
      this.#verifyWorkEventHead(work);
      return { workId: work.id, sequence: work.next_sequence - 1 };
    });
    return read.deferred();
  }

  #taskHistorySourceCounts(workId: string, taskId: string): WorkTaskHistoryCounts {
    const row = this.#database.query(
      `SELECT
         (SELECT COUNT(*) FROM work_attempts
          WHERE work_id=? AND task_id=?) AS attempts,
         (SELECT COUNT(*) FROM work_attempt_reports AS r
          JOIN work_attempts AS a ON a.id=r.attempt_id
          WHERE r.work_id=? AND a.task_id=?) AS attempt_reports,
         (SELECT COUNT(*) FROM work_submissions
          WHERE work_id=? AND task_id=?) AS submissions,
         (SELECT COUNT(*) FROM work_reviews AS r
          JOIN work_submissions AS s ON s.id=r.submission_id
          WHERE r.work_id=? AND s.task_id=?) AS reviews,
         (SELECT COUNT(*) FROM work_signals
          WHERE work_id=? AND task_id=?) AS signals`,
    ).get(
      workId,
      taskId,
      workId,
      taskId,
      workId,
      taskId,
      workId,
      taskId,
      workId,
      taskId,
    ) as {
      attempts: number;
      attempt_reports: number;
      submissions: number;
      reviews: number;
      signals: number;
    };
    return {
      attempts: row.attempts,
      attemptReports: row.attempt_reports,
      submissions: row.submissions,
      reviews: row.reviews,
      signals: row.signals,
    };
  }

  #taskHistoryCounts(
    workId: string,
    taskId: string,
    highWaterOrdinal: number,
  ): WorkTaskHistoryCounts {
    const row = this.#database.query(
      `SELECT
         COALESCE(SUM(kind='attempt'),0) AS attempts,
         COALESCE(SUM(kind='attempt_report'),0) AS attempt_reports,
         COALESCE(SUM(kind='submission'),0) AS submissions,
         COALESCE(SUM(kind='review'),0) AS reviews,
         COALESCE(SUM(kind='signal'),0) AS signals
       FROM work_task_history_index
       WHERE work_id=? AND task_id=? AND ordinal<=?`,
    ).get(workId, taskId, highWaterOrdinal) as {
      attempts: number;
      attempt_reports: number;
      submissions: number;
      reviews: number;
      signals: number;
    };
    return {
      attempts: row.attempts,
      attemptReports: row.attempt_reports,
      submissions: row.submissions,
      reviews: row.reviews,
      signals: row.signals,
    };
  }

  #taskHistoryMetadata(
    workId: string,
    taskId: string,
    highWaterOrdinal: number,
    offset: number,
    limit: number,
  ): WorkTaskHistoryMetadataRow[] {
    return this.#database.query(
      `WITH ranked AS (
         SELECT kind,ordinal,stable_key,created_at,
           SUM(CASE WHEN kind='attempt' THEN 1 ELSE 0 END) OVER ordered
             AS through_attempts,
           SUM(CASE WHEN kind='attempt_report' THEN 1 ELSE 0 END) OVER ordered
             AS through_attempt_reports,
           SUM(CASE WHEN kind='submission' THEN 1 ELSE 0 END) OVER ordered
             AS through_submissions,
           SUM(CASE WHEN kind='review' THEN 1 ELSE 0 END) OVER ordered
             AS through_reviews,
           SUM(CASE WHEN kind='signal' THEN 1 ELSE 0 END) OVER ordered
             AS through_signals
         FROM work_task_history_index
         WHERE work_id=? AND task_id=? AND ordinal<=?
         WINDOW ordered AS (
           ORDER BY ordinal DESC
           ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
         )
       )
       SELECT * FROM ranked
       ORDER BY ordinal DESC LIMIT ? OFFSET ?`,
    ).all(workId, taskId, highWaterOrdinal, limit, offset) as WorkTaskHistoryMetadataRow[];
  }

  #taskHistoryItem(
    workId: string,
    taskId: string,
    metadata: WorkTaskHistoryMetadataRow,
    observedSequence: number,
  ): WorkTaskHistoryItem {
    // The cached cut may still say claimed after the source attempt settled.
    // Validate immutable provenance against current rows, never cached liveness.
    this.#assertCanonicalHistorySource(workId, taskId, metadata.kind, metadata.stable_key);
    const version = this.#database.query(
      `SELECT record_json,record_digest FROM work_task_history_versions
       WHERE history_ordinal=? AND work_id=? AND task_id=? AND event_sequence<=?
       ORDER BY event_sequence DESC,ordinal DESC LIMIT 1`,
    ).get(metadata.ordinal, workId, taskId, observedSequence) as {
      record_json: string;
      record_digest: string;
    } | null;
    if (version === null || digestText(version.record_json) !== version.record_digest) {
      throw new Error("WORK_TASK_HISTORY_VERSION_CORRUPT");
    }
    const item = workTaskHistoryItemSchema.parse(parseStoredJson(version.record_json));
    if (item.kind !== metadata.kind) throw new Error("WORK_TASK_HISTORY_VERSION_CORRUPT");
    if (
      (item.kind === "attempt" && item.value.id !== metadata.stable_key)
      || (
        item.kind === "attempt_report"
        && item.value.idempotencyKey !== metadata.stable_key
      )
      || (item.kind === "submission" && item.value.id !== metadata.stable_key)
      || (item.kind === "review" && item.value.id !== metadata.stable_key)
      || (item.kind === "signal" && item.value.id !== metadata.stable_key)
    ) throw new Error("WORK_TASK_HISTORY_VERSION_CORRUPT");
    return item;
  }

  taskHistory(
    taskId: string,
    limit = WORK_TASK_HISTORY_ITEM_LIMIT,
    cursor?: WorkTaskHistoryCursorPayload,
  ): WorkTaskHistoryPage {
    if (!Number.isInteger(limit) || limit < 1 || limit > WORK_TASK_HISTORY_ITEM_LIMIT) {
      throw new WorkStoreError("BAD_CURSOR");
    }
    const parsedCursor = cursor === undefined
      ? undefined
      : workTaskHistoryCursorPayloadSchema.safeParse(cursor);
    if (parsedCursor !== undefined && !parsedCursor.success) {
      throw new WorkStoreError("BAD_CURSOR");
    }
    const continued = parsedCursor?.success === true ? parsedCursor.data : undefined;
    if (continued !== undefined && continued.taskId !== taskId) {
      throw new WorkStoreError("BAD_CURSOR");
    }
    const read = this.#database.transaction((): WorkTaskHistoryPage => {
      let work: WorkRow;
      let found: { task: TaskRow; state: TaskStateRow };
      let projectionAt: number;
      let highWaterOrdinal: number;
      let taskRevision: number;
      let observedSequence: number;
      if (continued === undefined) {
        found = this.#requireTask(taskId);
        const initial = this.#requireWork(found.task.work_id);
        projectionAt = this.#projectionTime();
        if (["active", "cancel_pending", "fail_pending"].includes(initial.state)) {
          this.#sweepExpired(initial.id, projectionAt);
        }
        work = this.#requireWork(initial.id);
        found = this.#requireTask(taskId, work.id);
        const highWater = this.#database.query(
          `SELECT COALESCE(MAX(ordinal),0) AS ordinal FROM work_task_history_index
           WHERE work_id=? AND task_id=?`,
        ).get(work.id, taskId) as { ordinal: number } | null;
        highWaterOrdinal = highWater?.ordinal ?? 0;
        taskRevision = found.state.revision;
        observedSequence = work.next_sequence - 1;
      } else {
        work = this.#requireWork(continued.workId);
        if (
          continued.streamEpoch !== work.stream_epoch
          || continued.sequence < 1
          || continued.sequence > work.next_sequence - 1
        ) throw new WorkStoreError("BAD_CURSOR");
        const taskBinding = this.#database.query(
          "SELECT work_id FROM work_tasks WHERE id=?",
        ).get(taskId) as { work_id: string } | null;
        if (taskBinding === null) throw new WorkStoreError("TASK_NOT_FOUND");
        if (taskBinding.work_id !== work.id) throw new WorkStoreError("BAD_CURSOR");
        found = this.#requireTask(taskId, work.id);
        const highWater = this.#database.query(
          `SELECT COALESCE(MAX(ordinal),0) AS ordinal FROM work_task_history_index
           WHERE work_id=? AND task_id=?`,
        ).get(work.id, taskId) as { ordinal: number } | null;
        const currentHighWater = highWater?.ordinal ?? 0;
        if (
          continued.highWaterOrdinal > currentHighWater
          || continued.taskRevision > found.state.revision
          || (
            continued.highWaterOrdinal > 0
            && this.#database.query(
              `SELECT 1 AS present FROM work_task_history_index
               WHERE ordinal=? AND work_id=? AND task_id=?`,
            ).get(continued.highWaterOrdinal, work.id, taskId) === null
          )
        ) throw new WorkStoreError("BAD_CURSOR");
        projectionAt = continued.projectionAt;
        highWaterOrdinal = continued.highWaterOrdinal;
        taskRevision = continued.taskRevision;
        observedSequence = continued.sequence;
      }
      this.#verifyWorkEventHead(work);
      const offset = continued?.offset ?? 0;
      const counts = this.#taskHistoryCounts(work.id, taskId, highWaterOrdinal);
      const sourceCounts = this.#taskHistorySourceCounts(work.id, taskId);
      const countKeys = Object.keys(counts) as Array<keyof WorkTaskHistoryCounts>;
      if (countKeys.some((key) => (
        continued === undefined
          ? counts[key] !== sourceCounts[key]
          : counts[key] > sourceCounts[key]
      ))) throw new Error("WORK_TASK_HISTORY_INDEX_CORRUPT");
      const totalItems = Object.values(counts).reduce((sum, count) => sum + count, 0);
      if (offset > totalItems) throw new WorkStoreError("BAD_CURSOR");
      const metadata = this.#taskHistoryMetadata(
        work.id,
        taskId,
        highWaterOrdinal,
        offset,
        limit,
      );
      const versionedMembership = (this.#database.query(
        `SELECT COUNT(DISTINCT v.history_ordinal) AS count
         FROM work_task_history_versions AS v
         JOIN work_task_history_index AS i ON i.ordinal=v.history_ordinal
         WHERE i.work_id=? AND i.task_id=? AND i.ordinal<=? AND v.event_sequence<=?`,
      ).get(work.id, taskId, highWaterOrdinal, observedSequence) as { count: number } | null)
        ?.count ?? 0;
      if (versionedMembership !== totalItems) {
        throw new Error("WORK_TASK_HISTORY_VERSION_CORRUPT");
      }
      const selected = metadata.map((row) =>
        this.#taskHistoryItem(work.id, taskId, row, observedSequence));
      const requestedCursor = continued === undefined ? null : this.#encodeCursor(continued);
      const observedThroughCursor = this.#cursor(work, observedSequence);
      const countsThrough = (row: WorkTaskHistoryMetadataRow): WorkTaskHistoryCounts => ({
        attempts: row.through_attempts,
        attemptReports: row.through_attempt_reports,
        submissions: row.through_submissions,
        reviews: row.through_reviews,
        signals: row.through_signals,
      });
      const firstMetadata = metadata[0];
      const beforeCounts: WorkTaskHistoryCounts = firstMetadata === undefined
        ? { ...counts }
        : (() => {
            const through = countsThrough(firstMetadata);
            const firstKind = firstMetadata.kind;
            return {
              attempts: through.attempts - (firstKind === "attempt" ? 1 : 0),
              attemptReports: through.attemptReports - (firstKind === "attempt_report" ? 1 : 0),
              submissions: through.submissions - (firstKind === "submission" ? 1 : 0),
              reviews: through.reviews - (firstKind === "review" ? 1 : 0),
              signals: through.signals - (firstKind === "signal" ? 1 : 0),
            };
          })();
      const items: WorkTaskHistoryItem[] = [];
      let through = beforeCounts;
      const page = (): WorkTaskHistoryPage => {
        const remainingCounts: WorkTaskHistoryCounts = {
          attempts: counts.attempts - through.attempts,
          attemptReports: counts.attemptReports - through.attemptReports,
          submissions: counts.submissions - through.submissions,
          reviews: counts.reviews - through.reviews,
          signals: counts.signals - through.signals,
        };
        const remainingItems = totalItems - offset - items.length;
        const nextCursor = remainingItems === 0
          ? null
          : this.#encodeCursor(workTaskHistoryCursorPayloadSchema.parse({
              version: 1,
              type: "work_task_history",
              workId: work.id,
              taskId,
              streamEpoch: work.stream_epoch,
              sequence: observedSequence,
              projectionAt,
              highWaterOrdinal,
              taskRevision,
              offset: offset + items.length,
            }));
        return {
          version: 1,
          kind: "history",
          workId: work.id,
          taskId,
          taskRevision,
          projectionAt,
          requestedCursor,
          observedThroughCursor,
          offset,
          totalItems,
          counts,
          items,
          remainingItems,
          remainingCounts,
          nextCursor,
        };
      };
      for (const [index, item] of selected.entries()) {
        const metadataRow = metadata[index];
        if (metadataRow === undefined) throw new Error("WORK_TASK_HISTORY_CORRUPT");
        const priorThrough = through;
        items.push(item);
        through = countsThrough(metadataRow);
        if (workReadSuccessWireBytes("work.task", page()) > WORK_TASK_HISTORY_PAGE_MAX_BYTES) {
          items.pop();
          through = priorThrough;
          break;
        }
      }
      const bounded = page();
      if (bounded.remainingItems > 0 && bounded.items.length === 0) {
        throw new WorkStoreError("WORK_CAPACITY_EXCEEDED");
      }
      return workTaskHistoryPageSchema.parse(bounded);
    });
    return read.deferred();
  }

  poll(
    workId: string,
    actorSessionId?: string,
    cursorSequence = 0,
    limit = WORK_POLL_DEFAULT_LIMIT,
    actionCursor?: WorkActionCursorPayload,
  ): WorkPoll {
    if (!Number.isSafeInteger(cursorSequence) || cursorSequence < 0) {
      throw new WorkStoreError("BAD_CURSOR");
    }
    const bounded = boundedLimit(limit, WORK_POLL_LIMIT);
    const read = this.#database.transaction((): WorkPoll => {
      const initial = this.#requireWork(workId);
      if (actorSessionId !== undefined) this.#requireMember(workId, actorSessionId);
      const observedNow = this.#projectionTime();
      if (["active", "cancel_pending", "fail_pending"].includes(initial.state)) {
        this.#sweepExpired(workId, observedNow);
      }
      const work = this.#requireWork(workId);
      const headSequence = work.next_sequence - 1;
      const parsedActionCursor = actionCursor === undefined
        ? null
        : workActionCursorPayloadSchema.safeParse(actionCursor);
      if (
        parsedActionCursor !== null
        && (
          !parsedActionCursor.success
          || parsedActionCursor.data.workId !== workId
          || parsedActionCursor.data.actorSessionId !== (actorSessionId ?? null)
          || parsedActionCursor.data.streamEpoch !== work.stream_epoch
          || parsedActionCursor.data.sequence !== headSequence
          || parsedActionCursor.data.projectionAt > observedNow
        )
      ) throw new WorkStoreError("BAD_CURSOR");
      const now = parsedActionCursor?.success === true
        ? parsedActionCursor.data.projectionAt
        : observedNow;
      const offsets = parsedActionCursor?.success === true
        ? parsedActionCursor.data.offsets
        : {
            readyTasks: 0,
            ownedAttempts: 0,
            recoveryAttempts: 0,
            reviewableSubmissions: 0,
            signals: 0,
            preparedEffects: 0,
          };
      let remainingItems = Math.min(WORK_POLL_ITEM_LIMIT, bounded);
      const take = <Input, Output>(
        rows: readonly Input[],
        offset: number,
        project: (row: Input) => Output,
      ): Output[] => {
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > rows.length) {
          throw new WorkStoreError("BAD_CURSOR");
        }
        const selected = rows.slice(offset, offset + remainingItems).map(project);
        remainingItems -= selected.length;
        return selected;
      };
      const rows = this.#database.query(
        `SELECT t.*,s.state AS state,s.revision AS revision,s.next_fence AS next_fence,
                s.attempt_count AS attempt_count,s.accepted_submission_id AS accepted_submission_id,
                s.retry_not_before AS retry_not_before,s.updated_at AS updated_at
         FROM work_tasks AS t JOIN work_task_states AS s ON s.task_id=t.id
         WHERE t.work_id=? AND s.state='pending'
         ORDER BY t.priority DESC,t.ordinal,t.id`,
      ).all(workId) as Array<TaskRow & TaskStateRow>;
      const allReadyTasks = work.state === "active"
        ? rows.filter((row) => this.#taskReady(row, row, now))
        : [];
      const readyTasks = take(
        allReadyTasks,
        offsets.readyTasks,
        (row) => this.#taskSummary(row, row, now),
      );
      const allAttempts = actorSessionId === undefined
        ? []
        : this.#database.query(
          `SELECT * FROM work_attempts
           WHERE work_id=? AND worker_session_id=?
             AND state IN ('claimed','dispatching','running','submitted')
           ORDER BY updated_at,id`,
        ).all(workId, actorSessionId) as AttemptRow[];
      for (const attempt of allAttempts) this.#assertCanonicalAttempt(attempt);
      const attempts = take(
        allAttempts,
        offsets.ownedAttempts,
        (attempt) => this.#attemptRecord(attempt),
      );
      const allRecoveryAttempts = actorSessionId === undefined
        ? this.#database.query(
          `SELECT * FROM work_attempts
           WHERE work_id=? AND state='recovery_required' ORDER BY updated_at,id`,
        ).all(workId) as AttemptRow[]
        : this.#database.query(
          `SELECT * FROM work_attempts
           WHERE work_id=? AND worker_session_id=? AND state='recovery_required'
           ORDER BY updated_at,id`,
        ).all(workId, actorSessionId) as AttemptRow[];
      for (const attempt of allRecoveryAttempts) this.#assertCanonicalAttempt(attempt);
      const recoveryAttempts = take(
        allRecoveryAttempts,
        offsets.recoveryAttempts,
        (attempt) => this.#attemptRecord(attempt),
      );
      const reviewableRows = actorSessionId === undefined || work.state !== "active"
        ? []
        : this.#database.query(
          `SELECT s.* FROM work_submissions AS s
           JOIN work_tasks AS t ON t.id=s.task_id
           JOIN work_task_states AS ts ON ts.task_id=s.task_id AND ts.state='submitted'
           JOIN work_attempts AS a ON a.id=s.attempt_id AND a.state='submitted'
           WHERE s.work_id=? AND s.worker_session_id!=? AND t.required_reviews>0
             AND NOT EXISTS (
               SELECT 1 FROM work_reviews AS own
               WHERE own.submission_id=s.id AND own.reviewer_session_id=?
             )
             AND NOT EXISTS (
               SELECT 1 FROM work_reviews AS terminal
               WHERE terminal.submission_id=s.id AND terminal.decision IN ('revise','reject')
             )
             AND (
               SELECT COUNT(*) FROM work_reviews AS accepted
               WHERE accepted.submission_id=s.id AND accepted.decision='accept'
             ) < t.required_reviews
           ORDER BY s.created_at,s.id`,
        ).all(workId, actorSessionId, actorSessionId) as SubmissionRow[];
      for (const submission of reviewableRows) {
        this.#canonicalAttemptIdentity(submission.attempt_id, workId, submission.task_id);
      }
      const reviewable = take(reviewableRows, offsets.reviewableSubmissions, (row) => {
        const submission = this.#submissionRecord(row);
        if (submission.status !== "pending_review") {
          throw new Error("WORK_REVIEWABLE_SUBMISSION_PROJECTION_INVALID");
        }
        return {
          id: submission.id,
          taskId: submission.taskId,
          attemptId: submission.attemptId,
          status: submission.status,
          revision: submission.revision,
          contentDigest: submission.contentDigest,
          requiredReviews: submission.requiredReviews,
          acceptedReviews: submission.acceptedReviews,
          createdAt: submission.createdAt,
          updatedAt: submission.updatedAt,
        };
      });
      const signalCount = actorSessionId === undefined
        ? 0
        : (this.#database.query(
          `SELECT COUNT(*) AS count FROM work_signals AS s
           WHERE s.work_id=? AND s.to_session_id=?
             AND NOT EXISTS (
               SELECT 1 FROM work_signal_receipts AS r
               WHERE r.signal_id=s.id AND r.kind='ack'
             )`,
        ).get(workId, actorSessionId) as { count: number } | null)?.count ?? 0;
      if (offsets.signals > signalCount) throw new WorkStoreError("BAD_CURSOR");
      const signalRows = actorSessionId === undefined || remainingItems === 0
        ? []
        : this.#database.query(
          `SELECT s.id FROM work_signals AS s
           WHERE s.work_id=? AND s.to_session_id=?
             AND NOT EXISTS (
               SELECT 1 FROM work_signal_receipts AS r
               WHERE r.signal_id=s.id AND r.kind='ack'
             )
           ORDER BY s.created_at,s.id LIMIT ? OFFSET ?`,
        ).all(
          workId,
          actorSessionId,
          remainingItems,
          offsets.signals,
        ) as Array<{ id: string }>;
      const signals = signalRows.map((row) => this.#signalRecord(row.id));
      remainingItems -= signals.length;
      const effectFilter = actorSessionId === undefined
        ? "e.work_id=? AND e.state IN ('prepared','effect_started','unknown')"
        : `e.work_id=? AND e.state IN ('prepared','effect_started','unknown') AND (
             (e.effect_kind='attempt_dispatch' AND EXISTS (
               SELECT 1 FROM work_attempts AS a
               WHERE a.id=e.subject_id AND a.target_session_id=?
             )) OR
             (e.effect_kind='signal_send' AND EXISTS (
               SELECT 1 FROM work_signals AS s
               WHERE s.id=e.subject_id AND s.to_session_id=?
             ))
           )`;
      const effectParameters = actorSessionId === undefined
        ? [workId]
        : [workId, actorSessionId, actorSessionId];
      const effectCount = (this.#database.query(
        `SELECT COUNT(*) AS count FROM work_prepared_effects AS e WHERE ${effectFilter}`,
      ).get(...effectParameters) as { count: number } | null)?.count ?? 0;
      if (offsets.preparedEffects > effectCount) throw new WorkStoreError("BAD_CURSOR");
      const effects = remainingItems === 0
        ? []
        : actorSessionId === undefined
        ? this.#database.query(
          `SELECT * FROM work_prepared_effects AS e
           WHERE e.work_id=? AND e.state IN ('prepared','effect_started','unknown')
           ORDER BY prepared_at,idempotency_key LIMIT ? OFFSET ?`,
        ).all(workId, remainingItems, offsets.preparedEffects) as PreparedEffectRow[]
        : this.#database.query(
          `SELECT e.* FROM work_prepared_effects AS e
           WHERE e.work_id=? AND e.state IN ('prepared','effect_started','unknown') AND (
             (e.effect_kind='attempt_dispatch' AND EXISTS (
               SELECT 1 FROM work_attempts AS a
               WHERE a.id=e.subject_id AND a.target_session_id=?
             )) OR
             (e.effect_kind='signal_send' AND EXISTS (
               SELECT 1 FROM work_signals AS s
               WHERE s.id=e.subject_id AND s.to_session_id=?
             ))
           )
           ORDER BY e.prepared_at,e.idempotency_key LIMIT ? OFFSET ?`,
        ).all(
          workId,
          actorSessionId,
          actorSessionId,
          remainingItems,
          offsets.preparedEffects,
        ) as PreparedEffectRow[];
      const effectStatuses: WorkPreparedEffectStatus[] = [];
      for (const effect of effects) {
        const status = this.#effectStatusFromRow(effect);
        if (actorSessionId !== undefined && status.targetSessionId !== actorSessionId) continue;
        effectStatuses.push(status);
      }
      const wakeCandidates: number[] = [];
      if (work.state === "active") {
        for (const row of rows) {
          for (const candidate of [
            row.not_before,
            row.retry_not_before,
            row.claim_by,
            row.deadline,
          ]) {
            if (candidate !== null && candidate > now) wakeCandidates.push(candidate);
          }
        }
        const lease = this.#database.query(
          `SELECT MIN(lease_expires_at) AS wake_at FROM work_attempts
           WHERE work_id=? AND state IN ('claimed','dispatching','running') AND lease_expires_at>?`,
        ).get(workId, now) as { wake_at: number | null } | null;
        if (lease?.wake_at !== null && lease?.wake_at !== undefined) wakeCandidates.push(lease.wake_at);
        const deadline = this.#database.query(
          `SELECT MIN(t.deadline) AS wake_at FROM work_tasks AS t
           JOIN work_task_states AS s ON s.task_id=t.id
           WHERE t.work_id=? AND t.deadline>? AND s.state IN (
             'claimed','dispatching','running','submitted','recovery_required'
           )`,
        ).get(workId, now) as { wake_at: number | null } | null;
        if (deadline?.wake_at !== null && deadline?.wake_at !== undefined) {
          wakeCandidates.push(deadline.wake_at);
        }
      }
      const total = {
        readyTasks: allReadyTasks.length,
        ownedAttempts: allAttempts.length,
        recoveryAttempts: allRecoveryAttempts.length,
        reviewableSubmissions: reviewableRows.length,
        signals: signalCount,
        preparedEffects: effectCount,
      };
      for (const [section, offset] of Object.entries(offsets)) {
        if (offset > total[section as keyof typeof total]) throw new WorkStoreError("BAD_CURSOR");
      }
      const projected = {
        readyTasks,
        ownedAttempts: attempts,
        recoveryAttempts,
        reviewableSubmissions: reviewable,
        signals,
        preparedEffects: effectStatuses,
      };
      let eventLimit = bounded;
      let eventPage = this.#eventPage(workId, cursorSequence, eventLimit);
      const nextOffsets = () => ({
        readyTasks: offsets.readyTasks + projected.readyTasks.length,
        ownedAttempts: offsets.ownedAttempts + projected.ownedAttempts.length,
        recoveryAttempts: offsets.recoveryAttempts + projected.recoveryAttempts.length,
        reviewableSubmissions: offsets.reviewableSubmissions
          + projected.reviewableSubmissions.length,
        signals: offsets.signals + projected.signals.length,
        preparedEffects: offsets.preparedEffects + projected.preparedEffects.length,
      });
      const omitted = () => {
        const next = nextOffsets();
        return {
          readyTasks: total.readyTasks - next.readyTasks,
          ownedAttempts: total.ownedAttempts - next.ownedAttempts,
          recoveryAttempts: total.recoveryAttempts - next.recoveryAttempts,
          reviewableSubmissions: total.reviewableSubmissions - next.reviewableSubmissions,
          signals: total.signals - next.signals,
          preparedEffects: total.preparedEffects - next.preparedEffects,
        };
      };
      const nextActionCursor = (): string | null => {
        const remaining = omitted();
        if (!Object.values(remaining).some((count) => count > 0)) return null;
        return this.#encodeCursor(workActionCursorPayloadSchema.parse({
          version: 1,
          type: "work_actions",
          workId,
          streamEpoch: work.stream_epoch,
          sequence: headSequence,
          projectionAt: now,
          actorSessionId: actorSessionId ?? null,
          offsets: nextOffsets(),
        }));
      };
      const candidate = (): Record<string, unknown> => ({
        version: 1,
        workId,
        actorSessionId: actorSessionId ?? null,
        workRevision: work.revision,
        status: this.#workRecord(workId, now).status,
        nextWakeAt: wakeCandidates.length === 0 ? null : Math.min(...wakeCandidates),
        requestedActionCursor: parsedActionCursor?.success === true
          ? this.#encodeCursor(parsedActionCursor.data)
          : null,
        nextActionCursor: nextActionCursor(),
        ...projected,
        omitted: omitted(),
        eventPage,
      });
      const actionLists = [
        projected.preparedEffects,
        projected.signals,
        projected.reviewableSubmissions,
        projected.recoveryAttempts,
        projected.ownedAttempts,
        projected.readyTasks,
      ];
      while (workReadSuccessWireBytes("work.poll", candidate()) > WORK_POLL_MAX_BYTES) {
        if (eventPage.events.length > 1) {
          eventLimit = Math.max(1, Math.floor(eventPage.events.length / 2));
          eventPage = this.#eventPage(workId, cursorSequence, eventLimit);
          continue;
        }
        const latest = actionLists.find((list) => list.length > 0);
        if (latest === undefined) {
          throw new Error("WORK_POLL_BYTE_BUDGET_IMPOSSIBLE");
        }
        latest.pop();
      }
      return workPollSchema.parse(candidate());
    });
    return read.deferred();
  }
}
