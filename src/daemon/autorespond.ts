/*
 * Autorespond policy for brokered provider approvals.
 *
 * When a session runs in `auto:all`, Oompa answers command and permission
 * approvals immediately with the accept decision at `once` scope.
 * `auto:workspace` remains fail-closed until adapters can attest exact private
 * authority against a bound project root. File changes, questions, and MCP
 * forms are never answered here. Every action is bounded by a consecutive
 * counter that only a human message resets plus hourly and daily budgets.
 * A separate default-off consent may select higher protocol limits outside
 * notification hours. The decision is pure; the controller applies it through the daemon's ordinary
 * resolve path and records evidence.
 */

import type { ApprovalMode, InteractionDisplay, InteractionKind } from "../domain/interactions";
import type { AutorespondAfterHoursSelection } from "../domain/autorespond-after-hours";
import { decideProtocolAutorespondAuthority } from "../domain/autorespond-protocol-policy";
import {
  AUTORESPOND_CONSECUTIVE_LIMIT,
  AUTORESPOND_HOURLY_BUDGET,
  AUTORESPOND_DAILY_BUDGET,
} from "../domain/autorespond-budget";

export { AUTORESPOND_CONSECUTIVE_LIMIT, AUTORESPOND_HOURLY_BUDGET, AUTORESPOND_DAILY_BUDGET };

export type AutorespondBudgets = Readonly<{
  consecutive: number;
  lastHour: number;
  lastDay: number;
}>;

export type AutorespondDecision =
  | Readonly<{ action: "accept"; decision: "once"; approvalClass: string }>
  | Readonly<{ action: "escalate"; code: AutorespondEscalation; approvalClass: string }>;

export type AutorespondEscalation =
  | "manual_mode"
  | "not_an_approval"
  | "decision_unavailable"
  | "protected_authority_required"
  | "consecutive_limit"
  | "hourly_budget"
  | "daily_budget";

export function permissionNamesOf(display: InteractionDisplay): string[] {
  return display.kind === "permission_approval"
    ? display.requested.map((permission) => permission.name)
    : [];
}

export function decideAutorespond(input: Readonly<{
  budgets: AutorespondBudgets;
  display: InteractionDisplay;
  kind: InteractionKind;
  mode: ApprovalMode;
  selection?: AutorespondAfterHoursSelection;
}>): AutorespondDecision {
  const authority = decideProtocolAutorespondAuthority(input);
  if (authority.action === "escalate") return authority;
  const { approvalClass } = authority;
  const limits = input.selection?.limits ?? {
    consecutive: AUTORESPOND_CONSECUTIVE_LIMIT,
    lastHour: AUTORESPOND_HOURLY_BUDGET,
    lastDay: AUTORESPOND_DAILY_BUDGET,
  };
  if (input.budgets.consecutive >= limits.consecutive) {
    return { action: "escalate", code: "consecutive_limit", approvalClass };
  }
  if (input.budgets.lastHour >= limits.lastHour) {
    return { action: "escalate", code: "hourly_budget", approvalClass };
  }
  if (input.budgets.lastDay >= limits.lastDay) {
    return { action: "escalate", code: "daily_budget", approvalClass };
  }
  return { action: "accept", decision: "once", approvalClass };
}

/*
 * Prose path (W2). A prose approval has no provider interaction, so the
 * decision is the positive gate plus the baseline budgets:
 * at most one autoresponse per turn, a consecutive counter that only a
 * human-authored send resets, and the hourly and daily caps. The gate itself
 * (cues, message length, gateway key, pending interactions) is evaluated by
 * the daemon, which owns the classifier report and the store.
 */
export type ProseAutorespondGateFailure =
  | "consecutive_limit"
  | "credits_required"
  | "daily_budget"
  | "denylist_cue"
  | "gateway_key_missing"
  | "hourly_budget"
  | "human_action_cue"
  | "manual_mode"
  | "message_too_long"
  | "not_an_approval_cue"
  | "pending_interaction"
  | "policy_changed"
  | "source_changed"
  | "source_already_reserved"
  | "history_unavailable"
  | "verbatim_literal_missing";

export const PROSE_AUTORESPOND_MAX_MESSAGE_CHARACTERS = 4_000;

export type ProseAutorespondDecision =
  | Readonly<{ action: "send" }>
  | Readonly<{ action: "escalate"; code: ProseAutorespondGateFailure }>;

/** Budget half of the prose gate; the daemon applies the cue and custody half. */
export function decideProseAutorespond(input: Readonly<{
  budgets: AutorespondBudgets;
  mode: ApprovalMode;
}>): ProseAutorespondDecision {
  if (input.mode === "manual") return { action: "escalate", code: "manual_mode" };
  if (input.budgets.consecutive >= AUTORESPOND_CONSECUTIVE_LIMIT) {
    return { action: "escalate", code: "consecutive_limit" };
  }
  if (input.budgets.lastHour >= AUTORESPOND_HOURLY_BUDGET) {
    return { action: "escalate", code: "hourly_budget" };
  }
  if (input.budgets.lastDay >= AUTORESPOND_DAILY_BUDGET) {
    return { action: "escalate", code: "daily_budget" };
  }
  return { action: "send" };
}

export type AutorespondEvidenceInput = Readonly<{
  approvalClass: string;
  decision: string;
  interactionId: string;
  kind: InteractionKind;
  latencyMs: number;
  mode: ApprovalMode;
  outcome: "accepted" | "refused";
  sessionId: string;
  subagent: boolean;
}>;
