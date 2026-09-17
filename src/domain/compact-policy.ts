import { z } from "zod";

/**
 * Auto-compaction policy: a pure decision over a session's latest token_usage
 * fact. When enabled, a context crossing the trigger produces exactly one
 * `session.compact` durable command per usage bucket — the dispatch itself is
 * the rate limiter, never the observation.
 *
 * Defaults mirror gobstopper's research-backed posture: compact far earlier
 * than provider defaults (sawtooth math: average context ≈ (trigger+floor)/2,
 * so a 250k trigger roughly halves a 1M-default turn's cost), and never fire
 * while a turn is in flight.
 */
export const AUTO_COMPACT_DEFAULT_TRIGGER_TOKENS = 250_000;
export const AUTO_COMPACT_MIN_TRIGGER_TOKENS = 20_000;
export const AUTO_COMPACT_MAX_TRIGGER_TOKENS = 4_000_000;
export const AUTO_COMPACT_DEFAULT_MIN_INTERVAL_MS = 300_000;
export const AUTO_COMPACT_MIN_INTERVAL_FLOOR_MS = 30_000;
export const AUTO_COMPACT_MAX_MIN_INTERVAL_MS = 86_400_000;

export const autoCompactPolicySchema = z.object({
  enabled: z.boolean(),
  triggerTokens: z.number().int()
    .min(AUTO_COMPACT_MIN_TRIGGER_TOKENS)
    .max(AUTO_COMPACT_MAX_TRIGGER_TOKENS),
  minIntervalMs: z.number().int()
    .min(AUTO_COMPACT_MIN_INTERVAL_FLOOR_MS)
    .max(AUTO_COMPACT_MAX_MIN_INTERVAL_MS),
}).strict();
export type AutoCompactPolicy = z.infer<typeof autoCompactPolicySchema>;

export function defaultAutoCompactPolicy(): AutoCompactPolicy {
  return {
    enabled: false,
    triggerTokens: AUTO_COMPACT_DEFAULT_TRIGGER_TOKENS,
    minIntervalMs: AUTO_COMPACT_DEFAULT_MIN_INTERVAL_MS,
  };
}

export type AutoCompactDecision = Readonly<{
  action: "compact" | "observe";
  reason:
    | "disabled"
    | "no_usage"
    | "under_trigger"
    | "turn_in_flight"
    | "interval_active"
    | "over_trigger";
}>;

/**
 * Pure evaluation of one token_usage observation. `totalTokens` is the
 * provider's current-context reading; `modelContextWindow` bounds the
 * effective trigger so a trigger above the window can never fire.
 */
export function evaluateAutoCompact(input: Readonly<{
  enabled: boolean;
  totalTokens: number | null;
  modelContextWindow: number | null;
  triggerTokens: number;
  minIntervalMs: number;
  lastCompactionAtMs: number | null;
  turnInFlight: boolean;
  nowMs: number;
}>): AutoCompactDecision {
  if (!input.enabled) return { action: "observe", reason: "disabled" };
  if (input.totalTokens === null) return { action: "observe", reason: "no_usage" };
  const effectiveTrigger = input.modelContextWindow === null
    ? input.triggerTokens
    : Math.min(input.triggerTokens, input.modelContextWindow);
  if (input.totalTokens < effectiveTrigger) {
    return { action: "observe", reason: "under_trigger" };
  }
  if (input.turnInFlight) return { action: "observe", reason: "turn_in_flight" };
  if (
    input.lastCompactionAtMs !== null
    && input.nowMs - input.lastCompactionAtMs < input.minIntervalMs
  ) {
    return { action: "observe", reason: "interval_active" };
  }
  return { action: "compact", reason: "over_trigger" };
}
