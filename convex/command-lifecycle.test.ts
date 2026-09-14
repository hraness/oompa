import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeFunctionReference } from "convex/server";
import type { GenericId as Id, Value } from "convex/values";
import { convexTest } from "convex-test";

import { parseAuthCredentials } from "../src/cloud/authCredentials";
import { cloudLimits } from "../src/cloud/contracts";
import {
  authorityReductionOrphanRetentionMs,
  classifyAuthorityReductionCapacityForUser,
  createAccountDeletionCapacityForNewUser,
  createDeviceRevocationCapacityForNewDevice,
} from "./authorityReductionCapacity";
import { digestAuthEmail } from "./authEmail";
import {
  activateCommandCapacityReadinessForRuntime,
  acknowledgeDeviceCommandReceipt,
  acknowledgeSessionCommandReceipt,
  patchDeviceCommandWithLifecycleCapacity,
  patchSessionCommandWithLifecycleCapacity,
  reserveCommandLifecycleForInsert,
  requireCommandCapacityReadiness,
  runAuthorityReductionHeadroomPage,
  terminalizeDeviceCommandWithLifecycleCapacity,
  terminalizeSessionCommandWithLifecycleCapacity,
} from "./commandLifecycle";
import {
  CATEGORY_QUOTAS,
  SERVICE_TOTAL_QUOTA,
  USER_TOTAL_QUOTA,
  adjustCommandQuotaForPatch,
  adjustQuotaForPatch,
  initializeUserQuotaAuthority,
  logicalDocumentBytes,
  reserveDeviceQuotaForInsert,
  reserveNonterminalCommandQuotaForInsert,
  reserveQuotaForInsert,
  reserveQuotaForStoredIdentity,
  reserveSessionHeadQuotaForInsert,
  releaseQuotaForDelete,
} from "./quota";
import { COMMAND_TERMINAL_RETENTION_MS } from "./lifecyclePolicy";
import { patchAccountDeletionJobWithCapacity } from "./jobLifecycleCapacity";
import schema from "./schema";
import type { DataModel } from "./server";
import { modules, trackedCommandCapacityReadiness } from "./test.setup";
import {
  commandLifecycleCapacityCharacters,
  commandLifecycleCapacityVersion,
  commandReceiptCapacityReservation,
  durableJobCapacityReservation,
  maximumCommandLifecycleBatch,
} from "./validators";

type Args = Readonly<Record<string, Value>>;
type CommandType = "device" | "session";
const hmacEnvironmentName = "OOMPA_AUTH_HMAC_SECRET";
const priorHmacSecret = process.env[hmacEnvironmentName];

beforeAll(() => {
  process.env[hmacEnvironmentName] = "command-lifecycle-test-secret-at-least-thirty-two-characters";
});

afterAll(() => {
  if (priorHmacSecret === undefined) delete process.env.OOMPA_AUTH_HMAC_SECRET;
  else process.env[hmacEnvironmentName] = priorHmacSecret;
});
type AuditResult = Readonly<{
  continueCursor: string;
  effectRetirement?: readonly Readonly<{
    commandPublicId: string;
    status: "ambiguous" | "eligible" | "enqueue_missing";
  }>[];
  isDone: boolean;
  legacyRevoked?: readonly string[];
  noEffectRetirement?: readonly Readonly<{
    commandPublicId: string;
    status: "ambiguous" | "deadline_pending" | "eligible";
  }>[];
  scanned: number;
  unreserved: readonly string[];
}>;

const genesisQuota = makeFunctionReference<"mutation", Record<string, never>, unknown>(
  "quota:genesisHardAuthority",
);
const auditReservationPage = makeFunctionReference<"query", Args, AuditResult>(
  "commandLifecycle:auditReservationPage",
);
const auditTerminalReceiptCapacityPage = makeFunctionReference<"query", Args, AuditResult>(
  "commandLifecycle:auditTerminalReceiptCapacityPage",
);
const auditAuthorityReductionHeadroomPage = makeFunctionReference<"action", Args, Readonly<{
  capacityMissing: number;
  continueCursor: string;
  hardQuotaBlocked: number;
  isDone: boolean;
  mode: "audit" | "repair";
  orphanCleanupEligible: number;
  orphanCleanupPending: number;
  ready: number;
  repaired: number;
  scanned: number;
  schemaVersion: 1;
  topologyBlocked: number;
}>>("commandLifecycle:auditAuthorityReductionHeadroomPage");
const auditAuthorityReductionQuotaCeilingsPage = makeFunctionReference<"query", Args, unknown>(
  "commandLifecycle:auditAuthorityReductionQuotaCeilingsPage",
);
const reserveAuthorityReductionCapacity = makeFunctionReference<"mutation", Args, Readonly<{
  disposition?: "ready" | "capacity_missing" | "orphan_cleanup_pending"
    | "orphan_cleanup_eligible" | "topology_blocked";
  reserved: number;
  state: "absent" | "ready" | "reclassified" | "repaired";
}>>("commandLifecycle:reserveAuthorityReductionCapacity");
const requestAccountDeletion = makeFunctionReference<"mutation", Args, unknown>(
  "accountDeletion:request",
);
const drainAccountDeletion = makeFunctionReference<"mutation", Args, Readonly<{
  kind: "advanced" | "complete" | "drained" | "idle";
}>>("accountDeletion:drain");
const reserveExisting = makeFunctionReference<"mutation", Args, unknown>(
  "commandLifecycle:reserveExisting",
);
const reserveExistingTerminalReceipt = makeFunctionReference<"mutation", Args, unknown>(
  "commandLifecycle:reserveExistingTerminalReceipt",
);
const normalizeLegacyTerminalReceipt = makeFunctionReference<"mutation", Args, unknown>(
  "commandLifecycle:normalizeLegacyTerminalReceipt",
);
const retireLegacyEffectStarted = makeFunctionReference<"mutation", Args, unknown>(
  "commandLifecycle:retireLegacyEffectStarted",
);
const retireLegacyNoEffectExpired = makeFunctionReference<"mutation", Args, unknown>(
  "commandLifecycle:retireLegacyNoEffectExpired",
);
const confirmSessionTerminalRecovery = makeFunctionReference<"mutation", Args, unknown>(
  "commands:confirmTerminalRecovery",
);
const confirmDeviceTerminalRecovery = makeFunctionReference<"mutation", Args, unknown>(
  "deviceCommands:confirmTerminalRecovery",
);
const prepareDeviceCommand = makeFunctionReference<"mutation", Args, unknown>(
  "deviceCommands:prepare",
);
const markDeviceCommandEffectStarted = makeFunctionReference<"mutation", Args, unknown>(
  "deviceCommands:markEffectStarted",
);
const settleDeviceCommand = makeFunctionReference<"mutation", Args, unknown>(
  "deviceCommands:settle",
);
const enqueueSessionCommand = makeFunctionReference<"mutation", Args, unknown>(
  "commands:enqueue",
);
const enqueueDeviceCommand = makeFunctionReference<"mutation", Args, unknown>(
  "deviceCommands:enqueue",
);
const acknowledgeSessionReceipt = makeFunctionReference<"mutation", Args, unknown>(
  "commands:acknowledgeReceipt",
);
const listCapacitySessionCommands = makeFunctionReference<"query", Args, unknown>(
  "commands:listCapacityNonterminalForTargetPage",
);
const listLegacySessionCommands = makeFunctionReference<"query", Args, unknown>(
  "commands:listNonterminalForTargetPage",
);
const listCapacityDeviceCommands = makeFunctionReference<"query", Args, unknown>(
  "deviceCommands:listCapacityRecoverableForTarget",
);
const listLegacyDeviceCommands = makeFunctionReference<"query", Args, unknown>(
  "deviceCommands:listNonterminalForTargetPage",
);
const auditDirectTablePage = makeFunctionReference<"query", Args, unknown>(
  "quota:auditDirectTablePage",
);
const cleanupExpired = makeFunctionReference<"mutation", Args, unknown>(
  "maintenance:cleanupExpired",
);
const drainDeviceRevocations = makeFunctionReference<"mutation", Args, Readonly<{
  category?: string;
  kind: "advanced" | "complete" | "drained" | "idle";
  processed: number;
}>>("deviceRevocation:drain");

const maximumAuthority = {
  bootGeneration: Number.MAX_SAFE_INTEGER,
  bootId: "b".repeat(cloudLimits.identifierCharacters),
  fence: Number.MAX_SAFE_INTEGER,
} as const;
const maximumPayload = {
  algorithm: "A256GCM" as const,
  ciphertext: "A".repeat(cloudLimits.ciphertextCharacters),
  keyVersion: Number.MAX_SAFE_INTEGER,
  nonce: "B".repeat(16),
};
const maximumSessionResult = {
  ...maximumPayload,
  ciphertext: "C".repeat(cloudLimits.ciphertextCharacters),
};
const maximumDeviceResult = {
  ...maximumPayload,
  ciphertext: "D".repeat(cloudLimits.metadataCiphertextCharacters),
};
const smallEnvelope = {
  ...maximumPayload,
  ciphertext: "E".repeat(32),
};
const trackedRuntimeAttestation = {
  bound: false as const,
  schemaIdentity: "hra-release-attestation-v1" as const,
  schemaVersion: 1 as const,
};

function uuidV7(suffix: string): string {
  return `0198f56e-7b00-7000-8000-${suffix.padStart(12, "0").slice(-12)}`;
}

function currentUuidV7(suffix: string): string {
  const timestamp = Date.now().toString(16).padStart(12, "0").slice(-12);
  return `${timestamp.slice(0, 8)}-${timestamp.slice(8)}-7000-8000-${suffix.padStart(12, "0").slice(-12)}`;
}

function maximumPendingShape(commandType: CommandType) {
  const common = {
    createdAt: Number.MAX_SAFE_INTEGER,
    deadline: Number.MAX_SAFE_INTEGER,
    idempotencyKey: uuidV7(commandType === "session" ? "101" : "201"),
    lifecycleCapacityVersion: commandLifecycleCapacityVersion,
    nonterminal: true,
    payload: maximumPayload,
    publicId: uuidV7(commandType === "session" ? "102" : "202"),
    requestCommitmentVersion: 2 as const,
    requestDigest: "f".repeat(64),
    requestingDeviceId: "d".repeat(32),
    state: "pending" as const,
    targetDeviceId: "t".repeat(32),
    updatedAt: Number.MAX_SAFE_INTEGER,
    userId: "u".repeat(32),
  };
  return commandType === "session"
    ? { ...common, kind: "set_default_preset" as const, sessionId: "s".repeat(32) }
    : { ...common, kind: "account_login_start" as const };
}

function maximumTerminalShape(commandType: CommandType) {
  const pending = maximumPendingShape(commandType);
  const common = {
    ...pending,
    boundAuthority: maximumAuthority,
    lifecycleCapacityVersion: undefined,
    nonterminal: false,
    receiptCapacityReservation: commandReceiptCapacityReservation,
    resultCode: "R".repeat(cloudLimits.resultCodeCharacters),
    resultDigest: "e".repeat(64),
    state: "applied" as const,
  };
  return commandType === "session"
    ? { ...common, result: maximumSessionResult }
    : {
        ...common,
        result: maximumDeviceResult,
        resultExpiresAt: Number.MAX_SAFE_INTEGER,
        resultSingleUse: true,
      };
}

async function lifecycleWorld() {
  const testRuntime = convexTest(schema, modules);
  await testRuntime.mutation(genesisQuota, {});
  const now = Date.now();
  const email = "command-lifecycle@example.com";
  const parsedEmail = parseAuthCredentials({ email });
  if (parsedEmail.kind !== "request_code") throw new Error("email fixture is invalid");
  const emailDigest = await digestAuthEmail(parsedEmail.email);
  const ids = await testRuntime.run(async (ctx) => {
    const control = await ctx.db.query("serviceControl").unique();
    if (control === null) throw new Error("missing service control fixture");
    await ctx.db.patch(control._id, {
      commandCapacityReadiness: trackedCommandCapacityReadiness,
    });
    const userId = await ctx.db.insert("users", {
      email,
      emailVerificationTime: now,
    });
    await initializeUserQuotaAuthority(ctx, userId);
    const user = await ctx.db.get(userId);
    if (user === null) throw new Error("missing lifecycle user");
    await reserveQuotaForStoredIdentity(ctx, userId, user);
    const account = {
      emailVerified: email,
      provider: "hra-control-plane-otp-v1",
      providerAccountId: email,
      userId,
    };
    await reserveQuotaForInsert(ctx, userId, "identity", account);
    await ctx.db.insert("authAccounts", account);
    const device = {
      activatedAt: now,
      authEpoch: 1,
      createdAt: now,
      credentialGeneration: 1,
      encryptedLabel: smallEnvelope,
      keyVersion: 1,
      publicId: "device_lifecycle",
      revision: 1,
      signingPublicKey: "{}",
      status: "active" as const,
      updatedAt: now,
      userId,
      wrappingPublicKey: "{}",
    };
    await reserveDeviceQuotaForInsert(ctx, userId, device);
    const deviceId = await ctx.db.insert("devices", device);
    const subject = {
      authEpoch: 1,
      createdAt: now,
      emailDigest,
      status: "active" as const,
      updatedAt: now,
      userId,
      verifiedAt: now,
    };
    await reserveQuotaForInsert(ctx, userId, "identity", subject);
    await ctx.db.insert("authSubjects", subject);
    const authSessionId = await ctx.db.insert("authSessions", {
      expirationTime: now + 3_600_000,
      userId,
    });
    const deviceSession = {
      authEpoch: 1,
      authSessionId,
      boundAt: now,
      deviceId,
      userId,
    };
    await reserveQuotaForInsert(ctx, userId, "custody", deviceSession);
    await ctx.db.insert("deviceSessions", deviceSession);
    const session = {
      compactHeadSequence: 0,
      createdAt: now,
      detailHeadSequence: 0,
      executionDeviceId: deviceId,
      metadataRevision: 0,
      projectionRevision: 0,
      publicId: "session_lifecycle",
      state: "active" as const,
      updatedAt: now,
      userId,
    };
    await reserveSessionHeadQuotaForInsert(ctx, userId, session);
    const sessionId = await ctx.db.insert("sessionHeads", session);
    return { authSessionId, deviceId, sessionId, userId };
  });
  return {
    ...ids,
    actor: testRuntime.withIdentity({
      issuer: "https://test.example",
      subject: `${ids.userId}|${ids.authSessionId}`,
      tokenIdentifier: `test|${ids.authSessionId}`,
    }),
    now,
    testRuntime,
  };
}

async function insertReservedCommand(
  world: Awaited<ReturnType<typeof lifecycleWorld>>,
  commandType: CommandType,
  suffix: string,
  payload = smallEnvelope,
) {
  return await world.testRuntime.run(async (ctx) => {
    const common = {
      createdAt: world.now,
      deadline: world.now + 60_000,
      idempotencyKey: uuidV7(`${suffix}1`),
      lifecycleCapacityVersion: commandLifecycleCapacityVersion,
      nonterminal: true,
      payload,
      publicId: uuidV7(`${suffix}2`),
      requestCommitmentVersion: 2 as const,
      requestDigest: suffix.padStart(64, "a").slice(-64),
      requestingDeviceId: world.deviceId,
      state: "pending" as const,
      targetDeviceId: world.deviceId,
      updatedAt: world.now,
      userId: world.userId,
    };
    if (commandType === "session") {
      const document = {
        ...common,
        kind: "send" as const,
        sessionId: world.sessionId,
      };
      await reserveNonterminalCommandQuotaForInsert(ctx, world.userId, document);
      const id = await ctx.db.insert("sessionCommands", document);
      const stored = await ctx.db.get(id);
      if (stored === null) throw new Error("missing session command");
      await reserveCommandLifecycleForInsert(ctx, "session", stored);
      return id;
    }
    const document = { ...common, kind: "account_login_start" as const };
    await reserveNonterminalCommandQuotaForInsert(ctx, world.userId, document);
    const id = await ctx.db.insert("deviceCommands", document);
    const stored = await ctx.db.get(id);
    if (stored === null) throw new Error("missing device command");
    await reserveCommandLifecycleForInsert(ctx, "device", stored);
    return id;
  });
}

async function insertLegacyEffectStarted(
  world: Awaited<ReturnType<typeof lifecycleWorld>>,
  commandType: CommandType,
  suffix: string,
  ageMs = 0,
) {
  return await world.testRuntime.run(async (ctx) => {
    const createdAt = world.now - ageMs;
    const common = {
      boundAuthority: maximumAuthority,
      createdAt,
      deadline: createdAt + 60_000,
      idempotencyKey: uuidV7(`${suffix}1`),
      nonterminal: true,
      payload: smallEnvelope,
      publicId: uuidV7(`${suffix}2`),
      requestDigest: suffix.padStart(64, "f").slice(-64),
      requestingDeviceId: world.deviceId,
      state: "effect_started" as const,
      targetDeviceId: world.deviceId,
      updatedAt: createdAt,
      userId: world.userId,
    };
    const commandId = commandType === "session"
      ? await (async () => {
          const command = { ...common, kind: "send" as const, sessionId: world.sessionId };
          await reserveNonterminalCommandQuotaForInsert(ctx, world.userId, command);
          return await ctx.db.insert("sessionCommands", command);
        })()
      : await (async () => {
          const command = { ...common, kind: "usage_refresh" as const };
          await reserveNonterminalCommandQuotaForInsert(ctx, world.userId, command);
          return await ctx.db.insert("deviceCommands", command);
        })();
    const enqueue = {
      actorDeviceId: world.deviceId,
      createdAt,
      entityId: common.publicId,
      event: "command_enqueued" as const,
      userId: world.userId,
    };
    await reserveQuotaForInsert(ctx, world.userId, "security", enqueue);
    const eventId = await ctx.db.insert("securityEvents", enqueue);
    return { commandId, eventId, publicId: common.publicId };
  });
}

async function assertPhysicalCategoryLedgers(
  world: Awaited<ReturnType<typeof lifecycleWorld>>,
): Promise<void> {
  const snapshot = await world.testRuntime.run(async (ctx) => {
    const [
      sessionCommands,
      deviceCommands,
      lifecycleReservations,
      securityReservations,
      securityEvents,
      commandUsage,
      securityUsage,
    ] = await Promise.all([
      ctx.db.query("sessionCommands").collect(),
      ctx.db.query("deviceCommands").collect(),
      ctx.db.query("commandLifecycleReservations").collect(),
      ctx.db.query("commandTerminalSecurityReservations").collect(),
      ctx.db.query("securityEvents").collect(),
      ctx.db.query("storageUsageByUser")
        .withIndex("by_user_and_category", (builder) => builder
          .eq("userId", world.userId)
          .eq("category", "command"))
        .unique(),
      ctx.db.query("storageUsageByUser")
        .withIndex("by_user_and_category", (builder) => builder
          .eq("userId", world.userId)
          .eq("category", "security"))
        .unique(),
    ]);
    const commandDocuments = [
      ...sessionCommands,
      ...deviceCommands,
      ...lifecycleReservations,
    ];
    const securityDocuments = [...securityReservations, ...securityEvents];
    return {
      commandActualBytes: commandDocuments.reduce(
        (sum, document) => sum + logicalDocumentBytes(document),
        0,
      ),
      commandActualRecords: commandDocuments.length,
      commandUsage,
      securityActualBytes: securityDocuments.reduce(
        (sum, document) => sum + logicalDocumentBytes(document),
        0,
      ),
      securityActualRecords: securityDocuments.length,
      securityUsage,
    };
  });
  expect(snapshot.commandUsage).toMatchObject({
    logicalBytes: snapshot.commandActualBytes,
    records: snapshot.commandActualRecords,
  });
  expect(snapshot.securityUsage).toMatchObject({
    logicalBytes: snapshot.securityActualBytes,
    records: snapshot.securityActualRecords,
  });
}

async function saturateUserAndServiceCeilings(
  world: Awaited<ReturnType<typeof lifecycleWorld>>,
): Promise<void> {
  await world.testRuntime.run(async (ctx) => {
    const categoryRows = await ctx.db.query("storageUsageByUser")
      .withIndex("by_user_and_category", (builder) => builder.eq("userId", world.userId))
      .collect();
    const chunk = categoryRows.find((row) => row.category === "chunk");
    const security = categoryRows.find((row) => row.category === "security");
    const service = await ctx.db.query("storageUsageService")
      .withIndex("by_key", (builder) => builder.eq("key", "global"))
      .unique();
    if (chunk === undefined || security === undefined || service === null) {
      throw new Error("missing lifecycle quota authority");
    }
    const currentUserBytes = categoryRows.reduce((sum, row) => sum + row.logicalBytes, 0);
    const currentUserRecords = categoryRows.reduce((sum, row) => sum + row.records, 0);
    const byteFiller = USER_TOTAL_QUOTA.logicalBytes - currentUserBytes;
    const securityByteFiller = 1_024;
    const chunkRecordDelta = chunk.records === 0 ? 1 : 0;
    const securityRecordDelta = CATEGORY_QUOTAS.security.records - security.records;
    const nextUserRecords = currentUserRecords + chunkRecordDelta + securityRecordDelta;
    if (byteFiller <= securityByteFiller || nextUserRecords > USER_TOTAL_QUOTA.records) {
      throw new Error("invalid lifecycle quota saturation fixture");
    }
    await ctx.db.patch(chunk._id, {
      logicalBytes: chunk.logicalBytes + byteFiller - securityByteFiller,
      records: chunk.records + chunkRecordDelta,
      updatedAt: world.now,
    });
    await ctx.db.patch(security._id, {
      logicalBytes: security.logicalBytes + securityByteFiller,
      records: CATEGORY_QUOTAS.security.records,
      updatedAt: world.now,
    });
    await ctx.db.patch(service._id, {
      logicalBytes: SERVICE_TOTAL_QUOTA.logicalBytes,
      records: SERVICE_TOTAL_QUOTA.records,
      serviceLogicalBytes: SERVICE_TOTAL_QUOTA.logicalBytes - USER_TOTAL_QUOTA.logicalBytes,
      serviceRecords: SERVICE_TOTAL_QUOTA.records - nextUserRecords,
      updatedAt: world.now,
      userLogicalBytes: USER_TOTAL_QUOTA.logicalBytes,
      userRecords: nextUserRecords,
    });
  });
}

async function usageCeilings(world: Awaited<ReturnType<typeof lifecycleWorld>>) {
  return await world.testRuntime.run(async (ctx) => {
    const categoryRows = await ctx.db.query("storageUsageByUser")
      .withIndex("by_user_and_category", (builder) => builder.eq("userId", world.userId))
      .collect();
    const service = await ctx.db.query("storageUsageService")
      .withIndex("by_key", (builder) => builder.eq("key", "global"))
      .unique();
    const security = categoryRows.find((row) => row.category === "security");
    return {
      securityRecords: security?.records,
      serviceBytes: service?.logicalBytes,
      serviceRecords: service?.records,
      userBytes: categoryRows.reduce((sum, row) => sum + row.logicalBytes, 0),
    };
  });
}

async function releaseSyntheticByteHeadroom(
  world: Awaited<ReturnType<typeof lifecycleWorld>>,
  bytes = 1_024,
  records = 0,
): Promise<void> {
  await world.testRuntime.run(async (ctx) => {
    const chunk = await ctx.db.query("storageUsageByUser")
      .withIndex("by_user_and_category", (builder) => builder
        .eq("userId", world.userId)
        .eq("category", "chunk"))
      .unique();
    const service = await ctx.db.query("storageUsageService")
      .withIndex("by_key", (builder) => builder.eq("key", "global"))
      .unique();
    const security = await ctx.db.query("storageUsageByUser")
      .withIndex("by_user_and_category", (builder) => builder
        .eq("userId", world.userId)
        .eq("category", "security"))
      .unique();
    if (
      chunk === null
      || service === null
      || security === null
      || chunk.logicalBytes < bytes
      || service.logicalBytes < bytes
      || service.userLogicalBytes < bytes
      || security.records < records
      || service.records < records
      || service.userRecords < records
    ) throw new Error("invalid synthetic quota headroom fixture");
    await ctx.db.patch(chunk._id, {
      logicalBytes: chunk.logicalBytes - bytes,
      updatedAt: world.now,
    });
    await ctx.db.patch(service._id, {
      logicalBytes: service.logicalBytes - bytes,
      records: service.records - records,
      updatedAt: world.now,
      userLogicalBytes: service.userLogicalBytes - bytes,
      userRecords: service.userRecords - records,
    });
    if (records !== 0) {
      await ctx.db.patch(security._id, { records: security.records - records });
    }
  });
}

describe("command lifecycle physical quota reservations", () => {
  test("activates one exact runtime receipt idempotently and invalidates it on redeploy", async () => {
    const world = await lifecycleWorld();
    const firstRuntime = {
      bound: true as const,
      deployedAtMs: 10,
      previousDeployDigest: "1".repeat(64),
      runtimeRevision: "00000000-0000-4000-8000-000000000010",
      runtimeSourceCommit: "2".repeat(40),
      schemaIdentity: "hra-release-attestation-v1" as const,
      schemaVersion: 1 as const,
    };
    const first = {
      candidateDeployDigest: "3".repeat(64),
      evidenceDigest: "4".repeat(64),
      expectedRuntimeAttestation: firstRuntime,
      lifecycleCapacityVersion: commandLifecycleCapacityVersion,
      targetDigest: "5".repeat(64),
    } as const;
    expect(await world.testRuntime.run(async (ctx) =>
      await activateCommandCapacityReadinessForRuntime(ctx, first, firstRuntime)))
      .toMatchObject({ replay: false, readiness: { evidenceDigest: first.evidenceDigest } });
    expect(await world.testRuntime.run(async (ctx) =>
      await activateCommandCapacityReadinessForRuntime(ctx, first, firstRuntime)))
      .toMatchObject({ replay: true, readiness: { evidenceDigest: first.evidenceDigest } });
    await expect(world.testRuntime.run(async (ctx) =>
      await activateCommandCapacityReadinessForRuntime(ctx, {
        ...first,
        evidenceDigest: "6".repeat(64),
      }, firstRuntime))).rejects.toThrow("COMMAND_CAPACITY_ACTIVATION_CONFLICT");

    // The tracked test runtime has a different compiled attestation, exactly
    // like a new candidate deployment. It cannot consume the old marker.
    await expect(world.testRuntime.run(async (ctx) =>
      requireCommandCapacityReadiness(ctx, 2))).rejects.toThrow(
        "COMMAND_CAPACITY_NOT_READY",
      );
    const nextRuntime = {
      ...firstRuntime,
      deployedAtMs: 11,
      previousDeployDigest: first.candidateDeployDigest,
      runtimeRevision: "00000000-0000-4000-8000-000000000011",
      runtimeSourceCommit: "7".repeat(40),
    };
    const next = {
      ...first,
      candidateDeployDigest: "8".repeat(64),
      evidenceDigest: "9".repeat(64),
      expectedRuntimeAttestation: nextRuntime,
    } as const;
    await expect(world.testRuntime.run(async (ctx) =>
      await activateCommandCapacityReadinessForRuntime(ctx, first, nextRuntime)))
      .rejects.toThrow("COMMAND_LIFECYCLE_RUNTIME_CHANGED");
    expect(await world.testRuntime.run(async (ctx) =>
      await activateCommandCapacityReadinessForRuntime(ctx, next, nextRuntime)))
      .toMatchObject({ replay: false, readiness: { evidenceDigest: next.evidenceDigest } });
  });

  test("audits and atomically backfills physical revoke/delete capacity", async () => {
    const world = await lifecycleWorld();
    expect(await world.testRuntime.action(auditAuthorityReductionHeadroomPage, {
      expectedRuntimeAttestation: trackedRuntimeAttestation,
      mode: "audit",
      paginationOpts: { cursor: null, numItems: maximumCommandLifecycleBatch },
    })).toMatchObject({
      capacityMissing: 1,
      ready: 0,
      scanned: 1,
      topologyBlocked: 0,
    });
    expect(await world.testRuntime.action(auditAuthorityReductionHeadroomPage, {
      expectedRuntimeAttestation: trackedRuntimeAttestation,
      mode: "repair",
      paginationOpts: { cursor: null, numItems: maximumCommandLifecycleBatch },
    })).toMatchObject({
      capacityMissing: 0,
      hardQuotaBlocked: 0,
      repaired: 1,
      scanned: 1,
    });
    expect(await world.testRuntime.action(auditAuthorityReductionHeadroomPage, {
      expectedRuntimeAttestation: trackedRuntimeAttestation,
      mode: "audit",
      paginationOpts: { cursor: null, numItems: maximumCommandLifecycleBatch },
    })).toMatchObject({ capacityMissing: 0, ready: 1, scanned: 1 });
    const concurrentEmail = "concurrent-current-authority@example.com";
    const parsedConcurrentEmail = parseAuthCredentials({ email: concurrentEmail });
    if (parsedConcurrentEmail.kind !== "request_code") {
      throw new Error("concurrent email fixture is invalid");
    }
    const concurrentEmailDigest = await digestAuthEmail(parsedConcurrentEmail.email);
    await world.testRuntime.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {
        email: concurrentEmail,
        emailVerificationTime: world.now,
      });
      await initializeUserQuotaAuthority(ctx, userId);
      const user = await ctx.db.get(userId);
      if (user === null) throw new Error("missing concurrent capacity user");
      await reserveQuotaForStoredIdentity(ctx, userId, user);
      await createAccountDeletionCapacityForNewUser(ctx, userId);
      const account = {
        emailVerified: concurrentEmail,
        provider: "hra-control-plane-otp-v1",
        providerAccountId: concurrentEmail,
        userId,
      };
      await reserveQuotaForInsert(ctx, userId, "identity", account);
      await ctx.db.insert("authAccounts", account);
      const subject = {
        authEpoch: 1,
        createdAt: world.now,
        emailDigest: concurrentEmailDigest,
        status: "active" as const,
        updatedAt: world.now,
        userId,
        verifiedAt: world.now,
      };
      await reserveQuotaForInsert(ctx, userId, "identity", subject);
      await ctx.db.insert("authSubjects", subject);
      const device = {
        activatedAt: world.now,
        authEpoch: 1,
        createdAt: world.now,
        credentialGeneration: 1,
        encryptedLabel: smallEnvelope,
        keyVersion: 1,
        publicId: "device_concurrent_capacity",
        revision: 1,
        signingPublicKey: "{}",
        status: "active" as const,
        updatedAt: world.now,
        userId,
        wrappingPublicKey: "{}",
      };
      await reserveDeviceQuotaForInsert(ctx, userId, device);
      const deviceId = await ctx.db.insert("devices", device);
      await createDeviceRevocationCapacityForNewDevice(ctx, userId, deviceId);
    });
    expect(await world.testRuntime.action(auditAuthorityReductionHeadroomPage, {
      expectedRuntimeAttestation: trackedRuntimeAttestation,
      mode: "audit",
      paginationOpts: { cursor: null, numItems: maximumCommandLifecycleBatch },
    })).toMatchObject({ capacityMissing: 0, ready: 2, scanned: 2 });
    expect(await world.testRuntime.run(async (ctx) => ({
      accountIdentity: await ctx.db.query("accountDeletionIdentityReservations").collect(),
      accountJob: await ctx.db.query("accountDeletionJobReservations").collect(),
      device: await ctx.db.query("deviceRevocationDeviceReservations").collect(),
      deviceJob: await ctx.db.query("deviceRevocationJobReservations").collect(),
      deviceReceipt: await ctx.db.query("deviceRevocationReceiptReservations").collect(),
      deviceSecurity: await ctx.db.query("deviceRevocationSecurityReservations").collect(),
    }))).toMatchObject({
      accountIdentity: [{ category: "identity" }, { category: "identity" }],
      accountJob: [{ category: "job" }, { category: "job" }],
      device: [
        { category: "device", deviceId: world.deviceId },
        { category: "device" },
      ],
      deviceJob: [
        { category: "job", deviceId: world.deviceId },
        { category: "job" },
      ],
      deviceReceipt: [
        { category: "receipt", deviceId: world.deviceId },
        { category: "receipt" },
      ],
      deviceSecurity: [
        { category: "security", deviceId: world.deviceId },
        { category: "security" },
      ],
    });

    const saturated = await lifecycleWorld();
    await saturateUserAndServiceCeilings(saturated);
    const beforeBlockedRepair = await saturated.testRuntime.run(async (ctx) => ({
      accountIdentity: await ctx.db.query("accountDeletionIdentityReservations").collect(),
      accountJob: await ctx.db.query("accountDeletionJobReservations").collect(),
      device: await ctx.db.query("deviceRevocationDeviceReservations").collect(),
      deviceJob: await ctx.db.query("deviceRevocationJobReservations").collect(),
      deviceReceipt: await ctx.db.query("deviceRevocationReceiptReservations").collect(),
      deviceSecurity: await ctx.db.query("deviceRevocationSecurityReservations").collect(),
      serviceUsage: await ctx.db.query("storageUsageService").collect(),
      userUsage: await ctx.db.query("storageUsageByUser").collect(),
    }));
    await expect(saturated.testRuntime.mutation(reserveAuthorityReductionCapacity, {
      expectedRuntimeAttestation: trackedRuntimeAttestation,
      userId: saturated.userId,
    })).rejects.toThrow("authority_reduction_hard_quota");
    expect(await saturated.testRuntime.action(auditAuthorityReductionHeadroomPage, {
      expectedRuntimeAttestation: trackedRuntimeAttestation,
      mode: "audit",
      paginationOpts: { cursor: null, numItems: maximumCommandLifecycleBatch },
    })).toMatchObject({
      capacityMissing: 1,
      ready: 0,
    });
    expect(await saturated.testRuntime.action(auditAuthorityReductionHeadroomPage, {
      expectedRuntimeAttestation: trackedRuntimeAttestation,
      mode: "repair",
      paginationOpts: { cursor: null, numItems: maximumCommandLifecycleBatch },
    })).toMatchObject({
      capacityMissing: 0,
      hardQuotaBlocked: 1,
      repaired: 0,
      scanned: 1,
    });
    expect(await saturated.testRuntime.run(async (ctx) => ({
      accountIdentity: await ctx.db.query("accountDeletionIdentityReservations").collect(),
      accountJob: await ctx.db.query("accountDeletionJobReservations").collect(),
      device: await ctx.db.query("deviceRevocationDeviceReservations").collect(),
      deviceJob: await ctx.db.query("deviceRevocationJobReservations").collect(),
      deviceReceipt: await ctx.db.query("deviceRevocationReceiptReservations").collect(),
      deviceSecurity: await ctx.db.query("deviceRevocationSecurityReservations").collect(),
      serviceUsage: await ctx.db.query("storageUsageService").collect(),
      userUsage: await ctx.db.query("storageUsageByUser").collect(),
    }))).toEqual(beforeBlockedRepair);
  });

  test("does not relabel an unknown repair failure as hard quota", async () => {
    const world = await lifecycleWorld();
    await world.testRuntime.run(async (ctx) => {
      const service = await ctx.db.query("storageUsageService").unique();
      if (service === null) throw new Error("missing service quota fixture");
      await ctx.db.delete(service._id);
    });
    await expect(world.testRuntime.action(auditAuthorityReductionHeadroomPage, {
      expectedRuntimeAttestation: trackedRuntimeAttestation,
      mode: "repair",
      paginationOpts: { cursor: null, numItems: maximumCommandLifecycleBatch },
    })).rejects.toThrow("QUOTA_AUTHORITY_CORRUPT");
  });

  test("counts a user deleted between page classification and repair as ready", async () => {
    const world = await lifecycleWorld();
    await world.testRuntime.run(async (ctx) => {
      const authSession = await ctx.db.get(world.authSessionId);
      if (authSession === null) throw new Error("missing deletion-race auth session");
      await reserveQuotaForInsert(ctx, world.userId, "identity", authSession);
      await createAccountDeletionCapacityForNewUser(ctx, world.userId);
    });
    let deletionCompleted = false;
    const result = await runAuthorityReductionHeadroomPage({
      runMutation: async (reference, args) =>
        await world.testRuntime.mutation(reference, args),
      runQuery: async (reference, args) => {
        const page = await world.testRuntime.query(reference, args);
        expect(page).toMatchObject({
          classified: [{ disposition: "capacity_missing", userId: world.userId }],
          scanned: 1,
        });
        await world.actor.mutation(requestAccountDeletion, {
          jobId: "delete_job_capacity_race_AAAAAAAAAAAAAAAAAAAA",
          statusCapability: "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-ABCDE",
        });
        for (let iteration = 0; iteration < 100; iteration += 1) {
          const drained = await world.testRuntime.mutation(drainAccountDeletion, {
            limit: 200,
          });
          if (drained.kind === "complete") {
            deletionCompleted = true;
            break;
          }
        }
        if (!deletionCompleted) throw new Error("account deletion race did not complete");
        expect(await world.testRuntime.run(async (ctx) =>
          await ctx.db.get(world.userId))).toBeNull();
        return page;
      },
    }, {
      expectedRuntimeAttestation: trackedRuntimeAttestation,
      mode: "repair",
      paginationOpts: { cursor: null, numItems: maximumCommandLifecycleBatch },
    });
    expect(result).toMatchObject({
      capacityMissing: 0,
      hardQuotaBlocked: 0,
      ready: 1,
      repaired: 0,
      scanned: 1,
      topologyBlocked: 0,
    });
  });

  test("keeps a disconnected unverified Auth user as rollout debt", async () => {
    const runtime = convexTest(schema, modules);
    await runtime.mutation(genesisQuota, {});
    const now = Date.now();
    const email = "otp-gap@example.com";
    const parsedEmail = parseAuthCredentials({ email });
    if (parsedEmail.kind !== "request_code") throw new Error("email fixture is invalid");
    const emailDigest = await digestAuthEmail(parsedEmail.email);
    const userId = await runtime.run(async (ctx) => {
      const userId = await ctx.db.insert("users", { email });
      await initializeUserQuotaAuthority(ctx, userId);
      const user = await ctx.db.get(userId);
      if (user === null) throw new Error("missing OTP gap user");
      await reserveQuotaForStoredIdentity(ctx, userId, user);
      await createAccountDeletionCapacityForNewUser(ctx, userId);
      const account = {
        provider: "hra-control-plane-otp-v1",
        providerAccountId: email,
        userId,
      };
      await reserveQuotaForInsert(ctx, userId, "identity", account);
      await ctx.db.insert("authAccounts", account);
      return userId;
    });
    expect(await runtime.action(auditAuthorityReductionHeadroomPage, {
      expectedRuntimeAttestation: trackedRuntimeAttestation,
      mode: "audit",
      paginationOpts: { cursor: null, numItems: maximumCommandLifecycleBatch },
    })).toMatchObject({
      orphanCleanupPending: 1,
      scanned: 1,
      topologyBlocked: 0,
    });
    const newestOrphanWrite = await runtime.run(async (ctx) => {
      const [user, account, identity, job] = await Promise.all([
        ctx.db.get(userId),
        ctx.db.query("authAccounts")
          .withIndex("userIdAndProvider", (builder) => builder.eq("userId", userId))
          .unique(),
        ctx.db.query("accountDeletionIdentityReservations")
          .withIndex("by_user", (builder) => builder.eq("userId", userId))
          .unique(),
        ctx.db.query("accountDeletionJobReservations")
          .withIndex("by_user", (builder) => builder.eq("userId", userId))
          .unique(),
      ]);
      if (user === null || account === null || identity === null || job === null) {
        throw new Error("missing OTP gap boundary fixture");
      }
      return Math.max(
        user._creationTime,
        account._creationTime,
        identity.createdAt,
        job.createdAt,
      );
    });
    for (const [offset, disposition] of [
      [0, "orphan_cleanup_pending"],
      [1, "orphan_cleanup_eligible"],
    ] as const) {
      expect(await runtime.run(async (ctx) =>
        await classifyAuthorityReductionCapacityForUser(
          ctx,
          userId,
          newestOrphanWrite + authorityReductionOrphanRetentionMs + offset,
        ))).toMatchObject({ disposition });
    }
    expect(await runtime.mutation(reserveAuthorityReductionCapacity, {
      expectedRuntimeAttestation: trackedRuntimeAttestation,
      userId,
    })).toEqual({
      disposition: "orphan_cleanup_pending",
      reserved: 0,
      state: "reclassified",
    });
    await runtime.run(async (ctx) => {
      const subject = {
        admittedBy: "open" as const,
        authEpoch: 1,
        createdAt: now,
        emailDigest,
        status: "active" as const,
        updatedAt: now,
        userId,
      };
      await reserveQuotaForInsert(ctx, userId, "identity", subject);
      await ctx.db.insert("authSubjects", subject);
    });
    expect(await runtime.action(auditAuthorityReductionHeadroomPage, {
      expectedRuntimeAttestation: trackedRuntimeAttestation,
      mode: "audit",
      paginationOpts: { cursor: null, numItems: maximumCommandLifecycleBatch },
    })).toMatchObject({ ready: 1, scanned: 1 });
  });

  test("requires exact Oompa identity topology before certifying or backfilling capacity", async () => {
    const corruptions = [
      "missing_account",
      "noncanonical_user_email",
      "wrong_account_email",
      "wrong_digest",
      "wrong_provider",
      "verified_account_for_unverified_user",
      "verified_subject_for_unverified_user",
      "wrong_account_verification",
      "wrong_verification_time",
    ] as const;
    for (const corruption of corruptions) {
      const world = await lifecycleWorld();
      await world.testRuntime.mutation(reserveAuthorityReductionCapacity, {
        expectedRuntimeAttestation: trackedRuntimeAttestation,
        userId: world.userId,
      });
      await world.testRuntime.run(async (ctx) => {
        const [account, subject, user] = await Promise.all([
          ctx.db.query("authAccounts")
            .withIndex("userIdAndProvider", (builder) => builder.eq("userId", world.userId))
            .unique(),
          ctx.db.query("authSubjects")
            .withIndex("by_user", (builder) => builder.eq("userId", world.userId))
            .unique(),
          ctx.db.get(world.userId),
        ]);
        if (account === null || subject === null || user === null) {
          throw new Error("missing topology fixture");
        }
        switch (corruption) {
          case "missing_account":
            await ctx.db.delete(account._id);
            break;
          case "noncanonical_user_email":
            await ctx.db.patch(user._id, { email: "INVALID@EXAMPLE.COM" });
            break;
          case "wrong_account_email":
            await ctx.db.patch(account._id, { providerAccountId: "other@example.com" });
            break;
          case "wrong_digest":
            await ctx.db.patch(subject._id, { emailDigest: "f".repeat(64) });
            break;
          case "wrong_provider":
            await ctx.db.patch(account._id, { provider: "other-provider" });
            break;
          case "verified_account_for_unverified_user":
            await ctx.db.patch(user._id, { emailVerificationTime: undefined });
            await ctx.db.patch(subject._id, { verifiedAt: undefined });
            break;
          case "verified_subject_for_unverified_user":
            await ctx.db.patch(user._id, { emailVerificationTime: undefined });
            await ctx.db.patch(account._id, { emailVerified: undefined });
            break;
          case "wrong_account_verification":
            await ctx.db.patch(account._id, { emailVerified: "other@example.com" });
            break;
          case "wrong_verification_time":
            await ctx.db.patch(subject._id, { verifiedAt: world.now + 1 });
        }
      });
      expect(await world.testRuntime.action(auditAuthorityReductionHeadroomPage, {
        expectedRuntimeAttestation: trackedRuntimeAttestation,
        mode: "audit",
        paginationOpts: { cursor: null, numItems: maximumCommandLifecycleBatch },
      })).toMatchObject({
        ready: 0,
        topologyBlocked: 1,
      });
      expect(await world.testRuntime.mutation(reserveAuthorityReductionCapacity, {
        expectedRuntimeAttestation: trackedRuntimeAttestation,
        userId: world.userId,
      })).toEqual({
        disposition: "topology_blocked",
        reserved: 0,
        state: "reclassified",
      });
    }

    const lazyVerified = await lifecycleWorld();
    await lazyVerified.testRuntime.mutation(reserveAuthorityReductionCapacity, {
      expectedRuntimeAttestation: trackedRuntimeAttestation,
      userId: lazyVerified.userId,
    });
    await lazyVerified.testRuntime.run(async (ctx) => {
      const subject = await ctx.db.query("authSubjects")
        .withIndex("by_user", (builder) => builder.eq("userId", lazyVerified.userId))
        .unique();
      if (subject === null) throw new Error("missing lazy verification fixture");
      await ctx.db.patch(subject._id, { verifiedAt: undefined });
    });
    expect(await lazyVerified.testRuntime.action(auditAuthorityReductionHeadroomPage, {
      expectedRuntimeAttestation: trackedRuntimeAttestation,
      mode: "audit",
      paginationOpts: { cursor: null, numItems: maximumCommandLifecycleBatch },
    })).toMatchObject({ ready: 1, topologyBlocked: 0 });
  });

  test("certifies only an exact monotonically draining account deletion job", async () => {
    for (const kind of [
      "valid_pending",
      "valid_draining",
      "valid_capacity_pending",
      "active_subject",
      "unconsumed_pair",
      "wrong_capacity",
    ] as const) {
      const valid = kind === "valid_pending"
        || kind === "valid_draining"
        || kind === "valid_capacity_pending";
      const world = await lifecycleWorld();
      await world.testRuntime.run(async (ctx) => {
        const subject = await ctx.db.query("authSubjects")
          .withIndex("by_user", (builder) => builder.eq("userId", world.userId))
          .unique();
        if (subject === null) throw new Error("missing deletion topology subject");
        if (kind !== "active_subject") {
          await ctx.db.patch(subject._id, { status: "disabled" });
        }
        if (kind === "unconsumed_pair") {
          await createAccountDeletionCapacityForNewUser(ctx, world.userId);
        }
        const job = {
          ...(kind === "valid_capacity_pending"
            ? { capacityReservation: durableJobCapacityReservation }
            : kind === "wrong_capacity"
              ? { capacityReservation: "0" }
              : {}),
          category: "commands_and_leases" as const,
          createdAt: world.now,
          publicId: uuidV7(
            kind === "valid_pending"
              ? "404"
              : kind === "valid_draining"
                ? "405"
                : kind === "valid_capacity_pending"
                  ? "406"
                  : kind === "active_subject"
                    ? "407"
                    : kind === "unconsumed_pair"
                      ? "408"
                      : "409",
          ),
          state: kind === "valid_draining" ? "draining" as const : "pending" as const,
          statusCapabilityDigest: "b".repeat(64),
          subjectId: subject._id,
          updatedAt: world.now,
          userId: world.userId,
        };
        await reserveQuotaForInsert(ctx, world.userId, "job", job);
        await ctx.db.insert("accountDeletionJobs", job);
      });
      expect(await world.testRuntime.action(auditAuthorityReductionHeadroomPage, {
        expectedRuntimeAttestation: trackedRuntimeAttestation,
        mode: "audit",
        paginationOpts: { cursor: null, numItems: maximumCommandLifecycleBatch },
      })).toMatchObject(valid
        ? { ready: 1, topologyBlocked: 0 }
        : { ready: 0, topologyBlocked: 1 });
      const mutation = world.testRuntime.mutation(reserveAuthorityReductionCapacity, {
        expectedRuntimeAttestation: trackedRuntimeAttestation,
        userId: world.userId,
      });
      if (valid) expect(await mutation).toEqual({ reserved: 0, state: "ready" });
      else expect(await mutation).toEqual({
        disposition: "topology_blocked",
        reserved: 0,
        state: "reclassified",
      });
    }
  });

  test("certifies every exactly resized current account-deletion stage", async () => {
    const world = await lifecycleWorld();
    const jobId = await world.testRuntime.run(async (ctx) => {
      const subject = await ctx.db.query("authSubjects")
        .withIndex("by_user", (builder) => builder.eq("userId", world.userId))
        .unique();
      if (subject === null) throw new Error("missing deletion topology subject");
      await ctx.db.patch(subject._id, { status: "disabled" });
      const job = {
        capacityReservation: durableJobCapacityReservation,
        category: "commands_and_leases" as const,
        createdAt: world.now,
        publicId: uuidV7("410"),
        state: "pending" as const,
        statusCapabilityDigest: "c".repeat(64),
        subjectId: subject._id,
        updatedAt: world.now,
        userId: world.userId,
      };
      await reserveQuotaForInsert(ctx, world.userId, "job", job);
      return await ctx.db.insert("accountDeletionJobs", job);
    });
    const assertReady = async () => {
      expect(await world.testRuntime.action(auditAuthorityReductionHeadroomPage, {
        expectedRuntimeAttestation: trackedRuntimeAttestation,
        mode: "audit",
        paginationOpts: { cursor: null, numItems: maximumCommandLifecycleBatch },
      })).toMatchObject({ ready: 1, topologyBlocked: 0 });
      expect(await world.testRuntime.mutation(reserveAuthorityReductionCapacity, {
        expectedRuntimeAttestation: trackedRuntimeAttestation,
        userId: world.userId,
      })).toEqual({ reserved: 0, state: "ready" });
    };
    await assertReady();
    const drainingCategories = [
      "chunks_and_epochs",
      "session_heads",
      "usage_and_bindings",
      "codex_accounts",
      "device_custody",
      "devices",
      "receipts_and_events",
      "auth_tokens_and_verifiers",
      "auth_sessions",
      "auth_challenges",
      "auth_accounts",
      "user_and_subject",
    ] as const;
    for (const [index, category] of drainingCategories.entries()) {
      await world.testRuntime.run(async (ctx) => {
        const job = await ctx.db.get(jobId);
        if (job === null) throw new Error("missing capacity-backed deletion job");
        await patchAccountDeletionJobWithCapacity(ctx, job, {
          category,
          state: "draining",
          updatedAt: world.now + index + 1,
        });
      });
      await assertReady();
    }
  });

  test("command public ids are globally unique across both tables, including concurrent admission", async () => {
    const requestFor = (commandType: CommandType, publicId: string, suffix: string) =>
      commandType === "session"
        ? {
            deadline: Date.now() + 60_000,
            expectedTargetDevicePublicId: "device_lifecycle",
            idempotencyKey: currentUuidV7(`${suffix}1`),
            kind: "send",
            payload: smallEnvelope,
            publicId,
            requestDigest: suffix.repeat(64).slice(0, 64),
            sessionPublicId: "session_lifecycle",
          }
        : {
            deadline: Date.now() + 60_000,
            expectedTargetDevicePublicId: "device_lifecycle",
            idempotencyKey: currentUuidV7(`${suffix}2`),
            kind: "usage_refresh",
            payload: smallEnvelope,
            publicId,
            requestDigest: suffix.repeat(64).slice(0, 64),
          };
    const mutationFor = (commandType: CommandType) => commandType === "session"
      ? enqueueSessionCommand
      : enqueueDeviceCommand;

    for (const firstType of ["session", "device"] as const) {
      const world = await lifecycleWorld();
      const publicId = uuidV7(firstType === "session" ? "401" : "402");
      await world.actor.mutation(mutationFor(firstType), requestFor(firstType, publicId, "a"));
      const otherType = firstType === "session" ? "device" : "session";
      await expect(world.actor.mutation(
        mutationFor(otherType),
        requestFor(otherType, publicId, "b"),
      )).rejects.toThrow("Cloud authority is not current.");
    }

    const concurrent = await lifecycleWorld();
    const publicId = uuidV7("403");
    const outcomes = await Promise.allSettled([
      concurrent.actor.mutation(
        enqueueSessionCommand,
        requestFor("session", publicId, "c"),
      ),
      concurrent.actor.mutation(
        enqueueDeviceCommand,
        requestFor("device", publicId, "d"),
      ),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    expect(await concurrent.testRuntime.run(async (ctx) => (
      await ctx.db.query("sessionCommands")
        .withIndex("by_public_id", (builder) => builder.eq("publicId", publicId))
        .collect()
    ).length + (
      await ctx.db.query("deviceCommands")
        .withIndex("by_public_id", (builder) => builder.eq("publicId", publicId))
        .collect()
    ).length)).toBe(1);
  });

  test("covers every exact maximal terminal shape and both receipt outcomes", () => {
    const expectedMaximumGrowth = { device: 17_079, session: 350_653 } as const;
    for (const commandType of ["session", "device"] as const) {
      const pending = maximumPendingShape(commandType);
      const terminal = maximumTerminalShape(commandType);
      const required = logicalDocumentBytes(terminal) - logicalDocumentBytes(pending);
      expect(required).toBe(expectedMaximumGrowth[commandType]);
      expect(required).toBeLessThan(commandLifecycleCapacityCharacters[commandType]);
    }

    const reserved = maximumTerminalShape("session");
    const acknowledged = {
      ...reserved,
      receiptCapacityReservation: undefined,
      requesterAcknowledgedAt: Number.MAX_SAFE_INTEGER,
      terminalCleanupAfter: Number.MAX_SAFE_INTEGER,
    };
    const abandoned = {
      ...reserved,
      receiptCapacityReservation: undefined,
      requesterReceiptAbandonedAt: Number.MAX_SAFE_INTEGER,
      terminalCleanupAfter: Number.MAX_SAFE_INTEGER,
    };
    expect(logicalDocumentBytes(acknowledged)).toBeLessThanOrEqual(logicalDocumentBytes(reserved));
    expect(logicalDocumentBytes(abandoned)).toBeLessThanOrEqual(logicalDocumentBytes(reserved));

    const terminalEvent = {
      actorDeviceId: "d".repeat(32),
      createdAt: Number.MAX_SAFE_INTEGER,
      entityId: uuidV7("999"),
      event: "command_terminal" as const,
      userId: "u".repeat(32),
    };
    expect(logicalDocumentBytes({ ...terminalEvent, commandType: "session" }))
      .toBeGreaterThanOrEqual(logicalDocumentBytes(terminalEvent));
  });

  test("keeps physical command and security ledgers exact through both command lifecycles", async () => {
    const world = await lifecycleWorld();
    const sessionId = await insertReservedCommand(world, "session", "31");
    const deviceId = await insertReservedCommand(world, "device", "41");
    await assertPhysicalCategoryLedgers(world);

    await world.testRuntime.run(async (ctx) => {
      const session = await ctx.db.get(sessionId as Id<"sessionCommands">);
      const device = await ctx.db.get(deviceId as Id<"deviceCommands">);
      if (session === null || device === null) throw new Error("missing lifecycle command");
      await patchSessionCommandWithLifecycleCapacity(ctx, session, {
        boundAuthority: maximumAuthority,
        state: "prepared",
        updatedAt: world.now + 1,
      });
      await patchDeviceCommandWithLifecycleCapacity(ctx, device, {
        boundAuthority: maximumAuthority,
        state: "prepared",
        updatedAt: world.now + 1,
      });
    });
    await assertPhysicalCategoryLedgers(world);

    await world.testRuntime.run(async (ctx) => {
      const device = await ctx.db.get(deviceId as Id<"deviceCommands">);
      if (device === null) throw new Error("missing prepared device command");
      await patchDeviceCommandWithLifecycleCapacity(ctx, device, {
        boundAuthority: { bootGeneration: 1, bootId: "b", fence: 1 },
      });
      const shortened = await ctx.db.get(deviceId as Id<"deviceCommands">);
      if (shortened === null) throw new Error("missing shortened device authority");
      await patchDeviceCommandWithLifecycleCapacity(ctx, shortened, {
        boundAuthority: maximumAuthority,
      });
    });
    await assertPhysicalCategoryLedgers(world);

    await world.testRuntime.run(async (ctx) => {
      const session = await ctx.db.get(sessionId as Id<"sessionCommands">);
      const device = await ctx.db.get(deviceId as Id<"deviceCommands">);
      if (session === null || device === null) throw new Error("missing prepared command");
      await acknowledgeSessionCommandReceipt(ctx, session, {
        requesterAcknowledgedAt: world.now + 2,
      });
      await patchDeviceCommandWithLifecycleCapacity(ctx, device, {
        state: "effect_started",
        updatedAt: world.now + 2,
      });
    });
    await assertPhysicalCategoryLedgers(world);

    await world.testRuntime.run(async (ctx) => {
      const session = await ctx.db.get(sessionId as Id<"sessionCommands">);
      const device = await ctx.db.get(deviceId as Id<"deviceCommands">);
      if (session === null || device === null) throw new Error("missing command before terminal");
      await terminalizeSessionCommandWithLifecycleCapacity(ctx, session, {
        nonterminal: false,
        result: maximumSessionResult,
        resultCode: "R".repeat(64),
        resultDigest: "a".repeat(64),
        state: "applied",
        terminalCleanupAfter: world.now + 60_000,
        updatedAt: world.now + 3,
      }, {
        actorDeviceId: world.deviceId,
        createdAt: world.now + 3,
        entityId: session.publicId,
        event: "command_terminal",
        userId: world.userId,
      });
      await terminalizeDeviceCommandWithLifecycleCapacity(ctx, device, {
        nonterminal: false,
        result: maximumDeviceResult,
        resultCode: "R".repeat(64),
        resultDigest: "b".repeat(64),
        resultExpiresAt: world.now + 60_000,
        resultSingleUse: true,
        state: "applied",
        updatedAt: world.now + 3,
      }, {
        actorDeviceId: world.deviceId,
        createdAt: world.now + 3,
        entityId: device.publicId,
        event: "command_terminal",
        userId: world.userId,
      });
    });
    await assertPhysicalCategoryLedgers(world);

    await world.testRuntime.run(async (ctx) => {
      const device = await ctx.db.get(deviceId as Id<"deviceCommands">);
      if (device === null) throw new Error("missing terminal device command");
      expect(device.receiptCapacityReservation).toBe(commandReceiptCapacityReservation);
      await acknowledgeDeviceCommandReceipt(ctx, device, {
        requesterAcknowledgedAt: world.now + 4,
        terminalCleanupAfter: world.now + 60_004,
      });
    });
    await assertPhysicalCategoryLedgers(world);
  });

  test("rejects an underfunded lifecycle row before audit or command growth", async () => {
    for (const commandType of ["session", "device"] as const) {
      const world = await lifecycleWorld();
      const commandId = await insertReservedCommand(
        world,
        commandType,
        commandType === "session" ? "43" : "44",
      );
      const commandPublicId = await world.testRuntime.run(async (ctx) => {
        const command = commandType === "session"
          ? await ctx.db.get(commandId as Id<"sessionCommands">)
          : await ctx.db.get(commandId as Id<"deviceCommands">);
        if (command === null) throw new Error("missing underfunded command fixture");
        const reservation = await ctx.db.query("commandLifecycleReservations")
          .withIndex("by_command", (builder) => builder
            .eq("commandType", commandType)
            .eq("commandPublicId", command.publicId))
          .unique();
        if (reservation === null) throw new Error("missing lifecycle reservation fixture");
        await ctx.db.patch(reservation._id, { capacityReservation: "0" });
        return command.publicId;
      });
      await expect(world.testRuntime.query(auditReservationPage, {
        commandType,
        expectedRuntimeAttestation: trackedRuntimeAttestation,
        paginationOpts: { cursor: null, numItems: maximumCommandLifecycleBatch },
        state: "pending",
      })).rejects.toThrow("COMMAND_LIFECYCLE_RESERVATION_CORRUPT");
      await expect(world.testRuntime.run(async (ctx) => {
        if (commandType === "session") {
          const command = await ctx.db.get(commandId as Id<"sessionCommands">);
          if (command === null) throw new Error("missing session transition fixture");
          await patchSessionCommandWithLifecycleCapacity(ctx, command, {
            boundAuthority: maximumAuthority,
            state: "prepared",
          });
          return;
        }
        const command = await ctx.db.get(commandId as Id<"deviceCommands">);
        if (command === null) throw new Error("missing device transition fixture");
        await patchDeviceCommandWithLifecycleCapacity(ctx, command, {
          boundAuthority: maximumAuthority,
          state: "prepared",
        });
      })).rejects.toThrow("COMMAND_LIFECYCLE_RESERVATION_CORRUPT");
      expect(commandPublicId).toBeString();
    }
  });

  for (const commandType of ["session", "device"] as const) {
    test(`${commandType} terminalization succeeds at exact user, service, and security ceilings`, async () => {
      const world = await lifecycleWorld();
      const commandId = await insertReservedCommand(world, commandType, commandType === "session" ? "51" : "61", maximumPayload);
      await world.testRuntime.run(async (ctx) => {
        if (commandType === "session") {
          const command = await ctx.db.get(commandId as Id<"sessionCommands">);
          if (command === null) throw new Error("missing session ceiling command");
          await patchSessionCommandWithLifecycleCapacity(ctx, command, {
            boundAuthority: maximumAuthority,
            requesterAcknowledgedAt: world.now + 1,
            state: "effect_started",
            updatedAt: world.now + 1,
          });
          return;
        }
        const command = await ctx.db.get(commandId as Id<"deviceCommands">);
        if (command === null) throw new Error("missing device ceiling command");
        await patchDeviceCommandWithLifecycleCapacity(ctx, command, {
          boundAuthority: maximumAuthority,
          state: "effect_started",
          updatedAt: world.now + 1,
        });
      });
      await saturateUserAndServiceCeilings(world);
      expect(await usageCeilings(world)).toMatchObject({
        securityRecords: CATEGORY_QUOTAS.security.records,
        serviceBytes: SERVICE_TOTAL_QUOTA.logicalBytes,
        serviceRecords: SERVICE_TOTAL_QUOTA.records,
        userBytes: USER_TOTAL_QUOTA.logicalBytes,
      });

      await world.testRuntime.run(async (ctx) => {
        if (commandType === "session") {
          const command = await ctx.db.get(commandId as Id<"sessionCommands">);
          if (command === null) throw new Error("missing session ceiling command");
          await terminalizeSessionCommandWithLifecycleCapacity(ctx, command, {
            nonterminal: false,
            result: maximumSessionResult,
            resultCode: "R".repeat(64),
            resultDigest: "c".repeat(64),
            state: "applied",
            terminalCleanupAfter: world.now + 60_000,
            updatedAt: world.now + 2,
          }, {
            actorDeviceId: world.deviceId,
            createdAt: world.now + 2,
            entityId: command.publicId,
            event: "command_terminal",
            userId: world.userId,
          });
          return;
        }
        const command = await ctx.db.get(commandId as Id<"deviceCommands">);
        if (command === null) throw new Error("missing device ceiling command");
        await terminalizeDeviceCommandWithLifecycleCapacity(ctx, command, {
          nonterminal: false,
          result: maximumDeviceResult,
          resultCode: "R".repeat(64),
          resultDigest: "d".repeat(64),
          resultExpiresAt: world.now + 60_000,
          resultSingleUse: true,
          state: "applied",
          updatedAt: world.now + 2,
        }, {
          actorDeviceId: world.deviceId,
          createdAt: world.now + 2,
          entityId: command.publicId,
          event: "command_terminal",
          userId: world.userId,
        });
        const terminal = await ctx.db.get(commandId as Id<"deviceCommands">);
        if (terminal === null) throw new Error("missing device terminal receipt");
        await acknowledgeDeviceCommandReceipt(ctx, terminal, {
          requesterAcknowledgedAt: world.now + 3,
          terminalCleanupAfter: world.now + 60_003,
        });
      });
      const after = await usageCeilings(world);
      expect(after.securityRecords).toBe(CATEGORY_QUOTAS.security.records);
      expect(after.serviceBytes).toBeLessThanOrEqual(SERVICE_TOTAL_QUOTA.logicalBytes);
      expect(after.userBytes).toBeLessThanOrEqual(USER_TOTAL_QUOTA.logicalBytes);
    });
  }

  test("reserved device lifecycle survives consumed emergency headroom at every exact ceiling", async () => {
    const world = await lifecycleWorld();
    const commandId = await insertReservedCommand(world, "device", "6f", maximumPayload);
    const command = await world.testRuntime.run(async (ctx) => ctx.db.get(
      commandId as Id<"deviceCommands">,
    ));
    if (command === null) throw new Error("missing maximal public device command");
    // Exact hard saturation is stronger than one or more admitted authority
    // reductions: it places every ordinary user/service/category envelope
    // above its reserved threshold before any lifecycle transition.
    await saturateUserAndServiceCeilings(world);
    expect(await world.actor.mutation(prepareDeviceCommand, {
      authority: maximumAuthority,
      commandPublicId: command.publicId,
      executorRequestVersion: 2,
      localPhase: "prepared_no_effect",
    })).toMatchObject({ state: "prepared" });
    expect(await world.actor.mutation(markDeviceCommandEffectStarted, {
      authority: maximumAuthority,
      commandPublicId: command.publicId,
      executorRequestVersion: 2,
    })).toMatchObject({ state: "effect_started" });
    expect(await world.actor.mutation(settleDeviceCommand, {
      authority: maximumAuthority,
      commandPublicId: command.publicId,
      result: maximumDeviceResult,
      resultCode: "R".repeat(64),
      resultDigest: "d".repeat(64),
      singleUseResult: true,
      state: "applied",
    })).toMatchObject({ state: "applied" });
    expect(await world.testRuntime.run(async (ctx) => ctx.db.get(
      commandId as Id<"deviceCommands">,
    ))).toMatchObject({
      boundAuthority: maximumAuthority,
      nonterminal: false,
      result: maximumDeviceResult,
      state: "applied",
    });
  });

  test("unsafe legacy cleanup is normalized without deleting unobserved terminal evidence", async () => {
    const world = await lifecycleWorld();
    const fixtures = await world.testRuntime.run(async (ctx) => {
      const old = world.now - 60 * 24 * 60 * 60 * 1_000;
      const common = {
        createdAt: old,
        deadline: old + 60_000,
        nonterminal: false,
        payload: smallEnvelope,
        requestingDeviceId: world.deviceId,
        state: "applied" as const,
        targetDeviceId: world.deviceId,
        terminalCleanupAfter: old + COMMAND_TERMINAL_RETENTION_MS,
        updatedAt: old,
        userId: world.userId,
      };
      const resultSession = {
        ...common,
        idempotencyKey: uuidV7("8c1"),
        kind: "send" as const,
        publicId: uuidV7("8c2"),
        requestDigest: "c".repeat(64),
        result: smallEnvelope,
        resultCode: "APPLIED",
        resultDigest: "d".repeat(64),
        sessionId: world.sessionId,
      };
      const resultlessSession = {
        ...common,
        idempotencyKey: uuidV7("8d1"),
        kind: "stop" as const,
        publicId: uuidV7("8d2"),
        requestDigest: "e".repeat(64),
        sessionId: world.sessionId,
        state: "failed" as const,
      };
      const device = {
        ...common,
        idempotencyKey: uuidV7("8e1"),
        kind: "usage_refresh" as const,
        publicId: uuidV7("8e2"),
        requestDigest: "f".repeat(64),
      };
      for (const command of [resultSession, resultlessSession]) {
        await reserveQuotaForInsert(ctx, world.userId, "command", command);
        await ctx.db.insert("sessionCommands", command);
      }
      await reserveQuotaForInsert(ctx, world.userId, "command", device);
      await ctx.db.insert("deviceCommands", device);
      return {
        device: device.publicId,
        session: [resultSession.publicId, resultlessSession.publicId],
      };
    });
    await saturateUserAndServiceCeilings(world);
    expect(await world.testRuntime.query(auditTerminalReceiptCapacityPage, {
      commandType: "session",
      expectedRuntimeAttestation: trackedRuntimeAttestation,
      paginationOpts: { cursor: null, numItems: maximumCommandLifecycleBatch },
      state: "applied",
    })).toMatchObject({ unsafeCleanup: [fixtures.session[0]] });
    expect(await world.testRuntime.mutation(normalizeLegacyTerminalReceipt, {
      commandPublicId: fixtures.device,
      commandType: "device",
      expectedRuntimeAttestation: trackedRuntimeAttestation,
    })).toMatchObject({ state: "normalized" });
    await world.testRuntime.mutation(cleanupExpired, { limit: 8 });
    const retained = await world.testRuntime.run(async (ctx) => ({
      device: await ctx.db.query("deviceCommands")
        .withIndex("by_public_id", (builder) => builder.eq("publicId", fixtures.device))
        .unique(),
      sessions: await Promise.all(fixtures.session.map(async (publicId) =>
        await ctx.db.query("sessionCommands")
          .withIndex("by_public_id", (builder) => builder.eq("publicId", publicId))
          .unique())),
    }));
    expect(retained.device).not.toBeNull();
    expect(retained.device).not.toHaveProperty("terminalCleanupAfter");
    expect(retained.sessions).toHaveLength(2);
    for (const command of retained.sessions) {
      expect(command).not.toBeNull();
      expect(command).not.toHaveProperty("terminalCleanupAfter");
      expect(command).not.toHaveProperty("requesterAcknowledgedAt");
    }
  });

  test("audits and repairs legacy lifecycle and terminal receipt capacity in bounded pages", async () => {
    const world = await lifecycleWorld();
    const legacy = await world.testRuntime.run(async (ctx) => {
      const started = {
        boundAuthority: maximumAuthority,
        createdAt: world.now,
        deadline: world.now + 60_000,
        idempotencyKey: uuidV7("711"),
        kind: "send" as const,
        nonterminal: true,
        payload: smallEnvelope,
        publicId: uuidV7("712"),
        requestDigest: "7".repeat(64),
        requestingDeviceId: world.deviceId,
        sessionId: world.sessionId,
        state: "effect_started" as const,
        targetDeviceId: world.deviceId,
        updatedAt: world.now,
        userId: world.userId,
      };
      await reserveNonterminalCommandQuotaForInsert(ctx, world.userId, started);
      await ctx.db.insert("sessionCommands", started);
      const terminal = {
        createdAt: world.now,
        deadline: world.now + 60_000,
        idempotencyKey: uuidV7("721"),
        kind: "usage_refresh" as const,
        nonterminal: false,
        payload: smallEnvelope,
        publicId: uuidV7("722"),
        requestDigest: "8".repeat(64),
        requestingDeviceId: world.deviceId,
        state: "applied" as const,
        targetDeviceId: world.deviceId,
        updatedAt: world.now,
        userId: world.userId,
      };
      await reserveQuotaForInsert(ctx, world.userId, "command", terminal);
      await ctx.db.insert("deviceCommands", terminal);
      return { startedPublicId: started.publicId, terminalPublicId: terminal.publicId };
    });

    const effectAudit = await world.testRuntime.query(auditReservationPage, {
      commandType: "session",
      expectedRuntimeAttestation: trackedRuntimeAttestation,
      paginationOpts: { cursor: null, numItems: maximumCommandLifecycleBatch },
      state: "effect_started",
    });
    expect(effectAudit).toMatchObject({
      isDone: true,
      scanned: 1,
      unreserved: [legacy.startedPublicId],
    });
    expect(await world.testRuntime.mutation(reserveExisting, {
      commandPublicId: legacy.startedPublicId,
      commandType: "session",
      expectedRuntimeAttestation: trackedRuntimeAttestation,
    })).toMatchObject({ state: "reserved" });
    expect(await world.testRuntime.query(auditReservationPage, {
      commandType: "session",
      expectedRuntimeAttestation: trackedRuntimeAttestation,
      paginationOpts: { cursor: null, numItems: maximumCommandLifecycleBatch },
      state: "effect_started",
    })).toMatchObject({ unreserved: [] });

    expect(await world.testRuntime.query(auditTerminalReceiptCapacityPage, {
      commandType: "device",
      expectedRuntimeAttestation: trackedRuntimeAttestation,
      paginationOpts: { cursor: null, numItems: maximumCommandLifecycleBatch },
      state: "applied",
    })).toMatchObject({ unreserved: [legacy.terminalPublicId] });
    expect(await world.testRuntime.mutation(reserveExistingTerminalReceipt, {
      commandPublicId: legacy.terminalPublicId,
      commandType: "device",
      expectedRuntimeAttestation: trackedRuntimeAttestation,
    })).toMatchObject({ state: "reserved" });
    expect(await world.testRuntime.query(auditTerminalReceiptCapacityPage, {
      commandType: "device",
      expectedRuntimeAttestation: trackedRuntimeAttestation,
      paginationOpts: { cursor: null, numItems: maximumCommandLifecycleBatch },
      state: "applied",
    })).toMatchObject({ unreserved: [] });
    await world.testRuntime.run(async (ctx) => {
      const command = await ctx.db.query("deviceCommands")
        .withIndex("by_public_id", (builder) => builder.eq("publicId", legacy.terminalPublicId))
        .unique();
      if (command === null) throw new Error("missing repaired terminal receipt");
      await acknowledgeDeviceCommandReceipt(ctx, command, {
        requesterAcknowledgedAt: world.now + 1,
        terminalCleanupAfter: world.now + 60_001,
      });
    });
    const acknowledgedTerminal = await world.testRuntime.run(async (ctx) => await ctx.db.query("deviceCommands")
      .withIndex("by_public_id", (builder) => builder.eq("publicId", legacy.terminalPublicId))
      .unique());
    expect(acknowledgedTerminal).toMatchObject({
        requesterAcknowledgedAt: world.now + 1,
        terminalCleanupAfter: world.now + 60_001,
      });
    expect(acknowledgedTerminal).not.toHaveProperty("receiptCapacityReservation");

    await expect(world.testRuntime.query(auditReservationPage, {
      commandType: "session",
      expectedRuntimeAttestation: trackedRuntimeAttestation,
      paginationOpts: { cursor: null, numItems: maximumCommandLifecycleBatch + 1 },
      state: "effect_started",
    })).rejects.toThrow("COMMAND_LIFECYCLE_RESERVATION_CORRUPT");
    await expect(world.testRuntime.query(auditDirectTablePage, {
      paginationOpts: { cursor: null, numItems: maximumCommandLifecycleBatch + 1 },
      table: "commandLifecycleReservations",
      userId: world.userId,
    })).rejects.toThrow("QUOTA_AUTHORITY_CORRUPT");
    expect(await world.testRuntime.query(auditDirectTablePage, {
      paginationOpts: { cursor: null, numItems: maximumCommandLifecycleBatch },
      table: "commandLifecycleReservations",
      userId: world.userId,
    })).toMatchObject({ category: "command", records: 1 });
  });

  test("legacy rows acquire reservations before growth and fail closed on partial authority", async () => {
    const world = await lifecycleWorld();
    const commandId = await world.testRuntime.run(async (ctx) => {
      const command = {
        createdAt: world.now,
        deadline: world.now + 60_000,
        idempotencyKey: uuidV7("811"),
        kind: "usage_refresh" as const,
        nonterminal: true,
        payload: smallEnvelope,
        publicId: uuidV7("812"),
        requestDigest: "9".repeat(64),
        requestingDeviceId: world.deviceId,
        state: "pending" as const,
        targetDeviceId: world.deviceId,
        updatedAt: world.now,
        userId: world.userId,
      };
      await reserveNonterminalCommandQuotaForInsert(ctx, world.userId, command);
      return await ctx.db.insert("deviceCommands", command);
    });
    await world.testRuntime.run(async (ctx) => {
      const command = await ctx.db.get(commandId);
      if (command === null) throw new Error("missing legacy pending command");
      await patchDeviceCommandWithLifecycleCapacity(ctx, command, {
        boundAuthority: maximumAuthority,
        state: "prepared",
      });
    });
    expect(await world.testRuntime.query(auditReservationPage, {
      commandType: "device",
      expectedRuntimeAttestation: trackedRuntimeAttestation,
      paginationOpts: { cursor: null, numItems: maximumCommandLifecycleBatch },
      state: "prepared",
    })).toMatchObject({ unreserved: [] });

    await world.testRuntime.run(async (ctx) => {
      const command = await ctx.db.get(commandId);
      if (command === null) throw new Error("missing prepared command");
      const security = await ctx.db.query("commandTerminalSecurityReservations")
        .withIndex("by_command", (builder) => builder
          .eq("commandType", "device")
          .eq("entityId", command.publicId))
        .unique();
      if (security === null) throw new Error("missing security reservation");
      await ctx.db.delete(security._id);
    });
    await expect(world.testRuntime.run(async (ctx) => {
      const command = await ctx.db.get(commandId);
      if (command === null) throw new Error("missing partial-authority command");
      await patchDeviceCommandWithLifecycleCapacity(ctx, command, {
        state: "effect_started",
      });
    })).rejects.toThrow("COMMAND_LIFECYCLE_RESERVATION_CORRUPT");
    expect(await world.testRuntime.run(async (ctx) => await ctx.db.get(commandId)))
      .toMatchObject({ state: "prepared" });
  });

  for (const commandType of ["session", "device"] as const) {
    test(`${commandType} revoked legacy effect repair emits the reserved terminal audit event`, async () => {
      const world = await lifecycleWorld();
      const legacy = await insertLegacyEffectStarted(
        world,
        commandType,
        commandType === "session" ? "8a" : "8b",
      );
      await world.testRuntime.run(async (ctx) => {
        const requester = await ctx.db.get(world.deviceId);
        if (requester === null) throw new Error("missing requester for revoked repair");
        const patch = { revokedAt: world.now, status: "revoked" as const };
        await adjustQuotaForPatch(ctx, world.userId, "device", requester, patch);
        await ctx.db.patch(requester._id, patch);
      });
      expect(await world.testRuntime.mutation(reserveExisting, {
        commandPublicId: legacy.publicId,
        commandType,
        expectedRuntimeAttestation: trackedRuntimeAttestation,
      })).toMatchObject({ state: "terminalized" });
      const snapshot = await world.testRuntime.run(async (ctx) => ({
        command: commandType === "session"
          ? await ctx.db.get(legacy.commandId as Id<"sessionCommands">)
          : await ctx.db.get(legacy.commandId as Id<"deviceCommands">),
        lifecycle: await ctx.db.query("commandLifecycleReservations").collect(),
        security: await ctx.db.query("commandTerminalSecurityReservations").collect(),
        terminal: await ctx.db.query("securityEvents")
          .withIndex("by_user_entity_and_event", (builder) => builder
            .eq("userId", world.userId)
            .eq("entityId", legacy.publicId)
            .eq("event", "command_terminal"))
          .unique(),
      }));
      expect(snapshot.command).toMatchObject({
        nonterminal: false,
        state: "ambiguous",
      });
      expect(snapshot.command?.requesterReceiptAbandonedAt).toBeNumber();
      expect(snapshot.command).not.toHaveProperty("receiptCapacityReservation");
      expect(snapshot.lifecycle).toEqual([]);
      expect(snapshot.security).toEqual([]);
      expect(snapshot.terminal).toMatchObject({
        actorDeviceId: world.deviceId,
        entityId: legacy.publicId,
        event: "command_terminal",
      });
      await assertPhysicalCategoryLedgers(world);
    });
  }

  for (const commandType of ["session", "device"] as const) {
    test(`${commandType} pair without marker remains audit debt until the marker is repaired`, async () => {
      const world = await lifecycleWorld();
      const commandId = await insertReservedCommand(
        world,
        commandType,
        commandType === "session" ? "81" : "82",
      );
      await world.testRuntime.run(async (ctx) => {
        const command = commandType === "session"
          ? await ctx.db.get(commandId as Id<"sessionCommands">)
          : await ctx.db.get(commandId as Id<"deviceCommands">);
        if (command === null) throw new Error("missing marker fixture");
        const prepared = { boundAuthority: maximumAuthority, state: "effect_started" as const };
        if (commandType === "session") {
          await patchSessionCommandWithLifecycleCapacity(
            ctx,
            command as DataModel["sessionCommands"]["document"],
            prepared,
          );
        } else {
          await patchDeviceCommandWithLifecycleCapacity(
            ctx,
            command as DataModel["deviceCommands"]["document"],
            prepared,
          );
        }
        const current = commandType === "session"
          ? await ctx.db.get(commandId as Id<"sessionCommands">)
          : await ctx.db.get(commandId as Id<"deviceCommands">);
        if (current === null) throw new Error("missing prepared marker fixture");
        const markerPatch = { lifecycleCapacityVersion: undefined };
        await adjustCommandQuotaForPatch(ctx, world.userId, current, markerPatch);
        await ctx.db.patch(current._id, markerPatch);
      });
      const command = await world.testRuntime.run(async (ctx) => commandType === "session"
        ? await ctx.db.get(commandId as Id<"sessionCommands">)
        : await ctx.db.get(commandId as Id<"deviceCommands">));
      if (command === null) throw new Error("missing markerless command");
      expect(await world.testRuntime.query(auditReservationPage, {
        commandType,
        expectedRuntimeAttestation: trackedRuntimeAttestation,
        paginationOpts: { cursor: null, numItems: maximumCommandLifecycleBatch },
        state: "effect_started",
      })).toMatchObject({ unreserved: [command.publicId] });
      expect(await world.testRuntime.mutation(reserveExisting, {
        commandPublicId: command.publicId,
        commandType,
        expectedRuntimeAttestation: trackedRuntimeAttestation,
      })).toMatchObject({ state: "reserved" });
      expect(await world.testRuntime.query(auditReservationPage, {
        commandType,
        expectedRuntimeAttestation: trackedRuntimeAttestation,
        paginationOpts: { cursor: null, numItems: maximumCommandLifecycleBatch },
        state: "effect_started",
      })).toMatchObject({ unreserved: [] });
      const listing = commandType === "session"
        ? await world.actor.query(listCapacitySessionCommands, {
            paginationOpts: { cursor: null, numItems: maximumCommandLifecycleBatch },
          })
        : await world.actor.query(listCapacityDeviceCommands, {
            limit: maximumCommandLifecycleBatch,
          });
      expect(listing).toMatchObject({ page: [{ lifecycleCapacityReady: true }] });
    });
  }

  test("capacity-aware command discovery is additive, exact-key compatible, and bounded to eight rows", async () => {
    const world = await lifecycleWorld();
    const sessionId = await insertReservedCommand(world, "session", "83");
    const deviceId = await insertReservedCommand(world, "device", "84");
    await world.testRuntime.run(async (ctx) => {
      const device = await ctx.db.get(deviceId as Id<"deviceCommands">);
      if (device === null) throw new Error("missing recoverable device fixture");
      await patchDeviceCommandWithLifecycleCapacity(ctx, device, {
        boundAuthority: maximumAuthority,
        state: "prepared",
      });
    });
    const oldSession = await world.actor.query(listLegacySessionCommands, {
      paginationOpts: { cursor: null, numItems: 9 },
    }) as Readonly<{ page: readonly Readonly<Record<string, unknown>>[] }>;
    const oldDevice = await world.actor.query(listLegacyDeviceCommands, {
      paginationOpts: { cursor: null, numItems: 9 },
    }) as Readonly<{ page: readonly Readonly<Record<string, unknown>>[] }>;
    expect(oldSession.page).toHaveLength(1);
    expect(oldDevice.page).toHaveLength(1);
    expect(oldSession.page[0]).not.toHaveProperty("lifecycleCapacityReady");
    expect(oldDevice.page[0]).not.toHaveProperty("lifecycleCapacityReady");
    await expect(world.actor.query(listCapacitySessionCommands, {
      paginationOpts: { cursor: null, numItems: 9 },
    })).rejects.toThrow("Cloud authority is not current.");
    await expect(world.actor.query(listCapacityDeviceCommands, { limit: 9 }))
      .rejects.toThrow("Cloud authority is not current.");
    expect(await world.actor.query(listCapacitySessionCommands, {
      paginationOpts: { cursor: null, numItems: maximumCommandLifecycleBatch },
    })).toMatchObject({ page: [{ lifecycleCapacityReady: true }] });
    expect(await world.actor.query(listCapacityDeviceCommands, {
      limit: maximumCommandLifecycleBatch,
    })).toMatchObject({ page: [{ lifecycleCapacityReady: true }] });
    expect(sessionId).toBeString();
  });

  test("a legacy pending row without headroom cannot cross the effect boundary", async () => {
    const world = await lifecycleWorld();
    const commandId = await world.testRuntime.run(async (ctx) => {
      const command = {
        createdAt: world.now,
        deadline: world.now + 60_000,
        idempotencyKey: uuidV7("911"),
        kind: "send" as const,
        nonterminal: true,
        payload: smallEnvelope,
        publicId: uuidV7("912"),
        requestDigest: "c".repeat(64),
        requestingDeviceId: world.deviceId,
        sessionId: world.sessionId,
        state: "pending" as const,
        targetDeviceId: world.deviceId,
        updatedAt: world.now,
        userId: world.userId,
      };
      await reserveNonterminalCommandQuotaForInsert(ctx, world.userId, command);
      return await ctx.db.insert("sessionCommands", command);
    });
    await saturateUserAndServiceCeilings(world);
    await expect(world.testRuntime.run(async (ctx) => {
      const command = await ctx.db.get(commandId);
      if (command === null) throw new Error("missing no-headroom command");
      await patchSessionCommandWithLifecycleCapacity(ctx, command, {
        boundAuthority: maximumAuthority,
        state: "prepared",
      });
    })).rejects.toThrow("QUOTA_EXCEEDED");
    expect(await world.testRuntime.run(async (ctx) => ({
      command: await ctx.db.get(commandId),
      lifecycle: await ctx.db.query("commandLifecycleReservations").collect(),
      security: await ctx.db.query("commandTerminalSecurityReservations").collect(),
    }))).toMatchObject({
      command: { state: "pending" },
      lifecycle: [],
      security: [],
    });
  });

  test("expired legacy no-effect rows retire non-growingly at exact quota, including enqueue-acked device pending", async () => {
    const world = await lifecycleWorld();
    const fixtures = await world.testRuntime.run(async (ctx) => {
      const common = {
        createdAt: world.now - 120_000,
        deadline: world.now - 60_000,
        nonterminal: true,
        payload: smallEnvelope,
        requestingDeviceId: world.deviceId,
        targetDeviceId: world.deviceId,
        updatedAt: world.now - 120_000,
        userId: world.userId,
      };
      const sessionPending = {
        ...common,
        idempotencyKey: uuidV7("9a1"),
        kind: "send" as const,
        publicId: uuidV7("9a2"),
        requestDigest: "a".repeat(64),
        sessionId: world.sessionId,
        state: "pending" as const,
      };
      const sessionPrepared = {
        ...common,
        boundAuthority: maximumAuthority,
        idempotencyKey: uuidV7("9b1"),
        kind: "stop" as const,
        publicId: uuidV7("9b2"),
        requesterAcknowledgedAt: world.now - 90_000,
        requestDigest: "b".repeat(64),
        sessionId: world.sessionId,
        state: "prepared" as const,
      };
      const devicePending = {
        ...common,
        idempotencyKey: uuidV7("9c1"),
        kind: "usage_refresh" as const,
        publicId: uuidV7("9c2"),
        requesterAcknowledgedAt: world.now - 90_000,
        requestDigest: "c".repeat(64),
        state: "pending" as const,
      };
      const devicePrepared = {
        ...common,
        boundAuthority: maximumAuthority,
        idempotencyKey: uuidV7("9d1"),
        kind: "usage_refresh" as const,
        publicId: uuidV7("9d2"),
        requesterAcknowledgedAt: world.now - 90_000,
        requestDigest: "d".repeat(64),
        state: "prepared" as const,
      };
      for (const command of [sessionPending, sessionPrepared]) {
        await reserveNonterminalCommandQuotaForInsert(ctx, world.userId, command);
        await ctx.db.insert("sessionCommands", command);
      }
      for (const command of [devicePending, devicePrepared]) {
        await reserveNonterminalCommandQuotaForInsert(ctx, world.userId, command);
        await ctx.db.insert("deviceCommands", command);
      }
      return {
        device: [devicePending.publicId, devicePrepared.publicId],
        session: [sessionPending.publicId, sessionPrepared.publicId],
      };
    });
    for (const commandType of ["session", "device"] as const) {
      for (const state of ["pending", "prepared"] as const) {
        const commandPublicId = fixtures[commandType][state === "pending" ? 0 : 1];
        if (commandPublicId === undefined) throw new Error("missing no-effect fixture");
        const audit = await world.testRuntime.query(auditReservationPage, {
          commandType,
          expectedRuntimeAttestation: trackedRuntimeAttestation,
          paginationOpts: { cursor: null, numItems: maximumCommandLifecycleBatch },
          state,
        });
        expect(audit.noEffectRetirement).toEqual([{
          commandPublicId,
          status: "eligible",
        }]);
      }
    }
    await saturateUserAndServiceCeilings(world);
    const before = await usageCeilings(world);
    for (const commandType of ["session", "device"] as const) {
      for (const commandPublicId of fixtures[commandType]) {
        expect(await world.testRuntime.mutation(retireLegacyNoEffectExpired, {
          acknowledgement: "RETIRE_LEGACY_NO_EFFECT_AS_EXPIRED",
          commandPublicId,
          commandType,
          expectedRuntimeAttestation: trackedRuntimeAttestation,
        })).toMatchObject({ state: "retired" });
        expect(await world.testRuntime.mutation(retireLegacyNoEffectExpired, {
          acknowledgement: "RETIRE_LEGACY_NO_EFFECT_AS_EXPIRED",
          commandPublicId,
          commandType,
          expectedRuntimeAttestation: trackedRuntimeAttestation,
        })).toMatchObject({ state: "exact" });
      }
      const preparedPublicId = fixtures[commandType][1];
      if (preparedPublicId === undefined) throw new Error("missing prepared no-effect fixture");
      expect(await world.actor.mutation(
        commandType === "session"
          ? confirmSessionTerminalRecovery
          : confirmDeviceTerminalRecovery,
        {
          commandPublicId: preparedPublicId,
          localPhase: "effect_started",
          staleAuthority: maximumAuthority,
        },
      )).toMatchObject({ replay: true, state: "expired" });
    }
    const after = await usageCeilings(world);
    expect(after.userBytes).toBeLessThanOrEqual(before.userBytes);
    expect(after.serviceBytes).toBeLessThanOrEqual(before.serviceBytes ?? 0);
    expect(await world.testRuntime.query(auditTerminalReceiptCapacityPage, {
      commandType: "device",
      expectedRuntimeAttestation: trackedRuntimeAttestation,
      paginationOpts: { cursor: null, numItems: maximumCommandLifecycleBatch },
      state: "expired",
    })).toMatchObject({ unreserved: [] });
    const commands = await world.testRuntime.run(async (ctx) => ({
      device: await ctx.db.query("deviceCommands").collect(),
      session: await ctx.db.query("sessionCommands").collect(),
    }));
    expect([...commands.device, ...commands.session].every((command) =>
      !command.nonterminal && command.state === "expired")).toBe(true);
    expect(commands.device.every((command) =>
      command.requesterAcknowledgedAt !== undefined
      && command.terminalCleanupAfter === undefined)).toBe(true);

    // The non-growing compatibility terminal keeps no cleanup timestamp, but
    // its exact shape is still bounded by the normal 30-day terminal retention
    // clock. It must not disappear early, including at an exact quota ceiling.
    await world.testRuntime.mutation(cleanupExpired, { limit: 8 });
    expect(await world.testRuntime.run(async (ctx) => ({
      device: await ctx.db.query("deviceCommands").collect(),
      session: await ctx.db.query("sessionCommands").collect(),
    }))).toMatchObject({ device: [{ state: "expired" }, { state: "expired" }], session: [
      { state: "expired" },
      { state: "expired" },
    ] });
    await world.testRuntime.run(async (ctx) => {
      const old = world.now - COMMAND_TERMINAL_RETENTION_MS - 1;
      for (const command of await ctx.db.query("sessionCommands").collect()) {
        const patch = { updatedAt: old };
        await adjustCommandQuotaForPatch(ctx, world.userId, command, patch);
        await ctx.db.patch(command._id, patch);
      }
      for (const command of await ctx.db.query("deviceCommands").collect()) {
        const patch = { updatedAt: old };
        await adjustCommandQuotaForPatch(ctx, world.userId, command, patch);
        await ctx.db.patch(command._id, patch);
      }
      const maintenance = await ctx.db.query("maintenanceState").unique();
      if (maintenance === null) throw new Error("missing maintenance cursor fixture");
      await ctx.db.patch(maintenance._id, { nextCategory: "terminal_commands" });
    });
    expect(await world.testRuntime.mutation(cleanupExpired, { limit: 8 }))
      .toMatchObject({ terminalCommands: 2, terminalDeviceCommands: 0 });
    expect(await world.testRuntime.mutation(cleanupExpired, { limit: 8 }))
      .toMatchObject({ terminalCommands: 0, terminalDeviceCommands: 2 });
    const retained = await world.testRuntime.run(async (ctx) => ({
      device: await ctx.db.query("deviceCommands").collect(),
      session: await ctx.db.query("sessionCommands").collect(),
    }));
    const sessionPendingPublicId = fixtures.session[0];
    if (sessionPendingPublicId === undefined) throw new Error("missing session pending fixture");
    expect(retained.device).toEqual([]);
    expect(retained.session).toMatchObject([{ publicId: sessionPendingPublicId, state: "expired" }]);
    expect(retained.session[0]).not.toHaveProperty("requesterAcknowledgedAt");
    await releaseSyntheticByteHeadroom(
      world,
      2_048,
      0,
    );
    expect(await world.actor.mutation(acknowledgeSessionReceipt, {
      commandPublicId: sessionPendingPublicId,
      idempotencyKey: uuidV7("9a1"),
      requestDigest: "a".repeat(64),
    })).toMatchObject({ publicId: sessionPendingPublicId, replay: false });
    await world.testRuntime.run(async (ctx) => {
      const command = await ctx.db.query("sessionCommands")
        .withIndex("by_public_id", (builder) => builder.eq("publicId", sessionPendingPublicId))
        .unique();
      if (command === null) throw new Error("missing acknowledged no-effect receipt");
      const patch = { terminalCleanupAfter: world.now - 1 };
      await adjustCommandQuotaForPatch(ctx, world.userId, command, patch);
      await ctx.db.patch(command._id, patch);
      const maintenance = await ctx.db.query("maintenanceState").unique();
      if (maintenance === null) throw new Error("missing maintenance cursor fixture");
      await ctx.db.patch(maintenance._id, { nextCategory: "terminal_commands" });
    });
    expect(await world.testRuntime.mutation(cleanupExpired, { limit: 1 }))
      .toMatchObject({ terminalCommands: 1 });
    expect(await world.testRuntime.run(async (ctx) => ctx.db.query("sessionCommands").collect()))
      .toEqual([]);
  });

  test("acknowledged no-effect cleanup skips unrelated legacy terminal shapes without head-of-line failure", async () => {
    const world = await lifecycleWorld();
    const ids = await world.testRuntime.run(async (ctx) => {
      const old = world.now - COMMAND_TERMINAL_RETENTION_MS - 1;
      const common = {
        createdAt: old,
        deadline: old + 1,
        nonterminal: false,
        payload: smallEnvelope,
        requesterAcknowledgedAt: old,
        requestingDeviceId: world.deviceId,
        state: "expired" as const,
        targetDeviceId: world.deviceId,
        updatedAt: old,
        userId: world.userId,
      };
      const blocker = {
        ...common,
        idempotencyKey: uuidV7("9f1"),
        kind: "send" as const,
        publicId: uuidV7("9f2"),
        requestDigest: "1".repeat(64),
        result: smallEnvelope,
        resultCode: "LEGACY_RESULT",
        resultDigest: "2".repeat(64),
        sessionId: world.sessionId,
        terminalCleanupAfter: world.now + COMMAND_TERMINAL_RETENTION_MS,
      };
      const eligible = {
        ...common,
        idempotencyKey: uuidV7("9f3"),
        kind: "stop" as const,
        publicId: uuidV7("9f4"),
        requestDigest: "3".repeat(64),
        sessionId: world.sessionId,
      };
      await reserveQuotaForInsert(ctx, world.userId, "command", blocker);
      const blockerId = await ctx.db.insert("sessionCommands", blocker);
      await reserveQuotaForInsert(ctx, world.userId, "command", eligible);
      const eligibleId = await ctx.db.insert("sessionCommands", eligible);
      return { blockerId, eligibleId };
    });
    await world.testRuntime.run(async (ctx) => {
      const maintenance = await ctx.db.query("maintenanceState").unique();
      if (maintenance === null) {
        await ctx.db.insert("maintenanceState", {
          key: "retention",
          nextCategory: "terminal_commands",
          updatedAt: world.now,
        });
      } else {
        await ctx.db.patch(maintenance._id, { nextCategory: "terminal_commands" });
      }
    });
    expect(await world.testRuntime.mutation(cleanupExpired, { limit: 8 }))
      .toMatchObject({ terminalCommands: 1 });
    expect(await world.testRuntime.run(async (ctx) => ({
      blocker: await ctx.db.get(ids.blockerId),
      eligible: await ctx.db.get(ids.eligibleId),
    }))).toMatchObject({ blocker: { resultCode: "LEGACY_RESULT" }, eligible: null });
  });

  test("acknowledged no-effect cleanup paginates without rewriting receipt timestamps", async () => {
    const world = await lifecycleWorld();
    const fixture = await world.testRuntime.run(async (ctx) => {
      const old = world.now - COMMAND_TERMINAL_RETENTION_MS - 1;
      const acknowledgements: number[] = [];
      for (let index = 0; index < maximumCommandLifecycleBatch; index += 1) {
        const requesterAcknowledgedAt = world.now - 200_000 + index;
        acknowledgements.push(requesterAcknowledgedAt);
        const command = {
          createdAt: old,
          deadline: old + 1,
          idempotencyKey: uuidV7(`a${index}1`),
          kind: "stop" as const,
          nonterminal: false,
          payload: smallEnvelope,
          publicId: uuidV7(`a${index}2`),
          requesterAcknowledgedAt,
          requestDigest: index.toString(16).padStart(64, "0"),
          requestingDeviceId: world.deviceId,
          sessionId: world.sessionId,
          state: "expired" as const,
          targetDeviceId: world.deviceId,
          updatedAt: world.now,
          userId: world.userId,
        };
        await reserveQuotaForInsert(ctx, world.userId, "command", command);
        await ctx.db.insert("sessionCommands", command);
      }
      const eligible = {
        createdAt: old,
        deadline: old + 1,
        idempotencyKey: uuidV7("af1"),
        kind: "stop" as const,
        nonterminal: false,
        payload: smallEnvelope,
        publicId: uuidV7("af2"),
        requesterAcknowledgedAt: world.now - 100_000,
        requestDigest: "f".repeat(64),
        requestingDeviceId: world.deviceId,
        sessionId: world.sessionId,
        state: "expired" as const,
        targetDeviceId: world.deviceId,
        updatedAt: old,
        userId: world.userId,
      };
      await reserveQuotaForInsert(ctx, world.userId, "command", eligible);
      await ctx.db.insert("sessionCommands", eligible);
      const securityEvent = {
        actorDeviceId: world.deviceId,
        createdAt: world.now - (91 * 24 * 60 * 60 * 1_000),
        entityId: "retention_rotation_probe",
        event: "device_registered" as const,
        userId: world.userId,
      };
      await reserveQuotaForInsert(ctx, world.userId, "security", securityEvent);
      await ctx.db.insert("securityEvents", securityEvent);
      await ctx.db.insert("maintenanceState", {
        key: "retention",
        nextCategory: "terminal_commands",
        updatedAt: world.now,
      });
      return { acknowledgements, eligiblePublicId: eligible.publicId };
    });
    expect(await world.testRuntime.mutation(cleanupExpired, { limit: 8 })).toMatchObject({
      nextCategory: "pending_device_commands",
      processed: 8,
      terminalCommands: 8,
    });
    expect((await world.testRuntime.run(async (ctx) =>
      await ctx.db.query("sessionCommands").collect()))
      .filter((command) => command.publicId !== fixture.eligiblePublicId)
      .map((command) => command.requesterAcknowledgedAt)
      .sort((left, right) => (left ?? 0) - (right ?? 0)))
      .toEqual(fixture.acknowledgements);
    expect(await world.testRuntime.mutation(cleanupExpired, { limit: 8 })).toMatchObject({
      processed: 2,
      securityEvents: 1,
      terminalCommands: 1,
    });
    expect(await world.testRuntime.run(async (ctx) => ctx.db.query("sessionCommands")
      .withIndex("by_public_id", (builder) => builder.eq("publicId", fixture.eligiblePublicId))
      .unique())).toBeNull();
  });

  test("paired pre-rollout no-effect rows with one cross-table public id remain independently retireable", async () => {
    const world = await lifecycleWorld();
    const publicId = uuidV7("9e2");
    await world.testRuntime.run(async (ctx) => {
      const common = {
        createdAt: world.now - 120_000,
        deadline: world.now - 60_000,
        nonterminal: true,
        payload: smallEnvelope,
        publicId,
        requestingDeviceId: world.deviceId,
        state: "pending" as const,
        targetDeviceId: world.deviceId,
        updatedAt: world.now - 120_000,
        userId: world.userId,
      };
      const session = {
        ...common,
        idempotencyKey: uuidV7("9e3"),
        kind: "send" as const,
        requestDigest: "e".repeat(64),
        sessionId: world.sessionId,
      };
      const device = {
        ...common,
        idempotencyKey: uuidV7("9e4"),
        kind: "usage_refresh" as const,
        requesterAcknowledgedAt: world.now - 90_000,
        requestDigest: "f".repeat(64),
      };
      await reserveNonterminalCommandQuotaForInsert(ctx, world.userId, session);
      await ctx.db.insert("sessionCommands", session);
      await reserveNonterminalCommandQuotaForInsert(ctx, world.userId, device);
      await ctx.db.insert("deviceCommands", device);
    });
    await saturateUserAndServiceCeilings(world);
    for (const commandType of ["session", "device"] as const) {
      expect(await world.testRuntime.mutation(retireLegacyNoEffectExpired, {
        acknowledgement: "RETIRE_LEGACY_NO_EFFECT_AS_EXPIRED",
        commandPublicId: publicId,
        commandType,
        expectedRuntimeAttestation: trackedRuntimeAttestation,
      })).toMatchObject({ state: "retired" });
    }
    expect(await world.testRuntime.run(async (ctx) => ({
      device: await ctx.db.query("deviceCommands").withIndex(
        "by_public_id",
        (builder) => builder.eq("publicId", publicId),
      ).unique(),
      session: await ctx.db.query("sessionCommands").withIndex(
        "by_public_id",
        (builder) => builder.eq("publicId", publicId),
      ).unique(),
    }))).toMatchObject({
      device: { nonterminal: false, state: "expired" },
      session: { nonterminal: false, state: "expired" },
    });
  });

  for (const commandType of ["session", "device"] as const) {
    test(`${commandType} legacy terminal acknowledgement fails closed at the ceiling and retries with actual headroom`, async () => {
      const world = await lifecycleWorld();
      const commandId = await world.testRuntime.run(async (ctx) => {
        const common = {
          createdAt: world.now,
          deadline: world.now + 60_000,
          idempotencyKey: uuidV7(commandType === "session" ? "e11" : "e21"),
          nonterminal: false,
          payload: smallEnvelope,
          publicId: uuidV7(commandType === "session" ? "e12" : "e22"),
          requestDigest: (commandType === "session" ? "1" : "2").repeat(64),
          requestingDeviceId: world.deviceId,
          state: "applied" as const,
          targetDeviceId: world.deviceId,
          updatedAt: world.now,
          userId: world.userId,
        };
        if (commandType === "session") {
          const command = { ...common, kind: "send" as const, sessionId: world.sessionId };
          await reserveQuotaForInsert(ctx, world.userId, "command", command);
          return await ctx.db.insert("sessionCommands", command);
        }
        const command = { ...common, kind: "usage_refresh" as const };
        await reserveQuotaForInsert(ctx, world.userId, "command", command);
        return await ctx.db.insert("deviceCommands", command);
      });
      await saturateUserAndServiceCeilings(world);
      const acknowledge = async () => await world.testRuntime.run(async (ctx) => {
        const command = commandType === "session"
          ? await ctx.db.get(commandId as Id<"sessionCommands">)
          : await ctx.db.get(commandId as Id<"deviceCommands">);
        if (command === null) throw new Error("missing legacy terminal command");
        const patch = {
          requesterAcknowledgedAt: world.now + 1,
          terminalCleanupAfter: world.now + COMMAND_TERMINAL_RETENTION_MS + 1,
        };
        if (commandType === "session") {
          await acknowledgeSessionCommandReceipt(ctx, command as DataModel["sessionCommands"]["document"], patch);
        } else {
          await acknowledgeDeviceCommandReceipt(ctx, command as DataModel["deviceCommands"]["document"], patch);
        }
      });
      await expect(acknowledge()).rejects.toThrow("QUOTA_EXCEEDED");
      expect(await world.testRuntime.run(async (ctx) => await ctx.db.get(commandId as never)))
        .not.toHaveProperty("requesterAcknowledgedAt");
      await releaseSyntheticByteHeadroom(
        world,
        1_024,
        0,
      );
      await acknowledge();
      expect(await world.testRuntime.run(async (ctx) => await ctx.db.get(commandId as never)))
        .toMatchObject({
          requesterAcknowledgedAt: world.now + 1,
          terminalCleanupAfter: world.now + COMMAND_TERMINAL_RETENTION_MS + 1,
        });
    });
  }

  for (const commandType of ["session", "device"] as const) {
    test(`${commandType} pre-marker effect settlement charges only actual growth`, async () => {
      const world = await lifecycleWorld();
      const legacy = await insertLegacyEffectStarted(
        world,
        commandType,
        commandType === "session" ? "f1" : "f2",
      );
      await saturateUserAndServiceCeilings(world);
      // This is deliberately far below either 24 KiB or 352 KiB reservation,
      // but comfortably above the small real terminal result/event delta.
      await releaseSyntheticByteHeadroom(
        world,
        2_048,
        1,
      );
      await world.testRuntime.run(async (ctx) => {
        const command = commandType === "session"
          ? await ctx.db.get(legacy.commandId as Id<"sessionCommands">)
          : await ctx.db.get(legacy.commandId as Id<"deviceCommands">);
        if (command === null) throw new Error("missing legacy effect command");
        const patch = {
          nonterminal: false,
          result: smallEnvelope,
          resultCode: "APPLIED",
          resultDigest: "a".repeat(64),
          state: "applied" as const,
          updatedAt: world.now + 1,
        };
        const security = {
          actorDeviceId: world.deviceId,
          createdAt: world.now + 1,
          entityId: legacy.publicId,
          event: "command_terminal" as const,
          userId: world.userId,
        };
        if (commandType === "session") {
          await terminalizeSessionCommandWithLifecycleCapacity(
            ctx,
            command as DataModel["sessionCommands"]["document"],
            patch,
            security,
          );
        } else {
          await terminalizeDeviceCommandWithLifecycleCapacity(
            ctx,
            command as DataModel["deviceCommands"]["document"],
            patch,
            security,
          );
        }
      });
      const snapshot = await world.testRuntime.run(async (ctx) => ({
        command: commandType === "session"
          ? await ctx.db.get(legacy.commandId as Id<"sessionCommands">)
          : await ctx.db.get(legacy.commandId as Id<"deviceCommands">),
        lifecycle: await ctx.db.query("commandLifecycleReservations").collect(),
        securityEvents: await ctx.db.query("securityEvents")
          .withIndex("by_user_entity_and_event", (builder) => builder
            .eq("userId", world.userId)
            .eq("entityId", legacy.publicId)
            .eq("event", "command_terminal"))
          .collect(),
        securityReservations: await ctx.db.query("commandTerminalSecurityReservations").collect(),
      }));
      expect(snapshot.command).toMatchObject({
        nonterminal: false,
        receiptCapacityReservation: commandReceiptCapacityReservation,
        resultCode: "APPLIED",
        state: "applied",
      });
      expect(snapshot.lifecycle).toEqual([]);
      expect(snapshot.securityReservations).toEqual([]);
      expect(snapshot.securityEvents).toHaveLength(1);
    });
  }

  for (const commandType of ["session", "device"] as const) {
    test(`${commandType} break-glass retirement is non-growing, replayable, and durably provable`, async () => {
      const world = await lifecycleWorld();
      const legacy = await insertLegacyEffectStarted(
        world,
        commandType,
        commandType === "session" ? "fa" : "fb",
        91 * 24 * 60 * 60 * 1_000,
      );
      await saturateUserAndServiceCeilings(world);
      await expect(world.testRuntime.run(async (ctx) => {
        const command = commandType === "session"
          ? await ctx.db.get(legacy.commandId as Id<"sessionCommands">)
          : await ctx.db.get(legacy.commandId as Id<"deviceCommands">);
        if (command === null) throw new Error("missing saturated legacy effect");
        const patch = {
          nonterminal: false,
          result: smallEnvelope,
          resultCode: "APPLIED",
          resultDigest: "b".repeat(64),
          state: "applied" as const,
          updatedAt: world.now + 1,
        };
        const security = {
          actorDeviceId: world.deviceId,
          createdAt: world.now + 1,
          entityId: legacy.publicId,
          event: "command_terminal" as const,
          userId: world.userId,
        };
        if (commandType === "session") {
          await terminalizeSessionCommandWithLifecycleCapacity(
            ctx,
            command as DataModel["sessionCommands"]["document"],
            patch,
            security,
          );
        } else {
          await terminalizeDeviceCommandWithLifecycleCapacity(
            ctx,
            command as DataModel["deviceCommands"]["document"],
            patch,
            security,
          );
        }
      })).rejects.toThrow("QUOTA_EXCEEDED");

      const before = await usageCeilings(world);
      expect(await world.testRuntime.mutation(retireLegacyEffectStarted, {
        acknowledgement: "RETIRE_LEGACY_EFFECT_AS_RESULTLESS_AMBIGUOUS",
        commandPublicId: legacy.publicId,
        commandType,
        expectedRuntimeAttestation: trackedRuntimeAttestation,
      })).toMatchObject({ state: "retired" });
      const after = await usageCeilings(world);
      expect(after.userBytes).toBeLessThanOrEqual(before.userBytes);
      expect(after.serviceBytes).toBeLessThanOrEqual(before.serviceBytes ?? 0);

      const retired = await world.testRuntime.run(async (ctx) => ({
        command: commandType === "session"
          ? await ctx.db.get(legacy.commandId as Id<"sessionCommands">)
          : await ctx.db.get(legacy.commandId as Id<"deviceCommands">),
        enqueue: await ctx.db.query("securityEvents")
          .withIndex("by_user_entity_and_event", (builder) => builder
            .eq("userId", world.userId)
            .eq("entityId", legacy.publicId)
            .eq("event", "command_enqueued"))
          .collect(),
        terminal: await ctx.db.query("securityEvents")
          .withIndex("by_user_entity_and_event", (builder) => builder
            .eq("userId", world.userId)
            .eq("entityId", legacy.publicId)
            .eq("event", "command_terminal"))
          .unique(),
      }));
      expect(retired.enqueue).toEqual([]);
      expect(retired.command).toMatchObject({
        nonterminal: false,
        state: "ambiguous",
      });
      expect(retired.command).not.toHaveProperty("boundAuthority");
      expect(retired.command).not.toHaveProperty("receiptCapacityReservation");
      const operatorAbandonedAt = retired.command?.operatorAbandonedAt;
      expect(operatorAbandonedAt).toBeNumber();
      expect(retired.command?.terminalCleanupAfter)
        .toBe((operatorAbandonedAt ?? 0) + COMMAND_TERMINAL_RETENTION_MS);
      expect(retired.terminal).toMatchObject({
        actorDeviceId: world.deviceId,
        createdAt: operatorAbandonedAt,
      });
      expect(await world.testRuntime.mutation(retireLegacyEffectStarted, {
        acknowledgement: "RETIRE_LEGACY_EFFECT_AS_RESULTLESS_AMBIGUOUS",
        commandPublicId: legacy.publicId,
        commandType,
        expectedRuntimeAttestation: trackedRuntimeAttestation,
      })).toMatchObject({ state: "exact" });

      const recovery = {
        commandPublicId: legacy.publicId,
        localPhase: "effect_started" as const,
        staleAuthority: maximumAuthority,
      };
      expect(await world.actor.mutation(
        commandType === "session"
          ? confirmSessionTerminalRecovery
          : confirmDeviceTerminalRecovery,
        recovery,
      )).toMatchObject({ replay: true, state: "ambiguous" });

      // The original enqueue proof was already older than the security
      // retention window. Conversion resets its clock, so an immediate sweep
      // cannot strand daemon recovery before command retention completes.
      await world.testRuntime.mutation(cleanupExpired, { limit: 8 });
      expect(await world.testRuntime.run(async (ctx) => ctx.db.get(legacy.eventId))).not.toBeNull();

      // The collision fixture is unrelated to the saturation proof above and
      // needs one real record plus bounded bytes of synthetic ledger headroom.
      await releaseSyntheticByteHeadroom(
        world,
        2_048,
        2,
      );
      const collisionIds = await world.testRuntime.run(async (ctx) => {
        const command = commandType === "session"
          ? await ctx.db.get(legacy.commandId as Id<"sessionCommands">)
          : await ctx.db.get(legacy.commandId as Id<"deviceCommands">);
        const event = await ctx.db.get(legacy.eventId);
        if (command === null || event === null) throw new Error("missing retirement proof");
        const old = world.now - 91 * 24 * 60 * 60 * 1_000;
        const commandPatch = {
          operatorAbandonedAt: old,
          terminalCleanupAfter: old + COMMAND_TERMINAL_RETENTION_MS,
          updatedAt: old,
        };
        const eventPatch = { createdAt: old };
        await adjustCommandQuotaForPatch(ctx, world.userId, command, commandPatch);
        await ctx.db.patch(command._id, commandPatch);
        await adjustQuotaForPatch(ctx, world.userId, "security", event, eventPatch);
        await ctx.db.patch(event._id, eventPatch);
        const collisionCommon = {
          createdAt: world.now,
          deadline: world.now + 60_000,
          idempotencyKey: uuidV7(commandType === "session" ? "fca" : "fcb"),
          nonterminal: false,
          payload: smallEnvelope,
          publicId: legacy.publicId,
          requestDigest: (commandType === "session" ? "7" : "8").repeat(64),
          requestingDeviceId: world.deviceId,
          state: "applied" as const,
          targetDeviceId: world.deviceId,
          updatedAt: world.now,
          userId: world.userId,
        };
        const collision = commandType === "session"
          ? { ...collisionCommon, kind: "usage_refresh" as const }
          : { ...collisionCommon, kind: "send" as const, sessionId: world.sessionId };
        await reserveQuotaForInsert(ctx, world.userId, "command", collision);
        const collisionId = commandType === "session"
          ? await ctx.db.insert("deviceCommands", collision as DataModel["deviceCommands"]["document"])
          : await ctx.db.insert("sessionCommands", collision as DataModel["sessionCommands"]["document"]);
        const collisionEvent = {
          actorDeviceId: world.deviceId,
          createdAt: world.now,
          entityId: legacy.publicId,
          event: "command_terminal" as const,
          userId: world.userId,
        };
        await reserveQuotaForInsert(ctx, world.userId, "security", collisionEvent);
        const collisionEventId = await ctx.db.insert("securityEvents", collisionEvent);
        const maintenance = await ctx.db.query("maintenanceState").unique();
        if (maintenance === null) {
          await ctx.db.insert("maintenanceState", {
            key: "retention",
            nextCategory: "security_events",
            updatedAt: world.now,
          });
        } else {
          await ctx.db.patch(maintenance._id, { nextCategory: "security_events" });
        }
        return { collisionEventId, collisionId };
      });
      expect(await world.testRuntime.mutation(cleanupExpired, { limit: 1 }))
        .toMatchObject({ processed: 1, securityEvents: 1 });
      expect(await world.testRuntime.run(async (ctx) => ({
        command: commandType === "session"
          ? await ctx.db.get(legacy.commandId as Id<"sessionCommands">)
          : await ctx.db.get(legacy.commandId as Id<"deviceCommands">),
        event: await ctx.db.get(legacy.eventId),
        collision: commandType === "session"
          ? await ctx.db.get(collisionIds.collisionId as Id<"deviceCommands">)
          : await ctx.db.get(collisionIds.collisionId as Id<"sessionCommands">),
        collisionEvent: await ctx.db.get(collisionIds.collisionEventId),
      }))).toMatchObject({
        command: null,
        event: null,
        collision: { state: "applied" },
        collisionEvent: { createdAt: world.now, event: "command_terminal" },
      });
    });
  }

  test("effect retirement audit distinguishes missing and ambiguous security provenance", async () => {
    const world = await lifecycleWorld();
    const eligible = await insertLegacyEffectStarted(world, "session", "fc");
    const missing = await insertLegacyEffectStarted(world, "session", "fd");
    const mismatched = await insertLegacyEffectStarted(world, "session", "fe");
    await world.testRuntime.run(async (ctx) => {
      const missingEvent = await ctx.db.get(missing.eventId);
      const mismatchedEvent = await ctx.db.get(mismatched.eventId);
      if (missingEvent === null || mismatchedEvent === null) {
        throw new Error("missing retirement provenance fixtures");
      }
      await releaseQuotaForDelete(ctx, world.userId, "security", missingEvent);
      await ctx.db.delete(missingEvent._id);
      const patch = { createdAt: mismatchedEvent.createdAt + 1 };
      await adjustQuotaForPatch(ctx, world.userId, "security", mismatchedEvent, patch);
      await ctx.db.patch(mismatchedEvent._id, patch);
    });
    const audit = await world.testRuntime.query(auditReservationPage, {
      commandType: "session",
      expectedRuntimeAttestation: trackedRuntimeAttestation,
      paginationOpts: { cursor: null, numItems: maximumCommandLifecycleBatch },
      state: "effect_started",
    });
    if (audit.effectRetirement === undefined) {
      throw new Error("missing effect retirement audit");
    }
    const retirementStatus = new Map(audit.effectRetirement.map((entry) => [
      entry.commandPublicId,
      entry.status,
    ]));
    expect(retirementStatus.get(eligible.publicId)).toBe("eligible");
    expect(retirementStatus.get(missing.publicId)).toBe("enqueue_missing");
    expect(retirementStatus.get(mismatched.publicId)).toBe("ambiguous");
    for (const publicId of [missing.publicId, mismatched.publicId]) {
      await expect(world.testRuntime.mutation(retireLegacyEffectStarted, {
        acknowledgement: "RETIRE_LEGACY_EFFECT_AS_RESULTLESS_AMBIGUOUS",
        commandPublicId: publicId,
        commandType: "session",
        expectedRuntimeAttestation: trackedRuntimeAttestation,
      })).rejects.toThrow("COMMAND_LIFECYCLE_RESERVATION_CORRUPT");
    }
    await expect(world.testRuntime.query(auditReservationPage, {
      commandType: "session",
      expectedRuntimeAttestation: {
        ...trackedRuntimeAttestation,
        bound: true,
        deployedAtMs: 1,
        previousDeployDigest: null,
        runtimeRevision: "00000000-0000-4000-8000-000000000001",
        runtimeSourceCommit: "a".repeat(40),
      },
      paginationOpts: { cursor: null, numItems: maximumCommandLifecycleBatch },
      state: "effect_started",
    })).rejects.toThrow("COMMAND_LIFECYCLE_RUNTIME_CHANGED");
  });

  test("daemon recovery rejects a malformed operator-abandonment terminal", async () => {
    const world = await lifecycleWorld();
    const legacy = await insertLegacyEffectStarted(world, "device", "ff");
    await world.testRuntime.mutation(retireLegacyEffectStarted, {
      acknowledgement: "RETIRE_LEGACY_EFFECT_AS_RESULTLESS_AMBIGUOUS",
      commandPublicId: legacy.publicId,
      commandType: "device",
      expectedRuntimeAttestation: trackedRuntimeAttestation,
    });
    await world.testRuntime.run(async (ctx) => {
      const command = await ctx.db.get(legacy.commandId as Id<"deviceCommands">);
      if (command === null) throw new Error("missing retired device command");
      const patch = { terminalCleanupAfter: undefined };
      await adjustCommandQuotaForPatch(ctx, world.userId, command, patch);
      await ctx.db.patch(command._id, patch);
    });
    await expect(world.actor.mutation(confirmDeviceTerminalRecovery, {
      commandPublicId: legacy.publicId,
      localPhase: "effect_started",
      staleAuthority: maximumAuthority,
    })).rejects.toThrow("DEVICE_COMMAND_TERMINAL_RECOVERY_CONFLICT");
    await expect(world.testRuntime.mutation(retireLegacyEffectStarted, {
      acknowledgement: "RETIRE_LEGACY_EFFECT_AS_RESULTLESS_AMBIGUOUS",
      commandPublicId: legacy.publicId,
      commandType: "device",
      expectedRuntimeAttestation: trackedRuntimeAttestation,
    })).rejects.toThrow("COMMAND_LIFECYCLE_RESERVATION_CORRUPT");
  });

  test("live legacy single-use result scheduling never grows a terminal row", async () => {
    const world = await lifecycleWorld();
    const commandId = await world.testRuntime.run(async (ctx) => {
      const command = {
        createdAt: world.now,
        deadline: world.now + 60_000,
        idempotencyKey: uuidV7("a11"),
        kind: "account_login_start" as const,
        nonterminal: false,
        payload: smallEnvelope,
        publicId: uuidV7("a12"),
        receiptCapacityReservation: commandReceiptCapacityReservation,
        requestDigest: "d".repeat(64),
        requestingDeviceId: world.deviceId,
        result: maximumDeviceResult,
        resultCode: "APPLIED",
        resultDigest: "e".repeat(64),
        resultSingleUse: true,
        state: "applied" as const,
        targetDeviceId: world.deviceId,
        updatedAt: Date.now(),
        userId: world.userId,
      };
      await reserveQuotaForInsert(ctx, world.userId, "command", command);
      return await ctx.db.insert("deviceCommands", command);
    });
    const before = await world.testRuntime.run(async (ctx) => await ctx.db.get(commandId));
    await saturateUserAndServiceCeilings(world);
    expect(await world.testRuntime.mutation(cleanupExpired, { limit: 8 }))
      .toMatchObject({ deviceCommandLoginResults: 1 });
    const after = await world.testRuntime.run(async (ctx) => await ctx.db.get(commandId));
    expect(after).toEqual(before);
    expect(after).not.toHaveProperty("resultExpiresAt");
  });

  test("classifies pre-completed revocation debt without growth and deletes it only after 30 days", async () => {
    const world = await lifecycleWorld();
    const ids = await world.testRuntime.run(async (ctx) => {
      const requester = await ctx.db.get(world.deviceId);
      if (requester === null) throw new Error("missing legacy revoked requester");
      const revokePatch = { revokedAt: world.now, status: "revoked" as const };
      await adjustQuotaForPatch(ctx, world.userId, "device", requester, revokePatch);
      await ctx.db.patch(requester._id, revokePatch);
      const common = {
        createdAt: world.now,
        deadline: world.now + 60_000,
        nonterminal: false,
        payload: smallEnvelope,
        requestingDeviceId: world.deviceId,
        state: "applied" as const,
        targetDeviceId: world.deviceId,
        updatedAt: world.now,
        userId: world.userId,
      };
      const session = {
        ...common,
        idempotencyKey: uuidV7("b11"),
        kind: "send" as const,
        publicId: uuidV7("b12"),
        requestDigest: "1".repeat(64),
        sessionId: world.sessionId,
      };
      await reserveQuotaForInsert(ctx, world.userId, "command", session);
      const sessionId = await ctx.db.insert("sessionCommands", session);
      const device = {
        ...common,
        idempotencyKey: uuidV7("b21"),
        kind: "usage_refresh" as const,
        publicId: uuidV7("b22"),
        requestDigest: "2".repeat(64),
      };
      await reserveQuotaForInsert(ctx, world.userId, "command", device);
      const deviceId = await ctx.db.insert("deviceCommands", device);
      return { deviceId, devicePublicId: device.publicId, sessionId, sessionPublicId: session.publicId };
    });

    for (const [commandType, publicId] of [
      ["session", ids.sessionPublicId],
      ["device", ids.devicePublicId],
    ] as const) {
      expect(await world.testRuntime.query(auditTerminalReceiptCapacityPage, {
        commandType,
        expectedRuntimeAttestation: trackedRuntimeAttestation,
        paginationOpts: { cursor: null, numItems: maximumCommandLifecycleBatch },
        state: "applied",
      })).toMatchObject({ legacyRevoked: [publicId], unreserved: [] });
      expect(await world.testRuntime.mutation(reserveExistingTerminalReceipt, {
        commandPublicId: publicId,
        commandType,
        expectedRuntimeAttestation: trackedRuntimeAttestation,
      })).toMatchObject({ state: "legacy_revoked" });
    }

    await saturateUserAndServiceCeilings(world);
    await world.testRuntime.mutation(cleanupExpired, { limit: 8 });
    expect(await world.testRuntime.run(async (ctx) => ({
      device: await ctx.db.get(ids.deviceId),
      session: await ctx.db.get(ids.sessionId),
    }))).toMatchObject({
      device: { state: "applied" },
      session: { state: "applied" },
    });

    await world.testRuntime.run(async (ctx) => {
      const device = await ctx.db.get(ids.deviceId);
      const session = await ctx.db.get(ids.sessionId);
      if (device === null || session === null) throw new Error("missing retained legacy receipt");
      const old = world.now - 31 * 24 * 60 * 60 * 1_000;
      await adjustCommandQuotaForPatch(ctx, world.userId, device, { updatedAt: old });
      await ctx.db.patch(device._id, { updatedAt: old });
      await adjustCommandQuotaForPatch(ctx, world.userId, session, { updatedAt: old });
      await ctx.db.patch(session._id, { updatedAt: old });
    });
    await world.testRuntime.mutation(cleanupExpired, { limit: 8 });
    expect(await world.testRuntime.run(async (ctx) => ({
      device: await ctx.db.get(ids.deviceId),
      session: await ctx.db.get(ids.sessionId),
    }))).toMatchObject({
      device: { state: "applied" },
      session: { state: "applied" },
    });

    await world.testRuntime.run(async (ctx) => {
      const requester = await ctx.db.get(world.deviceId);
      const device = await ctx.db.get(ids.deviceId);
      const session = await ctx.db.get(ids.sessionId);
      if (requester === null || device === null || session === null) {
        throw new Error("missing retained legacy receipt authority");
      }
      const old = world.now - 31 * 24 * 60 * 60 * 1_000;
      const revokePatch = { revokedAt: old };
      await adjustQuotaForPatch(ctx, world.userId, "device", requester, revokePatch);
      await ctx.db.patch(requester._id, revokePatch);
      await adjustCommandQuotaForPatch(ctx, world.userId, device, { updatedAt: old });
      await ctx.db.patch(device._id, { updatedAt: old });
      await adjustCommandQuotaForPatch(ctx, world.userId, session, { updatedAt: old });
      await ctx.db.patch(session._id, { updatedAt: old });
    });
    await world.testRuntime.mutation(cleanupExpired, { limit: 8 });
    await world.testRuntime.mutation(cleanupExpired, { limit: 8 });
    expect(await world.testRuntime.run(async (ctx) => ({
      device: await ctx.db.get(ids.deviceId),
      session: await ctx.db.get(ids.sessionId),
    }))).toEqual({ device: null, session: null });
  });

  for (const jobState of ["pending", "draining"] as const) {
    test(`an old ${jobState} revocation job skips legacy receipt debt without starving reserved rows`, async () => {
      const world = await lifecycleWorld();
      const ids = await world.testRuntime.run(async (ctx) => {
        const requester = await ctx.db.get(world.deviceId);
        if (requester === null) throw new Error("missing revocation requester");
        const revokePatch = {
          revokedAt: world.now,
          revision: requester.revision + 1,
          status: "revoked" as const,
          updatedAt: world.now,
        };
        await adjustQuotaForPatch(ctx, world.userId, "device", requester, revokePatch);
        await ctx.db.patch(requester._id, revokePatch);

        const common = {
          createdAt: world.now,
          deadline: world.now + 60_000,
          nonterminal: false,
          payload: smallEnvelope,
          requestingDeviceId: world.deviceId,
          state: "applied" as const,
          targetDeviceId: world.deviceId,
          updatedAt: world.now,
          userId: world.userId,
        };
        const insertSession = async (suffix: string, reserved: boolean) => {
          const command = {
            ...common,
            idempotencyKey: uuidV7(`c1${suffix}`),
            kind: "stop" as const,
            publicId: uuidV7(`c2${suffix}`),
            ...(reserved
              ? { receiptCapacityReservation: commandReceiptCapacityReservation }
              : {}),
            requestDigest: suffix.repeat(64),
            sessionId: world.sessionId,
          };
          await reserveQuotaForInsert(ctx, world.userId, "command", command);
          return await ctx.db.insert("sessionCommands", command);
        };
        const insertDevice = async (suffix: string, reserved: boolean) => {
          const command = {
            ...common,
            idempotencyKey: uuidV7(`d1${suffix}`),
            kind: "usage_refresh" as const,
            publicId: uuidV7(`d2${suffix}`),
            ...(reserved
              ? { receiptCapacityReservation: commandReceiptCapacityReservation }
              : {}),
            requestDigest: suffix.repeat(64),
          };
          await reserveQuotaForInsert(ctx, world.userId, "command", command);
          return await ctx.db.insert("deviceCommands", command);
        };
        const legacySessionId = await insertSession("1", false);
        const reservedSessionId = await insertSession("2", true);
        const legacyDeviceId = await insertDevice("3", false);
        const reservedDeviceId = await insertDevice("4", true);
        const job = {
          category: "commands" as const,
          createdAt: world.now,
          deviceId: world.deviceId,
          publicId: uuidV7(jobState === "pending" ? "c31" : "c32"),
          state: jobState,
          updatedAt: world.now,
          userId: world.userId,
        };
        await reserveQuotaForInsert(ctx, world.userId, "job", job);
        await ctx.db.insert("deviceRevocationJobs", job);
        return { legacyDeviceId, legacySessionId, reservedDeviceId, reservedSessionId };
      });

      await saturateUserAndServiceCeilings(world);
      expect(await world.testRuntime.mutation(drainDeviceRevocations, { limit: 8 }))
        .toMatchObject({ category: "commands", kind: "drained", processed: 2 });
      const after = await world.testRuntime.run(async (ctx) => ({
        legacyDevice: await ctx.db.get(ids.legacyDeviceId),
        legacySession: await ctx.db.get(ids.legacySessionId),
        reservedDevice: await ctx.db.get(ids.reservedDeviceId),
        reservedSession: await ctx.db.get(ids.reservedSessionId),
      }));
      expect(after.legacyDevice).not.toHaveProperty("requesterReceiptAbandonedAt");
      expect(after.legacySession).not.toHaveProperty("requesterReceiptAbandonedAt");
      expect(after.reservedDevice?.requesterReceiptAbandonedAt).toBeNumber();
      expect(after.reservedSession?.requesterReceiptAbandonedAt).toBeNumber();
      expect(after.reservedDevice).not.toHaveProperty("requesterAcknowledgedAt");
      expect(after.reservedSession).not.toHaveProperty("requesterAcknowledgedAt");
      expect(await world.testRuntime.mutation(drainDeviceRevocations, { limit: 8 }))
        .toMatchObject({ category: "custody", kind: "drained", processed: 1 });
      expect(await world.testRuntime.mutation(drainDeviceRevocations, { limit: 8 }))
        .toMatchObject({ category: "complete", kind: "complete", processed: 0 });
    });
  }
});

const diagnosticSnapshot = async (world: Awaited<ReturnType<typeof lifecycleWorld>>) =>
  await world.testRuntime.run(async (ctx) => await Promise.all(([
    "accountDeletionIdentityReservations", "accountDeletionJobReservations",
    "deviceRevocationDeviceReservations", "deviceRevocationJobReservations",
    "deviceRevocationReceiptReservations", "deviceRevocationSecurityReservations",
    "storageUsageByUser", "storageUsageService", "serviceControl",
  ] as const).map(async (table) => await ctx.db.query(table).collect())));

const diagnosticArgs = {
  expectedRuntimeAttestation: trackedRuntimeAttestation,
  paginationOpts: { cursor: null, numItems: 8 },
};

describe("read-only authority reduction quota page", () => {
  test("distinguishes missing sets and simultaneous ceilings without changing stored state", async () => {
    const world = await lifecycleWorld();
    await saturateUserAndServiceCeilings(world);
    const before = await diagnosticSnapshot(world);
    const result = await world.testRuntime.query(auditAuthorityReductionQuotaCeilingsPage, diagnosticArgs);
    expect(result).toMatchObject({
      activationAuthorized: false, capacityMissing: 1, consistency: "page_snapshot", evaluated: 1,
      demand: { accountPairs: 1, deviceQuartets: 1, paddingBytesLowerBound: 12_288, totalRecords: 6 },
      quotaAuthorityUnknown: 0, repairAuthorized: false, scanned: 1,
      ceilings: {
        security: { recordsBlocked: 1 },
        serviceTotal: { bytesBlockedByLowerBound: 1, recordsBlocked: 1 },
        userTotal: { bytesBlockedByLowerBound: 1 },
      },
    });
    if (typeof result !== "object" || result === null || !("continueCursor" in result)) {
      throw new Error("invalid diagnostic result");
    }
    const { continueCursor, ...closed } = result;
    expect(typeof continueCursor).toBe("string");
    const encoded = JSON.stringify(closed);
    for (const forbidden of [world.userId, world.deviceId, "userId", "email", "createdAt", "updatedAt", "_id"]) {
      expect(encoded).not.toContain(forbidden);
    }
    expect(await diagnosticSnapshot(world)).toEqual(before);
  });

  test("only missing sets are demanded and the padding is below genuine stored cost", async () => {
    const world = await lifecycleWorld();
    await world.testRuntime.run(async (ctx) => { await createAccountDeletionCapacityForNewUser(ctx, world.userId); });
    expect(await world.testRuntime.query(auditAuthorityReductionQuotaCeilingsPage, diagnosticArgs))
      .toMatchObject({ demand: { accountPairs: 0, deviceQuartets: 1, totalRecords: 4 }, ceilings: { identity: { applicable: 0 } } });
    await world.testRuntime.run(async (ctx) => { await createDeviceRevocationCapacityForNewDevice(ctx, world.userId, world.deviceId); });
    expect(await world.testRuntime.query(auditAuthorityReductionQuotaCeilingsPage, diagnosticArgs))
      .toMatchObject({ capacityMissing: 0, evaluated: 0, ready: 1, demand: { totalRecords: 0 } });
    await world.testRuntime.run(async (ctx) => {
      const rows = [
        ...await ctx.db.query("accountDeletionIdentityReservations").collect(),
        ...await ctx.db.query("accountDeletionJobReservations").collect(),
        ...await ctx.db.query("deviceRevocationDeviceReservations").collect(),
        ...await ctx.db.query("deviceRevocationJobReservations").collect(),
        ...await ctx.db.query("deviceRevocationSecurityReservations").collect(),
        ...await ctx.db.query("deviceRevocationReceiptReservations").collect(),
      ];
      expect(rows).toHaveLength(6);
      for (const row of rows) expect(logicalDocumentBytes(row)).toBeGreaterThan(2_048);
    });
  });

  test("partial reservation topology and corrupt quota authority remain distinct", async () => {
    const world = await lifecycleWorld();
    await world.testRuntime.run(async (ctx) => {
      const memory = await ctx.db.query("storageUsageByUser")
        .withIndex("by_user_and_category", (q) => q.eq("userId", world.userId).eq("category", "memory")).unique();
      if (memory === null) throw new Error("missing memory fixture");
      await ctx.db.delete(memory._id);
    });
    expect(await world.testRuntime.query(auditAuthorityReductionQuotaCeilingsPage, diagnosticArgs))
      .toMatchObject({ capacityMissing: 1, evaluated: 0, quotaAuthorityUnknown: 1, demand: { totalRecords: 6 } });
    await world.testRuntime.run(async (ctx) => {
      await ctx.db.insert("accountDeletionIdentityReservations", {
        capacityReservation: "0".repeat(2_048), capacityVersion: 1,
        category: "identity", createdAt: world.now, userId: world.userId,
      });
    });
    expect(await world.testRuntime.query(auditAuthorityReductionQuotaCeilingsPage, diagnosticArgs))
      .toMatchObject({ capacityMissing: 0, evaluated: 0, quotaAuthorityUnknown: 0, topologyBlocked: 1 });
  });

  test("server-owned pagination reads no more than eight identities", async () => {
    const world = await lifecycleWorld();
    await world.testRuntime.run(async (ctx) => {
      for (let index = 0; index < 8; index += 1) {
        await ctx.db.insert("users", { email: `unverified-${String(index)}@example.com` });
      }
    });
    const first = await world.testRuntime.query(auditAuthorityReductionQuotaCeilingsPage, diagnosticArgs);
    expect(first).toMatchObject({ isDone: false, scanned: 8 });
    if (typeof first !== "object" || first === null || !("continueCursor" in first)
      || typeof first.continueCursor !== "string") throw new Error("invalid fixture cursor");
    expect(await world.testRuntime.query(auditAuthorityReductionQuotaCeilingsPage, {
      ...diagnosticArgs, paginationOpts: { cursor: first.continueCursor, numItems: 8 },
    })).toMatchObject({ isDone: true, scanned: 1 });
  });

  test("rejects cursor overrides and stale runtime before classification", async () => {
    const world = await lifecycleWorld();
    const foreign = makeFunctionReference<"query", Args, unknown>("commandLifecycle:auditAuthorityReductionQuotaCeilingsPage");
    for (const paginationOpts of [
      { cursor: null, numItems: 9 }, { cursor: null, numItems: 0 },
      { cursor: "x".repeat(4_097), numItems: 1 },
      { cursor: null, endCursor: "override", numItems: 1 },
      { cursor: null, maximumRowsRead: 100, numItems: 1 },
      { cursor: null, maximumBytesRead: 1_000_000, numItems: 1 },
    ]) await expect(world.testRuntime.query(foreign, {
      ...diagnosticArgs, paginationOpts,
    })).rejects.toThrow();
    await expect(world.testRuntime.query(foreign, {
      ...diagnosticArgs,
      expectedRuntimeAttestation: { ...candidateRuntimeForDiagnostic },
    })).rejects.toThrow("COMMAND_LIFECYCLE_RUNTIME_CHANGED");
  });
});

const candidateRuntimeForDiagnostic = {
  bound: true, deployedAtMs: 1, previousDeployDigest: null, runtimeRevision: "fixture",
  runtimeSourceCommit: "a".repeat(40), schemaIdentity: "hra-release-attestation-v1", schemaVersion: 1,
};
