import { describe, expect, test } from "bun:test";
import { makeFunctionReference } from "convex/server";
import type { Value } from "convex/values";
import { convexTest } from "convex-test";
import fc from "fast-check";

import {
  logicalDocumentBytes,
  auditUserQuotaUpgradePageForRuntime,
  diagnoseUserQuotaUpgradePageForRuntime,
  emptyQuotaUpgradeCorruptionCounts,
  upgradeUserQuotaPageForRuntime,
  initializeUserQuotaAuthority,
  reserveQuotaForInsert,
  reserveMemorySpaceQuotaForInsert,
  reserveSessionHeadQuotaForInsert,
} from "./quota";
import schema from "./schema";
import { modules } from "./test.setup";
import { internalMutation, internalQuery } from "./server";
import { runtimeReleaseAttestation, userQuotaUpgradePaginationOpts } from "./validators";

const boundRuntime = {
  bound: true as const,
  schemaIdentity: "hra-release-attestation-v1" as const,
  schemaVersion: 1 as const,
  deployedAtMs: 1_700_000_000_000,
  previousDeployDigest: "a".repeat(64),
  runtimeRevision: "00000000-0000-4000-8000-000000000001",
  runtimeSourceCommit: "b".repeat(40),
};
const pageArgs = { expectedRuntimeAttestation: boundRuntime, paginationOpts: { cursor: null, numItems: 8 } };
const entryArgs = { expectedRuntimeAttestation: runtimeReleaseAttestation, paginationOpts: userQuotaUpgradePaginationOpts };
// Exercise real registered Convex transactions with an explicit bound test
// runtime. Production registrations separately prove unbound-build refusal.
const testModules = {
  ...modules,
  "./quotaUpgradeFixture.ts": async () => ({
    audit: internalQuery({ args: entryArgs, handler: async (ctx, args) =>
      await auditUserQuotaUpgradePageForRuntime(ctx, args, boundRuntime) }),
    diagnose: internalQuery({ args: entryArgs, handler: async (ctx, args) =>
      await diagnoseUserQuotaUpgradePageForRuntime(ctx, args, boundRuntime) }),
    upgrade: internalMutation({ args: entryArgs, handler: async (ctx, args) =>
      await upgradeUserQuotaPageForRuntime(ctx, args, boundRuntime) }),
  }),
};
type Args = Record<string, Value>;
type Audit = Awaited<ReturnType<typeof auditUserQuotaUpgradePageForRuntime>>;
type Diagnostic = Awaited<ReturnType<typeof diagnoseUserQuotaUpgradePageForRuntime>>;
type Upgrade = Awaited<ReturnType<typeof upgradeUserQuotaPageForRuntime>>;
const audit = makeFunctionReference<"query", Args, Audit>("quotaUpgradeFixture:audit");
const diagnose = makeFunctionReference<"query", Args, Diagnostic>("quotaUpgradeFixture:diagnose");
const productionDiagnose = makeFunctionReference<"query", Args, Diagnostic>("quota:diagnoseUserQuotaUpgradePage");
const upgrade = makeFunctionReference<"mutation", Args, Upgrade>("quotaUpgradeFixture:upgrade");
const productionAudit = makeFunctionReference<"query", Args, Audit>("quota:auditUserQuotaUpgradePage");
const productionUpgrade = makeFunctionReference<"mutation", Args, Upgrade>("quota:upgradeUserQuotaPage");

// Closed predecessor schema from a75e748; do not derive it by filtering today's
// arrays, because a future category must not silently enter this fixture.
const predecessorCategories = [
  "identity", "device", "account", "session", "chunk", "usage",
  "command", "custody", "receipt", "security", "job",
] as const;
const predecessorResources = [
  "device", "codex_account", "session_head", "session_chunk",
  "nonterminal_command", "live_chunk",
] as const;
const genesisHardAuthority = makeFunctionReference<
  "mutation", Record<string, never>, Readonly<{ enforcement: "hard" }>
>("quota:genesisHardAuthority");

async function predecessorQuotaWorld() {
  const runtime = convexTest(schema, testModules);
  await runtime.mutation(genesisHardAuthority, {});
  const addUser = async () => await runtime.run(async (ctx) => {
    const now = 1_700_000_000_000;
    const id = await ctx.db.insert("users", {
      email: "predecessor-quota@example.com",
      emailVerificationTime: now,
    });
    const user = await ctx.db.get(id);
    if (user === null) throw new Error("missing predecessor user fixture");
    const identityBytes = logicalDocumentBytes(user);
    for (const category of predecessorCategories) {
      await ctx.db.insert("storageUsageByUser", {
        category,
        logicalBytes: category === "identity" ? identityBytes : 0,
        records: category === "identity" ? 1 : 0,
        updatedAt: now,
        userId: id,
      });
    }
    for (const resource of predecessorResources) {
      await ctx.db.insert("storageResourceUsageByUser", {
        resource, records: 0, updatedAt: now, userId: id,
      });
    }
    const service = await ctx.db.query("storageUsageService")
      .withIndex("by_key", (query) => query.eq("key", "global")).unique();
    if (service === null) throw new Error("missing predecessor service fixture");
    await ctx.db.patch(service._id, {
      identities: service.identities + 1,
      logicalBytes: service.logicalBytes + identityBytes,
      records: service.records + 1,
      userLogicalBytes: service.userLogicalBytes + identityBytes,
      userRecords: service.userRecords + 1,
      updatedAt: now,
    });
    return id;
  });
  const userId = await addUser();
  return { runtime, userId, addUser };
}

type World = Awaited<ReturnType<typeof predecessorQuotaWorld>>;
async function snapshot(world: World) {
  return await world.runtime.run(async (ctx) => ({
    users: await ctx.db.query("users").collect(),
    service: await ctx.db.query("storageUsageService").collect(),
    categories: await ctx.db.query("storageUsageByUser").collect(),
    resources: await ctx.db.query("storageResourceUsageByUser").collect(),
    spaces: await ctx.db.query("memorySpaces").collect(),
    operations: await ctx.db.query("memoryOperations").collect(),
  }));
}
async function assertConserved(world: World, before: Awaited<ReturnType<typeof snapshot>>) {
  const after = await snapshot(world);
  expect(after.users).toEqual(before.users);
  expect(after.service).toEqual(before.service);
  expect(after.spaces).toEqual(before.spaces);
  expect(after.operations).toEqual(before.operations);
  for (const row of before.categories) {
    expect(after.categories.find((candidate) => candidate._id === row._id))
      .toEqual(row.category === "identity" ? { ...row, quotaSchemaVersion: 2 } : row);
  }
  for (const row of before.resources) {
    expect(after.resources.find((candidate) => candidate._id === row._id)).toEqual(row);
  }
}

async function addCurrentRows(world: World) {
  await world.runtime.run(async (ctx) => {
    await ctx.db.insert("storageUsageByUser", {
      category: "memory", logicalBytes: 0, records: 0, updatedAt: 1_700_000_000_000, userId: world.userId,
    });
    await ctx.db.insert("storageResourceUsageByUser", {
      resource: "memory_space", records: 0, updatedAt: 1_700_000_000_000, userId: world.userId,
    });
  });
}

const envelope = { algorithm: "A256GCM" as const, ciphertext: "fixture", keyVersion: 1, nonce: "fixture" };
async function addMemorySpace(world: World, charge = false) {
  return await world.runtime.run(async (ctx) => {
    const document = {
      bindingPolicy: "one_project_one_space" as const, createdAt: 1, encryptedDescriptor: envelope,
      genesisToken: "fixture-genesis", genesisHeadProof: envelope, identityContract: 2 as const,
      keyVersion: 1, publicId: "fixture-space", revision: 1, updatedAt: 1, userId: world.userId,
      wrappedSpaceKey: envelope,
    };
    if (charge) await reserveMemorySpaceQuotaForInsert(ctx, world.userId, document);
    return await ctx.db.insert("memorySpaces", document);
  });
}

const incompleteForms = [
  { missing: "category", marked: false }, { missing: "resource", marked: false },
  { missing: "category", marked: true }, { missing: "resource", marked: true },
  { missing: "both", marked: true },
] as const;
type IncompleteForm = typeof incompleteForms[number];
async function makeIncompleteMemory(world: World, form: IncompleteForm) {
  await addCurrentRows(world);
  await world.runtime.run(async (ctx) => {
    const categories = await ctx.db.query("storageUsageByUser")
      .withIndex("by_user_and_category", (q) => q.eq("userId", world.userId)).collect();
    const resource = await ctx.db.query("storageResourceUsageByUser")
      .withIndex("by_user_and_resource", (q) => q.eq("userId", world.userId).eq("resource", "memory_space")).unique();
    const memory = categories.find((row) => row.category === "memory");
    const identity = categories.find((row) => row.category === "identity");
    if (memory === undefined || identity === undefined || resource === null) throw new Error("incomplete fixture setup failed");
    if (form.missing !== "resource") await ctx.db.delete(memory._id);
    if (form.missing !== "category") await ctx.db.delete(resource._id);
    if (form.marked) await ctx.db.patch(identity._id, { quotaSchemaVersion: 2 });
  });
}

describe("predecessor hosted quota upgrade", () => {
  test("five empty-memory forms add only absent rows and preserve all six tables under repeat and concurrency", async () => {
    for (const form of incompleteForms) {
      const world = await predecessorQuotaWorld();
      await makeIncompleteMemory(world, form);
      const before = await snapshot(world);
      expect(await world.runtime.query(audit, pageArgs)).toMatchObject({
        schemaVersion: 2, legacy: 0, unmarkedCurrent: 0, incompleteEmptyMemory: 1, corrupt: 0,
      });
      expect(await world.runtime.query(diagnose, pageArgs)).toMatchObject({
        incompleteEmptyMemory: 1, corrupt: 0, reasons: emptyQuotaUpgradeCorruptionCounts(), missingShapes: [],
      });
      expect(await snapshot(world)).toEqual(before);
      const earliest = Date.now();
      const results = await Promise.all([world.runtime.mutation(upgrade, pageArgs), world.runtime.mutation(upgrade, pageArgs)]);
      const latest = Date.now();
      expect(results.reduce((sum, row) => sum + row.changed, 0)).toBe(1);
      expect(results.reduce((sum, row) => sum + row.repairedMemory, 0)).toBe(1);
      expect(results.reduce((sum, row) => sum + row.marked, 0)).toBe(form.marked ? 0 : 1);
      expect(results.reduce((sum, row) => sum + row.upgraded, 0)).toBe(0);
      await assertConserved(world, before);
      const after = await snapshot(world);
      expect(after.categories).toHaveLength(12); expect(after.resources).toHaveLength(7);
      const addedCategories = after.categories.filter((row) => !before.categories.some((old) => old._id === row._id));
      const addedResources = after.resources.filter((row) => !before.resources.some((old) => old._id === row._id));
      expect(addedCategories).toHaveLength(form.missing === "resource" ? 0 : 1);
      expect(addedResources).toHaveLength(form.missing === "category" ? 0 : 1);
      for (const row of addedCategories) expect(row).toMatchObject({ category: "memory", logicalBytes: 0, records: 0, userId: world.userId });
      for (const row of addedResources) expect(row).toMatchObject({ resource: "memory_space", records: 0, userId: world.userId });
      for (const row of [...addedCategories, ...addedResources]) {
        expect(row.updatedAt).toBeGreaterThanOrEqual(earliest); expect(row.updatedAt).toBeLessThanOrEqual(latest);
      }
      expect(await world.runtime.mutation(upgrade, pageArgs)).toMatchObject({ current: 1, changed: 0, repairedMemory: 0, marked: 0, upgraded: 0 });
      expect(await snapshot(world)).toEqual(after);
    }
  });

  test("empty-memory completion preserves arbitrary valid old accounting and rejects runtime drift", async () => {
    await fc.assert(fc.asyncProperty(fc.constantFrom(...incompleteForms), fc.integer({ min: 1, max: 100 }),
      fc.integer({ min: 1, max: 1000 }), async (form, records, perRecord) => {
        const world = await predecessorQuotaWorld(); await makeIncompleteMemory(world, form);
        await world.runtime.run(async (ctx) => {
          const row = await ctx.db.query("storageUsageByUser")
            .withIndex("by_user_and_category", (q) => q.eq("userId", world.userId).eq("category", "receipt")).unique();
          const service = await ctx.db.query("storageUsageService").unique();
          if (row === null || service === null) throw new Error("missing conservation fixture");
          const logicalBytes = records * perRecord;
          await ctx.db.patch(row._id, { logicalBytes, records });
          await ctx.db.patch(service._id, { logicalBytes: service.logicalBytes + logicalBytes,
            userLogicalBytes: service.userLogicalBytes + logicalBytes, records: service.records + records,
            userRecords: service.userRecords + records });
        });
        const before = await snapshot(world);
        await expect(world.runtime.mutation(upgrade, { ...pageArgs,
          expectedRuntimeAttestation: { ...boundRuntime, runtimeSourceCommit: "c".repeat(40) },
        })).rejects.toThrow("QUOTA_UPGRADE_RUNTIME_CHANGED");
        expect(await snapshot(world)).toEqual(before);
        await world.runtime.mutation(upgrade, pageArgs); await assertConserved(world, before);
      }), { numRuns: 20 });
  });

  test("nonzero retained memory authority is never reset even when both owner indexes are empty", async () => {
    for (const form of incompleteForms.filter((value) => value.missing !== "both")) {
      const world = await predecessorQuotaWorld();
      await makeIncompleteMemory(world, form);
      await world.runtime.run(async (ctx) => {
        if (form.missing === "category") {
          const resource = await ctx.db.query("storageResourceUsageByUser")
            .withIndex("by_user_and_resource", (q) => q.eq("userId", world.userId).eq("resource", "memory_space")).unique();
          if (resource === null) throw new Error("missing retained resource");
          await ctx.db.patch(resource._id, { records: 1 });
        } else {
          const category = await ctx.db.query("storageUsageByUser")
            .withIndex("by_user_and_category", (q) => q.eq("userId", world.userId).eq("category", "memory")).unique();
          const service = await ctx.db.query("storageUsageService").unique();
          if (category === null || service === null) throw new Error("missing retained category");
          await ctx.db.patch(category._id, { logicalBytes: 1, records: 1 });
          await ctx.db.patch(service._id, { logicalBytes: service.logicalBytes + 1, records: service.records + 1,
            userLogicalBytes: service.userLogicalBytes + 1, userRecords: service.userRecords + 1 });
        }
      });
      const before = await snapshot(world);
      expect(await world.runtime.query(diagnose, pageArgs)).toMatchObject({ incompleteEmptyMemory: 0, corrupt: 1,
        reasons: { ...emptyQuotaUpgradeCorruptionCounts(), schema_shape: 1 } });
      await expect(world.runtime.mutation(upgrade, pageArgs)).rejects.toThrow("QUOTA_AUTHORITY_CORRUPT");
      expect(await snapshot(world)).toEqual(before);
    }
  });

  test("each incomplete form checks owner spaces and orphan operations before repair", async () => {
    for (const form of incompleteForms) for (const orphan of [false, true]) {
      const world = await predecessorQuotaWorld(); await makeIncompleteMemory(world, form);
      expect(await world.runtime.query(audit, pageArgs)).toMatchObject({ incompleteEmptyMemory: 1, corrupt: 0 });
      const memorySpaceId = await addMemorySpace(world);
      if (orphan) await world.runtime.run(async (ctx) => {
        const deviceId = await ctx.db.insert("devices", {
          activatedAt: 1, authEpoch: 1, createdAt: 1, credentialGeneration: 1,
          encryptedLabel: envelope, keyVersion: 1, publicId: "fixture-device", revision: 1,
          signingPublicKey: "fixture", status: "active", updatedAt: 1, userId: world.userId, wrappingPublicKey: "fixture",
        });
        await ctx.db.insert("memoryOperations", {
          adoptionProof: null, baseRevision: 1, createdAt: 1, genesisToken: "fixture-genesis", headToken: "fixture-head",
          keyVersion: 1, memorySpaceId, operation: envelope, priorToken: "fixture-prior", sequence: 1,
          sourceDeviceId: deviceId, terminalHeadProof: envelope, userId: world.userId,
        });
        await ctx.db.delete(memorySpaceId);
      });
      const before = await snapshot(world);
      expect(await world.runtime.query(diagnose, pageArgs)).toMatchObject({ incompleteEmptyMemory: 0, corrupt: 1,
        reasons: { ...emptyQuotaUpgradeCorruptionCounts(), incomplete_memory_present: 1 } });
      await expect(world.runtime.mutation(upgrade, pageArgs)).rejects.toThrow("QUOTA_AUTHORITY_CORRUPT");
      expect(await snapshot(world)).toEqual(before);
    }
  });

  test("unrelated owner data is conserved and a later corrupt owner rolls back empty-memory additions", async () => {
    for (const corruptLater of [false, true]) {
      const world = await predecessorQuotaWorld(); await makeIncompleteMemory(world, { missing: "both", marked: true });
      const other = { ...world, userId: await world.addUser() }; await addCurrentRows(other); await addMemorySpace(other, true);
      if (corruptLater) await world.runtime.run(async (ctx) => {
        const row = await ctx.db.query("storageUsageByUser")
          .withIndex("by_user_and_category", (q) => q.eq("userId", other.userId).eq("category", "job")).unique();
        if (row === null) throw new Error("missing later corrupt fixture"); await ctx.db.delete(row._id);
      });
      const before = await snapshot(world);
      if (corruptLater) {
        await expect(world.runtime.mutation(upgrade, pageArgs)).rejects.toThrow("QUOTA_AUTHORITY_CORRUPT");
        expect(await snapshot(world)).toEqual(before);
      } else {
        expect(await world.runtime.mutation(upgrade, pageArgs)).toMatchObject({ changed: 2, repairedMemory: 1, marked: 1, upgraded: 0 });
        await assertConserved(world, before);
      }
    }
  });

  test("missing-shape diagnosis groups only matching ledgers and preserves all stored data", async () => {
    const world = await predecessorQuotaWorld();
    await world.runtime.mutation(upgrade, pageArgs);
    const second = { ...world, userId: await world.addUser() };
    await world.runtime.mutation(upgrade, pageArgs);
    const partial = { ...world, userId: await world.addUser() };
    await addCurrentRows(partial);
    await addMemorySpace(partial, true);
    const older = { ...world, userId: await world.addUser() };
    await addCurrentRows(older);
    await world.runtime.run(async (ctx) => {
      for (const owner of [world, second]) {
        const category = await ctx.db.query("storageUsageByUser")
          .withIndex("by_user_and_category", (q) => q.eq("userId", owner.userId).eq("category", "memory")).unique();
        const resource = await ctx.db.query("storageResourceUsageByUser")
          .withIndex("by_user_and_resource", (q) => q.eq("userId", owner.userId).eq("resource", "memory_space")).unique();
        if (category === null || resource === null) throw new Error("missing current fixture");
        await ctx.db.delete(category._id); await ctx.db.delete(resource._id);
      }
      const resource = await ctx.db.query("storageResourceUsageByUser")
        .withIndex("by_user_and_resource", (q) => q.eq("userId", partial.userId).eq("resource", "memory_space")).unique();
      const category = await ctx.db.query("storageUsageByUser")
        .withIndex("by_user_and_category", (q) => q.eq("userId", older.userId).eq("category", "device")).unique();
      const identity = await ctx.db.query("storageUsageByUser")
        .withIndex("by_user_and_category", (q) => q.eq("userId", older.userId).eq("category", "identity")).unique();
      if (resource === null || category === null || identity === null) throw new Error("missing partial fixture");
      await ctx.db.delete(resource._id); await ctx.db.delete(category._id);
      await ctx.db.patch(identity._id, { quotaSchemaVersion: 2 });
    });
    const before = await snapshot(world);
    const result = await world.runtime.query(diagnose, pageArgs);
    expect(result).toEqual({ schemaVersion: 2, continueCursor: expect.any(String), isDone: true,
      scanned: 4, legacy: 0, unmarkedCurrent: 0, incompleteEmptyMemory: 2, current: 0, corrupt: 2,
      reasons: { ...emptyQuotaUpgradeCorruptionCounts(), schema_shape: 2 },
      missingShapes: [
        { count: 1, shape: { marker: "current", missingCategories: ["device"], missingResources: [], memoryCategory: "zero", memoryResource: "zero" } },
        { count: 1, shape: { marker: "unmarked", missingCategories: [], missingResources: ["memory_space"], memoryCategory: "nonzero", memoryResource: "absent" } },
      ] });
    expect(await snapshot(world)).toEqual(before);
    await expect(world.runtime.mutation(upgrade, pageArgs)).rejects.toThrow("QUOTA_AUTHORITY_CORRUPT");
    expect(await snapshot(world)).toEqual(before);
  });

  test("diagnostic conserves all data and counts each disposition without identity output", async () => {
    const world = await predecessorQuotaWorld();
    await world.runtime.mutation(upgrade, pageArgs);
    const unmarked = await world.addUser();
    await addCurrentRows({ ...world, userId: unmarked });
    await world.addUser();
    const corrupt = await world.addUser();
    await world.runtime.run(async (ctx) => {
      const identity = await ctx.db.query("storageUsageByUser")
        .withIndex("by_user_and_category", (query) => query.eq("userId", corrupt).eq("category", "identity")).unique();
      if (identity === null) throw new Error("missing diagnostic fixture");
      await ctx.db.patch(identity._id, { quotaSchemaVersion: 3 });
    });
    const before = await snapshot(world);
    const result = await world.runtime.query(diagnose, pageArgs);
    expect(result).toEqual({ schemaVersion: 2, continueCursor: expect.any(String), isDone: true,
      scanned: 4, legacy: 1, unmarkedCurrent: 1, incompleteEmptyMemory: 0, current: 1, corrupt: 1,
      reasons: { ...emptyQuotaUpgradeCorruptionCounts(), category_authority: 1 }, missingShapes: [] });
    expect(await snapshot(world)).toEqual(before);
    await expect(world.runtime.query(productionDiagnose, pageArgs)).rejects.toThrow("QUOTA_UPGRADE_RUNTIME_CHANGED");
    await expect(world.runtime.query(diagnose, { ...pageArgs, expectedRuntimeAttestation: {
      ...boundRuntime, runtimeSourceCommit: "c".repeat(40),
    } })).rejects.toThrow("QUOTA_UPGRADE_RUNTIME_CHANGED");
  });

  test("empty pages still require durable hard service authority", async () => {
    const runtime = convexTest(schema, testModules);
    await expect(runtime.query(audit, pageArgs)).rejects.toThrow("QUOTA_AUTHORITY_CORRUPT");
    await expect(runtime.query(diagnose, pageArgs)).rejects.toThrow("QUOTA_AUTHORITY_CORRUPT");
    await expect(runtime.mutation(upgrade, pageArgs)).rejects.toThrow("QUOTA_AUTHORITY_CORRUPT");
    await runtime.mutation(genesisHardAuthority, {});
    expect(await runtime.query(audit, pageArgs)).toMatchObject({ scanned: 0, corrupt: 0, current: 0, isDone: true });
    expect(await runtime.query(diagnose, pageArgs)).toMatchObject({ scanned: 0, corrupt: 0,
      reasons: emptyQuotaUpgradeCorruptionCounts(), isDone: true });
    expect(await runtime.mutation(upgrade, pageArgs)).toMatchObject({ scanned: 0, marked: 0, upgraded: 0, isDone: true });
  });

  test("the same preserved counters admit ordinary writes when both new zero rows exist", async () => {
    const world = await predecessorQuotaWorld();
    await world.runtime.run(async (ctx) => {
      await ctx.db.insert("storageUsageByUser", {
        category: "memory", logicalBytes: 0, records: 0, updatedAt: 1_700_000_000_000, userId: world.userId,
      });
      await ctx.db.insert("storageResourceUsageByUser", {
        resource: "memory_space", records: 0, updatedAt: 1_700_000_000_000, userId: world.userId,
      });
      await reserveQuotaForInsert(ctx, world.userId, "receipt", {
        marker: "credential-free-receipt", userId: world.userId,
      });
      await reserveSessionHeadQuotaForInsert(ctx, world.userId, {
        marker: "credential-free-session-head", userId: world.userId,
      });
    });
    expect(await world.runtime.run(async (ctx) =>
      await ctx.db.query("storageResourceUsageByUser")
        .withIndex("by_user_and_resource", (query) => query.eq("userId", world.userId).eq("resource", "session_head"))
        .unique())).toMatchObject({ records: 1 });
  });

  test("ordinary category writes resume only after the explicit predecessor upgrade", async () => {
    const world = await predecessorQuotaWorld();
    await expect(world.runtime.run(async (ctx) =>
      await reserveQuotaForInsert(ctx, world.userId, "receipt", { marker: "before-upgrade", userId: world.userId })))
      .rejects.toThrow("QUOTA_AUTHORITY_CORRUPT");
    expect(await world.runtime.mutation(upgrade, pageArgs)).toMatchObject({ upgraded: 1, marked: 1, current: 0 });
    await world.runtime.run(async (ctx) =>
      await reserveQuotaForInsert(ctx, world.userId, "receipt", {
        marker: "credential-free-receipt", userId: world.userId,
      }));
    expect(await world.runtime.run(async (ctx) =>
      await ctx.db.query("storageUsageByUser")
        .withIndex("by_user_and_category", (query) => query.eq("userId", world.userId).eq("category", "receipt"))
        .unique())).toMatchObject({ records: 1 });
  });

  test("ordinary resource writes resume only after the explicit predecessor upgrade", async () => {
    const world = await predecessorQuotaWorld();
    await expect(world.runtime.run(async (ctx) =>
      await reserveSessionHeadQuotaForInsert(ctx, world.userId, { marker: "before-upgrade", userId: world.userId })))
      .rejects.toThrow("QUOTA_AUTHORITY_CORRUPT");
    await world.runtime.mutation(upgrade, pageArgs);
    await world.runtime.run(async (ctx) =>
      await reserveSessionHeadQuotaForInsert(ctx, world.userId, {
        marker: "credential-free-session-head", userId: world.userId,
      }));
    expect(await world.runtime.run(async (ctx) =>
      await ctx.db.query("storageResourceUsageByUser")
        .withIndex("by_user_and_resource", (query) => query.eq("userId", world.userId).eq("resource", "session_head"))
        .unique())).toMatchObject({ records: 1 });
  });

  test("audit is read-only and returns only the frozen aggregate response", async () => {
    const world = await predecessorQuotaWorld();
    const before = await snapshot(world);
    const result = await world.runtime.query(audit, pageArgs);
    expect(result).toEqual({ schemaVersion: 2, continueCursor: expect.any(String), isDone: true,
      scanned: 1, legacy: 1, unmarkedCurrent: 0, incompleteEmptyMemory: 0, current: 0, corrupt: 0 });
    expect(await snapshot(world)).toEqual(before);
  });

  test("preserves all prior authority and is idempotent under repeat and concurrent calls", async () => {
    const world = await predecessorQuotaWorld();
    const before = await snapshot(world);
    const results = await Promise.all([
      world.runtime.mutation(upgrade, pageArgs), world.runtime.mutation(upgrade, pageArgs),
    ]);
    expect(results.reduce((sum, result) => sum + result.upgraded, 0)).toBe(1);
    expect(results.reduce((sum, result) => sum + result.marked, 0)).toBe(1);
    await assertConserved(world, before);
    const after = await snapshot(world);
    expect(after.categories.length).toBe(12);
    expect(after.resources.length).toBe(7);
    expect(await world.runtime.mutation(upgrade, pageArgs)).toMatchObject({ current: 1, marked: 0, upgraded: 0 });
    expect(await snapshot(world)).toEqual(after);
  });

  test("marks a complete current ledger without inserting or modifying other fields", async () => {
    const world = await predecessorQuotaWorld();
    await addCurrentRows(world);
    const before = await snapshot(world);
    expect(await world.runtime.query(audit, pageArgs)).toMatchObject({ unmarkedCurrent: 1, legacy: 0 });
    expect(await world.runtime.mutation(upgrade, pageArgs)).toMatchObject({ marked: 1, upgraded: 0 });
    await assertConserved(world, before);
    expect((await snapshot(world)).categories.length).toBe(before.categories.length);
  });

  test("fresh identity authority carries the marker", async () => {
    const world = await predecessorQuotaWorld();
    const userId = await world.runtime.run(async (ctx) => {
      const id = await ctx.db.insert("users", {});
      await initializeUserQuotaAuthority(ctx, id);
      return id;
    });
    expect(await world.runtime.run(async (ctx) => await ctx.db.query("storageUsageByUser")
      .withIndex("by_user_and_category", (query) => query.eq("userId", userId).eq("category", "identity"))
      .unique())).toMatchObject({ quotaSchemaVersion: 2 });
  });

  test("a corrupt second identity rolls back the first identity's page additions", async () => {
    const world = await predecessorQuotaWorld();
    const secondId = await world.addUser();
    await world.runtime.run(async (ctx) => {
      const row = await ctx.db.query("storageUsageByUser")
        .withIndex("by_user_and_category", (query) => query.eq("userId", secondId).eq("category", "job")).unique();
      if (row === null) throw new Error("missing corrupt second identity fixture");
      await ctx.db.delete(row._id);
    });
    const before = await snapshot(world);
    expect(await world.runtime.query(audit, pageArgs)).toMatchObject({ legacy: 1, corrupt: 1 });
    await expect(world.runtime.mutation(upgrade, pageArgs)).rejects.toThrow("QUOTA_AUTHORITY_CORRUPT");
    expect(await snapshot(world)).toEqual(before);
  });

  test("unbound builds, changed runtime fields and invalid page bounds refuse without writes", async () => {
    const world = await predecessorQuotaWorld();
    const before = await snapshot(world);
    const unbound = { bound: false, schemaIdentity: "hra-release-attestation-v1", schemaVersion: 1 };
    for (const expectedRuntimeAttestation of [unbound, { ...boundRuntime, runtimeSourceCommit: "c".repeat(40) },
      { ...boundRuntime, runtimeRevision: "00000000-0000-4000-8000-000000000002" },
      { ...boundRuntime, deployedAtMs: boundRuntime.deployedAtMs + 1 },
      { ...boundRuntime, previousDeployDigest: "d".repeat(64) }]) {
      const args = { ...pageArgs, expectedRuntimeAttestation };
      await expect(world.runtime.query(audit, args)).rejects.toThrow("QUOTA_UPGRADE_RUNTIME_CHANGED");
      await expect(world.runtime.query(diagnose, args)).rejects.toThrow("QUOTA_UPGRADE_RUNTIME_CHANGED");
      await expect(world.runtime.mutation(upgrade, args)).rejects.toThrow("QUOTA_UPGRADE_RUNTIME_CHANGED");
    }
    for (const expectedRuntimeAttestation of [unbound, boundRuntime]) {
      await expect(world.runtime.query(productionAudit, { ...pageArgs, expectedRuntimeAttestation }))
        .rejects.toThrow("QUOTA_UPGRADE_RUNTIME_CHANGED");
      await expect(world.runtime.mutation(productionUpgrade, { ...pageArgs, expectedRuntimeAttestation }))
        .rejects.toThrow("QUOTA_UPGRADE_RUNTIME_CHANGED");
    }
    for (const numItems of [0, 9, -1, 1.5]) {
      const args = { ...pageArgs, paginationOpts: { cursor: null, numItems } };
      await expect(world.runtime.query(audit, args)).rejects.toThrow("QUOTA_AUTHORITY_CORRUPT");
      await expect(world.runtime.query(diagnose, args)).rejects.toThrow("QUOTA_AUTHORITY_CORRUPT");
      await expect(world.runtime.mutation(upgrade, args)).rejects.toThrow("QUOTA_AUTHORITY_CORRUPT");
    }
    expect(await snapshot(world)).toEqual(before);
  });

  test("preserves arbitrary valid predecessor accounting during the additive transition", async () => {
    await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 100 }), fc.integer({ min: 1, max: 1000 }), async (records, perRecord) => {
      const world = await predecessorQuotaWorld();
      await world.runtime.run(async (ctx) => {
        const row = await ctx.db.query("storageUsageByUser")
          .withIndex("by_user_and_category", (query) => query.eq("userId", world.userId).eq("category", "receipt")).unique();
        const service = await ctx.db.query("storageUsageService").unique();
        if (row === null || service === null) throw new Error("missing conservation fixture");
        const logicalBytes = records * perRecord;
        await ctx.db.patch(row._id, { logicalBytes, records });
        await ctx.db.patch(service._id, { logicalBytes: service.logicalBytes + logicalBytes,
          userLogicalBytes: service.userLogicalBytes + logicalBytes, records: service.records + records,
          userRecords: service.userRecords + records });
      });
      const before = await snapshot(world);
      await world.runtime.mutation(upgrade, pageArgs);
      await assertConserved(world, before);
    }), { numRuns: 20 });
  });

  test("never converts arbitrary missing or duplicate predecessor categories to zero", async () => {
    await fc.assert(fc.asyncProperty(fc.constantFrom(...predecessorCategories), fc.boolean(), async (category, duplicate) => {
      const world = await predecessorQuotaWorld();
      await world.runtime.run(async (ctx) => {
        const row = await ctx.db.query("storageUsageByUser")
          .withIndex("by_user_and_category", (query) => query.eq("userId", world.userId).eq("category", category)).unique();
        if (row === null) throw new Error("missing corruption fixture");
        if (duplicate) await ctx.db.insert("storageUsageByUser", { category, logicalBytes: row.logicalBytes,
          records: row.records, updatedAt: row.updatedAt, userId: row.userId });
        else await ctx.db.delete(row._id);
      });
      const before = await snapshot(world);
      expect(await world.runtime.query(audit, pageArgs)).toMatchObject({ corrupt: 1, legacy: 0 });
      expect(await world.runtime.query(diagnose, pageArgs)).toMatchObject({ corrupt: 1, legacy: 0,
        reasons: { ...emptyQuotaUpgradeCorruptionCounts(),
          [duplicate ? "duplicate_categories" : category === "identity" ? "identity_category_missing" : "schema_shape"]: 1 } });
      await expect(world.runtime.mutation(upgrade, pageArgs)).rejects.toThrow("QUOTA_AUTHORITY_CORRUPT");
      expect(await snapshot(world)).toEqual(before);
    }), { numRuns: 30 });
  });

  test("preserves correctly charged memory data on complete unmarked current ledgers", async () => {
    const world = await predecessorQuotaWorld();
    await addCurrentRows(world);
    await addMemorySpace(world, true);
    const before = await snapshot(world);
    expect(before.categories.find((row) => row.category === "memory")?.records).toBe(1);
    expect(await world.runtime.query(audit, pageArgs)).toMatchObject({ unmarkedCurrent: 1, corrupt: 0 });
    expect(await world.runtime.mutation(upgrade, pageArgs)).toMatchObject({ marked: 1, upgraded: 0 });
    await assertConserved(world, before);
  });

  test("owner memory data and orphan operations disprove legacy zero usage", async () => {
    for (const orphanOperation of [false, true]) {
      const world = await predecessorQuotaWorld();
      const memorySpaceId = await addMemorySpace(world);
      if (orphanOperation) await world.runtime.run(async (ctx) => {
        const deviceId = await ctx.db.insert("devices", {
          activatedAt: 1, authEpoch: 1, createdAt: 1, credentialGeneration: 1,
          encryptedLabel: envelope, keyVersion: 1, publicId: "fixture-device", revision: 1,
          signingPublicKey: "fixture", status: "active", updatedAt: 1,
          userId: world.userId, wrappingPublicKey: "fixture",
        });
        await ctx.db.insert("memoryOperations", {
          adoptionProof: null, baseRevision: 1, createdAt: 1, genesisToken: "fixture-genesis",
          headToken: "fixture-head", keyVersion: 1, memorySpaceId, operation: envelope,
          priorToken: "fixture-prior", sequence: 1, sourceDeviceId: deviceId,
          terminalHeadProof: envelope, userId: world.userId,
        });
        await ctx.db.delete(memorySpaceId);
      });
      const before = await snapshot(world);
      expect(await world.runtime.query(audit, pageArgs)).toMatchObject({ corrupt: 1, legacy: 0 });
      expect(await world.runtime.query(diagnose, pageArgs)).toMatchObject({ corrupt: 1, legacy: 0,
        reasons: { ...emptyQuotaUpgradeCorruptionCounts(), legacy_memory_present: 1 } });
      await expect(world.runtime.mutation(upgrade, pageArgs)).rejects.toThrow("QUOTA_AUTHORITY_CORRUPT");
      expect(await snapshot(world)).toEqual(before);
    }
  });

  test("another owner's charged memory data does not block the legacy owner", async () => {
    const world = await predecessorQuotaWorld();
    const other = { ...world, userId: await world.addUser() };
    await addCurrentRows(other);
    await addMemorySpace(other, true);
    const before = await snapshot(world);
    expect(await world.runtime.query(audit, pageArgs)).toMatchObject({ legacy: 1, unmarkedCurrent: 1, corrupt: 0 });
    expect(await world.runtime.mutation(upgrade, pageArgs)).toMatchObject({ upgraded: 1, marked: 2 });
    await assertConserved(world, before);
  });

  test("malformed authority never becomes an eligible upgrade", async () => {
    const cases = ["missing_resource", "duplicate_resource", "future_marker", "old_marker",
      "misplaced_marker", "negative_bytes", "fractional_records", "incoherent_pair", "category_limit",
      "resource_limit", "service_split_mismatch", "service_below_owner", "invalid_timestamp", "memory_resource_mismatch"] as const;
    for (const kind of cases) {
      const world = await predecessorQuotaWorld();
      if (kind === "memory_resource_mismatch") await addCurrentRows(world);
      await world.runtime.run(async (ctx) => {
        const categories = await ctx.db.query("storageUsageByUser").collect();
        const resources = await ctx.db.query("storageResourceUsageByUser").collect();
        const identity = categories.find((row) => row.category === "identity");
        const device = categories.find((row) => row.category === "device");
        const resource = resources.find((row) => row.resource === "device");
        const service = await ctx.db.query("storageUsageService").unique();
        if (identity === undefined || device === undefined || resource === undefined || service === null) {
          throw new Error("missing adversarial authority fixture");
        }
        switch (kind) {
          case "missing_resource": await ctx.db.delete(resource._id); break;
          case "duplicate_resource":
            await ctx.db.insert("storageResourceUsageByUser", { resource: "device", records: 0, updatedAt: 1, userId: world.userId });
            break;
          case "future_marker": await ctx.db.patch(identity._id, { quotaSchemaVersion: 3 }); break;
          case "old_marker": await ctx.db.patch(identity._id, { quotaSchemaVersion: 1 }); break;
          case "misplaced_marker": await ctx.db.patch(device._id, { quotaSchemaVersion: 2 }); break;
          case "negative_bytes": await ctx.db.patch(identity._id, { logicalBytes: -1 }); break;
          case "fractional_records": await ctx.db.patch(resource._id, { records: 0.5 }); break;
          case "incoherent_pair": await ctx.db.patch(device._id, { logicalBytes: 1 }); break;
          case "category_limit": await ctx.db.patch(device._id, { logicalBytes: 1, records: 65 }); break;
          case "resource_limit": await ctx.db.patch(resource._id, { records: 17 }); break;
          case "service_split_mismatch": await ctx.db.patch(service._id, { records: service.records + 1 }); break;
          case "service_below_owner":
            await ctx.db.patch(service._id, { identities: 0, logicalBytes: 0, records: 0, userLogicalBytes: 0, userRecords: 0 });
            break;
          case "invalid_timestamp": await ctx.db.patch(device._id, { updatedAt: -1 }); break;
          case "memory_resource_mismatch": {
            const space = resources.find((row) => row.resource === "memory_space");
            if (space === undefined) throw new Error("missing contradictory memory fixture");
            await ctx.db.patch(space._id, { records: 1 });
            break;
          }
        }
      });
      const before = await snapshot(world);
      if (kind === "service_split_mismatch") {
        await expect(world.runtime.query(audit, pageArgs)).rejects.toThrow("QUOTA_AUTHORITY_CORRUPT");
        await expect(world.runtime.query(diagnose, pageArgs)).rejects.toThrow("QUOTA_AUTHORITY_CORRUPT");
      } else {
        expect(await world.runtime.query(audit, pageArgs)).toMatchObject({ corrupt: 1, legacy: 0 });
        const expectedReasons = {
          missing_resource: "schema_shape", duplicate_resource: "duplicate_resources",
          future_marker: "category_authority", old_marker: "category_authority", misplaced_marker: "category_authority",
          negative_bytes: "category_authority", fractional_records: "resource_authority", incoherent_pair: "category_authority",
          category_limit: "category_ceiling", resource_limit: "resource_ceiling", service_below_owner: "service_total",
          invalid_timestamp: "category_authority", memory_resource_mismatch: "memory_counters",
        } as const;
        expect(await world.runtime.query(diagnose, pageArgs)).toMatchObject({ corrupt: 1, legacy: 0,
          reasons: { ...emptyQuotaUpgradeCorruptionCounts(), [expectedReasons[kind]]: 1 } });
      }
      await expect(world.runtime.mutation(upgrade, pageArgs)).rejects.toThrow("QUOTA_AUTHORITY_CORRUPT");
      expect(await snapshot(world)).toEqual(before);
    }
  });

  test("closed pagination rejects overrides and traverses more than eight users in bounded pages", async () => {
    const world = await predecessorQuotaWorld();
    for (let index = 0; index < 9; index += 1) await world.addUser();
    const before = await snapshot(world);
    for (const extra of [{ endCursor: "forged-range" }, { maximumRowsRead: 1000 },
      { maximumBytesRead: 1000000 }, { id: 1 }, { unknown: true }]) {
      const args = { ...pageArgs, paginationOpts: { ...pageArgs.paginationOpts, ...extra } };
      await expect(world.runtime.query(audit, args)).rejects.toThrow();
      await expect(world.runtime.query(diagnose, args)).rejects.toThrow();
      await expect(world.runtime.mutation(upgrade, args)).rejects.toThrow();
    }
    expect(await snapshot(world)).toEqual(before);
    const diagnosticFirst = await world.runtime.query(diagnose, pageArgs);
    expect(diagnosticFirst).toMatchObject({ scanned: 8, legacy: 8, isDone: false });
    expect(await world.runtime.query(diagnose, { ...pageArgs,
      paginationOpts: { cursor: diagnosticFirst.continueCursor, numItems: 8 },
    })).toMatchObject({ scanned: 2, legacy: 2, isDone: true });
    const first = await world.runtime.mutation(upgrade, pageArgs);
    expect(first).toMatchObject({ scanned: 8, upgraded: 8, isDone: false });
    const second = await world.runtime.mutation(upgrade, {
      ...pageArgs, paginationOpts: { cursor: first.continueCursor, numItems: 8 },
    });
    expect(second).toMatchObject({ scanned: 2, upgraded: 2, isDone: true });
    await assertConserved(world, before);
  });
});
