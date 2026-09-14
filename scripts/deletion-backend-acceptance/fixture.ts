import { v, type GenericId as Id, type Infer, type Value } from "convex/values";

import { isCanonicalAuthEmail } from "../../src/cloud/authCredentials";
import { sha256Hex } from "../../src/cloud/crypto";
import { ACCOUNT_DELETION_TABLE_STRATEGY } from "../../convex/accountDeletion";
import {
  backfillAuthorityReductionCapacityForUser,
  createAccountDeletionCapacityForNewUser,
  loadAccountDeletionCapacity,
} from "../../convex/authorityReductionCapacity";
import { digestAuthEmail } from "../../convex/authEmail";
import { HOSTED_TABLE_LIFECYCLE } from "../../convex/lifecyclePolicy";
import { cloudRetentionMs } from "../../convex/maintenance";
import {
  initializeUserQuotaAuthority, logicalDocumentBytes, requireHardQuotaAuthority,
  reserveDeviceQuotaForInsert, reserveParentAttributedQuotaForInsert,
  reserveQuotaForInsert, reserveQuotaForStoredIdentity,
} from "../../convex/quota";
import schema from "../../convex/schema";
import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "../../convex/server";

const maximumRowsPerTable = 300;
const ownerKind = v.union(v.literal("dedicated"), v.literal("inline"), v.literal("abandoned"), v.literal("witness"));
export const fixtureOwner = v.object({
  kind: ownerKind, userId: v.id("users"), subjectId: v.id("authSubjects"), authAccountId: v.id("authAccounts"),
  authSessionId: v.union(v.id("authSessions"), v.null()), deviceId: v.union(v.id("devices"), v.null()),
  emailDigest: v.string(), jobId: v.string(), statusCapability: v.string(),
  beforeSubjectBytes: v.number(), beforeIdentityRecords: v.number(), beforeIdentityBytes: v.number(), beforeJobBytes: v.number(),
});
export const fixtureSeed = v.object({
  schemaVersion: v.literal(1), dedicated: fixtureOwner, inline: fixtureOwner, abandoned: fixtureOwner, witness: fixtureOwner,
  witnessDigest: v.string(),
  backfill: v.object({ identityRecordsBefore: v.literal(256), identityRecordsAfter: v.literal(256),
    addedNonIdentityRecords: v.literal(5), exactBytesCharged: v.literal(true), replayUnchanged: v.literal(true) }),
});
export type FixtureOwner = Infer<typeof fixtureOwner>;
export type FixtureSeed = Infer<typeof fixtureSeed>;
type Kind = Infer<typeof ownerKind>;
type Row = Readonly<Record<string, Value | undefined>>;
type TableName = keyof typeof schema.tables;
type Census = readonly Readonly<{ table: TableName; rows: readonly Row[] }>[];

function assert(condition: boolean): asserts condition {
  if (!condition) throw new Error("DELETION_BACKEND_QUALIFICATION_ASSERTION");
}
function requireDisposable(): void {
  if (process.env.OOMPA_DELETION_BACKEND_QUALIFICATION !== "disposable-v1") {
    throw new Error("DELETION_BACKEND_QUALIFICATION_DISABLED");
  }
}
const tables = Object.keys(schema.tables).filter((name): name is TableName => Object.hasOwn(schema.tables, name));
async function census(ctx: QueryCtx | MutationCtx): Promise<Census> {
  assert(JSON.stringify([...tables].sort()) === JSON.stringify(Object.keys(ACCOUNT_DELETION_TABLE_STRATEGY).sort()));
  return await Promise.all(tables.map(async (table) => {
    const rows: readonly Row[] = await ctx.db.query(table).take(maximumRowsPerTable + 1);
    assert(rows.length <= maximumRowsPerTable);
    return { table, rows };
  }));
}
function owned(row: Row, owner: FixtureOwner): boolean {
  return row._id === owner.userId || row._id === owner.subjectId || row._id === owner.authAccountId
    || row._id === owner.authSessionId || row._id === owner.deviceId || row.userId === owner.userId
    || (owner.authSessionId !== null && (row.sessionId === owner.authSessionId || row.authSessionId === owner.authSessionId))
    || row.accountId === owner.authAccountId || row.emailDigest === owner.emailDigest
    || row.issuerUserId === owner.userId || row.boundEmailDigest === owner.emailDigest;
}
function ownedRows(all: Census, owner: FixtureOwner): readonly Readonly<{ table: TableName; row: Row }>[] {
  return all.flatMap(({ table, rows }) => rows.filter((row) => owned(row, owner)).map((row) => ({ table, row })));
}
async function fingerprint(all: Census, owner: FixtureOwner): Promise<string> {
  const records = ownedRows(all, owner).map(({ table, row }) => ({ table, row: Object.fromEntries(Object.entries(row).sort(([a], [b]) => a.localeCompare(b))) }));
  records.sort((a, b) => `${a.table}:${JSON.stringify(a.row._id)}`.localeCompare(`${b.table}:${JSON.stringify(b.row._id)}`));
  return await sha256Hex(JSON.stringify(records));
}
function categoryRow(all: Census, owner: FixtureOwner, category: string): Row | undefined {
  const rows = all.find((entry) => entry.table === "storageUsageByUser")?.rows
    .filter((row) => row.userId === owner.userId && row.category === category) ?? [];
  assert(rows.length <= 1);
  return rows[0];
}
function numberField(row: Row | undefined, name: string): number {
  const result = row?.[name];
  assert(typeof result === "number" && Number.isSafeInteger(result) && result >= 0);
  return result;
}
function assertBalanced(all: Census, owners: readonly FixtureOwner[]): void {
  let userBytes = 0; let userRecords = 0; let serviceBytes = 0; let serviceRecords = 0;
  for (const owner of owners) {
    const actual = new Map<string, { bytes: number; records: number }>();
    for (const { table, row } of ownedRows(all, owner)) {
      const category = HOSTED_TABLE_LIFECYCLE[table].quota;
      if (category === null) continue;
      const usage = actual.get(category) ?? { bytes: 0, records: 0 };
      usage.bytes += logicalDocumentBytes(row); usage.records += 1; actual.set(category, usage);
    }
    const ledgers = all.find((entry) => entry.table === "storageUsageByUser")?.rows.filter((row) => row.userId === owner.userId) ?? [];
    for (const ledger of ledgers) {
      assert(typeof ledger.category === "string");
      const expected = actual.get(ledger.category) ?? { bytes: 0, records: 0 };
      assert(ledger.logicalBytes === expected.bytes && ledger.records === expected.records);
      userBytes += expected.bytes; userRecords += expected.records; actual.delete(ledger.category);
    }
    assert(actual.size === 0);
  }
  for (const { table, rows } of all) {
    if (HOSTED_TABLE_LIFECYCLE[table].quota === null) continue;
    for (const row of rows) if (!owners.some((owner) => owned(row, owner))) {
      // The only charged survivor outside the four synthetic owners is the
      // capability receipt written by the real account-deletion finalizer.
      assert(table === "accountDeletionReceipts");
      serviceBytes += logicalDocumentBytes(row); serviceRecords += 1;
    }
  }
  const services = all.find((entry) => entry.table === "storageUsageService")?.rows ?? [];
  assert(services.length === 1);
  const service = services[0];
  assert(service !== undefined && service.userLogicalBytes === userBytes && service.userRecords === userRecords
    && service.serviceLogicalBytes === serviceBytes && service.serviceRecords === serviceRecords
    && service.logicalBytes === userBytes + serviceBytes && service.records === userRecords + serviceRecords
    && service.identities === (all.find((entry) => entry.table === "users")?.rows.length ?? 0));
}

async function createOwner(ctx: MutationCtx, kind: Kind): Promise<FixtureOwner> {
  const now = Date.now(); const abandoned = kind === "abandoned";
  const email = `deletion-${kind}@example.invalid`;
  assert(isCanonicalAuthEmail(email));
  const emailDigest = await digestAuthEmail(email);
  const userId = await ctx.db.insert("users", { email, ...(abandoned ? {} : { emailVerificationTime: now }) });
  await initializeUserQuotaAuthority(ctx, userId);
  const user = await ctx.db.get(userId); assert(user !== null);
  await reserveQuotaForStoredIdentity(ctx, userId, user);
  if (kind === "dedicated" || kind === "witness") await createAccountDeletionCapacityForNewUser(ctx, userId);
  const authAccountId = await ctx.db.insert("authAccounts", { provider: "hra-control-plane-otp-v1", providerAccountId: email,
    userId, ...(abandoned ? {} : { emailVerified: email }) });
  const subjectId = await ctx.db.insert("authSubjects", { authEpoch: 1,
    createdAt: abandoned ? now - cloudRetentionMs.abandonedIdentity - 120_000 : now,
    updatedAt: abandoned ? now - cloudRetentionMs.abandonedIdentity - 120_000 : now,
    emailDigest, status: "active", userId, ...(abandoned ? {} : { verifiedAt: now }) });
  for (const id of [authAccountId, subjectId]) {
    const document = await ctx.db.get(id); assert(document !== null);
    await reserveQuotaForInsert(ctx, userId, "identity", document);
  }
  let authSessionId: Id<"authSessions"> | null = null;
  if (!abandoned) {
    authSessionId = await ctx.db.insert("authSessions", { expirationTime: now + 2 * 60 * 60 * 1000, userId });
    const session = await ctx.db.get(authSessionId); assert(session !== null);
    await reserveQuotaForInsert(ctx, userId, "identity", session);
  }
  if (kind === "inline") {
    assert(authSessionId !== null);
    for (let index = 0; index < 201; index += 1) {
      const id = await ctx.db.insert("authRefreshTokens", { sessionId: authSessionId, expirationTime: now + 2 * 60 * 60 * 1000 });
      const token = await ctx.db.get(id); assert(token !== null);
      await reserveParentAttributedQuotaForInsert(ctx, userId, "identity", token);
    }
    for (let index = 0; index < 51; index += 1) {
      const id = await ctx.db.insert("authVerifiers", { sessionId: authSessionId, signature: `synthetic-verifier-${index}` });
      const verifier = await ctx.db.get(id); assert(verifier !== null);
      await reserveParentAttributedQuotaForInsert(ctx, userId, "identity", verifier);
    }
  }
  let deviceId: Id<"devices"> | null = null;
  if (kind === "inline") {
    deviceId = await ctx.db.insert("devices", { activatedAt: now, authEpoch: 1, createdAt: now, credentialGeneration: 1,
      encryptedLabel: { algorithm: "A256GCM", ciphertext: "synthetic", keyVersion: 1, nonce: "synthetic" },
      keyVersion: 1, publicId: "synthetic-qualification-device", revision: 1, signingPublicKey: "synthetic", status: "active",
      updatedAt: now, userId, wrappingPublicKey: "synthetic" });
    const device = await ctx.db.get(deviceId); assert(device !== null);
    await reserveDeviceQuotaForInsert(ctx, userId, device);
  }
  return { kind, userId, subjectId, authAccountId, authSessionId, deviceId, emailDigest,
    jobId: `delete_job_${kind}_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`,
    statusCapability: kind === "inline" ? "InlineAbCdEfGhIjKlMnOpQrStUvWxYz0123456789ABCDE" : "DedicatedAbCdEfGhIjKlMnOpQrStUvWxYz0123456789AB",
    beforeSubjectBytes: 0, beforeIdentityRecords: 0, beforeIdentityBytes: 0, beforeJobBytes: 0 };
}
async function baseline(ctx: MutationCtx, owner: FixtureOwner): Promise<FixtureOwner> {
  const all = await census(ctx); const subject = await ctx.db.get(owner.subjectId); assert(subject !== null);
  return { ...owner, beforeSubjectBytes: logicalDocumentBytes(subject),
    beforeIdentityBytes: numberField(categoryRow(all, owner, "identity"), "logicalBytes"),
    beforeIdentityRecords: numberField(categoryRow(all, owner, "identity"), "records"),
    beforeJobBytes: numberField(categoryRow(all, owner, "job"), "logicalBytes") };
}

/** Run only after the driver invokes production quota:genesisHardAuthority. */
export const seed = internalMutation({ args: {}, handler: async (ctx): Promise<FixtureSeed> => {
  requireDisposable(); await requireHardQuotaAuthority(ctx);
  const initial = await census(ctx);
  for (const { table, rows } of initial) if (table !== "storageUsageService" && table !== "serviceControl" && table !== "maintenanceState") assert(rows.length === 0);
  const dedicated = await createOwner(ctx, "dedicated");
  const inline = await createOwner(ctx, "inline");
  const abandoned = await createOwner(ctx, "abandoned");
  const witness = await createOwner(ctx, "witness");
  const owners = [dedicated, inline, abandoned, witness];
  const before = await census(ctx); assertBalanced(before, owners);
  assert(numberField(categoryRow(before, inline, "identity"), "records") === 256);
  const subjectBefore = await ctx.db.get(inline.subjectId); assert(subjectBefore !== null);
  const identityBefore = numberField(categoryRow(before, inline, "identity"), "logicalBytes");
  const serviceRecordsBefore = numberField(before.find((entry) => entry.table === "storageUsageService")?.rows[0], "records");
  assert((await backfillAuthorityReductionCapacityForUser(ctx, inline.userId)).reserved === 2);
  const after = await census(ctx); assertBalanced(after, owners);
  const subjectAfter = await ctx.db.get(inline.subjectId); assert(subjectAfter !== null);
  assert(numberField(categoryRow(after, inline, "identity"), "records") === 256);
  assert(numberField(categoryRow(after, inline, "identity"), "logicalBytes") - identityBefore
    === logicalDocumentBytes(subjectAfter) - logicalDocumentBytes(subjectBefore));
  assert(numberField(after.find((entry) => entry.table === "storageUsageService")?.rows[0], "records") - serviceRecordsBefore === 5);
  const replayBefore = await fingerprint(after, inline);
  assert((await backfillAuthorityReductionCapacityForUser(ctx, inline.userId)).reserved === 0);
  assert(await fingerprint(await census(ctx), inline) === replayBefore);
  assert((await backfillAuthorityReductionCapacityForUser(ctx, abandoned.userId)).reserved === 1);
  assert((await loadAccountDeletionCapacity(ctx, dedicated.userId)).kind === "reserved");
  const maintenance = await ctx.db.query("maintenanceState").withIndex("by_key", (q) => q.eq("key", "retention")).take(2);
  assert(maintenance.length <= 1);
  if (maintenance[0] === undefined) await ctx.db.insert("maintenanceState", { key: "retention", nextCategory: "abandoned_identities", updatedAt: Date.now() });
  else await ctx.db.patch(maintenance[0]._id, { nextCategory: "abandoned_identities" });
  const final = await census(ctx); assertBalanced(final, owners);
  return { schemaVersion: 1, dedicated: await baseline(ctx, dedicated), inline: await baseline(ctx, inline),
    abandoned: await baseline(ctx, abandoned), witness: await baseline(ctx, witness), witnessDigest: await fingerprint(final, witness),
    backfill: { identityRecordsBefore: 256, identityRecordsAfter: 256, addedNonIdentityRecords: 5, exactBytesCharged: true, replayUnchanged: true } };
} });

function inspectOwner(all: Census, owner: FixtureOwner) {
  const records = ownedRows(all, owner);
  const user = records.find(({ table }) => table === "users");
  const subject = records.find(({ table }) => table === "authSubjects")?.row;
  const jobs = records.filter(({ table }) => table === "accountDeletionJobs");
  const reserves = records.filter(({ table }) => table === "accountDeletionIdentityReservations" || table === "accountDeletionJobReservations");
  const phase = user === undefined ? "complete" as const : subject?.status === "disabled" ? "disabled" as const : "active" as const;
  if (phase === "complete") assert(records.length === 0);
  if (phase === "disabled") assert(subject?.authEpoch === 2 && subject.accountDeletionCapacity === undefined && reserves.length === 0 && jobs.length === 1);
  const identity = categoryRow(all, owner, "identity");
  const identityRecords = identity === undefined ? 0 : numberField(identity, "records");
  if (phase === "disabled") assert(identityRecords <= owner.beforeIdentityRecords - (owner.kind === "dedicated" ? 1 : 0));
  return { phase, ownedRowsRemaining: records.length, identityRecords,
    paddingConsumed: phase !== "active" && subject?.accountDeletionCapacity === undefined,
    subjectNonGrowing: phase !== "active" && (subject === undefined || logicalDocumentBytes(subject) <= owner.beforeSubjectBytes),
    capacityConsumed: phase !== "active" && reserves.length === 0 };
}
async function inspectFixture(ctx: QueryCtx, args: { seed: FixtureSeed }) {
  requireDisposable(); await requireHardQuotaAuthority(ctx);
  const all = await census(ctx); const owners = [args.seed.dedicated, args.seed.inline, args.seed.abandoned, args.seed.witness];
  assertBalanced(all, owners);
  const witnessUnchanged = await fingerprint(all, args.seed.witness) === args.seed.witnessDigest;
  assert(witnessUnchanged);
  return { schemaVersion: 1 as const, dedicated: inspectOwner(all, args.seed.dedicated), inline: inspectOwner(all, args.seed.inline),
    abandoned: inspectOwner(all, args.seed.abandoned), witnessUnchanged, serviceBalanced: true as const,
    allOwnedTablesCovered: true as const, inspectedTables: all.length,
    completionReceipts: all.find((entry) => entry.table === "accountDeletionReceipts")?.rows.length ?? 0 };
}
export const inspect = internalQuery({ args: { seed: fixtureSeed }, handler: inspectFixture });
export type FixtureInspection = Awaited<ReturnType<typeof inspectFixture>>;
