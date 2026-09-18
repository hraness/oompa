import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { canonical40QueuesFixture } from "../../scripts/fixtures/canonical40-queues";
import { canonical39AttachmentFixtures } from "../../scripts/fixtures/canonical39-attachments";
import { IndeterminateCodexEffectError, type OompaHostToolCall } from "../codex";
import { CLAUDE_PIN } from "../claude/pin";
import { DEVIN_PIN } from "../devin/pin";
import { AccountKeyLossPreconditionError } from "../cloud/local-control";
import { localCommandSchema, type LocalCommand } from "../domain/contracts";
import { OOMPA_HOST_TOOL_PUBLIC_RESULT_MAX_BYTES } from "../domain/host-tools";
import { PROJECT_MEMORY_EMPTY_HEAD } from "../domain/project-memory";
import { AttachmentBlobStore } from "../storage/attachment-store";
import { ingestAttachments } from "./attachment-ingest";
import { currentPresetContract, presetRequirements } from "../domain/presets";
import type { EffectiveDevinRuntimeProfile, EffectiveRuntimeProfile } from "../domain/runtime-profile";
import { SESSION_EVENT_RETAIN_AGE_MS } from "../domain/session-events";
import { StateStore, type SessionRecord } from "../storage/state-store";
import { SessionSendOwnershipError } from "../storage/session-send-owner";
import type { CodexRuntimePort, DevinRuntimePort, ProfileAuthority } from "./ports";
import { CommandFailure, OompaService } from "./service";
import {
  FakeClaude,
  FakeCloud,
  FakeCodex,
  FakeDaemonAuthority,
  FakeFactsMemoryLifecycle,
  FakeMemory,
  FakeMemoryRefusalError,
  MANAGED_CODEX_HOST_TOOL_PROVENANCE,
  abandonArchivedDevinLogin,
  adoptedClaudeFixture,
  archivedDevinFixture,
  claudeAccountFixture,
  claudeProviderAccountKey,
  codexInteractionBinding,
  codexProviderAccountKey,
  createIdleSession,
  createOwnedServiceCase,
  createPeerMessageBoundaryFixture,
  devinAccountFixture,
  expectHistoricalValue,
  fixture,
  hostToolAuthorityFor,
  isolatedLoginCompletionFixture,
  liveAuthorityFor,
  ownedFixtureTeardowns,
  ownedServiceCase,
  ownedServiceCaseTeardowns,
  prepareAbandonedPeerScenario,
  privatePathRoot,
  providerMutationCalls,
  serviceFixtureDatabaseSnapshot,
  serviceRoots,
  signal,
  stores,
} from "../../scripts/fixtures/service-testkit";

setDefaultTimeout(60_000);

afterEach(async () => {
  const caseTeardowns = ownedServiceCaseTeardowns.splice(0);
  // A timed-out owned fixture can still have an admitted command. Join its
  // request and service before the shared fixture cleanup removes storage.
  for (const teardown of ownedFixtureTeardowns) await teardown();
  ownedFixtureTeardowns.length = 0;
  for (const store of stores.splice(0)) store.close();
  await Promise.all(serviceRoots.splice(0).map(async (root) =>
    rm(root, { force: true, recursive: true })));
  // Each case owns private lists. A late drain cannot claim fixtures from a
  // subsequent test, even if this afterEach itself reaches its deadline.
  const results = await Promise.allSettled(caseTeardowns.map(async (teardown) => await teardown()));
  const failures = results.flatMap((result): unknown[] => result.status === "rejected" ? [result.reason] : []);
  if (failures.length > 0) throw new AggregateError(failures, "Service case teardown failed.");
});

describe("OompaService", () => {
test("original send ambiguity stays visible to doctor and cannot enter generic session recovery", async () => {
    const value = await fixture();
    const bootId = `boot_${"d".repeat(32)}`;
    const daemonGeneration = value.store.nextDaemonGeneration(bootId);
    const { sessionId } = await createIdleSession(value, "Owned send diagnostics");
    const request = { kind: "session.send" as const, session: sessionId, message: "Original recovery input",
      attachments: [], idempotencyKey: crypto.randomUUID() };
    const owner = value.store.prepareOwnedSessionSend(request);
    const runtimeProfile = value.store.latestSessionRuntimeProfile(sessionId)?.profile;
    if (runtimeProfile === undefined) throw new Error("Expected a reviewed session runtime profile.");
    const claim = value.store.beginOwnedDirectSendEffect({
      attemptId: owner.owner.attemptId, ownerDigest: owner.ownerDigest, requestFingerprint: owner.owner.fingerprint,
      daemonGeneration, bootId, expectedSessionRevision: owner.owner.sourceSessionRevision,
      executionAuthority: owner.owner.sourceAuthority,
      evidence: { kind: "session.send", providerThreadId: owner.owner.sourceThreadId,
        baseline: { providerUpdatedAt: null, status: "idle", activeTurnId: null },
        clientMessageId: owner.owner.attemptId, messageDigest: owner.owner.fingerprint.inputDigest, runtimeProfile },
    });
    if (claim.claimDigest === null) throw new Error("Expected a durable direct send claim.");
    const ambiguous = value.store.settleOwnedDirectSend({ attemptId: owner.owner.attemptId,
      ownerDigest: owner.ownerDigest, claimDigest: claim.claimDigest,
      outcome: { kind: "ambiguous", reason: "provider_outcome_unknown" } });
    value.store.reconcileSessionFromProvider({ sessionId, state: "recovery_required" });
    const doctor = await value.service.execute({ kind: "doctor", offline: true }, { signal });
    expect(doctor).toMatchObject({ state: { database: "ready", unsettledMutations: 1 } });
    expect(value.store.listUnsettledMutations({ sessionId })).toMatchObject([
      { format: "original_send_v1", id: owner.owner.attemptId, state: "ambiguous" },
    ]);
    const providerCalls = [...value.codex.calls];
    const current = value.store.requireSession(sessionId);
    for (const kind of ["session.recover", "session.abandon"] as const) {
      await expect(value.service.execute({ kind, session: sessionId }, { signal })).rejects.toMatchObject({
        code: "RECOVERY_REQUIRED", details: { reason: "original_send_recovery_required" },
      });
    }
    expect(value.codex.calls).toEqual(providerCalls);
    expect(value.store.requireSession(sessionId)).toEqual(current);
    expect(value.store.readOwnedSessionSend(request.idempotencyKey)).toEqual(ambiguous);
    expect(value.codex.committedStartTurns).toBe(0);
  });
describe("automatic policy commands", () => {
    type Configuration = ReturnType<StateStore["readAutomaticUsagePolicyConfiguration"]>;
    type Change = Parameters<StateStore["updateAutomaticUsagePolicyConfiguration"]>[0]["change"];
    const initial: Configuration = { version: 1, defaultEnabled: true,
      overrides: { codex: "inherit", claude: "inherit" }, automaticPolicyRevision: 1 };
    const recoveryMessage = "Automatic usage policy could not be verified. No automatic setting was reinitialized; inspect local recovery before retrying.";
    const revisionMessage = "Automatic usage policy changed since that revision. Run `oompa usage auto status` before submitting a new change.";
    const keyMessage = "The automatic usage policy key belongs to a different request. Replay the original request or use a new key for a new change.";
    const projection = (configuration: Configuration, providers: readonly ("codex" | "claude")[] = ["codex", "claude"]) => ({
      version: 1, configuration,
      effective: providers.map((provider) => ({ provider,
        enabled: configuration.overrides[provider] === "inherit" ? configuration.defaultEnabled : configuration.overrides[provider] === "on",
        source: configuration.overrides[provider] === "inherit" ? "default" : "override",
        automaticPolicyRevision: configuration.automaticPolicyRevision,
      })),
    });
    const request = (expectedAutomaticPolicyRevision = 1, change: Change = { kind: "set_default", enabled: false }) => ({
      kind: "usage.auto.set", idempotencyKey: crypto.randomUUID(), expectedAutomaticPolicyRevision, change,
    });
    const execute = (service: OompaService, command: unknown) => service.execute(localCommandSchema.parse(command), { signal });
    const setup = async () => {
      const now = 1_800_000_000_000;
      const claude = new FakeClaude("isolated", {
        pid: 63_042, pidDomain: "darwin", procStart: "automatic-policy-command-fake-process",
      });
      const value = await fixture(new FakeCloud(), () => undefined, () => now, undefined, { claude });
      const profiles = ["primary", "secondary"].map((label) => {
        const current = value.store.nextProfileGeneration(value.store.createProfile(`Automatic ${label}`).id);
        expect(value.store.setProfileState(current.id, current.processGeneration, "signed_in", {
          email: `automatic-${label}@example.com`, plan: "Plus",
        })).toBe(true);
        return value.store.requireProfileById(current.id);
      });
      const primary = profiles[0];
      if (primary === undefined) throw new Error("Expected a seeded account.");
      const session = value.store.createSession({ profileId: primary.id, provider: "codex", preset: "high", fastEnabled: false });
      value.store.bindSession({ sessionId: session.id, expectedRevision: session.revision,
        providerThreadId: "automatic-policy-preserved-thread", state: "idle" });
      const resetInput = { profileId: primary.id, processGeneration: primary.processGeneration,
        accountFingerprint: createHash("sha256").update("automatic-primary@example.com").digest("hex"),
        weeklyWindowResetsAt: now + 86_400_000 };
      expect(value.store.authorizeAccountRateLimitResetPolicy({ ...resetInput, weeklyWindowDurationMinutes: 10_080 }).decision).toBe("allow");
      value.store.prepareAccountRateLimitReset({ ...resetInput, observedUsedPercent: 99 });
      value.store.prepareMutation({ idempotencyKey: crypto.randomUUID(), kind: "test.policy-preserved",
        authorityId: "test-policy-preserved", authorityGeneration: 1, request: { preserve: true } });
      const snapshot = (unrelated = false) => {
        const db = new Database(value.paths.database, { readonly: true, strict: true });
        try {
          const names = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
          return {
            version: db.query("PRAGMA user_version").get(),
            schema: db.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all(),
            tables: names.filter(({ name }) => !unrelated || name !== "automatic_usage_policy_revisions")
              .map(({ name }) => ({ name, rows: db.query(`SELECT * FROM "${name.replaceAll('"', '""')}"${
                unrelated && name === "mutation_attempts" ? " WHERE kind<>'usage.auto.configure'" : ""
              }`).all() })),
          };
        } finally { db.close(false); }
      };
      const expectNoProviderWork = () => {
        expect(value.codex.calls).toEqual([]);
        expect(value.codex.resetIdempotencyKeys).toEqual([]);
        expect(value.codex.turnEffectTrace).toEqual([]);
        expect(claude.calls).toEqual([]);
      };
      return { ...value, claude, now, sessionId: session.id, snapshot, expectNoProviderWork };
    };

    test("reports defaults and exact provider filters without any write or provider call", async () => {
      const value = await setup();
      const before = value.snapshot();
      expect(await execute(value.service, { kind: "usage.auto.status" })).toEqual(projection(initial));
      for (const provider of ["codex", "claude"] as const) {
        expect(await execute(value.service, { kind: "usage.auto.status", provider })).toEqual(projection(initial, [provider]));
      }
      expect(value.snapshot()).toEqual(before);
      value.expectNoProviderWork();
    });

    test("updates the effective default and override matrix without touching existing sessions, resets or pointers", async () => {
      const value = await setup();
      const before = value.snapshot(true);
      let configuration = initial;
      const changes: Change[] = [
        { kind: "set_default", enabled: false },
        { kind: "set_override", provider: "codex", override: "on" },
        { kind: "set_override", provider: "claude", override: "off" },
        { kind: "set_default", enabled: true },
        { kind: "set_override", provider: "codex", override: "off" },
        { kind: "set_override", provider: "claude", override: "on" },
        { kind: "set_override", provider: "codex", override: "inherit" },
        { kind: "set_override", provider: "claude", override: "inherit" },
        { kind: "set_default", enabled: true },
      ];
      for (const change of changes) {
        const command = request(configuration.automaticPolicyRevision, change);
        configuration = { ...configuration, overrides: { ...configuration.overrides },
          automaticPolicyRevision: configuration.automaticPolicyRevision + 1 };
        if (change.kind === "set_default") configuration.defaultEnabled = change.enabled;
        else configuration.overrides[change.provider] = change.override;
        expect(await execute(value.service, command)).toEqual(projection(configuration));
        expect(await execute(value.service, { kind: "usage.auto.status", provider: "claude" }))
          .toEqual(projection(configuration, ["claude"]));
        expect(value.store.readMutation(command.idempotencyKey)).toMatchObject({
          kind: "usage.auto.configure", authorityId: "automatic-usage-policy",
          authorityGeneration: command.expectedAutomaticPolicyRevision, state: "applied",
          result: { version: 1, automaticPolicyRevision: configuration.automaticPolicyRevision },
        });
        expect(value.snapshot(true)).toEqual(before);
      }
      value.expectNoProviderWork();
    });

    test("replays the original receipt before a changed live head without rewriting anything", async () => {
      const value = await setup();
      const original = request();
      const first = await execute(value.service, original);
      expect(first).toEqual(projection({ ...initial, defaultEnabled: false, automaticPolicyRevision: 2 }));
      const latest = await execute(value.service, request(2, { kind: "set_override", provider: "codex", override: "on" }));
      expect(latest).not.toEqual(first);
      const before = value.snapshot();
      Object.defineProperty(value.store, "readAutomaticUsagePolicyConfiguration", {
        configurable: true, value: () => { throw new Error("A historical replay must not preflight the live head."); },
      });
      try { expect(await execute(value.service, original)).toEqual(first); }
      finally { Reflect.deleteProperty(value.store, "readAutomaticUsagePolicyConfiguration"); }
      expect(value.snapshot()).toEqual(before);
      expect(await execute(value.service, { kind: "usage.auto.status" })).toEqual(latest);
      value.expectNoProviderWork();
    });

    test("rejects conflicting keys and stale revisions without intent or state changes", async () => {
      const value = await setup();
      const accepted = request();
      await execute(value.service, accepted);
      const foreign = request(2);
      value.store.prepareMutation({ idempotencyKey: foreign.idempotencyKey, kind: "test.other",
        authorityId: "test-policy-key", authorityGeneration: 1, request: {} });
      for (const [command, message] of [
        [{ ...accepted, change: { kind: "set_default", enabled: true } }, keyMessage],
        [{ ...accepted, expectedAutomaticPolicyRevision: 2 }, keyMessage],
        [foreign, keyMessage],
        [request(1), revisionMessage],
      ] as const) {
        const before = value.snapshot();
        await expect(execute(value.service, command)).rejects.toMatchObject({ code: "CONFLICT", message, details: undefined });
        expect(value.snapshot()).toEqual(before);
      }
      value.expectNoProviderWork();
    });

    test("reports an owned session-send key as an inert conflict", async () => {
      const value = await setup();
      const command = request();
      const owner = value.store.prepareOwnedSessionSend({ kind: "session.send", session: value.sessionId,
        message: "Preserve the original send owner", attachments: [], idempotencyKey: command.idempotencyKey });
      const history = value.store.readOwnedSessionSend(command.idempotencyKey);
      expect(history).toMatchObject({ kind: "owned", ownerDigest: owner.ownerDigest });
      const before = value.snapshot();
      await expect(execute(value.service, command)).rejects.toMatchObject({ code: "CONFLICT", message: keyMessage, details: undefined });
      expect(value.snapshot()).toEqual(before);
      expect(value.store.readOwnedSessionSend(command.idempotencyKey)).toEqual(history);
      value.expectNoProviderWork();
    });

    test("keeps corrupt session-send ownership a sanitized recovery refusal", async () => {
      const value = await setup();
      const before = value.snapshot();
      const failure = new SessionSendOwnershipError("SESSION_SEND_OWNER_CORRUPT");
      failure.message = `${failure.code} ${privatePathRoot}/owner-private-sentinel`;
      Object.defineProperty(value.store, "updateAutomaticUsagePolicyConfiguration", {
        configurable: true, value: () => { throw failure; },
      });
      await expect(execute(value.service, request()))
        .rejects.toMatchObject({ code: "RECOVERY_REQUIRED", message: recoveryMessage, details: undefined });
      expect(value.snapshot()).toEqual(before);
      value.expectNoProviderWork();
    });

    test("admits exactly one revision contender across two real service/store connections", async () => {
      const value = await setup();
      const contenderStore = new StateStore(value.paths, { now: () => value.now });
      stores.push(contenderStore);
      const contender = new OompaService({ store: contenderStore, paths: value.paths,
        codex: value.codex, claude: value.claude, cloud: value.cloud,
        daemonAuthority: new FakeDaemonAuthority(), daemonGeneration: value.daemonGeneration,
        daemonBootId: value.daemonBootId, eventCursors: value.eventCursors, now: () => value.now,
        requestStop: () => undefined,
      });
      const commands = [request(), request(1, { kind: "set_override", provider: "codex", override: "off" })];
      const before = value.snapshot(true);
      try {
        const results = await Promise.allSettled(commands.map((command, index) => execute(index === 0 ? value.service : contender, command)));
        expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
        expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
        for (const [index, result] of results.entries()) {
          const command = commands[index];
          if (command === undefined) throw new Error("Expected contender request.");
          if (result.status === "rejected") {
            expect(result.reason).toMatchObject({ code: "CONFLICT", message: revisionMessage, details: undefined });
            expect(value.store.readMutation(command.idempotencyKey)).toBeNull();
          } else expect(result.value).toMatchObject({ configuration: { automaticPolicyRevision: 2 } });
        }
        expect(value.store.readAutomaticUsagePolicyConfiguration().automaticPolicyRevision).toBe(2);
        expect(contenderStore.readAutomaticUsagePolicyConfiguration()).toEqual(value.store.readAutomaticUsagePolicyConfiguration());
        expect(value.snapshot(true)).toEqual(before);
        value.expectNoProviderWork();
      } finally { await contender.close(); }
    });

    for (const operation of ["status", "set"] as const) {
      for (const failure of ["throw", "malformed_result"] as const) {
        test(`sanitizes ${operation} ${failure} inside the policy boundary without reinitializing state`, async () => {
          const value = await setup();
          const sentinel = `${privatePathRoot}/policy-secret-sentinel`;
          const before = value.snapshot();
          Object.defineProperty(value.store, operation === "status" ? "readAutomaticUsagePolicyConfiguration" : "updateAutomaticUsagePolicyConfiguration", {
            configurable: true,
            value: () => {
              if (failure === "throw") throw new Error(`AUTOMATIC_USAGE_POLICY_INVALID ${sentinel}`);
              return { ...initial, automaticPolicyRevision: 0, privateDetail: sentinel };
            },
          });
          await expect(execute(value.service, operation === "status" ? { kind: "usage.auto.status" } : request()))
            .rejects.toMatchObject({ code: "RECOVERY_REQUIRED", message: recoveryMessage, details: undefined });
          expect(value.snapshot()).toEqual(before);
          value.expectNoProviderWork();
        });
      }
    }

    test("reports exhausted revision capacity as a closed inert conflict", async () => {
      const value = await setup();
      const before = value.snapshot();
      Object.defineProperty(value.store, "updateAutomaticUsagePolicyConfiguration", {
        configurable: true, value: () => { throw new Error("AUTOMATIC_USAGE_POLICY_REVISION_EXHAUSTED"); },
      });
      await expect(execute(value.service, request())).rejects.toMatchObject({ code: "CONFLICT", details: undefined,
        message: "Automatic usage policy revision capacity is exhausted; this setting cannot be updated further." });
      expect(value.snapshot()).toEqual(before);
      value.expectNoProviderWork();
    });

    test("rejects unknown wire fields and unsupported providers before service admission", () => {
      for (const command of [
        { kind: "usage.auto.status", provider: "devin" },
        { kind: "usage.auto.status", extra: true },
        { ...request(), extra: true },
        { ...request(), expectedAutomaticPolicyRevision: 0 },
        { ...request(), expectedAutomaticPolicyRevision: Number.MAX_SAFE_INTEGER + 1 },
        { ...request(), change: { kind: "set_default", enabled: false, extra: true } },
        { ...request(), change: { kind: "set_override", provider: "codex", override: "disabled" } },
        { ...request(), change: { kind: "set_override", provider: "devin", override: "off" } },
      ]) expect(localCommandSchema.safeParse(command).success).toBe(false);
    });
  });
test("reports and CAS-updates notification hours with the injected clock only", async () => {
    let now = Date.parse("2026-09-04T12:30:00.000Z");
    const value = await fixture(new FakeCloud(),
      () => undefined,
      () => now,
    );
    const approvalBefore = await value.service.execute(
      { kind: "autorespond.status" },
      { signal },
    );

    expect(await value.service.execute({
      kind: "notification-hours.set",
      expectedRevision: 1,
      version: 1,
      startMinute: 10 * 60,
      endMinute: 22 * 60,
      timeZone: "UTC",
    }, { signal })).toEqual({
      policy: {
        version: 1,
        revision: 2,
        startMinute: 10 * 60,
        endMinute: 22 * 60,
        timeZone: "UTC",
      },
      observedAt: now,
      withinHours: true,
    });

    now = Date.parse("2026-09-04T22:00:00.000Z");
    expect(await value.service.execute(
      { kind: "notification-hours.status" },
      { signal },
    )).toEqual({
      policy: {
        version: 1,
        revision: 2,
        startMinute: 10 * 60,
        endMinute: 22 * 60,
        timeZone: "UTC",
      },
      observedAt: now,
      withinHours: false,
    });
    expect(await value.service.execute(
      { kind: "autorespond.status" },
      { signal },
    )).toEqual(approvalBefore);
  });
test("maps a stale notification-hours revision to a closed conflict", async () => {
    const value = await fixture();
    const first = {
      kind: "notification-hours.set",
      expectedRevision: 1,
      version: 1,
      startMinute: 8 * 60,
      endMinute: 20 * 60,
      timeZone: "UTC",
    } as const;
    await value.service.execute(first, { signal });

    await expect(value.service.execute({
      ...first,
      startMinute: 9 * 60,
    }, { signal })).rejects.toMatchObject({
      code: "CONFLICT",
      name: "CommandFailure",
    });
    expect(value.store.readNotificationHours()).toEqual({
      version: 1,
      revision: 2,
      startMinute: 8 * 60,
      endMinute: 20 * 60,
      timeZone: "UTC",
    });
  });
test("keeps notification email local, default-off, and on the shared revision", async () => {
    const value = await fixture(new FakeCloud(), () => undefined, () => 1_000);
    expect(await value.service.execute(
      { kind: "notification-email.status" },
      { signal },
    )).toEqual({
      hostedAuthority: { state: "not_observed" },
      policy: { enabled: false, revision: 1, version: 1 },
    });
    expect(await value.service.execute({
      expectedRevision: 1,
      kind: "notification-email.enable",
    }, { signal })).toEqual({
      hostedAuthority: { state: "not_observed" },
      policy: { enabled: true, revision: 2, version: 1 },
    });
    expect((await value.service.execute(
      { kind: "notification-hours.status" },
      { signal },
    ) as { policy: { revision: number } }).policy.revision).toBe(2);

    await value.service.execute({
      kind: "notification-hours.set",
      expectedRevision: 2,
      version: 1,
      startMinute: 480,
      endMinute: 1_200,
      timeZone: "UTC",
    }, { signal });
    expect(await value.service.execute(
      { kind: "notification-email.status" },
      { signal },
    )).toEqual({
      hostedAuthority: { state: "not_observed" },
      policy: { enabled: true, revision: 3, version: 1 },
    });
    expect(await value.service.execute({
      expectedRevision: 3,
      kind: "notification-email.disable",
    }, { signal })).toEqual({
      hostedAuthority: { state: "not_observed" },
      policy: { enabled: false, revision: 4, version: 1 },
    });
  });
test("commits local disable before reporting hosted acknowledgement", async () => {
    const cloud = new FakeCloud();
    const value = await fixture(cloud, () => undefined, () => 60_000);
    await value.service.execute({
      expectedRevision: 1,
      kind: "notification-email.enable",
    }, { signal });
    cloud.beforeAttentionInvalidation = (input) => {
      expect(value.store.readNotificationEmailPolicy()).toEqual({
        enabled: false,
        revision: 3,
        version: 1,
      });
      expect(input.localNotificationPolicyRevision).toBe(3);
    };
    cloud.attentionInvalidation = {
      acknowledgedAt: 61_000,
      consentLeaseUntil: 61_000,
      state: "acknowledged",
    };
    expect(await value.service.execute({
      expectedRevision: 2,
      kind: "notification-email.disable",
    }, { signal })).toEqual({
      hostedAuthority: {
        acknowledgedAt: 61_000,
        consentLeaseUntil: 61_000,
        state: "acknowledged",
      },
      policy: { enabled: false, revision: 3, version: 1 },
    });
  });
test("returns exact bounded hosted observations for status and enable", async () => {
    const cloud = new FakeCloud();
    cloud.attentionObservation = {
      deviceAuthority: {
        consentLeaseUntil: 180_000,
        globalNotificationGeneration: 4,
        localNotificationPolicyRevision: 1,
      },
      globalNotificationGeneration: 4,
      globalState: "enabled",
      observedAt: 60_000,
      state: "observed",
    };
    const value = await fixture(cloud, () => undefined, () => 60_000);
    expect(await value.service.execute(
      { kind: "notification-email.status" },
      { signal },
    )).toEqual({
      hostedAuthority: cloud.attentionObservation,
      policy: { enabled: false, revision: 1, version: 1 },
    });
    expect(await value.service.execute({
      expectedRevision: 1,
      kind: "notification-email.enable",
    }, { signal })).toEqual({
      hostedAuthority: cloud.attentionObservation,
      policy: { enabled: true, revision: 2, version: 1 },
    });
    for (const attentionObservation of [
      {
        acknowledgedAt: 61_000,
        consentLeaseUntil: 61_000,
        state: "acknowledged" as const,
      },
      {
        expiresNoLaterThan: 180_000,
        state: "revocation_pending" as const,
      },
      { state: "not_observed" as const },
    ]) {
      cloud.attentionObservation = attentionObservation;
      expect((await value.service.execute(
        { kind: "notification-email.status" },
        { signal },
      ) as { hostedAuthority: unknown }).hostedAuthority).toEqual(attentionObservation);
    }
    cloud.attentionObservation = {
      acknowledgedAt: 61_000,
      consentLeaseUntil: 61_000,
      state: "acknowledged",
    };
    expect(await value.service.execute({
      expectedRevision: 2,
      kind: "notification-email.enable",
    }, { signal })).toEqual({
      hostedAuthority: { state: "not_observed" },
      policy: { enabled: true, revision: 3, version: 1 },
    });
  });
test("does not invent a revocation deadline when offline after the local commit", async () => {
    const cloud = new FakeCloud();
    cloud.beforeAttentionInvalidation = () => {
      throw new Error("offline");
    };
    const value = await fixture(cloud, () => undefined, () => 60_000);
    await value.service.execute({
      expectedRevision: 1,
      kind: "notification-email.enable",
    }, { signal });
    expect(await value.service.execute({
      expectedRevision: 2,
      kind: "notification-email.disable",
    }, { signal })).toEqual({
      hostedAuthority: { state: "not_observed" },
      policy: { enabled: false, revision: 3, version: 1 },
    });
    expect(value.store.readNotificationEmailPolicy().enabled).toBe(false);
  });
test("reports revocation pending only from an exact control receipt", async () => {
    const cloud = new FakeCloud();
    cloud.attentionInvalidation = {
      expiresNoLaterThan: 180_000,
      state: "revocation_pending",
    };
    const value = await fixture(cloud, () => undefined, () => 60_000);
    await value.service.execute({
      expectedRevision: 1,
      kind: "notification-email.enable",
    }, { signal });
    expect(await value.service.execute({
      expectedRevision: 2,
      kind: "notification-email.disable",
    }, { signal })).toEqual({
      hostedAuthority: cloud.attentionInvalidation,
      policy: { enabled: false, revision: 3, version: 1 },
    });
  });
test("maps stale notification-email CAS without changing local authority", async () => {
    const value = await fixture();
    await value.service.execute({
      expectedRevision: 1,
      kind: "notification-email.enable",
    }, { signal });
    await expect(value.service.execute({
      expectedRevision: 1,
      kind: "notification-email.disable",
    }, { signal })).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("notification-email status"),
      name: "CommandFailure",
    });
    expect(value.store.readNotificationEmailPolicy()).toEqual({
      enabled: true,
      revision: 2,
      version: 1,
    });
  });
test("reads the default peer policy and applies exact-CAS owner updates", async () => {
    let now = 1_000;
    const value = await fixture(new FakeCloud(),
      () => undefined,
      () => now,
    );
    const { sessionId } = await createIdleSession(value, "Peer policy owner");
    const providerCalls = [...value.codex.calls];

    const initial = await value.service.execute({
      kind: "session.peer-policy.get",
      session: sessionId,
    }, { signal });
    expect(initial).toEqual({
      version: 1,
      sessionId,
      mode: "coordinate",
      revision: 1,
      updatedAt: 1_000,
    });

    now = 2_000;
    const changed = await value.service.execute({
      expectedRevision: 1,
      kind: "session.peer-policy.set",
      mode: "inspect",
      session: sessionId,
    }, { signal });
    expect(changed).toEqual({
      version: 1,
      sessionId,
      mode: "inspect",
      revision: 2,
      updatedAt: 2_000,
    });

    await expect(value.service.execute({
      expectedRevision: 1,
      kind: "session.peer-policy.set",
      mode: "off",
      session: sessionId,
    }, { signal })).rejects.toMatchObject({
      code: "CONFLICT",
      details: { reason: "PEER_SESSION_POLICY_REVISION_CONFLICT" },
    });
    expect(await value.service.execute({
      kind: "session.peer-policy.get",
      session: sessionId,
    }, { signal })).toEqual(changed);

    now = 3_000;
    expect(await value.service.execute({
      expectedRevision: 2,
      kind: "session.peer-policy.set",
      mode: "off",
      session: sessionId,
    }, { signal })).toEqual({
      version: 1,
      sessionId,
      mode: "off",
      revision: 3,
      updatedAt: 3_000,
    });
    expect(value.codex.calls).toEqual(providerCalls);

    await expect(value.service.execute({
      kind: "session.peer-policy.get",
      session: `sess_${"f".repeat(32)}`,
    }, { signal })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
test("cancels a revoked peer queue and dispatches the next human item", async () => {
    const value = await fixture();
    const { sessionId: targetSessionId } = await createIdleSession(
      value,
      "Revoked peer queue target",
    );
    const target = value.store.requireSession(targetSessionId);
    if (target.projectId === undefined || target.providerThreadId === undefined) {
      throw new Error("Expected a project-bound target session.");
    }
    const actorBase = value.store.createSession({
      profileId: target.profileId,
      projectId: target.projectId,
      title: "Revoked peer queue actor",
      provider: "codex",
      preset: "high",
      fastEnabled: false,
    });
    const actorIdle = value.store.bindSession({
      sessionId: actorBase.id,
      expectedRevision: actorBase.revision,
      providerThreadId: "provider-revoked-peer-actor",
      state: "idle",
    });
    value.store.bindSessionProviderAccountAuthority({
      sessionId: actorIdle.id,
      provider: "codex",
      runtimeScope: "managed",
      accountKey: codexProviderAccountKey(),
    });
    const actor = value.store.setSessionTurnState({
      sessionId: actorIdle.id,
      expectedRevision: actorIdle.revision,
      state: "active",
      activeTurnId: "turn-revoked-peer-actor",
    });
    const peerMessage = "This revoked peer message must never reach the provider.";
    const admitted = value.store.admitPeerSessionAction({
      actorSessionId: actor.id,
      actorTurnId: actor.activeTurnId!,
      targetSessionId: target.id,
      expectedTargetRevision: target.revision,
      delivery: "queue",
      requestDigest: createHash("sha256").update("revoked peer request").digest("hex"),
      messageDigest: createHash("sha256").update(peerMessage).digest("hex"),
      reasonDigest: createHash("sha256").update("revoked peer reason").digest("hex"),
      idempotencyKey: crypto.randomUUID(),
      message: peerMessage,
    });
    const actorPolicy = value.store.requirePeerSessionPolicy(actor.id);
    value.store.setPeerSessionPolicy({
      sessionId: actor.id,
      expectedRevision: actorPolicy.revision,
      mode: "off",
    });
    value.codex.readProjection = {
      providerThreadId: target.providerThreadId,
      title: target.title,
      status: "idle",
      providerUpdatedAt: target.providerUpdatedAt ?? 10,
    };
    value.codex.turnStatus = "completed";
    const writesBefore = providerMutationCalls(value.codex).length;
    const humanMessage = "This human queue item must advance after revocation.";

    const human = await value.service.execute({
      idempotencyKey: crypto.randomUUID(),
      kind: "session.queue",
      message: humanMessage,
      session: target.id,
    }, { signal }) as { queued: { id: `queue_${string}` } };
    await value.service.settled();

    expect(value.store.requireQueue(admitted.queue!.id).state).toBe("cancelled");
    expect(value.store.requirePeerSessionAction(admitted.action.id).state).toBe("cancelled");
    expect(value.store.readQueueEffect(admitted.queue!.id)).toBeNull();
    expect(value.store.requireQueue(human.queued.id).state).toBe("applied");
    expect(providerMutationCalls(value.codex)).toHaveLength(writesBefore + 1);
    expect(value.codex.calls.filter((call) => call === "review-turn")).toHaveLength(1);
    expect(value.codex.readProjection.messages?.at(-1)?.text).toBe(humanMessage);
  });
test("cancels a crash-left direct peer admission with no nested mutation on restart", async () => {
    const value = await fixture();
    const { sessionId } = await createIdleSession(value, "Peer restart actor");
    const idleActor = value.store.requireSession(sessionId);
    const actorProjectId = idleActor.projectId;
    if (actorProjectId === undefined) throw new Error("Expected a project-bound actor.");
    const actor = value.store.setSessionTurnState({
      sessionId: idleActor.id,
      expectedRevision: idleActor.revision,
      state: "active",
      activeTurnId: "turn-peer-restart-actor",
    });
    const targetBase = value.store.createSession({
      profileId: actor.profileId,
      projectId: actorProjectId,
      title: "Peer restart target",
      provider: "codex",
      preset: "high",
      fastEnabled: false,
    });
    const target = value.store.bindSession({
      sessionId: targetBase.id,
      expectedRevision: targetBase.revision,
      providerThreadId: "provider-peer-restart-target",
      state: "idle",
    });
    value.store.bindSessionProviderAccountAuthority({
      sessionId: target.id,
      provider: "codex",
      runtimeScope: "managed",
      accountKey: codexProviderAccountKey(),
    });
    const idempotencyKey = crypto.randomUUID();
    const request = {
      actorSessionId: actor.id,
      actorTurnId: actor.activeTurnId!,
      targetSessionId: target.id,
      expectedTargetRevision: target.revision,
      delivery: "send" as const,
      requestDigest: createHash("sha256").update("peer restart request").digest("hex"),
      messageDigest: createHash("sha256").update("peer restart message").digest("hex"),
      reasonDigest: createHash("sha256").update("peer restart reason").digest("hex"),
      idempotencyKey,
    };
    const admitted = value.store.admitPeerSessionAction(request);
    expect(admitted.action.state).toBe("prepared");
    expect(value.store.readMutation(idempotencyKey)).toBeNull();

    await value.service.close();
    const restarted = new OompaService({
      store: value.store,
      paths: value.paths,
      codex: new FakeCodex(),
      cloud: new FakeCloud(),
      daemonAuthority: new FakeDaemonAuthority(),
      eventCursors: value.eventCursors,
      requestStop: () => undefined,
    });
    await restarted.recover();
    expect(value.store.requirePeerSessionAction(admitted.action.id)).toMatchObject({
      state: "cancelled",
    });
    expect(value.store.readMutation(idempotencyKey)).toMatchObject({
      state: "cancelled",
      result: {
        code: "PEER_SESSION_PROVIDER_EFFECT_NOT_STARTED",
        peerActionId: admitted.action.id,
        providerEffectStarted: false,
      },
    });
    expect(value.store.readPeerSessionMutationJoin(idempotencyKey)).toMatchObject({
      action: { id: admitted.action.id, state: "cancelled" },
      attempt: { state: "cancelled" },
    });
    expect(value.store.admitPeerSessionAction(request)).toMatchObject({
      action: { id: admitted.action.id, state: "cancelled" },
      replay: true,
    });
    await restarted.close();
  });
for (const peerEffectStarted of [false, true]) {
    test(`cancels a crash-left ${peerEffectStarted ? "effect-started" : "prepared"} peer action with a prepared nested mutation on restart`, async () => {
      const value = await fixture();
      const { sessionId } = await createIdleSession(
        value,
        `Prepared peer restart ${peerEffectStarted ? "started" : "admitted"}`,
      );
      const idleActor = value.store.requireSession(sessionId);
      const actorProjectId = idleActor.projectId;
      if (actorProjectId === undefined) throw new Error("Expected a project-bound actor.");
      const actor = value.store.setSessionTurnState({
        sessionId: idleActor.id,
        expectedRevision: idleActor.revision,
        state: "active",
        activeTurnId: `turn-peer-prepared-restart-${peerEffectStarted ? "started" : "admitted"}`,
      });
      const targetBase = value.store.createSession({
        profileId: actor.profileId,
        projectId: actorProjectId,
        title: "Prepared peer restart target",
        provider: "codex",
        preset: "high",
        fastEnabled: false,
      });
      const target = value.store.bindSession({
        sessionId: targetBase.id,
        expectedRevision: targetBase.revision,
        providerThreadId: `provider-peer-prepared-restart-${peerEffectStarted ? "started" : "admitted"}`,
        state: "idle",
      });
      value.store.bindSessionProviderAccountAuthority({
        sessionId: target.id,
        provider: "codex",
        runtimeScope: "managed",
        accountKey: codexProviderAccountKey(),
      });
      const idempotencyKey = crypto.randomUUID();
      const message = "prepared peer restart message";
      const request = {
        actorSessionId: actor.id,
        actorTurnId: actor.activeTurnId!,
        targetSessionId: target.id,
        expectedTargetRevision: target.revision,
        delivery: "send" as const,
        requestDigest: createHash("sha256").update("prepared peer restart request").digest("hex"),
        messageDigest: createHash("sha256").update(message).digest("hex"),
        reasonDigest: createHash("sha256").update("prepared peer restart reason").digest("hex"),
        idempotencyKey,
      };
      const admitted = value.store.admitPeerSessionAction(request);
      const prepared = value.store.prepareSessionInputMutation({
        kind: "session.send",
        sessionId: target.id,
        providerAuthority: value.store.requireProviderAccountAuthority(target.profileId, "codex"),
        message,
        attachments: [],
        idempotencyKey,
        daemonGeneration: value.daemonGeneration,
        bootId: value.daemonBootId,
      });
      if (peerEffectStarted) value.store.beginPeerSessionActionEffect(admitted.action.id);
      expect(value.store.requirePeerSessionAction(admitted.action.id).state)
        .toBe(peerEffectStarted ? "effect_started" : "prepared");
      expect(value.store.readMutation(idempotencyKey)?.state).toBe("prepared");

      await value.service.close();
      const restartedCodex = new FakeCodex();
      const restarted = new OompaService({
        store: value.store,
        paths: value.paths,
        codex: restartedCodex,
        cloud: new FakeCloud(),
        daemonAuthority: new FakeDaemonAuthority(),
        eventCursors: value.eventCursors,
        requestStop: () => undefined,
      });
      await restarted.recover();

      expect(value.store.requirePeerSessionAction(admitted.action.id).state).toBe("cancelled");
      expect(value.store.readMutation(idempotencyKey)).toMatchObject({
        id: prepared.attempt.id,
        kind: "session.send",
        state: "cancelled",
      });
      // Genuine retained input keeps its own no-effect custody receipt; the
      // terminal peer action, not an invented mutation result, proves cancel.
      expect(value.store.readMutation(idempotencyKey)?.result).toBeUndefined();
      expect(value.store.readPeerSessionMutationJoin(idempotencyKey)).toMatchObject({
        action: { id: admitted.action.id, state: "cancelled" },
        attempt: { id: prepared.attempt.id, state: "cancelled" },
      });
      expect(providerMutationCalls(restartedCodex)).toEqual([]);
      await restarted.close();
    });
  }
test("resumes an exact live peer replay with a prepared nested mutation", async () => {
    const value = await fixture();
    const { sessionId: actorSessionId } = await createIdleSession(value, "Prepared live peer replay");
    const idleActor = value.store.requireSession(actorSessionId);
    if (idleActor.projectId === undefined || idleActor.providerThreadId === undefined) {
      throw new Error("Expected a project-bound actor session.");
    }
    const targetBase = value.store.createSession({
      profileId: idleActor.profileId,
      projectId: idleActor.projectId,
      title: "Prepared live peer replay target",
      provider: "codex",
      preset: "high",
      fastEnabled: false,
    });
    const target = value.store.bindSession({
      sessionId: targetBase.id,
      expectedRevision: targetBase.revision,
      providerThreadId: "provider-peer-prepared-live-replay",
      state: "idle",
      providerUpdatedAt: 11,
    });
    value.store.bindSessionProviderAccountAuthority({
      sessionId: target.id,
      provider: "codex",
      runtimeScope: "managed",
      accountKey: codexProviderAccountKey(),
    });
    await value.service.execute({
      kind: "session.send",
      session: actorSessionId,
      message: "Start the peer replay actor.",
    }, { signal });
    const actor = value.store.requireSession(actorSessionId);
    const profile = value.store.requireProfileById(actor.profileId);
    if (actor.providerThreadId === undefined || actor.activeTurnId === undefined) {
      throw new Error("Expected an active bound actor turn.");
    }
    value.codex.readProjection = {
      providerThreadId: target.providerThreadId!,
      title: target.title,
      status: "idle",
      providerUpdatedAt: 11,
    };
    const authority: ProfileAuthority = liveAuthorityFor(value.store, profile.id, "codex");
    const call = {
      authority: hostToolAuthorityFor(liveAuthorityFor(value.store, profile.id)),
      callId: "peer-prepared-live-replay",
      connectionId: value.codex.observationConnectionId,
      input: {
        sessionId: target.id,
        expectedRevision: target.revision,
        delivery: "send" as const,
        message: "Resume only this exact prepared message.",
        reason: "Prove live replay remains resumable",
      },
      requestDigest: createHash("sha256").update("peer-prepared-live-replay").digest("hex"),
      requestId: { type: "string" as const, value: "peer-prepared-live-replay" },
      threadId: actor.providerThreadId,
      tool: "session_message" as const,
      turnId: actor.activeTurnId,
    } satisfies OompaHostToolCall;
    const originalBegin = value.store.beginSessionMutationEffect.bind(value.store);
    let injected = false;
    (value.store as unknown as {
      beginSessionMutationEffect: StateStore["beginSessionMutationEffect"];
    }).beginSessionMutationEffect = (input) => {
      if (!injected && input.sessionId === target.id) {
        injected = true;
        const action = value.store.listUnsettledPeerSessionActions(10)[0];
        if (action === undefined) throw new Error("Expected a prepared peer action.");
        value.store.beginPeerSessionActionEffect(action.id);
        throw new Error("injected before nested mutation begin");
      }
      return originalBegin(input);
    };
    const providerWritesBefore = providerMutationCalls(value.codex);

    await expect(value.service.handleOompaHostToolCall(
      authority,
      call,
      MANAGED_CODEX_HOST_TOOL_PROVENANCE,
    ))
      .rejects.toThrow("injected before nested mutation begin");
    const unsettled = value.store.listUnsettledPeerSessionActions(10);
    expect(unsettled).toHaveLength(1);
    expect(unsettled[0]).toMatchObject({ state: "ambiguous", targetSessionId: target.id });
    expect(value.store.readMutation(unsettled[0]!.idempotencyKey)?.state).toBe("prepared");
    expect(providerMutationCalls(value.codex)).toEqual(providerWritesBefore);

    (value.store as unknown as {
      beginSessionMutationEffect: StateStore["beginSessionMutationEffect"];
    }).beginSessionMutationEffect = originalBegin;
    const replayed = await value.service.handleOompaHostToolCall(
      authority,
      call,
      MANAGED_CODEX_HOST_TOOL_PROVENANCE,
    );
    expect(replayed).toMatchObject({
      ok: true,
      replay: true,
      action: { state: "applied", targetSessionId: target.id },
    });
    expect(providerMutationCalls(value.codex)).toHaveLength(providerWritesBefore.length + 1);
  });
test("settles an applied nested peer send after restart without replaying the provider", async () => {
    const value = await fixture();
    const { sessionId: actorSessionId } = await createIdleSession(
      value,
      "Applied peer receipt restart",
    );
    const idleActor = value.store.requireSession(actorSessionId);
    if (idleActor.projectId === undefined || idleActor.providerThreadId === undefined) {
      throw new Error("Expected a project-bound actor session.");
    }
    const targetBase = value.store.createSession({
      profileId: idleActor.profileId,
      projectId: idleActor.projectId,
      title: "Applied peer receipt restart target",
      provider: "codex",
      preset: "high",
      fastEnabled: false,
    });
    const target = value.store.bindSession({
      sessionId: targetBase.id,
      expectedRevision: targetBase.revision,
      providerThreadId: "provider-peer-applied-restart",
      state: "idle",
      providerUpdatedAt: 11,
    });
    if (target.providerThreadId === undefined) throw new Error("Expected a bound peer target.");
    value.store.bindSessionProviderAccountAuthority({
      sessionId: target.id,
      provider: "codex",
      runtimeScope: "managed",
      accountKey: codexProviderAccountKey(),
    });
    await value.service.execute({
      kind: "session.send",
      session: actorSessionId,
      message: "Start the applied-receipt peer actor.",
    }, { signal });
    const actor = value.store.requireSession(actorSessionId);
    const profile = value.store.requireProfileById(actor.profileId);
    if (actor.providerThreadId === undefined || actor.activeTurnId === undefined) {
      throw new Error("Expected an active bound actor turn.");
    }
    value.codex.readProjection = {
      providerThreadId: target.providerThreadId,
      title: target.title,
      status: "idle",
      providerUpdatedAt: 11,
    };
    const authority: ProfileAuthority = liveAuthorityFor(value.store, profile.id, "codex");
    const call = {
      authority: hostToolAuthorityFor(liveAuthorityFor(value.store, profile.id)),
      callId: "peer-applied-receipt-restart",
      connectionId: value.codex.observationConnectionId,
      input: {
        sessionId: target.id,
        expectedRevision: target.revision,
        delivery: "send" as const,
        message: "Commit this nested peer send exactly once.",
        reason: "Prove restart joins the applied nested receipt",
      },
      requestDigest: createHash("sha256").update("peer-applied-receipt-restart").digest("hex"),
      requestId: { type: "string" as const, value: "peer-applied-receipt-restart" },
      threadId: actor.providerThreadId,
      tool: "session_message" as const,
      turnId: actor.activeTurnId,
    } satisfies OompaHostToolCall;
    const originalSettle = value.store.settlePeerSessionAction.bind(value.store);
    let injectedSettlements = 0;
    (value.store as unknown as {
      settlePeerSessionAction: StateStore["settlePeerSessionAction"];
    }).settlePeerSessionAction = (input) => {
      if (input.state === "applied") {
        injectedSettlements += 1;
        throw new Error("injected after nested peer receipt commit");
      }
      return originalSettle(input);
    };
    const providerWritesBefore = providerMutationCalls(value.codex);
    try {
      await expect(value.service.handleOompaHostToolCall(
        authority,
        call,
        MANAGED_CODEX_HOST_TOOL_PROVENANCE,
      )).rejects.toThrow("injected after nested peer receipt commit");
    } finally {
      (value.store as unknown as {
        settlePeerSessionAction: StateStore["settlePeerSessionAction"];
      }).settlePeerSessionAction = originalSettle;
    }

    expect(injectedSettlements).toBe(2);
    const [unsettled] = value.store.listUnsettledPeerSessionActions(10);
    if (unsettled === undefined) throw new Error("Expected an unsettled peer action.");
    expect(unsettled).toMatchObject({ state: "effect_started", targetSessionId: target.id });
    expect(value.store.readMutation(unsettled.idempotencyKey)).toMatchObject({
      state: "applied",
      result: { turnId: "turn-next-2" },
    });
    expect(providerMutationCalls(value.codex)).toHaveLength(providerWritesBefore.length + 1);

    const oldStoreIndex = stores.indexOf(value.store);
    if (oldStoreIndex < 0) throw new Error("Expected the fixture store to be tracked.");
    value.daemonAuthority.invalidate();
    value.store.close();
    stores.splice(oldStoreIndex, 1);
    const restartedStore = new StateStore(value.paths);
    stores.push(restartedStore);
    const daemonGeneration = restartedStore.nextDaemonGeneration(`boot_${"a".repeat(32)}`);
    const restartedCodex = new FakeCodex();
    restartedCodex.observationConnectionId = "30000000-0000-4000-8000-000000000002";
    expect(restartedCodex.observationConnectionId).not.toBe(call.connectionId);
    restartedCodex.readProjection = {
      providerThreadId: actor.providerThreadId,
      title: actor.title,
      status: "active",
      activeTurnId: actor.activeTurnId,
      providerUpdatedAt: 100,
    };
    const restarted = new OompaService({
      store: restartedStore,
      paths: value.paths,
      codex: restartedCodex,
      cloud: new FakeCloud(),
      daemonAuthority: new FakeDaemonAuthority(),
      daemonGeneration,
      eventCursors: value.eventCursors,
      requestStop: () => undefined,
    });
    await restarted.recover();
    const recoveredAction = restartedStore.requirePeerSessionAction(unsettled.id);
    expect(recoveredAction.state).toBe("applied");
    expect(typeof recoveredAction.targetTurnDigest).toBe("string");
    expect(providerMutationCalls(restartedCodex)).toEqual([]);

    const restartedProfile = restartedStore.requireProfileById(actor.profileId);
    const replayAuthority = {
      ...authority,
      generation: restartedProfile.processGeneration,
    };
    const replayCall = {
      ...call,
      authority: {
        ...call.authority,
        processGeneration: restartedProfile.processGeneration,
      },
      connectionId: restartedCodex.observationConnectionId,
    } satisfies OompaHostToolCall;
    const replayed = await restarted.handleOompaHostToolCall(
      replayAuthority,
      replayCall,
      MANAGED_CODEX_HOST_TOOL_PROVENANCE,
    );
    expect(replayed).toMatchObject({
      ok: true,
      replay: true,
      action: { state: "applied", targetSessionId: target.id },
    });
    expect(providerMutationCalls(restartedCodex)).toEqual([]);
    await restarted.close();
  });
test("refuses the thirty-third peer steer before dispatch at target-turn origin capacity", async () => {
    const { value, actor, target, authority, callFor } = await createPeerMessageBoundaryFixture("steer");
    let lastAcceptedCall: ReturnType<typeof callFor> | undefined;
    for (let index = 0; index < 32; index += 1) {
      const call = callFor(index);
      lastAcceptedCall = call;
      await expect(value.service.handleOompaHostToolCall(
        authority,
        call,
        MANAGED_CODEX_HOST_TOOL_PROVENANCE,
      )).resolves.toMatchObject({
        ok: true,
        replay: false,
        action: { state: "applied", delivery: "steer", hop: 1 },
      });
    }
    expect(value.store.readPeerSessionTurnOrigins({
      sessionId: actor.id,
      turnId: actor.activeTurnId!,
    })).toEqual([]);
    expect(value.store.readPeerSessionTurnOrigins({
      sessionId: target.id,
      turnId: "turn-peer-boundary-target",
    })).toHaveLength(32);
    expect(value.codex.calls.filter((call) => call === "steer")).toHaveLength(32);
    const writesBeforeRefusal = providerMutationCalls(value.codex);

    const refused = await value.service.handleOompaHostToolCall(
      authority,
      callFor(32),
      MANAGED_CODEX_HOST_TOOL_PROVENANCE,
    );
    expect(refused).toMatchObject({
      version: 1,
      ok: false,
      code: "PEER_SESSION_CAUSAL_LIMIT_REFUSED",
    });
    expect(providerMutationCalls(value.codex)).toEqual(writesBeforeRefusal);
    expect(value.store.listUnsettledPeerSessionActions(10)).toEqual([]);
    expect(value.store.readPeerSessionTurnOrigins({
      sessionId: target.id,
      turnId: "turn-peer-boundary-target",
    })).toHaveLength(32);
    if (lastAcceptedCall === undefined) throw new Error("Expected a retained successful peer call.");
    await expect(value.service.handleOompaHostToolCall(
      authority,
      lastAcceptedCall,
      MANAGED_CODEX_HOST_TOOL_PROVENANCE,
    )).resolves.toMatchObject({ ok: true, replay: true, action: { state: "applied" } });
    await value.service.recover();
    expect(providerMutationCalls(value.codex)).toEqual(writesBeforeRefusal);
    expect(value.store.listUnsettledPeerSessionActions(10)).toEqual([]);
    await value.service.close();
  }, 30_000);
for (const delivery of ["send", "steer"] as const) {
    for (const resolution of ["proven_applied", "abandoned"] as const) {
      test.each([false, true])(
        `resolves uncertain peer ${delivery} after a real lost response as ${resolution} with legacy observation=%s`,
        async (legacyObservation) => {
          const { value, target, authority, callFor } = await createPeerMessageBoundaryFixture(delivery);
          const call = callFor(0);
          const lostResponse = new IndeterminateCodexEffectError(
            delivery === "send" ? "turn/start" : "turn/steer",
            81,
          );
          // Both existing fake-runtime errors occur after its provider message
          // and client id are recorded, not before the service begins the effect.
          if (delivery === "send") value.codex.startTurnError = lostResponse;
          else value.codex.steerError = lostResponse;
          const writesBeforeEffect = providerMutationCalls(value.codex);
          await expect(value.service.handleOompaHostToolCall(
            authority,
            call,
            MANAGED_CODEX_HOST_TOOL_PROVENANCE,
          )).resolves.toMatchObject({ ok: false, code: "RECOVERY_REQUIRED" });
          delete value.codex.startTurnError;
          delete value.codex.steerError;

          const [action] = value.store.listUnsettledPeerSessionActions(10);
          if (action === undefined) throw new Error("Expected the real uncertain peer effect.");
          expect(action).toMatchObject({ state: "ambiguous", delivery, targetSessionId: target.id });
          expect(action.resultDigest).toBeUndefined();
          const attempt = value.store.readMutation(action.idempotencyKey);
          expect(attempt).toMatchObject({
            state: "ambiguous",
            evidence: { evidence: { kind: `session.${delivery}`, messageActor: "peer_session" } },
          });
          if (attempt?.evidence === undefined) throw new Error("Expected immutable provider-effect evidence.");
          const originalEvidence = attempt.evidence;
          const providerMessage = value.codex.readProjection.messages?.find((message) =>
            message.clientId === attempt.id);
          expect(providerMessage).toMatchObject({ role: "user", clientId: attempt.id });
          if (providerMessage?.turnId === undefined) throw new Error("Expected the accepted provider turn.");
          const targetTurnId = providerMessage.turnId;
          expect(value.store.requireSession(target.id).state).toBe("recovery_required");
          expect(providerMutationCalls(value.codex)).toHaveLength(writesBeforeEffect.length + 1);

          const legacyMarker = createHash("sha256")
            .update(JSON.stringify({ code: "EFFECT_OUTCOME_UNSETTLED" })).digest("hex");
          if (legacyObservation) {
            // Represent the exact historical marker without changing the real
            // lost-response evidence or weakening its immutable transition.
            value.store.settlePeerSessionAction({
              actionId: action.id,
              expectedState: "ambiguous",
              state: "ambiguous",
              resultDigest: legacyMarker,
            });
            expect(value.store.requirePeerSessionAction(action.id).resultDigest).toBe(legacyMarker);
          }
          const expectedFinalDigest = legacyObservation
            ? legacyMarker
            : createHash("sha256").update(JSON.stringify(resolution === "proven_applied"
                ? { targetTurnId }
                : { mutationState: "reconciled", resolution: "abandoned" })).digest("hex");
          const writesBeforeRecovery = providerMutationCalls(value.codex);

          const recovered = await value.service.execute({
            kind: resolution === "proven_applied" ? "session.recover" : "session.abandon",
            session: target.id,
          }, { signal });
          expect(recovered).toMatchObject({
            recovery: { resolved: true, resolution, providerEffectRetried: false },
          });
          expect(value.store.readMutation(action.idempotencyKey)).toMatchObject({
            state: "reconciled",
            originalState: "ambiguous",
            resolution: { kind: resolution },
            evidence: originalEvidence,
          });
          expect(value.store.requirePeerSessionAction(action.id)).toMatchObject({
            state: resolution === "proven_applied" ? "applied" : "failed",
            resultDigest: expectedFinalDigest,
          });
          const origins = value.store.readPeerSessionTurnOrigins({ sessionId: target.id, turnId: targetTurnId });
          expect(origins.map((origin) => origin.id))
            .toEqual(resolution === "proven_applied" ? [action.id] : []);
          expect(value.store.sessionMessageActorForSource(target.id, attempt.id)).toBe("peer_session");
          if (resolution === "proven_applied") {
            const userMessageActors = value.store.listSessionEvents({ sessionId: target.id, afterSequence: 0 }).events
              .flatMap(({ body }) => body.type === "user_message" ? [body.actor] : []);
            expect(userMessageActors).toEqual(["peer_session"]);
          }
          await value.service.recover();
          expect(value.store.requirePeerSessionAction(action.id).resultDigest).toBe(expectedFinalDigest);
          expect(value.store.listUnsettledPeerSessionActions(10)).toEqual([]);
          expect(providerMutationCalls(value.codex)).toEqual(writesBeforeRecovery);
          await value.service.close();
        },
      );
    }
  }
for (const delivery of ["send", "steer", "queue"] as const) {
    describe(`refuses a return peer steer after abandoning an accepted uncertain peer ${delivery}`, () => {
      let owner: ReturnType<typeof createOwnedServiceCase> | undefined;
      let prepared: Awaited<ReturnType<typeof prepareAbandonedPeerScenario>> | undefined;
      beforeEach(() => {
        owner = createOwnedServiceCase();
        prepared = undefined;
        return owner.run(async (context) => {
          const value = await prepareAbandonedPeerScenario(delivery, context);
          context.signal.throwIfAborted();
          prepared = value;
        });
      }, 5_000);

      test("retains the coupled abandonment, refusal, inspection, and fresh-turn proof", () => {
        if (owner === undefined) throw new Error("Expected the prepared peer case owner.");
        return owner.run(async ({ signal }) => {
          if (prepared === undefined) throw new Error("Expected fresh prepared peer accounts and sessions.");
          const { value, actor, actorProjection, actorTurnId, target } = prepared;
          expect(target.profileId).not.toBe(actor.profileId);
          expect(target.projectId).toBe(actor.projectId);
          expect(value.store.readSessionHostCapabilityBinding(actor.id)).not.toBeNull();
          expect(value.store.readSessionHostCapabilityBinding(target.id)).not.toBeNull();

          const authorityFor = (source: SessionRecord): ProfileAuthority => {
            return liveAuthorityFor(value.store, source.profileId);
          };
          const messageCall = (
            source: SessionRecord,
            turnId: string,
            destination: SessionRecord,
            messageDelivery: "send" | "steer" | "queue",
            callId: string,
          ): Extract<OompaHostToolCall, { tool: "session_message" }> => {
            if (source.providerThreadId === undefined) throw new Error("Expected a bound provider thread.");
            const authority = authorityFor(source);
            const input = {
              sessionId: destination.id,
              expectedRevision: value.store.requireSession(destination.id).revision,
              delivery: messageDelivery,
              message: "Continue the same peer coordination chain.",
              reason: "Preserve causal authority across owner abandonment",
            };
            return {
              authority: hostToolAuthorityFor(authority),
              callId,
              connectionId: value.codex.observationConnectionId,
              input,
              requestDigest: createHash("sha256").update(JSON.stringify(input)).digest("hex"),
              requestId: { type: "string", value: callId },
              threadId: source.providerThreadId,
              tool: "session_message",
              turnId,
            };
          };
          const firstCall = messageCall(actor, actorTurnId, target, delivery, `abandoned-${delivery}-outbound`);
          const writesBeforeEffect = providerMutationCalls(value.codex);
          const lostResponse = new IndeterminateCodexEffectError(
            delivery === "steer" ? "turn/steer" : "turn/start",
            82,
          );
          if (delivery === "steer") value.codex.steerError = lostResponse;
          else value.codex.startTurnError = lostResponse;
          const firstResult = await value.service.handleOompaHostToolCall(
            authorityFor(actor), firstCall, MANAGED_CODEX_HOST_TOOL_PROVENANCE,
          );
          if (delivery === "queue") {
            expect(firstResult).toMatchObject({ ok: true, action: { state: "queued" } });
            await value.service.settled();
          } else {
            expect(firstResult).toMatchObject({ ok: false, code: "RECOVERY_REQUIRED" });
          }
          delete value.codex.startTurnError;
          delete value.codex.steerError;

          const [outbound] = value.store.listUnsettledPeerSessionActions(10);
          if (outbound === undefined) throw new Error("Expected the uncertain outbound peer action.");
          const queue = delivery === "queue"
            ? value.store.listQueue(target.id).find((entry) => entry.peerActionId === outbound.id)
            : undefined;
          const attempt = delivery === "queue" ? null : value.store.readMutation(outbound.idempotencyKey);
          if (delivery === "queue") {
            if (queue === undefined) throw new Error("Expected the attributed queued provider effect.");
            expect(queue).toMatchObject({ state: "ambiguous", messageActor: "peer_session" });
            expect(value.store.readQueueEffect(queue.id)?.resolution).toBeUndefined();
          } else {
            if (attempt === null) throw new Error("Expected the nested provider effect.");
            expect(attempt).toMatchObject({ state: "ambiguous" });
          }
          const acceptedSourceId = queue?.id ?? attempt?.id;
          if (acceptedSourceId === undefined) throw new Error("Expected the accepted source identity.");
          const acceptedMessage = value.codex.readProjection.messages?.find((message) => message.clientId === acceptedSourceId);
          if (acceptedMessage?.turnId === undefined) throw new Error("Expected the actually accepted target message.");
          const targetTurnId = acceptedMessage.turnId;
          expect(value.codex.readProjection).toMatchObject({ status: "active", activeTurnId: targetTurnId });
          expect(providerMutationCalls(value.codex)).toHaveLength(writesBeforeEffect.length + 1);
          expect(value.store.requireSession(target.id).state).toBe("recovery_required");

          await expect(value.service.execute({ kind: "session.abandon", session: target.id }, { signal }))
            .resolves.toMatchObject({
              recovery: { resolved: true, resolution: "abandoned", providerEffectRetried: false },
            });
          if (queue !== undefined) {
            expect(value.store.readQueueEffect(queue.id)).toMatchObject({ resolution: { kind: "abandoned" } });
          } else {
            expect(value.store.readMutation(outbound.idempotencyKey)).toMatchObject({
              state: "reconciled",
              resolution: { kind: "abandoned" },
            });
          }
          expect(providerMutationCalls(value.codex)).toHaveLength(writesBeforeEffect.length + 1);
          const abandonedTargetProjection = value.codex.readProjection;

          // The provider already consumed the outbound message. A fresh callback
          // from that same target turn must not restart its ancestry at hop one.
          value.codex.readProjection = actorProjection;
          const returnCall = messageCall(target, targetTurnId, actor, "steer", `abandoned-${delivery}-return`);
          const writesBeforeReturn = providerMutationCalls(value.codex);
          const returned = await value.service.handleOompaHostToolCall(
            authorityFor(target), returnCall, MANAGED_CODEX_HOST_TOOL_PROVENANCE,
          );
          expect({
            providerWrites: providerMutationCalls(value.codex),
            returnOrigins: value.store.readPeerSessionTurnOrigins({ sessionId: actor.id, turnId: actorTurnId })
              .map((origin) => ({ hop: origin.hop, parentActionIds: origin.parentActionIds })),
          }).toEqual({ providerWrites: writesBeforeReturn, returnOrigins: [] });
          expect(returned).toMatchObject({ ok: false, code: "PEER_SESSION_ACTOR_TURN_REFUSED" });

          const inspectionInput = {
            sessionId: actor.id,
            expectedRevision: value.store.requireSession(actor.id).revision,
            limit: 10,
          };
          const inspectionCallId = `abandoned-${delivery}-inspect`;
          await expect(value.service.handleOompaHostToolCall(authorityFor(target), {
            ...returnCall,
            callId: inspectionCallId,
            input: inspectionInput,
            requestDigest: createHash("sha256").update(JSON.stringify(inspectionInput)).digest("hex"),
            requestId: { type: "string", value: inspectionCallId },
            tool: "session_inspect",
          }, MANAGED_CODEX_HOST_TOOL_PROVENANCE)).resolves.toMatchObject({ ok: true });
          expect(providerMutationCalls(value.codex)).toEqual(writesBeforeReturn);

          // The fence is not a session-wide loss of owner control. Stop the
          // affected turn, then start a separately receipted human turn normally.
          value.codex.readProjection = abandonedTargetProjection;
          await expect(value.service.execute({ kind: "session.stop", session: target.id }, { signal }))
            .resolves.toMatchObject({ stopped: true, session: { state: "idle" } });
          expect(providerMutationCalls(value.codex)).toEqual([...writesBeforeReturn, "stop"]);
          const humanKey = crypto.randomUUID();
          await value.service.execute({
            kind: "session.send",
            idempotencyKey: humanKey,
            session: target.id,
            message: "Begin an independent owner-directed coordination turn.",
          }, { signal });
          const freshTarget = value.store.requireSession(target.id);
          const freshTargetTurnId = freshTarget.activeTurnId;
          if (freshTargetTurnId === undefined) throw new Error("Expected a new human-started turn.");
          expect(freshTargetTurnId).not.toBe(targetTurnId);
          const humanAttempt = value.store.readMutation(humanKey);
          if (humanAttempt === null) throw new Error("Expected the independent human mutation receipt.");
          expect(humanAttempt).toMatchObject({ kind: "session.send", state: "applied" });
          expect(value.store.sessionMessageActorForSource(target.id, humanAttempt.id)).toBe("human");
          expect(value.store.readPeerSessionTurnOrigins({
            sessionId: target.id, turnId: freshTargetTurnId,
          })).toEqual([]);

          value.codex.readProjection = actorProjection;
          const freshCall = messageCall(
            freshTarget, freshTargetTurnId, actor, "steer", `abandoned-${delivery}-fresh-turn`,
          );
          const writesBeforeFreshCoordination = providerMutationCalls(value.codex);
          await expect(value.service.handleOompaHostToolCall(
            authorityFor(freshTarget), freshCall, MANAGED_CODEX_HOST_TOOL_PROVENANCE,
          )).resolves.toMatchObject({ ok: true, action: { state: "applied" } });
          expect(providerMutationCalls(value.codex)).toEqual([...writesBeforeFreshCoordination, "steer"]);
          expect(value.store.readPeerSessionTurnOrigins({ sessionId: actor.id, turnId: actorTurnId })
            .map((origin) => ({ hop: origin.hop, parentActionIds: origin.parentActionIds })))
            .toEqual([{ hop: 1, parentActionIds: [] }]);
        });
      }, 5_000);
    });
  }
test.each(["recovery_required", "removed"] as const)(
    "fences recovery-blocked Claude targets and terminal history under removed profiles (%s)",
    (profileState) => ownedServiceCase(async ({ createFixture, signal }) => {
      const provider = "claude";
      const value = await claudeAccountFixture(true, "linux", createFixture);
      signal.throwIfAborted();
      const fence = profileState === "removed" ? "removed" : "recovery-fenced";
      const { sessionId: actorSessionId } = await createIdleSession(
        value,
        `${provider} ${fence} peer actor`,
      );
      signal.throwIfAborted();
      const idleActor = value.store.requireSession(actorSessionId);
      if (idleActor.projectId === undefined) throw new Error("Expected a project-bound actor.");
      const targetProfile = value.store.createProfile(`${provider} ${fence} target`);
      const targetBase = value.store.createSession({
        profileId: targetProfile.id,
        projectId: idleActor.projectId,
        title: `${provider} ${fence} target`,
        provider,
        preset: "fable-max",
        fastEnabled: false,
      });
      const target = value.store.bindSession({
        sessionId: targetBase.id,
        expectedRevision: targetBase.revision,
        providerThreadId: `provider-${provider}-${fence}-target`,
        state: "idle",
      });
      if (profileState === "removed") {
        // Removal requires all owned sessions to be terminal. Do not invent
        // the impossible current state of a live session on a removed owner.
        value.store.setSessionTurnState({
          sessionId: target.id,
          expectedRevision: target.revision,
          state: "terminal",
        });
        value.store.removeProfile(targetProfile.id);
        expect(value.store.requireProfileById(targetProfile.id, { includeRemoved: true }).state).toBe("removed");
      } else {
        expect(value.store.setProfileState(
          targetProfile.id,
          targetProfile.processGeneration,
          profileState,
        )).toBe(true);
      }

      // The terminal-session fence precedes profile selection on direct input.
      const establishedCode = profileState === "removed" ? "CONFLICT" : "RECOVERY_REQUIRED";
      await expect(value.service.execute({
        kind: "session.send",
        session: target.id,
        message: `Do not dispatch while the profile is ${profileState}.`,
      }, { signal })).rejects.toMatchObject({ code: establishedCode });
      signal.throwIfAborted();
      await expect(value.service.execute({
        kind: "session.queue",
        session: target.id,
        message: `Do not enqueue while the profile is ${profileState}.`,
      }, { signal })).rejects.toMatchObject({ code: establishedCode });
      signal.throwIfAborted();
      expect(value.store.listQueue(target.id)).toEqual([]);
      expect(value.providerSessionCalls).toEqual([]);

      await value.service.execute({
        kind: "session.send",
        session: actorSessionId,
        message: "Start the peer actor.",
      }, { signal });
      signal.throwIfAborted();
      const actor = value.store.requireSession(actorSessionId);
      const actorProfile = value.store.requireProfileById(actor.profileId);
      if (actor.providerThreadId === undefined || actor.activeTurnId === undefined) {
        throw new Error("Expected an active bound peer actor.");
      }
      const authority: ProfileAuthority = liveAuthorityFor(value.store, actorProfile.id, "codex");
      const base = {
        authority: hostToolAuthorityFor(liveAuthorityFor(value.store, actorProfile.id)),
        connectionId: value.codex.observationConnectionId,
        requestId: { type: "string" as const, value: `${provider}-${fence}-peer` },
        threadId: actor.providerThreadId,
        tool: "session_message" as const,
        turnId: actor.activeTurnId,
      } as const;
      for (const delivery of ["send", "queue"] as const) {
        const result = await value.service.handleOompaHostToolCall(authority, {
          ...base,
          callId: `${provider}-${fence}-peer-${delivery}`,
          input: {
            sessionId: target.id,
            expectedRevision: target.revision,
            delivery,
            message: `Do not ${delivery} into a ${fence} target.`,
            reason: `Target profile is ${profileState}`,
          },
          requestDigest: createHash("sha256")
            .update(`${provider}-${fence}-peer-${delivery}`).digest("hex"),
        } satisfies OompaHostToolCall, MANAGED_CODEX_HOST_TOOL_PROVENANCE);
        signal.throwIfAborted();
        expect(result).toEqual({
          version: 1,
          ok: false,
          code: "RECOVERY_REQUIRED",
        });
      }
      expect(value.store.listUnsettledPeerSessionActions(10)).toEqual([]);
      expect(value.store.listQueue(target.id)).toEqual([]);
      expect(value.providerSessionCalls).toEqual([]);
    }),
    5_000,
  );
test("revalidates peer actor account authority after its mutation locks are acquired", async () => {
    const cloud = new FakeCloud();
    const value = await fixture(cloud);
    const { sessionId: actorSessionId } = await createIdleSession(
      value,
      "Peer actor authority race",
    );
    const idleActor = value.store.requireSession(actorSessionId);
    if (idleActor.projectId === undefined) throw new Error("Expected a project-bound actor.");
    const targetBase = value.store.createSession({
      profileId: idleActor.profileId,
      projectId: idleActor.projectId,
      title: "Peer actor authority race target",
      provider: "codex",
      preset: "high",
      fastEnabled: false,
    });
    const target = value.store.bindSession({
      sessionId: targetBase.id,
      expectedRevision: targetBase.revision,
      providerThreadId: "provider-peer-actor-authority-race-target",
      state: "idle",
    });
    await value.service.execute({
      kind: "session.send",
      session: actorSessionId,
      message: "Start the peer actor authority race.",
    }, { signal });
    const actor = value.store.requireSession(actorSessionId);
    const profile = value.store.requireProfileById(actor.profileId);
    if (actor.providerThreadId === undefined || actor.activeTurnId === undefined) {
      throw new Error("Expected an active bound actor turn.");
    }
    const authority: ProfileAuthority = liveAuthorityFor(value.store, profile.id, "codex");
    const call = {
      authority: hostToolAuthorityFor(liveAuthorityFor(value.store, profile.id)),
      callId: "peer-actor-authority-race",
      connectionId: value.codex.observationConnectionId,
      input: {
        sessionId: target.id,
        expectedRevision: target.revision,
        delivery: "send" as const,
        message: "This stale actor must not dispatch.",
        reason: "Prove post-lock actor revalidation",
      },
      requestDigest: createHash("sha256").update("peer-actor-authority-race").digest("hex"),
      requestId: { type: "string" as const, value: "peer-actor-authority-race" },
      threadId: actor.providerThreadId,
      tool: "session_message" as const,
      turnId: actor.activeTurnId,
    } satisfies OompaHostToolCall;
    const originalAdmission = value.store.admitPeerSessionAction.bind(value.store);
    let admissionCalls = 0;
    (value.store as unknown as {
      admitPeerSessionAction: StateStore["admitPeerSessionAction"];
    }).admitPeerSessionAction = (input) => {
      admissionCalls += 1;
      return originalAdmission(input);
    };
    let authorityInvalidated = false;
    cloud.beforeProjectionUnsettledSessionReturn = async (sessionPublicId) => {
      if (authorityInvalidated || sessionPublicId !== actor.id) return;
      authorityInvalidated = true;
      expect(value.store.setProfileState(
        profile.id,
        profile.processGeneration,
        "signed_out",
      )).toBe(true);
    };
    const providerWritesBefore = providerMutationCalls(value.codex);

    await expect(value.service.handleOompaHostToolCall(
      authority,
      call,
      MANAGED_CODEX_HOST_TOOL_PROVENANCE,
    ))
      .rejects.toThrow("OOMPA_HOST_TOOL_AUTHORITY_STALE");
    expect(authorityInvalidated).toBe(true);
    expect(admissionCalls).toBe(0);
    expect(value.store.listUnsettledPeerSessionActions(10)).toEqual([]);
    expect(value.store.listQueue(target.id)).toEqual([]);
    expect(providerMutationCalls(value.codex)).toEqual(providerWritesBefore);
  });
test("refuses a peer target that moved to an account whose lock was not acquired", async () => {
    const cloud = new FakeCloud();
    const value = await fixture(cloud);
    const { sessionId: actorSessionId } = await createIdleSession(
      value,
      "Peer target lock freshness actor",
    );
    const idleActor = value.store.requireSession(actorSessionId);
    if (idleActor.projectId === undefined) throw new Error("Expected a project-bound actor.");
    const targetBase = value.store.createSession({
      profileId: idleActor.profileId,
      projectId: idleActor.projectId,
      title: "Peer target lock freshness target",
      provider: "codex",
      preset: "high",
      fastEnabled: false,
    });
    const target = value.store.bindSession({
      sessionId: targetBase.id,
      expectedRevision: targetBase.revision,
      providerThreadId: "provider-peer-target-lock-freshness",
      state: "idle",
    });
    const movedProfile = value.store.createProfile("Peer target moved account");
    expect(value.store.setProfileState(
      movedProfile.id,
      movedProfile.processGeneration,
      "signed_in",
    )).toBe(true);
    await value.service.execute({
      kind: "session.send",
      session: actorSessionId,
      message: "Start the peer target lock freshness actor.",
    }, { signal });
    const actor = value.store.requireSession(actorSessionId);
    const actorProfile = value.store.requireProfileById(actor.profileId);
    if (actor.providerThreadId === undefined || actor.activeTurnId === undefined) {
      throw new Error("Expected an active bound actor turn.");
    }
    const authority: ProfileAuthority = liveAuthorityFor(value.store, actorProfile.id, "codex");
    const call = {
      authority: hostToolAuthorityFor(liveAuthorityFor(value.store, actorProfile.id)),
      callId: "peer-target-lock-freshness",
      connectionId: value.codex.observationConnectionId,
      input: {
        sessionId: target.id,
        // A caller can predict the next session revision. That must not let a
        // post-switch target pass while only its former account lock is held.
        expectedRevision: target.revision + 1,
        delivery: "send" as const,
        message: "This target moved beyond the acquired account lock.",
        reason: "Prove target account lock freshness",
      },
      requestDigest: createHash("sha256").update("peer-target-lock-freshness").digest("hex"),
      requestId: { type: "string" as const, value: "peer-target-lock-freshness" },
      threadId: actor.providerThreadId,
      tool: "session_message" as const,
      turnId: actor.activeTurnId,
    } satisfies OompaHostToolCall;
    const originalRequireSession = value.store.requireSession.bind(value.store);
    let targetMoved = false;
    (value.store as unknown as {
      requireSession: StateStore["requireSession"];
    }).requireSession = (sessionId) => {
      const current = originalRequireSession(sessionId);
      return targetMoved && sessionId === target.id
        ? { ...current, profileId: movedProfile.id, revision: target.revision + 1 }
        : current;
    };
    const originalAdmission = value.store.admitPeerSessionAction.bind(value.store);
    let admissionCalls = 0;
    (value.store as unknown as {
      admitPeerSessionAction: StateStore["admitPeerSessionAction"];
    }).admitPeerSessionAction = (input) => {
      admissionCalls += 1;
      return originalAdmission(input);
    };
    cloud.beforeProjectionUnsettledSessionReturn = async (sessionPublicId) => {
      if (sessionPublicId === target.id) targetMoved = true;
    };
    const providerWritesBefore = providerMutationCalls(value.codex);

    await expect(value.service.handleOompaHostToolCall(
      authority,
      call,
      MANAGED_CODEX_HOST_TOOL_PROVENANCE,
    )).resolves.toEqual({
      version: 1,
      ok: false,
      code: "PEER_SESSION_REVISION_CONFLICT",
    });
    expect(targetMoved).toBe(true);
    expect(admissionCalls).toBe(0);
    expect(value.store.listUnsettledPeerSessionActions(10)).toEqual([]);
    expect(value.store.listQueue(target.id)).toEqual([]);
    expect(providerMutationCalls(value.codex)).toEqual(providerWritesBefore);
  });
test("lists, inspects, and messages a same-project peer through exact host authority", async () => {
    const value = await fixture();
    const { sessionId: actorSessionId } = await createIdleSession(value, "Peer host actor");
    const idleActor = value.store.requireSession(actorSessionId);
    if (idleActor.projectId === undefined || idleActor.providerThreadId === undefined) {
      throw new Error("Expected a project-bound actor session.");
    }
    const targetStarting = value.store.createSession({
      profileId: idleActor.profileId,
      projectId: idleActor.projectId,
      title: "Peer review target",
      provider: "codex",
      preset: "high",
      fastEnabled: false,
    });
    const target = value.store.bindSession({
      sessionId: targetStarting.id,
      expectedRevision: targetStarting.revision,
      providerThreadId: "provider-peer-target",
      state: "idle",
      providerUpdatedAt: 11,
    });
    value.store.bindSessionProviderAccountAuthority({
      sessionId: target.id,
      provider: "codex",
      runtimeScope: "managed",
      accountKey: codexProviderAccountKey(),
    });
    const profile = value.store.requireProfileById(idleActor.profileId);
    value.store.appendSessionEvent({
      providerAuthority: value.store.requireProviderAccountAuthority(profile.id, "codex"),
      sessionId: target.id,
      accountId: profile.id,
      providerGeneration: profile.processGeneration,
      providerConnectionId: null,
      body: {
        type: "user_message",
        turnId: "target-turn",
        actor: "human",
        text: "Please inspect this bounded target record.",
        omittedCharacters: 0,
      },
    });
    value.store.appendSessionEvent({
      providerAuthority: value.store.requireProviderAccountAuthority(profile.id, "codex"),
      sessionId: target.id,
      accountId: profile.id,
      providerGeneration: profile.processGeneration,
      providerConnectionId: null,
      body: {
        type: "reasoning_summary_delta",
        turnId: "target-turn",
        itemId: "target-reasoning",
        text: "hidden unless show-thinking is enabled",
      },
    });

    await value.service.execute({
      kind: "session.send",
      session: actorSessionId,
      message: "Coordinate the peer review.",
    }, { signal });
    const actor = value.store.requireSession(actorSessionId);
    if (actor.providerThreadId === undefined || actor.activeTurnId === undefined) {
      throw new Error("Expected an active bound actor turn.");
    }
    const authority: ProfileAuthority = liveAuthorityFor(value.store, profile.id, "codex");
    const base = {
      authority: hostToolAuthorityFor(liveAuthorityFor(value.store, profile.id)),
      connectionId: value.codex.observationConnectionId,
      requestId: { type: "string" as const, value: "peer-host-request" },
      requestDigest: createHash("sha256").update("peer-host-request").digest("hex"),
      threadId: actor.providerThreadId,
      turnId: actor.activeTurnId,
    } as const;

    const listed = await value.service.handleOompaHostToolCall(authority, {
      ...base,
      callId: "peer-list",
      tool: "sessions_list",
      input: { limit: 10 },
    } satisfies OompaHostToolCall, MANAGED_CODEX_HOST_TOOL_PROVENANCE) as {
      ok: boolean;
      sessions: readonly Record<string, unknown>[];
    };
    expect(listed.ok).toBe(true);
    expect(listed.sessions).toHaveLength(1);
    expect(listed.sessions[0]).toMatchObject({
      id: target.id,
      title: "Peer review target",
      state: "idle",
      peerPolicy: { mode: "coordinate" },
    });
    expect(Object.keys(listed.sessions[0] ?? {}).sort()).toEqual([
      "active",
      "id",
      "lastActivityAt",
      "model",
      "peerPolicy",
      "provider",
      "revision",
      "state",
      "title",
    ]);

    const inspected = await value.service.handleOompaHostToolCall(authority, {
      ...base,
      callId: "peer-inspect",
      tool: "session_inspect",
      input: { sessionId: target.id, expectedRevision: target.revision, limit: 10 },
    } satisfies OompaHostToolCall, MANAGED_CODEX_HOST_TOOL_PROVENANCE) as {
      ok: boolean;
      transcript: { records: readonly { kind: string; text?: string }[] };
    };
    expect(inspected.ok).toBe(true);
    expect(inspected.transcript.records).toEqual([
      expect.objectContaining({
        kind: "user",
        text: "Please inspect this bounded target record.",
      }),
    ]);

    for (let index = 0; index < 50; index += 1) {
      value.store.appendSessionEvent({
        providerAuthority: value.store.requireProviderAccountAuthority(profile.id, "codex"),
        sessionId: target.id,
        accountId: profile.id,
        providerGeneration: profile.processGeneration,
        providerConnectionId: null,
        body: {
          type: "user_message",
          turnId: `target-budget-turn-${String(index)}`,
          actor: "human",
          text: "😀".repeat(768),
          omittedCharacters: 0,
        },
      });
    }
    const boundedInspection = await value.service.handleOompaHostToolCall(authority, {
      ...base,
      callId: "peer-inspect-budgeted",
      tool: "session_inspect",
      input: { sessionId: target.id, expectedRevision: target.revision, limit: 50 },
    } satisfies OompaHostToolCall, MANAGED_CODEX_HOST_TOOL_PROVENANCE) as {
      nextCursor: string | null;
      transcript: { records: readonly { sequence: number }[] };
    };
    expect(new TextEncoder().encode(JSON.stringify(boundedInspection)).byteLength)
      .toBeLessThanOrEqual(OOMPA_HOST_TOOL_PUBLIC_RESULT_MAX_BYTES);
    expect(boundedInspection.transcript.records.length).toBeLessThan(50);
    expect(boundedInspection.nextCursor).toMatch(/^hra1\./u);
    const seenSequences = new Set(
      boundedInspection.transcript.records.map((record) => record.sequence),
    );
    let budgetCursor = boundedInspection.nextCursor;
    for (let pageIndex = 1; budgetCursor !== null && pageIndex < 10; pageIndex += 1) {
      const continuation = await value.service.handleOompaHostToolCall(authority, {
        ...base,
        callId: `peer-inspect-budgeted-${String(pageIndex)}`,
        tool: "session_inspect",
        input: {
          sessionId: target.id,
          expectedRevision: target.revision,
          limit: 50,
          cursor: budgetCursor,
        },
      } satisfies OompaHostToolCall, MANAGED_CODEX_HOST_TOOL_PROVENANCE) as {
        nextCursor: string | null;
        transcript: { records: readonly { sequence: number }[] };
      };
      expect(new TextEncoder().encode(JSON.stringify(continuation)).byteLength)
        .toBeLessThanOrEqual(OOMPA_HOST_TOOL_PUBLIC_RESULT_MAX_BYTES);
      for (const record of continuation.transcript.records) {
        expect(seenSequences.has(record.sequence)).toBe(false);
        seenSequences.add(record.sequence);
      }
      budgetCursor = continuation.nextCursor;
    }
    expect(budgetCursor).toBeNull();
    expect(seenSequences.size).toBe(51);

    value.store.bumpAutorespondCounter(target.id);
    value.codex.readProjection = {
      providerThreadId: "provider-peer-target",
      title: "Peer review target",
      status: "idle",
      providerUpdatedAt: 11,
    };
    const messageCall = {
      ...base,
      callId: "peer-message",
      requestDigest: createHash("sha256").update("peer-message").digest("hex"),
      tool: "session_message" as const,
      input: {
        sessionId: target.id,
        expectedRevision: target.revision,
        delivery: "send" as const,
        message: "Review the authority boundary and report findings.",
        reason: "Independent peer review",
      },
    } satisfies OompaHostToolCall;
    const messaged = await value.service.handleOompaHostToolCall(
      authority,
      messageCall,
      MANAGED_CODEX_HOST_TOOL_PROVENANCE,
    ) as {
      ok: boolean;
      action: { id: string; state: string; targetSessionId: string };
      replay: boolean;
    };
    expect(messaged).toMatchObject({
      ok: true,
      replay: false,
      action: { state: "applied", targetSessionId: target.id },
    });
    const peerEvent = value.store.listSessionEvents({
      sessionId: target.id,
      afterSequence: 0,
    }).events.filter((event) => event.body.type === "user_message").at(-1);
    expect(peerEvent?.body).toMatchObject({
      type: "user_message",
      actor: "peer_session",
    });
    expect(peerEvent?.body.type === "user_message" ? peerEvent.body.text : "")
      .toContain("Oompa peer-session message");
    const projectedActorTurnId = value.eventCursors.projectPublicProviderIdentifier(
      actor.activeTurnId,
    );
    const providerMessage = (value.codex.readProjection.messages ?? [])
      .filter((message) => message.role === "user")
      .at(-1)?.text ?? "";
    expect(providerMessage).toContain(`Source turn: ${projectedActorTurnId}`);
    expect(providerMessage).not.toContain(actor.activeTurnId);
    expect(value.store.readAutorespondBudgets(target.id).consecutive).toBe(1);

    const activeTarget = value.store.requireSession(target.id);
    expect(activeTarget.state).toBe("active");
    const steered = await value.service.handleOompaHostToolCall(authority, {
      ...base,
      callId: "peer-steer",
      requestDigest: createHash("sha256").update("peer-steer").digest("hex"),
      tool: "session_message",
      input: {
        sessionId: activeTarget.id,
        expectedRevision: activeTarget.revision,
        delivery: "steer",
        message: "Also check the exact in-turn authority.",
        reason: "Independent peer follow-up",
      },
    } satisfies OompaHostToolCall, MANAGED_CODEX_HOST_TOOL_PROVENANCE) as {
      ok: boolean;
      action: { state: string; targetSessionId: string };
      replay: boolean;
    };
    expect(steered).toMatchObject({
      ok: true,
      replay: false,
      action: { state: "applied", targetSessionId: target.id },
    });
    expect(value.codex.calls.filter((call) => call === "steer")).toHaveLength(1);

    const replayed = await value.service.handleOompaHostToolCall(
      authority,
      messageCall,
      MANAGED_CODEX_HOST_TOOL_PROVENANCE,
    );
    expect(replayed).toMatchObject({ ok: true, replay: true, action: { state: "applied" } });
    expect(value.codex.calls.filter((call) => call === "send")).toHaveLength(2);
  });
test("binds every host-tool call to the exact provider and runtime scope", async () => {
    const value = await fixture();
    const { sessionId } = await createIdleSession(value, "Host provenance actor");
    await value.service.execute({
      kind: "session.send",
      session: sessionId,
      message: "Establish the exact host-tool turn.",
    }, { signal });
    const actor = value.store.requireSession(sessionId);
    const profile = value.store.requireProfileById(actor.profileId);
    if (actor.providerThreadId === undefined || actor.activeTurnId === undefined) {
      throw new Error("Expected an active host-tool actor.");
    }
    const call = {
      authority: hostToolAuthorityFor(liveAuthorityFor(value.store, profile.id)),
      callId: "host-provenance-list",
      connectionId: value.codex.observationConnectionId,
      input: { limit: 10 },
      requestDigest: createHash("sha256").update("host-provenance-list").digest("hex"),
      requestId: { type: "string" as const, value: "host-provenance-list" },
      threadId: actor.providerThreadId,
      tool: "sessions_list" as const,
      turnId: actor.activeTurnId,
    } satisfies OompaHostToolCall;
    const authority: ProfileAuthority = liveAuthorityFor(value.store, profile.id, "codex");

    await expect(value.service.handleOompaHostToolCall(authority, call, {
      provider: "claude",
      source: "managed",
    })).rejects.toThrow("OOMPA_HOST_TOOL_AUTHORITY_STALE");
    await expect(value.service.handleOompaHostToolCall(authority, call, {
      provider: "codex",
      source: "personal",
    })).rejects.toThrow("OOMPA_HOST_TOOL_AUTHORITY_STALE");
    await expect(value.service.handleOompaHostToolCall(authority, call, {
      provider: "codex",
      source: "managed",
    })).resolves.toMatchObject({ ok: true, version: 1 });
  });
test("preserves exact native legacy automation without granting adopted callbacks", async () => {
    const value = await fixture();
    const { sessionId } = await createIdleSession(value, "Native legacy automation");
    await value.service.execute({
      kind: "session.send",
      session: sessionId,
      message: "Establish the native legacy automation turn.",
    }, { signal });
    const actor = value.store.requireSession(sessionId);
    const profile = value.store.requireProfileById(actor.profileId);
    if (actor.providerThreadId === undefined || actor.activeTurnId === undefined) {
      throw new Error("Expected an active native automation actor.");
    }
    expect(value.store.isConversationAutomationEnabled(actor.id, actor.providerThreadId))
      .toBe(true);
    const legacy = new Database(value.paths.database, { strict: true });
    try {
      // Reproduce the durable row shape accepted from releases predating the
      // host-capability table. The current delete guard correctly makes this
      // state impossible to create through a live product path.
      legacy.run("DROP TRIGGER session_host_capability_binding_delete_guard");
      legacy.query("DELETE FROM session_host_capability_bindings WHERE session_id=?")
        .run(actor.id);
    } finally {
      legacy.close();
    }
    expect(value.store.readSessionHostCapabilityBinding(actor.id)).toBeNull();

    const operation = {
      mode: "create" as const,
      name: "Native legacy review",
      prompt: "Continue the exact native session.",
      schedule: { kind: "interval_minutes" as const, minutes: 15 },
      paused: true,
    };
    const call = {
      authority: hostToolAuthorityFor(liveAuthorityFor(value.store, profile.id)),
      callId: "native-legacy-automation",
      connectionId: value.codex.observationConnectionId,
      input: operation,
      operation,
      requestDigest: createHash("sha256")
        .update("native-legacy-automation")
        .digest("hex"),
      requestId: { type: "string" as const, value: "native-legacy-automation" },
      threadId: actor.providerThreadId,
      tool: "automation_update" as const,
      turnId: actor.activeTurnId,
    } satisfies OompaHostToolCall;
    await expect(value.service.handleOompaHostToolCall(liveAuthorityFor(value.store, profile.id, "codex"), call, MANAGED_CODEX_HOST_TOOL_PROVENANCE)).resolves.toMatchObject({
      name: operation.name,
      sessionId: actor.id,
      status: "paused",
    });
    expect(value.store.createSessionTaskStore().list(actor.id)).toEqual([
      expect.objectContaining({ name: operation.name, status: "paused" }),
    ]);

    await expect(value.service.handleOompaHostToolCall(liveAuthorityFor(value.store, profile.id, "codex"), {
      ...call,
      callId: "native-legacy-automation-stale-connection",
      connectionId: "30000000-0000-4000-8000-999999999999",
      input: { ...operation, name: "Must not use a stale provider connection" },
      operation: { ...operation, name: "Must not use a stale provider connection" },
      requestDigest: createHash("sha256")
        .update("native-legacy-automation-stale-connection")
        .digest("hex"),
      requestId: {
        type: "string" as const,
        value: "native-legacy-automation-stale-connection",
      },
    }, MANAGED_CODEX_HOST_TOOL_PROVENANCE)).rejects.toThrow(
      "CONVERSATION_AUTOMATION_SESSION_UNAVAILABLE",
    );
    expect(value.store.createSessionTaskStore().list(actor.id)).toHaveLength(1);

    const incompatible = new Database(value.paths.database, { strict: true });
    try {
      incompatible.query(
        `INSERT INTO session_host_capability_bindings(
           session_id,preamble_version,preamble_digest,manifest_version,
           manifest_digest,recorded_at
         ) VALUES (?,?,?,?,?,?)`,
      ).run(actor.id, 999, "a".repeat(64), 999, "b".repeat(64), Date.now());
    } finally {
      incompatible.close();
    }
    const incompatibleCall = {
      ...call,
      callId: "native-legacy-automation-incompatible-binding",
      input: { ...operation, name: "Must not bypass an incompatible binding" },
      operation: { ...operation, name: "Must not bypass an incompatible binding" },
      requestDigest: createHash("sha256")
        .update("native-legacy-automation-incompatible-binding")
        .digest("hex"),
      requestId: {
        type: "string" as const,
        value: "native-legacy-automation-incompatible-binding",
      },
    } satisfies OompaHostToolCall;
    await expect(value.service.handleOompaHostToolCall(liveAuthorityFor(value.store, profile.id, "codex"), incompatibleCall, MANAGED_CODEX_HOST_TOOL_PROVENANCE)).rejects.toThrow(
      "CONVERSATION_AUTOMATION_SESSION_UNAVAILABLE",
    );
    expect(value.store.createSessionTaskStore().list(actor.id)).toHaveLength(1);
  });
test("admits Darwin personal-Claude custody without fabricating host-tool authority", async () => {
    const memory = new FakeMemory();
    const value = await adoptedClaudeFixture(
      "Darwin Claude adopted custody",
      "darwin-personal-claude-adopted-custody",
      undefined,
      undefined,
      "darwin",
      false,
      undefined,
      memory,
    );
    const authority = value.personalClaude.claimRequests[0]?.authority;
    if (authority === undefined) throw new Error("Expected personal Claude authority.");
    expect(value.store.requireProfileById(value.accountId).state).toBe("signed_out");
    expect(value.store.readSessionPersonalRuntimeBinding(value.session.id)).toMatchObject({
      provider: "claude",
      state: "active",
    });
    expect(value.store.readSessionHostCapabilityBinding(value.session.id)).toBeNull();
    if (value.session.providerThreadId === undefined) {
      throw new Error("Expected an adopted personal Claude provider thread.");
    }
    expect(value.personalClaude.hostToolActivationRequests).toEqual([]);

    await value.service.observePersonalClaudeFact(authority, {
      connectionId: value.personalClaude.observationConnectionId,
      providerThreadId: value.session.providerThreadId,
      turnId: "darwin-personal-claude-host-turn",
      type: "turnStarted",
    });
    const actor = value.store.requireSession(value.session.id);
    expect(actor).toMatchObject({
      activeTurnId: "darwin-personal-claude-host-turn",
      state: "active",
    });
    if (actor.providerThreadId === undefined || actor.activeTurnId === undefined) {
      throw new Error("Expected an active personal Claude host-tool actor.");
    }
    const callBase = {
      authority: hostToolAuthorityFor(authority),
      connectionId: value.personalClaude.observationConnectionId,
      requestId: { type: "string" as const, value: "darwin-personal-claude-host" },
      threadId: actor.providerThreadId,
      turnId: actor.activeTurnId,
    };
    const listCall = {
      ...callBase,
      callId: "darwin-personal-claude-list",
      input: { limit: 10 },
      requestDigest: createHash("sha256")
        .update("darwin-personal-claude-list")
        .digest("hex"),
      tool: "sessions_list" as const,
    } satisfies OompaHostToolCall;

    await expect(value.service.handleOompaHostToolCall(authority, listCall, {
      provider: "claude",
      source: "personal",
    })).rejects.toThrow("SESSION_HOST_CAPABILITY_BINDING_MISSING");
    await expect(value.service.handleOompaHostToolCall(authority, listCall, {
      provider: "claude",
      source: "managed",
    })).rejects.toThrow("OOMPA_HOST_TOOL_AUTHORITY_STALE");
    await expect(value.service.handleOompaHostToolCall(authority, listCall, {
      provider: "codex",
      source: "personal",
    })).rejects.toThrow("OOMPA_HOST_TOOL_AUTHORITY_STALE");

    const operation = {
      mode: "create" as const,
      name: "Darwin Claude scheduled review",
      prompt: "Review the current project state.",
      schedule: { kind: "interval_minutes" as const, minutes: 15 },
      paused: true,
    };
    const automationCall = {
      ...callBase,
      callId: "darwin-personal-claude-automation",
      input: operation,
      operation,
      requestDigest: createHash("sha256")
        .update("darwin-personal-claude-automation")
        .digest("hex"),
      requestId: { type: "string" as const, value: "darwin-personal-claude-automation" },
      tool: "automation_update" as const,
    } satisfies OompaHostToolCall;
    const forgedAutomation = new Database(value.paths.database, { strict: true });
    try {
      forgedAutomation.query(
        "INSERT INTO session_conversation_automation(session_id,provider_thread_id,enabled_at) VALUES (?,?,?)",
      ).run(actor.id, actor.providerThreadId, Date.now());
    } finally {
      forgedAutomation.close();
    }
    expect(value.store.isConversationAutomationEnabled(actor.id, actor.providerThreadId))
      .toBe(true);
    expect(value.store.hasNativeConversationAutomationAuthority(actor.id, actor.providerThreadId))
      .toBe(false);
    await expect(value.service.handleOompaHostToolCall(authority, automationCall, {
      provider: "claude",
      source: "personal",
    })).rejects.toThrow("CONVERSATION_AUTOMATION_SESSION_UNAVAILABLE");
    await expect(value.service.handleOompaHostToolCall(authority, {
      ...automationCall,
      callId: "darwin-personal-claude-automation-wrong-source",
      requestDigest: createHash("sha256")
        .update("darwin-personal-claude-automation-wrong-source")
        .digest("hex"),
    }, {
      provider: "claude",
      source: "managed",
    })).rejects.toThrow("CONVERSATION_AUTOMATION_AUTHORITY_STALE");

    expect(value.store.createSessionTaskStore().list(actor.id)).toEqual([]);

    await expect(value.service.execute({
      kind: "memory.status",
      session: actor.id,
    }, { signal })).resolves.toMatchObject({ kind: "status", sessionId: actor.id });
    await expect(value.service.execute({
      kind: "memory.remember",
      session: actor.id,
      idempotencyKey: "00000000-0000-4000-8000-000000000606",
      value: {
        key: "adopted.custody",
        title: "Adopted custody",
        summary: "Owner memory remains available without provider host tools.",
        body: "The adopted provider snapshot grants no Oompa callback capability.",
      },
    }, { signal })).resolves.toMatchObject({ idempotencyKey: "00000000-0000-4000-8000-000000000606" });
    expect(memory.statuses).toEqual([{ actorSessionId: actor.id }]);
    expect(memory.remembers).toHaveLength(1);

    await value.service.observePersonalClaudeFact(authority, {
      connectionId: value.personalClaude.observationConnectionId,
      providerThreadId: value.session.providerThreadId,
      status: "completed",
      turnId: "darwin-personal-claude-host-turn",
      type: "turnCompleted",
    });
    const completedActor = value.store.requireSession(actor.id);
    expect(completedActor.state).toBe("idle");
    expect(completedActor.activeTurnId).toBeUndefined();

    await expect(value.service.execute({
      kind: "account.login",
      account: value.accountId,
      deviceCode: false,
    }, { signal })).resolves.toMatchObject({
      account: { id: value.accountId },
    });
    expect(value.store.requireProfileById(value.accountId).processGeneration).toBe(1);
    expect(value.store.requireProviderAccountAuthority(value.accountId, "claude").processGeneration)
      .toBe(authority.generation);
    expect(value.managedClaude.rebindings).toEqual([]);
    expect(value.personalClaude.rebindings).toEqual([]);
  });
test.each(["actor", "target"] as const)(
    "fences peer mutations when either account has durable projection recovery (%s)",
    (recoverySide) => ownedServiceCase(async ({ createFixture, signal }) => {
      const cloud = new FakeCloud();
      const value = await createFixture(cloud);
      signal.throwIfAborted();
      const { sessionId: actorSessionId } = await createIdleSession(
        value,
        `Peer durable projection ${recoverySide} actor`,
      );
      signal.throwIfAborted();
      const idleActor = value.store.requireSession(actorSessionId);
      if (idleActor.projectId === undefined) throw new Error("Expected a project-bound peer actor.");
      const targetEmail = `peer-durable-${recoverySide}@example.com`;
      const targetProfile = value.store.createProfile(`Peer durable ${recoverySide} target`);
      expect(value.store.setProfileState(
        targetProfile.id,
        targetProfile.processGeneration,
        "signed_in",
        { email: targetEmail, plan: "Plus" },
      )).toBe(true);
      const targetBase = value.store.createSession({
        profileId: targetProfile.id,
        projectId: idleActor.projectId,
        title: `Peer durable ${recoverySide} target`,
        provider: "codex",
        preset: "high",
        fastEnabled: false,
      });
      const target = value.store.bindSession({
        sessionId: targetBase.id,
        expectedRevision: targetBase.revision,
        providerThreadId: `provider-peer-durable-${recoverySide}-target`,
        state: "idle",
      });
      value.store.bindSessionProviderAccountAuthority({
        sessionId: target.id,
        provider: "codex",
        runtimeScope: "managed",
        accountKey: codexProviderAccountKey(targetEmail),
      });
      await value.service.execute({
        kind: "session.send",
        session: actorSessionId,
        message: `Start the durable projection ${recoverySide} peer actor.`,
      }, { signal });
      signal.throwIfAborted();
      const actor = value.store.requireSession(actorSessionId);
      const actorProfile = value.store.requireProfileById(actor.profileId);
      if (actor.providerThreadId === undefined || actor.activeTurnId === undefined) {
        throw new Error("Expected an active bound peer actor.");
      }
      cloud.unsettledProjectionProfiles.add(
        recoverySide === "actor" ? actorProfile.id : targetProfile.id,
      );
      const providerWritesBefore = providerMutationCalls(value.codex);
      const requestLabel = `peer-durable-projection-${recoverySide}`;
      const authority: ProfileAuthority = liveAuthorityFor(value.store, actorProfile.id, "codex");

      await expect(value.service.handleOompaHostToolCall(authority, {
        authority: hostToolAuthorityFor(liveAuthorityFor(value.store, actorProfile.id)),
        callId: requestLabel,
        connectionId: value.codex.observationConnectionId,
        input: {
          sessionId: target.id,
          expectedRevision: target.revision,
          delivery: "send",
          message: "Do not cross a durable account recovery fence.",
          reason: `The ${recoverySide} account has unsettled projection recovery`,
        },
        requestDigest: createHash("sha256").update(requestLabel).digest("hex"),
        requestId: { type: "string", value: requestLabel },
        threadId: actor.providerThreadId,
        tool: "session_message",
        turnId: actor.activeTurnId,
      } satisfies OompaHostToolCall, {
        provider: "codex",
        source: "managed",
      })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
      signal.throwIfAborted();
      expect(value.store.listRecentPeerSessionActions()).toEqual([]);
      expect(providerMutationCalls(value.codex)).toEqual(providerWritesBefore);
    }),
    5_000,
  );
test.each(["actor", "target"] as const)(
    "fences peer mutations while a sibling projection recovery owns the %s account",
    (recoverySide) => ownedServiceCase(async ({ createFixture, signal }) => {
      const cloud = new FakeCloud();
      const value = await createFixture(cloud);
      signal.throwIfAborted();
      const { sessionId: actorSessionId } = await createIdleSession(
        value,
        `Peer in-flight projection ${recoverySide} actor`,
      );
      const idleActor = value.store.requireSession(actorSessionId);
      if (idleActor.projectId === undefined) throw new Error("Expected a project-bound peer actor.");
      const targetEmail = `peer-in-flight-${recoverySide}@example.com`;
      const targetProfile = value.store.createProfile(`Peer in-flight ${recoverySide} target`);
      expect(value.store.setProfileState(
        targetProfile.id,
        targetProfile.processGeneration,
        "signed_in",
        { email: targetEmail, plan: "Plus" },
      )).toBe(true);
      const targetBase = value.store.createSession({
        profileId: targetProfile.id,
        projectId: idleActor.projectId,
        title: `Peer in-flight ${recoverySide} target`,
        provider: "codex",
        preset: "high",
        fastEnabled: false,
      });
      const target = value.store.bindSession({
        sessionId: targetBase.id,
        expectedRevision: targetBase.revision,
        providerThreadId: `provider-peer-in-flight-${recoverySide}-target`,
        state: "idle",
      });
      const targetAccountKey = codexProviderAccountKey(targetEmail);
      value.store.bindSessionProviderAccountAuthority({
        sessionId: target.id,
        provider: "codex",
        runtimeScope: "managed",
        accountKey: targetAccountKey,
      });
      await value.service.execute({
        kind: "session.send",
        session: actorSessionId,
        message: `Start the in-flight projection ${recoverySide} peer actor.`,
      }, { signal });
      const actor = value.store.requireSession(actorSessionId);
      const actorProfile = value.store.requireProfileById(actor.profileId);
      const actorAccountKey = value.store.readSessionProviderAccountAuthority(actor.id)?.accountKey;
      if (
        actor.providerThreadId === undefined
        || actor.activeTurnId === undefined
        || actorAccountKey === undefined
      ) throw new Error("Expected an active bound peer actor with account authority.");
      const recoveryProfile = recoverySide === "actor" ? actorProfile : targetProfile;
      const siblingBase = value.store.createSession({
        profileId: recoveryProfile.id,
        projectId: idleActor.projectId,
        title: `Peer ${recoverySide} recovery sibling`,
        provider: "codex",
        preset: "high",
        fastEnabled: false,
      });
      const sibling = value.store.bindSession({
        sessionId: siblingBase.id,
        expectedRevision: siblingBase.revision,
        providerThreadId: `provider-peer-${recoverySide}-recovery-sibling`,
        state: "idle",
      });
      value.store.bindSessionProviderAccountAuthority({
        sessionId: sibling.id,
        provider: "codex",
        runtimeScope: "managed",
        accountKey: recoverySide === "actor" ? actorAccountKey : targetAccountKey,
      });
      let entered!: () => void;
      let rejectEntry!: (reason: unknown) => void;
      let didEnter = false;
      const recoveryEntered = new Promise<void>((resolve, reject) => {
        entered = resolve;
        rejectEntry = reject;
      });
      let release!: () => void;
      const recoveryGate = new Promise<void>((resolve) => { release = resolve; });
      cloud.beforeProjectionRecoveryReturn = async () => {
        didEnter = true;
        entered();
        await recoveryGate;
      };
      signal.throwIfAborted();
      // Cancellation can arrive before the cloud hook enters. Releasing now
      // also admits that later hook, so joining the owned case cannot deadlock.
      signal.addEventListener("abort", release, { once: true });
      const recovery = value.service.execute({
        acknowledgeGap: true,
        idempotencyKey: crypto.randomUUID(),
        kind: "sync.projection-recover",
        session: sibling.id,
      }, { signal });
      // Observe the original task immediately, including rejection before the
      // entry hook. The finally below still joins its real outcome.
      void recovery.then(() => {
        if (!didEnter) rejectEntry(new Error("Expected the projection recovery entry hook."));
      }, rejectEntry);
      try {
        await recoveryEntered;
        signal.throwIfAborted();
        const providerWritesBefore = providerMutationCalls(value.codex);
        const requestLabel = `peer-in-flight-projection-${recoverySide}`;
        const authority: ProfileAuthority = liveAuthorityFor(value.store, actorProfile.id, "codex");
        await expect(value.service.handleOompaHostToolCall(authority, {
          authority: hostToolAuthorityFor(liveAuthorityFor(value.store, actorProfile.id)),
          callId: requestLabel,
          connectionId: value.codex.observationConnectionId,
          input: {
            sessionId: target.id,
            expectedRevision: target.revision,
            delivery: "send",
            message: "Do not cross a sibling in-flight account recovery fence.",
            reason: `A ${recoverySide} account sibling is recovering its projection`,
          },
          requestDigest: createHash("sha256").update(requestLabel).digest("hex"),
          requestId: { type: "string", value: requestLabel },
          threadId: actor.providerThreadId,
          tool: "session_message",
          turnId: actor.activeTurnId,
        } satisfies OompaHostToolCall, {
          provider: "codex",
          source: "managed",
        })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
        expect(value.store.listRecentPeerSessionActions()).toEqual([]);
        expect(providerMutationCalls(value.codex)).toEqual(providerWritesBefore);
      } finally {
        signal.removeEventListener("abort", release);
        release();
        await recovery;
      }
    }),
  );
test("dispatches memory host tools with session authority, deterministic mutation keys, and closed refusals", async () => {
    const memory = new FakeMemory();
    const value = await fixture(new FakeCloud(),
      () => undefined,
      Date.now,
      undefined,
      {},
      memory,
    );
    const { sessionId } = await createIdleSession(value, "Memory host actor");
    await value.service.execute({
      kind: "session.send",
      message: "Use the bounded memory surface.",
      session: sessionId,
    }, { signal });
    const actor = value.store.requireSession(sessionId);
    const profile = value.store.requireProfileById(actor.profileId);
    if (actor.providerThreadId === undefined || actor.activeTurnId === undefined) {
      throw new Error("Expected an active memory host actor.");
    }
    const authority: ProfileAuthority = liveAuthorityFor(value.store, profile.id, "codex");
    const base = {
      authority: hostToolAuthorityFor(liveAuthorityFor(value.store, profile.id)),
      connectionId: value.codex.observationConnectionId,
      requestId: { type: "string" as const, value: "memory-host-request" },
      threadId: actor.providerThreadId,
      turnId: actor.activeTurnId,
    } as const;
    const rememberCall = {
      ...base,
      callId: "memory-remember-call",
      requestDigest: createHash("sha256").update("memory-remember").digest("hex"),
      tool: "memory_remember" as const,
      input: {
        key: "architecture.boundary",
        title: "Authority boundary",
        summary: "The service revalidates actor authority under its lock.",
        body: "Memory mutations are attributed to the current actor session.",
      },
    } satisfies OompaHostToolCall;
    expect(await value.service.handleOompaHostToolCall(
      authority,
      rememberCall,
      MANAGED_CODEX_HOST_TOOL_PROVENANCE,
    ))
      .toMatchObject({ ok: true, kind: "remember" });
    expect(await value.service.handleOompaHostToolCall(
      authority,
      rememberCall,
      MANAGED_CODEX_HOST_TOOL_PROVENANCE,
    ))
      .toMatchObject({ ok: true, kind: "remember" });
    expect(memory.remembers).toHaveLength(2);
    expect(memory.remembers[0]).toMatchObject({
      actorSessionId: sessionId,
      requestDigest: rememberCall.requestDigest,
      value: rememberCall.input,
    });
    expect(memory.remembers[0]?.idempotencyKey)
      .toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    expect(memory.remembers[1]?.idempotencyKey).toBe(memory.remembers[0]?.idempotencyKey);

    const queryCall = {
      ...base,
      callId: "memory-query-call",
      requestDigest: createHash("sha256").update("memory-query").digest("hex"),
      tool: "memory_query" as const,
      input: { mode: "list" as const },
    } satisfies OompaHostToolCall;
    expect(await value.service.handleOompaHostToolCall(
      authority,
      queryCall,
      MANAGED_CODEX_HOST_TOOL_PROVENANCE,
    ))
      .toMatchObject({ ok: true, kind: "query" });
    expect(memory.queries.at(-1)).toEqual({ actorSessionId: sessionId, value: queryCall.input });

    const explainCall = {
      ...base,
      callId: "memory-explain-call",
      requestDigest: createHash("sha256").update("memory-explain").digest("hex"),
      tool: "memory_explain" as const,
      input: { queryId: `memq_${"1".repeat(32)}`, row: 0 },
    } satisfies OompaHostToolCall;
    expect(await value.service.handleOompaHostToolCall(
      authority,
      explainCall,
      MANAGED_CODEX_HOST_TOOL_PROVENANCE,
    ))
      .toMatchObject({ ok: true, kind: "explain" });
    expect(memory.explanations.at(-1)).toEqual({ actorSessionId: sessionId, value: explainCall.input });

    const shareCall = {
      ...base,
      callId: "memory-share-call",
      requestDigest: createHash("sha256").update("memory-share").digest("hex"),
      tool: "memory_share" as const,
      input: { key: "architecture.boundary", reason: "Durable project context" },
    } satisfies OompaHostToolCall;
    expect(await value.service.handleOompaHostToolCall(
      authority,
      shareCall,
      MANAGED_CODEX_HOST_TOOL_PROVENANCE,
    ))
      .toMatchObject({ ok: true, kind: "share" });
    expect(memory.shares.at(-1)).toMatchObject({
      actorSessionId: sessionId,
      requestDigest: shareCall.requestDigest,
      value: shareCall.input,
    });
    expect(memory.shares.at(-1)?.idempotencyKey).not.toBe(memory.remembers[0]?.idempotencyKey);

    memory.queryError = new FakeMemoryRefusalError("MEMORY_QUERY_EXPIRED");
    expect(await value.service.handleOompaHostToolCall(authority, {
      ...queryCall,
      callId: "memory-query-refusal",
    }, MANAGED_CODEX_HOST_TOOL_PROVENANCE)).toEqual({
      version: 1,
      ok: false,
      code: "MEMORY_QUERY_EXPIRED",
    });

    await value.service.close();
    await value.service.close();
    expect(memory.closeCalls).toBe(1);
  });
test("quiesces external memory observers before closing the memory coordinator", async () => {
    const memory = new FakeMemory();
    let releaseQuiescence!: () => void;
    let markQuiescenceStarted!: () => void;
    const quiescenceStarted = new Promise<void>((resolve) => { markQuiescenceStarted = resolve; });
    const quiescence = new Promise<void>((resolve) => { releaseQuiescence = resolve; });
    const value = await fixture(new FakeCloud(),
      () => undefined,
      Date.now,
      undefined,
      {
        beforeMemoryClose: async () => {
          markQuiescenceStarted();
          await quiescence;
        },
      },
      memory,
    );

    const closing = value.service.close();
    await quiescenceStarted;
    expect(memory.closeCalls).toBe(0);
    releaseQuiescence();
    await closing;
    expect(memory.closeCalls).toBe(1);
  });
test("does not close memory when external observer quiescence fails", async () => {
    const memory = new FakeMemory();
    const quiescenceFailure = new Error("external memory observer remained live");
    const value = await fixture(new FakeCloud(),
      () => undefined,
      Date.now,
      undefined,
      {
        beforeMemoryClose: async () => { throw quiescenceFailure; },
      },
      memory,
    );

    await expect(value.service.close()).rejects.toBe(quiescenceFailure);
    expect(memory.closeCalls).toBe(0);
  });
test("routes the owner memory CLI through the coordinator with exact session and replay authority", async () => {
    const memory = new FakeMemory();
    const value = await fixture(new FakeCloud(),
      () => undefined,
      Date.now,
      undefined,
      {},
      memory,
    );
    const { sessionId } = await createIdleSession(value, "Memory owner CLI");

    expect(await value.service.execute({
      kind: "memory.status",
      session: sessionId,
    }, { signal })).toEqual({ version: 1, ok: true, kind: "status", sessionId });
    expect(memory.statuses).toEqual([{ actorSessionId: sessionId }]);

    const query = {
      kind: "memory.query",
      session: sessionId,
      value: { mode: "search", text: "authority boundary" },
    } satisfies LocalCommand;
    expect(await value.service.execute(query, { signal }))
      .toEqual({ version: 1, ok: true, kind: "query", sessionId });
    expect(memory.queries.at(-1)).toEqual({
      actorSessionId: sessionId,
      value: query.value,
    });

    const explain = {
      kind: "memory.explain",
      session: sessionId,
      value: { queryId: `memq_${"7".repeat(32)}`, row: 1 },
    } satisfies LocalCommand;
    expect(await value.service.execute(explain, { signal }))
      .toEqual({ version: 1, ok: true, kind: "explain", sessionId });
    expect(memory.explanations.at(-1)).toEqual({
      actorSessionId: sessionId,
      value: explain.value,
    });

    const remember = {
      kind: "memory.remember",
      session: sessionId,
      idempotencyKey: "00000000-0000-4000-8000-000000000601",
      value: {
        key: "architecture.boundary",
        title: "Authority boundary",
        summary: "The owner CLI delegates to the coordinator.",
        body: "No owner command opens Oh directly.",
      },
    } satisfies LocalCommand;
    expect(await value.service.execute(remember, { signal })).toMatchObject({
      idempotencyKey: remember.idempotencyKey,
    });
    expect(await value.service.execute(remember, { signal })).toMatchObject({
      idempotencyKey: remember.idempotencyKey,
    });
    expect(memory.remembers).toHaveLength(2);
    expect(memory.remembers[0]).toMatchObject({
      actorSessionId: sessionId,
      idempotencyKey: remember.idempotencyKey,
      value: remember.value,
    });
    expect(memory.remembers[0]?.requestDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(memory.remembers[1]?.requestDigest).toBe(memory.remembers[0]?.requestDigest);

    const share = {
      kind: "memory.share",
      session: sessionId,
      idempotencyKey: "00000000-0000-4000-8000-000000000602",
      value: { key: "architecture.boundary", reason: "Shared project decision" },
    } satisfies LocalCommand;
    expect(await value.service.execute(share, { signal })).toMatchObject({
      idempotencyKey: share.idempotencyKey,
    });
    expect(memory.shares.at(-1)).toMatchObject({
      actorSessionId: sessionId,
      idempotencyKey: share.idempotencyKey,
      value: share.value,
    });
    expect(memory.shares.at(-1)?.requestDigest).not.toBe(memory.remembers[0]?.requestDigest);

    memory.queryError = new FakeMemoryRefusalError("MEMORY_CONTINUATION_REFUSED");
    await expect(value.service.execute(query, { signal })).rejects.toMatchObject({
      code: "CONFLICT",
      details: { reason: "MEMORY_CONTINUATION_REFUSED" },
    });
    await value.service.close();
  });
test("revalidates memory actor authority after acquiring the session lock", async () => {
    const memory = new FakeMemory();
    const cloud = new FakeCloud();
    const value = await fixture(cloud,
      () => undefined,
      Date.now,
      undefined,
      {},
      memory,
    );
    const { sessionId } = await createIdleSession(value, "Queued memory actor");
    await value.service.execute({
      kind: "session.send",
      message: "Begin the memory call.",
      session: sessionId,
    }, { signal });
    const actor = value.store.requireSession(sessionId);
    const profile = value.store.requireProfileById(actor.profileId);
    if (actor.providerThreadId === undefined || actor.activeTurnId === undefined) {
      throw new Error("Expected an active queued memory actor.");
    }
    let releaseCheck: (() => void) | undefined;
    let enteredCheck: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => { enteredCheck = resolve; });
    const blocked = new Promise<void>((resolve) => { releaseCheck = resolve; });
    cloud.beforeProjectionUnsettledSessionReturn = async () => {
      enteredCheck?.();
      await blocked;
    };
    const pending = value.service.handleOompaHostToolCall(liveAuthorityFor(value.store, profile.id, "codex"), {
      authority: hostToolAuthorityFor(liveAuthorityFor(value.store, profile.id)),
      callId: "memory-query-stale-actor",
      connectionId: value.codex.observationConnectionId,
      input: { mode: "list" },
      requestDigest: createHash("sha256").update("memory-query-stale-actor").digest("hex"),
      requestId: { type: "string", value: "memory-query-stale-actor" },
      threadId: actor.providerThreadId,
      tool: "memory_query",
      turnId: actor.activeTurnId,
    }, MANAGED_CODEX_HOST_TOOL_PROVENANCE);
    await entered;
    value.store.setSessionTurnState({
      sessionId,
      expectedRevision: actor.revision,
      state: "idle",
    });
    releaseCheck?.();
    expect(await pending).toEqual({
      version: 1,
      ok: false,
      code: "PEER_SESSION_ACTOR_TURN_REFUSED",
    });
    expect(memory.queries).toEqual([]);
  });
test("revalidates peer actor account authority after acquiring both session locks", async () => {
    const cloud = new FakeCloud();
    const value = await fixture(cloud);
    const { sessionId: actorSessionId } = await createIdleSession(
      value,
      "Queued peer actor account authority",
    );
    const idleActor = value.store.requireSession(actorSessionId);
    if (idleActor.projectId === undefined) throw new Error("Expected a project-bound actor.");
    const targetBase = value.store.createSession({
      profileId: idleActor.profileId,
      projectId: idleActor.projectId,
      title: "Queued peer actor account authority target",
      provider: "codex",
      preset: "high",
      fastEnabled: false,
    });
    const target = value.store.bindSession({
      sessionId: targetBase.id,
      expectedRevision: targetBase.revision,
      providerThreadId: "provider-peer-actor-account-authority-target",
      state: "idle",
      providerUpdatedAt: 11,
    });
    value.store.bindSessionProviderAccountAuthority({
      sessionId: target.id,
      provider: "codex",
      runtimeScope: "managed",
      accountKey: codexProviderAccountKey(),
    });
    await value.service.execute({
      kind: "session.send",
      message: "Begin the peer actor account-authority call.",
      session: actorSessionId,
    }, { signal });
    const actor = value.store.requireSession(actorSessionId);
    const profile = value.store.requireProfileById(actor.profileId);
    if (actor.providerThreadId === undefined || actor.activeTurnId === undefined) {
      throw new Error("Expected an active peer actor.");
    }
    let releaseCheck: (() => void) | undefined;
    let enteredCheck: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => { enteredCheck = resolve; });
    const blocked = new Promise<void>((resolve) => { releaseCheck = resolve; });
    cloud.beforeProjectionUnsettledSessionReturn = async () => {
      enteredCheck?.();
      await blocked;
    };
    const providerWritesBefore = providerMutationCalls(value.codex);
    const pending = value.service.handleOompaHostToolCall(liveAuthorityFor(value.store, profile.id, "codex"), {
      authority: hostToolAuthorityFor(liveAuthorityFor(value.store, profile.id)),
      callId: "peer-actor-account-authority-stale",
      connectionId: value.codex.observationConnectionId,
      input: {
        sessionId: target.id,
        expectedRevision: target.revision,
        delivery: "send",
        message: "Do not dispatch under an unprovable actor account.",
        reason: "Prove actor account authority is rechecked under both locks",
      },
      requestDigest: createHash("sha256")
        .update("peer-actor-account-authority-stale")
        .digest("hex"),
      requestId: { type: "string", value: "peer-actor-account-authority-stale" },
      threadId: actor.providerThreadId,
      tool: "session_message",
      turnId: actor.activeTurnId,
    }, MANAGED_CODEX_HOST_TOOL_PROVENANCE);
    await entered;
    const direct = new Database(value.paths.database, { create: false, strict: true });
    try {
      direct.query("DELETE FROM session_provider_account_authorities WHERE session_id=?")
        .run(actor.id);
    } finally {
      direct.close();
    }
    expect(value.store.sessionAccountAuthorityMatches(actor.id, profile.id)).toBe(false);
    releaseCheck?.();
    await expect(pending).rejects.toThrow("OOMPA_HOST_TOOL_AUTHORITY_STALE");
    expect(value.store.listRecentPeerSessionActions()).toEqual([]);
    expect(providerMutationCalls(value.codex)).toEqual(providerWritesBefore);
  });
test("requires exact live runtime authority before and after the host-tool session lock", async () => {
    const memory = new FakeMemory();
    const cloud = new FakeCloud();
    const value = await fixture(cloud,
      () => undefined,
      Date.now,
      undefined,
      {},
      memory,
    );
    const { sessionId } = await createIdleSession(value, "Queued runtime host-tool authority");
    await value.service.execute({
      kind: "session.send",
      message: "Begin the runtime-authority host-tool call.",
      session: sessionId,
    }, { signal });
    const actor = value.store.requireSession(sessionId);
    const profile = value.store.requireProfileById(actor.profileId);
    if (actor.providerThreadId === undefined || actor.activeTurnId === undefined) {
      throw new Error("Expected an active runtime-authority actor.");
    }
    const authority: ProfileAuthority = liveAuthorityFor(value.store, profile.id, "codex");
    const call = {
      authority: hostToolAuthorityFor(liveAuthorityFor(value.store, profile.id)),
      callId: "memory-query-runtime-authority-stale",
      connectionId: value.codex.observationConnectionId,
      input: { mode: "list" as const },
      requestDigest: createHash("sha256")
        .update("memory-query-runtime-authority-stale")
        .digest("hex"),
      requestId: { type: "string" as const, value: "memory-query-runtime-authority-stale" },
      threadId: actor.providerThreadId,
      tool: "memory_query" as const,
      turnId: actor.activeTurnId,
    } satisfies OompaHostToolCall;
    let releaseCheck: (() => void) | undefined;
    let enteredCheck: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => { enteredCheck = resolve; });
    const blocked = new Promise<void>((resolve) => { releaseCheck = resolve; });
    cloud.beforeProjectionUnsettledSessionReturn = async () => {
      enteredCheck?.();
      await blocked;
    };
    const pending = value.service.handleOompaHostToolCall(
      authority,
      call,
      MANAGED_CODEX_HOST_TOOL_PROVENANCE,
    );
    await entered;
    value.codex.liveHostToolCall = false;
    releaseCheck?.();
    await expect(pending).rejects.toThrow("OOMPA_HOST_TOOL_RUNTIME_AUTHORITY_STALE");
    expect(memory.queries).toEqual([]);
    expect(value.codex.liveHostToolCallRequests).toEqual([
      {
        authority,
        providerThreadId: actor.providerThreadId,
        connectionId: call.connectionId,
        turnId: actor.activeTurnId,
        callId: call.callId,
        requestDigest: call.requestDigest,
      },
      {
        authority,
        providerThreadId: actor.providerThreadId,
        connectionId: call.connectionId,
        turnId: actor.activeTurnId,
        callId: call.callId,
        requestDigest: call.requestDigest,
      },
    ]);

    value.codex.liveHostToolCall = true;
    delete cloud.beforeProjectionUnsettledSessionReturn;
    const liveProbe = value.codex.hasLiveHostToolCall.bind(value.codex);
    (value.codex as { hasLiveHostToolCall?: CodexRuntimePort["hasLiveHostToolCall"] })
      .hasLiveHostToolCall = undefined;
    await expect(value.service.handleOompaHostToolCall(authority, {
      ...call,
      callId: "memory-query-runtime-authority-missing",
      requestDigest: createHash("sha256")
        .update("memory-query-runtime-authority-missing")
        .digest("hex"),
    }, MANAGED_CODEX_HOST_TOOL_PROVENANCE)).rejects.toThrow(
      "OOMPA_HOST_TOOL_RUNTIME_AUTHORITY_STALE",
    );
    expect(memory.queries).toEqual([]);

    (value.codex as { hasLiveHostToolCall?: CodexRuntimePort["hasLiveHostToolCall"] })
      .hasLiveHostToolCall = liveProbe;
    await expect(value.service.handleOompaHostToolCall(authority, {
      ...call,
      callId: "memory-query-runtime-authority-current",
      requestDigest: createHash("sha256")
        .update("memory-query-runtime-authority-current")
        .digest("hex"),
    }, MANAGED_CODEX_HOST_TOOL_PROVENANCE)).resolves.toMatchObject({
      kind: "query",
      ok: true,
    });
    expect(memory.queries).toEqual([{
      actorSessionId: actor.id,
      value: call.input,
    }]);
  });
test("sets the two device-command switches locally and reports them", async () => {
    const value = await fixture();
    expect(await value.service.execute({ kind: "remote.policy-status" }, { signal })).toEqual({
      accountLinkingAllowed: false,
      deviceCommandsAllowed: true,
      version: 1,
    });
    expect(await value.service.execute(
      { allowed: false, kind: "remote.policy-set", switch: "device-commands" },
      { signal },
    )).toEqual({ accountLinkingAllowed: false, deviceCommandsAllowed: false, version: 1 });
    expect(await value.service.execute(
      { allowed: true, kind: "remote.policy-set", switch: "account-linking" },
      { signal },
    )).toEqual({ accountLinkingAllowed: true, deviceCommandsAllowed: false, version: 1 });
    expect(value.store.readDeviceCommandPolicy()).toEqual({
      accountLinkingAllowed: true,
      deviceCommandsAllowed: false,
    });
  });
test("forwards one caller UUIDv7 through lost device responses and exact replays", async () => {
    for (const kind of ["approve", "revoke"] as const) {
      const cloud = new FakeCloud();
      const { service } = await fixture(cloud);
      const idempotencyKey = kind === "approve"
        ? "018bcfe5-6800-7000-8000-000000000041"
        : "018bcfe5-6800-7000-8000-000000000042";
      const command = kind === "approve"
        ? {
            device: "device_approve",
            fingerprint: "0000-1111-2222-3333-4444-5555-6666-7777",
            idempotencyKey,
            kind: "device.approve",
          } as const
        : {
            device: "device_revoke",
            idempotencyKey,
            kind: "device.revoke",
          } as const;
      cloud.loseNextDeviceMutationResponses.add(kind);

      await expect(service.execute(command, { signal }))
        .rejects.toThrow(`Lost local device ${kind} response.`);
      await expect(service.execute(command, { signal })).resolves.toMatchObject({
        device: command.device,
        idempotencyKey,
        replay: true,
      });
      expect(cloud.deviceMutations).toEqual([
        { device: command.device, idempotencyKey, kind, signal },
        { device: command.device, idempotencyKey, kind, signal },
      ]);
    }
  });
test("rejects a device caller key reused across targets or operations", async () => {
    const cloud = new FakeCloud();
    const { service } = await fixture(cloud);
    const idempotencyKey = "018bcfe5-6800-7000-8000-000000000043";
    await expect(service.execute({
      device: "device_original",
      fingerprint: "0000-1111-2222-3333-4444-5555-6666-7777",
      idempotencyKey,
      kind: "device.approve",
    }, { signal })).resolves.toMatchObject({ approved: true, idempotencyKey });

    await expect(service.execute({
      device: "device_changed",
      fingerprint: "0000-1111-2222-3333-4444-5555-6666-7777",
      idempotencyKey,
      kind: "device.approve",
    }, { signal })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(service.execute({
      device: "device_original",
      idempotencyKey,
      kind: "device.revoke",
    }, { signal })).rejects.toMatchObject({ code: "CONFLICT" });
  });
test("maps every expected account-key loss precondition to a closed actionable failure", async () => {
    const cases = [
      {
        failure: "signed_out",
        code: "INTERACTION_REQUIRED",
        nextCommand: "oompa auth login --input-stdin",
      },
      {
        failure: "device_unregistered",
        code: "INTERACTION_REQUIRED",
        nextCommand: "oompa device pair",
      },
      {
        failure: "observation_missing",
        code: "INTERACTION_REQUIRED",
        nextCommand: "oompa auth status",
      },
      {
        failure: "already_ready",
        code: "CONFLICT",
        nextCommand: "oompa auth status",
      },
      {
        failure: "auth_identity_unbound",
        code: "RECOVERY_REQUIRED",
        nextCommand: "oompa auth status",
      },
      {
        failure: "authority_changed",
        code: "RECOVERY_REQUIRED",
        nextCommand: "oompa auth status",
      },
    ] as const;
    const cloud = new FakeCloud();
    const { service } = await fixture(cloud);
    for (const expected of cases) {
      cloud.keyLossError = new AccountKeyLossPreconditionError(expected.failure);
      await expect(service.execute({
        acknowledgeNoKeyHolders: true,
        kind: "device.key-loss",
      }, { signal })).rejects.toMatchObject({
        code: expected.code,
        details: { nextCommand: expected.nextCommand },
        name: "CommandFailure",
      });
    }
    expect(cloud.keyLossCalls).toBe(cases.length);
  });
test("defers identity-switch and account-erasure shutdown until after the response boundary", async () => {
    const cloud = new FakeCloud();
    let stopCalls = 0;
    const { service, store } = await fixture(cloud, () => { stopCalls += 1; });
    const afterResponse: Array<() => void> = [];

    cloud.authResult = { daemonRestartRequired: true, signedIn: true };
    const auth = await service.execute({
      code: "12345678",
      email: "person@example.com",
      kind: "auth.login",
    }, {
      afterResponse: (callback) => { afterResponse.push(callback); },
      signal,
    });
    expect(auth).toMatchObject({ daemonRestartRequired: true });
    expect(stopCalls).toBe(0);
    expect(afterResponse).toHaveLength(1);
    afterResponse.shift()?.();
    expect(stopCalls).toBe(1);

    const localAccountsBefore = store.listProfiles().length;
    const localSessionsBefore = store.listSessions().length;
    const deletion = await service.execute({
      acknowledgeErasure: true,
      kind: "auth.delete",
    }, {
      afterResponse: (callback) => { afterResponse.push(callback); },
      signal,
    });
    expect(deletion).toMatchObject({
      daemonRestartRequired: true,
      deletion: { effectsDisabled: true, state: "pending" },
    });
    expect(cloud.deleteAccountCalls).toBe(1);
    expect(store.listProfiles()).toHaveLength(localAccountsBefore);
    expect(store.listSessions()).toHaveLength(localSessionsBefore);
    expect(stopCalls).toBe(1);
    expect(afterResponse).toHaveLength(1);
    afterResponse.shift()?.();
    expect(stopCalls).toBe(2);
  });
test("doctor closes dependency failures without repeating arbitrary runtime diagnostics", async () => {
    const privatePath = ["", "Users", "operator", "private"].join("/");
    const secret = `sk-live-secret ${privatePath}\u001b[31m`;
    const cloud = new FakeCloud();
    cloud.statusError = new Error(secret);
    const { service } = await fixture(cloud);

    const doctor = await service.execute({ kind: "doctor", offline: false }, { signal });
    const serialized = JSON.stringify(doctor);
    expect(serialized).not.toContain("sk-live-secret");
    expect(serialized).not.toContain(privatePath);
    expect(serialized).not.toContain("\u001b");
    expect(doctor).toMatchObject({
      cloud: {
        diagnostic: "Cloud status failed without exposing its runtime diagnostic.",
        status: "unavailable",
      },
    });
  });
test("creates and signs in an isolated account generation", async () => {
    const { service, codex } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Personal" }, { signal }) as { account: { id: string } };
    const result = await service.execute({ kind: "account.login", account: added.account.id, deviceCode: true }, { signal }) as { account: { state: string; processGeneration: number } };
    expect(result.account).toMatchObject({ state: "signed_in", processGeneration: 1 });
    expect(codex.calls[0]).toContain(":1:device_code");
  });
test("shows a pristine signed-out account without touching Codex", async () => {
    const { service, codex } = await fixture();
    const added = await service.execute(
      { kind: "account.add", label: "Pristine" },
      { signal },
    ) as { account: { id: string } };

    await expect(service.execute({
      kind: "account.show",
      account: added.account.id,
    }, { signal })).resolves.toMatchObject({
      account: {
        id: added.account.id,
        label: "Pristine",
        processGeneration: 0,
        state: "signed_out",
      },
    });
    expect(codex.calls).toEqual([]);
  });
describe.each(["claude"] as const)("exact %s login completion", (provider) => {
    test.each(["missing", "provenance", "binding", "process"] as const)("refuses %s authority before any status read", async (corruption) => {
      const value = await isolatedLoginCompletionFixture(provider);
      const readAuthorities = value.store.readMutationProviderAuthorities.bind(value.store);
      const captured = readAuthorities(value.prepared.login.attemptId);
      const mutationBefore = value.store.readMutation(value.key);
      const original = value.store.requireProviderAccountAuthority(value.profile.id, provider);
      const readsBefore = value.providerReadCalls();
      if (corruption === "binding") {
        value.store.observeProviderAccountReadiness({
          profileId: value.profile.id, provider,
          expectedBindingGeneration: original.bindingGeneration, readiness: "signed_in",
        });
      } else if (corruption === "process") {
        value.corruptProviderProcess();
      } else {
        Object.defineProperty(value.store, "readMutationProviderAuthorities", {
          configurable: true,
          value: (attemptId: Parameters<StateStore["readMutationProviderAuthorities"]>[0]) => {
            const recorded = readAuthorities(attemptId);
            if (attemptId !== value.prepared.login.attemptId) return recorded;
            return corruption === "missing" ? [] : recorded.map((entry) => ({ ...entry, provenance: "unproved_login" }));
          },
        });
      }
      try {
        await expect(value.service.execute(value.complete, { signal })).rejects.toMatchObject({ code: "CONFLICT" });
        expect(value.providerReadCalls()).toBe(readsBefore);
        expect(value.providerSessionCalls).toEqual([]);
        expect(value.store.readMutation(value.key)).toEqual(mutationBefore);
      } finally {
        Object.defineProperty(value.store, "readMutationProviderAuthorities", { configurable: true, value: readAuthorities });
      }
      expect(readAuthorities(value.prepared.login.attemptId)).toEqual(captured);
    });

    test.each(["binding", "process"] as const)("refuses settlement when %s authority retires during status read", async (retirement) => {
      const value = await isolatedLoginCompletionFixture(provider);
      const original = value.store.requireProviderAccountAuthority(value.profile.id, provider);
      const captured = value.store.readMutationProviderAuthorities(value.prepared.login.attemptId);
      const mutationBefore = value.store.readMutation(value.key);
      const readsBefore = value.providerReadCalls();
      value.setProviderReadHook(() => {
        if (retirement === "binding") value.store.observeProviderAccountReadiness({
          profileId: value.profile.id, provider,
          expectedBindingGeneration: original.bindingGeneration, readiness: "signed_in",
        });
        else value.corruptProviderProcess();
      });
      await expect(value.service.execute(value.complete, { signal })).rejects.toMatchObject({ code: "CONFLICT" });
      expect(value.providerReadCalls()).toBe(readsBefore + 1);
      expect(value.readAuthorities.at(-1)).toMatchObject({
        id: original.profileId, provider, providerAccountId: original.providerAccountId,
        bindingGeneration: original.bindingGeneration, generation: original.processGeneration,
      });
      expect(value.store.readMutation(value.key)).toEqual(mutationBefore);
      expect(value.store.readMutationProviderAuthorities(value.prepared.login.attemptId)).toEqual(captured);
      expect(value.providerSessionCalls).toEqual([]);
    });

    test("ignores sibling generation advances while settling the original provider authority", async () => {
      const value = await isolatedLoginCompletionFixture(provider);
      const original = value.store.requireProviderAccountAuthority(value.profile.id, provider);
      const captured = value.store.readMutationProviderAuthorities(value.prepared.login.attemptId);
      value.setProviderReadHook(() => {
        for (const other of ["codex"] as const) {
          const authority = value.store.requireProviderAccountAuthority(value.profile.id, other);
          value.store.advanceProviderAccountProcessGeneration({
            profileId: value.profile.id, provider: other, expectedProcessGeneration: authority.processGeneration,
          });
        }
      });
      await expect(value.service.execute(value.complete, { signal })).resolves.toMatchObject({
        authentication: { provider, signedIn: true }, login: { status: "signed_in" },
      });
      expect(value.store.readMutation(value.key)).toMatchObject({ state: "applied" });
      expect(value.store.requireProviderAccountAuthority(value.profile.id, provider)).toEqual(original);
      expect(value.store.readMutationProviderAuthorities(value.prepared.login.attemptId)).toEqual(captured);
      expect(value.providerSessionCalls).toEqual([]);
    });
  });
test("preserves historical Devin login custody until exact acknowledged cleanup", async () => {
    const value = await archivedDevinFixture();
    const profile = value.captured.profile;
    const key = value.captured.idempotencyKey;
    const attemptId = value.captured.mutation.id;
    const original = value.store.readMutation(key);
    const status = await value.service.execute({
      kind: "account.show", account: profile.id, provider: "devin",
    }, { signal }) as { recovery: Record<string, unknown> };
    expect(status.recovery).toMatchObject({ required: true, attemptId, idempotencyKey: key });
    expect(status.recovery.sameKeyReplayCommand)
      .toBe(`oompa account login ${profile.id} --provider devin --idempotency-key ${key}`);
    expect(value.store.readMutation(key)?.state).toBe("effect_started");
    const command = {
      kind: "account.devin-login.abandon", account: profile.id,
      attemptId, idempotencyKey: key, providerGeneration: profile.processGeneration,
      acknowledgeChildExited: true,
    } as const;
    await expect(value.service.execute({
      ...command, providerGeneration: profile.processGeneration + 1,
    }, { signal })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(value.store.readMutation(key)?.state).toBe("effect_started");
    await expect(value.service.execute(command, { signal })).resolves.toMatchObject({
      login: { status: "abandoned", localOnly: true, credentialAction: "none" },
    });
    expect(value.store.readMutation(key)).toMatchObject({
      state: "reconciled", resolution: { kind: "abandoned" },
    });
    expect(value.store.readMutation(key)?.evidence).toEqual(original?.evidence);
    expect(value.store.readMutation(key)?.requestDigest).toBe(original?.requestDigest);
    expect(value.codex.calls).toEqual([]);
  });
test("reports Devin auth separately, preserves unknown allowance, and settles one foreground login", async () => {
    const value = await devinAccountFixture();
    const added = await value.service.execute(
      { kind: "account.add", label: "Devin private" },
      { signal },
    ) as { account: { id: `acct_${string}` } };

    await expect(value.service.execute({
      kind: "account.show",
      account: added.account.id,
      provider: "devin",
    }, { signal })).resolves.toMatchObject({
      account: { id: added.account.id, label: "Devin private" },
      authentication: { provider: "devin", signedIn: false },
      nextCommand: `oompa account login ${added.account.id} --provider devin`,
      providerGeneration: 0,
      usage: {
        allowance: "unknown",
        reason: "Devin ACP reports context and optional cumulative session cost, but exposes no account allowance or reset window.",
        source: "devin_acp",
      },
    });

    const key = "00000000-0000-4000-8000-000000000711";
    const prepared = await value.service.execute({
      kind: "account.devin-login.prepare",
      account: added.account.id,
      idempotencyKey: key,
      manualTokenFlow: true,
    }, { signal }) as {
      login: { attemptId: `attempt_${string}`; providerGeneration: number };
    };
    expect(prepared).toMatchObject({
      authentication: { provider: "devin", signedIn: false },
      login: { status: "launch_granted", idempotencyKey: key },
    });
    const readsBeforeRecovery = value.devinReadCalls();
    await expect(value.service.execute({
      kind: "account.show",
      account: added.account.id,
      provider: "devin",
    }, { signal })).resolves.toMatchObject({
      authentication: { provider: "devin", signedIn: null },
      recovery: {
        required: true,
        attemptId: prepared.login.attemptId,
        idempotencyKey: key,
      },
      usage: { allowance: "unknown", source: "devin_acp" },
    });
    expect(value.devinReadCalls()).toBe(readsBeforeRecovery);

    value.setDevinSignedIn(true);
    await expect(value.service.execute({
      kind: "account.devin-login.complete",
      account: added.account.id,
      attemptId: prepared.login.attemptId,
      idempotencyKey: key,
      providerGeneration: prepared.login.providerGeneration,
      outcome: { state: "joined", exitCode: 0, interruptedBy: null },
    }, { signal })).resolves.toMatchObject({
      authentication: { provider: "devin", signedIn: true },
      login: { status: "signed_in" },
    });
    expect(value.store.readMutation(key)).toMatchObject({ state: "applied" });

    value.setDevinReadError(new Error("terminal replay must not inspect Devin auth"));
    await expect(value.service.execute({
      kind: "account.devin-login.prepare",
      account: added.account.id,
      idempotencyKey: key,
      manualTokenFlow: false,
    }, { signal })).resolves.toMatchObject({
      authentication: { provider: "devin", signedIn: true },
      login: { status: "signed_in" },
    });
    expect(value.providerSessionCalls).toEqual([]);
  });
test("records signed-in Devin readiness and one exact generation after a joined foreground login", async () => {
    const value = await devinAccountFixture();
    const added = await value.service.execute(
      { kind: "account.add", label: "Devin readiness" },
      { signal },
    ) as { account: { id: `acct_${string}` } };
    const key = "00000000-0000-4000-8000-000000000713";
    const prepared = await value.service.execute({
      kind: "account.devin-login.prepare",
      account: added.account.id,
      idempotencyKey: key,
      manualTokenFlow: false,
    }, { signal }) as {
      login: { attemptId: `attempt_${string}`; providerGeneration: number };
    };
    const granted = value.store.requireProviderAccountAuthority(added.account.id, "devin");
    expect(value.store.requireProviderAccountForProfile(added.account.id, "devin"))
      .toMatchObject({ readiness: "unverified", readinessObservedAt: null });

    value.setDevinSignedIn(true);
    await expect(value.service.execute({
      kind: "account.devin-login.complete",
      account: added.account.id,
      attemptId: prepared.login.attemptId,
      idempotencyKey: key,
      providerGeneration: prepared.login.providerGeneration,
      outcome: { state: "joined", exitCode: 0, interruptedBy: null },
    }, { signal })).resolves.toMatchObject({
      authentication: { provider: "devin", signedIn: true },
      login: { status: "signed_in" },
    });

    const settled = value.store.requireProviderAccountForProfile(added.account.id, "devin");
    expect(settled.readiness).toBe("signed_in");
    expect(settled.readinessObservedAt).not.toBeNull();
    // One readiness change is exactly one binding advance, and the login never
    // rotates the Devin process fence it settled under.
    expect(settled.bindingGeneration).toBe(granted.bindingGeneration + 1);
    expect(settled.processGeneration).toBe(prepared.login.providerGeneration);
    const current = value.store.requireProviderAccountAuthority(added.account.id, "devin");
    expect(current).toMatchObject({
      providerAccountId: granted.providerAccountId,
      processGeneration: granted.processGeneration,
      bindingGeneration: granted.bindingGeneration + 1,
    });

    // Replaying the same terminal receipt must stay idempotent.
    value.setDevinReadError(new Error("terminal replay must not inspect Devin auth"));
    await expect(value.service.execute({
      kind: "account.devin-login.complete",
      account: added.account.id,
      attemptId: prepared.login.attemptId,
      idempotencyKey: key,
      providerGeneration: prepared.login.providerGeneration,
      outcome: { state: "joined", exitCode: 0, interruptedBy: null },
    }, { signal })).resolves.toMatchObject({
      authentication: { provider: "devin", signedIn: true },
    });
    expect(value.store.requireProviderAccountForProfile(added.account.id, "devin"))
      .toMatchObject({
        readiness: "signed_in",
        bindingGeneration: granted.bindingGeneration + 1,
        processGeneration: granted.processGeneration,
      });
    expect(value.providerSessionCalls).toEqual([]);
  });
test("grants Claude foreground login once and accepts a status-versus-complete race", async () => {
    const value = await claudeAccountFixture();
    const added = await value.service.execute(
      { kind: "account.add", label: "Claude private" },
      { signal },
    ) as { account: { id: `acct_${string}` } };
    const key = "00000000-0000-4000-8000-000000000701";
    const prepared = await value.service.execute({
      kind: "account.claude-login.prepare",
      account: added.account.id,
      idempotencyKey: key,
    }, { signal }) as {
      login: { attemptId: `attempt_${string}`; providerGeneration: number };
    };
    await expect(value.service.execute({
      kind: "account.claude-login.prepare",
      account: added.account.id,
      idempotencyKey: key,
    }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    await expect(value.service.execute({
      kind: "account.claude-login.prepare",
      account: added.account.id,
      idempotencyKey: "00000000-0000-4000-8000-000000000702",
    }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });

    value.setClaudeSignedIn(true);
    value.setClaudeReadError(new Error("Claude runtime drift must not hide recovery"));
    const readsBeforeRecoveryStatus = value.claudeReadCalls();
    const status = await value.service.execute({
      kind: "account.show",
      account: added.account.id,
      provider: "claude",
    }, { signal }) as Record<string, unknown> & { account: Record<string, unknown> };
    expect(status).toMatchObject({
      account: { id: added.account.id, label: "Claude private" },
      authentication: { provider: "claude", signedIn: null },
      providerGeneration: 0,
      recovery: {
        required: true,
        attemptId: prepared.login.attemptId,
        idempotencyKey: key,
        abandonCommand: `oompa account login-cancel ${added.account.id} --provider claude --attempt-id ${prepared.login.attemptId} --provider-generation 0 --idempotency-key ${key} --acknowledge-child-exited`,
      },
    });
    expect(value.claudeReadCalls()).toBe(readsBeforeRecoveryStatus);
    expect(Object.keys(status.account).sort()).toEqual(["id", "label"]);
    expect(value.store.readMutation(key)).toMatchObject({ state: "effect_started" });

    value.setClaudeReadError(undefined);
    await expect(value.service.execute({
      kind: "account.claude-login.complete",
      account: added.account.id,
      attemptId: prepared.login.attemptId,
      idempotencyKey: key,
      providerGeneration: prepared.login.providerGeneration,
      outcome: { state: "joined", exitCode: 0, interruptedBy: null },
    }, { signal })).resolves.toMatchObject({
      authentication: { provider: "claude", signedIn: true },
      login: { status: "signed_in" },
    });
    expect(value.store.readMutation(key)).toMatchObject({ state: "applied" });
    value.setClaudeSignedIn(false);
    value.setClaudeReadError(new Error("terminal replay must restore its receipt"));
    await expect(value.service.execute({
      kind: "account.claude-login.prepare",
      account: added.account.id,
      idempotencyKey: key,
    }, { signal })).resolves.toMatchObject({
      authentication: { provider: "claude", signedIn: true },
      login: { status: "signed_in" },
    });
  });
test("settles a typed not-started Claude launch without wedging the account", async () => {
    const value = await claudeAccountFixture();
    const added = await value.service.execute(
      { kind: "account.add", label: "Claude spawn" },
      { signal },
    ) as { account: { id: `acct_${string}` } };
    const key = "00000000-0000-4000-8000-000000000703";
    const prepared = await value.service.execute({
      kind: "account.claude-login.prepare",
      account: added.account.id,
      idempotencyKey: key,
    }, { signal }) as { login: { attemptId: `attempt_${string}`; providerGeneration: number } };
    value.setClaudeReadError(new Error("status unavailable after the no-effect spawn failure"));
    await expect(value.service.execute({
      kind: "account.claude-login.complete",
      account: added.account.id,
      attemptId: prepared.login.attemptId,
      idempotencyKey: key,
      providerGeneration: prepared.login.providerGeneration,
      outcome: { state: "not_started", reason: "spawn_failed" },
    }, { signal })).resolves.toMatchObject({
      authentication: { provider: "claude", signedIn: false },
      login: { status: "signed_out" },
    });
    expect(value.store.readMutation(key)).toMatchObject({ state: "failed" });
    value.setClaudeSignedIn(true);
    await expect(value.service.execute({
      kind: "account.claude-login.prepare",
      account: added.account.id,
      idempotencyKey: key,
    }, { signal })).rejects.toMatchObject({ code: "INTERACTION_REQUIRED" });
    value.setClaudeReadError(undefined);
    value.setClaudeSignedIn(false);
    const interruptedKey = "00000000-0000-4000-8000-000000000704";
    const interrupted = await value.service.execute({
      kind: "account.claude-login.prepare",
      account: added.account.id,
      idempotencyKey: interruptedKey,
    }, { signal }) as { login: { attemptId: `attempt_${string}`; providerGeneration: number } };
    value.setClaudeReadError(new Error("interruption before spawn must not read status"));
    await expect(value.service.execute({
      kind: "account.claude-login.complete",
      account: added.account.id,
      attemptId: interrupted.login.attemptId,
      idempotencyKey: interruptedKey,
      providerGeneration: interrupted.login.providerGeneration,
      outcome: {
        state: "not_started",
        reason: "interrupted_before_spawn",
        interruptedBy: "SIGINT",
      },
    }, { signal })).resolves.toMatchObject({
      authentication: { provider: "claude", signedIn: false },
      login: { status: "signed_out" },
    });
    expect(value.store.readMutation(interruptedKey)).toMatchObject({ state: "failed" });
  });
test("preserves the original foreground Claude authority across daemon restart and reconciles its joined completion", async () => {
    const value = await claudeAccountFixture();
    const added = await value.service.execute(
      { kind: "account.add", label: "Claude restart" },
      { signal },
    ) as { account: { id: `acct_${string}` } };
    const codexBefore = value.store.requireProviderAccountAuthority(added.account.id, "codex");
    const launchedAuthority = value.store.advanceProviderAccountProcessGeneration({
      profileId: added.account.id,
      provider: "claude",
      expectedProcessGeneration: 0,
    });
    const key = "00000000-0000-4000-8000-000000000707";
    const prepared = await value.service.execute({
      kind: "account.claude-login.prepare",
      account: added.account.id,
      idempotencyKey: key,
    }, { signal }) as { login: { attemptId: `attempt_${string}`; providerGeneration: number } };
    expect(prepared.login.providerGeneration).toBe(launchedAuthority.processGeneration);
    const captured = value.store.readMutationProviderAuthorities(prepared.login.attemptId);
    expect(captured).toMatchObject([{
      role: "primary",
      authority: {
        profileId: added.account.id,
        provider: "claude",
        processGeneration: launchedAuthority.processGeneration,
      },
      provenance: "account_claude_login",
    }]);
    expect(value.store.nextDaemonGeneration(`boot_${"c".repeat(32)}`)).toBe(value.daemonGeneration + 1);
    expect(value.store.requireProviderAccountAuthority(added.account.id, "claude").processGeneration)
      .toBe(launchedAuthority.processGeneration);
    expect(value.store.requireProviderAccountAuthority(added.account.id, "codex"))
      .toEqual(codexBefore);
    expect(value.store.readMutationProviderAuthorities(prepared.login.attemptId)).toEqual(captured);
    expect(value.store.recoverEffectStartedMutations()).toEqual({
      recovered: [prepared.login.attemptId],
      unresolved: [],
    });
    value.setClaudeSignedIn(true);
    await expect(value.service.execute({
      kind: "account.show",
      account: added.account.id,
      provider: "claude",
    }, { signal })).resolves.toMatchObject({
      authentication: { provider: "claude", signedIn: null },
      recovery: { required: true, attemptId: prepared.login.attemptId },
    });
    expect(value.store.readMutation(key)).toMatchObject({ state: "ambiguous" });
    const complete = {
      kind: "account.claude-login.complete" as const,
      account: added.account.id,
      attemptId: prepared.login.attemptId,
      idempotencyKey: key,
      providerGeneration: prepared.login.providerGeneration,
      outcome: { state: "joined" as const, exitCode: 0, interruptedBy: null },
    };
    await expect(value.service.execute(complete, { signal })).resolves.toMatchObject({
      authentication: { provider: "claude", signedIn: true },
      login: { status: "signed_in", providerGeneration: launchedAuthority.processGeneration },
    });
    expect(value.store.readMutation(key)).toMatchObject({
      state: "reconciled",
      originalState: "ambiguous",
      resolution: { kind: "proven_applied" },
    });
    await expect(value.service.execute(complete, { signal })).resolves.toMatchObject({
      authentication: { provider: "claude", signedIn: true },
      login: { status: "signed_in" },
    });
    value.setClaudeSignedIn(false);
    value.setClaudeReadError(new Error("resolved replay must restore its receipt"));
    await expect(value.service.execute({
      kind: "account.claude-login.prepare",
      account: added.account.id,
      idempotencyKey: key,
    }, { signal })).resolves.toMatchObject({
      authentication: { provider: "claude", signedIn: true },
      login: { status: "signed_in" },
    });
  });
test.each(["missing", "binding", "provenance"] as const)(
    "refuses historical Claude login recovery without its exact immutable authority (%s)",
    (corruption) => ownedServiceCase(async ({ createFixture, signal }) => {
      const value = await claudeAccountFixture(false, "linux", createFixture);
      signal.throwIfAborted();
      const added = await value.service.execute(
        { kind: "account.add", label: "Claude immutable login" },
        { signal },
      ) as { account: { id: `acct_${string}` } };
      value.store.advanceProviderAccountProcessGeneration({
        profileId: added.account.id,
        provider: "claude",
        expectedProcessGeneration: 0,
      });
      const key = crypto.randomUUID();
      const prepared = await value.service.execute({
        kind: "account.claude-login.prepare",
        account: added.account.id,
        idempotencyKey: key,
      }, { signal }) as { login: { attemptId: `attempt_${string}` } };
      const readAuthorities = value.store.readMutationProviderAuthorities.bind(value.store);
      const captured = readAuthorities(prepared.login.attemptId);
      value.store.nextDaemonGeneration(`boot_${"e".repeat(32)}`);
      const readsBeforeRecovery = value.claudeReadCalls();
      Object.defineProperty(value.store, "readMutationProviderAuthorities", {
        configurable: true,
        value: (attemptId: Parameters<StateStore["readMutationProviderAuthorities"]>[0]) => {
          const recorded = readAuthorities(attemptId);
          if (attemptId !== prepared.login.attemptId) return recorded;
          if (corruption === "missing") return [];
          return recorded.map((entry) => corruption === "provenance"
            ? { ...entry, provenance: "unproved_claude_login" }
            : {
                ...entry,
                authority: {
                  ...entry.authority,
                  bindingGeneration: entry.authority.bindingGeneration + 1,
                },
              });
        },
      });
      try {
        expect(value.store.recoverEffectStartedMutations()).toEqual({
          recovered: [],
          unresolved: [{
            id: prepared.login.attemptId,
            kind: "account.claude-login",
            authorityId: added.account.id,
          }],
        });
        expect(value.store.readMutation(key)).toMatchObject({ state: "effect_started" });
        expect(value.claudeReadCalls()).toBe(readsBeforeRecovery);
        expect(value.providerSessionCalls).toEqual([]);
      } finally {
        Object.defineProperty(value.store, "readMutationProviderAuthorities", {
          configurable: true,
          value: readAuthorities,
        });
      }
      expect(readAuthorities(prepared.login.attemptId)).toEqual(captured);
    }),
  );
test("abandons only one exact unsettled Claude fence after explicit child-exit acknowledgement", async () => {
    const value = await claudeAccountFixture();
    const added = await value.service.execute(
      { kind: "account.add", label: "Claude abandon" },
      { signal },
    ) as { account: { id: `acct_${string}` } };
    const launchedAuthority = value.store.advanceProviderAccountProcessGeneration({
      profileId: added.account.id,
      provider: "claude",
      expectedProcessGeneration: 0,
    });
    const key = "00000000-0000-4000-8000-000000000709";
    const prepared = await value.service.execute({
      kind: "account.claude-login.prepare",
      account: added.account.id,
      idempotencyKey: key,
    }, { signal }) as { login: { attemptId: `attempt_${string}`; providerGeneration: number } };
    expect(prepared.login.providerGeneration).toBe(launchedAuthority.processGeneration);
    const captured = value.store.readMutationProviderAuthorities(prepared.login.attemptId);
    expect(value.store.nextDaemonGeneration(`boot_${"d".repeat(32)}`)).toBe(value.daemonGeneration + 1);
    expect(value.store.recoverEffectStartedMutations()).toEqual({
      recovered: [prepared.login.attemptId],
      unresolved: [],
    });
    value.setClaudeReadError(new Error("abandon must not inspect or mutate Claude"));
    const readsBeforeAbandon = value.claudeReadCalls();
    const abandon = {
      kind: "account.claude-login.abandon" as const,
      account: added.account.id,
      attemptId: prepared.login.attemptId,
      idempotencyKey: key,
      providerGeneration: launchedAuthority.processGeneration,
      acknowledgeChildExited: true as const,
    };
    await expect(value.service.execute({
      ...abandon,
      idempotencyKey: "00000000-0000-4000-8000-000000000710",
    }, { signal })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(value.service.execute({
      ...abandon,
      providerGeneration: launchedAuthority.processGeneration + 1,
    }, { signal })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(value.service.execute(abandon, { signal })).resolves.toMatchObject({
      account: { id: added.account.id, label: "Claude abandon" },
      login: {
        status: "abandoned",
        localOnly: true,
        credentialAction: "none",
      },
    });
    expect(value.store.readMutation(key)).toMatchObject({
      state: "reconciled",
      originalState: "ambiguous",
      resolution: {
        kind: "abandoned",
        evidence: {
          acknowledgedChildExited: true,
          credentialAction: "none",
          localOnly: true,
        },
      },
    });
    await expect(value.service.execute(abandon, { signal })).resolves.toMatchObject({
      login: { status: "abandoned" },
    });
    await expect(value.service.execute({
      kind: "account.claude-login.prepare",
      account: added.account.id,
      idempotencyKey: key,
    }, { signal })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(value.service.execute({
      kind: "account.claude-login.complete",
      account: added.account.id,
      attemptId: prepared.login.attemptId,
      idempotencyKey: key,
      providerGeneration: launchedAuthority.processGeneration,
      outcome: { state: "joined", exitCode: 0, interruptedBy: null },
    }, { signal })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(value.claudeReadCalls()).toBe(readsBeforeAbandon);
    expect(value.store.readMutationProviderAuthorities(prepared.login.attemptId)).toEqual(captured);
  });
test("refuses Claude login before provider status while a Claude session is starting", async () => {
    const value = await claudeAccountFixture();
    const added = await value.service.execute(
      { kind: "account.add", label: "Claude session owner" },
      { signal },
    ) as { account: { id: `acct_${string}` } };
    value.store.createSession({
      profileId: added.account.id,
      provider: "claude",
      preset: "fable-max",
      fastEnabled: false,
    });
    value.setClaudeReadError(new Error("session fence must precede provider status"));
    await expect(value.service.execute({
      kind: "account.claude-login.prepare",
      account: added.account.id,
      idempotencyKey: "00000000-0000-4000-8000-000000000711",
    }, { signal })).rejects.toMatchObject({
      code: "CONFLICT",
      details: { provider: "claude", reason: "active_session", retryable: true },
    });
  });
test("refuses a new Claude login before probe or idle-session release while Codex auth is unbound", async () => {
    const value = await claudeAccountFixture();
    const added = await value.service.execute({ kind: "account.add", label: "Shared auth fence" }, { signal }) as { account: { id: `acct_${string}` } };
    value.codex.beforeLoginReturn = async () => { throw new IndeterminateCodexEffectError("account/login/start", 12); };
    await expect(value.service.execute({ kind: "account.login", account: added.account.id, deviceCode: true }, { signal }))
      .rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    value.store.nextProfileGeneration(added.account.id);
    // Model retained local sibling state without importing new provider
    // authority into an account that is already quarantined.
    const starting = value.store.createSession({
      profileId: added.account.id, provider: "claude", title: "Preserved Claude session",
      preset: "fable-max", fastEnabled: false,
    });
    const idle = value.store.bindSession({
      sessionId: starting.id, expectedRevision: starting.revision,
      providerThreadId: "claude-shared-auth-fence", state: "idle",
    });
    const before = value.store.requireSession(idle.id);
    const key = "00000000-0000-4000-8000-000000000723";
    await expect(value.service.execute({ kind: "account.claude-login.prepare", account: added.account.id, idempotencyKey: key }, { signal }))
      .rejects.toMatchObject({ code: "RECOVERY_REQUIRED", details: { reason: "account_mutation_unsettled" } });
    expect(value.claudeReadCalls()).toBe(0);
    expect(value.providerSessionCalls).toEqual([]);
    expect(value.store.requireSession(idle.id)).toEqual(before);
    expect(value.store.readMutation(key)).toBeNull();
  });
test("prepares managed Claude login without releasing an adopted personal Claude controller", async () => {
    const value = await adoptedClaudeFixture(
      "Personal Claude survives managed login",
      "personal-claude-managed-login",
    );
    const beforeSession = value.store.requireSession(value.session.id);
    const beforeBinding = value.store.readSessionPersonalRuntimeBinding(
      value.session.id,
    );
    const beforeProcess = value.store.readClaudeProcessAuthority({
      providerThreadId: "personal-claude-managed-login",
      profileId: value.accountId,
      runtimeScope: "personal",
    });
    value.managedClaude.accountProjection = { signedIn: false };

    await expect(value.service.execute({
      kind: "account.claude-login.prepare",
      account: value.accountId,
      idempotencyKey: "00000000-0000-4000-8000-000000000715",
    }, { signal })).resolves.toMatchObject({
      authentication: { provider: "claude", signedIn: false },
      login: { status: "launch_granted" },
    });

    expect(value.managedClaude.endRequests).toEqual([]);
    expect(value.personalClaude.endRequests).toEqual([]);
    expect(value.store.requireSession(value.session.id)).toEqual(beforeSession);
    expect(value.store.readSessionPersonalRuntimeBinding(value.session.id))
      .toEqual(beforeBinding);
    expect(value.store.readClaudeProcessAuthority({
      providerThreadId: "personal-claude-managed-login",
      profileId: value.accountId,
      runtimeScope: "personal",
    })).toEqual(beforeProcess);
  });
test("gates new Claude effects on Darwin but preserves exact unresolved login recovery", async () => {
    const value = await claudeAccountFixture(false, "darwin");
    const added = await value.service.execute(
      { kind: "account.add", label: "Darwin Claude" },
      { signal },
    ) as { account: { id: `acct_${string}` } };
    await value.service.execute({
      account: added.account.id,
      deviceCode: false,
      kind: "account.login",
    }, { signal });
    await value.service.execute(
      { kind: "project.add", label: "Darwin docs", path: value.documents },
      { signal },
    );
    const started = await value.service.execute({
      account: added.account.id,
      fast: false,
      kind: "session.start",
      preset: "high",
      presetContract: 2,
    }, { signal }) as { session: { id: `sess_${string}` } };
    const loginKey = "00000000-0000-4000-8000-000000000712";
    const expectedPlatformRefusal = {
      code: "UNAVAILABLE",
      details: {
        platform: "darwin",
        provider: "claude",
        reason: "claude_isolation_acceptance_pending",
        retryable: false,
        supportedPlatforms: ["linux"],
      },
      message: expect.stringContaining("currently supported only on Linux"),
    };

    await expect(value.service.execute({
      account: added.account.id,
      kind: "account.show",
      provider: "claude",
    }, { signal })).rejects.toMatchObject(expectedPlatformRefusal);
    await expect(value.service.execute({
      account: added.account.id,
      idempotencyKey: loginKey,
      kind: "account.claude-login.prepare",
    }, { signal })).rejects.toMatchObject(expectedPlatformRefusal);
    await expect(value.service.execute({
      account: added.account.id,
      fast: false,
      idempotencyKey: "00000000-0000-4000-8000-000000000713",
      kind: "session.start",
      preset: "fable-max",
      provider: "claude",
    }, { signal })).rejects.toMatchObject(expectedPlatformRefusal);
    await expect(value.service.execute({
      idempotencyKey: "00000000-0000-4000-8000-000000000714",
      kind: "session.switch",
      provider: "claude",
      session: started.session.id,
    }, { signal })).rejects.toMatchObject(expectedPlatformRefusal);
    expect(value.claudeReadCalls()).toBe(0);
    expect(value.store.readMutation(loginKey)).toBeNull();
    expect(value.store.requireSession(started.session.id)).toMatchObject({
      provider: "codex",
      state: "idle",
    });

    const profile = value.store.requireProfileById(added.account.id);
    const claudeBefore = value.store.requireProviderAccountAuthority(profile.id, "claude");
    expect(claudeBefore.processGeneration).toBe(0);
    const firstClaudeProcess = value.store.advanceProviderAccountProcessGeneration({
      expectedProcessGeneration: claudeBefore.processGeneration,
      profileId: profile.id,
      provider: "claude",
    });
    // Arrange historical recovery independently of the refused platform probes.
    const claudeAuthority = value.store.advanceProviderAccountProcessGeneration({
      expectedProcessGeneration: firstClaudeProcess.processGeneration,
      profileId: profile.id,
      provider: "claude",
    });
    expect(claudeAuthority.processGeneration).not.toBe(profile.processGeneration);
    const recoveryKey = "00000000-0000-4000-8000-000000000715";
    const attempt = value.store.prepareMutation({
      authorityGeneration: claudeAuthority.processGeneration,
      authorityId: profile.id,
      idempotencyKey: recoveryKey,
      kind: "account.claude-login",
      request: { provider: "claude" },
      providerAuthorities: [{
        role: "primary",
        authority: claudeAuthority,
        provenance: "account_claude_login",
      }],
    });
    value.store.beginClaudeLoginMutationEffect({
      attemptId: attempt.id,
      evidence: {
        baselineSignedIn: false,
        kind: "account.claude-login",
        provider: "claude",
      },
      profileGeneration: claudeAuthority.processGeneration,
      profileId: profile.id,
    });
    const abandonCommand = `oompa account login-cancel ${profile.id} --provider claude --attempt-id ${attempt.id} --provider-generation ${String(claudeAuthority.processGeneration)} --idempotency-key ${recoveryKey} --acknowledge-child-exited`;
    await expect(value.service.execute({
      account: profile.id,
      kind: "account.show",
      provider: "claude",
    }, { signal })).resolves.toMatchObject({
      account: { id: profile.id, label: "Darwin Claude" },
      authentication: { provider: "claude", signedIn: null },
      recovery: {
        abandonCommand,
        attemptId: attempt.id,
        idempotencyKey: recoveryKey,
        providerGeneration: claudeAuthority.processGeneration,
        required: true,
      },
    });
    expect(value.claudeReadCalls()).toBe(0);
    await expect(value.service.execute({
      account: profile.id,
      attemptId: attempt.id,
      idempotencyKey: recoveryKey,
      kind: "account.claude-login.complete",
      outcome: { state: "joined", exitCode: 0, interruptedBy: null },
      providerGeneration: claudeAuthority.processGeneration,
    }, { signal })).rejects.toMatchObject(expectedPlatformRefusal);
    expect(value.claudeReadCalls()).toBe(0);
    expect(value.providerSessionCalls).toEqual([]);
    expect(value.store.readMutation(recoveryKey)).toMatchObject({ state: "effect_started" });
    await expect(value.service.execute({
      account: profile.id,
      acknowledgeChildExited: true,
      attemptId: attempt.id,
      idempotencyKey: recoveryKey,
      kind: "account.claude-login.abandon",
      providerGeneration: claudeAuthority.processGeneration,
    }, { signal })).resolves.toMatchObject({
      login: { localOnly: true, status: "abandoned" },
    });
  });
test("keeps durable Claude state readable on Darwin without resubscribe, dispatch, or effects", async () => {
    const value = await claudeAccountFixture(false, "darwin");
    const added = await value.service.execute(
      { kind: "account.add", label: "Darwin upgrade" },
      { signal },
    ) as { account: { id: `acct_${string}` } };
    await value.service.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: false,
    }, { signal });
    const profile = value.store.requireProfileById(added.account.id);
    const idle = value.store.upsertProviderSession({
      providerAuthority: value.store.requireProviderAccountAuthority(profile.id, "claude"),
      fastEnabled: false,
      preset: "fable-max",
      profileId: profile.id,
      provider: "claude",
      providerThreadId: "claude-thread-darwin-idle",
      providerAccountKey: claudeProviderAccountKey(),
      state: "idle",
      title: "Darwin idle session",
    });
    value.store.appendSessionEvent({
      accountId: profile.id,
      body: {
        actor: "human",
        omittedCharacters: 0,
        text: "durable local message",
        turnId: null,
        type: "user_message",
      },
      providerConnectionId: null,
      providerGeneration: value.store.requireProviderAccountAuthority(profile.id, "claude").processGeneration,
      providerAuthority: value.store.requireProviderAccountAuthority(profile.id, "claude"),
      sessionId: idle.id,
    });
    const queued = value.store.enqueue(idle.id, "preserve pending queue");
    const active = value.store.upsertProviderSession({
      providerAuthority: value.store.requireProviderAccountAuthority(profile.id, "claude"),
      fastEnabled: false,
      preset: "fable-max",
      profileId: profile.id,
      provider: "claude",
      activeTurnId: "claude-turn-darwin-active",
      providerThreadId: "claude-thread-darwin-active",
      providerAccountKey: claudeProviderAccountKey(),
      state: "active",
      title: "Darwin active session",
    });

    await value.service.recover();
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    expect(value.providerSessionCalls).toEqual([]);
    expect(value.store.requireQueue(queued.id)).toMatchObject({ state: "pending" });
    expect(value.store.requireSession(active.id)).toMatchObject({ state: "active" });

    await expect(value.service.execute({
      kind: "session.status",
      session: idle.id,
    }, { signal })).resolves.toMatchObject({
      providerObservation: {
        basis: "local_state",
        code: "provider_platform_unavailable",
        state: "unavailable",
      },
      session: { id: idle.id },
    });
    await expect(value.service.execute({
      detail: true,
      kind: "session.show",
      session: idle.id,
    }, { signal })).resolves.toMatchObject({
      providerObservation: {
        code: "provider_platform_unavailable",
        state: "unavailable",
      },
      session: { id: idle.id, provider: "claude" },
    });
    await expect(value.service.execute({
      kind: "session.events",
      limit: 20,
      session: idle.id,
      waitMs: 0,
    }, { signal })).resolves.toMatchObject({
      events: [{ body: { text: "durable local message", type: "user_message" } }],
    });
    await expect(value.service.execute({
      kind: "session.transcript",
      limit: 20,
      session: idle.id,
    }, { signal })).resolves.toMatchObject({
      records: [{ actor: "human", kind: "user", text: "durable local message" }],
      sessionId: idle.id,
    });
    await expect(value.service.execute({
      kind: "session.transcript",
      limit: 20,
      session: idle.id,
      tail: true,
    }, { signal })).resolves.toMatchObject({
      provider: "claude",
      records: [{ actor: "human", kind: "user", text: "durable local message" }],
      sessionId: idle.id,
    });

    const refusal = {
      code: "UNAVAILABLE",
      details: { provider: "claude", reason: "claude_isolation_acceptance_pending" },
    };
    const effectKeys = [
      "00000000-0000-4000-8000-000000000716",
      "00000000-0000-4000-8000-000000000717",
      "00000000-0000-4000-8000-000000000718",
      "00000000-0000-4000-8000-000000000719",
    ] as const;
    await expect(value.service.execute({
      idempotencyKey: effectKeys[0],
      kind: "session.send",
      message: "do not send",
      session: idle.id,
    }, { signal })).rejects.toMatchObject(refusal);
    await expect(value.service.execute({
      idempotencyKey: effectKeys[1],
      kind: "session.steer",
      message: "do not steer",
      session: idle.id,
    }, { signal })).rejects.toMatchObject(refusal);
    await expect(value.service.execute({
      idempotencyKey: effectKeys[2],
      kind: "session.stop",
      session: idle.id,
    }, { signal })).rejects.toMatchObject(refusal);
    await expect(value.service.execute({
      idempotencyKey: effectKeys[3],
      kind: "session.queue",
      message: "do not queue",
      session: idle.id,
    }, { signal })).rejects.toMatchObject(refusal);
    for (const key of effectKeys) expect(value.store.readMutation(key)).toBeNull();
    expect(value.store.listQueue(idle.id)).toHaveLength(1);

    const interaction = value.store.admitInteraction({
      authority: {
        approvalId: null,
        connectionId: "10000000-0000-4000-8000-000000000091",
        itemId: "toolu_darwin",
        method: "claude/control_request/can_use_tool",
        ...value.store.requireProviderAccountAuthority(profile.id, "claude"),
        requestDigest: "a".repeat(64),
        requestId: { type: "string", value: "darwin-request" },
        threadId: "claude-thread-darwin-idle",
        turnId: "claude-turn-darwin",
      },
      blocking: true,
      display: {
        availableDecisions: ["once", "decline", "cancel"],
        commandClass: "shell",
        kind: "command_approval",
        reason: null,
        summary: "Do not resolve on Darwin",
        workingDirectory: null,
      },
      kind: "command_approval",
      publicId: "10000000-0000-4000-8000-000000000092",
      sessionId: idle.id,
    }).record;
    await expect(value.service.execute({
      expectedRevision: interaction.revision,
      interaction: interaction.publicId,
      kind: "interaction.resolve",
      resolution: { decision: "once", kind: "approval_decision" },
    }, { signal })).rejects.toMatchObject(refusal);
    expect(value.store.requireInteraction(interaction.publicId)).toMatchObject({
      revision: interaction.revision,
      state: "pending",
    });

    const recoveryBound = value.store.upsertProviderSession({
      providerAuthority: value.store.requireProviderAccountAuthority(profile.id, "claude"),
      fastEnabled: false,
      preset: "fable-max",
      profileId: profile.id,
      provider: "claude",
      providerThreadId: "claude-thread-darwin-recovery",
      providerAccountKey: claudeProviderAccountKey(),
      state: "idle",
      title: "Darwin recovery session",
    });
    value.store.quarantineSession(recoveryBound.id);
    await expect(value.service.execute({
      kind: "session.recover",
      session: recoveryBound.id,
    }, { signal })).rejects.toMatchObject(refusal);
    await expect(value.service.execute({
      kind: "session.abandon",
      session: recoveryBound.id,
    }, { signal })).resolves.toMatchObject({
      recovery: { providerEffectRetried: false, resolution: "abandoned" },
      session: { state: "terminal" },
    });
    expect(value.providerSessionCalls).toEqual([]);
  });
test("validates a supplied Claude login key before signed-in short-circuiting", async () => {
    const value = await claudeAccountFixture(true);
    const first = value.store.createProfile("First");
    const second = value.store.createProfile("Second");
    const wrongKind = "00000000-0000-4000-8000-000000000705";
    value.store.prepareMutation({
      kind: "account.logout",
      authorityId: first.id,
      authorityGeneration: first.processGeneration,
      request: {},
      idempotencyKey: wrongKind,
    });
    await expect(value.service.execute({
      kind: "account.claude-login.prepare",
      account: first.id,
      idempotencyKey: wrongKind,
    }, { signal })).rejects.toMatchObject({ code: "CONFLICT" });

    const wrongAccount = "00000000-0000-4000-8000-000000000706";
    value.store.prepareMutation({
      kind: "account.claude-login",
      authorityId: first.id,
      authorityGeneration: first.processGeneration,
      request: { provider: "claude" },
      idempotencyKey: wrongAccount,
    });
    await expect(value.service.execute({
      kind: "account.claude-login.prepare",
      account: second.id,
      idempotencyKey: wrongAccount,
    }, { signal })).rejects.toMatchObject({ code: "CONFLICT" });
  });
test("returns ID-only signed-out recovery guidance for provider operations", async () => {
    const { service, codex } = await fixture();
    const privateLabel = "Private provider account";
    const added = await service.execute(
      { kind: "account.add", label: privateLabel },
      { signal },
    ) as { account: { id: `acct_${string}` } };

    const failure = await service.execute({
      account: added.account.id,
      kind: "plugin.list",
      refresh: false,
    }, { signal }).catch((error: unknown) => error);
    if (!(failure instanceof CommandFailure)) throw new Error("Expected a signed-out CommandFailure.");
    expect(failure).toMatchObject({
      code: "INTERACTION_REQUIRED",
      details: {
        accountSelector: added.account.id,
        accountState: "signed_out",
        nextCommand: `oompa account login ${added.account.id}`,
      },
      name: "CommandFailure",
    });
    expect(failure.message).not.toContain(privateLabel);
    expect(JSON.stringify(failure.details)).not.toContain(privateLabel);
    expect(codex.calls).toEqual([]);
  });
test("refuses a preset the chosen provider cannot run and a provider the daemon cannot start", async () => {
    const { service, documents } = await fixture();
    const added = await service.execute(
      { kind: "account.add", label: "Providers" },
      { signal },
    ) as { account: { id: `acct_${string}` } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    await service.execute({ kind: "project.add", label: "Provider docs", path: documents }, { signal });

    // A Claude preset on a Codex session is refused, never silently ignored.
    await expect(service.execute({
      kind: "session.start",
      account: added.account.id,
      preset: "fable-max",
      fast: false,
    }, { signal })).rejects.toThrow("does not support the `fable-max` model preset");

    // A Codex preset on a Claude session is refused for the same reason.
    await expect(service.execute({
      kind: "session.start",
      account: added.account.id,
      provider: "claude",
      preset: "ultra",
      presetContract: 2,
      fast: false,
    }, { signal })).rejects.toThrow("does not support the `ultra` model preset");

    // The coherent pair is admitted, but this fixture composes no Claude
    // runtime, so the refusal names the exact pinned release to install.
    await expect(service.execute({
      kind: "session.start",
      account: added.account.id,
      provider: "claude",
      preset: "fable-max",
      fast: false,
    }, { signal })).rejects.toThrow(
      `This daemon has no Claude Code runtime. Install Claude Code ${CLAUDE_PIN} exactly`,
    );

    await expect(service.execute({
      kind: "session.start",
      account: added.account.id,
      provider: "devin",
      preset: "ultra",
      fast: false,
    }, { signal })).rejects.toThrow("does not support the `ultra` model preset");

    await expect(service.execute({
      kind: "session.start",
      account: added.account.id,
      provider: "devin",
      preset: "astra",
      fast: false,
    }, { signal })).rejects.toThrow(
      `This daemon has no Devin runtime. Install Devin CLI ${DEVIN_PIN} exactly`,
    );

    // Every existing Codex path is unchanged.
    const started = await service.execute({
      kind: "session.start",
      account: added.account.id,
      preset: "high",
      presetContract: 2,
      fast: false,
    }, { signal }) as { session: { id: `sess_${string}` } };
    expect(started.session.id).toMatch(/^sess_/u);
  });
test("fails closed for an unrecognized provider-level interaction method", async () => {
    const { store, codex, paths } = await fixture();
    const profile = store.createProfile("Unknown provider interaction");
    const snapshot = () => {
      const database = new Database(paths.database, { strict: true });
      try {
        database.exec("PRAGMA query_only=ON");
        return database.transaction(() => {
          const tables = database.query<{ name: string }, []>(
            "SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name",
          ).all();
          return {
            schema: database.query("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name").all(),
            rows: tables.map(({ name }) => {
              if (!/^[A-Za-z0-9_]+$/u.test(name)) throw new Error("Unexpected fixture table name.");
              return [name, database.query(`SELECT * FROM "${name}"`).all()
                .map((row) => JSON.stringify(row)).sort()];
            }),
          };
        }).deferred();
      } finally { database.close(false); }
    };
    const before = snapshot();
    const calls = [...codex.calls];
    // Unbound unknown methods have no admitted provider source. Known foreign
    // methods cannot borrow the explicitly captured Codex tuple either.
    for (const [method, diagnostic] of [
      ["future-provider/requestApproval", "provider interaction authority mismatch"],
      ["claude/control_request/can_use_tool", "INTERACTION_PROVIDER_AUTHORITY_MISMATCH"],
      ["devin/session/request_permission", "INTERACTION_PROVIDER_AUTHORITY_MISMATCH"],
    ] as const) {
      expect(() => store.admitInteraction({
        authority: {
          ...codexInteractionBinding(store, profile.id),
          approvalId: null,
          connectionId: "30000000-0000-4000-8000-000000000004",
          itemId: "unknown-item",
          method,
          processGeneration: profile.processGeneration,
          profileId: profile.id,
          requestDigest: "a".repeat(64),
          requestId: { type: "string", value: "unknown-request" },
          threadId: null,
          turnId: null,
        },
        blocking: true,
        display: {
          availableDecisions: ["once", "decline", "cancel"],
          commandClass: "unknown",
          kind: "command_approval",
          reason: null,
          summary: "Unknown provider request",
          workingDirectory: null,
        },
        kind: "command_approval",
        publicId: "30000000-0000-4000-8000-000000000005",
        sessionId: null,
      })).toThrow(diagnostic);
      expect(snapshot()).toEqual(before);
    }
    expect(codex.calls).toEqual(calls);
    expect(codex.inspectedInteractions).toEqual([]);
    expect(codex.validatedInteractions).toEqual([]);
    expect(codex.resolvedInteractions).toEqual([]);
    expect(codex.validatedInteractionTimeouts).toEqual([]);
    expect(codex.timedOutInteractions).toEqual([]);
  });
test("fails closed for unknown or cross-provider methods on a bound session", async () => {
    let now = 50_000;
    const value = await fixture(new FakeCloud(), () => undefined, () => now);
    const { sessionId } = await createIdleSession(value, "Provider-bound interaction");
    const session = value.store.requireSession(sessionId);
    const profile = value.store.requireProfileById(session.profileId);
    if (session.providerThreadId === undefined) throw new Error("Expected a bound session.");

    const snapshot = () => {
      const database = new Database(value.paths.database, { strict: true });
      try {
        database.exec("PRAGMA query_only=ON");
        return database.transaction(() => {
          const tables = database.query<{ name: string }, []>(
            "SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name",
          ).all();
          return {
            schema: database.query("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name").all(),
            rows: tables.map(({ name }) => {
              if (!/^[A-Za-z0-9_]+$/u.test(name)) throw new Error("Unexpected fixture table name.");
              return [name, database.query(`SELECT * FROM "${name}"`).all()
                .map((row) => JSON.stringify(row)).sort()];
            }),
          };
        }).deferred();
      } finally { database.close(false); }
    };
    const input: Parameters<StateStore["admitInteraction"]>[0] = {
      authority: {
        ...codexInteractionBinding(value.store, profile.id),
        approvalId: null,
        connectionId: "30000000-0000-4000-8000-000000000014",
        itemId: "provider-bound-item",
        method: "future-provider/requestApproval",
        processGeneration: profile.processGeneration,
        profileId: profile.id,
        requestDigest: "1".repeat(64),
        requestId: { type: "string", value: "provider-bound-request" },
        threadId: session.providerThreadId,
        turnId: "provider-bound-turn",
      },
      blocking: true,
      display: {
        availableDecisions: ["once", "decline", "cancel"],
        commandClass: "unknown",
        kind: "command_approval",
        reason: null,
        summary: "Provider-bound request",
        workingDirectory: null,
      },
      kind: "command_approval",
      publicId: "30000000-0000-4000-8000-000000000015",
      sessionId: session.id,
    };
    const beforeAdmission = snapshot();
    for (const [method, diagnostic] of [
      ["claude/control_request/can_use_tool", "INTERACTION_PROVIDER_AUTHORITY_MISMATCH"],
      ["devin/session/request_permission", "INTERACTION_PROVIDER_AUTHORITY_MISMATCH"],
    ] as const) {
      expect(() => value.store.admitInteraction({ ...input, authority: { ...input.authority, method } }))
        .toThrow(diagnostic);
      expect(snapshot()).toEqual(beforeAdmission);
    }
    // A bound unknown method can be retained, but it cannot dispatch through
    // the session's otherwise valid captured provider-account authority.
    const interaction = value.store.admitInteraction(input).record;
    const before = snapshot();
    const calls = [...value.codex.calls];
    await expect(value.service.execute({
      kind: "interaction.inspect", interaction: interaction.publicId, expectedRevision: interaction.revision,
    }, { signal })).rejects.toMatchObject({
      code: "RECOVERY_REQUIRED", details: { reason: "interaction_provider_unknown" },
    });
    expect(snapshot()).toEqual(before);
    await expect(value.service.execute({
      expectedRevision: interaction.revision,
      interaction: interaction.publicId,
      kind: "interaction.resolve",
      resolution: { decision: "once", kind: "approval_decision" },
    }, { signal })).rejects.toMatchObject({
      code: "RECOVERY_REQUIRED",
      details: { reason: "interaction_provider_unknown" },
    });
    expect(snapshot()).toEqual(before);
    now = interaction.deadlineAt;
    expect(await value.service.maintainInteractionDeadlines()).toEqual({ examined: 1, failed: 1 });
    expect(value.store.requireInteraction(interaction.publicId)).toEqual(interaction);
    expect(snapshot()).toEqual(before);
    expect(value.codex.calls).toEqual(calls);
    expect(value.codex.inspectedInteractions).toEqual([]);
    expect(value.codex.validatedInteractions).toEqual([]);
    expect(value.codex.resolvedInteractions).toEqual([]);
    expect(value.codex.validatedInteractionTimeouts).toEqual([]);
    expect(value.codex.timedOutInteractions).toEqual([]);
  });
test("starts a native managed Devin session with current keyless authority", async () => {
    const providerThreadId = "native-managed-devin";
    const connectionId = "018f1f55-3f10-7c1a-8f7b-c6dc608bcd3d";
    const reviewed: EffectiveDevinRuntimeProfile[] = [];
    const devin = {
      provider: "devin" as const,
      readAccount: async () => ({ readiness: "signed_in" as const, observedAt: 2_000 }),
      reviewSessionStart: async (
        input: Parameters<DevinRuntimePort["reviewSessionStart"]>[0],
      ) => {
        const effectiveRuntimeProfile: EffectiveDevinRuntimeProfile = {
          profileId: input.authority.id,
          processGeneration: input.authority.generation,
          observedAt: 2_000,
          preset: "astra",
          model: input.requirement.model,
          reasoningEffort: "provider-default",
          devinVersion: DEVIN_PIN,
          protocolVersion: 1,
          isolatedHome: true,
        };
        reviewed.push(effectiveRuntimeProfile);
        return {
          reviewId: crypto.randomUUID(),
          kind: "session_start" as const,
          effectiveRuntimeProfile,
        };
      },
      discardRuntimeReview: () => undefined,
      startSession: async (
        input: Parameters<DevinRuntimePort["startSession"]>[0],
      ) => ({
        providerThreadId,
        title: "Native managed Devin",
        status: "idle" as const,
        providerUpdatedAt: 2_001,
        effectiveRuntimeProfile: input.review.effectiveRuntimeProfile,
      }),
      observeSession: async () => ({
        connectionId,
        projection: {
          providerThreadId,
          title: "Native managed Devin",
          status: "idle" as const,
          providerUpdatedAt: 2_001,
        },
        resumed: true,
      }),
      endSession: async () => undefined,
      close: async () => undefined,
    } as unknown as DevinRuntimePort;
    const value = await fixture(
      new FakeCloud(),
      () => undefined,
      Date.now,
      undefined,
      { devin },
    );
    const added = await value.service.execute(
      { kind: "account.add", label: "Native managed Devin" },
      { signal },
    ) as { account: { id: `acct_${string}` } };
    await value.service.execute({
      kind: "project.add",
      label: "Native managed Devin project",
      path: value.documents,
    }, { signal });

    const started = await value.service.execute({
      kind: "session.start",
      account: added.account.id,
      provider: "devin",
      preset: "astra",
      fast: false,
    }, { signal }) as {
      session: SessionRecord;
      effectiveRuntimeProfile: Record<string, unknown>;
    };

    expect(reviewed).toHaveLength(1);
    expect(started.session).toMatchObject({
      provider: "devin",
      providerThreadId,
      preset: "astra",
      state: "idle",
    });
    expect(value.store.readSessionProviderAccountAuthority(started.session.id)).toBeNull();
    expect(value.store.requireSessionPresetRequirement(started.session.id)).toEqual({
      preset: "astra",
      requirement: presetRequirements.astra,
    });
    expect(started.effectiveRuntimeProfile).not.toHaveProperty("isolatedHome");

    // Devin owns its own process fence. The first session start advances it
    // past the profile's Codex generation, and status must report that exact
    // Devin generation rather than the unrelated Codex counter.
    const devinAuthority = value.store.requireProviderAccountAuthority(added.account.id, "devin");
    expect(devinAuthority.processGeneration).toBe(1);
    expect(value.store.requireProfileById(added.account.id).processGeneration).toBe(0);
    expect(value.store.requireProviderAccountForProfile(added.account.id, "devin"))
      .toMatchObject({ readiness: "signed_in" });
    await expect(value.service.execute({
      kind: "account.show",
      account: added.account.id,
      provider: "devin",
    }, { signal })).resolves.toMatchObject({
      authentication: { provider: "devin", signedIn: true },
      providerGeneration: devinAuthority.processGeneration,
    });
  });
test("archives and unarchives a session and filters the default listing", async () => {
    const { service, documents } = await fixture();
    const added = await service.execute(
      { kind: "account.add", label: "Archiving" },
      { signal },
    ) as { account: { id: `acct_${string}` } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    await service.execute({ kind: "project.add", label: "Archive docs", path: documents }, { signal });
    const started = await service.execute({
      kind: "session.start",
      account: added.account.id,
      preset: "high",
      presetContract: 2,
      fast: false,
    }, { signal }) as { session: { id: `sess_${string}` } };

    const archived = await service.execute({
      kind: "session.archive",
      session: started.session.id,
      archived: true,
    }, { signal }) as { archived: boolean; archivedAt: number | null; session: string };
    expect(archived.session).toBe(started.session.id);
    expect(archived.archived).toBe(true);
    expect(archived.archivedAt).toBeGreaterThan(0);

    const hidden = await service.execute({ kind: "session.list", archived: false, limit: 100 }, { signal }) as {
      sessions: readonly { id: string }[];
    };
    expect(hidden.sessions.map((session) => session.id)).not.toContain(started.session.id);
    const shown = await service.execute({ kind: "session.list", archived: true, limit: 100 }, { signal }) as {
      sessions: readonly { id: string }[];
    };
    expect(shown.sessions.map((session) => session.id)).toContain(started.session.id);

    // The session itself stays fully readable while archived.
    expect(await service.execute({ kind: "session.status", session: started.session.id }, { signal }))
      .toMatchObject({ session: expect.objectContaining({ id: started.session.id }) });

    expect(await service.execute({
      kind: "session.archive",
      session: started.session.id,
      archived: false,
    }, { signal })).toMatchObject({ archived: false, archivedAt: null });
    const restored = await service.execute({ kind: "session.list", archived: false, limit: 100 }, { signal }) as {
      sessions: readonly { id: string }[];
    };
    expect(restored.sessions.map((session) => session.id)).toContain(started.session.id);
  });
test("lists a selected signed-out account's locally stored sessions without provider access", async () => {
    const { service, codex, documents } = await fixture();
    const added = await service.execute(
      { kind: "account.add", label: "Offline sessions" },
      { signal },
    ) as { account: { id: `acct_${string}` } };
    await service.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: false,
    }, { signal });
    await service.execute({
      kind: "project.add",
      label: "Offline docs",
      path: documents,
    }, { signal });
    const started = await service.execute({
      kind: "session.start",
      account: added.account.id,
      preset: "high",
      presetContract: 2,
      fast: false,
    }, { signal }) as { session: { id: `sess_${string}` } };
    await service.execute({
      kind: "account.logout",
      account: added.account.id,
    }, { signal });
    const providerCallsBeforeList = codex.calls.length;

    const unfiltered = await service.execute({
      kind: "session.list",
      archived: false,
      limit: 100,
    }, { signal }) as { sessions: readonly { id: string; profileId: string }[] };
    const selected = await service.execute({
      kind: "session.list",
      archived: false,
      account: added.account.id,
      limit: 100,
    }, { signal });

    expect(selected).toEqual({
      accountId: added.account.id,
      sessions: unfiltered.sessions.filter((session) => session.profileId === added.account.id),
      nextCursor: null,
      listing: {
        accountSelector: added.account.id,
        accountState: "signed_out",
        provider: "codex",
        scope: "local_only",
        freshness: "stale",
        localCompleteness: "complete",
        providerAccess: "not_attempted",
        providerCompleteness: "unknown",
        nextCommand: `oompa account login ${added.account.id}`,
      },
    });
    expect(selected).toMatchObject({ sessions: [{ id: started.session.id }] });
    expect(codex.calls).toHaveLength(providerCallsBeforeList);
  });
test("pages every signed-out local session with account-bound tamper-evident continuations", async () => {
    const { service, store, codex } = await fixture();
    const added = await service.execute(
      { kind: "account.add", label: "Retained local history" },
      { signal },
    ) as { account: { id: `acct_${string}` } };
    for (let index = 0; index < 105; index += 1) {
      store.createSession({
        profileId: added.account.id,
        title: `Local retained ${String(index).padStart(3, "0")}`,
        preset: "high",
        fastEnabled: false,
      });
    }

    const ids: string[] = [];
    let cursor: string | undefined;
    let firstCursor: string | undefined;
    let finalListing: unknown;
    do {
      const page = await service.execute({
        kind: "session.list",
        archived: false,
        account: added.account.id,
        limit: 37,
        ...(cursor === undefined ? {} : { cursor }),
      }, { signal }) as {
        sessions: readonly { id: string }[];
        nextCursor: string | null;
        listing: unknown;
      };
      ids.push(...page.sessions.map((session) => session.id));
      firstCursor ??= page.nextCursor ?? undefined;
      cursor = page.nextCursor ?? undefined;
      finalListing = page.listing;
    } while (cursor !== undefined);

    expect(ids).toHaveLength(105);
    expect(new Set(ids).size).toBe(105);
    expect(firstCursor).toStartWith("hra1.");
    expect(finalListing).toEqual({
      accountSelector: added.account.id,
      accountState: "signed_out",
      provider: "codex",
      scope: "local_only",
      freshness: "stale",
      localCompleteness: "complete",
      providerAccess: "not_attempted",
      providerCompleteness: "unknown",
      nextCommand: `oompa account login ${added.account.id}`,
    });
    expect(codex.calls).toEqual([]);

    if (firstCursor === undefined) throw new Error("Expected a local continuation.");
    const other = await service.execute(
      { kind: "account.add", label: "Other retained history" },
      { signal },
    ) as { account: { id: `acct_${string}` } };
    await expect(service.execute({
      kind: "session.list",
      archived: false,
      account: other.account.id,
      limit: 37,
      cursor: firstCursor,
    }, { signal })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(service.execute({
      kind: "session.list",
      archived: false,
      account: added.account.id,
      limit: 36,
      cursor: firstCursor,
    }, { signal })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(service.execute({
      kind: "session.list",
      archived: true,
      account: added.account.id,
      limit: 37,
      cursor: firstCursor,
    }, { signal })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    const replacement = firstCursor.at(-1) === "A" ? "B" : "A";
    await expect(service.execute({
      kind: "session.list",
      archived: false,
      account: added.account.id,
      limit: 37,
      cursor: `${firstCursor.slice(0, -1)}${replacement}`,
    }, { signal })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(codex.calls).toEqual([]);
  });
test("rejects an all-local cursor after a signed-out account becomes provider-ready", async () => {
    const { service, store, codex } = await fixture();
    const added = await service.execute(
      { kind: "account.add", label: "Pending cursor transition" },
      { signal },
    ) as { account: { id: `acct_${string}` } };
    for (let index = 0; index < 2; index += 1) {
      store.createSession({
        profileId: added.account.id,
        title: `Pending local ${String(index)}`,
        preset: "high",
        fastEnabled: false,
      });
    }
    const first = await service.execute({
      kind: "session.list",
      archived: false,
      account: added.account.id,
      limit: 1,
    }, { signal }) as { sessions: readonly { id: string }[]; nextCursor: string };
    expect(first.sessions).toHaveLength(1);
    expect(first.nextCursor).toStartWith("hra1.");

    await service.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: false,
    }, { signal });
    const providerListsBefore = codex.sessionListRequests.length;
    await expect(service.execute({
      kind: "session.list",
      archived: false,
      account: added.account.id,
      cursor: first.nextCursor,
      limit: 1,
    }, { signal })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(codex.sessionListRequests).toHaveLength(providerListsBefore);
  });
test("returns a stable conflict for a duplicate non-ASCII case-insensitive account label", async () => {
    const { service, store } = await fixture();
    await service.execute({ kind: "account.add", label: "Équipe" }, { signal });

    const failure = await service.execute(
      { kind: "account.add", label: "équipe" },
      { signal },
    ).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      code: "CONFLICT",
      message: "An active account already uses that label.",
      name: "CommandFailure",
    });
    expect(String(failure)).not.toContain("SQLite");
    expect(String(failure)).not.toContain("UNIQUE");
    expect(String(failure)).not.toContain("profiles_label_active");
    expect(String(failure)).not.toContain("profiles_label_key_active");
    expect(store.listProfiles()).toHaveLength(1);
  });
test("returns a stable conflict for a canonically equivalent project label", async () => {
    const { service, store, documents } = await fixture();
    const secondRoot = join(documents, "Other");
    await mkdir(secondRoot, { recursive: true });
    await service.execute({
      kind: "project.add",
      label: "Café",
      path: documents,
    }, { signal });

    const failure = await service.execute({
      kind: "project.add",
      label: "Cafe\u0301",
      path: secondRoot,
    }, { signal }).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      code: "CONFLICT",
      message: "A project already uses that label.",
      name: "CommandFailure",
    });
    expect(String(failure)).not.toContain("SQLite");
    expect(String(failure)).not.toContain("UNIQUE");
    expect(String(failure)).not.toContain("projects_label_unique");
    expect(String(failure)).not.toContain("projects_label_key_unique");
    expect(store.listProjects()).toHaveLength(1);
  });
test("returns a stable conflict when another label names the same project directory", async () => {
    const { service, store, documents } = await fixture();
    await service.execute({
      kind: "project.add",
      label: "Primary",
      path: documents,
    }, { signal });

    const failure = await service.execute({
      kind: "project.add",
      label: "Same directory",
      path: documents,
    }, { signal }).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      code: "CONFLICT",
      message: "A project already uses that directory.",
      name: "CommandFailure",
    });
    expect(String(failure)).not.toContain("SQLite");
    expect(String(failure)).not.toContain("UNIQUE");
    expect(store.listProjects()).toHaveLength(1);
  });
test("maps an existing but noncanonical project root to actionable unavailability", async () => {
    const { service, store, documents } = await fixture();
    const linkedRoot = `${documents}-linked-private`;
    await symlink(documents, linkedRoot, "dir");

    await expect(service.execute({
      kind: "project.add",
      label: "Linked project",
      path: linkedRoot,
    }, { signal })).rejects.toMatchObject({
      code: "UNAVAILABLE",
      details: {
        nextCommand: "oompa doctor",
        repair: "repair_or_select_project",
      },
      message: "The project directory is missing, unsafe, or not readable, writable, traversable, and canonical. Repair it or choose another directory before retrying.",
    });
    expect(store.listProjects()).toHaveLength(0);
  });
test("rejects a post-registration project symlink swap before Codex and reports it in both doctor modes", async () => {
    const { service, codex, documents, store } = await fixture();
    const added = await service.execute(
      { kind: "account.add", label: "Project custody" },
      { signal },
    ) as { account: { id: `acct_${string}` } };
    expect(store.setProfileState(added.account.id, 0, "signed_in", {
      email: "project-custody@example.com",
      plan: "Plus",
    })).toBe(true);
    await service.execute({
      kind: "project.add",
      label: "Custody docs",
      path: documents,
    }, { signal });
    const relocated = `${documents}-relocated-private`;
    await rename(documents, relocated);
    await symlink(relocated, documents, "dir");
    expect(codex.calls).toEqual([]);

    await expect(service.execute({
      kind: "session.start",
      account: added.account.id,
      preset: "high",
      presetContract: 2,
      fast: false,
    }, { signal })).rejects.toMatchObject({
      code: "UNAVAILABLE",
      details: {
        nextCommand: "oompa doctor",
        repair: "repair_or_select_project",
      },
    });
    expect(codex.calls).toEqual([]);
    expect(codex.calls).not.toContain("review-session");
    expect(codex.calls.filter((call) => call.startsWith("start:"))).toHaveLength(0);
    expect(store.listSessions()).toHaveLength(0);

    const expectedProblem = "A configured project directory is missing or unsafe. Run `oompa project list`, then restore or repair every listed directory so it is readable, writable, traversable, and canonical.";
    for (const offline of [true, false]) {
      const doctor = await service.execute({ kind: "doctor", offline }, { signal }) as {
        healthy: boolean;
        problems: readonly string[];
        state: { database: string; projects: number };
      };
      expect(doctor).toMatchObject({
        healthy: false,
        offline,
        state: { database: "ready", projects: 1 },
      });
      expect(doctor.problems).toContain(expectedProblem);
      expect(JSON.stringify(doctor)).not.toContain(documents);
      expect(JSON.stringify(doctor)).not.toContain(relocated);
    }
  });
test("turns bounded projection and deployment status into actionable doctor health", async () => {
    const cloud = new FakeCloud();
    const { service, documents } = await fixture(cloud);
    await service.execute({ kind: "project.add", label: "Doctor docs", path: documents }, { signal });

    cloud.statusResult = {
      configured: true,
      projectionCache: {
        code: "CACHE_CORRUPT_OR_UNREADABLE",
        state: "unavailable",
      },
    };
    const unavailable = await service.execute({ kind: "doctor", offline: false }, { signal }) as {
      healthy: boolean;
      problems: readonly string[];
    };
    expect(unavailable.healthy).toBe(false);
    expect(unavailable.problems).toContain(
      "The cloud projection cache is corrupt or unreadable. Run `oompa session list`, choose each affected local session, then explicitly run `oompa sync projection recover <session> --acknowledge-gap`.",
    );

    const affectedSession = `sess_${"3".repeat(32)}`;
    const idempotencyKey = "018bcfe5-6800-7000-8000-000000000703";
    cloud.statusResult = {
      configured: true,
      projectionCache: {
        affectedSessions: [affectedSession],
        affectedSessionsTruncated: false,
        code: "STREAM_RECOVERY_REQUIRED",
        sessions: 1,
        state: "degraded",
      },
      projectionRecovery: {
        recoveries: [{
          cacheActivated: false,
          idempotencyKey,
          phase: "effect_started",
          sessionPublicId: affectedSession,
        }],
        recoveriesTruncated: false,
        totalRecoveries: 1,
      },
    };
    const unsettled = await service.execute({ kind: "doctor", offline: false }, { signal }) as {
      healthy: boolean;
      problems: readonly string[];
    };
    expect(unsettled.healthy).toBe(false);
    expect(unsettled.problems).not.toContain(
      `Cloud transcript projection requires recovery for 1 session(s). Run \`oompa sync projection recover ${affectedSession} --acknowledge-gap\`.`,
    );
    expect(unsettled.problems).toContain(
      `Cloud projection recovery is unsettled. Retry \`oompa sync projection recover ${affectedSession} --acknowledge-gap --idempotency-key ${idempotencyKey}\`.`,
    );

    cloud.statusResult = {
      configured: true,
      projectionCache: { state: "ready" },
      projectionRecovery: {
        recoveries: Array.from({ length: 128 }, (_, index) => ({
          idempotencyKey: `018bcfe5-6800-7000-8000-${index.toString(16).padStart(12, "0")}`,
          phase: "rejected",
          sessionPublicId: `sess_${index.toString(16).padStart(32, "0")}`,
        })),
        recoveriesTruncated: true,
        totalRecoveries: 150,
      },
    };
    const boundedHistory = await service.execute({ kind: "doctor", offline: false }, { signal }) as {
      healthy: boolean;
      problems: readonly string[];
    };
    expect(boundedHistory).toMatchObject({ healthy: true, problems: [] });

    cloud.statusResult = {
      configured: true,
      projectionCache: { state: "ready" },
      projectionRecovery: {
        recoveries: [],
        recoveriesTruncated: true,
        totalRecoveries: 150,
      },
    };
    const impossibleShortPage = await service.execute({ kind: "doctor", offline: false }, { signal }) as {
      healthy: boolean;
      problems: readonly string[];
    };
    expect(impossibleShortPage.healthy).toBe(false);
    expect(impossibleShortPage.problems).toContain(
      "Cloud projection recovery status is invalid or exceeds its local bound. Restart the daemon, then rerun `oompa doctor`.",
    );

    cloud.statusResult = {
      configured: false,
      diagnostic: "Cloud sync is disabled for this daemon. Unset OOMPA_CONVEX_URL and HRA_CONVEX_URL and restart the daemon to use hosted sync.",
      projectionRecovery: {
        recoveries: [{
          cacheActivated: false,
          idempotencyKey,
          phase: "effect_started",
          sessionPublicId: affectedSession,
        }],
        recoveriesTruncated: false,
        totalRecoveries: 1,
      },
      reenable: { kind: "use_hosted_default" },
      signedIn: false,
      unavailability: "disabled",
    };
    const disabledRecovery = await service.execute({ kind: "doctor", offline: false }, { signal }) as {
      healthy: boolean;
      problems: readonly string[];
    };
    expect(disabledRecovery.healthy).toBe(false);
    expect(disabledRecovery.problems).toContain(
      `Cloud projection recovery is unsettled. Unset OOMPA_CONVEX_URL and HRA_CONVEX_URL and restart the daemon first. After restart, retry \`oompa sync projection recover ${affectedSession} --acknowledge-gap --idempotency-key ${idempotencyKey}\`.`,
    );

    cloud.statusResult = {
      ...(cloud.statusResult as Record<string, unknown>),
      diagnostic: "Cloud sync is disabled for this daemon. Restore this state root's bound deployment with OOMPA_CONVEX_URL, unset HRA_CONVEX_URL, and restart the daemon.",
      reenable: {
        deploymentUrl: "https://bound.convex.cloud",
        kind: "restore_bound_deployment",
      },
    };
    const selfManagedRecovery = await service.execute({ kind: "doctor", offline: false }, { signal }) as {
      healthy: boolean;
      problems: readonly string[];
    };
    expect(selfManagedRecovery.healthy).toBe(false);
    expect(selfManagedRecovery.problems).toContain(
      `Cloud projection recovery is unsettled. Set OOMPA_CONVEX_URL to https://bound.convex.cloud, unset HRA_CONVEX_URL, and restart the daemon first. After restart, retry \`oompa sync projection recover ${affectedSession} --acknowledge-gap --idempotency-key ${idempotencyKey}\`.`,
    );

    cloud.statusResult = {
      configured: false,
      diagnostic: "Cloud sync is disabled for this daemon. Unset OOMPA_CONVEX_URL and HRA_CONVEX_URL and restart the daemon to use hosted sync.",
      reenable: { kind: "use_hosted_default" },
      signedIn: false,
      unavailability: "disabled",
    };
    const intentionallyDisabled = await service.execute({ kind: "doctor", offline: false }, { signal }) as {
      healthy: boolean;
    };
    expect(intentionallyDisabled.healthy).toBe(true);

    cloud.statusResult = {
      configured: false,
      diagnostic: "Cloud sync is unavailable because deployment custody requires recovery.",
      signedIn: false,
    };
    const custody = await service.execute({ kind: "doctor", offline: false }, { signal }) as {
      healthy: boolean;
      problems: readonly string[];
    };
    expect(custody.healthy).toBe(false);
    expect(custody.problems).toContain(
      "Cloud deployment custody is unavailable. Run `oompa sync status --json`, correct the reported deployment configuration or custody state, then restart the daemon.",
    );
  });
test("imports every requested Codex session page and binds continuations to the resolved account filter", async () => {
    const value = await fixture();
    const firstAccount = await value.service.execute(
      { kind: "account.add", label: "Mutable label" },
      { signal },
    ) as { account: { id: `acct_${string}` } };
    await value.service.execute({
      kind: "account.login",
      account: firstAccount.account.id,
      deviceCode: false,
    }, { signal });
    value.codex.listedProjections = [{
      providerThreadId: "provider-newer",
      providerUpdatedAt: 20,
      status: "idle",
      title: "Newer provider thread",
    }];
    value.codex.listedNextCursor = "provider-page-2";

    const first = await value.service.execute({
      kind: "session.list",
      archived: false,
      account: "Mutable label",
      limit: 1,
    }, { signal }) as {
      accountId: string;
      sessions: readonly { providerThreadId?: string; title: string }[];
      nextCursor: string;
    };
    expect(first).toMatchObject({
      accountId: firstAccount.account.id,
      sessions: [{ providerThreadId: "provider-newer", title: "Newer provider thread" }],
    });
    expect(first.nextCursor).toStartWith("hra1.");

    value.codex.listedProjections = [{
      providerThreadId: "provider-older",
      providerUpdatedAt: 10,
      status: "idle",
      title: "Older provider thread",
    }];
    value.codex.listedNextCursor = null;
    await expect(value.service.execute({
      kind: "session.list",
      archived: false,
      account: firstAccount.account.id,
      cursor: first.nextCursor,
      limit: 1,
    }, { signal })).resolves.toMatchObject({
      accountId: firstAccount.account.id,
      nextCursor: null,
      sessions: [{ providerThreadId: "provider-older", title: "Older provider thread" }],
    });
    expect(value.codex.sessionListRequests.map(({ cursor, limit }) => ({ cursor, limit }))).toEqual([
      { cursor: undefined, limit: 1 },
      { cursor: "provider-page-2", limit: 1 },
    ]);
    const importedTitles = value.store.listSessions(10, firstAccount.account.id)
      .map((session) => session.title);
    expect(importedTitles).toHaveLength(2);
    expect(new Set(importedTitles)).toEqual(new Set([
      "Newer provider thread",
      "Older provider thread",
    ]));

    const callsBeforeInvalid = value.codex.sessionListRequests.length;
    const tampered = `${first.nextCursor.slice(0, -1)}${first.nextCursor.at(-1) === "A" ? "B" : "A"}`;
    await expect(value.service.execute({
      kind: "session.list",
      archived: false,
      account: firstAccount.account.id,
      cursor: tampered,
      limit: 1,
    }, { signal })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(value.service.execute({
      kind: "session.list",
      archived: false,
      account: firstAccount.account.id,
      cursor: first.nextCursor,
      limit: 2,
    }, { signal })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(value.service.execute({
      kind: "session.list",
      archived: true,
      account: firstAccount.account.id,
      cursor: first.nextCursor,
      limit: 1,
    }, { signal })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(value.service.execute({
      kind: "session.list",
      archived: false,
      cursor: first.nextCursor,
      limit: 1,
    }, { signal })).rejects.toMatchObject({ code: "INVALID_INPUT" });

    const secondAccount = await value.service.execute(
      { kind: "account.add", label: "Other account" },
      { signal },
    ) as { account: { id: `acct_${string}` } };
    await value.service.execute({
      kind: "account.login",
      account: secondAccount.account.id,
      deviceCode: false,
    }, { signal });
    await expect(value.service.execute({
      kind: "session.list",
      archived: false,
      account: secondAccount.account.id,
      cursor: first.nextCursor,
      limit: 1,
    }, { signal })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(value.codex.sessionListRequests).toHaveLength(callsBeforeInvalid);
  });
test("pages every durable provider session before Codex discovery without duplicates", async () => {
    const value = await archivedDevinFixture();
    await abandonArchivedDevinLogin(value);
    const added = { account: value.captured.profile };
    await value.service.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: false,
    }, { signal });

    const firstClaude = value.store.upsertProviderSession({
      providerAuthority: value.store.requireProviderAccountAuthority(added.account.id, "claude"),
        profileId: added.account.id,
        provider: "claude",
        providerThreadId: "durable-claude-one",
        providerAccountKey: claudeProviderAccountKey("durable-claude-one"),
        preset: "fable-max",
        fastEnabled: false,
        state: "idle",
        title: "Durable Claude one",
      });
    const durableDevin = value.store.requireSession(value.captured.session.id);
    const secondClaude = value.store.upsertProviderSession({
      providerAuthority: value.store.requireProviderAccountAuthority(added.account.id, "claude"),
        profileId: added.account.id,
        provider: "claude",
        providerThreadId: "durable-claude-two",
        providerAccountKey: claudeProviderAccountKey("durable-claude-two"),
        preset: "fable-max",
        fastEnabled: false,
        state: "idle",
        title: "Durable Claude two",
      });
    const localSessions = [firstClaude, durableDevin, secondClaude];
    const existingCodex = value.store.upsertProviderSession({
      providerAuthority: value.store.requireProviderAccountAuthority(added.account.id, "codex"),
      fastEnabled: false,
      profileId: added.account.id,
      preset: "high",
      provider: "codex",
      providerThreadId: "provider-existing-codex",
      providerAccountKey: codexProviderAccountKey(),
      state: "idle",
      title: "Existing Codex cache",
    });

    const first = await value.service.execute({
      kind: "session.list",
      archived: false,
      account: added.account.id,
      limit: 2,
    }, { signal }) as {
      sessions: readonly { id: string; provider: string }[];
      nextCursor: string;
    };
    expect(first.sessions).toHaveLength(2);
    expect(first.sessions.every((session) => [
      ...localSessions.map((local) => local.id),
      existingCodex.id,
    ].includes(session.id))).toBe(true);
    expect(value.codex.sessionListRequests).toHaveLength(0);

    value.codex.listedProjections = [{
      providerThreadId: "provider-existing-codex",
      status: "idle",
      title: "Existing Codex refreshed",
    }];
    value.codex.listedNextCursor = "provider-page-two";
    const second = await value.service.execute({
      kind: "session.list",
      archived: false,
      account: added.account.id,
      cursor: first.nextCursor,
      limit: 2,
    }, { signal }) as {
      sessions: readonly { id: string; provider: string }[];
      nextCursor: string;
    };
    expect(second.sessions).toHaveLength(2);
    expect(value.codex.sessionListRequests).toHaveLength(0);

    const third = await value.service.execute({
      kind: "session.list",
      archived: false,
      account: added.account.id,
      cursor: second.nextCursor,
      limit: 2,
    }, { signal }) as {
      sessions: readonly { id: string; provider: string }[];
      nextCursor: string;
    };
    expect(third.sessions).toHaveLength(0);
    expect(value.codex.sessionListRequests).toHaveLength(1);

    value.codex.listedProjections = [{
      providerThreadId: "provider-new-codex",
      status: "idle",
      title: "Next Codex page",
    }];
    value.codex.listedNextCursor = null;
    const fourth = await value.service.execute({
      kind: "session.list",
      archived: false,
      account: added.account.id,
      cursor: third.nextCursor,
      limit: 2,
    }, { signal }) as {
      sessions: readonly { id: string; provider: string }[];
      nextCursor: null;
    };

    const allReturned = [...first.sessions, ...second.sessions, ...third.sessions, ...fourth.sessions];
    const nextCodex = fourth.sessions[0];
    if (nextCodex === undefined) throw new Error("Expected the final Codex session page.");
    expect(new Set(allReturned.map((session) => session.id)).size).toBe(allReturned.length);
    expect(new Set(allReturned.map((session) => session.id))).toEqual(new Set([
      ...localSessions.map((session) => session.id),
      existingCodex.id,
      nextCodex.id,
    ]));
    expect(fourth).toMatchObject({
      sessions: [{ provider: "codex" }],
      nextCursor: null,
    });
    expect(value.codex.sessionListRequests.map(({ cursor, limit }) => ({ cursor, limit }))).toEqual([
      { cursor: undefined, limit: 2 },
      { cursor: "provider-page-two", limit: 2 },
    ]);
  });
test("fails closed on a provider session-list cursor cycle before importing that page", async () => {
    const value = await fixture();
    const added = await value.service.execute(
      { kind: "account.add", label: "Paged account" },
      { signal },
    ) as { account: { id: `acct_${string}` } };
    await value.service.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: false,
    }, { signal });

    value.codex.listedProjections = [{
      providerThreadId: "provider-page-one",
      status: "idle",
      title: "Page one",
    }];
    value.codex.listedNextCursor = "provider-a";
    const first = await value.service.execute({
      kind: "session.list",
      archived: false,
      account: added.account.id,
      limit: 1,
    }, { signal }) as { nextCursor: string };

    value.codex.listedProjections = [{
      providerThreadId: "provider-page-two",
      status: "idle",
      title: "Page two",
    }];
    value.codex.listedNextCursor = "provider-b";
    const second = await value.service.execute({
      kind: "session.list",
      archived: false,
      account: added.account.id,
      cursor: first.nextCursor,
      limit: 1,
    }, { signal }) as { nextCursor: string };

    value.codex.listedProjections = [{
      providerThreadId: "provider-page-three",
      status: "idle",
      title: "Page three",
    }];
    value.codex.listedNextCursor = "provider-a";
    const third = await value.service.execute({
      kind: "session.list",
      archived: false,
      account: added.account.id,
      cursor: second.nextCursor,
      limit: 1,
    }, { signal }) as { nextCursor: string };

    value.codex.listedProjections = [{
      providerThreadId: "provider-must-not-import",
      status: "idle",
      title: "Must not import",
    }];
    value.codex.listedNextCursor = "provider-b";
    await expect(value.service.execute({
      kind: "session.list",
      archived: false,
      account: added.account.id,
      cursor: third.nextCursor,
      limit: 1,
    }, { signal })).rejects.toMatchObject({ code: "UNAVAILABLE" });
    const importedTitles = value.store.listSessions(10, added.account.id)
      .map((session) => session.title);
    expect(importedTitles).toHaveLength(3);
    expect(new Set(importedTitles)).toEqual(new Set(["Page one", "Page two", "Page three"]));
    expect(importedTitles).not.toContain("Must not import");
  });
test("lists and selects plugins through the read-only account and project boundary", async () => {
    const { service, codex, documents } = await fixture();
    const added = await service.execute(
      { kind: "account.add", label: "Plugin account" },
      { signal },
    ) as { account: { id: `acct_${string}` } };
    await expect(service.execute({
      account: added.account.id,
      kind: "plugin.list",
      refresh: false,
    }, { signal })).rejects.toMatchObject({ code: "INTERACTION_REQUIRED" });
    expect(codex.pluginRequests).toHaveLength(0);

    await service.execute({
      account: added.account.id,
      deviceCode: false,
      kind: "account.login",
    }, { signal });
    const project = await service.execute({
      kind: "project.add",
      label: "Release",
      path: documents,
    }, { signal }) as { project: { id: string } };

    const listed = await service.execute({
      account: added.account.id,
      kind: "plugin.list",
      project: project.project.id,
      refresh: true,
    }, { signal });
    expect(listed).toMatchObject({
      account: { id: added.account.id, state: "signed_in" },
      catalog: {
        marketplaces: [{ plugins: [{ id: "files@official" }] }],
        lifecycle: {
          discovery: "available",
          install: "blocked_compound_upstream_effect",
          enablement: "no_separate_pinned_method",
          oauth: "separate_foreground_only",
        },
      },
    });
    expect(codex.pluginRequests[0]).toMatchObject({
      authority: { id: added.account.id, generation: 1 },
      forceRefetch: true,
      projectRoot: documents,
    });

    const selected = await service.execute({
      account: added.account.id,
      kind: "plugin.show",
      plugin: "Files",
      refresh: false,
    }, { signal });
    expect(selected).toMatchObject({
      marketplace: { name: "official" },
      plugin: { id: "files@official", displayName: "Files" },
      lifecycle: { install: "blocked_compound_upstream_effect" },
    });
    expect(codex.pluginRequests[1]).toMatchObject({
      forceRefetch: false,
    });
    expect(codex.pluginRequests[1]).not.toHaveProperty("projectRoot");

    const official = codex.pluginCatalog.marketplaces[0];
    const files = official?.plugins[0];
    if (official === undefined || files === undefined) throw new Error("Plugin fixture is incomplete.");
    codex.pluginCatalog = {
      ...codex.pluginCatalog,
      marketplaces: [
        official,
        {
          displayName: "Community",
          name: "community",
          plugins: [{ ...files, id: "files-search@community", name: "files-search" }],
        },
      ],
    };
    await expect(service.execute({
      account: added.account.id,
      kind: "plugin.show",
      plugin: "Files",
      refresh: false,
    }, { signal })).rejects.toMatchObject({ code: "AMBIGUOUS" });
    await expect(service.execute({
      account: added.account.id,
      kind: "plugin.show",
      plugin: "files@official",
      refresh: false,
    }, { signal })).resolves.toMatchObject({ plugin: { id: "files@official" } });
  });
test("starts, reads, queues, steers, stops, and annotates a session", async () => {
    const { service, documents, store } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Work" }, { signal }) as { account: { id: string } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    await service.execute({ kind: "project.add", label: "Documents", path: documents }, { signal });
    const started = await service.execute({ kind: "session.start", account: added.account.id, preset: "high", presetContract: 2, fast: true }, { signal }) as { session: { id: `sess_${string}` }; effectiveRuntimeProfile: EffectiveRuntimeProfile };
    expect(started.effectiveRuntimeProfile).toMatchObject({ reviewMode: "auto_review", computerUse: true, enabledApps: [{ id: "app.files" }] });
    expect(store.latestSessionRuntimeProfile(started.session.id)).toMatchObject({ revision: 1, sourceKind: "session_start", profile: started.effectiveRuntimeProfile });
    await service.execute({ kind: "session.send", session: started.session.id, message: "hello" }, { signal });
    expect(await service.execute({ kind: "session.show", session: started.session.id, detail: false }, { signal })).toMatchObject({ projection: { status: "active", messages: [{ role: "user" }] }, effectiveRuntimeProfile: started.effectiveRuntimeProfile });
    expect(await service.execute({ kind: "session.queue", session: started.session.id, message: "later" }, { signal })).toMatchObject({ queued: { state: "pending" } });
    expect(await service.execute({ kind: "session.steer", session: started.session.id, message: "focus" }, { signal })).toMatchObject({ steered: true });
    expect(await service.execute({ kind: "session.stop", session: started.session.id }, { signal })).toMatchObject({ stopped: true });
    expect(await service.execute({ kind: "session.note.set", session: started.session.id, note: "One note" }, { signal })).toMatchObject({ session: { note: "One note" } });
    expect(await service.execute({ kind: "session.rename", session: started.session.id, name: "Release" }, { signal })).toMatchObject({ session: { title: "Release" } });
  });
test("scheduled task materialization dispatches through the sealed empty-attachment queue writer", async () => {
    let now = 2_000;
    const value = await fixture(new FakeCloud(), () => undefined, () => now);
    const { service, store, codex } = value;
    try {
      const { sessionId } = await createIdleSession(value, "Sealed scheduled task");
      const tasks = store.createSessionTaskStore();
      const task = tasks.create({
        sessionId, name: "Scheduled check", prompt: "Check the scheduled work once.",
        minutes: 15, status: "active", idempotencyKey: crypto.randomUUID(),
      });
      expect(task.nextDueAt).toBe(902_000);
      now = task.nextDueAt ?? now;
      expect(await service.maintainSessionTasks()).toEqual({ materialized: 1 });
      await service.settled();
      const queues = store.listQueue(sessionId);
      expect(queues).toHaveLength(1);
      const queue = queues[0];
      if (queue === undefined) throw new Error("Scheduled task did not create its queue.");
      expect(queue.state).toBe("applied");
      expect(store.queueAttachmentManifest(queue.id)).toEqual([]);
      expect(store.hasUnsettledQueueAttachmentQuarantineForSession(sessionId)).toBe(false);
      expect(codex.startTurnAttachments).toEqual([{ clientMessageId: queue.id }]);
      expect(codex.readProjection.messages?.at(-1)).toMatchObject({
        text: "Check the scheduled work once.", clientId: queue.id,
      });
      expect(await service.maintainSessionTasks()).toEqual({ materialized: 0 });
      expect(store.listQueue(sessionId)).toHaveLength(1);
    } finally {
      await service.close();
    }
  });
test("carries attachments from a command to the provider, custody, and the projection", async () => {
    const value = await fixture();
    const { service, codex, documents, paths, store } = value;
    const added = await service.execute({ kind: "account.add", label: "Work" }, { signal }) as { account: { id: string } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    await service.execute({ kind: "project.add", label: "Documents", path: documents }, { signal });
    const started = await service.execute({ kind: "session.start", account: added.account.id, preset: "high", presetContract: 2, fast: false }, { signal }) as { session: { id: `sess_${string}` } };

    // The image bytes are assembled here; the repository commits no binary.
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
    await writeFile(join(documents, "diagram.png"), png);
    await writeFile(join(documents, "notes.md"), "# hello");
    const blobs = AttachmentBlobStore.forStatePaths(paths);
    const attachments = await ingestAttachments(blobs, ["diagram.png", "notes.md"], documents);

    const sent = await service.execute({
      attachments: [...attachments],
      kind: "session.send",
      message: "what changed?",
      session: started.session.id,
    }, { signal }) as { attachments: readonly { name: string }[] };
    expect(sent.attachments.map((entry) => entry.name)).toEqual(["diagram.png", "notes.md"]);

    const dispatched = codex.startTurnAttachments.at(-1);
    expect(dispatched?.attachments?.map((entry) => entry.kind)).toEqual(["image", "text"]);
    const image = dispatched?.attachments?.[0];
    expect(image?.kind === "image" ? image.base64 : null)
      .toBe(Buffer.from(png).toString("base64"));
    const text = dispatched?.attachments?.[1];
    expect(text?.kind === "text" ? text.text : null).toBe("# hello");

    // Custody records the manifest against the exact dispatched client id.
    const manifest = store.messageAttachmentManifest(
      started.session.id,
      dispatched?.clientMessageId ?? "",
    );
    expect(manifest.map((entry) => [entry.name, entry.mediaType, entry.byteLength])).toEqual([
      ["diagram.png", "image/png", png.byteLength],
      ["notes.md", "text/markdown", 7],
    ]);

    const shown = await service.execute({
      detail: false,
      kind: "session.show",
      session: started.session.id,
    }, { signal }) as { projection: { messages: readonly { attachments?: readonly unknown[] }[] } };
    expect(shown.projection.messages.at(-1)?.attachments).toEqual(manifest);
    const transcript = await service.execute({
      after: undefined,
      kind: "session.transcript",
      limit: 50,
      session: started.session.id,
    }, { signal }) as { records: readonly { attachments?: readonly unknown[]; kind: string; text?: string }[] };
    expect(transcript.records.find((record) =>
      record.kind === "user" && record.text === "what changed?")?.attachments).toEqual(manifest);
    expect(JSON.stringify(shown)).not.toContain(Buffer.from(png).toString("base64"));
    expect(JSON.stringify(transcript)).not.toContain(Buffer.from(png).toString("base64"));
  });
test.each(["send", "steer"] as const)(
    "projects authentic predecessor attachment names only for its exact settled replay (%s)",
    async (scenario) => {
      const captured = canonical39AttachmentFixtures[scenario];
      const { service, codex, store, paths } = await fixture(new FakeCloud(), () => undefined, () => 40_000, undefined, {},
        { canonical39Attachments: scenario },
      );
      const unsafeNames = [
        "legacy\u2028notes.txt", "legacy\u2029notes.txt", "legacy�notes.txt",
      ];
      const projectedNames = ["legacy�notes~1.txt", "legacy�notes~2.txt", "legacy�notes.txt"];
      expectHistoricalValue(captured.request.attachments.map(({ name }) => name), unsafeNames);
      expectHistoricalValue(captured.manifest.map(({ name }) => name), unsafeNames);
      expect(store.readMutation(captured.idempotencyKey)?.requestDigest).toBe(captured.mutation.requestDigest);
      expectHistoricalValue(store.readMutation(captured.idempotencyKey)?.evidence, captured.mutation.evidence);
      expectHistoricalValue(store.readMutation(captured.idempotencyKey)?.result, captured.mutation.result);
      const expectedAttachments = captured.request.attachments.map((attachment, index) => ({
        ...attachment, name: projectedNames[index],
      }));
      expectHistoricalValue(store.messageAttachmentManifest(captured.session.id, captured.mutation.id), expectedAttachments);
      const blobs = AttachmentBlobStore.forStatePaths(paths);
      // Only archived terminal receipts/manifests were imported. No blob file or
      // renewed native authority is manufactured to make a settled replay work.
      await expect(readFile(blobs.pathFor(captured.attachments[0].digest, "text/plain")))
        .rejects.toMatchObject({ code: "ENOENT" });
      const base = {
        kind: scenario === "send" ? "session.send" as const : "session.steer" as const,
        session: captured.session.id, message: captured.request.message,
        attachments: captured.request.attachments.map((attachment) => ({ ...attachment })),
      };
      const command = { ...base, idempotencyKey: captured.idempotencyKey };
      const before = serviceFixtureDatabaseSnapshot(paths.database);
      for (let replay = 0; replay < 2; replay++) {
        const replayed = await service.execute(command, { signal });
        expect(replayed).toMatchObject({
          idempotencyKey: captured.idempotencyKey, attachments: expectedAttachments,
        });
        expect(serviceFixtureDatabaseSnapshot(paths.database)).toEqual(before);
      }
      const absentKey = crypto.randomUUID();
      for (const key of [undefined, absentKey]) {
        await expect(service.execute({
          ...base, ...(key === undefined ? {} : { idempotencyKey: key }),
        }, { signal })).rejects.toMatchObject({ code: "INVALID_INPUT" });
        expect(store.readMutation(absentKey)).toBeNull();
        expect(serviceFixtureDatabaseSnapshot(paths.database)).toEqual(before);
      }
      for (const changed of [
        { ...command, message: command.message + " changed" },
        { ...command, attachments: command.attachments.map((attachment, index) => ({
          ...attachment, name: index === 0 ? "different\u2028notes.txt" : attachment.name,
        })) },
      ]) {
        await expect(service.execute(changed, { signal })).rejects.toMatchObject({ code: "INVALID_INPUT" });
        expect(serviceFixtureDatabaseSnapshot(paths.database)).toEqual(before);
      }
      expect(codex.calls).toEqual([]);
      expectHistoricalValue(store.readMutation(captured.idempotencyKey)?.result, captured.mutation.result);
      expectHistoricalValue(store.readMutation(captured.idempotencyKey)?.evidence, captured.mutation.evidence);
    },
  );
test.each(["accounted", "unaccounted"] as const)("attachment cleanup rechecks a competing writer's reference after the %s snapshot", async (mode) => {
    const value = await fixture();
    const { service, store, paths, documents } = value;
    const { sessionId } = await createIdleSession(value, "Attachment cleanup race");
    await writeFile(join(documents, "retained.txt"), "retain these exact bytes");
    await writeFile(join(documents, "sent.txt"), "trigger bounded maintenance");
    const blobs = AttachmentBlobStore.forStatePaths(paths);
    const references = await ingestAttachments(blobs, ["retained.txt", "sent.txt"], documents);
    const retained = references[0];
    const sent = references[1];
    if (retained === undefined || sent === undefined) throw new Error("Missing attachment race fixture.");
    const stored = { ...retained, canonicalMediaType: "text/plain" as const };
    await utimes(blobs.pathFor(retained.digest, "text/plain"), new Date(1_000), new Date(1_000));
    if (mode === "accounted") {
      store.recordMessageAttachments({ sessionId, sourceId: "old-display-source", attachments: [stored] });
      const inspector = new Database(paths.database, { strict: true });
      inspector.query("DELETE FROM message_attachments WHERE session_id=? AND source_id=?")
        .run(sessionId, "old-display-source");
      inspector.close(false);
    }
    expect(store.attachmentCustody(retained.digest)?.referenceCount).toBe(mode === "accounted" ? 0 : undefined);
    const other = new StateStore(paths);
    const listUnreferenced = store.listUnreferencedAttachments.bind(store);
    // Restore the exact prototype method below; invoke it only with the
    // actual blob-store receiver through apply.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const listCandidates = AttachmentBlobStore.prototype.listCleanupCandidates;
    let injected = false;
    store.listUnreferencedAttachments = (...input) => {
      const candidates = listUnreferenced(...input);
      if (mode === "accounted" && !injected && candidates.some((candidate) => candidate.digest === retained.digest)) {
        injected = true;
        other.recordMessageAttachments({ sessionId, sourceId: "competing-retained-source", attachments: [stored] });
      }
      return candidates;
    };
    AttachmentBlobStore.prototype.listCleanupCandidates = async function (...input) {
      const snapshot = await listCandidates.apply(this, input);
      if (mode === "unaccounted" && !injected
        && snapshot.candidates.some((candidate) => candidate.kind === "blob" && candidate.digest === retained.digest)) {
        injected = true;
        other.recordMessageAttachments({ sessionId, sourceId: "competing-retained-source", attachments: [stored] });
      }
      return snapshot;
    };
    try {
      await service.execute({ kind: "session.send", session: sessionId, message: "Use the second file.",
        attachments: [sent], idempotencyKey: crypto.randomUUID() }, { signal });
      expect(injected).toBe(true);
      expect(store.attachmentCustody(retained.digest)?.referenceCount).toBe(1);
      expect(store.messageAttachmentManifest(sessionId, "competing-retained-source")).toEqual([retained]);
      expect(await blobs.read(retained.digest, "text/plain"))
        .toEqual(new TextEncoder().encode("retain these exact bytes"));
    } finally {
      store.listUnreferencedAttachments = listUnreferenced;
      AttachmentBlobStore.prototype.listCleanupCandidates = listCandidates;
      other.close();
    }
  });
test.each(["session.send", "session.steer", "session.queue"] as const)("attachment ingress protects %s before its first blob read", async (kind) => {
    const value = await fixture();
    const { service, store, paths, documents, daemonGeneration, daemonBootId } = value;
    const { sessionId } = await createIdleSession(value, "Reserved attachment read");
    if (kind !== "session.send") {
      await service.execute({ kind: "session.send", session: sessionId, message: "Keep this turn active." }, { signal });
    }
    await writeFile(join(documents, "reserved-read.txt"), "protect bytes before reading them");
    const blobs = AttachmentBlobStore.forStatePaths(paths);
    const references = await ingestAttachments(blobs, ["reserved-read.txt"], documents);
    const reference = references[0];
    if (reference === undefined) throw new Error("Missing reserved read fixture.");
    await utimes(blobs.pathFor(reference.digest, "text/plain"), new Date(1_000), new Date(1_000));
    const other = new StateStore(paths);
    // Preserve the prototype method for exact restoration; the hook invokes
    // it only through apply(this, input), retaining the actual blob store.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const read = AttachmentBlobStore.prototype.read;
    let cleanup: ReturnType<StateStore["cleanupAttachmentCandidate"]> | undefined;
    AttachmentBlobStore.prototype.read = async function (...input) {
      if (input[0] === reference.digest && cleanup === undefined) {
        cleanup = other.cleanupAttachmentCandidate({ daemonGeneration, bootId: daemonBootId,
          candidate: { kind: "blob", digest: reference.digest, canonicalMediaType: "text/plain" } });
      }
      return await read.apply(this, input);
    };
    try {
      const result = await service.execute({ kind, session: sessionId, message: "Read the protected original input.",
        attachments: [...references] }, { signal }) as { idempotencyKey: string };
      expect(cleanup).toEqual({ kind: "retained", reason: "reserved" });
      expect(store.readMutation(result.idempotencyKey)?.state).toBe("applied");
      expect(await blobs.read(reference.digest, "text/plain"))
        .toEqual(new TextEncoder().encode("protect bytes before reading them"));
    } finally {
      AttachmentBlobStore.prototype.read = read;
      other.close();
    }
  });
test.each(["session.send", "session.steer", "session.queue"] as const)("attachment ingress releases only its %s invocation after a missing-byte refusal", async (kind) => {
    const value = await fixture();
    const { service, store, paths } = value;
    const { sessionId } = await createIdleSession(value, "Missing attachment reservation");
    if (kind !== "session.send") {
      await service.execute({ kind: "session.send", session: sessionId, message: "Keep this turn active." }, { signal });
    }
    const reserve = store.reserveAttachmentIngress.bind(store);
    const release = store.releaseAttachmentIngress.bind(store);
    const reservations: ReturnType<StateStore["reserveAttachmentIngress"]>[] = [];
    const releases: ReturnType<StateStore["releaseAttachmentIngress"]>[] = [];
    store.reserveAttachmentIngress = (input) => {
      const result = reserve(input);
      reservations.push(result);
      return result;
    };
    store.releaseAttachmentIngress = (input) => {
      const result = release(input);
      releases.push(result);
      return result;
    };
    const key = crypto.randomUUID();
    try {
      await expect(service.execute({ kind, session: sessionId, message: "Do not dispatch missing bytes.", idempotencyKey: key,
        attachments: [{ digest: "c".repeat(64), name: "missing.txt", mediaType: "text/plain", byteLength: 7 }] }, { signal }))
        .rejects.toMatchObject({ code: "INVALID_INPUT" });
      expect(reservations.map((reservation) => reservation.kind)).toEqual(["reserved"]);
      expect(releases).toEqual([{ released: true, reason: "released" }]);
      expect(store.readMutation(key)).toBeNull();
      const inspector = new Database(paths.database, { readonly: true, strict: true });
      try {
        expect(inspector.query("SELECT COUNT(*) AS count FROM attachment_custody_slots").get()).toEqual({ count: 0 });
      } finally {
        inspector.close(false);
      }
    } finally {
      store.reserveAttachmentIngress = reserve;
      store.releaseAttachmentIngress = release;
    }
  });
test.each(["session.send", "session.steer"] as const)("completed %s attachment replay needs no live slot, blob or provider preflight", async (kind) => {
    const value = await fixture();
    const { service, store, paths, documents, codex, daemonGeneration, daemonBootId } = value;
    const { sessionId } = await createIdleSession(value, "Historical attachment receipt");
    if (kind === "session.steer") {
      await service.execute({ kind: "session.send", session: sessionId, message: "Keep this turn active." }, { signal });
    }
    await writeFile(join(documents, "receipt.txt"), "the original accepted attachment");
    const blobs = AttachmentBlobStore.forStatePaths(paths);
    const references = await ingestAttachments(blobs, ["receipt.txt"], documents);
    const reference = references[0];
    if (reference === undefined) throw new Error("Missing accepted attachment fixture.");
    const command = { kind, session: sessionId, message: "Keep this receipt replayable.",
      attachments: [...references], idempotencyKey: crypto.randomUUID() };
    const first = await service.execute(command, { signal }) as { turnId: string };
    const session = store.requireSession(sessionId);
    const providerAuthority = store.requireProviderAccountAuthority(session.profileId, session.provider);
    const holds: Array<{ reservationId: string; reservationDigest: string }> = [];
    try {
      for (let index = 0; index < 64; index++) {
        const hold = store.reserveAttachmentIngress({ kind, sessionId, message: "Occupy one independent slot.",
          idempotencyKey: crypto.randomUUID(), attachments: references, providerAuthority, daemonGeneration, bootId: daemonBootId });
        if (hold.kind !== "reserved") throw new Error("Expected an attached live slot.");
        holds.push({ reservationId: hold.reservationId, reservationDigest: hold.reservationDigest });
      }
      const calls = [...codex.calls];
      const events = store.listSessionEvents({ sessionId, afterSequence: 0 }).events;
      const receipt = { turnId: first.turnId, attachments: references, idempotencyKey: command.idempotencyKey };
      await expect(service.execute(command, { signal })).resolves.toMatchObject(receipt);
      await blobs.remove(reference.digest, "text/plain");
      store.setSessionTurnState({ sessionId, expectedRevision: session.revision, state: "recovery_required" });
      await expect(service.execute(command, { signal })).resolves.toMatchObject(receipt);
      expect(codex.calls).toEqual(calls);
      expect(store.listSessionEvents({ sessionId, afterSequence: 0 }).events).toEqual(events);
    } finally {
      for (const hold of holds) store.releaseAttachmentIngress({ ...hold, daemonGeneration, bootId: daemonBootId });
    }
  });
test.each(["session.send", "session.steer"] as const)("raced completed %s attachment replay has no post-receipt side effects", async (kind) => {
    const value = await fixture();
    const { service, store, paths, documents, codex } = value;
    const { sessionId } = await createIdleSession(value, "Raced attachment receipt");
    if (kind === "session.steer") {
      await service.execute({ kind: "session.send", session: sessionId, message: "Keep this turn active." }, { signal });
    } else codex.turnStatus = "completed";
    await service.settled();
    await writeFile(join(documents, "raced-receipt.txt"), "one attached native effect");
    const references = await ingestAttachments(AttachmentBlobStore.forStatePaths(paths), ["raced-receipt.txt"], documents);
    const reference = references[0];
    if (reference === undefined) throw new Error("Missing raced attachment fixture.");
    const command = { kind, session: sessionId, message: "Accept this exact original input once.",
      attachments: [...references], idempotencyKey: crypto.randomUUID() };
    const other = new StateStore(paths);
    // A separate service has separate ranked locks, but the same persisted
    // boot and exact runtime authority. It can complete while this caller is
    // suspended in its first attachment read without a same-lock deadlock.
    const winner = new OompaService({ store: other, paths, codex, cloud: value.cloud,
      daemonAuthority: value.daemonAuthority, daemonGeneration: value.daemonGeneration,
      daemonBootId: value.daemonBootId, eventCursors: value.eventCursors, platform: "linux", requestStop: () => undefined });
    const readReplay = store.readSessionInputReplay.bind(store);
    const listUnreferenced = store.listUnreferencedAttachments.bind(store);
    const nextPendingQueue = store.nextPendingQueue.bind(store);
    const resetCounter = store.resetAutorespondCounter.bind(store);
    // The original method is invoked only with its actual blob-store receiver.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const readBlob = AttachmentBlobStore.prototype.read;
    const observed = { nullPreflight: false, injected: false, sweepReads: 0, queueReads: 0, counterResets: 0 };
    let accepted: { turnId: string } | undefined;
    const original = { receipt: null as ReturnType<StateStore["readMutation"]> };
    let nativeCalls: Array<"send" | "steer"> = [];
    let userMessages: Array<ReturnType<StateStore["listSessionEvents"]>["events"][number]> = [];
    store.readSessionInputReplay = (input) => {
      const result = readReplay(input);
      if (input.idempotencyKey === command.idempotencyKey && result === null) observed.nullPreflight = true;
      return result;
    };
    store.listUnreferencedAttachments = (...input) => { observed.sweepReads += 1; return listUnreferenced(...input); };
    store.nextPendingQueue = (...input) => { observed.queueReads += 1; return nextPendingQueue(...input); };
    store.resetAutorespondCounter = (...input) => { observed.counterResets += 1; return resetCounter(...input); };
    AttachmentBlobStore.prototype.read = async function (...input) {
      if (input[0] === reference.digest && !observed.injected) {
        observed.injected = true;
        expect(observed.nullPreflight).toBe(true);
        expect(other.readMutation(command.idempotencyKey)).toBeNull();
        accepted = await winner.execute(command, { signal }) as { turnId: string };
        await winner.settled();
        original.receipt = other.readMutation(command.idempotencyKey);
        expect(original.receipt?.state).toBe("applied");
        other.bumpAutorespondCounter(sessionId);
        nativeCalls = codex.calls.filter((call) => call === "send" || call === "steer");
        userMessages = other.listSessionEvents({ sessionId, afterSequence: 0 }).events
          .filter((event) => event.body.type === "user_message");
        expect(userMessages.filter((event) => event.body.type === "user_message" && event.body.text === command.message)).toHaveLength(1);
      }
      return await readBlob.apply(this, input);
    };
    try {
      const result = await service.execute(command, { signal });
      await service.settled();
      expect(observed.injected).toBe(true);
      expect(accepted).toBeDefined();
      expect(result).toMatchObject({ turnId: accepted?.turnId, attachments: references, idempotencyKey: command.idempotencyKey });
      if (original.receipt === null) throw new Error("Missing competing terminal receipt.");
      expect(store.readMutation(command.idempotencyKey)).toEqual(original.receipt);
      expect({
        nativeCalls: codex.calls.filter((call) => call === "send" || call === "steer"),
        userMessages: store.listSessionEvents({ sessionId, afterSequence: 0 }).events.filter((event) => event.body.type === "user_message"),
        sweepReads: observed.sweepReads, queueReads: observed.queueReads, counterResets: observed.counterResets,
        consecutive: store.readAutorespondBudgets(sessionId).consecutive,
      }).toEqual({ nativeCalls, userMessages, sweepReads: 0, queueReads: 0, counterResets: 0, consecutive: 1 });
    } finally {
      AttachmentBlobStore.prototype.read = readBlob;
      store.readSessionInputReplay = readReplay;
      store.listUnreferencedAttachments = listUnreferenced;
      store.nextPendingQueue = nextPendingQueue;
      store.resetAutorespondCounter = resetCounter;
      await winner.close();
      other.close();
    }
  });
test("attachment release diagnostics do not replace the original missing-byte refusal", async () => {
    const value = await fixture();
    const { service, store } = value;
    const { sessionId } = await createIdleSession(value, "Attachment release diagnostics");
    const release = store.releaseAttachmentIngress.bind(store);
    store.releaseAttachmentIngress = (input) => {
      release(input);
      throw new Error("private attachment release detail");
    };
    try {
      await expect(service.execute({ kind: "session.send", session: sessionId, message: "Keep the original refusal.",
        attachments: [{ digest: "d".repeat(64), name: "missing.txt", mediaType: "text/plain", byteLength: 7 }] }, { signal }))
        .rejects.toMatchObject({ code: "INVALID_INPUT" });
      expect(service.backgroundDiagnostics().last).toMatchObject({
        code: "attachment_ingress_release_failed", cause: "error", count: 1,
      });
      expect(JSON.stringify(service.backgroundDiagnostics())).not.toContain("private attachment release detail");
    } finally {
      store.releaseAttachmentIngress = release;
    }
  });
test.each(["session.send", "session.steer"] as const)("attachment admission rolls back %s begin and preserves exact prepared retry", async (kind) => {
    const value = await fixture();
    const { service, store, paths, documents, codex } = value;
    const { sessionId } = await createIdleSession(value, "Atomic attachment begin");
    if (kind === "session.steer") {
      await service.execute({ kind: "session.send", session: sessionId, message: "Keep this turn active." }, { signal });
    }
    await writeFile(join(documents, "atomic-input.txt"), "read exactly once at provider dispatch");
    const blobs = AttachmentBlobStore.forStatePaths(paths);
    const references = await ingestAttachments(blobs, ["atomic-input.txt"], documents);
    const reference = references[0];
    if (reference === undefined) throw new Error("Missing atomic attachment fixture.");
    const command = { kind, session: sessionId, message: "Preserve this original input.",
      attachments: [...references], idempotencyKey: crypto.randomUUID() };
    const providerCall = kind === "session.send" ? "send" : "steer";
    const calls = codex.calls.filter((call) => call === providerCall).length;
    const inspector = new Database(paths.database, { strict: true });
    try {
      inspector.exec("CREATE TRIGGER fail_session_input_manifest BEFORE INSERT ON message_attachments BEGIN SELECT RAISE(ABORT,'injected_session_input_manifest_failure'); END");
      await expect(service.execute(command, { signal })).rejects.toThrow("injected_session_input_manifest_failure");
      const prepared = store.readMutation(command.idempotencyKey);
      expect(prepared?.state).toBe("prepared");
      expect(prepared?.evidence).toBeUndefined();
      expect(store.messageAttachmentManifest(sessionId, prepared?.id ?? "missing")).toEqual([]);
      expect(codex.calls.filter((call) => call === providerCall)).toHaveLength(calls);
      expect(await blobs.read(reference.digest, "text/plain"))
        .toEqual(new TextEncoder().encode("read exactly once at provider dispatch"));
      inspector.exec("DROP TRIGGER fail_session_input_manifest");
      await service.execute(command, { signal });
      const accepted = store.readMutation(command.idempotencyKey);
      expect(accepted?.id).toBe(prepared?.id);
      expect(accepted?.state).toBe("applied");
      expect(store.messageAttachmentManifest(sessionId, accepted?.id ?? "missing")).toEqual(references);
      expect(codex.calls.filter((call) => call === providerCall)).toHaveLength(calls + 1);
    } finally {
      inspector.exec("DROP TRIGGER IF EXISTS fail_session_input_manifest");
      inspector.close(false);
    }
  });
test("refuses a message whose attachment is not in local custody", async () => {
    const value = await fixture();
    const { service, documents } = value;
    const added = await service.execute({ kind: "account.add", label: "Work" }, { signal }) as { account: { id: string } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    await service.execute({ kind: "project.add", label: "Documents", path: documents }, { signal });
    const started = await service.execute({ kind: "session.start", account: added.account.id, preset: "high", presetContract: 2, fast: false }, { signal }) as { session: { id: `sess_${string}` } };
    await expect(service.execute({
      attachments: [{
        byteLength: 7,
        digest: "c".repeat(64),
        mediaType: "text/markdown",
        name: "absent.md",
      }],
      kind: "session.send",
      message: "look",
      session: started.session.id,
    }, { signal })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
test.each(["rename", "reorder", "omit", "append"] as const)("queue attachment identity rejects a %s retry without changing custody", async (change) => {
    const { service, codex, documents, paths, store } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Queue identity" }, { signal }) as { account: { id: string } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    await service.execute({ kind: "project.add", label: "Documents", path: documents }, { signal });
    const started = await service.execute({ presetContract: currentPresetContract, kind: "session.start", account: added.account.id, preset: "high", fast: false }, { signal }) as { session: { id: `sess_${string}` } };
    await service.execute({ kind: "session.send", session: started.session.id, message: "Keep the provider busy." }, { signal });
    await writeFile(join(documents, "first.txt"), "first attachment");
    await writeFile(join(documents, "second.txt"), "second attachment");
    const references = await ingestAttachments(AttachmentBlobStore.forStatePaths(paths), ["first.txt", "second.txt"], documents);
    const one = references[0];
    if (one === undefined) throw new Error("Missing queue attachment fixture.");
    const command = { kind: "session.queue" as const, session: started.session.id, message: "Use both files.",
      attachments: [...references], idempotencyKey: crypto.randomUUID() };
    const first = await service.execute(command, { signal }) as { queued: { id: string } };
    const manifest = store.messageAttachmentManifest(started.session.id, first.queued.id);
    const custody = references.map((reference) => store.attachmentCustody(reference.digest));
    const calls = [...codex.calls];
    const attachments = change === "rename" ? [{ ...one, name: "renamed.txt" }, ...references.slice(1)]
      : change === "reorder" ? [...references].reverse()
        : change === "omit" ? [] : [...references, { ...one, name: "extra.txt" }];
    await expect(service.execute({ ...command, attachments }, { signal })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(store.listQueue(started.session.id)).toHaveLength(1);
    expect(store.messageAttachmentManifest(started.session.id, first.queued.id)).toEqual(manifest);
    expect(references.map((reference) => store.attachmentCustody(reference.digest))).toEqual(custody);
    expect(codex.calls).toEqual(calls);
  });
test("queue attachment identity rolls back enqueue when manifest admission fails", async () => {
    const { service, documents, paths, store } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Queue rollback" }, { signal }) as { account: { id: string } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    await service.execute({ kind: "project.add", label: "Documents", path: documents }, { signal });
    const started = await service.execute({ presetContract: currentPresetContract, kind: "session.start", account: added.account.id, preset: "high", fast: false }, { signal }) as { session: { id: `sess_${string}` } };
    await service.execute({ kind: "session.send", session: started.session.id, message: "Keep the provider busy." }, { signal });
    await writeFile(join(documents, "atomic.txt"), "atomic attachment");
    const references = await ingestAttachments(AttachmentBlobStore.forStatePaths(paths), ["atomic.txt"], documents);
    const command = { kind: "session.queue" as const, session: started.session.id, message: "All or nothing.",
      attachments: [...references], idempotencyKey: crypto.randomUUID() };
    const inspector = new Database(paths.database, { strict: true });
    try {
      inspector.exec("CREATE TRIGGER fail_queue_manifest BEFORE INSERT ON message_attachments BEGIN SELECT RAISE(ABORT,'injected_queue_manifest_failure'); END");
      await expect(service.execute(command, { signal })).rejects.toThrow("injected_queue_manifest_failure");
      expect(store.listQueue(started.session.id)).toEqual([]);
      expect(store.readMutation(command.idempotencyKey)).toBeNull();
    } finally {
      inspector.exec("DROP TRIGGER fail_queue_manifest");
      inspector.close(false);
    }
  });
test("queue attachment identity replays before blob and live session preflight", async () => {
    const { service, codex, documents, paths, store } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Queue historical replay" }, { signal }) as { account: { id: string } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    await service.execute({ kind: "project.add", label: "Documents", path: documents }, { signal });
    const started = await service.execute({ presetContract: currentPresetContract, kind: "session.start", account: added.account.id, preset: "high", fast: false }, { signal }) as { session: { id: `sess_${string}` } };
    await service.execute({ kind: "session.send", session: started.session.id, message: "Keep the provider busy." }, { signal });
    await writeFile(join(documents, "historical.txt"), "historical attachment");
    const blobs = AttachmentBlobStore.forStatePaths(paths);
    const references = await ingestAttachments(blobs, ["historical.txt"], documents);
    const reference = references[0];
    if (reference === undefined) throw new Error("Missing queue replay fixture.");
    const command = { kind: "session.queue" as const, session: started.session.id, message: "Keep the original receipt.",
      attachments: [...references], idempotencyKey: crypto.randomUUID() };
    const first = await service.execute(command, { signal });
    await blobs.remove(reference.digest, "text/plain");
    const current = store.requireSession(started.session.id);
    store.setSessionTurnState({ sessionId: current.id, expectedRevision: current.revision, state: "recovery_required" });
    const calls = [...codex.calls];
    await expect(service.execute(command, { signal })).resolves.toEqual(first);
    expect(store.listQueue(started.session.id)).toHaveLength(1);
    expect(codex.calls).toEqual(calls);
  });
test("queue attachment identity does not sweep or schedule when another writer wins after replay preflight", async () => {
    const value = await fixture();
    const { service, store, paths, documents, codex } = value;
    const { sessionId } = await createIdleSession(value, "Queue replay race");
    await writeFile(join(documents, "race.txt"), "shared queue attachment");
    const references = await ingestAttachments(AttachmentBlobStore.forStatePaths(paths), ["race.txt"], documents);
    const captured = store.requireSessionProviderAuthority(sessionId);
    const authority = { provider: captured.provider, providerAccountId: captured.providerAccountId, profileId: captured.profileId,
      bindingGeneration: captured.bindingGeneration, processGeneration: captured.processGeneration };
    const command = { kind: "session.queue" as const, session: sessionId, message: "One accepted queue item.",
      attachments: [...references], idempotencyKey: crypto.randomUUID() };
    const other = new StateStore(paths);
    const readReplay = store.readQueueEnqueueReplay.bind(store);
    const listUnreferenced = store.listUnreferencedAttachments.bind(store);
    let injected = false;
    let sweepReads = 0;
    store.readQueueEnqueueReplay = (input) => {
      const result = readReplay(input);
      if (!injected && result === null && input.idempotencyKey === command.idempotencyKey) {
        injected = true;
        const reservation = other.reserveAttachmentIngress({ kind: "session.queue", sessionId,
          idempotencyKey: command.idempotencyKey, message: command.message, attachments: references,
          providerAuthority: authority, daemonGeneration: value.daemonGeneration, bootId: value.daemonBootId });
        if (reservation.kind !== "reserved") throw new Error("Missing competing queue reservation.");
        other.enqueueIdempotent({ sessionId, message: command.message, idempotencyKey: command.idempotencyKey,
          profileGeneration: authority.processGeneration, providerAuthority: authority,
          attachmentReservation: { reservationId: reservation.reservationId, reservationDigest: reservation.reservationDigest,
            daemonGeneration: value.daemonGeneration, bootId: value.daemonBootId },
          attachments: references,
          storedAttachments: references.map((reference) => ({ ...reference, canonicalMediaType: "text/plain" as const })) });
      }
      return result;
    };
    store.listUnreferencedAttachments = (...input) => {
      sweepReads += 1;
      return listUnreferenced(...input);
    };
    const calls = [...codex.calls];
    try {
      await expect(service.execute(command, { signal })).resolves.toMatchObject({ queued: { state: "pending" } });
      await service.settled();
      expect(injected).toBe(true);
      expect(store.listQueue(sessionId)).toHaveLength(1);
      expect(sweepReads).toBe(0);
      // The null preflight still requires fresh account identity before the
      // atomic enqueue discovers the competing receipt. No other work runs.
      expect(codex.calls).toEqual([...calls, "readAccount"]);
    } finally {
      store.readQueueEnqueueReplay = readReplay;
      store.listUnreferencedAttachments = listUnreferenced;
      other.close();
    }
  });
test("queue attachment identity quarantines an unproved legacy FIFO head until explicit abandonment", async () => {
    const value = await fixture(new FakeCloud(), () => undefined,
      () => 1_900_000_001_000, undefined, {}, { canonical40Queues: true });
    const { service, store, paths, codex } = value;
    const archived = canonical40QueuesFixture.queues.find((entry) => entry.state === "pending");
    if (archived === undefined) throw new Error("Missing archived pending queue.");
    const { sessionId, queueId: legacyId } = archived;
    const inspector = new Database(paths.database, { strict: true });
    try {
      // Released canonical40 kept no immutable queue tuple or attachment seal.
      // Migration must quarantine that history, not borrow the session's tuple.
      expect(inspector.query("SELECT * FROM queue_provider_authorities WHERE queue_id=?").get(legacyId)).toBeNull();
      expect(inspector.query("SELECT * FROM queue_attachment_identities WHERE queue_id=?").get(legacyId)).toBeNull();
    } finally {
      inspector.close(false);
    }
    const calls = [...codex.calls];
    const originalQueue = store.listQueue(sessionId);
    expect(originalQueue.map((entry) => entry.id)).toEqual([legacyId]);
    const laterKey = crypto.randomUUID();
    await expect(service.execute({ kind: "session.queue", session: sessionId, message: "A later proved request.",
      idempotencyKey: laterKey }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    await service.settled();
    expect(store.listQueue(sessionId)).toEqual(originalQueue);
    expect(store.readMutation(laterKey)).toBeNull();
    expect(store.requireQueue(legacyId)).toMatchObject({ state: "pending", message: archived.originalMessage });
    expect(store.requireSession(sessionId).state).toBe("recovery_required");
    expect(codex.calls).toEqual(calls);
    await expect(service.execute({ kind: "session.recover", session: sessionId }, { signal }))
      .rejects.toMatchObject({ code: "RECOVERY_REQUIRED", details: { reason: "queue_attachment_identity_unproved" } });
    expect(codex.calls).toEqual(calls);
    expect(store.requireQueue(legacyId).message).toBe(archived.originalMessage);
    await expect(service.execute({ kind: "session.abandon", session: sessionId }, { signal }))
      .resolves.toMatchObject({ recovery: { resolved: true, resolution: "abandoned", providerEffectRetried: false, providerStateDeleted: false } });
    await service.settled();
    expect(store.requireQueue(legacyId)).toMatchObject({ state: "cancelled", message: "[queue message removed after settlement]" });
    expect(store.hasUnsettledQueueAttachmentQuarantineForSession(sessionId)).toBe(false);
    expect(store.listQueue(sessionId)).toHaveLength(1);
    expect(store.requireSession(sessionId).state).toBe("terminal");
    expect(codex.calls).toEqual(calls);
  });
test("pages neutral transcript records without skipping and reports retained-history loss", async () => {
    let currentTime = 1_000;
    const value = await fixture(new FakeCloud(),
      () => undefined,
      () => currentTime,
    );
    const { sessionId } = await createIdleSession(value, "Transcript paging");
    const session = value.store.requireSession(sessionId);
    const profile = value.store.requireProfileById(session.profileId);
    const append = (text: string): void => {
      currentTime += 1;
      value.store.appendSessionEvent({
        providerAuthority: value.store.requireProviderAccountAuthority(profile.id, "codex"),
        accountId: profile.id,
        body: {
          actor: "human",
          omittedCharacters: 0,
          text,
          turnId: null,
          type: "user_message",
        },
        providerConnectionId: null,
        providerGeneration: profile.processGeneration,
        sessionId,
      });
    };
    append("one");
    append("two");
    append("three");

    type TranscriptResult = {
      nextSequence: number | null;
      records: readonly { kind: string; text?: string }[];
      retentionGapReason?: string | null;
    };
    const first = await value.service.execute({
      kind: "session.transcript",
      limit: 2,
      session: sessionId,
    }, { signal }) as TranscriptResult;
    expect(first.records.map((record) => record.text)).toEqual(["one", "two"]);
    expect(first.nextSequence).not.toBeNull();
    const second = await value.service.execute({
      after: first.nextSequence ?? undefined,
      kind: "session.transcript",
      limit: 2,
      session: sessionId,
    }, { signal }) as TranscriptResult;
    expect(second.records.map((record) => record.text)).toEqual(["three"]);
    expect(second.nextSequence).toBeNull();

    currentTime += SESSION_EVENT_RETAIN_AGE_MS + 1;
    append("after retention");
    for (const after of [undefined, 0] as const) {
      const retained = await value.service.execute({
        ...(after === undefined ? {} : { after }),
        kind: "session.transcript",
        limit: 10,
        session: sessionId,
      }, { signal }) as TranscriptResult;
      expect(retained.records.map((record) => record.text)).toEqual(["after retention"]);
      expect(retained.retentionGapReason).toBe("retention_age");
    }
  });
test("hooks host-owned facts memory into start, resume, terminal archive, and expiry without a model command", async () => {
    const factsMemory = new FakeFactsMemoryLifecycle();
    const now = () => 10_000;
    const { service, documents, codex } = await fixture(new FakeCloud(),
      () => undefined,
      now,
      factsMemory,
    );
    const added = await service.execute({ kind: "account.add", label: "Memory" }, { signal }) as { account: { id: string } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    await service.execute({ kind: "project.add", label: "Memory docs", path: documents }, { signal });
    const started = await service.execute({
      kind: "session.start",
      account: added.account.id,
      preset: "high",
      presetContract: 2,
      fast: false,
    }, { signal }) as { session: { id: string } };
    expect(factsMemory.ensures.length).toBeGreaterThanOrEqual(2);
    expect(factsMemory.ensures.every((entry) =>
      entry.ownerId === added.account.id && entry.sessionId === started.session.id)).toBe(true);
    expect(JSON.stringify(factsMemory.ensures)).not.toMatch(/path|store|space|authority|rule|purge|credential/iu);

    codex.readProjection = {
      providerThreadId: "provider-thread",
      status: "terminal",
      title: "Archived",
    };
    await service.execute({ kind: "session.show", session: started.session.id, detail: false }, { signal });
    expect(factsMemory.cleanups).toContainEqual({
      ownerId: added.account.id,
      reason: "archive",
      sessionId: started.session.id,
    });
    expect(factsMemory.sweeps.length).toBeGreaterThan(0);
    expect(localCommandSchema.safeParse({
      kind: "facts-memory.query",
      path: "/tmp/agent-selected",
    }).success).toBe(false);
  });
test.each([false, true])("honors bound working-memory ownership during a cross-account switch (unsettled=%s)", async (unsettled) => {
    const factsMemory = new FakeFactsMemoryLifecycle();
    const value = await fixture(new FakeCloud(),
      () => undefined,
      Date.now,
      factsMemory,
    );
    const source = await value.service.execute(
      { kind: "account.add", label: "Memory switch source" },
      { signal },
    ) as { account: { id: string } };
    await value.service.execute(
      { kind: "account.login", account: source.account.id, deviceCode: false },
      { signal },
    );
    await value.service.execute(
      { kind: "project.add", label: "Memory switch docs", path: value.documents },
      { signal },
    );
    const started = await value.service.execute({
      kind: "session.start",
      account: source.account.id,
      preset: "high",
      presetContract: currentPresetContract,
      fast: false,
    }, { signal }) as { session: { id: `sess_${string}` } };
    const target = await value.service.execute(
      { kind: "account.add", label: "Memory switch target" },
      { signal },
    ) as { account: { id: string } };
    await value.service.execute(
      { kind: "account.login", account: target.account.id, deviceCode: false },
      { signal },
    );
    const callsBeforeSwitch = [...value.codex.calls];
    const memoryBefore = factsMemory.readSession(started.session.id);
    if (memoryBefore === null) throw new Error("Expected an existing facts-memory owner.");
    expect(memoryBefore.ownerId).toBe(source.account.id);
    const session = value.store.requireSession(started.session.id);
    if (session.projectId === undefined) throw new Error("Expected a project-bound session.");
    const prepared = unsettled ? value.store.prepareMemorySubmission({
      actorSessionId: session.id, projectId: session.projectId, kind: "remember",
      requestDigest: "1".repeat(64), contentDigest: "2".repeat(64), keyDigest: "3".repeat(64),
      workingBindingDigest: memoryBefore.bindingDigest, workingEpoch: memoryBefore.epoch,
      expectedHead: { sequence: 0, operationSha256: null, headDigest: PROJECT_MEMORY_EMPTY_HEAD.headDigest },
      idempotencyKey: crypto.randomUUID(),
    }).record : null;
    const before = serviceFixtureDatabaseSnapshot(value.paths.database);
    const key = crypto.randomUUID();
    const command = {
      account: target.account.id,
      idempotencyKey: key,
      kind: "session.switch" as const,
      presetContract: currentPresetContract,
      provider: "codex" as const,
      session: started.session.id,
    };
    if (prepared !== null) {
      await expect(value.service.execute(command, { signal })).rejects.toMatchObject({
        code: "RECOVERY_REQUIRED", details: { sessionId: session.id, submissionId: prepared.id, submissionState: "prepared" },
      });
      expect(value.codex.calls).toEqual(callsBeforeSwitch);
      expect(serviceFixtureDatabaseSnapshot(value.paths.database)).toEqual(before);
      expect(factsMemory.readSession(session.id)).toEqual(memoryBefore);
      expect(factsMemory.transfers).toEqual([]);
    } else {
      await value.service.execute(command, { signal });
      const record = value.store.readSessionSwitchByIdempotencyKey(key);
      if (record === null) throw new Error("Expected the committed switch journal.");
      const digest = createHash("sha256").update(JSON.stringify({
        domain: "hra:session-switch-facts-memory-owner:v1", attemptId: record.attemptId,
        sourceAuthority: record.sourceAuthority, targetAuthority: record.targetAuthority,
      })).digest("hex");
      expect(factsMemory.transfers).toHaveLength(1);
      expect(factsMemory.transfers[0]).toMatchObject({ sessionId: session.id,
        fromOwnerId: source.account.id, toOwnerId: target.account.id, operationKey: `session-switch-owner:${digest}` });
      expect(factsMemory.readSession(session.id)).toEqual({ ...memoryBefore,
        ownerId: target.account.id, epoch: memoryBefore.epoch + 1 });
      expect(value.store.requireSession(session.id).profileId).toBe(target.account.id);
    }
    expect(factsMemory.cleanups).toEqual([]);
  });
test("cancels pre-effect memory submissions before terminal facts-memory purge", async () => {
    const factsMemory = new FakeFactsMemoryLifecycle();
    const memory = new FakeMemory();
    const value = await fixture(new FakeCloud(),
      () => undefined,
      Date.now,
      factsMemory,
      {},
      memory,
    );
    const { sessionId } = await createIdleSession(value, "Prepared memory cleanup");
    const session = value.store.requireSession(sessionId);
    if (session.projectId === undefined) throw new Error("Expected a project-bound session.");
    const prepared = value.store.prepareMemorySubmission({
      actorSessionId: sessionId,
      projectId: session.projectId,
      kind: "remember",
      requestDigest: "1".repeat(64),
      contentDigest: "2".repeat(64),
      keyDigest: "3".repeat(64),
      workingBindingDigest: "4".repeat(64),
      workingEpoch: 1,
      expectedHead: {
        sequence: 0,
        operationSha256: null,
        headDigest: PROJECT_MEMORY_EMPTY_HEAD.headDigest,
      },
      idempotencyKey: crypto.randomUUID(),
    }).record;
    value.codex.readProjection = {
      providerThreadId: session.providerThreadId ?? "provider-thread",
      status: "terminal",
      title: session.title,
    };

    await expect(value.service.execute({
      kind: "session.show",
      session: sessionId,
      detail: false,
    }, { signal })).resolves.toMatchObject({ session: { state: "terminal" } });
    expect(value.store.requireMemorySubmission(prepared.id).state).toBe("cancelled");
    expect(factsMemory.cleanups.at(-1)).toEqual({
      ownerId: session.profileId,
      reason: "archive",
      sessionId,
    });
    expect(memory.forgottenSessions).toContain(sessionId);
  });
});
