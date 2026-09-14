import { describe, expect, test } from "bun:test";
import { makeFunctionReference } from "convex/server";
import type { GenericId as Id, Value } from "convex/values";
import { convexTest } from "convex-test";
import fc from "fast-check";

import { USAGE_POLL_MIN_INTERVAL_MS } from "../src/daemon/usage-poller";
import {
  identityInviteLifetimeMs,
  invitePublicIdFromCapabilityDigest,
} from "../src/cloud/inviteAuthority";
import {
  parseUsageEncryptedEnvelope,
  USAGE_CLOUD_ENVELOPE_MAX_CIPHERTEXT_CHARACTERS,
} from "../src/cloud/usage";
import {
  USAGE_CLOUD_UPLOAD_MIN_INTERVAL_MS,
  USAGE_LOCAL_RETAIN_BYTES,
  USAGE_LOCAL_SNAPSHOT_MAX_BYTES,
} from "../src/storage/state-store";
import {
  CLOUD_USAGE_SNAPSHOT_RETENTION_MS,
  HOSTED_TABLE_LIFECYCLE,
} from "./lifecyclePolicy";
import {
  createAccountDeletionCapacityForNewUser,
  createDeviceRevocationCapacityForNewDevice,
} from "./authorityReductionCapacity";
import schema from "./schema";
import { modules } from "./test.setup";
import {
  USAGE_ADMISSION_EXPIRY_RELEASE_LIMIT,
  USAGE_SERVER_ADMISSION_MIN_INTERVAL_MS,
} from "./usage";
import {
  authorityReductionReservationDemand,
  inspectAuthorityReductionQuota,
  ACCOUNT_RESOURCE_QUOTAS,
  CATEGORY_QUOTAS,
  SERVICE_TOTAL_QUOTA,
  USER_RESOURCE_QUOTAS,
  USER_TOTAL_QUOTA,
  adjustCommandQuotaForPatch,
  adjustQuotaForPatch,
  adjustServiceQuotaForPatch,
  finalizeUserQuotaAuthorityForDelete,
  hostedBootstrapStatus as hostedBootstrapStatusQuery,
  initializeAccountUsageQuotaAuthority,
  initializeUserQuotaAuthority,
  logicalDocumentBytes,
  nextQuotaSnapshot,
  nextResourceRecords,
  releaseQuotaForDelete,
  releaseQuotaForStoredIdentity,
  releaseServiceQuotaForDelete,
  reserveAccountUsageSnapshotQuotaForInsert,
  reserveCodexAccountQuotaForInsert,
  reserveDeviceQuotaForInsert,
  reserveNonterminalCommandQuotaForInsert,
  reserveQuotaForInsert,
  reserveQuotaForStoredIdentity,
  reserveServiceQuotaForInsert,
  reserveSessionChunkQuotaForInsert,
  reserveSessionHeadQuotaForInsert,
} from "./quota";
import type { QuotaCategory } from "./quota";
import { durableJobCapacityReservation } from "./validators";

type Args = Readonly<Record<string, Value>>;
type PresenceResponse = Readonly<{ online: boolean; sequence: number | null }>;

const genesisHardAuthority = makeFunctionReference<
  "mutation",
  Record<string, never>,
  Readonly<{ enforcement: "hard" }>
>("quota:genesisHardAuthority");
const genesisHostedAuthority = makeFunctionReference<"mutation", Readonly<{
  capabilityDigest: string;
  lifetimeMs: number;
  publicId: string;
}>, unknown>("quota:genesisHostedAuthority");
const hostedBootstrapStatus = makeFunctionReference<"query", Record<string, never>, Readonly<{
  occupiedTableCount: number;
  serviceControlCount: 0 | 1 | 2;
  state: "accepted" | "inconsistent" | "ready" | "uninitialized";
}>>("quota:hostedBootstrapStatus");
const connect = makeFunctionReference<"mutation", Args, PresenceResponse>("presence:connect");
const heartbeat = makeFunctionReference<"mutation", Args, PresenceResponse>("presence:heartbeat");
const auditDirectTablePage = makeFunctionReference<"query", Args, Readonly<{
  category: QuotaCategory;
  continueCursor: string;
  isDone: boolean;
  logicalBytes: number;
  records: number;
  table: string;
}>>("quota:auditDirectTablePage");

const envelope = {
  algorithm: "A256GCM" as const,
  ciphertext: "ciphertext",
  keyVersion: 1,
  nonce: "nonce",
};

async function quotaWorld() {
  const testRuntime = convexTest(schema, modules);
  await testRuntime.mutation(genesisHardAuthority, {});
  const now = Date.now();
  const ids = await testRuntime.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      email: "quota@example.com",
      emailVerificationTime: now,
    });
    await initializeUserQuotaAuthority(ctx, userId);
    const user = await ctx.db.get(userId);
    if (user === null) throw new Error("missing quota fixture user");
    await reserveQuotaForStoredIdentity(ctx, userId, user);
    const authSession = {
      expirationTime: now + 3_600_000,
      userId,
    };
    await reserveQuotaForInsert(ctx, userId, "identity", authSession);
    const authSessionId = await ctx.db.insert("authSessions", authSession);
    const subject = {
      authEpoch: 1,
      createdAt: now,
      emailDigest: "a".repeat(64),
      status: "active",
      updatedAt: now,
      userId,
    } as const;
    await reserveQuotaForInsert(ctx, userId, "identity", subject);
    await ctx.db.insert("authSubjects", subject);
    const device = {
      activatedAt: now,
      authEpoch: 1,
      createdAt: now,
      credentialGeneration: 1,
      encryptedLabel: envelope,
      keyVersion: 1,
      publicId: "device_quota_test",
      revision: 1,
      signingPublicKey: "fixture",
      status: "active",
      updatedAt: now,
      userId,
      wrappingPublicKey: "fixture",
    } as const;
    await reserveDeviceQuotaForInsert(ctx, userId, device);
    const deviceId = await ctx.db.insert("devices", device);
    const deviceSession = {
      authEpoch: 1,
      authSessionId,
      boundAt: now,
      deviceId,
      userId,
    };
    await reserveQuotaForInsert(ctx, userId, "custody", deviceSession);
    await ctx.db.insert("deviceSessions", deviceSession);
    return { authSessionId, deviceId, userId };
  });
  return {
    ...ids,
    actor: testRuntime.withIdentity({
      issuer: "https://test.example",
      subject: `${ids.userId}|${ids.authSessionId}`,
      tokenIdentifier: `test|${ids.authSessionId}`,
    }),
    testRuntime,
  };
}

type QuotaRuntime = Awaited<ReturnType<typeof quotaWorld>>["testRuntime"];

async function hostedBootstrapWorld(): Promise<QuotaRuntime> {
  const runtime = convexTest(schema, modules);
  const capabilityDigest = "6".repeat(64);
  expect(await runtime.mutation(genesisHostedAuthority, {
    capabilityDigest,
    lifetimeMs: identityInviteLifetimeMs,
    publicId: invitePublicIdFromCapabilityDigest(capabilityDigest),
  })).toMatchObject({ enforcement: "hard", replay: false });
  return runtime;
}

async function insertOrphanMemoryRow(
  runtime: QuotaRuntime,
  table: "memorySpaces" | "memoryOperations",
): Promise<void> {
  await runtime.run(async (ctx) => {
    const now = Date.now();
    const userId = await ctx.db.insert("users", {});
    const memoryEnvelope = {
      algorithm: "A256GCM" as const,
      ciphertext: "A".repeat(22),
      keyVersion: 1,
      nonce: "B".repeat(16),
    };
    const memorySpaceId = await ctx.db.insert("memorySpaces", {
      bindingPolicy: "one_project_one_space",
      createdAt: now,
      encryptedDescriptor: memoryEnvelope,
      genesisHeadProof: memoryEnvelope,
      genesisToken: "0".repeat(64),
      identityContract: 2,
      keyVersion: 1,
      publicId: `memory_${"A".repeat(32)}`,
      revision: 1,
      updatedAt: now,
      userId,
      wrappedSpaceKey: memoryEnvelope,
    });
    if (table === "memoryOperations") {
      const sourceDeviceId = await ctx.db.insert("devices", {
        authEpoch: 1,
        createdAt: now,
        credentialGeneration: 1,
        deviceClass: "daemon",
        encryptedLabel: memoryEnvelope,
        keyVersion: 1,
        publicId: "device_bootstrap_memory",
        revision: 1,
        signingPublicKey: "fixture",
        status: "active",
        updatedAt: now,
        userId,
        wrappingPublicKey: "fixture",
      });
      await ctx.db.insert("memoryOperations", {
        adoptionProof: null,
        baseRevision: 1,
        createdAt: now,
        genesisToken: "0".repeat(64),
        headToken: "1".repeat(64),
        keyVersion: 1,
        memorySpaceId,
        operation: memoryEnvelope,
        priorToken: "0".repeat(64),
        sequence: 1,
        sourceDeviceId,
        terminalHeadProof: memoryEnvelope,
        userId,
      });
      await ctx.db.delete(memorySpaceId);
      await ctx.db.delete(sourceDeviceId);
    }
    // Model inconsistent stored state without inventing IDs or bypassing the
    // schema. Only the chosen memory table remains occupied by this fixture.
    await ctx.db.delete(userId);
  });
}

async function categoryUsageFor(
  testRuntime: QuotaRuntime,
  userId: Id<"users">,
  category: QuotaCategory,
) {
  return await testRuntime.run(async (ctx) => await ctx.db.query("storageUsageByUser")
    .withIndex("by_user_and_category", (builder) => builder
      .eq("userId", userId)
      .eq("category", category))
    .unique());
}

async function userResourceFor(
  testRuntime: QuotaRuntime,
  userId: Id<"users">,
  resource: keyof typeof USER_RESOURCE_QUOTAS,
) {
  return await testRuntime.run(async (ctx) =>
    await ctx.db.query("storageResourceUsageByUser")
      .withIndex("by_user_and_resource", (builder) => builder
        .eq("userId", userId)
        .eq("resource", resource))
      .unique());
}

describe("hosted bootstrap status table coverage", () => {
  test("reports a genuinely empty deployment as uninitialized", async () => {
    const runtime = convexTest(schema, modules);
    expect(await runtime.query(hostedBootstrapStatus, {})).toEqual({
      occupiedTableCount: 0,
      serviceControlCount: 0,
      state: "uninitialized",
    });
  });

  test("reports the genuine clean hosted-bootstrap frame as ready", async () => {
    const runtime = await hostedBootstrapWorld();
    expect(await runtime.query(hostedBootstrapStatus, {})).toEqual({
      occupiedTableCount: 3,
      serviceControlCount: 1,
      state: "ready",
    });
  });

  for (const table of ["memorySpaces", "memoryOperations"] as const) {
    test(`rejects ${table} as the sole orphan table`, async () => {
      const runtime = convexTest(schema, modules);
      await insertOrphanMemoryRow(runtime, table);
      expect(await runtime.run(async (ctx) => await ctx.db.query(table).collect()))
        .toHaveLength(1);
      expect(await runtime.query(hostedBootstrapStatus, {})).toEqual({
        occupiedTableCount: 1,
        serviceControlCount: 0,
        state: "inconsistent",
      });
    });

    test(`rejects unaccounted ${table} after genuine hosted bootstrap`, async () => {
      const runtime = await hostedBootstrapWorld();
      expect(await runtime.query(hostedBootstrapStatus, {})).toEqual({
        occupiedTableCount: 3,
        serviceControlCount: 1,
        state: "ready",
      });
      await insertOrphanMemoryRow(runtime, table);
      expect(await runtime.query(hostedBootstrapStatus, {})).toEqual({
        occupiedTableCount: 4,
        serviceControlCount: 1,
        state: "inconsistent",
      });
    });

    test(`counts multiple ${table} rows as one occupied table`, async () => {
      const runtime = convexTest(schema, modules);
      await insertOrphanMemoryRow(runtime, table);
      await insertOrphanMemoryRow(runtime, table);
      expect(await runtime.run(async (ctx) => await ctx.db.query(table).collect()))
        .toHaveLength(2);
      expect(await runtime.query(hostedBootstrapStatus, {})).toEqual({
        occupiedTableCount: 1,
        serviceControlCount: 0,
        state: "inconsistent",
      });
    });
  }

  test("counts both orphan memory tables independently", async () => {
    const runtime = convexTest(schema, modules);
    await insertOrphanMemoryRow(runtime, "memorySpaces");
    await insertOrphanMemoryRow(runtime, "memoryOperations");
    expect(await runtime.query(hostedBootstrapStatus, {})).toEqual({
      occupiedTableCount: 2,
      serviceControlCount: 0,
      state: "inconsistent",
    });
  });

  test("rejects both unaccounted memory tables after genuine hosted bootstrap", async () => {
    const runtime = await hostedBootstrapWorld();
    await insertOrphanMemoryRow(runtime, "memorySpaces");
    await insertOrphanMemoryRow(runtime, "memoryOperations");
    expect(await runtime.query(hostedBootstrapStatus, {})).toEqual({
      occupiedTableCount: 5,
      serviceControlCount: 1,
      state: "inconsistent",
    });
  });

  test("reads and counts every lifecycle table through bounded actual queries", async () => {
    const runtime = convexTest(schema, modules);
    const reads: Array<Readonly<{ limit: number; table: string }>> = [];
    const countedTables = new Set<string>();
    const status = await runtime.query(async (ctx) => {
      const originalQuery = ctx.db.query.bind(ctx.db);
      const query: typeof ctx.db.query = (table) => {
        const initializer = originalQuery(table);
        const originalTake = initializer.take.bind(initializer);
        initializer.take = async (limit) => {
          reads.push({ limit, table });
          const rows = await originalTake(limit);
          return new Proxy(rows, {
            get(target, property, receiver) {
              if (property === "length") countedTables.add(table);
              const value: unknown = Reflect.get(target, property, receiver);
              return value;
            },
          });
        };
        return initializer;
      };
      // The registered runtime exposes this handler, but its public declaration
      // omits internal members. Keep this test-only access checked and unknown.
      const handler: unknown = Reflect.get(hostedBootstrapStatusQuery, "_handler");
      if (typeof handler !== "function") throw new Error("Missing bootstrap status test handler.");
      const result: unknown = await Reflect.apply(handler, undefined, [
        { ...ctx, db: { ...ctx.db, query } },
        {},
      ]);
      return result;
    });
    const expectedTables = Object.keys(HOSTED_TABLE_LIFECYCLE).sort();
    expect(status).toEqual({
      occupiedTableCount: 0,
      serviceControlCount: 0,
      state: "uninitialized",
    });
    expect(reads.map((read) => read.table).sort()).toEqual(expectedTables);
    expect(reads.map((read) => read.limit)).toEqual(expectedTables.map(() => 2));
    expect([...countedTables].sort()).toEqual(expectedTables);
  });
});

describe("hosted quota authority", () => {
  test("uses Convex UTF-8 canonicalization and deterministic system overhead", () => {
    expect(logicalDocumentBytes({ text: "é🙂", userId: "u" })).toBe(86);
    expect(logicalDocumentBytes({ text: "é🙂", userId: "u", ignored: undefined })).toBe(86);
    expect(logicalDocumentBytes({
      _creationTime: 1,
      _id: "x".repeat(32),
      text: "é🙂",
      userId: "u",
    })).toBe(86);
  });

  test("pins the open-beta free tier and its deliberate oversubscription", () => {
    expect(USER_TOTAL_QUOTA.logicalBytes).toBe(200 * 1_024 * 1_024);
    expect(USER_RESOURCE_QUOTAS.session_chunk).toBe(50_000);
    expect(USER_RESOURCE_QUOTAS.live_chunk).toBe(20_000);
    expect(USER_RESOURCE_QUOTAS.live_chunk)
      .toBeLessThan(USER_RESOURCE_QUOTAS.session_chunk);
    expect(SERVICE_TOTAL_QUOTA.identities).toBe(5_000);
    // The service byte ceiling, not the identity count, is the real hard stop.
    expect(SERVICE_TOTAL_QUOTA.logicalBytes)
      .toBeLessThan(SERVICE_TOTAL_QUOTA.identities * USER_TOTAL_QUOTA.logicalBytes);
    // Bytes bind before records for one identity at any plausible row size.
    expect(USER_TOTAL_QUOTA.logicalBytes / USER_TOTAL_QUOTA.records).toBeLessThan(64);
  });

  test("accepts exact aggregate and resource boundaries and rejects the next unit", () => {
    const categoryLimit = CATEGORY_QUOTAS.device;
    const exact = nextQuotaSnapshot({
      category: {
        logicalBytes: categoryLimit.logicalBytes - 1,
        records: categoryLimit.records - 1,
      },
      service: { identities: 0, logicalBytes: 0, records: 0 },
      user: { logicalBytes: 0, records: 0 },
    }, { logicalBytes: 1, records: 1 }, "device", "hard");
    expect(exact.category).toEqual(categoryLimit);
    expect(() => nextQuotaSnapshot(exact, { logicalBytes: 0, records: 1 }, "device", "hard"))
      .toThrow("QUOTA_EXCEEDED");
    expect(() => nextQuotaSnapshot({
      category: { logicalBytes: 1, records: 1 },
      service: {
        identities: SERVICE_TOTAL_QUOTA.identities,
        logicalBytes: SERVICE_TOTAL_QUOTA.logicalBytes,
        records: SERVICE_TOTAL_QUOTA.records,
      },
      user: {
        logicalBytes: USER_TOTAL_QUOTA.logicalBytes,
        records: USER_TOTAL_QUOTA.records,
      },
    }, { logicalBytes: 1, records: 0 }, "chunk", "hard")).toThrow("QUOTA_EXCEEDED");
    for (const limit of Object.values(USER_RESOURCE_QUOTAS)) {
      expect(nextResourceRecords(limit - 1, 1, limit)).toBe(limit);
      expect(() => nextResourceRecords(limit, 1, limit)).toThrow("QUOTA_EXCEEDED");
      expect(() => nextResourceRecords(limit + 1, -1, limit))
        .toThrow("QUOTA_AUTHORITY_CORRUPT");
    }
    const accountLimit = ACCOUNT_RESOURCE_QUOTAS.usage_snapshot;
    expect(nextResourceRecords(accountLimit - 1, 1, accountLimit)).toBe(accountLimit);
    expect(() => nextResourceRecords(accountLimit, 1, accountLimit))
      .toThrow("QUOTA_EXCEEDED");
  });

  test("usage cadence reaches cleanup with conservative boundary headroom", () => {
    const maximumSourcesPerAccount = USER_RESOURCE_QUOTAS.device;
    expect(USAGE_CLOUD_UPLOAD_MIN_INTERVAL_MS)
      .toBe(USAGE_SERVER_ADMISSION_MIN_INTERVAL_MS);
    const recordsPerSourceBeforeCleanup = Math.floor(
      CLOUD_USAGE_SNAPSHOT_RETENTION_MS / USAGE_SERVER_ADMISSION_MIN_INTERVAL_MS,
    ) + 1;
    const conservativeAccountRecords = maximumSourcesPerAccount
      * recordsPerSourceBeforeCleanup;
    expect(recordsPerSourceBeforeCleanup).toBe(91);
    expect(conservativeAccountRecords).toBe(1_456);
    expect(conservativeAccountRecords)
      .toBeLessThan(ACCOUNT_RESOURCE_QUOTAS.usage_snapshot);
    expect(conservativeAccountRecords * USER_RESOURCE_QUOTAS.codex_account)
      .toBeLessThan(CATEGORY_QUOTAS.usage.records);
    expect(USAGE_ADMISSION_EXPIRY_RELEASE_LIMIT)
      .toBeGreaterThanOrEqual(maximumSourcesPerAccount);

    const maximumEnvelope = {
      algorithm: "A256GCM" as const,
      ciphertext: "A".repeat(USAGE_CLOUD_ENVELOPE_MAX_CIPHERTEXT_CHARACTERS),
      keyVersion: Number.MAX_SAFE_INTEGER,
      nonce: "A".repeat(16),
    };
    expect(parseUsageEncryptedEnvelope(maximumEnvelope)).toEqual(maximumEnvelope);
    const conservativeIdentifier = "i".repeat(96);
    const maximumUsageDocument = {
      accountId: conservativeIdentifier,
      createdAt: Number.MAX_SAFE_INTEGER,
      digest: "f".repeat(64),
      envelope: maximumEnvelope,
      observedAt: Number.MAX_SAFE_INTEGER,
      receivedAt: Number.MAX_SAFE_INTEGER,
      sourceDeviceId: conservativeIdentifier,
      sourceDevicePublicId: "d".repeat(96),
      sourceRevision: Number.MAX_SAFE_INTEGER,
      userId: conservativeIdentifier,
    };
    const maximumLogicalBytes = logicalDocumentBytes(maximumUsageDocument);
    expect(maximumLogicalBytes).toBe(11_599);
    // The open-beta free tier makes this statement per Codex account. One
    // account's worst-case telemetry before any row becomes cleanup-eligible
    // stays under a tenth of the tier, and the tier holds twelve such accounts
    // at once. Running more accounts than that at the absolute worst-case
    // envelope needs a raised tier, not a looser conservative bound.
    const conservativeAccountUsageBytes = conservativeAccountRecords
      * maximumLogicalBytes;
    const conservativeUserRecords = conservativeAccountRecords
      * USER_RESOURCE_QUOTAS.codex_account;
    expect(conservativeUserRecords).toBe(46_592);
    expect(conservativeUserRecords).toBeLessThan(CATEGORY_QUOTAS.usage.records);
    expect(conservativeAccountUsageBytes).toBe(16_888_144);
    expect(conservativeAccountUsageBytes * 10)
      .toBeLessThan(USER_TOTAL_QUOTA.logicalBytes);
    expect(Math.floor(USER_TOTAL_QUOTA.logicalBytes / conservativeAccountUsageBytes))
      .toBe(12);

    const minimumByteBoundSamples = Math.floor(
      USAGE_LOCAL_RETAIN_BYTES / USAGE_LOCAL_SNAPSHOT_MAX_BYTES,
    );
    const maximumVelocityWindowSamples = Math.ceil(
      (15 * 60_000 * 1.2) / USAGE_POLL_MIN_INTERVAL_MS,
    ) + 1;
    expect(minimumByteBoundSamples).toBe(64);
    expect(minimumByteBoundSamples).toBeGreaterThan(maximumVelocityWindowSamples);
  });

  test("hard genesis requires a pristine deployment and is one-shot under races", async () => {
    const clean = convexTest(schema, modules);
    expect(await clean.mutation(genesisHardAuthority, {})).toEqual({ enforcement: "hard" });
    expect(await clean.run(async (ctx) => await ctx.db.query("storageUsageService").unique()))
      .toMatchObject({ enforcement: "hard", identities: 0, logicalBytes: 0, records: 0 });
    await expect(clean.mutation(genesisHardAuthority, {}))
      .rejects.toThrow("QUOTA_HARD_GENESIS_ALREADY_EXISTS");

    const nonempty = convexTest(schema, modules);
    await nonempty.run(async (ctx) => await ctx.db.insert("users", {}));
    await expect(nonempty.mutation(genesisHardAuthority, {}))
      .rejects.toThrow("QUOTA_HARD_GENESIS_NOT_EMPTY");

    const rateLimited = convexTest(schema, modules);
    await rateLimited.run(async (ctx) => await ctx.db.insert("authRateLimits", {
      attemptsLeft: 1,
      identifier: "genesis-rate-limit",
      lastAttemptTime: 1,
    }));
    await expect(rateLimited.mutation(genesisHardAuthority, {}))
      .rejects.toThrow("QUOTA_HARD_GENESIS_NOT_EMPTY");

    const attempted = convexTest(schema, modules);
    await attempted.run(async (ctx) => await ctx.db.insert("authEmailAttemptEvents", {
      authEpoch: 1,
      createdAt: 1,
      emailDigest: "0".repeat(64),
      expiresAt: 2,
      kind: "send",
    }));
    await expect(attempted.mutation(genesisHardAuthority, {}))
      .rejects.toThrow("QUOTA_HARD_GENESIS_NOT_EMPTY");

    const maintenanceDirty = convexTest(schema, modules);
    await maintenanceDirty.run(async (ctx) => await ctx.db.insert("maintenanceState", {
      key: "retention",
      nextCategory: "auth_attempts",
      updatedAt: 1,
    }));
    await expect(maintenanceDirty.mutation(genesisHardAuthority, {}))
      .rejects.toThrow("QUOTA_HARD_GENESIS_NOT_EMPTY");

    const outboxDirty = convexTest(schema, modules);
    await outboxDirty.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      const now = Date.now();
      const deviceId = await ctx.db.insert("devices", {
        authEpoch: 1,
        createdAt: now,
        encryptedLabel: {
          algorithm: "A256GCM",
          ciphertext: "notification-genesis-device",
          keyVersion: 1,
          nonce: "notification-genesis-nonce",
        },
        keyVersion: 1,
        publicId: "device_notification_genesis",
        revision: 1,
        signingPublicKey: "notification-genesis-signing-key",
        status: "active",
        updatedAt: now,
        userId,
        wrappingPublicKey: "notification-genesis-wrapping-key",
      });
      const sessionId = await ctx.db.insert("sessionHeads", {
        compactHeadSequence: 0,
        createdAt: now,
        detailHeadSequence: 0,
        executionDeviceId: deviceId,
        metadataRevision: 0,
        projectionRevision: 0,
        publicId: "session_notification_genesis",
        state: "idle",
        updatedAt: now,
        userId,
      });
      await ctx.db.insert("attentionNotificationOutbox", {
        allowedWindowEnd: now + 60_000,
        claimDeadline: now + 60_000,
        coalesceAfter: now + 60_000,
        consentLeaseUntil: now + 60_000,
        createdAt: now,
        executionAuthority: { bootGeneration: 1, bootId: "boot_genesis", fence: 1 },
        globalNotificationGeneration: 1,
        interactionDeadline: now + 60_000,
        interactionId: "interaction_notification_genesis",
        interactionKind: "command_approval",
        interactionRevision: 1,
        localNotificationPolicyRevision: 1,
        nonterminal: true,
        reconciliationSequence: 1,
        remoteActions: [],
        sessionId,
        sessionPublicId: "session_notification_genesis",
        sourceDeviceId: deviceId,
        state: "pending",
        updatedAt: now,
        userId,
      });
      await ctx.db.delete(sessionId);
      await ctx.db.delete(deviceId);
      await ctx.db.delete(userId);
    });
    await expect(outboxDirty.mutation(genesisHardAuthority, {}))
      .rejects.toThrow("QUOTA_HARD_GENESIS_NOT_EMPTY");

    const historicalShadow = convexTest(schema, modules);
    await historicalShadow.run(async (ctx) => await ctx.db.insert("storageUsageService", {
      enforcement: "shadow",
      identities: 0,
      key: "global",
      logicalBytes: 0,
      records: 0,
      serviceLogicalBytes: 0,
      serviceRecords: 0,
      updatedAt: Date.now(),
      userLogicalBytes: 0,
      userRecords: 0,
    }));
    await expect(historicalShadow.mutation(genesisHardAuthority, {}))
      .rejects.toThrow("QUOTA_HARD_GENESIS_ALREADY_EXISTS");

    const racing = convexTest(schema, modules);
    const results = await Promise.allSettled([
      racing.mutation(genesisHardAuthority, {}),
      racing.mutation(genesisHardAuthority, {}),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await racing.run(async (ctx) => await ctx.db.query("storageUsageService").collect()))
      .toHaveLength(1);
  });

  test("persists the identity total and removes empty user authority exactly", async () => {
    const runtime = convexTest(schema, modules);
    await runtime.mutation(genesisHardAuthority, {});
    const userId = await runtime.run(async (ctx) => {
      const id = await ctx.db.insert("users", {
        email: "identity-ledger@example.com",
        emailVerificationTime: 1,
      });
      await initializeUserQuotaAuthority(ctx, id);
      const user = await ctx.db.get(id);
      if (user === null) throw new Error("missing identity fixture");
      await reserveQuotaForStoredIdentity(ctx, id, user);
      return id;
    });
    expect(await runtime.run(async (ctx) =>
      await ctx.db.query("storageUsageService").unique()))
      .toMatchObject({ identities: 1, userRecords: 1 });
    await runtime.run(async (ctx) => {
      const user = await ctx.db.get(userId);
      if (user === null) throw new Error("missing identity fixture");
      await releaseQuotaForStoredIdentity(ctx, userId, user);
      await finalizeUserQuotaAuthorityForDelete(ctx, userId);
      await ctx.db.delete(userId);
    });
    expect(await runtime.run(async (ctx) => ({
      categories: await ctx.db.query("storageUsageByUser").collect(),
      resources: await ctx.db.query("storageResourceUsageByUser").collect(),
      service: await ctx.db.query("storageUsageService").unique(),
      user: await ctx.db.get(userId),
    }))).toMatchObject({
      categories: [],
      resources: [],
      service: {
        identities: 0,
        logicalBytes: 0,
        records: 0,
        userLogicalBytes: 0,
        userRecords: 0,
      },
      user: null,
    });
  });

  test("presence is category-charged but excluded from the device resource cap", async () => {
    const world = await quotaWorld();
    const beforeCategory = await categoryUsageFor(
      world.testRuntime,
      world.userId,
      "device",
    );
    const beforeResource = await userResourceFor(
      world.testRuntime,
      world.userId,
      "device",
    );
    const args = {
      connectionId: "quota_connection",
      credentialGeneration: 1,
      fingerprint: "1".repeat(64),
      sequence: 0,
    };
    await world.actor.mutation(connect, args);
    const presence = await world.testRuntime.run(async (ctx) =>
      (await ctx.db.query("devicePresence").collect())[0]);
    expect(await categoryUsageFor(world.testRuntime, world.userId, "device"))
      .toMatchObject({
        logicalBytes: (beforeCategory?.logicalBytes ?? 0)
          + logicalDocumentBytes(presence ?? {}),
        records: (beforeCategory?.records ?? 0) + 1,
      });
    expect(await userResourceFor(world.testRuntime, world.userId, "device"))
      .toEqual(beforeResource);
    await world.actor.mutation(connect, args);
    await world.actor.mutation(heartbeat, {
      ...args,
      fingerprint: "2".repeat(64),
      sequence: 1,
    });
    expect(await userResourceFor(world.testRuntime, world.userId, "device"))
      .toEqual(beforeResource);
  });

  test("serializes concurrent device admission at the exact resource boundary", async () => {
    const world = await quotaWorld();
    const insertDevice = async (index: number) => await world.testRuntime.run(async (ctx) => {
      const document = {
        authEpoch: 1,
        createdAt: index,
        credentialGeneration: 1,
        encryptedLabel: envelope,
        keyVersion: 1,
        publicId: `quota_device_${index.toString().padStart(2, "0")}`,
        revision: 1,
        signingPublicKey: "fixture",
        status: "pending" as const,
        updatedAt: index,
        userId: world.userId,
        wrappingPublicKey: "fixture",
      };
      await reserveDeviceQuotaForInsert(ctx, world.userId, document);
      return await ctx.db.insert("devices", document);
    });
    for (let index = 1; index < USER_RESOURCE_QUOTAS.device - 1; index += 1) {
      await insertDevice(index);
    }
    const results = await Promise.allSettled([insertDevice(16), insertDevice(17)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await userResourceFor(world.testRuntime, world.userId, "device"))
      .toMatchObject({ records: USER_RESOURCE_QUOTAS.device });
    expect(await world.testRuntime.run(async (ctx) => await ctx.db.query("devices")
      .withIndex("by_user_and_public_id", (builder) => builder.eq("userId", world.userId))
      .collect())).toHaveLength(USER_RESOURCE_QUOTAS.device);
  });

  test("session chunk resource accepts the exact 50,000th row atomically", async () => {
    const world = await quotaWorld();
    const sessionId = await world.testRuntime.run(async (ctx) => {
      const document = {
        compactHeadSequence: 0,
        createdAt: Date.now(),
        detailHeadSequence: 0,
        executionDeviceId: world.deviceId,
        metadataRevision: 0,
        projectionRevision: 0,
        publicId: "quota_resource_session",
        state: "idle",
        updatedAt: Date.now(),
        userId: world.userId,
      } as const;
      await reserveSessionHeadQuotaForInsert(ctx, world.userId, document);
      const id = await ctx.db.insert("sessionHeads", document);
      const resource = await ctx.db.query("storageResourceUsageByUser")
        .withIndex("by_user_and_resource", (builder) => builder
          .eq("userId", world.userId)
          .eq("resource", "session_chunk"))
        .unique();
      if (resource === null) throw new Error("missing resource fixture");
      await ctx.db.patch(resource._id, { records: USER_RESOURCE_QUOTAS.session_chunk - 1 });
      return id;
    });
    const insertChunk = async (sequence: number) => await world.testRuntime.run(async (ctx) => {
      const document = {
        authority: { bootGeneration: 1, bootId: "quota_boot", fence: 1 },
        createdAt: Date.now(),
        digest: sequence.toString(16).padStart(64, "0"),
        envelope,
        firstSequence: sequence,
        lastSequence: sequence,
        sessionId,
        sourceDeviceId: world.deviceId,
        stream: "detail" as const,
        userId: world.userId,
      };
      await reserveSessionChunkQuotaForInsert(ctx, world.userId, document);
      await ctx.db.insert("sessionChunks", document);
    });
    await insertChunk(1);
    expect(await userResourceFor(world.testRuntime, world.userId, "session_chunk"))
      .toMatchObject({ records: USER_RESOURCE_QUOTAS.session_chunk });
    await expect(insertChunk(2)).rejects.toThrow("QUOTA_EXCEEDED");
    expect(await world.testRuntime.run(async (ctx) =>
      await ctx.db.query("sessionChunks").collect())).toHaveLength(1);
    expect(await categoryUsageFor(world.testRuntime, world.userId, "chunk"))
      .toMatchObject({ records: 1 });
  });

  test("usage snapshot caps are isolated per Codex account", async () => {
    const world = await quotaWorld();
    const [accountA, accountB] = await world.testRuntime.run(async (ctx) => {
      const createAccount = async (publicId: string) => {
        const document = {
          createdAt: Date.now(),
          encryptedMetadata: envelope,
          matchKey: publicId.padEnd(64, "0"),
          publicId,
          updatedAt: Date.now(),
          userId: world.userId,
        };
        await reserveCodexAccountQuotaForInsert(ctx, world.userId, document);
        const accountId = await ctx.db.insert("codexAccounts", document);
        await initializeAccountUsageQuotaAuthority(ctx, world.userId, accountId);
        return accountId;
      };
      return [await createAccount("quota_account_a"), await createAccount("quota_account_b")];
    });
    await world.testRuntime.run(async (ctx) => {
      const usage = await ctx.db.query("storageResourceUsageByAccount")
        .withIndex("by_account_and_resource", (builder) => builder
          .eq("accountId", accountA)
          .eq("resource", "usage_snapshot"))
        .unique();
      if (usage === null) throw new Error("missing account resource fixture");
      await ctx.db.patch(usage._id, { records: ACCOUNT_RESOURCE_QUOTAS.usage_snapshot });
    });
    const insertSnapshot = async (accountId: Id<"codexAccounts">, revision: number) =>
      await world.testRuntime.run(async (ctx) => {
        const document = {
          accountId,
          createdAt: Date.now(),
          digest: revision.toString(16).padStart(64, "0"),
          envelope,
          observedAt: Date.now(),
          receivedAt: Date.now(),
          sourceDeviceId: world.deviceId,
          sourceDevicePublicId: "device_quota_test",
          sourceRevision: revision,
          userId: world.userId,
        };
        await reserveAccountUsageSnapshotQuotaForInsert(
          ctx,
          world.userId,
          accountId,
          document,
        );
        await ctx.db.insert("accountUsageSnapshots", document);
      });
    await expect(insertSnapshot(accountA, 1)).rejects.toThrow("QUOTA_EXCEEDED");
    await insertSnapshot(accountB, 1);
    const rows = await world.testRuntime.run(async (ctx) =>
      await ctx.db.query("storageResourceUsageByAccount").collect());
    expect(rows.find((row) => row.accountId === accountA)?.records)
      .toBe(ACCOUNT_RESOURCE_QUOTAS.usage_snapshot);
    expect(rows.find((row) => row.accountId === accountB)?.records).toBe(1);
  });

  test("nonterminal command count releases once on the first terminal transition", async () => {
    const world = await quotaWorld();
    const commandId = await world.testRuntime.run(async (ctx) => {
      const session = {
        compactHeadSequence: 0,
        createdAt: Date.now(),
        detailHeadSequence: 0,
        executionDeviceId: world.deviceId,
        metadataRevision: 0,
        projectionRevision: 0,
        publicId: "quota_command_session",
        state: "idle",
        updatedAt: Date.now(),
        userId: world.userId,
      } as const;
      await reserveSessionHeadQuotaForInsert(ctx, world.userId, session);
      const sessionId = await ctx.db.insert("sessionHeads", session);
      const document = {
        createdAt: Date.now(),
        deadline: Date.now() + 60_000,
        idempotencyKey: "0198f56e-7b00-7000-8000-000000000001",
        kind: "send" as const,
        nonterminal: true,
        payload: envelope,
        publicId: "0198f56e-7b00-7000-8000-000000000002",
        requestDigest: "b".repeat(64),
        requestingDeviceId: world.deviceId,
        sessionId,
        state: "pending" as const,
        targetDeviceId: world.deviceId,
        updatedAt: Date.now(),
        userId: world.userId,
      };
      await reserveNonterminalCommandQuotaForInsert(ctx, world.userId, document);
      return await ctx.db.insert("sessionCommands", document);
    });
    expect(await userResourceFor(world.testRuntime, world.userId, "nonterminal_command"))
      .toMatchObject({ records: 1 });
    for (let replay = 0; replay < 2; replay += 1) {
      await world.testRuntime.run(async (ctx) => {
        const command = await ctx.db.get(commandId);
        if (command === null) throw new Error("missing command fixture");
        const patch = {
          nonterminal: false,
          state: "cancelled" as const,
          updatedAt: Date.now(),
        };
        await adjustCommandQuotaForPatch(ctx, world.userId, command, patch);
        await ctx.db.patch(commandId, patch);
      });
      expect(await userResourceFor(world.testRuntime, world.userId, "nonterminal_command"))
        .toMatchObject({ records: 0 });
    }
  });

  test("hard writes close on missing, duplicate, and corrupt resource authority", async () => {
    const missingService = convexTest(schema, modules);
    const userId = await missingService.run(async (ctx) => await ctx.db.insert("users", {}));
    await expect(missingService.run(async (ctx) =>
      await initializeUserQuotaAuthority(ctx, userId)))
      .rejects.toThrow("QUOTA_AUTHORITY_CORRUPT");

    const assertBroken = async (
      mutate: (runtime: QuotaRuntime, userId: Id<"users">) => Promise<void>,
    ) => {
      const world = await quotaWorld();
      await mutate(world.testRuntime, world.userId);
      await expect(world.testRuntime.run(async (ctx) =>
        await reserveSessionChunkQuotaForInsert(ctx, world.userId, {
          marker: "not_inserted",
          userId: world.userId,
        }))).rejects.toThrow("QUOTA_AUTHORITY_CORRUPT");
    };
    await assertBroken(async (runtime, id) => await runtime.run(async (ctx) => {
      const row = await ctx.db.query("storageResourceUsageByUser")
        .withIndex("by_user_and_resource", (builder) => builder
          .eq("userId", id)
          .eq("resource", "session_chunk"))
        .unique();
      if (row !== null) await ctx.db.delete(row._id);
    }));
    await assertBroken(async (runtime, id) => await runtime.run(async (ctx) => {
      await ctx.db.insert("storageResourceUsageByUser", {
        records: 0,
        resource: "session_chunk",
        updatedAt: Date.now(),
        userId: id,
      });
    }));
    await assertBroken(async (runtime, id) => await runtime.run(async (ctx) => {
      const row = await ctx.db.query("storageResourceUsageByUser")
        .withIndex("by_user_and_resource", (builder) => builder
          .eq("userId", id)
          .eq("resource", "session_chunk"))
        .unique();
      if (row === null) throw new Error("missing corrupt fixture");
      await ctx.db.patch(row._id, { records: -1 });
    }));
  });

  test("generic insert, patch, and delete preserve exact hard ledgers", async () => {
    const world = await quotaWorld();
    const eventId = await world.testRuntime.run(async (ctx) => {
      const document = {
        actorDeviceId: world.deviceId,
        createdAt: Date.now(),
        entityId: "quota_event",
        event: "command_enqueued" as const,
        userId: world.userId,
      };
      await reserveQuotaForInsert(ctx, world.userId, "security", document);
      return await ctx.db.insert("securityEvents", document);
    });
    let stored = await world.testRuntime.run(async (ctx) => await ctx.db.get(eventId));
    expect(await categoryUsageFor(world.testRuntime, world.userId, "security"))
      .toMatchObject({ logicalBytes: logicalDocumentBytes(stored ?? {}), records: 1 });
    await world.testRuntime.run(async (ctx) => {
      if (stored === null) throw new Error("missing event fixture");
      const patch = { entityId: "quota_event_with_more_bytes" };
      await adjustQuotaForPatch(ctx, world.userId, "security", stored, patch);
      await ctx.db.patch(eventId, patch);
    });
    stored = await world.testRuntime.run(async (ctx) => await ctx.db.get(eventId));
    expect(await categoryUsageFor(world.testRuntime, world.userId, "security"))
      .toMatchObject({ logicalBytes: logicalDocumentBytes(stored ?? {}), records: 1 });
    await world.testRuntime.run(async (ctx) => {
      if (stored === null) throw new Error("missing event fixture");
      await releaseQuotaForDelete(ctx, world.userId, "security", stored);
      await ctx.db.delete(eventId);
    });
    expect(await categoryUsageFor(world.testRuntime, world.userId, "security"))
      .toMatchObject({ logicalBytes: 0, records: 0 });
  });

  test("service-owned quota preserves replay, partition, underflow, and ceiling laws", async () => {
    const missing = convexTest(schema, modules);
    await expect(missing.run(async (ctx) =>
      await reserveServiceQuotaForInsert(ctx, { marker: "missing" })))
      .rejects.toThrow("QUOTA_AUTHORITY_CORRUPT");

    const duplicate = convexTest(schema, modules);
    const serviceAuthority = {
      enforcement: "hard" as const,
      identities: 0,
      key: "global" as const,
      logicalBytes: 0,
      records: 0,
      serviceLogicalBytes: 0,
      serviceRecords: 0,
      updatedAt: 1,
      userLogicalBytes: 0,
      userRecords: 0,
    };
    await duplicate.run(async (ctx) => {
      await ctx.db.insert("storageUsageService", serviceAuthority);
      await ctx.db.insert("storageUsageService", serviceAuthority);
    });
    await expect(duplicate.run(async (ctx) =>
      await reserveServiceQuotaForInsert(ctx, { marker: "duplicate" })))
      .rejects.toThrow("QUOTA_AUTHORITY_CORRUPT");

    const corruptRuntime = convexTest(schema, modules);
    await corruptRuntime.mutation(genesisHardAuthority, {});
    await corruptRuntime.run(async (ctx) => {
      const service = await ctx.db.query("storageUsageService").unique();
      if (service === null) throw new Error("missing corrupt service fixture");
      await ctx.db.patch(service._id, { serviceRecords: 1 });
    });
    await expect(corruptRuntime.run(async (ctx) =>
      await reserveServiceQuotaForInsert(ctx, { marker: "corrupt" })))
      .rejects.toThrow("QUOTA_AUTHORITY_CORRUPT");

    const runtime = convexTest(schema, modules);
    await runtime.mutation(genesisHardAuthority, {});
    const document = {
      completedAt: 1,
      expiresAt: 2,
      publicId: "service_receipt_quota",
      statusCapabilityDigest: "f".repeat(64),
    };
    const insertOnce = async () => await runtime.run(async (ctx) => {
      const existing = await ctx.db.query("accountDeletionReceipts")
        .withIndex("by_public_id", (builder) => builder.eq("publicId", document.publicId))
        .unique();
      if (existing !== null) return existing._id;
      await reserveServiceQuotaForInsert(ctx, document);
      return await ctx.db.insert("accountDeletionReceipts", document);
    });
    const receiptId = await insertOnce();
    expect(await insertOnce()).toBe(receiptId);
    let stored = await runtime.run(async (ctx) => await ctx.db.get(receiptId));
    let chargedBytes = logicalDocumentBytes(stored ?? {});
    let charged = await runtime.run(async (ctx) =>
      await ctx.db.query("storageUsageService").unique());
    expect(charged).toMatchObject({
      logicalBytes: chargedBytes,
      records: 1,
      serviceLogicalBytes: chargedBytes,
      serviceRecords: 1,
      userLogicalBytes: 0,
      userRecords: 0,
    });
    await runtime.run(async (ctx) => {
      if (stored === null) throw new Error("missing service quota fixture");
      const patch = { publicId: "service_receipt_quota_with_more_bytes" };
      await adjustServiceQuotaForPatch(ctx, stored, patch);
      await ctx.db.patch(receiptId, patch);
    });
    stored = await runtime.run(async (ctx) => await ctx.db.get(receiptId));
    chargedBytes = logicalDocumentBytes(stored ?? {});
    charged = await runtime.run(async (ctx) =>
      await ctx.db.query("storageUsageService").unique());
    expect(charged).toMatchObject({
      logicalBytes: chargedBytes,
      records: 1,
      serviceLogicalBytes: chargedBytes,
      serviceRecords: 1,
    });
    await runtime.run(async (ctx) => {
      if (stored === null) throw new Error("missing service quota fixture");
      await adjustServiceQuotaForPatch(ctx, stored, {
        publicId: "service_receipt_quota_with_more_bytes",
      });
    });
    expect(await runtime.run(async (ctx) =>
      await ctx.db.query("storageUsageService").unique())).toMatchObject({
        identities: charged?.identities,
        logicalBytes: charged?.logicalBytes,
        records: charged?.records,
        serviceLogicalBytes: charged?.serviceLogicalBytes,
        serviceRecords: charged?.serviceRecords,
        userLogicalBytes: charged?.userLogicalBytes,
        userRecords: charged?.userRecords,
      });
    await runtime.run(async (ctx) => {
      if (stored === null) throw new Error("missing service quota fixture");
      await releaseServiceQuotaForDelete(ctx, stored);
      await ctx.db.delete(receiptId);
    });
    await expect(runtime.run(async (ctx) => {
      if (stored === null) throw new Error("missing service quota fixture");
      await releaseServiceQuotaForDelete(ctx, stored);
    })).rejects.toThrow("QUOTA_AUTHORITY_CORRUPT");

    const limitRuntime = convexTest(schema, modules);
    await limitRuntime.mutation(genesisHardAuthority, {});
    const candidateBytes = logicalDocumentBytes(document);
    await limitRuntime.run(async (ctx) => {
      const service = await ctx.db.query("storageUsageService").unique();
      if (service === null) throw new Error("missing service limit fixture");
      const atBoundary = SERVICE_TOTAL_QUOTA.logicalBytes - candidateBytes;
      await ctx.db.patch(service._id, {
        logicalBytes: atBoundary,
        records: 1,
        serviceLogicalBytes: atBoundary,
        serviceRecords: 1,
      });
      await reserveServiceQuotaForInsert(ctx, document);
      await ctx.db.insert("accountDeletionReceipts", document);
    });
    expect(await limitRuntime.run(async (ctx) =>
      await ctx.db.query("storageUsageService").unique()))
      .toMatchObject({ logicalBytes: SERVICE_TOTAL_QUOTA.logicalBytes });
    await expect(limitRuntime.run(async (ctx) => {
      await reserveServiceQuotaForInsert(ctx, {
        ...document,
        publicId: "service_receipt_over_limit",
      });
    })).rejects.toThrow("QUOTA_EXCEEDED");
  });

  test("shadow audit remains bounded and read-only", async () => {
    const world = await quotaWorld();
    await world.testRuntime.run(async (ctx) => {
      for (const entityId of ["audit_a", "audit_b", "audit_c"]) {
        await ctx.db.insert("securityEvents", {
          createdAt: 1,
          entityId,
          event: "command_enqueued",
          userId: world.userId,
        });
      }
    });
    const before = await categoryUsageFor(world.testRuntime, world.userId, "security");
    const first = await world.testRuntime.query(auditDirectTablePage, {
      paginationOpts: { cursor: null, numItems: 2 },
      table: "securityEvents",
      userId: world.userId,
    });
    const second = await world.testRuntime.query(auditDirectTablePage, {
      paginationOpts: { cursor: first.continueCursor, numItems: 2 },
      table: "securityEvents",
      userId: world.userId,
    });
    expect(first).toMatchObject({ isDone: false, records: 2 });
    expect(second).toMatchObject({ isDone: true, records: 1 });
    expect(await categoryUsageFor(world.testRuntime, world.userId, "security")).toEqual(before);
  });

  test("shadow audit reconciles every physical authority-reduction reservation", async () => {
    const world = await quotaWorld();
    await world.testRuntime.run(async (ctx) => {
      await createAccountDeletionCapacityForNewUser(ctx, world.userId);
      await createDeviceRevocationCapacityForNewDevice(
        ctx,
        world.userId,
        world.deviceId,
      );
    });
    const expected = {
      accountDeletionIdentityReservations: "identity",
      accountDeletionJobReservations: "job",
      deviceRevocationDeviceReservations: "device",
      deviceRevocationJobReservations: "job",
      deviceRevocationReceiptReservations: "receipt",
      deviceRevocationSecurityReservations: "security",
    } as const;
    for (const [table, category] of Object.entries(expected)) {
      const audit = await world.testRuntime.query(auditDirectTablePage, {
        paginationOpts: { cursor: null, numItems: 1 },
        table,
        userId: world.userId,
      });
      expect(audit).toMatchObject({ category, isDone: true, records: 1, table });
      expect(audit.logicalBytes).toBeGreaterThan(2_048);
    }
  });

  test("shadow audit reconciles capacity-backed durable jobs as job-category rows", async () => {
    const world = await quotaWorld();
    const documents = await world.testRuntime.run(async (ctx) => {
      const subject = await ctx.db.query("authSubjects")
        .withIndex("by_user", (builder) => builder.eq("userId", world.userId))
        .unique();
      if (subject === null) throw new Error("missing job audit subject");
      const accountDeletion = {
        capacityReservation: durableJobCapacityReservation,
        category: "commands_and_leases" as const,
        createdAt: 1,
        publicId: "job_audit_account",
        state: "pending" as const,
        statusCapabilityDigest: "a".repeat(64),
        subjectId: subject._id,
        updatedAt: 1,
        userId: world.userId,
      };
      const deviceRevocation = {
        capacityReservation: durableJobCapacityReservation,
        category: "sessions" as const,
        createdAt: 1,
        deviceId: world.deviceId,
        publicId: "job_audit_device",
        state: "pending" as const,
        updatedAt: 1,
        userId: world.userId,
      };
      await reserveQuotaForInsert(ctx, world.userId, "job", accountDeletion);
      await ctx.db.insert("accountDeletionJobs", accountDeletion);
      await reserveQuotaForInsert(ctx, world.userId, "job", deviceRevocation);
      await ctx.db.insert("deviceRevocationJobs", deviceRevocation);
      return { accountDeletion, deviceRevocation };
    });
    const before = await categoryUsageFor(world.testRuntime, world.userId, "job");
    const accountAudit = await world.testRuntime.query(auditDirectTablePage, {
      paginationOpts: { cursor: null, numItems: 1 },
      table: "accountDeletionJobs",
      userId: world.userId,
    });
    const revocationAudit = await world.testRuntime.query(auditDirectTablePage, {
      paginationOpts: { cursor: null, numItems: 1 },
      table: "deviceRevocationJobs",
      userId: world.userId,
    });
    expect(accountAudit).toMatchObject({
      category: "job",
      isDone: true,
      logicalBytes: logicalDocumentBytes(documents.accountDeletion),
      records: 1,
      table: "accountDeletionJobs",
    });
    expect(revocationAudit).toMatchObject({
      category: "job",
      isDone: true,
      logicalBytes: logicalDocumentBytes(documents.deviceRevocation),
      records: 1,
      table: "deviceRevocationJobs",
    });
    expect(await categoryUsageFor(world.testRuntime, world.userId, "job")).toEqual(before);
  });
});

// These ledger-only fixtures retain hard-authority attribution while varying
// individual ceilings. They do not insert fake future reservation metadata.
async function setDiagnosticUsage(
  world: Awaited<ReturnType<typeof quotaWorld>>,
  overrides: Partial<Record<QuotaCategory, Partial<{ logicalBytes: number; records: number }>>>,
  serviceOverride: Partial<{ logicalBytes: number; records: number }> = {},
) {
  await world.testRuntime.run(async (ctx) => {
    const rows = await ctx.db.query("storageUsageByUser")
      .withIndex("by_user_and_category", (q) => q.eq("userId", world.userId)).collect();
    let userLogicalBytes = 0;
    let userRecords = 0;
    for (const row of rows) {
      const patch = overrides[row.category];
      const records = patch?.records ?? row.records;
      const logicalBytes = records === 0 ? 0 : patch?.logicalBytes ?? Math.max(1, row.logicalBytes);
      await ctx.db.patch(row._id, { logicalBytes, records });
      userLogicalBytes += logicalBytes;
      userRecords += records;
    }
    const service = await ctx.db.query("storageUsageService").unique();
    if (service === null) throw new Error("missing diagnostic service fixture");
    const serviceRecords = serviceOverride.records === undefined
      ? serviceOverride.logicalBytes === undefined ? 0 : 1
      : serviceOverride.records - userRecords;
    const serviceLogicalBytes = serviceOverride.logicalBytes === undefined
      ? serviceRecords === 0 ? 0 : 1
      : serviceOverride.logicalBytes - userLogicalBytes;
    await ctx.db.patch(service._id, {
      logicalBytes: userLogicalBytes + serviceLogicalBytes,
      records: userRecords + serviceRecords,
      serviceLogicalBytes, serviceRecords, userLogicalBytes, userRecords,
    });
  });
}

const inspectDiagnostic = async (world: Awaited<ReturnType<typeof quotaWorld>>, a = 1, d = 1) =>
  await world.testRuntime.run(async (ctx) => await inspectAuthorityReductionQuota(ctx, world.userId, a, d));

describe("authority reduction quota ceiling diagnostic", () => {
  test("exact record demand covers every bounded account/device combination", () => {
    for (const a of [0, 1]) for (let d = 0; d <= 16; d += 1) {
      expect(authorityReductionReservationDemand(a, d)).toEqual({
        accountPairs: a, deviceQuartets: d,
        paddingBytesLowerBound: 2_048 * (2 * a + 4 * d), totalRecords: 2 * a + 4 * d,
      });
    }
    fc.assert(fc.property(fc.integer(), fc.integer(), (a, d) => {
      if ((a === 0 || a === 1) && d >= 0 && d <= 16) {
        expect(authorityReductionReservationDemand(a, d).totalRecords).toBeLessThanOrEqual(66);
      } else expect(() => authorityReductionReservationDemand(a, d)).toThrow("QUOTA_AUTHORITY_CORRUPT");
    }), { numRuns: 100 });
    for (const invalid of [NaN, Infinity, -Infinity, 0.5]) {
      expect(() => authorityReductionReservationDemand(1, invalid)).toThrow("QUOTA_AUTHORITY_CORRUPT");
    }
  });

  test.each(["identity", "job", "device", "security", "receipt"] as const)(
    "%s record equality fits only that dimension; one fewer slot blocks", async (category) => {
      const world = await quotaWorld();
      const needed = category === "job" ? 2 : 1;
      await setDiagnosticUsage(world, { [category]: { records: CATEGORY_QUOTAS[category].records - needed } });
      const equal = await inspectDiagnostic(world);
      expect(equal.state).toBe("observed");
      if (equal.state !== "observed") throw new Error("unproved diagnostic fixture");
      expect(equal.ceilings[category]).toEqual({
        applicable: 1, bytesBlockedByLowerBound: 0, bytesUnknown: 1, recordsBlocked: 0,
      });
      await setDiagnosticUsage(world, { [category]: { records: CATEGORY_QUOTAS[category].records - needed + 1 } });
      const blocked = await inspectDiagnostic(world);
      if (blocked.state !== "observed") throw new Error("unproved diagnostic fixture");
      expect(blocked.ceilings[category].recordsBlocked).toBe(1);
      expect(blocked.ceilings.userTotal.recordsBlocked).toBe(0);
      expect(blocked.ceilings.serviceTotal.recordsBlocked).toBe(0);
    },
  );

  test("user and service record ceilings are separate exact dimensions", async () => {
    const world = await quotaWorld();
    const others = await world.testRuntime.run(async (ctx) => {
      const rows = await ctx.db.query("storageUsageByUser").collect();
      return rows.filter((row) => !["usage", "chunk", "memory"].includes(row.category))
        .reduce((sum, row) => sum + row.records, 0);
    });
    await setDiagnosticUsage(world, {
      chunk: { records: 500_000 }, memory: { records: 300_000 - others - 6 }, usage: { records: 3_200_000 },
    }, { records: SERVICE_TOTAL_QUOTA.records - 6 });
    const equal = await inspectDiagnostic(world);
    if (equal.state !== "observed") throw new Error("unproved diagnostic fixture");
    expect(equal.ceilings.userTotal.recordsBlocked).toBe(0);
    expect(equal.ceilings.serviceTotal.recordsBlocked).toBe(0);
    await setDiagnosticUsage(world, { memory: { records: 300_000 - others - 5 } }, {
      records: SERVICE_TOTAL_QUOTA.records - 5,
    });
    const blocked = await inspectDiagnostic(world);
    if (blocked.state !== "observed") throw new Error("unproved diagnostic fixture");
    expect(blocked.ceilings.userTotal.recordsBlocked).toBe(1);
    expect(blocked.ceilings.serviceTotal.recordsBlocked).toBe(1);
  });

  test.each([-1, 0, 1])("byte headroom floor offset %s never proves byte fit", async (offset) => {
    const world = await quotaWorld();
    await setDiagnosticUsage(world, {
      identity: { logicalBytes: CATEGORY_QUOTAS.identity.logicalBytes - 2_048 - offset },
    }, { logicalBytes: SERVICE_TOTAL_QUOTA.logicalBytes - 12_288 - offset });
    const value = await inspectDiagnostic(world);
    if (value.state !== "observed") throw new Error("unproved diagnostic fixture");
    for (const key of ["identity", "serviceTotal"] as const) {
      expect(value.ceilings[key].bytesBlockedByLowerBound).toBe(offset < 0 ? 1 : 0);
      expect(value.ceilings[key].bytesUnknown).toBe(offset < 0 ? 0 : 1);
    }
  });

  test.each([-1, 0, 1])("user byte headroom floor offset %s remains conservative", async (offset) => {
    const world = await quotaWorld();
    const others = await world.testRuntime.run(async (ctx) =>
      (await ctx.db.query("storageUsageByUser").collect())
        .filter((row) => row.category !== "chunk")
        .reduce((sum, row) => sum + row.logicalBytes, 0));
    await setDiagnosticUsage(world, {
      chunk: { logicalBytes: USER_TOTAL_QUOTA.logicalBytes - others - 12_288 - offset, records: 1 },
    });
    const value = await inspectDiagnostic(world);
    if (value.state !== "observed") throw new Error("unproved diagnostic fixture");
    expect(value.ceilings.userTotal.bytesBlockedByLowerBound).toBe(offset < 0 ? 1 : 0);
    expect(value.ceilings.userTotal.bytesUnknown).toBe(offset < 0 ? 0 : 1);
    expect(value.ceilings.serviceTotal.bytesBlockedByLowerBound).toBe(0);
  });

  test("a saturated category with no required insert is not applicable", async () => {
    const world = await quotaWorld();
    await setDiagnosticUsage(world, { identity: { records: CATEGORY_QUOTAS.identity.records } });
    const value = await inspectDiagnostic(world, 0, 1);
    if (value.state !== "observed") throw new Error("unproved diagnostic fixture");
    expect(value.ceilings.identity).toEqual({
      applicable: 0, bytesBlockedByLowerBound: 0, bytesUnknown: 0, recordsBlocked: 0,
    });
    expect(value.ceilings.device.applicable).toBe(1);
  });

  test.each(["missing_service", "duplicate_service", "predecessor", "duplicate_category", "negative", "unsafe", "pair", "attribution", "marker"])(
    "%s preserves unknown authority instead of reporting a ceiling", async (kind) => {
      const world = await quotaWorld();
      await world.testRuntime.run(async (ctx) => {
        const service = await ctx.db.query("storageUsageService").unique();
        const memory = await ctx.db.query("storageUsageByUser")
          .withIndex("by_user_and_category", (q) => q.eq("userId", world.userId).eq("category", "memory")).unique();
        if (service === null || memory === null) throw new Error("missing diagnostic fixture");
        if (kind === "missing_service") await ctx.db.delete(service._id);
        else if (kind === "duplicate_service") {
          const { _id, _creationTime, ...body } = service;
          void _id; void _creationTime;
          await ctx.db.insert("storageUsageService", body);
        } else if (kind === "predecessor") await ctx.db.delete(memory._id);
        else if (kind === "duplicate_category") {
          const { _id, _creationTime, ...body } = memory;
          void _id; void _creationTime;
          await ctx.db.insert("storageUsageByUser", body);
        } else if (kind === "negative") await ctx.db.patch(memory._id, { records: -1 });
        else if (kind === "unsafe") await ctx.db.patch(memory._id, { records: Number.MAX_SAFE_INTEGER + 1 });
        else if (kind === "pair") await ctx.db.patch(memory._id, { logicalBytes: 1 });
        else if (kind === "marker") await ctx.db.patch(memory._id, { quotaSchemaVersion: 2 });
        else await ctx.db.patch(service._id, { userLogicalBytes: service.userLogicalBytes + 1 });
      });
      expect(await inspectDiagnostic(world)).toEqual({ state: "authority_unknown" });
    },
  );

  test("unrelated resource ledger absence does not invent a reservation ceiling", async () => {
    const world = await quotaWorld();
    await world.testRuntime.run(async (ctx) => {
      for (const row of await ctx.db.query("storageResourceUsageByUser").collect()) await ctx.db.delete(row._id);
    });
    expect((await inspectDiagnostic(world)).state).toBe("observed");
  });
});
