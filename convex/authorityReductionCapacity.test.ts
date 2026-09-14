import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeFunctionReference } from "convex/server";
import { v, type Value } from "convex/values";
import { convexTest } from "convex-test";

import { isCanonicalAuthEmail } from "../src/cloud/authCredentials";
import {
  backfillAuthorityReductionCapacityForUser,
  classifyAuthorityReductionCapacityForUser,
  consumeAccountDeletionCapacity,
  createAccountDeletionCapacityForNewUser,
  loadAccountDeletionCapacity,
} from "./authorityReductionCapacity";
import { digestAuthEmail } from "./authEmail";
import { runQuotaAwareAuthStoreForTest } from "./auth";
import { cloudRetentionMs } from "./maintenance";
import {
  CATEGORY_QUOTAS, adjustParentAttributedQuotaForPatch, adjustQuotaForPatch, initializeUserQuotaAuthority, logicalDocumentBytes,
  reserveDeviceQuotaForInsert, reserveQuotaForInsert, reserveQuotaForStoredIdentity,
} from "./quota";
import schema from "./schema";
import { internalMutation } from "./server";
import { modules } from "./test.setup";
import { authorityReductionCapacityReservation, durableJobCapacityReservation } from "./validators";

const testModules = {
  ...modules,
  "./inlineCapacityFixture.ts": async () => ({
    backfill: internalMutation({ args: { userId: v.id("users") },
      handler: async (ctx, args) => await backfillAuthorityReductionCapacityForUser(ctx, args.userId) }),
    oversizedConsume: internalMutation({ args: { userId: v.id("users") }, handler: async (ctx, args) => {
      const capacity = await loadAccountDeletionCapacity(ctx, args.userId);
      if (capacity.kind !== "inline_reserved") throw new Error("missing inline fixture");
      await consumeAccountDeletionCapacity(ctx, capacity, capacity.subject, {
        authEpoch: capacity.subject.authEpoch + 1, status: "disabled", updatedAt: Date.now(),
        emailDigest: "x".repeat(8192),
      }, { capacityReservation: durableJobCapacityReservation, category: "commands_and_leases", createdAt: Date.now(),
        publicId: "oversized-job", state: "pending", statusCapabilityDigest: "a".repeat(64),
        subjectId: capacity.subject._id, updatedAt: Date.now(), userId: args.userId });
    } }),
  }),
};
type Args = Record<string, Value>;
const genesis = makeFunctionReference<"mutation", Args, unknown>("quota:genesisHardAuthority");
const backfill = makeFunctionReference<"mutation", Args, { reserved: number }>("inlineCapacityFixture:backfill");
const oversizedConsume = makeFunctionReference<"mutation", Args, unknown>("inlineCapacityFixture:oversizedConsume");
const requestDeletion = makeFunctionReference<"mutation", Args, unknown>("accountDeletion:request");
const drainDeletion = makeFunctionReference<"mutation", Args, unknown>("accountDeletion:drain");
const cleanup = makeFunctionReference<"mutation", Args, unknown>("maintenance:cleanupExpired");
const savedHmac = process.env.OOMPA_AUTH_HMAC_SECRET;
beforeAll(() => { process.env.OOMPA_AUTH_HMAC_SECRET = "x".repeat(32); });
afterAll(() => {
  if (savedHmac === undefined) delete process.env.OOMPA_AUTH_HMAC_SECRET;
  else process.env.OOMPA_AUTH_HMAC_SECRET = savedHmac;
});

async function world(options: { dedicated?: boolean; full?: boolean; verified?: boolean; device?: boolean } = {}) {
  const runtime = convexTest(schema, testModules);
  await runtime.mutation(genesis, {});
  const now = Date.now();
  const email = "inline-capacity@example.com";
  if (!isCanonicalAuthEmail(email)) throw new Error("invalid canonical email fixture");
  const emailDigest = await digestAuthEmail(email);
  const verified = options.verified !== false;
  const ids = await runtime.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { email, ...(verified ? { emailVerificationTime: now } : {}) });
    await initializeUserQuotaAuthority(ctx, userId);
    const user = await ctx.db.get(userId);
    if (user === null) throw new Error("missing user fixture");
    await reserveQuotaForStoredIdentity(ctx, userId, user);
    if (options.dedicated) await createAccountDeletionCapacityForNewUser(ctx, userId);
    const accountId = await ctx.db.insert("authAccounts", {
      provider: "hra-control-plane-otp-v1", providerAccountId: email, userId,
      ...(verified ? { emailVerified: email } : {}),
    });
    const subjectId = await ctx.db.insert("authSubjects", {
      authEpoch: 1, createdAt: now, emailDigest, status: "active", updatedAt: now, userId,
      ...(verified ? { verifiedAt: now } : {}),
    });
    for (const id of [accountId, subjectId]) {
      const stored = await ctx.db.get(id);
      if (stored === null) throw new Error("missing identity fixture");
      await reserveQuotaForInsert(ctx, userId, "identity", stored);
    }
    const sessionIds = [];
    const count = options.full ? 253 - (options.dedicated ? 1 : 0) : 1;
    for (let index = 0; index < count; index += 1) {
      const id = await ctx.db.insert("authSessions", { expirationTime: now + 60_000, userId });
      const session = await ctx.db.get(id);
      if (session === null) throw new Error("missing session fixture");
      await reserveQuotaForInsert(ctx, userId, "identity", session);
      sessionIds.push(id);
    }
    if (options.device) {
      const id = await ctx.db.insert("devices", { activatedAt: now, authEpoch: 1, createdAt: now,
        credentialGeneration: 1, encryptedLabel: { algorithm: "A256GCM", ciphertext: "fixture", keyVersion: 1, nonce: "fixture" },
        keyVersion: 1, publicId: "inline-device", revision: 1, signingPublicKey: "fixture", status: "active",
        updatedAt: now, userId, wrappingPublicKey: "fixture" });
      const device = await ctx.db.get(id);
      if (device === null) throw new Error("missing device fixture");
      await reserveDeviceQuotaForInsert(ctx, userId, device);
    }
    const authSessionId = sessionIds[0];
    if (authSessionId === undefined) throw new Error("missing actor fixture");
    return { userId, accountId, subjectId, authSessionId };
  });
  return { ...ids, runtime, actor: runtime.withIdentity({
    issuer: "https://test.example", subject: `${ids.userId}|${ids.authSessionId}`, tokenIdentifier: `test|${ids.authSessionId}`,
  }) };
}
type World = Awaited<ReturnType<typeof world>>;

async function snapshot(value: World) {
  return await value.runtime.run(async (ctx) => ({
    users: await ctx.db.query("users").collect(), subjects: await ctx.db.query("authSubjects").collect(),
    accounts: await ctx.db.query("authAccounts").collect(), sessions: await ctx.db.query("authSessions").collect(),
    identityReservations: await ctx.db.query("accountDeletionIdentityReservations").collect(),
    jobReservations: await ctx.db.query("accountDeletionJobReservations").collect(),
    jobs: await ctx.db.query("accountDeletionJobs").collect(),
    service: await ctx.db.query("storageUsageService").unique(), categories: await ctx.db.query("storageUsageByUser").collect(),
    resources: await ctx.db.query("storageResourceUsageByUser").collect(),
    deviceReservations: await ctx.db.query("deviceRevocationDeviceReservations").collect(),
    deviceJobReservations: await ctx.db.query("deviceRevocationJobReservations").collect(),
    deviceSecurityReservations: await ctx.db.query("deviceRevocationSecurityReservations").collect(),
    deviceReceiptReservations: await ctx.db.query("deviceRevocationReceiptReservations").collect(),
  }));
}
const request = { jobId: "delete_job_inline_AAAAAAAAAAAAAAAAAAAAAAAAA", statusCapability: "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-ABCDE" };

describe("legacy inline account deletion capacity", () => {
  test("genuine 256-record identity adds only charged bytes and five non-identity slots, once", async () => {
    const value = await world({ full: true, device: true });
    const before = await snapshot(value);
    const identityBefore = before.categories.find((row) => row.category === "identity");
    expect(before.users.length + before.subjects.length + before.accounts.length + before.sessions.length).toBe(256);
    expect(identityBefore?.records).toBe(256);
    expect(identityBefore?.logicalBytes).toBe([...before.users, ...before.subjects, ...before.accounts, ...before.sessions]
      .reduce((total, row) => total + logicalDocumentBytes(row), 0));
    const results: unknown[] = await Promise.all([
      value.runtime.mutation(backfill, { userId: value.userId }), value.runtime.mutation(backfill, { userId: value.userId }),
    ]);
    expect(results).toEqual([{ reserved: 2 }, { reserved: 0 }]);
    const after = await snapshot(value);
    expect(after.users).toEqual(before.users); expect(after.accounts).toEqual(before.accounts); expect(after.sessions).toEqual(before.sessions);
    expect(after.identityReservations).toEqual([]); expect(after.jobReservations).toHaveLength(1);
    const subject = after.subjects[0]; const prior = before.subjects[0];
    if (subject === undefined || prior === undefined) throw new Error("missing subject observation");
    expect(subject).toMatchObject({ ...prior, accountDeletionCapacity: {
      version: 2, reservation: authorityReductionCapacityReservation, createdAt: after.jobReservations[0]?.createdAt,
    } });
    expect(after.categories.find((row) => row.category === "identity")).toMatchObject({
      records: 256, logicalBytes: (identityBefore?.logicalBytes ?? 0) + logicalDocumentBytes(subject) - logicalDocumentBytes(prior),
    });
    expect(after.service?.records).toBe((before.service?.records ?? 0) + 5);
    expect(await value.runtime.run(async (ctx) =>
      await classifyAuthorityReductionCapacityForUser(ctx, value.userId, Date.now())))
      .toEqual({ disposition: "ready", missing: 0 });
    expect(await value.runtime.mutation(backfill, { userId: value.userId })).toEqual({ reserved: 0 });
    expect(await snapshot(value)).toEqual(after);
  });

  test("a full identity consumes inline padding without growing bytes or records and completes deletion", async () => {
    const value = await world({ full: true });
    await value.runtime.mutation(backfill, { userId: value.userId });
    const before = await snapshot(value);
    await value.actor.mutation(requestDeletion, request);
    const after = await snapshot(value);
    const subject = after.subjects[0]; const prior = before.subjects[0];
    if (subject === undefined || prior === undefined) throw new Error("missing subject observation");
    expect(subject.accountDeletionCapacity).toBeUndefined();
    expect(subject).toMatchObject({ status: "disabled", authEpoch: 2 });
    expect(logicalDocumentBytes(subject)).toBeLessThan(logicalDocumentBytes(prior));
    expect(after.categories.find((row) => row.category === "identity")?.records).toBe(256);
    expect(after.jobReservations).toEqual([]); expect(after.jobs).toHaveLength(1);
    expect(after.jobs[0]?.capacityReservation).toBe(durableJobCapacityReservation);
    expect(after.service?.records).toBe(before.service?.records);
    expect(await value.actor.mutation(requestDeletion, request)).toMatchObject({ replay: true });
    expect(await snapshot(value)).toEqual(after);
    for (let index = 0; index < 300; index += 1) {
      await value.runtime.mutation(drainDeletion, { limit: 200 });
      if (await value.runtime.run(async (ctx) => await ctx.db.get(value.userId)) === null) break;
    }
    expect(await snapshot(value)).toMatchObject({ users: [], subjects: [], accounts: [], sessions: [],
      identityReservations: [], jobReservations: [], jobs: [], categories: [],
      service: { userRecords: 0, userLogicalBytes: 0, identities: 0 } });
  });

  test("actual identity byte-ceiling refusal rolls back the separately inserted job", async () => {
    const value = await world();
    await value.runtime.run(async (ctx) => {
      const user = await ctx.db.get(value.userId);
      const identity = await ctx.db.query("storageUsageByUser")
        .withIndex("by_user_and_category", (q) => q.eq("userId", value.userId).eq("category", "identity")).unique();
      if (user === null || identity === null) throw new Error("missing ceiling fixture");
      // A real user field fills the category's byte quota; no forged counters.
      const room = CATEGORY_QUOTAS.identity.logicalBytes - identity.logicalBytes;
      const overhead = logicalDocumentBytes({ ...user, name: "" }) - logicalDocumentBytes(user);
      const patch = { name: "x".repeat(room - overhead) };
      await adjustParentAttributedQuotaForPatch(ctx, value.userId, "identity", user, patch);
      await ctx.db.patch(user._id, patch);
    });
    const before = await snapshot(value);
    expect(before.categories.find((row) => row.category === "identity")?.logicalBytes).toBe(CATEGORY_QUOTAS.identity.logicalBytes);
    await expect(value.runtime.mutation(backfill, { userId: value.userId })).rejects.toThrow("QUOTA_EXCEEDED");
    expect(await snapshot(value)).toEqual(before);
  });

  test("oversized authority consumption refuses without changing subject or job", async () => {
    const value = await world();
    await value.runtime.mutation(backfill, { userId: value.userId });
    const before = await snapshot(value);
    await expect(value.runtime.mutation(oversizedConsume, { userId: value.userId }))
      .rejects.toThrow("AUTHORITY_REDUCTION_CAPACITY_CORRUPT");
    expect(await snapshot(value)).toEqual(before);
  });

  test("mixed, partial, mismatched and disabled inline authority refuses without repair", async () => {
    for (const kind of ["mixed", "missing_job", "missing_inline", "padding", "timestamp", "job_user", "duplicate_subject", "disabled"] as const) {
      const value = await world();
      await value.runtime.mutation(backfill, { userId: value.userId });
      await value.runtime.run(async (ctx) => {
        const subject = await ctx.db.get(value.subjectId);
        const job = await ctx.db.query("accountDeletionJobReservations").unique();
        if (subject?.accountDeletionCapacity === undefined || job === null) throw new Error("missing corruption fixture");
        switch (kind) {
          case "mixed": await ctx.db.insert("accountDeletionIdentityReservations", { capacityReservation: authorityReductionCapacityReservation,
            capacityVersion: 1, category: "identity", createdAt: job.createdAt, userId: value.userId }); break;
          case "missing_job": await ctx.db.delete(job._id); break;
          case "missing_inline": await ctx.db.patch(subject._id, { accountDeletionCapacity: undefined }); break;
          case "padding": await ctx.db.patch(subject._id, { accountDeletionCapacity: { ...subject.accountDeletionCapacity, reservation: "0" } }); break;
          case "timestamp": await ctx.db.patch(subject._id, { accountDeletionCapacity: { ...subject.accountDeletionCapacity, createdAt: job.createdAt + 1 } }); break;
          case "job_user": await ctx.db.patch(job._id, { userId: await ctx.db.insert("users", {}) }); break;
          case "duplicate_subject": await ctx.db.insert("authSubjects", { authEpoch: 1, createdAt: 1, emailDigest: "b".repeat(64),
            status: "active", updatedAt: 1, userId: value.userId }); break;
          case "disabled": await ctx.db.patch(subject._id, { status: "disabled" }); break;
        }
      });
      const before = await snapshot(value);
      await expect(value.runtime.run(async (ctx) => await loadAccountDeletionCapacity(ctx, value.userId)))
        .rejects.toThrow("AUTHORITY_REDUCTION_CAPACITY_CORRUPT");
      await expect(value.runtime.mutation(backfill, { userId: value.userId })).rejects.toThrow("AUTHORITY_REDUCTION_CAPACITY_CORRUPT");
      expect(await snapshot(value)).toEqual(before);
    }
  });

  test("fresh dedicated capacity is unchanged and remains consumable", async () => {
    const value = await world({ dedicated: true });
    const before = await snapshot(value);
    expect(before.identityReservations).toHaveLength(1); expect(before.subjects[0]?.accountDeletionCapacity).toBeUndefined();
    expect(await value.runtime.mutation(backfill, { userId: value.userId })).toEqual({ reserved: 0 });
    expect(await snapshot(value)).toEqual(before);
    await value.actor.mutation(requestDeletion, request);
    const after = await snapshot(value);
    expect(after.identityReservations).toEqual([]); expect(after.jobReservations).toEqual([]);
    expect(after.categories.find((row) => row.category === "identity")?.records)
      .toBe((before.categories.find((row) => row.category === "identity")?.records ?? 0) - 1);
  });

  test("ordinary quota-charged subject patches preserve inline authority and standalone Auth user deletion refuses", async () => {
    const value = await world();
    await value.runtime.mutation(backfill, { userId: value.userId });
    const before = await snapshot(value);
    await value.runtime.run(async (ctx) => {
      const subject = await ctx.db.get(value.subjectId);
      if (subject === null) throw new Error("missing patch fixture");
      const patch = { updatedAt: subject.updatedAt + 1 };
      await adjustQuotaForPatch(ctx, value.userId, "identity", subject, patch);
      await ctx.db.patch(subject._id, patch);
      expect((await loadAccountDeletionCapacity(ctx, value.userId)).kind).toBe("inline_reserved");
    });
    const afterPatch = await snapshot(value);
    expect(afterPatch.subjects[0]?.accountDeletionCapacity).toEqual(before.subjects[0]?.accountDeletionCapacity);
    await expect(value.runtime.run(async (ctx) => await runQuotaAwareAuthStoreForTest(ctx, "signIn", async (wrapped) =>
      await wrapped.db.delete(value.userId)))).rejects.toThrow();
    expect(await snapshot(value)).toEqual(afterPatch);
  });

  test("abandoned-identity cleanup removes inline subject and job together within its row budget", async () => {
    const value = await world({ verified: false });
    await value.runtime.mutation(backfill, { userId: value.userId });
    await value.runtime.run(async (ctx) => {
      const subject = await ctx.db.get(value.subjectId);
      if (subject === null) throw new Error("missing cleanup subject");
      const patch = { updatedAt: Date.now() - cloudRetentionMs.abandonedIdentity - 1 };
      await adjustQuotaForPatch(ctx, value.userId, "identity", subject, patch);
      await ctx.db.patch(subject._id, patch);
      await runQuotaAwareAuthStoreForTest(ctx, "signOut", async (wrapped) => await wrapped.db.delete(value.authSessionId));
      await ctx.db.insert("maintenanceState", { key: "retention", nextCategory: "abandoned_identities", updatedAt: Date.now() });
    });
    const resetCategory = async () => {
      await value.runtime.run(async (ctx) => {
        const state = await ctx.db.query("maintenanceState").unique();
        if (state !== null) await ctx.db.patch(state._id, { nextCategory: "abandoned_identities" });
      });
    };
    expect(await value.runtime.mutation(cleanup, { limit: 200 })).toMatchObject({ abandonedIdentities: 1 });
    await resetCategory();
    const beforeSmallBudget = await snapshot(value);
    expect(await value.runtime.mutation(cleanup, { limit: 2 })).toMatchObject({ abandonedIdentities: 0 });
    expect(await snapshot(value)).toEqual(beforeSmallBudget);
    await resetCategory();
    expect(await value.runtime.mutation(cleanup, { limit: 200 })).toMatchObject({ abandonedIdentities: 3 });
    expect(await snapshot(value)).toMatchObject({ users: [], subjects: [], accounts: [], sessions: [],
      identityReservations: [], jobReservations: [], service: { identities: 0, userRecords: 0, userLogicalBytes: 0 } });
  });

  test("unbound inline padding is corrupt orphan authority and is never deleted by maintenance", async () => {
    const value = await world({ verified: false });
    await value.runtime.mutation(backfill, { userId: value.userId });
    await value.runtime.run(async (ctx) => {
      await runQuotaAwareAuthStoreForTest(ctx, "signOut", async (wrapped) => await wrapped.db.delete(value.authSessionId));
      await ctx.db.patch(value.subjectId, { userId: undefined, updatedAt: Date.now() - cloudRetentionMs.abandonedIdentity - 1 });
      await ctx.db.insert("maintenanceState", { key: "retention", nextCategory: "abandoned_identities", updatedAt: Date.now() });
    });
    const before = await snapshot(value);
    await expect(value.runtime.mutation(cleanup, { limit: 200 })).rejects.toThrow("Maintenance authority is corrupt.");
    expect(await snapshot(value)).toEqual(before);
  });
});
