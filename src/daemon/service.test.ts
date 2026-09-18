import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { CodexError, IndeterminateCodexEffectError, readCodexAutomationAuthority, type CodexAutomationAuthorityRequest, type CodexAutomationAuthorityScan } from "../codex";
import { parseFact } from "../codex/protocol";
import { localCommandSchema, publicSessionListPageSchema, type LocalCommand } from "../domain/contracts";
import type { InteractionRecord, ProviderInteractionAuthority } from "../domain/interactions";
import { currentPresetContract, legacyPresetContract, presetRequirements } from "../domain/presets";
import type { EffectiveClaudeRuntimeProfile, EffectiveRuntimeProfile } from "../domain/runtime-profile";
import { initializeStatePaths, profilePaths, resolveStatePaths } from "../storage/paths";
import { InMemoryGatewayKeyStore, type GatewayKeyPort } from "../storage/gateway-key-custody";
import { StateStore } from "../storage/state-store";
import { canonicalAdoption40DatabaseBytes, canonicalAdoption40Fixture } from "../../scripts/fixtures/canonical-adoption40";
import { DeterministicProseResponder, PROSE_APPROVAL_REPLY, type ProseResponder } from "./prose-responder";
import { DaemonAuthoritySafetyError } from "./daemon-lock";
import { ClaudeProcessExitUnprovenError, ClaudeSessionObservationError, CodexClaimReleaseUnprovenError, CodexSessionObservationError, type ClaudeProcessIdentity, type CodexAccountProjection, type ProfileAuthority } from "./ports";
import { BoundedPersonalSessionDiscovery, CLAUDE_REGISTRY_MAX_RECORDS, PERSONAL_CODEX_DISCOVERY_MAX_RESULTS, PERSONAL_SESSION_DISCOVERY_MAX_RESULTS, PERSONAL_SESSION_DISCOVERY_RECENCY_WINDOW_MS, type ClaudeProcessLivenessProbe, type PersonalSessionDiscoveryPort } from "./personal-session-discovery";
import { SessionEventCursorCodec } from "./session-event-cursor";
import { CommandFailure, OompaService } from "./service";
import type {
  ServiceFixtureFactory} from "../../scripts/fixtures/service-testkit";
import {
  FakeClaude,
  FakeCloud,
  FakeCodex,
  FakeDaemonAuthority,
  FakeFactsMemoryLifecycle,
  FakePersonalSessionDiscovery,
  abandonArchivedDevinLogin,
  adoptedClaudeFixture,
  adoptedCodexFixture,
  archivedDevinFixture,
  claudeAuthorityFixtureTimeoutMs,
  claudeProviderAccountKey,
  claudeRuntimeProfile,
  codexInteractionBinding,
  codexProviderAccountKey,
  createIdleSession,
  createOwnedServiceCase,
  fixture,
  liveAuthorityFor,
  nativeClaudeFixture,
  ownedFixtureTeardowns,
  ownedServiceCase,
  ownedServiceCaseTeardowns,
  ownedServiceFixture,
  ownedServiceFixtureWithClose,
  personalAdoptionNow,
  personalCodexAutomationScan,
  personalCodexHome,
  preparedPersonalCodexCandidate,
  privatePathRoot,
  renderJson,
  runtimeProfile,
  seedResolvableInteraction,
  serviceRoots,
  signal,
  stores,
} from "../../scripts/fixtures/service-testkit";

setDefaultTimeout(60_000);

describe("owned service case lifecycle", () => {
  test("checks cancellation between prepared-value resolution and publication", async () => {
    const teardowns: Array<() => Promise<void>> = [];
    const owner = createOwnedServiceCase(teardowns);
    const entered = Promise.withResolvers<undefined>();
    const preparation = Promise.withResolvers<string>();
    let published: string | undefined;
    const setup = owner.run(async (context) => {
      entered.resolve(undefined);
      const value = await preparation.promise;
      context.signal.throwIfAborted();
      published = value;
    });
    await entered.promise;
    preparation.resolve("prepared");
    const closing = teardowns[0]?.();
    await closing;
    await expect(setup).rejects.toThrow("Owned service case is closing.");
    expect(published).toBeUndefined();
  });

  test.each(["setup", "case"] as const)("returns the observed %s task and drains it before later cleanup", async (phase) => {
    const teardowns: Array<() => Promise<void>> = [];
    const owner = createOwnedServiceCase(teardowns);
    const nextTeardowns: Array<() => Promise<void>> = [];
    const nextOwner = createOwnedServiceCase(nextTeardowns);
    const entered = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    const lateFailure = new Error(`late ${phase} failure`);
    const events: string[] = [];
    if (phase === "case") await owner.run(async () => undefined);
    await nextOwner.run(async ({ resources }) => {
      resources.stores.push({ close: () => { events.push("close-next-case"); } });
    });
    let observed: Promise<void> | undefined;
    const hook = () => {
      observed = owner.run(async ({ resources }) => {
        entered.resolve(undefined);
        await release.promise;
        resources.stores.push({ close: () => { events.push("close-late-store"); } });
        events.push("raw-failed");
        throw lateFailure;
      });
      return observed;
    };
    const task = hook();
    expect<Promise<void> | undefined>(task).toBe(observed);
    await entered.promise;
    const closing = teardowns[0]?.().catch((error: unknown) => error);
    await Promise.resolve();
    expect(events).toEqual([]);
    release.resolve(undefined);
    const error = await closing;
    expect(error).toBeInstanceOf(AggregateError);
    if (!(error instanceof AggregateError)) throw new Error("Expected the original late phase failure.");
    expect(error.errors).toEqual([lateFailure]);
    await expect(task).rejects.toBe(lateFailure);
    expect(events).toEqual(["raw-failed", "close-late-store"]);
    await nextTeardowns[0]?.();
    expect(events).toEqual(["raw-failed", "close-late-store", "close-next-case"]);
  });

  test("keeps real SQLite open until delayed service retirement has joined", async () => {
    const teardowns: Array<() => Promise<void>> = [];
    const owner = createOwnedServiceCase(teardowns);
    const entered = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    let value: Awaited<ReturnType<typeof fixture>> | undefined;
    await owner.run(async ({ createFixture }) => {
      value = await createFixture(undefined, undefined, undefined, undefined, {
        beforeMemoryClose: async () => {
          entered.resolve(undefined);
          await release.promise;
        },
      });
    });
    if (value === undefined) throw new Error("Expected the real service fixture.");
    const store = value.store;
    const closing = teardowns[0]?.();
    void closing?.catch((error: unknown) => { entered.reject(error); });
    try {
      await entered.promise;
      expect(store.listUnreleasedClaudeProcessAuthorities()).toEqual([]);
    } finally {
      release.resolve(undefined);
      await closing;
    }
    expect(() => store.listUnreleasedClaudeProcessAuthorities()).toThrow("Cannot use a closed database");
  });

  test("registers before deferred setup and cancels before resources open", async () => {
    const teardowns: Array<() => Promise<void>> = [];
    let opened = false;
    const task = ownedServiceCase(async () => { opened = true; }, teardowns);
    expect(teardowns).toHaveLength(1);
    await teardowns[0]?.();
    await expect(task).rejects.toThrow("Owned service case is closing.");
    expect(opened).toBe(false);
  });

  test("joins a late case failure and tries every service close before retaining unproved storage", async () => {
    const teardowns: Array<() => Promise<void>> = [];
    const entered = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    const caseFailure = new Error("late service case failure");
    const closeFailure = new Error("service close failure");
    const events: string[] = [];
    const task = ownedServiceCase(async ({ resources }) => {
      resources.services.push({ close: async () => { events.push("close-first"); throw closeFailure; } });
      entered.resolve(undefined);
      await release.promise;
      resources.services.push({ close: async () => { events.push("close-late"); } });
      resources.stores.push({ close: () => { events.push("close-store"); } });
      events.push("raw-failed");
      throw caseFailure;
    }, teardowns);
    await entered.promise;
    const closing = teardowns[0]?.().catch((error: unknown) => error);
    await Promise.resolve();
    expect(events).toEqual([]);
    release.resolve(undefined);
    const error = await closing;
    expect(error).toBeInstanceOf(AggregateError);
    if (!(error instanceof AggregateError)) throw new Error("Expected case and service close failures.");
    expect(error.errors).toEqual([caseFailure, closeFailure]);
    await expect(task).rejects.toBe(caseFailure);
    expect(events).toEqual(["raw-failed", "close-first", "close-late"]);
  });

  test("closes stores only after the raw case and every service have joined", async () => {
    const teardowns: Array<() => Promise<void>> = [];
    const entered = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    const events: string[] = [];
    const task = ownedServiceCase(async ({ resources }) => {
      resources.services.push({ close: async () => { events.push("close-service"); } });
      entered.resolve(undefined);
      await release.promise;
      resources.stores.push({ close: () => { events.push("close-store"); } });
      events.push("raw-joined");
    }, teardowns);
    await entered.promise;
    const closing = teardowns[0]?.();
    await Promise.resolve();
    expect(events).toEqual([]);
    release.resolve(undefined);
    await closing;
    await expect(task).rejects.toThrow("Owned service case is closing.");
    expect(events).toEqual(["raw-joined", "close-service", "close-store"]);
  });
});

describe("OompaService personal-session adoption", () => {
  const expectUnprovedLaunchCloseRefused = async (value: {
    service: OompaService;
    store: StateStore;
  }): Promise<void> => {
    const intents = value.store.listClaudeProcessLaunchIntents(500);
    expect(intents.length).toBeGreaterThan(0);
    const authorities = intents.map((intent) =>
      value.store.requireProviderAccountAuthority(intent.profileId, "claude"));
    await expect(value.service.close()).rejects.toThrow(
      "An unresolved Claude launch still requires exact process recovery.",
    );
    expect(value.store.listClaudeProcessLaunchIntents(500)).toEqual(intents);
    expect(intents.map((intent) =>
      value.store.requireProviderAccountAuthority(intent.profileId, "claude"))).toEqual(authorities);
  };

  const waitFor = async (predicate: () => boolean, timeoutMs = 2_000): Promise<void> => {
    const startedAt = Date.now();
    while (!predicate()) {
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error("Timed out waiting for adopted-session autorespond.");
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };

  test.each([
    ["high", { model: "gpt-6-astra", effort: "max" }],
    ["ultra", { model: "gpt-6-astra", effort: "ultra" }],
  ] as const)(
    "binds a fresh adopted Codex %s session to Astra contract 2",
    async (preset, requirement) => {
      const providerThreadId = `personal-codex-fresh-${preset}-contract`;
      const value = await preparedPersonalCodexCandidate({
        label: `Fresh ${preset} contract`,
        providerThreadId,
        updatedAt: personalAdoptionNow - 11 * 60_000,
        liveness: "not_live",
      });
      value.store.setDefaultPreset(preset);

      await expect(value.enable()).resolves.toMatchObject({
        discovery: { provider: "codex", adopted: 1, failed: 0 },
      });

      expect(value.personalCodex.claimRequests).toHaveLength(1);
      expect(value.personalCodex.claimRequests[0]).toMatchObject({
        preset,
        requirement,
      });
      const session = value.store.findSessionByProviderThread(
        value.accountId,
        providerThreadId,
      );
      if (session === null) throw new Error("Expected the fresh Codex adoption.");
      expect(value.store.requireSessionPresetRequirement(session.id)).toEqual({
        preset,
        requirement,
      });
      expect(value.store.latestSessionRuntimeProfile(session.id)).toMatchObject({
        sourceKind: "session_start",
        profile: { preset, model: requirement.model, reasoningEffort: requirement.effort },
      });
      const inspector = new Database(value.paths.database, { readonly: true, strict: true });
      try {
        expect(inspector.query(
          "SELECT preset_contract FROM sessions WHERE id=?",
        ).get(session.id)).toEqual({ preset_contract: currentPresetContract });
      } finally {
        inspector.close(false);
      }
    },
  );

  test("keeps an adopted queue pending when its personal provider disconnects after review", async () => {
    const value = await adoptedCodexFixture(
      "Adopted queue disconnect fence",
      "personal-codex-queue-disconnect-fence",
    );
    const authority = value.personalCodex.claimRequests[0]?.authority;
    if (authority === undefined) throw new Error("Expected personal claim authority.");
    const providerCallsBefore = value.personalCodex.calls.filter(
      (call) => call === "send",
    ).length;
    value.personalCodex.beforeReviewTurnStartReturn = async () => {
      delete value.personalCodex.beforeReviewTurnStartReturn;
      value.personalCodex.observeError = new CodexSessionObservationError(
        "resume_unavailable",
      );
      await value.service.observePersonalCodexFact(authority, {
        type: "providerDisconnected",
        connectionId: value.personalCodex.observationConnectionId,
        reason: "process_exit",
      });
    };

    const result = await value.service.execute({
      kind: "session.queue",
      session: value.session.id,
      message: "remain pending across the exact disconnect race",
      idempotencyKey: "00000000-0000-4000-8000-00000000c004",
    }, { signal }) as { queued: { id: `queue_${string}` } };
    await value.service.settled();

    expect(value.personalCodex.turnReviewRequests).toHaveLength(1);
    expect(value.personalCodex.calls.filter((call) => call === "send"))
      .toHaveLength(providerCallsBefore);
    expect(value.store.requireQueue(result.queued.id)).toMatchObject({ state: "pending" });
    expect(value.store.readQueueEffect(result.queued.id)).toBeNull();
  });

  test("keeps an adopted direct send prepared when its personal provider disconnects after review, then retries on the replacement connection", async () => {
    const value = await adoptedCodexFixture(
      "Adopted send disconnect fence",
      "personal-codex-send-disconnect-fence",
    );
    const authority = value.personalCodex.claimRequests[0]?.authority;
    if (authority === undefined) throw new Error("Expected personal claim authority.");
    const key = "00000000-0000-4000-8000-00000000c005";
    const providerCallsBefore = value.personalCodex.calls.filter(
      (call) => call === "send",
    ).length;
    value.personalCodex.beforeReviewTurnStartReturn = async () => {
      delete value.personalCodex.beforeReviewTurnStartReturn;
      value.personalCodex.observeError = new CodexSessionObservationError(
        "resume_unavailable",
      );
      await value.service.observePersonalCodexFact(authority, {
        type: "providerDisconnected",
        connectionId: value.personalCodex.observationConnectionId,
        reason: "process_exit",
      });
    };

    const command = {
      kind: "session.send" as const,
      session: value.session.id,
      message: "dispatch only on the replacement connection",
      idempotencyKey: key,
    };
    await expect(value.service.execute(command, { signal })).rejects.toMatchObject({
      code: "UNAVAILABLE",
      details: { reason: "provider_connection_changed_before_effect" },
    });

    expect(value.personalCodex.calls.filter((call) => call === "send"))
      .toHaveLength(providerCallsBefore);
    const prepared = value.store.readMutation(key);
    expect(prepared).toMatchObject({ state: "prepared" });
    expect(prepared?.evidence).toBeUndefined();
    expect(value.store.readSessionUserMessageSource(value.session.id, "mutation", key))
      .toEqual({ status: "none" });

    const replacementConnectionId = "30000000-0000-4000-8000-0000000000d5";
    value.personalCodex.observationConnectionId = replacementConnectionId;
    delete value.personalCodex.observeError;
    await expect(value.service.execute(command, { signal })).resolves.toMatchObject({
      idempotencyKey: key,
    });

    expect(value.personalCodex.calls.filter((call) => call === "send"))
      .toHaveLength(providerCallsBefore + 1);
    expect(value.store.readMutation(key)).toMatchObject({ state: "applied" });
    const event = value.store.listSessionEvents({
      sessionId: value.session.id,
      afterSequence: 0,
    }).events.find((candidate) =>
      candidate.body.type === "user_message" && candidate.body.sourceId === key);
    expect(event).toMatchObject({ providerConnectionId: replacementConnectionId });
  });

  test("keeps an adopted steer prepared when its personal provider disconnects after the exact read, then retries on the replacement connection", async () => {
    const value = await adoptedCodexFixture(
      "Adopted steer disconnect fence",
      "personal-codex-steer-disconnect-fence",
    );
    const authority = value.personalCodex.claimRequests[0]?.authority;
    if (authority === undefined) throw new Error("Expected personal claim authority.");
    const activeTurnId = "turn-steer-disconnect-fence";
    value.personalCodex.readProjection = {
      ...value.personalCodex.readProjection,
      status: "active",
      activeTurnId,
    };
    value.store.reconcileSessionFromProvider({
      sessionId: value.session.id,
      state: "active",
      activeTurnId,
    });
    const key = "00000000-0000-4000-8000-00000000c006";
    const providerCallsBefore = value.personalCodex.calls.filter(
      (call) => call === "steer",
    ).length;
    value.personalCodex.beforeReadSessionReturn = async () => {
      delete value.personalCodex.beforeReadSessionReturn;
      value.personalCodex.observeError = new CodexSessionObservationError(
        "resume_unavailable",
      );
      await value.service.observePersonalCodexFact(authority, {
        type: "providerDisconnected",
        connectionId: value.personalCodex.observationConnectionId,
        reason: "process_exit",
      });
    };

    const command = {
      kind: "session.steer" as const,
      session: value.session.id,
      message: "steer only on the replacement connection",
      idempotencyKey: key,
    };
    await expect(value.service.execute(command, { signal })).rejects.toMatchObject({
      code: "UNAVAILABLE",
      details: { reason: "provider_connection_changed_before_effect" },
    });

    expect(value.personalCodex.calls.filter((call) => call === "steer"))
      .toHaveLength(providerCallsBefore);
    const prepared = value.store.readMutation(key);
    expect(prepared).toMatchObject({ state: "prepared" });
    expect(prepared?.evidence).toBeUndefined();
    expect(value.store.readSessionUserMessageSource(value.session.id, "mutation", key))
      .toEqual({ status: "none" });

    const replacementConnectionId = "30000000-0000-4000-8000-0000000000d6";
    value.personalCodex.observationConnectionId = replacementConnectionId;
    delete value.personalCodex.observeError;
    await expect(value.service.execute(command, { signal })).resolves.toMatchObject({
      idempotencyKey: key,
      steered: true,
      turnId: activeTurnId,
    });

    expect(value.personalCodex.calls.filter((call) => call === "steer"))
      .toHaveLength(providerCallsBefore + 1);
    expect(value.store.readMutation(key)).toMatchObject({ state: "applied" });
    const event = value.store.listSessionEvents({
      sessionId: value.session.id,
      afterSequence: 0,
    }).events.find((candidate) =>
      candidate.body.type === "user_message" && candidate.body.sourceId === key);
    expect(event).toMatchObject({ providerConnectionId: replacementConnectionId });
  });

  test.each([
    ["stop", "stop", "00000000-0000-4000-8000-00000000c007"],
    ["rename", "rename", "00000000-0000-4000-8000-00000000c008"],
  ] as const)(
    "keeps an adopted %s prepared when its personal provider disconnects after the exact read",
    async (operation, providerCall, key) => {
      const value = await adoptedCodexFixture(
        `Adopted ${operation} disconnect fence`,
        `personal-codex-${operation}-disconnect-fence`,
      );
      const authority = value.personalCodex.claimRequests[0]?.authority;
      if (authority === undefined) throw new Error("Expected personal claim authority.");
      if (operation === "stop") {
        const activeTurnId = "turn-stop-disconnect-fence";
        value.personalCodex.readProjection = {
          ...value.personalCodex.readProjection,
          status: "active",
          activeTurnId,
        };
        value.store.reconcileSessionFromProvider({
          sessionId: value.session.id,
          state: "active",
          activeTurnId,
        });
      }
      const providerCallsBefore = value.personalCodex.calls.filter(
        (call) => call === providerCall,
      ).length;
      value.personalCodex.beforeReadSessionReturn = async () => {
        delete value.personalCodex.beforeReadSessionReturn;
        value.personalCodex.observeError = new CodexSessionObservationError(
          "resume_unavailable",
        );
        await value.service.observePersonalCodexFact(authority, {
          type: "providerDisconnected",
          connectionId: value.personalCodex.observationConnectionId,
          reason: "process_exit",
        });
      };
      const command = operation === "stop"
        ? {
            kind: "session.stop" as const,
            session: value.session.id,
            idempotencyKey: key,
          }
        : {
            kind: "session.rename" as const,
            session: value.session.id,
            name: "Renamed only on a live connection",
            idempotencyKey: key,
          };

      await expect(value.service.execute(command, { signal })).rejects.toMatchObject({
        code: "UNAVAILABLE",
        details: { reason: "provider_connection_changed_before_effect" },
      });
      expect(value.personalCodex.calls.filter((call) => call === providerCall))
        .toHaveLength(providerCallsBefore);
      const prepared = value.store.readMutation(key);
      expect(prepared).toMatchObject({ state: "prepared" });
      expect(prepared?.evidence).toBeUndefined();
    },
  );

  test("preserves an established adopted Sol contract across rediscovery and restart, then rebinds Astra after detach", async () => {
    const providerThreadId = "personal-codex-historical-sol-contract";
    const value = await adoptedCodexFixture(
      "Historical adopted Sol contract",
      providerThreadId,
    );
    const initialAuthority = value.personalCodex.claimRequests[0]?.authority;
    if (initialAuthority === undefined) throw new Error("Expected initial adoption authority.");
    const historicalAstraProfile: EffectiveRuntimeProfile = {
      ...runtimeProfile(initialAuthority),
      preset: "ultra",
      model: "gpt-5.6-sol",
      reasoningEffort: "ultra",
    };
    const writer = new Database(value.paths.database, { strict: true });
    try {
      expect(writer.query(
        "UPDATE sessions SET preset_contract=?,canonical_profile_key='codex:gpt-5.6-sol:ultra' WHERE id=?",
      ).run(legacyPresetContract, value.session.id).changes).toBe(1);
    } finally {
      writer.close(false);
    }
    value.store.recordSessionRuntimeProfile({
      sessionId: value.session.id,
      sourceKind: "turn_start",
      sourceId: "historical-adopted-sol-contract",
      profile: historicalAstraProfile,
      providerAuthority: value.store.requireProviderAccountAuthority(historicalAstraProfile.profileId, "codex"),
    });
    const establishedSession = value.store.requireSession(value.session.id);
    const establishedProfile = value.store.latestSessionRuntimeProfile(value.session.id);
    expect(value.store.requireSessionPresetRequirement(value.session.id)).toEqual({
      preset: "ultra",
      requirement: { model: "gpt-5.6-sol", effort: "ultra" },
    });

    await expect(value.service.execute({
      kind: "session.adoption.discover",
      provider: "codex",
    }, { signal })).resolves.toMatchObject({
      providers: [{ provider: "codex", adopted: 0 }],
    });
    expect(value.personalCodex.claimRequests).toHaveLength(1);
    expect(value.store.requireSession(value.session.id)).toEqual(establishedSession);
    expect(value.store.latestSessionRuntimeProfile(value.session.id)).toEqual(establishedProfile);

    const originalCaptured = value.store.requireCapturedSessionProviderAuthority(value.session.id);
    await value.service.close();
    // Shutdown alone retires the runtime. Its exact historical observation
    // permission is local-only and must not silently revive the old tuple.
    expect(value.store.requireCapturedSessionProviderAuthority(value.session.id)).toEqual(originalCaptured);
    expect(value.store.readHistoricalSessionObservationAuthority(value.session.id)).toEqual({
      authority: originalCaptured, lineage: "provider_disconnect",
    });
    expect(() => value.store.requireSessionProviderAuthority(value.session.id))
      .toThrow("SESSION_PROVIDER_AUTHORITY_STALE");
    expect(value.store.latestSessionRuntimeProfile(value.session.id)).toEqual(establishedProfile);
    const restartBootId = `boot_${crypto.randomUUID().replaceAll("-", "")}`;
    const restartGeneration = value.store.nextDaemonGeneration(restartBootId);
    expect(restartGeneration).toBe(value.daemonGeneration + 1);
    const rebound = value.store.requireSessionProviderAuthority(value.session.id);
    expect(rebound).toEqual({
      ...originalCaptured,
      authorityRevision: originalCaptured.authorityRevision + 1,
      processGeneration: originalCaptured.processGeneration + 2,
    });
    expect(value.store.readHistoricalSessionObservationAuthority(value.session.id)).toBeNull();
    const successorReader = new Database(value.paths.database, { strict: true });
    try {
      successorReader.exec("PRAGMA query_only=ON");
      expect(successorReader.query(`SELECT from_provider_account_id,to_provider_account_id,
        from_profile_id,to_profile_id,from_provider,to_provider,
        from_binding_generation,to_binding_generation,from_process_generation,to_process_generation,
        transition_kind,transition_id FROM session_provider_authority_successors
        WHERE session_id=? AND from_authority_revision=?`).all(value.session.id, originalCaptured.authorityRevision))
        .toEqual([{
          from_provider_account_id: originalCaptured.providerAccountId,
          to_provider_account_id: originalCaptured.providerAccountId,
          from_profile_id: originalCaptured.profileId, to_profile_id: originalCaptured.profileId,
          from_provider: "codex", to_provider: "codex",
          from_binding_generation: originalCaptured.bindingGeneration,
          to_binding_generation: originalCaptured.bindingGeneration,
          from_process_generation: originalCaptured.processGeneration,
          to_process_generation: rebound.processGeneration,
          transition_kind: "provider_restart", transition_id: restartBootId,
        }]);
    } finally { successorReader.close(false); }
    const restartedPersonalCodex = new FakeCodex();
    restartedPersonalCodex.readProjection = {
      ...value.personalCodex.readProjection,
      providerThreadId,
      status: "idle",
    };
    const restarted = new OompaService({
      store: value.store,
      paths: value.paths,
      codex: new FakeCodex(),
      personalCodex: restartedPersonalCodex,
      personalCodexHome,
      personalDiscovery: value.discovery,
      cloud: new FakeCloud(),
      daemonAuthority: new FakeDaemonAuthority(),
      daemonGeneration: restartGeneration,
      daemonBootId: restartBootId,
      eventCursors: value.eventCursors,
      now: () => personalAdoptionNow,
      requestStop: () => undefined,
    });
    await restarted.recover();
    await restarted.settled();
    expect(restartedPersonalCodex.claimRequests).toHaveLength(0);
    expect(restartedPersonalCodex.observedThreads).toContain(providerThreadId);
    expect(value.store.requireSessionPresetRequirement(value.session.id)).toEqual({
      preset: "ultra",
      requirement: { model: "gpt-5.6-sol", effort: "ultra" },
    });
    expect(value.store.latestSessionRuntimeProfile(value.session.id)).toEqual(establishedProfile);

    await expect(restarted.execute({
      kind: "session.adoption.discover",
      provider: "codex",
    }, { signal })).resolves.toMatchObject({
      providers: [{ provider: "codex", adopted: 0 }],
    });
    expect(restartedPersonalCodex.claimRequests).toHaveLength(0);
    expect(value.store.requireSessionPresetRequirement(value.session.id).requirement)
      .toEqual({ model: "gpt-5.6-sol", effort: "ultra" });

    value.store.detachPersonalSession({ sessionId: value.session.id, archive: false });
    value.store.setSessionAdoptionPolicy({ provider: "codex", profileId: null });
    value.store.setSessionAdoptionPolicy({ provider: "codex", profileId: value.accountId });
    value.store.setDefaultPreset("high");
    await expect(restarted.execute({
      kind: "session.adoption.discover",
      provider: "codex",
    }, { signal })).resolves.toMatchObject({
      providers: [{ provider: "codex", adopted: 1, failed: 0 }],
    });
    expect(restartedPersonalCodex.claimRequests).toHaveLength(1);
    expect(restartedPersonalCodex.claimRequests[0]).toMatchObject({
      preset: "high",
      requirement: { model: "gpt-6-astra", effort: "max" },
    });
    expect(value.store.requireSessionPresetRequirement(value.session.id)).toEqual({
      preset: "high",
      requirement: { model: "gpt-6-astra", effort: "max" },
    });
    const inspector = new Database(value.paths.database, { readonly: true, strict: true });
    try {
      expect(inspector.query(
        "SELECT preset_contract FROM sessions WHERE id=?",
      ).get(value.session.id)).toEqual({ preset_contract: currentPresetContract });
    } finally {
      inspector.close(false);
    }
    await restarted.close();
  });

  test.each([
    ["a deterministically released claim failure", new Error("claim rejected after exact release"), "pending"],
    ["an unproven claim release", new CodexClaimReleaseUnprovenError(), "claiming"],
  ] as const)(
    "records the exact durable outcome for %s",
    async (_case, claimError, expectedStatus) => {
      let now = personalAdoptionNow;
      const providerThreadId = `personal-codex-${expectedStatus}-claim-failure`;
      const value = await preparedPersonalCodexCandidate({
        label: `Codex ${expectedStatus} claim failure`,
        providerThreadId,
        updatedAt: personalAdoptionNow - 11 * 60_000,
        liveness: "not_live",
        now: () => now,
      });
      value.personalCodex.claimError = claimError;

      await expect(value.enable()).resolves.toMatchObject({
        discovery: { provider: "codex", adopted: 0, failed: 1 },
      });

      expect(value.personalCodex.claimRequests).toHaveLength(1);
      expect(value.personalCodex.calls.filter((call) => call === "end")).toHaveLength(0);
      expect(value.store.listSessionAdoptionCandidates({ provider: "codex" })
        .some((candidate) =>
          candidate.providerThreadId === providerThreadId
          && candidate.status === expectedStatus)).toBe(true);
      if (expectedStatus !== "claiming") return;

      now += 1;
      await expect(value.service.execute({
        kind: "session.adoption.discover",
        provider: "codex",
      }, { signal })).resolves.toMatchObject({
        providers: [{ provider: "codex", adopted: 0, pending: 1 }],
      });
      expect(value.personalCodex.claimRequests).toHaveLength(1);
      expect(value.store.listSessionAdoptionCandidates({ provider: "codex" })
        .some((candidate) =>
          candidate.providerThreadId === providerThreadId
          && candidate.status === "claiming")).toBe(true);

      now += 1;
      const daemonGeneration = value.store.nextDaemonGeneration(
        `boot_${"7".repeat(32)}`,
      );
      const restartedPersonalCodex = new FakeCodex();
      restartedPersonalCodex.readProjection = {
        ...value.personalCodex.readProjection,
        providerThreadId,
      };
      const restarted = new OompaService({
        store: value.store,
        paths: value.paths,
        codex: new FakeCodex(),
        personalCodex: restartedPersonalCodex,
        personalCodexHome,
        personalDiscovery: value.discovery,
        cloud: new FakeCloud(),
        daemonAuthority: new FakeDaemonAuthority(),
        daemonGeneration,
        now: () => now,
        requestStop: () => undefined,
      });
      await expect(restarted.execute({
        kind: "session.adoption.discover",
        provider: "codex",
      }, { signal })).resolves.toMatchObject({
        providers: [{ provider: "codex", adopted: 1, failed: 0 }],
      });
      expect(restartedPersonalCodex.claimRequests).toHaveLength(1);
      expect(value.store.findSessionByProviderThread(value.accountId, providerThreadId))
        .not.toBeNull();
    },
  );

  test.each(["disable", "reassign"] as const)(
    "recovers a restarted stale Codex claim after schedule removal before policy %s",
    async (action) => {
      let now = personalAdoptionNow;
      const providerThreadId = `removed-schedule-${action}-claim`;
      let scheduledTargets: readonly Readonly<{ targetThreadId: string | null }>[] = [{
        targetThreadId: providerThreadId,
      }];
      const value = await preparedPersonalCodexCandidate({
        label: `Removed schedule ${action}`,
        providerThreadId,
        updatedAt: personalAdoptionNow - 24 * 60 * 60_000,
        liveness: "not_live",
        scheduledTaskTarget: true,
        now: () => now,
        readPersonalCodexAutomations: (request) => Promise.resolve(
          personalCodexAutomationScan(scheduledTargets, request),
        ),
      });
      const replacement = await value.service.execute({
        kind: "account.add",
        label: `Replacement account ${action}`,
      }, { signal }) as { account: { id: `acct_${string}` } };
      await value.service.execute({
        kind: "account.login",
        account: replacement.account.id,
        deviceCode: false,
      }, { signal });
      value.personalCodex.claimError = new CodexClaimReleaseUnprovenError();
      await expect(value.enable()).resolves.toMatchObject({
        discovery: { provider: "codex", adopted: 0, failed: 1 },
      });
      expect(value.store.listSessionAdoptionCandidates({
        provider: "codex",
        status: "claiming",
      })).toHaveLength(1);

      // The granting Desktop record disappears while the daemon is down. The
      // old thread is outside ordinary recency and therefore cannot re-enter
      // discovery merely to settle its interrupted claim.
      scheduledTargets = [];
      value.discovery.candidates = [];
      now += 1;
      const daemonGeneration = value.store.nextDaemonGeneration(
        `boot_${(action === "disable" ? "8" : "9").repeat(32)}`,
      );
      const restartedPersonalCodex = new FakeCodex();
      restartedPersonalCodex.readProjection = {
        providerThreadId,
        title: `Removed schedule ${action} personal thread`,
        projectRoot: value.documents,
        status: "idle",
        providerUpdatedAt: personalAdoptionNow - 24 * 60 * 60_000,
      };
      const restarted = new OompaService({
        store: value.store,
        paths: value.paths,
        codex: new FakeCodex(),
        personalCodex: restartedPersonalCodex,
        personalCodexHome,
        personalDiscovery: value.discovery,
        readPersonalCodexAutomations: (request) => Promise.resolve(
          personalCodexAutomationScan(scheduledTargets, request),
        ),
        cloud: new FakeCloud(),
        daemonAuthority: new FakeDaemonAuthority(),
        daemonGeneration,
        now: () => now,
        requestStop: () => undefined,
      });

      if (action === "disable") {
        await expect(restarted.execute({
          kind: "session.adoption.set",
          provider: "codex",
          enabled: false,
        }, { signal })).resolves.toMatchObject({
          providers: [{ provider: "codex", enabled: false }],
        });
        expect(value.store.readSessionAdoptionPolicy("codex")?.profileId).toBeNull();
      } else {
        await expect(restarted.execute({
          kind: "session.adoption.set",
          provider: "codex",
          enabled: true,
          account: replacement.account.id,
        }, { signal })).resolves.toMatchObject({
          providers: [{
            provider: "codex",
            accountId: replacement.account.id,
            enabled: true,
          }],
        });
        expect(value.store.readSessionAdoptionPolicy("codex")?.profileId)
          .toBe(replacement.account.id);
      }
      expect(restartedPersonalCodex.metadataReadRequests).toHaveLength(1);
      expect(restartedPersonalCodex.metadataReadRequests[0]?.providerThreadId)
        .toBe(providerThreadId);
      expect(value.store.listSessionAdoptionCandidates({
        provider: "codex",
        status: "claiming",
      })).toEqual([]);
      await restarted.close();
    },
  );

  test("persists a native Claude launch intent before admission and consumes it into exact custody", async () => {
    const managedClaude = new FakeClaude("isolated", {
      pid: 62_990,
      pidDomain: "darwin",
      procStart: "managed-claude-pre-admission",
    });
    const value = await fixture(new FakeCloud(),
      () => undefined,
      () => personalAdoptionNow,
      undefined,
      {},
      { managedClaude },
    );
    const added = await value.service.execute(
      { kind: "account.add", label: "Native Claude launch intent" },
      { signal },
    ) as { account: { id: `acct_${string}` } };
    await value.service.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: false,
    }, { signal });
    await value.service.execute({
      kind: "project.add",
      label: "Native Claude launch intent project",
      path: value.documents,
    }, { signal });
    let stagedProviderThreadId: string | undefined;
    let stagedSessionId: string | undefined;
    managedClaude.beforeStartSessionAdmission = (input) => {
      stagedProviderThreadId = input.providerThreadId;
      if (stagedProviderThreadId === undefined) {
        throw new Error("Expected a reserved Claude provider identity.");
      }
      const intent = value.store.readClaudeProcessLaunchIntent({
        providerThreadId: stagedProviderThreadId,
        profileId: added.account.id,
        runtimeScope: "managed",
      });
      if (intent?.sessionId === null || intent === null) {
        throw new Error("Expected a session-bound Claude launch intent.");
      }
      stagedSessionId = intent.sessionId;
      expect(intent.profileGeneration).toBe(
        value.store.requireProfileById(added.account.id).processGeneration,
      );
      expect(value.store.readClaudeProcessAuthority({
        providerThreadId: stagedProviderThreadId,
        profileId: added.account.id,
        runtimeScope: "managed",
      })).toBeNull();
    };

    const started = await value.service.execute({
      kind: "session.start",
      account: added.account.id,
      provider: "claude",
      preset: "fable-max",
      fast: false,
    }, { signal }) as { session: { id: `sess_${string}`; providerThreadId?: string } };
    if (stagedProviderThreadId === undefined || stagedSessionId === undefined) {
      throw new Error("Expected the pre-admission hook to observe launch authority.");
    }
    expect(started.session).toMatchObject({
      id: stagedSessionId,
      providerThreadId: stagedProviderThreadId,
    });
    expect(value.store.readClaudeProcessLaunchIntent({
      providerThreadId: stagedProviderThreadId,
      profileId: added.account.id,
      runtimeScope: "managed",
    })).toBeNull();
    expect(value.store.readClaudeProcessAuthority({
      providerThreadId: stagedProviderThreadId,
      profileId: added.account.id,
      runtimeScope: "managed",
    })).toMatchObject({
      identity: managedClaude.processIdentity,
      sessionId: started.session.id,
      state: "bound",
    });
    await value.service.close();
  });

  test("retains native Claude launch authority and suppresses replay when child exit is unproven", async () => {
    const managedClaude = new FakeClaude("isolated", {
      pid: 62_991,
      pidDomain: "darwin",
      procStart: "managed-claude-unproven-start",
    });
    const value = await fixture(new FakeCloud(),
      () => undefined,
      () => personalAdoptionNow,
      undefined,
      {},
      { managedClaude },
    );
    const added = await value.service.execute(
      { kind: "account.add", label: "Native Claude unproven launch" },
      { signal },
    ) as { account: { id: `acct_${string}` } };
    await value.service.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: false,
    }, { signal });
    await value.service.execute({
      kind: "project.add",
      label: "Native Claude unproven launch project",
      path: value.documents,
    }, { signal });
    managedClaude.startSessionError = new ClaudeProcessExitUnprovenError();
    const idempotencyKey = crypto.randomUUID();

    const failure = await value.service.execute({
      kind: "session.start",
      account: added.account.id,
      provider: "claude",
      preset: "fable-max",
      fast: false,
      idempotencyKey,
    }, { signal }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CommandFailure);
    expect((failure as CommandFailure).code).toBe("RECOVERY_REQUIRED");
    expect(managedClaude.startSessionRequests).toHaveLength(1);
    const providerThreadId = managedClaude.startSessionRequests[0]?.providerThreadId;
    if (providerThreadId === undefined) throw new Error("Expected a reserved Claude identity.");
    const intent = value.store.readClaudeProcessLaunchIntent({
      providerThreadId,
      profileId: added.account.id,
      runtimeScope: "managed",
    });
    if (intent?.sessionId === null || intent === null) {
      throw new Error("Expected retained session-bound launch authority.");
    }
    expect(value.store.requireSession(intent.sessionId).state).toBe("recovery_required");
    expect(value.store.readMutation(idempotencyKey)).toMatchObject({ state: "ambiguous" });
    expect(value.store.readClaudeProcessAuthority({
      providerThreadId,
      profileId: added.account.id,
      runtimeScope: "managed",
    })).toBeNull();

    const replay = await value.service.execute({
      kind: "session.start",
      account: added.account.id,
      provider: "claude",
      preset: "fable-max",
      fast: false,
      idempotencyKey,
    }, { signal }).catch((error: unknown) => error);
    expect(replay).toBeInstanceOf(CommandFailure);
    expect((replay as CommandFailure).code).toBe("RECOVERY_REQUIRED");
    expect(managedClaude.startSessionRequests).toHaveLength(1);
    await expectUnprovedLaunchCloseRefused(value);
  });

  test("retains adopted Claude launch authority and never reclaims after an unproven child exit", async () => {
    const managedClaude = new FakeClaude("isolated", {
      pid: 62_993,
      pidDomain: "darwin",
      procStart: "managed-claude-adoption-control",
    });
    const personalClaude = new FakeClaude("personal", {
      pid: 62_994,
      pidDomain: "darwin",
      procStart: "personal-claude-unproven-adoption",
    });
    personalClaude.claimSessionError = new ClaudeProcessExitUnprovenError();
    const discovery = new FakePersonalSessionDiscovery();
    let expectedCustodyRefusal = false;
    const value = await ownedServiceFixtureWithClose(
      (closing) => expectedCustodyRefusal
        ? expectUnprovedLaunchCloseRefused(closing)
        : closing.service.close(),
      new FakeCloud(),
      () => undefined,
      () => personalAdoptionNow,
      undefined,
      {},
      {
        managedClaude,
        personalClaude,
        personalCodexHome,
        personalDiscovery: discovery,
      },
    );
    const added = await value.execute(
      { kind: "account.add", label: "Adopted Claude unproven launch" },
    ) as { account: { id: `acct_${string}` } };
    await value.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: false,
    });
    await value.execute({
      kind: "project.add",
      label: "Adopted Claude unproven launch project",
      path: value.documents,
    });
    const providerThreadId = "personal-claude-unproven-adoption";
    discovery.candidates = [{
      provider: "claude",
      providerThreadId,
      title: "Personal Claude unproven adoption",
      projectRoot: value.documents,
      updatedAt: personalAdoptionNow - 1_000,
      liveness: "not_live",
    }];

    await expect(value.execute({
      kind: "session.adoption.set",
      provider: "claude",
      enabled: true,
      account: added.account.id,
    })).resolves.toMatchObject({
      discovery: { state: "ready", adopted: 0, failed: 1 },
      providers: [{ pending: 1 }],
    });
    expect(personalClaude.claimRequests).toHaveLength(1);
    expect(value.store.findSessionByProviderThread(added.account.id, providerThreadId))
      .toBeNull();
    expect(value.store.listSessionAdoptionCandidates({ provider: "claude" })[0])
      .toMatchObject({ providerThreadId, status: "claiming" });
    expect(value.store.readClaudeProcessLaunchIntent({
      providerThreadId,
      profileId: added.account.id,
      runtimeScope: "personal",
    })).toMatchObject({
      profileId: added.account.id,
      runtimeScope: "personal",
      sessionId: null,
    });
    expect(value.store.readClaudeProcessAuthority({
      providerThreadId,
      profileId: added.account.id,
      runtimeScope: "personal",
    })).toBeNull();

    await expect(value.execute({
      kind: "session.adoption.discover",
      provider: "claude",
    })).resolves.toMatchObject({
      providers: [{ adopted: 0, pending: 1 }],
    });
    expect(personalClaude.claimRequests).toHaveLength(1);
    expect(value.store.readClaudeProcessLaunchIntent({
      providerThreadId,
      profileId: added.account.id,
      runtimeScope: "personal",
    })).not.toBeNull();
    expectedCustodyRefusal = true;
    await expectUnprovedLaunchCloseRefused(value);
  }, claudeAuthorityFixtureTimeoutMs);

  for (const source of ["managed", "personal"] as const) {
    test(`resumes legacy ${source} Claude authority without adding host capabilities`, async () => {
      const value = source === "managed"
        ? await nativeClaudeFixture("Legacy native tools", "legacy-native-tools", {
            pid: 62_995,
            pidDomain: "darwin",
            procStart: "legacy-native-tools",
          }, undefined, true, ownedServiceFixture)
        : await adoptedClaudeFixture("Legacy personal tools", "legacy-personal-tools");
      const execute = "execute" in value
        ? value.execute
        : (command: LocalCommand) => value.service.execute(command, { signal });
      const runtime = "personalClaude" in value ? value.personalClaude : value.managedClaude;
      const activationCount = runtime.hostToolActivationRequests.length;
      const readBinding = value.store.readSessionHostCapabilityBinding.bind(value.store);
      // Model the exact legacy authority read. The adapter regression separately
      // proves disabled claims launch no preamble, MCP config, or tool lease.
      value.store.readSessionHostCapabilityBinding = (sessionId) =>
        sessionId === value.session.id ? null : readBinding(sessionId);
      runtime.disconnectOnObserveRequest = runtime.observeRequests.length + 1;
      await execute({
        kind: "session.send",
        session: value.session.id,
        message: "Continue this existing conversation without new capabilities.",
      });
      expect(runtime.claimRequests.at(-1)).toMatchObject({ hostTools: "disabled" });
      expect(runtime.hostToolActivationRequests).toHaveLength(activationCount);
      expect(runtime.turnRequests.at(-1)?.message)
        .toBe("Continue this existing conversation without new capabilities.");
      expect(value.store.readSessionHostCapabilityBinding(value.session.id)).toBeNull();
    }, source === "managed" ? claudeAuthorityFixtureTimeoutMs : 5_000);
  }

  test("quarantines Claude resume when the replacement child exit is unproven", async () => {
    const value = await nativeClaudeFixture(
      "Native Claude unproven resume",
      "native-claude-unproven-resume",
      {
        pid: 62_992,
        pidDomain: "darwin",
        procStart: "managed-claude-unproven-resume",
      },
    );
    const failedObservation = value.managedClaude.observeRequests.length + 1;
    value.managedClaude.disconnectOnObserveRequest = failedObservation;
    value.managedClaude.claimSessionError = new ClaudeProcessExitUnprovenError();

    const failure = await value.service.execute({
      kind: "session.status",
      session: value.session.id,
    }, { signal }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CommandFailure);
    expect((failure as CommandFailure).code).toBe("RECOVERY_REQUIRED");
    expect(value.managedClaude.claimRequests).toHaveLength(1);
    expect(value.store.requireSession(value.session.id).state).toBe("recovery_required");
    expect(value.store.readClaudeProcessLaunchIntent({
      providerThreadId: value.providerThreadId,
      profileId: value.accountId,
      runtimeScope: "managed",
    })).toMatchObject({
      sessionId: value.session.id,
    });
    expect(value.store.readClaudeProcessAuthority({
      providerThreadId: value.providerThreadId,
      profileId: value.accountId,
      runtimeScope: "managed",
    })?.state).toBe("released");

    await expect(value.service.execute({
      kind: "session.status",
      session: value.session.id,
    }, { signal })).resolves.toMatchObject({
      providerObservation: { state: "recovery_required" },
    });
    expect(value.managedClaude.claimRequests).toHaveLength(1);
    await expectUnprovedLaunchCloseRefused(value);
  });

  test("retires an exact Claude resume launch intent after an ordinary pre-admission claim failure", async () => {
    const value = await nativeClaudeFixture(
      "Native Claude rejected resume",
      "native-claude-rejected-resume",
      {
        pid: 62_995,
        pidDomain: "darwin",
        procStart: "managed-claude-rejected-resume",
      },
    );
    const claimFailure = new Error("replacement claim rejected before process admission");
    value.managedClaude.disconnectOnObserveRequest = value.managedClaude.observeRequests.length + 1;
    value.managedClaude.claimSessionError = claimFailure;

    const failure = await value.service.execute({
      kind: "session.status",
      session: value.session.id,
    }, { signal }).catch((error: unknown) => error);

    expect(failure).toBe(claimFailure);
    expect(value.managedClaude.claimRequests).toHaveLength(1);
    expect(value.store.readClaudeProcessLaunchIntent({
      providerThreadId: value.providerThreadId,
      profileId: value.accountId,
      runtimeScope: "managed",
    })).toBeNull();
    expect(value.store.readClaudeProcessAuthority({
      providerThreadId: value.providerThreadId,
      profileId: value.accountId,
      runtimeScope: "managed",
    })?.state).toBe("released");
    expect(value.store.requireSession(value.session.id).state).toBe("idle");
    await value.service.close();
  });

  test("quarantines an exact Claude resume when its ordinary-failure launch intent cannot be retired", async () => {
    const value = await nativeClaudeFixture(
      "Native Claude conflicted resume cleanup",
      "native-claude-conflicted-resume-cleanup",
      {
        pid: 62_996,
        pidDomain: "darwin",
        procStart: "managed-claude-conflicted-resume-cleanup",
      },
    );
    const claimFailure = new Error("replacement claim rejected before process admission");
    let replacementIntentId: string | undefined;
    value.managedClaude.disconnectOnObserveRequest = value.managedClaude.observeRequests.length + 1;
    value.managedClaude.beforeClaimSessionAdmission = () => {
      const original = value.store.readClaudeProcessLaunchIntent({
        providerThreadId: value.providerThreadId,
        profileId: value.accountId,
        runtimeScope: "managed",
      });
      if (original === null || original.providerAccountKey === null) {
        throw new Error("Expected the account-bound exact Claude resume launch intent.");
      }
      value.store.cancelClaudeProcessLaunchIntent({
        providerThreadId: original.providerThreadId,
        profileId: original.profileId,
        profileGeneration: original.profileGeneration,
        runtimeScope: original.runtimeScope,
        intentId: original.intentId,
        expectedRevision: original.revision,
      });
      replacementIntentId = value.store.stageClaudeProcessLaunchIntent({
        providerAuthority: value.store.requireProviderAccountAuthority(value.accountId, "claude"),
        providerThreadId: original.providerThreadId,
        profileId: original.profileId,
        profileGeneration: original.profileGeneration,
        runtimeScope: original.runtimeScope,
        providerAccountKey: original.providerAccountKey,
        sessionId: value.session.id,
      }).intentId;
    };
    value.managedClaude.claimSessionError = claimFailure;

    const failure = await value.service.execute({
      kind: "session.status",
      session: value.session.id,
    }, { signal }).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      name: "IndeterminateLocalCommitError",
      message: "Claude rejected exact-process resume, but its launch intent could not be retired.",
    });
    expect(value.store.requireSession(value.session.id).state).toBe("recovery_required");
    expect(value.store.readClaudeProcessLaunchIntent({
      providerThreadId: value.providerThreadId,
      profileId: value.accountId,
      runtimeScope: "managed",
    })?.intentId).toBe(replacementIntentId);
    expect(value.store.readClaudeProcessAuthority({
      providerThreadId: value.providerThreadId,
      profileId: value.accountId,
      runtimeScope: "managed",
    })?.state).toBe("released");
    await expectUnprovedLaunchCloseRefused(value);
  });

  test("keeps native Claude config-home provenance private across start, show, and send", async () => {
    const managedClaude = new FakeClaude("isolated", {
      pid: 63_000,
      pidDomain: "darwin",
      procStart: "managed-claude-public-profile",
    });
    const value = await fixture(new FakeCloud(),
      () => undefined,
      () => personalAdoptionNow,
      undefined,
      {},
      { managedClaude },
    );
    const added = await value.service.execute(
      { kind: "account.add", label: "Native Claude profile" },
      { signal },
    ) as { account: { id: `acct_${string}` } };
    await value.service.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: false,
    }, { signal });
    await value.service.execute({
      kind: "project.add",
      label: "Native Claude project",
      path: value.documents,
    }, { signal });

    const started = await value.service.execute({
      kind: "session.start",
      account: added.account.id,
      provider: "claude",
      preset: "fable-max",
      fast: false,
    }, { signal }) as {
      effectiveRuntimeProfile: Record<string, unknown>;
      session: { id: `sess_${string}` };
    };
    expect(started.effectiveRuntimeProfile).not.toHaveProperty("configHome");
    expect(started.effectiveRuntimeProfile).not.toHaveProperty("isolatedConfigDir");
    expect(value.store.latestSessionRuntimeProfile(started.session.id))
      .toMatchObject({ profile: { configHome: "isolated" } });

    const shown = await value.service.execute({
      kind: "session.show",
      session: started.session.id,
      detail: false,
    }, { signal }) as {
      effectiveRuntimeProfile: Record<string, unknown>;
    };
    expect(shown.effectiveRuntimeProfile).not.toHaveProperty("configHome");
    expect(shown.effectiveRuntimeProfile).not.toHaveProperty("isolatedConfigDir");

    const sent = await value.service.execute({
      kind: "session.send",
      session: started.session.id,
      message: "Continue native Claude work",
    }, { signal }) as {
      effectiveRuntimeProfile: Record<string, unknown>;
      turnId: string;
    };
    expect(sent.effectiveRuntimeProfile).not.toHaveProperty("configHome");
    expect(sent.effectiveRuntimeProfile).not.toHaveProperty("isolatedConfigDir");
    expect(value.store.runtimeProfileForTurn(started.session.id, sent.turnId))
      .toMatchObject({ configHome: "isolated" });
    await value.service.close();
  });

  test.each(["current", "legacy"] as const)(
    "keeps a stored %s Claude config-home private when managed control is platform-unavailable",
    async (profileShape) => {
      const value = await fixture(new FakeCloud(),
        () => undefined,
        () => personalAdoptionNow,
        undefined,
        {},
        "darwin",
      );
      const added = await value.service.execute(
        { kind: "account.add", label: `Darwin ${profileShape} Claude profile` },
        { signal },
      ) as { account: { id: `acct_${string}` } };
      const profile = value.store.requireProfileById(added.account.id);
      const session = value.store.upsertProviderSession({
      providerAuthority: value.store.requireProviderAccountAuthority(profile.id, "claude"),
        profileId: profile.id,
        provider: "claude",
        providerThreadId: `darwin-${profileShape}-claude-profile`,
        title: `Darwin ${profileShape} Claude profile`,
        preset: "fable-max",
        fastEnabled: false,
        state: "idle",
        providerAccountKey: claudeProviderAccountKey(),
      });
      const authority = liveAuthorityFor(value.store, profile.id, "claude");
      const currentProfile = claudeRuntimeProfile(authority, "isolated");
      const storedProfile: EffectiveClaudeRuntimeProfile = profileShape === "current"
        ? currentProfile
        : {
            profileId: currentProfile.profileId,
            processGeneration: currentProfile.processGeneration,
            observedAt: currentProfile.observedAt,
            preset: currentProfile.preset,
            model: currentProfile.model,
            reasoningEffort: currentProfile.reasoningEffort,
            claudeVersion: currentProfile.claudeVersion,
            permissionMode: currentProfile.permissionMode,
            isolatedConfigDir: true,
            outputFormat: currentProfile.outputFormat,
            inputFormat: currentProfile.inputFormat,
          };
      value.store.recordSessionRuntimeProfile({
        providerAuthority: value.store.requireProviderAccountAuthority(session.profileId, "claude"),
        sessionId: session.id,
        sourceKind: "session_start",
        sourceId: `darwin-${profileShape}-stored-profile`,
        profile: storedProfile,
      });

      const shown = await value.service.execute({
        kind: "session.show",
        session: session.id,
        detail: false,
      }, { signal }) as {
        effectiveRuntimeProfile: Record<string, unknown>;
        providerObservation: { state: string };
      };

      expect(value.store.latestSessionRuntimeProfile(session.id)?.profile)
        .toHaveProperty(profileShape === "current" ? "configHome" : "isolatedConfigDir");
      expect(shown.providerObservation.state).toBe("unavailable");
      expect(shown.effectiveRuntimeProfile).not.toHaveProperty("configHome");
      expect(shown.effectiveRuntimeProfile).not.toHaveProperty("isolatedConfigDir");
      await value.service.close();
    },
  );

  test("releases and resumes a native Claude child lost at its first post-commit observation", async () => {
    const initialIdentity: ClaudeProcessIdentity = {
      pid: 63_010,
      pidDomain: "darwin",
      procStart: "native-claude-observation-gap-initial",
    };
    const replacementIdentity: ClaudeProcessIdentity = {
      pid: 63_011,
      pidDomain: "darwin",
      procStart: "native-claude-observation-gap-replacement",
    };
    const replacementConnectionId = "30000000-0000-4000-8000-0000000000c2";
    const managedClaude = new FakeClaude("isolated", initialIdentity);
    managedClaude.disconnectOnObserveRequest = 1;
    managedClaude.processIdentityOnClaim = replacementIdentity;
    managedClaude.observationConnectionIdOnClaim = replacementConnectionId;
    const value = await fixture(new FakeCloud(),
      () => undefined,
      () => personalAdoptionNow,
      undefined,
      {},
      { managedClaude },
    );
    const added = await value.service.execute(
      { kind: "account.add", label: "Native Claude observation gap" },
      { signal },
    ) as { account: { id: `acct_${string}` } };
    await value.service.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: false,
    }, { signal });
    await value.service.execute({
      kind: "project.add",
      label: "Native Claude observation gap project",
      path: value.documents,
    }, { signal });
    managedClaude.projection = {
      providerThreadId: "native-claude-observation-gap",
      title: "Native Claude observation gap",
      status: "idle",
      projectRoot: value.documents,
      providerUpdatedAt: personalAdoptionNow - 1_000,
    };

    const started = await value.service.execute({
      kind: "session.start",
      account: added.account.id,
      provider: "claude",
      preset: "fable-max",
      fast: false,
    }, { signal }) as { session: { id: `sess_${string}`; providerThreadId?: string } };

    const providerThreadId = started.session.providerThreadId;
    if (providerThreadId === undefined) throw new Error("Expected a bound native Claude session.");
    expect(providerThreadId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(managedClaude.endRequests).toHaveLength(1);
    expect(managedClaude.endRequests[0]?.providerThreadId)
      .toBe(providerThreadId);
    expect(managedClaude.endedProcessIdentities).toEqual([initialIdentity]);
    expect(managedClaude.claimRequests).toHaveLength(1);
    expect(managedClaude.claimRequests[0]).toMatchObject({
      providerThreadId,
      preset: "fable-max",
      requirement: presetRequirements["fable-max"],
      sourceLiveness: "not_live",
      title: "Untitled session",
    });
    expect(value.store.readClaudeProcessAuthority({
      providerThreadId,
      profileId: added.account.id,
      runtimeScope: "managed",
    })).toMatchObject({
      identity: replacementIdentity,
      sessionId: started.session.id,
      state: "bound",
    });
    await expect(value.service.execute({
      kind: "session.status",
      session: started.session.id,
    }, { signal })).resolves.toMatchObject({
      providerObservation: {
        connectionId: replacementConnectionId,
        state: "live",
      },
    });
    expect(managedClaude.endRequests).toHaveLength(1);
    expect(managedClaude.claimRequests).toHaveLength(1);
    await value.service.close();
  });

  test("releases a resumed native Claude child whose claimed profile violates the durable preset", async () => {
    const initialIdentity: ClaudeProcessIdentity = {
      pid: 63_014,
      pidDomain: "darwin",
      procStart: "native-claude-profile-mismatch-initial",
    };
    const replacementIdentity: ClaudeProcessIdentity = {
      pid: 63_015,
      pidDomain: "darwin",
      procStart: "native-claude-profile-mismatch-replacement",
    };
    const managedClaude = new FakeClaude("isolated", initialIdentity);
    managedClaude.disconnectOnObserveRequest = 1;
    managedClaude.processIdentityOnClaim = replacementIdentity;
    managedClaude.claimRuntimeProfileOverride = (authority) => ({
      ...claudeRuntimeProfile(authority, "isolated"),
      model: "claude-other-model",
    });
    const value = await fixture(new FakeCloud(),
      () => undefined,
      () => personalAdoptionNow,
      undefined,
      {},
      { managedClaude },
    );
    const added = await value.service.execute(
      { kind: "account.add", label: "Native Claude profile mismatch" },
      { signal },
    ) as { account: { id: `acct_${string}` } };
    await value.service.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: false,
    }, { signal });
    await value.service.execute({
      kind: "project.add",
      label: "Native Claude profile mismatch project",
      path: value.documents,
    }, { signal });
    managedClaude.projection = {
      providerThreadId: "native-claude-profile-mismatch",
      title: "Native Claude profile mismatch",
      status: "idle",
      projectRoot: value.documents,
      providerUpdatedAt: personalAdoptionNow - 1_000,
    };

    await expect(value.service.execute({
      kind: "session.start",
      account: added.account.id,
      provider: "claude",
      preset: "fable-max",
      fast: false,
    }, { signal })).rejects.toThrow("SESSION_CLAIM_RUNTIME_PROFILE_MISMATCH");

    const providerThreadId = managedClaude.claimRequests[0]?.providerThreadId;
    if (providerThreadId === undefined) throw new Error("Expected a replacement Claude claim.");
    expect(managedClaude.endRequests).toHaveLength(2);
    expect(managedClaude.endedProcessIdentities).toEqual([
      initialIdentity,
      replacementIdentity,
    ]);
    expect(value.store.readClaudeProcessAuthority({
      providerThreadId,
      profileId: added.account.id,
      runtimeScope: "managed",
    })).toMatchObject({
      identity: replacementIdentity,
      state: "released",
    });
    expect(value.store.readClaudeProcessLaunchIntent({
      providerThreadId,
      profileId: added.account.id,
      runtimeScope: "managed",
    })).toBeNull();
    await value.service.close();
  });

  test("retains an adopted Claude replacement when its old disconnect arrives before connection remapping", async () => {
    const value = await adoptedClaudeFixture(
      "Adopted Claude delayed disconnect",
      "personal-claude-delayed-disconnect",
    );
    await value.service.settled();
    const initialIdentity = value.personalClaude.processIdentity;
    const replacementIdentity: ClaudeProcessIdentity = {
      pid: 63_013,
      pidDomain: "darwin",
      procStart: "personal-claude-delayed-disconnect-replacement",
    };
    const initialConnectionId = value.personalClaude.observationConnectionId;
    const replacementConnectionId = "30000000-0000-4000-8000-0000000000c4";

    let markReplacementObservationStarted!: () => void;
    const replacementObservationStarted = new Promise<void>((resolve) => {
      markReplacementObservationStarted = resolve;
    });
    let releaseReplacementObservation!: () => void;
    const replacementObservationPause = new Promise<void>((resolve) => {
      releaseReplacementObservation = resolve;
    });
    const claimsBeforeRecovery = value.personalClaude.claimRequests.length;
    const failedObservationRequest = value.personalClaude.observeRequests.length + 1;
    value.personalClaude.disconnectOnObserveRequest = failedObservationRequest;
    value.personalClaude.processIdentityOnClaim = replacementIdentity;
    value.personalClaude.observationConnectionIdOnClaim = replacementConnectionId;
    value.personalClaude.pauseOnObserveRequest = failedObservationRequest + 1;
    value.personalClaude.observePauseStarted = markReplacementObservationStarted;
    value.personalClaude.observePause = replacementObservationPause;

    const foregroundRecovery = value.service.execute({
      kind: "session.status",
      session: value.session.id,
    }, { signal });
    await replacementObservationStarted;
    expect(value.store.readClaudeProcessAuthority({
      providerThreadId: "personal-claude-delayed-disconnect",
      profileId: value.accountId,
      runtimeScope: "personal",
    })).toMatchObject({
      identity: replacementIdentity,
      sessionId: value.session.id,
      state: "bound",
    });
    expect(value.personalClaude.claimRequests).toHaveLength(claimsBeforeRecovery + 1);
    const replacementAuthority = value.personalClaude.claimRequests.at(-1)?.authority;
    if (replacementAuthority === undefined) {
      throw new Error("Expected the replacement Claude claim authority.");
    }
    await value.service.observePersonalClaudeFact(replacementAuthority, {
      type: "providerDisconnected",
      connectionId: initialConnectionId,
      providerThreadId: "personal-claude-delayed-disconnect",
      reason: "process_exit",
    });
    expect(value.personalClaude.endRequests).toHaveLength(1);

    releaseReplacementObservation();
    await expect(foregroundRecovery).resolves.toMatchObject({
      providerObservation: {
        connectionId: replacementConnectionId,
        state: "live",
      },
    });
    await value.service.settled();
    expect(value.personalClaude.observeRequests)
      .toHaveLength(failedObservationRequest + 2);
    expect(value.personalClaude.endRequests).toHaveLength(1);
    expect(value.personalClaude.endedProcessIdentities).toEqual([initialIdentity]);
    expect(value.personalClaude.claimRequests).toHaveLength(claimsBeforeRecovery + 1);
    expect(value.store.readClaudeProcessAuthority({
      providerThreadId: "personal-claude-delayed-disconnect",
      profileId: value.accountId,
      runtimeScope: "personal",
    })).toMatchObject({
      identity: replacementIdentity,
      sessionId: value.session.id,
      state: "bound",
    });
    expect(value.store.readSessionPersonalRuntimeBinding(value.session.id))
      .toMatchObject({ state: "active" });

    await expect(value.service.execute({
      kind: "session.status",
      session: value.session.id,
    }, { signal })).resolves.toMatchObject({
      providerObservation: {
        connectionId: replacementConnectionId,
        state: "live",
      },
    });

    await expect(value.service.execute({
      kind: "session.send",
      session: value.session.id,
      message: "Continue on the replacement controller",
      idempotencyKey: "00000000-0000-4000-8000-00000000c004",
    }, { signal })).resolves.toMatchObject({
      session: { id: value.session.id, state: "idle" },
    });
    expect(value.personalClaude.turnRequests).toHaveLength(1);
    expect(value.managedClaude.turnRequests).toHaveLength(0);
    await value.service.close();
  });

  test("holds account authority across a personal Codex adoption claim and managed disconnect", async () => {
    const personalCodex = new FakeCodex();
    const discovery = new FakePersonalSessionDiscovery();
    const value = await fixture(new FakeCloud(),
      () => undefined,
      () => personalAdoptionNow,
      undefined,
      {},
      { personalCodex, personalCodexHome, personalDiscovery: discovery },
    );
    const added = await value.service.execute(
      { kind: "account.add", label: "Codex adoption account lock" },
      { signal },
    ) as { account: { id: `acct_${string}` } };
    await value.service.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: false,
    }, { signal });
    await value.service.execute({
      kind: "project.add",
      label: "Codex adoption account lock project",
      path: value.documents,
    }, { signal });

    const providerThreadId = "personal-thread-account-lock";
    personalCodex.readProjection = {
      providerThreadId,
      title: "Personal thread protected by the account lock",
      status: "idle",
      projectRoot: value.documents,
      providerUpdatedAt: personalAdoptionNow - 11 * 60_000,
    };
    discovery.candidates = [{
      provider: "codex",
      providerThreadId,
      title: "Personal thread protected by the account lock",
      projectRoot: value.documents,
      updatedAt: personalAdoptionNow - 11 * 60_000,
      liveness: "not_live",
    }];

    let markClaimStarted!: () => void;
    let releaseClaim!: () => void;
    const claimStarted = new Promise<void>((resolve) => {
      markClaimStarted = resolve;
    });
    const claimGate = new Promise<void>((resolve) => {
      releaseClaim = resolve;
    });
    personalCodex.beforeClaimSessionReturnOnce = async () => {
      markClaimStarted();
      await claimGate;
    };

    const adoption = value.service.execute({
      kind: "session.adoption.set",
      provider: "codex",
      enabled: true,
      account: added.account.id,
    }, { signal });
    await claimStarted;
    const authority = personalCodex.claimRequests[0]?.authority;
    if (authority === undefined) throw new Error("Expected a paused personal Codex claim.");
    const generationDuringClaim = value.store
      .requireProfileById(added.account.id).processGeneration;
    expect(authority.generation).toBe(generationDuringClaim);
    expect(value.store.listSessionAdoptionCandidates({ provider: "codex" })[0])
      .toMatchObject({ providerThreadId, status: "claiming" });

    await value.service.observeCodexFact(authority, {
      type: "providerDisconnected",
      connectionId: value.codex.observationConnectionId,
      reason: "process_exit",
    });
    const generationAfterDisconnectDuringClaim = value.store
      .requireProfileById(added.account.id).processGeneration;
    releaseClaim();
    const adoptionResult = await adoption;
    await value.service.settled();

    expect(generationAfterDisconnectDuringClaim).toBe(generationDuringClaim);
    expect(adoptionResult).toMatchObject({
      discovery: { provider: "codex", state: "ready", adopted: 1, failed: 0 },
    });

    expect(value.store.requireProfileById(added.account.id).processGeneration)
      .toBe(generationDuringClaim);
    expect(value.store.listSessionAdoptionCandidates({ provider: "codex" })[0])
      .toMatchObject({ providerThreadId, status: "adopted" });
    const session = value.store.findSessionByProviderThread(added.account.id, providerThreadId);
    if (session === null) throw new Error("Expected the claimed Codex thread to stay adopted.");
    expect(session).toMatchObject({
      profileId: added.account.id,
      provider: "codex",
      providerThreadId,
      state: "idle",
    });
    expect(session.archivedAt).toBeUndefined();
    expect(value.store.readSessionPersonalRuntimeBinding(session.id)).toMatchObject({
      provider: "codex",
      providerThreadId,
      state: "active",
    });
    expect(personalCodex.calls.filter((call) => call === "end")).toHaveLength(0);
  });

  test("starts a causally fresh account read when a post-claim fence overlaps an older check", async () => {
    const value = await adoptedCodexFixture(
      "Fresh post-claim identity",
      "personal-thread-before-fresh-post-claim",
    );
    const providerThreadId = "personal-thread-fresh-post-claim";
    value.personalCodex.readProjection = {
      providerThreadId,
      title: "Fresh post-claim personal thread",
      status: "idle",
      projectRoot: value.documents,
      providerUpdatedAt: personalAdoptionNow - 11 * 60_000,
    };
    value.discovery.candidates = [{
      provider: "codex",
      providerThreadId,
      title: "Fresh post-claim personal thread",
      projectRoot: value.documents,
      updatedAt: personalAdoptionNow - 11 * 60_000,
      liveness: "not_live",
    }];
    const seeded = await seedResolvableInteraction(
      value,
      value.session.id,
      "fresh-post-claim-overlap",
      undefined,
      "personal",
    );

    let releaseClaim!: () => void;
    let claimReturned!: () => void;
    const claimGate = new Promise<void>((resolve) => {
      releaseClaim = resolve;
    });
    const claimApplied = new Promise<void>((resolve) => {
      claimReturned = resolve;
    });
    value.personalCodex.beforeClaimSessionReturnOnce = async () => {
      claimReturned();
      await claimGate;
    };
    value.personalCodex.validateInteractionResolutionError = new CodexError(
      "UNSUPPORTED_CAPABILITY",
      "Stop after the account precheck.",
    );
    // Admit an older account read before discovery takes the account tail.
    // Once it finishes, discovery must perform its own pre-claim read and a
    // distinct causally fresh post-claim read rather than reusing either one.
    let releaseOlderRead!: () => void;
    let olderReadStarted!: () => void;
    const olderReadGate = new Promise<void>((resolve) => {
      releaseOlderRead = resolve;
    });
    const olderReadAdmitted = new Promise<void>((resolve) => {
      olderReadStarted = resolve;
    });
    value.personalCodex.beforeReadAccountReturn = async () => {
      delete value.personalCodex.beforeReadAccountReturn;
      olderReadStarted();
      await olderReadGate;
    };
    const resolving = value.service.execute({
      kind: "interaction.resolve",
      interaction: seeded.interaction.publicId,
      expectedRevision: seeded.interaction.revision,
      resolution: { kind: "approval_decision", decision: "once" },
    }, { signal });
    await olderReadAdmitted;
    const claimsBeforeDiscovery = value.personalCodex.claimRequests.length;
    const discovery = value.service.discoverPersonalSessions("codex", signal);
    await Bun.sleep(0);
    expect(value.personalCodex.claimRequests).toHaveLength(claimsBeforeDiscovery);
    releaseOlderRead();
    await expect(resolving).rejects.toMatchObject({ code: "CONFLICT" });
    const admission = await Promise.race([
      claimApplied.then(() => ({ kind: "claim" as const })),
      discovery.then(
        (result) => ({ kind: "settled" as const, result }),
        (error: unknown) => ({ error, kind: "failed" as const }),
      ),
    ]);
    if (admission.kind !== "claim") {
      throw new Error("Expected personal Codex discovery to pause inside the claim.", {
        cause: admission.kind === "failed" ? admission.error : admission.result,
      });
    }
    const claimAuthority = value.personalCodex.claimRequests.at(-1)?.authority;
    if (claimAuthority === undefined) throw new Error("Expected a paused personal Codex claim.");
    expect(claimAuthority).toMatchObject({
      id: seeded.authority.id,
      generation: seeded.authority.generation,
    });
    const readsBeforeSwap = value.personalCodex.calls
      .filter((call) => call === "readAccount").length;

    value.personalCodex.accountProjection = {
      signedIn: true,
      email: "replacement@example.com",
      plan: "Plus",
    };
    releaseClaim();
    await expect(discovery).resolves.toMatchObject({
      providers: [{
        adopted: 0,
        failed: 1,
        provider: "codex",
        state: "ready",
      }],
    });
    expect(value.personalCodex.calls.filter((call) => call === "readAccount").length)
      .toBeGreaterThan(readsBeforeSwap);
    expect(value.store.findSessionByProviderThread(value.accountId, providerThreadId))
      .toBeNull();
    expect(value.store.readSessionAdoptionPolicy("codex")).toMatchObject({
      enabled: false,
      profileId: null,
    });
    await value.service.settled();
  });

  test("completes personal Codex account revocation after the observer already retired its generation", async () => {
    const value = await adoptedCodexFixture(
      "Retired personal Codex account authority",
      "personal-thread-retired-account-authority",
    );
    const authority = value.personalCodex.claimRequests[0]?.authority;
    if (authority === undefined) throw new Error("Expected personal Codex claim authority.");
    const readsBeforeMismatch = value.personalCodex.calls
      .filter((call) => call === "readAccount").length;
    let releaseStarted!: () => void;
    const releaseAdmission = new Promise<void>((resolve) => {
      releaseStarted = resolve;
    });
    let finishRelease!: () => void;
    const releaseGate = new Promise<void>((resolve) => {
      finishRelease = resolve;
    });
    value.personalCodex.beforeReleaseOwnedAuthorityReturn = async () => {
      releaseStarted();
      await releaseGate;
    };

    // CodexRuntimeAdapter retires and removes the exact client before it
    // delivers the observer callback. Ordinary reads at this generation are
    // therefore impossible, while releaseOwnedAuthority can still await its
    // retained close task without launching anything.
    value.personalCodex.retireAuthority(authority);
    await expect(value.personalCodex.readAccount({ authority, signal }))
      .rejects.toThrow("AUTHORITY_STALE");

    const replacementB: CodexAccountProjection = {
      signedIn: true,
      email: "replacement-retired-b@example.com",
      plan: "Plus",
    };
    await expect(value.service.observePersonalCodexAccount(authority, replacementB))
      .rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    await releaseAdmission;

    const replacementC: CodexAccountProjection = {
      signedIn: true,
      email: "replacement-retired-c@example.com",
      plan: "Plus",
    };
    await expect(value.service.observePersonalCodexAccount(authority, replacementC))
      .rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    finishRelease();
    await value.service.settled();

    expect(value.personalCodex.calls.filter((call) => call === "readAccount"))
      .toHaveLength(readsBeforeMismatch + 1);
    expect(value.personalCodex.releasedAuthorities).toEqual([authority]);
    expect(value.store.readProviderRuntimeAccountRevocation({
      profileId: value.accountId,
      provider: "codex",
      runtimeScope: "personal",
    })).toMatchObject({
      currentAccountKey: codexProviderAccountKey("replacement-retired-c@example.com"),
      profileGeneration: authority.generation,
      state: "completed",
    });
    expect(value.store.readSessionPersonalRuntimeBinding(value.session.id, true))
      .toMatchObject({ state: "detached" });
    expect(value.store.requireSession(value.session.id).archivedAt).toBeUndefined();
    await expect(value.service.execute({
      kind: "session.adoption.status",
      provider: "codex",
    }, { signal })).resolves.toMatchObject({
      providers: [{ provider: "codex", restartRequired: true }],
    });
  });

  test("adopts an old exact target from a real paused Desktop heartbeat without projecting task metadata", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "oompa-scheduled-adoption-chain-")));
    serviceRoots.push(root);
    const codexHome = join(root, "codex-home");
    const automationsDirectory = join(codexHome, "automations");
    const sourceDirectoryName = "desktop-paused-heartbeat-source";
    const privateAutomationId = "desktop-private-task-identifier";
    const privateName = "Desktop private task name";
    const privatePrompt = "Desktop private task prompt";
    const privateCwd = join(root, "desktop-private-task-cwd");
    const privateRrule = "FREQ=DAILY;INTERVAL=17;BYHOUR=3";
    const providerThreadId = "scheduled-real-paused-heartbeat-thread";
    const automationPath = join(automationsDirectory, sourceDirectoryName, "automation.toml");
    const automationDocument = [
      `id = "${privateAutomationId}"`,
      'kind = "heartbeat"',
      `name = "${privateName}"`,
      `prompt = "${privatePrompt}"`,
      `cwds = ["${privateCwd}"]`,
      `rrule = "${privateRrule}"`,
      'status = "PAUSED"',
      `target_thread_id = "${providerThreadId}"`,
      "",
    ].join("\n");
    await mkdir(join(automationsDirectory, sourceDirectoryName), { recursive: true });
    await writeFile(automationPath, automationDocument);

    const personalCodex = new FakeCodex();
    const context: { personalAuthority?: ProfileAuthority } = {};
    const requirePersonalAuthority = (): ProfileAuthority => {
      if (context.personalAuthority === undefined) {
        throw new Error("Expected personal Codex discovery authority.");
      }
      return context.personalAuthority;
    };
    const discovery = new BoundedPersonalSessionDiscovery({
      now: () => personalAdoptionNow,
      codexListPage: ({ cursor, limit, signal: discoverySignal }) =>
        personalCodex.listSessions({
          authority: requirePersonalAuthority(),
          ...(cursor === undefined ? {} : { cursor }),
          limit,
          signal: discoverySignal,
        }),
      codexReadSession: ({ providerThreadId: exactThreadId, signal: discoverySignal }) =>
        personalCodex.readSessionMetadata(
          requirePersonalAuthority(),
          exactThreadId,
          discoverySignal,
        ),
    });
    const authorityRequests: CodexAutomationAuthorityRequest[] = [];
    const authorityScans: CodexAutomationAuthorityScan[] = [];
    const readPersonalCodexAutomations = async (
      request: CodexAutomationAuthorityRequest,
    ): Promise<CodexAutomationAuthorityScan> => {
      authorityRequests.push(request);
      const scan = await readCodexAutomationAuthority({
        ...request,
        automationsDirectory,
      });
      authorityScans.push(scan);
      return scan;
    };
    const value = await fixture(new FakeCloud(),
      () => undefined,
      () => personalAdoptionNow,
      undefined,
      {},
      {
        personalCodex,
        personalCodexHome: codexHome,
        personalDiscovery: discovery,
        readPersonalCodexAutomations,
      },
    );
    const projectRoot = value.documents;
    const added = await value.service.execute({
      kind: "account.add",
      label: "Real paused Desktop heartbeat",
    }, { signal }) as { account: { id: `acct_${string}` } };
    await value.service.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: false,
    }, { signal });
    await value.service.execute({
      kind: "project.add",
      label: "Real paused Desktop heartbeat project",
      path: projectRoot,
    }, { signal });
    const profile = value.store.requireProfileById(added.account.id);
    context.personalAuthority = {
      ...liveAuthorityFor(value.store, profile.id),
      codexHome,
      desktopUserData: profilePaths(value.paths, profile.id).desktopUserData,
    };
    personalCodex.readProjection = {
      providerThreadId,
      title: "Old exact Desktop heartbeat target",
      projectRoot,
      status: "idle",
      providerUpdatedAt: personalAdoptionNow - 24 * 60 * 60_000,
    };

    await expect(value.service.execute({
      kind: "session.adoption.set",
      provider: "codex",
      enabled: true,
      account: added.account.id,
    }, { signal })).resolves.toMatchObject({
      discovery: { provider: "codex", discovered: 1, adopted: 1, failed: 0 },
    });

    expect(personalCodex.sessionListRequests).toHaveLength(1);
    expect(personalCodex.listedProjections).toEqual([]);
    expect(personalCodex.metadataReadRequests).toEqual([{
      authority: context.personalAuthority,
      providerThreadId,
    }]);
    expect(authorityRequests.map((request) => request.kind)).toEqual([
      "page",
      "sources",
      "sources",
    ]);
    expect(authorityRequests.slice(1).map((request) =>
      request.kind === "sources" ? request.sourceDirectoryNames : [])).toEqual([
      [sourceDirectoryName],
      [sourceDirectoryName],
    ]);
    expect(authorityScans).toHaveLength(3);
    for (const scan of authorityScans) {
      expect(scan).toMatchObject({ complete: true, diagnostics: [], nextCursor: null });
      expect(scan.entries).toEqual([{
        automation: {
          kind: "heartbeat",
          status: "paused",
          targetThreadId: providerThreadId,
        },
        sourceDirectoryName,
      }]);
      expect(Object.keys(scan.entries[0]?.automation ?? {})).toEqual([
        "kind",
        "status",
        "targetThreadId",
      ]);
    }
    expect(personalCodex.claimRequests).toHaveLength(1);
    expect(personalCodex.claimRequests[0]).toMatchObject({
      authority: { codexHome },
      providerThreadId,
      projectRoot,
    });
    const session = value.store.findSessionByProviderThread(
      added.account.id,
      providerThreadId,
    );
    if (session === null || session.projectId === undefined) {
      throw new Error("Expected the real scheduled target to become a project-bound session.");
    }
    expect(value.store.isConversationAutomationEnabled(session.id, providerThreadId)).toBe(false);
    expect(value.store.createSessionTaskStore().list(session.id)).toEqual([]);
    expect(await readFile(automationPath, "utf8")).toBe(automationDocument);

    const listCommand = localCommandSchema.parse({
      kind: "session.list",
      archived: false,
      limit: 10,
    });
    const listed = await value.service.execute(listCommand, { signal });
    const rendered = JSON.parse(renderJson(listCommand, listed)) as { data: unknown };
    const publicPage = publicSessionListPageSchema.parse(rendered.data);
    expect(publicPage.sessions).toEqual([{
      id: session.id,
      profileId: session.profileId,
      projectId: session.projectId,
      title: session.title,
      state: session.state,
      provider: session.provider,
      preset: session.preset,
      fastEnabled: session.fastEnabled,
      revision: session.revision,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    }]);
    const publicJson = JSON.stringify(publicPage);
    for (const privateValue of [
      sourceDirectoryName,
      privateAutomationId,
      privateName,
      privatePrompt,
      privateCwd,
      privateRrule,
      providerThreadId,
    ]) {
      expect(publicJson).not.toContain(privateValue);
    }
    expect(publicJson).not.toContain("scheduledTaskTarget");
    expect(publicJson).not.toContain("sourceDirectoryName");
    expect(publicJson).not.toContain("automation");
  });

  test.each(["active", "paused"] as const)(
    "adopts a stale Codex thread targeted by a present %s heartbeat without exposing its source",
    async (status) => {
      const providerThreadId = `scheduled-${status}-heartbeat-thread`;
      let scanCalls = 0;
      const authorityRequests: CodexAutomationAuthorityRequest[] = [];
      const value = await preparedPersonalCodexCandidate({
        label: `Scheduled ${status} heartbeat`,
        providerThreadId,
        updatedAt: personalAdoptionNow - 24 * 60 * 60_000,
        liveness: "not_live",
        scheduledTaskTarget: true,
        readPersonalCodexAutomations: (request) => {
          scanCalls += 1;
          authorityRequests.push(request);
          return Promise.resolve(personalCodexAutomationScan([{
            status,
            targetThreadId: providerThreadId,
          }], request));
        },
      });

      await expect(value.enable()).resolves.toMatchObject({
        discovery: { provider: "codex", adopted: 1, failed: 0 },
      });
      expect(scanCalls).toBe(3);
      expect(authorityRequests.every((request) => request.signal === signal)).toBe(true);
      expect(authorityRequests.map((request) => request.deadlineAt)).toEqual([
        personalAdoptionNow + 5_000,
        personalAdoptionNow + 5_000,
        personalAdoptionNow + 5_000,
      ]);
      expect(value.discovery.requests).toHaveLength(1);
      expect(value.discovery.requests[0]?.codexScheduledThreadIds).toEqual([
        providerThreadId,
      ]);
      expect(value.personalCodex.claimRequests).toHaveLength(1);
      const session = value.store.findSessionByProviderThread(
        value.accountId,
        providerThreadId,
      );
      if (session === null) throw new Error("Expected the scheduled target to be adopted.");
      const listed = await value.service.execute({
        kind: "session.list",
        archived: false,
        account: value.accountId,
        limit: 10,
      }, { signal }) as { sessions: readonly Record<string, unknown>[] };
      const publicSession = listed.sessions.find((candidate) => candidate.id === session.id);
      expect(publicSession).toBeDefined();
      expect(publicSession).not.toHaveProperty("scheduledTaskTarget");
      expect(publicSession).not.toHaveProperty("automation");
    },
  );

  test("reasserts daemon authority after an exact scheduled-target read", async () => {
    const providerThreadId = "scheduled-authority-reassertion";
    let authorityReads = 0;
    const context: {
      value?: Awaited<ReturnType<typeof preparedPersonalCodexCandidate>>;
    } = {};
    const value = await preparedPersonalCodexCandidate({
      label: "Scheduled authority reassertion",
      providerThreadId,
      updatedAt: personalAdoptionNow - 24 * 60 * 60_000,
      liveness: "not_live",
      scheduledTaskTarget: true,
      readPersonalCodexAutomations: (request) => {
        authorityReads += 1;
        if (authorityReads === 2) context.value?.daemonAuthority.invalidate();
        return Promise.resolve(personalCodexAutomationScan([{
          targetThreadId: providerThreadId,
        }], request));
      },
    });
    context.value = value;

    await expect(value.enable()).rejects.toBeInstanceOf(DaemonAuthoritySafetyError);
    expect(authorityReads).toBe(2);
    expect(value.personalCodex.claimRequests).toHaveLength(0);
    expect(value.store.readSessionAdoptionCandidate("codex", providerThreadId))
      .toMatchObject({ status: "pending" });
  });

  test("reasserts daemon authority after the final scheduled-target read before commit", async () => {
    const providerThreadId = "scheduled-final-authority-reassertion";
    let authorityReads = 0;
    const context: {
      value?: Awaited<ReturnType<typeof preparedPersonalCodexCandidate>>;
    } = {};
    const value = await preparedPersonalCodexCandidate({
      label: "Scheduled final authority reassertion",
      providerThreadId,
      updatedAt: personalAdoptionNow - 24 * 60 * 60_000,
      liveness: "not_live",
      scheduledTaskTarget: true,
      readPersonalCodexAutomations: (request) => {
        authorityReads += 1;
        if (authorityReads === 3) context.value?.daemonAuthority.invalidate();
        return Promise.resolve(personalCodexAutomationScan([{
          targetThreadId: providerThreadId,
        }], request));
      },
    });
    context.value = value;

    await expect(value.enable()).rejects.toBeInstanceOf(DaemonAuthoritySafetyError);
    expect(authorityReads).toBe(3);
    expect(value.personalCodex.claimRequests).toHaveLength(1);
    expect(value.personalCodex.calls.filter((call) => call === "end")).toHaveLength(1);
    expect(value.store.findSessionByProviderThread(value.accountId, providerThreadId)).toBeNull();
  });

  test("rotates bounded scheduled-target batches so a nonclaimable prefix cannot starve later threads", async () => {
    const providerThreadIds = Array.from(
      { length: 60 },
      (_, index) => `scheduled-rotation-${String(index).padStart(3, "0")}`,
    );
    const laterProviderThreadId = providerThreadIds[55];
    if (laterProviderThreadId === undefined) throw new Error("Expected a later target id.");
    let projectRoot = privatePathRoot;
    const discoveryRequests: Array<
      Parameters<PersonalSessionDiscoveryPort["discover"]>[0]
    > = [];
    const discovery: PersonalSessionDiscoveryPort = {
      discover: (input) => {
        discoveryRequests.push(input);
        return Promise.resolve((input.codexScheduledThreadIds ?? []).map((providerThreadId) => ({
          provider: "codex" as const,
          providerThreadId,
          title: `Scheduled ${providerThreadId}`,
          projectRoot,
          updatedAt: personalAdoptionNow - 24 * 60 * 60_000,
          liveness: providerThreadId === laterProviderThreadId
            ? "not_live" as const
            : "live" as const,
          scheduledTaskTarget: true as const,
        })));
      },
    };
    const personalCodex = new FakeCodex();
    const value = await fixture(new FakeCloud(),
      () => undefined,
      () => personalAdoptionNow,
      undefined,
      {},
      {
        personalCodex,
        personalCodexHome,
        personalDiscovery: discovery,
        readPersonalCodexAutomations: (request) => Promise.resolve(personalCodexAutomationScan(
          providerThreadIds.map((targetThreadId) => ({ targetThreadId })),
          request,
        )),
      },
    );
    projectRoot = value.documents;
    personalCodex.readProjection = {
      providerThreadId: laterProviderThreadId,
      title: "Later scheduled target",
      projectRoot,
      status: "idle",
      providerUpdatedAt: personalAdoptionNow - 24 * 60 * 60_000,
    };
    const added = await value.service.execute(
      { kind: "account.add", label: "Scheduled target rotation" },
      { signal },
    ) as { account: { id: `acct_${string}` } };
    await value.service.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: false,
    }, { signal });
    await value.service.execute({
      kind: "project.add",
      label: "Scheduled target rotation project",
      path: projectRoot,
    }, { signal });

    await expect(value.service.execute({
      kind: "session.adoption.set",
      provider: "codex",
      enabled: true,
      account: added.account.id,
    }, { signal })).resolves.toMatchObject({
      discovery: { discovered: 50, adopted: 0, pending: 50 },
    });
    expect(discoveryRequests[0]?.codexScheduledThreadIds).toHaveLength(50);
    expect(discoveryRequests[0]?.codexScheduledThreadIds).not.toContain(laterProviderThreadId);

    await expect(value.service.execute({
      kind: "session.adoption.discover",
      provider: "codex",
    }, { signal })).resolves.toMatchObject({
      providers: [{ discovered: 10, adopted: 1, pending: 9 }],
    });
    expect(discoveryRequests[1]?.codexScheduledThreadIds).toHaveLength(10);
    expect(discoveryRequests[1]?.codexScheduledThreadIds).toContain(laterProviderThreadId);
    expect(value.store.findSessionByProviderThread(
      added.account.id,
      laterProviderThreadId,
    )).not.toBeNull();
  });

  test("rotates the first scheduled-target page by daemon generation across reader restarts", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "oompa-automation-restart-")));
    serviceRoots.push(root);
    const automationsDirectory = join(root, "automations");
    await mkdir(automationsDirectory);
    const providerThreadIds = Array.from(
      { length: 60 },
      (_, index) => `scheduled-restart-${String(index).padStart(3, "0")}`,
    );
    for (const [index, providerThreadId] of providerThreadIds.entries()) {
      const source = `restart-source-${String(index).padStart(3, "0")}`;
      await mkdir(join(automationsDirectory, source));
      await writeFile(
        join(automationsDirectory, source, "automation.toml"),
        [
          'kind = "heartbeat"',
          'status = "ACTIVE"',
          `target_thread_id = "${providerThreadId}"`,
          "",
        ].join("\n"),
      );
    }

    let projectRoot = privatePathRoot;
    let laterProviderThreadId: string | null = null;
    const discoveryRequests: Array<
      Parameters<PersonalSessionDiscoveryPort["discover"]>[0]
    > = [];
    const discovery: PersonalSessionDiscoveryPort = {
      discover: (input) => {
        discoveryRequests.push(input);
        if (
          laterProviderThreadId === null
          || !input.codexScheduledThreadIds?.includes(laterProviderThreadId)
        ) return Promise.resolve([]);
        return Promise.resolve([{
          provider: "codex" as const,
          providerThreadId: laterProviderThreadId,
          title: "Restart-rotated scheduled target",
          projectRoot,
          updatedAt: personalAdoptionNow - 24 * 60 * 60_000,
          liveness: "not_live" as const,
          scheduledTaskTarget: true as const,
        }]);
      },
    };
    const firstPersonalCodex = new FakeCodex();
    const firstReader = (request: CodexAutomationAuthorityRequest) =>
      readCodexAutomationAuthority({ ...request, automationsDirectory });
    const value = await fixture(new FakeCloud(),
      () => undefined,
      () => personalAdoptionNow,
      undefined,
      {},
      {
        daemonGeneration: 1,
        personalCodex: firstPersonalCodex,
        personalCodexHome,
        personalDiscovery: discovery,
        readPersonalCodexAutomations: firstReader,
      },
    );
    projectRoot = value.documents;
    const added = await value.service.execute(
      { kind: "account.add", label: "Restart-rotated schedules" },
      { signal },
    ) as { account: { id: `acct_${string}` } };
    await value.service.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: false,
    }, { signal });
    await value.service.execute({
      kind: "project.add",
      label: "Restart-rotated schedule project",
      path: projectRoot,
    }, { signal });

    await expect(value.service.execute({
      kind: "session.adoption.set",
      provider: "codex",
      enabled: true,
      account: added.account.id,
    }, { signal })).resolves.toMatchObject({
      discovery: { discovered: 0, adopted: 0 },
    });
    const firstPage = discoveryRequests[0]?.codexScheduledThreadIds ?? [];
    expect(firstPage).toHaveLength(50);
    laterProviderThreadId = providerThreadIds.find((id) => !firstPage.includes(id)) ?? null;
    if (laterProviderThreadId === null) throw new Error("Expected a target after page one.");
    await value.service.close();

    const restartedPersonalCodex = new FakeCodex();
    restartedPersonalCodex.readProjection = {
      providerThreadId: laterProviderThreadId,
      title: "Restart-rotated scheduled target",
      projectRoot,
      status: "idle",
      providerUpdatedAt: personalAdoptionNow - 24 * 60 * 60_000,
    };
    // Recreate both the service and its reader closure. Generation two starts
    // at the next dense page instead of returning to the first fifty forever.
    const restartedReader = (request: CodexAutomationAuthorityRequest) =>
      readCodexAutomationAuthority({ ...request, automationsDirectory });
    const restarted = new OompaService({
      store: value.store,
      paths: value.paths,
      codex: new FakeCodex(),
      personalCodex: restartedPersonalCodex,
      personalCodexHome,
      personalDiscovery: discovery,
      readPersonalCodexAutomations: restartedReader,
      cloud: new FakeCloud(),
      daemonAuthority: new FakeDaemonAuthority(),
      daemonGeneration: 42,
      eventCursors: value.eventCursors,
      now: () => personalAdoptionNow,
      requestStop: () => undefined,
    });

    await expect(restarted.execute({
      kind: "session.adoption.discover",
      provider: "codex",
    }, { signal })).resolves.toMatchObject({
      providers: [{ discovered: 1, adopted: 1, failed: 0 }],
    });
    expect(discoveryRequests[1]?.codexScheduledThreadIds).toContain(laterProviderThreadId);
    expect(discoveryRequests[1]?.codexScheduledThreadIds).toHaveLength(50);
    expect(value.store.findSessionByProviderThread(
      added.account.id,
      laterProviderThreadId,
    )).not.toBeNull();
  });

  test("falls back to ordinary schedule traversal after a restart seek fails", async () => {
    const providerThreadId = "scheduled-after-restart-seek-failure";
    const restartPages: number[] = [];
    const value = await preparedPersonalCodexCandidate({
      daemonGeneration: 42,
      label: "Restart seek fallback",
      providerThreadId,
      updatedAt: personalAdoptionNow - 24 * 60 * 60_000,
      liveness: "not_live",
      scheduledTaskTarget: true,
      readPersonalCodexAutomations: (request) => {
        if (request.kind === "sources") {
          return Promise.resolve(personalCodexAutomationScan(
            [{ targetThreadId: providerThreadId }],
            request,
          ));
        }
        restartPages.push(request.restartPage ?? 0);
        if (restartPages.length === 1) {
          return Promise.reject(new Error("restart seek deadline exhausted"));
        }
        return Promise.resolve(personalCodexAutomationScan(
          [{ targetThreadId: providerThreadId }],
          request,
        ));
      },
    });

    await expect(value.enable()).resolves.toMatchObject({
      discovery: { adopted: 0, failed: 1 },
    });
    await expect(value.service.execute({
      kind: "session.adoption.discover",
      provider: "codex",
    }, { signal })).resolves.toMatchObject({
      providers: [{ discovered: 1, adopted: 1, failed: 0 }],
    });
    expect(restartPages).toEqual([41, 0]);
    expect(value.store.findSessionByProviderThread(
      value.accountId,
      providerThreadId,
    )).not.toBeNull();
  });

  test("immediately consumes a rebuilt scheduled-target cursor after reader expiry", async () => {
    const providerThreadId = "scheduled-after-expired-reader";
    const prefix = Array.from(
      { length: 50 },
      (_, index) => ({ targetThreadId: `scheduled-expired-prefix-${String(index)}` }),
    );
    let now = personalAdoptionNow;
    let projectRoot = privatePathRoot;
    let pageReads = 0;
    const pageDeadlines: number[] = [];
    const pageCursors: Array<string | null> = [];
    const discoveryRequests: Array<
      Parameters<PersonalSessionDiscoveryPort["discover"]>[0]
    > = [];
    const discovery: PersonalSessionDiscoveryPort = {
      discover: (input) => {
        discoveryRequests.push(input);
        if (!input.codexScheduledThreadIds?.includes(providerThreadId)) {
          return Promise.resolve([]);
        }
        return Promise.resolve([{
          provider: "codex" as const,
          providerThreadId,
          title: "Scheduled after expired reader",
          projectRoot,
          updatedAt: personalAdoptionNow - 24 * 60 * 60_000,
          liveness: "not_live" as const,
          scheduledTaskTarget: true as const,
        }]);
      },
    };
    const personalCodex = new FakeCodex();
    const value = await fixture(new FakeCloud(),
      () => undefined,
      () => now,
      undefined,
      {},
      {
        personalCodex,
        personalCodexHome,
        personalDiscovery: discovery,
        readPersonalCodexAutomations: (request) => {
          if (request.kind === "sources") {
            return Promise.resolve(personalCodexAutomationScan(
              [{ targetThreadId: providerThreadId }],
              request,
            ));
          }
          pageReads += 1;
          pageCursors.push(request.after ?? null);
          if (request.deadlineAt === undefined) throw new Error("Expected a page deadline.");
          pageDeadlines.push(request.deadlineAt);
          if (pageReads === 1) {
            const scan = personalCodexAutomationScan(prefix, request);
            return Promise.resolve({ ...scan, complete: false, nextCursor: "expired-cursor" });
          }
          if (pageReads === 2) {
            now += 60_000;
            return Promise.resolve({
              complete: false,
              diagnostics: [],
              entries: [],
              nextCursor: "rebuilt-live-cursor",
            });
          }
          if (pageReads === 3) {
            return Promise.resolve({
              complete: false,
              diagnostics: [],
              entries: [],
              nextCursor: null,
            });
          }
          return Promise.resolve(personalCodexAutomationScan(
            [{ targetThreadId: providerThreadId }],
            { ...request, after: null },
          ));
        },
      },
    );
    projectRoot = value.documents;
    const added = await value.service.execute(
      { kind: "account.add", label: "Expired scheduled reader" },
      { signal },
    ) as { account: { id: `acct_${string}` } };
    await value.service.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: false,
    }, { signal });
    await value.service.execute({
      kind: "project.add",
      label: "Expired scheduled reader project",
      path: projectRoot,
    }, { signal });
    personalCodex.readProjection = {
      providerThreadId,
      title: "Scheduled after expired reader",
      projectRoot,
      status: "idle",
      providerUpdatedAt: personalAdoptionNow - 24 * 60 * 60_000,
    };

    await expect(value.service.execute({
      kind: "session.adoption.set",
      provider: "codex",
      enabled: true,
      account: added.account.id,
    }, { signal })).resolves.toMatchObject({
      discovery: { discovered: 0, adopted: 0 },
    });
    await expect(value.service.execute({
      kind: "session.adoption.discover",
      provider: "codex",
    }, { signal })).resolves.toMatchObject({
      providers: [{ discovered: 0, adopted: 0, failed: 0 }],
    });
    await expect(value.service.execute({
      kind: "session.adoption.discover",
      provider: "codex",
    }, { signal })).resolves.toMatchObject({
      providers: [{ discovered: 1, adopted: 1, failed: 0 }],
    });
    expect(pageReads).toBe(4);
    expect(pageDeadlines[2]).toBe(pageDeadlines[1]);
    expect(pageCursors).toEqual([
      null,
      "expired-cursor",
      "rebuilt-live-cursor",
      "rebuilt-live-cursor",
    ]);
    expect(discoveryRequests).toHaveLength(3);
    expect(discoveryRequests[2]?.codexScheduledThreadIds).toEqual([providerThreadId]);
  });

  test("bounds failing claims on nonfinal schedule pages so authority rotation still advances", async () => {
    let now = personalAdoptionNow;
    const providerThreadIds = Array.from(
      { length: 110 },
      (_, index) => `scheduled-failing-rotation-${String(index).padStart(3, "0")}`,
    );
    let projectRoot = privatePathRoot;
    const discoveryRequests: Array<
      Parameters<PersonalSessionDiscoveryPort["discover"]>[0]
    > = [];
    const discovery: PersonalSessionDiscoveryPort = {
      discover: (input) => {
        discoveryRequests.push(input);
        return Promise.resolve((input.codexScheduledThreadIds ?? []).map((providerThreadId) => ({
          provider: "codex" as const,
          providerThreadId,
          title: `Failing scheduled ${providerThreadId}`,
          projectRoot,
          updatedAt: personalAdoptionNow - 24 * 60 * 60_000,
          liveness: "not_live" as const,
          scheduledTaskTarget: true as const,
        })));
      },
    };
    const personalCodex = new FakeCodex();
    personalCodex.claimErrorForProviderThreadId = () => {
      // Model a slow, but individually deadline-bounded provider claim. Fifty
      // serial attempts would expire Desktop's five-minute continuation; the
      // poll budget must leave it usable for the next page.
      now += 2 * 60_000;
      return new Error("bounded scheduled claim failure");
    };
    let cursorState: Readonly<{ expiresAt: number; position: number; token: string }> | null = null;
    let cursorSequence = 0;
    const readPersonalCodexAutomations = (
      request: CodexAutomationAuthorityRequest,
    ): Promise<CodexAutomationAuthorityScan> => {
      if (request.kind === "sources") {
        return Promise.resolve(personalCodexAutomationScan(
          providerThreadIds.map((targetThreadId) => ({ targetThreadId })),
          request,
        ));
      }
      let position = 0;
      if (request.after !== undefined && request.after !== null) {
        if (
          cursorState === null
          || cursorState.token !== request.after
          || cursorState.expiresAt <= now
        ) {
          cursorSequence += 1;
          cursorState = {
            expiresAt: now + 5 * 60_000,
            position: 0,
            token: `authority-scan-${String(cursorSequence)}`,
          };
          return Promise.resolve({
            complete: false,
            diagnostics: [],
            entries: [],
            nextCursor: cursorState.token,
          });
        }
        position = cursorState.position;
      }
      const limit = request.limit ?? 200;
      const targets = providerThreadIds.map((targetThreadId) => ({ targetThreadId }));
      const page = personalCodexAutomationScan(targets, {
        kind: "page",
        after: position === 0
          ? null
          : `automation-source-${String(position).padStart(4, "0")}`,
        limit,
      });
      if (page.nextCursor === null) {
        cursorState = null;
        return Promise.resolve(page);
      }
      cursorSequence += 1;
      cursorState = {
        expiresAt: now + 5 * 60_000,
        position: position + page.entries.length,
        token: `authority-scan-${String(cursorSequence)}`,
      };
      return Promise.resolve({ ...page, nextCursor: cursorState.token });
    };
    const value = await fixture(new FakeCloud(),
      () => undefined,
      () => now,
      undefined,
      {},
      {
        personalCodex,
        personalCodexHome,
        personalDiscovery: discovery,
        readPersonalCodexAutomations,
      },
    );
    projectRoot = value.documents;
    const added = await value.service.execute(
      { kind: "account.add", label: "Failing scheduled rotation" },
      { signal },
    ) as { account: { id: `acct_${string}` } };
    await value.service.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: false,
    }, { signal });
    await value.service.execute({
      kind: "project.add",
      label: "Failing scheduled rotation project",
      path: projectRoot,
    }, { signal });

    await expect(value.service.execute({
      kind: "session.adoption.set",
      provider: "codex",
      enabled: true,
      account: added.account.id,
    }, { signal })).resolves.toMatchObject({
      discovery: { discovered: 50, adopted: 0, failed: 2, pending: 48 },
    });
    expect(personalCodex.claimRequests).toHaveLength(2);
    expect(discoveryRequests[0]?.codexScheduledThreadIds).toEqual(
      providerThreadIds.slice(0, 50),
    );

    await expect(value.service.execute({
      kind: "session.adoption.discover",
      provider: "codex",
    }, { signal })).resolves.toMatchObject({
      providers: [{ discovered: 50, adopted: 0, failed: 2, pending: 48 }],
    });
    expect(personalCodex.claimRequests).toHaveLength(4);
    expect(discoveryRequests[1]?.codexScheduledThreadIds).toEqual(
      providerThreadIds.slice(50, 100),
    );

    await expect(value.service.execute({
      kind: "session.adoption.discover",
      provider: "codex",
    }, { signal })).resolves.toMatchObject({
      providers: [{ discovered: 10, adopted: 0, failed: 2, pending: 8 }],
    });
    expect(personalCodex.claimRequests).toHaveLength(6);
    expect(discoveryRequests[2]?.codexScheduledThreadIds).toEqual(
      providerThreadIds.slice(100),
    );
  });

  test("bounds rejected scheduled preflights and durably rotates later candidates", async () => {
    const providerThreadIds = Array.from(
      { length: 5 },
      (_, index) => `scheduled-rejected-preflight-${String(index).padStart(2, "0")}`,
    );
    let projectRoot = privatePathRoot;
    const sourceRechecks: string[][] = [];
    const discovery: PersonalSessionDiscoveryPort = {
      discover: (input) => Promise.resolve((input.codexScheduledThreadIds ?? []).map(
        (providerThreadId) => ({
          provider: "codex" as const,
          providerThreadId,
          title: `Scheduled ${providerThreadId}`,
          projectRoot,
          updatedAt: personalAdoptionNow - 24 * 60 * 60_000,
          liveness: "not_live" as const,
          scheduledTaskTarget: true as const,
        }),
      )),
    };
    const personalCodex = new FakeCodex();
    const value = await fixture(new FakeCloud(),
      () => undefined,
      () => personalAdoptionNow,
      undefined,
      {},
      {
        personalCodex,
        personalCodexHome,
        personalDiscovery: discovery,
        readPersonalCodexAutomations: (request) => {
          if (request.kind === "sources") {
            sourceRechecks.push([...request.sourceDirectoryNames]);
            // The source vanished after the complete page supplied its exact
            // target. This is a preflight rejection with no provider effect.
            return Promise.resolve({
              complete: true,
              diagnostics: [],
              entries: [],
              nextCursor: null,
            });
          }
          return Promise.resolve(personalCodexAutomationScan(
            providerThreadIds.map((targetThreadId) => ({ targetThreadId })),
            request,
          ));
        },
      },
    );
    projectRoot = value.documents;
    const added = await value.service.execute(
      { kind: "account.add", label: "Rejected scheduled preflight fairness" },
      { signal },
    ) as { account: { id: `acct_${string}` } };
    await value.service.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: false,
    }, { signal });
    await value.service.execute({
      kind: "project.add",
      label: "Rejected scheduled preflight project",
      path: projectRoot,
    }, { signal });

    await expect(value.service.execute({
      kind: "session.adoption.set",
      provider: "codex",
      enabled: true,
      account: added.account.id,
    }, { signal })).resolves.toMatchObject({
      discovery: { discovered: 5, adopted: 0, failed: 2, pending: 3 },
    });
    expect(sourceRechecks).toEqual([
      ["automation-source-0001"],
      ["automation-source-0002"],
    ]);
    expect(personalCodex.claimRequests).toHaveLength(0);
    const firstPoll = new Map(value.store.listSessionAdoptionCandidates({
      provider: "codex",
      limit: 10,
    }).map((candidate) => [candidate.providerThreadId, candidate]));
    expect(providerThreadIds.slice(0, 2).every((id) => firstPoll.get(id)?.lastAttemptAt !== null))
      .toBe(true);
    expect(providerThreadIds.slice(2).every((id) => firstPoll.get(id)?.lastAttemptAt === null))
      .toBe(true);

    await expect(value.service.execute({
      kind: "session.adoption.discover",
      provider: "codex",
    }, { signal })).resolves.toMatchObject({
      providers: [{ discovered: 5, adopted: 0, failed: 2, pending: 3 }],
    });
    expect(sourceRechecks).toEqual([
      ["automation-source-0001"],
      ["automation-source-0002"],
      ["automation-source-0003"],
      ["automation-source-0004"],
    ]);
    expect(personalCodex.claimRequests).toHaveLength(0);
  });

  test("bounds failed project canonicalization and reaches a later valid row next poll", async () => {
    const personalCodex = new FakeCodex();
    const discovery = new FakePersonalSessionDiscovery();
    const value = await fixture(new FakeCloud(),
      () => undefined,
      () => personalAdoptionNow,
      undefined,
      {},
      {
        personalCodex,
        personalCodexHome,
        personalDiscovery: discovery,
      },
    );
    const validProviderThreadId = "valid-after-unusable-project-prefix";
    discovery.candidates = [
      {
        provider: "codex",
        providerThreadId: "unusable-project-prefix-one",
        title: "Unusable project one",
        projectRoot: join(value.documents, "missing-project-one"),
        updatedAt: personalAdoptionNow - 13 * 60_000,
        liveness: "not_live",
      },
      {
        provider: "codex",
        providerThreadId: "unusable-project-prefix-two",
        title: "Unusable project two",
        projectRoot: join(value.documents, "missing-project-two"),
        updatedAt: personalAdoptionNow - 12 * 60_000,
        liveness: "not_live",
      },
      {
        provider: "codex",
        providerThreadId: validProviderThreadId,
        title: "Valid project after rejected prefix",
        projectRoot: value.documents,
        updatedAt: personalAdoptionNow - 11 * 60_000,
        liveness: "not_live",
      },
    ];
    personalCodex.readProjection = {
      providerThreadId: validProviderThreadId,
      title: "Valid project after rejected prefix",
      projectRoot: value.documents,
      status: "idle",
      providerUpdatedAt: personalAdoptionNow - 11 * 60_000,
    };
    const added = await value.service.execute(
      { kind: "account.add", label: "Project preflight fairness" },
      { signal },
    ) as { account: { id: `acct_${string}` } };
    await value.service.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: false,
    }, { signal });
    await value.service.execute({
      kind: "project.add",
      label: "Project preflight fairness root",
      path: value.documents,
    }, { signal });

    await expect(value.service.execute({
      kind: "session.adoption.set",
      provider: "codex",
      enabled: true,
      account: added.account.id,
    }, { signal })).resolves.toMatchObject({
      discovery: { discovered: 3, adopted: 0, failed: 2, pending: 1 },
    });
    expect(personalCodex.claimRequests).toHaveLength(0);
    const firstPoll = new Map(value.store.listSessionAdoptionCandidates({
      provider: "codex",
      limit: 10,
    }).map((candidate) => [candidate.providerThreadId, candidate]));
    expect(firstPoll.get("unusable-project-prefix-one")?.lastAttemptAt).not.toBeNull();
    expect(firstPoll.get("unusable-project-prefix-two")?.lastAttemptAt).not.toBeNull();
    expect(firstPoll.get(validProviderThreadId)?.lastAttemptAt).toBeNull();

    await expect(value.service.execute({
      kind: "session.adoption.discover",
      provider: "codex",
    }, { signal })).resolves.toMatchObject({
      providers: [{ discovered: 3, adopted: 1 }],
    });
    expect(personalCodex.claimRequests.map((request) => request.providerThreadId))
      .toEqual([validProviderThreadId]);
    expect(value.store.findSessionByProviderThread(
      added.account.id,
      validProviderThreadId,
    )).not.toBeNull();
  });

  test("gives both recent and scheduled Codex claims bounded progress across polls", async () => {
    const scheduledProviderThreadIds = Array.from(
      { length: 60 },
      (_, index) => `scheduled-before-recent-${String(index).padStart(2, "0")}`,
    );
    const recentProviderThreadIds = [
      "expiring-recent-beside-failing-schedules-one",
      "expiring-recent-beside-failing-schedules-two",
    ] as const;
    const [firstRecentProviderThreadId, secondRecentProviderThreadId] = recentProviderThreadIds;
    const firstScheduledProviderThreadId = scheduledProviderThreadIds[0];
    const secondPageScheduledProviderThreadId = scheduledProviderThreadIds[50];
    if (
      firstScheduledProviderThreadId === undefined
      || secondPageScheduledProviderThreadId === undefined
    ) throw new Error("Expected scheduled candidates on both authority pages.");
    let projectRoot = privatePathRoot;
    let discoveryCall = 0;
    const discovery: PersonalSessionDiscoveryPort = {
      discover: (input) => {
        const recentProviderThreadId = recentProviderThreadIds[
          Math.min(discoveryCall, recentProviderThreadIds.length - 1)
        ] ?? secondRecentProviderThreadId;
        discoveryCall += 1;
        return Promise.resolve([
          ...(input.codexScheduledThreadIds ?? []).map((providerThreadId) => ({
            provider: "codex" as const,
            providerThreadId,
            title: `Failing scheduled ${providerThreadId}`,
            projectRoot,
            updatedAt: personalAdoptionNow - 24 * 60 * 60_000,
            liveness: "not_live" as const,
            scheduledTaskTarget: true as const,
          })),
          {
            provider: "codex" as const,
            providerThreadId: recentProviderThreadId,
            title: "Expiring recent candidate",
            projectRoot,
            updatedAt: personalAdoptionNow - 14 * 60_000,
            liveness: "not_live" as const,
          },
        ]);
      },
    };
    const personalCodex = new FakeCodex();
    personalCodex.claimErrorForProviderThreadId = (providerThreadId) =>
      scheduledProviderThreadIds.includes(providerThreadId)
        ? new Error("slow scheduled prefix failure")
        : undefined;
    const value = await fixture(new FakeCloud(),
      () => undefined,
      () => personalAdoptionNow,
      undefined,
      {},
      {
        personalCodex,
        personalCodexHome,
        personalDiscovery: discovery,
        readPersonalCodexAutomations: (request) => Promise.resolve(personalCodexAutomationScan(
          scheduledProviderThreadIds.map((targetThreadId) => ({ targetThreadId })),
          request,
        )),
      },
    );
    projectRoot = value.documents;
    personalCodex.readProjection = {
      providerThreadId: firstRecentProviderThreadId,
      title: "Expiring recent candidate",
      projectRoot,
      status: "idle",
      providerUpdatedAt: personalAdoptionNow - 14 * 60_000,
    };
    const added = await value.service.execute(
      { kind: "account.add", label: "Recent before scheduled" },
      { signal },
    ) as { account: { id: `acct_${string}` } };
    await value.service.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: false,
    }, { signal });
    await value.service.execute({
      kind: "project.add",
      label: "Recent before scheduled project",
      path: projectRoot,
    }, { signal });

    await expect(value.service.execute({
      kind: "session.adoption.set",
      provider: "codex",
      enabled: true,
      account: added.account.id,
    }, { signal })).resolves.toMatchObject({
      discovery: { adopted: 1, failed: 1, pending: 49 },
    });
    expect(personalCodex.claimRequests.map((request) => request.providerThreadId)).toEqual([
      firstRecentProviderThreadId,
      firstScheduledProviderThreadId,
    ]);
    expect(value.store.findSessionByProviderThread(
      added.account.id,
      firstRecentProviderThreadId,
    )).not.toBeNull();

    await expect(value.service.execute({
      kind: "session.adoption.discover",
      provider: "codex",
    }, { signal })).resolves.toMatchObject({
      providers: [{ adopted: 1, failed: 1, pending: 9 }],
    });
    expect(personalCodex.claimRequests.map((request) => request.providerThreadId)).toEqual([
      firstRecentProviderThreadId,
      firstScheduledProviderThreadId,
      secondPageScheduledProviderThreadId,
      secondRecentProviderThreadId,
    ]);
    expect(value.store.findSessionByProviderThread(
      added.account.id,
      secondRecentProviderThreadId,
    )).not.toBeNull();
  });

  test("persists 200 ordinary observations beside a full scheduled-target batch", async () => {
    const scheduledProviderThreadIds = Array.from(
      { length: 50 },
      (_, index) => `scheduled-coexistence-${String(index).padStart(2, "0")}`,
    );
    const ordinaryProviderThreadIds = Array.from(
      { length: PERSONAL_SESSION_DISCOVERY_MAX_RESULTS },
      (_, index) => `ordinary-with-scheduled-batch-${String(index).padStart(3, "0")}`,
    );
    const recentProviderThreadId = ordinaryProviderThreadIds.at(-1);
    if (recentProviderThreadId === undefined) throw new Error("Expected an ordinary candidate.");
    let projectRoot = privatePathRoot;
    const exactReads: string[] = [];
    const discovery = new BoundedPersonalSessionDiscovery({
      now: () => personalAdoptionNow,
      codexReadSession: ({ providerThreadId }) => {
        exactReads.push(providerThreadId);
        return Promise.resolve({
          providerThreadId,
          title: `Live scheduled ${providerThreadId}`,
          projectRoot,
          status: "active",
          activeTurnId: `turn-${providerThreadId}`,
          providerUpdatedAt: personalAdoptionNow - 24 * 60 * 60_000,
        });
      },
      codexListPage: (request) => {
        const offset = request.cursor === undefined ? 0 : Number(request.cursor);
        const ids = ordinaryProviderThreadIds.slice(offset, offset + request.limit);
        const nextOffset = offset + ids.length;
        return Promise.resolve({
          sessions: ids.map((providerThreadId) => providerThreadId === recentProviderThreadId
            ? {
                providerThreadId,
                title: "Ordinary recent candidate",
                projectRoot,
                status: "idle",
                providerUpdatedAt: personalAdoptionNow - 11 * 60_000,
              }
            : {
                providerThreadId,
                title: `Ordinary live ${providerThreadId}`,
                projectRoot,
                status: "active",
                activeTurnId: `turn-${providerThreadId}`,
                providerUpdatedAt: personalAdoptionNow - 1_000,
              }),
          nextCursor: nextOffset < ordinaryProviderThreadIds.length
            ? String(nextOffset)
            : null,
        });
      },
    });
    const personalCodex = new FakeCodex();
    const value = await fixture(new FakeCloud(),
      () => undefined,
      () => personalAdoptionNow,
      undefined,
      {},
      {
        personalCodex,
        personalCodexHome,
        personalDiscovery: discovery,
        readPersonalCodexAutomations: (request) => Promise.resolve(personalCodexAutomationScan(
          scheduledProviderThreadIds.map((targetThreadId) => ({ targetThreadId })),
          request,
        )),
      },
    );
    projectRoot = value.documents;
    personalCodex.readProjection = {
      providerThreadId: recentProviderThreadId,
      title: "Ordinary recent candidate",
      projectRoot,
      status: "idle",
      providerUpdatedAt: personalAdoptionNow - 11 * 60_000,
    };
    const added = await value.service.execute(
      { kind: "account.add", label: "Scheduled and recent coexistence" },
      { signal },
    ) as { account: { id: `acct_${string}` } };
    await value.service.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: false,
    }, { signal });
    await value.service.execute({
      kind: "project.add",
      label: "Scheduled and recent coexistence project",
      path: projectRoot,
    }, { signal });

    await expect(value.service.execute({
      kind: "session.adoption.set",
      provider: "codex",
      enabled: true,
      account: added.account.id,
    }, { signal })).resolves.toMatchObject({
      discovery: {
        discovered: PERSONAL_CODEX_DISCOVERY_MAX_RESULTS,
        adopted: 1,
        pending: PERSONAL_CODEX_DISCOVERY_MAX_RESULTS - 1,
      },
    });
    expect(exactReads).toHaveLength(50);
    const persistedIds = new Set(value.store.listSessionAdoptionCandidates({
      provider: "codex",
      limit: 500,
    }).map((candidate) => candidate.providerThreadId));
    expect(persistedIds.size).toBe(PERSONAL_CODEX_DISCOVERY_MAX_RESULTS);
    expect(ordinaryProviderThreadIds.every((providerThreadId) =>
      persistedIds.has(providerThreadId))).toBe(true);
    expect(value.store.findSessionByProviderThread(
      added.account.id,
      recentProviderThreadId,
    )).not.toBeNull();
    expect(personalCodex.claimRequests).toHaveLength(1);
  });

  test("persists a full bounded Codex observation before a later quiet claim", async () => {
    const quietProviderThreadId = "quiet-after-live-observation-prefix";
    let projectRoot = privatePathRoot;
    const discovery = new FakePersonalSessionDiscovery();
    discovery.candidates = [
      ...Array.from({ length: 59 }, (_, index) => ({
        provider: "codex" as const,
        providerThreadId: `live-observation-prefix-${String(index).padStart(2, "0")}`,
        title: `Live observation ${index}`,
        projectRoot,
        updatedAt: personalAdoptionNow - 1_000 - index,
        liveness: "live" as const,
      })),
      {
        provider: "codex",
        providerThreadId: quietProviderThreadId,
        title: "Quiet after live prefix",
        projectRoot,
        updatedAt: personalAdoptionNow - 11 * 60_000,
        liveness: "not_live",
      },
    ];
    const personalCodex = new FakeCodex();
    const value = await fixture(new FakeCloud(),
      () => undefined,
      () => personalAdoptionNow,
      undefined,
      {},
      {
        personalCodex,
        personalCodexHome,
        personalDiscovery: discovery,
      },
    );
    projectRoot = value.documents;
    discovery.candidates = discovery.candidates.map((candidate) => ({
      ...candidate,
      projectRoot,
    }));
    personalCodex.readProjection = {
      providerThreadId: quietProviderThreadId,
      title: "Quiet after live prefix",
      projectRoot,
      status: "idle",
      providerUpdatedAt: personalAdoptionNow - 11 * 60_000,
    };
    const added = await value.service.execute(
      { kind: "account.add", label: "Bounded Codex observation" },
      { signal },
    ) as { account: { id: `acct_${string}` } };
    await value.service.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: false,
    }, { signal });
    await value.service.execute({
      kind: "project.add",
      label: "Bounded Codex observation project",
      path: projectRoot,
    }, { signal });

    await expect(value.service.execute({
      kind: "session.adoption.set",
      provider: "codex",
      enabled: true,
      account: added.account.id,
    }, { signal })).resolves.toMatchObject({
      discovery: { discovered: 60, adopted: 1, pending: 59, failed: 0 },
    });
    expect(discovery.requests[0]?.limit).toBe(PERSONAL_SESSION_DISCOVERY_MAX_RESULTS);
    expect(value.store.listSessionAdoptionCandidates({ provider: "codex", limit: 100 }))
      .toHaveLength(60);
    expect(personalCodex.claimRequests.map((request) => request.providerThreadId))
      .toEqual([quietProviderThreadId]);
  });

  test("retains stale active Codex work without claiming until a recent live-to-quiet edge", async () => {
    const providerThreadId = "stale-active-to-quiet-codex";
    const value = await preparedPersonalCodexCandidate({
      label: "Stale active Codex retention",
      providerThreadId,
      updatedAt: personalAdoptionNow - 24 * 60 * 60_000,
      liveness: "live",
    });
    const active = value.discovery.candidates[0];
    if (active === undefined) throw new Error("Expected the active candidate.");
    value.discovery.candidates = [{
      ...active,
      admissionEligible: false,
      trustedLiveObservation: true,
    }];

    await expect(value.enable()).resolves.toMatchObject({
      discovery: { discovered: 1, adopted: 0, pending: 1, failed: 0 },
    });
    expect(value.personalCodex.claimRequests).toHaveLength(0);
    expect(value.store.readSessionAdoptionCandidate("codex", providerThreadId))
      .toMatchObject({
        lastLiveObservedAt: personalAdoptionNow,
        liveness: "live",
        status: "pending",
      });

    value.discovery.candidates = [{
      ...active,
      liveness: "not_live",
      admissionEligible: false,
    }];
    await expect(value.service.execute({
      kind: "session.adoption.discover",
      provider: "codex",
    }, { signal })).resolves.toMatchObject({
      providers: [{ discovered: 1, adopted: 1, pending: 0, failed: 0 }],
    });
    expect(value.personalCodex.claimRequests.map((request) => request.providerThreadId))
      .toEqual([providerThreadId]);
  });

  test("never admits stale quiet Codex history without a trusted live observation", async () => {
    const providerThreadId = "stale-quiet-without-live-codex";
    const value = await preparedPersonalCodexCandidate({
      label: "Stale quiet Codex history",
      providerThreadId,
      updatedAt: personalAdoptionNow - 24 * 60 * 60_000,
      liveness: "not_live",
    });
    const quiet = value.discovery.candidates[0];
    if (quiet === undefined) throw new Error("Expected the quiet candidate.");
    value.discovery.candidates = [{ ...quiet, admissionEligible: false }];

    await expect(value.enable()).resolves.toMatchObject({
      discovery: { discovered: 0, adopted: 0, pending: 0, failed: 0 },
    });
    expect(value.personalCodex.claimRequests).toHaveLength(0);
    expect(value.store.readSessionAdoptionCandidate("codex", providerThreadId)).toBeNull();
  });

  test("expires retained Codex live authority before a stale quiet observation", async () => {
    let now = personalAdoptionNow;
    const providerThreadId = "expired-active-to-quiet-codex";
    const value = await preparedPersonalCodexCandidate({
      label: "Expired active Codex retention",
      providerThreadId,
      updatedAt: personalAdoptionNow - 24 * 60 * 60_000,
      liveness: "live",
      now: () => now,
    });
    const active = value.discovery.candidates[0];
    if (active === undefined) throw new Error("Expected the active candidate.");
    value.discovery.candidates = [{
      ...active,
      admissionEligible: false,
      trustedLiveObservation: true,
    }];
    await value.enable();
    now += PERSONAL_SESSION_DISCOVERY_RECENCY_WINDOW_MS + 1;
    value.discovery.candidates = [{
      ...active,
      liveness: "not_live",
      admissionEligible: false,
    }];

    await expect(value.service.execute({
      kind: "session.adoption.discover",
      provider: "codex",
    }, { signal })).resolves.toMatchObject({
      providers: [{ discovered: 0, adopted: 0, pending: 0, failed: 0 }],
    });
    expect(value.personalCodex.claimRequests).toHaveLength(0);
    expect(value.store.readSessionAdoptionCandidate("codex", providerThreadId))
      .toMatchObject({ liveness: "live", status: "pending" });
  });

  test("caps Claude controller claims at two after persisting every observation", async () => {
    let projectRoot = privatePathRoot;
    const discovery = new FakePersonalSessionDiscovery();
    const managedClaude = new FakeClaude("isolated", {
      pid: 61_000,
      pidDomain: "darwin",
      procStart: "managed-claim-cap",
    });
    const personalClaude = new FakeClaude("personal", {
      pid: 61_001,
      pidDomain: "darwin",
      procStart: "personal-claim-cap",
    });
    personalClaude.claimSessionError = new Error("bounded Claude claim failure");
    const value = await fixture(new FakeCloud(),
      () => undefined,
      () => personalAdoptionNow,
      undefined,
      {},
      {
        managedClaude,
        personalClaude,
        personalCodexHome,
        personalDiscovery: discovery,
      },
    );
    projectRoot = value.documents;
    discovery.candidates = Array.from({ length: 5 }, (_, index) => ({
      provider: "claude" as const,
      providerThreadId: `bounded-claude-claim-${index}`,
      title: `Bounded Claude claim ${index}`,
      projectRoot,
      updatedAt: personalAdoptionNow - 11 * 60_000 - index,
      liveness: "not_live" as const,
      sourceProcessIdentity: {
        pid: 61_100 + index,
        pidDomain: "darwin" as const,
        procStart: `source-claim-cap-${index}`,
      },
    }));
    const added = await value.service.execute(
      { kind: "account.add", label: "Bounded Claude claims" },
      { signal },
    ) as { account: { id: `acct_${string}` } };
    await value.service.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: false,
    }, { signal });
    await value.service.execute({
      kind: "project.add",
      label: "Bounded Claude claims project",
      path: projectRoot,
    }, { signal });

    await expect(value.service.execute({
      kind: "session.adoption.set",
      provider: "claude",
      enabled: true,
      account: added.account.id,
    }, { signal })).resolves.toMatchObject({
      discovery: { discovered: 5, adopted: 0, pending: 3, failed: 2 },
    });
    expect(personalClaude.claimRequests).toHaveLength(2);
    expect(value.store.listSessionAdoptionCandidates({ provider: "claude", limit: 100 }))
      .toHaveLength(5);
  });

  test.each([
    ["removed", [], true],
    ["retargeted", [{ targetThreadId: "replacement-thread" }], true],
    ["invalid", [{
      kind: "cron",
      targetThreadId: "scheduled-racy-heartbeat-thread",
    }], true],
    ["incomplete", [{
      targetThreadId: "scheduled-racy-heartbeat-thread",
    }], false],
  ] as const)(
    "releases a claimed stale Codex target when its heartbeat becomes %s before commit",
    async (_change, changedTargets, changedComplete) => {
      const providerThreadId = "scheduled-racy-heartbeat-thread";
      let currentTargets: readonly Readonly<{
        kind?: string;
        targetThreadId: string | null;
      }>[] = [{ targetThreadId: providerThreadId }];
      let currentComplete = true;
      let scanCalls = 0;
      const value = await preparedPersonalCodexCandidate({
        label: "Scheduled heartbeat claim race",
        providerThreadId,
        updatedAt: personalAdoptionNow - 24 * 60 * 60_000,
        liveness: "not_live",
        scheduledTaskTarget: true,
        readPersonalCodexAutomations: (request) => {
          scanCalls += 1;
          return Promise.resolve(personalCodexAutomationScan(
            currentTargets,
            request,
            currentComplete,
          ));
        },
      });
      value.personalCodex.beforeClaimSessionReturnOnce = () => {
        currentTargets = changedTargets;
        currentComplete = changedComplete;
        return Promise.resolve();
      };

      await expect(value.enable()).resolves.toMatchObject({
        discovery: { provider: "codex", adopted: 0, failed: 1 },
      });
      expect(scanCalls).toBe(3);
      expect(value.personalCodex.claimRequests).toHaveLength(1);
      expect(value.personalCodex.calls.filter((call) => call === "end")).toHaveLength(1);
      expect(value.store.findSessionByProviderThread(
        value.accountId,
        providerThreadId,
      )).toBeNull();
      expect(value.store.listSessionAdoptionCandidates({ provider: "codex" })
        .some((candidate) =>
          candidate.providerThreadId === providerThreadId
          && candidate.status === "pending"))
        .toBe(true);
    },
  );

  test("keeps active, timestamp-less, and terminal scheduled Codex targets ineligible", async () => {
    const providerThreadIds = [
      "scheduled-active-thread",
      "scheduled-missing-time-thread",
      "scheduled-terminal-thread",
    ] as const;
    let projectRoot = privatePathRoot;
    const discovery = new BoundedPersonalSessionDiscovery({
      now: () => personalAdoptionNow,
      codexReadSession: ({ providerThreadId }) => {
        if (providerThreadId === providerThreadIds[0]) {
          return Promise.resolve({
            providerThreadId,
            title: "Scheduled active thread",
            projectRoot,
            status: "active",
            activeTurnId: "turn-active-elsewhere",
            providerUpdatedAt: personalAdoptionNow - 24 * 60 * 60_000,
          });
        }
        if (providerThreadId === providerThreadIds[1]) {
          return Promise.resolve({
            providerThreadId,
            title: "Scheduled timestamp-less thread",
            projectRoot,
            status: "idle",
          });
        }
        return Promise.resolve({
          providerThreadId,
          title: "Scheduled terminal thread",
          projectRoot,
          status: "terminal",
          providerUpdatedAt: personalAdoptionNow - 24 * 60 * 60_000,
        });
      },
    });
    const personalCodex = new FakeCodex();
    const value = await fixture(new FakeCloud(),
      () => undefined,
      () => personalAdoptionNow,
      undefined,
      {},
      {
        personalCodex,
        personalCodexHome,
        personalDiscovery: discovery,
        readPersonalCodexAutomations: (request) => Promise.resolve(personalCodexAutomationScan(
          providerThreadIds.map((targetThreadId) => ({ targetThreadId })),
          request,
        )),
      },
    );
    projectRoot = value.documents;
    const added = await value.service.execute(
      { kind: "account.add", label: "Scheduled ineligible targets" },
      { signal },
    ) as { account: { id: `acct_${string}` } };
    await value.service.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: false,
    }, { signal });
    await value.service.execute({
      kind: "project.add",
      label: "Scheduled ineligible targets project",
      path: value.documents,
    }, { signal });

    await expect(value.service.execute({
      kind: "session.adoption.set",
      provider: "codex",
      enabled: true,
      account: added.account.id,
    }, { signal })).resolves.toMatchObject({
      discovery: { provider: "codex", discovered: 1, adopted: 0, pending: 1 },
    });
    expect(personalCodex.claimRequests).toHaveLength(0);
    expect(value.store.listSessionAdoptionCandidates({ provider: "codex" }))
      .toEqual([expect.objectContaining({
        providerThreadId: providerThreadIds[0],
        liveness: "live",
        status: "pending",
      })]);
  });

  test("continues recent Codex discovery when the automation scan fails", async () => {
    let scanCalls = 0;
    const value = await preparedPersonalCodexCandidate({
      label: "Recent discovery after automation failure",
      providerThreadId: "recent-after-automation-failure",
      updatedAt: personalAdoptionNow - 11 * 60_000,
      liveness: "not_live",
      readPersonalCodexAutomations: () => {
        scanCalls += 1;
        return Promise.reject(new Error("automation directory unavailable"));
      },
    });

    await expect(value.enable()).resolves.toMatchObject({
      discovery: { provider: "codex", adopted: 1, failed: 0 },
    });
    expect(scanCalls).toBe(1);
    expect(value.discovery.requests[0]?.codexScheduledThreadIds).toEqual([]);
    expect(value.personalCodex.claimRequests).toHaveLength(1);
  });

  test("adopts a recent registered-project Codex thread as an ordinary session and routes its turns to personal custody", async () => {
    const value = await adoptedCodexFixture(
      "Adopted routing",
      "personal-thread-routing",
    );

    expect(value.enabled).toMatchObject({
      providers: [{ provider: "codex", enabled: true, adopted: 1 }],
      discovery: { provider: "codex", state: "ready", discovered: 1, adopted: 1 },
    });
    expect(value.personalCodex.claimRequests).toHaveLength(1);
    expect(value.personalCodex.claimRequests[0]).toMatchObject({
      authority: {
        id: value.accountId,
        codexHome: personalCodexHome,
      },
      providerThreadId: "personal-thread-routing",
      projectRoot: value.documents,
      preset: "ultra",
      requirement: presetRequirements.ultra,
      fast: false,
    });
    expect(value.store.requireSessionPresetRequirement(value.session.id)).toEqual({
      preset: "ultra",
      requirement: presetRequirements.ultra,
    });
    expect(value.store.latestSessionRuntimeProfile(value.session.id)).toMatchObject({
      sourceKind: "session_start",
      profile: {
        preset: "ultra",
        approvalPolicy: "on-request",
        reviewMode: "auto_review",
        permissionProfile: ":workspace",
      },
    });
    expect(value.store.isConversationAutomationEnabled(
      value.session.id,
      "personal-thread-routing",
    )).toBe(false);
    expect(value.store.readSessionPersonalRuntimeBinding(value.session.id)).toMatchObject({
      provider: "codex",
      providerThreadId: "personal-thread-routing",
      state: "active",
    });

    const listed = await value.service.execute({
      kind: "session.list",
      archived: false,
      limit: 100,
    }, { signal }) as { sessions: readonly Record<string, unknown>[] };
    const publicSession = listed.sessions.find((session) => session.id === value.session.id);
    expect(publicSession).toMatchObject({
      id: value.session.id,
      profileId: value.accountId,
      provider: "codex",
      providerThreadId: "personal-thread-routing",
      state: "idle",
    });
    expect(publicSession).not.toHaveProperty("origin");
    expect(publicSession).not.toHaveProperty("adopted");
    expect(publicSession).not.toHaveProperty("observationTier");

    const accountListed = await value.service.execute({
      kind: "session.list",
      archived: false,
      account: value.accountId,
      limit: 1,
    }, { signal }) as {
      sessions: readonly { id: string; providerThreadId?: string }[];
      nextCursor: string | null;
    };
    expect(accountListed.sessions).toEqual([expect.objectContaining({
      id: value.session.id,
      providerThreadId: "personal-thread-routing",
    })]);
    expect(accountListed.nextCursor).not.toBeNull();

    // A managed projection may expose the same opaque provider thread id. The
    // source/session identity must keep this row from being emitted twice.
    value.codex.listedProjections = [{
      providerThreadId: "personal-thread-routing",
      title: "Managed collision",
      status: "active",
      activeTurnId: "managed-collision-turn",
      providerUpdatedAt: personalAdoptionNow + 1_000,
    }];
    const collisionListed = await value.service.execute({
      kind: "session.list",
      archived: false,
      account: value.accountId,
      limit: 2,
    }, { signal }) as { sessions: readonly { id: string }[]; nextCursor: string | null };
    expect(collisionListed.sessions.map((session) => session.id)).toEqual([value.session.id]);
    expect(collisionListed.nextCursor).not.toBeNull();
    await expect(value.service.execute({
      kind: "session.list",
      archived: false,
      account: value.accountId,
      limit: 2,
      cursor: collisionListed.nextCursor ?? undefined,
    }, { signal })).resolves.toMatchObject({ sessions: [], nextCursor: null });
    expect(value.store.requireSession(value.session.id)).toMatchObject({
      title: "Adopted routing personal thread",
      state: "idle",
    });
    expect(value.store.readSessionPersonalRuntimeBinding(value.session.id))
      .toMatchObject({ state: "active" });

    const foreign = await value.service.execute(
      { kind: "account.add", label: "Foreign collision account" },
      { signal },
    ) as { account: { id: `acct_${string}` } };
    await value.service.execute({
      kind: "account.login",
      account: foreign.account.id,
      deviceCode: false,
    }, { signal });
    const foreignCollision = await value.service.execute({
      kind: "session.list",
      archived: false,
      account: foreign.account.id,
      limit: 2,
    }, { signal }) as { sessions: readonly { id: string }[] };
    expect(foreignCollision.sessions).toEqual([]);
    expect(value.store.findSessionByProviderThread(
      foreign.account.id,
      "personal-thread-routing",
    )).toBeNull();
    expect(value.store.requireSession(value.session.id)).toMatchObject({
      profileId: value.accountId,
      title: "Adopted routing personal thread",
      state: "idle",
    });

    const nativeSendsBefore = value.codex.calls.filter((call) => call === "send").length;
    const personalSendsBefore = value.personalCodex.calls
      .filter((call) => call === "send").length;
    await expect(value.service.execute({
      kind: "session.send",
      session: value.session.id,
      message: "Continue under Oompa",
      idempotencyKey: "00000000-0000-4000-8000-00000000a001",
    }, { signal })).resolves.toMatchObject({
      session: { id: value.session.id, state: "active" },
    });
    expect(value.personalCodex.calls.filter((call) => call === "send")).toHaveLength(
      personalSendsBefore + 1,
    );
    expect(value.codex.calls.filter((call) => call === "send")).toHaveLength(
      nativeSendsBefore,
    );
  });

  test("releases a Codex claim whose fresh projection revoked the quiet-window inference", async () => {
    const personalCodex = new FakeCodex();
    const discovery = new FakePersonalSessionDiscovery();
    const value = await fixture(new FakeCloud(),
      () => undefined,
      () => personalAdoptionNow,
      undefined,
      {},
      { personalCodex, personalCodexHome, personalDiscovery: discovery },
    );
    const added = await value.service.execute(
      { kind: "account.add", label: "Codex liveness race" },
      { signal },
    ) as { account: { id: `acct_${string}` } };
    await value.service.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: false,
    }, { signal });
    await value.service.execute({
      kind: "project.add",
      label: "Codex liveness race project",
      path: value.documents,
    }, { signal });
    const providerThreadId = "personal-thread-liveness-race";
    personalCodex.readProjection = {
      providerThreadId,
      title: "Freshly active elsewhere",
      status: "idle",
      projectRoot: value.documents,
      providerUpdatedAt: personalAdoptionNow - 1_000,
    };
    discovery.candidates = [{
      provider: "codex",
      providerThreadId,
      title: "Previously quiet",
      projectRoot: value.documents,
      updatedAt: personalAdoptionNow - 11 * 60_000,
      liveness: "not_live",
    }];

    await expect(value.service.execute({
      kind: "session.adoption.set",
      provider: "codex",
      enabled: true,
      account: added.account.id,
    }, { signal })).resolves.toMatchObject({
      discovery: { adopted: 0, failed: 1 },
    });
    expect(personalCodex.claimRequests).toHaveLength(1);
    expect(personalCodex.calls.filter((call) => call === "end")).toHaveLength(1);
    expect(value.store.findSessionByProviderThread(added.account.id, providerThreadId)).toBeNull();
    expect(value.store.listSessionAdoptionCandidates({ provider: "codex" })[0])
      .toMatchObject({ status: "pending" });
  });

  test("paginates native and adopted sessions together before unknown provider discovery", async () => {
    const personalCodex = new FakeCodex();
    const managedClaude = new FakeClaude("isolated", {
      pid: 63_100,
      pidDomain: "darwin",
      procStart: "managed-claude-pagination",
    });
    const discovery = new FakePersonalSessionDiscovery();
    const value = await fixture(new FakeCloud(),
      () => undefined,
      () => personalAdoptionNow,
      undefined,
      {},
      { managedClaude, personalCodex, personalCodexHome, personalDiscovery: discovery },
    );
    const added = await value.service.execute(
      { kind: "account.add", label: "Adopted pagination" },
      { signal },
    ) as { account: { id: `acct_${string}` } };
    await value.service.execute(
      { kind: "account.login", account: added.account.id, deviceCode: false },
      { signal },
    );
    await value.service.execute(
      { kind: "project.add", label: "Adopted pagination project", path: value.documents },
      { signal },
    );
    managedClaude.projection = {
      providerThreadId: "managed-claude-pagination",
      title: "Managed Claude pagination",
      status: "idle",
      projectRoot: value.documents,
      providerUpdatedAt: personalAdoptionNow - 500,
    };
    const nativeClaude = await value.service.execute({
      kind: "session.start",
      account: added.account.id,
      provider: "claude",
      preset: "fable-max",
      fast: false,
    }, { signal }) as { session: { id: string; providerThreadId?: string } };
    expect(nativeClaude.session.providerThreadId).toMatch(/^[0-9a-f-]{36}$/u);
    personalCodex.readProjection = {
      providerThreadId: "adopted-pagination-template",
      title: "Adopted pagination thread",
      status: "idle",
      projectRoot: value.documents,
      providerUpdatedAt: personalAdoptionNow - 11 * 60_000,
    };
    discovery.candidates = [1, 2, 3].map((index) => ({
      provider: "codex" as const,
      providerThreadId: `adopted-pagination-${String(index)}`,
      title: `Adopted pagination ${String(index)}`,
      projectRoot: value.documents,
      updatedAt: personalAdoptionNow - 11 * 60_000 - index,
      liveness: "not_live" as const,
    }));
    await expect(value.service.execute({
      kind: "session.adoption.set",
      provider: "codex",
      enabled: true,
      account: added.account.id,
    }, { signal })).resolves.toMatchObject({
      discovery: { adopted: 2, failed: 0, pending: 1 },
    });
    await expect(value.service.execute({
      kind: "session.adoption.discover",
      provider: "codex",
    }, { signal })).resolves.toMatchObject({
      providers: [{ adopted: 1, failed: 0 }],
    });
    const adoptedIds = new Set(value.store.listSessionPersonalRuntimeBindings()
      .map((binding) => binding.sessionId));
    expect(adoptedIds.size).toBe(3);
    const expectedLocalIds = new Set([...adoptedIds, nativeClaude.session.id]);

    value.codex.listedProjections = [{
      providerThreadId: "managed-pagination-1",
      title: "Managed first page",
      status: "idle",
    }];
    value.codex.listedNextCursor = "provider-page-2";
    const first = await value.service.execute({
      kind: "session.list",
      archived: false,
      account: added.account.id,
      limit: 2,
    }, { signal }) as {
      sessions: readonly { id: string; providerThreadId?: string }[];
      nextCursor: string | null;
    };
    expect(first.sessions).toHaveLength(2);
    expect(first.sessions.every((session) => expectedLocalIds.has(session.id))).toBe(true);
    expect(first.nextCursor).not.toBeNull();

    const second = await value.service.execute({
      kind: "session.list",
      archived: false,
      account: added.account.id,
      limit: 2,
      cursor: first.nextCursor ?? undefined,
    }, { signal }) as {
      sessions: readonly { id: string; providerThreadId?: string }[];
      nextCursor: string | null;
    };
    expect(second.sessions).toHaveLength(2);
    expect(second.nextCursor).not.toBeNull();

    const third = await value.service.execute({
      kind: "session.list",
      archived: false,
      account: added.account.id,
      limit: 2,
      cursor: second.nextCursor ?? undefined,
    }, { signal }) as {
      sessions: readonly { id: string; providerThreadId?: string }[];
      nextCursor: string | null;
    };
    expect(third.sessions.map((session) => session.providerThreadId))
      .toEqual(["managed-pagination-1"]);
    expect(third.nextCursor).not.toBeNull();

    const replayedThird = await value.service.execute({
      kind: "session.list",
      archived: false,
      account: added.account.id,
      limit: 2,
      cursor: second.nextCursor ?? undefined,
    }, { signal }) as {
      sessions: readonly { id: string; providerThreadId?: string }[];
      nextCursor: string | null;
    };
    expect(replayedThird.sessions.map((session) => session.id))
      .toEqual(third.sessions.map((session) => session.id));
    expect(replayedThird.sessions.map((session) => session.providerThreadId))
      .toEqual(["managed-pagination-1"]);
    expect(replayedThird.nextCursor).toBe(third.nextCursor);

    value.codex.listedProjections = [{
      providerThreadId: "managed-pagination-2",
      title: "Managed terminal page",
      status: "idle",
    }];
    value.codex.listedNextCursor = null;
    const fourth = await value.service.execute({
      kind: "session.list",
      archived: false,
      account: added.account.id,
      limit: 2,
      cursor: third.nextCursor ?? undefined,
    }, { signal }) as {
      sessions: readonly { id: string; providerThreadId?: string }[];
      nextCursor: string | null;
    };
    expect(fourth.sessions.map((session) => session.providerThreadId))
      .toEqual(["managed-pagination-2"]);
    expect(fourth.nextCursor).toBeNull();
    const replayedFourth = await value.service.execute({
      kind: "session.list",
      archived: false,
      account: added.account.id,
      limit: 2,
      cursor: third.nextCursor ?? undefined,
    }, { signal }) as {
      sessions: readonly { id: string; providerThreadId?: string }[];
      nextCursor: string | null;
    };
    expect(replayedFourth.sessions.map((session) => session.id))
      .toEqual(fourth.sessions.map((session) => session.id));
    expect(replayedFourth.sessions.map((session) => session.providerThreadId))
      .toEqual(["managed-pagination-2"]);
    expect(replayedFourth.nextCursor).toBeNull();
    const localSessions = [...first.sessions, ...second.sessions];
    expect(new Set(localSessions.map((session) => session.id))).toEqual(expectedLocalIds);
    const listedNativeClaude = localSessions.find(
      (session) => session.id === nativeClaude.session.id,
    );
    expect(listedNativeClaude?.providerThreadId).toBe(nativeClaude.session.providerThreadId);
    const allIds = [...first.sessions, ...second.sessions, ...third.sessions, ...fourth.sessions]
      .map((session) => session.id);
    expect(new Set(allIds).size).toBe(allIds.length);
    expect(value.codex.sessionListRequests.map((request) => request.cursor ?? null))
      .toEqual([null, null, "provider-page-2", "provider-page-2"]);
  });

  test("re-proves the managed account identity before importing a provider list page", async () => {
    const value = await fixture();
    const added = await value.service.execute(
      { kind: "account.add", label: "List identity race" },
      { signal },
    ) as { account: { id: `acct_${string}` } };
    await value.service.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: false,
    }, { signal });
    value.codex.listedProjections = [{
      providerThreadId: "replacement-account-thread",
      title: "Must not cross the account fence",
      status: "idle",
    }];
    value.codex.beforeListSessionsReturn = () => {
      value.codex.accountProjection = {
        signedIn: true,
        email: "replacement-list-owner@example.com",
        plan: "Plus",
      };
    };

    await expect(value.service.execute({
      kind: "session.list",
      archived: false,
      account: added.account.id,
      limit: 10,
    }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(value.codex.sessionListRequests).toHaveLength(1);
    expect(value.store.findSessionByProviderThread(
      added.account.id,
      "replacement-account-thread",
    )).toBeNull();
    await value.service.settled();
  });

  test("denies provider discovery for a signed-in runtime without an identifiable account", async () => {
    const value = await fixture();
    value.codex.loginResult = {
      status: "signed_in",
      account: { signedIn: true },
    };
    value.codex.accountProjection = { signedIn: true };
    const added = await value.service.execute(
      { kind: "account.add", label: "Unidentifiable list account" },
      { signal },
    ) as { account: { id: `acct_${string}` } };
    await value.service.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: false,
    }, { signal });
    value.codex.listedProjections = [{
      providerThreadId: "unidentifiable-provider-thread",
      title: "Must not import",
      status: "idle",
    }];

    await expect(value.service.execute({
      kind: "session.list",
      archived: false,
      account: added.account.id,
      limit: 10,
    }, { signal })).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(value.codex.sessionListRequests).toEqual([]);
    expect(value.store.findSessionByProviderThread(
      added.account.id,
      "unidentifiable-provider-thread",
    )).toBeNull();
  });

  test("pages every authorized local session while provider listing is recovery-blocked", async () => {
    const cloud = new FakeCloud();
    const value = await archivedDevinFixture(cloud);
    await abandonArchivedDevinLogin(value);
    const added = { account: value.captured.profile };
    await value.service.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: false,
    }, { signal });
    const expectedIds = new Set(Array.from({ length: 3 }, (_, index) => {
      const session = value.store.upsertProviderSession({
      providerAuthority: value.store.requireProviderAccountAuthority(added.account.id, "codex"),
        profileId: added.account.id,
        provider: "codex",
        providerThreadId: `recovery-local-${String(index)}`,
        title: `Recovery local ${String(index)}`,
        preset: "high",
        fastEnabled: false,
        state: "idle",
        providerAccountKey: codexProviderAccountKey(),
      });
      return session.id;
    }));
    expectedIds.add(value.captured.session.id);
    cloud.unsettledProjectionProfiles.add(added.account.id);
    value.codex.listedProjections = [{
      providerThreadId: "recovery-blocked-provider-thread",
      title: "Must remain undiscovered",
      status: "idle",
    }];

    const listedIds: string[] = [];
    let cursor: string | undefined;
    for (let pageIndex = 0; pageIndex < expectedIds.size; pageIndex += 1) {
      const page = await value.service.execute({
        kind: "session.list",
        archived: false,
        account: added.account.id,
        limit: 1,
        ...(cursor === undefined ? {} : { cursor }),
      }, { signal }) as {
        sessions: readonly { id: string }[];
        nextCursor: string | null;
        recovery: { required: boolean };
      };
      expect(page.sessions).toHaveLength(1);
      expect(page.recovery.required).toBe(true);
      listedIds.push(page.sessions[0]?.id ?? "missing-session");
      if (pageIndex < expectedIds.size - 1) {
        expect(page.nextCursor).not.toBeNull();
        cursor = page.nextCursor ?? undefined;
      } else {
        expect(page.nextCursor).toBeNull();
      }
    }

    expect(new Set(listedIds)).toEqual(expectedIds);
    expect(listedIds).toHaveLength(expectedIds.size);
    expect(value.codex.sessionListRequests).toEqual([]);
    expect(value.store.findSessionByProviderThread(
      added.account.id,
      "recovery-blocked-provider-thread",
    )).toBeNull();
  });

  test("does not let a managed Codex projection mutate a native Claude collision", async () => {
    const managedClaude = new FakeClaude("isolated", {
      pid: 63_101,
      pidDomain: "darwin",
      procStart: "managed-claude-provider-collision",
    });
    const value = await fixture(new FakeCloud(),
      () => undefined,
      () => personalAdoptionNow,
      undefined,
      {},
      { managedClaude },
    );
    const added = await value.service.execute(
      { kind: "account.add", label: "Provider collision" },
      { signal },
    ) as { account: { id: `acct_${string}` } };
    await value.service.execute(
      { kind: "account.login", account: added.account.id, deviceCode: false },
      { signal },
    );
    await value.service.execute(
      { kind: "project.add", label: "Provider collision project", path: value.documents },
      { signal },
    );
    managedClaude.projection = {
      providerThreadId: "cross-provider-thread-collision",
      title: "Native Claude collision",
      status: "idle",
      projectRoot: value.documents,
      providerUpdatedAt: personalAdoptionNow - 1_000,
    };
    const started = await value.service.execute({
      kind: "session.start",
      account: added.account.id,
      provider: "claude",
      preset: "fable-max",
      fast: false,
    }, { signal }) as { session: { id: `sess_${string}` } };
    const before = value.store.requireSession(started.session.id);
    if (before.providerThreadId === undefined) throw new Error("Expected a bound Claude session.");

    value.codex.listedProjections = [{
      providerThreadId: before.providerThreadId,
      title: "Codex must not overwrite this row",
      status: "active",
      activeTurnId: "wrong-provider-turn",
      providerUpdatedAt: personalAdoptionNow + 1_000,
    }];
    value.codex.listedNextCursor = null;
    const listed = await value.service.execute({
      kind: "session.list",
      archived: false,
      account: added.account.id,
      limit: 10,
    }, { signal }) as {
      sessions: readonly { id: string; provider: string }[];
      nextCursor: string | null;
    };

    const collisions = listed.sessions.filter((session) => session.id === started.session.id);
    expect(collisions).toHaveLength(1);
    expect(collisions[0]?.provider).toBe("claude");
    expect(listed.nextCursor).not.toBeNull();
    await expect(value.service.execute({
      kind: "session.list",
      archived: false,
      account: added.account.id,
      limit: 10,
      cursor: listed.nextCursor ?? undefined,
    }, { signal })).resolves.toMatchObject({ sessions: [], nextCursor: null });
    expect(value.store.requireSession(started.session.id)).toEqual(before);
  });

  test("retains a stale live Claude process with a noncanonical project root and adopts it after the exact source disappears", async () => {
    const sourceProcessIdentity: ClaudeProcessIdentity = {
      pid: 62_901,
      pidDomain: "darwin",
      procStart: "retained-source-process",
    };
    const livenessChecks: Array<Parameters<ClaudeProcessLivenessProbe>[0]> = [];
    const managedClaude = new FakeClaude("isolated", {
      pid: 62_902,
      pidDomain: "darwin",
      procStart: "retained-managed-process",
    });
    const personalClaude = new FakeClaude("personal", {
      pid: 62_903,
      pidDomain: "darwin",
      procStart: "retained-adopted-process",
    });
    const discovery = new FakePersonalSessionDiscovery();
    const value = await fixture(new FakeCloud(),
      () => undefined,
      () => personalAdoptionNow,
      undefined,
      {},
      {
        managedClaude,
        personalClaude,
        personalCodexHome,
        personalDiscovery: discovery,
        claudeProcessLiveness: (identity) => {
          livenessChecks.push(identity);
          return Promise.resolve("not_live");
        },
      },
    );
    const added = await value.service.execute(
      { kind: "account.add", label: "Retained Claude adoption" },
      { signal },
    ) as { account: { id: `acct_${string}` } };
    await value.service.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: false,
    }, { signal });
    const project = await value.service.execute({
      kind: "project.add",
      label: "Retained Claude project",
      path: value.documents,
    }, { signal }) as { project: { id: `proj_${string}` } };
    const providerProjectRoot = `${value.documents}/provider-alias/..`;
    personalClaude.projection = {
      providerThreadId: "retained-claude-thread",
      title: "Retained Claude thread",
      status: "idle",
      projectRoot: providerProjectRoot,
      providerUpdatedAt: personalAdoptionNow - 1_000,
    };
    discovery.candidates = [{
      provider: "claude",
      providerThreadId: "retained-claude-thread",
      title: "Retained Claude thread",
      projectRoot: providerProjectRoot,
      updatedAt: personalAdoptionNow - 24 * 60 * 60_000,
      liveness: "live",
      sourceProcessIdentity,
      admissionEligible: false,
      trustedLiveObservation: true,
    }];

    await expect(value.service.execute({
      kind: "session.adoption.set",
      provider: "claude",
      enabled: true,
      account: added.account.id,
    }, { signal })).resolves.toMatchObject({
      discovery: { provider: "claude", discovered: 1, adopted: 0, pending: 1 },
    });
    expect(livenessChecks).toHaveLength(0);
    expect(value.store.listSessionAdoptionCandidates({ provider: "claude" })[0])
      .toMatchObject({
        projectId: null,
        providerProjectRoot,
        liveness: "live",
        status: "pending",
        sourceProcessIdentity,
      });
    expect(value.store.findSessionByProviderThread(
      added.account.id,
      "retained-claude-thread",
    )).toBeNull();

    // Every structurally observed Claude id must fence retained reprobes,
    // even when the target sorts outside the ordinary admission bound and
    // its current row is ineligible (for example, a wrong pinned version).
    discovery.candidates = [
      ...Array.from({ length: 50 }, (_, index) => ({
        provider: "claude" as const,
        providerThreadId: `newer-ineligible-claude-${String(index)}`,
        title: `Newer ineligible Claude ${String(index)}`,
        updatedAt: personalAdoptionNow - index,
        liveness: "unknown" as const,
        sourceProcessIdentity: null,
        admissionEligible: false,
      })),
      {
        provider: "claude",
        providerThreadId: "retained-claude-thread",
        title: "Current incompatible Claude row",
        updatedAt: personalAdoptionNow - 100,
        liveness: "live",
        sourceProcessIdentity: null,
        admissionEligible: false,
      },
    ];
    await expect(value.service.execute({
      kind: "session.adoption.discover",
      provider: "claude",
    }, { signal })).resolves.toMatchObject({
      providers: [{ discovered: 0, adopted: 0 }],
    });
    expect(discovery.requests.at(-1)?.limit).toBe(CLAUDE_REGISTRY_MAX_RECORDS);
    expect(livenessChecks).toHaveLength(0);
    expect(personalClaude.claimRequests).toHaveLength(0);
    expect(value.store.listSessionAdoptionCandidates({ provider: "claude" })[0])
      .toMatchObject({ liveness: "live", status: "pending", sourceProcessIdentity });

    // Once a later proven-complete snapshot contains no row for the id, Oompa
    // can prove the retained PID/start tuple is gone and admit the candidate.
    discovery.candidates = [];
    await expect(value.service.execute({
      kind: "session.adoption.discover",
      provider: "claude",
    }, { signal })).resolves.toMatchObject({
      providers: [{
        provider: "claude",
        state: "ready",
        discovered: 0,
        adopted: 1,
        failed: 0,
      }],
    });
    expect(livenessChecks).toEqual([sourceProcessIdentity]);
    expect(personalClaude.claimRequests).toHaveLength(1);
    expect(value.store.findSessionByProviderThread(
      added.account.id,
      "retained-claude-thread",
    )).toMatchObject({
      profileId: added.account.id,
      projectId: project.project.id,
      provider: "claude",
    });
    expect(value.store.readSessionAdoptionCandidate(
      "claude",
      "retained-claude-thread",
    )).toMatchObject({
      projectId: project.project.id,
      providerProjectRoot: value.documents,
      status: "adopted",
    });
  });

  test("excludes a full current Claude snapshot before bounding retained reprobes", async () => {
    const targetProviderThreadId = "z-retained-after-current-prefix";
    const targetIdentity: ClaudeProcessIdentity = {
      pid: 63_999,
      pidDomain: "darwin",
      procStart: "retained-after-current-prefix",
    };
    const probed: Array<Parameters<ClaudeProcessLivenessProbe>[0]> = [];
    const discovery = new FakePersonalSessionDiscovery();
    const managedClaude = new FakeClaude("isolated", {
      pid: 63_000,
      pidDomain: "darwin",
      procStart: "managed-retained-prefix",
    });
    const personalClaude = new FakeClaude("personal", {
      pid: 63_001,
      pidDomain: "darwin",
      procStart: "personal-retained-prefix",
    });
    const value = await fixture(new FakeCloud(),
      () => undefined,
      () => personalAdoptionNow,
      undefined,
      {},
      {
        managedClaude,
        personalClaude,
        personalCodexHome,
        personalDiscovery: discovery,
        claudeProcessLiveness: (identity) => {
          probed.push(identity);
          return Promise.resolve("not_live");
        },
      },
    );
    const added = await value.service.execute(
      { kind: "account.add", label: "Retained query fairness" },
      { signal },
    ) as { account: { id: `acct_${string}` } };
    await value.service.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: false,
    }, { signal });
    const project = await value.service.execute({
      kind: "project.add",
      label: "Retained query fairness project",
      path: value.documents,
    }, { signal }) as { project: { id: `proj_${string}` } };
    const currentProviderThreadIds = Array.from(
      { length: 100 },
      (_, index) => `a-current-retained-prefix-${String(index).padStart(3, "0")}`,
    );
    for (const [index, providerThreadId] of currentProviderThreadIds.entries()) {
      value.store.upsertSessionAdoptionCandidate({
        provider: "claude",
        providerThreadId,
        projectId: project.project.id,
        title: `Current retained prefix ${index}`,
        state: "active",
        providerUpdatedAt: personalAdoptionNow - 1_000,
        liveness: "live",
        trustedLiveObservation: true,
        sourceProcessIdentity: {
          pid: 64_000 + index,
          pidDomain: "darwin",
          procStart: `current-retained-prefix-${index}`,
        },
      });
    }
    value.store.upsertSessionAdoptionCandidate({
      provider: "claude",
      providerThreadId: targetProviderThreadId,
      projectId: project.project.id,
      title: "Retained after current prefix",
      state: "active",
      providerUpdatedAt: personalAdoptionNow - 24 * 60 * 60_000,
      liveness: "live",
      trustedLiveObservation: true,
      sourceProcessIdentity: targetIdentity,
    });
    discovery.candidates = currentProviderThreadIds.map((providerThreadId, index) => ({
      provider: "claude" as const,
      providerThreadId,
      title: `Ineligible current prefix ${index}`,
      updatedAt: personalAdoptionNow - index,
      liveness: "unknown" as const,
      sourceProcessIdentity: null,
      admissionEligible: false,
    }));
    personalClaude.projection = {
      providerThreadId: targetProviderThreadId,
      title: "Retained after current prefix",
      projectRoot: value.documents,
      status: "idle",
      providerUpdatedAt: personalAdoptionNow - 24 * 60 * 60_000,
    };

    await expect(value.service.execute({
      kind: "session.adoption.set",
      provider: "claude",
      enabled: true,
      account: added.account.id,
    }, { signal })).resolves.toMatchObject({
      discovery: { discovered: 0, adopted: 1, failed: 0 },
    });
    expect(probed).toEqual([targetIdentity]);
    expect(personalClaude.claimRequests.map((request) => request.providerThreadId))
      .toEqual([targetProviderThreadId]);
  });

  test("does not adopt a retained Claude candidate on unknown liveness or a stale exact probe", async () => {
    const sourceProcessIdentity: ClaudeProcessIdentity = {
      pid: 62_911,
      pidDomain: "darwin",
      procStart: "retained-fenced-source",
    };
    const replacementIdentity: ClaudeProcessIdentity = {
      pid: 62_912,
      pidDomain: "darwin",
      procStart: "retained-fenced-replacement",
    };
    let probeResult: "not_live" | "unknown" = "unknown";
    const raceContext: { store?: StateStore } = {};
    const personalClaude = new FakeClaude("personal", {
      pid: 62_913,
      pidDomain: "darwin",
      procStart: "retained-fenced-adopted",
    });
    const discovery = new FakePersonalSessionDiscovery();
    const value = await fixture(new FakeCloud(),
      () => undefined,
      () => personalAdoptionNow,
      undefined,
      {},
      {
        managedClaude: new FakeClaude("isolated", {
          pid: 62_914,
          pidDomain: "darwin",
          procStart: "retained-fenced-managed",
        }),
        personalClaude,
        personalCodexHome,
        personalDiscovery: discovery,
        claudeProcessLiveness: () => {
          if (probeResult === "not_live") {
            const store = raceContext.store;
            if (store === undefined) throw new Error("Expected the race store.");
            const current = store.listSessionAdoptionCandidates({ provider: "claude" })[0];
            if (current === undefined) throw new Error("Expected the retained candidate.");
            store.upsertSessionAdoptionCandidate({
              provider: "claude",
              providerThreadId: current.providerThreadId,
              ...(current.projectId === null ? {} : { projectId: current.projectId }),
              title: current.title,
              state: "active",
              ...(current.providerUpdatedAt === null
                ? {}
                : { providerUpdatedAt: current.providerUpdatedAt }),
              liveness: "live",
              trustedLiveObservation: true,
              sourceProcessIdentity: replacementIdentity,
            });
          }
          return Promise.resolve(probeResult);
        },
      },
    );
    raceContext.store = value.store;
    const added = await value.service.execute(
      { kind: "account.add", label: "Retained Claude fence" },
      { signal },
    ) as { account: { id: `acct_${string}` } };
    await value.service.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: false,
    }, { signal });
    await value.service.execute({
      kind: "project.add",
      label: "Retained Claude fence project",
      path: value.documents,
    }, { signal });
    personalClaude.projection = {
      providerThreadId: "retained-claude-fenced-thread",
      title: "Retained Claude fenced thread",
      status: "idle",
      projectRoot: value.documents,
      providerUpdatedAt: personalAdoptionNow - 1_000,
    };
    discovery.candidates = [{
      provider: "claude",
      providerThreadId: "retained-claude-fenced-thread",
      title: "Retained Claude fenced thread",
      projectRoot: value.documents,
      updatedAt: personalAdoptionNow - 1_000,
      liveness: "live",
      trustedLiveObservation: true,
      sourceProcessIdentity,
    }];
    await value.service.execute({
      kind: "session.adoption.set",
      provider: "claude",
      enabled: true,
      account: added.account.id,
    }, { signal });

    discovery.candidates = [];
    await expect(value.service.execute({
      kind: "session.adoption.discover",
      provider: "claude",
    }, { signal })).resolves.toMatchObject({
      providers: [{ discovered: 0, adopted: 0, pending: 1 }],
    });
    expect(personalClaude.claimRequests).toHaveLength(0);
    expect(value.store.listSessionAdoptionCandidates({ provider: "claude" })[0])
      .toMatchObject({ liveness: "unknown", status: "pending", sourceProcessIdentity });

    probeResult = "not_live";
    await expect(value.service.execute({
      kind: "session.adoption.discover",
      provider: "claude",
    }, { signal })).resolves.toMatchObject({
      providers: [{ discovered: 0, adopted: 0 }],
    });
    expect(personalClaude.claimRequests).toHaveLength(0);
    expect(value.store.findSessionByProviderThread(
      added.account.id,
      "retained-claude-fenced-thread",
    )).toBeNull();
    expect(value.store.listSessionAdoptionCandidates({ provider: "claude" })[0])
      .toMatchObject({
        liveness: "live",
        status: "pending",
        sourceProcessIdentity: replacementIdentity,
      });
  });

  test("preserves an adopted Claude title beyond the bounded runtime projection", async () => {
    const durableTitle = `Personal Claude ${"界".repeat(80)}`;
    const boundedProjectionTitle = `Personal Claude ${"界".repeat(34)}`;
    expect(new TextEncoder().encode(durableTitle).byteLength).toBeGreaterThan(120);
    expect(new TextEncoder().encode(boundedProjectionTitle).byteLength)
      .toBeLessThanOrEqual(120);
    const value = await adoptedClaudeFixture(
      "Adopted Claude long title",
      "personal-claude-long-title",
      (runtime) => {
        runtime.claimProjectionTitle = boundedProjectionTitle;
      },
      durableTitle,
    );
    await value.service.settled();

    expect(value.personalClaude.claimRequests[0]?.title).toBe(durableTitle);
    expect(value.personalClaude.projection.title).toBe(boundedProjectionTitle);
    expect(value.store.requireSession(value.session.id).title).toBe(durableTitle);
    expect(value.store.listSessionAdoptionCandidates({ provider: "claude" })[0]?.title)
      .toBe(durableTitle);
    await expect(value.service.execute({
      kind: "session.show",
      session: value.session.id,
      detail: false,
    }, { signal })).resolves.toMatchObject({
      projection: { title: boundedProjectionTitle },
      session: { title: durableTitle },
    });
    expect(value.store.requireSession(value.session.id).title).toBe(durableTitle);
  });

  test("preserves an adopted Claude title across controller restart observation", async () => {
    const durableTitle = `Restarted Claude ${"界".repeat(80)}`;
    const boundedProjectionTitle = `Restarted Claude ${"界".repeat(33)}`;
    expect(new TextEncoder().encode(durableTitle).byteLength).toBeGreaterThan(120);
    expect(new TextEncoder().encode(boundedProjectionTitle).byteLength)
      .toBeLessThanOrEqual(120);
    const value = await adoptedClaudeFixture(
      "Adopted Claude restart title",
      "personal-claude-restart-title",
      (runtime) => {
        runtime.claimProjectionTitle = boundedProjectionTitle;
      },
      durableTitle,
    );
    await value.service.settled();
    const initialIdentity = value.personalClaude.processIdentity;
    const replacementIdentity: ClaudeProcessIdentity = {
      pid: 63_024,
      pidDomain: "darwin",
      procStart: "personal-claude-restart-title-replacement",
    };
    const replacementConnectionId = "30000000-0000-4000-8000-0000000000c5";
    value.personalClaude.disconnectOnObserveRequest =
      value.personalClaude.observeRequests.length + 1;
    value.personalClaude.processIdentityOnClaim = replacementIdentity;
    value.personalClaude.observationConnectionIdOnClaim = replacementConnectionId;

    await expect(value.service.execute({
      kind: "session.status",
      session: value.session.id,
    }, { signal })).resolves.toMatchObject({
      providerObservation: {
        connectionId: replacementConnectionId,
        state: "live",
      },
    });

    expect(value.personalClaude.endedProcessIdentities).toEqual([initialIdentity]);
    expect(value.personalClaude.claimRequests).toHaveLength(2);
    expect(value.personalClaude.claimRequests[1]?.title).toBe(durableTitle);
    expect(value.personalClaude.projection.title).toBe(boundedProjectionTitle);
    expect(value.store.readClaudeProcessAuthority({
      providerThreadId: "personal-claude-restart-title",
      profileId: value.accountId,
      runtimeScope: "personal",
    })).toMatchObject({
      identity: replacementIdentity,
      sessionId: value.session.id,
      state: "bound",
    });
    expect(value.store.requireSession(value.session.id).title).toBe(durableTitle);
    await expect(value.service.execute({
      kind: "session.show",
      session: value.session.id,
      detail: false,
    }, { signal })).resolves.toMatchObject({
      projection: { title: boundedProjectionTitle },
      session: { title: durableTitle },
    });
    expect(value.store.requireSession(value.session.id).title).toBe(durableTitle);
  });

  test("preserves an adopted Claude title across status, mutation, and queue recovery", async () => {
    const durableTitle = `Recovered Claude ${"界".repeat(80)}`;
    const boundedProjectionTitle = `Recovered Claude ${"界".repeat(33)}`;
    expect(new TextEncoder().encode(durableTitle).byteLength).toBeGreaterThan(120);
    expect(new TextEncoder().encode(boundedProjectionTitle).byteLength)
      .toBeLessThanOrEqual(120);
    const value = await adoptedClaudeFixture(
      "Adopted Claude recovered title",
      "personal-claude-recovered-title",
      (runtime) => {
        runtime.claimProjectionTitle = boundedProjectionTitle;
      },
      durableTitle,
    );
    await value.service.settled();

    expect(value.store.quarantineSession(value.session.id))
      .toMatchObject({ state: "recovery_required", title: durableTitle });
    await expect(value.service.execute({
      kind: "session.recover",
      session: value.session.id,
    }, { signal })).resolves.toMatchObject({
      session: { state: "idle", title: durableTitle },
      projection: { title: boundedProjectionTitle },
      recovery: { resolution: "provider_state_reconciled" },
    });

    const mutationKey = "00000000-0000-4000-8000-00000000c101";
    value.personalClaude.startTurnError = new IndeterminateCodexEffectError(
      "claude/turn",
      48,
    );
    await expect(value.service.execute({
      kind: "session.send",
      session: value.session.id,
      message: "Recover this exact mutation",
      idempotencyKey: mutationKey,
    }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(value.store.readMutation(mutationKey)).toMatchObject({ state: "ambiguous" });
    delete value.personalClaude.startTurnError;
    await expect(value.service.execute({
      kind: "session.recover",
      session: value.session.id,
    }, { signal })).resolves.toMatchObject({
      session: { title: durableTitle },
      projection: { title: boundedProjectionTitle },
      recovery: { resolution: "proven_applied", providerEffectRetried: false },
    });
    expect(value.store.requireSession(value.session.id).title).toBe(durableTitle);

    value.personalClaude.startTurnError = new IndeterminateCodexEffectError(
      "claude/turn",
      49,
    );
    const queued = await value.service.execute({
      kind: "session.queue",
      session: value.session.id,
      message: "Recover this exact queue effect",
    }, { signal }) as { queued: { id: `queue_${string}` } };
    await value.service.settled();
    expect(value.store.requireQueue(queued.queued.id)).toMatchObject({ state: "ambiguous" });
    expect(value.store.requireSession(value.session.id))
      .toMatchObject({ state: "recovery_required", title: durableTitle });
    delete value.personalClaude.startTurnError;
    await expect(value.service.execute({
      kind: "session.recover",
      session: value.session.id,
    }, { signal })).resolves.toMatchObject({
      queueId: queued.queued.id,
      session: { title: durableTitle },
      projection: { title: boundedProjectionTitle },
      recovery: { resolution: "proven_applied", providerEffectRetried: false },
    });
    expect(value.store.requireSession(value.session.id).title).toBe(durableTitle);
  });

  test("refuses a fresh Codex adoption whose claimed runtime profile uses the inactive Sol contract", async () => {
    const providerThreadId = "personal-thread-inactive-sol-runtime-profile";
    const value = await preparedPersonalCodexCandidate({
      label: "Inactive Sol runtime profile",
      providerThreadId,
      updatedAt: personalAdoptionNow - 11 * 60_000,
      liveness: "not_live",
    });
    const profile = value.store.requireProfile(value.accountId);
    const preset = value.store.readDefaultPreset("codex");
    value.personalCodex.claimRuntimeProfileOverride = {
      ...runtimeProfile({
        ...liveAuthorityFor(value.store, profile.id),
        codexHome: personalCodexHome,
        desktopUserData: join(privatePathRoot, "personal-codex-desktop"),
      }),
      preset,
      model: "gpt-5.6-sol",
      reasoningEffort: preset === "ultra" ? "ultra" : "max",
    };

    await expect(value.enable()).resolves.toMatchObject({
      discovery: { adopted: 0, failed: 1, provider: "codex" },
    });
    expect(value.personalCodex.claimRequests[0]).toMatchObject({
      preset,
      requirement: presetRequirements[preset],
    });
    expect(value.store.findSessionByProviderThread(value.accountId, providerThreadId)).toBeNull();
  });

  describe("keeps account-authority failures source-neutral for native and adopted controllers", () => {
    const shape = (error: unknown) => {
      const failure = error as CommandFailure;
      return { code: failure.code, message: failure.message, details: failure.details };
    };
    const withoutAccountIdentity = (error: unknown) => {
      const failure = shape(error);
      const details = failure.details as { accountId: string; provider: string };
      return { ...failure, details: { ...details, accountId: "<account>" } };
    };

    const expectPrivateDetailsAbsent = (failures: readonly unknown[]) => {
      for (const failure of failures) {
        const serialized = JSON.stringify(shape(failure)).toLowerCase();
        expect(serialized).not.toContain("personal");
        expect(serialized).not.toContain("managed");
        expect(serialized).not.toContain("runtimescope");
        expect(serialized).not.toContain("home");
      }
    };

    test("Codex account mismatch retains the paired controller comparison", () => ownedServiceCase(async ({ createFixture, signal }) => {
      const adopted = await adoptedCodexFixture(
        "Source-neutral adopted authority",
        "source-neutral-adopted-codex",
        undefined,
        createFixture,
      );
      signal.throwIfAborted();
      const adoptedAuthority = adopted.personalCodex.claimRequests[0]?.authority;
      if (adoptedAuthority === undefined) throw new Error("Expected adopted authority.");
      const replacementAccount = {
        signedIn: true as const,
        email: "replacement-source-neutral@example.com",
        plan: "Plus",
      };
      const adoptedMismatch = await adopted.service.observePersonalCodexAccount(
        adoptedAuthority,
        replacementAccount,
      ).catch((error: unknown) => error);

      const native = await createFixture();
      signal.throwIfAborted();
      const { sessionId } = await createIdleSession(native, "Source-neutral native authority");
      signal.throwIfAborted();
      const nativeProfile = native.store.requireProfileById(
        native.store.requireSession(sessionId).profileId,
      );
      const nativePaths = profilePaths(native.paths, nativeProfile.id);
      const nativeMismatch = await native.service.observeCodexAccount({
        ...liveAuthorityFor(native.store, nativeProfile.id),
        codexHome: nativePaths.codexHome,
        desktopUserData: nativePaths.desktopUserData,
      }, replacementAccount).catch((error: unknown) => error);
      await Promise.all([adopted.service.settled(), native.service.settled()]);

      expect(adoptedMismatch).toBeInstanceOf(CommandFailure);
      expect(nativeMismatch).toBeInstanceOf(CommandFailure);
      expect(withoutAccountIdentity(adoptedMismatch)).toEqual(
        withoutAccountIdentity(nativeMismatch),
      );
      expect(withoutAccountIdentity(adoptedMismatch)).toEqual({
        code: "RECOVERY_REQUIRED",
        message: "The provider account changed. Oompa refused stale controller authority and is releasing the affected sessions.",
        details: { accountId: "<account>", provider: "codex" },
      });
      expectPrivateDetailsAbsent([adoptedMismatch, nativeMismatch]);
    }));

    test("Claude pending release retains the paired controller comparison", () => ownedServiceCase(async ({ createFixture, signal }) => {
      const pending = await adoptedClaudeFixture(
        "Source-neutral pending authority",
        "source-neutral-pending-adopted-claude",
        undefined, undefined, "linux", true, () => personalAdoptionNow, undefined,
        createFixture,
      );
      signal.throwIfAborted();
      pending.managedClaude.projection = {
        providerThreadId: "source-neutral-pending-native-claude",
        title: "Source-neutral pending native Claude",
        status: "idle",
        projectRoot: pending.documents,
        providerUpdatedAt: personalAdoptionNow,
      };
      await pending.service.execute({
        kind: "session.start",
        account: pending.accountId,
        provider: "claude",
        preset: "fable-max",
        fast: false,
      }, { signal });
      const pendingProfile = pending.store.requireProfileById(pending.accountId);
      const direct = new Database(pending.paths.database, { create: false, strict: true });
      try {
        for (const runtimeScope of ["personal", "managed"] as const) {
          direct.query(
            `INSERT INTO provider_runtime_account_revocations(
               profile_id,profile_generation,provider,runtime_scope,current_account_key,
               state,revision,created_at,updated_at,completed_at
             ) VALUES (?,?,'claude',?,?, 'releasing',1,?,?,NULL)`,
          ).run(
            pendingProfile.id,
            pendingProfile.processGeneration,
            runtimeScope,
            claudeProviderAccountKey(),
            personalAdoptionNow,
            personalAdoptionNow,
          );
        }
      } finally {
        direct.close();
      }

      const adoptedPending = await pending.service.discoverPersonalSessions(
        "claude",
        signal,
      ).catch((error: unknown) => error);
      const nativePending = await pending.service.execute({
        kind: "session.start",
        account: pending.accountId,
        provider: "claude",
        preset: "fable-max",
        fast: false,
      }, { signal }).catch((error: unknown) => error);
      expect(adoptedPending).toBeInstanceOf(CommandFailure);
      expect(nativePending).toBeInstanceOf(CommandFailure);
      expect(shape(adoptedPending)).toEqual(shape(nativePending));
      expect(shape(adoptedPending)).toEqual({
        code: "RECOVERY_REQUIRED",
        message: "The provider account authority is being released.",
        details: { accountId: pending.accountId, provider: "claude" },
      });
      expectPrivateDetailsAbsent([adoptedPending, nativePending]);
    }));
  });

  test("routes an adopted Claude session on Darwin only through personal custody", async () => {
    const value = await adoptedClaudeFixture(
      "Adopted Claude routing",
      "same-opaque-claude-thread",
      undefined,
      undefined,
      "darwin",
    );

    expect(value.enabled).toMatchObject({
      providers: [{ provider: "claude", enabled: true, adopted: 1 }],
      discovery: { provider: "claude", state: "ready", adopted: 1 },
    });
    expect(value.personalClaude.claimRequests[0]).toMatchObject({
      authority: { id: value.accountId, codexHome: personalCodexHome },
      providerThreadId: "same-opaque-claude-thread",
      preset: "fable-max",
      requirement: presetRequirements["fable-max"],
      fast: false,
      sourceLiveness: "not_live",
      title: "Adopted Claude routing personal thread",
    });
    expect(value.store.requireSessionPresetRequirement(value.session.id)).toEqual({
      preset: "fable-max",
      requirement: presetRequirements["fable-max"],
    });
    expect(value.store.latestSessionRuntimeProfile(value.session.id)).toMatchObject({
      profile: {
        configHome: "personal",
        preset: "fable-max",
      },
    });
    const shown = await value.service.execute({
      kind: "session.show",
      session: value.session.id,
      detail: false,
    }, { signal }) as {
      effectiveRuntimeProfile: Record<string, unknown>;
      projection: { title: string };
      session: { title: string };
    };
    expect(shown).toMatchObject({
      projection: { title: "Adopted Claude routing personal thread" },
      session: { title: "Adopted Claude routing personal thread" },
    });
    expect(shown.effectiveRuntimeProfile).not.toHaveProperty("configHome");
    expect(shown.effectiveRuntimeProfile).not.toHaveProperty("isolatedConfigDir");
    expect(value.store.readClaudeProcessAuthority({
      providerThreadId: "same-opaque-claude-thread",
      profileId: value.accountId,
      runtimeScope: "personal",
    })).toMatchObject({
      sessionId: value.session.id,
      state: "bound",
      identity: value.personalIdentity,
    });

    const listed = await value.service.execute({
      kind: "session.list",
      archived: false,
      account: value.accountId,
      limit: 1,
    }, { signal }) as { sessions: readonly Record<string, unknown>[] };
    expect(listed.sessions).toEqual([expect.objectContaining({
      id: value.session.id,
      provider: "claude",
      providerThreadId: "same-opaque-claude-thread",
    })]);
    expect(listed.sessions[0]).not.toHaveProperty("adopted");
    expect(listed.sessions[0]).not.toHaveProperty("origin");

    value.store.recordClaimedClaudeProcessAuthority({
      providerAuthority: value.store.requireProviderAccountAuthority(value.accountId, "claude"),
      providerThreadId: "same-opaque-claude-thread",
      profileId: value.accountId,
      profileGeneration: value.store.requireProfileById(value.accountId).processGeneration,
      runtimeScope: "managed",
      identity: value.managedClaude.processIdentity,
    });
    const sent = await value.service.execute({
      kind: "session.send",
      session: value.session.id,
      message: "Continue the adopted Claude conversation",
      idempotencyKey: "00000000-0000-4000-8000-00000000c001",
    }, { signal }) as {
      effectiveRuntimeProfile: Record<string, unknown>;
      session: { id: string; state: string; title: string };
    };
    expect(sent).toMatchObject({
      session: { id: value.session.id, state: "idle" },
    });
    expect(sent.session.title).toBe("Adopted Claude routing personal thread");
    expect(sent.effectiveRuntimeProfile).not.toHaveProperty("configHome");
    expect(sent.effectiveRuntimeProfile).not.toHaveProperty("isolatedConfigDir");
    expect(value.personalClaude.turnRequests).toHaveLength(1);
    expect(value.personalClaude.turnRequests[0]?.authority.codexHome).toBe(personalCodexHome);
    expect(value.managedClaude.turnRequests).toHaveLength(0);

  });

  test("autoresponds on Darwin to adopted Claude approval authority through its personal controller", async () => {
    const value = await adoptedClaudeFixture(
      "Adopted Claude approval",
      "personal-claude-approval",
      undefined,
      undefined,
      "darwin",
    );
    value.store.setDefaultApprovalMode("auto:all");
    const authority = value.personalClaude.claimRequests[0]?.authority;
    if (authority === undefined) throw new Error("Expected personal Claude authority.");
    const requestId = "adopted-claude-approval-request";

    await value.service.observePersonalClaudeFact(authority, {
      providerThreadId: "personal-claude-approval",
      connectionId: value.personalClaude.observationConnectionId,
      type: "interactionRequested",
      requestId,
      turnId: "claude-turn-approval",
      itemId: "claude-item-approval",
      kind: "command_approval",
      blocking: true,
      display: {
        kind: "command_approval",
        summary: "Run the adopted Claude test",
        reason: null,
        commandClass: "bun test",
        workingDirectory: null,
        availableDecisions: ["once", "session", "decline", "cancel"],
      },
      request: {
        blockedPath: null,
        decisionReasonType: null,
        description: "Run the adopted Claude test",
        displayName: "Bash",
        input: { command: "bun test" },
        permissionSuggestionCount: 0,
        questions: null,
        requiresUserInteraction: false,
        subtype: "can_use_tool",
        toolName: "Bash",
        toolUseId: "claude-item-approval",
      },
    });

    await waitFor(() => value.personalClaude.resolvedInteractions.length === 1);
    expect(value.personalClaude.validatedInteractions).toHaveLength(1);
    expect(value.personalClaude.resolvedInteractions[0]).toMatchObject({
      authority: { id: value.accountId, codexHome: personalCodexHome },
      kind: "command_approval",
      resolution: { kind: "approval_decision", decision: "once" },
    });
    expect(value.managedClaude.validatedInteractions).toHaveLength(0);
    expect(value.managedClaude.resolvedInteractions).toHaveLength(0);
    const interaction = value.store.listInteractions({
      sessionId: value.session.id,
      limit: 10,
    }).find((candidate) => candidate.authority.requestId.value === requestId);
    expect(interaction).toMatchObject({
      resolvedBy: "autorespond",
      sessionId: value.session.id,
    });
    expect(interaction?.state).not.toBe("pending");
  });

  test("adopts, operates, and autoresponds on Darwin through personal Claude while Codex is signed out", async () => {
    const value = await adoptedClaudeFixture(
      "Signed-out adopted Claude parity",
      "signed-out-personal-claude-approval",
      undefined,
      undefined,
      "darwin",
      false,
    );
    expect(value.store.requireProfileById(value.accountId).state).toBe("signed_out");
    value.store.setDefaultApprovalMode("auto:all");

    await expect(value.service.execute({
      kind: "session.send",
      session: value.session.id,
      message: "Continue with provider-specific Claude authority",
      idempotencyKey: "00000000-0000-4000-8000-00000000c002",
    }, { signal })).resolves.toMatchObject({
      session: { id: value.session.id },
    });

    const authority = value.personalClaude.claimRequests[0]?.authority;
    if (authority === undefined) throw new Error("Expected personal Claude authority.");
    const requestId = "signed-out-adopted-claude-approval";
    await value.service.observePersonalClaudeFact(authority, {
      providerThreadId: "signed-out-personal-claude-approval",
      connectionId: value.personalClaude.observationConnectionId,
      type: "interactionRequested",
      requestId,
      turnId: "signed-out-adopted-turn",
      itemId: "signed-out-adopted-item",
      kind: "command_approval",
      blocking: true,
      display: {
        kind: "command_approval",
        summary: "Run the signed-out adopted Claude test",
        reason: null,
        commandClass: "bun test",
        workingDirectory: null,
        availableDecisions: ["once", "session", "decline", "cancel"],
      },
      request: {
        blockedPath: null,
        decisionReasonType: null,
        description: "Run the signed-out adopted Claude test",
        displayName: "Bash",
        input: { command: "bun test" },
        permissionSuggestionCount: 0,
        questions: null,
        requiresUserInteraction: false,
        subtype: "can_use_tool",
        toolName: "Bash",
        toolUseId: "signed-out-adopted-item",
      },
    });

    await waitFor(() => value.personalClaude.resolvedInteractions.length === 1);
    expect(value.personalClaude.resolvedInteractions[0]).toMatchObject({
      authority: { id: value.accountId, codexHome: personalCodexHome },
      resolution: { kind: "approval_decision", decision: "once" },
    });
    expect(value.managedClaude.resolvedInteractions).toHaveLength(0);
    expect(value.store.listInteractions({
      sessionId: value.session.id,
      limit: 10,
    }).some((interaction) =>
      interaction.resolvedBy === "autorespond"
      && interaction.state === "response_written")).toBe(true);
    value.store.setDefaultApprovalMode("manual");
    const manualRequestId = "signed-out-adopted-claude-manual";
    await value.service.observePersonalClaudeFact(authority, {
      providerThreadId: "signed-out-personal-claude-approval",
      connectionId: value.personalClaude.observationConnectionId,
      type: "interactionRequested",
      requestId: manualRequestId,
      turnId: "signed-out-adopted-manual-turn",
      itemId: "signed-out-adopted-manual-item",
      kind: "command_approval",
      blocking: true,
      display: {
        kind: "command_approval",
        summary: "Inspect and resolve signed-out adopted Claude authority",
        reason: null,
        commandClass: "bun test",
        workingDirectory: null,
        availableDecisions: ["once", "session", "decline", "cancel"],
      },
      request: {
        blockedPath: null,
        decisionReasonType: null,
        description: "Inspect and resolve signed-out adopted Claude authority",
        displayName: "Bash",
        input: { command: "bun test" },
        permissionSuggestionCount: 0,
        questions: null,
        requiresUserInteraction: false,
        subtype: "can_use_tool",
        toolName: "Bash",
        toolUseId: "signed-out-adopted-manual-item",
      },
    });
    const manualInteraction = value.store.listInteractions({
      sessionId: value.session.id,
      pendingOnly: true,
      limit: 10,
    }).find((candidate) => candidate.authority.requestId.value === manualRequestId);
    if (manualInteraction === undefined) {
      throw new Error("Expected a manual adopted Claude interaction.");
    }
    await expect(value.service.execute({
      kind: "interaction.inspect",
      interaction: manualInteraction.publicId,
      expectedRevision: manualInteraction.revision,
    }, { signal })).resolves.toMatchObject({
      binding: { interactionId: manualInteraction.publicId },
      authority: { kind: "command_approval", command: "bun test" },
    });
    await expect(value.service.execute({
      kind: "interaction.resolve",
      interaction: manualInteraction.publicId,
      expectedRevision: manualInteraction.revision,
      resolution: { kind: "approval_decision", decision: "once" },
    }, { signal })).resolves.toMatchObject({
      responseWritten: true,
      interaction: { state: "response_written" },
    });
    expect(value.personalClaude.inspectedInteractions).toHaveLength(1);
    expect(value.personalClaude.resolvedInteractions).toHaveLength(2);
    await value.service.observePersonalClaudeFact(authority, {
      providerThreadId: "signed-out-personal-claude-approval",
      connectionId: value.personalClaude.observationConnectionId,
      type: "interactionCanceled",
      requestId: manualRequestId,
    });
    expect(value.store.requireInteraction(manualInteraction.publicId).state).toBe("resolved");
    expect(value.store.requireProfileById(value.accountId).state).toBe("signed_out");
  });

  test("starts, operates, and autoresponds through managed Claude while Codex is signed out", async () => {
    const value = await nativeClaudeFixture(
      "Signed-out native Claude parity",
      "signed-out-native-claude",
      {
        pid: 63_028,
        pidDomain: "darwin",
        procStart: "signed-out-native-claude-process",
      },
      undefined,
      false,
    );
    const profile = value.store.requireProfileById(value.accountId);
    expect(profile.state).toBe("signed_out");
    value.store.setDefaultApprovalMode("auto:all");

    await expect(value.service.execute({
      kind: "session.send",
      session: value.session.id,
      message: "Continue with managed Claude authority",
      idempotencyKey: "00000000-0000-4000-8000-00000000c003",
    }, { signal })).resolves.toMatchObject({
      session: { id: value.session.id },
    });

    const authority = liveAuthorityFor(value.store, profile.id, "claude");
    const requestId = "signed-out-native-claude-approval";
    await value.service.observeClaudeFact(authority, {
      providerThreadId: value.providerThreadId,
      connectionId: value.managedClaude.observationConnectionId,
      type: "interactionRequested",
      requestId,
      turnId: "signed-out-native-turn",
      itemId: "signed-out-native-item",
      kind: "command_approval",
      blocking: true,
      display: {
        kind: "command_approval",
        summary: "Run the signed-out native Claude test",
        reason: null,
        commandClass: "bun test",
        workingDirectory: null,
        availableDecisions: ["once", "session", "decline", "cancel"],
      },
      request: {
        blockedPath: null,
        decisionReasonType: null,
        description: "Run the signed-out native Claude test",
        displayName: "Bash",
        input: { command: "bun test" },
        permissionSuggestionCount: 0,
        questions: null,
        requiresUserInteraction: false,
        subtype: "can_use_tool",
        toolName: "Bash",
        toolUseId: "signed-out-native-item",
      },
    });

    await waitFor(() => value.managedClaude.resolvedInteractions.length === 1);
    expect(value.managedClaude.resolvedInteractions[0]).toMatchObject({
      authority: { id: value.accountId },
      resolution: { kind: "approval_decision", decision: "once" },
    });
    expect(value.store.listInteractions({
      sessionId: value.session.id,
      limit: 10,
    }).some((interaction) =>
      interaction.resolvedBy === "autorespond"
      && interaction.state === "response_written")).toBe(true);
    value.store.setDefaultApprovalMode("manual");
    const manualRequestId = "signed-out-native-claude-manual";
    await value.service.observeClaudeFact(authority, {
      providerThreadId: value.providerThreadId,
      connectionId: value.managedClaude.observationConnectionId,
      type: "interactionRequested",
      requestId: manualRequestId,
      turnId: "signed-out-native-manual-turn",
      itemId: "signed-out-native-manual-item",
      kind: "command_approval",
      blocking: true,
      display: {
        kind: "command_approval",
        summary: "Inspect and resolve signed-out Claude authority",
        reason: null,
        commandClass: "bun test",
        workingDirectory: null,
        availableDecisions: ["once", "session", "decline", "cancel"],
      },
      request: {
        blockedPath: null,
        decisionReasonType: null,
        description: "Inspect and resolve signed-out Claude authority",
        displayName: "Bash",
        input: { command: "bun test" },
        permissionSuggestionCount: 0,
        questions: null,
        requiresUserInteraction: false,
        subtype: "can_use_tool",
        toolName: "Bash",
        toolUseId: "signed-out-native-manual-item",
      },
    });
    const manualInteraction = value.store.listInteractions({
      sessionId: value.session.id,
      pendingOnly: true,
      limit: 10,
    }).find((candidate) => candidate.authority.requestId.value === manualRequestId);
    if (manualInteraction === undefined) throw new Error("Expected a manual Claude interaction.");
    await expect(value.service.execute({
      kind: "interaction.inspect",
      interaction: manualInteraction.publicId,
      expectedRevision: manualInteraction.revision,
    }, { signal })).resolves.toMatchObject({
      binding: { interactionId: manualInteraction.publicId },
      authority: { kind: "command_approval", command: "bun test" },
    });
    await expect(value.service.execute({
      kind: "interaction.resolve",
      interaction: manualInteraction.publicId,
      expectedRevision: manualInteraction.revision,
      resolution: { kind: "approval_decision", decision: "once" },
    }, { signal })).resolves.toMatchObject({
      responseWritten: true,
      interaction: { state: "response_written" },
    });
    expect(value.managedClaude.inspectedInteractions).toHaveLength(1);
    expect(value.managedClaude.resolvedInteractions).toHaveLength(2);
    await value.service.observeClaudeFact(authority, {
      providerThreadId: value.providerThreadId,
      connectionId: value.managedClaude.observationConnectionId,
      type: "interactionCanceled",
      requestId: manualRequestId,
    });
    expect(value.store.requireInteraction(manualInteraction.publicId).state).toBe("resolved");
    const observationsBeforeDisconnect = value.managedClaude.observeRequests.length;
    await value.service.observeClaudeFact(authority, {
      type: "providerDisconnected",
      providerThreadId: value.providerThreadId,
      connectionId: value.managedClaude.observationConnectionId,
      reason: "eof",
    });
    await waitFor(() =>
      value.managedClaude.observeRequests.length > observationsBeforeDisconnect);
    expect(value.store.readClaudeProcessAuthority({
      providerThreadId: value.providerThreadId,
      profileId: value.accountId,
      runtimeScope: "managed",
    })).toMatchObject({ state: "bound", sessionId: value.session.id });
    expect(value.store.requireProfileById(value.accountId).state).toBe("signed_out");
  });

  test("replays a dedicated switch from personal Claude after committed seed response loss", async () => {
    const value = await adoptedClaudeFixture(
      "Adopted Claude dedicated switch",
      "adopted-claude-dedicated-source",
    );
    const personalAuthority = value.store.requireSessionProviderAuthority(value.session.id);
    expect(personalAuthority.processGeneration).toBeGreaterThan(0);
    expect(value.store.requireProviderAccount(personalAuthority.providerAccountId).readiness)
      .toBe("unverified");
    const command = {
      idempotencyKey: crypto.randomUUID(),
      kind: "session.switch" as const,
      presetContract: currentPresetContract,
      provider: "codex" as const,
      session: value.session.id,
    };
    const complete = value.store.completeSessionSwitchSeed.bind(value.store);
    Object.defineProperty(value.store, "completeSessionSwitchSeed", {
      configurable: true,
      value: (input: Parameters<StateStore["completeSessionSwitchSeed"]>[0]) => {
        complete(input);
        throw new Error("simulated response loss after the durable seed receipt");
      },
    });
    try {
      await expect(value.service.execute({
        idempotencyKey: command.idempotencyKey,
        kind: "session.switch",
        presetContract: currentPresetContract,
        provider: "codex",
        session: value.session.id,
      }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    } finally {
      Object.defineProperty(value.store, "completeSessionSwitchSeed", {
        configurable: true, value: complete,
      });
    }
    const settled = value.store.readSessionSwitchByIdempotencyKey(command.idempotencyKey);
    if (settled === null) throw new Error("Expected the dedicated switch journal.");
    expect(settled.phase).toBe("seed_settled");
    expect(value.store.readSessionSwitchAdoption(settled.attemptId)).toMatchObject({
      sourceRuntimeScope: "personal",
      sourcePersonalBindingRevision: expect.any(Number),
      targetAccountKey: codexProviderAccountKey(),
    });
    expect(value.store.readSessionPersonalRuntimeBinding(value.session.id, true))
      .toMatchObject({ provider: "claude", providerThreadId: "adopted-claude-dedicated-source", state: "detached" });
    expect(value.codex.committedStartTurns).toBe(1);
    expect(value.personalClaude.endRequests).toHaveLength(1);
    const calls = {
      codex: [...value.codex.calls],
      managedClaude: [...value.managedClaude.calls],
      personalClaude: [...value.personalClaude.calls],
    };
    await expect(value.service.execute(command, { signal })).resolves.toMatchObject({
      session: { id: value.session.id, provider: "codex" },
      seed: { delivered: true },
    });
    expect({
      codex: value.codex.calls,
      managedClaude: value.managedClaude.calls,
      personalClaude: value.personalClaude.calls,
    }).toEqual(calls);
    expect(value.codex.committedStartTurns).toBe(1);
    await value.service.close();
  });

  test("quarantines a real canonical-40 target-bound personal-source switch without inventing Claude authority", async () => {
    const origin = canonicalAdoption40Fixture;
    const home = await realpath(await mkdtemp(join(tmpdir(), "oompa-canonical40-switch-")));
    serviceRoots.push(home);
    const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
    await initializeStatePaths(paths);
    await writeFile(paths.database, canonicalAdoption40DatabaseBytes(), { mode: 0o600 });
    // A fully checkpointed WAL-mode image has no copied -shm file. Let SQLite
    // initialize its local auxiliaries, then enforce read-only SQL inspection.
    const raw = new Database(paths.database, { create: false, strict: true });
    raw.exec("PRAGMA query_only=ON");
    const before = raw.query(
      "SELECT evidence_json,evidence_digest FROM mutation_effect_evidence WHERE attempt_id=?",
    ).get(origin.attemptId);
    expect(raw.query("PRAGMA user_version").get()).toEqual({ user_version: 40 });
    expect(raw.query(
      "SELECT state,provider,provider_thread_id FROM session_personal_runtime_bindings WHERE session_id=?",
    ).get(origin.sessionId)).toEqual({
      state: "detached", provider: "claude", provider_thread_id: origin.sourceThread,
    });
    raw.close();
    const store = new StateStore(paths, { now: () => personalAdoptionNow });
    stores.push(store);
    const migrated = new Database(paths.database, { readonly: true, strict: true });
    expect(migrated.query("PRAGMA user_version").get()).toEqual({ user_version: 61 });
    expect(migrated.query(
      "SELECT evidence_json,evidence_digest FROM mutation_effect_evidence WHERE attempt_id=?",
    ).get(origin.attemptId)).toEqual(before);
    migrated.close();
    expect(store.readMutation(origin.idempotencyKey)).toMatchObject({
      id: origin.attemptId, state: "ambiguous", evidence: { digest: origin.evidenceDigest },
    });
    expect(JSON.stringify(store.readSessionProviderSwitchProgress(origin.attemptId)))
      .toBe(JSON.stringify(origin.progress));
    const codex = new FakeCodex();
    codex.accountProjection = { signedIn: true, email: "canonical40-fixture@example.com", plan: "Plus" };
    codex.readProjection = {
      providerThreadId: origin.targetThread, status: "idle", title: "Canonical 40 personal source",
      providerUpdatedAt: personalAdoptionNow,
    };
    const personalClaude = new FakeClaude("personal", {
      pid: 63040, pidDomain: "darwin", procStart: "canonical40-fixture-process",
    });
    const service = new OompaService({
      store, paths, codex, personalClaude, cloud: new FakeCloud(),
      daemonAuthority: new FakeDaemonAuthority(), daemonGeneration: 1,
      daemonBootId: `boot_${"6".repeat(32)}`,
      eventCursors: new SessionEventCursorCodec(SessionEventCursorCodec.generateKey()),
      now: () => personalAdoptionNow, requestStop: () => undefined,
    });
    // The released source proves only Claude's shared profile-generation
    // shadow. Target Codex evidence cannot manufacture the absent independent
    // source tuple or authorize settlement of the entire historical switch.
    expect(store.hasUnsettledLegacyProviderAuthorityQuarantineForSession(origin.sessionId)).toBe(true);
    await expect(service.execute({
      kind: "session.recover", session: origin.sessionId,
    }, { signal })).rejects.toMatchObject({
      code: "RECOVERY_REQUIRED",
      message: expect.stringContaining("no provable provider-account authority"),
    });
    expect(store.readMutation(origin.idempotencyKey)).toMatchObject({
      state: "ambiguous", evidence: { digest: origin.evidenceDigest },
    });
    expect(JSON.stringify(store.readSessionProviderSwitchProgress(origin.attemptId)))
      .toBe(JSON.stringify(origin.progress));
    expect(store.requireSession(origin.sessionId)).toMatchObject({
      provider: "codex", providerThreadId: origin.targetThread, state: "recovery_required",
    });
    expect(codex.committedStartTurns).toBe(0);
    expect(codex.calls).toEqual([]);
    expect(personalClaude.calls).toEqual([]);
    expect(personalClaude.endRequests).toEqual([]);
    expect(store.readSessionPersonalRuntimeBinding(origin.sessionId, true))
      .toMatchObject({ provider: "claude", providerThreadId: origin.sourceThread, state: "detached" });
    await service.close();
  });

  test("acknowledges only the exact completed provider switch after its response is lost", async () => {
    const value = await adoptedClaudeFixture(
      "Completed Claude switch acknowledgement",
      "completed-claude-switch-source",
    );
    const idempotencyKey = crypto.randomUUID();
    const complete = value.store.completeSessionProviderSwitch.bind(value.store);
    Object.defineProperty(value.store, "completeSessionProviderSwitch", {
      configurable: true,
      value: (input: Parameters<StateStore["completeSessionProviderSwitch"]>[0]) => {
        complete(input);
        throw new Error("simulated lost provider-switch response");
      },
    });
    try {
      const outcome = await value.service.execute({
        idempotencyKey,
        kind: "session.switch",
        presetContract: currentPresetContract,
        provider: "codex",
        session: value.session.id,
      }, { signal }).catch((error: unknown) => ({
        error,
        mutation: value.store.readMutation(idempotencyKey),
      }));
      expect(outcome).toMatchObject({
        idempotencyKey,
        session: { id: value.session.id, provider: "codex" },
        from: { provider: "claude" },
        to: { provider: "codex" },
        seed: { delivered: true },
      });
    } finally {
      Object.defineProperty(value.store, "completeSessionProviderSwitch", {
        configurable: true,
        value: complete,
      });
    }

    expect(value.store.readMutation(idempotencyKey)).toMatchObject({
      authorityId: value.session.id,
      idempotencyKey,
      kind: "session.switch",
      state: "applied",
    });
    expect(value.store.requireSession(value.session.id)).toMatchObject({
      provider: "codex",
      state: "active",
    });
  });

  test("recovers an adopted Claude session after clean restart from released process custody", async () => {
    const value = await adoptedClaudeFixture(
      "Adopted Claude restart",
      "personal-claude-restart",
    );
    const oldAuthority = value.store.readClaudeProcessAuthority({
      providerThreadId: "personal-claude-restart",
      profileId: value.accountId,
      runtimeScope: "personal",
    });
    if (oldAuthority === null) throw new Error("Expected initial Claude process authority.");
    const oldGeneration = value.store.requireProfileById(value.accountId).processGeneration;
    const oldClaudeAuthority = value.store.requireProviderAccountAuthority(value.accountId, "claude");
    await value.service.close();
    expect(value.store.requireProfileById(value.accountId).processGeneration)
      .toBe(oldGeneration + 1);
    expect(value.store.readSessionPersonalRuntimeBinding(value.session.id))
      .toMatchObject({ state: "active" });
    const daemonBootId = `boot_${crypto.randomUUID().replaceAll("-", "")}`;
    const daemonGeneration = value.store.nextDaemonGeneration(daemonBootId);
    const restartedClaudeAuthority = value.store.requireProviderAccountAuthority(value.accountId, "claude");
    expect(restartedClaudeAuthority.processGeneration).toBe(oldClaudeAuthority.processGeneration + 1);

    const restartedPersonal = new FakeClaude("personal", {
      pid: 63_003,
      pidDomain: "darwin",
      procStart: "personal-claude-restarted",
    });
    restartedPersonal.projection = {
      ...value.personalClaude.projection,
      providerThreadId: "personal-claude-restart",
      status: "idle",
    };
    restartedPersonal.readIdentityErrorOnce = new Error("prior child is gone");
    restartedPersonal.observeErrorOnce = new ClaudeSessionObservationError();
    const restartedManaged = new FakeClaude("isolated", {
      pid: 63_004,
      pidDomain: "darwin",
      procStart: "managed-claude-restarted",
    });
    const livenessChecks: Array<Parameters<ClaudeProcessLivenessProbe>[0]> = [];
    const restarted = new OompaService({
      store: value.store,
      daemonGeneration,
      daemonBootId,
      paths: value.paths,
      codex: new FakeCodex(),
      claude: restartedManaged,
      personalClaude: restartedPersonal,
      personalCodexHome,
      claudeProcessLiveness: (identity) => {
        livenessChecks.push(identity);
        return Promise.resolve("not_live");
      },
      cloud: new FakeCloud(),
      daemonAuthority: new FakeDaemonAuthority(),
      eventCursors: value.eventCursors,
      now: () => personalAdoptionNow,
      requestStop: () => undefined,
    });
    await expect(restarted.recover()).resolves.toBeUndefined();
    await restarted.settled();

    // The prior service closed the exact child successfully and durably
    // released its process row before generation rollover. Restart therefore
    // needs no second OS liveness inference for that already-proven exit.
    expect(livenessChecks).toEqual([]);
    expect(restartedPersonal.endRequests).toHaveLength(0);
    expect(restartedManaged.calls).toEqual([]);
    expect(restartedPersonal.claimRequests).toHaveLength(1);
    expect(restartedPersonal.claimRequests[0]).toMatchObject({
      authority: {
        id: value.accountId,
        provider: "claude",
        providerAccountId: restartedClaudeAuthority.providerAccountId,
        bindingGeneration: restartedClaudeAuthority.bindingGeneration,
        generation: restartedClaudeAuthority.processGeneration,
        codexHome: personalCodexHome,
      },
      providerThreadId: "personal-claude-restart",
      sourceLiveness: "not_live",
      title: "Adopted Claude restart personal thread",
    });
    expect(value.store.readClaudeProcessAuthority({
      providerThreadId: "personal-claude-restart",
      profileId: value.accountId,
      runtimeScope: "personal",
    })).toMatchObject({
      identity: restartedPersonal.processIdentity,
      profileGeneration: value.store.requireProfileById(value.accountId).processGeneration,
      providerAuthority: restartedClaudeAuthority,
      sessionId: value.session.id,
      state: "bound",
    });
    expect(value.store.readSessionPersonalRuntimeBinding(value.session.id))
      .toMatchObject({ state: "active" });
    const shownAfterRestart = await restarted.execute({
      kind: "session.show",
      session: value.session.id,
      detail: false,
    }, { signal }) as {
      effectiveRuntimeProfile: Record<string, unknown>;
      projection: { title: string };
      session: { title: string };
    };
    expect(shownAfterRestart).toMatchObject({
      projection: { title: "Adopted Claude restart personal thread" },
      session: { title: "Adopted Claude restart personal thread" },
    });
    expect(shownAfterRestart.effectiveRuntimeProfile).not.toHaveProperty("configHome");

    await expect(restarted.execute({
      kind: "session.send",
      session: value.session.id,
      message: "Continue after restart",
      idempotencyKey: "00000000-0000-4000-8000-00000000c002",
    }, { signal })).resolves.toMatchObject({
      session: { id: value.session.id, state: "idle" },
    });
    expect(restartedPersonal.turnRequests).toHaveLength(1);
    expect(restartedManaged.turnRequests).toHaveLength(0);
    await restarted.close();
  });

  test("clean shutdown retires adopted Claude while preserving zero-generation Codex and pristine providers", async () => {
    const value = await adoptedClaudeFixture(
      "Generation-zero adopted Claude shutdown",
      "generation-zero-personal-claude-shutdown",
      undefined,
      undefined,
      "darwin",
      false,
    );
    const pristine = await value.service.execute({
      kind: "account.add",
      label: "Pristine generation-zero account",
    }, { signal }) as { account: { id: `acct_${string}` } };
    expect(value.store.requireProfileById(value.accountId)).toMatchObject({
      processGeneration: 0,
      state: "signed_out",
    });
    expect(value.store.requireProfileById(pristine.account.id)).toMatchObject({
      processGeneration: 0,
      state: "signed_out",
    });
    const claudeBefore = value.store.requireProviderAccountAuthority(value.accountId, "claude");
    expect(claudeBefore.processGeneration).toBeGreaterThan(0);

    await expect(value.service.close()).resolves.toBeUndefined();

    expect(value.store.requireProfileById(value.accountId)).toMatchObject({
      processGeneration: 0,
      state: "signed_out",
    });
    expect(value.store.requireProfileById(pristine.account.id)).toMatchObject({
      processGeneration: 0,
      state: "signed_out",
    });
    expect(value.store.readSessionPersonalRuntimeBinding(value.session.id)).toMatchObject({
      state: "active",
    });
    expect(value.store.readClaudeProcessAuthority({
      providerThreadId: "generation-zero-personal-claude-shutdown",
      profileId: value.accountId,
      runtimeScope: "personal",
    })).toMatchObject({
      profileGeneration: 0,
      sessionId: value.session.id,
      state: "released",
    });
    expect(value.store.requireProviderAccountAuthority(value.accountId, "claude").processGeneration)
      .toBe(claudeBefore.processGeneration);
    expect(value.store.requireProviderAccountAuthority(pristine.account.id, "claude").processGeneration)
      .toBe(0);
    const daemonBootId = `boot_${crypto.randomUUID().replaceAll("-", "")}`;
    const daemonGeneration = value.store.nextDaemonGeneration(daemonBootId);
    const restartedClaudeAuthority = value.store.requireProviderAccountAuthority(value.accountId, "claude");
    expect(restartedClaudeAuthority.processGeneration).toBe(claudeBefore.processGeneration + 1);

    const restartedPersonal = new FakeClaude("personal", {
      pid: 63_029,
      pidDomain: "darwin",
      procStart: "generation-one-personal-claude",
    });
    restartedPersonal.projection = {
      ...value.personalClaude.projection,
      providerThreadId: "generation-zero-personal-claude-shutdown",
      status: "idle",
    };
    restartedPersonal.readIdentityErrorOnce = new Error("prior child is gone");
    restartedPersonal.observeErrorOnce = new ClaudeSessionObservationError();
    const restarted = new OompaService({
      store: value.store,
      daemonGeneration,
      daemonBootId,
      paths: value.paths,
      codex: new FakeCodex(),
      claude: new FakeClaude("isolated", {
        pid: 63_030,
        pidDomain: "darwin",
        procStart: "generation-one-managed-claude",
      }),
      personalClaude: restartedPersonal,
      personalCodexHome,
      claudeProcessLiveness: () => Promise.resolve("not_live"),
      cloud: new FakeCloud(),
      daemonAuthority: new FakeDaemonAuthority(),
      eventCursors: value.eventCursors,
      now: () => personalAdoptionNow,
      requestStop: () => undefined,
    });
    await expect(restarted.recover()).resolves.toBeUndefined();
    await restarted.settled();

    expect(restartedPersonal.claimRequests).toHaveLength(1);
    expect(restartedPersonal.claimRequests[0]).toMatchObject({
      authority: {
        id: value.accountId, generation: restartedClaudeAuthority.processGeneration,
        provider: "claude", providerAccountId: restartedClaudeAuthority.providerAccountId,
        bindingGeneration: restartedClaudeAuthority.bindingGeneration, codexHome: personalCodexHome,
      },
      providerThreadId: "generation-zero-personal-claude-shutdown",
    });
    expect(value.store.readClaudeProcessAuthority({
      providerThreadId: "generation-zero-personal-claude-shutdown",
      profileId: value.accountId,
      runtimeScope: "personal",
    })).toMatchObject({
      identity: restartedPersonal.processIdentity,
      profileGeneration: value.store.requireProfileById(value.accountId).processGeneration,
      providerAuthority: restartedClaudeAuthority,
      sessionId: value.session.id,
      state: "bound",
    });
    await restarted.close();
  });

  test("releases and resumes an adopted Claude controller lost between claim and commit", async () => {
    const value = await adoptedClaudeFixture(
      "Adopted Claude admission race",
      "personal-claude-admission-race",
      (runtime) => { runtime.disconnectOnObserveRequest = 2; },
    );
    await value.service.settled();

    expect(value.personalClaude.endRequests).toHaveLength(1);
    expect(value.personalClaude.claimRequests).toHaveLength(2);
    expect(value.personalClaude.claimRequests[1]).toMatchObject({
      providerThreadId: "personal-claude-admission-race",
      sourceLiveness: "not_live",
      title: "Adopted Claude admission race personal thread",
    });
    expect(value.store.readClaudeProcessAuthority({
      providerThreadId: "personal-claude-admission-race",
      profileId: value.accountId,
      runtimeScope: "personal",
    })).toMatchObject({
      sessionId: value.session.id,
      state: "bound",
    });
    expect(value.store.readSessionPersonalRuntimeBinding(value.session.id))
      .toMatchObject({ state: "active" });

    await expect(value.service.execute({
      kind: "session.send",
      session: value.session.id,
      message: "Continue after admission recovery",
      idempotencyKey: "00000000-0000-4000-8000-00000000c003",
    }, { signal })).resolves.toMatchObject({
      session: {
        id: value.session.id,
        state: "idle",
        title: "Adopted Claude admission race personal thread",
      },
    });
    await value.service.close();
  });

  test("retires a daemon generation without detaching adopted sessions", async () => {
    const value = await adoptedCodexFixture(
      "Adopted restart",
      "personal-thread-restart",
    );
    const before = value.store.requireProfileById(value.accountId).processGeneration;

    await expect(value.service.close()).resolves.toBeUndefined();

    expect(value.store.requireProfileById(value.accountId).processGeneration).toBe(before + 1);
    expect(value.store.readSessionPersonalRuntimeBinding(value.session.id)).toMatchObject({
      state: "active",
    });
    const daemonBootId = `boot_${crypto.randomUUID().replaceAll("-", "")}`;
    const daemonGeneration = value.store.nextDaemonGeneration(daemonBootId);
    const authority = value.store.requireSessionProviderAuthority(value.session.id);
    expect(authority).toMatchObject({ provider: "codex", processGeneration: before + 2,
      routingProvenance: "explicit", appliedPointerRevision: null });
    const personalCodex = new FakeCodex();
    personalCodex.readProjection = { ...value.personalCodex.readProjection };
    const managedCodex = new FakeCodex();
    const restarted = new OompaService({ store: value.store, paths: value.paths,
      daemonGeneration, daemonBootId, codex: managedCodex, personalCodex, personalCodexHome,
      cloud: new FakeCloud(), daemonAuthority: new FakeDaemonAuthority(),
      eventCursors: value.eventCursors, now: () => personalAdoptionNow,
      requestStop: () => undefined });
    await restarted.recover();
    await expect(restarted.execute({ kind: "session.send", session: value.session.id,
      message: "Continue the personal Codex session after restart",
      idempotencyKey: "00000000-0000-4000-8000-00000000c105" }, { signal }))
      .resolves.toMatchObject({ session: { id: value.session.id, state: "active", activeTurnId: "turn-next" } });
    expect(personalCodex.committedStartTurns).toBe(1);
    expect(managedCodex.committedStartTurns).toBe(0);
    expect(value.store.readSessionPersonalRuntimeBinding(value.session.id)).toMatchObject({ state: "active" });
    await restarted.close();
  });

  test("terminalizes an adopted Codex session task and releases personal custody on provider deletion", async () => {
    const providerThreadId = "personal-thread-deleted-with-task";
    const value = await adoptedCodexFixture(
      "Adopted deletion with task",
      providerThreadId,
    );
    const authority = value.personalCodex.claimRequests[0]?.authority;
    if (authority === undefined) throw new Error("Expected personal claim authority.");
    const taskStore = value.store.createSessionTaskStore();
    const activeTask = taskStore.create({
      sessionId: value.session.id,
      name: "Adopted session task",
      prompt: "Must not run after the personal provider deletes this session.",
      minutes: 15,
      status: "active",
      idempotencyKey: "00000000-0000-4000-8000-00000000d001",
    });
    const personalEndsBefore = value.personalCodex.calls.filter((call) => call === "end").length;
    const managedEndsBefore = value.codex.calls.filter((call) => call === "end").length;
    const deletedFact = {
      ...parseFact("thread/deleted", { threadId: providerThreadId }),
      connectionId: value.personalCodex.observationConnectionId,
    };

    await value.service.observePersonalCodexFact(authority, deletedFact);
    await value.service.settled();

    const terminalSession = value.store.requireSession(value.session.id);
    expect(terminalSession).toMatchObject({ state: "terminal" });
    expect(terminalSession.activeTurnId).toBeUndefined();
    const pausedTask = taskStore.list(value.session.id).find((task) =>
      task.id === activeTask.id);
    expect(pausedTask).toMatchObject({
      status: "paused",
      revision: activeTask.revision + 1,
      nextDueAt: null,
    });
    expect(value.personalCodex.calls.filter((call) => call === "end"))
      .toHaveLength(personalEndsBefore + 1);
    expect(value.codex.calls.filter((call) => call === "end"))
      .toHaveLength(managedEndsBefore);
    expect(value.service.backgroundDiagnostics()).toEqual({ last: null, byCode: [] });
    expect(value.store.readSessionPersonalRuntimeBinding(value.session.id)).toBeNull();
    expect(value.store.readSessionPersonalRuntimeBinding(value.session.id, true))
      .toMatchObject({ state: "detached" });
    await value.service.observePersonalCodexFact(authority, deletedFact);
    await value.service.settled();
    expect(taskStore.list(value.session.id).find((task) => task.id === activeTask.id))
      .toEqual(pausedTask);
    expect(value.personalCodex.calls.filter((call) => call === "end"))
      .toHaveLength(personalEndsBefore + 1);
    expect(value.codex.calls.filter((call) => call === "end"))
      .toHaveLength(managedEndsBefore);
  });

  test("keeps committed adoption authority and retries failed memory initialization", async () => {
    const factsMemory = new FakeFactsMemoryLifecycle();
    factsMemory.ensureErrorOnce = new Error("lost adoption memory receipt");
    const value = await adoptedCodexFixture(
      "Adopted initialization retry",
      "personal-thread-initialization-retry",
      factsMemory,
    );

    expect(value.store.readSessionPersonalRuntimeBinding(value.session.id)).toMatchObject({
      state: "active",
    });
    expect(value.store.latestSessionRuntimeProfile(value.session.id)).toMatchObject({
      sourceKind: "session_start",
      profile: { profileId: value.accountId, preset: "ultra" },
    });
    await waitFor(() => factsMemory.ensures.filter(
      ({ sessionId }) => sessionId === value.session.id,
    ).length >= 2);
    expect(factsMemory.states.get(value.session.id)).toBe("active");
    expect(value.personalCodex.calls.filter((call) => call === "end")).toHaveLength(0);
  });

  test("admits and autoresponds to an adopted session approval through personal custody", async () => {
    const value = await adoptedCodexFixture(
      "Adopted approval",
      "personal-thread-approval",
    );
    value.store.setDefaultApprovalMode("auto:all");
    const authority = value.personalCodex.claimRequests[0]?.authority;
    if (authority === undefined) throw new Error("Expected personal claim authority.");
    const requestId = "adopted-approval-request";
    const connectionId = value.personalCodex.observationConnectionId;

    await value.service.observePersonalCodexFact(authority, {
      type: "interactionRequested",
      connectionId,
      provider: {
        profileId: value.session.profileId,
        processGeneration: authority.generation,
        provider: authority.provider,
        providerAccountId: authority.providerAccountId,
        bindingGeneration: authority.bindingGeneration,
        connectionId,
        requestId: { type: "string", value: requestId },
        method: "item/commandExecution/requestApproval",
        requestDigest: createHash("sha256").update(requestId).digest("hex"),
        threadId: "personal-thread-approval",
        turnId: "turn-adopted-approval",
        itemId: "item-adopted-approval",
        approvalId: null,
      },
      kind: "command_approval",
      blocking: true,
      display: {
        kind: "command_approval",
        summary: "Run the adopted session test",
        reason: null,
        commandClass: "bun test",
        workingDirectory: null,
        availableDecisions: ["once", "session", "decline", "cancel"],
      },
    });

    await waitFor(() => value.personalCodex.resolvedInteractions.length === 1);
    expect(value.personalCodex.resolvedInteractions[0]).toMatchObject({
      kind: "command_approval",
      resolution: { kind: "approval_decision", decision: "once" },
    });
    expect(value.codex.resolvedInteractions).toHaveLength(0);
    await waitFor(() => value.store.listInteractions({
      sessionId: value.session.id,
      limit: 10,
    }).some((candidate) =>
      candidate.authority.requestId.value === requestId
      && candidate.resolvedBy === "autorespond"));
    const interaction = value.store.listInteractions({
      sessionId: value.session.id,
      limit: 10,
    }).find((candidate) => candidate.authority.requestId.value === requestId);
    expect(interaction).toMatchObject({
      resolvedBy: "autorespond",
      sessionId: value.session.id,
    });
    expect(interaction?.state).not.toBe("pending");
    await waitFor(() => value.store.listAutorespondEvidence({
      sessionId: value.session.id,
    }).length === 1);
    expect(value.store.listAutorespondEvidence({ sessionId: value.session.id })[0])
      .toMatchObject({
        decision: "once",
        kind: "command_approval",
        mode: "auto:all",
        outcome: "accepted",
      });
  });

  test("keeps adopted Codex protected approvals pending through personal custody", async () => {
    const providerThreadId = "personal-thread-protected-approvals";
    const value = await adoptedCodexFixture(
      "Adopted protected approvals",
      providerThreadId,
    );
    const authority = value.personalCodex.claimRequests[0]?.authority;
    if (authority === undefined) throw new Error("Expected personal claim authority.");
    const connectionId = value.personalCodex.observationConnectionId;
    const providerAuthority = (
      requestId: string,
      method: string,
    ): ProviderInteractionAuthority => ({
      profileId: value.session.profileId,
      processGeneration: authority.generation,
      provider: authority.provider,
      providerAccountId: authority.providerAccountId,
      bindingGeneration: authority.bindingGeneration,
      connectionId,
      requestId: { type: "string", value: requestId },
      method,
      requestDigest: createHash("sha256").update(requestId).digest("hex"),
      threadId: providerThreadId,
      turnId: `turn-${requestId}`,
      itemId: `item-${requestId}`,
      approvalId: null,
    });
    const findInteraction = (requestId: string): InteractionRecord => {
      const interaction = value.store.listInteractions({
        sessionId: value.session.id,
        limit: 10,
      }).find((candidate) => candidate.authority.requestId.value === requestId);
      if (interaction === undefined) throw new Error(`Expected interaction ${requestId}.`);
      return interaction;
    };

    value.store.setSessionApprovalMode(value.session.id, "auto:workspace");
    const commandRequestId = "adopted-workspace-command";
    await value.service.observePersonalCodexFact(authority, {
      type: "interactionRequested",
      connectionId,
      provider: providerAuthority(
        commandRequestId,
        "item/commandExecution/requestApproval",
      ),
      kind: "command_approval",
      blocking: true,
      display: {
        kind: "command_approval",
        summary: "Run the adopted workspace command",
        reason: null,
        commandClass: "bun test",
        workingDirectory: null,
        availableDecisions: ["once", "session", "decline", "cancel"],
      },
    });
    const command = findInteraction(commandRequestId);
    await waitFor(() => value.store.listAutorespondEvidence({
      sessionId: value.session.id,
    }).length === 1);

    const permissionRequestId = "adopted-workspace-permission";
    await value.service.observePersonalCodexFact(authority, {
      type: "interactionRequested",
      connectionId,
      provider: providerAuthority(
        permissionRequestId,
        "item/permissions/requestApproval",
      ),
      kind: "permission_approval",
      blocking: true,
      display: {
        kind: "permission_approval",
        summary: "Allow the adopted workspace permission",
        reason: null,
        requested: [{ name: "workspace_write" }],
        allowsSessionScope: true,
      },
    });
    const permission = findInteraction(permissionRequestId);
    await waitFor(() => value.store.listAutorespondEvidence({
      sessionId: value.session.id,
    }).length === 2);

    value.store.setSessionApprovalMode(value.session.id, "auto:all");
    const fileChangeRequestId = "adopted-all-file-change";
    await value.service.observePersonalCodexFact(authority, {
      type: "interactionRequested",
      connectionId,
      provider: providerAuthority(
        fileChangeRequestId,
        "item/fileChange/requestApproval",
      ),
      kind: "file_change_approval",
      blocking: true,
      display: {
        kind: "file_change_approval",
        summary: "Allow the adopted file changes",
        reason: null,
        grantRoot: null,
        availableDecisions: ["once", "decline", "cancel"],
      },
    });
    const fileChange = findInteraction(fileChangeRequestId);
    await waitFor(() => value.store.listAutorespondEvidence({
      sessionId: value.session.id,
    }).length === 3);

    for (const interaction of [command, permission, fileChange]) {
      expect(value.store.requireInteraction(interaction.publicId)).toMatchObject({
        resolvedBy: null,
        state: "pending",
      });
    }
    const evidence = value.store.listAutorespondEvidence({
      sessionId: value.session.id,
    });
    for (const [interaction, mode] of [
      [command, "auto:workspace"],
      [permission, "auto:workspace"],
      [fileChange, "auto:all"],
    ] as const) {
      expect(evidence.find((row) => row.interactionId === interaction.publicId))
        .toMatchObject({
          decision: "protected_authority_required",
          interactionId: interaction.publicId,
          mode,
          outcome: "refused",
        });
    }
    expect(value.store.readSessionState(value.session.id)).toMatchObject({
      attention: true,
      reason: "autorespond_protected_authority_required",
      state: "needs_approval",
    });
    expect(value.personalCodex.validatedInteractions).toHaveLength(0);
    expect(value.personalCodex.resolvedInteractions).toHaveLength(0);
    expect(value.codex.validatedInteractions).toHaveLength(0);
    expect(value.codex.resolvedInteractions).toHaveLength(0);
  });

  test("inspects and manually resolves an adopted Codex approval only through personal custody", async () => {
    const value = await adoptedCodexFixture(
      "Adopted manual approval",
      "personal-thread-manual-approval",
    );
    value.store.setSessionApprovalMode(value.session.id, "manual");
    const seeded = await seedResolvableInteraction(
      value,
      value.session.id,
      "adopted-manual-approval",
      undefined,
      "personal",
    );
    await waitFor(() => value.store.listAutorespondEvidence({
      sessionId: value.session.id,
    }).length === 1);

    await expect(value.service.execute({
      kind: "interaction.inspect",
      interaction: seeded.interaction.publicId,
      expectedRevision: seeded.interaction.revision,
    }, { signal })).resolves.toMatchObject({
      binding: { interactionId: seeded.interaction.publicId },
      authority: { kind: "command_approval", command: "git status --short" },
    });
    await expect(value.service.execute({
      kind: "interaction.resolve",
      interaction: seeded.interaction.publicId,
      expectedRevision: seeded.interaction.revision,
      resolution: { kind: "approval_decision", decision: "once" },
    }, { signal })).resolves.toMatchObject({
      responseWritten: true,
      interaction: { state: "response_written" },
    });

    expect(value.personalCodex.inspectedInteractions).toHaveLength(1);
    expect(value.personalCodex.inspectedInteractions[0]).toMatchObject({
      authority: seeded.authority,
      provider: seeded.interaction.authority,
    });
    expect(value.personalCodex.validatedInteractions).toHaveLength(1);
    expect(value.personalCodex.resolvedInteractions).toHaveLength(1);
    expect(value.personalCodex.resolvedInteractions[0]).toMatchObject({
      authority: seeded.authority,
      provider: seeded.interaction.authority,
      resolution: { kind: "approval_decision", decision: "once" },
    });
    expect(value.codex.inspectedInteractions).toHaveLength(0);
    expect(value.codex.validatedInteractions).toHaveLength(0);
    expect(value.codex.resolvedInteractions).toHaveLength(0);
    expect(value.store.requireInteraction(seeded.interaction.publicId)).toMatchObject({
      resolvedBy: null,
      state: "response_written",
    });
    expect(value.store.readAutorespondBudgets(value.session.id).consecutive).toBe(0);
  });

  test("keeps an adopted autoresponse charged but unknown when its account drifts after provider write", async () => {
    const value = await adoptedCodexFixture(
      "Adopted post-write account drift",
      "personal-thread-post-write-account-drift",
    );
    const authority = value.personalCodex.claimRequests[0]?.authority;
    if (authority === undefined) throw new Error("Expected personal claim authority.");
    value.store.setSessionApprovalMode(value.session.id, "auto:all");
    const managedRevocationBefore = value.store.readProviderRuntimeAccountRevocation({
      profileId: value.accountId,
      provider: "codex",
      runtimeScope: "managed",
    });
    const managedValidatedBefore = value.codex.validatedInteractions.length;
    const managedResolvedBefore = value.codex.resolvedInteractions.length;
    const managedReleasesBefore = value.codex.releasedAuthorities.length;

    let validationStarted!: () => void;
    const validationAdmission = new Promise<void>((resolve) => {
      validationStarted = resolve;
    });
    let finishValidation!: () => void;
    const validationGate = new Promise<void>((resolve) => {
      finishValidation = resolve;
    });
    value.personalCodex.beforeValidateInteractionResolutionReturn = async () => {
      validationStarted();
      await validationGate;
    };
    let releaseStarted!: () => void;
    const releaseAdmission = new Promise<void>((resolve) => {
      releaseStarted = resolve;
    });
    let finishRelease!: () => void;
    const releaseGate = new Promise<void>((resolve) => {
      finishRelease = resolve;
    });
    value.personalCodex.beforeReleaseOwnedAuthorityReturn = async () => {
      releaseStarted();
      await releaseGate;
    };
    const replacementAccount: CodexAccountProjection = {
      signedIn: true,
      email: "replacement-after-adopted-response@example.com",
      plan: "Plus",
    };
    value.personalCodex.beforeResolveInteractionReturn = async () => {
      value.personalCodex.accountProjection = replacementAccount;
      await expect(value.service.observePersonalCodexAccount(
        authority,
        replacementAccount,
      )).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    };

    const seeded = await seedResolvableInteraction(
      value,
      value.session.id,
      "adopted-post-write-account-drift",
      undefined,
      "personal",
    );
    await validationAdmission;
    finishValidation();
    await waitFor(() => value.personalCodex.resolvedInteractions.length === 1);
    await releaseAdmission;
    await waitFor(() => value.store.listAutorespondEvidence({
      sessionId: value.session.id,
    }).length === 1);

    expect(value.store.requireInteraction(seeded.interaction.publicId)).toMatchObject({
      intendedTerminalState: "resolved",
      resolvedBy: null,
      state: "resolution_unknown",
    });
    expect(value.store.readAutorespondBudgets(value.session.id)).toMatchObject({
      consecutive: 1,
      lastDay: 1,
      lastHour: 1,
    });
    expect(value.store.listAutorespondEvidence({ sessionId: value.session.id })[0])
      .toMatchObject({
        decision: "once",
        interactionId: seeded.interaction.publicId,
        mode: "auto:all",
        outcome: "unknown",
      });
    expect(value.store.readProviderRuntimeAccountRevocation({
      profileId: value.accountId,
      provider: "codex",
      runtimeScope: "personal",
    })).toMatchObject({
      currentAccountKey: codexProviderAccountKey(
        "replacement-after-adopted-response@example.com",
      ),
      profileGeneration: authority.generation,
      state: "releasing",
    });
    expect(value.store.readProviderRuntimeAccountRevocation({
      profileId: value.accountId,
      provider: "codex",
      runtimeScope: "managed",
    })).toEqual(managedRevocationBefore);
    expect(value.personalCodex.validatedInteractions).toHaveLength(1);
    expect(value.personalCodex.resolvedInteractions).toHaveLength(1);
    expect(value.codex.validatedInteractions).toHaveLength(managedValidatedBefore);
    expect(value.codex.resolvedInteractions).toHaveLength(managedResolvedBefore);
    expect(value.codex.releasedAuthorities).toHaveLength(managedReleasesBefore);

    finishRelease();
    await value.service.settled();
    expect(value.personalCodex.releasedAuthorities).toEqual([authority]);
    expect(value.store.readProviderRuntimeAccountRevocation({
      profileId: value.accountId,
      provider: "codex",
      runtimeScope: "personal",
    })).toMatchObject({ state: "completed" });
    expect(value.store.readSessionPersonalRuntimeBinding(value.session.id, true))
      .toMatchObject({ state: "detached" });
    expect(value.store.readProviderRuntimeAccountRevocation({
      profileId: value.accountId,
      provider: "codex",
      runtimeScope: "managed",
    })).toEqual(managedRevocationBefore);
    expect(value.codex.releasedAuthorities).toHaveLength(managedReleasesBefore);
  });

  test("refuses protected approval inspection when the adopted Codex account changes in flight", async () => {
    const value = await adoptedCodexFixture(
      "Adopted inspection account race",
      "personal-thread-inspection-account-race",
    );
    value.store.setDefaultApprovalMode("manual");
    const seeded = await seedResolvableInteraction(
      value,
      value.session.id,
      "adopted-inspection-account-race",
      undefined,
      "personal",
    );
    value.personalCodex.interactionAuthority = {
      kind: "command_approval",
      command: "PRIVATE-OLD-ACCOUNT-COMMAND",
      reason: null,
      availableDecisions: ["accept", "decline", "cancel"],
      workingDirectory: "/workspace",
      environmentId: null,
      commandActions: null,
      networkApprovalContext: null,
      additionalPermissions: null,
      proposedExecpolicyAmendment: null,
      proposedNetworkPolicyAmendments: null,
    };
    let markInspectionStarted!: () => void;
    const inspectionStarted = new Promise<void>((resolve) => {
      markInspectionStarted = resolve;
    });
    let releaseInspection!: () => void;
    const inspectionGate = new Promise<void>((resolve) => {
      releaseInspection = resolve;
    });
    value.personalCodex.beforeInspectInteractionReturn = async () => {
      markInspectionStarted();
      await inspectionGate;
    };

    const inspecting = value.service.execute({
      kind: "interaction.inspect",
      interaction: seeded.interaction.publicId,
      expectedRevision: seeded.interaction.revision,
    }, { signal });
    await inspectionStarted;
    value.personalCodex.accountProjection = {
      signedIn: true,
      email: "replacement-during-inspection@example.com",
      plan: "Plus",
    };
    releaseInspection();

    await expect(inspecting).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(value.personalCodex.inspectedInteractions).toHaveLength(1);
    expect(value.store.requireInteraction(seeded.interaction.publicId))
      .toMatchObject({ state: "expired" });
    expect(value.store.requireSession(value.session.id))
      .toMatchObject({ state: "recovery_required" });
    await value.service.settled();
    expect(value.store.readSessionPersonalRuntimeBinding(value.session.id, true))
      .toMatchObject({ state: "detached" });
  });

  test("replaying an applied account login leaves a newer managed Claude controller untouched", async () => {
    let providerThreadId = "native-claude-login-replay";
    const loginIdempotencyKey = "00000000-0000-4000-8000-00000000c100";
    const identity: ClaudeProcessIdentity = {
      pid: 63_019,
      pidDomain: "darwin",
      procStart: "native-claude-login-replay-process",
    };
    const value = await nativeClaudeFixture(
      "Native Claude login replay",
      providerThreadId,
      identity,
      loginIdempotencyKey,
    );
    providerThreadId = value.providerThreadId;
    const profile = value.store.requireProfileById(value.accountId);
    expect(value.store.readClaudeProcessAuthority({
      providerThreadId,
      profileId: value.accountId,
      runtimeScope: "managed",
    })).toMatchObject({
      identity,
      profileGeneration: profile.processGeneration,
      sessionId: value.session.id,
      state: "bound",
    });

    await expect(value.service.execute({
      kind: "account.login",
      account: value.accountId,
      deviceCode: false,
      idempotencyKey: loginIdempotencyKey,
    }, { signal })).resolves.toMatchObject({
      account: {
        id: value.accountId,
        processGeneration: profile.processGeneration,
        state: "signed_in",
      },
      login: { status: "signed_in" },
    });

    expect(value.codex.calls.filter((call) => call.startsWith("login:")))
      .toHaveLength(1);
    expect(value.managedClaude.endRequests).toEqual([]);
    expect(value.managedClaude.endedProcessIdentities).toEqual([]);
    expect(value.store.readClaudeProcessAuthority({
      providerThreadId,
      profileId: value.accountId,
      runtimeScope: "managed",
    })).toMatchObject({
      identity,
      profileGeneration: profile.processGeneration,
      sessionId: value.session.id,
      state: "bound",
    });
    expect(value.store.requireProfileById(value.accountId)).toMatchObject({
      processGeneration: profile.processGeneration,
      state: "signed_in",
    });
  });

  test("preserves exact native Claude process authority across explicit Codex logout", async () => {
    let providerThreadId = "native-claude-explicit-logout";
    const identity: ClaudeProcessIdentity = {
      pid: 63_020,
      pidDomain: "darwin",
      procStart: "native-claude-explicit-logout-process",
    };
    const value = await nativeClaudeFixture(
      "Native Claude explicit logout",
      providerThreadId,
      identity,
    );
    providerThreadId = value.providerThreadId;
    const profile = value.store.requireProfileById(value.accountId);
    expect(value.store.listSessionPersonalRuntimeBindings()).toEqual([]);
    expect(value.store.readClaudeProcessAuthority({
      providerThreadId,
      profileId: value.accountId,
      runtimeScope: "managed",
    })).toMatchObject({
      identity,
      profileGeneration: profile.processGeneration,
      sessionId: value.session.id,
      state: "bound",
    });

    await expect(value.service.execute({
      kind: "account.logout",
      account: value.accountId,
      idempotencyKey: "00000000-0000-4000-8000-00000000c101",
    }, { signal })).resolves.toMatchObject({
      account: { id: value.accountId, state: "signed_out" },
    });

    expect(value.codex.calls.filter((call) => call === "logout")).toHaveLength(1);
    expect(value.managedClaude.endRequests).toEqual([]);
    expect(value.managedClaude.endedProcessIdentities).toEqual([]);
    expect(value.store.readClaudeProcessAuthority({
      providerThreadId,
      profileId: value.accountId,
      runtimeScope: "managed",
    })).toMatchObject({
      identity,
      profileGeneration: profile.processGeneration,
      sessionId: value.session.id,
      state: "bound",
    });
    expect(value.store.requireProfileById(value.accountId).state).toBe("signed_out");

    await expect(value.service.execute({
      kind: "session.send",
      session: value.session.id,
      message: "Continue under independent Claude authority",
      idempotencyKey: "00000000-0000-4000-8000-00000000c102",
    }, { signal })).resolves.toMatchObject({
      session: { id: value.session.id },
    });
    expect(value.managedClaude.turnRequests).toHaveLength(1);
  });

  test("preserves live exact Claude custody across same-profile Codex login", async () => {
    const value = await nativeClaudeFixture(
      "Independent Codex login",
      "native-claude-sibling-codex-login",
      { pid: 63_030, pidDomain: "darwin", procStart: "sibling-codex-login-process" },
      undefined,
      false,
    );
    const captured = value.store.requireSessionProviderAuthority(value.session.id);
    const profileBefore = value.store.requireProfileById(value.accountId);
    const processSelector = {
      providerThreadId: value.providerThreadId,
      profileId: value.accountId,
      runtimeScope: "managed" as const,
    };
    const processBefore = value.store.readClaudeProcessAuthority(processSelector);
    const callsBefore = [...value.managedClaude.calls];
    const originalFactAuthority = value.managedClaude.startSessionRequests[0]?.authority;
    if (originalFactAuthority === undefined) throw new Error("Expected the original Claude writer authority.");
    expect(profileBefore.processGeneration).toBe(0);
    expect(captured.processGeneration).toBeGreaterThan(0);
    expect(processBefore).toMatchObject({ state: "bound", profileGeneration: 0 });

    await expect(value.service.execute({
      kind: "account.login",
      account: value.accountId,
      deviceCode: false,
      idempotencyKey: "00000000-0000-4000-8000-00000000c103",
    }, { signal })).resolves.toMatchObject({ account: { id: value.accountId } });
    await value.service.settled();

    expect(value.store.requireProfileById(value.accountId)).toMatchObject({
      state: "signed_in", processGeneration: profileBefore.processGeneration + 1,
    });
    expect(value.store.requireSessionProviderAuthority(value.session.id)).toEqual(captured);
    expect(value.store.readClaudeProcessAuthority(processSelector)).toEqual(processBefore);
    expect(value.managedClaude.calls).toEqual(callsBefore);
    expect(value.managedClaude.endRequests).toEqual([]);
    expect(value.managedClaude.endedProcessIdentities).toEqual([]);
    expect(value.store.readProviderRuntimeAccountRevocation({
      profileId: value.accountId, provider: "claude", runtimeScope: "managed",
    })).toBeNull();
    // Deliver on the pre-login connection before any service send can refresh
    // its observation capability from the now-advanced Codex shadow.
    await value.service.observeClaudeFact(originalFactAuthority, {
      providerThreadId: value.providerThreadId,
      connectionId: value.managedClaude.observationConnectionId,
      type: "assistantDelta", turnId: "unchanged-claude-turn",
      itemId: "unchanged-claude-item", text: "Still the original Claude writer",
    });
    // Flush the streaming redactor at the real provider turn boundary.
    await value.service.observeClaudeFact(originalFactAuthority, {
      providerThreadId: value.providerThreadId,
      connectionId: value.managedClaude.observationConnectionId,
      type: "turnCompleted", turnId: "unchanged-claude-turn", status: "completed",
    });
    const acceptedFact = value.store.listSessionEvents({
      sessionId: value.session.id, afterSequence: 0, limit: 100,
    }).events.find((event) => event.body.type === "assistant_delta"
      && event.body.text === "Still the original Claude writer");
    expect(acceptedFact).toBeDefined();
    if (acceptedFact === undefined) throw new Error("Expected the original Claude fact to remain admissible.");
    const raw = new Database(value.paths.database, { readonly: true });
    expect(raw.query(`SELECT provider,provider_account_id,binding_generation,process_generation
      FROM session_event_provider_authorities WHERE session_id=? AND sequence=?`)
      .get(value.session.id, acceptedFact.sequence)).toEqual({
        provider: captured.provider, provider_account_id: captured.providerAccountId,
        binding_generation: captured.bindingGeneration, process_generation: captured.processGeneration,
      });
    raw.close();
    expect(value.store.requireSessionProviderAuthority(value.session.id)).toEqual(captured);
    expect(value.store.readClaudeProcessAuthority(processSelector)).toEqual(processBefore);
    await expect(value.service.execute({
      kind: "session.send", session: value.session.id,
      message: "Continue on the unchanged Claude writer",
      idempotencyKey: "00000000-0000-4000-8000-00000000c104",
    }, { signal })).resolves.toMatchObject({ session: { id: value.session.id } });
    expect(value.managedClaude.turnRequests).toHaveLength(1);
    await value.service.close();
  });

  test("preserves exact Claude custody after a sibling Codex signout observation", async () => {
    const value = await nativeClaudeFixture(
      "Observed sibling signout",
      "native-claude-observed-sibling-signout",
      { pid: 63_029, pidDomain: "darwin", procStart: "observed-sibling-signout-process" },
    );
    const captured = value.store.requireSessionProviderAuthority(value.session.id);
    const processSelector = {
      providerThreadId: value.providerThreadId,
      profileId: value.accountId,
      runtimeScope: "managed" as const,
    };
    const processBefore = value.store.readClaudeProcessAuthority(processSelector);
    await expect(value.service.observeCodexAccount(
      liveAuthorityFor(value.store, value.accountId, "codex"),
      { signedIn: false },
    )).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    await value.service.settled();

    expect(value.store.requireProfileById(value.accountId).state).toBe("signed_out");
    expect(value.store.requireSessionProviderAuthority(value.session.id)).toEqual(captured);
    expect(value.store.readClaudeProcessAuthority(processSelector)).toEqual(processBefore);
    expect(value.store.readProviderRuntimeAccountRevocation({
      profileId: value.accountId, provider: "claude", runtimeScope: "managed",
    })).toBeNull();
    expect(value.managedClaude.endRequests).toEqual([]);
    expect(value.managedClaude.endedProcessIdentities).toEqual([]);
    await expect(value.service.readSessionProjectionForCloud(value.session.id, signal))
      .resolves.toMatchObject({ providerThreadId: value.providerThreadId });
    await value.service.close();
  });

  test("durably revokes native Claude process authority after provider-observed signout", async () => {
    let providerThreadId = "native-claude-observed-signout";
    const identity: ClaudeProcessIdentity = {
      pid: 63_021,
      pidDomain: "darwin",
      procStart: "native-claude-observed-signout-process",
    };
    const value = await nativeClaudeFixture(
      "Native Claude observed signout",
      providerThreadId,
      identity,
    );
    providerThreadId = value.providerThreadId;
    const profile = value.store.requireProfileById(value.accountId);
    const captured = value.store.requireProviderAccountAuthority(value.accountId, "claude");
    let markReleaseStarted!: () => void;
    const releaseStarted = new Promise<void>((resolve) => {
      markReleaseStarted = resolve;
    });
    let finishRelease!: () => void;
    const releaseGate = new Promise<void>((resolve) => {
      finishRelease = resolve;
    });
    value.managedClaude.beforeEndSessionReturn = async () => {
      markReleaseStarted();
      await releaseGate;
    };

    value.managedClaude.accountProjection = { signedIn: false };
    await expect(value.service.readSessionProjectionForCloud(value.session.id, signal))
      .rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    await releaseStarted;
    try {
      expect(value.store.readProviderRuntimeAccountRevocation({
        profileId: value.accountId, provider: "claude", runtimeScope: "managed",
      }))
        .toMatchObject({
          profileGeneration: profile.processGeneration,
          state: "releasing",
        });
      expect(value.store.requireProfileById(value.accountId).state)
        .toBe(profile.state);
      expect(value.store.readClaudeProcessAuthority({
        providerThreadId,
        profileId: value.accountId,
        runtimeScope: "managed",
      })).toMatchObject({
        identity,
        providerAuthority: captured,
        profileGeneration: profile.processGeneration,
        sessionId: value.session.id,
        state: "releasing",
      });
      expect(value.store.listSessionPersonalRuntimeBindings()).toEqual([]);
    } finally {
      finishRelease();
    }
    await value.service.settled();

    expect(value.managedClaude.endRequests).toHaveLength(1);
    expect(value.managedClaude.endedProcessIdentities).toEqual([identity]);
    expect(value.store.readClaudeProcessAuthority({
      providerThreadId,
      profileId: value.accountId,
      runtimeScope: "managed",
    })).toMatchObject({
      identity,
      providerAuthority: captured,
      profileGeneration: profile.processGeneration,
      sessionId: value.session.id,
      state: "released",
    });
    expect(value.store.readProviderRuntimeAccountRevocation({
      profileId: value.accountId, provider: "claude", runtimeScope: "managed",
    }))
      .toMatchObject({
        profileGeneration: profile.processGeneration,
        state: "completed",
      });
    expect(value.store.requireProfileById(value.accountId)).toEqual(profile);
    expect(value.store.requireProviderAccountAuthority(value.accountId, "codex").processGeneration)
      .toBe(profile.processGeneration);
  });

  test("revokes managed Claude authority before accepting replaced or missing account identity", async () => {
    const observations: readonly CodexAccountProjection[] = [
      { signedIn: true, email: "replacement@example.com", plan: "Plus" },
      { signedIn: true, plan: "Plus" },
    ];
    for (const [index, observation] of observations.entries()) {
      let providerThreadId = `native-claude-account-identity-${String(index)}`;
      const identity: ClaudeProcessIdentity = {
        pid: 63_030 + index,
        pidDomain: "darwin",
        procStart: `native-claude-account-identity-${String(index)}`,
      };
      const value = await nativeClaudeFixture(
        `Native Claude account identity ${String(index)}`,
        providerThreadId,
        identity,
      );
      providerThreadId = value.providerThreadId;
      const profile = value.store.requireProfileById(value.accountId);
      const captured = value.store.requireProviderAccountAuthority(value.accountId, "claude");
      expect(profile.providerEmail).toBe("person@example.com");
      let markReleaseStarted!: () => void;
      const releaseStarted = new Promise<void>((resolve) => {
        markReleaseStarted = resolve;
      });
      let finishRelease!: () => void;
      const releaseGate = new Promise<void>((resolve) => {
        finishRelease = resolve;
      });
      value.managedClaude.beforeEndSessionReturn = async () => {
        markReleaseStarted();
        await releaseGate;
      };

      value.managedClaude.accountProjection = observation;
      await expect(value.service.readSessionProjectionForCloud(value.session.id, signal))
        .rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
      await releaseStarted;
      try {
        expect(value.store.requireProfileById(value.accountId)).toMatchObject({
          providerEmail: "person@example.com",
          state: profile.state,
        });
        expect(value.store.readProviderRuntimeAccountRevocation({
          profileId: value.accountId, provider: "claude", runtimeScope: "managed",
        }))
          .toMatchObject({
            profileGeneration: profile.processGeneration,
            state: "releasing",
          });
        expect(value.store.readClaudeProcessAuthority({
          providerThreadId,
          profileId: value.accountId,
          runtimeScope: "managed",
        })).toMatchObject({
          identity,
          providerAuthority: captured,
          state: "releasing",
        });
      } finally {
        finishRelease();
      }
      await value.service.settled();

      const retired = value.store.requireProfileById(value.accountId);
      expect(retired).toEqual(profile);
      expect(value.store.readProviderRuntimeAccountRevocation({
        profileId: value.accountId, provider: "claude", runtimeScope: "managed",
      })).toMatchObject({ state: "completed", profileGeneration: profile.processGeneration });
      expect(value.store.readClaudeProcessAuthority({
        providerThreadId,
        profileId: value.accountId,
        runtimeScope: "managed",
      })?.state).toBe("released");
      await value.service.close();
    }
  });

  test("keeps a dormant native session bound to its original account across replacement", async () => {
    const value = await fixture();
    const { sessionId } = await createIdleSession(value, "Native account identity fence");
    const session = value.store.requireSession(sessionId);
    const original = value.store.requireProfileById(session.profileId);
    expect(value.store.sessionAccountAuthorityMatches(session.id, original.id)).toBe(true);

    value.codex.accountProjection = {
      signedIn: true,
      email: "replacement-native-owner@example.com",
      plan: "Plus",
    };
    await expect(value.service.execute({
      kind: "account.show",
      account: original.id,
    }, { signal })).resolves.toMatchObject({
      account: { providerEmail: "person@example.com", state: "signed_in" },
      providerProjection: { email: "replacement-native-owner@example.com", signedIn: true },
      recovery: { required: true },
    });
    await value.service.settled();

    expect(value.store.requireProfileById(original.id)).toMatchObject({
      processGeneration: original.processGeneration + 1,
      state: "signed_out",
    });
    expect(value.store.requireSession(session.id)).toMatchObject({
      providerThreadId: session.providerThreadId,
      state: "recovery_required",
    });
    expect(value.store.sessionAccountAuthorityMatches(session.id, original.id)).toBe(false);

    value.codex.loginResult = {
      status: "signed_in",
      account: {
        signedIn: true,
        email: "replacement-native-owner@example.com",
        plan: "Plus",
      },
    };
    await value.service.execute({
      kind: "account.login",
      account: original.id,
      deviceCode: false,
    }, { signal });
    expect(value.store.sessionAccountAuthorityMatches(session.id, original.id)).toBe(false);
    await expect(value.service.execute({
      kind: "session.list",
      account: original.id,
      archived: false,
      limit: 10,
    }, { signal })).resolves.toMatchObject({ sessions: [], nextCursor: null });
    await expect(value.service.execute({
      kind: "session.note.set",
      session: session.id,
      note: "replacement must not change original metadata",
    }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    await expect(value.service.execute({
      kind: "autorespond.set",
      session: session.id,
      mode: "auto:all",
    }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    await expect(value.service.execute({
      kind: "session.archive",
      session: session.id,
      archived: true,
    }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    const turnsBefore = value.codex.committedStartTurns;
    await expect(value.service.execute({
      kind: "session.send",
      session: session.id,
      message: "must stay with the original identity",
    }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(value.codex.committedStartTurns).toBe(turnsBefore);
  });

  test("account read revokes an adopted controller before exposing a replacement identity", async () => {
    const value = await adoptedCodexFixture(
      "Adopted account replacement",
      "personal-thread-account-replacement",
    );
    value.codex.accountProjection = {
      signedIn: true,
      email: "replacement@example.com",
      plan: "Plus",
    };

    const shown = await value.service.execute({
      kind: "account.show",
      account: value.accountId,
    }, { signal }) as {
      account: { providerEmail?: string; state: string };
      providerProjection: CodexAccountProjection;
      recovery: { required: boolean };
    };
    expect(shown).toMatchObject({
      account: {
        providerEmail: "person@example.com",
        state: "signed_in",
      },
      providerProjection: { signedIn: true, email: "replacement@example.com" },
      recovery: { required: true },
    });
    await value.service.settled();

    const retired = value.store.requireProfileById(value.accountId);
    expect(retired.state).toBe("signed_out");
    expect(retired.providerEmail).toBeUndefined();
    expect(value.store.readSessionPersonalRuntimeBinding(value.session.id, true))
      .toMatchObject({ state: "detached" });
    expect(value.store.readProfilePersonalAuthorityRevocation(value.accountId))
      .toMatchObject({ state: "completed" });
    await value.service.close();
  });

  test("account read requires explicit login before binding a controller-free replacement identity", async () => {
    const value = await fixture();
    const added = await value.service.execute(
      { kind: "account.add", label: "Controller-free account replacement" },
      { signal },
    ) as { account: { id: `acct_${string}` } };
    await value.service.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: false,
    }, { signal });
    expect(value.store.requireProfileById(added.account.id).providerEmail)
      .toBe("person@example.com");
    value.codex.accountProjection = {
      signedIn: true,
      email: "replacement@example.com",
      plan: "Plus",
    };

    await expect(value.service.execute({
      kind: "account.show",
      account: added.account.id,
    }, { signal })).resolves.toMatchObject({
      account: {
        providerEmail: "person@example.com",
        state: "signed_in",
      },
      providerProjection: { email: "replacement@example.com", signedIn: true },
      recovery: { required: true },
    });
    await value.service.settled();
    expect(value.store.requireProfileById(added.account.id)).toMatchObject({
      processGeneration: 2,
      state: "signed_out",
    });
    expect(value.store.readProfilePersonalAuthorityRevocation(added.account.id))
      .toMatchObject({ profileGeneration: 1, state: "completed" });
    await value.service.close();
  });

  test("supersedes completed non-null scoped Codex fences before account login", async () => {
    const value = await fixture();
    const added = await value.service.execute(
      { kind: "account.add", label: "Completed scoped Codex fences" },
      { signal },
    ) as { account: { id: `acct_${string}` } };
    const profile = value.store.requireProfileById(added.account.id);
    const capturedAuthority = liveAuthorityFor(value.store, profile.id, "codex", profilePaths(value.paths, profile.id));
    const priorAccountKey = codexProviderAccountKey("prior-owner@example.com");
    const direct = new Database(value.paths.database, { create: false, strict: true });
    try {
      for (const runtimeScope of ["personal", "managed"] as const) {
        direct.query(
          `INSERT INTO provider_runtime_account_revocations(
             profile_id,profile_generation,provider,runtime_scope,current_account_key,
             state,revision,created_at,updated_at,completed_at
           ) VALUES (?,?,'codex',?,?, 'completed',1,?,?,?)`,
        ).run(
          profile.id,
          profile.processGeneration,
          runtimeScope,
          priorAccountKey,
          1_000,
          1_000,
          1_000,
        );
      }
    } finally {
      direct.close();
    }

    await expect(value.service.execute({
      account: profile.id,
      deviceCode: false,
      kind: "account.login",
    }, { signal })).resolves.toMatchObject({
      account: { id: profile.id, state: "signed_in" },
      login: { status: "signed_in" },
    });

    for (const runtimeScope of ["personal", "managed"] as const) {
      expect(value.store.readProviderRuntimeAccountRevocation({
        profileId: profile.id,
        provider: "codex",
        runtimeScope,
      })).toMatchObject({
        currentAccountKey: null,
        profileGeneration: profile.processGeneration,
        state: "completed",
      });
    }
    expect(value.codex.releasedAuthorities).toContainEqual({
      ...capturedAuthority,
    });
  });

  test("failed managed Claude shutdown preserves the live generation and exact process authority", async () => {
    let providerThreadId = "native-claude-failed-shutdown";
    const identity: ClaudeProcessIdentity = {
      pid: 63_022,
      pidDomain: "darwin",
      procStart: "native-claude-failed-shutdown-process",
    };
    const value = await nativeClaudeFixture(
      "Native Claude failed shutdown",
      providerThreadId,
      identity,
    );
    providerThreadId = value.providerThreadId;
    const profileBefore = value.store.requireProfileById(value.accountId);
    const processBefore = value.store.readClaudeProcessAuthority({
      providerThreadId,
      profileId: value.accountId,
      runtimeScope: "managed",
    });
    if (processBefore === null) throw new Error("Expected native Claude process authority.");
    expect(processBefore).toMatchObject({
      identity,
      profileGeneration: profileBefore.processGeneration,
      sessionId: value.session.id,
      state: "bound",
    });
    value.managedClaude.closeError = new Error(
      "managed Claude child exit could not be proved",
    );

    await expect(value.service.close()).rejects.toBeInstanceOf(Error);

    expect(value.codex.closeCalls).toBe(1);
    expect(value.managedClaude.closeCalls).toBe(1);
    expect(value.store.requireProfileById(value.accountId)).toMatchObject({
      processGeneration: profileBefore.processGeneration,
      state: profileBefore.state,
    });
    expect(value.store.readClaudeProcessAuthority({
      providerThreadId,
      profileId: value.accountId,
      runtimeScope: "managed",
    })).toEqual(processBefore);
  });

  test("successful managed Claude shutdown releases exact process authority before generation retirement", async () => {
    let providerThreadId = "native-claude-clean-shutdown";
    const identity: ClaudeProcessIdentity = {
      pid: 63_023,
      pidDomain: "darwin",
      procStart: "native-claude-clean-shutdown-process",
    };
    const value = await nativeClaudeFixture(
      "Native Claude clean shutdown",
      providerThreadId,
      identity,
    );
    providerThreadId = value.providerThreadId;
    const profileBefore = value.store.requireProfileById(value.accountId);
    expect(value.store.readClaudeProcessAuthority({
      providerThreadId,
      profileId: value.accountId,
      runtimeScope: "managed",
    })).toMatchObject({
      identity,
      profileGeneration: profileBefore.processGeneration,
      sessionId: value.session.id,
      state: "bound",
    });

    await expect(value.service.close()).resolves.toBeUndefined();

    expect(value.codex.closeCalls).toBe(1);
    expect(value.managedClaude.closeCalls).toBe(1);
    expect(value.store.readClaudeProcessAuthority({
      providerThreadId,
      profileId: value.accountId,
      runtimeScope: "managed",
    })).toMatchObject({
      identity,
      profileGeneration: profileBefore.processGeneration,
      sessionId: value.session.id,
      state: "released",
    });
    expect(value.store.requireProfileById(value.accountId)).toMatchObject({
      processGeneration: profileBefore.processGeneration + 1,
      state: profileBefore.state,
    });
  });

  test("releases adopted controllers before authoritative account sign-out completes", async () => {
    const value = await adoptedCodexFixture(
      "Adopted sign-out",
      "personal-thread-sign-out",
    );
    const authority = value.personalCodex.claimRequests[0]?.authority;
    if (authority === undefined) throw new Error("Expected personal claim authority.");
    const requestId = "adopted-sign-out-approval";
    await value.service.observePersonalCodexFact(authority, {
      type: "interactionRequested",
      connectionId: value.personalCodex.observationConnectionId,
      provider: {
        profileId: value.accountId,
        processGeneration: authority.generation,
        provider: authority.provider,
        providerAccountId: authority.providerAccountId,
        bindingGeneration: authority.bindingGeneration,
        connectionId: value.personalCodex.observationConnectionId,
        requestId: { type: "string", value: requestId },
        method: "item/commandExecution/requestApproval",
        requestDigest: createHash("sha256").update(requestId).digest("hex"),
        threadId: value.session.providerThreadId ?? null,
        turnId: "turn-adopted-sign-out",
        itemId: "item-adopted-sign-out",
        approvalId: null,
      },
      kind: "command_approval",
      blocking: true,
      display: {
        kind: "command_approval",
        summary: "Do not answer after sign-out",
        reason: null,
        commandClass: "bun test",
        workingDirectory: null,
        availableDecisions: ["once", "decline", "cancel"],
      },
    });
    const interaction = value.store.listInteractions({
      sessionId: value.session.id,
      pendingOnly: true,
      limit: 10,
    })[0];
    if (interaction === undefined) throw new Error("Expected pending interaction.");
    const releasesBefore = value.personalCodex.releasedAuthorities.length;

    await expect(value.service.observeCodexAccount(authority, { signedIn: false }))
      .rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    await value.service.settled();

    expect(value.personalCodex.releasedAuthorities).toHaveLength(releasesBefore + 1);
    expect(value.personalCodex.releasedAuthorities.at(-1)).toEqual(authority);
    expect(value.store.requireProfileById(value.accountId).state).toBe("signed_out");
    expect(value.store.readSessionPersonalRuntimeBinding(value.session.id)).toBeNull();
    expect(value.store.readSessionPersonalRuntimeBinding(value.session.id, true))
      .toMatchObject({ state: "detached" });
    expect(value.store.requireSession(value.session.id)).toMatchObject({
      state: "recovery_required",
      archivedAt: expect.any(Number),
    });
    expect(value.store.requireInteraction(interaction.publicId).state).toBe("expired");
    expect(value.personalCodex.resolvedInteractions).toHaveLength(0);
    expect(value.store.readSessionAdoptionPolicy("codex")).toMatchObject({
      enabled: false,
      profileId: null,
    });
    expect(value.store.readProfilePersonalAuthorityRevocation(value.accountId))
      .toMatchObject({ state: "completed" });
  });

  test("recovers a durably staged personal-controller revocation after daemon loss", async () => {
    const value = await adoptedCodexFixture(
      "Adopted sign-out recovery",
      "personal-thread-sign-out-recovery",
    );
    const profile = value.store.requireProfileById(value.accountId);
    value.store.stageProfilePersonalAuthorityRevocation({
      profileId: profile.id,
      expectedGeneration: profile.processGeneration,
    });
    const restartedGeneration = profile.processGeneration + 1;
    value.store.nextDaemonGeneration(crypto.randomUUID());
    expect(value.store.requireProfileById(value.accountId).processGeneration)
      .toBe(restartedGeneration);
    expect(value.store.readProfilePersonalAuthorityRevocation(value.accountId))
      .toMatchObject({
        profileGeneration: restartedGeneration,
        state: "releasing",
      });
    const releasesBefore = value.personalCodex.releasedAuthorities.length;

    // Simulate process loss after the sign-out fact was staged but before the
    // asynchronous controller release began. Recovery must finish from the
    // durable revocation row before it admits any session resubscriptions.
    const restarted = new OompaService({
      store: value.store,
      paths: value.paths,
      codex: new FakeCodex(),
      personalCodex: value.personalCodex,
      personalCodexHome,
      cloud: new FakeCloud(),
      daemonAuthority: new FakeDaemonAuthority(),
      eventCursors: value.eventCursors,
      now: () => personalAdoptionNow,
      requestStop: () => undefined,
    });
    await expect(restarted.recover()).resolves.toBeUndefined();

    expect(value.personalCodex.releasedAuthorities).toHaveLength(releasesBefore + 1);
    expect(value.personalCodex.releasedAuthorities.at(-1)).toMatchObject({
      id: value.accountId,
      generation: restartedGeneration,
    });
    expect(value.store.requireProfileById(value.accountId).state).toBe("signed_out");
    expect(value.store.readSessionPersonalRuntimeBinding(value.session.id)).toBeNull();
    expect(value.store.readSessionPersonalRuntimeBinding(value.session.id, true))
      .toMatchObject({ state: "detached" });
    expect(value.store.requireSession(value.session.id)).toMatchObject({
      state: "recovery_required",
      archivedAt: expect.any(Number),
    });
    expect(value.store.readProfilePersonalAuthorityRevocation(value.accountId))
      .toMatchObject({ state: "completed" });
    await restarted.close();
  });

  test("releases a claimed personal thread when durable adoption collides", async () => {
    const personalCodex = new FakeCodex();
    const discovery = new FakePersonalSessionDiscovery();
    const value = await fixture(new FakeCloud(),
      () => undefined,
      () => personalAdoptionNow,
      undefined,
      {},
      {
        personalCodex,
        personalCodexHome,
        personalDiscovery: discovery,
      },
    );
    const existingOwner = await value.service.execute(
      { kind: "account.add", label: "Existing thread owner" },
      { signal },
    ) as { account: { id: `acct_${string}` } };
    await value.service.execute({
      kind: "account.login",
      account: existingOwner.account.id,
      deviceCode: false,
    }, { signal });
    await value.service.execute({
      kind: "project.add",
      label: "Adoption collision project",
      path: value.documents,
    }, { signal });
    const existing = await value.service.execute({
      kind: "session.start",
      account: existingOwner.account.id,
      preset: "high",
      presetContract: currentPresetContract,
      fast: false,
    }, { signal }) as { session: { id: `sess_${string}`; providerThreadId: string } };
    const adoptingOwner = await value.service.execute(
      { kind: "account.add", label: "Adopting thread owner" },
      { signal },
    ) as { account: { id: `acct_${string}` } };
    await value.service.execute({
      kind: "account.login",
      account: adoptingOwner.account.id,
      deviceCode: false,
    }, { signal });
    personalCodex.readProjection = {
      providerThreadId: existing.session.providerThreadId,
      title: "Colliding personal thread",
      status: "idle",
      projectRoot: value.documents,
      providerUpdatedAt: personalAdoptionNow - 1_000,
    };
    discovery.candidates = [{
      provider: "codex",
      providerThreadId: existing.session.providerThreadId,
      title: "Colliding personal thread",
      projectRoot: value.documents,
      updatedAt: personalAdoptionNow - 1_000,
      liveness: "not_live",
    }];

    await expect(value.service.execute({
      kind: "session.adoption.set",
      provider: "codex",
      enabled: true,
      account: adoptingOwner.account.id,
    }, { signal })).resolves.toMatchObject({
      discovery: { provider: "codex", state: "ready", adopted: 0, failed: 1 },
    });
    expect(personalCodex.calls.filter((call) => call === "claim")).toHaveLength(1);
    expect(personalCodex.calls.filter((call) => call === "end")).toHaveLength(1);
    expect(value.store.findSessionByProviderThread(
      adoptingOwner.account.id,
      existing.session.providerThreadId,
    )).toBeNull();
    expect(value.store.listSessionPersonalRuntimeBindings()).toHaveLength(0);
    expect(value.store.listSessionAdoptionCandidates({ provider: "codex" })[0])
      .toMatchObject({ status: "pending" });
  });

  test("finishes a crash-left detach fence before skipping a quarantined session", async () => {
    const value = await adoptedCodexFixture(
      "Adopted detach restart",
      "personal-thread-detach-restart",
    );
    expect(value.store.quarantineSession(value.session.id))
      .toMatchObject({ state: "recovery_required" });
    value.store.beginPersonalSessionDetach({ sessionId: value.session.id });
    await value.service.close();

    const personalCodex = new FakeCodex();
    const restarted = new OompaService({
      store: value.store,
      paths: value.paths,
      codex: new FakeCodex(),
      personalCodex,
      personalCodexHome,
      cloud: new FakeCloud(),
      daemonAuthority: new FakeDaemonAuthority(),
      eventCursors: value.eventCursors,
      now: () => personalAdoptionNow,
      requestStop: () => undefined,
    });
    await restarted.recover();
    await restarted.settled();

    expect(personalCodex.claimRequests).toHaveLength(0);
    expect(personalCodex.releasedAuthorities).toHaveLength(1);
    expect(value.store.readSessionPersonalRuntimeBinding(value.session.id, true))
      .toMatchObject({ state: "detached" });
    await restarted.close();
  });
});

describe("OompaService autorespond", () => {
  const waitFor = async (predicate: () => boolean, timeoutMs = 2_000): Promise<void> => {
    const startedAt = Date.now();
    while (!predicate()) {
      if (Date.now() - startedAt > timeoutMs) throw new Error("Timed out waiting for autorespond.");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };

  const requestCommandApproval = async (
    value: Awaited<ReturnType<typeof fixture>>,
    sessionId: string,
    requestId: string,
    afterObservation?: () => Promise<void>,
  ) => {
    const session = value.store.requireSession(sessionId);
    const profile = value.store.requireProfileById(session.profileId);
    if (session.providerThreadId === undefined) throw new Error("Expected a bound session.");
    const authority = liveAuthorityFor(value.store, profile.id);
    const connectionId = value.codex.observationConnectionId;
    await value.service.observeCodexFact(authority, {
      type: "interactionRequested",
      connectionId,
      provider: {
        profileId: profile.id,
        processGeneration: profile.processGeneration,
        provider: authority.provider,
        providerAccountId: authority.providerAccountId,
        bindingGeneration: authority.bindingGeneration,
        connectionId,
        requestId: { type: "string" as const, value: requestId },
        method: "item/commandExecution/requestApproval",
        requestDigest: createHash("sha256").update(requestId).digest("hex"),
        threadId: session.providerThreadId,
        turnId: "turn-autorespond",
        itemId: `item-${requestId}`,
        approvalId: null,
      },
      kind: "command_approval",
      blocking: true,
      display: {
        kind: "command_approval",
        summary: "Run the test suite",
        reason: null,
        commandClass: "bun test",
        workingDirectory: null,
        availableDecisions: ["once", "session", "decline", "cancel"],
      },
    });
    if (afterObservation !== undefined) await afterObservation();
    const interaction = value.store.listInteractions({ sessionId, limit: 50 })
      .find((candidate) => candidate.authority.requestId.value === requestId);
    if (interaction === undefined) throw new Error("Expected a command approval interaction.");
    return interaction;
  };

  const requestPermissionApproval = async (
    value: Awaited<ReturnType<typeof fixture>>,
    sessionId: string,
    requestId: string,
    requested: readonly string[],
  ) => {
    const session = value.store.requireSession(sessionId);
    const profile = value.store.requireProfileById(session.profileId);
    if (session.providerThreadId === undefined) throw new Error("Expected a bound session.");
    const connectionId = value.codex.observationConnectionId;
    const authority = liveAuthorityFor(value.store, profile.id);
    await value.service.observeCodexFact(authority, {
      type: "interactionRequested",
      connectionId,
      provider: {
        profileId: profile.id,
        processGeneration: profile.processGeneration,
        provider: authority.provider,
        providerAccountId: authority.providerAccountId,
        bindingGeneration: authority.bindingGeneration,
        connectionId,
        requestId: { type: "string" as const, value: requestId },
        method: "item/permissions/requestApproval",
        requestDigest: createHash("sha256").update(requestId).digest("hex"),
        threadId: session.providerThreadId,
        turnId: "turn-autorespond",
        itemId: `item-${requestId}`,
        approvalId: null,
      },
      kind: "permission_approval",
      blocking: true,
      display: {
        kind: "permission_approval",
        summary: "Allow requested permissions",
        reason: null,
        requested: requested.map((name) => ({ name })),
        allowsSessionScope: true,
      },
    });
    const interaction = value.store.listInteractions({ sessionId, limit: 10 })
      .find((candidate) => candidate.authority.requestId.value === requestId);
    if (interaction === undefined) throw new Error("Expected a permission approval interaction.");
    return interaction;
  };

  const requestFileChangeApproval = async (
    value: Awaited<ReturnType<typeof fixture>>,
    sessionId: string,
    requestId: string,
  ) => {
    const session = value.store.requireSession(sessionId);
    const profile = value.store.requireProfileById(session.profileId);
    if (session.providerThreadId === undefined) throw new Error("Expected a bound session.");
    const connectionId = value.codex.observationConnectionId;
    const authority = liveAuthorityFor(value.store, profile.id);
    await value.service.observeCodexFact(authority, {
      type: "interactionRequested",
      connectionId,
      provider: {
        profileId: profile.id,
        processGeneration: profile.processGeneration,
        provider: authority.provider,
        providerAccountId: authority.providerAccountId,
        bindingGeneration: authority.bindingGeneration,
        connectionId,
        requestId: { type: "string" as const, value: requestId },
        method: "item/fileChange/requestApproval",
        requestDigest: createHash("sha256").update(requestId).digest("hex"),
        threadId: session.providerThreadId,
        turnId: "turn-autorespond",
        itemId: `item-${requestId}`,
        approvalId: null,
      },
      kind: "file_change_approval",
      blocking: true,
      display: {
        kind: "file_change_approval",
        summary: "Allow proposed file changes",
        reason: null,
        grantRoot: null,
        availableDecisions: ["once", "decline", "cancel"],
      },
    });
    const interaction = value.store.listInteractions({ sessionId, limit: 10 })
      .find((candidate) => candidate.authority.requestId.value === requestId);
    if (interaction === undefined) throw new Error("Expected a file-change approval interaction.");
    return interaction;
  };

  test("accepts a command approval at once scope under auto:all and records evidence", async () => {
    const value = await fixture();
    const { sessionId } = await createIdleSession(value, "Autorespond");
    value.store.setDefaultApprovalMode("auto:all");
    const interaction = await requestCommandApproval(value, sessionId, "autorespond-1");
    await waitFor(() => value.codex.resolvedInteractions.length === 1);
    expect(value.codex.resolvedInteractions[0]).toMatchObject({
      kind: "command_approval",
      resolution: { kind: "approval_decision", decision: "once" },
    });
    await waitFor(() => value.store.listAutorespondEvidence({ sessionId }).length === 1);
    expect(value.store.listAutorespondEvidence({ sessionId })[0]).toMatchObject({
      approvalClass: "command:bun test",
      decision: "once",
      kind: "command_approval",
      mode: "auto:all",
      outcome: "accepted",
    });
    expect(value.store.requireInteraction(interaction.publicId).state).not.toBe("pending");
    expect(value.store.requireInteraction(interaction.publicId).resolvedBy).toBe("autorespond");
    expect(value.store.readAutorespondBudgets(sessionId).consecutive).toBe(1);
  });

  const configureAfterHours = async (
    value: Awaited<ReturnType<typeof fixture>>,
    enabled: boolean,
  ): Promise<void> => {
    await value.service.execute({
      kind: "notification-hours.set", expectedRevision: 1, version: 1,
      startMinute: 600, endMinute: 1_320, timeZone: "UTC",
    }, { signal });
    if (enabled) await value.service.execute({
      kind: "autorespond-after-hours.enable", expectedRevision: 1,
    }, { signal });
  };

  const acceptProtocolApprovals = async (
    value: Awaited<ReturnType<typeof fixture>>,
    sessionId: string,
    count: number,
    prefix: string,
  ): Promise<void> => {
    const before = value.codex.resolvedInteractions.length;
    for (let index = 0; index < count; index += 1) {
      const interaction = await requestCommandApproval(value, sessionId, `${prefix}-${String(index)}`);
      await value.service.settled();
      expect(value.store.requireInteraction(interaction.publicId).resolvedBy).toBe("autorespond");
      expect(value.codex.resolvedInteractions).toHaveLength(before + index + 1);
    }
  };

  test("keeps after-hours consent default-off and CAS-bound without changing notifications or resetting spend", async () => {
    const now = Date.parse("2026-09-04T09:59:59.999Z");
    const value = await fixture(new FakeCloud(), () => undefined, () => now);
    const { sessionId } = await createIdleSession(value, "Separate after-hours consent");
    value.store.setSessionApprovalMode(sessionId, "auto:all");
    await acceptProtocolApprovals(value, sessionId, 1, "separate-consent");
    const budgetsBefore = value.store.readAutorespondBudgets(sessionId);
    const modeBefore = value.store.readSessionApprovalMode(sessionId);
    const disabled = { policy: { kind: "autorespond_after_hours", version: 1, revision: 1, enabled: false } };
    expect(await value.service.execute({ kind: "autorespond-after-hours.status" }, { signal })).toEqual(disabled);

    await configureAfterHours(value, false);
    await value.service.execute({ kind: "notification-email.enable", expectedRevision: 2 }, { signal });
    expect(await value.service.execute({ kind: "autorespond-after-hours.status" }, { signal })).toEqual(disabled);
    const hoursBefore = await value.service.execute({ kind: "notification-hours.status" }, { signal });
    const emailBefore = await value.service.execute({ kind: "notification-email.status" }, { signal });
    const callsBefore = [...value.codex.calls];
    const enabled = { policy: { ...disabled.policy, enabled: true, revision: 2 } };
    expect(await value.service.execute({ kind: "autorespond-after-hours.enable", expectedRevision: 1 }, { signal })).toEqual(enabled);
    await expect(value.service.execute({ kind: "autorespond-after-hours.disable", expectedRevision: 1 }, { signal }))
      .rejects.toMatchObject({ code: "CONFLICT", name: "CommandFailure" });
    expect(await value.service.execute({ kind: "autorespond-after-hours.status" }, { signal })).toEqual(enabled);
    expect(await value.service.execute({ kind: "autorespond-after-hours.disable", expectedRevision: 2 }, { signal }))
      .toEqual({ policy: { ...disabled.policy, revision: 3 } });
    expect(await value.service.execute({ kind: "notification-hours.status" }, { signal })).toEqual(hoursBefore);
    expect(await value.service.execute({ kind: "notification-email.status" }, { signal })).toEqual(emailBefore);
    expect(value.store.readAutorespondBudgets(sessionId)).toEqual(budgetsBefore);
    expect(value.store.readSessionApprovalMode(sessionId)).toEqual(modeBefore);
    expect(value.codex.calls).toEqual(callsBefore);
  });

  test.each([
    { label: "enabled outside hours", enabled: true, instant: "2026-09-04T09:59:59.999Z", cap: 6 },
    { label: "disabled outside hours", enabled: false, instant: "2026-09-04T09:59:59.999Z", cap: 3 },
    { label: "enabled inside hours", enabled: true, instant: "2026-09-04T10:00:00.000Z", cap: 3 },
  ])("keeps the protocol consecutive cap at $cap when $label", async ({ label, enabled, instant, cap }) => {
    const now = Date.parse(instant);
    const value = await fixture(new FakeCloud(), () => undefined, () => now);
    const { sessionId } = await createIdleSession(value, label);
    await configureAfterHours(value, enabled);
    value.store.setSessionApprovalMode(sessionId, "auto:all");
    await acceptProtocolApprovals(value, sessionId, cap, `cap-${String(cap)}`);
    const refused = await requestCommandApproval(value, sessionId, "after-hours-cap-refused");
    await value.service.settled();
    expect(value.codex.resolvedInteractions).toHaveLength(cap);
    expect(value.store.readAutorespondBudgets(sessionId)).toEqual({ consecutive: cap, lastHour: cap, lastDay: cap });
    expect(value.store.requireInteraction(refused.publicId).state).toBe("pending");
    expect(value.store.listAutorespondEvidence({ sessionId }).find((row) => row.interactionId === refused.publicId))
      .toMatchObject({ decision: "consecutive_limit", outcome: "refused" });
    expect(value.store.readSessionState(sessionId)).toMatchObject({
      state: "needs_approval", attention: true, reason: "autorespond_consecutive_limit",
    });
  });

  test.each(["disable policy", "change notification hours", "cross exact start boundary"] as const)(
    "rechecks after-hours authority after protocol validation: %s",
    async (change) => {
      let now = Date.parse("2026-09-04T09:59:59.999Z");
      const value = await fixture(new FakeCloud(), () => undefined, () => now);
      const { sessionId } = await createIdleSession(value, `After-hours ${change}`);
      await configureAfterHours(value, true);
      value.store.setSessionApprovalMode(sessionId, "auto:all");
      await acceptProtocolApprovals(value, sessionId, 3, "before-authority-change");
      const before = value.store.readAutorespondBudgets(sessionId);
      let validationStarted = false;
      let releaseValidation!: () => void;
      const gate = new Promise<void>((resolve) => { releaseValidation = resolve; });
      value.codex.beforeValidateInteractionResolutionReturn = async () => {
        validationStarted = true;
        await gate;
      };
      const interaction = await requestCommandApproval(value, sessionId, "after-hours-authority-race");
      try {
        await waitFor(() => validationStarted);
        expect(value.codex.resolvedInteractions).toHaveLength(3);
        if (change === "disable policy") {
          await value.service.execute({ kind: "autorespond-after-hours.disable", expectedRevision: 2 }, { signal });
        } else if (change === "change notification hours") {
          await value.service.execute({
            kind: "notification-hours.set", expectedRevision: 2, version: 1,
            startMinute: 540, endMinute: 1_320, timeZone: "UTC",
          }, { signal });
        } else {
          now = Date.parse("2026-09-04T10:00:00.000Z");
        }
      } finally {
        releaseValidation();
      }
      await value.service.settled();
      expect(value.codex.resolvedInteractions).toHaveLength(3);
      expect(value.store.requireInteraction(interaction.publicId)).toMatchObject({
        state: "pending", revision: interaction.revision,
      });
      expect(value.store.readAutorespondBudgets(sessionId)).toEqual(before);
      expect(value.store.listAutorespondEvidence({ sessionId }).find((row) => row.interactionId === interaction.publicId))
        .toMatchObject({ decision: "consecutive_limit", outcome: "refused" });
      expect(value.store.readSessionState(sessionId)).toMatchObject({
        state: "needs_approval", attention: true, reason: "autorespond_consecutive_limit",
      });
    },
  );

  test("reserves only the sixth after-hours slot across concurrent protocol approvals", async () => {
    const now = Date.parse("2026-09-04T09:59:59.999Z");
    const value = await fixture(new FakeCloud(), () => undefined, () => now);
    const { sessionId } = await createIdleSession(value, "Concurrent after-hours approvals");
    await configureAfterHours(value, true);
    value.store.setSessionApprovalMode(sessionId, "auto:all");
    await acceptProtocolApprovals(value, sessionId, 5, "before-concurrent-after-hours");
    let validationStarted = false;
    let releaseValidation!: () => void;
    const gate = new Promise<void>((resolve) => { releaseValidation = resolve; });
    value.codex.beforeValidateInteractionResolutionReturn = async () => {
      validationStarted = true;
      await gate;
    };
    const first = await requestCommandApproval(value, sessionId, "after-hours-concurrent-first");
    let secondObserved = false;
    let secondAdmission: Promise<InteractionRecord>;
    try {
      await waitFor(() => validationStarted);
      secondAdmission = requestCommandApproval(value, sessionId, "after-hours-concurrent-second", async () => {
        secondObserved = true;
        await value.service.settled();
      });
      await waitFor(() => secondObserved);
      expect(value.codex.resolvedInteractions).toHaveLength(5);
      expect(value.store.readAutorespondBudgets(sessionId).consecutive).toBe(5);
    } finally {
      releaseValidation();
    }
    const second = await secondAdmission;
    await value.service.settled();
    expect(value.codex.resolvedInteractions).toHaveLength(6);
    expect(value.store.requireInteraction(first.publicId).resolvedBy).toBe("autorespond");
    expect(value.store.requireInteraction(second.publicId).state).toBe("pending");
    expect(value.store.readAutorespondBudgets(sessionId)).toEqual({ consecutive: 6, lastHour: 6, lastDay: 6 });
    expect(value.store.listAutorespondEvidence({ sessionId }).find((row) => row.interactionId === second.publicId))
      .toMatchObject({ decision: "consecutive_limit", outcome: "refused" });
    expect(value.store.readSessionState(sessionId)).toMatchObject({
      state: "needs_approval", attention: true, reason: "autorespond_consecutive_limit",
    });
  });

  test.each([
    { code: "consecutive_limit", consecutive: 2, priorAcceptances: 0, ageMs: 0, limit: 3, field: "consecutive" },
    { code: "hourly_budget", consecutive: 0, priorAcceptances: 9, ageMs: 0, limit: 10, field: "lastHour" },
    { code: "daily_budget", consecutive: 0, priorAcceptances: 39, ageMs: 2 * 60 * 60 * 1_000, limit: 40, field: "lastDay" },
  ] as const)("enforces $code across concurrently admitted protocol approvals", async (budget) => {
    let now = 1_900_000_000_000;
    const value = await fixture(new FakeCloud(), () => undefined, () => now);
    const { sessionId } = await createIdleSession(value, `Concurrent ${budget.code}`);
    value.store.setSessionApprovalMode(sessionId, "auto:all");
    for (let count = 0; count < budget.consecutive; count += 1) {
      value.store.bumpAutorespondCounter(sessionId);
    }
    for (let count = 0; count < budget.priorAcceptances; count += 1) {
      if (budget.code === "daily_budget" && count > 0 && count % 9 === 0) {
        now += 2 * 60 * 60 * 1_000;
      }
      value.store.setSessionApprovalMode(sessionId, "manual");
      const prior = await requestCommandApproval(value, sessionId, `${budget.code}-prior-${count}`);
      await value.service.settled();
      value.store.setSessionApprovalMode(sessionId, "auto:all");
      expect(value.store.reserveAutorespondBudget({
        sessionId,
        sourceId: prior.publicId,
        sourceKind: "protocol",
        expectedMode: "auto:all",
      })).toEqual({ state: "reserved" });
      value.store.resetAutorespondCounter(sessionId);
    }
    now += budget.ageMs;
    expect(value.store.readAutorespondBudgets(sessionId)[budget.field]).toBe(budget.limit - 1);

    let validationStarted!: () => void;
    const validationAdmission = new Promise<void>((resolve) => { validationStarted = resolve; });
    let releaseValidation!: () => void;
    const validationGate = new Promise<void>((resolve) => { releaseValidation = resolve; });
    value.codex.beforeValidateInteractionResolutionReturn = async () => {
      validationStarted();
      await validationGate;
    };

    const first = await requestCommandApproval(value, sessionId, `${budget.code}-first`);
    await validationAdmission;
    let secondObserved!: () => void;
    const secondObservation = new Promise<void>((resolve) => { secondObserved = resolve; });
    const secondAdmission = requestCommandApproval(value, sessionId, `${budget.code}-second`, async () => {
      secondObserved();
      await value.service.settled();
    });
    await secondObservation;
    releaseValidation();
    const second = await secondAdmission;
    await value.service.settled();

    expect(value.codex.resolvedInteractions).toHaveLength(1);
    expect(value.store.requireInteraction(first.publicId).resolvedBy).toBe("autorespond");
    expect(value.store.requireInteraction(second.publicId).state).toBe("pending");
    const evidence = value.store.listAutorespondEvidence({ sessionId, limit: 50 })
      .filter((row) => row.interactionId === first.publicId || row.interactionId === second.publicId);
    expect(evidence).toHaveLength(2);
    expect(evidence.find((row) => row.interactionId === first.publicId))
      .toMatchObject({ decision: "once", outcome: "accepted" });
    expect(evidence.find((row) => row.interactionId === second.publicId))
      .toMatchObject({ decision: budget.code, outcome: "refused" });
    expect(value.store.readAutorespondBudgets(sessionId)[budget.field]).toBe(budget.limit);
  });

  test("rechecks manual mode after protocol validation before resolving an approval", async () => {
    const value = await fixture();
    const { sessionId } = await createIdleSession(value, "Protocol policy race");
    value.store.setSessionApprovalMode(sessionId, "auto:all");
    let validationStarted!: () => void;
    const validationAdmission = new Promise<void>((resolve) => { validationStarted = resolve; });
    let releaseValidation!: () => void;
    const validationGate = new Promise<void>((resolve) => { releaseValidation = resolve; });
    value.codex.beforeValidateInteractionResolutionReturn = async () => {
      validationStarted();
      await validationGate;
    };

    const interaction = await requestCommandApproval(value, sessionId, "protocol-policy-race");
    await validationAdmission;
    await value.service.execute({ kind: "autorespond.set", session: sessionId, mode: "manual" }, { signal });
    releaseValidation();
    await value.service.settled();

    expect(value.codex.resolvedInteractions).toHaveLength(0);
    expect(value.store.requireInteraction(interaction.publicId).state).toBe("pending");
    expect(value.store.listAutorespondEvidence({ sessionId })).toEqual([
      expect.objectContaining({
        decision: "manual_mode",
        interactionId: interaction.publicId,
        mode: "manual",
        outcome: "refused",
      }),
    ]);
  });

  test("keeps an indeterminate protocol autoresponse charged after reopening storage", async () => {
    const value = await fixture();
    const { sessionId } = await createIdleSession(value, "Uncertain protocol budget");
    value.store.setSessionApprovalMode(sessionId, "auto:all");
    value.store.bumpAutorespondCounter(sessionId);
    value.store.bumpAutorespondCounter(sessionId);
    value.codex.resolveInteractionError = new CodexError(
      "INDETERMINATE_EFFECT",
      "the response write may have reached the provider",
    );

    const interaction = await requestCommandApproval(value, sessionId, "uncertain-protocol-budget");
    await value.service.settled();
    expect(value.codex.resolvedInteractions).toHaveLength(1);
    expect(value.store.requireInteraction(interaction.publicId).state).toBe("resolution_unknown");
    expect(value.store.readAutorespondBudgets(sessionId)).toMatchObject({
      consecutive: 3,
      lastHour: 1,
      lastDay: 1,
    });

    await value.service.close();
    value.store.close();
    const reopened = new StateStore(value.paths);
    stores.push(reopened);
    expect(reopened.readAutorespondBudgets(sessionId)).toMatchObject({
      consecutive: 3,
      lastHour: 1,
      lastDay: 1,
    });
    expect(reopened.requireInteraction(interaction.publicId).state).toBe("resolution_unknown");
  });

  test("keeps command approvals pending under auto:workspace without trusting their display class", async () => {
    const value = await fixture();
    const { sessionId } = await createIdleSession(value, "Workspace command guard");
    value.store.setSessionApprovalMode(sessionId, "auto:workspace");
    const interaction = await requestCommandApproval(value, sessionId, "workspace-command-1");
    await waitFor(() => value.store.listAutorespondEvidence({ sessionId }).length === 1);
    expect(value.codex.validatedInteractions).toHaveLength(0);
    expect(value.codex.resolvedInteractions).toHaveLength(0);
    expect(value.store.requireInteraction(interaction.publicId).state).toBe("pending");
    expect(value.store.readSessionState(sessionId)).toMatchObject({
      attention: true,
      reason: "autorespond_protected_authority_required",
      state: "needs_approval",
    });
  });

  test("raises attention only when a refused provider resolution remains pending", async () => {
    const pendingValue = await fixture();
    const { sessionId: pendingSessionId } = await createIdleSession(pendingValue, "Pending refusal");
    pendingValue.store.setSessionApprovalMode(pendingSessionId, "auto:all");
    pendingValue.codex.validateInteractionResolutionError = new CodexError("INVALID_INPUT", "refused");
    const pending = await requestCommandApproval(pendingValue, pendingSessionId, "pending-refusal-1");
    await waitFor(() => pendingValue.store.listAutorespondEvidence({ sessionId: pendingSessionId }).length === 1);
    expect(pendingValue.store.requireInteraction(pending.publicId).state).toBe("pending");
    expect(pendingValue.store.readSessionState(pendingSessionId)).toMatchObject({
      attention: true,
      reason: "autorespond_resolution_refused",
      state: "needs_approval",
    });

    const terminalValue = await fixture();
    const { sessionId: terminalSessionId } = await createIdleSession(terminalValue, "Terminal refusal");
    terminalValue.store.setSessionApprovalMode(terminalSessionId, "auto:all");
    terminalValue.codex.validateInteractionResolutionError = new CodexError("PROCESS_EXITED", "closed");
    const terminal = await requestCommandApproval(terminalValue, terminalSessionId, "terminal-refusal-1");
    await waitFor(() => terminalValue.store.listAutorespondEvidence({ sessionId: terminalSessionId }).length === 1);
    expect(terminalValue.store.requireInteraction(terminal.publicId).state).toBe("expired");
    expect(terminalValue.store.readSessionState(terminalSessionId)?.reason)
      .not.toBe("autorespond_resolution_refused");
  });

  test("leaves approvals pending under manual mode", async () => {
    const value = await fixture();
    const { sessionId } = await createIdleSession(value, "Manual");
    value.store.setSessionApprovalMode(sessionId, "manual");
    const interaction = await requestCommandApproval(value, sessionId, "manual-1");
    await waitFor(() => value.store.listAutorespondEvidence({ sessionId }).length === 1);
    expect(value.codex.resolvedInteractions).toHaveLength(0);
    expect(value.store.requireInteraction(interaction.publicId).state).toBe("pending");
    expect(value.store.listAutorespondEvidence({ sessionId })).toEqual([
      expect.objectContaining({
        decision: "manual_mode",
        interactionId: interaction.publicId,
        mode: "manual",
        outcome: "refused",
        path: "protocol",
      }),
    ]);
    expect(value.store.readSessionState(sessionId)).toMatchObject({
      attention: true,
      reason: "autorespond_manual_mode",
      state: "needs_approval",
    });
  });

  test("keeps every unattested workspace permission pending without a provider call", async () => {
    const value = await fixture();
    const { sessionId } = await createIdleSession(value, "Workspace permission guard");
    value.store.setSessionApprovalMode(sessionId, "auto:workspace");
    for (const [index, name] of ["workspace_write", "camera", "file_camera"].entries()) {
      const interaction = await requestPermissionApproval(value, sessionId, `workspace-permission-${String(index)}`, [name]);
      await waitFor(() => value.store.listAutorespondEvidence({ sessionId }).length === index + 1);
      expect(value.store.requireInteraction(interaction.publicId).state).toBe("pending");
    }
    expect(value.codex.validatedInteractions).toHaveLength(0);
    expect(value.codex.resolvedInteractions).toHaveLength(0);
    expect(value.store.listAutorespondEvidence({ sessionId }))
      .toHaveLength(3);
    expect(value.store.listAutorespondEvidence({ sessionId }).every((row) =>
      row.decision === "protected_authority_required" && row.outcome === "refused")).toBe(true);
    expect(value.store.readSessionState(sessionId)).toMatchObject({
      attention: true,
      reason: "autorespond_protected_authority_required",
      state: "needs_approval",
    });
  });

  test("keeps file changes pending without a provider call in every automatic mode", async () => {
    const value = await fixture();
    const { sessionId } = await createIdleSession(value, "File change guard");
    for (const [index, mode] of (["auto:all", "auto:workspace"] as const).entries()) {
      value.store.setSessionApprovalMode(sessionId, mode);
      const interaction = await requestFileChangeApproval(value, sessionId, `file-change-${String(index)}`);
      await waitFor(() => value.store.listAutorespondEvidence({ sessionId }).length === index + 1);
      expect(value.store.requireInteraction(interaction.publicId).state).toBe("pending");
    }
    expect(value.codex.validatedInteractions).toHaveLength(0);
    expect(value.codex.resolvedInteractions).toHaveLength(0);
    expect(value.store.readSessionState(sessionId)).toMatchObject({
      attention: true,
      reason: "autorespond_protected_authority_required",
      state: "needs_approval",
    });
  });

  test("clears autorespond attention only after the last pending approval resolves", async () => {
    const value = await fixture();
    const { sessionId } = await createIdleSession(value, "Autorespond attention lifecycle");
    value.store.setSessionApprovalMode(sessionId, "auto:workspace");
    const first = await requestCommandApproval(value, sessionId, "attention-first");
    const second = await requestCommandApproval(value, sessionId, "attention-second");
    await waitFor(() => value.store.listAutorespondEvidence({ sessionId }).length === 2);
    expect(value.store.readSessionState(sessionId)).toMatchObject({
      attention: true,
      state: "needs_approval",
    });

    const settleDecline = async (interaction: InteractionRecord): Promise<void> => {
      await value.service.execute({
        kind: "interaction.resolve",
        interaction: interaction.publicId,
        expectedRevision: interaction.revision,
        resolution: { kind: "approval_decision", decision: "decline" },
      }, { signal });
      const profile = value.store.requireProfileById(interaction.authority.profileId);
      await value.service.observeCodexFact(liveAuthorityFor(value.store, profile.id), {
        type: "interactionResolved",
        connectionId: interaction.authority.connectionId,
        provider: interaction.authority,
        kind: "command_approval",
      });
    };

    await settleDecline(first);
    expect(value.store.requireInteraction(first.publicId).state).toBe("declined");
    expect(value.store.requireInteraction(second.publicId).state).toBe("pending");
    expect(value.store.readSessionState(sessionId)).toMatchObject({
      attention: true,
      state: "needs_approval",
    });

    await settleDecline(second);
    expect(value.store.readSessionState(sessionId)).toMatchObject({
      attention: false,
      state: "done",
    });
  });

  test("keeps a manual prompt human-owned after a later mode change", async () => {
    const value = await fixture();
    const { sessionId } = await createIdleSession(value, "Autorespond disposition binding");
    value.store.setSessionApprovalMode(sessionId, "manual");
    const manual = await requestCommandApproval(value, sessionId, "manual-before-mode-change");
    await waitFor(() => value.store.listAutorespondEvidence({ sessionId }).length === 1);

    value.store.setSessionApprovalMode(sessionId, "auto:all");
    const automatic = await requestCommandApproval(value, sessionId, "automatic-after-mode-change");
    await waitFor(() => value.store.listAutorespondEvidence({ sessionId }).length === 2);
    expect(value.codex.resolvedInteractions).toHaveLength(1);
    expect(value.store.requireInteraction(manual.publicId).state).toBe("pending");
    expect(value.store.requireInteraction(automatic.publicId).state).not.toBe("pending");
    expect(value.store.readSessionState(sessionId)).toMatchObject({
      attention: true,
      state: "needs_approval",
    });
  });

  test("clears autorespond attention when the pending approval expires", async () => {
    let now = 10_000;
    const value = await fixture(new FakeCloud(), () => undefined, () => now);
    const { sessionId } = await createIdleSession(value, "Autorespond expiry lifecycle");
    value.store.setSessionApprovalMode(sessionId, "auto:workspace");
    const interaction = await requestCommandApproval(value, sessionId, "attention-expiry");
    await waitFor(() => value.store.listAutorespondEvidence({ sessionId }).length === 1);
    expect(value.store.readSessionState(sessionId)).toMatchObject({
      attention: true,
      state: "needs_approval",
    });

    now = interaction.deadlineAt;
    expect(await value.service.maintainInteractionDeadlines()).toEqual({ examined: 1, failed: 0 });
    expect(value.store.requireInteraction(interaction.publicId).state).toBe("expired");
    expect(value.store.readSessionState(sessionId)).toMatchObject({
      attention: false,
      state: "done",
    });
  });

  test("returns to working when the last actionable approval settles during an active turn", async () => {
    const value = await fixture();
    const { sessionId } = await createIdleSession(value, "Active-turn attention lifecycle");
    const session = value.store.requireSession(sessionId);
    const profile = value.store.requireProfileById(session.profileId);
    if (session.providerThreadId === undefined) throw new Error("Expected a bound session.");
    const authority = liveAuthorityFor(value.store, profile.id);
    await value.service.observeCodexFact(authority, {
      type: "turnStarted",
      threadId: session.providerThreadId,
      turn: {
        id: "turn-autorespond",
        items: [],
        status: "inProgress",
        startedAt: 1,
        completedAt: null,
        durationMs: null,
      },
    });

    value.store.setSessionApprovalMode(sessionId, "auto:workspace");
    const interaction = await requestCommandApproval(value, sessionId, "active-turn-attention");
    await waitFor(() => value.store.listAutorespondEvidence({ sessionId }).length === 1);
    expect(value.store.readSessionState(sessionId)).toMatchObject({
      attention: true,
      state: "needs_approval",
    });

    await value.service.execute({
      kind: "interaction.resolve",
      interaction: interaction.publicId,
      expectedRevision: interaction.revision,
      resolution: { kind: "approval_decision", decision: "decline" },
    }, { signal });
    await value.service.observeCodexFact(authority, {
      type: "interactionResolved",
      connectionId: interaction.authority.connectionId,
      provider: interaction.authority,
      kind: "command_approval",
    });

    expect(value.store.requireSession(sessionId)).toMatchObject({
      activeTurnId: "turn-autorespond",
      state: "active",
    });
    expect(value.store.readSessionState(sessionId)).toMatchObject({
      attention: false,
      state: "working",
    });
  });
});

describe("OompaService prose autorespond", () => {
  // Twenty-four printable characters, built rather than written, so no
  // credential-shaped literal enters the repository.
  const testGatewayKey = ["gw", "k".repeat(22)].join("");
  const filler = `${"Progress notes continue here without any cue that changes the classification. ".repeat(12)}\n\n`;

  const waitFor = async (predicate: () => boolean, timeoutMs = 2_000): Promise<void> => {
    const startedAt = Date.now();
    while (!predicate()) {
      if (Date.now() - startedAt > timeoutMs) throw new Error("Timed out waiting for prose autorespond.");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };

  const proseFixture = async (options: Readonly<{
    gatewayKeys?: GatewayKeyPort;
    now?: () => number;
    onStopRequested?: () => void;
    responder?: ProseResponder;
  }> = {}, createFixture: ServiceFixtureFactory = fixture) => {
    const responder = options.responder ?? new DeterministicProseResponder();
    const gatewayKeys = options.gatewayKeys ?? new InMemoryGatewayKeyStore(testGatewayKey);
    const value = await createFixture(new FakeCloud(),
      options.onStopRequested ?? (() => undefined),
      options.now ?? Date.now,
      undefined,
      {
        gatewayKeys,
        proseResponder: responder,
      },
    );
    return { ...value, gatewayKeys, responder };
  };

  const completeTurn = async (
    value: Awaited<ReturnType<typeof proseFixture>>,
    sessionId: `sess_${string}`,
    turnId: string,
    text: string,
  ): Promise<void> => {
    const session = value.store.requireSession(sessionId);
    const profile = value.store.requireProfileById(session.profileId);
    const threadId = session.providerThreadId;
    if (threadId === undefined) throw new Error("Expected a bound session.");
    const authority = liveAuthorityFor(value.store, profile.id);
    await value.service.observeCodexFact(authority, {
      type: "turnStarted",
      threadId,
      turn: { id: turnId, items: [], status: "inProgress", startedAt: 1, completedAt: null, durationMs: null },
    });
    await value.service.observeCodexFact(authority, {
      type: "itemStarted",
      threadId,
      turnId,
      itemId: `${turnId}-agent`,
      itemKind: "agentMessage",
    });
    await value.service.observeCodexFact(authority, {
      type: "assistantDelta",
      threadId,
      turnId,
      itemId: `${turnId}-agent`,
      text,
    });
    await value.service.observeCodexFact(authority, {
      type: "itemCompleted",
      threadId,
      turnId,
      itemId: `${turnId}-agent`,
      itemKind: "agentMessage",
      status: "completed",
    });
    await value.service.observeCodexFact(authority, {
      type: "turnCompleted",
      threadId,
      turn: { id: turnId, items: [], status: "completed", startedAt: 1, completedAt: 2, durationMs: 1 },
    });
  };

  const proseEvidence = (
    value: Awaited<ReturnType<typeof proseFixture>>,
    sessionId: `sess_${string}`,
  ) => value.store.listAutorespondEvidence({ sessionId, limit: 50 })
    .filter((row) => row.path === "prose");

  const lastUserMessage = (
    value: Awaited<ReturnType<typeof proseFixture>>,
  ): Readonly<{ clientId?: string; text: string }> | undefined =>
    [...(value.codex.readProjection.messages ?? [])]
      .reverse()
      .find((message) => message.role === "user");

  const lastSessionStateBody = (
    value: Awaited<ReturnType<typeof proseFixture>>,
    sessionId: `sess_${string}`,
  ) => {
    const bodies = value.store
      .listSessionEvents({ sessionId, afterSequence: null, limit: 200 })
      .events
      .map((event) => event.body)
      .filter((body) => body.type === "session_state");
    return bodies.at(-1);
  };

  test("sends the fixed approval reply, marks the source, and records sent evidence", async () => {
    const value = await proseFixture();
    const { sessionId } = await createIdleSession(value, "Prose accept");
    value.store.setSessionApprovalMode(sessionId, "auto:all");
    const sends = value.codex.calls.filter((call) => call === "send").length;

    await completeTurn(value, sessionId, "turn-prose-1", "The refactor is staged. Should I proceed?");

    await waitFor(() => proseEvidence(value, sessionId).length === 1);
    expect(proseEvidence(value, sessionId)[0]).toMatchObject({
      decision: "send",
      kind: "prose_approval",
      mode: "auto:all",
      outcome: "sent",
      path: "prose",
      rule: "approval_cue",
    });
    expect(proseEvidence(value, sessionId)[0]?.model).toBe("openai/gpt-5-nano");
    expect(value.codex.calls.filter((call) => call === "send").length).toBe(sends + 1);
    expect(lastUserMessage(value)?.text).toBe(PROSE_APPROVAL_REPLY);
    expect(value.responder).toBeInstanceOf(DeterministicProseResponder);
    // The autoresponse spends budget and never resets the consecutive counter.
    expect(value.store.readAutorespondBudgets(sessionId).consecutive).toBe(1);
    expect(value.store.readAutorespondBudgets(sessionId).lastHour).toBe(1);
  });

  test.each([
    { change: "manual mode", mode: "manual", outcome: "gate_failed:manual_mode" },
    { change: "gateway authorization", mode: "auto:all", outcome: "gate_failed:policy_changed" },
  ] as const)("rechecks $change after the prose responder returns before sending", async (policy) => {
    let responderStarted!: () => void;
    const responderAdmission = new Promise<void>((resolve) => { responderStarted = resolve; });
    let releaseResponder!: () => void;
    const responderGate = new Promise<void>((resolve) => { releaseResponder = resolve; });
    const delegate = new DeterministicProseResponder();
    const value = await proseFixture({
      responder: {
        respond: async (input, responderSignal) => {
          responderStarted();
          await responderGate;
          return delegate.respond(input, responderSignal);
        },
      },
    });
    const { sessionId } = await createIdleSession(value, "Prose policy race");
    value.store.setSessionApprovalMode(sessionId, "auto:all");
    const sends = value.codex.calls.filter((call) => call === "send").length;

    await completeTurn(value, sessionId, "prose-policy-race", "The refactor is staged. Should I proceed?");
    await responderAdmission;
    await value.service.execute(policy.change === "manual mode"
      ? { kind: "autorespond.set", session: sessionId, mode: "manual" }
      : { kind: "autorespond.gateway-clear" }, { signal });
    releaseResponder();
    await value.service.settled();

    expect(value.codex.calls.filter((call) => call === "send")).toHaveLength(sends);
    expect(proseEvidence(value, sessionId)).toHaveLength(1);
    expect(proseEvidence(value, sessionId)[0])
      .toMatchObject({ decision: "refuse", mode: policy.mode, outcome: policy.outcome });
    expect(value.store.readSessionState(sessionId)).toMatchObject({
      attention: true,
      state: "needs_approval",
      reason: policy.outcome.replace("gate_failed:", "prose_autorespond_"),
    });
    expect(value.store.readAutorespondBudgets(sessionId).consecutive).toBe(0);
  });

  test("rechecks manual mode after the final prose runtime review before sending", async () => {
    const value = await proseFixture();
    const { sessionId } = await createIdleSession(value, "Prose dispatch policy race");
    value.store.setSessionApprovalMode(sessionId, "auto:all");
    const sends = value.codex.calls.filter((call) => call === "send").length;
    let reviewStarted!: () => void;
    const reviewAdmission = new Promise<void>((resolve) => { reviewStarted = resolve; });
    let releaseReview!: () => void;
    const reviewGate = new Promise<void>((resolve) => { releaseReview = resolve; });
    value.codex.beforeReviewTurnStartReturn = async () => {
      reviewStarted();
      await reviewGate;
    };

    await completeTurn(value, sessionId, "prose-dispatch-policy-race", "Ready to apply. Should I proceed?");
    await reviewAdmission;
    await value.service.execute({ kind: "autorespond.set", session: sessionId, mode: "manual" }, { signal });
    releaseReview();
    await value.service.settled();

    expect(value.codex.calls.filter((call) => call === "send")).toHaveLength(sends);
    expect(proseEvidence(value, sessionId)).toHaveLength(1);
    expect(proseEvidence(value, sessionId)[0])
      .toMatchObject({ decision: "refuse", mode: "manual", outcome: "gate_failed:manual_mode" });
    expect(value.store.readAutorespondBudgets(sessionId).consecutive).toBe(0);
    await expect(value.service.execute({
      kind: "session.send",
      session: sessionId,
      message: "The human will review the patch now.",
    }, { signal })).resolves.toMatchObject({ turnId: "turn-next" });
    expect(value.codex.calls.filter((call) => call === "send")).toHaveLength(sends + 1);
  });

  test("refuses a prose response while gateway-key removal is still in progress", async () => {
    let responderStarted!: () => void;
    const responderAdmission = new Promise<void>((resolve) => { responderStarted = resolve; });
    let releaseResponder!: () => void;
    const responderGate = new Promise<void>((resolve) => { releaseResponder = resolve; });
    let clearStarted!: () => void;
    const clearAdmission = new Promise<void>((resolve) => { clearStarted = resolve; });
    let releaseClear!: () => void;
    const clearGate = new Promise<void>((resolve) => { releaseClear = resolve; });
    const keys = new InMemoryGatewayKeyStore(testGatewayKey);
    const delegate = new DeterministicProseResponder();
    const value = await proseFixture({
      gatewayKeys: {
        isConfigured: () => keys.isConfigured(),
        read: () => keys.read(),
        set: (key) => keys.set(key),
        clear: async () => {
          clearStarted();
          await clearGate;
          return keys.clear();
        },
      },
      responder: {
        respond: async (input, responderSignal) => {
          responderStarted();
          await responderGate;
          return delegate.respond(input, responderSignal);
        },
      },
    });
    const { sessionId } = await createIdleSession(value, "Prose gateway removal race");
    value.store.setSessionApprovalMode(sessionId, "auto:all");
    const sends = value.codex.calls.filter((call) => call === "send").length;

    await completeTurn(value, sessionId, "prose-gateway-removal-race", "Ready to apply. Should I proceed?");
    await responderAdmission;
    const clearing = value.service.execute({ kind: "autorespond.gateway-clear" }, { signal });
    await clearAdmission;
    releaseResponder();
    await value.service.settled();
    releaseClear();
    await clearing;

    expect(value.codex.calls.filter((call) => call === "send")).toHaveLength(sends);
    expect(proseEvidence(value, sessionId)).toHaveLength(1);
    expect(proseEvidence(value, sessionId)[0])
      .toMatchObject({ decision: "refuse", outcome: "gate_failed:policy_changed" });
    expect(value.store.readAutorespondBudgets(sessionId).consecutive).toBe(0);
    expect(await keys.isConfigured()).toBe(false);
  });

  test.each([
    {
      scenario: "fixed approval",
      sourceText: "The refactor is staged. Should I proceed?",
      nextText: "The requested summary is complete.",
      nextState: "done",
      invalidReply: false,
    },
    {
      scenario: "unmatched verbatim reply before a newer question",
      sourceText: 'The refactor is staged. Please reply with "APPROVE PATCH" to continue.',
      nextText: "Which database should we use?",
      nextState: "needs_answer",
      invalidReply: true,
    },
  ])("refuses a stale prose response after a newer completed turn changes its source ($scenario)", async (source) => {
    let responderStarted!: () => void;
    const responderAdmission = new Promise<void>((resolve) => { responderStarted = resolve; });
    let releaseResponder!: () => void;
    const responderGate = new Promise<void>((resolve) => { releaseResponder = resolve; });
    const delegate = new DeterministicProseResponder(source.invalidReply
      ? { reply: () => "not the requested literal" }
      : {});
    const value = await proseFixture({
      responder: {
        respond: async (input, responderSignal) => {
          responderStarted();
          await responderGate;
          return delegate.respond(input, responderSignal);
        },
      },
    });
    const { sessionId } = await createIdleSession(value, "Prose source race");
    value.store.setSessionApprovalMode(sessionId, "auto:all");
    const sends = value.codex.calls.filter((call) => call === "send").length;

    await completeTurn(value, sessionId, "prose-source-old", source.sourceText);
    await responderAdmission;
    let newerStateCommitted!: () => void;
    const newerStateCommit = new Promise<void>((resolve) => { newerStateCommitted = resolve; });
    const upsert = value.store.upsertSessionState.bind(value.store);
    Object.defineProperty(value.store, "upsertSessionState", {
      configurable: true,
      value: (input: Parameters<typeof upsert>[0]): ReturnType<typeof upsert> => {
        const result = upsert(input);
        if (input.sessionId === sessionId && input.state === source.nextState) newerStateCommitted();
        return result;
      },
    });
    await completeTurn(value, sessionId, "prose-source-new", source.nextText);
    await newerStateCommit;
    const latestState = value.store.readSessionState(sessionId);
    releaseResponder();
    await value.service.settled();

    expect(value.codex.calls.filter((call) => call === "send")).toHaveLength(sends);
    expect(proseEvidence(value, sessionId)).toHaveLength(1);
    expect(proseEvidence(value, sessionId)[0])
      .toMatchObject({ decision: "refuse", outcome: "gate_failed:source_changed" });
    expect(value.store.readSessionState(sessionId)).toEqual(latestState);
    expect(value.store.readAutorespondBudgets(sessionId).consecutive).toBe(0);
  });

  test("distinguishes a newer identical prose approval from the stale turn being answered", async () => {
    let responderStarted!: () => void;
    const responderAdmission = new Promise<void>((resolve) => { responderStarted = resolve; });
    let releaseResponder!: () => void;
    const responderGate = new Promise<void>((resolve) => { releaseResponder = resolve; });
    const delegate = new DeterministicProseResponder();
    let responderCalls = 0;
    const value = await proseFixture({
      responder: {
        respond: async (input, responderSignal) => {
          responderCalls += 1;
          if (responderCalls === 1) {
            responderStarted();
            await responderGate;
          }
          return delegate.respond(input, responderSignal);
        },
      },
    });
    const { sessionId } = await createIdleSession(value, "Identical prose source race");
    value.store.setSessionApprovalMode(sessionId, "auto:all");
    value.codex.turnStatus = "completed";
    const sends = value.codex.calls.filter((call) => call === "send").length;
    const question = "The refactor is staged. Should I proceed?";

    await completeTurn(value, sessionId, "identical-prose-old", question);
    await responderAdmission;
    await completeTurn(value, sessionId, "identical-prose-new", question);
    releaseResponder();
    await value.service.settled();

    expect(value.codex.calls.filter((call) => call === "send")).toHaveLength(sends + 1);
    expect(proseEvidence(value, sessionId)).toHaveLength(2);
    expect(proseEvidence(value, sessionId).find((row) => row.outcome === "gate_failed:source_changed"))
      .toMatchObject({ decision: "refuse" });
    expect(proseEvidence(value, sessionId).find((row) => row.outcome === "sent"))
      .toMatchObject({ decision: "send" });
    expect(value.store.readAutorespondBudgets(sessionId).consecutive).toBe(1);
  });

  test("refuses a prose response when a provider interaction became pending while the responder ran", async () => {
    let responderStarted!: () => void;
    const responderAdmission = new Promise<void>((resolve) => { responderStarted = resolve; });
    let releaseResponder!: () => void;
    const responderGate = new Promise<void>((resolve) => { releaseResponder = resolve; });
    const delegate = new DeterministicProseResponder();
    const value = await proseFixture({
      responder: {
        respond: async (input, responderSignal) => {
          responderStarted();
          await responderGate;
          return delegate.respond(input, responderSignal);
        },
      },
    });
    const { sessionId } = await createIdleSession(value, "Prose pending interaction race");
    value.store.setSessionApprovalMode(sessionId, "auto:all");
    const sends = value.codex.calls.filter((call) => call === "send").length;

    await completeTurn(value, sessionId, "prose-pending-race", "The refactor is staged. Should I proceed?");
    await responderAdmission;
    // File-change approvals remain manual even under auto:all, so no competing
    // automatic resolution can remove this request before the prose gate.
    const session = value.store.requireSession(sessionId);
    const profile = value.store.requireProfileById(session.profileId);
    if (session.providerThreadId === undefined) throw new Error("Expected a bound session.");
    const connectionId = value.codex.observationConnectionId;
    await value.service.observeCodexFact(liveAuthorityFor(value.store, profile.id, "codex"), {
      type: "interactionRequested",
      connectionId,
      provider: {
        ...codexInteractionBinding(value.store, profile.id),
        profileId: profile.id,
        processGeneration: profile.processGeneration,
        connectionId,
        requestId: { type: "string", value: "prose-new-pending" },
        method: "item/fileChange/requestApproval",
        requestDigest: createHash("sha256").update("prose-new-pending").digest("hex"),
        threadId: session.providerThreadId,
        turnId: "prose-pending-race",
        itemId: "prose-pending-race-file",
        approvalId: null,
      },
      kind: "file_change_approval",
      blocking: true,
      display: {
        kind: "file_change_approval",
        summary: "Apply reviewed file changes",
        reason: null,
        grantRoot: null,
        availableDecisions: ["once", "decline", "cancel"],
      },
    });
    releaseResponder();
    await value.service.settled();

    expect(value.codex.calls.filter((call) => call === "send")).toHaveLength(sends);
    expect(value.store.listInteractions({ sessionId, pendingOnly: true })).toEqual([
      expect.objectContaining({ kind: "file_change_approval", state: "pending" }),
    ]);
    expect(proseEvidence(value, sessionId)).toHaveLength(1);
    expect(proseEvidence(value, sessionId)[0])
      .toMatchObject({ decision: "refuse", outcome: "gate_failed:pending_interaction" });
    expect(value.store.readAutorespondBudgets(sessionId).consecutive).toBe(0);
  });

  test("commits an accepted autoresponse receipt and transcript without charging its reserved budget twice", async () => {
    const value = await proseFixture();
    const { sessionId } = await createIdleSession(value, "Prose transcript replay");
    value.store.setSessionApprovalMode(sessionId, "auto:all");
    const sends = value.codex.calls.filter((call) => call === "send").length;
    const complete = value.store.completeSessionTurnEffect.bind(value.store);
    let completedAtomically = false;
    Object.defineProperty(value.store, "completeSessionTurnEffect", {
      configurable: true,
      value: (write: Parameters<typeof complete>[0]): ReturnType<typeof complete> => {
        expect(value.store.readAutorespondBudgets(sessionId).consecutive).toBe(1);
        const result = complete(write);
        expect(value.store.readAutorespondBudgets(sessionId).consecutive).toBe(1);
        completedAtomically = true;
        return result;
      },
    });

    await completeTurn(
      value,
      sessionId,
      "turn-prose-transcript-replay",
      "The exact patch is staged. Should I proceed?",
    );

    await waitFor(() => proseEvidence(value, sessionId).length === 1);
    expect(completedAtomically).toBe(true);
    expect(proseEvidence(value, sessionId)[0]).toMatchObject({
      decision: "send",
      outcome: "sent",
    });
    expect(value.codex.calls.filter((call) => call === "send").length).toBe(sends + 1);
    const messages = value.store
      .listSessionEvents({ sessionId, afterSequence: null, limit: 200 })
      .events
      .map((event) => event.body)
      .filter((body) => body.type === "user_message" && body.actor === "autorespond");
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ text: PROSE_APPROVAL_REPLY });
    expect(value.store.readAutorespondBudgets(sessionId).consecutive).toBe(1);
  });

  test("fences the session when the atomic autoresponse receipt cannot commit", async () => {
    const value = await proseFixture();
    const { sessionId } = await createIdleSession(value, "Prose transcript quarantine");
    value.store.setSessionApprovalMode(sessionId, "auto:all");
    const sends = value.codex.calls.filter((call) => call === "send").length;
    Object.defineProperty(value.store, "completeSessionTurnEffect", {
      configurable: true,
      value: () => { throw new Error("persistent atomic receipt failure"); },
    });

    await completeTurn(
      value,
      sessionId,
      "turn-prose-transcript-quarantine",
      "The exact patch is staged. Should I proceed?",
    );

    await waitFor(() => proseEvidence(value, sessionId).length === 1);
    expect(proseEvidence(value, sessionId)[0]).toMatchObject({
      decision: "send",
      outcome: "sent",
    });
    expect(value.codex.calls.filter((call) => call === "send").length).toBe(sends + 1);
    expect(value.store.readAutorespondBudgets(sessionId)).toMatchObject({
      consecutive: 1,
      lastHour: 1,
    });
    const [attempt] = value.store.listUnsettledMutations({ sessionId })
      .filter((candidate) => candidate.kind === "session.send");
    expect(attempt).toMatchObject({ state: "ambiguous" });
    if (attempt === undefined) throw new Error("Expected the accepted autoresponse ambiguity.");
    expect(value.store.readSessionUserMessageSource(
      sessionId,
      "mutation",
      attempt.idempotencyKey,
    )).toMatchObject({
      status: "pending",
      intent: { actor: "autorespond" },
    });
    expect(value.store.requireSession(sessionId).state).toBe("recovery_required");
  });

  test("marks the dispatched autoresponse as an autorespond message source", async () => {
    const value = await proseFixture();
    const { sessionId } = await createIdleSession(value, "Prose source");
    value.store.setSessionApprovalMode(sessionId, "auto:all");

    await completeTurn(value, sessionId, "turn-prose-source", "Ready to apply. Should I proceed?");
    await waitFor(() => proseEvidence(value, sessionId).length === 1);

    const clientId = lastUserMessage(value)?.clientId;
    expect(clientId).toBeDefined();
    expect(value.store.isAutorespondMessageSource(sessionId, clientId as string)).toBe(true);
    expect(value.store.isAutorespondMessageSource(sessionId, "attempt_not_ours")).toBe(false);
  });

  test("sends a verbatim literal only when it is a byte-exact substring", async () => {
    const value = await proseFixture();
    const { sessionId } = await createIdleSession(value, "Prose verbatim");
    value.store.setSessionApprovalMode(sessionId, "auto:all");

    await completeTurn(
      value,
      sessionId,
      "turn-prose-verbatim",
      'The migration is staged. Please reply with "APPROVE MIGRATION" to continue.',
    );

    await waitFor(() => proseEvidence(value, sessionId).length === 1);
    expect(proseEvidence(value, sessionId)[0]).toMatchObject({ outcome: "sent" });
    expect(lastUserMessage(value)?.text).toBe("APPROVE MIGRATION");
  });

  test("escalates to needs_answer when the responder's verbatim reply does not match", async () => {
    const value = await proseFixture({
      responder: new DeterministicProseResponder({ reply: () => "TOTALLY DIFFERENT STRING" }),
    });
    const { sessionId } = await createIdleSession(value, "Prose mismatch");
    value.store.setSessionApprovalMode(sessionId, "auto:all");
    const sends = value.codex.calls.filter((call) => call === "send").length;

    await completeTurn(
      value,
      sessionId,
      "turn-prose-mismatch",
      'The migration is staged. Please reply with "APPROVE MIGRATION" to continue.',
    );

    await waitFor(() => proseEvidence(value, sessionId).length === 1);
    expect(proseEvidence(value, sessionId)[0]).toMatchObject({
      decision: "refuse",
      outcome: "verbatim_mismatch",
    });
    expect(value.codex.calls.filter((call) => call === "send").length).toBe(sends);
    const durable = value.store.readSessionState(sessionId);
    expect(durable).toMatchObject({
      attention: true,
      reason: "autorespond_verbatim_mismatch",
      state: "needs_answer",
    });
    const latest = lastSessionStateBody(value, sessionId);
    expect(latest).toMatchObject({
      attention: true,
      reason: "autorespond_verbatim_mismatch",
      state: "needs_answer",
    });
    expect(durable?.revision).toBe(latest?.revision);
  });

  test("records responder_failed and sends nothing when the responder call fails", async () => {
    const value = await proseFixture({
      responder: new DeterministicProseResponder({ failure: "gateway unavailable" }),
    });
    const { sessionId } = await createIdleSession(value, "Prose responder failure");
    value.store.setSessionApprovalMode(sessionId, "auto:all");
    const sends = value.codex.calls.filter((call) => call === "send").length;

    await completeTurn(value, sessionId, "turn-prose-failure", "Ready to apply. Should I proceed?");

    await waitFor(() => proseEvidence(value, sessionId).length === 1);
    expect(proseEvidence(value, sessionId)[0]).toMatchObject({
      model: null,
      outcome: "responder_failed",
    });
    expect(value.codex.calls.filter((call) => call === "send").length).toBe(sends);
  });

  test("refuses when no gateway key is configured", async () => {
    const value = await proseFixture({ gatewayKeys: new InMemoryGatewayKeyStore() });
    const { sessionId } = await createIdleSession(value, "Prose no key");
    value.store.setSessionApprovalMode(sessionId, "auto:all");

    await completeTurn(value, sessionId, "turn-prose-nokey", "Ready to apply. Should I proceed?");

    await waitFor(() => proseEvidence(value, sessionId).length === 1);
    expect(proseEvidence(value, sessionId)[0]).toMatchObject({
      outcome: "gate_failed:gateway_key_missing",
    });
    expect((value.responder as DeterministicProseResponder).calls).toHaveLength(0);
  });

  test("refuses under manual approval mode", async () => {
    const value = await proseFixture();
    const { sessionId } = await createIdleSession(value, "Prose manual");
    value.store.setSessionApprovalMode(sessionId, "manual");

    await completeTurn(value, sessionId, "turn-prose-manual", "Ready to apply. Should I proceed?");

    await waitFor(() => proseEvidence(value, sessionId).length === 1);
    expect(proseEvidence(value, sessionId)[0]).toMatchObject({
      mode: "manual",
      outcome: "gate_failed:manual_mode",
    });
  });

  test("refuses a human-action cue that sits outside the classified tail", async () => {
    const value = await proseFixture();
    const { sessionId } = await createIdleSession(value, "Prose human action");
    value.store.setSessionApprovalMode(sessionId, "auto:all");

    await completeTurn(
      value,
      sessionId,
      "turn-prose-human",
      `The publish step needs npm login first.\n\n${filler}Everything else is staged. Should I proceed?`,
    );

    await waitFor(() => proseEvidence(value, sessionId).length === 1);
    expect(proseEvidence(value, sessionId)[0]).toMatchObject({
      outcome: "gate_failed:human_action_cue",
    });
  });

  test("refuses a denylist cue that the classifier stripped with the code fence", async () => {
    const value = await proseFixture();
    const { sessionId } = await createIdleSession(value, "Prose denylist");
    value.store.setSessionApprovalMode(sessionId, "auto:all");

    await completeTurn(
      value,
      sessionId,
      "turn-prose-denylist",
      "The cleanup script is staged.\n\n```sh\ndrop the production database\n```\n\nShould I proceed?",
    );

    await waitFor(() => proseEvidence(value, sessionId).length === 1);
    expect(proseEvidence(value, sessionId)[0]).toMatchObject({
      outcome: "gate_failed:denylist_cue",
    });
  });

  test("refuses a message at or beyond the four-thousand character bound", async () => {
    const value = await proseFixture();
    const { sessionId } = await createIdleSession(value, "Prose long");
    value.store.setSessionApprovalMode(sessionId, "auto:all");

    await completeTurn(
      value,
      sessionId,
      "turn-prose-long",
      `${"Bounded progress prose without any cue at all. ".repeat(120)}\n\nShould I proceed?`,
    );

    await waitFor(() => proseEvidence(value, sessionId).length === 1);
    expect(proseEvidence(value, sessionId)[0]).toMatchObject({
      outcome: "gate_failed:message_too_long",
    });
  });

  for (const { afterHoursEnabled, label } of [
    { afterHoursEnabled: false, label: "disabled" },
    { afterHoursEnabled: true, label: "enabled" },
  ]) {
    describe(`keeps prose at three approvals with after-hours consent ${label} and resumes only after a human send`, () => {
      let owner: ReturnType<typeof createOwnedServiceCase> | undefined;
      let prepared: {
        value: Awaited<ReturnType<typeof proseFixture>>;
        sessionId: `sess_${string}`;
      } | undefined;
      // Only fresh fixture and idle-session creation moves to setup. This adds
      // a separate 5 s allowance, not an unchanged end-to-end test deadline.
      beforeEach(() => {
        owner = createOwnedServiceCase();
        prepared = undefined;
        return owner.run(async ({ createFixture, signal }) => {
          const now = Date.parse("2026-09-04T09:59:59.999Z");
          const value = await proseFixture({ now: () => now }, createFixture);
          signal.throwIfAborted();
          const { sessionId } = await createIdleSession(value, "Prose budget");
          signal.throwIfAborted();
          prepared = { value, sessionId };
        });
      }, 5_000);

      test("retains the coupled three-approval cap, refusal, and human-reset proof", () => {
        if (owner === undefined) throw new Error("Expected the prose budget case owner.");
        return owner.run(async ({ signal }) => {
          if (prepared === undefined) throw new Error("Expected a fresh prepared prose budget session.");
          const { value, sessionId } = prepared;
          await value.service.execute({
            kind: "notification-hours.set", expectedRevision: 1, version: 1,
            startMinute: 600, endMinute: 1_320, timeZone: "UTC",
          }, { signal });
          if (afterHoursEnabled) {
            await value.service.execute({ kind: "autorespond-after-hours.enable", expectedRevision: 1 }, { signal });
            expect(value.store.readAutorespondAfterHoursSelection(sessionId, "protocol", "eligible").tier).toBe("after_hours");
          }
          value.store.setSessionApprovalMode(sessionId, "auto:all");

          // Each autoresponse must leave the fake provider idle so the next turn can
          // start; the daemon refuses to send into an active turn.
          value.codex.turnStatus = "completed";
          const sent = () => proseEvidence(value, sessionId).filter((row) => row.outcome === "sent").length;
          let expected = 0;
          for (const turn of ["budget-1", "budget-2", "budget-3"]) {
            expected += 1;
            await completeTurn(value, sessionId, turn, "Ready to apply. Should I proceed?");
            await waitFor(() => sent() === expected);
          }
          expect(value.store.readAutorespondBudgets(sessionId).consecutive).toBe(3);

          await completeTurn(value, sessionId, "budget-4", "Ready to apply. Should I proceed?");
          await waitFor(() => proseEvidence(value, sessionId).length === 4);
          expect(proseEvidence(value, sessionId)[0]).toMatchObject({
            outcome: "gate_failed:consecutive_limit",
          });
          expect(value.store.readSessionState(sessionId)).toMatchObject({
            attention: true,
            state: "needs_approval",
            reason: "prose_autorespond_consecutive_limit",
          });
          expect(sent()).toBe(3);
          expect(value.store.readAutorespondBudgets(sessionId)).toEqual({ consecutive: 3, lastHour: 3, lastDay: 3 });

          // Only a human-authored send clears the consecutive counter.
          await value.service.execute(
            { kind: "session.send", session: sessionId, message: "carry on" },
            { signal },
          );
          expect(value.store.readAutorespondBudgets(sessionId).consecutive).toBe(0);
          expect(value.store.readAutorespondBudgets(sessionId)).toEqual({ consecutive: 0, lastHour: 3, lastDay: 3 });
        });
      }, 5_000);
    });
  }

  test("does not reset the consecutive budget for a rejected human send", async () => {
    const value = await proseFixture();
    const { sessionId } = await createIdleSession(value, "Rejected human send budget");
    value.store.bumpAutorespondCounter(sessionId);
    value.store.bumpAutorespondCounter(sessionId);
    value.store.bumpAutorespondCounter(sessionId);
    value.codex.startTurnErrorOnce = new Error("determinate provider refusal");

    await expect(value.service.execute(
      { kind: "session.send", session: sessionId, message: "human attempt" },
      { signal },
    )).rejects.toThrow("determinate provider refusal");

    expect(value.store.readAutorespondBudgets(sessionId).consecutive).toBe(3);
  });

  test("resets the consecutive budget only when human steer and queue messages reach the provider", async () => {
    const value = await proseFixture();
    const { sessionId } = await createIdleSession(value, "Human message budget reset");
    await value.service.execute(
      { kind: "session.send", session: sessionId, message: "begin" },
      { signal },
    );
    for (let count = 0; count < 3; count += 1) {
      value.store.bumpAutorespondCounter(sessionId);
    }

    await value.service.execute(
      { kind: "session.steer", session: sessionId, message: "human steering" },
      { signal },
    );
    expect(value.store.readAutorespondBudgets(sessionId).consecutive).toBe(0);

    for (let count = 0; count < 3; count += 1) {
      value.store.bumpAutorespondCounter(sessionId);
    }
    await value.service.execute(
      { kind: "session.queue", session: sessionId, message: "human queued follow-up" },
      { signal },
    );
    expect(value.store.readAutorespondBudgets(sessionId).consecutive).toBe(3);

    const session = value.store.requireSession(sessionId);
    const profile = value.store.requireProfileById(session.profileId);
    value.codex.readProjection = {
      ...value.codex.readProjection,
      status: "idle",
      providerUpdatedAt: (value.codex.readProjection.providerUpdatedAt ?? 10) + 1,
    };
    delete (value.codex.readProjection as { activeTurnId?: string }).activeTurnId;
    await value.service.observeCodexFact(liveAuthorityFor(value.store, profile.id, "codex"), {
      type: "turnCompleted",
      threadId: session.providerThreadId as string,
      turn: {
        id: "human-message-budget-active",
        items: [],
        status: "completed",
        startedAt: 1,
        completedAt: 2,
        durationMs: 1,
      },
    });
    await value.service.settled();

    expect(value.store.readAutorespondBudgets(sessionId).consecutive).toBe(0);
  });

  test("does not reset the consecutive budget when a scheduled automation reaches the provider", async () => {
    let now = 1_900_000_000_000;
    const value = await proseFixture({ now: () => now });
    const { sessionId } = await createIdleSession(value, "Scheduled automation budget");
    const prompt = "scheduled automation follow-up";
    for (let count = 0; count < 3; count += 1) {
      value.store.bumpAutorespondCounter(sessionId);
    }
    value.codex.turnStatus = "completed";
    value.store.createSessionTaskStore().create({
      sessionId,
      name: "Scheduled automation budget",
      prompt,
      minutes: 15,
      status: "active",
      idempotencyKey: crypto.randomUUID(),
    });

    now += 15 * 60_000;
    await expect(value.service.maintainSessionTasks()).resolves.toEqual({ materialized: 1 });
    await value.service.settled();

    const [queued] = value.store.listQueue(sessionId);
    expect(queued).toMatchObject({ state: "applied" });
    if (queued === undefined) throw new Error("Expected one scheduled queue entry.");
    expect(value.store.queueMessageActor(queued.id)).toBe("automation");
    expect(lastUserMessage(value)).toMatchObject({ clientId: queued.id, text: prompt });
    expect(value.store.readSessionUserMessageSource(sessionId, "queue", queued.id))
      .toMatchObject({ status: "finalized", intent: { actor: "automation" } });
    const queuedTranscriptEvents = value.store.listSessionEvents({
      sessionId,
      afterSequence: null,
      limit: 200,
    }).events.map((event) => event.body).filter((body) =>
      body.type === "user_message" && body.sourceId === queued.id);
    expect(queuedTranscriptEvents).toHaveLength(1);
    expect(queuedTranscriptEvents[0]).toMatchObject({
      actor: "automation",
      text: prompt,
    });
    expect(value.store.readAutorespondBudgets(sessionId).consecutive).toBe(3);
  });

  test("answers at most one prose approval per turn", async () => {
    const value = await proseFixture();
    const { sessionId } = await createIdleSession(value, "Prose once");
    value.store.setSessionApprovalMode(sessionId, "auto:all");

    await completeTurn(value, sessionId, "turn-prose-once", "Ready to apply. Should I proceed?");
    await waitFor(() => proseEvidence(value, sessionId).length === 1);
    const session = value.store.requireSession(sessionId);
    const profile = value.store.requireProfileById(session.profileId);
    await value.service.observeCodexFact(
      liveAuthorityFor(value.store, profile.id),
      {
        type: "turnCompleted",
        threadId: session.providerThreadId as string,
        turn: { id: "turn-prose-once", items: [], status: "completed", startedAt: 1, completedAt: 2, durationMs: 1 },
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(proseEvidence(value, sessionId)).toHaveLength(1);
  });

  test("reports gateway custody status without ever exposing the key", async () => {
    const value = await proseFixture({ gatewayKeys: new InMemoryGatewayKeyStore() });
    const before = await value.service.execute({ kind: "autorespond.status" }, { signal });
    expect(before).toMatchObject({ gateway: "not configured" });

    await value.service.execute(
      { kind: "autorespond.gateway-set", key: testGatewayKey },
      { signal },
    );
    const after = await value.service.execute({ kind: "autorespond.status" }, { signal });
    expect(after).toMatchObject({ gateway: "configured" });
    expect(JSON.stringify(after)).not.toContain(testGatewayKey);

    expect(await value.service.execute({ kind: "autorespond.gateway-clear" }, { signal }))
      .toMatchObject({ cleared: true, gateway: "not configured" });
    expect(await value.service.execute({ kind: "autorespond.status" }, { signal }))
      .toMatchObject({ gateway: "not configured" });
  });
});

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
