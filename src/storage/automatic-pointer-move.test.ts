import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { canonical40QueuesDatabaseBytes } from "../../scripts/fixtures/canonical40-queues";
import { automaticPointerMoveCapsuleDigest, type AutomaticPointerMoveRequest } from "../domain/automatic-pointer-move";
import { codexProviderAccountAuthoritySchema } from "../domain/provider-accounts";
import { createStoredAccountUsageSnapshot } from "../domain/usage-metrics";
import { type ProfileId } from "../domain/values";
import { AUTOMATIC_POINTER_MOVE_SCHEMA_OBJECTS } from "./automatic-pointer-move";
import { initializeStatePaths, resolveStatePaths } from "./paths";
import { StateStore } from "./state-store";

const stores = new Set<StateStore>();
const homes: string[] = [];
afterEach(async () => {
  for (const store of stores) store.close();
  stores.clear();
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

async function fixture(canonical40 = false) {
  const home = await realpath(await mkdtemp(join(tmpdir(), "oompa-pointer-move-")));
  homes.push(home);
  const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
  await initializeStatePaths(paths);
  if (canonical40) {
    await writeFile(paths.database, canonical40QueuesDatabaseBytes());
    await chmod(paths.database, 0o600);
  }
  const historicalSnapshot = () => {
    const db = new Database(paths.database, { strict: true });
    try {
      return { profiles: db.query("SELECT * FROM profiles ORDER BY id").all(),
        migrations: db.query("SELECT * FROM migrations WHERE version<=40 ORDER BY version").all() };
    } finally { db.close(false); }
  };
  const historicalBefore = canonical40 ? historicalSnapshot() : null;
  let time = 1_800_000_000_000;
  const open = (readonly = false) => {
    const store = new StateStore(paths, { readonly, now: () => time, resolveMachineTimeZone: () => "UTC" });
    stores.add(store); return store;
  };
  const store = open();
  const historicalAfter = canonical40 ? historicalSnapshot() : null;
  const bootId = `boot_${"a".repeat(32)}`;
  const daemonGeneration = store.nextDaemonGeneration(bootId);
  const profile = (label: string) => {
    const value = store.nextProfileGeneration(store.createProfile(label).id);
    expect(store.setProfileState(value.id, value.processGeneration, "signed_in", { email: `${label}@example.com`, plan: "Plus" })).toBe(true);
    return store.requireProfile(value.id);
  };
  const source = profile("source");
  const target = profile("target");
  if (canonical40) store.activateProviderAccount({ provider: "codex", providerAccountId: source.id,
    expectedPointerRevision: store.readProviderAccountState("codex").pointerRevision });
  const writeQuota = (profileId: ProfileId, usedPercent: number, credits = 0, observedAt = time) => {
    const authority = store.requireProviderAccountAuthority(profileId, "codex");
    const sourceSequence = (store.latestUsage(profileId)?.sourceRevision ?? 0) + 1;
    const email = store.requireProfile(profileId).providerEmail;
    if (email === undefined) throw new Error("Fixture account email missing");
    const snapshot = createStoredAccountUsageSnapshot({
      accountFingerprint: createHash("sha256").update(email.trim().toLowerCase()).digest("hex"),
      daemonGeneration, providerGeneration: authority.processGeneration, sourceSequence,
      observedAt, receivedAt: observedAt, previousPayload: null,
      providerPayload: {
        usage: { summary: { lifetimeTokens: 1234, peakDailyTokens: null, longestRunningTurnSec: null,
          currentStreakDays: null, longestStreakDays: null }, dailyUsageBuckets: null },
        rateLimits: { primary: { limitId: null, limitName: null, planType: null, rateLimitReachedType: null,
          primary: { usedPercent, windowDurationMins: 10080, resetsAt: Math.floor((time + 3_600_000) / 1000) }, secondary: null },
          byLimitId: null, resetCreditsAvailable: credits },
      },
    });
    store.recordUsage(profileId, sourceSequence, observedAt, snapshot, authority);
  };
  writeQuota(source.id, 99); writeQuota(target.id, 20);
  const request = (): AutomaticPointerMoveRequest => {
    const pointer = store.readProviderAccountState("codex");
    const authority = codexProviderAccountAuthoritySchema.parse(store.requireProviderAccountAuthority(source.id, "codex"));
    const quota = store.latestProviderUsage(authority.providerAccountId)?.quota;
    if (quota === undefined || quota === null) throw new Error("Fixture quota missing");
    return { idempotencyKey: randomUUID(), provider: "codex", daemonGeneration, bootId, expectedSourceAuthority: authority,
      expectedSourceQuotaObservationRevision: quota.observationRevision, expectedSourceQuotaComponentDigest: quota.componentDigest,
      expectedResetPolicyRevision: store.requireAccountRateLimitResetPolicy(source.id).revision,
      expectedAutomaticPolicyRevision: store.readAutomaticUsagePolicyConfiguration().automaticPolicyRevision,
      expectedOrderRevision: pointer.orderRevision, expectedPointerRevision: pointer.pointerRevision };
  };
  const inspect = () => new Database(paths.database, { strict: true });
  return { store, paths, source, target, open, inspect, request, writeQuota, profile, historicalBefore, historicalAfter,
    advanceTime: (ms: number) => { time += ms; } };
}

describe("automatic pointer-only storage", () => {
  test("commits one pointer CAS with quota-only canonical history and no provider/session effect", async () => {
    const value = await fixture();
    const request = value.request();
    const before = value.store.requireProfile(value.source.id);
    const result = value.store.settleAutomaticPointerMove(request);
    expect(result.replayed).toBe(false);
    expect(result.move.target.authority.profileId).toBe(value.target.id);
    expect(result.capsuleDigest).toBe(automaticPointerMoveCapsuleDigest(result.capsule));
    expect(value.store.readProviderAccountState("codex").pointerRevision).toBe(request.expectedPointerRevision + 1);
    expect(value.store.requireProfile(value.source.id)).toEqual(before);
    expect(value.store.settleAutomaticPointerMove(request)).toEqual({ ...result, replayed: true });
    expect(value.open(true).readAutomaticPointerMove(request.idempotencyKey)?.move).toEqual(result.move);
    const db = value.inspect();
    try {
      for (const table of ["sessions", "mutation_effect_evidence", "mutation_provider_authorities", "mutation_resolutions", "account_rate_limit_reset_attempts"]) {
        expect(db.query(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
      }
      const stored = db.query("SELECT capsule_json FROM automatic_pointer_moves").get() as { capsule_json: string };
      expect(stored.capsule_json).not.toContain("lifetimeTokens");
      expect(stored.capsule_json).not.toContain("providerPayload");
    } finally { db.close(false); }
  });

  test.each([false, true])("different keys cannot duplicate the pointer CAS across connections (reverse=%s)", async (reverse) => {
    const value = await fixture();
    const other = value.open();
    const first = value.request(); const second = { ...first, idempotencyKey: randomUUID() };
    const [winner, loser] = reverse ? [other, value.store] : [value.store, other];
    winner.settleAutomaticPointerMove(first);
    expect(() => loser.settleAutomaticPointerMove(second)).toThrow("AUTOMATIC_POINTER_MOVE_CAS_CONFLICT");
    expect(loser.readAutomaticPointerMove(second.idempotencyKey)).toBeNull();
  });

  test.each(["daemon", "boot", "quota", "binding", "order", "policy", "reset"] as const)("refuses a stale %s fence without committing the key", async (field) => {
    const value = await fixture(); const request = value.request();
    if (field === "daemon") request.daemonGeneration++;
    if (field === "boot") request.bootId = `boot_${"b".repeat(32)}`;
    if (field === "quota") value.writeQuota(value.source.id, 99);
    if (field === "binding") request.expectedSourceAuthority.bindingGeneration++;
    if (field === "order") request.expectedOrderRevision++;
    if (field === "policy") request.expectedAutomaticPolicyRevision++;
    if (field === "reset") request.expectedResetPolicyRevision++;
    expect(() => value.store.settleAutomaticPointerMove(request)).toThrow("AUTOMATIC_POINTER_MOVE_CAS_CONFLICT");
    expect(value.store.readAutomaticPointerMove(request.idempotencyKey)).toBeNull();
  });

  test.each(["reset_required", "source_below", "target_stale", "disabled"] as const)("%s is an inert non-admission", async (condition) => {
    const value = await fixture();
    if (condition === "reset_required") value.writeQuota(value.source.id, 99, 1);
    if (condition === "source_below") value.writeQuota(value.source.id, 98);
    if (condition === "target_stale") { value.advanceTime(300_001); value.writeQuota(value.source.id, 99); }
    if (condition === "disabled") value.store.updateAutomaticUsagePolicyConfiguration({ idempotencyKey: randomUUID(), expectedAutomaticPolicyRevision: 1,
      change: { kind: "set_default", enabled: false } });
    const request = value.request();
    expect(() => value.store.settleAutomaticPointerMove(request)).toThrow("AUTOMATIC_POINTER_MOVE_NOT_ADMITTED");
    expect(value.store.readAutomaticPointerMove(request.idempotencyKey)).toBeNull();
  });

  test("a last-step trigger failure rolls back mutation, capsule, anchor and pointer together", async () => {
    const value = await fixture(); const request = value.request(); const db = value.inspect();
    try {
      db.exec("CREATE TRIGGER fail_pointer AFTER UPDATE OF active_provider_account_id ON provider_account_states BEGIN SELECT RAISE(ABORT,'injected_pointer_failure'); END");
      expect(() => value.store.settleAutomaticPointerMove(request)).toThrow("injected_pointer_failure");
      for (const table of ["automatic_pointer_moves", "automatic_pointer_move_anchors", "mutation_attempts"]) {
        expect(db.query(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
      }
      expect(value.store.readProviderAccountState("codex").pointerRevision).toBe(request.expectedPointerRevision);
      db.exec("DROP TRIGGER fail_pointer");
      expect(value.store.settleAutomaticPointerMove(request).replayed).toBe(false);
    } finally { db.close(false); }
  });

  test("the SQL receipt guard rejects null instead of accepting an unknown comparison", async () => {
    const value = await fixture(); const request = value.request(); const db = value.inspect();
    try {
      db.exec(`CREATE TRIGGER inject_null_pointer_receipt AFTER UPDATE OF state ON mutation_attempts
        WHEN NEW.kind='usage.pointer.move' AND NEW.state='effect_started'
        BEGIN UPDATE mutation_attempts SET state='applied',result_json=NULL WHERE id=NEW.id; END`);
      expect(() => value.store.settleAutomaticPointerMove(request)).toThrow("AUTOMATIC_POINTER_MOVE_CLOSED_API_REQUIRED");
      for (const table of ["mutation_attempts", "automatic_pointer_moves", "automatic_pointer_move_anchors"]) {
        expect(db.query(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
      }
      expect(value.store.readProviderAccountState("codex").pointerRevision).toBe(request.expectedPointerRevision);
    } finally { db.close(false); }
  });

  test.each(["automatic_pointer_moves", "automatic_pointer_move_anchors", "mutation_attempts"] as const)("sparse %s deletion refuses hot head and both reopen modes", async (table) => {
    const value = await fixture(); const request = value.request(); value.store.settleAutomaticPointerMove(request);
    const db = value.inspect();
    try {
      db.exec("PRAGMA foreign_keys=OFF");
      const guards = AUTOMATIC_POINTER_MOVE_SCHEMA_OBJECTS.filter((object) => object.type === "trigger" && object.table === table && object.sql.includes("BEFORE DELETE"));
      for (const guard of guards) db.exec(`DROP TRIGGER ${guard.name}`);
      db.query(`DELETE FROM ${table}`).run();
      for (const guard of guards) db.exec(guard.sql);
      expect(() => value.store.readProviderAccountState("codex")).toThrow("AUTOMATIC_POINTER_MOVE_CORRUPT");
      expect(() => value.store.readAutomaticPointerMove(request.idempotencyKey)).toThrow("AUTOMATIC_POINTER_MOVE_CORRUPT");
      for (const readonly of [false, true]) expect(() => value.open(readonly)).toThrow("AUTOMATIC_POINTER_MOVE_CORRUPT");
    } finally { db.close(false); }
  });

  test.each([
    ["source", "intact"], ["target", "intact"], ["source", "missing"], ["target", "missing"],
    ["source", "replaced"], ["target", "replaced"],
  ] as const)("unresolved %s logout blocks even with %s primary sidecar", async (endpoint, corruption) => {
    const value = await fixture(); const request = value.request();
    const profile = value[endpoint];
    const authority = value.store.requireProviderAccountAuthority(profile.id, "codex");
    const workStore = value.store.createWorkStore(request.daemonGeneration, () => "unused-revocation-cursor", {
      issue: () => `hrac1_${"A".repeat(43)}`, verify: () => true,
    });
    for (const runtimeScope of ["personal", "managed"] as const) {
      const begun = value.store.beginProviderRuntimeAccountRevocation({ profileId: profile.id,
        expectedGeneration: authority.processGeneration, provider: "codex", runtimeScope, currentAccountKey: null, workStore });
      value.store.completeProviderRuntimeAccountRevocation({ profileId: profile.id,
        expectedGeneration: authority.processGeneration, provider: "codex", runtimeScope, expectedRevision: begun.revocation.revision });
    }
    const attempt = value.store.prepareMutation({ kind: "account.logout", authorityId: profile.id, authorityGeneration: authority.processGeneration,
      request: {}, providerAuthorities: [{ role: "primary", authority, provenance: "account_logout" }] });
    value.store.beginAccountMutationEffect({ attemptId: attempt.id, profileId: profile.id, profileGeneration: authority.processGeneration,
      providerAuthority: authority, evidence: { kind: "account.logout", baselineSignedIn: true } });
    const db = value.inspect();
    try {
      if (corruption !== "intact") {
        const name = `mutation_provider_authorities_immutable_${corruption === "missing" ? "delete" : "update"}`;
        const guard = db.query("SELECT sql FROM sqlite_master WHERE name=?").get(name) as { sql: string };
        db.exec(`DROP TRIGGER ${name}`);
        if (corruption === "missing") db.query("DELETE FROM mutation_provider_authorities WHERE attempt_id=?").run(attempt.id);
        else db.query("UPDATE mutation_provider_authorities SET process_generation=process_generation+1 WHERE attempt_id=?").run(attempt.id);
        db.exec(guard.sql);
      }
      expect(() => value.store.settleAutomaticPointerMove(request)).toThrow("AUTOMATIC_POINTER_MOVE_NOT_ADMITTED");
      expect(db.query("SELECT COUNT(*) AS count FROM automatic_pointer_moves").get()).toEqual({ count: 0 });
      expect(value.store.readAutomaticPointerMove(request.idempotencyKey)).toBeNull();
    } finally { db.close(false); }
  });

  test("a sibling Claude login does not block the selected Codex pointer", async () => {
    const provider = "claude";
    const value = await fixture(); const request = value.request();
    const authority = value.store.requireProviderAccountAuthority(value.source.id, provider);
    value.store.prepareMutation({ kind: `account.${provider}-login`, authorityId: value.source.id, authorityGeneration: authority.processGeneration,
      request: {}, providerAuthorities: [{ role: "primary", authority, provenance: `account_${provider}_login` }] });
    expect(value.store.settleAutomaticPointerMove(request).move.target.authority.profileId).toBe(value.target.id);
  });

  test("a sibling Devin login does not block the selected Codex pointer", async () => {
    const value = await fixture(); const request = value.request();
    const authority = value.store.requireProviderAccountAuthority(value.source.id, "devin");
    const idempotencyKey = randomUUID();
    expect(value.store.prepareMutation({ kind: "account.devin-login", authorityId: value.source.id,
      authorityGeneration: authority.processGeneration, idempotencyKey, request: {},
      providerAuthorities: [{ role: "primary", authority, provenance: "account_devin_login" }] }))
      .toMatchObject({ state: "prepared", replay: false });
    expect(value.store.readMutation(idempotencyKey)).toMatchObject({ state: "prepared" });
    expect(value.store.settleAutomaticPointerMove(request).move.target.authority.profileId).toBe(value.target.id);
  });

  test.each([["source", false], ["target", false], ["source", true]] as const)("%s reset ownership (settled=%s) refuses without guessing a quota baseline", async (endpoint, settled) => {
    const value = await fixture(); const profile = value[endpoint];
    const authority = value.store.requireProviderAccountAuthority(profile.id, "codex");
    const email = value.store.requireProfile(profile.id).providerEmail;
    if (email === undefined) throw new Error("Missing reset email");
    const accountFingerprint = createHash("sha256").update(email).digest("hex");
    const weeklyWindowResetsAt = 1_800_003_600_000;
    expect(value.store.authorizeAccountRateLimitResetPolicy({ profileId: profile.id, processGeneration: authority.processGeneration,
      accountFingerprint, weeklyWindowDurationMinutes: 10080, weeklyWindowResetsAt }).decision).toBe("allow");
    const reset = value.store.prepareAccountRateLimitReset({ profileId: profile.id, processGeneration: authority.processGeneration,
      accountFingerprint, weeklyWindowResetsAt, observedUsedPercent: 99 });
    if (settled) {
      value.store.beginAccountRateLimitReset(reset.idempotencyKey, authority);
      value.store.settleAccountRateLimitReset(reset.idempotencyKey, "noCredit");
    }
    const request = value.request();
    expect(() => value.store.settleAutomaticPointerMove(request)).toThrow("AUTOMATIC_POINTER_MOVE_NOT_ADMITTED");
    expect(value.store.readAutomaticPointerMove(request.idempotencyKey)).toBeNull();
  });

  test("upgrades authentic canonical40 additively and refuses a missing current-format guard before repair", async () => {
    const value = await fixture(true); const db = value.inspect();
    try {
      expect(value.historicalBefore).not.toBeNull();
      expect(value.historicalAfter).toEqual(value.historicalBefore);
      expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 61 });
      expect(db.query("SELECT version FROM migrations WHERE version>40 ORDER BY version").all())
        .toEqual(Array.from({ length: 21 }, (_, index) => ({ version: index + 41 })));
      value.store.settleAutomaticPointerMove(value.request());
      db.exec("DROP TRIGGER automatic_pointer_move_anchor_insert_guard");
      const snapshot = () => ({ schema: db.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all(),
        migrations: db.query("SELECT * FROM migrations ORDER BY version").all(), profiles: db.query("SELECT * FROM profiles ORDER BY id").all(),
        moves: db.query("SELECT * FROM automatic_pointer_moves ORDER BY attempt_id").all(),
        anchors: db.query("SELECT * FROM automatic_pointer_move_anchors ORDER BY attempt_id").all(),
        mutations: db.query("SELECT * FROM mutation_attempts ORDER BY id").all() });
      const before = snapshot();
      for (const readonly of [false, true]) expect(() => value.open(readonly)).toThrow("AUTOMATIC_POINTER_MOVE_CORRUPT");
      expect(snapshot()).toEqual(before);
      expect(db.query("SELECT 1 FROM sqlite_master WHERE name='automatic_pointer_move_anchor_insert_guard'").get()).toBeNull();
    } finally { db.close(false); }
  });

  test("hot anchored digest tampering refuses even an empty lineage read", async () => {
    const value = await fixture(); const request = value.request(); value.store.settleAutomaticPointerMove(request);
    const db = value.inspect();
    try {
      const guard = AUTOMATIC_POINTER_MOVE_SCHEMA_OBJECTS.find((object) => object.name === "automatic_pointer_move_anchors_immutable_update");
      if (guard === undefined) throw new Error("Missing anchor guard");
      db.exec(`DROP TRIGGER ${guard.name}`);
      db.exec("UPDATE automatic_pointer_move_anchors SET capsule_digest=printf('%064d',0)");
      db.exec(guard.sql);
      expect(() => value.store.readProviderAccountState("codex")).toThrow("AUTOMATIC_POINTER_MOVE_CORRUPT");
      expect(() => value.store.readAutomaticPointerMoveLineage({ fromPointerRevision: request.expectedPointerRevision + 1,
        throughPointerRevision: request.expectedPointerRevision + 1 })).toThrow("AUTOMATIC_POINTER_MOVE_CORRUPT");
    } finally { db.close(false); }
  });
});
