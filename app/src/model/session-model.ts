/**
 * The session model reducer.
 *
 * A pure fold of the decrypted compact and detail projections into the shape
 * the grid and the session view render. It imports no React and touches no
 * document, so `bun test ./app` exercises it directly.
 *
 * Ordering contract: the caller feeds events per stream in ascending sequence
 * and never feeds the same sequence twice (the live tail de-duplicates and the
 * history walk is monotonic). The reducer therefore keeps no cursor of its own,
 * with one exception: `session_state` carries an explicit revision and a later
 * revision always wins, so a stale revision is dropped here.
 */
import type {
  CompactInteractionKind,
  CompactInteractionState,
  CompactRemoteInteractionPolicy,
  CompactSessionEvent,
  DetailSessionEvent,
  SessionStateValue,
} from "../oompa/cloud";

/**
 * One open interaction, as the projection describes it. Every optional field
 * is detail a newer daemon carries and an older one does not. Only the nested,
 * parser-validated v2 `remotePolicy` grants remote authority; the legacy v1
 * fields remain presentation-only and never enter this model as controls.
 */
export type PendingInteraction = Readonly<{
  blocking: boolean;
  detailMarkdown: string | null;
  headline: string | null;
  interactionId: string;
  interactionKind: CompactInteractionKind;
  label: string | null;
  remotePolicy: CompactRemoteInteractionPolicy | null;
  revision: number;
  state: CompactInteractionState;
  summary: string;
}>;

export type SubagentActivity = Readonly<{
  agentId: string;
  depth: number | null;
  nickname: string | null;
  role: string | null;
}>;

export type SessionModel = Readonly<{
  attention: boolean;
  /**
   * Highest revision seen per interaction id, including interactions that have
   * already left `pendingInteractions`. Without it a stale `pending` revision
   * arriving after a resolution would reopen a closed interaction.
   */
  interactionRevisions: Readonly<Record<string, number>>;
  lastActivityAt: number;
  lastPrompt: string | null;
  pendingInteractions: readonly PendingInteraction[];
  state: SessionStateValue;
  stateRevision: number;
  streamingText: string;
  subagents: readonly SubagentActivity[];
  thinkingText: string;
  title: string | null;
  turnActive: boolean;
  turnId: string | null;
}>;

export type SessionModelAction =
  | Readonly<{ type: "reset" }>
  | Readonly<{ name: string | null; type: "metadata" }>
  | Readonly<{ events: readonly CompactSessionEvent[]; type: "compact" }>
  | Readonly<{ events: readonly DetailSessionEvent[]; type: "detail" }>;

/**
 * Interaction states that still want a human. Everything else is terminal or
 * already answered, so the card stops asking.
 */
const openInteractionStates = new Set<CompactInteractionState>([
  "pending",
]);

const terminalSessionStates = new Set<SessionStateValue>([
  "done",
  "done_followups",
  "done_caveats",
  "aborted",
]);

export const maximumStreamingCharacters = 64_000;

export function initialSessionModel(): SessionModel {
  return {
    attention: false,
    interactionRevisions: {},
    lastActivityAt: 0,
    lastPrompt: null,
    pendingInteractions: [],
    state: "working",
    stateRevision: 0,
    streamingText: "",
    subagents: [],
    thinkingText: "",
    title: null,
    turnActive: false,
    turnId: null,
  };
}

/** The first line of the first prompt, bounded, used when no name is set. */
export function derivedTitle(prompt: string): string {
  const line = prompt.split("\n").find((candidate) => candidate.trim().length > 0) ?? "";
  const trimmed = line.trim();
  return trimmed.length <= 72 ? trimmed : `${trimmed.slice(0, 71)}…`;
}

function appendBounded(current: string, addition: string): string {
  const next = current + addition;
  return next.length <= maximumStreamingCharacters
    ? next
    : next.slice(next.length - maximumStreamingCharacters);
}

function upsertInteraction(
  model: SessionModel,
  event: Extract<CompactSessionEvent, { kind: "interaction_state" }>,
): SessionModel {
  const seen = model.interactionRevisions[event.interactionId];
  if (seen !== undefined && seen >= event.revision) return model;
  const without = model.pendingInteractions
    .filter((entry) => entry.interactionId !== event.interactionId);
  const pendingInteractions = openInteractionStates.has(event.state)
    ? [
        ...without,
        {
          blocking: event.blocking,
          detailMarkdown: event.detailMarkdown ?? null,
          headline: event.headline ?? null,
          interactionId: event.interactionId,
          interactionKind: event.interactionKind,
          label: event.label ?? null,
          remotePolicy: event.remotePolicy ?? null,
          revision: event.revision,
          state: event.state,
          summary: event.summary,
        },
      ]
    : without;
  return {
    ...model,
    interactionRevisions: {
      ...model.interactionRevisions,
      [event.interactionId]: event.revision,
    },
    pendingInteractions,
  };
}

function foldCompact(model: SessionModel, event: CompactSessionEvent): SessionModel {
  switch (event.kind) {
    case "user_message":
      return {
        ...model,
        lastPrompt: event.text,
        title: model.title ?? derivedTitle(event.text),
      };
    case "assistant_message":
      // The compact projection carries the authoritative final text for the
      // turn. It replaces whatever the live deltas accumulated.
      return { ...model, streamingText: event.text, turnId: event.turnId };
    case "interaction_state":
      return upsertInteraction(model, event);
    case "turn_summary":
      return event.turnId === model.turnId || model.turnId === null
        ? { ...model, turnActive: false }
        : model;
    default:
      return model;
  }
}

function foldDetail(model: SessionModel, event: DetailSessionEvent): SessionModel {
  switch (event.type) {
    case "turn_started":
      return {
        ...model,
        lastActivityAt: Math.max(model.lastActivityAt, event.at),
        streamingText: event.turnId === model.turnId ? model.streamingText : "",
        thinkingText: event.turnId === model.turnId ? model.thinkingText : "",
        turnActive: true,
        turnId: event.turnId,
      };
    case "assistant_delta":
      return {
        ...model,
        streamingText: event.turnId === model.turnId
          ? appendBounded(model.streamingText, event.text)
          : event.text,
        thinkingText: event.turnId === model.turnId ? model.thinkingText : "",
        turnActive: true,
        turnId: event.turnId,
      };
    case "reasoning_summary_delta":
      return {
        ...model,
        thinkingText: event.turnId === model.turnId
          ? appendBounded(model.thinkingText, event.text)
          : event.text,
        turnId: event.turnId,
      };
    case "subagent_activity": {
      const without = model.subagents.filter((entry) => entry.agentId !== event.agentId);
      if (event.kind === "interrupted" || event.kind === "completed") {
        return { ...model, subagents: without };
      }
      // Only the thread-start announcement carries the nickname, role, and
      // depth; a later activity for the same agent omits them, so what is
      // already known is kept rather than blanked.
      const known = model.subagents.find((entry) => entry.agentId === event.agentId);
      return {
        ...model,
        subagents: [
          ...without,
          {
            agentId: event.agentId,
            depth: event.depth ?? known?.depth ?? null,
            nickname: event.nickname ?? known?.nickname ?? null,
            role: event.role ?? known?.role ?? null,
          },
        ],
      };
    }
    case "session_state":
      if (event.revision <= model.stateRevision) return model;
      return {
        ...model,
        attention: event.attention,
        lastActivityAt: Math.max(model.lastActivityAt, event.lastActivityAt),
        state: event.state,
        stateRevision: event.revision,
        turnActive: model.turnActive && !terminalSessionStates.has(event.state),
      };
    default:
      return model;
  }
}

export function sessionModelReducer(
  model: SessionModel,
  action: SessionModelAction,
): SessionModel {
  switch (action.type) {
    case "reset":
      return initialSessionModel();
    case "metadata":
      return action.name === null ? model : { ...model, title: action.name };
    case "compact":
      return action.events.reduce(foldCompact, model);
    case "detail":
      return action.events.reduce(foldDetail, model);
    default:
      return model;
  }
}
