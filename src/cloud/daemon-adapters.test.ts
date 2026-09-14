import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Database } from "bun:sqlite";

import { canonical39DevinDatabaseBytes, canonical39DevinFixture } from "../../scripts/fixtures/canonical39-devin";
import type { LocalCommand } from "../domain/contracts";
import { presetRequirements } from "../domain/presets";
import { effectiveRuntimeProfileSchema } from "../domain/runtime-profile";
import type { SessionId } from "../domain/values";
import {
  createStoredAccountUsageSnapshot,
  storedAccountUsageSnapshotSchema,
} from "../domain/usage-metrics";
import type {
  ClaudeRuntimePort,
  ClaudeAccountReadinessProjection,
  CodexAccountProjection,
  CodexRuntimePort,
  CodexSessionProjection,
  CloudControlPort,
  ProfileAuthority,
} from "../daemon/ports";
import { initializeStatePaths, resolveStatePaths, type StatePaths } from "../storage/paths";
import {
  USAGE_CLOUD_UPLOAD_MIN_INTERVAL_MS,
  StateStore,
} from "../storage/state-store";
import { cloudLimits, containsAbsolutePath } from "./contracts";
import type {
  CloudCommandExecutionResult,
  CloudDaemonBridge,
  CloudDaemonCycleResult,
  CloudLocalCommandAuthority,
} from "./daemon-bridge";
import {
  BridgedCloudControl,
  deviceRegistryAccountAddress,
  StateBackedCloudDaemonAdapter,
  type CloudProviderAccountProjectionReader,
} from "./daemon-adapters";
import { parseDeviceRegistryPayload, type RemoteCommandPayload } from "./payloads";
import type { CloudRemoteControlPort } from "./local-control";
import type { CompactRemoteInteractionReasonCode } from "./projection";

const privateRootFixture = ["", "Users", "alice", "private"].join("/");
const bearerFixture = ["Bearer", "secret-token-value"].join(" ");

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const codexProviderAccountKey = `v1:codex:${sha256("person@example.com")}`;
class FakeCodex implements CodexRuntimePort {
  readonly provider = "codex" as const;
  discardRuntimeReview(): void {}
  projection: CodexSessionProjection = {
    providerThreadId: "thread_0001",
    providerUpdatedAt: 1_000,
    title: "Provider title",
    status: "idle",
    messages: [
      { role: "user", text: `Read \`${privateRootFixture}/repo/key.ts\``, turnId: "turn_0001" },
      { role: "assistant", text: `Done ${bearerFixture}`, turnId: "turn_0001" },
    ],
    turnSummaries: [{
      id: "turn_0001",
      status: "completed",
      runtimeMs: 1_250,
      files: ["src/index.ts", `${privateRootFixture}.ts`],
      actions: [`git status --short ${bearerFixture}`, "bun test"],
      omittedFiles: 0,
      omittedActions: 0,
    }],
  };
  readSessionCalls = 0;
  usageCalls = 0;

  login(): Promise<never> { return Promise.reject(new Error("unused")); }
  cancelLogin(): Promise<never> { return Promise.reject(new Error("unused")); }
  logout(): Promise<void> { return Promise.reject(new Error("unused")); }
  readAccount(): Promise<CodexAccountProjection> { return Promise.reject(new Error("unused")); }
  listPlugins(): Promise<never> { return Promise.reject(new Error("unused")); }
  listSessions(): ReturnType<CodexRuntimePort["listSessions"]> { return Promise.reject(new Error("unused")); }
  reviewSessionStart(): Promise<never> { return Promise.reject(new Error("unused")); }
  startSession(): Promise<never> { return Promise.reject(new Error("unused")); }
  observeSession(): ReturnType<CodexRuntimePort["observeSession"]> { return Promise.reject(new Error("unused")); }
  reviewTurnStart(): Promise<never> { return Promise.reject(new Error("unused")); }
  startTurn(): Promise<never> { return Promise.reject(new Error("unused")); }
  steer(): Promise<void> { return Promise.reject(new Error("unused")); }
  interrupt(): Promise<void> { return Promise.reject(new Error("unused")); }
  rename(): Promise<void> { return Promise.reject(new Error("unused")); }
  inspectTurn(): Promise<unknown> { return Promise.reject(new Error("unused")); }
  inspectInteractionAuthority(): ReturnType<CodexRuntimePort["inspectInteractionAuthority"]> { return Promise.reject(new Error("unused")); }
  validateInteractionResolution(): Promise<{ responseDigest: string }> { return Promise.reject(new Error("unused")); }
  resolveInteraction(): Promise<{ responseWritten: true }> { return Promise.reject(new Error("unused")); }
  validateInteractionTimeout(): Promise<{ responseDigest: string }> { return Promise.reject(new Error("unused")); }
  timeoutInteraction(): Promise<{ responseWritten: true }> { return Promise.reject(new Error("unused")); }
  close(): Promise<void> { return Promise.resolve(); }

  endSession(): Promise<void> { return Promise.resolve(); }

  readonly readSessionProjectionForCloud = async (
    _sessionPublicId: string,
    signal: AbortSignal,
  ): Promise<CodexSessionProjection> => {
    signal.throwIfAborted();
    this.readSessionCalls += 1;
    return this.projection;
  };

  readSession(input: { authority: ProfileAuthority; providerThreadId: string; detail: boolean; signal: AbortSignal }): Promise<CodexSessionProjection> {
    this.readSessionCalls += 1;
    expect(input.providerThreadId).toBe("thread_0001");
    return Promise.resolve(this.projection);
  }

  readUsage(): Promise<{ revision: number; observedAt: number; payload: unknown }> {
    this.usageCalls += 1;
    return Promise.resolve({
      revision: this.usageCalls,
      observedAt: 2_000 + this.usageCalls,
      payload: {
        usage: {
          summary: {
            lifetimeTokens: 42,
            peakDailyTokens: 12,
            longestRunningTurnSec: 9,
            currentStreakDays: 2,
            longestStreakDays: 3,
          },
          dailyUsageBuckets: [{ startDate: "2026-08-22", tokens: 12 }],
        },
        rateLimits: {
          primary: {
            limitId: "primary",
            limitName: `Primary ${privateRootFixture}/secret`,
            primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 2_000_000_000 },
            secondary: null,
            planType: "plus",
            rateLimitReachedType: null,
          },
          byLimitId: null,
          resetCreditsAvailable: 1,
          resetCreditSentinel: "PRIVATE-RESET-CREDIT-SENTINEL",
        },
      },
    });
  }
  consumeRateLimitReset(): Promise<never> {
    return Promise.reject(new Error("unused reset mutation"));
  }
}

const temporaryDirectories: string[] = [];
const ownedFixtureTeardowns: Array<() => Promise<void>> = [];

/**
 * The presentation detail an `mcp_elicitation` interaction projects. The
 * server name, unsupported field names, choices, and values stay on the
 * machine. A separately validated remote policy may identify only answerable
 * bounded string fields.
 */
const mcpElicitationProjectedDetail = {
  detailMarkdown: [
    "- This form may contain protected values.",
    "- It is completed on the machine running the session.",
  ].join("\n"),
  detailVersion: 2,
  headline: "Codex requests MCP form input",
  label: "MCP form",
} as const;

const machineOnlyRemotePolicy = (
  deadlineAt: number,
  reasonCodes: readonly CompactRemoteInteractionReasonCode[],
) => ({
  actions: [],
  deadlineAt,
  questions: [],
  reasonCodes,
  version: 2,
}) as const;

async function fixture(
  registerStore?: (store: StateStore) => void,
  source?: "canonical39-devin",
): Promise<Readonly<{
  codex: FakeCodex;
  daemonGeneration: number;
  daemonBootId: string;
  now: () => number;
  paths: StatePaths;
  sessionId: string;
  setNow: (now: number) => void;
  store: StateStore;
}>> {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), "oompa-cloud-adapter-")));
  temporaryDirectories.push(temporary);
  const paths = resolveStatePaths({ homeDirectory: temporary, platform: "linux" });
  await initializeStatePaths(paths);
  if (source === "canonical39-devin") {
    await writeFile(paths.database, canonical39DevinDatabaseBytes(), { mode: 0o600, flag: "wx" });
  }
  let now = source === "canonical39-devin" ? canonical39DevinFixture.fixedTime : 1_000;
  const store = new StateStore(paths, { now: () => now });
  registerStore?.(store);
  const daemonBootId = `boot_${crypto.randomUUID().replaceAll("-", "")}`;
  const daemonGeneration = store.nextDaemonGeneration(daemonBootId);
  if (source === "canonical39-devin") {
    return {
      codex: new FakeCodex(), daemonGeneration, daemonBootId, now: () => now, paths,
      sessionId: canonical39DevinFixture.cases[0].session.id,
      setNow: (nextNow) => { now = nextNow; }, store,
    };
  }
  const profile = store.createProfile(`Personal \`${privateRootFixture}/profile\``);
  const current = store.nextProfileGeneration(profile.id);
  expect(store.setProfileState(current.id, current.processGeneration, "signed_in", {
    email: "person@example.com",
    plan: `file://${privateRootFixture}/plan`,
  })).toBe(true);
  const bound = store.upsertProviderSession({
    providerAuthority: store.requireProviderAccountAuthority(current.id, "codex"),
    profileId: current.id,
    title: `Work ${privateRootFixture}`,
    preset: "high",
    fastEnabled: true,
    provider: "codex",
    providerThreadId: "thread_0001",
    state: "idle",
    providerUpdatedAt: 1_000,
    providerAccountKey: `v1:codex:${sha256("person@example.com")}`,
  });
  store.updateSessionMetadata({
    sessionId: bound.id,
    expectedRevision: bound.revision,
    note: `Local checkout: ${privateRootFixture}/repo`,
  });
  const codex = new FakeCodex();
  const usage = await codex.readUsage();
  const sourceSequence = store.allocateNextUsageRevision(current.id);
  const usageAuthority = store.requireProviderAccountAuthority(current.id, "codex");
  store.recordUsage(current.id, sourceSequence, usage.observedAt, createStoredAccountUsageSnapshot({
    providerPayload: usage.payload,
    sourceSequence,
    observedAt: usage.observedAt,
    receivedAt: usage.observedAt,
    accountFingerprint: sha256("person@example.com"),
    providerGeneration: current.processGeneration,
    daemonGeneration: 1,
    previousPayload: null,
  }), usageAuthority);
  return {
    codex,
    daemonGeneration,
    daemonBootId,
    now: () => now,
    paths,
    sessionId: bound.id,
    setNow: (nextNow) => {
      now = nextNow;
    },
    store,
  };
}

function ownedCloudAdapterCase(
  runCase: (
    value: Awaited<ReturnType<typeof fixture>>,
    context: Readonly<{
      createAdapter: (executeRemote?: (command: LocalCommand) => Promise<unknown>) => StateBackedCloudDaemonAdapter;
      request: <T>(operation: () => Promise<T>) => Promise<T>;
      signal: AbortSignal;
    }>,
  ) => Promise<void>,
  source?: "canonical39-devin",
): Promise<void> {
  const controller = new AbortController();
  const adapters: StateBackedCloudDaemonAdapter[] = [];
  let store: StateStore | undefined;
  // Defer setup until its owner is registered, including partial setup that
  // has opened storage but has not returned the completed fixture yet.
  const setup = Promise.resolve().then(() => fixture((created) => { store = created; }, source));
  const caseTask = setup.then(async (value) => {
    controller.signal.throwIfAborted();
    await runCase(value, {
      createAdapter: (executeRemote = () => Promise.resolve({})) => {
        controller.signal.throwIfAborted();
        const adapter = new StateBackedCloudDaemonAdapter({
          readSessionProjectionForCloud: value.codex.readSessionProjectionForCloud,
          executeRemote,
          paths: value.paths,
          ...(source === "canonical39-devin" ? { platform: "darwin" as const } : {}),
          store: value.store,
        });
        adapters.push(adapter);
        return adapter;
      },
      request: async <T>(operation: () => Promise<T>): Promise<T> => {
        controller.signal.throwIfAborted();
        const result = await operation();
        controller.signal.throwIfAborted();
        return result;
      },
      signal: controller.signal,
    });
    controller.signal.throwIfAborted();
  });
  // Observe both promises immediately. Cleanup joins the raw case, never the
  // returned finally promise, and retains failures before storage/root removal.
  const settled = Promise.allSettled([setup, caseTask]);
  let teardownTask: Promise<void> | undefined;
  const teardown = (): Promise<void> => {
    controller.abort(new Error("Owned cloud adapter case is closing."));
    teardownTask ??= settled.then(async () => {
      for (const adapter of adapters) await adapter.close();
      store?.close();
    });
    return teardownTask;
  };
  ownedFixtureTeardowns.push(teardown);
  const result = caseTask.finally(teardown);
  void result.catch(() => undefined);
  return result;
}

function adoptPersonalCodexSession(
  value: Awaited<ReturnType<typeof fixture>>,
  providerThreadId: string,
) {
  const profile = value.store.requireProfileById(
    value.store.requireSession(value.sessionId).profileId,
  );
  value.store.setSessionAdoptionPolicy({ provider: "codex", profileId: profile.id });
  const candidate = value.store.upsertSessionAdoptionCandidate({
    provider: "codex",
    providerThreadId,
    title: `Adopted ${providerThreadId}`,
    state: "idle",
    liveness: "not_live",
  });
  const claiming = value.store.fenceSessionAdoptionCandidateForClaim({
    provider: "codex",
    providerThreadId,
    expectedRevision: candidate.revision,
  });
  return value.store.adoptSessionCandidate({
    providerAuthority: value.store.requireProviderAccountAuthority(profile.id, "codex"),
    expectedCandidateRevision: claiming.revision,
    fastEnabled: false,
    preset: "high",
    requirement: presetRequirements.high,
    profileId: profile.id,
    profileGeneration: profile.processGeneration,
    runtimeProfile: {
      approvalPolicy: "on-request",
      computerUse: true,
      enabledApps: [],
      fast: false,
      model: "gpt-6-astra",
      observedAt: 2_000,
      permissionProfile: ":workspace",
      pluginCapability: true,
      preset: "high",
      processGeneration: profile.processGeneration,
      profileId: profile.id,
      reasoningEffort: "max",
      reviewMode: "auto_review",
      serviceTier: null,
    },
    providerAccountKey: codexProviderAccountKey,
    provider: "codex",
    providerThreadId,
  });
}

function beginTurnProfileBinding(value: Awaited<ReturnType<typeof fixture>>, input: Readonly<{
  fast: boolean;
  preset: "low" | "high" | "ultra";
}>): Readonly<{
  attemptId: `attempt_${string}`;
  message: string;
  profile: Parameters<StateStore["recordSessionRuntimeProfile"]>[0]["profile"];
  providerAuthority: ReturnType<StateStore["requireProviderAccountAuthority"]>;
}> {
  const session = value.store.requireSession(value.sessionId);
  const profile = value.store.requireProfileById(session.profileId);
  const providerAuthority = value.store.requireProviderAccountAuthority(profile.id, "codex");
  const message = "fixture";
  const presetSelection = value.store.requireSessionPresetRequirement(session.id);
  if (presetSelection.preset !== input.preset) {
    throw new Error("Expected the fixture preset to match the session preset.");
  }
  const runtime = effectiveRuntimeProfileSchema.parse({
    profileId: profile.id,
    processGeneration: profile.processGeneration,
    observedAt: 2_000,
    preset: input.preset,
    model: presetSelection.requirement.model,
    reasoningEffort: presetSelection.requirement.effort,
    serviceTier: input.fast ? "priority" as const : null,
    fast: input.fast,
    approvalPolicy: "on-request" as const,
    reviewMode: "auto_review" as const,
    permissionProfile: ":workspace" as const,
    computerUse: true as const,
    pluginCapability: true as const,
    enabledApps: [],
  });
  const { attempt } = value.store.prepareSessionInputMutation({
    kind: "session.send",
    sessionId: session.id,
    providerAuthority,
    message,
    attachments: [],
    idempotencyKey: crypto.randomUUID(),
    daemonGeneration: value.daemonGeneration,
    bootId: value.daemonBootId,
  });
  value.store.beginSessionMutationEffect({
    attemptId: attempt.id,
    transcript: {
      accountId: profile.id,
      providerGeneration: profile.processGeneration,
      providerConnectionId: "10000000-0000-4000-8000-00000000000b",
      actor: "human",
      message,
    },
    evidence: {
      baseline: { activeTurnId: null, providerUpdatedAt: session.providerUpdatedAt ?? null, status: "idle" },
      clientMessageId: attempt.id,
      kind: "session.send",
      messageDigest: sha256(message),
      providerThreadId: session.providerThreadId ?? "thread_0001",
      runtimeProfile: runtime,
    },
    profileGeneration: profile.processGeneration,
    providerAuthority,
    sessionId: session.id,
    attachments: [],
    daemonGeneration: value.daemonGeneration,
    bootId: value.daemonBootId,
    message,
  });
  return { attemptId: attempt.id as `attempt_${string}`, message, profile: runtime, providerAuthority };
}

async function materializeScheduledTaskQueue(
  value: Awaited<ReturnType<typeof fixture>>,
  input: Readonly<{ idempotencyKey: string; prompt: string; turnId: string }>,
): Promise<string> {
  const project = value.store.listProjects()[0]
    ?? await value.store.createProject("Cloud projection fixture", value.paths.root, true);
  const session = value.store.requireSession(value.sessionId);
  if (session.projectId === undefined) {
    value.store.updateSessionMetadata({
      sessionId: session.id,
      expectedRevision: session.revision,
      projectId: project.id,
    });
  }
  const taskStore = value.store.createSessionTaskStore();
  const task = taskStore.create({
    idempotencyKey: input.idempotencyKey,
    minutes: 15,
    name: "Cloud projection privacy fixture",
    prompt: input.prompt,
    sessionId: value.sessionId,
    status: "active",
  });
  if (task.nextDueAt === null) throw new Error("Expected an active scheduled task.");
  value.setNow(task.nextDueAt);
  const materialized = await taskStore.materializeDue({
    now: task.nextDueAt,
  });
  const occurrence = materialized[0];
  if (occurrence === undefined) throw new Error("Expected a scheduled task queue occurrence.");
  const current = value.store.requireSession(value.sessionId);
  const profile = value.store.requireProfileById(current.profileId);
  const providerAuthority = value.store.requireProviderAccountAuthority(profile.id, "codex");
  const presetSelection = value.store.requireSessionPresetRequirement(current.id);
  if (current.providerThreadId === undefined) throw new Error("Expected a bound session.");
  const runtime = effectiveRuntimeProfileSchema.parse({
    profileId: profile.id,
    processGeneration: profile.processGeneration,
    observedAt: 2_000,
    preset: presetSelection.preset,
    model: presetSelection.requirement.model,
    reasoningEffort: presetSelection.requirement.effort,
    serviceTier: current.fastEnabled ? "priority" as const : null,
    fast: current.fastEnabled,
    approvalPolicy: "on-request" as const,
    reviewMode: "auto_review" as const,
    permissionProfile: ":workspace" as const,
    computerUse: true as const,
    pluginCapability: true as const,
    enabledApps: [],
  });
  const evidence = value.store.beginQueueEffect({
    queueId: occurrence.queue.id,
    sessionId: current.id,
    profileGeneration: profile.processGeneration,
    providerAuthority,
    providerConnectionId: "10000000-0000-4000-8000-000000000001",
    evidence: {
      kind: "queue.dispatch",
      queueId: occurrence.queue.id,
      sessionId: current.id,
      providerThreadId: current.providerThreadId,
      profileGeneration: profile.processGeneration,
      baseline: {
        activeTurnId: null,
        providerUpdatedAt: current.providerUpdatedAt ?? null,
        status: "idle",
      },
      clientMessageId: occurrence.queue.id,
      messageDigest: sha256(input.prompt),
      runtimeProfile: runtime,
    },
  });
  value.store.completeQueueEffect({
    accountId: profile.id,
    providerGeneration: providerAuthority.processGeneration,
    queueId: occurrence.queue.id,
    expectedEvidenceDigest: evidence.digest,
    expectedSessionRevision: current.revision,
    providerAuthority,
    message: input.prompt,
    providerConnectionId: null,
    applyResponseState: false,
    turnId: input.turnId,
    turnStatus: "completed",
    runtimeProfile: runtime,
    receipt: { turnId: input.turnId, sourceId: occurrence.queue.id },
  });
  return occurrence.queue.id;
}

function admitCloudInteraction(
  value: Awaited<ReturnType<typeof fixture>>,
  publicId: string,
  connectionId: string,
): void {
  const session = value.store.requireSession(value.sessionId);
  const profile = value.store.requireProfileById(session.profileId);
  const providerAuthority = value.store.requireSessionProviderAuthority(session.id);
  value.store.admitInteraction({
    authority: {
      approvalId: null,
      bindingGeneration: providerAuthority.bindingGeneration,
      connectionId,
      itemId: null,
      method: "mcp/elicitation/create",
      processGeneration: profile.processGeneration,
      profileId: profile.id,
      provider: providerAuthority.provider,
      providerAccountId: providerAuthority.providerAccountId,
      requestDigest: "d".repeat(64),
      requestId: { type: "string", value: `request_${publicId}` },
      threadId: session.providerThreadId ?? null,
      turnId: null,
    },
    blocking: true,
    display: {
      kind: "mcp_elicitation",
      mayContainSecrets: true,
      mode: "form",
      serverName: "fixture",
      summary: "Review provider input",
      url: null,
    },
    kind: "mcp_elicitation",
    publicId,
    sessionId: value.sessionId as `sess_${string}`,
  });
}

afterEach(async () => {
  for (const teardown of ownedFixtureTeardowns) await teardown();
  ownedFixtureTeardowns.length = 0;
  while (temporaryDirectories.length > 0) {
    const temporary = temporaryDirectories.pop();
    if (temporary !== undefined) await rm(temporary, { force: true, recursive: true });
  }
});

/**
 * A Claude seam that answers only what cloud projection asks of it. The
 * adapter must reach it, not the Codex port, for a session whose provider is
 * `claude`.
 */
class FakeClaude implements ClaudeRuntimePort {
  readonly provider = "claude" as const;
  rebindProfileAuthority(): void { throw new Error("unused"); }
  afterReadSession: (() => void) | undefined;
  discardRuntimeReview(): void {}
  readSessionCalls = 0;
  readonly readSessionAuthorities: ProfileAuthority[] = [];
  readAccountCalls = 0;
  readonly accountProjection: ClaudeAccountReadinessProjection | Error;
  projection: CodexSessionProjection = {
    messages: [
      { role: "user", text: "Summarise the diff", turnId: "turn_claude_1" },
      { role: "assistant", text: "Two files changed", turnId: "turn_claude_1" },
    ],
    providerThreadId: "thread_claude_0001",
    providerUpdatedAt: 1_000,
    status: "idle",
    title: "Claude title",
    turnSummaries: [{
      actions: [],
      files: ["src/index.ts"],
      id: "turn_claude_1",
      omittedActions: 0,
      omittedFiles: 0,
      runtimeMs: 2_374,
      status: "completed",
    }],
  };

  constructor(accountProjection: ClaudeAccountReadinessProjection | Error = {
    observedAt: 1_050,
    readiness: "signed_in",
  }) {
    this.accountProjection = accountProjection;
  }

  async readSession(
    input: Parameters<ClaudeRuntimePort["readSession"]>[0],
  ): Promise<CodexSessionProjection> {
    this.readSessionCalls += 1;
    this.readSessionAuthorities.push(input.authority);
    this.afterReadSession?.();
    return this.projection;
  }
  endSession(): Promise<void> { return Promise.resolve(); }
  #unused(): never { throw new Error("unused"); }
  pinnedVersion(): string { return this.#unused(); }
  interactionAuthority(): never { return this.#unused(); }
  readAccount(): Promise<ClaudeAccountReadinessProjection> {
    this.readAccountCalls += 1;
    return this.accountProjection instanceof Error
      ? Promise.reject(this.accountProjection)
      : Promise.resolve(this.accountProjection);
  }
  reviewSessionStart(): Promise<never> { return Promise.reject(this.#unused()); }
  startSession(): Promise<never> { return Promise.reject(this.#unused()); }
  claimSession(): Promise<never> { return Promise.reject(this.#unused()); }
  readSessionProcessIdentity(): ReturnType<ClaudeRuntimePort["readSessionProcessIdentity"]> {
    return Promise.reject(this.#unused());
  }
  observeSession(): ReturnType<ClaudeRuntimePort["observeSession"]> { return Promise.reject(this.#unused()); }
  reviewTurnStart(): Promise<never> { return Promise.reject(this.#unused()); }
  startTurn(): Promise<never> { return Promise.reject(this.#unused()); }
  steer(): Promise<void> { return Promise.reject(this.#unused()); }
  interrupt(): Promise<void> { return Promise.reject(this.#unused()); }
  inspectInteractionAuthority(): ReturnType<ClaudeRuntimePort["inspectInteractionAuthority"]> { return Promise.reject(this.#unused()); }
  validateInteractionResolution(): Promise<{ responseDigest: string }> { return Promise.reject(this.#unused()); }
  resolveInteraction(): Promise<{ responseWritten: true }> { return Promise.reject(this.#unused()); }
  validateInteractionTimeout(): Promise<{ responseDigest: string }> { return Promise.reject(this.#unused()); }
  timeoutInteraction(): Promise<{ responseWritten: true }> { return Promise.reject(this.#unused()); }
  async close(): Promise<void> {}
}


async function readFixtureProviderSession(
  value: Awaited<ReturnType<typeof fixture>>,
  runtime: ClaudeRuntimePort,
  sessionId: string,
  signal: AbortSignal,
): Promise<CodexSessionProjection> {
  const session = value.store.requireSession(sessionId);
  const captured = value.store.requireSessionProviderAuthority(session.id);
  if (session.providerThreadId === undefined) throw new Error("Fixture session is unbound.");
  return await runtime.readSession({
    authority: {
      id: captured.profileId,
      generation: captured.processGeneration,
      provider: captured.provider,
      providerAccountId: captured.providerAccountId,
      bindingGeneration: captured.bindingGeneration,
      codexHome: join(value.paths.root, "private-provider-home"),
      desktopUserData: join(value.paths.root, "private-provider-data"),
    },
    providerThreadId: session.providerThreadId,
    detail: true,
    signal,
  });
}

describe("state-backed cloud daemon adapter", () => {
  test("routes list and recovery projection reads through the service-owned exact seam", async () => {
    const value = await fixture();
    const projectedSessionIds: string[] = [];
    const adapter = new StateBackedCloudDaemonAdapter({
      readSessionProjectionForCloud: (sessionPublicId, signal) => {
        signal.throwIfAborted();
        projectedSessionIds.push(sessionPublicId);
        return Promise.resolve(value.codex.projection);
      },
      executeRemote: () => Promise.resolve({}),
      paths: value.paths,
      store: value.store,
    });
    try {
      const signal = new AbortController().signal;
      await adapter.listSessions({ limit: 25, signal });
      await adapter.planCompactProjectionRecovery({
        idempotencyKey: "00000000-0000-7000-8000-00000000072a",
        sessionPublicId: value.sessionId,
        signal,
      });
      expect(projectedSessionIds).toEqual([value.sessionId, value.sessionId]);
    } finally {
      await adapter.close();
      value.store.close();
    }
  });

  test("projects a Claude session through the service-owned exact reader", async () => {
    const value = await fixture();
    const profile = value.store.requireProfileById(
      value.store.requireSession(value.sessionId).profileId,
    );
    const claudeAccount = value.store.requireProviderAccountForProfile(
      profile.id,
      "claude",
    );
    const firstClaudeProcess = value.store.advanceProviderAccountProcessGeneration({
      expectedProcessGeneration: claudeAccount.processGeneration,
      profileId: profile.id,
      provider: "claude",
    });
    const claudeAuthority = value.store.advanceProviderAccountProcessGeneration({
      expectedProcessGeneration: firstClaudeProcess.processGeneration,
      profileId: profile.id,
      provider: "claude",
    });
    expect(value.store.setProfileState(
      profile.id,
      profile.processGeneration,
      "signed_out",
    )).toBe(true);
    const starting = value.store.createSession({
      fastEnabled: false,
      preset: "fable-max",
      profileId: profile.id,
      provider: "claude",
      title: "Claude work",
    });
    expect(value.store.requireProviderAccountForProfile(profile.id, "claude").readiness)
      .toBe("unverified");
    expect(value.store.requireSessionProviderAuthority(starting.id).routingProvenance)
      .toBe("explicit");
    const bound = value.store.bindSession({
      sessionId: starting.id,
      expectedRevision: starting.revision,
      providerThreadId: "thread_claude_0001",
      state: "idle",
      providerUpdatedAt: 1_000,
    });
    value.store.bindSessionProviderAccountAuthority({
      sessionId: bound.id,
      provider: "claude",
      runtimeScope: "managed",
      accountKey: `v1:claude:${sha256("managed-claude-account")}`,
    });
    // Bind the turn's reviewed Claude profile the way a dispatched queue entry
    // does, so the compact turn summary can name its model.
    const claudeProfile = {
      claudeVersion: "2.1.260",
      inputFormat: "stream-json" as const,
      isolatedConfigDir: true as const,
      model: "claude-fable-5-1",
      observedAt: 2_100,
      outputFormat: "stream-json" as const,
      permissionMode: "default" as const,
      preset: "fable-max" as const,
      processGeneration: claudeAuthority.processGeneration,
      profileId: profile.id,
      reasoningEffort: "max" as const,
    };
    const queued = value.store.enqueue(bound.id, "Summarise the diff");
    const evidence = value.store.beginQueueEffect({
      evidence: {
        baseline: { activeTurnId: null, providerUpdatedAt: 1_000, status: "idle" },
        clientMessageId: queued.id,
        kind: "queue.dispatch",
        messageDigest: sha256("Summarise the diff"),
        profileGeneration: claudeAuthority.processGeneration,
        providerThreadId: "thread_claude_0001",
        queueId: queued.id,
        runtimeProfile: claudeProfile,
        sessionId: bound.id,
      },
      profileGeneration: claudeAuthority.processGeneration,
      providerAuthority: claudeAuthority,
      providerConnectionId: "10000000-0000-4000-8000-000000000002",
      queueId: queued.id,
      sessionId: bound.id,
    });
    value.store.completeQueueEffect({
      accountId: profile.id,
      providerGeneration: claudeAuthority.processGeneration,
      applyResponseState: false,
      expectedEvidenceDigest: evidence.digest,
      expectedSessionRevision: bound.revision,
      providerAuthority: claudeAuthority,
      message: "Summarise the diff",
      providerConnectionId: null,
      queueId: queued.id,
      receipt: { turnId: "turn_claude_1" },
      runtimeProfile: claudeProfile,
      turnId: "turn_claude_1",
      turnStatus: "completed",
    });

    const claude = new FakeClaude();
    const remoteAuthorities: unknown[] = [];
    const commands: LocalCommand[] = [];
    const adapter = new StateBackedCloudDaemonAdapter({
      readSessionProjectionForCloud: async (sessionPublicId, signal) => {
        if (sessionPublicId === bound.id) {
          signal.throwIfAborted();
          return await readFixtureProviderSession(value, claude, sessionPublicId, signal);
        }
        return await value.codex.readSessionProjectionForCloud(sessionPublicId, signal);
      },
      executeRemote: (command, expected) => {
        commands.push(command);
        remoteAuthorities.push(expected);
        return Promise.resolve({});
      },
      paths: value.paths,
      platform: "linux",
      store: value.store,
    });
    try {
      const signal = new AbortController().signal;
      const projected = await adapter.listSessions({ limit: 25, signal });
      expect(projected.sessions.map((session) => session.publicId)).toContain(bound.id);
      expect(claude.readSessionCalls).toBe(1);
      expect(claudeAuthority.processGeneration).toBe(2);
      expect(profile.processGeneration).toBe(1);
      expect(claude.readSessionAuthorities).toMatchObject([{
        bindingGeneration: claudeAuthority.bindingGeneration,
        generation: claudeAuthority.processGeneration,
        id: profile.id,
        provider: "claude",
        providerAccountId: claudeAuthority.providerAccountId,
      }]);
      const recovery = await adapter.planCompactProjectionRecovery({
        idempotencyKey: "018bcfe5-6800-7000-8000-0000000000c1",
        sessionPublicId: bound.id,
        signal,
      });
      expect(recovery.localAuthority).toMatchObject({
        bindingGeneration: claudeAuthority.bindingGeneration,
        processGeneration: claudeAuthority.processGeneration,
        profileId: profile.id,
        provider: "claude",
        providerAccountId: claudeAuthority.providerAccountId,
        providerThreadId: "thread_claude_0001",
      });
      const authority = await adapter.resolveCommandAuthority({
        sessionPublicId: bound.id,
        signal,
      });
      expect(authority).not.toBeNull();
      for (const [idempotencyKey, payload] of [
        ["00000000-0000-7000-8000-0000000000c2", { kind: "send", message: "Continue" }],
        ["00000000-0000-7000-8000-0000000000c3", { kind: "stop" }],
      ] as const) {
        expect(await adapter.execute({
          authority: authority as CloudLocalCommandAuthority,
          idempotencyKey,
          leaseAuthority: { bootGeneration: 1, bootId: "boot_00000001", fence: 1 },
          payload,
          sessionPublicId: bound.id,
          signal,
        })).toEqual({ code: "APPLIED", state: "applied" });
      }
      expect(commands.map((command) => command.kind)).toEqual(["session.send", "session.stop"]);
      const events = await adapter.readCompactEvents({
        afterSequence: 0,
        limit: 128,
        sessionPublicId: bound.id,
        signal,
      });
      expect(events.complete).toBe(true);
      expect(events.events.map((event) => event.kind)).toEqual([
        "user_message",
        "assistant_message",
        "turn_summary",
      ]);
      // The compact format pairs `model` and `fast`; the Claude document has
      // no fast mode, so the pair stays coherent with an explicit `false`.
      expect(events.events[2]).toMatchObject({
        fast: false,
        filesTouched: ["src/index.ts"],
        kind: "turn_summary",
        model: "fable-max",
        runtimeMs: 2_374,
      });
      const commandAuthority = await adapter.resolveCommandAuthority({
        sessionPublicId: bound.id,
        signal,
      });
      expect(commandAuthority).toMatchObject({
        bindingGeneration: claudeAuthority.bindingGeneration,
        localSessionId: bound.id,
        processGeneration: 2,
        profileId: profile.id,
        provider: "claude",
        providerAccountId: claudeAuthority.providerAccountId,
        providerThreadId: "thread_claude_0001",
      });
      expect(commandAuthority).not.toHaveProperty("profileGeneration");
      expect(await adapter.execute({
        authority: commandAuthority as CloudLocalCommandAuthority,
        idempotencyKey: "00000000-0000-7000-8000-00000000c101",
        leaseAuthority: { bootGeneration: 1, bootId: "boot_00000001", fence: 1 },
        payload: { kind: "stop" },
        sessionPublicId: bound.id,
        signal,
      })).toEqual({ code: "APPLIED", state: "applied" });
      const expectedRemoteAuthority = {
        bindingGeneration: claudeAuthority.bindingGeneration,
        processGeneration: 2,
        profileId: profile.id,
        provider: "claude",
        providerAccountId: claudeAuthority.providerAccountId,
        providerThreadId: "thread_claude_0001",
        sessionId: bound.id,
      };
      expect(remoteAuthorities).toMatchObject([
        expectedRemoteAuthority,
        expectedRemoteAuthority,
        expectedRemoteAuthority,
      ]);
      expect(remoteAuthorities[0]).not.toHaveProperty("profileGeneration");

      claude.afterReadSession = () => {
        value.store.advanceProviderAccountProcessGeneration({
          expectedProcessGeneration: claudeAuthority.processGeneration,
          profileId: profile.id,
          provider: "claude",
        });
      };
      await adapter.listSessions({ limit: 25, signal });
      expect(claude.readSessionAuthorities.at(-1)).toMatchObject({
        generation: claudeAuthority.processGeneration,
        provider: "claude",
        providerAccountId: claudeAuthority.providerAccountId,
      });
      await expect(adapter.readCompactEvents({
        afterSequence: 0,
        limit: 128,
        sessionPublicId: bound.id,
        signal,
      })).rejects.toThrow("SESSION_PROVIDER_AUTHORITY_STALE");
    } finally {
      await adapter.close();
      value.store.close();
    }
  });

  test("does not read or authorize a managed Claude session on Darwin", async () => {
    const value = await fixture();
    const profile = value.store.requireProfileById(
      value.store.requireSession(value.sessionId).profileId,
    );
    const bound = value.store.upsertProviderSession({
      providerAuthority: value.store.requireProviderAccountAuthority(profile.id, "claude"),
      fastEnabled: false,
      preset: "fable-max",
      profileId: profile.id,
      provider: "claude",
      title: "Durable Claude work",
      providerThreadId: "thread_claude_darwin",
      state: "idle",
      providerAccountKey: `v1:claude:${sha256("managed-claude-darwin-account")}`,
    });
    const claude = new FakeClaude();
    const projectedSessionIds: string[] = [];
    const adapter = new StateBackedCloudDaemonAdapter({
      readSessionProjectionForCloud: async (sessionPublicId, signal) => {
        signal.throwIfAborted();
        projectedSessionIds.push(sessionPublicId);
        return sessionPublicId === bound.id
          ? await readFixtureProviderSession(value, claude, sessionPublicId, signal)
          : await value.codex.readSessionProjectionForCloud(sessionPublicId, signal);
      },
      executeRemote: () => Promise.reject(new Error("remote effect was not expected")),
      paths: value.paths,
      platform: "darwin",
      store: value.store,
    });
    try {
      const signal = new AbortController().signal;
      const projected = await adapter.listSessions({ limit: 25, signal });
      expect(projected.sessions.map((session) => session.publicId)).not.toContain(bound.id);
      expect(projectedSessionIds).not.toContain(bound.id);
      expect(claude.readSessionCalls).toBe(0);
      await expect(adapter.resolveCommandAuthority({
        sessionPublicId: bound.id,
        signal,
      })).resolves.toBeNull();
      await expect(adapter.planCompactProjectionRecovery({
        idempotencyKey: "018bcfe5-6800-7000-8000-0000000000c4",
        sessionPublicId: bound.id,
        signal,
      })).rejects.toThrow("local authority changed");
      expect(claude.readSessionCalls).toBe(0);
    } finally {
      await adapter.close();
      value.store.close();
    }
  });

  test("preserves cached retired Devin history without any provider or command effects", () => ownedCloudAdapterCase(async (
    value, { createAdapter, request, signal },
  ) => {
    const captured = canonical39DevinFixture.cases[0];
    expect(value.store.requireSession(value.sessionId)).toEqual(captured.session);
    expect(value.store.latestSessionRuntimeProfile(captured.session.id)).toEqual(captured.runtime);
    expect(value.store.readMutation(captured.idempotencyKey)).toMatchObject(captured.mutation);
    const commands: LocalCommand[] = [];
    const initial = createAdapter();
    await request(() => initial.close());
    // The source database is the unchanged archived v39 producer image before
    // real migration/boot. It contains no compact transcript. Seed only this
    // separate synthetic cache input, not historical provider output or any
    // session, runtime, login, or execution-authority row in the source store.
    const body = { kind: "assistant_message", text: "Synthetic retained offline cache.", turnId: "turn_retired_cache_0001" } as const;
    const events = [{ ...body, sequence: 1 }];
    const cache = new Database(join(value.paths.root, "cloud-projection.sqlite"), { create: false, strict: true });
    try {
      cache.transaction(() => {
        cache.query("INSERT INTO projection_sessions(session_id,next_sequence) VALUES (?,?)").run(value.sessionId, 2);
        cache.query("INSERT INTO projection_turns(session_id,turn_id,start_sequence,event_count,digest,events_json) VALUES (?,?,?,?,?,?)")
          .run(value.sessionId, body.turnId, 1, 1, sha256(JSON.stringify([body])), JSON.stringify(events));
      })();
    } finally { cache.close(false); }
    const adapter = createAdapter((command) => { commands.push(command); return Promise.resolve({}); });
    const database = new Database(value.paths.database, { create: false, strict: true });
    database.exec("PRAGMA query_only=ON");
    const originalRows = () => ({
      session: database.query("SELECT * FROM sessions WHERE id=?").get(captured.session.id),
      runtime: database.query("SELECT * FROM session_runtime_profiles WHERE session_id=? ORDER BY revision").all(captured.session.id),
      login: database.query("SELECT * FROM mutation_attempts WHERE id=?").get(captured.mutation.id),
      effect: database.query("SELECT * FROM mutation_effect_evidence WHERE attempt_id=?").get(captured.mutation.id),
      authority: database.query("SELECT * FROM session_provider_account_authorities WHERE session_id=?").get(captured.session.id),
    });
    try {
      const retained = originalRows();
      expect(retained.authority).toBeNull();
      const calls = value.codex.readSessionCalls;
      const before = await request(() => adapter.readCompactEvents({
        afterSequence: 0, limit: 128, sessionPublicId: value.sessionId, signal,
      }));
      expect(before.events.length).toBeGreaterThan(0);
      expect(before.events).toEqual(events);
      const projected = await request(() => adapter.listSessions({ limit: 25, signal }));
      expect(projected.sessions.find((session) => session.publicId === value.sessionId))
        .toMatchObject({ metadata: { retiredProvider: "devin" }, state: "terminal" });
      expect(value.codex.readSessionCalls).toBe(calls);
      expect(await request(() => adapter.resolveCommandAuthority({ sessionPublicId: value.sessionId, signal }))).toBeNull();
      expect((await request(() => adapter.readCompactEvents({
        afterSequence: 0, limit: 128, sessionPublicId: value.sessionId, signal,
      }))).events).toEqual(before.events);
      // An already-decoded, untrusted command is not retained Devin authority.
      // No modern provider tuple was issued or inserted for this historical row.
      const authority: CloudLocalCommandAuthority = {
        bindingGeneration: 1, localSessionId: captured.session.id, processGeneration: captured.generation,
        profileId: captured.profile.id, provider: "codex", providerAccountId: "acct_ffffffffffffffffffffffffffffffff",
        providerThreadId: captured.session.providerThreadId,
      };
      expect(await request(() => adapter.execute({
        authority,
        idempotencyKey: "00000000-0000-7000-8000-0000000000a4",
        leaseAuthority: { bootGeneration: value.daemonGeneration, bootId: value.daemonBootId, fence: 1 },
        payload: { kind: "send", message: "must not run" },
        sessionPublicId: value.sessionId,
        signal,
      }))).toEqual({ code: "PROVIDER_RETIRED", state: "failed" });
      expect(commands).toEqual([]);
      expect(value.codex.readSessionCalls).toBe(calls);
      expect(calls).toBe(0);
      expect(value.codex.usageCalls).toBe(0);
      expect(originalRows()).toEqual(retained);
    } finally {
      database.close(false);
    }
  }, "canonical39-devin"));

  test("projects and authorizes an actively bound personal Claude session on Darwin", async () => {
    const value = await fixture();
    const profile = value.store.createProfile("Signed-out Codex, personal Claude");
    expect(profile).toMatchObject({ processGeneration: 0, state: "signed_out" });
    const providerAuthority = value.store.advanceProviderAccountProcessGeneration({
      profileId: profile.id, provider: "claude", expectedProcessGeneration: 0,
    });
    value.store.setSessionAdoptionPolicy({ provider: "claude", profileId: profile.id });
    const candidate = value.store.upsertSessionAdoptionCandidate({
      provider: "claude",
      providerThreadId: "thread_personal_claude_darwin",
      title: "Personal Claude work",
      state: "idle",
      providerUpdatedAt: 1_000,
      liveness: "not_live",
    });
    value.store.fenceSessionAdoptionCandidateForClaim({
      provider: "claude",
      providerThreadId: candidate.providerThreadId,
      expectedRevision: candidate.revision,
    });
    const processIdentity = {
      pid: 42_701,
      pidDomain: "darwin" as const,
      procStart: "Fri Sep  4 12:00:00 2026",
    };
    value.store.recordClaimedClaudeProcessAuthority({
      providerAuthority,
      providerThreadId: candidate.providerThreadId,
      profileId: profile.id,
      profileGeneration: profile.processGeneration,
      runtimeScope: "personal",
      identity: processIdentity,
    });
    const claimed = value.store.listSessionAdoptionCandidates({ provider: "claude" })
      .find((entry) => entry.providerThreadId === candidate.providerThreadId);
    if (claimed === undefined) throw new Error("Expected the claimed personal Claude candidate.");
    const adopted = value.store.adoptSessionCandidate({
      providerAuthority,
      provider: "claude",
      providerThreadId: candidate.providerThreadId,
      expectedCandidateRevision: claimed.revision,
      profileId: profile.id,
      profileGeneration: profile.processGeneration,
      preset: "fable-max",
      requirement: presetRequirements["fable-max"],
      fastEnabled: false,
      runtimeProfile: {
        claudeVersion: "2.1.260",
        configHome: "personal",
        inputFormat: "stream-json",
        model: "claude-fable-5-1",
        observedAt: 2_100,
        outputFormat: "stream-json",
        permissionMode: "default",
        preset: "fable-max",
        processGeneration: providerAuthority.processGeneration,
        profileId: profile.id,
        reasoningEffort: "max",
      },
      providerAccountKey: `v1:claude:${sha256("personal-claude-account")}`,
      claudeProcessIdentity: processIdentity,
    });
    const claude = new FakeClaude();
    const projectedSessionIds: string[] = [];
    const commands: LocalCommand[] = [];
    const adapter = new StateBackedCloudDaemonAdapter({
      readSessionProjectionForCloud: async (sessionPublicId, signal) => {
        signal.throwIfAborted();
        projectedSessionIds.push(sessionPublicId);
        if (sessionPublicId !== adopted.session.id) {
          return await value.codex.readSessionProjectionForCloud(sessionPublicId, signal);
        }
        return {
          ...await readFixtureProviderSession(value, claude, sessionPublicId, signal),
          providerThreadId: candidate.providerThreadId,
          title: candidate.title,
        };
      },
      executeRemote: (command) => {
        commands.push(command);
        return Promise.resolve({});
      },
      paths: value.paths,
      platform: "darwin",
      store: value.store,
    });
    try {
      const signal = new AbortController().signal;
      const projected = await adapter.listSessions({ limit: 25, signal });
      const head = projected.sessions.find((session) => session.publicId === adopted.session.id);
      if (head === undefined) throw new Error("Expected the adopted Claude session projection.");
      expect(head).not.toHaveProperty("adopted");
      expect(head).not.toHaveProperty("origin");
      expect(head).not.toHaveProperty("runtimeScope");
      expect(projectedSessionIds).toContain(adopted.session.id);

      await expect(adapter.planCompactProjectionRecovery({
        idempotencyKey: "018bcfe5-6800-7000-8000-0000000000c5",
        sessionPublicId: adopted.session.id,
        signal,
      })).resolves.toMatchObject({
        localAuthority: {
          provider: "claude",
          providerAccountId: providerAuthority.providerAccountId,
          bindingGeneration: providerAuthority.bindingGeneration,
          processGeneration: providerAuthority.processGeneration,
          profileId: profile.id,
          providerThreadId: candidate.providerThreadId,
        },
      });
      const authority = await adapter.resolveCommandAuthority({
        sessionPublicId: adopted.session.id,
        signal,
      });
      expect(authority).not.toBeNull();
      await expect(adapter.execute({
        authority: authority as CloudLocalCommandAuthority,
        idempotencyKey: "00000000-0000-7000-8000-0000000000c6",
        leaseAuthority: { bootGeneration: 1, bootId: "boot_00000001", fence: 1 },
        payload: { kind: "send", message: "Continue" },
        sessionPublicId: adopted.session.id,
        signal,
      })).resolves.toEqual({ code: "APPLIED", state: "applied" });
      expect(commands.map((command) => command.kind)).toEqual(["session.send"]);

      value.store.beginPersonalSessionDetach({ sessionId: adopted.session.id });
      const readsBeforeDetachingChecks = claude.readSessionCalls;
      await expect(adapter.resolveCommandAuthority({
        sessionPublicId: adopted.session.id,
        signal,
      })).resolves.toBeNull();
      await expect(adapter.planCompactProjectionRecovery({
        idempotencyKey: "018bcfe5-6800-7000-8000-0000000000c7",
        sessionPublicId: adopted.session.id,
        signal,
      })).rejects.toThrow("local authority changed");
      await adapter.listSessions({ limit: 25, signal });
      expect(claude.readSessionCalls).toBe(readsBeforeDetachingChecks);
      await expect(adapter.execute({
        authority: authority as CloudLocalCommandAuthority,
        idempotencyKey: "00000000-0000-7000-8000-0000000000c8",
        leaseAuthority: { bootGeneration: 1, bootId: "boot_00000001", fence: 2 },
        payload: { kind: "stop" },
        sessionPublicId: adopted.session.id,
        signal,
      })).resolves.toEqual({ code: "LOCAL_AUTHORITY_CHANGED", state: "failed" });
    } finally {
      await adapter.close();
      value.store.close();
    }
  });

  test("persists bounded compact sequences and projects polled usage without exporting local paths", async () => {
    const value = await fixture();
    const commands: LocalCommand[] = [];
    let adapter = new StateBackedCloudDaemonAdapter({
      readSessionProjectionForCloud: value.codex.readSessionProjectionForCloud,
      executeRemote: (command) => { commands.push(command); return Promise.resolve({}); },
      now: () => 5_000,
      paths: value.paths,
      store: value.store,
    });
    try {
      const signal = new AbortController().signal;
      const { sessions } = await adapter.listSessions({ limit: 25, signal });
      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({
        publicId: value.sessionId,
        metadata: {
          name: "Work [local-path]",
          note: "Local checkout: [local-path]",
        },
      });
      const first = await adapter.readCompactEvents({
        afterSequence: 0,
        limit: 128,
        sessionPublicId: value.sessionId,
        signal,
      });
      expect(first.complete).toBe(true);
      expect(first.events.map((event) => event.sequence)).toEqual([1, 2, 3]);
      expect(first.events[0]).toMatchObject({ kind: "user_message", text: "Read `[local-path]`" });
      expect(JSON.stringify(first.events)).not.toContain("secret-token-value");
      expect(first.events[1]).toMatchObject({
        kind: "assistant_message",
        text: "Done [cloud projection secret omitted]",
      });
      expect(first.events[2]).toMatchObject({
        kind: "turn_summary",
        filesTouched: ["src/index.ts"],
        gitActions: [{
          kind: "status",
          label: "git status --short [cloud projection secret omitted]",
        }],
      });
      expect(first.events[2] === undefined || "model" in first.events[2]).toBe(false);
      const usage = await adapter.listUsage({ limit: 100, signal });
      expect(usage).toHaveLength(1);
      expect(usage[0]).toMatchObject({
        localReference: expect.stringMatching(/^acct_/),
        matchReference: "person@example.com",
        metadata: {
          label: "Personal `[local-path]`",
          plan: "[local-path]",
        },
        projection: {
          state: "ready",
          data: { lifetimeTokens: 42, limits: [{ name: "Primary [local-path]" }] },
        },
      });
      expect(JSON.stringify(usage)).not.toContain(privateRootFixture);
      expect(JSON.stringify(usage)).not.toContain("resetCreditsAvailable");
      expect(JSON.stringify(usage)).not.toContain("PRIVATE-RESET-CREDIT-SENTINEL");

      await adapter.close();
      adapter = new StateBackedCloudDaemonAdapter({
        readSessionProjectionForCloud: value.codex.readSessionProjectionForCloud,
        executeRemote: (command) => { commands.push(command); return Promise.resolve({}); },
        paths: value.paths,
        store: value.store,
      });
      await adapter.listSessions({ limit: 25, signal });
      const replay = await adapter.readCompactEvents({
        afterSequence: 0,
        limit: 128,
        sessionPublicId: value.sessionId,
        signal,
      });
      expect(replay.events).toEqual(first.events);
    } finally {
      await adapter.close();
      value.store.close();
    }
  });

  test("exports only usage rows for the current account after an identity change", async () => {
    const value = await fixture();
    const profile = value.store.listProfiles()[0];
    if (profile === undefined) throw new Error("missing profile fixture");
    const first = value.store.latestUsage(profile.id);
    if (first === null) throw new Error("missing usage fixture");
    const firstReceivedAt = storedAccountUsageSnapshotSchema.parse(first.payload)
      .observation.receivedAt;
    const secondEmail = "second-person@example.com";
    expect(value.store.setProfileState(
      profile.id,
      profile.processGeneration,
      "signed_in",
      { email: secondEmail, plan: "Plus" },
    )).toBe(true);
    const usageAuthority = value.store.requireProviderAccountAuthority(profile.id, "codex");
    const provider = await value.codex.readUsage();
    value.store.recordUsage(profile.id, 2, 2_000, createStoredAccountUsageSnapshot({
      accountFingerprint: sha256(secondEmail),
      daemonGeneration: 1,
      observedAt: 2_000,
      previousPayload: null,
      providerGeneration: profile.processGeneration,
      providerPayload: provider.payload,
      receivedAt: firstReceivedAt + USAGE_CLOUD_UPLOAD_MIN_INTERVAL_MS,
      sourceSequence: 2,
    }), usageAuthority);
    value.store.recordUsage(profile.id, 3, 3_000, createStoredAccountUsageSnapshot({
      accountFingerprint: sha256("person@example.com"),
      daemonGeneration: 1,
      observedAt: 3_000,
      previousPayload: first.payload,
      providerGeneration: profile.processGeneration,
      providerPayload: provider.payload,
      receivedAt: firstReceivedAt + 2 * USAGE_CLOUD_UPLOAD_MIN_INTERVAL_MS,
      sourceSequence: 3,
    }), usageAuthority);
    expect(value.store.latestUsage(profile.id)).toMatchObject({ sourceRevision: 3 });

    const adapter = new StateBackedCloudDaemonAdapter({
      readSessionProjectionForCloud: value.codex.readSessionProjectionForCloud,
      executeRemote: () => Promise.resolve({}),
      now: value.now,
      paths: value.paths,
      store: value.store,
    });
    try {
      const signal = new AbortController().signal;
      const current = await adapter.listUsage({ limit: 25, signal });
      expect(current).toHaveLength(1);
      expect(current[0]).toMatchObject({
        matchReference: secondEmail,
        sourceRevision: 2,
      });
      const history = await adapter.listUsageHistory({
        afterSourceRevision: 0,
        limit: 25,
        localReference: profile.id,
        signal,
        sourceGeneration: profile.processGeneration,
      });
      expect(history.map((snapshot) => ({
        matchReference: snapshot.matchReference,
        sourceRevision: snapshot.sourceRevision,
      }))).toEqual([{ matchReference: secondEmail, sourceRevision: 2 }]);
    } finally {
      await adapter.close();
      value.store.close();
    }
  });

  test.each([
    ["autorespond", undefined, "Continue after the recorded answer."],
    ["automation", "automation", "Continue the scheduled task."],
    ["peer_session", "peer_session", "Check the peer result."],
    ["provider_switch", "provider_switch", "Continue from the provider-neutral handoff."],
  ] as const)(
    "keeps non-owner %s messages compatible with the released actor field",
    (messageActor, actorKind, text) => ownedCloudAdapterCase(async (value, { createAdapter, request, signal }) => {
      const sourceId = "attempt_00000000-0000-4000-8000-0000000000a1";
      value.codex.projection = {
        ...value.codex.projection,
        messages: [{
          clientId: sourceId,
          role: "user",
          text,
          turnId: "turn_handoff_0001",
        }],
        turnSummaries: [{
          actions: [],
          files: [],
          id: "turn_handoff_0001",
          omittedActions: 0,
          omittedFiles: 0,
          runtimeMs: 25,
          status: "completed",
        }],
      };
      const lookups: string[] = [];
      const classify = value.store.sessionMessageActorForSource.bind(value.store);
      Object.defineProperty(value.store, "sessionMessageActorForSource", {
        configurable: true,
        value: (sessionId: SessionId, candidateSourceId: string) => {
          lookups.push(candidateSourceId);
          return candidateSourceId === sourceId
            ? messageActor
            : classify(sessionId, candidateSourceId);
        },
      });
      const adapter = createAdapter();
      await request(() => adapter.listSessions({ limit: 25, signal }));
      const projected = await request(() => adapter.readCompactEvents({
        afterSequence: 0,
        limit: 128,
        sessionPublicId: value.sessionId,
        signal,
      }));
      expect(lookups).toContain(sourceId);
      expect(projected.events[0]).toEqual({
        actor: "autorespond",
        ...(actorKind === undefined ? {} : { actorKind }),
        kind: "user_message",
        sequence: 1,
        text,
        turnId: "turn_handoff_0001",
      });
      expect(JSON.stringify(projected.events)).not.toContain("provider_switched");
    }),
  );

  test("omits only confirmed scheduled-task prompts from normal cloud projection", async () => {
    const value = await fixture();
    const privatePrompt = "SCHEDULED_TASK_PRIVATE_PROMPT_SENTINEL";
    const scheduledQueueId = await materializeScheduledTaskQueue(value, {
      idempotencyKey: "60000000-0000-4000-8000-000000000001",
      prompt: privatePrompt,
      turnId: "turn_scheduled_0001",
    });
    const ordinaryPrompt = "Ordinary queue prompt remains visible.";
    const ordinaryQueue = value.store.enqueue(value.sessionId, ordinaryPrompt);
    value.codex.projection = {
      ...value.codex.projection,
      messages: [
        {
          clientId: scheduledQueueId,
          role: "user",
          text: privatePrompt,
          turnId: "turn_scheduled_0001",
        },
        {
          role: "assistant",
          text: "Scheduled task output retained.",
          turnId: "turn_scheduled_0001",
        },
        {
          clientId: ordinaryQueue.id,
          role: "user",
          text: ordinaryPrompt,
          turnId: "turn_ordinary_queue_0001",
        },
        {
          role: "assistant",
          text: "Ordinary queue output retained.",
          turnId: "turn_ordinary_queue_0001",
        },
      ],
      turnSummaries: [
        {
          actions: [],
          files: ["src/scheduled.ts"],
          id: "turn_scheduled_0001",
          omittedActions: 0,
          omittedFiles: 0,
          runtimeMs: 50,
          status: "completed",
        },
        {
          actions: [],
          files: [],
          id: "turn_ordinary_queue_0001",
          omittedActions: 0,
          omittedFiles: 0,
          runtimeMs: 25,
          status: "completed",
        },
      ],
    };
    const adapter = new StateBackedCloudDaemonAdapter({
      readSessionProjectionForCloud: value.codex.readSessionProjectionForCloud,
      executeRemote: () => Promise.resolve({}),
      now: value.now,
      paths: value.paths,
      store: value.store,
    });
    try {
      const signal = new AbortController().signal;
      await adapter.listSessions({ limit: 25, signal });
      const projected = await adapter.readCompactEvents({
        afterSequence: 0,
        limit: 128,
        sessionPublicId: value.sessionId,
        signal,
      });
      const scheduled = projected.events.filter((event) =>
        "turnId" in event && event.turnId === "turn_scheduled_0001");
      expect(scheduled).toHaveLength(3);
      expect(scheduled[0]).toMatchObject({
        kind: "user_message",
        text: "[scheduled task prompt omitted]",
      });
      expect(scheduled[1]).toMatchObject({
        kind: "assistant_message",
        text: "Scheduled task output retained.",
      });
      expect(scheduled[2]).toMatchObject({
        filesTouched: ["src/scheduled.ts"],
        kind: "turn_summary",
        runtimeMs: 50,
      });
      expect(projected.events.find((event) =>
        event.kind === "user_message" && event.turnId === "turn_ordinary_queue_0001"))
        .toMatchObject({ text: ordinaryPrompt });
      expect(JSON.stringify(projected.events)).not.toContain(privatePrompt);
    } finally {
      await adapter.close();
      value.store.close();
    }
  });

  test("projects stable bounded local pages beyond the newest session window", async () => {
    const value = await fixture();
    const profileId = value.store.requireSession(value.sessionId).profileId;
    for (let index = 0; index < 30; index += 1) {
      value.store.upsertProviderSession({
        providerAuthority: value.store.requireProviderAccountAuthority(profileId, "codex"),
        fastEnabled: false,
        preset: "high",
        profileId,
        provider: "codex",
        providerThreadId: `thread_page_${index.toString().padStart(4, "0")}`,
        providerUpdatedAt: 2_000 + index,
        providerAccountKey: `v1:codex:${sha256("person@example.com")}`,
        state: "idle",
        title: `Paged ${index}`,
      });
    }
    const adapter = new StateBackedCloudDaemonAdapter({
      readSessionProjectionForCloud: value.codex.readSessionProjectionForCloud,
      executeRemote: () => Promise.resolve({}),
      now: value.now,
      paths: value.paths,
      store: value.store,
    });
    try {
      const observed: string[] = [];
      let afterPublicId: string | null = null;
      for (let pageNumber = 0; pageNumber < 5; pageNumber += 1) {
        const page = await adapter.listSessions({
          afterPublicId,
          limit: 10,
          signal: new AbortController().signal,
        });
        observed.push(...page.sessions.map((session) => session.publicId));
        afterPublicId = page.continueAfterPublicId;
        if (page.isDone) break;
      }
      expect(observed).toHaveLength(31);
      expect(observed).toEqual([...observed].sort());
      expect(new Set(observed).size).toBe(31);
      expect(afterPublicId).toBeNull();
    } finally {
      await adapter.close();
      value.store.close();
    }
  });

  test("projects only bounded public interaction state and follows its terminal revision", async () => {
    const value = await fixture();
    const session = value.store.requireSession(value.sessionId);
    const profile = value.store.requireProfileById(session.profileId);
    const providerAuthority = value.store.requireSessionProviderAuthority(session.id);
    const interactionId = "70000000-0000-4000-8000-000000000001";
    const providerRequestId = "provider_request_private_12345678";
    const providerTurnId = "provider_turn_private_12345678";
    const providerItemId = "provider_item_private_12345678";
    const providerApprovalId = "provider_approval_private_12345678";
    const privateFieldName = "provider_token_private";
    const privateChoice = ["sk", "secret_choice_12345678"].join("_");
    value.store.admitInteraction({
      authority: {
        approvalId: providerApprovalId,
        bindingGeneration: providerAuthority.bindingGeneration,
        connectionId: "80000000-0000-4000-8000-000000000001",
        itemId: providerItemId,
        method: "mcp/elicitation/create",
        processGeneration: profile.processGeneration,
        profileId: profile.id,
        provider: providerAuthority.provider,
        providerAccountId: providerAuthority.providerAccountId,
        requestDigest: "d".repeat(64),
        requestId: { type: "string", value: providerRequestId },
        threadId: session.providerThreadId ?? null,
        turnId: providerTurnId,
      },
      blocking: true,
      display: {
        fields: [{
          choices: [privateChoice],
          name: privateFieldName,
          required: true,
          type: "single_select",
        }],
        kind: "mcp_elicitation",
        mayContainSecrets: true,
        mode: "form",
        serverName: "private_provider_server",
        summary: `Review ${bearerFixture} at ${privateRootFixture}`,
        url: null,
      },
      kind: "mcp_elicitation",
      publicId: interactionId,
      sessionId: value.sessionId as `sess_${string}`,
    });
    const adapter = new StateBackedCloudDaemonAdapter({
      readSessionProjectionForCloud: value.codex.readSessionProjectionForCloud,
      executeRemote: () => Promise.resolve({}),
      now: value.now,
      paths: value.paths,
      store: value.store,
    });
    try {
      const signal = new AbortController().signal;
      await adapter.listSessions({ limit: 25, signal });
      const first = await adapter.readCompactEvents({
        afterSequence: 0,
        limit: 128,
        sessionPublicId: value.sessionId,
        signal,
      });
      expect(first.events.at(-1)).toEqual({
        blocking: true,
        interactionId,
        interactionKind: "mcp_elicitation",
        kind: "interaction_state",
        revision: 1,
        sequence: 4,
        state: "pending",
        ...mcpElicitationProjectedDetail,
        remotePolicy: machineOnlyRemotePolicy(1_801_000, ["MCP_ANSWER_LOCAL_ONLY"]),
        summary: "An MCP server requests protected form input",
      });
      const serialized = JSON.stringify(first.events.at(-1));
      for (const privateValue of [
        providerRequestId,
        providerTurnId,
        providerItemId,
        providerApprovalId,
        privateFieldName,
        privateChoice,
        privateRootFixture,
        bearerFixture,
        "private_provider_server",
        "d".repeat(64),
      ]) expect(serialized).not.toContain(privateValue);

      value.store.expireInteraction({ id: interactionId, expectedRevision: 1 });
      await adapter.listSessions({ limit: 25, signal });
      const terminal = await adapter.readCompactEvents({
        afterSequence: 0,
        limit: 128,
        sessionPublicId: value.sessionId,
        signal,
      });
      expect(terminal.events.at(-1)).toEqual({
        blocking: true,
        interactionId,
        interactionKind: "mcp_elicitation",
        kind: "interaction_state",
        revision: 2,
        sequence: 5,
        state: "expired",
        ...mcpElicitationProjectedDetail,
        remotePolicy: machineOnlyRemotePolicy(1_801_000, ["INTERACTION_NOT_PENDING"]),
        summary: "An MCP server requests protected form input",
      });
      await adapter.listSessions({ limit: 25, signal });
      expect((await adapter.readCompactEvents({
        afterSequence: 0,
        limit: 128,
        sessionPublicId: value.sessionId,
        signal,
      })).events).toEqual(terminal.events);
    } finally {
      await adapter.close();
      value.store.close();
    }
  });

  test("drains only an observed terminal interaction while its profile is signed out", async () => {
    const value = await fixture();
    const observedId = "70000000-0000-4000-8000-000000000201";
    const unobservedId = "70000000-0000-4000-8000-000000000202";
    admitCloudInteraction(
      value,
      observedId,
      "80000000-0000-4000-8000-000000000201",
    );
    const adapter = new StateBackedCloudDaemonAdapter({
      readSessionProjectionForCloud: value.codex.readSessionProjectionForCloud,
      executeRemote: () => Promise.resolve({}),
      now: value.now,
      paths: value.paths,
      store: value.store,
    });
    try {
      const signal = new AbortController().signal;
      await adapter.listSessions({ limit: 25, signal });
      const initial = await adapter.readCompactEvents({
        afterSequence: 0,
        limit: 128,
        sessionPublicId: value.sessionId,
        signal,
      });
      expect(initial.events.at(-1)).toMatchObject({
        interactionId: observedId,
        revision: 1,
        sequence: 4,
        state: "pending",
      });
      const initialCheckpoint = {
        cacheId: initial.cacheId,
        digest: "a".repeat(64),
        expectedHeadSequence: 0,
        expectedStreamEpoch: 0,
        headSequence: 4,
        sessionPublicId: value.sessionId,
      };
      await adapter.recordCompactUploadIntent(initialCheckpoint);
      await adapter.acknowledgeCompactUpload(initialCheckpoint);

      admitCloudInteraction(
        value,
        unobservedId,
        "80000000-0000-4000-8000-000000000202",
      );
      value.store.expireInteraction({ id: observedId, expectedRevision: 1 });
      const profile = value.store.requireProfileById(
        value.store.requireSession(value.sessionId).profileId,
      );
      expect(value.store.setProfileState(
        profile.id,
        profile.processGeneration,
        "signed_out",
      )).toBe(true);

      const readSessionCalls = value.codex.readSessionCalls;
      expect((await adapter.listSessions({ limit: 25, signal })).sessions.map(
        (session) => session.publicId,
      )).toEqual([value.sessionId]);
      expect(value.codex.readSessionCalls).toBe(readSessionCalls);
      const terminal = await adapter.readCompactEvents({
        afterSequence: 4,
        limit: 128,
        remoteTailDigest: initialCheckpoint.digest,
        sessionPublicId: value.sessionId,
        signal,
      });
      expect(terminal.events).toEqual([{
        blocking: true,
        interactionId: observedId,
        interactionKind: "mcp_elicitation",
        kind: "interaction_state",
        revision: 2,
        sequence: 5,
        state: "expired",
        ...mcpElicitationProjectedDetail,
        remotePolicy: machineOnlyRemotePolicy(1_801_000, ["INTERACTION_NOT_PENDING"]),
        summary: "An MCP server requests protected form input",
      }]);
      expect(JSON.stringify(terminal.events)).not.toContain(unobservedId);

      const terminalCheckpoint = {
        cacheId: terminal.cacheId,
        digest: "b".repeat(64),
        expectedHeadSequence: 4,
        expectedStreamEpoch: 0,
        expectedTailDigest: initialCheckpoint.digest,
        headSequence: 5,
        sessionPublicId: value.sessionId,
      };
      await adapter.recordCompactUploadIntent(terminalCheckpoint);
      expect((await adapter.listSessions({ limit: 25, signal })).sessions).toHaveLength(1);
      expect(value.codex.readSessionCalls).toBe(readSessionCalls);
      await adapter.acknowledgeCompactUpload(terminalCheckpoint);
      expect((await adapter.listSessions({ limit: 25, signal })).sessions).toEqual([]);
      expect(value.codex.readSessionCalls).toBe(readSessionCalls);
    } finally {
      await adapter.close();
      value.store.close();
    }
  });

  test("unions newest and fair observed pages without starving an older terminal revision", async () => {
    const value = await fixture();
    const oldestId = "7fffffff-ffff-4fff-8fff-ffffffffffff";
    const interactionIds = [
      oldestId,
      ...Array.from({ length: 200 }, (_, index) =>
        `70000000-0000-4000-8001-${String(index + 1).padStart(12, "0")}`),
    ];
    admitCloudInteraction(
      value,
      oldestId,
      "8fffffff-ffff-4fff-8fff-ffffffffffff",
    );
    const adapter = new StateBackedCloudDaemonAdapter({
      readSessionProjectionForCloud: value.codex.readSessionProjectionForCloud,
      executeRemote: () => Promise.resolve({}),
      paths: value.paths,
      store: value.store,
    });
    try {
      const signal = new AbortController().signal;
      await adapter.listSessions({ limit: 25, signal });
      for (const [index, interactionId] of interactionIds.slice(1).entries()) {
        admitCloudInteraction(
          value,
          interactionId,
          `80000000-0000-4000-8001-${String(index + 1).padStart(12, "0")}`,
        );
      }
      await adapter.listSessions({ limit: 25, signal });
      const initial = await adapter.readCompactEvents({
        afterSequence: 0,
        limit: 512,
        sessionPublicId: value.sessionId,
        signal,
      });
      const initialHead = initial.events.at(-1)?.sequence ?? 0;
      expect(initialHead).toBe(204);
      const initialCheckpoint = {
        cacheId: initial.cacheId,
        digest: "c".repeat(64),
        expectedHeadSequence: 0,
        expectedStreamEpoch: 0,
        headSequence: initialHead,
        sessionPublicId: value.sessionId,
      };
      await adapter.recordCompactUploadIntent(initialCheckpoint);
      await adapter.acknowledgeCompactUpload(initialCheckpoint);

      for (const interactionId of interactionIds) {
        value.store.expireInteraction({ id: interactionId, expectedRevision: 1 });
      }
      const profile = value.store.requireProfileById(
        value.store.requireSession(value.sessionId).profileId,
      );
      expect(value.store.setProfileState(
        profile.id,
        profile.processGeneration,
        "signed_out",
      )).toBe(true);

      await adapter.listSessions({ limit: 25, signal });
      const firstTerminalPage = await adapter.readCompactEvents({
        afterSequence: initialHead,
        limit: 512,
        remoteTailDigest: initialCheckpoint.digest,
        sessionPublicId: value.sessionId,
        signal,
      });
      expect(firstTerminalPage.events).toHaveLength(201);
      expect(firstTerminalPage.events.some((event) =>
        event.kind === "interaction_state" && event.interactionId === oldestId)).toBe(true);
      const firstTerminalHead = firstTerminalPage.events.at(-1)?.sequence ?? initialHead;
      const firstTerminalCheckpoint = {
        cacheId: firstTerminalPage.cacheId,
        digest: "d".repeat(64),
        expectedHeadSequence: initialHead,
        expectedStreamEpoch: 0,
        expectedTailDigest: initialCheckpoint.digest,
        headSequence: firstTerminalHead,
        sessionPublicId: value.sessionId,
      };
      await adapter.recordCompactUploadIntent(firstTerminalCheckpoint);
      await adapter.acknowledgeCompactUpload(firstTerminalCheckpoint);
      expect((await adapter.listSessions({ limit: 25, signal })).sessions).toEqual([]);
    } finally {
      await adapter.close();
      value.store.close();
    }
  });

  test("persists a fair interaction scan and reaches item 201 while the first 200 stay pending", async () => {
    const value = await fixture();
    const interactionIds = [
      "7fffffff-ffff-4fff-8ffe-ffffffffffff",
      ...Array.from({ length: 200 }, (_, index) =>
        `70000000-0000-4000-8002-${String(index + 1).padStart(12, "0")}`),
    ];
    admitCloudInteraction(
      value,
      interactionIds[0] as string,
      "80000000-0000-4000-8002-000000000001",
    );
    let adapter = new StateBackedCloudDaemonAdapter({
      readSessionProjectionForCloud: value.codex.readSessionProjectionForCloud,
      executeRemote: () => Promise.resolve({}),
      now: value.now,
      paths: value.paths,
      store: value.store,
    });
    try {
      const signal = new AbortController().signal;
      await adapter.listSessions({ limit: 25, signal });
      for (const [index, interactionId] of interactionIds.slice(1).entries()) {
        admitCloudInteraction(
          value,
          interactionId,
          `80000000-0000-4000-8002-${String(index + 2).padStart(12, "0")}`,
        );
      }
      await adapter.listSessions({ limit: 25, signal });
      const initial = await adapter.readCompactEvents({
        afterSequence: 0,
        limit: 512,
        sessionPublicId: value.sessionId,
        signal,
      });
      const pendingEvents = initial.events.filter((event) => event.kind === "interaction_state");
      expect(pendingEvents).toHaveLength(201);
      const terminalId = pendingEvents.at(-1)?.interactionId;
      expect(terminalId).toBeDefined();
      const initialHead = initial.events.at(-1)?.sequence ?? 0;
      const initialCheckpoint = {
        cacheId: initial.cacheId,
        digest: "6".repeat(64),
        expectedHeadSequence: 0,
        expectedStreamEpoch: 0,
        headSequence: initialHead,
        sessionPublicId: value.sessionId,
      };
      await adapter.recordCompactUploadIntent(initialCheckpoint);
      await adapter.acknowledgeCompactUpload(initialCheckpoint);

      value.store.expireInteraction({ id: terminalId as string, expectedRevision: 1 });
      const profile = value.store.requireProfileById(
        value.store.requireSession(value.sessionId).profileId,
      );
      expect(value.store.setProfileState(
        profile.id,
        profile.processGeneration,
        "signed_out",
      )).toBe(true);

      expect((await adapter.listSessions({ limit: 25, signal })).sessions.map(
        (session) => session.publicId,
      )).toEqual([value.sessionId]);
      await adapter.close();
      adapter = new StateBackedCloudDaemonAdapter({
        readSessionProjectionForCloud: value.codex.readSessionProjectionForCloud,
        executeRemote: () => Promise.resolve({}),
        now: value.now,
        paths: value.paths,
        store: value.store,
      });
      expect((await adapter.listSessions({ limit: 25, signal })).sessions.map(
        (session) => session.publicId,
      )).toEqual([value.sessionId]);
      const terminal = await adapter.readCompactEvents({
        afterSequence: initialHead,
        limit: 128,
        remoteTailDigest: initialCheckpoint.digest,
        sessionPublicId: value.sessionId,
        signal,
      });
      expect(terminal.events).toEqual([expect.objectContaining({
        interactionId: terminalId,
        revision: 2,
        state: "expired",
      })]);
    } finally {
      await adapter.close();
      value.store.close();
    }
  });

  test("discovers the newest page while a persisted fair history cursor continues", async () => {
    const value = await fixture();
    const interactionIds = Array.from({ length: 201 }, (_, index) =>
      `71000000-0000-4000-8005-${String(index + 1).padStart(12, "0")}`);
    for (const [index, interactionId] of interactionIds.entries()) {
      admitCloudInteraction(
        value,
        interactionId,
        `81000000-0000-4000-8005-${String(index + 1).padStart(12, "0")}`,
      );
    }
    const terminalId = interactionIds.at(-1) as string;
    value.store.expireInteraction({ id: terminalId, expectedRevision: 1 });

    let adapter = new StateBackedCloudDaemonAdapter({
      readSessionProjectionForCloud: value.codex.readSessionProjectionForCloud,
      executeRemote: () => Promise.resolve({}),
      paths: value.paths,
      store: value.store,
    });
    try {
      const signal = new AbortController().signal;
      await adapter.listSessions({ limit: 25, signal });
      const first = await adapter.readCompactEvents({
        afterSequence: 0,
        limit: 512,
        sessionPublicId: value.sessionId,
        signal,
      });
      expect(first.events.filter((event) => event.kind === "interaction_state"))
        .toHaveLength(200);

      await adapter.close();
      const newestTerminalId = "11000000-0000-4000-8005-000000000001";
      admitCloudInteraction(
        value,
        newestTerminalId,
        "21000000-0000-4000-8005-000000000001",
      );
      value.store.expireInteraction({ id: newestTerminalId, expectedRevision: 1 });
      adapter = new StateBackedCloudDaemonAdapter({
        readSessionProjectionForCloud: value.codex.readSessionProjectionForCloud,
        executeRemote: () => Promise.resolve({}),
        paths: value.paths,
        store: value.store,
      });
      await adapter.listSessions({ limit: 25, signal });
      const complete = await adapter.readCompactEvents({
        afterSequence: 0,
        limit: 512,
        sessionPublicId: value.sessionId,
        signal,
      });
      const interactions = complete.events.filter((event) => event.kind === "interaction_state");
      expect(interactions).toHaveLength(202);
      expect(interactions.find((event) => event.interactionId === terminalId)).toMatchObject({
        revision: 2,
        state: "expired",
      });
      expect(interactions.find((event) =>
        event.interactionId === newestTerminalId)).toMatchObject({
        revision: 2,
        state: "expired",
      });
    } finally {
      await adapter.close();
      value.store.close();
    }
  });

  test("freezes the interaction scan ceiling so continuous new rows cannot prevent wraparound", async () => {
    const value = await fixture();
    const firstId = "7fffffff-ffff-4fff-8ffd-ffffffffffff";
    const firstPageIds = Array.from({ length: 200 }, (_, index) =>
      `70000000-0000-4000-8004-${String(index + 1).padStart(12, "0")}`);
    const newerPageIds = Array.from({ length: 200 }, (_, index) =>
      `60000000-0000-4000-8004-${String(index + 1).padStart(12, "0")}`);
    admitCloudInteraction(
      value,
      firstId,
      "8fffffff-ffff-4fff-8ffd-ffffffffffff",
    );
    let adapter = new StateBackedCloudDaemonAdapter({
      readSessionProjectionForCloud: value.codex.readSessionProjectionForCloud,
      executeRemote: () => Promise.resolve({}),
      paths: value.paths,
      store: value.store,
    });
    try {
      const signal = new AbortController().signal;
      await adapter.listSessions({ limit: 25, signal });
      for (const [index, interactionId] of firstPageIds.entries()) {
        admitCloudInteraction(
          value,
          interactionId,
          `80000000-0000-4000-8004-${String(index + 1).padStart(12, "0")}`,
        );
      }
      await adapter.listSessions({ limit: 25, signal });
      for (const [index, interactionId] of newerPageIds.entries()) {
        admitCloudInteraction(
          value,
          interactionId,
          `90000000-0000-4000-8004-${String(index + 1).padStart(12, "0")}`,
        );
      }
      // Finish the frozen older discovery page, then wrap to the newer page.
      await adapter.listSessions({ limit: 25, signal });
      await adapter.listSessions({ limit: 25, signal });
      const initial = await adapter.readCompactEvents({
        afterSequence: 0,
        limit: 512,
        sessionPublicId: value.sessionId,
        signal,
      });
      const interactions = initial.events.filter((event) => event.kind === "interaction_state");
      expect(interactions).toHaveLength(401);
      const initialHead = initial.events.at(-1)?.sequence ?? 0;
      const checkpoint = {
        cacheId: initial.cacheId,
        digest: "7".repeat(64),
        expectedHeadSequence: 0,
        expectedStreamEpoch: 0,
        headSequence: initialHead,
        sessionPublicId: value.sessionId,
      };
      await adapter.recordCompactUploadIntent(checkpoint);
      await adapter.acknowledgeCompactUpload(checkpoint);

      value.store.expireInteraction({ id: firstId, expectedRevision: 1 });
      const profile = value.store.requireProfileById(
        value.store.requireSession(value.sessionId).profileId,
      );
      expect(value.store.setProfileState(
        profile.id,
        profile.processGeneration,
        "signed_out",
      )).toBe(true);
      expect((await adapter.listSessions({ limit: 25, signal })).sessions.map(
        (session) => session.publicId,
      )).toEqual([value.sessionId]);

      await adapter.close();
      adapter = new StateBackedCloudDaemonAdapter({
        readSessionProjectionForCloud: value.codex.readSessionProjectionForCloud,
        executeRemote: () => Promise.resolve({}),
        paths: value.paths,
        store: value.store,
      });
      expect((await adapter.listSessions({ limit: 25, signal })).sessions.map(
        (session) => session.publicId,
      )).toEqual([value.sessionId]);
      const terminal = await adapter.readCompactEvents({
        afterSequence: initialHead,
        limit: 128,
        remoteTailDigest: checkpoint.digest,
        sessionPublicId: value.sessionId,
        signal,
      });
      expect(terminal.events).toEqual([expect.objectContaining({
        interactionId: firstId,
        revision: 2,
        state: "expired",
      })]);
    } finally {
      await adapter.close();
      value.store.close();
    }
  });

  test.each([
    "epoch",
    "pending",
    "recovered_zero",
    "unsafe_sequence",
    "scan_cursor",
    "discovery_cursor",
  ] as const)(
    "withholds offline heads when the compact stream ledger is semantically incoherent: %s",
    (variant) => ownedCloudAdapterCase(
      async (value, { createAdapter, request, signal }) => {
        const cachePath = join(value.paths.root, "cloud-projection.sqlite");
        let adapter = createAdapter();
        await request(() => adapter.listSessions({ limit: 25, signal }));
        const initial = await request(() => adapter.readCompactEvents({
          afterSequence: 0,
          limit: 128,
          sessionPublicId: value.sessionId,
          signal,
        }));
        const checkpoint = {
          cacheId: initial.cacheId,
          digest: "a".repeat(64),
          expectedHeadSequence: 0,
          expectedStreamEpoch: 0,
          headSequence: initial.events.at(-1)?.sequence ?? 0,
          sessionPublicId: value.sessionId,
        };
        await request(() => adapter.recordCompactUploadIntent(checkpoint));
        await request(() => adapter.acknowledgeCompactUpload(checkpoint));
        await request(() => adapter.close());

        const database = new Database(cachePath, { strict: true });
        try {
          if (variant === "epoch") {
            database.query(
              "UPDATE projection_sessions SET stream_epoch=1 WHERE session_id=?",
            ).run(value.sessionId);
          } else if (variant === "pending") {
            database.query(
              `UPDATE projection_remote_checkpoints
               SET pending_expected_head=head_sequence,
                   pending_expected_tail=tail_digest,
                   pending_head=head_sequence+100,
                   pending_tail=?
               WHERE session_id=?`,
            ).run("b".repeat(64), value.sessionId);
          } else if (variant === "recovered_zero") {
            database.query(
              "UPDATE projection_sessions SET stream_epoch=1 WHERE session_id=?",
            ).run(value.sessionId);
            database.query(
              `UPDATE projection_remote_checkpoints
               SET stream_epoch=1,head_sequence=0,tail_digest=NULL
               WHERE session_id=?`,
            ).run(value.sessionId);
          } else if (variant === "unsafe_sequence") {
            database.query(
              `UPDATE projection_sessions SET next_sequence=9007199254740992
               WHERE session_id=?`,
            ).run(value.sessionId);
          } else if (variant === "scan_cursor") {
            database.query(
              `UPDATE projection_sessions
               SET interaction_scan_sequence=4,interaction_scan_ceiling_sequence=4
               WHERE session_id=?`,
            ).run(value.sessionId);
          } else {
            database.query(
              `UPDATE projection_sessions SET interaction_discovery_cursor=?
               WHERE session_id=?`,
            ).run("x".repeat(50), value.sessionId);
          }
        } finally {
          database.close(false);
        }
        const profile = value.store.requireProfileById(
          value.store.requireSession(value.sessionId).profileId,
        );
        expect(value.store.setProfileState(
          profile.id,
          profile.processGeneration,
          "signed_out",
        )).toBe(true);
        adapter = createAdapter();

        expect((await request(() => adapter.listSessions({ limit: 25, signal }))).sessions).toEqual([]);
        expect(adapter.projectionCacheStatus()).toMatchObject({
          affectedSessions: [value.sessionId],
          code: "STREAM_RECOVERY_REQUIRED",
          sessions: 1,
          state: "degraded",
        });
        await expect(request(() => adapter.readCompactEvents({
          afterSequence: checkpoint.headSequence,
          limit: 128,
          remoteTailDigest: checkpoint.digest,
          sessionPublicId: value.sessionId,
          signal,
        }))).rejects.toThrow("explicit, potentially history-discarding reseed");
      },
    ),
  );

  test.each(["body", "count", "sequence", "turn_id"] as const)(
    "rejects compact rows whose body, count, sequence, or turn identity changed: %s",
    (variant) => ownedCloudAdapterCase(async (value, { createAdapter, request, signal }) => {
      const cachePath = join(value.paths.root, "cloud-projection.sqlite");
      let adapter = createAdapter();
      await request(() => adapter.listSessions({ limit: 25, signal }));
      await adapter.close();
      const database = new Database(cachePath, { strict: true });
      try {
        if (variant === "body") {
          database.query(
            `UPDATE projection_turns
             SET events_json=json_set(events_json,'$[0].text','safe changed body')
             WHERE session_id=?`,
          ).run(value.sessionId);
        } else if (variant === "count") {
          database.query(
            "UPDATE projection_turns SET event_count=event_count+1 WHERE session_id=?",
          ).run(value.sessionId);
          database.query(
            "UPDATE projection_sessions SET next_sequence=next_sequence+1 WHERE session_id=?",
          ).run(value.sessionId);
        } else if (variant === "sequence") {
          database.query(
            `UPDATE projection_turns
             SET events_json=json_set(events_json,
               '$[0].sequence',2,'$[1].sequence',3,'$[2].sequence',4)
             WHERE session_id=?`,
          ).run(value.sessionId);
        } else {
          database.query(
            "UPDATE projection_turns SET turn_id='turn_tampered_0001' WHERE session_id=?",
          ).run(value.sessionId);
        }
      } finally {
        database.close(false);
      }
      adapter = createAdapter();
      await expect(request(() => adapter.readCompactEvents({
        afterSequence: 0,
        limit: 128,
        sessionPublicId: value.sessionId,
        signal,
      }))).rejects.toThrow("explicit, potentially history-discarding reseed");
      expect(adapter.projectionCacheStatus()).toMatchObject({
        affectedSessions: [value.sessionId],
        code: "STREAM_RECOVERY_REQUIRED",
        state: "degraded",
      });
    }),
  );

  test("invalidates incremental ledger trust after an external SQLite commit", async () => {
    const value = await fixture();
    const cachePath = join(value.paths.root, "cloud-projection.sqlite");
    const adapter = new StateBackedCloudDaemonAdapter({
      readSessionProjectionForCloud: value.codex.readSessionProjectionForCloud,
      executeRemote: () => Promise.resolve({}),
      paths: value.paths,
      store: value.store,
    });
    try {
      const signal = new AbortController().signal;
      await adapter.listSessions({ limit: 25, signal });
      await adapter.readCompactEvents({
        afterSequence: 0,
        limit: 128,
        sessionPublicId: value.sessionId,
        signal,
      });

      const tampered = new Database(cachePath, { strict: true });
      tampered.query(
        `UPDATE projection_turns
         SET events_json=json_set(events_json,'$[0].text','externally changed')
         WHERE session_id=?`,
      ).run(value.sessionId);
      tampered.close(false);

      await expect(adapter.readCompactEvents({
        afterSequence: 0,
        limit: 128,
        sessionPublicId: value.sessionId,
        signal,
      })).rejects.toThrow("explicit, potentially history-discarding reseed");
      expect(adapter.projectionCacheStatus()).toMatchObject({
        code: "STREAM_RECOVERY_REQUIRED",
        state: "degraded",
      });
    } finally {
      await adapter.close();
      value.store.close();
    }
  });

  test("rejects an interaction index that no longer matches the verified ledger", async () => {
    const value = await fixture();
    const interactionId = "73000000-0000-4000-8007-000000000001";
    admitCloudInteraction(
      value,
      interactionId,
      "83000000-0000-4000-8007-000000000001",
    );
    const cachePath = join(value.paths.root, "cloud-projection.sqlite");
    const adapter = new StateBackedCloudDaemonAdapter({
      readSessionProjectionForCloud: value.codex.readSessionProjectionForCloud,
      executeRemote: () => Promise.resolve({}),
      paths: value.paths,
      store: value.store,
    });
    try {
      const signal = new AbortController().signal;
      await adapter.listSessions({ limit: 25, signal });
      const tampered = new Database(cachePath, { strict: true });
      tampered.query(
        `DELETE FROM projection_interaction_index
         WHERE session_id=? AND interaction_id=?`,
      ).run(value.sessionId, interactionId);
      tampered.close(false);

      await expect(adapter.readCompactEvents({
        afterSequence: 0,
        limit: 128,
        sessionPublicId: value.sessionId,
        signal,
      })).rejects.toThrow("explicit, potentially history-discarding reseed");
      expect(adapter.projectionCacheStatus()).toMatchObject({
        code: "STREAM_RECOVERY_REQUIRED",
        state: "degraded",
      });
    } finally {
      await adapter.close();
      value.store.close();
    }
  });

  test("rejects a forged safe interaction identity before offline state lookup", async () => {
    const value = await fixture();
    const cachePath = join(value.paths.root, "cloud-projection.sqlite");
    const interactionId = "70000000-0000-4000-8003-000000000001";
    admitCloudInteraction(
      value,
      interactionId,
      "80000000-0000-4000-8003-000000000001",
    );
    let adapter = new StateBackedCloudDaemonAdapter({
      readSessionProjectionForCloud: value.codex.readSessionProjectionForCloud,
      executeRemote: () => Promise.resolve({}),
      paths: value.paths,
      store: value.store,
    });
    try {
      const signal = new AbortController().signal;
      await adapter.listSessions({ limit: 25, signal });
      await adapter.close();
      const database = new Database(cachePath, { strict: true });
      database.query(
        `UPDATE projection_turns
         SET events_json=json_set(
           events_json,'$[0].interactionId','70000000-0000-4000-8003-000000000002'
         )
         WHERE session_id=? AND json_extract(events_json,'$[0].kind')='interaction_state'`,
      ).run(value.sessionId);
      database.close(false);
      const profile = value.store.requireProfileById(
        value.store.requireSession(value.sessionId).profileId,
      );
      expect(value.store.setProfileState(
        profile.id,
        profile.processGeneration,
        "signed_out",
      )).toBe(true);
      adapter = new StateBackedCloudDaemonAdapter({
        readSessionProjectionForCloud: value.codex.readSessionProjectionForCloud,
        executeRemote: () => Promise.resolve({}),
        paths: value.paths,
        store: value.store,
      });
      expect((await adapter.listSessions({ limit: 25, signal })).sessions).toEqual([]);
      expect(adapter.projectionCacheStatus()).toMatchObject({
        affectedSessions: [value.sessionId],
        code: "STREAM_RECOVERY_REQUIRED",
        state: "degraded",
      });
    } finally {
      await adapter.close();
      value.store.close();
    }
  });

  test("pages upload history by source revision with bounded redacted projections", async () => {
    const value = await fixture();
    const profile = value.store.listProfiles()[0];
    if (profile === undefined) throw new Error("missing profile fixture");
    const head = value.store.latestUsage(profile.id);
    if (head === null) throw new Error("missing usage fixture");
    const firstReceivedAt = storedAccountUsageSnapshotSchema.parse(head.payload)
      .observation.receivedAt;
    const usageAuthority = value.store.requireProviderAccountAuthority(profile.id, "codex");
    for (const [sourceSequence, observedAt] of [[2, 9_000], [3, 8_000]] as const) {
      const provider = await value.codex.readUsage();
      value.store.recordUsage(profile.id, sourceSequence, observedAt, createStoredAccountUsageSnapshot({
        accountFingerprint: sha256("person@example.com"),
        daemonGeneration: 1,
        observedAt,
        previousPayload: null,
        providerGeneration: profile.processGeneration,
        providerPayload: provider.payload,
        receivedAt: firstReceivedAt
          + (sourceSequence - 1) * USAGE_CLOUD_UPLOAD_MIN_INTERVAL_MS,
        sourceSequence,
      }), usageAuthority);
    }
    const adapter = new StateBackedCloudDaemonAdapter({
      readSessionProjectionForCloud: value.codex.readSessionProjectionForCloud,
      executeRemote: () => Promise.resolve({}),
      paths: value.paths,
      store: value.store,
    });
    try {
      const signal = new AbortController().signal;
      const history = await adapter.listUsageHistory({
        afterSourceRevision: 1,
        limit: 2,
        localReference: profile.id,
        signal,
        sourceGeneration: profile.processGeneration,
      });

      expect(history.map((snapshot) => ({
        observedAt: snapshot.observedAt,
        sourceRevision: snapshot.sourceRevision,
      }))).toEqual([
        { observedAt: 9_000, sourceRevision: 2 },
        { observedAt: 8_000, sourceRevision: 3 },
      ]);
      expect(JSON.stringify(history)).not.toContain(privateRootFixture);
      expect(await adapter.listUsageHistory({
        afterSourceRevision: 1,
        limit: 2,
        localReference: profile.id,
        signal,
        sourceGeneration: profile.processGeneration + 1,
      })).toEqual([]);
    } finally {
      await adapter.close();
      value.store.close();
    }
  });

  test("keeps completed turn model and Fast immutable after mutable session settings change", async () => {
    const value = await fixture();
    const binding = beginTurnProfileBinding(value, { fast: false, preset: "high" });
    value.store.completeSessionTurnEffect({
      accountId: binding.profile.profileId,
      providerGeneration: binding.providerAuthority.processGeneration,
      applyResponseState: false,
      attemptId: binding.attemptId,
      expectedSessionRevision: value.store.requireSession(value.sessionId).revision,
      providerAuthority: binding.providerAuthority,
      message: binding.message,
      providerConnectionId: null,
      receipt: { turnId: "turn_0001" },
      runtimeProfile: binding.profile,
      sessionId: value.sessionId as `sess_${string}`,
      turnId: "turn_0001",
      turnStatus: "completed",
    });
    const current = value.store.requireSession(value.sessionId);
    value.store.updateSessionMetadata({
      expectedRevision: current.revision,
      fastEnabled: true,
      preset: "ultra",
      sessionId: current.id,
    });
    const adapter = new StateBackedCloudDaemonAdapter({
      readSessionProjectionForCloud: value.codex.readSessionProjectionForCloud,
      executeRemote: () => Promise.resolve({}),
      paths: value.paths,
      store: value.store,
    });
    try {
      const signal = new AbortController().signal;
      await adapter.listSessions({ limit: 25, signal });
      const first = await adapter.readCompactEvents({ afterSequence: 0, limit: 128, sessionPublicId: value.sessionId, signal });
      expect(first.events.at(-1)).toMatchObject({ fast: false, model: "high", turnId: "turn_0001" });
      await adapter.listSessions({ limit: 25, signal });
      expect(await adapter.readCompactEvents({ afterSequence: 0, limit: 128, sessionPublicId: value.sessionId, signal })).toEqual(first);
    } finally {
      await adapter.close();
      value.store.close();
    }
  });

  test("waits for an exact in-flight turn profile, then ingests it without freezing unknown metadata", async () => {
    const value = await fixture();
    const initial = value.store.requireSession(value.sessionId);
    value.store.updateSessionMetadata({
      expectedRevision: initial.revision,
      preset: "ultra",
      sessionId: initial.id,
    });
    const binding = beginTurnProfileBinding(value, { fast: true, preset: "ultra" });
    value.codex.projection = {
      ...value.codex.projection,
      messages: (value.codex.projection.messages ?? []).map((message) =>
        message.role === "user" ? { ...message, clientId: binding.attemptId } : message),
    };
    const adapter = new StateBackedCloudDaemonAdapter({
      readSessionProjectionForCloud: value.codex.readSessionProjectionForCloud,
      executeRemote: () => Promise.resolve({}),
      paths: value.paths,
      store: value.store,
    });
    try {
      const signal = new AbortController().signal;
      await adapter.listSessions({ limit: 25, signal });
      expect((await adapter.readCompactEvents({ afterSequence: 0, limit: 128, sessionPublicId: value.sessionId, signal })).events).toEqual([]);
      value.store.completeSessionTurnEffect({
        accountId: binding.profile.profileId,
        providerGeneration: binding.providerAuthority.processGeneration,
        applyResponseState: false,
        attemptId: binding.attemptId,
        expectedSessionRevision: value.store.requireSession(value.sessionId).revision,
        providerAuthority: binding.providerAuthority,
        message: binding.message,
        providerConnectionId: null,
        receipt: { turnId: "turn_0001" },
        runtimeProfile: binding.profile,
        sessionId: value.sessionId as `sess_${string}`,
        turnId: "turn_0001",
        turnStatus: "completed",
      });
      await adapter.listSessions({ limit: 25, signal });
      expect((await adapter.readCompactEvents({ afterSequence: 0, limit: 128, sessionPublicId: value.sessionId, signal })).events.at(-1))
        .toMatchObject({ fast: true, model: "ultra" });
    } finally {
      await adapter.close();
      value.store.close();
    }
  });

  test("defers only explicitly incomplete completed turns and ingests them once complete", async () => {
    const value = await fixture();
    value.codex.projection = {
      ...value.codex.projection,
      omission: {
        hasMoreOlderTurns: false,
        incompleteTurnIds: ["turn_0001"],
        omittedMessages: 0,
        returnedTurns: 1,
        truncatedMessages: 0,
        turnLimit: 100,
        unreadItemTurnIds: ["turn_0001"],
      },
    };
    const adapter = new StateBackedCloudDaemonAdapter({
      readSessionProjectionForCloud: value.codex.readSessionProjectionForCloud,
      executeRemote: () => Promise.resolve({}),
      paths: value.paths,
      store: value.store,
    });
    try {
      const signal = new AbortController().signal;
      await adapter.listSessions({ limit: 25, signal });
      expect((await adapter.readCompactEvents({ afterSequence: 0, limit: 128, sessionPublicId: value.sessionId, signal })).events).toEqual([]);
      value.codex.projection = {
        ...value.codex.projection,
        omission: {
          hasMoreOlderTurns: false,
          incompleteTurnIds: [],
          omittedMessages: 0,
          returnedTurns: 1,
          truncatedMessages: 0,
          turnLimit: 100,
          unreadItemTurnIds: ["turn_0001"],
        },
      };
      await adapter.listSessions({ limit: 25, signal });
      expect((await adapter.readCompactEvents({ afterSequence: 0, limit: 128, sessionPublicId: value.sessionId, signal })).events)
        .toHaveLength(3);
    } finally {
      await adapter.close();
      value.store.close();
    }
  });

  test("reads an offline projection cache with bounded rows and transport bytes", async () => {
    const value = await fixture();
    const cachePath = join(value.paths.root, "cloud-projection.sqlite");
    const initial = new StateBackedCloudDaemonAdapter({
      readSessionProjectionForCloud: value.codex.readSessionProjectionForCloud,
      executeRemote: () => Promise.resolve({}),
      paths: value.paths,
      store: value.store,
    });
    await initial.close();
    const database = new Database(cachePath, { strict: true });
    database.query("INSERT INTO projection_sessions(session_id,next_sequence) VALUES (?,?)")
      .run(value.sessionId, 41);
    const insert = database.query(
      "INSERT INTO projection_turns(session_id,turn_id,start_sequence,event_count,digest,events_json) VALUES (?,?,?,?,?,?)",
    );
    for (let sequence = 1; sequence <= 40; sequence += 1) {
      const body = {
        kind: "assistant_message",
        text: "x".repeat(60_000),
        turnId: `turn_cache_${String(sequence).padStart(4, "0")}`,
      } as const;
      insert.run(
        value.sessionId,
        body.turnId,
        sequence,
        1,
        sha256(JSON.stringify([body])),
        JSON.stringify([{ ...body, sequence }]),
      );
    }
    database.close(false);
    const adapter = new StateBackedCloudDaemonAdapter({
      readSessionProjectionForCloud: value.codex.readSessionProjectionForCloud,
      executeRemote: () => Promise.resolve({}),
      paths: value.paths,
      store: value.store,
    });
    try {
      const signal = new AbortController().signal;
      const first = await adapter.readCompactEvents({ afterSequence: 0, limit: 128, sessionPublicId: value.sessionId, signal });
      expect(first.complete).toBe(false);
      expect(first.events.map((event) => event.sequence)).toEqual([1, 2, 3, 4]);
      expect(new TextEncoder().encode(JSON.stringify(first.events)).byteLength)
        .toBeLessThanOrEqual(cloudLimits.detailChunkBytes);
      const seen = [...first.events];
      let page = first;
      let remoteHead = 0;
      let remoteTailDigest: string | undefined;
      let upload = 0;
      while (!page.complete) {
        const headSequence = seen.at(-1)?.sequence ?? 0;
        const digest = `${"a".repeat(63)}${String(upload % 10)}`;
        const checkpoint = {
          cacheId: page.cacheId,
          digest,
          expectedHeadSequence: remoteHead,
          expectedStreamEpoch: 0,
          ...(remoteTailDigest === undefined ? {} : { expectedTailDigest: remoteTailDigest }),
          headSequence,
          sessionPublicId: value.sessionId,
        };
        await adapter.recordCompactUploadIntent(checkpoint);
        await adapter.acknowledgeCompactUpload(checkpoint);
        remoteHead = headSequence;
        remoteTailDigest = digest;
        upload += 1;
        page = await adapter.readCompactEvents({
          afterSequence: remoteHead,
          limit: 128,
          remoteTailDigest,
          sessionPublicId: value.sessionId,
          signal,
        });
        seen.push(...page.events);
      }
      expect(seen.map((event) => event.sequence)).toEqual(
        Array.from({ length: 40 }, (_, index) => index + 1),
      );
    } finally {
      await adapter.close();
      value.store.close();
    }
  });

  test("quarantines a recreated projection stream against a nonzero remote head without aliasing sequences", async () => {
    const value = await fixture();
    const commands: LocalCommand[] = [];
    const adapter = new StateBackedCloudDaemonAdapter({
      readSessionProjectionForCloud: value.codex.readSessionProjectionForCloud,
      executeRemote: (command) => { commands.push(command); return Promise.resolve({}); },
      now: value.now,
      paths: value.paths,
      store: value.store,
    });
    try {
      const signal = new AbortController().signal;
      await adapter.listSessions({ limit: 25, signal });
      await expect(adapter.readCompactEvents({
        afterSequence: 300,
        limit: 128,
        remoteTailDigest: "b".repeat(64),
        sessionPublicId: value.sessionId,
        signal,
      })).rejects.toThrow("explicit, potentially history-discarding reseed");
      expect(adapter.projectionCacheStatus()).toMatchObject({
        affectedSessions: [value.sessionId],
        affectedSessionsTruncated: false,
        code: "STREAM_RECOVERY_REQUIRED",
        sessions: 1,
        state: "degraded",
      });
      expect(await adapter.listUsage({ limit: 100, signal })).toHaveLength(1);
      const authority = await adapter.resolveCommandAuthority({
        sessionPublicId: value.sessionId,
        signal,
      });
      expect(await adapter.execute({
        authority: authority as CloudLocalCommandAuthority,
        idempotencyKey: "00000000-0000-7000-8000-000000000009",
        leaseAuthority: { bootGeneration: 1, bootId: "boot_00000001", fence: 1 },
        payload: { kind: "stop" },
        sessionPublicId: value.sessionId,
        signal,
      })).toEqual({ code: "APPLIED", state: "applied" });
      expect(commands).toHaveLength(1);
      await expect(adapter.readCompactEvents({
        afterSequence: 300,
        limit: 128,
        remoteTailDigest: "b".repeat(64),
        sessionPublicId: value.sessionId,
        signal,
      })).rejects.toThrow("explicit, potentially history-discarding reseed");
    } finally {
      await adapter.close();
      value.store.close();
    }
  });

  test("reports cache unavailability when recovery activation fails after closing the source", async () => {
    const value = await fixture();
    const cachePath = join(value.paths.root, "cloud-projection.sqlite");
    const adapter = new StateBackedCloudDaemonAdapter({
      readSessionProjectionForCloud: value.codex.readSessionProjectionForCloud,
      executeRemote: () => Promise.resolve({}),
      paths: value.paths,
      store: value.store,
    });
    try {
      const signal = new AbortController().signal;
      await adapter.listSessions({ limit: 25, signal });
      await expect(adapter.readCompactEvents({
        afterSequence: 300,
        limit: 128,
        remoteTailDigest: "b".repeat(64),
        sessionPublicId: value.sessionId,
        signal,
      })).rejects.toThrow("explicit, potentially history-discarding reseed");

      const idempotencyKey = "00000000-0000-7000-8000-00000000071a";
      const plan = await adapter.planCompactProjectionRecovery({
        idempotencyKey,
        sessionPublicId: value.sessionId,
        signal,
      });
      const installation = {
        ...plan,
        boundaryHeadSequence: 300,
        boundaryTailDigest: "b".repeat(64),
        compactStreamEpoch: 1,
        idempotencyKey,
        signal,
      } as const;
      await adapter.stageCompactProjectionRecovery(installation);
      await writeFile(
        `${cachePath}.quarantine-${idempotencyKey}`,
        "safe conflict",
        { mode: 0o600 },
      );

      await expect(adapter.activateCompactProjectionRecovery(installation))
        .rejects.toThrow("quarantine conflicts");
      expect(adapter.projectionCacheStatus()).toMatchObject({
        code: "CACHE_RECOVERY_IN_PROGRESS",
        state: "unavailable",
      });
      await expect(adapter.readCompactEvents({
        afterSequence: 300,
        limit: 128,
        remoteStreamEpoch: 1,
        remoteTailDigest: "b".repeat(64),
        sessionPublicId: value.sessionId,
        signal,
      })).rejects.toThrow("awaiting exact local cache activation");
    } finally {
      await adapter.close();
      value.store.close();
    }
  });

  test("recovers at the global remote head and omits later scheduled-task prompts", async () => {
    const value = await fixture();
    const adapter = new StateBackedCloudDaemonAdapter({
      readSessionProjectionForCloud: value.codex.readSessionProjectionForCloud,
      executeRemote: () => Promise.resolve({}),
      paths: value.paths,
      store: value.store,
    });
    try {
      const signal = new AbortController().signal;
      await adapter.listSessions({ limit: 25, signal });
      expect(value.codex.readSessionCalls).toBe(1);
      const idempotencyKey = "00000000-0000-7000-8000-000000000701";
      const plan = await adapter.planCompactProjectionRecovery({
        idempotencyKey,
        sessionPublicId: value.sessionId,
        signal,
      });
      expect(value.codex.readSessionCalls).toBe(2);
      expect(plan.baselineCompletedTurns).toHaveLength(1);
      const installation = {
        ...plan,
        boundaryHeadSequence: 300,
        boundaryTailDigest: "b".repeat(64),
        compactStreamEpoch: 1,
        idempotencyKey,
        signal,
      } as const;
      await adapter.stageCompactProjectionRecovery(installation);
      await adapter.activateCompactProjectionRecovery(installation);
      await adapter.listSessions({ limit: 25, signal });
      const baseline = await adapter.readCompactEvents({
        afterSequence: 300,
        limit: 128,
        remoteStreamEpoch: 1,
        remoteTailDigest: "b".repeat(64),
        sessionPublicId: value.sessionId,
        signal,
      });
      expect(baseline).toMatchObject({ complete: true, events: [] });
      expect(baseline.cacheId).toBe(plan.replacementCacheId);

      const privatePrompt = "RECOVERY_SCHEDULED_TASK_PRIVATE_PROMPT_SENTINEL";
      await materializeScheduledTaskQueue(value, {
        idempotencyKey: "60000000-0000-4000-8000-000000000002",
        prompt: privatePrompt,
        turnId: "turn_0002",
      });
      value.codex.projection = {
        ...value.codex.projection,
        messages: [
          ...(value.codex.projection.messages ?? []),
          {
            role: "user",
            text: privatePrompt,
            turnId: "turn_0002",
          },
          { role: "assistant", text: "Future scheduled output", turnId: "turn_0002" },
        ],
        turnSummaries: [
          ...(value.codex.projection.turnSummaries ?? []),
          {
            actions: [],
            files: [],
            id: "turn_0002",
            omittedActions: 0,
            omittedFiles: 0,
            runtimeMs: 25,
            status: "completed",
          },
        ],
      };
      await adapter.listSessions({ limit: 25, signal });
      const future = await adapter.readCompactEvents({
        afterSequence: 300,
        limit: 128,
        remoteStreamEpoch: 1,
        remoteTailDigest: "b".repeat(64),
        sessionPublicId: value.sessionId,
        signal,
      });
      expect(future.events.map((event) => event.sequence)).toEqual([301, 302, 303]);
      expect(future.events.map((event) => "turnId" in event ? event.turnId : null)).toEqual([
        "turn_0002",
        "turn_0002",
        "turn_0002",
      ]);
      expect(future.events[0]).toMatchObject({
        kind: "user_message",
        text: "[scheduled task prompt omitted]",
      });
      expect(future.events[1]).toMatchObject({
        kind: "assistant_message",
        text: "Future scheduled output",
      });
      expect(future.events[2]).toMatchObject({ kind: "turn_summary", runtimeMs: 25 });
      expect(JSON.stringify(future.events)).not.toContain(privatePrompt);
    } finally {
      await adapter.close();
      value.store.close();
    }
  });

  test("replays recovery with the current terminal revision of an old cloud interaction", async () => {
    const value = await fixture();
    const session = value.store.requireSession(value.sessionId);
    const profile = value.store.requireProfileById(session.profileId);
    const providerAuthority = value.store.requireSessionProviderAuthority(session.id);
    const interactionId = "70000000-0000-4000-8000-000000000101";
    const privateRequestId = "provider_request_private_recovery";
    value.store.admitInteraction({
      authority: {
        approvalId: "provider_approval_private_recovery",
        bindingGeneration: providerAuthority.bindingGeneration,
        connectionId: "80000000-0000-4000-8000-000000000101",
        itemId: "provider_item_private_recovery",
        method: "mcp/elicitation/create",
        processGeneration: profile.processGeneration,
        profileId: profile.id,
        provider: providerAuthority.provider,
        providerAccountId: providerAuthority.providerAccountId,
        requestDigest: "d".repeat(64),
        requestId: { type: "string", value: privateRequestId },
        threadId: session.providerThreadId ?? null,
        turnId: "provider_turn_private_recovery",
      },
      blocking: true,
      display: {
        fields: [{
          choices: ["sk_secret_answer"],
          name: "provider_token_private",
          required: true,
          type: "single_select",
        }],
        kind: "mcp_elicitation",
        mayContainSecrets: true,
        mode: "form",
        serverName: "private_provider_server",
        summary: `Review ${bearerFixture} at ${privateRootFixture}`,
        url: null,
      },
      kind: "mcp_elicitation",
      publicId: interactionId,
      sessionId: value.sessionId as `sess_${string}`,
    });
    let adapter = new StateBackedCloudDaemonAdapter({
      readSessionProjectionForCloud: value.codex.readSessionProjectionForCloud,
      executeRemote: () => Promise.resolve({}),
      now: value.now,
      paths: value.paths,
      store: value.store,
    });
    try {
      const signal = new AbortController().signal;
      await adapter.listSessions({ limit: 25, signal });
      expect((await adapter.readCompactEvents({
        afterSequence: 0,
        limit: 128,
        sessionPublicId: value.sessionId,
        signal,
      })).events.at(-1)).toMatchObject({
        interactionId,
        revision: 1,
        state: "pending",
      });
      value.store.expireInteraction({ id: interactionId, expectedRevision: 1 });

      const idempotencyKey = "00000000-0000-7000-8000-000000000711";
      const plan = await adapter.planCompactProjectionRecovery({
        idempotencyKey,
        observedInteractionIds: [interactionId],
        sessionPublicId: value.sessionId,
        signal,
      });
      expect(plan.baselineInteractions).toEqual([{
        blocking: true,
        interactionId,
        interactionKind: "mcp_elicitation",
        revision: 2,
        state: "expired",
        ...mcpElicitationProjectedDetail,
        remotePolicy: machineOnlyRemotePolicy(1_801_000, ["INTERACTION_NOT_PENDING"]),
        summary: "An MCP server requests protected form input",
      }]);
      const installation = {
        ...plan,
        boundaryHeadSequence: 300,
        boundaryTailDigest: "b".repeat(64),
        compactStreamEpoch: 1,
        idempotencyKey,
        signal,
      } as const;
      await adapter.stageCompactProjectionRecovery(installation);

      await adapter.close();
      adapter = new StateBackedCloudDaemonAdapter({
        readSessionProjectionForCloud: value.codex.readSessionProjectionForCloud,
        executeRemote: () => Promise.resolve({}),
        now: value.now,
        paths: value.paths,
        store: value.store,
      });
      await adapter.stageCompactProjectionRecovery(installation);
      await adapter.activateCompactProjectionRecovery(installation);
      await adapter.listSessions({ limit: 25, signal });
      const recovered = await adapter.readCompactEvents({
        afterSequence: 300,
        limit: 128,
        remoteStreamEpoch: 1,
        remoteTailDigest: "b".repeat(64),
        sessionPublicId: value.sessionId,
        signal,
      });
      expect(recovered).toMatchObject({ complete: true });
      expect(recovered.events).toEqual([{
        blocking: true,
        interactionId,
        interactionKind: "mcp_elicitation",
        kind: "interaction_state",
        revision: 2,
        sequence: 301,
        state: "expired",
        ...mcpElicitationProjectedDetail,
        remotePolicy: machineOnlyRemotePolicy(1_801_000, ["INTERACTION_NOT_PENDING"]),
        summary: "An MCP server requests protected form input",
      }]);

      await adapter.close();
      adapter = new StateBackedCloudDaemonAdapter({
        readSessionProjectionForCloud: value.codex.readSessionProjectionForCloud,
        executeRemote: () => Promise.resolve({}),
        paths: value.paths,
        store: value.store,
      });
      const replay = await adapter.readCompactEvents({
        afterSequence: 300,
        limit: 128,
        remoteStreamEpoch: 1,
        remoteTailDigest: "b".repeat(64),
        sessionPublicId: value.sessionId,
        signal,
      });
      expect(replay.events).toEqual(recovered.events);
      for (const privateValue of [
        privateRequestId,
        "provider_approval_private_recovery",
        "provider_item_private_recovery",
        "provider_turn_private_recovery",
        "provider_token_private",
        "sk_secret_answer",
        "private_provider_server",
        privateRootFixture,
        bearerFixture,
        "d".repeat(64),
      ]) expect(JSON.stringify(replay.events)).not.toContain(privateValue);
    } finally {
      await adapter.close();
      value.store.close();
    }
  });

  test("never baselines an explicitly incomplete turn and ingests it after recovery", async () => {
    const value = await fixture();
    value.codex.projection = {
      ...value.codex.projection,
      omission: {
        hasMoreOlderTurns: true,
        incompleteTurnIds: ["turn_0001"],
        omittedMessages: 0,
        returnedTurns: 1,
        truncatedMessages: 0,
        turnLimit: 24,
        unreadItemTurnIds: ["turn_0001"],
      },
    };
    const adapter = new StateBackedCloudDaemonAdapter({
      readSessionProjectionForCloud: value.codex.readSessionProjectionForCloud,
      executeRemote: () => Promise.resolve({}),
      paths: value.paths,
      store: value.store,
    });
    try {
      const signal = new AbortController().signal;
      const idempotencyKey = "00000000-0000-7000-8000-000000000702";
      const plan = await adapter.planCompactProjectionRecovery({
        idempotencyKey,
        sessionPublicId: value.sessionId,
        signal,
      });
      expect(plan.baselineCompletedTurns).toEqual([]);
      const installation = {
        ...plan,
        boundaryHeadSequence: 9,
        boundaryTailDigest: "c".repeat(64),
        compactStreamEpoch: 2,
        idempotencyKey,
        signal,
      } as const;
      await adapter.stageCompactProjectionRecovery(installation);
      await adapter.activateCompactProjectionRecovery(installation);
      value.codex.projection = {
        ...value.codex.projection,
        omission: {
          ...value.codex.projection.omission,
          incompleteTurnIds: [],
        } as NonNullable<CodexSessionProjection["omission"]>,
      };
      await adapter.listSessions({ limit: 25, signal });
      expect((await adapter.readCompactEvents({
        afterSequence: 9,
        limit: 128,
        remoteStreamEpoch: 2,
        remoteTailDigest: "c".repeat(64),
        sessionPublicId: value.sessionId,
        signal,
      })).events.map((event) => event.sequence)).toEqual([10, 11, 12]);
    } finally {
      await adapter.close();
      value.store.close();
    }
  });

  test("baselines only fully read completed turns", async () => {
    const value = await fixture();
    value.codex.projection = {
      ...value.codex.projection,
      omission: {
        hasMoreOlderTurns: true,
        incompleteTurnIds: [],
        omittedMessages: 0,
        returnedTurns: 3,
        truncatedMessages: 0,
        turnLimit: 24,
        unreadItemTurnIds: ["turn_0001"],
      },
      turnSummaries: [
        ...(value.codex.projection.turnSummaries ?? []),
        {
          actions: [],
          files: [],
          id: "turn_failed_0002",
          omittedActions: 0,
          omittedFiles: 0,
          status: "failed",
        },
        {
          actions: [],
          files: [],
          id: "turn_interrupted_0003",
          omittedActions: 0,
          omittedFiles: 0,
          status: "interrupted",
        },
      ],
    };
    const adapter = new StateBackedCloudDaemonAdapter({
      readSessionProjectionForCloud: value.codex.readSessionProjectionForCloud,
      executeRemote: () => Promise.resolve({}),
      paths: value.paths,
      store: value.store,
    });
    try {
      const plan = await adapter.planCompactProjectionRecovery({
        idempotencyKey: "00000000-0000-7000-8000-00000000070a",
        sessionPublicId: value.sessionId,
        signal: new AbortController().signal,
      });
      expect(plan.baselineCompletedTurns).toEqual([]);
    } finally {
      await adapter.close();
      value.store.close();
    }
  });

  test("preserves a corrupt cache in quarantine and atomically activates a fresh ledger", async () => {
    const value = await fixture();
    const cachePath = join(value.paths.root, "cloud-projection.sqlite");
    const corruptBytes = "corrupt projection sentinel";
    await writeFile(cachePath, corruptBytes, { mode: 0o600 });
    const adapter = new StateBackedCloudDaemonAdapter({
      readSessionProjectionForCloud: value.codex.readSessionProjectionForCloud,
      executeRemote: () => Promise.resolve({}),
      paths: value.paths,
      store: value.store,
    });
    try {
      expect(adapter.projectionCacheStatus()).toMatchObject({
        code: "CACHE_CORRUPT_OR_UNREADABLE",
        state: "unavailable",
      });
      const signal = new AbortController().signal;
      const idempotencyKey = "00000000-0000-7000-8000-000000000703";
      const plan = await adapter.planCompactProjectionRecovery({
        idempotencyKey,
        sessionPublicId: value.sessionId,
        signal,
      });
      expect(plan.sourceCacheId).toBeNull();
      const installation = {
        ...plan,
        boundaryHeadSequence: 5,
        boundaryTailDigest: "d".repeat(64),
        compactStreamEpoch: 1,
        idempotencyKey,
        signal,
      } as const;
      await adapter.stageCompactProjectionRecovery(installation);
      await adapter.activateCompactProjectionRecovery(installation);
      expect(adapter.projectionCacheStatus()).toEqual({ state: "ready" });
      expect(await readFile(
        `${cachePath}.quarantine-${idempotencyKey}`,
        "utf8",
      )).toBe(corruptBytes);
      expect((await adapter.readCompactEvents({
        afterSequence: 5,
        limit: 128,
        remoteStreamEpoch: 1,
        remoteTailDigest: "d".repeat(64),
        sessionPublicId: value.sessionId,
        signal,
      })).cacheId).toBe(plan.replacementCacheId);
    } finally {
      await adapter.close();
      value.store.close();
    }
  });

  test("refuses to overwrite a newer cache that replaces the planned corrupt source", async () => {
    const value = await fixture();
    const cachePath = join(value.paths.root, "cloud-projection.sqlite");
    await writeFile(cachePath, "corrupt projection sentinel", { mode: 0o600 });
    const adapter = new StateBackedCloudDaemonAdapter({
      readSessionProjectionForCloud: value.codex.readSessionProjectionForCloud,
      executeRemote: () => Promise.resolve({}),
      paths: value.paths,
      store: value.store,
    });
    const idempotencyKey = "00000000-0000-7000-8000-00000000070b";
    try {
      const signal = new AbortController().signal;
      const plan = await adapter.planCompactProjectionRecovery({
        idempotencyKey,
        sessionPublicId: value.sessionId,
        signal,
      });
      const installation = {
        ...plan,
        boundaryHeadSequence: 5,
        boundaryTailDigest: "d".repeat(64),
        compactStreamEpoch: 1,
        idempotencyKey,
        signal,
      } as const;
      await adapter.stageCompactProjectionRecovery(installation);
      await rm(cachePath);
      const replacement = new Database(cachePath, { create: true, strict: true });
      replacement.exec("PRAGMA user_version=6");
      replacement.close(false);
      await chmod(cachePath, 0o600);

      await expect(adapter.activateCompactProjectionRecovery(installation))
        .rejects.toThrow("newer Oompa version");
      const preserved = new Database(cachePath, { strict: true });
      expect((preserved.query("PRAGMA user_version").get() as { user_version: number })
        .user_version).toBe(6);
      preserved.close(false);
      expect((await readdir(value.paths.root)).some((name) =>
        name.includes(`quarantine-${idempotencyKey}`))).toBe(false);
    } finally {
      await adapter.close();
      value.store.close();
    }
  });

  test("refuses a same-user pathname replacement of the active source cache", async () => {
    const value = await fixture();
    const cachePath = join(value.paths.root, "cloud-projection.sqlite");
    const movedPath = join(value.paths.root, "cloud-projection-original.sqlite");
    const adapter = new StateBackedCloudDaemonAdapter({
      readSessionProjectionForCloud: value.codex.readSessionProjectionForCloud,
      executeRemote: () => Promise.resolve({}),
      paths: value.paths,
      store: value.store,
    });
    const idempotencyKey = "00000000-0000-7000-8000-00000000070c";
    try {
      const signal = new AbortController().signal;
      const plan = await adapter.planCompactProjectionRecovery({
        idempotencyKey,
        sessionPublicId: value.sessionId,
        signal,
      });
      const installation = {
        ...plan,
        boundaryHeadSequence: 5,
        boundaryTailDigest: "e".repeat(64),
        compactStreamEpoch: 1,
        idempotencyKey,
        signal,
      } as const;
      await adapter.stageCompactProjectionRecovery(installation);

      await rename(cachePath, movedPath);
      await copyFile(movedPath, cachePath);
      await chmod(cachePath, 0o600);
      const replacementIdentity = await lstat(cachePath);
      expect(replacementIdentity.ino).not.toBe((await lstat(movedPath)).ino);

      await expect(adapter.activateCompactProjectionRecovery(installation))
        .rejects.toThrow("pathname changed");
      expect((await lstat(cachePath)).ino).toBe(replacementIdentity.ino);
      expect((await readdir(value.paths.root)).some((name) =>
        name.includes(`quarantine-${idempotencyKey}`))).toBe(false);
      expect((await readdir(value.paths.root)).some((name) =>
        name.includes(`recovery-${idempotencyKey}`))).toBe(true);
      await adapter.discardCompactProjectionRecovery({
        idempotencyKey,
        sessionPublicId: value.sessionId,
      });
      expect((await readdir(value.paths.root)).some((name) =>
        name.includes(`recovery-${idempotencyKey}`))).toBe(false);
      expect((await lstat(cachePath)).ino).toBe(replacementIdentity.ino);
    } finally {
      await adapter.close();
      value.store.close();
    }
  });

  test("reopens the exact installed cache before acknowledging activation replay", async () => {
    const value = await fixture();
    const cachePath = join(value.paths.root, "cloud-projection.sqlite");
    const movedPath = join(value.paths.root, "cloud-projection-installed.sqlite");
    const adapter = new StateBackedCloudDaemonAdapter({
      readSessionProjectionForCloud: value.codex.readSessionProjectionForCloud,
      executeRemote: () => Promise.resolve({}),
      paths: value.paths,
      store: value.store,
    });
    const idempotencyKey = "00000000-0000-7000-8000-00000000070d";
    try {
      const signal = new AbortController().signal;
      const plan = await adapter.planCompactProjectionRecovery({
        idempotencyKey,
        sessionPublicId: value.sessionId,
        signal,
      });
      const installation = {
        ...plan,
        boundaryHeadSequence: 5,
        boundaryTailDigest: "f".repeat(64),
        compactStreamEpoch: 1,
        idempotencyKey,
        signal,
      } as const;
      await adapter.stageCompactProjectionRecovery(installation);
      await adapter.activateCompactProjectionRecovery(installation);

      await rename(cachePath, movedPath);
      await copyFile(movedPath, cachePath);
      await chmod(cachePath, 0o600);
      const replacementIdentity = await lstat(cachePath);

      await expect(adapter.activateCompactProjectionRecovery(installation))
        .rejects.toThrow("pathname changed");
      expect((await lstat(cachePath)).ino).toBe(replacementIdentity.ino);
      expect((await readdir(value.paths.root)).some((name) =>
        name.includes(`quarantine-${idempotencyKey}`))).toBe(true);
    } finally {
      await adapter.close();
      value.store.close();
    }
  });

  test("attests the source pathname and rebuilds partial or retried staging from that source", async () => {
    const value = await fixture();
    const cachePath = join(value.paths.root, "cloud-projection.sqlite");
    const originalPath = join(value.paths.root, "cloud-projection-source.sqlite");
    let adapter = new StateBackedCloudDaemonAdapter({
      readSessionProjectionForCloud: value.codex.readSessionProjectionForCloud,
      executeRemote: () => Promise.resolve({}),
      paths: value.paths,
      store: value.store,
    });
    const idempotencyKey = "00000000-0000-7000-8000-00000000070e";
    try {
      const signal = new AbortController().signal;
      const plan = await adapter.planCompactProjectionRecovery({
        idempotencyKey,
        sessionPublicId: value.sessionId,
        signal,
      });
      const installation = {
        ...plan,
        boundaryHeadSequence: 5,
        boundaryTailDigest: "1".repeat(64),
        compactStreamEpoch: 1,
        idempotencyKey,
        signal,
      } as const;

      await rename(cachePath, originalPath);
      await copyFile(originalPath, cachePath);
      await chmod(cachePath, 0o600);
      await expect(adapter.stageCompactProjectionRecovery(installation))
        .rejects.toThrow("pathname changed");
      expect((await readdir(value.paths.root)).some((name) =>
        name.includes(`recovery-${idempotencyKey}`))).toBe(false);

      await adapter.close();
      await rm(cachePath);
      await rename(originalPath, cachePath);
      adapter = new StateBackedCloudDaemonAdapter({
        readSessionProjectionForCloud: value.codex.readSessionProjectionForCloud,
        executeRemote: () => Promise.resolve({}),
        paths: value.paths,
        store: value.store,
      });
      const stagingPath = join(
        value.paths.root,
        `cloud-projection.sqlite.recovery-${idempotencyKey}`,
      );
      await copyFile(cachePath, stagingPath);
      await chmod(stagingPath, 0o600);
      await adapter.stageCompactProjectionRecovery(installation);
      const tampered = new Database(stagingPath, { strict: true });
      tampered.query(
        "INSERT INTO projection_sessions(session_id,next_sequence,stream_epoch) VALUES (?,?,?)",
      ).run("session_foreign_12345678", 1, 0);
      tampered.close(false);

      await adapter.stageCompactProjectionRecovery(installation);
      const rebuilt = new Database(stagingPath, { readonly: true, strict: true });
      expect(rebuilt.query(
        "SELECT session_id FROM projection_sessions WHERE session_id=?",
      ).get("session_foreign_12345678")).toBeNull();
      rebuilt.close(false);
      await adapter.activateCompactProjectionRecovery(installation);
    } finally {
      await adapter.close();
      value.store.close();
    }
  });

  test("observes a future-version cache without mutating its bytes or journal mode", async () => {
    const value = await fixture();
    const cachePath = join(value.paths.root, "cloud-projection.sqlite");
    execFileSync(process.execPath, ["-e", `
      import { Database } from "bun:sqlite";
      const future = new Database(process.argv[1], { create: true, strict: true });
      future.exec(\`
        PRAGMA journal_mode=WAL;
        PRAGMA wal_autocheckpoint=0;
        CREATE TABLE future_sentinel(value TEXT NOT NULL) STRICT;
        INSERT INTO future_sentinel(value) VALUES ('preserve-me');
        PRAGMA user_version=6;
      \`);
      process.exit(0);
    `, cachePath]);
    const futurePaths = [cachePath, `${cachePath}-wal`, `${cachePath}-shm`];
    for (const path of futurePaths) {
      try {
        await chmod(path, 0o600);
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" || path === cachePath) throw error;
      }
    }
    const snapshotFutureFiles = async () => Promise.all(futurePaths.map(async (path) => {
      try {
        return {
          path,
          present: true as const,
          bytes: await readFile(path),
          mode: (await lstat(path)).mode,
        };
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        return { path, present: false as const };
      }
    }));
    const before = await snapshotFutureFiles();
    expect(before[0]).toMatchObject({ path: cachePath, present: true });

    const adapter = new StateBackedCloudDaemonAdapter({
      readSessionProjectionForCloud: value.codex.readSessionProjectionForCloud,
      executeRemote: () => Promise.resolve({}),
      paths: value.paths,
      store: value.store,
    });
    try {
      expect(adapter.projectionCacheStatus()).toMatchObject({
        code: "CACHE_NEWER_VERSION",
        state: "unavailable",
      });
      const after = await snapshotFutureFiles();
      expect(after).toEqual(before);
    } finally {
      await adapter.close();
      value.store.close();
    }
  });

  test.each(["symlink", "hardlink", "fifo", "newer"] as const)(
    "rejects symlink, hardlink, FIFO, and newer-version cache authority before staging recovery: %s",
    (variant) => ownedCloudAdapterCase(async (value, { createAdapter, request, signal }) => {
      const cachePath = join(value.paths.root, "cloud-projection.sqlite");
      if (variant === "symlink") {
        await request(() => symlink("/dev/null", cachePath));
      } else if (variant === "hardlink") {
        const source = join(value.paths.root, "projection-hardlink-source");
        await request(() => writeFile(source, "unsafe cache authority", { mode: 0o600 }));
        await request(() => link(source, cachePath));
      } else if (variant === "fifo") {
        execFileSync("mkfifo", [cachePath]);
      } else {
        const database = new Database(cachePath, { create: true, strict: true });
        try {
          database.exec("PRAGMA user_version=6");
        } finally {
          database.close(false);
        }
        await request(() => chmod(cachePath, 0o600));
      }
      const adapter = createAdapter();
      const idempotencyKey = `00000000-0000-7000-8000-00000000070${
        variant === "symlink" ? "4" : variant === "hardlink" ? "5" : variant === "fifo" ? "6" : "7"
      }`;
      await expect(request(() => adapter.planCompactProjectionRecovery({
        idempotencyKey,
        sessionPublicId: value.sessionId,
        signal,
      }))).rejects.toThrow("refuses unsafe cache authority");
      expect((await request(() => readdir(value.paths.root))).some((name) =>
        name.includes(`recovery-${idempotencyKey}`))).toBe(false);
    }),
  );

  test("migrates a legacy v1 cache without changing its stream meaning", async () => {
    const value = await fixture();
    const interactionId = "70000000-0000-4000-8000-000000000291";
    admitCloudInteraction(
      value,
      interactionId,
      "80000000-0000-4000-8000-000000000291",
    );
    const legacyInteractionBody = {
      detailMarkdown: [
        "- This form may contain protected values.",
        "- It is completed on the machine running the session.",
      ].join("\n"),
      detailVersion: 1,
      headline: "Codex requests MCP form input",
      label: "MCP form",
      blocking: true,
      interactionId,
      interactionKind: "mcp_elicitation",
      kind: "interaction_state",
      revision: 1,
      state: "pending",
      summary: "An MCP server requests protected form input",
    } as const;
    const cachePath = join(value.paths.root, "cloud-projection.sqlite");
    const database = new Database(cachePath, { create: true, strict: true });
    database.exec(`
      CREATE TABLE projection_sessions (
        session_id TEXT PRIMARY KEY,
        next_sequence INTEGER NOT NULL CHECK(next_sequence > 0)
      ) STRICT;
      CREATE TABLE projection_turns (
        session_id TEXT NOT NULL REFERENCES projection_sessions(session_id) ON DELETE CASCADE,
        turn_id TEXT NOT NULL,
        start_sequence INTEGER NOT NULL CHECK(start_sequence > 0),
        event_count INTEGER NOT NULL CHECK(event_count > 0),
        digest TEXT NOT NULL CHECK(length(digest) = 64),
        events_json TEXT NOT NULL,
        PRIMARY KEY(session_id, turn_id),
        UNIQUE(session_id, start_sequence)
      ) STRICT;
      CREATE TABLE projection_ledger (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        cache_id TEXT NOT NULL CHECK(length(cache_id) BETWEEN 16 AND 128)
      ) STRICT;
      CREATE TABLE projection_remote_checkpoints (
        session_id TEXT PRIMARY KEY,
        head_sequence INTEGER NOT NULL CHECK(head_sequence >= 0),
        tail_digest TEXT,
        pending_expected_head INTEGER,
        pending_expected_tail TEXT,
        pending_head INTEGER,
        pending_tail TEXT
      ) STRICT;
      INSERT INTO projection_ledger(singleton,cache_id)
        VALUES (1,'cache_legacy_12345678');
      PRAGMA user_version=1;
    `);
    database.query(
      "INSERT INTO projection_sessions(session_id,next_sequence) VALUES (?,2)",
    ).run(value.sessionId);
    database.query(
      `INSERT INTO projection_turns(
         session_id,turn_id,start_sequence,event_count,digest,events_json
       ) VALUES (?,?,?,?,?,?)`,
    ).run(
      value.sessionId,
      `hraix_${sha256(`${interactionId}:1`)}`,
      1,
      1,
      sha256(JSON.stringify([legacyInteractionBody])),
      JSON.stringify([{ ...legacyInteractionBody, sequence: 1 }]),
    );
    database.close(false);
    await chmod(cachePath, 0o600);
    const adapter = new StateBackedCloudDaemonAdapter({
      readSessionProjectionForCloud: value.codex.readSessionProjectionForCloud,
      executeRemote: () => Promise.resolve({}),
      paths: value.paths,
      store: value.store,
    });
    try {
      expect(adapter.projectionCacheStatus()).toEqual({ state: "ready" });
      const signal = new AbortController().signal;
      await adapter.listSessions({ limit: 25, signal });
      const projection = await adapter.readCompactEvents({
        afterSequence: 0,
        limit: 128,
        remoteStreamEpoch: 0,
        sessionPublicId: value.sessionId,
        signal,
      });
      expect(projection.cacheId).toBe("cache_legacy_12345678");
      expect(projection.events.map((event) => event.sequence)).toEqual([1, 2, 3, 4]);
      expect(projection.events[0]).toEqual({ ...legacyInteractionBody, sequence: 1 });
      expect(projection.events[0]?.kind === "interaction_state"
        ? projection.events[0].remotePolicy
        : "wrong-kind").toBeUndefined();
    } finally {
      await adapter.close();
      const migrated = new Database(cachePath, { strict: true });
      expect((migrated.query("PRAGMA user_version").get() as { user_version: number })
        .user_version).toBe(5);
      const migratedColumns = (migrated.query("PRAGMA table_info(projection_sessions)").all() as
        Array<{ name: string }>).map((column) => column.name);
      expect(migratedColumns).toContain("stream_epoch");
      expect(migratedColumns).toContain("interaction_scan_sequence");
      expect(migratedColumns).toContain("interaction_scan_ceiling_sequence");
      expect(migratedColumns).toContain("interaction_discovery_cursor");
      migrated.close(false);
      value.store.close();
    }
  });

  test("migrates a populated v2 cache with an inactive durable interaction scan", async () => {
    const value = await fixture();
    const cachePath = join(value.paths.root, "cloud-projection.sqlite");
    const database = new Database(cachePath, { create: true, strict: true });
    database.exec(`
      CREATE TABLE projection_sessions (
        session_id TEXT PRIMARY KEY,
        next_sequence INTEGER NOT NULL CHECK(next_sequence > 0),
        stream_epoch INTEGER NOT NULL DEFAULT 0 CHECK(stream_epoch >= 0)
      ) STRICT;
      CREATE TABLE projection_turns (
        session_id TEXT NOT NULL REFERENCES projection_sessions(session_id) ON DELETE CASCADE,
        turn_id TEXT NOT NULL,
        start_sequence INTEGER NOT NULL CHECK(start_sequence > 0),
        event_count INTEGER NOT NULL CHECK(event_count > 0),
        digest TEXT NOT NULL CHECK(length(digest) = 64),
        events_json TEXT NOT NULL,
        PRIMARY KEY(session_id, turn_id),
        UNIQUE(session_id, start_sequence)
      ) STRICT;
      CREATE TABLE projection_baselines (
        session_id TEXT NOT NULL REFERENCES projection_sessions(session_id) ON DELETE CASCADE,
        turn_id TEXT NOT NULL,
        digest TEXT NOT NULL CHECK(length(digest) = 64),
        PRIMARY KEY(session_id, turn_id)
      ) STRICT;
      CREATE TABLE projection_ledger (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        cache_id TEXT NOT NULL CHECK(length(cache_id) BETWEEN 16 AND 128)
      ) STRICT;
      CREATE TABLE projection_remote_checkpoints (
        session_id TEXT PRIMARY KEY,
        head_sequence INTEGER NOT NULL CHECK(head_sequence >= 0),
        stream_epoch INTEGER NOT NULL DEFAULT 0 CHECK(stream_epoch >= 0),
        tail_digest TEXT,
        pending_expected_head INTEGER,
        pending_expected_tail TEXT,
        pending_head INTEGER,
        pending_tail TEXT
      ) STRICT;
      INSERT INTO projection_ledger(singleton,cache_id)
        VALUES (1,'cache_v2_1234567890');
      PRAGMA user_version=2;
    `);
    database.query(
      "INSERT INTO projection_sessions(session_id,next_sequence,stream_epoch) VALUES (?,1,0)",
    ).run(value.sessionId);
    database.query(
      `INSERT INTO projection_remote_checkpoints(
         session_id,head_sequence,stream_epoch,tail_digest
       ) VALUES (?,0,0,NULL)`,
    ).run(value.sessionId);
    database.close(false);
    await chmod(cachePath, 0o600);

    const adapter = new StateBackedCloudDaemonAdapter({
      readSessionProjectionForCloud: value.codex.readSessionProjectionForCloud,
      executeRemote: () => Promise.resolve({}),
      paths: value.paths,
      store: value.store,
    });
    try {
      expect(adapter.projectionCacheStatus()).toEqual({ state: "ready" });
    } finally {
      await adapter.close();
      const migrated = new Database(cachePath, { readonly: true, strict: true });
      expect((migrated.query("PRAGMA user_version").get() as { user_version: number })
        .user_version).toBe(5);
      expect(migrated.query(
        `SELECT interaction_scan_sequence,interaction_scan_ceiling_sequence,
                interaction_discovery_cursor
         FROM projection_sessions WHERE session_id=?`,
      ).get(value.sessionId)).toEqual({
        interaction_discovery_cursor: null,
        interaction_scan_ceiling_sequence: 0,
        interaction_scan_sequence: 0,
      });
      expect(migrated.query(
        "SELECT cache_id FROM projection_ledger WHERE singleton=1",
      ).get()).toEqual({ cache_id: "cache_v2_1234567890" });
      expect(migrated.query(
        "SELECT head_sequence,stream_epoch,tail_digest FROM projection_remote_checkpoints WHERE session_id=?",
      ).get(value.sessionId)).toEqual({ head_sequence: 0, stream_epoch: 0, tail_digest: null });
      migrated.close(false);
      value.store.close();
    }
  });

  test("migrates a populated v3 cache with an inactive interaction discovery cursor", async () => {
    const value = await fixture();
    const cachePath = join(value.paths.root, "cloud-projection.sqlite");
    let adapter = new StateBackedCloudDaemonAdapter({
      readSessionProjectionForCloud: value.codex.readSessionProjectionForCloud,
      executeRemote: () => Promise.resolve({}),
      paths: value.paths,
      store: value.store,
    });
    try {
      await adapter.listSessions({
        limit: 25,
        signal: new AbortController().signal,
      });
      await adapter.close();
      const previous = new Database(cachePath, { strict: true });
      previous.exec(`
        DROP TABLE projection_interaction_index;
        ALTER TABLE projection_sessions DROP COLUMN interaction_discovery_cursor;
        PRAGMA user_version=3;
      `);
      previous.close(false);

      adapter = new StateBackedCloudDaemonAdapter({
        readSessionProjectionForCloud: value.codex.readSessionProjectionForCloud,
        executeRemote: () => Promise.resolve({}),
        paths: value.paths,
        store: value.store,
      });
      expect(adapter.projectionCacheStatus()).toEqual({ state: "ready" });
    } finally {
      await adapter.close();
      const migrated = new Database(cachePath, { readonly: true, strict: true });
      expect((migrated.query("PRAGMA user_version").get() as { user_version: number })
        .user_version).toBe(5);
      expect(migrated.query(
        "SELECT interaction_discovery_cursor FROM projection_sessions WHERE session_id=?",
      ).get(value.sessionId)).toEqual({ interaction_discovery_cursor: null });
      migrated.close(false);
      value.store.close();
    }
  });

  test("migrates v4 by rebuilding the bounded interaction index atomically", async () => {
    const value = await fixture();
    const interactionId = "72000000-0000-4000-8006-000000000001";
    admitCloudInteraction(
      value,
      interactionId,
      "82000000-0000-4000-8006-000000000001",
    );
    const cachePath = join(value.paths.root, "cloud-projection.sqlite");
    let adapter = new StateBackedCloudDaemonAdapter({
      readSessionProjectionForCloud: value.codex.readSessionProjectionForCloud,
      executeRemote: () => Promise.resolve({}),
      paths: value.paths,
      store: value.store,
    });
    try {
      await adapter.listSessions({
        limit: 25,
        signal: new AbortController().signal,
      });
      await adapter.close();
      const previous = new Database(cachePath, { strict: true });
      previous.exec(`
        DROP TABLE projection_interaction_index;
        PRAGMA user_version=4;
      `);
      previous.close(false);

      adapter = new StateBackedCloudDaemonAdapter({
        readSessionProjectionForCloud: value.codex.readSessionProjectionForCloud,
        executeRemote: () => Promise.resolve({}),
        paths: value.paths,
        store: value.store,
      });
      expect(adapter.projectionCacheStatus()).toEqual({ state: "ready" });
    } finally {
      await adapter.close();
      const migrated = new Database(cachePath, { readonly: true, strict: true });
      expect((migrated.query("PRAGMA user_version").get() as { user_version: number })
        .user_version).toBe(5);
      expect(migrated.query(
        `SELECT interaction_id,start_sequence FROM projection_interaction_index
         WHERE session_id=?`,
      ).get(value.sessionId)).toEqual({
        interaction_id: interactionId,
        start_sequence: 4,
      });
      migrated.close(false);
      value.store.close();
    }
  });

  test("reconciles an exact committed compact upload after its response is lost", async () => {
    const value = await fixture();
    const adapter = new StateBackedCloudDaemonAdapter({
      readSessionProjectionForCloud: value.codex.readSessionProjectionForCloud,
      executeRemote: () => Promise.resolve({}),
      paths: value.paths,
      store: value.store,
    });
    try {
      const signal = new AbortController().signal;
      await adapter.listSessions({ limit: 25, signal });
      const page = await adapter.readCompactEvents({
        afterSequence: 0,
        limit: 128,
        sessionPublicId: value.sessionId,
        signal,
      });
      const headSequence = page.events.at(-1)?.sequence ?? 0;
      const checkpoint = {
        cacheId: page.cacheId,
        digest: "d".repeat(64),
        expectedHeadSequence: 0,
        expectedStreamEpoch: 0,
        headSequence,
        sessionPublicId: value.sessionId,
      };
      await adapter.recordCompactUploadIntent(checkpoint);

      expect(await adapter.readCompactEvents({
        afterSequence: headSequence,
        limit: 128,
        remoteTailDigest: checkpoint.digest,
        sessionPublicId: value.sessionId,
        signal,
      })).toEqual({ cacheId: page.cacheId, complete: true, events: [] });
      await adapter.acknowledgeCompactUpload(checkpoint);
      expect(adapter.projectionCacheStatus()).toEqual({ state: "ready" });
    } finally {
      await adapter.close();
      value.store.close();
    }
  });

  test("quarantines corrupt, symlinked, and newer projection caches without blocking local authority or cloud usage", async () => {
    for (const variant of ["corrupt", "symlink", "newer"] as const) {
      const value = await fixture();
      const cachePath = join(value.paths.root, "cloud-projection.sqlite");
      if (variant === "corrupt") await writeFile(cachePath, "not sqlite", { mode: 0o600 });
      else if (variant === "symlink") await symlink("/dev/null", cachePath);
      else {
        const database = new Database(cachePath, { create: true, strict: true });
        database.exec("PRAGMA user_version=6");
        database.close(false);
      }
      const commands: LocalCommand[] = [];
      const adapter = new StateBackedCloudDaemonAdapter({
        readSessionProjectionForCloud: value.codex.readSessionProjectionForCloud,
        executeRemote: (command) => { commands.push(command); return Promise.resolve({}); },
        paths: value.paths,
        store: value.store,
      });
      try {
        expect(adapter.projectionCacheStatus()).toMatchObject({ state: "unavailable" });
        expect((await adapter.listSessions({
          limit: 25,
          signal: new AbortController().signal,
        })).sessions).toHaveLength(1);
        expect(await adapter.listUsage({ limit: 100, signal: new AbortController().signal })).toHaveLength(1);
        const authority = await adapter.resolveCommandAuthority({ sessionPublicId: value.sessionId, signal: new AbortController().signal });
        expect(authority).not.toBeNull();
        expect(await adapter.execute({
          authority: authority as CloudLocalCommandAuthority,
          idempotencyKey: `00000000-0000-7000-8000-00000000000${variant === "corrupt" ? "3" : variant === "symlink" ? "4" : "5"}`,
          leaseAuthority: { bootGeneration: 1, bootId: "boot_00000001", fence: 1 },
          payload: { kind: "stop" },
          sessionPublicId: value.sessionId,
          signal: new AbortController().signal,
        })).toEqual({ code: "APPLIED", state: "applied" });
        expect(commands).toHaveLength(1);
        await expect(adapter.readCompactEvents({ afterSequence: 0, limit: 128, sessionPublicId: value.sessionId, signal: new AbortController().signal }))
          .rejects.toThrow("cloud projection cache");
      } finally {
        await adapter.close();
        value.store.close();
      }
    }
  });

  test("routes a remote provider switch onto the ordinary execution path", async () => {
    const value = await fixture();
    const commands: LocalCommand[] = [];
    const adapter = new StateBackedCloudDaemonAdapter({
      readSessionProjectionForCloud: value.codex.readSessionProjectionForCloud,
      executeRemote: (command) => { commands.push(command); return Promise.resolve({}); },
      paths: value.paths,
      store: value.store,
    });
    try {
      const signal = new AbortController().signal;
      const authority = await adapter.resolveCommandAuthority({
        sessionPublicId: value.sessionId,
        signal,
      });
      expect(authority).not.toBeNull();
      expect(await adapter.execute({
        authority: authority as CloudLocalCommandAuthority,
        idempotencyKey: "00000000-0000-7000-8000-0000000000a1",
        leaseAuthority: { bootGeneration: 1, bootId: "boot_00000001", fence: 1 },
        payload: { kind: "set_provider", preset: "fable-max", provider: "claude" },
        sessionPublicId: value.sessionId,
        signal,
      })).toEqual({ code: "APPLIED", state: "applied" });
      // A provider switch is a provider effect, not a local setting: it reaches
      // the daemon as a command rather than settling inside the adapter.
      expect(commands).toEqual([{
        idempotencyKey: "00000000-0000-7000-8000-0000000000a1",
        kind: "session.switch",
        preset: "fable-max",
        provider: "claude",
        session: value.sessionId,
      }]);
      expect(await adapter.execute({
        authority: authority as CloudLocalCommandAuthority,
        idempotencyKey: "00000000-0000-7000-8000-0000000000a2",
        leaseAuthority: { bootGeneration: 1, bootId: "boot_00000001", fence: 1 },
        payload: { kind: "set_provider", presetContract: 2, provider: "codex" },
        sessionPublicId: value.sessionId,
        signal,
      })).toEqual({ code: "APPLIED", state: "applied" });
      expect(commands[1]).toEqual({
        idempotencyKey: "00000000-0000-7000-8000-0000000000a2",
        kind: "session.switch",
        presetContract: 2,
        provider: "codex",
        session: value.sessionId,
      });
      expect(await adapter.execute({
        authority: authority as CloudLocalCommandAuthority,
        idempotencyKey: "00000000-0000-7000-8000-0000000000a3",
        leaseAuthority: { bootGeneration: 1, bootId: "boot_00000001", fence: 1 },
        payload: { kind: "set_provider", preset: "astra", provider: "devin" } as unknown as Parameters<StateBackedCloudDaemonAdapter["execute"]>[0]["payload"],
        sessionPublicId: value.sessionId,
        signal,
      })).toEqual({ code: "COMMAND_PAYLOAD_INVALID", state: "failed" });
      expect(commands).toHaveLength(2);
    } finally {
      await adapter.close();
      value.store.close();
    }
  });

  test("dispatches only under the exact local profile and provider authority", async () => {
    const value = await fixture();
    const commands: LocalCommand[] = [];
    const expectedAuthorities: unknown[] = [];
    const adapter = new StateBackedCloudDaemonAdapter({
      readSessionProjectionForCloud: value.codex.readSessionProjectionForCloud,
      executeRemote: (command, expected) => {
        commands.push(command);
        expectedAuthorities.push(expected);
        return Promise.resolve({});
      },
      paths: value.paths,
      store: value.store,
    });
    try {
      const signal = new AbortController().signal;
      const authority = await adapter.resolveCommandAuthority({ sessionPublicId: value.sessionId, signal });
      expect(authority).not.toBeNull();
      const applied = await adapter.execute({
        authority: authority as CloudLocalCommandAuthority,
        idempotencyKey: "00000000-0000-7000-8000-000000000001",
        leaseAuthority: { bootGeneration: 1, bootId: "boot_00000001", fence: 1 },
        payload: { kind: "send", message: "Continue" },
        sessionPublicId: value.sessionId,
        signal,
      });
      expect(applied).toEqual({ code: "APPLIED", state: "applied" });
      expect(commands).toEqual([{
        kind: "session.send",
        session: value.sessionId,
        message: "Continue",
        idempotencyKey: "00000000-0000-7000-8000-000000000001",
      }]);
      expect(expectedAuthorities).toMatchObject([{
        bindingGeneration: (authority as CloudLocalCommandAuthority).bindingGeneration,
        processGeneration: (authority as CloudLocalCommandAuthority).processGeneration,
        profileId: (authority as CloudLocalCommandAuthority).profileId,
        provider: "codex",
        providerAccountId: (authority as CloudLocalCommandAuthority).providerAccountId,
        providerThreadId: "thread_0001",
        sessionId: value.sessionId,
      }]);

      expect(await adapter.execute({
        authority: authority as CloudLocalCommandAuthority,
        idempotencyKey: "00000000-0000-7000-8000-000000000006",
        leaseAuthority: { bootGeneration: 1, bootId: "boot_00000001", fence: 1 },
        payload: { kind: "set_fast", enabled: true },
        sessionPublicId: value.sessionId,
        signal,
      })).toEqual({ code: "APPLIED", state: "applied" });
      expect(commands.at(-1)).toEqual({
        enabled: true,
        idempotencyKey: "00000000-0000-7000-8000-000000000006",
        kind: "session.fast",
        session: value.sessionId,
      });

      expect(await adapter.execute({
        authority: authority as CloudLocalCommandAuthority,
        idempotencyKey: "00000000-0000-7000-8000-000000000007",
        leaseAuthority: { bootGeneration: 1, bootId: "boot_00000001", fence: 1 },
        payload: { kind: "set_model", preset: "ultra", presetContract: 2 },
        sessionPublicId: value.sessionId,
        signal,
      })).toEqual({ code: "APPLIED", state: "applied" });
      expect(commands.at(-1)).toEqual({
        idempotencyKey: "00000000-0000-7000-8000-000000000007",
        kind: "session.preset",
        preset: "ultra",
        session: value.sessionId,
      });

      const profile = value.store.requireProfileById((authority as CloudLocalCommandAuthority).profileId as Parameters<StateStore["requireProfileById"]>[0]);
      value.store.advanceProfileGeneration(profile.id, profile.processGeneration);
      expect(await adapter.execute({
        authority: authority as CloudLocalCommandAuthority,
        idempotencyKey: "00000000-0000-7000-8000-000000000002",
        leaseAuthority: { bootGeneration: 1, bootId: "boot_00000001", fence: 1 },
        payload: { kind: "stop" },
        sessionPublicId: value.sessionId,
        signal,
      })).toEqual({ code: "LOCAL_AUTHORITY_CHANGED", state: "failed" });
      expect(commands).toHaveLength(3);
    } finally {
      await adapter.close();
      value.store.close();
    }
  });

  test("refuses a remote command after its provider binding generation changes", async () => {
    const value = await fixture();
    const commands: LocalCommand[] = [];
    const adapter = new StateBackedCloudDaemonAdapter({
      readSessionProjectionForCloud: value.codex.readSessionProjectionForCloud,
      executeRemote: (command) => {
        commands.push(command);
        return Promise.resolve({});
      },
      paths: value.paths,
      store: value.store,
    });
    try {
      const signal = new AbortController().signal;
      const authority = await adapter.resolveCommandAuthority({
        sessionPublicId: value.sessionId,
        signal,
      });
      if (authority === null) throw new Error("missing provider authority fixture");
      const profile = value.store.requireProfileById(authority.profileId);
      expect(value.store.setProfileState(
        profile.id,
        profile.processGeneration,
        "signed_out",
      )).toBe(true);

      expect(await adapter.execute({
        authority,
        idempotencyKey: "00000000-0000-7000-8000-0000000000b1",
        leaseAuthority: { bootGeneration: 1, bootId: "boot_00000001", fence: 1 },
        payload: { kind: "stop" },
        sessionPublicId: value.sessionId,
        signal,
      })).toEqual({ code: "LOCAL_AUTHORITY_CHANGED", state: "failed" });
      expect(commands).toEqual([]);
    } finally {
      await adapter.close();
      value.store.close();
    }
  });
});

describe("bridged cloud control", () => {
  test("manual sync runs the daemon bridge before the ordinary control pull", async () => {
    const calls: string[] = [];
    const cycleOptions: unknown[] = [];
    const deviceSignals: AbortSignal[] = [];
    const cycle: CloudDaemonCycleResult = {
      commandRequestVersion: 2,
      commandsApplied: 0,
      commandsUnsettled: 0,
      errors: [],
      online: true,
      remoteSessions: [{
        complete: true,
        events: [{
          kind: "assistant_message",
          sequence: 1,
          text: "remote-sentinel".repeat(450_000),
          turnId: "turn_large_sync",
        }],
        executionDevicePublicId: "device_12345678",
        metadata: null,
        publicId: "session_large_sync",
        state: "idle",
        updatedAt: 4_000,
      }],
      sessionsUploaded: 1,
      usageUploaded: 1,
    };
    const bridge: CloudDaemonBridge = {
      close: () => { calls.push("close"); return Promise.resolve(); },
      cycle: (_signal, options) => {
        calls.push("bridge");
        cycleOptions.push(options);
        return Promise.resolve(cycle);
      },
      invalidateAttentionNotificationAuthority: () => {
        calls.push("attention-invalidate");
        return Promise.resolve({
          expiresNoLaterThan: 124_000,
          state: "revocation_pending",
        });
      },
      observeAttentionNotificationAuthority: () => {
        calls.push("attention-observe");
        return Promise.resolve({
          acknowledgedAt: 4_000,
          consentLeaseUntil: 4_000,
          state: "acknowledged",
        });
      },
      pullRemoteSessions: () => Promise.resolve([]),
    };
    const unused = () => Promise.reject(new Error("unused"));
    const control: CloudControlPort & CloudRemoteControlPort = {
      status: unused,
      auth: unused,
      logout: unused,
      deleteAccount: (input) => {
        calls.push(`delete:${String(input.acknowledgeErasure)}`);
        return Promise.resolve({ deletion: { effectsDisabled: true, state: "pending" } });
      },
      listDevices: unused,
      pairDevice: unused,
      acknowledgeNoAccountKeyHolders: (signal) => {
        expect(signal.aborted).toBe(false);
        calls.push("key-loss");
        return Promise.resolve({ localOnly: true });
      },
      approveDevice: (device, idempotencyKey, fingerprint, signal) => {
        expect(signal.aborted).toBe(false);
        deviceSignals.push(signal);
        calls.push(`approve:${device}:${idempotencyKey}:${fingerprint}`);
        return Promise.resolve({ approved: true });
      },
      revokeDevice: (device, idempotencyKey, signal) => {
        expect(signal.aborted).toBe(false);
        deviceSignals.push(signal);
        calls.push(`revoke:${device}:${idempotencyKey}`);
        return Promise.resolve({ revoked: true });
      },
      listRemoteSessionHeads: unused,
      resolveRemoteSession: unused,
      pullRemoteSession: unused,
      getRemoteCommandStatus: unused,
      enqueueRemoteCommand: unused,
      isCompactProjectionRecoveryUnsettled: () => Promise.resolve(false),
      isCompactProjectionRecoveryUnsettledForProfile: () => Promise.resolve(false),
      supersedeCompactProjectionRecoveryForProviderDeletion: () =>
        Promise.resolve({ superseded: false }),
      supersedeTerminalCompactProjectionRecoveries: () =>
        Promise.resolve({ superseded: 0 }),
      recoverCompactProjection: unused,
      sync: () => {
        calls.push("control");
        return Promise.resolve({
          accountCount: 2,
          ignoredProjection: "sentinel".repeat(900_000),
          sessionCount: 3,
          synced: true,
          syncedAt: 4_000,
          truncated: false,
          usageSnapshotCount: 1,
        });
      },
    };
    const combined = new BridgedCloudControl(control, bridge);
    const synced = await combined.sync(new AbortController().signal);
    expect(synced).toEqual({
      control: {
        accountCount: 2,
        sessionCount: 3,
        synced: true,
        syncedAt: 4_000,
        truncated: false,
        usageSnapshotCount: 1,
      },
      daemon: {
        commandRequestVersion: 2,
        commandsApplied: 0,
        commandsUnsettled: 0,
        errors: [],
        online: true,
        remoteSessionCount: 1,
        sessionsUploaded: 1,
        usageUploaded: 1,
      },
    });
    expect(JSON.stringify(synced).length).toBeLessThan(2_048);
    expect(JSON.stringify(synced)).not.toContain("sentinel");
    expect(calls).toEqual(["bridge", "control"]);
    expect(cycleOptions).toEqual([{ forceDeviceRegistryPublication: true }]);

    calls.length = 0;
    expect(await combined.observeAttentionNotificationAuthority(
      new AbortController().signal,
    )).toEqual({
      acknowledgedAt: 4_000,
      consentLeaseUntil: 4_000,
      state: "acknowledged",
    });
    expect(await combined.invalidateAttentionNotificationAuthority({
      localNotificationPolicyRevision: 4,
      signal: new AbortController().signal,
    })).toEqual({
      expiresNoLaterThan: 124_000,
      state: "revocation_pending",
    });
    expect(calls).toEqual(["attention-observe", "attention-invalidate"]);

    calls.length = 0;
    expect(await combined.deleteAccount({
      acknowledgeErasure: true,
      signal: new AbortController().signal,
    })).toEqual({
      daemonRestartRequired: true,
      deletion: { effectsDisabled: true, state: "pending" },
    });
    expect(calls).toEqual(["close", "delete:true"]);

    calls.length = 0;
    const deviceSignal = new AbortController().signal;
    const approvalKey = "018bcfe5-6800-7000-8000-000000000031";
    const approvalFingerprint = "0000-1111-2222-3333-4444-5555-6666-7777";
    const revocationKey = "018bcfe5-6800-7000-8000-000000000032";
    expect(await combined.acknowledgeNoAccountKeyHolders(deviceSignal))
      .toEqual({ localOnly: true });
    expect(await combined.approveDevice(
      "device_pending",
      approvalKey,
      approvalFingerprint,
      deviceSignal,
    )).toEqual({ approved: true });
    expect(await combined.revokeDevice("device_active", revocationKey, deviceSignal))
      .toEqual({ revoked: true });
    expect(calls).toEqual([
      "key-loss",
      `approve:device_pending:${approvalKey}:${approvalFingerprint}`,
      `revoke:device_active:${revocationKey}`,
    ]);
    expect(deviceSignals).toEqual([deviceSignal, deviceSignal]);
  });
});

describe("remote decisions at the custodian", () => {
  test("send_or_steer sends when no turn is active and remote decisions are verified before dispatch", async () => {
    const value = await fixture();
    const commands: LocalCommand[] = [];
    const adapter = new StateBackedCloudDaemonAdapter({
      readSessionProjectionForCloud: value.codex.readSessionProjectionForCloud,
      executeRemote: (command) => { commands.push(command); return Promise.resolve({}); },
      paths: value.paths,
      store: value.store,
    });
    try {
      const signal = new AbortController().signal;
      const authority = await adapter.resolveCommandAuthority({ sessionPublicId: value.sessionId, signal });
      expect(authority).not.toBeNull();
      expect(await adapter.execute({
        authority: authority as CloudLocalCommandAuthority,
        idempotencyKey: "00000000-0000-7000-8000-000000000021",
        leaseAuthority: { bootGeneration: 1, bootId: "boot_00000001", fence: 1 },
        payload: { kind: "send_or_steer", message: "Keep going" },
        sessionPublicId: value.sessionId,
        signal,
      })).toEqual({ code: "APPLIED", state: "applied" });
      expect(commands.at(-1)).toMatchObject({ kind: "session.send", message: "Keep going" });

      expect(await adapter.execute({
        authority: authority as CloudLocalCommandAuthority,
        idempotencyKey: "00000000-0000-7000-8000-000000000022",
        leaseAuthority: { bootGeneration: 1, bootId: "boot_00000001", fence: 1 },
        payload: {
          decision: "once",
          interactionId: "0192a3b4-c5d6-7e8f-8a9b-0c1d2e3f4a5b",
          kind: "resolve_interaction",
          revision: 1,
        },
        sessionPublicId: value.sessionId,
        signal,
      })).toEqual({ code: "INTERACTION_NOT_FOUND", state: "failed" });
      expect(commands.filter((command) => command.kind === "interaction.resolve")).toHaveLength(0);
    } finally {
      await adapter.close();
      value.store.close();
    }
  });
});

describe("remote interaction detail and the decisions it licenses", () => {
  const leaseAuthority = { bootGeneration: 1, bootId: "boot_00000001", fence: 1 } as const;
  let sequence = 0;

  function admitDisplay(
    value: Awaited<ReturnType<typeof fixture>>,
    publicId: string,
    display: Parameters<StateStore["admitInteraction"]>[0]["display"],
  ): void {
    sequence += 1;
    const suffix = String(sequence).padStart(12, "0");
    // The decision verifier reads the wall clock, so the fixture clock is
    // advanced to it: an interaction admitted at the fixture's epoch would be
    // past its deadline before any decision could be verified.
    value.setNow(Date.now());
    const session = value.store.requireSession(value.sessionId);
    const profile = value.store.requireProfileById(session.profileId);
    const providerAuthority = value.store.requireSessionProviderAuthority(session.id);
    value.store.admitInteraction({
      authority: {
        approvalId: null,
        bindingGeneration: providerAuthority.bindingGeneration,
        connectionId: `90000000-0000-4000-8000-${suffix}`,
        itemId: null,
        method: "item/commandExecution/requestApproval",
        processGeneration: profile.processGeneration,
        profileId: profile.id,
        provider: providerAuthority.provider,
        providerAccountId: providerAuthority.providerAccountId,
        requestDigest: "e".repeat(64),
        requestId: { type: "string", value: `request_${publicId}` },
        threadId: session.providerThreadId ?? null,
        turnId: null,
      },
      blocking: true,
      display,
      kind: display.kind,
      publicId,
      sessionId: value.sessionId as `sess_${string}`,
    });
  }

  async function harness(
    value: Awaited<ReturnType<typeof fixture>>,
  ): Promise<Readonly<{
    adapter: StateBackedCloudDaemonAdapter;
    commands: LocalCommand[];
    projected: (interactionId: string) => Promise<Record<string, unknown> | undefined>;
    resolve: (
      payload: Extract<RemoteCommandPayload, { kind: "resolve_interaction" }>,
    ) => Promise<CloudCommandExecutionResult>;
  }>> {
    const commands: LocalCommand[] = [];
    const adapter = new StateBackedCloudDaemonAdapter({
      readSessionProjectionForCloud: value.codex.readSessionProjectionForCloud,
      executeRemote: (command) => { commands.push(command); return Promise.resolve({}); },
      now: value.now,
      paths: value.paths,
      store: value.store,
    });
    const signal = new AbortController().signal;
    const authority = await adapter.resolveCommandAuthority({
      sessionPublicId: value.sessionId,
      signal,
    });
    let key = 0;
    return {
      adapter,
      commands,
      projected: async (interactionId) => {
        await adapter.listSessions({ limit: 25, signal });
        const read = await adapter.readCompactEvents({
          afterSequence: 0,
          limit: 128,
          sessionPublicId: value.sessionId,
          signal,
        });
        return read.events.find((event) =>
          event.kind === "interaction_state" && event.interactionId === interactionId) as
            Record<string, unknown> | undefined;
      },
      resolve: async (payload) => {
        key += 1;
        return await adapter.execute({
          authority: authority as CloudLocalCommandAuthority,
          idempotencyKey: `00000000-0000-7000-8000-0000000005${String(key).padStart(2, "0")}`,
          leaseAuthority,
          payload,
          sessionPublicId: value.sessionId,
          signal,
        });
      },
    };
  }

  test("projects bounded command detail but keeps every command grant on the execution device", async () => {
    const value = await fixture();
    const interactionId = "70000000-0000-4000-8000-000000000301";
    const absoluteFixture = ["", "opt", "private", "checkout"].join("/");
    admitDisplay(value, interactionId, {
      availableDecisions: ["once", "decline"],
      commandClass: "git commit",
      kind: "command_approval",
      reason: `Commit the staged work in ${absoluteFixture}`,
      summary: "Allow git commit",
      workingDirectory: "src/cloud",
    });
    const harnessed = await harness(value);
    try {
      const event = await harnessed.projected(interactionId);
      expect(event).toMatchObject({
        detailVersion: 2,
        headline: "Allow git commit",
        label: "Command approval",
        remotePolicy: {
          actions: ["decline"],
          questions: [],
          reasonCodes: ["COMMAND_APPROVAL_LOCAL_ONLY"],
          version: 2,
        },
      });
      expect(event?.availableDecisions).toBeUndefined();
      expect(event?.commandClass).toBeUndefined();
      expect(event?.questions).toBeUndefined();
      const detail = event?.detailMarkdown as string;
      expect(detail).toContain("- Runs: git commit");
      expect(detail).toContain("- Directory: src/cloud");
      const serialized = JSON.stringify(event);
      expect(serialized).not.toContain("private");
      expect(containsAbsolutePath(serialized)).toBe(false);

      expect(await harnessed.resolve({
        decision: "once",
        interactionId,
        kind: "resolve_interaction",
        revision: 1,
      })).toEqual({ code: "INTERACTION_COMMAND_APPROVAL_LOCAL_ONLY", state: "failed" });
      expect(harnessed.commands).toHaveLength(0);

      expect(await harnessed.resolve({
        decision: "decline",
        interactionId,
        kind: "resolve_interaction",
        revision: 1,
      })).toEqual({ code: "APPLIED", state: "applied" });
      expect(harnessed.commands.at(-1)).toMatchObject({
        kind: "interaction.resolve",
        resolution: { decision: "decline", kind: "approval_decision" },
      });
    } finally {
      await harnessed.adapter.close();
      value.store.close();
    }
  });

  test("keeps every permission grant local because public categories hide protected values", async () => {
    const value = await fixture();
    const workspaceId = "70000000-0000-4000-8000-000000000311";
    const networkId = "70000000-0000-4000-8000-000000000312";
    admitDisplay(value, workspaceId, {
      allowsSessionScope: true,
      kind: "permission_approval",
      reason: "Write the generated file",
      requested: [{ name: "workspace_write" }],
      summary: "Allow additional workspace permissions",
    });
    admitDisplay(value, networkId, {
      allowsSessionScope: true,
      kind: "permission_approval",
      reason: "Reach the package registry",
      requested: [{ name: "network_outbound" }],
      summary: "Allow additional permissions",
    });
    const harnessed = await harness(value);
    try {
      const workspace = await harnessed.projected(workspaceId);
      expect(workspace).toMatchObject({
        detailVersion: 2,
        remotePolicy: {
          actions: ["decline"],
          questions: [],
          reasonCodes: ["PERMISSION_APPROVAL_LOCAL_ONLY"],
        },
      });
      expect(workspace?.detailMarkdown).toContain("- Requested category: workspace");
      // The class is projected; the exact requested value never is.
      expect(JSON.stringify(workspace)).not.toContain("workspace_write");

      const network = await harnessed.projected(networkId);
      expect(network?.commandClass).toBeUndefined();
      expect(network?.remotePolicy).toMatchObject({
        actions: ["decline"],
        questions: [],
        reasonCodes: ["PERMISSION_APPROVAL_LOCAL_ONLY"],
      });
      expect(JSON.stringify(network)).not.toContain("network_outbound");
      expect(network?.detailMarkdown).toContain("- Requested category: network");

      expect(await harnessed.resolve({
        decision: "once",
        interactionId: workspaceId,
        kind: "resolve_interaction",
        revision: 1,
      })).toEqual({ code: "INTERACTION_PERMISSION_APPROVAL_LOCAL_ONLY", state: "failed" });
      expect(harnessed.commands).toHaveLength(0);

      // Decline remains safe for either category; no remote path can compile a
      // hidden permission value into a provider grant.
      for (const [interactionId, decision, expected] of [
        [workspaceId, "decline", { code: "APPLIED", state: "applied" }],
        [networkId, "once", { code: "INTERACTION_PERMISSION_APPROVAL_LOCAL_ONLY", state: "failed" }],
        [networkId, "decline", { code: "APPLIED", state: "applied" }],
      ] as const) {
        expect(await harnessed.resolve({
          decision,
          interactionId,
          kind: "resolve_interaction",
          revision: 1,
        })).toEqual(expected);
      }
      expect(harnessed.commands).toHaveLength(2);
      expect(harnessed.commands.every((command) =>
        command.kind === "interaction.resolve"
        && command.resolution.kind === "approval_decision"
        && command.resolution.decision === "decline")).toBe(true);
    } finally {
      await harnessed.adapter.close();
      value.store.close();
    }
  });

  test("lists a secret question without an answer path and answers only the plain ones", async () => {
    const value = await fixture();
    const interactionId = "70000000-0000-4000-8000-000000000321";
    admitDisplay(value, interactionId, {
      blocking: true,
      kind: "user_input",
      questions: [
        {
          allowsOther: false,
          header: "Region",
          id: "region",
          options: [{ description: "Europe", label: "eu" }],
          question: "Which region should it deploy to?",
          remoteAnswerable: true,
          secret: false,
        },
        {
          allowsOther: false,
          header: "Registry token",
          id: "registry_token",
          options: [{ description: "Use the stored value", label: "Stored" }],
          question: "Paste the registry token.",
          remoteAnswerable: true,
          secret: true,
        },
      ],
      summary: "Codex needs user input",
    });
    const harnessed = await harness(value);
    try {
      const event = await harnessed.projected(interactionId);
      expect(event?.questions).toBeUndefined();
      expect(event?.remotePolicy).toMatchObject({
        actions: [],
        questions: [],
        reasonCodes: ["USER_INPUT_SECRET_QUESTION"],
      });
      // Presentation acknowledges the local-only question without projecting
      // either its answer authority or protected prompt text.
      expect(event?.detailMarkdown).toContain("- Registry token: answered on the machine");
      expect(event?.detailMarkdown).not.toContain("Paste the registry token");

      // The local resolve path answers a question set whole, so every way of
      // answering this one is refused: the protected value alone, the set that
      // carries it, and the partial set that leaves it out.
      for (const answers of [
        { registry_token: { answers: ["a-token"] } },
        { region: { answers: ["eu"] }, registry_token: { answers: ["a-token"] } },
        { region: { answers: ["eu"] } },
      ]) {
        expect(await harnessed.resolve({
          answers,
          interactionId,
          kind: "resolve_interaction",
          revision: 1,
        })).toEqual({ code: "INTERACTION_SECRET_ANSWER_REFUSED", state: "failed" });
      }
      expect(harnessed.commands.filter((command) =>
        command.kind === "interaction.resolve")).toHaveLength(0);

      // A question set with nothing protected in it is answered from here.
      const plainId = "70000000-0000-4000-8000-000000000322";
      admitDisplay(value, plainId, {
        blocking: true,
        kind: "user_input",
        questions: [{
          allowsOther: false,
          header: "Region",
          id: "region",
          options: [{ description: "Europe", label: "eu" }],
          question: "Which region should it deploy to?",
          remoteAnswerable: true,
          secret: false,
        }],
        summary: "Codex needs user input",
      });
      for (const answers of [
        { region: { answers: [] } },
        { region: { answers: [""] } },
        { region: { answers: ["eu", "us"] } },
      ]) {
        expect(await harnessed.resolve({
          answers,
          interactionId: plainId,
          kind: "resolve_interaction",
          revision: 1,
        })).toEqual({ code: "INTERACTION_ANSWER_CONSTRAINT_FAILED", state: "failed" });
      }
      expect(await harnessed.resolve({
        answers: { region: { answers: ["eu"] } },
        interactionId: plainId,
        kind: "resolve_interaction",
        revision: 1,
      })).toMatchObject({ state: "applied" });
      expect(harnessed.commands.at(-1)).toMatchObject({
        kind: "interaction.resolve",
        resolution: { answers: { region: { answers: ["eu"] } }, kind: "user_answers" },
      });

    } finally {
      await harnessed.adapter.close();
      value.store.close();
    }
  });

  test("keeps every MCP form local regardless of its public field shape", async () => {
    const value = await fixture();
    const textId = "70000000-0000-4000-8000-000000000331";
    const typedId = "70000000-0000-4000-8000-000000000332";
    const mixedRequiredId = "70000000-0000-4000-8000-000000000333";
    const optionalUnsupportedId = "70000000-0000-4000-8000-000000000334";
    const prototypeNameId = "70000000-0000-4000-8000-000000000335";
    const allOptionalId = "70000000-0000-4000-8000-000000000336";
    const tooManyFieldsId = "70000000-0000-4000-8000-000000000337";
    const unicodeOneId = "70000000-0000-4000-8000-000000000338";
    const unicodeTwoId = "70000000-0000-4000-8000-000000000339";
    const aggregateId = "70000000-0000-4000-8000-000000000340";
    admitDisplay(value, textId, {
      fields: [{
        format: null,
        maxLength: 64,
        minLength: 1,
        name: "region",
        required: true,
        type: "string",
      }],
      kind: "mcp_elicitation",
      mayContainSecrets: true,
      mode: "form",
      serverName: "deploy_server",
      summary: "Review provider input",
      url: null,
    });
    admitDisplay(value, typedId, {
      fields: [{
        choices: ["blue", "green"],
        name: "slot",
        required: true,
        type: "single_select",
      }],
      kind: "mcp_elicitation",
      mayContainSecrets: true,
      mode: "form",
      serverName: "deploy_server",
      summary: "Review provider input",
      url: null,
    });
    admitDisplay(value, mixedRequiredId, {
      fields: [
        {
          format: null,
          maxLength: 64,
          minLength: 1,
          name: "region",
          required: true,
          type: "string",
        },
        {
          choices: ["blue", "green"],
          name: "slot",
          required: true,
          type: "single_select",
        },
      ],
      kind: "mcp_elicitation",
      mayContainSecrets: true,
      mode: "form",
      serverName: "deploy_server",
      summary: "Review provider input",
      url: null,
    });
    admitDisplay(value, optionalUnsupportedId, {
      fields: [
        {
          format: null,
          maxLength: 64,
          minLength: 1,
          name: "region",
          required: true,
          type: "string",
        },
        {
          choices: ["blue", "green"],
          name: "slot",
          required: false,
          type: "single_select",
        },
      ],
      kind: "mcp_elicitation",
      mayContainSecrets: true,
      mode: "form",
      serverName: "deploy_server",
      summary: "Review provider input",
      url: null,
    });
    admitDisplay(value, prototypeNameId, {
      fields: [
        {
          format: null,
          maxLength: 64,
          minLength: 1,
          name: "region",
          required: true,
          type: "string",
        },
        {
          format: null,
          maxLength: 64,
          minLength: 0,
          name: "constructor",
          required: false,
          type: "string",
        },
      ],
      kind: "mcp_elicitation",
      mayContainSecrets: true,
      mode: "form",
      serverName: "deploy_server",
      summary: "Review provider input",
      url: null,
    });
    admitDisplay(value, allOptionalId, {
      fields: [{
        format: null,
        maxLength: 64,
        minLength: 0,
        name: "notes",
        required: false,
        type: "string",
      }],
      kind: "mcp_elicitation",
      mayContainSecrets: true,
      mode: "form",
      serverName: "deploy_server",
      summary: "Review provider input",
      url: null,
    });
    admitDisplay(value, tooManyFieldsId, {
      fields: Array.from({ length: 9 }, (_, index) => ({
        format: null,
        maxLength: 64,
        minLength: 0,
        name: `field_${String(index + 1)}`,
        required: false,
        type: "string" as const,
      })),
      kind: "mcp_elicitation",
      mayContainSecrets: true,
      mode: "form",
      serverName: "deploy_server",
      summary: "Review provider input",
      url: null,
    });
    for (const [interactionId, length] of [
      [unicodeOneId, 1],
      [unicodeTwoId, 2],
    ] as const) {
      admitDisplay(value, interactionId, {
        fields: [{
          format: null,
          maxLength: length,
          minLength: length,
          name: "symbol",
          required: true,
          type: "string",
        }],
        kind: "mcp_elicitation",
        mayContainSecrets: true,
        mode: "form",
        serverName: "deploy_server",
        summary: "Review provider input",
        url: null,
      });
    }
    admitDisplay(value, aggregateId, {
      fields: Array.from({ length: 8 }, (_, index) => ({
        format: null,
        maxLength: 16_384,
        minLength: 0,
        name: `field_${String(index)}`,
        required: false,
        type: "string" as const,
      })),
      kind: "mcp_elicitation",
      mayContainSecrets: true,
      mode: "form",
      serverName: "deploy_server",
      summary: "Review provider input",
      url: null,
    });
    const harnessed = await harness(value);
    try {
      const text = await harnessed.projected(textId);
      expect(text?.questions).toBeUndefined();
      expect(text?.remotePolicy).toMatchObject({
        actions: [],
        questions: [],
        reasonCodes: ["MCP_ANSWER_LOCAL_ONLY"],
      });
      // The server name and every unanswerable field name stay local.
      expect(JSON.stringify(text)).not.toContain("deploy_server");
      const typed = await harnessed.projected(typedId);
      expect(typed?.questions).toBeUndefined();
      expect(typed?.remotePolicy).toMatchObject({
        actions: [],
        questions: [],
        reasonCodes: ["MCP_ANSWER_LOCAL_ONLY"],
      });
      expect(JSON.stringify(typed)).not.toContain("slot");
      const mixedRequired = await harnessed.projected(mixedRequiredId);
      expect(mixedRequired?.remotePolicy).toMatchObject({
        actions: [],
        questions: [],
        reasonCodes: ["MCP_ANSWER_LOCAL_ONLY"],
      });
      const optionalUnsupported = await harnessed.projected(optionalUnsupportedId);
      expect(optionalUnsupported?.remotePolicy).toMatchObject({
        actions: [],
        questions: [],
        reasonCodes: ["MCP_ANSWER_LOCAL_ONLY"],
      });
      expect(JSON.stringify(optionalUnsupported)).not.toContain("slot");
      expect(optionalUnsupported?.detailMarkdown)
        .toContain("- It is completed on the machine running the session.");
      expect(optionalUnsupported?.detailMarkdown)
        .not.toContain("can be answered from here");
      const prototypeName = await harnessed.projected(prototypeNameId);
      expect(prototypeName?.remotePolicy).toMatchObject({
        actions: [],
        questions: [],
        reasonCodes: ["MCP_ANSWER_LOCAL_ONLY"],
      });
      const tooManyFields = await harnessed.projected(tooManyFieldsId);
      expect(tooManyFields?.remotePolicy).toMatchObject({
        actions: [],
        questions: [],
        reasonCodes: ["MCP_ANSWER_LOCAL_ONLY"],
      });
      expect(tooManyFields?.detailMarkdown)
        .toContain("- It is completed on the machine running the session.");
      expect(tooManyFields?.detailMarkdown)
        .not.toContain("can be answered from here.");

      expect(await harnessed.resolve({
        answers: { region: { answers: ["eu"] } },
        interactionId: textId,
        kind: "resolve_interaction",
        revision: 1,
      })).toEqual({ code: "INTERACTION_ELICITATION_NOT_REMOTE", state: "failed" });
      // Question IDs are untrusted provider strings. An omitted optional name
      // that shadows Object.prototype must not be mistaken for an answer.
      expect(await harnessed.resolve({
        answers: { region: { answers: ["eu"] } },
        interactionId: prototypeNameId,
        kind: "resolve_interaction",
        revision: 1,
      })).toEqual({ code: "INTERACTION_ELICITATION_NOT_REMOTE", state: "failed" });
      expect(await harnessed.resolve({
        answers: {},
        interactionId: allOptionalId,
        kind: "resolve_interaction",
        revision: 1,
      })).toEqual({ code: "INTERACTION_ELICITATION_NOT_REMOTE", state: "failed" });
      expect(await harnessed.resolve({
        answers: Object.fromEntries(Array.from({ length: 8 }, (_, index) => [
          `field_${String(index)}`,
          { answers: ["x".repeat(10_000)] },
        ])),
        interactionId: aggregateId,
        kind: "resolve_interaction",
        revision: 1,
      })).toEqual({ code: "INTERACTION_ELICITATION_NOT_REMOTE", state: "failed" });
      expect(await harnessed.resolve({
        answers: { symbol: { answers: ["😀"] } },
        interactionId: unicodeOneId,
        kind: "resolve_interaction",
        revision: 1,
      })).toEqual({ code: "INTERACTION_ELICITATION_NOT_REMOTE", state: "failed" });
      expect(await harnessed.resolve({
        answers: { symbol: { answers: ["😀"] } },
        interactionId: unicodeTwoId,
        kind: "resolve_interaction",
        revision: 1,
      })).toEqual({ code: "INTERACTION_ELICITATION_NOT_REMOTE", state: "failed" });

      // A form with no exact remote action refuses every submitted field.
      expect(await harnessed.resolve({
        answers: { slot: { answers: ["blue"] } },
        interactionId: typedId,
        kind: "resolve_interaction",
        revision: 1,
      })).toEqual({ code: "INTERACTION_ELICITATION_NOT_REMOTE", state: "failed" });
      expect(await harnessed.resolve({
        answers: { region: { answers: ["eu"] } },
        interactionId: typedId,
        kind: "resolve_interaction",
        revision: 1,
      })).toEqual({ code: "INTERACTION_ELICITATION_NOT_REMOTE", state: "failed" });
      expect(await harnessed.resolve({
        answers: { region: { answers: ["eu", "us"] } },
        interactionId: textId,
        kind: "resolve_interaction",
        revision: 1,
      })).toEqual({ code: "INTERACTION_ELICITATION_NOT_REMOTE", state: "failed" });
      expect(await harnessed.resolve({
        answers: { region: { answers: ["eu"] } },
        interactionId: mixedRequiredId,
        kind: "resolve_interaction",
        revision: 1,
      })).toEqual({ code: "INTERACTION_ELICITATION_NOT_REMOTE", state: "failed" });
      expect(await harnessed.resolve({
        answers: { region: { answers: ["eu"] } },
        interactionId: optionalUnsupportedId,
        kind: "resolve_interaction",
        revision: 1,
      })).toEqual({ code: "INTERACTION_ELICITATION_NOT_REMOTE", state: "failed" });
      expect(harnessed.commands).toHaveLength(0);
    } finally {
      await harnessed.adapter.close();
      value.store.close();
    }
  });

  test("refuses accepting a file change from a device and preserves every earlier code", async () => {
    const value = await fixture();
    const interactionId = "70000000-0000-4000-8000-000000000341";
    admitDisplay(value, interactionId, {
      availableDecisions: ["once", "decline"],
      grantRoot: "src",
      kind: "file_change_approval",
      reason: "Write the generated module",
      summary: "Allow a file change",
    });
    const harnessed = await harness(value);
    try {
      const event = await harnessed.projected(interactionId);
      expect(event).toMatchObject({
        remotePolicy: {
          actions: ["decline"],
          questions: [],
          reasonCodes: ["FILE_CHANGE_APPROVAL_LOCAL_ONLY"],
        },
      });
      expect(event?.availableDecisions).toBeUndefined();
      expect(event?.commandClass).toBeUndefined();
      expect(event?.detailMarkdown).toContain("cannot show the exact affected paths");

      expect(await harnessed.resolve({
        decision: "once",
        interactionId,
        kind: "resolve_interaction",
        revision: 1,
      })).toEqual({ code: "INTERACTION_FILE_CHANGE_ACCEPT_NOT_REMOTE", state: "failed" });
      expect(await harnessed.resolve({
        answers: { region: { answers: ["eu"] } },
        interactionId,
        kind: "resolve_interaction",
        revision: 1,
      })).toEqual({ code: "INTERACTION_ANSWERS_NOT_REMOTE", state: "failed" });
      expect(await harnessed.resolve({
        decision: "decline",
        interactionId,
        kind: "resolve_interaction",
        revision: 4,
      })).toEqual({ code: "INTERACTION_REVISION_STALE", state: "failed" });
      expect(await harnessed.resolve({
        decision: "decline",
        interactionId,
        kind: "resolve_interaction",
        revision: 1,
      })).toEqual({ code: "APPLIED", state: "applied" });
      value.store.expireInteraction({ id: interactionId, expectedRevision: 1 });
      expect(await harnessed.resolve({
        decision: "decline",
        interactionId,
        kind: "resolve_interaction",
        revision: 1,
      })).toEqual({ code: "INTERACTION_ALREADY_RESOLVED", state: "failed" });
    } finally {
      await harnessed.adapter.close();
      value.store.close();
    }
  });

  test("refuses a decision on a question and an answer on an approval", async () => {
    const value = await fixture();
    const questionId = "70000000-0000-4000-8000-000000000351";
    admitDisplay(value, questionId, {
      blocking: true,
      kind: "user_input",
      questions: [{
        allowsOther: true,
        header: "Region",
        id: "region",
        options: null,
        question: "Which region?",
        secret: false,
      }],
      summary: "Codex needs user input",
    });
    const harnessed = await harness(value);
    try {
      expect(await harnessed.resolve({
        decision: "once",
        interactionId: questionId,
        kind: "resolve_interaction",
        revision: 1,
      })).toEqual({ code: "INTERACTION_DECISION_NOT_REMOTE", state: "failed" });
    } finally {
      await harnessed.adapter.close();
      value.store.close();
    }
  });

  test("keeps projection and live-verifier action membership identical for every kind", async () => {
    const value = await fixture();
    const fixtures = [
      {
        answers: { value: { answers: ["eu"] } },
        display: {
          availableDecisions: ["once", "decline"],
          commandClass: "git status",
          kind: "command_approval",
          reason: null,
          summary: "Allow git status",
          workingDirectory: "src",
        },
        id: "70000000-0000-4000-8000-000000000361",
      },
      {
        answers: { value: { answers: ["eu"] } },
        display: {
          availableDecisions: ["once", "decline"],
          grantRoot: "src",
          kind: "file_change_approval",
          reason: null,
          summary: "Allow file changes",
        },
        id: "70000000-0000-4000-8000-000000000362",
      },
      {
        answers: { value: { answers: ["eu"] } },
        display: {
          allowsSessionScope: true,
          kind: "permission_approval",
          reason: null,
          requested: [{ name: "workspace_write" }],
          summary: "Allow workspace write",
        },
        id: "70000000-0000-4000-8000-000000000363",
      },
      {
        answers: { value: { answers: ["eu"] } },
        display: {
          blocking: true,
          kind: "user_input",
          questions: [{
            allowsOther: false,
            header: "Region",
            id: "value",
            options: [{ description: "Europe", label: "eu" }],
            question: "Which region?",
            remoteAnswerable: true,
            secret: false,
          }],
          summary: "Codex needs user input",
        },
        id: "70000000-0000-4000-8000-000000000364",
      },
      {
        answers: { value: { answers: ["eu"] } },
        display: {
          fields: [{
            format: null,
            maxLength: 10,
            minLength: 1,
            name: "value",
            required: true,
            type: "string",
          }],
          kind: "mcp_elicitation",
          mayContainSecrets: true,
          mode: "form",
          serverName: "fixture",
          summary: "Review provider input",
          url: null,
        },
        id: "70000000-0000-4000-8000-000000000365",
      },
    ] satisfies ReadonlyArray<{
      answers: Record<string, { answers: string[] }>;
      display: Parameters<StateStore["admitInteraction"]>[0]["display"];
      id: string;
    }>;
    for (const item of fixtures) admitDisplay(value, item.id, item.display);
    const harnessed = await harness(value);
    try {
      for (const item of fixtures) {
        const event = await harnessed.projected(item.id);
        const policy = event?.remotePolicy as { actions?: readonly string[] } | undefined;
        const projectedActions = policy?.actions ?? [];
        for (const action of ["approve_once", "decline", "answer"] as const) {
          const payload = action === "answer"
            ? {
                answers: item.answers,
                interactionId: item.id,
                kind: "resolve_interaction" as const,
                revision: 1,
              }
            : {
                decision: action === "approve_once" ? "once" as const : "decline" as const,
                interactionId: item.id,
                kind: "resolve_interaction" as const,
                revision: 1,
              };
          const result = await harnessed.resolve(payload);
          expect(result.state === "applied").toBe(projectedActions.includes(action));
        }
      }
    } finally {
      await harnessed.adapter.close();
      value.store.close();
    }
  });

  test("uses the injected deadline clock, freezes a projected revision, and closes prepared state", async () => {
    const value = await fixture();
    const deadlineId = "70000000-0000-4000-8000-000000000371";
    admitDisplay(value, deadlineId, {
      availableDecisions: ["once", "decline"],
      commandClass: "git status",
      kind: "command_approval",
      reason: null,
      summary: "Allow git status",
      workingDirectory: "src",
    });
    const deadlineAt = value.store.requireInteraction(deadlineId).deadlineAt;
    value.setNow(deadlineAt - 1);
    const harnessed = await harness(value);
    try {
      const before = await harnessed.projected(deadlineId);
      expect(before?.remotePolicy).toMatchObject({
        actions: ["decline"],
        deadlineAt,
        reasonCodes: ["COMMAND_APPROVAL_LOCAL_ONLY"],
      });
      value.setNow(deadlineAt);
      expect(await harnessed.resolve({
        decision: "decline",
        interactionId: deadlineId,
        kind: "resolve_interaction",
        revision: 1,
      })).toEqual({ code: "INTERACTION_EXPIRED", state: "failed" });
      // The cached event is evidence from first observation; the client and
      // final verifier both suppress it at deadline without mutating its digest.
      expect(await harnessed.projected(deadlineId)).toEqual(before);

      const preparedId = "70000000-0000-4000-8000-000000000372";
      admitDisplay(value, preparedId, {
        availableDecisions: ["once", "decline"],
        commandClass: "git status",
        kind: "command_approval",
        reason: null,
        summary: "Allow git status",
        workingDirectory: "src",
      });
      value.store.prepareInteractionResponse({
        expectedRevision: 1,
        id: preparedId,
        responseDigest: "f".repeat(64),
      });
      const prepared = await harnessed.projected(preparedId);
      expect(prepared).toMatchObject({
        revision: 2,
        state: "response_prepared",
        remotePolicy: {
          actions: [],
          questions: [],
          reasonCodes: ["INTERACTION_NOT_PENDING"],
        },
      });
      expect(await harnessed.resolve({
        decision: "decline",
        interactionId: preparedId,
        kind: "resolve_interaction",
        revision: 2,
      })).toEqual({ code: "INTERACTION_ALREADY_RESOLVED", state: "failed" });
    } finally {
      await harnessed.adapter.close();
      value.store.close();
    }
  });
});

describe("settings commands and the device registry", () => {
  const leaseAuthority = { bootGeneration: 1, bootId: "boot_00000001", fence: 1 } as const;

  test("captures one Codex default binding without deriving it from an established session", async () => {
    const value = await fixture();
    let reads = 0;
    const readDefault = value.store.readDefaultPreset.bind(value.store);
    Object.defineProperty(value.store, "readDefaultPreset", {
      configurable: true,
      value: () => { reads += 1; return readDefault(); },
    });
    const adapter = new StateBackedCloudDaemonAdapter({
      executeRemote: () => { throw new Error("default observation must not invoke a command"); },
      gatewayKeyCustody: { hasKey: () => Promise.resolve(false), setKey: () => Promise.resolve() },
      paths: value.paths,
      readSessionProjectionForCloud: () => { throw new Error("default observation must not read a session"); },
      store: value.store,
    });
    try {
      expect(value.store.requireSession(value.sessionId).preset).toBe("high");
      const signal = new AbortController().signal;
      expect(await adapter.readDeviceRegistryProjection({ signal })).toMatchObject({
        profileBinding: { preset: "ultra", profileKey: "codex:gpt-6-astra:ultra" },
        registry: { defaultPreset: "ultra" },
      });
      expect(reads).toBe(1);
      value.store.setDefaultPreset("low");
      expect(await adapter.readDeviceRegistryProjection({ signal })).toMatchObject({
        profileBinding: { preset: "low", profileKey: "codex:gpt-5.6-luna:max" },
        registry: { defaultPreset: "low" },
      });
      expect(reads).toBe(2);
      value.store.setDefaultPreset("fable-max");
      expect(await adapter.readDeviceRegistryProjection({ signal })).toMatchObject({
        profileBinding: { preset: "ultra", profileKey: "codex:gpt-6-astra:ultra" },
        registry: { defaultPreset: "ultra" },
      });
      expect(reads).toBe(3);
    } finally {
      await adapter.close();
      value.store.close();
    }
  });

  test("captures the current tier after asynchronous custody work completes", async () => {
    const value = await fixture();
    const adapter = new StateBackedCloudDaemonAdapter({
      executeRemote: () => Promise.resolve({}),
      gatewayKeyCustody: {
        hasKey: () => { value.store.setDefaultPreset("high"); return Promise.resolve(false); },
        setKey: () => Promise.resolve(),
      },
      paths: value.paths,
      readSessionProjectionForCloud: value.codex.readSessionProjectionForCloud,
      store: value.store,
    });
    try {
      expect(value.store.readDefaultPreset()).toBe("ultra");
      expect(await adapter.readDeviceRegistryProjection({ signal: new AbortController().signal })).toMatchObject({
        profileBinding: { preset: "high", profileKey: "codex:gpt-6-astra:max" },
        registry: { defaultPreset: "high" },
      });
    } finally {
      await adapter.close();
      value.store.close();
    }
  });

  test("applies every settings command locally and never reaches the provider", async () => {
    const value = await fixture();
    const commands: LocalCommand[] = [];
    const gatewayKeys: string[] = [];
    const adapter = new StateBackedCloudDaemonAdapter({
      readSessionProjectionForCloud: value.codex.readSessionProjectionForCloud,
      executeRemote: (command) => { commands.push(command); return Promise.resolve({}); },
      gatewayKeyCustody: {
        hasKey: () => Promise.resolve(gatewayKeys.length > 0),
        setKey: (key) => { gatewayKeys.push(key); return Promise.resolve(); },
      },
      paths: value.paths,
      store: value.store,
    });
    try {
      const signal = new AbortController().signal;
      const authority = await adapter.resolveCommandAuthority({ sessionPublicId: value.sessionId, signal });
      expect(authority).not.toBeNull();
      let sequence = 30;
      const execute = async (
        payload: Parameters<typeof adapter.execute>[0]["payload"],
      ): Promise<unknown> => {
        sequence += 1;
        return await adapter.execute({
          authority: authority as CloudLocalCommandAuthority,
          idempotencyKey: `00000000-0000-7000-8000-0000000000${String(sequence)}`,
          leaseAuthority,
          payload,
          sessionPublicId: value.sessionId,
          signal,
        });
      };

      expect(await execute({ kind: "set_approval_mode", mode: "manual", scope: "session" }))
        .toEqual({ code: "APPLIED", state: "applied" });
      expect(value.store.readSessionApprovalMode(value.sessionId as SessionId))
        .toEqual({ mode: "manual", source: "session" });
      expect(await execute({ kind: "set_approval_mode", mode: "auto:workspace", scope: "default" }))
        .toEqual({ code: "APPLIED", state: "applied" });
      expect(value.store.readDefaultApprovalMode()).toBe("auto:workspace");

      expect(await execute({ kind: "set_show_thinking", enabled: true, scope: "session" }))
        .toEqual({ code: "APPLIED", state: "applied" });
      expect(value.store.readSessionShowThinking(value.sessionId as SessionId))
        .toEqual({ enabled: true, source: "session" });
      expect(await execute({ kind: "set_show_thinking", enabled: true, scope: "default" }))
        .toEqual({ code: "APPLIED", state: "applied" });
      expect(value.store.readDefaultShowThinking()).toBe(true);

      expect(await execute({ kind: "set_default_preset", preset: "low" }))
        .toEqual({ code: "APPLIED", state: "applied" });
      expect(value.store.readDefaultPreset()).toBe("low");

      expect(await execute({ kind: "archive_session", archived: true }))
        .toEqual({ code: "APPLIED", state: "applied" });
      expect(value.store.requireSession(value.sessionId).archivedAt).toBeGreaterThan(0);
      expect(value.store.listSessions(50).map((session) => session.id)).not.toContain(value.sessionId);
      expect(value.store.listSessions(50, undefined, true).map((session) => session.id))
        .toContain(value.sessionId);
      expect(await execute({ kind: "archive_session", archived: false }))
        .toEqual({ code: "APPLIED", state: "applied" });
      expect(value.store.requireSession(value.sessionId).archivedAt).toBeUndefined();

      const gatewayKey = ["gw", "k".repeat(24)].join("-");
      expect(await execute({ kind: "set_gateway_key", key: gatewayKey }))
        .toEqual({ code: "APPLIED", state: "applied" });
      expect(gatewayKeys).toEqual([gatewayKey]);

      // No settings command touches the provider.
      expect(commands).toEqual([]);

      // Renaming is provider-observable and stays on the execution path; a
      // cleared name resets the session to the default title.
      expect(await execute({ kind: "rename_session", name: "Renamed remotely" }))
        .toEqual({ code: "APPLIED", state: "applied" });
      expect(commands.at(-1)).toMatchObject({ kind: "session.rename", name: "Renamed remotely" });
      expect(await execute({ kind: "rename_session", name: null }))
        .toEqual({ code: "APPLIED", state: "applied" });
      expect(commands.at(-1)).toMatchObject({ kind: "session.rename", name: "Untitled session" });
    } finally {
      await adapter.close();
      value.store.close();
    }
  });

  test("live projection honours the stored show-thinking setting", async () => {
    const value = await fixture();
    const adapter = new StateBackedCloudDaemonAdapter({
      readSessionProjectionForCloud: value.codex.readSessionProjectionForCloud,
      executeRemote: () => Promise.resolve({}),
      paths: value.paths,
      store: value.store,
    });
    try {
      const signal = new AbortController().signal;
      expect((await adapter.readLiveEvents({
        afterLocalSequence: null,
        limit: 10,
        sessionPublicId: value.sessionId,
        signal,
      })).includeThinking).toBe(false);
      value.store.setSessionShowThinking(value.sessionId as SessionId, true);
      expect((await adapter.readLiveEvents({
        afterLocalSequence: null,
        limit: 10,
        sessionPublicId: value.sessionId,
        signal,
      })).includeThinking).toBe(true);
      value.store.setSessionShowThinking(value.sessionId as SessionId, null);
      value.store.setDefaultShowThinking(true);
      expect((await adapter.readLiveEvents({
        afterLocalSequence: null,
        limit: 10,
        sessionPublicId: value.sessionId,
        signal,
      })).includeThinking).toBe(true);
    } finally {
      await adapter.close();
      value.store.close();
    }
  });

  test("projects labels and adoption aggregates without private candidate detail", async () => {
    const value = await fixture();
    const profileId = value.store.requireSession(value.sessionId).profileId;
    const profileGeneration = value.store.requireProfileById(profileId).processGeneration;
    const adoptionRuntimeProfile = {
      approvalPolicy: "on-request" as const,
      computerUse: true as const,
      enabledApps: [],
      fast: false,
      model: "gpt-6-astra",
      observedAt: 2_000,
      permissionProfile: ":workspace" as const,
      pluginCapability: true as const,
      preset: "high" as const,
      processGeneration: profileGeneration,
      profileId,
      reasoningEffort: "max" as const,
      reviewMode: "auto_review" as const,
      serviceTier: null,
    };
    value.store.setSessionAdoptionPolicy({ provider: "codex", profileId });
    const pending = value.store.upsertSessionAdoptionCandidate({
      provider: "codex",
      providerThreadId: "private-pending-thread",
      title: "PRIVATE PENDING TITLE",
      state: "idle",
      liveness: "unknown",
    });
    const adopted = value.store.upsertSessionAdoptionCandidate({
      provider: "codex",
      providerThreadId: "private-adopted-thread",
      title: "PRIVATE ADOPTED TITLE",
      state: "idle",
      liveness: "not_live",
    });
    const claimedAdopted = value.store.fenceSessionAdoptionCandidateForClaim({
      provider: "codex",
      providerThreadId: adopted.providerThreadId,
      expectedRevision: adopted.revision,
    });
    const activeAdoption = value.store.adoptSessionCandidate({
      providerAuthority: value.store.requireProviderAccountAuthority(profileId, "codex"),
      expectedCandidateRevision: claimedAdopted.revision,
      fastEnabled: false,
      preset: "high",
      requirement: presetRequirements.high,
      profileId,
      profileGeneration,
      runtimeProfile: adoptionRuntimeProfile,
      providerAccountKey: codexProviderAccountKey,
      provider: "codex",
      providerThreadId: adopted.providerThreadId,
    });
    const fenced = value.store.upsertSessionAdoptionCandidate({
      provider: "codex",
      providerThreadId: "private-fenced-thread",
      title: "PRIVATE FENCED TITLE",
      state: "idle",
      liveness: "not_live",
    });
    const claimedFenced = value.store.fenceSessionAdoptionCandidateForClaim({
      provider: "codex",
      providerThreadId: fenced.providerThreadId,
      expectedRevision: fenced.revision,
    });
    const fencedAdoption = value.store.adoptSessionCandidate({
      providerAuthority: value.store.requireProviderAccountAuthority(profileId, "codex"),
      expectedCandidateRevision: claimedFenced.revision,
      fastEnabled: false,
      preset: "high",
      requirement: presetRequirements.high,
      profileId,
      profileGeneration,
      runtimeProfile: adoptionRuntimeProfile,
      providerAccountKey: codexProviderAccountKey,
      provider: "codex",
      providerThreadId: fenced.providerThreadId,
    });
    value.store.detachPersonalSession({ sessionId: fencedAdoption.session.id });
    expect(pending.status).toBe("pending");
    const oompaTask = value.store.createSessionTaskStore().create({
      idempotencyKey: "00000000-0000-4000-8000-000000000711",
      minutes: 60,
      name: "Public Oompa conversation task",
      prompt: "Continue the ordinary Oompa conversation.",
      sessionId: activeAdoption.session.id,
      status: "paused",
    });
    const projectedSessionIds: string[] = [];
    const adapter = new StateBackedCloudDaemonAdapter({
      readSessionProjectionForCloud: (sessionPublicId, signal) => {
        signal.throwIfAborted();
        projectedSessionIds.push(sessionPublicId);
        const session = value.store.requireSession(sessionPublicId);
        if (session.providerThreadId === undefined) {
          throw new Error("missing provider binding");
        }
        return Promise.resolve({
          ...value.codex.projection,
          providerThreadId: session.providerThreadId,
          title: session.title,
        });
      },
      executeRemote: () => Promise.resolve({}),
      gatewayKeyCustody: { hasKey: () => Promise.resolve(true), setKey: () => Promise.resolve() },
      machineLabel: "Studio",
      paths: value.paths,
      store: value.store,
    });
    try {
      const signal = new AbortController().signal;
      const sessions = await adapter.listSessions({ limit: 25, signal });
      expect(sessions.sessions.map((session) => session.publicId)).toContain(
        activeAdoption.session.id,
      );
      expect(projectedSessionIds).toContain(value.sessionId);
      expect(projectedSessionIds).toContain(activeAdoption.session.id);
      const registry = await adapter.readDeviceRegistry({ signal });
      expect(parseDeviceRegistryPayload(registry)).toEqual(registry);
      expect(registry).toMatchObject({
        defaultApprovalMode: "auto:all",
        defaultPreset: "ultra",
        machineLabel: "Studio",
        proseAutorespondConfigured: true,
        sessionAdoption: {
          claude: { adopted: 0, enabled: false, fenced: 0, pending: 0 },
          codex: { adopted: 1, enabled: true, fenced: 1, pending: 1 },
        },
        showThinkingDefault: false,
        version: 1,
      });
      // The fixture account and session labels embed a private path; the
      // projection replaces them rather than leaking a filesystem location.
      expect(JSON.stringify(registry)).not.toContain(privateRootFixture);
      expect(JSON.stringify(registry)).not.toContain("private-pending-thread");
      expect(JSON.stringify(registry)).not.toContain("PRIVATE PENDING TITLE");
      expect(JSON.stringify(registry)).not.toContain("upload-usage");
      expect(JSON.stringify(registry)).not.toContain("FREQ=WEEKLY;BYDAY=MO");
      expect(JSON.stringify(registry)).not.toContain(adopted.providerThreadId);
      expect(JSON.stringify(registry)).not.toContain(fenced.providerThreadId);
      expect(registry.accounts).toEqual([
        expect.objectContaining({ provider: "codex", publicId: expect.any(String), status: "signed_in" }),
      ]);
      expect(registry.scheduledTasks).toEqual([
        {
          cadence: "every 60 minutes",
          id: oompaTask.id,
          kind: "hra_conversation",
          label: "Public Oompa conversation task",
          nextRunAt: null,
          sessionPublicId: activeAdoption.session.id,
        },
      ]);
      const notificationProjection = await adapter.readDeviceRegistryProjection({ signal });
      expect(notificationProjection).toMatchObject({
        notificationEmail: { enabled: false, revision: 1 },
        notificationHours: { revision: 1 },
        notificationPolicyRevision: 1,
      });
      value.store.updateNotificationEmailPolicy({ enabled: true, expectedRevision: 1 });
      expect(await adapter.readDeviceRegistryProjection({ signal })).toMatchObject({
        notificationEmail: { enabled: true, revision: 2 },
        notificationHours: { revision: 2 },
        notificationPolicyRevision: 2,
      });
      admitCloudInteraction(
        value,
        "40000000-0000-4000-8000-000000000001",
        "40000000-0000-4000-8000-000000000002",
      );
      const attention = await adapter.readAttentionNotificationSnapshot({
        limit: 64,
        now: value.now(),
        signal,
      });
      expect(attention).toMatchObject({
        candidates: [{
          interactionId: "40000000-0000-4000-8000-000000000001",
          interactionKind: "mcp_elicitation",
          interactionRevision: 1,
          remoteActions: [],
          sessionPublicId: value.sessionId,
        }],
        notificationEmail: { enabled: true, revision: 2 },
        notificationHours: { revision: 2 },
        notificationPolicyRevision: 2,
        observedAt: value.now(),
        status: "complete",
      });
      expect(Object.keys(attention.candidates[0] ?? {}).sort()).toEqual([
        "interactionDeadline",
        "interactionId",
        "interactionKind",
        "interactionRevision",
        "remoteActions",
        "sessionPublicId",
      ]);
      expect(JSON.stringify(attention)).not.toMatch(/display|question|prompt|path|provider/i);
      const readEmail = value.store.readNotificationEmailPolicy.bind(value.store);
      Object.defineProperty(value.store, "readNotificationEmailPolicy", {
        configurable: true,
        value: () => ({ ...readEmail(), revision: 3 }),
      });
      await expect(adapter.readDeviceRegistryProjection({ signal }))
        .rejects.toThrow("NOTIFICATION_POLICY_REVISION_DIVERGED");
      await expect(adapter.readAttentionNotificationSnapshot({
        limit: 64,
        now: value.now(),
        signal,
      })).rejects.toThrow("NOTIFICATION_POLICY_REVISION_DIVERGED");
    } finally {
      await adapter.close();
      value.store.close();
    }
  });

  test("projects native and adopted Oompa tasks with the same public shape", async () => {
    const value = await fixture();
    const nativeSession = value.store.requireSession(value.sessionId);
    const adopted = adoptPersonalCodexSession(value, "old-personal-codex-thread");
    const privateDesktopAutomation = {
      cadence: "FREQ=WEEKLY;BYDAY=MO",
      id: "desktop-private-automation-id",
      label: "Desktop private automation label",
      sessionPublicId: "sess_private_target_correlation",
    } as const;
    let desktopAutomationReads = 0;
    const taskStore = value.store.createSessionTaskStore();
    const nativeTask = taskStore.create({
      idempotencyKey: "00000000-0000-4000-8000-000000000721",
      minutes: 30,
      name: "Native public task",
      prompt: "Continue the native conversation.",
      sessionId: nativeSession.id,
      status: "paused",
    });
    const adoptedTask = taskStore.create({
      idempotencyKey: "00000000-0000-4000-8000-000000000722",
      minutes: 30,
      name: "Adopted public task",
      prompt: "Continue the adopted conversation.",
      sessionId: adopted.session.id,
      status: "paused",
    });
    const adapterOptions = {
      readSessionProjectionForCloud: value.codex.readSessionProjectionForCloud,
      executeRemote: () => Promise.resolve({}),
      paths: value.paths,
      // Deliberately model the retired adapter option. Even if a caller still
      // carries it, Desktop automations remain private age-gate authority and
      // cannot become registry schedules or an origin marker.
      readCodexAutomations: () => {
        desktopAutomationReads += 1;
        return Promise.resolve([privateDesktopAutomation]);
      },
      store: value.store,
    };
    const adapter = new StateBackedCloudDaemonAdapter(
      adapterOptions as unknown as ConstructorParameters<typeof StateBackedCloudDaemonAdapter>[0],
    );
    try {
      const signal = new AbortController().signal;
      const registry = await adapter.readDeviceRegistry({ signal });
      const nativeRow = registry.scheduledTasks.find((task) => task.id === nativeTask.id);
      const adoptedRow = registry.scheduledTasks.find((task) => task.id === adoptedTask.id);
      expect(nativeRow).toEqual({
        cadence: "every 30 minutes",
        id: nativeTask.id,
        kind: "hra_conversation",
        label: "Native public task",
        nextRunAt: null,
        sessionPublicId: nativeSession.id,
      });
      expect(adoptedRow).toEqual({
        cadence: "every 30 minutes",
        id: adoptedTask.id,
        kind: "hra_conversation",
        label: "Adopted public task",
        nextRunAt: null,
        sessionPublicId: adopted.session.id,
      });
      expect(Object.keys(nativeRow ?? {}).sort()).toEqual(Object.keys(adoptedRow ?? {}).sort());
      expect({ ...nativeRow, id: "task", label: "task", sessionPublicId: "session" })
        .toEqual({ ...adoptedRow, id: "task", label: "task", sessionPublicId: "session" });
      const publicRegistry = JSON.stringify(registry);
      expect(desktopAutomationReads).toBe(0);
      expect(publicRegistry).not.toContain("codex_automation");
      expect(publicRegistry).not.toContain("thread_0001");
      expect(publicRegistry).not.toContain("old-personal-codex-thread");
      for (const privateValue of Object.values(privateDesktopAutomation)) {
        expect(publicRegistry).not.toContain(privateValue);
      }
    } finally {
      await adapter.close();
      value.store.close();
    }
  });

  test("uploads the archived flag in session metadata only while archived", async () => {
    const value = await fixture();
    const adapter = new StateBackedCloudDaemonAdapter({
      readSessionProjectionForCloud: value.codex.readSessionProjectionForCloud,
      executeRemote: () => Promise.resolve({}),
      paths: value.paths,
      store: value.store,
    });
    try {
      const signal = new AbortController().signal;
      const before = await adapter.listSessions({ limit: 10, signal });
      expect(before.sessions.at(0)?.metadata.archived).toBeUndefined();
      value.store.setSessionArchived(value.sessionId as SessionId, true);
      const archived = await adapter.listSessions({ limit: 10, signal });
      expect(archived.sessions.at(0)?.metadata.archived).toBe(true);
      value.store.setSessionArchived(value.sessionId as SessionId, false);
      const restored = await adapter.listSessions({ limit: 10, signal });
      expect(restored.sessions.at(0)?.metadata.archived).toBeUndefined();
    } finally {
      await adapter.close();
      value.store.close();
    }
  });

  test("publishes an archived cloud head after personal-session detach without reopening provider authority", async () => {
    const value = await fixture();
    const adopted = adoptPersonalCodexSession(value, "detached-cloud-head-thread");
    value.store.detachPersonalSession({ sessionId: adopted.session.id });
    const projectedSessionIds: string[] = [];
    const adapter = new StateBackedCloudDaemonAdapter({
      readSessionProjectionForCloud: (sessionPublicId) => {
        projectedSessionIds.push(sessionPublicId);
        return Promise.reject(new Error("detached provider authority must stay closed"));
      },
      executeRemote: () => Promise.resolve({}),
      paths: value.paths,
      store: value.store,
    });
    try {
      const page = await adapter.listSessions({
        limit: 100,
        signal: new AbortController().signal,
      });
      const detachedHead = page.sessions.find((session) => session.publicId === adopted.session.id);
      expect(detachedHead).toMatchObject({
        publicId: adopted.session.id,
        metadata: { archived: true },
      });
      expect(projectedSessionIds).not.toContain(adopted.session.id);
    } finally {
      await adapter.close();
      value.store.close();
    }
  });
});

/*
 * Device command guards. Every one of them is decided locally, before any
 * effect: the two `oompa remote allow|deny` switches, the requesting device's
 * day bucket, and the account and project the registry projected. Each refusal
 * has its own closed code so the browser can name the operator switch.
 */
async function deviceCommandFixture(options: Readonly<{
  claude?: ClaudeRuntimePort;
  now?: () => number;
}> = {}) {
  const value = await fixture();
  const root = join(value.paths.root, "device-command-project");
  await mkdir(root, { recursive: true });
  const project = await value.store.createProject("Control plane", root, true);
  const account = value.store.listProfiles()[0];
  if (account === undefined) throw new Error("missing account fixture");
  const loginAccount = value.store.createProfile("Link target");
  const executed: LocalCommand[] = [];
  const notices: string[] = [];
  const adapter = new StateBackedCloudDaemonAdapter({
    readSessionProjectionForCloud: value.codex.readSessionProjectionForCloud,
    ...(options.claude === undefined ? {} : {
      readProviderAccountProjectionForCloud: async (input: Parameters<CloudProviderAccountProjectionReader>[0]) => {
        const authority = input.authority;
        const request = {
          authority: {
            codexHome: join(value.paths.root, "private-provider-home"),
            desktopUserData: join(value.paths.root, "private-provider-data"),
            generation: authority.processGeneration,
            id: authority.profileId,
            provider: authority.provider,
            providerAccountId: authority.providerAccountId,
            bindingGeneration: authority.bindingGeneration,
          },
          signal: input.signal,
        };
        if (authority.provider === "claude" && options.claude !== undefined) {
          const projection = await options.claude.readAccount(request);
          return { signedIn: projection.readiness === "signed_in" ? true
            : projection.readiness === "signed_out" ? false : null };
        }
        throw new Error("runtime unavailable");
      },
    }),
    executeLocal: (command) => {
      executed.push(command);
      if (command.kind === "session.start") {
        return Promise.resolve({ session: { id: value.sessionId } });
      }
      if (command.kind === "account.login") {
        return Promise.resolve({
          login: {
            loginId: "login_incomplete",
            status: "pending",
            verificationUrl: "https://auth.openai.com/codex/device",
          },
        });
      }
      return Promise.resolve({});
    },
    executeRemote: () => Promise.resolve({}),
    notifyOperator: (input) => { notices.push(input.title); return Promise.resolve(); },
    now: options.now ?? (() => 1_760_000_000_000),
    paths: value.paths,
    store: value.store,
  });
  const sessionStart = {
    accountPublicId: account.id,
    kind: "session_start" as const,
    preset: "ultra" as const,
    presetContract: 2 as const,
    projectPublicId: project.id,
    prompt: "continue the migration",
    provider: "codex" as const,
  };
  return { account, adapter, executed, loginAccount, notices, project, sessionStart, value };
}

async function observeFixtureRegistry(world: Awaited<ReturnType<typeof deviceCommandFixture>>) {
  const signal = new AbortController().signal;
  // These fake providers settle immediately. Each refresh advances the bounded
  // background discovery cursor; the following read projects that observation.
  const count = world.value.store.listProfiles().length;
  for (let index = 0; index < count; index += 1) {
    await world.adapter.readDeviceRegistry({ signal });
    await new Promise<void>((resolve) => { setImmediate(resolve); });
  }
  return await world.adapter.readDeviceRegistry({ signal });
}

describe("device command execution", () => {
  test("a login-pending profile cannot starve later provider account discovery", async () => {
    const world = await deviceCommandFixture({ claude: new FakeClaude({ observedAt: 1_050, readiness: "signed_in" }) });
    try {
      const [first, second] = world.value.store.listProfiles();
      if (first === undefined || second === undefined) throw new Error("Expected two isolated profiles.");
      const account = world.value.store.requireProviderAccountForProfile(first.id, "claude");
      world.value.store.observeProviderAccountReadiness({
        expectedBindingGeneration: account.bindingGeneration,
        profileId: first.id,
        provider: "claude",
        readiness: "login_pending",
      });
      const registry = await observeFixtureRegistry(world);
      expect(registry.accounts.filter((entry) => entry.provider === "claude").map((entry) => entry.publicId))
        .toEqual([`claude_${second.id}`]);
    } finally {
      await world.adapter.close();
      world.value.store.close();
    }
  });

  test("backwards clock movement invalidates cached auth instead of extending its freshness", async () => {
    let now = 1_760_000_000_000;
    const claude = new FakeClaude({ observedAt: 1_050, readiness: "signed_in" });
    const world = await deviceCommandFixture({ claude, now: () => now });
    try {
      expect((await observeFixtureRegistry(world)).accounts.some((account) => account.provider === "claude")).toBe(true);
      now -= 1;
      const backwards = await world.adapter.readDeviceRegistry({ signal: new AbortController().signal });
      expect(backwards.accounts.some((account) => account.provider === "claude")).toBe(false);
      expect((await observeFixtureRegistry(world)).accounts.some((account) => account.provider === "claude")).toBe(true);
    } finally {
      await world.adapter.close();
      world.value.store.close();
    }
  });

  test("held auth results cannot survive their own binding or process change", async () => {
    for (const change of ["binding", "process"] as const) {
      const claude = new FakeClaude();
      let release: (projection: ClaudeAccountReadinessProjection) => void = () => {};
      let observedAuthority: ProfileAuthority | undefined;
      Object.defineProperty(claude, "readAccount", {
        value: (input: Parameters<ClaudeRuntimePort["readAccount"]>[0]) => {
          observedAuthority = input.authority;
          return new Promise<ClaudeAccountReadinessProjection>((resolve) => {
            release = resolve;
            input.signal.addEventListener("abort", () => resolve({ observedAt: 1_050, readiness: "signed_out" }), { once: true });
          });
        },
      });
      const world = await deviceCommandFixture({ claude });
      try {
        await world.adapter.readDeviceRegistry({ signal: new AbortController().signal });
        const captured = observedAuthority;
        if (captured === undefined) throw new Error("Expected an admitted auth probe.");
        const account = world.value.store.requireProviderAccountForProfile(captured.id, "claude");
        expect(captured).toMatchObject({
          bindingGeneration: account.bindingGeneration,
          generation: account.processGeneration,
          provider: "claude",
          providerAccountId: account.id,
        });
        if (change === "binding") {
          world.value.store.observeProviderAccountReadiness({
            expectedBindingGeneration: account.bindingGeneration,
            profileId: captured.id,
            provider: "claude",
            readiness: "signed_out",
          });
        } else {
          world.value.store.advanceProviderAccountProcessGeneration({
            expectedProcessGeneration: account.processGeneration,
            profileId: captured.id,
            provider: "claude",
          });
        }
        release({ observedAt: 1_050, readiness: "signed_in" });
        await new Promise<void>((resolve) => { setImmediate(resolve); });
        const registry = await world.adapter.readDeviceRegistry({ signal: new AbortController().signal });
        expect(registry.accounts.some((entry) => entry.publicId === `claude_${captured.id}`)).toBe(false);
      } finally {
        release({ observedAt: 1_050, readiness: "signed_out" });
        await world.adapter.close();
        world.value.store.close();
      }
    }
  });

  test("rejects retired starts and login requests without probing or dispatching", async () => {
    const claude = new FakeClaude({ observedAt: 1_050, readiness: "signed_in" });
    const world = await deviceCommandFixture({ claude });
    try {
      world.value.store.setAccountLinkingAllowed(true);
      const accountPublicId = `devin_${world.account.id}`;
      expect(deviceRegistryAccountAddress({ kind: "local", profileId: world.account.id, provider: "devin" })).toBeNull();
      expect(deviceRegistryAccountAddress({ kind: "public", publicId: accountPublicId }))
        .toMatchObject({ profileId: world.account.id, provider: "devin" });
      const stalePayloads: unknown[] = [
        { ...world.sessionStart, accountPublicId, provider: "devin", preset: "astra" },
        { accountPublicId, kind: "account_login_start", handoffVersion: 2 },
        { accountPublicId, kind: "account_login_status" },
      ];
      for (const payload of stalePayloads) {
        expect(await world.adapter.executeDeviceCommand({
          idempotencyKey: "018bcfe5-6800-7000-8000-000000000113",
          payload: payload as Parameters<StateBackedCloudDaemonAdapter["executeDeviceCommand"]>[0]["payload"],
          requestingDevicePublicId: "device_browser1",
          signal: new AbortController().signal,
        })).toEqual({ code: "DEVICE_COMMAND_PROVIDER_UNSUPPORTED", state: "failed" });
      }
      expect(world.executed).toEqual([]);
      expect(world.notices).toEqual([]);
      expect(claude.readAccountCalls).toBe(0);
      expect((await observeFixtureRegistry(world)).accounts.some((account) => account.provider === "devin")).toBe(false);
    } finally {
      await world.adapter.close();
      world.value.store.close();
    }
  });

  test("expires optional auth observations and invalidates their own authority without borrowing Codex generation", async () => {
    let now = 1_760_000_000_000;
    const claude = new FakeClaude({ observedAt: 1_050, readiness: "signed_in" });
    const world = await deviceCommandFixture({ claude, now: () => now });
    try {
      expect((await observeFixtureRegistry(world)).accounts.filter((account) => account.provider === "claude"))
        .toHaveLength(2);
      world.value.store.removeProfile(world.loginAccount.id);
      world.value.store.nextProfileGeneration(world.account.id);
      const changed = await world.adapter.readDeviceRegistry({ signal: new AbortController().signal });
      expect(changed.accounts.some((account) => account.publicId.endsWith(world.loginAccount.id)))
        .toBe(false);
      expect(changed.accounts.some((account) => account.provider === "claude")).toBe(true);
      const claudeAccount = world.value.store.requireProviderAccountForProfile(world.account.id, "claude");
      world.value.store.advanceProviderAccountProcessGeneration({
        expectedProcessGeneration: claudeAccount.processGeneration,
        profileId: world.account.id,
        provider: "claude",
      });
      const ownChanged = await world.adapter.readDeviceRegistry({ signal: new AbortController().signal });
      expect(ownChanged.accounts.some((account) => account.provider === "claude")).toBe(false);
      expect((await observeFixtureRegistry(world)).accounts.some((account) => account.provider === "claude"))
        .toBe(true);
      now += 60_001;
      const expired = await world.adapter.readDeviceRegistry({ signal: new AbortController().signal });
      expect(expired.accounts.some((account) => account.provider === "claude")).toBe(false);
    } finally {
      await world.adapter.close();
      world.value.store.close();
    }
  });

  test("provider discovery rotates through later profiles and backs off failed probes", async () => {
    let now = 1_760_000_000_000;
    const claude = new FakeClaude(new Error("runtime unavailable"));
    const observedProfiles: string[] = [];
    Object.defineProperty(claude, "readAccount", {
      value: (input: Parameters<ClaudeRuntimePort["readAccount"]>[0]) => {
        observedProfiles.push(input.authority.id);
        return Promise.reject(new Error("runtime unavailable"));
      },
    });
    const world = await deviceCommandFixture({ claude, now: () => now });
    world.value.store.createProfile("Third provider profile");
    try {
      for (let index = 0; index < 3; index += 1) {
        await world.adapter.readDeviceRegistry({ signal: new AbortController().signal });
        await new Promise<void>((resolve) => { setImmediate(resolve); });
        now += 60_001;
      }
      expect(new Set(observedProfiles).size).toBe(3);
      await observeFixtureRegistry(world);
      const count = observedProfiles.length;
      await observeFixtureRegistry(world);
      expect(observedProfiles).toHaveLength(count);
    } finally {
      await world.adapter.close();
      world.value.store.close();
    }
  });

  test("joins canceled background auth cleanup and shares the close outcome", async () => {
    const claude = new FakeClaude();
    let releaseJoin!: () => void;
    const joined = new Promise<void>((resolve) => { releaseJoin = resolve; });
    let probeSignal: AbortSignal | undefined;
    Object.defineProperty(claude, "readAccount", {
      value: async (input: Parameters<ClaudeRuntimePort["readAccount"]>[0]) => {
        probeSignal = input.signal;
        await new Promise<void>((resolve) => {
          input.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        await joined;
        throw new Error("Provider observation canceled after cleanup");
      },
    });
    const world = await deviceCommandFixture({ claude });
    try {
      await world.adapter.readDeviceRegistry({ signal: new AbortController().signal });
      const closing = world.adapter.close();
      expect(probeSignal?.aborted).toBe(true);
      expect(world.adapter.close()).toBe(closing);
      let settled = false;
      void closing.then(() => { settled = true; });
      await new Promise<void>((resolve) => { setImmediate(resolve); });
      expect(settled).toBe(false);
      releaseJoin();
      await closing;
      expect(settled).toBe(true);
    } finally {
      releaseJoin();
      await world.adapter.close();
      world.value.store.close();
    }
  });

  test("fences future observations and fails close when provider child cleanup is unproven", async () => {
    const cleanupFailure = new Error("Claude authentication output could not be drained");
    const claude = new FakeClaude(new Error("runtime admission failed", { cause: cleanupFailure }));
    const world = await deviceCommandFixture({ claude });
    try {
      await observeFixtureRegistry(world);
      await observeFixtureRegistry(world);
      expect(claude.readAccountCalls).toBe(1);
      await expect(world.adapter.close()).rejects.toThrow("cleanup could not be proven");
    } finally {
      await world.adapter.close().catch(() => undefined);
      world.value.store.close();
    }
  });

  test("a held Claude auth probe cannot block registry, Codex, or settings commands", async () => {
    const claude = new FakeClaude();
    const probeSignals: AbortSignal[] = [];
    Object.defineProperty(claude, "readAccount", {
      value: (input: Parameters<ClaudeRuntimePort["readAccount"]>[0]) => {
        claude.readAccountCalls += 1;
        probeSignals.push(input.signal);
        return new Promise<ClaudeAccountReadinessProjection>((_resolve, reject) => {
          input.signal.addEventListener("abort", () => reject(input.signal.reason), { once: true });
        });
      },
    });
    const world = await deviceCommandFixture({ claude });
    const controller = new AbortController();
    const promptly = async <T>(promise: Promise<T>): Promise<T | "blocked"> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          promise,
          new Promise<"blocked">((resolve) => {
            timer = setTimeout(() => resolve("blocked"), 100);
          }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    };
    const registry = world.adapter.readDeviceRegistry({ signal: controller.signal });
    try {
      expect(await promptly(registry)).not.toBe("blocked");
      for (let index = 0; index < 3; index += 1) {
        const projection = await world.adapter.readDeviceRegistry({ signal: controller.signal });
        expect(projection.accounts.some((account) => account.provider === "claude")).toBe(false);
      }
      expect(claude.readAccountCalls).toBe(1);
      expect(await promptly(world.adapter.executeDeviceCommand({
        idempotencyKey: "018bcfe5-6800-7000-8000-000000000111",
        payload: world.sessionStart,
        requestingDevicePublicId: "device_browser1",
        signal: controller.signal,
      }))).toMatchObject({ code: "APPLIED", state: "applied" });
      expect(await promptly(world.adapter.executeDeviceCommand({
        idempotencyKey: "018bcfe5-6800-7000-8000-000000000112",
        payload: {
          endMinute: 1_320,
          expectedRevision: world.value.store.readNotificationHours().revision,
          kind: "set_notification_hours",
          startMinute: 600,
          timeZone: "America/Puerto_Rico",
          version: 1,
        },
        requestingDevicePublicId: "device_browser1",
        signal: controller.signal,
      }))).toEqual({ code: "APPLIED", state: "applied" });
      expect(claude.readAccountCalls).toBe(1);
      controller.abort(new Error("registry caller canceled"));
      expect(probeSignals.every((signal) => signal.aborted)).toBe(true);
      await world.adapter.close();
      expect(probeSignals.every((signal) => signal.aborted)).toBe(true);
    } finally {
      controller.abort(new Error("test cleanup"));
      await registry.catch(() => undefined);
      await world.adapter.close();
      world.value.store.close();
    }
  });

  test("derives reversible provider-qualified account ids without cross-provider collisions", async () => {
    const world = await deviceCommandFixture({
      claude: new FakeClaude({ observedAt: 1_050, readiness: "signed_in" }),
    });
    try {
      const addresses = (["codex", "claude"] as const).map((provider) =>
        deviceRegistryAccountAddress({
          kind: "local",
          profileId: world.account.id,
          provider,
        }));
      expect(addresses.every((address) => address !== null)).toBe(true);
      expect(new Set(addresses.map((address) => address?.publicId)).size).toBe(2);
      expect(addresses.map((address) => address?.publicId)).toEqual([
        world.account.id,
        `claude_${world.account.id}`,
      ]);
      for (const address of addresses) {
        if (address === null) throw new Error("expected account address");
        expect(deviceRegistryAccountAddress({ kind: "public", publicId: address.publicId }))
          .toEqual(address);
      }
      expect(deviceRegistryAccountAddress({
        kind: "public",
        publicId: `codex_${world.account.id}`,
      })).toBeNull();
      expect(deviceRegistryAccountAddress({
        kind: "public",
        publicId: "claude_".padEnd(97, "a"),
      })).toBeNull();

      const registry = await observeFixtureRegistry(world);
      expect(new Set(registry.accounts.map((account) => account.publicId)).size)
        .toBe(registry.accounts.length);
      for (const provider of ["claude"] as const) {
        const localId = world.value.store.requireProviderAccountForProfile(world.account.id, provider).id;
        expect(JSON.stringify(registry)).not.toContain(localId);
        expect(deviceRegistryAccountAddress({ kind: "public", publicId: localId })).toBeNull();
      }
      expect(registry.accounts
        .filter((account) => account.publicId.endsWith(world.account.id))
        .map((account) => [account.provider, account.status]))
        .toEqual([
          ["codex", "signed_in"],
          ["claude", "signed_in"],
        ]);
    } finally {
      await world.adapter.close();
      world.value.store.close();
    }
  });

  test("caps the registry only at complete provider-qualified profile groups", async () => {
    const world = await deviceCommandFixture({
      claude: new FakeClaude({ observedAt: 1_050, readiness: "signed_in" }),
    });
    try {
      for (let index = 0; index < 49; index += 1) {
        world.value.store.createProfile(`Provider group ${index.toString().padStart(2, "0")}`);
      }
      const registry = await observeFixtureRegistry(world);
      expect(registry.accounts).toHaveLength(100);
      const providersByProfile = new Map<string, string[]>();
      for (const account of registry.accounts) {
        const address = deviceRegistryAccountAddress({
          kind: "public",
          publicId: account.publicId,
        });
        if (address === null) throw new Error("expected bounded registry account address");
        const providers = providersByProfile.get(address.profileId) ?? [];
        providers.push(address.provider);
        providersByProfile.set(address.profileId, providers);
      }
      expect(providersByProfile.size).toBe(50);
      for (const providers of providersByProfile.values()) {
        expect(providers).toEqual(["codex", "claude"]);
      }
    } finally {
      await world.adapter.close();
      world.value.store.close();
    }
  });

  test("discovers a signed-in Claude account and translates its public id before local start", async () => {
    const claude = new FakeClaude({ observedAt: 1_050, readiness: "signed_in" });
    const world = await deviceCommandFixture({ claude });
    try {
      const signal = new AbortController().signal;
      const registry = await observeFixtureRegistry(world);
      const account = registry.accounts.find((entry) =>
        entry.provider === "claude" && entry.publicId.endsWith(world.account.id));
      expect(account).toEqual({
        label: "Personal `[local-path]`",
        provider: "claude",
        publicId: `claude_${world.account.id}`,
        status: "signed_in",
      });
      if (account === undefined) throw new Error("expected Claude registry account");

      const outcome = await world.adapter.executeDeviceCommand({
        idempotencyKey: "018bcfe5-6800-7000-8000-000000000101",
        payload: {
          accountPublicId: account.publicId,
          kind: world.sessionStart.kind,
          preset: "fable-max",
          projectPublicId: world.sessionStart.projectPublicId,
          prompt: world.sessionStart.prompt,
          provider: "claude",
        },
        requestingDevicePublicId: "device_browser1",
        signal,
      });
      expect(outcome).toMatchObject({ code: "APPLIED", state: "applied" });
      expect(world.executed[0]).toMatchObject({
        account: world.account.id,
        kind: "session.start",
        preset: "fable-max",
        provider: "claude",
      });
      expect(world.executed[0]).not.toHaveProperty("presetContract");
      expect(claude.readAccountCalls).toBe(2);
    } finally {
      await world.adapter.close();
      world.value.store.close();
    }
  });

  test("publishes known signed-out Claude state and refuses it before local execution", async () => {
    const world = await deviceCommandFixture({ claude: new FakeClaude({ observedAt: 1_050, readiness: "signed_out" }) });
    try {
      const signal = new AbortController().signal;
      const address = deviceRegistryAccountAddress({
        kind: "local",
        profileId: world.account.id,
        provider: "claude",
      });
      if (address === null) throw new Error("expected Claude account address");
      expect((await observeFixtureRegistry(world)).accounts.some((account) =>
        account.provider === "claude"
        && account.publicId === address.publicId
        && account.status === "signed_out"))
        .toBe(true);
      expect(await world.adapter.executeDeviceCommand({
        idempotencyKey: "018bcfe5-6800-7000-8000-000000000102",
        payload: {
          accountPublicId: address.publicId,
          kind: world.sessionStart.kind,
          preset: "fable-max",
          projectPublicId: world.sessionStart.projectPublicId,
          prompt: world.sessionStart.prompt,
          provider: "claude",
        },
        requestingDevicePublicId: "device_browser1",
        signal,
      })).toEqual({ code: "DEVICE_COMMAND_ACCOUNT_SIGNED_OUT", state: "failed" });
      expect(world.executed).toEqual([]);
    } finally {
      await world.adapter.close();
      world.value.store.close();
    }
  });

  test("refuses a provider mismatch against the provider-qualified account row", async () => {
    const world = await deviceCommandFixture({ claude: new FakeClaude({ observedAt: 1_050, readiness: "signed_in" }) });
    try {
      const address = deviceRegistryAccountAddress({
        kind: "local",
        profileId: world.account.id,
        provider: "claude",
      });
      if (address === null) throw new Error("expected Claude account address");
      expect(await world.adapter.executeDeviceCommand({
        idempotencyKey: "018bcfe5-6800-7000-8000-000000000103",
        payload: { ...world.sessionStart, accountPublicId: address.publicId },
        requestingDevicePublicId: "device_browser1",
        signal: new AbortController().signal,
      })).toEqual({ code: "DEVICE_COMMAND_PROVIDER_UNSUPPORTED", state: "failed" });
      expect(world.executed).toEqual([]);
    } finally {
      await world.adapter.close();
      world.value.store.close();
    }
  });

  test("omits a Claude row when its runtime cannot prove authentication", async () => {
    const claude = new FakeClaude(new Error("runtime unavailable"));
    const world = await deviceCommandFixture({ claude });
    try {
      const registry = await world.adapter.readDeviceRegistry({
        signal: new AbortController().signal,
      });
      expect(registry.accounts.some((account) => account.provider === "claude")).toBe(false);
      expect(registry.accounts.some((account) =>
        account.provider === "codex"
        && account.publicId === world.account.id
        && account.status === "signed_in"))
        .toBe(true);
      expect(claude.readAccountCalls).toBe(1);
    } finally {
      await world.adapter.close();
      world.value.store.close();
    }
  });

  test("keeps Codex login on raw profile ids and refuses provider-qualified ids", async () => {
    const world = await deviceCommandFixture({ claude: new FakeClaude({ observedAt: 1_050, readiness: "signed_in" }) });
    try {
      world.value.store.setAccountLinkingAllowed(true);
      const signal = new AbortController().signal;
      expect(await world.adapter.executeDeviceCommand({
        idempotencyKey: "018bcfe5-6800-7000-8000-000000000104",
        payload: {
          accountPublicId: world.loginAccount.id,
          kind: "account_login_status",
        },
        requestingDevicePublicId: "device_browser1",
        signal,
      })).toMatchObject({
        code: "APPLIED",
        result: { kind: "account_login_status", status: "idle" },
        state: "applied",
      });

      const claudeAddress = deviceRegistryAccountAddress({
        kind: "local",
        profileId: world.loginAccount.id,
        provider: "claude",
      });
      if (claudeAddress === null) throw new Error("expected Claude account address");
      expect(await world.adapter.executeDeviceCommand({
        idempotencyKey: "018bcfe5-6800-7000-8000-000000000105",
        payload: {
          accountPublicId: claudeAddress.publicId,
          kind: "account_login_status",
        },
        requestingDevicePublicId: "device_browser1",
        signal,
      })).toEqual({ code: "DEVICE_COMMAND_PROVIDER_UNSUPPORTED", state: "failed" });
      expect(await world.adapter.executeDeviceCommand({
        idempotencyKey: "018bcfe5-6800-7000-8000-000000000106",
        payload: {
          accountPublicId: world.loginAccount.id,
          handoffVersion: 2,
          kind: "account_login_start",
        },
        requestingDevicePublicId: "device_browser1",
        signal,
      })).toEqual({ code: "ACCOUNT_LOGIN_RELAY_UNAVAILABLE", state: "failed" });
      expect(world.executed).toHaveLength(1);
      expect(world.executed[0]).toMatchObject({
        account: world.loginAccount.id,
        deviceCode: true,
        kind: "account.login",
      });
    } finally {
      await world.adapter.close();
      world.value.store.close();
    }
  });

  test("starts a session then sends its prompt, inheriting the project approval mode", async () => {
    const world = await deviceCommandFixture();
    try {
      world.value.store.setDefaultApprovalMode("manual");
      world.value.store.setProjectApprovalMode(world.project.id, "auto:workspace");
      const outcome = await world.adapter.executeDeviceCommand({
        idempotencyKey: "018bcfe5-6800-7000-8000-000000000001",
        payload: world.sessionStart,
        requestingDevicePublicId: "device_browser1",
        signal: new AbortController().signal,
      });
      expect(outcome).toMatchObject({
        code: "APPLIED",
        result: { kind: "session_start", sessionPublicId: world.value.sessionId },
        state: "applied",
      });
      expect(world.executed.map((command) => command.kind))
        .toEqual(["session.start", "session.send"]);
      expect(world.executed[0]).toMatchObject({
        account: world.account.id,
        kind: "session.start",
        provider: "codex",
        preset: "ultra",
        presetContract: 2,
      });
      // One device command, two local effects, two distinct derived keys.
      const keys = world.executed.map((command) =>
        (command as { idempotencyKey?: string }).idempotencyKey);
      expect(new Set(keys).size).toBe(2);
      expect(world.value.store.readSessionApprovalMode(world.value.sessionId as SessionId))
        .toEqual({ mode: "auto:workspace", source: "session" });
      // The desktop notice fires on the first session start from this device.
      expect(world.notices).toEqual(["Oompa: new device started a session"]);
    } finally {
      await world.adapter.close();
      world.value.store.close();
    }
  });

  test("quarantines a send that may or may not have reached the started session", async () => {
    const value = await fixture();
    const root = join(value.paths.root, "ambiguous-project");
    await mkdir(root, { recursive: true });
    const project = await value.store.createProject("Ambiguous", root, true);
    const account = value.store.listProfiles()[0];
    if (account === undefined) throw new Error("missing account fixture");
    const adapter = new StateBackedCloudDaemonAdapter({
      readSessionProjectionForCloud: value.codex.readSessionProjectionForCloud,
      executeLocal: (command) => command.kind === "session.start"
        ? Promise.resolve({ session: { id: value.sessionId } })
        : Promise.reject(new Error("the provider connection dropped")),
      executeRemote: () => Promise.resolve({}),
      notifyOperator: () => Promise.resolve(),
      paths: value.paths,
      store: value.store,
    });
    try {
      const outcome = await adapter.executeDeviceCommand({
        idempotencyKey: "018bcfe5-6800-7000-8000-000000000002",
        payload: {
          accountPublicId: account.id,
          kind: "session_start",
          preset: "ultra",
          presetContract: 2,
          projectPublicId: project.id,
          prompt: "continue",
          provider: "codex",
        },
        requestingDevicePublicId: "device_browser1",
        signal: new AbortController().signal,
      });
      // The session exists, so this is never a clean failure and never carries
      // a session id a client could treat as a completed start.
      expect(outcome).toEqual({ code: "LOCAL_SESSION_SEND_INDETERMINATE", state: "ambiguous" });
      expect(outcome.result).toBeUndefined();
    } finally {
      await adapter.close();
      value.store.close();
    }
  });

  test("the kill switch refuses every device command without probing provider authentication", async () => {
    const claude = new FakeClaude({ observedAt: 1_050, readiness: "signed_in" });
    const world = await deviceCommandFixture({ claude });
    try {
      world.value.store.setDeviceCommandsAllowed(false);
      const signal = new AbortController().signal;
      for (const payload of [
        world.sessionStart,
        { kind: "usage_refresh" as const },
        { kind: "account_login_status" as const },
      ]) {
        expect(await world.adapter.executeDeviceCommand({
          idempotencyKey: "018bcfe5-6800-7000-8000-000000000003",
          payload,
          requestingDevicePublicId: "device_browser1",
          signal,
        })).toEqual({ code: "DEVICE_COMMANDS_DENIED", state: "failed" });
      }
      expect(world.executed).toEqual([]);
      expect(world.notices).toEqual([]);
      expect(claude.readAccountCalls).toBe(0);
    } finally {
      await world.adapter.close();
      world.value.store.close();
    }
  });

  test("updates notification hours by its own revision without a provider call", async () => {
    const world = await deviceCommandFixture();
    try {
      const before = world.value.store.readNotificationHours();
      expect(await world.adapter.executeDeviceCommand({
        idempotencyKey: "018bcfe5-6800-7000-8000-0000000000aa",
        payload: {
          endMinute: 1_320,
          expectedRevision: before.revision,
          kind: "set_notification_hours",
          startMinute: 600,
          timeZone: "America/Puerto_Rico",
          version: 1,
        },
        requestingDevicePublicId: "device_browser1",
        signal: new AbortController().signal,
      })).toEqual({ code: "APPLIED", state: "applied" });
      expect(world.value.store.readNotificationHours()).toMatchObject({
        endMinute: 1_320,
        revision: before.revision + 1,
        startMinute: 600,
      });
      expect(world.executed).toEqual([]);
      expect(await world.adapter.executeDeviceCommand({
        idempotencyKey: "018bcfe5-6800-7000-8000-0000000000ab",
        payload: {
          endMinute: 1_320,
          expectedRevision: before.revision,
          kind: "set_notification_hours",
          startMinute: 600,
          timeZone: "America/Puerto_Rico",
          version: 1,
        },
        requestingDevicePublicId: "device_browser1",
        signal: new AbortController().signal,
      })).toEqual({ code: "LOCAL_NOTIFICATION_HOURS_REVISION_CONFLICT", state: "failed" });
      const authority = new Database(world.value.paths.database, { create: false, strict: true });
      authority.exec(`
        DROP TRIGGER notification_hours_update_guard;
        DROP TRIGGER attention_email_policy_update_guard;
        UPDATE notification_hours SET revision=9007199254740991 WHERE singleton=1;
        UPDATE attention_email_policy SET revision=9007199254740991 WHERE singleton=1;
      `);
      authority.close(false);
      expect(await world.adapter.executeDeviceCommand({
        idempotencyKey: "018bcfe5-6800-7000-8000-0000000000ac",
        payload: {
          endMinute: 1_320,
          expectedRevision: Number.MAX_SAFE_INTEGER,
          kind: "set_notification_hours",
          startMinute: 600,
          timeZone: "America/Puerto_Rico",
          version: 1,
        },
        requestingDevicePublicId: "device_browser1",
        signal: new AbortController().signal,
      })).toEqual({ code: "LOCAL_NOTIFICATION_HOURS_REVISION_EXHAUSTED", state: "failed" });
    } finally {
      await world.adapter.close();
      world.value.store.close();
    }
  });

  test("account linking needs the local opt-in and a complete device-code handoff", async () => {
    const world = await deviceCommandFixture();
    try {
      const signal = new AbortController().signal;
      const payload = {
        accountPublicId: world.loginAccount.id,
        handoffVersion: 2 as const,
        kind: "account_login_start" as const,
      };
      expect(await world.adapter.executeDeviceCommand({
        idempotencyKey: "018bcfe5-6800-7000-8000-000000000004",
        payload,
        requestingDevicePublicId: "device_browser1",
        signal,
      })).toEqual({ code: "ACCOUNT_LINKING_DENIED", state: "failed" });

      world.value.store.setAccountLinkingAllowed(true);
      // A verification URL without the separate one-time user code is not a
      // usable Codex device-code handoff, so the command fails closed.
      expect(await world.adapter.executeDeviceCommand({
        idempotencyKey: "018bcfe5-6800-7000-8000-000000000005",
        payload,
        requestingDevicePublicId: "device_browser1",
        signal,
      })).toEqual({ code: "ACCOUNT_LOGIN_RELAY_UNAVAILABLE", state: "failed" });
      expect(world.executed).toHaveLength(1);
      expect(world.executed[0]).toMatchObject({
        account: world.loginAccount.id,
        deviceCode: true,
        kind: "account.login",
      });
    } finally {
      await world.adapter.close();
      world.value.store.close();
    }
  });

  test("relays the complete single-use device-code handoff when the machine has opted in", async () => {
    const value = await fixture();
    const account = value.store.createProfile("Relay target");
    value.store.setAccountLinkingAllowed(true);
    const executed: LocalCommand[] = [];
    const adapter = new StateBackedCloudDaemonAdapter({
      readSessionProjectionForCloud: value.codex.readSessionProjectionForCloud,
      executeLocal: (command) => {
        executed.push(command);
        return Promise.resolve({
          login: {
            loginId: "login_1",
            status: "pending",
            userCode: "ABCD-EFGH",
            verificationUrl: "https://auth.openai.com/codex/device",
          },
        });
      },
      executeRemote: () => Promise.resolve({}),
      now: () => 1_760_000_000_000,
      paths: value.paths,
      store: value.store,
    });
    try {
      const outcome = await adapter.executeDeviceCommand({
        idempotencyKey: "018bcfe5-6800-7000-8000-000000000006",
        payload: {
          accountPublicId: account.id,
          handoffVersion: 2,
          kind: "account_login_start",
        },
        requestingDevicePublicId: "device_browser1",
        signal: new AbortController().signal,
      });
      expect(outcome).toMatchObject({ code: "APPLIED", singleUseResult: true, state: "applied" });
      expect(outcome.result).toEqual({
        expiresAt: 1_760_000_000_000 + 5 * 60 * 1_000,
        handoffVersion: 2,
        kind: "account_login_start",
        loginUrl: "https://auth.openai.com/codex/device",
        userCode: "ABCD-EFGH",
      });
      expect(executed[0]).toMatchObject({
        account: account.id,
        deviceCode: true,
        kind: "account.login",
      });
    } finally {
      await adapter.close();
      value.store.close();
    }
  });

  test("refuses a legacy URL-only requester before starting a browser login", async () => {
    const world = await deviceCommandFixture();
    try {
      world.value.store.setAccountLinkingAllowed(true);
      const outcome = await world.adapter.executeDeviceCommand({
        idempotencyKey: "018bcfe5-6800-7000-8000-000000000008",
        payload: { accountPublicId: world.loginAccount.id, kind: "account_login_start" },
        requestingDevicePublicId: "device_browser1",
        signal: new AbortController().signal,
      });
      expect(outcome).toEqual({ code: "ACCOUNT_LOGIN_RELAY_UNAVAILABLE", state: "failed" });
      expect(world.executed).toEqual([]);
    } finally {
      await world.adapter.close();
      world.value.store.close();
    }
  });

  test("refuses to relink a signed-in account before executing a local command", async () => {
    const world = await deviceCommandFixture();
    try {
      world.value.store.setAccountLinkingAllowed(true);
      expect(await world.adapter.executeDeviceCommand({
        idempotencyKey: "018bcfe5-6800-7000-8000-00000000000e",
        payload: {
          accountPublicId: world.account.id,
          handoffVersion: 2,
          kind: "account_login_start",
        },
        requestingDevicePublicId: "device_browser1",
        signal: new AbortController().signal,
      })).toEqual({ code: "ACCOUNT_LOGIN_NOT_AVAILABLE", state: "failed" });
      expect(world.executed).toEqual([]);
    } finally {
      await world.adapter.close();
      world.value.store.close();
    }
  });

  test("reports login status for the addressed account without leaking a sibling", async () => {
    const world = await deviceCommandFixture();
    try {
      world.value.store.setAccountLinkingAllowed(true);
      const sibling = world.value.store.createProfile("Sibling");
      expect(world.value.store.setProfileState(
        sibling.id,
        sibling.processGeneration,
        "login_pending",
      )).toBe(true);
      const outcome = await world.adapter.executeDeviceCommand({
        idempotencyKey: "018bcfe5-6800-7000-8000-000000000007",
        payload: {
          accountPublicId: world.account.id,
          kind: "account_login_status",
        },
        requestingDevicePublicId: "device_browser1",
        signal: new AbortController().signal,
      });
      expect(outcome).toMatchObject({ code: "APPLIED", state: "applied" });
      expect(outcome.result).toEqual({
        instruction: "This account is signed in on this machine.",
        kind: "account_login_status",
        status: "signed_in",
      });
      const siblingStatus = await world.adapter.executeDeviceCommand({
        idempotencyKey: "018bcfe5-6800-7000-8000-00000000000d",
        payload: {
          accountPublicId: sibling.id,
          kind: "account_login_status",
        },
        requestingDevicePublicId: "device_browser1",
        signal: new AbortController().signal,
      });
      expect(siblingStatus.result).toEqual({
        instruction: `A login is in progress for this account. Finish its existing browser or device-code handoff, or cancel it with \`oompa account login-cancel ${sibling.id}\`.`,
        kind: "account_login_status",
        status: "pending",
      });
      const legacy = await world.adapter.executeDeviceCommand({
        idempotencyKey: "018bcfe5-6800-7000-8000-00000000000c",
        payload: { kind: "account_login_status" },
        requestingDevicePublicId: "device_browser1",
        signal: new AbortController().signal,
      });
      expect(legacy.result).toMatchObject({
        kind: "account_login_status",
        status: "pending",
      });
      expect(world.executed).toEqual([]);
    } finally {
      await world.adapter.close();
      world.value.store.close();
    }
  });

  test("refuses addressing the registry does not carry", async () => {
    const world = await deviceCommandFixture();
    try {
      const signal = new AbortController().signal;
      expect(await world.adapter.executeDeviceCommand({
        idempotencyKey: "018bcfe5-6800-7000-8000-000000000008",
        payload: { ...world.sessionStart, accountPublicId: "acct_missing0001" },
        requestingDevicePublicId: "device_browser1",
        signal,
      })).toEqual({ code: "DEVICE_COMMAND_ACCOUNT_UNKNOWN", state: "failed" });
      expect(await world.adapter.executeDeviceCommand({
        idempotencyKey: "018bcfe5-6800-7000-8000-000000000009",
        payload: { ...world.sessionStart, projectPublicId: "proj_missing0001" },
        requestingDevicePublicId: "device_browser1",
        signal,
      })).toEqual({ code: "DEVICE_COMMAND_PROJECT_UNKNOWN", state: "failed" });
      expect(world.executed).toEqual([]);
    } finally {
      await world.adapter.close();
      world.value.store.close();
    }
  });

  test("caps a device at its daily budget and refreshes usage for signed-in accounts", async () => {
    const world = await deviceCommandFixture();
    try {
      const signal = new AbortController().signal;
      expect(await world.adapter.executeDeviceCommand({
        idempotencyKey: "018bcfe5-6800-7000-8000-00000000000a",
        payload: { kind: "usage_refresh" },
        requestingDevicePublicId: "device_browser1",
        signal,
      })).toMatchObject({ code: "APPLIED", result: { accountsRefreshed: 1 }, state: "applied" });

      world.value.store.recordDeviceCommandAdmission({
        dayCount: 100,
        dayKey: Math.floor(1_760_000_000_000 / (24 * 60 * 60 * 1_000)),
        devicePublicId: "device_browser1",
        notifiedFirstSessionStart: false,
      });
      expect(await world.adapter.executeDeviceCommand({
        idempotencyKey: "018bcfe5-6800-7000-8000-00000000000b",
        payload: { kind: "usage_refresh" },
        requestingDevicePublicId: "device_browser1",
        signal,
      })).toEqual({ code: "DEVICE_COMMAND_DAILY_CAP", state: "failed" });
      // A second device has its own budget.
      expect(await world.adapter.executeDeviceCommand({
        idempotencyKey: "018bcfe5-6800-7000-8000-00000000000c",
        payload: { kind: "usage_refresh" },
        requestingDevicePublicId: "device_browser2",
        signal,
      })).toMatchObject({ state: "applied" });
    } finally {
      await world.adapter.close();
      world.value.store.close();
    }
  });

  test("projects the two switches into the device registry", async () => {
    const world = await deviceCommandFixture();
    try {
      const signal = new AbortController().signal;
      const before = await world.adapter.readDeviceRegistry({ signal });
      expect(parseDeviceRegistryPayload(before)).toMatchObject({
        accountLinkingAllowed: false,
        deviceCommandsAllowed: true,
      });
      world.value.store.setDeviceCommandsAllowed(false);
      world.value.store.setAccountLinkingAllowed(true);
      expect(await world.adapter.readDeviceRegistry({ signal })).toMatchObject({
        accountLinkingAllowed: true,
        deviceCommandsAllowed: false,
      });
    } finally {
      await world.adapter.close();
      world.value.store.close();
    }
  });
});
