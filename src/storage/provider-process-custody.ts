import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { z } from "zod";

import { snapshotForeignJson } from "../domain/guards";
import { nativePreparedOfReady, nativePreparedSchema, nativeReadySchema,
  type NativePrepared, type NativeReady } from "../domain/native-process-identity";
import { providerAccountIdSchema, type ProviderAccountAuthority } from "../domain/provider-accounts";
import { providerProcessDaemonSchema, providerProcessDigestSchema, providerProcessNonceSchema,
  providerProcessReleaseEvidenceSchema, providerProcessReservationSchema, readProviderProcessReleaseProof,
  providerProcessLaunchContextSchema,
  type ProviderProcessDaemon, type ProviderProcessInvocation, type ProviderProcessReleaseEvidence,
  type ProviderProcessReleaseProof, type ProviderProcessReservation, type ProviderProcessTransition,
  type ProviderProcessLaunchContext, type ProviderProcessLocalFiles, type ProviderProcessRecoveryActor,
  type ProviderProcessRecoveryTransition,
} from "../domain/provider-process-custody";
import { profileIdSchema, unixMillisecondsSchema } from "../domain/values";
import { assertSchemaCohortObjects, schemaCohortObjects } from "./schema-cohort";

const schema = `
CREATE TABLE provider_process_invocations (
  nonce TEXT PRIMARY KEY CHECK(length(nonce)=32 AND nonce NOT GLOB '*[^a-f0-9]*'),
  provider_account_id TEXT NOT NULL REFERENCES provider_accounts(id),
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  provider TEXT NOT NULL CHECK(provider IN ('codex','claude')),
  runtime_scope TEXT NOT NULL CHECK(runtime_scope IN ('managed','personal')),
  reservation_json TEXT NOT NULL CHECK(json_valid(reservation_json) AND length(CAST(reservation_json AS BLOB))<=2048),
  binding_digest TEXT NOT NULL CHECK(length(binding_digest)=64 AND binding_digest NOT GLOB '*[^a-f0-9]*'),
  state TEXT NOT NULL CHECK(state IN ('reserved','prepared','running','releasing','released')),
  revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 5),
  prepared_json TEXT CHECK(prepared_json IS NULL OR (json_valid(prepared_json) AND length(CAST(prepared_json AS BLOB))<=4096)),
  ready_json TEXT CHECK(ready_json IS NULL OR (json_valid(ready_json) AND length(CAST(ready_json AS BLOB))<=4096)),
  release_json TEXT CHECK(release_json IS NULL OR (json_valid(release_json) AND length(CAST(release_json AS BLOB))<=8192)),
  created_at INTEGER NOT NULL CHECK(created_at BETWEEN 0 AND 9007199254740991),
  updated_at INTEGER NOT NULL CHECK(updated_at BETWEEN created_at AND 9007199254740991),
  released_at INTEGER CHECK(released_at IS NULL OR released_at=updated_at),
  CHECK(ready_json IS NULL OR prepared_json IS NOT NULL),
  CHECK((state='released' AND release_json IS NOT NULL AND released_at IS NOT NULL)
    OR (state!='released' AND release_json IS NULL AND released_at IS NULL)),
  CHECK((state='reserved' AND revision=1 AND prepared_json IS NULL AND ready_json IS NULL)
    OR (state='prepared' AND revision=2 AND prepared_json IS NOT NULL AND ready_json IS NULL)
    OR (state='running' AND revision=3 AND prepared_json IS NOT NULL AND ready_json IS NOT NULL)
    OR (state='releasing' AND revision=2+(prepared_json IS NOT NULL)+(ready_json IS NOT NULL))
    OR (state='released' AND revision=3+(prepared_json IS NOT NULL)+(ready_json IS NOT NULL)))
) STRICT;
CREATE UNIQUE INDEX provider_process_invocations_active_scope
ON provider_process_invocations(provider_account_id,runtime_scope) WHERE state!='released';
CREATE INDEX provider_process_invocations_unreleased
ON provider_process_invocations(nonce) WHERE state!='released';
CREATE TRIGGER provider_process_invocations_insert
BEFORE INSERT ON provider_process_invocations
WHEN NEW.state!='reserved' OR NEW.revision!=1
  OR (SELECT COUNT(*) FROM (SELECT 1 FROM provider_process_invocations WHERE state!='released' LIMIT 256))>=256
BEGIN SELECT RAISE(ABORT,'PROVIDER_PROCESS_CUSTODY_ADMISSION'); END;
CREATE TRIGGER provider_process_invocations_transition
BEFORE UPDATE ON provider_process_invocations
WHEN NEW.nonce IS NOT OLD.nonce OR NEW.provider_account_id IS NOT OLD.provider_account_id
  OR NEW.profile_id IS NOT OLD.profile_id OR NEW.provider IS NOT OLD.provider
  OR NEW.runtime_scope IS NOT OLD.runtime_scope OR NEW.reservation_json IS NOT OLD.reservation_json
  OR NEW.binding_digest IS NOT OLD.binding_digest OR NEW.created_at IS NOT OLD.created_at
  OR NEW.updated_at<OLD.updated_at OR NEW.revision!=OLD.revision+1
  OR (OLD.prepared_json IS NOT NULL AND NEW.prepared_json IS NOT OLD.prepared_json)
  OR (OLD.ready_json IS NOT NULL AND NEW.ready_json IS NOT OLD.ready_json)
  OR NOT ((OLD.state='reserved' AND NEW.state IN ('prepared','releasing'))
    OR (OLD.state='prepared' AND NEW.state IN ('running','releasing'))
    OR (OLD.state='running' AND NEW.state='releasing')
    OR (OLD.state='releasing' AND NEW.state='released'))
  OR (NEW.prepared_json IS NOT OLD.prepared_json AND NEW.state!='prepared')
  OR (NEW.ready_json IS NOT OLD.ready_json AND NEW.state!='running')
BEGIN SELECT RAISE(ABORT,'PROVIDER_PROCESS_CUSTODY_TRANSITION'); END;
CREATE TRIGGER provider_process_invocations_delete
BEFORE DELETE ON provider_process_invocations
BEGIN SELECT RAISE(ABORT,'PROVIDER_PROCESS_CUSTODY_RETAINED'); END;
`;
export const PROVIDER_PROCESS_CUSTODY_OBJECTS = schemaCohortObjects(schema);

type CustodyErrorCode = "PROVIDER_PROCESS_CUSTODY_INVALID" | "PROVIDER_PROCESS_CUSTODY_CORRUPT"
  | "PROVIDER_PROCESS_CUSTODY_STALE" | "PROVIDER_PROCESS_CUSTODY_BLOCKED"
  | "PROVIDER_PROCESS_CUSTODY_UNPROVED" | "PROVIDER_PROCESS_CUSTODY_MISSING";
export class ProviderProcessCustodyError extends Error {
  constructor(readonly code: CustodyErrorCode) { super(code); this.name = "ProviderProcessCustodyError"; }
}
function fail(code: CustodyErrorCode): never { throw new ProviderProcessCustodyError(code); }
const parse = <T>(codec: z.ZodType<T>, input: unknown): T => {
  try {
    const snapshot = snapshotForeignJson(input);
    if (!snapshot.ok) return fail("PROVIDER_PROCESS_CUSTODY_INVALID");
    return codec.parse(snapshot.value);
  }
  catch { return fail("PROVIDER_PROCESS_CUSTODY_INVALID"); }
};
const decode = <T>(codec: z.ZodType<T>, text: string): T => {
  try { return codec.parse(JSON.parse(text) as unknown); }
  catch { return fail("PROVIDER_PROCESS_CUSTODY_CORRUPT"); }
};
const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);
const bindingDigest = (reservation: ProviderProcessReservation, createdAt: number): string =>
  createHash("sha256").update(JSON.stringify({ domain: "oompa.provider-process-custody.v1", reservation, createdAt })).digest("hex");

export function assertProviderProcessCustodyAbsent(db: Database): void {
  if (db.query("SELECT 1 FROM sqlite_master WHERE name GLOB 'provider_process_invocations*' LIMIT 1").get() !== null) {
    fail("PROVIDER_PROCESS_CUSTODY_CORRUPT");
  }
}
export function applyProviderProcessCustody(db: Database): void {
  assertProviderProcessCustodyAbsent(db);
  db.exec(schema);
  assertProviderProcessCustodySchema(db);
}
export function assertProviderProcessCustodySchema(db: Database): void {
  try {
    assertSchemaCohortObjects(db, PROVIDER_PROCESS_CUSTODY_OBJECTS, "provider_process61");
    const names = z.array(z.object({ name: z.string() }).strict()).parse(db.query(
      "SELECT name FROM sqlite_master WHERE tbl_name='provider_process_invocations' AND sql IS NOT NULL ORDER BY name",
    ).all()).map(value => value.name);
    if (!same(names, PROVIDER_PROCESS_CUSTODY_OBJECTS.map(value => value.name).sort())) fail("PROVIDER_PROCESS_CUSTODY_CORRUPT");
  }
  catch { fail("PROVIDER_PROCESS_CUSTODY_CORRUPT"); }
}

const rowSchema = z.object({ nonce: providerProcessNonceSchema, provider_account_id: providerAccountIdSchema,
  profile_id: profileIdSchema, provider: z.enum(["codex", "claude"]), runtime_scope: z.enum(["managed", "personal"]),
  reservation_json: z.string().max(2048), binding_digest: providerProcessDigestSchema,
  state: z.enum(["reserved", "prepared", "running", "releasing", "released"]),
  revision: z.number().int().min(1).max(5), prepared_json: z.string().max(4096).nullable(),
  ready_json: z.string().max(4096).nullable(), release_json: z.string().max(8192).nullable(),
  created_at: unixMillisecondsSchema, updated_at: unixMillisecondsSchema, released_at: unixMillisecondsSchema.nullable(),
}).strict();

function assertReleaseBinding(record: ProviderProcessInvocation, evidence: ProviderProcessReleaseEvidence): void {
  if (evidence.nonce !== record.nonce || evidence.bindingDigest !== record.bindingDigest
    || evidence.expectedRevision !== (record.state === "released" ? record.revision - 1 : record.revision)) {
    fail("PROVIDER_PROCESS_CUSTODY_UNPROVED");
  }
  switch (evidence.kind) {
    case "native-settled": {
      const observed = evidence.observed;
      if (!same(evidence.actor.daemon, record.daemon)
        || !same(evidence.committedPrepared, record.prepared) || !same(evidence.committedReady, record.ready)
        || observed.binding.nonce !== record.nonce
        || (record.prepared !== null && !same(record.prepared, observed.prepared))
        || (record.ready !== null && !same(record.ready, observed.ready))
        || (observed.prepared !== null && (observed.prepared.nonce !== record.nonce
          || !same(observed.prepared.boot, record.launchContext.boot)))
        || (observed.ready !== null && (observed.prepared === null
          || !same(nativePreparedOfReady(observed.ready), observed.prepared)))
        || (observed.kind === "joined" && record.prepared === null)
        || (observed.kind === "not-started" && observed.ready !== null)) fail("PROVIDER_PROCESS_CUSTODY_UNPROVED");
      break;
    }
    case "activation-never-admitted":
      if (record.prepared !== null || record.ready !== null
        || !same(evidence.observedContext, record.launchContext)) fail("PROVIDER_PROCESS_CUSTODY_UNPROVED");
      break;
    case "scope-absent":
      if (record.prepared === null || !same(evidence.committedPrepared, record.prepared)
        || !same(evidence.committedReady, record.ready)
        || !same(evidence.observedContext, record.launchContext)) fail("PROVIDER_PROCESS_CUSTODY_UNPROVED");
      break;
    case "boot-ended":
      if (!same(evidence.committedPrepared, record.prepared) || !same(evidence.committedReady, record.ready)
        || !same(evidence.observedContext.host, record.launchContext.host)
        || evidence.observedContext.boot.platform !== record.launchContext.boot.platform
        || evidence.observedContext.boot.id === record.launchContext.boot.id) fail("PROVIDER_PROCESS_CUSTODY_UNPROVED");
      break;
  }
  if (evidence.actor.kind === "startup-recovery"
    && (evidence.actor.previousDaemon.generation !== record.daemon.daemonGeneration
      || evidence.actor.previousDaemon.bootId !== record.daemon.bootId)) fail("PROVIDER_PROCESS_CUSTODY_UNPROVED");
}

function mapRow(value: unknown): ProviderProcessInvocation {
  try {
    const row = rowSchema.parse(value);
    const reservation = decode(providerProcessReservationSchema, row.reservation_json);
    const prepared = row.prepared_json === null ? null : decode(nativePreparedSchema, row.prepared_json);
    const ready = row.ready_json === null ? null : decode(nativeReadySchema, row.ready_json);
    const releaseEvidence = row.release_json === null ? null : decode(providerProcessReleaseEvidenceSchema, row.release_json);
    const record: ProviderProcessInvocation = { ...reservation, bindingDigest: row.binding_digest,
      state: row.state, revision: row.revision, prepared, ready, releaseEvidence,
      createdAt: row.created_at, updatedAt: row.updated_at, releasedAt: row.released_at };
    if (record.nonce !== row.nonce || reservation.providerAuthority.providerAccountId !== row.provider_account_id
      || reservation.providerAuthority.profileId !== row.profile_id || reservation.providerAuthority.provider !== row.provider
      || reservation.runtimeScope !== row.runtime_scope || bindingDigest(reservation, row.created_at) !== row.binding_digest
      || row.updated_at < row.created_at || (prepared !== null && (prepared.nonce !== record.nonce
        || !same(prepared.boot, record.launchContext.boot)))
      || (ready !== null && (prepared === null || !same(nativePreparedOfReady(ready), prepared)))
      || (row.state === "reserved" && (prepared !== null || ready !== null || row.revision !== 1))
      || (row.state === "prepared" && (prepared === null || ready !== null || row.revision !== 2))
      || (row.state === "running" && (prepared === null || ready === null || row.revision !== 3))
      || (row.state === "releasing" && row.revision !== 2 + Number(prepared !== null) + Number(ready !== null))
      || (row.state === "released" && row.revision !== 3 + Number(prepared !== null) + Number(ready !== null))
      || (row.state === "released" ? releaseEvidence === null || row.released_at !== row.updated_at
        : releaseEvidence !== null || row.released_at !== null)) fail("PROVIDER_PROCESS_CUSTODY_CORRUPT");
    if (releaseEvidence !== null) assertReleaseBinding(record, releaseEvidence);
    return record;
  } catch { return fail("PROVIDER_PROCESS_CUSTODY_CORRUPT"); }
}

export function readProviderProcessInvocation(db: Database, nonce: string): ProviderProcessInvocation | null {
  const key = parse(providerProcessNonceSchema, nonce);
  assertProviderProcessCustodySchema(db);
  const row = db.query("SELECT * FROM provider_process_invocations WHERE nonce=?").get(key);
  return row === null ? null : mapRow(row);
}
export type ListProviderProcessInvocations = Readonly<{ afterNonce?: string; limit?: number;
  providerAccountId?: string; runtimeScope?: "managed" | "personal" }>;
export function listUnreleasedProviderProcessInvocations(db: Database, input: ListProviderProcessInvocations = {}): readonly ProviderProcessInvocation[] {
  const parsed = parse(z.object({ afterNonce: providerProcessNonceSchema.optional(), limit: z.number().int().min(1).max(256).optional(),
    providerAccountId: providerAccountIdSchema.optional(), runtimeScope: z.enum(["managed", "personal"]).optional() }).strict(), input);
  assertProviderProcessCustodySchema(db);
  return db.query(`SELECT * FROM provider_process_invocations WHERE state!='released' AND nonce>?
    AND (? IS NULL OR provider_account_id=?) AND (? IS NULL OR runtime_scope=?) ORDER BY nonce LIMIT ?`)
    .all(parsed.afterNonce ?? "", parsed.providerAccountId ?? null, parsed.providerAccountId ?? null,
      parsed.runtimeScope ?? null, parsed.runtimeScope ?? null, parsed.limit ?? 128).map(mapRow);
}
export function auditProviderProcessCustody(db: Database): void {
  assertProviderProcessCustodySchema(db);
  // Opening the store audits the bounded live authority, not every process
  // ever launched. The partial index excludes retained release history. Any
  // historical row actually consumed is independently validated by its reader.
  const rows = db.query("SELECT * FROM provider_process_invocations WHERE state!='released' ORDER BY nonce LIMIT 257").all();
  if (rows.length > 256) fail("PROVIDER_PROCESS_CUSTODY_CORRUPT");
  for (const row of rows) mapRow(row);
}
function assertDaemon(db: Database, daemon: ProviderProcessDaemon): void {
  if (db.query("SELECT 1 FROM daemon_state WHERE singleton=1 AND generation=? AND boot_id=? AND stopped_at IS NULL")
    .get(daemon.daemonGeneration, daemon.bootId) === null) fail("PROVIDER_PROCESS_CUSTODY_STALE");
}
const transitionSchema = z.object({ nonce: providerProcessNonceSchema,
  expectedRevision: z.number().int().min(1).max(5), daemon: providerProcessDaemonSchema }).strict();
function requireCurrent(db: Database, input: ProviderProcessTransition): ProviderProcessInvocation {
  assertDaemon(db, input.daemon);
  const current = readProviderProcessInvocation(db, input.nonce);
  if (current === null) fail("PROVIDER_PROCESS_CUSTODY_MISSING");
  if (current.revision !== input.expectedRevision) fail("PROVIDER_PROCESS_CUSTODY_STALE");
  return current;
}
function requireUpdated(db: Database, nonce: string): ProviderProcessInvocation {
  const record = readProviderProcessInvocation(db, nonce);
  if (record === null) fail("PROVIDER_PROCESS_CUSTODY_MISSING");
  return record;
}
type AssertAuthority = (authority: ProviderAccountAuthority) => void;
function assertLaunchAuthority(db: Database, current: ProviderProcessInvocation,
  daemon: ProviderProcessDaemon, assertAuthority: AssertAuthority): void {
  if (!same(current.daemon, daemon)) fail("PROVIDER_PROCESS_CUSTODY_STALE");
  assertAuthority(current.providerAuthority);
  if (db.query("SELECT 1 FROM profiles WHERE id=? AND process_generation=? AND state!='removed'")
    .get(current.providerAuthority.profileId, current.profileGeneration) === null) fail("PROVIDER_PROCESS_CUSTODY_STALE");
}

/** Read-only final authority check immediately before Activate or a native write. */
export function assertProviderProcessInvocationCurrent(db: Database,
  input: ProviderProcessTransition & { state: "prepared" | "running" }, assertAuthority: AssertAuthority): void {
  const parsed = parse(transitionSchema.extend({ state: z.enum(["prepared", "running"]) }), input);
  const current = requireCurrent(db, parsed);
  assertLaunchAuthority(db, current, parsed.daemon, assertAuthority);
  if (current.state !== parsed.state) fail("PROVIDER_PROCESS_CUSTODY_STALE");
}

export function reserveProviderProcessInvocation(db: Database, input: ProviderProcessReservation,
  now: number, assertAuthority: AssertAuthority): ProviderProcessInvocation {
  const parsed = parse(providerProcessReservationSchema, input);
  const at = parse(unixMillisecondsSchema, now);
  if (Buffer.byteLength(JSON.stringify(parsed)) > 2048) fail("PROVIDER_PROCESS_CUSTODY_INVALID");
  return db.transaction(() => {
    assertProviderProcessCustodySchema(db);
    assertDaemon(db, parsed.daemon);
    assertAuthority(parsed.providerAuthority);
    if (db.query("SELECT 1 FROM profiles WHERE id=? AND process_generation=? AND state!='removed'")
      .get(parsed.providerAuthority.profileId, parsed.profileGeneration) === null) fail("PROVIDER_PROCESS_CUSTODY_STALE");
    if (db.query("SELECT 1 FROM provider_process_invocations WHERE nonce=? OR (provider_account_id=? AND runtime_scope=? AND state!='released') LIMIT 1")
      .get(parsed.nonce, parsed.providerAuthority.providerAccountId, parsed.runtimeScope) !== null) fail("PROVIDER_PROCESS_CUSTODY_BLOCKED");
    const inserted = db.query(`INSERT INTO provider_process_invocations(nonce,provider_account_id,profile_id,provider,runtime_scope,
      reservation_json,binding_digest,state,revision,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,'reserved',1,?,?)`).run(parsed.nonce, parsed.providerAuthority.providerAccountId,
      parsed.providerAuthority.profileId, parsed.providerAuthority.provider, parsed.runtimeScope,
      JSON.stringify(parsed), bindingDigest(parsed, at), at, at);
    if (inserted.changes !== 1) fail("PROVIDER_PROCESS_CUSTODY_STALE");
    return requireUpdated(db, parsed.nonce);
  }).immediate();
}

export function prepareProviderProcessInvocation(db: Database, input: ProviderProcessTransition & { prepared: NativePrepared },
  now: number, assertAuthority: AssertAuthority): ProviderProcessInvocation {
  const parsed = parse(transitionSchema.extend({ prepared: nativePreparedSchema }), input);
  const at = parse(unixMillisecondsSchema, now);
  return db.transaction(() => {
    const current = requireCurrent(db, parsed);
    assertLaunchAuthority(db, current, parsed.daemon, assertAuthority);
    if (current.state !== "reserved" || parsed.prepared.nonce !== current.nonce
      || !same(parsed.prepared.boot, current.launchContext.boot)) fail("PROVIDER_PROCESS_CUSTODY_STALE");
    const changed = db.query(`UPDATE provider_process_invocations SET state='prepared',revision=revision+1,prepared_json=?,updated_at=MAX(updated_at,?)
      WHERE nonce=? AND revision=?`).run(JSON.stringify(parsed.prepared), at, parsed.nonce, parsed.expectedRevision);
    if (changed.changes !== 1) fail("PROVIDER_PROCESS_CUSTODY_STALE");
    return requireUpdated(db, parsed.nonce);
  }).immediate();
}
export function markProviderProcessInvocationRunning(db: Database, input: ProviderProcessTransition & { ready: NativeReady },
  now: number, assertAuthority: AssertAuthority): ProviderProcessInvocation {
  const parsed = parse(transitionSchema.extend({ ready: nativeReadySchema }), input);
  const at = parse(unixMillisecondsSchema, now);
  return db.transaction(() => {
    const current = requireCurrent(db, parsed);
    assertLaunchAuthority(db, current, parsed.daemon, assertAuthority);
    if (current.state !== "prepared" || !same(nativePreparedOfReady(parsed.ready), current.prepared)) fail("PROVIDER_PROCESS_CUSTODY_STALE");
    const changed = db.query(`UPDATE provider_process_invocations SET state='running',revision=revision+1,ready_json=?,updated_at=MAX(updated_at,?)
      WHERE nonce=? AND revision=?`).run(JSON.stringify(parsed.ready), at, parsed.nonce, parsed.expectedRevision);
    if (changed.changes !== 1) fail("PROVIDER_PROCESS_CUSTODY_STALE");
    return requireUpdated(db, parsed.nonce);
  }).immediate();
}
export function beginProviderProcessInvocationRelease(db: Database, input: ProviderProcessTransition, now: number): ProviderProcessInvocation {
  const parsed = parse(transitionSchema, input);
  const at = parse(unixMillisecondsSchema, now);
  return db.transaction(() => {
    const current = requireCurrent(db, parsed);
    if (current.state === "released") fail("PROVIDER_PROCESS_CUSTODY_STALE");
    if (current.state === "releasing") return current;
    const changed = db.query(`UPDATE provider_process_invocations SET state='releasing',revision=revision+1,updated_at=MAX(updated_at,?)
      WHERE nonce=? AND revision=?`).run(at, parsed.nonce, parsed.expectedRevision);
    if (changed.changes !== 1) fail("PROVIDER_PROCESS_CUSTODY_STALE");
    return requireUpdated(db, parsed.nonce);
  }).immediate();
}
export function releaseProviderProcessInvocation(db: Database, input: ProviderProcessTransition & { proof: ProviderProcessReleaseProof },
  now: number): ProviderProcessInvocation {
  // The proof is deliberately excluded from JSON snapshot/parsing. A copied or
  // deserialized object cannot acquire the host issuer's WeakMap membership.
  const parsed = parse(transitionSchema, { nonce: input.nonce, expectedRevision: input.expectedRevision, daemon: input.daemon });
  const evidence = readProviderProcessReleaseProof(input.proof);
  const at = parse(unixMillisecondsSchema, now);
  return db.transaction(() => {
    const current = requireCurrent(db, parsed);
    if (current.state !== "releasing" || evidence.kind !== "native-settled"
      || !same(evidence.actor.daemon, parsed.daemon)) fail("PROVIDER_PROCESS_CUSTODY_STALE");
    const updatedAt = Math.max(at, current.updatedAt);
    assertReleaseBinding({ ...current, updatedAt }, evidence);
    const changed = db.query(`UPDATE provider_process_invocations SET state='released',revision=revision+1,release_json=?,updated_at=?,released_at=?
      WHERE nonce=? AND revision=?`).run(JSON.stringify(evidence), updatedAt, updatedAt, parsed.nonce, parsed.expectedRevision);
    if (changed.changes !== 1) fail("PROVIDER_PROCESS_CUSTODY_STALE");
    return requireUpdated(db, parsed.nonce);
  }).immediate();
}

type AssertRecoveryAuthority = () => Readonly<{
  actor: ProviderProcessRecoveryActor; localFiles: ProviderProcessLocalFiles;
}>;
const recoveryTransitionSchema = z.object({ nonce: providerProcessNonceSchema,
  expectedRevision: z.number().int().min(1).max(5) }).strict();

/** The partial index keeps retained release history out of startup work. */
export function assertProviderProcessInvocationsReleased(db: Database): void {
  assertProviderProcessCustodySchema(db);
  if (db.query("SELECT 1 FROM provider_process_invocations WHERE state!='released' LIMIT 1").get() !== null) {
    fail("PROVIDER_PROCESS_CUSTODY_BLOCKED");
  }
}
function requireRecoveryCurrent(db: Database, input: ProviderProcessRecoveryTransition,
  actor: ProviderProcessRecoveryActor): ProviderProcessInvocation {
  const previous = actor.previousDaemon;
  if (db.query(`SELECT 1 FROM daemon_state WHERE singleton=1 AND generation=? AND boot_id IS ? AND stopped_at IS ?`)
    .get(previous.generation, previous.bootId, previous.stoppedAt) === null) fail("PROVIDER_PROCESS_CUSTODY_STALE");
  const record = readProviderProcessInvocation(db, input.nonce);
  if (record === null) fail("PROVIDER_PROCESS_CUSTODY_MISSING");
  if (record.revision !== input.expectedRevision || record.state === "released") fail("PROVIDER_PROCESS_CUSTODY_STALE");
  return record;
}
function enterRecoveryRelease(db: Database, current: ProviderProcessInvocation, at: number): ProviderProcessInvocation {
  if (current.state === "releasing") return current;
  const changed = db.query(`UPDATE provider_process_invocations SET state='releasing',revision=revision+1,updated_at=MAX(updated_at,?)
    WHERE nonce=? AND revision=?`).run(at, current.nonce, current.revision);
  if (changed.changes !== 1) fail("PROVIDER_PROCESS_CUSTODY_STALE");
  return requireUpdated(db, current.nonce);
}
function commitRecoveryRelease(db: Database, current: ProviderProcessInvocation,
  evidence: ProviderProcessReleaseEvidence, at: number): ProviderProcessInvocation {
  const updatedAt = Math.max(at, current.updatedAt);
  assertReleaseBinding({ ...current, updatedAt }, evidence);
  const changed = db.query(`UPDATE provider_process_invocations SET state='released',revision=revision+1,release_json=?,updated_at=?,released_at=?
    WHERE nonce=? AND revision=?`).run(JSON.stringify(evidence), updatedAt, updatedAt, current.nonce, current.revision);
  if (changed.changes !== 1) fail("PROVIDER_PROCESS_CUSTODY_STALE");
  return requireUpdated(db, current.nonce);
}

/** Logical fencing only: this never fabricates helper collection or stream EOF. */
export function recoverUnpreparedProviderProcessInvocation(db: Database,
  input: ProviderProcessRecoveryTransition & { currentContext: ProviderProcessLaunchContext }, now: number,
  assertAuthority: AssertRecoveryAuthority): ProviderProcessInvocation {
  const parsed = parse(recoveryTransitionSchema.extend({ currentContext: providerProcessLaunchContextSchema }), input);
  const at = parse(unixMillisecondsSchema, now);
  return db.transaction(() => {
    const held = assertAuthority();
    const current = requireRecoveryCurrent(db, parsed, held.actor);
    if (current.prepared !== null || current.ready !== null
      || !same(parsed.currentContext.localFiles, held.localFiles)) fail("PROVIDER_PROCESS_CUSTODY_UNPROVED");
    const releasing = enterRecoveryRelease(db, current, at);
    const evidence: ProviderProcessReleaseEvidence = {
      kind: "activation-never-admitted", nonce: current.nonce, bindingDigest: current.bindingDigest,
      expectedRevision: releasing.revision, observedAt: at, actor: held.actor, observedContext: parsed.currentContext,
    };
    assertAuthority();
    return commitRecoveryRelease(db, releasing, evidence, at);
  }).immediate();
}

/** No saved identity here authorizes a signal; the nominal observer proves absence. */
export function recoverObservedProviderProcessInvocation(db: Database,
  input: ProviderProcessRecoveryTransition & { proof: ProviderProcessReleaseProof }, now: number,
  assertAuthority: AssertRecoveryAuthority): ProviderProcessInvocation {
  const parsed = parse(recoveryTransitionSchema, { nonce: input.nonce, expectedRevision: input.expectedRevision });
  const evidence = readProviderProcessReleaseProof(input.proof);
  const at = parse(unixMillisecondsSchema, now);
  return db.transaction(() => {
    const held = assertAuthority();
    const current = requireRecoveryCurrent(db, parsed, held.actor);
    if ((evidence.kind !== "scope-absent" && evidence.kind !== "boot-ended")
      || !same(evidence.actor, held.actor)
      || !same(evidence.observedContext.localFiles, held.localFiles)) fail("PROVIDER_PROCESS_CUSTODY_UNPROVED");
    const releasing = enterRecoveryRelease(db, current, at);
    assertAuthority();
    return commitRecoveryRelease(db, releasing, evidence, at);
  }).immediate();
}
