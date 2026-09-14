import { ConvexCredentials } from "@convex-dev/auth/providers/ConvexCredentials";
import { convexAuth, createAccount } from "@convex-dev/auth/server";
import { makeFunctionReference } from "convex/server";
import { v, type GenericId as Id, type Value } from "convex/values";

import {
  generateEightDigitOtp,
  isCanonicalAuthEmail,
  parseAuthCredentials,
} from "../src/cloud/authCredentials";
import { digestAuthEmail, digestAuthOtp } from "./authEmail";
import { digestInviteCapability } from "./authInvites";
import { authOtpLifetimeMs } from "./authPolicy";
import { sendOtpEmail } from "./otpEmail";
import {
  adjustParentAttributedQuotaForPatch,
  adjustQuotaForPatch,
  adjustServiceQuotaForPatch,
  initializeUserQuotaAuthority,
  releaseParentAttributedQuotaForDelete,
  releaseQuotaForDelete,
  releaseQuotaForStoredIdentity,
  releaseServiceQuotaForDelete,
  reserveParentAttributedQuotaForInsert,
  reserveQuotaForInsert,
  reserveQuotaForStoredIdentity,
  reserveServiceQuotaForInsert,
  transferServiceQuotaToUserForPatch,
} from "./quota";
import { internalMutation, type DataModel, type MutationCtx } from "./server";
import { requireActiveAuthSubject } from "./authDelivery";
import { requireAuthAdmissionsOpen } from "./admissionControl";
import {
  createAccountDeletionCapacityForNewUser,
  loadAccountDeletionCapacity,
} from "./authorityReductionCapacity";

export const oompaOtpProviderId = "hra-control-plane-otp-v1";

type ReserveArgs = Readonly<{
  emailDigest: string;
  inviteCapabilityDigest?: string;
  kind: "send" | "verify";
}>;
type ReserveResult = Readonly<{
  authEpoch: number;
  inviteBinding: "bound" | "not_required" | "replay";
}>;
type StoreArgs = Readonly<{
  accountId: Id<"authAccounts">;
  authEpoch: number;
  codeDigest: string;
  emailDigest: string;
  expiresAt: number;
  userId: Id<"users">;
}>;
type ConsumeArgs = Readonly<{
  authEpoch: number;
  codeDigest: string;
  emailDigest: string;
}>;

const reserveEmailAttempt = makeFunctionReference<"mutation", ReserveArgs, ReserveResult>(
  "authDelivery:reserveEmailAttempt",
);
const storeOtpChallenge = makeFunctionReference<
  "mutation",
  StoreArgs,
  Id<"authOtpChallenges">
>("authDelivery:storeOtpChallenge");
const recordOtpDelivery = makeFunctionReference<
  "mutation",
  Readonly<{
    challengeId: Id<"authOtpChallenges">;
    state: "accepted" | "ambiguous";
  }>,
  Id<"authOtpChallenges"> | null
>("authDelivery:recordOtpDelivery");
const consumeOtpChallenge = makeFunctionReference<"mutation", ConsumeArgs, Id<"users">>(
  "authDelivery:consumeOtpChallenge",
);

export const PINNED_CONVEX_AUTH_QUOTA_TABLE_MATRIX = Object.freeze({
  users: "stored_identity",
  authSessions: "direct_user",
  authAccounts: "direct_user",
  authRefreshTokens: "session_parent",
  authVerificationCodes: "account_parent",
  authVerifiers: "service_or_session_parent",
  authRateLimits: "service",
} as const);

export const PINNED_CONVEX_AUTH_STORE_OPERATIONS = Object.freeze([
  "signIn",
  "signOut",
  "refreshSession",
  "verifyCodeAndSignIn",
  "verifier",
  "verifierSignature",
  "userOAuth",
  "createVerificationCode",
  "createAccountFromCredentials",
  "retrieveAccountWithCredentials",
  "modifyAccount",
  "invalidateSessions",
] as const);

type AuthQuotaTable = keyof typeof PINNED_CONVEX_AUTH_QUOTA_TABLE_MATRIX;
const AUTH_QUOTA_LEDGER_TABLES = [
  "storageUsageService",
  "storageUsageByUser",
  "storageResourceUsageByUser",
  "storageResourceUsageByAccount",
] as const;
type AuthStoreOperation = typeof PINNED_CONVEX_AUTH_STORE_OPERATIONS[number];
type StoredDocument = Readonly<Record<string, Value>> & Readonly<{
  _creationTime: number;
  _id: Id<AuthQuotaTable>;
}>;
type QuotaOwner =
  | Readonly<{ kind: "stored_identity"; userId: Id<"users"> }>
  | Readonly<{ kind: "direct_user"; userId: Id<"users"> }>
  | Readonly<{ kind: "parent_user"; userId: Id<"users"> }>
  | Readonly<{ kind: "service" }>;
type NewIdentityBinding = Readonly<{ email: string; emailDigest: string }>;

const authStoreRejectedMessage = "Authentication storage could not be completed.";

const rejectAuthStore = (): never => {
  throw new Error(authStoreRejectedMessage);
};

function requireAuthStoreOperation(value: unknown): AuthStoreOperation {
  if (
    typeof value !== "string"
    || !(PINNED_CONVEX_AUTH_STORE_OPERATIONS as readonly string[]).includes(value)
  ) return rejectAuthStore();
  return value as AuthStoreOperation;
}

function requireId<Table extends string>(
  value: Value | undefined,
): Id<Table> {
  if (typeof value !== "string") return rejectAuthStore();
  return value as Id<Table>;
}

async function requireDocument(
  ctx: MutationCtx,
  id: Id<string>,
): Promise<StoredDocument> {
  const document = await ctx.db.get(id as never) as StoredDocument | null;
  if (document === null) return rejectAuthStore();
  return document;
}

function tableForId(ctx: MutationCtx, id: Id<string>): AuthQuotaTable {
  const matches = (Object.keys(PINNED_CONVEX_AUTH_QUOTA_TABLE_MATRIX) as AuthQuotaTable[])
    .filter((table) => ctx.db.normalizeId(table, id) !== null);
  if (matches.length !== 1 || matches[0] === undefined) return rejectAuthStore();
  return matches[0];
}

function isQuotaLedgerId(ctx: MutationCtx, id: Id<string>): boolean {
  return AUTH_QUOTA_LEDGER_TABLES.some((table) =>
    ctx.db.normalizeId(table, id) !== null);
}

type DeletedParents = Readonly<{
  accounts: Map<string, StoredDocument>;
  sessions: Map<string, StoredDocument>;
  users: Map<string, StoredDocument>;
}>;

async function requireUser(
  ctx: MutationCtx,
  userId: Id<"users">,
  deleted: DeletedParents,
): Promise<StoredDocument> {
  const user = await ctx.db.get(userId) as StoredDocument | null;
  const resolved = user ?? deleted.users.get(userId) ?? null;
  if (resolved === null || resolved._id !== userId) return rejectAuthStore();
  return resolved;
}

async function quotaOwner(
  ctx: MutationCtx,
  table: AuthQuotaTable,
  document: StoredDocument,
  deleted: DeletedParents,
): Promise<QuotaOwner> {
  switch (table) {
    case "users":
      return { kind: "stored_identity", userId: document._id as Id<"users"> };
    case "authSessions":
    case "authAccounts": {
      const userId = requireId<"users">(document.userId);
      await requireUser(ctx, userId, deleted);
      return { kind: "direct_user", userId };
    }
    case "authRefreshTokens": {
      const sessionId = requireId<"authSessions">(document.sessionId);
      const session = await ctx.db.get(sessionId) as StoredDocument | null
        ?? deleted.sessions.get(sessionId)
        ?? null;
      if (session === null || session._id !== sessionId) return rejectAuthStore();
      const userId = requireId<"users">(session.userId);
      await requireUser(ctx, userId, deleted);
      return { kind: "parent_user", userId };
    }
    case "authVerificationCodes": {
      const accountId = requireId<"authAccounts">(document.accountId);
      const account = await ctx.db.get(accountId) as StoredDocument | null
        ?? deleted.accounts.get(accountId)
        ?? null;
      if (account === null || account._id !== accountId) return rejectAuthStore();
      const userId = requireId<"users">(account.userId);
      await requireUser(ctx, userId, deleted);
      return { kind: "parent_user", userId };
    }
    case "authVerifiers": {
      if (document.sessionId === undefined) return { kind: "service" };
      const sessionId = requireId<"authSessions">(document.sessionId);
      const session = await ctx.db.get(sessionId) as StoredDocument | null
        ?? deleted.sessions.get(sessionId)
        ?? null;
      if (session === null || session._id !== sessionId) return rejectAuthStore();
      const userId = requireId<"users">(session.userId);
      await requireUser(ctx, userId, deleted);
      return { kind: "parent_user", userId };
    }
    case "authRateLimits":
      return { kind: "service" };
  }
}

function sameOwner(left: QuotaOwner, right: QuotaOwner): boolean {
  return left.kind === right.kind
    && (left.kind === "service"
      || (right.kind !== "service" && left.userId === right.userId));
}

async function reserveAuthDocument(
  ctx: MutationCtx,
  owner: QuotaOwner,
  document: StoredDocument,
  newIdentityBinding?: NewIdentityBinding,
): Promise<void> {
  switch (owner.kind) {
    case "stored_identity":
      if (
        newIdentityBinding !== undefined
        && (
          document.email !== newIdentityBinding.email
          || document.emailVerificationTime !== undefined
        )
      ) return rejectAuthStore();
      await initializeUserQuotaAuthority(ctx, owner.userId);
      await reserveQuotaForStoredIdentity(ctx, owner.userId, document);
      await createAccountDeletionCapacityForNewUser(ctx, owner.userId);
      if (newIdentityBinding !== undefined) {
        const [subjectsByDigest, subjectsByUser] = await Promise.all([
          ctx.db.query("authSubjects")
            .withIndex("by_email_digest", (query) =>
              query.eq("emailDigest", newIdentityBinding.emailDigest))
            .take(2),
          ctx.db.query("authSubjects")
            .withIndex("by_user", (query) => query.eq("userId", owner.userId))
            .take(2),
        ]);
        const subject = subjectsByDigest[0];
        if (
          subjectsByDigest.length !== 1
          || subject === undefined
          || subjectsByUser.length !== 0
          || subject.status !== "active"
          || subject.userId !== undefined
          || subject.verifiedAt !== undefined
          || subject.accountDeletionCapacity !== undefined
        ) return rejectAuthStore();
        const patch = { updatedAt: Date.now(), userId: owner.userId };
        await transferServiceQuotaToUserForPatch(
          ctx,
          owner.userId,
          "identity",
          subject,
          patch,
        );
        await ctx.db.patch(subject._id, patch);
      }
      return;
    case "direct_user":
      await reserveQuotaForInsert(ctx, owner.userId, "identity", document);
      return;
    case "parent_user":
      await reserveParentAttributedQuotaForInsert(
        ctx,
        owner.userId,
        "identity",
        document,
      );
      return;
    case "service":
      await reserveServiceQuotaForInsert(ctx, document);
  }
}

async function adjustAuthDocument(
  ctx: MutationCtx,
  owner: QuotaOwner,
  document: StoredDocument,
  next: StoredDocument,
): Promise<void> {
  switch (owner.kind) {
    case "stored_identity":
    case "parent_user":
      await adjustParentAttributedQuotaForPatch(
        ctx,
        owner.userId,
        "identity",
        document,
        next,
      );
      return;
    case "direct_user":
      await adjustQuotaForPatch(ctx, owner.userId, "identity", document, next);
      return;
    case "service":
      await adjustServiceQuotaForPatch(ctx, document, next);
  }
}

async function releaseAuthDocument(
  ctx: MutationCtx,
  owner: QuotaOwner,
  document: StoredDocument,
): Promise<void> {
  switch (owner.kind) {
    case "stored_identity":
      {
        const capacity = await loadAccountDeletionCapacity(ctx, owner.userId);
        // Bound inline authority must be removed together with its subject by
        // account deletion or abandoned-identity maintenance, never Auth's
        // user-row deletion alone.
        if (capacity.kind === "inline_reserved") return rejectAuthStore();
        if (capacity.kind === "reserved") {
          await releaseQuotaForDelete(
            ctx,
            owner.userId,
            "identity",
            capacity.identity,
          );
          await releaseQuotaForDelete(ctx, owner.userId, "job", capacity.job);
          await ctx.db.delete(capacity.identity._id);
          await ctx.db.delete(capacity.job._id);
        }
      }
      await releaseQuotaForStoredIdentity(ctx, owner.userId, document);
      return;
    case "direct_user":
      await releaseQuotaForDelete(ctx, owner.userId, "identity", document);
      return;
    case "parent_user":
      await releaseParentAttributedQuotaForDelete(
        ctx,
        owner.userId,
        "identity",
        document,
      );
      return;
    case "service":
      await releaseServiceQuotaForDelete(ctx, document);
  }
}

function rememberDeletedParent(
  table: AuthQuotaTable,
  document: StoredDocument,
  deleted: DeletedParents,
): void {
  if (table === "users") deleted.users.set(document._id, document);
  if (table === "authSessions") deleted.sessions.set(document._id, document);
  if (table === "authAccounts") deleted.accounts.set(document._id, document);
}

type LooseWriter = Readonly<{
  delete(id: Id<string>): Promise<void>;
  get(id: Id<string>): Promise<StoredDocument | null>;
  insert(table: string, value: Record<string, Value | undefined>): Promise<Id<string>>;
  patch(id: Id<string>, value: Record<string, Value | undefined>): Promise<void>;
  replace(id: Id<string>, value: Record<string, Value | undefined>): Promise<void>;
}>;

function quotaAwareDatabase(
  ctx: MutationCtx,
  newIdentityBinding?: NewIdentityBinding,
): MutationCtx["db"] {
  const writer = ctx.db as unknown as LooseWriter;
  const deleted: DeletedParents = {
    accounts: new Map(),
    sessions: new Map(),
    users: new Map(),
  };
  return new Proxy(ctx.db, {
    get(target, property) {
      if (property === "insert") {
        return async (table: string, value: Record<string, Value | undefined>) => {
          if (!(table in PINNED_CONVEX_AUTH_QUOTA_TABLE_MATRIX)) return rejectAuthStore();
          const id = await writer.insert(table, value);
          const stored = await requireDocument(ctx, id);
          const owner = await quotaOwner(ctx, table as AuthQuotaTable, stored, deleted);
          await reserveAuthDocument(ctx, owner, stored, newIdentityBinding);
          return id;
        };
      }
      if (property === "patch" || property === "replace") {
        return async (id: Id<string>, value: Record<string, Value | undefined>) => {
          // Pinned auth callbacks run inside this same handler and maintain the
          // quota ledgers through the original writer. Only updates to the
          // closed authority-table set bypass auth-document attribution.
          if (isQuotaLedgerId(ctx, id)) {
            await writer[property](id, value);
            return;
          }
          const table = tableForId(ctx, id);
          const before = await requireDocument(ctx, id);
          const beforeOwner = await quotaOwner(ctx, table, before, deleted);
          await writer[property](id, value);
          const after = await requireDocument(ctx, id);
          const afterOwner = await quotaOwner(ctx, table, after, deleted);
          if (sameOwner(beforeOwner, afterOwner)) {
            await adjustAuthDocument(ctx, beforeOwner, before, after);
          } else {
            await releaseAuthDocument(ctx, beforeOwner, before);
            await reserveAuthDocument(ctx, afterOwner, after);
          }
        };
      }
      if (property === "delete") {
        return async (id: Id<string>) => {
          const table = tableForId(ctx, id);
          const before = await requireDocument(ctx, id);
          const owner = await quotaOwner(ctx, table, before, deleted);
          await releaseAuthDocument(ctx, owner, before);
          rememberDeletedParent(table, before, deleted);
          await writer.delete(id);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      if (typeof value !== "function") return value;
      return (...parameters: unknown[]): unknown =>
        Reflect.apply(value, target, parameters) as unknown;
    },
  });
}

export async function runQuotaAwareAuthStoreForTest<T>(
  ctx: MutationCtx,
  operation: AuthStoreOperation,
  handler: (ctx: MutationCtx) => Promise<T>,
  newIdentityBinding?: NewIdentityBinding,
): Promise<T> {
  requireAuthStoreOperation(operation);
  if (operation === "refreshSession") {
    await requireAuthAdmissionsOpen(ctx);
  }
  await adjustServiceQuotaForPatch(
    ctx,
    { kind: "convex_auth_store_authority_probe", version: 1 },
    {},
  );
  return await handler({ ...ctx, db: quotaAwareDatabase(ctx, newIdentityBinding) });
}

const oompaOtp = ConvexCredentials<DataModel>({
  id: oompaOtpProviderId,
  authorize: async (credentials, ctx) => {
    try {
      const parsed = parseAuthCredentials(credentials);
      if (parsed.kind === "rejected") return null;
      const emailDigest = await digestAuthEmail(parsed.email);
      const reservation = await ctx.runMutation(reserveEmailAttempt, {
        emailDigest,
        kind: parsed.kind === "request_code" ? "send" : "verify",
        ...(parsed.kind === "request_code" && parsed.invite !== undefined
          ? {
              inviteCapabilityDigest: await digestInviteCapability(
                parsed.invite,
                "identity",
              ),
            }
          : {}),
      });
      if (parsed.kind === "verify_code") {
        return {
          userId: await ctx.runMutation(consumeOtpChallenge, {
            authEpoch: reservation.authEpoch,
            codeDigest: await digestAuthOtp(parsed.email, parsed.code),
            emailDigest,
          }),
        };
      }

      const token = generateEightDigitOtp();
      const expiresAt = Date.now() + authOtpLifetimeMs;
      const { account, user } = await createAccount(ctx, {
        account: { id: parsed.email },
        profile: { email: parsed.email },
        provider: oompaOtpProviderId,
        shouldLinkViaEmail: true,
      });
      const challengeId = await ctx.runMutation(storeOtpChallenge, {
        accountId: account._id,
        authEpoch: reservation.authEpoch,
        codeDigest: await digestAuthOtp(parsed.email, token),
        emailDigest,
        expiresAt,
        userId: user._id,
      });
      try {
        await sendOtpEmail({ email: parsed.email, expiresAt, token });
        await ctx.runMutation(recordOtpDelivery, { challengeId, state: "accepted" });
      } catch {
        await ctx.runMutation(recordOtpDelivery, { challengeId, state: "ambiguous" });
      }
      return null;
    } catch {
      return null;
    }
  },
});

const configuredAuth = convexAuth({
  callbacks: {
    async beforeSessionCreation(ctx, { userId }) {
      await requireAuthAdmissionsOpen(ctx as unknown as MutationCtx);
      await requireActiveAuthSubject(
        ctx as unknown as MutationCtx,
        userId,
      );
    },
  },
  jwt: { durationMs: 15 * 60 * 1_000 },
  providers: [oompaOtp],
  session: {
    inactiveDurationMs: 24 * 60 * 60 * 1_000,
    totalDurationMs: 7 * 24 * 60 * 60 * 1_000,
  },
  signIn: { maxFailedAttempsPerHour: 12 },
});

const upstreamStore = configuredAuth.store;
const pinnedUpstreamStore = upstreamStore as unknown as Readonly<{
  _handler?: (ctx: MutationCtx, args: unknown) => Promise<unknown>;
  exportArgs?: () => string;
  isInternal?: boolean;
  isMutation?: boolean;
}>;
if (
  pinnedUpstreamStore.isMutation !== true
  || pinnedUpstreamStore.isInternal !== true
  || typeof pinnedUpstreamStore._handler !== "function"
  || typeof pinnedUpstreamStore.exportArgs !== "function"
) {
  throw new Error("PINNED_CONVEX_AUTH_STORE_HANDLER_MISMATCH");
}
const upstreamStoreHandler = pinnedUpstreamStore._handler;
const upstreamStoreArgs = pinnedUpstreamStore.exportArgs;

function pinnedStoreOperationLiterals(serialized: string): readonly string[] {
  const schema = JSON.parse(serialized) as unknown;
  if (typeof schema !== "object" || schema === null || !("value" in schema)) {
    throw new Error("PINNED_CONVEX_AUTH_STORE_SCHEMA_MISMATCH");
  }
  const value = schema.value;
  if (typeof value !== "object" || value === null || !("args" in value)) {
    throw new Error("PINNED_CONVEX_AUTH_STORE_SCHEMA_MISMATCH");
  }
  const args = value.args;
  if (typeof args !== "object" || args === null || !("fieldType" in args)) {
    throw new Error("PINNED_CONVEX_AUTH_STORE_SCHEMA_MISMATCH");
  }
  const fieldType = args.fieldType;
  if (
    typeof fieldType !== "object"
    || fieldType === null
    || !("value" in fieldType)
    || !Array.isArray(fieldType.value)
  ) throw new Error("PINNED_CONVEX_AUTH_STORE_SCHEMA_MISMATCH");
  return fieldType.value.map((entry: unknown) => {
    if (typeof entry !== "object" || entry === null || !("value" in entry)) {
      throw new Error("PINNED_CONVEX_AUTH_STORE_SCHEMA_MISMATCH");
    }
    const entryValue = entry.value;
    if (typeof entryValue !== "object" || entryValue === null || !("type" in entryValue)) {
      throw new Error("PINNED_CONVEX_AUTH_STORE_SCHEMA_MISMATCH");
    }
    const type = entryValue.type;
    if (typeof type !== "object" || type === null || !("fieldType" in type)) {
      throw new Error("PINNED_CONVEX_AUTH_STORE_SCHEMA_MISMATCH");
    }
    const literal = type.fieldType;
    if (
      typeof literal !== "object"
      || literal === null
      || !("value" in literal)
      || typeof literal.value !== "string"
    ) throw new Error("PINNED_CONVEX_AUTH_STORE_SCHEMA_MISMATCH");
    return literal.value;
  });
}

if (
  JSON.stringify(pinnedStoreOperationLiterals(upstreamStoreArgs()))
  !== JSON.stringify(PINNED_CONVEX_AUTH_STORE_OPERATIONS)
) {
  throw new Error("PINNED_CONVEX_AUTH_STORE_SCHEMA_MISMATCH");
}

export const auth = configuredAuth.auth;
export const isAuthenticated = configuredAuth.isAuthenticated;
export const signIn = configuredAuth.signIn;
export const signOut = configuredAuth.signOut;

// Convex Auth 0.0.95 routes every library-owned auth table write through this
// registered mutation handler. Wrapping the pinned handler is the only seam in
// this release that observes refresh-token and cascading session lifecycles in
// the same transaction. The closed operation and table matrices above turn an
// upstream storage-surface change into a hard failure instead of an uncharged
// write.
export const store = internalMutation({
  args: { args: v.any() },
  handler: async (ctx, args) => {
    const root = args.args as Record<string, unknown>;
    const operation = requireAuthStoreOperation(root.type);
    let newIdentityBinding: NewIdentityBinding | undefined;
    if (operation === "createAccountFromCredentials") {
      const account = root.account;
      const profile = root.profile;
      const email = profile !== null && typeof profile === "object"
        ? (profile as Record<string, unknown>).email
        : undefined;
      const accountId = account !== null && typeof account === "object"
        ? (account as Record<string, unknown>).id
        : undefined;
      if (
        root.provider !== oompaOtpProviderId
        || !isCanonicalAuthEmail(email)
        || accountId !== email
      ) return rejectAuthStore();
      newIdentityBinding = {
        email,
        emailDigest: await digestAuthEmail(email),
      };
    }
    return await runQuotaAwareAuthStoreForTest(
      ctx,
      operation,
      async (quotaCtx) => await upstreamStoreHandler(quotaCtx, args),
      newIdentityBinding,
    );
  },
});
