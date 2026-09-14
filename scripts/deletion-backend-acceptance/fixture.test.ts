import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeFunctionReference } from "convex/server";
import type { Value } from "convex/values";
import { convexTest } from "convex-test";

import { modules } from "../../convex/test.setup";
import schema from "../../convex/schema";
import { inspect, seed, type FixtureSeed } from "./fixture";

const testModules = {
  ...modules,
  "./deletionQualificationFixture.ts": async () => ({ seed, inspect }),
};
type Args = Record<string, Value>;
const genesis = makeFunctionReference<"mutation", Args, unknown>("quota:genesisHardAuthority");
const seedRef = makeFunctionReference<"mutation", Args, FixtureSeed>("deletionQualificationFixture:seed");
const inspectRef = makeFunctionReference<"query", Args, unknown>("deletionQualificationFixture:inspect");
const request = makeFunctionReference<"mutation", Args, unknown>("accountDeletion:request");
const status = makeFunctionReference<"query", Args, unknown>("accountDeletion:status");
const drain = makeFunctionReference<"mutation", Args, unknown>("accountDeletion:drain");
const cleanup = makeFunctionReference<"mutation", Args, unknown>("maintenance:cleanupExpired");
const current = makeFunctionReference<"query", Args, unknown>("account:current");
const priorMarker = process.env.OOMPA_DELETION_BACKEND_QUALIFICATION;
const priorHmac = process.env.OOMPA_AUTH_HMAC_SECRET;
beforeAll(() => {
  process.env.OOMPA_DELETION_BACKEND_QUALIFICATION = "disposable-v1";
  process.env.OOMPA_AUTH_HMAC_SECRET = "x".repeat(32);
});
afterAll(() => {
  if (priorMarker === undefined) delete process.env.OOMPA_DELETION_BACKEND_QUALIFICATION;
  else process.env.OOMPA_DELETION_BACKEND_QUALIFICATION = priorMarker;
  if (priorHmac === undefined) delete process.env.OOMPA_AUTH_HMAC_SECRET;
  else process.env.OOMPA_AUTH_HMAC_SECRET = priorHmac;
});

describe("deletion backend acceptance fixture", () => {
  test("seeds exact ledgers, proves protected identity, and completes dedicated and inline public deletion", async () => {
    const runtime = convexTest(schema, testModules);
    await runtime.mutation(genesis, {});
    const fixture = await runtime.mutation(seedRef, {});
    expect(fixture).toMatchObject({ schemaVersion: 1, backfill: {
      identityRecordsBefore: 256, identityRecordsAfter: 256, addedNonIdentityRecords: 5,
      exactBytesCharged: true, replayUnchanged: true,
    } });
    expect(await runtime.query(inspectRef, { seed: fixture })).toMatchObject({
      schemaVersion: 1, serviceBalanced: true, witnessUnchanged: true, allOwnedTablesCovered: true,
      dedicated: { phase: "active" }, inline: { phase: "active", identityRecords: 256 }, abandoned: { phase: "active" },
    });
    const inlineActor = runtime.withIdentity({ issuer: "https://fixture.example", subject: `${fixture.inline.userId}|${fixture.inline.authSessionId}`, tokenIdentifier: "fixture-inline" });
    const dedicatedActor = runtime.withIdentity({ issuer: "https://fixture.example", subject: `${fixture.dedicated.userId}|${fixture.dedicated.authSessionId}`, tokenIdentifier: "fixture-dedicated" });
    expect(await inlineActor.query(current, {})).toMatchObject({ authEpoch: 1 });
    expect(await dedicatedActor.query(current, {})).toMatchObject({ authEpoch: 1 });
    await expect(inlineActor.query(current, {})).resolves.toBeDefined();
    await expect(inlineActor.mutation(request, { jobId: fixture.inline.jobId, statusCapability: fixture.inline.statusCapability })).resolves.toMatchObject({ state: "pending" });
    await expect(inlineActor.mutation(request, { jobId: fixture.inline.jobId, statusCapability: fixture.inline.statusCapability })).resolves.toMatchObject({ replay: true });
    await expect(inlineActor.mutation(request, { jobId: `${fixture.inline.jobId}_wrong`, statusCapability: `${fixture.inline.statusCapability}wrong` })).rejects.toThrow();
    await expect(inlineActor.query(current, {})).rejects.toThrow("Cloud authority is not current.");
    let completed = false;
    for (let index = 0; index < 320; index += 1) {
      const result = await runtime.mutation(drain, { limit: 200 }) as { kind?: string };
      if (result.kind === "complete") { completed = true; break; }
    }
    expect(completed).toBeTrue();
    await expect(inlineActor.query(status, { jobId: fixture.inline.jobId, statusCapability: fixture.inline.statusCapability })).resolves.toMatchObject({ state: "complete" });
    await expect(inlineActor.query(status, { jobId: fixture.inline.jobId, statusCapability: fixture.inline.statusCapability })).resolves.toMatchObject({ state: "complete" });
    await expect(inlineActor.query(status, { jobId: fixture.inline.jobId, statusCapability: `${fixture.inline.statusCapability}wrong` })).rejects.toThrow();
    expect(await runtime.query(inspectRef, { seed: fixture })).toMatchObject({ inline: { phase: "complete", ownedRowsRemaining: 0 }, witnessUnchanged: true, serviceBalanced: true });

    await expect(dedicatedActor.mutation(request, { jobId: fixture.dedicated.jobId, statusCapability: fixture.dedicated.statusCapability })).resolves.toMatchObject({ state: "pending" });
    for (let index = 0; index < 20; index += 1) if ((await runtime.mutation(drain, { limit: 200 }) as { kind?: string }).kind === "complete") break;
    await expect(dedicatedActor.query(status, { jobId: fixture.dedicated.jobId, statusCapability: fixture.dedicated.statusCapability })).resolves.toMatchObject({ state: "complete" });
    expect(await runtime.query(inspectRef, { seed: fixture })).toMatchObject({ dedicated: { phase: "complete", ownedRowsRemaining: 0 }, witnessUnchanged: true, serviceBalanced: true });
  }, 30_000);

  test("bounded cleanup retires an aged inline orphan after its account child", async () => {
    const runtime = convexTest(schema, testModules);
    await runtime.mutation(genesis, {});
    const fixture = await runtime.mutation(seedRef, {});
    // Seed's maintenance cursor already targets abandoned identities; invoke
    // the production cleaner repeatedly, never deleting rows directly.
    for (let index = 0; index < 8; index += 1) {
      await runtime.mutation(cleanup, { limit: 200 });
      await runtime.run(async (ctx) => {
        const row = await ctx.db.query("maintenanceState").unique();
        if (row !== null) await ctx.db.patch(row._id, { nextCategory: "abandoned_identities" });
      });
    }
    expect(await runtime.query(inspectRef, { seed: fixture })).toMatchObject({ abandoned: { phase: "complete" }, witnessUnchanged: true, serviceBalanced: true });
  }, 30_000);
});
