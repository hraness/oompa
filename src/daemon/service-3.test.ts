import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { canonical39RetiredRecoveryDatabaseBytes, canonical39RetiredRecoveryFixtures } from "../../scripts/fixtures/canonical39-retired-recovery";
import { canonicalSessionStartFixtures } from "../../scripts/fixtures/canonical-session-start";
import { CodexError, IndeterminateCodexEffectError, type CodexFact } from "../codex";
import { parseFact, parseThreadMetadataRead } from "../codex/protocol";
import { projectBoundedThread } from "./codex-runtime-adapter";
import type { LocalCommand } from "../domain/contracts";
import { PROTECTED_INTERACTION_DETAIL_MAXIMUM_BYTES, encodeProtectedInteractionDetailDocument, protectedInteractionDetailDocumentSchema, publicInteractionSchema, type InteractionResolution, type PublicInteraction } from "../domain/interactions";
import { sessionStatusSchema, type SessionStatus } from "../domain/observation";
import { currentPresetContract } from "../domain/presets";
import { SESSION_EVENT_RETAIN_AGE_MS, sessionEventPageSchema } from "../domain/session-events";
import { resolveUsableCanonicalProjectDirectory } from "../storage/project-directory";
import { mutationRequestDigest, sessionStartMutationRequest, StateSecurityScrubRequiredError, StateStore } from "../storage/state-store";
import { DaemonAuthoritySafetyError } from "./daemon-lock";
import { CodexSessionObservationError, type CodexRuntimePort, type CodexSessionProjection } from "./ports";
import { CommandFailure, OompaService } from "./service";
import {
  FakeCloud,
  FakeCodex,
  FakeDaemonAuthority,
  FakeFactsMemoryLifecycle,
  TrackingClaudeAuthority,
  adoptedClaudeFixture,
  adoptedCodexFixture,
  claudeProviderAccountKey,
  codexInteractionBinding,
  codexProviderAccountKey,
  createIdleSession,
  expectHistoricalValue,
  fixture,
  liveAuthorityFor,
  ownedFixtureTeardowns,
  ownedServiceCase,
  ownedServiceCaseTeardowns,
  ownedServiceFixtureWithClose,
  personalAdoptionNow,
  privatePathRoot,
  providerMutationCalls,
  renderHuman,
  renderJson,
  runtimeProfile,
  seedResolvableInteraction,
  seedUnsettledInteractionStates,
  serviceFixtureDatabaseSnapshot,
  serviceRoots,
  shortScrubCheckpoint,
  signal,
  stores,
  terminalInputCustodyFixture,
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
test("keeps independent Claude authority unchanged on Codex login and disconnect", async () => {
    const claude = new TrackingClaudeAuthority();
    const { codex, documents, service, store } = await fixture(new FakeCloud(),
      () => undefined,
      Date.now,
      undefined,
      {},
      undefined,
      claude,
    );
    const added = await service.execute({
      kind: "account.add",
      label: "Cross-provider authority",
    }, { signal }) as { account: { id: `acct_${string}` } };

    await service.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: false,
    }, { signal });
    const claudeAuthority = store.requireProviderAccountAuthority(added.account.id, "claude");
    expect(claude.rebindings).toEqual([]);
    await service.execute({
      kind: "project.add",
      label: "Rebind authority docs",
      path: documents,
    }, { signal });
    await service.execute({
      kind: "session.start",
      account: added.account.id,
      preset: "high",
      presetContract: currentPresetContract,
      fast: false,
    }, { signal });

    const generationOne = store.requireProfileById(added.account.id);
    await service.observeCodexFact(liveAuthorityFor(store, generationOne.id), {
      type: "providerDisconnected",
      connectionId: codex.observationConnectionId,
      reason: "process_exit",
    });
    expect(store.requireProfileById(added.account.id).processGeneration).toBe(2);
    expect(claude.rebindings).toEqual([]);
    expect(store.requireProviderAccountAuthority(added.account.id, "claude")).toEqual(claudeAuthority);
  });
test("does not call an unrelated Claude rebind during Codex generation advance", async () => {
    let stopCalls = 0;
    const claude = new TrackingClaudeAuthority();
    const { codex, daemonAuthority, documents, service, store } = await fixture(new FakeCloud(),
      () => { stopCalls += 1; },
      Date.now,
      undefined,
      {},
      undefined,
      claude,
    );
    const added = await service.execute({
      kind: "account.add",
      label: "Failed Claude authority rebind",
    }, { signal }) as { account: { id: `acct_${string}` } };
    await service.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: false,
    }, { signal });
    await service.execute({
      kind: "project.add",
      label: "Failed rebind authority docs",
      path: documents,
    }, { signal });
    await service.execute({
      kind: "session.start",
      account: added.account.id,
      preset: "high",
      presetContract: currentPresetContract,
      fast: false,
    }, { signal });
    const before = store.requireProfileById(added.account.id);
    const claudeAuthority = store.requireProviderAccountAuthority(added.account.id, "claude");
    claude.rebindError = new Error("injected Claude authority rebind failure");

    await expect(service.observeCodexFact(liveAuthorityFor(store, before.id), {
      type: "providerDisconnected",
      connectionId: codex.observationConnectionId,
      reason: "process_exit",
    })).resolves.toBeUndefined();

    expect(store.requireProfileById(added.account.id).processGeneration)
      .toBe(before.processGeneration + 1);
    expect(claude.rebindings).toEqual([]);
    expect(store.requireProviderAccountAuthority(added.account.id, "claude")).toEqual(claudeAuthority);
    expect(daemonAuthority.closeCalls).toBe(0);
    await Bun.sleep(5);
    expect(stopCalls).toBe(0);
    await expect(service.execute({ kind: "account.list" }, { signal }))
      .resolves.toBeDefined();
  });
test("leaves a restarted Claude schedule due until this daemon has its live binding", async () => {
    const clock = { value: 1_000 };
    const claude = new TrackingClaudeAuthority();
    const { service, store, documents } = await fixture(new FakeCloud(),
      () => undefined,
      () => clock.value,
      undefined,
      {},
      undefined,
      claude,
    );
    const added = await service.execute({
      kind: "account.add",
      label: "Restarted Claude schedule",
    }, { signal }) as { account: { id: `acct_${string}` } };
    const project = await store.createProject("Restarted Claude schedule docs", documents);
    const starting = store.createSession({
      fastEnabled: false,
      preset: "fable-max",
      profileId: added.account.id,
      projectId: project.id,
      provider: "claude",
      title: "Durable Claude schedule",
    });
    const providerThreadId = "claude-restart-thread";
    const session = store.bindSession({
      expectedRevision: starting.revision,
      providerThreadId,
      sessionId: starting.id,
      state: "idle",
    });
    store.bindSessionProviderAccountAuthority({
      sessionId: session.id,
      provider: "claude",
      runtimeScope: "managed",
      accountKey: claudeProviderAccountKey(),
    });
    const tasks = store.createSessionTaskStore();
    const task = tasks.create({
      idempotencyKey: "00000000-0000-4000-8000-000000000901",
      minutes: 15,
      name: "Resume only with live authority",
      prompt: "Continue the durable Claude task.",
      sessionId: session.id,
      status: "active",
    });
    if (task.nextDueAt === null) throw new Error("Expected an active task deadline.");
    clock.value = task.nextDueAt;

    expect(claude.hasLiveSession({
      authority: { ...liveAuthorityFor(store, added.account.id, "claude"), generation: 0 },
      providerThreadId,
    })).toBe(false);
    await expect(service.maintainSessionTasks()).resolves.toEqual({ materialized: 0 });
    expect(tasks.listOccurrences(session.id, task.id)).toEqual([]);
    expect(tasks.require(session.id, task.id).nextDueAt).toBe(task.nextDueAt);
    expect(store.listQueue(session.id)).toEqual([]);
  });
test("materializes an adopted personal-Claude schedule from its owning runtime", async () => {
    const clock = { value: personalAdoptionNow };
    const value = await adoptedClaudeFixture(
      "Personal Claude schedule",
      "personal-claude-schedule-thread",
      undefined,
      "Personal Claude scheduled task",
      "linux",
      true,
      () => clock.value,
    );
    expect(value.managedClaude.hasLiveSession({
      authority: liveAuthorityFor(value.store, value.accountId, "claude"),
      providerThreadId: value.session.providerThreadId ?? "missing",
    })).toBe(false);
    expect(value.personalClaude.hasLiveSession({
      authority: liveAuthorityFor(value.store, value.accountId, "claude"),
      providerThreadId: value.session.providerThreadId ?? "missing",
    })).toBe(true);

    if (value.session.providerThreadId === undefined) {
      throw new Error("Expected an adopted personal Claude provider thread.");
    }
    // Model a task retained from the earlier adoption implementation. New
    // personal adoptions no longer mint provider callback authority, but an
    // already-durable owner task must still use the exact owning runtime.
    const legacy = new Database(value.paths.database, { strict: true });
    try {
      legacy.query(
        "INSERT INTO session_conversation_automation(session_id,provider_thread_id,enabled_at) VALUES (?,?,?)",
      ).run(value.session.id, value.session.providerThreadId, clock.value);
    } finally {
      legacy.close();
    }
    const tasks = value.store.createSessionTaskStore();
    const task = tasks.create({
      idempotencyKey: "00000000-0000-4000-8000-000000000903",
      minutes: 15,
      name: "Personal runtime liveness",
      prompt: "Continue through the exact personal Claude controller.",
      sessionId: value.session.id,
      status: "active",
    });
    if (task.nextDueAt === null) throw new Error("Expected an active task deadline.");
    clock.value = task.nextDueAt;

    await expect(value.service.maintainSessionTasks()).resolves.toEqual({ materialized: 1 });
    expect(tasks.listOccurrences(value.session.id, task.id)).toHaveLength(1);
  });
test("atomically retires an old connection while a fresh login advances the profile", async () => {
    const value = await fixture();
    const { sessionId } = await createIdleSession(value, "Disconnect retirement");
    const seeded = await seedResolvableInteraction(
      value,
      sessionId,
      "disconnect-retirement",
    );
    const session = value.store.requireSession(sessionId);
    if (session.providerThreadId === undefined) throw new Error("Expected a bound session.");
    await value.service.observeCodexFact(seeded.authority, {
      type: "itemStarted",
      connectionId: seeded.interaction.authority.connectionId,
      threadId: session.providerThreadId,
      turnId: "turn-retirement-redaction",
      itemId: "assistant-retirement-redaction",
      itemKind: "agentMessage",
    });
    await value.service.observeCodexFact(seeded.authority, {
      type: "assistantDelta",
      connectionId: seeded.interaction.authority.connectionId,
      threadId: session.providerThreadId,
      turnId: "turn-retirement-redaction",
      itemId: "assistant-retirement-redaction",
      text: "unfinished api_",
    });
    value.codex.observeErrorOnce = new CodexSessionObservationError("resume_unavailable");
    await expect(value.service.execute({
      kind: "session.status",
      session: sessionId,
    }, { signal })).resolves.toMatchObject({
      providerObservation: {
        basis: "provider_read",
        code: "resume_unavailable",
        coverage: "unavailable",
        freshness: "fresh",
        source: "codex_app_server",
        state: "unavailable",
      },
    });
    expect(JSON.stringify(value.store.listSessionEvents({
      sessionId,
      afterSequence: 0,
      limit: 100,
    }))).not.toContain("unfinished api_");
    await value.service.execute({
      kind: "account.logout",
      account: seeded.authority.id,
    }, { signal });
    expect(value.store.requireInteraction(seeded.interaction.publicId).state).toBe("expired");
    const retiredBeforeLogin = value.store.listSessionEvents({
      sessionId,
      afterSequence: 0,
      limit: 100,
    }).events;
    expect(retiredBeforeLogin.flatMap((event) =>
      event.body.type === "assistant_delta" ? [event.body.text] : []))
      .toEqual(["[protected]"]);
    expect(retiredBeforeLogin.filter((event) =>
      event.body.type === "connection" && event.body.state === "disconnected"))
      .toHaveLength(1);
    expect(retiredBeforeLogin.filter((event) =>
      event.body.type === "gap" && event.body.reason === "provider_disconnect"))
      .toHaveLength(1);
    let releaseFreshLogin!: () => void;
    let freshLoginPreflightStarted!: () => void;
    const freshLoginGate = new Promise<void>((resolve) => {
      releaseFreshLogin = resolve;
    });
    const preflightStarted = new Promise<void>((resolve) => {
      freshLoginPreflightStarted = resolve;
    });
    value.cloud.beforeProjectionUnsettledProfileReturn = async (profileId) => {
      if (profileId !== seeded.authority.id) return;
      freshLoginPreflightStarted();
      await freshLoginGate;
    };
    value.codex.loginResult = {
      status: "signed_in",
      account: { signedIn: true, email: "fresh@example.com", plan: "Plus" },
    };
    value.codex.beforeLoginReturn = async ({ authority }) => {
      if (authority.generation !== 2) return;
      await value.service.observeCodexFact(seeded.authority, {
        type: "providerDisconnected",
        connectionId: seeded.interaction.authority.connectionId,
        reason: "closed",
      });
    };

    const freshLogin = value.service.execute({
      kind: "account.login",
      account: seeded.authority.id,
      deviceCode: false,
    }, { signal });
    await preflightStarted;
    expect(value.store.requireInteraction(seeded.interaction.publicId).state).toBe("expired");
    expect(value.store.listSessionEvents({
      sessionId,
      afterSequence: 0,
      limit: 100,
    }).events).toEqual(retiredBeforeLogin);
    releaseFreshLogin();
    const retiredFreshLoginResult = await freshLogin;
    expect(retiredFreshLoginResult).toMatchObject({
      account: { processGeneration: 2, state: "signed_in" },
      login: { status: "signed_in" },
    });
    await value.service.settled();

    expect(value.store.requireProfileById(seeded.authority.id)).toMatchObject({
      processGeneration: 2,
      state: "signed_in",
    });
    expect(value.store.requireInteraction(seeded.interaction.publicId).state).toBe("expired");
    const events = value.store.listSessionEvents({
      sessionId,
      afterSequence: 0,
      limit: 100,
    }).events;
    expect(JSON.stringify(events)).not.toContain("unfinished api_");
    expect(events.flatMap((event) =>
      event.body.type === "assistant_delta" ? [event.body.text] : []))
      .toEqual(["[protected]"]);
    const retirementEvents = events.filter((event) =>
      event.body.type === "assistant_delta"
      || event.body.type === "warning"
      || (event.body.type === "interaction_state" && event.body.interactionId === seeded.interaction.publicId)
      || (event.body.type === "connection" && event.body.state === "disconnected")
      || (event.body.type === "gap" && event.body.reason === "provider_disconnect"));
    expect(retirementEvents.map((event) => event.providerGeneration))
      .toEqual(retirementEvents.map(() => seeded.authority.generation));
    expect(retirementEvents.map((event) => event.sequence))
      .toEqual([...retirementEvents.map((event) => event.sequence)].sort((left, right) => left - right));
    const bodies = events.map((event) => event.body);
    expect(bodies.filter((event) => event.type === "connection" && event.state === "disconnected")).toEqual([{
      type: "connection",
      state: "disconnected",
      reason: "closed",
    }]);
    expect(bodies.filter((event) => event.type === "gap" && event.reason === "provider_disconnect"))
      .toHaveLength(1);
    expect(events.filter((event) => event.body.type === "warning")).toMatchObject([{
      providerConnectionId: null,
      body: {
        code: "provider_resume_unavailable",
        type: "warning",
      },
    }]);
  });
test("retires a mapped session that a provider list already made terminal", async () => {
    const value = await fixture();
    const { sessionId } = await createIdleSession(value, "Terminal login retirement");
    const session = value.store.requireSession(sessionId);
    const profile = value.store.requireProfileById(session.profileId);
    if (session.providerThreadId === undefined) throw new Error("Expected a bound session.");
    await value.service.execute({
      kind: "session.status",
      session: sessionId,
    }, { signal });
    value.codex.listedProjections = [{
      ...value.codex.readProjection,
      providerThreadId: session.providerThreadId,
      status: "terminal",
      providerUpdatedAt: (session.providerUpdatedAt ?? 0) + 1,
    }];
    const localPage = await value.service.execute({
      kind: "session.list",
      archived: false,
      account: profile.id,
      limit: 100,
    }, { signal }) as { nextCursor: string | null };
    if (localPage.nextCursor === null) throw new Error("Expected a provider-discovery continuation.");
    await value.service.execute({
      kind: "session.list",
      archived: false,
      account: profile.id,
      limit: 100,
      cursor: localPage.nextCursor,
    }, { signal });
    expect(value.store.requireSession(sessionId).state).toBe("terminal");

    await value.service.execute({
      kind: "account.logout",
      account: profile.id,
    }, { signal });
    value.codex.loginResult = {
      status: "signed_in",
      account: { signedIn: true, email: "fresh@example.com", plan: "Plus" },
    };
    const terminalLoginResult = await value.service.execute({
      kind: "account.login",
      account: profile.id,
      deviceCode: false,
    }, { signal });
    expect(terminalLoginResult).toMatchObject({
      account: { processGeneration: profile.processGeneration + 1, state: "signed_in" },
      login: { status: "signed_in" },
    });

    const events = value.store.listSessionEvents({
      sessionId,
      afterSequence: 0,
      limit: 100,
    }).events;
    expect(events.filter((event) =>
      event.body.type === "connection" && event.body.state === "disconnected")).toHaveLength(1);
    expect(events.filter((event) =>
      event.body.type === "gap" && event.body.reason === "provider_disconnect")).toHaveLength(1);
    expect(events.filter((event) =>
      event.body.type === "connection" || event.body.type === "gap").map(
      (event) => event.providerGeneration,
    )).toEqual(events.filter((event) =>
      event.body.type === "connection" || event.body.type === "gap").map(
      () => profile.processGeneration,
    ));
  });
test("preserves a lost pending-login response across daemon rollover for exact cancellation without replay", async () => {
    const { service, codex, store, paths } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Restart login" }, { signal }) as { account: { id: `acct_${string}` } };
    const idempotencyKey = "00000000-0000-4000-8000-000000000119";
    codex.loginResult = {
      status: "pending",
      loginId: "provider-login-restart",
      verificationUrl: "https://example.test/login?private=handoff",
      userCode: "PRIVATE-CODE",
    };
    const first = await service.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: true,
      idempotencyKey,
    }, { signal }) as { login: { loginId: string; userCode: string } };
    expect(first.login).toMatchObject({ loginId: "provider-login-restart", userCode: "PRIVATE-CODE" });
    expect(store.readPendingLoginAuthority(added.account.id, 1)).toMatchObject({
      idempotencyKey,
      loginId: "provider-login-restart",
      processGeneration: 1,
    });
    const originalAttempt = store.readMutation(idempotencyKey);
    if (originalAttempt === null) throw new Error("Expected the pending login mutation.");
    const capturedProviderAuthorities = store.readMutationProviderAuthorities(originalAttempt.id);

    const daemonGeneration = store.nextDaemonGeneration(`boot_${"a".repeat(32)}`);
    expect(store.requireProfile(added.account.id)).toMatchObject({
      processGeneration: 2,
      state: "login_pending",
    });
    expect(store.readPendingLoginAuthority(added.account.id, 2)).toMatchObject({
      attemptId: originalAttempt.id,
      loginId: "provider-login-restart",
      processGeneration: 2,
    });
    const beforeStaleRead = serviceFixtureDatabaseSnapshot(paths.database);
    expect(() => store.readPendingLoginAuthority(added.account.id, 1)).toThrow("PROVIDER_LOGIN_BINDING_PROOF_INVALID");
    expect(serviceFixtureDatabaseSnapshot(paths.database)).toEqual(beforeStaleRead);

    const restartedCodex = new FakeCodex();
    restartedCodex.accountProjection = { signedIn: false };
    restartedCodex.cancelLoginResult = { status: "not_found" };
    const restarted = new OompaService({
      store,
      paths,
      codex: restartedCodex,
      cloud: new FakeCloud(),
      daemonAuthority: new FakeDaemonAuthority(),
      daemonGeneration,
      requestStop: () => undefined,
    });
    await restarted.recover();
    expect(await restarted.execute({
      kind: "account.show",
      account: added.account.id,
    }, { signal })).toMatchObject({
      account: { processGeneration: 2, state: "login_pending" },
      login: {
        status: "pending",
        loginId: "provider-login-restart",
        next: `oompa account login-cancel ${added.account.id}`,
      },
    });
    const replay = await restarted.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: true,
      idempotencyKey,
    }, { signal }) as { account: { processGeneration: number }; login: Record<string, unknown> };
    expect(replay.account.processGeneration).toBe(2);
    expect(replay.login).toEqual({
      status: "pending",
      loginId: "provider-login-restart",
      next: `oompa account login-cancel ${added.account.id}`,
    });
    expect(JSON.stringify(replay)).not.toContain("PRIVATE-CODE");
    expect(JSON.stringify(replay)).not.toContain("private=handoff");
    expect(restartedCodex.calls.filter((call) => call.startsWith("login:"))).toHaveLength(0);
    expect(() => store.settlePendingLogin({
      profileId: added.account.id,
      processGeneration: 2,
      loginId: "wrong-provider-login",
      providerStatus: "not_found",
      provider: { signedIn: false },
    })).toThrow("LOGIN_CANCEL_AUTHORITY_MISMATCH");
    expect(await restarted.execute({
      kind: "account.login-cancel",
      account: added.account.id,
    }, { signal })).toMatchObject({
      account: { state: "signed_out" },
      providerStatus: "not_found",
      status: "canceled",
    });
    expect(restartedCodex.calls).toContain(`login-cancel:${added.account.id}:2:provider-login-restart`);
    expect(await restarted.execute({
      kind: "account.login-cancel",
      account: added.account.id,
    }, { signal })).toMatchObject({ status: "already_settled" });
    expect(restartedCodex.calls.filter((call) => call.startsWith("login-cancel:"))).toHaveLength(1);
    const attempt = store.readMutation(idempotencyKey);
    if (attempt === null) throw new Error("Expected the retired login mutation.");
    expect(store.readMutationProviderAuthorities(attempt.id)).toEqual(capturedProviderAuthorities);

    restartedCodex.loginResult = {
      status: "signed_in",
      account: { signedIn: true, email: "fresh@example.com", plan: "Plus" },
    };
    const fresh = await restarted.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: false,
    }, { signal }) as { account: { processGeneration: number; state: string } };
    expect(fresh.account).toMatchObject({ processGeneration: 3, state: "signed_in" });
  });
test("rejects login cancellation after an unbound profile generation change", async () => {
    const { service, codex, store, paths } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Stale login" }, { signal }) as { account: { id: `acct_${string}` } };
    codex.loginResult = { status: "pending", loginId: "provider-login-stale" };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    store.nextProfileGeneration(added.account.id);
    const before = serviceFixtureDatabaseSnapshot(paths.database);
    const calls = [...codex.calls];
    await expect(service.execute({
      kind: "account.login-cancel",
      account: added.account.id,
    }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED",
      message: "The pending login authority cannot be proved. Inspect the account before changing provider state." });
    expect(serviceFixtureDatabaseSnapshot(paths.database)).toEqual(before);
    expect(codex.calls).toEqual(calls);
    expect(codex.calls.filter((call) => call.startsWith("login-cancel:"))).toHaveLength(0);
  });
test("preserves exact pending-login cancellation authority across an unexpected provider disconnect", async () => {
    const { service, codex, store, paths } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Disconnected login" }, { signal }) as { account: { id: `acct_${string}` } };
    codex.loginResult = { status: "pending", loginId: "provider-login-disconnected" };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    await service.observeCodexFact(liveAuthorityFor(store, added.account.id), {
      type: "providerDisconnected",
      connectionId: "018f1f55-3f10-7c1a-8f7b-c6dc608bcd3b",
      reason: "process_exit",
    });
    // Login authority retirement is ordered behind the durable account tail;
    // the callback itself must return before that tail can close its client.
    await service.settled();
    expect(store.requireProfile(added.account.id)).toMatchObject({
      processGeneration: 2,
      state: "login_pending",
    });
    const beforeStaleRead = serviceFixtureDatabaseSnapshot(paths.database);
    expect(() => store.readPendingLoginAuthority(added.account.id, 1)).toThrow("PROVIDER_LOGIN_BINDING_PROOF_INVALID");
    expect(serviceFixtureDatabaseSnapshot(paths.database)).toEqual(beforeStaleRead);
    expect(store.readPendingLoginAuthority(added.account.id, 2)).toMatchObject({
      loginId: "provider-login-disconnected",
      processGeneration: 2,
    });
    codex.accountProjection = { signedIn: false };
    codex.cancelLoginResult = { status: "not_found" };
    await expect(service.execute({
      kind: "account.login-cancel",
      account: added.account.id,
    }, { signal })).resolves.toMatchObject({
      account: { state: "signed_out" },
      status: "canceled",
    });
    expect(codex.calls).toContain(`login-cancel:${added.account.id}:2:provider-login-disconnected`);
    await expect(service.execute({
      kind: "account.show",
      account: added.account.id,
    }, { signal })).resolves.toMatchObject({
      account: { processGeneration: 2, state: "signed_out" },
    });
    expect(codex.calls.filter((call) => call.startsWith("login-cancel:"))).toHaveLength(1);
  });
test("rejects an idempotency key reused across account authorities without mutating the second account", async () => {
    const { service, store } = await fixture();
    const first = await service.execute({ kind: "account.add", label: "First" }, { signal }) as { account: { id: string } };
    const second = await service.execute({ kind: "account.add", label: "Second" }, { signal }) as { account: { id: string } };
    const idempotencyKey = "00000000-0000-4000-8000-000000000102";
    await service.execute({ kind: "account.login", account: first.account.id, deviceCode: false, idempotencyKey }, { signal });
    await expect(service.execute({ kind: "account.login", account: second.account.id, deviceCode: false, idempotencyKey }, { signal })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(store.requireProfile(second.account.id)).toMatchObject({ processGeneration: 0, state: "signed_out" });
  });
test("queues exactly once when an applied response is retried", async () => {
    const { service, documents, store } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Queue replay" }, { signal }) as { account: { id: string } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    await service.execute({ kind: "project.add", label: "Docs", path: documents }, { signal });
    const started = await service.execute({ kind: "session.start", account: added.account.id, preset: "high", presetContract: 2, fast: false }, { signal }) as { session: { id: `sess_${string}` } };
    const command = { kind: "session.queue" as const, session: started.session.id, message: "only once", idempotencyKey: "00000000-0000-4000-8000-000000000103" };
    const first = await service.execute(command, { signal }) as { queued: { id: string } };
    const replay = await service.execute(command, { signal }) as { queued: { id: string } };
    expect(replay.queued.id).toBe(first.queued.id);
    expect(store.listQueue(started.session.id)).toHaveLength(1);
  });
test("replays applied send and stop receipts after their local session state has advanced", async () => {
    const { service, codex, documents, store } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Effect replay" }, { signal }) as { account: { id: string } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    await service.execute({ kind: "project.add", label: "Docs", path: documents }, { signal });
    const started = await service.execute({ kind: "session.start", account: added.account.id, preset: "high", presetContract: 2, fast: false }, { signal }) as { session: { id: string } };
    const send = { kind: "session.send" as const, session: started.session.id, message: "once", idempotencyKey: "00000000-0000-4000-8000-000000000105" };
    const firstSend = await service.execute(send, { signal });
    expect(await service.execute(send, { signal })).toEqual(firstSend);
    expect(codex.calls.filter((call) => call === "send")).toHaveLength(1);
    expect(store.listSessionEvents({
      afterSequence: 0,
      sessionId: started.session.id as `sess_${string}`,
    }).events.filter((event) =>
      event.body.type === "user_message" && event.body.text === send.message))
      .toHaveLength(1);
    const stop = { kind: "session.stop" as const, session: started.session.id, idempotencyKey: "00000000-0000-4000-8000-000000000106" };
    const firstStop = await service.execute(stop, { signal });
    expect(await service.execute(stop, { signal })).toEqual(firstStop);
    expect(codex.calls.filter((call) => call === "stop")).toHaveLength(1);
  });
test("fences incomplete pending transcript replay without manufacturing source runtime authority", async () => {
    const value = await fixture();
    const { service, codex, cloud, documents, store, paths } = value;
    const added = await service.execute(
      { kind: "account.add", label: "Transcript-first replay" },
      { signal },
    ) as { account: { id: `acct_${string}` } };
    await service.execute(
      { kind: "account.login", account: added.account.id, deviceCode: false },
      { signal },
    );
    await service.execute(
      { kind: "project.add", label: "Docs", path: documents },
      { signal },
    );
    const started = await service.execute({
      kind: "session.start",
      account: added.account.id,
      preset: "high",
      presetContract: 2,
      fast: false,
    }, { signal }) as { session: { id: `sess_${string}` } };
    const session = store.requireSession(started.session.id);
    const profile = store.requireProfileById(session.profileId);
    const runtime = store.latestSessionRuntimeProfile(session.id)?.profile;
    if (runtime === undefined) throw new Error("Expected the session-start runtime profile.");
    const key = "00000000-0000-4000-8000-00000000010a";
    const message = "finish only the durable transcript";
    const { attempt } = store.prepareSessionInputMutation({
      kind: "session.send",
      sessionId: session.id,
      providerAuthority: store.requireProviderAccountAuthority(profile.id, "codex"),
      message, attachments: [], daemonGeneration: value.daemonGeneration, bootId: value.daemonBootId,
      idempotencyKey: key,
    });
    store.beginSessionMutationEffect({
      providerAuthority: store.requireProviderAccountAuthority(profile.id, "codex"),
      attachments: [], daemonGeneration: value.daemonGeneration, bootId: value.daemonBootId,
      attemptId: attempt.id,
      message,
      sessionId: session.id,
      profileGeneration: profile.processGeneration,
      transcript: {
        accountId: profile.id,
        providerGeneration: profile.processGeneration,
        providerConnectionId: "30000000-0000-4000-8000-00000000000c",
        actor: "human",
        message,
      },
      evidence: {
        kind: "session.send",
        providerThreadId: session.providerThreadId ?? "",
        baseline: {
          providerUpdatedAt: session.providerUpdatedAt ?? null,
          status: "idle",
          activeTurnId: null,
        },
        clientMessageId: attempt.id,
        messageDigest: createHash("sha256").update(message).digest("hex"),
        runtimeProfile: runtime,
      },
    });
    expect(store.transitionMutation(attempt.id, "effect_started", "applied", {
      turnId: "turn-transcript-first-replay",
      status: "inProgress",
      sourceId: attempt.id,
      effectiveRuntimeProfile: runtime,
    })).toBe(true);
    // This intentionally incomplete current source has a receipt but no
    // source turn/runtime binding. It proves refusal, not an accepted recovery.
    const before = serviceFixtureDatabaseSnapshot(paths.database);
    cloud.beforeProjectionUnsettledSessionReturn = () => {
      throw new Error("A digest conflict must not observe current cloud recovery state.");
    };
    cloud.beforeProjectionUnsettledProfileReturn = () => {
      throw new Error("A digest conflict must not observe current account recovery state.");
    };
    const providerCalls = [...codex.calls];

    await expect(service.execute({
      kind: "session.send",
      session: session.id,
      message: `${message} changed`,
      idempotencyKey: key,
    }, { signal })).rejects.toThrow("IDEMPOTENCY_CONFLICT");
    expect(serviceFixtureDatabaseSnapshot(paths.database)).toEqual(before);
    delete cloud.beforeProjectionUnsettledSessionReturn;
    delete cloud.beforeProjectionUnsettledProfileReturn;
    cloud.unsettledProjectionSessions.add(session.id);
    cloud.unsettledProjectionProfiles.add(profile.id);
    await expect(service.execute({
      kind: "session.send",
      session: session.id,
      message,
      idempotencyKey: key,
    }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(serviceFixtureDatabaseSnapshot(paths.database)).toEqual(before);
    expect(store.readSessionUserMessageSource(session.id, "mutation", key))
      .toMatchObject({ status: "pending" });
    expect(store.listSessionEvents({ sessionId: session.id, afterSequence: 0 }).events
      .filter((event) => event.body.type === "user_message"
        && event.body.sourceId === key)).toHaveLength(0);
    cloud.unsettledProjectionSessions.clear();
    cloud.unsettledProjectionProfiles.clear();

    await expect(service.execute({
      kind: "session.send",
      session: session.id,
      message,
      idempotencyKey: key,
    }, { signal })).rejects.toThrow();
    expect(serviceFixtureDatabaseSnapshot(paths.database)).toEqual(before);
    expect(codex.calls).toEqual(providerCalls);
    expect(store.readSessionUserMessageSource(session.id, "mutation", key))
      .toMatchObject({ status: "pending", intent: { actor: "human" } });
    expect(store.listSessionEvents({ sessionId: session.id, afterSequence: 0 }).events
      .filter((event) => event.body.type === "user_message"
        && event.body.sourceId === key)).toHaveLength(0);
  });
test("keeps a genuinely settled send replay independent of current projection and process authority", async () => {
    const value = await fixture();
    const { service, store, paths } = value;
    const { sessionId } = await createIdleSession(value, "Settled original-authority replay");
    const originalSession = store.requireSession(sessionId);
    const authority = store.requireProviderAccountAuthority(originalSession.profileId, "codex");
    const key = "00000000-0000-4000-8000-00000000010a";
    const message = "genuinely settled before the process restart";
    const command = { kind: "session.send" as const, session: sessionId, message, idempotencyKey: key };
    const first = await service.execute(command, { signal });
    if (typeof first !== "object" || first === null || Array.isArray(first)) throw new Error("Expected a structured send receipt.");
    const original = store.readMutation(key);
    if (original === null) throw new Error("Expected an actual completed provider receipt.");
    expect(original.state).toBe("applied");
    const originalAuthorities = store.readMutationProviderAuthorities(original.id);
    const originalSource = store.readSessionUserMessageSource(sessionId, "mutation", key);
    expect(originalSource.status).toBe("finalized");
    const originalRuntime = store.latestSessionRuntimeProfile(sessionId);
    expect(originalRuntime).toMatchObject({ sourceKind: "turn_start", sourceId: original.id });
    const originalEvents = store.listSessionEvents({ sessionId, afterSequence: 0 }).events;
    expect(originalEvents.filter((event) => event.body.type === "user_message" && event.body.sourceId === key)).toHaveLength(1);
    await service.close();
    const bootId = `boot_${crypto.randomUUID().replaceAll("-", "")}`;
    const daemonGeneration = store.nextDaemonGeneration(bootId);
    expect(store.requireProviderAccountAuthority(authority.profileId, "codex").processGeneration)
      .toBeGreaterThan(authority.processGeneration);
    const cloud = new FakeCloud();
    const codex = new FakeCodex();
    const restarted = new OompaService({ store, paths, codex, cloud, daemonGeneration, daemonBootId: bootId,
      daemonAuthority: new FakeDaemonAuthority(), requestStop: () => undefined });
    const before = serviceFixtureDatabaseSnapshot(paths.database);
    cloud.beforeProjectionUnsettledSessionReturn = () => {
      throw new Error("A settled replay must not observe current cloud recovery state.");
    };
    cloud.beforeProjectionUnsettledProfileReturn = () => {
      throw new Error("A settled replay must not observe current account recovery state.");
    };
    const replay = await restarted.execute(command, { signal });
    expect(replay).toMatchObject({ idempotencyKey: key });
    expectHistoricalValue(replay, { ...first, session: store.requireSession(sessionId) });
    expect(store.readMutation(key)).toEqual(original);
    expect(store.readMutationProviderAuthorities(original.id)).toEqual(originalAuthorities);
    expect(store.readSessionUserMessageSource(sessionId, "mutation", key)).toEqual(originalSource);
    expect(store.latestSessionRuntimeProfile(sessionId)).toEqual(originalRuntime);
    expect(serviceFixtureDatabaseSnapshot(paths.database)).toEqual(before);
    expect(codex.calls).toEqual([]);
    await restarted.close();
  });
test("does not resurrect a retained-out send transcript record on exact replay", async () => {
    let currentTime = 1_000;
    const { service, codex, documents, store } = await fixture(new FakeCloud(),
      () => undefined,
      () => currentTime,
    );
    const added = await service.execute({ kind: "account.add", label: "Send retention replay" }, { signal }) as { account: { id: string } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    await service.execute({ kind: "project.add", label: "Docs", path: documents }, { signal });
    const started = await service.execute({ kind: "session.start", account: added.account.id, preset: "high", presetContract: 2, fast: false }, { signal }) as { session: { id: `sess_${string}` } };
    const command = {
      kind: "session.send" as const,
      session: started.session.id,
      message: "expire this send",
      idempotencyKey: "00000000-0000-4000-8000-000000000107",
    };

    await service.execute(command, { signal });
    currentTime += SESSION_EVENT_RETAIN_AGE_MS + 1;
    store.maintainSessionEventRetention(started.session.id, currentTime);
    expect(store.listSessionEvents({
      afterSequence: 0,
      sessionId: started.session.id,
    }).events.some((event) =>
      event.body.type === "user_message"
      && event.body.sourceId === command.idempotencyKey)).toBe(false);

    await service.execute(command, { signal });

    expect(codex.calls.filter((call) => call === "send")).toHaveLength(1);
    expect(store.listSessionEvents({
      afterSequence: 0,
      sessionId: started.session.id,
    }).events.some((event) =>
      event.body.type === "user_message"
      && event.body.sourceId === command.idempotencyKey)).toBe(false);
  });
test("does not reopen the human autorespond budget on retained-out exact replay", async () => {
    let currentTime = 1_000;
    const { service, codex, documents, store } = await fixture(new FakeCloud(),
      () => undefined,
      () => currentTime,
    );
    const added = await service.execute({ kind: "account.add", label: "Human replay budget" }, { signal }) as { account: { id: string } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    await service.execute({ kind: "project.add", label: "Docs", path: documents }, { signal });
    const started = await service.execute({ kind: "session.start", account: added.account.id, preset: "high", presetContract: 2, fast: false }, { signal }) as { session: { id: `sess_${string}` } };
    const command = {
      kind: "session.send" as const,
      session: started.session.id,
      message: "old human authority",
      idempotencyKey: "00000000-0000-4000-8000-000000000109",
    };

    await service.execute(command, { signal });
    currentTime += SESSION_EVENT_RETAIN_AGE_MS + 1;
    store.maintainSessionEventRetention(started.session.id, currentTime);
    store.bumpAutorespondCounter(started.session.id);
    store.bumpAutorespondCounter(started.session.id);
    store.bumpAutorespondCounter(started.session.id);
    expect(store.readAutorespondBudgets(started.session.id).consecutive).toBe(3);

    await service.execute(command, { signal });

    expect(codex.calls.filter((call) => call === "send")).toHaveLength(1);
    expect(store.readAutorespondBudgets(started.session.id).consecutive).toBe(3);
  });
test("does not resurrect a retained-out steer transcript record on exact replay", async () => {
    let currentTime = 1_000;
    const { service, codex, documents, store } = await fixture(new FakeCloud(),
      () => undefined,
      () => currentTime,
    );
    const added = await service.execute({ kind: "account.add", label: "Steer retention replay" }, { signal }) as { account: { id: string } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    await service.execute({ kind: "project.add", label: "Docs", path: documents }, { signal });
    const started = await service.execute({ kind: "session.start", account: added.account.id, preset: "high", presetContract: 2, fast: false }, { signal }) as { session: { id: `sess_${string}` } };
    await service.execute({ kind: "session.send", session: started.session.id, message: "activate" }, { signal });
    const command = {
      kind: "session.steer" as const,
      session: started.session.id,
      message: "expire this steer",
      idempotencyKey: "00000000-0000-4000-8000-000000000108",
    };

    await service.execute(command, { signal });
    currentTime += SESSION_EVENT_RETAIN_AGE_MS + 1;
    store.maintainSessionEventRetention(started.session.id, currentTime);
    expect(store.listSessionEvents({
      afterSequence: 0,
      sessionId: started.session.id,
    }).events.some((event) =>
      event.body.type === "user_message"
      && event.body.sourceId === command.idempotencyKey)).toBe(false);

    await service.execute(command, { signal });

    expect(codex.calls.filter((call) => call === "steer")).toHaveLength(1);
    expect(store.listSessionEvents({
      afterSequence: 0,
      sessionId: started.session.id,
    }).events.some((event) =>
      event.body.type === "user_message"
      && event.body.sourceId === command.idempotencyKey)).toBe(false);
  });
test("keeps a receipt-commit ambiguity quarantined across passive and exact provider reads", async () => {
    const { service, codex, documents, store } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Receipt failure" }, { signal }) as { account: { id: string } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    await service.execute({ kind: "project.add", label: "Docs", path: documents }, { signal });
    const started = await service.execute({ kind: "session.start", account: added.account.id, preset: "high", presetContract: 2, fast: false }, { signal }) as { session: { id: string } };
    codex.turnId = "";
    const idempotencyKey = "00000000-0000-4000-8000-000000000107";
    const command = { kind: "session.send" as const, session: started.session.id, message: "ambiguous", idempotencyKey };
    await expect(service.execute(command, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(store.readMutation(idempotencyKey)).toMatchObject({ state: "ambiguous" });
    const quarantined = store.requireSession(started.session.id);
    expect(quarantined).toMatchObject({ state: "recovery_required", providerUpdatedAt: 10 });

    await expect(service.execute({ kind: "session.send", session: started.session.id, message: "different key", idempotencyKey: "00000000-0000-4000-8000-000000000110" }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(codex.calls.filter((call) => call === "send")).toHaveLength(1);

    codex.listedProjections = [{ providerThreadId: "provider-thread", title: "Passive", status: "active", activeTurnId: "turn-passive", providerUpdatedAt: 11 }];
    await service.execute({ kind: "session.list", account: added.account.id, archived: false, limit: 20 }, { signal });
    expect(store.requireSession(started.session.id)).toEqual(quarantined);

    codex.readProjection = { providerThreadId: "provider-thread", title: "Exact", status: "active", activeTurnId: "turn-exact", providerUpdatedAt: 12 };
    expect(await service.execute({ kind: "session.show", session: started.session.id, detail: false }, { signal })).toMatchObject({
      session: { state: "recovery_required", providerUpdatedAt: 10 },
      recovery: { required: true, cleared: false },
    });
    expect(store.requireSession(started.session.id)).toEqual(quarantined);

    await expect(service.execute(command, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(codex.calls.filter((call) => call === "send")).toHaveLength(1);
  });
test("quarantines a provider turn when its effective runtime profile cannot be committed", async () => {
    const { service, documents, store } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Runtime receipt" }, { signal }) as { account: { id: string } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    await service.execute({ kind: "project.add", label: "Docs", path: documents }, { signal });
    const started = await service.execute({ kind: "session.start", account: added.account.id, preset: "high", presetContract: 2, fast: false }, { signal }) as { session: { id: `sess_${string}` } };
    const originalComplete = store.completeSessionTurnEffect.bind(store);
    store.completeSessionTurnEffect = (() => { throw new Error("simulated receipt storage failure"); }) as StateStore["completeSessionTurnEffect"];
    const key = "00000000-0000-4000-8000-000000000111";

    await expect(service.execute({ kind: "session.send", session: started.session.id, message: "profile must commit", idempotencyKey: key }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(store.readMutation(key)).toMatchObject({ state: "ambiguous" });
    expect(store.requireSession(started.session.id)).toMatchObject({ state: "recovery_required" });
    expect(store.latestSessionRuntimeProfile(started.session.id)).toMatchObject({ revision: 1, sourceKind: "session_start" });
    store.completeSessionTurnEffect = originalComplete;
  });
test.each(["send", "steer", "stop", "rename"] as const)(
    "quarantines a lost %s provider response before another key can dispatch",
    (operation) => {
      const caseTask: Promise<void> = ownedServiceFixtureWithClose(async (value) => {
        // Timeout cancellation joins the complete test continuation before
        // service/store cleanup, including assertions after an admitted call.
        await Promise.allSettled([caseTask]);
        await value.service.close();
      }).then(async ({ execute, codex, documents, store }) => {
        const added = await execute({ kind: "account.add", label: `Lost ${operation}` }) as { account: { id: string } };
        await execute({ kind: "account.login", account: added.account.id, deviceCode: false });
        await execute({ kind: "project.add", label: "Docs", path: documents });
        const started = await execute({ kind: "session.start", account: added.account.id, preset: "high", presetContract: 2, fast: false }) as { session: { id: string } };
        if (operation === "steer" || operation === "stop") {
          await execute({ kind: "session.send", session: started.session.id, message: "activate" });
        }
        const lost = new IndeterminateCodexEffectError(`turn/${operation}`, 41);
        if (operation === "send") codex.startTurnError = lost;
        if (operation === "steer") codex.steerError = lost;
        if (operation === "stop") codex.interruptError = lost;
        if (operation === "rename") codex.renameError = lost;
        const firstKey = `00000000-0000-4000-8000-0000000002${operation === "send" ? "01" : operation === "steer" ? "02" : operation === "stop" ? "03" : "04"}`;
        const secondKey = `00000000-0000-4000-8000-0000000003${operation === "send" ? "01" : operation === "steer" ? "02" : operation === "stop" ? "03" : "04"}`;
        const first = operation === "send"
          ? { kind: "session.send" as const, session: started.session.id, message: "lost", idempotencyKey: firstKey }
          : operation === "steer"
            ? { kind: "session.steer" as const, session: started.session.id, message: "lost", idempotencyKey: firstKey }
            : operation === "stop"
              ? { kind: "session.stop" as const, session: started.session.id, idempotencyKey: firstKey }
              : { kind: "session.rename" as const, session: started.session.id, name: "Lost", idempotencyKey: firstKey };
        const second = operation === "send"
          ? { kind: "session.send" as const, session: started.session.id, message: "different", idempotencyKey: secondKey }
          : operation === "steer"
            ? { kind: "session.steer" as const, session: started.session.id, message: "different", idempotencyKey: secondKey }
            : operation === "stop"
              ? { kind: "session.stop" as const, session: started.session.id, idempotencyKey: secondKey }
              : { kind: "session.rename" as const, session: started.session.id, name: "Different", idempotencyKey: secondKey };

        await expect(execute(first)).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
        expect(store.requireSession(started.session.id)).toMatchObject({ state: "recovery_required" });
        const providerCalls = codex.calls.filter((call) => call === operation).length;
        await expect(execute(second)).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
        expect(codex.calls.filter((call) => call === operation)).toHaveLength(providerCalls);
      });
      void caseTask.catch(() => undefined);
      return caseTask;
    },
  );
test("quarantines a bound session when the session-start receipt cannot commit", async () => {
    const { service, codex, documents, store } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Start receipt" }, { signal }) as { account: { id: string } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    await service.execute({ kind: "project.add", label: "Docs", path: documents }, { signal });
    const originalComplete = store.completeSessionStartEffect.bind(store);
    store.completeSessionStartEffect = (() => { throw new Error("simulated atomic start receipt failure"); }) as StateStore["completeSessionStartEffect"];
    const command = { kind: "session.start" as const, account: added.account.id, preset: "high" as const, presetContract: 2 as const, fast: false, idempotencyKey: "00000000-0000-4000-8000-000000000401" };
    await expect(service.execute(command, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    store.completeSessionStartEffect = originalComplete;

    const [session] = store.listSessions();
    expect(session).toMatchObject({ state: "recovery_required" });
    expect(session?.providerThreadId).toBe("provider-thread");
    if (session === undefined) throw new Error("The quarantined session is missing.");
    await expect(service.execute({ kind: "session.send", session: session.id, message: "must not dispatch", idempotencyKey: "00000000-0000-4000-8000-000000000402" }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    await expect(service.execute(command, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(codex.calls.filter((call) => call.startsWith("start:"))).toHaveLength(1);
    expect(codex.calls.filter((call) => call === "send")).toHaveLength(0);
  });
test.each(["canonical33_applied", "canonical39_applied"] as const)(
    "replays an authentic archived start only under its captured source contract (%s)",
    async (scenario) => {
      const captured = canonicalSessionStartFixtures[scenario];
      const { service, codex, store, paths } = await fixture(new FakeCloud(), () => undefined, () => 40_000, undefined, {},
        { canonicalSessionStart: scenario },
      );
      // The fixture is imported before migration and a real new daemon boot.
      // Its synthetic provider receipt proves replay, not renewed native custody.
      expect(store.requireProfileById(captured.profile.id).processGeneration)
        .toBeGreaterThan(captured.profile.processGeneration);
      expectHistoricalValue(store.readMutation(captured.idempotencyKey)?.evidence, captured.mutation.evidence);
      expectHistoricalValue(store.readMutation(captured.idempotencyKey)?.result, captured.mutation.result);
      expect(store.readMutation(captured.idempotencyKey)?.requestDigest).toBe(captured.mutation.requestDigest);
      const command = {
        kind: "session.start" as const,
        account: captured.profile.id,
        preset: "high" as const,
        fast: false,
        idempotencyKey: captured.idempotencyKey,
      };
      const before = serviceFixtureDatabaseSnapshot(paths.database);
      await expect(service.execute(command, { signal })).rejects.toMatchObject({ code: "CONFLICT" });
      await expect(service.execute({
        ...command, presetContract: captured.interpretedPresetContract === 1 ? 2 : 1,
      }, { signal })).rejects.toMatchObject({ code: "CONFLICT" });
      await expect(service.execute({
        ...command, presetContract: captured.interpretedPresetContract,
      }, { signal })).resolves.toMatchObject({
        idempotencyKey: captured.idempotencyKey,
        session: { id: captured.session.id, projectId: captured.project.id },
        effectiveRuntimeProfile: { model: captured.model, reasoningEffort: "max", processGeneration: 1 },
      });
      expectHistoricalValue(store.readMutation(captured.idempotencyKey)?.result, captured.mutation.result);
      expectHistoricalValue(store.readMutation(captured.idempotencyKey)?.evidence, captured.mutation.evidence);
      expect(serviceFixtureDatabaseSnapshot(paths.database)).toEqual(before);
      expect(codex.calls).toEqual([]);
    },
  );
test("replays a settled source-bound start against its original project after the default changes", async () => {
    const { service, codex, cloud, documents } = await fixture();
    const added = await service.execute(
      { kind: "account.add", label: "Settled start default project" },
      { signal },
    ) as { account: { id: string } };
    await service.execute(
      { kind: "account.login", account: added.account.id, deviceCode: false },
      { signal },
    );
    const original = await service.execute(
      { kind: "project.add", label: "Original start project", path: documents },
      { signal },
    ) as { project: { id: string } };
    const command = {
      account: added.account.id,
      fast: false,
      idempotencyKey: "00000000-0000-4000-8000-00000000041c",
      kind: "session.start" as const,
      preset: "high" as const,
      presetContract: 2 as const,
    };
    const first = await service.execute(command, { signal }) as {
      idempotencyKey: string;
      session: { id: string; projectId?: string };
    };
    expect(first.session.projectId).toBe(original.project.id);

    const alternateRoot = join(documents, "..", "Alternate");
    await mkdir(alternateRoot, { recursive: true });
    const alternate = await service.execute(
      { kind: "project.add", label: "Alternate start project", path: alternateRoot },
      { signal },
    ) as { project: { id: string } };
    await service.execute(
      { kind: "project.use", project: alternate.project.id },
      { signal },
    );
    cloud.beforeProjectionUnsettledProfileReturn = () => {
      throw new Error("A settled start replay must not query current cloud recovery state.");
    };
    const providerCalls = [...codex.calls];

    await expect(service.execute(command, { signal })).resolves.toMatchObject({
      idempotencyKey: command.idempotencyKey,
      session: { id: first.session.id, projectId: original.project.id },
    });
    await expect(service.execute({
      ...command,
      project: alternate.project.id,
    }, { signal })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(service.execute({
      ...command,
      presetContract: 1,
    }, { signal })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(codex.calls).toEqual(providerCalls);
  });
test("replays a settled source-bound start after its project root disappears", async () => {
    const { service, codex, cloud, documents } = await fixture();
    const added = await service.execute(
      { kind: "account.add", label: "Settled start missing project" },
      { signal },
    ) as { account: { id: string } };
    await service.execute(
      { kind: "account.login", account: added.account.id, deviceCode: false },
      { signal },
    );
    const project = await service.execute(
      { kind: "project.add", label: "Missing start project", path: documents },
      { signal },
    ) as { project: { id: string } };
    const command = {
      account: added.account.id,
      fast: false,
      idempotencyKey: "00000000-0000-4000-8000-00000000041d",
      kind: "session.start" as const,
      preset: "ultra" as const,
      presetContract: 2 as const,
      project: project.project.id,
    };
    const first = await service.execute(command, { signal }) as {
      idempotencyKey: string;
      session: { id: string };
    };
    await rename(documents, `${documents}-missing`);
    cloud.beforeProjectionUnsettledProfileReturn = () => {
      throw new Error("A settled start replay must not query current cloud recovery state.");
    };
    const providerCalls = [...codex.calls];

    await expect(service.execute(command, { signal })).resolves.toMatchObject({
      idempotencyKey: command.idempotencyKey,
      session: { id: first.session.id },
    });
    expect(codex.calls).toEqual(providerCalls);
  });
test.each(["canonical33_effect_started", "canonical39_effect_started"] as const)(
    "retains an authentic indeterminate start across boot, checking source authority only when its captured root is usable (%s)",
    async (scenario) => {
      const captured = canonicalSessionStartFixtures[scenario];
      const { service, codex, store, paths } = await fixture(new FakeCloud(), () => undefined, () => 40_000, undefined, {},
        { canonicalSessionStart: scenario },
      );
      expect(store.requireProfileById(captured.profile.id).processGeneration)
        .toBeGreaterThan(captured.profile.processGeneration);
      expect(store.readMutation(captured.idempotencyKey)).toMatchObject({
        authorityId: captured.profile.id,
        authorityGeneration: captured.profile.processGeneration,
        requestDigest: captured.mutation.requestDigest,
        state: "ambiguous",
      });
      expectHistoricalValue(store.readMutation(captured.idempotencyKey)?.evidence, captured.mutation.evidence);
      expect(store.requireSession(captured.session.id).state).toBe("recovery_required");
      const command = {
        kind: "session.start" as const,
        account: captured.profile.id,
        preset: "high" as const,
        fast: false,
        idempotencyKey: captured.idempotencyKey,
      };
      const before = serviceFixtureDatabaseSnapshot(paths.database);
      // The authentic capture retains its original /opt/homebrew project.
      // Observe that exact path independently before invocation; never relocate
      // historical authority or derive an expected refusal from the response.
      const capturedRootUsable = await resolveUsableCanonicalProjectDirectory(captured.project.rootPath) !== null;
      if (capturedRootUsable) {
        await expect(service.execute(command, { signal })).rejects.toMatchObject({ code: "CONFLICT" });
        await expect(service.execute({
          ...command, presetContract: captured.interpretedPresetContract === 1 ? 2 : 1,
        }, { signal })).rejects.toMatchObject({ code: "CONFLICT" });
        await expect(service.execute({
          ...command, presetContract: captured.interpretedPresetContract,
        }, { signal })).rejects.toMatchObject({
          code: "RECOVERY_REQUIRED", details: { idempotencyKey: captured.idempotencyKey },
        });
      } else {
        for (const requested of [
          command,
          { ...command, presetContract: captured.interpretedPresetContract === 1 ? 2 as const : 1 as const },
          { ...command, presetContract: captured.interpretedPresetContract },
        ]) {
          await expect(service.execute(requested, { signal })).rejects.toMatchObject({
            code: "UNAVAILABLE",
            details: { nextCommand: "oompa doctor", repair: "repair_or_select_project" },
          });
        }
      }
      expect(serviceFixtureDatabaseSnapshot(paths.database)).toEqual(before);
      expectHistoricalValue(store.readMutation(captured.idempotencyKey)?.evidence, captured.mutation.evidence);
      expect(codex.calls).toEqual([]);
    },
  );
test("refuses new starts after the registered project root disappears without changing authority", async () => {
    const { service, codex, documents, store, paths } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Missing start root" }, { signal }) as {
      account: { id: `acct_${string}` };
    };
    expect(store.setProfileState(added.account.id, 0, "signed_in", {
      email: "missing-start-root@example.com", plan: "Plus",
    })).toBe(true);
    await service.execute({ kind: "project.add", label: "Missing root", path: documents }, { signal });
    await rename(documents, `${documents}-unavailable`);
    expect(await resolveUsableCanonicalProjectDirectory(documents)).toBeNull();
    const before = serviceFixtureDatabaseSnapshot(paths.database);
    for (const presetContract of [undefined, 2, 1] as const) {
      await expect(service.execute({
        kind: "session.start", account: added.account.id, preset: "high", fast: false,
        ...(presetContract === undefined ? {} : { presetContract }),
      }, { signal })).rejects.toMatchObject({
        code: "UNAVAILABLE",
        details: { nextCommand: "oompa doctor", repair: "repair_or_select_project" },
      });
    }
    expect(serviceFixtureDatabaseSnapshot(paths.database)).toEqual(before);
    expect(store.listSessions()).toEqual([]);
    expect(codex.calls).toEqual([]);
  });
test("refuses fresh absent or stale rebound sources before provider contact or mutation preparation", async () => {
    const { service, codex, documents, store } = await fixture();
    const added = await service.execute(
      { kind: "account.add", label: "Fresh source admission" },
      { signal },
    ) as { account: { id: string } };
    await service.execute(
      { kind: "account.login", account: added.account.id, deviceCode: false },
      { signal },
    );
    const project = await service.execute(
      { kind: "project.add", label: "Fresh source docs", path: documents },
      { signal },
    ) as { project: { id: `proj_${string}` } };
    const providerCallsBefore = codex.calls.length;
    const base = {
      account: added.account.id,
      fast: false,
      kind: "session.start" as const,
      preset: "high" as const,
    };
    for (const [idempotencyKey, presetContract] of [
      ["00000000-0000-4000-8000-00000000040a", undefined],
      ["00000000-0000-4000-8000-00000000040b", 1],
    ] as const) {
      await expect(service.execute({
        ...base,
        idempotencyKey,
        ...(presetContract === undefined ? {} : { presetContract }),
      }, { signal })).rejects.toMatchObject({ code: "CONFLICT" });
      expect(store.readMutation(idempotencyKey)).toBeNull();
      expect(codex.calls).toHaveLength(providerCallsBefore);
    }

    const currentKey = "00000000-0000-4000-8000-00000000040c";
    await expect(service.execute({
      ...base,
      idempotencyKey: currentKey,
      presetContract: 2,
    }, { signal })).resolves.toMatchObject({ session: { state: "idle" } });
    expect(store.readMutation(currentKey)).toMatchObject({
      evidence: { evidence: { presetContract: 2 } },
      requestDigest: mutationRequestDigest({
        authorityGeneration: store.requireProfileById(added.account.id).processGeneration,
        authorityId: added.account.id,
        kind: "session.start",
        request: sessionStartMutationRequest({
          fast: false,
          preset: "high",
          presetContract: 2,
          projectId: project.project.id,
          provider: "codex",
        }),
      }),
      state: "applied",
    });
    const providerCallsAfterCurrent = codex.calls.length;
    await expect(service.execute({
      ...base,
      fast: true,
      idempotencyKey: currentKey,
      presetContract: 2,
    }, { signal })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(service.execute({
      ...base,
      idempotencyKey: currentKey,
    }, { signal })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(codex.calls).toHaveLength(providerCallsAfterCurrent);
  });
test("resumes only currently admitted prepared rebound starts", async () => {
    const { service, codex, documents, store } = await fixture();
    const added = await service.execute(
      { kind: "account.add", label: "Prepared source admission" },
      { signal },
    ) as { account: { id: `acct_${string}` } };
    await service.execute(
      { kind: "account.login", account: added.account.id, deviceCode: false },
      { signal },
    );
    const project = await service.execute(
      { kind: "project.add", label: "Prepared source docs", path: documents },
      { signal },
    ) as { project: { id: `proj_${string}` } };
    const profile = store.requireProfileById(added.account.id);
    const prepare = (idempotencyKey: string, presetContract?: 1 | 2) => store.prepareMutation({
      authorityGeneration: profile.processGeneration,
      authorityId: profile.id,
      providerAuthorities: [{ role: "primary", authority: store.requireProviderAccountAuthority(profile.id, "codex"), provenance: "session_start" }],
      idempotencyKey,
      kind: "session.start",
      request: sessionStartMutationRequest({
        fast: false,
        preset: "high",
        ...(presetContract === undefined ? {} : { presetContract }),
        projectId: project.project.id,
        provider: "codex",
      }),
    });
    const prepareContractless = (idempotencyKey: string) => store.prepareMutation({
      authorityGeneration: profile.processGeneration,
      authorityId: profile.id,
      idempotencyKey,
      kind: "session.start",
      request: {
        projectId: project.project.id,
        preset: "high",
        fast: false,
      },
    });
    const base = {
      account: profile.id,
      fast: false,
      kind: "session.start" as const,
      preset: "high" as const,
    };

    // These are deliberately unadmitted current prepared requests, not historical writer output.
    const legacyPreparedKey = "00000000-0000-4000-8000-00000000040e";
    prepareContractless(legacyPreparedKey);
    const stalePreparedKey = "00000000-0000-4000-8000-00000000040f";
    prepare(stalePreparedKey, 1);
    const providerCallsBefore = codex.calls.length;
    await expect(service.execute({
      ...base,
      idempotencyKey: legacyPreparedKey,
    }, { signal })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(service.execute({
      ...base,
      idempotencyKey: legacyPreparedKey,
      presetContract: 2,
    }, { signal })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(service.execute({
      ...base,
      idempotencyKey: legacyPreparedKey,
      presetContract: 1,
    }, { signal })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(service.execute({
      ...base,
      idempotencyKey: stalePreparedKey,
      presetContract: 1,
    }, { signal })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(codex.calls).toHaveLength(providerCallsBefore);
    expect(store.readMutation(legacyPreparedKey)).toMatchObject({ state: "prepared" });
    expect(store.readMutation(stalePreparedKey)).toMatchObject({ state: "prepared" });

    const currentPreparedKey = "00000000-0000-4000-8000-000000000412";
    prepare(currentPreparedKey, 2);
    await expect(service.execute({
      ...base,
      idempotencyKey: currentPreparedKey,
      presetContract: 2,
    }, { signal })).resolves.toMatchObject({ session: { preset: "high", state: "idle" } });
    expect(store.readMutation(currentPreparedKey)).toMatchObject({ state: "applied" });
    expect(codex.calls.filter((call) => call === "review-session")).toHaveLength(1);
    expect(codex.calls.filter((call) => call === "start:high")).toHaveLength(1);
  });
test.each(["provider_thread_deleted", "provider_transport_lost"] as const)(
    "acknowledges terminal input custody locally without outer memory maintenance (%s)",
    async (source) => {
      const f = await terminalInputCustodyFixture(source);
      if (f.attemptId === undefined || f.idempotencyKey === undefined) throw new Error("Expected retained input.");
      const original = f.store.readMutation(f.idempotencyKey);
      const authority = f.store.readMutationProviderAuthorities(f.attemptId);
      expect(original?.resolution).toMatchObject({ kind: "abandoned", evidence: { source } });
      expect(f.store.messageAttachmentManifest(f.terminal.id, f.attemptId)).toEqual([f.reference]);
      const command = { kind: "session.abandon" as const, session: f.terminal.id };
      await expect(f.local.execute(command, { signal })).resolves.toMatchObject({
        session: f.terminal,
        recovery: { resolved: true, resolution: "abandoned", localInputCustodyAcknowledged: true,
          releasedInputCount: 1, alreadyAcknowledgedInputCount: 0,
          providerEffectRetried: false, providerStateDeleted: false, providerOutcomeKnown: false },
      });
      expect(f.store.readMutation(f.idempotencyKey)).toEqual(original);
      expect(f.store.readMutationProviderAuthorities(f.attemptId)).toEqual(authority);
      expect(f.store.messageAttachmentManifest(f.terminal.id, f.attemptId)).toEqual([]);
      expect(f.store.attachmentCustody(f.reference.digest)).toMatchObject({ referenceCount: 0 });
      f.assertNoExternalWork();
      const after = serviceFixtureDatabaseSnapshot(f.paths.database);
      await expect(f.local.execute(command, { signal })).resolves.toMatchObject({
        recovery: { releasedInputCount: 0, alreadyAcknowledgedInputCount: 1, providerOutcomeKnown: false },
      });
      expect(serviceFixtureDatabaseSnapshot(f.paths.database)).toEqual(after);
      f.assertNoExternalWork();
    },
  );
test("refuses terminal abandon without an acknowledgment candidate and leaves local history unchanged", async () => {
    const f = await terminalInputCustodyFixture("provider_thread_deleted", false);
    const before = serviceFixtureDatabaseSnapshot(f.paths.database);
    await expect(f.local.execute({ kind: "session.abandon", session: f.terminal.id }, { signal }))
      .rejects.toMatchObject({ code: "CONFLICT" });
    expect(serviceFixtureDatabaseSnapshot(f.paths.database)).toEqual(before);
    f.assertNoExternalWork();
  });
test.each(["revision", "daemon"] as const)(
    "rechecks selected terminal acknowledgment authority before local commit (%s)",
    async (changed) => {
      const f = await terminalInputCustodyFixture();
      let assertions = 0;
      let afterConcurrentChange = serviceFixtureDatabaseSnapshot(f.paths.database);
      f.daemonAuthority.beforeAssert = async () => {
        assertions++;
        // Entry, account serializer, session serializer, then the final local
        // commit fence. Cross the last await, not an earlier lock acquisition.
        if (assertions !== 4) return;
        if (changed === "daemon") f.daemonAuthority.current = false;
        else f.store.setSessionTurnState({
          sessionId: f.terminal.id, expectedRevision: f.terminal.revision, state: "terminal",
        });
        afterConcurrentChange = serviceFixtureDatabaseSnapshot(f.paths.database);
      };
      const command = f.local.execute({ kind: "session.abandon", session: f.terminal.id }, { signal });
      if (changed === "daemon") await expect(command).rejects.toBeInstanceOf(DaemonAuthoritySafetyError);
      else await expect(command).rejects.toMatchObject({ code: "CONFLICT" });
      expect(assertions).toBe(4);
      expect(serviceFixtureDatabaseSnapshot(f.paths.database)).toEqual(afterConcurrentChange);
      f.assertNoExternalWork();
    },
  );
test("maps a closed terminal acknowledgment refusal without leaking storage diagnostics", async () => {
    const f = await terminalInputCustodyFixture();
    f.store.acknowledgeTerminalSessionInputCustody = () => { throw new Error("ATTACHMENT_TERMINAL_ACKNOWLEDGMENT_INVALID"); };
    const before = serviceFixtureDatabaseSnapshot(f.paths.database);
    await expect(f.local.execute({ kind: "session.abandon", session: f.terminal.id }, { signal }))
      .rejects.toMatchObject({
        code: "RECOVERY_REQUIRED",
        message: "The retained terminal input custody cannot be proved. Inspect the session before acknowledging local cleanup.",
      });
    expect(serviceFixtureDatabaseSnapshot(f.paths.database)).toEqual(before);
    f.assertNoExternalWork();
  });
test("refuses an aborted terminal acknowledgment without changing custody or memory", async () => {
    const f = await terminalInputCustodyFixture();
    const controller = new AbortController();
    const reason = new Error("Synthetic terminal acknowledgment cancelled.");
    controller.abort(reason);
    const before = serviceFixtureDatabaseSnapshot(f.paths.database);
    await expect(f.local.execute({ kind: "session.abandon", session: f.terminal.id }, { signal: controller.signal }))
      .rejects.toBe(reason);
    expect(serviceFixtureDatabaseSnapshot(f.paths.database)).toEqual(before);
    f.assertNoExternalWork();
  });
test("preserves admitted selection errors and normal maintenance when terminal lookup fails", async () => {
    const f = await terminalInputCustodyFixture();
    await expect(f.local.execute({ kind: "session.abandon", session: `sess_${"0".repeat(32)}` }, { signal }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(f.factsMemory.cleanups).toContainEqual({
      ownerId: f.terminal.profileId, sessionId: f.terminal.id, reason: "archive",
    });
    if (f.attemptId === undefined) throw new Error("Expected retained input.");
    expect(f.store.messageAttachmentManifest(f.terminal.id, f.attemptId)).toEqual([f.reference]);
  });
test.each(["recover", "nonterminal_abandon"] as const)(
    "preserves ordinary memory maintenance outside terminal-only acknowledgment (%s)",
    async (action) => {
      const f = await terminalInputCustodyFixture();
      delete f.cloud.beforeProjectionUnsettledSessionReturn;
      delete f.cloud.beforeProjectionUnsettledProfileReturn;
      const live = action === "recover" ? null : f.store.upsertProviderSession({
        profileId: f.terminal.profileId, provider: "codex",
        providerAuthority: f.store.requireProviderAccountAuthority(f.terminal.profileId, "codex"),
        providerAccountKey: codexProviderAccountKey(), providerThreadId: "ordinary-abandon-control",
        title: "Ordinary live refusal", preset: "high", fastEnabled: false, state: "idle",
      });
      const command = action === "recover"
        ? { kind: "session.recover" as const, session: f.terminal.id }
        : { kind: "session.abandon" as const, session: live?.id ?? "" };
      await expect(f.local.execute(command, { signal })).rejects.toMatchObject({ code: "CONFLICT" });
      expect(f.factsMemory.cleanups).toContainEqual({
        ownerId: f.terminal.profileId, sessionId: f.terminal.id, reason: "archive",
      });
      expect(f.factsMemory.sweeps.length).toBeGreaterThan(0);
      if (f.attemptId === undefined) throw new Error("Expected retained input.");
      expect(f.store.messageAttachmentManifest(f.terminal.id, f.attemptId)).toEqual([f.reference]);
      expect(f.store.attachmentCustody(f.reference.digest)).toMatchObject({ referenceCount: 1 });
    },
  );
test("preserves the committed security-scrub lifecycle after terminal-only acknowledgment", async () => {
    const f = await terminalInputCustodyFixture();
    const acknowledge = f.store.acknowledgeTerminalSessionInputCustody.bind(f.store);
    f.store.acknowledgeTerminalSessionInputCustody = (input) => {
      acknowledge(input);
      throw new StateSecurityScrubRequiredError(true);
    };
    await expect(f.local.execute({ kind: "session.abandon", session: f.terminal.id }, {
      signal, afterResponse: (callback) => { f.afterResponse.push(callback); },
    })).rejects.toMatchObject({ code: "UNAVAILABLE", details: { operationCommitted: true } });
    expect(f.stopCalls()).toBe(0);
    expect(f.afterResponse).toHaveLength(1);
    f.afterResponse[0]?.();
    expect(f.stopCalls()).toBe(1);
    expect(f.store.attachmentCustody(f.reference.digest)).toMatchObject({ referenceCount: 0 });
    f.assertNoExternalWork();
  });
test("quarantines an unbound session-start lost response without blind replay", async () => {
    const { service, codex, documents, store } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Lost start" }, { signal }) as { account: { id: string } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    await service.execute({ kind: "project.add", label: "Docs", path: documents }, { signal });
    codex.startSessionError = new IndeterminateCodexEffectError("thread/start", 42);
    const command = { kind: "session.start" as const, account: added.account.id, preset: "high" as const, presetContract: 2 as const, fast: false, idempotencyKey: "00000000-0000-4000-8000-000000000403" };
    await expect(service.execute(command, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(store.listSessions()).toHaveLength(1);
    expect(store.listSessions()[0]).toMatchObject({ state: "recovery_required" });
    await expect(service.execute(command, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    await expect(service.execute({ ...command, idempotencyKey: "00000000-0000-4000-8000-000000000404" }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(codex.calls.filter((call) => call.startsWith("start:"))).toHaveLength(1);
  });
test("keeps legacy stop and rename timestamps unresolved after real provider seconds conversion", async () => {
    for (const operation of ["stop", "rename"] as const) {
      const value = await fixture();
      const { service, codex, store } = value;
      const { sessionId } = await createIdleSession(value, `Legacy ${operation}`);
      if (operation === "stop") await service.execute({ kind: "session.send", session: sessionId, message: "activate" }, { signal });
      codex.readProjection = { ...codex.readProjection, providerUpdatedAt: 1_900_000_000 };
      const key = crypto.randomUUID();
      if (operation === "stop") codex.interruptError = new IndeterminateCodexEffectError("turn/interrupt", 61);
      else codex.renameError = new IndeterminateCodexEffectError("thread/name/set", 62);
      const command = operation === "stop"
        ? { kind: "session.stop" as const, session: sessionId, idempotencyKey: key }
        : { kind: "session.rename" as const, session: sessionId, name: "Recovered", idempotencyKey: key };
      await expect(service.execute(command, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
      const original = store.readMutation(key)?.evidence;
      expect(original?.evidence).not.toHaveProperty("providerTimestampUnit");
      expect(original?.evidence).toMatchObject({ baseline: { providerUpdatedAt: 1_900_000_000 } });
      codex.readProjection = projectBoundedThread(parseThreadMetadataRead({ thread: {
        id: "provider-thread", preview: "Recovered", ephemeral: false, modelProvider: "openai",
        createdAt: 1_900_000_000, updatedAt: 1_900_000_000, status: { type: "idle" },
        cwd: value.documents, name: "Recovered", turns: [],
      } }), false);
      expect(codex.readProjection.providerUpdatedAt).toBe(1_900_000_000_000);
      await expect(service.execute({ kind: "session.recover", session: sessionId }, { signal }))
        .rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
      expect(store.readMutation(key)?.evidence).toEqual(original);
      expect(store.readMutation(key)?.state).toBe("ambiguous");
      expect(store.requireSession(sessionId).state).toBe("recovery_required");
      expect(codex.calls.filter((call) => call === operation)).toHaveLength(1);
    }
  });
test.each(["stop", "rename"] as const)(
    "requires marked safe advancement for %s recovery and strips internal provenance",
    (operation) => {
      const caseTask: Promise<void> = ownedServiceFixtureWithClose(async (value) => {
        await Promise.allSettled([caseTask]);
        await value.service.close();
      }).then(async (value) => {
        const { service, execute, codex, store } = value;
        const { sessionId } = await createIdleSession(value, `Marked ${operation}`);
        if (operation === "stop") await execute({ kind: "session.send", session: sessionId, message: "activate" });
        codex.readProjection = { ...codex.readProjection, providerUpdatedAt: 10_000, providerTimestampUnit: "unix_milliseconds_v1" };
        const key = crypto.randomUUID();
        if (operation === "stop") codex.interruptError = new IndeterminateCodexEffectError("turn/interrupt", 63);
        else codex.renameError = new IndeterminateCodexEffectError("thread/name/set", 64);
        const command = operation === "stop"
          ? { kind: "session.stop" as const, session: sessionId, idempotencyKey: key }
          : { kind: "session.rename" as const, session: sessionId, name: "Recovered", idempotencyKey: key };
        await expect(execute(command)).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
        expect(store.readMutation(key)?.evidence?.evidence).toMatchObject({ providerTimestampUnit: "unix_milliseconds_v1" });
        const observed = codex.readProjection;
        for (const invalid of [
          { providerUpdatedAt: 10_000 }, { providerUpdatedAt: 9_999 },
          { providerUpdatedAt: -1 }, { providerUpdatedAt: 10_000.5 },
          { providerUpdatedAt: Number.MAX_SAFE_INTEGER + 1 },
          { providerUpdatedAt: null }, { providerUpdatedAt: undefined },
          { providerTimestampUnit: undefined }, { providerTimestampUnit: "unix_seconds" },
        ]) {
          // Foreign adapters can return invalid runtime values despite their local type.
          codex.readProjection = { ...observed, ...invalid } as CodexSessionProjection;
          await expect(execute({ kind: "session.recover", session: sessionId }))
            .rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
          expect(store.readMutation(key)?.state).toBe("ambiguous");
        }
        codex.readProjection = observed;
        const recovered = await execute({ kind: "session.recover", session: sessionId });
        expect(recovered).toMatchObject({ recovery: { resolution: "proven_applied", providerEffectRetried: false } });
        expect(recovered).not.toHaveProperty("projection.providerTimestampUnit");
        expect(store.readMutation(key)?.resolution?.evidence).toMatchObject({ providerTimestampUnit: "unix_milliseconds_v1", providerUpdatedAt: 10_001 });
        expect(codex.calls.filter((call) => call === operation)).toHaveLength(1);
        expect(await execute({ kind: "session.show", session: sessionId, detail: false }))
          .not.toHaveProperty("projection.providerTimestampUnit");
        expect(await service.readSessionProjectionForCloud(sessionId, signal)).not.toHaveProperty("providerTimestampUnit");
      });
      void caseTask.catch(() => undefined);
      return caseTask;
    },
  );
test("causally reconciles a lost send by exact client id within one provider timestamp tick", async () => {
    const { service, codex, documents, store } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Causal send" }, { signal }) as { account: { id: string } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    await service.execute({ kind: "project.add", label: "Docs", path: documents }, { signal });
    const started = await service.execute({ kind: "session.start", account: added.account.id, preset: "high", presetContract: 2, fast: false }, { signal }) as { session: { id: `sess_${string}` } };
    const key = "00000000-0000-4000-8000-000000000405";
    codex.startTurnError = new IndeterminateCodexEffectError("turn/start", 44);
    await expect(service.execute({ kind: "session.send", session: started.session.id, message: "causal", idempotencyKey: key }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED", details: { idempotencyKey: key } });
    expect(store.readMutation(key)).toMatchObject({ state: "ambiguous", evidence: { evidence: { kind: "session.send", clientMessageId: expect.any(String), baseline: { providerUpdatedAt: 10 } } } });
    expect(codex.calls.filter((call) => call === "send")).toHaveLength(1);

    delete codex.startTurnError;
    codex.readProjection = { ...codex.readProjection, providerUpdatedAt: 10 };
    expect(await service.execute({ kind: "session.recover", session: started.session.id }, { signal })).toMatchObject({
      idempotencyKey: key,
      session: { state: "active", activeTurnId: "turn-next", providerUpdatedAt: 10 },
      recovery: { resolved: true, resolution: "proven_applied", providerEffectRetried: false },
    });
    expect(store.readMutation(key)).toMatchObject({ state: "reconciled", originalState: "ambiguous", result: { turnId: "turn-next" } });
    expect(store.latestSessionRuntimeProfile(started.session.id)).toMatchObject({ revision: 2, sourceKind: "turn_start", sourceId: expect.any(String) });
    expect(await service.execute({ kind: "session.send", session: started.session.id, message: "causal", idempotencyKey: key }, { signal })).toMatchObject({ turnId: "turn-next", idempotencyKey: key });
    expect(codex.calls.filter((call) => call === "send")).toHaveLength(1);
    expect(await service.execute({ kind: "session.stop", session: started.session.id, idempotencyKey: "00000000-0000-4000-8000-000000000406" }, { signal })).toMatchObject({ stopped: true });
  });
test("reconciles a retired-generation send from immutable evidence after daemon rollover without replay", async () => {
    const value = await fixture();
    const { service, codex, documents, store } = value;
    const added = await service.execute({ kind: "account.add", label: "Rollover causal send" }, { signal }) as { account: { id: `acct_${string}` } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    await service.execute({ kind: "project.add", label: "Rollover docs", path: documents }, { signal });
    const started = await service.execute({ presetContract: currentPresetContract, kind: "session.start", account: added.account.id, preset: "high", fast: false }, { signal }) as { session: { id: `sess_${string}` } };
    const key = "00000000-0000-4000-8000-00000000040a";
    codex.startTurnError = new IndeterminateCodexEffectError("turn/start", 44);
    await expect(service.execute({ kind: "session.send", session: started.session.id, message: "causal across rollover", idempotencyKey: key }, { signal }))
      .rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    const attempt = store.readMutation(key);
    if (attempt === null) throw new Error("Expected the ambiguous send attempt.");
    const capturedAttemptAuthority = store.readMutationProviderAuthorities(attempt.id);
    const oldSessionAuthority = store.requireSessionProviderAuthority(started.session.id);
    const providerProjection = codex.readProjection;

    const daemonGeneration = store.nextDaemonGeneration(`boot_${"d".repeat(32)}`);
    expect(store.requireSessionProviderAuthority(started.session.id)).toMatchObject({
      bindingGeneration: oldSessionAuthority.bindingGeneration,
      processGeneration: oldSessionAuthority.processGeneration + 1,
      providerAccountId: oldSessionAuthority.providerAccountId,
    });
    expect(store.readMutationProviderAuthorities(attempt.id)).toEqual(capturedAttemptAuthority);
    const restartedCodex = new FakeCodex();
    restartedCodex.readProjection = { ...providerProjection, providerUpdatedAt: 10 };
    const restarted = new OompaService({
      store,
      paths: value.paths,
      codex: restartedCodex,
      cloud: new FakeCloud(),
      daemonAuthority: new FakeDaemonAuthority(),
      daemonGeneration,
      requestStop: () => undefined,
    });
    await restarted.recover();
    expect(restartedCodex.calls.filter((call) => call === "send")).toHaveLength(0);

    expect(await restarted.execute({ kind: "session.recover", session: started.session.id }, { signal }))
      .toMatchObject({
        idempotencyKey: key,
        session: { state: "active", activeTurnId: "turn-next" },
        recovery: { resolved: true, resolution: "proven_applied", providerEffectRetried: false },
      });
    expect(store.readMutation(key)).toMatchObject({
      state: "reconciled",
      originalState: "ambiguous",
      resolution: { kind: "proven_applied" },
    });
    expect(store.readMutationProviderAuthorities(attempt.id)).toEqual(capturedAttemptAuthority);
    expect(restartedCodex.calls.filter((call) => call === "send")).toHaveLength(0);
    expect(restartedCodex.calls.filter((call) => call === "read")).toHaveLength(1);
    await restarted.close();
  });
test.each(["missing", "binding"] as const)("rejects missing or replaced immutable send authority after rollover before a provider read (%s)", (corruption) =>
    ownedServiceCase(async ({ createFixture, signal, resources }) => {
      const value = await createFixture();
      signal.throwIfAborted();
      const { service, codex, documents, store } = value;
      const added = await service.execute({ kind: "account.add", label: "Fenced rollover" }, { signal }) as { account: { id: `acct_${string}` } };
      await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
      await service.execute({ kind: "project.add", label: "Fenced docs", path: documents }, { signal });
      const started = await service.execute({ presetContract: currentPresetContract, kind: "session.start", account: added.account.id, preset: "high", fast: false }, { signal }) as { session: { id: `sess_${string}` } };
      const key = crypto.randomUUID();
      codex.startTurnError = new IndeterminateCodexEffectError("turn/start", 44);
      await expect(service.execute({ kind: "session.send", session: started.session.id, message: "immutable", idempotencyKey: key }, { signal }))
        .rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
      signal.throwIfAborted();
      const attempt = store.readMutation(key);
      if (attempt === null) throw new Error("Expected the uncertain send.");
      const readAuthorities = store.readMutationProviderAuthorities.bind(store);
      const original = readAuthorities(attempt.id);
      const daemonGeneration = store.nextDaemonGeneration(`boot_${"e".repeat(32)}`);
      const restartedCodex = new FakeCodex();
      restartedCodex.readProjection = codex.readProjection;
      const restarted = new OompaService({
        store,
        paths: value.paths,
        codex: restartedCodex,
        cloud: new FakeCloud(),
        daemonAuthority: new FakeDaemonAuthority(),
        daemonGeneration,
        requestStop: () => undefined,
      });
      resources.services.push(restarted);
      signal.throwIfAborted();
      await restarted.recover();
      signal.throwIfAborted();
      Object.defineProperty(store, "readMutationProviderAuthorities", {
        configurable: true,
        value: (attemptId: Parameters<StateStore["readMutationProviderAuthorities"]>[0]) => {
          const recorded = readAuthorities(attemptId);
          if (attemptId !== attempt.id) return recorded;
          return corruption === "missing" ? [] : recorded.map((entry) => ({
            ...entry,
            authority: { ...entry.authority, bindingGeneration: entry.authority.bindingGeneration + 1 },
          }));
        },
      });
      try {
        await expect(restarted.execute({ kind: "session.recover", session: started.session.id }, { signal }))
          .rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
        expect(restartedCodex.calls.filter((call) => call === "read" || call === "send")).toHaveLength(0);
        expect(store.requireSession(started.session.id).state).toBe("recovery_required");
      } finally {
        Object.defineProperty(store, "readMutationProviderAuthorities", { configurable: true, value: readAuthorities });
        await restarted.close();
      }
      expect(readAuthorities(attempt.id)).toEqual(original);
    }),
  );
test("rejects noncausal recovery proof and releases an unbound start only by explicit abandon", async () => {
    const { service, codex, documents, store } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Abandon start" }, { signal }) as { account: { id: string } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    await service.execute({ kind: "project.add", label: "Docs", path: documents }, { signal });
    codex.startSessionError = new IndeterminateCodexEffectError("thread/start", 45);
    const key = "00000000-0000-4000-8000-000000000407";
    await expect(service.execute({ kind: "session.start", account: added.account.id, preset: "high", presetContract: 2, fast: false, idempotencyKey: key }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED", details: { idempotencyKey: key } });
    const [session] = store.listSessions();
    if (session === undefined) throw new Error("Expected a bound start placeholder.");
    expect(await service.execute({ kind: "session.recover", session: session.id }, { signal }).catch((error: unknown) => error)).toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(await service.execute({ kind: "session.abandon", session: session.id }, { signal })).toMatchObject({
      idempotencyKey: key,
      session: { state: "terminal" },
      recovery: { resolution: "abandoned", providerEffectRetried: false, providerStateDeleted: false },
    });
    expect(store.readMutation(key)).toMatchObject({ state: "reconciled", originalState: "ambiguous", resolution: { kind: "abandoned" } });
    await expect(service.execute({ kind: "session.start", account: added.account.id, preset: "high", presetContract: 2, fast: false, idempotencyKey: key }, { signal })).rejects.toMatchObject({ code: "CONFLICT" });
    delete codex.startSessionError;
    expect(await service.execute({ kind: "session.start", account: added.account.id, preset: "high", presetContract: 2, fast: false, idempotencyKey: "00000000-0000-4000-8000-000000000408" }, { signal })).toMatchObject({ session: { state: "idle" } });
    expect(codex.calls.filter((call) => call.startsWith("start:"))).toHaveLength(2);
  });
test("reconciles an unsettled-free system error through one exact read and no provider write", async () => {
    const { service, codex, documents, store } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Status recovery" }, { signal }) as { account: { id: string } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    await service.execute({ kind: "project.add", label: "Docs", path: documents }, { signal });
    const started = await service.execute({ presetContract: currentPresetContract, kind: "session.start", account: added.account.id, preset: "high", fast: false }, { signal }) as { session: { id: `sess_${string}`; providerThreadId: string } };
    const authority = liveAuthorityFor(store, added.account.id as `acct_${string}`);
    await service.observeCodexFact(authority, { type: "threadStatusChanged", threadId: started.session.providerThreadId, status: { type: "systemError" } });
    expect(store.requireSession(started.session.id)).toMatchObject({ state: "recovery_required" });
    expect(store.listUnsettledMutations({ sessionId: started.session.id })).toHaveLength(0);
    expect(store.listUnsettledQueueEffects(started.session.id)).toHaveLength(0);
    codex.readProjection = { ...codex.readProjection, title: "Recovered exact state", status: "idle", providerUpdatedAt: 12 };
    const providerWritesBefore = codex.calls.filter((call) => call === "send" || call === "steer" || call === "stop" || call === "rename").length;

    expect(await service.execute({ kind: "session.recover", session: started.session.id }, { signal })).toMatchObject({
      session: { state: "idle", title: "Recovered exact state", providerUpdatedAt: 12 },
      recovery: { resolved: true, resolution: "provider_state_reconciled", providerEffectRetried: false },
    });
    expect(codex.calls.filter((call) => call === "send" || call === "steer" || call === "stop" || call === "rename")).toHaveLength(providerWritesBefore);
  });
test("continues a pending queue after recovery restores an idle session", async () => {
    const { service, codex, documents, store } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Recovery queue" }, { signal }) as { account: { id: string } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    await service.execute({ kind: "project.add", label: "Docs", path: documents }, { signal });
    const started = await service.execute({ kind: "session.start", account: added.account.id, preset: "high", presetContract: 2, fast: false }, { signal }) as { session: { id: `sess_${string}`; providerThreadId: string } };
    const pending = store.enqueue(started.session.id, "continue after recovery");
    const authority = liveAuthorityFor(store, added.account.id as `acct_${string}`);
    await service.observeCodexFact(authority, { type: "threadStatusChanged", threadId: started.session.providerThreadId, status: { type: "systemError" } });
    codex.readProjection = { ...codex.readProjection, status: "idle", providerUpdatedAt: 12 };

    expect(await service.execute({ kind: "session.recover", session: started.session.id }, { signal })).toMatchObject({
      session: { state: "idle" },
      recovery: { resolution: "provider_state_reconciled", providerEffectRetried: false },
    });
    await service.settled();
    expect(store.requireQueue(pending.id)).toMatchObject({ state: "applied" });
    expect(codex.calls.filter((call) => call === "send")).toHaveLength(1);
  });
test("explicitly abandons an unsettled-free status quarantine without reading or deleting provider state", async () => {
    const { service, codex, documents, store } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Status abandon" }, { signal }) as { account: { id: string } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    await service.execute({ kind: "project.add", label: "Docs", path: documents }, { signal });
    const started = await service.execute({ kind: "session.start", account: added.account.id, preset: "high", presetContract: 2, fast: false }, { signal }) as { session: { id: `sess_${string}`; providerThreadId: string } };
    const pending = store.enqueue(started.session.id, "never dispatched");
    const authority = liveAuthorityFor(store, added.account.id as `acct_${string}`);
    await service.observeCodexFact(authority, { type: "threadStatusChanged", threadId: started.session.providerThreadId, status: { type: "systemError" } });
    const readsBefore = codex.calls.filter((call) => call === "read").length;

    expect(await service.execute({ kind: "session.abandon", session: started.session.id }, { signal })).toMatchObject({
      session: { state: "terminal" },
      recovery: { resolved: true, resolution: "abandoned", providerEffectRetried: false, providerStateDeleted: false },
    });
    expect(store.requireQueue(pending.id)).toMatchObject({ state: "cancelled" });
    expect(codex.calls.filter((call) => call === "read")).toHaveLength(readsBefore);
  });
test("abandons quarantined legacy queue authority locally without a provider read", async () => {
    const value = await fixture();
    const { service, codex, store, paths } = value;
    const { sessionId } = await createIdleSession(value, "Legacy queue abandon");
    const pending = store.enqueue(sessionId, "cancel locally");
    const ambiguous = store.enqueue(sessionId, "preserve ambiguous evidence");
    const injector = new Database(paths.database, { create: false, strict: true });
    try {
      injector.query(
        `INSERT INTO legacy_provider_authority_quarantines(
           scope_kind,scope_id,reason,recorded_at
         ) VALUES ('queue',?,'unsettled_provider_authority_unproved',?)`,
      ).run(pending.id, Date.now());
      injector.query(
        `INSERT INTO legacy_provider_authority_quarantines(
           scope_kind,scope_id,reason,recorded_at
         ) VALUES ('queue',?,'unsettled_provider_authority_unproved',?)`,
      ).run(ambiguous.id, Date.now());
      injector.query(
        "UPDATE queue_entries SET state='dispatching' WHERE id=?",
      ).run(ambiguous.id);
      injector.query(
        "UPDATE queue_entries SET state='ambiguous' WHERE id=?",
      ).run(ambiguous.id);
    } finally {
      injector.close(false);
    }
    store.quarantineSession(sessionId);
    const readsBefore = codex.calls.filter((call) => call === "read").length;

    await expect(service.execute({
      kind: "session.recover",
      session: sessionId,
    }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(codex.calls.filter((call) => call === "read")).toHaveLength(readsBefore);
    await expect(service.execute({
      kind: "session.abandon",
      session: sessionId,
    }, { signal })).resolves.toMatchObject({
      session: { state: "terminal" },
      recovery: {
        resolved: true,
        resolution: "abandoned",
        providerEffectRetried: false,
        providerStateDeleted: false,
      },
    });
    expect(store.requireQueue(pending.id)).toMatchObject({ state: "cancelled" });
    expect(store.requireQueue(ambiguous.id)).toMatchObject({ state: "ambiguous" });
    expect(codex.calls.filter((call) => call === "read")).toHaveLength(readsBefore);
  });
test("reports a committed scrub quarantine and stops only after the local response boundary", async () => {
    let stopRequests = 0;
    const value = await fixture(new FakeCloud(), () => { stopRequests += 1; }, undefined, undefined,
      { securityScrubCheckpoint: shortScrubCheckpoint },
    );
    const { sessionId } = await createIdleSession(value, "Committed scrub quarantine");
    const pending = value.store.enqueue(sessionId, "PINNED_SERVICE_QUEUE_BODY_SENTINEL");
    value.store.quarantineSession(sessionId);
    const pinnedReader = new Database(value.paths.database, { readonly: true, strict: true });
    pinnedReader.exec("BEGIN");
    expect(pinnedReader.query(
      "SELECT message FROM queue_entries WHERE id=?",
    ).get(pending.id)).toEqual({ message: "PINNED_SERVICE_QUEUE_BODY_SENTINEL" });
    const afterResponse: Array<() => void> = [];
    try {
      await expect(value.service.execute({
        kind: "session.abandon",
        session: sessionId,
      }, {
        signal,
        afterResponse: (callback) => afterResponse.push(callback),
      })).rejects.toMatchObject({
        code: "UNAVAILABLE",
        details: { operationCommitted: true },
      });
      expect(stopRequests).toBe(0);
      expect(value.store.requireSession(sessionId)).toMatchObject({ state: "terminal" });
      expect(value.store.requireQueue(pending.id)).toMatchObject({
        message: "[queue message removed after settlement]",
        state: "cancelled",
      });
      expect(afterResponse).toHaveLength(1);
      afterResponse[0]?.();
      expect(stopRequests).toBe(1);
    } finally {
      pinnedReader.exec("COMMIT");
      pinnedReader.close(false);
    }
    expect(value.store.transitionQueue(pending.id, "pending", "cancelled")).toBe(false);
  });
test("keeps a lost send ambiguous when client-id or revision proof is tampered", async () => {
    const { service, codex, documents, store } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Tamper proof" }, { signal }) as { account: { id: string } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    await service.execute({ kind: "project.add", label: "Docs", path: documents }, { signal });
    const started = await service.execute({ kind: "session.start", account: added.account.id, preset: "high", presetContract: 2, fast: false }, { signal }) as { session: { id: `sess_${string}` } };
    codex.startTurnError = new IndeterminateCodexEffectError("turn/start", 46);
    const key = "00000000-0000-4000-8000-000000000409";
    await expect(service.execute({ kind: "session.send", session: started.session.id, message: "tamper", idempotencyKey: key }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    delete codex.startTurnError;
    const actual = codex.readProjection;
    codex.readProjection = { ...actual, providerUpdatedAt: 10, messages: (actual.messages ?? []).map((message) => message.role === "user" ? { ...message, clientId: "wrong-client" } : message) };
    await expect(service.execute({ kind: "session.recover", session: started.session.id }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(store.readMutation(key)).toMatchObject({ state: "ambiguous" });
    expect(store.requireSession(started.session.id)).toMatchObject({ state: "recovery_required" });

    const attempt = store.readMutation(key);
    if (
      attempt?.evidence?.evidence.kind !== "session.send"
      && attempt?.evidence?.evidence.kind !== "session.steer"
    ) throw new Error("Expected unsettled message evidence.");
    const clientMessageId = attempt.evidence.evidence.clientMessageId;
    codex.readProjection = {
      ...actual,
      providerUpdatedAt: 10,
      messages: [
        {
          clientId: clientMessageId,
          role: "user",
          text: "tamper",
          turnId: "turn-next",
        },
        {
          clientId: clientMessageId,
          role: "user",
          text: "different body under the same client id",
        },
      ],
    };
    await expect(service.execute({
      kind: "session.recover",
      session: started.session.id,
    }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(store.readMutation(key)).toMatchObject({ state: "ambiguous" });
  });
test("keeps a lost steer ambiguous when one client id names multiple messages", async () => {
    const { service, codex, documents, store } = await fixture();
    const added = await service.execute({
      kind: "account.add",
      label: "Steer equivocation",
    }, { signal }) as { account: { id: string } };
    await service.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: false,
    }, { signal });
    await service.execute({ kind: "project.add", label: "Docs", path: documents }, { signal });
    const started = await service.execute({
      kind: "session.start",
      account: added.account.id,
      preset: "high",
      presetContract: currentPresetContract,
      fast: false,
    }, { signal }) as { session: { id: `sess_${string}` } };
    await service.execute({
      kind: "session.send",
      session: started.session.id,
      message: "start",
    }, { signal });

    const key = "00000000-0000-4000-8000-00000000040a";
    codex.steerError = new IndeterminateCodexEffectError("turn/steer", 48);
    await expect(service.execute({
      idempotencyKey: key,
      kind: "session.steer",
      message: "redirect",
      session: started.session.id,
    }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    delete codex.steerError;
    const attempt = store.readMutation(key);
    if (attempt?.evidence?.evidence.kind !== "session.steer") {
      throw new Error("Expected unsettled steer evidence.");
    }
    codex.readProjection = {
      ...codex.readProjection,
      messages: [
        ...(codex.readProjection.messages ?? []),
        {
          clientId: attempt.evidence.evidence.clientMessageId,
          role: "user",
          text: "different body under the same client id",
        },
      ],
    };

    await expect(service.execute({
      kind: "session.recover",
      session: started.session.id,
    }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(store.readMutation(key)).toMatchObject({ state: "ambiguous" });
    expect(codex.calls.filter((call) => call === "steer")).toHaveLength(1);
  });
test("schedules recoverable idle queues without awaiting provider dispatch before readiness", async () => {
    const { service, codex, documents, store } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Queue readiness" }, { signal }) as { account: { id: string } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    await service.execute({ kind: "project.add", label: "Docs", path: documents }, { signal });
    const started = await service.execute({ kind: "session.start", account: added.account.id, preset: "high", presetContract: 2, fast: false }, { signal }) as { session: { id: `sess_${string}` } };
    store.enqueue(started.session.id, "resume in background");
    let releaseDispatch!: () => void;
    const dispatchGate = new Promise<void>((resolve) => { releaseDispatch = resolve; });
    codex.beforeStartTurnReturn = async () => await dispatchGate;

    const readiness = await Promise.race([
      service.recover().then(() => "ready" as const),
      new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 100)),
    ]);
    expect(readiness).toBe("ready");
    releaseDispatch();
    await service.settled();
    expect(store.listQueue(started.session.id)[0]).toMatchObject({ state: "applied" });
  });
test("pages recovery across the session quota and bounds eager active observations", () => ownedServiceCase(async ({ createFixture, signal }) => {
    const { service, codex, documents, store } = await createFixture();
    signal.throwIfAborted();
    const added = await service.execute({
      kind: "account.add",
      label: "Paged active recovery",
    }, { signal }) as { account: { id: `acct_${string}` } };
    signal.throwIfAborted();
    await service.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: false,
    }, { signal });
    signal.throwIfAborted();
    const project = await service.execute({
      kind: "project.add",
      label: "Paged recovery docs",
      path: documents,
    }, { signal }) as { project: { id: `proj_${string}` } };
    signal.throwIfAborted();
    const created = Array.from({ length: 103 }, (_, index) => {
      const active = index >= 100;
      const session = store.upsertProviderSession({
        providerAuthority: store.requireProviderAccountAuthority(added.account.id, "codex"),
        profileId: added.account.id,
        projectId: project.project.id,
        provider: "codex",
        providerThreadId: `provider-recovery-${String(index)}`,
        title: `Recovery ${String(index)}`,
        preset: "high",
        fastEnabled: false,
        state: active ? "active" : "idle",
        ...(active ? { activeTurnId: `turn-${String(index)}` } : {}),
        providerAccountKey: codexProviderAccountKey(),
      });
      return { active, index, session };
    }).toSorted((left, right) => left.session.id.localeCompare(right.session.id));
    codex.beforeObserveReturn = async () => await Bun.sleep(2);

    signal.throwIfAborted();
    const readiness = await Promise.race([
      service.recover().then(() => "ready" as const),
      new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 100)),
    ]);
    expect(readiness).toBe("ready");
    signal.throwIfAborted();
    await service.settled();
    signal.throwIfAborted();
    for (const { active, index } of created.filter((entry) => entry.active)) {
      expect(codex.observedThreads).toContain(`provider-recovery-${String(index)}`);
      expect(active).toBe(true);
    }
    expect(codex.maximumConcurrentObservations).toBe(1);
  }));
test("dispatches a durable queue immediately for an idle session", async () => {
    const { service, codex, documents, store } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Idle queue" }, { signal }) as { account: { id: string } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    await service.execute({ kind: "project.add", label: "Docs", path: documents }, { signal });
    const started = await service.execute({ kind: "session.start", account: added.account.id, preset: "high", presetContract: 2, fast: false }, { signal }) as { session: { id: `sess_${string}` } };
    await service.execute({ kind: "session.queue", session: started.session.id, message: "dispatch now" }, { signal });
    await service.settled();
    expect(store.listQueue(started.session.id)[0]).toMatchObject({ state: "applied" });
    expect(store.requireSession(started.session.id)).toMatchObject({ state: "active", activeTurnId: "turn-next" });
    expect(codex.calls.filter((call) => call === "send")).toHaveLength(1);
    expect(store.listSessionEvents({
      afterSequence: 0,
      sessionId: started.session.id,
    }).events.some((event) => event.body.type === "user_message"
      && event.body.actor === "human"
      && event.body.text === "dispatch now")).toBe(true);
  });
test("stops after a committed queued turn scrub failure without inventing ambiguity", async () => {
    let stopRequests = 0;
    const value = await fixture(new FakeCloud(), () => { stopRequests += 1; }, undefined, undefined,
      { securityScrubCheckpoint: shortScrubCheckpoint },
    );
    const { sessionId } = await createIdleSession(value, "Queued scrub quarantine");
    let releaseProvider!: () => void;
    let signalProviderApplied!: () => void;
    const providerGate = new Promise<void>((resolve) => { releaseProvider = resolve; });
    const providerApplied = new Promise<void>((resolve) => { signalProviderApplied = resolve; });
    value.codex.beforeStartTurnReturn = async () => {
      signalProviderApplied();
      await providerGate;
    };
    const result = await value.service.execute({
      kind: "session.queue",
      session: sessionId,
      message: "PINNED_BACKGROUND_QUEUE_BODY_SENTINEL",
    }, { signal }) as { queued: { id: `queue_${string}` } };
    await providerApplied;

    const pinnedReader = new Database(value.paths.database, { readonly: true, strict: true });
    pinnedReader.exec("BEGIN");
    expect(pinnedReader.query(
      "SELECT message,state FROM queue_entries WHERE id=?",
    ).get(result.queued.id)).toEqual({
      message: "PINNED_BACKGROUND_QUEUE_BODY_SENTINEL",
      state: "dispatching",
    });
    try {
      releaseProvider();
      await value.service.settled();
      expect(stopRequests).toBe(1);
      expect(value.store.requireQueue(result.queued.id)).toMatchObject({
        message: "[queue message removed after settlement]",
        state: "applied",
      });
      expect(value.store.requireSession(sessionId).state).not.toBe("recovery_required");
      expect(value.store.listUnsettledQueueEffects(sessionId)).toEqual([]);
    } finally {
      pinnedReader.exec("COMMIT");
      pinnedReader.close(false);
    }
    expect(value.store.transitionQueue(result.queued.id, "dispatching", "applied")).toBe(false);
  });
test("stops when a deterministic queued turn failure commits but its scrub cannot finish", async () => {
    let stopRequests = 0;
    const value = await fixture(new FakeCloud(), () => { stopRequests += 1; }, undefined, undefined,
      { securityScrubCheckpoint: shortScrubCheckpoint },
    );
    const { sessionId } = await createIdleSession(value, "Failed queue scrub quarantine");
    let releaseProvider!: () => void;
    let signalProviderEntered!: () => void;
    const providerGate = new Promise<void>((resolve) => { releaseProvider = resolve; });
    const providerEntered = new Promise<void>((resolve) => { signalProviderEntered = resolve; });
    value.codex.startTurnErrorOnce = new Error("Deterministic provider turn rejection.");
    value.codex.beforeStartTurnEffect = async () => {
      signalProviderEntered();
      await providerGate;
    };
    const result = await value.service.execute({
      kind: "session.queue",
      session: sessionId,
      message: "PINNED_FAILED_QUEUE_BODY_SENTINEL",
    }, { signal }) as { queued: { id: `queue_${string}` } };
    await providerEntered;

    const pinnedReader = new Database(value.paths.database, { readonly: true, strict: true });
    pinnedReader.exec("BEGIN");
    expect(pinnedReader.query(
      "SELECT message,state FROM queue_entries WHERE id=?",
    ).get(result.queued.id)).toEqual({
      message: "PINNED_FAILED_QUEUE_BODY_SENTINEL",
      state: "dispatching",
    });
    try {
      releaseProvider();
      await value.service.settled();
      expect(stopRequests).toBe(1);
      expect(value.store.requireQueue(result.queued.id)).toMatchObject({
        message: "[queue message removed after settlement]",
        state: "failed",
      });
      expect(value.store.requireSession(sessionId).state).toBe("idle");
      expect(value.store.listUnsettledQueueEffects(sessionId)).toEqual([]);
    } finally {
      pinnedReader.exec("COMMIT");
      pinnedReader.close(false);
    }
    expect(value.store.transitionQueue(result.queued.id, "dispatching", "failed")).toBe(false);
  });
test("recovers a crash-adjacent dispatch as ambiguous without replaying it", async () => {
    const { service, codex, documents, store } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Queue recovery" }, { signal }) as { account: { id: string } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    await service.execute({ kind: "project.add", label: "Docs", path: documents }, { signal });
    const started = await service.execute({ kind: "session.start", account: added.account.id, preset: "high", presetContract: 2, fast: false }, { signal }) as { session: { id: `sess_${string}` } };
    const queued = store.enqueue(started.session.id, "uncertain");
    store.beginQueueEffect({
      queueId: queued.id,
      sessionId: started.session.id,
      profileGeneration: 1,
      providerAuthority: store.requireProviderAccountAuthority(
        added.account.id as `acct_${string}`,
        "codex",
      ),
      providerConnectionId: "10000000-0000-4000-8000-000000000003",
      evidence: {
        kind: "queue.dispatch",
        queueId: queued.id,
        sessionId: started.session.id,
        providerThreadId: "provider-thread",
        profileGeneration: 1,
        baseline: { providerUpdatedAt: 10, status: "idle", activeTurnId: null },
        clientMessageId: queued.id,
        messageDigest: createHash("sha256").update("uncertain").digest("hex"),
        runtimeProfile: runtimeProfile(liveAuthorityFor(store, added.account.id as `acct_${string}`)),
      },
    });
    await service.recover();
    expect(store.requireQueue(queued.id)).toMatchObject({ state: "ambiguous" });
    expect(store.requireSession(started.session.id)).toMatchObject({ state: "recovery_required" });
    expect(codex.calls.filter((call) => call === "send")).toHaveLength(0);
  });
test("causally recovers an ambiguous queued dispatch with its reviewed runtime profile", async () => {
    const { service, codex, documents, store, paths } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Queue causal recovery" }, { signal }) as { account: { id: string } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    await service.execute({ kind: "project.add", label: "Docs", path: documents }, { signal });
    const started = await service.execute({ kind: "session.start", account: added.account.id, preset: "high", presetContract: 2, fast: false }, { signal }) as { session: { id: `sess_${string}`; providerThreadId: string } };
    codex.startTurnError = new IndeterminateCodexEffectError("turn/start", 47);
    const queued = await service.execute({ kind: "session.queue", session: started.session.id, message: "uncertain queue" }, { signal }) as { queued: { id: `queue_${string}` } };
    await service.settled();
    expect(store.requireQueue(queued.queued.id)).toMatchObject({ state: "ambiguous" });
    expect(store.requireSession(started.session.id)).toMatchObject({ state: "recovery_required" });
    delete codex.startTurnError;
    const complete = {
      ...codex.readProjection,
      providerUpdatedAt: 10,
    };
    const omission = complete.omission;
    const exactMessage = complete.messages?.find((message) => message.clientId === queued.queued.id);
    if (omission === undefined || exactMessage === undefined) throw new Error("Expected the fake's exact committed queue projection.");
    const absentCompleteness = { ...complete };
    delete absentCompleteness.omission;
    const variants: readonly CodexSessionProjection[] = [
      absentCompleteness,
      { ...complete, messages: [] },
      { ...complete, omission: { ...omission, incompleteTurnIds: ["synthetic-incomplete-turn"] } },
      { ...complete, omission: { ...omission, truncatedMessages: 1 } },
      { ...complete, messages: [...(complete.messages ?? []), { ...exactMessage }] },
      { ...complete, messages: (complete.messages ?? []).map((message) => message === exactMessage
        ? { ...message, text: "different queue body under the same client id" } : message) },
      { ...complete, messages: (complete.messages ?? []).map((message) => message === exactMessage
        ? { ...message, omission: {
          omittedUtf8Bytes: 1,
          originalUtf8Bytes: new TextEncoder().encode(message.text).byteLength + 1,
          returnedUtf8Bytes: new TextEncoder().encode(message.text).byteLength,
        } } : message) },
    ];
    const requestedDetails: boolean[] = [];
    const port: CodexRuntimePort = codex;
    const read = port.readSession.bind(port);
    port.readSession = async (input) => {
      requestedDetails.push(input.detail);
      return await read(input);
    };
    const snapshot = () => {
      const database = new Database(paths.database, { strict: true });
      try {
        database.exec("PRAGMA query_only=ON");
        return database.transaction(() => ({
          schema: database.query("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name").all(),
          tables: database.query<{ name: string }, []>("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all()
            .map(({ name }) => {
              if (!/^[A-Za-z0-9_]+$/u.test(name)) throw new Error("Unexpected fixture table name.");
              const rows = database.query(`SELECT * FROM "${name}" LIMIT 4097`).all();
              if (rows.length > 4096) throw new Error("Queue recovery fixture exceeded row bound.");
              return { name, rows: rows.map((row) => JSON.stringify(row)).sort() };
            }),
        })).deferred();
      } finally { database.close(false); }
    };
    const before = snapshot();
    const providerWrites = providerMutationCalls(codex);
    for (const projection of variants) {
      codex.readProjection = projection;
      await expect(service.execute({ kind: "session.recover", session: started.session.id }, { signal }))
        .rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
      expect(requestedDetails.splice(0)).toEqual([true]);
      expect(store.readQueueEffect(queued.queued.id)?.resolution).toBeUndefined();
      expect(snapshot()).toEqual(before);
      expect(providerMutationCalls(codex)).toEqual(providerWrites);
    }
    codex.readProjection = complete;

    expect(await service.execute({ kind: "session.recover", session: started.session.id }, { signal })).toMatchObject({
      queueId: queued.queued.id,
      session: { state: "active", activeTurnId: "turn-next" },
      recovery: { resolution: "proven_applied", providerEffectRetried: false },
    });
    expect(requestedDetails.splice(0)).toEqual([true]);
    expect(store.readQueueEffect(queued.queued.id)).toMatchObject({ resolution: { kind: "proven_applied" } });
    expect(store.latestSessionRuntimeProfile(started.session.id)).toMatchObject({ revision: 2, sourceKind: "queue_start", sourceId: queued.queued.id });
    expect(codex.calls.filter((call) => call === "send")).toHaveLength(1);
    const recoveredMessages = store.listSessionEvents({
      afterSequence: 0,
      sessionId: started.session.id,
    }).events.filter((event) => event.body.type === "user_message"
      && event.body.sourceId === queued.queued.id);
    expect(recoveredMessages).toHaveLength(1);
    expect(recoveredMessages[0]?.body).toMatchObject({
      actor: "human",
      sourceId: queued.queued.id,
      text: "uncertain queue",
      type: "user_message",
    });
    const authority = liveAuthorityFor(store, added.account.id as `acct_${string}`);
    await service.observeCodexFact(authority, { type: "threadStatusChanged", threadId: started.session.providerThreadId, status: { type: "systemError" } });
    expect(await service.execute({ kind: "session.recover", session: started.session.id }, { signal })).toMatchObject({
      recovery: { resolution: "provider_state_reconciled" },
    });
  });
test("abandons an ambiguous queued dispatch using metadata without claiming a complete message set", async () => {
    const value = await fixture();
    const { service, store, codex } = value;
    const { sessionId } = await createIdleSession(value, "Queue metadata abandonment");
    codex.startTurnError = new IndeterminateCodexEffectError("turn/start", 48);
    const queued = await service.execute({
      kind: "session.queue", session: sessionId, message: "Uncertain metadata-only abandonment",
    }, { signal }) as { queued: { id: `queue_${string}` } };
    await service.settled();
    expect(store.requireQueue(queued.queued.id).state).toBe("ambiguous");
    const original = store.readQueueEffect(queued.queued.id);
    const providerWrites = providerMutationCalls(codex);
    codex.readProjection = {
      providerThreadId: codex.readProjection.providerThreadId,
      title: codex.readProjection.title,
      status: "idle",
    };
    const details: boolean[] = [];
    const port: CodexRuntimePort = codex;
    const read = port.readSession.bind(port);
    port.readSession = async (input) => { details.push(input.detail); return await read(input); };
    await expect(service.execute({ kind: "session.abandon", session: sessionId }, { signal }))
      .resolves.toMatchObject({ queueId: queued.queued.id,
        recovery: { resolution: "abandoned", providerEffectRetried: false, providerStateDeleted: false } });
    expect(details).toEqual([false]);
    expect(store.readQueueEffect(queued.queued.id)).toMatchObject({ resolution: { kind: "abandoned" } });
    expect(store.readQueueEffect(queued.queued.id)?.evidence).toEqual(original?.evidence);
    expect(store.listSessionEvents({ sessionId, afterSequence: 0 }).events
      .filter((event) => event.body.type === "user_message" && event.body.sourceId === queued.queued.id)).toEqual([]);
    expect(providerMutationCalls(codex)).toEqual(providerWrites);
  });
test("reconciles a retired-generation queued dispatch after daemon rollover without replay", async () => {
    const value = await fixture();
    const { service, codex, documents, store } = value;
    const added = await service.execute({ kind: "account.add", label: "Rollover queue" }, { signal }) as { account: { id: `acct_${string}` } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    await service.execute({ kind: "project.add", label: "Rollover queue docs", path: documents }, { signal });
    const started = await service.execute({ presetContract: currentPresetContract, kind: "session.start", account: added.account.id, preset: "high", fast: false }, { signal }) as { session: { id: `sess_${string}` } };
    codex.startTurnError = new IndeterminateCodexEffectError("turn/start", 47);
    const queued = await service.execute({ kind: "session.queue", session: started.session.id, message: "queue across rollover" }, { signal }) as { queued: { id: `queue_${string}` } };
    await service.settled();
    const capturedQueueAuthority = store.readQueueProviderAuthority(queued.queued.id);
    const providerProjection = codex.readProjection;

    const daemonGeneration = store.nextDaemonGeneration(`boot_${"e".repeat(32)}`);
    expect(store.readQueueProviderAuthority(queued.queued.id)).toEqual(capturedQueueAuthority);
    const restartedCodex = new FakeCodex();
    restartedCodex.readProjection = { ...providerProjection, providerUpdatedAt: 10 };
    const restarted = new OompaService({
      store,
      paths: value.paths,
      codex: restartedCodex,
      cloud: new FakeCloud(),
      daemonAuthority: new FakeDaemonAuthority(),
      daemonGeneration,
      requestStop: () => undefined,
    });
    await restarted.recover();
    expect(restartedCodex.calls.filter((call) => call === "send")).toHaveLength(0);

    await expect(restarted.execute({ kind: "session.recover", session: started.session.id }, { signal }))
      .resolves.toMatchObject({
        queueId: queued.queued.id,
        session: { state: "active", activeTurnId: "turn-next" },
        recovery: { resolution: "proven_applied", providerEffectRetried: false },
      });
    expect(store.readQueueEffect(queued.queued.id)).toMatchObject({
      resolution: { kind: "proven_applied" },
    });
    expect(store.readQueueProviderAuthority(queued.queued.id)).toEqual(capturedQueueAuthority);
    expect(restartedCodex.calls.filter((call) => call === "send")).toHaveLength(0);
    expect(restartedCodex.calls.filter((call) => call === "read")).toHaveLength(1);
    await restarted.close();
  });
test("rejects signed-out runtime effects before creating sessions or usage observations", async () => {
    const { service, documents, store, codex } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Signed out" }, { signal }) as { account: { id: string } };
    await service.execute({ kind: "project.add", label: "Docs", path: documents }, { signal });
    await expect(service.execute({ kind: "session.start", account: added.account.id, preset: "high", presetContract: 2, fast: false }, { signal })).rejects.toMatchObject({ code: "INTERACTION_REQUIRED" });
    await expect(service.execute({ kind: "account.usage", account: added.account.id, refresh: true }, { signal })).rejects.toMatchObject({ code: "INTERACTION_REQUIRED" });
    expect(store.listSessions()).toHaveLength(0);
    expect(codex.calls).toHaveLength(0);
  });
test("removes an unused local placeholder after a determinate provider start rejection", async () => {
    const { service, documents, store, codex } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Rejected start" }, { signal }) as { account: { id: string } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    await service.execute({ kind: "project.add", label: "Docs", path: documents }, { signal });
    codex.startSessionError = new Error("provider rejected before creating a thread");

    await expect(service.execute({ kind: "session.start", account: added.account.id, preset: "high", presetContract: 2, fast: false }, { signal })).rejects.toThrow("provider rejected");

    expect(store.listSessions()).toHaveLength(0);
    expect(codex.calls.filter((call) => call.startsWith("start:"))).toHaveLength(1);
  });
test("binds an idle steer key so it cannot steer a future turn", async () => {
    const { service, documents, store, codex } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Idle steer" }, { signal }) as { account: { id: string } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    await service.execute({ kind: "project.add", label: "Docs", path: documents }, { signal });
    const started = await service.execute({ kind: "session.start", account: added.account.id, preset: "high", presetContract: 2, fast: false }, { signal }) as { session: { id: string } };
    const idempotencyKey = "00000000-0000-4000-8000-000000000108";
    const steer = { kind: "session.steer" as const, session: started.session.id, message: "future", idempotencyKey };
    await expect(service.execute(steer, { signal })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(store.readMutation(idempotencyKey)).toMatchObject({ state: "failed" });
    await service.execute({ kind: "session.send", session: started.session.id, message: "now" }, { signal });
    await expect(service.execute(steer, { signal })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(codex.calls.filter((call) => call === "steer")).toHaveLength(0);
  });
test("a determinate queued dispatch failure is terminal without quarantining the session", async () => {
    const { service, documents, store, codex } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Queue failure" }, { signal }) as { account: { id: string } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    await service.execute({ kind: "project.add", label: "Docs", path: documents }, { signal });
    const started = await service.execute({ kind: "session.start", account: added.account.id, preset: "high", presetContract: 2, fast: false }, { signal }) as { session: { id: `sess_${string}` } };
    codex.startTurnError = new Error("provider rejected before effect");
    await service.execute({ kind: "session.queue", session: started.session.id, message: "will fail" }, { signal });
    await service.settled();
    expect(store.listQueue(started.session.id)[0]).toMatchObject({ state: "failed" });
    expect(store.requireSession(started.session.id)).toMatchObject({ state: "idle" });
  });
test("replays logout without contacting Codex twice", async () => {
    const { service, codex } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Logout replay" }, { signal }) as { account: { id: string } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    const command = { kind: "account.logout" as const, account: added.account.id, idempotencyKey: "00000000-0000-4000-8000-000000000109" };
    await service.execute(command, { signal });
    expect(await service.execute(command, { signal })).toMatchObject({ account: { state: "signed_out" } });
    expect(codex.calls.filter((call) => call === "logout")).toHaveLength(1);
  });
test("retires the exact Codex client only after logout dispatch and requires a fresh generation to reconcile ambiguity", async () => {
    const value = await fixture();
    const { service, codex, documents, store, paths } = value;
    const added = await service.execute({ kind: "account.add", label: "Logout recovery" }, { signal }) as { account: { id: string } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    await service.execute({ kind: "project.add", label: "Docs", path: documents }, { signal });
    const started = await service.execute({ presetContract: currentPresetContract, kind: "session.start", account: added.account.id, preset: "high", fast: false }, { signal }) as { session: { id: string } };
    const seeded = await seedResolvableInteraction(
      value,
      started.session.id as `sess_${string}`,
      "ambiguous-logout-retirement",
    );
    const releasesBeforeLogout = codex.releasedAuthorities.length;
    codex.logoutError = new IndeterminateCodexEffectError("account/logout", 43);
    codex.beforeLogoutReturn = async () => {
      expect(codex.releasedAuthorities).toHaveLength(releasesBeforeLogout);
      expect(store.readProviderRuntimeAccountRevocation({
        profileId: added.account.id,
        provider: "codex",
        runtimeScope: "personal",
      })).toMatchObject({ currentAccountKey: null, state: "completed" });
      expect(store.readProviderRuntimeAccountRevocation({
        profileId: added.account.id,
        provider: "codex",
        runtimeScope: "managed",
      })).toMatchObject({ currentAccountKey: null, state: "releasing" });
    };
    const command = { kind: "account.logout" as const, account: added.account.id, idempotencyKey: "00000000-0000-4000-8000-000000000501" };

    await expect(service.execute(command, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    const quarantined = store.requireProfile(added.account.id);
    expect(quarantined).toMatchObject({ state: "recovery_required", processGeneration: 1, providerEmail: "person@example.com" });
    expect(store.requireInteraction(seeded.interaction.publicId).state).toBe("expired");
    const quarantinedEvents = store.listSessionEvents({
      sessionId: started.session.id as `sess_${string}`,
      afterSequence: 0,
      limit: 100,
    }).events;
    expect(quarantinedEvents.filter((event) =>
      event.body.type === "connection" && event.body.state === "disconnected"))
      .toHaveLength(1);
    expect(quarantinedEvents.filter((event) =>
      event.body.type === "gap" && event.body.reason === "provider_disconnect"))
      .toHaveLength(1);
    await service.observeCodexFact(seeded.authority, {
      type: "providerDisconnected",
      connectionId: seeded.interaction.authority.connectionId,
      reason: "closed",
    });
    await service.settled();
    expect(store.listSessionEvents({
      sessionId: started.session.id as `sess_${string}`,
      afterSequence: 0,
      limit: 100,
    }).events.filter((event) =>
      event.body.type === "connection" && event.body.state === "disconnected"))
      .toHaveLength(1);
    expect(store.setProfileState(quarantined.id, quarantined.processGeneration, "signed_in", { email: "notification@example.com" })).toBe(false);

    await expect(service.execute({ kind: "session.send", session: started.session.id, message: "blocked", idempotencyKey: "00000000-0000-4000-8000-000000000502" }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    await expect(service.execute({ kind: "account.logout", account: added.account.id, idempotencyKey: "00000000-0000-4000-8000-000000000503" }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(codex.calls.filter((call) => call === "send")).toHaveLength(0);
    expect(codex.calls.filter((call) => call === "logout")).toHaveLength(1);
    expect(codex.releasedAuthorities).toHaveLength(releasesBeforeLogout + 1);
    expect(store.readProviderRuntimeAccountRevocation({
      profileId: added.account.id,
      provider: "codex",
      runtimeScope: "managed",
    })).toMatchObject({ currentAccountKey: null, state: "completed" });

    delete codex.logoutError;
    delete codex.beforeLogoutReturn;
    await expect(service.execute({
      kind: "account.show",
      account: added.account.id,
    }, { signal })).resolves.toMatchObject({
      account: { state: "recovery_required", processGeneration: 1 },
      recovery: { required: true, cleared: false, restartRequired: true },
    });

    store.nextDaemonGeneration(`boot_${"9".repeat(32)}`);
    const restartedCodex = new FakeCodex();
    restartedCodex.accountProjection = {
      signedIn: true,
      email: "person@example.com",
      plan: "Pro",
    };
    const restarted = new OompaService({
      store,
      paths,
      codex: restartedCodex,
      cloud: new FakeCloud(),
      daemonAuthority: new FakeDaemonAuthority(),
      requestStop: () => undefined,
    });
    expect(await restarted.execute({
      kind: "account.show",
      account: added.account.id,
    }, { signal })).toMatchObject({
      account: { state: "signed_in", processGeneration: 2, providerEmail: "person@example.com" },
      providerProjection: { signedIn: true, email: "person@example.com" },
      recovery: { required: false, cleared: true, resolution: "provider_state_reconciled" },
    });
    await expect(restarted.execute(command, { signal })).rejects.toThrow("IDEMPOTENCY_CONFLICT");
    expect(store.requireProfile(added.account.id)).toMatchObject({ state: "signed_in" });
    expect(codex.calls.filter((call) => call === "logout")).toHaveLength(1);
    expect(restartedCodex.calls.filter((call) => call === "logout")).toHaveLength(0);
    expect(await restarted.execute({
      kind: "account.logout",
      account: added.account.id,
      idempotencyKey: "00000000-0000-4000-8000-000000000504",
    }, { signal })).toMatchObject({ account: { state: "signed_out", processGeneration: 2 } });
    expect(restartedCodex.calls.filter((call) => call === "logout")).toHaveLength(1);
  });
test("releases retained Codex logout custody despite request cancellation after dispatch", async () => {
    const { service, codex, store } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Canceled logout" }, { signal }) as { account: { id: string } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    const releasesBeforeLogout = codex.releasedAuthorities.length;
    const cancellation = new AbortController();
    codex.beforeLogoutReturn = async () => {
      expect(codex.releasedAuthorities).toHaveLength(releasesBeforeLogout);
      cancellation.abort(new Error("caller canceled after dispatch"));
    };

    await expect(service.execute({
      kind: "account.logout",
      account: added.account.id,
      idempotencyKey: "00000000-0000-4000-8000-000000000505",
    }, { signal: cancellation.signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });

    expect(codex.calls.filter((call) => call === "logout")).toHaveLength(1);
    expect(codex.releasedAuthorities).toHaveLength(releasesBeforeLogout + 1);
    expect(store.readProviderRuntimeAccountRevocation({
      profileId: added.account.id,
      provider: "codex",
      runtimeScope: "managed",
    })).toMatchObject({ currentAccountKey: null, state: "completed" });
    expect(store.requireProfile(added.account.id)).toMatchObject({ state: "recovery_required" });
  });
test("reconciles an ambiguous Codex logout as signed out after one real daemon generation advance", async () => {
    const { service, codex, store, paths } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Applied ambiguous logout" }, { signal }) as { account: { id: string } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    codex.logoutError = new IndeterminateCodexEffectError("account/logout", 44);

    await expect(service.execute({
      kind: "account.logout",
      account: added.account.id,
      idempotencyKey: "00000000-0000-4000-8000-000000000507",
    }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    const readsBeforeShow = codex.calls.filter((call) => call === "readAccount").length;
    await expect(service.execute({
      kind: "account.show",
      account: added.account.id,
    }, { signal })).resolves.toMatchObject({
      account: { state: "recovery_required", processGeneration: 1 },
      recovery: { required: true, cleared: false, restartRequired: true },
    });
    expect(codex.calls.filter((call) => call === "readAccount")).toHaveLength(readsBeforeShow);

    store.nextDaemonGeneration(`boot_${"8".repeat(32)}`);
    const restartedCodex = new FakeCodex();
    restartedCodex.accountProjection = { signedIn: false };
    const restarted = new OompaService({
      store,
      paths,
      codex: restartedCodex,
      cloud: new FakeCloud(),
      daemonAuthority: new FakeDaemonAuthority(),
      requestStop: () => undefined,
    });
    await expect(restarted.execute({
      kind: "account.show",
      account: added.account.id,
    }, { signal })).resolves.toMatchObject({
      account: { state: "signed_out", processGeneration: 2 },
      providerProjection: { signedIn: false },
      recovery: { required: false, cleared: true, resolution: "proven_applied" },
    });
  });
test("releases retained Codex custody when durable logout admission fails", async () => {
    let stopRequests = 0;
    const { service, codex, store } = await fixture(new FakeCloud(),
      () => { stopRequests += 1; },
    );
    const added = await service.execute({ kind: "account.add", label: "Rejected logout admission" }, { signal }) as { account: { id: string } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    const releasesBeforeLogout = codex.releasedAuthorities.length;
    const beginAccountMutationEffect = store.beginAccountMutationEffect.bind(store);
    store.beginAccountMutationEffect = ((input) => {
      if (input.evidence.kind === "account.logout") {
        throw new Error("injected logout admission failure");
      }
      return beginAccountMutationEffect(input);
    }) as StateStore["beginAccountMutationEffect"];

    await expect(service.execute({
      kind: "account.logout",
      account: added.account.id,
      idempotencyKey: "00000000-0000-4000-8000-000000000506",
    }, { signal })).rejects.toThrow("injected logout admission failure");

    expect(codex.calls.filter((call) => call === "logout")).toHaveLength(0);
    expect(codex.releasedAuthorities).toHaveLength(releasesBeforeLogout + 1);
    expect(store.readProviderRuntimeAccountRevocation({
      profileId: added.account.id,
      provider: "codex",
      runtimeScope: "managed",
    })).toMatchObject({ currentAccountKey: null, state: "completed" });
    expect(store.readMutation("00000000-0000-4000-8000-000000000506"))
      .toMatchObject({ state: "prepared" });
    await Bun.sleep(10);
    expect(stopRequests).toBe(1);
    await expect(service.execute({
      kind: "account.show",
      account: added.account.id,
    }, { signal })).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });
test("does not commit a provider turn after daemon authority becomes stale post-await", async () => {
    const { service, codex, daemonAuthority, documents, store } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Stale authority" }, { signal }) as { account: { id: `acct_${string}` } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    await service.execute({ kind: "project.add", label: "Documents", path: documents }, { signal });
    const started = await service.execute({ kind: "session.start", account: added.account.id, preset: "high", presetContract: 2, fast: false }, { signal }) as { session: { id: `sess_${string}` } };
    let releaseProvider!: () => void;
    let signalProviderApplied!: () => void;
    const providerGate = new Promise<void>((resolve) => { releaseProvider = resolve; });
    const providerApplied = new Promise<void>((resolve) => { signalProviderApplied = resolve; });
    codex.beforeStartTurnReturn = async () => {
      signalProviderApplied();
      await providerGate;
    };

    const sending = service.execute({ kind: "session.send", session: started.session.id, message: "must not commit" }, { signal });
    await providerApplied;
    daemonAuthority.invalidate();
    releaseProvider();

    await expect(sending).rejects.toBeInstanceOf(DaemonAuthoritySafetyError);
    expect(store.requireSession(started.session.id)).toMatchObject({ state: "idle" });
    expect(store.requireSession(started.session.id).activeTurnId).toBeUndefined();
    expect(store.latestSessionRuntimeProfile(started.session.id)).toMatchObject({ revision: 1, sourceKind: "session_start" });
    expect(store.listUnsettledMutations({ sessionId: started.session.id })).toEqual([
      expect.objectContaining({ kind: "session.send", state: "effect_started" }),
    ]);
    const recovered = store.recoverEffectStartedMutations();
    expect(recovered.unresolved).toEqual([]);
    expect(recovered.recovered).toHaveLength(1);
    expect(store.requireSession(started.session.id)).toMatchObject({ state: "recovery_required" });
    expect(store.listUnsettledMutations({ sessionId: started.session.id })).toEqual([
      expect.objectContaining({ kind: "session.send", state: "ambiguous" }),
    ]);
  });
test("projects subagent activity into the session event stream with opaque agent identity", async () => {
    const value = await fixture();
    const { sessionId } = await createIdleSession(value, "Subagent stream");
    const session = value.store.requireSession(sessionId);
    const profile = value.store.requireProfileById(session.profileId);
    if (session.providerThreadId === undefined) throw new Error("Expected a bound session.");
    const providerThreadId = session.providerThreadId;
    const authority = liveAuthorityFor(value.store, profile.id);
    const connectionId = value.codex.observationConnectionId;
    value.codex.observationConnectionId = connectionId;
    await value.service.observeCodexFact(authority, {
      type: "turnStarted",
      connectionId,
      threadId: providerThreadId,
      turn: { id: "turn-fanout", items: [], status: "inProgress", startedAt: 1, completedAt: null, durationMs: null },
    });
    await value.service.observeCodexFact(authority, {
      type: "subagentThreadStarted",
      connectionId,
      threadId: providerThreadId,
      agentThreadId: "thread-agent-1",
      depth: 1,
      nickname: "quiet-otter",
      role: "reviewer",
    });
    for (const kind of ["started", "interacted", "completed"] as const) {
      await value.service.observeCodexFact(authority, {
        type: "itemStarted",
        connectionId,
        threadId: providerThreadId,
        turnId: "turn-fanout",
        itemId: `activity-${kind}`,
        itemKind: "subAgentActivity",
        subagent: { agentThreadId: "thread-agent-1", kind },
      });
      await value.service.observeCodexFact(authority, {
        type: "itemCompleted",
        connectionId,
        threadId: providerThreadId,
        turnId: "turn-fanout",
        itemId: `activity-${kind}`,
        itemKind: "subAgentActivity",
        subagent: { agentThreadId: "thread-agent-1", kind },
      });
    }
    const page = await value.service.execute({
      kind: "session.events",
      session: sessionId,
      limit: 200,
      waitMs: 0,
    }, { signal }) as {
      events: Array<{ body: Record<string, unknown> }>;
    };
    const subagentEvents = page.events
      .map((event) => event.body)
      .filter((body) => body.type === "subagent_activity");
    expect(subagentEvents.map((body) => body.kind)).toEqual([
      "started",
      "started",
      "started",
      "interacted",
      "interacted",
      "completed",
      "completed",
    ]);
    const agentIds = new Set(subagentEvents.map((body) => body.agentId));
    expect(agentIds.size).toBe(1);
    for (const agentId of agentIds) expect(agentId).toMatch(/^opaque_v2_[a-f0-9]{64}$/u);
    expect(subagentEvents[0]).toMatchObject({ nickname: "quiet-otter", role: "reviewer", depth: 1 });
    expect(JSON.stringify(page.events)).not.toContain("thread-agent-1");
    // The marker items never leak as ordinary item rows.
    expect(page.events.some((event) => event.body.itemKind === "subAgentActivity")).toBe(false);
  });
test("exposes an atomic status cursor and wakes a bounded event tail without losing safe deltas", async () => {
    const value = await fixture();
    const { sessionId } = await createIdleSession(value, "Event stream");
    const session = value.store.requireSession(sessionId);
    const profile = value.store.requireProfileById(session.profileId);
    if (session.providerThreadId === undefined) throw new Error("Expected a bound session.");
    const authority = liveAuthorityFor(value.store, profile.id);
    const connectionId = value.codex.observationConnectionId;
    value.codex.observationConnectionId = connectionId;
    await value.service.observeCodexFact(authority, {
      type: "itemStarted",
      connectionId,
      threadId: session.providerThreadId,
      turnId: "turn-live",
      itemId: "item-live",
      itemKind: "commandExecution",
      liveAcceptanceCommandDigest: "a".repeat(64),
    });
    await value.service.observeCodexFact(authority, {
      type: "assistantDelta",
      connectionId,
      threadId: session.providerThreadId,
      turnId: "turn-live",
      itemId: "item-live",
      text: "Visible progress",
    });
    await value.service.observeCodexFact(authority, {
      type: "itemCompleted",
      connectionId,
      threadId: session.providerThreadId,
      turnId: "turn-live",
      itemId: "item-live",
      itemKind: "commandExecution",
      status: "completed",
      liveAcceptanceCommandDigest: "a".repeat(64),
    });
    const first = await value.service.execute({
      kind: "session.events",
      session: sessionId,
      limit: 200,
      waitMs: 0,
    }, { signal }) as { events: Array<{ body: { type: string; text?: string } }>; nextCursor: string };
    expect(first.events.map((event) => event.body.type)).toEqual([
      "connection",
      "item_started",
      "assistant_delta",
      "item_completed",
    ]);
    expect(first.events.at(-2)?.body.text).toBe("Visible progress");
    expect(first.events[1]?.body).toMatchObject({
      type: "item_started",
      liveAcceptanceCommandDigest: "a".repeat(64),
    });

    await value.service.observeCodexFact(authority, {
      type: "itemStarted",
      connectionId,
      threadId: session.providerThreadId,
      turnId: "turn-live",
      itemId: "reasoning-live",
      itemKind: "reasoning",
    });

    const status = sessionStatusSchema.parse(await value.service.execute({
      kind: "session.status",
      session: sessionId,
    }, { signal }));
    expect(status).toMatchObject({
      version: 2,
      session: { id: sessionId, execution: "idle" },
      advisory: {
        attention: "none",
        execution: "idle",
        queueDepth: 0,
      },
      localObservation: {
        coverage: "complete",
        freshness: "fresh",
        source: "sqlite",
      },
      providerObservation: {
        basis: "provider_read",
        connectionId,
        coverage: "complete",
        freshness: "fresh",
        profileGeneration: authority.generation,
        source: "codex_app_server",
        state: "live",
      },
      eventStream: { observedThroughSequence: 5 },
      interactions: {
        pending: [],
        pendingCount: 0,
        responseInFlightCount: 0,
        truncated: false,
      },
      queue: {
        ambiguousCount: 0,
        depth: 0,
        dispatchingCount: 0,
        failedCount: 0,
      },
    });
    expect(Object.keys(status).sort()).toEqual([
      "advisory",
      "eventStream",
      "interactions",
      "localObservation",
      "providerObservation",
      "queue",
      "session",
      "version",
    ]);
    const waiting = value.service.execute({
      kind: "session.events",
      session: sessionId,
      cursor: status.eventStream.cursor,
      limit: 200,
      waitMs: 1_000,
    }, { signal }) as Promise<{ events: Array<{ body: { type: string; text?: string } }>; nextCursor: string }>;
    await Bun.sleep(5);
    await value.service.observeCodexFact(authority, {
      type: "reasoningSummaryDelta",
      connectionId,
      threadId: session.providerThreadId,
      turnId: "turn-live",
      itemId: "reasoning-live",
      summaryIndex: 0,
      text: "Checking the public contract",
    });
    await value.service.observeCodexFact(authority, {
      type: "itemCompleted",
      connectionId,
      threadId: session.providerThreadId,
      turnId: "turn-live",
      itemId: "reasoning-live",
      itemKind: "reasoning",
      status: "completed",
    });
    await expect(waiting).resolves.toMatchObject({
      events: [
        { body: { type: "reasoning_summary_delta", text: "Checking the public contract" } },
        {
          body: {
            type: "item_completed",
            itemId: value.eventCursors.projectPublicProviderIdentifier("reasoning-live"),
          },
        },
      ],
    });
    await expect(value.service.execute({
      kind: "session.events",
      session: sessionId,
      cursor: `${first.nextCursor}tampered`,
      limit: 10,
      waitMs: 0,
    }, { signal })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
test("maintains idle and terminal event streams on read without a new append", async () => {
    for (const localState of ["idle_signed_out", "terminal"] as const) {
      let currentTime = 1_000;
      const value = await fixture(new FakeCloud(),
        () => undefined,
        () => currentTime,
      );
      const { sessionId } = await createIdleSession(value, `Read retention ${localState}`);
      const session = value.store.requireSession(sessionId);
      const profile = value.store.requireProfileById(session.profileId);
      const event = value.store.appendSessionEvent({
        sessionId,
        accountId: profile.id,
        providerGeneration: profile.processGeneration,
        providerAuthority: value.store.requireProviderAccountAuthority(profile.id, "codex"),
        providerConnectionId: null,
        body: {
          type: "warning",
          code: "RETENTION",
          message: `age ${localState} without append`,
        },
      });
      if (localState === "terminal") {
        value.store.setSessionTurnState({
          sessionId,
          expectedRevision: session.revision,
          state: "terminal",
        });
      }
      const cursor = value.eventCursors.encode({
        version: 1,
        sessionId,
        streamEpoch: event.streamEpoch,
        sequence: 0,
      });
      const providerReadsBefore = value.codex.observedThreads.length;
      let observedThroughBeforeRead = event.sequence;

      // A signed-out historical stream is readable only after an exact
      // disconnect retirement was durably recorded under its captured
      // authority. The subsequent readiness change is local and must not
      // cause a provider observation.
      if (localState === "idle_signed_out") {
        const authority = liveAuthorityFor(value.store, profile.id);
        await value.service.observeCodexFact(authority, {
          type: "providerDisconnected",
          connectionId: value.codex.observationConnectionId,
          reason: "process_exit",
        });
        const retired = value.store.requireProfileById(profile.id);
        expect(value.store.setProfileState(
          retired.id,
          retired.processGeneration,
          "signed_out",
        )).toBe(true);
        observedThroughBeforeRead = value.store
          .eventStreamPosition(sessionId).observedThroughSequence;
      }

      currentTime += SESSION_EVENT_RETAIN_AGE_MS + 1;

      const page = sessionEventPageSchema.parse(await value.service.execute({
        kind: "session.events",
        session: sessionId,
        cursor,
        limit: 10,
        waitMs: 0,
      }, { signal }));
      expect(page.events).toEqual([]);
      expect(page.gap).toEqual({
        reason: "retention_age",
        requestedSequence: 0,
        retainedFromSequence: observedThroughBeforeRead + 1,
      });
      expect(value.eventCursors.decode(page.nextCursor)).toEqual({
        version: 1,
        sessionId,
        streamEpoch: event.streamEpoch,
        sequence: observedThroughBeforeRead,
      });
      expect(value.store.eventStreamPosition(sessionId)).toEqual({
        streamEpoch: event.streamEpoch,
        floorSequence: observedThroughBeforeRead + 1,
        observedThroughSequence: observedThroughBeforeRead,
      });
      expect(value.codex.observedThreads).toHaveLength(providerReadsBefore);
    }
  });
test("fails an unavailable event follow closed after surfacing one durable warning", async () => {
    const value = await fixture();
    const { sessionId } = await createIdleSession(value, "Unavailable observation");
    const position = value.store.eventStreamPosition(sessionId);
    const cursor = value.eventCursors.encode({
      version: 1,
      sessionId,
      streamEpoch: position.streamEpoch,
      sequence: position.observedThroughSequence,
    });
    const observationsBeforeInvalidCursor = value.codex.observedThreads.length;
    await expect(value.service.execute({
      kind: "session.events",
      session: sessionId,
      cursor: `${cursor}tampered`,
      limit: 200,
      waitMs: 1_000,
    }, { signal })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(value.codex.observedThreads).toHaveLength(observationsBeforeInvalidCursor);
    value.codex.observeError = new CodexSessionObservationError("resume_unavailable");

    const startedAt = Date.now();
    const warningPage = await value.service.execute({
      kind: "session.events",
      session: sessionId,
      cursor,
      limit: 200,
      waitMs: 1_000,
    }, { signal }) as { events: Array<{ body: { type: string; code?: string } }>; nextCursor: string };
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(warningPage.events).toHaveLength(1);
    expect(warningPage.events[0]?.body).toMatchObject({
      code: "provider_resume_unavailable",
      type: "warning",
    });
    await expect(value.service.execute({
      kind: "session.events",
      session: sessionId,
      cursor: warningPage.nextCursor,
      limit: 200,
      waitMs: 1_000,
    }, { signal })).rejects.toMatchObject({ code: "UNAVAILABLE" });

    await expect(value.service.execute({
      kind: "session.send",
      session: sessionId,
      message: "must not dispatch",
      idempotencyKey: "018bcfe5-6800-7000-8000-000000000711",
    }, { signal })).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(value.codex.calls).not.toContain("send");
    await expect(value.service.execute({
      kind: "session.queue",
      session: sessionId,
      message: "dispatch after reconnect",
      idempotencyKey: "018bcfe5-6800-7000-8000-000000000712",
    }, { signal })).resolves.toMatchObject({ queued: { state: "pending" } });
  });
test("quarantines a mismatched resumed thread and exposes the closed status", async () => {
    const value = await fixture();
    const { sessionId } = await createIdleSession(value, "Mismatched observation");
    value.codex.observationThreadIdOverride = "provider-thread-foreign";

    await expect(value.service.execute({
      kind: "session.status",
      session: sessionId,
    }, { signal })).resolves.toMatchObject({
      providerObservation: {
        basis: "provider_read",
        code: "thread_mismatch",
        coverage: "partial",
        freshness: "fresh",
        source: "codex_app_server",
        state: "recovery_required",
      },
      advisory: {
        attention: "recovery_required",
        execution: "recovery_required",
      },
      session: { execution: "recovery_required" },
    });
    const mismatch = value.store.listSessionEvents({
      sessionId,
      afterSequence: 0,
    }).events.find((event) => event.body.type === "error");
    expect(mismatch?.body).toMatchObject({
      code: "provider_thread_mismatch",
      terminal: true,
      type: "error",
    });
  });
test("reports explicit provider provenance for unbound, signed-out, quarantined, and terminal sessions", async () => {
    const value = await fixture(new FakeCloud(), () => undefined, () => 210_000);
    const unboundProfile = value.store.createProfile("Unbound observation");
    const unboundSession = value.store.createSession({
      profileId: unboundProfile.id,
      title: "Unbound observation",
      preset: "high",
      fastEnabled: false,
    });
    const unbound = sessionStatusSchema.parse(await value.service.execute({
      kind: "session.status",
      session: unboundSession.id,
    }, { signal }));
    expect(unbound.providerObservation).toEqual({
      source: "codex_app_server",
      basis: "local_state",
      profileGeneration: 0,
      observedAt: 210_000,
      state: "not_applicable",
      coverage: "not_attempted",
      freshness: "unknown",
      reason: "unbound",
    });

    const { sessionId } = await createIdleSession(value, "Provider variants");
    const session = value.store.requireSession(sessionId);
    const profile = value.store.requireProfileById(session.profileId);
    // A terminal row still needs immutable provenance at creation time. Bind
    // it while the selected Codex identity is established, then prove that
    // terminal observation remains local after the profile signs out.
    const terminalSession = value.store.upsertProviderSession({
      providerAuthority: value.store.requireProviderAccountAuthority(profile.id, "codex"),
      profileId: profile.id,
      provider: "codex",
      providerThreadId: "provider-terminal-observation",
      preset: "high",
      fastEnabled: false,
      title: "Terminal provider observation",
      state: "terminal",
      providerAccountKey: codexProviderAccountKey(),
    });
    const observeCallsBeforeNonLiveStatuses = value.codex.calls.filter(
      (call) => call === "observe",
    ).length;
    await value.service.observeCodexFact(liveAuthorityFor(value.store, profile.id), {
      type: "providerDisconnected",
      connectionId: value.codex.observationConnectionId,
      reason: "process_exit",
    });
    const retiredProfile = value.store.requireProfileById(profile.id);
    expect(value.store.setProfileState(
      retiredProfile.id,
      retiredProfile.processGeneration,
      "signed_out",
    )).toBe(true);
    const signedOut = sessionStatusSchema.parse(await value.service.execute({
      kind: "session.status",
      session: sessionId,
    }, { signal }));
    expect(signedOut.providerObservation).toEqual({
      source: "codex_app_server",
      basis: "local_state",
      profileGeneration: profile.processGeneration,
      observedAt: 210_000,
      state: "unavailable",
      coverage: "unavailable",
      freshness: "fresh",
      code: "account_signed_out",
    });

    value.store.setSessionTurnState({
      sessionId,
      expectedRevision: session.revision,
      state: "recovery_required",
    });
    const quarantined = sessionStatusSchema.parse(await value.service.execute({
      kind: "session.status",
      session: sessionId,
    }, { signal }));
    expect(quarantined.providerObservation).toEqual({
      source: "codex_app_server",
      basis: "local_state",
      profileGeneration: profile.processGeneration,
      observedAt: 210_000,
      state: "recovery_required",
      coverage: "partial",
      freshness: "fresh",
      code: "session_quarantined",
    });
    expect(quarantined.advisory.attention).toBe("recovery_required");

    const terminal = sessionStatusSchema.parse(await value.service.execute({
      kind: "session.status",
      session: terminalSession.id,
    }, { signal }));
    expect(terminal.providerObservation).toEqual({
      source: "codex_app_server",
      basis: "local_state",
      profileGeneration: profile.processGeneration,
      observedAt: 210_000,
      state: "not_applicable",
      coverage: "not_attempted",
      freshness: "unknown",
      reason: "terminal",
    });
    expect(terminal.advisory).toMatchObject({
      attention: "none",
      execution: "terminal",
    });
    expect(value.codex.calls.filter((call) => call === "observe")).toHaveLength(
      observeCallsBeforeNonLiveStatuses,
    );
  });
test("rejects a stale local observation without exact historical retirement evidence", async () => {
    const value = await fixture();
    const { sessionId } = await createIdleSession(value, "Unproved retired observation");
    const session = value.store.requireSession(sessionId);
    const captured = value.store.requireSessionProviderAuthority(sessionId);
    value.store.advanceProfileGeneration(session.profileId, captured.processGeneration);
    const advanced = value.store.requireProfileById(session.profileId);
    expect(value.store.setProfileState(
      advanced.id,
      advanced.processGeneration,
      "signed_out",
    )).toBe(true);
    const providerReadsBefore = value.codex.observedThreads.length;

    await expect(value.service.execute({
      kind: "session.status",
      session: sessionId,
    }, { signal })).rejects.toMatchObject({
      code: "RECOVERY_REQUIRED",
      details: { reason: "SESSION_PROVIDER_AUTHORITY_STALE" },
    });
    expect(value.codex.observedThreads).toHaveLength(providerReadsBefore);
    expect(value.store.requireCapturedSessionProviderAuthority(sessionId))
      .toMatchObject(captured);
  });
test("does not append an old-generation warning when resume retirement advances authority", async () => {
    const value = await fixture();
    const { sessionId } = await createIdleSession(value, "Retired observation generation");
    const session = value.store.requireSession(sessionId);
    const profile = value.store.requireProfileById(session.profileId);
    const before = value.store.listSessionEvents({ sessionId, afterSequence: 0 }).events;
    value.codex.beforeObserveReturn = async () => {
      delete value.codex.beforeObserveReturn;
      value.store.advanceProfileGeneration(profile.id, profile.processGeneration);
    };
    value.codex.observeErrorOnce = new CodexSessionObservationError("resume_unavailable");

    await expect(value.service.execute({
      kind: "session.status",
      session: sessionId,
    }, { signal })).rejects.toMatchObject({ name: "IndeterminateLocalCommitError" });
    expect(value.store.requireProfileById(profile.id).processGeneration)
      .toBe(profile.processGeneration + 1);
    expect(value.store.listSessionEvents({ sessionId, afterSequence: 0 }).events).toEqual(before);
  });
test("preserves parsed MCP tool identity through safe events and human rendering", async () => {
    const value = await fixture();
    const { sessionId } = await createIdleSession(value, "MCP lifecycle stream");
    const session = value.store.requireSession(sessionId);
    const profile = value.store.requireProfileById(session.profileId);
    if (session.providerThreadId === undefined) throw new Error("Expected a bound session.");
    const authority = liveAuthorityFor(value.store, profile.id);
    const connectionId = value.codex.observationConnectionId;
    const providerArgumentsSecret = "MCP-ARGUMENT-SECRET-MUST-NOT-PERSIST";
    const providerResultSecret = "MCP-RESULT-SECRET-MUST-NOT-PERSIST";
    const providerItem = {
      type: "mcpToolCall",
      id: "mcp-item-1",
      server: "github",
      tool: "create_issue",
      status: "inProgress",
      arguments: { token: providerArgumentsSecret },
      result: { content: providerResultSecret },
    };

    await value.service.observeCodexFact(authority, {
      ...parseFact("item/started", {
        threadId: session.providerThreadId,
        turnId: "turn-mcp",
        item: providerItem,
      }),
      connectionId,
    });
    await value.service.observeCodexFact(authority, {
      ...parseFact("item/completed", {
        threadId: session.providerThreadId,
        turnId: "turn-mcp",
        item: { ...providerItem, status: "completed" },
      }),
      connectionId,
    });

    const command = {
      kind: "session.events",
      session: sessionId,
      limit: 200,
      waitMs: 0,
    } satisfies LocalCommand;
    const page = await value.service.execute(command, { signal }) as {
      events: Array<{ body: Record<string, unknown> }>;
    };
    const lifecycle = page.events
      .map((event) => event.body)
      .filter((body) => body.type === "item_started" || body.type === "item_completed");
    expect(lifecycle).toHaveLength(2);
    expect(lifecycle[0]).toMatchObject({
      type: "item_started",
      itemKind: "mcpToolCall",
      server: "github",
      tool: "create_issue",
    });
    expect(lifecycle[1]).toMatchObject({
      type: "item_completed",
      itemKind: "mcpToolCall",
      server: "github",
      tool: "create_issue",
      status: "completed",
    });
    const serialized = JSON.stringify(page);
    expect(serialized).not.toContain(providerArgumentsSecret);
    expect(serialized).not.toContain(providerResultSecret);
    expect(serialized).not.toContain('"arguments"');
    expect(serialized).not.toContain('"result"');
    expect(renderHuman(command, page)).toContain("mcpToolCall github/create_issue");
    expect(renderJson(command, page)).toContain('"server":"github"');
    expect(renderJson(command, page)).toContain('"tool":"create_issue"');
  });
test("turns a valid prior-epoch cursor into one resumable stream-restored gap", async () => {
    const value = await fixture();
    const { sessionId } = await createIdleSession(value, "Restored event stream");
    const priorEpoch = "7f000000-0000-4000-8000-000000000001";
    const priorCursor = value.eventCursors.encode({
      version: 1,
      sessionId,
      streamEpoch: priorEpoch,
      sequence: 99,
    });

    const restored = await value.service.execute({
      kind: "session.events",
      session: sessionId,
      cursor: priorCursor,
      limit: 1,
      waitMs: 30_000,
    }, { signal }) as {
      requestedCursor: string;
      nextCursor: string;
      gap: null | { reason: string; requestedSequence: number | null };
      events: Array<{ streamEpoch: string }>;
    };
    expect(restored).toMatchObject({
      requestedCursor: priorCursor,
      gap: { reason: "stream_restored", requestedSequence: 99 },
    });
    expect(restored.nextCursor).not.toBe(priorCursor);
    expect(restored.events.every((entry) => entry.streamEpoch !== priorEpoch)).toBe(true);

    const resumed = await value.service.execute({
      kind: "session.events",
      session: sessionId,
      cursor: restored.nextCursor,
      limit: 200,
      waitMs: 0,
    }, { signal }) as { requestedCursor: string; gap: unknown };
    expect(resumed).toMatchObject({ requestedCursor: restored.nextCursor, gap: null });
  });
test("routes provider close and delete lifecycle without leaving a mutable stale session", async () => {
    const factsMemory = new FakeFactsMemoryLifecycle();
    const value = await fixture(new FakeCloud(),
      () => undefined,
      Date.now,
      factsMemory,
    );
    const { sessionId } = await createIdleSession(value, "Provider lifecycle");
    const session = value.store.requireSession(sessionId);
    const profile = value.store.requireProfileById(session.profileId);
    if (session.providerThreadId === undefined) throw new Error("Expected a bound session.");
    const authority = liveAuthorityFor(value.store, profile.id);
    const connectionId = value.codex.observationConnectionId;
    factsMemory.ensures.length = 0;
    await value.service.observeCodexFact(authority, {
      type: "turnStarted",
      connectionId,
      threadId: session.providerThreadId,
      turn: {
        id: "turn-lifecycle",
        items: [],
        status: "inProgress",
        startedAt: 1,
        completedAt: null,
        durationMs: null,
      },
    });
    expect(value.store.requireSession(sessionId)).toMatchObject({
      activeTurnId: "turn-lifecycle",
      state: "active",
    });
    expect(factsMemory.ensures.at(-1)).toMatchObject({
      ownerId: profile.id,
      sessionId,
    });

    await value.service.observeCodexFact(authority, {
      ...parseFact("thread/closed", { threadId: session.providerThreadId }),
      connectionId,
    });
    expect(value.store.requireSession(sessionId)).toMatchObject({ state: "idle" });
    expect(value.store.requireSession(sessionId).activeTurnId).toBeUndefined();
    const afterClose = value.store.listSessionEvents({
      sessionId,
      afterSequence: 0,
    });
    expect(afterClose.events.at(-1)?.body).toEqual({
      type: "session_status",
      status: "not_loaded",
      activeTurnId: null,
    });

    await value.service.observeCodexFact(authority, {
      ...parseFact("skills/changed", { paths: ["/private/discarded"] }),
      connectionId,
    });
    expect(value.store.listSessionEvents({ sessionId, afterSequence: 0 }).events)
      .toHaveLength(afterClose.events.length);

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
        requestId: { type: "number", value: 41 },
        method: "item/commandExecution/requestApproval",
        requestDigest: "4".repeat(64),
        threadId: session.providerThreadId,
        turnId: "turn-deleted",
        itemId: "item-deleted",
        approvalId: null,
      },
      kind: "command_approval",
      blocking: true,
      display: {
        kind: "command_approval",
        summary: "Approval cannot survive provider deletion",
        reason: null,
        commandClass: "test",
        workingDirectory: null,
        availableDecisions: ["once" as const, "decline" as const, "cancel" as const],
      },
    });
    expect(value.store.listInteractions({ sessionId, pendingOnly: true })).toHaveLength(1);
    const pendingQueue = value.store.enqueue(session.id, "must not dispatch after deletion");
    expect(value.store.quarantineSession(session.id)).toMatchObject({ state: "recovery_required" });
    await value.service.observeCodexFact(authority, {
      ...parseFact("thread/deleted", { threadId: session.providerThreadId }),
      connectionId,
    });
    expect(value.store.requireSession(sessionId)).toMatchObject({ state: "terminal" });
    expect(value.store.requireQueue(pendingQueue.id)).toMatchObject({ state: "cancelled" });
    expect(value.store.listInteractions({ sessionId, pendingOnly: true })).toEqual([]);
    expect(value.store.listInteractions({ sessionId, pendingOnly: false })).toEqual([
      expect.objectContaining({ state: "expired", revision: 2 }),
    ]);
    const afterDelete = value.store.listSessionEvents({ sessionId, afterSequence: 0 }).events;
    expect(afterDelete.filter((event) =>
      event.body.type === "session_status" && event.body.status === "terminal")
      .map((event) => event.body))
      .toEqual([{ type: "session_status", status: "terminal", activeTurnId: null }]);
    expect(factsMemory.cleanups).toContainEqual({
      ownerId: profile.id,
      reason: "archive",
      sessionId,
    });
    await expect(value.service.execute({
      kind: "session.send",
      session: sessionId,
      message: "must fail closed",
    }, { signal })).rejects.toMatchObject({ code: "CONFLICT" });
  });
test("keeps provider diagnostic secrets out of the durable stream and CLI", async () => {
    const value = await fixture();
    const { sessionId } = await createIdleSession(value, "Safe diagnostics");
    const session = value.store.requireSession(sessionId);
    const profile = value.store.requireProfileById(session.profileId);
    if (session.providerThreadId === undefined) throw new Error("Expected a bound session.");
    const authority = liveAuthorityFor(value.store, profile.id);
    const privatePath = ["", "Users", "alice", "private", "key"].join("/");
    const sentinel = `Bearer PROVIDER_EVENT_SECRET at ${privatePath}`;
    const parsed = parseFact("warning", {
      threadId: session.providerThreadId,
      message: sentinel,
    });
    await value.service.observeCodexFact(authority, {
      ...parsed,
      connectionId: value.codex.observationConnectionId,
    });
    const command = {
      kind: "session.events",
      session: sessionId,
      limit: 200,
      waitMs: 0,
    } satisfies LocalCommand;
    const page = await value.service.execute(command, { signal });
    const durable = JSON.stringify(value.store.listSessionEvents({
      sessionId,
      afterSequence: 0,
    }));
    const human = renderHuman(command, page);
    const json = renderJson(command, page);
    for (const output of [durable, human, json]) {
      expect(output).not.toContain("PROVIDER_EVENT_SECRET");
      expect(output).not.toContain(privatePath);
    }
    expect(human).toContain("Codex reported a provider warning.");
  });
test("redacts interleaved streamed and complete provider prose before SQLite or CLI output", async () => {
    const value = await fixture();
    const { sessionId } = await createIdleSession(value, "Stream confidentiality");
    const session = value.store.requireSession(sessionId);
    const profile = value.store.requireProfileById(session.profileId);
    if (session.providerThreadId === undefined) throw new Error("Expected a bound session.");
    const authority = liveAuthorityFor(value.store, profile.id);
    const connectionId = value.codex.observationConnectionId;
    const observe = async (fact: CodexFact): Promise<void> =>
      await value.service.observeCodexFact(authority, { ...fact, connectionId });

    await observe({
      type: "assistantDelta",
      threadId: session.providerThreadId,
      turnId: "turn-private",
      itemId: "assistant-private",
      text: "Before Authori",
    });
    await observe({
      type: "reasoningSummaryDelta",
      threadId: session.providerThreadId,
      turnId: "turn-private",
      itemId: "reasoning-private",
      summaryIndex: 0,
      text: "Checking device_",
    });
    await observe({
      type: "assistantDelta",
      threadId: session.providerThreadId,
      turnId: "turn-private",
      itemId: "assistant-private",
      text: "zation: Bearer ASSISTANT-STREAM-SECRET-11\nAfter",
    });
    await observe({
      type: "reasoningSummaryDelta",
      threadId: session.providerThreadId,
      turnId: "turn-private",
      itemId: "reasoning-private",
      summaryIndex: 0,
      text: "code=REASONING-STREAM-SECRET-22 done",
    });
    expect(JSON.stringify(value.store.listSessionEvents({
      sessionId,
      afterSequence: 0,
    }))).not.toContain("STREAM-SECRET");

    for (const [itemId, itemKind] of [
      ["assistant-private", "agentMessage"],
      ["reasoning-private", "reasoning"],
    ] as const) {
      await observe({
        type: "itemCompleted",
        threadId: session.providerThreadId,
        turnId: "turn-private",
        itemId,
        itemKind,
        status: "completed",
      });
    }
    await observe({
      type: "planUpdated",
      threadId: session.providerThreadId,
      turnId: "turn-private",
      steps: [{
        text: "Load api_key=PLAN-PROSE-SECRET-33",
        status: "in_progress",
      }],
      explanation: `Read ${privatePathRoot}/.env with token=PLAN-PROSE-SECRET-44`,
    });
    await observe({
      type: "interactionRequested",
      provider: {
        profileId: profile.id,
        processGeneration: profile.processGeneration,
        provider: authority.provider,
        providerAccountId: authority.providerAccountId,
        bindingGeneration: authority.bindingGeneration,
        connectionId,
        requestId: { type: "string", value: "confidentiality-request" },
        method: "item/tool/requestUserInput",
        requestDigest: "c".repeat(64),
        threadId: session.providerThreadId,
        turnId: "turn-private",
        itemId: "question-private",
        approvalId: null,
      },
      kind: "user_input",
      blocking: true,
      display: {
        kind: "user_input",
        summary: "Authorization: Bearer INTERACTION-PROSE-SECRET-55",
        blocking: true,
        questions: [{
          id: "question-safe",
          header: "Device code=INTERACTION-PROSE-SECRET-66",
          question: `Continue from ${privatePathRoot}/project?`,
          options: [{ label: "Continue", description: "Use token=INTERACTION-PROSE-SECRET-77" }],
          allowsOther: false,
          secret: false,
        }],
      },
    });
    await observe({
      type: "assistantDelta",
      threadId: session.providerThreadId,
      turnId: "turn-private",
      itemId: "interrupted-private",
      text: "unfinished api_",
    });
    await value.service.observeCodexFact(authority, {
      type: "providerDisconnected",
      connectionId,
      reason: "process_exit",
    });

    const command = {
      kind: "session.events",
      session: sessionId,
      limit: 200,
      waitMs: 0,
    } satisfies LocalCommand;
    const page = await value.service.execute(command, { signal });
    const durableEvents = JSON.stringify(value.store.listSessionEvents({
      sessionId,
      afterSequence: 0,
    }));
    const durableInteractions = JSON.stringify(value.store.listInteractions({
      sessionId,
      pendingOnly: false,
    }));
    for (const output of [
      durableEvents,
      durableInteractions,
      renderHuman(command, page),
      renderJson(command, page),
    ]) {
      expect(output).not.toContain("STREAM-SECRET");
      expect(output).not.toContain("PROSE-SECRET");
      expect(output).not.toContain(privatePathRoot);
      expect(output).not.toContain("unfinished api_");
    }
    expect(durableEvents).toContain("[protected]");
    expect(durableEvents).toContain("[local-path]");
    expect(durableEvents).toContain("provider_disconnect");
  });
test("never persists a split exact Codex heartbeat echo from live assistant deltas", async () => {
    const value = await fixture();
    const { sessionId } = await createIdleSession(value, "Heartbeat stream confidentiality");
    const session = value.store.requireSession(sessionId);
    const profile = value.store.requireProfileById(session.profileId);
    if (session.providerThreadId === undefined) throw new Error("Expected a bound session.");
    const authority = liveAuthorityFor(value.store, profile.id);
    const connectionId = value.codex.observationConnectionId;
    const turnId = "turn-heartbeat-echo";
    const itemId = "assistant-heartbeat-echo";
    const heartbeat = [
      "<heartbeat>",
      "  <automation_id>weekly-project-maintenance</automation_id>",
      "  <current_time_iso>2030-01-02T03:04:05.678Z</current_time_iso>",
      "  <instructions>",
      "  Review the synthetic fixture project.",
      "  </instructions>",
      "</heartbeat>",
    ].join("\n");
    await value.service.observeCodexFact(authority, {
      type: "itemStarted",
      connectionId,
      threadId: session.providerThreadId,
      turnId,
      itemId,
      itemKind: "agentMessage",
    });
    for (const text of [
      heartbeat.slice(0, 7),
      heartbeat.slice(7, 31),
      heartbeat.slice(31, 79),
      heartbeat.slice(79),
    ]) {
      await value.service.observeCodexFact(authority, {
        type: "assistantDelta",
        connectionId,
        threadId: session.providerThreadId,
        turnId,
        itemId,
        text,
      });
      const durable = JSON.stringify(value.store.listSessionEvents({
        sessionId,
        afterSequence: 0,
      }));
      expect(durable).not.toContain("weekly-project-maintenance");
      expect(durable).not.toContain("2030-01-02T03:04:05.678Z");
      expect(durable).not.toContain("synthetic fixture project");
    }
    await value.service.observeCodexFact(authority, {
      type: "itemCompleted",
      connectionId,
      threadId: session.providerThreadId,
      turnId,
      itemId,
      itemKind: "agentMessage",
      status: "completed",
    });

    const events = value.store.listSessionEvents({
      sessionId,
      afterSequence: 0,
    }).events;
    expect(events.flatMap((event) =>
      event.body.type === "assistant_delta" ? [event.body.text] : []))
      .toEqual(["[protected]"]);
    expect(JSON.stringify(events)).not.toContain("weekly-project-maintenance");
    expect(JSON.stringify(events)).not.toContain("2030-01-02T03:04:05.678Z");
    expect(JSON.stringify(events)).not.toContain("synthetic fixture project");
  });
test("rejects unsafe exact interaction answer keys before durable admission", async () => {
    const value = await fixture();
    const { sessionId } = await createIdleSession(value, "Unsafe interaction key");
    const session = value.store.requireSession(sessionId);
    const profile = value.store.requireProfileById(session.profileId);
    if (session.providerThreadId === undefined) throw new Error("Expected a bound session.");
    const authority = liveAuthorityFor(value.store, profile.id);
    const connectionId = value.codex.observationConnectionId;
    await expect(value.service.observeCodexFact(authority, {
      type: "interactionRequested",
      connectionId,
      provider: {
        profileId: profile.id,
        processGeneration: profile.processGeneration,
        provider: authority.provider,
        providerAccountId: authority.providerAccountId,
        bindingGeneration: authority.bindingGeneration,
        connectionId,
        requestId: { type: "string", value: "unsafe-exact-key" },
        method: "item/tool/requestUserInput",
        requestDigest: "d".repeat(64),
        threadId: session.providerThreadId,
        turnId: "turn-unsafe-key",
        itemId: "item-unsafe-key",
        approvalId: null,
      },
      kind: "user_input",
      blocking: true,
      display: {
        kind: "user_input",
        summary: "Choose",
        blocking: true,
        questions: [{
          id: "Authorization: Bearer EXACT-KEY-SECRET-11",
          header: "Choice",
          question: "Choose one",
          options: null,
          allowsOther: false,
          secret: false,
        }],
      },
    })).rejects.toThrow("UNSAFE_EXACT_INTERACTION_DISPLAY:question_id");
    expect(value.store.listInteractions({ sessionId, pendingOnly: false })).toEqual([]);
    expect(JSON.stringify(value.store.listSessionEvents({
      sessionId,
      afterSequence: 0,
    }))).not.toContain("EXACT-KEY-SECRET-11");
  });
for (const fault of [
    { boundary: "prepare", timing: "before", providerCalls: 0, state: "expired" },
    { boundary: "prepare", timing: "after", providerCalls: 0, state: "expired" },
    { boundary: "prepared_event", timing: "before", providerCalls: 0, state: "expired" },
    { boundary: "prepared_event", timing: "after", providerCalls: 0, state: "expired" },
    { boundary: "mark", timing: "before", providerCalls: 1, state: "resolution_unknown" },
    { boundary: "mark", timing: "after", providerCalls: 1, state: "resolution_unknown" },
    { boundary: "written_event", timing: "before", providerCalls: 1, state: "resolution_unknown" },
    { boundary: "written_event", timing: "after", providerCalls: 1, state: "resolution_unknown" },
  ] as const) {
    test(`quarantines an interaction persistence fault ${fault.timing} ${fault.boundary}`, async () => {
      let stopCalls = 0;
      const value = await fixture(new FakeCloud(),
        () => { stopCalls += 1; },
      );
      const { sessionId } = await createIdleSession(
        value,
        `Persistence ${fault.boundary} ${fault.timing}`,
      );
      const seeded = await seedResolvableInteraction(
        value,
        sessionId,
        `persistence-${fault.boundary}-${fault.timing}`,
      );
      const originalGeneration = seeded.authority.generation;
      let injected = false;
      if (fault.boundary === "prepare") {
        const original = value.store.prepareInteractionResponse.bind(value.store);
        (value.store as unknown as {
          prepareInteractionResponse: StateStore["prepareInteractionResponse"];
        }).prepareInteractionResponse = (input) => {
          if (injected) return original(input);
          injected = true;
          if (fault.timing === "after") original(input);
          throw new Error(`injected ${fault.timing} prepare fault`);
        };
      } else if (fault.boundary === "mark") {
        const original = value.store.markInteractionResponseWritten.bind(value.store);
        (value.store as unknown as {
          markInteractionResponseWritten: StateStore["markInteractionResponseWritten"];
        }).markInteractionResponseWritten = (input) => {
          if (injected) return original(input);
          injected = true;
          if (fault.timing === "after") original(input);
          throw new Error(`injected ${fault.timing} mark fault`);
        };
      } else {
        const targetState = fault.boundary === "prepared_event"
          ? "response_prepared"
          : "response_written";
        const original = value.store.appendSessionEvent.bind(value.store);
        (value.store as unknown as {
          appendSessionEvent: StateStore["appendSessionEvent"];
        }).appendSessionEvent = (input) => {
          if (
            !injected
            && input.body.type === "interaction_state"
            && input.body.state === targetState
          ) {
            injected = true;
            if (fault.timing === "after") original(input);
            throw new Error(`injected ${fault.timing} ${fault.boundary} fault`);
          }
          return original(input);
        };
      }

      const command = {
        kind: "interaction.resolve" as const,
        interaction: seeded.interaction.publicId,
        expectedRevision: seeded.interaction.revision,
        resolution: { kind: "approval_decision" as const, decision: "once" as const },
      };
      const beforeQuarantine = await value.service.execute({
        kind: "session.status",
        session: sessionId,
      }, { signal }) as { eventStream: { cursor: string } };
      const afterResponse: Array<() => void> = [];
      const error = await value.service.execute(command, {
        signal,
        afterResponse: (callback) => { afterResponse.push(callback); },
      }).catch((caught: unknown) => caught);

      expect(injected).toBe(true);
      expect(error).toMatchObject({
        code: "RECOVERY_REQUIRED",
        details: {
          daemonRestartRequired: true,
          interaction: {
            id: seeded.interaction.publicId,
            state: fault.state,
          },
        },
      });
      expect(value.codex.resolvedInteractions).toHaveLength(fault.providerCalls);
      expect(value.store.requireInteraction(seeded.interaction.publicId)).toMatchObject({
        state: fault.state,
      });
      expect(value.store.requireProfileById(seeded.authority.id).processGeneration)
        .toBe(originalGeneration + 1);
      expect(afterResponse).toHaveLength(1);
      expect(stopCalls).toBe(0);

      const publicEvents = await value.service.execute({
        kind: "session.events",
        session: sessionId,
        cursor: beforeQuarantine.eventStream.cursor,
        limit: 200,
        waitMs: 0,
      }, { signal }) as {
        events: Array<{
          body: {
            interactionId?: string;
            revision?: number;
            state?: string;
            type: string;
          };
        }>;
      };
      expect(publicEvents.events.at(-1)?.body).toEqual({
        type: "interaction_state",
        interactionId: seeded.interaction.publicId,
        state: fault.state,
        revision: expect.any(Number),
      });

      const restartVisible = new StateStore(value.paths, { readonly: true });
      try {
        expect(restartVisible.requireInteraction(seeded.interaction.publicId)).toMatchObject({
          state: fault.state,
        });
        expect(restartVisible.requireProfileById(seeded.authority.id).processGeneration)
          .toBe(originalGeneration + 1);
        expect(restartVisible.listSessionEvents({
          sessionId,
          afterSequence: 0,
        }).events.at(-1)?.body).toEqual({
          type: "interaction_state",
          interactionId: seeded.interaction.publicId,
          state: fault.state,
          revision: expect.any(Number),
        });
      } finally {
        restartVisible.close();
      }

      await expect(value.service.execute(command, {
        signal,
        afterResponse: (callback) => { afterResponse.push(callback); },
      })).rejects.toMatchObject({ code: "CONFLICT" });
      expect(value.codex.resolvedInteractions).toHaveLength(fault.providerCalls);
      expect(afterResponse).toHaveLength(1);

      const eventsBeforeStaleFact = value.store.listSessionEvents({
        sessionId,
        afterSequence: 0,
      }).events;
      await value.service.observeCodexFact(seeded.authority, {
        type: "assistantDelta",
        connectionId: seeded.interaction.authority.connectionId,
        threadId: seeded.interaction.authority.threadId as string,
        turnId: "turn-stale-persistence-boundary",
        itemId: "item-stale-persistence-boundary",
        text: "must remain fenced",
      });
      expect(value.store.listSessionEvents({ sessionId, afterSequence: 0 }).events)
        .toEqual(eventsBeforeStaleFact);

      afterResponse[0]?.();
      expect(stopCalls).toBe(1);
      await value.service.close();
    });
  }
test("stops admitting work immediately when the atomic interaction quarantine itself fails", async () => {
    let stopCalls = 0;
    const value = await fixture(new FakeCloud(),
      () => { stopCalls += 1; },
    );
    const { sessionId } = await createIdleSession(value, "Failed persistence quarantine");
    const seeded = await seedResolvableInteraction(
      value,
      sessionId,
      "failed-persistence-quarantine",
    );
    const originalPrepare = value.store.prepareInteractionResponse.bind(value.store);
    const originalQuarantine = value.store.quarantineInteractionPersistenceBoundary
      .bind(value.store);
    (value.store as unknown as {
      prepareInteractionResponse: StateStore["prepareInteractionResponse"];
      quarantineInteractionPersistenceBoundary:
        StateStore["quarantineInteractionPersistenceBoundary"];
    }).prepareInteractionResponse = () => {
      throw new Error("injected prepare failure before commit");
    };
    (value.store as unknown as {
      quarantineInteractionPersistenceBoundary:
        StateStore["quarantineInteractionPersistenceBoundary"];
    }).quarantineInteractionPersistenceBoundary = () => {
      throw new Error("injected atomic quarantine failure");
    };
    const afterResponse: Array<() => void> = [];

    const error = await value.service.execute({
      kind: "interaction.resolve",
      interaction: seeded.interaction.publicId,
      expectedRevision: seeded.interaction.revision,
      resolution: { kind: "approval_decision", decision: "once" },
    }, {
      signal,
      afterResponse: (callback) => { afterResponse.push(callback); },
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "RECOVERY_REQUIRED",
      details: {
        daemonRestartRequired: true,
        interaction: { id: seeded.interaction.publicId, state: "pending" },
      },
    });
    expect((error as Error).message).toContain("could not be confirmed");
    expect(value.store.requireInteraction(seeded.interaction.publicId)).toMatchObject({
      state: "pending",
      revision: 1,
    });
    expect(value.store.requireProfileById(seeded.authority.id).processGeneration)
      .toBe(seeded.authority.generation);
    expect(afterResponse).toHaveLength(1);
    await expect(value.service.execute({ kind: "account.list" }, { signal }))
      .rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(value.codex.resolvedInteractions).toHaveLength(0);
    expect(stopCalls).toBe(0);
    afterResponse[0]?.();
    expect(stopCalls).toBe(1);

    (value.store as unknown as {
      prepareInteractionResponse: StateStore["prepareInteractionResponse"];
      quarantineInteractionPersistenceBoundary:
        StateStore["quarantineInteractionPersistenceBoundary"];
    }).prepareInteractionResponse = originalPrepare;
    (value.store as unknown as {
      quarantineInteractionPersistenceBoundary:
        StateStore["quarantineInteractionPersistenceBoundary"];
    }).quarantineInteractionPersistenceBoundary = originalQuarantine;
    await value.service.close();
  });
test("durably admits, privately routes, and settles an exact provider interaction", async () => {
    const value = await fixture();
    const { sessionId } = await createIdleSession(value, "Interaction broker");
    const session = value.store.requireSession(sessionId);
    const profile = value.store.requireProfileById(session.profileId);
    if (session.providerThreadId === undefined) throw new Error("Expected a bound session.");
    const authority = liveAuthorityFor(value.store, profile.id);
    const privateTurnId = `${["", "Users", "person", "private"].join("/")}/api_key=INTERACTION-TURN-SECRET`;
    const privateItemId = "token=INTERACTION-ITEM-SECRET";
    const provider = {
      profileId: profile.id,
      processGeneration: profile.processGeneration,
      provider: authority.provider,
      providerAccountId: authority.providerAccountId,
      bindingGeneration: authority.bindingGeneration,
      connectionId: value.codex.observationConnectionId,
      requestId: { type: "string" as const, value: "approval-request-1" },
      method: "item/commandExecution/requestApproval",
      requestDigest: "a".repeat(64),
      threadId: session.providerThreadId,
      turnId: privateTurnId,
      itemId: privateItemId,
      approvalId: "approval-1",
    };
    await value.service.observeCodexFact(authority, {
      type: "interactionRequested",
      connectionId: provider.connectionId,
      provider,
      kind: "command_approval",
      blocking: true,
      display: {
        kind: "command_approval",
        summary: "Run the reviewed command",
        reason: "The test needs a safe effect",
        commandClass: "test",
        workingDirectory: null,
        availableDecisions: ["once" as const, "cancel" as const],
      },
    });
    const sessionInteractionsCommand = {
      kind: "session.interactions",
      session: sessionId,
      pending: true,
      limit: 10,
    } satisfies LocalCommand;
    const listed = await value.service.execute(
      sessionInteractionsCommand,
      { signal },
    ) as { interactions: PublicInteraction[] };
    expect(listed.interactions).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain("approval-request-1");
    expect(JSON.stringify(listed)).not.toContain(provider.requestDigest);
    expect(JSON.stringify(listed)).not.toContain(privateTurnId);
    expect(JSON.stringify(listed)).not.toContain(privateItemId);
    const interaction = listed.interactions[0];
    if (interaction === undefined) throw new Error("Expected an admitted interaction.");
    expect(publicInteractionSchema.parse(interaction)).toEqual(interaction);
    expect(interaction.context.turnId).toMatch(/^opaque_v2_[a-f0-9]{64}$/u);
    expect(interaction.context.itemId).toMatch(/^opaque_v2_[a-f0-9]{64}$/u);
    if (interaction.context.turnId === null) {
      throw new Error("Expected a public turn alias.");
    }
    const publicTurnId = interaction.context.turnId;
    expect(value.store.requireInteraction(interaction.id).authority).toMatchObject({
      turnId: privateTurnId,
      itemId: privateItemId,
    });

    const interactionListCommand = {
      kind: "interaction.list",
      pending: true,
      limit: 10,
    } satisfies LocalCommand;
    const interactionList = await value.service.execute(interactionListCommand, { signal });
    const interactionShowCommand = {
      kind: "interaction.show",
      interaction: interaction.id,
    } satisfies LocalCommand;
    const interactionShow = await value.service.execute(interactionShowCommand, { signal });
    const privateNote = "PRIVATE-SESSION-NOTE-MUST-NOT-LEAK";
    const beforeNote = value.store.requireSession(sessionId);
    value.store.updateSessionMetadata({
      sessionId,
      expectedRevision: beforeNote.revision,
      note: privateNote,
    });
    const beforeActive = value.store.requireSession(sessionId);
    value.store.setSessionTurnState({
      sessionId,
      expectedRevision: beforeActive.revision,
      state: "active",
      activeTurnId: privateTurnId,
    });
    value.store.appendSessionEvent({
      sessionId,
      accountId: profile.id,
      providerGeneration: profile.processGeneration,
      providerAuthority: value.store.requireProviderAccountAuthority(profile.id, "codex"),
      providerConnectionId: provider.connectionId,
      body: { type: "turn_started", turnId: privateTurnId },
    });
    value.codex.readProjection = {
      ...value.codex.readProjection,
      providerThreadId: session.providerThreadId,
      status: "active",
      activeTurnId: privateTurnId,
      providerUpdatedAt: (value.codex.readProjection.providerUpdatedAt ?? 10) + 1,
    };
    const statusCommand = { kind: "session.status", session: sessionId } satisfies LocalCommand;
    const status = sessionStatusSchema.parse(
      await value.service.execute(statusCommand, { signal }),
    );
    expect(status.session.activeTurnId).toBe(publicTurnId);
    const eventAliases = value.store.listSessionEvents({
      sessionId,
      afterSequence: 0,
    }).events.flatMap((event) =>
      event.body.type === "turn_started" ? [event.body.turnId] : []);
    expect(eventAliases).toContain(publicTurnId);
    const serializedStatus = JSON.stringify(status);
    expect(serializedStatus).not.toContain(privateNote);
    expect(serializedStatus).not.toContain(session.providerThreadId);
    expect(serializedStatus).not.toContain('"note"');
    expect(serializedStatus).not.toContain('"providerThreadId"');
    for (const [command, result] of [
      [sessionInteractionsCommand, listed],
      [interactionListCommand, interactionList],
      [interactionShowCommand, interactionShow],
      [statusCommand, status],
    ] as const) {
      const human = renderHuman(command, result);
      expect(human).toContain("Run the reviewed command");
      expect(human).toContain(interaction.id);
      expect(human).not.toContain("unavailable");
      const json = renderJson(command, result);
      expect(json).not.toContain("approval-request-1");
      expect(json).not.toContain(provider.requestDigest);
      expect(json).not.toContain("INTERACTION-TURN-SECRET");
      expect(json).not.toContain("INTERACTION-ITEM-SECRET");
      expect(json).not.toContain("requestDigest");
      expect(json).not.toContain("responseDigest");
      expect(json).not.toContain("authority");
    }

    expect(renderHuman(interactionShowCommand, interactionShow)).toContain(
      "Available decisions: once, cancel",
    );
    const privateCommand = "git reset --hard PRIVATE-AUTHORITY-SENTINEL";
    value.codex.interactionAuthority = {
      kind: "command_approval",
      command: privateCommand,
      reason: "Apply the exact private command",
      availableDecisions: ["accept", "cancel"],
      workingDirectory: "/private/workspace",
      environmentId: "environment-1",
      commandActions: [{ type: "unknown", command: privateCommand }],
      networkApprovalContext: { host: "private.example", protocol: "https" },
      additionalPermissions: { network: { enabled: true } },
      proposedExecpolicyAmendment: null,
      proposedNetworkPolicyAmendments: null,
    };
    const inspectCommand = {
      kind: "interaction.inspect",
      interaction: interaction.id,
      expectedRevision: interaction.revision,
    } satisfies LocalCommand;
    const inspected = await value.service.execute(inspectCommand, { signal });
    const protectedDocument = protectedInteractionDetailDocumentSchema.parse(inspected);
    expect(protectedDocument.binding).toEqual({
      interactionId: interaction.id,
      revision: interaction.revision,
      kind: "command_approval",
      sessionId,
      profileId: profile.id,
      processGeneration: profile.processGeneration,
      connectionId: provider.connectionId,
    });
    expect(protectedDocument.authority).toEqual(value.codex.interactionAuthority);
    expect(value.codex.inspectedInteractions).toHaveLength(1);
    expect(value.codex.inspectedInteractions[0]).toMatchObject({
      authority: expect.objectContaining({
        id: profile.id,
        generation: profile.processGeneration,
      }),
      provider,
      kind: "command_approval",
    });
    expect(JSON.stringify(value.store.requireInteraction(interaction.id))).not.toContain(
      "PRIVATE-AUTHORITY-SENTINEL",
    );
    expect(renderJson(inspectCommand, inspected)).not.toContain("PRIVATE-AUTHORITY-SENTINEL");
    expect(renderHuman(inspectCommand, inspected)).not.toContain("PRIVATE-AUTHORITY-SENTINEL");
    await expect(value.service.execute({
      ...inspectCommand,
      expectedRevision: interaction.revision + 1,
    }, { signal })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(value.codex.inspectedInteractions).toHaveLength(1);

    if (protectedDocument.authority.kind !== "command_approval") {
      throw new Error("Expected command approval authority.");
    }
    const exactEmptyDocument = {
      ...protectedDocument,
      authority: { ...protectedDocument.authority, additionalPermissions: "" },
    };
    const emptyEncoded = encodeProtectedInteractionDetailDocument(exactEmptyDocument);
    const fillerBytes = PROTECTED_INTERACTION_DETAIL_MAXIMUM_BYTES - emptyEncoded.byteLength;
    emptyEncoded.fill(0);
    if (fillerBytes < 0) throw new Error("Protected interaction fixture exceeded its byte limit.");
    const exactAuthority = {
      ...protectedDocument.authority,
      additionalPermissions: "a".repeat(fillerBytes),
    };
    value.codex.interactionAuthority = exactAuthority;
    const exactInspected = protectedInteractionDetailDocumentSchema.parse(
      await value.service.execute(inspectCommand, { signal }),
    );
    const exactEncoded = encodeProtectedInteractionDetailDocument(exactInspected);
    expect(exactEncoded.byteLength).toBe(PROTECTED_INTERACTION_DETAIL_MAXIMUM_BYTES);
    exactEncoded.fill(0);

    value.codex.interactionAuthority = {
      ...exactAuthority,
      additionalPermissions: `${exactAuthority.additionalPermissions}a`,
    };
    await expect(value.service.execute(inspectCommand, { signal })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    for (const unavailableDecision of ["session", "decline"] as const) {
      await expect(value.service.execute({
        kind: "interaction.resolve",
        interaction: interaction.id,
        expectedRevision: interaction.revision,
        resolution: { kind: "approval_decision", decision: unavailableDecision },
      }, { signal })).rejects.toMatchObject({ code: "INVALID_INPUT" });
      expect(value.store.requireInteraction(interaction.id)).toMatchObject({
        state: "pending",
        revision: interaction.revision,
      });
      expect(value.codex.resolvedInteractions).toHaveLength(0);
    }

    const resolveCommand = {
      kind: "interaction.resolve",
      interaction: interaction.id,
      expectedRevision: interaction.revision,
      resolution: { kind: "approval_decision", decision: "once" },
    } satisfies LocalCommand;
    const resolved = await value.service.execute(resolveCommand, { signal });
    expect(resolved).toMatchObject({
      responseWritten: true,
      interaction: { id: interaction.id, state: "response_written", revision: 3 },
    });
    expect(renderHuman(resolveCommand, resolved)).toContain("State: response_written");
    expect(renderJson(resolveCommand, resolved)).not.toContain("responseDigest");
    expect(value.codex.resolvedInteractions).toHaveLength(1);
    expect(value.codex.resolvedInteractions[0]).toMatchObject({
      provider,
      kind: "command_approval",
      resolution: { kind: "approval_decision", decision: "once" },
    });
    await value.service.observeCodexFact(authority, {
      type: "interactionResolved",
      connectionId: provider.connectionId,
      provider,
      kind: "command_approval",
    });
    expect(value.store.requireInteraction(interaction.id)).toMatchObject({
      state: "resolved",
      revision: 4,
    });

    const mcpFormProvider = {
      ...provider,
      requestId: { type: "string" as const, value: "mcp-form-request-1" },
      method: "mcpServer/elicitation/request",
      requestDigest: "b".repeat(64),
      itemId: null,
      approvalId: null,
    };
    await value.service.observeCodexFact(authority, {
      type: "interactionRequested",
      connectionId: provider.connectionId,
      provider: mcpFormProvider,
      kind: "mcp_elicitation",
      blocking: true,
      display: {
        kind: "mcp_elicitation",
        summary: "credential=TOPSECRET-9415",
        serverName: "example",
        mode: "form",
        url: null,
        mayContainSecrets: true,
        fields: [
          {
            name: "token",
            type: "string",
            required: true,
            minLength: 8,
            maxLength: 64,
            format: null,
          },
          { name: "confirmed", type: "boolean", required: true },
        ],
      },
    });
    const mcpForm = value.store.listInteractions({ sessionId, pendingOnly: true, limit: 10 })
      .find((record) => record.authority.requestId.value === "mcp-form-request-1");
    if (mcpForm === undefined) throw new Error("Expected a standard MCP form interaction.");
    expect(mcpForm.display.summary).toBe("Codex requests MCP form input");
    expect(JSON.stringify(value.store.listSessionEvents({
      sessionId,
      afterSequence: 0,
    }).events)).not.toContain("TOPSECRET-9415");
    const submittedSentinel = "MCP_SERVICE_SUBMISSION_SECRET_SENTINEL";
    await expect(value.service.execute({
      kind: "interaction.resolve",
      interaction: mcpForm.publicId,
      expectedRevision: mcpForm.revision,
      resolution: {
        kind: "mcp_submission",
        action: "accept",
        content: { token: submittedSentinel, confirmed: "yes" },
      },
    }, { signal })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(value.store.requireInteraction(mcpForm.publicId)).toMatchObject({
      state: "pending",
      revision: 1,
      responseDigest: null,
    });
    expect(value.codex.resolvedInteractions).toHaveLength(1);
    const completedMcpForm = await value.service.execute({
      kind: "interaction.resolve",
      interaction: mcpForm.publicId,
      expectedRevision: mcpForm.revision,
      resolution: {
        kind: "mcp_submission",
        action: "accept",
        content: { token: "protected-value", confirmed: true },
      },
    }, { signal });
    expect(completedMcpForm).toMatchObject({
      interaction: { id: mcpForm.publicId, state: "response_written", revision: 3 },
    });
    expect(value.codex.resolvedInteractions).toHaveLength(2);
    await value.service.observeCodexFact(authority, {
      type: "interactionResolved",
      connectionId: provider.connectionId,
      provider: mcpFormProvider,
      kind: "mcp_elicitation",
    });
    expect(value.store.requireInteraction(mcpForm.publicId)).toMatchObject({
      state: "resolved",
      revision: 4,
    });
    expect(JSON.stringify(value.store.listInteractions({ limit: 100 })))
      .not.toContain(submittedSentinel);
    expect(JSON.stringify(value.store.listInteractions({ limit: 100 })))
      .not.toContain("protected-value");

    const missingFieldsProvider = {
      ...mcpFormProvider,
      requestId: { type: "string" as const, value: "mcp-missing-fields-request" },
      requestDigest: "d".repeat(64),
    };
    await expect(value.service.observeCodexFact(authority, {
      type: "interactionRequested",
      connectionId: provider.connectionId,
      provider: missingFieldsProvider,
      kind: "mcp_elicitation",
      blocking: true,
      display: {
        kind: "mcp_elicitation",
        summary: "Incomplete MCP form",
        serverName: "example",
        mode: "form",
        url: null,
        mayContainSecrets: true,
      },
    })).rejects.toThrow("MCP_FORM_DISPLAY_CONTRACT_MISSING");
    expect(value.store.listInteractions({ limit: 100 }).some((record) =>
      record.authority.requestId.value === "mcp-missing-fields-request")).toBe(false);

    const secretUrl = "https://example.com/authorize?token=SECRET_SENTINEL";
    const mcpProvider = {
      ...provider,
      requestId: { type: "string" as const, value: "mcp-request-1" },
      method: "mcpServer/elicitation/request",
      requestDigest: "c".repeat(64),
      itemId: null,
      approvalId: null,
    };
    const unsafeUrlFact = {
      type: "interactionRequested",
      connectionId: provider.connectionId,
      provider: mcpProvider,
      kind: "mcp_elicitation",
      blocking: true,
      display: {
        kind: "mcp_elicitation",
        summary: "Authorize the MCP server",
        serverName: "example",
        mode: "url",
        url: secretUrl,
        mayContainSecrets: true,
      },
    } as unknown as CodexFact;
    await expect(value.service.observeCodexFact(authority, unsafeUrlFact)).rejects.toThrow();
    const mcpRecord = value.store.listInteractions({
      sessionId,
      pendingOnly: true,
      limit: 10,
    }).find((record) => record.kind === "mcp_elicitation");
    expect(mcpRecord).toBeUndefined();
    expect(JSON.stringify(value.store.listInteractions({ limit: 100 })))
      .not.toContain("SECRET_SENTINEL");
  });
for (const timing of ["before", "after"] as const) {
    test(`quarantines a committed provider-resolution event boundary ${timing} event insertion`, async () => {
    let stopCalls = 0;
    const value = await fixture(new FakeCloud(),
      () => { stopCalls += 1; },
    );
    const { sessionId } = await createIdleSession(value, "Provider resolution persistence");
    const seeded = await seedResolvableInteraction(
      value,
      sessionId,
      "provider-resolution-persistence",
    );
    await value.service.execute({
      kind: "interaction.resolve",
      interaction: seeded.interaction.publicId,
      expectedRevision: seeded.interaction.revision,
      resolution: { kind: "approval_decision", decision: "once" },
    }, { signal });
    const peer = await seedResolvableInteraction(
      value,
      sessionId,
      "provider-resolution-peer",
    );
    const originalAppend = value.store.appendSessionEvent.bind(value.store);
    let injected = false;
    (value.store as unknown as {
      appendSessionEvent: StateStore["appendSessionEvent"];
    }).appendSessionEvent = (input) => {
      if (
        !injected
        && input.body.type === "interaction_state"
        && input.body.interactionId === seeded.interaction.publicId
        && input.body.state === "resolved"
      ) {
        injected = true;
        if (timing === "after") originalAppend(input);
        throw new Error(`injected ${timing} provider-resolution event fault`);
      }
      return originalAppend(input);
    };

    await expect(value.service.observeCodexFact(seeded.authority, {
      type: "interactionResolved",
      connectionId: seeded.interaction.authority.connectionId,
      provider: seeded.interaction.authority,
      kind: "command_approval",
    })).rejects.toMatchObject({ name: "InteractionPersistenceBoundaryError" });

    expect(injected).toBe(true);
    expect(value.store.requireInteraction(seeded.interaction.publicId)).toMatchObject({
      state: "resolved",
      revision: 4,
    });
    expect(value.store.requireInteraction(peer.interaction.publicId)).toMatchObject({
      state: "expired",
      revision: 2,
    });
    expect(value.store.requireProfileById(seeded.authority.id).processGeneration)
      .toBe(seeded.authority.generation + 1);
    const focalTerminalEvents = value.store.listSessionEvents({
      sessionId,
      afterSequence: 0,
    }).events.filter((event) =>
      event.body.type === "interaction_state"
      && event.body.interactionId === seeded.interaction.publicId
      && event.body.revision === 4
    );
    expect(focalTerminalEvents).toHaveLength(1);
    expect(focalTerminalEvents[0]?.body).toEqual({
      type: "interaction_state",
      interactionId: seeded.interaction.publicId,
      state: "resolved",
      revision: 4,
    });
    await Bun.sleep(10);
    expect(stopCalls).toBe(1);

    const restartVisible = new StateStore(value.paths, { readonly: true });
    try {
      expect(restartVisible.requireInteraction(seeded.interaction.publicId)).toMatchObject({
        state: "resolved",
      });
      expect(restartVisible.requireInteraction(peer.interaction.publicId)).toMatchObject({
        state: "expired",
      });
      expect(restartVisible.listSessionEvents({
        sessionId,
        afterSequence: 0,
      }).events.filter((event) =>
        event.body.type === "interaction_state"
        && event.body.interactionId === seeded.interaction.publicId
        && event.body.revision === 4
      )).toHaveLength(1);
    } finally {
      restartVisible.close();
    }
    await value.service.close();
    });
  }
test("pages signed interaction listings and caps the separate status summary", async () => {
    const value = await fixture(new FakeCloud(), () => undefined, () => 200_000);
    const { sessionId } = await createIdleSession(value, "Interaction pagination");
    const session = value.store.requireSession(sessionId);
    const profile = value.store.requireProfileById(session.profileId);
    if (session.providerThreadId === undefined) throw new Error("Expected a bound session.");
    const publicIds: string[] = [];
    for (let index = 0; index < 101; index += 1) {
      const publicId = `74000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
      publicIds.push(publicId);
      value.store.admitInteraction({
        publicId,
        sessionId,
        authority: {
          profileId: profile.id,
          processGeneration: profile.processGeneration,
          ...codexInteractionBinding(value.store, profile.id),
          connectionId: "74000000-0000-4000-8000-999999999999",
          requestId: { type: "number", value: index },
          method: "item/commandExecution/requestApproval",
          requestDigest: index.toString(16).padStart(64, "0"),
          threadId: session.providerThreadId,
          turnId: `turn-page-${String(index)}`,
          itemId: `item-page-${String(index)}`,
          approvalId: null,
        },
        kind: "command_approval",
        blocking: true,
        display: {
          kind: "command_approval",
          summary: `Page interaction ${String(index)}`,
          reason: null,
          commandClass: "test",
          workingDirectory: null,
          availableDecisions: ["once", "decline", "cancel"],
        },
        requestedAt: 100_000 + index,
        deadlineAt: 500_000,
      });
    }
    const oldestPublicId = publicIds[0];
    if (oldestPublicId === undefined) throw new Error("Expected a seeded oldest interaction.");

    type InteractionPage = Readonly<{
      interactions: readonly PublicInteraction[];
      nextCursor: string | null;
      sessionId: string | null;
    }>;
    const first = await value.service.execute({
      kind: "session.interactions",
      session: session.title,
      pending: true,
      limit: 100,
    }, { signal }) as InteractionPage;
    expect(first.sessionId).toBe(sessionId);
    expect(first.interactions.map((interaction) => interaction.id)).toEqual(
      [...publicIds].reverse().slice(0, 100),
    );
    expect(first.nextCursor).toBeString();
    if (first.nextCursor === null) throw new Error("Expected an interaction continuation cursor.");

    const status = await value.service.execute({
      kind: "session.status",
      session: sessionId,
    }, { signal }) as SessionStatus;
    expect(status.interactions).toMatchObject({
      pendingCount: 101,
      responseInFlightCount: 0,
      truncated: true,
    });
    expect(status.interactions.pending.map((interaction) => interaction.id)).toEqual(
      publicIds.slice(0, 10),
    );
    expect(status.eventStream.cursor).not.toBe(first.nextCursor);

    const second = await value.service.execute({
      kind: "session.interactions",
      session: sessionId,
      pending: true,
      limit: 100,
      cursor: first.nextCursor,
    }, { signal }) as InteractionPage;
    expect(second.sessionId).toBe(sessionId);
    expect(second.nextCursor).toBeNull();
    expect(second.interactions.map((interaction) => interaction.id)).toEqual([oldestPublicId]);
    const oldest = second.interactions[0];
    if (oldest === undefined) throw new Error("Expected to discover the oldest interaction.");

    const global = await value.service.execute({
      kind: "interaction.list",
      pending: true,
      limit: 100,
    }, { signal }) as InteractionPage;
    expect(global.sessionId).toBeNull();
    expect(global.nextCursor).toBeString();
    if (global.nextCursor === null) throw new Error("Expected a global interaction continuation cursor.");

    const otherSessionId = value.store.createSession({
      profileId: profile.id,
      title: "Other interaction session",
      preset: "high",
      fastEnabled: false,
    }).id;
    for (const command of [
      {
        kind: "session.interactions",
        session: otherSessionId,
        pending: true,
        limit: 100,
        cursor: first.nextCursor,
      },
      {
        kind: "session.interactions",
        session: sessionId,
        pending: false,
        limit: 100,
        cursor: first.nextCursor,
      },
      {
        kind: "session.interactions",
        session: sessionId,
        pending: true,
        limit: 100,
        cursor: global.nextCursor,
      },
      {
        kind: "session.interactions",
        session: sessionId,
        pending: true,
        limit: 100,
        cursor: `${first.nextCursor}x`,
      },
    ] as const) {
      await expect(value.service.execute(command, { signal })).rejects.toMatchObject({
        code: "INVALID_INPUT",
      });
    }

    const resolved = await value.service.execute({
      kind: "interaction.resolve",
      interaction: oldest.id,
      expectedRevision: oldest.revision,
      resolution: { kind: "approval_decision", decision: "once" },
    }, { signal });
    expect(resolved).toMatchObject({
      responseWritten: true,
      interaction: { id: oldestPublicId, state: "response_written" },
    });
  });
test("session status separates pending summaries from responses in flight and reports queue axes", async () => {
    const value = await fixture(new FakeCloud(), () => undefined, () => 200_000);
    const { sessionId } = await createIdleSession(value, "Unsettled status");
    const seeded = seedUnsettledInteractionStates(
      value,
      sessionId,
      "75000000-0000-4000-8000-000000000001",
      "status-unsettled",
    );
    const pendingQueue = value.store.enqueue(sessionId, "Pending queue status");
    const dispatchingQueue = value.store.enqueue(sessionId, "Dispatching queue status");
    const ambiguousQueue = value.store.enqueue(sessionId, "Ambiguous queue status");
    const failedQueue = value.store.enqueue(sessionId, "Failed queue status");
    expect(value.store.transitionQueue(dispatchingQueue.id, "pending", "dispatching")).toBe(true);
    expect(value.store.transitionQueue(ambiguousQueue.id, "pending", "dispatching")).toBe(true);
    expect(value.store.transitionQueue(ambiguousQueue.id, "dispatching", "ambiguous")).toBe(true);
    expect(value.store.transitionQueue(failedQueue.id, "pending", "dispatching")).toBe(true);
    expect(value.store.transitionQueue(failedQueue.id, "dispatching", "failed")).toBe(true);

    const status = sessionStatusSchema.parse(await value.service.execute({
      kind: "session.status",
      session: sessionId,
    }, { signal }));
    expect(status.interactions).toMatchObject({
      pendingCount: 1,
      responseInFlightCount: 2,
      truncated: false,
    });
    expect(status.interactions.pending).toEqual([{
      id: seeded.pending.publicId,
      kind: seeded.pending.kind,
      revision: seeded.pending.revision,
      blocking: true,
      summary: "Recover pending response state",
      requestedAt: seeded.pending.requestedAt,
      deadlineAt: seeded.pending.deadlineAt,
    }]);
    expect(status.advisory).toEqual({
      attention: "human_action_required",
      execution: "idle",
      queueDepth: 1,
    });
    expect(status.queue).toEqual({
      depth: 1,
      dispatchingCount: 1,
      ambiguousCount: 1,
      failedCount: 1,
    });
    expect(value.store.requireQueue(pendingQueue.id).state).toBe("pending");

    value.store.expireInteraction({
      id: seeded.pending.publicId,
      expectedRevision: seeded.pending.revision,
    });
    const responseInFlightOnly = sessionStatusSchema.parse(await value.service.execute({
      kind: "session.status",
      session: sessionId,
    }, { signal }));
    expect(responseInFlightOnly.interactions).toMatchObject({
      pending: [],
      pendingCount: 0,
      responseInFlightCount: 2,
      truncated: false,
    });
    expect(responseInFlightOnly.advisory.attention).toBe("response_in_flight");
  });
test("preserves quarantined retired interactions without starving supported deadlines or clearing uncertainty", async () => {
    const archive = canonical39RetiredRecoveryFixtures.interaction_deadlines;
    const captured = archive.retained;
    let now = archive.fixedTime;
    const value = await fixture(new FakeCloud(), () => undefined, () => now,
      undefined, {}, { canonical39RetiredRecovery: "interaction_deadlines" });
    // Keep the archived byte image independently readable. The current fixture
    // already performed the real migration and boot, not a restamped downgrade.
    const originalPath = join(value.documents, "canonical39-original.sqlite");
    await writeFile(originalPath, canonical39RetiredRecoveryDatabaseBytes("interaction_deadlines"), { mode: 0o600 });
    const original = new Database(originalPath, { create: false, strict: true });
    original.exec("PRAGMA query_only=ON");
    const inspected = new Database(value.paths.database, { create: false, strict: true });
    inspected.exec("PRAGMA query_only=ON");
    try {
      const columns = original.query("PRAGMA table_info(provider_interactions)").all() as { name: string }[];
      expect(columns.length).toBeGreaterThan(0);
      expect(columns.length).toBeLessThan(64);
      for (const column of columns) expect(column.name).toMatch(/^[a-z_]+$/);
      const select = columns.map(({ name }) => `"${name}"`).join(",");
      const sql = `SELECT ${select} FROM provider_interactions WHERE profile_id=? ORDER BY public_id LIMIT 35`;
      const originalRows = original.query(sql).all(captured.profile.id) as Array<Record<string, unknown> & {
        state: string; session_id: string | null; revision: number;
      }>;
      expect(originalRows).toHaveLength(34);
      const expectedRows = originalRows.map((row) => row.state === "pending" && row.session_id === null
        ? { ...row, state: "expired", revision: row.revision + 1, updated_at: now, terminal_at: now }
        : row);
      // Only exact-method orphan pending callbacks gain a sidecar and expire
      // at boot. Bound callbacks lack an original turn authority: quarantine
      // retains every cell, including prepared responses and unknown outcomes.
      const retainedRows = () => JSON.stringify(inspected.query(sql).all(captured.profile.id));
      const expectedBytes = JSON.stringify(expectedRows);
      expect(retainedRows()).toBe(expectedBytes);
      expect(value.store.requireInteraction(captured.unknown.publicId)).toMatchObject(captured.unknown);
      expect(value.codex.calls).toEqual([]);
      expect(value.codex.validatedInteractionTimeouts).toEqual([]);
      expect(value.codex.timedOutInteractions).toEqual([]);

      // Quarantined records are not live capacity, an armed deadline timer, or
      // an attention notification. Exclusion must happen before each limit.
      expect(value.store.listDueInteractions({ now: now + 1_000, limit: 1 })).toEqual([]);
      expect(value.store.nextInteractionDeadlineAt()).toBeNull();
      expect(value.store.readAttentionNotificationSnapshot({ now, limit: 1 })).toEqual({
        interactions: [], observedAt: now, status: "complete",
      });
      const { sessionId } = await createIdleSession(value, "Supported historical deadlines");
      const session = value.store.requireSession(sessionId);
      const supported = value.store.admitInteraction({
        publicId: crypto.randomUUID(), sessionId,
        authority: {
          ...value.store.requireProviderAccountAuthority(session.profileId, "codex"),
          connectionId: value.codex.observationConnectionId,
          requestId: { type: "string", value: "supported-after-retired" },
          method: "item/commandExecution/requestApproval",
          requestDigest: createHash("sha256").update("supported-after-retired").digest("hex"),
          threadId: session.providerThreadId ?? null,
          turnId: null, itemId: null, approvalId: null,
        },
        kind: "command_approval", blocking: true,
        display: {
          kind: "command_approval", summary: "Supported pending approval", reason: null,
          commandClass: "test", workingDirectory: null,
          availableDecisions: ["once", "decline", "cancel"],
        },
        requestedAt: now, deadlineAt: now + 1_001,
      }).record;
      expect(value.store.readAttentionNotificationSnapshot({ now, limit: 1 })).toEqual({
        interactions: [supported], observedAt: now, status: "complete",
      });
      expect(value.store.nextInteractionDeadlineAt()).toBe(supported.deadlineAt);
      value.codex.calls.length = 0;
      now += 2_000;
      expect(value.store.listDueInteractions({ now, limit: 1 })).toEqual([supported]);
      expect(await value.service.maintainInteractionDeadlines()).toEqual({ examined: 1, failed: 0 });
      expect(value.store.requireInteraction(supported.publicId).state).toBe("expired");
      expect(value.codex.validatedInteractionTimeouts).toHaveLength(1);
      expect(value.codex.timedOutInteractions).toHaveLength(1);
      expect(value.store.nextInteractionDeadlineAt()).toBeNull();
      expect(await value.service.maintainInteractionDeadlines()).toEqual({ examined: 0, failed: 0 });
      expect(retainedRows()).toBe(expectedBytes);
      expect(value.codex.calls.every((call) => call === "readAccount")).toBe(true);
    } finally {
      original.close(false);
      inspected.close(false);
      await value.service.close();
    }
  });
test("expires all callback kinds exactly at their receipt-anchored deadline", async () => {
    let now = 50_000;
    const value = await fixture(new FakeCloud(), () => undefined, () => now);
    const { sessionId } = await createIdleSession(value, "Interaction deadlines");
    const session = value.store.requireSession(sessionId);
    const profile = value.store.requireProfileById(session.profileId);
    if (session.providerThreadId === undefined) throw new Error("Expected a bound session.");
    const authority = liveAuthorityFor(value.store, profile.id);
    const connectionId = value.codex.observationConnectionId;
    const requests = [
      {
        kind: "command_approval" as const,
        method: "item/commandExecution/requestApproval",
        display: {
          kind: "command_approval" as const,
          summary: "Allow command",
          reason: null,
          commandClass: "test",
          workingDirectory: null,
          availableDecisions: ["once" as const, "decline" as const, "cancel" as const],
        },
      },
      {
        kind: "file_change_approval" as const,
        method: "item/fileChange/requestApproval",
        display: {
          kind: "file_change_approval" as const,
          summary: "Allow files",
          reason: null,
          grantRoot: null,
          availableDecisions: ["once" as const, "decline" as const, "cancel" as const],
        },
      },
      {
        kind: "permission_approval" as const,
        method: "item/permissions/requestApproval",
        display: {
          kind: "permission_approval" as const,
          summary: "Allow permissions",
          reason: null,
          requested: [{ name: "network" }],
          allowsSessionScope: false,
        },
      },
      {
        kind: "user_input" as const,
        method: "item/tool/requestUserInput",
        display: {
          kind: "user_input" as const,
          summary: "Codex needs one answer",
          blocking: true,
          questions: [{
            id: "choice",
            header: "Choice",
            question: "Choose",
            options: null,
            allowsOther: true,
            secret: false,
          }],
        },
      },
      {
        kind: "mcp_elicitation" as const,
        method: "mcpServer/elicitation/request",
        display: {
          kind: "mcp_elicitation" as const,
          summary: "Configure MCP",
          serverName: "example",
          mode: "form" as const,
          url: null,
          mayContainSecrets: true as const,
          fields: [],
        },
      },
    ];
    for (const [index, request] of requests.entries()) {
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
          requestId: { type: "number", value: index + 1 },
          method: request.method,
          requestDigest: createHash("sha256").update(request.method).digest("hex"),
          threadId: session.providerThreadId,
          turnId: "turn-deadline",
          itemId: `item-${String(index + 1)}`,
          approvalId: null,
        },
        kind: request.kind,
        blocking: true,
        display: request.display,
        timeoutMs: 1_000,
        requestedAt: 50_000,
        deadlineAt: 51_000,
      });
    }
    now = 50_999;
    expect(await value.service.maintainInteractionDeadlines()).toEqual({ examined: 0, failed: 0 });
    expect(value.codex.timedOutInteractions).toHaveLength(0);
    now = 51_000;
    expect(await value.service.maintainInteractionDeadlines()).toEqual({ examined: 5, failed: 0 });
    expect(value.codex.validatedInteractionTimeouts).toHaveLength(5);
    expect(value.codex.timedOutInteractions).toHaveLength(5);
    expect(value.store.listInteractions({ sessionId, limit: 10 })).toHaveLength(5);
    for (const interaction of value.store.listInteractions({ sessionId, limit: 10 })) {
      expect(interaction).toMatchObject({
        state: "expired",
        revision: 4,
        intendedTerminalState: "expired",
        deadlineAt: 51_000,
      });
    }
    expect(value.store.nextInteractionDeadlineAt()).toBeNull();
    await value.service.close();
  });
test("rejects every manual interaction shape at the exact immutable deadline", async () => {
    let now = 70_000;
    const value = await fixture(new FakeCloud(), () => undefined, () => now);
    const { sessionId } = await createIdleSession(value, "Manual interaction deadlines");
    const session = value.store.requireSession(sessionId);
    const profile = value.store.requireProfileById(session.profileId);
    if (session.providerThreadId === undefined) throw new Error("Expected a bound session.");
    const authority = liveAuthorityFor(value.store, profile.id);
    const providerThreadId = session.providerThreadId;
    const connectionId = value.codex.observationConnectionId;
    const cases = [
      {
        kind: "command_approval" as const,
        method: "item/commandExecution/requestApproval",
        display: {
          kind: "command_approval" as const,
          summary: "Allow command",
          reason: null,
          commandClass: "test",
          workingDirectory: null,
          availableDecisions: ["once" as const, "decline" as const, "cancel" as const],
        },
        resolution: { kind: "approval_decision", decision: "once" } as const,
      },
      {
        kind: "file_change_approval" as const,
        method: "item/fileChange/requestApproval",
        display: {
          kind: "file_change_approval" as const,
          summary: "Allow files",
          reason: null,
          grantRoot: null,
          availableDecisions: ["once" as const, "decline" as const, "cancel" as const],
        },
        resolution: { kind: "approval_decision", decision: "decline" } as const,
      },
      {
        kind: "permission_approval" as const,
        method: "item/permissions/requestApproval",
        display: {
          kind: "permission_approval" as const,
          summary: "Allow permissions",
          reason: null,
          requested: [{ name: "network" }],
          allowsSessionScope: false,
        },
        resolution: {
          kind: "permission_grant",
          permissions: ["network"],
          scope: "turn",
        } as const,
      },
      {
        kind: "user_input" as const,
        method: "item/tool/requestUserInput",
        display: {
          kind: "user_input" as const,
          summary: "Codex needs one answer",
          blocking: true,
          questions: [{
            id: "choice",
            header: "Choice",
            question: "Choose",
            options: null,
            allowsOther: true,
            secret: false,
          }],
        },
        resolution: {
          kind: "user_answers",
          answers: { choice: { answers: ["manual answer"] } },
        } as const,
      },
      {
        kind: "mcp_elicitation" as const,
        method: "mcpServer/elicitation/request",
        display: {
          kind: "mcp_elicitation" as const,
          summary: "Configure MCP",
          serverName: "example",
          mode: "form" as const,
          url: null,
          mayContainSecrets: true as const,
          fields: [],
        },
        resolution: {
          kind: "mcp_submission",
          action: "accept",
          content: {},
        } as const,
      },
    ] satisfies readonly {
      kind: Extract<CodexFact, { type: "interactionRequested" }>["kind"];
      method: string;
      display: Extract<CodexFact, { type: "interactionRequested" }>["display"];
      resolution: InteractionResolution;
    }[];
    const admitRound = async (round: string) => {
      const records = [];
      for (const [index, interactionCase] of cases.entries()) {
        const requestId = `${round}-${String(index + 1)}`;
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
            requestId: { type: "string", value: requestId },
            method: interactionCase.method,
            requestDigest: createHash("sha256").update(requestId).digest("hex"),
            threadId: providerThreadId,
            turnId: `turn-${round}`,
            itemId: `item-${requestId}`,
            approvalId: null,
          },
          kind: interactionCase.kind,
          blocking: true,
          display: interactionCase.display,
          requestedAt: 70_000,
          deadlineAt: 71_000,
        });
        const record = value.store.listInteractions({ sessionId, limit: 100 })
          .find((candidate) => candidate.authority.requestId.value === requestId);
        if (record === undefined) throw new Error("Expected an admitted deadline interaction.");
        records.push(record);
      }
      return records;
    };

    const beforeBoundary = await admitRound("before");
    now = 70_999;
    for (const [index, interaction] of beforeBoundary.entries()) {
      const interactionCase = cases[index];
      if (interactionCase === undefined) throw new Error("Expected a manual resolution case.");
      if (interactionCase.kind === "file_change_approval") {
        await expect(value.service.execute({
          kind: "interaction.resolve",
          interaction: interaction.publicId,
          expectedRevision: interaction.revision,
          resolution: { kind: "approval_decision", decision: "once" },
        }, { signal })).rejects.toMatchObject({ code: "INVALID_INPUT" });
      }
      await expect(value.service.execute({
        kind: "interaction.resolve",
        interaction: interaction.publicId,
        expectedRevision: interaction.revision,
        resolution: interactionCase.resolution,
      }, { signal })).resolves.toMatchObject({
        interaction: { state: "response_written", revision: 3 },
        responseWritten: true,
      });
    }
    expect(value.codex.resolvedInteractions).toHaveLength(cases.length);

    const atBoundary = await admitRound("boundary");
    now = 71_000;
    for (const [index, interaction] of atBoundary.entries()) {
      const interactionCase = cases[index];
      if (interactionCase === undefined) throw new Error("Expected a manual resolution case.");
      await expect(value.service.execute({
        kind: "interaction.resolve",
        interaction: interaction.publicId,
        expectedRevision: interaction.revision,
        resolution: interactionCase.resolution,
      }, { signal })).rejects.toMatchObject({
        code: "CONFLICT",
        details: { interaction: { state: "expired", revision: 4 } },
      });
    }
    expect(value.codex.resolvedInteractions).toHaveLength(cases.length);
    expect(value.codex.validatedInteractionTimeouts).toHaveLength(cases.length);
    expect(value.codex.timedOutInteractions).toHaveLength(cases.length);
    for (const interaction of atBoundary) {
      expect(value.store.requireInteraction(interaction.publicId)).toMatchObject({
        state: "expired",
        intendedTerminalState: "expired",
        deadlineAt: 71_000,
      });
    }
    await value.service.close();
  });
test("expires a manual resolution when validation crosses the deadline before dispatch", async () => {
    let now = 80_000;
    const value = await fixture(new FakeCloud(), () => undefined, () => now);
    const { sessionId } = await createIdleSession(value, "Deadline validation race");
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
        requestId: { type: "string", value: "validation-deadline" },
        method: "item/commandExecution/requestApproval",
        requestDigest: "d".repeat(64),
        threadId: session.providerThreadId,
        turnId: "turn-validation-deadline",
        itemId: "item-validation-deadline",
        approvalId: null,
      },
      kind: "command_approval",
      blocking: true,
      display: {
        kind: "command_approval",
        summary: "Allow command before deadline",
        reason: null,
        commandClass: "test",
        workingDirectory: null,
        availableDecisions: ["once" as const, "decline" as const, "cancel" as const],
      },
      requestedAt: 80_000,
      deadlineAt: 81_000,
    });
    const interaction = value.store.listInteractions({ sessionId, pendingOnly: true })[0];
    if (interaction === undefined) throw new Error("Expected a pending interaction.");
    now = 80_999;
    value.codex.beforeValidateInteractionResolutionReturn = async () => {
      now = 81_000;
    };
    await expect(value.service.execute({
      kind: "interaction.resolve",
      interaction: interaction.publicId,
      expectedRevision: interaction.revision,
      resolution: { kind: "approval_decision", decision: "once" },
    }, { signal })).rejects.toMatchObject({
      code: "CONFLICT",
      details: { interaction: { state: "expired", revision: 4 } },
    });
    expect(value.codex.validatedInteractions).toHaveLength(1);
    expect(value.codex.resolvedInteractions).toHaveLength(0);
    expect(value.codex.timedOutInteractions).toHaveLength(1);
    expect(value.store.requireInteraction(interaction.publicId)).toMatchObject({
      state: "expired",
      intendedTerminalState: "expired",
      deadlineAt: 81_000,
    });
    await value.service.close();
  });
test("does not dispatch a response prepared on the deadline clock edge", async () => {
    let baseNow = 90_000;
    const now = () => baseNow;
    const value = await fixture(new FakeCloud(), () => undefined, now);
    const { sessionId } = await createIdleSession(value, "Deadline prepare edge");
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
        requestId: { type: "string", value: "prepare-deadline" },
        method: "item/commandExecution/requestApproval",
        requestDigest: "f".repeat(64),
        threadId: session.providerThreadId,
        turnId: "turn-prepare-deadline",
        itemId: "item-prepare-deadline",
        approvalId: null,
      },
      kind: "command_approval",
      blocking: true,
      display: {
        kind: "command_approval",
        summary: "Apply before deadline",
        reason: null,
        commandClass: "test",
        workingDirectory: null,
        availableDecisions: ["once" as const, "decline" as const, "cancel" as const],
      },
      requestedAt: 90_000,
      deadlineAt: 91_000,
    });
    const interaction = value.store.listInteractions({ sessionId, pendingOnly: true })[0];
    if (interaction === undefined) throw new Error("Expected a pending interaction.");
    baseNow = 90_999;
    const prepareResponse = value.store.prepareInteractionResponse.bind(value.store);
    let preparedAtBoundary = false;
    value.store.prepareInteractionResponse = (input) => {
      const prepared = prepareResponse(input);
      if (input.id === interaction.publicId && input.intendedTerminalState === "resolved") {
        expect(prepared.state).toBe("response_prepared");
        expect(prepared.updatedAt).toBe(90_999);
        preparedAtBoundary = true;
        baseNow = 91_000;
      }
      return prepared;
    };
    const deadlineFailure = await value.service.execute({
      kind: "interaction.resolve",
      interaction: interaction.publicId,
      expectedRevision: interaction.revision,
      resolution: { kind: "approval_decision", decision: "once" },
    }, { signal }).then(
      () => null,
      (error: unknown) => error,
    );
    value.store.prepareInteractionResponse = prepareResponse;
    expect(preparedAtBoundary).toBe(true);
    expect(deadlineFailure).toBeInstanceOf(CommandFailure);
    expect(deadlineFailure).toMatchObject({ code: "CONFLICT" });
    expect((deadlineFailure as CommandFailure).details).toMatchObject({
      interaction: { state: "expired", revision: 5 },
    });
    expect(value.codex.validatedInteractions).toHaveLength(1);
    expect(value.codex.validatedInteractionTimeouts).toHaveLength(1);
    expect(value.codex.timedOutInteractions).toHaveLength(1);
    expect(value.codex.resolvedInteractions).toHaveLength(0);
    expect(value.store.requireInteraction(interaction.publicId)).toMatchObject({
      state: "expired",
      intendedTerminalState: "expired",
      revision: 5,
      deadlineAt: 91_000,
    });
    await value.service.close();
  });
test("settles a manual response unknown when account authority changes after the provider write", async () => {
    const now = 95_000;
    const value = await fixture(new FakeCloud(), () => undefined, () => now);
    const { sessionId } = await createIdleSession(value, "Interaction post-write account fence");
    const seeded = await seedResolvableInteraction(
      value,
      sessionId,
      "interaction-post-write-account-fence",
      { requestedAt: now, deadlineAt: now + 1_000 },
    );
    const queued = value.store.enqueue(sessionId, "must fence with the account callback");
    let callbackFence: {
      interactionState: string;
      profileState: string;
      queueState: string;
      sessionState: string;
    } | undefined;
    let finishRelease!: () => void;
    const releaseGate = new Promise<void>((resolve) => {
      finishRelease = resolve;
    });
    value.codex.beforeReleaseOwnedAuthorityReturn = async () => await releaseGate;
    value.codex.beforeResolveInteractionReturn = async () => {
      value.codex.accountProjection = {
        signedIn: true,
        email: "replacement-after-response@example.com",
        plan: "Plus",
      };
      await expect(value.service.observeCodexAccount(
        seeded.authority,
        value.codex.accountProjection,
      )).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
      callbackFence = {
        interactionState: value.store.requireInteraction(seeded.interaction.publicId).state,
        profileState: value.store.requireProfileById(seeded.authority.id).state,
        queueState: value.store.requireQueue(queued.id).state,
        sessionState: value.store.requireSession(sessionId).state,
      };
    };

    await expect(value.service.execute({
      kind: "interaction.resolve",
      interaction: seeded.interaction.publicId,
      expectedRevision: seeded.interaction.revision,
      resolution: { kind: "approval_decision", decision: "once" },
    }, { signal })).rejects.toMatchObject({
      code: "RECOVERY_REQUIRED",
      details: {
        interaction: {
          id: seeded.interaction.publicId,
          state: "resolution_unknown",
        },
      },
    });
    expect(value.codex.resolvedInteractions).toHaveLength(1);
    expect(value.store.requireInteraction(seeded.interaction.publicId)).toMatchObject({
      state: "resolution_unknown",
      intendedTerminalState: "resolved",
    });
    finishRelease();
    expect(callbackFence).toEqual({
      interactionState: "resolution_unknown",
      profileState: "recovery_required",
      queueState: "cancelled",
      sessionState: "recovery_required",
    });
    await value.service.settled();
    await value.service.close();
  });
test("settles a deadline timeout unknown when account authority changes after its provider write", async () => {
    let now = 96_000;
    const value = await fixture(new FakeCloud(), () => undefined, () => now);
    const { sessionId } = await createIdleSession(value, "Deadline timeout post-write account fence");
    const seeded = await seedResolvableInteraction(
      value,
      sessionId,
      "deadline-timeout-post-write-account-fence",
      { requestedAt: now, deadlineAt: now + 1_000 },
    );
    value.codex.beforeResolveInteractionReturn = async () => {
      now = 97_000;
    };
    value.codex.resolveInteractionError = new CodexError(
      "DEADLINE_EXPIRED",
      "the final manual write reached its deadline",
    );
    value.codex.beforeTimeoutInteractionReturn = async () => {
      value.codex.accountProjection = {
        signedIn: true,
        email: "replacement-after-deadline-timeout@example.com",
        plan: "Plus",
      };
    };

    await expect(value.service.execute({
      kind: "interaction.resolve",
      interaction: seeded.interaction.publicId,
      expectedRevision: seeded.interaction.revision,
      resolution: { kind: "approval_decision", decision: "once" },
    }, { signal })).rejects.toMatchObject({
      code: "RECOVERY_REQUIRED",
      details: {
        interaction: {
          id: seeded.interaction.publicId,
          state: "resolution_unknown",
        },
      },
    });
    expect(value.codex.timedOutInteractions).toHaveLength(1);
    expect(value.store.requireInteraction(seeded.interaction.publicId)).toMatchObject({
      state: "resolution_unknown",
      intendedTerminalState: "expired",
    });
    await value.service.settled();
    await value.service.close();
  });
test("settles maintenance timeout unknown when account authority changes after its provider write", async () => {
    let now = 98_000;
    const value = await fixture(new FakeCloud(), () => undefined, () => now);
    const { sessionId } = await createIdleSession(value, "Maintenance timeout post-write account fence");
    const seeded = await seedResolvableInteraction(
      value,
      sessionId,
      "maintenance-timeout-post-write-account-fence",
      { requestedAt: now, deadlineAt: now + 1_000 },
    );
    value.codex.beforeTimeoutInteractionReturn = async () => {
      value.codex.accountProjection = {
        signedIn: true,
        email: "replacement-after-maintenance-timeout@example.com",
        plan: "Plus",
      };
    };
    now = 99_000;

    await expect(value.service.maintainInteractionDeadlines())
      .resolves.toEqual({ examined: 1, failed: 0 });
    expect(value.codex.timedOutInteractions).toHaveLength(1);
    expect(value.store.requireInteraction(seeded.interaction.publicId)).toMatchObject({
      state: "resolution_unknown",
      intendedTerminalState: "expired",
    });
    await value.service.settled();
    await value.service.close();
  });
test("turns a client final-boundary deadline rejection into one durable neutral timeout", async () => {
    let now = 100_000;
    const value = await fixture(new FakeCloud(), () => undefined, () => now);
    const { sessionId } = await createIdleSession(value, "Client deadline boundary");
    const session = value.store.requireSession(sessionId);
    const profile = value.store.requireProfileById(session.profileId);
    if (session.providerThreadId === undefined) throw new Error("Expected a bound session.");
    const authority = liveAuthorityFor(value.store, profile.id);
    const connectionId = value.codex.observationConnectionId;
    const admit = async (requestId: string, requestedAt: number, deadlineAt: number) => {
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
          requestId: { type: "string", value: requestId },
          method: "item/commandExecution/requestApproval",
          requestDigest: createHash("sha256").update(requestId).digest("hex"),
          threadId: session.providerThreadId as string,
          turnId: `turn-${requestId}`,
          itemId: `item-${requestId}`,
          approvalId: null,
        },
        kind: "command_approval",
        blocking: true,
        display: {
          kind: "command_approval",
          summary: "Allow before the final write boundary",
          reason: null,
          commandClass: "test",
          workingDirectory: null,
          availableDecisions: ["once", "decline", "cancel"],
        },
        requestedAt,
        deadlineAt,
      });
      const interaction = value.store.listInteractions({ sessionId, pendingOnly: true, limit: 10 })
        .find((candidate) => candidate.authority.requestId.value === requestId);
      if (interaction === undefined) throw new Error("Expected a pending interaction.");
      return interaction;
    };

    const closed = await admit("client-deadline-success", 100_000, 101_000);
    now = 100_999;
    value.codex.beforeResolveInteractionReturn = async () => { now = 101_000; };
    value.codex.resolveInteractionError = new CodexError(
      "DEADLINE_EXPIRED",
      "the final serialized write guard rejected the manual response",
    );
    await expect(value.service.execute({
      kind: "interaction.resolve",
      interaction: closed.publicId,
      expectedRevision: closed.revision,
      resolution: { kind: "approval_decision", decision: "once" },
    }, { signal })).rejects.toMatchObject({
      code: "CONFLICT",
      details: { interaction: { state: "expired", revision: 5 } },
    });
    expect(value.codex.resolvedInteractions.at(-1)).toMatchObject({ deadlineAt: 101_000 });
    expect(value.codex.validatedInteractionTimeouts).toHaveLength(1);
    expect(value.codex.timedOutInteractions).toHaveLength(1);

    now = 110_000;
    const unknown = await admit("client-deadline-unknown", 110_000, 111_000);
    now = 110_999;
    value.codex.beforeResolveInteractionReturn = async () => { now = 111_000; };
    value.codex.timeoutInteractionError = new CodexError(
      "INDETERMINATE_EFFECT",
      "the timeout write may have reached the provider",
    );
    await expect(value.service.execute({
      kind: "interaction.resolve",
      interaction: unknown.publicId,
      expectedRevision: unknown.revision,
      resolution: { kind: "approval_decision", decision: "once" },
    }, { signal })).rejects.toMatchObject({
      code: "RECOVERY_REQUIRED",
      details: { interaction: { state: "resolution_unknown", revision: 4 } },
      message: "The timeout response may have reached the provider; its resolution is unknown.",
    });
    expect(value.store.requireInteraction(unknown.publicId)).toMatchObject({
      state: "resolution_unknown",
      intendedTerminalState: "expired",
      revision: 4,
    });
    expect(value.codex.timedOutInteractions).toHaveLength(2);
    await value.service.close();
  });
test("quarantines automatic timeout persistence after the provider accepts the timeout", async () => {
    const now = 120_000;
    let stopCalls = 0;
    const value = await fixture(new FakeCloud(),
      () => { stopCalls += 1; },
      () => now,
    );
    const { sessionId } = await createIdleSession(value, "Automatic timeout persistence");
    const session = value.store.requireSession(sessionId);
    const profile = value.store.requireProfileById(session.profileId);
    if (session.providerThreadId === undefined) throw new Error("Expected a bound session.");
    const interaction = value.store.admitInteraction({
      publicId: crypto.randomUUID(),
      sessionId,
      authority: {
        profileId: profile.id,
        processGeneration: profile.processGeneration,
        ...codexInteractionBinding(value.store, profile.id),
        connectionId: "46100000-0000-4000-8000-000000000001",
        requestId: { type: "string", value: "automatic-timeout-persistence" },
        method: "item/commandExecution/requestApproval",
        requestDigest: "a".repeat(64),
        threadId: session.providerThreadId,
        turnId: "turn-automatic-timeout-persistence",
        itemId: "item-automatic-timeout-persistence",
        approvalId: null,
      },
      kind: "command_approval",
      blocking: true,
      display: {
        kind: "command_approval",
        summary: "Expire at the automatic timeout boundary",
        reason: null,
        commandClass: "test",
        workingDirectory: null,
        availableDecisions: ["once", "decline", "cancel"],
      },
      requestedAt: now,
      deadlineAt: now,
    }).record;
    const originalMark = value.store.markInteractionResponseWritten.bind(value.store);
    let injected = false;
    (value.store as unknown as {
      markInteractionResponseWritten: StateStore["markInteractionResponseWritten"];
    }).markInteractionResponseWritten = (input) => {
      if (injected) return originalMark(input);
      injected = true;
      throw new Error("injected automatic timeout mark failure");
    };

    expect(await value.service.maintainInteractionDeadlines()).toEqual({
      examined: 1,
      failed: 1,
    });
    expect(injected).toBe(true);
    expect(value.codex.timedOutInteractions).toHaveLength(1);
    expect(value.store.requireInteraction(interaction.publicId)).toMatchObject({
      state: "resolution_unknown",
      intendedTerminalState: "expired",
      revision: 3,
    });
    expect(value.store.requireProfileById(profile.id).processGeneration)
      .toBe(profile.processGeneration + 1);
    await Bun.sleep(10);
    expect(stopCalls).toBe(1);
    await value.service.close();
  });
test("repairs a final automatic-timeout event failure before retiring the provider generation", async () => {
    const now = 125_000;
    let stopCalls = 0;
    const value = await fixture(new FakeCloud(),
      () => { stopCalls += 1; },
      () => now,
    );
    const { sessionId } = await createIdleSession(value, "Automatic timeout terminal event");
    const session = value.store.requireSession(sessionId);
    const profile = value.store.requireProfileById(session.profileId);
    if (session.providerThreadId === undefined) throw new Error("Expected a bound session.");
    const interaction = value.store.admitInteraction({
      publicId: crypto.randomUUID(),
      sessionId,
      authority: {
        profileId: profile.id,
        processGeneration: profile.processGeneration,
        ...codexInteractionBinding(value.store, profile.id),
        connectionId: "46150000-0000-4000-8000-000000000001",
        requestId: { type: "string", value: "automatic-timeout-terminal-event" },
        method: "item/commandExecution/requestApproval",
        requestDigest: "b".repeat(64),
        threadId: session.providerThreadId,
        turnId: "turn-automatic-timeout-terminal-event",
        itemId: "item-automatic-timeout-terminal-event",
        approvalId: null,
      },
      kind: "command_approval",
      blocking: true,
      display: {
        kind: "command_approval",
        summary: "Expire with one durable terminal event",
        reason: null,
        commandClass: "test",
        workingDirectory: null,
        availableDecisions: ["once", "decline", "cancel"],
      },
      requestedAt: now,
      deadlineAt: now,
    }).record;
    const originalAppend = value.store.appendSessionEvent.bind(value.store);
    let injected = false;
    (value.store as unknown as {
      appendSessionEvent: StateStore["appendSessionEvent"];
    }).appendSessionEvent = (input) => {
      if (
        !injected
        && input.body.type === "interaction_state"
        && input.body.interactionId === interaction.publicId
        && input.body.state === "expired"
      ) {
        injected = true;
        throw new Error("injected pre-insert automatic timeout terminal event fault");
      }
      return originalAppend(input);
    };

    expect(await value.service.maintainInteractionDeadlines()).toEqual({
      examined: 1,
      failed: 1,
    });
    expect(injected).toBe(true);
    expect(value.codex.timedOutInteractions).toHaveLength(1);
    expect(value.store.requireInteraction(interaction.publicId)).toMatchObject({
      state: "expired",
      revision: 4,
    });
    expect(value.store.requireProfileById(profile.id).processGeneration)
      .toBe(profile.processGeneration + 1);
    const terminalEvents = value.store.listSessionEvents({
      sessionId,
      afterSequence: 0,
    }).events.filter((event) =>
      event.body.type === "interaction_state"
      && event.body.interactionId === interaction.publicId
      && event.body.revision === 4
    );
    expect(terminalEvents).toHaveLength(1);
    expect(terminalEvents[0]?.body).toEqual({
      type: "interaction_state",
      interactionId: interaction.publicId,
      state: "expired",
      revision: 4,
    });
    await Bun.sleep(10);
    expect(stopCalls).toBe(1);
    await value.service.close();
  });
test("quarantines deadline-supersede persistence after the provider accepts the neutral timeout", async () => {
    let now = 130_000;
    let stopCalls = 0;
    const value = await fixture(new FakeCloud(),
      () => { stopCalls += 1; },
      () => now,
    );
    const { sessionId } = await createIdleSession(value, "Deadline supersede persistence");
    const session = value.store.requireSession(sessionId);
    const profile = value.store.requireProfileById(session.profileId);
    if (session.providerThreadId === undefined) throw new Error("Expected a bound session.");
    const seeded = await seedResolvableInteraction(
      value,
      sessionId,
      "deadline-supersede-persistence",
      { requestedAt: 130_000, deadlineAt: 131_000 },
    );
    now = 130_999;
    value.codex.beforeResolveInteractionReturn = async () => { now = 131_000; };
    value.codex.resolveInteractionError = new CodexError(
      "DEADLINE_EXPIRED",
      "the provider rejected the final manual write at its deadline",
    );
    const originalMark = value.store.markInteractionResponseWritten.bind(value.store);
    let injected = false;
    (value.store as unknown as {
      markInteractionResponseWritten: StateStore["markInteractionResponseWritten"];
    }).markInteractionResponseWritten = (input) => {
      if (injected) return originalMark(input);
      injected = true;
      throw new Error("injected deadline supersede mark failure");
    };
    const afterResponse: Array<() => void> = [];

    await expect(value.service.execute({
      kind: "interaction.resolve",
      interaction: seeded.interaction.publicId,
      expectedRevision: seeded.interaction.revision,
      resolution: { kind: "approval_decision", decision: "once" },
    }, {
      signal,
      afterResponse: (callback) => { afterResponse.push(callback); },
    })).rejects.toMatchObject({
      code: "RECOVERY_REQUIRED",
      details: {
        daemonRestartRequired: true,
        interaction: {
          id: seeded.interaction.publicId,
          state: "resolution_unknown",
        },
      },
    });
    expect(injected).toBe(true);
    expect(value.codex.resolvedInteractions).toHaveLength(1);
    expect(value.codex.timedOutInteractions).toHaveLength(1);
    expect(value.store.requireInteraction(seeded.interaction.publicId)).toMatchObject({
      state: "resolution_unknown",
      intendedTerminalState: "expired",
      revision: 4,
    });
    expect(value.store.requireProfileById(profile.id).processGeneration)
      .toBe(profile.processGeneration + 1);
    expect(afterResponse).toHaveLength(1);
    expect(stopCalls).toBe(0);
    afterResponse[0]?.();
    expect(stopCalls).toBe(1);
    await value.service.close();
  });
test("backs off a persistent deadline maintenance fault and later recovers", async () => {
    const now = 60_000;
    const value = await fixture(new FakeCloud(), () => undefined, () => now);
    const { sessionId } = await createIdleSession(value, "Deadline retry");
    const session = value.store.requireSession(sessionId);
    const profile = value.store.requireProfileById(session.profileId);
    if (session.providerThreadId === undefined) throw new Error("Expected a bound session.");
    const authority = liveAuthorityFor(value.store, profile.id);
    const originalExpire = value.store.expireInteraction.bind(value.store);
    (value.store as unknown as { expireInteraction: StateStore["expireInteraction"] }).expireInteraction = () => {
      throw new Error("injected durable terminalization fault");
    };
    value.codex.validateInteractionTimeoutError = new CodexError(
      "AUTHORITY_STALE",
      "injected stale provider",
    );
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
        requestId: { type: "number", value: 1 },
        method: "item/commandExecution/requestApproval",
        requestDigest: "f".repeat(64),
        threadId: session.providerThreadId,
        turnId: "turn-retry",
        itemId: "item-retry",
        approvalId: null,
      },
      kind: "command_approval",
      blocking: true,
      display: {
        kind: "command_approval",
        summary: "Allow retry test",
        reason: null,
        commandClass: "test",
        workingDirectory: null,
        availableDecisions: ["once" as const, "decline" as const, "cancel" as const],
      },
      timeoutMs: 0,
      requestedAt: now,
      deadlineAt: now,
    });
    await Bun.sleep(25);
    expect(value.codex.validatedInteractionTimeouts.length).toBeLessThanOrEqual(1);
    (value.store as unknown as { expireInteraction: StateStore["expireInteraction"] }).expireInteraction = originalExpire;
    expect(await value.service.maintainInteractionDeadlines()).toEqual({ examined: 1, failed: 0 });
    expect(value.store.listInteractions({ sessionId, pendingOnly: true })).toEqual([]);
    await value.service.close();
  });
test("keeps invalid permission grants pending and supports the fail-safe decline path", async () => {
    const value = await fixture();
    const { sessionId } = await createIdleSession(value, "Permission broker");
    const session = value.store.requireSession(sessionId);
    const profile = value.store.requireProfileById(session.profileId);
    if (session.providerThreadId === undefined) throw new Error("Expected a bound session.");
    const authority = liveAuthorityFor(value.store, profile.id);
    const connectionId = value.codex.observationConnectionId;
    const request = async (requestId: string) => {
      const provider = {
        profileId: profile.id,
        processGeneration: profile.processGeneration,
        provider: authority.provider,
        providerAccountId: authority.providerAccountId,
        bindingGeneration: authority.bindingGeneration,
        connectionId,
        requestId: { type: "string" as const, value: requestId },
        method: "item/permissions/requestApproval",
        requestDigest: createHash("sha256").update(requestId).digest("hex"),
        threadId: session.providerThreadId as string,
        turnId: "turn-permission",
        itemId: `item-${requestId}`,
        approvalId: null,
      };
      await value.service.observeCodexFact(authority, {
        type: "interactionRequested",
        connectionId,
        provider,
        kind: "permission_approval",
        blocking: true,
        display: {
          kind: "permission_approval",
          summary: "Allow requested permissions",
          reason: "The provider needs a bounded capability",
          requested: [{ name: "network" }, { name: "fileSystem" }],
          allowsSessionScope: true,
        },
      });
      const interaction = value.store.listInteractions({
        sessionId,
        pendingOnly: true,
        limit: 10,
      }).find((candidate) => candidate.authority.requestId.value === requestId);
      if (interaction === undefined) throw new Error("Expected a permission interaction.");
      return interaction;
    };

    const grant = await request("permission-grant-1");
    value.codex.validateInteractionResolutionError = new CodexError(
      "INVALID_INPUT",
      "selected permissions exceed the requested profile",
    );
    await expect(value.service.execute({
      kind: "interaction.resolve",
      interaction: grant.publicId,
      expectedRevision: grant.revision,
      resolution: {
        kind: "permission_grant",
        permissions: ["fileSystem"],
        scope: "turn",
      },
    }, { signal })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(value.store.requireInteraction(grant.publicId)).toMatchObject({
      state: "pending",
      revision: 1,
      responseDigest: null,
    });
    expect(value.codex.resolvedInteractions).toHaveLength(0);

    delete value.codex.validateInteractionResolutionError;
    const corrected = await value.service.execute({
      kind: "interaction.resolve",
      interaction: grant.publicId,
      expectedRevision: grant.revision,
      resolution: {
        kind: "permission_grant",
        permissions: ["network"],
        scope: "turn",
      },
    }, { signal });
    expect(corrected).toMatchObject({
      interaction: { id: grant.publicId, state: "response_written", revision: 3 },
    });

    const declined = await request("permission-decline-1");
    const declineResult = await value.service.execute({
      kind: "interaction.resolve",
      interaction: declined.publicId,
      expectedRevision: declined.revision,
      resolution: { kind: "approval_decision", decision: "decline" },
    }, { signal });
    expect(declineResult).toMatchObject({
      interaction: { id: declined.publicId, state: "response_written", revision: 3 },
    });
    expect(value.codex.resolvedInteractions.at(-1)?.resolution).toEqual({
      kind: "approval_decision",
      decision: "decline",
    });
    await value.service.observeCodexFact(authority, {
      type: "interactionResolved",
      connectionId,
      provider: declined.authority,
      kind: "permission_approval",
    });
    expect(value.store.requireInteraction(declined.publicId)).toMatchObject({
      state: "declined",
      intendedTerminalState: "declined",
      revision: 4,
    });
    const canceled = await request("permission-cancel-1");
    await expect(value.service.execute({
      kind: "interaction.resolve",
      interaction: canceled.publicId,
      expectedRevision: canceled.revision,
      resolution: { kind: "approval_decision", decision: "cancel" },
    }, { signal })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(value.store.requireInteraction(canceled.publicId)).toMatchObject({
      state: "pending",
      intendedTerminalState: null,
      revision: 1,
    });
    expect(value.codex.validatedInteractions).toHaveLength(3);
  });
test("marks a response-write failure unknown and expires untouched prompts on disconnect", async () => {
    const value = await fixture();
    const { sessionId } = await createIdleSession(value, "Interaction recovery");
    const session = value.store.requireSession(sessionId);
    const profile = value.store.requireProfileById(session.profileId);
    if (session.providerThreadId === undefined) throw new Error("Expected a bound session.");
    const authority = liveAuthorityFor(value.store, profile.id);
    const connectionId = value.codex.observationConnectionId;
    const request = async (requestId: string) => {
      const provider = {
        profileId: profile.id,
        processGeneration: profile.processGeneration,
        provider: authority.provider,
        providerAccountId: authority.providerAccountId,
        bindingGeneration: authority.bindingGeneration,
        connectionId,
        requestId: { type: "string" as const, value: requestId },
        method: "item/commandExecution/requestApproval",
        requestDigest: createHash("sha256").update(requestId).digest("hex"),
        threadId: session.providerThreadId as string,
        turnId: "turn-file",
        itemId: `item-${requestId}`,
        approvalId: null,
      };
      await value.service.observeCodexFact(authority, {
        type: "interactionRequested",
        connectionId,
        provider,
        kind: "command_approval",
        blocking: true,
        display: {
          kind: "command_approval",
          summary: "Apply reviewed changes",
          reason: null,
          commandClass: "test",
          workingDirectory: null,
          availableDecisions: ["once" as const, "decline" as const, "cancel" as const],
        },
      });
      return provider;
    };
    await request("file-request-1");
    const first = value.store.listInteractions({ sessionId, pendingOnly: true, limit: 10 })[0];
    if (first === undefined) throw new Error("Expected the first interaction.");
    value.codex.resolveInteractionError = new CodexError(
      "INDETERMINATE_EFFECT",
      "the response write may have reached Codex",
    );
    await expect(value.service.execute({
      kind: "interaction.resolve",
      interaction: first.publicId,
      expectedRevision: first.revision,
      resolution: { kind: "approval_decision", decision: "once" },
    }, { signal })).rejects.toMatchObject({
      code: "RECOVERY_REQUIRED",
      message: "The interaction response may have reached the provider; its resolution is unknown.",
    });
    expect(value.store.requireInteraction(first.publicId)).toMatchObject({
      state: "resolution_unknown",
      revision: 3,
    });
    expect(value.codex.validatedInteractionTimeouts).toHaveLength(0);
    expect(value.codex.timedOutInteractions).toHaveLength(0);
    delete value.codex.resolveInteractionError;
    await request("file-request-2");
    const second = value.store.listInteractions({ sessionId, pendingOnly: true, limit: 10 })[0];
    if (second === undefined) throw new Error("Expected the second interaction.");
    await value.service.observeCodexFact(authority, {
      type: "providerDisconnected",
      connectionId,
      reason: "process_exit",
    });
    expect(value.store.requireProfileById(profile.id).processGeneration).toBe(
      profile.processGeneration + 1,
    );
    const replacementAuthority = {
      ...authority,
      generation: authority.generation + 1,
    };
    const eventsAfterDisconnect = value.store.listSessionEvents({
      sessionId,
      afterSequence: null,
      limit: 200,
    }).events;
    const replacementConnectionId = "50000000-0000-4000-8000-000000000099";
    value.codex.observationConnectionId = replacementConnectionId;
    await value.service.observeCodexFact(replacementAuthority, {
      type: "itemStarted",
      connectionId: replacementConnectionId,
      threadId: session.providerThreadId,
      turnId: "turn-after-restart",
      itemId: "assistant-after-restart",
      itemKind: "agentMessage",
    });
    await value.service.observeCodexFact(replacementAuthority, {
      type: "assistantDelta",
      connectionId: replacementConnectionId,
      threadId: session.providerThreadId,
      turnId: "turn-after-restart",
      itemId: "assistant-after-restart",
      text: "new generation visible",
    });
    await value.service.observeCodexFact(replacementAuthority, {
      type: "itemCompleted",
      connectionId: replacementConnectionId,
      threadId: session.providerThreadId,
      turnId: "turn-after-restart",
      itemId: "assistant-after-restart",
      itemKind: "agentMessage",
      status: "completed",
    });
    const eventsAfterReplacement = value.store.listSessionEvents({
      sessionId,
      afterSequence: null,
      limit: 200,
    }).events;
    expect(eventsAfterReplacement).toEqual(eventsAfterDisconnect);
    await value.service.observeCodexFact(authority, {
      type: "assistantDelta",
      connectionId,
      threadId: session.providerThreadId,
      turnId: "turn-before-restart",
      itemId: "assistant-before-restart",
      text: "stale generation hidden",
    });
    expect(value.store.listSessionEvents({
      sessionId,
      afterSequence: null,
      limit: 200,
    }).events).toEqual(eventsAfterReplacement);
    expect(JSON.stringify(eventsAfterReplacement)).not.toContain("new generation visible");
    expect(JSON.stringify(eventsAfterReplacement)).not.toContain("stale generation hidden");
    expect(() => value.store.requireSessionProviderAuthority(sessionId))
      .toThrow("SESSION_PROVIDER_AUTHORITY_STALE");
    expect(value.store.requireInteraction(second.publicId)).toMatchObject({
      state: "expired",
      revision: 2,
    });
    const bodies = value.store.listSessionEvents({
      sessionId,
      afterSequence: null,
      limit: 200,
    }).events.map((event) => event.body.type);
    expect(bodies).toContain("gap");
    expect(bodies).toContain("interaction_state");
  });
test("clean shutdown retires every live provider generation when runtime close emits no disconnect fact", async () => {
    const value = await fixture();
    const { sessionId } = await createIdleSession(value, "Clean interaction shutdown");
    const connectionId = value.codex.observationConnectionId;
    const seeded = seedUnsettledInteractionStates(
      value,
      sessionId,
      connectionId,
      "clean-shutdown",
    );
    const originalGeneration = seeded.profile.processGeneration;
    const authority = liveAuthorityFor(value.store, seeded.profile.id);
    await value.service.observeCodexFact(authority, {
      type: "assistantDelta",
      connectionId,
      threadId: seeded.session.providerThreadId as string,
      turnId: "clean-shutdown-turn",
      itemId: "clean-shutdown-agent",
      text: "visible before shutdown",
    });

    await value.service.close();

    expect(value.codex.closeCalls).toBe(1);
    expect(value.store.requireProfileById(seeded.profile.id).processGeneration)
      .toBe(originalGeneration + 1);
    expect(value.store.requireInteraction(seeded.pending.publicId)).toMatchObject({
      state: "expired",
      revision: 2,
    });
    expect(value.store.requireInteraction(seeded.prepared.publicId)).toMatchObject({
      state: "resolution_unknown",
      revision: 3,
    });
    expect(value.store.requireInteraction(seeded.written.publicId)).toMatchObject({
      state: "resolution_unknown",
      revision: 4,
    });
    expect(value.store.listInteractions({ sessionId, pendingOnly: true })).toEqual([]);
    expect(value.store.listSessionEvents({ sessionId, afterSequence: 0 }).events
      .map((event) => event.body))
      .toContainEqual({
        type: "connection",
        state: "disconnected",
        reason: "closed",
      });

    const restartedCodex = new FakeCodex();
    const restarted = new OompaService({
      store: value.store,
      paths: value.paths,
      codex: restartedCodex,
      cloud: new FakeCloud(),
      daemonAuthority: new FakeDaemonAuthority(),
      daemonGeneration: 2,
      requestStop: () => undefined,
    });
    await restarted.recover();
    for (const interaction of [seeded.pending, seeded.prepared, seeded.written]) {
      await expect(restarted.execute({
        kind: "interaction.resolve",
        interaction: interaction.publicId,
        expectedRevision: interaction.revision,
        resolution: { kind: "approval_decision", decision: "once" },
      }, { signal })).rejects.toMatchObject({ code: "CONFLICT" });
    }
    expect(restartedCodex.validatedInteractions).toHaveLength(0);
    expect(restartedCodex.resolvedInteractions).toHaveLength(0);

    const replacementConnectionId = "51000000-0000-4000-8000-000000000099";
    restartedCodex.observationConnectionId = replacementConnectionId;
    const replacementAuthority = {
      ...authority,
      generation: originalGeneration + 1,
    };
    const eventsAfterShutdown = value.store.listSessionEvents({
      sessionId,
      afterSequence: 0,
    }).events;
    await restarted.observeCodexFact(replacementAuthority, {
      type: "itemStarted",
      connectionId: replacementConnectionId,
      threadId: seeded.session.providerThreadId as string,
      turnId: "clean-shutdown-replacement-turn",
      itemId: "clean-shutdown-replacement-agent",
      itemKind: "agentMessage",
    });
    await restarted.observeCodexFact(replacementAuthority, {
      type: "assistantDelta",
      connectionId: replacementConnectionId,
      threadId: seeded.session.providerThreadId as string,
      turnId: "clean-shutdown-replacement-turn",
      itemId: "clean-shutdown-replacement-agent",
      text: "replacement generation visible",
    });
    await restarted.observeCodexFact(replacementAuthority, {
      type: "itemCompleted",
      connectionId: replacementConnectionId,
      threadId: seeded.session.providerThreadId as string,
      turnId: "clean-shutdown-replacement-turn",
      itemId: "clean-shutdown-replacement-agent",
      itemKind: "agentMessage",
      status: "completed",
    });
    const afterReplacement = value.store.listSessionEvents({
      sessionId,
      afterSequence: 0,
    }).events;
    expect(afterReplacement).toEqual(eventsAfterShutdown);
    await restarted.observeCodexFact(authority, {
      type: "assistantDelta",
      connectionId,
      threadId: seeded.session.providerThreadId as string,
      turnId: "clean-shutdown-stale-turn",
      itemId: "clean-shutdown-stale-agent",
      text: "stale generation hidden",
    });
    expect(value.store.listSessionEvents({ sessionId, afterSequence: 0 }).events)
      .toEqual(afterReplacement);
    expect(JSON.stringify(afterReplacement)).not.toContain("replacement generation visible");
    expect(JSON.stringify(afterReplacement)).not.toContain("stale generation hidden");
    expect(() => value.store.requireSessionProviderAuthority(sessionId))
      .toThrow("SESSION_PROVIDER_AUTHORITY_STALE");
    await restarted.close();
  });
test("quarantines the matching provider when runtime close throws synchronously", async () => {
    const value = await fixture();
    const { sessionId } = await createIdleSession(value, "Synchronous close failure");
    const session = value.store.requireSession(sessionId);
    const generation = value.store.requireProfileById(session.profileId).processGeneration;
    let closeCalls = 0;
    Object.defineProperty(value.codex, "close", {
      configurable: true,
      value: () => {
        closeCalls += 1;
        throw new Error("synchronous Codex close failure");
      },
    });

    await expect(value.service.close()).rejects.toThrow("synchronous Codex close failure");
    expect(closeCalls).toBe(1);
    expect(value.store.requireSession(sessionId).state).toBe("recovery_required");
    expect(value.store.requireProfileById(session.profileId).processGeneration).toBe(generation);
  });
test("quarantines only the failed runtime scope when managed and personal Codex coexist", async () => {
    for (const failedScope of ["managed", "personal"] as const) {
      const value = await adoptedCodexFixture(
        `Scoped ${failedScope} shutdown`,
        `personal-thread-${failedScope}-shutdown`,
      );
      const started = await value.service.execute({
        kind: "session.start",
        account: value.accountId,
        preset: "high",
        presetContract: currentPresetContract,
        fast: false,
      }, { signal }) as { session: { id: `sess_${string}` } };
      const nativeSessionId = started.session.id;
      expect(value.store.readSessionProviderAccountAuthority(nativeSessionId))
        .toMatchObject({ provider: "codex", runtimeScope: "managed" });
      expect(value.store.readSessionProviderAccountAuthority(value.session.id))
        .toMatchObject({ provider: "codex", runtimeScope: "personal" });
      const failure = new Error(`${failedScope} Codex close failure`);
      if (failedScope === "managed") value.codex.closeError = failure;
      else value.personalCodex.closeError = failure;

      await expect(value.service.close()).rejects.toThrow(failure.message);

      expect(value.store.requireSession(nativeSessionId).state).toBe(
        failedScope === "managed" ? "recovery_required" : "idle",
      );
      expect(value.store.requireSession(value.session.id).state).toBe(
        failedScope === "personal" ? "recovery_required" : "idle",
      );
    }
  });
test("crash restart atomically fences the old generation and terminalizes ambiguous interaction states", async () => {
    const value = await fixture();
    const { sessionId } = await createIdleSession(value, "Crashed interaction authority");
    const seeded = seedUnsettledInteractionStates(
      value,
      sessionId,
      "52000000-0000-4000-8000-000000000001",
      "crash-restart",
    );
    const originalGeneration = seeded.profile.processGeneration;
    const originalSessionAuthority = value.store.requireSessionProviderAuthority(sessionId);
    const originalProviderAuthority = {
      provider: originalSessionAuthority.provider,
      providerAccountId: originalSessionAuthority.providerAccountId,
      profileId: originalSessionAuthority.profileId,
      bindingGeneration: originalSessionAuthority.bindingGeneration,
      processGeneration: originalSessionAuthority.processGeneration,
    } as const;
    const originalRuntimeAuthority = liveAuthorityFor(
      value.store,
      seeded.profile.id,
    );
    const stalePreparedKey = "52000000-0000-4000-8000-000000000099";
    const { attempt: stalePrepared } = value.store.prepareSessionInputMutation({
      kind: "session.send",
      sessionId,
      providerAuthority: originalProviderAuthority,
      message: "must remain fenced after restart",
      attachments: [],
      idempotencyKey: stalePreparedKey,
      daemonGeneration: value.daemonGeneration,
      bootId: value.daemonBootId,
    });
    expect(stalePrepared).toMatchObject({ state: "prepared", replay: false });
    const staleQueue = value.store.enqueue(
      sessionId,
      "queued input must remain fenced after restart",
    );
    expect(value.store.readQueueProviderAuthority(staleQueue.id))
      .toMatchObject(originalProviderAuthority);
    const oldStoreIndex = stores.indexOf(value.store);
    if (oldStoreIndex < 0) throw new Error("Expected the fixture store to be tracked.");
    value.daemonAuthority.invalidate();
    value.store.close();
    stores.splice(oldStoreIndex, 1);

    const restartedStore = new StateStore(value.paths);
    stores.push(restartedStore);
    const daemonGeneration = restartedStore.nextDaemonGeneration(
      `boot_${"f".repeat(32)}`,
    );
    expect(daemonGeneration).toBe(value.daemonGeneration + 1);
    expect(restartedStore.requireProfileById(seeded.profile.id).processGeneration)
      .toBe(originalGeneration + 1);
    const reboundSessionAuthority = restartedStore.requireSessionProviderAuthority(sessionId);
    expect(reboundSessionAuthority).toMatchObject({
      provider: originalSessionAuthority.provider,
      providerAccountId: originalSessionAuthority.providerAccountId,
      profileId: originalSessionAuthority.profileId,
      bindingGeneration: originalSessionAuthority.bindingGeneration,
      processGeneration: originalSessionAuthority.processGeneration + 1,
    });
    expect(restartedStore.readMutation(stalePreparedKey))
      .toMatchObject({ state: "cancelled" });
    expect(restartedStore.requireQueue(staleQueue.id))
      .toMatchObject({ state: "cancelled" });
    expect(restartedStore.readQueueProviderAuthority(staleQueue.id))
      .toMatchObject(originalProviderAuthority);
    expect(restartedStore.requireInteraction(seeded.pending.publicId)).toMatchObject({
      state: "expired",
      revision: 2,
    });
    expect(restartedStore.requireInteraction(seeded.prepared.publicId)).toMatchObject({
      state: "resolution_unknown",
      revision: 3,
    });
    expect(restartedStore.requireInteraction(seeded.written.publicId)).toMatchObject({
      state: "resolution_unknown",
      revision: 4,
    });
    expect(restartedStore.listInteractions({ sessionId, pendingOnly: true })).toEqual([]);

    const restartedCodex = new FakeCodex();
    const restarted = new OompaService({
      store: restartedStore,
      paths: value.paths,
      codex: restartedCodex,
      cloud: new FakeCloud(),
      daemonAuthority: new FakeDaemonAuthority(),
      daemonGeneration,
      requestStop: () => undefined,
    });
    await restarted.recover();
    for (const interaction of [seeded.pending, seeded.prepared, seeded.written]) {
      await expect(restarted.execute({
        kind: "interaction.resolve",
        interaction: interaction.publicId,
        expectedRevision: interaction.revision,
        resolution: { kind: "approval_decision", decision: "once" },
      }, { signal })).rejects.toMatchObject({ code: "CONFLICT" });
    }
    expect(restartedCodex.validatedInteractions).toHaveLength(0);
    expect(restartedCodex.resolvedInteractions).toHaveLength(0);
    const restartStatus = await restarted.execute({
      kind: "session.status",
      session: sessionId,
    }, { signal }) as { eventStream: { cursor: string }; providerObservation: unknown };
    expect(restartStatus).toMatchObject({
      providerObservation: {
        basis: "provider_read",
        connectionId: restartedCodex.observationConnectionId,
        mode: "resubscribed",
        state: "live",
      },
    });
    await expect(restarted.execute({
      kind: "session.events",
      session: sessionId,
      cursor: restartStatus.eventStream.cursor,
      limit: 200,
      waitMs: 0,
    }, { signal })).resolves.toMatchObject({ events: [] });
    const eventsBeforeOldCallback = restartedStore.listSessionEvents({
      sessionId,
      afterSequence: 0,
    }).events;
    await restarted.observeCodexFact(
      originalRuntimeAuthority,
      {
        type: "assistantDelta",
        connectionId: "52000000-0000-4000-8000-000000000001",
        threadId: seeded.session.providerThreadId as string,
        turnId: "old-restart-turn",
        itemId: "old-restart-item",
        text: "stale callback must stay fenced",
      },
    );
    expect(restartedStore.listSessionEvents({
      sessionId,
      afterSequence: 0,
    }).events).toEqual(eventsBeforeOldCallback);
    const providerCallsBeforeStalePrepared = restartedCodex.calls.length;
    await expect(restarted.execute({
      kind: "session.send",
      session: sessionId,
      message: "must remain fenced after restart",
      idempotencyKey: stalePreparedKey,
    }, { signal })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(restartedCodex.calls.slice(providerCallsBeforeStalePrepared))
      .not.toContain("send");
    const restartEvents = restartedStore.listSessionEvents({
      sessionId,
      afterSequence: 0,
    }).events;
    expect(restartEvents.filter((event) =>
      event.body.type === "gap" && event.body.reason === "provider_restart"))
      .toHaveLength(1);
    const resubscribed = restartEvents.find((event) =>
      event.body.type === "connection" && event.body.state === "resubscribed");
    expect(resubscribed).toMatchObject({
      body: { type: "connection", state: "resubscribed" },
      providerConnectionId: restartedCodex.observationConnectionId,
      providerGeneration: originalSessionAuthority.processGeneration + 1,
    });
    await restarted.close();
  });
test("closes fact admission before draining and never dispatches a queued turn from a late completion", async () => {
    const { service, codex, daemonAuthority, documents, store } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Shutdown authority" }, { signal }) as { account: { id: `acct_${string}`; processGeneration: number } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    await service.execute({ kind: "project.add", label: "Documents", path: documents }, { signal });
    const started = await service.execute({ kind: "session.start", account: added.account.id, preset: "high", presetContract: 2, fast: false }, { signal }) as { session: { id: `sess_${string}`; providerThreadId: string } };
    await service.execute({ kind: "session.send", session: started.session.id, message: "active" }, { signal });
    const queued = await service.execute({ kind: "session.queue", session: started.session.id, message: "must remain queued" }, { signal }) as { queued: { id: string } };
    let releaseFact!: () => void;
    let signalFactAdmitted!: () => void;
    const factGate = new Promise<void>((resolve) => { releaseFact = resolve; });
    const factAdmitted = new Promise<void>((resolve) => { signalFactAdmitted = resolve; });
    let gated = false;
    daemonAuthority.beforeAssert = async () => {
      if (gated) return;
      gated = true;
      signalFactAdmitted();
      await factGate;
    };
    const authority = liveAuthorityFor(store, added.account.id);
    const fact = service.observeCodexFact(authority, {
      type: "turnCompleted",
      threadId: started.session.providerThreadId,
      turn: { id: "turn-next", items: [], status: "completed", startedAt: 1, completedAt: 2, durationMs: 1 },
    });
    await factAdmitted;

    let closeSettled = false;
    const closing = service.close().then(() => { closeSettled = true; });
    await service.observeCodexFact(authority, {
      type: "turnCompleted",
      threadId: started.session.providerThreadId,
      turn: { id: "late-turn", items: [], status: "completed", startedAt: 1, completedAt: 2, durationMs: 1 },
    });
    await Promise.resolve();
    expect(closeSettled).toBe(false);
    releaseFact();
    await expect(fact).rejects.toBeInstanceOf(DaemonAuthoritySafetyError);
    await closing;

    expect(daemonAuthority.closeCalls).toBe(1);
    expect(codex.closeCalls).toBe(1);
    expect(codex.calls.filter((call) => call === "send")).toHaveLength(1);
    expect(store.requireSession(started.session.id)).toMatchObject({ state: "active", activeTurnId: "turn-next" });
    expect(store.nextPendingQueue(started.session.id)).toMatchObject({ id: queued.queued.id, state: "pending" });
    await expect(service.execute({ kind: "daemon.status" }, { signal })).rejects.toThrow("no longer accepts operations");
  });
});
