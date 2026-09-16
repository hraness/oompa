import type { ClaudeFact } from "../claude/assembler";
import type { CodexFact } from "../codex/protocol";
import type {
  InteractionKind,
  ProviderInteractionAuthority,
} from "../domain/interactions";
import type { ProviderAccountAuthority } from "../domain/provider-accounts";

/**
 * One Claude fact with the session identity the runtime manager binds to it.
 * The bridge itself knows nothing about Oompa sessions, so the manager stamps
 * the provider thread and the exact connection generation onto every fact.
 */
export type ClaudeSessionFact = ClaudeFact & {
  readonly providerThreadId: string;
  readonly connectionId: string;
};

export type ClaudeUsageObservation =
  | Readonly<{
      component: "quota";
      authority: ProviderAccountAuthority;
      providerThreadId: string;
      connectionId: string;
      turnId: string;
      observationRevision: number;
      observedAt: number;
      receivedAt: number;
      sourceEventId: string;
      sourceEventDigest: string;
      quota: Extract<ClaudeFact, { type: "rateLimitObserved" }>[
        "quota"
      ];
    }>
  | Readonly<{
      component: "accounting";
      authority: ProviderAccountAuthority;
      providerThreadId: string;
      connectionId: string;
      turnId: string;
      observationRevision: number;
      observedAt: number;
      receivedAt: number;
      sourceEventId: string;
      sourceEventDigest: string;
      accounting: Extract<ClaudeFact, { type: "usageAccountingObserved" }>[
        "accounting"
      ];
    }>;

export type ClaudeFactTranslation = Readonly<{
  timelineFacts: readonly CodexFact[];
  usageObservations: readonly ClaudeUsageObservation[];
}>;

/**
 * The interaction identity a pending Claude control request bound, remembered
 * only until the request is answered or cancelled.
 */
type RememberedInteraction = Readonly<{
  authority: ProviderInteractionAuthority;
  kind: InteractionKind;
}>;

/** Upper bound on remembered pending Claude control requests. */
const REMEMBERED_INTERACTION_LIMIT = 1_024;

/**
 * Translates the Claude bridge's fact vocabulary into the daemon's neutral
 * one.
 *
 * The daemon owns exactly one session timeline, expressed as the fact union
 * `src/codex/protocol.ts` publishes. Rather than teach every reducer, event
 * projector, classifier, and uploader a second vocabulary, the Claude facts
 * are reduced to that same union here: a Claude session then produces the
 * identical transcript events, durable interactions, turn boundaries, and
 * session-state classification as a Codex one, and the cloud projection and
 * live uploader need no provider knowledge at all.
 */
export class ClaudeSessionFactTranslator {
  readonly #authorityFor: (
    authority: ProviderAccountAuthority,
    providerThreadId: string,
    requestId: string,
  ) => ProviderInteractionAuthority;
  readonly #now: () => number;
  readonly #remembered = new Map<string, RememberedInteraction>();
  /** Item ids already announced on the current turn, per provider thread. */
  readonly #openItems = new Map<string, Map<string, string>>();

  constructor(input: {
    /** The exact provider authority the manager binds to a pending request. */
    authorityFor: (
      authority: ProviderAccountAuthority,
      providerThreadId: string,
      requestId: string,
    ) => ProviderInteractionAuthority;
    now: () => number;
  }) {
    this.#authorityFor = input.authorityFor;
    this.#now = input.now;
  }

  /** Empty for a fact the neutral timeline has no place for. */
  translate(
    authority: ProviderAccountAuthority,
    fact: ClaudeSessionFact,
  ): ClaudeFactTranslation {
    if (fact.type === "rateLimitObserved") {
      return {
        timelineFacts: [],
        usageObservations: [{
          authority,
          component: "quota",
          connectionId: fact.connectionId,
          observationRevision: fact.observationRevision,
          observedAt: fact.observedAt,
          providerThreadId: fact.providerThreadId,
          quota: fact.quota,
          receivedAt: fact.receivedAt,
          sourceEventDigest: fact.sourceEventDigest,
          sourceEventId: fact.sourceEventId,
          turnId: fact.turnId,
        }],
      };
    }
    if (fact.type === "usageAccountingObserved") {
      return {
        timelineFacts: [],
        usageObservations: [{
          accounting: fact.accounting,
          authority,
          component: "accounting",
          connectionId: fact.connectionId,
          observationRevision: fact.observationRevision,
          observedAt: fact.observedAt,
          providerThreadId: fact.providerThreadId,
          receivedAt: fact.receivedAt,
          sourceEventDigest: fact.sourceEventDigest,
          sourceEventId: fact.sourceEventId,
          turnId: fact.turnId,
        }],
      };
    }
    const single = this.#translate(authority, fact);
    if (single === null) return { timelineFacts: [], usageObservations: [] };
    // A text stream is only readable once its item has been announced: the
    // daemon's streaming redactor protects a delta whose item it never saw
    // open. Claude publishes no item lifecycle of its own, so the assembler's
    // item identity is turned into the same `itemStarted`/`itemCompleted`
    // pair Codex emits around its own agent message and reasoning items.
    if (single.type === "assistantDelta" || single.type === "reasoningSummaryDelta") {
      const opened = this.#openItem(
        authority,
        fact.providerThreadId,
        single.itemId,
        single.type === "assistantDelta" ? "agentMessage" : "reasoning",
      );
      return {
        timelineFacts: opened === null
          ? [single]
          : [{ ...opened, ...this.#itemFrame(fact, single) }, single],
        usageObservations: [],
      };
    }
    if (single.type === "turnCompleted") {
      return {
        timelineFacts: [...this.#closeItems(authority, fact, single.turn.id), single],
        usageObservations: [],
      };
    }
    if (single.type === "turnStarted") {
      this.#openItems.delete(this.#sessionKey(authority, fact.providerThreadId));
      return { timelineFacts: [single], usageObservations: [] };
    }
    return { timelineFacts: [single], usageObservations: [] };
  }

  #itemFrame(
    fact: ClaudeSessionFact,
    delta: Readonly<{ itemId: string; turnId: string }>,
  ): Readonly<{ connectionId: string; itemId: string; threadId: string; turnId: string }> {
    return {
      connectionId: fact.connectionId,
      itemId: delta.itemId,
      threadId: fact.providerThreadId,
      turnId: delta.turnId,
    };
  }

  /** Announces one item once, returning null when it is already open. */
  #openItem(
    authority: ProviderAccountAuthority,
    providerThreadId: string,
    itemId: string,
    itemKind: string,
  ): Readonly<{ itemKind: string; type: "itemStarted" }> | null {
    const sessionKey = this.#sessionKey(authority, providerThreadId);
    let items = this.#openItems.get(sessionKey);
    if (items === undefined) {
      items = new Map();
      this.#openItems.set(sessionKey, items);
    }
    if (items.has(itemId)) return null;
    items.set(itemId, itemKind);
    return { itemKind, type: "itemStarted" };
  }

  #closeItems(
    authority: ProviderAccountAuthority,
    fact: ClaudeSessionFact,
    turnId: string,
  ): readonly CodexFact[] {
    const sessionKey = this.#sessionKey(authority, fact.providerThreadId);
    const items = this.#openItems.get(sessionKey);
    this.#openItems.delete(sessionKey);
    if (items === undefined) return [];
    return [...items].map(([itemId, itemKind]) => ({
      connectionId: fact.connectionId,
      itemId,
      itemKind,
      status: "completed",
      threadId: fact.providerThreadId,
      turnId,
      type: "itemCompleted" as const,
    }));
  }

  #translate(
    authority: ProviderAccountAuthority,
    fact: ClaudeSessionFact,
  ): CodexFact | null {
    const threadId = fact.providerThreadId;
    const connectionId = fact.connectionId;
    switch (fact.type) {
      // The bootstrap line only proves the runtime came up with the reviewed
      // model and permission mode; the reviewed profile is the durable record
      // of that, so nothing is projected.
      case "sessionBootstrapped":
        return null;
      case "providerDisconnected":
        this.forgetSession(authority, threadId);
        return {
          connectionId,
          reason: fact.reason,
          type: "providerDisconnected",
        };
      case "turnStarted":
        return {
          connectionId,
          threadId,
          turn: {
            completedAt: null,
            durationMs: null,
            id: fact.turnId,
            items: [],
            startedAt: this.#now(),
            status: "inProgress",
          },
          type: "turnStarted",
        };
      case "turnCompleted":
        return {
          connectionId,
          threadId,
          turn: {
            completedAt: this.#now(),
            durationMs: null,
            id: fact.turnId,
            items: [],
            startedAt: null,
            status: fact.status,
          },
          type: "turnCompleted",
        };
      case "assistantDelta":
        return {
          connectionId,
          itemId: fact.itemId,
          text: fact.text,
          threadId,
          turnId: fact.turnId,
          type: "assistantDelta",
        };
      case "reasoningSummaryDelta":
        return {
          connectionId,
          itemId: fact.itemId,
          summaryIndex: fact.summaryIndex,
          text: fact.text,
          threadId,
          turnId: fact.turnId,
          type: "reasoningSummaryDelta",
        };
      // A started subagent carries its bounded nickname, role, and depth, and
      // only the spawned-thread fact has room for them; a later activity on an
      // already-known agent is the marker-item shape.
      case "subagentActivity":
        return fact.activity === "started"
          ? {
              agentThreadId: fact.taskId,
              connectionId,
              depth: fact.depth,
              nickname: fact.nickname,
              role: fact.role,
              threadId,
              type: "subagentThreadStarted",
            }
          : {
              connectionId,
              itemId: fact.itemId,
              itemKind: "subAgentActivity",
              subagent: { agentThreadId: fact.taskId, kind: fact.activity },
              threadId,
              turnId: fact.turnId,
              ...(fact.status === undefined ? {} : { status: fact.status }),
              type: "itemStarted",
            };
      case "interactionRequested": {
        const interactionAuthority = this.#authorityFor(
          authority,
          threadId,
          fact.requestId,
        );
        if (!this.#interactionMatchesAuthority(interactionAuthority, authority)) {
          throw new Error("CLAUDE_INTERACTION_PROVIDER_AUTHORITY_MISMATCH");
        }
        this.#remember(authority, threadId, fact.requestId, {
          authority: interactionAuthority,
          kind: fact.kind,
        });
        return {
          blocking: fact.blocking,
          connectionId,
          display: fact.display,
          kind: fact.kind,
          provider: interactionAuthority,
          type: "interactionRequested",
        };
      }
      case "interactionCanceled": {
        const remembered = this.#forget(authority, threadId, fact.requestId);
        if (remembered === undefined) return null;
        return {
          connectionId,
          kind: remembered.kind,
          provider: remembered.authority,
          type: "interactionResolved",
        };
      }
      case "tokenUsageUpdated":
        return {
          cachedInputTokens: fact.usage.cachedInputTokens ?? 0,
          connectionId,
          inputTokens: fact.usage.inputTokens ?? 0,
          modelContextWindow: fact.usage.modelContextWindow,
          outputTokens: fact.usage.outputTokens ?? 0,
          reasoningOutputTokens: fact.usage.reasoningOutputTokens ?? 0,
          threadId,
          totalTokens: fact.usage.totalTokens
            ?? (fact.usage.inputTokens ?? 0) + (fact.usage.outputTokens ?? 0),
          turnId: fact.turnId,
          type: "tokenUsageUpdated",
        };
      case "providerError":
        return {
          code: fact.code,
          connectionId,
          message: fact.message,
          terminal: fact.terminal,
          threadId,
          turnId: fact.turnId ?? "",
          type: "providerError",
        };
      case "protocolNotice":
        return { connectionId, method: fact.event, type: "protocolNotice" };
      // A provider compaction episode maps onto the shared `threadCompaction`
      // fact. Claude binds no turn to the episode, and its own trigger label
      // and error code stay provider-private — the neutral timeline owns
      // trigger attribution and carries outcomes and token counts only.
      case "compaction":
        return {
          connectionId,
          outcome: fact.outcome,
          threadId,
          turnId: null,
          type: "threadCompaction",
          ...(fact.preTokens === undefined ? {} : { preTokens: fact.preTokens }),
          ...(fact.postTokens === undefined ? {} : { postTokens: fact.postTokens }),
        };
      // The turn summary's exact runtime and result text reach the projection
      // through `readSession`, not the event stream; the rate-limit line names
      // no Codex usage counter Oompa could refresh.
      case "turnSummary":
      case "rateLimitObserved":
      case "usageAccountingObserved":
        return null;
    }
  }

  /** Drops every pending request a closed or replaced session remembered. */
  forgetSession(
    authority: ProviderAccountAuthority,
    providerThreadId: string,
  ): void {
    const sessionKey = this.#sessionKey(authority, providerThreadId);
    this.#openItems.delete(sessionKey);
    const prefix = `${sessionKey}:`;
    for (const key of [...this.#remembered.keys()]) {
      if (key.startsWith(prefix)) this.#remembered.delete(key);
    }
  }

  #remember(
    authority: ProviderAccountAuthority,
    providerThreadId: string,
    requestId: string,
    value: RememberedInteraction,
  ): void {
    if (this.#remembered.size >= REMEMBERED_INTERACTION_LIMIT) {
      const oldest = this.#remembered.keys().next();
      if (!oldest.done) this.#remembered.delete(oldest.value);
    }
    this.#remembered.set(this.#requestKey(authority, providerThreadId, requestId), value);
  }

  #forget(
    authority: ProviderAccountAuthority,
    providerThreadId: string,
    requestId: string,
  ): RememberedInteraction | undefined {
    const key = this.#requestKey(authority, providerThreadId, requestId);
    const value = this.#remembered.get(key);
    this.#remembered.delete(key);
    return value;
  }

  #sessionKey(
    authority: ProviderAccountAuthority,
    providerThreadId: string,
  ): string {
    return JSON.stringify([
      authority.profileId,
      authority.provider,
      authority.providerAccountId,
      authority.bindingGeneration,
      authority.processGeneration,
      providerThreadId,
    ]);
  }

  #requestKey(
    authority: ProviderAccountAuthority,
    providerThreadId: string,
    requestId: string,
  ): string {
    return `${this.#sessionKey(authority, providerThreadId)}:${JSON.stringify(requestId)}`;
  }

  #interactionMatchesAuthority(
    interaction: ProviderInteractionAuthority,
    authority: ProviderAccountAuthority,
  ): boolean {
    return interaction.profileId === authority.profileId
      && interaction.provider === authority.provider
      && interaction.providerAccountId === authority.providerAccountId
      && interaction.bindingGeneration === authority.bindingGeneration
      && interaction.processGeneration === authority.processGeneration;
  }
}
