import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import { canonical41TimestampsDatabaseBytes, canonical41TimestampsFixture } from "../../scripts/fixtures/canonical41-timestamps";
import { readMutationEffectEvidenceProvenance } from "./effect-evidence-provenance";
import { joinedMutationEffectEvidenceSchema } from "./joined-effect-evidence-codecs";
import { initializeStatePaths, resolveStatePaths } from "./paths";
import { StateStore } from "./state-store";

const recordedAt = 1_900_000_000_000;
const options = { now: () => recordedAt, resolveMachineTimeZone: () => "UTC" };
const hash = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
const rowSchema = z.record(z.string(), z.unknown());
const evidenceRowSchema = z.object({
  attempt_id: z.string(),
  kind: z.string(),
  evidence_json: z.string(),
  evidence_digest: z.string(),
  recorded_at: z.number(),
}).strict();
type GenericKind = "session.stop" | "session.rename";
type GenericEvidence = Extract<
  Parameters<StateStore["beginSessionMutationEffect"]>[0]["evidence"],
  { kind: GenericKind }
>;

const snapshot = (database: Database) => {
  const tables = z.object({ name: z.string().regex(/^[a-z][a-z0-9_]*$/u) }).strict().array().parse(
    database.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name LIMIT 513").all(),
  );
  expect(tables.length).toBeLessThanOrEqual(512);
  const rows: Record<string, z.infer<typeof rowSchema>[]> = {};
  for (const { name } of tables) {
    const values = rowSchema.array().parse(database.query(`SELECT * FROM "${name}" LIMIT 4097`).all());
    expect(values.length).toBeLessThanOrEqual(4096);
    rows[name] = values.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  }
  const value = {
    version: database.query("PRAGMA user_version").get(),
    ledger: database.query("SELECT version,applied_at FROM migrations ORDER BY version").all(),
    schema: database.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all(),
    foreignKeys: database.query("PRAGMA foreign_key_check").all(),
    rows,
  };
  expect(value.foreignKeys).toEqual([]);
  expect(Buffer.byteLength(JSON.stringify(value), "utf8")).toBeLessThanOrEqual(16 * 1024 * 1024);
  return value;
};

const stageEffect = (store: StateStore, profile: ReturnType<StateStore["requireProfile"]>, kind: GenericKind, suffix: string, marked = false) => {
  const providerThreadId = `synthetic-evidence-admission-${suffix}`;
  const session = store.upsertProviderSession({
    profileId: profile.id,
    provider: "codex",
    providerAuthority: store.requireProviderAccountAuthority(profile.id, "codex"),
    providerAccountKey: `v1:codex:${hash("evidence-admission@example.com")}`,
    providerThreadId,
    preset: "high",
    fastEnabled: false,
    state: "idle",
    title: "Before rename",
    providerUpdatedAt: 10,
  });
  const key = suffix === "sentinel"
    ? "49000000-0000-4000-8000-000000000002"
    : "49000000-0000-4000-8000-000000000001";
  const attempt = store.prepareMutation({
    kind,
    authorityId: session.id,
    authorityGeneration: profile.processGeneration,
    request: kind === "session.stop" ? {} : { name: "After rename" },
    idempotencyKey: key,
  });
  const baseline = { providerUpdatedAt: 10, status: "idle" as const, activeTurnId: null };
  const timestamp = marked ? { providerTimestampUnit: "unix_milliseconds_v1" as const } : {};
  const evidence: GenericEvidence = kind === "session.stop"
    ? { kind, providerThreadId, ...timestamp, baseline, activeTurnId: null }
    : { kind, providerThreadId, ...timestamp, baseline, requestedName: "After rename" };
  const record = store.beginSessionMutationEffect({
    attemptId: attempt.id,
    sessionId: session.id,
    profileGeneration: profile.processGeneration,
    providerAuthority: store.requireProviderAccountAuthority(profile.id, "codex"),
    evidence,
  });
  expect(store.readMutation(key)).toMatchObject({ state: "effect_started", evidence: record });
  expect(store.readLegacyProviderAuthorityQuarantine("mutation", attempt.id)).toBeNull();
  return { attempt, key, session, evidence, record };
};

const withEffectFixture = async (
  kind: GenericKind,
  run: (input: {
    paths: StateStore["paths"];
    database: Database;
    staged: ReturnType<typeof stageEffect>;
  }) => Promise<void>,
): Promise<void> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "oompa-effect-evidence-admission-")));
  let store: StateStore | undefined;
  let database: Database | undefined;
  try {
    const paths = resolveStatePaths({ rootDirectory: root });
    await initializeStatePaths(paths);
    store = new StateStore(paths, options);
    const created = store.createProfile("Evidence admission");
    const current = store.nextProfileGeneration(created.id);
    expect(store.setProfileState(current.id, current.processGeneration, "signed_in", {
      email: "evidence-admission@example.com", plan: "Plus",
    })).toBe(true);
    const profile = store.requireProfile(current.id);
    // Writable startup otherwise initializes this unrelated lazy allocator.
    // Converge it through the real API before the full no-write baseline;
    // allocating a sequence does not fabricate a provider usage observation.
    expect(store.allocateNextUsageRevision(profile.id)).toBe(1);
    const staged = stageEffect(store, profile, kind, "subject");
    // Keep a real, nonempty resolved receipt alongside the unresolved subject;
    // whole-database snapshots below must preserve its original evidence too.
    const sentinel = stageEffect(store, profile, "session.rename", "sentinel", true);
    expect(store.transitionMutation(sentinel.attempt.id, "effect_started", "ambiguous", { code: "LOST_RESPONSE" })).toBe(true);
    store.quarantineSession(sentinel.session.id);
    store.resolveSessionMutation({
      attemptId: sentinel.attempt.id,
      expectedOriginalState: "ambiguous",
      expectedEvidenceDigest: sentinel.record.digest,
      resolution: "proven_applied",
      resolutionEvidence: { kind: "session.rename", providerThreadId: sentinel.evidence.providerThreadId,
        providerTimestampUnit: "unix_milliseconds_v1", providerUpdatedAt: 11, requestedName: "After rename" },
      receipt: { renamed: true },
      provider: { providerThreadId: sentinel.evidence.providerThreadId, title: "After rename", status: "idle", providerUpdatedAt: 11 },
    });
    expect(store.readMutation(sentinel.key)).toMatchObject({ state: "reconciled", resolution: { kind: "proven_applied" } });
    store.close();
    store = undefined;
    database = new Database(paths.database, { create: false, strict: true });
    database.exec("PRAGMA foreign_keys=ON");
    expect(database.query("PRAGMA user_version").get()).toEqual({ user_version: 61 });
    expect(database.query("SELECT version FROM migrations ORDER BY version").all())
      .toEqual(Array.from({ length: 61 }, (_, index) => ({ version: index + 1 })));
    expect(database.query("SELECT DISTINCT format FROM mutation_effect_evidence_provenance").all())
      .toEqual([{ format: "joined_v1" }]);
    expect(readMutationEffectEvidenceProvenance(database, staged.attempt.id))
      .toMatchObject({ kind: "parsed", format: "joined_v1", evidence: staged.record.evidence });
    expect(database.query("SELECT profile_id,next_revision FROM usage_revision_authority").all())
      .toEqual([{ profile_id: profile.id, next_revision: 2 }]);
    expect(database.query("SELECT * FROM usage_snapshots").all()).toEqual([]);
    expect(database.query("SELECT * FROM usage_poll_failures").all()).toEqual([]);
    expect(database.query("SELECT attempt_id FROM mutation_resolutions").all())
      .toEqual([{ attempt_id: sentinel.attempt.id }]);
    await run({ paths, database, staged });
  } finally {
    database?.close(false);
    store?.close();
    await rm(root, { recursive: true, force: true });
  }
};

// Deliberately synthetic corruption of a retained row. Current60 tests leave its
// original provenance/anchor unchanged; the canonical41 test corrupts before
// admission. Neither corruption is claimed as an archived producer operation.
const corruptEvidence = (database: Database, attemptId: string, replacement: {
  json: string;
  digest: string;
  kind?: string;
}): void => {
  const guard = z.object({ sql: z.string() }).strict().parse(database.query(
    "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='mutation_effect_evidence_immutable_update'",
  ).get());
  const before = snapshot(database);
  database.transaction(() => {
    database.exec("DROP TRIGGER mutation_effect_evidence_immutable_update");
    try {
      expect(database.query(`UPDATE mutation_effect_evidence SET evidence_json=?,evidence_digest=?,kind=COALESCE(?,kind)
        WHERE attempt_id=?`).run(replacement.json, replacement.digest, replacement.kind ?? null, attemptId).changes).toBe(1);
    } finally { database.exec(guard.sql); }
  }).immediate();
  const after = snapshot(database);
  expect(after.schema).toEqual(before.schema);
  expect(after.version).toEqual(before.version);
  expect(after.ledger).toEqual(before.ledger);
  const beforeEvidence = before.rows.mutation_effect_evidence;
  if (beforeEvidence === undefined) throw new Error("Missing fixture effect evidence table.");
  expect(after.rows).toEqual({
    ...before.rows,
    mutation_effect_evidence: beforeEvidence.map((row) => row.attempt_id === attemptId
      ? { ...row, evidence_json: replacement.json, evidence_digest: replacement.digest, kind: replacement.kind ?? row.kind }
      : row),
  });
  expect(() => database.query("UPDATE mutation_effect_evidence SET evidence_digest=evidence_digest WHERE attempt_id=?").run(attemptId))
    .toThrow("mutation effect evidence is immutable");
};

const jsonWithTimestampUnit = (evidence: GenericEvidence): string => JSON.stringify({
  kind: evidence.kind,
  providerThreadId: evidence.providerThreadId,
  providerTimestampUnit: "unix_milliseconds_v1",
  baseline: evidence.baseline,
  ...(evidence.kind === "session.stop" ? { activeTurnId: evidence.activeTurnId } : { requestedName: evidence.requestedName }),
});

type Corruption = {
  name: string;
  json: (evidence: GenericEvidence) => string;
  wrongDigest?: true;
  validJoinedDocument?: true;
  sqlUnit?: "unix_milliseconds_v1";
  nonJson?: true;
};
const corruptions: readonly Corruption[] = [
  { name: "valid joined timestamp unit with matching replacement digest", json: jsonWithTimestampUnit, validJoinedDocument: true, sqlUnit: "unix_milliseconds_v1" },
  { name: "valid joined timestamp unit with wrong digest", json: jsonWithTimestampUnit, wrongDigest: true, validJoinedDocument: true, sqlUnit: "unix_milliseconds_v1" },
  { name: "unknown field", json: (evidence) => JSON.stringify({ ...evidence, unexpected: true }) },
  {
    name: "timestamp unit plus unknown field",
    json: (evidence) => `${jsonWithTimestampUnit(evidence).slice(0, -1)},"unexpected":true}`,
    sqlUnit: "unix_milliseconds_v1",
  },
  {
    name: "duplicate unit keys with an invalid final value",
    json: (evidence) => `${jsonWithTimestampUnit(evidence).slice(0, -1)},"providerTimestampUnit":null}`,
    sqlUnit: "unix_milliseconds_v1",
  },
  {
    name: "JSON5 unit readable by SQLite but not JSON.parse",
    json: (evidence) => `${JSON.stringify(evidence).slice(0, -1)},providerTimestampUnit:"unix_milliseconds_v1"}`,
    sqlUnit: "unix_milliseconds_v1",
    nonJson: true,
  },
  { name: "valid joined document with wrong digest", json: JSON.stringify, wrongDigest: true, validJoinedDocument: true },
];

const refuseCurrentTamperThroughReopens = async (
  input: Parameters<Parameters<typeof withEffectFixture>[1]>[0],
): Promise<void> => {
  const { database, paths, staged } = input;
  expect(database.query("PRAGMA wal_checkpoint(TRUNCATE)").get()).toEqual({ busy: 0, log: 0, checkpointed: 0 });
  // This holder keeps WAL sidecars available to genuine readonly StateStores.
  // It cannot write and holds no transaction spanning a writable reopen.
  database.exec("PRAGMA query_only=ON");
  const expected = snapshot(database);
  expect(() => readMutationEffectEvidenceProvenance(database, staged.attempt.id))
    .toThrow("EFFECT_EVIDENCE_PROVENANCE_CORRUPT");
  for (const readonly of [false, true, false, true]) {
    const beforeBytes = hash(await readFile(paths.database));
    if (!readonly) {
      // Current writable startup audits every immutable provenance anchor. It
      // must not recapture changed bytes as a newly admitted opaque history row.
      expect(() => new StateStore(paths, options)).toThrow("EFFECT_EVIDENCE_PROVENANCE_CORRUPT");
    } else {
      // Readonly startup checks schema; the selected-effect read owns this
      // row-level proof. Do not require an unrelated eager whole-history scan.
      const reopened = new StateStore(paths, { ...options, readonly: true });
      try {
        expect(() => reopened.readMutation(staged.key)).toThrow("EFFECT_EVIDENCE_PROVENANCE_CORRUPT");
        expect(reopened.requireSession(staged.session.id)).toEqual(staged.session);
      } finally { reopened.close(); }
    }
    expect(snapshot(database)).toEqual(expected);
    if (readonly) expect(hash(await readFile(paths.database))).toBe(beforeBytes);
  }
};

for (const kind of ["session.stop", "session.rename"] as const) {
  for (const corruption of corruptions) {
    test(`current61 refuses anchored ${kind} tamper: ${corruption.name}`, async () => {
      await withEffectFixture(kind, async (input) => {
        const { database, staged } = input;
        const json = corruption.json(staged.evidence);
        const digest = corruption.wrongDigest === true ? "0".repeat(64) : hash(json);
        expect(digest === hash(json)).toBe(corruption.wrongDigest !== true);
        if (corruption.nonJson === true) expect(() => JSON.parse(json) as unknown).toThrow();
        else expect(joinedMutationEffectEvidenceSchema.safeParse(JSON.parse(json) as unknown).success)
          .toBe(corruption.validJoinedDocument === true);
        corruptEvidence(database, staged.attempt.id, { json, digest });
        const retained = evidenceRowSchema.parse(database.query("SELECT * FROM mutation_effect_evidence WHERE attempt_id=?").get(staged.attempt.id));
        expect(retained).toEqual({ attempt_id: staged.attempt.id, kind, evidence_json: json, evidence_digest: digest, recorded_at: recordedAt });
        if (corruption.sqlUnit !== undefined) {
          // Raw SQL JSON extraction is not evidence validation. These probes
          // include unknown-field, duplicate-key and JSON5 counterexamples.
          expect(database.query("SELECT json_extract(evidence_json,'$.providerTimestampUnit') AS unit FROM mutation_effect_evidence WHERE attempt_id=?").get(staged.attempt.id))
            .toEqual({ unit: corruption.sqlUnit });
        }
        await refuseCurrentTamperThroughReopens(input);
      });
    });
  }

  for (const mismatch of ["stored evidence kind", "parsed evidence kind"] as const) {
    test(`current61 refuses anchored ${kind} with mismatched ${mismatch}`, async () => {
      await withEffectFixture(kind, async (input) => {
        const { database, staged } = input;
        const otherKind = kind === "session.stop" ? "session.rename" : "session.stop";
        const otherEvidence: GenericEvidence = otherKind === "session.stop"
          ? { kind: otherKind, providerThreadId: staged.evidence.providerThreadId, baseline: staged.evidence.baseline, activeTurnId: null }
          : { kind: otherKind, providerThreadId: staged.evidence.providerThreadId, baseline: staged.evidence.baseline, requestedName: "Other mutation" };
        const json = JSON.stringify(mismatch === "stored evidence kind" ? staged.evidence : otherEvidence);
        expect(joinedMutationEffectEvidenceSchema.safeParse(JSON.parse(json) as unknown).success).toBe(true);
        corruptEvidence(database, staged.attempt.id, {
          json,
          digest: hash(json),
          ...(mismatch === "stored evidence kind" ? { kind: otherKind } : {}),
        });
        await refuseCurrentTamperThroughReopens(input);
      });
    });
  }

  test(`valid current61 ${kind} control still enters existing restart containment`, async () => {
    await withEffectFixture(kind, async ({ paths, database, staged }) => {
      const expected = snapshot(database);
      const reopened = new StateStore(paths, options);
      try {
        expect(snapshot(database)).toEqual(expected);
        expect(reopened.recoverEffectStartedMutations()).toEqual({ recovered: [staged.attempt.id], unresolved: [] });
        expect(reopened.readMutation(staged.key)).toMatchObject({ state: "ambiguous", result: { code: "DAEMON_RESTART" }, evidence: staged.record });
        expect(reopened.requireSession(staged.session.id)).toMatchObject({ state: "recovery_required" });
        const after = snapshot(database);
        expect(after.schema).toEqual(expected.schema);
        expect(after.ledger).toEqual(expected.ledger);
        expect(after.version).toEqual(expected.version);
        expect(after.rows.mutation_effect_evidence).toEqual(expected.rows.mutation_effect_evidence);
        expect(after.rows.mutation_resolutions).toEqual(expected.rows.mutation_resolutions);
        expect(reopened.recoverEffectStartedMutations()).toEqual({ recovered: [], unresolved: [] });
      } finally { reopened.close(); }
    });
  });
}

// Unlike the current61 tamper tests, these begin with exact captured canonical41
// bytes. The one negative deliberately changes an original unresolved row BEFORE
// migration; only that change is synthetic. No current database is restamped,
// no generator executes, and neither case claims combined49 or native acceptance.
for (const corrupt of [false, true]) {
  test(`canonical41 original timestamp effects migrate and reopen ${corrupt ? "with one explicitly corrupted opaque row" : "without rewriting their six preimages"}`, async () => {
    const fixture = canonical41TimestampsFixture;
    expect(fixture.sourceRevision).toBe("576ccd76a6742cd62759ab6176a6a41844846daa");
    const bytes = canonical41TimestampsDatabaseBytes();
    expect(hash(bytes)).toBe("ad4842496d9ee5f8d51210ef9a99e255d76e6c42505cc3f6e996c919b2caa106");
    const root = await realpath(await mkdtemp(join(tmpdir(), "oompa-canonical41-effect-admission-")));
    let database: Database | undefined;
    let store: StateStore | undefined;
    try {
      const paths = resolveStatePaths({ rootDirectory: root });
      await initializeStatePaths(paths);
      await writeFile(paths.database, bytes, { mode: 0o600, flag: "wx" });
      database = new Database(paths.database, { create: false, strict: true });
      database.exec("PRAGMA foreign_keys=ON");
      expect(database.query("PRAGMA user_version").get()).toEqual({ user_version: 41 });
      const original = snapshot(database);
      expect(database.query("SELECT * FROM mutation_effect_evidence ORDER BY attempt_id").all())
        .toEqual([...fixture.effects]);
      expect(database.query("SELECT * FROM mutation_resolutions ORDER BY attempt_id").all())
        .toEqual([...fixture.resolutions]);
      expect(() => new StateStore(paths, { ...options, readonly: true }))
        .toThrow("STATE_SCHEMA_MIGRATION_REQUIRED:41:61");
      expect(snapshot(database)).toEqual(original);
      const subject = fixture.scenarios["stop-marked_unresolved"];
      if (corrupt) {
        const json = JSON.stringify({ ...subject.originalEffect.evidence, unexpected: true });
        corruptEvidence(database, subject.attemptId, { json, digest: hash(json) });
      }
      const admittedHistory = snapshot(database);
      store = new StateStore(paths, options);
      expect(database.query("PRAGMA user_version").get()).toEqual({ user_version: 61 });
      expect(database.query("SELECT DISTINCT format FROM mutation_effect_evidence_provenance").all())
        .toEqual([{ format: "canonical41_v1" }]);
      const afterMigration = snapshot(database);
      expect(afterMigration.rows.mutation_effect_evidence).toEqual(admittedHistory.rows.mutation_effect_evidence);
      expect(afterMigration.rows.mutation_resolutions).toEqual(original.rows.mutation_resolutions);
      expect(database.query("SELECT version,applied_at FROM migrations WHERE version<=41 ORDER BY version").all())
        .toEqual(original.ledger);
      // Close the first migrator before establishing the repeat-open baseline.
      // New columns, sidecars and quarantine rows are legitimate migration work;
      // they are not included in a false all-table-before/after equality claim.
      store.close();
      store = undefined;
      expect(database.query("PRAGMA wal_checkpoint(TRUNCATE)").get())
        .toEqual({ busy: 0, log: 0, checkpointed: 0 });
      database.exec("PRAGMA query_only=ON");
      const baseline = snapshot(database);
      for (const readonly of [true, false, true, false]) {
        const beforeBytes = hash(await readFile(paths.database));
        const reopened = new StateStore(paths, { ...options, readonly });
        store = reopened;
        try {
          for (const scenario of Object.values(fixture.scenarios)) {
            const selected = readMutationEffectEvidenceProvenance(database, scenario.attemptId);
            if (corrupt && scenario.attemptId === subject.attemptId) {
              expect(selected).toEqual({ kind: "opaque", format: "canonical41_v1", reason: "invalid_shape" });
              expect(() => reopened.readMutation(scenario.idempotencyKey))
                .toThrow("MUTATION_EFFECT_EVIDENCE_UNAVAILABLE");
              expect(database.query("SELECT projection_json,opaque_reason FROM mutation_effect_evidence_provenance WHERE attempt_id=?")
                .get(scenario.attemptId)).toEqual({ projection_json: null, opaque_reason: "invalid_shape" });
            } else {
              expect(selected).toMatchObject({ kind: "parsed", format: "canonical41_v1",
                evidence: scenario.originalEffect.evidence, digest: scenario.originalEffect.digest });
              expect(reopened.readMutation(scenario.idempotencyKey)).toMatchObject({
                id: scenario.attemptId, evidence: { digest: scenario.originalEffect.digest,
                  evidence: scenario.originalEffect.evidence },
              });
            }
          }
          expect(snapshot(database)).toEqual(baseline);
        } finally {
          reopened.close();
          store = undefined;
        }
        expect(snapshot(database)).toEqual(baseline);
        if (readonly) expect(hash(await readFile(paths.database))).toBe(beforeBytes);
      }
    } finally {
      store?.close();
      database?.close(false);
      await rm(root, { recursive: true, force: true });
    }
  });
}
