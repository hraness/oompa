import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";

import { hmacSha256Hex } from "../cloud/crypto";
import { deriveUsageSourcePublicIdV2, type UsageHeadContextV2 } from "../cloud/usage-context-v2";
import { decryptUsageHeadV2, encryptUsageHeadV2 } from "../cloud/usage-envelope-v2";
import { parseUsageHeadV2 } from "../cloud/usage-head-v2";
import { projectUsageHeadV2 } from "../cloud/usage-projector-v2";
import { createClaudeAccountingUsageComponent, createClaudeQuotaUsageComponent,
  providerUsageDigest, usageProviderAccountAuthoritySchema } from "../domain/provider-usage";
import { effectiveClaudeRuntimeProfileSchema } from "../domain/runtime-profile";
import { createStoredAccountUsageSnapshot } from "../domain/usage-metrics";
import { initializeStatePaths, resolveStatePaths } from "./paths";
import { PROVIDER_USAGE_RESET_FACT_CANDIDATE_LIMIT, StateStore } from "./state-store";

const now = 1_800_000_000_000;
const email = "Facts@Example.com";
const fingerprint = createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
const roots: string[] = [];
const stores: StateStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "oompa-usage-source-facts-")));
  roots.push(root);
  const paths = resolveStatePaths({ homeDirectory: root, platform: "linux" });
  await initializeStatePaths(paths);
  const open = (readonly = false) => {
    const store = new StateStore(paths, { readonly, now: () => now, resolveMachineTimeZone: () => "UTC" });
    stores.push(store);
    return store;
  };
  const store = open();
  const profile = store.nextProfileGeneration(store.createProfile("Facts source").id);
  expect(store.setProfileState(profile.id, profile.processGeneration, "signed_in", { email, plan: "Plus" })).toBe(true);
  const input = (provider: "codex" | "claude") => ({ provider,
    providerAccountId: store.requireProviderAccountForProfile(profile.id, provider).id });
  const read = (provider: "codex" | "claude", reader = store) => {
    const value = reader.readProviderUsageSourceFacts(input(provider));
    if (value.state !== "cached") throw new Error("Expected cached fixture facts.");
    return value;
  };
  const sql = <T>(run: (database: Database) => T): T => {
    const database = new Database(paths.database, { strict: true });
    try { return run(database); } finally { database.close(false); }
  };
  // Damage only this disposable fixture, restoring all exact trigger bytes
  // before reading. This is neither a production writer nor migration proof.
  const corrupt = (run: (database: Database) => void) => sql((database) => {
    database.exec("PRAGMA foreign_keys=OFF");
    database.exec("PRAGMA ignore_check_constraints=ON");
    const triggers = database.query<{ name: string; sql: string }, []>(
      "SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name").all();
    database.transaction(() => {
      for (const trigger of triggers) database.exec(`DROP TRIGGER "${trigger.name.replaceAll('"', '""')}"`);
      run(database);
      for (const trigger of triggers) database.exec(trigger.sql);
    }).immediate();
    expect(database.query("SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name").all()).toEqual(triggers);
  });
  const snapshot = () => sql((database) => {
    const rows = database.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
    const hash = createHash("sha256");
    for (const { name } of rows) hash.update(name).update(JSON.stringify(database.query(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all()));
    return { hash: hash.digest("hex"), schema: database.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all() };
  });
  const recordCodex = (options: { credits?: number; identity?: string; used?: number; writer?: StateStore } = {}) => {
    const writer = options.writer ?? store;
    const sequence = writer.allocateNextUsageRevision(profile.id);
    const observedAt = now + sequence;
    const limit = { limitId: "codex", limitName: null, planType: "Plus", rateLimitReachedType: null,
      primary: { usedPercent: options.used ?? 25, windowDurationMins: 60, resetsAt: now / 1_000 + 3600 }, secondary: null };
    const payload = createStoredAccountUsageSnapshot({ sourceSequence: sequence, observedAt, receivedAt: observedAt + 1,
      accountFingerprint: options.identity ?? fingerprint, providerGeneration: profile.processGeneration,
      daemonGeneration: 1, previousPayload: null,
      providerPayload: { usage: { summary: { lifetimeTokens: 20, peakDailyTokens: 20, longestRunningTurnSec: null,
        currentStreakDays: null, longestStreakDays: null }, dailyUsageBuckets: [] },
      rateLimits: { primary: limit, byLimitId: { codex: limit }, resetCreditsAvailable: options.credits ?? 0 } } });
    writer.recordUsage(profile.id, sequence, observedAt, payload, writer.requireProviderAccountAuthority(profile.id, "codex"));
    return { sequence, payload };
  };
  const prepareReset = (weeklyWindowResetsAt = now + 7 * 24 * 60 * 60_000) => {
    expect(store.authorizeAccountRateLimitResetPolicy({ profileId: profile.id,
      processGeneration: profile.processGeneration, accountFingerprint: fingerprint,
      weeklyWindowDurationMinutes: 10080, weeklyWindowResetsAt }).decision).toBe("allow");
    return store.prepareAccountRateLimitReset({ profileId: profile.id, processGeneration: profile.processGeneration,
      accountFingerprint: fingerprint, weeklyWindowResetsAt, observedUsedPercent: 99 });
  };
  return { store, profile, paths, open, input, read, sql, corrupt, snapshot, recordCodex, prepareReset };
}

function expectFrozen(value: unknown): void {
  if (typeof value !== "object" || value === null) return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) expectFrozen(child);
}

function bindClaudeTurn(value: Awaited<ReturnType<typeof fixture>>) {
  const { store, profile } = value;
  const bootId = `boot_${randomUUID().replaceAll("-", "")}`;
  const daemon = { bootId, daemonGeneration: store.nextDaemonGeneration(bootId) };
  store.advanceProviderAccountProcessGeneration({ profileId: profile.id, provider: "claude", expectedProcessGeneration: 0 });
  const authority = usageProviderAccountAuthoritySchema.parse(store.requireProviderAccountAuthority(profile.id, "claude"));
  const created = store.createSession({ profileId: profile.id, provider: "claude", preset: "fable-max", fastEnabled: false });
  const session = store.bindSession({ sessionId: created.id, expectedRevision: created.revision,
    providerThreadId: "facts-thread", providerUpdatedAt: now, state: "idle" });
  const runtimeProfile = effectiveClaudeRuntimeProfileSchema.parse({ profileId: profile.id,
    processGeneration: authority.processGeneration, observedAt: now, preset: "fable-max", model: "claude-fable-5-1",
    reasoningEffort: "max", claudeVersion: "2.1.260", inputFormat: "stream-json", outputFormat: "stream-json",
    permissionMode: "default", isolatedConfigDir: true,
    nativeFallback: { model: "claude-opus-5", reason: "live_acceptance_required", status: "unavailable" } });
  const message = "Observe fixture usage";
  const { attempt } = store.prepareSessionInputMutation({ ...daemon, sessionId: session.id,
    idempotencyKey: randomUUID(), kind: "session.send", providerAuthority: authority, message, attachments: [] });
  const providerConnectionId = "10000000-0000-4000-8000-000000000231";
  store.beginSessionMutationEffect({ ...daemon, attachments: [], attemptId: attempt.id, message,
    transcript: { accountId: profile.id, providerGeneration: authority.processGeneration, providerConnectionId, actor: "human", message },
    evidence: { baseline: { activeTurnId: null, providerUpdatedAt: now, status: "idle" }, clientMessageId: attempt.id,
      kind: "session.send", messageDigest: createHash("sha256").update(message).digest("hex"), providerThreadId: "facts-thread", runtimeProfile },
    profileGeneration: authority.processGeneration, providerAuthority: authority, sessionId: session.id });
  const turnId = "facts-turn";
  store.completeSessionTurnEffect({ applyResponseState: false, attemptId: attempt.id, accountId: profile.id,
    providerGeneration: authority.processGeneration, providerConnectionId, message, expectedSessionRevision: session.revision,
    providerAuthority: authority, receipt: { turnId }, runtimeProfile, sessionId: session.id, turnId, turnStatus: "completed" });
  const base = (revision: number) => ({ authority, sessionId: session.id, turnId,
    observedAt: now + revision, receivedAt: now + revision, observationRevision: revision,
    sourceEventDigest: providerUsageDigest({ revision }),
    sourceEventId: `10000000-0000-4000-8000-${revision.toString(16).padStart(12, "0")}` });
  const quota = (revision: number) => createClaudeQuotaUsageComponent({ ...base(revision), quota: {
    status: { state: "known", value: "allowed" }, rateLimitType: "five_hour", resetsAtMs: now + 10000,
    overageStatus: null, overageDisabledReason: null, isUsingOverage: null,
    windows: [{ id: "five_hour", scope: "account", usedPercent: 25, resetsAtMs: now + 10000 }] } });
  const accounting = (revision: number) => createClaudeAccountingUsageComponent({ ...base(revision), accounting: {
    totalCostUsd: null, inputTokens: 2, cacheReadInputTokens: 1, cacheCreationInputTokens: null,
    outputTokens: 3, thinkingTokens: null, models: [] } });
  return { authority, session, quota, accounting };
}

describe("coherent private provider usage facts", () => {
  test("captures detached frozen observed facts without writes, including readonly reopen", async () => {
    const f = await fixture();
    f.recordCodex({ credits: 2 });
    const before = f.snapshot();
    const result = f.read("codex");
    expect(result.quota).toMatchObject({ state: "observed", data: { resetCreditsAvailable: 2 },
      provenance: { observedAt: now + 1, receivedAt: now + 2 } });
    expect(result.accounting).toEqual({ state: "unavailable", reason: "not_projected" });
    expect(result.reset).toMatchObject({ currentIdentity: { state: "known", lastAttempt: null }, pending: { state: "none" } });
    expectFrozen(result);
    expect(f.read("codex", f.open(true))).toEqual(result);
    expect(f.read("codex")).not.toBe(result);
    expect(f.snapshot()).toEqual(before);
  });

  test("preserves future component clocks and does not label collapsed zero credits observed", async () => {
    const f = await fixture();
    f.recordCodex();
    expect(f.read("codex").quota).toMatchObject({ state: "observed", data: { resetCreditsAvailable: null },
      provenance: { observedAt: now + 1, receivedAt: now + 2 } });
  });

  test.each(["digest", "sidecar", "identity", "authority", "bytes"] as const)(
    "refuses newest Codex %s damage without falling back", async (damage) => {
      const f = await fixture();
      f.recordCodex({ used: 1 });
      const latest = f.recordCodex({ used: 99, ...(damage === "identity" ? { identity: "a".repeat(64) } : {}) });
      if (damage !== "identity") f.corrupt((db) => {
        if (damage === "digest") db.query("UPDATE usage_snapshots SET digest=? WHERE profile_id=? AND source_revision=?")
          .run("f".repeat(64), f.profile.id, latest.sequence);
        if (damage === "sidecar") db.query("DELETE FROM account_scoped_provider_authorities WHERE scope_kind='usage_snapshot' AND scope_id=?")
          .run(`${f.profile.id}:${latest.sequence}`);
        if (damage === "authority") db.query("UPDATE account_scoped_provider_authorities SET binding_generation=binding_generation+1 WHERE scope_kind='usage_snapshot' AND scope_id=?")
          .run(`${f.profile.id}:${latest.sequence}`);
        if (damage === "bytes") db.query("UPDATE usage_snapshots SET payload_json=? WHERE profile_id=? AND source_revision=?")
          .run('"' + "x".repeat(262_144) + '"', f.profile.id, latest.sequence);
      });
      const before = f.snapshot();
      expect(f.read("codex").quota).toMatchObject({ state: "unavailable" });
      expect(f.snapshot()).toEqual(before);
    },
  );

  test("does not upgrade compatible historical Codex sidecars to current facts", async () => {
    const f = await fixture();
    const row = f.recordCodex();
    f.corrupt((db) => db.query("UPDATE account_scoped_provider_authorities SET process_generation=NULL,provenance='legacy_codex_compatibility' WHERE scope_kind='usage_snapshot' AND scope_id=?")
      .run(`${f.profile.id}:${row.sequence}`));
    expect(f.read("codex").quota).toEqual({ state: "unavailable", reason: "authority_mismatch" });
  });

  test.each(["provider_account_id", "provenance", "profile_id"] as const)(
    "oversized Codex sidecar %s is refused before the existing authority reader", async (column) => {
      const f = await fixture();
      const row = f.recordCodex();
      f.corrupt((db) => db.query(`UPDATE account_scoped_provider_authorities SET ${column}=? WHERE scope_kind='usage_snapshot' AND scope_id=?`)
        .run("x".repeat(1_048_576), `${f.profile.id}:${row.sequence}`));
      let authorityRead = false;
      f.store.readCodexUsageAuthorityMetadata = () => { authorityRead = true; throw new Error("Oversized sidecar crossed preflight."); };
      const before = f.snapshot();
      expect(f.read("codex").quota).toEqual({ state: "unavailable", reason: "snapshot_conflict" });
      expect(authorityRead).toBe(false);
      expect(f.snapshot()).toEqual(before);
    },
  );

  test("independently captures newest Claude quota and terminal accounting clocks", async () => {
    const f = await fixture(); const turn = bindClaudeTurn(f);
    f.store.recordProviderUsageObservation(turn.quota(1));
    f.store.recordProviderUsageObservation(turn.accounting(3));
    const before = f.snapshot();
    const result = f.read("claude");
    expect(result.quota).toMatchObject({ state: "observed", provenance: { observedAt: now + 1, receivedAt: now + 1 } });
    expect(result.accounting).toMatchObject({ state: "observed", data: { totalCostUsd: null, inputTokens: 2 },
      provenance: { observedAt: now + 3, receivedAt: now + 3, turn: { turnId: "facts-turn" } } });
    expect(result.reset).toEqual({ state: "unavailable", reason: "provider_unsupported" });
    expectFrozen(result);
    expect(f.snapshot()).toEqual(before);
  });

  test.each(["missing component", "receipt mismatch", "receipt turn", "bytes"] as const)(
    "Claude %s refuses the selected quota while preserving accounting", async (damage) => {
      const f = await fixture(); const turn = bindClaudeTurn(f);
      f.store.recordProviderUsageObservation(turn.quota(1));
      const newest = turn.quota(2);
      f.store.recordProviderUsageObservation(newest);
      f.store.recordProviderUsageObservation(turn.accounting(3));
      f.corrupt((db) => {
        if (damage === "missing component") db.query("DELETE FROM provider_usage_observation_components WHERE idempotency_key=?").run(newest.idempotencyKey);
        if (damage === "receipt mismatch") db.query("UPDATE provider_usage_observation_receipts SET received_at=received_at+1 WHERE idempotency_key=?").run(newest.idempotencyKey);
        if (damage === "receipt turn") db.query("UPDATE provider_usage_observation_receipts SET session_id=? WHERE idempotency_key=?").run("sess_wrong", newest.idempotencyKey);
        if (damage === "bytes") db.query("UPDATE provider_usage_observation_components SET component_json=? WHERE idempotency_key=?")
          .run('"' + "x".repeat(262_144) + '"', newest.idempotencyKey);
      });
      const before = f.snapshot();
      expect(f.read("claude").quota).toMatchObject({ state: "unavailable" });
      expect(f.read("claude").accounting).toMatchObject({ state: "observed", provenance: { observedAt: now + 3 } });
      expect(f.snapshot()).toEqual(before);
    },
  );

  test("missing immutable Claude turn authority invalidates both selected components", async () => {
    const f = await fixture(); const turn = bindClaudeTurn(f);
    f.store.recordProviderUsageObservation(turn.quota(1));
    f.store.recordProviderUsageObservation(turn.accounting(2));
    f.corrupt((db) => db.query("DELETE FROM runtime_profile_provider_authorities WHERE session_id=?").run(turn.session.id));
    const before = f.snapshot();
    expect(f.read("claude")).toMatchObject({ metadata: { source: { state: "cached" } },
      quota: { state: "unavailable", reason: "snapshot_conflict" },
      accounting: { state: "unavailable", reason: "snapshot_conflict" } });
    expect(f.snapshot()).toEqual(before);
  });

  test.each(["provider_account_id", "profile_id", "provider"] as const)(
    "oversized Claude turn authority %s invalidates both selected components", async (column) => {
      const f = await fixture(); const turn = bindClaudeTurn(f);
      f.store.recordProviderUsageObservation(turn.quota(1));
      f.store.recordProviderUsageObservation(turn.accounting(2));
      f.corrupt((db) => db.query(`UPDATE runtime_profile_provider_authorities SET ${column}=? WHERE session_id=?`)
        .run("x".repeat(1_048_576), turn.session.id));
      const before = f.snapshot();
      expect(f.read("claude")).toMatchObject({ metadata: { source: { state: "cached" } },
        quota: { state: "unavailable", reason: "snapshot_conflict" },
        accounting: { state: "unavailable", reason: "snapshot_conflict" } });
      expect(f.snapshot()).toEqual(before);
    },
  );

  test("Claude current authority never comes from sibling Codex generations", async () => {
    const f = await fixture(); const turn = bindClaudeTurn(f);
    f.store.recordProviderUsageObservation(turn.quota(1));
    f.corrupt((db) => db.query("UPDATE profiles SET process_generation=process_generation+1 WHERE id=?").run(f.profile.id));
    expect(f.read("claude").quota).toMatchObject({ state: "observed" });
    f.store.advanceProviderAccountProcessGeneration({ profileId: f.profile.id, provider: "claude", expectedProcessGeneration: turn.authority.processGeneration });
    expect(f.read("claude").quota).toEqual({ state: "unavailable", reason: "authority_mismatch" });
  });

  test.each(["identity", "mirror", "policy"] as const)("retained reset recovery survives unavailable %s", async (damage) => {
    const f = await fixture(); const attempt = f.prepareReset();
    f.corrupt((db) => {
      if (damage === "identity") {
        db.query("UPDATE profiles SET provider_email=NULL WHERE id=?").run(f.profile.id);
        db.query("UPDATE provider_accounts SET provider_email=NULL WHERE id=?").run(f.profile.id);
      } else if (damage === "mirror") db.query("UPDATE profiles SET process_generation=process_generation+1 WHERE id=?").run(f.profile.id);
      else db.query("DELETE FROM account_rate_limit_reset_policies WHERE profile_id=?").run(f.profile.id);
    });
    const before = f.snapshot();
    expect(f.read("codex").reset).toMatchObject({ currentIdentity: { state: "unavailable" },
      pending: { state: "retained", attempt, identityRelation: damage === "policy" ? "current" : "unavailable" } });
    expect(f.snapshot()).toEqual(before);
  });

  test("retained reset under another identity never becomes current-identity history", async () => {
    const f = await fixture(); const attempt = f.prepareReset();
    f.corrupt((db) => {
      db.query("UPDATE profiles SET provider_email='replacement@example.com' WHERE id=?").run(f.profile.id);
      db.query("UPDATE provider_accounts SET provider_email='replacement@example.com' WHERE id=?").run(f.profile.id);
    });
    expect(f.read("codex").reset).toMatchObject({ currentIdentity: { state: "known", lastAttempt: null },
      pending: { state: "retained", attempt, identityRelation: "different" } });
  });

  test.each([false, true])("reset generation requires its complete retained rebind chain (missing=%s)", async (missing) => {
    const f = await fixture(); const attempt = f.prepareReset();
    const next = f.store.nextProfileGeneration(f.profile.id);
    const rebound = f.store.rebindAccountRateLimitReset({ idempotencyKey: attempt.idempotencyKey,
      expectedCurrentProcessGeneration: attempt.currentProcessGeneration, nextProcessGeneration: next.processGeneration,
      accountFingerprint: fingerprint });
    if (missing) f.corrupt((db) => db.query("DELETE FROM account_rate_limit_reset_rebinds WHERE idempotency_key=?").run(attempt.idempotencyKey));
    const before = f.snapshot();
    expect(f.read("codex").reset).toMatchObject({ pending: missing
      ? { state: "unavailable", reason: "snapshot_conflict" }
      : { state: "retained", attempt: rebound, identityRelation: "current" } });
    expect(f.snapshot()).toEqual(before);
  });

  test.each([false, true])("ambiguous reset recovery selects newest retained policy authority (damaged=%s)", async (damaged) => {
    const f = await fixture(); const attempt = f.prepareReset(now + 86_400_000);
    const authority = f.store.requireProviderAccountAuthority(f.profile.id, "codex");
    f.store.beginAccountRateLimitReset(attempt.idempotencyKey, authority);
    f.store.deferAccountRateLimitReset(attempt.idempotencyKey, "ambiguous");
    expect(f.store.authorizeAccountRateLimitResetPolicy({ profileId: f.profile.id,
      processGeneration: f.profile.processGeneration, accountFingerprint: fingerprint,
      weeklyWindowDurationMinutes: 10080, weeklyWindowResetsAt: now + 2 * 86_400_000 }).decision).toBe("allow");
    const resumed = f.store.beginAccountRateLimitReset(attempt.idempotencyKey, authority);
    if (damaged) f.corrupt((db) => db.query(`UPDATE account_rate_limit_reset_provider_authorities SET provenance='broken'
      WHERE idempotency_key=? AND policy_revision=(SELECT MAX(policy_revision) FROM account_rate_limit_reset_provider_authorities WHERE idempotency_key=?)`)
      .run(attempt.idempotencyKey, attempt.idempotencyKey));
    const before = f.snapshot();
    expect(f.read("codex").reset).toMatchObject({ pending: damaged
      ? { state: "unavailable", reason: "snapshot_conflict" }
      : { state: "retained", attempt: resumed, identityRelation: "current" } });
    expect(resumed.weeklyWindowResetsAt).toBe(attempt.weeklyWindowResetsAt);
    expect(f.snapshot()).toEqual(before);
  });

  test("multiple separately attributed pending reset identities remain unavailable", async () => {
    const f = await fixture(); const attempt = f.prepareReset();
    const otherKey = randomUUID(); const otherFingerprint = "b".repeat(64);
    f.corrupt((db) => {
      db.query(`INSERT INTO account_rate_limit_reset_attempts
        SELECT attempt_sequence+1,?,profile_id,origin_process_generation,current_process_generation,?,
          weekly_window_resets_at,observed_used_percent,state,outcome,local_resolution,created_at,updated_at
        FROM account_rate_limit_reset_attempts WHERE idempotency_key=?`).run(otherKey, otherFingerprint, attempt.idempotencyKey);
      db.query(`INSERT INTO account_scoped_provider_authorities
        SELECT scope_kind,?,provider_account_id,profile_id,provider,binding_generation,process_generation,provenance,recorded_at
        FROM account_scoped_provider_authorities WHERE scope_kind='reset_attempt' AND scope_id=?`)
        .run(`${f.profile.id}:${attempt.attemptSequence + 1}`, `${f.profile.id}:${attempt.attemptSequence}`);
      db.query(`INSERT INTO account_rate_limit_reset_provider_authorities
        SELECT ?,process_generation,provider_account_id,profile_id,provider,binding_generation,policy_revision,?,
          policy_weekly_window_resets_at,provenance,recorded_at
        FROM account_rate_limit_reset_provider_authorities WHERE idempotency_key=?`).run(otherKey, otherFingerprint, attempt.idempotencyKey);
    });
    const before = f.snapshot();
    expect(f.read("codex").reset).toMatchObject({ pending: { state: "unavailable", reason: "snapshot_conflict" } });
    expect(f.snapshot()).toEqual(before);
  });

  test.each(["missing authority", "invalid state", "overflow"] as const)("reset %s never reports none", async (damage) => {
    const f = await fixture(); const attempt = f.prepareReset();
    f.corrupt((db) => {
      if (damage === "missing authority") db.query("DELETE FROM account_rate_limit_reset_provider_authorities WHERE idempotency_key=?").run(attempt.idempotencyKey);
      else if (damage === "invalid state") db.query("UPDATE account_rate_limit_reset_attempts SET state='broken' WHERE idempotency_key=?").run(attempt.idempotencyKey);
      else for (let index = 1; index <= PROVIDER_USAGE_RESET_FACT_CANDIDATE_LIMIT; index++) {
        db.query(`INSERT INTO account_rate_limit_reset_attempts
          SELECT attempt_sequence+?, ?,profile_id,origin_process_generation,current_process_generation,?,
            weekly_window_resets_at,observed_used_percent,state,outcome,local_resolution,created_at,updated_at
          FROM account_rate_limit_reset_attempts WHERE idempotency_key=?`)
          .run(index, randomUUID(), index.toString(16).padStart(64, "0"), attempt.idempotencyKey);
      }
    });
    const before = f.snapshot();
    expect(f.read("codex").reset).toMatchObject({ pending: { state: "unavailable", reason: damage === "overflow" ? "representation_limit" : "snapshot_conflict" } });
    expect(f.snapshot()).toEqual(before);
  });

  test("metadata and quota remain on one snapshot across an independent writer commit", async () => {
    const f = await fixture(); f.recordCodex({ used: 25 });
    const writer = f.open();
    const metadata = f.store.readProviderUsageSourceMetadata.bind(f.store);
    let interleaved = false;
    f.store.readProviderUsageSourceMetadata = (input) => {
      const result = metadata(input);
      if (!interleaved) { interleaved = true; f.recordCodex({ used: 99, writer }); }
      return result;
    };
    expect(f.read("codex").quota).toMatchObject({ state: "observed", data: { limits: [{ primary: { usedPercent: 25 } }, { primary: { usedPercent: 25 } }] } });
    expect(interleaved).toBe(true);
    expect(f.read("codex").quota).toMatchObject({ state: "observed", data: { limits: [{ primary: { usedPercent: 99 } }, { primary: { usedPercent: 99 } }] } });
  });

  test("bounded fact selectors consume index order without materializing a temporary sort", async () => {
    const f = await fixture(); const claude = await fixture(); const turn = bindClaudeTurn(claude);
    f.recordCodex(); f.prepareReset();
    claude.store.recordProviderUsageObservation(turn.quota(1));
    claude.store.recordProviderUsageObservation(turn.accounting(2));
    const tables = ["usage_snapshots", "provider_usage_observation_receipts", "account_rate_limit_reset_attempts",
      "account_rate_limit_reset_provider_authorities", "account_rate_limit_reset_rebinds"];
    const query = spyOn(Database.prototype, "query");
    let statements: string[];
    try {
      expect(f.read("codex").quota.state).toBe("observed");
      expect(claude.read("claude").accounting.state).toBe("observed");
      statements = [...new Set(query.mock.calls.map(([sql]) => sql))];
    } finally { query.mockRestore(); }
    f.sql((db) => {
      for (const table of tables) {
        const matches = statements.filter((sql) => new RegExp(`FROM ${table}\\b`).test(sql) && sql.includes("ORDER BY") && sql.includes("LIMIT"));
        expect(matches).toHaveLength(1);
        const statement = matches[0] as string;
        const plan = db.query<{ detail: string }, null[]>(`EXPLAIN QUERY PLAN ${statement}`)
          .all(...Array<null>(statement.split("?").length - 1).fill(null)).map(({ detail }) => detail).join("\n");
        expect(plan).toContain("SEARCH");
        expect(plan).not.toContain("TEMP B-TREE");
      }
    });
  });

  test("invalid requests are total and cannot invoke nested readers", async () => {
    const f = await fixture();
    f.store.readProviderUsageSourceMetadata = () => { throw new Error("must not read metadata"); };
    for (const input of [null, undefined, {}, { ...f.input("codex"), extra: true }, { provider: "devin", providerAccountId: f.profile.id }]) {
      expect(f.store.readProviderUsageSourceFacts(input)).toEqual({ state: "unavailable", reason: "snapshot_conflict" });
    }
  });
});

// Composition deliberately uses the real reader and its durable fixtures.
// Synthetic account keys and expected contexts grant no publication authority.
const projectionKey = () => new Uint8Array(32).fill(71);
async function projectionContext(f: Awaited<ReturnType<typeof fixture>>, provider: "codex" | "claude",
  key = projectionKey()): Promise<UsageHeadContextV2> {
  const source = { apiOrigin: "https://example.com", userPublicId: "user_12345678",
    sourceDevicePublicId: "device_12345678", provider, localProviderAccountId: f.input(provider).providerAccountId, keyVersion: 1 };
  return { apiOrigin: source.apiOrigin, userPublicId: source.userPublicId, sourceDevicePublicId: source.sourceDevicePublicId,
    provider, sourcePublicId: await deriveUsageSourcePublicIdV2(key, source), sourceRevision: 1, keyVersion: 1 };
}
async function project(f: Awaited<ReturnType<typeof fixture>>, provider: "codex" | "claude") {
  const context = await projectionContext(f, provider);
  const before = f.snapshot();
  const facts = f.read(provider);
  const head = await projectUsageHeadV2(facts, projectionKey(), context, f.input(provider).providerAccountId);
  expect(head).not.toBeNull();
  if (head === null) throw new Error("Expected fixture head.");
  expect(parseUsageHeadV2(head, context)).toEqual(head);
  expectFrozen(head);
  expect(f.snapshot()).toEqual(before);
  const json = JSON.stringify(head);
  for (const secret of [email, fingerprint, f.profile.id, f.paths.root, "facts-thread", "facts-turn",
    f.input("claude").providerAccountId, "providerAccountId", "profileId", "accountFingerprint", "idempotencyKey",
    "bindingGeneration", "processGeneration", "sourceEventDigest", "componentDigest", "observationRevision", "limitName", "planType"]) {
    expect(json).not.toContain(secret);
  }
  return { head, context, facts };
}

describe("private reader to standalone V2 head", () => {
  test("Codex preserves clocks and nullable credits, derives the legacy grouping preimage and encrypts canonical output", async () => {
    const f = await fixture(); f.recordCodex({ credits: 2 });
    const { head, context } = await project(f, "codex");
    expect(head.codexAccountMatchPublicId).toBe(`codex_${(await hmacSha256Hex(projectionKey(), "codex-account-match", "facts@example.com")).slice(0, 48)}`);
    expect(head.components.quota).toMatchObject({ state: "observed", source: "codex_app_server",
      observedAt: now + 1, receivedAt: now + 2, data: { resetCreditsAvailable: 2,
        limits: [{ id: "legacy:primary", secondary: null }, { id: "limit:codex", secondary: null }] } });
    expect(head.display.nextAction).toEqual({ state: "unavailable", reason: "runtime_not_integrated" });
    const encrypted = await encryptUsageHeadV2(head, projectionKey(), context);
    expect(await decryptUsageHeadV2(encrypted, projectionKey(), context)).toEqual(head);
    const facts = f.read("codex");
    if (facts.quota.state !== "observed") throw new Error("Expected quota.");
    const directZero = await projectUsageHeadV2({ ...facts, quota: { ...facts.quota,
      data: { ...facts.quota.data, resetCreditsAvailable: 0 } } }, projectionKey(), context, f.profile.id);
    expect(directZero?.components.quota).toMatchObject({ data: { resetCreditsAvailable: null } });
    f.recordCodex();
    expect((await project(f, "codex")).head.components.quota).toMatchObject({ data: { resetCreditsAvailable: null } });
  });

  test("an unseen source remains unknown; future and zero readiness clocks are copied without freshness claims", async () => {
    const f = await fixture();
    expect((await project(f, "codex")).head.components.quota).toEqual({ state: "unavailable", reason: "not_observed" });
    const facts = f.read("codex"); const context = await projectionContext(f, "codex");
    if (facts.metadata.source.state !== "cached") throw new Error("Expected source.");
    for (const observedAt of [null, 0, now + 9_000_000]) {
      const input = { ...facts, metadata: { ...facts.metadata, source: { ...facts.metadata.source, readinessObservedAt: observedAt } } };
      const head = await projectUsageHeadV2(input, projectionKey(), context, f.profile.id);
      expect(head?.components.readiness).toEqual({ state: "cached", value: "signed_in", observedAt });
    }
  });

  test("Claude quota and last-result accounting retain independent clocks and round-trip without Codex grouping", async () => {
    const f = await fixture(); const turn = bindClaudeTurn(f);
    f.store.recordProviderUsageObservation(turn.quota(1));
    f.store.recordProviderUsageObservation(turn.accounting(2));
    f.store.recordProviderUsageObservation(turn.quota(3));
    const { head, context } = await project(f, "claude");
    expect(head.codexAccountMatchPublicId).toBeNull();
    expect(head.components.quota).toMatchObject({ state: "observed", source: "claude_rate_limit_event", observedAt: now + 3, receivedAt: now + 3 });
    expect(head.components.accounting).toMatchObject({ state: "observed", source: "claude_result", observedAt: now + 2, receivedAt: now + 2,
      data: { inputTokens: 2, outputTokens: 3, thinkingTokens: null, totalCostUsd: null } });
    expect(head.display.reset).toEqual({ state: "unavailable", reason: "provider_unsupported" });
    expect(await decryptUsageHeadV2(await encryptUsageHeadV2(head, projectionKey(), context), projectionKey(), context)).toEqual(head);
  });

  test("newest corrupt Codex evidence cannot fall back to the preceding quota", async () => {
    const f = await fixture(); f.recordCodex({ used: 1 }); const latest = f.recordCodex({ used: 99 });
    f.corrupt((db) => db.query("UPDATE usage_snapshots SET digest=? WHERE profile_id=? AND source_revision=?")
      .run("f".repeat(64), f.profile.id, latest.sequence));
    const { head } = await project(f, "codex");
    expect(head.components.quota).toEqual({ state: "unavailable", reason: "source_unavailable" });
    expect(head.display.nextAction).toEqual({ state: "unavailable", reason: "snapshot_conflict" });
  });

  test.each(["identity", "mirror", "policy", "different"] as const)("known recovery survives %s and wins unavailable advice", async (damage) => {
    const f = await fixture(); const attempt = f.prepareReset();
    f.store.beginAccountRateLimitReset(attempt.idempotencyKey, f.store.requireProviderAccountAuthority(f.profile.id, "codex"));
    f.store.deferAccountRateLimitReset(attempt.idempotencyKey, "ambiguous");
    f.corrupt((db) => {
      if (damage === "identity" || damage === "different") {
        const identity = damage === "identity" ? null : "replacement@example.com";
        db.query("UPDATE profiles SET provider_email=? WHERE id=?").run(identity, f.profile.id);
        db.query("UPDATE provider_accounts SET provider_email=? WHERE id=?").run(identity, f.profile.id);
      } else if (damage === "mirror") db.query("UPDATE profiles SET process_generation=process_generation+1 WHERE id=?").run(f.profile.id);
      else db.query("DELETE FROM account_rate_limit_reset_policies WHERE profile_id=?").run(f.profile.id);
    });
    const { head } = await project(f, "codex");
    expect(head.display.nextAction).toEqual({ state: "blocked", reason: "reset_outcome_unknown" });
    expect(head.display.reset).toMatchObject({ state: "cached", pending: { state: "recovery_pending",
      weeklyWindowResetsAt: attempt.weeklyWindowResetsAt,
      identityRelation: damage === "policy" ? "current" : damage === "different" ? "different" : "unavailable" } });
    expect(JSON.stringify(head)).not.toContain(attempt.idempotencyKey);
    if (damage === "identity" || damage === "mirror") expect(head.codexAccountMatchPublicId).toBeNull();
  });

  test("the same pending attempt may be retained in current history without failing alias capture", async () => {
    const f = await fixture(); f.prepareReset();
    const facts = f.read("codex");
    if ("state" in facts.reset || facts.reset.currentIdentity.state !== "known" || facts.reset.pending.state !== "retained") throw new Error("Expected reset.");
    expect(facts.reset.currentIdentity.lastAttempt).toBe(facts.reset.pending.attempt);
    const { head } = await project(f, "codex");
    expect(head.display.reset).toMatchObject({ currentIdentity: { lastAttempt: { state: "prepared" } }, pending: { state: "prepared" } });
  });

  test("missing identity removes grouping and retained quota while a changed identity cannot inherit the old observation", async () => {
    const f = await fixture(); f.recordCodex();
    f.corrupt((db) => {
      db.query("UPDATE profiles SET provider_email='replacement@example.com' WHERE id=?").run(f.profile.id);
      db.query("UPDATE provider_accounts SET provider_email='replacement@example.com' WHERE id=?").run(f.profile.id);
    });
    expect((await project(f, "codex")).head.components.quota).toEqual({ state: "unavailable", reason: "identity_unavailable" });
    f.corrupt((db) => {
      db.query("UPDATE profiles SET provider_email=NULL WHERE id=?").run(f.profile.id);
      db.query("UPDATE provider_accounts SET provider_email=NULL WHERE id=?").run(f.profile.id);
    });
    const { head } = await project(f, "codex");
    expect(head.codexAccountMatchPublicId).toBeNull();
    expect(head.components.quota).toEqual({ state: "unavailable", reason: "identity_unavailable" });
  });

  test("a removed source keeps an explicit unknown head under independently supplied source context", async () => {
    const f = await fixture(); f.recordCodex();
    const context = await projectionContext(f, "codex");
    f.corrupt((db) => db.query("UPDATE provider_accounts SET readiness='removed' WHERE id=?").run(f.profile.id));
    const before = f.snapshot();
    const facts = f.store.readProviderUsageSourceFacts({ provider: "codex", providerAccountId: f.profile.id });
    const head = await projectUsageHeadV2(facts, projectionKey(), context, f.profile.id);
    if (head === null) throw new Error("Expected removed source head.");
    expect(f.snapshot()).toEqual(before);
    expect(head.codexAccountMatchPublicId).toBeNull();
    expect(head.components.quota).toEqual({ state: "unavailable", reason: "source_unavailable" });
    expect(head.components.readiness).toEqual({ state: "unavailable", reason: "source_unavailable" });
  });

  test("all private missing reasons have a conservative closed public mapping", async () => {
    const f = await fixture(); const context = await projectionContext(f, "codex"); const facts = f.read("codex");
    for (const reason of ["not_observed", "identity_unavailable", "source_unavailable", "representation_limit", "authority_mismatch", "snapshot_conflict"] as const) {
      const head = await projectUsageHeadV2({ ...facts, quota: { state: "unavailable", reason } }, projectionKey(), context, f.profile.id);
      expect(head?.components.quota).toEqual({ state: "unavailable",
        reason: reason === "authority_mismatch" || reason === "snapshot_conflict" ? "source_unavailable" : reason });
      expect(head?.display.nextAction).toEqual({ state: "unavailable",
        reason: reason === "authority_mismatch" || reason === "snapshot_conflict" ? "snapshot_conflict" : "runtime_not_integrated" });
    }
    const unknown = await projectUsageHeadV2({ state: "unavailable", reason: "snapshot_conflict" }, projectionKey(), context, f.profile.id);
    expect(unknown?.order).toEqual({ state: "unavailable", reason: "snapshot_conflict" });
    expect(unknown?.display.nextAction).toEqual({ state: "unavailable", reason: "snapshot_conflict" });
  });

  test("provider, source binding, provenance and independently selected context must all agree", async () => {
    const f = await fixture(); f.recordCodex(); const facts = f.read("codex"); const context = await projectionContext(f, "codex");
    expect(await projectUsageHeadV2(facts, projectionKey(), await projectionContext(f, "claude"), f.input("claude").providerAccountId)).toBeNull();
    expect(await projectUsageHeadV2(facts, projectionKey(), context, `acct_${"f".repeat(32)}`)).toBeNull();
    for (const change of [{ apiOrigin: "https://other.example.com" }, { userPublicId: "user_87654321" },
      { sourceDevicePublicId: "device_87654321" }, { keyVersion: 2 }, { sourcePublicId: `usrc2_${"f".repeat(64)}` }]) {
      expect(await projectUsageHeadV2(facts, projectionKey(), { ...context, ...change }, f.profile.id)).toBeNull();
    }
    if (facts.quota.state !== "observed") throw new Error("Expected quota.");
    expect(await projectUsageHeadV2({ ...facts, quota: { ...facts.quota, provenance: { ...facts.quota.provenance,
      authority: { ...facts.quota.provenance.authority, bindingGeneration: 99 } } } }, projectionKey(), context, f.profile.id)).toBeNull();
    expect(await projectUsageHeadV2(facts, new Uint8Array(32).fill(72), context, f.profile.id)).toBeNull();
  });

  test("key, facts and context are captured before asynchronous derivation", async () => {
    const f = await fixture(); f.recordCodex({ credits: 3 });
    const key = projectionKey(); const context = { ...await projectionContext(f, "codex", key) };
    const original = f.read("codex"); const facts = structuredClone(original);
    const expected = await projectUsageHeadV2(original, key, context, f.profile.id);
    const pending = projectUsageHeadV2(facts, key, context, f.profile.id);
    key.fill(255); context.sourceRevision = 99; context.userPublicId = "user_87654321";
    if (facts.metadata.source.state === "cached" && facts.metadata.source.provider === "codex" && facts.metadata.source.identity.state === "cached") {
      Object.assign(facts.metadata.source.identity, { email: "changed@example.com" });
    }
    Object.assign(facts, { quota: { state: "unavailable", reason: "not_observed" } });
    expect(await pending).toEqual(expected);
  });

  test("foreign totality rejects accessors, cycles, unknown keys, sparse input and non-byte/shared keys", async () => {
    const f = await fixture(); const facts = f.read("codex"); const context = await projectionContext(f, "codex");
    let reads = 0;
    const getter = Object.defineProperty({}, "state", { enumerable: true, get() { reads++; return "cached"; } });
    const cyclic: Record<string, unknown> = { state: "cached" }; cyclic.reset = cyclic;
    for (const invalid of [null, [], new Array(3), getter, cyclic, { ...facts, extra: "private" }]) {
      expect(await projectUsageHeadV2(invalid, projectionKey(), context, f.profile.id)).toBeNull();
    }
    expect(reads).toBe(0);
    for (const key of [new Uint8Array(31), new Uint8Array(new SharedArrayBuffer(32)), new Int8Array(32) as unknown as Uint8Array]) {
      expect(await projectUsageHeadV2(facts, key, context, f.profile.id)).toBeNull();
    }
    await fc.assert(fc.asyncProperty(fc.jsonValue(), async (input) => {
      expect(await projectUsageHeadV2(input, projectionKey(), context, f.profile.id)).toBeNull();
    }), { numRuns: 50, seed: 20260911 });
  });
});

describe("V2 composition representation boundaries", () => {
  test("all 101 real Codex limits survive without filtering, sorting or truncation", async () => {
    const f = await fixture(); const sequence = f.store.allocateNextUsageRevision(f.profile.id);
    const limit = { limitId: null, limitName: "private display name", planType: "private plan",
      rateLimitReachedType: null, primary: { usedPercent: 0, windowDurationMins: 0, resetsAt: 0 }, secondary: null };
    const payload = createStoredAccountUsageSnapshot({ sourceSequence: sequence, observedAt: now, receivedAt: now,
      accountFingerprint: fingerprint, providerGeneration: f.profile.processGeneration, daemonGeneration: 1, previousPayload: null,
      providerPayload: { usage: { summary: { lifetimeTokens: null, peakDailyTokens: null, longestRunningTurnSec: null,
        currentStreakDays: null, longestStreakDays: null }, dailyUsageBuckets: null },
      rateLimits: { primary: limit, byLimitId: Object.fromEntries(Array.from({ length: 100 }, (_, index) =>
        [String(index).padStart(250, "a"), limit])), resetCreditsAvailable: Number.MAX_SAFE_INTEGER } } });
    f.store.recordUsage(f.profile.id, sequence, now, payload, f.store.requireProviderAccountAuthority(f.profile.id, "codex"));
    const { facts, head } = await project(f, "codex");
    if (facts.quota.state !== "observed" || facts.quota.data.format !== "codex_v1" || head.components.provider !== "codex"
      || head.components.quota.state !== "observed") throw new Error("Expected full Codex quota.");
    expect(head.components.quota.data.limits).toHaveLength(101);
    expect(head.components.quota.data.limits.map((row) => row.id)).toEqual(facts.quota.data.limits.map((row) => row.id));
    expect(head.components.quota).toMatchObject({ observedAt: now, receivedAt: now,
      data: { resetCreditsAvailable: Number.MAX_SAFE_INTEGER } });
    expect(head.components.quota.data.limits[0]).toMatchObject({ primary: { usedPercent: 0, windowDurationMins: 0, resetsAtMs: 0 } });
    expect(new TextEncoder().encode(JSON.stringify(head)).byteLength).toBeLessThanOrEqual(69_961);
    expect(JSON.stringify(head)).not.toContain("private display name");
    expect(JSON.stringify(head)).not.toContain("private plan");
  });

  test("all 16 Claude quota rows and 32 independent model rows survive, and unsafe model codes refuse only accounting", async () => {
    const f = await fixture(); const turn = bindClaudeTurn(f); const template = turn.quota(1);
    const base = { authority: template.authority, sessionId: template.turn.sessionId, turnId: template.turn.turnId,
      observedAt: now, receivedAt: now, observationRevision: 1, sourceEventDigest: template.sourceEventDigest, sourceEventId: randomUUID() };
    const counter = Number.MAX_SAFE_INTEGER;
    const tokens = { inputTokens: counter, cacheReadInputTokens: counter, cacheCreationInputTokens: counter,
      outputTokens: counter, thinkingTokens: counter };
    const quota = { status: { state: "unknown" as const, value: "a".repeat(128) }, rateLimitType: "b".repeat(128),
      resetsAtMs: counter, overageStatus: "c".repeat(128), overageDisabledReason: "d".repeat(128), isUsingOverage: false,
      windows: Array.from({ length: 16 }, (_, index) => ({ id: String(index).padStart(128, "a"), scope: "account" as const,
        usedPercent: 0.0000010000000000000002, resetsAtMs: counter })) };
    const accounting = { ...tokens, totalCostUsd: 0.0000010000000000000002,
      models: Array.from({ length: 32 }, (_, index) => ({ ...tokens, model: String(index).padStart(128, "a"),
        costUsd: 0.0000010000000000000002, contextWindow: counter, maxOutputTokens: counter })) };
    f.store.recordProviderUsageObservation(createClaudeQuotaUsageComponent({ ...base, quota }));
    f.store.recordProviderUsageObservation(createClaudeAccountingUsageComponent({ ...base,
      sourceEventId: randomUUID(), sourceEventDigest: providerUsageDigest({ accounting: 1 }), accounting }));
    const { head } = await project(f, "claude");
    if (head.components.provider !== "claude" || head.components.quota.state !== "observed"
      || head.components.accounting.state !== "observed") throw new Error("Expected full Claude components.");
    expect(head.components.quota.data.windows).toHaveLength(16);
    expect(head.components.accounting.data.models).toHaveLength(32);
    expect(head.components.quota.observedAt).toBe(now);
    expect(head.components.accounting.receivedAt).toBe(now);
    expect(new TextEncoder().encode(JSON.stringify(head)).byteLength).toBeLessThanOrEqual(19_477);
    f.store.recordProviderUsageObservation(createClaudeAccountingUsageComponent({ ...base, observedAt: now + 1, receivedAt: now + 1,
      observationRevision: 2, sourceEventId: randomUUID(), sourceEventDigest: providerUsageDigest({ accounting: 2 }),
      accounting: { ...accounting, models: [{ ...tokens, costUsd: 0.0000010000000000000002,
        contextWindow: counter, maxOutputTokens: counter, model: "/private/unsafe-model" }] } }));
    const refused = (await project(f, "claude")).head;
    expect(refused.components.quota).toEqual(head.components.quota);
    expect(refused.components.accounting).toEqual({ state: "unavailable", reason: "representation_limit" });
    expect(JSON.stringify(refused)).not.toContain("/private/unsafe-model");
  });

  test("zero and full-width numeric facts compose canonically across deterministic samples", async () => {
    const f = await fixture(); f.recordCodex({ credits: 4 }); const facts = f.read("codex"); const context = await projectionContext(f, "codex");
    if (facts.quota.state !== "observed" || facts.quota.data.format !== "codex_v1") throw new Error("Expected quota.");
    const quota = facts.quota; const limits = facts.quota.data.limits;
    await fc.assert(fc.asyncProperty(fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
      fc.double({ min: 0, max: 100, noNaN: true }), async (time, usedPercent) => {
        const head = await projectUsageHeadV2({ ...facts, quota: { ...quota,
          provenance: { ...quota.provenance, observedAt: time, receivedAt: time }, data: { ...quota.data,
            limits: [{ ...limits[0], primary: { usedPercent, windowDurationMins: null, resetsAtMs: time }, secondary: null }] } } },
        projectionKey(), context, f.profile.id);
        expect(head).not.toBeNull();
        expect(head?.components.quota).toMatchObject({ observedAt: time, receivedAt: time,
          data: { limits: [{ primary: { usedPercent, windowDurationMins: null, resetsAtMs: time }, secondary: null }] } });
        expect(parseUsageHeadV2(head, context)).toEqual(head);
      }), { numRuns: 40, seed: 20260912 });
  });
});

describe("V2 reset state redaction", () => {
  test.each(["effect_started", "retryable", "ambiguous", "settled", "closed"] as const)("maps retained %s exactly", async (state) => {
    const f = await fixture(); const attempt = f.prepareReset();
    if (state === "closed") f.store.closeAccountRateLimitReset(attempt.idempotencyKey, "weekly_window_changed");
    else {
      f.store.beginAccountRateLimitReset(attempt.idempotencyKey, f.store.requireProviderAccountAuthority(f.profile.id, "codex"));
      if (state === "retryable" || state === "ambiguous") f.store.deferAccountRateLimitReset(attempt.idempotencyKey, state);
      if (state === "settled") f.store.settleAccountRateLimitReset(attempt.idempotencyKey, "noCredit");
    }
    const { head } = await project(f, "codex");
    const expected = state === "effect_started" || state === "ambiguous" ? "recovery_pending"
      : state === "retryable" ? "retry_pending" : state;
    expect(head.display.reset).toMatchObject({ state: "cached", currentIdentity: { lastAttempt: {
      state: expected, weeklyWindowResetsAt: attempt.weeklyWindowResetsAt,
      ...(state === "settled" ? { outcome: "noCredit" } : state === "closed" ? { reason: "weekly_window_changed" } : {}),
    } }, pending: state === "settled" || state === "closed" ? { state: "none" } : {
      state: expected, weeklyWindowResetsAt: attempt.weeklyWindowResetsAt, identityRelation: "current",
    } });
    expect(head.display.nextAction).toEqual(expected === "recovery_pending"
      ? { state: "blocked", reason: "reset_outcome_unknown" } : { state: "unavailable", reason: "runtime_not_integrated" });
  });

  test("a previous identity's retained policy cannot become the current identity's public latch", async () => {
    const f = await fixture(); f.prepareReset();
    f.corrupt((db) => {
      db.query("UPDATE profiles SET provider_email='replacement@example.com' WHERE id=?").run(f.profile.id);
      db.query("UPDATE provider_accounts SET provider_email='replacement@example.com' WHERE id=?").run(f.profile.id);
    });
    const { head } = await project(f, "codex");
    expect(head.display.reset).toMatchObject({ state: "cached",
      currentIdentity: { state: "unavailable", reason: "snapshot_conflict" },
      pending: { state: "prepared", identityRelation: "different" } });
    expect(head.display.nextAction).toEqual({ state: "unavailable", reason: "snapshot_conflict" });
  });
});

describe("V2 captured identity compatibility", () => {
  test("private normalization and the original Codex grouping preimage stay distinct", async () => {
    const f = await fixture();
    const raw = "  Ｆacts＠Example.com  ";
    f.corrupt((db) => {
      db.query("UPDATE profiles SET provider_email=? WHERE id=?").run(raw, f.profile.id);
      db.query("UPDATE provider_accounts SET provider_email=? WHERE id=?").run(raw, f.profile.id);
    });
    const { head, facts } = await project(f, "codex");
    expect(head.codexAccountMatchPublicId).toBe(`codex_${(await hmacSha256Hex(projectionKey(), "codex-account-match", "facts@example.com")).slice(0, 48)}`);
    expect(facts.reset).toMatchObject({ currentIdentity: { accountFingerprint:
      createHash("sha256").update(raw.trim().toLowerCase()).digest("hex") } });
    expect(JSON.stringify(head)).not.toContain(raw);
    const formatCharacter = "\u200bfacts@example.com";
    f.corrupt((db) => {
      db.query("UPDATE profiles SET provider_email=? WHERE id=?").run(formatCharacter, f.profile.id);
      db.query("UPDATE provider_accounts SET provider_email=? WHERE id=?").run(formatCharacter, f.profile.id);
    });
    expect((await project(f, "codex")).head.codexAccountMatchPublicId).toBe(
      `codex_${(await hmacSha256Hex(projectionKey(), "codex-account-match", formatCharacter)).slice(0, 48)}`);
  });
});
