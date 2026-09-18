import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { z } from "zod";
import { canonical40UsageDatabaseBytes, canonical40UsageFixture } from "../../scripts/fixtures/canonical40-usage";
import { canonicalBudgetFixtures } from "../../scripts/fixtures/canonical-budget-history";
import { canonicalAuthBudgetFixtures } from "../../scripts/fixtures/canonical-auth-budget";
import { canonical34StorageFixture } from "../../scripts/fixtures/canonical34-storage";
import { canonicalIdentityAttentionFixtures } from "../../scripts/fixtures/canonical-identity-attention";
import { canonical35To38Fixture } from "../../scripts/fixtures/canonical35-38";
import { canonical38RuntimeFixture } from "../../scripts/fixtures/canonical38-runtime";
import { canonicalResetPolicyFixtures } from "../../scripts/fixtures/canonical-reset-policy";
import { combined49RetiredFixture } from "../../scripts/fixtures/combined49-retired";
import { canonical39DevinFixture } from "../../scripts/fixtures/canonical39-devin";
import { retiredSuccessorFixtures } from "../../scripts/fixtures/retired-successors";
import { ROOT_STATUS_ATTENTION_LIMIT, ROOT_STATUS_MAXIMUM_BYTES, sessionLocalObservationSnapshotSchema } from "../domain/observation";
import type { InteractionDisplay, InteractionKind } from "../domain/interactions";
import { legacyPresetContract, presetRequirements } from "../domain/presets";
import { SESSION_EVENT_MAX_BYTES, SESSION_EVENT_PUBLIC_MAX_BYTES, SESSION_EVENT_RETAIN_AGE_MS, SESSION_EVENT_USER_MESSAGE_MAX_CHARACTERS } from "../domain/session-events";
import { createClaudeAccountingUsageComponent, providerUsageDigest, usageProviderAccountAuthoritySchema } from "../domain/provider-usage";
import { accountUsageCounterSamples, observedAccountTokenVelocity, type StoredAccountUsageSnapshot } from "../domain/usage-metrics";
import { utf8Bytes } from "../domain/values";
import { initializeStatePaths, resolveStatePaths } from "./paths";
import { ATTENTION_NOTIFICATION_SNAPSHOT_LIMIT, USAGE_CLOUD_UPLOAD_MIN_INTERVAL_MS, USAGE_CLOUD_UPLOAD_ANCHOR_COUNT, USAGE_LOCAL_RETAIN_AGE_MS, USAGE_LOCAL_RETAIN_BYTES, USAGE_LOCAL_RETAIN_SUCCESS_COUNT, PROVIDER_USAGE_COMPONENT_RETAIN_BYTES, PROVIDER_USAGE_COMPONENT_RETAIN_COUNT, ProviderUsageTurnNotBoundError, StateStore } from "./state-store";
import { auditJoinedEvidenceGuards } from "./joined-evidence-guards";
import {
  admitRestartCommandInteraction,
  archivedRetired49,
  beginAuthorizedReset,
  bindClaudeTurnForUsageTest,
  canonical34StorageArchive,
  canonical35To38Archive,
  canonical38RuntimeArchive,
  canonical39DevinArchive,
  canonicalAuthBudgetArchive,
  canonicalAuthBudgetFrozenSchema,
  canonicalAuthBudgetPendingQuarantine,
  canonicalAuthBudgetRows,
  canonicalAuthBudgetSnapshot,
  canonicalBudgetArchive,
  canonicalIdentityAttentionArchive,
  canonicalResetPolicyArchive,
  capturedProviderAuthorityForTest,
  claudeAccountingForUsageTest,
  claudeQuotaForUsageTest,
  codexAdoptionRuntimeProfile,
  codexInteractionBinding,
  codexRuntimeProfile,
  completeCodexAccountMutationAuthorityRetirement,
  completeCodexRuntimeAccountAuthorityRetirement,
  corruptCanonical43Rows,
  createAuthorizedStartingTestSession,
  createProvenTestSession,
  createRevocationWorkStore,
  drainStateStoreCasesAndClose,
  expectCanonical35To38InertReopens,
  expectCanonical43ReadonlyRefusal,
  expectHistoricalValue,
  expectInertSchemaRefusal,
  fixture,
  namedProviderAccountKey,
  ownedStateStoreCase,
  ownedStateStoreCaseDrains,
  peerIdempotencyKey,
  prepareAuthorizedReset,
  privateUserPathRoot,
  providerAccountKeyForProfile,
  providerSwitchSchemaObjectCount,
  publicProviderIdentifier,
  recordUsageForTest,
  recordUsagePollFailureForTest,
  resetAccountFingerprint,
  retiredCloseHistory,
  retiredSuccessorArchive,
  seedProviderUsageForTest,
  signInProfile,
  snapshotSwitchContainmentForTest,
  startInputFixtureDaemon,
  stores,
  testDigest,
  upsertProvenTestSession,
  usageFingerprint,
  usageSnapshot,
  withCanonicalSessionKey,
  withRemovedTestGuards,
} from "../../scripts/fixtures/state-store-testkit";

setDefaultTimeout(60_000);

afterEach(async () => {
  await drainStateStoreCasesAndClose(ownedStateStoreCaseDrains, () => stores.splice(0));
});

describe("StateStore", () => {
test("rolls back send and queue receipts when their exact session revision CAS fails", async () => {
    const { store } = await fixture();
    const daemon = startInputFixtureDaemon(store);
    const profile = signInProfile(store, "Receipt CAS", "receipt-cas@example.com");
    const providerAuthority = store.requireProviderAccountAuthority(profile.id, "codex");
    const other = signInProfile(store, "Wrong receipt authority", "wrong-receipt@example.com");
    const conflictingAuthority = store.requireProviderAccountAuthority(other.id, "codex");
    const runtime = {
      profileId: profile.id,
      processGeneration: profile.processGeneration,
      observedAt: 2_000,
      preset: "high" as const,
      model: "gpt-6-astra",
      reasoningEffort: "max" as const,
      serviceTier: null,
      fast: false,
      approvalPolicy: "on-request" as const,
      reviewMode: "auto_review" as const,
      permissionProfile: ":workspace" as const,
      computerUse: true as const,
      pluginCapability: true as const,
      enabledApps: [],
    };

    const importedSendSession = upsertProvenTestSession(store, {
      profileId: profile.id,
      preset: "high",
      fastEnabled: false,
      providerThreadId: "thread-send-cas",
      state: "idle",
      providerUpdatedAt: 10,
    });
    const sendSession = store.updateSessionMetadata({
      sessionId: importedSendSession.id,
      expectedRevision: importedSendSession.revision,
      preset: "high",
    });
    const sendKey = "00000000-0000-4000-8000-000000000711";
    const { attempt: sendAttempt } = store.prepareSessionInputMutation({ kind: "session.send", sessionId: sendSession.id,
      ...daemon, providerAuthority, message: "send", attachments: [], idempotencyKey: sendKey });
    store.beginSessionMutationEffect({
      ...daemon,
      attachments: [],
      attemptId: sendAttempt.id,
      sessionId: sendSession.id,
      profileGeneration: profile.processGeneration,
      providerAuthority,
      message: "send",
      transcript: {
        accountId: profile.id,
        providerGeneration: profile.processGeneration,
        providerConnectionId: "10000000-0000-4000-8000-00000000000e",
        actor: "human",
        message: "send",
      },
      evidence: {
        kind: "session.send",
        providerThreadId: "thread-send-cas",
        baseline: { providerUpdatedAt: 10, status: "idle", activeTurnId: null },
        clientMessageId: sendAttempt.id,
        messageDigest: createHash("sha256").update("send").digest("hex"),
        runtimeProfile: runtime,
      },
    });
    expect(() => store.completeSessionTurnEffect({
      attemptId: sendAttempt.id,
      sessionId: sendSession.id,
      accountId: profile.id,
      providerGeneration: profile.processGeneration,
      providerConnectionId: null,
      message: "send",
      expectedSessionRevision: sendSession.revision,
      applyResponseState: true,
      providerAuthority: conflictingAuthority,
      turnId: "turn-send-cas",
      turnStatus: "inProgress",
      runtimeProfile: runtime,
      receipt: { turnId: "turn-send-cas" },
    })).toThrow("SESSION_TURN_PROVIDER_AUTHORITY_MISMATCH");
    expect(store.readMutation(sendKey)).toMatchObject({ state: "effect_started" });
    expect(store.latestSessionRuntimeProfile(sendSession.id)).toBeNull();
    store.updateSessionMetadata({ sessionId: sendSession.id, expectedRevision: sendSession.revision, note: "concurrent" });
    expect(() => store.completeSessionTurnEffect({
      attemptId: sendAttempt.id,
      sessionId: sendSession.id,
      accountId: profile.id,
      providerGeneration: profile.processGeneration,
      providerConnectionId: null,
      expectedSessionRevision: sendSession.revision,
      applyResponseState: true,
      providerAuthority,
      turnId: "turn-send-cas",
      turnStatus: "inProgress",
      runtimeProfile: runtime,
      message: "send",
      receipt: { turnId: "turn-send-cas" },
    })).toThrow("SESSION_TURN_STATE_CAS_CONFLICT");
    expect(store.readMutation(sendKey)).toMatchObject({ state: "effect_started" });
    expect(store.latestSessionRuntimeProfile(sendSession.id)).toBeNull();
    expect(store.requireSession(sendSession.id)).toMatchObject({ state: "idle", note: "concurrent" });

    const importedQueueSession = upsertProvenTestSession(store, {
      profileId: profile.id,
      preset: "high",
      fastEnabled: false,
      providerThreadId: "thread-queue-cas",
      state: "idle",
      providerUpdatedAt: 10,
    });
    const queueSession = store.updateSessionMetadata({
      sessionId: importedQueueSession.id,
      expectedRevision: importedQueueSession.revision,
      preset: "high",
    });
    const queue = store.enqueue(queueSession.id, "queued");
    const queueEvidence = store.beginQueueEffect({
      queueId: queue.id,
      sessionId: queueSession.id,
      profileGeneration: profile.processGeneration,
      providerAuthority,
      providerConnectionId: "10000000-0000-4000-8000-000000000008",
      evidence: {
        kind: "queue.dispatch",
        queueId: queue.id,
        sessionId: queueSession.id,
        providerThreadId: "thread-queue-cas",
        profileGeneration: profile.processGeneration,
        baseline: { providerUpdatedAt: 10, status: "idle", activeTurnId: null },
        clientMessageId: queue.id,
        messageDigest: new Bun.CryptoHasher("sha256").update("queued").digest("hex"),
        runtimeProfile: runtime,
      },
    });
    expect(() => store.completeQueueEffect({
      queueId: queue.id,
      accountId: profile.id,
      providerGeneration: profile.processGeneration,
      providerConnectionId: null,
      message: "queued",
      expectedEvidenceDigest: queueEvidence.digest,
      expectedSessionRevision: queueSession.revision,
      applyResponseState: true,
      providerAuthority: conflictingAuthority,
      turnId: "turn-queue-cas",
      turnStatus: "inProgress",
      runtimeProfile: runtime,
      receipt: { turnId: "turn-queue-cas" },
    })).toThrow("QUEUE_PROVIDER_AUTHORITY_MISMATCH");
    expect(store.requireQueue(queue.id)).toMatchObject({ state: "dispatching" });
    expect(store.latestSessionRuntimeProfile(queueSession.id)).toBeNull();
    store.updateSessionMetadata({ sessionId: queueSession.id, expectedRevision: queueSession.revision, fastEnabled: true });
    expect(() => store.completeQueueEffect({
      queueId: queue.id,
      accountId: profile.id,
      providerGeneration: profile.processGeneration,
      providerConnectionId: null,
      expectedEvidenceDigest: queueEvidence.digest,
      expectedSessionRevision: queueSession.revision,
      applyResponseState: true,
      providerAuthority,
      turnId: "turn-queue-cas",
      turnStatus: "inProgress",
      runtimeProfile: runtime,
      message: "queued",
      receipt: { turnId: "turn-queue-cas" },
    })).toThrow("QUEUE_EFFECT_SESSION_CAS_CONFLICT");
    expect(store.requireQueue(queue.id)).toMatchObject({ state: "dispatching" });
    expect(store.latestSessionRuntimeProfile(queueSession.id)).toBeNull();
    expect(store.requireSession(queueSession.id)).toMatchObject({ state: "idle", fastEnabled: true });
  });
test("commits sanitized send, steer, and queue message events with their effect receipts", async () => {
    let currentTime = 1_000;
    const { store } = await fixture({ now: () => currentTime });
    const daemon = startInputFixtureDaemon(store);
    const profile = signInProfile(store, "Atomic message events", "atomic-events@example.com");
    const runtime = codexRuntimeProfile(profile);
    const bind = (
      thread: string,
      state: "active" | "idle",
      activeTurnId?: string,
    ) => {
      const created = createAuthorizedStartingTestSession(store, {
        profileId: profile.id,
        preset: "high",
        fastEnabled: false,
      });
      return store.bindSession({
        sessionId: created.id,
        expectedRevision: created.revision,
        providerThreadId: thread,
        state,
        ...(activeTurnId === undefined ? {} : { activeTurnId }),
      });
    };

    const sendSession = bind("thread-atomic-send", "idle");
    const sendMessage = [
      "", "Users", "private", "project",
      "x".repeat(SESSION_EVENT_USER_MESSAGE_MAX_CHARACTERS),
    ].join("/");
    const sendKey = peerIdempotencyKey(70_001);
    const { attempt: sendAttempt } = store.prepareSessionInputMutation({
      ...daemon, kind: "session.send", sessionId: sendSession.id,
      providerAuthority: capturedProviderAuthorityForTest(store, sendSession.id),
      message: sendMessage, attachments: [],
      idempotencyKey: sendKey,
    });
    store.beginSessionMutationEffect({
      ...daemon, attachments: [],
      providerAuthority: capturedProviderAuthorityForTest(store, sendSession.id),
      transcript: {
        accountId: store.requireSession(sendSession.id).profileId,
        providerGeneration: profile.processGeneration,
        providerConnectionId: "10000000-0000-4000-8000-000000000099",
        actor: store.sessionMessageActorForSource(sendSession.id, sendAttempt.id) ?? "human",
        message: sendMessage,
      },
      attemptId: sendAttempt.id,
      sessionId: sendSession.id,
      profileGeneration: profile.processGeneration,
      message: sendMessage,
      evidence: {
        kind: "session.send",
        providerThreadId: "thread-atomic-send",
        baseline: { providerUpdatedAt: null, status: "idle", activeTurnId: null },
        clientMessageId: sendAttempt.id,
        messageDigest: testDigest(sendMessage),
        runtimeProfile: runtime,
      },
    });
    expect(store.bumpAutorespondCounter(sendSession.id)).toBe(1);
    expect(store.bumpAutorespondCounter(sendSession.id)).toBe(2);
    expect(() => store.completeSessionTurnEffect({
      providerAuthority: capturedProviderAuthorityForTest(store, sendSession.id),
      attemptId: sendAttempt.id,
      sessionId: sendSession.id,
      accountId: profile.id,
      providerGeneration: profile.processGeneration,
      providerConnectionId: null,
      expectedSessionRevision: sendSession.revision,
      applyResponseState: false,
      turnId: "turn-atomic-send",
      turnStatus: "completed",
      runtimeProfile: runtime,
      message: `${sendMessage}changed`,
      receipt: { turnId: "turn-atomic-send" },
    })).toThrow("SESSION_MESSAGE_DIGEST_MISMATCH");
    expect(store.readMutation(sendKey)?.state).toBe("effect_started");
    expect(store.readSessionMessageEventSource(sendSession.id, sendAttempt.id)).toBeNull();
    expect(store.listSessionEvents({ sessionId: sendSession.id, afterSequence: 0 }).events)
      .toEqual([]);
    expect(store.latestSessionRuntimeProfile(sendSession.id)).toBeNull();
    expect(store.readAutorespondBudgets(sendSession.id).consecutive).toBe(2);

    const sent = store.completeSessionTurnEffect({
      providerAuthority: capturedProviderAuthorityForTest(store, sendSession.id),
      attemptId: sendAttempt.id,
      sessionId: sendSession.id,
      accountId: profile.id,
      providerGeneration: profile.processGeneration,
      providerConnectionId: null,
      expectedSessionRevision: sendSession.revision,
      applyResponseState: false,
      turnId: "turn-atomic-send",
      turnStatus: "completed",
      runtimeProfile: runtime,
      message: sendMessage,
      receipt: { turnId: "turn-atomic-send" },
    });
    expect(sent).toMatchObject({
      appended: true,
      event: {
        body: {
          type: "user_message",
          actor: "human",
          text: "[local-path]",
          omittedCharacters: sendMessage.length
            - SESSION_EVENT_USER_MESSAGE_MAX_CHARACTERS,
        },
      },
    });
    expect(store.readAutorespondBudgets(sendSession.id).consecutive).toBe(0);
    expect(store.bumpAutorespondCounter(sendSession.id)).toBe(1);
    expect(store.appendSessionUserMessageEventOnce({
      sourceId: sendAttempt.id,
      sessionId: sendSession.id,
      accountId: profile.id,
      providerGeneration: profile.processGeneration,
      providerConnectionId: null,
      turnId: "turn-atomic-send",
      message: sendMessage,
    })).toEqual({ ...sent, appended: false });
    expect(store.readAutorespondBudgets(sendSession.id).consecutive).toBe(1);
    expect(() => store.appendSessionUserMessageEventOnce({
      sourceId: sendAttempt.id,
      sessionId: sendSession.id,
      accountId: profile.id,
      providerGeneration: profile.processGeneration,
      providerConnectionId: null,
      turnId: "different-atomic-send-turn",
      message: sendMessage,
    })).toThrow("SESSION_MESSAGE_EVENT_SOURCE_CONFLICT");
    expect(store.listSessionEvents({ sessionId: sendSession.id, afterSequence: 0 }).events)
      .toEqual([sent.event]);
    expect(store.readAutorespondBudgets(sendSession.id).consecutive).toBe(1);

    const steerSession = bind("thread-atomic-steer", "active", "turn-atomic-steer");
    const steerMessage = "sk_testabcdefgh";
    const steerKey = peerIdempotencyKey(70_002);
    const { attempt: steerAttempt } = store.prepareSessionInputMutation({
      ...daemon, kind: "session.steer", sessionId: steerSession.id,
      providerAuthority: capturedProviderAuthorityForTest(store, steerSession.id),
      message: steerMessage, attachments: [],
      idempotencyKey: steerKey,
    });
    store.beginSessionMutationEffect({
      ...daemon, attachments: [],
      providerAuthority: capturedProviderAuthorityForTest(store, steerSession.id),
      transcript: {
        accountId: store.requireSession(steerSession.id).profileId,
        providerGeneration: profile.processGeneration,
        providerConnectionId: "10000000-0000-4000-8000-000000000099",
        actor: store.sessionMessageActorForSource(steerSession.id, steerAttempt.id) ?? "human",
        message: steerMessage,
      },
      attemptId: steerAttempt.id,
      sessionId: steerSession.id,
      profileGeneration: profile.processGeneration,
      message: steerMessage,
      evidence: {
        kind: "session.steer",
        providerThreadId: "thread-atomic-steer",
        baseline: {
          providerUpdatedAt: null,
          status: "active",
          activeTurnId: "turn-atomic-steer",
        },
        activeTurnId: "turn-atomic-steer",
        clientMessageId: steerAttempt.id,
        messageDigest: testDigest(steerMessage),
      },
    });
    expect(store.completeSessionSteerEffect({
      attemptId: steerAttempt.id,
      sessionId: steerSession.id,
      accountId: profile.id,
      providerGeneration: profile.processGeneration,
      providerAuthority: capturedProviderAuthorityForTest(store, steerSession.id),
      providerConnectionId: null,
      turnId: "turn-atomic-steer",
      message: steerMessage,
      receipt: { steered: true, activeTurnId: "turn-atomic-steer" },
    })).toMatchObject({
      appended: true,
      event: { body: { type: "user_message", actor: "human", text: "[protected]" } },
    });

    const queueSession = bind("thread-atomic-queue", "idle");
    const queueMessage = "line one\nright\u202Eleft\u0000done";
    const queue = store.enqueue(queueSession.id, queueMessage);
    const queueEvidence = store.beginQueueEffect({
      providerAuthority: capturedProviderAuthorityForTest(store, queueSession.id),
      queueId: queue.id,
      sessionId: queueSession.id,
      profileGeneration: profile.processGeneration,
      providerConnectionId: "10000000-0000-4000-8000-000000000099",
      evidence: {
        kind: "queue.dispatch",
        queueId: queue.id,
        sessionId: queueSession.id,
        providerThreadId: "thread-atomic-queue",
        profileGeneration: profile.processGeneration,
        baseline: { providerUpdatedAt: null, status: "idle", activeTurnId: null },
        clientMessageId: queue.id,
        messageDigest: testDigest(queueMessage),
        runtimeProfile: runtime,
      },
    });
    expect(store.completeQueueEffect({
      providerAuthority: capturedProviderAuthorityForTest(store, store.requireQueue(queue.id).sessionId),
      queueId: queue.id,
      accountId: profile.id,
      providerGeneration: profile.processGeneration,
      providerConnectionId: null,
      expectedEvidenceDigest: queueEvidence.digest,
      expectedSessionRevision: queueSession.revision,
      applyResponseState: false,
      turnId: "turn-atomic-queue",
      turnStatus: "completed",
      runtimeProfile: runtime,
      message: queueMessage,
      receipt: { turnId: "turn-atomic-queue" },
    })).toMatchObject({
      appended: true,
      event: {
        body: {
          type: "user_message",
          actor: "human",
          text: "line one\nright�left�done",
        },
      },
    });

    const cutoffSecrets = [
      ["aws", "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"],
      ["google", `AIza${"Sy".repeat(17)}A`],
      ["npm", `npm_${"Ab9".repeat(12)}`],
    ] as const;
    for (const [index, [name, secret]] of cutoffSecrets.entries()) {
      const cutoffMessage = `${" ".repeat(
        SESSION_EVENT_USER_MESSAGE_MAX_CHARACTERS - secret.length + 1,
      )}${secret} tail`;
      expect(cutoffMessage.slice(0, SESSION_EVENT_USER_MESSAGE_MAX_CHARACTERS))
        .toEndWith(secret.slice(0, -1));
      const cutoffSession = bind(`thread-atomic-cutoff-${name}`, "idle");
      const cutoffKey = peerIdempotencyKey(70_010 + index);
      const { attempt: cutoffAttempt } = store.prepareSessionInputMutation({
        ...daemon, kind: "session.send", sessionId: cutoffSession.id,
        providerAuthority: capturedProviderAuthorityForTest(store, cutoffSession.id),
        message: cutoffMessage, attachments: [],
        idempotencyKey: cutoffKey,
      });
      store.beginSessionMutationEffect({
      ...daemon, attachments: [],
        providerAuthority: capturedProviderAuthorityForTest(store, cutoffSession.id),
        transcript: {
          accountId: store.requireSession(cutoffSession.id).profileId,
          providerGeneration: profile.processGeneration,
          providerConnectionId: "10000000-0000-4000-8000-000000000099",
          actor: store.sessionMessageActorForSource(cutoffSession.id, cutoffAttempt.id) ?? "human",
          message: cutoffMessage,
        },
        attemptId: cutoffAttempt.id,
        sessionId: cutoffSession.id,
        profileGeneration: profile.processGeneration,
        message: cutoffMessage,
        evidence: {
          kind: "session.send",
          providerThreadId: `thread-atomic-cutoff-${name}`,
          baseline: { providerUpdatedAt: null, status: "idle", activeTurnId: null },
          clientMessageId: cutoffAttempt.id,
          messageDigest: testDigest(cutoffMessage),
          runtimeProfile: runtime,
        },
      });
      // Recovery consumes this durable intent without the original message.
      // Its pre-effect bytes must already protect a credential crossing the cap.
      const pendingCutoff = store.readSessionUserMessageSource(
        cutoffSession.id, "mutation", cutoffKey,
      );
      expect(pendingCutoff).toMatchObject({ status: "pending" });
      expect(pendingCutoff.intent).toMatchObject({
        text: expect.stringContaining("[protected]"),
      });
      expect(JSON.stringify(pendingCutoff)).not.toContain(secret.slice(0, -1));
      const cutoffResult = store.completeSessionTurnEffect({
        providerAuthority: capturedProviderAuthorityForTest(store, cutoffSession.id),
        attemptId: cutoffAttempt.id,
        sessionId: cutoffSession.id,
        accountId: profile.id,
        providerGeneration: profile.processGeneration,
        providerConnectionId: null,
        expectedSessionRevision: cutoffSession.revision,
        applyResponseState: false,
        turnId: `turn-atomic-cutoff-${name}`,
        turnStatus: "completed",
        runtimeProfile: runtime,
        message: cutoffMessage,
        receipt: { turnId: `turn-atomic-cutoff-${name}` },
      });
      if (cutoffResult.event.body.type !== "user_message") {
        throw new Error("Expected a cutoff user-message event.");
      }
      expect(cutoffResult.event.body.text).toContain("[protected]");
      expect(cutoffResult.event.body.text).not.toContain(secret.slice(0, -1));
      expect(cutoffResult.event.body.omittedCharacters).toBe(
        cutoffMessage.length - SESSION_EVENT_USER_MESSAGE_MAX_CHARACTERS,
      );
    }

    currentTime += SESSION_EVENT_RETAIN_AGE_MS + 1;
    expect(store.listSessionEvents({ sessionId: sendSession.id, afterSequence: 0 }).events)
      .toEqual([]);
    expect(store.readSessionMessageEventSource(sendSession.id, sendAttempt.id)).toBeNull();
    const replay = {
      sourceId: sendAttempt.id,
      sessionId: sendSession.id,
      accountId: profile.id,
      providerGeneration: profile.processGeneration,
      providerConnectionId: null,
      turnId: "turn-atomic-send",
      message: sendMessage,
    };
    expect(() => store.appendSessionUserMessageEventOnce(replay))
      .toThrow("SESSION_USER_MESSAGE_SOURCE_FINALIZED");
    expect(() => store.appendSessionUserMessageEventOnce({ ...replay, message: `${sendMessage}changed` }))
      .toThrow("SESSION_MESSAGE_DIGEST_MISMATCH");
    expect(store.finalizeSessionUserMessageSource({
      sessionId: sendSession.id,
      sourceKind: "mutation",
      sourceId: sendKey,
      turnId: "turn-atomic-send",
    })).toBeNull();
    expect(store.listSessionEvents({ sessionId: sendSession.id, afterSequence: 0 }).events)
      .toEqual([]);
    expect(store.readAutorespondBudgets(sendSession.id).consecutive).toBe(1);
  });
test("reports whether any session is mid-turn as a cloud cadence hint", async () => {
    const { store } = await fixture();
    const profile = signInProfile(store, "Cadence authority", "cadence@example.com");
    expect(store.hasSessionWithActiveTurn()).toBe(false);
    const bound = upsertProvenTestSession(store, {
      profileId: profile.id,
      preset: "high",
      fastEnabled: false,
      providerThreadId: "thread-cadence",
      state: "active",
      activeTurnId: "turn-cadence",
    });
    expect(store.hasSessionWithActiveTurn()).toBe(true);
    store.reconcileSessionFromProvider({
      sessionId: bound.id,
      state: "idle",
      activeTurnId: null,
    });
    expect(store.hasSessionWithActiveTurn()).toBe(false);
  });
test("appends ordered bounded session events and reads an atomic snapshot cursor", async () => {
    const { store } = await fixture();
    const profile = signInProfile(store, "Event authority", "events@example.com");
    const session = upsertProvenTestSession(store, {
      profileId: profile.id,
      preset: "high",
      fastEnabled: false,
      providerThreadId: "thread-events",
      state: "active",
      activeTurnId: "turn-events",
    });
    const connectionId = "10000000-0000-4000-8000-000000000001";
    const providerAuthority = store.requireProviderAccountAuthority(profile.id, "codex");
    const first = store.appendSessionEvent({
      sessionId: session.id,
      accountId: profile.id,
      providerGeneration: profile.processGeneration,
      providerAuthority,
      providerConnectionId: connectionId,
      body: { type: "turn_started", turnId: "turn-events" },
    });
    const second = store.appendSessionEvent({
      sessionId: session.id,
      accountId: profile.id,
      providerGeneration: profile.processGeneration,
      providerAuthority,
      providerConnectionId: connectionId,
      body: {
        type: "assistant_delta",
        turnId: "turn-events",
        itemId: "item-events",
        text: "Visible progress",
      },
    });
    expect(first).toMatchObject({ sequence: 1, accountId: profile.id, providerGeneration: profile.processGeneration });
    expect(second).toMatchObject({ sequence: 2, streamEpoch: first.streamEpoch });
    expect(store.eventStreamPosition(session.id)).toEqual({
      streamEpoch: first.streamEpoch,
      floorSequence: 1,
      observedThroughSequence: 2,
    });
    expect(store.readSessionSnapshotWithEventPosition(session.id)).toMatchObject({
      session: { id: session.id, state: "active", activeTurnId: "turn-events" },
      streamEpoch: first.streamEpoch,
      floorSequence: 1,
      observedThroughSequence: 2,
    });
    expect(store.listSessionEvents({ sessionId: session.id, afterSequence: 0, limit: 1 })).toMatchObject({
      streamEpoch: first.streamEpoch,
      floorSequence: 1,
      observedThroughSequence: 2,
      gapReason: null,
      retentionGapReason: null,
      events: [{ sequence: 1 }],
    });
    expect(store.listSessionEvents({ sessionId: session.id, afterSequence: 1 })).toMatchObject({
      events: [{ sequence: 2, body: { type: "assistant_delta", text: "Visible progress" } }],
    });
    expect(() => store.listSessionEvents({ sessionId: session.id, afterSequence: 3 })).toThrow("SESSION_EVENT_CURSOR_AHEAD");
    expect(() => store.appendSessionEvent({
      sessionId: session.id,
      accountId: profile.id,
      providerGeneration: profile.processGeneration + 1,
      providerAuthority,
      providerConnectionId: connectionId,
      body: { type: "warning", code: "STALE", message: "must not append" },
    })).toThrow("SESSION_EVENT_AUTHORITY_CHANGED");
    expect(store.eventStreamPosition(session.id).observedThroughSequence).toBe(2);

    const inspector = new Database(store.paths.database, { create: false, strict: true });
    try {
      const stored = inspector.query(
        "SELECT event_bytes,length(CAST(event_json AS BLOB)) AS actual_bytes FROM session_events WHERE session_id=? ORDER BY sequence",
      ).all(session.id);
      expect(stored).toEqual([
        expect.objectContaining({ event_bytes: expect.any(Number), actual_bytes: expect.any(Number) }),
        expect.objectContaining({ event_bytes: expect.any(Number), actual_bytes: expect.any(Number) }),
      ]);
      for (const row of stored as Array<{ event_bytes: number; actual_bytes: number }>) {
        expect(row.event_bytes).toBe(row.actual_bytes);
      }
      expect(() => inspector.query(
        "UPDATE session_events SET event_json='{}' WHERE session_id=? AND sequence=1",
      ).run(session.id)).toThrow("session event is immutable");
    } finally {
      inspector.close(false);
    }
  });
test("projects legacy private identifiers and MCP summaries on every public read", async () => {
    const { store } = await fixture();
    const profile = signInProfile(store, "Legacy public projection", "legacy-projection@example.com");
    const session = upsertProvenTestSession(store, {
      profileId: profile.id,
      title: "Legacy public projection",
      preset: "high",
      fastEnabled: false,
      providerThreadId: "thread-legacy-public-projection",
      state: "active",
      activeTurnId: `${privateUserPathRoot}/api_key=LEGACY-TURN-SECRET-1234`,
    });
    const rawTurnId = `${privateUserPathRoot}/api_key=LEGACY-TURN-SECRET-1234`;
    const connectionId = "10000000-0000-4000-8000-000000000099";
    const providerAuthority = store.requireProviderAccountAuthority(profile.id, "codex");
    const interaction = store.admitInteraction({
      publicId: "10000000-0000-4000-8000-000000000098",
      sessionId: session.id,
      authority: {
        ...codexInteractionBinding(store, profile.id),
        profileId: profile.id,
        processGeneration: profile.processGeneration,
        connectionId,
        requestId: { type: "string", value: "legacy-mcp" },
        method: "mcpServer/elicitation/request",
        requestDigest: "a".repeat(64),
        threadId: "thread-legacy-public-projection",
        turnId: rawTurnId,
        itemId: null,
        approvalId: null,
      },
      kind: "mcp_elicitation",
      blocking: true,
      display: {
        kind: "mcp_elicitation",
        summary: "credential=LEGACY-MCP-SECRET-9415",
        serverName: "example",
        mode: "form",
        url: null,
        mayContainSecrets: true,
        fields: [],
      },
    }).record;
    const turnEvent = store.appendSessionEvent({
      sessionId: session.id,
      accountId: profile.id,
      providerGeneration: profile.processGeneration,
      providerAuthority,
      providerConnectionId: connectionId,
      body: { type: "turn_started", turnId: "turn-safe-before-upgrade" },
    });
    const interactionEvent = store.appendSessionEvent({
      sessionId: session.id,
      accountId: profile.id,
      providerGeneration: profile.processGeneration,
      providerAuthority,
      providerConnectionId: connectionId,
      body: {
        type: "interaction_requested",
        interactionId: interaction.publicId,
        interactionKind: "mcp_elicitation",
        revision: interaction.revision,
        blocking: true,
        summary: "Codex requests MCP form input",
      },
    });

    const inspector = new Database(store.paths.database, { create: false, strict: true });
    try {
      inspector.exec("DROP TRIGGER session_events_immutable_update");
      const replaceBody = (sequence: number, body: unknown): void => {
        const row = z.object({ event_json: z.string() }).strict().parse(
          inspector.query("SELECT event_json FROM session_events WHERE session_id=? AND sequence=?")
            .get(session.id, sequence),
        );
        const event = z.object({ body: z.unknown() }).passthrough()
          .parse(JSON.parse(row.event_json) as unknown);
        const eventJson = JSON.stringify({ ...event, body });
        inspector.query(
          "UPDATE session_events SET event_json=?,event_bytes=length(CAST(? AS BLOB)),projection_version=1 WHERE session_id=? AND sequence=?",
        ).run(eventJson, eventJson, session.id, sequence);
      };
      replaceBody(turnEvent.sequence, { type: "turn_started", turnId: rawTurnId });
      replaceBody(interactionEvent.sequence, {
        type: "interaction_requested",
        interactionId: interaction.publicId,
        interactionKind: "mcp_elicitation",
        revision: interaction.revision,
        blocking: true,
        summary: "credential=LEGACY-EVENT-SECRET-9415",
      });
    } finally {
      inspector.exec(`CREATE TRIGGER session_events_immutable_update
        BEFORE UPDATE ON session_events
        BEGIN SELECT RAISE(ABORT, 'session event is immutable'); END`);
      inspector.close(false);
    }

    const snapshot = store.readSessionObservationSnapshot(session.id);
    expect(snapshot.session.activeTurnId).toBe(
      store.projectPublicProviderIdentifier(rawTurnId),
    );
    expect(snapshot.interactions.pending.some((candidate) =>
      candidate.id === interaction.publicId
      && candidate.summary === "Codex requests MCP form input"
    )).toBe(true);
    expect(store.requireInteraction(interaction.publicId).display.summary)
      .toBe("Codex requests MCP form input");
    const publicEvents = store.listSessionEvents({
      sessionId: session.id,
      afterSequence: 0,
    }).events;
    expect(publicEvents.find((candidate) => candidate.sequence === turnEvent.sequence))
      .toMatchObject({
      sequence: turnEvent.sequence,
      body: {
        type: "turn_started",
        turnId: store.projectPublicProviderIdentifier(rawTurnId),
      },
    });
    expect(publicEvents.find((candidate) => candidate.sequence === interactionEvent.sequence))
      .toMatchObject({
      sequence: interactionEvent.sequence,
      body: {
        type: "interaction_requested",
        summary: "Codex requests MCP form input",
      },
    });
    expect(JSON.stringify({ snapshot, publicEvents })).not.toContain("LEGACY-");
  });
test("projects newly unsafe attachment scalars from immutable v1 and v2 event history", async () => {
    const { store } = await fixture();
    const profile = signInProfile(store, "Legacy attachment events", "legacy-attachment-events@example.com");
    const session = createProvenTestSession(store, {
      fastEnabled: false,
      preset: "high",
      profileId: profile.id,
      state: "idle",
    });
    const append = (digest: string) => store.appendSessionEvent({
      providerAuthority: capturedProviderAuthorityForTest(store, session.id),
      accountId: profile.id,
      body: {
        actor: "human" as const,
        attachments: ["same€name.txt", "same₹name.txt", "same�name.txt"].map((name) => ({
          byteLength: 4,
          digest,
          mediaType: "text/plain" as const,
          name,
        })),
        omittedCharacters: 0,
        text: "historical attachment",
        turnId: null,
        type: "user_message" as const,
      },
      providerConnectionId: null,
      providerGeneration: profile.processGeneration,
      sessionId: session.id,
    });
    const v1 = append("a".repeat(64));
    const v2 = append("b".repeat(64));
    const inspector = new Database(store.paths.database, { create: false, strict: true });
    try {
      inspector.exec("DROP TRIGGER session_events_immutable_update");
      for (const [event, projectionVersion] of [[v1, 1], [v2, 2]] as const) {
        const stored = z.object({
          event_bytes: z.number().int(),
          event_json: z.string(),
        }).strict().parse(inspector.query(
          `SELECT event_json,event_bytes FROM session_events
           WHERE session_id=? AND sequence=?`,
        ).get(session.id, event.sequence));
        const legacyJson = stored.event_json
          .replace("€", String.fromCodePoint(0x2028))
          .replace("₹", String.fromCodePoint(0x2029));
        expect(utf8Bytes(legacyJson)).toBe(stored.event_bytes);
        inspector.query(
          `UPDATE session_events SET event_json=?,projection_version=?
           WHERE session_id=? AND sequence=?`,
        ).run(legacyJson, projectionVersion, session.id, event.sequence);
      }
    } finally {
      inspector.exec(`CREATE TRIGGER session_events_immutable_update
        BEFORE UPDATE ON session_events
        BEGIN SELECT RAISE(ABORT, 'session event is immutable'); END`);
      inspector.close(false);
    }

    const projected = store.listSessionEvents({
      afterSequence: 0,
      sessionId: session.id,
    }).events;
    expect(projected.map((event) =>
      event.body.type === "user_message"
        ? event.body.attachments?.map(({ name }) => name)
        : null))
      .toEqual([
        ["same�name~1.txt", "same�name~2.txt", "same�name.txt"],
        ["same�name~1.txt", "same�name~2.txt", "same�name.txt"],
      ]);
    expect(JSON.stringify(projected)).not.toContain(String.fromCodePoint(0x2028));
  });
test("stores an exact 64 KiB public event and reads a maximally expanded legacy row", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "oompa-store-event-bound-")));
    const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
    await initializeStatePaths(paths);
    const now = 1_700_000_000_000;
    const store = new StateStore(paths, {
      now: () => now,
      publicProviderIdentifierProjector: publicProviderIdentifier,
    });
    stores.push(store);
    const profile = signInProfile(store, "Event byte bound", "event-bound@example.com");
    const session = store.createSession({
      profileId: profile.id,
      title: "Event byte bound",
      preset: "high",
      fastEnabled: false,
    });
    const stream = store.eventStreamPosition(session.id);
    const turnId = publicProviderIdentifier("t");
    const itemId = publicProviderIdentifier("i");
    const sizedText = (base: unknown, targetBytes: number): string => {
      const baseBytes = utf8Bytes(JSON.stringify(base));
      const remaining = targetBytes - baseBytes;
      if (remaining < 0) throw new Error("Event envelope exceeds its target size.");
      return `${"界".repeat(Math.floor(remaining / 3))}${"x".repeat(remaining % 3)}`;
    };
    const publicBase = {
      version: 1 as const,
      sessionId: session.id,
      streamEpoch: stream.streamEpoch,
      sequence: 1,
      recordedAt: now,
      accountId: profile.id,
      providerGeneration: profile.processGeneration,
      providerConnectionId: null,
      body: { type: "assistant_delta" as const, turnId, itemId, text: "" },
    };
    const publicText = sizedText(publicBase, SESSION_EVENT_MAX_BYTES);
    const appended = store.appendPublicSessionEvent({
      sessionId: session.id,
      accountId: profile.id,
      providerGeneration: profile.processGeneration,
      providerAuthority: store.requireProviderAccountAuthority(profile.id, "codex"),
      providerConnectionId: null,
      body: { ...publicBase.body, text: publicText },
    });
    expect(utf8Bytes(JSON.stringify(appended))).toBe(SESSION_EVENT_MAX_BYTES);

    const inspector = new Database(store.paths.database, { create: false, strict: true });
    try {
      const stored = z.object({
        event_bytes: z.number().int(),
        projection_version: z.number().int(),
      }).strict().parse(inspector.query(
        "SELECT event_bytes,projection_version FROM session_events WHERE session_id=? AND sequence=1",
      ).get(session.id));
      expect(stored).toEqual({
        event_bytes: SESSION_EVENT_MAX_BYTES,
        projection_version: 2,
      });
      const legacyBase = {
        ...publicBase,
        body: { ...publicBase.body, turnId: "t", itemId: "i", text: "" },
      };
      const legacyEvent = {
        ...legacyBase,
        body: {
          ...legacyBase.body,
          text: sizedText(legacyBase, SESSION_EVENT_MAX_BYTES),
        },
      };
      expect(utf8Bytes(JSON.stringify(legacyEvent))).toBe(SESSION_EVENT_MAX_BYTES);
      inspector.exec("DROP TRIGGER session_events_immutable_update");
      inspector.query(
        "UPDATE session_events SET event_json=?,event_bytes=?,projection_version=1 WHERE session_id=? AND sequence=1",
      ).run(JSON.stringify(legacyEvent), SESSION_EVENT_MAX_BYTES, session.id);
    } finally {
      inspector.exec(`CREATE TRIGGER session_events_immutable_update
        BEFORE UPDATE ON session_events
        BEGIN SELECT RAISE(ABORT, 'session event is immutable'); END`);
      inspector.close(false);
    }

    const projected = store.listSessionEvents({
      sessionId: session.id,
      afterSequence: 0,
    }).events[0];
    if (projected === undefined) throw new Error("Expected the projected legacy event.");
    expect(projected.body).toMatchObject({
      type: "assistant_delta",
      turnId,
      itemId,
    });
    expect(utf8Bytes(JSON.stringify(projected))).toBe(SESSION_EVENT_PUBLIC_MAX_BYTES);
  });
test("reads one bounded local session observation with exact interaction and queue semantics", async () => {
    const { store } = await fixture();
    const profile = signInProfile(store, "Observation account", "observation@example.com");
    const session = upsertProvenTestSession(store, {
      profileId: profile.id,
      title: `Observed api_key=TITLE-SECRET-1234 ${privateUserPathRoot}/work`,
      preset: "high",
      fastEnabled: false,
      providerThreadId: "thread-observation",
      state: "idle",
    });
    const connectionId = "10100000-0000-4000-8000-000000000001";
    const admit = (input: Readonly<{
      id: string;
      request: string;
      requestedAt: number;
      deadlineAt: number;
      summary: string;
    }>) => store.admitInteraction({
      publicId: input.id,
      sessionId: session.id,
      authority: {
        ...codexInteractionBinding(store, profile.id),
        profileId: profile.id,
        processGeneration: profile.processGeneration,
        connectionId,
        requestId: { type: "string", value: input.request },
        method: "item/commandExecution/requestApproval",
        requestDigest: new Bun.CryptoHasher("sha256").update(input.request).digest("hex"),
        threadId: "thread-observation",
        turnId: "turn-observation",
        itemId: input.request,
        approvalId: null,
      },
      kind: "command_approval",
      blocking: true,
      display: {
        kind: "command_approval",
        summary: input.summary,
        reason: null,
        commandClass: "test",
        workingDirectory: null,
        availableDecisions: ["once", "decline", "cancel"],
      },
      requestedAt: input.requestedAt,
      deadlineAt: input.deadlineAt,
    }).record;
    const later = admit({
      id: "10100000-0000-4000-8000-000000000002",
      request: "later",
      requestedAt: 200,
      deadlineAt: 900,
      summary: `api_key=SUMMARY-SECRET-1234 ${privateUserPathRoot}/summary`,
    });
    const urgent = admit({
      id: "10100000-0000-4000-8000-000000000003",
      request: "urgent",
      requestedAt: 100,
      deadlineAt: 800,
      summary: "u".repeat(700),
    });
    const prepared = admit({
      id: "10100000-0000-4000-8000-000000000004",
      request: "prepared",
      requestedAt: 300,
      deadlineAt: 950,
      summary: "prepared response",
    });
    store.prepareInteractionResponse({
      id: prepared.publicId,
      expectedRevision: prepared.revision,
      responseDigest: "a".repeat(64),
    });

    const pendingQueue = store.enqueue(session.id, "pending secret");
    const dispatchingQueue = store.enqueue(session.id, "dispatching secret");
    expect(store.transitionQueue(dispatchingQueue.id, "pending", "dispatching")).toBe(true);
    const ambiguousQueue = store.enqueue(session.id, "ambiguous secret");
    expect(store.transitionQueue(ambiguousQueue.id, "pending", "dispatching")).toBe(true);
    expect(store.transitionQueue(ambiguousQueue.id, "dispatching", "ambiguous")).toBe(true);
    const failedQueue = store.enqueue(session.id, "failed secret");
    expect(store.transitionQueue(failedQueue.id, "pending", "dispatching")).toBe(true);
    expect(store.transitionQueue(failedQueue.id, "dispatching", "failed")).toBe(true);
    const event = store.appendSessionEvent({
      sessionId: session.id,
      accountId: profile.id,
      providerGeneration: profile.processGeneration,
      providerAuthority: store.requireProviderAccountAuthority(profile.id, "codex"),
      providerConnectionId: connectionId,
      body: { type: "session_status", status: "idle", activeTurnId: null },
    });

    const snapshot = store.readSessionObservationSnapshot(session.id, 1);
    expect(sessionLocalObservationSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(snapshot).toMatchObject({
      session: {
        id: session.id,
        accountId: profile.id,
        projectId: null,
        title: "Observed [protected] [local-path]",
        execution: "idle",
        activeTurnId: null,
        revision: session.revision,
      },
      eventStream: {
        streamEpoch: event.streamEpoch,
        floorSequence: 1,
        observedThroughSequence: 1,
      },
      interactions: {
        pendingCount: 2,
        responseInFlightCount: 1,
        truncated: true,
        pending: [{ id: urgent.publicId, summary: "u".repeat(512) }],
      },
      queue: {
        depth: 1,
        dispatchingCount: 1,
        ambiguousCount: 1,
        failedCount: 1,
      },
    });
    expect(snapshot.interactions.pending.some((item) => item.id === prepared.publicId)).toBe(false);
    const completeSnapshot = store.readSessionObservationSnapshot(session.id);
    const encodedCompleteSnapshot = JSON.stringify(completeSnapshot);
    expect(encodedCompleteSnapshot).not.toContain("TITLE-SECRET-1234");
    expect(encodedCompleteSnapshot).not.toContain("SUMMARY-SECRET-1234");
    expect(encodedCompleteSnapshot).not.toContain(privateUserPathRoot);
    expect(completeSnapshot.interactions.pending.some((candidate) =>
      candidate.id === later.publicId
      && candidate.summary === "[protected] [local-path]"
    )).toBe(true);
    expect(store.requireQueue(pendingQueue.id).state).toBe("pending");
    expect(later.state).toBe("pending");
    expect(snapshot.observedAt).toBeGreaterThanOrEqual(session.updatedAt);
    expect(() => store.readSessionObservationSnapshot(session.id, 0)).toThrow();
    expect(() => store.readSessionObservationSnapshot(session.id, 11)).toThrow();

    const expansion = store.createSession({
      profileId: profile.id,
      title: "/a ".repeat(106).trim(),
      preset: "high",
      fastEnabled: false,
    });
    const expandedSnapshot = store.readSessionObservationSnapshot(expansion.id);
    expect(utf8Bytes(expandedSnapshot.session.title)).toBeLessThanOrEqual(320);
    expect(expandedSnapshot.session.title).toEndWith("[truncated]");
    expect(expandedSnapshot.session.title).not.toContain("/a");

    const privateTurnId = `${privateUserPathRoot}/api_key=TURN-SECRET-1234`;
    const privateTurnSession = upsertProvenTestSession(store, {
      profileId: profile.id,
      title: "Private provider identifier",
      preset: "high",
      fastEnabled: false,
      providerThreadId: "thread-private-provider-id",
      state: "active",
      activeTurnId: privateTurnId,
    });
    const privateTurnSnapshot = store.readSessionObservationSnapshot(privateTurnSession.id);
    expect(privateTurnSnapshot.session.activeTurnId)
      .toBe(store.projectPublicProviderIdentifier(privateTurnId));
    expect(privateTurnSnapshot.session.activeTurnId)
      .toMatch(/^opaque_v2_[a-f0-9]{64}$/u);
    expect(JSON.stringify(privateTurnSnapshot)).not.toContain("TURN-SECRET-1234");
    expect(store.requireSession(privateTurnSession.id).activeTurnId).toBe(privateTurnId);

    const longTurnId = "l".repeat(201);
    const longTurnSession = upsertProvenTestSession(store, {
      profileId: profile.id,
      title: "Long provider identifier",
      preset: "high",
      fastEnabled: false,
      providerThreadId: "thread-long-provider-id",
      state: "active",
      activeTurnId: longTurnId,
    });
    expect(store.readSessionObservationSnapshot(longTurnSession.id).session.activeTurnId)
      .toBe(store.projectPublicProviderIdentifier(longTurnId));
    expect(store.requireSession(longTurnSession.id).activeTurnId).toBe(longTurnId);
  });
test("establishes each SQLite observation cut before assigning its observed time", async () => {
    const { store } = await fixture();
    const profile = store.createProfile("Snapshot boundary");
    const session = store.createSession({
      profileId: profile.id,
      title: "Snapshot boundary",
      preset: "high",
      fastEnabled: false,
    });
    let sessionWriterRan = false;
    const sessionObserver = new StateStore(store.paths, {
      readonly: true,
      now: () => {
        if (sessionWriterRan) throw new Error("Session observation clock was read more than once.");
        sessionWriterRan = true;
        store.setSessionTurnState({
          sessionId: session.id,
          expectedRevision: session.revision,
          state: "idle",
        });
        return 10_000;
      },
    });
    stores.push(sessionObserver);

    const sessionSnapshot = sessionObserver.readSessionObservationSnapshot(session.id);
    expect(sessionWriterRan).toBe(true);
    expect(sessionSnapshot.observedAt).toBe(10_000);
    expect(sessionSnapshot.session).toMatchObject({
      execution: "starting",
      revision: session.revision,
    });
    expect(store.requireSession(session.id)).toMatchObject({
      state: "idle",
      revision: session.revision + 1,
    });

    const accountCountBeforeRootCut = store.listProfiles().length;
    let rootWriterRan = false;
    const rootObserver = new StateStore(store.paths, {
      readonly: true,
      now: () => {
        if (rootWriterRan) throw new Error("Root observation clock was read more than once.");
        rootWriterRan = true;
        store.createProfile("Committed after root cut");
        return 20_000;
      },
    });
    stores.push(rootObserver);

    const rootSnapshot = rootObserver.readRootStatusSnapshot();
    expect(rootWriterRan).toBe(true);
    expect(rootSnapshot.localObservation.observedAt).toBe(20_000);
    expect(
      rootSnapshot.counts.accounts.signedOut
      + rootSnapshot.counts.accounts.loginPending
      + rootSnapshot.counts.accounts.signedIn
      + rootSnapshot.counts.accounts.recoveryRequired,
    ).toBe(accountCountBeforeRootCut);
    expect(store.listProfiles()).toHaveLength(accountCountBeforeRootCut + 1);
  });
test("reads latest nonremoved account usage outcomes without leaking private root data", async () => {
    const { store } = await fixture();
    const observed = signInProfile(store, "Observed private label", "observed-private@example.com");
    const failed = signInProfile(store, "Failed private label", "failed-private@example.com");
    const missing = store.createProfile("Missing private label");
    const removed = signInProfile(store, "Removed private label", "removed-private@example.com");
    recordUsageForTest(store, observed.id, 1, 100, { sentinel: "old-observed-payload" });
    recordUsagePollFailureForTest(store,
      observed.id,
      resetAccountFingerprint("observed-private@example.com"),
      2,
      200,
    );
    recordUsageForTest(store, observed.id, 3, 300, { sentinel: "latest-observed-payload" });
    recordUsageForTest(store, failed.id, 1, 100, { sentinel: "old-failed-payload" });
    recordUsagePollFailureForTest(store,
      failed.id,
      resetAccountFingerprint("failed-private@example.com"),
      2,
      200,
    );
    recordUsageForTest(store, removed.id, 1, 100, { sentinel: "removed-account-payload" });
    store.removeProfile(removed.id);

    const session = upsertProvenTestSession(store, {
      profileId: observed.id,
      title: "private session title",
      preset: "high",
      fastEnabled: false,
      providerThreadId: "private-thread", state: "idle",
    });
    store.updateSessionMetadata({
      sessionId: session.id,
      expectedRevision: session.revision,
      note: "private session note",
    });
    store.admitInteraction({
      publicId: "10200000-0000-4000-8000-000000000001",
      sessionId: session.id,
      authority: {
        ...codexInteractionBinding(store, observed.id),
        profileId: observed.id,
        processGeneration: observed.processGeneration,
        connectionId: "10200000-0000-4000-8000-000000000002",
        requestId: { type: "string", value: "private-interaction" },
        method: "item/commandExecution/requestApproval",
        requestDigest: "b".repeat(64),
        threadId: "private-thread",
        turnId: "private-turn",
        itemId: "private-item",
        approvalId: null,
      },
      kind: "command_approval",
      blocking: true,
      display: {
        kind: "command_approval",
        summary: "private interaction summary",
        reason: "private interaction reason",
        commandClass: "private command class",
        workingDirectory: "/private/root",
        availableDecisions: ["once", "decline"],
      },
    });
    store.enqueue(session.id, "private queued message");

    const status = store.readRootStatusSnapshot();
    expect(status.counts).toMatchObject({
      accounts: { signedOut: 1, loginPending: 0, signedIn: 2, recoveryRequired: 0 },
      sessions: { idle: 1 },
      interactions: { pending: 1 },
      queue: { pending: 1 },
      usage: { observed: 1, failed: 1, missing: 1 },
    });
    expect(status.attention).toMatchObject({
      total: 1,
      truncated: false,
      records: [{
        kind: "interaction_pending",
        accountId: observed.id,
        sessionId: session.id,
      }],
    });
    expect(status.providerObservation.coverage).toBe("not_attempted");
    expect(status.cloudObservation.devices).toEqual({ registered: null, online: null });
    const encoded = JSON.stringify(status);
    for (const forbidden of [
      z.string().parse(observed.providerEmail),
      z.string().parse(failed.providerEmail),
      z.string().parse(removed.providerEmail),
      "Observed private label",
      "Failed private label",
      "Missing private label",
      "Removed private label",
      "private session title",
      "private session note",
      "private interaction summary",
      "private interaction reason",
      "private command class",
      "/private/root",
      "private queued message",
      "old-observed-payload",
      "latest-observed-payload",
      "old-failed-payload",
      "removed-account-payload",
    ]) {
      expect(encoded).not.toContain(forbidden);
    }
    expect(status.attention.records[0]?.intent).toEqual({
      kind: "inspect_interaction",
      interactionId: "10200000-0000-4000-8000-000000000001",
      expectedRevision: 1,
    });
    expect(missing.state).toBe("signed_out");
    expect(new TextEncoder().encode(encoded).byteLength).toBeLessThanOrEqual(ROOT_STATUS_MAXIMUM_BYTES);
  });
test("emits executable root attention intents for every interaction kind and in-flight state", async () => {
    const { store } = await fixture();
    const profile = signInProfile(store, "Actionable attention", "attention@example.com");
    const session = upsertProvenTestSession(store, {
      profileId: profile.id,
      title: "Actionable attention",
      preset: "high",
      fastEnabled: false,
      providerThreadId: "thread-actionable-attention", state: "idle",
    });
    const cases = [
      {
        kind: "command_approval",
        method: "item/commandExecution/requestApproval",
        display: {
          kind: "command_approval",
          summary: "Approve command",
          reason: null,
          commandClass: "test",
          workingDirectory: null,
          availableDecisions: ["once", "decline", "cancel"],
        },
      },
      {
        kind: "file_change_approval",
        method: "item/fileChange/requestApproval",
        display: {
          kind: "file_change_approval",
          summary: "Approve files",
          reason: null,
          grantRoot: null,
          availableDecisions: ["once", "decline", "cancel"],
        },
      },
      {
        kind: "permission_approval",
        method: "item/permissions/requestApproval",
        display: {
          kind: "permission_approval",
          summary: "Approve permission",
          reason: null,
          requested: [{ name: "network" }],
          allowsSessionScope: true,
        },
      },
      {
        kind: "user_input",
        method: "item/tool/requestUserInput",
        display: {
          kind: "user_input",
          summary: "Answer question",
          blocking: true,
          questions: [{
            id: "answer",
            header: "Answer",
            question: "Continue?",
            options: null,
            allowsOther: true,
            secret: false,
          }],
        },
      },
      {
        kind: "mcp_elicitation",
        method: "mcpServer/elicitation/request",
        display: {
          kind: "mcp_elicitation",
          summary: "Codex requests MCP form input",
          serverName: "example",
          mode: "form",
          url: null,
          mayContainSecrets: true,
          fields: [],
        },
      },
    ] satisfies readonly Readonly<{
      kind: InteractionKind;
      method: string;
      display: InteractionDisplay;
    }>[];
    const admit = (candidate: (typeof cases)[number], index: number) =>
      store.admitInteraction({
        publicId: `10300000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
        sessionId: session.id,
        authority: {
          ...codexInteractionBinding(store, profile.id),
          profileId: profile.id,
          processGeneration: profile.processGeneration,
          connectionId: "10300000-0000-4000-8000-000000000099",
          requestId: { type: "string", value: `attention-${String(index)}` },
          method: candidate.method,
          requestDigest: index.toString(16).padStart(64, "0"),
          threadId: "thread-actionable-attention",
          turnId: "turn-actionable-attention",
          itemId: `item-${String(index)}`,
          approvalId: null,
        },
        kind: candidate.kind,
        blocking: true,
        display: candidate.display,
      }).record;
    const pending = cases.map((candidate, index) => admit(candidate, index + 1));
    const preparedSeed = admit(cases[0]!, 6);
    const prepared = store.prepareInteractionResponse({
      id: preparedSeed.publicId,
      expectedRevision: preparedSeed.revision,
      responseDigest: "b".repeat(64),
    });
    const writtenSeed = admit(cases[0]!, 7);
    const writtenPrepared = store.prepareInteractionResponse({
      id: writtenSeed.publicId,
      expectedRevision: writtenSeed.revision,
      responseDigest: "c".repeat(64),
    });
    const written = store.markInteractionResponseWritten({
      id: writtenPrepared.publicId,
      expectedRevision: writtenPrepared.revision,
      responseDigest: "c".repeat(64),
    });

    const status = store.readRootStatusSnapshot();
    expect(status.attention.total).toBe(7);
    const byId = new Map(status.attention.records.flatMap((record) =>
      "interactionId" in record ? [[record.interactionId, record] as const] : []));
    for (const record of pending) {
      const attention = byId.get(record.publicId);
      if (record.kind === "command_approval" || record.kind === "permission_approval") {
        expect(attention?.intent).toEqual({
          kind: "inspect_interaction",
          interactionId: record.publicId,
          expectedRevision: record.revision,
        });
      } else {
        expect(attention?.intent).toEqual({
          kind: "show_interaction",
          interactionId: record.publicId,
        });
      }
    }
    for (const record of [prepared, written]) {
      expect(byId.get(record.publicId)?.intent).toEqual({
        kind: "show_interaction",
        interactionId: record.publicId,
      });
    }
  });
test("caps deterministic root attention with truthful truncation under the byte bound", async () => {
    const { store } = await fixture();
    const accountIds: string[] = [];
    for (let index = 0; index < ROOT_STATUS_ATTENTION_LIMIT + 5; index += 1) {
      const account = store.createProfile(`Recovery ${String(index).padStart(2, "0")}`);
      expect(store.setProfileState(
        account.id,
        account.processGeneration,
        "recovery_required",
      )).toBe(true);
      accountIds.push(account.id);
    }

    const status = store.readRootStatusSnapshot();
    expect(status.attention.records).toHaveLength(ROOT_STATUS_ATTENTION_LIMIT);
    expect(status.attention.total).toBe(ROOT_STATUS_ATTENTION_LIMIT + 5);
    expect(status.attention.truncated).toBe(true);
    expect(status.attention.records.map((record) => record.accountId))
      .toEqual(accountIds.slice(0, ROOT_STATUS_ATTENTION_LIMIT));
    expect(new TextEncoder().encode(JSON.stringify(status)).byteLength)
      .toBeLessThanOrEqual(ROOT_STATUS_MAXIMUM_BYTES);
    expect(() => store.readRootStatusSnapshot(0)).toThrow();
    expect(() => store.readRootStatusSnapshot(ROOT_STATUS_ATTENTION_LIMIT + 1)).toThrow();
  });
test("atomically retires one provider generation before an account login advances it", async () => {
    const { store } = await fixture();
    const profile = signInProfile(store, "Login retirement", "login-retirement@example.com");
    const session = upsertProvenTestSession(store, {
      profileId: profile.id,
      preset: "high",
      fastEnabled: false,
      providerThreadId: "thread-login-retirement",
      state: "idle",
    });
    const sessionProviderAuthority = store.requireProviderAccountAuthority(profile.id, "codex");
    const connectionId = "11000000-0000-4000-8000-000000000001";
    store.appendSessionEvent({
      sessionId: session.id,
      accountId: profile.id,
      providerGeneration: profile.processGeneration,
      providerAuthority: sessionProviderAuthority,
      providerConnectionId: connectionId,
      body: { type: "connection", state: "connected" },
    });
    const interaction = store.admitInteraction({
      publicId: "11000000-0000-4000-8000-000000000002",
      sessionId: session.id,
      authority: {
        ...codexInteractionBinding(store, profile.id),
        profileId: profile.id,
        processGeneration: profile.processGeneration,
        connectionId,
        requestId: { type: "string", value: "login-retirement" },
        method: "item/commandExecution/requestApproval",
        requestDigest: "1".repeat(64),
        threadId: "thread-login-retirement",
        turnId: "turn-login-retirement",
        itemId: "item-login-retirement",
        approvalId: null,
      },
      kind: "command_approval",
      blocking: true,
      display: {
        kind: "command_approval",
        summary: "Retire this prompt",
        reason: null,
        commandClass: "test",
        workingDirectory: null,
        availableDecisions: ["once", "decline", "cancel"],
      },
    }).record;
    const attempt = store.prepareMutation({
      kind: "account.login",
      authorityId: profile.id,
      authorityGeneration: profile.processGeneration + 1,
      request: { deviceCode: false },
      idempotencyKey: "00000000-0000-4000-8000-000000000811",
    });
    completeCodexAccountMutationAuthorityRetirement(
      store,
      profile.id,
      profile.processGeneration,
    );

    const begun = store.beginAccountMutationEffect({
      attemptId: attempt.id,
      profileId: profile.id,
      profileGeneration: profile.processGeneration + 1,
      providerAuthority: sessionProviderAuthority,
      evidence: { kind: "account.login", method: "browser" },
      providerRetirements: [{
        sessionId: session.id,
        connectionId,
        providerAuthority: sessionProviderAuthority,
        releasedEvents: [{
          accountId: profile.id,
          sessionId: session.id,
          providerGeneration: profile.processGeneration,
          providerConnectionId: connectionId,
          body: {
            type: "assistant_delta",
            turnId: publicProviderIdentifier("turn-login-retirement"),
            itemId: publicProviderIdentifier("item-login-retirement"),
            text: "[protected]",
          },
        }, {
          accountId: profile.id,
          sessionId: session.id,
          providerGeneration: profile.processGeneration,
          providerConnectionId: null,
          body: {
            type: "warning",
            code: "provider_resume_unavailable",
            message: "Provider observation is unavailable.",
          },
        }],
      }],
    });

    expect(begun).toMatchObject({
      profile: { processGeneration: profile.processGeneration + 1, state: "login_pending" },
      retiredSessionIds: [session.id],
    });
    expect(store.requireInteraction(interaction.publicId)).toMatchObject({
      revision: interaction.revision + 1,
      state: "expired",
    });
    expect(store.readMutation("00000000-0000-4000-8000-000000000811"))
      .toMatchObject({ state: "effect_started" });
    const events = store.listSessionEvents({
      sessionId: session.id,
      afterSequence: 0,
      limit: 100,
    }).events;
    expect(events.map((event) => event.body)).toEqual([
      { type: "connection", state: "connected" },
      {
        type: "interaction_state",
        interactionId: interaction.publicId,
        state: "expired",
        revision: interaction.revision + 1,
      },
      {
        type: "assistant_delta",
        turnId: publicProviderIdentifier("turn-login-retirement"),
        itemId: publicProviderIdentifier("item-login-retirement"),
        text: "[protected]",
      },
      {
        type: "warning",
        code: "provider_resume_unavailable",
        message: "Provider observation is unavailable.",
      },
      { type: "connection", state: "disconnected", reason: "closed" },
      {
        type: "gap",
        reason: "provider_disconnect",
        fromSequence: 6,
        throughSequence: 6,
      },
    ]);
    expect(events.map((event) => event.providerGeneration))
      .toEqual(events.map(() => profile.processGeneration));
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
  });
test("atomically retires exact session authority with a logout binding transition", async () => {
    const { store, home } = await fixture();
    const profile = signInProfile(store, "Logout retirement", "logout-retirement@example.com");
    const created = store.createSession({
      profileId: profile.id,
      preset: "high",
      fastEnabled: false,
    });
    const session = store.bindSession({
      sessionId: created.id,
      expectedRevision: created.revision,
      providerThreadId: "thread-logout-retirement",
      state: "idle",
    });
    const providerAuthority = store.requireProviderAccountAuthority(profile.id, "codex");
    const connectionId = "11500000-0000-4000-8000-000000000001";
    store.appendSessionEvent({
      sessionId: session.id,
      accountId: profile.id,
      providerGeneration: profile.processGeneration,
      providerAuthority,
      providerConnectionId: connectionId,
      body: { type: "connection", state: "connected" },
    });
    const workStore = store.createWorkStore(
      0,
      () => "unused-test-cursor",
      {
        issue: () => "unused-test-capability",
        verify: () => false,
      },
    );

    const changed = store.setProfileStateWithProviderRetirement({
      profileId: profile.id,
      expectedGeneration: profile.processGeneration,
      state: "signed_out",
      providerAuthority,
      workStore,
      providerRetirements: [{
        sessionId: session.id,
        connectionId,
        providerAuthority,
        releasedEvents: [{
          accountId: profile.id,
          sessionId: session.id,
          providerGeneration: profile.processGeneration,
          providerConnectionId: connectionId,
          body: {
            type: "assistant_delta",
            turnId: publicProviderIdentifier("turn-logout-retirement"),
            itemId: publicProviderIdentifier("item-logout-retirement"),
            text: "[protected]",
          },
        }],
      }],
    });

    expect(changed).toMatchObject({
      changed: true,
      profile: { state: "signed_out" },
      retiredSessionIds: [session.id],
    });
    expect(store.requireProviderAccountAuthority(profile.id, "codex")).toMatchObject({
      bindingGeneration: providerAuthority.bindingGeneration + 1,
      processGeneration: providerAuthority.processGeneration,
    });
    const events = store.listSessionEvents({
      sessionId: session.id,
      afterSequence: 0,
      limit: 100,
    }).events;
    expect(events.map((event) => event.body)).toEqual([
      { type: "connection", state: "connected" },
      {
        type: "assistant_delta",
        turnId: publicProviderIdentifier("turn-logout-retirement"),
        itemId: publicProviderIdentifier("item-logout-retirement"),
        text: "[protected]",
      },
      { type: "connection", state: "disconnected", reason: "closed" },
      {
        type: "gap",
        reason: "provider_disconnect",
        fromSequence: 4,
        throughSequence: 4,
      },
    ]);
    const database = new Database(
      resolveStatePaths({ homeDirectory: home, platform: "darwin" }).database,
      { readonly: true, strict: true },
    );
    try {
      const authorities = database.query(
        `SELECT binding_generation,process_generation
         FROM session_event_provider_authorities
         WHERE session_id=? ORDER BY sequence`,
      ).all(session.id);
      expect(authorities).toEqual(events.map(() => ({
        binding_generation: providerAuthority.bindingGeneration,
        process_generation: providerAuthority.processGeneration,
      })));
    } finally {
      database.close(false);
    }
  });
test("rolls back a logout retirement snapshot after its event writes and permits one exact retry", async () => {
    const { store } = await fixture();
    const profile = signInProfile(store, "Late logout rollback", "late-logout-rollback@example.com");
    const session = upsertProvenTestSession(store, {
      profileId: profile.id,
      preset: "high",
      fastEnabled: false,
      providerThreadId: "thread-late-logout-rollback",
      state: "idle",
    });
    const providerAuthority = store.requireProviderAccountAuthority(profile.id, "codex");
    const connectionId = "11600000-0000-4000-8000-000000000001";
    store.appendSessionEvent({
      sessionId: session.id,
      accountId: profile.id,
      providerGeneration: providerAuthority.processGeneration,
      providerAuthority,
      providerConnectionId: connectionId,
      body: { type: "connection", state: "connected" },
    });
    const interaction = store.admitInteraction({
      publicId: "11600000-0000-4000-8000-000000000002",
      sessionId: session.id,
      authority: {
        ...codexInteractionBinding(store, profile.id),
        profileId: profile.id,
        processGeneration: providerAuthority.processGeneration,
        connectionId,
        requestId: { type: "string", value: "late-logout-rollback" },
        method: "item/commandExecution/requestApproval",
        requestDigest: "6".repeat(64),
        threadId: "thread-late-logout-rollback",
        turnId: "turn-late-logout-rollback",
        itemId: "item-late-logout-rollback",
        approvalId: null,
      },
      kind: "command_approval",
      blocking: true,
      display: {
        kind: "command_approval",
        summary: "Retain exact expired interaction after rollback",
        reason: null,
        commandClass: "test",
        workingDirectory: null,
        availableDecisions: ["once", "decline", "cancel"],
      },
    }).record;
    const idempotencyKey = "00000000-0000-4000-8000-000000000816";
    const attempt = store.prepareMutation({
      kind: "account.logout",
      authorityId: profile.id,
      authorityGeneration: providerAuthority.processGeneration,
      request: {},
      idempotencyKey,
      providerAuthorities: [{ role: "primary", authority: providerAuthority, provenance: "account_logout" }],
    });
    const releasedBody = {
      type: "assistant_delta" as const,
      turnId: publicProviderIdentifier("turn-late-logout-rollback"),
      itemId: publicProviderIdentifier("item-late-logout-rollback"),
      text: "[protected]",
    };
    const input: Parameters<StateStore["beginAccountMutationEffect"]>[0] = {
      attemptId: attempt.id,
      profileId: profile.id,
      profileGeneration: providerAuthority.processGeneration,
      providerAuthority,
      evidence: { kind: "account.logout", baselineSignedIn: true },
      providerRetirements: [{
        sessionId: session.id,
        connectionId,
        providerAuthority,
        releasedEvents: [{
          accountId: profile.id,
          sessionId: session.id,
          providerGeneration: providerAuthority.processGeneration,
          providerConnectionId: connectionId,
          body: releasedBody,
        }],
      }],
    };
    const workStore = createRevocationWorkStore(store);
    const personal = store.beginProviderRuntimeAccountRevocation({
      profileId: profile.id, expectedGeneration: profile.processGeneration,
      provider: "codex", runtimeScope: "personal", currentAccountKey: null, workStore,
    });
    store.completeProviderRuntimeAccountRevocation({
      profileId: profile.id, expectedGeneration: profile.processGeneration,
      provider: "codex", runtimeScope: "personal", expectedRevision: personal.revocation.revision,
    });
    store.beginProviderRuntimeAccountRevocation({
      profileId: profile.id, expectedGeneration: profile.processGeneration,
      provider: "codex", runtimeScope: "managed", currentAccountKey: null, workStore,
    });
    const expired = store.requireInteraction(interaction.publicId);
    expect(expired).toMatchObject({ state: "expired", revision: interaction.revision + 1 });
    const database = new Database(store.paths.database, { create: false, strict: true });
    try {
      const snapshot = () => ({
        profile: database.query("SELECT * FROM profiles WHERE id=?").get(profile.id),
        accounts: database.query("SELECT * FROM provider_accounts WHERE profile_id=? ORDER BY provider").all(profile.id),
        providerAuthority: store.requireProviderAccountAuthority(profile.id, "codex"),
        capturedAuthority: store.requireCapturedSessionProviderAuthority(session.id),
        session: database.query("SELECT * FROM sessions WHERE id=?").get(session.id),
        mutation: database.query("SELECT * FROM mutation_attempts WHERE id=?").get(attempt.id),
        mutationAuthorities: store.readMutationProviderAuthorities(attempt.id),
        evidence: database.query("SELECT * FROM mutation_effect_evidence WHERE attempt_id=?").all(attempt.id),
        events: database.query("SELECT * FROM session_events WHERE session_id=? ORDER BY sequence").all(session.id),
        eventAuthorities: database.query("SELECT * FROM session_event_provider_authorities WHERE session_id=? ORDER BY sequence").all(session.id),
        stream: database.query("SELECT * FROM session_event_streams WHERE session_id=?").get(session.id),
        cursor: store.eventStreamPosition(session.id),
        interaction: store.requireInteraction(interaction.publicId),
      });
      const before = snapshot();
      expect(before.evidence).toEqual([]);
      expect(store.readMutation(idempotencyKey)).toMatchObject({ state: "prepared" });
      // The failure fires only after all three captured retirement events
      // have reached SQLite. If they are absent this trigger does not reject,
      // so the expected error cannot be satisfied by its wrong-order branch.
      database.exec(`CREATE TRIGGER test_logout_retirement_evidence_failure
        BEFORE INSERT ON mutation_effect_evidence
        WHEN NEW.attempt_id='${attempt.id}' AND NEW.kind='account.logout'
          AND (SELECT COUNT(*) FROM session_events WHERE session_id='${session.id}')=${before.events.length + 3}
        BEGIN
          SELECT RAISE(ABORT,'INJECTED_LOGOUT_EVIDENCE_FAILURE');
        END;`);
      try {
        // The provenance writer sanitizes SQL failures at its public boundary.
        expect(() => store.beginAccountMutationEffect(input))
          .toThrow("EFFECT_EVIDENCE_PROVENANCE_CORRUPT");
        expect(snapshot()).toEqual(before);
      } finally {
        database.exec("DROP TRIGGER test_logout_retirement_evidence_failure");
      }

      expect(store.beginAccountMutationEffect(input)).toMatchObject({
        profile: { state: "signed_in", processGeneration: profile.processGeneration },
        retiredSessionIds: [session.id],
      });
      const after = snapshot();
      expect(after.profile).toEqual(before.profile);
      expect(after.accounts).toEqual(before.accounts);
      expect(after.providerAuthority).toEqual(providerAuthority);
      expect(after.capturedAuthority).toEqual(before.capturedAuthority);
      expect(after.session).toEqual(before.session);
      expect(after.mutationAuthorities).toEqual(before.mutationAuthorities);
      expect(after.interaction).toEqual(expired);
      expect(store.readMutation(idempotencyKey)).toMatchObject({ state: "effect_started" });
      expect(after.evidence).toHaveLength(1);
      expect(after.evidence).toMatchObject([{
        attempt_id: attempt.id,
        kind: "account.logout",
        evidence_json: JSON.stringify(input.evidence),
        evidence_digest: createHash("sha256").update(JSON.stringify(input.evidence)).digest("hex"),
      }]);
      expect(after.events.slice(0, before.events.length)).toEqual(before.events);
      expect(after.eventAuthorities.slice(0, before.eventAuthorities.length)).toEqual(before.eventAuthorities);
      expect(after.events).toHaveLength(before.events.length + 3);
      expect(after.eventAuthorities).toHaveLength(before.eventAuthorities.length + 3);
      expect(after.cursor.observedThroughSequence).toBe(before.cursor.observedThroughSequence + 3);
      const events = store.listSessionEvents({ sessionId: session.id, afterSequence: 0, limit: 100 }).events;
      expect(events.slice(-3).map((event) => event.body)).toEqual([
        releasedBody,
        { type: "connection", state: "disconnected", reason: "closed" },
        {
          type: "gap", reason: "provider_disconnect",
          fromSequence: before.cursor.observedThroughSequence + 3,
          throughSequence: before.cursor.observedThroughSequence + 3,
        },
      ]);
      expect(database.query(`SELECT provider_account_id,profile_id,provider,binding_generation,process_generation
        FROM session_event_provider_authorities WHERE session_id=? ORDER BY sequence`).all(session.id))
        .toEqual(events.map(() => ({
          provider_account_id: providerAuthority.providerAccountId,
          profile_id: providerAuthority.profileId,
          provider: providerAuthority.provider,
          binding_generation: providerAuthority.bindingGeneration,
          process_generation: providerAuthority.processGeneration,
        })));
    } finally {
      database.close(false);
    }
  });
test("rolls an invalid account-login retirement back and permits an exact retry", async () => {
    const { store } = await fixture();
    const profile = signInProfile(store, "Rollback retirement", "rollback-retirement@example.com");
    const other = signInProfile(store, "Other retirement", "other-retirement@example.com");
    const session = upsertProvenTestSession(store, {
      profileId: profile.id,
      preset: "high",
      fastEnabled: false,
      providerThreadId: "thread-rollback-retirement", state: "idle",
    });
    const otherSession = store.createSession({
      profileId: other.id,
      preset: "high",
      fastEnabled: false,
    });
    const sessionProviderAuthority = store.requireProviderAccountAuthority(profile.id, "codex");
    const otherSessionProviderAuthority = store.requireProviderAccountAuthority(other.id, "codex");
    const connectionId = "12000000-0000-4000-8000-000000000001";
    const interaction = store.admitInteraction({
      publicId: "12000000-0000-4000-8000-000000000002",
      sessionId: session.id,
      authority: {
        ...codexInteractionBinding(store, profile.id),
        profileId: profile.id,
        processGeneration: profile.processGeneration,
        connectionId,
        requestId: { type: "number", value: 1 },
        method: "item/commandExecution/requestApproval",
        requestDigest: "2".repeat(64),
        threadId: "thread-rollback-retirement",
        turnId: "turn-rollback-retirement",
        itemId: "item-rollback-retirement",
        approvalId: null,
      },
      kind: "command_approval",
      blocking: true,
      display: {
        kind: "command_approval",
        summary: "Keep pending after rollback",
        reason: null,
        commandClass: "test",
        workingDirectory: null,
        availableDecisions: ["once", "decline", "cancel"],
      },
    }).record;
    const key = "00000000-0000-4000-8000-000000000812";
    const attempt = store.prepareMutation({
      kind: "account.login",
      authorityId: profile.id,
      authorityGeneration: profile.processGeneration + 1,
      request: { deviceCode: false },
      idempotencyKey: key,
    });
    const begin = (providerRetirements: Parameters<StateStore["beginAccountMutationEffect"]>[0]["providerRetirements"]) =>
      store.beginAccountMutationEffect({
        attemptId: attempt.id,
        profileId: profile.id,
        profileGeneration: profile.processGeneration + 1,
        providerAuthority: sessionProviderAuthority,
        evidence: { kind: "account.login", method: "browser" },
        ...(providerRetirements === undefined ? {} : { providerRetirements }),
      });
    completeCodexAccountMutationAuthorityRetirement(
      store,
      profile.id,
      profile.processGeneration,
    );
    const assertUnchanged = (): void => {
      expect(store.requireProfileById(profile.id)).toMatchObject({
        processGeneration: profile.processGeneration,
        state: "signed_in",
      });
      expect(store.requireInteraction(interaction.publicId)).toMatchObject({
        revision: interaction.revision + 1,
        state: "expired",
      });
      expect(store.readMutation(key)).toMatchObject({ state: "prepared" });
      expect(store.eventStreamPosition(session.id).observedThroughSequence).toBe(1);
    };

    expect(() => begin([{
      sessionId: session.id,
      connectionId,
      providerAuthority: sessionProviderAuthority,
      releasedEvents: [{
        accountId: profile.id,
        sessionId: session.id,
        providerGeneration: profile.processGeneration,
        providerConnectionId: null,
        body: {
          type: "assistant_delta",
          turnId: publicProviderIdentifier("turn-rollback-retirement"),
          itemId: publicProviderIdentifier("item-rollback-retirement"),
          text: "[protected]",
        },
      }],
    }])).toThrow("ACCOUNT_PROVIDER_RETIREMENT_EVENT_AUTHORITY_MISMATCH");
    assertUnchanged();
    expect(() => begin([{
      sessionId: session.id,
      connectionId,
      providerAuthority: sessionProviderAuthority,
      releasedEvents: [{
        accountId: profile.id,
        sessionId: session.id,
        providerGeneration: profile.processGeneration,
        providerConnectionId: connectionId,
        body: {
          type: "gap",
          reason: "provider_disconnect",
          fromSequence: 1,
          throughSequence: 1,
        },
      }],
    }])).toThrow("ACCOUNT_PROVIDER_RETIREMENT_EVENT_AUTHORITY_MISMATCH");
    assertUnchanged();
    expect(() => begin([{
      sessionId: otherSession.id,
      connectionId,
      providerAuthority: otherSessionProviderAuthority,
      releasedEvents: [],
    }])).toThrow("ACCOUNT_PROVIDER_RETIREMENT_AUTHORITY_MISMATCH");
    assertUnchanged();

    expect(begin([{
      sessionId: session.id,
      connectionId,
      providerAuthority: sessionProviderAuthority,
      releasedEvents: [],
    }])).toMatchObject({
      profile: { processGeneration: profile.processGeneration + 1 },
      retiredSessionIds: [session.id],
    });
    expect(store.requireInteraction(interaction.publicId).state).toBe("expired");
  });
test("requires completed Codex authority retirement before ordinary login and logout effects", async () => {
    const { store } = await fixture();
    for (const [kind, idempotencyKey] of [
      ["account.login", "00000000-0000-4000-8000-000000000813"],
      ["account.logout", "00000000-0000-4000-8000-000000000814"],
    ] as const) {
      const profile = signInProfile(
        store,
        `Retirement parity ${kind}`,
        `retirement-parity-${kind.slice("account.".length)}@example.com`,
      );
      const effectGeneration = kind === "account.login"
        ? profile.processGeneration + 1
        : profile.processGeneration;
      const attempt = store.prepareMutation({
        kind,
        authorityId: profile.id,
        authorityGeneration: effectGeneration,
        request: kind === "account.login" ? { deviceCode: false } : {},
        idempotencyKey,
      });
      const evidence = kind === "account.login"
        ? { kind, method: "browser" as const }
        : { kind, baselineSignedIn: true };

      expect(() => store.beginAccountMutationEffect({
        providerAuthority: store.requireProviderAccountAuthority(profile.id, "codex"),
        attemptId: attempt.id,
        profileId: profile.id,
        profileGeneration: effectGeneration,
        evidence,
      })).toThrow("ACCOUNT_MUTATION_CODEX_AUTHORITY_NOT_RETIRED");
      expect(store.readMutation(idempotencyKey)).toMatchObject({ state: "prepared" });

      completeCodexRuntimeAccountAuthorityRetirement(
        store,
        profile.id,
        profile.processGeneration,
        kind === "account.login" ? "personal" : "managed",
      );
      expect(() => store.beginAccountMutationEffect({
        providerAuthority: store.requireProviderAccountAuthority(profile.id, "codex"),
        attemptId: attempt.id,
        profileId: profile.id,
        profileGeneration: effectGeneration,
        evidence,
      })).toThrow("ACCOUNT_MUTATION_CODEX_AUTHORITY_NOT_RETIRED");
      expect(store.readMutation(idempotencyKey)).toMatchObject({ state: "prepared" });

      completeCodexAccountMutationAuthorityRetirement(
        store,
        profile.id,
        profile.processGeneration,
      );
      expect(store.beginAccountMutationEffect({
        providerAuthority: store.requireProviderAccountAuthority(profile.id, "codex"),
        attemptId: attempt.id,
        profileId: profile.id,
        profileGeneration: effectGeneration,
        evidence,
      })).toMatchObject({
        profile: {
          processGeneration: effectGeneration,
          state: kind === "account.login" ? "login_pending" : "signed_in",
        },
      });
      expect(store.readMutation(idempotencyKey)).toMatchObject({ state: "effect_started" });
      for (const runtimeScope of ["personal", "managed"] as const) {
        expect(store.readProviderRuntimeAccountRevocation({
          profileId: profile.id,
          provider: "codex",
          runtimeScope,
        })).toMatchObject({
          currentAccountKey: null,
          profileGeneration: profile.processGeneration,
          state: "completed",
        });
      }
    }
  });
test("starts logout after personal retirement while its exact managed null fence is still releasing", async () => {
    const { store } = await fixture();
    const profile = signInProfile(
      store,
      "Ordered logout retirement",
      "ordered-logout-retirement@example.com",
    );
    const idempotencyKey = "00000000-0000-4000-8000-000000000815";
    const attempt = store.prepareMutation({
      kind: "account.logout",
      authorityId: profile.id,
      authorityGeneration: profile.processGeneration,
      request: {},
      idempotencyKey,
    });
    const workStore = createRevocationWorkStore(store);
    const personal = store.beginProviderRuntimeAccountRevocation({
      profileId: profile.id,
      expectedGeneration: profile.processGeneration,
      provider: "codex",
      runtimeScope: "personal",
      currentAccountKey: null,
      workStore,
    });
    const managed = store.beginProviderRuntimeAccountRevocation({
      profileId: profile.id,
      expectedGeneration: profile.processGeneration,
      provider: "codex",
      runtimeScope: "managed",
      currentAccountKey: null,
      workStore,
    });

    expect(() => store.beginAccountMutationEffect({
      providerAuthority: store.requireProviderAccountAuthority(profile.id, "codex"),
      attemptId: attempt.id,
      profileId: profile.id,
      profileGeneration: profile.processGeneration,
      evidence: { kind: "account.logout", baselineSignedIn: true },
    })).toThrow("ACCOUNT_MUTATION_CODEX_AUTHORITY_NOT_RETIRED");
    expect(store.readMutation(idempotencyKey)).toMatchObject({ state: "prepared" });

    store.completeProviderRuntimeAccountRevocation({
      profileId: profile.id,
      expectedGeneration: profile.processGeneration,
      provider: "codex",
      runtimeScope: "personal",
      expectedRevision: personal.revocation.revision,
    });
    expect(store.beginAccountMutationEffect({
      providerAuthority: store.requireProviderAccountAuthority(profile.id, "codex"),
      attemptId: attempt.id,
      profileId: profile.id,
      profileGeneration: profile.processGeneration,
      evidence: { kind: "account.logout", baselineSignedIn: true },
    })).toMatchObject({
      profile: {
        processGeneration: profile.processGeneration,
        state: "signed_in",
      },
    });
    expect(store.readMutation(idempotencyKey)).toMatchObject({ state: "effect_started" });
    expect(store.readProviderRuntimeAccountRevocation({
      profileId: profile.id,
      provider: "codex",
      runtimeScope: "personal",
    })).toMatchObject({ currentAccountKey: null, state: "completed" });
    expect(store.readProviderRuntimeAccountRevocation({
      profileId: profile.id,
      provider: "codex",
      runtimeScope: "managed",
    })).toMatchObject({
      currentAccountKey: null,
      profileGeneration: profile.processGeneration,
      revision: managed.revocation.revision,
      state: "releasing",
    });
  });
test("does not extend logout's releasing exception to login or a non-null managed fence", async () => {
    const { store } = await fixture();
    const loginProfile = signInProfile(
      store,
      "Still fenced login",
      "still-fenced-login@example.com",
    );
    const loginAttempt = store.prepareMutation({
      kind: "account.login",
      authorityId: loginProfile.id,
      authorityGeneration: loginProfile.processGeneration + 1,
      request: { deviceCode: false },
      idempotencyKey: "00000000-0000-4000-8000-000000000816",
    });
    completeCodexRuntimeAccountAuthorityRetirement(
      store,
      loginProfile.id,
      loginProfile.processGeneration,
      "personal",
    );
    store.beginProviderRuntimeAccountRevocation({
      profileId: loginProfile.id,
      expectedGeneration: loginProfile.processGeneration,
      provider: "codex",
      runtimeScope: "managed",
      currentAccountKey: null,
      workStore: createRevocationWorkStore(store),
    });
    expect(() => store.beginAccountMutationEffect({
      providerAuthority: store.requireProviderAccountAuthority(loginProfile.id, "codex"),
      attemptId: loginAttempt.id,
      profileId: loginProfile.id,
      profileGeneration: loginProfile.processGeneration + 1,
      evidence: { kind: "account.login", method: "browser" },
    })).toThrow("ACCOUNT_MUTATION_CODEX_AUTHORITY_NOT_RETIRED");

    const logoutProfile = signInProfile(
      store,
      "Non-null fenced logout",
      "non-null-fenced-logout@example.com",
    );
    const logoutAttempt = store.prepareMutation({
      kind: "account.logout",
      authorityId: logoutProfile.id,
      authorityGeneration: logoutProfile.processGeneration,
      request: {},
      idempotencyKey: "00000000-0000-4000-8000-000000000817",
    });
    completeCodexRuntimeAccountAuthorityRetirement(
      store,
      logoutProfile.id,
      logoutProfile.processGeneration,
      "personal",
    );
    store.beginProviderRuntimeAccountRevocation({
      profileId: logoutProfile.id,
      expectedGeneration: logoutProfile.processGeneration,
      provider: "codex",
      runtimeScope: "managed",
      currentAccountKey: providerAccountKeyForProfile(
        store,
        logoutProfile.id,
        "codex",
      ),
      workStore: createRevocationWorkStore(store),
    });
    expect(() => store.beginAccountMutationEffect({
      providerAuthority: store.requireProviderAccountAuthority(logoutProfile.id, "codex"),
      attemptId: logoutAttempt.id,
      profileId: logoutProfile.id,
      profileGeneration: logoutProfile.processGeneration,
      evidence: { kind: "account.logout", baselineSignedIn: true },
    })).toThrow("ACCOUNT_MUTATION_CODEX_AUTHORITY_NOT_RETIRED");
    expect(store.readMutation("00000000-0000-4000-8000-000000000816"))
      .toMatchObject({ state: "prepared" });
    expect(store.readMutation("00000000-0000-4000-8000-000000000817"))
      .toMatchObject({ state: "prepared" });
  });
test("evicts a deterministic contiguous event prefix by age and reports the exact floor gap", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "oompa-store-event-retention-")));
    const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
    await initializeStatePaths(paths);
    let currentTime = 1_000;
    const store = new StateStore(paths, { now: () => currentTime });
    stores.push(store);
    const profile = signInProfile(store, "Retention", "retention@example.com");
    const session = createProvenTestSession(store, {
      profileId: profile.id,
      preset: "high",
      fastEnabled: false,
      providerThreadId: "thread-interaction",
    });
    const append = (message: string) => store.appendSessionEvent({
      sessionId: session.id,
      accountId: profile.id,
      providerGeneration: profile.processGeneration,
      providerAuthority: store.requireProviderAccountAuthority(profile.id, "codex"),
      providerConnectionId: null,
      body: { type: "warning", code: "RETENTION", message },
    });
    const first = append("first");
    currentTime = 1_001;
    append("second");
    currentTime = 1_002 + SESSION_EVENT_RETAIN_AGE_MS;
    const third = append("third");

    expect(third).toMatchObject({ sequence: 3, streamEpoch: first.streamEpoch });
    expect(store.eventStreamPosition(session.id)).toEqual({
      streamEpoch: first.streamEpoch,
      floorSequence: 3,
      observedThroughSequence: 3,
    });
    expect(store.listSessionEvents({ sessionId: session.id, afterSequence: 0 })).toMatchObject({
      gapReason: "retention_age",
      retentionGapReason: "retention_age",
      floorSequence: 3,
      observedThroughSequence: 3,
      events: [{ sequence: 3 }],
    });
    expect(store.listSessionEvents({ sessionId: session.id, afterSequence: null })).toMatchObject({
      gapReason: null,
      retentionGapReason: "retention_age",
      events: [{ sequence: 3 }],
    });
  });
test("maintains the age bound while reading an idle stream with no new append", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "oompa-store-event-read-retention-")));
    const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
    await initializeStatePaths(paths);
    let currentTime = 1_000;
    const store = new StateStore(paths, { now: () => currentTime });
    stores.push(store);
    const profile = signInProfile(store, "Idle retention", "idle-retention@example.com");
    const session = store.createSession({
      profileId: profile.id,
      preset: "high",
      fastEnabled: false,
    });
    const event = store.appendSessionEvent({
      sessionId: session.id,
      accountId: profile.id,
      providerGeneration: profile.processGeneration,
      providerAuthority: store.requireProviderAccountAuthority(profile.id, "codex"),
      providerConnectionId: null,
      body: { type: "warning", code: "RETENTION", message: "age without append" },
    });

    currentTime += SESSION_EVENT_RETAIN_AGE_MS + 1;

    expect(store.listSessionEvents({
      sessionId: session.id,
      afterSequence: 0,
    })).toMatchObject({
      gapReason: "retention_age",
      floorSequence: event.sequence + 1,
      observedThroughSequence: event.sequence,
      events: [],
    });
  });
test("caps event pages by encoded bytes without splitting or reordering events", async () => {
    const { store } = await fixture();
    const profile = signInProfile(store, "Page bytes", "page-bytes@example.com");
    const session = createProvenTestSession(store, {
      profileId: profile.id,
      preset: "high",
      fastEnabled: false,
      providerThreadId: "thread-interaction-page",
    });
    for (let index = 0; index < 18; index += 1) {
      store.appendSessionEvent({
        sessionId: session.id,
        accountId: profile.id,
        providerGeneration: profile.processGeneration,
        providerAuthority: store.requireProviderAccountAuthority(profile.id, "codex"),
        providerConnectionId: null,
        body: {
          type: "assistant_delta",
          turnId: "turn-page",
          itemId: `item-${index}`,
          text: "x".repeat(32_768),
        },
      });
    }
    const page = store.listSessionEvents({ sessionId: session.id, afterSequence: 0, limit: 18 });
    expect(page.events.length).toBeGreaterThan(1);
    expect(page.events.length).toBeLessThan(18);
    expect(page.events.map((event) => event.sequence)).toEqual(
      Array.from({ length: page.events.length }, (_, index) => index + 1),
    );
  });
test.each(["codex", "claude"] as const)("rejects a bound interaction from another provider thread for %s", async (provider) => {
    const { store } = await fixture();
    const profile = signInProfile(store, "Exact interaction thread", "exact-thread@example.com");
    const session = upsertProvenTestSession(store, {
      profileId: profile.id, provider, preset: provider === "codex" ? "high" : "fable-max",
      fastEnabled: false,
      providerThreadId: "exact-interaction-thread", state: "idle",
    });
    const captured = store.requireProviderAccountAuthority(profile.id, provider);
    const authority = {
      ...captured, connectionId: "20000000-0000-4000-8000-000000000801",
      requestId: { type: "number" as const, value: 1 },
      method: provider === "codex" ? "item/commandExecution/requestApproval"
        : "claude/control_request/can_use_tool",
      requestDigest: "a".repeat(64), threadId: "exact-interaction-thread",
      turnId: null, itemId: null, approvalId: null,
    };
    const input = {
      publicId: "20000000-0000-4000-8000-000000000802", sessionId: session.id,
      authority, kind: "command_approval" as const, blocking: true,
      display: {
        kind: "command_approval" as const, summary: "Exact thread approval", reason: null,
        commandClass: "test", workingDirectory: null, availableDecisions: ["once" as const],
      },
    };
    for (const threadId of ["unrelated-interaction-thread", null]) {
      expect(() => store.admitInteraction({ ...input, authority: { ...authority, threadId } }))
        .toThrow("INTERACTION_SESSION_AUTHORITY_MISMATCH");
      const inspector = new Database(store.paths.database, { strict: true });
      try {
        expect(() => inspector.query(
          `INSERT INTO provider_interactions(
             public_id,session_id,profile_id,process_generation,connection_id,
             request_id_type,request_id_number,method,request_digest,thread_id,
             kind,state,revision,blocking,display_json,requested_at,updated_at
           ) VALUES (?,?,?,?,?,'number',1,?,?,?,'command_approval','pending',1,1,?,2000,2000)`,
        ).run(input.publicId, session.id, profile.id, captured.processGeneration,
          authority.connectionId, authority.method, authority.requestDigest, threadId,
          JSON.stringify(input.display)))
          .toThrow("provider interaction authority mismatch");
        expect(inspector.query("SELECT count(*) AS count FROM provider_interactions").get())
          .toEqual({ count: 0 });
      } finally {
        inspector.close(false);
      }
    }
    expect(store.admitInteraction(input)).toMatchObject({ replayed: false, record: { state: "pending" } });
  });
test("admits callbacks on migrated Devin history only with the exact retained thread", async () => {
    const paths = await canonical39DevinArchive();
    const source = canonical39DevinFixture.cases.find((entry) => entry.generation === 0);
    if (source === undefined) throw new Error("Expected archived generation-zero Devin session.");
    const store = new StateStore(paths);
    stores.push(store);
    const database = new Database(paths.database, { create: false, strict: true });
    try {
      const before = snapshotSwitchContainmentForTest(database);
      const authority = store.requireProviderAccountAuthority(source.profile.id, "devin");
      const input = {
        publicId: "20000000-0000-4000-8000-000000000802", sessionId: source.session.id,
        authority: { ...authority, connectionId: "20000000-0000-4000-8000-000000000801",
          requestId: { type: "number" as const, value: 1 }, method: "devin/session/request_permission",
          requestDigest: "a".repeat(64), threadId: source.session.providerThreadId, turnId: null, itemId: null, approvalId: null },
        kind: "command_approval" as const, blocking: true,
        display: { kind: "command_approval" as const, summary: "Migrated Devin callback", reason: null,
          commandClass: "test", workingDirectory: null, availableDecisions: ["once" as const] },
      };
      // Every other binding still refuses through the ordinary authority fence.
      for (const [publicId, threadId] of [
        ["20000000-0000-4000-8000-000000000803", "unrelated-interaction-thread"],
        ["20000000-0000-4000-8000-000000000804", null],
      ] as const) {
        expect(() => store.admitInteraction({
          ...input, publicId,
          authority: { ...input.authority, threadId },
        })).toThrow("INTERACTION_SESSION_AUTHORITY_MISMATCH");
      }
      expect(snapshotSwitchContainmentForTest(database)).toEqual(before);
      // The migrated session's exact authority admits like any live session.
      expect(store.admitInteraction(input)).toMatchObject({
        replayed: false, record: { state: "pending" },
      });
    } finally { database.close(false); }
  });
test("brokers tagged provider requests with exact replay and write-ahead CAS states", async () => {
    const { store } = await fixture();
    const profile = signInProfile(store, "Interactions", "interactions@example.com");
    const session = createProvenTestSession(store, {
      profileId: profile.id,
      preset: "high",
      fastEnabled: false,
      providerThreadId: "thread-interaction",
    });
    const connectionId = "20000000-0000-4000-8000-000000000001";
    const authority = {
      ...codexInteractionBinding(store, profile.id),
      profileId: profile.id,
      processGeneration: profile.processGeneration,
      connectionId,
      requestId: { type: "number" as const, value: 1 },
      method: "item/commandExecution/requestApproval",
      requestDigest: "a".repeat(64),
      threadId: "thread-interaction",
      turnId: "turn-interaction",
      itemId: "item-interaction",
      approvalId: "approval-interaction",
    };
    const display = {
      kind: "command_approval" as const,
      summary: "Run the bounded check",
      reason: null,
      commandClass: "test",
      workingDirectory: null,
      availableDecisions: ["once" as const, "session" as const, "decline" as const, "cancel" as const],
    };
    const admitted = store.admitInteraction({
      publicId: "20000000-0000-4000-8000-000000000002",
      sessionId: session.id,
      authority,
      kind: "command_approval",
      blocking: true,
      display,
    });
    expect(admitted).toMatchObject({ replayed: false, record: { state: "pending", revision: 1 } });
    expect(store.admitInteraction({
      publicId: "20000000-0000-4000-8000-000000000003",
      sessionId: session.id,
      authority,
      kind: "command_approval",
      blocking: true,
      display,
    })).toMatchObject({ replayed: true, record: { publicId: admitted.record.publicId, revision: 1 } });
    expect(() => store.admitInteraction({
      publicId: "20000000-0000-4000-8000-000000000004",
      sessionId: session.id,
      authority: { ...authority, requestDigest: "b".repeat(64) },
      kind: "command_approval",
      blocking: true,
      display,
    })).toThrow("INTERACTION_REQUEST_REPLAY_CONFLICT");

    const stringRequest = store.admitInteraction({
      publicId: "20000000-0000-4000-8000-000000000005",
      sessionId: session.id,
      authority: {
        ...authority,
        requestId: { type: "string", value: "1" },
        requestDigest: "c".repeat(64),
      },
      kind: "command_approval",
      blocking: true,
      display,
    });
    expect(stringRequest.record.publicId).not.toBe(admitted.record.publicId);

    const responseDigest = "d".repeat(64);
    const prepared = store.prepareInteractionResponse({
      id: admitted.record.publicId,
      expectedRevision: 1,
      responseDigest,
    });
    expect(prepared).toMatchObject({ state: "response_prepared", revision: 2, responseDigest });
    expect(store.prepareInteractionResponse({
      id: admitted.record.publicId,
      expectedRevision: 1,
      responseDigest,
    })).toEqual(prepared);
    expect(() => store.prepareInteractionResponse({
      id: admitted.record.publicId,
      expectedRevision: 1,
      responseDigest: "e".repeat(64),
    })).toThrow("INTERACTION_RESPONSE_CONFLICT");
    const written = store.markInteractionResponseWritten({
      id: admitted.record.publicId,
      expectedRevision: prepared.revision,
      responseDigest,
    });
    expect(written).toMatchObject({ state: "response_written", revision: 3 });
    expect(store.markInteractionResponseWritten({
      id: admitted.record.publicId,
      expectedRevision: prepared.revision,
      responseDigest,
    })).toEqual(written);
    expect(() => store.settleInteraction({
      id: admitted.record.publicId,
      expectedRevision: written.revision,
      state: "resolved",
      authority: { ...authority, connectionId: "20000000-0000-4000-8000-000000000099" },
      responseDigest,
    })).toThrow("INTERACTION_AUTHORITY_MISMATCH");
    const settled = store.settleInteraction({
      id: admitted.record.publicId,
      expectedRevision: written.revision,
      state: "resolved",
      authority,
      responseDigest,
    });
    expect(settled).toMatchObject({ state: "resolved", revision: 4, responseDigest });
    expect(store.settleInteraction({
      id: admitted.record.publicId,
      expectedRevision: written.revision,
      state: "resolved",
      authority,
      responseDigest,
    })).toEqual(settled);
    expect(store.listInteractions({ sessionId: session.id, pendingOnly: true })).toEqual([
      expect.objectContaining({ publicId: stringRequest.record.publicId, state: "pending" }),
    ]);

    const inspector = new Database(store.paths.database, { readonly: true, strict: true });
    try {
      const columns = inspector.query("PRAGMA table_info(provider_interactions)").all() as Array<{ name: string }>;
      expect(columns.map((column) => column.name)).not.toContain("resolution_json");
      expect(inspector.query(
        "SELECT response_digest,display_json FROM provider_interactions WHERE public_id=?",
      ).get(admitted.record.publicId)).toEqual({ response_digest: responseDigest, display_json: JSON.stringify(display) });
      expect(inspector.query(
        "SELECT revision,state FROM provider_interaction_transitions WHERE public_id=? ORDER BY revision",
      ).all(admitted.record.publicId)).toEqual([
        { revision: 1, state: "pending" },
        { revision: 2, state: "response_prepared" },
        { revision: 3, state: "response_written" },
        { revision: 4, state: "resolved" },
      ]);
    } finally {
      inspector.close(false);
    }
  });
test("paginates tied interactions exactly once in descending-time ascending-id order", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "oompa-store-interaction-page-")));
    const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
    await initializeStatePaths(paths);
    const store = new StateStore(paths, { now: () => 20_000 });
    stores.push(store);
    const profile = signInProfile(store, "Interaction pages", "interaction-pages@example.com");
    const session = createProvenTestSession(store, {
      profileId: profile.id,
      preset: "high",
      fastEnabled: false,
      providerThreadId: "thread-interaction-page",
    });
    const display = {
      kind: "command_approval" as const,
      summary: "Resolve the paged interaction",
      reason: null,
      commandClass: "test",
      workingDirectory: null,
      availableDecisions: ["once" as const, "decline" as const, "cancel" as const],
    };
    const publicIds: string[] = [];
    for (let index = 0; index < 105; index += 1) {
      const suffix = String(index).padStart(12, "0");
      const publicId = `23000000-0000-4000-8000-${suffix}`;
      publicIds.push(publicId);
      store.admitInteraction({
        publicId,
        sessionId: session.id,
        authority: {
          ...codexInteractionBinding(store, profile.id),
          profileId: profile.id,
          processGeneration: profile.processGeneration,
          connectionId: "23000000-0000-4000-8000-999999999999",
          requestId: { type: "number", value: index },
          method: "item/commandExecution/requestApproval",
          requestDigest: index.toString(16).padStart(64, "0"),
          threadId: "thread-interaction-page",
          turnId: `turn-${String(index)}`,
          itemId: `item-${String(index)}`,
          approvalId: null,
        },
        kind: "command_approval",
        blocking: true,
        display,
        requestedAt: 10_000,
        deadlineAt: 30_000,
      });
    }

    const first = store.listInteractionPage({
      sessionId: session.id,
      pendingOnly: true,
      limit: 100,
    });
    expect(first.interactions.map((interaction) => interaction.publicId)).toEqual(publicIds.slice(0, 100));
    const firstPageLastId = publicIds[99];
    if (firstPageLastId === undefined) throw new Error("Expected the first interaction page to be full.");
    expect(first.nextPosition).toEqual({ requestedAt: 10_000, publicId: firstPageLastId });
    if (first.nextPosition === null) throw new Error("Expected an interaction continuation.");
    const second = store.listInteractionPage({
      sessionId: session.id,
      pendingOnly: true,
      limit: 100,
      after: first.nextPosition,
    });
    expect(second.interactions.map((interaction) => interaction.publicId)).toEqual(publicIds.slice(100));
    expect(second.nextPosition).toBeNull();
    expect(new Set([...first.interactions, ...second.interactions].map((interaction) => interaction.publicId)).size)
      .toBe(105);
  });
test("reads only linked, pending, unexpired attention in deterministic deadline order", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "oompa-store-attention-snapshot-")));
    const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
    await initializeStatePaths(paths);
    const now = 50_000;
    const store = new StateStore(paths, { now: () => now });
    stores.push(store);
    const profile = signInProfile(store, "Attention snapshot", "attention-snapshot@example.com");
    const session = upsertProvenTestSession(store, {
      profileId: profile.id,
      preset: "high",
      fastEnabled: false,
      providerThreadId: "thread-attention-snapshot",
      state: "idle",
    });
    const connectionId = "24000000-0000-4000-8000-999999999999";
    const display = {
      kind: "command_approval" as const,
      summary: "Review the bounded interaction",
      reason: null,
      commandClass: "test",
      workingDirectory: null,
      availableDecisions: ["decline" as const],
    };
    const admit = (input: Readonly<{
      deadlineAt: number;
      index: number;
      requestedAt: number;
    }>) => store.admitInteraction({
      publicId: `24000000-0000-4000-8000-${String(input.index).padStart(12, "0")}`,
      sessionId: session.id,
      authority: {
        ...codexInteractionBinding(store, profile.id),
        profileId: profile.id,
        processGeneration: profile.processGeneration,
        connectionId,
        requestId: { type: "number" as const, value: input.index },
        method: "item/commandExecution/requestApproval",
        requestDigest: input.index.toString(16).padStart(64, "0"),
        threadId: "thread-attention-snapshot",
        turnId: `turn-${String(input.index)}`,
        itemId: `item-${String(input.index)}`,
        approvalId: null,
      },
      kind: "command_approval",
      blocking: true,
      display,
      requestedAt: input.requestedAt,
      deadlineAt: input.deadlineAt,
    }).record;

    expect(store.readAttentionNotificationSnapshot({
      limit: ATTENTION_NOTIFICATION_SNAPSHOT_LIMIT,
      now,
    })).toEqual({ interactions: [], observedAt: now, status: "complete" });

    const later = admit({ deadlineAt: now + 500, index: 1, requestedAt: now - 100 });
    const tiedFirst = admit({ deadlineAt: now + 100, index: 2, requestedAt: now - 300 });
    const tiedSecond = admit({ deadlineAt: now + 100, index: 3, requestedAt: now - 300 });
    admit({ deadlineAt: now, index: 4, requestedAt: now - 400 });
    const preparedBase = admit({ deadlineAt: now + 50, index: 5, requestedAt: now - 500 });
    const writtenBase = admit({ deadlineAt: now + 25, index: 6, requestedAt: now - 600 });
    const boundaryFuture = admit({ deadlineAt: now + 1, index: 7, requestedAt: now - 700 });
    store.prepareInteractionResponse({
      id: preparedBase.publicId,
      expectedRevision: preparedBase.revision,
      responseDigest: "a".repeat(64),
    });
    const writtenPrepared = store.prepareInteractionResponse({
      id: writtenBase.publicId,
      expectedRevision: writtenBase.revision,
      responseDigest: "b".repeat(64),
    });
    store.markInteractionResponseWritten({
      id: writtenPrepared.publicId,
      expectedRevision: writtenPrepared.revision,
      responseDigest: "b".repeat(64),
    });

    const snapshot = store.readAttentionNotificationSnapshot({
      limit: ATTENTION_NOTIFICATION_SNAPSHOT_LIMIT,
      now,
    });
    expect(snapshot.status).toBe("complete");
    expect(snapshot.observedAt).toBe(now);
    expect(snapshot.interactions.map((interaction) => interaction.publicId)).toEqual([
      boundaryFuture.publicId,
      tiedFirst.publicId,
      tiedSecond.publicId,
      later.publicId,
    ]);
    expect(snapshot.interactions.every((interaction) =>
      interaction.sessionId !== null
      && interaction.state === "pending"
      && interaction.deadlineAt > now)).toBe(true);

    for (const invalid of [
      { limit: 0, now },
      { limit: ATTENTION_NOTIFICATION_SNAPSHOT_LIMIT + 1, now },
      { limit: 1.5, now },
      { limit: 1, now: -1 },
      { limit: 1, now: Number.NaN },
    ]) {
      expect(() => store.readAttentionNotificationSnapshot(invalid)).toThrow();
    }
  });
test("returns no partial attention candidates on linked overflow", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "oompa-store-attention-overflow-")));
    const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
    await initializeStatePaths(paths);
    const now = 80_000;
    const store = new StateStore(paths, { now: () => now });
    stores.push(store);
    const profile = signInProfile(store, "Attention overflow", "attention-overflow@example.com");
    const session = upsertProvenTestSession(store, {
      profileId: profile.id,
      preset: "high",
      fastEnabled: false,
      providerThreadId: "thread-attention-overflow",
      state: "idle",
    });
    const connectionId = "25000000-0000-4000-8000-999999999999";
    const admit = (index: number, sessionId: string | null) => store.admitInteraction({
      publicId: `25000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      sessionId,
      authority: {
        ...codexInteractionBinding(store, profile.id),
        profileId: profile.id,
        processGeneration: profile.processGeneration,
        connectionId,
        requestId: { type: "number" as const, value: index },
        method: "item/commandExecution/requestApproval",
        requestDigest: index.toString(16).padStart(64, "0"),
        threadId: sessionId === null ? null : "thread-attention-overflow",
        turnId: sessionId === null ? null : `turn-${String(index)}`,
        itemId: sessionId === null ? null : `item-${String(index)}`,
        approvalId: null,
      },
      kind: "command_approval",
      blocking: true,
      display: {
        kind: "command_approval",
        summary: "Review overflow accounting",
        reason: null,
        commandClass: "test",
        workingDirectory: null,
        availableDecisions: ["decline"],
      },
      requestedAt: now - 1_000,
      deadlineAt: now + 1_000,
    }).record;

    for (let index = 1; index <= ATTENTION_NOTIFICATION_SNAPSHOT_LIMIT + 16; index += 1) {
      admit(index, null);
    }
    const linked = Array.from(
      { length: ATTENTION_NOTIFICATION_SNAPSHOT_LIMIT },
      (_, offset) => admit(100 + offset, session.id),
    );
    expect(store.readAttentionNotificationSnapshot({
      limit: ATTENTION_NOTIFICATION_SNAPSHOT_LIMIT,
      now,
    })).toEqual({
      interactions: linked,
      observedAt: now,
      status: "complete",
    });

    admit(100 + ATTENTION_NOTIFICATION_SNAPSHOT_LIMIT, session.id);
    expect(store.readAttentionNotificationSnapshot({
      limit: ATTENTION_NOTIFICATION_SNAPSHOT_LIMIT,
      now,
    })).toEqual({ interactions: [], observedAt: now, status: "overflow" });
  });
test("anchors immutable interaction deadlines and terminal intent across delayed admission", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "oompa-store-deadline-")));
    const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
    await initializeStatePaths(paths);
    let now = 10_000;
    const store = new StateStore(paths, { now: () => now });
    stores.push(store);
    const profile = signInProfile(store, "Deadline", "deadline@example.com");
    const session = createProvenTestSession(store, {
      profileId: profile.id,
      preset: "high",
      fastEnabled: false,
      providerThreadId: "thread-deadline",
    });
    const authority = {
      ...codexInteractionBinding(store, profile.id),
      profileId: profile.id,
      processGeneration: profile.processGeneration,
      connectionId: "21000000-0000-4000-8000-000000000001",
      requestId: { type: "number" as const, value: 1 },
      method: "item/fileChange/requestApproval",
      requestDigest: "a".repeat(64),
      threadId: "thread-deadline",
      turnId: "turn-deadline",
      itemId: "item-deadline",
      approvalId: null,
    };
    const display = {
      kind: "file_change_approval" as const,
      summary: "Allow bounded changes",
      reason: null,
      grantRoot: null,
      availableDecisions: ["once" as const, "decline" as const, "cancel" as const],
    };
    now = 15_000;
    const admitted = store.admitInteraction({
      publicId: "21000000-0000-4000-8000-000000000002",
      sessionId: session.id,
      authority,
      kind: "file_change_approval",
      blocking: true,
      display,
      requestedAt: 10_000,
      deadlineAt: 16_000,
    });
    expect(admitted.record).toMatchObject({ requestedAt: 10_000, deadlineAt: 16_000 });
    expect(store.nextInteractionDeadlineAt()).toBe(16_000);
    expect(store.listDueInteractions({ now: 15_999 })).toEqual([]);
    expect(store.listDueInteractions({ now: 16_000 })).toEqual([admitted.record]);
    now = 16_000;
    expect(store.admitInteraction({
      publicId: "21000000-0000-4000-8000-000000000003",
      sessionId: session.id,
      authority,
      kind: "file_change_approval",
      blocking: true,
      display,
      requestedAt: 10_000,
      deadlineAt: 16_000,
    })).toEqual({ record: admitted.record, replayed: true });
    expect(() => store.admitInteraction({
      publicId: "21000000-0000-4000-8000-000000000004",
      sessionId: session.id,
      authority,
      kind: "file_change_approval",
      blocking: true,
      display,
      requestedAt: 10_000,
      deadlineAt: 16_001,
    })).toThrow("INTERACTION_REQUEST_REPLAY_CONFLICT");

    const digest = "b".repeat(64);
    const prepared = store.prepareInteractionResponse({
      id: admitted.record.publicId,
      expectedRevision: admitted.record.revision,
      responseDigest: digest,
      intendedTerminalState: "declined",
    });
    const written = store.markInteractionResponseWritten({
      id: prepared.publicId,
      expectedRevision: prepared.revision,
      responseDigest: digest,
    });
    expect(() => store.settleInteraction({
      id: written.publicId,
      expectedRevision: written.revision,
      state: "resolved",
      authority,
      responseDigest: digest,
    })).toThrow("INTERACTION_TERMINAL_INTENT_CONFLICT");
    expect(store.settleInteraction({
      id: written.publicId,
      expectedRevision: written.revision,
      state: "declined",
      authority,
      responseDigest: digest,
    })).toMatchObject({ state: "declined", intendedTerminalState: "declined", deadlineAt: 16_000 });
  });
test("supersedes only the exact elapsed prepared response with a durable timeout intent", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "oompa-store-timeout-cas-")));
    const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
    await initializeStatePaths(paths);
    let now = 15_000;
    const store = new StateStore(paths, { now: () => now });
    stores.push(store);
    const profile = signInProfile(store, "Timeout CAS", "timeout-cas@example.com");
    const session = createProvenTestSession(store, {
      profileId: profile.id,
      preset: "high",
      fastEnabled: false,
      providerThreadId: "thread-timeout-cas",
    });
    const authority = {
      ...codexInteractionBinding(store, profile.id),
      profileId: profile.id,
      processGeneration: profile.processGeneration,
      connectionId: "22000000-0000-4000-8000-000000000001",
      requestId: { type: "string" as const, value: "timeout-cas" },
      method: "item/commandExecution/requestApproval",
      requestDigest: "a".repeat(64),
      threadId: "thread-timeout-cas",
      turnId: "turn-timeout-cas",
      itemId: "item-timeout-cas",
      approvalId: null,
    };
    const admitted = store.admitInteraction({
      publicId: "22000000-0000-4000-8000-000000000002",
      sessionId: session.id,
      authority,
      kind: "command_approval",
      blocking: true,
      display: {
        kind: "command_approval",
        summary: "Allow before the deadline",
        reason: null,
        commandClass: "test",
        workingDirectory: null,
        availableDecisions: ["once", "decline", "cancel"],
      },
      requestedAt: 10_000,
      deadlineAt: 16_000,
    }).record;
    const manualResponseDigest = "b".repeat(64);
    const timeoutResponseDigest = "c".repeat(64);
    const prepared = store.prepareInteractionResponse({
      id: admitted.publicId,
      expectedRevision: admitted.revision,
      responseDigest: manualResponseDigest,
      intendedTerminalState: "resolved",
    });
    expect(() => store.supersedePreparedInteractionResponseWithTimeout({
      id: prepared.publicId,
      expectedRevision: prepared.revision,
      manualResponseDigest,
      timeoutResponseDigest,
    })).toThrow("INTERACTION_DEADLINE_NOT_ELAPSED");

    now = 16_000;
    const superseded = store.supersedePreparedInteractionResponseWithTimeout({
      id: prepared.publicId,
      expectedRevision: prepared.revision,
      manualResponseDigest,
      timeoutResponseDigest,
    });
    expect(superseded).toMatchObject({
      state: "response_prepared",
      revision: 3,
      responseDigest: timeoutResponseDigest,
      intendedTerminalState: "expired",
    });
    expect(store.supersedePreparedInteractionResponseWithTimeout({
      id: prepared.publicId,
      expectedRevision: prepared.revision,
      manualResponseDigest,
      timeoutResponseDigest,
    })).toEqual(superseded);
    expect(() => store.supersedePreparedInteractionResponseWithTimeout({
      id: prepared.publicId,
      expectedRevision: prepared.revision,
      manualResponseDigest: "d".repeat(64),
      timeoutResponseDigest,
    })).toThrow("INTERACTION_RESPONSE_CONFLICT");
    expect(() => store.markInteractionResponseWritten({
      id: superseded.publicId,
      expectedRevision: superseded.revision,
      responseDigest: manualResponseDigest,
    })).toThrow("INTERACTION_RESPONSE_CONFLICT");
    const written = store.markInteractionResponseWritten({
      id: superseded.publicId,
      expectedRevision: superseded.revision,
      responseDigest: timeoutResponseDigest,
    });
    expect(written).toMatchObject({ state: "response_written", revision: 4 });
    expect(() => store.supersedePreparedInteractionResponseWithTimeout({
      id: prepared.publicId,
      expectedRevision: prepared.revision,
      manualResponseDigest,
      timeoutResponseDigest: "e".repeat(64),
    })).toThrow("INTERACTION_REVISION_CONFLICT");

    const raw = new Database(paths.database, { create: false, strict: true });
    try {
      expect(() => raw.query(
        "UPDATE provider_interactions SET response_digest=? WHERE public_id=?",
      ).run("f".repeat(64), admitted.publicId)).toThrow(
        "provider interaction response authority is immutable",
      );
      expect(raw.query(
        `SELECT revision,state,response_digest FROM provider_interaction_transitions
         WHERE public_id=? ORDER BY revision`,
      ).all(admitted.publicId)).toEqual([
        { revision: 1, state: "pending", response_digest: null },
        { revision: 2, state: "response_prepared", response_digest: manualResponseDigest },
        { revision: 3, state: "response_prepared", response_digest: timeoutResponseDigest },
        { revision: 4, state: "response_written", response_digest: timeoutResponseDigest },
      ]);
    } finally {
      raw.close(false);
    }
  });
test("expires generation interactions only for the requested session on a shared connection", async () => {
    const { store } = await fixture();
    const profile = signInProfile(store, "Scoped interaction drain", "scoped-drain@example.com");
    const providerAuthority = store.requireProviderAccountAuthority(profile.id, "codex");
    const connectionId = "30000000-0000-4000-8000-000000000091";
    const sessions = [1, 2].map((index) => upsertProvenTestSession(store, {
      profileId: profile.id, provider: "codex", preset: "high", fastEnabled: false,
      providerThreadId: `scoped-drain-thread-${index}`, state: "idle",
    }));
    const interactions = sessions.map((session, index) => store.admitInteraction({
      publicId: randomUUID(), sessionId: session.id,
      authority: {
        ...providerAuthority, connectionId, requestId: { type: "number", value: index + 1 },
        method: "item/commandExecution/requestApproval", requestDigest: String(index + 1).repeat(64),
        threadId: `scoped-drain-thread-${index + 1}`, turnId: null, itemId: null, approvalId: null,
      },
      kind: "command_approval", blocking: true,
      display: { kind: "command_approval", summary: "Approve scoped command", reason: null,
        commandClass: "test", workingDirectory: null, availableDecisions: ["once", "decline"] },
    }).record);
    const selected = interactions[0]!;
    const sibling = interactions[1]!;
    const siblingEvents = store.listSessionEvents({ sessionId: sessions[1]!.id, afterSequence: 0 });
    const input = {
      profileId: profile.id, processGeneration: providerAuthority.processGeneration,
      providerAuthority, connectionId, sessionId: sessions[0]!.id,
    };
    expect(store.expireGenerationInteractions(input)).toMatchObject([{ publicId: selected.publicId, state: "expired" }]);
    expect(store.requireInteraction(sibling.publicId)).toEqual(sibling);
    expect(store.listSessionEvents({ sessionId: sessions[1]!.id, afterSequence: 0 })).toEqual(siblingEvents);
    expect(store.expireGenerationInteractions(input)).toEqual([]);
    expect(store.expireGenerationInteractions({ ...input, sessionId: sessions[1]!.id }))
      .toMatchObject([{ publicId: sibling.publicId, state: "expired" }]);
  });
test("expires untouched generation interactions and quarantines write-adjacent responses", async () => {
    const { store } = await fixture();
    const profile = signInProfile(store, "Interaction restart", "interaction-restart@example.com");
    const connectionId = "30000000-0000-4000-8000-000000000001";
    const admit = (publicId: string, requestId: number) => store.admitInteraction({
      publicId,
      sessionId: null,
      authority: {
        ...codexInteractionBinding(store, profile.id),
        profileId: profile.id,
        processGeneration: profile.processGeneration,
        connectionId,
        requestId: { type: "number", value: requestId },
        method: "item/tool/requestUserInput",
        requestDigest: requestId.toString(16).padStart(64, "0"),
        threadId: null,
        turnId: null,
        itemId: null,
        approvalId: null,
      },
      kind: "user_input",
      blocking: true,
      display: {
        kind: "user_input",
        summary: "A protected question",
        blocking: true,
        questions: [{
          id: `question-${requestId}`,
          header: "Choice",
          question: "Continue?",
          options: null,
          allowsOther: true,
          secret: true,
        }],
      },
    }).record;
    const pending = admit("30000000-0000-4000-8000-000000000002", 1);
    const preparedBase = admit("30000000-0000-4000-8000-000000000003", 2);
    const prepared = store.prepareInteractionResponse({
      id: preparedBase.publicId,
      expectedRevision: preparedBase.revision,
      responseDigest: "f".repeat(64),
    });
    const providerAuthority = store.requireProviderAccountAuthority(profile.id, "codex");
    store.nextProfileGeneration(profile.id);
    expect(() => store.prepareInteractionResponse({
      id: pending.publicId,
      expectedRevision: pending.revision,
      responseDigest: "1".repeat(64),
    })).toThrow("INTERACTION_AUTHORITY_CHANGED");
    const terminal = store.expireGenerationInteractions({
      profileId: profile.id,
      processGeneration: profile.processGeneration,
      connectionId,
      providerAuthority,
    });
    expect(terminal).toEqual([
      expect.objectContaining({ publicId: pending.publicId, state: "expired", revision: 2 }),
      expect.objectContaining({ publicId: prepared.publicId, state: "resolution_unknown", revision: 3 }),
    ]);
    expect(store.listInteractions({ pendingOnly: true })).toEqual([]);
    expect(() => store.prepareInteractionResponse({
      id: pending.publicId,
      expectedRevision: pending.revision,
      responseDigest: "1".repeat(64),
    })).toThrow("INTERACTION_AUTHORITY_CHANGED");
  });
test("repairs interaction-owned attention to working when an active turn loses its callback", async () => {
    const { store } = await fixture();
    const profile = signInProfile(store, "Active restart attention", "active-restart-attention@example.com");
    const threadId = "thread-active-restart-attention";
    const turnId = "turn-active-restart-attention";
    const session = createProvenTestSession(store, {
      profileId: profile.id,
      providerThreadId: threadId,
      title: "Active restart attention",
      preset: "high",
      fastEnabled: false,
      state: "active",
      activeTurnId: turnId,
    });
    const interaction = admitRestartCommandInteraction(store, {
      index: 1,
      processGeneration: profile.processGeneration,
      profileId: profile.id,
      sessionId: session.id,
      threadId,
      turnId,
    });
    store.upsertSessionState({
      sessionId: session.id,
      state: "needs_approval",
      attention: true,
      reason: "pending command_approval",
      verbatimRequired: false,
      verbatimLiteral: undefined,
      lastActivityAt: 900,
      revision: 7,
    });

    expect(store.nextDaemonGeneration(`boot_${"1".repeat(32)}`)).toBe(1);

    expect(store.requireInteraction(interaction.publicId)).toMatchObject({
      state: "expired",
      revision: interaction.revision + 1,
    });
    const repaired = store.readSessionState(session.id);
    expect(repaired).toMatchObject({
      sessionId: session.id,
      state: "working",
      attention: false,
      reason: "turn active",
      verbatimRequired: false,
      verbatimLiteral: null,
      revision: 8,
    });
    if (repaired === null) throw new Error("Expected repaired session state.");
    const events = store.listSessionEvents({
      sessionId: session.id,
      afterSequence: 0,
    }).events;
    expect(events.filter((event) => event.body.type !== "gap").map((event) => ({
      body: event.body,
      providerGeneration: event.providerGeneration,
    }))).toEqual([{
      body: {
        type: "interaction_state",
        interactionId: interaction.publicId,
        state: "expired",
        revision: interaction.revision + 1,
      },
      providerGeneration: profile.processGeneration,
    }, {
      body: {
        type: "session_state",
        state: "working",
        attention: false,
        reason: "turn active",
        verbatimRequired: false,
        lastActivityAt: repaired.lastActivityAt,
        revision: repaired.revision,
      },
      providerGeneration: profile.processGeneration,
    }]);
  });
test.each(["codex", "claude"] as const)("repairs %s restart attention under its captured clean-close authority", async (provider) => {
    const { store } = await fixture();
    const profile = signInProfile(store, `${provider} close attention`, `${provider}-close-attention@example.com`);
    if (provider === "claude") {
      store.advanceProviderAccountProcessGeneration({ profileId: profile.id, provider, expectedProcessGeneration: 0 });
      store.advanceProviderAccountProcessGeneration({ profileId: profile.id, provider, expectedProcessGeneration: 1 });
    }
    const session = upsertProvenTestSession(store, { profileId: profile.id, provider,
      preset: provider === "claude" ? "fable-max" : "high", fastEnabled: false,
      providerThreadId: `${provider}-close-attention-thread`, state: "idle" });
    const captured = store.requireCapturedSessionProviderAuthority(session.id);
    const authority = { provider: captured.provider, providerAccountId: captured.providerAccountId,
      profileId: captured.profileId, bindingGeneration: captured.bindingGeneration, processGeneration: captured.processGeneration };
    const interaction = admitRestartCommandInteraction(store, { index: provider === "codex" ? 41 : 42,
      profileId: profile.id, processGeneration: authority.processGeneration, sessionId: session.id,
      threadId: session.providerThreadId ?? "", turnId: null });
    store.upsertSessionState({ sessionId: session.id, state: "needs_approval", attention: true,
      reason: "pending command_approval", verbatimRequired: false, verbatimLiteral: undefined,
      lastActivityAt: 1_000, revision: 1 });
    store.appendSessionEvent({ sessionId: session.id, accountId: profile.id,
      providerGeneration: authority.processGeneration, providerAuthority: authority, providerConnectionId: null,
      body: { type: "gap", reason: "provider_disconnect", fromSequence: 1, throughSequence: 1 } });
    store.advanceProviderAccountProcessGeneration({ profileId: profile.id, provider, expectedProcessGeneration: authority.processGeneration });
    const ordinaryAppend = () => store.appendSessionEvent({ sessionId: session.id, accountId: profile.id,
      providerGeneration: authority.processGeneration, providerAuthority: authority, providerConnectionId: null,
      body: { type: "connection", state: "disconnected", reason: "test" } });
    expect(ordinaryAppend).toThrow();
    const bootId = `boot_${(provider === "codex" ? "6" : "7").repeat(32)}`;
    expect(store.nextDaemonGeneration(bootId)).toBe(1);
    expect(store.requireInteraction(interaction.publicId)).toMatchObject({ state: "expired", authority: interaction.authority });
    expect(store.readSessionState(session.id)).toMatchObject({ state: "aborted", attention: false, revision: 2 });
    const events = store.listSessionEvents({ sessionId: session.id, afterSequence: 0 }).events;
    expect(events.filter((event) => event.body.type === "interaction_state" || event.body.type === "session_state"))
      .toMatchObject([{ providerGeneration: authority.processGeneration }, { providerGeneration: authority.processGeneration }]);
    const database = new Database(store.paths.database, { readonly: true, strict: true });
    try {
      expect(database.query(`SELECT provider_account_id,provider,binding_generation,process_generation FROM session_event_provider_authorities
        WHERE session_id=? ORDER BY sequence`).all(session.id)).toEqual(events.map(() => ({
        provider_account_id: authority.providerAccountId, provider, binding_generation: authority.bindingGeneration,
        process_generation: authority.processGeneration,
      })));
    } finally { database.close(false); }
    expect(ordinaryAppend).toThrow();
    expect(store.nextDaemonGeneration(bootId)).toBe(1);
    expect(store.listSessionEvents({ sessionId: session.id, afterSequence: 0 }).events).toEqual(events);
  });
test("repairs stranded historical Devin attention without consuming its unused close or granting a successor", async () => {
    const paths = await archivedRetired49();
    const store = new StateStore(paths);
    stores.push(store);
    const { session, capturedAuthority: authority } = combined49RetiredFixture.close;
    const database = new Database(paths.database, { readonly: true, strict: true });
    try {
      const originalHistory = retiredCloseHistory(database);
      const originalSession = store.requireSession(session.id);
      // Local display state only; this does not create a provider interaction,
      // runtime observation, writer witness, close receipt or process authority.
      store.upsertSessionState({ sessionId: session.id, state: "needs_approval", attention: true,
        reason: "pending command_approval", verbatimRequired: false, verbatimLiteral: undefined,
        lastActivityAt: 1_000, revision: 1 });
      const bootId = `boot_${"8".repeat(32)}`;
      expect(store.nextDaemonGeneration(bootId)).toBe(2);
      expect(store.requireCapturedSessionProviderAuthority(session.id)).toEqual(authority);
      // Local attention repair is not a new provider discontinuity or process grant.
      expect(store.requireSession(session.id)).toEqual(originalSession);
      expect(originalSession.state).toBe("idle");
      expect(store.readSessionState(session.id)).toMatchObject({ state: "aborted", attention: false, revision: 2 });
      const stateEvents = store.listSessionEvents({ sessionId: session.id, afterSequence: 0 }).events
        .filter((event) => event.body.type === "session_state");
      expect(stateEvents).toMatchObject([{ providerGeneration: authority.processGeneration, accountId: authority.profileId }]);
      expect(store.nextDaemonGeneration(bootId)).toBe(2);
      expect(store.readSessionState(session.id)?.revision).toBe(2);
      expect(retiredCloseHistory(database)).toEqual(originalHistory);
    } finally { database.close(false); }
  });
test.each([false, true])("daemon boot preserves authentic v39 unproved attention with pending callback=%s", async (pendingCallback) => {
    const scenario = pendingCallback
      ? "canonical39-unproved-attention-with-callback"
      : "canonical39-unproved-attention-without-callback";
    const paths = await canonicalIdentityAttentionArchive(scenario);
    const source = canonicalIdentityAttentionFixtures[scenario];
    const { session, state, interaction } = source.retained;
    const database = new Database(paths.database, { create: false, strict: true });
    try {
      const original = canonicalAuthBudgetSnapshot(database);
      expect(database.query("SELECT * FROM session_runtime_profiles").all()).toEqual([]);
      expect(database.query("SELECT name FROM sqlite_master WHERE name='session_provider_account_authorities'").get()).toBeNull();
      expect(database.query("SELECT * FROM session_events").all()).toEqual([]);
      expect(database.query("SELECT * FROM session_autorespond_counters").all()).toEqual([]);
      expect(() => new StateStore(paths, { readonly: true })).toThrow("STATE_SCHEMA_MIGRATION_REQUIRED:39:61");
      expect(canonicalAuthBudgetSnapshot(database)).toEqual(original);
      const retained = canonicalAuthBudgetRows(database, Object.keys(original.rows)
        .filter((table) => !["migrations", "sessions", "session_autorespond_counters"].includes(table)));
      const sessions = canonicalAuthBudgetRows(database, ["sessions"]);
      const expectedSessions = z.array(z.record(z.string(), z.unknown())).parse(sessions.before.sessions)
        .map((row) => ({ ...row, state: "recovery_required", active_turn_id: null,
          revision: z.number().parse(row.revision) + 1, updated_at: 90_000 }));
      const store = new StateStore(paths, { now: () => 90_000 });
      stores.push(store);
      expect(retained.read()).toEqual(retained.before);
      expect(sessions.read().sessions).toEqual(expectedSessions);
      expect(database.query("SELECT * FROM session_autorespond_counters").all())
        .toEqual([{ session_id: session.id, consecutive_count: 3, updated_at: 90_000 }]);
      expect(database.query("SELECT * FROM migrations WHERE version<=39 ORDER BY version").all()).toEqual([...source.ledger]);
      expect(database.query("SELECT version FROM migrations ORDER BY version").all())
        .toEqual(Array.from({ length: 61 }, (_, index) => ({ version: index + 1 })));
      expect(database.query("PRAGMA user_version").get()).toEqual({ user_version: 61 });
      expect(store.hasUnsettledLegacyProviderAuthorityQuarantineForSession(session.id)).toBe(true);
      expect(store.sessionAccountAuthorityMatches(session.id, source.retained.profile.id)).toBe(false);
      expect(store.readSessionProviderAccountAuthority(session.id)).toBeNull();
      expect(() => store.requireCapturedSessionProviderAuthority(session.id))
        .toThrow("SESSION_PROVIDER_AUTHORITY_QUARANTINED:missing_immutable_runtime_authority");
      const authorityTables = ["session_runtime_profiles", "session_provider_authorities",
        "session_provider_account_authorities", "interaction_provider_authorities",
        "session_events", "session_event_provider_authorities", "mutation_effect_evidence"];
      for (const table of authorityTables) expect(database.query(`SELECT * FROM "${table}"`).all()).toEqual([]);

      // This drives the real storage boot transition, not a daemon process or
      // provider restart. Missing historical authority cannot repair attention.
      const bootId = `boot_${"9".repeat(32)}`;
      const migratedSession = store.requireSession(session.id);
      expect(store.nextDaemonGeneration(bootId)).toBe(1);
      expect(store.readSessionState(session.id)).toEqual(state);
      expect(store.requireSession(session.id)).toEqual(migratedSession);
      expect(store.hasUnsettledLegacyProviderAuthorityQuarantineForSession(session.id)).toBe(true);
      expect(store.eventStreamPosition(session.id).observedThroughSequence).toBe(0);
      if (interaction !== null) {
        expect(store.readInteractionProviderAuthority(interaction.publicId)).toBeNull();
        expect(database.query("SELECT state,revision,display_json FROM provider_interactions WHERE public_id=?")
          .get(interaction.publicId)).toEqual({ state: interaction.state, revision: interaction.revision,
          display_json: JSON.stringify(interaction.display) });
        expect(() => store.requireInteraction(interaction.publicId)).toThrow("INTERACTION_PROVIDER_AUTHORITY_MISSING");
      }
      for (const table of authorityTables) expect(database.query(`SELECT * FROM "${table}"`).all()).toEqual([]);
      expect(database.query("PRAGMA foreign_key_check").all()).toEqual([]);
      const booted = canonicalAuthBudgetSnapshot(database);
      expect(store.nextDaemonGeneration(bootId)).toBe(1);
      expect(canonicalAuthBudgetSnapshot(database)).toEqual(booted);
      expectCanonical35To38InertReopens(paths, database);
    } finally { database.close(false); }
  });
test.each(["codex", "claude"] as const)("restart preserves historical attention when the %s account binding has changed", async (provider) => {
    const { store } = await fixture();
    const profile = signInProfile(store, "Retired binding attention", "retired-binding-attention@example.com");
    const session = upsertProvenTestSession(store, { profileId: profile.id, provider,
      preset: provider === "codex" ? "high" : "fable-max", fastEnabled: false,
      providerThreadId: `retired-binding-${provider}`, state: "idle" });
    const captured = store.requireCapturedSessionProviderAuthority(session.id);
    const state = store.upsertSessionState({ sessionId: session.id, state: "needs_approval", attention: true,
      reason: "pending command_approval", verbatimRequired: false, verbatimLiteral: undefined,
      lastActivityAt: 1_000, revision: 1 });
    if (provider === "codex") {
      completeCodexAccountMutationAuthorityRetirement(store, profile.id, profile.processGeneration);
      store.setProfileState(profile.id, profile.processGeneration, "recovery_required");
    } else {
      store.observeProviderAccountReadiness({ profileId: profile.id, provider,
        expectedBindingGeneration: captured.bindingGeneration, readiness: "signed_in" });
    }
    expect(store.requireProviderAccountAuthority(profile.id, provider).bindingGeneration)
      .toBe(captured.bindingGeneration + 1);
    const events = store.listSessionEvents({ sessionId: session.id, afterSequence: 0 }).events;
    const bootId = `boot_${"b".repeat(32)}`;
    expect(store.nextDaemonGeneration(bootId)).toBe(1);
    expect(store.readSessionState(session.id)).toEqual(state);
    expect(store.requireCapturedSessionProviderAuthority(session.id)).toEqual(captured);
    expect(store.listSessionEvents({ sessionId: session.id, afterSequence: 0 }).events).toEqual(events);
    expect(store.nextDaemonGeneration(bootId)).toBe(1);
    expect(store.readSessionState(session.id)).toEqual(state);
  });
test("repairs interaction-owned attention to aborted when an idle session loses its callback", async () => {
    const { store } = await fixture();
    const profile = signInProfile(store, "Idle restart attention", "idle-restart-attention@example.com");
    const threadId = "thread-idle-restart-attention";
    const session = createProvenTestSession(store, {
      profileId: profile.id,
      providerThreadId: threadId,
      title: "Idle restart attention",
      preset: "high",
      fastEnabled: false,
      state: "idle",
    });
    const interaction = admitRestartCommandInteraction(store, {
      index: 2,
      processGeneration: profile.processGeneration,
      profileId: profile.id,
      sessionId: session.id,
      threadId,
      turnId: null,
    });
    store.upsertSessionState({
      sessionId: session.id,
      state: "needs_approval",
      attention: true,
      reason: "autorespond_manual_mode",
      verbatimRequired: false,
      verbatimLiteral: undefined,
      lastActivityAt: 901,
      revision: 3,
    });

    expect(store.nextDaemonGeneration(`boot_${"2".repeat(32)}`)).toBe(1);

    expect(store.requireInteraction(interaction.publicId)).toMatchObject({
      state: "expired",
      revision: interaction.revision + 1,
    });
    const repaired = store.readSessionState(session.id);
    expect(repaired).toMatchObject({
      state: "aborted",
      attention: false,
      reason: "provider interaction ended during daemon restart",
      verbatimRequired: false,
      verbatimLiteral: null,
      revision: 4,
    });
    const stateEvents = store.listSessionEvents({
      sessionId: session.id,
      afterSequence: 0,
    }).events.filter((event) => event.body.type === "session_state");
    expect(stateEvents).toHaveLength(1);
    expect(stateEvents[0]).toMatchObject({
      body: {
        type: "session_state",
        state: "aborted",
        attention: false,
        reason: "provider interaction ended during daemon restart",
        revision: 4,
      },
    });
  });
test("preserves non-interaction attention while restart terminalizes linked interactions", async () => {
    const { store } = await fixture();
    const profile = signInProfile(
      store,
      "Non-interaction restart attention",
      "non-interaction-restart-attention@example.com",
    );
    const cases = [{
      index: 11,
      state: "needs_answer" as const,
      reason: "autorespond_verbatim_mismatch",
      verbatimRequired: true,
      verbatimLiteral: "Approve exactly this sentence.",
    }, {
      index: 12,
      state: "needs_action" as const,
      reason: "review the release checklist",
      verbatimRequired: false,
      verbatimLiteral: undefined,
    }];
    const casesBySession = new Map<string, Readonly<{
      before: ReturnType<StateStore["upsertSessionState"]>;
      interaction: ReturnType<typeof admitRestartCommandInteraction>;
    }>>();

    for (const input of cases) {
      const threadId = `thread-non-interaction-attention-${String(input.index)}`;
      const turnId = `turn-non-interaction-attention-${String(input.index)}`;
      const session = createProvenTestSession(store, {
        profileId: profile.id,
        providerThreadId: threadId,
        title: `Non-interaction attention ${String(input.index)}`,
        preset: "high",
        fastEnabled: false,
        state: "active",
        activeTurnId: turnId,
      });
      const interaction = admitRestartCommandInteraction(store, {
        index: input.index,
        processGeneration: profile.processGeneration,
        profileId: profile.id,
        sessionId: session.id,
        threadId,
        turnId,
      });
      const before = store.upsertSessionState({
        sessionId: session.id,
        state: input.state,
        attention: true,
        reason: input.reason,
        verbatimRequired: input.verbatimRequired,
        verbatimLiteral: input.verbatimLiteral,
        lastActivityAt: 910 + input.index,
        revision: input.index,
      });
      casesBySession.set(session.id, { before, interaction });
    }

    expect(store.nextDaemonGeneration(`boot_${"3".repeat(32)}`)).toBe(1);

    for (const [sessionId, { before, interaction }] of casesBySession) {
      expect(store.requireInteraction(interaction.publicId)).toMatchObject({
        state: "expired",
        revision: interaction.revision + 1,
      });
      expect(store.readSessionState(sessionId)).toEqual(before);
      const events = store.listSessionEvents({ sessionId, afterSequence: 0 }).events;
      expect(events.filter((event) => event.body.type === "interaction_state")).toHaveLength(1);
      expect(events.filter((event) => event.body.type === "session_state")).toEqual([]);
    }
  });
test("repairs one session-state revision after terminalizing every interaction in the session", async () => {
    const { store } = await fixture();
    const profile = signInProfile(store, "Multi restart attention", "multi-restart-attention@example.com");
    const threadId = "thread-multi-restart-attention";
    const turnId = "turn-multi-restart-attention";
    const session = createProvenTestSession(store, {
      profileId: profile.id,
      providerThreadId: threadId,
      title: "Multi restart attention",
      preset: "high",
      fastEnabled: false,
      state: "active",
      activeTurnId: turnId,
    });
    const interactions = [21, 22].map((index) => admitRestartCommandInteraction(store, {
      index,
      processGeneration: profile.processGeneration,
      profileId: profile.id,
      sessionId: session.id,
      threadId,
      turnId,
    }));
    store.upsertSessionState({
      sessionId: session.id,
      state: "needs_approval",
      attention: true,
      reason: "autorespond_manual_mode",
      verbatimRequired: false,
      verbatimLiteral: undefined,
      lastActivityAt: 920,
      revision: 20,
    });

    expect(store.nextDaemonGeneration(`boot_${"4".repeat(32)}`)).toBe(1);

    for (const interaction of interactions) {
      expect(store.requireInteraction(interaction.publicId)).toMatchObject({
        publicId: interaction.publicId,
        state: "expired",
        revision: interaction.revision + 1,
      });
    }
    expect(store.readSessionState(session.id)).toMatchObject({
      state: "working",
      attention: false,
      reason: "turn active",
      revision: 21,
    });
    const events = store.listSessionEvents({ sessionId: session.id, afterSequence: 0 }).events;
    expect(events.filter((event) => event.body.type === "interaction_state").map((event) => event.body))
      .toEqual(interactions.map((interaction) => ({
        type: "interaction_state",
        interactionId: interaction.publicId,
        state: "expired",
        revision: interaction.revision + 1,
      })));
    expect(events.filter((event) => event.body.type === "session_state")).toHaveLength(1);
  });
test("rolls restart interaction and attention repair back when its event append fails", async () => {
    const { store } = await fixture();
    const profile = signInProfile(store, "Restart repair rollback", "restart-repair-rollback@example.com");
    const threadId = "thread-restart-repair-rollback";
    const turnId = "turn-restart-repair-rollback";
    const session = createProvenTestSession(store, {
      profileId: profile.id,
      providerThreadId: threadId,
      title: "Restart repair rollback",
      preset: "high",
      fastEnabled: false,
      state: "active",
      activeTurnId: turnId,
    });
    const interaction = admitRestartCommandInteraction(store, {
      index: 31,
      processGeneration: profile.processGeneration,
      profileId: profile.id,
      sessionId: session.id,
      threadId,
      turnId,
    });
    const beforeState = store.upsertSessionState({
      sessionId: session.id,
      state: "needs_approval",
      attention: true,
      reason: "pending command_approval",
      verbatimRequired: false,
      verbatimLiteral: undefined,
      lastActivityAt: 931,
      revision: 31,
    });
    const injector = new Database(store.paths.database, { create: false, strict: true });
    try {
      injector.exec(`
        CREATE TRIGGER fail_restart_session_state_event
        BEFORE INSERT ON session_events
        WHEN json_extract(NEW.event_json,'$.body.type')='session_state'
        BEGIN
          SELECT RAISE(ABORT,'injected restart event failure');
        END
      `);
    } finally {
      injector.close(false);
    }

    expect(() => store.nextDaemonGeneration(`boot_${"5".repeat(32)}`))
      .toThrow("injected restart event failure");

    expect(store.requireInteraction(interaction.publicId)).toEqual(interaction);
    expect(store.readSessionState(session.id)).toEqual(beforeState);
    expect(store.requireProfileById(profile.id).processGeneration).toBe(profile.processGeneration);
    expect(store.eventStreamPosition(session.id).observedThroughSequence).toBe(0);
    const inspector = new Database(store.paths.database, { readonly: true, strict: true });
    try {
      expect(inspector.query("SELECT generation FROM daemon_state WHERE singleton=1").get())
        .toEqual({ generation: 0 });
      expect(inspector.query(
        "SELECT revision,state FROM provider_interaction_transitions WHERE public_id=? ORDER BY revision",
      ).all(interaction.publicId)).toEqual([{ revision: 1, state: "pending" }]);
    } finally {
      inspector.close(false);
    }
  });
test("repairs adopted Codex attention before advancing personal authority", async () => {
    const { store } = await fixture();
    const profile = signInProfile(
      store,
      "Adopted restart attention",
      "adopted-restart-attention@example.com",
    );
    const threadId = "thread-adopted-restart-attention";
    store.setSessionAdoptionPolicy({ provider: "codex", profileId: profile.id });
    const candidate = store.upsertSessionAdoptionCandidate({
      provider: "codex",
      providerThreadId: threadId,
      title: "Adopted restart attention",
      state: "idle",
      providerUpdatedAt: 10,
      liveness: "not_live",
    });
    const claiming = store.fenceSessionAdoptionCandidateForClaim({
      provider: "codex",
      providerThreadId: threadId,
      expectedRevision: candidate.revision,
    });
    const adopted = store.adoptSessionCandidate({
      providerAuthority: store.requireProviderAccountAuthority(profile.id, "codex"),
      provider: "codex",
      providerThreadId: threadId,
      expectedCandidateRevision: claiming.revision,
      profileId: profile.id,
      profileGeneration: profile.processGeneration,
      preset: "high",
      requirement: presetRequirements.high,
      fastEnabled: false,
      runtimeProfile: codexAdoptionRuntimeProfile(profile, "high", false),
      providerAccountKey: providerAccountKeyForProfile(store, profile.id, "codex"),
    });
    const interaction = admitRestartCommandInteraction(store, {
      index: 41,
      processGeneration: profile.processGeneration,
      profileId: profile.id,
      sessionId: adopted.session.id,
      threadId,
      turnId: null,
    });
    const beforeState = store.upsertSessionState({
      sessionId: adopted.session.id,
      state: "needs_approval",
      attention: true,
      reason: "autorespond_protected_authority_required",
      verbatimRequired: false,
      verbatimLiteral: undefined,
      lastActivityAt: 941,
      revision: 41,
    });

    expect(store.nextDaemonGeneration(`boot_${"6".repeat(32)}`)).toBe(1);

    expect(store.requireInteraction(interaction.publicId)).toMatchObject({
      state: "expired",
      revision: interaction.revision + 1,
    });
    expect(store.readSessionState(adopted.session.id)).toMatchObject({
      state: "aborted",
      attention: false,
      reason: "provider interaction ended during daemon restart",
      revision: beforeState.revision + 1,
    });
    expect(store.requireProfileById(profile.id).processGeneration)
      .toBe(profile.processGeneration + 1);
    expect(store.readSessionPersonalRuntimeBinding(adopted.session.id)).toMatchObject({
      provider: "codex",
      providerThreadId: threadId,
      state: "active",
    });
    expect(store.sessionAccountAuthorityMatches(adopted.session.id, profile.id)).toBe(true);
    expect(store.listSessionEvents({
      sessionId: adopted.session.id,
      afterSequence: 0,
    }).events.map((event) => ({
      type: event.body.type,
      providerGeneration: event.providerGeneration,
    }))).toEqual([
      { type: "gap", providerGeneration: profile.processGeneration },
      { type: "interaction_state", providerGeneration: profile.processGeneration },
      { type: "session_state", providerGeneration: profile.processGeneration },
    ]);
    const inspector = new Database(store.paths.database, { readonly: true, strict: true });
    try {
      expect(inspector.query(
        "SELECT COUNT(*) AS count FROM session_adoption_profile_generation_permits",
      ).get()).toEqual({ count: 0 });
    } finally {
      inspector.close(false);
    }
  });
for (const effect of ["known_unsent", "possibly_sent"] as const) {
    test(`atomically quarantines an interaction persistence boundary that is ${effect}`, async () => {
      const { store } = await fixture();
      const profile = signInProfile(
        store,
        `Persistence ${effect}`,
        `persistence-${effect}@example.com`,
      );
      const session = upsertProvenTestSession(store, {
        profileId: profile.id,
        preset: "high",
        fastEnabled: false,
        providerThreadId: "thread-persistence-quarantine", state: "idle",
      });
      const connectionId = effect === "known_unsent"
        ? "30100000-0000-4000-8000-000000000001"
        : "30200000-0000-4000-8000-000000000001";
      let request = 0;
      const admit = (connection = connectionId) => {
        request += 1;
        return store.admitInteraction({
          publicId: crypto.randomUUID(),
          sessionId: session.id,
          authority: {
            ...codexInteractionBinding(store, profile.id),
            profileId: profile.id,
            processGeneration: profile.processGeneration,
            connectionId: connection,
            requestId: { type: "number", value: request },
            method: "item/commandExecution/requestApproval",
            requestDigest: request.toString(16).padStart(64, "0"),
            threadId: "thread-persistence-quarantine",
            turnId: "turn-persistence-quarantine",
            itemId: `item-${String(request)}`,
            approvalId: null,
          },
          kind: "command_approval",
          blocking: true,
          display: {
            kind: "command_approval",
            summary: "Quarantine the persistence boundary",
            reason: null,
            commandClass: "test",
            workingDirectory: null,
            availableDecisions: ["once", "decline", "cancel"],
          },
        }).record;
      };
      const focalBase = admit();
      const focalPrepared = store.prepareInteractionResponse({
        id: focalBase.publicId,
        expectedRevision: focalBase.revision,
        responseDigest: "a".repeat(64),
      });
      const focal = effect === "known_unsent"
        ? focalPrepared
        : store.markInteractionResponseWritten({
            id: focalPrepared.publicId,
            expectedRevision: focalPrepared.revision,
            responseDigest: "a".repeat(64),
          });
      const peerPending = admit();
      const peerPrepared = store.prepareInteractionResponse({
        id: admit().publicId,
        expectedRevision: 1,
        responseDigest: "b".repeat(64),
      });
      const peerPreparedForWrite = store.prepareInteractionResponse({
        id: admit().publicId,
        expectedRevision: 1,
        responseDigest: "c".repeat(64),
      });
      const peerWritten = store.markInteractionResponseWritten({
        id: peerPreparedForWrite.publicId,
        expectedRevision: peerPreparedForWrite.revision,
        responseDigest: "c".repeat(64),
      });
      const otherConnection = admit("30900000-0000-4000-8000-000000000001");
      const claudeAuthority = store.advanceProviderAccountProcessGeneration({
        profileId: profile.id, provider: "claude", expectedProcessGeneration: 0,
      });
      const claudeSession = upsertProvenTestSession(store, {
        profileId: profile.id, provider: "claude", preset: "fable-max", fastEnabled: false,
        providerThreadId: "thread-persistence-quarantine-claude", state: "idle",
      });
      const coincidentClaudeInteraction = store.admitInteraction({
        publicId: crypto.randomUUID(),
        sessionId: claudeSession.id,
        authority: {
          ...claudeAuthority,
          connectionId,
          requestId: { type: "string", value: "coincident-claude-request" },
          method: "claude/control_request/can_use_tool",
          requestDigest: "d".repeat(64),
          threadId: "thread-persistence-quarantine-claude",
          turnId: "turn-persistence-quarantine",
          itemId: "coincident-claude-tool",
          approvalId: null,
        },
        kind: "command_approval",
        blocking: true,
        display: {
          kind: "command_approval", summary: "Independent Claude authority",
          reason: null, commandClass: "test", workingDirectory: null,
          availableDecisions: ["once", "decline", "cancel"],
        },
      }).record;

      expect(() => store.quarantineInteractionPersistenceBoundary({
        profileId: profile.id,
        processGeneration: profile.processGeneration,
        connectionId,
        focalInteractionId: focal.publicId,
        effect,
        responseDigest: "f".repeat(64),
      })).toThrow("INTERACTION_QUARANTINE_RESPONSE_CONFLICT");
      expect(store.requireProfileById(profile.id).processGeneration).toBe(
        profile.processGeneration,
      );
      expect(store.requireInteraction(focal.publicId)).toEqual(focal);
      expect(store.requireInteraction(peerPending.publicId)).toEqual(peerPending);
      expect(store.requireInteraction(otherConnection.publicId)).toEqual(otherConnection);

      const quarantined = store.quarantineInteractionPersistenceBoundary({
        profileId: profile.id,
        processGeneration: profile.processGeneration,
        connectionId,
        focalInteractionId: focal.publicId,
        effect,
        responseDigest: "a".repeat(64),
      });

      expect(quarantined.profile.processGeneration).toBe(profile.processGeneration + 1);
      expect(store.requireProviderAccountAuthority(profile.id, "claude")).toEqual(claudeAuthority);
      expect(store.requireInteraction(coincidentClaudeInteraction.publicId))
        .toEqual(coincidentClaudeInteraction);
      expect(quarantined.focalInteraction).toMatchObject({
        publicId: focal.publicId,
        state: effect === "known_unsent" ? "expired" : "resolution_unknown",
        revision: focal.revision + 1,
      });
      expect(quarantined.terminalInteractions).toEqual([
        expect.objectContaining({ publicId: focal.publicId }),
        expect.objectContaining({ publicId: peerPending.publicId, state: "expired" }),
        expect.objectContaining({ publicId: peerPrepared.publicId, state: "resolution_unknown" }),
        expect.objectContaining({ publicId: peerWritten.publicId, state: "resolution_unknown" }),
        expect.objectContaining({ publicId: otherConnection.publicId, state: "expired" }),
      ]);
      const terminalEvents = store.listSessionEvents({
        sessionId: session.id,
        afterSequence: 0,
      }).events;
      expect(terminalEvents).toHaveLength(quarantined.terminalInteractions.length);
      expect(terminalEvents.map((event) => ({
        accountId: event.accountId,
        body: event.body,
        providerGeneration: event.providerGeneration,
      }))).toEqual(quarantined.terminalInteractions.map((interaction) => ({
        accountId: profile.id,
        body: {
          type: "interaction_state",
          interactionId: interaction.publicId,
          state: interaction.state,
          revision: interaction.revision,
        },
        providerGeneration: profile.processGeneration,
      })));
      expect(store.requireInteraction(otherConnection.publicId)).toMatchObject({
        state: "expired",
        revision: 2,
      });
      expect(() => store.prepareInteractionResponse({
        id: otherConnection.publicId,
        expectedRevision: otherConnection.revision,
        responseDigest: "d".repeat(64),
      })).toThrow("INTERACTION_AUTHORITY_CHANGED");

      const inspector = new Database(store.paths.database, { readonly: true, strict: true });
      try {
        for (const terminal of quarantined.terminalInteractions) {
          expect(inspector.query(
            `SELECT revision,state FROM provider_interaction_transitions
             WHERE public_id=? ORDER BY revision DESC LIMIT 1`,
          ).get(terminal.publicId)).toEqual({
            revision: terminal.revision,
            state: terminal.state,
          });
        }
        expect(inspector.query(
          "SELECT COUNT(*) AS count FROM provider_interaction_transitions WHERE public_id=?",
        ).get(otherConnection.publicId)).toEqual({ count: 2 });
      } finally {
        inspector.close(false);
      }
    });
  }
test("rolls back every quarantine transition when its generation fence cannot commit", async () => {
    const { store } = await fixture();
    const profile = signInProfile(store, "Persistence rollback", "persistence-rollback@example.com");
    const session = upsertProvenTestSession(store, {
      profileId: profile.id,
      preset: "high",
      fastEnabled: false,
      providerThreadId: "thread-persistence-rollback", state: "idle",
    });
    const connectionId = "30300000-0000-4000-8000-000000000001";
    const admit = (requestId: number) => store.admitInteraction({
      publicId: crypto.randomUUID(),
      sessionId: session.id,
      authority: {
        ...codexInteractionBinding(store, profile.id),
        profileId: profile.id,
        processGeneration: profile.processGeneration,
        connectionId,
        requestId: { type: "number", value: requestId },
        method: "item/tool/requestUserInput",
        requestDigest: requestId.toString(16).padStart(64, "0"),
        threadId: "thread-persistence-rollback",
        turnId: null,
        itemId: null,
        approvalId: null,
      },
      kind: "user_input",
      blocking: true,
      display: {
        kind: "user_input",
        summary: "Rollback the persistence quarantine",
        blocking: true,
        questions: [{
          id: `rollback-${String(requestId)}`,
          header: "Rollback",
          question: "Continue?",
          options: null,
          allowsOther: true,
          secret: true,
        }],
      },
    }).record;
    const focal = store.prepareInteractionResponse({
      id: admit(1).publicId,
      expectedRevision: 1,
      responseDigest: "a".repeat(64),
    });
    const peer = admit(2);
    const injector = new Database(store.paths.database, { create: false, strict: true });
    try {
      injector.exec(`
        CREATE TRIGGER reject_interaction_quarantine_generation
        BEFORE UPDATE OF process_generation ON profiles
        WHEN OLD.id='${profile.id}'
        BEGIN SELECT RAISE(ABORT, 'injected quarantine rollback'); END;
      `);
    } finally {
      injector.close(false);
    }

    expect(() => store.quarantineInteractionPersistenceBoundary({
      profileId: profile.id,
      processGeneration: profile.processGeneration,
      connectionId,
      focalInteractionId: focal.publicId,
      effect: "known_unsent",
      responseDigest: "a".repeat(64),
    })).toThrow("injected quarantine rollback");
    expect(store.requireProfileById(profile.id).processGeneration).toBe(
      profile.processGeneration,
    );
    expect(store.requireInteraction(focal.publicId)).toEqual(focal);
    expect(store.requireInteraction(peer.publicId)).toEqual(peer);
    expect(store.listSessionEvents({ sessionId: session.id, afterSequence: 0 }).events).toEqual([]);
    const inspector = new Database(store.paths.database, { readonly: true, strict: true });
    try {
      expect(inspector.query(
        "SELECT revision,state FROM provider_interaction_transitions WHERE public_id=? ORDER BY revision",
      ).all(focal.publicId)).toEqual([
        { revision: 1, state: "pending" },
        { revision: 2, state: "response_prepared" },
      ]);
      expect(inspector.query(
        "SELECT revision,state FROM provider_interaction_transitions WHERE public_id=? ORDER BY revision",
      ).all(peer.publicId)).toEqual([{ revision: 1, state: "pending" }]);
    } finally {
      inspector.close(false);
    }
  });
test("allocates usage revisions atomically and pages the historical ledger", async () => {
    const { store } = await fixture();
    const profile = store.createProfile("Usage ledger");
    expect(store.allocateNextUsageRevision(profile.id)).toBe(1);
    recordUsageForTest(store, profile.id, 1, 10_000, { totalTokens: 100 });
    expect(store.allocateNextUsageRevision(profile.id)).toBe(2);
    const secondUsage = recordUsageForTest(store, profile.id, 2, 20_000, { totalTokens: 250 });
    recordUsageForTest(store, profile.id, 2, 20_000, { totalTokens: 250 });
    expect(() => recordUsageForTest(store, profile.id, 2, 20_000, { totalTokens: 251 }))
      .toThrow("Usage source revision conflict");
    expect(store.usageRange({ profileId: profile.id, fromObservedAt: 15_000, throughObservedAt: 25_000 })).toEqual([
      { sourceRevision: 2, observedAt: 20_000, payload: secondUsage },
    ]);
    expect(store.latestUsage(profile.id)).toEqual({
      sourceRevision: 2,
      observedAt: 20_000,
      payload: secondUsage,
    });
  });
test("creates new profiles with explicit active reset policy atomically", async () => {
    const { store } = await fixture();
    const profile = store.createProfile("Policy active");
    expect(store.requireAccountRateLimitResetPolicy(profile.id)).toMatchObject({
      state: "active_unbound",
      accountFingerprint: null,
      weeklyWindowResetsAt: null,
      revision: 1,
    });

    const writer = new Database(store.paths.database, { create: false, strict: true });
    try {
      writer.exec(`
        CREATE TRIGGER test_reset_policy_insert_failure
        BEFORE INSERT ON account_rate_limit_reset_policies
        WHEN NEW.profile_id IN (SELECT id FROM profiles WHERE label='Policy rollback')
        BEGIN SELECT RAISE(ABORT, 'injected policy insert failure'); END;
      `);
    } finally {
      writer.close(false);
    }
    expect(() => store.createProfile("Policy rollback"))
      .toThrow("injected policy insert failure");
    expect(store.listProfiles().map((candidate) => candidate.label))
      .not.toContain("Policy rollback");
  });
test("re-pends an unbound reset policy when the signed-in identity changes", async () => {
    const { store } = await fixture();
    const firstEmail = "unbound-first@example.com";
    const profile = signInProfile(store, "Unbound identity drift", firstEmail);
    expect(store.requireAccountRateLimitResetPolicy(profile.id)).toMatchObject({
      state: "active_unbound",
      accountFingerprint: null,
      weeklyWindowResetsAt: null,
      revision: 1,
    });

    const secondEmail = "unbound-second@example.com";
    expect(store.setProfileState(
      profile.id,
      profile.processGeneration,
      "signed_in",
      { email: secondEmail, plan: "Plus" },
    )).toBe(true);
    expect(store.requireProfileById(profile.id)).toMatchObject({
      providerEmail: secondEmail,
    });
    expect(store.requireAccountRateLimitResetPolicy(profile.id)).toMatchObject({
      state: "reconciliation_required",
      accountFingerprint: null,
      weeklyWindowResetsAt: null,
      revision: 2,
    });

    const secondFingerprint = resetAccountFingerprint(secondEmail);
    expect(() => store.prepareAccountRateLimitReset({
      profileId: profile.id,
      processGeneration: profile.processGeneration,
      accountFingerprint: secondFingerprint,
      weeklyWindowResetsAt: 500_000_000,
      observedUsedPercent: 99,
    })).toThrow("ACCOUNT_RATE_LIMIT_RESET_POLICY_NOT_ACTIVE");
    expect(store.authorizeAccountRateLimitResetPolicy({
      profileId: profile.id,
      processGeneration: profile.processGeneration,
      accountFingerprint: secondFingerprint,
      weeklyWindowDurationMinutes: 10_080,
      weeklyWindowResetsAt: 500_000_000,
    })).toMatchObject({
      decision: "suppress",
      reason: "reconciliation_window",
      policy: {
        accountFingerprint: secondFingerprint,
        state: "window_suppressed",
        weeklyWindowResetsAt: 500_000_000,
      },
    });
  });
test("migrates every nonremoved profile from an exact v27 writer into fail-closed reconciliation", async () => {
    const source = canonicalResetPolicyFixtures[27];
    const ledger = [...source.ledger].sort((a, b) => a.version - b.version);
    const paths = await canonicalResetPolicyArchive(27);
    const inspector = new Database(paths.database, { create: false, strict: true });
    try {
      expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: 27 });
      expect(inspector.query("SELECT * FROM migrations ORDER BY version").all()).toEqual(ledger);
      expect(inspector.query("SELECT 1 FROM sqlite_master WHERE name='account_rate_limit_reset_policies'").get()).toBeNull();
      const original = canonicalAuthBudgetRows(inspector, ["profiles", "account_rate_limit_reset_attempts", "usage_revision_authority"]);
      const before = canonicalAuthBudgetSnapshot(inspector);
      expect(() => { const opened = new StateStore(paths, { readonly: true }); opened.close(); })
        .toThrow("STATE_SCHEMA_MIGRATION_REQUIRED:27:61");
      expect(canonicalAuthBudgetSnapshot(inspector)).toEqual(before);

      const migrated = new StateStore(paths, { now: () => 40_000, resolveMachineTimeZone: () => "UTC" });
      stores.push(migrated);
      expect(original.read()).toEqual(original.before);
      for (const profileId of [source.signedIn.id, source.signedOut.id]) {
        expect(migrated.requireAccountRateLimitResetPolicy(profileId)).toMatchObject({
          state: "reconciliation_required", accountFingerprint: null,
          weeklyWindowResetsAt: null, revision: 1,
        });
      }
      expect(() => migrated.requireAccountRateLimitResetPolicy(source.removed.id))
        .toThrow("ACCOUNT_RATE_LIMIT_RESET_POLICY_MISSING");
      expect(migrated.readRecoverableAccountRateLimitReset(source.signedIn.id, source.fingerprint))
        .toMatchObject(source.started);
      const refusal = canonicalAuthBudgetSnapshot(inspector);
      expect(() => migrated.prepareAccountRateLimitReset({
        profileId: source.signedIn.id, processGeneration: source.signedIn.processGeneration,
        accountFingerprint: source.fingerprint, weeklyWindowResetsAt: source.weeklyWindowResetsAt,
        observedUsedPercent: 99,
      })).toThrow("ACCOUNT_RATE_LIMIT_RESET_POLICY_NOT_ACTIVE");
      expect(canonicalAuthBudgetSnapshot(inspector)).toEqual(refusal);
      expect(inspector.query("SELECT * FROM migrations WHERE version<=27 ORDER BY version").all()).toEqual(ledger);
      expect(inspector.query("PRAGMA foreign_key_check").all()).toEqual([]);
      for (const readonly of [false, true]) {
        const snapshot = canonicalAuthBudgetSnapshot(inspector);
        const reopened = new StateStore(paths, { readonly, now: () => 40_001 });
        try {
          expect(reopened.readRecoverableAccountRateLimitReset(source.signedIn.id, source.fingerprint))
            .toMatchObject(source.started);
        } finally { reopened.close(); }
        expect(canonicalAuthBudgetSnapshot(inspector)).toEqual(snapshot);
      }

      // A later explicit identity change cannot reuse the old reset window.
      const replacementEmail = "legacy-policy-replacement@example.com";
      expect(migrated.setProfileState(source.signedIn.id, source.signedIn.processGeneration,
        "signed_in", { email: replacementEmail, plan: "Plus" })).toBe(true);
      expect(migrated.readRecoverableAccountRateLimitReset(source.signedIn.id, source.fingerprint))
        .toMatchObject(source.started);
      const replacementFingerprint = resetAccountFingerprint(replacementEmail);
      expect(migrated.authorizeAccountRateLimitResetPolicy({
        profileId: source.signedIn.id, processGeneration: source.signedIn.processGeneration,
        accountFingerprint: replacementFingerprint, weeklyWindowDurationMinutes: 10_080,
        weeklyWindowResetsAt: 500_100_000,
      })).toMatchObject({
        decision: "suppress", policy: { accountFingerprint: replacementFingerprint, state: "window_suppressed" },
      });
      expect(migrated.readRecoverableAccountRateLimitReset(source.signedIn.id, source.fingerprint)).toBeNull();
      expect(migrated.latestAccountRateLimitResetAttempt(source.signedIn.id, source.fingerprint)).toMatchObject({
        idempotencyKey: source.started.idempotencyKey, localResolution: "account_identity_changed",
        outcome: null, state: "closed",
      });
      expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: 61 });
      expect(inspector.query("SELECT COUNT(*) AS count FROM account_rate_limit_reset_attempts").get()).toEqual({ count: 1 });
    } finally { inspector.close(false); }
  });
test("reconciles an explicitly source-derived partial-v28 policy boundary stamped 27", async () => {
    const source = canonicalResetPolicyFixtures[28];
    const ledger = [...source.ledger].sort((a, b) => a.version - b.version);
    const paths = await canonicalResetPolicyArchive(28);
    const inspector = new Database(paths.database, { create: false, strict: true });
    try {
      expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: 28 });
      expect(inspector.query("SELECT * FROM migrations ORDER BY version").all()).toEqual(ledger);
      const original = canonicalAuthBudgetRows(inspector, ["profiles", "account_rate_limit_reset_attempts", "usage_revision_authority"]);
      const intact = canonicalAuthBudgetSnapshot(inspector);
      // An adversarial partial-stamp derivative, not a released v27 database
      // or an observed interrupted migration. Retain every authentic v28 data
      // cell and schema object, changing only its exact final ledger/stamp.
      inspector.transaction(() => {
        expect(inspector.query("DELETE FROM migrations WHERE version=28").run().changes).toBe(1);
        inspector.exec("PRAGMA user_version=27");
      }).immediate();
      const partial = canonicalAuthBudgetSnapshot(inspector);
      expect(partial.schema).toEqual(intact.schema);
      for (const [table, rows] of Object.entries(intact.rows)) {
        if (table !== "migrations") expect(partial.rows[table]).toEqual(rows);
      }
      expect(inspector.query("SELECT * FROM migrations ORDER BY version").all())
        .toEqual(ledger.filter((entry) => entry.version !== 28));
      expect(() => { const opened = new StateStore(paths, { readonly: true }); opened.close(); })
        .toThrow("STATE_SCHEMA_MIGRATION_REQUIRED:27:61");
      expect(canonicalAuthBudgetSnapshot(inspector)).toEqual(partial);

      const migrated = new StateStore(paths, { now: () => 40_000, resolveMachineTimeZone: () => "UTC" });
      stores.push(migrated);
      expect(original.read()).toEqual(original.before);
      expect(migrated.requireAccountRateLimitResetPolicy(source.signedIn.id)).toMatchObject({
        state: "reconciliation_required", accountFingerprint: null,
        weeklyWindowResetsAt: null, revision: source.policy.revision + 1,
      });
      expect(migrated.requireAccountRateLimitResetPolicy(source.signedOut.id)).toMatchObject({
        state: "reconciliation_required", accountFingerprint: null, weeklyWindowResetsAt: null, revision: 2,
      });
      expect(() => migrated.requireAccountRateLimitResetPolicy(source.removed.id))
        .toThrow("ACCOUNT_RATE_LIMIT_RESET_POLICY_MISSING");
      expect(migrated.readRecoverableAccountRateLimitReset(source.signedIn.id, source.fingerprint))
        .toMatchObject(source.started);
      expect(inspector.query("SELECT * FROM migrations WHERE version<=27 ORDER BY version").all())
        .toEqual(ledger.filter((entry) => entry.version !== 28));
      expect(inspector.query("SELECT * FROM migrations WHERE version=28").get()).toEqual({ version: 28, applied_at: 40_000 });
      expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: 61 });
      expect(inspector.query("PRAGMA foreign_key_check").all()).toEqual([]);
      for (const readonly of [false, true]) {
        const snapshot = canonicalAuthBudgetSnapshot(inspector);
        const reopened = new StateStore(paths, { readonly, now: () => 40_001 });
        try {
          expect(reopened.requireAccountRateLimitResetPolicy(source.signedIn.id))
            .toEqual(migrated.requireAccountRateLimitResetPolicy(source.signedIn.id));
        } finally { reopened.close(); }
        expect(canonicalAuthBudgetSnapshot(inspector)).toEqual(snapshot);
      }
    } finally { inspector.close(false); }
  });
test("persists reset-policy reconciliation until the suppressed boundary has elapsed", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "oompa-policy-boundary-")));
    const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
    await initializeStatePaths(paths);
    let now = 1_000;
    const store = new StateStore(paths, { now: () => now });
    stores.push(store);
    const firstEmail = "policy-first@example.com";
    const profile = signInProfile(store, "Policy transitions", firstEmail);
    const firstFingerprint = resetAccountFingerprint(firstEmail);
    const firstWindow = 10_000;
    const first = store.authorizeAccountRateLimitResetPolicy({
      profileId: profile.id,
      processGeneration: profile.processGeneration,
      accountFingerprint: firstFingerprint,
      weeklyWindowDurationMinutes: 10_080,
      weeklyWindowResetsAt: firstWindow,
    });
    expect(first).toMatchObject({ decision: "allow", policy: { state: "active_bound" } });
    expect(store.authorizeAccountRateLimitResetPolicy({
      profileId: profile.id,
      processGeneration: profile.processGeneration,
      accountFingerprint: firstFingerprint,
      weeklyWindowDurationMinutes: 10_080,
      weeklyWindowResetsAt: firstWindow - 1,
    })).toMatchObject({
      decision: "block",
      reason: "weekly_window_nonmonotonic",
      policy: { revision: first.policy.revision },
    });
    expect(store.authorizeAccountRateLimitResetPolicy({
      profileId: profile.id,
      processGeneration: profile.processGeneration,
      accountFingerprint: firstFingerprint,
      weeklyWindowDurationMinutes: 10_080,
      weeklyWindowResetsAt: firstWindow + 1_000,
    })).toMatchObject({
      decision: "allow",
      policy: { state: "active_bound", weeklyWindowResetsAt: firstWindow + 1_000 },
    });

    const secondEmail = "policy-second@example.com";
    expect(store.setProfileState(
      profile.id,
      profile.processGeneration,
      "signed_in",
      { email: secondEmail, plan: "Plus" },
    )).toBe(true);
    expect(store.requireAccountRateLimitResetPolicy(profile.id)).toMatchObject({
      state: "reconciliation_required",
      accountFingerprint: null,
      weeklyWindowResetsAt: null,
    });
    const secondFingerprint = resetAccountFingerprint(secondEmail);
    const suppressedWindow = 20_000;
    const suppressed = store.authorizeAccountRateLimitResetPolicy({
      profileId: profile.id,
      processGeneration: profile.processGeneration,
      accountFingerprint: secondFingerprint,
      weeklyWindowDurationMinutes: 10_080,
      weeklyWindowResetsAt: suppressedWindow,
    });
    expect(suppressed).toMatchObject({
      decision: "suppress",
      reason: "reconciliation_window",
      policy: { state: "window_suppressed" },
    });
    store.nextDaemonGeneration(`boot_${"w".repeat(32)}`);
    const restarted = store.requireProfileById(profile.id);
    expect(store.authorizeAccountRateLimitResetPolicy({
      profileId: profile.id,
      processGeneration: restarted.processGeneration,
      accountFingerprint: secondFingerprint,
      weeklyWindowDurationMinutes: 10_080,
      weeklyWindowResetsAt: suppressedWindow,
    })).toMatchObject({
      decision: "suppress",
      policy: { revision: suppressed.policy.revision },
    });
    expect(store.authorizeAccountRateLimitResetPolicy({
      profileId: profile.id,
      processGeneration: restarted.processGeneration,
      accountFingerprint: secondFingerprint,
      weeklyWindowDurationMinutes: 10_080,
      weeklyWindowResetsAt: suppressedWindow - 1_000,
    })).toMatchObject({
      decision: "block",
      reason: "weekly_window_nonmonotonic",
      policy: { revision: suppressed.policy.revision },
    });
    expect(store.authorizeAccountRateLimitResetPolicy({
      profileId: profile.id,
      processGeneration: restarted.processGeneration,
      accountFingerprint: secondFingerprint,
      weeklyWindowDurationMinutes: 10_080,
      weeklyWindowResetsAt: suppressedWindow + 1_000,
    })).toMatchObject({
      decision: "block",
      reason: "weekly_window_nonmonotonic",
      policy: { revision: suppressed.policy.revision },
    });
    now = suppressedWindow - 1;
    expect(store.authorizeAccountRateLimitResetPolicy({
      profileId: profile.id,
      processGeneration: restarted.processGeneration,
      accountFingerprint: secondFingerprint,
      weeklyWindowDurationMinutes: 10_080,
      weeklyWindowResetsAt: suppressedWindow,
    })).toMatchObject({
      decision: "suppress",
      policy: { revision: suppressed.policy.revision },
    });
    expect(store.authorizeAccountRateLimitResetPolicy({
      profileId: profile.id,
      processGeneration: restarted.processGeneration,
      accountFingerprint: secondFingerprint,
      weeklyWindowDurationMinutes: 10_080,
      weeklyWindowResetsAt: suppressedWindow + 1_000,
    })).toMatchObject({
      decision: "block",
      reason: "weekly_window_nonmonotonic",
      policy: { revision: suppressed.policy.revision },
    });
    now = suppressedWindow;
    const activated = store.authorizeAccountRateLimitResetPolicy({
      profileId: profile.id,
      processGeneration: restarted.processGeneration,
      accountFingerprint: secondFingerprint,
      weeklyWindowDurationMinutes: 10_080,
      weeklyWindowResetsAt: suppressedWindow + 1_000,
    });
    expect(activated).toMatchObject({
      decision: "allow",
      policy: { state: "active_bound", weeklyWindowResetsAt: suppressedWindow + 1_000 },
    });
    expect(store.authorizeAccountRateLimitResetPolicy({
      profileId: profile.id,
      processGeneration: restarted.processGeneration,
      accountFingerprint: secondFingerprint,
      weeklyWindowDurationMinutes: 10_080,
      weeklyWindowResetsAt: suppressedWindow + 2_000,
    })).toMatchObject({
      decision: "allow",
      policy: { state: "active_bound", weeklyWindowResetsAt: suppressedWindow + 2_000 },
    });

    const thirdEmail = "policy-third@example.com";
    expect(store.setProfileState(
      profile.id,
      restarted.processGeneration,
      "signed_in",
      { email: thirdEmail, plan: "Plus" },
    )).toBe(true);
    expect(store.requireAccountRateLimitResetPolicy(profile.id)).toMatchObject({
      state: "reconciliation_required",
      accountFingerprint: null,
      weeklyWindowResetsAt: null,
    });
    const thirdFingerprint = resetAccountFingerprint(thirdEmail);
    const pending = store.authorizeAccountRateLimitResetPolicy({
      profileId: profile.id,
      processGeneration: restarted.processGeneration,
      accountFingerprint: thirdFingerprint,
      weeklyWindowDurationMinutes: 300,
      weeklyWindowResetsAt: suppressedWindow + 3_000,
    });
    expect(pending).toMatchObject({
      decision: "block",
      reason: "weekly_window_unavailable",
      policy: { state: "reconciliation_required" },
    });
    expect(store.authorizeAccountRateLimitResetPolicy({
      profileId: profile.id,
      processGeneration: restarted.processGeneration,
      accountFingerprint: thirdFingerprint,
      weeklyWindowDurationMinutes: 300,
      weeklyWindowResetsAt: suppressedWindow + 3_000,
    })).toMatchObject({
      decision: "block",
      reason: "weekly_window_unavailable",
      policy: { revision: pending.policy.revision, state: "reconciliation_required" },
    });
  });
test("re-pends bound identity drift and closes every old-identity recoverable state", async () => {
    const { store } = await fixture();
    const recoverableStates = [
      "prepared",
      "retryable",
      "ambiguous",
      "effect_started",
    ] as const;

    for (const [index, recoverableState] of recoverableStates.entries()) {
      const firstEmail = `identity-${recoverableState}@example.com`;
      const profile = signInProfile(
        store,
        `Identity ${recoverableState}`,
        firstEmail,
      );
      expect(store.requireAccountRateLimitResetPolicy(profile.id)).toMatchObject({
        state: "active_unbound",
        accountFingerprint: null,
      });
      const firstFingerprint = resetAccountFingerprint(firstEmail);
      const prepared = prepareAuthorizedReset(store, {
        profileId: profile.id,
        processGeneration: profile.processGeneration,
        accountFingerprint: firstFingerprint,
        weeklyWindowResetsAt: 500_000_000 + index,
        observedUsedPercent: 99,
      });
      if (recoverableState !== "prepared") {
        beginAuthorizedReset(store, prepared);
      }
      if (recoverableState === "retryable" || recoverableState === "ambiguous") {
        store.deferAccountRateLimitReset(prepared.idempotencyKey, recoverableState);
      }
      const policyBeforeDrift = store.requireAccountRateLimitResetPolicy(profile.id);
      const secondEmail = `replacement-${recoverableState}@example.com`;
      expect(store.setProfileState(
        profile.id,
        profile.processGeneration,
        "signed_in",
        { email: secondEmail, plan: "Plus" },
      )).toBe(true);

      expect(store.requireAccountRateLimitResetPolicy(profile.id)).toMatchObject({
        state: "reconciliation_required",
        accountFingerprint: null,
        weeklyWindowResetsAt: null,
        revision: policyBeforeDrift.revision + 1,
      });
      expect(store.latestAccountRateLimitResetAttempt(profile.id, firstFingerprint))
        .toMatchObject({
          idempotencyKey: prepared.idempotencyKey,
          localResolution: "account_identity_changed",
          outcome: null,
          state: "closed",
        });
      expect(store.readRecoverableAccountRateLimitReset(profile.id, firstFingerprint))
        .toBeNull();

      const secondFingerprint = resetAccountFingerprint(secondEmail);
      expect(store.authorizeAccountRateLimitResetPolicy({
        profileId: profile.id,
        processGeneration: profile.processGeneration,
        accountFingerprint: secondFingerprint,
        weeklyWindowDurationMinutes: 10_080,
        weeklyWindowResetsAt: 500_100_000 + index,
      })).toMatchObject({
        decision: "suppress",
        reason: "reconciliation_window",
        policy: {
          accountFingerprint: secondFingerprint,
          state: "window_suppressed",
        },
      });
    }
  });
test("refuses to reopen a current database with missing reset policy authority", async () => {
    const { store } = await fixture();
    const profile = store.createProfile("Missing reset policy");
    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const damaged = new Database(paths.database, { create: false, strict: true });
    try {
      withRemovedTestGuards(damaged, ["account_rate_limit_reset_policy_delete_guard"], () => {
        damaged.query("DELETE FROM account_rate_limit_reset_policies WHERE profile_id=?").run(profile.id);
      });
    } finally {
      damaged.close(false);
    }
    expect(() => new StateStore(paths))
      .toThrow("STATE_ACCOUNT_RATE_LIMIT_RESET_POLICY_MISSING");
  });
test("readonly open rejects a stale same-name reset-policy guard", async () => {
    const { store } = await fixture({ provision: "migrate" });
    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const damaged = new Database(paths.database, { create: false, strict: true });
    try {
      damaged.exec(`
        DROP TRIGGER account_rate_limit_reset_policy_transition_guard;
        CREATE TRIGGER account_rate_limit_reset_policy_transition_guard
        BEFORE UPDATE ON account_rate_limit_reset_policies
        BEGIN SELECT 1; END;
      `);
    } finally {
      damaged.close(false);
    }

    expect(() => new StateStore(paths, { readonly: true }))
      .toThrow("STATE_SCHEMA_V28_STRUCTURE_INVALID");
  });
test("readonly open rejects a weakened same-name reset-policy table", async () => {
    const { store } = await fixture({ provision: "migrate" });
    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const damaged = new Database(paths.database, { create: false, strict: true });
    try {
      const pristine = snapshotSwitchContainmentForTest(damaged);
      const triggers = damaged.query(
        `SELECT name,sql FROM sqlite_master
         WHERE type='trigger' AND (
           name LIKE 'account_rate_limit_reset_policy_%'
           OR name='account_rate_limit_reset_attempt_transition_guard'
           OR name LIKE 'account_rate_limit_reset_attempt_policy_%'
           OR name IN (
             'account_rate_limit_reset_rebind_policy_guard',
             'account_rate_limit_reset_rebind_insert_guard'
           )
         ) ORDER BY name`,
      ).all().map((row) => z.object({ name: z.string(), sql: z.string() })
        .strict().parse(row));
      for (const trigger of triggers) {
        damaged.exec(`DROP TRIGGER ${trigger.name}`);
      }
      damaged.exec(`
        PRAGMA foreign_keys=OFF;
        PRAGMA legacy_alter_table=ON;
        BEGIN IMMEDIATE;
        ALTER TABLE account_rate_limit_reset_policies
          RENAME TO account_rate_limit_reset_policies_strict;
        CREATE TABLE account_rate_limit_reset_policies (
          profile_id TEXT PRIMARY KEY,
          state TEXT NOT NULL,
          account_fingerprint TEXT,
          weekly_window_resets_at INTEGER,
          revision INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        INSERT INTO account_rate_limit_reset_policies
          SELECT * FROM account_rate_limit_reset_policies_strict;
        DROP TABLE account_rate_limit_reset_policies_strict;
        COMMIT;
        PRAGMA legacy_alter_table=OFF;
      `);
      for (const trigger of triggers) damaged.exec(trigger.sql);
      const corrupted = snapshotSwitchContainmentForTest(damaged);
      const unrelatedSchema = (schema: typeof pristine.schema) => schema.filter((row) =>
        z.object({ name: z.string() }).parse(row).name !== "account_rate_limit_reset_policies");
      expect(unrelatedSchema(corrupted.schema)).toEqual(unrelatedSchema(pristine.schema));
      expect(corrupted.version).toEqual(pristine.version);
      expect(corrupted.rows).toEqual(pristine.rows);
      expect(() => new StateStore(paths, { readonly: true }))
        .toThrow("STATE_SCHEMA_V28_STRUCTURE_INVALID");
      expect(snapshotSwitchContainmentForTest(damaged)).toEqual(corrupted);
    } finally {
      damaged.close(false);
    }
  });
test("readonly open rejects a corrupt reset-policy row under exact guards", async () => {
    const { store } = await fixture();
    const profile = store.createProfile("Corrupt reset policy");
    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const damaged = new Database(paths.database, { create: false, strict: true });
    try {
      const transition = z.object({ sql: z.string() }).strict().parse(
        damaged.query(
          `SELECT sql FROM sqlite_master
           WHERE type='trigger'
             AND name='account_rate_limit_reset_policy_transition_guard'`,
        ).get(),
      ).sql;
      damaged.exec(`
        DROP TRIGGER account_rate_limit_reset_policy_transition_guard;
        PRAGMA ignore_check_constraints=ON;
      `);
      damaged.query(
        `UPDATE account_rate_limit_reset_policies
         SET state='active_bound',account_fingerprint=NULL,
           weekly_window_resets_at=NULL,revision=revision+1
         WHERE profile_id=?`,
      ).run(profile.id);
      damaged.exec(transition);
      damaged.exec("PRAGMA ignore_check_constraints=OFF");
    } finally {
      damaged.close(false);
    }

    expect(() => new StateStore(paths, { readonly: true }))
      .toThrow("STATE_ACCOUNT_RATE_LIMIT_RESET_POLICY_INVALID");
  });
test("readonly open rejects reset policy authority outside the live profile set", async () => {
    const { store } = await fixture();
    const profile = store.createProfile("Orphan reset policy");
    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const damaged = new Database(paths.database, { create: false, strict: true });
    try {
      expect(damaged.query(
        "UPDATE profiles SET state='removed' WHERE id=?",
      ).run(profile.id).changes).toBe(1);
    } finally {
      damaged.close(false);
    }

    expect(() => new StateStore(paths, { readonly: true }))
      .toThrow("STATE_ACCOUNT_RATE_LIMIT_RESET_POLICY_ORPHANED");
  });
test("journals automatic weekly reset redemption and retries only the same indeterminate key", async () => {
    const { store } = await fixture();
    const email = "reset@example.com";
    const profile = signInProfile(store, "Reset journal", email);
    const input = {
      profileId: profile.id,
      processGeneration: profile.processGeneration,
      accountFingerprint: resetAccountFingerprint(email),
      weeklyWindowResetsAt: 500_000_000,
      observedUsedPercent: 99,
    };
    const prepared = prepareAuthorizedReset(store, input);
    expect(prepared).toMatchObject({
      profileId: input.profileId,
      originProcessGeneration: input.processGeneration,
      currentProcessGeneration: input.processGeneration,
      accountFingerprint: input.accountFingerprint,
      weeklyWindowResetsAt: input.weeklyWindowResetsAt,
      observedUsedPercent: input.observedUsedPercent,
      outcome: null,
      localResolution: null,
      state: "prepared",
    });
    expect(store.prepareAccountRateLimitReset({
      ...input,
      observedUsedPercent: 99.8,
    }).idempotencyKey).toBe(prepared.idempotencyKey);

    const wrongProfile = signInProfile(store, "Wrong reset authority", "wrong-reset@example.com");
    expect(() => store.beginAccountRateLimitReset(
      prepared.idempotencyKey,
      store.requireProviderAccountAuthority(wrongProfile.id, "codex"),
    )).toThrow("ACCOUNT_RATE_LIMIT_RESET_PROVIDER_AUTHORITY_MISMATCH");
    expect(store.latestAccountRateLimitResetAttempt(
      profile.id,
      input.accountFingerprint,
    )).toMatchObject({ state: "prepared" });
    expect(beginAuthorizedReset(store, prepared).state)
      .toBe("effect_started");
    expect(store.deferAccountRateLimitReset(prepared.idempotencyKey, "ambiguous").state)
      .toBe("ambiguous");
    expect(() => store.closeAccountRateLimitReset(
      prepared.idempotencyKey,
      "weekly_window_changed",
    )).toThrow("ACCOUNT_RATE_LIMIT_RESET_CLOSE_RESOLUTION_INVALID");
    expect(store.readRecoverableAccountRateLimitReset(
      profile.id,
      input.accountFingerprint,
    )?.idempotencyKey).toBe(prepared.idempotencyKey);
    expect(beginAuthorizedReset(store, prepared)).toMatchObject({
      idempotencyKey: prepared.idempotencyKey,
      state: "effect_started",
    });
    expect(store.deferAccountRateLimitReset(prepared.idempotencyKey, "ambiguous"))
      .toMatchObject({ idempotencyKey: prepared.idempotencyKey, state: "ambiguous" });
    expect(store.latestAccountRateLimitResetAttempt(
      profile.id,
      input.accountFingerprint,
    )).toMatchObject({
      idempotencyKey: prepared.idempotencyKey,
      state: "ambiguous",
      outcome: null,
    });
    expect(store.latestAccountRateLimitResetAttempt(
      profile.id,
      resetAccountFingerprint("someone-else@example.com"),
    )).toBeNull();

    expect(store.prepareAccountRateLimitReset({
      ...input,
      observedUsedPercent: 100,
    }).idempotencyKey).toBe(prepared.idempotencyKey);
    expect(store.readRecoverableAccountRateLimitReset(
      profile.id,
      input.accountFingerprint,
    )).toMatchObject({ idempotencyKey: prepared.idempotencyKey, state: "ambiguous" });
  });
test("enforces reset-policy dispatch and ambiguous-effect guards in SQLite", async () => {
    const { store } = await fixture();
    const firstEmail = "raw-policy@example.com";
    const first = signInProfile(store, "Raw policy guard", firstEmail);
    const firstFingerprint = resetAccountFingerprint(firstEmail);
    const prepared = prepareAuthorizedReset(store, {
      profileId: first.id,
      processGeneration: first.processGeneration,
      accountFingerprint: firstFingerprint,
      weeklyWindowResetsAt: 500_000_000,
      observedUsedPercent: 99,
    });
    const changedEmail = "raw-policy-changed@example.com";
    expect(store.setProfileState(
      first.id,
      first.processGeneration,
      "signed_in",
      { email: changedEmail, plan: "Plus" },
    )).toBe(true);
    expect(store.latestAccountRateLimitResetAttempt(first.id, firstFingerprint))
      .toMatchObject({ idempotencyKey: prepared.idempotencyKey, state: "closed" });
    expect(store.authorizeAccountRateLimitResetPolicy({
      profileId: first.id,
      processGeneration: first.processGeneration,
      accountFingerprint: resetAccountFingerprint(changedEmail),
      weeklyWindowDurationMinutes: null,
      weeklyWindowResetsAt: null,
    })).toMatchObject({
      decision: "block",
      reason: "weekly_window_unavailable",
      policy: { state: "reconciliation_required" },
    });

    const secondEmail = "raw-ambiguous@example.com";
    const second = signInProfile(store, "Raw ambiguous guard", secondEmail);
    const secondFingerprint = resetAccountFingerprint(secondEmail);
    const ambiguous = prepareAuthorizedReset(store, {
      profileId: second.id,
      processGeneration: second.processGeneration,
      accountFingerprint: secondFingerprint,
      weeklyWindowResetsAt: 500_000_000,
      observedUsedPercent: 99,
    });
    beginAuthorizedReset(store, ambiguous);
    store.deferAccountRateLimitReset(ambiguous.idempotencyKey, "ambiguous");

    const inspector = new Database(store.paths.database, { create: false, strict: true });
    try {
      expect(() => inspector.query(
        `UPDATE account_rate_limit_reset_attempts
         SET state='closed',local_resolution='weekly_window_changed'
         WHERE idempotency_key=?`,
      ).run(ambiguous.idempotencyKey))
        .toThrow("illegal account rate-limit reset transition");
      inspector.query(
        `UPDATE account_rate_limit_reset_policies
         SET state='reconciliation_required',account_fingerprint=NULL,
           weekly_window_resets_at=NULL,revision=revision+1,
           updated_at=MAX(updated_at,?)
         WHERE profile_id=?`,
      ).run(2_000, second.id);
      expect(() => inspector.query(
        `INSERT INTO account_rate_limit_reset_attempts(
           idempotency_key,profile_id,origin_process_generation,
           current_process_generation,account_fingerprint,weekly_window_resets_at,
           observed_used_percent,state,created_at,updated_at
         ) VALUES (?,?,?,?,?,?,?,'prepared',?,?)`,
      ).run(
        "00000000-0000-4000-8000-000000000028",
        first.id,
        first.processGeneration,
        first.processGeneration,
        resetAccountFingerprint(changedEmail),
        500_000_001,
        99,
        2_000,
        2_000,
      )).toThrow("policy does not authorize preparation");
      expect(() => inspector.query(
        `UPDATE account_rate_limit_reset_attempts
         SET state='effect_started' WHERE idempotency_key=?`,
      ).run(ambiguous.idempotencyKey))
        .toThrow("policy does not authorize dispatch");
      expect(() => inspector.query(
        `INSERT INTO account_rate_limit_reset_rebinds(
           idempotency_key,from_process_generation,to_process_generation,
           account_fingerprint,created_at
         ) VALUES (?,?,?,?,?)`,
      ).run(
        ambiguous.idempotencyKey,
        ambiguous.currentProcessGeneration,
        ambiguous.currentProcessGeneration + 1,
        secondFingerprint,
        2_000,
      )).toThrow("policy does not authorize rebind");
    } finally {
      inspector.close(false);
    }
  });
test("refuses to begin a reset after its authorized window expires", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "oompa-reset-expired-begin-")));
    const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
    await initializeStatePaths(paths);
    let now = 1_000;
    const store = new StateStore(paths, { now: () => now });
    stores.push(store);
    const email = "expired-begin@example.com";
    const profile = signInProfile(store, "Expired reset begin", email);
    const prepared = prepareAuthorizedReset(store, {
      profileId: profile.id,
      processGeneration: profile.processGeneration,
      accountFingerprint: resetAccountFingerprint(email),
      weeklyWindowResetsAt: 5_000,
      observedUsedPercent: 99,
    });

    now = prepared.weeklyWindowResetsAt;
    expect(() => beginAuthorizedReset(store, prepared))
      .toThrow("ACCOUNT_RATE_LIMIT_RESET_WINDOW_NOT_FRESH");
    expect(store.readRecoverableAccountRateLimitReset(
      profile.id,
      prepared.accountFingerprint,
    )).toMatchObject({ idempotencyKey: prepared.idempotencyKey, state: "prepared" });
  });
test("orders the most recent reset attempt by a durable sequence across clock rollback and vacuum", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "oompa-reset-sequence-")));
    const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
    await initializeStatePaths(paths);
    let now = 10_000;
    const store = new StateStore(paths, { now: () => now });
    stores.push(store);
    const email = "ordered-reset@example.com";
    const profile = signInProfile(store, "Ordered reset", email);
    const accountFingerprint = resetAccountFingerprint(email);
    const first = prepareAuthorizedReset(store, {
      profileId: profile.id,
      processGeneration: profile.processGeneration,
      accountFingerprint,
      weeklyWindowResetsAt: 500_000_000,
      observedUsedPercent: 99,
    });
    beginAuthorizedReset(store, first);
    store.settleAccountRateLimitReset(first.idempotencyKey, "reset");

    now = 9_000;
    const second = prepareAuthorizedReset(store, {
      profileId: profile.id,
      processGeneration: profile.processGeneration,
      accountFingerprint,
      weeklyWindowResetsAt: 500_100_000,
      observedUsedPercent: 99,
    });
    expect(second.attemptSequence).toBeGreaterThan(first.attemptSequence);
    expect(second.createdAt).toBeLessThan(first.createdAt);
    expect(store.latestAccountRateLimitResetAttempt(profile.id, accountFingerprint))
      .toMatchObject({
        attemptSequence: second.attemptSequence,
        idempotencyKey: second.idempotencyKey,
        state: "prepared",
        weeklyWindowResetsAt: second.weeklyWindowResetsAt,
      });

    store.close();
    stores.splice(stores.indexOf(store), 1);
    const maintenance = new Database(paths.database, { create: false, strict: true });
    try {
      maintenance.exec("VACUUM");
    } finally {
      maintenance.close(false);
    }
    const reopened = new StateStore(paths);
    stores.push(reopened);
    expect(reopened.latestAccountRateLimitResetAttempt(profile.id, accountFingerprint))
      .toMatchObject({
        attemptSequence: second.attemptSequence,
        idempotencyKey: second.idempotencyKey,
        state: "prepared",
      });
  });
test("retries a known no-op only after the weekly percentage advances", async () => {
    const { store } = await fixture();
    const email = "noop@example.com";
    const profile = signInProfile(store, "Reset no-op", email);
    const base = {
      profileId: profile.id,
      processGeneration: profile.processGeneration,
      accountFingerprint: resetAccountFingerprint(email),
      weeklyWindowResetsAt: 500_000_000,
    };
    const first = prepareAuthorizedReset(store, {
      ...base,
      observedUsedPercent: 99,
    });
    beginAuthorizedReset(store, first);
    store.settleAccountRateLimitReset(first.idempotencyKey, "nothingToReset");
    expect(store.prepareAccountRateLimitReset({
      ...base,
      observedUsedPercent: 99.9,
    }).idempotencyKey).toBe(first.idempotencyKey);
    const finalPercent = store.prepareAccountRateLimitReset({
      ...base,
      observedUsedPercent: 100,
    });
    expect(finalPercent.idempotencyKey).not.toBe(first.idempotencyKey);
    expect(finalPercent.state).toBe("prepared");
  });
test("recovers effect-adjacent reset attempts without changing account state", async () => {
    const { store } = await fixture();
    const email = "recovery@example.com";
    const profile = signInProfile(store, "Reset recovery", email);
    const accountFingerprint = resetAccountFingerprint(email);
    const prepared = prepareAuthorizedReset(store, {
      profileId: profile.id,
      processGeneration: profile.processGeneration,
      accountFingerprint,
      weeklyWindowResetsAt: 500_000_000,
      observedUsedPercent: 99,
    });
    beginAuthorizedReset(store, prepared);
    expect(store.recoverAccountRateLimitResetAttempts({
      profileId: profile.id,
      processGeneration: profile.processGeneration,
      accountFingerprint,
      weeklyWindowResetsAt: prepared.weeklyWindowResetsAt,
    }))
      .toEqual([prepared.idempotencyKey]);
    expect(store.readRecoverableAccountRateLimitReset(
      profile.id,
      accountFingerprint,
    )).toMatchObject({
      idempotencyKey: prepared.idempotencyKey,
      state: "ambiguous",
    });
    expect(store.requireProfileById(profile.id).state).toBe("signed_in");
  });
test("rebinds and retries an ambiguous key only after a later policy window activates", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "oompa-reset-later-recovery-")));
    const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
    await initializeStatePaths(paths);
    let now = 1_000;
    const store = new StateStore(paths, { now: () => now });
    stores.push(store);
    const email = "restart-reset@example.com";
    const profile = signInProfile(store, "Reset restart", email);
    const accountFingerprint = resetAccountFingerprint(email);
    const firstWindow = 10_000;
    const prepared = prepareAuthorizedReset(store, {
      profileId: profile.id,
      processGeneration: profile.processGeneration,
      accountFingerprint,
      weeklyWindowResetsAt: firstWindow,
      observedUsedPercent: 99,
    });
    beginAuthorizedReset(store, prepared);
    store.recoverAccountRateLimitResetAttempts({
      profileId: profile.id,
      processGeneration: profile.processGeneration,
      accountFingerprint,
      weeklyWindowResetsAt: prepared.weeklyWindowResetsAt,
    });

    const migration = new Database(store.paths.database, { create: false, strict: true });
    try {
      migration.query(
        `UPDATE account_rate_limit_reset_policies
         SET state='reconciliation_required',account_fingerprint=NULL,
           weekly_window_resets_at=NULL,revision=revision+1,
           updated_at=MAX(updated_at,?)
         WHERE profile_id=?`,
      ).run(now, profile.id);
    } finally {
      migration.close(false);
    }
    expect(store.authorizeAccountRateLimitResetPolicy({
      profileId: profile.id,
      processGeneration: profile.processGeneration,
      accountFingerprint,
      weeklyWindowDurationMinutes: 10_080,
      weeklyWindowResetsAt: firstWindow,
    })).toMatchObject({ decision: "suppress", policy: { state: "window_suppressed" } });
    expect(() => beginAuthorizedReset(store, prepared))
      .toThrow("ACCOUNT_RATE_LIMIT_RESET_POLICY_NOT_ACTIVE");
    store.nextDaemonGeneration(`boot_${"r".repeat(32)}`);
    const restarted = store.requireProfileById(profile.id);

    const recoverable = store.readRecoverableAccountRateLimitReset(
      profile.id,
      accountFingerprint,
    );
    expect(recoverable).toMatchObject({
      idempotencyKey: prepared.idempotencyKey,
      originProcessGeneration: profile.processGeneration,
      currentProcessGeneration: profile.processGeneration,
      state: "ambiguous",
    });
    expect(() => store.rebindAccountRateLimitReset({
      idempotencyKey: prepared.idempotencyKey,
      expectedCurrentProcessGeneration: profile.processGeneration,
      nextProcessGeneration: restarted.processGeneration,
      accountFingerprint,
    })).toThrow("ACCOUNT_RATE_LIMIT_RESET_POLICY_NOT_ACTIVE");
    expect(store.listAccountRateLimitResetRebinds(prepared.idempotencyKey)).toEqual([]);
    now = firstWindow;
    const laterWindow = 20_000;
    expect(store.authorizeAccountRateLimitResetPolicy({
      profileId: profile.id,
      processGeneration: restarted.processGeneration,
      accountFingerprint,
      weeklyWindowDurationMinutes: 10_080,
      weeklyWindowResetsAt: laterWindow,
    })).toMatchObject({
      decision: "allow",
      policy: { state: "active_bound", weeklyWindowResetsAt: laterWindow },
    });
    expect(store.rebindAccountRateLimitReset({
      idempotencyKey: prepared.idempotencyKey,
      expectedCurrentProcessGeneration: profile.processGeneration,
      nextProcessGeneration: restarted.processGeneration,
      accountFingerprint,
    })).toMatchObject({
      idempotencyKey: prepared.idempotencyKey,
      state: "ambiguous",
      weeklyWindowResetsAt: firstWindow,
    });
    expect(beginAuthorizedReset(store, prepared)).toMatchObject({
      idempotencyKey: prepared.idempotencyKey,
      state: "effect_started",
      weeklyWindowResetsAt: firstWindow,
    });
    expect(store.listAccountRateLimitResetRebinds(prepared.idempotencyKey))
      .toHaveLength(1);
  });
test("keeps prepared and retryable attempts bound to their exact active window", async () => {
    const { store } = await fixture();
    const attempts: Array<{
      accountFingerprint: string;
      idempotencyKey: string;
      profileId: ReturnType<typeof signInProfile>["id"];
      processGeneration: number;
    }> = [];
    for (const [index, state] of (["prepared", "retryable"] as const).entries()) {
      const email = `exact-window-${state}@example.com`;
      const profile = signInProfile(store, `Exact window ${state}`, email);
      const accountFingerprint = resetAccountFingerprint(email);
      const weeklyWindowResetsAt = 500_000_000 + index * 10_000;
      const prepared = prepareAuthorizedReset(store, {
        profileId: profile.id,
        processGeneration: profile.processGeneration,
        accountFingerprint,
        weeklyWindowResetsAt,
        observedUsedPercent: 99,
      });
      if (state === "retryable") {
        beginAuthorizedReset(store, prepared);
        store.deferAccountRateLimitReset(prepared.idempotencyKey, "retryable");
      }
      expect(store.authorizeAccountRateLimitResetPolicy({
        profileId: profile.id,
        processGeneration: profile.processGeneration,
        accountFingerprint,
        weeklyWindowDurationMinutes: 10_080,
        weeklyWindowResetsAt: weeklyWindowResetsAt + 1_000,
      })).toMatchObject({ decision: "allow", policy: { state: "active_bound" } });
      expect(() => beginAuthorizedReset(store, prepared))
        .toThrow("ACCOUNT_RATE_LIMIT_RESET_POLICY_NOT_ACTIVE");
      attempts.push({
        accountFingerprint,
        idempotencyKey: prepared.idempotencyKey,
        profileId: profile.id,
        processGeneration: profile.processGeneration,
      });
    }

    store.nextDaemonGeneration(`boot_${"e".repeat(32)}`);
    for (const attempt of attempts) {
      const restarted = store.requireProfileById(attempt.profileId);
      expect(() => store.rebindAccountRateLimitReset({
        idempotencyKey: attempt.idempotencyKey,
        expectedCurrentProcessGeneration: attempt.processGeneration,
        nextProcessGeneration: restarted.processGeneration,
        accountFingerprint: attempt.accountFingerprint,
      })).toThrow("ACCOUNT_RATE_LIMIT_RESET_POLICY_NOT_ACTIVE");
    }
  });
test("cascades rebind evidence when expired parent history is pruned", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "oompa-reset-rebind-prune-")));
    const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
    await initializeStatePaths(paths);
    let now = 1_000;
    const store = new StateStore(paths, { now: () => now++ });
    stores.push(store);
    const email = "pruned-rebind-reset@example.com";
    const profile = signInProfile(store, "Reset rebind prune", email);
    const accountFingerprint = resetAccountFingerprint(email);
    const expiringWindowResetsAt = 500_000;
    const prepared = prepareAuthorizedReset(store, {
      profileId: profile.id,
      processGeneration: profile.processGeneration,
      accountFingerprint,
      weeklyWindowResetsAt: expiringWindowResetsAt,
      observedUsedPercent: 99,
    });
    store.nextDaemonGeneration(`boot_${"p".repeat(32)}`);
    const restarted = store.requireProfileById(profile.id);
    store.rebindAccountRateLimitReset({
      idempotencyKey: prepared.idempotencyKey,
      expectedCurrentProcessGeneration: profile.processGeneration,
      nextProcessGeneration: restarted.processGeneration,
      accountFingerprint,
    });
    beginAuthorizedReset(store, prepared);
    store.settleAccountRateLimitReset(prepared.idempotencyKey, "reset");
    expect(store.listAccountRateLimitResetRebinds(prepared.idempotencyKey))
      .toHaveLength(1);

    for (let index = 0; index < 129; index += 1) {
      const historical = prepareAuthorizedReset(store, {
        profileId: restarted.id,
        processGeneration: restarted.processGeneration,
        accountFingerprint,
        weeklyWindowResetsAt: expiringWindowResetsAt + index + 1,
        observedUsedPercent: 99,
      });
      beginAuthorizedReset(store, historical);
      store.settleAccountRateLimitReset(historical.idempotencyKey, "noCredit");
    }
    now = 1_000_000;
    prepareAuthorizedReset(store, {
      profileId: restarted.id,
      processGeneration: restarted.processGeneration,
      accountFingerprint,
      weeklyWindowResetsAt: 1_500_000,
      observedUsedPercent: 99,
    });

    const inspector = new Database(store.paths.database, { create: false, strict: true });
    try {
      expect(inspector.query(
        "SELECT 1 FROM account_rate_limit_reset_attempts WHERE idempotency_key=?",
      ).get(prepared.idempotencyKey)).toBeNull();
      expect(inspector.query(
        "SELECT 1 FROM account_rate_limit_reset_rebinds WHERE idempotency_key=?",
      ).get(prepared.idempotencyKey)).toBeNull();
    } finally {
      inspector.close(false);
    }
  });
test("keeps a successful weekly-window latch across daemon generations", async () => {
    const { store } = await fixture();
    const email = "latched-reset@example.com";
    const profile = signInProfile(store, "Reset latch", email);
    const accountFingerprint = resetAccountFingerprint(email);
    const input = {
      profileId: profile.id,
      processGeneration: profile.processGeneration,
      accountFingerprint,
      weeklyWindowResetsAt: 500_000_000,
      observedUsedPercent: 99,
    };
    const prepared = prepareAuthorizedReset(store, input);
    beginAuthorizedReset(store, prepared);
    store.settleAccountRateLimitReset(prepared.idempotencyKey, "reset");
    store.nextDaemonGeneration(`boot_${"s".repeat(32)}`);
    const restarted = store.requireProfileById(profile.id);

    expect(store.prepareAccountRateLimitReset({
      ...input,
      processGeneration: restarted.processGeneration,
      observedUsedPercent: 100,
    })).toMatchObject({
      idempotencyKey: prepared.idempotencyKey,
      originProcessGeneration: profile.processGeneration,
      outcome: "reset",
      state: "settled",
    });
  });
test("keeps terminal reset evidence immutable", async () => {
    const { store } = await fixture();
    const email = "immutable-reset@example.com";
    const profile = signInProfile(store, "Reset evidence", email);
    const base = {
      profileId: profile.id,
      processGeneration: profile.processGeneration,
      accountFingerprint: resetAccountFingerprint(email),
      observedUsedPercent: 99,
    };
    const settled = prepareAuthorizedReset(store, {
      ...base,
      weeklyWindowResetsAt: 500_000_000,
    });
    beginAuthorizedReset(store, settled);
    store.settleAccountRateLimitReset(settled.idempotencyKey, "reset");
    const closed = prepareAuthorizedReset(store, {
      ...base,
      weeklyWindowResetsAt: 500_001_000,
    });
    store.closeAccountRateLimitReset(closed.idempotencyKey, "weekly_window_changed");

    const inspector = new Database(store.paths.database, { create: false, strict: true });
    try {
      expect(() => inspector.query(
        "UPDATE account_rate_limit_reset_attempts SET outcome='noCredit' WHERE idempotency_key=?",
      ).run(settled.idempotencyKey)).toThrow("terminal evidence is immutable");
      expect(() => inspector.query(
        `UPDATE account_rate_limit_reset_attempts
         SET local_resolution='account_identity_changed' WHERE idempotency_key=?`,
      ).run(closed.idempotencyKey)).toThrow("terminal evidence is immutable");
    } finally {
      inspector.close(false);
    }
    expect(store.latestAccountRateLimitResetAttempt(
      profile.id,
      base.accountFingerprint,
    )).toMatchObject({
      idempotencyKey: closed.idempotencyKey,
      state: "closed",
    });
  });
test("retains every live-window latch while bounding expired reset history", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "oompa-reset-retention-")));
    const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
    await initializeStatePaths(paths);
    let now = 1_000;
    const store = new StateStore(paths, { now: () => now++ });
    stores.push(store);
    const email = "retained-reset@example.com";
    const profile = signInProfile(store, "Reset retention", email);
    const accountFingerprint = resetAccountFingerprint(email);
    const firstWindowResetsAt = 500_000;
    let firstKey: string | null = null;

    for (let index = 0; index < 130; index += 1) {
      const prepared = prepareAuthorizedReset(store, {
        profileId: profile.id,
        processGeneration: profile.processGeneration,
        accountFingerprint,
        weeklyWindowResetsAt: firstWindowResetsAt + index,
        observedUsedPercent: 99,
      });
      firstKey ??= prepared.idempotencyKey;
      beginAuthorizedReset(store, prepared);
      store.settleAccountRateLimitReset(prepared.idempotencyKey, "reset");
    }
    if (firstKey === null) throw new Error("Expected the first reset latch.");
    expect(store.latestAccountRateLimitResetAttempt(profile.id, accountFingerprint))
      .not.toBeNull();

    now = firstWindowResetsAt + 1_000;
    prepareAuthorizedReset(store, {
      profileId: profile.id,
      processGeneration: profile.processGeneration,
      accountFingerprint,
      weeklyWindowResetsAt: now + 500_000,
      observedUsedPercent: 99,
    });

    const inspector = new Database(store.paths.database, { create: false, strict: true });
    try {
      expect(inspector.query(
        `SELECT COUNT(*) AS count FROM account_rate_limit_reset_attempts
         WHERE profile_id=? AND state IN ('settled','closed')
           AND weekly_window_resets_at<=?`,
      ).get(profile.id, now)).toEqual({ count: 128 });
      expect(inspector.query(
        "SELECT 1 FROM account_rate_limit_reset_attempts WHERE idempotency_key=?",
      ).get(firstKey)).toBeNull();
    } finally {
      inspector.close(false);
    }
  });
test("closes identity-mismatched recovery without minting a duplicate key", async () => {
    const { store } = await fixture();
    const email = "identity-reset@example.com";
    const profile = signInProfile(store, "Reset identity", email);
    const accountFingerprint = resetAccountFingerprint(email);
    const input = {
      profileId: profile.id,
      processGeneration: profile.processGeneration,
      accountFingerprint,
      weeklyWindowResetsAt: 500_000_000,
      observedUsedPercent: 99,
    };
    const prepared = prepareAuthorizedReset(store, input);
    store.nextDaemonGeneration(`boot_${"i".repeat(32)}`);
    const restarted = store.requireProfileById(profile.id);
    expect(store.setProfileState(
      restarted.id,
      restarted.processGeneration,
      "signed_in",
      { email: "different@example.com", plan: "Plus" },
    )).toBe(true);

    expect(() => store.rebindAccountRateLimitReset({
      idempotencyKey: prepared.idempotencyKey,
      expectedCurrentProcessGeneration: profile.processGeneration,
      nextProcessGeneration: restarted.processGeneration,
      accountFingerprint,
    })).toThrow("ACCOUNT_RATE_LIMIT_RESET_REBIND_STATE_INVALID");
    expect(store.readRecoverableAccountRateLimitReset(profile.id, accountFingerprint))
      .toBeNull();
    expect(store.latestAccountRateLimitResetAttempt(profile.id, accountFingerprint))
      .toMatchObject({
        idempotencyKey: prepared.idempotencyKey,
        localResolution: "account_identity_changed",
        outcome: null,
        state: "closed",
      });
    expect(store.listAccountRateLimitResetRebinds(prepared.idempotencyKey)).toEqual([]);
    expect(() => store.prepareAccountRateLimitReset({
      ...input,
      processGeneration: restarted.processGeneration,
    })).toThrow("ACCOUNT_RATE_LIMIT_RESET_AUTHORITY_CHANGED");
  });
test("admits one later no-credit attempt per whole-percent observation and bounds repeats", async () => {
    const { store } = await fixture();
    const email = "credit-reset@example.com";
    const profile = signInProfile(store, "Reset credit", email);
    const base = {
      profileId: profile.id,
      processGeneration: profile.processGeneration,
      accountFingerprint: resetAccountFingerprint(email),
      weeklyWindowResetsAt: 500_000_000,
    };
    const first = prepareAuthorizedReset(store, {
      ...base,
      observedUsedPercent: 99,
    });
    beginAuthorizedReset(store, first);
    store.settleAccountRateLimitReset(first.idempotencyKey, "noCredit");

    const later = store.prepareAccountRateLimitReset({
      ...base,
      observedUsedPercent: 99.5,
    });
    expect(later.idempotencyKey).not.toBe(first.idempotencyKey);
    beginAuthorizedReset(store, later);
    store.settleAccountRateLimitReset(later.idempotencyKey, "noCredit");
    expect(store.prepareAccountRateLimitReset({
      ...base,
      observedUsedPercent: 99.8,
    }).idempotencyKey).toBe(later.idempotencyKey);

    const exhausted = store.prepareAccountRateLimitReset({
      ...base,
      observedUsedPercent: 100,
    });
    expect(exhausted.idempotencyKey).not.toBe(later.idempotencyKey);
  });
test("pages successful and failed usage observations in one exact source order", async () => {
    const { store } = await fixture();
    const profile = store.createProfile("Usage history page");
    const firstPayload = usageSnapshot({
      lifetimeTokens: 100,
      observedAt: 30_000,
      previous: null,
      providerGeneration: profile.processGeneration,
      receivedAt: 30_000,
      sourceSequence: 1,
    });
    const thirdPayload = usageSnapshot({
      lifetimeTokens: 300,
      observedAt: 20_000,
      previous: firstPayload,
      providerGeneration: profile.processGeneration,
      receivedAt: 20_000,
      sourceSequence: 3,
    });
    recordUsageForTest(store, profile.id, 1, 30_000, firstPayload);
    recordUsagePollFailureForTest(store, profile.id, usageFingerprint, 2, 10_000);
    recordUsageForTest(store, profile.id, 3, 20_000, thirdPayload);
    recordUsagePollFailureForTest(store, profile.id, usageFingerprint, 4, 50_000);

    const first = store.usageHistoryPage({
      profileId: profile.id,
      accountFingerprint: usageFingerprint,
      fromObservedAt: 5_000,
      throughObservedAt: 40_000,
      limit: 2,
    });
    expect(first).toEqual({
      entries: [
        {
          state: "observed",
          sourceRevision: 1,
          observedAt: 30_000,
          payload: firstPayload,
        },
        {
          state: "failed",
          sourceRevision: 2,
          observedAt: 10_000,
          reasonCode: "account_usage_read_failed",
        },
      ],
      nextSourceRevision: 2,
    });
    expect(store.usageHistoryPage({
      profileId: profile.id,
      accountFingerprint: usageFingerprint,
      fromObservedAt: 5_000,
      throughObservedAt: 40_000,
      afterSourceRevision: first.nextSourceRevision ?? 0,
      limit: 2,
    })).toEqual({
      entries: [{
        state: "observed",
        sourceRevision: 3,
        observedAt: 20_000,
        payload: thirdPayload,
      }],
      nextSourceRevision: null,
    });
  });
test("selects latest usage outcomes by durable source revision instead of provider time", async () => {
    const { store } = await fixture();
    const profile = store.createProfile("Usage source order");
    recordUsageForTest(store, profile.id, 1, 30_000, { totalTokens: 100 });
    const second = recordUsageForTest(store, profile.id, 2, 10_000, { totalTokens: 200 });
    recordUsagePollFailureForTest(store, profile.id, usageFingerprint, 3, 40_000);
    recordUsagePollFailureForTest(store, profile.id, usageFingerprint, 4, 5_000);

    expect(store.latestUsage(profile.id)).toEqual({
      sourceRevision: 2,
      observedAt: 10_000,
      payload: second,
    });
    expect(store.latestUsagePollFailure(profile.id, usageFingerprint)).toEqual({
      sourceRevision: 4,
      observedAt: 5_000,
      reasonCode: "account_usage_read_failed",
    });
  });
test("scopes usage snapshots and failures to the exact account after an identity change", async () => {
    const { store } = await fixture();
    const firstEmail = "usage-a@example.com";
    const secondEmail = "usage-b@example.com";
    const firstFingerprint = resetAccountFingerprint(firstEmail);
    const secondFingerprint = resetAccountFingerprint(secondEmail);
    const profile = signInProfile(store, "Usage identity", firstEmail);
    const first = usageSnapshot({
      accountFingerprint: firstFingerprint,
      lifetimeTokens: 100,
      observedAt: 10_000,
      previous: null,
      providerGeneration: profile.processGeneration,
      receivedAt: 1_000,
      sourceSequence: 1,
    });
    recordUsageForTest(store, profile.id, 1, 10_000, first);
    recordUsagePollFailureForTest(store, profile.id, firstFingerprint, 2, 20_000);

    expect(store.setProfileState(
      profile.id,
      profile.processGeneration,
      "signed_in",
      { email: secondEmail, plan: "Plus" },
    )).toBe(true);
    const second = usageSnapshot({
      accountFingerprint: secondFingerprint,
      lifetimeTokens: 200,
      observedAt: 30_000,
      previous: null,
      providerGeneration: profile.processGeneration,
      receivedAt: 1_000 + USAGE_CLOUD_UPLOAD_MIN_INTERVAL_MS,
      sourceSequence: 3,
    });
    recordUsageForTest(store, profile.id, 3, 30_000, second);
    recordUsagePollFailureForTest(store, profile.id, secondFingerprint, 4, 40_000);
    const staleFirst = usageSnapshot({
      accountFingerprint: firstFingerprint,
      lifetimeTokens: 300,
      observedAt: 50_000,
      previous: first,
      providerGeneration: profile.processGeneration,
      receivedAt: 1_000 + 2 * USAGE_CLOUD_UPLOAD_MIN_INTERVAL_MS,
      sourceSequence: 5,
    });
    recordUsageForTest(store, profile.id, 5, 50_000, staleFirst);
    recordUsagePollFailureForTest(store, profile.id, null, 6, 60_000);

    expect(store.latestUsage(profile.id)).toMatchObject({ sourceRevision: 5 });
    expect(store.latestUsageForAccount(profile.id, firstFingerprint))
      .toEqual({ sourceRevision: 5, observedAt: 50_000, payload: staleFirst });
    expect(store.latestUsageForAccount(profile.id, secondFingerprint))
      .toEqual({ sourceRevision: 3, observedAt: 30_000, payload: second });
    expect(store.latestUsagePollFailure(profile.id, firstFingerprint))
      .toMatchObject({ sourceRevision: 2 });
    expect(store.latestUsagePollFailure(profile.id, secondFingerprint))
      .toMatchObject({ sourceRevision: 4 });

    expect(store.usageHistoryPage({
      accountFingerprint: secondFingerprint,
      profileId: profile.id,
      fromObservedAt: 0,
      throughObservedAt: 60_000,
      limit: 10,
    }).entries.map((entry) => entry.sourceRevision)).toEqual([3, 4]);
    expect(store.usageHistoryPage({
      accountFingerprint: firstFingerprint,
      profileId: profile.id,
      fromObservedAt: 0,
      throughObservedAt: 60_000,
      limit: 10,
    }).entries.map((entry) => entry.sourceRevision)).toEqual([1, 2, 5]);
    expect(store.usageAfterRevision({
      accountFingerprint: secondFingerprint,
      afterSourceRevision: 0,
      limit: 10,
      profileId: profile.id,
    }).map((snapshot) => snapshot.sourceRevision)).toEqual([3]);
    expect(store.usageAfterRevision({
      accountFingerprint: firstFingerprint,
      afterSourceRevision: 0,
      limit: 10,
      profileId: profile.id,
    }).map((snapshot) => snapshot.sourceRevision)).toEqual([1, 5]);
  });
test("pages successful usage by exact source revision independent of observation time", async () => {
    const { store } = await fixture();
    const profile = store.createProfile("Usage upload ledger");
    const first = usageSnapshot({
      lifetimeTokens: 100,
      observedAt: 30_000,
      previous: null,
      providerGeneration: profile.processGeneration,
      receivedAt: 1_000,
      sourceSequence: 1,
    });
    const second = usageSnapshot({
      lifetimeTokens: 200,
      observedAt: 10_000,
      previous: first,
      providerGeneration: profile.processGeneration,
      receivedAt: 1_000 + USAGE_CLOUD_UPLOAD_MIN_INTERVAL_MS,
      sourceSequence: 2,
    });
    const fourth = usageSnapshot({
      lifetimeTokens: 400,
      observedAt: 20_000,
      previous: second,
      providerGeneration: profile.processGeneration,
      receivedAt: 1_000 + 2 * USAGE_CLOUD_UPLOAD_MIN_INTERVAL_MS,
      sourceSequence: 4,
    });
    recordUsageForTest(store, profile.id, 1, 30_000, first);
    recordUsageForTest(store, profile.id, 2, 10_000, second);
    recordUsagePollFailureForTest(store, profile.id, usageFingerprint, 3, 40_000);
    recordUsageForTest(store, profile.id, 4, 20_000, fourth);

    expect(store.usageAfterRevision({
      afterSourceRevision: 1,
      accountFingerprint: usageFingerprint,
      limit: 2,
      profileId: profile.id,
    })).toEqual([
      { sourceRevision: 2, observedAt: 10_000, payload: second },
      { sourceRevision: 4, observedAt: 20_000, payload: fourth },
    ]);
    expect(store.usageAfterRevision({
      afterSourceRevision: 2,
      accountFingerprint: usageFingerprint,
      limit: 1,
      profileId: profile.id,
    })).toEqual([
      { sourceRevision: 4, observedAt: 20_000, payload: fourth },
    ]);
  });
test("coalesces cloud upload history at the durable received-time cadence", async () => {
    const { store } = await fixture();
    const profile = store.createProfile("Usage upload cadence");
    let previous: StoredAccountUsageSnapshot | null = null;
    const received = [
      1_000,
      1_000 + USAGE_CLOUD_UPLOAD_MIN_INTERVAL_MS - 1,
      1_000 + USAGE_CLOUD_UPLOAD_MIN_INTERVAL_MS,
      1_000 + 2 * USAGE_CLOUD_UPLOAD_MIN_INTERVAL_MS - 1,
      1_000 + 2 * USAGE_CLOUD_UPLOAD_MIN_INTERVAL_MS,
    ];
    for (const [index, receivedAt] of received.entries()) {
      const sourceSequence = index + 1;
      const snapshot = usageSnapshot({
        lifetimeTokens: sourceSequence * 100,
        observedAt: receivedAt + 10_000,
        previous,
        providerGeneration: profile.processGeneration,
        receivedAt,
        sourceSequence,
      });
      recordUsageForTest(
        store,
        profile.id,
        sourceSequence,
        snapshot.observation.observedAt,
        snapshot,
      );
      previous = snapshot;
    }

    expect(store.usageAfterRevision({
      afterSourceRevision: 0,
      accountFingerprint: usageFingerprint,
      limit: 10,
      profileId: profile.id,
    }).map((snapshot) => snapshot.sourceRevision)).toEqual([1, 3, 5]);
    expect(store.usageAfterRevision({
      afterSourceRevision: 1,
      accountFingerprint: usageFingerprint,
      limit: 10,
      profileId: profile.id,
    }).map((snapshot) => snapshot.sourceRevision)).toEqual([3, 5]);
  });
test("keeps daily upload cadence when the uploaded payload row is byte-pruned", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "oompa-usage-anchor-retention-")));
    const paths = resolveStatePaths({ homeDirectory: home, platform: "linux" });
    await initializeStatePaths(paths);
    let now = 100_000;
    const store = new StateStore(paths, { now: () => now });
    stores.push(store);
    const profile = store.createProfile("Usage durable anchor");
    let previous: StoredAccountUsageSnapshot | null = null;
    for (let sourceSequence = 1; sourceSequence <= 70; sourceSequence += 1) {
      now = 100_000 + (sourceSequence - 1) * 50_000;
      const snapshot = usageSnapshot({
        fillerBytes: 249 * 1_024,
        lifetimeTokens: sourceSequence * 100,
        observedAt: now,
        previous,
        providerGeneration: profile.processGeneration,
        receivedAt: now,
        sourceSequence,
      });
      recordUsageForTest(store, profile.id, sourceSequence, now, snapshot);
      previous = snapshot;
    }

    expect(store.usageRange({ profileId: profile.id, limit: 10_000 })[0]?.sourceRevision)
      .toBeGreaterThan(1);
    expect(store.usageAfterRevision({
      afterSourceRevision: 1,
      accountFingerprint: usageFingerprint,
      limit: 10,
      profileId: profile.id,
    })).toEqual([]);
    const inspector = new Database(paths.database, { readonly: true, strict: true });
    try {
      expect(inspector.query(
        `SELECT source_revision,received_at FROM usage_cloud_upload_anchors
         WHERE profile_id=? ORDER BY source_revision`,
      ).all(profile.id)).toEqual([{ received_at: 100_000, source_revision: 1 }]);
    } finally {
      inspector.close(false);
    }

    now = 100_000 + USAGE_CLOUD_UPLOAD_MIN_INTERVAL_MS;
    const next = usageSnapshot({
      fillerBytes: 249 * 1_024,
      lifetimeTokens: 7_100,
      observedAt: now,
      previous,
      providerGeneration: profile.processGeneration,
      receivedAt: now,
      sourceSequence: 71,
    });
    recordUsageForTest(store, profile.id, 71, now, next);
    expect(store.usageAfterRevision({
      afterSourceRevision: 1,
      accountFingerprint: usageFingerprint,
      limit: 10,
      profileId: profile.id,
    }).map((snapshot) => snapshot.sourceRevision)).toEqual([71]);
  });
test("bounds compact upload anchors independently of payload retention", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "oompa-usage-anchor-bound-")));
    const paths = resolveStatePaths({ homeDirectory: home, platform: "linux" });
    await initializeStatePaths(paths);
    let now = 1_000;
    const store = new StateStore(paths, { now: () => now });
    stores.push(store);
    const profile = store.createProfile("Usage anchor bound");
    for (
      let sourceRevision = 1;
      sourceRevision <= USAGE_CLOUD_UPLOAD_ANCHOR_COUNT + 2;
      sourceRevision += 1
    ) {
      now = 1_000 + (sourceRevision - 1) * USAGE_CLOUD_UPLOAD_MIN_INTERVAL_MS;
      recordUsageForTest(store, profile.id, sourceRevision, now, { totalTokens: sourceRevision });
    }
    const inspector = new Database(paths.database, { readonly: true, strict: true });
    try {
      const anchors = inspector.query(
        `SELECT source_revision FROM usage_cloud_upload_anchors
         WHERE profile_id=? ORDER BY source_revision`,
      ).all(profile.id) as { source_revision: number }[];
      expect(anchors).toHaveLength(USAGE_CLOUD_UPLOAD_ANCHOR_COUNT);
      expect(anchors[0]?.source_revision).toBe(3);
    } finally {
      inspector.close(false);
    }
  });
test("bounds local usage bytes while preserving the live velocity window", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "oompa-usage-retention-")));
    const paths = resolveStatePaths({ homeDirectory: home, platform: "linux" });
    await initializeStatePaths(paths);
    let now = 1_000;
    const store = new StateStore(paths, { now: () => now });
    stores.push(store);
    const profile = store.createProfile("Usage byte retention");
    let previous: StoredAccountUsageSnapshot | null = null;
    for (let sourceSequence = 1; sourceSequence <= 100; sourceSequence += 1) {
      now = 100_000 + sourceSequence * 50_000;
      const snapshot = usageSnapshot({
        fillerBytes: 240_000,
        lifetimeTokens: sourceSequence * 100,
        observedAt: now,
        previous,
        providerGeneration: profile.processGeneration,
        receivedAt: now,
        sourceSequence,
      });
      recordUsageForTest(store, profile.id, sourceSequence, now, snapshot);
      previous = snapshot;
    }

    const ledger = store.usageRange({ profileId: profile.id, limit: 10_000 });
    const retainedBytes = ledger.reduce(
      (total, snapshot) => total + new TextEncoder().encode(JSON.stringify(snapshot.payload)).byteLength,
      0,
    );
    expect(ledger.length).toBeLessThan(100);
    expect(retainedBytes).toBeLessThanOrEqual(USAGE_LOCAL_RETAIN_BYTES);
    expect(observedAccountTokenVelocity({
      samples: accountUsageCounterSamples(ledger),
      window: "15m",
      now,
    })).toMatchObject({
      available: true,
      throughSourceSequence: 100,
    });
  });
test("bounds local usage rows and removes observations past the age contract", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "oompa-usage-row-retention-")));
    const paths = resolveStatePaths({ homeDirectory: home, platform: "linux" });
    await initializeStatePaths(paths);
    let now = 1_000;
    const store = new StateStore(paths, { now: () => now });
    stores.push(store);
    const profile = store.createProfile("Usage row retention");
    for (
      let sourceRevision = 1;
      sourceRevision <= USAGE_LOCAL_RETAIN_SUCCESS_COUNT + 2;
      sourceRevision += 1
    ) {
      now += 1;
      recordUsageForTest(store, profile.id, sourceRevision, now, { totalTokens: sourceRevision });
    }
    const bounded = store.usageRange({ profileId: profile.id, limit: 10_000 });
    expect(bounded).toHaveLength(USAGE_LOCAL_RETAIN_SUCCESS_COUNT);
    expect(bounded[0]?.sourceRevision).toBe(3);

    now += USAGE_LOCAL_RETAIN_AGE_MS + 1;
    const finalPayload = recordUsageForTest(
      store,
      profile.id,
      USAGE_LOCAL_RETAIN_SUCCESS_COUNT + 3,
      now,
      { totalTokens: USAGE_LOCAL_RETAIN_SUCCESS_COUNT + 3 },
    );
    expect(store.usageRange({ profileId: profile.id, limit: 10_000 })).toEqual([{
      observedAt: now,
      payload: finalPayload,
      sourceRevision: USAGE_LOCAL_RETAIN_SUCCESS_COUNT + 3,
    }]);
  });
test("freezes exact Codex usage authority for snapshots, failures, and upload anchors", async () => {
    const { store } = await fixture();
    const profile = signInProfile(store, "Exact Codex usage", "exact-usage@example.com");
    const authority = store.requireProviderAccountAuthority(profile.id, "codex");
    const snapshot = usageSnapshot({
      lifetimeTokens: 100,
      observedAt: 10_000,
      previous: null,
      providerGeneration: profile.processGeneration,
      receivedAt: 10_000,
      sourceSequence: 1,
    });
    store.recordUsage(profile.id, 1, 10_000, snapshot, authority);
    expect(() => store.recordUsage(
      profile.id,
      1,
      10_000,
      snapshot,
      { ...authority, bindingGeneration: authority.bindingGeneration + 1 },
    )).toThrow("CODEX_USAGE_AUTHORITY_REPLAY_CONFLICT");
    store.recordUsagePollFailure(
      profile.id,
      usageFingerprint,
      2,
      20_000,
      authority,
    );

    expect(store.readCodexUsageAuthorityMetadata("usage_snapshot", profile.id, 1))
      .toMatchObject({
        authority,
        binding: { processGeneration: authority.processGeneration, provenance: "usage_snapshot_v36" },
        canAuthorizeQuota: true,
        mode: "mutation_authoritative",
      });
    expect(store.readCodexUsageAuthorityMetadata("usage_poll_failure", profile.id, 2))
      .toMatchObject({
        authority,
        binding: {
          processGeneration: authority.processGeneration,
          provenance: "usage_poll_failure_v36",
        },
        canAuthorizeQuota: false,
        mode: "mutation_authoritative",
      });
    expect(store.readCodexUsageAuthorityMetadata("usage_upload_anchor", profile.id, 1))
      .toMatchObject({
        authority,
        binding: {
          processGeneration: authority.processGeneration,
          provenance: "usage_upload_anchor_v36",
        },
        canAuthorizeQuota: false,
        mode: "mutation_authoritative",
      });

    const mismatchedPayload = {
      ...snapshot,
      observation: {
        ...snapshot.observation,
        observedAt: 30_000,
        providerGeneration: authority.processGeneration + 1,
        sourceSequence: 3,
      },
    };
    expect(() => store.recordUsage(
      profile.id,
      3,
      30_000,
      mismatchedPayload,
      authority,
    )).toThrow("CODEX_USAGE_PAYLOAD_AUTHORITY_MISMATCH");

    const stalePayload = usageSnapshot({
      lifetimeTokens: 200,
      observedAt: 40_000,
      previous: snapshot,
      providerGeneration: profile.processGeneration,
      receivedAt: 40_000,
      sourceSequence: 4,
    });
    store.advanceProviderAccountProcessGeneration({
      expectedProcessGeneration: authority.processGeneration,
      profileId: profile.id,
      provider: "codex",
    });
    expect(() => store.recordUsage(
      profile.id,
      4,
      40_000,
      stalePayload,
      authority,
    )).toThrow("PROVIDER_ACCOUNT_AUTHORITY_STALE");
    expect(() => store.recordUsagePollFailure(
      profile.id,
      usageFingerprint,
      5,
      50_000,
      authority,
    )).toThrow("PROVIDER_ACCOUNT_AUTHORITY_STALE");

    const inspector = new Database(store.paths.database, { readonly: true, strict: true });
    try {
      expect(inspector.query(
        `SELECT scope_kind,process_generation,provenance
         FROM account_scoped_provider_authorities
         WHERE scope_kind IN ('usage_snapshot','usage_poll_failure','usage_upload_anchor')
         ORDER BY scope_kind,scope_id`,
      ).all()).toEqual([
        {
          process_generation: authority.processGeneration,
          provenance: "usage_poll_failure_v36",
          scope_kind: "usage_poll_failure",
        },
        {
          process_generation: authority.processGeneration,
          provenance: "usage_snapshot_v36",
          scope_kind: "usage_snapshot",
        },
        {
          process_generation: authority.processGeneration,
          provenance: "usage_upload_anchor_v36",
          scope_kind: "usage_upload_anchor",
        },
      ]);
      expect(inspector.query(
        "SELECT source_revision FROM usage_snapshots WHERE source_revision IN (3,4)",
      ).all()).toEqual([]);
      expect(inspector.query(
        "SELECT source_revision FROM usage_poll_failures WHERE source_revision=5",
      ).all()).toEqual([]);
    } finally {
      inspector.close(false);
    }
  });
test("makes Codex usage rows immutable and rejects a stored-byte digest mismatch", async () => {
    const { store } = await fixture();
    const profile = signInProfile(store, "Immutable Codex usage", "immutable-usage@example.com");
    const authority = store.requireProviderAccountAuthority(profile.id, "codex");
    const snapshot = usageSnapshot({
      lifetimeTokens: 100,
      observedAt: 10_000,
      previous: null,
      providerGeneration: profile.processGeneration,
      receivedAt: 10_000,
      sourceSequence: 1,
    });
    store.recordUsage(profile.id, 1, 10_000, snapshot, authority);
    store.recordUsagePollFailure(profile.id, usageFingerprint, 2, 20_000, authority);

    const inspector = new Database(store.paths.database, { create: false, strict: true });
    try {
      expect(() => inspector.query(
        `UPDATE usage_snapshots SET observed_at=observed_at+1
         WHERE profile_id=? AND source_revision=1`,
      ).run(profile.id)).toThrow("Codex usage snapshot is immutable");
      expect(() => inspector.query(
        `UPDATE usage_poll_failures SET observed_at=observed_at+1
         WHERE profile_id=? AND source_revision=2`,
      ).run(profile.id)).toThrow("Codex usage failure is immutable");
      expect(() => inspector.query(
        `UPDATE usage_cloud_upload_anchors SET received_at=received_at+1
         WHERE profile_id=? AND source_revision=1`,
      ).run(profile.id)).toThrow("Codex usage upload anchor is immutable");
    } finally {
      inspector.close(false);
    }

    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const corrupt = new Database(paths.database, { create: false, strict: true });
    withRemovedTestGuards(corrupt, ["usage_snapshots_immutable_update"], () => {
      corrupt.query("UPDATE usage_snapshots SET digest=? WHERE profile_id=? AND source_revision=1")
        .run("0".repeat(64), profile.id);
    });
    corrupt.close(false);

    expect(() => new StateStore(paths)).toThrow("CODEX_USAGE_SNAPSHOT_DIGEST_INVALID");
  });
test("refuses weakened same-name usage guards in current60 without rewriting authority", async () => {
    const { store } = await fixture({ provision: "migrate" });
    const profile = signInProfile(store, "Repair v36 guards", "repair-v36@example.com");
    const codexAuthority = store.requireProviderAccountAuthority(profile.id, "codex");
    const snapshot = usageSnapshot({
      lifetimeTokens: 100,
      observedAt: 10_000,
      previous: null,
      providerGeneration: profile.processGeneration,
      receivedAt: 10_000,
      sourceSequence: 1,
    });
    store.recordUsage(profile.id, 1, 10_000, snapshot, codexAuthority);
    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);

    const weakened = new Database(paths.database, { create: false, strict: true });
    try {
      weakened.exec(`
        DROP TRIGGER provider_usage_observation_receipts_insert_guard;
        CREATE TRIGGER provider_usage_observation_receipts_insert_guard
        BEFORE INSERT ON provider_usage_observation_receipts
        BEGIN SELECT 1; END;
        DROP TRIGGER usage_snapshots_immutable_update;
        CREATE TRIGGER usage_snapshots_immutable_update
        BEFORE UPDATE ON usage_snapshots
        BEGIN SELECT 1; END;
        DROP TRIGGER account_scoped_provider_authorities_immutable_update;
        CREATE TRIGGER account_scoped_provider_authorities_immutable_update
        BEFORE UPDATE ON account_scoped_provider_authorities
        BEGIN SELECT 1; END;
      `);
    } finally {
      weakened.close(false);
    }

    expectInertSchemaRefusal(paths, "STATE_SCHEMA_COHORT_INVALID:joined60:account_scoped_provider_authorities_immutable_update");
  });
test("refuses weakened same-name switch guards in current49 without rewriting authority", async () => {
    const { store } = await fixture({ provision: "migrate" });
    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);

    const weakened = new Database(paths.database, { create: false, strict: true });
    try {
      weakened.exec(`
        DROP TRIGGER session_switch_session_update_guard;
        CREATE TRIGGER session_switch_session_update_guard
        BEFORE UPDATE ON sessions
        BEGIN SELECT 1; END;
        DROP INDEX session_switch_one_open_per_session;
        CREATE UNIQUE INDEX session_switch_one_open_per_session
          ON session_switch_attempts(session_id)
          WHERE phase='prepared';
      `);
    } finally {
      weakened.close(false);
    }

    expectInertSchemaRefusal(paths, "STATE_SCHEMA_V42_STRUCTURE_INVALID");
  });
test.each([
    "usage_snapshot",
    "usage_poll_failure",
    "usage_upload_anchor",
  ] as const)(
    "audits missing Codex usage authority before startup retention for %s",
    (scopeKind) => ownedStateStoreCase(async ({ request }) => {
      const { store } = await request(() => fixture());
      const profile = signInProfile(
        store,
        `Missing ${scopeKind}`,
        `${scopeKind}@example.com`,
      );
      const authority = store.requireProviderAccountAuthority(profile.id, "codex");
      const snapshot = usageSnapshot({
        lifetimeTokens: 100,
        observedAt: 10_000,
        previous: null,
        providerGeneration: profile.processGeneration,
        receivedAt: 10_000,
        sourceSequence: 1,
      });
      store.recordUsage(profile.id, 1, 10_000, snapshot, authority);
      store.recordUsagePollFailure(profile.id, usageFingerprint, 2, 20_000, authority);
      const sourceRevision = scopeKind === "usage_poll_failure" ? 2 : 1;
      const paths = store.paths;
      store.close();
      stores.splice(stores.indexOf(store), 1);

      const corrupt = new Database(paths.database, { create: false, strict: true });
      withRemovedTestGuards(corrupt, ["account_scoped_provider_authorities_immutable_delete"], () => {
        corrupt.query("DELETE FROM account_scoped_provider_authorities WHERE scope_kind=? AND scope_id=?")
          .run(scopeKind, `${profile.id}:${sourceRevision}`);
      });
      corrupt.close(false);

      expect(() => new StateStore(paths, {
        now: () => USAGE_LOCAL_RETAIN_AGE_MS + 100_000,
      })).toThrow("ACCOUNT_SCOPED_PROVIDER_AUTHORITY_MISSING");
      expectInertSchemaRefusal(paths, "ACCOUNT_SCOPED_PROVIDER_AUTHORITY_MISSING");
    }),
  );
test("stores Claude quota and accounting against immutable turn authority", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "oompa-provider-usage-")));
    const paths = resolveStatePaths({ homeDirectory: home, platform: "linux" });
    await initializeStatePaths(paths);
    const store = new StateStore(paths, { now: () => 20_000 });
    stores.push(store);
    const daemon = startInputFixtureDaemon(store);
    const profile = store.createProfile("Claude usage");
    store.advanceProviderAccountProcessGeneration({
      expectedProcessGeneration: 0,
      profileId: profile.id,
      provider: "claude",
    });
    const beforeReadiness = store.requireProviderAccountForProfile(profile.id, "claude");
    store.observeProviderAccountReadiness({
      expectedBindingGeneration: beforeReadiness.bindingGeneration,
      observedAt: 1_000,
      profileId: profile.id,
      provider: "claude",
      readiness: "signed_in",
    });
    const oldTurn = bindClaudeTurnForUsageTest(store, profile.id, "turn-old-authority", daemon);
    const newerQuota = claudeQuotaForUsageTest({
      ...oldTurn,
      event: 2,
      observedAt: 9_000,
      revision: 2,
    });
    const olderQuota = claudeQuotaForUsageTest({
      ...oldTurn,
      event: 1,
      observedAt: 8_000,
      revision: 1,
    });
    const accounting = claudeAccountingForUsageTest({
      ...oldTurn,
      event: 3,
      observedAt: 10_000,
      revision: 1,
    });

    expect(store.recordProviderUsageObservation(newerQuota).status).toBe("inserted");
    expect(store.recordProviderUsageObservation(newerQuota).status).toBe("replayed");
    expect(() => store.recordProviderUsageObservation(claudeQuotaForUsageTest({
      ...oldTurn,
      event: 2,
      observedAt: 9_000,
      revision: 2,
      usedPercent: 99,
    }))).toThrow("PROVIDER_USAGE_IDEMPOTENCY_CONFLICT");
    expect(() => store.recordProviderUsageObservation(claudeQuotaForUsageTest({
      ...oldTurn,
      event: 22,
      observedAt: 9_000,
      revision: 2,
    }))).toThrow("PROVIDER_USAGE_REVISION_CONFLICT");
    expect(store.recordProviderUsageObservation(olderQuota).status).toBe("inserted");
    expect(store.recordProviderUsageObservation(accounting).status).toBe("inserted");

    expect(store.latestProviderUsage(oldTurn.authority.providerAccountId)).toMatchObject({
      accounting: { observationRevision: 1, observedAt: 10_000 },
      authority: oldTurn.authority,
      quota: { observationRevision: 2, observedAt: 9_000 },
    });
    let pendingTurnError: unknown;
    try {
      store.recordProviderUsageObservation(claudeQuotaForUsageTest({
        ...oldTurn,
        event: 23,
        observedAt: 11_000,
        revision: 3,
        turnId: "turn-not-bound",
      }));
    } catch (error: unknown) {
      pendingTurnError = error;
    }
    expect(pendingTurnError).toBeInstanceOf(ProviderUsageTurnNotBoundError);
    expect((pendingTurnError as Error).message).toBe("PROVIDER_USAGE_TURN_NOT_BOUND");
    expect(() => store.recordProviderUsageObservation(claudeQuotaForUsageTest({
      ...oldTurn,
      authority: {
        ...oldTurn.authority,
        bindingGeneration: oldTurn.authority.bindingGeneration + 1,
      },
      event: 24,
      observedAt: 11_000,
      revision: 3,
    }))).toThrow("provider usage turn authority mismatch");

    const currentAccount = store.requireProviderAccountForProfile(profile.id, "claude");
    store.observeProviderAccountReadiness({
      expectedBindingGeneration: currentAccount.bindingGeneration,
      observedAt: 12_000,
      profileId: profile.id,
      provider: "claude",
      readiness: "signed_out",
    });
    const rebound = store.requireProviderAccountAuthority(profile.id, "claude");
    const replacement = store.advanceProviderAccountProcessGeneration({
      expectedProcessGeneration: rebound.processGeneration,
      profileId: profile.id,
      provider: "claude",
    });
    const delayed = claudeQuotaForUsageTest({
      ...oldTurn,
      event: 4,
      observedAt: 12_500,
      revision: 3,
    });
    expect(store.recordProviderUsageObservation(delayed).status).toBe("inserted");

    const replacementTurn = bindClaudeTurnForUsageTest(
      store,
      profile.id,
      "turn-replacement-authority",
      daemon,
    );
    expect(replacementTurn.authority).toEqual(replacement);
    const replacementAccounting = claudeAccountingForUsageTest({
      ...replacementTurn,
      event: 5,
      observedAt: 13_000,
      revision: 1,
    });
    store.recordProviderUsageObservation(replacementAccounting);
    expect(store.latestProviderUsage(oldTurn.authority.providerAccountId)).toMatchObject({
      accounting: replacementAccounting,
      authority: replacement,
      quota: null,
    });

    const inspector = new Database(paths.database, { readonly: true, strict: true });
    try {
      const stored = inspector.query(
        `SELECT component_json FROM provider_usage_observation_components
         WHERE idempotency_key=?`,
      ).get(newerQuota.idempotencyKey) as { component_json: string };
      expect(stored.component_json).not.toContain("00000000-0000-4000-8000-000000000002");
      expect(stored.component_json).not.toContain("eventId\"");
    } finally {
      inspector.close(false);
    }
  });
test("uses the digest as the shared final ordering tie break", async () => {
    const { store } = await fixture();
    const daemon = startInputFixtureDaemon(store);
    const profile = store.createProfile("Claude usage ordering");
    store.advanceProviderAccountProcessGeneration({
      expectedProcessGeneration: 0,
      profileId: profile.id,
      provider: "claude",
    });
    const firstTurn = bindClaudeTurnForUsageTest(store, profile.id, "turn-\u{1f600}", daemon);
    const secondTurn = bindClaudeTurnForUsageTest(store, profile.id, "turn-\ue000", daemon);
    const first = claudeQuotaForUsageTest({
      ...firstTurn,
      event: 101,
      observedAt: 2_000,
      revision: 1,
    });
    const second = claudeQuotaForUsageTest({
      ...secondTurn,
      event: 102,
      observedAt: 2_000,
      revision: 1,
    });
    store.recordProviderUsageObservation(second);
    store.recordProviderUsageObservation(first);
    const expected = first.idempotencyKey < second.idempotencyKey ? second : first;

    expect(store.providerUsageObservations({
      component: "quota",
      providerAccountId: firstTurn.authority.providerAccountId,
    })[0]).toEqual(expected);
    expect(store.latestProviderUsage(firstTurn.authority.providerAccountId)?.quota)
      .toEqual(expected);
  });
test("replays retained Claude evidence before expiry and prunes components independently", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "oompa-provider-usage-prune-")));
    const paths = resolveStatePaths({ homeDirectory: home, platform: "linux" });
    await initializeStatePaths(paths);
    let now = 1_000;
    const store = new StateStore(paths, { now: () => now });
    stores.push(store);
    const daemon = startInputFixtureDaemon(store);
    const profile = store.createProfile("Claude usage retention");
    store.advanceProviderAccountProcessGeneration({
      expectedProcessGeneration: 0,
      profileId: profile.id,
      provider: "claude",
    });
    const turn = bindClaudeTurnForUsageTest(store, profile.id, "turn-retention", daemon);
    const oldQuota = claudeQuotaForUsageTest({
      ...turn,
      observedAt: now,
      revision: 1,
    });
    store.recordProviderUsageObservation(oldQuota);
    now = 5_000;
    const retainedAccounting = claudeAccountingForUsageTest({
      ...turn,
      observedAt: now,
      revision: 1,
    });
    store.recordProviderUsageObservation(retainedAccounting);

    now = 24 * 60 * 60 * 1_000 + 2_001;
    expect(store.recordProviderUsageObservation(oldQuota).status).toBe("replayed");
    const freshQuota = claudeQuotaForUsageTest({
      ...turn,
      event: 2,
      observedAt: now,
      revision: 2,
    });
    store.recordProviderUsageObservation(freshQuota);
    expect(store.providerUsageObservations({
      component: "quota",
      providerAccountId: turn.authority.providerAccountId,
    })).toEqual([freshQuota]);
    expect(store.providerUsageObservations({
      component: "accounting",
      providerAccountId: turn.authority.providerAccountId,
    })).toEqual([retainedAccounting]);
  });
test("bounds Claude provider usage independently by component count and bytes", async () => {
    const countHome = await realpath(await mkdtemp(join(tmpdir(), "oompa-provider-usage-count-")));
    const countPaths = resolveStatePaths({ homeDirectory: countHome, platform: "linux" });
    await initializeStatePaths(countPaths);
    let countNow = 10_000;
    const countStore = new StateStore(countPaths, { now: () => countNow });
    stores.push(countStore);
    const countDaemon = startInputFixtureDaemon(countStore);
    const countProfile = countStore.createProfile("Claude usage count bound");
    countStore.advanceProviderAccountProcessGeneration({
      expectedProcessGeneration: 0,
      profileId: countProfile.id,
      provider: "claude",
    });
    const countTurn = bindClaudeTurnForUsageTest(
      countStore,
      countProfile.id,
      "turn-count-bound",
      countDaemon,
    );
    seedProviderUsageForTest(
      countPaths.database,
      PROVIDER_USAGE_COMPONENT_RETAIN_COUNT,
      (revision) => claudeQuotaForUsageTest({
        ...countTurn,
        event: revision,
        observedAt: 10_000 + revision,
        revision,
      }),
    );
    countNow = 10_000 + PROVIDER_USAGE_COMPONENT_RETAIN_COUNT + 1;
    countStore.recordProviderUsageObservation(claudeQuotaForUsageTest({
      ...countTurn,
      event: PROVIDER_USAGE_COMPONENT_RETAIN_COUNT + 1,
      observedAt: countNow,
      revision: PROVIDER_USAGE_COMPONENT_RETAIN_COUNT + 1,
    }));
    const countInspector = new Database(countPaths.database, { readonly: true, strict: true });
    try {
      expect(countInspector.query(
        `SELECT COUNT(*) AS count,MIN(observation_revision) AS minimum
         FROM provider_usage_observation_receipts WHERE component='quota'`,
      ).get()).toEqual({ count: PROVIDER_USAGE_COMPONENT_RETAIN_COUNT, minimum: 2 });
    } finally {
      countInspector.close(false);
    }

    const bytesHome = await realpath(await mkdtemp(join(tmpdir(), "oompa-provider-usage-bytes-")));
    const bytesPaths = resolveStatePaths({ homeDirectory: bytesHome, platform: "linux" });
    await initializeStatePaths(bytesPaths);
    let bytesNow = 20_000;
    const bytesStore = new StateStore(bytesPaths, { now: () => bytesNow });
    stores.push(bytesStore);
    const bytesDaemon = startInputFixtureDaemon(bytesStore);
    const bytesProfile = bytesStore.createProfile("Claude usage byte bound");
    bytesStore.advanceProviderAccountProcessGeneration({
      expectedProcessGeneration: 0,
      profileId: bytesProfile.id,
      provider: "claude",
    });
    const bytesTurn = bindClaudeTurnForUsageTest(
      bytesStore,
      bytesProfile.id,
      "turn-byte-bound",
      bytesDaemon,
    );
    const largeModels = Array.from({ length: 32 }, (_, index) => ({
      cacheCreationInputTokens: Number.MAX_SAFE_INTEGER,
      cacheReadInputTokens: Number.MAX_SAFE_INTEGER,
      contextWindow: Number.MAX_SAFE_INTEGER,
      costUsd: Number.MAX_SAFE_INTEGER,
      inputTokens: Number.MAX_SAFE_INTEGER,
      maxOutputTokens: Number.MAX_SAFE_INTEGER,
      model: `${String(index).padStart(3, "0")}${"x".repeat(125)}`,
      outputTokens: Number.MAX_SAFE_INTEGER,
      thinkingTokens: Number.MAX_SAFE_INTEGER,
    }));
    const insertedForByteBound = 1_200;
    const largeAccounting = (revision: number) => createClaudeAccountingUsageComponent({
        accounting: {
          cacheCreationInputTokens: Number.MAX_SAFE_INTEGER,
          cacheReadInputTokens: Number.MAX_SAFE_INTEGER,
          inputTokens: Number.MAX_SAFE_INTEGER,
          models: largeModels,
          outputTokens: Number.MAX_SAFE_INTEGER,
          thinkingTokens: Number.MAX_SAFE_INTEGER,
          totalCostUsd: Number.MAX_SAFE_INTEGER,
        },
        authority: usageProviderAccountAuthoritySchema.parse(bytesTurn.authority),
        observationRevision: revision,
        observedAt: 20_000 + revision,
        receivedAt: 20_000 + revision,
        sessionId: bytesTurn.sessionId,
        sourceEventDigest: providerUsageDigest({ kind: "accounting-byte-bound", revision }),
        sourceEventId: `20000000-0000-4000-8000-${String(revision).padStart(12, "0")}`,
        turnId: bytesTurn.turnId,
      });
    seedProviderUsageForTest(
      bytesPaths.database,
      insertedForByteBound - 1,
      largeAccounting,
    );
    bytesNow = 20_000 + insertedForByteBound;
    bytesStore.recordProviderUsageObservation(largeAccounting(insertedForByteBound));
    const bytesInspector = new Database(bytesPaths.database, { readonly: true, strict: true });
    try {
      const retained = bytesInspector.query(
        `SELECT COUNT(*) AS count,
                SUM(length(CAST(value.component_json AS BLOB))) AS bytes
         FROM provider_usage_observation_receipts receipt
         JOIN provider_usage_observation_components value
           ON value.idempotency_key=receipt.idempotency_key
         WHERE receipt.component='accounting'`,
      ).get() as { bytes: number; count: number };
      expect(retained.count).toBeLessThan(insertedForByteBound);
      expect(retained.bytes).toBeLessThanOrEqual(PROVIDER_USAGE_COMPONENT_RETAIN_BYTES);
    } finally {
      bytesInspector.close(false);
    }
  }, 30_000);
test("migrates authentic canonical40 Codex usage bytes as display-only authority and reopens current49", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "oompa-store-canonical40-usage-")));
    const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
    await initializeStatePaths(paths);
    await writeFile(paths.database, canonical40UsageDatabaseBytes(), { mode: 0o600 });
    const profileId = canonical40UsageFixture.profileId;
    const inspector = new Database(paths.database, { create: false, strict: true });
    try {
      const storedBytes = () => ({
        snapshots: inspector.query("SELECT * FROM usage_snapshots ORDER BY profile_id,source_revision").all(),
        failures: inspector.query("SELECT * FROM usage_poll_failures ORDER BY profile_id,source_revision").all(),
        anchors: inspector.query("SELECT * FROM usage_cloud_upload_anchors ORDER BY profile_id,source_revision").all(),
      });
      const archived = {
        snapshots: [...canonical40UsageFixture.snapshots],
        failures: [...canonical40UsageFixture.failures],
        anchors: [...canonical40UsageFixture.anchors],
      };
      expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: 40 });
      expect(storedBytes()).toEqual(archived);
      expect(inspector.query(
        "SELECT name FROM sqlite_master WHERE name='account_scoped_provider_authorities'",
      ).get()).toBeNull();
      const migrated = new StateStore(paths, { now: () => 40_000 });
      stores.push(migrated);
      for (const [scope, revision] of [
        ["usage_snapshot", 1], ["usage_snapshot", 3],
        ["usage_poll_failure", 2], ["usage_upload_anchor", 1],
      ] as const) {
        expect(migrated.readCodexUsageAuthorityMetadata(scope, profileId, revision))
          .toMatchObject({
            binding: { processGeneration: null, provenance: "legacy_codex_compatibility" },
            canAuthorizeQuota: false,
            mode: "compatibility_display_only",
          });
      }
      const authority = migrated.requireProviderAccountAuthority(profileId, "codex");
      expect(() => migrated.recordUsage(profileId, 1, 10_000, canonical40UsageFixture.first, authority))
        .toThrow("CODEX_USAGE_AUTHORITY_REPLAY_CONFLICT");
      expect(() => migrated.recordUsagePollFailure(
        profileId, canonical40UsageFixture.fingerprint, 2, 20_000, authority,
      )).toThrow("CODEX_USAGE_FAILURE_AUTHORITY_REPLAY_CONFLICT");
      const sidecars = () => inspector.query(
        `SELECT * FROM account_scoped_provider_authorities
         WHERE scope_kind IN ('usage_snapshot','usage_poll_failure','usage_upload_anchor')
         ORDER BY scope_kind,scope_id`,
      ).all();
      const admittedSidecars = sidecars();
      expect(admittedSidecars).toHaveLength(4);
      expect(() => inspector.query(
        `UPDATE account_scoped_provider_authorities SET process_generation=?
         WHERE scope_kind='usage_snapshot' AND scope_id=?`,
      ).run(authority.processGeneration, `${profileId}:1`)).toThrow("account provider compatibility authority is immutable");
      expect(sidecars()).toEqual(admittedSidecars);
      expect(storedBytes()).toEqual(archived);
      expect(inspector.query("SELECT COUNT(*) AS count FROM codex_usage_authority_prune_targets").get())
        .toEqual({ count: 0 });
      expect(inspector.query("SELECT version,applied_at FROM migrations WHERE version<=40 ORDER BY version").all())
        .toEqual([...canonical40UsageFixture.migrations]);
      expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: 61 });
      const ledger = inspector.query("SELECT * FROM migrations ORDER BY version").all();
      migrated.close();
      stores.splice(stores.indexOf(migrated), 1);
      const reopened = new StateStore(paths, { now: () => 40_001 });
      stores.push(reopened);
      const readonly = new StateStore(paths, { readonly: true });
      readonly.close();
      expect(storedBytes()).toEqual(archived);
      expect(sidecars()).toEqual(admittedSidecars);
      expect(inspector.query("SELECT * FROM migrations ORDER BY version").all()).toEqual(ledger);
      expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: 61 });
    } finally {
      inspector.close(false);
    }
  });
test("migrates a canonical40 upload anchor whose snapshot was pruned before authority tracking", async () => {
    // Pre-authority releases prune usage snapshots by age and count while
    // keeping up to 128 upload anchors, so an authentic state can hold an
    // anchor with no snapshot. The schema-41 backfill derives snapshot
    // authority only from retained snapshots, so that anchor can never bind
    // to one. The migration retires it and keeps every anchor whose snapshot
    // survived, instead of refusing the whole state.
    const home = await realpath(await mkdtemp(join(tmpdir(), "oompa-store-canonical40-pruned-anchor-")));
    const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
    await initializeStatePaths(paths);
    await writeFile(paths.database, canonical40UsageDatabaseBytes(), { mode: 0o600 });
    const profileId = canonical40UsageFixture.profileId;
    const prunedAnchor = canonical40UsageFixture.anchors[0];
    const retainedSnapshot = canonical40UsageFixture.snapshots[1];
    const retainedAnchor = {
      profile_id: profileId,
      source_revision: retainedSnapshot.source_revision,
      received_at: canonical40UsageFixture.third.observation.receivedAt,
    };
    expect(prunedAnchor.source_revision).toBe(canonical40UsageFixture.snapshots[0].source_revision);
    expect(retainedAnchor.source_revision).not.toBe(prunedAnchor.source_revision);
    const inspector = new Database(paths.database, { create: false, strict: true });
    try {
      const anchors = () => inspector.query(
        "SELECT * FROM usage_cloud_upload_anchors ORDER BY profile_id,source_revision",
      ).all();
      const snapshots = () => inspector.query(
        "SELECT * FROM usage_snapshots ORDER BY profile_id,source_revision",
      ).all();
      const sidecars = () => inspector.query(
        `SELECT scope_kind,scope_id,process_generation,provenance
         FROM account_scoped_provider_authorities
         WHERE scope_kind IN ('usage_snapshot','usage_poll_failure','usage_upload_anchor')
         ORDER BY scope_kind,scope_id`,
      ).all();
      expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: 40 });
      inspector.transaction(() => {
        inspector.query("DELETE FROM usage_snapshots WHERE profile_id=? AND source_revision=?")
          .run(profileId, prunedAnchor.source_revision);
        inspector.query(
          "INSERT INTO usage_cloud_upload_anchors(profile_id,source_revision,received_at) VALUES (?,?,?)",
        ).run(retainedAnchor.profile_id, retainedAnchor.source_revision, retainedAnchor.received_at);
      }).immediate();
      expect(anchors()).toEqual([prunedAnchor, retainedAnchor]);
      expect(snapshots()).toEqual([retainedSnapshot]);

      const migrated = new StateStore(paths, { now: () => 40_000 });
      stores.push(migrated);
      expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: 61 });
      expect(anchors()).toEqual([retainedAnchor]);
      expect(snapshots()).toEqual([retainedSnapshot]);
      const compatibility = { process_generation: null, provenance: "legacy_codex_compatibility" };
      const admittedSidecars = [
        { scope_kind: "usage_poll_failure", scope_id: `${profileId}:${canonical40UsageFixture.failures[0].source_revision}`, ...compatibility },
        { scope_kind: "usage_snapshot", scope_id: `${profileId}:${retainedAnchor.source_revision}`, ...compatibility },
        { scope_kind: "usage_upload_anchor", scope_id: `${profileId}:${retainedAnchor.source_revision}`, ...compatibility },
      ];
      expect(sidecars()).toEqual(admittedSidecars);
      expect(inspector.query("SELECT COUNT(*) AS count FROM codex_usage_authority_prune_targets").get())
        .toEqual({ count: 0 });
      for (const [scope, revision] of [
        ["usage_snapshot", retainedAnchor.source_revision],
        ["usage_upload_anchor", retainedAnchor.source_revision],
        ["usage_poll_failure", canonical40UsageFixture.failures[0].source_revision],
      ] as const) {
        expect(migrated.readCodexUsageAuthorityMetadata(scope, profileId, revision))
          .toMatchObject({ canAuthorizeQuota: false, mode: "compatibility_display_only" });
      }
      expect(() => migrated.readCodexUsageAuthorityMetadata("usage_upload_anchor", profileId, prunedAnchor.source_revision))
        .toThrow("ACCOUNT_SCOPED_PROVIDER_AUTHORITY_MISSING");
      expect(inspector.query("SELECT version,applied_at FROM migrations WHERE version<=40 ORDER BY version").all())
        .toEqual([...canonical40UsageFixture.migrations]);
      const ledger = inspector.query("SELECT * FROM migrations ORDER BY version").all();
      migrated.close();
      stores.splice(stores.indexOf(migrated), 1);

      const readonly = new StateStore(paths, { readonly: true });
      readonly.close();
      const reopened = new StateStore(paths, { now: () => 40_001 });
      stores.push(reopened);
      expect(anchors()).toEqual([retainedAnchor]);
      expect(sidecars()).toEqual(admittedSidecars);
      expect(inspector.query("SELECT * FROM migrations ORDER BY version").all()).toEqual(ledger);
      expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: 61 });
    } finally {
      inspector.close(false);
    }
  });
test("rejects a trigger-disabled provider usage receipt-to-JSON mismatch on reopen", async () => {
    const { store } = await fixture();
    const daemon = startInputFixtureDaemon(store);
    const profile = store.createProfile("Provider usage corruption");
    store.advanceProviderAccountProcessGeneration({
      expectedProcessGeneration: 0,
      profileId: profile.id,
      provider: "claude",
    });
    const turn = bindClaudeTurnForUsageTest(store, profile.id, "turn-corrupt-usage", daemon);
    const observation = claudeQuotaForUsageTest({
      ...turn,
      observedAt: 2_000,
      revision: 1,
    });
    store.recordProviderUsageObservation(observation);
    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);

    const corrupt = new Database(paths.database, { create: false, strict: true });
    withRemovedTestGuards(corrupt, ["provider_usage_observation_components_immutable_update"], () => {
      corrupt.query(`UPDATE provider_usage_observation_components
        SET component_json=json_set(component_json,'$.observedAt',?) WHERE idempotency_key=?`)
        .run(observation.observedAt + 1, observation.idempotencyKey);
    });
    corrupt.close(false);
    expect(() => new StateStore(paths))
      .toThrow("PROVIDER_USAGE_COMPONENT_EVIDENCE_MISMATCH");
  });
test("rejects noncanonical provider usage bytes and unowned Codex usage sidecars", async () => {
    const canonicalFixture = await fixture();
    const daemon = startInputFixtureDaemon(canonicalFixture.store);
    const canonicalProfile = canonicalFixture.store.createProfile("Provider usage canonical bytes");
    canonicalFixture.store.advanceProviderAccountProcessGeneration({
      expectedProcessGeneration: 0,
      profileId: canonicalProfile.id,
      provider: "claude",
    });
    const turn = bindClaudeTurnForUsageTest(
      canonicalFixture.store,
      canonicalProfile.id,
      "turn-noncanonical-usage",
      daemon,
    );
    const observation = claudeQuotaForUsageTest({
      ...turn,
      observedAt: 2_000,
      revision: 1,
    });
    canonicalFixture.store.recordProviderUsageObservation(observation);
    const canonicalPaths = canonicalFixture.store.paths;
    canonicalFixture.store.close();
    stores.splice(stores.indexOf(canonicalFixture.store), 1);
    const noncanonical = new Database(canonicalPaths.database, { create: false, strict: true });
    withRemovedTestGuards(noncanonical, ["provider_usage_observation_components_immutable_update"], () => {
      noncanonical.query("UPDATE provider_usage_observation_components SET component_json=' '||component_json WHERE idempotency_key=?")
        .run(observation.idempotencyKey);
    });
    noncanonical.close(false);
    expect(() => new StateStore(canonicalPaths)).toThrow("PROVIDER_USAGE_COMPONENT_INVALID");

    const orphanFixture = await fixture();
    const orphanProfile = signInProfile(
      orphanFixture.store,
      "Orphan Codex usage",
      "orphan-usage@example.com",
    );
    recordUsagePollFailureForTest(
      orphanFixture.store,
      orphanProfile.id,
      usageFingerprint,
      1,
      2_000,
    );
    const orphanPaths = orphanFixture.store.paths;
    orphanFixture.store.close();
    stores.splice(stores.indexOf(orphanFixture.store), 1);
    const orphan = new Database(orphanPaths.database, { create: false, strict: true });
    withRemovedTestGuards(orphan, ["usage_poll_failures_prune_authority"], () => {
      orphan.query("DELETE FROM usage_poll_failures WHERE profile_id=? AND source_revision=1").run(orphanProfile.id);
    });
    orphan.close(false);
    expect(() => new StateStore(orphanPaths)).toThrow("CODEX_USAGE_AUTHORITY_ORPHANED");
  });
test("reopens v9 event and interaction state read-only without rotating authority", async () => {
    const { store } = await fixture();
    const profile = signInProfile(store, "Readonly v9", "readonly-v9@example.com");
    const session = createProvenTestSession(store, {
      profileId: profile.id,
      preset: "high",
      fastEnabled: false,
      providerThreadId: "thread-readonly",
    });
    const providerAuthority = store.requireProviderAccountAuthority(profile.id, "codex");
    const event = store.appendSessionEvent({
      sessionId: session.id,
      accountId: profile.id,
      providerGeneration: profile.processGeneration,
      providerAuthority,
      providerConnectionId: null,
      body: { type: "warning", code: "PERSISTED", message: "safe" },
    });
    const interaction = store.admitInteraction({
      publicId: "40000000-0000-4000-8000-000000000001",
      sessionId: session.id,
      authority: {
        ...codexInteractionBinding(store, profile.id),
        profileId: profile.id,
        processGeneration: profile.processGeneration,
        connectionId: "40000000-0000-4000-8000-000000000002",
        requestId: { type: "string", value: "request-readonly" },
        method: "item/fileChange/requestApproval",
        requestDigest: "4".repeat(64),
        threadId: "thread-readonly",
        turnId: "turn-readonly",
        itemId: "item-readonly",
        approvalId: null,
      },
      kind: "file_change_approval",
      blocking: true,
      display: {
        kind: "file_change_approval",
        summary: "Apply safe changes",
        reason: null,
        grantRoot: null,
        availableDecisions: ["once" as const, "decline" as const, "cancel" as const],
      },
    }).record;
    const paths = store.paths;
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const readonly = new StateStore(paths, { readonly: true });
    stores.push(readonly);
    expect(readonly.eventStreamPosition(session.id)).toEqual({
      streamEpoch: event.streamEpoch,
      floorSequence: 1,
      observedThroughSequence: 1,
    });
    expect(readonly.listSessionEvents({ sessionId: session.id, afterSequence: 0 }).events).toEqual([event]);
    expect(readonly.requireInteraction(interaction.publicId)).toEqual(interaction);
  });
test("migrates captured v38 runtime evidence and adversarial derivatives without inventing authority", async () => {
    const captured = canonical38RuntimeFixture;
    const c = captured.retained;
    const { first, signedIn, target } = c;
    const codexSession = c.codex.session;
    const claudeSession = c.claude.session;
    const conflictingSession = c.conflictingBaseline.session;
    const revisionPrecedenceSession = c.revisionPrecedence.session;
    const invalidLatestSession = c.invalidLatestBaseline.session;
    const unprovedSession = c.unproved.session;
    const unprovedQueue = c.unproved.queue;
    const unprovedInteraction = c.unproved.interaction;
    const unprovedMutation = c.unproved.mutation;
    const unprovedEvent = c.unproved.event;
    const switchedSession = c.switched.session;
    const historicalQueue = c.switched.queue;
    const historicalEvent = c.switched.event;
    const migratedAt = 60_000;
    expect(first.createdAt).toBeLessThan(signedIn.createdAt);
    expect(signedIn.createdAt).toBeLessThan(target.createdAt);
    expect(target.createdAt).toBeLessThan(c.restartTarget.createdAt);
    expect(first.state).toBe("signed_out");
    expect(c.revisionPrecedence.second.revision).toBeGreaterThan(c.revisionPrecedence.record.revision);
    expect(c.revisionPrecedence.second.recordedAt).toBeLessThan(c.revisionPrecedence.record.recordedAt);

    // First prove that the intact archived image admits each valid baseline.
    const controlPaths = await canonical38RuntimeArchive();
    const control = new StateStore(controlPaths, { now: () => migratedAt, resolveMachineTimeZone: () => "UTC" });
    try {
      expect(control.requireSessionProviderAuthority(conflictingSession.id)).toMatchObject({ provider: "claude", profileId: signedIn.id });
      expect(control.requireSessionProviderAuthority(invalidLatestSession.id)).toMatchObject({ provider: "codex", profileId: signedIn.id });
      expect(control.requireSessionProviderAuthority(revisionPrecedenceSession.id)).toMatchObject({ provider: "claude", profileId: signedIn.id });
    } finally { control.close(); }

    const paths = await canonical38RuntimeArchive();
    const inspector = new Database(paths.database, { create: false, strict: true });
    try {
      inspector.exec("PRAGMA foreign_keys=ON");
      const original = canonicalAuthBudgetSnapshot(inspector);
      // Explicitly test-derived old-state disagreements, not writer output:
      // a mutable provider cell; a malformed newest runtime; and conflicting
      // older runtime bytes whose later timestamp must not outrank revision2.
      expect(inspector.query("UPDATE sessions SET provider='codex' WHERE id=?").run(conflictingSession.id).changes).toBe(1);
      const insertLatest = inspector.query("INSERT INTO session_runtime_profiles(session_id,revision,source_kind,source_id,profile_id,process_generation,observed_at,profile_json,recorded_at) VALUES (?,2,'session_start',?,?,?,38101,?,38101)");
      expect(insertLatest.run(invalidLatestSession.id, "adversarial-invalid-latest", signedIn.id, signedIn.processGeneration, '{"invalid":true}').changes).toBe(1);
      const replaceOlder = () => inspector.query("UPDATE session_runtime_profiles SET profile_json=? WHERE session_id=? AND revision=1")
        .run(JSON.stringify(c.codex.runtime), revisionPrecedenceSession.id);
      expect(replaceOlder).toThrow("session runtime profile is immutable");
      withRemovedTestGuards(inspector, ["session_runtime_profiles_immutable_update"], () => {
        expect(replaceOlder().changes).toBe(1);
      });
      const derived = canonicalAuthBudgetSnapshot(inspector);
      expect(derived.schema).toEqual(original.schema);
      expect(derived.version).toEqual(original.version);
      for (const [table, rows] of Object.entries(original.rows)) {
        if (table !== "sessions" && table !== "session_runtime_profiles") expect(derived.rows[table]).toEqual(rows);
      }
      const sessionRows = z.array(z.object({ id: z.string() }).passthrough()).parse(original.rows.sessions);
      expect(derived.rows.sessions).toEqual(sessionRows.map((row) => row.id === conflictingSession.id ? { ...row, provider: "codex" } : row));
      expect(inspector.query("SELECT profile_json,recorded_at FROM session_runtime_profiles WHERE session_id=? ORDER BY revision")
        .all(revisionPrecedenceSession.id)).toEqual([
          { profile_json: JSON.stringify(c.codex.runtime), recorded_at: c.revisionPrecedence.record.recordedAt },
          { profile_json: JSON.stringify(c.revisionPrecedence.second.profile), recorded_at: c.revisionPrecedence.second.recordedAt },
        ]);
      const retained = canonicalAuthBudgetRows(inspector, [
        "profiles", "provider_interactions", "provider_interaction_transitions",
        "session_runtime_profiles", "session_turn_runtime_profiles", "session_events",
        "queue_entries", "queue_effect_evidence", "mutation_effect_evidence",
        "session_mutation_authority_rebinds", "session_provider_switch_targets",
        "session_provider_switch_seed_intents", "session_provider_switch_seed_results",
        "session_provider_switch_source_releases",
      ]);
      const sessions = canonicalAuthBudgetRows(inspector, ["sessions"]);
      const mutations = canonicalAuthBudgetRows(inspector, ["mutation_attempts"]);
      expect(() => { new StateStore(paths, { readonly: true }).close(); }).toThrow("STATE_SCHEMA_MIGRATION_REQUIRED:38:61");
      expect(canonicalAuthBudgetSnapshot(inspector)).toEqual(derived);
      const migrated = new StateStore(paths, { now: () => migratedAt, resolveMachineTimeZone: () => "UTC" });
      stores.push(migrated);
      expect(migrated.listProviderAccounts("codex").map((account) => ({
        id: account.id, orderPosition: account.orderPosition, profileId: account.profileId,
      }))).toEqual([first, signedIn, target, c.restartTarget].map((profile, index) => ({
        id: profile.id, orderPosition: index + 1, profileId: profile.id,
      })));
      expect(migrated.readProviderAccountState("codex").activeProviderAccountId).toBe(signedIn.id);
      expect(migrated.readProviderAccountState("claude").activeProviderAccountId)
        .toBe(migrated.requireProviderAccountForProfile(first.id, "claude").id);
      for (const [session, provider] of [[codexSession, "codex"], [claudeSession, "claude"], [revisionPrecedenceSession, "claude"]] as const) {
        expect(migrated.requireSessionProviderAuthority(session.id)).toMatchObject({
          appliedPointerRevision: null, profileId: signedIn.id, provider, routingProvenance: "explicit",
        });
      }
      expect(() => migrated.requireSessionProviderAuthority(conflictingSession.id))
        .toThrow("SESSION_PROVIDER_AUTHORITY_QUARANTINED:conflicting_immutable_runtime_authority");
      for (const session of [unprovedSession, invalidLatestSession]) {
        expect(() => migrated.requireSessionProviderAuthority(session.id))
          .toThrow("SESSION_PROVIDER_AUTHORITY_QUARANTINED:missing_immutable_runtime_authority");
      }
      const migratedSourceAuthority = migrated.requireProviderAccountAuthority(signedIn.id, "codex");
      const migratedTargetAuthority = migrated.requireProviderAccountAuthority(target.id, "claude");
      expect(migrated.requireSessionProviderAuthority(switchedSession.id)).toMatchObject({
        profileId: target.id, provider: "claude", providerAccountId: migratedTargetAuthority.providerAccountId,
        processGeneration: migratedTargetAuthority.processGeneration,
      });
      expect(migrated.readQueueProviderAuthority(historicalQueue.id)).toEqual(migratedSourceAuthority);
      expectHistoricalValue(migrated.readQueueEffect(historicalQueue.id), c.switched.queueEffect);
      expect(migrated.listSessionEvents({ afterSequence: 0, sessionId: switchedSession.id }).events.some(
        (event) => event.accountId === signedIn.id && event.providerGeneration === signedIn.processGeneration
          && event.sequence === historicalEvent.sequence,
      )).toBe(true);
      // Exercise the actual captured queue's immutable document and anchor,
      // rather than constructing a new effect outside its provenance writer.
      const sourceClaudeAuthority = migrated.requireProviderAccountAuthority(signedIn.id, "claude");
      const guardDatabase = new Database(paths.database, { create: false, strict: true });
      try {
        expect(guardDatabase.query(
          "SELECT provider_account_id,profile_id,provider,binding_generation,process_generation FROM session_event_provider_authorities WHERE session_id=? AND sequence=?",
        ).get(switchedSession.id, historicalEvent.sequence)).toEqual({
          binding_generation: migratedSourceAuthority.bindingGeneration,
          process_generation: migratedSourceAuthority.processGeneration,
          profile_id: migratedSourceAuthority.profileId,
          provider: migratedSourceAuthority.provider,
          provider_account_id: migratedSourceAuthority.providerAccountId,
        });
        const capturedQueueAuthority = z.object({
          queue_id: z.string(), provider_account_id: z.string(), profile_id: z.string(), provider: z.string(),
          binding_generation: z.number(), process_generation: z.number(), provenance: z.literal("legacy_queue_runtime"),
          recorded_at: z.number(),
        }).strict().parse(guardDatabase.query("SELECT * FROM queue_provider_authorities WHERE queue_id=?").get(historicalQueue.id));
        const beforeQueueProbe = canonicalAuthBudgetSnapshot(guardDatabase);
        const queueProbeRollback = "ROLLBACK_LEGACY_QUEUE_AUTHORITY_PROBE";
        const queueProbe = guardDatabase.transaction(() => {
          // This temporary sidecar removal changes no captured effect bytes,
          // provenance or schema. Every installed guard remains intact.
          expect(guardDatabase.query("DELETE FROM queue_provider_authorities WHERE queue_id=?").run(historicalQueue.id).changes).toBe(1);
          const missingSidecar = canonicalAuthBudgetSnapshot(guardDatabase);
          const insert = (authority: typeof capturedQueueAuthority) => guardDatabase.query(
            "INSERT INTO queue_provider_authorities(queue_id,provider_account_id,profile_id,provider,binding_generation,process_generation,provenance,recorded_at) VALUES (?,?,?,?,?,?,?,?)",
          ).run(authority.queue_id, authority.provider_account_id, authority.profile_id, authority.provider,
            authority.binding_generation, authority.process_generation, authority.provenance, authority.recorded_at);
          for (const wrong of [
            { ...capturedQueueAuthority, profile_id: migratedTargetAuthority.profileId,
              provider_account_id: migratedTargetAuthority.providerAccountId, provider: migratedTargetAuthority.provider,
              binding_generation: migratedTargetAuthority.bindingGeneration, process_generation: migratedTargetAuthority.processGeneration },
            { ...capturedQueueAuthority, process_generation: capturedQueueAuthority.process_generation + 1 },
            { ...capturedQueueAuthority, provider_account_id: sourceClaudeAuthority.providerAccountId, provider: sourceClaudeAuthority.provider,
              binding_generation: sourceClaudeAuthority.bindingGeneration },
          ]) {
            expect(() => insert(wrong)).toThrow(/queue provider authority mismatch|JOINED_EVIDENCE_BOUNDARY_REFUSED/u);
            expect(canonicalAuthBudgetSnapshot(guardDatabase)).toEqual(missingSidecar);
          }
          expect(() => guardDatabase.query(
            "INSERT INTO queue_provider_authorities SELECT ?,?,?,?,?,?,'forged_unknown_provenance',?",
          ).run(historicalQueue.id, capturedQueueAuthority.provider_account_id, capturedQueueAuthority.profile_id,
            capturedQueueAuthority.provider, capturedQueueAuthority.binding_generation,
            capturedQueueAuthority.process_generation, capturedQueueAuthority.recorded_at))
            .toThrow("queue provider authority mismatch");
          expect(canonicalAuthBudgetSnapshot(guardDatabase)).toEqual(missingSidecar);
          expect(insert(capturedQueueAuthority).changes).toBe(1);
          expect(canonicalAuthBudgetSnapshot(guardDatabase)).toEqual(beforeQueueProbe);
          throw new Error(queueProbeRollback);
        });
        expect(() => queueProbe()).toThrow(queueProbeRollback);
        expect(canonicalAuthBudgetSnapshot(guardDatabase)).toEqual(beforeQueueProbe);
        expect(migrated.readQueueProviderAuthority(historicalQueue.id)).toEqual(migratedSourceAuthority);
        expectHistoricalValue(migrated.readQueueEffect(historicalQueue.id), c.switched.queueEffect);

        // A different old queue has no effect or anchor. Even copied valid
        // runtime fields cannot create new evidence outside the joined writer.
        const unanchored = { ...c.switched.queueEffect.evidence, queueId: unprovedQueue.id,
          clientMessageId: unprovedQueue.id, sessionId: unprovedSession.id,
          providerThreadId: unprovedSession.providerThreadId,
          messageDigest: createHash("sha256").update(unprovedQueue.message).digest("hex") };
        const unanchoredJson = JSON.stringify(unanchored);
        expect(guardDatabase.query("SELECT * FROM queue_effect_evidence WHERE queue_id=?").all(unprovedQueue.id)).toEqual([]);
        expect(() => guardDatabase.query(
          "INSERT INTO queue_effect_evidence(queue_id,evidence_json,evidence_digest,recorded_at) VALUES (?,?,?,?)",
        ).run(unprovedQueue.id, unanchoredJson, createHash("sha256").update(unanchoredJson).digest("hex"), 61_100))
          .toThrow("EFFECT_EVIDENCE_PROVENANCE_CORRUPT");
        expect(canonicalAuthBudgetSnapshot(guardDatabase)).toEqual(beforeQueueProbe);

      // Schema60 replaces this event guard with the joined boundary's exact
      // refusal; every rejected insertion must leave all retained state intact.
      const insertEventAuthority = guardDatabase.query(
        `INSERT INTO session_event_provider_authorities(
           session_id,sequence,provider_account_id,profile_id,provider,
           binding_generation,process_generation,provenance,recorded_at
         ) VALUES (?,?,?,?,?,?,?,?,?)`,
      );
      expect(() => insertEventAuthority.run(
        unprovedSession.id,
        unprovedEvent.sequence,
        migratedSourceAuthority.providerAccountId,
        migratedSourceAuthority.profileId,
        migratedSourceAuthority.provider,
        migratedSourceAuthority.bindingGeneration,
        migratedSourceAuthority.processGeneration,
        "legacy_session_runtime",
        61_100,
      )).toThrow("JOINED_EVIDENCE_BOUNDARY_REFUSED");
      expect(canonicalAuthBudgetSnapshot(guardDatabase)).toEqual(beforeQueueProbe);
      expect(() => insertEventAuthority.run(
        unprovedSession.id,
        unprovedEvent.sequence,
        migratedSourceAuthority.providerAccountId,
        migratedSourceAuthority.profileId,
        migratedSourceAuthority.provider,
        migratedSourceAuthority.bindingGeneration,
        migratedSourceAuthority.processGeneration,
        "legacy_interaction_authority",
        61_100,
      )).toThrow("JOINED_EVIDENCE_BOUNDARY_REFUSED");
      expect(canonicalAuthBudgetSnapshot(guardDatabase)).toEqual(beforeQueueProbe);
      expect(() => insertEventAuthority.run(
        unprovedSession.id,
        unprovedEvent.sequence,
        migratedSourceAuthority.providerAccountId,
        migratedSourceAuthority.profileId,
        migratedSourceAuthority.provider,
        migratedSourceAuthority.bindingGeneration,
        migratedSourceAuthority.processGeneration,
        "forged_unknown_provenance",
        61_100,
      )).toThrow("JOINED_EVIDENCE_BOUNDARY_REFUSED");
      expect(canonicalAuthBudgetSnapshot(guardDatabase)).toEqual(beforeQueueProbe);
      expect(() => insertEventAuthority.run(
        unprovedSession.id,
        unprovedEvent.sequence,
        migratedTargetAuthority.providerAccountId,
        migratedTargetAuthority.profileId,
        migratedTargetAuthority.provider,
        migratedTargetAuthority.bindingGeneration,
        migratedTargetAuthority.processGeneration,
        "legacy_session_runtime",
        61_100,
      )).toThrow("JOINED_EVIDENCE_BOUNDARY_REFUSED");
      expect(canonicalAuthBudgetSnapshot(guardDatabase)).toEqual(beforeQueueProbe);
      expect(() => insertEventAuthority.run(
        unprovedSession.id,
        unprovedEvent.sequence,
        migratedSourceAuthority.providerAccountId,
        migratedSourceAuthority.profileId,
        migratedSourceAuthority.provider,
        migratedSourceAuthority.bindingGeneration,
        migratedSourceAuthority.processGeneration + 1,
        "legacy_session_runtime",
        61_100,
      )).toThrow("JOINED_EVIDENCE_BOUNDARY_REFUSED");
      expect(canonicalAuthBudgetSnapshot(guardDatabase)).toEqual(beforeQueueProbe);
      expect(() => insertEventAuthority.run(
        unprovedSession.id,
        unprovedEvent.sequence,
        migratedSourceAuthority.providerAccountId,
        migratedSourceAuthority.profileId,
        "claude",
        migratedSourceAuthority.bindingGeneration,
        migratedSourceAuthority.processGeneration,
        "legacy_session_runtime",
        61_100,
      )).toThrow("JOINED_EVIDENCE_BOUNDARY_REFUSED");
      expect(canonicalAuthBudgetSnapshot(guardDatabase)).toEqual(beforeQueueProbe);
      expect(guardDatabase.query(
        `SELECT provider_account_id,profile_id,provider,binding_generation,process_generation
         FROM session_event_provider_authorities
         WHERE session_id=? AND sequence=?`,
      ).get(unprovedSession.id, unprovedEvent.sequence)).toBeNull();
    } finally {
      guardDatabase.close(false);
    }

    const quarantines = inspector.query(
      `SELECT scope_kind,scope_id,reason
       FROM legacy_provider_authority_quarantines
       ORDER BY scope_kind,scope_id`,
    ).all();
    expect(quarantines).toContainEqual({
      reason: "conflicting_immutable_runtime_authority",
      scope_id: conflictingSession.id,
      scope_kind: "session",
    });
    expect(quarantines).toContainEqual({
      reason: "missing_immutable_runtime_authority",
      scope_id: unprovedSession.id,
      scope_kind: "session",
    });
    expect(quarantines).toContainEqual({
      reason: "missing_immutable_runtime_authority",
      scope_id: invalidLatestSession.id,
      scope_kind: "session",
    });
    expect(quarantines).toContainEqual({
      reason: "unsettled_provider_authority_unproved",
      scope_id: unprovedInteraction.publicId,
      scope_kind: "interaction",
    });
    expect(quarantines).toContainEqual({
      reason: "unsettled_provider_authority_unproved",
      scope_id: unprovedMutation.id,
      scope_kind: "mutation",
    });
    expect(quarantines).toContainEqual({
      reason: "missing_immutable_runtime_authority",
      scope_id: `${unprovedEvent.sessionId}:${String(unprovedEvent.sequence)}`,
      scope_kind: "session_event",
    });
    expect(quarantines).toContainEqual({
      reason: "unsettled_provider_authority_unproved",
      scope_id: unprovedQueue.id,
      scope_kind: "queue",
    });
    expect(inspector.query(
      "SELECT 1 FROM session_provider_authorities WHERE session_id=?",
    ).get(conflictingSession.id)).toBeNull();
    expect(inspector.query(
      "SELECT 1 FROM session_provider_authorities WHERE session_id=?",
    ).get(unprovedSession.id)).toBeNull();
    expect(inspector.query(
      "SELECT 1 FROM session_provider_authorities WHERE session_id=?",
    ).get(invalidLatestSession.id)).toBeNull();
      expect(retained.read()).toEqual(retained.before);
      const sessionSchema = z.object({ state: z.string(), revision: z.number(), updated_at: z.number() }).passthrough();
      expect(sessions.read().sessions).toEqual(z.array(sessionSchema).parse(sessions.before.sessions).map((row) =>
        row.state === "terminal" || row.state === "recovery_required" ? row
          : { ...row, state: "recovery_required", revision: row.revision + 1, updated_at: migratedAt }));
      const mutationSchema = z.object({ id: z.string(), state: z.string() }).passthrough();
      expect(mutations.read().mutation_attempts).toEqual(z.array(mutationSchema).parse(mutations.before.mutation_attempts).map((row) =>
        row.state === "effect_started" ? { ...row, state: "ambiguous", updated_at: migratedAt } : row));
      expect(inspector.query("SELECT * FROM session_provider_account_authorities").all()).toEqual([]);
      expect(inspector.query("SELECT id,codex_account_key FROM profiles ORDER BY created_at,id").all()).toEqual(
        [{ id: first.id, codex_account_key: null }, ...[signedIn, target, c.restartTarget].map((profile) => ({
          id: profile.id, codex_account_key: namedProviderAccountKey("codex", profile.providerEmail),
        }))],
      );
      expect(inspector.query("SELECT * FROM migrations WHERE version<=38 ORDER BY version").all()).toEqual([...captured.snapshot.ledger]);
      expect(inspector.query("PRAGMA foreign_key_check").all()).toEqual([]);
      expectCanonical35To38InertReopens(paths, inspector);
    } finally { inspector.close(false); }
  });
test("creates fresh databases at the latest append-only schema version", async () => {
    const { store } = await fixture({ provision: "migrate" });
    const inspector = new Database(store.paths.database, { readonly: true, strict: true });
    try {
      expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: 61 });
      expect(inspector.query("SELECT version FROM migrations ORDER BY version").all())
        .toEqual(Array.from({ length: 61 }, (_, index) => ({ version: index + 1 })));
      expect(inspector.query("PRAGMA table_info(account_rate_limit_reset_attempts)").all())
        .toContainEqual(expect.objectContaining({ name: "attempt_sequence", type: "INTEGER", pk: 1 }));
      expect(inspector.query("PRAGMA table_info(account_rate_limit_reset_attempts)").all())
        .toContainEqual(expect.objectContaining({ name: "idempotency_key", type: "TEXT", notnull: 1, pk: 0 }));
      const resetAttemptColumns = inspector
        .query("PRAGMA table_info(account_rate_limit_reset_attempts)").all();
      for (const expected of [
        { name: "origin_process_generation", type: "INTEGER", notnull: 1 },
        { name: "current_process_generation", type: "INTEGER", notnull: 1 },
        { name: "account_fingerprint", type: "TEXT", notnull: 1 },
      ]) expect(resetAttemptColumns).toContainEqual(expect.objectContaining(expected));
      expect(inspector.query("PRAGMA table_info(account_rate_limit_reset_rebinds)").all())
        .toContainEqual(expect.objectContaining({ name: "sequence", type: "INTEGER", pk: 1 }));
      const resetPolicyColumns = inspector
        .query("PRAGMA table_info(account_rate_limit_reset_policies)").all();
      for (const expected of [
        { name: "profile_id", type: "TEXT", notnull: 1, pk: 1 },
        { name: "state", type: "TEXT", notnull: 1 },
        { name: "account_fingerprint", type: "TEXT", notnull: 0 },
        { name: "weekly_window_resets_at", type: "INTEGER", notnull: 0 },
        { name: "revision", type: "INTEGER", notnull: 1 },
      ]) expect(resetPolicyColumns).toContainEqual(expect.objectContaining(expected));
      expect(inspector.query("PRAGMA table_info(session_adoption_policies)").all())
        .toContainEqual(expect.objectContaining({ name: "provider", type: "TEXT", pk: 1 }));
      const adoptionCandidateColumns = inspector
        .query("PRAGMA table_info(session_adoption_candidates)").all();
      expect(adoptionCandidateColumns)
        .toContainEqual(expect.objectContaining({ name: "liveness", type: "TEXT", notnull: 1 }));
      for (const name of ["source_pid", "source_pid_domain", "source_proc_start"]) {
        expect(adoptionCandidateColumns)
          .toContainEqual(expect.objectContaining({ name, notnull: 0 }));
      }
      expect(inspector.query(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='session_adoption_candidates_claude_reprobe'",
      ).get()).toEqual({ name: "session_adoption_candidates_claude_reprobe" });
      expect(inspector.query("PRAGMA table_info(session_personal_runtime_bindings)").all())
        .toContainEqual(expect.objectContaining({ name: "session_id", type: "TEXT", pk: 1 }));
      expect(inspector.query("PRAGMA table_info(profiles)").all())
        .toContainEqual(expect.objectContaining({ name: "label_key", type: "TEXT" }));
      expect(inspector.query("PRAGMA table_info(projects)").all())
        .toContainEqual(expect.objectContaining({ name: "label_key", type: "TEXT" }));
      expect(inspector.query(
        "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE '%label_key%' ORDER BY name",
      ).all()).toEqual([
        { name: "profiles_label_key_active" },
        { name: "projects_label_key_unique" },
      ]);
      expect(inspector.query("PRAGMA table_info(sessions)").all()).toContainEqual(expect.objectContaining({ name: "provider_updated_at", type: "REAL" }));
      expect(inspector.query("PRAGMA table_info(desktop_switches)").all()).toContainEqual(expect.objectContaining({ name: "switch_generation", type: "INTEGER" }));
      expect(inspector.query("PRAGMA table_info(usage_poll_failures)").all()).toContainEqual(expect.objectContaining({ name: "reason_code", type: "TEXT" }));
      expect(inspector.query("PRAGMA table_info(usage_poll_failures)").all()).toContainEqual(
        expect.objectContaining({ name: "account_fingerprint", type: "TEXT", notnull: 0 }),
      );
      expect(inspector.query("PRAGMA table_info(usage_cloud_upload_anchors)").all())
        .toContainEqual(expect.objectContaining({ name: "received_at", type: "INTEGER" }));
      expect(inspector.query("PRAGMA table_info(provider_interactions)").all())
        .toContainEqual(expect.objectContaining({ name: "deadline_at", type: "INTEGER", notnull: 1 }));
      expect(inspector.query("PRAGMA table_info(provider_interactions)").all())
        .toContainEqual(expect.objectContaining({ name: "intended_terminal_state", type: "TEXT" }));
      expect(inspector.query("PRAGMA table_info(provider_login_authorities)").all())
        .toContainEqual(expect.objectContaining({ name: "login_id", type: "TEXT", notnull: 1 }));
      const queueScrubPlan = inspector.query(
        `EXPLAIN QUERY PLAN
         SELECT 1
         FROM queue_entries
         WHERE message!='[queue message removed after settlement]'
           AND (
             state IN ('applied','failed','cancelled')
             OR EXISTS(
               SELECT 1 FROM queue_effect_resolutions r
               WHERE r.queue_id=queue_entries.id
             )
           )
         LIMIT 1`,
      ).all() as Array<{ detail: string }>;
      expect(queueScrubPlan.map((entry) => entry.detail).join(" "))
        .toContain("queue_entries_message_scrub_candidates");
      expect(inspector.query(
        "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'provider_interactions_mcp_url_guard_%' ORDER BY name",
      ).all()).toEqual([
        { name: "provider_interactions_mcp_url_guard_insert" },
        { name: "provider_interactions_mcp_url_guard_update" },
      ]);
      expect(inspector.query(
        "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'provider_interactions_listing_%' ORDER BY name",
      ).all()).toEqual([
        { name: "provider_interactions_listing_global" },
        { name: "provider_interactions_listing_pending_global" },
        { name: "provider_interactions_listing_pending_session" },
        { name: "provider_interactions_listing_session" },
      ]);
    } finally {
      inspector.close(false);
    }
  });
test("upgrades an exact captured v38 writer without changing presets or notifications while quarantining unproved adoption", async () => {
    const paths = await canonical35To38Archive("canonical38");
    const captured = canonical35To38Fixture.captures.canonical38;
    const retained = canonical35To38Fixture.input.retained;
    const database = new Database(paths.database, { create: false, strict: true });
    try {
      database.exec("PRAGMA query_only=ON");
      const before = canonicalAuthBudgetSnapshot(database);
      const history = canonicalAuthBudgetRows(database, ["profiles", "session_runtime_profiles", "queue_entries"]);
      const sessionRows = canonicalAuthBudgetRows(database, ["sessions"]);
      expect(database.query("SELECT name FROM sqlite_master WHERE name='provider_accounts'").get()).toBeNull();
      expect(() => new StateStore(paths, { readonly: true }))
        .toThrow("STATE_SCHEMA_MIGRATION_REQUIRED:38:61");
      expect(canonicalAuthBudgetSnapshot(database)).toEqual(before);

      const migratedAt = 90_000_000;
      const upgraded = new StateStore(paths, { now: () => migratedAt,
        resolveMachineTimeZone: () => { throw new Error("CAPTURED_V38_ZONE_MUST_NOT_BE_REPLACED"); },
      });
      stores.push(upgraded);
      expect(upgraded.readNotificationHours()).toEqual(captured.metadata.caseState.hours);
      expect(upgraded.readNotificationEmailPolicy()).toEqual(captured.metadata.caseState.email);
      expect(upgraded.requireSessionPresetContract(retained.session.id)).toBe(legacyPresetContract);
      expectHistoricalValue(upgraded.latestSessionRuntimeProfile(retained.session.id)?.profile, retained.runtime);
      expect(history.read()).toEqual(history.before);
      const originals = z.array(z.record(z.string(), z.unknown())).parse(sessionRows.before.sessions);
      // Both retained34 sessions lack native account-scope attestation: the
      // bound Sol row and the unbound queued row retain every other old cell.
      expect(sessionRows.read().sessions).toEqual(originals.map((row) => ({
        ...row, state: "recovery_required", revision: z.number().parse(row.revision) + 1, updated_at: migratedAt,
      })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))));
      expect(database.query("SELECT * FROM session_provider_account_authorities").all()).toEqual([]);
      expect(database.query("PRAGMA user_version").get()).toEqual({ user_version: 61 });
      expect(database.query("SELECT * FROM migrations WHERE version<=38 ORDER BY version").all())
        .toEqual([...captured.snapshot.ledger]);
      expect(database.query("PRAGMA foreign_key_check").all()).toEqual([]);
      expectCanonical35To38InertReopens(paths, database);
    } finally { database.close(false); }
  });
test("migrates captured canonical37 Sol runtime profiles without rewriting their durable JSON", async () => {
    const paths = await canonical35To38Archive("canonical37");
    const retained = canonical35To38Fixture.input.retained;
    const database = new Database(paths.database, { create: false, strict: true });
    try {
      database.exec("PRAGMA query_only=ON");
      const before = canonicalAuthBudgetSnapshot(database);
      const runtimeRows = canonicalAuthBudgetRows(database, ["session_runtime_profiles"]);
      expect(retained.runtime.model).toBe("gpt-5.6-sol");
      expect(database.query("SELECT profile_json FROM session_runtime_profiles WHERE session_id=?")
        .get(retained.session.id)).toEqual({ profile_json: JSON.stringify(retained.runtime) });
      expect(() => new StateStore(paths, { readonly: true }))
        .toThrow("STATE_SCHEMA_MIGRATION_REQUIRED:37:61");
      expect(canonicalAuthBudgetSnapshot(database)).toEqual(before);
      const migrated = new StateStore(paths, { now: () => 90_000_000,
        resolveMachineTimeZone: () => { throw new Error("CAPTURED_SOL_ZONE_MUST_NOT_BE_REPLACED"); },
      });
      stores.push(migrated);
      expectHistoricalValue(migrated.latestSessionRuntimeProfile(retained.session.id)?.profile, retained.runtime);
      expect(migrated.requireSessionPresetRequirement(retained.session.id)).toEqual({
        preset: "high", requirement: { model: "gpt-5.6-sol", effort: "max" },
      });
      expect(runtimeRows.read()).toEqual(runtimeRows.before);
      expect(database.query("SELECT * FROM session_provider_account_authorities WHERE session_id=?")
        .get(retained.session.id)).toBeNull();
      expect(database.query("PRAGMA user_version").get()).toEqual({ user_version: 61 });
      expect(database.query("PRAGMA foreign_key_check").all()).toEqual([]);
      expectCanonical35To38InertReopens(paths, database);
    } finally { database.close(false); }
  });
test("preserves authentic canonical39 Devin runtime and login bytes without borrowing a later Codex generation", async () => {
    const paths = await canonical39DevinArchive();
    // A copied WAL-mode main image needs SQLite to establish its local shared
    // memory files. This raw query-only observer never runs Oompa migrations.
    const database = new Database(paths.database, { create: false, strict: true });
    database.exec("PRAGMA query_only=ON");
    try {
      expect(database.query("PRAGMA user_version").get()).toEqual({ user_version: 39 });
      const ledger = database.query("SELECT * FROM migrations ORDER BY version").all();
      const readOriginalHistory = () => ({
        runtime: database.query("SELECT session_id,revision,source_kind,source_id,profile_id,process_generation,observed_at,profile_json,recorded_at FROM session_runtime_profiles ORDER BY session_id,revision").all(),
        evidence: database.query("SELECT attempt_id,kind,evidence_json,evidence_digest,recorded_at FROM mutation_effect_evidence ORDER BY attempt_id").all(),
      });
      const originalHistory = readOriginalHistory();
      expect(originalHistory.runtime).toHaveLength(2);
      expect(originalHistory.evidence).toHaveLength(2);
      const store = new StateStore(paths);
      stores.push(store);
      expect(database.query("SELECT * FROM migrations WHERE version<=39 ORDER BY version").all()).toEqual(ledger);
      expect(readOriginalHistory()).toEqual(originalHistory);
      for (const source of canonical39DevinFixture.cases) {
        const authority = store.requireProviderAccountAuthority(source.profile.id, "devin");
        expect(authority).toMatchObject({ provider: "devin", profileId: source.profile.id,
          bindingGeneration: 1, processGeneration: source.generation });
        expect(authority.providerAccountId).toMatch(/^dact_[0-9a-f]{32}$/u);
        expect(store.requireProviderAccountForProfile(source.profile.id, "devin").readiness).toBe("unverified");
        expect(store.requireCapturedSessionProviderAuthority(source.session.id)).toMatchObject(authority);
        expect(store.latestSessionRuntimeProfile(source.session.id)?.profile).toEqual(source.runtimeProfile);
        expect(store.readMutationProviderAuthorities(source.mutation.id)).toEqual([{
          role: "primary", authority, provenance: "legacy_account_devin_login",
        }]);
        store.nextProfileGeneration(source.profile.id);
        store.nextProfileGeneration(source.profile.id);
        expect(store.requireProviderAccountAuthority(source.profile.id, "devin")).toEqual(authority);
        expect(store.requireCapturedSessionProviderAuthority(source.session.id)).toMatchObject(authority);
      }
      expect(readOriginalHistory()).toEqual(originalHistory);
      const reader = new StateStore(paths, { readonly: true });
      stores.push(reader);
      for (const source of canonical39DevinFixture.cases) {
        expect(reader.latestSessionRuntimeProfile(source.session.id)?.profile).toEqual(source.runtimeProfile);
        expect(reader.requireProviderAccountAuthority(source.profile.id, "devin").processGeneration).toBe(source.generation);
      }
      expect(readOriginalHistory()).toEqual(originalHistory);
    } finally { database.close(false); }
  });
test("widens captured v38 provider columns while retaining the authentic generation-rebind history", async () => {
    const paths = await canonical38RuntimeArchive();
    const c = canonical38RuntimeFixture.retained;
    const inspector = new Database(paths.database, { create: false, strict: true });
    try {
      const before = canonicalAuthBudgetSnapshot(inspector);
      expect(inspector.query("SELECT name FROM pragma_table_info('sessions') WHERE name='provider_v39'").get()).toBeNull();
      const originalRebind = {
        attempt_id: c.pendingSwitch.attempt.id, profile_id: c.restartTarget.id, provider: "claude",
        from_generation: c.restartTarget.processGeneration, to_generation: c.advanced.profile.processGeneration,
        recorded_at: 38_200,
      };
      expect(inspector.query("SELECT * FROM session_mutation_authority_rebinds").all()).toEqual([originalRebind]);
      expect(originalRebind.from_generation + 1).toBe(originalRebind.to_generation);
      const retained = canonicalAuthBudgetRows(inspector, [
        "profiles", "queue_entries", "session_mutation_authority_rebinds", "session_runtime_profiles",
        "session_turn_runtime_profiles", "mutation_effect_evidence",
      ]);
      const sessions = canonicalAuthBudgetRows(inspector, ["sessions"]);
      const oldProviders = z.array(z.object({ id: z.string(), provider: z.string() }).strict())
        .parse(inspector.query("SELECT id,provider FROM sessions ORDER BY id").all());
      expect(() => { new StateStore(paths, { readonly: true }).close(); }).toThrow("STATE_SCHEMA_MIGRATION_REQUIRED:38:61");
      expect(canonicalAuthBudgetSnapshot(inspector)).toEqual(before);
      const migrated = new StateStore(paths, { now: () => 60_000, resolveMachineTimeZone: () => "UTC" });
      stores.push(migrated);
      expect(migrated.requireSession(c.codex.session.id)).toMatchObject({ provider: "codex", preset: "high" });
      expect(migrated.requireSession(c.claude.session.id)).toMatchObject({ provider: "claude", preset: "fable-max" });
      expect(migrated.requireQueue(c.unproved.queue.id).message).toBe(c.unproved.queue.message);
      expect(retained.read()).toEqual(retained.before);
      expect(inspector.query("SELECT id,provider,provider_v39 FROM sessions ORDER BY id").all())
        .toEqual(oldProviders.map((row) => ({ ...row, provider_v39: row.provider })));
      expect(inspector.query("SELECT * FROM session_mutation_authority_rebinds_v39").all()).toEqual([originalRebind]);
      expect(migrated.readMutation(c.pendingSwitch.key)?.evidence).toEqual(c.pendingSwitch.effect);
      expect(inspector.query("SELECT * FROM session_provider_account_authorities").all()).toEqual([]);
      const sessionSchema = z.object({ state: z.string(), revision: z.number() }).passthrough();
      expect(sessions.read().sessions).toEqual(z.array(sessionSchema).parse(sessions.before.sessions).map((row) =>
        row.state === "terminal" || row.state === "recovery_required" ? row
          : { ...row, state: "recovery_required", revision: row.revision + 1, updated_at: 60_000 }));
      // Historical widening stays readable. Devin is admitted again, so a new
      // Devin session starts under the current contract like any provider.
      const revived = migrated.createSession({ profileId: c.signedIn.id, provider: "devin",
        preset: "astra", fastEnabled: false });
      expect(revived).toMatchObject({ provider: "devin", preset: "astra" });
      const joined = canonicalAuthBudgetSnapshot(inspector);
      expect(() => inspector.query("INSERT INTO session_mutation_authority_rebinds_v39(attempt_id,profile_id,provider,from_generation,to_generation,recorded_at) VALUES (?,?,?,?,?,?)")
        .run(c.pendingSwitch.attempt.id, c.restartTarget.id, "devin",
          originalRebind.from_generation, originalRebind.to_generation, 60_001))
        .toThrow("session mutation provider successor authority mismatch");
      expect(() => inspector.query("UPDATE session_mutation_authority_rebinds_v39 SET recorded_at=recorded_at+1 WHERE attempt_id=? AND provider='claude'")
        .run(c.pendingSwitch.attempt.id)).toThrow("immutable");
      expect(canonicalAuthBudgetSnapshot(inspector)).toEqual(joined);
      expect(inspector.query("SELECT * FROM migrations WHERE version<=38 ORDER BY version").all()).toEqual([...canonical38RuntimeFixture.snapshot.ledger]);
      expect(inspector.query("PRAGMA foreign_key_check").all()).toEqual([]);
      expectCanonical35To38InertReopens(paths, inspector);
    } finally { inspector.close(false); }
  });
test("rejects a v39 Devin session persisted under the legacy preset contract", async () => {
    const paths = await canonical39DevinArchive();
    const source = canonical39DevinFixture.cases[0];
    const session = source.session;
    const partial = new Database(paths.database, { create: false, strict: true });
    try {
      const before = canonicalAuthBudgetSnapshot(partial);
      expect(before.version).toEqual({ user_version: 39 });
      expect(partial.query("SELECT provider_v39,preset_contract FROM sessions WHERE id=?").get(session.id))
        .toEqual({ provider_v39: "devin", preset_contract: 2 });
      // One explicitly adversarial old cell, not a new historical capture or
      // a relabeled current Codex session. Restore the exact captured trigger.
      partial.exec("PRAGMA ignore_check_constraints=ON");
      try {
        withRemovedTestGuards(partial, ["work_session_devin_contract_guard"], () => {
          expect(partial.query("UPDATE sessions SET preset_contract=? WHERE id=?")
            .run(legacyPresetContract, session.id).changes).toBe(1);
        });
      } finally { partial.exec("PRAGMA ignore_check_constraints=OFF"); }
      const after = canonicalAuthBudgetSnapshot(partial);
      expect(after.schema).toEqual(before.schema);
      for (const [table, rows] of Object.entries(before.rows)) {
        if (table !== "sessions") expect(after.rows[table]).toEqual(rows);
      }
    } finally {
      partial.close(false);
    }

    expectInertSchemaRefusal(paths, "STATE_SCHEMA_V39_DEVIN_PRESET_CONTRACT_INVALID:sessions",
      "STATE_SCHEMA_MIGRATION_REQUIRED:39:61");

    const inspector = new Database(paths.database, { readonly: true, strict: true });
    try {
      expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: 39 });
      expect(inspector.query(
        "SELECT provider_v39,preset_contract FROM sessions WHERE id=?",
      ).get(session.id)).toEqual({
        provider_v39: "devin",
        preset_contract: legacyPresetContract,
      });
      expect(inspector.query("SELECT version FROM migrations WHERE version=39").get()).toEqual({ version: 39 });
    } finally {
      inspector.close(false);
    }
  });
test("creates a fresh database before newer SQLite revalidates Work authority triggers", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "oompa-store-newer-sqlite-")));
    const repositoryRoot = join(import.meta.dir, "..", "..");
    const customSqliteCandidate = process.arch === "arm64"
      ? "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib"
      : "/usr/local/opt/sqlite/lib/libsqlite3.dylib";
    const customSqlite = process.platform === "darwin" && existsSync(customSqliteCandidate)
      ? customSqliteCandidate
      : "";
    const program = String.raw`
      import { Database } from "bun:sqlite";
      import { join } from "node:path";
      import { pathToFileURL } from "node:url";

      const [repositoryRoot, home, customSqlite] = Bun.argv.slice(1);
      if (customSqlite.length > 0 && !Database.setCustomSQLite(customSqlite)) {
        throw new Error("CUSTOM_SQLITE_CONFIGURATION_FAILED");
      }
      const versionProbe = new Database(":memory:");
      const sqliteVersion = versionProbe.query("SELECT sqlite_version() AS version").get().version;
      versionProbe.close(false);

      const pathsModule = await import(pathToFileURL(
        join(repositoryRoot, "src", "storage", "paths.ts"),
      ).href);
      const storeModule = await import(pathToFileURL(
        join(repositoryRoot, "src", "storage", "state-store.ts"),
      ).href);
      const paths = pathsModule.resolveStatePaths({
        homeDirectory: home,
        platform: process.platform === "linux" ? "linux" : "darwin",
      });
      await pathsModule.initializeStatePaths(paths);
      const store = new storeModule.StateStore(paths, {
        now: (() => { let value = 1_000; return () => value++; })(),
        resolveMachineTimeZone: () => "UTC",
      });
      store.close();

      const inspector = new Database(paths.database, { readonly: true, strict: true });
      const userVersion = inspector.query("PRAGMA user_version").get().user_version;
      const dependencyTables = inspector.query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ("
          + "'provider_accounts','provider_runtime_account_revocations','session_account_authorities',"
          + "'session_adoption_candidates','session_personal_runtime_bindings',"
          + "'session_provider_account_authorities','session_provider_authorities') ORDER BY name",
      ).all().map((row) => row.name);
      const profileColumns = inspector.query(
        "SELECT name FROM pragma_table_info('profiles') WHERE name='codex_account_key'",
      ).all().map((row) => row.name);
      const foreignKeyViolations = inspector.query("PRAGMA foreign_key_check").all().length;
      inspector.close(false);
      console.log(JSON.stringify({
        dependencyTables,
        foreignKeyViolations,
        profileColumns,
        sqliteVersion,
        userVersion,
      }));
    `;
    const child = Bun.spawn([
      process.execPath,
      "--eval",
      program,
      repositoryRoot,
      home,
      customSqlite,
    ], {
      cwd: repositoryRoot,
      env: {},
      stderr: "pipe",
      stdin: "ignore",
      stdout: "pipe",
    });
    const [exitCode, stderr, stdout] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
      new Response(child.stdout).text(),
    ]);

    expect(exitCode, stderr).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      dependencyTables: [
        "provider_accounts",
        "provider_runtime_account_revocations",
        "session_account_authorities",
        "session_adoption_candidates",
        "session_personal_runtime_bindings",
        "session_provider_account_authorities",
        "session_provider_authorities",
      ],
      foreignKeyViolations: 0,
      profileColumns: ["codex_account_key"],
      sqliteVersion: expect.stringMatching(/^3\./u),
      userVersion: 61,
    });
  });
test("migrates v34 through provider switch, notifications, contracts, and adoption v39", async () => {
    const paths = await canonical34StorageArchive();
    const source = canonical34StorageFixture.retained;
    const inspector = new Database(paths.database, { create: false, strict: true });
    inspector.exec("PRAGMA query_only=ON");
    try {
      const original = canonicalAuthBudgetSnapshot(inspector);
      const ledger = inspector.query("SELECT * FROM migrations ORDER BY version").all();
      const retained = canonicalAuthBudgetRows(inspector, [
        "profiles", "session_runtime_profiles", "queue_entries",
        "desktop_switches", "desktop_switch_resolutions", "desktop_switch_authority",
      ]);
      expect(original.version).toEqual({ user_version: 34 });
      expect(providerSwitchSchemaObjectCount(inspector)).toBe(0);
      expect(() => new StateStore(paths, { readonly: true }))
        .toThrow("STATE_SCHEMA_MIGRATION_REQUIRED:34:61");
      expect(canonicalAuthBudgetSnapshot(inspector)).toEqual(original);

      const migrated = new StateStore(paths, { now: () => 40_000 });
      stores.push(migrated);
      expectHistoricalValue(migrated.latestSessionRuntimeProfile(source.session.id), source.runtimeRecord);
      expect(migrated.requireSessionPresetRequirement(source.session.id)).toEqual({
        preset: "high", requirement: { model: "gpt-5.6-sol", effort: "max" },
      });
      // The separate unbound source never had a native account/runtime proof
      // or queue identity. Retain its input; no missing authority is invented.
      expect(migrated.requireQueue(source.unboundQueue.id)).toMatchObject(source.unboundQueue);
      expect(migrated.hasUnsettledQueueAttachmentQuarantineForSession(source.unboundSession.id)).toBe(true);
      expect(inspector.query("SELECT * FROM session_provider_account_authorities WHERE session_id=?")
        .all(source.unboundSession.id)).toEqual([]);
      expect(inspector.query("SELECT * FROM queue_attachment_identities WHERE queue_id=?")
        .all(source.unboundQueue.id)).toEqual([]);
      expect(retained.read()).toEqual(retained.before);
      expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: 61 });
      expect(inspector.query("SELECT * FROM migrations WHERE version<=34 ORDER BY version").all()).toEqual(ledger);
      expect(inspector.query("SELECT version,applied_at FROM migrations WHERE version>=35 ORDER BY version").all())
        .toEqual(Array.from({ length: 27 }, (_, index) => ({ version: index + 35, applied_at: 40_000 })));
      expect(providerSwitchSchemaObjectCount(inspector)).toBe(21);
      expect(inspector.query("SELECT name FROM sqlite_master WHERE type='table' AND name='session_adoption_policies'")
        .get()).toEqual({ name: "session_adoption_policies" });
      expect(inspector.query("PRAGMA foreign_key_check").all()).toEqual([]);
      const joined = canonicalAuthBudgetSnapshot(inspector);
      migrated.close();
      stores.splice(stores.indexOf(migrated), 1);
      for (const readonly of [false, true]) {
        const reopened = new StateStore(paths, { readonly, now: () => 40_001 });
        try {
          expectHistoricalValue(reopened.latestSessionRuntimeProfile(source.session.id), source.runtimeRecord);
          expect(retained.read()).toEqual(retained.before);
          expect(canonicalAuthBudgetSnapshot(inspector)).toEqual(joined);
        } finally { reopened.close(); }
      }
    } finally { inspector.close(false); }
  });
test("migrates an exact main35 writer through adoption and the joined60 ledger", async () => {
    const paths = await canonical35To38Archive("main35");
    const captured = canonical35To38Fixture.captures.main35;
    const database = new Database(paths.database, { create: false, strict: true });
    try {
      database.exec("PRAGMA query_only=ON");
      expect(database.query("SELECT name FROM sqlite_master WHERE name='session_provider_switch_targets'").get())
        .toEqual({ name: "session_provider_switch_targets" });
      expect(database.query("SELECT name FROM sqlite_master WHERE name='session_adoption_policies'").get()).toBeNull();
      const before = canonicalAuthBudgetSnapshot(database);
      const history = canonicalAuthBudgetRows(database, [
        "session_provider_switch_targets", "mutation_effect_evidence", "session_runtime_profiles", "queue_entries",
      ]);
      expect(() => new StateStore(paths, { readonly: true }))
        .toThrow("STATE_SCHEMA_MIGRATION_REQUIRED:35:61");
      expect(canonicalAuthBudgetSnapshot(database)).toEqual(before);
      let zoneReads = 0;
      const migrated = new StateStore(paths, { now: () => 90_000_000,
        resolveMachineTimeZone: () => { zoneReads++; return "UTC"; },
      });
      stores.push(migrated);
      expect(zoneReads).toBe(1);
      expect(history.read()).toEqual(history.before);
      expect(database.query("PRAGMA user_version").get()).toEqual({ user_version: 61 });
      expect(database.query("SELECT * FROM migrations ORDER BY version").all()).toEqual([
        ...captured.snapshot.ledger,
        ...Array.from({ length: 26 }, (_, index) => ({ version: index + 36, applied_at: 90_000_000 })),
      ]);
      expect(database.query(`SELECT name FROM sqlite_master WHERE type='table'
        AND name IN ('session_provider_switch_targets','session_adoption_policies') ORDER BY name`).all())
        .toEqual([{ name: "session_adoption_policies" }, { name: "session_provider_switch_targets" }]);
      expect(database.query("PRAGMA foreign_key_check").all()).toEqual([]);
      expectCanonical35To38InertReopens(paths, database);
    } finally { database.close(false); }
  });
test("migrates the exact protected-main provider-v39 predecessor to adoption v40", async () => {
    const paths = await canonical39DevinArchive();
    const source = canonical39DevinFixture.cases.find((entry) => entry.generation === 0);
    if (source === undefined) throw new Error("Expected archived canonical39 Devin session.");
    const session = source.session;

    const predecessor = new Database(paths.database, { create: false, strict: true });
    try {
      expect(predecessor.query("PRAGMA user_version").get()).toEqual({ user_version: 39 });
      expect(predecessor.query(
        "SELECT name FROM pragma_table_info('profiles') WHERE name='codex_account_key'",
      ).get()).toBeNull();
      expect(predecessor.query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='session_adoption_policies'",
      ).get()).toBeNull();
      expect(predecessor.query(
        "SELECT provider_v39,preset_contract FROM sessions WHERE id=?",
      ).get(session.id)).toEqual({ provider_v39: "devin", preset_contract: 2 });
    } finally {
      predecessor.close(false);
    }

    expect(() => new StateStore(paths, { readonly: true }))
      .toThrow("STATE_SCHEMA_MIGRATION_REQUIRED:39:61");
    const migrated = new StateStore(paths, { now: () => 2_000 });
    stores.push(migrated);
    expect(migrated.requireSession(session.id)).toMatchObject({
      provider: "devin",
      preset: "astra",
    });
    const inspector = new Database(paths.database, { readonly: true, strict: true });
    try {
      expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: 61 });
      expect(inspector.query(
        "SELECT version FROM migrations WHERE version>=39 ORDER BY version",
      ).all()).toEqual([
        { version: 39 }, { version: 40 }, { version: 41 },
        { version: 42 }, { version: 43 }, { version: 44 },
        { version: 45 }, { version: 46 }, { version: 47 },
        { version: 48 }, { version: 49 },
        ...Array.from({ length: 12 }, (_, index) => ({ version: index + 50 })),
      ]);
      expect(inspector.query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='session_adoption_policies'",
      ).get()).toEqual({ name: "session_adoption_policies" });
    } finally {
      inspector.close(false);
    }
  });
test("migrates exact timestamp-v41 Work guards to active Sol v42 without rewriting retired history", async () => {
    const paths = await retiredSuccessorArchive(41);
    const session = retiredSuccessorFixtures[41].retained.session;

    const predecessor = new Database(paths.database, { create: false, strict: true });
    let timestampGuardBefore: unknown;
    let sessionBefore: Record<string, unknown>;
    let pendingBefore: { id: string; message: string }[];
    try {
      expect(predecessor.query("PRAGMA user_version").get()).toEqual({ user_version: 41 });
      expect(predecessor.query(
        "SELECT version FROM migrations WHERE version>=40 ORDER BY version",
      ).all()).toEqual([{ version: 40 }, { version: 41 }]);
      timestampGuardBefore = predecessor.query(
        "SELECT type,tbl_name,sql FROM sqlite_master WHERE name='mutation_resolutions_timestamp_proof_insert'",
      ).get();
      sessionBefore = z.record(z.string(), z.unknown()).parse(
        predecessor.query("SELECT * FROM sessions WHERE id=?").get(session.id),
      );
      pendingBefore = z.array(z.object({ id: z.string(), message: z.string() }).strict()).parse(
        predecessor.query("SELECT id,message FROM queue_entries WHERE session_id=? AND state='pending' ORDER BY id")
          .all(session.id),
      );
      expect(pendingBefore.length).toBeGreaterThan(0);
      expect(sessionBefore.state).toBe("idle");
      expect(predecessor.query(
        "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='work_devin_preset_contract_guard'",
      ).get()).toEqual(expect.objectContaining({
        sql: expect.stringContaining("s.provider_v39='devin'"),
      }));
      expect(predecessor.query(
        "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='work_session_devin_contract_guard'",
      ).get()).toEqual(expect.objectContaining({
        sql: expect.stringContaining("FROM works AS w"),
      }));
    } finally {
      predecessor.close(false);
    }

    expect(() => new StateStore(paths, { readonly: true }))
      .toThrow("STATE_SCHEMA_MIGRATION_REQUIRED:41:61");
    const migrated = new StateStore(paths, { now: () => 2_000 });
    stores.push(migrated);
    expect(migrated.requireSession(session.id)).toMatchObject({
      provider: "devin",
      preset: "astra",
    });

    const inspector = new Database(paths.database, { readonly: true, strict: true });
    try {
      expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: 61 });
      expect(inspector.query(
        "SELECT version FROM migrations WHERE version>=40 ORDER BY version",
      ).all()).toEqual([{ version: 40 }, { version: 41 }, { version: 42 }, { version: 43 }, { version: 44 }, { version: 45 }, { version: 46 }, { version: 47 }, { version: 48 }, { version: 49 }, ...Array.from({ length: 12 }, (_, index) => ({ version: index + 50 }))]);
      expect(inspector.query(
        "SELECT type,tbl_name,sql FROM sqlite_master WHERE name='mutation_resolutions_timestamp_proof_insert'",
      ).get()).toEqual(timestampGuardBefore);
      expect(inspector.query("SELECT * FROM sessions WHERE id=?").get(session.id))
        .toEqual(withCanonicalSessionKey({
          ...sessionBefore,
          // The original pending queues lack immutable enqueue identity. The
          // joined migration contains them without changing their input or
          // granting dispatch authority; only these session projection cells
          // change, independently of the preserved timestamp/Work history.
          state: "recovery_required",
          revision: z.number().parse(sessionBefore.revision) + 1,
          updated_at: Math.max(z.number().parse(sessionBefore.updated_at), 2_000),
        }));
      for (const queue of pendingBefore) {
        expect(inspector.query("SELECT id,message FROM queue_entries WHERE id=?").get(queue.id)).toEqual(queue);
        expect(inspector.query("SELECT enqueue_identity_format FROM queue_entries WHERE id=?").get(queue.id))
          .toEqual({ enqueue_identity_format: null });
        expect(inspector.query("SELECT * FROM queue_attachment_quarantines WHERE queue_id=?").all(queue.id))
          .toEqual([{ queue_id: queue.id, ordinal: 1, session_id: session.id, kind: "quarantined",
            predecessor: null, expected_session_revision: null, reason: "legacy_identity_unproved", recorded_at: 2_000 }]);
        expect(inspector.query("SELECT 1 FROM queue_attachment_identities WHERE queue_id=?").get(queue.id)).toBeNull();
        expect(inspector.query("SELECT 1 FROM queue_attachment_identity_anchors WHERE queue_id=?").get(queue.id)).toBeNull();
      }
      const workGuard = z.object({ sql: z.string() }).parse(inspector.query(
        "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='work_devin_preset_contract_guard'",
      ).get()).sql;
      // The Work guard is rebuilt at open against the active contract (2, Astra).
      expect(workGuard).toContain("NEW.preset_contract!=2");
      expect(workGuard).not.toContain("provider_v39='devin'");
      const sessionGuard = z.object({ sql: z.string() }).parse(inspector.query(
        "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='work_session_devin_contract_guard'",
      ).get()).sql;
      expect(sessionGuard).toContain("NEW.preset_contract!=2");
      expect(sessionGuard).toContain("w.coordinator_session_id=NEW.id");
      expect(sessionGuard).not.toContain("w.coordinator_session_id=OLD.id");
    } finally {
      inspector.close(false);
    }
  });
test("migrates exact archived schema42 sources without claiming unavailable transcript events", async () => {
    const paths = await retiredSuccessorArchive(42);
    const source = retiredSuccessorFixtures[42].retained;
    const { session, appliedMutationKey, preparedMutationKey, dispatchingQueue,
      pendingQueue, laterPendingQueue, legacyAttachment } = source;
    const preparedDigest = source.preparedMutation.requestDigest;
    const predecessor = new Database(paths.database, { create: false, strict: true });
    try {
      // The exact archived schema42 public writer admitted this name. No current
      // authority tuple, schema version, or attachment row is rewritten here.
      expect(predecessor.query("SELECT name FROM message_attachments WHERE session_id=? AND source_id=?")
        .get(session.id, pendingQueue.id)).toEqual({ name: legacyAttachment.name });
      expect(predecessor.query("PRAGMA user_version").get()).toEqual({ user_version: 42 });
      expect(predecessor.query(
        "SELECT name FROM pragma_table_info('mutation_attempts') WHERE name='transcript_finalized'",
      ).get()).toBeNull();
      expect(predecessor.query(
        "SELECT name FROM pragma_table_info('queue_entries') WHERE name='transcript_finalized'",
      ).get()).toBeNull();
    } finally {
      predecessor.close(false);
    }

    expect(() => new StateStore(paths, { readonly: true }))
      .toThrow("STATE_SCHEMA_MIGRATION_REQUIRED:42:61");
    const migrated = new StateStore(paths, { now: () => 4_300 });
    stores.push(migrated);
    expect(migrated.hasSessionUserMessageSource(session.id, "mutation", appliedMutationKey)).toBe(false);
    expect(migrated.readSessionUserMessageSource(session.id, "mutation", appliedMutationKey))
      .toEqual({ status: "unavailable" });
    expect(migrated.hasSessionUserMessageSource(session.id, "mutation", preparedMutationKey)).toBe(false);
    expect(migrated.readMutation(preparedMutationKey)).toMatchObject({
      requestDigest: preparedDigest,
      state: "prepared",
    });
    expect(migrated.hasSessionUserMessageSource(session.id, "queue", dispatchingQueue.id)).toBe(false);
    expect(migrated.readSessionUserMessageSource(session.id, "queue", dispatchingQueue.id))
      .toEqual({ status: "unavailable" });
    expect(migrated.hasSessionUserMessageSource(session.id, "queue", pendingQueue.id)).toBe(false);
    expect(migrated.requireQueue(pendingQueue.id)).toMatchObject({ state: "pending" });
    expect(migrated.requireQueue(laterPendingQueue.id)).toMatchObject({ state: "pending" });
    expect(migrated.messageAttachmentManifest(session.id, pendingQueue.id)).toEqual([{
      byteLength: legacyAttachment.byteLength,
      digest: legacyAttachment.digest,
      mediaType: legacyAttachment.mediaType,
      name: "legacy�name.txt",
    }]);
    expect(migrated.attachmentCustody(legacyAttachment.digest))
      .toMatchObject({ referenceCount: 1 });
    expect(migrated.listSessionEvents({ sessionId: session.id, afterSequence: 0 }).events
      .filter((event) => event.body.type === "warning"))
      .toEqual([]);
    const inspector = new Database(paths.database, { readonly: true, strict: true });
    try {
      expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: 61 });
      expect(inspector.query("SELECT version FROM migrations WHERE version>=40 ORDER BY version").all())
        .toEqual([{ version: 40 }, { version: 41 }, { version: 42 }, { version: 43 }, { version: 44 }, { version: 45 }, { version: 46 }, { version: 47 }, { version: 48 }, { version: 49 }, ...Array.from({ length: 12 }, (_, index) => ({ version: index + 50 }))]);
      expect(inspector.query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='session_user_message_finalizations'",
      ).get()).toBeNull();
      // Historical43 installed the old scalar event guard. The final joined
      // schema must instead have the exact source-selected authority guards;
      // demanding the historical body here would discard that later fence.
      expect(() => auditJoinedEvidenceGuards(inspector)).not.toThrow();
    } finally {
      inspector.close(false);
    }
  });
test("upgrades exact shipped main v44 through auth v45, after-hours v46, peer v47, and canonical memory v48 without changing released authority", async () => {
    const paths = await canonicalAuthBudgetArchive(44);
    const captured = canonicalAuthBudgetFixtures[44].retained;
    const session = captured.fresh.session;
    const heldSession = captured.heldSession;
    const queued = captured.pending.queue;
    const predecessor = new Database(paths.database, { create: false, strict: true });
    try {
      expect(predecessor.query("PRAGMA user_version").get()).toEqual({ user_version: 44 });
      const quarantine = canonicalAuthBudgetPendingQuarantine(predecessor, 50_000);
      // These holds and charged reservations came from the archived44
      // migration/API. No current database is restamped as a predecessor.
      const stable = canonicalAuthBudgetRows(predecessor, [
        "profiles", "sessions", "session_runtime_profiles", "mutation_attempts", "mutation_effect_evidence",
        "session_autorespond_counters", "autorespond_budget_history", "autorespond_budget_reservations",
        "queue_entries",
      ]);
      const schemaBefore = canonicalAuthBudgetFrozenSchema(predecessor);
      const ledgerBefore = predecessor.query("SELECT * FROM migrations ORDER BY version").all();
      const beforeReadonly = canonicalAuthBudgetSnapshot(predecessor);
      expect(() => new StateStore(paths, { readonly: true })).toThrow("STATE_SCHEMA_MIGRATION_REQUIRED:44:61");
      expect(canonicalAuthBudgetSnapshot(predecessor)).toEqual(beforeReadonly);
      const upgraded = new StateStore(paths, { now: () => 50_000 });
      stores.push(upgraded);
      expect(predecessor.query("PRAGMA user_version").get()).toEqual({ user_version: 61 });
      expect(predecessor.query("SELECT * FROM migrations WHERE version<=44 ORDER BY version").all()).toEqual(ledgerBefore);
      expect(predecessor.query("SELECT * FROM migrations WHERE version>44 ORDER BY version").all())
        .toEqual(Array.from({ length: 17 }, (_, index) => ({ version: index + 45, applied_at: 50_000 })));
      for (const row of schemaBefore) expect(canonicalAuthBudgetFrozenSchema(predecessor)).toContainEqual(row);
      expect(stable.read()).toEqual({ ...stable.before, sessions: quarantine.sessions });
      quarantine.assertInstalled(upgraded);
      expect(upgraded.readAutorespondBudgets(session.id)).toEqual({ consecutive: 2, lastHour: 1, lastDay: 1 });
      expect(upgraded.readAutorespondBudgetHistoryAvailableAt(session.id)).toBeNull();
      expect(upgraded.readAutorespondBudgetHistoryAvailableAt(heldSession.id)).toBe(captured.legacyAvailableAt);
      expect(captured.legacyAvailableAt).toBe(86_444_000);
      expect(predecessor.query("SELECT message_actor,peer_action_id FROM queue_entries WHERE id=?").get(queued.id))
        .toEqual({ message_actor: "human", peer_action_id: null });
      expect(upgraded.readSessionUserMessageSource(session.id, "queue", queued.id)).toEqual(captured.pending.source);
      expect(predecessor.query(
        "SELECT name FROM sqlite_master WHERE name IN ('session_peer_policies','memory_submissions','project_memory_sync_intents') ORDER BY name",
      ).all()).toEqual([
        { name: "memory_submissions" }, { name: "project_memory_sync_intents" }, { name: "session_peer_policies" },
      ]);
      const after = canonicalAuthBudgetSnapshot(predecessor);
      for (const readonly of [false, true]) {
        const reopened = new StateStore(paths, { readonly, now: () => 50_001 });
        stores.push(reopened);
        expect(reopened.requireSession(session.id)).toEqual(upgraded.requireSession(session.id));
        expect(canonicalAuthBudgetSnapshot(predecessor)).toEqual(after);
      }
    } finally { predecessor.close(false); }
  });
test("upgrades populated exact main v46 through peer v47 and canonical memory v48 without changing consent, budgets, or history", async () => {
    const paths = await canonicalAuthBudgetArchive(46);
    const captured = canonicalAuthBudgetFixtures[46].retained;
    const session = captured.fresh.session;
    const queued = captured.pending.queue;
    const predecessor = new Database(paths.database, { create: false, strict: true });
    try {
      expect(predecessor.query("PRAGMA user_version").get()).toEqual({ user_version: 46 });
      const quarantine = canonicalAuthBudgetPendingQuarantine(predecessor, 52_000);
      const stable = canonicalAuthBudgetRows(predecessor, [
        "autorespond_after_hours_policy", "autorespond_after_hours_history",
        "session_autorespond_counters", "autorespond_budget_history", "autorespond_budget_reservations",
        "profiles", "sessions", "session_runtime_profiles", "queue_entries",
        "mutation_attempts", "mutation_effect_evidence", "account_mutation_authority_rebinds", "provider_login_authorities",
      ]);
      const schemaBefore = canonicalAuthBudgetFrozenSchema(predecessor);
      const ledgerBefore = predecessor.query("SELECT * FROM migrations ORDER BY version").all();
      const beforeReadonly = canonicalAuthBudgetSnapshot(predecessor);
      expect(() => new StateStore(paths, { readonly: true })).toThrow("STATE_SCHEMA_MIGRATION_REQUIRED:46:61");
      expect(canonicalAuthBudgetSnapshot(predecessor)).toEqual(beforeReadonly);
      const upgraded = new StateStore(paths, { now: () => 52_000 });
      stores.push(upgraded);
      expect(predecessor.query("PRAGMA user_version").get()).toEqual({ user_version: 61 });
      expect(predecessor.query("SELECT * FROM migrations WHERE version<=46 ORDER BY version").all()).toEqual(ledgerBefore);
      expect(predecessor.query("SELECT * FROM migrations WHERE version>46 ORDER BY version").all())
        .toEqual(Array.from({ length: 15 }, (_, index) => ({ version: index + 47, applied_at: 52_000 })));
      expect(stable.read()).toEqual({ ...stable.before, sessions: quarantine.sessions });
      quarantine.assertInstalled(upgraded);
      for (const row of schemaBefore) expect(canonicalAuthBudgetFrozenSchema(predecessor)).toContainEqual(row);
      expect(predecessor.query("SELECT message_actor,peer_action_id FROM queue_entries WHERE id=?").get(queued.id))
        .toEqual({ message_actor: "human", peer_action_id: null });
      expect(upgraded.readSessionUserMessageSource(session.id, "queue", queued.id)).toEqual(captured.pending.source);
      expect(upgraded.readAutorespondAfterHoursPolicy()).toEqual(captured.policy);
      expect(captured.policy).toEqual({ kind: "autorespond_after_hours", version: 1, revision: 2, enabled: true });
      expect(upgraded.readAutorespondBudgets(session.id)).toEqual({ consecutive: 1, lastHour: 1, lastDay: 1 });
      expect(predecessor.query(
        "SELECT name FROM sqlite_master WHERE name IN ('session_peer_policies','memory_submissions','project_memory_sync_intents') ORDER BY name",
      ).all()).toEqual([
        { name: "memory_submissions" }, { name: "project_memory_sync_intents" }, { name: "session_peer_policies" },
      ]);
      const after = canonicalAuthBudgetSnapshot(predecessor);
      for (const readonly of [false, true]) {
        const reopened = new StateStore(paths, { readonly, now: () => 52_001 });
        stores.push(reopened);
        expect(reopened.readAutorespondAfterHoursPolicy()).toEqual(captured.policy);
        expect(canonicalAuthBudgetSnapshot(predecessor)).toEqual(after);
      }
    } finally { predecessor.close(false); }
  });
test("upgrades exact auth v45 through after-hours v46 and memory v47/v48 without rewriting a live successor chain or retained transcript", async () => {
    const paths = await canonicalAuthBudgetArchive(45);
    const captured = canonicalAuthBudgetFixtures[45].retained;
    const { cancellation, cancellationKey: key, loginId, loginProfile: profile } = captured;
    const session = captured.fresh.session;
    const queued = captured.pending.queue;
    const inspector = new Database(paths.database, { create: false, strict: true });
    try {
      expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: 45 });
      const quarantine = canonicalAuthBudgetPendingQuarantine(inspector, 51_000);
      const stable = canonicalAuthBudgetRows(inspector, [
        "profiles", "sessions", "session_runtime_profiles", "mutation_attempts", "mutation_effect_evidence",
        "mutation_resolutions", "provider_login_authorities", "account_mutation_authority_rebinds",
        "session_autorespond_counters", "autorespond_budget_history", "autorespond_budget_reservations", "queue_entries",
      ]);
      const schemaBefore = canonicalAuthBudgetFrozenSchema(inspector);
      const ledgerBefore = inspector.query("SELECT * FROM migrations ORDER BY version").all();
      const columnsBefore = inspector.query("PRAGMA table_info(queue_entries)").all();
      expect(inspector.query("SELECT attempt_id,profile_id,kind,from_generation,to_generation FROM account_mutation_authority_rebinds").all())
        .toEqual([{ attempt_id: cancellation.id, profile_id: profile.id, kind: "account.login-cancel", from_generation: 1, to_generation: 2 }]);
      const beforeReadonly = canonicalAuthBudgetSnapshot(inspector);
      expect(() => new StateStore(paths, { readonly: true })).toThrow("STATE_SCHEMA_MIGRATION_REQUIRED:45:61");
      expect(canonicalAuthBudgetSnapshot(inspector)).toEqual(beforeReadonly);
      const upgraded = new StateStore(paths, { now: () => 51_000 });
      stores.push(upgraded);
      expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: 61 });
      expect(inspector.query("SELECT * FROM migrations WHERE version<=45 ORDER BY version").all()).toEqual(ledgerBefore);
      expect(inspector.query("SELECT * FROM migrations WHERE version>45 ORDER BY version").all())
        .toEqual(Array.from({ length: 16 }, (_, index) => ({ version: index + 46, applied_at: 51_000 })));
      for (const row of schemaBefore) expect(canonicalAuthBudgetFrozenSchema(inspector)).toContainEqual(row);
      expect(stable.read()).toEqual({ ...stable.before, sessions: quarantine.sessions });
      quarantine.assertInstalled(upgraded);
      const columnsAfter = inspector.query("PRAGMA table_info(queue_entries)").all();
      expect(columnsAfter.slice(0, columnsBefore.length)).toEqual(columnsBefore);
      // The canonical peer additions precede the joined queue-custody tail.
      expect(columnsAfter.slice(columnsBefore.length, columnsBefore.length + 2)).toEqual([
        expect.objectContaining({ name: "message_actor", type: "TEXT", notnull: 1, dflt_value: "'human'" }),
        expect.objectContaining({ name: "peer_action_id", type: "TEXT", notnull: 0 }),
      ]);
      expect(inspector.query("SELECT message_actor,peer_action_id FROM queue_entries WHERE id=?").get(queued.id))
        .toEqual({ message_actor: "human", peer_action_id: null });
      expect(upgraded.readSessionUserMessageSource(session.id, "queue", queued.id)).toEqual(captured.pending.source);
      const exactOrigin = { attemptId: cancellation.id, profileId: profile.id, originGeneration: 1 };
      expect(upgraded.isAccountMutationAuthorityCurrent(exactOrigin)).toBe(true);
      expect(upgraded.readPendingLoginAuthority(profile.id, 2)?.loginId).toBe(loginId);
      expect(upgraded.readMutation(key)).toMatchObject({ authorityGeneration: 1, state: "ambiguous" });
      const after = canonicalAuthBudgetSnapshot(inspector);
      for (const readonly of [false, true]) {
        const reopened = new StateStore(paths, { readonly, now: () => 51_001 });
        stores.push(reopened);
        expect(reopened.isAccountMutationAuthorityCurrent(exactOrigin)).toBe(true);
        expect(canonicalAuthBudgetSnapshot(inspector)).toEqual(after);
      }
      expect(() => inspector.query("UPDATE account_mutation_authority_rebinds SET recorded_at=50000 WHERE attempt_id=?").run(cancellation.id)).toThrow("immutable");
      expect(() => inspector.query("DELETE FROM account_mutation_authority_rebinds WHERE attempt_id=?").run(cancellation.id)).toThrow("immutable");
      const effects = inspector.query("SELECT * FROM mutation_effect_evidence ORDER BY attempt_id").all();
      upgraded.nextDaemonGeneration(`boot_${"e".repeat(32)}`);
      expect(upgraded.isAccountMutationAuthorityCurrent(exactOrigin)).toBe(true);
      expect(upgraded.readPendingLoginAuthority(profile.id, 3)?.loginId).toBe(loginId);
      expect(inspector.query("SELECT from_generation,to_generation FROM account_mutation_authority_rebinds WHERE attempt_id=? ORDER BY from_generation").all(cancellation.id))
        .toEqual([{ from_generation: 1, to_generation: 2 }, { from_generation: 2, to_generation: 3 }]);
      expect(inspector.query("SELECT * FROM mutation_effect_evidence ORDER BY attempt_id").all()).toEqual(effects);
      expect(upgraded.readMutation(key)).toMatchObject({ authorityGeneration: 1, state: "ambiguous" });
    } finally { inspector.close(false); }
  });
test("normalizes pre-release v43 attachment names without losing pending or effect-crossed messages", async () => {
    const paths = await canonicalBudgetArchive(43);
    const { session, attachments, queues } = canonicalBudgetFixtures[43].retained;
    const [attachment] = attachments.pending;
    const [dispatchedAttachment] = attachments.dispatched;
    const queued = queues.pending;
    const dispatched = queues.dispatched;

    const unsafeName = `pre-release${String.fromCodePoint(0x2029)}name.txt`;
    const predecessor = new Database(paths.database, { create: false, strict: true });
    try {
      corruptCanonical43Rows(predecessor, ["message_attachments", "queue_entries"],
        ["message_attachments_immutable_update", "queue_transcript_finalization_guard"], () => {
          for (const sourceId of [queued.id, dispatched.id]) {
            predecessor.query("UPDATE message_attachments SET name=? WHERE session_id=? AND source_id=?")
              .run(unsafeName, session.id, sourceId);
            predecessor.query(`UPDATE queue_entries SET transcript_intent_json=json_set(
              transcript_intent_json,'$.attachments[0].name',?) WHERE id=?`).run(unsafeName, sourceId);
          }
        });
    } finally {
      predecessor.close(false);
    }

    expectCanonical43ReadonlyRefusal(paths);
    const repaired = new StateStore(paths, { now: () => 44_001 });
    stores.push(repaired);
    expect(repaired.requireQueue(queued.id)).toMatchObject({
      message: "pre-release pending queue",
      state: "pending",
    });
    expect(repaired.readSessionUserMessageSource(session.id, "queue", queued.id)).toEqual({
      status: "pending",
      intent: expect.objectContaining({
        actor: "human",
        attachments: [expect.objectContaining({ name: "pre-release�name.txt" })],
        text: "pre-release pending queue",
        version: 1,
      }),
    });
    expect(repaired.messageAttachmentManifest(session.id, queued.id)).toEqual([{
      byteLength: attachment.byteLength,
      digest: attachment.digest,
      mediaType: attachment.mediaType,
      name: "pre-release�name.txt",
    }]);
    expect(repaired.attachmentCustody(attachment.digest)).toMatchObject({ referenceCount: 1 });
    expect(repaired.requireQueue(dispatched.id)).toMatchObject({
      message: "pre-release effect-crossed queue",
      state: "dispatching",
    });
    expect(repaired.readSessionUserMessageSource(session.id, "queue", dispatched.id))
      .toMatchObject({
        intent: expect.objectContaining({
          attachments: [expect.objectContaining({ name: "pre-release�name.txt" })],
          text: "pre-release effect-crossed queue",
        }),
        status: "pending",
      });
    expect(repaired.messageAttachmentManifest(session.id, dispatched.id)[0]?.name)
      .toBe("pre-release�name.txt");
    expect(repaired.attachmentCustody(dispatchedAttachment.digest))
      .toMatchObject({ referenceCount: 1 });

    repaired.close();
    stores.splice(stores.indexOf(repaired), 1);
    const reopened = new StateStore(paths, { now: () => 44_002 });
    stores.push(reopened);
    expect(reopened.readSessionUserMessageSource(session.id, "queue", queued.id))
      .toMatchObject({ status: "pending" });
    expect(reopened.messageAttachmentManifest(session.id, queued.id)[0]?.name)
      .toBe("pre-release�name.txt");
  });
test("normalizes colliding v43 manifest and pending-intent names without collapsing positions", async () => {
    const paths = await canonicalBudgetArchive(43);
    const { session, attachments, queues } = canonicalBudgetFixtures[43].retained;
    const digest = attachments.collisions[0].digest;
    const queued = queues.collisions;

    const predecessorNames = [
      `same${String.fromCodePoint(0x2028)}name.txt`,
      `same${String.fromCodePoint(0x2029)}name.txt`,
      "same�name.txt",
    ];
    const damaged = new Database(paths.database, { create: false, strict: true });
    try {
      corruptCanonical43Rows(damaged, ["message_attachments", "queue_entries"],
        ["message_attachments_immutable_update", "queue_transcript_finalization_guard"], () => {
          for (const [position, name] of predecessorNames.entries()) {
            damaged.query(`UPDATE message_attachments SET name=? WHERE session_id=? AND source_id=? AND position=?`)
              .run(name, session.id, queued.id, position);
            damaged.query(`UPDATE queue_entries SET transcript_intent_json=json_set(transcript_intent_json,?,?) WHERE id=?`)
              .run(`$.attachments[${String(position)}].name`, name, queued.id);
          }
        });
    } finally {
      damaged.close(false);
    }

    expectCanonical43ReadonlyRefusal(paths);
    const repaired = new StateStore(paths, { now: () => 44_002 });
    stores.push(repaired);
    const expectedNames = [
      "same�name~1.txt",
      "same�name~2.txt",
      "same�name.txt",
    ];
    expect(repaired.messageAttachmentManifest(session.id, queued.id)
      .map(({ name }) => name)).toEqual(expectedNames);
    const source = repaired.readSessionUserMessageSource(session.id, "queue", queued.id);
    expect(source).toMatchObject({ status: "pending" });
    if (
      source.status !== "pending"
      || source.intent === undefined
      || !("text" in source.intent)
    ) throw new Error("Expected a pending transcript intent.");
    expect(source.intent.attachments?.map(({ name }) => name)).toEqual(expectedNames);
    expect(repaired.attachmentCustody(digest)).toMatchObject({ referenceCount: 3 });
  });
test("rejects a missing v43 queue-cancellation guard on readonly open and repairs it on writable open", async () => {
    const paths = await canonicalBudgetArchive(43);
    const damaged = new Database(paths.database, { create: false, strict: true });
    try {
      // Deliberate missing-guard adversary on the real canonical43 capture.
      damaged.exec("DROP TRIGGER queue_transcript_cancellation_settlement");
    } finally {
      damaged.close(false);
    }

    expectCanonical43ReadonlyRefusal(paths);
    const repaired = new StateStore(paths);
    stores.push(repaired);
    const inspector = new Database(paths.database, { readonly: true, strict: true });
    try {
      expect(inspector.query(
        `SELECT type FROM sqlite_master
         WHERE name='queue_transcript_cancellation_settlement'`,
      ).get()).toEqual({ type: "trigger" });
    } finally {
      inspector.close(false);
    }
  });
test("upgrades the exact pre-rebind v43 queue transcript guard on writable open only", async () => {
    const paths = await canonicalBudgetArchive(43);
    const predecessor = new Database(paths.database, { create: false, strict: true });
    try {
      // Deliberate exact legacy guard variant, not a historical writer claim.
      const trigger = z.object({ sql: z.string() }).strict().parse(predecessor.query(
        `SELECT sql FROM sqlite_master
         WHERE type='trigger' AND name='queue_transcript_finalization_guard'`,
      ).get());
      const start = trigger.sql.indexOf("  OR (OLD.state='pending' AND NEW.state='pending'");
      const end = trigger.sql.indexOf(
        "\n  OR (OLD.transcript_status='pending' AND OLD.transcript_finalized=0\n"
          + "    AND NEW.transcript_status='finalized'",
        start,
      );
      expect(start).toBeGreaterThan(0);
      expect(end).toBeGreaterThan(start);
      const legacySql = trigger.sql.slice(0, start) + trigger.sql.slice(end);
      predecessor.exec("DROP TRIGGER queue_transcript_finalization_guard");
      predecessor.exec(legacySql);
    } finally {
      predecessor.close(false);
    }

    expectCanonical43ReadonlyRefusal(paths);
    const upgraded = new StateStore(paths);
    stores.push(upgraded);
    const inspector = new Database(paths.database, { readonly: true, strict: true });
    try {
      expect(z.object({ sql: z.string() }).strict().parse(inspector.query(
        `SELECT sql FROM sqlite_master
         WHERE type='trigger' AND name='queue_transcript_finalization_guard'`,
      ).get()).sql).toContain("OLD.state='pending' AND NEW.state='pending'");
    } finally {
      inspector.close(false);
    }
  });
test("retroactively settles a cancelled v43 queue before accepting its authority surface", async () => {
    const paths = await canonicalBudgetArchive(43);
    const { session, attachments, queues } = canonicalBudgetFixtures[43].retained;
    const [attachment] = attachments.cancelled;
    const queued = queues.cancelled;

    const damaged = new Database(paths.database, { create: false, strict: true });
    try {
      corruptCanonical43Rows(damaged, ["message_attachments", "queue_entries", "queue_message_scrub_authority"],
        ["message_attachments_immutable_update", "queue_transcript_cancellation_settlement", "queue_transcript_finalization_guard"], () => {
          const unsafeName = `cancelled${String.fromCodePoint(0x2028)}v43.txt`;
          damaged.query("UPDATE message_attachments SET name=? WHERE session_id=? AND source_id=?")
            .run(unsafeName, session.id, queued.id);
          damaged.query(`UPDATE queue_entries SET transcript_intent_json=json_set(
            transcript_intent_json,'$.attachments[0].name',?) WHERE id=?`).run(unsafeName, queued.id);
          damaged.query("UPDATE queue_entries SET state='cancelled' WHERE id=? AND state='pending'").run(queued.id);
          damaged.query("DELETE FROM queue_message_scrub_authority WHERE singleton=1").run();
        });
    } finally {
      damaged.close(false);
    }

    expectCanonical43ReadonlyRefusal(paths);
    const repaired = new StateStore(paths, { now: () => 44_003 });
    stores.push(repaired);
    expect(repaired.requireQueue(queued.id)).toMatchObject({ state: "cancelled" });
    expect(repaired.readSessionUserMessageSource(session.id, "queue", queued.id)).toEqual({
      status: "abandoned",
      intent: { actor: "human", hadAttachments: true, version: 1 },
    });
    expect(repaired.messageAttachmentManifest(session.id, queued.id)).toEqual([]);
    expect(repaired.attachmentCustody(attachment.digest)).toMatchObject({ referenceCount: 0 });
  });
test("refuses a colliding session-event authority guard during v43 migration", async () => {
    const paths = await retiredSuccessorArchive(42);
    const predecessor = new Database(paths.database, { create: false, strict: true });
    let schemaBefore: unknown[] = [];
    try {
      expect(predecessor.query("PRAGMA user_version").get()).toEqual({ user_version: 42 });
      predecessor.exec(`
        DROP TRIGGER session_events_account_authority_guard;
        CREATE TRIGGER session_events_account_authority_guard
        BEFORE INSERT ON session_events BEGIN SELECT 1; END;
      `);
      schemaBefore = predecessor.query(
        "SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name",
      ).all();
    } finally {
      predecessor.close(false);
    }

    expect(() => new StateStore(paths))
      .toThrow("STATE_SCHEMA_V43_SESSION_EVENT_AUTHORITY_GUARD_COLLISION");
    const inspector = new Database(paths.database, { readonly: true, strict: true });
    try {
      expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: 42 });
      expect(inspector.query(
        "SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name",
      ).all()).toEqual(schemaBefore);
    } finally {
      inspector.close(false);
    }
  });
});
