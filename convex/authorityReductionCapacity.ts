import type { GenericId as Id, Value } from "convex/values";

import { isCanonicalAuthEmail } from "../src/cloud/authCredentials";
import { isFiniteTimestamp, isSafePositiveInteger } from "../src/cloud/contracts";
import { digestAuthEmail } from "./authEmail";
import { hasExactAccountDeletionJobCapacity } from "./jobLifecycleCapacity";
import {
  consumeAuthorityReductionPatchReservationQuota,
  replaceAuthorityReductionReservationQuota,
  reserveQuotaForInsert,
} from "./quota";
import type { DataModel, MutationCtx, QueryCtx } from "./server";
import {
  authorityReductionCapacityReservation,
  authorityReductionCapacityVersion,
} from "./validators";

type AccountIdentityReservation =
  DataModel["accountDeletionIdentityReservations"]["document"];
type AccountJobReservation =
  DataModel["accountDeletionJobReservations"]["document"];
type DeviceReservation =
  DataModel["deviceRevocationDeviceReservations"]["document"];
type DeviceJobReservation =
  DataModel["deviceRevocationJobReservations"]["document"];
type DeviceSecurityReservation =
  DataModel["deviceRevocationSecurityReservations"]["document"];
export type DeviceReceiptReservation =
  DataModel["deviceRevocationReceiptReservations"]["document"];

export type AccountDeletionCapacity = Readonly<{
  identity: AccountIdentityReservation;
  job: AccountJobReservation;
  kind: "reserved";
}> | Readonly<{ kind: "legacy" }>;

export type DeviceRevocationCapacity = Readonly<{
  device: DeviceReservation;
  job: DeviceJobReservation;
  receipt: DeviceReceiptReservation;
  security: DeviceSecurityReservation;
  kind: "reserved";
}> | Readonly<{ kind: "legacy" }>;

type LogicalDocument = Readonly<Record<string, Value | undefined>>;
const oompaOtpProviderId = "hra-control-plane-otp-v1";
export const authorityReductionOrphanRetentionMs = 24 * 60 * 60 * 1_000;

export type AuthorityReductionCapacityDisposition =
  | "ready"
  | "capacity_missing"
  | "orphan_cleanup_pending"
  | "orphan_cleanup_eligible"
  | "topology_blocked";

export type LegacyOtpOrphanCandidate = Readonly<{
  account: DataModel["authAccounts"]["document"];
  capacity: AccountDeletionCapacity;
  disposition: "orphan_cleanup_eligible";
  subject?: DataModel["authSubjects"]["document"];
}> | Readonly<{ disposition: "orphan_cleanup_pending" }>;

function corrupt(): never {
  throw new Error("AUTHORITY_REDUCTION_CAPACITY_CORRUPT");
}

function isCapacityCorruption(error: unknown): boolean {
  return error instanceof Error
    && (
      error.message === "AUTHORITY_REDUCTION_CAPACITY_CORRUPT"
      || error.message === "DURABLE_JOB_CAPACITY_CORRUPT"
    );
}

async function hasExactOompaAuthTopology(
  ctx: QueryCtx | MutationCtx,
  user: DataModel["users"]["document"],
): Promise<boolean> {
  if (!isCanonicalAuthEmail(user.email)) return false;
  const emailDigest = await digestAuthEmail(user.email);
  const [accounts, subjects, subjectsByDigest] = await Promise.all([
    ctx.db.query("authAccounts")
      .withIndex("userIdAndProvider", (builder) => builder.eq("userId", user._id))
      .take(2),
    ctx.db.query("authSubjects")
      .withIndex("by_user", (builder) => builder.eq("userId", user._id))
      .take(2),
    ctx.db.query("authSubjects")
      .withIndex("by_email_digest", (builder) => builder.eq("emailDigest", emailDigest))
      .take(2),
  ]);
  const account = accounts[0];
  const subject = subjects[0];
  if (
    accounts.length !== 1
    || account === undefined
    || account.provider !== oompaOtpProviderId
    || account.providerAccountId !== user.email
    || account.userId !== user._id
    || subjects.length !== 1
    || subject === undefined
    || subject.status !== "active"
    || subject.userId !== user._id
    || subject.emailDigest !== emailDigest
    || !isSafePositiveInteger(subject.authEpoch)
    || subjectsByDigest.length !== 1
    || subjectsByDigest[0]?._id !== subject._id
  ) return false;
  if (user.emailVerificationTime === undefined) {
    return subject.verifiedAt === undefined && account.emailVerified === undefined;
  }
  return isFiniteTimestamp(user.emailVerificationTime)
    && (subject.verifiedAt === undefined
      || subject.verifiedAt === user.emailVerificationTime)
    && account.emailVerified === user.email;
}

async function hasExactDrainingDeletionTopology(
  ctx: QueryCtx | MutationCtx,
  user: DataModel["users"]["document"],
  job: DataModel["accountDeletionJobs"]["document"],
): Promise<boolean> {
  const [identityReservations, jobReservations, subjects] = await Promise.all([
    ctx.db.query("accountDeletionIdentityReservations")
      .withIndex("by_user", (builder) => builder.eq("userId", user._id))
      .take(2),
    ctx.db.query("accountDeletionJobReservations")
      .withIndex("by_user", (builder) => builder.eq("userId", user._id))
      .take(2),
    ctx.db.query("authSubjects")
      .withIndex("by_user", (builder) => builder.eq("userId", user._id))
      .take(2),
  ]);
  const subject = subjects[0];
  return job.userId === user._id
    && (job.state === "pending" || job.state === "draining")
    && (job.capacityReservation === undefined
      || hasExactAccountDeletionJobCapacity(job))
    && identityReservations.length === 0
    && jobReservations.length === 0
    && subjects.length === 1
    && subject !== undefined
    && subject._id === job.subjectId
    && subject.userId === user._id
    && subject.status === "disabled";
}

function canonicalReservation(
  reservation: Readonly<{
    capacityReservation: string;
    capacityVersion: number;
    category: string;
    createdAt: number;
    userId: Id<"users">;
  }>,
  userId: Id<"users">,
  category: "device" | "identity" | "job" | "receipt" | "security",
): boolean {
  return reservation.userId === userId
    && reservation.capacityVersion === authorityReductionCapacityVersion
    && reservation.capacityReservation === authorityReductionCapacityReservation
    && reservation.category === category
    && isFiniteTimestamp(reservation.createdAt);
}

export async function loadAccountDeletionCapacity(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
): Promise<AccountDeletionCapacity> {
  const [identityRows, jobRows] = await Promise.all([
    ctx.db.query("accountDeletionIdentityReservations")
      .withIndex("by_user", (builder) => builder.eq("userId", userId))
      .take(2),
    ctx.db.query("accountDeletionJobReservations")
      .withIndex("by_user", (builder) => builder.eq("userId", userId))
      .take(2),
  ]);
  if (identityRows.length === 0 && jobRows.length === 0) {
    return { kind: "legacy" };
  }
  const identity = identityRows[0];
  const job = jobRows[0];
  if (
    identityRows.length !== 1
    || jobRows.length !== 1
    || identity === undefined
    || job === undefined
    || !canonicalReservation(identity, userId, "identity")
    || !canonicalReservation(job, userId, "job")
    || identity.createdAt !== job.createdAt
  ) corrupt();
  return { identity, job, kind: "reserved" };
}

export async function loadDeviceRevocationCapacity(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
  deviceId: Id<"devices">,
): Promise<DeviceRevocationCapacity> {
  const [deviceRows, jobRows, securityRows, receiptRows] = await Promise.all([
    ctx.db.query("deviceRevocationDeviceReservations")
      .withIndex("by_device", (builder) => builder.eq("deviceId", deviceId))
      .take(2),
    ctx.db.query("deviceRevocationJobReservations")
      .withIndex("by_device", (builder) => builder.eq("deviceId", deviceId))
      .take(2),
    ctx.db.query("deviceRevocationSecurityReservations")
      .withIndex("by_device", (builder) => builder.eq("deviceId", deviceId))
      .take(2),
    ctx.db.query("deviceRevocationReceiptReservations")
      .withIndex("by_device", (builder) => builder.eq("deviceId", deviceId))
      .take(2),
  ]);
  if (
    deviceRows.length === 0
    && jobRows.length === 0
    && securityRows.length === 0
    && receiptRows.length === 0
  ) return { kind: "legacy" };
  const device = deviceRows[0];
  const job = jobRows[0];
  const security = securityRows[0];
  const receipt = receiptRows[0];
  if (
    deviceRows.length !== 1
    || jobRows.length !== 1
    || securityRows.length !== 1
    || receiptRows.length !== 1
    || device === undefined
    || job === undefined
    || security === undefined
    || receipt === undefined
    || device.deviceId !== deviceId
    || job.deviceId !== deviceId
    || security.deviceId !== deviceId
    || receipt.deviceId !== deviceId
    || !canonicalReservation(device, userId, "device")
    || !canonicalReservation(job, userId, "job")
    || !canonicalReservation(security, userId, "security")
    || !canonicalReservation(receipt, userId, "receipt")
    || ![device, job, security, receipt].every((row) =>
      row.deviceId === deviceId)
    || ![device, job, security, receipt].every((row) =>
      row.createdAt === device.createdAt)
  ) corrupt();
  return { device, job, kind: "reserved", receipt, security };
}

export async function createAccountDeletionCapacityForNewUser(
  ctx: MutationCtx,
  userId: Id<"users">,
): Promise<void> {
  const user = await ctx.db.get(userId);
  if (user === null || (await loadAccountDeletionCapacity(ctx, userId)).kind !== "legacy") {
    corrupt();
  }
  const now = Date.now();
  const identityDocument = {
    capacityReservation: authorityReductionCapacityReservation,
    capacityVersion: authorityReductionCapacityVersion,
    category: "identity" as const,
    createdAt: now,
    userId,
  } as const;
  const jobDocument = { ...identityDocument, category: "job" as const };
  const jobId = await ctx.db.insert("accountDeletionJobReservations", jobDocument);
  const storedJob = await ctx.db.get(jobId);
  if (storedJob === null) corrupt();
  await reserveQuotaForInsert(ctx, userId, "job", storedJob);
  const identityId = await ctx.db.insert(
    "accountDeletionIdentityReservations",
    identityDocument,
  );
  const storedIdentity = await ctx.db.get(identityId);
  if (storedIdentity === null) corrupt();
  await reserveQuotaForInsert(ctx, userId, "identity", storedIdentity);
}

export async function createDeviceRevocationCapacityForNewDevice(
  ctx: MutationCtx,
  userId: Id<"users">,
  deviceId: Id<"devices">,
): Promise<void> {
  const device = await ctx.db.get(deviceId);
  if (
    device?.userId !== userId
    || device.status === "revoked"
    || (await loadDeviceRevocationCapacity(ctx, userId, deviceId)).kind !== "legacy"
  ) corrupt();
  const common = {
    capacityReservation: authorityReductionCapacityReservation,
    capacityVersion: authorityReductionCapacityVersion,
    createdAt: Date.now(),
    deviceId,
    userId,
  } as const;
  const reservations = [
    ["deviceRevocationDeviceReservations", "device"],
    ["deviceRevocationJobReservations", "job"],
    ["deviceRevocationSecurityReservations", "security"],
    ["deviceRevocationReceiptReservations", "receipt"],
  ] as const;
  for (const [table, category] of reservations) {
    const document = { ...common, category };
    const id = await ctx.db.insert(table, document);
    const stored = await ctx.db.get(id);
    if (stored === null) corrupt();
    await reserveQuotaForInsert(ctx, userId, category, stored);
  }
}

// This is the single structural and age predicate used both by rollout
// classification and by the scheduled deletion sweep. Callers may observe an
// eligible orphan, but only maintenance owns its deletion.
export async function inspectLegacyOtpOrphanCandidate(
  ctx: QueryCtx | MutationCtx,
  user: DataModel["users"]["document"],
  now: number,
  validation: "diagnostic" | "maintenance" = "diagnostic",
): Promise<LegacyOtpOrphanCandidate | null> {
  const cutoff = now - authorityReductionOrphanRetentionMs;
  // Preserve the cleanup sweep's historical staging: a fresh predecessor
  // write is skipped before any later ambiguity or partial-capacity probe can
  // abort the cron. Diagnostic callers still validate the entire shape.
  if (validation === "maintenance" && user._creationTime >= cutoff) {
    return { disposition: "orphan_cleanup_pending" };
  }
  if (
    user.emailVerificationTime !== undefined
    || user.phoneVerificationTime !== undefined
    || user.isAnonymous !== undefined
    || user.phone !== undefined
  ) return null;
  const [accounts, boundSubjects, challenges, deletionJob, device, session] = await Promise.all([
    ctx.db.query("authAccounts")
      .withIndex("userIdAndProvider", (builder) => builder.eq("userId", user._id))
      .take(2),
    ctx.db.query("authSubjects")
      .withIndex("by_user", (builder) => builder.eq("userId", user._id))
      .take(2),
    ctx.db.query("authOtpChallenges")
      .withIndex("by_user", (builder) => builder.eq("userId", user._id))
      .take(1),
    ctx.db.query("accountDeletionJobs")
      .withIndex("by_user", (builder) => builder.eq("userId", user._id))
      .first(),
    ctx.db.query("devices")
      .withIndex("by_user_and_public_id", (builder) => builder.eq("userId", user._id))
      .first(),
    ctx.db.query("authSessions")
      .withIndex("userId", (builder) => builder.eq("userId", user._id))
      .first(),
  ]);
  if (
    accounts.length !== 1
    || boundSubjects.length !== 0
    || challenges.length !== 0
    || deletionJob !== null
    || device !== null
    || session !== null
  ) return null;
  const account = accounts[0];
  if (
    account === undefined
    || account.provider !== oompaOtpProviderId
    || account.emailVerified !== undefined
    || !isCanonicalAuthEmail(account.providerAccountId)
    || user.email !== account.providerAccountId
  ) return null;
  if (validation === "maintenance" && account._creationTime >= cutoff) {
    return { disposition: "orphan_cleanup_pending" };
  }
  const emailDigest = await digestAuthEmail(account.providerAccountId);
  const matchingSubjects = await ctx.db.query("authSubjects")
    .withIndex("by_email_digest", (builder) => builder.eq("emailDigest", emailDigest))
    .take(2);
  if (matchingSubjects.length > 1) corrupt();
  const subject = matchingSubjects[0];
  if (
    subject !== undefined
    && (
      subject.userId !== undefined
      || subject.status !== "active"
      || subject.verifiedAt !== undefined
    )
  ) return null;
  if (
    validation === "maintenance"
    && subject !== undefined
    && (subject.createdAt >= cutoff || subject.updatedAt >= cutoff)
  ) return { disposition: "orphan_cleanup_pending" };
  const verificationCode = await ctx.db.query("authVerificationCodes")
    .withIndex("accountId", (builder) => builder.eq("accountId", account._id))
    .first();
  if (verificationCode !== null) return null;
  const capacity = await loadAccountDeletionCapacity(ctx, user._id);
  if (
    validation === "maintenance"
    && capacity.kind === "reserved"
    && (capacity.identity.createdAt >= cutoff || capacity.job.createdAt >= cutoff)
  ) return { disposition: "orphan_cleanup_pending" };
  const eligible = user._creationTime < cutoff
    && account._creationTime < cutoff
    && (subject === undefined
      || (subject.createdAt < cutoff && subject.updatedAt < cutoff))
    && (capacity.kind === "legacy"
      || (capacity.identity.createdAt < cutoff && capacity.job.createdAt < cutoff));
  return eligible
    ? {
        account,
        capacity,
        disposition: "orphan_cleanup_eligible",
        ...(subject === undefined ? {} : { subject }),
      }
    : { disposition: "orphan_cleanup_pending" };
}

export type AuthorityReductionCapacityInspection = Readonly<{
  accountPairs: 0 | 1;
  deviceQuartets: number;
  disposition: "capacity_missing";
  missing: number;
}> | Readonly<{
  disposition: Exclude<AuthorityReductionCapacityDisposition, "capacity_missing">;
  missing: number;
}>;

export async function inspectAuthorityReductionCapacityForUser(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
  now: number,
): Promise<AuthorityReductionCapacityInspection> {
  const [user, deletionJobs, devices] = await Promise.all([
    ctx.db.get(userId),
    ctx.db.query("accountDeletionJobs")
      .withIndex("by_user", (builder) => builder.eq("userId", userId))
      .take(2),
    ctx.db.query("devices")
      .withIndex("by_user_and_public_id", (builder) => builder.eq("userId", userId))
      .take(17),
  ]);
  if (user === null || deletionJobs.length > 1 || devices.length > 16) {
    return { disposition: "topology_blocked", missing: 1 };
  }
  try {
    const deletionJob = deletionJobs[0];
    if (deletionJob !== undefined) {
      return await hasExactDrainingDeletionTopology(ctx, user, deletionJob)
        ? { disposition: "ready", missing: 0 }
        : { disposition: "topology_blocked", missing: 1 };
    }
    if (!(await hasExactOompaAuthTopology(ctx, user))) {
      const orphan = await inspectLegacyOtpOrphanCandidate(ctx, user, now);
      return orphan === null
        ? { disposition: "topology_blocked", missing: 1 }
        : { disposition: orphan.disposition, missing: 1 };
    }
    const accountPairs = (await loadAccountDeletionCapacity(ctx, userId)).kind === "legacy" ? 1 : 0;
    let deviceQuartets = 0;
    for (const device of devices) {
      const capacity = await loadDeviceRevocationCapacity(ctx, userId, device._id);
      if (device.status === "revoked") {
        if (capacity.kind !== "legacy") return { disposition: "topology_blocked", missing: 1 };
      } else if (capacity.kind === "legacy") {
        deviceQuartets += 1;
      }
    }
    const missing = accountPairs + deviceQuartets;
    return missing === 0
      ? { disposition: "ready", missing: 0 }
      : { accountPairs, deviceQuartets, disposition: "capacity_missing", missing };
  } catch (error: unknown) {
    if (isCapacityCorruption(error)) {
      return { disposition: "topology_blocked", missing: 1 };
    }
    throw error;
  }
}

export async function classifyAuthorityReductionCapacityForUser(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
  now: number,
): Promise<Readonly<{
  disposition: AuthorityReductionCapacityDisposition;
  missing: number;
}>> {
  const { disposition, missing } = await inspectAuthorityReductionCapacityForUser(ctx, userId, now);
  return { disposition, missing };
}

export async function backfillAuthorityReductionCapacityForUser(
  ctx: MutationCtx,
  userId: Id<"users">,
): Promise<Readonly<{ reserved: number }>> {
  const [user, deletionJobs, devices] = await Promise.all([
    ctx.db.get(userId),
    ctx.db.query("accountDeletionJobs")
      .withIndex("by_user", (builder) => builder.eq("userId", userId))
      .take(2),
    ctx.db.query("devices")
      .withIndex("by_user_and_public_id", (builder) => builder.eq("userId", userId))
      .take(17),
  ]);
  if (
    user === null
    || deletionJobs.length > 1
    || devices.length > 16
  ) corrupt();
  const deletionJob = deletionJobs[0];
  if (deletionJob !== undefined) {
    if (!(await hasExactDrainingDeletionTopology(ctx, user, deletionJob))) corrupt();
    return { reserved: 0 };
  }
  if (!(await hasExactOompaAuthTopology(ctx, user))) corrupt();
  let reserved = 0;
  if ((await loadAccountDeletionCapacity(ctx, userId)).kind === "legacy") {
    await createAccountDeletionCapacityForNewUser(ctx, userId);
    reserved += 1;
  }
  for (const device of devices) {
    const capacity = await loadDeviceRevocationCapacity(ctx, userId, device._id);
    if (device.status === "revoked") {
      if (capacity.kind !== "legacy") corrupt();
      continue;
    }
    if (capacity.kind === "legacy") {
      await createDeviceRevocationCapacityForNewDevice(ctx, userId, device._id);
      reserved += 1;
    }
  }
  return { reserved };
}

export async function consumeAccountDeletionCapacity(
  ctx: MutationCtx,
  capacity: Extract<AccountDeletionCapacity, { kind: "reserved" }>,
  subject: DataModel["authSubjects"]["document"],
  subjectPatch: LogicalDocument,
  jobDocument: Omit<DataModel["accountDeletionJobs"]["document"], "_creationTime" | "_id">,
): Promise<void> {
  if (subject.userId !== capacity.identity.userId) corrupt();
  await consumeAuthorityReductionPatchReservationQuota(
    ctx,
    capacity.identity.userId,
    "identity",
    capacity.identity,
    subject,
    subjectPatch,
  );
  const jobId = await ctx.db.insert("accountDeletionJobs", jobDocument);
  const storedJob = await ctx.db.get(jobId);
  if (storedJob === null) corrupt();
  await replaceAuthorityReductionReservationQuota(
    ctx,
    capacity.job.userId,
    "job",
    capacity.job,
    storedJob,
  );
  await ctx.db.delete(capacity.identity._id);
  await ctx.db.delete(capacity.job._id);
  await ctx.db.patch(subject._id, subjectPatch as never);
}

export async function consumeDeviceRevocationCapacity(
  ctx: MutationCtx,
  capacity: Extract<DeviceRevocationCapacity, { kind: "reserved" }>,
  target: DataModel["devices"]["document"],
  targetPatch: LogicalDocument,
  jobDocument: Omit<DataModel["deviceRevocationJobs"]["document"], "_creationTime" | "_id">,
  securityDocument: Omit<DataModel["securityEvents"]["document"], "_creationTime" | "_id">,
): Promise<void> {
  if (target._id !== capacity.device.deviceId || target.userId !== capacity.device.userId) {
    corrupt();
  }
  await consumeAuthorityReductionPatchReservationQuota(
    ctx,
    target.userId,
    "device",
    capacity.device,
    target,
    targetPatch,
  );
  const jobId = await ctx.db.insert("deviceRevocationJobs", jobDocument);
  const storedJob = await ctx.db.get(jobId);
  const securityId = await ctx.db.insert("securityEvents", securityDocument);
  const storedSecurity = await ctx.db.get(securityId);
  if (storedJob === null || storedSecurity === null) corrupt();
  await replaceAuthorityReductionReservationQuota(
    ctx,
    target.userId,
    "job",
    capacity.job,
    storedJob,
  );
  await replaceAuthorityReductionReservationQuota(
    ctx,
    target.userId,
    "security",
    capacity.security,
    storedSecurity,
  );
  await ctx.db.delete(capacity.device._id);
  await ctx.db.delete(capacity.job._id);
  await ctx.db.delete(capacity.security._id);
  await ctx.db.patch(target._id, targetPatch as never);
}

export async function consumeDeviceRevocationReceiptCapacity(
  ctx: MutationCtx,
  reservation: DeviceReceiptReservation,
  receiptDocument: Omit<DataModel["idempotencyReceipts"]["document"], "_creationTime" | "_id">,
): Promise<void> {
  if (receiptDocument.userId !== reservation.userId) corrupt();
  const receiptId = await ctx.db.insert("idempotencyReceipts", receiptDocument);
  const storedReceipt = await ctx.db.get(receiptId);
  if (storedReceipt === null) corrupt();
  await replaceAuthorityReductionReservationQuota(
    ctx,
    reservation.userId,
    "receipt",
    reservation,
    storedReceipt,
  );
  await ctx.db.delete(reservation._id);
}
