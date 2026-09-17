import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { canonical40QueuesDatabaseBytes, canonical40QueuesFixture } from "../../scripts/fixtures/canonical40-queues";
import { effectiveRuntimeProfileSchema } from "../domain/runtime-profile";
import { ATTACHMENT_CUSTODY_SCHEMA_OBJECTS } from "./attachment-custody";
import { initializeStatePaths, resolveStatePaths } from "./paths";
import { StateStore } from "./state-store";

const stores: StateStore[] = [];
const roots: string[] = [];
const databases: Database[] = [];
afterEach(async () => {
  for (const db of databases.splice(0)) db.close(false);
  for (const store of stores.splice(0)) store.close();
  for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true });
});
async function fixture(legacy = false) {
  const home = await realpath(await mkdtemp(join(tmpdir(), "oompa-custody-integrity-")));
  roots.push(home);
  const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
  await initializeStatePaths(paths);
  if (legacy) {
    await writeFile(paths.database, canonical40QueuesDatabaseBytes());
    await chmod(paths.database, 0o600);
  }
  const calls: string[] = [];
  const store = new StateStore(paths, { now: () => 2_000_000_000_000,
    attachmentCleanupPort: { unlinkCleanupCandidateSync: () => { calls.push("unlink"); return { kind: "absent" }; } } });
  stores.push(store);
  const bootId = legacy ? canonical40QueuesFixture.bootId : `boot_${randomUUID().replaceAll("-", "")}`;
  const daemon = { daemonGeneration: legacy ? canonical40QueuesFixture.daemonGeneration : store.nextDaemonGeneration(bootId), bootId };
  const historical = legacy ? canonical40QueuesFixture.sessionInputs.find((entry) => entry.kind === "session.send") : undefined;
  if (legacy && historical === undefined) throw new Error("Missing archived prepared send.");
  const profile = historical === undefined ? store.nextProfileGeneration(store.createProfile("custody").id)
    : store.requireProfileById(canonical40QueuesFixture.profileId);
  if (historical === undefined) store.setProfileState(profile.id, profile.processGeneration, "signed_in", { email: "custody@example.com", plan: "Plus" });
  const authority = store.requireProviderAccountAuthority(profile.id, "codex");
  const session = (() => {
    if (historical !== undefined) return store.requireSession(historical.sessionId);
    const imported = store.upsertProviderSession({ profileId: profile.id, provider: "codex", providerAuthority: authority,
      providerAccountKey: `v1:codex:${createHash("sha256").update("custody@example.com").digest("hex")}`,
      title: "Custody integrity", preset: "high", fastEnabled: false, providerThreadId: "custody-thread", state: "idle" });
    return store.updateSessionMetadata({ sessionId: imported.id, expectedRevision: imported.revision, preset: "high" });
  })();
  const db = new Database(paths.database);
  databases.push(db);
  const attachment = { digest: "c".repeat(64), byteLength: 4, mediaType: "text/plain" as const, name: "file.txt" };
  const input = (refs = [attachment]) => ({ kind: "session.send" as const, sessionId: session.id, idempotencyKey: randomUUID(),
    message: "input", attachments: refs, providerAuthority: authority, ...daemon });
  const transcript = { accountId: authority.profileId, providerGeneration: authority.processGeneration,
    providerConnectionId: "48000000-0000-4000-8000-000000000002", actor: "human" as const, message: "input" };
  const reserve = (request = input()) => {
    const result = store.reserveAttachmentIngress(request);
    if (result.kind !== "reserved") throw new Error("Expected attached custody");
    return { request, reservation: { reservationId: result.reservationId, reservationDigest: result.reservationDigest } };
  };
  const prepare = () => { const value = reserve(); return { ...value, prepared: store.prepareSessionInputMutation({ ...value.request, reservation: value.reservation }) }; };
  const cleanup = () => store.cleanupAttachmentCandidate({ ...daemon, candidate: { kind: "blob", digest: attachment.digest, canonicalMediaType: "text/plain" } });
  const reopen = (readonly: boolean) => { const reopened = new StateStore(paths, { readonly, now: () => 2_000_000_000_000 }); stores.push(reopened); return reopened; };
  return { store, paths, db, daemon, session, authority, attachment, input, transcript, reserve, prepare, cleanup, calls, reopen, historical };
}
function bypassTableGuards(db: Database, table: string, action: () => void): void {
  const guards = db.query("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name=?").all(table) as { name: string; sql: string }[];
  for (const guard of guards) db.exec(`DROP TRIGGER ${guard.name}`);
  try { action(); } finally { for (const guard of guards) db.exec(guard.sql); }
}
describe("attachment custody immutable integrity", () => {
  test("fresh49 and both reopens preserve exact positive empty identity without a live slot", async () => {
    const f = await fixture();
    const request = f.input([]);
    const prepared = f.store.prepareSessionInputMutation(request);
    expect(f.db.query("PRAGMA user_version").get()).toEqual({ user_version: 62 });
    expect(f.db.query("SELECT COUNT(*) AS n FROM attachment_custody_slots").get()).toEqual({ n: 0 });
    expect(f.cleanup()).toEqual({ kind: "absent" });
    expect(f.reopen(true).readMutation(f.input([]).idempotencyKey)).toBeNull();
    expect(f.reopen(false).readMutation(request.idempotencyKey)?.id).toBe(prepared.attempt.id);
  });

  for (const table of ["attachment_custody_members", "attachment_custody_sets", "attachment_custody_anchors", "attachment_custody_slots"]) {
    test(`hot cleanup and both reopens refuse a missing live ${table}`, async () => {
      const f = await fixture();
      f.prepare();
      const triggers = f.db.query("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name=?").all(table) as { name: string; sql: string }[];
      for (const trigger of triggers) f.db.exec(`DROP TRIGGER ${trigger.name}`);
      f.db.exec(`DELETE FROM ${table}`);
      for (const trigger of triggers) f.db.exec(trigger.sql);
      expect(f.cleanup).toThrow("ATTACHMENT_CUSTODY_CORRUPT");
      expect(() => f.reopen(false)).toThrow();
      expect(() => f.reopen(true)).toThrow();
      expect(f.calls).toEqual([]);
    });
  }

  test("the 65th attached set refuses atomically while empty input remains available", async () => {
    const f = await fixture();
    for (let index = 0; index < 64; index++) f.reserve();
    expect(() => f.reserve()).toThrow("ATTACHMENT_CUSTODY_LIMIT");
    expect(f.store.reserveAttachmentIngress(f.input([]))).toEqual({ kind: "empty" });
    expect(f.db.query("SELECT COUNT(*) AS n FROM attachment_custody_sets").get()).toEqual({ n: 64 });
  });

  test("a generic fabricated applied object is not terminal attachment proof", async () => {
    const f = await fixture();
    const p = f.prepare();
    const custody = p.prepared.custody;
    if (custody.kind !== "mutation_owned") throw new Error("Expected durable custody");
    f.store.beginSessionMutationEffect({ attemptId: p.prepared.attempt.id, sessionId: f.session.id, profileGeneration: f.authority.processGeneration,
      message: f.transcript.message, transcript: f.transcript,
      providerAuthority: f.authority, attachments: [{ ...f.attachment, canonicalMediaType: "text/plain" }], custody, ...f.daemon,
      evidence: { kind: "session.send", providerThreadId: "custody-thread", baseline: { status: "idle", activeTurnId: null, providerUpdatedAt: null },
        clientMessageId: p.prepared.attempt.id, messageDigest: createHash("sha256").update("input").digest("hex") } });
    expect(f.store.transitionMutation(p.prepared.attempt.id, "effect_started", "applied", {})).toBe(true);
    expect(() => f.db.query("UPDATE mutation_attempts SET attachment_cleanup_terminal_digest=? WHERE id=?")
      .run("d".repeat(64), p.prepared.attempt.id)).toThrow("ATTACHMENT_CUSTODY_UNPROVED");
    expect(f.db.query("SELECT COUNT(*) AS n FROM attachment_custody_slots").get()).toEqual({ n: 1 });
    expect(f.cleanup().kind).toBe("retained");
  });

  test("new positive empty proof cannot be detached before begin or reopen", async () => {
    const f = await fixture();
    const request = f.input([]);
    f.store.prepareSessionInputMutation(request);
    f.db.exec("DROP TRIGGER attachment_custody_anchors_permanent; DELETE FROM attachment_custody_anchors");
    const guard = ATTACHMENT_CUSTODY_SCHEMA_OBJECTS.find((object) => object.name === "attachment_custody_anchors_permanent");
    if (guard === undefined) throw new Error("Missing canonical guard");
    f.db.exec(guard.sql);
    expect(() => f.store.prepareSessionInputMutation(request)).toThrow();
    expect(() => f.reopen(false)).toThrow();
  });

  test("canonical40 classifies an actual old prepared request as unknown without inventing empty custody", async () => {
    const f = await fixture(true);
    const old = f.historical;
    if (old === undefined) throw new Error("Expected archived prepared send.");
    const { idempotencyKey } = old;
    const migrated = f.reopen(false);
    expect(f.db.query("SELECT attachment_input_format FROM mutation_attempts WHERE id=?").get(old.attemptId)).toEqual({ attachment_input_format: null });
    expect(f.db.query("SELECT COUNT(*) AS n FROM attachment_legacy_cleanup_blockers WHERE attempt_id=?").get(old.attemptId)).toEqual({ n: 1 });
    expect(migrated.cleanupAttachmentCandidate({ ...f.daemon, candidate: { kind: "blob", digest: "c".repeat(64), canonicalMediaType: "text/plain" } }).kind).toBe("retained");
    const historical = migrated.readMutation(idempotencyKey);
    if (historical === null) throw new Error("Expected historical mutation");
    const replayInput = { kind: "session.send" as const, sessionId: f.session.id, idempotencyKey, message: old.message, attachments: [] };
    expect(migrated.readSessionInputReplay(replayInput)).toBeNull();
    expect(() => migrated.readSessionInputReplay({ ...replayInput, message: "changed" })).toThrow("ATTACHMENT_CUSTODY_REQUEST_CONFLICT");
    expect(migrated.prepareMutation({ kind: "session.send", authorityId: f.session.id, authorityGeneration: f.authority.processGeneration,
      request: { message: old.message }, idempotencyKey }).replay).toBe(true);
    expect(migrated.transitionMutation(historical.id, "prepared", "cancelled")).toBe(true);
    expect(migrated.readSessionInputReplay(replayInput)?.state).toBe("cancelled");
    expect(f.db.query("SELECT terminal_digest IS NOT NULL AS settled FROM attachment_legacy_cleanup_blockers WHERE attempt_id=?").get(old.attemptId)).toEqual({ settled: 1 });
  });

  test("a surviving partial custody trigger in current62 is refused without repair or row changes", async () => {
    const f = await fixture();
    f.store.prepareSessionInputMutation(f.input([]));
    for (const type of ["trigger", "index", "table"] as const) for (const object of [...ATTACHMENT_CUSTODY_SCHEMA_OBJECTS].reverse()) {
      if (object.type === type && object.name !== "attachment_unknown_capture") f.db.exec(`DROP ${type.toUpperCase()} ${object.name}`);
    }
    const snapshot = () => {
      const tables = f.db.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
      return { schema: f.db.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all(),
        version: f.db.query("PRAGMA user_version").get(),
        rows: tables.map(({ name }) => {
          if (!/^[a-z_][a-z0-9_]*$/u.test(name)) throw new Error("Unexpected fixture table name");
          return [name, f.db.query(`SELECT * FROM "${name}"`).all()];
        }) };
    };
    const before = snapshot();
    // Dropping custody tables also removes their peer-cancellation guards.
    // Current admission detects that exact missing footprint first; neither
    // writable nor read-only admission may reconstruct any object or row.
    for (const readonly of [false, true]) {
      expect(() => f.reopen(readonly)).toThrow("PEER_SESSION_CANCELLATION_UNPROVEN");
      expect(snapshot()).toEqual(before);
    }
    expect(f.db.query("PRAGMA user_version").get()).toEqual({ user_version: 62 });
  });

  test("a missing parent cannot free its live slot or its original global key", async () => {
    const f = await fixture();
    const p = f.prepare();
    bypassTableGuards(f.db, "mutation_attempts", () => { f.db.query("DELETE FROM mutation_attempts WHERE id=?").run(p.prepared.attempt.id); });
    expect(f.cleanup).toThrow();
    expect(() => f.store.readMutation(p.request.idempotencyKey)).toThrow();
    expect(() => f.db.query("INSERT INTO mutation_attempts(id,idempotency_key,kind,authority_id,authority_generation,request_digest,state,created_at,updated_at) VALUES(?,?,'session.send',?,1,?,'prepared',1,1)")
      .run(`attempt_${randomUUID().replaceAll("-", "")}`, p.request.idempotencyKey, f.session.id, "a".repeat(64))).toThrow("ATTACHMENT_CUSTODY_CORRUPT");
    expect(() => f.reopen(false)).toThrow();
    expect(f.calls).toEqual([]);
  });

  test("relocating one mutation key is rejected at both original and replacement lookups", async () => {
    const f = await fixture();
    const p = f.prepare();
    const replacement = randomUUID();
    bypassTableGuards(f.db, "mutation_attempts", () => { f.db.query("UPDATE mutation_attempts SET idempotency_key=? WHERE id=?").run(replacement, p.prepared.attempt.id); });
    expect(() => f.store.readMutation(p.request.idempotencyKey)).toThrow();
    expect(() => f.store.readMutation(replacement)).toThrow();
    expect(f.cleanup).toThrow();
    expect(() => f.reopen(true)).toThrow();
  });

  test("a public marked manifest write refuses and an injected same-length wrong name cannot pass atomic begin", async () => {
    const f = await fixture();
    const p = f.prepare();
    const custody = p.prepared.custody;
    if (custody.kind !== "mutation_owned") throw new Error("Expected pins");
    const attachments = [{ ...f.attachment, canonicalMediaType: "text/plain" as const }];
    expect(() => f.store.recordMessageAttachments({ sessionId: f.session.id, sourceId: p.prepared.attempt.id, attachments })).toThrow("ATTACHMENT_CUSTODY_REQUEST_CONFLICT");
    f.db.query("INSERT INTO attachments(digest,media_type,byte_length,created_at,reference_count) VALUES(?,'text/plain',4,1,0)").run(f.attachment.digest);
    f.db.query("INSERT INTO message_attachments(session_id,source_id,position,digest,name,media_type,byte_length,created_at) VALUES(?,?,0,?,'evil.txt','text/plain',4,1)")
      .run(f.session.id, p.prepared.attempt.id, f.attachment.digest);
    const snapshot = () => ({ attempts: f.db.query("SELECT * FROM mutation_attempts ORDER BY id").all(),
      evidence: f.db.query("SELECT * FROM mutation_effect_evidence ORDER BY attempt_id").all(),
      manifest: f.db.query("SELECT * FROM message_attachments ORDER BY session_id,source_id,position").all(),
      accounting: f.db.query("SELECT * FROM attachments ORDER BY digest").all() });
    const before = snapshot();
    expect(() => f.store.beginSessionMutationEffect({ attemptId: p.prepared.attempt.id, sessionId: f.session.id, profileGeneration: f.authority.processGeneration,
      message: f.transcript.message, transcript: f.transcript,
      providerAuthority: f.authority, attachments, custody, ...f.daemon,
      evidence: { kind: "session.send", providerThreadId: "custody-thread", baseline: { status: "idle", activeTurnId: null, providerUpdatedAt: null },
        clientMessageId: p.prepared.attempt.id, messageDigest: createHash("sha256").update("input").digest("hex") } })).toThrow("MESSAGE_ATTACHMENT_IDENTITY_CONFLICT");
    expect(snapshot()).toEqual(before);
    expect(f.db.query("SELECT state FROM mutation_attempts WHERE id=?").get(p.prepared.attempt.id)).toEqual({ state: "prepared" });
    expect(f.db.query("SELECT 1 FROM mutation_effect_evidence WHERE attempt_id=?").get(p.prepared.attempt.id)).toBeNull();
  });

  test("boot retires only the unparented invocation and preserves the original owned pin", async () => {
    const f = await fixture();
    const loose = f.reserve();
    const original = f.store.prepareOwnedSessionSendWithCustody({ request: { kind: "session.send", session: f.session.id, idempotencyKey: randomUUID(), message: "", attachments: [f.attachment] }, ...f.daemon });
    const nextBoot = `boot_${randomUUID().replaceAll("-", "")}`;
    expect(f.store.nextDaemonGeneration(nextBoot)).toBe(f.daemon.daemonGeneration + 1);
    expect(f.db.query("SELECT released_by IS NOT NULL AS released FROM attachment_custody_sets WHERE id=?").get(loose.reservation.reservationId)).toEqual({ released: 1 });
    expect(f.db.query("SELECT COUNT(*) AS n FROM attachment_custody_slots").get()).toEqual({ n: 1 });
    expect(f.store.readOwnedSessionSend(original.owner.idempotencyKey)?.state).toBe("input_required");
    expect(f.reopen(false).readOwnedSessionSend(original.owner.idempotencyKey)?.ownerDigest).toBe(original.ownerDigest);
    f.store.cancelOwnedSessionSend({ attemptId: original.owner.attemptId, ownerDigest: original.ownerDigest });
    expect(f.db.query("SELECT COUNT(*) AS n FROM attachment_custody_slots").get()).toEqual({ n: 0 });
  });

  test("immutable released proof cannot be replaced by an unrecognized daemon object", async () => {
    const f = await fixture();
    const p = f.reserve();
    f.store.releaseAttachmentIngress({ ...p.reservation, ...f.daemon });
    bypassTableGuards(f.db, "attachment_custody_dispositions", () => { f.db.query("UPDATE attachment_custody_dispositions SET proof_json=? WHERE custody_id=?")
      .run(JSON.stringify({ ...f.daemon, bypass: true }), p.reservation.reservationId); });
    expect(() => f.store.releaseAttachmentIngress({ ...p.reservation, ...f.daemon })).toThrow("ATTACHMENT_CUSTODY_CORRUPT");
    expect(() => f.reopen(false)).toThrow();
  });

  test("marked empty input cannot use a generic or raw SQL begin without exact effect evidence", async () => {
    const f = await fixture();
    const prepared = f.store.prepareSessionInputMutation(f.input([]));
    expect(() => f.store.transitionMutation(prepared.attempt.id, "prepared", "effect_started")).toThrow("ATTACHMENT_CUSTODY_UNPROVED");
    expect(() => f.store.beginPreparedMutationEffect({ attemptId: prepared.attempt.id,
      providerAuthorities: [{ role: "primary", authority: f.authority, provenance: "session_send" }] })).toThrow("ATTACHMENT_CUSTODY_UNPROVED");
    expect(() => f.db.query("UPDATE mutation_attempts SET state='effect_started' WHERE id=?").run(prepared.attempt.id)).toThrow("ATTACHMENT_CUSTODY_UNPROVED");
    expect(f.db.query("SELECT state FROM mutation_attempts WHERE id=?").get(prepared.attempt.id)).toEqual({ state: "prepared" });
    expect(f.db.query("SELECT COUNT(*) AS n FROM mutation_effect_evidence").get()).toEqual({ n: 0 });
  });

  test("raw queue transfer and surplus release proofs cannot remove a live invocation", async () => {
    const f = await fixture();
    const request = { ...f.input(), kind: "session.queue" as const };
    const reserved = f.store.reserveAttachmentIngress(request);
    if (reserved.kind !== "reserved") throw new Error("Expected ingress");
    const insert = (kind: string, proof: unknown) => f.db.query("INSERT INTO attachment_custody_dispositions(custody_id,ordinal,original_key,kind,proof_json,digest,recorded_at) VALUES(?,1,?,?,?,?,?)")
      .run(reserved.reservationId, request.idempotencyKey, kind, JSON.stringify(proof), "d".repeat(64), 2_000_000_000_000);
    expect(() => insert("queue_transferred", { queueId: `queue_${"a".repeat(32)}`, identityDigest: "b".repeat(64) })).toThrow("ATTACHMENT_CUSTODY_CORRUPT");
    expect(() => insert("released", { ...f.daemon, extra: true })).toThrow("ATTACHMENT_CUSTODY_AUTHORITY_CHANGED");
    expect(f.db.query("SELECT COUNT(*) AS n FROM attachment_custody_dispositions").get()).toEqual({ n: 0 });
    expect(f.db.query("SELECT COUNT(*) AS n FROM attachment_custody_slots").get()).toEqual({ n: 1 });
    expect(f.cleanup()).toEqual({ kind: "retained", reason: "reserved" });
    expect(f.calls).toEqual([]);
  });

  test("malformed optional reconciliation evidence cannot authorize raw terminal projection", async () => {
    const f = await fixture();
    const p = f.prepare();
    const custody = p.prepared.custody;
    if (custody.kind !== "mutation_owned") throw new Error("Expected retained input");
    f.store.beginSessionMutationEffect({ attemptId: p.prepared.attempt.id, sessionId: f.session.id, profileGeneration: f.authority.processGeneration,
      message: f.transcript.message, transcript: f.transcript,
      providerAuthority: f.authority, attachments: [{ ...f.attachment, canonicalMediaType: "text/plain" }], custody, ...f.daemon,
      evidence: { kind: "session.send", providerThreadId: "custody-thread", baseline: { status: "idle", activeTurnId: null, providerUpdatedAt: null },
        clientMessageId: p.prepared.attempt.id, messageDigest: createHash("sha256").update("input").digest("hex") } });
    f.store.transitionMutation(p.prepared.attempt.id, "effect_started", "ambiguous");
    f.db.query("INSERT INTO mutation_resolutions(attempt_id,resolution_kind,evidence_json,created_at) VALUES(?,'abandoned',?,?)")
      .run(p.prepared.attempt.id, JSON.stringify({ action: "user_abandon", providerEffectRetried: false, providerStateDeleted: false, observedProviderUpdatedAt: "invalid" }), 2_000_000_000_000);
    expect(() => f.db.query("UPDATE mutation_attempts SET attachment_cleanup_terminal_digest=? WHERE id=?")
      .run("d".repeat(64), p.prepared.attempt.id)).toThrow("ATTACHMENT_CUSTODY_UNPROVED");
    expect(f.cleanup().kind).toBe("retained");
    expect(f.db.query("SELECT COUNT(*) AS n FROM attachment_custody_slots").get()).toEqual({ n: 1 });
  });

  for (const terminal of ["cancelled", "applied"] as const) {
    test(`exact ${terminal} closed replay survives a real new boot without renewing custody or evidence`, async () => {
      const f = await fixture();
      const p = f.prepare();
      if (terminal === "cancelled") f.store.transitionMutation(p.prepared.attempt.id, "prepared", "cancelled");
      else {
        const custody = p.prepared.custody;
        if (custody.kind !== "mutation_owned") throw new Error("Expected retained input");
        const { preset, requirement } = f.store.requireSessionPresetRequirement(f.session.id);
        const runtimeProfile = effectiveRuntimeProfileSchema.parse({
          profileId: f.authority.profileId, processGeneration: f.authority.processGeneration, observedAt: f.session.updatedAt,
          preset, model: requirement.model, reasoningEffort: requirement.effort, serviceTier: null, fast: false,
          approvalPolicy: "on-request", reviewMode: "auto_review", permissionProfile: ":workspace",
          computerUse: true, pluginCapability: true, enabledApps: [],
        });
        f.store.beginSessionMutationEffect({ attemptId: p.prepared.attempt.id, sessionId: f.session.id, profileGeneration: f.authority.processGeneration,
          message: f.transcript.message, transcript: f.transcript,
          providerAuthority: f.authority, attachments: [{ ...f.attachment, canonicalMediaType: "text/plain" }], custody, ...f.daemon,
          evidence: { kind: "session.send", providerThreadId: "custody-thread", baseline: { status: "idle", activeTurnId: null, providerUpdatedAt: null },
            clientMessageId: p.prepared.attempt.id, runtimeProfile, messageDigest: createHash("sha256").update("input").digest("hex") } });
        // An applied flag alone intentionally retains the pending transcript
        // hold. Real completion proves the turn and finalizes that source.
        const completed = f.store.completeSessionTurnEffect({
          attemptId: p.prepared.attempt.id, sessionId: f.session.id, accountId: f.authority.profileId,
          providerGeneration: f.authority.processGeneration, providerAuthority: f.authority,
          providerConnectionId: f.transcript.providerConnectionId, expectedSessionRevision: f.session.revision,
          applyResponseState: true, runtimeProfile, message: f.transcript.message,
          turnId: "accepted-turn", turnStatus: "completed", receipt: { turnId: "accepted-turn", sourceId: p.prepared.attempt.id },
        });
        expect(completed.event.body).toMatchObject({ type: "user_message", actor: "human", attachments: [f.attachment] });
        expect(f.store.readSessionUserMessageSource(f.session.id, "mutation", p.request.idempotencyKey).status).toBe("finalized");
      }
      const before = f.store.readMutation(p.request.idempotencyKey);
      const bootId = `boot_${randomUUID().replaceAll("-", "")}`;
      const daemonGeneration = f.store.nextDaemonGeneration(bootId);
      const replay = f.store.prepareSessionInputMutation({ ...p.request, daemonGeneration, bootId,
        providerAuthority: f.store.requireProviderAccountAuthority(f.authority.profileId, "codex") });
      expect(replay.attempt.id).toBe(p.prepared.attempt.id);
      expect(replay.attempt.state).toBe(terminal);
      expect(replay.attempt.replay).toBe(true);
      expect(f.store.readMutation(p.request.idempotencyKey)).toEqual(before);
      expect(f.db.query("SELECT COUNT(*) AS n FROM attachment_custody_slots").get()).toEqual({ n: 0 });
      expect(f.db.query("SELECT COUNT(*) AS n FROM attachment_custody_sets").get()).toEqual({ n: 1 });
      expect(f.reopen(false).readMutation(p.request.idempotencyKey)).toEqual(before);
      if (terminal === "applied") {
        const currentAuthority = f.store.requireProviderAccountAuthority(f.authority.profileId, "codex");
        for (let index = 0; index < 64; index++) f.store.reserveAttachmentIngress({ ...f.input(), providerAuthority: currentAuthority, daemonGeneration, bootId });
        const historicalInput = { kind: "session.send" as const, sessionId: f.session.id, idempotencyKey: p.request.idempotencyKey,
          message: p.request.message, attachments: p.request.attachments };
        expect(f.store.readSessionInputReplay(historicalInput)).toEqual({ id: p.prepared.attempt.id, state: "applied", replay: true, result: before?.result });
        expect(() => f.store.readSessionInputReplay({ ...historicalInput, attachments: [{ ...f.attachment, name: "changed.txt" }] })).toThrow("ATTACHMENT_CUSTODY_REQUEST_CONFLICT");
        expect(f.db.query("SELECT COUNT(*) AS n FROM attachment_custody_slots").get()).toEqual({ n: 64 });
      }
    });
  }

  test("a bare old invocation can retire after an intervening legacy daemon boot", async () => {
    const f = await fixture();
    const p = f.reserve();
    expect(f.store.nextDaemonGeneration("legacy-boot-string")).toBe(f.daemon.daemonGeneration + 1);
    expect(f.db.query("SELECT COUNT(*) AS n FROM attachment_custody_slots").get()).toEqual({ n: 1 });
    const bootId = `boot_${randomUUID().replaceAll("-", "")}`;
    expect(f.store.nextDaemonGeneration(bootId)).toBe(f.daemon.daemonGeneration + 2);
    expect(f.db.query("SELECT COUNT(*) AS n FROM attachment_custody_slots").get()).toEqual({ n: 0 });
    expect(f.db.query("SELECT kind FROM attachment_custody_dispositions WHERE custody_id=?").get(p.reservation.reservationId)).toEqual({ kind: "boot_retired" });
    expect(() => f.reopen(false)).not.toThrow();
  });

  for (const kind of ["session.send", "session.steer"] as const) {
    test(`new generic ${kind} API and SQL admissions refuse without consuming the original key`, async () => {
      const f = await fixture();
      const request = { ...f.input([]), kind };
      expect(() => f.store.prepareMutation({ kind, authorityId: f.session.id, authorityGeneration: f.authority.processGeneration,
        request: { message: request.message }, idempotencyKey: request.idempotencyKey,
        providerAuthorities: [{ role: "primary", authority: f.authority, provenance: kind === "session.send" ? "session_send" : "session_steer" }] })).toThrow("ATTACHMENT_CUSTODY_UNPROVED");
      expect(() => f.db.query("INSERT INTO mutation_attempts(id,idempotency_key,kind,authority_id,authority_generation,request_digest,state,created_at,updated_at) VALUES(?,?,?,?,?,?,'prepared',1,1)")
        .run(`attempt_${randomUUID().replaceAll("-", "")}`, request.idempotencyKey, kind, f.session.id, f.authority.processGeneration, "d".repeat(64))).toThrow("ATTACHMENT_CUSTODY_UNPROVED");
      expect(f.store.readMutation(request.idempotencyKey)).toBeNull();
      expect(f.db.query("SELECT COUNT(*) AS n FROM attachment_legacy_cleanup_blockers").get()).toEqual({ n: 0 });
      expect(f.store.prepareSessionInputMutation(request).attempt.replay).toBe(false);
    });
  }

  test("new attached queue requires an exact invocation while historical replay needs none", async () => {
    const f = await fixture();
    const request = { ...f.input(), kind: "session.queue" as const };
    const queueInput = { sessionId: f.session.id, profileGeneration: f.authority.processGeneration, providerAuthority: f.authority,
      idempotencyKey: request.idempotencyKey, message: request.message, attachments: request.attachments,
      storedAttachments: [{ ...f.attachment, canonicalMediaType: "text/plain" as const }] };
    expect(() => f.store.enqueueIdempotent(queueInput)).toThrow("ATTACHMENT_CUSTODY_UNPROVED");
    expect(f.store.readMutation(request.idempotencyKey)).toBeNull();
    expect(f.db.query("SELECT COUNT(*) AS n FROM queue_entries").get()).toEqual({ n: 0 });
    const reserved = f.store.reserveAttachmentIngress(request);
    if (reserved.kind !== "reserved") throw new Error("Expected queue invocation");
    const admitted = f.store.enqueueIdempotentWithResult({ ...queueInput, attachmentReservation: { ...reserved, ...f.daemon } });
    expect(admitted.replayed).toBe(false);
    expect(f.db.query("SELECT COUNT(*) AS n FROM attachment_custody_slots").get()).toEqual({ n: 0 });
    const replay = f.store.enqueueIdempotentWithResult(queueInput);
    expect(replay).toEqual({ ...admitted, replayed: true });
    expect(f.store.enqueue(f.session.id, "scheduled text").state).toBe("pending");
  });

  test("raw attached queue identity cannot be admitted with only a retired historical hold", async () => {
    const f = await fixture();
    const request = { ...f.input(), kind: "session.queue" as const };
    const reserved = f.store.reserveAttachmentIngress(request);
    if (reserved.kind !== "reserved") throw new Error("Expected queue invocation");
    const queue = f.store.enqueueIdempotent({ sessionId: f.session.id, profileGeneration: f.authority.processGeneration, providerAuthority: f.authority,
      idempotencyKey: request.idempotencyKey, message: request.message, attachments: request.attachments,
      storedAttachments: [{ ...f.attachment, canonicalMediaType: "text/plain" }],
      attachmentReservation: { ...reserved, ...f.daemon } });
    const identity = f.db.query("SELECT * FROM queue_attachment_identities WHERE queue_id=?").get(queue.id) as {
      queue_id: string; attempt_id: string; original_key: string; session_id: string; identity_json: string; identity_digest: string };
    bypassTableGuards(f.db, "queue_attachment_identity_anchors", () => { f.db.query("DELETE FROM queue_attachment_identity_anchors WHERE queue_id=?").run(queue.id); });
    bypassTableGuards(f.db, "queue_attachment_identities", () => { f.db.query("DELETE FROM queue_attachment_identities WHERE queue_id=?").run(queue.id); });
    expect(() => f.db.query("INSERT INTO queue_attachment_identities(queue_id,attempt_id,original_key,session_id,identity_json,identity_digest) VALUES(?,?,?,?,?,?)")
      .run(identity.queue_id, identity.attempt_id, identity.original_key, identity.session_id, identity.identity_json, identity.identity_digest)).toThrow("ATTACHMENT_CUSTODY_UNPROVED");
    expect(f.db.query("SELECT COUNT(*) AS n FROM queue_attachment_identities").get()).toEqual({ n: 0 });
  });

  test("a final queue transfer failure rolls back its single mutation and seal while retaining ingress", async () => {
    const f = await fixture();
    const request = { ...f.input(), kind: "session.queue" as const };
    const reserved = f.store.reserveAttachmentIngress(request);
    if (reserved.kind !== "reserved") throw new Error("Expected queue invocation");
    f.db.exec("CREATE TRIGGER fail_custody_transfer BEFORE INSERT ON attachment_custody_dispositions WHEN NEW.kind='queue_transferred' BEGIN SELECT RAISE(ABORT,'injected transfer failure'); END");
    expect(() => f.store.enqueueIdempotent({ sessionId: f.session.id, profileGeneration: f.authority.processGeneration, providerAuthority: f.authority,
      idempotencyKey: request.idempotencyKey, message: request.message, attachments: request.attachments,
      storedAttachments: [{ ...f.attachment, canonicalMediaType: "text/plain" }],
      attachmentReservation: { ...reserved, ...f.daemon } })).toThrow("injected transfer failure");
    for (const table of ["queue_entries", "queue_attachment_identities", "queue_attachment_identity_anchors", "message_attachments", "mutation_attempts"])
      expect(f.db.query(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
    expect(f.db.query("SELECT COUNT(*) AS n FROM attachment_custody_slots").get()).toEqual({ n: 1 });
  });

  test("historical input preflight rejects an unrelated operation key before custody decoding", async () => {
    const f = await fixture();
    const key = randomUUID();
    const input = { kind: "session.send" as const, sessionId: f.session.id, idempotencyKey: key, message: "input", attachments: [] };
    expect(f.store.readSessionInputReplay(input)).toBeNull();
    const other = f.store.prepareMutation({ kind: "fixture.other", authorityId: f.session.id, authorityGeneration: f.authority.processGeneration,
      request: { value: true }, idempotencyKey: key });
    expect(() => f.store.readSessionInputReplay(input)).toThrow("ATTACHMENT_CUSTODY_REQUEST_CONFLICT");
    expect(f.store.readMutation(key)?.id).toBe(other.id);
  });
});
