import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";

import { isSafePositiveInteger, isUuidV7 } from "../src/cloud/contracts";
import { deviceCommandLoginResultLifetimeMs } from "../src/cloud/payloads";
import { sha256Hex } from "../src/cloud/crypto";
import { maximumLiveOtpChallenges } from "./authPolicy";
import {
  attentionNotificationGroupLimit,
  attentionNotificationQuarantineRowLimit,
  attentionNotificationQuotaReservations,
  attentionNotificationRetryRecoveryMs,
  latchCorruptAttentionNotificationDelivery,
  quarantineFaultedAttentionNotificationDelivery,
  validatedStartedAttentionNotificationGroup,
} from "./attentionNotifications";
import {
  deleteExpiredAttentionNotificationSafetyFaults,
  readOldestPendingStoredAttentionNotificationSafetyFault,
  releaseUnusedAttentionNotificationFaultCapacity,
} from "./attentionNotificationControl";
import { commandTerminalRetentionMs } from "./commands";
import {
  isLegacyNoEffectExpiredTerminal,
  isOperatorAbandonedEffectTerminal,
  requireOperatorAbandonedSecurityEvent,
  terminalizeDeviceCommandWithLifecycleCapacity,
  terminalizeSessionCommandWithLifecycleCapacity,
} from "./commandLifecycle";
import {
  authorityReductionOrphanRetentionMs,
  inspectLegacyOtpOrphanCandidate,
  loadAccountDeletionCapacity,
  releaseAccountDeletionCapacityForSubjectDeletion,
} from "./authorityReductionCapacity";
import {
  ATTENTION_NOTIFICATION_TERMINAL_RETENTION_MS,
  CLOUD_USAGE_SNAPSHOT_RETENTION_MS,
  type HOSTED_TABLE_LIFECYCLE,
} from "./lifecyclePolicy";
import {
  adjustCommandQuotaForPatch,
  adjustQuotaForPatch,
  finalizeUserQuotaAuthorityForDelete,
  releaseAccountUsageSnapshotQuotaForDelete,
  releaseCommandQuotaForDelete,
  releaseLiveChunkResourceForDelete,
  releaseParentAttributedQuotaForDelete,
  releaseQuotaForDelete,
  releaseQuotaForStoredIdentity,
  releaseServiceQuotaForDelete,
  releaseSessionChunkQuotaForDelete,
  requireHardQuotaAuthority,
  logicalDocumentBytes,
} from "./quota";
import { internalMutation, type DataModel, type MutationCtx } from "./server";
import { beginDetailRetentionEpoch } from "./sessions";
import {
  commandLifecycleCapacityVersion,
  maximumCommandLifecycleBatch,
} from "./validators";

const maximumCleanupBatch = 200;
const categoryQuantum = 20;
const expireLoginResult = makeFunctionReference<
  "mutation",
  Readonly<{ commandPublicId: string; resultExpiresAt: number }>,
  unknown
>("maintenance:expireDeviceCommandLoginResult");
const maintenanceCategories = [
  "auth_attempts",
  "otp_challenges",
  "auth_invites",
  "abandoned_identities",
  "orphaned_auth_users",
  "bind_challenges",
  "device_presence",
  "idempotency_receipts",
  "pending_commands",
  "terminal_commands",
  "pending_device_commands",
  "device_command_login_results",
  "terminal_device_commands",
  "pending_attention_notifications",
  "started_attention_notifications",
  "terminal_attention_notifications",
  "attention_notification_faults",
  "security_events",
  "usage_snapshots",
  "account_deletion_receipts",
  "device_revocation_jobs",
  "live_tail_chunks",
] as const;
type MaintenanceCategory = typeof maintenanceCategories[number];

// Every hosted table is explicitly classified for periodic retention. Empty
// means the table is governed by another lifecycle (for example active state,
// immutable encrypted history, account deletion, or permanent service state).
export const MAINTENANCE_RETENTION_STRATEGY = {
  users: ["abandoned_identities"],
  authSessions: [],
  authAccounts: ["abandoned_identities"],
  authRefreshTokens: [],
  authVerificationCodes: ["abandoned_identities"],
  authVerifiers: [],
  authRateLimits: [],
  authSubjects: ["abandoned_identities"],
  authEmailAttemptEvents: ["auth_attempts"],
  authOtpChallenges: ["otp_challenges", "abandoned_identities"],
  authInvites: ["auth_invites"],
  devices: [],
  accountDeletionIdentityReservations: [],
  accountDeletionJobReservations: [],
  deviceRevocationDeviceReservations: [],
  deviceRevocationJobReservations: [],
  deviceRevocationSecurityReservations: [],
  deviceRevocationReceiptReservations: [],
  deviceSessions: [],
  deviceBindChallenges: ["bind_challenges"],
  deviceKeyEnvelopes: [],
  recoveryEnvelopes: [],
  devicePresence: ["device_presence"],
  deviceRegistries: [],
  memorySpaces: [],
  memoryOperations: [],
  sessionHeads: ["live_tail_chunks"],
  sessionChunks: ["live_tail_chunks"],
  sessionStreamEpochs: ["live_tail_chunks"],
  executionLeases: [],
  sessionCommands: ["pending_commands", "terminal_commands"],
  deviceCommands: [
    "pending_device_commands",
    "device_command_login_results",
    "terminal_device_commands",
  ],
  commandLifecycleReservations: ["pending_commands", "pending_device_commands"],
  commandTerminalSecurityReservations: ["pending_commands", "pending_device_commands"],
  attentionNotificationOutbox: [
    "pending_attention_notifications",
    "started_attention_notifications",
    "terminal_attention_notifications",
  ],
  attentionNotificationSafetyFaults: ["attention_notification_faults"],
  codexAccounts: [],
  deviceAccountBindings: ["usage_snapshots"],
  accountUsageSnapshots: ["usage_snapshots"],
  idempotencyReceipts: ["idempotency_receipts"],
  securityEvents: ["security_events"],
  accountDeletionJobs: [],
  accountDeletionReceipts: ["account_deletion_receipts"],
  deviceRevocationJobs: ["device_revocation_jobs"],
  storageUsageByUser: [],
  storageUsageService: [],
  serviceControl: [],
  storageResourceUsageByUser: [],
  storageResourceUsageByAccount: [],
  maintenanceState: [],
} as const satisfies Readonly<Record<
  keyof typeof HOSTED_TABLE_LIFECYCLE,
  readonly MaintenanceCategory[]
>>;

export const cloudRetentionMs = Object.freeze({
  abandonedIdentity: authorityReductionOrphanRetentionMs,
  accountDeletionReceipt: 7 * 24 * 60 * 60 * 1_000,
  authAttemptMaximum: 24 * 60 * 60 * 1_000,
  bindChallengeMaximum: 5 * 60 * 1_000,
  deviceRevocationJob: 7 * 24 * 60 * 60 * 1_000,
  idempotencyReceipt: 7 * 24 * 60 * 60 * 1_000,
  otpChallengeMaximum: 10 * 60 * 1_000,
  securityEvent: 90 * 24 * 60 * 60 * 1_000,
  terminalCommand: commandTerminalRetentionMs,
  usageSnapshot: CLOUD_USAGE_SNAPSHOT_RETENTION_MS,
} as const);

type CleanupCounts = {
  abandonedIdentities: number;
  orphanedAuthUsers: number;
  accountDeletionReceipts: number;
  authAttempts: number;
  authInvites: number;
  bindChallenges: number;
  devicePresence: number;
  deviceRevocationJobs: number;
  deviceCommandLoginResults: number;
  expiredPendingAttentionNotifications: number;
  expiredPendingCommands: number;
  expiredPendingDeviceCommands: number;
  idempotencyReceipts: number;
  liveTailChunks: number;
  otpChallenges: number;
  securityEvents: number;
  startedAttentionNotifications: number;
  terminalAttentionNotifications: number;
  attentionNotificationFaults: number;
  terminalCommands: number;
  terminalDeviceCommands: number;
  usageSnapshots: number;
};

const countField = {
  live_tail_chunks: "liveTailChunks",
  auth_attempts: "authAttempts",
  otp_challenges: "otpChallenges",
  auth_invites: "authInvites",
  abandoned_identities: "abandonedIdentities",
  orphaned_auth_users: "orphanedAuthUsers",
  bind_challenges: "bindChallenges",
  device_presence: "devicePresence",
  idempotency_receipts: "idempotencyReceipts",
  pending_commands: "expiredPendingCommands",
  terminal_commands: "terminalCommands",
  pending_device_commands: "expiredPendingDeviceCommands",
  device_command_login_results: "deviceCommandLoginResults",
  terminal_device_commands: "terminalDeviceCommands",
  pending_attention_notifications: "expiredPendingAttentionNotifications",
  started_attention_notifications: "startedAttentionNotifications",
  terminal_attention_notifications: "terminalAttentionNotifications",
  attention_notification_faults: "attentionNotificationFaults",
  security_events: "securityEvents",
  usage_snapshots: "usageSnapshots",
  account_deletion_receipts: "accountDeletionReceipts",
  device_revocation_jobs: "deviceRevocationJobs",
} as const satisfies Readonly<Record<MaintenanceCategory, keyof CleanupCounts>>;

function requireCleanupLimit(value: number): number {
  if (!isSafePositiveInteger(value) || value > maximumCleanupBatch) {
    throw new Error("Invalid cleanup batch.");
  }
  return value;
}

async function deleteExpiredAuthAttempts(ctx: MutationCtx, now: number, limit: number): Promise<number> {
  const records = await ctx.db.query("authEmailAttemptEvents")
    .withIndex("by_expires_at", (builder) => builder.lt("expiresAt", now))
    .take(limit);
  for (const record of records) {
    await releaseServiceQuotaForDelete(ctx, record);
    await ctx.db.delete(record._id);
  }
  return records.length;
}

async function deleteExpiredOtpChallenges(ctx: MutationCtx, now: number, limit: number): Promise<number> {
  const records = await ctx.db.query("authOtpChallenges")
    .withIndex("by_expires_at", (builder) => builder.lt("expiresAt", now))
    .take(limit);
  for (const record of records) {
    await releaseQuotaForDelete(ctx, record.userId, "identity", record);
    await ctx.db.delete(record._id);
  }
  return records.length;
}

async function deleteExpiredInvites(ctx: MutationCtx, now: number, limit: number): Promise<number> {
  const records = await ctx.db.query("authInvites")
    .withIndex("by_expiry", (builder) => builder.lt("expiresAt", now))
    .take(limit);
  for (const record of records) {
    await releaseServiceQuotaForDelete(ctx, record);
    await ctx.db.delete(record._id);
  }
  return records.length;
}

async function cleanAbandonedIdentity(ctx: MutationCtx, now: number, limit: number): Promise<number> {
  const subject = await ctx.db.query("authSubjects")
    .withIndex("by_unverified_status_and_updated_at", (builder) => builder
      .eq("verifiedAt", undefined)
      .eq("status", "active")
      .lt("updatedAt", now - cloudRetentionMs.abandonedIdentity))
    .first();
  if (subject === null) return 0;
  if (subject.userId === undefined) {
    if (subject.accountDeletionCapacity !== undefined) throw new Error("Maintenance authority is corrupt.");
    await releaseServiceQuotaForDelete(ctx, subject);
    await ctx.db.delete(subject._id);
    return 1;
  }
  const user = await ctx.db.get(subject.userId);
  if (user === null) {
    throw new Error("Maintenance authority is corrupt.");
  }
  if (user.emailVerificationTime !== undefined) {
    const subjectPatch = {
      updatedAt: now,
      verifiedAt: user.emailVerificationTime,
    };
    await adjustQuotaForPatch(ctx, user._id, "identity", subject, subjectPatch);
    await ctx.db.patch(subject._id, subjectPatch);
    return 1;
  }
  const liveChallenges = await ctx.db.query("authOtpChallenges")
    .withIndex("by_user_and_expires_at", (builder) => builder
      .eq("userId", user._id)
      .gt("expiresAt", now))
    .take(maximumLiveOtpChallenges + 1);
  if (liveChallenges.length > maximumLiveOtpChallenges) {
    throw new Error("Maintenance authority is corrupt.");
  }
  if (liveChallenges.length > 0) {
    if (liveChallenges.some((challenge) =>
      challenge.authEpoch !== subject.authEpoch
      || challenge.emailDigest !== subject.emailDigest)) {
      throw new Error("Maintenance authority is corrupt.");
    }
    const subjectPatch = { updatedAt: now };
    await adjustQuotaForPatch(ctx, user._id, "identity", subject, subjectPatch);
    await ctx.db.patch(subject._id, subjectPatch);
    return 1;
  }
  const [session, device] = await Promise.all([
    ctx.db.query("authSessions")
      .withIndex("userId", (builder) => builder.eq("userId", user._id))
      .first(),
    ctx.db.query("devices")
      .withIndex("by_user_and_public_id", (builder) => builder.eq("userId", user._id))
      .first(),
  ]);
  if (session !== null || device !== null) {
    const subjectPatch = { updatedAt: now };
    await adjustQuotaForPatch(ctx, user._id, "identity", subject, subjectPatch);
    await ctx.db.patch(subject._id, subjectPatch);
    return 1;
  }

  let remaining = limit;
  const challenges = await ctx.db.query("authOtpChallenges")
    .withIndex("by_user", (builder) => builder.eq("userId", user._id))
    .take(remaining);
  for (const challenge of challenges) {
    await releaseQuotaForDelete(ctx, user._id, "identity", challenge);
    await ctx.db.delete(challenge._id);
  }
  remaining -= challenges.length;
  if (remaining === 0) return limit;

  const account = await ctx.db.query("authAccounts")
    .withIndex("userIdAndProvider", (builder) => builder.eq("userId", user._id))
    .first();
  if (account !== null) {
    const codes = await ctx.db.query("authVerificationCodes")
      .withIndex("accountId", (builder) => builder.eq("accountId", account._id))
      .take(remaining);
    for (const code of codes) {
      await releaseParentAttributedQuotaForDelete(ctx, user._id, "identity", code);
      await ctx.db.delete(code._id);
    }
    remaining -= codes.length;
    if (remaining === 0) return limit;
    if (codes.length === 0) {
      await releaseQuotaForDelete(ctx, user._id, "identity", account);
      await ctx.db.delete(account._id);
      remaining -= 1;
    }
    return limit - remaining;
  }

  const capacity = await loadAccountDeletionCapacity(ctx, user._id);
  const required = capacity.kind === "reserved" ? 4 : capacity.kind === "inline_reserved" ? 3 : 2;
  // Delete authority and its physical escape capacity in one transaction.
  // An earlier bounded sweep must never leave an active unverified identity
  // without the pair that guarantees account deletion at a hard ceiling.
  if (remaining < required) return limit - remaining;
  await releaseAccountDeletionCapacityForSubjectDeletion(ctx, capacity, subject);
  await releaseQuotaForDelete(ctx, user._id, "identity", subject);
  await releaseQuotaForStoredIdentity(ctx, user._id, user);
  await finalizeUserQuotaAuthorityForDelete(ctx, user._id);
  await ctx.db.delete(subject._id);
  await ctx.db.delete(user._id);
  return limit - remaining + required;
}

const orphanedAuthUserMaximumDeletedRows = 5;

async function cleanOrphanedAuthUsers(
  ctx: MutationCtx,
  now: number,
  limit: number,
  maintenance?: DataModel["maintenanceState"]["document"],
): Promise<number> {
  if (maintenance === undefined) throw new Error("Maintenance authority is corrupt.");
  const numItems = Math.floor(limit / orphanedAuthUserMaximumDeletedRows);
  if (numItems < 1) return 0;
  const cursor = maintenance.orphanedAuthUserCursor;
  const cursorId = cursor === undefined ? null : ctx.db.normalizeId("users", cursor);
  if (cursor !== undefined && cursorId === null) {
    throw new Error("Maintenance authority is corrupt.");
  }
  // Auth accounts are a complete, user-keyed inventory of the predecessor gap
  // and let retention advance with an ordinary bounded index read. This avoids
  // consuming Convex's single pagination slot before command retention runs.
  const candidates = await ctx.db.query("authAccounts")
    .withIndex("userIdAndProvider", (builder) =>
      cursorId === null ? builder : builder.gt("userId", cursorId))
    .take(numItems);
  let processed = 0;
  for (const candidate of candidates) {
    const user = await ctx.db.get(candidate.userId);
    if (user === null) continue;
    const orphan = await inspectLegacyOtpOrphanCandidate(ctx, user, now, "maintenance");
    if (orphan?.disposition !== "orphan_cleanup_eligible") continue;
    const { account, capacity, subject } = orphan;
    if (capacity.kind === "inline_reserved") throw new Error("Maintenance authority is corrupt.");
    const required = (capacity.kind === "reserved" ? 4 : 2)
      + (subject === undefined ? 0 : 1);
    if (processed + required > limit) throw new Error("Maintenance category exceeded its budget.");
    if (subject !== undefined) {
      await releaseServiceQuotaForDelete(ctx, subject);
    }
    await releaseQuotaForDelete(ctx, user._id, "identity", account);
    if (capacity.kind === "reserved") {
      await releaseQuotaForDelete(ctx, user._id, "identity", capacity.identity);
      await releaseQuotaForDelete(ctx, user._id, "job", capacity.job);
    }
    await releaseQuotaForStoredIdentity(ctx, user._id, user);
    await finalizeUserQuotaAuthorityForDelete(ctx, user._id);
    if (subject !== undefined) await ctx.db.delete(subject._id);
    await ctx.db.delete(account._id);
    if (capacity.kind === "reserved") {
      await ctx.db.delete(capacity.identity._id);
      await ctx.db.delete(capacity.job._id);
    }
    await ctx.db.delete(user._id);
    processed += required;
  }
  await ctx.db.patch(maintenance._id, {
    orphanedAuthUserCursor: candidates.length < numItems
      ? undefined
      : String(candidates.at(-1)?.userId),
  });
  return processed;
}

async function deleteExpiredBindChallenges(ctx: MutationCtx, now: number, limit: number): Promise<number> {
  const records = await ctx.db.query("deviceBindChallenges")
    .withIndex("by_expiry", (builder) => builder.lt("expiresAt", now))
    .take(limit);
  for (const record of records) {
    await releaseQuotaForDelete(ctx, record.userId, "custody", record);
    await ctx.db.delete(record._id);
  }
  return records.length;
}

async function deleteExpiredPresence(ctx: MutationCtx, now: number, limit: number): Promise<number> {
  const records = await ctx.db.query("devicePresence")
    .withIndex("by_presence_until", (builder) => builder.lt("presenceUntil", now))
    .take(limit);
  for (const record of records) {
    await releaseQuotaForDelete(ctx, record.userId, "device", record);
    await ctx.db.delete(record._id);
  }
  return records.length;
}

async function deleteExpiredIdempotency(ctx: MutationCtx, now: number, limit: number): Promise<number> {
  const records = await ctx.db.query("idempotencyReceipts")
    .withIndex("by_expiry", (builder) => builder.lt("expiresAt", now))
    .take(limit);
  for (const record of records) {
    await releaseQuotaForDelete(ctx, record.userId, "receipt", record);
    await ctx.db.delete(record._id);
  }
  return records.length;
}

async function expirePendingCommands(ctx: MutationCtx, now: number, limit: number): Promise<number> {
  const records = await ctx.db.query("sessionCommands")
    .withIndex("by_state_capacity_and_deadline", (builder) => builder
      .eq("state", "pending")
      .eq("lifecycleCapacityVersion", commandLifecycleCapacityVersion)
      .lt("deadline", now))
    .take(Math.min(limit, maximumCommandLifecycleBatch));
  for (const record of records) {
    const commandPatch = {
      nonterminal: false,
      state: "expired" as const,
      ...(record.requesterAcknowledgedAt === undefined
        ? {}
        : { terminalCleanupAfter: now + cloudRetentionMs.terminalCommand }),
      updatedAt: now,
    };
    await terminalizeSessionCommandWithLifecycleCapacity(ctx, record, commandPatch);
  }
  return records.length;
}

async function deleteTerminalCommands(
  ctx: MutationCtx,
  now: number,
  limit: number,
  maintenance?: DataModel["maintenanceState"]["document"],
): Promise<Readonly<{ paginationDone: boolean; processed: number; usedPagination: boolean }>> {
  if (maintenance === undefined) throw new Error("Maintenance authority is corrupt.");
  const commandLimit = Math.min(limit, maximumCommandLifecycleBatch);
  let remaining = commandLimit;
  const noEffectCutoff = now - commandTerminalRetentionMs;
  const noEffectQuery = () => ctx.db.query("sessionCommands")
    .withIndex("by_acknowledged_no_effect_cleanup", (builder) => builder
      .eq("state", "expired")
      .eq("lifecycleCapacityVersion", undefined)
      .eq("nonterminal", false)
      .eq("terminalCleanupAfter", undefined)
      .eq("receiptCapacityReservation", undefined)
      .eq("requesterReceiptAbandonedAt", undefined)
      .eq("operatorAbandonedAt", undefined)
      .eq("resultCode", undefined)
      .eq("resultDigest", undefined)
      .gt("requesterAcknowledgedAt", 0));
  const useNoEffectPagination = maintenance.sessionNoEffectCleanupCursor !== undefined
    || (await noEffectQuery().take(1)).length !== 0;
  const noEffectPage = useNoEffectPagination
    ? await noEffectQuery().paginate({
        cursor: maintenance.sessionNoEffectCleanupCursor ?? null,
        numItems: remaining,
      })
    : undefined;
  const noEffectRecords = noEffectPage?.page ?? [];
  for (const record of noEffectRecords) {
    // This broad physical index deliberately avoids adding a marker to an
    // exact-ceiling legacy row. Non-matching and not-yet-old rows advance the
    // bounded cursor without mutating externally visible receipt evidence.
    if (!isLegacyNoEffectExpiredTerminal(record)) continue;
    const [requester, target, session] = await Promise.all([
      ctx.db.get(record.requestingDeviceId),
      ctx.db.get(record.targetDeviceId),
      ctx.db.get(record.sessionId),
    ]);
    if (
      requester?.userId !== record.userId
      || target?.userId !== record.userId
      || session?.userId !== record.userId
      || session.executionDeviceId !== record.targetDeviceId
    ) throw new Error("Maintenance authority is corrupt.");
    if (record.updatedAt < noEffectCutoff) {
      await releaseCommandQuotaForDelete(ctx, record.userId, record);
      await ctx.db.delete(record._id);
    }
  }
  if (noEffectPage !== undefined) {
    await ctx.db.patch(maintenance._id, {
      sessionNoEffectCleanupCursor: noEffectPage.isDone
        ? undefined
        : noEffectPage.continueCursor,
    });
  }
  remaining -= noEffectRecords.length;
  for (const state of ["applied", "failed", "ambiguous", "cancelled", "expired"] as const) {
    if (remaining === 0) break;
    const records = await ctx.db.query("sessionCommands")
      .withIndex("by_state_and_cleanup_after", (builder) => builder
        .eq("state", state)
        .gt("terminalCleanupAfter", 0)
        .lt("terminalCleanupAfter", now))
      .take(remaining);
    for (const record of records) {
      const operatorAbandoned = isOperatorAbandonedEffectTerminal(record);
      const requesterAcknowledged = record.requesterAcknowledgedAt !== undefined;
      const requesterAbandoned = record.requesterReceiptAbandonedAt !== undefined;
      if (
        (record.operatorAbandonedAt !== undefined && !operatorAbandoned)
        || (requesterAcknowledged && requesterAbandoned)
        || record.receiptCapacityReservation !== undefined
      ) throw new Error("Maintenance authority is corrupt.");
      if (!operatorAbandoned && !requesterAcknowledged && !requesterAbandoned) {
        const patch = { terminalCleanupAfter: undefined, updatedAt: now };
        await adjustCommandQuotaForPatch(ctx, record.userId, record, patch);
        await ctx.db.patch(record._id, patch);
        continue;
      }
      if (operatorAbandoned) {
        await requireOperatorAbandonedSecurityEvent(ctx, record);
      }
      await releaseCommandQuotaForDelete(ctx, record.userId, record);
      await ctx.db.delete(record._id);
    }
    remaining -= records.length;
  }
  const legacyCutoff = now - commandTerminalRetentionMs;
  let legacyScanRemaining = remaining;
  for (const state of ["applied", "failed", "ambiguous", "cancelled", "expired"] as const) {
    if (remaining === 0 || legacyScanRemaining === 0) break;
    const records = await ctx.db.query("sessionCommands")
      .withIndex("by_state_unreserved_receipt_and_updated_at", (builder) => builder
        .eq("state", state)
        .eq("receiptCapacityReservation", undefined)
        .eq("requesterAcknowledgedAt", undefined)
        .eq("requesterReceiptAbandonedAt", undefined)
        .lt("updatedAt", legacyCutoff))
      .take(legacyScanRemaining);
    legacyScanRemaining -= records.length;
    for (const record of records) {
      const requester = await ctx.db.get(record.requestingDeviceId);
      if (requester?.userId !== record.userId) {
        throw new Error("Maintenance authority is corrupt.");
      }
      if (requester.status !== "revoked") {
        const patch = { updatedAt: now };
        if (logicalDocumentBytes({ ...record, ...patch }) > logicalDocumentBytes(record)) {
          throw new Error("Maintenance authority is corrupt.");
        }
        await adjustCommandQuotaForPatch(ctx, record.userId, record, patch);
        await ctx.db.patch(record._id, patch);
        remaining -= 1;
        continue;
      }
      if (
        requester.revokedAt === undefined
        || !Number.isSafeInteger(requester.revokedAt)
        || requester.revokedAt < 1
      ) throw new Error("Maintenance authority is corrupt.");
      if (requester.revokedAt >= legacyCutoff) {
        const patch = { updatedAt: Math.max(record.updatedAt, requester.revokedAt) };
        if (logicalDocumentBytes({ ...record, ...patch }) > logicalDocumentBytes(record)) {
          throw new Error("Maintenance authority is corrupt.");
        }
        await adjustCommandQuotaForPatch(ctx, record.userId, record, patch);
        await ctx.db.patch(record._id, patch);
        remaining -= 1;
        continue;
      }
      await releaseCommandQuotaForDelete(ctx, record.userId, record);
      await ctx.db.delete(record._id);
      remaining -= 1;
    }
  }
  return {
    paginationDone: noEffectPage?.isDone ?? true,
    processed: commandLimit - remaining,
    usedPagination: noEffectPage !== undefined,
  };
}

/*
 * Device commands share the session-command lifecycle, so a pending row past
 * its deadline expires and an acknowledged terminal row is later deleted.
 * Their login handoffs additionally have an independent short-lived result
 * sweep. Separate categories keep one table or lifecycle from starving another.
 */
async function expirePendingDeviceCommands(ctx: MutationCtx, now: number, limit: number): Promise<number> {
  const records = await ctx.db.query("deviceCommands")
    .withIndex("by_state_capacity_and_deadline", (builder) => builder
      .eq("state", "pending")
      .eq("lifecycleCapacityVersion", commandLifecycleCapacityVersion)
      .lt("deadline", now))
    .take(Math.min(limit, maximumCommandLifecycleBatch));
  for (const record of records) {
    const commandPatch = {
      nonterminal: false,
      state: "expired" as const,
      ...(record.requesterAcknowledgedAt === undefined
        ? {}
        : { terminalCleanupAfter: now + cloudRetentionMs.terminalCommand }),
      updatedAt: now,
    };
    await terminalizeDeviceCommandWithLifecycleCapacity(ctx, record, commandPatch);
  }
  return records.length;
}

/*
 * An account-login result is ciphertext, but it is still a short-lived provider
 * handoff. Its server-owned settlement deadline is independent of command
 * acknowledgement and terminal-row retention, so an abandoned browser cannot
 * leave the handoff stored indefinitely.
 */
export const expireDeviceCommandLoginResult = internalMutation({
  args: {
    commandPublicId: v.string(),
    resultExpiresAt: v.number(),
  },
  handler: async (ctx, args) => {
    await requireHardQuotaAuthority(ctx);
    if (
      !isUuidV7(args.commandPublicId)
      || !Number.isSafeInteger(args.resultExpiresAt)
      || args.resultExpiresAt < 1
    ) throw new Error("Invalid device-command login-result expiry.");
    const matches = await ctx.db.query("deviceCommands")
      .withIndex("by_public_id", (builder) => builder.eq("publicId", args.commandPublicId))
      .take(2);
    if (matches.length > 1) throw new Error("Maintenance authority is corrupt.");
    const record = matches[0];
    const legacyResultExpiresAt = record !== undefined
      && record.resultExpiresAt === undefined
      && record.kind === "account_login_start"
      && !record.nonterminal
      && record.state === "applied"
      && record.resultSingleUse === true
      && record.result !== undefined
      && record.resultConsumedAt === undefined
      ? record.updatedAt + deviceCommandLoginResultLifetimeMs
      : undefined;
    if (
      record === undefined
      || (record.resultExpiresAt ?? legacyResultExpiresAt) !== args.resultExpiresAt
    ) {
      return { status: "retired" as const };
    }
    const now = Date.now();
    if (now < args.resultExpiresAt) {
      await ctx.scheduler.runAt(args.resultExpiresAt, expireLoginResult, args);
      return { status: "pending" as const };
    }
    if (
      record.kind !== "account_login_start"
      || record.nonterminal
      || record.state !== "applied"
      || record.resultSingleUse !== true
      || record.result === undefined
      || record.resultConsumedAt !== undefined
    ) throw new Error("Maintenance authority is corrupt.");
    const commandPatch = {
      result: undefined,
      resultConsumedAt: now,
      resultExpiresAt: undefined,
      updatedAt: now,
    };
    await adjustCommandQuotaForPatch(ctx, record.userId, record, commandPatch);
    await ctx.db.patch(record._id, commandPatch);
    return { status: "erased" as const };
  },
});

async function expireDeviceCommandLoginResults(
  ctx: MutationCtx,
  now: number,
  limit: number,
): Promise<number> {
  const expired = await ctx.db.query("deviceCommands")
    .withIndex("by_single_use_result_expiry", (builder) => builder
      .eq("resultSingleUse", true)
      .eq("resultConsumedAt", undefined)
      .gt("resultExpiresAt", 0)
      .lte("resultExpiresAt", now))
    .take(limit);
  for (const record of expired) {
    if (
      record.kind !== "account_login_start"
      || record.nonterminal
      || record.state !== "applied"
      || record.result === undefined
      || record.resultExpiresAt === undefined
    ) throw new Error("Maintenance authority is corrupt.");
    const commandPatch = {
      result: undefined,
      resultConsumedAt: now,
      resultExpiresAt: undefined,
      updatedAt: now,
    };
    await adjustCommandQuotaForPatch(ctx, record.userId, record, commandPatch);
    await ctx.db.patch(record._id, commandPatch);
  }
  const remaining = limit - expired.length;
  if (remaining === 0) return limit;

  // Rows settled before `resultExpiresAt` existed cannot safely grow at a hard
  // byte ceiling. An already-expired row is erased immediately; a still-live
  // row is scheduled against the deterministic legacy deadline without a
  // document patch. Repeated sweep scheduling during this bounded five-minute
  // compatibility window is harmless because erasure is idempotent.
  const legacy = await ctx.db.query("deviceCommands")
    .withIndex("by_single_use_result_expiry", (builder) => builder
      .eq("resultSingleUse", true)
      .eq("resultConsumedAt", undefined)
      .eq("resultExpiresAt", undefined))
    .take(remaining);
  for (const record of legacy) {
    if (
      record.kind !== "account_login_start"
      || record.nonterminal
      || record.result === undefined
    ) throw new Error("Maintenance authority is corrupt.");
    const resultExpiresAt = record.updatedAt + deviceCommandLoginResultLifetimeMs;
    if (!Number.isSafeInteger(resultExpiresAt)) {
      throw new Error("Maintenance authority is corrupt.");
    }
    const erase = record.state !== "applied" || resultExpiresAt <= now;
    if (erase) {
      const commandPatch = {
        result: undefined,
        resultConsumedAt: now,
        resultExpiresAt: undefined,
        updatedAt: now,
      };
      await adjustCommandQuotaForPatch(ctx, record.userId, record, commandPatch);
      await ctx.db.patch(record._id, commandPatch);
    } else {
      await ctx.scheduler.runAt(resultExpiresAt, expireLoginResult, {
        commandPublicId: record.publicId,
        resultExpiresAt,
      });
    }
  }
  return expired.length + legacy.length;
}

async function deleteTerminalDeviceCommands(
  ctx: MutationCtx,
  now: number,
  limit: number,
  maintenance?: DataModel["maintenanceState"]["document"],
): Promise<Readonly<{ paginationDone: boolean; processed: number; usedPagination: boolean }>> {
  if (maintenance === undefined) throw new Error("Maintenance authority is corrupt.");
  const commandLimit = Math.min(limit, maximumCommandLifecycleBatch);
  let remaining = commandLimit;
  const noEffectCutoff = now - commandTerminalRetentionMs;
  const noEffectQuery = () => ctx.db.query("deviceCommands")
    .withIndex("by_acknowledged_no_effect_cleanup", (builder) => builder
      .eq("state", "expired")
      .eq("lifecycleCapacityVersion", undefined)
      .eq("nonterminal", false)
      .eq("terminalCleanupAfter", undefined)
      .eq("receiptCapacityReservation", undefined)
      .eq("requesterReceiptAbandonedAt", undefined)
      .eq("operatorAbandonedAt", undefined)
      .eq("resultCode", undefined)
      .eq("resultDigest", undefined)
      .gt("requesterAcknowledgedAt", 0));
  const useNoEffectPagination = maintenance.deviceNoEffectCleanupCursor !== undefined
    || (await noEffectQuery().take(1)).length !== 0;
  const noEffectPage = useNoEffectPagination
    ? await noEffectQuery().paginate({
        cursor: maintenance.deviceNoEffectCleanupCursor ?? null,
        numItems: remaining,
      })
    : undefined;
  const noEffectRecords = noEffectPage?.page ?? [];
  for (const record of noEffectRecords) {
    if (!isLegacyNoEffectExpiredTerminal(record)) continue;
    const [requester, target] = await Promise.all([
      ctx.db.get(record.requestingDeviceId),
      ctx.db.get(record.targetDeviceId),
    ]);
    if (requester?.userId !== record.userId || target?.userId !== record.userId) {
      throw new Error("Maintenance authority is corrupt.");
    }
    if (record.updatedAt < noEffectCutoff) {
      await releaseCommandQuotaForDelete(ctx, record.userId, record);
      await ctx.db.delete(record._id);
    }
  }
  if (noEffectPage !== undefined) {
    await ctx.db.patch(maintenance._id, {
      deviceNoEffectCleanupCursor: noEffectPage.isDone
        ? undefined
        : noEffectPage.continueCursor,
    });
  }
  remaining -= noEffectRecords.length;
  for (const state of ["applied", "failed", "ambiguous", "cancelled", "expired"] as const) {
    if (remaining === 0) break;
    const records = await ctx.db.query("deviceCommands")
      .withIndex("by_state_and_cleanup_after", (builder) => builder
        .eq("state", state)
        .gt("terminalCleanupAfter", 0)
        .lt("terminalCleanupAfter", now))
      .take(remaining);
    for (const record of records) {
      const operatorAbandoned = isOperatorAbandonedEffectTerminal(record);
      const requesterAcknowledged = record.requesterAcknowledgedAt !== undefined;
      const requesterAbandoned = record.requesterReceiptAbandonedAt !== undefined;
      if (
        (record.operatorAbandonedAt !== undefined && !operatorAbandoned)
        || (requesterAcknowledged && requesterAbandoned)
        || record.receiptCapacityReservation !== undefined
      ) throw new Error("Maintenance authority is corrupt.");
      if (!operatorAbandoned && !requesterAcknowledged && !requesterAbandoned) {
        const patch = { terminalCleanupAfter: undefined, updatedAt: now };
        await adjustCommandQuotaForPatch(ctx, record.userId, record, patch);
        await ctx.db.patch(record._id, patch);
        continue;
      }
      if (operatorAbandoned) {
        await requireOperatorAbandonedSecurityEvent(ctx, record);
      }
      await releaseCommandQuotaForDelete(ctx, record.userId, record);
      await ctx.db.delete(record._id);
    }
    remaining -= records.length;
  }
  const legacyCutoff = now - commandTerminalRetentionMs;
  let legacyScanRemaining = remaining;
  for (const state of ["applied", "failed", "ambiguous", "cancelled", "expired"] as const) {
    if (remaining === 0 || legacyScanRemaining === 0) break;
    const records = await ctx.db.query("deviceCommands")
      .withIndex("by_state_unreserved_receipt_and_updated_at", (builder) => builder
        .eq("state", state)
        .eq("receiptCapacityReservation", undefined)
        .eq("requesterAcknowledgedAt", undefined)
        .eq("requesterReceiptAbandonedAt", undefined)
        .lt("updatedAt", legacyCutoff))
      .take(legacyScanRemaining);
    legacyScanRemaining -= records.length;
    for (const record of records) {
      if (
        record.resultSingleUse === true
        && (
          record.result !== undefined
          || record.resultConsumedAt === undefined
          || record.resultExpiresAt !== undefined
        )
      ) throw new Error("Maintenance authority is corrupt.");
      const requester = await ctx.db.get(record.requestingDeviceId);
      if (requester?.userId !== record.userId) {
        throw new Error("Maintenance authority is corrupt.");
      }
      if (requester.status !== "revoked") {
        const patch = { updatedAt: now };
        if (logicalDocumentBytes({ ...record, ...patch }) > logicalDocumentBytes(record)) {
          throw new Error("Maintenance authority is corrupt.");
        }
        await adjustCommandQuotaForPatch(ctx, record.userId, record, patch);
        await ctx.db.patch(record._id, patch);
        remaining -= 1;
        continue;
      }
      if (
        requester.revokedAt === undefined
        || !Number.isSafeInteger(requester.revokedAt)
        || requester.revokedAt < 1
      ) throw new Error("Maintenance authority is corrupt.");
      if (requester.revokedAt >= legacyCutoff) {
        const patch = { updatedAt: Math.max(record.updatedAt, requester.revokedAt) };
        if (logicalDocumentBytes({ ...record, ...patch }) > logicalDocumentBytes(record)) {
          throw new Error("Maintenance authority is corrupt.");
        }
        await adjustCommandQuotaForPatch(ctx, record.userId, record, patch);
        await ctx.db.patch(record._id, patch);
        remaining -= 1;
        continue;
      }
      await releaseCommandQuotaForDelete(ctx, record.userId, record);
      await ctx.db.delete(record._id);
      remaining -= 1;
    }
  }
  return {
    paginationDone: noEffectPage?.isDone ?? true,
    processed: commandLimit - remaining,
    usedPagination: noEffectPage !== undefined,
  };
}

async function expirePendingAttentionNotifications(
  ctx: MutationCtx,
  now: number,
  limit: number,
): Promise<number> {
  const records = await ctx.db.query("attentionNotificationOutbox")
    .withIndex("by_state_and_claim_deadline", (builder) => builder
      .eq("state", "pending")
      .lt("claimDeadline", now))
    .take(limit);
  for (const record of records) {
    if (record.claimCapacityReservation !== attentionNotificationQuotaReservations.pending) {
      throw new Error("Maintenance authority is corrupt.");
    }
    const patch = {
      claimCapacityReservation: undefined,
      nonterminal: false,
      state: "expired" as const,
      terminalCleanupAfter: now + ATTENTION_NOTIFICATION_TERMINAL_RETENTION_MS,
      updatedAt: now,
    };
    await adjustCommandQuotaForPatch(ctx, record.userId, record, patch);
    await ctx.db.patch(record._id, patch);
  }
  return records.length;
}

async function closeUnsettledAttentionNotifications(
  ctx: MutationCtx,
  now: number,
  limit: number,
): Promise<number> {
  const fault = await readOldestPendingStoredAttentionNotificationSafetyFault(ctx);
  if (fault !== null) {
    const quarantine = await quarantineFaultedAttentionNotificationDelivery(
      ctx,
      fault.faultId,
      Math.min(limit, attentionNotificationQuarantineRowLimit),
    );
    if (quarantine.deleted > 0) return quarantine.deleted;
  }
  const seeds = await ctx.db.query("attentionNotificationOutbox")
    .withIndex("by_state_and_delivery_deadline", (builder) => builder
      .eq("state", "effect_started")
      .lt("delivery.deadline", now))
    .take(limit);
  const visited = new Set<string>();
  let processed = 0;
  for (const seed of seeds) {
    const seedDelivery = seed.delivery;
    if (seedDelivery === undefined || seedDelivery.settledAt !== undefined) {
      throw new Error("Maintenance authority is corrupt.");
    }
    if (visited.has(seedDelivery.id)) continue;
    visited.add(seedDelivery.id);
    const records = await ctx.db.query("attentionNotificationOutbox")
      .withIndex("by_delivery_id", (builder) => builder.eq("delivery.id", seedDelivery.id))
      .take(attentionNotificationGroupLimit + 1);
    if (records.length === 0) throw new Error("Maintenance authority is corrupt.");
    if (records.length > attentionNotificationGroupLimit) {
      await latchCorruptAttentionNotificationDelivery(ctx, seedDelivery.id);
      break;
    }
    if (records.length > limit - processed) break;
    const validated = await validatedStartedAttentionNotificationGroup(
      ctx,
      seedDelivery.id,
    );
    if (validated === null || validated.rows.some((record) =>
      record.delivery === undefined || record.delivery.deadline >= now)) {
      await latchCorruptAttentionNotificationDelivery(ctx, seedDelivery.id);
      break;
    }
    const exactRecords = validated.rows;
    const exactDelivery = exactRecords[0]?.delivery;
    if (exactDelivery === undefined) throw new Error("Maintenance authority is corrupt.");
    const settlementSafeAfter = Math.max(
      exactDelivery.deadline,
      exactDelivery.effectStartedAt + attentionNotificationRetryRecoveryMs,
      exactDelivery.nextAttemptAt ?? 0,
    );
    if (now <= settlementSafeAfter) continue;
    const outcomeCode = "unsettled_effect" as const;
    const outcomeDigest = await sha256Hex([
      "hra-attention-settlement:v1",
      seedDelivery.id,
      String(seedDelivery.generation),
      outcomeCode,
    ].join("\u0000"));
    for (const record of exactRecords) {
      const delivery = record.delivery;
      if (delivery === undefined) throw new Error("Maintenance authority is corrupt.");
      const deliveryWithoutRetry = { ...delivery };
      Reflect.deleteProperty(deliveryWithoutRetry, "nextAttemptAt");
      const patch = {
        claimCapacityReservation: undefined,
        delivery: {
          ...deliveryWithoutRetry,
          outcomeCode,
          outcomeDigest,
          settledAt: now,
        },
        nonterminal: false,
        state: "ambiguous" as const,
        terminalCleanupAfter: now + ATTENTION_NOTIFICATION_TERMINAL_RETENTION_MS,
        updatedAt: now,
      };
      await adjustCommandQuotaForPatch(ctx, record.userId, record, patch);
      await ctx.db.patch(record._id, patch);
    }
    const first = exactRecords[0];
    if (first?.faultCapacityAnchor === undefined) {
      throw new Error("Maintenance authority is corrupt.");
    }
    await releaseUnusedAttentionNotificationFaultCapacity(ctx, {
      anchorRowId: first.faultCapacityAnchor,
      deliveryId: exactDelivery.id,
      userId: first.userId,
    });
    processed += exactRecords.length;
  }
  return processed;
}

async function deleteTerminalAttentionNotifications(
  ctx: MutationCtx,
  now: number,
  limit: number,
): Promise<number> {
  let remaining = limit;
  for (const state of [
    "accepted",
    "refused",
    "ambiguous",
    "cancelled",
    "expired",
  ] as const) {
    if (remaining === 0) break;
    const records = await ctx.db.query("attentionNotificationOutbox")
      .withIndex("by_state_and_cleanup_after", (builder) => builder
        .eq("state", state)
        .gt("terminalCleanupAfter", 0)
        .lt("terminalCleanupAfter", now))
      .take(remaining);
    let deleted = 0;
    for (const record of records) {
      const locators = await ctx.db.query("attentionNotificationSafetyFaults")
        .withIndex("by_cleanup_row", (builder) => builder.eq("cleanupRowId", record._id))
        .take(2);
      if (locators.length > 1) throw new Error("Maintenance authority is corrupt.");
      if (locators[0]?.quarantineState === "pending") continue;
      await releaseCommandQuotaForDelete(ctx, record.userId, record);
      await ctx.db.delete(record._id);
      deleted += 1;
    }
    remaining -= deleted;
  }
  return limit - remaining;
}

async function deleteOperatorAbandonedCommandForSecurityEvent(
  ctx: MutationCtx,
  record: DataModel["securityEvents"]["document"],
  now: number,
): Promise<void> {
  if (record.event !== "command_terminal") return;
  const [sessionCommands, deviceCommands] = await Promise.all([
    ctx.db.query("sessionCommands")
      .withIndex("by_public_id", (builder) => builder.eq("publicId", record.entityId))
      .take(2),
    ctx.db.query("deviceCommands")
      .withIndex("by_public_id", (builder) => builder.eq("publicId", record.entityId))
      .take(2),
  ]);
  const commands = [...sessionCommands, ...deviceCommands];
  const operatorCommands = commands.filter((command) =>
    command.userId === record.userId
    && command.operatorAbandonedAt !== undefined);
  if (operatorCommands.length === 0) return;
  const command = operatorCommands[0];
  if (
    command === undefined
    || operatorCommands.length !== 1
    || command.userId !== record.userId
    || !isOperatorAbandonedEffectTerminal(command)
    || command.terminalCleanupAfter === undefined
    || command.terminalCleanupAfter >= now
  ) throw new Error("Maintenance authority is corrupt.");
  await requireOperatorAbandonedSecurityEvent(ctx, command);
  await releaseCommandQuotaForDelete(ctx, command.userId, command);
  await ctx.db.delete(command._id);
}

async function deleteExpiredSecurityEvents(ctx: MutationCtx, now: number, limit: number): Promise<number> {
  const records = await ctx.db.query("securityEvents")
    .withIndex("by_created_at", (builder) => builder
      .lt("createdAt", now - cloudRetentionMs.securityEvent))
    .take(Math.min(limit, maximumCommandLifecycleBatch));
  for (const record of records) {
    await deleteOperatorAbandonedCommandForSecurityEvent(ctx, record, now);
    await releaseQuotaForDelete(ctx, record.userId, "security", record);
    await ctx.db.delete(record._id);
  }
  return records.length;
}

async function deleteExpiredUsage(ctx: MutationCtx, now: number, limit: number): Promise<number> {
  const records = await ctx.db.query("accountUsageSnapshots")
    .withIndex("by_received_at", (builder) => builder
      .lt("receivedAt", now - cloudRetentionMs.usageSnapshot))
    .take(limit);
  for (const record of records) {
    let snapshotQuotaReleased = false;
    const bindings = await ctx.db.query("deviceAccountBindings")
      .withIndex("by_device_and_account", (builder) => builder
        .eq("deviceId", record.sourceDeviceId)
        .eq("accountId", record.accountId))
      .take(2);
    if (bindings.length > 1) throw new Error("USAGE_RETENTION_AUTHORITY_CORRUPT");
    const binding = bindings[0];
    if (binding !== undefined && binding.usageAdmission === undefined) {
      if (binding.userId !== record.userId) {
        throw new Error("USAGE_RETENTION_AUTHORITY_CORRUPT");
      }
      const latest = (await ctx.db.query("accountUsageSnapshots")
        .withIndex("by_source_revision", (builder) => builder
          .eq("accountId", record.accountId)
          .eq("sourceDeviceId", record.sourceDeviceId))
        .order("desc")
        .take(1))[0];
      if (
        latest !== undefined
        && latest._id === record._id
      ) {
        if (
          latest.userId !== record.userId
          || latest.sourceDevicePublicId !== record.sourceDevicePublicId
        ) throw new Error("USAGE_RETENTION_AUTHORITY_CORRUPT");
        const patch = {
          updatedAt: Math.max(binding.updatedAt, now),
          usageAdmission: {
            cursor: {
              digest: latest.digest,
              disposition: "stored" as const,
              observedAt: latest.observedAt,
              sourceRevision: latest.sourceRevision,
            },
            lastAcceptedAt: latest.receivedAt,
          },
        } as const;
        await releaseAccountUsageSnapshotQuotaForDelete(
          ctx,
          record.userId,
          record.accountId,
          record,
        );
        snapshotQuotaReleased = true;
        await adjustQuotaForPatch(ctx, record.userId, "account", binding, patch);
        await ctx.db.patch(binding._id, patch);
      }
    }
    if (!snapshotQuotaReleased) {
      await releaseAccountUsageSnapshotQuotaForDelete(
        ctx,
        record.userId,
        record.accountId,
        record,
      );
    }
    await ctx.db.delete(record._id);
  }
  return records.length;
}

async function deleteExpiredAccountReceipts(ctx: MutationCtx, now: number, limit: number): Promise<number> {
  const records = await ctx.db.query("accountDeletionReceipts")
    .withIndex("by_expiry", (builder) => builder.lt("expiresAt", now))
    .take(limit);
  for (const record of records) {
    await releaseServiceQuotaForDelete(ctx, record);
    await ctx.db.delete(record._id);
  }
  return records.length;
}

async function deleteCompletedRevocationJobs(ctx: MutationCtx, now: number, limit: number): Promise<number> {
  const records = await ctx.db.query("deviceRevocationJobs")
    .withIndex("by_state_and_updated_at", (builder) => builder
      .eq("state", "complete")
      .lt("updatedAt", now - cloudRetentionMs.deviceRevocationJob))
    .take(limit);
  for (const record of records) {
    await releaseQuotaForDelete(ctx, record.userId, "job", record);
    await ctx.db.delete(record._id);
  }
  return records.length;
}

/*
 * live_tail retention: detail-stream chunks carry an expiresAt deadline set at
 * append time. Expired rows are removed per session behind one detail
 * retention epoch per session per sweep, so digest-chain verification of the
 * surviving tail stays valid, and both the session_chunk charge and the
 * live_chunk resource counter are released.
 */
async function deleteExpiredLiveTailChunks(ctx: MutationCtx, now: number, limit: number): Promise<number> {
  const expired = await ctx.db.query("sessionChunks")
    .withIndex("by_stream_and_expires_at", (builder) => builder
      .eq("stream", "detail")
      .lt("expiresAt", now))
    .take(limit);
  if (expired.length === 0) return 0;
  const bySession = new Map<string, typeof expired>();
  for (const chunk of expired) {
    const list = bySession.get(chunk.sessionId) ?? [];
    list.push(chunk);
    bySession.set(chunk.sessionId, list);
  }
  let deleted = 0;
  for (const chunks of bySession.values()) {
    const first = chunks[0];
    if (first === undefined) continue;
    const session = await ctx.db.get(first.sessionId);
    if (session === null) {
      for (const chunk of chunks) {
        await releaseSessionChunkQuotaForDelete(ctx, chunk.userId, chunk);
        await releaseLiveChunkResourceForDelete(ctx, chunk.userId);
        await ctx.db.delete(chunk._id);
        deleted += 1;
      }
      continue;
    }
    chunks.sort((left, right) => left.firstSequence - right.firstSequence);
    const last = chunks.at(-1);
    if (last === undefined) continue;
    await beginDetailRetentionEpoch(ctx, session, last.lastSequence, last.digest);
    for (const chunk of chunks) {
      if (chunk.userId !== session.userId) throw new Error("Maintenance authority is corrupt.");
      await releaseSessionChunkQuotaForDelete(ctx, session.userId, chunk);
      await releaseLiveChunkResourceForDelete(ctx, session.userId);
      await ctx.db.delete(chunk._id);
      deleted += 1;
    }
  }
  return deleted;
}

const handlers = {
  live_tail_chunks: deleteExpiredLiveTailChunks,
  auth_attempts: deleteExpiredAuthAttempts,
  otp_challenges: deleteExpiredOtpChallenges,
  auth_invites: deleteExpiredInvites,
  abandoned_identities: cleanAbandonedIdentity,
  bind_challenges: deleteExpiredBindChallenges,
  device_presence: deleteExpiredPresence,
  idempotency_receipts: deleteExpiredIdempotency,
  pending_commands: expirePendingCommands,
  pending_device_commands: expirePendingDeviceCommands,
  device_command_login_results: expireDeviceCommandLoginResults,
  pending_attention_notifications: expirePendingAttentionNotifications,
  started_attention_notifications: closeUnsettledAttentionNotifications,
  terminal_attention_notifications: deleteTerminalAttentionNotifications,
  attention_notification_faults: deleteExpiredAttentionNotificationSafetyFaults,
  security_events: deleteExpiredSecurityEvents,
  usage_snapshots: deleteExpiredUsage,
  account_deletion_receipts: deleteExpiredAccountReceipts,
  device_revocation_jobs: deleteCompletedRevocationJobs,
} as const satisfies Readonly<Record<
  Exclude<
    MaintenanceCategory,
    "orphaned_auth_users" | "terminal_commands" | "terminal_device_commands"
  >,
  (ctx: MutationCtx, now: number, limit: number) => Promise<number>
>>;

const emptyCounts = (): CleanupCounts => ({
  abandonedIdentities: 0,
  orphanedAuthUsers: 0,
  accountDeletionReceipts: 0,
  authAttempts: 0,
  authInvites: 0,
  bindChallenges: 0,
  devicePresence: 0,
  deviceRevocationJobs: 0,
  deviceCommandLoginResults: 0,
  expiredPendingAttentionNotifications: 0,
  expiredPendingCommands: 0,
  expiredPendingDeviceCommands: 0,
  idempotencyReceipts: 0,
  liveTailChunks: 0,
  otpChallenges: 0,
  securityEvents: 0,
  startedAttentionNotifications: 0,
  terminalAttentionNotifications: 0,
  attentionNotificationFaults: 0,
  terminalCommands: 0,
  terminalDeviceCommands: 0,
  usageSnapshots: 0,
});

export const cleanupExpired = internalMutation({
  args: { limit: v.number() },
  handler: async (ctx, args) => {
    await requireHardQuotaAuthority(ctx);
    let remaining = requireCleanupLimit(args.limit);
    const now = Date.now();
    const counts = emptyCounts();
    const states = await ctx.db.query("maintenanceState")
      .withIndex("by_key", (builder) => builder.eq("key", "retention"))
      .take(2);
    if (states.length > 1) throw new Error("Maintenance authority is corrupt.");
    let state = states[0];
    const start = state === undefined
      ? 0
      : maintenanceCategories.indexOf(state.nextCategory);
    if (start < 0) throw new Error("Maintenance authority is corrupt.");
    if (state === undefined) {
      const stateId = await ctx.db.insert("maintenanceState", {
        key: "retention",
        nextCategory: maintenanceCategories[0],
        updatedAt: now,
      });
      state = await ctx.db.get(stateId) ?? undefined;
      if (state === undefined) throw new Error("Maintenance authority is corrupt.");
    }
    let visited = 0;
    let forcedNextCategory: MaintenanceCategory | undefined;
    while (remaining > 0 && visited < maintenanceCategories.length) {
      const category = maintenanceCategories[(start + visited) % maintenanceCategories.length];
      if (category === undefined) throw new Error("Maintenance category is unavailable.");
      const budget = Math.min(categoryQuantum, remaining);
      let terminalResult: Readonly<{
        paginationDone: boolean;
        processed: number;
        usedPagination: boolean;
      }> | undefined;
      let processed: number;
      if (category === "orphaned_auth_users") {
        terminalResult = undefined;
        processed = await cleanOrphanedAuthUsers(ctx, now, budget, state);
      } else if (category === "terminal_commands") {
        terminalResult = await deleteTerminalCommands(ctx, now, budget, state);
        processed = terminalResult.processed;
      } else if (category === "terminal_device_commands") {
        terminalResult = await deleteTerminalDeviceCommands(ctx, now, budget, state);
        processed = terminalResult.processed;
      } else {
        terminalResult = undefined;
        processed = await handlers[category](ctx, now, budget);
      }
      if (!Number.isSafeInteger(processed) || processed < 0 || processed > budget) {
        throw new Error("Maintenance category exceeded its budget.");
      }
      counts[countField[category]] += processed;
      remaining -= processed;
      visited += 1;
      // Convex permits one paginated query per function. Stop after either
      // command cleanup page, but always advance the global category. The
      // per-table cursor resumes on the next full rotation so a large rollout
      // backlog cannot monopolize retention for every intervening cron run.
      if (terminalResult?.usedPagination === true) {
        forcedNextCategory = maintenanceCategories[
          (start + visited) % maintenanceCategories.length
        ];
        break;
      }
    }
    const nextCategory = forcedNextCategory
      ?? maintenanceCategories[(start + visited) % maintenanceCategories.length];
    if (nextCategory === undefined) throw new Error("Maintenance category is unavailable.");
    await ctx.db.patch(state._id, { nextCategory, updatedAt: now });
    return {
      ...counts,
      nextCategory,
      processed: args.limit - remaining,
      visitedCategories: visited,
    };
  },
});
