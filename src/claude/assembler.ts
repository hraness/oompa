import type { InteractionDisplay, InteractionKind } from "../domain/interactions.ts";
import { ClaudeError } from "./errors.ts";
import {
  boundClaudeText,
  claudeInteractionDisplay,
  claudeInteractionKind,
  sanitizeClaudeText,
  type ClaudeCanUseTool,
  type ClaudeRateLimitObservation,
  type ClaudeResultAccounting,
  type ClaudeStreamEvent,
  type ClaudeUsage,
} from "./protocol.ts";

/**
 * The closed vocabulary the Claude bridge hands the runtime. It is
 * deliberately the same shape as the Codex fact vocabulary
 * (`src/codex/protocol.ts`): the bridge knows Claude's dialect, the runtime
 * owns the session timeline and knows neither.
 */
export type ClaudeFact =
  | {
      readonly type: "sessionBootstrapped";
      readonly providerSessionId: string;
      readonly model: string;
      readonly permissionMode: string;
      readonly claudeVersion: string;
    }
  | {
      readonly type: "providerDisconnected";
      readonly reason: "eof" | "process_exit" | "protocol_fault";
    }
  | { readonly type: "turnStarted"; readonly turnId: string }
  | {
      readonly type: "assistantDelta";
      readonly turnId: string;
      readonly itemId: string;
      readonly text: string;
    }
  | {
      readonly type: "reasoningSummaryDelta";
      readonly turnId: string;
      readonly itemId: string;
      readonly summaryIndex: number;
      readonly text: string;
    }
  | {
      readonly type: "subagentActivity";
      readonly turnId: string;
      readonly itemId: string;
      readonly taskId: string;
      readonly activity: "started" | "interacted" | "interrupted";
      readonly nickname: string;
      readonly role: string;
      readonly depth: number;
      readonly status?: string;
    }
  | {
      readonly type: "interactionRequested";
      readonly requestId: string;
      readonly turnId: string | null;
      readonly itemId: string;
      readonly kind: InteractionKind;
      readonly blocking: boolean;
      readonly display: InteractionDisplay;
      readonly request: ClaudeCanUseTool;
    }
  | { readonly type: "interactionCanceled"; readonly requestId: string }
  | {
      readonly type: "turnCompleted";
      readonly turnId: string;
      readonly status: "completed" | "interrupted" | "failed";
      readonly errorCode?: string;
    }
  | {
      readonly type: "turnSummary";
      readonly turnId: string;
      readonly status: "completed" | "interrupted" | "failed";
      readonly runtimeMs: number;
      readonly stopReason: string | null;
      readonly terminalReason: string | null;
      readonly resultText: string;
    }
  | { readonly type: "tokenUsageUpdated"; readonly turnId: string; readonly usage: ClaudeUsage }
  | {
      /**
       * One provider-native compaction signal. `started` is emitted once per
       * compaction episode when `status: "compacting"` first arrives;
       * `completed`/`failed` are each emitted at most once per episode, from
       * `compact_result` or a `compact_boundary` transcript marker. Bounded
       * outcome vocabulary only — never provider free text.
       */
      readonly type: "compaction";
      readonly outcome: "started" | "completed" | "failed";
      readonly errorCode?: string;
      readonly trigger?: string;
      readonly preTokens?: number;
      readonly postTokens?: number;
    }
  | {
      readonly type: "rateLimitObserved";
      readonly turnId: string;
      readonly observationRevision: number;
      readonly observedAt: number;
      readonly receivedAt: number;
      readonly sourceEventId: string;
      readonly sourceEventDigest: string;
      readonly quota: ClaudeRateLimitObservation;
    }
  | {
      readonly type: "usageAccountingObserved";
      readonly turnId: string;
      readonly observationRevision: number;
      readonly observedAt: number;
      readonly receivedAt: number;
      readonly sourceEventId: string;
      readonly sourceEventDigest: string;
      readonly accounting: ClaudeResultAccounting;
    }
  | {
      readonly type: "providerError";
      readonly turnId: string | null;
      readonly code: string;
      readonly message: string;
      readonly terminal: boolean;
    }
  | {
      readonly type: "providerDisconnected";
      readonly reason: "eof" | "protocol_fault";
    }
  | { readonly type: "protocolNotice"; readonly event: string };

type SubagentState = {
  readonly itemId: string;
  readonly nickname: string;
  readonly role: string;
  readonly depth: number;
};

const NICKNAME_BYTES = 256;
const ROLE_BYTES = 128;
export const CLAUDE_USAGE_EVENTS_PER_TURN_LIMIT = 1_024;

type UsageEventRevision = Readonly<{
  sourceEventDigest: string;
  observationRevision: number;
  observedAt: number;
  receivedAt: number;
}>;

const safeLabel = (value: string, bytes: number): string =>
  boundClaudeText(sanitizeClaudeText(value), bytes);

/**
 * One compaction episode's emitted terminal outcomes. The set's presence is
 * what deduplicates a `compact_boundary` plus `compact_result` pair (and a
 * repeated `status: "compacting"` refresh) into a single `started` and at
 * most one fact per outcome; a fresh `compacting` status after a settled
 * episode opens the next episode.
 */
type CompactionEpisode = {
  readonly outcomes: Set<"completed" | "failed">;
};

/**
 * Turns a stream of parsed Claude stream-json events into Oompa facts. It owns
 * exactly one concern: which turn, item, and subagent a line belongs to.
 *
 * The runtime tells it when a turn begins (Oompa writes the `user` line, so Oompa
 * mints the turn id); Claude's own `result` line ends it.
 */
export class ClaudeDeltaAssembler {
  #activeTurnId: string | null = null;
  #providerSessionId: string | null = null;
  #interrupted = false;
  #nextQuotaObservationRevision = 1;
  #compaction: CompactionEpisode | null = null;
  readonly #quotaEventRevisions = new Map<string, UsageEventRevision>();
  readonly #subagents = new Map<string, SubagentState>();
  readonly #subagentsByToolUse = new Map<string, string>();
  readonly #now: () => number;

  constructor(options: Readonly<{ now?: () => number }> = {}) {
    this.#now = options.now ?? Date.now;
  }

  get activeTurnId(): string | null {
    return this.#activeTurnId;
  }

  get providerSessionId(): string | null {
    return this.#providerSessionId;
  }

  /** Oompa mints the turn id when it writes the turn's first `user` line. */
  beginTurn(turnId: string): readonly ClaudeFact[] {
    if (this.#activeTurnId !== null) {
      throw new ClaudeError("INVALID_INPUT", "A Claude turn is already in flight");
    }
    if (turnId.length < 1 || turnId.length > 200) {
      throw new ClaudeError("INVALID_INPUT", "A Claude turn id must be a bounded string");
    }
    this.#activeTurnId = turnId;
    this.#interrupted = false;
    this.#nextQuotaObservationRevision = 1;
    // A compaction that announced `compacting` but reported no outcome before
    // the next turn is a dangling observation, not an open episode.
    if (this.#compaction !== null && this.#compaction.outcomes.size === 0) {
      this.#compaction = null;
    }
    this.#quotaEventRevisions.clear();
    this.#subagents.clear();
    this.#subagentsByToolUse.clear();
    return [{ turnId, type: "turnStarted" }];
  }

  /** Records that Oompa asked the runtime to stop, so `result` reads as interrupted. */
  markInterrupted(): void {
    if (this.#activeTurnId !== null) this.#interrupted = true;
  }

  /** A provider disconnect ends any in-flight turn without inventing a result. */
  abandonTurn(reason: string): readonly ClaudeFact[] {
    const turnId = this.#activeTurnId;
    if (turnId === null) return [];
    this.#activeTurnId = null;
    return [
      {
        code: "claude_stream_ended",
        message: boundClaudeText(sanitizeClaudeText(reason), 512),
        terminal: true,
        turnId,
        type: "providerError",
      },
      { status: "failed", turnId, type: "turnCompleted" },
    ];
  }

  apply(event: ClaudeStreamEvent): readonly ClaudeFact[] {
    switch (event.type) {
      case "session_init":
        if (
          this.#providerSessionId !== null
          && this.#providerSessionId !== event.sessionId
        ) {
          return [{ event: "session_init/session_mismatch", type: "protocolNotice" }];
        }
        this.#providerSessionId = event.sessionId;
        return [
          {
            claudeVersion: event.claudeVersion,
            model: event.model,
            permissionMode: event.permissionMode,
            providerSessionId: event.sessionId,
            type: "sessionBootstrapped",
          },
        ];
      case "assistant_message":
        return this.#assistant(event.parentToolUseId, event.messageId, event.text, event.thinking);
      case "content_delta":
        return this.#assistant(
          event.parentToolUseId,
          `${this.#activeTurnId ?? "turn"}#b${String(event.blockIndex)}`,
          event.block === "text" ? event.text : "",
          event.block === "thinking" ? event.text : "",
          event.blockIndex,
        );
      case "task_started": {
        const turnId = this.#activeTurnId;
        if (turnId === null) return [];
        const state: SubagentState = {
          depth: Math.min(event.spawnDepth, 64),
          itemId: event.toolUseId,
          nickname: safeLabel(event.description, NICKNAME_BYTES),
          role: safeLabel(event.subagentType, ROLE_BYTES),
        };
        this.#subagents.set(event.taskId, state);
        this.#subagentsByToolUse.set(event.toolUseId, event.taskId);
        return [{ activity: "started", taskId: event.taskId, turnId, type: "subagentActivity", ...state }];
      }
      case "task_progress": {
        const turnId = this.#activeTurnId;
        if (turnId === null) return [];
        const state = this.#subagentState(event.taskId, {
          itemId: event.toolUseId,
          nickname: event.description ?? "",
          role: event.subagentType ?? "",
        });
        return [
          {
            activity: "interacted",
            taskId: event.taskId,
            turnId,
            type: "subagentActivity",
            ...state,
            ...(event.lastToolName === null
              ? {}
              : { status: safeLabel(event.lastToolName, 64) }),
          },
        ];
      }
      case "task_updated": {
        const turnId = this.#activeTurnId;
        const state = this.#subagents.get(event.taskId);
        if (turnId === null || state === undefined) return [];
        return [
          {
            activity: subagentActivityFor(event.status),
            taskId: event.taskId,
            turnId,
            type: "subagentActivity",
            ...state,
            ...(event.status === null ? {} : { status: safeLabel(event.status, 64) }),
          },
        ];
      }
      case "task_notification": {
        const turnId = this.#activeTurnId;
        if (turnId === null) return [];
        const state = this.#subagentState(event.taskId, { itemId: event.toolUseId });
        return [
          {
            activity: subagentActivityFor(event.status),
            status: safeLabel(event.status, 64),
            taskId: event.taskId,
            turnId,
            type: "subagentActivity",
            ...state,
          },
        ];
      }
      case "control_request": {
        const kind = claudeInteractionKind(event.request);
        return [
          {
            blocking: true,
            display: claudeInteractionDisplay(event.request),
            itemId: event.request.toolUseId,
            kind,
            request: event.request,
            requestId: event.requestId,
            turnId: this.#activeTurnId,
            type: "interactionRequested",
          },
        ];
      }
      case "control_cancel_request":
        return [{ requestId: event.requestId, type: "interactionCanceled" }];
      case "status": {
        const gate = this.#sessionGate("system/status", event.sessionId);
        if (gate !== null) return gate;
        const facts: ClaudeFact[] = [];
        if (event.status === "compacting") {
          if (this.#compaction === null || this.#compaction.outcomes.size > 0) {
            this.#compaction = { outcomes: new Set() };
            facts.push({ outcome: "started", type: "compaction" });
          }
        }
        if (event.compactResult !== null) {
          facts.push(...this.#compactionOutcome(event.compactResult, event.compactError));
        }
        return facts;
      }
      case "compact_result": {
        const gate = this.#sessionGate("system/compact_result", event.sessionId);
        if (gate !== null) return gate;
        return this.#compactionOutcome(event.compactResult, event.compactError);
      }
      case "compact_boundary": {
        const gate = this.#sessionGate("system/compact_boundary", event.sessionId);
        if (gate !== null) return gate;
        // A boundary record is itself the applied-compaction signal; its
        // token fields ride along when it is the episode's first completion.
        const episode = (this.#compaction ??= { outcomes: new Set() });
        if (episode.outcomes.has("completed")) return [];
        episode.outcomes.add("completed");
        return [{
          outcome: "completed",
          type: "compaction",
          ...(event.trigger === null ? {} : { trigger: event.trigger }),
          ...(event.preTokens === null ? {} : { preTokens: event.preTokens }),
          ...(event.postTokens === null ? {} : { postTokens: event.postTokens }),
        }];
      }
      case "rate_limit": {
        const turnId = this.#activeTurnId;
        if (turnId === null) {
          return [{ event: "rate_limit_event/outside_turn", type: "protocolNotice" }];
        }
        if (this.#providerSessionId === null) {
          return [{ event: "rate_limit_event/session_uninitialized", type: "protocolNotice" }];
        }
        if (event.sessionId !== this.#providerSessionId) {
          return [{ event: "rate_limit_event/session_mismatch", type: "protocolNotice" }];
        }
        const revision = this.#quotaRevision(event.eventId, event.sourceEventDigest);
        if (revision === "conflict") {
          return [{ event: "rate_limit_event/conflicting_duplicate", type: "protocolNotice" }];
        }
        if (revision === "limit") {
          return [{ event: "rate_limit_event/observation_limit", type: "protocolNotice" }];
        }
        return [{
          observationRevision: revision.observationRevision,
          observedAt: revision.observedAt,
          quota: event.quota,
          receivedAt: revision.receivedAt,
          sourceEventDigest: event.sourceEventDigest,
          sourceEventId: event.eventId,
          turnId,
          type: "rateLimitObserved",
        }];
      }
      case "result": {
        const turnId = this.#activeTurnId;
        if (turnId === null) return [];
        if (this.#providerSessionId === null) {
          return [{ event: "result/session_uninitialized", type: "protocolNotice" }];
        }
        if (event.sessionId !== this.#providerSessionId) {
          return [{ event: "result/session_mismatch", type: "protocolNotice" }];
        }
        this.#activeTurnId = null;
        const status = this.#interrupted
          ? "interrupted"
          : event.isError
            ? "failed"
            : "completed";
        this.#interrupted = false;
        const facts: ClaudeFact[] = [{ turnId, type: "tokenUsageUpdated", usage: event.usage }];
        let usageTail: ClaudeFact;
        if (
          event.accounting !== null
          && event.eventId !== null
          && event.sourceEventDigest !== null
        ) {
          const observedAt = this.#now();
          usageTail = {
            accounting: event.accounting,
            observationRevision: 1,
            observedAt,
            receivedAt: observedAt,
            sourceEventDigest: event.sourceEventDigest,
            sourceEventId: event.eventId,
            turnId,
            type: "usageAccountingObserved",
          };
        } else {
          usageTail = { event: "result/accounting_invalid", type: "protocolNotice" };
        }
        if (event.isError) {
          facts.push({
            code: boundClaudeText(sanitizeClaudeText(event.terminalReason ?? "error"), 128),
            message: boundClaudeText(sanitizeClaudeText(event.resultText), 512),
            terminal: false,
            turnId,
            type: "providerError",
          });
        }
        facts.push(
          { status, turnId, type: "turnCompleted" },
          {
            resultText: boundClaudeText(sanitizeClaudeText(event.resultText, true), 4_096),
            runtimeMs: Math.max(0, event.durationMs),
            status,
            stopReason: event.stopReason,
            terminalReason: event.terminalReason,
            turnId,
            type: "turnSummary",
          },
          usageTail,
        );
        return facts;
      }
      case "protocol_notice":
        return [{ event: event.event, type: "protocolNotice" }];
      case "ignored":
        return [];
    }
  }

  /**
   * Session-correlated compaction signals carry `session_id`; a line that
   * names a different provider session is a bounded notice, while a line
   * that omits it is tolerated like the other session-scoped events are not
   * (status envelopes are advisory, so absence is not an identity claim).
   */
  #sessionGate(label: string, sessionId: string | null): readonly ClaudeFact[] | null {
    if (
      sessionId !== null
      && this.#providerSessionId !== null
      && sessionId !== this.#providerSessionId
    ) {
      return [{ event: `${label}/session_mismatch`, type: "protocolNotice" }];
    }
    return null;
  }

  /**
   * `compact_result` is the provider's own outcome word: `"success"` is the
   * only completed spelling, and every other bounded code — including the
   * documented `"failed"` — is a failure. `compact_error` is provider free
   * text, so it survives only as a sanitized, bounded `errorCode`; an
   * unrecognized result code itself becomes that token.
   */
  #compactionOutcome(
    result: string,
    error: string | null,
  ): readonly ClaudeFact[] {
    const episode = (this.#compaction ??= { outcomes: new Set() });
    const outcome = result === "success" ? "completed" : "failed";
    if (episode.outcomes.has(outcome)) return [];
    episode.outcomes.add(outcome);
    if (outcome === "completed") return [{ outcome, type: "compaction" }];
    const errorCode = error !== null
      ? boundClaudeText(sanitizeClaudeText(error), 128)
      : result === "failed"
        ? undefined
        : result;
    return [{
      outcome,
      type: "compaction",
      ...(errorCode === undefined ? {} : { errorCode }),
    }];
  }

  #quotaRevision(
    sourceEventId: string,
    sourceEventDigest: string,
  ): UsageEventRevision | "conflict" | "limit" {
    const seen = this.#quotaEventRevisions.get(sourceEventId);
    if (seen !== undefined) {
      return seen.sourceEventDigest === sourceEventDigest
        ? seen
        : "conflict";
    }
    if (this.#quotaEventRevisions.size >= CLAUDE_USAGE_EVENTS_PER_TURN_LIMIT) return "limit";
    const observationRevision = this.#nextQuotaObservationRevision;
    if (!Number.isSafeInteger(observationRevision)) return "limit";
    this.#nextQuotaObservationRevision += 1;
    const observedAt = this.#now();
    const admitted = {
      observationRevision,
      observedAt,
      receivedAt: observedAt,
      sourceEventDigest,
    };
    this.#quotaEventRevisions.set(sourceEventId, admitted);
    return admitted;
  }

  #assistant(
    parentToolUseId: string | null,
    itemId: string,
    text: string,
    thinking: string,
    summaryIndex = 0,
  ): readonly ClaudeFact[] {
    const turnId = this.#activeTurnId;
    if (turnId === null) return [];
    if (parentToolUseId !== null) {
      // A subagent's own message. It never enters the parent transcript; it
      // is projected as subagent activity keyed by the spawning tool use.
      const taskId = this.#subagentsByToolUse.get(parentToolUseId);
      const state = taskId === undefined ? undefined : this.#subagents.get(taskId);
      if (taskId === undefined || state === undefined) return [];
      return [
        { activity: "interacted", taskId, turnId, type: "subagentActivity", ...state },
      ];
    }
    const facts: ClaudeFact[] = [];
    if (thinking.length > 0) {
      facts.push({ itemId, summaryIndex, text: thinking, turnId, type: "reasoningSummaryDelta" });
    }
    if (text.length > 0) facts.push({ itemId, text, turnId, type: "assistantDelta" });
    return facts;
  }

  #subagentState(
    taskId: string,
    fallback: Readonly<{ itemId: string; nickname?: string; role?: string }>,
  ): SubagentState {
    const known = this.#subagents.get(taskId);
    if (known !== undefined) return known;
    const state: SubagentState = {
      depth: 0,
      itemId: fallback.itemId,
      nickname: safeLabel(fallback.nickname ?? "", NICKNAME_BYTES),
      role: safeLabel(fallback.role ?? "", ROLE_BYTES),
    };
    this.#subagents.set(taskId, state);
    this.#subagentsByToolUse.set(fallback.itemId, taskId);
    return state;
  }
}

const subagentActivityFor = (status: string | null): "started" | "interacted" | "interrupted" =>
  status === "killed" || status === "failed" || status === "refused" ? "interrupted" : "interacted";
