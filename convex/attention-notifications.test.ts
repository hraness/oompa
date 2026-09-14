import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { makeFunctionReference } from "convex/server";
import type { Value } from "convex/values";
import { convexTest } from "convex-test";

import type { CanonicalAuthEmail } from "../src/cloud/authCredentials";
import { sha256Hex } from "../src/cloud/crypto";
import { buildOompaAttentionEmailBody, type OompaAttentionEmailBody } from "./attentionEmail";
import {
  attentionNotificationQuotaReservations,
  attentionNotificationRetryRecoveryMs,
} from "./attentionNotifications";
import { digestAuthEmail } from "./authEmail";
import { ATTENTION_NOTIFICATION_TERMINAL_RETENTION_MS } from "./lifecyclePolicy";
import {
  adjustCommandQuotaForPatch,
  CATEGORY_QUOTAS,
  initializeUserQuotaAuthority,
  logicalDocumentBytes,
  releaseCommandQuotaForDelete,
  reserveDeviceQuotaForInsert,
  reserveQuotaForInsert,
  reserveQuotaForStoredIdentity,
  reserveServiceQuotaForInsert,
  reserveSessionHeadQuotaForInsert,
  SERVICE_TOTAL_QUOTA,
  USER_TOTAL_QUOTA,
} from "./quota";
import schema from "./schema";
import {
  oompaAttentionResendApiKeyEnvironmentName,
  oompaResendApiKeyEnvironmentName,
} from "./resendApiKey";
import { modules } from "./test.setup";

type Args = Readonly<Record<string, Value>>;
const genesis = makeFunctionReference<"mutation", Args, unknown>(
  "quota:genesisHardAuthority",
);
const transition = makeFunctionReference<"mutation", Args, unknown>(
  "attentionNotificationControl:transition",
);
const acknowledgeSafetyFault = makeFunctionReference<"mutation", Args, unknown>(
  "attentionNotificationControl:acknowledgeSafetyFault",
);
const reconcile = makeFunctionReference<"mutation", Args, Readonly<{
  acknowledgedAt: number;
  candidateCount?: number;
  consentLeaseUntil: number;
  state: "complete" | "invalidated";
}>>("attentionNotifications:reconcile");
type AuthorityStatus = Readonly<{
  deviceAuthority: null | Readonly<{
    consentLeaseUntil: number;
    globalNotificationGeneration: number;
    localNotificationPolicyRevision: number;
    reconciliationSequence: number;
  }>;
  enabled: boolean;
  globalNotificationGeneration: number;
  observedAt: number;
  safetyFaultState: "latched" | "none" | "reviewed";
}>;
const authorityStatus = makeFunctionReference<"mutation", Args, AuthorityStatus>(
  "attentionNotifications:authorityStatus",
);
const claimNext = makeFunctionReference<"mutation", Args, unknown>(
  "attentionNotifications:claimNext",
);
const drainNotifications = makeFunctionReference<"action", Args, Readonly<{
  claimed: number;
  closed: number;
  processed: number;
}>>("attentionNotificationDelivery:drain");
const settleAttempt = makeFunctionReference<"mutation", Args, unknown>(
  "attentionNotifications:settleAttempt",
);
const readControlStatus = makeFunctionReference<"query", Args, Readonly<{
  enabled: boolean;
  generation: number;
  safetyFault: null | Readonly<{
    deliveryId: string;
    faultId: string;
    reason: "invalid_idempotent_request" | "stored_delivery_corrupt";
    resultDigest: string;
    state: "latched" | "reviewed";
  }>;
}>>("attentionNotificationControl:status");
const quarantineFaultedDelivery = makeFunctionReference<"mutation", Args, unknown>(
  "attentionNotifications:quarantineFaultedDelivery",
);
const cleanupExpired = makeFunctionReference<"mutation", Args, unknown>(
  "maintenance:cleanupExpired",
);
const drainAccountDeletion = makeFunctionReference<"mutation", Args, unknown>(
  "accountDeletion:drain",
);

const hmacEnvironmentName = "OOMPA_AUTH_HMAC_SECRET";
let originalHmacSecret: string | undefined;
let originalAttentionKey: string | undefined;
let originalAuthKey: string | undefined;

beforeEach(() => {
  originalHmacSecret = process.env[hmacEnvironmentName];
  originalAttentionKey = process.env[oompaAttentionResendApiKeyEnvironmentName];
  originalAuthKey = process.env[oompaResendApiKeyEnvironmentName];
  process.env[hmacEnvironmentName] = "attention-notification-test-secret-at-least-thirty-two-characters";
  process.env[oompaAttentionResendApiKeyEnvironmentName] = "re_notice_test";
  process.env[oompaResendApiKeyEnvironmentName] = "re_auth_test";
});

afterEach(() => {
  if (originalHmacSecret === undefined) Reflect.deleteProperty(process.env, hmacEnvironmentName);
  else process.env[hmacEnvironmentName] = originalHmacSecret;
  for (const [name, value] of [
    [oompaAttentionResendApiKeyEnvironmentName, originalAttentionKey],
    [oompaResendApiKeyEnvironmentName, originalAuthKey],
  ] as const) {
    if (value === undefined) Reflect.deleteProperty(process.env, name);
    else process.env[name] = value;
  }
});

const envelope = (ciphertext: string) => ({
  algorithm: "A256GCM" as const,
  ciphertext,
  keyVersion: 1,
  nonce: "N".repeat(16),
});

const enableMutationId = "01912345-6789-7abc-8def-0123456789a1";

type World = Awaited<ReturnType<typeof notificationWorld>>;

async function safetyFaults(world: World) {
  return await world.runtime.run(async (ctx) =>
    await ctx.db.query("attentionNotificationSafetyFaults").collect());
}

async function notificationWorld() {
  const runtime = convexTest(schema, modules);
  await runtime.mutation(genesis, {});
  await runtime.mutation(transition, {
    enabled: true,
    expectedGeneration: 0,
    mutationId: enableMutationId,
  });
  const now = Date.now();
  const email = "attention@example.com" as CanonicalAuthEmail;
  const emailDigest = await digestAuthEmail(email);
  const ids = await runtime.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      email,
      emailVerificationTime: now,
    });
    await initializeUserQuotaAuthority(ctx, userId);
    const user = await ctx.db.get(userId);
    if (user === null) throw new Error("missing user fixture");
    await reserveQuotaForStoredIdentity(ctx, userId, user);
    const subject = {
      authEpoch: 1,
      createdAt: now,
      emailDigest,
      status: "active",
      updatedAt: now,
      userId,
      verifiedAt: now,
    } as const;
    await reserveQuotaForInsert(ctx, userId, "identity", subject);
    await ctx.db.insert("authSubjects", subject);
    const authSession = {
      expirationTime: now + 60 * 60 * 1_000,
      userId,
    } as const;
    await reserveQuotaForInsert(ctx, userId, "identity", authSession);
    const authSessionId = await ctx.db.insert("authSessions", authSession);
    const device = {
      activatedAt: now,
      authEpoch: 1,
      createdAt: now,
      credentialGeneration: 1,
      deviceClass: "daemon",
      encryptedLabel: envelope("L".repeat(32)),
      keyVersion: 1,
      publicId: "device_attention_runtime",
      revision: 1,
      signingPublicKey: "fixture-signing-key",
      status: "active",
      updatedAt: now,
      userId,
      wrappingPublicKey: "fixture-wrapping-key",
    } as const;
    await reserveDeviceQuotaForInsert(ctx, userId, device);
    const deviceId = await ctx.db.insert("devices", device);
    const deviceSession = {
      authEpoch: 1,
      authSessionId,
      boundAt: now,
      deviceId,
      userId,
    } as const;
    await reserveQuotaForInsert(ctx, userId, "custody", deviceSession);
    await ctx.db.insert("deviceSessions", deviceSession);
    const registry = {
      createdAt: now,
      deviceId,
      devicePublicId: "device_attention_runtime",
      envelope: envelope("R".repeat(32)),
      keyVersion: 1,
      notificationEmailEnvelope: envelope("E".repeat(32)),
      notificationHoursEnvelope: envelope("H".repeat(32)),
      notificationPolicyRevision: 1,
      revision: 1,
      updatedAt: now,
      userId,
    } as const;
    await reserveQuotaForInsert(ctx, userId, "custody", registry);
    await ctx.db.insert("deviceRegistries", registry);
    const session = {
      compactHeadSequence: 0,
      createdAt: now,
      detailHeadSequence: 0,
      executionDeviceId: deviceId,
      metadataRevision: 0,
      projectionRevision: 0,
      publicId: "session_attention_runtime",
      state: "active",
      updatedAt: now,
      userId,
    } as const;
    await reserveSessionHeadQuotaForInsert(ctx, userId, session);
    const sessionId = await ctx.db.insert("sessionHeads", session);
    const lease = {
      bootGeneration: 1,
      bootId: "boot_attention_runtime",
      deviceId,
      fence: 1,
      heartbeatFingerprint: "f".repeat(64),
      heartbeatSequence: 1,
      leaseUntil: now + 30 * 60 * 1_000,
      sessionId,
      updatedAt: now,
      userId,
    } as const;
    await reserveQuotaForInsert(ctx, userId, "session", lease);
    await ctx.db.insert("executionLeases", lease);
    return { authSessionId, deviceId, sessionId, userId };
  });
  const actor = runtime.withIdentity({
    issuer: "https://test.example",
    subject: `${ids.userId}|${ids.authSessionId}`,
    tokenIdentifier: `test|${ids.authSessionId}`,
  });
  return { actor, email, ids, now, runtime };
}

function candidate(index = 1) {
  const remoteActions: ("answer" | "decline")[] = index % 2 === 0
    ? ["answer"]
    : ["decline"];
  return {
    executionAuthority: {
      bootGeneration: 1,
      bootId: "boot_attention_runtime",
      fence: 1,
    },
    interactionDeadline: Date.now() + 20 * 60 * 1_000,
    interactionId: `interaction_attention_${String(index).padStart(2, "0")}`,
    interactionKind: index % 2 === 0 ? "user_input" as const : "command_approval" as const,
    interactionRevision: 1,
    remoteActions,
    sessionPublicId: "session_attention_runtime",
  };
}

async function complete(
  world: World,
  candidates = [candidate()],
  sequence = 1,
  localNotificationPolicyRevision = 1,
  expectedGlobalNotificationGeneration = 1,
) {
  return await world.actor.mutation(reconcile, {
    allowedWindowEnd: Date.now() + 20 * 60 * 1_000,
    candidates,
    expectedGlobalNotificationGeneration,
    localNotificationPolicyRevision,
    mode: "complete",
    reconciliationSequence: sequence,
  });
}

async function makeDue(world: World): Promise<void> {
  await world.runtime.run(async (ctx) => {
    const rows = await ctx.db.query("attentionNotificationOutbox").collect();
    for (const row of rows) {
      if (row.state === "pending") {
        await ctx.db.patch(row._id, { coalesceAfter: Date.now() - 1 });
      }
    }
  });
}

type Claim = Readonly<{
  body: OompaAttentionEmailBody;
  deliveryId: string;
  generation: number;
  globalNotificationGeneration: number;
  idempotencyKey: string;
  kind: "effect";
  recipient: string;
}>;

function requireClaim(value: unknown): Claim {
  if (typeof value !== "object" || value === null || !("kind" in value) || value.kind !== "effect") {
    throw new Error("expected claimed notification effect");
  }
  return value as Claim;
}

async function claim(world: World): Promise<Claim> {
  return requireClaim(await world.runtime.mutation(claimNext, {}));
}

async function makeRetryDue(world: World, deliveryId: string): Promise<void> {
  const dueAt = Date.now() - 1;
  await world.runtime.run(async (ctx) => {
    const rows = await ctx.db.query("attentionNotificationOutbox")
      .withIndex("by_delivery_id", (builder) => builder.eq("delivery.id", deliveryId))
      .collect();
    for (const row of rows) {
      if (row.delivery === undefined) throw new Error("missing delivery fixture");
      await ctx.db.patch(row._id, {
        delivery: { ...row.delivery, nextAttemptAt: dueAt },
      });
    }
  });
}

async function insertDeletionJob(
  world: World,
  publicId: string,
  disableSubject = false,
): Promise<void> {
  await world.runtime.run(async (ctx) => {
    const subject = await ctx.db.query("authSubjects")
      .withIndex("by_user", (builder) => builder.eq("userId", world.ids.userId))
      .filter((builder) => builder.eq(builder.field("status"), "active"))
      .first();
    if (subject === null) throw new Error("missing subject fixture");
    const now = Date.now();
    if (disableSubject) {
      await ctx.db.patch(subject._id, { status: "disabled", updatedAt: now });
    }
    const job = {
      category: "commands_and_leases",
      createdAt: now,
      publicId,
      state: "pending",
      statusCapabilityDigest: "d".repeat(64),
      subjectId: subject._id,
      updatedAt: now,
      userId: world.ids.userId,
    } as const;
    await reserveQuotaForInsert(ctx, world.ids.userId, "job", job);
    await ctx.db.insert("accountDeletionJobs", job);
  });
}

async function insertHistoricalClaims(
  world: World,
  count: number,
  claimedAt: number,
): Promise<void> {
  await world.runtime.run(async (ctx) => {
    const now = Date.now();
    for (let index = 0; index < count; index += 1) {
      const historical = {
        allowedWindowEnd: now + 60 * 60 * 1_000,
        claimDeadline: now + 60 * 60 * 1_000,
        coalesceAfter: now - 1,
        consentLeaseUntil: now + 60_000,
        createdAt: claimedAt,
        executionAuthority: {
          bootGeneration: 1,
          bootId: "boot_attention_runtime",
          fence: 1,
        },
        globalNotificationGeneration: 1,
        interactionDeadline: now + 60 * 60 * 1_000,
        interactionId: `boundary_interaction_${String(index).padStart(2, "0")}`,
        interactionKind: "command_approval" as const,
        interactionRevision: 1,
        localNotificationPolicyRevision: 1,
        nonterminal: false,
        reconciliationSequence: 1,
        remoteActions: ["decline"] as ("decline" | "answer")[],
        sessionId: world.ids.sessionId,
        sessionPublicId: "session_attention_runtime",
        sourceDeviceId: world.ids.deviceId,
        state: "accepted" as const,
        terminalCleanupAfter: now + 60 * 60 * 1_000,
        updatedAt: now,
        userId: world.ids.userId,
      };
      const id = await ctx.db.insert("attentionNotificationOutbox", historical);
      await ctx.db.patch(id, {
        delivery: {
          attemptCount: 1,
          body: { text: "Oompa needs your attention", version: 1 },
          bodyDigest: "1".repeat(64),
          claimedAt,
          deadline: now + 60_000,
          effectStartedAt: claimedAt,
          firstAttemptAt: claimedAt,
          generation: 1,
          id: `boundary_delivery_${String(index).padStart(2, "0")}`,
          idempotencyKey: "2".repeat(64),
          lastAttemptAt: claimedAt,
          leaderRowId: id,
          outcomeCode: "provider_accepted",
          outcomeDigest: "3".repeat(64),
          recipientDigest: "4".repeat(64),
          settledAt: now,
        },
      });
    }
  });
}

async function saturateUserLogicalBytes(world: World): Promise<void> {
  await world.runtime.run(async (ctx) => {
    const [usage, service] = await Promise.all([
      ctx.db.query("storageUsageByUser")
        .withIndex("by_user_and_category", (builder) => builder.eq("userId", world.ids.userId))
        .collect(),
      ctx.db.query("storageUsageService").unique(),
    ]);
    const session = usage.find((row) => row.category === "session");
    if (session === undefined || service === null) throw new Error("missing quota fixture");
    const current = usage.reduce((total, row) => total + row.logicalBytes, 0);
    const delta = USER_TOTAL_QUOTA.logicalBytes - current;
    if (delta < 0) throw new Error("user quota fixture exceeds its limit");
    if (delta === 0) return;
    const now = Date.now();
    await ctx.db.patch(session._id, {
      logicalBytes: session.logicalBytes + delta,
      updatedAt: now,
    });
    await ctx.db.patch(service._id, {
      logicalBytes: service.logicalBytes + delta,
      updatedAt: now,
      userLogicalBytes: service.userLogicalBytes + delta,
    });
  });
}

async function userLogicalBytes(world: World): Promise<number> {
  return await world.runtime.run(async (ctx) => (await ctx.db.query("storageUsageByUser")
    .withIndex("by_user_and_category", (builder) => builder.eq("userId", world.ids.userId))
    .collect()).reduce((total, row) => total + row.logicalBytes, 0));
}

async function saturateServiceLogicalBytes(world: World): Promise<void> {
  await world.runtime.run(async (ctx) => {
    const service = await ctx.db.query("storageUsageService").unique();
    if (service === null) throw new Error("missing service quota fixture");
    const delta = SERVICE_TOTAL_QUOTA.logicalBytes - service.logicalBytes;
    if (delta < 0) throw new Error("service quota fixture exceeds its limit");
    if (delta === 0) return;
    const introducesServiceRecord = service.serviceRecords === 0;
    await ctx.db.patch(service._id, {
      logicalBytes: service.logicalBytes + delta,
      records: service.records + (introducesServiceRecord ? 1 : 0),
      serviceLogicalBytes: service.serviceLogicalBytes + delta,
      serviceRecords: service.serviceRecords + (introducesServiceRecord ? 1 : 0),
      updatedAt: Date.now(),
    });
  });
}

async function serviceLogicalBytes(world: World): Promise<number> {
  return await world.runtime.run(async (ctx) => {
    const service = await ctx.db.query("storageUsageService").unique();
    if (service === null) throw new Error("missing service quota fixture");
    return service.logicalBytes;
  });
}

async function selectAttentionMaintenanceFirst(world: World): Promise<void> {
  await world.runtime.run(async (ctx) => {
    const state = await ctx.db.query("maintenanceState").unique();
    if (state === null) {
      await ctx.db.insert("maintenanceState", {
        key: "retention",
        nextCategory: "started_attention_notifications",
        updatedAt: Date.now(),
      });
      return;
    }
    await ctx.db.patch(state._id, {
      nextCategory: "started_attention_notifications",
      updatedAt: Date.now(),
    });
  });
}

describe("inactive hosted attention notification runtime", () => {
  test("accepts a complete exact snapshot, uses a server-clock consent lease, and claims metadata only", async () => {
    const world = await notificationWorld();
    const before = Date.now();
    const result = await complete(world);
    expect(result).toMatchObject({ candidateCount: 1, state: "complete" });
    expect(result.consentLeaseUntil).toBeGreaterThan(before);
    expect(result.consentLeaseUntil).toBeLessThanOrEqual(before + 2 * 60 * 1_000 + 100);
    const statusBefore = Date.now();
    expect(await world.actor.mutation(authorityStatus, {})).toMatchObject({
      enabled: true,
      globalNotificationGeneration: 1,
      observedAt: expect.any(Number) as unknown as number,
      safetyFaultState: "none",
    });
    const status = await world.actor.mutation(authorityStatus, {});
    expect(status.observedAt).toBeGreaterThanOrEqual(statusBefore);
    expect(status.observedAt).toBeLessThanOrEqual(Date.now());
    await makeDue(world);
    const effect = await claim(world);
    expect(effect).toMatchObject({
      generation: 1,
      globalNotificationGeneration: 1,
      recipient: world.email,
    });
    expect(effect.body.text).toContain("Command approval");
    expect(effect.body.text).toContain("session_attention_runtime");
    expect(effect.body.text).not.toContain(world.email);
    expect(effect.idempotencyKey).toMatch(/^[0-9a-f]{64}$/u);
    const stored = await world.runtime.run(async (ctx) =>
      await ctx.db.query("attentionNotificationOutbox").unique());
    expect(stored).toMatchObject({ nonterminal: true, state: "effect_started" });
    expect(JSON.stringify(stored)).not.toContain(world.email);
  });

  test("returns uncached server observation time across consent expiry", async () => {
    jest.useFakeTimers();
    const now = 1_800_000_000_000;
    jest.setSystemTime(now);
    try {
      const world = await notificationWorld();
      await complete(world);
      const first = await world.actor.mutation(authorityStatus, {});
      expect(first.observedAt).toBe(now);
      expect(first.deviceAuthority?.consentLeaseUntil).toBe(now + 2 * 60 * 1_000);
      jest.setSystemTime(now + 2 * 60 * 1_000 + 1);
      const expired = await world.actor.mutation(authorityStatus, {});
      expect(expired.observedAt).toBe(now + 2 * 60 * 1_000 + 1);
      expect(expired.observedAt).toBeGreaterThan(first.observedAt);
      expect(expired.deviceAuthority?.consentLeaseUntil).toBeLessThan(expired.observedAt);
    } finally {
      jest.useRealTimers();
    }
  });

  test("reserves fixed zero-only capacity for every worst-case lifecycle patch", async () => {
    expect(attentionNotificationQuotaReservations.pending).toMatch(/^0+$/u);
    expect(attentionNotificationQuotaReservations.started).toMatch(/^0+$/u);
    expect(attentionNotificationQuotaReservations.suppressed).toMatch(/^0+$/u);
    expect(attentionNotificationQuotaReservations.pending).toHaveLength(16 * 1_024);
    expect(attentionNotificationQuotaReservations.started).toHaveLength(4 * 1_024);
    expect(attentionNotificationQuotaReservations.suppressed).toHaveLength(3 * 1_024);

    const world = await notificationWorld();
    await complete(world);
    const pending = await world.runtime.run(async (ctx) =>
      await ctx.db.query("attentionNotificationOutbox").unique());
    if (pending === null) throw new Error("missing reservation fixture");
    const now = Date.now();
    const body = buildOompaAttentionEmailBody(Array.from({ length: 8 }, () => ({
      interactionKind: "permission_approval" as const,
      sessionPublicId: "s".repeat(96),
    })));
    const delivery = {
      attemptCount: 3,
      body,
      bodyDigest: "a".repeat(64),
      claimedAt: now,
      deadline: now + 23 * 60 * 60 * 1_000,
      effectStartedAt: now,
      firstAttemptAt: now,
      generation: 3,
      id: "01912345-6789-7abc-8def-0123456789d1",
      idempotencyKey: "b".repeat(64),
      lastAttemptAt: now,
      leaderRowId: pending._id,
      nextAttemptAt: now + 5 * 60 * 1_000,
      recipientDigest: "c".repeat(64),
    } as const;
    const started = {
      ...pending,
      claimCapacityReservation: attentionNotificationQuotaReservations.started,
      delivery,
      state: "effect_started" as const,
      updatedAt: now,
    };
    const suppressed = {
      ...started,
      claimCapacityReservation: attentionNotificationQuotaReservations.suppressed,
      revocationObservedAt: now,
      retrySuppressedAt: now,
      retrySuppressionReason: "recipient_unavailable" as const,
    };
    const terminal = (
      source: typeof started | typeof suppressed,
      state: "accepted" | "refused" | "ambiguous",
      outcomeCode:
        | "provider_accepted"
        | "provider_refused"
        | "retry_exhausted"
        | "delivery_deadline_elapsed",
    ) => ({
      ...source,
      claimCapacityReservation: undefined,
      delivery: {
        ...source.delivery,
        nextAttemptAt: undefined,
        outcomeCode,
        outcomeDigest: "d".repeat(64),
        settledAt: now,
      },
      nonterminal: false,
      state,
      terminalCleanupAfter: now + 7 * 24 * 60 * 60 * 1_000,
      updatedAt: now,
    });
    const cancelled = {
      ...pending,
      claimCapacityReservation: undefined,
      nonterminal: false,
      retrySuppressedAt: now,
      retrySuppressionReason: "global_disabled" as const,
      state: "cancelled" as const,
      terminalCleanupAfter: now + 7 * 24 * 60 * 60 * 1_000,
      updatedAt: now,
    };
    expect(logicalDocumentBytes(started)).toBeLessThanOrEqual(logicalDocumentBytes(pending));
    expect(logicalDocumentBytes(suppressed)).toBeLessThanOrEqual(logicalDocumentBytes(started));
    expect(logicalDocumentBytes(cancelled)).toBeLessThanOrEqual(logicalDocumentBytes(pending));
    expect(logicalDocumentBytes(terminal(started, "accepted", "provider_accepted")))
      .toBeLessThanOrEqual(logicalDocumentBytes(started));
    expect(logicalDocumentBytes(terminal(started, "refused", "provider_refused")))
      .toBeLessThanOrEqual(logicalDocumentBytes(started));
    expect(logicalDocumentBytes(terminal(started, "ambiguous", "retry_exhausted")))
      .toBeLessThanOrEqual(logicalDocumentBytes(started));
    expect(logicalDocumentBytes(
      terminal(suppressed, "ambiguous", "delivery_deadline_elapsed"),
    )).toBeLessThanOrEqual(logicalDocumentBytes(suppressed));
  });

  test("claims and settles accepted, refused, and retry-exhausted outcomes at exact quota", async () => {
    for (const result of [
      { kind: "accepted" as const, providerMessageId: "message_exact_quota" },
      { kind: "refused" as const, providerErrorType: "invalid_api_key", status: 403 },
    ]) {
      const world = await notificationWorld();
      await complete(world);
      await makeDue(world);
      await saturateUserLogicalBytes(world);
      expect(await userLogicalBytes(world)).toBe(USER_TOTAL_QUOTA.logicalBytes);
      const effect = await claim(world);
      expect(await userLogicalBytes(world)).toBeLessThan(USER_TOTAL_QUOTA.logicalBytes);
      await saturateUserLogicalBytes(world);
      expect(await world.runtime.mutation(settleAttempt, {
        deliveryId: effect.deliveryId,
        generation: effect.generation,
        globalNotificationGeneration: effect.globalNotificationGeneration,
        result,
      })).toEqual({ kind: result.kind });
      const settled = await world.runtime.run(async (ctx) =>
        await ctx.db.query("attentionNotificationOutbox").unique());
      expect(settled).toMatchObject({
        nonterminal: false,
        state: result.kind,
      });
      expect(settled?.claimCapacityReservation).toBeUndefined();
    }

    const retryWorld = await notificationWorld();
    await complete(retryWorld);
    await makeDue(retryWorld);
    const effect = await claim(retryWorld);
    await retryWorld.runtime.run(async (ctx) => {
      const row = await ctx.db.query("attentionNotificationOutbox").unique();
      if (row?.delivery === undefined) throw new Error("missing retry-exhaustion fixture");
      const patch = {
        delivery: { ...row.delivery, attemptCount: 3, generation: 3 },
      };
      await adjustCommandQuotaForPatch(ctx, retryWorld.ids.userId, row, patch);
      await ctx.db.patch(row._id, patch);
    });
    await saturateUserLogicalBytes(retryWorld);
    expect(await retryWorld.runtime.mutation(settleAttempt, {
      deliveryId: effect.deliveryId,
      generation: 3,
      globalNotificationGeneration: effect.globalNotificationGeneration,
      result: { kind: "retryable", reason: "timeout" },
    })).toEqual({ kind: "ambiguous", reason: "retry_exhausted" });
    const retrySettled = await retryWorld.runtime.run(async (ctx) =>
      await ctx.db.query("attentionNotificationOutbox").unique());
    expect(retrySettled).toMatchObject({
      delivery: { outcomeCode: "retry_exhausted" },
      nonterminal: false,
      state: "ambiguous",
    });
    expect(retrySettled?.claimCapacityReservation).toBeUndefined();

    const deadlineWorld = await notificationWorld();
    await complete(deadlineWorld);
    await makeDue(deadlineWorld);
    await claim(deadlineWorld);
    await deadlineWorld.runtime.run(async (ctx) => {
      const row = await ctx.db.query("attentionNotificationOutbox").unique();
      if (row?.delivery === undefined) throw new Error("missing deadline fixture");
      const delivery = { ...row.delivery };
      Reflect.deleteProperty(delivery, "nextAttemptAt");
      const patch = {
        delivery: {
          ...delivery,
          deadline: Date.now() - attentionNotificationRetryRecoveryMs - 2,
          effectStartedAt: Date.now() - attentionNotificationRetryRecoveryMs - 2,
        },
      };
      await adjustCommandQuotaForPatch(ctx, deadlineWorld.ids.userId, row, patch);
      await ctx.db.patch(row._id, patch);
    });
    await selectAttentionMaintenanceFirst(deadlineWorld);
    await saturateUserLogicalBytes(deadlineWorld);
    expect(await deadlineWorld.runtime.mutation(cleanupExpired, { limit: 20 }))
      .toMatchObject({ processed: 1, startedAttentionNotifications: 1 });
    const deadlineSettled = await deadlineWorld.runtime.run(async (ctx) =>
      await ctx.db.query("attentionNotificationOutbox").unique());
    expect(deadlineSettled).toMatchObject({
      delivery: { outcomeCode: "unsettled_effect" },
      nonterminal: false,
      state: "ambiguous",
    });
    expect(deadlineSettled?.claimCapacityReservation).toBeUndefined();
  });

  test("refuses claim before effect when fixed service fault capacity is exactly full", async () => {
    const world = await notificationWorld();
    await complete(world);
    await makeDue(world);
    await saturateServiceLogicalBytes(world);
    expect(await serviceLogicalBytes(world)).toBe(SERVICE_TOTAL_QUOTA.logicalBytes);

    expect(await world.runtime.mutation(claimNext, {})).toEqual({ kind: "closed" });
    expect(await world.runtime.mutation(claimNext, {})).toBeNull();
    expect(await safetyFaults(world)).toEqual([]);
    expect(await world.runtime.run(async (ctx) =>
      await ctx.db.query("attentionNotificationOutbox").unique())).toMatchObject({
      nonterminal: false,
      retrySuppressionReason: "service_fault",
      state: "cancelled",
    });
  });

  test("keeps an in-flight exact generation settleable across its deadline", async () => {
    jest.useFakeTimers();
    const now = 1_800_000_000_000;
    jest.setSystemTime(now);
    try {
      const world = await notificationWorld();
      await complete(world, [{ ...candidate(), interactionDeadline: now + 1 }]);
      await makeDue(world);
      const effect = await claim(world);
      jest.setSystemTime(now + 2);
      await selectAttentionMaintenanceFirst(world);
      expect(await world.runtime.mutation(cleanupExpired, { limit: 20 })).toMatchObject({
        processed: 0,
        startedAttentionNotifications: 0,
      });
      expect(await world.runtime.mutation(settleAttempt, {
        deliveryId: effect.deliveryId,
        generation: effect.generation,
        globalNotificationGeneration: effect.globalNotificationGeneration,
        result: { kind: "accepted", providerMessageId: "message_after_deadline" },
      })).toEqual({ kind: "accepted" });
      expect(await world.runtime.run(async (ctx) =>
        await ctx.db.query("attentionNotificationOutbox").unique())).toMatchObject({
        state: "accepted",
      });

      const expiredWorld = await notificationWorld();
      const expiresAt = Date.now() + 1;
      await complete(expiredWorld, [{ ...candidate(2), interactionDeadline: expiresAt }]);
      await makeDue(expiredWorld);
      jest.setSystemTime(expiresAt);
      expect(await expiredWorld.runtime.mutation(claimNext, {})).toEqual({ kind: "closed" });
      const expired = await expiredWorld.runtime.run(async (ctx) =>
        await ctx.db.query("attentionNotificationOutbox").unique());
      expect(expired).toMatchObject({
        state: "expired",
      });
      expect(expired?.delivery).toBeUndefined();
    } finally {
      jest.useRealTimers();
    }
  });

  test("closes only after the full two-minute recovery fence", async () => {
    jest.useFakeTimers();
    const now = 1_800_000_000_000;
    jest.setSystemTime(now);
    try {
      const world = await notificationWorld();
      await complete(world, [{ ...candidate(), interactionDeadline: now + 1 }]);
      await makeDue(world);
      await claim(world);

      jest.setSystemTime(now + attentionNotificationRetryRecoveryMs - 1);
      await selectAttentionMaintenanceFirst(world);
      expect(await world.runtime.mutation(cleanupExpired, { limit: 20 })).toMatchObject({
        processed: 0,
        startedAttentionNotifications: 0,
      });
      jest.setSystemTime(now + attentionNotificationRetryRecoveryMs);
      await selectAttentionMaintenanceFirst(world);
      expect(await world.runtime.mutation(cleanupExpired, { limit: 20 })).toMatchObject({
        processed: 0,
        startedAttentionNotifications: 0,
      });
      jest.setSystemTime(now + attentionNotificationRetryRecoveryMs + 1);
      await selectAttentionMaintenanceFirst(world);
      expect(await world.runtime.mutation(cleanupExpired, { limit: 20 })).toMatchObject({
        processed: 1,
        startedAttentionNotifications: 1,
      });
      expect(await world.runtime.run(async (ctx) =>
        await ctx.db.query("attentionNotificationOutbox").unique())).toMatchObject({
        delivery: { outcomeCode: "unsettled_effect" },
        state: "ambiguous",
      });
    } finally {
      jest.useRealTimers();
    }
  });

  test("rejects an incomplete candidate envelope atomically and fences stale reconciliation", async () => {
    const world = await notificationWorld();
    await expect(complete(world, [{
      ...candidate(),
      executionAuthority: { ...candidate().executionAuthority, fence: 2 },
    }])).rejects.toThrow("ATTENTION_NOTIFICATION_RECONCILIATION_REJECTED");
    expect(await world.runtime.run(async (ctx) =>
      await ctx.db.query("attentionNotificationOutbox").collect())).toEqual([]);

    await complete(world);
    const invalidated = await world.actor.mutation(reconcile, {
      localNotificationPolicyRevision: 2,
      mode: "invalidate",
      reconciliationSequence: 2,
    });
    expect(invalidated).toMatchObject({ state: "invalidated" });
    await expect(complete(world, [candidate()], 1))
      .rejects.toThrow("ATTENTION_NOTIFICATION_RECONCILIATION_REJECTED");
    const row = await world.runtime.run(async (ctx) =>
      await ctx.db.query("attentionNotificationOutbox").unique());
    expect(row).toMatchObject({
      nonterminal: false,
      retrySuppressionReason: "local_policy_changed",
      state: "cancelled",
    });
  });

  test("coalesces no more than eight rows and preserves exact body and key across retry generations", async () => {
    const world = await notificationWorld();
    await complete(world, Array.from({ length: 9 }, (_, index) => candidate(index + 1)));
    await makeDue(world);
    const first = await claim(world);
    const firstRows = await world.runtime.run(async (ctx) =>
      await ctx.db.query("attentionNotificationOutbox")
        .withIndex("by_delivery_id", (builder) => builder.eq("delivery.id", first.deliveryId))
        .collect());
    expect(firstRows).toHaveLength(8);
    expect(firstRows.filter((row) => row.delivery?.body !== undefined)).toHaveLength(1);

    await world.runtime.mutation(settleAttempt, {
      deliveryId: first.deliveryId,
      generation: first.generation,
      globalNotificationGeneration: first.globalNotificationGeneration,
      result: { kind: "retryable", reason: "timeout" },
    });
    await makeRetryDue(world, first.deliveryId);
    const retry = await claim(world);
    expect(retry).toMatchObject({
      deliveryId: first.deliveryId,
      generation: 2,
      idempotencyKey: first.idempotencyKey,
    });
    expect(retry.body).toEqual(first.body);
  });

  test("revalidates the exact lease before claim and produces no provider effect on drift", async () => {
    const world = await notificationWorld();
    await complete(world);
    await makeDue(world);
    await world.runtime.run(async (ctx) => {
      const lease = await ctx.db.query("executionLeases").unique();
      if (lease === null) throw new Error("missing lease fixture");
      await ctx.db.patch(lease._id, { fence: 2 });
    });
    expect(await world.runtime.mutation(claimNext, {})).toEqual({ kind: "closed" });
    const row = await world.runtime.run(async (ctx) =>
      await ctx.db.query("attentionNotificationOutbox").unique());
    expect(row).toMatchObject({
      nonterminal: false,
      retrySuppressionReason: "execution_authority_changed",
      state: "cancelled",
    });
  });

  test("observes account deletion before both first claim and retry without a provider effect", async () => {
    const pendingWorld = await notificationWorld();
    await complete(pendingWorld);
    await makeDue(pendingWorld);
    await insertDeletionJob(pendingWorld, "deletion_before_attention_claim");
    expect(await pendingWorld.runtime.mutation(claimNext, {})).toEqual({ kind: "closed" });
    expect(await pendingWorld.runtime.run(async (ctx) =>
      await ctx.db.query("attentionNotificationOutbox").unique())).toMatchObject({
      nonterminal: false,
      retrySuppressionReason: "account_deletion",
      state: "cancelled",
    });

    const retryWorld = await notificationWorld();
    await complete(retryWorld);
    await makeDue(retryWorld);
    const effect = await claim(retryWorld);
    await retryWorld.runtime.mutation(settleAttempt, {
      deliveryId: effect.deliveryId,
      generation: effect.generation,
      globalNotificationGeneration: effect.globalNotificationGeneration,
      result: { kind: "retryable", reason: "timeout" },
    });
    await makeRetryDue(retryWorld, effect.deliveryId);
    await insertDeletionJob(retryWorld, "deletion_before_attention_retry");
    expect(await retryWorld.runtime.mutation(claimNext, {})).toEqual({ kind: "closed" });
    const retryRow = await retryWorld.runtime.run(async (ctx) =>
      await ctx.db.query("attentionNotificationOutbox").unique());
    expect(retryRow).toMatchObject({
      nonterminal: true,
      retrySuppressionReason: "account_deletion",
      state: "effect_started",
    });
    expect(retryRow?.delivery?.nextAttemptAt).toBeUndefined();
  });

  test("selects exactly one active recipient across bounded subject history and fails closed", async () => {
    const historyWorld = await notificationWorld();
    await complete(historyWorld);
    await makeDue(historyWorld);
    await historyWorld.runtime.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert("authSubjects", {
        authEpoch: 2,
        createdAt: now - 1,
        emailDigest: "9".repeat(64),
        status: "disabled",
        updatedAt: now,
        userId: historyWorld.ids.userId,
        verifiedAt: now - 1,
      });
    });
    expect((await claim(historyWorld)).recipient).toBe(historyWorld.email);

    const duplicateWorld = await notificationWorld();
    await complete(duplicateWorld);
    await makeDue(duplicateWorld);
    await duplicateWorld.runtime.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert("authSubjects", {
        authEpoch: 2,
        createdAt: now,
        emailDigest: "8".repeat(64),
        status: "active",
        updatedAt: now,
        userId: duplicateWorld.ids.userId,
        verifiedAt: now,
      });
    });
    expect(await duplicateWorld.runtime.mutation(claimNext, {})).toEqual({ kind: "closed" });
    expect(await duplicateWorld.runtime.run(async (ctx) =>
      await ctx.db.query("attentionNotificationOutbox").unique())).toMatchObject({
      retrySuppressionReason: "recipient_unavailable",
      state: "cancelled",
    });

    const overflowWorld = await notificationWorld();
    await complete(overflowWorld);
    await makeDue(overflowWorld);
    await overflowWorld.runtime.run(async (ctx) => {
      const now = Date.now();
      for (let index = 0; index < CATEGORY_QUOTAS.identity.records; index += 1) {
        await ctx.db.insert("authSubjects", {
          authEpoch: index + 2,
          createdAt: now,
          emailDigest: index.toString(16).padStart(64, "0"),
          status: "disabled",
          updatedAt: now,
          userId: overflowWorld.ids.userId,
        });
      }
    });
    expect(await overflowWorld.runtime.mutation(claimNext, {})).toEqual({ kind: "closed" });
    expect(await overflowWorld.runtime.run(async (ctx) =>
      await ctx.db.query("attentionNotificationOutbox").unique())).toMatchObject({
      retrySuppressionReason: "recipient_unavailable",
      state: "cancelled",
    });
  });

  test("retains exact 409 ambiguity evidence at quota and permits reason-specific review", async () => {
    const world = await notificationWorld();
    await complete(world);
    await makeDue(world);
    const first = await claim(world);
    await saturateUserLogicalBytes(world);
    await saturateServiceLogicalBytes(world);
    expect(await userLogicalBytes(world)).toBe(USER_TOTAL_QUOTA.logicalBytes);
    expect(await serviceLogicalBytes(world)).toBe(SERVICE_TOTAL_QUOTA.logicalBytes);
    const mismatch = {
      kind: "ambiguous" as const,
      providerErrorType: "invalid_idempotent_request" as const,
      safetyFault: true as const,
      status: 409 as const,
    };
    const settlementStartedAt = Date.now();
    expect(await world.runtime.mutation(settleAttempt, {
      deliveryId: first.deliveryId,
      generation: 1,
      globalNotificationGeneration: 1,
      result: mismatch,
    })).toEqual({ kind: "ambiguous", reason: "idempotency_mismatch" });
    const settlementCompletedAt = Date.now();
    expect(await userLogicalBytes(world)).toBeLessThan(USER_TOTAL_QUOTA.logicalBytes);
    const controlStatus = await world.runtime.query(readControlStatus, {});
    if (controlStatus.safetyFault === null) throw new Error("missing idempotency fault");
    expect(controlStatus).toMatchObject({
      enabled: false,
      generation: 2,
      safetyFault: {
        deliveryId: first.deliveryId,
        reason: "invalid_idempotent_request",
        state: "latched",
      },
    });
    const retained = await world.runtime.run(async (ctx) =>
      await ctx.db.query("attentionNotificationOutbox").unique());
    expect(retained).toMatchObject({
      delivery: {
        outcomeCode: "idempotency_mismatch",
        outcomeDigest: controlStatus.safetyFault.resultDigest,
      },
      nonterminal: false,
      state: "ambiguous",
    });
    expect(retained?.delivery?.nextAttemptAt).toBeUndefined();
    expect(retained?.claimCapacityReservation).toBeUndefined();
    const settledAt = retained?.delivery?.settledAt;
    if (settledAt === undefined) throw new Error("missing ambiguity settlement time");
    expect(settledAt).toBeGreaterThanOrEqual(settlementStartedAt);
    expect(settledAt).toBeLessThanOrEqual(settlementCompletedAt);
    expect(retained?.terminalCleanupAfter).toBe(
      settledAt + ATTENTION_NOTIFICATION_TERMINAL_RETENTION_MS,
    );
    expect(await world.runtime.mutation(claimNext, {})).toBeNull();
    await expect(world.runtime.mutation(quarantineFaultedDelivery, {
      faultId: controlStatus.safetyFault.faultId,
    })).rejects.toThrow("ATTENTION_NOTIFICATION_AUTHORITY_CORRUPT");
    await world.runtime.mutation(acknowledgeSafetyFault, {
      expectedDeliveryId: first.deliveryId,
      expectedFaultId: controlStatus.safetyFault.faultId,
      expectedGeneration: 2,
      expectedResultDigest: controlStatus.safetyFault.resultDigest,
      mutationId: "01912345-6789-7abc-8def-0123456789c5",
    });
    await world.runtime.mutation(transition, {
      enabled: true,
      expectedGeneration: 2,
      mutationId: "01912345-6789-7abc-8def-0123456789c6",
    });
    expect(await world.runtime.mutation(claimNext, {})).toBeNull();
    expect(await world.runtime.run(async (ctx) =>
      await ctx.db.query("attentionNotificationOutbox").unique())).toEqual(retained);
  });

  test.each([1, 2] as const)("preserves retained v%i bytes through retry and safety-fault review", async (version) => {
    const world = await notificationWorld();
    await complete(world);
    await makeDue(world);
    const first = await claim(world);
    // Seed an already-started historical delivery, retaining the digest/key
    // grammar used by that version and accounting for its exact stored size.
    const historical = await world.runtime.run(async (ctx) => {
      const row = await ctx.db.query("attentionNotificationOutbox").unique();
      const delivery = row?.delivery;
      if (row === null || delivery === undefined) throw new Error("missing started historical delivery");
      const body = buildOompaAttentionEmailBody([{ interactionKind: row.interactionKind,
        sessionPublicId: row.sessionPublicId }], version);
      const bodyDigest = await sha256Hex(`hra-attention-body:v1\u0000${body.text}`);
      const idempotencyKey = await sha256Hex(["hra-attention-resend:v1", delivery.id,
        delivery.recipientDigest, bodyDigest].join("\u0000"));
      const patch = { delivery: { ...delivery, body, bodyDigest, idempotencyKey } };
      await adjustCommandQuotaForPatch(ctx, world.ids.userId, row, patch);
      await ctx.db.patch(row._id, patch);
      return { body, bodyDigest, idempotencyKey };
    });
    await world.runtime.mutation(settleAttempt, { deliveryId: first.deliveryId,
      generation: first.generation, globalNotificationGeneration: first.globalNotificationGeneration,
      result: { kind: "retryable", reason: "network" } });
    await makeRetryDue(world, first.deliveryId);
    const retry = await claim(world);
    expect(retry.body).toEqual(historical.body);
    expect(retry.idempotencyKey).toBe(historical.idempotencyKey);
    expect(await world.runtime.mutation(settleAttempt, { deliveryId: retry.deliveryId,
      generation: retry.generation, globalNotificationGeneration: retry.globalNotificationGeneration,
      result: { kind: "ambiguous", providerErrorType: "invalid_idempotent_request", safetyFault: true, status: 409 } }))
      .toEqual({ kind: "ambiguous", reason: "idempotency_mismatch" });
    const status = await world.runtime.query(readControlStatus, {});
    if (status.safetyFault === null) throw new Error("missing historical delivery fault");
    const retained = await world.runtime.run(async (ctx) => await ctx.db.query("attentionNotificationOutbox").unique());
    expect(retained).toMatchObject({ state: "ambiguous", nonterminal: false, delivery: historical });
    await world.runtime.mutation(acknowledgeSafetyFault, { expectedDeliveryId: retry.deliveryId,
      expectedFaultId: status.safetyFault.faultId, expectedGeneration: status.generation,
      expectedResultDigest: status.safetyFault.resultDigest, mutationId: "01912345-6789-7abc-8def-0123456789d1" });
    expect(await world.runtime.query(readControlStatus, {})).toMatchObject({ enabled: false, safetyFault: null });
    expect(await world.runtime.run(async (ctx) => await ctx.db.query("attentionNotificationOutbox").unique())).toEqual(retained);
  });

  test("re-latches late same-delivery corruption after the first 409 was reviewed", async () => {
    const world = await notificationWorld();
    await complete(world);
    await makeDue(world);
    const effect = await claim(world);
    const mismatch = {
      kind: "ambiguous" as const,
      providerErrorType: "invalid_idempotent_request" as const,
      safetyFault: true as const,
      status: 409 as const,
    };
    expect(await world.runtime.mutation(settleAttempt, {
      deliveryId: effect.deliveryId,
      generation: effect.generation,
      globalNotificationGeneration: effect.globalNotificationGeneration,
      result: mismatch,
    })).toEqual({ kind: "ambiguous", reason: "idempotency_mismatch" });
    const firstFault = (await safetyFaults(world)).find((fault) =>
      fault.reason === "invalid_idempotent_request" && fault.state === "latched");
    if (firstFault?.faultId === undefined || firstFault.resultDigest === undefined) {
      throw new Error("missing first same-delivery fault");
    }
    await world.runtime.mutation(acknowledgeSafetyFault, {
      expectedDeliveryId: effect.deliveryId,
      expectedFaultId: firstFault.faultId,
      expectedGeneration: 2,
      expectedResultDigest: firstFault.resultDigest,
      mutationId: "01912345-6789-7abc-8def-0123456789e5",
    });
    await world.runtime.mutation(transition, {
      enabled: true,
      expectedGeneration: 2,
      mutationId: "01912345-6789-7abc-8def-0123456789e6",
    });
    await world.runtime.run(async (ctx) => {
      const row = await ctx.db.query("attentionNotificationOutbox").unique();
      if (row?.delivery === undefined) throw new Error("missing retained ambiguity row");
      await ctx.db.patch(row._id, {
        delivery: { ...row.delivery, bodyDigest: "0".repeat(64) },
      });
    });

    const late = await world.runtime.mutation(settleAttempt, {
      deliveryId: effect.deliveryId,
      generation: effect.generation,
      globalNotificationGeneration: effect.globalNotificationGeneration,
      result: mismatch,
    });
    expect(late).toMatchObject({
      kind: "safety_fault",
      quarantineFaultId: expect.any(String) as unknown as string,
    });
    const after = await safetyFaults(world);
    const storedFault = after.find((fault) =>
      fault.reason === "stored_delivery_corrupt" && fault.state === "latched");
    if (storedFault?.faultId === undefined || storedFault.resultDigest === undefined) {
      throw new Error("missing late stored-corruption fault");
    }
    expect(storedFault.deliveryId).toBe(effect.deliveryId);
    expect(after.filter((fault) => fault.state === "reviewed")).toHaveLength(1);
    expect(after.filter((fault) => fault.state === "latched")).toHaveLength(1);
    expect(after.filter((fault) => fault.state === "reserved")).toHaveLength(2);
    expect(await world.runtime.query(readControlStatus, {})).toMatchObject({
      enabled: false,
      generation: 4,
      safetyFault: { faultId: storedFault.faultId, reason: "stored_delivery_corrupt" },
    });
    expect(await world.runtime.mutation(quarantineFaultedDelivery, {
      faultId: storedFault.faultId,
    })).toEqual({ deleted: 1, remaining: false });
    await world.runtime.mutation(acknowledgeSafetyFault, {
      expectedDeliveryId: storedFault.deliveryId,
      expectedFaultId: storedFault.faultId,
      expectedGeneration: 4,
      expectedResultDigest: storedFault.resultDigest,
      mutationId: "01912345-6789-7abc-8def-0123456789e7",
    });
    expect(await world.runtime.mutation(transition, {
      enabled: true,
      expectedGeneration: 4,
      mutationId: "01912345-6789-7abc-8def-0123456789e8",
    })).toMatchObject({ enabled: true, generation: 5 });
  });

  test("records and independently reviews a late 409 from an earlier admitted generation", async () => {
    const world = await notificationWorld();
    await complete(world);
    await makeDue(world);
    const first = await claim(world);
    expect(await world.runtime.mutation(settleAttempt, {
      deliveryId: first.deliveryId,
      generation: first.generation,
      globalNotificationGeneration: first.globalNotificationGeneration,
      result: { kind: "retryable", reason: "timeout" },
    })).toMatchObject({ kind: "retry_scheduled" });
    await makeRetryDue(world, first.deliveryId);
    const second = await claim(world);
    expect(second).toMatchObject({
      deliveryId: first.deliveryId,
      generation: 2,
      idempotencyKey: first.idempotencyKey,
    });
    const mismatch = {
      kind: "ambiguous" as const,
      providerErrorType: "invalid_idempotent_request" as const,
      safetyFault: true as const,
      status: 409 as const,
    };
    await world.runtime.mutation(settleAttempt, {
      deliveryId: second.deliveryId,
      generation: second.generation,
      globalNotificationGeneration: second.globalNotificationGeneration,
      result: mismatch,
    });
    const secondFault = (await safetyFaults(world)).find((fault) =>
      fault.deliveryGeneration === 2 && fault.state === "latched");
    if (secondFault?.faultId === undefined || secondFault.resultDigest === undefined) {
      throw new Error("missing second-generation fault");
    }

    await world.runtime.run(async (ctx) => {
      const stored = await ctx.db.query("attentionNotificationSafetyFaults")
        .withIndex("by_fault_id", (builder) => builder.eq("faultId", secondFault.faultId))
        .unique();
      if (stored === null) throw new Error("missing generation-bound fault");
      await ctx.db.patch(stored._id, { deliveryGeneration: 3 });
    });
    const secondReviewArgs = {
      expectedDeliveryId: second.deliveryId,
      expectedFaultId: secondFault.faultId,
      expectedGeneration: 2,
      expectedResultDigest: secondFault.resultDigest,
      mutationId: "01912345-6789-7abc-8def-0123456789f2",
    };
    await expect(world.runtime.mutation(acknowledgeSafetyFault, secondReviewArgs))
      .rejects.toThrow("ATTENTION_NOTIFICATION_SAFETY_FAULT_LATCHED");
    await world.runtime.run(async (ctx) => {
      const stored = await ctx.db.query("attentionNotificationSafetyFaults")
        .withIndex("by_fault_id", (builder) => builder.eq("faultId", secondFault.faultId))
        .unique();
      if (stored === null) throw new Error("missing generation-bound fault");
      await ctx.db.patch(stored._id, { deliveryGeneration: 2 });
    });
    await world.runtime.mutation(acknowledgeSafetyFault, secondReviewArgs);
    await world.runtime.mutation(transition, {
      enabled: true,
      expectedGeneration: 2,
      mutationId: "01912345-6789-7abc-8def-0123456789f3",
    });
    const retainedBeforeLate = await world.runtime.run(async (ctx) =>
      await ctx.db.query("attentionNotificationOutbox").unique());

    expect(await world.runtime.mutation(settleAttempt, {
      deliveryId: first.deliveryId,
      generation: first.generation,
      globalNotificationGeneration: first.globalNotificationGeneration,
      result: mismatch,
    })).toEqual({ kind: "ambiguous", reason: "idempotency_mismatch" });
    expect(await world.runtime.run(async (ctx) =>
      await ctx.db.query("attentionNotificationOutbox").unique())).toEqual(retainedBeforeLate);
    const after = await safetyFaults(world);
    const lateFault = after.find((fault) =>
      fault.deliveryGeneration === 1 && fault.state === "latched");
    expect(lateFault).toMatchObject({
      deliveryId: first.deliveryId,
      reason: "invalid_idempotent_request",
    });
    expect(after.filter((fault) => fault.state === "reviewed")).toHaveLength(1);
    expect(after.filter((fault) => fault.state === "latched")).toHaveLength(1);
    expect(after.filter((fault) => fault.state === "reserved")).toHaveLength(2);
    expect(await world.runtime.query(readControlStatus, {})).toMatchObject({
      enabled: false,
      generation: 4,
      safetyFault: { faultId: lateFault?.faultId },
    });
    if (lateFault?.faultId === undefined || lateFault.resultDigest === undefined) {
      throw new Error("missing exact late-generation fault evidence");
    }
    const lateReviewArgs = {
      expectedDeliveryId: first.deliveryId,
      expectedFaultId: lateFault.faultId,
      expectedGeneration: 4,
      expectedResultDigest: lateFault.resultDigest,
      mutationId: "01912345-6789-7abc-8def-0123456789f4",
    };
    await expect(world.runtime.mutation(acknowledgeSafetyFault, lateReviewArgs))
      .rejects.toThrow("ATTENTION_NOTIFICATION_SAFETY_FAULT_LATCHED");
    await world.runtime.run(async (ctx) => {
      const retained = await ctx.db.query("attentionNotificationOutbox").unique();
      if (retained === null) throw new Error("missing retained late-generation evidence");
      await releaseCommandQuotaForDelete(ctx, world.ids.userId, retained);
      await ctx.db.delete(retained._id);
    });
    await world.runtime.mutation(acknowledgeSafetyFault, lateReviewArgs);
    expect(await world.runtime.mutation(transition, {
      enabled: true,
      expectedGeneration: 4,
      mutationId: "01912345-6789-7abc-8def-0123456789f5",
    })).toMatchObject({ enabled: true, generation: 5 });
  });

  test("latches a late earlier-generation 409 after recovery advances the delivery", async () => {
    const world = await notificationWorld();
    await complete(world);
    await makeDue(world);
    const first = await claim(world);
    await makeRetryDue(world, first.deliveryId);
    const second = await claim(world);
    expect(second).toMatchObject({
      deliveryId: first.deliveryId,
      generation: 2,
      idempotencyKey: first.idempotencyKey,
    });
    const mismatch = {
      kind: "ambiguous" as const,
      providerErrorType: "invalid_idempotent_request" as const,
      safetyFault: true as const,
      status: 409 as const,
    };

    expect(await world.runtime.mutation(settleAttempt, {
      deliveryId: first.deliveryId,
      generation: first.generation,
      globalNotificationGeneration: first.globalNotificationGeneration,
      result: mismatch,
    })).toEqual({ kind: "ambiguous", reason: "idempotency_mismatch" });
    const terminalAfterFirst = await world.runtime.run(async (ctx) =>
      await ctx.db.query("attentionNotificationOutbox").unique());
    expect(terminalAfterFirst).toMatchObject({
      delivery: {
        generation: second.generation,
        outcomeCode: "idempotency_mismatch",
        settledAt: expect.any(Number) as unknown as number,
      },
      nonterminal: false,
      state: "ambiguous",
    });
    expect((await safetyFaults(world)).filter((fault) => fault.state === "latched"))
      .toMatchObject([{ deliveryGeneration: first.generation }]);
    expect(await world.runtime.query(readControlStatus, {})).toMatchObject({
      enabled: false,
      generation: 2,
      safetyFault: { reason: "invalid_idempotent_request" },
    });
    expect(await world.runtime.mutation(claimNext, {})).toBeNull();

    await expect(world.runtime.mutation(settleAttempt, {
      deliveryId: second.deliveryId,
      generation: second.generation,
      globalNotificationGeneration: second.globalNotificationGeneration,
      result: { kind: "accepted", providerMessageId: "must_not_override_ambiguity" },
    })).rejects.toThrow("ATTENTION_NOTIFICATION_AUTHORITY_CORRUPT");
    expect(await world.runtime.run(async (ctx) =>
      await ctx.db.query("attentionNotificationOutbox").unique())).toEqual(terminalAfterFirst);

    expect(await world.runtime.mutation(settleAttempt, {
      deliveryId: second.deliveryId,
      generation: second.generation,
      globalNotificationGeneration: second.globalNotificationGeneration,
      result: mismatch,
    })).toEqual({ kind: "ambiguous", reason: "idempotency_mismatch" });
    expect((await safetyFaults(world)).filter((fault) => fault.state === "latched"))
      .toMatchObject([
        { deliveryGeneration: first.generation },
        { deliveryGeneration: second.generation },
      ]);
    expect(await world.runtime.mutation(settleAttempt, {
      deliveryId: second.deliveryId,
      generation: second.generation,
      globalNotificationGeneration: second.globalNotificationGeneration,
      result: mismatch,
    })).toEqual({ kind: "replay" });
  });

  test("blocks 409 review when the retained delivery id drifts until anchor erasure", async () => {
    const world = await notificationWorld();
    await complete(world);
    await makeDue(world);
    const effect = await claim(world);
    const mismatch = {
      kind: "ambiguous" as const,
      providerErrorType: "invalid_idempotent_request" as const,
      safetyFault: true as const,
      status: 409 as const,
    };
    await world.runtime.mutation(settleAttempt, {
      deliveryId: effect.deliveryId,
      generation: effect.generation,
      globalNotificationGeneration: effect.globalNotificationGeneration,
      result: mismatch,
    });
    const fault = (await safetyFaults(world)).find((candidate) =>
      candidate.reason === "invalid_idempotent_request" && candidate.state === "latched");
    if (fault?.faultId === undefined || fault.resultDigest === undefined) {
      throw new Error("missing id-drift fault fixture");
    }
    const reviewArgs = {
      expectedDeliveryId: effect.deliveryId,
      expectedFaultId: fault.faultId,
      expectedGeneration: 2,
      expectedResultDigest: fault.resultDigest,
      mutationId: "01912345-6789-7abc-8def-012345678910",
    };
    await world.runtime.run(async (ctx) => {
      const retained = await ctx.db.query("attentionNotificationOutbox").unique();
      if (retained?.delivery === undefined) throw new Error("missing retained id-drift row");
      await ctx.db.patch(retained._id, {
        delivery: {
          ...retained.delivery,
          id: "01912345-6789-7abc-8def-0123456789fe",
        },
      });
    });
    await expect(world.runtime.mutation(acknowledgeSafetyFault, reviewArgs))
      .rejects.toThrow("ATTENTION_NOTIFICATION_SAFETY_FAULT_LATCHED");
    await expect(world.runtime.mutation(transition, {
      enabled: true,
      expectedGeneration: 2,
      mutationId: "01912345-6789-7abc-8def-012345678911",
    })).rejects.toThrow("ATTENTION_NOTIFICATION_SAFETY_FAULT_LATCHED");
    const publicFault = (await world.runtime.query(readControlStatus, {})).safetyFault;
    expect(publicFault).not.toHaveProperty("anchorRowId");
    expect(publicFault).not.toHaveProperty("cleanupRowId");

    await world.runtime.run(async (ctx) => {
      const retained = await ctx.db.query("attentionNotificationOutbox").unique();
      if (retained === null) throw new Error("missing retained id-drift cleanup row");
      await releaseCommandQuotaForDelete(ctx, world.ids.userId, retained);
      await ctx.db.delete(retained._id);
    });
    expect(await world.runtime.mutation(acknowledgeSafetyFault, reviewArgs))
      .toMatchObject({ changed: true, replay: false });
  });

  test("fails closed on a synthetic 409 after ordinary terminal capacity was released", async () => {
    const world = await notificationWorld();
    await complete(world);
    await makeDue(world);
    const first = await claim(world);
    await world.runtime.mutation(settleAttempt, {
      deliveryId: first.deliveryId,
      generation: first.generation,
      globalNotificationGeneration: first.globalNotificationGeneration,
      result: { kind: "retryable", reason: "timeout" },
    });
    await makeRetryDue(world, first.deliveryId);
    const second = await claim(world);
    await world.runtime.mutation(settleAttempt, {
      deliveryId: second.deliveryId,
      generation: second.generation,
      globalNotificationGeneration: second.globalNotificationGeneration,
      result: { kind: "accepted", providerMessageId: "ordinary_terminal_result" },
    });
    const retained = await world.runtime.run(async (ctx) =>
      await ctx.db.query("attentionNotificationOutbox").unique());
    expect(await safetyFaults(world)).toEqual([]);
    await expect(world.runtime.mutation(settleAttempt, {
      deliveryId: first.deliveryId,
      generation: first.generation,
      globalNotificationGeneration: first.globalNotificationGeneration,
      result: {
        kind: "ambiguous",
        providerErrorType: "invalid_idempotent_request",
        safetyFault: true,
        status: 409,
      },
    })).rejects.toThrow("ATTENTION_NOTIFICATION_AUTHORITY_CORRUPT");
    expect(await world.runtime.run(async (ctx) =>
      await ctx.db.query("attentionNotificationOutbox").unique())).toEqual(retained);
    expect(await safetyFaults(world)).toEqual([]);
    expect(await world.runtime.action(drainNotifications, { limit: 10 })).toEqual({
      claimed: 0,
      closed: 0,
      processed: 0,
    });
  });

  test("requires separate review of concurrent faults from different deliveries", async () => {
    const world = await notificationWorld();
    const firstCandidate = candidate(1);
    await complete(world, [firstCandidate]);
    await makeDue(world);
    const first = await claim(world);
    await complete(world, [firstCandidate, candidate(2)], 2);
    await makeDue(world);
    const second = await claim(world);
    expect(second.deliveryId).not.toBe(first.deliveryId);
    const mismatch = {
      kind: "ambiguous" as const,
      providerErrorType: "invalid_idempotent_request" as const,
      safetyFault: true as const,
      status: 409 as const,
    };
    expect(await world.runtime.mutation(settleAttempt, {
      deliveryId: first.deliveryId,
      generation: first.generation,
      globalNotificationGeneration: first.globalNotificationGeneration,
      result: mismatch,
    })).toEqual({ kind: "ambiguous", reason: "idempotency_mismatch" });
    expect(await world.runtime.mutation(settleAttempt, {
      deliveryId: second.deliveryId,
      generation: second.generation,
      globalNotificationGeneration: second.globalNotificationGeneration,
      result: mismatch,
    })).toEqual({ kind: "ambiguous", reason: "idempotency_mismatch" });
    const retainedBeforeReview = await world.runtime.run(async (ctx) =>
      await ctx.db.query("attentionNotificationOutbox").collect());
    expect(retainedBeforeReview).toHaveLength(2);
    expect(retainedBeforeReview.every((row) =>
      row.state === "ambiguous"
        && !row.nonterminal
        && row.delivery?.outcomeCode === "idempotency_mismatch"
    )).toBe(true);

    const faults = await safetyFaults(world);
    expect(faults).toHaveLength(8);
    const firstFault = faults.find((fault) =>
      fault.deliveryId === first.deliveryId && fault.state === "latched");
    const secondFault = faults.find((fault) =>
      fault.deliveryId === second.deliveryId && fault.state === "latched");
    if (
      firstFault?.faultId === undefined
      || firstFault.resultDigest === undefined
      || secondFault?.faultId === undefined
      || secondFault.resultDigest === undefined
    ) throw new Error("missing concurrent safety-fault rows");
    const publicFault = (await world.runtime.query(readControlStatus, {})).safetyFault;
    if (publicFault === null) throw new Error("missing public concurrent fault");
    expect([first.deliveryId, second.deliveryId]).toContain(publicFault.deliveryId);
    for (const privateField of [
      "_id",
      "anchorRowId",
      "capacityReservation",
      "cleanupRowId",
      "quarantineCompletedAt",
      "quarantineState",
      "slot",
      "terminalCleanupAfter",
      "userId",
    ]) expect(publicFault).not.toHaveProperty(privateField);
    const daemonStatus = await world.actor.mutation(authorityStatus, {});
    expect(daemonStatus).toMatchObject({ enabled: false, safetyFaultState: "latched" });
    expect(daemonStatus).not.toHaveProperty("safetyFault");
    expect(JSON.stringify(daemonStatus)).not.toContain(publicFault.faultId);

    const firstReviewArgs = {
      expectedDeliveryId: first.deliveryId,
      expectedFaultId: firstFault.faultId,
      expectedGeneration: 2,
      expectedResultDigest: firstFault.resultDigest,
      mutationId: "01912345-6789-7abc-8def-0123456789d1",
    };
    const reviewedFirst = await world.runtime.mutation(acknowledgeSafetyFault, firstReviewArgs);
    expect(reviewedFirst).toMatchObject({
      enabled: false,
      generation: 2,
      safetyFault: { deliveryId: first.deliveryId, state: "reviewed" },
    });
    expect(await world.runtime.mutation(acknowledgeSafetyFault, firstReviewArgs)).toMatchObject({
      changed: false,
      replay: true,
      safetyFault: { deliveryId: first.deliveryId, state: "reviewed" },
    });
    await expect(world.runtime.mutation(transition, {
      enabled: true,
      expectedGeneration: 2,
      mutationId: "01912345-6789-7abc-8def-0123456789d2",
    })).rejects.toThrow("ATTENTION_NOTIFICATION_SAFETY_FAULT_LATCHED");

    await world.runtime.mutation(acknowledgeSafetyFault, {
      expectedDeliveryId: second.deliveryId,
      expectedFaultId: secondFault.faultId,
      expectedGeneration: 2,
      expectedResultDigest: secondFault.resultDigest,
      mutationId: "01912345-6789-7abc-8def-0123456789d3",
    });
    expect(await world.runtime.mutation(transition, {
      enabled: true,
      expectedGeneration: 2,
      mutationId: "01912345-6789-7abc-8def-0123456789d4",
    })).toMatchObject({ enabled: true, generation: 3 });
    expect(await world.runtime.run(async (ctx) =>
      await ctx.db.query("attentionNotificationOutbox").collect())).toHaveLength(2);
    expect(await world.runtime.mutation(claimNext, {})).toBeNull();
  });

  test("quarantines coexisting stored corruption independently of another fault", async () => {
    const world = await notificationWorld();
    const firstCandidate = candidate(1);
    await complete(world, [firstCandidate]);
    await makeDue(world);
    const first = await claim(world);
    await complete(world, [firstCandidate, candidate(2)], 2);
    await makeDue(world);
    const second = await claim(world);
    const mismatch = {
      kind: "ambiguous" as const,
      providerErrorType: "invalid_idempotent_request" as const,
      safetyFault: true as const,
      status: 409 as const,
    };
    await world.runtime.mutation(settleAttempt, {
      deliveryId: first.deliveryId,
      generation: first.generation,
      globalNotificationGeneration: first.globalNotificationGeneration,
      result: mismatch,
    });
    await world.runtime.run(async (ctx) => {
      const row = (await ctx.db.query("attentionNotificationOutbox")
        .withIndex("by_delivery_id", (builder) => builder.eq("delivery.id", second.deliveryId))
        .take(1))[0];
      if (row?.delivery === undefined) throw new Error("missing coexisting corruption fixture");
      await ctx.db.patch(row._id, {
        delivery: { ...row.delivery, bodyDigest: "0".repeat(64) },
      });
    });
    const corruptSettlement = await world.runtime.mutation(settleAttempt, {
      deliveryId: second.deliveryId,
      generation: second.generation,
      globalNotificationGeneration: second.globalNotificationGeneration,
      result: { kind: "accepted", providerMessageId: "never_retained" },
    });
    expect(corruptSettlement).toMatchObject({ kind: "safety_fault" });
    const faults = await safetyFaults(world);
    const firstFault = faults.find((fault) =>
      fault.deliveryId === first.deliveryId && fault.reason === "invalid_idempotent_request");
    const storedFault = faults.find((fault) => fault.reason === "stored_delivery_corrupt");
    if (
      firstFault?.faultId === undefined
      || firstFault.resultDigest === undefined
      || storedFault?.faultId === undefined
      || storedFault.resultDigest === undefined
      || storedFault.observedAt === undefined
    ) throw new Error("missing coexisting fault rows");
    expect(corruptSettlement).toMatchObject({ quarantineFaultId: storedFault.faultId });

    await world.runtime.mutation(acknowledgeSafetyFault, {
      expectedDeliveryId: first.deliveryId,
      expectedFaultId: firstFault.faultId,
      expectedGeneration: 2,
      expectedResultDigest: firstFault.resultDigest,
      mutationId: "01912345-6789-7abc-8def-0123456789d5",
    });
    expect(storedFault).toMatchObject({
      reason: "stored_delivery_corrupt",
    });
    const storedReviewArgs = {
      expectedDeliveryId: storedFault.deliveryId,
      expectedFaultId: storedFault.faultId,
      expectedGeneration: 2,
      expectedResultDigest: storedFault.resultDigest,
      mutationId: "01912345-6789-7abc-8def-0123456789d6",
    };
    await expect(world.runtime.mutation(acknowledgeSafetyFault, storedReviewArgs))
      .rejects.toThrow("ATTENTION_NOTIFICATION_SAFETY_FAULT_LATCHED");
    expect(await world.runtime.mutation(quarantineFaultedDelivery, {
      faultId: storedFault.faultId,
    })).toEqual({ deleted: 1, remaining: false });
    const quarantined = (await safetyFaults(world)).find((fault) =>
      fault.faultId === storedFault.faultId);
    expect(quarantined?.cleanupRowId).toBeUndefined();
    const quarantineCompletedAt = quarantined?.quarantineCompletedAt;
    if (quarantineCompletedAt === undefined) throw new Error("missing quarantine proof");
    expect(quarantineCompletedAt).toBeGreaterThanOrEqual(storedFault.observedAt);
    await world.runtime.mutation(acknowledgeSafetyFault, storedReviewArgs);
    expect(await world.runtime.mutation(transition, {
      enabled: true,
      expectedGeneration: 2,
      mutationId: "01912345-6789-7abc-8def-0123456789d7",
    })).toMatchObject({ enabled: true, generation: 3 });
  });

  test("treats a 409 settlement after erasure as inert", async () => {
    const world = await notificationWorld();
    expect(await world.runtime.mutation(settleAttempt, {
      deliveryId: "01912345-6789-7abc-8def-0123456789c7",
      generation: 1,
      globalNotificationGeneration: 1,
      result: {
        kind: "ambiguous",
        providerErrorType: "invalid_idempotent_request",
        safetyFault: true,
        status: 409,
      },
    })).toEqual({ kind: "erased" });
    expect(await world.runtime.query(readControlStatus, {})).toMatchObject({
      enabled: true,
      generation: 1,
      safetyFault: null,
    });
  });

  test("does not resurrect a pending interaction across global disable and re-enable", async () => {
    const world = await notificationWorld();
    await complete(world);
    await world.runtime.mutation(transition, {
      enabled: false,
      expectedGeneration: 1,
      mutationId: "01912345-6789-7abc-8def-0123456789a2",
    });
    await world.runtime.mutation(transition, {
      enabled: true,
      expectedGeneration: 2,
      mutationId: "01912345-6789-7abc-8def-0123456789a3",
    });
    await complete(world, [candidate()], 2, 1, 3);
    const rows = await world.runtime.run(async (ctx) =>
      await ctx.db.query("attentionNotificationOutbox").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      globalNotificationGeneration: 1,
      nonterminal: false,
      retrySuppressionReason: "global_disabled",
      state: "cancelled",
    });
  });

  test("does not resurrect a pending interaction across a local policy generation", async () => {
    const world = await notificationWorld();
    await complete(world);
    await world.runtime.run(async (ctx) => {
      const registry = await ctx.db.query("deviceRegistries").unique();
      if (registry === null) throw new Error("missing registry fixture");
      await ctx.db.patch(registry._id, { notificationPolicyRevision: 2 });
    });
    await complete(world, [candidate()], 2, 2, 1);
    const rows = await world.runtime.run(async (ctx) =>
      await ctx.db.query("attentionNotificationOutbox").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      localNotificationPolicyRevision: 1,
      nonterminal: false,
      retrySuppressionReason: "local_policy_changed",
      state: "cancelled",
    });
  });

  test("rejects undocumented refusal cross-pairs and a wrong settlement generation fence", async () => {
    const world = await notificationWorld();
    await complete(world);
    await makeDue(world);
    const effect = await claim(world);
    await expect(world.runtime.mutation(settleAttempt, {
      deliveryId: effect.deliveryId,
      generation: effect.generation,
      globalNotificationGeneration: effect.globalNotificationGeneration,
      result: {
        kind: "refused",
        providerErrorType: "invalid_api_key",
        status: 409,
      },
    })).rejects.toThrow("ATTENTION_NOTIFICATION_AUTHORITY_CORRUPT");
    await expect(world.runtime.mutation(settleAttempt, {
      deliveryId: effect.deliveryId,
      generation: effect.generation,
      globalNotificationGeneration: effect.globalNotificationGeneration + 1,
      result: { kind: "accepted", providerMessageId: "message_valid" },
    })).rejects.toThrow("ATTENTION_NOTIFICATION_AUTHORITY_CORRUPT");
    expect(await world.runtime.run(async (ctx) =>
      await ctx.db.query("attentionNotificationOutbox").unique())).toMatchObject({
      nonterminal: true,
      state: "effect_started",
    });
  });

  test("stores only an accepted outcome digest and safety-latches stored group divergence", async () => {
    const acceptedWorld = await notificationWorld();
    await complete(acceptedWorld);
    await makeDue(acceptedWorld);
    const accepted = await claim(acceptedWorld);
    await acceptedWorld.runtime.mutation(settleAttempt, {
      deliveryId: accepted.deliveryId,
      generation: accepted.generation,
      globalNotificationGeneration: accepted.globalNotificationGeneration,
      result: { kind: "accepted", providerMessageId: "message_accepted" },
    });
    const acceptedRow = await acceptedWorld.runtime.run(async (ctx) =>
      await ctx.db.query("attentionNotificationOutbox").unique());
    expect(acceptedRow).toMatchObject({
      delivery: {
        outcomeCode: "provider_accepted",
        outcomeDigest: expect.stringMatching(/^[0-9a-f]{64}$/u) as unknown as string,
      },
      state: "accepted",
    });
    expect(acceptedRow?.delivery).not.toHaveProperty("providerMessageId");
    expect(await acceptedWorld.runtime.mutation(settleAttempt, {
      deliveryId: accepted.deliveryId,
      generation: accepted.generation,
      globalNotificationGeneration: accepted.globalNotificationGeneration,
      result: { kind: "accepted", providerMessageId: "message_accepted" },
    })).toEqual({ kind: "replay" });
    await expect(acceptedWorld.runtime.mutation(settleAttempt, {
      deliveryId: accepted.deliveryId,
      generation: accepted.generation + 1,
      globalNotificationGeneration: accepted.globalNotificationGeneration,
      result: { kind: "accepted", providerMessageId: "message_accepted" },
    })).rejects.toThrow("ATTENTION_NOTIFICATION_AUTHORITY_CORRUPT");

    const corruptWorld = await notificationWorld();
    await complete(corruptWorld);
    await makeDue(corruptWorld);
    const corruptEffect = await claim(corruptWorld);
    await corruptWorld.runtime.run(async (ctx) => {
      const row = await ctx.db.query("attentionNotificationOutbox").unique();
      if (row?.delivery === undefined) throw new Error("missing delivery fixture");
      await ctx.db.patch(row._id, {
        delivery: { ...row.delivery, bodyDigest: "0".repeat(64) },
      });
    });
    const corruptSettlement = await corruptWorld.runtime.mutation(settleAttempt, {
      deliveryId: corruptEffect.deliveryId,
      generation: corruptEffect.generation,
      globalNotificationGeneration: corruptEffect.globalNotificationGeneration,
      result: { kind: "accepted", providerMessageId: "message_never_stored" },
    });
    expect(corruptSettlement).toMatchObject({
      kind: "safety_fault",
      quarantineFaultId: expect.any(String) as unknown as string,
    });
    expect(await corruptWorld.runtime.query(readControlStatus, {})).toMatchObject({
      enabled: false,
      safetyFault: { reason: "stored_delivery_corrupt", state: "latched" },
    });
  });

  test("latches a mixed-state corrupt group without requiring normal terminalization", async () => {
    const world = await notificationWorld();
    await complete(world, [candidate(1), candidate(2)]);
    await makeDue(world);
    const effect = await claim(world);
    await makeRetryDue(world, effect.deliveryId);
    await world.runtime.run(async (ctx) => {
      const rows = await ctx.db.query("attentionNotificationOutbox")
        .withIndex("by_delivery_id", (builder) => builder.eq("delivery.id", effect.deliveryId))
        .collect();
      const corruptRow = rows[0];
      if (corruptRow === undefined) throw new Error("missing corrupt group fixture");
      const patch = {
        nonterminal: false,
        state: "cancelled" as const,
        terminalCleanupAfter: Date.now() + 60_000,
      };
      await adjustCommandQuotaForPatch(ctx, world.ids.userId, corruptRow, patch);
      await ctx.db.patch(corruptRow._id, patch);
    });
    const corruptSettlement = await world.runtime.mutation(settleAttempt, {
      deliveryId: effect.deliveryId,
      generation: effect.generation,
      globalNotificationGeneration: effect.globalNotificationGeneration,
      result: { kind: "accepted", providerMessageId: "message_never_stored" },
    });
    expect(corruptSettlement).toMatchObject({
      kind: "safety_fault",
      quarantineFaultId: expect.any(String) as unknown as string,
    });
    expect(await world.runtime.query(readControlStatus, {})).toMatchObject({
      enabled: false,
      safetyFault: { reason: "stored_delivery_corrupt", state: "latched" },
    });
    expect(await world.runtime.action(drainNotifications, { limit: 10 })).toEqual({
      claimed: 0,
      closed: 0,
      processed: 0,
    });
    const faultId = (await world.runtime.query(readControlStatus, {})).safetyFault?.faultId;
    if (faultId === undefined) throw new Error("missing mixed-state fault id");
    expect(await world.runtime.mutation(quarantineFaultedDelivery, { faultId }))
      .toEqual({ deleted: 2, remaining: false });
    expect(await world.runtime.run(async (ctx) =>
      await ctx.db.query("attentionNotificationOutbox").collect())).toEqual([]);
  });

  test("account deletion releases fault capacity before erasing a corrupt group", async () => {
    const world = await notificationWorld();
    await complete(world, [candidate(1), candidate(2)]);
    await makeDue(world);
    const effect = await claim(world);
    const malformedDeliveryId = "corrupt_account_deletion_locator";
    await world.runtime.run(async (ctx) => {
      const rows = await ctx.db.query("attentionNotificationOutbox")
        .withIndex("by_delivery_id", (builder) => builder.eq("delivery.id", effect.deliveryId))
        .collect();
      for (const row of rows) {
        if (row.delivery === undefined) throw new Error("missing corrupt delivery fixture");
        const patch = {
          delivery: {
            ...row.delivery,
            id: malformedDeliveryId,
            nextAttemptAt: Date.now() - 1,
          },
        };
        await adjustCommandQuotaForPatch(ctx, world.ids.userId, row, patch);
        await ctx.db.patch(row._id, patch);
      }
    });
    const closed = await world.runtime.mutation(claimNext, {});
    expect(closed).toMatchObject({ kind: "closed", quarantineFaultId: expect.any(String) });
    const fault = (await safetyFaults(world)).find((row) => row.state === "latched");
    if (
      fault?.cleanupRowId === undefined
      || fault.faultId === undefined
      || fault.resultDigest === undefined
    ) throw new Error("missing quarantine locator");
    const cleanupRowId = fault.cleanupRowId;
    const publicFault = (await world.runtime.query(readControlStatus, {})).safetyFault;
    expect(publicFault).not.toHaveProperty("cleanupRowId");
    expect(publicFault).not.toHaveProperty("quarantineCompletedAt");
    await insertDeletionJob(world, "deletion_attests_corrupt_delivery", true);

    expect(await world.runtime.mutation(drainAccountDeletion, { limit: 1 }))
      .toMatchObject({ category: "commands_and_leases", processed: 1 });
    expect(await world.runtime.run(async (ctx) => await ctx.db.get(cleanupRowId))).not.toBeNull();
    expect((await safetyFaults(world)).find((row) => row.faultId === fault.faultId))
      .toBeUndefined();
    for (let index = 0; index < 8; index += 1) {
      await world.runtime.mutation(drainAccountDeletion, { limit: 1 });
    }
    expect(await world.runtime.run(async (ctx) =>
      await ctx.db.query("attentionNotificationOutbox").collect())).toEqual([]);
    expect((await safetyFaults(world)).filter((row) => row.userId === world.ids.userId))
      .toEqual([]);
    expect((await world.runtime.query(readControlStatus, {})).safetyFault).toBeNull();
  });

  test("does not treat a missing corrupt-group locator as completed quarantine", async () => {
    const world = await notificationWorld();
    await complete(world, [candidate(1), candidate(2)]);
    await makeDue(world);
    const effect = await claim(world);
    const malformedDeliveryId = "corrupt_deleted_account_deletion_locator";
    await world.runtime.run(async (ctx) => {
      const rows = await ctx.db.query("attentionNotificationOutbox")
        .withIndex("by_delivery_id", (builder) => builder.eq("delivery.id", effect.deliveryId))
        .collect();
      for (const row of rows) {
        if (row.delivery === undefined) throw new Error("missing corrupt delivery fixture");
        const patch = {
          delivery: {
            ...row.delivery,
            id: malformedDeliveryId,
            nextAttemptAt: Date.now() - 1,
          },
        };
        await adjustCommandQuotaForPatch(ctx, world.ids.userId, row, patch);
        await ctx.db.patch(row._id, patch);
      }
    });
    expect(await world.runtime.mutation(claimNext, {})).toMatchObject({
      kind: "closed",
      quarantineFaultId: expect.any(String),
    });
    const fault = (await safetyFaults(world)).find((row) => row.state === "latched");
    if (
      fault?.cleanupRowId === undefined
      || fault.faultId === undefined
      || fault.resultDigest === undefined
    ) throw new Error("missing quarantine locator");
    const cleanupRowId = fault.cleanupRowId;
    const reviewArgs = {
      expectedDeliveryId: fault.deliveryId,
      expectedFaultId: fault.faultId,
      expectedGeneration: 2,
      expectedResultDigest: fault.resultDigest,
      mutationId: "01912345-6789-7abc-8def-0123456789c9",
    };

    await world.runtime.run(async (ctx) => {
      const locator = await ctx.db.get(cleanupRowId);
      if (locator === null) throw new Error("missing quarantine locator row");
      await releaseCommandQuotaForDelete(ctx, world.ids.userId, locator);
      await ctx.db.delete(locator._id);
    });
    expect(await world.runtime.run(async (ctx) =>
      await ctx.db.query("attentionNotificationOutbox").collect())).toHaveLength(1);
    const incomplete = (await safetyFaults(world)).find((row) =>
      row.faultId === fault.faultId);
    expect(incomplete?.cleanupRowId).toBe(cleanupRowId);
    expect(incomplete?.quarantineCompletedAt).toBeUndefined();
    await expect(world.runtime.mutation(acknowledgeSafetyFault, reviewArgs))
      .rejects.toThrow("ATTENTION_NOTIFICATION_SAFETY_FAULT_LATCHED");

    await insertDeletionJob(world, "deletion_recovers_missing_corrupt_locator", true);
    for (let index = 0; index < 8; index += 1) {
      await world.runtime.mutation(drainAccountDeletion, { limit: 1 });
    }
    expect(await world.runtime.run(async (ctx) =>
      await ctx.db.query("attentionNotificationOutbox").collect())).toEqual([]);
    expect((await safetyFaults(world)).filter((row) => row.userId === world.ids.userId))
      .toEqual([]);
  });

  test("blocks review until a malformed-id delivery is quarantined through its safe locator", async () => {
    const world = await notificationWorld();
    await complete(world);
    await makeDue(world);
    const effect = await claim(world);
    const malformedDeliveryId = "corrupt_delivery_locator";
    await world.runtime.run(async (ctx) => {
      const row = await ctx.db.query("attentionNotificationOutbox").unique();
      if (row?.delivery === undefined) throw new Error("missing malformed delivery fixture");
      const patch = {
        delivery: {
          ...row.delivery,
          id: malformedDeliveryId,
          nextAttemptAt: Date.now() - 1,
        },
      };
      await adjustCommandQuotaForPatch(ctx, world.ids.userId, row, patch);
      await ctx.db.patch(row._id, patch);
    });
    expect(await world.runtime.mutation(claimNext, {})).toMatchObject({
      kind: "closed",
      quarantineFaultId: expect.any(String),
    });
    const fault = (await safetyFaults(world)).find((row) => row.state === "latched");
    if (fault?.faultId === undefined || fault.resultDigest === undefined) {
      throw new Error("missing malformed-id safety fault");
    }
    expect(fault.deliveryId).not.toBe(effect.deliveryId);
    expect(fault.cleanupRowId).toBeDefined();
    const reviewArgs = {
      expectedDeliveryId: fault.deliveryId,
      expectedFaultId: fault.faultId,
      expectedGeneration: 2,
      expectedResultDigest: fault.resultDigest,
      mutationId: "01912345-6789-7abc-8def-0123456789c3",
    };
    await expect(world.runtime.mutation(acknowledgeSafetyFault, reviewArgs))
      .rejects.toThrow("ATTENTION_NOTIFICATION_SAFETY_FAULT_LATCHED");
    await expect(world.runtime.mutation(transition, {
      enabled: true,
      expectedGeneration: 2,
      mutationId: "01912345-6789-7abc-8def-0123456789c4",
    })).rejects.toThrow("ATTENTION_NOTIFICATION_SAFETY_FAULT_LATCHED");

    const cleanupRowId = fault.cleanupRowId;
    if (cleanupRowId === undefined) throw new Error("missing malformed-id cleanup locator");
    await world.runtime.run(async (ctx) => {
      const locator = await ctx.db.get(cleanupRowId);
      if (locator === null) throw new Error("missing malformed-id locator row");
      const terminalPatch = {
        claimCapacityReservation: undefined,
        nonterminal: false,
        state: "ambiguous" as const,
        terminalCleanupAfter: Date.now() - 1,
      };
      await adjustCommandQuotaForPatch(ctx, world.ids.userId, locator, terminalPatch);
      await ctx.db.patch(locator._id, terminalPatch);
      const receiptId = await ctx.db.insert("accountDeletionReceipts", {
        completedAt: Date.now() - 2,
        expiresAt: Date.now() - 1,
        publicId: "fault_locator_maintenance_budget",
        statusCapabilityDigest: "b".repeat(64),
      });
      const receipt = await ctx.db.get(receiptId);
      if (receipt === null) throw new Error("missing maintenance budget fixture");
      await reserveServiceQuotaForInsert(ctx, receipt);
      const maintenanceState = await ctx.db.query("maintenanceState").unique();
      if (maintenanceState === null) {
        await ctx.db.insert("maintenanceState", {
          key: "retention",
          nextCategory: "terminal_attention_notifications",
          updatedAt: Date.now(),
        });
      } else {
        await ctx.db.patch(maintenanceState._id, {
          nextCategory: "terminal_attention_notifications",
          updatedAt: Date.now(),
        });
      }
    });
    expect(await world.runtime.mutation(cleanupExpired, { limit: 1 })).toMatchObject({
      accountDeletionReceipts: 1,
      processed: 1,
      terminalAttentionNotifications: 0,
    });
    expect(await world.runtime.run(async (ctx) => await ctx.db.get(cleanupRowId))).not.toBeNull();
    expect(await world.runtime.mutation(quarantineFaultedDelivery, { faultId: fault.faultId }))
      .toEqual({ deleted: 1, remaining: false });
    expect(await world.runtime.run(async (ctx) =>
      await ctx.db.query("attentionNotificationOutbox").collect())).toEqual([]);
    await world.runtime.mutation(acknowledgeSafetyFault, reviewArgs);
    await world.runtime.mutation(transition, {
      enabled: true,
      expectedGeneration: 2,
      mutationId: "01912345-6789-7abc-8def-0123456789c4",
    });
    await selectAttentionMaintenanceFirst(world);
    expect(await world.runtime.mutation(cleanupExpired, { limit: 20 })).toMatchObject({
      processed: 0,
      startedAttentionNotifications: 0,
    });
    expect(await world.runtime.mutation(claimNext, {})).toBeNull();
    expect(await world.runtime.query(readControlStatus, {})).toMatchObject({
      enabled: true,
      generation: 3,
    });
  });

  test("quarantines an oversized delivery and leaves later work stable across re-enable", async () => {
    const world = await notificationWorld();
    await complete(world, Array.from({ length: 10 }, (_, index) => candidate(index + 1)));
    await makeDue(world);
    const effect = await claim(world);
    await world.runtime.run(async (ctx) => {
      const started = await ctx.db.query("attentionNotificationOutbox")
        .withIndex("by_delivery_id", (builder) => builder.eq("delivery.id", effect.deliveryId))
        .collect();
      const leader = started.find((row) => row.delivery?.body !== undefined);
      const pending = await ctx.db.query("attentionNotificationOutbox")
        .withIndex("by_user_and_interaction", (builder) => builder
          .eq("userId", world.ids.userId)
          .eq("interactionId", candidate(9).interactionId))
        .unique();
      if (leader?.delivery === undefined || pending === null) {
        throw new Error("missing oversized delivery fixture");
      }
      const dueAt = Date.now() - 1;
      for (const row of started) {
        if (row.delivery === undefined) throw new Error("missing started delivery fixture");
        const patch = {
          delivery: { ...row.delivery, nextAttemptAt: dueAt },
        };
        await adjustCommandQuotaForPatch(ctx, world.ids.userId, row, patch);
        await ctx.db.patch(row._id, patch);
      }
      const leaderDelivery = { ...leader.delivery };
      Reflect.deleteProperty(leaderDelivery, "body");
      const delivery = { ...leaderDelivery, nextAttemptAt: dueAt };
      const patch = {
        claimCapacityReservation: attentionNotificationQuotaReservations.started,
        delivery,
        faultCapacityAnchor: leader.faultCapacityAnchor,
        state: "effect_started" as const,
      };
      await adjustCommandQuotaForPatch(ctx, world.ids.userId, pending, patch);
      await ctx.db.patch(pending._id, patch);
    });
    expect(await world.runtime.action(drainNotifications, { limit: 10 })).toEqual({
      claimed: 0,
      closed: 1,
      processed: 1,
    });
    expect(await world.runtime.query(readControlStatus, {})).toMatchObject({
      enabled: false,
      safetyFault: { reason: "stored_delivery_corrupt", state: "latched" },
    });
    const remaining = await world.runtime.run(async (ctx) =>
      await ctx.db.query("attentionNotificationOutbox").collect());
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toMatchObject({
      interactionId: candidate(10).interactionId,
      state: "pending",
    });
    expect(await world.runtime.action(drainNotifications, { limit: 10 })).toEqual({
      claimed: 0,
      closed: 0,
      processed: 0,
    });
    const fault = (await safetyFaults(world)).find((row) => row.state === "latched");
    if (fault?.faultId === undefined || fault.resultDigest === undefined) {
      throw new Error("missing oversized-delivery safety fault");
    }
    await world.runtime.mutation(acknowledgeSafetyFault, {
      expectedDeliveryId: fault.deliveryId,
      expectedFaultId: fault.faultId,
      expectedGeneration: 2,
      expectedResultDigest: fault.resultDigest,
      mutationId: "01912345-6789-7abc-8def-0123456789c1",
    });
    await world.runtime.mutation(transition, {
      enabled: true,
      expectedGeneration: 2,
      mutationId: "01912345-6789-7abc-8def-0123456789c2",
    });
    expect(await world.runtime.mutation(claimNext, {})).toEqual({ kind: "closed" });
    expect(await world.runtime.mutation(claimNext, {})).toBeNull();
    expect(await world.runtime.query(readControlStatus, {})).toMatchObject({
      enabled: true,
      generation: 3,
      safetyFault: null,
    });
  });

  test("uses exactly three same-key attempts before terminal ambiguity", async () => {
    const world = await notificationWorld();
    await complete(world);
    await makeDue(world);
    const first = await claim(world);
    expect(await world.runtime.mutation(settleAttempt, {
      deliveryId: first.deliveryId,
      generation: first.generation,
      globalNotificationGeneration: first.globalNotificationGeneration,
      result: { kind: "retryable", reason: "network" },
    })).toMatchObject({ kind: "retry_scheduled" });
    await makeRetryDue(world, first.deliveryId);
    const second = await claim(world);
    expect(second).toMatchObject({
      deliveryId: first.deliveryId,
      generation: 2,
      idempotencyKey: first.idempotencyKey,
    });
    await world.runtime.mutation(settleAttempt, {
      deliveryId: second.deliveryId,
      generation: second.generation,
      globalNotificationGeneration: second.globalNotificationGeneration,
      result: { kind: "retryable", reason: "transient_http" },
    });
    await makeRetryDue(world, second.deliveryId);
    const third = await claim(world);
    expect(third).toMatchObject({
      deliveryId: first.deliveryId,
      generation: 3,
      idempotencyKey: first.idempotencyKey,
    });
    expect(await world.runtime.mutation(settleAttempt, {
      deliveryId: third.deliveryId,
      generation: third.generation,
      globalNotificationGeneration: third.globalNotificationGeneration,
      result: { kind: "retryable", reason: "timeout" },
    })).toEqual({ kind: "ambiguous", reason: "retry_exhausted" });
    expect(await world.runtime.run(async (ctx) =>
      await ctx.db.query("attentionNotificationOutbox").unique())).toMatchObject({
      delivery: { attemptCount: 3, outcomeCode: "retry_exhausted" },
      nonterminal: false,
      state: "ambiguous",
    });
  });

  test("lets account-deletion erasure win over exact settlement", async () => {
    const world = await notificationWorld();
    await complete(world);
    await makeDue(world);
    const effect = await claim(world);
    await world.runtime.run(async (ctx) => {
      const subjects = await ctx.db.query("authSubjects")
        .withIndex("by_user", (builder) => builder.eq("userId", world.ids.userId))
        .collect();
      const subject = subjects[0];
      if (subject === undefined) throw new Error("missing subject fixture");
      await ctx.db.patch(subject._id, { status: "disabled", updatedAt: Date.now() });
      await ctx.db.insert("accountDeletionJobs", {
        category: "commands_and_leases",
        createdAt: Date.now(),
        publicId: "deletion_attention_runtime",
        state: "pending",
        statusCapabilityDigest: "d".repeat(64),
        subjectId: subject._id,
        updatedAt: Date.now(),
        userId: world.ids.userId,
      });
    });
    expect(await world.runtime.mutation(settleAttempt, {
      deliveryId: effect.deliveryId,
      generation: effect.generation,
      globalNotificationGeneration: effect.globalNotificationGeneration,
      result: { kind: "accepted", providerMessageId: "message_erased" },
    })).toEqual({ kind: "erasure_pending" });
    expect(await world.runtime.run(async (ctx) =>
      await ctx.db.query("attentionNotificationOutbox").unique())).toMatchObject({
      nonterminal: true,
      state: "effect_started",
    });
  });

  test("defers a corrupt cap overflow strictly into the future instead of hot-looping", async () => {
    const world = await notificationWorld();
    await complete(world);
    await makeDue(world);
    const now = Date.now();
    await world.runtime.run(async (ctx) => {
      for (let index = 0; index < 49; index += 1) {
        const historical = {
          allowedWindowEnd: now + 60 * 60 * 1_000,
          claimDeadline: now + 60 * 60 * 1_000,
          coalesceAfter: now - 1,
          consentLeaseUntil: now + 60_000,
          createdAt: now - 1_000,
          executionAuthority: {
            bootGeneration: 1,
            bootId: "boot_attention_runtime",
            fence: 1,
          },
          globalNotificationGeneration: 1,
          interactionDeadline: now + 60 * 60 * 1_000,
          interactionId: `historical_interaction_${String(index).padStart(2, "0")}`,
          interactionKind: "command_approval" as const,
          interactionRevision: 1,
          localNotificationPolicyRevision: 1,
          nonterminal: false,
          reconciliationSequence: 1,
          remoteActions: ["decline"] as ("decline" | "answer")[],
          sessionId: world.ids.sessionId,
          sessionPublicId: "session_attention_runtime",
          sourceDeviceId: world.ids.deviceId,
          state: "accepted" as const,
          terminalCleanupAfter: now + 60 * 60 * 1_000,
          updatedAt: now,
          userId: world.ids.userId,
        };
        const id = await ctx.db.insert("attentionNotificationOutbox", historical);
        await ctx.db.patch(id, {
          delivery: {
            attemptCount: 1,
            bodyDigest: "1".repeat(64),
            claimedAt: now - 1_000,
            deadline: now + 60_000,
            effectStartedAt: now - 1_000,
            firstAttemptAt: now - 1_000,
            generation: 1,
            id: `history_delivery_${String(index).padStart(2, "0")}`,
            idempotencyKey: "2".repeat(64),
            lastAttemptAt: now - 1_000,
            leaderRowId: id,
            outcomeCode: "provider_accepted",
            outcomeDigest: "3".repeat(64),
            recipientDigest: "4".repeat(64),
            settledAt: now,
          },
        });
      }
    });
    expect(await world.runtime.mutation(claimNext, {})).toEqual({ kind: "closed" });
    const seed = await world.runtime.run(async (ctx) =>
      await ctx.db.query("attentionNotificationOutbox")
        .withIndex("by_user_and_interaction", (builder) => builder
          .eq("userId", world.ids.userId)
          .eq("interactionId", candidate().interactionId))
        .unique());
    expect(
      seed?.state === "expired"
      || (seed?.state === "pending" && seed.coalesceAfter > now),
    ).toBeTrue();
  });

  test("defers a claim counted at the exact rolling-window cutoff past now", async () => {
    jest.useFakeTimers();
    const now = 1_800_000_000_000;
    jest.setSystemTime(now);
    try {
      const world = await notificationWorld();
      await complete(world);
      await makeDue(world);
      await insertHistoricalClaims(world, 6, now - 60 * 60 * 1_000);
      expect(await world.runtime.mutation(claimNext, {})).toEqual({ kind: "closed" });
      const seed = await world.runtime.run(async (ctx) =>
        await ctx.db.query("attentionNotificationOutbox")
          .withIndex("by_user_and_interaction", (builder) => builder
            .eq("userId", world.ids.userId)
            .eq("interactionId", candidate().interactionId))
          .unique());
      expect(seed).toMatchObject({
        coalesceAfter: now + 1,
        state: "pending",
      });
    } finally {
      jest.useRealTimers();
    }
  });

  test("rejects 65 candidates without consuming the previous complete snapshot", async () => {
    const world = await notificationWorld();
    await expect(complete(
      world,
      Array.from({ length: 65 }, (_, index) => candidate(index + 1)),
    )).rejects.toThrow("ATTENTION_NOTIFICATION_RECONCILIATION_REJECTED");
    expect(await world.runtime.run(async (ctx) =>
      await ctx.db.query("attentionNotificationOutbox").collect())).toEqual([]);
  });
});
