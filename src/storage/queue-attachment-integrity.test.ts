import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { canonical40QueuesDatabaseBytes, canonical40QueuesFixture } from "../../scripts/fixtures/canonical40-queues";
import { effectiveRuntimeProfileSchema } from "../domain/runtime-profile";
import { initializeStatePaths, resolveStatePaths } from "./paths";
import { StateStore, type StoredMessageAttachment } from "./state-store";

const stores: StateStore[] = [];
const databases: Database[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close(false);
  for (const store of stores.splice(0)) store.close();
});
const attachment: StoredMessageAttachment = { digest: createHash("sha256").update("private bytes").digest("hex"),
  name: "notes.txt", mediaType: "text/plain", canonicalMediaType: "text/plain", byteLength: 13 };
async function fixture() {
  const home = await realpath(await mkdtemp(join(tmpdir(), "oompa-queue-integrity-")));
  const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
  await initializeStatePaths(paths);
  const clock = { now: 10_000 };
  const store = new StateStore(paths, { now: () => clock.now++ });
  stores.push(store);
  const bootId = `boot_${"a".repeat(32)}`;
  const daemonGeneration = store.nextDaemonGeneration(bootId);
  const profile = store.nextProfileGeneration(store.createProfile("Queue integrity").id);
  store.setProfileState(profile.id, profile.processGeneration, "signed_in", { email: "queue@example.com", plan: "Plus" });
  const authority = store.requireProviderAccountAuthority(profile.id, "codex");
  const imported = store.upsertProviderSession({ profileId: profile.id, provider: "codex",
    providerAuthority: authority, providerAccountKey: `v1:codex:${createHash("sha256").update("queue@example.com").digest("hex")}`,
    preset: "high", fastEnabled: false, title: "Queue integrity", providerThreadId: "queue-integrity", state: "idle" });
  const session = store.updateSessionMetadata({ sessionId: imported.id, expectedRevision: imported.revision, preset: "high" });
  const database = new Database(paths.database, { strict: true });
  databases.push(database);
  database.exec("PRAGMA foreign_keys=ON");
  const input = { sessionId: session.id, message: "original private body", profileGeneration: authority.processGeneration,
    providerAuthority: authority, idempotencyKey: randomUUID(),
    attachments: [{ digest: attachment.digest, name: attachment.name, mediaType: attachment.mediaType, byteLength: attachment.byteLength }],
    storedAttachments: [attachment] };
  const enqueue = (request: typeof input = input) => {
    const reservation = store.reserveAttachmentIngress({ kind: "session.queue", sessionId: request.sessionId,
      idempotencyKey: request.idempotencyKey, message: request.message, providerAuthority: request.providerAuthority,
      daemonGeneration, bootId, attachments: request.attachments.map(({ digest, name, mediaType, byteLength }) => ({ digest, name, mediaType, byteLength })) });
    return store.enqueueIdempotent({ ...request, ...(reservation.kind === "reserved" ? { attachmentReservation: {
      reservationId: reservation.reservationId, reservationDigest: reservation.reservationDigest, daemonGeneration, bootId,
    } } : {}) });
  };
  const close = () => { store.close(); stores.splice(stores.indexOf(store), 1); };
  const reopen = (readonly = false) => { const opened = new StateStore(paths, { readonly, now: () => clock.now++ }); stores.push(opened); return opened; };
  const dropGuard = (name: string) => {
    const row = database.query("SELECT sql FROM sqlite_master WHERE name=?").get(name) as { sql: string };
    database.exec(`DROP TRIGGER ${name}`);
    return () => database.exec(row.sql);
  };
  return { store, database, clock, paths, session, authority, profile, input, enqueue, close, reopen, dropGuard };
}
async function legacyFixture(state: "pending" | "cancelled") {
  const entry = canonical40QueuesFixture.queues.find((queue) => queue.state === state);
  if (entry === undefined) throw new Error("Missing archived queue fixture.");
  const home = await realpath(await mkdtemp(join(tmpdir(), "oompa-canonical40-queue-")));
  const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
  await initializeStatePaths(paths);
  await writeFile(paths.database, canonical40QueuesDatabaseBytes());
  await chmod(paths.database, 0o600);
  const store = new StateStore(paths, { now: () => 1_900_000_001_000 });
  stores.push(store);
  const database = new Database(paths.database, { strict: true });
  databases.push(database);
  const session = store.requireSession(entry.sessionId);
  const queued = store.requireQueue(entry.queueId);
  const input = { sessionId: session.id, message: entry.originalMessage, idempotencyKey: entry.idempotencyKey, attachments: [] };
  return { store, database, session, queued, input };
}
describe("queue attachment durable integrity", () => {
  test("legacy pending identity is quarantined without losing its body across boot and explicit abandonment", async () => {
    const f = await legacyFixture("pending");
    const { store: reopened, queued } = f;
    expect(reopened.hasUnsettledQueueAttachmentQuarantineForSession(f.session.id)).toBe(true);
    expect(reopened.listQueue(f.session.id)).toEqual([queued]);
    // Canonical40 has no immutable queue provider tuple. Keep its FIFO head
    // visible, but never return that head from the dispatch-facing selector.
    expect(reopened.nextPendingQueue(f.session.id)).toBeNull();
    expect(f.database.query("SELECT queue_id FROM queue_provider_authorities WHERE queue_id=?").get(queued.id)).toBeNull();
    expect(f.database.query("SELECT scope_id FROM legacy_provider_authority_quarantines WHERE scope_kind='queue' AND scope_id=?").get(queued.id))
      .toEqual({ scope_id: queued.id });
    expect(() => reopened.queueAttachmentManifest(queued.id)).toThrow("QUEUE_ATTACHMENT_IDENTITY_UNPROVED");
    reopened.nextDaemonGeneration(`boot_${"b".repeat(32)}`);
    expect(reopened.requireQueue(queued.id)).toMatchObject({ state: "pending", message: f.input.message });
    expect(() => reopened.transitionQueue(queued.id, "pending", "cancelled")).toThrow("QUEUE_ATTACHMENT_IDENTITY_UNPROVED");
    expect(reopened.readQueueEnqueueReplay({ ...f.input, attachments: [] })?.verification).toBe("legacy_unverified");
    expect(() => reopened.readQueueEnqueueReplay({ ...f.input, attachments: [{ digest: attachment.digest, name: attachment.name, mediaType: attachment.mediaType, byteLength: attachment.byteLength }] })).toThrow("QUEUE_ATTACHMENT_IDENTITY_UNPROVED");
    const current = reopened.requireSession(f.session.id);
    expect(reopened.abandonQueueAttachmentQuarantinedSession({ sessionId: current.id, expectedRevision: current.revision }).state).toBe("terminal");
    expect(reopened.requireQueue(queued.id)).toMatchObject({ state: "cancelled", message: "[queue message removed after settlement]" });
    expect(reopened.hasUnsettledQueueAttachmentQuarantineForSession(f.session.id)).toBe(false);
    expect(f.database.query("SELECT ordinal,kind FROM queue_attachment_quarantines WHERE queue_id=? ORDER BY ordinal").all(queued.id)).toEqual([
      { ordinal: 1, kind: "quarantined" }, { ordinal: 2, kind: "abandoned" },
    ]);
  });
  test("legacy terminal receipt remains text-replayable without inventing an empty seal", async () => {
    const f = await legacyFixture("cancelled");
    const { store: reopened, queued } = f;
    expect(reopened.readQueueEnqueueReplay({ ...f.input, attachments: [] })).toEqual({ queued: reopened.requireQueue(queued.id), verification: "legacy_unverified" });
    expect(f.database.query("SELECT * FROM queue_attachment_identities").all()).toEqual([]);
    expect(f.database.query("SELECT * FROM queue_attachment_quarantines WHERE queue_id=?").all(queued.id)).toEqual([]);
  });
  test.each(["queue_attachment_identities", "queue_attachment_identity_anchors"] as const)("missing %s fails hot original-key and both reopen modes", async (table) => {
    const f = await fixture(); const queued = f.enqueue();
    const restore = f.dropGuard(`${table}_immutable_delete`);
    f.database.exec("PRAGMA foreign_keys=OFF"); f.database.query(`DELETE FROM ${table} WHERE queue_id=?`).run(queued.id); restore();
    expect(() => f.store.readQueueEnqueueReplay(f.input)).toThrow();
    expect(() => f.store.prepareMutation({ kind: "session.rename", authorityId: f.session.id, authorityGeneration: f.authority.processGeneration,
      request: { title: "collision" }, idempotencyKey: f.input.idempotencyKey })).toThrow();
    f.close(); expect(() => f.reopen()).toThrow("QUEUE_ATTACHMENT_IDENTITY_CORRUPT"); expect(() => f.reopen(true)).toThrow("QUEUE_ATTACHMENT_IDENTITY_CORRUPT");
  });
  test("malformed SQL-legal reference is a typed quarantine error and fails reopen", async () => {
    const f = await fixture(); const queued = f.enqueue();
    const restore = f.dropGuard("message_attachments_immutable_update");
    f.database.query("UPDATE message_attachments SET name='../x' WHERE source_id=?").run(queued.id); restore();
    expect(() => f.store.queueAttachmentManifest(queued.id)).toThrow("QUEUE_ATTACHMENT_IDENTITY_CORRUPT");
    f.close(); expect(() => f.reopen()).toThrow("QUEUE_ATTACHMENT_IDENTITY_CORRUPT");
  });
  test("missing protected manifest is detected before schema repair", async () => {
    const f = await fixture(); const queued = f.enqueue();
    const restore = f.dropGuard("queue_attachment_manifest_delete_guard");
    f.database.query("DELETE FROM message_attachments WHERE source_id=?").run(queued.id); restore();
    f.close(); expect(() => f.reopen()).toThrow("QUEUE_ATTACHMENT_IDENTITY_CORRUPT");
  });
  test("new invalid Unicode is refused with no request or attachment writes", async () => {
    const f = await fixture();
    expect(() => f.store.enqueueIdempotent({ ...f.input, message: "bad\ud800" })).toThrow("QUEUE_ATTACHMENT_REQUEST_CONFLICT");
    expect(() => f.store.enqueueIdempotent({ ...f.input, attachments: [{ digest: attachment.digest,
      byteLength: attachment.byteLength, mediaType: attachment.mediaType, name: "bad\ud800.txt" }] }))
      .toThrow("An attachment name must be a single-line file name");
    expect(f.database.query("SELECT * FROM queue_entries").all()).toEqual([]);
    expect(f.database.query("SELECT * FROM queue_attachment_identities").all()).toEqual([]);
    expect(f.database.query("SELECT * FROM message_attachments").all()).toEqual([]);
  });
  test.each(["relocated", "missing"] as const)("reserves original key after its queue mutation is %s", async (mode) => {
    const f = await fixture(); f.enqueue();
    const replacement = randomUUID();
    const restore = f.dropGuard(mode === "relocated" ? "queue_attachment_mutation_update_guard" : "queue_attachment_mutation_delete_guard");
    f.database.exec("PRAGMA foreign_keys=OFF");
    if (mode === "relocated") f.database.query("UPDATE mutation_attempts SET idempotency_key=? WHERE idempotency_key=?").run(replacement, f.input.idempotencyKey);
    else f.database.query("DELETE FROM mutation_attempts WHERE idempotency_key=?").run(f.input.idempotencyKey);
    restore();
    const references = [{ digest: attachment.digest, name: attachment.name, mediaType: attachment.mediaType, byteLength: attachment.byteLength }];
    expect(() => f.store.readQueueEnqueueReplay({ ...f.input, attachments: references })).toThrow();
    if (mode === "relocated") expect(() => f.store.readQueueEnqueueReplay({ ...f.input, idempotencyKey: replacement, attachments: references })).toThrow();
    expect(() => f.store.prepareMutation({ kind: "session.rename", authorityId: f.session.id, authorityGeneration: f.authority.processGeneration,
      request: { title: "wrong owner" }, idempotencyKey: f.input.idempotencyKey })).toThrow();
    f.close(); expect(() => f.reopen()).toThrow("QUEUE_ATTACHMENT_IDENTITY_CORRUPT");
  });
  test("an anchor-only queue schema is refused without current-cohort repair", async () => {
    const f = await fixture(); f.enqueue();
    // Keep the genuine current cohort and every surviving marker/anchor. An
    // absent owned table is corruption, not permission to repair a legacy DB.
    f.database.exec("PRAGMA foreign_keys=OFF; DROP TABLE queue_attachment_identities");
    const before = f.database.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY name").all();
    const tables = f.database.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
    const retainedRows = () => tables.map(({ name }) => ({ name,
      rows: f.database.query(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all() }));
    const rowsBefore = retainedRows();
    expect(() => f.store.prepareMutation({ kind: "session.rename", authorityId: f.session.id, authorityGeneration: f.authority.processGeneration,
      request: {}, idempotencyKey: f.input.idempotencyKey })).toThrow();
    f.close();
    // Dropping the table also deletes its independently audited peer-cancellation
    // guard. Joined canonical admission checks that boundary before the later
    // retired-provider audit. Both open modes must preserve every surviving row.
    for (const readonly of [false, true]) {
      expect(() => { f.reopen(readonly); }).toThrow("PEER_SESSION_CANCELLATION_UNPROVEN");
      expect(f.database.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY name").all()).toEqual(before);
      expect(retainedRows()).toEqual(rowsBefore);
    }
    expect(f.database.query("PRAGMA user_version").get()).toEqual({ user_version: 61 });
  });
  test("a retained format marker prevents public manifest repair after both seals disappear", async () => {
    const f = await fixture(); const queue = f.enqueue();
    const restoreIdentity = f.dropGuard("queue_attachment_identities_immutable_delete");
    const restoreAnchor = f.dropGuard("queue_attachment_identity_anchors_immutable_delete");
    f.database.exec("PRAGMA foreign_keys=OFF");
    f.database.query("DELETE FROM queue_attachment_identity_anchors WHERE queue_id=?").run(queue.id);
    f.database.query("DELETE FROM queue_attachment_identities WHERE queue_id=?").run(queue.id);
    restoreIdentity(); restoreAnchor();
    expect(() => f.store.recordMessageAttachments({ sessionId: f.session.id, sourceId: queue.id, attachments: [] })).toThrow("QUEUE_ATTACHMENT_IDENTITY_CORRUPT");
    expect(() => f.database.query("INSERT INTO message_attachments(session_id,source_id,position,digest,name,media_type,byte_length,created_at) VALUES(?,?,1,?,'extra.txt','text/plain',13,20000)").run(f.session.id, queue.id, attachment.digest)).toThrow("QUEUE_ATTACHMENT_REQUEST_CONFLICT");
  });
  test("a deferred seal reference prevents an unsealed new-format queue commit", async () => {
    const f = await fixture();
    expect(() => f.database.query(`INSERT INTO queue_entries(id,session_id,message,state,enqueue_sequence,created_at,updated_at,enqueue_identity_format,enqueue_identity_attempt_id)
      VALUES(?,?,'unsealed','pending',500,1,1,'atomic_attachments_v1',?)`).run(`queue_${"a".repeat(32)}`, f.session.id, `attempt_${"a".repeat(32)}`)).toThrow("FOREIGN KEY constraint failed");
    expect(f.database.query("SELECT * FROM queue_entries").all()).toEqual([]);
  });
  test("identity and anchor failure roll back the entire queue transaction", async () => {
    const f = await fixture();
    f.database.exec("CREATE TRIGGER test_anchor_failure BEFORE INSERT ON queue_attachment_identity_anchors BEGIN SELECT RAISE(ABORT,'anchor injection'); END");
    expect(() => f.enqueue()).toThrow("anchor injection");
    expect(f.database.query("SELECT * FROM queue_entries").all()).toEqual([]);
    expect(f.database.query("SELECT * FROM mutation_attempts").all()).toEqual([]);
    expect(f.database.query("SELECT * FROM attachments").all()).toEqual([]);
  });
  test("transport loss retains quarantined pending input without disposing independent recovery", async () => {
    const f = await fixture(); const queued = f.enqueue();
    const restore = f.dropGuard("queue_attachment_manifest_delete_guard");
    f.database.query("DELETE FROM message_attachments WHERE source_id=?").run(queued.id); restore();
    f.store.quarantineQueueAttachmentIdentity({ queueId: queued.id, sessionId: f.session.id });
    const result = f.store.terminalizeSessionFromProviderDeletion({ sessionId: f.session.id, accountId: f.profile.id,
      providerAuthority: f.authority, providerGeneration: f.authority.processGeneration, providerConnectionId: null, source: "provider_transport_lost" });
    expect(result.session.state).toBe("recovery_required");
    expect(f.store.requireQueue(queued.id)).toMatchObject({ state: "pending", message: f.input.message });
    expect(f.store.hasUnsettledQueueAttachmentQuarantineForSession(f.session.id)).toBe(true);
  });
  test("pending abandonment refuses a separate unresolved mutation without settling or scrubbing it", async () => {
    const f = await fixture(); const queued = f.enqueue();
    const attempt = f.store.prepareMutation({ kind: "session.rename", authorityId: f.session.id, authorityGeneration: f.authority.processGeneration,
      request: { title: "possibly changed" }, providerAuthorities: [{ role: "primary", authority: f.authority, provenance: "session_rename" }] });
    f.store.transitionMutation(attempt.id, "prepared", "effect_started");
    const restore = f.dropGuard("queue_attachment_manifest_delete_guard");
    f.database.query("DELETE FROM message_attachments WHERE source_id=?").run(queued.id); restore();
    f.store.quarantineQueueAttachmentIdentity({ queueId: queued.id, sessionId: f.session.id });
    const current = f.store.requireSession(f.session.id);
    expect(() => f.store.abandonQueueAttachmentQuarantinedSession({ sessionId: current.id, expectedRevision: current.revision })).toThrow("QUEUE_ATTACHMENT_IDENTITY_UNPROVED");
    expect(f.store.requireQueue(queued.id).message).toBe(f.input.message);
    expect(f.database.query("SELECT * FROM queue_attachment_quarantines WHERE ordinal=2").all()).toEqual([]);
    expect(f.database.query("SELECT state FROM mutation_attempts WHERE id=?").get(attempt.id)).toEqual({ state: "effect_started" });
    expect(f.database.query("SELECT * FROM mutation_resolutions WHERE attempt_id=?").get(attempt.id)).toBeNull();
  });
  test.each(["dispatching", "ambiguous"] as const)("retains %s attachments beyond the display cap", async (state) => {
    const f = await fixture(); const queued = f.enqueue();
    const binding = f.store.requireSessionPresetRequirement(f.session.id);
    const evidence = f.store.beginQueueEffect({ queueId: queued.id, sessionId: f.session.id, profileGeneration: f.authority.processGeneration, providerAuthority: f.authority,
      providerConnectionId: "48000000-0000-4000-8000-000000000003",
      evidence: { kind: "queue.dispatch", queueId: queued.id, sessionId: f.session.id, providerThreadId: "queue-integrity", profileGeneration: f.authority.processGeneration,
        baseline: { providerUpdatedAt: null, status: "idle", activeTurnId: null }, clientMessageId: queued.id,
        messageDigest: createHash("sha256").update(f.input.message).digest("hex"), runtimeProfile: effectiveRuntimeProfileSchema.parse({
          profileId: f.profile.id, processGeneration: f.profile.processGeneration, observedAt: 2_000,
          preset: binding.preset, model: binding.requirement.model, reasoningEffort: binding.requirement.effort,
          serviceTier: null, fast: false, approvalPolicy: "on-request", reviewMode: "auto_review", permissionProfile: ":workspace", computerUse: true, pluginCapability: true, enabledApps: [],
        }) } });
    if (state === "ambiguous") f.store.markQueueEffectAmbiguous(queued.id, evidence.digest);
    for (let index = 0; index < 201; index++) f.store.recordMessageAttachments({ sessionId: f.session.id, sourceId: `display_${String(index)}`, attachments: [attachment] });
    expect(f.store.requireQueue(queued.id).state).toBe(state);
    expect(f.store.queueAttachmentManifest(queued.id)).toHaveLength(1);
    expect(() => f.database.query("DELETE FROM message_attachments WHERE source_id=?").run(queued.id)).toThrow("QUEUE_ATTACHMENT_IDENTITY_CORRUPT");
  });
  test.each(["none", "occurrence", "schedule"] as const)("scheduled task uses one sealed empty queue and rolls back every row after %s failure", async (failure) => {
    const f = await fixture();
    const projectRoot = await realpath(await mkdtemp(join(tmpdir(), "oompa-queue-task-project-")));
    const project = await f.store.createProject("Scheduled queue project", projectRoot);
    f.store.updateSessionMetadata({ sessionId: f.session.id, expectedRevision: f.session.revision, projectId: project.id });
    const tasks = f.store.createSessionTaskStore();
    const task = tasks.create({ sessionId: f.session.id, name: "Scheduled inspection", prompt: "Inspect the project.", minutes: 15, status: "active", idempotencyKey: randomUUID() });
    if (task.nextDueAt === null) throw new Error("task due time missing");
    f.clock.now = task.nextDueAt;
    const snapshot = () => ["queue_entries", "mutation_attempts", "mutation_provider_authorities", "queue_provider_authorities", "queue_attachment_identities", "queue_attachment_identity_anchors", "queue_sequence_authority", "session_task_occurrences", "session_tasks"]
      .map((table) => f.database.query(`SELECT * FROM ${table}`).all());
    if (failure !== "none") {
      const before = snapshot();
      f.database.exec(failure === "occurrence"
        ? "CREATE TRIGGER test_task_failure BEFORE INSERT ON session_task_occurrences BEGIN SELECT RAISE(ABORT,'task injection'); END"
        : "CREATE TRIGGER test_task_failure BEFORE UPDATE OF next_due_at ON session_tasks BEGIN SELECT RAISE(ABORT,'task injection'); END");
      await expect(tasks.materializeDue({ now: task.nextDueAt })).rejects.toThrow("task injection");
      expect(snapshot()).toEqual(before);
      f.database.exec("DROP TRIGGER test_task_failure");
    }
    const materialized = await tasks.materializeDue({ now: task.nextDueAt });
    expect(materialized).toHaveLength(1);
    const queue = materialized[0]?.queue;
    if (queue === undefined) throw new Error("scheduled queue missing");
    expect(f.store.queueAttachmentManifest(queue.id)).toEqual([]);
    expect(f.database.query("SELECT kind,state FROM mutation_attempts WHERE kind='session.queue'").all()).toEqual([{ kind: "session.queue", state: "applied" }]);
    expect(f.database.query("SELECT queue_id FROM queue_attachment_identity_anchors").all()).toEqual([{ queue_id: queue.id }]);
    const binding = f.store.requireSessionPresetRequirement(f.session.id);
    const started = f.store.beginQueueEffect({ queueId: queue.id, sessionId: f.session.id, profileGeneration: f.authority.processGeneration, providerAuthority: f.authority,
      providerConnectionId: "48000000-0000-4000-8000-000000000003",
      evidence: { kind: "queue.dispatch", queueId: queue.id, sessionId: f.session.id, providerThreadId: "queue-integrity", profileGeneration: f.authority.processGeneration,
        baseline: { providerUpdatedAt: null, status: "idle", activeTurnId: null }, clientMessageId: queue.id,
        messageDigest: createHash("sha256").update(queue.message).digest("hex"), runtimeProfile: effectiveRuntimeProfileSchema.parse({
          profileId: f.profile.id, processGeneration: f.profile.processGeneration, observedAt: 2_000,
          preset: binding.preset, model: binding.requirement.model, reasoningEffort: binding.requirement.effort,
          serviceTier: null, fast: false, approvalPolicy: "on-request", reviewMode: "auto_review", permissionProfile: ":workspace", computerUse: true, pluginCapability: true, enabledApps: [],
        }) } });
    expect(started.queueId).toBe(queue.id);
    expect(f.store.requireQueue(queue.id).state).toBe("dispatching");
  });
});
