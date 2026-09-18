import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import fc from "fast-check";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { canonical24ResetDatabaseBytes, canonical24ResetFixture } from "../../scripts/fixtures/canonical24-reset";
import { canonicalLoginLedgerDatabaseBytes, canonicalLoginLedgerFixtures } from "../../scripts/fixtures/canonical-login-ledger";
import { CodexError, CodexRemoteError, IndeterminateCodexEffectError } from "../codex";
import { parseFact } from "../codex/protocol";
import { IndeterminateClaudeEffectError } from "../claude/errors";
import { CloudProjectionRecoveryAdmissionError } from "../cloud/contracts";
import { CloudDaemonJournalRecoveryBlocker, createCloudProjectionRecoveryTerminalReceipt, MemoryCloudDaemonJournal, transitionCloudProjectionRecovery, type CloudProjectionRecoveryJournalEntry } from "../cloud/daemon-journal";
import { localCommandSchema } from "../domain/contracts";
import { PROJECT_MEMORY_EMPTY_HEAD } from "../domain/project-memory";
import { currentPresetContract } from "../domain/presets";
import { createStoredAccountUsageSnapshot, storedAccountUsageSnapshotSchema } from "../domain/usage-metrics";
import { initializeStatePaths, profilePaths, resolveStatePaths } from "../storage/paths";
import { StateStore } from "../storage/state-store";
import { DaemonAuthoritySafetyError } from "./daemon-lock";
import { UnavailableCloudControl, type DevinRuntimePort, type ProfileAuthority } from "./ports";
import { CommandFailure, FACTS_MEMORY_SESSION_TTL_MS, OompaService } from "./service";
import { USAGE_HISTORY_CURSOR_TTL_MS } from "./usage-history-cursor";
import {
  FakeCloud,
  FakeCodex,
  FakeDaemonAuthority,
  FakeFactsMemoryLifecycle,
  FakeMemory,
  automaticResetWindowResetsAt,
  automaticResetWindowResetsAtSeconds,
  codexProviderAccountKey,
  createIdleSession,
  fixture,
  interactionAuthorityFor,
  liveAuthorityFor,
  nativeClaudeFixture,
  ownedFixtureTeardowns,
  ownedServiceCase,
  ownedServiceCaseTeardowns,
  ownedServiceFixture,
  providerMutationCalls,
  remoteAuthorityFor,
  runtimeProfile,
  seedResolvableInteraction,
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
test("terminalizes provider deletion immediately but orders purge after admitted memory", async () => {
    const factsMemory = new FakeFactsMemoryLifecycle();
    const memory = new FakeMemory();
    const value = await fixture(new FakeCloud(),
      () => undefined,
      Date.now,
      factsMemory,
      {},
      memory,
    );
    const { sessionId } = await createIdleSession(value, "Provider deletion memory race");
    const session = value.store.requireSession(sessionId);
    const profile = value.store.requireProfileById(session.profileId);
    if (session.providerThreadId === undefined) throw new Error("Expected a bound session.");
    const authority: ProfileAuthority = liveAuthorityFor(value.store, profile.id, "codex");
    let entered!: () => void;
    const memoryEntered = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const memoryGate = new Promise<void>((resolve) => { release = resolve; });
    memory.beforeRememberReturn = async () => {
      entered();
      await memoryGate;
    };
    const first = value.service.execute({
      idempotencyKey: "00000000-0000-4000-8000-000000000611",
      kind: "memory.remember",
      session: sessionId,
      value: {
        body: "The admitted operation settles before provider deletion purges its authority.",
        key: "authority.deletion-order",
        summary: "Deletion waits for admitted memory",
        title: "Provider deletion ordering",
      },
    }, { signal });
    await memoryEntered;

    // The provider callback persists terminal authority while memory is blocked,
    // but it may not purge the directory underneath that admitted operation.
    await value.service.observeCodexFact(authority, {
      ...parseFact("thread/deleted", { threadId: session.providerThreadId }),
      connectionId: value.codex.observationConnectionId,
    });
    expect(value.store.requireSession(sessionId).state).toBe("terminal");
    expect(factsMemory.cleanups).toEqual([]);

    const queued = value.service.execute({
      kind: "memory.query",
      session: sessionId,
      value: { mode: "list" },
    }, { signal });
    const queuedOutcome = queued.then(
      () => ({ error: null }),
      (error: unknown) => ({ error }),
    );
    release();
    await expect(first).resolves.toMatchObject({ ok: true });
    await expect(queuedOutcome).resolves.toMatchObject({
      error: {
        code: "CONFLICT",
        details: { reason: "MEMORY_SESSION_REFUSED" },
      },
    });
    await value.service.settled();

    expect(value.store.requireSession(sessionId).state).toBe("terminal");
    expect(factsMemory.cleanups).toEqual([{
      ownerId: profile.id,
      reason: "archive",
      sessionId,
    }]);
    expect(factsMemory.states.get(sessionId)).toBe("purged");
    expect(memory.remembers).toHaveLength(1);
    expect(memory.queries).toEqual([]);
    await value.service.close();
  });
test("retains terminal facts memory while a post-effect submission needs recovery", async () => {
    const factsMemory = new FakeFactsMemoryLifecycle();
    const memory = new FakeMemory();
    const value = await fixture(new FakeCloud(),
      () => undefined,
      Date.now,
      factsMemory,
      {},
      memory,
    );
    const { sessionId } = await createIdleSession(value, "Effect memory cleanup");
    const session = value.store.requireSession(sessionId);
    if (session.projectId === undefined) throw new Error("Expected a project-bound session.");
    const idempotencyKey = crypto.randomUUID();
    const prepared = value.store.prepareMemorySubmission({
      actorSessionId: sessionId,
      projectId: session.projectId,
      kind: "remember",
      requestDigest: "6".repeat(64),
      contentDigest: "7".repeat(64),
      keyDigest: "8".repeat(64),
      workingBindingDigest: "9".repeat(64),
      workingEpoch: 1,
      expectedHead: {
        sequence: 0,
        operationSha256: null,
        headDigest: PROJECT_MEMORY_EMPTY_HEAD.headDigest,
      },
      idempotencyKey,
    }).record;
    value.store.bindMemorySubmissionEffect({
      submissionId: prepared.id,
      effectRecordSha256: "b".repeat(64),
      attestationSha256: "c".repeat(64),
      operationId: "test-terminal-memory-effect",
    });
    const begun = value.store.beginMemorySubmission(prepared.id, idempotencyKey);
    value.codex.readProjection = {
      providerThreadId: session.providerThreadId ?? "provider-thread",
      status: "terminal",
      title: session.title,
    };

    await expect(value.service.execute({
      kind: "session.show",
      session: sessionId,
      detail: false,
    }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(value.store.requireSession(sessionId).state).toBe("terminal");
    expect(value.store.requireMemorySubmission(prepared.id).state).toBe("effect_started");
    expect(factsMemory.cleanups).toEqual([]);
    expect(memory.forgottenSessions).toContain(sessionId);

    value.store.settleMemorySubmission({
      submissionId: prepared.id,
      expectedState: begun.state === "ambiguous" ? "ambiguous" : "effect_started",
      state: "failed",
      outcomeCode: "remember_not_applied",
    });
    await expect(value.service.execute({ kind: "account.list" }, { signal }))
      .resolves.toBeDefined();
    expect(factsMemory.cleanups.at(-1)).toEqual({
      ownerId: session.profileId,
      reason: "archive",
      sessionId,
    });
  });
test("expiry sweep retains post-effect working memory until submission recovery settles", async () => {
    const factsMemory = new FakeFactsMemoryLifecycle();
    factsMemory.simulateExpiry = true;
    const memory = new FakeMemory();
    let now = 1_000;
    const value = await fixture(new FakeCloud(),
      () => undefined,
      () => now,
      factsMemory,
      {},
      memory,
    );
    const { sessionId } = await createIdleSession(value, "Expiring effect memory");
    const session = value.store.requireSession(sessionId);
    if (session.projectId === undefined) throw new Error("Expected a project-bound session.");
    const idempotencyKey = crypto.randomUUID();
    const prepared = value.store.prepareMemorySubmission({
      actorSessionId: sessionId,
      projectId: session.projectId,
      kind: "remember",
      requestDigest: "d".repeat(64),
      contentDigest: "e".repeat(64),
      keyDigest: "f".repeat(64),
      workingBindingDigest: "1".repeat(64),
      workingEpoch: 1,
      expectedHead: {
        sequence: 0,
        operationSha256: null,
        headDigest: PROJECT_MEMORY_EMPTY_HEAD.headDigest,
      },
      idempotencyKey,
    }).record;
    value.store.bindMemorySubmissionEffect({
      submissionId: prepared.id,
      effectRecordSha256: "3".repeat(64),
      attestationSha256: "4".repeat(64),
      operationId: "test-expired-memory-effect",
    });
    const begun = value.store.beginMemorySubmission(prepared.id, idempotencyKey);
    const expiry = factsMemory.expiries.get(sessionId);
    if (expiry === undefined) throw new Error("Expected facts-memory expiry.");
    now = expiry;

    await value.service.execute({ kind: "account.list" }, { signal });
    expect(factsMemory.states.get(sessionId)).toBe("active");
    expect(memory.forgottenSessions).toContain(sessionId);

    value.store.settleMemorySubmission({
      submissionId: prepared.id,
      expectedState: begun.state === "ambiguous" ? "ambiguous" : "effect_started",
      state: "failed",
      outcomeCode: "remember_not_applied",
    });
    await value.service.execute({ kind: "account.list" }, { signal });
    expect(factsMemory.states.get(sessionId)).toBe("purged");
  });
test("blocks project reassignment while a memory submission is unsettled", async () => {
    const memory = new FakeMemory();
    const value = await fixture(new FakeCloud(),
      () => undefined,
      Date.now,
      undefined,
      {},
      memory,
    );
    const { sessionId } = await createIdleSession(value, "Memory project binding");
    const session = value.store.requireSession(sessionId);
    if (session.projectId === undefined) throw new Error("Expected a project-bound session.");
    const alternateDirectory = join(value.documents, "alternate-project");
    await mkdir(alternateDirectory);
    const alternate = await value.service.execute({
      kind: "project.add",
      label: "Alternate memory project",
      path: alternateDirectory,
    }, { signal }) as { project: { id: string } };
    const prepared = value.store.prepareMemorySubmission({
      actorSessionId: sessionId,
      projectId: session.projectId,
      kind: "remember",
      requestDigest: "5".repeat(64),
      contentDigest: "6".repeat(64),
      keyDigest: "7".repeat(64),
      workingBindingDigest: "8".repeat(64),
      workingEpoch: 1,
      expectedHead: {
        sequence: 0,
        operationSha256: null,
        headDigest: PROJECT_MEMORY_EMPTY_HEAD.headDigest,
      },
      idempotencyKey: crypto.randomUUID(),
    }).record;

    await expect(value.service.execute({
      kind: "session.project",
      project: alternate.project.id,
      session: sessionId,
    }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(value.store.requireSession(sessionId).projectId).toBe(session.projectId);
    expect(memory.forgottenSessions).toEqual([]);

    value.store.cancelPreparedMemorySubmission(prepared.id);
    await expect(value.service.execute({
      kind: "session.project",
      project: alternate.project.id,
      session: sessionId,
    }, { signal })).resolves.toMatchObject({ session: { projectId: alternate.project.id } });
    expect(memory.forgottenSessions).toEqual([sessionId]);
  });
test("moves provider, peer, and memory project authority only between turns", async () => {
    const value = await fixture();
    const { sessionId } = await createIdleSession(value, "Project turn boundary");
    const original = value.store.requireSession(sessionId);
    const alternateDirectory = join(value.documents, "project-turn-boundary-alternate");
    await mkdir(alternateDirectory);
    const alternate = await value.service.execute({
      kind: "project.add",
      label: "Project turn boundary alternate",
      path: alternateDirectory,
    }, { signal }) as { project: { id: string } };
    await value.service.execute({
      kind: "session.send",
      message: "Keep this provider turn on its admitted project.",
      session: sessionId,
    }, { signal });
    const active = value.store.requireSession(sessionId);
    expect(active).toMatchObject({ projectId: original.projectId, state: "active" });

    await expect(value.service.execute({
      kind: "session.project",
      project: alternate.project.id,
      session: sessionId,
    }, { signal })).rejects.toMatchObject({
      code: "CONFLICT",
      details: { sessionId, state: "active" },
    });
    expect(value.store.requireSession(sessionId)).toEqual(active);

    await value.service.execute({ kind: "session.stop", session: sessionId }, { signal });
    await expect(value.service.execute({
      kind: "session.project",
      project: alternate.project.id,
      session: sessionId,
    }, { signal })).resolves.toMatchObject({
      session: { projectId: alternate.project.id, state: "idle" },
    });
  });
test("never moves Claude project authority away from the provider working directory", async () => {
    const value = await fixture();
    const original = await value.store.createProject(
      "Provider-bound original",
      value.documents,
    );
    const alternateDirectory = join(value.documents, "provider-bound-alternate");
    await mkdir(alternateDirectory);
    const alternate = await value.store.createProject(
      "Provider-bound alternate",
      alternateDirectory,
    );
    const profile = value.store.createProfile("Provider-bound account");

    const provider = "claude" as const;
    const created = value.store.createSession({
      fastEnabled: false,
      preset: "fable-max",
      profileId: profile.id,
      projectId: original.id,
      provider,
    });
    const session = value.store.bindSession({
      expectedRevision: created.revision,
      providerThreadId: `${provider}-provider-bound-thread`,
      sessionId: created.id,
      state: "idle",
    });

    await expect(value.service.execute({
      kind: "session.project",
      project: alternate.id,
      session: session.id,
    }, { signal })).rejects.toMatchObject({
      code: "CONFLICT",
      details: {
        provider,
        reason: "provider_project_rebind_unsupported",
        sessionId: session.id,
      },
    });
    expect(value.store.requireSession(session.id)).toMatchObject({
      projectId: original.id,
      revision: session.revision,
    });

    await expect(value.service.execute({
      kind: "session.project",
      project: original.id,
      session: session.id,
    }, { signal })).resolves.toMatchObject({
      session: { projectId: original.id, revision: session.revision + 1 },
    });
  });
test("cleans list-driven terminalization and reconciles a crash-left terminal on restart", async () => {
    const factsMemory = new FakeFactsMemoryLifecycle();
    const value = await fixture(new FakeCloud(),
      () => undefined,
      Date.now,
      factsMemory,
    );
    const { sessionId } = await createIdleSession(value, "List terminal memory");
    const session = value.store.requireSession(sessionId);
    if (session.providerThreadId === undefined) throw new Error("Expected provider binding.");
    value.codex.listedProjections = [{
      providerThreadId: session.providerThreadId,
      providerUpdatedAt: (session.providerUpdatedAt ?? 0) + 1,
      status: "terminal",
      title: "List terminal memory",
    }];
    const localPage = await value.service.execute({
      account: session.profileId,
      kind: "session.list",
      archived: false,
      limit: 20,
    }, { signal }) as { nextCursor: string | null };
    if (localPage.nextCursor === null) throw new Error("Expected a provider-discovery continuation.");
    await value.service.execute({
      account: session.profileId,
      kind: "session.list",
      archived: false,
      limit: 20,
      cursor: localPage.nextCursor,
    }, { signal });
    expect(value.store.requireSession(sessionId).state).toBe("terminal");
    expect(factsMemory.cleanups).toContainEqual({
      ownerId: session.profileId,
      reason: "archive",
      sessionId,
    });

    const crashFactsMemory = new FakeFactsMemoryLifecycle();
    const otherSession = value.store.upsertProviderSession({
      providerAuthority: value.store.requireProviderAccountAuthority(
        session.profileId,
        "codex",
      ),
      profileId: session.profileId,
      provider: "codex",
      providerThreadId: "provider-thread-crash-terminal",
      preset: "high",
      fastEnabled: false,
      providerUpdatedAt: 1,
      providerAccountKey: codexProviderAccountKey(),
      state: "idle",
      title: "Crash terminal memory",
    });
    if (otherSession.providerThreadId === undefined) throw new Error("Expected provider binding.");
    value.store.upsertProviderSession({
      providerAuthority: value.store.requireProviderAccountAuthority(
        otherSession.profileId,
        "codex",
      ),
      profileId: otherSession.profileId,
      provider: "codex",
      providerThreadId: otherSession.providerThreadId,
      preset: "high",
      fastEnabled: false,
      providerUpdatedAt: (otherSession.providerUpdatedAt ?? 0) + 1,
      providerAccountKey: codexProviderAccountKey(),
      state: "terminal",
      title: otherSession.title,
    });
    const restarted = new OompaService({
      store: value.store,
      paths: value.paths,
      codex: new FakeCodex(),
      cloud: new FakeCloud(),
      daemonAuthority: new FakeDaemonAuthority(),
      factsMemory: crashFactsMemory,
      requestStop: () => undefined,
    });
    await restarted.recover();
    expect(crashFactsMemory.cleanups).toContainEqual({
      ownerId: otherSession.profileId,
      reason: "archive",
      sessionId: otherSession.id,
    });
    await restarted.close();
  });
test("renews facts-memory expiry after metadata-only durable activity", async () => {
    const factsMemory = new FakeFactsMemoryLifecycle();
    let now = 1_000;
    const value = await fixture(new FakeCloud(),
      () => undefined,
      () => now,
      factsMemory,
    );
    const { sessionId } = await createIdleSession(value, "Metadata memory renewal");
    factsMemory.ensures.length = 0;
    now += 29 * 24 * 60 * 60 * 1_000;
    await value.service.execute({
      kind: "session.note.set",
      note: "day twenty-nine activity",
      session: sessionId,
    }, { signal });
    expect(factsMemory.ensures).toEqual([{
      expiresAt: now + 30 * 24 * 60 * 60 * 1_000,
      ownerId: value.store.requireSession(sessionId).profileId,
      sessionId,
    }]);
  });
test("refuses local and remote preset changes until session recovery settles", async () => {
    const value = await fixture();
    const { sessionId } = await createIdleSession(value, "Recovery preset fence");
    const quarantined = value.store.quarantineSession(sessionId);
    const profile = value.store.requireProfileById(quarantined.profileId);
    if (quarantined.providerThreadId === undefined) throw new Error("Expected provider binding.");
    const refusal = {
      code: "RECOVERY_REQUIRED",
      message: "The session requires recovery before its model preset can change.",
    };

    await expect(value.service.execute({
      kind: "session.preset",
      preset: "high",
      session: sessionId,
    }, { signal })).rejects.toMatchObject(refusal);
    await expect(value.service.executeRemote({
      kind: "session.preset",
      preset: "high",
      session: sessionId,
    }, {
      ...value.store.requireProviderAccountAuthority(profile.id, quarantined.provider),
      providerThreadId: quarantined.providerThreadId,
      sessionId,
    }, { signal })).rejects.toMatchObject(refusal);
    expect(value.store.requireSession(sessionId)).toMatchObject({
      preset: "high",
      revision: quarantined.revision,
      state: "recovery_required",
    });
  });
test("reactivates stale live memory with a current TTL and does not churn epochs on unchanged resume", async () => {
    const factsMemory = new FakeFactsMemoryLifecycle();
    factsMemory.simulateExpiry = true;
    let now = 1_000;
    const value = await fixture(new FakeCloud(),
      () => undefined,
      () => now,
      factsMemory,
    );
    const { sessionId } = await createIdleSession(value, "Stale live memory");
    const firstExpiry = factsMemory.expiries.get(sessionId);
    if (firstExpiry === undefined) throw new Error("Expected initial facts-memory expiry.");
    now = firstExpiry;
    factsMemory.ensures.length = 0;

    await value.service.execute({
      detail: false,
      kind: "session.show",
      session: sessionId,
    }, { signal });
    expect(factsMemory.epochs.get(sessionId)).toBe(2);
    expect(factsMemory.ensures.every((entry) =>
      entry.expiresAt >= now + FACTS_MEMORY_SESSION_TTL_MS)).toBe(true);

    now += 1;
    await value.service.execute({
      detail: false,
      kind: "session.show",
      session: sessionId,
    }, { signal });
    expect(factsMemory.epochs.get(sessionId)).toBe(2);
  });
test("sweeps and renews facts memory for remote metadata and provider-list commits", async () => {
    const factsMemory = new FakeFactsMemoryLifecycle();
    let now = 2_000;
    const value = await fixture(new FakeCloud(),
      () => undefined,
      () => now,
      factsMemory,
    );
    const { sessionId } = await createIdleSession(value, "Remote memory activity");
    const session = value.store.requireSession(sessionId);
    const profile = value.store.requireProfileById(session.profileId);
    if (session.providerThreadId === undefined) throw new Error("Expected provider binding.");
    factsMemory.ensures.length = 0;
    factsMemory.sweeps.length = 0;
    now = 20_000;

    await value.service.executeRemote({
      enabled: true,
      kind: "session.fast",
      session: session.id,
    }, remoteAuthorityFor(value.store, session.id), { signal });
    expect(factsMemory.sweeps).toContain(now);
    expect(factsMemory.ensures.at(-1)).toEqual({
      expiresAt: now + FACTS_MEMORY_SESSION_TTL_MS,
      ownerId: profile.id,
      sessionId,
    });

    factsMemory.ensures.length = 0;
    value.codex.listedProjections = [{
      providerThreadId: session.providerThreadId,
      providerUpdatedAt: (session.providerUpdatedAt ?? 0) + 1,
      status: "idle",
      title: session.title,
    }];
    const localPage = await value.service.execute({
      account: profile.id,
      kind: "session.list",
      archived: false,
      limit: 20,
    }, { signal }) as { nextCursor: string | null };
    if (localPage.nextCursor === null) throw new Error("Expected a provider-discovery continuation.");
    await value.service.execute({
      account: profile.id,
      kind: "session.list",
      archived: false,
      limit: 20,
      cursor: localPage.nextCursor,
    }, { signal });
    expect(factsMemory.ensures.at(-1)).toEqual({
      expiresAt: now + FACTS_MEMORY_SESSION_TTL_MS,
      ownerId: profile.id,
      sessionId,
    });
  });
test("terminal recovery commits purge immediately and a poisoned terminal row cannot block restart", async () => {
    const factsMemory = new FakeFactsMemoryLifecycle();
    const value = await fixture(new FakeCloud(),
      () => undefined,
      Date.now,
      factsMemory,
    );
    const { sessionId } = await createIdleSession(value, "Terminal recovery memory");
    const session = value.store.requireSession(sessionId);
    const profile = value.store.requireProfileById(session.profileId);
    if (session.providerThreadId === undefined) throw new Error("Expected provider binding.");
    const authority = liveAuthorityFor(value.store, profile.id);
    await value.service.observeCodexFact(authority, {
      type: "threadStatusChanged",
      threadId: session.providerThreadId,
      status: { type: "systemError" },
    });
    factsMemory.cleanups.length = 0;
    value.codex.readProjection = {
      providerThreadId: session.providerThreadId,
      providerUpdatedAt: (session.providerUpdatedAt ?? 0) + 1,
      status: "terminal",
      title: session.title,
    };
    await expect(value.service.execute({
      kind: "session.recover",
      session: sessionId,
    }, { signal })).resolves.toMatchObject({ session: { state: "terminal" } });
    expect(factsMemory.cleanups.at(-1)).toEqual({
      ownerId: profile.id,
      reason: "archive",
      sessionId,
    });

    const poisoned = value.store.upsertProviderSession({
      providerAuthority: value.store.requireProviderAccountAuthority(profile.id, "codex"),
      profileId: profile.id,
      provider: "codex",
      providerThreadId: "provider-terminal-poisoned",
      preset: "high",
      fastEnabled: false,
      providerUpdatedAt: 1,
      providerAccountKey: codexProviderAccountKey(),
      state: "terminal",
      title: "Poisoned terminal memory",
    });
    const healthy = value.store.upsertProviderSession({
      providerAuthority: value.store.requireProviderAccountAuthority(profile.id, "codex"),
      profileId: profile.id,
      provider: "codex",
      providerThreadId: "provider-terminal-healthy",
      preset: "high",
      fastEnabled: false,
      providerUpdatedAt: 1,
      providerAccountKey: codexProviderAccountKey(),
      state: "terminal",
      title: "Healthy terminal memory",
    });
    const restartMemory = new FakeFactsMemoryLifecycle();
    restartMemory.cleanupErrors.add(poisoned.id);
    const restarted = new OompaService({
      store: value.store,
      paths: value.paths,
      codex: new FakeCodex(),
      cloud: new FakeCloud(),
      daemonAuthority: new FakeDaemonAuthority(),
      factsMemory: restartMemory,
      requestStop: () => undefined,
    });
    await expect(restarted.recover()).resolves.toBeUndefined();
    const cleanedSessionIds = restartMemory.cleanups.map(({ sessionId: candidate }) => candidate);
    expect(cleanedSessionIds).toContain(poisoned.id);
    expect(cleanedSessionIds).toContain(healthy.id);
    restartMemory.cleanupErrors.clear();
    await expect(restarted.execute({ kind: "account.list" }, { signal })).resolves.toBeDefined();
    expect(restartMemory.states.get(poisoned.id)).toBe("purged");
    await restarted.close();
  });
test("purges facts memory before releasing an abandoned local recovery authority", async () => {
    const factsMemory = new FakeFactsMemoryLifecycle();
    const value = await fixture(new FakeCloud(),
      () => undefined,
      Date.now,
      factsMemory,
    );
    const { sessionId } = await createIdleSession(value, "Abandon memory");
    value.store.quarantineSession(sessionId);
    await expect(value.service.execute({ kind: "session.abandon", session: sessionId }, { signal }))
      .resolves.toMatchObject({ recovery: { resolution: "abandoned" } });
    expect(factsMemory.cleanups.at(-1)).toEqual({
      ownerId: value.store.requireSession(sessionId).profileId,
      reason: "abandon",
      sessionId,
    });
  });
test("does not purge facts memory when abandon is rejected for a live session", async () => {
    const factsMemory = new FakeFactsMemoryLifecycle();
    const value = await fixture(new FakeCloud(),
      () => undefined,
      Date.now,
      factsMemory,
    );
    const { sessionId } = await createIdleSession(value, "Live abandon memory");
    await expect(value.service.execute({ kind: "session.abandon", session: sessionId }, { signal }))
      .rejects.toMatchObject({ code: "CONFLICT" });
    expect(factsMemory.cleanups).toEqual([]);
  });
test("returns the created session authority when memory finalization needs an exact retry", async () => {
    const factsMemory = new FakeFactsMemoryLifecycle();
    factsMemory.ensureErrorOnce = new Error("lost memory receipt");
    const value = await fixture(new FakeCloud(),
      () => undefined,
      Date.now,
      factsMemory,
    );
    const added = await value.service.execute({ kind: "account.add", label: "Memory retry" }, { signal }) as { account: { id: string } };
    await value.service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    await value.service.execute({ kind: "project.add", label: "Memory retry docs", path: value.documents }, { signal });
    let details: { idempotencyKey: string; nextCommand: string; sessionId: `sess_${string}` } | undefined;
    try {
      await value.service.execute({
        kind: "session.start",
        account: added.account.id,
        preset: "high",
        presetContract: 2,
        fast: false,
      }, { signal });
    } catch (error: unknown) {
      expect(error).toMatchObject({ code: "RECOVERY_REQUIRED" });
      details = (error as CommandFailure).details as typeof details;
    }
    expect(details).toBeDefined();
    if (details === undefined) throw new Error("Expected memory recovery details.");
    expect(details.nextCommand).toBe(`oompa session show ${details.sessionId}`);
    await expect(value.service.execute({
      kind: "session.show",
      session: details.sessionId,
      detail: false,
    }, { signal })).resolves.toMatchObject({ session: { id: details.sessionId } });
    expect(factsMemory.ensures.filter(({ sessionId }) => sessionId === details.sessionId).length)
      .toBeGreaterThanOrEqual(2);
    expect(value.codex.calls.filter((call) => call.startsWith("start:"))).toHaveLength(1);
  });
test("same-key settled start replay reconciles missing facts memory without another provider start", async () => {
    const factsMemory = new FakeFactsMemoryLifecycle();
    factsMemory.ensureErrorOnce = new Error("lost memory receipt");
    const value = await fixture(new FakeCloud(),
      () => undefined,
      Date.now,
      factsMemory,
    );
    const added = await value.service.execute(
      { kind: "account.add", label: "Same-key memory retry" },
      { signal },
    ) as { account: { id: string } };
    await value.service.execute(
      { kind: "account.login", account: added.account.id, deviceCode: false },
      { signal },
    );
    await value.service.execute(
      { kind: "project.add", label: "Same-key memory retry docs", path: value.documents },
      { signal },
    );
    const command = {
      account: "Same-key memory retry",
      fast: false,
      idempotencyKey: "00000000-0000-4000-8000-00000000041e",
      kind: "session.start" as const,
      preset: "high" as const,
      presetContract: 2 as const,
    };

    await expect(value.service.execute(command, { signal }))
      .rejects.toMatchObject({
        code: "RECOVERY_REQUIRED",
        details: { idempotencyKey: command.idempotencyKey },
      });
    const providerStarts = value.codex.calls.filter((call) => call.startsWith("start:"));
    expect(providerStarts).toHaveLength(1);

    const replayed = await value.service.execute(command, { signal }) as {
      session: { id: string };
    };
    expect(factsMemory.ensures.filter(({ sessionId }) => sessionId === replayed.session.id))
      .toHaveLength(2);
    expect(value.codex.calls.filter((call) => call.startsWith("start:")))
      .toEqual(providerStarts);
  });
test("same-key settled start replay keeps terminal facts memory purged without live dependencies", async () => {
    const factsMemory = new FakeFactsMemoryLifecycle();
    const value = await fixture(new FakeCloud(),
      () => undefined,
      Date.now,
      factsMemory,
    );
    const added = await value.service.execute(
      { kind: "account.add", label: "Terminal start replay" },
      { signal },
    ) as { account: { id: string } };
    await value.service.execute(
      { kind: "account.login", account: added.account.id, deviceCode: false },
      { signal },
    );
    await value.service.execute(
      { kind: "project.add", label: "Terminal start replay docs", path: value.documents },
      { signal },
    );
    const command = {
      account: added.account.id,
      fast: false,
      idempotencyKey: "00000000-0000-4000-8000-00000000041f",
      kind: "session.start" as const,
      preset: "high" as const,
      presetContract: 2 as const,
    };
    const first = await value.service.execute(command, { signal }) as {
      session: { id: `sess_${string}`; profileId: `acct_${string}`; providerThreadId?: string };
    };
    if (first.session.providerThreadId === undefined) {
      throw new Error("Expected a provider-bound started session.");
    }
    const profile = value.store.requireProfileById(first.session.profileId);
    await value.service.observeCodexFact(liveAuthorityFor(value.store, profile.id, "codex"), {
      ...parseFact("thread/deleted", { threadId: first.session.providerThreadId }),
      connectionId: value.codex.observationConnectionId,
    });
    await value.service.settled();
    expect(value.store.requireSession(first.session.id).state).toBe("terminal");
    expect(factsMemory.states.get(first.session.id)).toBe("purged");

    await rename(value.documents, `${value.documents}-missing`);
    value.cloud.beforeProjectionUnsettledProfileReturn = () => {
      throw new Error("A terminal settled start replay must not query current cloud recovery state.");
    };
    const providerCalls = [...value.codex.calls];
    const ensureCount = factsMemory.ensures.length;
    const cleanupCount = factsMemory.cleanups.length;

    await expect(value.service.execute(command, { signal })).resolves.toMatchObject({
      idempotencyKey: command.idempotencyKey,
      session: { id: first.session.id, state: "terminal" },
    });
    expect(factsMemory.ensures).toHaveLength(ensureCount);
    expect(factsMemory.cleanups.length).toBeGreaterThan(cleanupCount);
    expect(factsMemory.states.get(first.session.id)).toBe("purged");
    expect(value.codex.calls).toEqual(providerCalls);
  });
test("refreshes usage without treating missing data as zero", async () => {
    const { service } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Usage" }, { signal }) as { account: { id: string } };
    const before = await service.execute({ kind: "account.usage", account: added.account.id, refresh: false }, { signal });
    expect(before).toMatchObject({ usage: [{ snapshot: null }] });
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    const after = await service.execute({ kind: "account.usage", account: added.account.id, refresh: true }, { signal });
    expect(after).toMatchObject({ usage: [{ snapshot: { payload: { primary: { usedPercent: 25 } } } }] });
  });
test("revokes a changed provider identity before reading below-threshold usage", async () => {
    const { service, codex, store } = await fixture();
    const added = await service.execute({
      kind: "account.add",
      label: "Usage identity",
    }, { signal }) as { account: { id: `acct_${string}` } };
    await service.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: false,
    }, { signal });
    codex.accountProjection = {
      signedIn: true,
      email: "other@example.com",
      plan: "Plus",
    };
    codex.usageResult = {
      revision: 1,
      observedAt: 2_000,
      payload: { primary: { usedPercent: 20 }, privateIdentity: "other" },
    };
    const callsBefore = codex.calls.length;
    await expect(service.execute({
      kind: "account.usage",
      account: added.account.id,
      refresh: true,
    }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    await service.settled();
    expect(codex.calls.slice(callsBefore)).toEqual(["readAccount"]);
    expect(store.latestUsage(added.account.id)).toBeNull();
    expect(codex.resetIdempotencyKeys).toEqual([]);
    expect(store.requireAccountRateLimitResetPolicy(added.account.id)).toMatchObject({
      state: "reconciliation_required",
      accountFingerprint: null,
      weeklyWindowResetsAt: null,
    });
    await expect(service.execute({
      kind: "account.usage",
      account: added.account.id,
      refresh: false,
    }, { signal })).resolves.toMatchObject({
      usage: [{
        account: { processGeneration: 2, state: "signed_out" },
        automaticReset: { policy: { state: "reconciliation_required" } },
        poll: { state: "never_observed" },
        snapshot: null,
      }],
    });
  });
test("discards usage when the provider identity changes during the read", async () => {
    const { service, codex, store } = await fixture();
    const added = await service.execute({
      kind: "account.add",
      label: "Usage identity sandwich",
    }, { signal }) as { account: { id: `acct_${string}` } };
    await service.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: false,
    }, { signal });
    codex.usageResult = {
      revision: 1,
      observedAt: 2_000,
      payload: { primary: { usedPercent: 20 }, privateIdentity: "other" },
    };
    codex.beforeReadUsageReturn = async () => {
      codex.accountProjection = {
        signedIn: true,
        email: "other@example.com",
        plan: "Plus",
      };
    };
    await expect(service.execute({
      kind: "account.usage",
      account: added.account.id,
      refresh: true,
    }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    await service.settled();
    expect(codex.calls.slice(-3)).toEqual(["readAccount", "usage", "readAccount"]);
    expect(store.latestUsage(added.account.id)).toBeNull();
    expect(codex.resetIdempotencyKeys).toEqual([]);
  });
test("rejects an initial usage identity proof when its exact provider binding is replaced", async () => {
    const { service, codex, store } = await fixture();
    const added = await service.execute({
      kind: "account.add",
      label: "Usage initial authority race",
    }, { signal }) as { account: { id: `acct_${string}` } };
    await service.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: false,
    }, { signal });
    const captured = store.requireProviderAccountAuthority(added.account.id, "codex");
    codex.beforeReadAccountReturn = async () => {
      expect(store.setProfileState(
        added.account.id,
        captured.processGeneration,
        "signed_out",
      )).toBe(true);
    };

    await expect(service.execute({
      kind: "account.usage",
      account: added.account.id,
      refresh: true,
    }, { signal })).rejects.toMatchObject({ code: "CONFLICT" });

    expect(codex.readAccountAuthorities.slice(-1)[0]).toMatchObject({
      bindingGeneration: captured.bindingGeneration,
      generation: captured.processGeneration,
      id: captured.profileId,
      provider: "codex",
      providerAccountId: captured.providerAccountId,
    });
    expect(codex.readUsageAuthorities).toEqual([]);
    expect(store.requireProviderAccountAuthority(added.account.id, "codex")).toMatchObject({
      bindingGeneration: captured.bindingGeneration + 1,
      processGeneration: captured.processGeneration,
    });
    expect(store.latestUsage(added.account.id)).toBeNull();
  });
test("does not cross to a replacement binding after a successful Codex usage read", async () => {
    const { service, codex, store } = await fixture();
    const added = await service.execute({
      kind: "account.add",
      label: "Usage success authority race",
    }, { signal }) as { account: { id: `acct_${string}` } };
    await service.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: false,
    }, { signal });
    const captured = store.requireProviderAccountAuthority(added.account.id, "codex");
    const accountReadsBefore = codex.readAccountAuthorities.length;
    codex.beforeReadUsageReturn = async () => {
      expect(store.setProfileState(
        added.account.id,
        captured.processGeneration,
        "signed_out",
      )).toBe(true);
    };

    await expect(service.execute({
      kind: "account.usage",
      account: added.account.id,
      refresh: true,
    }, { signal })).rejects.toMatchObject({ code: "CONFLICT" });

    const dispatched = [
      ...codex.readAccountAuthorities.slice(accountReadsBefore),
      ...codex.readUsageAuthorities,
    ];
    expect(dispatched).toHaveLength(2);
    for (const authority of dispatched) {
      expect(authority).toMatchObject({
        bindingGeneration: captured.bindingGeneration,
        generation: captured.processGeneration,
        id: captured.profileId,
        provider: "codex",
        providerAccountId: captured.providerAccountId,
      });
    }
    expect(store.requireProviderAccountAuthority(added.account.id, "codex")).toMatchObject({
      bindingGeneration: captured.bindingGeneration + 1,
      processGeneration: captured.processGeneration,
    });
    expect(store.latestUsage(added.account.id)).toBeNull();
  });
test("preserves the original read failure and writes no failure row after authority replacement", async () => {
    const { service, codex, store } = await fixture();
    const added = await service.execute({
      kind: "account.add",
      label: "Usage failure authority race",
    }, { signal }) as { account: { id: `acct_${string}` } };
    await service.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: false,
    }, { signal });
    const captured = store.requireProviderAccountAuthority(added.account.id, "codex");
    const readFailure = new Error("provider usage exploded");
    codex.usageError = readFailure;
    codex.beforeReadUsageReturn = async () => {
      expect(store.setProfileState(
        added.account.id,
        captured.processGeneration,
        "signed_out",
      )).toBe(true);
    };

    let rejected: unknown;
    try {
      await service.execute({
        kind: "account.usage",
        account: added.account.id,
        refresh: true,
      }, { signal });
    } catch (error: unknown) {
      rejected = error;
    }
    expect(rejected).toBe(readFailure);
    expect(codex.readUsageAuthorities.slice(-1)[0]).toMatchObject({
      bindingGeneration: captured.bindingGeneration,
      generation: captured.processGeneration,
      providerAccountId: captured.providerAccountId,
    });
    const fingerprint = createHash("sha256").update("person@example.com").digest("hex");
    expect(store.latestUsagePollFailure(added.account.id, fingerprint)).toBeNull();
    expect(store.latestUsage(added.account.id)).toBeNull();
  });
test("rejects a replacement that lands during the exact post-read identity proof", async () => {
    const { service, codex, store } = await fixture();
    const added = await service.execute({
      kind: "account.add",
      label: "Usage second proof authority race",
    }, { signal }) as { account: { id: `acct_${string}` } };
    await service.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: false,
    }, { signal });
    const captured = store.requireProviderAccountAuthority(added.account.id, "codex");
    const accountReadsBefore = codex.readAccountAuthorities.length;
    let usageProofReads = 0;
    codex.beforeReadAccountReturn = async () => {
      usageProofReads += 1;
      if (usageProofReads === 2) {
        expect(store.setProfileState(
          added.account.id,
          captured.processGeneration,
          "signed_out",
        )).toBe(true);
      }
    };

    await expect(service.execute({
      kind: "account.usage",
      account: added.account.id,
      refresh: true,
    }, { signal })).rejects.toMatchObject({ code: "CONFLICT" });

    expect(usageProofReads).toBe(2);
    const dispatched = [
      ...codex.readAccountAuthorities.slice(accountReadsBefore),
      ...codex.readUsageAuthorities,
    ];
    expect(dispatched).toHaveLength(3);
    for (const authority of dispatched) {
      expect(authority).toMatchObject({
        bindingGeneration: captured.bindingGeneration,
        generation: captured.processGeneration,
        id: captured.profileId,
        provider: "codex",
        providerAccountId: captured.providerAccountId,
      });
    }
    expect(store.requireProviderAccountAuthority(added.account.id, "codex")).toMatchObject({
      bindingGeneration: captured.bindingGeneration + 1,
      processGeneration: captured.processGeneration,
    });
    expect(store.latestUsage(added.account.id)).toBeNull();
  });
test("keeps below-threshold usage polling to the identity sandwich", async () => {
    const { service, codex } = await fixture();
    const added = await service.execute({
      kind: "account.add",
      label: "Below reset threshold",
    }, { signal }) as { account: { id: `acct_${string}` } };
    await service.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: false,
    }, { signal });
    codex.usageResult = {
      revision: 1,
      observedAt: 2_000,
      payload: {
        rateLimits: {
          primary: {
            limitId: "codex",
            primary: {
              usedPercent: 50,
              windowDurationMins: 10_080,
              resetsAt: automaticResetWindowResetsAtSeconds,
            },
            secondary: null,
          },
          byLimitId: null,
          resetCreditsAvailable: 1,
        },
      },
    };

    const callsBefore = codex.calls.length;
    await expect(service.execute({
      kind: "account.usage",
      account: added.account.id,
      refresh: true,
    }, { signal })).resolves.toMatchObject({
      usage: [{
        automaticReset: {
          refresh: { state: "not_eligible", reason: "below_threshold" },
        },
      }],
    });
    expect(codex.calls.slice(callsBefore)).toEqual([
      "readAccount",
      "usage",
      "readAccount",
    ]);
    expect(codex.resetIdempotencyKeys).toEqual([]);
  });
describe("automatic policy reset admission", () => {
    const fingerprint = createHash("sha256").update("person@example.com").digest("hex");
    const limits = (usedPercent = 99, credits = 1, resetsAt = automaticResetWindowResetsAtSeconds) => ({
      rateLimits: {
        primary: {
          limitId: "codex",
          primary: { usedPercent, windowDurationMins: 10_080, resetsAt },
          secondary: null,
        },
        byLimitId: null,
        resetCreditsAvailable: credits,
      },
    });
    const configure = (
      store: StateStore,
      change: Parameters<StateStore["updateAutomaticUsagePolicyConfiguration"]>[0]["change"],
    ) => store.updateAutomaticUsagePolicyConfiguration({
      idempotencyKey: crypto.randomUUID(),
      expectedAutomaticPolicyRevision: store.readAutomaticUsagePolicyConfiguration().automaticPolicyRevision,
      change,
    });
    const setup = async () => {
      const value = await fixture(new FakeCloud(), () => undefined,
        () => automaticResetWindowResetsAt - 3 * 24 * 60 * 60_000);
      const added = await value.service.execute({ kind: "account.add", label: "Policy reset" }, { signal }) as {
        account: { id: `acct_${string}` };
      };
      await value.service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
      value.codex.usageResult = { revision: 1, observedAt: 2_000, payload: limits() };
      return { ...value, profileId: added.account.id };
    };
    const refresh = (value: Awaited<ReturnType<typeof setup>>) => value.service.execute({
      kind: "account.usage", account: value.profileId, refresh: true,
    }, { signal });
    const effectRows = (value: Awaited<ReturnType<typeof setup>>) => {
      const db = new Database(value.paths.database, { readonly: true, strict: true });
      try {
        return {
          attempts: db.query("SELECT * FROM account_rate_limit_reset_attempts ORDER BY idempotency_key").all(),
          authorities: db.query("SELECT * FROM account_rate_limit_reset_provider_authorities ORDER BY idempotency_key,process_generation,policy_revision").all(),
          rebinds: db.query("SELECT * FROM account_rate_limit_reset_rebinds ORDER BY idempotency_key,from_process_generation").all(),
          policies: db.query("SELECT * FROM account_rate_limit_reset_policies ORDER BY profile_id").all(),
          sessions: db.query("SELECT * FROM sessions ORDER BY id").all(),
          mutations: db.query("SELECT * FROM mutation_attempts ORDER BY id").all(),
          pointers: db.query("SELECT * FROM provider_account_states ORDER BY provider").all(),
        };
      } finally { db.close(false); }
    };

    for (const scenario of [
      { name: "inherited default off", defaultEnabled: false, codex: "inherit", claude: "inherit", enabled: false },
      { name: "Codex off overrides default on", defaultEnabled: true, codex: "off", claude: "on", enabled: false },
      { name: "Codex on overrides default off", defaultEnabled: false, codex: "on", claude: "off", enabled: true },
      { name: "Claude off does not disable Codex", defaultEnabled: true, codex: "inherit", claude: "off", enabled: true },
      { name: "inherited default on", defaultEnabled: true, codex: "inherit", claude: "inherit", enabled: true },
    ] as const) {
      test(`honors effective policy: ${scenario.name}`, async () => {
        const value = await setup();
        configure(value.store, { kind: "set_default", enabled: scenario.defaultEnabled });
        configure(value.store, { kind: "set_override", provider: "codex", override: scenario.codex });
        configure(value.store, { kind: "set_override", provider: "claude", override: scenario.claude });
        const before = effectRows(value);
        const callsBefore = value.codex.calls.length;
        const response = await refresh(value);
        expect(response).toMatchObject({ usage: [{ automaticReset: { refresh: scenario.enabled
          ? { state: "settled", outcome: "reset" }
          : { state: "suppressed", reason: "automatic_policy_disabled" } } }] });
        expect(value.codex.resetIdempotencyKeys).toHaveLength(scenario.enabled ? 1 : 0);
        expect(value.codex.committedStartTurns).toBe(0);
        expect(value.codex.turnEffectTrace).toEqual([]);
        expect(value.store.usageRange({ profileId: value.profileId })).toHaveLength(scenario.enabled ? 2 : 1);
        expect(effectRows(value).pointers).toEqual(before.pointers);
        expect(effectRows(value).sessions).toEqual(before.sessions);
        if (!scenario.enabled) {
          expect(value.codex.calls.slice(callsBefore)).toEqual(["readAccount", "usage", "readAccount"]);
          expect(effectRows(value)).toEqual(before);
          const passiveCalls = value.codex.calls.length;
          await value.service.execute({ kind: "account.usage", account: value.profileId, refresh: false }, { signal });
          expect(value.codex.calls).toHaveLength(passiveCalls);
          expect(effectRows(value)).toEqual(before);
        }
      });
    }

    for (const state of ["prepared", "retryable", "ambiguous", "effect_started"] as const) {
      test(`keeps disabled ${state} attempt immutable without reset or turn`, async () => {
        const value = await setup();
        const profile = value.store.requireProfileById(value.profileId);
        expect(value.store.authorizeAccountRateLimitResetPolicy({
          profileId: profile.id, processGeneration: profile.processGeneration,
          accountFingerprint: fingerprint, weeklyWindowDurationMinutes: 10_080,
          weeklyWindowResetsAt: automaticResetWindowResetsAt,
        }).decision).toBe("allow");
        const attempt = value.store.prepareAccountRateLimitReset({
          profileId: profile.id, processGeneration: profile.processGeneration,
          accountFingerprint: fingerprint, weeklyWindowResetsAt: automaticResetWindowResetsAt,
          observedUsedPercent: 99,
        });
        if (state !== "prepared") {
          value.store.beginAccountRateLimitReset(attempt.idempotencyKey,
            value.store.requireProviderAccountAuthority(profile.id, "codex"));
          if (state !== "effect_started") value.store.deferAccountRateLimitReset(attempt.idempotencyKey, state);
        }
        configure(value.store, { kind: "set_override", provider: "codex", override: "off" });
        const before = effectRows(value);
        const callsBefore = value.codex.calls.length;
        for (const payload of [limits(), limits(0, 0, automaticResetWindowResetsAtSeconds + 86_400)]) {
          value.codex.usageResult = { revision: 2, observedAt: 2_001, payload };
          expect(await refresh(value)).toMatchObject({ usage: [{ automaticReset: { refresh:
            state === "ambiguous" || state === "effect_started"
              ? { state: "recovery_pending" }
              : { state: "suppressed", reason: "automatic_policy_disabled" },
          } }] });
          expect(effectRows(value)).toEqual(before);
          expect(value.store.readRecoverableAccountRateLimitReset(profile.id, fingerprint))
            .toMatchObject({ idempotencyKey: attempt.idempotencyKey, state, outcome: null, localResolution: null });
        }
        expect(value.codex.resetIdempotencyKeys).toEqual([]);
        expect(value.codex.calls.slice(callsBefore)).toEqual([
          "readAccount", "usage", "readAccount", "readAccount", "usage", "readAccount",
        ]);
        expect(value.codex.committedStartTurns).toBe(0);
        expect(value.codex.turnEffectTrace).toEqual([]);
      });
    }

    test("re-enabling reconciles the same disabled ambiguous key after rollover", async () => {
      const value = await setup();
      value.codex.resetError = new IndeterminateCodexEffectError("account/rateLimitResetCredit/consume", 99);
      expect(await refresh(value)).toMatchObject({ usage: [{ automaticReset: { refresh: { state: "recovery_pending" } } }] });
      const key = value.codex.resetIdempotencyKeys[0];
      if (key === undefined) throw new Error("Expected original ambiguous key.");
      configure(value.store, { kind: "set_default", enabled: false });
      const before = effectRows(value);
      value.codex.resetError = undefined;
      value.codex.resetOutcome = "alreadyRedeemed";
      value.codex.usageResult = { revision: 2, observedAt: 2_001,
        payload: limits(0, 0, automaticResetWindowResetsAtSeconds + 86_400) };
      expect(await refresh(value)).toMatchObject({ usage: [{ automaticReset: {
        lastAttempt: { state: "recovery_pending" }, refresh: { state: "recovery_pending" },
      } }] });
      expect(value.codex.resetIdempotencyKeys).toEqual([key]);
      expect(effectRows(value)).toEqual(before);
      configure(value.store, { kind: "set_override", provider: "codex", override: "on" });
      const usageBefore = value.store.usageRange({ profileId: value.profileId }).length;
      expect(await refresh(value)).toMatchObject({ usage: [{ automaticReset: {
        lastAttempt: { state: "settled", outcome: "alreadyRedeemed" },
        refresh: { state: "settled", outcome: "alreadyRedeemed" },
      } }] });
      expect(value.codex.resetIdempotencyKeys).toEqual([key, key]);
      expect(value.store.latestAccountRateLimitResetAttempt(value.profileId, fingerprint))
        .toMatchObject({ idempotencyKey: key, state: "settled", outcome: "alreadyRedeemed" });
      expect(value.store.usageRange({ profileId: value.profileId })).toHaveLength(usageBefore + 2);
      expect(effectRows(value).pointers).toEqual(before.pointers);
      expect(effectRows(value).sessions).toEqual(before.sessions);
      expect(value.codex.committedStartTurns).toBe(0);
    });

    test("rechecks disable after the awaited final identity proof", async () => {
      const value = await setup();
      let accountReads = 0;
      let disabled = false;
      value.codex.beforeReadAccountReturn = async () => {
        accountReads += 1;
        if (accountReads === 3) {
          await Promise.resolve();
          configure(value.store, { kind: "set_override", provider: "codex", override: "off" });
          disabled = true;
        }
      };
      const pointer = value.store.readProviderAccountState("codex");
      expect(await refresh(value)).toMatchObject({ usage: [{ automaticReset: {
        refresh: { state: "suppressed", reason: "automatic_policy_disabled" },
      } }] });
      expect(disabled).toBe(true);
      expect(accountReads).toBe(3);
      expect(value.codex.resetIdempotencyKeys).toEqual([]);
      expect(value.store.latestAccountRateLimitResetAttempt(value.profileId, fingerprint)).toBeNull();
      expect(value.store.readProviderAccountState("codex")).toEqual(pointer);
      expect(value.codex.committedStartTurns).toBe(0);
      expect(effectRows(value).sessions).toEqual([]);
    });

    for (const state of ["fresh", "ambiguous"] as const) {
      test(`handles a final begin refusal for ${state} without rewriting recovery evidence`, async () => {
        const value = await setup();
        if (state === "ambiguous") {
          value.codex.resetError = new IndeterminateCodexEffectError("account/rateLimitResetCredit/consume", 99);
          expect(await refresh(value)).toMatchObject({ usage: [{ automaticReset: { refresh: { state: "recovery_pending" } } }] });
          value.codex.resetError = undefined;
        }
        const originalKeys = [...value.codex.resetIdempotencyKeys];
        const begin = value.store.beginAccountRateLimitReset.bind(value.store);
        const begins: ReturnType<typeof effectRows>[] = [];
        Object.defineProperty(value.store, "beginAccountRateLimitReset", {
          configurable: true,
          value: (...args: Parameters<StateStore["beginAccountRateLimitReset"]>) => {
            // Commit through the real configuration API at the final boundary.
            // The real begin transaction, not a synthetic thrown error, refuses.
            configure(value.store, { kind: "set_override", provider: "codex", override: "off" });
            begins.push(effectRows(value));
            return begin(...args);
          },
        });
        expect(await refresh(value)).toMatchObject({ usage: [{ automaticReset: { refresh: state === "ambiguous"
          ? { state: "recovery_pending" }
          : { state: "suppressed", reason: "automatic_policy_disabled" },
        } }] });
        expect(begins).toHaveLength(1);
        const before = begins[0];
        if (before === undefined) throw new Error("Expected the real final begin boundary.");
        expect(effectRows(value)).toEqual(before);
        expect(value.codex.resetIdempotencyKeys).toEqual(originalKeys);
        expect(value.store.readRecoverableAccountRateLimitReset(value.profileId, fingerprint))
          .toMatchObject({ state: state === "ambiguous" ? "ambiguous" : "prepared", outcome: null, localResolution: null });
        expect(value.codex.committedStartTurns).toBe(0);
        expect(value.codex.turnEffectTrace).toEqual([]);
      });
    }

    test("settles and rereads an admitted in-flight success after disable", async () => {
      const value = await setup();
      let signalReset!: () => void;
      const resetStarted = new Promise<void>((resolve) => { signalReset = resolve; });
      let releaseReset!: () => void;
      const resetGate = new Promise<void>((resolve) => { releaseReset = resolve; });
      value.codex.beforeResetReturn = async () => { signalReset(); await resetGate; };
      const pointer = value.store.readProviderAccountState("codex");
      const pending = refresh(value);
      try {
        await resetStarted;
        expect(value.store.readRecoverableAccountRateLimitReset(value.profileId, fingerprint))
          .toMatchObject({ state: "effect_started" });
        configure(value.store, { kind: "set_default", enabled: false });
        value.codex.usageResult = { revision: 2, observedAt: 2_001, payload: limits(0, 0) };
      } finally { releaseReset(); }
      expect(await pending).toMatchObject({ usage: [{
        automaticReset: { lastAttempt: { state: "settled", outcome: "reset" }, refresh: { state: "settled", outcome: "reset" } },
        snapshot: { sourceRevision: 2, payload: limits(0, 0) },
      }] });
      const key = value.codex.resetIdempotencyKeys[0];
      if (key === undefined) throw new Error("Expected admitted reset key.");
      expect(value.store.latestAccountRateLimitResetAttempt(value.profileId, fingerprint))
        .toMatchObject({ idempotencyKey: key, state: "settled", outcome: "reset" });
      expect(value.store.usageRange({ profileId: value.profileId }).map((row) => row.sourceRevision)).toEqual([1, 2]);
      expect(await refresh(value)).toMatchObject({ usage: [{ automaticReset: {
        refresh: { state: "suppressed", reason: "automatic_policy_disabled" },
      } }] });
      expect(value.codex.resetIdempotencyKeys).toEqual([key]);
      expect(value.store.readProviderAccountState("codex")).toEqual(pointer);
      expect(value.codex.committedStartTurns).toBe(0);
      expect(effectRows(value).sessions).toEqual([]);
    });

    test("automatic policy commands disable Codex before an exhausted usage refresh", async () => {
      const value = await setup();
      const command = { kind: "usage.auto.set", idempotencyKey: crypto.randomUUID(), expectedAutomaticPolicyRevision: 1,
        change: { kind: "set_override", provider: "codex", override: "off" } };
      expect(await value.service.execute(localCommandSchema.parse(command), { signal })).toMatchObject({
        configuration: { automaticPolicyRevision: 2, overrides: { codex: "off", claude: "inherit" } },
        effective: [{ provider: "codex", enabled: false, source: "override", automaticPolicyRevision: 2 },
          { provider: "claude", enabled: true, source: "default", automaticPolicyRevision: 2 }],
      });
      expect(await value.service.execute(localCommandSchema.parse({ kind: "usage.auto.status", provider: "codex" }), { signal }))
        .toMatchObject({ effective: [{ provider: "codex", enabled: false, source: "override", automaticPolicyRevision: 2 }] });
      const before = effectRows(value);
      const callsBefore = value.codex.calls.length;
      expect(await refresh(value)).toMatchObject({ usage: [{ automaticReset: {
        refresh: { state: "suppressed", reason: "automatic_policy_disabled" },
      } }] });
      expect(value.codex.calls.slice(callsBefore)).toEqual(["readAccount", "usage", "readAccount"]);
      expect(value.store.usageRange({ profileId: value.profileId })).toHaveLength(1);
      expect(value.codex.resetIdempotencyKeys).toEqual([]);
      expect(effectRows(value)).toEqual(before);
    });

    test("fails closed before reset when automatic policy cannot be read", async () => {
      const value = await setup();
      const before = effectRows(value);
      Object.defineProperty(value.store, "readAutomaticUsagePolicyConfiguration", {
        configurable: true,
        value: () => { throw new Error("test automatic policy unavailable"); },
      });
      await expect(refresh(value)).rejects.toMatchObject({
        code: "UNAVAILABLE",
        message: "A required local or provider capability is unavailable.",
      });
      expect(value.codex.resetIdempotencyKeys).toEqual([]);
      expect(effectRows(value)).toEqual(before);
      expect(value.codex.committedStartTurns).toBe(0);
    });
  });
test("automatically consumes one reset at one percent remaining and rereads limits", async () => {
    const { service, codex, store } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Auto reset" }, { signal }) as { account: { id: `acct_${string}` } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    const limits = (usedPercent: number, credits: number) => ({
      usage: { summary: { lifetimeTokens: 10 } },
      rateLimits: {
        primary: {
          limitId: "codex",
          primary: { usedPercent: 80, windowDurationMins: 300, resetsAt: automaticResetWindowResetsAtSeconds },
          secondary: { usedPercent, windowDurationMins: 10_080, resetsAt: automaticResetWindowResetsAtSeconds },
        },
        byLimitId: null,
        resetCreditsAvailable: credits,
      },
    });
    const afterReset = { revision: 2, observedAt: 2_001, payload: limits(0, 0) };
    codex.usageResult = afterReset;
    codex.usageResults.push(
      { revision: 1, observedAt: 2_000, payload: limits(99, 1) },
      afterReset,
    );

    const response = await service.execute({
      kind: "account.usage",
      account: added.account.id,
      refresh: true,
    }, { signal });
    expect(codex.calls.slice(-8)).toEqual([
      "readAccount",
      "usage",
      "readAccount",
      "readAccount",
      "reset",
      "readAccount",
      "usage",
      "readAccount",
    ]);
    expect(codex.resetIdempotencyKeys).toHaveLength(1);
    expect(store.usageRange({ profileId: added.account.id }).map((row) => row.sourceRevision))
      .toEqual([1, 2]);
    expect(response).toMatchObject({
      usage: [{
        automaticReset: {
          threshold: { remainingPercent: 1, usedPercent: 99 },
          observation: {
            state: "available",
            creditsAvailable: 0,
            remainingPercent: 100,
            usedPercent: 0,
          },
          lastAttempt: {
            state: "settled",
            outcome: "reset",
            weeklyWindowResetsAt: automaticResetWindowResetsAt,
          },
          refresh: { state: "settled", outcome: "reset" },
        },
        snapshot: { sourceRevision: 2, payload: limits(0, 0) },
      }],
    });

    await service.execute({
      kind: "account.usage",
      account: added.account.id,
      refresh: true,
    }, { signal });
    expect(codex.resetIdempotencyKeys).toHaveLength(1);
  });
test("rechecks the provider identity immediately before automatic reset dispatch", async () => {
    const { service, codex, daemonAuthority, store } = await fixture();
    const added = await service.execute({
      kind: "account.add",
      label: "Reset identity fence",
    }, { signal }) as { account: { id: `acct_${string}` } };
    await service.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: false,
    }, { signal });
    codex.usageResult = {
      revision: 1,
      observedAt: 2_000,
      payload: {
        rateLimits: {
          primary: {
            limitId: "codex",
            primary: {
              usedPercent: 99,
              windowDurationMins: 10_080,
              resetsAt: automaticResetWindowResetsAtSeconds,
            },
            secondary: null,
          },
          byLimitId: null,
          resetCreditsAvailable: 1,
        },
      },
    };
    let identityChanged = false;
    daemonAuthority.beforeAssert = async () => {
      if (
        !identityChanged
        && codex.calls.slice(-3).join(",") === "readAccount,usage,readAccount"
      ) {
        identityChanged = true;
        codex.accountProjection = {
          signedIn: true,
          email: "replacement@example.com",
          plan: "Plus",
        };
      }
    };

    const callsBefore = codex.calls.length;
    await expect(service.execute({
      kind: "account.usage",
      account: added.account.id,
      refresh: true,
    }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    await service.settled();
    expect(identityChanged).toBe(true);
    expect(codex.calls.slice(callsBefore)).toEqual([
      "readAccount",
      "usage",
      "readAccount",
      "readAccount",
    ]);
    expect(codex.resetIdempotencyKeys).toEqual([]);
    expect(store.requireProfileById(added.account.id)).toMatchObject({
      processGeneration: 2,
      state: "signed_out",
    });
    expect(store.requireAccountRateLimitResetPolicy(added.account.id)).toMatchObject({
      state: "reconciliation_required",
      accountFingerprint: null,
      weeklyWindowResetsAt: null,
    });
    await expect(service.execute({
      kind: "account.usage",
      account: added.account.id,
      refresh: false,
    }, { signal })).resolves.toMatchObject({
      usage: [{
        automaticReset: { policy: { state: "reconciliation_required" } },
      }],
    });

    codex.loginResult = {
      status: "signed_in",
      account: {
        signedIn: true,
        email: "replacement@example.com",
        plan: "Plus",
      },
    };
    await service.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: false,
    }, { signal });
    await expect(service.execute({
      kind: "account.usage",
      account: added.account.id,
      refresh: true,
    }, { signal })).resolves.toMatchObject({
      usage: [{ automaticReset: {
        policy: {
          state: "window_suppressed",
          weeklyWindowResetsAt: automaticResetWindowResetsAt,
        },
        refresh: { state: "suppressed", reason: "reconciliation_window" },
      } }],
    });
    expect(codex.resetIdempotencyKeys).toEqual([]);
    expect(store.requireAccountRateLimitResetPolicy(added.account.id)).toMatchObject({
      state: "window_suppressed",
      accountFingerprint: createHash("sha256")
        .update("replacement@example.com").digest("hex"),
      weeklyWindowResetsAt: automaticResetWindowResetsAt,
    });
  });
test("suppresses the first reconciled window through its boundary before activating a later window", async () => {
    let now = 1_000_000_000;
    const suppressedWindow = now + 3 * 24 * 60 * 60 * 1_000;
    const laterWindow = suppressedWindow + 3 * 24 * 60 * 60 * 1_000;
    const { service, codex, store } = await fixture(new FakeCloud(),
      () => undefined,
      () => now,
    );
    const added = await service.execute({
      kind: "account.add",
      label: "Legacy reset reconciliation",
    }, { signal }) as { account: { id: `acct_${string}` } };
    await service.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: false,
    }, { signal });
    const original = store.requireProfileById(added.account.id);
    const originalFingerprint = createHash("sha256")
      .update("person@example.com").digest("hex");
    expect(store.authorizeAccountRateLimitResetPolicy({
      profileId: original.id,
      processGeneration: original.processGeneration,
      accountFingerprint: originalFingerprint,
      weeklyWindowDurationMinutes: 10_080,
      weeklyWindowResetsAt: suppressedWindow,
    }).decision).toBe("allow");
    const legacyEmail = "legacy@example.com";
    expect(store.setProfileState(
      original.id,
      original.processGeneration,
      "signed_in",
      { email: legacyEmail, plan: "Plus" },
    )).toBe(true);
    const legacy = store.requireProfileById(original.id);
    const legacyFingerprint = createHash("sha256").update(legacyEmail).digest("hex");
    expect(store.requireAccountRateLimitResetPolicy(legacy.id)).toMatchObject({
      state: "reconciliation_required",
      accountFingerprint: null,
      weeklyWindowResetsAt: null,
    });
    codex.accountProjection = { signedIn: true, email: legacyEmail, plan: "Plus" };

    const payload = (usedPercent: number, credits: number, resetsAt: number) => ({
      rateLimits: {
        primary: {
          limitId: "codex",
          primary: {
            usedPercent,
            windowDurationMins: 10_080,
            resetsAt,
          },
          secondary: null,
        },
        byLimitId: null,
        resetCreditsAvailable: credits,
      },
    });
    codex.usageResult = {
      revision: 1,
      observedAt: 2_000,
      payload: payload(0, 0, suppressedWindow / 1_000),
    };
    await expect(service.execute({
      kind: "account.usage",
      account: legacy.id,
      refresh: true,
    }, { signal })).resolves.toMatchObject({
      usage: [{ automaticReset: {
        policy: {
          state: "window_suppressed",
          weeklyWindowResetsAt: suppressedWindow,
        },
        refresh: { state: "suppressed", reason: "reconciliation_window" },
      } }],
    });
    expect(codex.resetIdempotencyKeys).toEqual([]);
    expect(store.latestAccountRateLimitResetAttempt(legacy.id, legacyFingerprint))
      .toBeNull();

    codex.usageResult = {
      revision: 2,
      observedAt: 3_000,
      payload: payload(99, 1, suppressedWindow / 1_000),
    };
    await service.execute({
      kind: "account.usage",
      account: legacy.id,
      refresh: true,
    }, { signal });
    expect(codex.resetIdempotencyKeys).toEqual([]);

    now = suppressedWindow - 1_000;
    codex.usageResult = {
      revision: 3,
      observedAt: 4_000,
      payload: payload(99, 1, laterWindow / 1_000),
    };
    await expect(service.execute({
      kind: "account.usage",
      account: legacy.id,
      refresh: true,
    }, { signal })).resolves.toMatchObject({
      usage: [{ automaticReset: {
        policy: {
          state: "window_suppressed",
          weeklyWindowResetsAt: suppressedWindow,
        },
        refresh: { state: "suppressed", reason: "weekly_window_nonmonotonic" },
      } }],
    });
    expect(codex.resetIdempotencyKeys).toEqual([]);

    now = suppressedWindow;
    codex.usageResult = {
      revision: 4,
      observedAt: 5_000,
      payload: payload(0, 1, laterWindow / 1_000),
    };
    await expect(service.execute({
      kind: "account.usage",
      account: legacy.id,
      refresh: true,
    }, { signal })).resolves.toMatchObject({
      usage: [{ automaticReset: {
        policy: { state: "active" },
        refresh: { state: "not_eligible", reason: "below_threshold" },
      } }],
    });
    expect(codex.resetIdempotencyKeys).toEqual([]);
    expect(store.requireAccountRateLimitResetPolicy(legacy.id)).toMatchObject({
      state: "active_bound",
      weeklyWindowResetsAt: laterWindow,
    });

    codex.usageResult = {
      revision: 5,
      observedAt: 6_000,
      payload: payload(99, 1, laterWindow / 1_000),
    };
    await service.execute({
      kind: "account.usage",
      account: legacy.id,
      refresh: true,
    }, { signal });
    expect(codex.resetIdempotencyKeys).toHaveLength(1);
    expect(JSON.stringify(store.requireAccountRateLimitResetPolicy(legacy.id)))
      .not.toContain(legacyEmail);
  });
test("migrates a signed-in v24 profile and suppresses its first valid window across restart and notification", async () => {
    const now = canonical24ResetFixture.now;
    const firstWindow = now + 3 * 24 * 60 * 60 * 1_000;
    const home = await realpath(await mkdtemp(join(tmpdir(), "hra-service-v24-reset-")));
    serviceRoots.push(home);
    const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
    await initializeStatePaths(paths);
    await writeFile(paths.database, canonical24ResetDatabaseBytes(), { mode: 0o600 });
    const accountId = canonical24ResetFixture.profile.id;
    const store = new StateStore(paths, { now: () => now });
    stores.push(store);
    expect(store.requireProfileById(accountId)).toMatchObject(canonical24ResetFixture.profile);
    expect(store.requireAccountRateLimitResetPolicy(accountId)).toMatchObject({
      state: "reconciliation_required",
      accountFingerprint: null,
      weeklyWindowResetsAt: null,
    });
    const inspector = new Database(paths.database, { readonly: true, strict: true });
    try {
      expect(inspector.query("PRAGMA user_version").get()).toEqual({ user_version: 61 });
      expect(inspector.query(
        "SELECT id,label,state,process_generation,provider_email,provider_plan,created_at,updated_at,label_key FROM profiles WHERE id=?",
      ).get(accountId)).toEqual(canonical24ResetFixture.profileRow);
      expect(inspector.query(
        "SELECT version,applied_at FROM migrations WHERE version<=24 ORDER BY version",
      ).all()).toEqual([...canonical24ResetFixture.migrations]);
      expect(inspector.query(
        "SELECT version FROM migrations WHERE version>=25 ORDER BY version",
      ).all()).toEqual(Array.from({ length: 37 }, (_, index) => ({ version: index + 25 })));
    } finally {
      inspector.close(false);
    }

    const daemonBootId = `boot_${"3".repeat(32)}`;
    const daemonGeneration = store.nextDaemonGeneration(daemonBootId);
    const codex = new FakeCodex();
    const migrated = new OompaService({
      store,
      paths,
      codex,
      daemonGeneration,
      daemonBootId,
      cloud: new FakeCloud(),
      daemonAuthority: new FakeDaemonAuthority(),
      now: () => now,
      requestStop: () => undefined,
    });
    codex.usageResult = {
      revision: 1,
      observedAt: 2_000,
      payload: { rateLimits: { temporarilyUnavailable: true } },
    };
    await expect(migrated.execute({
      kind: "account.usage",
      account: accountId,
      refresh: true,
    }, { signal })).resolves.toMatchObject({
      usage: [{ automaticReset: {
        policy: { state: "reconciliation_required" },
        refresh: { state: "suppressed", reason: "reconciliation_required" },
      } }],
    });

    const eligiblePayload = {
      rateLimits: {
        primary: {
          limitId: "codex",
          primary: {
            usedPercent: 99,
            windowDurationMins: 10_080,
            resetsAt: firstWindow / 1_000,
          },
          secondary: null,
        },
        byLimitId: null,
        resetCreditsAvailable: 1,
      },
    };
    codex.usageResult = { revision: 2, observedAt: 3_000, payload: eligiblePayload };
    await expect(migrated.execute({
      kind: "account.usage",
      account: accountId,
      refresh: true,
    }, { signal })).resolves.toMatchObject({
      usage: [{ automaticReset: {
        policy: { state: "window_suppressed" },
        refresh: { state: "suppressed", reason: "reconciliation_window" },
      } }],
    });
    expect(codex.resetIdempotencyKeys).toEqual([]);

    await migrated.close();
    const restartedDaemonBootId = `boot_${"4".repeat(32)}`;
    const restartedDaemonGeneration = store.nextDaemonGeneration(restartedDaemonBootId);
    const restartedCodex = new FakeCodex();
    restartedCodex.usageResult = {
      revision: 3,
      observedAt: 4_000,
      payload: eligiblePayload,
    };
    const restarted = new OompaService({
      store,
      paths,
      codex: restartedCodex,
      daemonGeneration: restartedDaemonGeneration,
      daemonBootId: restartedDaemonBootId,
      cloud: new FakeCloud(),
      daemonAuthority: new FakeDaemonAuthority(),
      now: () => now,
      requestStop: () => undefined,
    });
    await restarted.recover();
    const profile = store.requireProfileById(accountId);
    const owned = profilePaths(paths, profile.id);
    await restarted.observeCodexFact(
      liveAuthorityFor(store, profile.id, "codex", owned),
      { type: "rateLimitsUpdated" },
    );
    await restarted.settled();
    expect(restartedCodex.calls).toEqual(["readAccount", "usage", "readAccount"]);
    expect(restartedCodex.resetIdempotencyKeys).toEqual([]);
    expect(store.requireAccountRateLimitResetPolicy(profile.id)).toMatchObject({
      state: "window_suppressed",
      weeklyWindowResetsAt: firstWindow,
    });
    await restarted.close();
  });
test("fails before reset-attempt inspection when policy storage is unavailable", async () => {
    const { service, codex, store } = await fixture();
    const added = await service.execute({
      kind: "account.add",
      label: "Reset policy failure",
    }, { signal }) as { account: { id: `acct_${string}` } };
    await service.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: false,
    }, { signal });
    codex.usageResult = {
      revision: 1,
      observedAt: 2_000,
      payload: {
        rateLimits: {
          primary: {
            limitId: "codex",
            primary: {
              usedPercent: 99,
              windowDurationMins: 10_080,
              resetsAt: automaticResetWindowResetsAtSeconds,
            },
            secondary: null,
          },
          byLimitId: null,
          resetCreditsAvailable: 1,
        },
      },
    };
    Object.defineProperty(store, "authorizeAccountRateLimitResetPolicy", {
      configurable: true,
      value: () => { throw new Error("injected reset policy failure"); },
    });
    await expect(service.execute({
      kind: "account.usage",
      account: added.account.id,
      refresh: true,
    }, { signal })).rejects.toThrow("injected reset policy failure");
    expect(codex.resetIdempotencyKeys).toEqual([]);
  });
test("persists a background reset result for later passive usage status", async () => {
    const { service, codex, store, paths } = await fixture();
    const added = await service.execute({
      kind: "account.add",
      label: "Background reset",
    }, { signal }) as { account: { id: `acct_${string}` } };
    await service.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: false,
    }, { signal });
    const limits = (usedPercent: number, credits: number) => ({
      rateLimits: {
        primary: {
          limitId: "codex",
          primary: null,
          secondary: {
            usedPercent,
            windowDurationMins: 10_080,
            resetsAt: automaticResetWindowResetsAtSeconds,
          },
        },
        byLimitId: null,
        resetCreditsAvailable: credits,
      },
    });
    const afterReset = { revision: 2, observedAt: 2_001, payload: limits(0, 0) };
    codex.usageResult = afterReset;
    codex.usageResults.push(
      { revision: 1, observedAt: 2_000, payload: limits(99, 1) },
      afterReset,
    );
    const profile = store.requireProfileById(added.account.id);
    const owned = profilePaths(paths, profile.id);
    await service.observeCodexFact(
      liveAuthorityFor(store, profile.id, "codex", owned),
      { type: "rateLimitsUpdated" },
    );
    await service.settled();

    const passive = await service.execute({
      kind: "account.usage",
      account: profile.id,
      refresh: false,
    }, { signal }) as { usage: Array<{ automaticReset: Record<string, unknown> }> };
    expect(codex.calls.slice(-8)).toEqual([
      "readAccount",
      "usage",
      "readAccount",
      "readAccount",
      "reset",
      "readAccount",
      "usage",
      "readAccount",
    ]);
    expect(passive).toMatchObject({
      usage: [{
        automaticReset: {
          lastAttempt: {
            state: "settled",
            outcome: "reset",
            weeklyWindowResetsAt: automaticResetWindowResetsAt,
          },
        },
      }],
    });
    expect(passive.usage[0]?.automaticReset).not.toHaveProperty("refresh");
    const automaticReset = JSON.stringify(passive.usage[0]?.automaticReset);
    expect(automaticReset).not.toContain(codex.resetIdempotencyKeys[0] as string);
    expect(automaticReset).not.toContain(
      createHash("sha256").update("person@example.com").digest("hex"),
    );
  });
test("settles known reset no-ops without degrading successful usage polling", async () => {
    for (const outcome of ["nothingToReset", "noCredit"] as const) {
      const { service, codex } = await fixture();
      const added = await service.execute({
        kind: "account.add",
        label: `Reset ${outcome}`,
      }, { signal }) as { account: { id: string } };
      await service.execute({
        kind: "account.login",
        account: added.account.id,
        deviceCode: false,
      }, { signal });
      const payload = {
        usage: { summary: { lifetimeTokens: 10 } },
        rateLimits: {
          primary: {
            limitId: "codex",
            primary: null,
            secondary: {
              usedPercent: 99,
              windowDurationMins: 10_080,
              resetsAt: automaticResetWindowResetsAtSeconds,
            },
          },
          byLimitId: null,
          resetCreditsAvailable: 1,
        },
      };
      codex.usageResult = { revision: 1, observedAt: 2_000, payload };
      codex.resetOutcome = outcome;
      const first = await service.execute({
        kind: "account.usage",
        account: added.account.id,
        refresh: true,
      }, { signal });
      expect(first).toMatchObject({
        usage: [{
          automaticReset: { refresh: { state: "settled", outcome } },
          poll: { state: "observed" },
        }],
      });
      expect(codex.resetIdempotencyKeys).toHaveLength(1);
      await service.execute({
        kind: "account.usage",
        account: added.account.id,
        refresh: true,
      }, { signal });
      expect(codex.resetIdempotencyKeys).toHaveLength(outcome === "noCredit" ? 2 : 1);
      await service.execute({
        kind: "account.usage",
        account: added.account.id,
        refresh: true,
      }, { signal });
      expect(codex.resetIdempotencyKeys).toHaveLength(outcome === "noCredit" ? 2 : 1);
    }
  });
test("reconciles an indeterminate reset with its exact persisted key", async () => {
    const { service, codex, store } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Reset retry" }, { signal }) as { account: { id: `acct_${string}` } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    const payload = {
      usage: { summary: { lifetimeTokens: 10 } },
      rateLimits: {
        primary: {
          limitId: "codex",
          primary: null,
          secondary: {
            usedPercent: 99,
            windowDurationMins: 10_080,
            resetsAt: automaticResetWindowResetsAtSeconds,
          },
        },
        byLimitId: null,
        resetCreditsAvailable: 1,
      },
    };
    codex.usageResult = { revision: 1, observedAt: 2_000, payload };
    codex.resetError = new IndeterminateCodexEffectError(
      "account/rateLimitResetCredit/consume",
      99,
    );
    const indeterminate = await service.execute({
      kind: "account.usage",
      account: added.account.id,
      refresh: true,
    }, { signal });
    expect(indeterminate).toMatchObject({
      usage: [{ automaticReset: {
        lastAttempt: {
          state: "recovery_pending",
          weeklyWindowResetsAt: automaticResetWindowResetsAt,
        },
        refresh: { state: "recovery_pending" },
      } }],
    });
    const key = codex.resetIdempotencyKeys[0];
    if (key === undefined) throw new Error("Expected a persisted reset idempotency key.");
    expect(typeof key).toBe("string");
    expect(store.readRecoverableAccountRateLimitReset(
      added.account.id,
      createHash("sha256").update("person@example.com").digest("hex"),
    )).toMatchObject({ idempotencyKey: key, state: "ambiguous" });
    await expect(service.execute({
      kind: "account.usage",
      account: added.account.id,
      refresh: false,
    }, { signal })).resolves.toMatchObject({
      usage: [{ automaticReset: { lastAttempt: {
        state: "recovery_pending",
        weeklyWindowResetsAt: automaticResetWindowResetsAt,
      } } }],
    });

    codex.resetError = undefined;
    codex.resetOutcome = "alreadyRedeemed";
    await service.execute({
      kind: "account.usage",
      account: added.account.id,
      refresh: true,
    }, { signal });
    expect(codex.resetIdempotencyKeys).toEqual([key, key]);
    expect(store.latestAccountRateLimitResetAttempt(
      added.account.id,
      createHash("sha256").update("person@example.com").digest("hex"),
    )).toMatchObject({ idempotencyKey: key, state: "settled", outcome: "alreadyRedeemed" });
  });
test("preserves an ambiguous reset key while its live weekly bucket is unavailable", async () => {
    const { service, codex, store } = await fixture();
    const added = await service.execute({
      kind: "account.add",
      label: "Reset missing bucket",
    }, { signal }) as { account: { id: `acct_${string}` } };
    await service.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: false,
    }, { signal });
    const eligiblePayload = {
      rateLimits: {
        primary: {
          limitId: "codex",
          primary: {
            usedPercent: 99,
            windowDurationMins: 10_080,
            resetsAt: automaticResetWindowResetsAtSeconds,
          },
          secondary: null,
        },
        byLimitId: null,
        resetCreditsAvailable: 1,
      },
    };
    codex.usageResult = { revision: 1, observedAt: 2_000, payload: eligiblePayload };
    codex.resetError = new IndeterminateCodexEffectError(
      "account/rateLimitResetCredit/consume",
      99,
    );
    await service.execute({
      kind: "account.usage",
      account: added.account.id,
      refresh: true,
    }, { signal });
    const key = codex.resetIdempotencyKeys[0];
    if (key === undefined) throw new Error("Expected an ambiguous reset key.");

    codex.resetError = undefined;
    codex.usageResult = {
      revision: 2,
      observedAt: 3_000,
      payload: { rateLimits: { temporarilyUnavailable: true } },
    };
    await expect(service.execute({
      kind: "account.usage",
      account: added.account.id,
      refresh: true,
    }, { signal })).resolves.toMatchObject({
      usage: [{ automaticReset: { refresh: {
        state: "suppressed",
        reason: "weekly_window_unavailable",
      } } }],
    });
    const fingerprint = createHash("sha256").update("person@example.com").digest("hex");
    expect(store.readRecoverableAccountRateLimitReset(added.account.id, fingerprint))
      .toMatchObject({ idempotencyKey: key, state: "ambiguous" });
    expect(codex.resetIdempotencyKeys).toEqual([key]);

    codex.usageResult = { revision: 3, observedAt: 4_000, payload: eligiblePayload };
    codex.resetOutcome = "alreadyRedeemed";
    await service.execute({
      kind: "account.usage",
      account: added.account.id,
      refresh: true,
    }, { signal });
    expect(codex.resetIdempotencyKeys).toEqual([key, key]);
    expect(store.latestAccountRateLimitResetAttempt(added.account.id, fingerprint))
      .toMatchObject({ idempotencyKey: key, state: "settled", outcome: "alreadyRedeemed" });
  });
test("never redispatches a terminal reset latch returned by preparation", async () => {
    const settled = await fixture();
    const settledAccount = await settled.service.execute({
      kind: "account.add",
      label: "Settled reset latch",
    }, { signal }) as { account: { id: `acct_${string}` } };
    await settled.service.execute({
      kind: "account.login",
      account: settledAccount.account.id,
      deviceCode: false,
    }, { signal });
    const eligiblePayload = {
      rateLimits: {
        primary: {
          limitId: "codex",
          primary: {
            usedPercent: 99,
            windowDurationMins: 10_080,
            resetsAt: automaticResetWindowResetsAtSeconds,
          },
          secondary: null,
        },
        byLimitId: null,
        resetCreditsAvailable: 1,
      },
    };
    settled.codex.usageResult = {
      revision: 1,
      observedAt: 2_000,
      payload: eligiblePayload,
    };
    await settled.service.execute({
      kind: "account.usage",
      account: settledAccount.account.id,
      refresh: true,
    }, { signal });
    await expect(settled.service.execute({
      kind: "account.usage",
      account: settledAccount.account.id,
      refresh: true,
    }, { signal })).resolves.toMatchObject({
      usage: [{ automaticReset: {
        refresh: { state: "latched", outcome: "reset" },
      } }],
    });
    expect(settled.codex.resetIdempotencyKeys).toHaveLength(1);

    const closed = await fixture();
    const closedAccount = await closed.service.execute({
      kind: "account.add",
      label: "Closed reset latch",
    }, { signal }) as { account: { id: `acct_${string}` } };
    await closed.service.execute({
      kind: "account.login",
      account: closedAccount.account.id,
      deviceCode: false,
    }, { signal });
    const profile = closed.store.requireProfileById(closedAccount.account.id);
    const fingerprint = createHash("sha256").update("person@example.com").digest("hex");
    expect(closed.store.authorizeAccountRateLimitResetPolicy({
      profileId: profile.id,
      processGeneration: profile.processGeneration,
      accountFingerprint: fingerprint,
      weeklyWindowDurationMinutes: 10_080,
      weeklyWindowResetsAt: automaticResetWindowResetsAt,
    }).decision).toBe("allow");
    const prepared = closed.store.prepareAccountRateLimitReset({
      profileId: profile.id,
      processGeneration: profile.processGeneration,
      accountFingerprint: fingerprint,
      weeklyWindowResetsAt: automaticResetWindowResetsAt,
      observedUsedPercent: 99,
    });
    closed.store.closeAccountRateLimitReset(
      prepared.idempotencyKey,
      "weekly_window_changed",
    );
    closed.codex.usageResult = {
      revision: 1,
      observedAt: 2_000,
      payload: eligiblePayload,
    };
    await expect(closed.service.execute({
      kind: "account.usage",
      account: closedAccount.account.id,
      refresh: true,
    }, { signal })).resolves.toMatchObject({
      usage: [{ automaticReset: {
        refresh: { state: "latched", reason: "weekly_window_changed" },
      } }],
    });
    expect(closed.codex.resetIdempotencyKeys).toEqual([]);
  });
test("rechecks eligibility after a determinate reset rejection", async () => {
    const { service, codex, store } = await fixture();
    const added = await service.execute({
      kind: "account.add",
      label: "Reset rejection",
    }, { signal }) as { account: { id: `acct_${string}` } };
    await service.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: false,
    }, { signal });
    const payload = (usedPercent: number) => ({
      rateLimits: {
        primary: {
          limitId: "codex",
          primary: {
            usedPercent,
            windowDurationMins: 10_080,
            resetsAt: automaticResetWindowResetsAtSeconds,
          },
          secondary: null,
        },
        byLimitId: null,
        resetCreditsAvailable: 1,
      },
    });
    codex.usageResult = { revision: 1, observedAt: 2_000, payload: payload(99) };
    codex.resetError = new CodexRemoteError(-32_000, "request failed");
    await expect(service.execute({
      kind: "account.usage",
      account: added.account.id,
      refresh: true,
    }, { signal })).resolves.toMatchObject({
      usage: [{ automaticReset: { refresh: { state: "retry_pending" } } }],
    });
    const key = codex.resetIdempotencyKeys[0];
    if (key === undefined) throw new Error("Expected a retryable reset key.");
    const fingerprint = createHash("sha256").update("person@example.com").digest("hex");
    expect(store.readRecoverableAccountRateLimitReset(added.account.id, fingerprint))
      .toMatchObject({ idempotencyKey: key, state: "retryable" });
    await expect(service.execute({
      kind: "account.usage",
      account: added.account.id,
      refresh: false,
    }, { signal })).resolves.toMatchObject({
      usage: [{ automaticReset: { lastAttempt: {
        state: "retry_pending",
        weeklyWindowResetsAt: automaticResetWindowResetsAt,
      } } }],
    });

    codex.resetError = undefined;
    codex.usageResult = { revision: 2, observedAt: 3_000, payload: payload(98) };
    await expect(service.execute({
      kind: "account.usage",
      account: added.account.id,
      refresh: true,
    }, { signal })).resolves.toMatchObject({
      usage: [{
        automaticReset: {
          refresh: { state: "waiting", reason: "below_threshold" },
        },
      }],
    });
    expect(codex.resetIdempotencyKeys).toEqual([key]);

    codex.usageResult = { revision: 3, observedAt: 4_000, payload: payload(99) };
    await service.execute({
      kind: "account.usage",
      account: added.account.id,
      refresh: true,
    }, { signal });
    expect(codex.resetIdempotencyKeys).toEqual([key, key]);
  });
test("reconciles an ambiguous reset with its original key in a later active window", async () => {
    let now = 2_000_000_000;
    const originalWindow = now + 3 * 24 * 60 * 60 * 1_000;
    const laterWindow = originalWindow + 3 * 24 * 60 * 60 * 1_000;
    const { service, codex, store } = await fixture(new FakeCloud(),
      () => undefined,
      () => now,
    );
    const added = await service.execute({
      kind: "account.add",
      label: "Reset window",
    }, { signal }) as { account: { id: `acct_${string}` } };
    await service.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: false,
    }, { signal });
    const payload = (resetsAt: number, usedPercent: number, credits: number) => ({
      rateLimits: {
        primary: {
          limitId: "codex",
          primary: {
            usedPercent,
            windowDurationMins: 10_080,
            resetsAt,
          },
          secondary: null,
        },
        byLimitId: null,
        resetCreditsAvailable: credits,
      },
    });
    codex.usageResult = {
      revision: 1,
      observedAt: 2_000,
      payload: payload(originalWindow / 1_000, 99, 1),
    };
    codex.resetError = new IndeterminateCodexEffectError(
      "account/rateLimitResetCredit/consume",
      99,
    );
    await service.execute({
      kind: "account.usage",
      account: added.account.id,
      refresh: true,
    }, { signal });
    const key = codex.resetIdempotencyKeys[0];
    if (key === undefined) throw new Error("Expected an ambiguous reset key.");
    codex.resetError = undefined;
    codex.resetOutcome = "alreadyRedeemed";
    now = originalWindow;
    codex.usageResult = {
      revision: 2,
      observedAt: 3_000,
      payload: payload(laterWindow / 1_000, 0, 0),
    };
    await expect(service.execute({
      kind: "account.usage",
      account: added.account.id,
      refresh: true,
    }, { signal })).resolves.toMatchObject({
      usage: [{ automaticReset: {
        policy: { state: "active" },
        refresh: { state: "settled", outcome: "alreadyRedeemed" },
      } }],
    });
    expect(codex.resetIdempotencyKeys).toEqual([key, key]);
    expect(store.requireAccountRateLimitResetPolicy(added.account.id)).toMatchObject({
      state: "active_bound",
      weeklyWindowResetsAt: laterWindow,
    });
    expect(store.requireProfileById(added.account.id).state).toBe("signed_in");
    expect(store.latestAccountRateLimitResetAttempt(
      added.account.id,
      createHash("sha256").update("person@example.com").digest("hex"),
    )).toMatchObject({ idempotencyKey: key, state: "settled", outcome: "alreadyRedeemed" });
  });
test("rebinds and reconciles an ambiguous reset across an app-server generation", async () => {
    const value = await fixture();
    const added = await value.service.execute({
      kind: "account.add",
      label: "Reset restart",
    }, { signal }) as { account: { id: `acct_${string}` } };
    await value.service.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: false,
    }, { signal });
    const payload = {
      usage: { summary: { lifetimeTokens: 10 } },
      rateLimits: {
        primary: {
          limitId: "codex",
          primary: null,
          secondary: {
            usedPercent: 99,
            windowDurationMins: 10_080,
            resetsAt: automaticResetWindowResetsAtSeconds,
          },
        },
        byLimitId: null,
        resetCreditsAvailable: 1,
      },
    };
    value.codex.usageResult = { revision: 1, observedAt: 2_000, payload };
    value.codex.resetError = new IndeterminateCodexEffectError(
      "account/rateLimitResetCredit/consume",
      99,
    );
    await value.service.execute({
      kind: "account.usage",
      account: added.account.id,
      refresh: true,
    }, { signal });
    const key = value.codex.resetIdempotencyKeys[0];
    if (key === undefined) throw new Error("Expected an ambiguous reset key.");
    const originalGeneration = value.store.requireProfileById(added.account.id)
      .processGeneration;
    await value.service.close();
    const replacementGeneration = value.store.requireProfileById(added.account.id)
      .processGeneration;
    expect(replacementGeneration).toBe(originalGeneration + 1);

    const replacementCodex = new FakeCodex();
    replacementCodex.usageResult = { revision: 2, observedAt: 3_000, payload };
    replacementCodex.resetOutcome = "alreadyRedeemed";
    const replacement = new OompaService({
      store: value.store,
      paths: value.paths,
      codex: replacementCodex,
      cloud: new FakeCloud(),
      daemonAuthority: new FakeDaemonAuthority(),
      daemonGeneration: 2,
      requestStop: () => undefined,
    });
    await replacement.recover();
    await replacement.execute({
      kind: "account.usage",
      account: added.account.id,
      refresh: true,
    }, { signal });
    expect(replacementCodex.resetIdempotencyKeys).toEqual([key]);
    expect(value.store.listAccountRateLimitResetRebinds(key)).toEqual([
      expect.objectContaining({
        idempotencyKey: key,
        fromProcessGeneration: originalGeneration,
        toProcessGeneration: replacementGeneration,
      }),
    ]);
    expect(value.store.latestAccountRateLimitResetAttempt(
      added.account.id,
      createHash("sha256").update("person@example.com").digest("hex"),
    )).toMatchObject({ idempotencyKey: key, state: "settled", outcome: "alreadyRedeemed" });
    await replacement.close();
  });
test("keeps a prepared reset dormant until the same weekly window is eligible again", async () => {
    const { service, codex, store } = await fixture();
    const added = await service.execute({
      kind: "account.add",
      label: "Reset threshold recheck",
    }, { signal }) as { account: { id: `acct_${string}` } };
    await service.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: false,
    }, { signal });
    const profile = store.requireProfileById(added.account.id);
    const fingerprint = createHash("sha256").update("person@example.com").digest("hex");
    const resetAt = automaticResetWindowResetsAt;
    expect(store.authorizeAccountRateLimitResetPolicy({
      profileId: profile.id,
      processGeneration: profile.processGeneration,
      accountFingerprint: fingerprint,
      weeklyWindowDurationMinutes: 10_080,
      weeklyWindowResetsAt: resetAt,
    }).decision).toBe("allow");
    const prepared = store.prepareAccountRateLimitReset({
      profileId: profile.id,
      processGeneration: profile.processGeneration,
      accountFingerprint: fingerprint,
      weeklyWindowResetsAt: resetAt,
      observedUsedPercent: 99,
    });
    codex.usageResult = {
      revision: 1,
      observedAt: 2_000,
      payload: {
        rateLimits: {
          primary: {
            limitId: "codex",
            primary: {
              usedPercent: 98,
              windowDurationMins: 10_080,
              resetsAt: resetAt / 1_000,
            },
            secondary: null,
          },
          byLimitId: null,
          resetCreditsAvailable: 1,
        },
      },
    };
    await service.execute({
      kind: "account.usage",
      account: profile.id,
      refresh: true,
    }, { signal });
    expect(codex.resetIdempotencyKeys).toEqual([]);
    expect(store.readRecoverableAccountRateLimitReset(profile.id, fingerprint))
      .toMatchObject({ idempotencyKey: prepared.idempotencyKey, state: "prepared" });
  });
test("keeps ambiguous recovery inert while a replacement identity reconciles", async () => {
    const { service, codex, store } = await fixture();
    const added = await service.execute({
      kind: "account.add",
      label: "Reset identity",
    }, { signal }) as { account: { id: `acct_${string}` } };
    await service.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: false,
    }, { signal });
    const payload = {
      rateLimits: {
        primary: {
          limitId: "codex",
          primary: {
            usedPercent: 99,
            windowDurationMins: 10_080,
            resetsAt: automaticResetWindowResetsAtSeconds,
          },
          secondary: null,
        },
        byLimitId: null,
        resetCreditsAvailable: 1,
      },
    };
    codex.usageResult = { revision: 1, observedAt: 2_000, payload };
    codex.resetError = new IndeterminateCodexEffectError(
      "account/rateLimitResetCredit/consume",
      99,
    );
    await service.execute({
      kind: "account.usage",
      account: added.account.id,
      refresh: true,
    }, { signal });
    codex.resetError = undefined;
    codex.accountProjection = {
      signedIn: true,
      email: "someone-else@example.com",
      plan: "Plus",
    };
    await expect(service.execute({
      kind: "account.usage",
      account: added.account.id,
      refresh: true,
    }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    await service.settled();
    expect(codex.resetIdempotencyKeys).toHaveLength(1);
    expect(store.requireProfileById(added.account.id)).toMatchObject({
      processGeneration: 2,
      state: "signed_out",
    });
    expect(store.requireAccountRateLimitResetPolicy(added.account.id)).toMatchObject({
      state: "reconciliation_required",
      accountFingerprint: null,
      weeklyWindowResetsAt: null,
    });
    expect(store.latestAccountRateLimitResetAttempt(
      added.account.id,
      createHash("sha256").update("person@example.com").digest("hex"),
    )).toMatchObject({ state: "closed", localResolution: "account_identity_changed" });
    await expect(service.execute({
      kind: "account.usage",
      account: added.account.id,
      refresh: false,
    }, { signal })).resolves.toMatchObject({
      usage: [{
        account: { processGeneration: 2, state: "signed_out" },
        automaticReset: {
          lastAttempt: null,
          observation: {
            state: "unavailable",
            reason: "weekly_window_unavailable",
          },
        },
        snapshot: null,
      }],
    });

    codex.loginResult = {
      status: "signed_in",
      account: {
        signedIn: true,
        email: "someone-else@example.com",
        plan: "Plus",
      },
    };
    await service.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: false,
    }, { signal });
    await expect(service.execute({
      kind: "account.usage",
      account: added.account.id,
      refresh: true,
    }, { signal })).resolves.toMatchObject({
      usage: [{ automaticReset: {
        policy: { state: "window_suppressed" },
        refresh: { state: "suppressed", reason: "reconciliation_window" },
      } }],
    });
    expect(codex.resetIdempotencyKeys).toHaveLength(1);
    expect(store.requireAccountRateLimitResetPolicy(added.account.id)).toMatchObject({
      state: "window_suppressed",
      accountFingerprint: createHash("sha256")
        .update("someone-else@example.com").digest("hex"),
      weeklyWindowResetsAt: automaticResetWindowResetsAt,
    });
  });
test("account show clears a reset-era recovery quarantine without a generic mutation", async () => {
    const { service, codex, store } = await fixture();
    const added = await service.execute({
      kind: "account.add",
      label: "Reset recovery",
    }, { signal }) as { account: { id: `acct_${string}` } };
    await service.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: false,
    }, { signal });
    const profile = store.requireProfileById(added.account.id);
    expect(store.setProfileState(
      profile.id,
      profile.processGeneration,
      "recovery_required",
      {
        ...(profile.providerEmail === undefined ? {} : { email: profile.providerEmail }),
        ...(profile.providerPlan === undefined ? {} : { plan: profile.providerPlan }),
      },
    )).toBe(true);
    codex.accountProjection = {
      signedIn: true,
      email: "person@example.com",
      plan: "Plus",
    };
    await expect(service.execute({
      kind: "account.show",
      account: added.account.id,
    }, { signal })).resolves.toMatchObject({
      account: { state: "signed_in" },
      recovery: {
        cleared: true,
        required: false,
        resolution: "provider_state_reconciled",
      },
    });
  });
test("synchronously fences provider authority when reset journaling fails", async () => {
    for (const boundary of ["defer", "settle"] as const) {
      let stopCalls = 0;
      const value = await fixture(new FakeCloud(),
        () => { stopCalls += 1; },
      );
      const added = await value.service.execute({
        kind: "account.add",
        label: `Reset journal ${boundary}`,
      }, { signal }) as { account: { id: `acct_${string}` } };
      await value.service.execute({
        kind: "account.login",
        account: added.account.id,
        deviceCode: false,
      }, { signal });
      value.codex.usageResult = {
        revision: 1,
        observedAt: 2_000,
        payload: {
          rateLimits: {
            primary: {
              limitId: "codex",
              primary: {
                usedPercent: 99,
                windowDurationMins: 10_080,
                resetsAt: automaticResetWindowResetsAtSeconds,
              },
              secondary: null,
            },
            byLimitId: null,
            resetCreditsAvailable: 1,
          },
        },
      };
      if (boundary === "defer") {
        value.codex.resetError = new IndeterminateCodexEffectError(
          "account/rateLimitResetCredit/consume",
          99,
        );
        Object.defineProperty(value.store, "deferAccountRateLimitReset", {
          configurable: true,
          value: () => { throw new Error("injected reset defer failure"); },
        });
      } else {
        Object.defineProperty(value.store, "settleAccountRateLimitReset", {
          configurable: true,
          value: () => { throw new Error("injected reset settlement failure"); },
        });
      }
      await expect(value.service.execute({
        kind: "account.usage",
        account: added.account.id,
        refresh: true,
      }, { signal })).rejects.toBeInstanceOf(AggregateError);
      expect(value.daemonAuthority.current).toBe(false);
      expect(value.daemonAuthority.closeCalls).toBe(1);
      const callsAtFence = value.codex.calls.length;
      await expect(value.service.execute({
        kind: "account.logout",
        account: added.account.id,
      }, { signal })).rejects.toMatchObject({ code: "UNAVAILABLE" });
      expect(value.codex.calls).toHaveLength(callsAtFence);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(stopCalls).toBe(1);
    }
  });
test("commits a returned reset outcome even when shutdown closes daemon authority", async () => {
    const value = await fixture();
    const added = await value.service.execute({
      kind: "account.add",
      label: "Reset shutdown",
    }, { signal }) as { account: { id: `acct_${string}` } };
    await value.service.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: false,
    }, { signal });
    value.codex.usageResult = {
      revision: 1,
      observedAt: 2_000,
      payload: {
        rateLimits: {
          primary: {
            limitId: "codex",
            primary: {
              usedPercent: 99,
              windowDurationMins: 10_080,
              resetsAt: automaticResetWindowResetsAtSeconds,
            },
            secondary: null,
          },
          byLimitId: null,
          resetCreditsAvailable: 1,
        },
      },
    };
    let signalReset!: () => void;
    const resetStarted = new Promise<void>((resolve) => { signalReset = resolve; });
    let releaseReset!: () => void;
    const resetGate = new Promise<void>((resolve) => { releaseReset = resolve; });
    value.codex.beforeResetReturn = async () => {
      signalReset();
      await resetGate;
    };
    const refresh = value.service.execute({
      kind: "account.usage",
      account: added.account.id,
      refresh: true,
    }, { signal });
    await resetStarted;
    const closing = value.service.close();
    releaseReset();
    await expect(refresh).rejects.toBeInstanceOf(DaemonAuthoritySafetyError);
    await closing;
    const fingerprint = createHash("sha256").update("person@example.com").digest("hex");
    expect(value.store.readRecoverableAccountRateLimitReset(
      added.account.id,
      fingerprint,
    )).toBeNull();
  });
test("coalesces rate-limit notifications into authoritative serialized reads", async () => {
    const { service, codex, store, paths } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Reset wake" }, { signal }) as { account: { id: `acct_${string}` } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    const profile = store.requireProfileById(added.account.id);
    const owned = profilePaths(paths, profile.id);
    const authority = liveAuthorityFor(store, profile.id, "codex", owned);
    codex.usageResult = {
      revision: 1,
      observedAt: 2_000,
      payload: {
        usage: { summary: { lifetimeTokens: 10 } },
        rateLimits: {
          primary: {
            limitId: "codex",
            primary: null,
            secondary: {
              usedPercent: 98,
              windowDurationMins: 10_080,
              resetsAt: automaticResetWindowResetsAtSeconds,
            },
          },
          byLimitId: null,
          resetCreditsAvailable: 1,
        },
      },
    };
    let reads = 0;
    let signalFirst!: () => void;
    const firstStarted = new Promise<void>((resolve) => { signalFirst = resolve; });
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let signalTrailing!: () => void;
    const trailingStarted = new Promise<void>((resolve) => { signalTrailing = resolve; });
    codex.beforeReadUsageReturn = async () => {
      reads += 1;
      if (reads === 1) {
        signalFirst();
        await firstGate;
      } else if (reads === 2) {
        signalTrailing();
      }
    };

    await service.observeCodexFact(authority, { type: "rateLimitsUpdated" });
    await firstStarted;
    await service.observeCodexFact(authority, { type: "rateLimitsUpdated" });
    releaseFirst();
    await trailingStarted;
    await service.execute({
      kind: "account.usage",
      account: profile.id,
      refresh: false,
    }, { signal });
    expect(reads).toBe(2);
    expect(codex.resetIdempotencyKeys).toEqual([]);
  });
test("allocates durable usage authority and returns an observed trailing velocity", async () => {
    const { service, codex, store } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Velocity" }, { signal }) as { account: { id: `acct_${string}` } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    const through = Date.now();
    const payload = (lifetimeTokens: number) => ({
      usage: { summary: { lifetimeTokens } },
      rateLimits: { primary: null, byLimitId: null },
    });
    codex.usageResult = { revision: 99, observedAt: through - 60_000, payload: payload(100) };
    await service.execute({ kind: "account.usage", account: added.account.id, refresh: true }, { signal });
    codex.usageResult = { revision: 99, observedAt: through, payload: payload(220) };
    const response = await service.execute({ kind: "account.usage", account: added.account.id, refresh: true }, { signal });
    const ledger = store.usageRange({ profileId: added.account.id });
    expect(ledger.map((entry) => entry.sourceRevision)).toEqual([1, 2]);
    expect(storedAccountUsageSnapshotSchema.parse(ledger[1]?.payload).observation)
      .toMatchObject({ sourceSequence: 2, lifetimeTokens: 220, gapBefore: false });
    expect(response).toMatchObject({
      usage: [{
        snapshot: { sourceRevision: 2, payload: payload(220) },
        velocity: {
          "1m": {
            available: true,
            counterDelta: 120,
            elapsedMs: 60_000,
            tokensPerMinute: 120,
          },
        },
      }],
    });
  });
test("pages a safe source-ordered 24-hour account usage history", async () => {
    let now = 1_700_000_000_000;
    const value = await fixture(new FakeCloud(), () => undefined, () => now);
    const added = await value.service.execute(
      { kind: "account.add", label: "Usage history" },
      { signal },
    ) as { account: { id: `acct_${string}` } };
    await value.service.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: false,
    }, { signal });
    const providerAuthority = value.store.requireProviderAccountAuthority(
      added.account.id,
      "codex",
    );
    const accountFingerprint = createHash("sha256")
      .update("person@example.com")
      .digest("hex");
    const sentinel = "PRIVATE_PROVIDER_PAYLOAD_SENTINEL";
    const first = createStoredAccountUsageSnapshot({
      providerPayload: {
        privateProviderPayload: sentinel,
        usage: { summary: { lifetimeTokens: 100 } },
      },
      sourceSequence: 1,
      observedAt: now - 180_000,
      receivedAt: now - 179_000,
      accountFingerprint,
      providerGeneration: providerAuthority.processGeneration,
      daemonGeneration: 1,
      previousPayload: null,
    });
    const third = createStoredAccountUsageSnapshot({
      providerPayload: {
        privateProviderPayload: sentinel,
        usage: { summary: { lifetimeTokens: 250 } },
      },
      sourceSequence: 3,
      observedAt: now - 60_000,
      receivedAt: now - 59_000,
      accountFingerprint,
      providerGeneration: providerAuthority.processGeneration,
      daemonGeneration: 1,
      previousPayload: first,
    });
    value.store.recordUsage(
      added.account.id,
      1,
      first.observation.observedAt,
      first,
      providerAuthority,
    );
    value.store.recordUsagePollFailure(
      added.account.id,
      accountFingerprint,
      2,
      now - 120_000,
      providerAuthority,
    );
    value.store.recordUsage(
      added.account.id,
      3,
      third.observation.observedAt,
      third,
      providerAuthority,
    );
    value.store.recordUsagePollFailure(
      added.account.id,
      accountFingerprint,
      4,
      now - 30_000,
      providerAuthority,
    );

    const firstPage = await value.service.execute({
      kind: "account.usage-history",
      account: added.account.id,
      fromObservedAt: now - 240_000,
      throughObservedAt: now,
      limit: 2,
    }, { signal }) as {
      entries: Array<{ sourceRevision: number }>;
      nextCursor: string;
      range: { fromObservedAt: number; throughObservedAt: number };
    };
    expect(firstPage).toMatchObject({
      account: { id: added.account.id, label: "Usage history" },
      range: { fromObservedAt: now - 240_000, throughObservedAt: now },
      entries: [
        {
          state: "observed",
          sourceRevision: 1,
          observedAt: now - 180_000,
          receivedAt: now - 179_000,
          lifetimeTokens: 100,
          gapBefore: false,
        },
        {
          state: "failed",
          sourceRevision: 2,
          observedAt: now - 120_000,
          reasonCode: "account_usage_read_failed",
        },
      ],
    });
    expect(JSON.stringify(firstPage)).not.toContain(sentinel);
    expect(JSON.stringify(firstPage)).not.toContain("providerPayload");

    const secondPage = await value.service.execute({
      kind: "account.usage-history",
      account: added.account.id,
      cursor: firstPage.nextCursor,
      limit: 2,
    }, { signal }) as { entries: Array<{ sourceRevision: number }>; nextCursor: null };
    expect(secondPage.entries.map((entry) => entry.sourceRevision)).toEqual([3, 4]);
    expect(secondPage.nextCursor).toBeNull();
    expect(secondPage.entries.some((entry) => entry.sourceRevision === 2)).toBe(false);

    await expect(value.service.execute({
      kind: "account.usage-history",
      account: added.account.id,
      cursor: firstPage.nextCursor,
      fromObservedAt: firstPage.range.fromObservedAt + 1,
      limit: 2,
    }, { signal })).rejects.toMatchObject({
      code: "INVALID_INPUT",
      details: { reason: "filter_mismatch" },
    });
    const other = await value.service.execute(
      { kind: "account.add", label: "Other usage" },
      { signal },
    ) as { account: { id: `acct_${string}` } };
    await expect(value.service.execute({
      kind: "account.usage-history",
      account: other.account.id,
      cursor: firstPage.nextCursor,
      limit: 2,
    }, { signal })).rejects.toMatchObject({
      code: "INVALID_INPUT",
      details: { reason: "account_mismatch" },
    });
    now += USAGE_HISTORY_CURSOR_TTL_MS + 1;
    await expect(value.service.execute({
      kind: "account.usage-history",
      account: added.account.id,
      cursor: firstPage.nextCursor,
      limit: 2,
    }, { signal })).rejects.toMatchObject({
      code: "CONFLICT",
      details: { reason: "expired" },
    });
  });
test("binds usage-history rows and cursors to the current account identity", async () => {
    const now = 1_700_000_000_000;
    const value = await fixture(new FakeCloud(), () => undefined, () => now);
    const added = await value.service.execute({
      kind: "account.add",
      label: "Identity history",
    }, { signal }) as { account: { id: `acct_${string}` } };
    await value.service.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: false,
    }, { signal });
    const providerAuthority = value.store.requireProviderAccountAuthority(
      added.account.id,
      "codex",
    );
    const firstFingerprint = createHash("sha256")
      .update("person@example.com")
      .digest("hex");
    const first = createStoredAccountUsageSnapshot({
      providerPayload: { usage: { summary: { lifetimeTokens: 10 } } },
      sourceSequence: 1,
      observedAt: now - 2_000,
      receivedAt: now - 1_900,
      accountFingerprint: firstFingerprint,
      providerGeneration: providerAuthority.processGeneration,
      daemonGeneration: 1,
      previousPayload: null,
    });
    value.store.recordUsage(
      added.account.id,
      1,
      first.observation.observedAt,
      first,
      providerAuthority,
    );
    value.store.recordUsagePollFailure(
      added.account.id,
      firstFingerprint,
      2,
      now - 1_000,
      providerAuthority,
    );
    const firstPage = await value.service.execute({
      kind: "account.usage-history",
      account: added.account.id,
      fromObservedAt: now - 3_000,
      throughObservedAt: now,
      limit: 1,
    }, { signal }) as { entries: unknown[]; nextCursor: string };
    expect(firstPage.entries).toHaveLength(1);
    expect(firstPage.nextCursor).toBeString();

    const profile = value.store.requireProfileById(added.account.id);
    expect(value.store.setProfileState(
      profile.id,
      profile.processGeneration,
      "signed_in",
      { email: "other@example.com", plan: "Plus" },
    )).toBe(true);
    await expect(value.service.execute({
      kind: "account.usage-history",
      account: added.account.id,
      cursor: firstPage.nextCursor,
      limit: 1,
    }, { signal })).rejects.toMatchObject({
      code: "INVALID_INPUT",
      details: { reason: "account_mismatch" },
    });
    await expect(value.service.execute({
      kind: "account.usage-history",
      account: added.account.id,
      fromObservedAt: now - 3_000,
      throughObservedAt: now,
      limit: 10,
    }, { signal })).resolves.toMatchObject({ entries: [], nextCursor: null });
  });
test("rejects usage-history ranges outside the retained window", async () => {
    const now = 1_700_000_000_000;
    const { service } = await fixture(new FakeCloud(), () => undefined, () => now);
    const added = await service.execute(
      { kind: "account.add", label: "Bounded usage" },
      { signal },
    ) as { account: { id: `acct_${string}` } };
    await expect(service.execute({
      kind: "account.usage-history",
      account: added.account.id,
      fromObservedAt: now - 24 * 60 * 60_000,
      throughObservedAt: now,
      limit: 50,
    }, { signal })).resolves.toMatchObject({
      range: {
        fromObservedAt: now - 24 * 60 * 60_000,
        throughObservedAt: now,
      },
      entries: [],
    });
    await expect(service.execute({
      kind: "account.usage-history",
      account: added.account.id,
      limit: 50,
    }, { signal })).resolves.toMatchObject({
      range: {
        fromObservedAt: now - 24 * 60 * 60_000,
        throughObservedAt: now,
      },
    });
    for (const command of [
      {
        kind: "account.usage-history" as const,
        account: added.account.id,
        fromObservedAt: now - 1,
        throughObservedAt: now - 2,
        limit: 50,
      },
      {
        kind: "account.usage-history" as const,
        account: added.account.id,
        throughObservedAt: now + 1,
        limit: 50,
      },
      {
        kind: "account.usage-history" as const,
        account: added.account.id,
        fromObservedAt: now - 24 * 60 * 60_000 - 1,
        limit: 50,
      },
    ]) {
      await expect(service.execute(command, { signal })).rejects.toMatchObject({
        code: "INVALID_INPUT",
      });
    }
  });
test("records a path-free historical usage failure without inventing a zero snapshot", async () => {
    const { service, codex, store } = await fixture();
    const added = await service.execute(
      { kind: "account.add", label: "Usage failure" },
      { signal },
    ) as { account: { id: `acct_${string}` } };
    await service.execute(
      { kind: "account.login", account: added.account.id, deviceCode: false },
      { signal },
    );
    const accountFingerprint = createHash("sha256")
      .update("person@example.com")
      .digest("hex");
    codex.usageError = new Error("provider failure at /private/secret with token=do-not-store");
    await expect(service.execute(
      { kind: "account.usage", account: added.account.id, refresh: true },
      { signal },
    )).rejects.toThrow("provider failure");

    expect(store.latestUsage(added.account.id)).toBeNull();
    expect(store.latestUsagePollFailure(added.account.id, accountFingerprint)).toMatchObject({
      reasonCode: "account_usage_read_failed",
      sourceRevision: 1,
    });
    expect(JSON.stringify(store.latestUsagePollFailure(
      added.account.id,
      accountFingerprint,
    ))).not.toContain("secret");
    const status = await service.execute(
      { kind: "account.usage", account: added.account.id, refresh: false },
      { signal },
    );
    expect(status).toMatchObject({
      usage: [{
        poll: {
          reasonCode: "account_usage_read_failed",
          sourceRevision: 1,
          state: "failed",
        },
        snapshot: null,
      }],
    });

    codex.usageError = undefined;
    codex.usageResult = { observedAt: Date.now(), payload: { primary: { usedPercent: 31 } }, revision: 2 };
    const recovered = await service.execute(
      { kind: "account.usage", account: added.account.id, refresh: true },
      { signal },
    );
    expect(recovered).toMatchObject({
      usage: [{ poll: { sourceRevision: 2, state: "observed" } }],
    });
  });
test.each([
    { prefix: 1, suffix: 1, barrier: true, sample: "regression" },
    { prefix: 0, suffix: 2, barrier: true, sample: "leading-barrier" },
    ...fc.sample(fc.record({
      prefix: fc.integer({ min: 0, max: 3 }),
      suffix: fc.integer({ min: 1, max: 3 }),
      barrier: fc.boolean(),
    }), { seed: 893041, numRuns: 8 }).map((value, index) => ({ ...value, sample: String(index) })),
  ])("preserves the Claude input fact prefix ordering law for %j", async ({ prefix, suffix, barrier }) => {
    const value = await nativeClaudeFixture("Claude input fact barrier", "claude-input-barrier", {
      pid: 63_091, pidDomain: "darwin", procStart: "claude-input-barrier-process",
    });
    const authority = liveAuthorityFor(value.store, value.accountId, "claude");
    const connectionId = value.managedClaude.observationConnectionId;
    value.managedClaude.beforeStartTurnReturn = async () => {
      delete value.managedClaude.beforeStartTurnReturn;
      for (let index = 0; index < prefix; index += 1) {
        await value.service.observeClaudeFact(authority, {
          connectionId, providerThreadId: value.providerThreadId,
          type: "turnCompleted", turnId: `captured-prefix-${String(index)}`, status: "completed",
        });
      }
      // This session-wide notification reserves its normal ordered slot, but
      // the input operation does not own authority to apply it inline.
      if (barrier) {
        await value.service.observeClaudeFact(authority, {
          connectionId, providerThreadId: value.providerThreadId,
          type: "protocolNotice", event: "test/ordered_barrier",
        });
      }
      for (let index = 0; index < suffix; index += 1) {
        await value.service.observeClaudeFact(authority, {
          connectionId, providerThreadId: value.providerThreadId,
          type: "turnCompleted", turnId: `captured-suffix-${String(index)}`, status: "completed",
        });
      }
      throw new IndeterminateClaudeEffectError("turn/start",
        new Error("test-only failure after captured facts"));
    };
    const idempotencyKey = crypto.randomUUID();
    const command = {
      kind: "session.send" as const, session: value.session.id,
      message: "Retain only the safe ordered prefix", idempotencyKey,
    };
    await expect(value.service.execute(command, { signal }))
      .rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    await value.service.settled();
    const page = value.store.listSessionEvents({ sessionId: value.session.id, afterSequence: null });
    const expectedTurns = [
      ...Array.from({ length: prefix }, (_, index) => `captured-prefix-${String(index)}`),
      ...Array.from({ length: barrier ? 0 : suffix }, (_, index) => `captured-suffix-${String(index)}`),
    ];
    expect(page.events.map((event) => event.body).filter((body) => body.type === "turn_completed"))
      .toEqual(expectedTurns.map((turnId) => ({
        type: "turn_completed", status: "completed",
        turnId: value.store.projectPublicProviderIdentifier(turnId),
      })));
    expect(page.events.some((event) => event.body.type === "user_message")).toBe(false);
    expect(value.store.readMutation(idempotencyKey)).toMatchObject({ state: "ambiguous" });
    expect(value.store.requireSession(value.session.id).state).toBe("recovery_required");
    const eventsBeforeReplay = page.events;
    await expect(value.service.execute(command, { signal }))
      .rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    await expect(value.service.execute({ ...command, idempotencyKey: crypto.randomUUID() }, { signal }))
      .rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    await value.service.settled();
    expect(value.managedClaude.turnRequests).toHaveLength(1);
    expect(value.store.listSessionEvents({ sessionId: value.session.id, afterSequence: null }).events)
      .toEqual(eventsBeforeReplay);
  }, 5_000);
test.each(["binding", "process"] as const)(
    "refuses a captured Claude input fact after its provider %s authority changes", async (retirement) => {
      const value = await nativeClaudeFixture("Claude stale input fact", "claude-input-stale", {
        pid: 63_092, pidDomain: "darwin", procStart: "claude-input-stale-process",
      });
      const authority = liveAuthorityFor(value.store, value.accountId, "claude");
      const captured = value.store.requireProviderAccountAuthority(value.accountId, "claude");
      value.managedClaude.beforeStartTurnReturn = async () => {
        delete value.managedClaude.beforeStartTurnReturn;
        await value.service.observeClaudeFact(authority, {
          connectionId: value.managedClaude.observationConnectionId,
          providerThreadId: value.providerThreadId,
          type: "turnCompleted", turnId: "retired-captured-turn", status: "completed",
        });
        if (retirement === "binding") {
          value.store.observeProviderAccountReadiness({
            profileId: value.accountId, provider: "claude",
            expectedBindingGeneration: captured.bindingGeneration, readiness: "signed_out",
          });
        } else {
          value.store.advanceProviderAccountProcessGeneration({
            profileId: value.accountId, provider: "claude",
            expectedProcessGeneration: captured.processGeneration,
          });
        }
        throw new IndeterminateClaudeEffectError("turn/start",
          new Error("test-only failure after authority retirement"));
      };
      const idempotencyKey = crypto.randomUUID();
      await expect(value.service.execute({
        kind: "session.send", session: value.session.id,
        message: "Do not retain stale authority", idempotencyKey,
      }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
      await value.service.settled();
      expect(value.store.requireProviderAccountAuthority(value.accountId, "claude")).not.toEqual(captured);
      expect(value.store.listSessionEvents({ sessionId: value.session.id, afterSequence: null }).events
        .some((event) => event.body.type === "turn_completed" || event.body.type === "user_message"))
        .toBe(false);
      expect(value.store.readMutation(idempotencyKey)).toMatchObject({ state: "ambiguous" });
      expect(value.store.requireSession(value.session.id).state).toBe("recovery_required");
      expect(value.managedClaude.turnRequests).toHaveLength(1);
    },
  );
test("seals retained Claude input fact routing before its producer mutates callback arguments", async () => {
    const value = await nativeClaudeFixture("Claude captured input snapshot", "claude-input-snapshot", {
      pid: 63_093, pidDomain: "darwin", procStart: "claude-input-snapshot-process",
    });
    value.managedClaude.beforeStartTurnReturn = async () => {
      delete value.managedClaude.beforeStartTurnReturn;
      const authority = { ...liveAuthorityFor(value.store, value.accountId, "claude") };
      const fact = {
        connectionId: value.managedClaude.observationConnectionId,
        providerThreadId: value.providerThreadId,
        type: "turnCompleted" as const, turnId: "sealed-captured-turn", status: "completed" as const,
      };
      await value.service.observeClaudeFact(authority, fact);
      // The callback has reserved its original FIFO slot. Its caller may no
      // longer mutate the routing or payload retained for the later drain.
      authority.generation += 1;
      fact.connectionId = "30000000-0000-4000-8000-0000000000ff";
      fact.providerThreadId = "mutated-unrelated-thread";
      fact.turnId = "mutated-unrelated-turn";
      throw new IndeterminateClaudeEffectError("turn/start",
        new Error("test-only failure after caller mutation"));
    };
    const idempotencyKey = crypto.randomUUID();
    await expect(value.service.execute({
      kind: "session.send", session: value.session.id,
      message: "Retain the observed immutable routing", idempotencyKey,
    }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    await value.service.settled();
    const bodies = value.store.listSessionEvents({ sessionId: value.session.id, afterSequence: null })
      .events.map((event) => event.body);
    expect(bodies.filter((body) => body.type === "turn_completed"))
      .toEqual([{
        type: "turn_completed", status: "completed",
        turnId: value.store.projectPublicProviderIdentifier("sealed-captured-turn"),
      }]);
    expect(bodies.some((body) => body.type === "user_message")).toBe(false);
    expect(value.store.readMutation(idempotencyKey)).toMatchObject({ state: "ambiguous" });
    expect(value.store.requireSession(value.session.id).state).toBe("recovery_required");
    expect(value.managedClaude.turnRequests).toHaveLength(1);
  });
test.each(["queued", "reentrant"] as const)(
    "bounds the lifetime of retained Claude input facts across %s arrivals", async (arrival) => {
      const value = await nativeClaudeFixture("Claude input fact bound", "claude-input-bound", {
        pid: 63_094, pidDomain: "darwin", procStart: "claude-input-bound-process",
      });
      const authority = liveAuthorityFor(value.store, value.accountId, "claude");
      const capturedLimit = 256;
      let observed = 0;
      const observeNext = async (): Promise<void> => {
        const index = observed++;
        await value.service.observeClaudeFact(authority, {
          connectionId: value.managedClaude.observationConnectionId,
          providerThreadId: value.providerThreadId,
          type: "turnCompleted", turnId: `bounded-turn-${String(index)}`, status: "completed",
        });
      };
      value.managedClaude.beforeStartTurnReturn = async () => {
        delete value.managedClaude.beforeStartTurnReturn;
        if (arrival === "queued") {
          for (let index = 0; index <= capturedLimit; index += 1) await observeNext();
        } else {
          await observeNext();
          value.cloud.beforeProjectionUnsettledSessionReturn = async (sessionId) => {
            if (sessionId !== value.session.id || observed > capturedLimit) return;
            // Admit another real callback while the previous closure drains.
            // Removing jobs must not replenish lifetime count capacity.
            await observeNext();
          };
        }
        throw new IndeterminateClaudeEffectError("turn/start",
          new Error("test-only failure before a bounded fact drain"));
      };
      const idempotencyKey = crypto.randomUUID();
      try {
        await expect(value.service.execute({
          kind: "session.send", session: value.session.id,
          message: "Keep callback retention finite", idempotencyKey,
        }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
        await value.service.settled();
      } finally {
        delete value.cloud.beforeProjectionUnsettledSessionReturn;
      }
      expect(observed).toBe(capturedLimit + 1);
      const first = value.store.listSessionEvents({ sessionId: value.session.id, afterSequence: null });
      const lastSequence = first.events.at(-1)?.sequence;
      if (lastSequence === undefined) throw new Error("Expected retained events before the bound.");
      const second = value.store.listSessionEvents({ sessionId: value.session.id, afterSequence: lastSequence });
      const bodies = [...first.events, ...second.events].map((event) => event.body);
      const completed = bodies.filter((body) => body.type === "turn_completed");
      expect(completed.map((body) => body.turnId)).toEqual(Array.from({ length: capturedLimit },
        (_, index) => value.store.projectPublicProviderIdentifier(`bounded-turn-${String(index)}`)));
      expect(bodies.some((body) => body.type === "user_message")).toBe(false);
      expect(value.store.readMutation(idempotencyKey)).toMatchObject({ state: "ambiguous" });
      expect(value.store.requireSession(value.session.id).state).toBe("recovery_required");
      expect(value.managedClaude.turnRequests).toHaveLength(1);
    },
  );
test("does not invent a Claude input barrier after the preceding ordered fact releases its locks", async () => {
    const value = await nativeClaudeFixture("Claude prior fact release", "claude-input-prior-fact", {
      pid: 63_095, pidDomain: "darwin", procStart: "claude-input-prior-fact-process",
    });
    const authority = liveAuthorityFor(value.store, value.accountId, "claude");
    const connectionId = value.managedClaude.observationConnectionId;
    value.managedClaude.beforeStartTurnReturn = async () => {
      delete value.managedClaude.beforeStartTurnReturn;
      await value.service.observeClaudeFact(authority, {
        connectionId, providerThreadId: value.providerThreadId,
        type: "turnCompleted", turnId: "following-input-fact", status: "completed",
      });
      throw new IndeterminateClaudeEffectError("turn/start",
        new Error("test-only failure after preceding locks released"));
    };
    const idempotencyKey = crypto.randomUUID();
    const following: { outcome?: Promise<Readonly<{ status: string; error?: unknown }>> } = {};
    value.cloud.beforeProjectionUnsettledSessionReturn = async (sessionId) => {
      if (sessionId !== value.session.id) return;
      delete value.cloud.beforeProjectionUnsettledSessionReturn;
      // Queue the next input while the preceding fact still owns its locks.
      // Do not await that input from its predecessor's held authority.
      following.outcome = value.service.execute({
        kind: "session.send", session: value.session.id,
        message: "Wait behind the preceding fact", idempotencyKey,
      }, { signal }).then(
        () => ({ status: "fulfilled" }),
        (error: unknown) => ({ status: "rejected", error }),
      );
    };
    await value.service.observeClaudeFact(authority, {
      connectionId, providerThreadId: value.providerThreadId,
      type: "turnCompleted", turnId: "preceding-fact", status: "completed",
    });
    if (following.outcome === undefined) throw new Error("Expected preceding fact to queue the next input.");
    expect(await following.outcome).toMatchObject({ status: "rejected", error: { code: "RECOVERY_REQUIRED" } });
    await value.service.settled();
    const completed = value.store.listSessionEvents({ sessionId: value.session.id, afterSequence: null })
      .events.map((event) => event.body).filter((body) => body.type === "turn_completed");
    expect(completed.map((body) => body.turnId)).toEqual([
      value.store.projectPublicProviderIdentifier("preceding-fact"),
      value.store.projectPublicProviderIdentifier("following-input-fact"),
    ]);
    expect(value.store.readMutation(idempotencyKey)).toMatchObject({ state: "ambiguous" });
    expect(value.store.requireSession(value.session.id).state).toBe("recovery_required");
    expect(value.managedClaude.turnRequests).toHaveLength(1);
  });
test.each([
    { payload: "single", outcome: "rejected" },
    { payload: "cumulative", outcome: "rejected" },
    { payload: "single", outcome: "accepted" },
  ] as const)(
    "bounds retained Claude input fact bytes before a later completion: %j", async ({ payload, outcome }) => {
      const value = await nativeClaudeFixture("Claude input fact byte bound", "claude-input-byte-bound", {
        pid: 63_096, pidDomain: "darwin", procStart: "claude-input-byte-bound-process",
      });
      const authority = liveAuthorityFor(value.store, value.accountId, "claude");
      const connectionId = value.managedClaude.observationConnectionId;
      let providerReturns = 0;
      const startTurn = value.managedClaude.startTurn.bind(value.managedClaude);
      value.managedClaude.startTurn = async (input) => {
        const result = await startTurn(input);
        providerReturns += 1;
        return result;
      };
      value.managedClaude.beforeStartTurnReturn = async () => {
        delete value.managedClaude.beforeStartTurnReturn;
        await value.service.observeClaudeFact(authority, {
          connectionId, providerThreadId: value.providerThreadId,
          type: "turnCompleted", turnId: "byte-prefix", status: "completed",
        });
        const text = "a".repeat(payload === "single" ? 1024 * 1024 : 64 * 1024);
        // Both variants stay far below the independent 256-fact count cap.
        // The second crosses the byte budget only through cumulative input.
        for (let index = 0; index < (payload === "single" ? 1 : 17); index += 1) {
          await value.service.observeClaudeFact(authority, {
            connectionId, providerThreadId: value.providerThreadId,
            type: "assistantDelta", turnId: "byte-payload", itemId: "byte-item", text,
          });
        }
        await value.service.observeClaudeFact(authority, {
          connectionId, providerThreadId: value.providerThreadId,
          type: "turnCompleted", turnId: "byte-suffix", status: "completed",
        });
        if (outcome === "rejected") {
          throw new IndeterminateClaudeEffectError("turn/start",
            new Error("test-only failure after the byte budget is exceeded"));
        }
      };
      const idempotencyKey = crypto.randomUUID();
      await expect(value.service.execute({
        kind: "session.send", session: value.session.id,
        message: "Bound retained callback bytes", idempotencyKey,
      }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
      await value.service.settled();
      expect(providerReturns).toBe(outcome === "accepted" ? 1 : 0);
      const completed: string[] = [];
      let afterSequence: number | null = null;
      let reachedEnd = false;
      for (let pageIndex = 0; pageIndex < 8; pageIndex += 1) {
        const page = value.store.listSessionEvents({ sessionId: value.session.id, afterSequence });
        for (const event of page.events) {
          if (event.body.type === "turn_completed") completed.push(event.body.turnId);
          expect(event.body.type).not.toBe("user_message");
        }
        const lastSequence = page.events.at(-1)?.sequence;
        if (lastSequence === undefined || lastSequence >= page.observedThroughSequence) {
          reachedEnd = true;
          break;
        }
        afterSequence = lastSequence;
      }
      expect(reachedEnd).toBe(true);
      expect(completed).toEqual([value.store.projectPublicProviderIdentifier("byte-prefix")]);
      expect(value.store.readMutation(idempotencyKey)).toMatchObject({ state: "ambiguous" });
      expect(value.store.requireSession(value.session.id).state).toBe("recovery_required");
      expect(value.managedClaude.turnRequests).toHaveLength(1);
      await expect(value.service.execute({
        kind: "session.send", session: value.session.id, message: "Do not replay overflowing input",
      }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
      expect(value.managedClaude.turnRequests).toHaveLength(1);
    },
  );
test("never retries a retained Claude input fact closure after its local drain fails", async () => {
    const value = await nativeClaudeFixture("Claude input fact drain failure", "claude-input-drain-failure", {
      pid: 63_097, pidDomain: "darwin", procStart: "claude-input-drain-failure-process",
    });
    const authority = liveAuthorityFor(value.store, value.accountId, "claude");
    let attemptedDrains = 0;
    value.managedClaude.beforeStartTurnReturn = async () => {
      delete value.managedClaude.beforeStartTurnReturn;
      await value.service.observeClaudeFact(authority, {
        connectionId: value.managedClaude.observationConnectionId,
        providerThreadId: value.providerThreadId,
        type: "turnCompleted", turnId: "partially-drained-turn", status: "completed",
      });
      value.cloud.beforeProjectionUnsettledSessionReturn = async (sessionId) => {
        if (sessionId !== value.session.id) return;
        attemptedDrains += 1;
        throw new Error("test-only local retention failure after the event was appended");
      };
      throw new IndeterminateClaudeEffectError("turn/start",
        new Error("test-only provider input uncertainty before the drain"));
    };
    const idempotencyKey = crypto.randomUUID();
    const command = {
      kind: "session.send" as const, session: value.session.id,
      message: "Do not retry a partially applied local fact", idempotencyKey,
    };
    try {
      await expect(value.service.execute(command, { signal }))
        .rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
      await value.service.settled();
    } finally {
      delete value.cloud.beforeProjectionUnsettledSessionReturn;
    }
    expect(attemptedDrains).toBe(1);
    const page = value.store.listSessionEvents({ sessionId: value.session.id, afterSequence: null });
    expect(page.events.map((event) => event.body).filter((body) => body.type === "turn_completed"))
      .toEqual([{
        type: "turn_completed", status: "completed",
        turnId: value.store.projectPublicProviderIdentifier("partially-drained-turn"),
      }]);
    expect(value.store.readMutation(idempotencyKey)).toMatchObject({ state: "ambiguous" });
    expect(value.store.requireSession(value.session.id).state).toBe("recovery_required");
    await expect(value.service.execute(command, { signal }))
      .rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    await expect(value.service.execute({ ...command, idempotencyKey: crypto.randomUUID() }, { signal }))
      .rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    await value.service.settled();
    expect(value.managedClaude.turnRequests).toHaveLength(1);
    expect(attemptedDrains).toBe(1);
    expect(value.store.listSessionEvents({ sessionId: value.session.id, afterSequence: null }).events)
      .toEqual(page.events);
  });
test("accepts provider notifications that arrive before mutation responses", async () => {
    const { service, codex, documents, store } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Race" }, { signal }) as { account: { id: string } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    await service.execute({ kind: "project.add", label: "Docs", path: documents }, { signal });
    const started = await service.execute({ kind: "session.start", account: added.account.id, preset: "high", presetContract: currentPresetContract, fast: false }, { signal }) as { session: { id: string; providerThreadId: string } };
    const authority = liveAuthorityFor(store, added.account.id as `acct_${string}`);
    codex.beforeStartTurnReturn = async () => service.observeCodexFact(authority, { type: "turnStarted", threadId: started.session.providerThreadId, turn: { id: "turn-next", items: [], status: "inProgress", startedAt: 1, completedAt: null, durationMs: null } });
    expect(await service.execute({ kind: "session.send", session: started.session.id, message: "race" }, { signal })).toMatchObject({ session: { state: "active", activeTurnId: "turn-next" } });
    expect(store.latestSessionRuntimeProfile(started.session.id as `sess_${string}`)).toMatchObject({ revision: 2, sourceKind: "turn_start" });
    codex.beforeInterruptReturn = async () => service.observeCodexFact(authority, { type: "turnCompleted", threadId: started.session.providerThreadId, turn: { id: "turn-next", items: [], status: "completed", startedAt: 1, completedAt: 2, durationMs: 1 } });
    expect(await service.execute({ kind: "session.stop", session: started.session.id }, { signal })).toMatchObject({ session: { state: "idle" } });
    codex.beforeRenameReturn = async () => service.observeCodexFact(authority, { type: "threadNameUpdated", threadId: started.session.providerThreadId, name: "Raced name" });
    expect(await service.execute({ kind: "session.rename", session: started.session.id, name: "Raced name" }, { signal })).toMatchObject({ session: { title: "Raced name" } });
  });
test("refreshes the exact turn profile after the provider baseline and immediately before dispatch", async () => {
    const { service, codex, documents, store } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Review order" }, { signal }) as { account: { id: string } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    await service.execute({ kind: "project.add", label: "Docs", path: documents }, { signal });
    const started = await service.execute({ kind: "session.start", account: added.account.id, preset: "high", presetContract: 2, fast: false }, { signal }) as { session: { id: `sess_${string}`; providerThreadId: string } };

    codex.turnEffectTrace.length = 0;
    await service.execute({ kind: "session.send", session: started.session.id, message: "active" }, { signal });
    expect(codex.turnEffectTrace).toEqual(["read", "review", "start"]);

    await service.execute({ kind: "session.queue", session: started.session.id, message: "queued" }, { signal });
    codex.readProjection = { ...codex.readProjection, status: "idle", providerUpdatedAt: (codex.readProjection.providerUpdatedAt ?? 10) + 1 };
    delete (codex.readProjection as { activeTurnId?: string }).activeTurnId;
    codex.turnEffectTrace.length = 0;
    await service.observeCodexFact(
      liveAuthorityFor(store, added.account.id as `acct_${string}`),
      { type: "turnCompleted", threadId: started.session.providerThreadId, turn: { id: "active-turn", items: [], status: "completed", startedAt: 1, completedAt: 2, durationMs: 1 } },
    );
    await service.settled();
    expect(codex.turnEffectTrace).toEqual(["read", "review", "start"]);
  });
test("serializes concurrent note and Fast metadata behind a provider-applied turn receipt", async () => {
    const { service, codex, documents, store } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Metadata race" }, { signal }) as { account: { id: string } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    await service.execute({ kind: "project.add", label: "Docs", path: documents }, { signal });
    const started = await service.execute({ kind: "session.start", account: added.account.id, preset: "high", presetContract: 2, fast: false }, { signal }) as { session: { id: `sess_${string}`; providerThreadId: string } };
    let note: Promise<unknown> | undefined;
    let fast: Promise<unknown> | undefined;
    codex.beforeStartTurnReturn = async () => {
      delete codex.beforeStartTurnReturn;
      note = service.execute({ kind: "session.note.set", session: started.session.id, note: "Concurrent note" }, { signal });
      fast = service.execute({ kind: "session.fast", session: started.session.id, enabled: true }, { signal });
      await Bun.sleep(0);
    };
    const key = "00000000-0000-4000-8000-000000000119";

    await expect(service.execute({ kind: "session.send", session: started.session.id, message: "provider applies first", idempotencyKey: key }, { signal })).resolves.toMatchObject({ session: { state: "active" } });
    if (note === undefined || fast === undefined) throw new Error("Concurrent metadata commands were not admitted.");
    await Promise.all([note, fast]);

    expect(store.readMutation(key)).toMatchObject({ state: "applied" });
    expect(store.requireSession(started.session.id)).toMatchObject({ state: "active", note: "Concurrent note", fastEnabled: true });
    expect(store.latestSessionRuntimeProfile(started.session.id)).toMatchObject({ revision: 2, sourceKind: "turn_start" });
  });
test("lets the cloud projection reader reacquire authority while the in-flight fence rejects concurrent mutations", async () => {
    const cloud = new FakeCloud();
    const value = await fixture(cloud);
    const { sessionId } = await createIdleSession(value, "Projection serialization");
    const recoverySession = value.store.requireSession(sessionId);
    const recoveryProfile = value.store.requireProfileById(recoverySession.profileId);
    if (recoverySession.providerThreadId === undefined) throw new Error("Expected a bound recovery session.");
    const recoveryProviderThreadId = recoverySession.providerThreadId;
    const recoveryRuntime = value.store.latestSessionRuntimeProfile(sessionId)?.profile;
    if (recoveryRuntime === undefined) throw new Error("Expected a recovery runtime profile.");
    const pendingReplayKey = "00000000-0000-4000-8000-000000000807";
    const pendingReplayMessage = "settled before compact recovery";
    let pendingReplayAttempt: ReturnType<StateStore["prepareSessionInputMutation"]>["attempt"] | undefined;
    const peerCreated = value.store.createSession({
      profileId: recoveryProfile.id,
      title: "Same-account recovery peer",
      provider: "codex",
      preset: "high",
      fastEnabled: false,
    });
    const peer = value.store.bindSession({
      sessionId: peerCreated.id,
      expectedRevision: peerCreated.revision,
      providerThreadId: "same-account-recovery-peer",
      state: "idle",
    });
    value.store.bindSessionProviderAccountAuthority({
      sessionId: peer.id,
      provider: "codex",
      runtimeScope: "managed",
      accountKey: codexProviderAccountKey(),
    });
    const providerWritesBefore = providerMutationCalls(value.codex);
    let entered!: () => void;
    const recoveryEntered = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const recoveryGate = new Promise<void>((resolve) => { release = resolve; });
    cloud.beforeProjectionRecoveryReturn = async () => {
      await expect(value.service.readSessionProjectionForCloud(
        sessionId,
        signal,
      )).resolves.toMatchObject({
        providerThreadId: recoverySession.providerThreadId,
      });
      const recoveryAuthority = liveAuthorityFor(value.store, recoveryProfile.id);
      await value.service.observeCodexFact(recoveryAuthority, {
        name: "must not cross the recovery fence",
        threadId: recoverySession.providerThreadId as string,
        type: "threadNameUpdated",
      });
      const { attempt: pendingReplay } = value.store.prepareSessionInputMutation({
        sessionId,
        providerAuthority: value.store.requireProviderAccountAuthority(recoveryProfile.id, "codex"),
        message: pendingReplayMessage,
        attachments: [],
        daemonGeneration: value.daemonGeneration,
        bootId: value.daemonBootId,
        idempotencyKey: pendingReplayKey,
        kind: "session.send",
      });
      pendingReplayAttempt = pendingReplay;
      value.store.beginSessionMutationEffect({
        attemptId: pendingReplay.id,
        evidence: {
          baseline: {
            activeTurnId: null,
            providerUpdatedAt: recoverySession.providerUpdatedAt ?? null,
            status: "idle",
          },
          clientMessageId: pendingReplay.id,
          kind: "session.send",
          messageDigest: createHash("sha256").update(pendingReplayMessage).digest("hex"),
          providerThreadId: recoveryProviderThreadId,
          runtimeProfile: recoveryRuntime,
        },
        providerAuthority: value.store.requireProviderAccountAuthority(recoveryProfile.id, "codex"),
        attachments: [],
        daemonGeneration: value.daemonGeneration,
        bootId: value.daemonBootId,
        message: pendingReplayMessage,
        profileGeneration: recoveryProfile.processGeneration,
        sessionId,
        transcript: {
          accountId: recoveryProfile.id,
          actor: "human",
          message: pendingReplayMessage,
          providerConnectionId: "30000000-0000-4000-8000-00000000000d",
          providerGeneration: recoveryProfile.processGeneration,
        },
      });
      // The admitted turn remains in flight while projection recovery holds
      // the fence; no applied receipt or source runtime is fabricated.
      await value.service.observeCodexAccount(recoveryAuthority, { signedIn: false });
      entered();
      await recoveryGate;
    };
    const recoveryKey = "00000000-0000-4000-8000-000000000801";
    const recovery = value.service.execute({
      acknowledgeGap: true,
      idempotencyKey: recoveryKey,
      kind: "sync.projection-recover",
      session: sessionId,
    }, { signal });
    await recoveryEntered;

    await expect(value.service.execute({
      acknowledgeGap: true,
      idempotencyKey: "00000000-0000-4000-8000-000000000804",
      kind: "sync.projection-recover",
      session: peer.id,
    }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    await expect(value.service.execute({
      kind: "session.note.set",
      note: "must remain fenced with its account peer",
      session: peer.id,
    }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    await expect(value.service.execute({
      idempotencyKey: "00000000-0000-4000-8000-000000000802",
      kind: "session.send",
      message: "after recovery",
      session: sessionId,
    }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    await expect(value.service.execute({
      idempotencyKey: pendingReplayKey,
      kind: "session.send",
      message: pendingReplayMessage,
      session: sessionId,
    }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(value.store.readSessionUserMessageSource(sessionId, "mutation", pendingReplayKey))
      .toMatchObject({ status: "pending" });
    await expect(value.service.execute({
      idempotencyKey: "00000000-0000-4000-8000-000000000803",
      kind: "session.note.set",
      note: "after recovery",
      session: sessionId,
    }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });

    expect(value.store.requireSession(sessionId)).toMatchObject({
      note: "",
      title: recoverySession.title,
    });
    expect(value.store.requireProfileById(recoveryProfile.id).state).toBe("signed_in");
    expect(providerMutationCalls(value.codex)).toEqual(providerWritesBefore);
    expect(cloud.projectionRecoveries).toHaveLength(1);
    expect(cloud.projectionRecoveries[0]).toMatchObject({
      acknowledgeGap: true,
      idempotencyKey: recoveryKey,
      sessionPublicId: sessionId,
    });

    release();
    await expect(recovery).resolves.toBe(cloud.projectionRecoveryResult);
    if (pendingReplayAttempt === undefined) throw new Error("Expected the admitted in-flight turn.");
    value.store.completeSessionTurnEffect({
      attemptId: pendingReplayAttempt.id, sessionId,
      accountId: recoveryProfile.id, providerGeneration: recoveryProfile.processGeneration,
      providerAuthority: value.store.requireProviderAccountAuthority(recoveryProfile.id, "codex"),
      providerConnectionId: "30000000-0000-4000-8000-00000000000d",
      expectedSessionRevision: value.store.requireSession(sessionId).revision, applyResponseState: false,
      turnId: "turn-pending-compact-recovery", turnStatus: "inProgress",
      runtimeProfile: recoveryRuntime, message: pendingReplayMessage,
      receipt: { effectiveRuntimeProfile: recoveryRuntime, sourceId: pendingReplayAttempt.id,
        status: "inProgress", turnId: "turn-pending-compact-recovery" },
    });
    await expect(value.service.execute({
      idempotencyKey: pendingReplayKey,
      kind: "session.send",
      message: pendingReplayMessage,
      session: sessionId,
    }, { signal })).resolves.toMatchObject({ turnId: "turn-pending-compact-recovery" });
    await expect(value.service.execute({
      idempotencyKey: "00000000-0000-4000-8000-000000000802",
      kind: "session.send",
      message: "after recovery",
      session: sessionId,
    }, { signal })).resolves.toBeDefined();
    await expect(value.service.execute({
      idempotencyKey: "00000000-0000-4000-8000-000000000803",
      kind: "session.note.set",
      note: "after recovery",
      session: sessionId,
    }, { signal })).resolves.toBeDefined();
    expect(value.store.requireSession(sessionId).note).toBe("after recovery");
    expect(value.codex.calls.filter((call) => call === "send")).toHaveLength(1);
  });
test("fences manual, autorespond, and deadline interaction effects during projection recovery", async () => {
    let now = 125_000;
    const cloud = new FakeCloud();
    const value = await fixture(cloud,
      () => undefined,
      () => now,
    );
    const { sessionId } = await createIdleSession(value, "Projection interaction fence");
    const session = value.store.requireSession(sessionId);
    const profile = value.store.requireProfileById(session.profileId);
    const manual = await seedResolvableInteraction(
      value,
      sessionId,
      "projection-manual-fence",
      { requestedAt: now, deadlineAt: now + 10_000 },
    );
    let entered!: () => void;
    const recoveryEntered = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const recoveryGate = new Promise<void>((resolve) => { release = resolve; });
    cloud.beforeProjectionRecoveryReturn = async () => {
      entered();
      await recoveryGate;
    };
    const recovery = value.service.execute({
      acknowledgeGap: true,
      idempotencyKey: "00000000-0000-4000-8000-000000000805",
      kind: "sync.projection-recover",
      session: sessionId,
    }, { signal });
    await recoveryEntered;

    await expect(value.service.execute({
      kind: "interaction.resolve",
      interaction: manual.interaction.publicId,
      expectedRevision: manual.interaction.revision,
      resolution: { kind: "approval_decision", decision: "once" },
    }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });

    const deadline = await seedResolvableInteraction(
      value,
      sessionId,
      "projection-deadline-fence",
      { requestedAt: now, deadlineAt: now + 1 },
    );
    now += 1;
    await expect(value.service.maintainInteractionDeadlines()).resolves.toEqual({
      examined: 1,
      failed: 1,
    });

    value.store.setSessionApprovalMode(sessionId, "auto:all");
    const automatic = await seedResolvableInteraction(
      value,
      sessionId,
      "projection-autorespond-fence",
      { requestedAt: now, deadlineAt: now + 10_000 },
    );
    const evidenceDeadline = Date.now() + 2_000;
    while (!value.store.listAutorespondEvidence({ sessionId }).some((row) =>
      row.interactionId === automatic.interaction.publicId)) {
      if (Date.now() >= evidenceDeadline) {
        throw new Error("Timed out waiting for fenced autorespond evidence.");
      }
      await Bun.sleep(5);
    }

    expect(value.codex.validatedInteractions).toEqual([]);
    expect(value.codex.resolvedInteractions).toEqual([]);
    expect(value.codex.validatedInteractionTimeouts).toEqual([]);
    expect(value.codex.timedOutInteractions).toEqual([]);
    expect(value.store.requireInteraction(manual.interaction.publicId).state).toBe("pending");
    expect(value.store.requireInteraction(deadline.interaction.publicId).state).toBe("pending");
    expect(value.store.requireInteraction(automatic.interaction.publicId).state).toBe("pending");
    const evidence = value.store.listAutorespondEvidence({ sessionId });
    expect(evidence).toHaveLength(3);
    expect(evidence.find((row) => row.interactionId === manual.interaction.publicId)).toMatchObject({
      decision: "manual_mode",
      mode: "manual",
      outcome: "refused",
    });
    expect(evidence.find((row) => row.interactionId === deadline.interaction.publicId)).toMatchObject({
      decision: "manual_mode",
      mode: "manual",
      outcome: "refused",
    });
    expect(evidence.find((row) => row.interactionId === automatic.interaction.publicId)).toMatchObject({
      decision: "once",
      mode: "auto:all",
      outcome: "refused",
    });
    expect(value.store.requireProfileById(profile.id).state).toBe("signed_in");

    release();
    await expect(recovery).resolves.toBe(cloud.projectionRecoveryResult);
  });
test("fences every interaction effect behind a pending accepted-message transcript", async () => {
    let now = 126_000;
    const value = await fixture(new FakeCloud(),
      () => undefined,
      () => now,
    );
    const { sessionId } = await createIdleSession(value, "Transcript interaction fence");
    const session = value.store.requireSession(sessionId);
    const profile = value.store.requireProfileById(session.profileId);
    const runtime = value.store.latestSessionRuntimeProfile(session.id)?.profile;
    if (runtime === undefined || session.providerThreadId === undefined) {
      throw new Error("Expected a bound session with a runtime profile.");
    }
    const message = "accepted before transcript commit";
    const { attempt } = value.store.prepareSessionInputMutation({
      kind: "session.send",
      sessionId: session.id,
      providerAuthority: value.store.requireProviderAccountAuthority(profile.id, "codex"),
      message, attachments: [], daemonGeneration: value.daemonGeneration, bootId: value.daemonBootId,
      idempotencyKey: "00000000-0000-4000-8000-000000000806",
    });
    value.store.beginSessionMutationEffect({
      providerAuthority: value.store.requireProviderAccountAuthority(profile.id, "codex"),
      attachments: [], daemonGeneration: value.daemonGeneration, bootId: value.daemonBootId,
      attemptId: attempt.id,
      message,
      sessionId: session.id,
      profileGeneration: profile.processGeneration,
      transcript: {
        accountId: profile.id,
        providerGeneration: profile.processGeneration,
        providerConnectionId: "30000000-0000-4000-8000-00000000000b",
        actor: "human",
        message,
      },
      evidence: {
        kind: "session.send",
        providerThreadId: session.providerThreadId,
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
    expect(value.store.transitionMutation(attempt.id, "effect_started", "applied", {
      turnId: "turn-pending-transcript-fence",
      status: "inProgress",
      sourceId: attempt.id,
      effectiveRuntimeProfile: runtime,
    })).toBe(true);

    const manual = await seedResolvableInteraction(
      value,
      sessionId,
      "transcript-manual-fence",
      { requestedAt: now, deadlineAt: now + 10_000 },
    );
    await expect(value.service.execute({
      kind: "interaction.resolve",
      interaction: manual.interaction.publicId,
      expectedRevision: manual.interaction.revision,
      resolution: { kind: "approval_decision", decision: "once" },
    }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });

    const deadline = await seedResolvableInteraction(
      value,
      sessionId,
      "transcript-deadline-fence",
      { requestedAt: now, deadlineAt: now + 1 },
    );
    now += 1;
    await expect(value.service.maintainInteractionDeadlines()).resolves.toEqual({
      examined: 1,
      failed: 1,
    });

    value.store.setSessionApprovalMode(sessionId, "auto:all");
    const automatic = await seedResolvableInteraction(
      value,
      sessionId,
      "transcript-autorespond-fence",
      { requestedAt: now, deadlineAt: now + 10_000 },
    );
    const evidenceDeadline = Date.now() + 2_000;
    while (!value.store.listAutorespondEvidence({ sessionId }).some((row) =>
      row.interactionId === automatic.interaction.publicId)) {
      if (Date.now() >= evidenceDeadline) {
        throw new Error("Timed out waiting for transcript-fenced autorespond evidence.");
      }
      await Bun.sleep(5);
    }

    expect(value.codex.validatedInteractions).toEqual([]);
    expect(value.codex.resolvedInteractions).toEqual([]);
    expect(value.codex.validatedInteractionTimeouts).toEqual([]);
    expect(value.codex.timedOutInteractions).toEqual([]);
    expect(value.store.requireInteraction(manual.interaction.publicId).state).toBe("pending");
    expect(value.store.requireInteraction(deadline.interaction.publicId).state).toBe("pending");
    expect(value.store.requireInteraction(automatic.interaction.publicId).state).toBe("pending");
  });
test("routes same-key projection recovery replay through the same closed cloud seam", async () => {
    const cloud = new FakeCloud();
    const value = await fixture(cloud);
    const { sessionId } = await createIdleSession(value, "Projection replay");
    const providerWritesBefore = providerMutationCalls(value.codex);
    const command = {
      acknowledgeGap: true as const,
      idempotencyKey: "00000000-0000-4000-8000-000000000809",
      kind: "sync.projection-recover" as const,
      session: sessionId,
    };

    expect(await value.service.execute(command, { signal })).toBe(cloud.projectionRecoveryResult);
    expect(await value.service.execute(command, { signal })).toBe(cloud.projectionRecoveryResult);
    expect(cloud.projectionRecoveries.map(({ acknowledgeGap, idempotencyKey, sessionPublicId }) => ({
      acknowledgeGap,
      idempotencyKey,
      sessionPublicId,
    }))).toEqual([
      { acknowledgeGap: true, idempotencyKey: command.idempotencyKey, sessionPublicId: sessionId },
      { acknowledgeGap: true, idempotencyKey: command.idempotencyKey, sessionPublicId: sessionId },
    ]);
    expect(providerMutationCalls(value.codex)).toEqual(providerWritesBefore);
  });
test("classifies absent old keys and changed-key recovery authority without opaque internal failures", async () => {
    const cloud = new FakeCloud();
    const value = await fixture(cloud);
    const { sessionId } = await createIdleSession(value, "Projection admission guidance");
    const command = {
      acknowledgeGap: true as const,
      idempotencyKey: "018bcfe5-6800-7000-8000-000000000809",
      kind: "sync.projection-recover" as const,
      session: sessionId,
    };

    cloud.projectionRecoveryError = new CloudProjectionRecoveryAdmissionError(
      "idempotency_authority_invalid",
    );
    await expect(value.service.execute(command, { signal })).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: expect.stringContaining("Omit `--idempotency-key`"),
    });

    cloud.projectionRecoveryError = new CloudProjectionRecoveryAdmissionError(
      "unsettled_session",
    );
    await expect(value.service.execute(command, { signal })).rejects.toMatchObject({
      code: "RECOVERY_REQUIRED",
      details: { nextCommand: "oompa sync status --json" },
      message: expect.stringContaining("replay the exact idempotency key"),
    });
    expect(cloud.projectionRecoveries).toEqual([]);
  });
test("durably blocks provider and metadata mutations until an unsettled recovery resolves", async () => {
    const cloud = new FakeCloud();
    const value = await fixture(cloud);
    const { sessionId } = await createIdleSession(value, "Projection durable block");
    const sessionBefore = value.store.requireSession(sessionId);
    const profile = value.store.requireProfileById(sessionBefore.profileId);
    cloud.unsettledProjectionSessions.add(sessionId);
    cloud.unsettledProjectionProfiles.add(profile.id);
    const providerWritesBefore = providerMutationCalls(value.codex);

    await expect(value.service.execute({
      idempotencyKey: "00000000-0000-4000-8000-000000000810",
      kind: "session.send",
      message: "must remain blocked",
      session: sessionId,
    }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    await expect(value.service.execute({
      kind: "session.fast",
      enabled: true,
      session: sessionId,
    }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(providerMutationCalls(value.codex)).toEqual(providerWritesBefore);
    expect(value.store.requireSession(sessionId).fastEnabled).toBe(false);
    await expect(value.service.execute({
      detail: false,
      kind: "session.show",
      session: sessionId,
    }, { signal })).resolves.toBeDefined();
    await expect(value.service.execute({
      account: profile.id,
      idempotencyKey: "00000000-0000-4000-8000-000000000812",
      kind: "account.logout",
    }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(value.store.requireProfileById(profile.id).state).toBe("signed_in");
    value.codex.listedProjections = [{
      providerThreadId: sessionBefore.providerThreadId as string,
      providerUpdatedAt: 999,
      status: "active",
      title: "must not be reconciled",
    }];
    await expect(value.service.execute({
      account: profile.id,
      kind: "session.list",
      archived: false,
      limit: 25,
    }, { signal })).resolves.toMatchObject({ recovery: { required: true } });
    const observerAuthority = liveAuthorityFor(value.store, profile.id);
    await value.service.observeCodexFact(
      observerAuthority,
      {
        name: "must not mutate the session",
        threadId: sessionBefore.providerThreadId as string,
        type: "threadNameUpdated",
      },
    );
    if (profile.providerEmail === undefined) throw new Error("Expected the signed-in profile identity.");
    // Exercise the projection-recovery fence under the same account. A
    // replacement identity has its own earlier controller-revocation fence.
    await value.service.observeCodexAccount(observerAuthority, {
      signedIn: true,
      email: profile.providerEmail,
    });
    value.codex.readProjection = {
      ...value.codex.readProjection,
      activeTurnId: "foreign-active-turn",
      providerThreadId: "foreign-provider-thread",
      status: "active",
    };
    const beforeBlockedShow = value.store.requireSession(sessionId);
    await expect(value.service.execute({
      detail: false,
      kind: "session.show",
      session: sessionId,
    }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(value.store.requireSession(sessionId)).toEqual(beforeBlockedShow);
    await value.service.observeCodexFact(observerAuthority, {
      status: { type: "systemError" },
      threadId: sessionBefore.providerThreadId as string,
      type: "threadStatusChanged",
    });
    await value.service.settled();
    expect(value.store.requireSession(sessionId)).toEqual(sessionBefore);
    expect(value.store.requireProfileById(profile.id).state).toBe("signed_in");
    expect(providerMutationCalls(value.codex)).toEqual(providerWritesBefore);
    expect(value.codex.calls.filter((call) => call === "logout")).toEqual([]);

    cloud.beforeProjectionRecoveryReturn = () => {
      cloud.unsettledProjectionSessions.delete(sessionId);
      cloud.unsettledProjectionProfiles.delete(profile.id);
      return Promise.resolve();
    };
    await expect(value.service.execute({
      acknowledgeGap: true,
      idempotencyKey: "00000000-0000-4000-8000-000000000811",
      kind: "sync.projection-recover",
      session: sessionId,
    }, { signal })).resolves.toBe(cloud.projectionRecoveryResult);
    await expect(value.service.execute({
      kind: "session.fast",
      enabled: true,
      session: sessionId,
    }, { signal })).resolves.toMatchObject({ session: { fastEnabled: true } });
  });
test("drops queue-scheduling provider facts while projection recovery preserves the session", async () => {
    const cloud = new FakeCloud();
    const value = await fixture(cloud);
    const { sessionId } = await createIdleSession(value, "Projection fact block");
    const session = value.store.requireSession(sessionId);
    const profile = value.store.requireProfileById(session.profileId);
    if (session.providerThreadId === undefined) throw new Error("Expected a bound session.");
    const pending = value.store.enqueue(session.id, "must remain behind recovery");
    cloud.unsettledProjectionSessions.add(session.id);
    cloud.unsettledProjectionProfiles.add(profile.id);
    const providerWritesBefore = providerMutationCalls(value.codex);

    await value.service.observeCodexFact(liveAuthorityFor(value.store, profile.id), {
      threadId: session.providerThreadId,
      turn: {
        completedAt: 2,
        durationMs: 1,
        id: "blocked-completion",
        items: [],
        startedAt: 1,
        status: "completed",
      },
      type: "turnCompleted",
    });
    await value.service.settled();

    expect(value.store.requireSession(session.id)).toEqual(session);
    expect(value.store.listQueue(session.id).find((entry) => entry.id === pending.id))
      .toMatchObject({ state: "pending" });
    expect(providerMutationCalls(value.codex)).toEqual(providerWritesBefore);
  });
test("drops a provider fact when its profile generation advances during the recovery-state read", async () => {
    const cloud = new FakeCloud();
    const value = await fixture(cloud);
    const { sessionId } = await createIdleSession(value, "Stale fact generation");
    const session = value.store.requireSession(sessionId);
    const profile = value.store.requireProfileById(session.profileId);
    if (session.providerThreadId === undefined) throw new Error("Expected a bound session.");
    let signalRead!: () => void;
    const readStarted = new Promise<void>((resolve) => { signalRead = resolve; });
    let releaseRead!: () => void;
    const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
    cloud.beforeProjectionUnsettledSessionReturn = async (observedSessionId) => {
      if (observedSessionId !== session.id) return;
      signalRead();
      await readGate;
    };
    const staleFact = value.service.observeCodexFact(
      liveAuthorityFor(value.store, profile.id),
      {
      threadId: session.providerThreadId,
      turn: {
        completedAt: null,
        durationMs: null,
        id: "stale-generation-turn",
        items: [],
        startedAt: 1,
        status: "inProgress",
      },
      type: "turnStarted",
      },
    );

    await readStarted;
    value.store.advanceProfileGeneration(profile.id, profile.processGeneration);
    releaseRead();
    await staleFact;

    expect(value.store.requireProfileById(profile.id).processGeneration).toBe(
      profile.processGeneration + 1,
    );
    const after = value.store.requireSession(session.id);
    expect(after.state).toBe("idle");
    expect(after.activeTurnId).toBeUndefined();
  });
test("drops a provider fact when its same-generation profile signs out during the recovery-state read", async () => {
    const cloud = new FakeCloud();
    const value = await fixture(cloud);
    const { sessionId } = await createIdleSession(value, "Signed-out fact authority");
    const session = value.store.requireSession(sessionId);
    const profile = value.store.requireProfileById(session.profileId);
    if (session.providerThreadId === undefined) throw new Error("Expected a bound session.");
    let signalRead!: () => void;
    const readStarted = new Promise<void>((resolve) => { signalRead = resolve; });
    let releaseRead!: () => void;
    const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
    cloud.beforeProjectionUnsettledSessionReturn = async (observedSessionId) => {
      if (observedSessionId !== session.id) return;
      signalRead();
      await readGate;
    };
    const staleFact = value.service.observeCodexFact(
      liveAuthorityFor(value.store, profile.id),
      {
      name: "must not apply after logout",
      threadId: session.providerThreadId,
      type: "threadNameUpdated",
      },
    );

    await readStarted;
    expect(value.store.setProfileState(profile.id, profile.processGeneration, "signed_out")).toBe(true);
    releaseRead();
    await staleFact;

    expect(value.store.requireProfileById(profile.id)).toMatchObject({
      processGeneration: profile.processGeneration,
      state: "signed_out",
    });
    expect(value.store.requireSession(session.id).title).toBe(session.title);
  });
test("provider deletion supersedes an in-flight recovery and terminalizes local authority exactly once", async () => {
    const cloud = new FakeCloud();
    const value = await fixture(cloud);
    const { sessionId } = await createIdleSession(value, "Projection deletion race");
    const session = value.store.requireSession(sessionId);
    const profile = value.store.requireProfileById(session.profileId);
    if (session.providerThreadId === undefined) throw new Error("Expected a bound recovery session.");
    const authority = liveAuthorityFor(value.store, profile.id);
    const connectionId = value.codex.observationConnectionId;
    let entered!: () => void;
    const recoveryEntered = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const recoveryGate = new Promise<void>((resolve) => { release = resolve; });
    cloud.beforeProjectionRecoveryReturn = async () => {
      entered();
      await recoveryGate;
    };
    const providerWritesBefore = providerMutationCalls(value.codex);
    const recovery = value.service.execute({
      acknowledgeGap: true,
      idempotencyKey: "018bcfe5-6800-7000-8000-000000000899",
      kind: "sync.projection-recover",
      session: sessionId,
    }, { signal });
    await recoveryEntered;

    const pendingQueue = value.store.enqueue(sessionId, "must be cancelled");
    await value.service.observeCodexFact(authority, {
      blocking: true,
      connectionId,
      display: {
        availableDecisions: ["once" as const, "decline" as const, "cancel" as const],
        commandClass: "test",
        kind: "command_approval",
        reason: null,
        summary: "Must expire on deletion",
        workingDirectory: null,
      },
      kind: "command_approval",
      provider: interactionAuthorityFor(authority, {
        approvalId: null,
        connectionId,
        itemId: "item-delete-race",
        method: "item/commandExecution/requestApproval",
        requestDigest: "9".repeat(64),
        requestId: { type: "number", value: 99 },
        threadId: session.providerThreadId,
        turnId: "turn-delete-race",
      }),
      type: "interactionRequested",
    });
    await value.service.observeCodexFact(authority, {
      ...parseFact("thread/deleted", { threadId: session.providerThreadId }),
      connectionId,
    });

    expect(value.store.requireSession(sessionId)).toMatchObject({ state: "terminal" });
    expect(value.store.requireQueue(pendingQueue.id)).toMatchObject({ state: "cancelled" });
    expect(value.store.listInteractions({ pendingOnly: true, sessionId })).toEqual([]);
    expect(cloud.providerDeletionSupersessions).toEqual([sessionId]);
    expect(providerMutationCalls(value.codex)).toEqual(providerWritesBefore);

    release();
    await expect(recovery).resolves.toMatchObject({
      phase: "rejected",
      rejectionCode: "PROVIDER_THREAD_DELETED",
      sessionPublicId: sessionId,
    });
    await value.service.observeCodexFact(authority, {
      ...parseFact("thread/deleted", { threadId: session.providerThreadId }),
      connectionId,
    });
    const terminalEvents = value.store.listSessionEvents({
      afterSequence: 0,
      sessionId,
    }).events.filter((event) =>
      event.body.type === "session_status" && event.body.status === "terminal");
    expect(terminalEvents).toHaveLength(1);
    expect(providerMutationCalls(value.codex)).toEqual(providerWritesBefore);
  });
test("reopened recovery supersedes crash-left journal authority for a terminal session", async () => {
    const value = await fixture();
    const { sessionId } = await createIdleSession(value, "Projection deletion restart");
    const session = value.store.requireSession(sessionId);
    const profile = value.store.requireProfileById(session.profileId);
    if (session.providerThreadId === undefined) throw new Error("Expected a bound recovery session.");
    const active: CloudProjectionRecoveryJournalEntry = {
      authority: { bootGeneration: 1, bootId: "boot_delete_restart_12345678", fence: 1 },
      baselineCompletedTurns: [],
      epochPublicId: "018bcfe5-6800-7000-8000-000000000892",
      expectedCompactStreamEpoch: 0,
      expectedHeadSequence: 300,
      expectedTailDigest: "a".repeat(64),
      idempotencyKey: "018bcfe5-6800-7000-8000-000000000891",
      lineageCommitment: "b".repeat(64),
      localAuthority: {
        profileGeneration: profile.processGeneration,
        profileId: profile.id,
        providerThreadId: session.providerThreadId,
        providerUpdatedAt: session.providerUpdatedAt ?? null,
        sessionRevision: session.revision,
      },
      phase: "effect_started",
      replacementCacheId: "cache_delete_restart_12345678",
      requestDigest: "c".repeat(64),
      requestedAt: 1_700_000_000_000,
      sessionPublicId: session.id,
      sourceCacheId: "cache_source_delete_restart_12345678",
      sourceDevicePublicId: "device_delete_restart_12345678",
      userPublicId: "user_delete_restart_12345678",
    };
    const journal = new MemoryCloudDaemonJournal();
    expect(await journal.compareAndSwap(null, {
      commands: [],
      pendingUsageAccount: null,
      projectionRecoveries: [active],
      projectionRecoveryReceipts: [],
      usageAccounts: [],
      version: 3,
    })).not.toBeNull();
    expect(value.store.terminalizeSessionFromProviderDeletion({
      accountId: profile.id,
      providerConnectionId: null,
      providerGeneration: profile.processGeneration,
      providerAuthority: value.store.requireProviderAccountAuthority(profile.id, "codex"),
      sessionId: session.id,
    }).changed).toBe(true);
    await value.service.close();
    const blocker = new CloudDaemonJournalRecoveryBlocker(journal, {
      isSessionTerminal: (sessionPublicId) =>
        value.store.requireSession(sessionPublicId).state === "terminal",
    });
    const reopened = new OompaService({
      cloud: new UnavailableCloudControl(blocker),
      codex: value.codex,
      daemonAuthority: new FakeDaemonAuthority(),
      paths: value.paths,
      requestStop: () => undefined,
      store: value.store,
    });
    const providerWritesBefore = providerMutationCalls(value.codex);

    await reopened.recover();
    const recovered = (await journal.read()).state;
    expect(recovered.projectionRecoveries).toEqual([]);
    expect(recovered.projectionRecoveryReceipts).toEqual([
      expect.objectContaining({
        idempotencyKey: active.idempotencyKey,
        phase: "rejected",
        rejectionCode: "PROVIDER_THREAD_DELETED",
        sessionPublicId: session.id,
      }),
    ]);
    await reopened.recover();
    expect((await journal.read()).state).toEqual(recovered);
    await expect(reopened.execute({
      acknowledgeGap: true,
      idempotencyKey: active.idempotencyKey,
      kind: "sync.projection-recover",
      session: session.id,
    }, { signal })).resolves.toEqual({
      idempotencyKey: active.idempotencyKey,
      phase: "rejected",
      rejectionCode: "PROVIDER_THREAD_DELETED",
      sessionPublicId: session.id,
    });
    expect((await journal.read()).state).toEqual(recovered);
    expect(value.store.listSessionEvents({
      afterSequence: 0,
      sessionId: session.id,
    }).events.filter((event) =>
      event.body.type === "session_status" && event.body.status === "terminal"))
      .toHaveLength(1);
    expect(providerMutationCalls(value.codex)).toEqual(providerWritesBefore);
    await reopened.close();
  });
test("reopened service keeps custody recovery blocking without cloud transport and same-key restore unblocks", async () => {
    const value = await fixture();
    const { sessionId: affectedSessionId } = await createIdleSession(value, "Projection offline restart");
    const unrelatedAccount = await value.service.execute({
      kind: "account.add",
      label: "Projection unrelated authority",
    }, { signal }) as { account: { id: string } };
    await value.service.execute({
      account: unrelatedAccount.account.id,
      deviceCode: false,
      kind: "account.login",
    }, { signal });
    const unrelatedStarted = await value.service.execute({
      account: unrelatedAccount.account.id,
      fast: false,
      kind: "session.start",
      preset: "high",
      presetContract: 2,
    }, { signal }) as { session: { id: `sess_${string}` } };
    const unrelatedSessionId = unrelatedStarted.session.id;
    const affectedSession = value.store.requireSession(affectedSessionId);
    const affectedProfile = value.store.requireProfile(affectedSession.profileId);
    const affectedAuthority = liveAuthorityFor(value.store, affectedProfile.id);
    if (affectedSession.providerThreadId === undefined) throw new Error("Expected a bound test session.");
    const idempotencyKey = "018bcfe5-6800-7000-8000-000000000881";
    const epochPublicId = "018bcfe5-6800-7000-8000-000000000882";
    const recovery: CloudProjectionRecoveryJournalEntry = {
      authority: { bootGeneration: 1, bootId: "boot_restart_12345678", fence: 1 },
      baselineCompletedTurns: [],
      epochPublicId,
      expectedCompactStreamEpoch: 0,
      expectedHeadSequence: 300,
      expectedTailDigest: "a".repeat(64),
      idempotencyKey,
      lineageCommitment: "b".repeat(64),
      localAuthority: {
        bindingGeneration: affectedAuthority.bindingGeneration,
        processGeneration: affectedAuthority.generation,
        profileId: affectedProfile.id,
        provider: affectedAuthority.provider,
        providerAccountId: affectedAuthority.providerAccountId,
        providerUpdatedAt: 10,
        providerThreadId: affectedSession.providerThreadId,
        sessionRevision: affectedSession.revision,
      },
      phase: "effect_started",
      replacementCacheId: "cache_replacement_restart_12345678",
      requestDigest: "c".repeat(64),
      requestedAt: 1_700_000_000_000,
      sessionPublicId: affectedSession.id,
      sourceDevicePublicId: "device_restart_12345678",
      sourceCacheId: "cache_source_restart_12345678",
      userPublicId: "user_restart_12345678",
    };
    const journal = new MemoryCloudDaemonJournal();
    expect(await journal.compareAndSwap(null, {
      commands: [],
      pendingUsageAccount: null,
      projectionRecoveries: [recovery],
      projectionRecoveryReceipts: [],
      usageAccounts: [],
      version: 3,
    })).not.toBeNull();
    const blocker = new CloudDaemonJournalRecoveryBlocker(journal);
    const providerWritesBefore = providerMutationCalls(value.codex);
    await value.service.close();
    const offlineDaemonGeneration = value.store.nextDaemonGeneration(
      `boot_${"8".repeat(32)}`,
    );

    const offlineAuthority = new FakeDaemonAuthority();
    const offlineService = new OompaService({
      cloud: new UnavailableCloudControl(blocker),
      codex: value.codex,
      daemonAuthority: offlineAuthority,
      daemonGeneration: offlineDaemonGeneration,
      paths: value.paths,
      requestStop: () => undefined,
      store: value.store,
    });
    await expect(offlineService.execute({
      idempotencyKey: "00000000-0000-4000-8000-000000000883",
      kind: "session.send",
      message: "must not reach the provider",
      session: affectedSessionId,
    }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    await expect(offlineService.execute({
      enabled: true,
      kind: "session.fast",
      session: affectedSessionId,
    }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    const offlineShow = await offlineService.execute({
      detail: false,
      kind: "session.show",
      session: affectedSessionId,
    }, { signal });
    expect(offlineShow).toBeDefined();
    await expect(offlineService.execute({
      enabled: true,
      kind: "session.fast",
      session: unrelatedSessionId,
    }, { signal })).resolves.toMatchObject({ session: { fastEnabled: true } });
    await expect(offlineService.execute({
      acknowledgeGap: true,
      idempotencyKey,
      kind: "sync.projection-recover",
      session: affectedSessionId,
    }, { signal })).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(providerMutationCalls(value.codex)).toEqual(providerWritesBefore);
    expect(await blocker.isCompactProjectionRecoveryUnsettled(affectedSessionId)).toBe(true);
    await offlineService.close();
    const restoredDaemonGeneration = value.store.nextDaemonGeneration(
      `boot_${"9".repeat(32)}`,
    );

    const configuredCloud = new FakeCloud();
    configuredCloud.projectionRecoveryBlocker = blocker;
    configuredCloud.beforeProjectionRecoveryReturn = async () => {
      const observed = await journal.read();
      const current = observed.state.projectionRecoveries.find((entry) =>
        entry.idempotencyKey === idempotencyKey);
      if (current === undefined || current.phase !== "effect_started") {
        throw new Error("Expected exact recovery evidence.");
      }
      const applied: CloudProjectionRecoveryJournalEntry = {
        ...current,
        cacheActivated: false,
        phase: "applied",
        response: {
          boundaryHeadSequence: current.expectedHeadSequence,
          boundaryTailDigest: current.expectedTailDigest,
          compactHasRecoveryGap: true,
          compactStreamEpoch: current.expectedCompactStreamEpoch + 1,
          epochPublicId: current.epochPublicId,
          projectionRevision: 2,
          sessionPublicId: current.sessionPublicId,
        },
      };
      const appliedState = transitionCloudProjectionRecovery(
        observed.state,
        current,
        applied,
        Date.now(),
      );
      const receipt = createCloudProjectionRecoveryTerminalReceipt(applied, {
        phase: "applied",
      });
      const committed = await journal.compareAndSwap(
        observed.generation,
        transitionCloudProjectionRecovery(appliedState, applied, receipt, Date.now()),
      );
      if (committed === null) throw new Error("Recovery journal authority changed.");
    };
    const restoredService = new OompaService({
      cloud: configuredCloud,
      codex: value.codex,
      daemonAuthority: new FakeDaemonAuthority(),
      daemonGeneration: restoredDaemonGeneration,
      paths: value.paths,
      requestStop: () => undefined,
      store: value.store,
    });
    const restoredProjection = await restoredService.execute({
      acknowledgeGap: true,
      idempotencyKey,
      kind: "sync.projection-recover",
      session: affectedSessionId,
    }, { signal });
    expect(restoredProjection).toBe(configuredCloud.projectionRecoveryResult);
    expect(configuredCloud.projectionRecoveries).toHaveLength(1);
    expect(await blocker.isCompactProjectionRecoveryUnsettled(affectedSessionId)).toBe(false);
    await expect(restoredService.execute({
      enabled: true,
      kind: "session.fast",
      session: affectedSessionId,
    }, { signal })).resolves.toMatchObject({ session: { fastEnabled: true } });
    expect(providerMutationCalls(value.codex)).toEqual(providerWritesBefore);
  });
test("rejects projection recovery before cloud dispatch for unsettled mutation and queue authority", async () => {
    for (const unsettled of ["mutation", "queue"] as const) {
      const cloud = new FakeCloud();
      const value = await fixture(cloud);
      const { sessionId } = await createIdleSession(value, `Projection ${unsettled}`);
      const session = value.store.requireSession(sessionId);
      const profile = value.store.requireProfile(session.profileId);
      if (unsettled === "mutation") {
        const attempt = value.store.prepareMutation({
          authorityGeneration: profile.processGeneration,
          authorityId: session.id,
          idempotencyKey: "00000000-0000-4000-8000-000000000804",
          kind: "session.rename",
          request: { name: "unsettled" },
        });
        expect(value.store.transitionMutation(attempt.id, "prepared", "effect_started")).toBe(true);
      } else {
        value.store.enqueue(session.id, "unsettled queue item");
      }
      const providerWritesBefore = providerMutationCalls(value.codex);

      await expect(value.service.execute({
        acknowledgeGap: true,
        idempotencyKey: unsettled === "mutation"
          ? "00000000-0000-4000-8000-000000000805"
          : "00000000-0000-4000-8000-000000000806",
        kind: "sync.projection-recover",
        session: session.id,
      }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
      expect(cloud.projectionRecoveries).toHaveLength(0);
      expect(providerMutationCalls(value.codex)).toEqual(providerWritesBefore);
    }
  });
test("rejects a projection recovery result when daemon authority becomes stale during the cloud await", async () => {
    const cloud = new FakeCloud();
    const value = await fixture(cloud);
    const { sessionId } = await createIdleSession(value, "Projection stale fence");
    const providerWritesBefore = providerMutationCalls(value.codex);
    cloud.beforeProjectionRecoveryReturn = async () => { value.daemonAuthority.invalidate(); };

    await expect(value.service.execute({
      acknowledgeGap: true,
      idempotencyKey: "00000000-0000-4000-8000-000000000807",
      kind: "sync.projection-recover",
      session: sessionId,
    }, { signal })).rejects.toBeInstanceOf(DaemonAuthoritySafetyError);
    expect(cloud.projectionRecoveries).toHaveLength(1);
    expect(providerMutationCalls(value.codex)).toEqual(providerWritesBefore);
  });
test("fences an in-flight projection recovery during shutdown and joins it", async () => {
    const cloud = new FakeCloud();
    const value = await fixture(cloud);
    const { sessionId } = await createIdleSession(value, "Projection shutdown fence");
    const providerWritesBefore = providerMutationCalls(value.codex);
    let entered!: () => void;
    const recoveryEntered = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const recoveryGate = new Promise<void>((resolve) => { release = resolve; });
    cloud.beforeProjectionRecoveryReturn = async () => {
      entered();
      await recoveryGate;
    };
    const recovery = value.service.execute({
      acknowledgeGap: true,
      idempotencyKey: "00000000-0000-4000-8000-000000000808",
      kind: "sync.projection-recover",
      session: sessionId,
    }, { signal });
    await recoveryEntered;

    const closing = value.service.close();
    release();
    await expect(recovery).rejects.toBeInstanceOf(DaemonAuthoritySafetyError);
    await expect(closing).resolves.toBeUndefined();
    expect(value.daemonAuthority.closeCalls).toBe(1);
    expect(cloud.projectionRecoveries).toHaveLength(1);
    expect(providerMutationCalls(value.codex)).toEqual(providerWritesBefore);
  });
test("keeps completion facts newer than a delayed turn-start response and continues the queue", async () => {
    const { service, codex, documents, store } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Completion race" }, { signal }) as { account: { id: string } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    await service.execute({ kind: "project.add", label: "Docs", path: documents }, { signal });
    const started = await service.execute({ kind: "session.start", account: added.account.id, preset: "high", presetContract: 2, fast: false }, { signal }) as { session: { id: `sess_${string}`; providerThreadId: string } };
    const queued = store.enqueue(started.session.id, "after completion");
    const authority = liveAuthorityFor(store, added.account.id as `acct_${string}`);
    codex.beforeStartTurnReturn = async () => {
      delete codex.beforeStartTurnReturn;
      codex.readProjection = { ...codex.readProjection, status: "idle", providerUpdatedAt: (codex.readProjection.providerUpdatedAt ?? 10) + 1 };
      delete (codex.readProjection as { activeTurnId?: string }).activeTurnId;
      await service.observeCodexFact(authority, { type: "turnCompleted", threadId: started.session.providerThreadId, turn: { id: "turn-next", items: [], status: "completed", startedAt: 1, completedAt: 2, durationMs: 1 } });
    };

    await service.execute({ kind: "session.send", session: started.session.id, message: "finishes before reply" }, { signal });
    await service.settled();
    expect(store.requireQueue(queued.id)).toMatchObject({ state: "applied" });
    expect(codex.calls.filter((call) => call === "send")).toHaveLength(2);
  });
test("treats a terminal turn-start response as idle and dispatches the next queued message", async () => {
    const { service, codex, documents, store } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Terminal response" }, { signal }) as { account: { id: string } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    await service.execute({ kind: "project.add", label: "Docs", path: documents }, { signal });
    const started = await service.execute({ kind: "session.start", account: added.account.id, preset: "high", presetContract: 2, fast: false }, { signal }) as { session: { id: `sess_${string}` } };
    const queued = store.enqueue(started.session.id, "next");
    codex.turnStatus = "completed";
    codex.beforeStartTurnReturn = async () => { delete codex.beforeStartTurnReturn; codex.turnStatus = "inProgress"; };

    expect(await service.execute({ kind: "session.send", session: started.session.id, message: "already complete" }, { signal })).toMatchObject({ turnId: "turn-next" });
    await service.settled();
    expect(store.requireQueue(queued.id)).toMatchObject({ state: "applied" });
    expect(store.requireSession(started.session.id)).toMatchObject({ state: "active", activeTurnId: "turn-next-2" });
  });
test("keeps a queued completion fact newer than its response and dispatches the following queue entry", async () => {
    const { service, codex, documents, store } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Queued completion race" }, { signal }) as { account: { id: string } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    await service.execute({ kind: "project.add", label: "Docs", path: documents }, { signal });
    const started = await service.execute({ kind: "session.start", account: added.account.id, preset: "high", presetContract: 2, fast: false }, { signal }) as { session: { id: `sess_${string}`; providerThreadId: string } };
    const first = store.enqueue(started.session.id, "first queued");
    const second = store.enqueue(started.session.id, "second queued");
    const authority = liveAuthorityFor(store, added.account.id as `acct_${string}`);
    codex.beforeStartTurnReturn = async () => {
      delete codex.beforeStartTurnReturn;
      codex.readProjection = { ...codex.readProjection, status: "idle", providerUpdatedAt: (codex.readProjection.providerUpdatedAt ?? 10) + 1 };
      delete (codex.readProjection as { activeTurnId?: string }).activeTurnId;
      await service.observeCodexFact(authority, { type: "turnCompleted", threadId: started.session.providerThreadId, turn: { id: "turn-next", items: [], status: "completed", startedAt: 1, completedAt: 2, durationMs: 1 } });
    };

    await service.recover();
    await service.settled();
    expect(store.requireQueue(first.id)).toMatchObject({ state: "applied" });
    expect(store.requireQueue(second.id)).toMatchObject({ state: "applied" });
    expect(codex.calls.filter((call) => call === "send")).toHaveLength(2);
  });
test("serializes session show with mutations so projection and runtime profile are coherent", async () => {
    const { service, codex, documents, store } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Coherent show" }, { signal }) as { account: { id: string } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    await service.execute({ kind: "project.add", label: "Docs", path: documents }, { signal });
    const started = await service.execute({ kind: "session.start", account: added.account.id, preset: "high", presetContract: 2, fast: false }, { signal }) as { session: { id: `sess_${string}` } };
    let releaseRead!: () => void;
    let markReadStarted!: () => void;
    const readStarted = new Promise<void>((resolve) => { markReadStarted = resolve; });
    const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
    codex.beforeReadSessionReturn = async () => { markReadStarted(); await readGate; };
    const show = service.execute({ kind: "session.show", session: started.session.id, detail: false }, { signal });
    await readStarted;
    delete codex.beforeReadSessionReturn;
    codex.runtimeProfileOverride = {
      ...runtimeProfile(liveAuthorityFor(store, added.account.id as `acct_${string}`)),
      observedAt: 3_000,
    };
    const send = service.execute({ kind: "session.send", session: started.session.id, message: "after read" }, { signal });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(codex.calls.filter((call) => call === "send")).toHaveLength(0);
    releaseRead();
    expect(await show).toMatchObject({ effectiveRuntimeProfile: { observedAt: 2_000 } });
    await send;
    expect(store.latestSessionRuntimeProfile(started.session.id)).toMatchObject({ revision: 2, profile: { observedAt: 3_000 } });
  });
test("dispatches the next durable queue item after a completed turn", async () => {
    const { service, codex, documents, store } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Queue" }, { signal }) as { account: { id: string } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    await service.execute({ kind: "project.add", label: "Docs", path: documents }, { signal });
    const started = await service.execute({ kind: "session.start", account: added.account.id, preset: "high", presetContract: 2, fast: false }, { signal }) as { session: { id: string; providerThreadId: string } };
    await service.execute({ kind: "session.send", session: started.session.id, message: "first" }, { signal });
    await service.execute({ kind: "session.queue", session: started.session.id, message: "second" }, { signal });
    codex.readProjection = { ...codex.readProjection, status: "idle", providerUpdatedAt: (codex.readProjection.providerUpdatedAt ?? 10) + 1 };
    delete (codex.readProjection as { activeTurnId?: string }).activeTurnId;
    await service.observeCodexFact(
      liveAuthorityFor(store, added.account.id as `acct_${string}`),
      { type: "turnCompleted", threadId: started.session.providerThreadId, turn: { id: "turn-initial", items: [], status: "completed", startedAt: 1, completedAt: 2, durationMs: 1 } },
    );
    await service.settled();
    expect(store.listQueue(started.session.id as `sess_${string}`)[0]).toMatchObject({ state: "applied" });
    expect(store.requireSession(started.session.id)).toMatchObject({ state: "active", activeTurnId: "turn-next-2" });
    expect(store.latestSessionRuntimeProfile(started.session.id)).toMatchObject({ revision: 3, sourceKind: "queue_start" });
    expect(codex.calls).toContain("send");
  });
test("continues FIFO after a determinate queued failure without overlapping dispatches", async () => {
    const { service, codex, documents, store } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Queue liveness" }, { signal }) as { account: { id: string } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    await service.execute({ kind: "project.add", label: "Docs", path: documents }, { signal });
    const started = await service.execute({ kind: "session.start", account: added.account.id, preset: "high", presetContract: 2, fast: false }, { signal }) as { session: { id: `sess_${string}`; providerThreadId: string } };
    await service.execute({ kind: "session.send", session: started.session.id, message: "active" }, { signal });
    expect(store.requireSession(started.session.id)).toMatchObject({ state: "active" });
    const first = await service.execute({ kind: "session.queue", session: started.session.id, message: "fails" }, { signal }) as { queued: { id: `queue_${string}` } };
    const second = await service.execute({ kind: "session.queue", session: started.session.id, message: "continues" }, { signal }) as { queued: { id: `queue_${string}` } };
    expect(store.requireQueue(first.queued.id)).toMatchObject({ state: "pending" });
    expect(store.requireQueue(second.queued.id)).toMatchObject({ state: "pending" });
    const authority = liveAuthorityFor(store, added.account.id as `acct_${string}`);
    codex.turnStatus = "completed";
    codex.startTurnErrorOnce = new Error("determinate rejection");
    codex.readProjection = { ...codex.readProjection, status: "idle", providerUpdatedAt: (codex.readProjection.providerUpdatedAt ?? 10) + 1 };
    delete (codex.readProjection as { activeTurnId?: string }).activeTurnId;
    codex.beforeStartTurnEffect = async () => {
      delete codex.beforeStartTurnEffect;
      await service.observeCodexFact(authority, { type: "turnCompleted", threadId: started.session.providerThreadId, turn: { id: "competing-fact", items: [], status: "completed", startedAt: 1, completedAt: 2, durationMs: 1 } });
      await Bun.sleep(0);
    };

    await service.observeCodexFact(authority, { type: "turnCompleted", threadId: started.session.providerThreadId, turn: { id: "active-turn", items: [], status: "completed", startedAt: 1, completedAt: 2, durationMs: 1 } });
    await service.settled();

    expect(store.requireQueue(first.queued.id)).toMatchObject({ state: "failed" });
    expect(store.requireQueue(second.queued.id)).toMatchObject({ state: "applied" });
    expect(codex.maximumConcurrentStartTurns).toBe(1);
    expect(codex.calls.filter((call) => call === "send")).toHaveLength(3);
  });
test("dispatches a stranded imported queue when a project is assigned", async () => {
    const { service, codex, documents, store } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Imported project" }, { signal }) as { account: { id: `acct_${string}` } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    const project = await service.execute({ kind: "project.add", label: "Docs", path: documents }, { signal }) as { project: { id: string } };
    const imported = store.upsertProviderSession({
      providerAuthority: store.requireProviderAccountAuthority(added.account.id, "codex"),
      profileId: added.account.id,
      provider: "codex",
      providerThreadId: "provider-thread",
      preset: "high",
      fastEnabled: false,
      title: "Imported without project",
      state: "idle",
      providerUpdatedAt: 10,
      providerAccountKey: codexProviderAccountKey(),
    });
    const queued = await service.execute({ kind: "session.queue", session: imported.id, message: "run after project" }, { signal }) as { queued: { id: `queue_${string}` } };
    await service.settled();
    expect(store.requireQueue(queued.queued.id)).toMatchObject({ state: "pending" });
    expect(codex.calls.filter((call) => call === "send")).toHaveLength(0);

    await service.execute({ kind: "session.project", session: imported.id, project: project.project.id }, { signal });
    await service.settled();
    expect(store.requireQueue(queued.queued.id)).toMatchObject({ state: "applied" });
    expect(codex.calls.filter((call) => call === "send")).toHaveLength(1);
    expect(codex.turnReviewRequests.at(-1)?.requirement).toEqual({
      model: "gpt-6-astra",
      effort: "max",
    });
    expect(store.latestSessionRuntimeProfile(imported.id)?.profile).toMatchObject({
      preset: "high",
      model: "gpt-6-astra",
      reasoningEffort: "max",
    });
  });
test("sends an imported session with its legacy exact preset requirement", async () => {
    const { service, codex, documents, store } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Imported send" }, { signal }) as { account: { id: `acct_${string}` } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    await service.execute({ kind: "project.add", label: "Imported send docs", path: documents }, { signal });
    const project = store.listProjects()[0];
    if (project === undefined) throw new Error("Expected the imported session project.");
    const imported = store.upsertProviderSession({
      providerAuthority: store.requireProviderAccountAuthority(added.account.id, "codex"),
      projectId: project.id,
      profileId: added.account.id,
      provider: "codex",
      providerThreadId: "provider-thread-imported-send",
      providerAccountKey: codexProviderAccountKey(),
      preset: "high",
      fastEnabled: false,
      title: "Imported send",
      state: "idle",
      providerUpdatedAt: 10,
    });
    codex.readProjection = {
      ...codex.readProjection,
      providerThreadId: "provider-thread-imported-send",
    };
    codex.turnStatus = "completed";

    await service.execute({
      kind: "session.send",
      session: imported.id,
      message: "keep the admitted model",
    }, { signal });

    expect(codex.turnReviewRequests.at(-1)?.requirement).toEqual({
      model: "gpt-6-astra",
      effort: "max",
    });
    expect(store.latestSessionRuntimeProfile(imported.id)?.profile).toMatchObject({
      preset: "high",
      model: "gpt-6-astra",
      reasoningEffort: "max",
    });
  });
test.each(["baseline", "capability"] as const)(
    "retries bounded pre-evidence baseline and capability failures without replaying a provider effect (%s)",
    (failure) => ownedServiceCase(async ({ createFixture, signal }) => {
      const { service, codex, documents, store } = await createFixture();
      signal.throwIfAborted();
      const added = await service.execute({ kind: "account.add", label: `Transient ${failure}` }, { signal }) as { account: { id: string } };
      await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
      await service.execute({ kind: "project.add", label: "Docs", path: documents }, { signal });
      const started = await service.execute({ kind: "session.start", account: added.account.id, preset: "high", presetContract: 2, fast: false }, { signal }) as { session: { id: `sess_${string}` } };
      if (failure === "baseline") codex.readSessionErrorOnce = new Error("transient baseline read");
      else codex.reviewTurnErrorOnce = new Error("transient capability read");

      const queued = await service.execute({ kind: "session.queue", session: started.session.id, message: `retry ${failure}` }, { signal }) as { queued: { id: `queue_${string}` } };
      await service.settled();

      expect(store.requireQueue(queued.queued.id)).toMatchObject({ state: "applied" });
      expect(store.readQueueEffect(queued.queued.id)).toMatchObject({ evidence: { queueId: queued.queued.id } });
      expect(codex.calls.filter((call) => call === "send")).toHaveLength(1);
      expect(codex.maximumConcurrentStartTurns).toBe(1);
    }),
  );
describe("maps bounded Codex failures to phase-specific safe guidance before dispatch", () => {
    const failures = [
      {
        code: "HOME_MISMATCH",
        reason: "codex_home_mismatch",
        message: "The Codex home does not match this account's isolated runtime. Run `oompa doctor --json` and repair the reported configuration before retrying.",
      },
      {
        code: "PROCESS_EXITED",
        reason: "codex_process_exited",
        message: "The pinned Codex process exited before the operation finished. Inspect daemon status before starting a fresh attempt.",
      },
      {
        code: "PROTOCOL_ERROR",
        reason: "codex_protocol_error",
        message: "Codex returned data that violates Oompa's pinned protocol. Run `oompa doctor --json` and repair or update Oompa before retrying.",
      },
      {
        code: "PROTOCOL_LIMIT",
        reason: "codex_protocol_limit",
        message: "Codex data exceeded Oompa's bounded protocol limits. Narrow the request where possible or update Oompa before trying again.",
      },
      {
        code: "REMOTE_ERROR",
        reason: "codex_remote_rejected",
        message: "Codex rejected the provider request. That request has settled; inspect current state before deciding whether a fresh attempt is appropriate.",
      },
      {
        code: "RUNTIME_MISMATCH",
        reason: "codex_runtime_mismatch",
        message: "Oompa's pinned Codex runtime is missing or incompatible. Run `oompa doctor --json` and repair or reinstall Oompa before retrying.",
      },
      {
        code: "TIMEOUT",
        reason: "codex_timeout",
        message: "Codex did not complete the operation within Oompa's bounded deadline. Inspect current state before deciding whether to start a fresh attempt.",
      },
      {
        code: "UNSUPPORTED_CAPABILITY",
        reason: "codex_capability_unsupported",
        message: "The pinned Codex runtime does not support a capability required for this operation. Run `oompa doctor --json` and update or reconfigure Oompa before retrying.",
      },
    ] as const;
    for (const [index, failure] of failures.entries()) {
      test(failure.code, async () => {
        const { execute, codex, documents, store } = await ownedServiceFixture();
        const added = await execute({ kind: "account.add", label: `Unavailable ${failure.code}` }) as { account: { id: string } };
        await execute({ kind: "account.login", account: added.account.id, deviceCode: false });
        await execute({ kind: "project.add", label: "Docs", path: documents });
        const started = await execute({ kind: "session.start", account: added.account.id, preset: "high", presetContract: 2, fast: false }) as { session: { id: `sess_${string}` } };
        const idempotencyKey = `00000000-0000-4000-8000-${String(730 + index).padStart(12, "0")}`;
        codex.reviewTurnErrorOnce = new CodexError(failure.code, "private provider capability diagnostic");

        await expect(execute({
          kind: "session.send",
          session: started.session.id,
          message: "must not dispatch",
          idempotencyKey,
        })).rejects.toMatchObject({
          code: "UNAVAILABLE",
          details: { reason: failure.reason },
          message: failure.message,
        });

        expect(codex.calls.filter((call) => call === "send")).toHaveLength(0);
        expect(store.readMutation(idempotencyKey)).toMatchObject({ state: "prepared" });
        expect(JSON.stringify(store.readMutation(idempotencyKey))).not.toContain("private provider capability diagnostic");
      });
    }
  });
test("records a dispatched remote rejection as failed and never describes it as unsettled", async () => {
    const { service, codex, documents, store } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Remote rejection" }, { signal }) as { account: { id: string } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    await service.execute({ kind: "project.add", label: "Docs", path: documents }, { signal });
    const started = await service.execute({ kind: "session.start", account: added.account.id, preset: "high", presetContract: 2, fast: false }, { signal }) as { session: { id: `sess_${string}` } };
    const idempotencyKey = "00000000-0000-4000-8000-000000000799";
    codex.startTurnErrorOnce = new CodexRemoteError(-32_600, "private provider rejection diagnostic");

    const command = {
      kind: "session.send" as const,
      session: started.session.id,
      message: "settled rejection",
      idempotencyKey,
    };
    await expect(service.execute(command, { signal })).rejects.toMatchObject({
      code: "UNAVAILABLE",
      details: { reason: "codex_remote_rejected", requestState: "settled" },
      message: "Codex rejected the provider request. That request has settled; inspect current state before deciding whether a fresh attempt is appropriate.",
    });
    expect(store.readMutation(idempotencyKey)).toMatchObject({ state: "failed" });
    expect(JSON.stringify(store.readMutation(idempotencyKey))).not.toContain("private provider rejection diagnostic");
    await expect(service.execute(command, { signal })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(codex.calls.filter((call) => call === "send")).toHaveLength(1);
  });
test("bounds persistent pre-evidence retries and permits an explicit project trigger", async () => {
    const { service, codex, documents, store } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Bounded retry" }, { signal }) as { account: { id: string } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    const project = await service.execute({ kind: "project.add", label: "Docs", path: documents }, { signal }) as { project: { id: string } };
    const started = await service.execute({ kind: "session.start", account: added.account.id, preset: "high", presetContract: 2, fast: false }, { signal }) as { session: { id: `sess_${string}` } };
    codex.beforeReadSessionReturn = async () => { throw new Error("persistent baseline failure"); };

    const queued = await service.execute({ kind: "session.queue", session: started.session.id, message: "bounded retry" }, { signal }) as { queued: { id: `queue_${string}` } };
    await service.settled();
    expect(store.requireQueue(queued.queued.id)).toMatchObject({ state: "pending" });
    expect(codex.calls.filter((call) => call === "read")).toHaveLength(4);
    expect(codex.calls.filter((call) => call === "send")).toHaveLength(0);

    delete codex.beforeReadSessionReturn;
    await service.execute({ kind: "session.project", session: started.session.id, project: project.project.id }, { signal });
    await service.settled();
    expect(store.requireQueue(queued.queued.id)).toMatchObject({ state: "applied" });
    expect(codex.calls.filter((call) => call === "send")).toHaveLength(1);
  });
test("canonicalizes selector aliases before serializing one session authority", async () => {
    const { service, codex, documents } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Canonical" }, { signal }) as { account: { id: string } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    await service.execute({ kind: "project.add", label: "Docs", path: documents }, { signal });
    const started = await service.execute({ kind: "session.start", account: added.account.id, preset: "high", presetContract: 2, fast: false }, { signal }) as { session: { id: string; title: string } };
    const results = await Promise.allSettled([
      service.execute({ kind: "session.send", session: started.session.id, message: "one" }, { signal }),
      service.execute({ kind: "session.send", session: started.session.title, message: "two" }, { signal }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(codex.calls.filter((call) => call === "send")).toHaveLength(1);
  });
test("revalidates remote session authority inside the account and session locks", async () => {
    const { service, codex, documents, store } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Remote authority" }, { signal }) as { account: { id: string } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    await service.execute({ kind: "project.add", label: "Docs", path: documents }, { signal });
    const started = await service.execute({ kind: "session.start", account: added.account.id, preset: "high", presetContract: 2, fast: false }, { signal }) as { session: { id: `sess_${string}` } };
    const session = store.requireSession(started.session.id);
    const profile = store.requireProfile(session.profileId);
    if (session.providerThreadId === undefined) throw new Error("The provider binding is missing.");
    let logoutEntered!: () => void;
    const entered = new Promise<void>((resolve) => { logoutEntered = resolve; });
    let releaseLogout!: () => void;
    const logoutGate = new Promise<void>((resolve) => { releaseLogout = resolve; });
    codex.beforeLogoutReturn = async () => {
      logoutEntered();
      await logoutGate;
    };
    const logout = service.execute({ kind: "account.logout", account: profile.id, idempotencyKey: "00000000-0000-4000-8000-000000000701" }, { signal });
    await entered;
    const remote = service.executeRemote(
      { kind: "session.send", session: session.id, message: "must remain fenced", idempotencyKey: "00000000-0000-4000-8000-000000000702" },
      remoteAuthorityFor(store, session.id),
      { signal },
    );
    releaseLogout();
    await logout;
    await expect(remote).rejects.toMatchObject({ code: "INTERACTION_REQUIRED" });
    expect(codex.calls.filter((call) => call === "send")).toHaveLength(0);
  });
test("serializes remote Fast behind an exact provider turn commit", async () => {
    const { service, codex, documents, store } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Remote metadata" }, { signal }) as { account: { id: string } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    await service.execute({ kind: "project.add", label: "Docs", path: documents }, { signal });
    const started = await service.execute({ kind: "session.start", account: added.account.id, preset: "high", presetContract: 2, fast: false }, { signal }) as { session: { id: `sess_${string}`; providerThreadId: string } };
    const session = store.requireSession(started.session.id);
    if (session.providerThreadId === undefined) throw new Error("The provider binding is missing.");
    let entered!: () => void;
    const providerVisible = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    codex.beforeStartTurnReturn = async () => { entered(); await gate; };
    const send = service.execute({
      kind: "session.send",
      session: session.id,
      message: "provider visible first",
      idempotencyKey: "00000000-0000-4000-8000-000000000711",
    }, { signal });
    await providerVisible;
    let remoteSettled = false;
    const remote = service.executeRemote({
      enabled: true,
      idempotencyKey: "00000000-0000-4000-8000-000000000712",
      kind: "session.fast",
      session: session.id,
    }, remoteAuthorityFor(store, session.id), { signal }).finally(() => { remoteSettled = true; });
    await Bun.sleep(0);
    expect(remoteSettled).toBe(false);
    expect(store.requireSession(session.id).fastEnabled).toBe(false);
    release();
    await send;
    await remote;
    expect(store.readMutation("00000000-0000-4000-8000-000000000711")).toMatchObject({ state: "applied" });
    expect(store.requireSession(session.id)).toMatchObject({ fastEnabled: true, state: "active" });
  });
test("rechecks the daemon fence after a remote metadata command waits for its session lock", async () => {
    const { service, codex, daemonAuthority, documents, store } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Remote fence" }, { signal }) as { account: { id: string } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    await service.execute({ kind: "project.add", label: "Docs", path: documents }, { signal });
    const started = await service.execute({ kind: "session.start", account: added.account.id, preset: "high", presetContract: 2, fast: false }, { signal }) as { session: { id: `sess_${string}`; providerThreadId: string } };
    const session = store.requireSession(started.session.id);
    if (session.providerThreadId === undefined) throw new Error("The provider binding is missing.");
    let entered!: () => void;
    const providerVisible = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    codex.beforeStartTurnReturn = async () => { entered(); await gate; };
    const send = service.execute({ kind: "session.send", session: session.id, message: "hold", idempotencyKey: "00000000-0000-4000-8000-000000000713" }, { signal })
      .then(() => null, (error: unknown) => error);
    await providerVisible;
    const remote = service.executeRemote({
      kind: "session.preset",
      preset: "ultra",
      session: session.id,
    }, remoteAuthorityFor(store, session.id), { signal }).then(() => null, (error: unknown) => error);
    await Bun.sleep(0);
    daemonAuthority.invalidate();
    release();
    expect(await send).toBeInstanceOf(DaemonAuthoritySafetyError);
    expect(await remote).toBeInstanceOf(DaemonAuthoritySafetyError);
    expect(store.requireSession(session.id).preset).toBe("high");
  });
test("replays an applied login without advancing the profile generation or persisting its one-time code", async () => {
    const { service, codex, store } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Login replay" }, { signal }) as { account: { id: string } };
    const idempotencyKey = "00000000-0000-4000-8000-000000000101";
    codex.loginResult = { status: "pending", loginId: "provider-login-1", verificationUrl: "https://example.test/device?secret=1", userCode: "ABCD-EFGH" };
    const first = await service.execute({ kind: "account.login", account: added.account.id, deviceCode: true, idempotencyKey }, { signal }) as { login: { userCode?: string }; account: { processGeneration: number } };
    const replay = await service.execute({ kind: "account.login", account: added.account.id, deviceCode: true, idempotencyKey }, { signal }) as { login: { status: string; loginId?: string; next?: string; userCode?: string; verificationUrl?: string }; account: { processGeneration: number } };
    expect(first.login.userCode).toBe("ABCD-EFGH");
    expect(replay.login).toEqual({
      status: "pending",
      loginId: "provider-login-1",
      next: `oompa account login-cancel ${added.account.id}`,
    });
    expect(replay.account.processGeneration).toBe(1);
    expect(codex.calls.filter((call) => call.startsWith("login:"))).toHaveLength(1);
    expect(JSON.stringify(store.readMutation(idempotencyKey)?.result)).not.toContain("ABCD-EFGH");
    expect(JSON.stringify(store.readMutation(idempotencyKey)?.result)).not.toContain("secret=1");
  });
test("an explicitly keyed login on a signed-in account has no authority or session effect", async () => {
    const value = await fixture();
    const { sessionId } = await createIdleSession(value, "Already linked");
    const beforeSession = value.store.requireSession(sessionId);
    const beforeProfile = value.store.requireProfileById(beforeSession.profileId);
    const loginCalls = value.codex.calls.filter((call) => call.startsWith("login:")).length;
    const idempotencyKey = "00000000-0000-4000-8000-000000000119";

    await expect(value.service.execute({
      kind: "account.login",
      account: beforeProfile.id,
      deviceCode: true,
      idempotencyKey,
    }, { signal })).resolves.toMatchObject({
      account: {
        id: beforeProfile.id,
        processGeneration: beforeProfile.processGeneration,
        state: "signed_in",
      },
      login: { status: "signed_in" },
    });

    expect(value.store.requireProfileById(beforeProfile.id)).toEqual(beforeProfile);
    expect(value.store.requireSession(sessionId)).toEqual(beforeSession);
    expect(value.store.readMutation(idempotencyKey)).toBeNull();
    expect(value.codex.calls.filter((call) => call.startsWith("login:"))).toHaveLength(loginCalls);
  });
test("returns terminal signed-in evidence when replaying a formerly pending login after provider completion", async () => {
    const { service, codex, store } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Completed login replay" }, { signal }) as { account: { id: `acct_${string}` } };
    const idempotencyKey = "00000000-0000-4000-8000-000000000120";
    codex.loginResult = {
      status: "pending",
      loginId: "provider-login-completed",
      verificationUrl: "https://example.test/device?secret=completed",
      userCode: "DONE-CODE",
    };
    await service.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: true,
      idempotencyKey,
    }, { signal });

    await service.observeCodexAccount(liveAuthorityFor(store, added.account.id), {
      signedIn: true,
      email: "completed@example.com",
      plan: "Plus",
    });
    await expect(service.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: false,
      idempotencyKey,
    }, { signal })).rejects.toThrow("IDEMPOTENCY_CONFLICT");
    const replay = await service.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: true,
      idempotencyKey,
    }, { signal });

    expect(replay).toMatchObject({
      account: {
        id: added.account.id,
        processGeneration: 1,
        providerEmail: "completed@example.com",
        providerPlan: "Plus",
        state: "signed_in",
      },
      idempotencyKey,
      login: {
        account: {
          email: "completed@example.com",
          plan: "Plus",
          signedIn: true,
        },
        status: "signed_in",
      },
    });
    expect((replay as { login: unknown }).login).toEqual({
      account: {
        email: "completed@example.com",
        plan: "Plus",
        signedIn: true,
      },
      status: "signed_in",
    });
    expect(codex.calls.filter((call) => call.startsWith("login:"))).toHaveLength(1);
    expect(JSON.stringify(replay)).not.toContain("DONE-CODE");
    expect(JSON.stringify(replay)).not.toContain("secret=completed");
    expect(store.readMutation(idempotencyKey)).toMatchObject({
      authorityGeneration: 1,
      authorityId: added.account.id,
      state: "applied",
    });
  });
test("returns a typed signed-out settlement when replaying a canceled pending login", async () => {
    const { service, codex, store } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Canceled login replay" }, { signal }) as { account: { id: `acct_${string}` } };
    const idempotencyKey = "00000000-0000-4000-8000-000000000121";
    codex.loginResult = {
      status: "pending",
      loginId: "provider-login-canceled",
      verificationUrl: "https://example.test/device?secret=canceled",
      userCode: "STOP-CODE",
    };
    await service.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: true,
      idempotencyKey,
    }, { signal });
    codex.accountProjection = { signedIn: false };
    codex.cancelLoginResult = { status: "canceled" };
    await expect(service.execute({
      kind: "account.login-cancel",
      account: added.account.id,
    }, { signal })).resolves.toMatchObject({
      account: { processGeneration: 1, state: "signed_out" },
      loginId: "provider-login-canceled",
      providerStatus: "canceled",
      status: "canceled",
    });

    const replay = await service.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: true,
      idempotencyKey,
    }, { signal });
    expect(replay).toEqual({
      account: expect.objectContaining({
        id: added.account.id,
        processGeneration: 1,
        state: "signed_out",
      }),
      idempotencyKey,
      login: { outcome: "signed_out", status: "settled" },
    });
    expect(codex.calls.filter((call) => call.startsWith("login:"))).toHaveLength(1);
    expect(codex.calls.filter((call) => call.startsWith("login-cancel:"))).toHaveLength(1);
    expect(JSON.stringify(replay)).not.toContain("STOP-CODE");
    expect(JSON.stringify(replay)).not.toContain("secret=canceled");
    expect(store.readPendingLoginAuthority(added.account.id, 1)).toBeNull();
  });
test("records the login cancellation before dispatch and replays it under the same key without another provider call", async () => {
    const { service, codex, store } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Ledgered cancel" }, { signal }) as { account: { id: `acct_${string}` } };
    codex.loginResult = { status: "pending", loginId: "provider-login-ledger" };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    codex.accountProjection = { signedIn: false };
    codex.cancelLoginResult = { status: "canceled" };
    const idempotencyKey = "00000000-0000-4000-8000-000000000131";
    let recordedBeforeDispatch: unknown;
    codex.beforeCancelLoginReturn = async () => {
      recordedBeforeDispatch = store.readMutation(idempotencyKey);
    };
    const first = await service.execute({
      kind: "account.login-cancel",
      account: added.account.id,
      idempotencyKey,
    }, { signal });
    expect(recordedBeforeDispatch).toMatchObject({
      kind: "account.login-cancel",
      authorityId: added.account.id,
      authorityGeneration: 1,
      state: "effect_started",
    });
    expect(first).toMatchObject({
      account: { processGeneration: 1, state: "signed_out" },
      loginId: "provider-login-ledger",
      providerStatus: "canceled",
      status: "canceled",
      idempotencyKey,
    });
    expect(store.readMutation(idempotencyKey)).toMatchObject({
      state: "applied",
      result: { loginId: "provider-login-ledger", providerStatus: "canceled", provider: { signedIn: false } },
    });
    expect(store.readPendingLoginAuthority(added.account.id, 1)).toBeNull();
    const cancelCalls = codex.calls.filter((call) => call.startsWith("login-cancel:")).length;
    const readCalls = codex.calls.filter((call) => call === "readAccount").length;

    const replay = await service.execute({
      kind: "account.login-cancel",
      account: added.account.id,
      idempotencyKey,
    }, { signal });
    expect(replay).toEqual(first);
    expect(codex.calls.filter((call) => call.startsWith("login-cancel:"))).toHaveLength(cancelCalls);
    expect(codex.calls.filter((call) => call === "readAccount")).toHaveLength(readCalls);
    expect(cancelCalls).toBe(1);

    const other = await service.execute({ kind: "account.add", label: "Other authority" }, { signal }) as { account: { id: `acct_${string}` } };
    await expect(service.execute({
      kind: "account.login-cancel",
      account: other.account.id,
      idempotencyKey,
    }, { signal })).rejects.toMatchObject({ code: "CONFLICT" });
  });
test("resolves an indeterminate login cancellation from an exact account read and admits a fresh cancellation", async () => {
    const { service, codex, store } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Indeterminate cancel" }, { signal }) as { account: { id: `acct_${string}` } };
    codex.loginResult = { status: "pending", loginId: "provider-login-indeterminate" };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    codex.accountProjection = { signedIn: false };
    codex.beforeCancelLoginReturn = async () => {
      throw new IndeterminateCodexEffectError("account/cancelLogin", 7);
    };
    const firstKey = "00000000-0000-4000-8000-000000000132";
    const secondKey = "00000000-0000-4000-8000-000000000133";
    await expect(service.execute({
      kind: "account.login-cancel",
      account: added.account.id,
      idempotencyKey: firstKey,
    }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(store.readMutation(firstKey)).toMatchObject({ state: "ambiguous", kind: "account.login-cancel" });
    expect(store.requireProfile(added.account.id)).toMatchObject({ processGeneration: 1, state: "login_pending" });

    codex.beforeCancelLoginReturn = undefined;
    codex.cancelLoginResult = { status: "not_found" };
    await expect(service.execute({
      kind: "account.login-cancel",
      account: added.account.id,
      idempotencyKey: secondKey,
    }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(codex.calls.filter((call) => call.startsWith("login-cancel:"))).toHaveLength(1);
    expect(store.readMutation(secondKey)).toBeNull();

    const shown = await service.execute({ kind: "account.show", account: added.account.id }, { signal });
    expect(shown).toMatchObject({
      account: { state: "login_pending" },
      login: { status: "pending", loginId: "provider-login-indeterminate" },
    });
    expect(store.readMutation(firstKey)).toMatchObject({
      state: "reconciled",
      originalState: "ambiguous",
      resolution: { kind: "provider_state_reconciled", evidence: { source: "account/read", signedIn: false } },
    });
    expect(store.listUnsettledMutations({ authorityId: added.account.id })).toEqual([]);

    await expect(service.execute({
      kind: "account.login-cancel",
      account: added.account.id,
      idempotencyKey: secondKey,
    }, { signal })).resolves.toMatchObject({
      account: { state: "signed_out" },
      providerStatus: "not_found",
      status: "canceled",
    });
    expect(codex.calls.filter((call) => call.startsWith("login-cancel:"))).toHaveLength(2);
    await expect(service.execute({
      kind: "account.login-cancel",
      account: added.account.id,
      idempotencyKey: firstKey,
    }, { signal })).resolves.toMatchObject({ status: "already_settled" });
    expect(codex.calls.filter((call) => call.startsWith("login-cancel:"))).toHaveLength(2);
  });
test.each(["missing_primary", "wrong_provenance", "second_owner", "extra_binding", "missing_login_successor"] as const)(
    "account recovery refuses %s without settling an uncertain cancellation",
    async (damage) => {
      const { service, codex, store, paths } = await fixture();
      const profile = store.createProfile(`Recovery ${damage}`);
      codex.loginResult = { status: "pending", loginId: "recovery-proof-login" };
      await service.execute({ kind: "account.login", account: profile.id, deviceCode: false }, { signal });
      codex.accountProjection = { signedIn: false };
      codex.beforeCancelLoginReturn = async () => {
        throw new IndeterminateCodexEffectError("account/cancelLogin", 71);
      };
      const key = "00000000-0000-4000-8000-000000000138";
      const second = damage === "second_owner" ? store.prepareMutation({
        kind: "account.login-cancel", authorityId: profile.id,
        authorityGeneration: 1, request: { loginId: "recovery-proof-login" },
        idempotencyKey: "00000000-0000-4000-8000-000000000139",
      }) : null;
      await expect(service.execute({ kind: "account.login-cancel", account: profile.id, idempotencyKey: key }, { signal }))
        .rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
      const attempt = store.readMutation(key);
      if (attempt === null) throw new Error("Missing cancellation fixture.");
      if (damage === "second_owner") {
        if (second === null) throw new Error("Missing second owner fixture.");
        store.beginLoginCancelMutationEffect({ attemptId: second.id, profileId: profile.id,
          processGeneration: 1, loginId: "recovery-proof-login",
          providerAuthority: store.requireProviderAccountAuthority(profile.id, "codex") });
      } else if (damage === "missing_login_successor") {
        store.nextDaemonGeneration(`boot_${"6".repeat(32)}`);
        const database = new Database(paths.database);
        try {
          const name = "session_mutation_authority_rebinds_v39_immutable_delete";
          const guard = database.query("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(name) as { sql: string };
          database.exec(`DROP TRIGGER ${name}`);
          try {
            expect(database.query("DELETE FROM session_mutation_authority_rebinds_v39 WHERE profile_id=? AND provider='codex'").run(profile.id).changes).toBe(1);
          } finally { database.exec(guard.sql); }
        } finally { database.close(false); }
      } else if (damage === "extra_binding") {
        // A same-process replacement followed by quarantine is two binding
        // changes, not the one admitted recovery transition.
        store.setProfileState(profile.id, 1, "login_pending", { email: "replacement@example.com" });
        store.setProfileState(profile.id, 1, "recovery_required");
      } else {
        const database = new Database(paths.database);
        try {
          const name = damage === "missing_primary"
            ? "mutation_provider_authorities_immutable_delete"
            : "mutation_provider_authorities_immutable_update";
          const guard = database.query("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(name) as { sql: string };
          database.exec(`DROP TRIGGER ${name}`);
          try {
            if (damage === "missing_primary") database.query("DELETE FROM mutation_provider_authorities WHERE attempt_id=?").run(attempt.id);
            else database.query("UPDATE mutation_provider_authorities SET provenance='account_logout' WHERE attempt_id=?").run(attempt.id);
          } finally { database.exec(guard.sql); }
        } finally { database.close(false); }
      }
      const before = store.listUnsettledMutations({ authorityId: profile.id });
      const captured = store.readMutationProviderAuthorities(attempt.id);
      const profileBefore = store.requireProfile(profile.id);
      const calls = codex.calls.length;
      await expect(service.execute({ kind: "account.show", account: profile.id }, { signal }))
        .rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
      expect(store.listUnsettledMutations({ authorityId: profile.id })).toEqual(before);
      expect(store.readMutationProviderAuthorities(attempt.id)).toEqual(captured);
      expect(store.requireProfile(profile.id)).toEqual(profileBefore);
      expect(codex.calls.slice(calls)).toEqual(["readAccount"]);
      const current = store.requireProviderAccountAuthority(profile.id, "codex");
      expect(() => store.resolveLoginCancelMutation({ attemptId: attempt.id, expectedOriginalState: "ambiguous",
        expectedProviderAuthority: current, provider: { signedIn: false } })).toThrow();
      expect(() => store.reconcileProfileRecoveryFromAccountRead({ profileId: profile.id,
        expectedGeneration: current.processGeneration, expectedProviderAuthority: current,
        provider: { signedIn: false } })).toThrow();
      expect(store.listUnsettledMutations({ authorityId: profile.id })).toEqual(before);
      expect(store.requireProfile(profile.id)).toEqual(profileBefore);
    },
  );
test.each(["binding", "identity", "process"] as const)(
    "account recovery rejects a captured %s race after the provider read",
    async (changedPart) => {
      const { service, codex, store } = await fixture();
      const profile = store.createProfile(`Read race ${changedPart}`);
      codex.loginResult = { status: "pending", loginId: "raced-recovery-login" };
      await service.execute({ kind: "account.login", account: profile.id, deviceCode: false }, { signal });
      codex.accountProjection = { signedIn: false };
      codex.beforeCancelLoginReturn = async () => { throw new IndeterminateCodexEffectError("account/cancelLogin", 72); };
      const key = "00000000-0000-4000-8000-000000000140";
      await expect(service.execute({ kind: "account.login-cancel", account: profile.id, idempotencyKey: key }, { signal }))
        .rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
      const attempt = store.readMutation(key);
      if (attempt === null) throw new Error("Missing read race fixture.");
      const frozen = store.readMutationProviderAuthorities(attempt.id);
      const captured = store.requireProviderAccountAuthority(profile.id, "codex");
      let changedProfile = store.requireProfile(profile.id);
      codex.beforeReadAccountReturn = async () => {
        if (changedPart === "process") store.nextProfileGeneration(profile.id);
        else store.setProfileState(profile.id, 1, changedPart === "binding" ? "recovery_required" : "login_pending",
          changedPart === "identity" ? { email: "changed-during-read@example.com" } : undefined);
        changedProfile = store.requireProfile(profile.id);
      };
      const calls = codex.calls.length;
      await expect(service.execute({ kind: "account.show", account: profile.id }, { signal }))
        .rejects.toMatchObject({ code: "CONFLICT" });
      expect(store.readMutation(key)).toEqual(attempt);
      expect(store.readMutationProviderAuthorities(attempt.id)).toEqual(frozen);
      expect(store.requireProfile(profile.id)).toEqual(changedProfile);
      expect(codex.calls.slice(calls)).toEqual(["readAccount"]);
      expect(() => store.resolveLoginCancelMutation({ attemptId: attempt.id,
        expectedOriginalState: "ambiguous", expectedProviderAuthority: captured,
        provider: { signedIn: false } })).toThrow();
      expect(store.readMutation(key)).toEqual(attempt);
    },
  );
test.each(["binding", "retired_controller"] as const)(
    "account recovery refuses a pre-read %s change during the cloud check",
    async (changedPart) => {
      const value = await fixture();
      const { service, codex, cloud, store, paths } = value;
      const profile = store.createProfile(`Pre-read race ${changedPart}`);
      await service.execute({ kind: "account.login", account: profile.id, deviceCode: false }, { signal });
      const frozen = store.requireProviderAccountAuthority(profile.id, "codex");
      const unused = (): never => { throw new Error("No Work capability expected."); };
      const work = store.createWorkStore(value.daemonGeneration, unused, { issue: unused, verify: unused });
      cloud.beforeProjectionUnsettledProfileReturn = async () => {
        if (changedPart === "binding") store.setProfileState(profile.id, 1, "recovery_required", { email: "person@example.com" });
        else {
          const started = store.beginProviderRuntimeAccountRevocation({ profileId: profile.id,
            expectedGeneration: 1, provider: "codex", runtimeScope: "managed", currentAccountKey: null, workStore: work });
          expect(started.sessionIds).toEqual([]);
          await codex.releaseOwnedAuthority({ authority: liveAuthorityFor(store, profile.id, "codex", profilePaths(paths, profile.id)), signal });
          store.completeProviderRuntimeAccountRevocation({ profileId: profile.id, expectedGeneration: 1,
            provider: "codex", runtimeScope: "managed", expectedRevision: started.revocation.revision });
        }
      };
      const calls = codex.calls.length;
      await expect(service.execute({ kind: "account.show", account: profile.id }, { signal }))
        .rejects.toMatchObject({ code: "CONFLICT" });
      expect(codex.calls.slice(calls)).toEqual([]);
      expect(store.requireProviderAccountAuthority(profile.id, "codex").processGeneration).toBe(frozen.processGeneration);
      expect(store.requireProfile(profile.id).state).toBe(changedPart === "binding" ? "recovery_required" : "signed_in");
    },
  );
test("account recovery keeps an exact uncompleted login unresolved on a signed-out read", async () => {
    const { service, codex, store } = await fixture();
    const profile = store.createProfile("Exact uncompleted login");
    const key = "00000000-0000-4000-8000-000000000143";
    codex.beforeLoginReturn = async () => { throw new IndeterminateCodexEffectError("account/login/start", 74); };
    await expect(service.execute({ kind: "account.login", account: profile.id,
      deviceCode: false, idempotencyKey: key }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    const original = store.readMutation(key);
    if (original === null) throw new Error("Missing uncompleted login fixture.");
    const captured = store.readMutationProviderAuthorities(original.id);
    const before = store.requireProfile(profile.id);
    const revocations = ["managed", "personal"].map((runtimeScope) => store.readProviderRuntimeAccountRevocation({
      profileId: profile.id, provider: "codex", runtimeScope: runtimeScope === "managed" ? "managed" : "personal",
    }));
    codex.accountProjection = { signedIn: false };
    const calls = codex.calls.length;
    const releases = codex.releasedAuthorities.length;
    await expect(service.execute({ kind: "account.show", account: profile.id }, { signal })).resolves.toMatchObject({
      account: { state: "recovery_required" },
      recovery: { required: true, cleared: false, diagnostic: "The exact provider read does not prove that login completed." },
    });
    await service.settled();
    expect(store.readMutation(key)).toEqual(original);
    expect(store.readMutationProviderAuthorities(original.id)).toEqual(captured);
    expect(store.requireProfile(profile.id)).toEqual(before);
    expect(codex.calls.slice(calls)).toEqual(["readAccount"]);
    expect(codex.releasedAuthorities).toHaveLength(releases);
    expect(codex.resetIdempotencyKeys).toEqual([]);
    expect(["managed", "personal"].map((runtimeScope) => store.readProviderRuntimeAccountRevocation({
      profileId: profile.id, provider: "codex", runtimeScope: runtimeScope === "managed" ? "managed" : "personal",
    }))).toEqual(revocations);
  });
test("account recovery blocks a fresh cancellation after restart until the original read reconciliation", async () => {
    const value = await fixture();
    const { store, service, codex, paths } = value;
    const profile = store.createProfile("Retired uncertain cancellation");
    codex.loginResult = { status: "pending", loginId: "retired-uncertain-login" };
    await service.execute({ kind: "account.login", account: profile.id, deviceCode: false }, { signal });
    codex.beforeCancelLoginReturn = async () => { throw new IndeterminateCodexEffectError("account/cancelLogin", 73); };
    const oldKey = "00000000-0000-4000-8000-000000000141";
    const newKey = "00000000-0000-4000-8000-000000000142";
    await expect(service.execute({ kind: "account.login-cancel", account: profile.id, idempotencyKey: oldKey }, { signal }))
      .rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    const original = store.readMutation(oldKey);
    if (original === null) throw new Error("Missing uncertain cancellation.");
    const frozen = store.readMutationProviderAuthorities(original.id);
    const bootId = `boot_${"7".repeat(32)}`;
    const generation = store.nextDaemonGeneration(bootId);
    const currentCodex = new FakeCodex();
    currentCodex.accountProjection = { signedIn: false };
    const restarted = new OompaService({ store, paths, codex: currentCodex,
      cloud: new FakeCloud(), daemonAuthority: new FakeDaemonAuthority(),
      daemonGeneration: generation, daemonBootId: bootId, requestStop: () => undefined });
    await restarted.recover();
    expect(store.requireProfile(profile.id)).toMatchObject({ state: "login_pending", processGeneration: 2 });
    const calls = currentCodex.calls.length;
    await expect(restarted.execute({ kind: "account.login-cancel", account: profile.id, idempotencyKey: newKey }, { signal }))
      .rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(currentCodex.calls.slice(calls)).toEqual([]);
    expect(store.readMutation(newKey)).toBeNull();
    expect(store.readMutation(oldKey)).toEqual(original);
    expect(store.readMutationProviderAuthorities(original.id)).toEqual(frozen);
    await expect(restarted.execute({ kind: "account.show", account: profile.id }, { signal }))
      .resolves.toMatchObject({ account: { state: "login_pending" }, login: { loginId: "retired-uncertain-login" } });
    expect(store.readMutation(oldKey)).toMatchObject({ state: "reconciled",
      resolution: { kind: "provider_state_reconciled" } });
    expect(store.readMutation(oldKey)?.resolution?.receipt).toBeUndefined();
    await expect(restarted.execute({ kind: "account.login-cancel", account: profile.id, idempotencyKey: newKey }, { signal }))
      .resolves.toMatchObject({ status: "canceled", account: { state: "signed_out" } });
    expect(currentCodex.calls.filter((call) => call.startsWith("login-cancel:"))).toHaveLength(1);
    expect(store.readMutationProviderAuthorities(original.id)).toEqual(frozen);
    await restarted.close();
  });
test("preserves an accepted cancellation when its following account read fails", async () => {
    const { service, codex, store } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Cancel read failure" }, { signal }) as { account: { id: `acct_${string}` } };
    codex.loginResult = { status: "pending", loginId: "provider-login-read-failure" };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    codex.accountProjection = { signedIn: false };
    codex.cancelLoginResult = { status: "canceled" };
    codex.beforeReadAccountReturn = async () => { throw new Error("Account read failed after cancellation."); };
    const idempotencyKey = "00000000-0000-4000-8000-000000000135";
    await expect(service.execute({
      kind: "account.login-cancel",
      account: added.account.id,
      idempotencyKey,
    }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(store.readMutation(idempotencyKey)).toMatchObject({ state: "ambiguous" });
    expect(store.requireProfile(added.account.id).state).toBe("login_pending");
    await expect(service.execute({
      kind: "account.login-cancel",
      account: added.account.id,
    }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(codex.calls.filter((call) => call.startsWith("login-cancel:"))).toHaveLength(1);

    delete codex.beforeReadAccountReturn;
    await expect(service.execute({ kind: "account.show", account: added.account.id }, { signal }))
      .resolves.toMatchObject({ login: { status: "pending", loginId: "provider-login-read-failure" } });
    expect(store.readMutation(idempotencyKey)).toMatchObject({ state: "reconciled", originalState: "ambiguous" });
    expect(codex.calls.filter((call) => call.startsWith("login-cancel:"))).toHaveLength(1);
    codex.cancelLoginResult = { status: "not_found" };
    await expect(service.execute({ kind: "account.login-cancel", account: added.account.id }, { signal }))
      .resolves.toMatchObject({ status: "canceled", providerStatus: "not_found" });
  });
test("rolls back cancellation settlement when its receipt compare-and-swap fails", async () => {
    const { service, codex, store } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Cancel receipt failure" }, { signal }) as { account: { id: `acct_${string}` } };
    codex.loginResult = { status: "pending", loginId: "provider-login-receipt-failure" };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    codex.accountProjection = { signedIn: false };
    const idempotencyKey = "00000000-0000-4000-8000-000000000140";
    const transition = store.transitionMutation.bind(store);
    store.transitionMutation = (id, from, to, result) => {
      if (to === "applied" && store.readMutation(idempotencyKey)?.id === id) return false;
      return transition(id, from, to, result);
    };
    await expect(service.execute({ kind: "account.login-cancel", account: added.account.id, idempotencyKey }, { signal }))
      .rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(store.requireProfile(added.account.id).state).toBe("login_pending");
    expect(store.readPendingLoginAuthority(added.account.id, 1)?.loginId).toBe("provider-login-receipt-failure");
    expect(store.readMutation(idempotencyKey)?.state).toBe("ambiguous");
    store.transitionMutation = transition;
    await expect(service.execute({ kind: "account.show", account: added.account.id }, { signal }))
      .resolves.toMatchObject({ login: { status: "pending", loginId: "provider-login-receipt-failure" } });
    expect(store.readMutation(idempotencyKey)?.state).toBe("reconciled");
    expect(codex.calls.filter((call) => call.startsWith("login-cancel:"))).toHaveLength(1);
  });
test("leaves an accepted cancellation effect started when the account-read fence is lost", async () => {
    const { service, codex, store, daemonAuthority } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Cancel read fence" }, { signal }) as { account: { id: `acct_${string}` } };
    codex.loginResult = { status: "pending", loginId: "provider-login-read-fence" };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    codex.accountProjection = { signedIn: false };
    codex.beforeReadAccountReturn = async () => { daemonAuthority.invalidate(); };
    const idempotencyKey = "00000000-0000-4000-8000-000000000136";
    await expect(service.execute({
      kind: "account.login-cancel",
      account: added.account.id,
      idempotencyKey,
    }, { signal })).rejects.toBeInstanceOf(DaemonAuthoritySafetyError);
    expect(store.readMutation(idempotencyKey)).toMatchObject({ state: "effect_started" });
    expect(codex.calls.filter((call) => call.startsWith("login-cancel:"))).toHaveLength(1);
  });
test("quarantines an effect-started login cancellation at restart and reconciles it from the account read", async () => {
    const value = await fixture();
    const { service, codex, store } = value;
    const added = await service.execute({ kind: "account.add", label: "Crashed cancel" }, { signal }) as { account: { id: `acct_${string}` } };
    codex.loginResult = { status: "pending", loginId: "provider-login-crashed-cancel" };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    const idempotencyKey = "00000000-0000-4000-8000-000000000134";
    const attempt = store.prepareMutation({
      kind: "account.login-cancel",
      authorityId: added.account.id,
      authorityGeneration: 1,
      request: { loginId: "provider-login-crashed-cancel" },
      idempotencyKey,
    });
    store.beginLoginCancelMutationEffect({
      attemptId: attempt.id,
      profileId: added.account.id,
      processGeneration: 1,
      loginId: "provider-login-crashed-cancel",
      providerAuthority: store.requireProviderAccountAuthority(added.account.id, "codex"),
    });
    const capturedAuthority = store.readMutationProviderAuthorities(attempt.id);
    expect(store.readMutation(idempotencyKey)).toMatchObject({
      state: "effect_started",
      evidence: { evidence: { kind: "account.login-cancel", loginId: "provider-login-crashed-cancel" } },
    });
    // A crash advances the live provider process fence. Recovery must still
    // classify and reconcile the immutable old-generation cancellation
    // without replaying it or rebinding its sidecar.
    const daemonGeneration = store.nextDaemonGeneration(`boot_${"c".repeat(32)}`);
    const restartedCodex = new FakeCodex();
    restartedCodex.accountProjection = { signedIn: false };
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
    expect(store.requireProfile(added.account.id)).toMatchObject({ processGeneration: 2, state: "recovery_required" });
    expect(store.readMutation(idempotencyKey)).toMatchObject({ state: "ambiguous", result: { code: "DAEMON_RESTART" } });
    expect(store.readMutationProviderAuthorities(attempt.id)).toEqual(capturedAuthority);

    const shown = await restarted.execute({ kind: "account.show", account: added.account.id }, { signal });
    expect(shown).toMatchObject({
      account: { processGeneration: 2, state: "login_pending" },
      login: { status: "pending", loginId: "provider-login-crashed-cancel" },
      recovery: { cleared: true, required: false, resolution: "provider_state_reconciled" },
    });
    expect(store.readMutation(idempotencyKey)).toMatchObject({ state: "reconciled", originalState: "ambiguous" });
    expect(() => store.readPendingLoginAuthority(added.account.id, 1)).toThrow("PROVIDER_LOGIN_BINDING_PROOF_INVALID");
    expect(store.readPendingLoginAuthority(added.account.id, 2)).toMatchObject({ loginId: "provider-login-crashed-cancel" });
    expect(store.listUnsettledMutations({ authorityId: added.account.id })).toEqual([]);
    expect(store.readMutationProviderAuthorities(attempt.id)).toEqual(capturedAuthority);
    expect(restartedCodex.calls.filter((call) => call.startsWith("login-cancel:"))).toHaveLength(0);
    expect(restartedCodex.calls.filter((call) => call.startsWith("login:"))).toHaveLength(0);
    expect(restartedCodex.calls.filter((call) => call === "logout")).toHaveLength(0);
    expect(restartedCodex.calls.filter((call) => call === "readAccount")).toHaveLength(1);
    await restarted.close();
    await service.close();
  });
test("reconciles retired-generation login and logout attempts from current exact account reads without replay", async () => {
    const value = await fixture();
    const { service, store } = value;
    const unusedCapability = (): never => { throw new Error("No Work capability expected in account-only fixture."); };
    const work = store.createWorkStore(value.daemonGeneration, unusedCapability,
      { issue: unusedCapability, verify: unusedCapability });
    const retireEmptyCodexScopes = (profileId: `acct_${string}`, generation: number): void => {
      // These profiles own no sessions or runtime children. Model the actual
      // two-scope retirement before the direct write-ahead account admission.
      for (const runtimeScope of ["personal", "managed"] as const) {
        const retired = store.beginProviderRuntimeAccountRevocation({ profileId,
          expectedGeneration: generation, provider: "codex", runtimeScope,
          currentAccountKey: null, workStore: work });
        expect(retired.sessionIds).toEqual([]);
        store.completeProviderRuntimeAccountRevocation({ profileId, expectedGeneration: generation,
          provider: "codex", runtimeScope, expectedRevision: retired.revocation.revision });
      }
    };
    const loginProfile = await service.execute(
      { kind: "account.add", label: "Crashed login rollover" },
      { signal },
    ) as { account: { id: `acct_${string}` } };
    const loginSource = store.requireProviderAccountAuthority(loginProfile.account.id, "codex");
    retireEmptyCodexScopes(loginProfile.account.id, loginSource.processGeneration);
    const loginKey = "00000000-0000-4000-8000-000000000135";
    const login = store.prepareMutation({
      kind: "account.login",
      authorityId: loginProfile.account.id,
      authorityGeneration: 1,
      request: { deviceCode: false },
      idempotencyKey: loginKey,
      providerAuthorities: [{
        role: "source",
        authority: loginSource,
        provenance: "account_login_source",
      }],
    });
    store.beginAccountMutationEffect({
      attemptId: login.id,
      profileId: loginProfile.account.id,
      profileGeneration: 1,
      providerAuthority: loginSource,
      evidence: { kind: "account.login", method: "browser" },
    });

    const logoutProfile = await service.execute(
      { kind: "account.add", label: "Crashed logout rollover" },
      { signal },
    ) as { account: { id: `acct_${string}` } };
    await service.execute(
      { kind: "account.login", account: logoutProfile.account.id, deviceCode: false },
      { signal },
    );
    const logoutAuthority = store.requireProviderAccountAuthority(logoutProfile.account.id, "codex");
    retireEmptyCodexScopes(logoutProfile.account.id, logoutAuthority.processGeneration);
    const logoutKey = "00000000-0000-4000-8000-000000000136";
    const logout = store.prepareMutation({
      kind: "account.logout",
      authorityId: logoutProfile.account.id,
      authorityGeneration: logoutAuthority.processGeneration,
      request: {},
      idempotencyKey: logoutKey,
      providerAuthorities: [{
        role: "primary",
        authority: logoutAuthority,
        provenance: "account_logout",
      }],
    });
    store.beginAccountMutationEffect({
      attemptId: logout.id,
      profileId: logoutProfile.account.id,
      profileGeneration: logoutAuthority.processGeneration,
      providerAuthority: logoutAuthority,
      evidence: { kind: "account.logout", baselineSignedIn: true },
    });
    const captured = {
      login: store.readMutationProviderAuthorities(login.id),
      logout: store.readMutationProviderAuthorities(logout.id),
    };

    const daemonGeneration = store.nextDaemonGeneration(`boot_${"f".repeat(32)}`);
    const restartedCodex = new FakeCodex();
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
    expect(store.requireProfile(loginProfile.account.id)).toMatchObject({
      processGeneration: 2,
      state: "recovery_required",
    });
    expect(store.requireProfile(logoutProfile.account.id)).toMatchObject({
      processGeneration: 2,
      state: "recovery_required",
    });

    restartedCodex.accountProjection = {
      signedIn: true,
      email: "recovered-login@example.com",
      plan: "Plus",
    };
    await expect(restarted.execute({ kind: "account.show", account: loginProfile.account.id }, { signal }))
      .resolves.toMatchObject({
        account: { processGeneration: 2, state: "signed_in" },
        recovery: { cleared: true, required: false, resolution: "proven_applied" },
      });
    restartedCodex.accountProjection = { signedIn: false };
    await expect(restarted.execute({ kind: "account.show", account: logoutProfile.account.id }, { signal }))
      .resolves.toMatchObject({
        account: { processGeneration: 2, state: "signed_out" },
        recovery: { cleared: true, required: false, resolution: "proven_applied" },
      });
    expect(store.readMutation(loginKey)).toMatchObject({
      state: "reconciled",
      originalState: "ambiguous",
      resolution: { kind: "proven_applied" },
    });
    expect(store.readMutation(logoutKey)).toMatchObject({
      state: "reconciled",
      originalState: "ambiguous",
      resolution: { kind: "proven_applied" },
    });
    expect(store.readMutationProviderAuthorities(login.id)).toEqual(captured.login);
    expect(store.readMutationProviderAuthorities(logout.id)).toEqual(captured.logout);
    expect(restartedCodex.calls.filter((call) => call.startsWith("login:"))).toHaveLength(0);
    expect(restartedCodex.calls.filter((call) => call === "logout")).toHaveLength(0);
    expect(restartedCodex.calls.filter((call) => call === "readAccount")).toHaveLength(2);
    await restarted.close();
    await service.close();
  });
test("recovers a cancellation through the production daemon generation rollover", async () => {
    const value = await fixture();
    const { service, codex, store, paths } = value;
    const added = await service.execute({ kind: "account.add", label: "Cancel production restart" }, { signal }) as { account: { id: `acct_${string}` } };
    codex.loginResult = { status: "pending", loginId: "provider-login-production-restart" };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    const idempotencyKey = "00000000-0000-4000-8000-000000000137";
    const attempt = store.prepareMutation({
      kind: "account.login-cancel",
      authorityId: added.account.id,
      authorityGeneration: 1,
      request: { loginId: "provider-login-production-restart" },
      idempotencyKey,
    });
    store.beginLoginCancelMutationEffect({
      providerAuthority: store.requireProviderAccountAuthority(added.account.id, "codex"),
      attemptId: attempt.id,
      profileId: added.account.id,
      processGeneration: 1,
      loginId: "provider-login-production-restart",
    });
    store.nextDaemonGeneration(`boot_${"b".repeat(32)}`);
    const restartedCodex = new FakeCodex();
    restartedCodex.accountProjection = { signedIn: false };
    const restarted = new OompaService({
      store, paths, codex: restartedCodex, cloud: new FakeCloud(),
      daemonAuthority: new FakeDaemonAuthority(), requestStop: () => undefined,
    });
    await expect(restarted.recover()).resolves.toBeUndefined();
    expect(store.requireProfile(added.account.id)).toMatchObject({ processGeneration: 2, state: "recovery_required" });
    expect(store.readMutation(idempotencyKey)).toMatchObject({ authorityGeneration: 1, state: "ambiguous" });
    // A second crash before status reconciliation must preserve the same
    // immutable cancellation instead of rejecting its retained login fence.
    store.nextDaemonGeneration(`boot_${"c".repeat(32)}`);
    const again = new OompaService({
      store, paths, codex: restartedCodex, cloud: new FakeCloud(),
      daemonAuthority: new FakeDaemonAuthority(), requestStop: () => undefined,
    });
    await expect(again.recover()).resolves.toBeUndefined();
    await expect(again.execute({ kind: "account.show", account: added.account.id }, { signal }))
      .resolves.toMatchObject({ account: { processGeneration: 3, state: "login_pending" }, login: { loginId: "provider-login-production-restart", status: "pending" }, recovery: { required: false, cleared: true } });
    expect(store.readMutation(idempotencyKey)).toMatchObject({ authorityGeneration: 1, state: "reconciled" });
    expect(restartedCodex.calls.filter((call) => call.startsWith("login-cancel:"))).toHaveLength(0);
  });
test("reconciles cancellation racing successful sign-in without revoking its exact login authority", async () => {
    const { service, codex, store } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Cancellation success race" }, { signal }) as { account: { id: `acct_${string}` } };
    codex.loginResult = { status: "pending", loginId: "provider-login-success-race" };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    codex.beforeCancelLoginReturn = async () => { throw new IndeterminateCodexEffectError("account/cancelLogin", 13); };
    const idempotencyKey = "00000000-0000-4000-8000-000000000143";
    await expect(service.execute({ kind: "account.login-cancel", account: added.account.id, idempotencyKey }, { signal }))
      .rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    store.recoverEffectStartedMutations();
    // Keep the original pending binding: a generic readiness transition is not
    // the dedicated cancellation-quarantine witness produced at real restart.
    codex.accountProjection = { signedIn: true, email: "race@example.com" };
    const shown = await service.execute({ kind: "account.show", account: added.account.id }, { signal });
    expect(shown).toMatchObject({ account: {
      state: "signed_in", processGeneration: 1, providerEmail: "race@example.com" } });
    expect(shown).not.toHaveProperty("recovery");
    await service.settled();
    expect(store.requireProfile(added.account.id)).toMatchObject({ state: "signed_in", processGeneration: 1 });
    expect(store.readMutation(idempotencyKey)?.state).toBe("reconciled");
    expect(codex.calls.filter((call) => call.startsWith("login-cancel:"))).toHaveLength(1);
  });
test("does not clear an ambiguous login after production daemon generation rollover", async () => {
    const value = await fixture();
    const { service, codex, store, paths } = value;
    const added = await service.execute({ kind: "account.add", label: "Login production restart" }, { signal }) as { account: { id: `acct_${string}` } };
    codex.beforeLoginReturn = async () => { throw new IndeterminateCodexEffectError("account/login/start", 9); };
    const idempotencyKey = "00000000-0000-4000-8000-000000000138";
    await expect(service.execute({
      kind: "account.login", account: added.account.id, deviceCode: true, idempotencyKey,
    }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    store.nextDaemonGeneration(`boot_${"d".repeat(32)}`);
    const restartedCodex = new FakeCodex();
    restartedCodex.accountProjection = { signedIn: false };
    const restarted = new OompaService({
      store, paths, codex: restartedCodex, cloud: new FakeCloud(),
      daemonAuthority: new FakeDaemonAuthority(), requestStop: () => undefined,
    });
    await restarted.recover();
    await expect(restarted.execute({ kind: "account.show", account: added.account.id }, { signal }))
      .resolves.toMatchObject({ account: { processGeneration: 2, state: "recovery_required" }, recovery: { required: true, cleared: false } });
    expect(store.readMutation(idempotencyKey)).toMatchObject({ authorityGeneration: 1, state: "ambiguous" });
    await expect(restarted.execute({ kind: "account.login", account: added.account.id, deviceCode: true }, { signal }))
      .rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(restartedCodex.calls.filter((call) => call.startsWith("login:"))).toHaveLength(0);

    restartedCodex.accountProjection = { signedIn: true, email: "recovered@example.com" };
    await expect(restarted.execute({ kind: "account.show", account: added.account.id }, { signal }))
      .resolves.toMatchObject({ account: { processGeneration: 2, state: "signed_in" }, recovery: { required: false, cleared: true } });
    expect(store.readMutation(idempotencyKey)).toMatchObject({ authorityGeneration: 1, state: "reconciled" });
    await expect(restarted.execute({ kind: "account.login", account: added.account.id, deviceCode: true, idempotencyKey }, { signal }))
      .resolves.toMatchObject({ login: { status: "signed_in" } });
    await expect(restarted.execute({ kind: "account.login", account: added.account.id, deviceCode: false, idempotencyKey }, { signal }))
      .rejects.toThrow("IDEMPOTENCY_CONFLICT");
    expect(restartedCodex.calls.filter((call) => call.startsWith("login:"))).toHaveLength(0);
  });
test("reports an unbound historical account mutation without reading or replacing provider authority", async () => {
    const { service, codex, store } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Unbound historical login" }, { signal }) as { account: { id: `acct_${string}` } };
    codex.beforeLoginReturn = async () => { throw new IndeterminateCodexEffectError("account/login/start", 10); };
    await expect(service.execute({ kind: "account.login", account: added.account.id, deviceCode: true }, { signal }))
      .rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    store.nextProfileGeneration(added.account.id);
    const calls = [...codex.calls];
    await expect(service.execute({ kind: "account.show", account: added.account.id }, { signal }))
      .resolves.toMatchObject({ recovery: { required: true, cleared: false, reason: "account_mutation_authority_unbound" } });
    for (const command of [
      { kind: "account.login", account: added.account.id, deviceCode: true },
      { kind: "account.logout", account: added.account.id },
      { kind: "account.login-cancel", account: added.account.id },
    ] as const) {
      await expect(service.execute(command, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    }
    expect(codex.calls).toEqual(calls);
  });
test("keeps unrelated accounts usable across a legacy schema 43 unbound login upgrade", async () => {
    // This archived binary actually advanced an ambiguous login's profile from
    // generation 1 to 2 without a successor ledger; no current rows are restamped.
    const captured = canonicalLoginLedgerFixtures[43];
    const original = captured.retained.login;
    const added = { account: captured.retained.loginProfile };
    const other = { account: captured.retained.profile };
    const idempotencyKey = captured.retained.loginKey;
    const home = await realpath(await mkdtemp(join(tmpdir(), "oompa-service-canonical43-login-")));
    serviceRoots.push(home);
    const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
    await initializeStatePaths(paths);
    await writeFile(paths.database, canonicalLoginLedgerDatabaseBytes(43), { mode: 0o600 });
    const retainedEvidence = () => {
      const database = new Database(paths.database, { strict: true });
      try {
        database.exec("PRAGMA query_only=ON");
        return {
          attempt: database.query(`SELECT id,idempotency_key,kind,authority_id,authority_generation,
            request_digest,state,result_json,created_at,updated_at FROM mutation_attempts WHERE id=?`).get(original.id),
          effect: database.query("SELECT * FROM mutation_effect_evidence WHERE attempt_id=?").get(original.id),
        };
      } finally { database.close(false); }
    };
    const before = retainedEvidence();
    const upgraded = new StateStore(paths);
    stores.push(upgraded);
    expect(upgraded.requireProfileById(added.account.id)).toMatchObject(added.account);
    expect(upgraded.requireProfileById(other.account.id)).toMatchObject(other.account);
    expect(upgraded.readMutation(idempotencyKey)).toMatchObject(original);
    expect(retainedEvidence()).toEqual(before);
    const restartedCodex = new FakeCodex();
    restartedCodex.accountProjection = {
      signedIn: true,
      email: other.account.providerEmail,
      plan: other.account.providerPlan,
    };
    const restarted = new OompaService({
      store: upgraded, paths, codex: restartedCodex, cloud: new FakeCloud(),
      daemonAuthority: new FakeDaemonAuthority(), requestStop: () => undefined,
    });
    for (const boot of ["e", "f"]) {
      upgraded.nextDaemonGeneration(`boot_${boot.repeat(32)}`);
      await expect(restarted.recover()).resolves.toBeUndefined();
      const beforeRead = [...restartedCodex.calls];
      await expect(restarted.execute({ kind: "account.show", account: added.account.id }, { signal }))
        .resolves.toMatchObject({ account: { state: "recovery_required" }, recovery: { required: true, cleared: false, reason: "account_mutation_authority_unbound" } });
      await expect(restarted.execute({ kind: "account.login", account: added.account.id, deviceCode: true }, { signal }))
        .rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
      expect(restartedCodex.calls).toEqual(beforeRead);
      await restarted.observeCodexAccount(liveAuthorityFor(upgraded, added.account.id, "codex"), { signedIn: true, email: "unsolicited@example.com" });
      expect(upgraded.requireProfile(added.account.id).state).toBe("recovery_required");
      await expect(restarted.execute({ kind: "account.usage", account: added.account.id, refresh: true }, { signal }))
        .rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
      expect(restartedCodex.calls).toEqual(beforeRead);
      await expect(restarted.execute({ kind: "account.show", account: other.account.id }, { signal }))
        .resolves.toMatchObject({ account: { state: "signed_in" } });
      expect(upgraded.readMutation(idempotencyKey)).toMatchObject({ authorityGeneration: 1, state: "ambiguous", evidence: original.evidence });
      expect(retainedEvidence()).toEqual(before);
    }
    const inspector = new Database(paths.database, { readonly: true });
    try {
      expect(inspector.query("SELECT COUNT(*) AS count FROM account_mutation_authority_rebinds").get()).toEqual({ count: 0 });
      expect(inspector.query("SELECT COUNT(*) AS count FROM mutation_resolutions WHERE attempt_id=?").get(original.id)).toEqual({ count: 0 });
    } finally { inspector.close(false); }
  });
test("leaves a logout rejection unsettled when the daemon fence closes before exact controller release", async () => {
    const { service, codex, store, daemonAuthority } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Fence loss" }, { signal }) as { account: { id: `acct_${string}` } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    const releasesBeforeLogout = codex.releasedAuthorities.length;
    codex.logoutError = new Error("provider rejected the logout");
    codex.beforeLogoutReturn = async () => {
      daemonAuthority.invalidate();
    };
    const idempotencyKey = "00000000-0000-4000-8000-000000000141";
    await expect(service.execute({
      kind: "account.logout",
      account: added.account.id,
      idempotencyKey,
    }, { signal })).rejects.toBeInstanceOf(DaemonAuthoritySafetyError);
    expect(store.readMutation(idempotencyKey)).toMatchObject({ state: "effect_started" });
    expect(store.listUnsettledMutations({ authorityId: added.account.id })
      .some((attempt) =>
        attempt.idempotencyKey === idempotencyKey
        && attempt.state === "effect_started")).toBe(true);
    expect(codex.releasedAuthorities).toHaveLength(releasesBeforeLogout);
    expect(store.readProviderRuntimeAccountRevocation({
      profileId: added.account.id,
      provider: "codex",
      runtimeScope: "managed",
    })).toMatchObject({ currentAccountKey: null, state: "releasing" });
  });
test("leaves a fenced effect that lost the daemon fence to restart recovery", async () => {
    const { service, codex, store, daemonAuthority } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Fence loss after effect" }, { signal }) as { account: { id: `acct_${string}` } };
    await service.execute({ kind: "account.login", account: added.account.id, deviceCode: false }, { signal });
    codex.beforeLogoutReturn = async () => {
      daemonAuthority.invalidate();
    };
    const idempotencyKey = "00000000-0000-4000-8000-000000000142";
    await expect(service.execute({
      kind: "account.logout",
      account: added.account.id,
      idempotencyKey,
    }, { signal })).rejects.toBeInstanceOf(DaemonAuthoritySafetyError);
    expect(store.readMutation(idempotencyKey)).toMatchObject({ state: "effect_started" });
  });
test("commits a login whose signed-in account fact arrives before the receipt commit without quarantining the profile", async () => {
    const { service, codex, store } = await fixture();
    const added = await service.execute({ kind: "account.add", label: "Early account fact" }, { signal }) as { account: { id: `acct_${string}` } };
    codex.loginResult = { status: "signed_in", account: { signedIn: true, email: "person@example.com", plan: "Plus" } };
    let factReturned = false;
    codex.beforeLoginReturn = async ({ authority }) => {
      await service.observeCodexAccount(authority, { signedIn: true, email: "person@example.com", plan: "Plus" });
      factReturned = true;
    };
    const idempotencyKey = "00000000-0000-4000-8000-000000000151";
    const result = await service.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: false,
      idempotencyKey,
    }, { signal });
    expect(factReturned).toBe(true);
    expect(result).toMatchObject({
      account: { processGeneration: 1, state: "signed_in" },
      login: { status: "signed_in" },
    });
    await service.settled();
    expect(store.requireProfile(added.account.id)).toMatchObject({
      processGeneration: 1,
      state: "signed_in",
      providerEmail: "person@example.com",
    });
    expect(store.readMutation(idempotencyKey)).toMatchObject({ state: "applied" });
    expect(service.backgroundDiagnostics()).toEqual({ last: null, byCode: [] });
  });
test("keeps only closed codes and cause classes in background diagnostics", async () => {
    const { service } = await fixture();
    service.recordBackgroundDiagnostic("usage_poll_tick_failed", new Error("secret provider text /Users/private"));
    service.recordBackgroundDiagnostic("usage_poll_tick_failed", new CommandFailure("CONFLICT", "conflict"));
    service.recordBackgroundDiagnostic("queue_dispatch_failed", new DaemonAuthoritySafetyError("stale"));
    const diagnostics = service.backgroundDiagnostics();
    expect(diagnostics.last).toMatchObject({ code: "queue_dispatch_failed", cause: "authority_unsafe", count: 1 });
    expect(diagnostics.byCode).toEqual([
      expect.objectContaining({ code: "queue_dispatch_failed", cause: "authority_unsafe", count: 1 }),
      expect.objectContaining({ code: "usage_poll_tick_failed", cause: "command_failure", count: 2 }),
    ]);
    expect(JSON.stringify(diagnostics)).not.toContain("secret provider text");
    expect(JSON.stringify(diagnostics)).not.toContain("/Users/private");
  });
test("settles only the exact failed provider login completion and permits a fresh login", async () => {
    const { service, codex, store } = await fixture();
    const added = await service.execute({
      kind: "account.add",
      label: "Timed out login",
    }, { signal }) as { account: { id: `acct_${string}` } };
    const idempotencyKey = "00000000-0000-4000-8000-000000000122";
    codex.loginResult = { status: "pending", loginId: "provider-login-timeout" };
    await service.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: false,
      idempotencyKey,
    }, { signal });
    const authority = liveAuthorityFor(store, added.account.id);

    await service.observeCodexFact(authority, {
      type: "loginCompleted",
      loginId: "provider-login-timeout",
      success: true,
    });
    await service.observeCodexFact(authority, {
      type: "loginCompleted",
      loginId: null,
      success: false,
    });
    await service.observeCodexFact(authority, {
      type: "loginCompleted",
      loginId: "another-provider-login",
      success: false,
    });
    await service.observeCodexFact({ ...authority, generation: 0 }, {
      type: "loginCompleted",
      loginId: "provider-login-timeout",
      success: false,
    });
    expect(store.requireProfile(added.account.id)).toMatchObject({
      processGeneration: 1,
      state: "login_pending",
    });
    expect(store.readPendingLoginAuthority(added.account.id, 1)).toMatchObject({
      idempotencyKey,
      loginId: "provider-login-timeout",
    });

    await service.observeCodexFact(authority, {
      type: "loginCompleted",
      loginId: "provider-login-timeout",
      success: false,
    });
    expect(store.requireProfile(added.account.id)).toMatchObject({
      processGeneration: 1,
      state: "signed_out",
    });
    expect(store.readPendingLoginAuthority(added.account.id, 1)).toBeNull();
    await expect(service.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: false,
      idempotencyKey,
    }, { signal })).resolves.toMatchObject({
      login: { outcome: "signed_out", status: "settled" },
    });

    codex.loginResult = {
      status: "signed_in",
      account: { signedIn: true, email: "fresh@example.com", plan: "Plus" },
    };
    await expect(service.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: false,
    }, { signal })).resolves.toMatchObject({
      account: { processGeneration: 2, state: "signed_in" },
      login: { status: "signed_in" },
    });
  });
test("returns an old failed-login fact before a queued fresh generation closes that client", async () => {
    const { service, codex, store } = await fixture();
    const added = await service.execute({
      kind: "account.add",
      label: "Cancellation race",
    }, { signal }) as { account: { id: `acct_${string}` } };
    codex.loginResult = { status: "pending", loginId: "provider-login-race" };
    await service.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: false,
    }, { signal });
    codex.accountProjection = { signedIn: false };
    codex.cancelLoginResult = { status: "canceled" };
    let releaseCancellation!: () => void;
    let cancellationStarted!: () => void;
    const cancellationGate = new Promise<void>((resolve) => {
      releaseCancellation = resolve;
    });
    const started = new Promise<void>((resolve) => {
      cancellationStarted = resolve;
    });
    codex.beforeCancelLoginReturn = async () => {
      cancellationStarted();
      await cancellationGate;
    };
    let releaseOldFactObserver!: () => void;
    const oldFactObserverReturned = new Promise<void>((resolve) => {
      releaseOldFactObserver = resolve;
    });
    codex.loginResult = {
      status: "signed_in",
      account: { signedIn: true, email: "fresh@example.com", plan: "Plus" },
    };
    codex.beforeLoginReturn = async ({ authority }) => {
      if (authority.generation === 2) await oldFactObserverReturned;
    };

    const cancellation = service.execute({
      kind: "account.login-cancel",
      account: added.account.id,
    }, { signal });
    await started;
    const freshLogin = service.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: false,
    }, { signal });
    await Bun.sleep(0);
    const fact = service.observeCodexFact(liveAuthorityFor(store, added.account.id), {
      type: "loginCompleted",
      loginId: "provider-login-race",
      success: false,
    }).then(() => {
      releaseOldFactObserver();
    });
    const factDelivery = await Promise.race([
      fact.then(() => "returned" as const),
      new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 100)),
    ]);
    expect(factDelivery).toBe("returned");

    releaseCancellation();
    await expect(cancellation).resolves.toMatchObject({
      account: { state: "signed_out" },
      providerStatus: "canceled",
      status: "canceled",
    });
    const freshLoginResult = await freshLogin;
    expect(freshLoginResult).toMatchObject({
      account: { processGeneration: 2, state: "signed_in" },
      login: { status: "signed_in" },
    });
    await service.settled();
    expect(store.requireProfile(added.account.id)).toMatchObject({
      processGeneration: 2,
      state: "signed_in",
    });
    expect(store.readPendingLoginAuthority(added.account.id, 1)).toBeNull();
    expect(codex.calls.filter((call) => call.startsWith("login-cancel:"))).toHaveLength(1);
  });
test("orders a failed login completion before a following provider disconnect", async () => {
    const { service, codex, store } = await fixture();
    const added = await service.execute({
      kind: "account.add",
      label: "Timeout then disconnect",
    }, { signal }) as { account: { id: `acct_${string}` } };
    codex.loginResult = { status: "pending", loginId: "provider-login-disconnect-race" };
    await service.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: false,
    }, { signal });
    codex.accountProjection = { signedIn: false };
    let releaseAccountRead!: () => void;
    let accountReadStarted!: () => void;
    const accountReadGate = new Promise<void>((resolve) => {
      releaseAccountRead = resolve;
    });
    const started = new Promise<void>((resolve) => {
      accountReadStarted = resolve;
    });
    codex.beforeReadAccountReturn = async () => {
      accountReadStarted();
      await accountReadGate;
    };
    const authority = liveAuthorityFor(store, added.account.id);

    const accountShow = service.execute({
      kind: "account.show",
      account: added.account.id,
    }, { signal });
    await started;
    await service.observeCodexFact(authority, {
      type: "loginCompleted",
      loginId: "provider-login-disconnect-race",
      success: false,
    });
    await service.observeCodexFact(authority, {
      type: "providerDisconnected",
      connectionId: "018f1f55-3f10-7c1a-8f7b-c6dc608bcd3b",
      reason: "process_exit",
    });
    expect(store.requireProfile(added.account.id)).toMatchObject({
      processGeneration: 1,
      state: "login_pending",
    });

    releaseAccountRead();
    await expect(accountShow).resolves.toMatchObject({
      account: { processGeneration: 1, state: "login_pending" },
    });
    await service.settled();
    expect(store.requireProfile(added.account.id)).toMatchObject({
      processGeneration: 2,
      state: "signed_out",
    });
    expect(store.readPendingLoginAuthority(added.account.id, 1)).toBeNull();
    expect(store.readPendingLoginAuthority(added.account.id, 2)).toBeNull();
  });
test("scopes an isolated Devin disconnect to its provider session", async () => {
    const devinConnection = "018f1f55-3f10-7c1a-8f7b-c6dc608bcd3c";
    const devin = {
      provider: "devin" as const,
      rebindProfileAuthority: () => undefined,
      observeSession: async (input: Parameters<DevinRuntimePort["observeSession"]>[0]) => ({
        connectionId: devinConnection,
        projection: {
          providerThreadId: input.providerThreadId,
          status: "idle" as const,
          title: "Devin provider-scoped session",
        },
        resumed: true,
      }),
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
      { kind: "account.add", label: "Provider-scoped disconnect" },
      { signal },
    ) as { account: { id: `acct_${string}` } };
    await value.service.execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: false,
    }, { signal });
    const profile = value.store.requireProfileById(added.account.id);
    const codexAuthority = value.store.requireProviderAccountAuthority(profile.id, "codex");
    const codexSession = value.store.upsertProviderSession({
      providerAuthority: codexAuthority,
      fastEnabled: false,
      preset: "high",
      profileId: profile.id,
      provider: "codex",
      providerThreadId: "codex-provider-scoped-thread",
      providerAccountKey: codexProviderAccountKey(),
      state: "active",
      activeTurnId: "codex-provider-scoped-turn",
      title: "Codex provider-scoped session",
    });
    const devinSession = value.store.upsertProviderSession({
      providerAuthority: value.store.requireProviderAccountAuthority(profile.id, "devin"),
      fastEnabled: false,
      preset: "astra",
      profileId: profile.id,
      provider: "devin",
      providerThreadId: "devin-provider-scoped-thread",
      state: "active",
      activeTurnId: "devin-provider-scoped-turn",
      title: "Devin provider-scoped session",
    });
    const codexProviderThreadId = "codex-provider-scoped-thread";
    const devinAuthority = value.store.requireProviderAccountAuthority(profile.id, "devin");
    const authority: ProfileAuthority = {
      bindingGeneration: devinAuthority.bindingGeneration,
      codexHome: "unused",
      desktopUserData: "unused",
      generation: devinAuthority.processGeneration,
      id: profile.id,
      provider: "devin",
      providerAccountId: devinAuthority.providerAccountId,
    };
    const codexConnection = "018f1f55-3f10-7c1a-8f7b-c6dc608bcd3b";
    value.codex.observationConnectionId = codexConnection;
    value.codex.readProjection = {
      providerThreadId: codexProviderThreadId,
      status: "idle",
      title: "Codex provider-scoped session",
    };
    await value.service.execute({ kind: "session.status", session: codexSession.id }, { signal });
    await value.service.execute({ kind: "session.status", session: devinSession.id }, { signal });

    // A provider-scoped observer may not mutate a sibling provider even when
    // handed its exact thread id.
    await value.service.observeDevinFact(authority, {
      connectionId: devinConnection,
      status: { type: "systemError" },
      threadId: codexProviderThreadId,
      type: "threadStatusChanged",
    });
    await value.service.observeDevinFact(authority, {
      connectionId: devinConnection,
      reason: "process_exit",
      type: "providerDisconnected",
    });

    expect(value.store.requireProfileById(profile.id).processGeneration)
      .toBe(profile.processGeneration);
    expect(value.store.listSessionEvents({
      afterSequence: 0,
      limit: 20,
      sessionId: codexSession.id,
    }).events.map((event) => event.body)).toEqual([
      { state: "connected", type: "connection" },
      { activeTurnId: null, status: "idle", type: "session_status" },
    ]);
    expect(value.store.listSessionEvents({
      afterSequence: 0,
      limit: 20,
      sessionId: devinSession.id,
    }).events.map((event) => event.body)).toEqual([
      { state: "connected", type: "connection" },
      { activeTurnId: null, status: "idle", type: "session_status" },
      { reason: "process_exit", state: "disconnected", type: "connection" },
      {
        fromSequence: 4,
        reason: "provider_disconnect",
        throughSequence: 4,
        type: "gap",
      },
    ]);
  });
});
