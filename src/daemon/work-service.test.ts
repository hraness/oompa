import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { IndeterminateCodexEffectError } from "../codex";
import { currentPresetContract } from "../domain/presets";
import type { EffectiveRuntimeProfile } from "../domain/runtime-profile";
import {
  WORK_APPLY_REQUEST_VERSION,
  workEventPageSchema,
  workOperationResultSchema,
  workPollSchema,
  workPreparedEffectSchema,
  workSnapshotSchema,
  workTaskDetailSchema,
  workTaskHistoryPageSchema,
  type WorkOperation,
  type WorkPreparedEffect,
  type WorkTaskSpec,
} from "../domain/work";
import { describeWorkProtocol } from "../domain/work-protocol";
import { workPreparedEffectMessage } from "../domain/work-message";
import {
  createSessionId,
  type ProfileId,
  type ProjectId,
  type SessionId,
} from "../domain/values";
import { initializeStatePaths, profilePaths, resolveStatePaths } from "../storage/paths";
import { WorkCapabilityCodec } from "../storage/work-capability";
import { StateStore } from "../storage/state-store";
import { canonicalWorkJson, type WorkStore } from "../storage/work-store";
import type {
  CloudControlPort,
  CodexAccountProjection,
  CodexLoginOutcome,
  CodexRuntimePort,
  CodexSessionObservation,
  CodexSessionProjection,
  ProfileAuthority,
  RuntimeStartReview,
} from "./ports";
import { SessionEventCursorCodec } from "./session-event-cursor";
import { CommandFailure, OompaService } from "./service";
import { provisionMigratedStateTemplate } from "../../scripts/fixtures/migrated-state-template";

const signal = new AbortController().signal;

const effectiveRuntimeProfile = (
  authority: ProfileAuthority,
  preset: "low" | "high" | "ultra" = "high",
  fast = false,
): EffectiveRuntimeProfile => ({
  profileId: authority.id,
  processGeneration: authority.generation,
  observedAt: 10_000,
  preset,
  model: preset === "low" ? "gpt-5.6-luna" : "gpt-6-astra",
  reasoningEffort: preset === "ultra" ? "ultra" : "max",
  serviceTier: fast ? "priority" : null,
  fast,
  approvalPolicy: "on-request",
  reviewMode: "auto_review",
  permissionProfile: ":workspace",
  computerUse: true,
  pluginCapability: true,
  enabledApps: [],
});

class WorkRuntime implements CodexRuntimePort {
  readonly provider = "codex" as const;
  discardRuntimeReview(): void {}
  beforeReviewSessionReturn?: () => Promise<void>;
  beforeStartSessionReturn?: () => Promise<void>;
  startSessionCount = 0;
  endSessionCount = 0;
  logoutCalls = 0;
  readonly startTurnCalls: Array<Readonly<{
    clientMessageId: string;
    effectiveRuntimeProfile: EffectiveRuntimeProfile;
    message: string;
    providerThreadId: string;
  }>> = [];
  readonly steerCalls: Array<Readonly<{
    activeTurnId: string;
    clientMessageId: string;
    message: string;
    providerThreadId: string;
  }>> = [];
  readonly #projections = new Map<string, CodexSessionProjection>();
  nextReviewTurnStartError?: Error;
  nextStartTurnError?: Error;
  #threadSequence = 0;

  async login(): Promise<CodexLoginOutcome> {
    return {
      status: "signed_in",
      account: { signedIn: true, email: "work-agent@example.com", plan: "Plus" },
    };
  }

  async readAccount(): Promise<CodexAccountProjection> {
    return { signedIn: true, email: "work-agent@example.com", plan: "Plus" };
  }

  async releaseOwnedAuthority(): Promise<void> {}

  async reviewSessionStart(
    input: Parameters<CodexRuntimePort["reviewSessionStart"]>[0],
  ): Promise<RuntimeStartReview> {
    await this.beforeReviewSessionReturn?.();
    return {
      reviewId: `session-review-${String(this.#threadSequence + 1)}`,
      kind: "session_start",
      effectiveRuntimeProfile: effectiveRuntimeProfile(
        input.authority,
        input.preset === "low" || input.preset === "ultra" ? input.preset : "high",
        input.fast,
      ),
    };
  }

  async startSession(
    input: Parameters<CodexRuntimePort["startSession"]>[0],
  ): Promise<CodexSessionProjection & { effectiveRuntimeProfile: EffectiveRuntimeProfile }> {
    this.startSessionCount += 1;
    await this.beforeStartSessionReturn?.();
    this.#threadSequence += 1;
    const projection: CodexSessionProjection = {
      providerThreadId: `provider-thread-${String(this.#threadSequence)}`,
      title: `Work actor ${String(this.#threadSequence)}`,
      status: "idle",
      providerUpdatedAt: 10_000 + this.#threadSequence,
      messages: [],
      turnSummaries: [],
    };
    this.#projections.set(projection.providerThreadId, projection);
    return {
      ...projection,
      effectiveRuntimeProfile: input.review.effectiveRuntimeProfile,
    };
  }

  async observeSession(
    input: Parameters<CodexRuntimePort["observeSession"]>[0],
  ): Promise<CodexSessionObservation> {
    return {
      connectionId: "30000000-0000-4000-8000-000000000901",
      projection: this.#requireProjection(input.providerThreadId),
      resumed: false,
    };
  }

  async readSession(
    input: Parameters<CodexRuntimePort["readSession"]>[0],
  ): Promise<CodexSessionProjection> {
    return this.#requireProjection(input.providerThreadId);
  }

  async endSession(): Promise<void> { this.endSessionCount += 1; }

  async reviewTurnStart(
    input: Parameters<CodexRuntimePort["reviewTurnStart"]>[0],
  ): Promise<RuntimeStartReview> {
    const error = this.nextReviewTurnStartError;
    delete this.nextReviewTurnStartError;
    if (error !== undefined) throw error;
    return {
      reviewId: `turn-review-${String(this.startTurnCalls.length + 1)}`,
      kind: "turn_start",
      effectiveRuntimeProfile: effectiveRuntimeProfile(
        input.authority,
        input.preset === "low" || input.preset === "ultra" ? input.preset : "high",
        input.fast,
      ),
    };
  }

  async steer(input: Parameters<CodexRuntimePort["steer"]>[0]): Promise<void> {
    this.steerCalls.push({
      activeTurnId: input.activeTurnId,
      clientMessageId: input.clientMessageId,
      message: input.message,
      providerThreadId: input.providerThreadId,
    });
  }

  async startTurn(
    input: Parameters<CodexRuntimePort["startTurn"]>[0],
  ): ReturnType<CodexRuntimePort["startTurn"]> {
    this.startTurnCalls.push({
      clientMessageId: input.clientMessageId,
      effectiveRuntimeProfile: input.review.effectiveRuntimeProfile,
      message: input.message,
      providerThreadId: input.providerThreadId,
    });
    const error = this.nextStartTurnError;
    delete this.nextStartTurnError;
    if (error !== undefined) throw error;

    const prior = this.#requireProjection(input.providerThreadId);
    const turnId = `provider-turn-${String(this.startTurnCalls.length)}`;
    this.#projections.set(input.providerThreadId, {
      ...prior,
      status: "active",
      activeTurnId: turnId,
      providerUpdatedAt: (prior.providerUpdatedAt ?? 10_000) + 1,
      messages: [
        ...(prior.messages ?? []),
        {
          role: "user",
          text: input.message,
          turnId,
          clientId: input.clientMessageId,
        },
      ],
      turnSummaries: [
        ...(prior.turnSummaries ?? []),
        {
          id: turnId,
          status: "inProgress",
          files: [],
          actions: [],
          omittedFiles: 0,
          omittedActions: 0,
        },
      ],
    });
    return {
      turnId,
      status: "inProgress",
      effectiveRuntimeProfile: input.review.effectiveRuntimeProfile,
    };
  }

  cancelLogin(): Promise<never> { return this.#closed(); }
  async logout(): Promise<void> { this.logoutCalls += 1; }
  readUsage(): Promise<never> { return this.#closed(); }
  consumeRateLimitReset(): Promise<never> { return this.#closed(); }
  listPlugins(): Promise<never> { return this.#closed(); }
  listSessions(): Promise<never> { return this.#closed(); }
  interrupt(): Promise<never> { return this.#closed(); }
  rename(): Promise<never> { return this.#closed(); }
  inspectTurn(): Promise<never> { return this.#closed(); }
  inspectInteractionAuthority(): Promise<never> { return this.#closed(); }
  validateInteractionResolution(): Promise<never> { return this.#closed(); }
  resolveInteraction(): Promise<never> { return this.#closed(); }
  validateInteractionTimeout(): Promise<never> { return this.#closed(); }
  timeoutInteraction(): Promise<never> { return this.#closed(); }
  async close(): Promise<void> {}

  #closed(): Promise<never> {
    return Promise.reject(new Error("The unused fake Codex operation is closed."));
  }

  #requireProjection(providerThreadId: string): CodexSessionProjection {
    const projection = this.#projections.get(providerThreadId);
    if (projection === undefined) throw new Error("Unknown fake provider thread.");
    return projection;
  }
}

class ClosedCloud implements CloudControlPort {
  async status(): Promise<unknown> { return { configured: false, signedIn: false }; }
  async sync(): Promise<never> { throw new Error("Cloud sync is closed in work tests."); }
  async isCompactProjectionRecoveryUnsettledForProfile(): Promise<boolean> { return false; }
  async isCompactProjectionRecoveryUnsettled(): Promise<boolean> { return false; }
  async supersedeCompactProjectionRecoveryForProviderDeletion(): Promise<{ superseded: boolean }> {
    return { superseded: false };
  }
  async supersedeTerminalCompactProjectionRecoveries(): Promise<{ superseded: number }> {
    return { superseded: 0 };
  }
  async recoverCompactProjection(): Promise<never> {
    throw new Error("Projection recovery is closed in work tests.");
  }
  async auth(): Promise<never> { throw new Error("Cloud auth is closed in work tests."); }
  async logout(): Promise<void> {}
  async deleteAccount(): Promise<never> {
    throw new Error("Cloud deletion is closed in work tests.");
  }
  async listDevices(): Promise<unknown> { return { devices: [] }; }
  async pairDevice(): Promise<never> { throw new Error("Pairing is closed in work tests."); }
  async acknowledgeNoAccountKeyHolders(): Promise<never> {
    throw new Error("Key-loss acknowledgement is closed in work tests.");
  }
  async approveDevice(): Promise<never> { throw new Error("Approval is closed in work tests."); }
  async revokeDevice(): Promise<never> { throw new Error("Revocation is closed in work tests."); }
}

class CurrentDaemonAuthority {
  current = true;

  async assertCurrent(): Promise<void> {
    if (!this.current) throw new Error("The test daemon authority is stale.");
  }

  close(): void {
    this.current = false;
  }
}

type Fixture = Readonly<{
  createService: () => OompaService;
  daemonGeneration: number;
  daemonBootId: string;
  eventCursors: SessionEventCursorCodec;
  paths: ReturnType<typeof resolveStatePaths>;
  projectRoot: string;
  runtime: WorkRuntime;
  service: OompaService;
  store: StateStore;
  workStore: WorkStore;
}>;

const fixtures: Fixture[] = [];
const fixtureRoots: string[] = [];
const ownedCaseTeardowns: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const teardown of ownedCaseTeardowns.splice(0)) await teardown();
  for (const value of fixtures.splice(0)) value.store.close();
  await Promise.all(fixtureRoots.splice(0).map(async (root) =>
    await rm(root, { force: true, recursive: true })));
});

async function fixture(registerStore?: (store: StateStore) => void): Promise<Fixture> {
  const home = await realpath(await mkdtemp(join(tmpdir(), "oompa-work-service-")));
  fixtureRoots.push(home);
  const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
  const projectRoot = join(home, "Documents");
  await mkdir(projectRoot, { recursive: true });
  await initializeStatePaths(paths);
  let observedAt = 10_000;
  const now = (): number => observedAt++;
  // Every test here starts from an empty current-schema store and none
  // inspects migrations, so the whole file uses the migrated template.
  await provisionMigratedStateTemplate(paths, { now });
  const store = new StateStore(paths, { now });
  registerStore?.(store);
  const daemonBootId = `boot_${crypto.randomUUID().replaceAll("-", "")}`;
  const daemonGeneration = store.nextDaemonGeneration(daemonBootId);
  const runtime = new WorkRuntime();
  const eventCursors = new SessionEventCursorCodec(SessionEventCursorCodec.generateKey());
  const workCapabilities = new WorkCapabilityCodec(WorkCapabilityCodec.generateKey());
  const createService = (): OompaService => new OompaService({
      store,
      paths,
      codex: runtime,
      cloud: new ClosedCloud(),
      daemonAuthority: new CurrentDaemonAuthority(),
      eventCursors,
      workCapabilities,
      daemonGeneration,
      daemonBootId,
      now: () => observedAt++,
      requestStop: () => undefined,
    });
  const service = createService();
  const workStore = store.createWorkStore(
    daemonGeneration,
    (payload) => payload.type === "work"
      ? eventCursors.encodeWorkEvent(payload)
      : payload.type === "work_actions"
        ? eventCursors.encodeWorkAction(payload)
        : eventCursors.encodeWorkTaskHistory(payload),
    {
      issue: (authority) => authority.scope === "attempt"
        ? workCapabilities.issue({
            scope: authority.scope,
            workId: authority.workId,
            sessionId: authority.sessionId,
            subjectId: authority.attemptId,
            fence: authority.fence,
          })
        : workCapabilities.issue(authority),
      verify: (capability, authority) => authority.scope === "attempt"
        ? workCapabilities.verify({
            scope: authority.scope,
            workId: authority.workId,
            sessionId: authority.sessionId,
            subjectId: authority.attemptId,
            fence: authority.fence,
            capability,
          })
        : workCapabilities.verify({ ...authority, capability }),
    },
  );
  const value = {
    createService,
    daemonGeneration,
    daemonBootId,
    eventCursors,
    paths,
    projectRoot,
    runtime,
    service,
    store,
    workStore,
  };
  fixtures.push(value);
  return value;
}

function ownedWorkServiceCase(runCase: (value: Fixture) => Promise<void>): Promise<void> {
  let store: StateStore | undefined;
  let value: Fixture | undefined;
  const setup = Promise.resolve().then(() => fixture((created) => { store = created; }));
  const caseTask = setup.then(async (created) => {
    value = created;
    await runCase(created);
  });
  // Each request is awaited by the case or its actor helpers. Join setup and
  // that raw case before closing the service, storage, or temporary root.
  const joined = Promise.allSettled([setup, caseTask]);
  let teardownTask: Promise<void> | undefined;
  const teardown = (): Promise<void> => {
    teardownTask ??= joined.then(async () => {
      if (value === undefined) store?.close();
      else await value.service.close();
    });
    return teardownTask;
  };
  ownedCaseTeardowns.push(teardown);
  const result = caseTask.finally(teardown);
  void result.catch(() => undefined);
  return result;
}

type Actor = Readonly<{
  accountId: ProfileId;
  projectId: ProjectId;
  sessionId: SessionId;
}>;

async function createActor(value: Fixture): Promise<Actor> {
  const added = await value.service.execute(
    { kind: "account.add", label: "Work agent" },
    { signal },
  ) as { account: { id: ProfileId } };
  await value.service.execute(
    { kind: "account.login", account: added.account.id, deviceCode: false },
    { signal },
  );
  const project = await value.service.execute(
    { kind: "project.add", label: "Work project", path: value.projectRoot },
    { signal },
  ) as { project: { id: ProjectId } };
  const started = await value.service.execute({
    kind: "session.start",
    account: added.account.id,
    project: project.project.id,
    preset: "high",
    fast: false,
    presetContract: 2,
  }, { signal }) as { session: { id: SessionId } };
  return {
    accountId: added.account.id,
    projectId: project.project.id,
    sessionId: started.session.id,
  };
}

async function createSiblingActor(value: Fixture, actor: Actor): Promise<Actor> {
  const started = await value.service.execute({
    kind: "session.start",
    account: actor.accountId,
    project: actor.projectId,
    preset: "high",
    fast: false,
    presetContract: 2,
  }, { signal }) as { session: { id: SessionId } };
  return { ...actor, sessionId: started.session.id };
}

function taskSpec(actor: Actor, clientRef = "implementation"): WorkTaskSpec {
  return {
    clientRef,
    dependsOnRefs: [],
    dependsOnTaskIds: [],
    objective: "Implement the bounded coordination change.",
    instructions: "Make the change and preserve exact durable authority.",
    criteria: ["The focused verification passes."],
    route: { accountId: actor.accountId, projectId: actor.projectId },
    preset: "high",
    fast: false,
    priority: 0,
    maxAttempts: 2,
    requiredReviews: 0,
    resultKind: "text",
    minEvidence: 0,
  };
}

let keySequence = 0;
const nextKey = (): string => {
  keySequence += 1;
  return `018f1f64-6c17-7000-8000-${String(keySequence).padStart(12, "0")}`;
};

async function createAndJoin(value: Fixture, actor: Actor) {
  const created = workOperationResultSchema.parse(await value.service.execute({
    kind: "work.apply",
    requestId: crypto.randomUUID(),
    requestVersion: WORK_APPLY_REQUEST_VERSION,
    presetContract: 2,
    operation: {
      kind: "work.create",
      idempotencyKey: nextKey(),
      clientRef: `work-${String(keySequence)}`,
      coordinatorSessionId: actor.sessionId,
      objective: "Coordinate one exact agent task.",
      routes: [{
        accountId: actor.accountId,
        projectId: actor.projectId,
        preset: "high",
        fast: false,
      }],
      tasks: [taskSpec(actor)],
    },
  }, { signal }));
  if (created.kind !== "work.create") throw new Error("Expected work creation.");
  const joinOperation = {
    kind: "work.join",
    idempotencyKey: nextKey(),
    workId: created.work.id,
    coordinatorSessionId: actor.sessionId,
    coordinatorCapability: created.coordinatorCapability,
    actorSessionId: actor.sessionId,
  } as const;
  const joined = workOperationResultSchema.parse(await value.service.execute({
    kind: "work.apply",
    requestId: crypto.randomUUID(),
    operation: joinOperation,
  }, { signal }));
  if (joined.kind !== "work.join") throw new Error("Expected work join.");
  return { created, joined, joinOperation };
}

async function createJoinClaim(value: Fixture, actor: Actor) {
  const { created, joined } = await createAndJoin(value, actor);
  const claimed = workOperationResultSchema.parse(await value.service.execute({
    kind: "work.apply",
    requestId: crypto.randomUUID(),
    operation: {
      kind: "task.claim",
      idempotencyKey: nextKey(),
      workId: created.work.id,
      taskId: created.tasks[0]!.id,
      expectedTaskRevision: created.tasks[0]!.revision,
      actorSessionId: actor.sessionId,
      actorCapability: joined.memberCapability,
      leaseMs: 5_000,
    },
  }, { signal }));
  if (claimed.kind !== "task.claim") throw new Error("Expected task claim.");
  return { created, joined, claimed };
}

type ClaimedWork = Awaited<ReturnType<typeof createJoinClaim>>;

function dispatchOperation(
  actor: Actor,
  claimedWork: ClaimedWork,
  idempotencyKey = nextKey(),
) {
  return {
    kind: "attempt.dispatch",
    idempotencyKey,
    workId: claimedWork.created.work.id,
    attemptId: claimedWork.claimed.attempt.id,
    expectedAttemptRevision: claimedWork.claimed.attempt.revision,
    fence: claimedWork.claimed.attempt.fence,
    actorSessionId: actor.sessionId,
    attemptCapability: claimedWork.claimed.attemptCapability,
    targetSessionId: actor.sessionId,
    mode: "send",
  } as const;
}

function prepareOuterDispatch(
  value: Fixture,
  actor: Actor,
  claimedWork: ClaimedWork,
) {
  const operation = dispatchOperation(actor, claimedWork);
  const result = workOperationResultSchema.parse(
    value.workStore.apply(operation, operation.idempotencyKey),
  );
  if (result.kind !== "attempt.dispatch") throw new Error("Expected dispatch preparation.");
  const prepared = value.workStore.preparedEffect(operation.idempotencyKey);
  if (prepared === null || prepared.effect.kind !== "dispatch") {
    throw new Error("Expected internal dispatch instruction.");
  }
  return {
    effect: workPreparedEffectSchema.parse(prepared.effect) as Extract<
      WorkPreparedEffect,
      { kind: "dispatch" }
    >,
    operation,
  };
}

function prepareNestedSend(
  value: Fixture,
  effect: Extract<WorkPreparedEffect, { kind: "dispatch" }>,
) {
  const message = workPreparedEffectMessage(effect);
  const sessionAuthority = value.store.requireSessionProviderAuthority(
    effect.targetSessionId,
  );
  return {
    attempt: value.store.prepareSessionInputMutation({
      kind: "session.send",
      sessionId: effect.targetSessionId,
      message,
      attachments: [],
      idempotencyKey: effect.nestedMutationKey,
      providerAuthority: {
        provider: sessionAuthority.provider,
        providerAccountId: sessionAuthority.providerAccountId,
        profileId: sessionAuthority.profileId,
        bindingGeneration: sessionAuthority.bindingGeneration,
        processGeneration: effect.accountGeneration,
      },
      daemonGeneration: value.daemonGeneration,
      bootId: value.daemonBootId,
    }).attempt,
    message,
  };
}

function beginNestedSend(
  value: Fixture,
  actor: Actor,
  effect: Extract<WorkPreparedEffect, { kind: "dispatch" }>,
  nested: ReturnType<typeof prepareNestedSend>,
) {
  const session = value.store.requireSession(actor.sessionId);
  if (session.providerThreadId === undefined) throw new Error("Expected a bound session.");
  if (session.state !== "idle" && session.state !== "active" && session.state !== "terminal") {
    throw new Error("Expected an observed provider session.");
  }
  const providerAuthority = value.store.requireProviderAccountAuthority(
    actor.accountId,
    "codex",
  );
  const runtimeProfile = effectiveRuntimeProfile({
    id: actor.accountId,
    generation: effect.accountGeneration,
    provider: providerAuthority.provider,
    providerAccountId: providerAuthority.providerAccountId,
    bindingGeneration: providerAuthority.bindingGeneration,
    codexHome: value.paths.profiles,
    desktopUserData: value.paths.profiles,
  });
  value.store.beginSessionMutationEffect({
    attemptId: nested.attempt.id,
    sessionId: actor.sessionId,
    profileGeneration: effect.accountGeneration,
    providerAuthority,
    attachments: [],
    daemonGeneration: value.daemonGeneration,
    bootId: value.daemonBootId,
    transcript: {
      accountId: actor.accountId,
      providerGeneration: effect.accountGeneration,
      providerConnectionId: "30000000-0000-4000-8000-00000000000d",
      actor: "automation",
      message: nested.message,
    },
    evidence: {
      kind: "session.send",
      providerThreadId: session.providerThreadId,
      baseline: {
        providerUpdatedAt: session.providerUpdatedAt ?? null,
        status: session.state,
        activeTurnId: session.activeTurnId ?? null,
      },
      clientMessageId: nested.attempt.id,
      messageDigest: createHash("sha256").update(nested.message).digest("hex"),
      runtimeProfile,
    },
    message: nested.message,
  });
  return { providerAuthority, runtimeProfile, session };
}

describe("OompaService work protocol", () => {
  test("preserves v1 replay identity while requiring current v2 source for rebound creation", async () => {
    const value = await fixture();
    const actor = await createActor(value);
    const { joined, joinOperation } = await createAndJoin(value, actor);

    expect(workOperationResultSchema.parse(await value.service.execute({
      kind: "work.apply",
      requestId: crypto.randomUUID(),
      operation: structuredClone(joinOperation),
    }, { signal }))).toEqual(joined);
    await expect(value.service.execute({
      kind: "work.apply",
      requestId: crypto.randomUUID(),
      requestVersion: WORK_APPLY_REQUEST_VERSION,
      operation: structuredClone(joinOperation),
    }, { signal })).rejects.toMatchObject({
      code: "CONFLICT",
      details: { reason: "IDEMPOTENCY_CONFLICT" },
    });

    const reboundOperation = {
      kind: "work.create",
      idempotencyKey: nextKey(),
      clientRef: `source-bound-work-${String(keySequence)}`,
      coordinatorSessionId: actor.sessionId,
      objective: "Require a current caller-authored source contract.",
      routes: [{
        accountId: actor.accountId,
        projectId: actor.projectId,
        preset: "ultra",
        fast: false,
      }],
      tasks: [taskSpec(actor, "source-bound-task")].map((task) => ({
        ...task,
        preset: "ultra" as const,
      })),
    } satisfies WorkOperation;
    await expect(value.service.execute({
      kind: "work.apply",
      requestId: crypto.randomUUID(),
      operation: reboundOperation,
    }, { signal })).rejects.toMatchObject({
      code: "CONFLICT",
      details: { reason: "ROUTE_MISMATCH" },
    });
    await expect(value.service.execute({
      kind: "work.apply",
      requestId: crypto.randomUUID(),
      requestVersion: WORK_APPLY_REQUEST_VERSION,
      presetContract: 1,
      operation: reboundOperation,
    }, { signal })).rejects.toMatchObject({
      code: "CONFLICT",
      details: { reason: "ROUTE_MISMATCH" },
    });
    const admitted = workOperationResultSchema.parse(await value.service.execute({
      kind: "work.apply",
      requestId: crypto.randomUUID(),
      requestVersion: WORK_APPLY_REQUEST_VERSION,
      presetContract: 2,
      operation: reboundOperation,
    }, { signal }));
    expect(admitted.kind).toBe("work.create");
    expect(workOperationResultSchema.parse(await value.service.execute({
      kind: "work.apply",
      requestId: crypto.randomUUID(),
      requestVersion: WORK_APPLY_REQUEST_VERSION,
      presetContract: 2,
      operation: structuredClone(reboundOperation),
    }, { signal }))).toEqual(admitted);
  });

  test("advertises, coordinates, dispatches, and exactly replays through session authority", async () => {
    const value = await fixture();
    const actor = await createActor(value);
    expect(await value.service.execute({ kind: "work.protocol", query: { kind: "index" } }, { signal }))
      .toEqual(describeWorkProtocol({ kind: "index" }));
    expect(await value.service.execute({ kind: "work.protocol", query: { kind: "topic", topic: "errors" } }, { signal }))
      .toEqual(describeWorkProtocol({ kind: "topic", topic: "errors" }));

    const { created, claimed } = await createJoinClaim(value, actor);
    const beforeDispatch = workSnapshotSchema.parse(await value.service.execute({
      kind: "work.snapshot",
      work: created.work.id,
      actor: actor.sessionId,
    }, { signal }));
    expect(beforeDispatch.joinedSessionIds).toEqual([actor.sessionId]);

    const dispatchKey = nextKey();
    const dispatchOperation = {
      kind: "attempt.dispatch",
      idempotencyKey: dispatchKey,
      workId: created.work.id,
      attemptId: claimed.attempt.id,
      expectedAttemptRevision: claimed.attempt.revision,
      fence: claimed.attempt.fence,
      actorSessionId: actor.sessionId,
      attemptCapability: claimed.attemptCapability,
      targetSessionId: actor.sessionId,
      mode: "send",
    } as const;
    const dispatched = workOperationResultSchema.parse(await value.service.execute({
      kind: "work.apply",
      requestId: crypto.randomUUID(),
      operation: dispatchOperation,
    }, { signal }));
    expect(dispatched).toMatchObject({
      kind: "attempt.dispatch",
      attempt: {
        id: claimed.attempt.id,
        actorSessionId: actor.sessionId,
        targetSessionId: actor.sessionId,
        status: "active",
      },
    });
    expect(value.runtime.startTurnCalls).toHaveLength(1);
    if (dispatched.kind !== "attempt.dispatch") throw new Error("Expected dispatch result.");
    const dispatchEffect = value.workStore.preparedEffect(dispatchKey)?.effect;
    if (dispatchEffect?.kind !== "dispatch") throw new Error("Expected internal dispatch effect.");
    const sessionMutation = value.store.readMutation(dispatchEffect.nestedMutationKey);
    expect(sessionMutation).toMatchObject({
      authorityId: actor.sessionId,
      idempotencyKey: dispatchEffect.nestedMutationKey,
      kind: "session.send",
      state: "applied",
    });
    expect(value.runtime.startTurnCalls[0]?.clientMessageId).toBe(sessionMutation?.id);
    expect(value.runtime.startTurnCalls[0]!.message).toBe(
      workPreparedEffectMessage(dispatchEffect),
    );
    expect(JSON.parse(value.runtime.startTurnCalls[0]!.message)).toMatchObject({
      control: {
        apply: { argv: ["oompa", "work", "apply", "--input-stdin"] },
        poll: {
          argv: ["oompa", "work", "poll", created.work.id, "--actor", actor.sessionId],
        },
        requests: {
          checkpoint: {
            protocol: "hra-work-local-v1",
            version: WORK_APPLY_REQUEST_VERSION,
            requestId: "$PERSISTED_REQUEST_UUID",
            operation: { attemptCapability: claimed.attemptCapability },
          },
        },
      },
    });
    expect(dispatched.attempt.dispatchReceipt).toMatchObject({
      kind: "turn_started",
      mutationAttemptId: sessionMutation?.id,
      accountGeneration: claimed.attempt.accountGeneration,
      turnId: value.eventCursors.projectPublicProviderIdentifier("provider-turn-1"),
    });
    expect(dispatched.attempt.dispatchReceipt?.kind === "turn_started"
      ? dispatched.attempt.dispatchReceipt.runtimeProfileDigest
      : "").toBe(createHash("sha256")
      .update(canonicalWorkJson(value.runtime.startTurnCalls[0]!.effectiveRuntimeProfile))
      .digest("hex"));
    expect(JSON.stringify(dispatched)).not.toContain("provider-turn-1");

    expect(workOperationResultSchema.parse(await value.service.execute({
      kind: "work.apply",
      requestId: crypto.randomUUID(),
      operation: structuredClone(dispatchOperation),
    }, { signal }))).toEqual(dispatched);
    expect(value.runtime.startTurnCalls).toHaveLength(1);

    const checkpoint = workOperationResultSchema.parse(await value.service.execute({
      kind: "work.apply",
      requestId: crypto.randomUUID(),
      operation: {
        kind: "attempt.report",
        idempotencyKey: nextKey(),
        workId: created.work.id,
        attemptId: claimed.attempt.id,
        expectedAttemptRevision: dispatched.attempt.revision,
        fence: claimed.attempt.fence,
        actorSessionId: actor.sessionId,
        attemptCapability: claimed.attemptCapability,
        report: { kind: "checkpoint", summary: "Durable checkpoint", evidence: [] },
      },
    }, { signal }));
    expect(checkpoint.kind).toBe("attempt.report");
    expect(workTaskDetailSchema.parse(await value.service.execute({
      kind: "work.task",
      task: created.tasks[0]!.id,
    }, { signal })).latestAttemptReport?.reportKind).toBe("checkpoint");
    const firstHistory = workTaskHistoryPageSchema.parse(await value.service.execute({
      kind: "work.task",
      task: created.tasks[0]!.id,
      historyLimit: 1,
    }, { signal }));
    expect(firstHistory.items).toHaveLength(1);
    expect(firstHistory.nextCursor).not.toBeNull();
    if (firstHistory.nextCursor === null) throw new Error("Expected task history continuation.");
    const secondHistory = workTaskHistoryPageSchema.parse(await value.service.execute({
      kind: "work.task",
      task: created.tasks[0]!.id,
      historyLimit: 1,
      historyCursor: firstHistory.nextCursor,
    }, { signal }));
    expect(secondHistory.requestedCursor).toBe(firstHistory.nextCursor);
    expect(secondHistory.offset).toBe(1);
    expect(secondHistory.items).toHaveLength(1);
    expect(secondHistory.items[0]).not.toEqual(firstHistory.items[0]);

    const actorPoll = workPollSchema.parse(await value.service.execute({
      kind: "work.poll",
      work: created.work.id,
      actor: actor.sessionId,
      limit: 50,
      waitMs: 0,
    }, { signal }));
    expect(actorPoll.actorSessionId).toBe(actor.sessionId);
    expect(actorPoll.ownedAttempts).toHaveLength(1);
    expect(actorPoll.ownedAttempts[0]?.actorSessionId).toBe(actor.sessionId);

    const monitorPoll = workPollSchema.parse(await value.service.execute({
      kind: "work.poll",
      work: created.work.id,
      limit: 50,
      waitMs: 0,
    }, { signal }));
    expect(monitorPoll.actorSessionId).toBeNull();
    expect(monitorPoll.ownedAttempts).toEqual([]);
    expect(monitorPoll.signals).toEqual([]);

    const events = workEventPageSchema.parse(await value.service.execute({
      kind: "work.events",
      work: created.work.id,
      limit: 50,
      waitMs: 0,
    }, { signal }));
    const decoded = value.eventCursors.decodeWorkEvent(events.nextCursor, created.work.id);
    const finalEvent = events.events.at(-1);
    if (finalEvent === undefined) throw new Error("Expected at least one work event.");
    expect(decoded.sequence).toBe(finalEvent.sequence);
    expect(events.nextCursor).toMatch(/^hra1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/u);
    expect(workEventPageSchema.parse(await value.service.execute({
      kind: "work.events",
      work: created.work.id,
      cursor: events.nextCursor,
      limit: 50,
      waitMs: 0,
    }, { signal }))).toMatchObject({
      requestedCursor: events.nextCursor,
      nextCursor: events.nextCursor,
      gap: null,
      events: [],
    });

    let actorBindingFailure: unknown;
    try {
      await value.service.execute({
        kind: "work.poll",
        work: created.work.id,
        actor: createSessionId(),
        limit: 50,
        waitMs: 0,
      }, { signal });
    } catch (error: unknown) {
      actorBindingFailure = error;
    }
    expect(actorBindingFailure).toBeInstanceOf(CommandFailure);
    expect((actorBindingFailure as CommandFailure).code).toBe("NOT_FOUND");

    const tamperedCursor = `${events.nextCursor.slice(0, -1)}${events.nextCursor.endsWith("A") ? "E" : "A"}`;
    let cursorFailure: unknown;
    try {
      await value.service.execute({
        kind: "work.events",
        work: created.work.id,
        cursor: tamperedCursor,
        limit: 50,
        waitMs: 0,
      }, { signal });
    } catch (error: unknown) {
      cursorFailure = error;
    }
    expect(cursorFailure).toBeInstanceOf(CommandFailure);
    expect((cursorFailure as CommandFailure).code).toBe("INVALID_INPUT");
  });

  test("settles a pre-effect rejection without calling the external turn effect", async () => {
    const value = await fixture();
    const actor = await createActor(value);
    const { created, claimed } = await createJoinClaim(value, actor);
    const dispatchOperation = {
      kind: "attempt.dispatch",
      idempotencyKey: nextKey(),
      workId: created.work.id,
      attemptId: claimed.attempt.id,
      expectedAttemptRevision: claimed.attempt.revision,
      fence: claimed.attempt.fence,
      actorSessionId: actor.sessionId,
      attemptCapability: claimed.attemptCapability,
      targetSessionId: actor.sessionId,
      mode: "send",
    } as const;
    value.runtime.nextReviewTurnStartError = new Error("Known turn preflight rejection.");

    for (let replay = 0; replay < 2; replay += 1) {
      let failure: unknown;
      try {
        await value.service.execute({
          kind: "work.apply",
          requestId: crypto.randomUUID(),
          operation: structuredClone(dispatchOperation),
        }, { signal });
      } catch (error: unknown) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(CommandFailure);
      expect((failure as CommandFailure).code).toBe("CONFLICT");
    }
    expect(value.runtime.startTurnCalls).toHaveLength(0);
  });

  test("startup executes an outer prepared dispatch from its persisted instruction", async () => {
    const value = await fixture();
    const actor = await createActor(value);
    const claimedWork = await createJoinClaim(value, actor);
    const prepared = prepareOuterDispatch(value, actor, claimedWork);
    expect(value.workStore.effectStatus(prepared.operation.idempotencyKey)?.state)
      .toBe("prepared");

    await value.createService().recover();

    expect(value.runtime.startTurnCalls).toHaveLength(1);
    const replay = workOperationResultSchema.parse(value.workStore.apply(
      prepared.operation,
      prepared.operation.idempotencyKey,
    ));
    expect(replay).toMatchObject({
      kind: "attempt.dispatch",
      attempt: { id: claimedWork.claimed.attempt.id, status: "active" },
    });
    expect(value.workStore.effectStatus(prepared.operation.idempotencyKey)?.state)
      .toBe("accepted");
  });

  test("startup resumes a nested prepared dispatch but never an authorized pre-begin gap", async () => {
    const resumable = await fixture();
    const resumableActor = await createActor(resumable);
    const resumableWork = await createJoinClaim(resumable, resumableActor);
    const outerPrepared = prepareOuterDispatch(resumable, resumableActor, resumableWork);
    prepareNestedSend(resumable, outerPrepared.effect);

    await resumable.createService().recover();

    expect(resumable.runtime.startTurnCalls).toHaveLength(1);
    expect(resumable.workStore.effectStatus(outerPrepared.operation.idempotencyKey)?.state)
      .toBe("accepted");

    const fenced = await fixture();
    const fencedActor = await createActor(fenced);
    const fencedWork = await createJoinClaim(fenced, fencedActor);
    const outerStarted = prepareOuterDispatch(fenced, fencedActor, fencedWork);
    prepareNestedSend(fenced, outerStarted.effect);
    expect(fenced.workStore.authorizePreparedEffect(outerStarted.operation.idempotencyKey))
      .toMatchObject({ executable: true, status: { state: "effect_started" } });

    await fenced.createService().recover();

    expect(fenced.runtime.startTurnCalls).toHaveLength(0);
    expect(fenced.store.readMutation(outerStarted.effect.nestedMutationKey)?.state)
      .toBe("cancelled");
    expect(fenced.workStore.effectStatus(outerStarted.operation.idempotencyKey)?.state)
      .toBe("failed");
  });

  test("startup turns a nested begun dispatch into unknown without provider replay", async () => {
    const value = await fixture();
    const actor = await createActor(value);
    const claimedWork = await createJoinClaim(value, actor);
    const prepared = prepareOuterDispatch(value, actor, claimedWork);
    const nested = prepareNestedSend(value, prepared.effect);
    expect(value.workStore.authorizePreparedEffect(prepared.operation.idempotencyKey))
      .toMatchObject({ executable: true, status: { state: "effect_started" } });
    beginNestedSend(value, actor, prepared.effect, nested);

    await value.createService().recover();

    expect(value.runtime.startTurnCalls).toHaveLength(0);
    expect(value.store.readMutation(prepared.effect.nestedMutationKey)?.state).toBe("ambiguous");
    expect(value.workStore.effectStatus(prepared.operation.idempotencyKey)?.state)
      .toBe("unknown");
  });

  test("startup reprojects a nested accepted dispatch without provider replay", async () => {
    const value = await fixture();
    const actor = await createActor(value);
    const claimedWork = await createJoinClaim(value, actor);
    const prepared = prepareOuterDispatch(value, actor, claimedWork);
    const nested = prepareNestedSend(value, prepared.effect);
    expect(value.workStore.authorizePreparedEffect(prepared.operation.idempotencyKey))
      .toMatchObject({ executable: true, status: { state: "effect_started" } });
    const begun = beginNestedSend(value, actor, prepared.effect, nested);
    value.store.completeSessionTurnEffect({
      accountId: actor.accountId,
      attemptId: nested.attempt.id,
      sessionId: actor.sessionId,
      expectedSessionRevision: begun.session.revision,
      providerAuthority: begun.providerAuthority,
      message: nested.message,
      providerConnectionId: null,
      providerGeneration: prepared.effect.accountGeneration,
      applyResponseState: true,
      turnId: "provider-turn-before-restart",
      turnStatus: "inProgress",
      runtimeProfile: begun.runtimeProfile,
      receipt: {
        turnId: "provider-turn-before-restart",
        status: "inProgress",
        sourceId: nested.attempt.id,
        effectiveRuntimeProfile: begun.runtimeProfile,
      },
    });

    await value.createService().recover();

    expect(value.runtime.startTurnCalls).toHaveLength(0);
    expect(value.workStore.effectStatus(prepared.operation.idempotencyKey)?.state)
      .toBe("accepted");
    const replay = workOperationResultSchema.parse(value.workStore.apply(
      prepared.operation,
      prepared.operation.idempotencyKey,
    ));
    expect(replay).toMatchObject({
      kind: "attempt.dispatch",
      attempt: {
        id: claimedWork.claimed.attempt.id,
        dispatchReceipt: {
          kind: "turn_started",
          mutationAttemptId: nested.attempt.id,
          turnId: value.eventCursors.projectPublicProviderIdentifier(
            "provider-turn-before-restart",
          ),
        },
      },
    });
  });

  test("startup preserves a nested ambiguous dispatch as unknown without replay", async () => {
    const value = await fixture();
    const actor = await createActor(value);
    const claimedWork = await createJoinClaim(value, actor);
    const prepared = prepareOuterDispatch(value, actor, claimedWork);
    const nested = prepareNestedSend(value, prepared.effect);
    expect(value.workStore.authorizePreparedEffect(prepared.operation.idempotencyKey))
      .toMatchObject({ executable: true, status: { state: "effect_started" } });
    beginNestedSend(value, actor, prepared.effect, nested);
    expect(value.store.transitionMutation(
      nested.attempt.id,
      "effect_started",
      "ambiguous",
      { code: "SIMULATED_CRASH" },
    )).toBe(true);

    await value.createService().recover();

    expect(value.runtime.startTurnCalls).toHaveLength(0);
    expect(value.workStore.effectStatus(prepared.operation.idempotencyKey)?.state)
      .toBe("unknown");
  });

  test("pages bounded action lists with an actor-bound fixed-snapshot cursor", async () => {
    const value = await fixture();
    const actor = await createActor(value);
    const created = workOperationResultSchema.parse(await value.service.execute({
      kind: "work.apply",
      requestId: crypto.randomUUID(),
      requestVersion: WORK_APPLY_REQUEST_VERSION,
      presetContract: 2,
      operation: {
        kind: "work.create",
        idempotencyKey: nextKey(),
        clientRef: `paged-work-${String(keySequence)}`,
        coordinatorSessionId: actor.sessionId,
        objective: "Expose a bounded action continuation.",
        routes: [{
          accountId: actor.accountId,
          projectId: actor.projectId,
          preset: "high",
          fast: false,
        }],
        tasks: [
          taskSpec(actor, "page-a"),
          taskSpec(actor, "page-b"),
          taskSpec(actor, "page-c"),
        ],
      },
    }, { signal }));
    if (created.kind !== "work.create") throw new Error("Expected work creation.");
    const first = workPollSchema.parse(await value.service.execute({
      kind: "work.poll",
      work: created.work.id,
      actor: actor.sessionId,
      limit: 1,
      waitMs: 0,
    }, { signal }));
    expect(first.readyTasks).toHaveLength(1);
    expect(first.omitted.readyTasks).toBe(2);
    expect(first.nextActionCursor).not.toBeNull();
    const firstActionCursor = first.nextActionCursor;
    if (firstActionCursor === null) throw new Error("Expected an action continuation.");

    const second = workPollSchema.parse(await value.service.execute({
      kind: "work.poll",
      actionCursor: firstActionCursor,
      work: created.work.id,
      actor: actor.sessionId,
      limit: 1,
      waitMs: 0,
    }, { signal }));
    expect(second.readyTasks).toHaveLength(1);
    expect(second.readyTasks[0]?.id).not.toBe(first.readyTasks[0]?.id);
    expect(second.omitted.readyTasks).toBe(1);
    expect(second.nextActionCursor).not.toBeNull();

    let waitingContinuationFailure: unknown;
    try {
      await value.service.execute({
        kind: "work.poll",
        actionCursor: firstActionCursor,
        work: created.work.id,
        actor: actor.sessionId,
        limit: 1,
        waitMs: 1,
      }, { signal });
    } catch (error: unknown) {
      waitingContinuationFailure = error;
    }
    expect(waitingContinuationFailure).toBeInstanceOf(CommandFailure);
    expect((waitingContinuationFailure as CommandFailure).code).toBe("INVALID_INPUT");
  });

  test("rejects stale work and profile authority before an external Codex effect", async () => {
    const value = await fixture();
    const actor = await createActor(value);
    const { created, claimed } = await createJoinClaim(value, actor);
    let staleFailure: unknown;
    try {
      await value.service.execute({
        kind: "work.apply",
        requestId: crypto.randomUUID(),
        operation: {
          kind: "attempt.dispatch",
          idempotencyKey: nextKey(),
          workId: created.work.id,
          attemptId: claimed.attempt.id,
          expectedAttemptRevision: claimed.attempt.revision + 1,
          fence: claimed.attempt.fence,
          actorSessionId: actor.sessionId,
          attemptCapability: claimed.attemptCapability,
          targetSessionId: actor.sessionId,
          mode: "send",
        },
      }, { signal });
    } catch (error: unknown) {
      staleFailure = error;
    }
    expect(staleFailure).toBeInstanceOf(CommandFailure);
    expect((staleFailure as CommandFailure).code).toBe("CONFLICT");
    expect(value.runtime.startTurnCalls).toHaveLength(0);

    const capabilityPayloadIndex = "hrac1_".length;
    const invalidCapability = `${claimed.attemptCapability.slice(0, capabilityPayloadIndex)}${
      claimed.attemptCapability[capabilityPayloadIndex] === "A" ? "B" : "A"
    }${claimed.attemptCapability.slice(capabilityPayloadIndex + 1)}`;
    let capabilityFailure: unknown;
    try {
      await value.service.execute({
        kind: "work.apply",
        requestId: crypto.randomUUID(),
        operation: {
          kind: "attempt.dispatch",
          idempotencyKey: nextKey(),
          workId: created.work.id,
          attemptId: claimed.attempt.id,
          expectedAttemptRevision: claimed.attempt.revision,
          fence: claimed.attempt.fence,
          actorSessionId: actor.sessionId,
          attemptCapability: invalidCapability,
          targetSessionId: actor.sessionId,
          mode: "send",
        },
      }, { signal });
    } catch (error: unknown) {
      capabilityFailure = error;
    }
    expect(capabilityFailure).toBeInstanceOf(CommandFailure);
    expect((capabilityFailure as CommandFailure).code).toBe("CONFLICT");
    expect(value.runtime.startTurnCalls).toHaveLength(0);

    let logoutFailure: unknown;
    try {
      await value.service.execute({
        kind: "account.logout",
        account: actor.accountId,
        idempotencyKey: nextKey(),
      }, { signal });
    } catch (error: unknown) {
      logoutFailure = error;
    }
    expect(logoutFailure).toBeInstanceOf(CommandFailure);
    expect((logoutFailure as CommandFailure).code).toBe("RECOVERY_REQUIRED");
    expect(value.runtime.logoutCalls).toBe(0);
  });

  test("refuses a meaningful same-account provider switch while the session belongs to live Work", async () => {
    const value = await fixture();
    const actor = await createActor(value);
    await createJoinClaim(value, actor);
    const switchKey = nextKey();
    const startsBefore = value.runtime.startSessionCount;

    await expect(value.service.execute({
      kind: "session.switch",
      idempotencyKey: switchKey,
      preset: "low",
      provider: "codex",
      session: actor.sessionId,
    }, { signal })).rejects.toMatchObject({
      code: "CONFLICT",
      details: { reason: "SESSION_PROVIDER_SWITCH_BLOCKED" },
    });

    expect(value.runtime.startSessionCount).toBe(startsBefore);
    expect(value.runtime.startTurnCalls).toHaveLength(0);
    expect(value.runtime.endSessionCount).toBe(0);
    expect(value.store.readMutation(switchKey)).toBeNull();
    expect(value.store.requireSession(actor.sessionId)).toMatchObject({
      profileId: actor.accountId,
      provider: "codex",
      state: "idle",
    });
  });

  test.each(["before review", "during review"] as const)("refuses a provider switch before effects when the session gains a Work attempt %s", async (timing) => {
    const value = await fixture();
    const actor = await createActor(value);
    if (timing === "before review") await createJoinClaim(value, actor);
    const target = await value.service.execute(
      { kind: "account.add", label: "Switch target" },
      { signal },
    ) as { account: { id: ProfileId } };
    await value.service.execute(
      { kind: "account.login", account: target.account.id, deviceCode: false },
      { signal },
    );
    const switchKey = nextKey();
    const startsBefore = value.runtime.startSessionCount;
    let admittedDuringReview = false;
    if (timing === "during review") {
      value.runtime.beforeReviewSessionReturn = async () => {
        delete value.runtime.beforeReviewSessionReturn;
        await createJoinClaim(value, actor);
        admittedDuringReview = true;
      };
    }

    await expect(value.service.execute({
      kind: "session.switch",
      account: target.account.id,
      idempotencyKey: switchKey,
      presetContract: currentPresetContract,
      provider: "codex",
      session: actor.sessionId,
    }, { signal })).rejects.toMatchObject({
      code: "CONFLICT",
      details: { reason: "SESSION_PROVIDER_SWITCH_BLOCKED" },
    });

    expect(value.runtime.startSessionCount).toBe(startsBefore);
    expect(value.runtime.startTurnCalls).toHaveLength(0);
    expect(value.runtime.endSessionCount).toBe(0);
    expect(admittedDuringReview).toBe(timing === "during review");
    expect(value.store.readMutation(switchKey)).toBeNull();
    expect(value.store.requireSession(actor.sessionId)).toMatchObject({
      profileId: actor.accountId,
      provider: "codex",
      state: "idle",
    });
  });

  test("lets an effect-started same-account provider switch fence a competing Work claim", async () => {
    const value = await fixture();
    const actor = await createActor(value);
    const coordinator = await createSiblingActor(value, actor);
    const { created } = await createAndJoin(value, coordinator);
    let enterTargetStart = (): void => {};
    const targetStartEntered = new Promise<void>((resolve) => { enterTargetStart = resolve; });
    let releaseTargetStart = (): void => {};
    const targetStartGate = new Promise<void>((resolve) => { releaseTargetStart = resolve; });
    value.runtime.beforeStartSessionReturn = async () => {
      delete value.runtime.beforeStartSessionReturn;
      enterTargetStart();
      await targetStartGate;
    };
    const switchKey = nextKey();
    const startsBefore = value.runtime.startSessionCount;
    const switchPromise = value.service.execute({
      kind: "session.switch",
      idempotencyKey: switchKey,
      preset: "low",
      provider: "codex",
      session: actor.sessionId,
    }, { signal });
    await targetStartEntered;

    const joined = workOperationResultSchema.parse(await value.service.execute({
      kind: "work.apply",
      requestId: crypto.randomUUID(),
      operation: {
        kind: "work.join",
        idempotencyKey: nextKey(),
        workId: created.work.id,
        coordinatorSessionId: coordinator.sessionId,
        coordinatorCapability: created.coordinatorCapability,
        actorSessionId: actor.sessionId,
      },
    }, { signal }));
    if (joined.kind !== "work.join") throw new Error("Expected the switching actor to join.");

    let claimFailure: unknown;
    try {
      await value.service.execute({
        kind: "work.apply",
        requestId: crypto.randomUUID(),
        operation: {
          kind: "task.claim",
          idempotencyKey: nextKey(),
          workId: created.work.id,
          taskId: created.tasks[0]!.id,
          expectedTaskRevision: created.tasks[0]!.revision,
          actorSessionId: actor.sessionId,
          actorCapability: joined.memberCapability,
          leaseMs: 5_000,
        },
      }, { signal });
    } catch (error: unknown) {
      claimFailure = error;
    }
    releaseTargetStart();
    const switched = await switchPromise as { session: { profileId: ProfileId } };

    expect(claimFailure).toBeInstanceOf(CommandFailure);
    expect(claimFailure).toMatchObject({
      code: "CONFLICT",
      details: { reason: "ROUTE_MISMATCH" },
    });
    expect(value.workStore.snapshot(created.work.id).tasks[0]?.status).toBe("ready");
    expect(value.store.readMutation(switchKey)).toMatchObject({ state: "applied" });
    expect(switched.session.profileId).toBe(actor.accountId);
    expect(value.store.requireSession(actor.sessionId).preset).toBe("low");
    expect(value.runtime.startSessionCount).toBe(startsBefore + 1);
    expect(value.runtime.startTurnCalls).toHaveLength(1);
    expect(value.runtime.endSessionCount).toBe(1);
  });

  test("lets an effect-started cross-account provider switch fence a competing Work claim", async () => {
    const value = await fixture();
    const actor = await createActor(value);
    const coordinator = await createSiblingActor(value, actor);
    const { created } = await createAndJoin(value, coordinator);
    const target = await value.service.execute(
      { kind: "account.add", label: "Concurrent switch target" },
      { signal },
    ) as { account: { id: ProfileId } };
    await value.service.execute(
      { kind: "account.login", account: target.account.id, deviceCode: false },
      { signal },
    );
    let enterTargetStart = (): void => {};
    const targetStartEntered = new Promise<void>((resolve) => { enterTargetStart = resolve; });
    let releaseTargetStart = (): void => {};
    const targetStartGate = new Promise<void>((resolve) => { releaseTargetStart = resolve; });
    value.runtime.beforeStartSessionReturn = async () => {
      delete value.runtime.beforeStartSessionReturn;
      enterTargetStart();
      await targetStartGate;
    };
    const startsBefore = value.runtime.startSessionCount;
    const switchKey = nextKey();
    const switchPromise = value.service.execute({
      kind: "session.switch",
      account: target.account.id,
      idempotencyKey: switchKey,
      presetContract: currentPresetContract,
      provider: "codex",
      session: actor.sessionId,
    }, { signal });
    await targetStartEntered;

    const joined = workOperationResultSchema.parse(await value.service.execute({
      kind: "work.apply",
      requestId: crypto.randomUUID(),
      operation: {
        kind: "work.join",
        idempotencyKey: nextKey(),
        workId: created.work.id,
        coordinatorSessionId: coordinator.sessionId,
        coordinatorCapability: created.coordinatorCapability,
        actorSessionId: actor.sessionId,
      },
    }, { signal }));
    if (joined.kind !== "work.join") throw new Error("Expected the switching actor to join.");

    let claimFailure: unknown;
    try {
      await value.service.execute({
        kind: "work.apply",
        requestId: crypto.randomUUID(),
        operation: {
          kind: "task.claim",
          idempotencyKey: nextKey(),
          workId: created.work.id,
          taskId: created.tasks[0]!.id,
          expectedTaskRevision: created.tasks[0]!.revision,
          actorSessionId: actor.sessionId,
          actorCapability: joined.memberCapability,
          leaseMs: 5_000,
        },
      }, { signal });
    } catch (error: unknown) {
      claimFailure = error;
    }
    releaseTargetStart();
    const switched = await switchPromise as { session: { profileId: ProfileId } };

    expect(claimFailure).toBeInstanceOf(CommandFailure);
    expect(claimFailure).toMatchObject({
      code: "CONFLICT",
      details: { reason: "ROUTE_MISMATCH" },
    });
    expect(value.workStore.snapshot(created.work.id).tasks[0]?.status).toBe("ready");
    expect(value.store.readMutation(switchKey)).toMatchObject({ state: "applied" });
    expect(switched.session.profileId).toBe(target.account.id);
    expect(value.runtime.startSessionCount).toBe(startsBefore + 1);
    expect(value.runtime.startTurnCalls).toHaveLength(1);
    expect(value.runtime.endSessionCount).toBe(1);
  });

  test.each(["provider_disconnect", "service_close"] as const)(
    "provider disconnect and service close atomically retire claimed, running, and recovery work: %s",
    (retirementMode) => ownedWorkServiceCase(async (value) => {
      const claimedActor = await createActor(value);
      const runningActor = await createSiblingActor(value, claimedActor);
      const recoveryActor = await createSiblingActor(value, claimedActor);
      const claimedWork = await createJoinClaim(value, claimedActor);
      const runningWork = await createJoinClaim(value, runningActor);
      const recoveryWork = await createJoinClaim(value, recoveryActor);

      const runningOperation = dispatchOperation(runningActor, runningWork);
      const running = workOperationResultSchema.parse(await value.service.execute({
        kind: "work.apply",
        requestId: crypto.randomUUID(),
        operation: runningOperation,
      }, { signal }));
      if (running.kind !== "attempt.dispatch") throw new Error("Expected a running dispatch.");

      const recoveryOperation = dispatchOperation(recoveryActor, recoveryWork);
      value.runtime.nextStartTurnError = new IndeterminateCodexEffectError(
        "turn/start",
        92,
      );
      let recoveryFailure: unknown;
      try {
        await value.service.execute({
          kind: "work.apply",
          requestId: crypto.randomUUID(),
          operation: recoveryOperation,
        }, { signal });
      } catch (error: unknown) {
        recoveryFailure = error;
      }
      expect(recoveryFailure).toBeInstanceOf(CommandFailure);
      expect((recoveryFailure as CommandFailure).code).toBe("RECOVERY_REQUIRED");
      const recoveryBefore = value.workStore.task(recoveryWork.created.tasks[0]!.id)
        .activeAttempt;
      expect(recoveryBefore).toMatchObject({
        id: recoveryWork.claimed.attempt.id,
        status: "unknown",
      });

      const profileBefore = value.store.requireProfileById(claimedActor.accountId);
      if (retirementMode === "provider_disconnect") {
        const owned = profilePaths(value.paths, profileBefore.id);
        const providerAuthority = value.store.requireProviderAccountAuthority(
          profileBefore.id,
          "codex",
        );
        await value.service.observeCodexFact({
          id: profileBefore.id,
          generation: profileBefore.processGeneration,
          codexHome: owned.codexHome,
          desktopUserData: owned.desktopUserData,
          provider: providerAuthority.provider,
          providerAccountId: providerAuthority.providerAccountId,
          bindingGeneration: providerAuthority.bindingGeneration,
        }, {
          type: "providerDisconnected",
          connectionId: "30000000-0000-4000-8000-000000000901",
          reason: "process_exit",
        });
      } else {
        await value.service.close();
      }

      expect(value.store.requireProfileById(claimedActor.accountId).processGeneration)
        .toBe(profileBefore.processGeneration + 1);
      expect(value.workStore.task(claimedWork.created.tasks[0]!.id)).toMatchObject({
        task: { status: "ready" },
        activeAttempt: null,
      });
      expect(value.workStore.task(runningWork.created.tasks[0]!.id).activeAttempt)
        .toMatchObject({
          id: runningWork.claimed.attempt.id,
          status: "unknown",
        });
      expect(value.workStore.task(recoveryWork.created.tasks[0]!.id).activeAttempt)
        .toMatchObject({
          id: recoveryWork.claimed.attempt.id,
          status: "unknown",
          revision: recoveryBefore?.revision,
        });
    }),
    // Two real stores and three actors: the default five-second deadline is
    // routinely exceeded on the macOS runners.
    30_000,
  );


  test("accepts queued and steered signals with exact nested receipts", async () => {
    const value = await fixture();
    const actor = await createActor(value);
    const { created, joined, claimed } = await createJoinClaim(value, actor);
    value.store.bumpAutorespondCounter(actor.sessionId);
    const dispatched = workOperationResultSchema.parse(await value.service.execute({
      kind: "work.apply",
      requestId: crypto.randomUUID(),
      operation: {
        kind: "attempt.dispatch",
        idempotencyKey: nextKey(),
        workId: created.work.id,
        attemptId: claimed.attempt.id,
        expectedAttemptRevision: claimed.attempt.revision,
        fence: claimed.attempt.fence,
        actorSessionId: actor.sessionId,
        attemptCapability: claimed.attemptCapability,
        targetSessionId: actor.sessionId,
        mode: "send",
      },
    }, { signal }));
    if (dispatched.kind !== "attempt.dispatch") throw new Error("Expected dispatch result.");
    expect(value.store.readAutorespondBudgets(actor.sessionId).consecutive).toBe(1);

    const queueKey = nextKey();
    const queued = workOperationResultSchema.parse(await value.service.execute({
      kind: "work.apply",
      requestId: crypto.randomUUID(),
      operation: {
        kind: "signal.send",
        idempotencyKey: queueKey,
        workId: created.work.id,
        senderSessionId: actor.sessionId,
        senderCapability: joined.memberCapability,
        targetSessionId: actor.sessionId,
        mode: "queue",
        body: "Inspect the durable result when the active turn completes.",
      },
    }, { signal }));
    if (queued.kind !== "signal.send") throw new Error("Expected queued signal result.");
    const queueEffect = value.workStore.preparedEffect(queueKey)?.effect;
    if (queueEffect?.kind !== "signal") throw new Error("Expected internal queue effect.");
    const queueMutation = value.store.readMutation(queueEffect.nestedMutationKey);
    const queueResult = queueMutation?.result as { queueId?: unknown } | undefined;
    if (typeof queueResult?.queueId !== "string") throw new Error("Expected queue id.");
    expect(value.store.queueMessageActor(queueResult.queueId as `queue_${string}`))
      .toBe("automation");
    expect(queued.signal).toMatchObject({
      deliveryState: "accepted",
      deliveryReceipt: {
        kind: "queue_created",
        mutationAttemptId: queueMutation?.id,
        accountGeneration: queued.signal.accountGeneration,
        queueId: queueResult.queueId,
      },
    });

    const steerKey = nextKey();
    const steered = workOperationResultSchema.parse(await value.service.execute({
      kind: "work.apply",
      requestId: crypto.randomUUID(),
      operation: {
        kind: "signal.send",
        idempotencyKey: steerKey,
        workId: created.work.id,
        senderSessionId: actor.sessionId,
        senderCapability: joined.memberCapability,
        targetSessionId: actor.sessionId,
        mode: "steer",
        body: "Recheck the adversarial authority boundary before reporting.",
      },
    }, { signal }));
    if (steered.kind !== "signal.send") throw new Error("Expected steered signal result.");
    const steerEffect = value.workStore.preparedEffect(steerKey)?.effect;
    if (steerEffect?.kind !== "signal") throw new Error("Expected internal steer effect.");
    const steerMutation = value.store.readMutation(steerEffect.nestedMutationKey);
    expect(value.runtime.steerCalls).toHaveLength(1);
    expect(value.runtime.steerCalls[0]?.clientMessageId).toBe(steerMutation?.id);
    expect(steered.signal).toMatchObject({
      deliveryState: "accepted",
      deliveryReceipt: {
        kind: "turn_steered",
        mutationAttemptId: steerMutation?.id,
        accountGeneration: steered.signal.accountGeneration,
        turnId: value.eventCursors.projectPublicProviderIdentifier("provider-turn-1"),
      },
    });
    expect(JSON.stringify(steered)).not.toContain("provider-turn-1");
    const automationMessages = value.store.listSessionEvents({
      afterSequence: 0,
      sessionId: actor.sessionId,
    }).events.filter((event) =>
      event.body.type === "user_message" && event.body.actor === "automation");
    expect(automationMessages).toHaveLength(2);
  });

  test("never replays an unknown dispatch and later reprojects exact recovery proof", async () => {
    const value = await fixture();
    const actor = await createActor(value);
    const { created, claimed } = await createJoinClaim(value, actor);
    const dispatchKey = nextKey();
    const dispatchOperation = {
      kind: "attempt.dispatch",
      idempotencyKey: dispatchKey,
      workId: created.work.id,
      attemptId: claimed.attempt.id,
      expectedAttemptRevision: claimed.attempt.revision,
      fence: claimed.attempt.fence,
      actorSessionId: actor.sessionId,
      attemptCapability: claimed.attemptCapability,
      targetSessionId: actor.sessionId,
      mode: "send",
    } as const;
    value.runtime.nextStartTurnError = new IndeterminateCodexEffectError(
      "turn/start",
      91,
    );

    let firstFailure: unknown;
    try {
      await value.service.execute({
        kind: "work.apply",
        requestId: crypto.randomUUID(),
        operation: dispatchOperation,
      }, { signal });
    } catch (error: unknown) {
      firstFailure = error;
    }
    expect(firstFailure).toBeInstanceOf(CommandFailure);
    expect((firstFailure as CommandFailure).code).toBe("RECOVERY_REQUIRED");
    expect(value.runtime.startTurnCalls).toHaveLength(1);

    const poll = workPollSchema.parse(await value.service.execute({
      kind: "work.poll",
      work: created.work.id,
      actor: actor.sessionId,
      limit: 50,
      waitMs: 0,
    }, { signal }));
    expect(poll.preparedEffects).toHaveLength(1);
    expect(poll.preparedEffects[0]).toMatchObject({
      idempotencyKey: dispatchKey,
      kind: "dispatch",
      state: "unknown",
      subjectId: claimed.attempt.id,
      targetSessionId: actor.sessionId,
    });
    expect(poll.recoveryAttempts.find((attempt) => attempt.id === claimed.attempt.id))
      .toMatchObject({
        id: claimed.attempt.id,
        status: "unknown",
        actorSessionId: actor.sessionId,
      });

    let replayFailure: unknown;
    try {
      await value.service.execute({
        kind: "work.apply",
        requestId: crypto.randomUUID(),
        operation: structuredClone(dispatchOperation),
      }, { signal });
    } catch (error: unknown) {
      replayFailure = error;
    }
    expect(replayFailure).toBeInstanceOf(CommandFailure);
    expect((replayFailure as CommandFailure).code).toBe("RECOVERY_REQUIRED");
    expect(value.runtime.startTurnCalls).toHaveLength(1);

    const [nestedMutation] = value.store.listUnsettledMutations({ sessionId: actor.sessionId });
    if (
      nestedMutation?.format !== "legacy"
      || nestedMutation.state !== "ambiguous"
      || nestedMutation.evidence?.evidence.kind !== "session.send"
    ) throw new Error("Expected one exact ambiguous session.send mutation.");
    const session = value.store.requireSession(actor.sessionId);
    if (session.providerThreadId === undefined) throw new Error("Expected a provider thread.");
    const prepared = value.workStore.preparedEffect(dispatchKey)?.effect;
    if (prepared?.kind !== "dispatch") throw new Error("Expected the exact dispatch effect.");
    const recoveredTurnId = "provider-turn-recovered";
    value.store.resolveSessionMutation({
      attemptId: nestedMutation.id,
      expectedOriginalState: "ambiguous",
      expectedEvidenceDigest: nestedMutation.evidence.digest,
      resolution: "proven_applied",
      resolutionEvidence: {
        kind: "session.send",
        clientMessageId: nestedMutation.id,
        turnId: recoveredTurnId,
        providerUpdatedAt: 20_000,
      },
      receipt: {
        turnId: recoveredTurnId,
        sourceId: nestedMutation.id,
        effectiveRuntimeProfile: nestedMutation.evidence.evidence.runtimeProfile,
      },
      message: workPreparedEffectMessage(prepared),
      provider: {
        providerThreadId: session.providerThreadId,
        title: session.title,
        status: "active",
        activeTurnId: recoveredTurnId,
        providerUpdatedAt: 20_000,
      },
    });

    const recovered = workOperationResultSchema.parse(await value.service.execute({
      kind: "work.apply",
      requestId: crypto.randomUUID(),
      operation: structuredClone(dispatchOperation),
    }, { signal }));
    if (recovered.kind !== "attempt.dispatch") throw new Error("Expected recovered dispatch.");
    expect(recovered.attempt).toMatchObject({
      id: claimed.attempt.id,
      status: "active",
      dispatchReceipt: {
        kind: "turn_started",
        mutationAttemptId: nestedMutation.id,
        accountGeneration: claimed.attempt.accountGeneration,
        turnId: value.eventCursors.projectPublicProviderIdentifier(recoveredTurnId),
      },
    });
    expect(value.runtime.startTurnCalls).toHaveLength(1);
  });
});
