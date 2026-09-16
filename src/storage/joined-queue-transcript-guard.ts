import type { Database } from "bun:sqlite";
import { z } from "zod";

import { normalizeSchemaSql } from "./schema-cohort";

const name = "queue_transcript_finalization_guard";
const invalid = (): never => { throw new Error("JOINED_QUEUE_TRANSCRIPT_GUARD_INVALID"); };

/** Only the pending connection-capture branch changes. The frozen predecessor
 * remains the historical recognizer; terminal and content-preservation clauses
 * are byte-preserved. A queued request never gains a different provider tuple. */
export function joinedQueueTranscriptGuardSql(predecessor: string): string {
  const before = `    AND json_extract(NEW.transcript_intent_json,'$.accountId')=(
      SELECT s.profile_id FROM sessions s WHERE s.id=NEW.session_id)
    AND json_extract(NEW.transcript_intent_json,'$.providerGeneration')=(
      SELECT p.process_generation FROM sessions s JOIN profiles p
      ON p.id=s.profile_id WHERE s.id=NEW.session_id)`;
  if (predecessor.split(before).length !== 2) return invalid();
  return predecessor.replace(before, `    AND EXISTS(
      SELECT 1 FROM queue_provider_authorities captured
      JOIN session_provider_authorities current ON current.session_id=NEW.session_id
      JOIN sessions s ON s.id=current.session_id
      JOIN provider_accounts account ON account.id=captured.provider_account_id
      JOIN profiles profile ON profile.id=captured.profile_id
      WHERE captured.queue_id=NEW.id AND NEW.session_id=OLD.session_id
        AND captured.provider IN ('codex','claude','devin')
        AND s.profile_id=captured.profile_id AND s.provider_v39=captured.provider
        AND current.provider_account_id=captured.provider_account_id
        AND current.profile_id=captured.profile_id AND current.provider=captured.provider
        AND current.binding_generation=captured.binding_generation
        AND current.process_generation=captured.process_generation
        AND account.profile_id=captured.profile_id AND account.provider=captured.provider
        AND account.binding_generation=captured.binding_generation
        AND account.process_generation=captured.process_generation
        AND account.readiness!='removed' AND profile.state!='removed'
        AND json_extract(OLD.transcript_intent_json,'$.accountId')=captured.profile_id
        AND json_extract(OLD.transcript_intent_json,'$.providerGeneration')=captured.process_generation
        AND json_extract(NEW.transcript_intent_json,'$.accountId')=captured.profile_id
        AND json_extract(NEW.transcript_intent_json,'$.providerGeneration')=captured.process_generation
    )`);
}

function observed(database: Database): string {
  const count = z.object({ n: z.literal(1) }).strict().safeParse(database.query(`SELECT count(*) AS n FROM (
    SELECT 1 FROM sqlite_master WHERE name=? COLLATE NOCASE
    UNION ALL SELECT 1 FROM sqlite_temp_master WHERE name=? COLLATE NOCASE)`).get(name, name));
  if (!count.success) return invalid();
  const row = z.object({ type: z.literal("trigger"), name: z.literal(name),
    tbl_name: z.literal("queue_entries"), sql: z.string().max(131_072),
  }).strict().safeParse(database.query(`SELECT type,name,
    CASE WHEN length(CAST(tbl_name AS BLOB))<=128 THEN tbl_name ELSE NULL END AS tbl_name,
    CASE WHEN length(CAST(sql AS BLOB))<=131072 THEN sql ELSE NULL END AS sql
    FROM (SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name=? COLLATE NOCASE
      UNION ALL SELECT type,name,tbl_name,sql FROM sqlite_temp_master WHERE name=? COLLATE NOCASE) LIMIT 1`).get(name, name));
  if (!row.success) return invalid();
  return row.data.sql;
}

export function assertJoinedQueueTranscriptGuard(database: Database, predecessor: string): void {
  if (normalizeSchemaSql(observed(database)) !== normalizeSchemaSql(joinedQueueTranscriptGuardSql(predecessor))) invalid();
}

export function applyJoinedQueueTranscriptGuard(database: Database, predecessor: string): void {
  if (!database.inTransaction) invalid();
  const original = observed(database);
  const joined = joinedQueueTranscriptGuardSql(predecessor);
  if (normalizeSchemaSql(original) === normalizeSchemaSql(joined)) return assertJoinedQueueTranscriptGuard(database, predecessor);
  if (normalizeSchemaSql(original) !== normalizeSchemaSql(predecessor)) invalid();
  database.exec(`DROP TRIGGER ${name}`);
  database.exec(joined);
  assertJoinedQueueTranscriptGuard(database, predecessor);
}
