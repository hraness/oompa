import { paginationOptsValidator } from "convex/server";
import { getDocumentSize, v, type GenericId as Id, type Infer, type Value } from "convex/values";

import {
  identityInviteLifetimeMs,
  invitePublicIdFromCapabilityDigest,
  isInvitePublicId,
} from "../src/cloud/inviteAuthority";
import { isFiniteTimestamp, isSafeNonNegativeInteger } from "../src/cloud/contracts";
import { isAuthDigest } from "./authPolicy";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "./server";
import { RELEASE_ATTESTATION } from "./releaseAttestation";
import {
  authorityReductionCapacityReservation,
  authorityReductionCapacityVersion,
  quotaAccountResource,
  quotaCategory,
  quotaEnforcement,
  quotaUserResource,
  maximumCommandLifecycleBatch,
  maximumUserQuotaUpgradeBatch,
  currentUserQuotaSchemaVersion,
  userQuotaUpgradePaginationOpts,
  runtimeReleaseAttestation,
} from "./validators";

export const QUOTA_CATEGORIES = [
  "identity",
  "device",
  "account",
  "session",
  "chunk",
  "usage",
  "command",
  "custody",
  "receipt",
  "security",
  "job",
  "memory",
] as const;

export type QuotaCategory = typeof QUOTA_CATEGORIES[number];
export type QuotaEnforcement = "shadow" | "hard";

export const USER_QUOTA_RESOURCES = [
  "device",
  "codex_account",
  "session_head",
  "session_chunk",
  "nonterminal_command",
  "live_chunk",
  "memory_space",
] as const;

export type UserQuotaResource = typeof USER_QUOTA_RESOURCES[number];
export type AccountQuotaResource = "usage_snapshot";

type QuotaLimit = Readonly<{ logicalBytes: number; records: number }>;

/**
 * Beta limits are logical, server-visible Convex document sizes. Ciphertext is
 * charged at its stored length. Convex's own value-size implementation counts
 * UTF-8 bytes and estimates missing system fields for documents that have
 * not been inserted yet. Reservation writers charge their actual stored row.
 */
/**
 * Open-beta free tier. One identity gets 200 MiB of server-visible logical
 * bytes. The record ceiling is deliberately far above what those bytes can
 * hold, so bytes are the binding limit and no row-count cliff appears first.
 */
export const USER_TOTAL_QUOTA = {
  logicalBytes: 200 * 1_024 * 1_024,
  records: 4_000_000,
} as const satisfies QuotaLimit;

/**
 * The identity ceiling is deliberately oversubscribed against the byte
 * ceiling: 5,000 free-tier identities could claim 1,000 GiB but the service
 * stops at 100 GiB, which is the real hard stop. Raise the byte ceiling before
 * the service approaches it, not the identity count.
 */
export const SERVICE_TOTAL_QUOTA = {
  identities: 5_000,
  logicalBytes: 100 * 1_024 * 1_024 * 1_024,
  records: 25_000_000,
} as const;

export const CATEGORY_QUOTAS = {
  identity: { logicalBytes: 16 * 1_024 * 1_024, records: 256 },
  device: { logicalBytes: 16 * 1_024 * 1_024, records: 64 },
  account: { logicalBytes: 64 * 1_024 * 1_024, records: 256 },
  session: { logicalBytes: 256 * 1_024 * 1_024, records: 20_000 },
  chunk: { logicalBytes: USER_TOTAL_QUOTA.logicalBytes, records: 500_000 },
  usage: { logicalBytes: USER_TOTAL_QUOTA.logicalBytes, records: 3_200_000 },
  command: { logicalBytes: 256 * 1_024 * 1_024, records: 10_000 },
  custody: { logicalBytes: 64 * 1_024 * 1_024, records: 512 },
  receipt: { logicalBytes: 256 * 1_024 * 1_024, records: 100_000 },
  security: { logicalBytes: 256 * 1_024 * 1_024, records: 250_000 },
  job: { logicalBytes: 16 * 1_024 * 1_024, records: 128 },
  memory: { logicalBytes: USER_TOTAL_QUOTA.logicalBytes, records: 500_000 },
} as const satisfies Readonly<Record<QuotaCategory, QuotaLimit>>;

export const USER_RESOURCE_QUOTAS = {
  device: 16,
  codex_account: 32,
  session_head: 10_000,
  session_chunk: 50_000,
  nonterminal_command: 256,
  // The live (detail-stream) tail is a bounded sub-quota of session_chunk:
  // every detail chunk also charges session_chunk, so live_chunk can never
  // exceed session_chunk, but it caps live-tail growth far tighter.
  live_chunk: 20_000,
  // The initial hosted memory surface deliberately has no pagination. Keep
  // the hard space cap equal to the complete owner-scoped list bound.
  memory_space: 100,
} as const satisfies Readonly<Record<UserQuotaResource, number>>;

export const ACCOUNT_RESOURCE_QUOTAS = {
  usage_snapshot: 100_000,
} as const satisfies Readonly<Record<AccountQuotaResource, number>>;

// A missing durable service row is never interpreted as permission to write.
// Only the clean-deployment genesis mutation may create hard authority.
export const QUOTA_DEPLOYMENT_ENFORCEMENT: QuotaEnforcement = "hard";

const corrupt = (): never => {
  throw new Error("QUOTA_AUTHORITY_CORRUPT");
};

const exceeded = (): never => {
  throw new Error("QUOTA_EXCEEDED");
};

const safeCounter = (value: number): boolean =>
  Number.isSafeInteger(value) && value >= 0;

const safeDelta = (value: number): boolean => Number.isSafeInteger(value);

const canonicalUsagePair = (logicalBytes: number, records: number): boolean =>
  (logicalBytes === 0) === (records === 0);

type HardServiceAuthority = Readonly<{
  enforcement: QuotaEnforcement;
  identities: number;
  logicalBytes: number;
  records: number;
  serviceLogicalBytes: number;
  serviceRecords: number;
  userLogicalBytes: number;
  userRecords: number;
}>;

function requireHardServiceAuthority<T extends HardServiceAuthority>(
  service: T | undefined,
): T {
  const authority = service ?? corrupt();
  if (
    authority.enforcement !== QUOTA_DEPLOYMENT_ENFORCEMENT
    || !safeCounter(authority.identities)
    || !safeCounter(authority.logicalBytes)
    || !safeCounter(authority.records)
    || !safeCounter(authority.serviceLogicalBytes)
    || !safeCounter(authority.serviceRecords)
    || !safeCounter(authority.userLogicalBytes)
    || !safeCounter(authority.userRecords)
    || authority.identities > SERVICE_TOTAL_QUOTA.identities
    || authority.logicalBytes > SERVICE_TOTAL_QUOTA.logicalBytes
    || authority.records > SERVICE_TOTAL_QUOTA.records
    || !canonicalUsagePair(authority.logicalBytes, authority.records)
    || !canonicalUsagePair(authority.serviceLogicalBytes, authority.serviceRecords)
    || !canonicalUsagePair(authority.userLogicalBytes, authority.userRecords)
    || authority.logicalBytes
      !== authority.serviceLogicalBytes + authority.userLogicalBytes
    || authority.records !== authority.serviceRecords + authority.userRecords
    || authority.identities > authority.userRecords
  ) corrupt();
  return authority;
}

export async function requireHardQuotaAuthority(ctx: Pick<QueryCtx, "db">): Promise<void> {
  const rows = await ctx.db.query("storageUsageService")
    .withIndex("by_key", (builder) => builder.eq("key", "global"))
    .take(2);
  if (rows.length !== 1) corrupt();
  requireHardServiceAuthority(rows[0]);
}

export function nextResourceRecords(
  current: number,
  delta: number,
  limit: number,
): number {
  if (
    !safeCounter(current)
    || !safeDelta(delta)
    || !safeCounter(limit)
    || current > limit
  ) corrupt();
  const records = current + delta;
  if (!safeCounter(records)) corrupt();
  if (records > limit) exceeded();
  return records;
}

type LogicalDocument = Readonly<Record<string, Value | undefined>>;

export function logicalDocumentBytes(document: LogicalDocument): number {
  const normalized: Record<string, Value> = {};
  for (const [key, value] of Object.entries(document)) {
    if (value !== undefined) normalized[key] = value;
  }
  const bytes = getDocumentSize(normalized);
  if (!safeCounter(bytes)) corrupt();
  return bytes;
}

export type QuotaSnapshot = Readonly<{
  category: QuotaLimit;
  service: Readonly<{ identities: number; logicalBytes: number; records: number }>;
  user: QuotaLimit;
}>;

export function nextQuotaSnapshot(
  current: QuotaSnapshot,
  delta: Readonly<{ identities?: number; logicalBytes: number; records: number }>,
  category: QuotaCategory,
  enforcement: QuotaEnforcement,
): QuotaSnapshot {
  const identityDelta = delta.identities ?? 0;
  if (
    !safeDelta(identityDelta)
    || !safeDelta(delta.logicalBytes)
    || !safeDelta(delta.records)
  ) corrupt();
  const next = {
    category: {
      logicalBytes: current.category.logicalBytes + delta.logicalBytes,
      records: current.category.records + delta.records,
    },
    service: {
      identities: current.service.identities + identityDelta,
      logicalBytes: current.service.logicalBytes + delta.logicalBytes,
      records: current.service.records + delta.records,
    },
    user: {
      logicalBytes: current.user.logicalBytes + delta.logicalBytes,
      records: current.user.records + delta.records,
    },
  };
  if (
    !safeCounter(next.category.logicalBytes)
    || !safeCounter(next.category.records)
    || !safeCounter(next.service.identities)
    || !safeCounter(next.service.logicalBytes)
    || !safeCounter(next.service.records)
    || !safeCounter(next.user.logicalBytes)
    || !safeCounter(next.user.records)
  ) corrupt();
  if (
    enforcement === "hard"
    && (
      next.category.logicalBytes > CATEGORY_QUOTAS[category].logicalBytes
      || next.category.records > CATEGORY_QUOTAS[category].records
      || next.user.logicalBytes > USER_TOTAL_QUOTA.logicalBytes
      || next.user.records > USER_TOTAL_QUOTA.records
      || next.service.identities > SERVICE_TOTAL_QUOTA.identities
      || next.service.logicalBytes > SERVICE_TOTAL_QUOTA.logicalBytes
      || next.service.records > SERVICE_TOTAL_QUOTA.records
    )
  ) exceeded();
  return next;
}

type StoredUserUsage = Readonly<{
  _id: Id<"storageUsageByUser">;
  category: QuotaCategory;
  logicalBytes: number;
  records: number;
}>;

const validQuotaSchemaMarker = (row: Readonly<{
  category: QuotaCategory;
  quotaSchemaVersion?: number;
}>): boolean => row.quotaSchemaVersion === undefined
  || (row.category === "identity" && row.quotaSchemaVersion === currentUserQuotaSchemaVersion);

async function loadQuotaAccounting(ctx: QueryCtx | MutationCtx, userId: Id<"users">) {
  const [serviceRows, userRows] = await Promise.all([
    ctx.db.query("storageUsageService")
      .withIndex("by_key", (builder) => builder.eq("key", "global"))
      .take(2),
    ctx.db.query("storageUsageByUser")
      .withIndex("by_user_and_category", (builder) => builder.eq("userId", userId))
      .take(QUOTA_CATEGORIES.length + 1),
  ]);
  if (serviceRows.length !== 1) corrupt();
  const service = requireHardServiceAuthority(serviceRows[0]);

  const byCategory = new Map<QuotaCategory, StoredUserUsage>();
  let userLogicalBytes = 0;
  let userRecords = 0;
  for (const row of userRows) {
    if (
      !QUOTA_CATEGORIES.includes(row.category)
      || !validQuotaSchemaMarker(row)
      || !safeCounter(row.logicalBytes)
      || !safeCounter(row.records)
      || row.logicalBytes > CATEGORY_QUOTAS[row.category].logicalBytes
      || row.records > CATEGORY_QUOTAS[row.category].records
      || !canonicalUsagePair(row.logicalBytes, row.records)
      || byCategory.has(row.category)
    ) corrupt();
    byCategory.set(row.category, row);
    userLogicalBytes += row.logicalBytes;
    userRecords += row.records;
    if (!safeCounter(userLogicalBytes) || !safeCounter(userRecords)) corrupt();
  }
  if (byCategory.size !== QUOTA_CATEGORIES.length) corrupt();
  if (
    userLogicalBytes > USER_TOTAL_QUOTA.logicalBytes
    || userRecords > USER_TOTAL_QUOTA.records
    || service.userLogicalBytes < userLogicalBytes
    || service.userRecords < userRecords
  ) corrupt();
  return { byCategory, service, userLogicalBytes, userRecords };
}

export const AUTHORITY_REDUCTION_QUOTA_CEILINGS = [
  "identity", "job", "device", "security", "receipt", "userTotal", "serviceTotal",
] as const;
export type AuthorityReductionQuotaCeiling = typeof AUTHORITY_REDUCTION_QUOTA_CEILINGS[number];
export type AuthorityReductionQuotaCounts = {
  applicable: number;
  bytesBlockedByLowerBound: number;
  bytesUnknown: number;
  recordsBlocked: number;
};
export type AuthorityReductionQuotaCeilings = Record<
  AuthorityReductionQuotaCeiling, AuthorityReductionQuotaCounts
>;

export function emptyAuthorityReductionQuotaCeilings(): AuthorityReductionQuotaCeilings {
  const empty = (): AuthorityReductionQuotaCounts => ({
    applicable: 0, bytesBlockedByLowerBound: 0, bytesUnknown: 0, recordsBlocked: 0,
  });
  return {
    device: empty(), identity: empty(), job: empty(), receipt: empty(),
    security: empty(), serviceTotal: empty(), userTotal: empty(),
  };
}

export function authorityReductionReservationDemand(accountPairs: number, deviceQuartets: number) {
  if (
    (accountPairs !== 0 && accountPairs !== 1)
    || !Number.isSafeInteger(deviceQuartets) || deviceQuartets < 0 || deviceQuartets > 16
  ) return corrupt();
  const totalRecords = 2 * accountPairs + 4 * deviceQuartets;
  return {
    accountPairs, deviceQuartets,
    paddingBytesLowerBound: totalRecords * authorityReductionCapacityReservation.length,
    totalRecords,
  };
}

// These counts describe one identity's missing reservation sets. Padding alone
// can prove a byte refusal; the remaining document/system fields are unknown
// until insertion. No prospective size estimate is treated as an exact fit.
export async function inspectAuthorityReductionQuota(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
  accountPairs: number,
  deviceQuartets: number,
): Promise<Readonly<{ state: "authority_unknown" }> | Readonly<{
  ceilings: AuthorityReductionQuotaCeilings;
  state: "observed";
}>> {
  const demand = authorityReductionReservationDemand(accountPairs, deviceQuartets);
  try {
    const { byCategory, service, userLogicalBytes, userRecords } = await loadQuotaAccounting(ctx, userId);
    const records = {
      device: deviceQuartets, identity: accountPairs, job: accountPairs + deviceQuartets,
      receipt: deviceQuartets, security: deviceQuartets,
      serviceTotal: demand.totalRecords, userTotal: demand.totalRecords,
    };
    const ceilings = emptyAuthorityReductionQuotaCeilings();
    for (const ceiling of AUTHORITY_REDUCTION_QUOTA_CEILINGS) {
      const additional = records[ceiling];
      if (additional === 0) continue;
      const current = ceiling === "serviceTotal" ? service
        : ceiling === "userTotal" ? { logicalBytes: userLogicalBytes, records: userRecords }
        : byCategory.get(ceiling);
      if (current === undefined) return corrupt();
      const limit = ceiling === "serviceTotal" ? SERVICE_TOTAL_QUOTA
        : ceiling === "userTotal" ? USER_TOTAL_QUOTA : CATEGORY_QUOTAS[ceiling];
      const byteBlocked = current.logicalBytes
        + additional * authorityReductionCapacityReservation.length > limit.logicalBytes;
      ceilings[ceiling] = {
        applicable: 1,
        bytesBlockedByLowerBound: byteBlocked ? 1 : 0,
        bytesUnknown: byteBlocked ? 0 : 1,
        recordsBlocked: current.records + additional > limit.records ? 1 : 0,
      };
    }
    return { ceilings, state: "observed" };
  } catch (error: unknown) {
    if (error instanceof Error && error.message === "QUOTA_AUTHORITY_CORRUPT") {
      return { state: "authority_unknown" };
    }
    throw error;
  }
}

async function applyQuotaDelta(
  ctx: MutationCtx,
  userId: Id<"users">,
  category: QuotaCategory,
  delta: Readonly<{ identities?: number; logicalBytes: number; records: number }>,
): Promise<void> {
  if (
    !safeDelta(delta.identities ?? 0)
    || !safeDelta(delta.logicalBytes)
    || !safeDelta(delta.records)
  ) corrupt();
  const { byCategory, service, userLogicalBytes, userRecords } = await loadQuotaAccounting(ctx, userId);
  const categoryUsage = byCategory.get(category);
  if (categoryUsage === undefined) return corrupt();

  const currentCategory = {
    logicalBytes: categoryUsage.logicalBytes,
    records: categoryUsage.records,
  };
  const currentService = {
    identities: service.identities,
    logicalBytes: service.logicalBytes,
    records: service.records,
  };
  const currentUser = { logicalBytes: userLogicalBytes, records: userRecords };
  const next = nextQuotaSnapshot(
    { category: currentCategory, service: currentService, user: currentUser },
    delta,
    category,
    "hard",
  );
  // The global ledger cannot legitimately be smaller than the user being
  // updated. This detects a damaged hard authority without an unbounded scan.
  if (
    next.service.logicalBytes < next.user.logicalBytes
    || next.service.records < next.user.records
    || !canonicalUsagePair(next.category.logicalBytes, next.category.records)
    || !canonicalUsagePair(next.service.logicalBytes, next.service.records)
    || !canonicalUsagePair(next.user.logicalBytes, next.user.records)
  ) corrupt();
  const nextUserLogicalBytes = service.userLogicalBytes + delta.logicalBytes;
  const nextUserRecords = service.userRecords + delta.records;
  if (
    !safeCounter(nextUserLogicalBytes)
    || !safeCounter(nextUserRecords)
    || nextUserLogicalBytes < next.user.logicalBytes
    || nextUserRecords < next.user.records
    || next.service.identities > nextUserRecords
    || next.service.logicalBytes
      !== service.serviceLogicalBytes + nextUserLogicalBytes
    || next.service.records !== service.serviceRecords + nextUserRecords
  ) corrupt();

  const now = Date.now();
  await ctx.db.patch(categoryUsage._id, {
    logicalBytes: next.category.logicalBytes,
    records: next.category.records,
    updatedAt: now,
  });
  await ctx.db.patch(service._id, {
    identities: next.service.identities,
    logicalBytes: next.service.logicalBytes,
    records: next.service.records,
    updatedAt: now,
    userLogicalBytes: nextUserLogicalBytes,
    userRecords: nextUserRecords,
  });
}

async function applyServiceQuotaDelta(
  ctx: MutationCtx,
  delta: Readonly<{ logicalBytes: number; records: number }>,
): Promise<void> {
  if (!safeDelta(delta.logicalBytes) || !safeDelta(delta.records)) corrupt();
  const rows = await ctx.db.query("storageUsageService")
    .withIndex("by_key", (builder) => builder.eq("key", "global"))
    .take(2);
  if (rows.length !== 1) corrupt();
  const service = requireHardServiceAuthority(rows[0]);
  const serviceLogicalBytes = service.serviceLogicalBytes + delta.logicalBytes;
  const serviceRecords = service.serviceRecords + delta.records;
  const logicalBytes = service.logicalBytes + delta.logicalBytes;
  const records = service.records + delta.records;
  if (
    !safeCounter(serviceLogicalBytes)
    || !safeCounter(serviceRecords)
    || !safeCounter(logicalBytes)
    || !safeCounter(records)
    || !canonicalUsagePair(logicalBytes, records)
    || !canonicalUsagePair(serviceLogicalBytes, serviceRecords)
    || logicalBytes !== service.userLogicalBytes + serviceLogicalBytes
    || records !== service.userRecords + serviceRecords
  ) corrupt();
  if (
    logicalBytes > SERVICE_TOTAL_QUOTA.logicalBytes
    || records > SERVICE_TOTAL_QUOTA.records
  ) exceeded();
  await ctx.db.patch(service._id, {
    logicalBytes,
    records,
    serviceLogicalBytes,
    serviceRecords,
    updatedAt: Date.now(),
  });
}

type StoredUserResourceUsage = Readonly<{
  _id: Id<"storageResourceUsageByUser">;
  records: number;
  resource: UserQuotaResource;
}>;

async function applyUserResourceDelta(
  ctx: MutationCtx,
  userId: Id<"users">,
  resource: UserQuotaResource,
  delta: number,
): Promise<void> {
  if (!safeDelta(delta)) corrupt();
  const rows = await ctx.db.query("storageResourceUsageByUser")
    .withIndex("by_user_and_resource", (builder) => builder.eq("userId", userId))
    .take(USER_QUOTA_RESOURCES.length + 1);
  const byResource = new Map<UserQuotaResource, StoredUserResourceUsage>();
  for (const row of rows) {
    if (
      !USER_QUOTA_RESOURCES.includes(row.resource)
      || !safeCounter(row.records)
      || row.records > USER_RESOURCE_QUOTAS[row.resource]
      || byResource.has(row.resource)
    ) corrupt();
    byResource.set(row.resource, row);
  }
  if (byResource.size !== USER_QUOTA_RESOURCES.length) corrupt();
  const usage = byResource.get(resource);
  if (usage === undefined) return corrupt();
  const records = nextResourceRecords(usage.records, delta, USER_RESOURCE_QUOTAS[resource]);
  await ctx.db.patch(usage._id, { records, updatedAt: Date.now() });
}

async function applyAccountResourceDelta(
  ctx: MutationCtx,
  userId: Id<"users">,
  accountId: Id<"codexAccounts">,
  resource: AccountQuotaResource,
  delta: number,
): Promise<void> {
  if (!safeDelta(delta)) corrupt();
  const rows = await ctx.db.query("storageResourceUsageByAccount")
    .withIndex("by_account_and_resource", (builder) => builder
      .eq("accountId", accountId)
      .eq("resource", resource))
    .take(2);
  if (rows.length !== 1) corrupt();
  const usage = rows[0];
  if (
    usage === undefined
    || usage.userId !== userId
    || !safeCounter(usage.records)
    || usage.records > ACCOUNT_RESOURCE_QUOTAS[resource]
  ) return corrupt();
  const records = nextResourceRecords(
    usage.records,
    delta,
    ACCOUNT_RESOURCE_QUOTAS[resource],
  );
  await ctx.db.patch(usage._id, { records, updatedAt: Date.now() });
}

async function reserveUserResourceInsert(
  ctx: MutationCtx,
  userId: Id<"users">,
  category: QuotaCategory,
  resource: UserQuotaResource,
  document: LogicalDocument,
): Promise<void> {
  await reserveQuotaForInsert(ctx, userId, category, document);
  await applyUserResourceDelta(ctx, userId, resource, 1);
}

async function releaseUserResourceDelete(
  ctx: MutationCtx,
  userId: Id<"users">,
  category: QuotaCategory,
  resource: UserQuotaResource,
  document: LogicalDocument,
): Promise<void> {
  await releaseQuotaForDelete(ctx, userId, category, document);
  await applyUserResourceDelta(ctx, userId, resource, -1);
}

function requireUser(document: LogicalDocument, userId: Id<"users">): void {
  if (document.userId !== userId) corrupt();
}

export async function reserveQuotaForInsert(
  ctx: MutationCtx,
  userId: Id<"users">,
  category: QuotaCategory,
  document: LogicalDocument,
): Promise<void> {
  requireUser(document, userId);
  await applyQuotaDelta(ctx, userId, category, {
    logicalBytes: logicalDocumentBytes(document),
    records: 1,
  });
}

export async function adjustQuotaForPatch(
  ctx: MutationCtx,
  userId: Id<"users">,
  category: QuotaCategory,
  document: LogicalDocument,
  patch: LogicalDocument,
): Promise<void> {
  requireUser(document, userId);
  const next = { ...document, ...patch };
  requireUser(next, userId);
  await applyQuotaDelta(ctx, userId, category, {
    logicalBytes: logicalDocumentBytes(next) - logicalDocumentBytes(document),
    records: 0,
  });
}

export async function releaseQuotaForDelete(
  ctx: MutationCtx,
  userId: Id<"users">,
  category: QuotaCategory,
  document: LogicalDocument,
): Promise<void> {
  requireUser(document, userId);
  await applyQuotaDelta(ctx, userId, category, {
    logicalBytes: -logicalDocumentBytes(document),
    records: -1,
  });
}

type AuthorityReductionReservation = LogicalDocument & Readonly<{
  capacityReservation: string;
  capacityVersion: number;
  category: QuotaCategory;
  userId: Id<"users">;
}>;

function requireAuthorityReductionReservation(
  reservation: AuthorityReductionReservation,
  userId: Id<"users">,
  category: QuotaCategory,
): void {
  requireUser(reservation, userId);
  if (
    reservation.capacityVersion !== authorityReductionCapacityVersion
    || reservation.capacityReservation !== authorityReductionCapacityReservation
    || reservation.category !== category
  ) corrupt();
}

/**
 * Exchange one real, category-charged authority-reduction reservation for its
 * exact artifact. The aggregate ledger transition must be non-growing, so it
 * remains valid even when user, category, and service are at their hard
 * ceilings. This is intentionally not a generic quota bypass.
 */
export async function replaceAuthorityReductionReservationQuota(
  ctx: MutationCtx,
  userId: Id<"users">,
  category: QuotaCategory,
  reservation: AuthorityReductionReservation,
  replacement: LogicalDocument,
): Promise<void> {
  requireAuthorityReductionReservation(reservation, userId, category);
  requireUser(replacement, userId);
  const logicalBytes = logicalDocumentBytes(replacement)
    - logicalDocumentBytes(reservation);
  if (logicalBytes > 0) corrupt();
  await applyQuotaDelta(ctx, userId, category, { logicalBytes, records: 0 });
}

/**
 * Consume a same-category reservation while applying an authority-reducing
 * patch to an existing row. Two charged records become one and the aggregate
 * stored bytes must not grow.
 */
export async function consumeAuthorityReductionPatchReservationQuota(
  ctx: MutationCtx,
  userId: Id<"users">,
  category: QuotaCategory,
  reservation: AuthorityReductionReservation,
  document: LogicalDocument,
  patch: LogicalDocument,
): Promise<void> {
  requireAuthorityReductionReservation(reservation, userId, category);
  requireUser(document, userId);
  const next = { ...document, ...patch };
  requireUser(next, userId);
  const logicalBytes = logicalDocumentBytes(next)
    - logicalDocumentBytes(document)
    - logicalDocumentBytes(reservation);
  if (logicalBytes > 0) corrupt();
  await applyQuotaDelta(ctx, userId, category, { logicalBytes, records: -1 });
}

export async function reserveParentAttributedQuotaForInsert(
  ctx: MutationCtx,
  userId: Id<"users">,
  category: QuotaCategory,
  document: LogicalDocument,
): Promise<void> {
  await applyQuotaDelta(ctx, userId, category, {
    logicalBytes: logicalDocumentBytes(document),
    records: 1,
  });
}

export async function adjustParentAttributedQuotaForPatch(
  ctx: MutationCtx,
  userId: Id<"users">,
  category: QuotaCategory,
  document: LogicalDocument,
  patch: LogicalDocument,
): Promise<void> {
  await applyQuotaDelta(ctx, userId, category, {
    logicalBytes: logicalDocumentBytes({ ...document, ...patch })
      - logicalDocumentBytes(document),
    records: 0,
  });
}

export async function releaseParentAttributedQuotaForDelete(
  ctx: MutationCtx,
  userId: Id<"users">,
  category: QuotaCategory,
  document: LogicalDocument,
): Promise<void> {
  await applyQuotaDelta(ctx, userId, category, {
    logicalBytes: -logicalDocumentBytes(document),
    records: -1,
  });
}

export async function reserveServiceQuotaForInsert(
  ctx: MutationCtx,
  document: LogicalDocument,
): Promise<void> {
  await applyServiceQuotaDelta(ctx, {
    logicalBytes: logicalDocumentBytes(document),
    records: 1,
  });
}

export async function tryReserveServiceQuotaForInserts(
  ctx: MutationCtx,
  documents: readonly LogicalDocument[],
): Promise<boolean> {
  if (documents.length < 1) corrupt();
  const logicalBytes = documents.reduce(
    (total, document) => total + logicalDocumentBytes(document),
    0,
  );
  try {
    await applyServiceQuotaDelta(ctx, {
      logicalBytes,
      records: documents.length,
    });
    return true;
  } catch (error) {
    if (error instanceof Error && error.message === "QUOTA_EXCEEDED") return false;
    throw error;
  }
}

export async function adjustServiceQuotaForPatch(
  ctx: MutationCtx,
  document: LogicalDocument,
  patch: LogicalDocument,
): Promise<void> {
  await applyServiceQuotaDelta(ctx, {
    logicalBytes: logicalDocumentBytes({ ...document, ...patch })
      - logicalDocumentBytes(document),
    records: 0,
  });
}

export async function releaseServiceQuotaForDelete(
  ctx: MutationCtx,
  document: LogicalDocument,
): Promise<void> {
  await applyServiceQuotaDelta(ctx, {
    logicalBytes: -logicalDocumentBytes(document),
    records: -1,
  });
}

export async function transferServiceQuotaToUserForPatch(
  ctx: MutationCtx,
  userId: Id<"users">,
  category: QuotaCategory,
  document: LogicalDocument,
  patch: LogicalDocument,
): Promise<void> {
  const next = { ...document, ...patch };
  requireUser(next, userId);
  await releaseServiceQuotaForDelete(ctx, document);
  await reserveQuotaForInsert(ctx, userId, category, next);
}

export async function reserveDeviceQuotaForInsert(
  ctx: MutationCtx,
  userId: Id<"users">,
  document: LogicalDocument,
): Promise<void> {
  await reserveUserResourceInsert(ctx, userId, "device", "device", document);
}

export async function releaseDeviceQuotaForDelete(
  ctx: MutationCtx,
  userId: Id<"users">,
  document: LogicalDocument,
): Promise<void> {
  await releaseUserResourceDelete(ctx, userId, "device", "device", document);
}

export async function reserveCodexAccountQuotaForInsert(
  ctx: MutationCtx,
  userId: Id<"users">,
  document: LogicalDocument,
): Promise<void> {
  await reserveUserResourceInsert(ctx, userId, "account", "codex_account", document);
}

export async function reserveSessionHeadQuotaForInsert(
  ctx: MutationCtx,
  userId: Id<"users">,
  document: LogicalDocument,
): Promise<void> {
  await reserveUserResourceInsert(ctx, userId, "session", "session_head", document);
}

export async function releaseSessionHeadQuotaForDelete(
  ctx: MutationCtx,
  userId: Id<"users">,
  document: LogicalDocument,
): Promise<void> {
  await releaseUserResourceDelete(ctx, userId, "session", "session_head", document);
}

export async function reserveMemorySpaceQuotaForInsert(
  ctx: MutationCtx,
  userId: Id<"users">,
  document: LogicalDocument,
): Promise<void> {
  await reserveUserResourceInsert(ctx, userId, "memory", "memory_space", document);
}

export async function releaseMemorySpaceQuotaForDelete(
  ctx: MutationCtx,
  userId: Id<"users">,
  document: LogicalDocument,
): Promise<void> {
  await releaseUserResourceDelete(ctx, userId, "memory", "memory_space", document);
}

export async function reserveSessionChunkQuotaForInsert(
  ctx: MutationCtx,
  userId: Id<"users">,
  document: LogicalDocument,
): Promise<void> {
  await reserveUserResourceInsert(ctx, userId, "chunk", "session_chunk", document);
}

export async function releaseSessionChunkQuotaForDelete(
  ctx: MutationCtx,
  userId: Id<"users">,
  document: LogicalDocument,
): Promise<void> {
  await releaseUserResourceDelete(ctx, userId, "chunk", "session_chunk", document);
}

/**
 * The live_chunk resource is a per-user counter over detail-stream chunks
 * only. It rides on top of the session_chunk logical-byte and record charge
 * already applied by reserve/releaseSessionChunkQuotaForInsert/ForDelete
 * (called separately for every chunk regardless of stream): this function
 * adjusts only the additional live_chunk resource counter, never the
 * category ledger, so a detail chunk is never charged twice for the same
 * logical bytes.
 */
export async function reserveLiveChunkResourceForInsert(
  ctx: MutationCtx,
  userId: Id<"users">,
): Promise<void> {
  await applyUserResourceDelta(ctx, userId, "live_chunk", 1);
}

export async function releaseLiveChunkResourceForDelete(
  ctx: MutationCtx,
  userId: Id<"users">,
): Promise<void> {
  await applyUserResourceDelta(ctx, userId, "live_chunk", -1);
}

export async function reserveNonterminalCommandQuotaForInsert(
  ctx: MutationCtx,
  userId: Id<"users">,
  document: LogicalDocument,
): Promise<void> {
  if (document.nonterminal !== true) corrupt();
  await reserveUserResourceInsert(
    ctx,
    userId,
    "command",
    "nonterminal_command",
    document,
  );
}

export async function adjustCommandQuotaForPatch(
  ctx: MutationCtx,
  userId: Id<"users">,
  document: LogicalDocument,
  patch: LogicalDocument,
): Promise<void> {
  const next = { ...document, ...patch };
  if (
    typeof document.nonterminal !== "boolean"
    || typeof next.nonterminal !== "boolean"
    || (!document.nonterminal && next.nonterminal)
  ) corrupt();
  await adjustQuotaForPatch(ctx, userId, "command", document, patch);
  if (document.nonterminal && !next.nonterminal) {
    await applyUserResourceDelta(ctx, userId, "nonterminal_command", -1);
  }
}

/**
 * Exchange a command and its already-charged lifecycle reservation as one
 * physical quota obligation. This is deliberately narrower than an
 * authority-reduction admission: callers cannot grow either the aggregate
 * bytes or record count, so a command that was admitted before a device
 * revocation/account deletion consumed the static emergency reserve can still
 * finish its lifecycle without crossing either the ordinary or hard ceiling.
 */
export async function adjustCommandLifecycleQuotaForReplacement(
  ctx: MutationCtx,
  userId: Id<"users">,
  command: LogicalDocument,
  commandPatch: LogicalDocument,
  reservation: LogicalDocument,
  reservationPatch: LogicalDocument | null,
): Promise<void> {
  requireUser(command, userId);
  requireUser(reservation, userId);
  if (
    typeof command.publicId !== "string"
    || reservation.commandPublicId !== command.publicId
    || (reservation.commandType !== "session" && reservation.commandType !== "device")
    || typeof reservation.capacityReservation !== "string"
    || reservation.capacityReservation.length < 1
    || !/^0+$/u.test(reservation.capacityReservation)
    || command.nonterminal !== true
  ) corrupt();
  const nextCommand = { ...command, ...commandPatch };
  requireUser(nextCommand, userId);
  if (typeof nextCommand.nonterminal !== "boolean") corrupt();
  const nextReservation = reservationPatch === null
    ? null
    : { ...reservation, ...reservationPatch };
  if (nextReservation !== null) {
    requireUser(nextReservation, userId);
    if (
      nextReservation.commandPublicId !== reservation.commandPublicId
      || nextReservation.commandType !== reservation.commandType
      || typeof nextReservation.capacityReservation !== "string"
      || nextReservation.capacityReservation.length < 1
      || !/^0+$/u.test(nextReservation.capacityReservation)
    ) corrupt();
  }
  const logicalBytes = logicalDocumentBytes(nextCommand)
    + (nextReservation === null ? 0 : logicalDocumentBytes(nextReservation))
    - logicalDocumentBytes(command)
    - logicalDocumentBytes(reservation);
  const records = nextReservation === null ? -1 : 0;
  if (logicalBytes > 0 || records > 0) corrupt();
  await applyQuotaDelta(ctx, userId, "command", { logicalBytes, records });
  if (!nextCommand.nonterminal) {
    await applyUserResourceDelta(ctx, userId, "nonterminal_command", -1);
  }
}

/** Replace one exact charged terminal-security placeholder with its event. */
export async function adjustTerminalSecurityQuotaForReplacement(
  ctx: MutationCtx,
  userId: Id<"users">,
  reservation: LogicalDocument,
  replacement: LogicalDocument,
): Promise<void> {
  requireUser(reservation, userId);
  requireUser(replacement, userId);
  if (
    reservation.event !== "command_terminal"
    || replacement.event !== "command_terminal"
    || typeof reservation.entityId !== "string"
    || replacement.entityId !== reservation.entityId
    || replacement.actorDeviceId !== reservation.actorDeviceId
    || (reservation.commandType !== "session" && reservation.commandType !== "device")
  ) corrupt();
  const logicalBytes = logicalDocumentBytes(replacement)
    - logicalDocumentBytes(reservation);
  if (logicalBytes > 0) corrupt();
  await applyQuotaDelta(ctx, userId, "security", { logicalBytes, records: 0 });
}

export async function releaseCommandQuotaForDelete(
  ctx: MutationCtx,
  userId: Id<"users">,
  document: LogicalDocument,
): Promise<void> {
  if (typeof document.nonterminal !== "boolean") corrupt();
  await releaseQuotaForDelete(ctx, userId, "command", document);
  if (document.nonterminal) {
    await applyUserResourceDelta(ctx, userId, "nonterminal_command", -1);
  }
}

export async function reserveAccountUsageSnapshotQuotaForInsert(
  ctx: MutationCtx,
  userId: Id<"users">,
  accountId: Id<"codexAccounts">,
  document: LogicalDocument,
): Promise<void> {
  if (document.accountId !== accountId) corrupt();
  await reserveQuotaForInsert(ctx, userId, "usage", document);
  await applyAccountResourceDelta(ctx, userId, accountId, "usage_snapshot", 1);
}

export async function releaseAccountUsageSnapshotQuotaForDelete(
  ctx: MutationCtx,
  userId: Id<"users">,
  accountId: Id<"codexAccounts">,
  document: LogicalDocument,
): Promise<void> {
  if (document.accountId !== accountId) corrupt();
  await releaseQuotaForDelete(ctx, userId, "usage", document);
  await applyAccountResourceDelta(ctx, userId, accountId, "usage_snapshot", -1);
}

export async function initializeAccountUsageQuotaAuthority(
  ctx: MutationCtx,
  userId: Id<"users">,
  accountId: Id<"codexAccounts">,
): Promise<void> {
  const [serviceRows, account, rows] = await Promise.all([
    ctx.db.query("storageUsageService")
      .withIndex("by_key", (builder) => builder.eq("key", "global"))
      .take(2),
    ctx.db.get(accountId),
    ctx.db.query("storageResourceUsageByAccount")
      .withIndex("by_account_and_resource", (builder) => builder
        .eq("accountId", accountId)
        .eq("resource", "usage_snapshot"))
      .take(2),
  ]);
  if (serviceRows.length !== 1) corrupt();
  requireHardServiceAuthority(serviceRows[0]);
  if (account?.userId !== userId || rows.length !== 0) corrupt();
  await ctx.db.insert("storageResourceUsageByAccount", {
    accountId,
    records: 0,
    resource: "usage_snapshot",
    updatedAt: Date.now(),
    userId,
  });
}

export async function releaseCodexAccountQuotaForDelete(
  ctx: MutationCtx,
  userId: Id<"users">,
  document: LogicalDocument & Readonly<{ _id: Id<"codexAccounts"> }>,
): Promise<void> {
  const rows = await ctx.db.query("storageResourceUsageByAccount")
    .withIndex("by_account_and_resource", (builder) => builder
      .eq("accountId", document._id)
      .eq("resource", "usage_snapshot"))
    .take(2);
  const usage = rows[0];
  if (rows.length !== 1 || usage?.userId !== userId || usage.records !== 0) {
    return corrupt();
  }
  await releaseUserResourceDelete(ctx, userId, "account", "codex_account", document);
  await ctx.db.delete(usage._id);
}

export async function reserveQuotaForStoredIdentity(
  ctx: MutationCtx,
  userId: Id<"users">,
  document: LogicalDocument,
): Promise<void> {
  if (document._id !== userId) corrupt();
  await applyQuotaDelta(ctx, userId, "identity", {
    identities: 1,
    logicalBytes: logicalDocumentBytes(document),
    records: 1,
  });
}

export async function releaseQuotaForStoredIdentity(
  ctx: MutationCtx,
  userId: Id<"users">,
  document: LogicalDocument,
): Promise<void> {
  if (document._id !== userId) corrupt();
  await applyQuotaDelta(ctx, userId, "identity", {
    identities: -1,
    logicalBytes: -logicalDocumentBytes(document),
    records: -1,
  });
}

export const QUOTA_GENESIS_CHARGED_TABLES = [
  "users",
  "authSessions",
  "authAccounts",
  "authRefreshTokens",
  "authVerificationCodes",
  "authVerifiers",
  "authRateLimits",
  "authSubjects",
  "authEmailAttemptEvents",
  "authOtpChallenges",
  "authInvites",
  "devices",
  "accountDeletionIdentityReservations",
  "accountDeletionJobReservations",
  "deviceRevocationDeviceReservations",
  "deviceRevocationJobReservations",
  "deviceRevocationSecurityReservations",
  "deviceRevocationReceiptReservations",
  "deviceSessions",
  "deviceBindChallenges",
  "deviceKeyEnvelopes",
  "recoveryEnvelopes",
  "devicePresence",
  "deviceRegistries",
  "memorySpaces",
  "memoryOperations",
  "sessionHeads",
  "sessionChunks",
  "sessionStreamEpochs",
  "executionLeases",
  "sessionCommands",
  "deviceCommands",
  "commandLifecycleReservations",
  "commandTerminalSecurityReservations",
  "attentionNotificationOutbox",
  "attentionNotificationSafetyFaults",
  "codexAccounts",
  "deviceAccountBindings",
  "accountUsageSnapshots",
  "idempotencyReceipts",
  "securityEvents",
  "accountDeletionJobs",
  "accountDeletionReceipts",
  "deviceRevocationJobs",
] as const;

const hasAny = async <T>(promise: Promise<readonly T[]>): Promise<boolean> =>
  (await promise).length !== 0;

async function requireGenesisEmpty(ctx: MutationCtx): Promise<void> {
  const [serviceExists, controlExists] = await Promise.all([
    hasAny(ctx.db.query("storageUsageService").take(1)),
    hasAny(ctx.db.query("serviceControl").take(1)),
  ]);
  if (serviceExists || controlExists) {
    throw new Error("QUOTA_HARD_GENESIS_ALREADY_EXISTS");
  }
  const occupied = await Promise.all([
    hasAny(ctx.db.query("users").take(1)),
    hasAny(ctx.db.query("authSessions").take(1)),
    hasAny(ctx.db.query("authAccounts").take(1)),
    hasAny(ctx.db.query("authRefreshTokens").take(1)),
    hasAny(ctx.db.query("authVerificationCodes").take(1)),
    hasAny(ctx.db.query("authVerifiers").take(1)),
    hasAny(ctx.db.query("authRateLimits").take(1)),
    hasAny(ctx.db.query("authSubjects").take(1)),
    hasAny(ctx.db.query("authEmailAttemptEvents").take(1)),
    hasAny(ctx.db.query("authOtpChallenges").take(1)),
    hasAny(ctx.db.query("authInvites").take(1)),
    hasAny(ctx.db.query("devices").take(1)),
    hasAny(ctx.db.query("accountDeletionIdentityReservations").take(1)),
    hasAny(ctx.db.query("accountDeletionJobReservations").take(1)),
    hasAny(ctx.db.query("deviceRevocationDeviceReservations").take(1)),
    hasAny(ctx.db.query("deviceRevocationJobReservations").take(1)),
    hasAny(ctx.db.query("deviceRevocationSecurityReservations").take(1)),
    hasAny(ctx.db.query("deviceRevocationReceiptReservations").take(1)),
    hasAny(ctx.db.query("deviceSessions").take(1)),
    hasAny(ctx.db.query("deviceBindChallenges").take(1)),
    hasAny(ctx.db.query("deviceKeyEnvelopes").take(1)),
    hasAny(ctx.db.query("recoveryEnvelopes").take(1)),
    hasAny(ctx.db.query("devicePresence").take(1)),
    hasAny(ctx.db.query("deviceRegistries").take(1)),
    hasAny(ctx.db.query("memorySpaces").take(1)),
    hasAny(ctx.db.query("memoryOperations").take(1)),
    hasAny(ctx.db.query("sessionHeads").take(1)),
    hasAny(ctx.db.query("sessionChunks").take(1)),
    hasAny(ctx.db.query("sessionStreamEpochs").take(1)),
    hasAny(ctx.db.query("executionLeases").take(1)),
    hasAny(ctx.db.query("sessionCommands").take(1)),
    hasAny(ctx.db.query("deviceCommands").take(1)),
    hasAny(ctx.db.query("commandLifecycleReservations").take(1)),
    hasAny(ctx.db.query("commandTerminalSecurityReservations").take(1)),
    hasAny(ctx.db.query("attentionNotificationOutbox").take(1)),
    hasAny(ctx.db.query("attentionNotificationSafetyFaults").take(1)),
    hasAny(ctx.db.query("codexAccounts").take(1)),
    hasAny(ctx.db.query("deviceAccountBindings").take(1)),
    hasAny(ctx.db.query("accountUsageSnapshots").take(1)),
    hasAny(ctx.db.query("idempotencyReceipts").take(1)),
    hasAny(ctx.db.query("securityEvents").take(1)),
    hasAny(ctx.db.query("accountDeletionJobs").take(1)),
    hasAny(ctx.db.query("accountDeletionReceipts").take(1)),
    hasAny(ctx.db.query("deviceRevocationJobs").take(1)),
    hasAny(ctx.db.query("storageUsageByUser").take(1)),
    hasAny(ctx.db.query("storageResourceUsageByUser").take(1)),
    hasAny(ctx.db.query("storageResourceUsageByAccount").take(1)),
    hasAny(ctx.db.query("maintenanceState").take(1)),
  ]);
  if (occupied.some(Boolean)) throw new Error("QUOTA_HARD_GENESIS_NOT_EMPTY");
}

async function insertHardAuthority(
  ctx: MutationCtx,
  now: number,
  bootstrap?: Readonly<{
    capabilityDigest: string;
    lifetimeMs: number;
    publicId: string;
  }>,
): Promise<void> {
  await ctx.db.insert("storageUsageService", {
    enforcement: "hard",
    identities: 0,
    key: "global",
    logicalBytes: 0,
    records: 0,
    serviceLogicalBytes: 0,
    serviceRecords: 0,
    updatedAt: now,
    userLogicalBytes: 0,
    userRecords: 0,
  });
  await ctx.db.insert("serviceControl", {
    authAdmissionGeneration: 0,
    authAdmissions: "open",
    ...(bootstrap === undefined
      ? {}
      : {
          bootstrapCompletedAt: now,
          bootstrapInviteCapabilityDigest: bootstrap.capabilityDigest,
          bootstrapInviteLifetimeMs: bootstrap.lifetimeMs,
          bootstrapInvitePublicId: bootstrap.publicId,
        }),
    key: "global",
    updatedAt: now,
  });
}

export const genesisHardAuthority = internalMutation({
  args: {},
  handler: async (ctx) => {
    await requireGenesisEmpty(ctx);
    await insertHardAuthority(ctx, Date.now());
    return { enforcement: "hard" as const };
  },
});

const refuseHostedBootstrap = (): never => {
  throw new Error("HOSTED_BOOTSTRAP_AUTHORITY_REFUSED");
};

export const genesisHostedAuthority = internalMutation({
  args: {
    capabilityDigest: v.string(),
    lifetimeMs: v.number(),
    publicId: v.string(),
  },
  handler: async (ctx, args) => {
    if (
      !isAuthDigest(args.capabilityDigest)
      || args.lifetimeMs !== identityInviteLifetimeMs
      || !isInvitePublicId(args.publicId)
      || invitePublicIdFromCapabilityDigest(args.capabilityDigest) !== args.publicId
    ) return refuseHostedBootstrap();

    const [serviceRows, controlRows, publicInvites, digestInvites, faults] = await Promise.all([
      ctx.db.query("storageUsageService")
        .withIndex("by_key", (builder) => builder.eq("key", "global"))
        .take(2),
      ctx.db.query("serviceControl")
        .withIndex("by_key", (builder) => builder.eq("key", "global"))
        .take(2),
      ctx.db.query("authInvites")
        .withIndex("by_public_id", (builder) => builder.eq("publicId", args.publicId))
        .take(2),
      ctx.db.query("authInvites")
        .withIndex("by_capability_digest", (builder) =>
          builder.eq("capabilityDigest", args.capabilityDigest))
        .take(2),
      ctx.db.query("attentionNotificationSafetyFaults").take(1),
    ]);
    if (serviceRows.length !== 0 || controlRows.length !== 0) {
      const service = serviceRows[0];
      const control = controlRows[0];
      const invite = publicInvites[0];
      if (
        serviceRows.length !== 1
        || controlRows.length !== 1
        || publicInvites.length !== 1
        || digestInvites.length !== 1
        || faults.length !== 0
        || service === undefined
        || control === undefined
        || invite === undefined
        || digestInvites[0]?._id !== invite._id
        || control.attentionNotificationGeneration !== undefined
        || control.attentionNotificationLastMutationId !== undefined
        || control.attentionNotifications !== undefined
        || control.authAdmissionGeneration !== 0
        || control.authAdmissions !== "open"
        || control.bootstrapAcceptedAt !== undefined
        || control.lastMutationId !== undefined
        || control.bootstrapInviteCapabilityDigest !== args.capabilityDigest
        || control.bootstrapInviteLifetimeMs !== args.lifetimeMs
        || control.bootstrapInvitePublicId !== args.publicId
        || control.bootstrapCompletedAt !== control.updatedAt
        || invite.capabilityDigest !== args.capabilityDigest
        || invite.publicId !== args.publicId
        || invite.purpose !== "identity"
        || invite.state !== "issued"
        || invite.issuedByUserId !== undefined
        || invite.requestedLifetimeMs !== args.lifetimeMs
        || invite.admissionExpiresAt !== invite.expiresAt
        || invite.expiresAt - invite.createdAt !== args.lifetimeMs
        || invite.updatedAt !== invite.createdAt
      ) return refuseHostedBootstrap();
      requireHardServiceAuthority(service);
      const inviteBytes = logicalDocumentBytes(invite);
      if (
        service.identities !== 0
        || service.records !== 1
        || service.logicalBytes !== inviteBytes
        || service.serviceRecords !== 1
        || service.serviceLogicalBytes !== inviteBytes
        || service.userRecords !== 0
        || service.userLogicalBytes !== 0
      ) return refuseHostedBootstrap();
      return {
        enforcement: "hard" as const,
        invite: {
          expiresAt: invite.expiresAt,
          publicId: invite.publicId,
          purpose: invite.purpose,
          state: invite.state,
        },
        replay: true,
      };
    }
    if (publicInvites.length !== 0 || digestInvites.length !== 0) {
      return refuseHostedBootstrap();
    }

    await requireGenesisEmpty(ctx);
    const now = Date.now();
    await insertHardAuthority(ctx, now, args);
    const expiresAt = now + args.lifetimeMs;
    const inviteId = await ctx.db.insert("authInvites", {
      admissionExpiresAt: expiresAt,
      capabilityDigest: args.capabilityDigest,
      createdAt: now,
      expiresAt,
      publicId: args.publicId,
      purpose: "identity",
      requestedLifetimeMs: args.lifetimeMs,
      state: "issued",
      updatedAt: now,
    });
    const invite = await ctx.db.get(inviteId);
    if (invite === null) return refuseHostedBootstrap();
    await reserveServiceQuotaForInsert(ctx, invite);
    return {
      enforcement: "hard" as const,
      invite: {
        expiresAt,
        publicId: args.publicId,
        purpose: "identity" as const,
        state: "issued" as const,
      },
      replay: false,
    };
  },
});

/*
 * Reviewed recovery for one specific launch failure: the bootstrap invitation
 * expired before anyone accepted it and its protected capability file is gone.
 * The deployment keeps its quota and admission authority; only the unaccepted
 * first invitation is replaced. Nothing else may exist yet, so the mutation
 * refuses once any identity, acceptance, or foreign invitation is present.
 */
export const reissueHostedBootstrapInvite = internalMutation({
  args: {
    capabilityDigest: v.string(),
    lifetimeMs: v.number(),
    publicId: v.string(),
  },
  handler: async (ctx, args) => {
    if (
      !isAuthDigest(args.capabilityDigest)
      || args.lifetimeMs !== identityInviteLifetimeMs
      || !isInvitePublicId(args.publicId)
      || invitePublicIdFromCapabilityDigest(args.capabilityDigest) !== args.publicId
    ) return refuseHostedBootstrap();

    const [serviceRows, controlRows, invites, users, faults] = await Promise.all([
      ctx.db.query("storageUsageService")
        .withIndex("by_key", (builder) => builder.eq("key", "global"))
        .take(2),
      ctx.db.query("serviceControl")
        .withIndex("by_key", (builder) => builder.eq("key", "global"))
        .take(2),
      ctx.db.query("authInvites").take(3),
      ctx.db.query("users").take(1),
      ctx.db.query("attentionNotificationSafetyFaults").take(1),
    ]);
    const service = serviceRows[0];
    const control = controlRows[0];
    if (
      serviceRows.length !== 1
      || controlRows.length !== 1
      || service === undefined
      || control === undefined
      || users.length !== 0
      || faults.length !== 0
      || invites.length > 1
      || control.bootstrapAcceptedAt !== undefined
      || control.bootstrapCompletedAt === undefined
      || control.bootstrapInviteLifetimeMs !== identityInviteLifetimeMs
      || !isAuthDigest(control.bootstrapInviteCapabilityDigest)
      || !isInvitePublicId(control.bootstrapInvitePublicId)
      || invitePublicIdFromCapabilityDigest(control.bootstrapInviteCapabilityDigest)
        !== control.bootstrapInvitePublicId
    ) return refuseHostedBootstrap();
    requireHardServiceAuthority(service);
    const invite = invites[0];
    const inviteBytes = invite === undefined ? 0 : logicalDocumentBytes(invite);
    if (
      service.identities !== 0
      || service.records !== invites.length
      || service.logicalBytes !== inviteBytes
      || service.serviceRecords !== invites.length
      || service.serviceLogicalBytes !== inviteBytes
      || service.userRecords !== 0
      || service.userLogicalBytes !== 0
      || (
        invite !== undefined
        && (
          invite.capabilityDigest !== control.bootstrapInviteCapabilityDigest
          || invite.publicId !== control.bootstrapInvitePublicId
          || invite.purpose !== "identity"
          || invite.state !== "issued"
          || invite.issuedByUserId !== undefined
          || invite.boundAt !== undefined
          || invite.boundEmailDigest !== undefined
          || invite.consumedAt !== undefined
          || invite.revokedAt !== undefined
          || invite.requestedLifetimeMs !== identityInviteLifetimeMs
          || invite.admissionExpiresAt !== invite.expiresAt
          || invite.expiresAt - invite.createdAt !== identityInviteLifetimeMs
          || invite.updatedAt !== invite.createdAt
        )
      )
    ) return refuseHostedBootstrap();

    const now = Date.now();
    if (control.bootstrapInviteCapabilityDigest === args.capabilityDigest) {
      if (
        invite === undefined
        || control.bootstrapInvitePublicId !== args.publicId
        || control.bootstrapCompletedAt > control.updatedAt
        || invite.expiresAt <= now
      ) return refuseHostedBootstrap();
      return {
        enforcement: "hard" as const,
        invite: {
          expiresAt: invite.expiresAt,
          publicId: invite.publicId,
          purpose: invite.purpose,
          state: invite.state,
        },
        replay: true,
      };
    }
    if (invite !== undefined) {
      if (invite.expiresAt > now) return refuseHostedBootstrap();
      await releaseServiceQuotaForDelete(ctx, invite);
      await ctx.db.delete(invite._id);
    }
    const expiresAt = now + args.lifetimeMs;
    const inviteId = await ctx.db.insert("authInvites", {
      admissionExpiresAt: expiresAt,
      capabilityDigest: args.capabilityDigest,
      createdAt: now,
      expiresAt,
      publicId: args.publicId,
      purpose: "identity",
      requestedLifetimeMs: args.lifetimeMs,
      state: "issued",
      updatedAt: now,
    });
    const reissued = await ctx.db.get(inviteId);
    if (reissued === null) return refuseHostedBootstrap();
    await reserveServiceQuotaForInsert(ctx, reissued);
    await ctx.db.patch(control._id, {
      bootstrapCompletedAt: now,
      bootstrapInviteCapabilityDigest: args.capabilityDigest,
      bootstrapInviteLifetimeMs: args.lifetimeMs,
      bootstrapInvitePublicId: args.publicId,
      updatedAt: now,
    });
    return {
      enforcement: "hard" as const,
      invite: {
        expiresAt,
        publicId: args.publicId,
        purpose: "identity" as const,
        state: "issued" as const,
      },
      replay: false,
    };
  },
});

/*
 * This bounded, non-secret projection is deliberately narrower than the
 * bootstrap mutation's recovery readback. It lets an operator distinguish an
 * untouched deployment from the exact first hosted-bootstrap frame without
 * returning an invitation, a quota value, or an application row.
 */
export const hostedBootstrapStatus = internalQuery({
  args: {},
  handler: async (ctx) => {
    const [
      quota,
      control,
      users,
      authSessions,
      authAccounts,
      authRefreshTokens,
      authVerificationCodes,
      authVerifiers,
      authRateLimits,
      authSubjects,
      authEmailAttemptEvents,
      authOtpChallenges,
      invites,
      devices,
      accountDeletionIdentityReservations,
      accountDeletionJobReservations,
      deviceRevocationDeviceReservations,
      deviceRevocationJobReservations,
      deviceRevocationSecurityReservations,
      deviceRevocationReceiptReservations,
      deviceSessions,
      deviceBindChallenges,
      deviceKeyEnvelopes,
      recoveryEnvelopes,
      devicePresence,
      deviceRegistries,
      memorySpaces,
      memoryOperations,
      sessionHeads,
      sessionChunks,
      sessionStreamEpochs,
      executionLeases,
      sessionCommands,
      deviceCommands,
      commandLifecycleReservations,
      commandTerminalSecurityReservations,
      attentionNotificationOutbox,
      attentionNotificationSafetyFaults,
      codexAccounts,
      deviceAccountBindings,
      accountUsageSnapshots,
      idempotencyReceipts,
      securityEvents,
      accountDeletionJobs,
      accountDeletionReceipts,
      deviceRevocationJobs,
      storageUsageByUser,
      storageResourceUsageByUser,
      storageResourceUsageByAccount,
      maintenanceState,
    ] = await Promise.all([
      ctx.db.query("storageUsageService").take(2),
      ctx.db.query("serviceControl").take(2),
      ctx.db.query("users").take(2),
      ctx.db.query("authSessions").take(2),
      ctx.db.query("authAccounts").take(2),
      ctx.db.query("authRefreshTokens").take(2),
      ctx.db.query("authVerificationCodes").take(2),
      ctx.db.query("authVerifiers").take(2),
      ctx.db.query("authRateLimits").take(2),
      ctx.db.query("authSubjects").take(2),
      ctx.db.query("authEmailAttemptEvents").take(2),
      ctx.db.query("authOtpChallenges").take(2),
      ctx.db.query("authInvites").take(2),
      ctx.db.query("devices").take(2),
      ctx.db.query("accountDeletionIdentityReservations").take(2),
      ctx.db.query("accountDeletionJobReservations").take(2),
      ctx.db.query("deviceRevocationDeviceReservations").take(2),
      ctx.db.query("deviceRevocationJobReservations").take(2),
      ctx.db.query("deviceRevocationSecurityReservations").take(2),
      ctx.db.query("deviceRevocationReceiptReservations").take(2),
      ctx.db.query("deviceSessions").take(2),
      ctx.db.query("deviceBindChallenges").take(2),
      ctx.db.query("deviceKeyEnvelopes").take(2),
      ctx.db.query("recoveryEnvelopes").take(2),
      ctx.db.query("devicePresence").take(2),
      ctx.db.query("deviceRegistries").take(2),
      ctx.db.query("memorySpaces").take(2),
      ctx.db.query("memoryOperations").take(2),
      ctx.db.query("sessionHeads").take(2),
      ctx.db.query("sessionChunks").take(2),
      ctx.db.query("sessionStreamEpochs").take(2),
      ctx.db.query("executionLeases").take(2),
      ctx.db.query("sessionCommands").take(2),
      ctx.db.query("deviceCommands").take(2),
      ctx.db.query("commandLifecycleReservations").take(2),
      ctx.db.query("commandTerminalSecurityReservations").take(2),
      ctx.db.query("attentionNotificationOutbox").take(2),
      ctx.db.query("attentionNotificationSafetyFaults").take(2),
      ctx.db.query("codexAccounts").take(2),
      ctx.db.query("deviceAccountBindings").take(2),
      ctx.db.query("accountUsageSnapshots").take(2),
      ctx.db.query("idempotencyReceipts").take(2),
      ctx.db.query("securityEvents").take(2),
      ctx.db.query("accountDeletionJobs").take(2),
      ctx.db.query("accountDeletionReceipts").take(2),
      ctx.db.query("deviceRevocationJobs").take(2),
      ctx.db.query("storageUsageByUser").take(2),
      ctx.db.query("storageResourceUsageByUser").take(2),
      ctx.db.query("storageResourceUsageByAccount").take(2),
      ctx.db.query("maintenanceState").take(2),
    ]);
    const rows = [
      quota,
      control,
      users,
      authSessions,
      authAccounts,
      authRefreshTokens,
      authVerificationCodes,
      authVerifiers,
      authRateLimits,
      authSubjects,
      authEmailAttemptEvents,
      authOtpChallenges,
      invites,
      devices,
      accountDeletionIdentityReservations,
      accountDeletionJobReservations,
      deviceRevocationDeviceReservations,
      deviceRevocationJobReservations,
      deviceRevocationSecurityReservations,
      deviceRevocationReceiptReservations,
      deviceSessions,
      deviceBindChallenges,
      deviceKeyEnvelopes,
      recoveryEnvelopes,
      devicePresence,
      deviceRegistries,
      memorySpaces,
      memoryOperations,
      sessionHeads,
      sessionChunks,
      sessionStreamEpochs,
      executionLeases,
      sessionCommands,
      deviceCommands,
      commandLifecycleReservations,
      commandTerminalSecurityReservations,
      attentionNotificationOutbox,
      attentionNotificationSafetyFaults,
      codexAccounts,
      deviceAccountBindings,
      accountUsageSnapshots,
      idempotencyReceipts,
      securityEvents,
      accountDeletionJobs,
      accountDeletionReceipts,
      deviceRevocationJobs,
      storageUsageByUser,
      storageResourceUsageByUser,
      storageResourceUsageByAccount,
      maintenanceState,
    ];
    const occupiedTableCount = rows.filter((entry) => entry.length !== 0).length;
    const serviceControlCount = control.length === 0 ? 0 : control.length === 1 ? 1 : 2;
    if (occupiedTableCount === 0) {
      return { occupiedTableCount, serviceControlCount, state: "uninitialized" as const };
    }

    const service = quota[0];
    const controlRow = control[0];
    const invite = invites[0];
    let inviteBytes: number | undefined;
    try {
      if (invite !== undefined) inviteBytes = logicalDocumentBytes(invite);
    } catch {
      inviteBytes = undefined;
    }
    const inviteValid = (
      invites.length === 1
      && invite !== undefined
      && isAuthDigest(invite.capabilityDigest)
      && isInvitePublicId(invite.publicId)
      && invitePublicIdFromCapabilityDigest(invite.capabilityDigest) === invite.publicId
      && invite.purpose === "identity"
      && invite.state === "issued"
      && invite.issuedByUserId === undefined
      && invite.boundAt === undefined
      && invite.boundEmailDigest === undefined
      && invite.consumedAt === undefined
      && invite.revokedAt === undefined
      && invite.requestedLifetimeMs === identityInviteLifetimeMs
      && isFiniteTimestamp(invite.createdAt)
      && isFiniteTimestamp(invite.expiresAt)
      && isFiniteTimestamp(invite.admissionExpiresAt)
      && isFiniteTimestamp(invite.updatedAt)
      && invite.admissionExpiresAt === invite.expiresAt
      && invite.expiresAt - invite.createdAt === identityInviteLifetimeMs
      && invite.updatedAt === invite.createdAt
      && invite.expiresAt > Date.now()
    );
    const controlValid = (
      control.length === 1
      && controlRow !== undefined
      && controlRow.attentionNotificationGeneration === undefined
      && controlRow.attentionNotificationLastMutationId === undefined
      && controlRow.attentionNotifications === undefined
      && controlRow.authAdmissionGeneration === 0
      && controlRow.authAdmissions === "open"
      && controlRow.lastMutationId === undefined
      && controlRow.bootstrapAcceptedAt === undefined
      && isFiniteTimestamp(controlRow.updatedAt)
      && isFiniteTimestamp(controlRow.bootstrapCompletedAt)
      && controlRow.bootstrapCompletedAt === controlRow.updatedAt
      && isAuthDigest(controlRow.bootstrapInviteCapabilityDigest)
      && isInvitePublicId(controlRow.bootstrapInvitePublicId)
      && controlRow.bootstrapInviteLifetimeMs === identityInviteLifetimeMs
      && invitePublicIdFromCapabilityDigest(controlRow.bootstrapInviteCapabilityDigest)
        === controlRow.bootstrapInvitePublicId
      && invite !== undefined
      && controlRow.bootstrapInviteCapabilityDigest === invite.capabilityDigest
      && controlRow.bootstrapInvitePublicId === invite.publicId
      && controlRow.bootstrapInviteLifetimeMs === invite.requestedLifetimeMs
      && controlRow.bootstrapCompletedAt === invite.createdAt
    );
    const quotaValid = (
      quota.length === 1
      && service !== undefined
      && service.enforcement === "hard"
      && isSafeNonNegativeInteger(service.identities)
      && isSafeNonNegativeInteger(service.logicalBytes)
      && isSafeNonNegativeInteger(service.records)
      && isSafeNonNegativeInteger(service.serviceLogicalBytes)
      && isSafeNonNegativeInteger(service.serviceRecords)
      && isSafeNonNegativeInteger(service.userLogicalBytes)
      && isSafeNonNegativeInteger(service.userRecords)
      && isFiniteTimestamp(service.updatedAt)
      && service.identities === 0
      && service.records === 1
      && service.serviceRecords === 1
      && service.userRecords === 0
      && service.userLogicalBytes === 0
      && service.logicalBytes === service.serviceLogicalBytes + service.userLogicalBytes
      && service.records === service.serviceRecords + service.userRecords
      && service.logicalBytes === inviteBytes
      && service.serviceLogicalBytes === inviteBytes
    );
    const ready = occupiedTableCount === 3 && quotaValid && controlValid && inviteValid;
    /*
     * After the first invitation is consumed the deployment is live: the
     * control row carries a durable accepted timestamp that is ordered after
     * bootstrap completion and no later than its last update, and the hard
     * quota singleton is still coherent. Admission generation and state are
     * reported separately and may have moved.
     */
    const accepted = (
      control.length === 1
      && controlRow !== undefined
      && quota.length === 1
      && service !== undefined
      && service.enforcement === "hard"
      && isSafeNonNegativeInteger(service.identities)
      && isSafeNonNegativeInteger(service.records)
      && isFiniteTimestamp(controlRow.updatedAt)
      && isFiniteTimestamp(controlRow.bootstrapCompletedAt)
      && isFiniteTimestamp(controlRow.bootstrapAcceptedAt)
      && controlRow.bootstrapCompletedAt <= controlRow.bootstrapAcceptedAt
      && controlRow.bootstrapAcceptedAt <= controlRow.updatedAt
      && isAuthDigest(controlRow.bootstrapInviteCapabilityDigest)
      && isInvitePublicId(controlRow.bootstrapInvitePublicId)
      && controlRow.bootstrapInviteLifetimeMs === identityInviteLifetimeMs
      && invitePublicIdFromCapabilityDigest(controlRow.bootstrapInviteCapabilityDigest)
        === controlRow.bootstrapInvitePublicId
    );
    return {
      occupiedTableCount,
      serviceControlCount,
      state: ready ? "ready" as const : accepted ? "accepted" as const : "inconsistent" as const,
    };
  },
});

type QuotaUpgradeRuntime = Infer<typeof runtimeReleaseAttestation>;
type QuotaUpgradeDisposition = "legacy" | "unmarked_current" | "current";
type QuotaUpgradeClassification = Readonly<{
  disposition: QuotaUpgradeDisposition;
  identityRowId: Id<"storageUsageByUser">;
}>;

export const quotaUpgradeCorruptionReasons = [
  "identity_missing", "service_authority", "duplicate_categories", "duplicate_resources",
  "category_authority", "category_ceiling", "user_total", "service_total",
  "resource_authority", "resource_ceiling", "identity_category_missing",
  "memory_counters", "schema_shape", "legacy_memory_present", "unknown_authority",
] as const;
type QuotaUpgradeCorruptionReason = typeof quotaUpgradeCorruptionReasons[number];

export const emptyQuotaUpgradeCorruptionCounts = (): Record<QuotaUpgradeCorruptionReason, number> => ({
  identity_missing: 0, service_authority: 0, duplicate_categories: 0, duplicate_resources: 0,
  category_authority: 0, category_ceiling: 0, user_total: 0, service_total: 0,
  resource_authority: 0, resource_ceiling: 0, identity_category_missing: 0,
  memory_counters: 0, schema_shape: 0, legacy_memory_present: 0, unknown_authority: 0,
});

class QuotaUpgradeClassificationError extends Error {
  constructor(readonly reason: QuotaUpgradeCorruptionReason) {
    // Preserve the existing audit and mutation refusal contract. Only the
    // separate read-only diagnostic projects the closed reason count.
    super("QUOTA_AUTHORITY_CORRUPT");
  }
}
const quotaUpgradeCorrupt = (reason: QuotaUpgradeCorruptionReason): never => {
  throw new QuotaUpgradeClassificationError(reason);
};

// This list names one reviewed predecessor schema. Deriving it by subtracting
// today's additions would silently authorize future unknown upgrade shapes.
const predecessorQuotaCategories = [
  "identity", "device", "account", "session", "chunk", "usage",
  "command", "custody", "receipt", "security", "job",
] as const;
const predecessorQuotaResources = [
  "device", "codex_account", "session_head", "session_chunk",
  "nonterminal_command", "live_chunk",
] as const;

function quotaUpgradeRuntimeTuple(runtime: QuotaUpgradeRuntime): readonly unknown[] {
  return runtime.bound
    ? [runtime.bound, runtime.schemaIdentity, runtime.schemaVersion,
      runtime.deployedAtMs, runtime.previousDeployDigest, runtime.runtimeRevision, runtime.runtimeSourceCommit]
    : [runtime.bound, runtime.schemaIdentity, runtime.schemaVersion];
}

function requireQuotaUpgradeRuntime(expected: QuotaUpgradeRuntime, runtime: QuotaUpgradeRuntime): void {
  if (!expected.bound || !runtime.bound
    || JSON.stringify(quotaUpgradeRuntimeTuple(expected))
      !== JSON.stringify(quotaUpgradeRuntimeTuple(runtime))) {
    throw new Error("QUOTA_UPGRADE_RUNTIME_CHANGED");
  }
}

async function classifyUserQuotaUpgrade(
  ctx: QueryCtx,
  userId: Id<"users">,
): Promise<QuotaUpgradeClassification> {
  const [user, serviceRows, categories, resources] = await Promise.all([
    ctx.db.get(userId),
    ctx.db.query("storageUsageService")
      .withIndex("by_key", (query) => query.eq("key", "global")).take(2),
    ctx.db.query("storageUsageByUser")
      .withIndex("by_user_and_category", (query) => query.eq("userId", userId))
      .take(QUOTA_CATEGORIES.length + 1),
    ctx.db.query("storageResourceUsageByUser")
      .withIndex("by_user_and_resource", (query) => query.eq("userId", userId))
      .take(USER_QUOTA_RESOURCES.length + 1),
  ]);
  if (user === null) return quotaUpgradeCorrupt("identity_missing");
  if (serviceRows.length !== 1) return quotaUpgradeCorrupt("service_authority");
  const service = requireHardServiceAuthority(serviceRows[0]);
  const byCategory = new Map(categories.map((row) => [row.category, row]));
  const byResource = new Map(resources.map((row) => [row.resource, row]));
  if (byCategory.size !== categories.length) return quotaUpgradeCorrupt("duplicate_categories");
  if (byResource.size !== resources.length) return quotaUpgradeCorrupt("duplicate_resources");
  let logicalBytes = 0;
  let records = 0;
  for (const row of categories) {
    if (
      !QUOTA_CATEGORIES.includes(row.category)
      || !validQuotaSchemaMarker(row)
      || !safeCounter(row.logicalBytes)
      || !safeCounter(row.records)
      || !isFiniteTimestamp(row.updatedAt)
      || !canonicalUsagePair(row.logicalBytes, row.records)
    ) return quotaUpgradeCorrupt("category_authority");
    if (row.logicalBytes > CATEGORY_QUOTAS[row.category].logicalBytes
      || row.records > CATEGORY_QUOTAS[row.category].records) return quotaUpgradeCorrupt("category_ceiling");
    logicalBytes += row.logicalBytes;
    records += row.records;
    if (!safeCounter(logicalBytes) || !safeCounter(records)) return quotaUpgradeCorrupt("user_total");
  }
  if (
    logicalBytes > USER_TOTAL_QUOTA.logicalBytes
    || records > USER_TOTAL_QUOTA.records
    || !canonicalUsagePair(logicalBytes, records)
  ) return quotaUpgradeCorrupt("user_total");
  if (logicalBytes > service.userLogicalBytes || records > service.userRecords) return quotaUpgradeCorrupt("service_total");
  for (const row of resources) {
    if (
      !USER_QUOTA_RESOURCES.includes(row.resource)
      || !safeCounter(row.records)
      || !isFiniteTimestamp(row.updatedAt)
    ) return quotaUpgradeCorrupt("resource_authority");
    if (row.records > USER_RESOURCE_QUOTAS[row.resource]) return quotaUpgradeCorrupt("resource_ceiling");
  }
  const identity = byCategory.get("identity");
  if (identity === undefined) return quotaUpgradeCorrupt("identity_category_missing");
  const current = categories.length === QUOTA_CATEGORIES.length
    && resources.length === USER_QUOTA_RESOURCES.length
    && QUOTA_CATEGORIES.every((category) => byCategory.has(category))
    && USER_QUOTA_RESOURCES.every((resource) => byResource.has(resource));
  if (current) {
    const memory = byCategory.get("memory");
    const memorySpace = byResource.get("memory_space");
    // Every charged memory space is also one record in its category. A
    // complete ledger with contradictory counters must not acquire a marker.
    if (memory === undefined || memorySpace === undefined || memorySpace.records > memory.records) return quotaUpgradeCorrupt("memory_counters");
    return {
      disposition: identity.quotaSchemaVersion === undefined ? "unmarked_current" : "current",
      identityRowId: identity._id,
    };
  }
  if (
    identity.quotaSchemaVersion !== undefined
    || categories.length !== predecessorQuotaCategories.length
    || resources.length !== predecessorQuotaResources.length
    || !predecessorQuotaCategories.every((category) => byCategory.has(category))
    || !predecessorQuotaResources.every((resource) => byResource.has(resource))
  ) return quotaUpgradeCorrupt("schema_shape");
  const [space, operation] = await Promise.all([
    ctx.db.query("memorySpaces")
      .withIndex("by_user_and_public_id", (query) => query.eq("userId", userId)).take(1),
    ctx.db.query("memoryOperations")
      .withIndex("by_user", (query) => query.eq("userId", userId)).take(1),
  ]);
  // Even an orphan operation disproves zero usage. Never infer absence from
  // missing space rows or inspect another owner's content.
  if (space.length !== 0 || operation.length !== 0) return quotaUpgradeCorrupt("legacy_memory_present");
  return { disposition: "legacy", identityRowId: identity._id };
}

function requireQuotaUpgradePageSize(numItems: number): void {
  if (!Number.isSafeInteger(numItems) || numItems < 1 || numItems > maximumUserQuotaUpgradeBatch) corrupt();
}

type QuotaUpgradePageArgs = Readonly<{
  expectedRuntimeAttestation: QuotaUpgradeRuntime;
  paginationOpts: Infer<typeof userQuotaUpgradePaginationOpts>;
}>;

// The explicit runtime parameter is the credential-free server-test seam.
// Registered production functions below always supply their compiled constant.
export async function auditUserQuotaUpgradePageForRuntime(
  ctx: QueryCtx,
  args: QuotaUpgradePageArgs,
  runtime: QuotaUpgradeRuntime,
) {
  requireQuotaUpgradeRuntime(args.expectedRuntimeAttestation, runtime);
  requireQuotaUpgradePageSize(args.paginationOpts.numItems);
  await requireHardQuotaAuthority(ctx);
  const page = await ctx.db.query("users").paginate({
    cursor: args.paginationOpts.cursor,
    numItems: args.paginationOpts.numItems,
    maximumRowsRead: maximumUserQuotaUpgradeBatch,
  });
  if (page.page.length > maximumUserQuotaUpgradeBatch) return corrupt();
  const counts = { legacy: 0, unmarkedCurrent: 0, current: 0, corrupt: 0 };
  for (const user of page.page) {
    try {
      const result = await classifyUserQuotaUpgrade(ctx, user._id);
      switch (result.disposition) {
        case "legacy": counts.legacy += 1; break;
        case "unmarked_current": counts.unmarkedCurrent += 1; break;
        case "current": counts.current += 1; break;
      }
    } catch (error: unknown) {
      if (!(error instanceof Error) || error.message !== "QUOTA_AUTHORITY_CORRUPT") throw error;
      counts.corrupt += 1;
    }
  }
  return { ...counts, continueCursor: page.continueCursor, isDone: page.isDone, scanned: page.page.length, schemaVersion: 1 as const };
}

/** One first-failure reason per inconsistent ledger, never identities or raw counters. */
export async function diagnoseUserQuotaUpgradePageForRuntime(
  ctx: QueryCtx,
  args: QuotaUpgradePageArgs,
  runtime: QuotaUpgradeRuntime,
) {
  requireQuotaUpgradeRuntime(args.expectedRuntimeAttestation, runtime);
  requireQuotaUpgradePageSize(args.paginationOpts.numItems);
  await requireHardQuotaAuthority(ctx);
  const page = await ctx.db.query("users").paginate({
    cursor: args.paginationOpts.cursor,
    numItems: args.paginationOpts.numItems,
    maximumRowsRead: maximumUserQuotaUpgradeBatch,
  });
  if (page.page.length > maximumUserQuotaUpgradeBatch) return corrupt();
  const reasons = emptyQuotaUpgradeCorruptionCounts();
  const counts = { legacy: 0, unmarkedCurrent: 0, current: 0, corrupt: 0 };
  for (const user of page.page) {
    try {
      const result = await classifyUserQuotaUpgrade(ctx, user._id);
      switch (result.disposition) {
        case "legacy": counts.legacy += 1; break;
        case "unmarked_current": counts.unmarkedCurrent += 1; break;
        case "current": counts.current += 1; break;
      }
    } catch (error: unknown) {
      if (!(error instanceof Error) || error.message !== "QUOTA_AUTHORITY_CORRUPT") throw error;
      counts.corrupt += 1;
      reasons[error instanceof QuotaUpgradeClassificationError ? error.reason : "unknown_authority"] += 1;
    }
  }
  return { ...counts, reasons, continueCursor: page.continueCursor, isDone: page.isDone,
    scanned: page.page.length, schemaVersion: 1 as const };
}

export async function upgradeUserQuotaPageForRuntime(
  ctx: MutationCtx,
  args: QuotaUpgradePageArgs,
  runtime: QuotaUpgradeRuntime,
) {
  requireQuotaUpgradeRuntime(args.expectedRuntimeAttestation, runtime);
  requireQuotaUpgradePageSize(args.paginationOpts.numItems);
  await requireHardQuotaAuthority(ctx);
  const page = await ctx.db.query("users").paginate({
    cursor: args.paginationOpts.cursor,
    numItems: args.paginationOpts.numItems,
    maximumRowsRead: maximumUserQuotaUpgradeBatch,
  });
  if (page.page.length > maximumUserQuotaUpgradeBatch) return corrupt();
  let upgraded = 0;
  let marked = 0;
  for (const user of page.page) {
    const result = await classifyUserQuotaUpgrade(ctx, user._id);
    if (result.disposition === "current") continue;
    if (result.disposition === "legacy") {
      const updatedAt = Date.now();
      await ctx.db.insert("storageUsageByUser", {
        category: "memory", logicalBytes: 0, records: 0, updatedAt, userId: user._id,
      });
      await ctx.db.insert("storageResourceUsageByUser", {
        resource: "memory_space", records: 0, updatedAt, userId: user._id,
      });
      upgraded += 1;
    }
    await ctx.db.patch(result.identityRowId, { quotaSchemaVersion: currentUserQuotaSchemaVersion });
    marked += 1;
  }
  return { continueCursor: page.continueCursor, current: page.page.length - marked, isDone: page.isDone, marked, scanned: page.page.length, schemaVersion: 1 as const, upgraded };
}

/** Read-only aggregate classification; raw identity and quota rows stay internal. */
export const auditUserQuotaUpgradePage = internalQuery({
  args: {
    expectedRuntimeAttestation: runtimeReleaseAttestation,
    paginationOpts: userQuotaUpgradePaginationOpts,
  },
  handler: async (ctx, args) => await auditUserQuotaUpgradePageForRuntime(ctx, args, RELEASE_ATTESTATION),
});

export const diagnoseUserQuotaUpgradePage = internalQuery({
  args: {
    expectedRuntimeAttestation: runtimeReleaseAttestation,
    paginationOpts: userQuotaUpgradePaginationOpts,
  },
  handler: async (ctx, args) => await diagnoseUserQuotaUpgradePageForRuntime(ctx, args, RELEASE_ATTESTATION),
});

/** One atomic page. Any refusal rolls back additions for every selected user. */
export const upgradeUserQuotaPage = internalMutation({
  args: {
    expectedRuntimeAttestation: runtimeReleaseAttestation,
    paginationOpts: userQuotaUpgradePaginationOpts,
  },
  handler: async (ctx, args) => await upgradeUserQuotaPageForRuntime(ctx, args, RELEASE_ATTESTATION),
});

export async function initializeUserQuotaAuthority(
  ctx: MutationCtx,
  userId: Id<"users">,
): Promise<void> {
  const [serviceRows, user, categoryRows, resourceRows] = await Promise.all([
    ctx.db.query("storageUsageService")
      .withIndex("by_key", (builder) => builder.eq("key", "global"))
      .take(2),
    ctx.db.get(userId),
    ctx.db.query("storageUsageByUser")
      .withIndex("by_user_and_category", (builder) => builder.eq("userId", userId))
      .take(QUOTA_CATEGORIES.length + 1),
    ctx.db.query("storageResourceUsageByUser")
      .withIndex("by_user_and_resource", (builder) => builder.eq("userId", userId))
      .take(USER_QUOTA_RESOURCES.length + 1),
  ]);
  if (serviceRows.length !== 1) corrupt();
  requireHardServiceAuthority(serviceRows[0]);
  if (user === null || categoryRows.length !== 0 || resourceRows.length !== 0) {
    corrupt();
  }
  const now = Date.now();
  for (const category of QUOTA_CATEGORIES) {
    await ctx.db.insert("storageUsageByUser", {
      category,
      ...(category === "identity" ? { quotaSchemaVersion: currentUserQuotaSchemaVersion } : {}),
      logicalBytes: 0,
      records: 0,
      updatedAt: now,
      userId,
    });
  }
  for (const resource of USER_QUOTA_RESOURCES) {
    await ctx.db.insert("storageResourceUsageByUser", {
      records: 0,
      resource,
      updatedAt: now,
      userId,
    });
  }
}

export async function finalizeUserQuotaAuthorityForDelete(
  ctx: MutationCtx,
  userId: Id<"users">,
): Promise<void> {
  const [serviceRows, user, categoryRows, resourceRows, accountRows] = await Promise.all([
    ctx.db.query("storageUsageService")
      .withIndex("by_key", (builder) => builder.eq("key", "global"))
      .take(2),
    ctx.db.get(userId),
    ctx.db.query("storageUsageByUser")
      .withIndex("by_user_and_category", (builder) => builder.eq("userId", userId))
      .take(QUOTA_CATEGORIES.length + 1),
    ctx.db.query("storageResourceUsageByUser")
      .withIndex("by_user_and_resource", (builder) => builder.eq("userId", userId))
      .take(USER_QUOTA_RESOURCES.length + 1),
    ctx.db.query("storageResourceUsageByAccount")
      .withIndex("by_user", (builder) => builder.eq("userId", userId))
      .take(1),
  ]);
  if (serviceRows.length !== 1) corrupt();
  requireHardServiceAuthority(serviceRows[0]);
  if (
    user === null
    || categoryRows.length !== QUOTA_CATEGORIES.length
    || resourceRows.length !== USER_QUOTA_RESOURCES.length
    || accountRows.length !== 0
  ) corrupt();
  const categories = new Set<QuotaCategory>();
  for (const row of categoryRows) {
    if (
      categories.has(row.category)
      || !validQuotaSchemaMarker(row)
      || row.logicalBytes !== 0
      || row.records !== 0
    ) corrupt();
    categories.add(row.category);
  }
  const resources = new Set<UserQuotaResource>();
  for (const row of resourceRows) {
    if (resources.has(row.resource) || row.records !== 0) corrupt();
    resources.add(row.resource);
  }
  if (
    categories.size !== QUOTA_CATEGORIES.length
    || resources.size !== USER_QUOTA_RESOURCES.length
  ) corrupt();
  for (const row of categoryRows) await ctx.db.delete(row._id);
  for (const row of resourceRows) await ctx.db.delete(row._id);
}

export const initializeUser = internalMutation({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    await initializeUserQuotaAuthority(ctx, args.userId);
    return {
      categories: QUOTA_CATEGORIES.length,
      resources: USER_QUOTA_RESOURCES.length,
    };
  },
});

export const readUser = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const rows = await ctx.db.query("storageUsageByUser")
      .withIndex("by_user_and_category", (builder) => builder.eq("userId", args.userId))
      .collect();
    return rows.map(({ category, logicalBytes, records, updatedAt }) => ({
      category,
      logicalBytes,
      records,
      updatedAt,
    }));
  },
});

const directlyAuditableTable = v.union(
  v.literal("sessionHeads"),
  v.literal("sessionChunks"),
  v.literal("sessionStreamEpochs"),
  v.literal("executionLeases"),
  v.literal("sessionCommands"),
  v.literal("deviceCommands"),
  v.literal("accountDeletionIdentityReservations"),
  v.literal("accountDeletionJobReservations"),
  v.literal("deviceRevocationDeviceReservations"),
  v.literal("deviceRevocationJobReservations"),
  v.literal("deviceRevocationSecurityReservations"),
  v.literal("deviceRevocationReceiptReservations"),
  v.literal("commandLifecycleReservations"),
  v.literal("commandTerminalSecurityReservations"),
  v.literal("attentionNotificationOutbox"),
  v.literal("codexAccounts"),
  v.literal("deviceAccountBindings"),
  v.literal("accountUsageSnapshots"),
  v.literal("idempotencyReceipts"),
  v.literal("securityEvents"),
  v.literal("devicePresence"),
  v.literal("memorySpaces"),
  v.literal("memoryOperations"),
  v.literal("accountDeletionJobs"),
  v.literal("deviceRevocationJobs"),
);

const DIRECT_TABLE_CATEGORY = {
  sessionHeads: "session",
  sessionChunks: "chunk",
  sessionStreamEpochs: "chunk",
  executionLeases: "session",
  sessionCommands: "command",
  deviceCommands: "command",
  accountDeletionIdentityReservations: "identity",
  accountDeletionJobReservations: "job",
  deviceRevocationDeviceReservations: "device",
  deviceRevocationJobReservations: "job",
  deviceRevocationSecurityReservations: "security",
  deviceRevocationReceiptReservations: "receipt",
  commandLifecycleReservations: "command",
  commandTerminalSecurityReservations: "security",
  attentionNotificationOutbox: "command",
  codexAccounts: "account",
  deviceAccountBindings: "account",
  accountUsageSnapshots: "usage",
  idempotencyReceipts: "receipt",
  securityEvents: "security",
  devicePresence: "device",
  memorySpaces: "memory",
  memoryOperations: "memory",
  accountDeletionJobs: "job",
  deviceRevocationJobs: "job",
} as const;

/**
 * Server-computed shadow audit page. Each call reads at most 200 ordinary
 * documents or eight potentially maximal command/capacity documents.
 * Parent-owned and capability-owned auth rows require schema attribution and
 * are deliberately excluded instead of guessing an owner.
 */
export const auditDirectTablePage = internalQuery({
  args: {
    paginationOpts: paginationOptsValidator,
    table: directlyAuditableTable,
    userId: v.id("users"),
  },
  handler: async (ctx, args) => {
    const maximumPage = (
      args.table === "sessionCommands"
      || args.table === "deviceCommands"
      || args.table === "commandLifecycleReservations"
    )
      ? maximumCommandLifecycleBatch
      : 200;
    if (
      !Number.isSafeInteger(args.paginationOpts.numItems)
      || args.paginationOpts.numItems < 1
      || args.paginationOpts.numItems > maximumPage
    ) corrupt();
    const paginationOpts = args.paginationOpts;
    const result = await (async () => {
      switch (args.table) {
        case "sessionHeads":
          return await ctx.db.query("sessionHeads")
            .withIndex("by_user_and_updated_at", (builder) => builder.eq("userId", args.userId))
            .paginate(paginationOpts);
        case "sessionChunks":
          return await ctx.db.query("sessionChunks")
            .withIndex("by_user", (builder) => builder.eq("userId", args.userId))
            .paginate(paginationOpts);
        case "sessionStreamEpochs":
          return await ctx.db.query("sessionStreamEpochs")
            .withIndex("by_user", (builder) => builder.eq("userId", args.userId))
            .paginate(paginationOpts);
        case "executionLeases":
          return await ctx.db.query("executionLeases")
            .withIndex("by_user", (builder) => builder.eq("userId", args.userId))
            .paginate(paginationOpts);
        case "sessionCommands":
          return await ctx.db.query("sessionCommands")
            .withIndex("by_user", (builder) => builder.eq("userId", args.userId))
            .paginate(paginationOpts);
        case "deviceCommands":
          return await ctx.db.query("deviceCommands")
            .withIndex("by_user", (builder) => builder.eq("userId", args.userId))
            .paginate(paginationOpts);
        case "accountDeletionIdentityReservations":
          return await ctx.db.query("accountDeletionIdentityReservations")
            .withIndex("by_user", (builder) => builder.eq("userId", args.userId))
            .paginate(paginationOpts);
        case "accountDeletionJobReservations":
          return await ctx.db.query("accountDeletionJobReservations")
            .withIndex("by_user", (builder) => builder.eq("userId", args.userId))
            .paginate(paginationOpts);
        case "deviceRevocationDeviceReservations":
          return await ctx.db.query("deviceRevocationDeviceReservations")
            .withIndex("by_user", (builder) => builder.eq("userId", args.userId))
            .paginate(paginationOpts);
        case "deviceRevocationJobReservations":
          return await ctx.db.query("deviceRevocationJobReservations")
            .withIndex("by_user", (builder) => builder.eq("userId", args.userId))
            .paginate(paginationOpts);
        case "deviceRevocationSecurityReservations":
          return await ctx.db.query("deviceRevocationSecurityReservations")
            .withIndex("by_user", (builder) => builder.eq("userId", args.userId))
            .paginate(paginationOpts);
        case "deviceRevocationReceiptReservations":
          return await ctx.db.query("deviceRevocationReceiptReservations")
            .withIndex("by_user", (builder) => builder.eq("userId", args.userId))
            .paginate(paginationOpts);
        case "commandLifecycleReservations":
          return await ctx.db.query("commandLifecycleReservations")
            .withIndex("by_user", (builder) => builder.eq("userId", args.userId))
            .paginate(paginationOpts);
        case "commandTerminalSecurityReservations":
          return await ctx.db.query("commandTerminalSecurityReservations")
            .withIndex("by_user", (builder) => builder.eq("userId", args.userId))
            .paginate(paginationOpts);
        case "attentionNotificationOutbox":
          return await ctx.db.query("attentionNotificationOutbox")
            .withIndex("by_user", (builder) => builder.eq("userId", args.userId))
            .paginate(paginationOpts);
        case "codexAccounts":
          return await ctx.db.query("codexAccounts")
            .withIndex("by_user_and_public_id", (builder) => builder.eq("userId", args.userId))
            .paginate(paginationOpts);
        case "deviceAccountBindings":
          return await ctx.db.query("deviceAccountBindings")
            .withIndex("by_user", (builder) => builder.eq("userId", args.userId))
            .paginate(paginationOpts);
        case "accountUsageSnapshots":
          return await ctx.db.query("accountUsageSnapshots")
            .withIndex("by_user", (builder) => builder.eq("userId", args.userId))
            .paginate(paginationOpts);
        case "idempotencyReceipts":
          return await ctx.db.query("idempotencyReceipts")
            .withIndex("by_user", (builder) => builder.eq("userId", args.userId))
            .paginate(paginationOpts);
        case "securityEvents":
          return await ctx.db.query("securityEvents")
            .withIndex("by_user_and_created_at", (builder) => builder.eq("userId", args.userId))
            .paginate(paginationOpts);
        case "devicePresence":
          return await ctx.db.query("devicePresence")
            .withIndex("by_user", (builder) => builder.eq("userId", args.userId))
            .paginate(paginationOpts);
        case "memorySpaces":
          return await ctx.db.query("memorySpaces")
            .withIndex("by_user_and_updated_at", (builder) => builder.eq("userId", args.userId))
            .paginate(paginationOpts);
        case "memoryOperations":
          return await ctx.db.query("memoryOperations")
            .withIndex("by_user", (builder) => builder.eq("userId", args.userId))
            .paginate(paginationOpts);
        case "accountDeletionJobs":
          return await ctx.db.query("accountDeletionJobs")
            .withIndex("by_user", (builder) => builder.eq("userId", args.userId))
            .paginate(paginationOpts);
        case "deviceRevocationJobs":
          return await ctx.db.query("deviceRevocationJobs")
            .withIndex("by_user", (builder) => builder.eq("userId", args.userId))
            .paginate(paginationOpts);
      }
    })();
    return {
      category: DIRECT_TABLE_CATEGORY[args.table],
      continueCursor: result.continueCursor,
      isDone: result.isDone,
      logicalBytes: result.page.reduce(
        (total, document) => total + logicalDocumentBytes(document),
        0,
      ),
      records: result.page.length,
      table: args.table,
    };
  },
});

// Re-export validators' static type boundary for coverage tests.
export const quotaValidators = {
  quotaAccountResource,
  quotaCategory,
  quotaEnforcement,
  quotaUserResource,
} as const;
