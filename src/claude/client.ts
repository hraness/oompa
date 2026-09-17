import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

import type { PreparedAttachment } from "../domain/attachments.ts";
import { ClaudeDeltaAssembler, type ClaudeFact } from "./assembler.ts";
import { ClaudeError, IndeterminateClaudeEffectError } from "./errors.ts";
import { ClaudeJsonLineDecoder } from "./jsonl.ts";
import type { ClaudeProcess } from "./process.ts";
import {
  claudeControlResponse,
  claudeControlResponseLine,
  claudeInterruptLine,
  claudeRequestDigest,
  claudeResponseDigest,
  claudeUserLine,
  parseClaudeStreamLine,
  type ClaudeCanUseTool,
  type ClaudeControlResponse,
} from "./protocol.ts";

export type ClaudeInteractionDecision =
  | Readonly<{ kind: "allow" }>
  | Readonly<{ kind: "answer"; answers: Readonly<Record<string, string>> }>
  | Readonly<{ kind: "deny"; message: string }>;

export interface ClaudeStreamClientOptions {
  readonly process: ClaudeProcess;
  /** Absolute reviewed logical home that owns this process. Fences every write. */
  readonly configDir: string;
  /**
   * May await fact handling, but not this client's cleanup. Schedule cleanup
   * under a separate owner after the callback returns.
   */
  readonly onFact: (fact: ClaudeFact) => void | Promise<void>;
  readonly onSafeDiagnostic?: (message: string) => void;
  readonly maxJsonLineBytes?: number;
  readonly shutdownTermGraceMs?: number;
  readonly shutdownSettlementMs?: number;
  readonly now?: () => number;
}

export type ClaudeStreamInitialization = Readonly<{
  providerSessionId: string;
  model: string;
  permissionMode: string;
  claudeVersion: string;
}>;

type PendingInteraction = {
  readonly requestId: string;
  readonly request: ClaudeCanUseTool;
  readonly requestDigest: string;
};

const STDERR_DIAGNOSTIC_BYTES = 4 * 1024;
const PROCESS_TERMINATION_GRACE_MS = 250;
const PROCESS_FORCE_JOIN_DEADLINE_MS = 1_000;
// Match the daemon's bounded deferred-fact count, with a separate byte bound
// below the stream decoder's 8 MiB single-line ceiling.
const PENDING_TURN_FACT_LIMIT = 256;
const PENDING_TURN_FACT_BYTES = 1024 * 1024;

type PendingTurnStart = {
  readonly turnId: string;
  readonly facts: Array<Readonly<{ fact: ClaudeFact; bytes: number }>>;
  bytes: number;
  draining: Promise<void> | null;
};

const boundedShutdownDuration = (value: number, label: string): number => {
  if (!Number.isSafeInteger(value) || value < 1 || value > 30_000) {
    throw new ClaudeError("INVALID_INPUT", `${label} must be between 1 and 30000 milliseconds`);
  }
  return value;
};

const resolvesWithin = async (promise: Promise<unknown>, milliseconds: number): Promise<boolean> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(
        () => true as const,
        () => false as const,
      ),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), milliseconds);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

const settlesWithin = async (promise: Promise<unknown>, milliseconds: number): Promise<boolean> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(
        () => true as const,
        () => true as const,
      ),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), milliseconds);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

/**
 * Owns one pinned Claude Code process speaking stream-json in both
 * directions. It translates every stdout line through the bridge's parser and
 * delta assembler, and it is the only writer of the process's stdin.
 */
export class ClaudeStreamClient {
  readonly #process: ClaudeProcess;
  readonly #configDir: string;
  readonly #onFact: ClaudeStreamClientOptions["onFact"];
  readonly #factDelivery = new AsyncLocalStorage<{ active: boolean }>();
  readonly #onSafeDiagnostic: ((message: string) => void) | undefined;
  readonly #assembler: ClaudeDeltaAssembler;
  readonly #decoder: ClaudeJsonLineDecoder;
  readonly #pending = new Map<string, PendingInteraction>();
  readonly #encoder = new TextEncoder();
  readonly #readTask: Promise<void>;
  readonly #stderrTask: Promise<void>;
  readonly #exitTask: Promise<number>;
  readonly #exitWatchTask: Promise<void>;
  readonly #initialization: Promise<ClaudeStreamInitialization>;
  readonly #resolveInitialization: (value: ClaudeStreamInitialization) => void;
  readonly #rejectInitialization: (reason: unknown) => void;
  readonly #shutdownTermGraceMs: number;
  readonly #shutdownSettlementMs: number;
  #initializationSettled = false;
  #initializationValue: ClaudeStreamInitialization | undefined;
  #exitResolved = false;
  #closeTask: Promise<void> | null = null;
  #closeFactsTask: Promise<void> | null = null;
  #state: "open" | "closing" | "closed" | "failed" = "open";
  #disconnectEmitted = false;
  #writeChain: Promise<void> = Promise.resolve();
  #writesFenced = false;
  #pendingTurnStart: PendingTurnStart | null = null;

  constructor(options: ClaudeStreamClientOptions) {
    if (!options.configDir.startsWith("/")) {
      throw new ClaudeError("INVALID_INPUT", "CLAUDE_CONFIG_DIR must be an absolute path");
    }
    this.#process = options.process;
    this.#configDir = options.configDir;
    this.#onFact = options.onFact;
    this.#onSafeDiagnostic = options.onSafeDiagnostic;
    this.#assembler = new ClaudeDeltaAssembler(
      options.now === undefined ? {} : { now: options.now },
    );
    this.#shutdownTermGraceMs = boundedShutdownDuration(
      options.shutdownTermGraceMs ?? PROCESS_TERMINATION_GRACE_MS,
      "Claude TERM grace",
    );
    this.#shutdownSettlementMs = boundedShutdownDuration(
      options.shutdownSettlementMs ?? PROCESS_FORCE_JOIN_DEADLINE_MS,
      "Claude shutdown settlement",
    );
    this.#decoder = new ClaudeJsonLineDecoder(
      options.maxJsonLineBytes === undefined ? {} : { maxLineBytes: options.maxJsonLineBytes },
    );
    let resolveInitialization!: (value: ClaudeStreamInitialization) => void;
    let rejectInitialization!: (reason: unknown) => void;
    this.#initialization = new Promise<ClaudeStreamInitialization>((resolve, reject) => {
      resolveInitialization = resolve;
      rejectInitialization = reject;
    });
    this.#resolveInitialization = resolveInitialization;
    this.#rejectInitialization = rejectInitialization;
    // A process can fail before its owner reaches the wait call. Keep that
    // deterministic rejection owned while preserving it for the later await.
    void this.#initialization.catch(() => undefined);
    this.#exitTask = this.#process.exited.then((code) => {
      this.#exitResolved = true;
      return code;
    });
    void this.#exitTask.catch(() => undefined);
    this.#readTask = this.#readStdout();
    void this.#readTask.catch(() => undefined);
    this.#stderrTask = this.#drainStderr();
    this.#exitWatchTask = this.#watchProcessExit();
    void this.#exitWatchTask.catch(() => undefined);
  }

  get configDir(): string {
    return this.#configDir;
  }

  get providerSessionId(): string | null {
    return this.#assembler.providerSessionId;
  }

  get activeTurnId(): string | null {
    return this.#assembler.activeTurnId;
  }

  get state(): "open" | "closing" | "closed" | "failed" {
    return this.#state;
  }

  /**
   * Waits for the one `system/init` identity that makes this process usable.
   * The caller supplies both an abort fence and a bounded deadline; neither a
   * silent binary nor a dead stream can hold session admission indefinitely.
   */
  async waitForInitialization(input: Readonly<{
    signal: AbortSignal;
    timeoutMs: number;
  }>): Promise<ClaudeStreamInitialization> {
    if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 60_000) {
      throw new ClaudeError("INVALID_INPUT", "Claude initialization timeout must be 1 to 60000 ms.");
    }
    input.signal.throwIfAborted();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let removeAbort = (): void => undefined;
    const boundary = new Promise<never>((_resolve, reject) => {
      const onAbort = (): void => { reject(input.signal.reason); };
      input.signal.addEventListener("abort", onAbort, { once: true });
      removeAbort = (): void => { input.signal.removeEventListener("abort", onAbort); };
      timer = setTimeout(() => {
        reject(new ClaudeError("TIMEOUT", "Claude did not publish its initialization identity in time."));
      }, input.timeoutMs);
      timer.unref();
    });
    try {
      return await Promise.race([this.#initialization, boundary]);
    } finally {
      removeAbort();
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** Starts a turn: Oompa mints the turn id, then writes the turn's `user` line. */
  async startTurn(input: Readonly<{
    turnId: string;
    message: string;
    attachments?: readonly PreparedAttachment[];
    onWriteStarted?: () => void;
  }>): Promise<void> {
    const onWriteStarted = input.onWriteStarted;
    this.#assertOpen();
    if (this.#pendingTurnStart !== null) {
      throw new ClaudeError("INVALID_INPUT", "A Claude turn start is still settling");
    }
    const line = claudeUserLine(input.message, input.attachments ?? []);
    this.#assembler.beginTurn(input.turnId);
    const pending: PendingTurnStart = { turnId: input.turnId, facts: [], bytes: 0, draining: null };
    this.#pendingTurnStart = pending;
    const write = { started: false };
    try {
      await this.#write(line, () => {
        write.started = true;
        onWriteStarted?.();
      });
      this.#assertOpen();
      await this.#drainPendingTurnStart(pending, true);
    } catch (error: unknown) {
      if (write.started) this.fenceWrites();
      // A rejected write may have escaped. Retain actual observed history,
      // but never manufacture a successful start or replace the write error.
      try {
        await this.#drainPendingTurnStart(pending, false);
      } catch {
        try {
          this.#onSafeDiagnostic?.("Oompa fact delivery failed after Claude turn admission failed");
        } catch {
          // An informational observer cannot replace the admission failure
          // or prevent the local turn from being abandoned below.
        }
      }
      this.#assembler.abandonTurn("the Claude turn write failed");
      throw error;
    }
  }

  async #emitFact(fact: ClaudeFact): Promise<void> {
    const pending = this.#pendingTurnStart;
    if (pending !== null && fact.type !== "rateLimitObserved"
      && (("turnId" in fact && fact.turnId === pending.turnId)
        || fact.type === "interactionCanceled")) {
      const bytes = this.#encoder.encode(JSON.stringify(fact)).byteLength;
      if (pending.facts.length >= PENDING_TURN_FACT_LIMIT
        || pending.bytes + bytes > PENDING_TURN_FACT_BYTES) {
        this.#onSafeDiagnostic?.("Claude pending turn facts exceeded their bounded capacity");
        throw new ClaudeError("PROTOCOL_LIMIT", "Claude pending turn facts exceeded their bounded capacity");
      }
      pending.facts.push({ fact, bytes });
      pending.bytes += bytes;
      return;
    }
    await this.#deliverFact(fact);
  }

  async #deliverFact(fact: ClaudeFact): Promise<void> {
    const callback = { active: true };
    await this.#factDelivery.run(callback, async () => {
      try {
        await this.#onFact(fact);
      } finally {
        // Tasks may inherit this context but run after the observer returns.
        // They are external cleanup owners, not a join of this live callback.
        callback.active = false;
      }
    });
  }

  async #drainPendingTurnStart(pending: PendingTurnStart, accepted: boolean): Promise<void> {
    if (pending.draining !== null) return await pending.draining;
    if (this.#pendingTurnStart !== pending) return;
    // Install the shared join before observer code can synchronously re-enter.
    const task = Promise.resolve().then(async () => {
      let failure: Readonly<{ error: unknown }> | undefined;
      const deliver = async (fact: ClaudeFact): Promise<void> => {
        try {
          await this.#deliverFact(fact);
        } catch (error: unknown) {
          failure ??= { error };
        }
      };
      if (accepted) await deliver({ type: "turnStarted", turnId: pending.turnId });
      for (;;) {
        const item = pending.facts.shift();
        if (item === undefined) break;
        pending.bytes -= item.bytes;
        await deliver(item.fact);
      }
      if (this.#pendingTurnStart === pending) this.#pendingTurnStart = null;
      if (failure !== undefined) throw failure.error;
    });
    pending.draining = task;
    await task;
  }

  /** Steering is the same wire shape: another `user` line while a turn runs. */
  async steer(
    message: string,
    attachments: readonly PreparedAttachment[] = [],
    onWriteStarted?: () => void,
  ): Promise<void> {
    this.#assertOpen();
    if (this.#assembler.activeTurnId === null) {
      throw new ClaudeError("INVALID_INPUT", "No Claude turn is in flight to steer");
    }
    await this.#write(claudeUserLine(message, attachments), onWriteStarted);
  }

  /**
   * Asks the pinned runtime to compact the session's context with one
   * `/compact` `user` line — the same write path `steer` uses, but admitted
   * only between turns: a `/compact` arriving mid-turn is ambiguous in v1
   * (the runtime may queue it as ordinary message text rather than run it),
   * so an in-flight turn refuses `INVALID_INPUT` instead of writing. A
   * closed or fenced client refuses through `#assertOpen` exactly as every
   * other frame does. The provider's `compaction` facts report the outcome.
   */
  async compact(onWriteStarted?: () => void): Promise<void> {
    this.#assertOpen();
    if (this.#assembler.activeTurnId !== null) {
      throw new ClaudeError(
        "INVALID_INPUT",
        "A Claude turn is in flight; compaction is only admitted between turns",
      );
    }
    await this.#write(claudeUserLine("/compact"), onWriteStarted);
  }

  /** Asks the runtime to stop the in-flight turn. Its `result` reads interrupted. */
  async interrupt(onWriteStarted?: () => void): Promise<void> {
    this.#assertOpen();
    if (this.#assembler.activeTurnId === null) return;
    this.#assembler.markInterrupted();
    await this.#write(claudeInterruptLine(randomUUID()), onWriteStarted);
  }

  pendingInteraction(requestId: string): PendingInteraction | undefined {
    return this.#pending.get(requestId);
  }

  /** Computes the exact bytes a decision would write, without writing them. */
  validateInteractionResolution(
    requestId: string,
    decision: ClaudeInteractionDecision,
  ): Readonly<{ response: ClaudeControlResponse; responseDigest: string }> {
    const pending = this.#pending.get(requestId);
    if (pending === undefined) {
      throw new ClaudeError("PROTOCOL_ERROR", "That Claude control request is no longer pending");
    }
    const response = claudeControlResponse(pending.request, decision);
    return { response, responseDigest: claudeResponseDigest(response) };
  }

  async resolveInteraction(
    requestId: string,
    decision: ClaudeInteractionDecision,
    onWriteStarted?: () => void,
  ): Promise<Readonly<{ responseDigest: string }>> {
    this.#assertOpen();
    const validated = this.validateInteractionResolution(requestId, decision);
    await this.#write(claudeControlResponseLine(requestId, validated.response), onWriteStarted);
    this.#pending.delete(requestId);
    return { responseDigest: validated.responseDigest };
  }

  async close(): Promise<void> {
    if (this.#factDelivery.getStore()?.active === true) {
      // A successful close proves the observer and admitted history joined.
      // That is impossible while this observer awaits close itself. Reject
      // before changing custody; a separate owner can still close and retry.
      throw new ClaudeError("INVALID_INPUT", "Claude fact callbacks cannot join their own client cleanup.");
    }
    if (this.#closeTask !== null) {
      await this.#closeTask;
      return;
    }
    const closeTask = this.#close();
    this.#closeTask = closeTask;
    try {
      await closeTask;
    } catch (error: unknown) {
      // A bounded close can fail before the exact child or its output drains
      // settle. Keep the client closed to new writes, but let its owner retry
      // the same exact process rather than turning the first timeout into a
      // permanently cached observation that can never prove later reaping.
      if (this.#closeTask === closeTask) this.#closeTask = null;
      throw error;
    }
  }

  async #close(): Promise<void> {
    if (this.#state === "closed") return;
    this.#state = "closing";
    this.#failInitialization(
      new ClaudeError("PROCESS_EXITED", "The Claude runtime closed before initialization."),
    );
    if (!this.#exitResolved) {
      try {
        this.#process.terminate();
      } catch {
        this.#onSafeDiagnostic?.("claude TERM failed; forcing process termination");
      }
      await resolvesWithin(this.#exitTask, this.#shutdownTermGraceMs);
    }
    if (!this.#exitResolved) {
      try {
        this.#process.forceTerminate();
      } catch {
        this.#onSafeDiagnostic?.("claude force termination failed");
      }
    }
    const [exitSettled, stdoutSettled, stderrSettled, exitWatcherSettled] = await Promise.all([
      resolvesWithin(this.#exitTask, this.#shutdownSettlementMs),
      settlesWithin(this.#readTask, this.#shutdownSettlementMs),
      settlesWithin(this.#stderrTask, this.#shutdownSettlementMs),
      // Exit may precede stdout EOF. Its watcher independently owns terminal
      // observers, so neither the exit promise nor the reader proves this join.
      settlesWithin(this.#exitWatchTask, this.#shutdownSettlementMs),
    ]);
    if (!exitSettled) {
      throw new ClaudeError(
        "TIMEOUT",
        "Claude session process could not be joined after forced termination.",
      );
    }
    if (!stdoutSettled || !stderrSettled || !exitWatcherSettled) {
      throw new ClaudeError(
        "TIMEOUT",
        "Claude session output could not be drained after forced termination.",
      );
    }
    // One retained owner drains these facts even when a caller times out.
    // In particular, abandonTurn extracts the completion before delivering
    // its error fact; recreating this task on retry would lose that completion.
    const closeFactsTask = this.#closeFactsTask ??= Promise.resolve().then(async () => {
      let failure: Readonly<{ error: unknown }> | undefined;
      if (this.#pendingTurnStart !== null) {
        try {
          await this.#drainPendingTurnStart(this.#pendingTurnStart, false);
        } catch (error: unknown) {
          failure ??= { error };
        }
      }
      for (const fact of this.#assembler.abandonTurn("the Claude runtime was closed")) {
        try {
          await this.#emitFact(fact);
        } catch (error: unknown) {
          failure ??= { error };
        }
      }
      if (failure !== undefined) throw failure.error;
    });
    if (!await settlesWithin(closeFactsTask, this.#shutdownSettlementMs)) {
      throw new ClaudeError(
        "TIMEOUT",
        "Claude session terminal facts could not be drained after forced termination.",
      );
    }
    try {
      await closeFactsTask;
    } finally {
      this.#pending.clear();
      this.#state = "closed";
    }
  }

  /** Close frame admission without inventing process exit or joining an observer. */
  fenceWrites(): void {
    this.#writesFenced = true;
  }

  #assertOpen(): void {
    if (this.#state !== "open") {
      throw new ClaudeError("PROCESS_EXITED", "The Claude runtime connection is closed");
    }
    if (this.#writesFenced) throw new IndeterminateClaudeEffectError("write");
  }

  #write(line: string, onWriteStarted?: () => void): Promise<void> {
    const bytes = this.#encoder.encode(line);
    const chained = this.#writeChain.then(async () => {
      // Admission can change while this frame waits behind an earlier write.
      // Recheck at the actual provider boundary so close, disconnect, and
      // account revocation fence every frame that has not begun writing yet.
      this.#assertOpen();
      try {
        onWriteStarted?.();
        await this.#process.write(bytes);
      } catch (error: unknown) {
        // Fence synchronously before the recovered chain can release another
        // queued frame. Cleanup and actual stream facts retain their owners.
        this.fenceWrites();
        throw error;
      }
    });
    this.#writeChain = chained.catch(() => undefined);
    return chained;
  }

  async #readStdout(): Promise<void> {
    let disconnectReason: "eof" | "protocol_fault" = "eof";
    try {
      for await (const chunk of this.#process.stdout) {
        for (const value of this.#decoder.push(chunk)) await this.#dispatch(value);
      }
      for (const value of this.#decoder.finish()) await this.#dispatch(value);
    } catch (error: unknown) {
      disconnectReason = "protocol_fault";
      this.#failInitialization(
        error instanceof ClaudeError
          ? error
          : new ClaudeError("PROTOCOL_ERROR", "Claude initialization could not be parsed."),
      );
      this.#onSafeDiagnostic?.(
        error instanceof ClaudeError
          ? `claude stream fault: ${error.code}`
          : "claude stream fault: unknown",
      );
    }
    await this.#handleUnexpectedDisconnect(disconnectReason);
  }

  async #watchProcessExit(): Promise<void> {
    try {
      await this.#exitTask;
    } catch {
      // A rejected exit promise is not proof of termination. The manager
      // retains the failed client so an exact close can be retried, but no
      // further write may cross this now-ambiguous process boundary.
      await this.#fenceAmbiguousProcessExit();
      return;
    }
    await this.#handleUnexpectedDisconnect("process_exit");
  }

  async #fenceAmbiguousProcessExit(): Promise<void> {
    if (this.#state !== "open") return;
    this.#state = "failed";
    this.#pending.clear();
    this.#failInitialization(
      new ClaudeError("PROCESS_EXITED", "Claude process settlement became indeterminate."),
    );
    this.#onSafeDiagnostic?.("Claude process exit settlement was indeterminate");
    try {
      this.#process.forceTerminate();
    } catch {
      this.#onSafeDiagnostic?.("Claude force termination failed after indeterminate exit");
    }
    for (const fact of this.#assembler.abandonTurn("the Claude runtime became indeterminate")) {
      try {
        await this.#emitFact(fact);
      } catch {
        this.#onSafeDiagnostic?.("Oompa fact delivery failed during Claude disconnection");
      }
    }
  }

  async #handleUnexpectedDisconnect(
    reason: "eof" | "process_exit" | "protocol_fault",
  ): Promise<void> {
    if (this.#state !== "open" || this.#disconnectEmitted) return;
    // Fence writes synchronously before any observer callback can re-enter.
    this.#state = "failed";
    this.#pending.clear();
    this.#failInitialization(
      new ClaudeError("PROCESS_EXITED", "The Claude runtime ended before admission completed."),
    );
    for (const fact of this.#assembler.abandonTurn("the Claude runtime disconnected")) {
      try {
        await this.#emitFact(fact);
      } catch {
        this.#onSafeDiagnostic?.("Oompa fact delivery failed during Claude disconnection");
      }
    }
    if (reason !== "process_exit") {
      try {
        this.#process.forceTerminate();
      } catch {
        this.#onSafeDiagnostic?.("Claude force termination failed after stream loss");
      }
      const exitSettled = await resolvesWithin(
        this.#exitTask,
        this.#shutdownSettlementMs,
      );
      if (!exitSettled) {
        this.#onSafeDiagnostic?.("Claude process exit did not settle after stream loss");
        return;
      }
    }
    if (this.#pendingTurnStart !== null) {
      try {
        await this.#drainPendingTurnStart(this.#pendingTurnStart, false);
      } catch {
        this.#onSafeDiagnostic?.("Oompa fact delivery failed during Claude disconnection");
      }
    }
    this.#disconnectEmitted = true;
    await this.#deliverFact({ type: "providerDisconnected", reason });
  }

  async #dispatch(value: unknown): Promise<void> {
    const event = parseClaudeStreamLine(value);
    for (const fact of this.#assembler.apply(event)) {
      if (fact.type === "interactionRequested") {
        this.#pending.set(fact.requestId, {
          request: fact.request,
          requestDigest: claudeRequestDigest(fact.requestId, fact.request),
          requestId: fact.requestId,
        });
      }
      if (fact.type === "interactionCanceled") this.#pending.delete(fact.requestId);
      await this.#emitFact(fact);
      if (fact.type === "sessionBootstrapped") {
        this.#settleInitialization({
          claudeVersion: fact.claudeVersion,
          model: fact.model,
          permissionMode: fact.permissionMode,
          providerSessionId: fact.providerSessionId,
        });
      }
    }
  }

  #settleInitialization(initialization: ClaudeStreamInitialization): void {
    if (this.#initializationValue !== undefined) {
      if (
        initialization.providerSessionId !== this.#initializationValue.providerSessionId
        || initialization.claudeVersion !== this.#initializationValue.claudeVersion
        || initialization.model !== this.#initializationValue.model
        || initialization.permissionMode !== this.#initializationValue.permissionMode
      ) {
        throw new ClaudeError(
          "PROTOCOL_ERROR",
          "Claude published conflicting initialization identities on one stream.",
        );
      }
      return;
    }
    if (this.#initializationSettled) return;
    this.#initializationSettled = true;
    this.#initializationValue = initialization;
    this.#resolveInitialization(initialization);
  }

  #failInitialization(error: unknown): void {
    if (this.#initializationSettled) return;
    this.#initializationSettled = true;
    this.#rejectInitialization(error);
  }

  async #drainStderr(): Promise<void> {
    let observed = 0;
    let truncated = false;
    try {
      for await (const chunk of this.#process.stderr) {
        const retained = Math.min(chunk.byteLength, STDERR_DIAGNOSTIC_BYTES - observed);
        observed += retained;
        if (retained < chunk.byteLength) truncated = true;
      }
    } catch {
      // Diagnostics are advisory; provider stderr never becomes Oompa data.
    }
    if (observed > 0) {
      this.#onSafeDiagnostic?.(
        `claude stderr bytes: ${String(observed)}${truncated ? "+" : ""}`,
      );
    }
  }
}
