import { describe, expect, test } from "bun:test";

import {
  DEVIN_MODEL,
  DEVIN_PIN,
  DevinError,
  devinAcpArgv,
  type DevinAcpProcess,
  type DevinDirectories,
  type PinnedDevinRuntime,
} from "../devin/index.ts";
import type { CodexFact } from "../codex/protocol.ts";
import { PresetProviderMismatchError } from "../domain/presets.ts";
import { effectiveDevinRuntimeProfileV2Schema } from "../domain/runtime-profile.ts";
import {
  PinnedDevinRuntimeManager,
  type DevinProcessFactory,
} from "./devin-runtime-adapter.ts";
import type { ProfileAuthority } from "./ports.ts";

type JsonRecord = Record<string, unknown>;
/** One JSON-RPC frame the fake agent writes; Oompa owns the framing now. */
type AnyMessage = JsonRecord;

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const PROJECT_ROOT = "/var/oompa/projects/demo";
const NOW = 1_700_000_000_000;
const ASTRA_REQUIREMENT = {
  effort: "provider-default",
  model: DEVIN_MODEL,
} as const;

const authority: ProfileAuthority = {
  bindingGeneration: 1,
  codexHome: "/var/oompa/profiles/acct/codex",
  desktopUserData: "/var/oompa/profiles/acct/desktop",
  generation: 3,
  id: "acct_00000000000000000000000000000000",
  provider: "devin",
  providerAccountId: "dact_00000000000000000000000000000000",
};

const directories: DevinDirectories = {
  cacheHome: "/var/oompa/profiles/acct/devin-cache",
  configHome: "/var/oompa/profiles/acct/devin-config",
  dataHome: "/var/oompa/profiles/acct/devin-data",
  home: "/var/oompa/profiles/acct/devin-home",
  stateHome: "/var/oompa/profiles/acct/devin-state",
};

const runtime: PinnedDevinRuntime = {
  build: "bcbe88c7",
  executablePath: "/usr/local/bin/devin",
  version: DEVIN_PIN,
  versionOutput: `devin ${DEVIN_PIN} (bcbe88c7)`,
};

const method = (message: JsonRecord): string | undefined =>
  typeof message.method === "string" ? message.method : undefined;

const requestId = (message: JsonRecord): string | number => {
  if (typeof message.id !== "string" && typeof message.id !== "number") {
    throw new Error("test expected a request id");
  }
  return message.id;
};

class FakeDevinProcess implements DevinAcpProcess {
  readonly stdin: WritableStream<Uint8Array>;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: AsyncIterable<Uint8Array> = {
    async *[Symbol.asyncIterator]() { /* No diagnostics. */ },
  };
  readonly exited: Promise<number>;
  readonly received: JsonRecord[] = [];
  readonly sessionId: string;
  beforeNewResponse: (() => void) | undefined;
  promptRequestId: string | number | undefined;
  finished = false;
  terminated = false;
  forceTerminated = false;
  #stdout!: ReadableStreamDefaultController<Uint8Array>;
  #resolveExit!: (code: number) => void;

  constructor(sessionId = "devin-session-1") {
    this.sessionId = sessionId;
    this.stdout = new ReadableStream({
      start: (controller) => { this.#stdout = controller; },
    });
    this.exited = new Promise((resolve) => { this.#resolveExit = resolve; });
    this.stdin = new WritableStream({
      write: async (chunk) => {
        for (const line of decoder.decode(chunk).split("\n")) {
          if (line.trim().length === 0) continue;
          const value = JSON.parse(line) as unknown;
          if (value === null || typeof value !== "object" || Array.isArray(value)) {
            throw new Error("test client wrote a non-object frame");
          }
          const message = value as JsonRecord;
          this.received.push(message);
          await this.#onMessage(message);
        }
      },
      close: () => { this.finish(0); },
      abort: () => { this.finish(1); },
    });
  }

  async #onMessage(message: JsonRecord): Promise<void> {
    switch (method(message)) {
      case "initialize":
        this.send({
          jsonrpc: "2.0",
          method: "_cognition.ai/mcp/serversChanged",
          params: {},
        });
        this.send({
          jsonrpc: "2.0",
          id: requestId(message),
          result: {
            protocolVersion: 1,
            agentCapabilities: { loadSession: true },
          },
        });
        break;
      case "session/new":
        this.beforeNewResponse?.();
        this.send({
          jsonrpc: "2.0",
          id: requestId(message),
          result: { sessionId: this.sessionId },
        });
        break;
      case "session/load":
        this.send({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: this.sessionId,
            update: {
              content: { text: "replayed answer", type: "text" },
              messageId: "replayed-message",
              sessionUpdate: "agent_message_chunk",
            },
          },
        });
        this.send({ jsonrpc: "2.0", id: requestId(message), result: {} });
        break;
      case "session/prompt":
        this.promptRequestId = requestId(message);
        break;
      case "session/cancel":
        if (this.promptRequestId !== undefined) this.completePrompt("cancelled");
        break;
      case undefined:
      default:
        break;
    }
  }

  send(message: AnyMessage): void {
    this.#stdout.enqueue(encoder.encode(`${JSON.stringify(message)}\n`));
  }

  sendUpdate(update: JsonRecord): void {
    this.sendSessionUpdate(this.sessionId, update);
  }

  sendSessionUpdate(sessionId: string, update: JsonRecord): void {
    this.send({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId, update },
    });
  }

  sendPermission(
    id: string | number = 77,
    options: readonly JsonRecord[] = [
      { kind: "allow_once", name: "Allow once", optionId: "allow-once" },
      { kind: "allow_always", name: "Always allow", optionId: "allow-always" },
      { kind: "reject_once", name: "Reject", optionId: "reject-once" },
    ],
    toolCallId = "tool-1",
  ): void {
    this.send({
      jsonrpc: "2.0",
      id,
      method: "session/request_permission",
      params: {
        options,
        sessionId: this.sessionId,
        toolCall: {
          kind: "execute",
          status: "pending",
          title: "Run the focused tests",
          toolCallId,
        },
      },
    });
  }

  completePrompt(stopReason: "end_turn" | "cancelled"): void {
    const id = this.promptRequestId;
    if (id === undefined) throw new Error("no prompt is pending");
    this.promptRequestId = undefined;
    this.send({ jsonrpc: "2.0", id, result: { stopReason } });
  }

  finish(code: number): void {
    if (this.finished) return;
    this.finished = true;
    this.#stdout.close();
    this.#resolveExit(code);
  }

  terminate(): void {
    this.terminated = true;
    this.finish(143);
  }

  forceTerminate(): void {
    this.forceTerminated = true;
    this.finish(137);
  }
}

const signal = (): AbortSignal => new AbortController().signal;

const settle = async (): Promise<void> => {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
  await new Promise((resolve) => { setTimeout(resolve, 1); });
};

const waitFor = async (condition: () => boolean | Promise<boolean>): Promise<void> => {
  for (let index = 0; index < 100; index += 1) {
    if (await condition()) return;
    await settle();
  }
  throw new Error("condition did not settle");
};

const harness = (options: {
  onFact?: (fact: CodexFact) => void | Promise<void>;
  isCurrent?: (authority: ProfileAuthority) => boolean;
  projectRootFor?: ConstructorParameters<typeof PinnedDevinRuntimeManager>[0]["projectRootFor"];
  processFactory?: DevinProcessFactory;
  readAuthStatus?: ConstructorParameters<typeof PinnedDevinRuntimeManager>[0]["readAuthStatus"];
  resolveRuntime?: ConstructorParameters<typeof PinnedDevinRuntimeManager>[0]["resolveRuntime"];
} = {}) => {
  const facts: CodexFact[] = [];
  const processes: FakeDevinProcess[] = [];
  const launches: Parameters<DevinProcessFactory>[0][] = [];
  const manager = new PinnedDevinRuntimeManager({
    directoriesFor: () => directories,
    isCurrent: options.isCurrent ?? (() => true),
    now: () => NOW,
    observer: { fact: async (_authority, fact) => {
      facts.push(fact);
      await options.onFact?.(fact);
    } },
    processFactory: options.processFactory ?? ((input) => {
      launches.push(input);
      const process = new FakeDevinProcess();
      processes.push(process);
      return process;
    }),
    ...(options.projectRootFor === undefined ? {} : { projectRootFor: options.projectRootFor }),
    ...(options.readAuthStatus === undefined ? {} : { readAuthStatus: options.readAuthStatus }),
    resolveRuntime: options.resolveRuntime ?? (async () => runtime),
  });
  return { facts, launches, manager, processes };
};

const startSession = async (
  manager: PinnedDevinRuntimeManager,
): Promise<string> => {
  const review = await manager.reviewSessionStart({
    authority,
    fast: false,
    preset: "astra",
    requirement: ASTRA_REQUIREMENT,
    projectRoot: PROJECT_ROOT,
    signal: signal(),
  });
  const started = await manager.startSession({
    authority,
    projectRoot: PROJECT_ROOT,
    review,
    signal: signal(),
  });
  return started.providerThreadId;
};

const startTurn = async (
  manager: PinnedDevinRuntimeManager,
  providerThreadId: string,
  message = "do the work",
): Promise<string> => {
  const review = await manager.reviewTurnStart({
    authority,
    fast: false,
    preset: "astra",
    requirement: ASTRA_REQUIREMENT,
    projectRoot: PROJECT_ROOT,
    providerThreadId,
    signal: signal(),
  });
  const result = await manager.startTurn({
    authority,
    clientMessageId: "client-message-1",
    message,
    projectRoot: PROJECT_ROOT,
    providerThreadId,
    review,
    signal: signal(),
  });
  return result.turnId;
};

describe("pinned Devin runtime manager", () => {
  test("reviews the exact pin and Astra argv, then projects a bounded ACP turn", async () => {
    const { facts, launches, manager, processes } = harness();
    const review = await manager.reviewSessionStart({
      authority,
      fast: false,
      preset: "astra",
      requirement: ASTRA_REQUIREMENT,
      projectRoot: PROJECT_ROOT,
      signal: signal(),
    });
    expect(effectiveDevinRuntimeProfileV2Schema.parse(review.effectiveRuntimeProfile)).toEqual({
      devinVersion: DEVIN_PIN,
      isolatedHome: true,
      model: DEVIN_MODEL,
      observedAt: NOW,
      preset: "astra",
      processGeneration: authority.generation,
      profileId: authority.id,
      protocolVersion: 1,
      reasoningEffort: "provider-default",
    });
    const started = await manager.startSession({
      authority,
      projectRoot: PROJECT_ROOT,
      review,
      signal: signal(),
    });
    expect(started).toMatchObject({
      providerThreadId: "devin-session-1",
      projectRoot: PROJECT_ROOT,
      status: "idle",
    });
    expect(manager.pinnedVersion()).toBe(DEVIN_PIN);
    expect(launches[0] === undefined ? undefined : devinAcpArgv(launches[0].runtime)).toEqual([
      "/usr/local/bin/devin",
      "acp",
      "--model",
      "gpt-6-astra",
    ]);

    const turnId = await startTurn(manager, started.providerThreadId, "Run tests");
    const process = processes[0];
    if (process === undefined) throw new Error("expected one Devin process");
    await waitFor(() => process.promptRequestId !== undefined);
    expect(process.received.find((entry) => method(entry) === "session/prompt")).toMatchObject({
      params: {
        prompt: [{ text: "Run tests", type: "text" }],
        sessionId: "devin-session-1",
      },
    });

    process.sendUpdate({
      content: { text: "done", type: "text" },
      messageId: "message-1",
      sessionUpdate: "agent_message_chunk",
    });
    process.sendUpdate({
      cost: { amount: 0.01, currency: "USD" },
      sessionUpdate: "usage_update",
      size: 200_000,
      used: 53_000,
    });
    process.sendUpdate({
      entries: [{ content: "Run tests", priority: "high", status: "completed" }],
      sessionUpdate: "plan",
    });
    process.sendPermission();
    await waitFor(() => facts.some((fact) => fact.type === "interactionRequested"));

    const usage = facts.find((fact) => fact.type === "tokenUsageUpdated");
    expect(usage).toMatchObject({
      cachedInputTokens: null,
      inputTokens: null,
      modelContextWindow: 200_000,
      outputTokens: null,
      providerCost: { amount: 0.01, currency: "USD" },
      reasoningOutputTokens: null,
      totalTokens: 53_000,
      turnId,
    });
    // ACP's context occupancy is not an account allowance or reset window.
    expect(facts.some((fact) => fact.type === "rateLimitsUpdated")).toBe(false);

    const interaction = manager.interactionAuthority(authority, started.providerThreadId, "n:77");
    expect(facts.find((fact) => fact.type === "interactionRequested")).toMatchObject({
      display: { allowsSessionScope: false },
    });
    expect(interaction).toMatchObject({
      approvalId: "tool-1",
      method: "devin/session/request_permission",
      processGeneration: authority.generation,
      profileId: authority.id,
      requestId: { type: "string", value: "n:77" },
      threadId: started.providerThreadId,
      turnId,
    });
    expect(await manager.inspectInteractionAuthority({
      authority,
      kind: "permission_approval",
      provider: interaction,
      signal: signal(),
    })).toEqual({
      environmentId: null,
      kind: "permission_approval",
      permissions: ["workspace:execute"],
      reason: "Run the focused tests",
      workingDirectory: PROJECT_ROOT,
    });
    const validated = await manager.validateInteractionResolution({
      authority,
      kind: "permission_approval",
      provider: interaction,
      resolution: { decision: "once", kind: "approval_decision" },
      signal: signal(),
    });
    expect(validated.responseDigest).toMatch(/^[a-f0-9]{64}$/u);
    await manager.resolveInteraction({
      authority,
      deadlineAt: NOW + 1_000,
      kind: "permission_approval",
      provider: interaction,
      resolution: { decision: "once", kind: "approval_decision" },
      signal: signal(),
    });
    expect(process.received.find((entry) => entry.id === 77)).toEqual({
      id: 77,
      jsonrpc: "2.0",
      result: { outcome: { optionId: "allow-once", outcome: "selected" } },
    });

    process.completePrompt("end_turn");
    await waitFor(async () => (await manager.readSession({
      authority,
      detail: false,
      providerThreadId: started.providerThreadId,
      signal: signal(),
    })).status === "idle");
    const projection = await manager.readSession({
      authority,
      detail: true,
      providerThreadId: started.providerThreadId,
      signal: signal(),
    });
    expect(projection.messages).toEqual([
      { clientId: "client-message-1", role: "user", text: "Run tests", turnId },
      { role: "assistant", text: "done", turnId },
    ]);
    expect(projection.turnSummaries?.[0]).toMatchObject({ id: turnId, status: "completed" });
    await manager.close();
    expect(process.finished).toBe(true);
  });

  test("loads an existing native session through the injected exact project root", async () => {
    const { facts, manager, processes } = harness({
      projectRootFor: ({ providerThreadId }) =>
        providerThreadId === "devin-session-1" ? PROJECT_ROOT : undefined,
    });
    const observation = await manager.observeSession({
      authority,
      providerThreadId: "devin-session-1",
      signal: signal(),
    });
    expect(observation.resumed).toBe(true);
    expect(observation.projection.messages).toEqual([
      { role: "assistant", text: "replayed answer" },
    ]);
    // Replay builds the read projection but cannot duplicate historical live facts.
    expect(facts.some((fact) => fact.type === "assistantDelta")).toBe(false);
    const process = processes[0];
    if (process === undefined) throw new Error("expected one Devin process");
    expect(process.received.find((entry) => method(entry) === "session/load")).toMatchObject({
      params: {
        cwd: PROJECT_ROOT,
        mcpServers: [],
        sessionId: "devin-session-1",
      },
    });

    const turnId = await startTurn(manager, "devin-session-1", "continue");
    await waitFor(() => process.promptRequestId !== undefined);
    process.sendUpdate({
      kind: "execute",
      sessionUpdate: "tool_call",
      status: "pending",
      title: "Command still running",
      toolCallId: "tool-pending",
    });
    await waitFor(() => facts.some((fact) =>
      fact.type === "itemStarted" && fact.itemId === "devin-tool:tool-pending"));
    await manager.interrupt({
      activeTurnId: turnId,
      authority,
      providerThreadId: "devin-session-1",
      signal: signal(),
    });
    await waitFor(() => facts.some((fact) =>
      fact.type === "turnCompleted" && fact.turn.id === turnId));
    expect(facts.find((fact) =>
      fact.type === "turnCompleted" && fact.turn.id === turnId)).toMatchObject({
      turn: { status: "interrupted" },
    });
    expect(facts.find((fact) =>
      fact.type === "itemCompleted" && fact.itemId === "devin-tool:tool-pending"))
      .toMatchObject({ status: "interrupted" });
    await manager.close();
  });

  test("buffers new-session updates until the returned session id is bound", async () => {
    const created: FakeDevinProcess[] = [];
    const { manager } = harness({
      processFactory: () => {
        const process = new FakeDevinProcess();
        process.beforeNewResponse = () => {
          process.sendSessionUpdate(process.sessionId, {
            content: { text: "bound answer", type: "text" },
            messageId: "bound-message",
            sessionUpdate: "agent_message_chunk",
          });
        };
        created.push(process);
        return process;
      },
    });

    const providerThreadId = await startSession(manager);
    expect((await manager.readSession({
      authority,
      detail: true,
      providerThreadId,
      signal: signal(),
    })).messages).toEqual([{ role: "assistant", text: "bound answer" }]);
    await manager.close();
    expect(created[0]?.finished).toBe(true);
  });

  test("admits a queued continuation as soon as turn completion is published", async () => {
    let continued = false;
    let continuationFailure: unknown;
    let finishContinuation!: () => void;
    const continuationFinished = new Promise<void>((resolve) => { finishContinuation = resolve; });
    const { manager, processes } = harness({
      onFact: async (fact) => {
        if (fact.type !== "turnCompleted" || continued) return;
        continued = true;
        try {
          await startTurn(manager, fact.threadId, "queued continuation");
        } catch (error: unknown) {
          continuationFailure = error;
        } finally {
          finishContinuation();
        }
      },
    });
    try {
      const providerThreadId = await startSession(manager);
      await startTurn(manager, providerThreadId);
      const process = processes[0];
      if (process === undefined) throw new Error("expected one Devin process");
      await waitFor(() => process.promptRequestId !== undefined);
      process.completePrompt("end_turn");
      await continuationFinished;
      expect(continuationFailure).toBeUndefined();
      expect(process.received.filter((frame) => method(frame) === "session/prompt")).toHaveLength(2);
    } finally {
      await manager.close();
    }
  });

  test("omits supported ACP metadata and raw thoughts without declaring protocol incompatibility", async () => {
    const { facts, manager, processes } = harness();
    try {
      const providerThreadId = await startSession(manager);
      await startTurn(manager, providerThreadId);
      const process = processes[0];
      if (process === undefined) throw new Error("expected one Devin process");
      await waitFor(() => process.promptRequestId !== undefined);
      process.sendUpdate({
        content: { text: "private provider reasoning", type: "text" },
        sessionUpdate: "agent_thought_chunk",
      });
      for (const update of [
        { sessionUpdate: "user_message_chunk", content: { type: "text", text: "echoed user prompt" } },
        { sessionUpdate: "available_commands_update", availableCommands: [] },
        { sessionUpdate: "current_mode_update", currentModeId: "default" },
        { sessionUpdate: "config_option_update", configOptions: [] },
        { sessionUpdate: "session_info_update", title: "Example" },
      ]) process.sendUpdate(update);
      process.sendUpdate({ sessionUpdate: "unexpected_extension_update" });
      process.sendUpdate({
        content: { text: "visible answer", type: "text" },
        sessionUpdate: "agent_message_chunk",
      });
      await waitFor(() => facts.some((fact) => fact.type === "assistantDelta"));
      expect(facts.flatMap((fact) => fact.type === "protocolNotice"
        && fact.method.startsWith("session/update:") ? [fact.method] : []))
        .toEqual(["session/update:unexpected_extension_update"]);
      expect(JSON.stringify(facts)).not.toContain("private provider reasoning");
      expect((await manager.readSession({
        authority, detail: true, providerThreadId, signal: signal(),
      })).messages?.at(-1)).toMatchObject({ role: "assistant", text: "visible answer" });
    } finally {
      await manager.close();
    }
  });

  test("retains cumulative omitted bytes when more deltas follow a truncated assistant message", async () => {
    const { facts, manager, processes } = harness();
    try {
      const providerThreadId = await startSession(manager);
      await startTurn(manager, providerThreadId);
      const process = processes[0];
      if (process === undefined) throw new Error("expected one Devin process");
      await waitFor(() => process.promptRequestId !== undefined);
      for (const text of ["a".repeat(17_000), "tail"]) {
        process.sendUpdate({
          content: { text, type: "text" },
          messageId: "long-message",
          sessionUpdate: "agent_message_chunk",
        });
      }
      await waitFor(() => facts.filter((fact) => fact.type === "assistantDelta").length === 2);
      const projection = await manager.readSession({
        authority, detail: true, providerThreadId, signal: signal(),
      });
      expect(projection.messages?.at(-1)?.omission).toEqual({
        omittedUtf8Bytes: 620,
        originalUtf8Bytes: 17_004,
        returnedUtf8Bytes: 16_384,
      });
      expect(projection.omission?.truncatedMessages).toBe(1);
    } finally {
      await manager.close();
    }
  });

  test("rejects a new-session update for an id other than the returned session", async () => {
    let process: FakeDevinProcess | undefined;
    const { manager } = harness({
      processFactory: () => {
        process = new FakeDevinProcess();
        process.beforeNewResponse = () => {
          process?.sendSessionUpdate("foreign-session", {
            content: { text: "foreign answer", type: "text" },
            messageId: "foreign-message",
            sessionUpdate: "agent_message_chunk",
          });
        };
        return process;
      },
    });

    await expect(startSession(manager)).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
    expect(process?.finished).toBe(true);
    await manager.close();
  });

  test("fails closed when new-session facts exceed their pre-bind bound", async () => {
    let process: FakeDevinProcess | undefined;
    const { manager } = harness({
      processFactory: () => {
        process = new FakeDevinProcess();
        process.beforeNewResponse = () => {
          for (let index = 0; index < 129; index += 1) {
            process?.sendSessionUpdate("devin-session-1", {
              content: { text: "x", type: "text" },
              messageId: `prebind-${index}`,
              sessionUpdate: "agent_message_chunk",
            });
          }
        };
        return process;
      },
    });

    await expect(startSession(manager)).rejects.toThrow("fact consumer failed");
    expect(process?.terminated).toBe(true);
    expect(process?.finished).toBe(true);
    await manager.close();
  });

  test("retires a proven dead writer so observation can load and continue the session", async () => {
    const { facts, manager, processes } = harness({
      projectRootFor: ({ providerThreadId }) =>
        providerThreadId === "devin-session-1" ? PROJECT_ROOT : undefined,
    });
    const providerThreadId = await startSession(manager);
    const first = processes[0];
    if (first === undefined) throw new Error("expected an initial Devin process");
    first.finish(17);
    await waitFor(() => facts.some((fact) => fact.type === "providerDisconnected"));

    const observation = await manager.observeSession({
      authority,
      providerThreadId,
      signal: signal(),
    });
    expect(observation.resumed).toBe(true);
    expect(processes).toHaveLength(2);
    const replacement = processes[1];
    if (replacement === undefined) throw new Error("expected a replacement Devin process");
    expect(replacement.received.some((entry) => method(entry) === "session/load")).toBe(true);

    const turnId = await startTurn(manager, providerThreadId, "continue after crash");
    await waitFor(() => replacement.promptRequestId !== undefined);
    await manager.interrupt({ activeTurnId: turnId, authority, providerThreadId, signal: signal() });
    await manager.close();
  });

  test("refuses ambiguous steering and a second concurrent prompt", async () => {
    const { manager, processes } = harness();
    const providerThreadId = await startSession(manager);
    const activeTurnId = await startTurn(manager, providerThreadId, "first");
    const process = processes[0];
    if (process === undefined) throw new Error("expected one Devin process");
    await waitFor(() => process.promptRequestId !== undefined);
    await expect(manager.steer({
      activeTurnId,
      authority,
      clientMessageId: "client-message-2",
      message: "change direction",
      providerThreadId,
      signal: signal(),
    })).rejects.toMatchObject({ code: "UNSUPPORTED_CAPABILITY" });

    const secondReview = await manager.reviewTurnStart({
      authority,
      fast: false,
      preset: "astra",
      requirement: ASTRA_REQUIREMENT,
      projectRoot: PROJECT_ROOT,
      providerThreadId,
      signal: signal(),
    });
    await expect(manager.startTurn({
      authority,
      clientMessageId: "client-message-3",
      message: "second",
      projectRoot: PROJECT_ROOT,
      providerThreadId,
      review: secondReview,
      signal: signal(),
    })).rejects.toThrow("already has an active prompt");
    await manager.interrupt({ activeTurnId, authority, providerThreadId, signal: signal() });
    await manager.close();
  });

  test("sends /compact as a between-turns prompt and fences mid-turn and terminal compaction", async () => {
    const { facts, manager, processes } = harness();
    const providerThreadId = await startSession(manager);
    const process = processes[0];
    if (process === undefined) throw new Error("expected one Devin process");

    const activeTurnId = await startTurn(manager, providerThreadId, "first");
    await waitFor(() => process.promptRequestId !== undefined);
    await expect(manager.compact({
      authority,
      providerThreadId,
      signal: signal(),
    })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await manager.interrupt({ activeTurnId, authority, providerThreadId, signal: signal() });
    await waitFor(() => facts.some((fact) =>
      fact.type === "turnCompleted" && fact.turn.id === activeTurnId));

    const factCountBeforeCompact = facts.length;
    const compacted = manager.compact({
      authority,
      providerThreadId,
      signal: signal(),
    });
    await waitFor(() => process.promptRequestId !== undefined);
    const prompt = process.received.filter((entry) => method(entry) === "session/prompt").at(-1);
    expect(prompt).toMatchObject({
      params: {
        prompt: [{ text: "/compact", type: "text" }],
        sessionId: providerThreadId,
      },
    });
    process.completePrompt("end_turn");
    await compacted;
    expect(facts.slice(factCountBeforeCompact).some((fact) =>
      fact.type === "turnStarted" || fact.type === "turnCompleted")).toBe(false);
    await manager.close();
  });

  test("fails a missing load root and fences a post-spawn authority change while joining the child", async () => {
    const withoutRoot = harness();
    await expect(withoutRoot.manager.observeSession({
      authority,
      providerThreadId: "unknown",
      signal: signal(),
    })).rejects.toMatchObject({ reason: "resume_unavailable" });
    expect(withoutRoot.processes).toEqual([]);
    await withoutRoot.manager.close();

    let current = true;
    let spawned: FakeDevinProcess | undefined;
    const fenced = harness({
      isCurrent: () => current,
      processFactory: () => {
        spawned = new FakeDevinProcess();
        spawned.beforeNewResponse = () => { current = false; };
        return spawned;
      },
    });
    const review = await fenced.manager.reviewSessionStart({
      authority,
      fast: false,
      preset: "astra",
      requirement: ASTRA_REQUIREMENT,
      projectRoot: PROJECT_ROOT,
      signal: signal(),
    });
    await expect(fenced.manager.startSession({
      authority,
      projectRoot: PROJECT_ROOT,
      review,
      signal: signal(),
    })).rejects.toMatchObject({ code: "AUTHORITY_STALE" });
    expect(spawned?.finished).toBe(true);
    await fenced.manager.close();
  });

  test("projects only Devin's signed-in boolean and refuses other-provider presets", async () => {
    const statusCalls: DevinDirectories[] = [];
    const { manager } = harness({
      readAuthStatus: async (input) => {
        statusCalls.push(input.directories);
        return { signedIn: true };
      },
    });
    expect(await manager.readAccount({ authority, signal: signal() }))
      .toEqual({ observedAt: NOW, readiness: "signed_in" });
    expect(statusCalls).toEqual([directories]);
    for (const invalid of [
      { ...authority, provider: "codex" as const },
      { ...authority, providerAccountId: "pact_00000000000000000000000000000000" },
      { ...authority, bindingGeneration: 0 },
    ]) {
      await expect(manager.readAccount({ authority: invalid, signal: signal() }))
        .rejects.toMatchObject({ code: "AUTHORITY_STALE" });
    }
    const unverified = harness({
      resolveRuntime: async () => { throw new DevinError("RUNTIME_MISMATCH", "not installed"); },
    });
    expect(await unverified.manager.readAccount({ authority, signal: signal() }))
      .toEqual({ observedAt: NOW, readiness: "unverified" });
    await unverified.manager.close();
    await expect(manager.reviewSessionStart({
      authority,
      fast: false,
      preset: "ultra",
      requirement: ASTRA_REQUIREMENT,
      projectRoot: PROJECT_ROOT,
      signal: signal(),
    })).rejects.toBeInstanceOf(PresetProviderMismatchError);
    await expect(manager.reviewSessionStart({
      authority,
      fast: true,
      preset: "astra",
      requirement: ASTRA_REQUIREMENT,
      projectRoot: PROJECT_ROOT,
      signal: signal(),
    })).rejects.toMatchObject({ code: "UNSUPPORTED_CAPABILITY" });
    await expect(manager.reviewSessionStart({
      authority,
      fast: false,
      preset: "astra",
      requirement: { effort: "max", model: "gpt-5.6-sol" },
      projectRoot: PROJECT_ROOT,
      signal: signal(),
    })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await manager.close();
  });

  test("checks deadlines and never widens a bounded denial into persistent rejection", async () => {
    const { manager, processes } = harness();
    const providerThreadId = await startSession(manager);
    await startTurn(manager, providerThreadId);
    const process = processes[0];
    if (process === undefined) throw new Error("expected one Devin process");
    await waitFor(() => process.promptRequestId !== undefined);
    process.sendPermission();
    await settle();
    const provider = manager.interactionAuthority(authority, providerThreadId, "n:77");
    await expect(manager.resolveInteraction({
      authority,
      deadlineAt: NOW - 1,
      kind: "permission_approval",
      provider,
      resolution: { decision: "once", kind: "approval_decision" },
      signal: signal(),
    })).rejects.toMatchObject({ code: "DEADLINE_EXPIRED" });
    expect(process.received.some((entry) => entry.id === 77)).toBe(false);
    const validated = await manager.validateInteractionTimeout({ authority, provider, signal: signal() });
    expect(validated.responseDigest).toMatch(/^[a-f0-9]{64}$/u);
    await manager.timeoutInteraction({ authority, provider, signal: signal() });
    expect(process.received.find((entry) => entry.id === 77)).toEqual({
      id: 77,
      jsonrpc: "2.0",
      result: { outcome: { optionId: "reject-once", outcome: "selected" } },
    });

    const persistentOnly = [
      { kind: "allow_once", name: "Allow once", optionId: "allow-once" },
      { kind: "reject_always", name: "Always reject", optionId: "reject-always" },
    ];
    process.sendPermission(78, persistentOnly);
    await waitFor(() => {
      try { return manager.interactionAuthority(authority, providerThreadId, "n:78").requestId.value === "n:78"; }
      catch { return false; }
    });
    const decline = manager.interactionAuthority(authority, providerThreadId, "n:78");
    await manager.resolveInteraction({
      authority,
      deadlineAt: NOW + 1_000,
      kind: "permission_approval",
      provider: decline,
      resolution: { decision: "decline", kind: "approval_decision" },
      signal: signal(),
    });
    expect(process.received.find((entry) => entry.id === 78)).toEqual({
      id: 78,
      jsonrpc: "2.0",
      result: { outcome: { outcome: "cancelled" } },
    });

    process.sendPermission(79, persistentOnly);
    await waitFor(() => {
      try { return manager.interactionAuthority(authority, providerThreadId, "n:79").requestId.value === "n:79"; }
      catch { return false; }
    });
    const timedOut = manager.interactionAuthority(authority, providerThreadId, "n:79");
    await manager.timeoutInteraction({ authority, provider: timedOut, signal: signal() });
    expect(process.received.find((entry) => entry.id === 79)).toEqual({
      id: 79,
      jsonrpc: "2.0",
      result: { outcome: { outcome: "cancelled" } },
    });
    await manager.close();
  });

  test("never maps HRA session scope to Devin's provider-persistent allow-always option", async () => {
    const { facts, manager, processes } = harness();
    const providerThreadId = await startSession(manager);
    await startTurn(manager, providerThreadId);
    const process = processes[0];
    if (process === undefined) throw new Error("expected one Devin process");
    await waitFor(() => process.promptRequestId !== undefined);
    process.sendPermission();
    await waitFor(() => facts.some((fact) => fact.type === "interactionRequested"));
    const provider = manager.interactionAuthority(authority, providerThreadId, "n:77");
    expect(facts.find((fact) => fact.type === "interactionRequested")).toMatchObject({
      display: { allowsSessionScope: false },
    });

    await expect(manager.validateInteractionResolution({
      authority,
      kind: "permission_approval",
      provider,
      resolution: { decision: "session", kind: "approval_decision" },
      signal: signal(),
    })).rejects.toMatchObject({ code: "UNSUPPORTED_CAPABILITY" });
    await expect(manager.validateInteractionResolution({
      authority,
      kind: "permission_approval",
      provider,
      resolution: {
        kind: "permission_grant",
        permissions: ["workspace:execute"],
        scope: "session",
      },
      signal: signal(),
    })).rejects.toMatchObject({ code: "UNSUPPORTED_CAPABILITY" });
    await expect(manager.resolveInteraction({
      authority,
      deadlineAt: NOW + 1_000,
      kind: "permission_approval",
      provider,
      resolution: { decision: "session", kind: "approval_decision" },
      signal: signal(),
    })).rejects.toMatchObject({ code: "UNSUPPORTED_CAPABILITY" });
    expect(process.received.some((entry) => entry.id === 77)).toBe(false);
    await manager.interrupt({
      activeTurnId: (await manager.readSession({
        authority,
        detail: false,
        providerThreadId,
        signal: signal(),
      })).activeTurnId ?? "",
      authority,
      providerThreadId,
      signal: signal(),
    });
    await manager.close();
  });

  test("fails the provider connection when pending permissions exceed the adapter bound", async () => {
    const { facts, manager, processes } = harness();
    const providerThreadId = await startSession(manager);
    await startTurn(manager, providerThreadId);
    const process = processes[0];
    if (process === undefined) throw new Error("expected one Devin process");
    await waitFor(() => process.promptRequestId !== undefined);
    for (let index = 0; index < 17; index += 1) {
      process.sendPermission(1_000 + index, undefined, `permission-tool-${index}`);
    }
    await waitFor(() => process.terminated);
    await waitFor(() => facts.some((fact) =>
      fact.type === "providerError" && fact.message.includes("fact consumer failed")));
    expect(facts.find((fact) => fact.type === "providerError")).toMatchObject({ terminal: true });
    await manager.close();
  });

  test("fails the provider connection when open tool items exceed the adapter bound", async () => {
    const { facts, manager, processes } = harness();
    const providerThreadId = await startSession(manager);
    await startTurn(manager, providerThreadId);
    const process = processes[0];
    if (process === undefined) throw new Error("expected one Devin process");
    await waitFor(() => process.promptRequestId !== undefined);
    for (let index = 0; index < 257; index += 1) {
      process.sendUpdate({
        kind: "execute",
        sessionUpdate: "tool_call",
        status: "pending",
        title: `tool ${index}`,
        toolCallId: `tool-${index}`,
      });
    }
    await waitFor(() => process.terminated);
    await waitFor(() => facts.some((fact) =>
      fact.type === "providerError" && fact.message.includes("fact consumer failed")));
    expect(facts.find((fact) => fact.type === "providerError")).toMatchObject({ terminal: true });
    await manager.close();
  });

  test("fails the provider connection when assistant assemblers exceed the adapter bound", async () => {
    const { facts, manager, processes } = harness();
    const providerThreadId = await startSession(manager);
    await startTurn(manager, providerThreadId);
    const process = processes[0];
    if (process === undefined) throw new Error("expected one Devin process");
    await waitFor(() => process.promptRequestId !== undefined);
    for (let index = 0; index < 129; index += 1) {
      process.sendUpdate({
        content: { text: "x", type: "text" },
        messageId: `assistant-${index}`,
        sessionUpdate: "agent_message_chunk",
      });
    }
    await waitFor(() => process.terminated);
    await waitFor(() => facts.some((fact) =>
      fact.type === "providerError" && fact.message.includes("fact consumer failed")));
    expect(facts.find((fact) => fact.type === "providerError")).toMatchObject({ terminal: true });
    await manager.close();
  });
});
