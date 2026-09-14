import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { chmod, link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";

import { canonicalSha256, parseSha256Hex } from "@hraness/oh";

import { CLAUDE_HOST_TOOL_BRIDGE_ENTRYPOINT } from "../src/claude/host-tool-bridge";
import { digestClaudeHostToolInvocation } from "../src/claude/host-tool-protocol";
import { CLAUDE_PIN, CLAUDE_PIN_MODEL } from "../src/claude/pin";
import { claudeHostToolCallbackSocketPath } from "../src/daemon/claude-host-tool-transport";
import type { ClaudeProcessLivenessProbe } from "../src/daemon/personal-session-discovery";
import { OOMPA_SESSION_PREAMBLE } from "../src/domain/oompa-preamble";
import { createFactsMemoryBinding } from "../src/domain/facts-memory";
import { memoryPageContentDigest, memoryPageKeyDigest } from "../src/domain/memory-page";
import { claudeProviderAccountAuthoritySchema } from "../src/domain/provider-accounts";
import { PROJECT_MEMORY_EMPTY_HEAD } from "../src/domain/project-memory";
import { SESSION_CONVERSATION_AUTOMATION_CAPABILITY } from "../src/domain/session-tasks";
import { initializeStatePaths, profilePaths, resolveStatePaths } from "../src/storage/paths";
import { StateStore, MEMORY_SUBMISSION_RETAIN_AGE_MS } from "../src/storage/state-store";
import { OOMPA_VERSION } from "../src/version";
import { ClaudeLiveAcceptanceProofCollector } from "./claude-live-acceptance-proof";
import { createClaudeLiveAcceptanceReadback, type ClaudeLiveAcceptanceProcessInspectionInput } from "./claude-live-acceptance-readback";

const sha = (value: string) => {
  const digest = parseSha256Hex(createHash("sha256").update(value).digest("hex"));
  if (digest === null) throw new Error("fixture_digest_invalid");
  return digest;
};
type ReadbackCleanup = () => Promise<void>;
const cleanups: ReadbackCleanup[] = [];

function createOwnedReadbackCase() {
  const controller = new AbortController();
  const cancellation = new Error("Owned readback case is closing.");
  const ownedCleanups: ReadbackCleanup[] = [];
  const tasks: Array<Promise<{ status: "fulfilled" } | { status: "rejected"; reason: unknown }>> = [];
  let closing: Promise<void> | undefined;
  const request = async <T>(operation: () => Promise<T>): Promise<T> => {
    controller.signal.throwIfAborted();
    const result = await operation();
    controller.signal.throwIfAborted();
    return result;
  };
  return {
    request,
    registerCleanup: (cleanup: ReadbackCleanup): void => { ownedCleanups.push(cleanup); },
    run: <T>(operation: () => Promise<T>): Promise<T> => {
      // Register and observe the raw setup/test task before its callback runs.
      // Never join a finally wrapper that waits for this same owner's cleanup.
      const task = Promise.resolve().then(async () => await request(operation));
      tasks.push(task.then(
        () => ({ status: "fulfilled" } as const),
        (reason: unknown) => ({ status: "rejected", reason } as const),
      ));
      return task;
    },
    close: (): Promise<void> => {
      if (closing !== undefined) return closing;
      controller.abort(cancellation);
      closing = (async () => {
        const failures: unknown[] = [];
        for (const result of await Promise.all(tasks)) {
          // An operation may fail after cancellation; only our exact sentinel
          // is expected cleanup, never an actual late readback refusal.
          if (result.status === "rejected" && result.reason !== cancellation) failures.push(result.reason);
        }
        // Setup can register resources while it drains. This list belongs only
        // to this case, including if Bun times out its afterEach hook.
        for (const cleanup of ownedCleanups.splice(0).reverse()) {
          try { await cleanup(); } catch (error: unknown) { failures.push(error); }
        }
        if (failures.length > 0) throw new AggregateError(failures, "Owned readback teardown failed.");
      })();
      return closing;
    },
  };
}

function runOwnedReadbackSetup<T>(
  owner: ReturnType<typeof createOwnedReadbackCase>,
  setup: () => Promise<T>,
  publish: (value: T) => void,
): Promise<void> {
  // Return the exact observed task. An async hook awaiting this promise would
  // create another, unobserved promise that could reject after Bun timed out.
  return owner.run(async () => {
    const value = await owner.request(setup);
    // Cancellation may run between request resolution and this continuation.
    // The new request checks synchronously before invoking the publication.
    await owner.request(async () => { publish(value); });
  });
}

const ownedReadbackCases: Array<ReturnType<typeof createOwnedReadbackCase>> = [];
afterEach(async () => {
  // Capture this case's owners before awaiting anything. A timed-out teardown
  // cannot take cleanup registrations from a subsequent test.
  const owners = ownedReadbackCases.splice(0);
  const unownedCleanups = cleanups.splice(0).reverse();
  const failures: unknown[] = [];
  for (const result of await Promise.allSettled(owners.map((owner) => owner.close()))) {
    if (result.status === "rejected") failures.push(result.reason);
  }
  for (const cleanup of unownedCleanups) {
    try { await cleanup(); } catch (error: unknown) { failures.push(error); }
  }
  if (failures.length > 0) throw new AggregateError(failures, "Readback teardown failed.");
});

describe("owned readback case lifecycle", () => {
  test("registers before deferred setup and cancels before opening resources", async () => {
    const owner = createOwnedReadbackCase();
    let opened = false;
    const setup = owner.run(async () => { opened = true; });
    const closing = owner.close();
    expect(owner.close()).toBe(closing);
    await closing;
    await expect(setup).rejects.toThrow("Owned readback case is closing.");
    expect(opened).toBe(false);
  });

  test.each(["cancellation", "late failure"] as const)(
    "returns the observed setup task and preserves %s without publishing late state",
    async (outcome) => {
      const owner = createOwnedReadbackCase();
      const nextOwner = createOwnedReadbackCase();
      const entered = Promise.withResolvers<undefined>();
      const release = Promise.withResolvers<undefined>();
      const lateFailure = new Error("late fixture creation failure");
      const events: string[] = [];
      let published = false;
      let rawTask: Promise<unknown> | undefined;
      const observedOwner = {
        ...owner,
        run: <T>(operation: () => Promise<T>): Promise<T> => {
          const task = owner.run(operation);
          rawTask = task;
          return task;
        },
      };
      nextOwner.registerCleanup(async () => { events.push("close-next-case"); });
      const hook = () => runOwnedReadbackSetup(observedOwner, async () => {
        entered.resolve(undefined);
        await release.promise;
        owner.registerCleanup(async () => { events.push("close-late-resource"); });
        if (outcome === "late failure") throw lateFailure;
        return "prepared";
      }, () => { published = true; });
      const task = hook();
      expect<Promise<unknown> | undefined>(task).toBe(rawTask);
      await entered.promise;
      const closing = owner.close().catch((error: unknown) => error);
      await Promise.resolve();
      expect(events).toEqual([]);
      release.resolve(undefined);
      if (outcome === "late failure") {
        await expect(task).rejects.toBe(lateFailure);
        const error = await closing;
        expect(error).toBeInstanceOf(AggregateError);
        if (!(error instanceof AggregateError)) throw new Error("Expected the original late fixture failure.");
        expect(error.errors).toEqual([lateFailure]);
      } else {
        await expect(task).rejects.toThrow("Owned readback case is closing.");
        expect(await closing).toBeUndefined();
      }
      expect(published).toBe(false);
      expect(events).toEqual(["close-late-resource"]);
      await nextOwner.close();
      expect(events).toEqual(["close-late-resource", "close-next-case"]);
    },
  );

  test("drains a paused negative readback and its probe assertions before closing storage", async () => {
    const owner = createOwnedReadbackCase();
    const entered = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    const refusal = new Error("expected final-probe readback refusal");
    const events: string[] = [];
    let storageClosed = false;
    let probes = 0;
    owner.registerCleanup(async () => { storageClosed = true; events.push("close-storage"); });
    const task = owner.run(async () => {
      await owner.request(async () => {
        const readback = (async () => {
          entered.resolve(undefined);
          await release.promise;
          expect(storageClosed).toBe(false);
          probes = 2;
          throw refusal;
        })();
        await expect(readback).rejects.toBe(refusal);
        expect(probes).toBe(2);
        events.push("assertions-complete");
      });
      events.push("continued-after-close");
    });
    await entered.promise;
    const closing = owner.close();
    await Promise.resolve();
    expect(storageClosed).toBe(false);
    release.resolve(undefined);
    await closing;
    await expect(task).rejects.toThrow("Owned readback case is closing.");
    expect(events).toEqual(["assertions-complete", "close-storage"]);
  });

  test("cancels between setup request completion and publication without publishing", async () => {
    const owner = createOwnedReadbackCase();
    const boundary = Promise.withResolvers<undefined>();
    let closing: Promise<void> | undefined;
    let observedSetup = false;
    let published = false;
    const observedOwner = {
      ...owner,
      request: <T>(operation: () => Promise<T>): Promise<T> => {
        const task = owner.request(operation);
        if (!observedSetup) {
          observedSetup = true;
          // This reaction is registered before the helper awaits the same
          // promise, after the request's own post-operation cancellation check.
          void task.then(() => {
            closing = owner.close();
            boundary.resolve(undefined);
          }, (error: unknown) => { boundary.reject(error); });
        }
        return task;
      },
    };
    const task = runOwnedReadbackSetup(observedOwner, async () => "prepared", () => { published = true; });
    await boundary.promise;
    await expect(task).rejects.toThrow("Owned readback case is closing.");
    if (closing === undefined) throw new Error("Expected cancellation at the publication boundary.");
    await closing;
    expect(published).toBe(false);
  });

  test.each(["setup", "test"] as const)("joins paused raw %s work before its late-registered cleanup", async (phase) => {
    const owner = createOwnedReadbackCase();
    const nextOwner = createOwnedReadbackCase();
    const entered = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    const events: string[] = [];
    owner.registerCleanup(async () => { events.push("close-initial"); });
    nextOwner.registerCleanup(async () => { events.push("close-next-case"); });
    if (phase === "test") await owner.run(async () => undefined);
    const task = owner.run(async () => {
      await owner.request(async () => {
        entered.resolve(undefined);
        await release.promise;
        events.push("raw-settled");
        owner.registerCleanup(async () => { events.push("close-late"); });
      });
      events.push("continued-after-close");
    });
    await entered.promise;
    const closing = owner.close();
    await Promise.resolve();
    expect(events).toEqual([]);
    release.resolve(undefined);
    await closing;
    await expect(task).rejects.toThrow("Owned readback case is closing.");
    expect(events).toEqual(["raw-settled", "close-late", "close-initial"]);
    await nextOwner.close();
    expect(events).toEqual(["raw-settled", "close-late", "close-initial", "close-next-case"]);
  });

  test("retains late operation failures and attempts every cleanup after raw work settles", async () => {
    const owner = createOwnedReadbackCase();
    const entered = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    const lateFailure = new Error("late readback refusal");
    const cleanupFailure = new Error("socket collection failed");
    const events: string[] = [];
    owner.registerCleanup(async () => { events.push("close-root"); });
    owner.registerCleanup(async () => { events.push("close-socket"); throw cleanupFailure; });
    const task = owner.run(async () => {
      await owner.request(async () => {
        entered.resolve(undefined);
        await release.promise;
        events.push("raw-failed");
        throw lateFailure;
      });
    });
    await entered.promise;
    const closing = owner.close().catch((error: unknown) => error);
    await Promise.resolve();
    expect(events).toEqual([]);
    release.resolve(undefined);
    const error = await closing;
    expect(error).toBeInstanceOf(AggregateError);
    if (!(error instanceof AggregateError)) throw new Error("Expected every teardown failure.");
    expect(error.errors).toEqual([lateFailure, cleanupFailure]);
    expect(error.errors[0]).toBe(lateFailure);
    await expect(task).rejects.toBe(lateFailure);
    expect(events).toEqual(["raw-failed", "close-socket", "close-root"]);
  });
});

// Deliberately differ from the sibling Codex generation; never borrow its counter.
const admitClaude = (store: StateStore, profileId: Parameters<StateStore["requireProfile"]>[0]) => {
  store.advanceProviderAccountProcessGeneration({ profileId, provider: "claude", expectedProcessGeneration: 0 });
  const authority = claudeProviderAccountAuthoritySchema.parse(store.advanceProviderAccountProcessGeneration({
    profileId, provider: "claude", expectedProcessGeneration: 1,
  }));
  store.observeProviderAccountReadiness({ profileId, provider: "claude",
    expectedBindingGeneration: authority.bindingGeneration, readiness: "signed_in" });
  // Readiness changes the binding generation independently of process identity.
  return claudeProviderAccountAuthoritySchema.parse(store.requireProviderAccountAuthority(profileId, "claude"));
};

// Real current-schema StateStore records and private filesystem artifacts.
// OS liveness and argv observations are typed deterministic fixtures; no provider is launched.
const fixture = async (registerCleanup: (cleanup: ReadbackCleanup) => void = (cleanup) => { cleanups.push(cleanup); }) => {
  // A short Unix temporary root keeps the real callback socket below sun_path's bound.
  const temporaryRoot = await mkdtemp("/tmp/oompa-clrb-");
  registerCleanup(async () => { await rm(temporaryRoot, { recursive: true }); });
  const root = await realpath(temporaryRoot);
  const paths = resolveStatePaths({ rootDirectory: root });
  await initializeStatePaths(paths);
  const store = new StateStore(paths);
  registerCleanup(async () => { store.close(); });
  const socketPath = claudeHostToolCallbackSocketPath(paths);
  const server = createServer();
  let socketClosed = false;
  const closeSocket = async () => {
    if (socketClosed) return;
    socketClosed = true;
    await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  };
  registerCleanup(async () => { if (server.listening) await closeSocket(); });
  const bootId = `boot_${randomUUID().replaceAll("-", "")}`;
  const daemonGeneration = store.nextDaemonGeneration(bootId);
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { mode: 0o700 });
  const project = await store.createProject("Readback test", projectRoot, true);
  const createdProfile = store.createProfile("Readback test");
  const profile = store.nextProfileGeneration(createdProfile.id);
  const providerAuthority = admitClaude(store, profile.id);
  const runtime = {
    profileId: profile.id, processGeneration: providerAuthority.processGeneration, observedAt: Date.now(),
    preset: "fable-max" as const, model: CLAUDE_PIN_MODEL, reasoningEffort: "max" as const,
    claudeVersion: CLAUDE_PIN, permissionMode: "default" as const, configHome: "isolated" as const,
    inputFormat: "stream-json" as const, outputFormat: "stream-json" as const,
  };
  const startIdempotencyKey = randomUUID();
  const sendIdempotencyKey = randomUUID();
  const start = store.prepareMutation({ kind: "session.start", authorityId: profile.id,
    authorityGeneration: providerAuthority.processGeneration, idempotencyKey: startIdempotencyKey,
    request: { projectId: project.id, provider: "claude", preset: "fable-max", fast: false } });
  const session = store.beginSessionStartEffect({ providerAuthority, attemptId: start.id, profileId: profile.id,
    profileGeneration: providerAuthority.processGeneration, projectId: project.id, provider: "claude", preset: "fable-max",
    fastEnabled: false, providerAccountKey: `v1:claude:${sha("test account")}`,
    providerAuthentication: { profileId: profile.id, processGeneration: providerAuthority.processGeneration, provider: "claude", signedIn: true },
    evidence: { kind: "session.start", projectId: project.id, clientMessageId: null, messageDigest: null,
      runtimeProfile: runtime, conversationAutomationCapability: SESSION_CONVERSATION_AUTOMATION_CAPABILITY },
    hostCapabilities: { preambleVersion: OOMPA_SESSION_PREAMBLE.version, preambleDigest: OOMPA_SESSION_PREAMBLE.digest,
      manifestVersion: OOMPA_SESSION_PREAMBLE.manifestVersion, manifestDigest: OOMPA_SESSION_PREAMBLE.manifestDigest },
  });
  const threadId = randomUUID();
  const turnId = randomUUID();
  const connectionId = randomUUID();
  const identity = { pid: 40001, pidDomain: "linux" as const, procStart: "readback-test-child" };
  store.recordClaimedClaudeProcessAuthority({ providerAuthority, providerThreadId: threadId, profileId: profile.id,
    profileGeneration: profile.processGeneration, runtimeScope: "managed", sessionId: session.id, identity });
  store.completeSessionStartEffect({ providerAuthority, attemptId: start.id, sessionId: session.id,
    expectedSessionRevision: session.revision, providerThreadId: threadId, state: "idle",
    runtimeProfile: runtime, claudeProcessIdentity: identity,
    receipt: { sessionId: session.id, effectiveRuntimeProfile: runtime } });
  const sendText = "Remember the exact test nonce and echo the returned receipt.";
  const { attempt: send } = store.prepareSessionInputMutation({ kind: "session.send", sessionId: session.id,
    providerAuthority, idempotencyKey: sendIdempotencyKey, message: sendText, attachments: [],
    daemonGeneration, bootId });
  store.beginSessionMutationEffect({ providerAuthority, attemptId: send.id, sessionId: session.id, profileGeneration: providerAuthority.processGeneration,
    attachments: [], daemonGeneration, bootId,
    transcript: { accountId: profile.id, providerGeneration: providerAuthority.processGeneration,
      providerConnectionId: connectionId, actor: "human", message: sendText },
    message: sendText, evidence: { kind: "session.send", providerThreadId: threadId,
      baseline: { status: "idle", activeTurnId: null, providerUpdatedAt: null },
      clientMessageId: send.id, messageDigest: sha(sendText), runtimeProfile: runtime, messageActor: "human" } });
  store.completeSessionTurnEffect({ providerAuthority, attemptId: send.id, sessionId: session.id, accountId: profile.id,
    providerGeneration: providerAuthority.processGeneration, providerConnectionId: connectionId,
    expectedSessionRevision: store.requireSession(session.id).revision, applyResponseState: true,
    turnId, turnStatus: "completed", runtimeProfile: runtime, message: sendText,
    receipt: { turnId, status: "completed", effectiveRuntimeProfile: runtime } });
  const runId = randomUUID();
  const memory = { body: `Acceptance nonce ${runId}.`, key: `acceptance/${runId}`,
    summary: "Synthetic acceptance memory.", title: "Acceptance memory" };
  const bindingId = `clhb_${randomUUID().replaceAll("-", "")}`;
  const callId = randomUUID();
  const request = { tool: "memory_remember", input: memory } as const;
  const requestDigest = digestClaudeHostToolInvocation(callId, request);
  const keyBytes = createHash("sha256").update([
    "hra:host-tool-call:v1", profile.id, threadId, turnId, callId, "memory_remember",
  ].join("\0")).digest();
  keyBytes[6] = (keyBytes[6] ?? 0) & 15 | 80;
  keyBytes[8] = (keyBytes[8] ?? 0) & 63 | 128;
  const hex = keyBytes.toString("hex");
  const memoryIdempotencyKey = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
  const submission = store.prepareMemorySubmission({ actorSessionId: session.id, projectId: project.id,
    kind: "remember", requestDigest, contentDigest: memoryPageContentDigest(memory), keyDigest: memoryPageKeyDigest(memory.key),
    workingBindingDigest: createFactsMemoryBinding({ ownerId: profile.id, sessionId: session.id }).bindingDigest,
    workingEpoch: 1, expectedHead: PROJECT_MEMORY_EMPTY_HEAD,
    idempotencyKey: memoryIdempotencyKey }).record;
  const attestedAt = new Date(submission.createdAt).toISOString();
  const actorId = "readback-test-actor";
  const attestationSha256 = canonicalSha256({ actorId, actorSessionId: session.id, attestedAt,
    contentDigest: submission.contentDigest, domain: "hra.memory.host-attestation.v1",
    idempotencyKeySha256: canonicalSha256({ idempotencyKey: memoryIdempotencyKey, v: 1 }),
    keyDigest: submission.keyDigest, projectId: project.id, requestDigest, submissionId: submission.id, v: 1,
    workingBindingDigest: submission.workingBindingDigest, workingEpoch: 1 });
  const recordSha256 = sha("test record");
  const operationSha256 = sha("test operation");
  const receiptSha256 = sha("test receipt");
  const headDigest = sha("test head");
  store.bindMemorySubmissionEffect({ submissionId: submission.id, attestationSha256, effectRecordSha256: recordSha256,
    operationId: "readback-test-operation" });
  store.beginMemorySubmission(submission.id);
  store.settleMemorySubmission({ submissionId: submission.id, expectedState: "effect_started", state: "applied",
    outcomeCode: "remember_committed", receiptDigest: receiptSha256,
    resultHead: { sequence: 1, operationSha256, headDigest } });
  const result = { version: 1, ok: true, replay: false,
    idempotencyRetainedUntil: new Date(store.requireMemorySubmission(submission.id).updatedAt + MEMORY_SUBMISSION_RETAIN_AGE_MS).toISOString(),
    submission: { id: submission.id, kind: "remember", state: "applied" },
    page: { key: memory.key, recordSha256, operationSha256 }, receiptSha256,
    workingHead: { digest: headDigest, operationSha256, sequence: 1 } } as const;
  const collector = new ClaudeLiveAcceptanceProofCollector({ runId,
    candidate: { cloudTargetDigest: sha("test cloud"), packageVersion: OOMPA_VERSION, sourceRevision: "1".repeat(40) } });
  collector.beginDaemonGeneration(daemonGeneration);
  collector.armFreshSession({ daemonGeneration, memory, profileGeneration: providerAuthority.processGeneration, profileId: profile.id,
    providerThreadId: threadId, sendIdempotencyKey, sessionId: session.id });
  const profileDirectories = profilePaths(paths, profile.id);
  await collector.handleManagedHostToolCall({ authority: { id: profile.id, generation: providerAuthority.processGeneration,
    provider: "claude", providerAccountId: providerAuthority.providerAccountId, bindingGeneration: providerAuthority.bindingGeneration,
    codexHome: profileDirectories.codexHome, desktopUserData: profileDirectories.desktopUserData },
    call: { authority: providerAuthority,
      callId, connectionId, threadId, turnId, requestId: { type: "string", value: callId }, requestDigest,
      tool: "memory_remember", input: memory }, dispatch: async () => result });
  collector.corroborateAppliedSend({ daemonGeneration, idempotencyKey: sendIdempotencyKey, sessionId: session.id, turnId });
  collector.handleManagedHostToolResponseWritten({ bindingId, callId, profileId: profile.id,
    processGeneration: providerAuthority.processGeneration, provider: "claude", providerThreadId: threadId, request, requestDigest });
  const receipt = collector.readProvisionalPrivateReceipt();
  const directory = await mkdtemp(join(paths.runtime, ".oompa-claude-host-tools-"));
  const bindingPath = join(directory, "binding.json");
  const configPath = join(directory, "mcp.json");
  const binding = { bindingId, callbackSocketPath: socketPath, capability: "a".repeat(43), version: 1 };
  await writeFile(bindingPath, JSON.stringify(binding), { mode: 0o600 });
  const config = { mcpServers: { hra: { args: [CLAUDE_HOST_TOOL_BRIDGE_ENTRYPOINT, "--binding", bindingPath],
    command: process.execPath, type: "stdio" } } };
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  await new Promise<void>((ready, reject) => { server.once("error", reject); server.listen(socketPath, ready); });
  await chmod(socketPath, 0o600);
  const workingQuery = { version: 1, ok: true, mode: "get", sessionId: session.id,
    queryId: `memq_${randomUUID().replaceAll("-", "")}`, rows: [{ row: 0, lane: "working", key: memory.key,
      recordSha256, title: memory.title, summary: memory.summary, language: null, createdAt: attestedAt, updatedAt: attestedAt,
      provenance: { kind: "host-attested", attestedAt, actorId, attestationSha256, verification: "local-ledger-verified" },
      bodyChunk: memory.body, chunkCount: 1, chunkIndex: 0 }], continuation: null, conflicts: [],
    page: { completeness: "complete", endExclusive: 1, hasMore: false, pageSize: 2, returnedRows: 1, start: 0, totalRows: 1 },
    scope: "working", canonicalHead: null, canonical: { included: false, frozen: false, diagnosticCode: null, syncState: null },
    workingHead: result.workingHead };
  const memoryStatus = { version: 1, ok: true, sessionId: session.id, projectId: project.id, unsettledSubmission: null,
    working: { state: "active", ownerMatchesSession: true, bindingDigest: submission.workingBindingDigest,
      epoch: 1, head: result.workingHead },
    canonical: { initialized: false, physicalState: null, identityContract: null, authorityDigest: null,
      bindingDigest: null, expectedHead: null, syncState: null, frozen: false, diagnosticCode: null,
      revision: null, lastExchangeAt: null, lastExchangeHead: null } };
  const input = { receipt, projectId: project.id, startIdempotencyKey, sendIdempotencyKey,
    sendText, claudeAuthentication: { signedIn: true as const }, workingQuery, memoryStatus };
  let liveness: "live" | "not_live" | "unknown" = "live";
  let processObservation: (() => void) | undefined;
  const processProbe: ClaudeProcessLivenessProbe = async (observed) => {
    expect(observed).toEqual(identity);
    processObservation?.();
    return liveness;
  };
  const oracle = (inspect?: (input: ClaudeLiveAcceptanceProcessInspectionInput) => Promise<void>) => createClaudeLiveAcceptanceReadback({ paths, signal: new AbortController().signal, processProbe,
    inspectLiveProcess: async (input) => {
      expect(input.identity).toEqual(identity);
      expect(input.configPath).toBe(configPath);
      await inspect?.(input);
      return { pinnedArgv: true, argvDigest: sha("deterministic argv observation") };
    } });
  const stop = async () => {
    const process = store.readSessionClaudeProcessAuthority(session.id);
    if (process === null) throw new Error("fixture process missing");
    const releasing = store.beginClaudeProcessAuthorityRelease({ profileId: profile.id, runtimeScope: "managed",
      providerThreadId: threadId, expectedRevision: process.revision, identity });
    store.completeClaudeProcessAuthorityRelease({ profileId: profile.id, runtimeScope: "managed",
      providerThreadId: threadId, expectedRevision: releasing.revision, identity });
    store.advanceProviderAccountProcessGeneration({ profileId: profile.id, provider: "claude",
      expectedProcessGeneration: providerAuthority.processGeneration });
    await closeSocket();
    await rm(directory, { recursive: true });
    liveness = "not_live";
    collector.closeDaemonGeneration(daemonGeneration);
    return collector.readPrivateReceipt();
  };
  return { root, paths, store, input, oracle, stop, directory, bindingPath, configPath, binding, config,
    profile, providerAuthority, session, send, submission, setLiveness: (value: typeof liveness) => { liveness = value; },
    observeProcess: (observation: () => void) => { processObservation = observation; } };
};

const startOnlyFixture = async (registerCleanup: (cleanup: ReadbackCleanup) => void = (cleanup) => { cleanups.push(cleanup); }) => {
  const temporaryRoot = await mkdtemp("/tmp/oompa-clrb-start-");
  registerCleanup(async () => { await rm(temporaryRoot, { recursive: true }); });
  const root = await realpath(temporaryRoot);
  const paths = resolveStatePaths({ rootDirectory: root });
  await initializeStatePaths(paths);
  const store = new StateStore(paths);
  registerCleanup(async () => { store.close(); });
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { mode: 0o700 });
  const project = await store.createProject("Start recovery", projectRoot, true);
  const profile = store.nextProfileGeneration(store.createProfile("Start recovery").id);
  const providerAuthority = admitClaude(store, profile.id);
  const startIdempotencyKey = randomUUID();
  const input = { profileId: profile.id, projectId: project.id, startIdempotencyKey };
  const runtime = { profileId: profile.id, processGeneration: providerAuthority.processGeneration, observedAt: Date.now(),
    preset: "fable-max" as const, model: CLAUDE_PIN_MODEL, reasoningEffort: "max" as const,
    claudeVersion: CLAUDE_PIN, permissionMode: "default" as const, configHome: "isolated" as const,
    inputFormat: "stream-json" as const, outputFormat: "stream-json" as const };
  const prepare = () => store.prepareMutation({ kind: "session.start", authorityId: profile.id,
    authorityGeneration: providerAuthority.processGeneration, idempotencyKey: startIdempotencyKey,
    request: { projectId: project.id, provider: "claude", preset: "fable-max", fast: false } });
  const apply = () => {
    const start = prepare();
    const session = store.beginSessionStartEffect({ providerAuthority, attemptId: start.id, profileId: profile.id,
      profileGeneration: providerAuthority.processGeneration, projectId: project.id, provider: "claude", preset: "fable-max",
      fastEnabled: false, providerAccountKey: `v1:claude:${sha("start recovery account")}`,
      providerAuthentication: { profileId: profile.id, processGeneration: providerAuthority.processGeneration, provider: "claude", signedIn: true },
      evidence: { kind: "session.start", projectId: project.id, clientMessageId: null, messageDigest: null,
        runtimeProfile: runtime, conversationAutomationCapability: SESSION_CONVERSATION_AUTOMATION_CAPABILITY },
      hostCapabilities: { preambleVersion: OOMPA_SESSION_PREAMBLE.version, preambleDigest: OOMPA_SESSION_PREAMBLE.digest,
        manifestVersion: OOMPA_SESSION_PREAMBLE.manifestVersion, manifestDigest: OOMPA_SESSION_PREAMBLE.manifestDigest } });
    const providerThreadId = randomUUID();
    const identity = { pid: 40002, pidDomain: "linux" as const, procStart: "synthetic-start-recovery" };
    store.recordClaimedClaudeProcessAuthority({ providerAuthority, providerThreadId, profileId: profile.id,
      profileGeneration: profile.processGeneration, runtimeScope: "managed", sessionId: session.id, identity });
    store.completeSessionStartEffect({ providerAuthority, attemptId: start.id, sessionId: session.id, expectedSessionRevision: session.revision,
      providerThreadId, state: "idle", runtimeProfile: runtime, claudeProcessIdentity: identity,
      receipt: { sessionId: session.id, effectiveRuntimeProfile: runtime } });
    const release = () => {
      const process = store.readSessionClaudeProcessAuthority(session.id);
      if (process === null) throw new Error("fixture_start_process_missing");
      const releasing = store.beginClaudeProcessAuthorityRelease({ profileId: profile.id, runtimeScope: "managed",
        providerThreadId, expectedRevision: process.revision, identity });
      store.completeClaudeProcessAuthorityRelease({ profileId: profile.id, runtimeScope: "managed",
        providerThreadId, expectedRevision: releasing.revision, identity });
      store.advanceProviderAccountProcessGeneration({ profileId: profile.id, provider: "claude",
      expectedProcessGeneration: providerAuthority.processGeneration });
    };
    return { session, start, release };
  };
  const oracle = (signal = new AbortController().signal) => createClaudeLiveAcceptanceReadback({ paths, signal,
    inspectLiveProcess: async () => { throw new Error("scope_recovery_must_not_inspect_argv"); },
    processProbe: async () => { throw new Error("scope_recovery_must_not_claim_liveness"); } });
  return { input, profile, providerAuthority, paths, store, prepare, apply, oracle };
};

describe("independent Claude private readback", () => {
  test("lost-start scope returns null only for a proved no-effect fresh profile", async () => {
    const f = await startOnlyFixture();
    expect(await f.oracle().recoverStartedSessionScope(f.input)).toBeNull();
    f.prepare();
    await expect(f.oracle().recoverStartedSessionScope(f.input)).rejects.toThrow("claude_live_acceptance_readback_refused");
  });

  describe("coupled start-scope recovery", () => {
    let prepared: Readonly<{ owner: ReturnType<typeof createOwnedReadbackCase>; fixture: Awaited<ReturnType<typeof startOnlyFixture>> }> | undefined;
    beforeEach(() => {
      prepared = undefined;
      const owner = createOwnedReadbackCase();
      ownedReadbackCases.push(owner);
      // Keep fresh database setup separate from the complete before/after
      // recovery proof, which retains one five-second test deadline.
      return runOwnedReadbackSetup(owner, () => startOnlyFixture(owner.registerCleanup), (value) => {
        prepared = { owner, fixture: value };
      });
    }, 5_000);

    test("recovers only exact direct-applied start scope before and after process release", () => {
      if (prepared === undefined) throw new Error("Owned start-scope fixture is not ready.");
      const { owner, fixture: f } = prepared;
      return owner.run(async () => {
        const started = f.apply();
        expect(f.providerAuthority.processGeneration).not.toBe(f.profile.processGeneration);
        expect(f.store.readSessionClaudeProcessAuthority(started.session.id)).toMatchObject({
          profileGeneration: f.profile.processGeneration, providerAuthority: f.providerAuthority, state: "bound",
        });
        const expected = { sessionId: started.session.id, profileGeneration: f.providerAuthority.processGeneration };
        const first = f.oracle();
        const scope = await owner.request(() => first.recoverStartedSessionScope(f.input));
        expect(scope).toEqual(expected);
        expect(Object.isFrozen(scope)).toBe(true);
        await owner.request(async () => {
          await expect(first.recoverStartedSessionScope(f.input)).rejects.toThrow("claude_live_acceptance_readback_refused");
        });
        started.release();
        expect(f.store.readSessionClaudeProcessAuthority(started.session.id, true)).toMatchObject({
          profileGeneration: f.profile.processGeneration, providerAuthority: f.providerAuthority, state: "released",
        });
        const stopped = f.oracle();
        expect(await owner.request(() => stopped.recoverStartedSessionScope(f.input))).toEqual(expected);
        expect(scope).not.toHaveProperty("processNotLive");
        expect(scope).not.toHaveProperty("soleRemember");
      });
    }, 5_000);
  });

  test.each(["foreign key", "foreign profile", "foreign project", "extra fields"] as const)(
    "lost-start scope refuses %s", async (mismatch) => {
      const f = await startOnlyFixture(); f.apply();
      const otherProfile = f.store.createProfile("Other scope");
      await mkdir(join(f.paths.root, "other-project"), { mode: 0o700 });
      const otherProject = await f.store.createProject("Other project", join(f.paths.root, "other-project"), false);
      const input = {
        "foreign key": { ...f.input, startIdempotencyKey: randomUUID() },
        "foreign profile": { ...f.input, profileId: otherProfile.id },
        "foreign project": { ...f.input, projectId: otherProject.id },
        "extra fields": { ...f.input, extra: true },
      }[mismatch];
      await expect(f.oracle().recoverStartedSessionScope(input)).rejects.toThrow("claude_live_acceptance_readback_refused");
    },
  );

  test("lost-start scope refuses changed generation after process release", async () => {
    const f = await startOnlyFixture(); const started = f.apply();
    started.release();
    f.store.advanceProviderAccountProcessGeneration({ profileId: f.profile.id, provider: "claude",
      expectedProcessGeneration: f.providerAuthority.processGeneration + 1 });
    await expect(f.oracle().recoverStartedSessionScope(f.input)).rejects.toThrow("claude_live_acceptance_readback_refused");
  });

  test("lost-start scope refuses a later send instead of adopting its session", async () => {
    const f = await fixture();
    await expect(f.oracle().recoverStartedSessionScope({ profileId: f.profile.id, projectId: f.input.projectId,
      startIdempotencyKey: f.input.startIdempotencyKey })).rejects.toThrow("claude_live_acceptance_readback_refused");
  });

  test("lost-start scope brackets authority changes between the two readonly snapshots", async () => {
    const f = await startOnlyFixture(); const started = f.apply(); started.release();
    const signal = new AbortController().signal;
    const original = signal.throwIfAborted.bind(signal);
    let checks = 0;
    Object.defineProperty(signal, "throwIfAborted", { value: () => {
      original();
      if (++checks === 3) f.store.advanceProviderAccountProcessGeneration({ profileId: f.profile.id, provider: "claude",
      expectedProcessGeneration: f.providerAuthority.processGeneration + 1 });
    } });
    await expect(f.oracle(signal).recoverStartedSessionScope(f.input)).rejects.toThrow("claude_live_acceptance_readback_refused");
    expect(checks).toBeGreaterThanOrEqual(3);
  });

  describe("coupled live-to-stopped readback", () => {
    let prepared: Readonly<{ owner: ReturnType<typeof createOwnedReadbackCase>; fixture: Awaited<ReturnType<typeof fixture>> }> | undefined;
    beforeEach(() => {
      prepared = undefined;
      const owner = createOwnedReadbackCase();
      ownedReadbackCases.push(owner);
      // A separate, fresh 5-second setup budget is deliberate. The complete
      // same-oracle live-to-stopped proof still has one 5-second test deadline.
      return runOwnedReadbackSetup(owner, () => fixture(owner.registerCleanup), (value) => {
        prepared = { owner, fixture: value };
      });
    }, 5_000);

    test("corroborates real durable rows and exact artifacts before and after shutdown", () => {
      if (prepared === undefined) throw new Error("Owned readback fixture is not ready.");
      const { owner, fixture: f } = prepared;
      return owner.run(async () => {
        expect(f.store.requireProfile(f.profile.id).state).toBe("signed_out");
        expect(f.providerAuthority.processGeneration).not.toBe(f.profile.processGeneration);
        expect(f.store.requireProviderAccountForProfile(f.profile.id, "claude").readiness).toBe("signed_in");
        expect(f.store.readSessionClaudeProcessAuthority(f.session.id)).toMatchObject({
          profileGeneration: f.profile.processGeneration, providerAuthority: f.providerAuthority, state: "bound",
        });
        const oracle = f.oracle();
        const live = await owner.request(async () => await oracle.captureLive(f.input));
        expect(live).toMatchObject({ phase: "live", soleRemember: true, managedClaudeSignedIn: true,
          proofBindingDigest: f.input.receipt.candidateBindingDigest });
        const receipt = await owner.request(f.stop);
        const stopped = await owner.request(async () => await oracle.verifyStopped({ receipt }));
        expect(f.store.readSessionClaudeProcessAuthority(f.session.id, true)).toMatchObject({
          profileGeneration: f.profile.processGeneration, providerAuthority: f.providerAuthority, state: "released",
        });
        expect(stopped).toMatchObject({ phase: "stopped", snapshotDigest: live.snapshotDigest,
          processReleased: true, processNotLive: true, privateArtifactsAbsent: true, lifecycleInvalidated: true });
        expect(JSON.stringify(stopped)).not.toContain(f.root);
        expect(JSON.stringify(stopped)).not.toContain(f.session.id);
        expect(JSON.stringify(stopped)).not.toContain("40001");
        await owner.request(async () => {
          await expect(oracle.verifyStopped({ receipt: { ...f.input.receipt, lifecycleInvalidated: true } }))
            .rejects.toThrow("claude_live_acceptance_readback_refused");
        });
      });
    }, 5_000);

    test("a sibling Codex generation change does not impersonate Claude lifecycle invalidation", () => {
      if (prepared === undefined) throw new Error("Owned readback fixture is not ready.");
      const { owner, fixture: f } = prepared;
      return owner.run(async () => {
        const originalProcess = f.store.readSessionClaudeProcessAuthority(f.session.id);
        expect(originalProcess).toMatchObject({
          profileGeneration: f.profile.processGeneration, providerAuthority: f.providerAuthority, state: "bound",
        });
        const oracle = f.oracle(async () => {
          f.store.advanceProfileGeneration(f.profile.id, f.profile.processGeneration);
        });
        const live = await owner.request(async () => await oracle.captureLive(f.input));
        expect(f.store.requireProfile(f.profile.id).processGeneration).toBe(f.profile.processGeneration + 1);
        expect(f.store.readSessionClaudeProcessAuthority(f.session.id)).toEqual(originalProcess);
        expect(f.store.requireProviderAccountAuthority(f.profile.id, "claude")).toEqual(f.providerAuthority);
        const receipt = await owner.request(f.stop);
        expect(await owner.request(async () => await oracle.verifyStopped({ receipt }))).toMatchObject({
          phase: "stopped", snapshotDigest: live.snapshotDigest,
        });
        // The extra tuple checks are private admission, not retroactive V1 fields.
        expect(live.version).toBe(1);
        expect(live).not.toHaveProperty("providerAccountId");
        expect(live).not.toHaveProperty("bindingGeneration");
      });
    }, 5_000);

    test("freezes caller evidence before asynchronous observations", () => {
      if (prepared === undefined) throw new Error("Owned readback fixture is not ready.");
      const { owner, fixture: f } = prepared;
      return owner.run(async () => {
        const input = structuredClone(f.input);
        const oracle = f.oracle(async () => {
          Object.assign(input.receipt.memory, { title: "caller changed this after capture began" });
          input.memoryStatus.working.epoch = 2;
          await Promise.resolve();
        });
        const live = await owner.request(async () => await oracle.captureLive(input));
        const receipt = await owner.request(f.stop);
        expect(await owner.request(async () => await oracle.verifyStopped({ receipt })))
          .toMatchObject({ phase: "stopped", snapshotDigest: live.snapshotDigest });
      });
    }, 5_000);

    test("requires live and then exact not-live process observations", () => {
      if (prepared === undefined) throw new Error("Owned readback fixture is not ready.");
      const { owner, fixture: f } = prepared;
      return owner.run(async () => {
        f.setLiveness("unknown");
        await owner.request(async () => {
          await expect(f.oracle().captureLive(f.input)).rejects.toThrow("claude_live_acceptance_readback_refused");
        });
        f.setLiveness("live");
        const oracle = f.oracle();
        await owner.request(async () => await oracle.captureLive(f.input));
        const receipt = await owner.request(f.stop);
        f.setLiveness("live");
        await owner.request(async () => {
          await expect(oracle.verifyStopped({ receipt })).rejects.toThrow("claude_live_acceptance_readback_refused");
        });
      });
    }, 5_000);

    test("requires removed artifacts even after exact process release", () => {
      if (prepared === undefined) throw new Error("Owned readback fixture is not ready.");
      const { owner, fixture: f } = prepared;
      return owner.run(async () => {
        const oracle = f.oracle();
        await owner.request(async () => await oracle.captureLive(f.input));
        const receipt = await owner.request(f.stop);
        await owner.request(async () => await mkdir(f.directory, { mode: 0o700 }));
        await owner.request(async () => await writeFile(f.configPath, JSON.stringify(f.config), { mode: 0o600 }));
        await owner.request(async () => {
          await expect(oracle.verifyStopped({ receipt })).rejects.toThrow("claude_live_acceptance_readback_refused");
        });
      });
    }, 5_000);

    test("refuses authority changed during the stopped process observation", () => {
      if (prepared === undefined) throw new Error("Owned readback fixture is not ready.");
      const { owner, fixture: f } = prepared;
      return owner.run(async () => {
        const oracle = f.oracle();
        await owner.request(async () => await oracle.captureLive(f.input));
        const receipt = await owner.request(f.stop);
        f.observeProcess(() => { f.store.advanceProviderAccountProcessGeneration({ profileId: f.profile.id, provider: "claude",
          expectedProcessGeneration: f.providerAuthority.processGeneration + 1 }); });
        await owner.request(async () => {
          await expect(oracle.verifyStopped({ receipt })).rejects.toThrow("claude_live_acceptance_readback_refused");
        });
      });
    }, 5_000);

    test("does not accept an early stop, a changed final receipt, or an aborted reader", () => {
      if (prepared === undefined) throw new Error("Owned readback fixture is not ready.");
      const { owner, fixture: f } = prepared;
      return owner.run(async () => {
        const oracle = f.oracle();
        await owner.request(async () => {
          await expect(oracle.verifyStopped({ receipt: { ...f.input.receipt, lifecycleInvalidated: true } }))
            .rejects.toThrow("claude_live_acceptance_readback_refused");
        });
        const valid = f.oracle();
        await owner.request(async () => await valid.captureLive(f.input));
        const receipt = await owner.request(f.stop);
        await owner.request(async () => {
          await expect(valid.verifyStopped({ receipt: { ...receipt, callId: "wrong" } }))
            .rejects.toThrow("claude_live_acceptance_readback_refused");
        });
        const controller = new AbortController(); controller.abort();
        const aborted = createClaudeLiveAcceptanceReadback({ paths: f.paths, signal: controller.signal,
          inspectLiveProcess: async () => { throw new Error("must not inspect"); } });
        await owner.request(async () => {
          await expect(aborted.captureLive(f.input)).rejects.toThrow("claude_live_acceptance_readback_refused");
        });
      });
    }, 5_000);

    test("cleanup-only proves retained released custody without minting acceptance proof", () => {
      if (prepared === undefined) throw new Error("Owned readback fixture is not ready.");
      const { owner, fixture: f } = prepared;
      return owner.run(async () => {
        expect(f.providerAuthority.processGeneration).not.toBe(f.profile.processGeneration);
        const input = { profileId: f.profile.id, profileGeneration: f.providerAuthority.processGeneration, sessionId: f.session.id };
        await owner.request(async () => {
          await expect(f.oracle().verifyCleanupStoppedCustody(input)).rejects.toThrow("claude_live_acceptance_readback_refused");
        });
        await owner.request(f.stop);
        expect(f.store.readSessionClaudeProcessAuthority(f.session.id, true)).toMatchObject({
          profileGeneration: f.profile.processGeneration, providerAuthority: f.providerAuthority, state: "released",
        });
        const oracle = f.oracle();
        const evidence = await owner.request(async () => await oracle.verifyCleanupStoppedCustody(input));
        expect(evidence).toMatchObject({ source: "independent_cleanup_readback", phase: "cleanup_stopped",
          retainedSessionProcess: "released_not_live", unreleasedProcessesAbsent: true, privateArtifactsAbsent: true,
          scopeBindingDigest: canonicalSha256({ domain: "hra.claude.cleanup-readback.v1", ...input }) });
        expect(evidence).not.toHaveProperty("soleRemember");
        expect(JSON.stringify(evidence)).not.toContain(f.session.id);
        await owner.request(async () => {
          await expect(oracle.captureLive(f.input)).rejects.toThrow("claude_live_acceptance_readback_refused");
        });
      });
    }, 5_000);

    test("cleanup-only refuses missing staged session, wrong generation, extra input, artifacts, and unknown liveness", () => {
      if (prepared === undefined) throw new Error("Owned readback fixture is not ready.");
      const { owner, fixture: f } = prepared;
      return owner.run(async () => {
        await owner.request(f.stop);
        const input = { profileId: f.profile.id, profileGeneration: f.providerAuthority.processGeneration, sessionId: f.session.id };
        for (const invalid of [{ profileId: f.profile.id }, { ...input, profileGeneration: input.profileGeneration + 1 },
          { profileId: input.profileId, sessionId: input.sessionId }, { ...input, extra: true }]) {
          await owner.request(async () => {
            await expect(f.oracle().verifyCleanupStoppedCustody(invalid)).rejects.toThrow("claude_live_acceptance_readback_refused");
          });
        }
        f.setLiveness("unknown");
        await owner.request(async () => {
          await expect(f.oracle().verifyCleanupStoppedCustody(input)).rejects.toThrow("claude_live_acceptance_readback_refused");
        });
        f.setLiveness("not_live");
        await owner.request(async () => await mkdir(f.directory, { mode: 0o700 }));
        await owner.request(async () => {
          await expect(f.oracle().verifyCleanupStoppedCustody(input)).rejects.toThrow("claude_live_acceptance_readback_refused");
        });
      });
    }, 5_000);

    test("cleanup-only refuses authority changed during its stopped observation", () => {
      if (prepared === undefined) throw new Error("Owned readback fixture is not ready.");
      const { owner, fixture: f } = prepared;
      return owner.run(async () => {
        await owner.request(f.stop);
        f.observeProcess(() => { f.store.advanceProviderAccountProcessGeneration({ profileId: f.profile.id, provider: "claude",
          expectedProcessGeneration: f.providerAuthority.processGeneration + 1 }); });
        await owner.request(async () => {
          await expect(f.oracle().verifyCleanupStoppedCustody({ profileId: f.profile.id,
            profileGeneration: f.providerAuthority.processGeneration, sessionId: f.session.id }))
            .rejects.toThrow("claude_live_acceptance_readback_refused");
        });
      });
    }, 5_000);
  });

  describe("final process-probe authority", () => {
    let prepared: Readonly<{ owner: ReturnType<typeof createOwnedReadbackCase>; fixture: Awaited<ReturnType<typeof fixture>> }> | undefined;
    beforeEach(() => {
      prepared = undefined;
      const owner = createOwnedReadbackCase();
      ownedReadbackCases.push(owner);
      // This adds a separate fresh-fixture budget, not more time for readback.
      // The stopped case keeps capture, stop, and final-probe refusal together.
      return runOwnedReadbackSetup(owner, () => fixture(owner.registerCleanup), (value) => {
        prepared = { owner, fixture: value };
      });
    }, 5_000);

    test.each(["live", "stopped", "cleanup"] as const)(
      "rechecks Claude authority after the final %s process probe",
      (phase) => {
        if (prepared === undefined) throw new Error("Owned readback fixture is not ready.");
        const { owner, fixture: f } = prepared;
        return owner.run(async () => {
          const oracle = f.oracle();
          if (phase === "stopped") await owner.request(async () => await oracle.captureLive(f.input));
          const receipt = phase === "live" ? null : await owner.request(f.stop);
          let probes = 0;
          f.observeProcess(() => {
            if (++probes === 2) f.store.advanceProviderAccountProcessGeneration({
              profileId: f.profile.id, provider: "claude",
              expectedProcessGeneration: f.providerAuthority.processGeneration + (phase === "live" ? 0 : 1),
            });
          });
          await owner.request(async () => {
            const result = phase === "live" ? oracle.captureLive(f.input)
              : phase === "stopped" ? oracle.verifyStopped({ receipt: receipt ?? (() => { throw new Error("fixture receipt missing"); })() })
                : oracle.verifyCleanupStoppedCustody({ profileId: f.profile.id,
                  profileGeneration: f.providerAuthority.processGeneration, sessionId: f.session.id });
            await expect(result).rejects.toThrow("claude_live_acceptance_readback_refused");
            expect(probes).toBe(2);
          });
        });
      },
      5_000,
    );
  });

  test.each(["nonce", "key", "attestation", "extra-row", "continuation", "canonical", "auth", "send", "start", "extra-field",
    "epoch", "owner", "status-head", "status-session", "status-project", "status-extra"])(
    "refuses mismatched independent %s evidence", async (kind) => {
      const f = await fixture();
      const input = structuredClone(f.input);
      const row = input.workingQuery.rows[0];
      if (row === undefined) throw new Error("fixture row missing");
      if (kind === "nonce") row.bodyChunk += "wrong";
      if (kind === "key") row.key += "wrong";
      if (kind === "attestation") row.provenance.attestationSha256 = sha("wrong");
      if (kind === "extra-row") input.workingQuery.rows.push(row);
      if (kind === "continuation") Object.assign(input.workingQuery, { continuation: "memc_unexpected" });
      if (kind === "canonical") row.lane = "canonical";
      if (kind === "auth") Object.assign(input.claudeAuthentication, { signedIn: false });
      if (kind === "send") input.sendIdempotencyKey = randomUUID();
      if (kind === "start") input.startIdempotencyKey = randomUUID();
      if (kind === "extra-field") Object.assign(input.receipt, { extra: true });
      if (kind === "epoch") input.memoryStatus.working.epoch = 2;
      if (kind === "owner") input.memoryStatus.working.ownerMatchesSession = false;
      if (kind === "status-head") input.memoryStatus.working.head = { ...input.memoryStatus.working.head, digest: sha("wrong") };
      if (kind === "status-session") input.memoryStatus.sessionId = `sess_${"0".repeat(32)}`;
      if (kind === "status-project") input.memoryStatus.projectId = `proj_${"0".repeat(32)}`;
      if (kind === "status-extra") Object.assign(input.memoryStatus, { extra: true });
      await expect(f.oracle().captureLive(input)).rejects.toThrow("claude_live_acceptance_readback_refused");
    },
  );

  test("refuses another retained submission even when it was cancelled", async () => {
    const f = await fixture();
    const extra = f.store.prepareMemorySubmission({ actorSessionId: f.session.id, projectId: f.input.projectId,
      kind: "remember", requestDigest: sha("extra"), contentDigest: sha("extra content"), keyDigest: sha("extra key"),
      workingBindingDigest: f.submission.workingBindingDigest, workingEpoch: 1,
      expectedHead: { sequence: 1, operationSha256: f.input.receipt.result.workingHead.operationSha256,
        headDigest: f.input.receipt.result.workingHead.digest }, idempotencyKey: randomUUID() }).record;
    f.store.cancelPreparedMemorySubmission(extra.id);
    await expect(f.oracle().captureLive(f.input)).rejects.toThrow("claude_live_acceptance_readback_refused");
  });

  test("refuses a retained attestation whose exact working reference was removed", async () => {
    const f = await fixture();
    f.store.reserveMemoryWorkingPageAttestationFork({ childBindingDigest: sha("other binding"),
      childSessionId: `sess_${"f".repeat(32)}`, parentBindingDigest: f.submission.workingBindingDigest,
      parentHead: f.input.receipt.result.workingHead });
    expect(f.store.purgeMemoryWorkingPageAttestations({ bindingDigest: f.submission.workingBindingDigest })).toBe(1);
    expect(f.store.findMemoryPageAttestation(f.input.workingQuery.rows[0]?.provenance.attestationSha256 ?? "")).not.toBeNull();
    await expect(f.oracle().captureLive(f.input)).rejects.toThrow("claude_live_acceptance_readback_refused");
  });

  test("refuses failed argv custody and artifacts changed during process inspection", async () => {
    const f = await fixture();
    await expect(f.oracle(async () => { throw new Error("synthetic custody refusal"); }).captureLive(f.input))
      .rejects.toThrow("claude_live_acceptance_readback_refused");
    await expect(f.oracle(async () => { await writeFile(f.configPath, JSON.stringify({ extra: true })); }).captureLive(f.input))
      .rejects.toThrow("claude_live_acceptance_readback_refused");
  });

  test.each(["symlink", "hardlink", "oversize", "binding", "config", "mode", "extra-binding", "extra-file", "invalid-utf8"])(
    "refuses %s private artifacts without leaking their bytes", async (kind) => {
      const f = await fixture();
      if (kind === "symlink") {
        const target = join(f.directory, "target.json");
        await writeFile(target, JSON.stringify(f.binding), { mode: 0o600 });
        await rm(f.bindingPath); await symlink(target, f.bindingPath);
      }
      if (kind === "oversize") await writeFile(f.bindingPath, "x".repeat(8193));
      if (kind === "hardlink") await link(f.bindingPath, join(f.paths.runtime, "linked-binding.json"));
      if (kind === "binding") await writeFile(f.bindingPath, JSON.stringify({ ...f.binding, bindingId: `clhb_${"0".repeat(32)}` }));
      if (kind === "config") await writeFile(f.configPath, JSON.stringify({ ...f.config, extra: "private" }));
      if (kind === "mode") await chmod(f.configPath, 0o644);
      if (kind === "extra-binding") await mkdtemp(join(f.paths.runtime, ".oompa-claude-host-tools-"));
      if (kind === "extra-file") await writeFile(join(f.directory, "extra.json"), "{}", { mode: 0o600 });
      if (kind === "invalid-utf8") await writeFile(f.bindingPath, new Uint8Array([0x22, 0xff, 0x22]));
      await expect(f.oracle().captureLive(f.input)).rejects.toThrow("claude_live_acceptance_readback_refused");
    },
  );







  test("cleanup before native start proves no sessions or unsettled start, not provider receipt consumption", async () => {
    const root = await realpath(await mkdtemp("/tmp/oompa-clrb-empty-"));
    const paths = resolveStatePaths({ rootDirectory: root });
    await initializeStatePaths(paths);
    const store = new StateStore(paths);
    cleanups.push(async () => { store.close(); await rm(root, { recursive: true }); });
    const profile = store.createProfile("Cleanup before native start");
    const oracle = () => createClaudeLiveAcceptanceReadback({ paths, signal: new AbortController().signal,
      inspectLiveProcess: async () => { throw new Error("no live process to inspect"); },
      processProbe: async () => { throw new Error("no process identity to inspect"); } });
    expect(await oracle().verifyCleanupStoppedCustody({ profileId: profile.id, profileGeneration: profile.processGeneration }))
      .toMatchObject({ retainedSessionProcess: "absent", phase: "cleanup_stopped" });
    const mutation = store.prepareMutation({ kind: "session.start", authorityId: profile.id,
      authorityGeneration: profile.processGeneration, idempotencyKey: randomUUID(), request: { synthetic: true } });
    expect(store.transitionMutation(mutation.id, "prepared", "effect_started")).toBe(true);
    await expect(oracle().verifyCleanupStoppedCustody({ profileId: profile.id }))
      .rejects.toThrow("claude_live_acceptance_readback_refused");
  });
});
