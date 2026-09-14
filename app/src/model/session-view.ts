/**
 * View-model derivations for the grid and the session screen.
 *
 * Everything here is a pure function over projection-derived values: no React,
 * no document, no Convex. The screens keep only layout and effects, so the
 * ordering ladder, the composer target rule, and the interaction affordance
 * table are all provable under `bun test ./app`.
 */
import type {
  CompactInteractionKind,
  CompactRemoteInteractionAction,
  CompactRemoteInteractionPolicy,
  CompactRemoteInteractionQuestion,
  CompactRemoteInteractionReasonCode,
  SessionStateValue,
} from "../oompa/cloud";

export type SessionTone = "neutral" | "accent" | "attention" | "danger";

export const sessionStateLabel: Readonly<Record<SessionStateValue, string>> = Object.freeze({
  aborted: "Aborted",
  done: "Done",
  done_caveats: "Done, caveats",
  done_followups: "Done, follow ups",
  needs_action: "Needs you",
  needs_answer: "Needs an answer",
  needs_approval: "Needs approval",
  working: "Working",
});

export const sessionStateTone: Readonly<Record<SessionStateValue, SessionTone>> = Object.freeze({
  aborted: "danger",
  done: "neutral",
  done_caveats: "danger",
  done_followups: "neutral",
  needs_action: "attention",
  needs_answer: "attention",
  needs_approval: "attention",
  working: "accent",
});

/**
 * One card's ordering facts. The grid cannot read them from the session head,
 * because the head carries no session state, so each card reports its own
 * folded summary upward and the grid orders what it has been told.
 */
export type SessionCardSummary = Readonly<{
  archived: boolean;
  retiredProvider?: "devin";
  attention: boolean;
  lastActivityAt: number;
  /**
   * The head revision the archived flag and the name were read from. The grid
   * discards a summary whose revision the head has moved past, so a rename or
   * an unarchive from another device re-mounts the card instead of leaving a
   * stale one hidden.
   */
  metadataRevision: number;
  publicId: string;
  state: SessionStateValue;
  title: string;
}>;

/**
 * The ordering ladder: cards that want a human first, then cards that are
 * working, then everything else. Inside a group the most recent activity wins,
 * with the public id as the final tie break so the order never depends on the
 * arrival order of two equal timestamps. Archived sessions leave the grid; they
 * come back from the settings screen.
 *
 * `manualOrder` is the reader's own arrangement (`model/card-order.ts`), and it
 * applies inside the attention grouping: a card the reader placed third still
 * loses its place to a card that starts asking for a human, and takes it back
 * when the question is answered. A card the arrangement does not name falls
 * through to the automatic ladder behind every card it does name, so an empty
 * arrangement orders the grid exactly as it did before there was one.
 */
export function orderSessionCards(
  summaries: readonly SessionCardSummary[],
  manualOrder: readonly string[] = [],
): readonly SessionCardSummary[] {
  const placed = new Map(manualOrder.map((publicId, index) => [publicId, index]));
  const attentionRank = (summary: SessionCardSummary): number => (summary.attention ? 0 : 1);
  const manualRank = (summary: SessionCardSummary): number =>
    placed.get(summary.publicId) ?? Number.MAX_SAFE_INTEGER;
  const activityRank = (summary: SessionCardSummary): number => {
    if (summary.attention) return 0;
    return summary.state === "working" ? 1 : 2;
  };
  return [...summaries]
    .filter((summary) => !summary.archived)
    .sort((left, right) => {
      const byAttention = attentionRank(left) - attentionRank(right);
      if (byAttention !== 0) return byAttention;
      const byManual = manualRank(left) - manualRank(right);
      if (byManual !== 0) return byManual;
      const byRank = activityRank(left) - activityRank(right);
      if (byRank !== 0) return byRank;
      const byActivity = right.lastActivityAt - left.lastActivityAt;
      if (byActivity !== 0) return byActivity;
      return left.publicId < right.publicId ? -1 : left.publicId > right.publicId ? 1 : 0;
    });
}

/** What a card knows about one running subagent, as the detail stream reports it. */
export type SubagentChipInput = Readonly<{
  agentId: string;
  depth: number | null;
  nickname: string | null;
  role: string | null;
}>;

export type SubagentChip = Readonly<{
  agentId: string;
  depth: number | null;
  /** The one line shown when the chip is hovered or tapped. */
  detail: string;
  /** The chip face: the nickname, else the role, else an opaque short id. */
  label: string;
  role: string | null;
}>;

export type SubagentChipSet = Readonly<{
  chips: readonly SubagentChip[];
  /** How many running subagents the chips do not name. */
  overflow: number;
}>;

export const maximumSubagentChips = 3;

/** A chip face stays short enough that three of them fit a phone-width card. */
export const subagentChipCharacters = 24;

function chipLabel(subagent: SubagentChipInput): string {
  const named = subagent.nickname?.trim() ?? "";
  const role = subagent.role?.trim() ?? "";
  const text = named.length > 0
    ? named
    : role.length > 0 ? role : `Agent ${subagent.agentId.slice(0, 6)}`;
  return text.length <= subagentChipCharacters
    ? text
    : `${text.slice(0, subagentChipCharacters - 1)}…`;
}

function chipDetail(subagent: SubagentChipInput): string {
  const role = subagent.role?.trim() ?? "";
  const depth = subagent.depth === null || !Number.isFinite(subagent.depth)
    ? "depth unknown"
    : `depth ${String(subagent.depth)}`;
  return `${role.length > 0 ? role : "No role reported"} · ${depth}`;
}

/**
 * The card's subagent chips.
 *
 * A session with no running subagent gets nothing at all, not an empty row.
 * Beyond `maximum` the count is carried by an overflow chip rather than by
 * shrinking the faces, and the order is derived rather than arrival based —
 * shallowest first, then by face — so a card that repaints every second does
 * not reshuffle its own chips.
 */
export function subagentChips(
  subagents: readonly SubagentChipInput[],
  maximum: number = maximumSubagentChips,
): SubagentChipSet {
  const all = [...subagents]
    .map((subagent) => ({
      agentId: subagent.agentId,
      depth: subagent.depth,
      detail: chipDetail(subagent),
      label: chipLabel(subagent),
      role: subagent.role,
    }))
    .sort((left, right) => {
      const leftDepth = left.depth ?? Number.MAX_SAFE_INTEGER;
      const rightDepth = right.depth ?? Number.MAX_SAFE_INTEGER;
      if (leftDepth !== rightDepth) return leftDepth - rightDepth;
      // Code point order rather than a locale collation: the chip row must not
      // depend on the runtime's locale data.
      if (left.label !== right.label) return left.label < right.label ? -1 : 1;
      if (left.agentId === right.agentId) return 0;
      return left.agentId < right.agentId ? -1 : 1;
    });
  const kept = maximum < 1 ? [] : all.slice(0, maximum);
  return { chips: kept, overflow: all.length - kept.length };
}

const idleStates = new Set<SessionStateValue>([
  "done",
  "done_followups",
  "done_caveats",
  "aborted",
]);

export function isIdleSession(state: SessionStateValue): boolean {
  return idleStates.has(state);
}

export const interactionKindLabel: Readonly<Record<CompactInteractionKind, string>> =
  Object.freeze({
    command_approval: "Command approval",
    file_change_approval: "File change approval",
    mcp_elicitation: "MCP form",
    permission_approval: "Permission request",
    user_input: "Question",
  });

export type InteractionAffordance = Readonly<{
  /** Exact actions this reader may offer right now, in wire order. */
  actions: readonly CompactRemoteInteractionAction[];
  /** Exact projected questions, present only while `answer` is actionable. */
  questions: readonly CompactRemoteInteractionQuestion[];
  /** Why authority is absent or intentionally narrower than the local UI. */
  reasonCodes: readonly InteractionAvailabilityReason[];
  reachability: "machine_only" | "remote_available" | "remote_limited";
}>;

export type InteractionAvailabilityReason =
  | CompactRemoteInteractionReasonCode
  | "REMOTE_POLICY_UNAVAILABLE";

/** Exhaustive reader-safe copy for every shared policy reason. */
export const interactionReasonCopy: Readonly<Record<InteractionAvailabilityReason, string>> =
  Object.freeze({
    COMMAND_APPROVAL_LOCAL_ONLY:
      "Approving this command needs its complete protected authority on the machine.",
    COMMAND_DECLINE_NOT_OFFERED: "The provider did not offer a decline action.",
    FILE_CHANGE_APPROVAL_LOCAL_ONLY:
      "Approving this file change needs the exact diff on the machine.",
    FILE_CHANGE_DECLINE_NOT_OFFERED: "The provider did not offer a decline action.",
    PERMISSION_APPROVAL_LOCAL_ONLY:
      "Granting this permission needs its protected values on the machine.",
    INTERACTION_EXPIRED: "The remote-action deadline has passed.",
    INTERACTION_NOT_PENDING: "This request is no longer pending.",
    INTERACTION_TIME_INVALID: "The request deadline could not be verified.",
    MCP_FIELDS_MISSING: "The complete MCP form is unavailable here.",
    MCP_ANSWER_LOCAL_ONLY:
      "MCP form values stay on the machine because their sensitivity cannot be verified here.",
    MCP_MODE_UNSUPPORTED: "This MCP interaction mode is completed on the machine.",
    PERMISSION_REQUEST_EMPTY: "The permission request has no verifiable category.",
    REMOTE_POLICY_UNAVAILABLE:
      "This projection carries no remote-action policy understood by this reader.",
    USER_INPUT_METADATA_UNPROJECTABLE: "The question cannot be represented exactly here.",
    USER_INPUT_FREE_TEXT_LOCAL_ONLY: "Free-text answers stay on the machine.",
    USER_INPUT_PROVIDER_CONTRACT_LOCAL_ONLY:
      "The provider answer contract cannot be represented exactly here.",
    USER_INPUT_SECRET_QUESTION: "A protected answer must be entered on the machine.",
  });

/**
 * What this reader may offer for one pending interaction. The app does not
 * reconstruct authority from the interaction kind. It consumes only the
 * parser-validated v2 policy and applies a final local deadline suppression;
 * the custodian daemon still recomputes the same policy before applying it.
 * An old daemon, an unknown policy version, or an omitted policy fails closed.
 */
export function interactionAffordance(
  remotePolicy: CompactRemoteInteractionPolicy | null,
  now = Date.now(),
): InteractionAffordance {
  if (remotePolicy === null) {
    return {
      actions: [],
      questions: [],
      reachability: "machine_only",
      reasonCodes: ["REMOTE_POLICY_UNAVAILABLE"],
    };
  }
  if (now >= remotePolicy.deadlineAt) {
    return {
      actions: [],
      questions: [],
      reachability: "machine_only",
      reasonCodes: [
        "INTERACTION_EXPIRED",
        ...remotePolicy.reasonCodes.filter((code) => code !== "INTERACTION_EXPIRED"),
      ],
    };
  }
  const actions = [...remotePolicy.actions];
  const questions = actions.includes("answer") ? [...remotePolicy.questions] : [];
  return {
    actions,
    questions,
    reasonCodes: [...remotePolicy.reasonCodes],
    reachability: actions.length === 0
      ? "machine_only"
      : remotePolicy.reasonCodes.length === 0
        ? "remote_available"
        : "remote_limited",
  };
}

/** Whether this device can resolve the interaction at all. */
export function interactionIsLocalOnly(affordance: InteractionAffordance): boolean {
  return affordance.reachability === "machine_only";
}

/** Stable React identity for draft and command state owned by one revision. */
export function interactionInstanceKey(
  interaction: Readonly<{ interactionId: string; revision: number }>,
): string {
  return `${interaction.interactionId}:${String(interaction.revision)}`;
}

/** A submitted command never follows the panel into another revision. */
export function interactionCommandPublicId(
  command: Readonly<{ interactionKey: string; publicId: string }> | null,
  interaction: Readonly<{ interactionId: string; revision: number }> | null,
): string | null {
  return command !== null
    && interaction !== null
    && command.interactionKey === interactionInstanceKey(interaction)
    ? command.publicId
    : null;
}

/** The one-line `turn_summary` marker under a finished turn. */
export function turnSummaryLine(input: Readonly<{
  filesTouched: number;
  gitActions: readonly string[];
  runtimeMs: number;
}>): string {
  const parts: string[] = [];
  parts.push(input.filesTouched === 1 ? "1 file" : `${String(input.filesTouched)} files`);
  if (input.gitActions.length > 0) parts.push(input.gitActions.join(", "));
  parts.push(formatDuration(input.runtimeMs));
  return parts.join(" · ");
}

export function formatDuration(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "unknown";
  const seconds = Math.round(milliseconds / 1_000);
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m ${String(seconds % 60)}s`;
  return `${String(Math.floor(minutes / 60))}h ${String(minutes % 60)}m`;
}

/** A bounded, non-identifying label for a session with no name and no prompt. */
export function shortSessionLabel(publicId: string): string {
  return `Session ${publicId.slice(0, 8)}`;
}
