import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { effectiveRuntimeProfileSchema } from "../domain/runtime-profile";
import type { SessionSendRequest } from "../domain/session-send-request";
import { createAttemptId } from "../domain/values";
import { AttachmentBlobStore } from "./attachment-store";
import { initializeStatePaths, resolveStatePaths } from "./paths";
import { insertSessionSendOwner } from "./session-send-owner";
import { MESSAGE_ATTACHMENT_SOURCE_PER_SESSION_CAP, StateStore, type StoredMessageAttachment } from "./state-store";

const stores: StateStore[] = [];
const databases: Database[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const database of databases.splice(0)) database.close(false);
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(kind: "attached" | "attachment_only" | "text" = "attached") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "oompa-owned-send-manifest-")));
  roots.push(root);
  const paths = resolveStatePaths({ rootDirectory: root });
  await initializeStatePaths(paths);
  const now = 1_900_000_000_000;
  const open = (readonly = false) => {
    const store = new StateStore(paths, { readonly, now: () => now, resolveMachineTimeZone: () => "UTC" });
    stores.push(store);
    return store;
  };
  const store = open();
  const bootId = `boot_${randomUUID().replaceAll("-", "")}`;
  const daemon = { bootId, daemonGeneration: store.nextDaemonGeneration(bootId) };
  const profile = store.nextProfileGeneration(store.createProfile("Owned manifest source").id);
  expect(store.setProfileState(profile.id, profile.processGeneration, "signed_in", {
    email: "owned-manifest@example.com", plan: "Plus",
  })).toBe(true);
  // Converge the unrelated lazy usage sequence before any reopen snapshot.
  expect(store.allocateNextUsageRevision(profile.id)).toBe(1);
  const created = store.createSession({ profileId: profile.id, preset: "high", fastEnabled: false });
  const session = store.bindSession({ sessionId: created.id, expectedRevision: created.revision,
    providerThreadId: "owned-manifest-thread", state: "idle" });
  const blobs = AttachmentBlobStore.forStatePaths(paths);
  const attachments: StoredMessageAttachment[] = [];
  if (kind !== "text") {
    for (const [name, mediaType, body] of [
      ["notes.md", "text/markdown", "# Original notes\nKeep these exact bytes."],
      ["rows.csv", "text/csv", "name,value\none,1\ntwo,2"],
    ] as const) {
      const stored = await blobs.put("text/plain", new TextEncoder().encode(body));
      if (stored.kind !== "stored") throw new Error("Expected real fixture blob custody.");
      await utimes(stored.value.path, new Date(1_000), new Date(1_000));
      attachments.push({ name, mediaType, digest: stored.value.digest,
        byteLength: stored.value.byteLength, canonicalMediaType: "text/plain" });
    }
  }
  const references = attachments.map(({ byteLength, digest, mediaType, name }) => ({ byteLength, digest, mediaType, name }));
  const request: SessionSendRequest = { kind: "session.send", idempotencyKey: randomUUID(), session: session.id,
    message: kind === "attachment_only" ? "" : "One original send.", attachments: references };
  const reservation = store.reserveOriginalSessionSendIngress({ request, ...daemon });
  if (reservation.kind === "owned") throw new Error("Expected a fresh original key.");
  const prepared = store.prepareOwnedSessionSendWithCustody({ request, ...daemon,
    ...(reservation.kind === "reserved" ? { reservation: {
      reservationId: reservation.reservationId, reservationDigest: reservation.reservationDigest,
    } } : {}),
  });
  const authority = prepared.owner.sourceAuthority;
  const runtimeProfile = effectiveRuntimeProfileSchema.parse({
    profileId: profile.id, processGeneration: profile.processGeneration, observedAt: now, preset: "high",
    model: "gpt-6-astra", reasoningEffort: "max", serviceTier: null, fast: false,
    approvalPolicy: "on-request", reviewMode: "auto_review", permissionProfile: ":workspace",
    computerUse: true, pluginCapability: true, enabledApps: [],
  });
  const evidence = { kind: "session.send" as const, providerThreadId: prepared.owner.sourceThreadId,
    baseline: { providerUpdatedAt: null, status: "idle" as const, activeTurnId: null },
    clientMessageId: prepared.owner.attemptId, messageDigest: prepared.owner.fingerprint.inputDigest, runtimeProfile };
  const claimInput = { attemptId: prepared.owner.attemptId, ownerDigest: prepared.ownerDigest,
    requestFingerprint: prepared.owner.fingerprint, ...daemon,
    expectedSessionRevision: prepared.owner.sourceSessionRevision, executionAuthority: authority, evidence };
  const input = { ...claimInput, attachments };
  const database = new Database(paths.database, { strict: true });
  databases.push(database);
  database.exec("PRAGMA foreign_keys=ON");
  const snapshot = () => ({
    version: database.query("PRAGMA user_version").get(),
    schema: database.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all(),
    tables: database.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
      .map(({ name }) => ({ name, rows: database.query(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all() })),
  });
  const pins = () => ({
    sets: database.query("SELECT * FROM attachment_custody_sets ORDER BY id").all(),
    members: database.query("SELECT * FROM attachment_custody_members ORDER BY custody_id,position").all(),
    slots: database.query("SELECT * FROM attachment_custody_slots ORDER BY slot").all(),
  });
  const cleanup = (attachment: StoredMessageAttachment, currentDaemon = daemon) => {
    if (attachment.canonicalMediaType !== "text/plain") throw new Error("Expected the fixture's verified text/plain blob.");
    return store.cleanupAttachmentCandidate({ ...currentDaemon,
      candidate: { kind: "blob", digest: attachment.digest, canonicalMediaType: attachment.canonicalMediaType } });
  };
  return { store, open, database, paths, now, daemon, profile, session, request, prepared, authority,
    runtimeProfile, evidence, claimInput, input, attachments, references, snapshot, pins, cleanup };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
const firstAttachment = (value: Fixture): StoredMessageAttachment => {
  const attachment = value.attachments[0];
  if (attachment === undefined) throw new Error("Expected an attached fixture.");
  return attachment;
};
const assertInert = (value: Fixture, action: () => unknown, diagnostic: string) => {
  const before = value.snapshot();
  expect(action).toThrow(diagnostic);
  expect(value.snapshot()).toEqual(before);
};
const insertAccounting = (value: Fixture, attachment = firstAttachment(value)) => value.database.query(
  "INSERT INTO attachments(digest,media_type,byte_length,created_at,reference_count) VALUES(?,?,?,?,0)",
).run(attachment.digest, attachment.canonicalMediaType, attachment.byteLength, value.now);

/* Field order and digest preimages transcribed from the pure source at
 * 8f69a8334d8d336e52b82df4ae21201b72fd0379, not an archived database capture:
 * session-send-owner.ts blob 4903b718877b4d50862f1b3474ea620c07b10ddd;
 * state-store.ts blob dbdd1766d70cb6ccb88e7d5651e37ec531138343;
 * runtime-profile.ts blob 9115f760bda97ce3a11a577593baebf3eb364727;
 * provider-accounts.ts blob 422072cc60828c9bc9fe27428296d1428decdc68.
 * Do not derive this oracle from the current claim/profile serializers. The
 * model is independent example input, not a captured historical authority:
 * newly created High sessions now select Sol without changing the v1 layout. */
function assertV1Bytes(value: Fixture, model: string, daemon = value.daemon) {
  const runtimeProfile = { profileId: value.profile.id, processGeneration: value.profile.processGeneration,
    observedAt: value.now, preset: "high", model, reasoningEffort: "max", serviceTier: null,
    fast: false, approvalPolicy: "on-request", reviewMode: "auto_review", permissionProfile: ":workspace",
    computerUse: true, pluginCapability: true, enabledApps: [] };
  const authority = { profileId: value.authority.profileId, bindingGeneration: value.authority.bindingGeneration,
    processGeneration: value.authority.processGeneration, provider: "codex", providerAccountId: value.authority.providerAccountId };
  const evidence = { kind: "session.send", providerThreadId: value.prepared.owner.sourceThreadId,
    baseline: { providerUpdatedAt: null, status: "idle", activeTurnId: null },
    clientMessageId: value.prepared.owner.attemptId, messageDigest: value.prepared.owner.fingerprint.inputDigest, runtimeProfile };
  const evidenceJson = JSON.stringify(evidence);
  const evidenceDigest = createHash("sha256").update(evidenceJson).digest("hex");
  const claim = { version: 1, mode: "direct", attemptId: value.prepared.owner.attemptId, ownerDigest: value.prepared.ownerDigest,
    daemonGeneration: daemon.daemonGeneration, bootId: daemon.bootId, executionAuthority: authority,
    sessionRevision: value.prepared.owner.sourceSessionRevision, sessionAuthorityRevision: value.prepared.owner.sourceAuthorityRevision,
    providerThreadId: value.prepared.owner.sourceThreadId, clientMessageId: value.prepared.owner.attemptId,
    evidence, evidenceDigest, createdAt: value.now };
  expect(value.database.query("SELECT claim_json,claim_digest FROM session_send_execution_claims WHERE attempt_id=?")
    .get(value.prepared.owner.attemptId)).toEqual({ claim_json: JSON.stringify(claim),
    claim_digest: createHash("sha256").update(JSON.stringify({ domain: "hra.session-send.claim.v1", value: claim })).digest("hex") });
  expect(value.database.query("SELECT evidence_json,evidence_digest FROM mutation_effect_evidence WHERE attempt_id=?")
    .get(value.prepared.owner.attemptId)).toEqual({ evidence_json: evidenceJson, evidence_digest: evidenceDigest });
}

describe("owned direct-send manifest admission", () => {
  test("refuses historical Sol evidence for a current Astra session without consuming its owner", async () => {
    const value = await fixture();
    expect(value.store.requireSessionPresetRequirement(value.session.id)).toEqual({
      preset: "high", requirement: { model: "gpt-6-astra", effort: "max" },
    });
    const historicalRuntime = effectiveRuntimeProfileSchema.parse({ ...value.runtimeProfile, model: "gpt-5.6-sol" });
    assertInert(value, () => value.store.beginOwnedDirectSendEffect({
      ...value.input, evidence: { ...value.evidence, runtimeProfile: historicalRuntime },
    }), "SESSION_RUNTIME_PROFILE_PRESET_CONTRACT_MISMATCH");
    expect(value.store.readOwnedSessionSend(value.request.idempotencyKey)?.state).toBe("input_required");
    expect(value.store.beginOwnedDirectSendEffect(value.input).dispatchGranted).toBe(true);
    assertV1Bytes(value, "gpt-6-astra");
  });

  test("admits attached manifest atomically with one existing-format claim", async () => {
    const value = await fixture();
    const pinsBefore = value.pins();
    expect(value.store.messageAttachmentManifest(value.session.id, value.prepared.owner.attemptId)).toEqual([]);
    const begun = value.store.beginOwnedDirectSendEffect(value.input);
    expect(begun).toMatchObject({ dispatchGranted: true, state: "effect_started", claim: { version: 1, mode: "direct" } });
    expect(begun.claim?.evidenceDigest).toBe(createHash("sha256").update(JSON.stringify(value.evidence)).digest("hex"));
    expect(value.store.messageAttachmentManifest(value.session.id, value.prepared.owner.attemptId)).toEqual(value.references);
    assertV1Bytes(value, "gpt-6-astra");
    expect(value.pins()).toEqual(pinsBefore);
    for (const attachment of value.attachments) {
      expect(value.store.attachmentCustody(attachment.digest)).toMatchObject({ digest: attachment.digest,
        byteLength: attachment.byteLength, canonicalMediaType: attachment.canonicalMediaType, referenceCount: 1 });
      expect(value.cleanup(attachment)).toEqual({ kind: "retained", reason: "reserved" });
    }
    const beforeReopen = value.snapshot();
    for (const readonly of [false, true]) {
      const reopened = value.open(readonly);
      expect(reopened.readOwnedSessionSend(value.request.idempotencyKey)?.state).toBe("effect_started");
      expect(reopened.messageAttachmentManifest(value.session.id, value.prepared.owner.attemptId)).toEqual(value.references);
      assertV1Bytes(value, "gpt-6-astra");
      expect(value.snapshot()).toEqual(beforeReopen);
    }
  });

  test("admits attachment-only input under the exact original client message id", async () => {
    const value = await fixture("attachment_only");
    expect(value.prepared.owner.fingerprint.inputUtf8Bytes).toBe(0);
    const begun = value.store.beginOwnedDirectSendEffect(value.input);
    expect(begun).toMatchObject({ dispatchGranted: true, state: "effect_started" });
    expect(value.store.messageAttachmentManifest(value.session.id, value.prepared.owner.attemptId)).toEqual(value.references);
    expect(value.store.messageAttachmentManifest(value.session.id, value.request.idempotencyKey)).toEqual([]);
    assertV1Bytes(value, "gpt-6-astra");
  });

  for (const omitted of [false, true]) {
    test(`preserves text-only v1 claim bytes and reopens with metadata omitted=${omitted}`, async () => {
      const value = await fixture("text");
      const ownerBefore = value.database.query("SELECT * FROM session_send_owners").all();
      expect(value.store.beginOwnedDirectSendEffect(omitted ? value.claimInput : value.input).dispatchGranted).toBe(true);
      expect(value.store.messageAttachmentManifest(value.session.id, value.prepared.owner.attemptId)).toEqual([]);
      expect(value.database.query("SELECT * FROM attachments").all()).toEqual([]);
      assertV1Bytes(value, "gpt-6-astra");
      const before = value.snapshot();
      for (const readonly of [false, true]) {
        expect(value.open(readonly).readOwnedSessionSend(value.request.idempotencyKey)?.state).toBe("effect_started");
        assertV1Bytes(value, "gpt-6-astra");
        expect(value.snapshot()).toEqual(before);
      }
      expect(value.database.query("SELECT * FROM session_send_owners").all()).toEqual(ownerBefore);
    });
  }

  test("requires metadata for attached ownership and rejects every changed ordered reference inertly", async () => {
    const value = await fixture();
    assertInert(value, () => value.store.beginOwnedDirectSendEffect(value.claimInput), "ATTACHMENT_CUSTODY_UNPROVED");
    const first = firstAttachment(value);
    const variants: readonly StoredMessageAttachment[][] = [
      [], value.attachments.slice(1), value.attachments.toReversed(),
      [{ ...first, name: "other.md" }, ...value.attachments.slice(1)],
      [{ ...first, mediaType: "text/plain" }, ...value.attachments.slice(1)],
      [{ ...first, byteLength: first.byteLength + 1 }, ...value.attachments.slice(1)],
      [{ ...first, digest: "f".repeat(64) }, ...value.attachments.slice(1)],
      [{ ...first, canonicalMediaType: "image/png" }, ...value.attachments.slice(1)],
      [{ ...first, canonicalMediaType: "text/markdown" }, ...value.attachments.slice(1)],
    ];
    for (const attachments of variants) assertInert(value,
      () => value.store.beginOwnedDirectSendEffect({ ...value.claimInput, attachments }), "ATTACHMENT_CUSTODY_REQUEST_CONFLICT");
    const text = await fixture("text");
    assertInert(text, () => text.store.beginOwnedDirectSendEffect({ ...text.claimInput, attachments: value.attachments }), "ATTACHMENT_CUSTODY_REQUEST_CONFLICT");
  });

  test("rejects malformed metadata and bounded-list violations without any write", async () => {
    const value = await fixture();
    const first = firstAttachment(value);
    const variants = [
      [{ ...first, privateExtra: "not admitted" }], [{ ...first, byteLength: 0 }],
      [{ ...first, name: "../escape.txt" }], [{ ...first, name: "broken\ud800.txt" }],
      [{ ...first, digest: "not-a-digest" }], [{ ...first, canonicalMediaType: "application/zip" }],
      [first, first],
      Array.from({ length: 9 }, (_, index) => ({ ...first, name: `item-${String(index)}.txt` })),
      Array.from({ length: 3 }, (_, index) => ({ ...first, name: `large-${String(index)}.txt`, byteLength: 5 * 1024 * 1024 })),
    ];
    for (const attachments of variants) {
      // Inputs deliberately cross the foreign-value boundary; avoid a cast
      // that would make the invalid metadata appear to be validated storage data.
      const input = { ...value.claimInput };
      Object.defineProperty(input, "attachments", { value: attachments });
      assertInert(value, () => value.store.beginOwnedDirectSendEffect(input), "ATTACHMENT_CUSTODY_INVALID_INPUT");
    }
  });

  test("parses metadata before any caller-supplied array map can substitute authority", async () => {
    const value = await fixture();
    const attachments = value.attachments.map((entry) => ({ ...entry, name: "changed.txt" }));
    let mapCalls = 0;
    Object.defineProperty(attachments, "map", { value: () => { mapCalls += 1; return value.attachments; } });
    assertInert(value, () => value.store.beginOwnedDirectSendEffect({ ...value.claimInput, attachments }), "ATTACHMENT_CUSTODY_REQUEST_CONFLICT");
    expect(mapCalls).toBe(0);
  });

  for (const initiallyPresent of [false, true]) {
    test(`takes one metadata accessor snapshot (initially present=${initiallyPresent})`, async () => {
      const value = await fixture();
      const input = { ...value.claimInput };
      let reads = 0;
      Object.defineProperty(input, "attachments", { get: () => {
        reads += 1;
        return (reads === 1) === initiallyPresent ? value.attachments : undefined;
      } });
      if (initiallyPresent) {
        expect(value.store.beginOwnedDirectSendEffect(input).dispatchGranted).toBe(true);
        expect(value.store.messageAttachmentManifest(value.session.id, value.prepared.owner.attemptId)).toEqual(value.references);
      } else assertInert(value, () => value.store.beginOwnedDirectSendEffect(input), "ATTACHMENT_CUSTODY_UNPROVED");
      expect(reads).toBe(1);
    });
  }

  for (const corruption of ["name", "media_type", "accounting_type", "accounting_size"] as const) {
    test(`refuses preexisting ${corruption} disagreement without overwriting it`, async () => {
      const value = await fixture();
      const first = firstAttachment(value);
      insertAccounting(value, { ...first,
        ...(corruption === "accounting_type" ? { canonicalMediaType: "image/png" as const } : {}),
        ...(corruption === "accounting_size" ? { byteLength: first.byteLength + 1 } : {}),
      });
      if (corruption === "name" || corruption === "media_type") value.database.query(
        "INSERT INTO message_attachments(session_id,source_id,position,digest,name,media_type,byte_length,created_at) VALUES(?,?,0,?,?,?,?,?)",
      ).run(value.session.id, value.prepared.owner.attemptId, first.digest,
        corruption === "name" ? "wrong.md" : first.name,
        corruption === "media_type" ? "text/plain" : first.mediaType, first.byteLength, value.now);
      assertInert(value, () => value.store.beginOwnedDirectSendEffect(value.input),
        corruption === "name" || corruption === "media_type"
          ? "MESSAGE_ATTACHMENT_IDENTITY_CONFLICT" : "ATTACHMENT_CUSTODY_IDENTITY_CONFLICT");
    });
  }

  test("refuses an extra retained-source manifest row after exact guard restoration", async () => {
    const value = await fixture();
    const first = firstAttachment(value);
    insertAccounting(value);
    const guard = value.database.query<{ sql: string }, []>(
      "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='attachment_manifest_input_guard'",
    ).get();
    if (guard === null) throw new Error("Expected the exact manifest input guard.");
    value.database.exec("DROP TRIGGER attachment_manifest_input_guard");
    try {
      value.database.query("INSERT INTO message_attachments(session_id,source_id,position,digest,name,media_type,byte_length,created_at) VALUES(?,?,2,?,?,?,?,?)")
        .run(value.session.id, value.prepared.owner.attemptId, first.digest, "extra.md", first.mediaType, first.byteLength, value.now);
    } finally { value.database.exec(guard.sql); }
    assertInert(value, () => value.store.beginOwnedDirectSendEffect(value.input), "MESSAGE_ATTACHMENT_COUNT_CONFLICT");
  });

  for (const [name, boundary] of [
    ["accounting", "AFTER INSERT ON attachments"],
    ["manifest", "AFTER INSERT ON message_attachments WHEN NEW.position=1"],
    ["claim", "AFTER INSERT ON session_send_execution_claims"],
    ["anchor", "AFTER INSERT ON session_send_owner_anchors WHEN NEW.kind='claim'"],
    ["evidence", "AFTER INSERT ON mutation_effect_evidence"],
    ["state", "AFTER UPDATE OF state ON mutation_attempts WHEN NEW.state='effect_started'"],
  ] as const) {
    test(`rolls back the complete admission at the ${name} write boundary`, async () => {
      const value = await fixture();
      const before = value.snapshot();
      // The provenance writer deliberately redacts arbitrary SQLite errors.
      // Inject its one preserved closed diagnostic at the evidence INSERT so
      // that receiving it proves this trigger ran, not an earlier corruption
      // refusal. The identical input must succeed after removing the trigger.
      const fault = name === "evidence" ? "EFFECT_EVIDENCE_PROVENANCE_LIMIT" : "owned-manifest-fault";
      value.database.exec(`CREATE TRIGGER test_owned_manifest_fault ${boundary} BEGIN SELECT RAISE(ABORT,'${fault}'); END`);
      try { assertInert(value, () => value.store.beginOwnedDirectSendEffect(value.input), fault); }
      finally { value.database.exec("DROP TRIGGER test_owned_manifest_fault"); }
      expect(value.snapshot()).toEqual(before);
      expect(value.store.readOwnedSessionSend(value.request.idempotencyKey)?.state).toBe("input_required");
      expect(value.store.beginOwnedDirectSendEffect(value.input).dispatchGranted).toBe(true);
      expect(value.store.messageAttachmentManifest(value.session.id, value.prepared.owner.attemptId)).toEqual(value.references);
    });
  }

  test("rolls back unrelated pruning and reference counts when the later claim insert fails", async () => {
    const value = await fixture();
    const first = firstAttachment(value);
    insertAccounting(value);
    // Synthetic already-retained legacy sources deliberately exceed today's
    // projection cap; inserting via the public writer would prune during setup.
    for (let index = 0; index <= MESSAGE_ATTACHMENT_SOURCE_PER_SESSION_CAP; index += 1) value.database.query(
      "INSERT INTO message_attachments(session_id,source_id,position,digest,name,media_type,byte_length,created_at) VALUES(?,?,0,?,?,?,?,?)",
    ).run(value.session.id, `legacy_prunable_${String(index).padStart(3, "0")}`, first.digest, first.name, first.mediaType, first.byteLength, value.now - 1);
    expect(value.store.attachmentCustody(first.digest)?.referenceCount).toBe(201);
    const before = value.snapshot();
    value.database.exec("CREATE TRIGGER test_owned_manifest_fault AFTER INSERT ON session_send_execution_claims BEGIN SELECT RAISE(ABORT,'owned-manifest-fault'); END");
    try { assertInert(value, () => value.store.beginOwnedDirectSendEffect(value.input), "owned-manifest-fault"); }
    finally { value.database.exec("DROP TRIGGER test_owned_manifest_fault"); }
    expect(value.snapshot()).toEqual(before);
    expect(value.store.beginOwnedDirectSendEffect(value.input).dispatchGranted).toBe(true);
    expect(value.database.query("SELECT COUNT(DISTINCT source_id) AS count FROM message_attachments WHERE source_id LIKE 'legacy_prunable_%'").get())
      .toEqual({ count: MESSAGE_ATTACHMENT_SOURCE_PER_SESSION_CAP });
    expect(value.store.attachmentCustody(first.digest)?.referenceCount).toBe(201);
  });

  for (const reverse of [false, true]) {
    test(`two connections grant one permit and never rewrite the winner (reverse=${reverse})`, async () => {
      const value = await fixture();
      const other = value.open();
      const [winner, loser] = reverse ? [other, value.store] : [value.store, other];
      expect(winner.beginOwnedDirectSendEffect(value.input).dispatchGranted).toBe(true);
      const before = value.snapshot();
      expect(() => loser.beginOwnedDirectSendEffect(value.input)).toThrow("SESSION_SEND_CLAIM_CONFLICT");
      expect(value.snapshot()).toEqual(before);
      assertV1Bytes(value, "gpt-6-astra");
    });
  }

  for (const cancelFirst of [false, true]) {
    test(`cancellation and attached dispatch remain exclusive (cancel first=${cancelFirst})`, async () => {
      const value = await fixture();
      const other = value.open();
      const cancel = { attemptId: value.prepared.owner.attemptId, ownerDigest: value.prepared.ownerDigest };
      if (cancelFirst) {
        other.cancelOwnedSessionSend(cancel);
        const before = value.snapshot();
        expect(() => value.store.beginOwnedDirectSendEffect(value.input)).toThrow();
        expect(value.snapshot()).toEqual(before);
        expect(value.store.messageAttachmentManifest(value.session.id, cancel.attemptId)).toEqual([]);
      } else {
        value.store.beginOwnedDirectSendEffect(value.input);
        assertInert(value, () => other.cancelOwnedSessionSend(cancel), "SESSION_SEND_CLAIM_CONFLICT");
      }
    });
  }

  test("rolls back manifest admission at the late daemon fence without changing source authority", async () => {
    const value = await fixture();
    assertInert(value, () => value.store.beginOwnedDirectSendEffect({ ...value.input,
      daemonGeneration: value.daemon.daemonGeneration + 1,
    }), "SESSION_SEND_CLAIM_CONFLICT");
    assertInert(value, () => value.store.beginOwnedDirectSendEffect({ ...value.input,
      bootId: `boot_${randomUUID().replaceAll("-", "")}`,
    }), "SESSION_SEND_CLAIM_CONFLICT");
    expect(value.store.beginOwnedDirectSendEffect(value.input).dispatchGranted).toBe(true);
    expect(value.store.messageAttachmentManifest(value.session.id, value.prepared.owner.attemptId)).toEqual(value.references);
    assertV1Bytes(value, "gpt-6-astra");
  });

  test("retains old-boot owned pins without reviving restart-retired source authority", async () => {
    const value = await fixture();
    const original = value.store.readOwnedSessionSend(value.request.idempotencyKey);
    const pinsBefore = value.pins();
    const nextBoot = `boot_${randomUUID().replaceAll("-", "")}`;
    const daemon = { bootId: nextBoot, daemonGeneration: value.store.nextDaemonGeneration(nextBoot) };
    expect(value.store.requireProviderAccountAuthority(value.profile.id, "codex").processGeneration)
      .toBeGreaterThan(value.prepared.owner.sourceAuthority.processGeneration);
    expect(value.store.readOwnedSessionSend(value.request.idempotencyKey)).toEqual(original);
    expect(value.pins()).toEqual(pinsBefore);
    for (const currentDaemon of [value.daemon, daemon]) assertInert(value,
      () => value.store.beginOwnedDirectSendEffect({ ...value.input, ...currentDaemon }), "SESSION_SEND_SOURCE_CHANGED");
    expect(value.store.messageAttachmentManifest(value.session.id, value.prepared.owner.attemptId)).toEqual([]);
    for (const attachment of value.attachments) expect(value.cleanup(attachment, daemon)).toEqual({ kind: "retained", reason: "reserved" });
    expect(value.pins()).toEqual(pinsBefore);
  });

  test("metadata cannot bless an unmarked historical-format attached owner", async () => {
    const value = await fixture();
    const legacy = value.database.transaction(() => insertSessionSendOwner(value.database, {
      ...value.prepared.owner, attemptId: createAttemptId(), idempotencyKey: randomUUID(),
    })).immediate();
    expect(value.database.query("SELECT attachment_input_format FROM mutation_attempts WHERE id=?").get(legacy.owner.attemptId))
      .toEqual({ attachment_input_format: null });
    assertInert(value, () => value.store.beginOwnedDirectSendEffect({ ...value.input,
      attemptId: legacy.owner.attemptId, ownerDigest: legacy.ownerDigest,
      evidence: { ...value.evidence, clientMessageId: legacy.owner.attemptId },
    }), "ATTACHMENT_CUSTODY_UNPROVED");
  });

  for (const outcome of ["ambiguous", "accepted"] as const) {
    test(`keeps the manifest and original claim immutable after ${outcome} settlement`, async () => {
      const value = await fixture();
      const begun = value.store.beginOwnedDirectSendEffect(value.input);
      if (begun.claimDigest === null) throw new Error("Expected a committed claim digest.");
      const beforeClaim = value.database.query("SELECT * FROM session_send_execution_claims").all();
      value.store.settleOwnedDirectSend({ attemptId: begun.owner.attemptId, ownerDigest: begun.ownerDigest,
        claimDigest: begun.claimDigest, outcome: outcome === "ambiguous"
          ? { kind: "ambiguous", reason: "provider_outcome_unknown" }
          : { kind: "accepted", receipt: { turnId: "owned-manifest-turn", status: "completed",
              sourceId: begun.owner.attemptId, effectiveRuntimeProfile: value.runtimeProfile } },
      });
      const before = value.snapshot();
      expect(() => value.store.beginOwnedDirectSendEffect(value.input)).toThrow();
      expect(value.snapshot()).toEqual(before);
      expect(value.database.query("SELECT * FROM session_send_execution_claims").all()).toEqual(beforeClaim);
      expect(value.store.messageAttachmentManifest(value.session.id, begun.owner.attemptId)).toEqual(value.references);
      for (const attachment of value.attachments) expect(value.cleanup(attachment))
        .toEqual({ kind: "retained", reason: outcome === "ambiguous" ? "reserved" : "referenced" });
      assertV1Bytes(value, "gpt-6-astra");
    });
  }
});
