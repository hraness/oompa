import { describe, expect, test } from "bun:test";

import type { AnyMessage } from "@agentclientprotocol/sdk";

import { DevinAcpClient } from "./client";
import type { DevinAcpProcess } from "./process";
import type { DevinFact } from "./protocol";

type JsonRecord = Record<string, unknown>;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

class FakeAcpProcess implements DevinAcpProcess {
  readonly stdin: WritableStream<Uint8Array>;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: AsyncIterable<Uint8Array> = {
    async *[Symbol.asyncIterator]() { /* No diagnostics. */ },
  };
  readonly exited: Promise<number>;
  readonly received: JsonRecord[] = [];
  terminated = false;
  forceTerminated = false;
  finishOnInputClose = true;
  ignoreTerminate = false;
  ignoreForceTerminate = false;
  outputChunksRead = 0;
  onOutputRead: () => void = () => undefined;
  onMessage: (message: JsonRecord) => void | Promise<void> = () => undefined;
  #stdout!: ReadableStreamDefaultController<Uint8Array>;
  #resolveExit!: (code: number) => void;
  #finished = false;
  #writeGate: Promise<void> | null = null;
  #releaseWriteGate: (() => void) | null = null;

  constructor() {
    this.stdout = new ReadableStream<Uint8Array>({
      start: (controller) => { this.#stdout = controller; },
    }).pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform: (chunk, controller) => {
        this.outputChunksRead += 1;
        this.onOutputRead();
        controller.enqueue(chunk);
      },
    }));
    this.exited = new Promise((resolve) => { this.#resolveExit = resolve; });
    this.stdin = new WritableStream({
      write: async (chunk) => {
        const writeGate = this.#writeGate;
        for (const line of decoder.decode(chunk).split("\n")) {
          if (line.trim().length === 0) continue;
          const value = JSON.parse(line) as unknown;
          if (value === null || typeof value !== "object" || Array.isArray(value)) {
            throw new Error("test client wrote a non-object frame");
          }
          const message = value as JsonRecord;
          this.received.push(message);
          await this.onMessage(message);
          await writeGate;
        }
      },
      close: () => { if (this.finishOnInputClose) this.finish(0); },
      abort: () => { this.finish(1); },
    });
  }

  blockWrites(): void {
    if (this.#writeGate !== null) throw new Error("test write gate is already blocked");
    this.#writeGate = new Promise((resolve) => { this.#releaseWriteGate = resolve; });
  }

  releaseWrites(): void {
    this.#releaseWriteGate?.();
    this.#releaseWriteGate = null;
    this.#writeGate = null;
  }

  send(message: AnyMessage): void {
    this.#stdout.enqueue(encoder.encode(`${JSON.stringify(message)}\n`));
  }

  sendRaw(bytes: Uint8Array): void {
    this.#stdout.enqueue(bytes);
  }

  finish(code: number): void {
    if (this.#finished) return;
    this.#finished = true;
    this.#stdout.close();
    this.#resolveExit(code);
  }

  terminate(): void {
    this.terminated = true;
    if (!this.ignoreTerminate) this.finish(143);
  }

  forceTerminate(): void {
    this.forceTerminated = true;
    if (!this.ignoreForceTerminate) this.finish(137);
  }
}

type TimedOutcome<Value> =
  | Readonly<{ status: "fulfilled"; value: Value }>
  | Readonly<{ status: "rejected"; reason: unknown }>
  | Readonly<{ status: "timeout" }>;

const outcomeWithin = async <Value>(
  promise: Promise<Value>,
  milliseconds = 200,
): Promise<TimedOutcome<Value>> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Readonly<{ status: "timeout" }>>((resolve) => {
    timer = setTimeout(() => resolve({ status: "timeout" }), milliseconds);
  });
  try {
    return await Promise.race([
      promise.then(
        (value) => ({ status: "fulfilled", value }) as const,
        (reason: unknown) => ({ status: "rejected", reason }) as const,
      ),
      timeout,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

const method = (message: JsonRecord): string | undefined =>
  typeof message.method === "string" ? message.method : undefined;
const requestId = (message: JsonRecord): string | number => {
  if (typeof message.id !== "string" && typeof message.id !== "number") {
    throw new Error("test expected a request id");
  }
  return message.id;
};

const startClient = async (
  fake: FakeAcpProcess,
  facts: DevinFact[],
  loadSession = true,
  observeFact?: (fact: DevinFact) => void | Promise<void>,
  options?: Readonly<{
    maximumPendingRequests?: number;
    maximumQueuedFrames?: number;
    maximumQueuedBytes?: number;
    shutdownGraceMs: number;
    shutdownForceJoinMs: number;
  }>,
): Promise<DevinAcpClient> => {
  fake.onMessage = (message) => {
    if (method(message) === "initialize") {
      fake.send({
        jsonrpc: "2.0",
        method: "_cognition.ai/hello",
        params: { arbitrary: "discarded" },
      });
      fake.send({
        jsonrpc: "2.0",
        id: requestId(message),
        result: { protocolVersion: 1, agentCapabilities: { loadSession } },
      });
    }
  };
  const client = new DevinAcpClient({
    process: fake,
    onFact: async (fact) => {
      facts.push(fact);
      await observeFact?.(fact);
    },
    ...options,
  });
  await client.start();
  return client;
};

describe("Devin ACP client", () => {
  test("initializes v1, tolerates vendor notifications, and drives new/prompt", async () => {
    const fake = new FakeAcpProcess();
    const facts: DevinFact[] = [];
    const client = await startClient(fake, facts);
    expect(Object.isFrozen(client.initialization)).toBe(true);
    fake.onMessage = (message) => {
      if (method(message) === "session/new") {
        fake.send({ jsonrpc: "2.0", id: requestId(message), result: { sessionId: "session-1" } });
      }
      if (method(message) === "session/prompt") {
        fake.send({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "session-1",
            update: {
              sessionUpdate: "agent_message_chunk",
              messageId: "message-1",
              content: { type: "text", text: "answer" },
            },
          },
        });
        fake.send({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "session-1",
            update: { sessionUpdate: "usage_update", used: 100, size: 1_000 },
          },
        });
        fake.send({ jsonrpc: "2.0", id: requestId(message), result: { stopReason: "end_turn" } });
      }
    };
    const sessionId = await client.newSession({ cwd: "/work/project" });
    await expect(client.prompt({ sessionId, text: "Do the work" })).resolves.toBe("end_turn");
    expect(facts).toEqual([
      {
        type: "protocolNotice",
        sessionId: null,
        method: "_cognition.ai/hello",
        disposition: "unknown_notification",
      },
      {
        type: "assistantDelta",
        sessionId: "session-1",
        messageId: "message-1",
        text: "answer",
      },
      { type: "usageUpdated", sessionId: "session-1", used: 100, size: 1_000, cost: null },
      { type: "turnStopped", sessionId: "session-1", stopReason: "end_turn" },
    ]);
    expect(fake.received[0]).toMatchObject({
      method: "initialize",
      params: {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
      },
    });
    expect(fake.received[1]).toMatchObject({
      method: "session/new",
      params: { cwd: "/work/project", mcpServers: [] },
    });
    expect(fake.received[2]).toMatchObject({
      method: "session/prompt",
      params: { sessionId: "session-1", prompt: [{ type: "text", text: "Do the work" }] },
    });
    await client.close();
  });

  test("loads only when the agent advertises loadSession", async () => {
    const fake = new FakeAcpProcess();
    const client = await startClient(fake, []);
    fake.onMessage = (message) => {
      if (method(message) === "session/load") {
        fake.send({ jsonrpc: "2.0", id: requestId(message), result: {} });
      }
    };
    await expect(client.loadSession({ sessionId: "restored", cwd: "/work/project" }))
      .resolves.toBeUndefined();
    await client.close();

    const unsupported = new FakeAcpProcess();
    const unsupportedClient = await startClient(unsupported, [], false);
    await expect(unsupportedClient.loadSession({ sessionId: "restored", cwd: "/work/project" }))
      .rejects.toMatchObject({ code: "UNSUPPORTED_CAPABILITY" });
    await unsupportedClient.close();
  });

  test("holds a permission request until an offered result is selected", async () => {
    const fake = new FakeAcpProcess();
    const facts: DevinFact[] = [];
    let resolvePermissionFact!: () => void;
    const permissionFact = new Promise<void>((resolve) => { resolvePermissionFact = resolve; });
    const client = await startClient(fake, facts, true, (fact) => {
      if (fact.type === "permissionRequested") resolvePermissionFact();
    });
    fake.onMessage = (message) => {
      if (method(message) === "session/new") {
        fake.send({ jsonrpc: "2.0", id: requestId(message), result: { sessionId: "session-1" } });
      }
    };
    await client.newSession({ cwd: "/work/project" });
    fake.send({
      jsonrpc: "2.0",
      id: "permission-1",
      method: "session/request_permission",
      params: {
        sessionId: "session-1",
        toolCall: { toolCallId: "tool-1", title: "Run tests", kind: "execute" },
        options: [
          { optionId: "once", name: "Allow once", kind: "allow_once" },
          { optionId: "reject", name: "Reject", kind: "reject_once" },
        ],
      },
    });
    await permissionFact;
    const fact = facts.find((entry) => entry.type === "permissionRequested");
    expect(fact).toMatchObject({ type: "permissionRequested", requestId: "s:permission-1" });
    await expect(client.resolvePermission({
      requestId: "s:permission-1",
      outcome: { outcome: "selected", optionId: "not-offered" },
    })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await client.resolvePermission({
      requestId: "s:permission-1",
      outcome: { outcome: "selected", optionId: "once" },
    });
    expect(fake.received.at(-1)).toEqual({
      jsonrpc: "2.0",
      id: "permission-1",
      result: { outcome: { outcome: "selected", optionId: "once" } },
    });
    await client.close();
  });

  test("admits only one response when a decision races with cancellation", async () => {
    const fake = new FakeAcpProcess();
    let permissionObserved!: () => void;
    const observed = new Promise<void>((resolve) => { permissionObserved = resolve; });
    const client = await startClient(fake, [], true, (fact) => {
      if (fact.type === "permissionRequested") permissionObserved();
    });
    fake.onMessage = (message) => {
      if (method(message) === "session/new") {
        fake.send({ jsonrpc: "2.0", id: requestId(message), result: { sessionId: "session-1" } });
      }
    };
    await client.newSession({ cwd: "/work/project" });
    fake.send({
      jsonrpc: "2.0",
      id: "racing-permission",
      method: "session/request_permission",
      params: {
        sessionId: "session-1",
        toolCall: { toolCallId: "tool-1" },
        options: [{ optionId: "once", name: "Allow once", kind: "allow_once" }],
      },
    });
    await observed;
    const decision = client.resolvePermission({
      requestId: "s:racing-permission",
      outcome: { outcome: "selected", optionId: "once" },
    });
    const cancellation = client.resolvePermission({
      requestId: "s:racing-permission",
      outcome: { outcome: "cancelled" },
    });
    try {
      await expect(cancellation).rejects.toMatchObject({ code: "INVALID_INPUT" });
      await decision;
      expect(fake.received.filter((message) => message.id === "racing-permission")).toEqual([
        {
          jsonrpc: "2.0",
          id: "racing-permission",
          result: { outcome: { outcome: "selected", optionId: "once" } },
        },
      ]);
    } finally {
      await Promise.allSettled([decision, cancellation]);
      await client.close();
    }
  });

  test("refuses concurrent prompts across the process", async () => {
    const fake = new FakeAcpProcess();
    const client = await startClient(fake, []);
    let sessionCount = 0;
    let firstPromptId: string | number | undefined;
    let resolveDispatched!: () => void;
    const dispatched = new Promise<void>((resolve) => { resolveDispatched = resolve; });
    fake.onMessage = (message) => {
      if (method(message) === "session/new") {
        sessionCount += 1;
        fake.send({
          jsonrpc: "2.0",
          id: requestId(message),
          result: { sessionId: `session-${sessionCount}` },
        });
      }
      if (method(message) === "session/prompt") {
        firstPromptId = requestId(message);
        resolveDispatched();
      }
    };
    await client.newSession({ cwd: "/work/project" });
    await client.newSession({ cwd: "/work/other" });
    const first = client.prompt({ sessionId: "session-1", text: "first" });
    await dispatched;
    await expect(client.prompt({ sessionId: "session-2", text: "second" }))
      .rejects.toThrow("concurrent prompts");
    fake.send({ jsonrpc: "2.0", id: firstPromptId ?? 0, result: { stopReason: "end_turn" } });
    await expect(first).resolves.toBe("end_turn");
    await client.close();
  });

  test("fails the client on malformed recognized updates and response bodies", async () => {
    const malformedUpdate = new FakeAcpProcess();
    const updateClient = await startClient(malformedUpdate, []);
    malformedUpdate.onMessage = (message) => {
      if (method(message) === "session/new") {
        malformedUpdate.send({
          jsonrpc: "2.0",
          id: requestId(message),
          result: { sessionId: "session-1" },
        });
      }
      if (method(message) === "session/prompt") {
        malformedUpdate.send({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "session-1",
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text" } },
          },
        });
      }
    };
    await updateClient.newSession({ cwd: "/work/project" });
    await expect(updateClient.prompt({ sessionId: "session-1", text: "test" }))
      .rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
    expect(malformedUpdate.terminated).toBe(true);
    await updateClient.close();

    const malformedResponse = new FakeAcpProcess();
    const responseClient = await startClient(malformedResponse, []);
    malformedResponse.onMessage = (message) => {
      if (method(message) === "session/new") {
        malformedResponse.send({ jsonrpc: "2.0", id: requestId(message), result: {} });
      }
    };
    await expect(responseClient.newSession({ cwd: "/work/project" }))
      .rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
    expect(malformedResponse.terminated).toBe(true);
    await responseClient.close();
  });

  test("bounds raw frames before SDK parsing", async () => {
    const fake = new FakeAcpProcess();
    const client = new DevinAcpClient({
      maximumFrameBytes: 128,
      onFact: () => undefined,
      process: fake,
    });
    const initialization = client.initialize();
    fake.sendRaw(new Uint8Array(129).fill(0x20));
    await expect(initialization).rejects.toMatchObject({ code: "PROTOCOL_LIMIT" });
    expect(fake.terminated).toBe(true);
    await client.close();
  });

  test("accepts chunked lines and rejects malformed JSON before SDK recovery", async () => {
    const chunked = new FakeAcpProcess();
    const chunkedClient = new DevinAcpClient({ onFact: () => undefined, process: chunked });
    const initialized = chunkedClient.initialize();
    const response = encoder.encode(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: { protocolVersion: 1 },
    }));
    const midpoint = Math.floor(response.byteLength / 2);
    chunked.sendRaw(response.slice(0, midpoint));
    chunked.sendRaw(encoder.encode(`${decoder.decode(response.slice(midpoint))}\n`));
    await expect(initialized).resolves.toEqual({ protocolVersion: 1, loadSession: false });
    await chunkedClient.close();

    const malformed = new FakeAcpProcess();
    const malformedClient = new DevinAcpClient({ onFact: () => undefined, process: malformed });
    const pending = malformedClient.initialize();
    malformed.sendRaw(encoder.encode("{not-json}\n"));
    await expect(pending).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
    expect(malformed.terminated).toBe(true);
    await malformedClient.close();
  });

  test("cancel closes pending permissions before notifying the session", async () => {
    const fake = new FakeAcpProcess();
    let permissionObserved!: () => void;
    const observed = new Promise<void>((resolve) => { permissionObserved = resolve; });
    const client = await startClient(fake, [], true, (fact) => {
      if (fact.type === "permissionRequested") permissionObserved();
    });
    fake.onMessage = (message) => {
      if (method(message) === "session/new") {
        fake.send({ jsonrpc: "2.0", id: requestId(message), result: { sessionId: "session-1" } });
      }
    };
    await client.newSession({ cwd: "/work/project" });
    fake.send({
      jsonrpc: "2.0",
      id: 77,
      method: "session/request_permission",
      params: {
        sessionId: "session-1",
        toolCall: { toolCallId: "tool-1" },
        options: [{ optionId: "reject", name: "Reject", kind: "reject_once" }],
      },
    });
    await observed;
    await client.cancel("session-1");
    expect(fake.received.slice(-2)).toEqual([
      { jsonrpc: "2.0", id: 77, result: { outcome: { outcome: "cancelled" } } },
      { jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "session-1" } },
    ]);
    await client.close();
  });

  test("projects a bounded provider error without leaking it through Error", async () => {
    const fake = new FakeAcpProcess();
    const facts: DevinFact[] = [];
    const client = await startClient(fake, facts);
    fake.onMessage = (message) => {
      if (method(message) === "session/new") {
        fake.send({
          jsonrpc: "2.0",
          id: requestId(message),
          error: { code: -32_000, message: "token=super-secret-value", data: { private: true } },
        });
      }
    };
    const failure = client.newSession({ cwd: "/work/project" });
    await expect(failure).rejects.toThrow("Devin rejected session/new");
    await expect(failure).rejects.not.toThrow("super-secret-value");
    expect(facts.at(-1)).toEqual({
      type: "providerError",
      sessionId: null,
      requestMethod: "session/new",
      code: -32_000,
      message: "[protected]",
      terminal: false,
    });
    await client.close();
  });

  test("reaches forced process cleanup while protocol shutdown writes are backpressured", async () => {
    const fake = new FakeAcpProcess();
    const client = await startClient(fake, [], true, undefined, {
      shutdownGraceMs: 5,
      shutdownForceJoinMs: 10,
    });
    let promptDispatched!: () => void;
    const dispatched = new Promise<void>((resolve) => { promptDispatched = resolve; });
    fake.onMessage = (message) => {
      if (method(message) === "session/new") {
        fake.send({ jsonrpc: "2.0", id: requestId(message), result: { sessionId: "session-1" } });
      }
      if (method(message) === "session/prompt") promptDispatched();
    };
    await client.newSession({ cwd: "/work/project" });
    const prompt = client.prompt({ sessionId: "session-1", text: "keep running" });
    const promptOutcome = outcomeWithin(prompt);
    await dispatched;
    fake.ignoreTerminate = true;
    fake.blockWrites();

    const firstClose = client.close();
    const secondClose = client.close();
    try {
      expect(firstClose).toBe(secondClose);
      expect(await outcomeWithin(firstClose)).toMatchObject({ status: "fulfilled" });
      expect(await outcomeWithin(secondClose)).toMatchObject({ status: "fulfilled" });
      expect(await promptOutcome).toMatchObject({
        status: "rejected",
        reason: { code: "PROCESS_EXITED" },
      });
      expect(fake.terminated).toBe(true);
      expect(fake.forceTerminated).toBe(true);
    } finally {
      fake.releaseWrites();
      await Promise.allSettled([firstClose, secondClose, prompt]);
    }
  });

  test("shares a failed bounded close outcome across concurrent callers", async () => {
    const fake = new FakeAcpProcess();
    const client = await startClient(fake, [], true, undefined, {
      shutdownGraceMs: 5,
      shutdownForceJoinMs: 10,
    });
    fake.finishOnInputClose = false;
    fake.ignoreTerminate = true;
    fake.ignoreForceTerminate = true;
    const observedClosed = client.closed;

    const firstClose = client.close();
    const secondClose = client.close();
    const outcomes = await Promise.all([
      outcomeWithin(firstClose),
      outcomeWithin(secondClose),
      outcomeWithin(observedClosed),
    ]);
    try {
      expect(firstClose).toBe(secondClose);
      for (const outcome of outcomes) {
        expect(outcome).toMatchObject({
          status: "rejected",
          reason: {
            code: "PROCESS_EXITED",
            message: "Devin ACP process could not be joined after forced termination",
          },
        });
      }
      expect(fake.terminated).toBe(true);
      expect(fake.forceTerminated).toBe(true);
    } finally {
      fake.finish(137);
      await Promise.allSettled([firstClose, secondClose, observedClosed]);
    }
  });

  test("fails closed when valid permission requests exceed the per-process bound", async () => {
    const fake = new FakeAcpProcess();
    const facts: DevinFact[] = [];
    fake.onMessage = (message) => {
      if (method(message) === "initialize") {
        fake.send({
          jsonrpc: "2.0",
          id: requestId(message),
          result: { protocolVersion: 1, agentCapabilities: { loadSession: true } },
        });
      }
    };
    const client = new DevinAcpClient({
      maximumPendingPermissions: 2,
      onFact: (fact) => { facts.push(fact); },
      process: fake,
      shutdownGraceMs: 5,
      shutdownForceJoinMs: 10,
    });
    await client.initialize();
    fake.onMessage = (message) => {
      if (method(message) === "session/new") {
        fake.send({ jsonrpc: "2.0", id: requestId(message), result: { sessionId: "session-1" } });
      }
    };
    await client.newSession({ cwd: "/work/project" });
    for (let index = 0; index < 3; index += 1) {
      fake.send({
        jsonrpc: "2.0",
        id: `permission-${index}`,
        method: "session/request_permission",
        params: {
          sessionId: "session-1",
          toolCall: { toolCallId: `tool-${index}` },
          options: [{ optionId: "reject", name: "Reject", kind: "reject_once" }],
        },
      });
    }
    try {
      expect(await outcomeWithin(client.closed)).toMatchObject({ status: "fulfilled" });
      await expect(client.newSession({ cwd: "/work/other" }))
        .rejects.toMatchObject({ code: "PROTOCOL_LIMIT" });
      expect(facts.filter((fact) => fact.type === "permissionRequested")).toHaveLength(2);
      expect(fake.terminated).toBe(true);
    } finally {
      await client.close().catch(() => undefined);
    }
  });

  test("fails closed when pending outbound requests exceed the per-process bound", async () => {
    const fake = new FakeAcpProcess();
    const client = new DevinAcpClient({
      maximumPendingRequests: 2,
      onFact: () => undefined,
      process: fake,
      shutdownGraceMs: 5,
      shutdownForceJoinMs: 10,
    });
    fake.onMessage = (message) => {
      if (method(message) === "initialize") {
        fake.send({ jsonrpc: "2.0", id: requestId(message), result: { protocolVersion: 1 } });
      }
    };
    await client.initialize();
    fake.onMessage = () => undefined;
    const requests = [
      client.newSession({ cwd: "/work/one" }),
      client.newSession({ cwd: "/work/two" }),
      client.newSession({ cwd: "/work/three" }),
    ];
    const allOutcomes = Promise.allSettled(requests);
    try {
      const bounded = await outcomeWithin(allOutcomes);
      expect(bounded.status).toBe("fulfilled");
      if (bounded.status !== "fulfilled") return;
      expect(bounded.value).toHaveLength(3);
      for (const outcome of bounded.value) {
        expect(outcome).toMatchObject({
          status: "rejected",
          reason: { code: "PROTOCOL_LIMIT" },
        });
      }
      expect(fake.terminated).toBe(true);
    } finally {
      await client.close().catch(() => undefined);
      await allOutcomes;
    }
  });

  test("settles an aborted request even when Devin ignores cancellation and frees its slot", async () => {
    const fake = new FakeAcpProcess();
    const client = await startClient(fake, [], true, undefined, {
      maximumPendingRequests: 1,
      shutdownGraceMs: 5,
      shutdownForceJoinMs: 10,
    });
    const controller = new AbortController();
    let cancelObserved!: () => void;
    const canceled = new Promise<void>((resolve) => { cancelObserved = resolve; });
    fake.onMessage = (message) => {
      if (method(message) === "session/new" && !controller.signal.aborted) {
        controller.abort();
      }
      if (method(message) === "$/cancel_request") cancelObserved();
    };
    await expect(client.newSession({
      cwd: "/work/aborted",
      signal: controller.signal,
    })).rejects.toMatchObject({
      code: "PROCESS_EXITED",
      message: "Devin ACP request was canceled",
    });
    await expect(outcomeWithin(canceled)).resolves.toMatchObject({ status: "fulfilled" });
    expect(fake.received.at(-1)).toMatchObject({
      jsonrpc: "2.0",
      method: "$/cancel_request",
      params: { requestId: 2 },
    });
    fake.send({
      jsonrpc: "2.0",
      id: 2,
      result: { sessionId: "ignored-canceled-session" },
    });

    fake.onMessage = (message) => {
      if (method(message) === "session/new") {
        fake.send({ jsonrpc: "2.0", id: requestId(message), result: { sessionId: "session-2" } });
      }
    };
    await expect(client.newSession({ cwd: "/work/retry" })).resolves.toBe("session-2");
    await client.close();
  });

  test("settles an aborted request while its original write remains backpressured", async () => {
    const fake = new FakeAcpProcess();
    const client = await startClient(fake, [], true, undefined, {
      shutdownGraceMs: 5,
      shutdownForceJoinMs: 10,
    });
    const controller = new AbortController();
    let requestDispatched!: () => void;
    const dispatched = new Promise<void>((resolve) => { requestDispatched = resolve; });
    fake.onMessage = (message) => {
      if (method(message) === "session/new") requestDispatched();
    };
    fake.blockWrites();
    const request = client.newSession({ cwd: "/work/blocked", signal: controller.signal });
    await dispatched;
    controller.abort();
    try {
      expect(await outcomeWithin(request)).toMatchObject({
        status: "rejected",
        reason: { code: "PROCESS_EXITED", message: "Devin ACP request was canceled" },
      });
    } finally {
      fake.releaseWrites();
      await client.close();
      await request.catch(() => undefined);
    }
  });

  test.each([
    { label: "frame", maximumQueuedFrames: 2 },
    { label: "byte", maximumQueuedBytes: 256 },
  ])("backpressures the SDK at its $label budget until facts are consumed", async (limits) => {
    const fake = new FakeAcpProcess();
    let releaseConsumer!: () => void;
    const consumerGate = new Promise<void>((resolve) => { releaseConsumer = resolve; });
    let allConsumed!: () => void;
    const consumed = new Promise<void>((resolve) => { allConsumed = resolve; });
    const count = 40;
    let observed = 0;
    const client = await startClient(fake, [], true, async (fact) => {
      if (fact.type !== "protocolNotice" || fact.method !== "_burst") return;
      if (observed === 0) await consumerGate;
      observed += 1;
      if (observed === count) allConsumed();
    }, { ...limits, shutdownGraceMs: 5, shutdownForceJoinMs: 10 });
    const initialReadCount = fake.outputChunksRead;
    let allRead!: () => void;
    const read = new Promise<void>((resolve) => { allRead = resolve; });
    fake.onOutputRead = () => {
      if (fake.outputChunksRead === initialReadCount + count) allRead();
    };
    for (let index = 0; index < count; index += 1) {
      fake.send({ jsonrpc: "2.0", method: "_burst", params: { body: "x".repeat(64) } });
    }
    try {
      expect(await outcomeWithin(read, 30)).toEqual({ status: "timeout" });
      expect(fake.outputChunksRead - initialReadCount).toBeLessThan(count);
      releaseConsumer();
      expect(await outcomeWithin(consumed)).toEqual({ status: "fulfilled", value: undefined });
      expect(observed).toBe(count);
      expect(fake.terminated).toBe(false);
    } finally {
      releaseConsumer();
      await client.close();
    }
  });
});
