import { isAbsolute, normalize } from "node:path";

import {
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type AnyMessage,
  type InitializeRequest,
  type LoadSessionRequest,
  type NewSessionRequest,
  type PromptRequest,
  type RequestPermissionResponse,
} from "@agentclientprotocol/sdk";

import { DevinError } from "./errors.ts";
import { DEVIN_ACP_PROTOCOL_VERSION } from "./pin.ts";
import type { DevinAcpProcess } from "./process.ts";
import {
  boundedDevinCwd,
  boundedDevinPrompt,
  boundedDevinRequestKey,
  boundedDevinSessionId,
  DEVIN_ACP_MAX_FRAME_BYTES,
  devinRequestKey,
  parseDevinInboundMessage,
  parseDevinInitializeResponse,
  parseDevinLoadSessionResponse,
  parseDevinNewSessionResponse,
  parseDevinPermissionRequest,
  parseDevinPromptResponse,
  parseDevinSessionUpdate,
  validateDevinPermissionOutcome,
  type DevinFact,
  type DevinInitialization,
  type DevinPermissionOption,
  type DevinPermissionOutcome,
  type DevinStopReason,
} from "./protocol.ts";

export interface DevinAcpClientOptions {
  readonly process: DevinAcpProcess;
  readonly onFact: (fact: DevinFact) => void | Promise<void>;
  readonly maximumFrameBytes?: number;
  readonly maximumPendingPermissions?: number;
  readonly maximumPendingRequests?: number;
  readonly maximumQueuedFrames?: number;
  readonly maximumQueuedBytes?: number;
  readonly maximumStderrBytes?: number;
  readonly shutdownGraceMs?: number;
  readonly shutdownForceJoinMs?: number;
}

export interface DevinAcpCallOptions {
  readonly signal?: AbortSignal;
}

export interface DevinNewSessionOptions extends DevinAcpCallOptions {
  readonly cwd: string;
}

export interface DevinLoadSessionOptions extends DevinAcpCallOptions {
  readonly sessionId: string;
  readonly cwd: string;
}

export interface DevinPromptOptions extends DevinAcpCallOptions {
  readonly sessionId: string;
  readonly text: string;
}

export interface DevinResolvePermissionOptions {
  readonly requestId: string;
  readonly outcome: DevinPermissionOutcome;
}

interface PendingRequest {
  readonly method: string;
  readonly sessionId: string | null;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: DevinError) => void;
  readonly signal: AbortSignal | undefined;
  readonly onAbort: (() => void) | undefined;
}

interface PendingPermission {
  readonly wireId: string | number;
  readonly sessionId: string;
  readonly options: readonly DevinPermissionOption[];
}

const DEFAULT_STDERR_MAX_BYTES = 64 * 1024;
const DEFAULT_MAX_PENDING_PERMISSIONS = 64;
const DEFAULT_MAX_PENDING_REQUESTS = 128;
const DEFAULT_MAX_QUEUED_FRAMES = 128;
const DEFAULT_MAX_QUEUED_BYTES = 2 * 1024 * 1024;
const DEFAULT_SHUTDOWN_GRACE_MS = 500;
const DEFAULT_FORCE_JOIN_MS = 1_000;

const boundedPositiveInteger = (value: number, label: string, maximum: number): number => {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new DevinError("INVALID_INPUT", `${label} must be a bounded positive integer`);
  }
  return value;
};

const wait = (milliseconds: number): Promise<false> => new Promise((resolve) => {
  const timer = setTimeout(() => resolve(false), milliseconds);
  timer.unref();
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * The SDK intentionally recovers from malformed NDJSON. HRA's provider seam is
 * stricter: it withholds each line until its byte bound, UTF-8, JSON, and ACP
 * v1 no-batch shape have been checked.
 */
export function boundedDevinAcpInput(
  source: ReadableStream<Uint8Array>,
  maximumFrameBytes = DEVIN_ACP_MAX_FRAME_BYTES,
  reserveFrame?: (byteLength: number) => Promise<void>,
): ReadableStream<Uint8Array> {
  boundedPositiveInteger(maximumFrameBytes, "Devin ACP frame limit", 16 * 1024 * 1024);
  let pending = new Uint8Array();
  const validate = (line: Uint8Array): boolean => {
    if (line.byteLength > maximumFrameBytes) {
      throw new DevinError("PROTOCOL_LIMIT", "Devin ACP frame exceeded its byte limit");
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(line).trim();
    } catch (error: unknown) {
      throw new DevinError("PROTOCOL_ERROR", "Devin ACP frame was not valid UTF-8", {
        cause: error,
      });
    }
    if (text.length === 0) return false;
    let value: unknown;
    try {
      value = JSON.parse(text) as unknown;
    } catch (error: unknown) {
      throw new DevinError("PROTOCOL_ERROR", "Devin ACP frame was not valid JSON", {
        cause: error,
      });
    }
    if (!isRecord(value)) {
      throw new DevinError("PROTOCOL_ERROR", "Devin ACP v1 frame must be one JSON object");
    }
    return true;
  };
  const transform = new TransformStream<Uint8Array, Uint8Array>({
    async transform(chunk, controller) {
      let start = 0;
      for (let index = 0; index < chunk.byteLength; index += 1) {
        if (chunk[index] !== 0x0a) continue;
        const segment = chunk.subarray(start, index);
        if (pending.byteLength + segment.byteLength > maximumFrameBytes) {
          throw new DevinError("PROTOCOL_LIMIT", "Devin ACP frame exceeded its byte limit");
        }
        const line = new Uint8Array(pending.byteLength + segment.byteLength);
        line.set(pending);
        line.set(segment, pending.byteLength);
        if (validate(line)) await reserveFrame?.(line.byteLength);
        const framed = new Uint8Array(line.byteLength + 1);
        framed.set(line);
        framed[line.byteLength] = 0x0a;
        controller.enqueue(framed);
        pending = new Uint8Array();
        start = index + 1;
      }
      const remainder = chunk.subarray(start);
      if (pending.byteLength + remainder.byteLength > maximumFrameBytes) {
        throw new DevinError("PROTOCOL_LIMIT", "Devin ACP frame exceeded its byte limit");
      }
      if (remainder.byteLength > 0) {
        const joined = new Uint8Array(pending.byteLength + remainder.byteLength);
        joined.set(pending);
        joined.set(remainder, pending.byteLength);
        pending = joined;
      }
    },
    async flush(controller) {
      if (pending.byteLength === 0) return;
      if (validate(pending)) await reserveFrame?.(pending.byteLength);
      controller.enqueue(pending);
      pending = new Uint8Array();
    },
  });
  return source.pipeThrough(transform);
}

const canonicalCwd = (value: string): string => {
  const cwd = boundedDevinCwd(value);
  if (!isAbsolute(cwd) || normalize(cwd) !== cwd) {
    throw new DevinError("INVALID_INPUT", "Devin session cwd must be an absolute normalized path");
  }
  return cwd;
};

export class DevinAcpClient {
  readonly #process: DevinAcpProcess;
  readonly #onFact: DevinAcpClientOptions["onFact"];
  readonly #writer: WritableStreamDefaultWriter<AnyMessage>;
  readonly #reader: ReadableStreamDefaultReader<AnyMessage>;
  readonly #pending = new Map<string, PendingRequest>();
  readonly #canceledRequests = new Set<string>();
  readonly #permissions = new Map<string, PendingPermission>();
  readonly #sessions = new Set<string>();
  readonly #activePrompts = new Set<string>();
  readonly #shutdownGraceMs: number;
  readonly #shutdownForceJoinMs: number;
  readonly #maximumPendingPermissions: number;
  readonly #maximumPendingRequests: number;
  readonly #maximumQueuedFrames: number;
  readonly #maximumQueuedBytes: number;
  readonly #queuedFrameBytes: number[] = [];
  #queuedBytes = 0;
  #frameCapacityWaiter: { resolve(): void; reject(error: DevinError): void } | null = null;
  readonly #maximumStderrBytes: number;
  readonly #readerTask: Promise<void>;
  readonly #stderrTask: Promise<void>;
  readonly #exit: Promise<number>;
  readonly #closed: Promise<void>;
  #resolveClosed!: () => void;
  #rejectClosed!: (error: unknown) => void;
  #closeTask: Promise<void> | null = null;
  #nextRequestId = 1;
  #initialization: DevinInitialization | null = null;
  #initializing = false;
  #state: "open" | "closing" | "closed" = "open";
  #failure: DevinError | null = null;
  #exitResolved = false;

  constructor(options: DevinAcpClientOptions) {
    const sdkProtocolVersion: number = PROTOCOL_VERSION;
    if (sdkProtocolVersion !== DEVIN_ACP_PROTOCOL_VERSION) {
      throw new DevinError("RUNTIME_MISMATCH", "the installed ACP SDK does not implement v1");
    }
    const maximumFrameBytes = boundedPositiveInteger(
      options.maximumFrameBytes ?? DEVIN_ACP_MAX_FRAME_BYTES,
      "Devin ACP frame limit",
      16 * 1024 * 1024,
    );
    this.#maximumStderrBytes = boundedPositiveInteger(
      options.maximumStderrBytes ?? DEFAULT_STDERR_MAX_BYTES,
      "Devin stderr limit",
      1024 * 1024,
    );
    this.#maximumPendingPermissions = boundedPositiveInteger(
      options.maximumPendingPermissions ?? DEFAULT_MAX_PENDING_PERMISSIONS,
      "Devin pending permission limit",
      4_096,
    );
    this.#maximumPendingRequests = boundedPositiveInteger(
      options.maximumPendingRequests ?? DEFAULT_MAX_PENDING_REQUESTS,
      "Devin pending request limit",
      4_096,
    );
    this.#maximumQueuedFrames = boundedPositiveInteger(
      options.maximumQueuedFrames ?? DEFAULT_MAX_QUEUED_FRAMES,
      "Devin queued frame limit",
      4_096,
    );
    this.#maximumQueuedBytes = boundedPositiveInteger(
      options.maximumQueuedBytes ?? Math.max(DEFAULT_MAX_QUEUED_BYTES, maximumFrameBytes),
      "Devin queued byte limit",
      64 * 1024 * 1024,
    );
    this.#shutdownGraceMs = boundedPositiveInteger(
      options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS,
      "Devin shutdown grace",
      10_000,
    );
    this.#shutdownForceJoinMs = boundedPositiveInteger(
      options.shutdownForceJoinMs ?? DEFAULT_FORCE_JOIN_MS,
      "Devin forced join deadline",
      10_000,
    );
    this.#process = options.process;
    this.#onFact = options.onFact;
    const stream = ndJsonStream(
      options.process.stdin,
      boundedDevinAcpInput(
        options.process.stdout,
        maximumFrameBytes,
        (byteLength) => this.#reserveFrame(byteLength),
      ),
    );
    this.#writer = stream.writable.getWriter();
    this.#reader = stream.readable.getReader();
    this.#closed = new Promise((resolve, reject) => {
      this.#resolveClosed = resolve;
      this.#rejectClosed = reject;
    });
    // A failed automatic cleanup remains observable through `closed` without
    // becoming an unhandled rejection when the process owner uses `close()`.
    void this.#closed.catch(() => undefined);
    this.#exit = options.process.exited.then(
      (code) => {
        this.#exitResolved = true;
        if (this.#state === "open") {
          this.#fail(new DevinError("PROCESS_EXITED", "Devin ACP process exited unexpectedly"));
        }
        return code;
      },
      (error: unknown) => {
        this.#fail(new DevinError("PROCESS_EXITED", "Devin ACP process exit could not be observed", {
          cause: error,
        }));
        throw error;
      },
    );
    // The two drains are started during construction so neither child pipe can
    // deadlock while an RPC is waiting.
    this.#readerTask = this.#readLoop();
    this.#stderrTask = this.#drainStderr();
    void this.#readerTask.catch(() => undefined);
    void this.#stderrTask.catch(() => undefined);
    void this.#exit.catch(() => undefined);
  }

  get closed(): Promise<void> { return this.#closed; }
  get initialization(): DevinInitialization | null { return this.#initialization; }

  /** Alias useful to process managers; initialization remains explicit and one-shot. */
  start(options: DevinAcpCallOptions = {}): Promise<DevinInitialization> {
    return this.initialize(options);
  }

  async initialize(options: DevinAcpCallOptions = {}): Promise<DevinInitialization> {
    this.#assertOpen();
    if (this.#initialization !== null || this.#initializing) {
      throw new DevinError("INVALID_INPUT", "Devin ACP client initialization is already active");
    }
    const params: InitializeRequest = {
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: "hra", version: "0.6.0" },
      protocolVersion: DEVIN_ACP_PROTOCOL_VERSION,
    };
    this.#initializing = true;
    try {
      const result = await this.#request(methods.agent.initialize, params, null, options.signal);
      const initialization = Object.freeze(
        this.#parseResponse(() => parseDevinInitializeResponse(result)),
      );
      this.#initialization = initialization;
      return initialization;
    } finally {
      this.#initializing = false;
    }
  }

  async newSession(options: DevinNewSessionOptions): Promise<string> {
    this.#assertInitialized();
    const params: NewSessionRequest = { cwd: canonicalCwd(options.cwd), mcpServers: [] };
    const result = await this.#request(methods.agent.session.new, params, null, options.signal);
    const sessionId = this.#parseResponse(() => parseDevinNewSessionResponse(result));
    if (this.#sessions.has(sessionId)) {
      throw this.#terminalProtocolFailure("Devin returned a duplicate session id");
    }
    this.#sessions.add(sessionId);
    return sessionId;
  }

  async loadSession(options: DevinLoadSessionOptions): Promise<void> {
    const initialization = this.#assertInitialized();
    if (!initialization.loadSession) {
      throw new DevinError("UNSUPPORTED_CAPABILITY", "Devin did not advertise session/load");
    }
    const sessionId = boundedDevinSessionId(options.sessionId);
    const params: LoadSessionRequest = {
      cwd: canonicalCwd(options.cwd),
      mcpServers: [],
      sessionId,
    };
    const result = await this.#request(methods.agent.session.load, params, sessionId, options.signal);
    this.#parseResponse(() => parseDevinLoadSessionResponse(result));
    this.#sessions.add(sessionId);
  }

  async prompt(options: DevinPromptOptions): Promise<DevinStopReason> {
    this.#assertInitialized();
    const sessionId = this.#knownSession(options.sessionId);
    if (this.#activePrompts.size > 0) {
      throw new DevinError("INVALID_INPUT", "Devin does not support concurrent prompts");
    }
    const params: PromptRequest = {
      prompt: [{ text: boundedDevinPrompt(options.text), type: "text" }],
      sessionId,
    };
    this.#activePrompts.add(sessionId);
    try {
      const result = await this.#request(methods.agent.session.prompt, params, sessionId, options.signal);
      const stopReason = this.#parseResponse(() => parseDevinPromptResponse(result));
      await this.#emit({ sessionId, stopReason, type: "turnStopped" });
      return stopReason;
    } finally {
      this.#activePrompts.delete(sessionId);
    }
  }

  async cancel(sessionIdInput: string): Promise<void> {
    this.#assertInitialized();
    const sessionId = this.#knownSession(sessionIdInput);
    for (const [requestId, permission] of this.#permissions) {
      if (permission.sessionId === sessionId) {
        await this.#resolvePermission(requestId, { outcome: "cancelled" });
      }
    }
    await this.#notify(methods.agent.session.cancel, { sessionId });
  }

  resolvePermission(options: DevinResolvePermissionOptions): Promise<void> {
    this.#assertOpen();
    return this.#resolvePermission(options.requestId, options.outcome);
  }

  close(): Promise<void> {
    return this.#beginClose();
  }

  #beginClose(): Promise<void> {
    if (this.#closeTask !== null) return this.#closeTask;
    const task = this.#close();
    this.#closeTask = task;
    void task.then(this.#resolveClosed, this.#rejectClosed);
    return task;
  }

  async #close(): Promise<void> {
    if (this.#state === "closed") return;
    this.#state = "closing";
    const closedError = new DevinError("PROCESS_EXITED", "Devin ACP client was closed");
    this.#rejectPending(closedError);
    this.#frameCapacityWaiter?.reject(closedError);
    this.#frameCapacityWaiter = null;

    // Protocol courtesy writes are best-effort. Process reaping starts first
    // and advances on its own deadlines even when the provider has stopped
    // reading stdin and every write below remains backpressured forever.
    const processJoin = this.#stopAndJoinProcess();
    const protocolCleanup = this.#bestEffortProtocolCleanup();
    void protocolCleanup.catch(() => undefined);
    let processJoined = false;
    let outputDrained = false;
    try {
      processJoined = await processJoin;
      const drained = await Promise.race([
        Promise.allSettled([this.#readerTask, this.#stderrTask]).then(() => true),
        wait(this.#shutdownForceJoinMs),
      ]);
      outputDrained = drained;
      if (!processJoined) {
        throw new DevinError("PROCESS_EXITED", "Devin ACP process could not be joined after forced termination");
      }
      if (!outputDrained) {
        throw new DevinError("PROCESS_EXITED", "Devin ACP output could not be drained after termination");
      }
    } finally {
      this.#canceledRequests.clear();
      this.#permissions.clear();
      this.#activePrompts.clear();
      this.#queuedFrameBytes.length = 0;
      this.#queuedBytes = 0;
      this.#state = "closed";
    }
  }

  async #stopAndJoinProcess(): Promise<boolean> {
    if (!this.#exitResolved) {
      try { this.#process.terminate(); } catch { /* Force below. */ }
      await Promise.race([this.#exit.catch(() => -1), wait(this.#shutdownGraceMs)]);
    }
    if (!this.#exitResolved) {
      try { this.#process.forceTerminate(); } catch { /* Bounded join below. */ }
      await Promise.race([this.#exit.catch(() => -1), wait(this.#shutdownForceJoinMs)]);
    }
    return this.#exitResolved;
  }

  async #bestEffortProtocolCleanup(): Promise<void> {
    for (const sessionId of this.#activePrompts) {
      await this.#write({
        jsonrpc: "2.0",
        method: methods.agent.session.cancel,
        params: { sessionId },
      }, true).catch(() => undefined);
    }
    for (const requestId of [...this.#permissions.keys()]) {
      await this.#resolvePermission(requestId, { outcome: "cancelled" }, true)
        .catch(() => undefined);
    }
    await this.#writer.close().catch(() => undefined);
  }

  #assertOpen(): void {
    if (this.#failure !== null) throw this.#failure;
    if (this.#state !== "open") throw new DevinError("PROCESS_EXITED", "Devin ACP client is closed");
  }

  #assertInitialized(): DevinInitialization {
    this.#assertOpen();
    if (this.#initialization === null) {
      throw new DevinError("INVALID_INPUT", "Devin ACP client has not been initialized");
    }
    return this.#initialization;
  }

  #knownSession(input: string): string {
    const sessionId = boundedDevinSessionId(input);
    if (!this.#sessions.has(sessionId)) {
      throw new DevinError("INVALID_INPUT", "Devin session is not owned by this client");
    }
    return sessionId;
  }

  async #request(
    method: string,
    params: unknown,
    sessionId: string | null,
    signal: AbortSignal | undefined,
  ): Promise<unknown> {
    this.#assertOpen();
    if (signal?.aborted === true) {
      throw new DevinError("PROCESS_EXITED", "Devin ACP request was canceled before dispatch");
    }
    if (this.#pending.size >= this.#maximumPendingRequests) {
      throw this.#terminalLimitFailure("Devin ACP exceeded its pending request limit");
    }
    if (this.#nextRequestId > Number.MAX_SAFE_INTEGER) {
      throw this.#terminalProtocolFailure("Devin ACP request id space was exhausted");
    }
    const id = this.#nextRequestId;
    this.#nextRequestId += 1;
    const key = devinRequestKey(id);
    let resolve!: (value: unknown) => void;
    let reject!: (error: DevinError) => void;
    const response = new Promise<unknown>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    // Cancellation can settle this promise while the original frame is still
    // backpressured. Keep that rejection observed until the caller receives it.
    void response.catch(() => undefined);
    const dispatchState: { aborted: boolean; promise: Promise<void> | null } = {
      aborted: false,
      promise: null,
    };
    const scheduleCancel = (dispatched: Promise<void>): void => {
      void dispatched.then(
        () => this.#notify(methods.protocol.cancelRequest, { requestId: id }),
        () => undefined,
      ).catch(() => undefined);
    };
    const onAbort = signal === undefined
      ? undefined
      : () => {
          if (!this.#pending.has(key)) return;
          if (this.#canceledRequests.size >= this.#maximumPendingRequests) {
            this.#terminalLimitFailure("Devin ACP exceeded its canceled request response limit");
            return;
          }
          this.#canceledRequests.add(key);
          dispatchState.aborted = true;
          this.#takePending(key)?.reject(
            new DevinError("PROCESS_EXITED", "Devin ACP request was canceled"),
          );
          if (dispatchState.promise !== null) scheduleCancel(dispatchState.promise);
        };
    this.#pending.set(key, { method, onAbort, reject, resolve, sessionId, signal });
    if (signal !== undefined && onAbort !== undefined) {
      signal.addEventListener("abort", onAbort, { once: true });
    }
    const dispatch = this.#write({ id, jsonrpc: "2.0", method, params });
    dispatchState.promise = dispatch;
    if (dispatchState.aborted) scheduleCancel(dispatch);
    void dispatch.catch((error: unknown) => {
      const pending = this.#takePending(key);
      pending?.reject(error instanceof DevinError
        ? error
        : new DevinError("PROCESS_EXITED", "Devin ACP request could not be written", { cause: error }));
    });
    return response;
  }

  async #reserveFrame(byteLength: number): Promise<void> {
    if (byteLength > this.#maximumQueuedBytes) {
      throw new DevinError("PROTOCOL_LIMIT", "Devin ACP frame exceeded its queued byte limit");
    }
    this.#assertOpen();
    while (
      this.#queuedFrameBytes.length >= this.#maximumQueuedFrames
      || this.#queuedBytes + byteLength > this.#maximumQueuedBytes
    ) {
      // The input transform is serial, so at most one frame can wait here.
      // Reserving before the SDK reads the frame prevents its eager parser
      // from retaining unbounded output behind a slow fact consumer.
      await new Promise<void>((resolve, reject) => {
        this.#frameCapacityWaiter = { reject, resolve };
      });
      this.#assertOpen();
    }
    this.#queuedFrameBytes.push(byteLength);
    this.#queuedBytes += byteLength;
  }

  #releaseFrame(): void {
    const byteLength = this.#queuedFrameBytes.shift();
    if (byteLength !== undefined) this.#queuedBytes -= byteLength;
    this.#frameCapacityWaiter?.resolve();
    this.#frameCapacityWaiter = null;
  }

  #takePending(key: string): PendingRequest | undefined {
    const pending = this.#pending.get(key);
    if (pending === undefined) return undefined;
    this.#pending.delete(key);
    if (pending.signal !== undefined && pending.onAbort !== undefined) {
      pending.signal.removeEventListener("abort", pending.onAbort);
    }
    return pending;
  }

  async #notify(method: string, params: unknown): Promise<void> {
    await this.#write({ jsonrpc: "2.0", method, params });
  }

  async #write(message: AnyMessage, allowClosing = false): Promise<void> {
    if (!allowClosing) this.#assertOpen();
    if (allowClosing && this.#state === "closed") {
      throw new DevinError("PROCESS_EXITED", "Devin ACP client is closed");
    }
    try {
      await this.#writer.write(message);
    } catch (error: unknown) {
      const failure = new DevinError("PROCESS_EXITED", "Devin ACP transport write failed", {
        cause: error,
      });
      this.#fail(failure);
      throw failure;
    }
  }

  async #readLoop(): Promise<void> {
    try {
      let next = await this.#reader.read();
      while (!next.done) {
        try {
          await this.#handleMessage(next.value);
        } finally {
          this.#releaseFrame();
        }
        next = await this.#reader.read();
      }
      if (this.#state === "open") {
        throw new DevinError("PROCESS_EXITED", "Devin ACP output closed unexpectedly");
      }
    } catch (error: unknown) {
      if (this.#state === "open") {
        this.#fail(error instanceof DevinError
          ? error
          : new DevinError("PROTOCOL_ERROR", "Devin ACP reader failed"));
      }
      throw error;
    }
  }

  async #handleMessage(raw: unknown): Promise<void> {
    const message = parseDevinInboundMessage(raw);
    if (message.kind === "response" || message.kind === "errorResponse") {
      const key = devinRequestKey(message.id);
      const pending = this.#takePending(key);
      if (pending === undefined) {
        // ACP requires the agent to answer even after a cancellation request.
        // Consume exactly one response for a bounded canceled-id tombstone.
        if (this.#canceledRequests.delete(key)) return;
        throw new DevinError("PROTOCOL_ERROR", "Devin returned an unknown or duplicate response id");
      }
      if (message.kind === "response") {
        pending.resolve(message.result);
      } else {
        pending.reject(new DevinError("PROTOCOL_ERROR", `Devin rejected ${pending.method}`));
        await this.#emit({
          code: message.error.code,
          message: message.error.message,
          requestMethod: pending.method,
          sessionId: pending.sessionId,
          terminal: false,
          type: "providerError",
        });
      }
      return;
    }
    if (message.kind === "notification") {
      if (message.method === methods.client.session.update) {
        for (const fact of parseDevinSessionUpdate(message.params)) await this.#emit(fact);
      } else {
        await this.#emit({
          disposition: "unknown_notification",
          method: message.method,
          sessionId: null,
          type: "protocolNotice",
        });
      }
      return;
    }
    if (message.method === methods.client.session.requestPermission) {
      const fact = parseDevinPermissionRequest(message.id, message.params);
      const requestId = fact.requestId;
      if (this.#permissions.has(requestId)) {
        throw new DevinError("PROTOCOL_ERROR", "Devin reused a pending permission request id");
      }
      if (!this.#sessions.has(fact.sessionId)) {
        throw new DevinError("PROTOCOL_ERROR", "Devin requested permission for an unknown session");
      }
      if (this.#permissions.size >= this.#maximumPendingPermissions) {
        throw new DevinError("PROTOCOL_LIMIT", "Devin exceeded its pending permission request limit");
      }
      this.#permissions.set(requestId, {
        options: fact.options.map((option) => Object.freeze({ ...option })),
        sessionId: fact.sessionId,
        wireId: message.id,
      });
      await this.#emit(fact);
      return;
    }
    await this.#write({
      error: { code: -32601, message: "Method not supported" },
      id: message.id,
      jsonrpc: "2.0",
    });
    await this.#emit({
      disposition: "unsupported_request",
      method: message.method,
      sessionId: null,
      type: "protocolNotice",
    });
  }

  async #resolvePermission(
    requestId: string,
    outcome: DevinPermissionOutcome,
    allowClosing = false,
  ): Promise<void> {
    requestId = boundedDevinRequestKey(requestId);
    const permission = this.#permissions.get(requestId);
    if (permission === undefined) {
      throw new DevinError("INVALID_INPUT", "Devin permission request is no longer pending");
    }
    const validated = validateDevinPermissionOutcome(outcome, permission.options);
    const result: RequestPermissionResponse = { outcome: validated };
    // Consume before the first await so a concurrent decision, timeout, or
    // cancellation cannot dispatch a second response for this wire request.
    // A failed write closes the transport, so this decision is never replayed.
    this.#permissions.delete(requestId);
    await this.#write({
      id: permission.wireId,
      jsonrpc: "2.0",
      result,
    }, allowClosing);
  }

  async #emit(fact: DevinFact): Promise<void> {
    try {
      await this.#onFact(fact);
    } catch {
      throw new DevinError("PROCESS_EXITED", "Devin fact consumer failed");
    }
  }

  async #drainStderr(): Promise<void> {
    let total = 0;
    try {
      for await (const chunk of this.#process.stderr) {
        total += chunk.byteLength;
        if (total > this.#maximumStderrBytes) {
          throw new DevinError("PROTOCOL_LIMIT", "Devin stderr exceeded its byte limit");
        }
      }
    } catch (error: unknown) {
      if (this.#state === "open") {
        this.#fail(error instanceof DevinError
          ? error
          : new DevinError("PROCESS_EXITED", "Devin stderr could not be drained", { cause: error }));
      }
      throw error;
    }
  }

  #rejectPending(error: DevinError): void {
    for (const key of [...this.#pending.keys()]) this.#takePending(key)?.reject(error);
  }

  #fail(error: DevinError): void {
    if (this.#failure !== null || this.#state !== "open") return;
    this.#failure = error;
    this.#rejectPending(error);
    void this.#beginClose().catch(() => undefined);
  }

  #terminalProtocolFailure(message: string): DevinError {
    const error = new DevinError("PROTOCOL_ERROR", message);
    this.#fail(error);
    return error;
  }

  #terminalLimitFailure(message: string): DevinError {
    const error = new DevinError("PROTOCOL_LIMIT", message);
    this.#fail(error);
    return error;
  }

  #parseResponse<Value>(parse: () => Value): Value {
    try {
      return parse();
    } catch (error: unknown) {
      const failure = error instanceof DevinError
        ? error
        : new DevinError("PROTOCOL_ERROR", "Devin returned a malformed response");
      this.#fail(failure);
      throw failure;
    }
  }
}
