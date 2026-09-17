import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import {
  autoCompactPolicySchema,
  defaultAutoCompactPolicy,
  evaluateAutoCompact,
  AUTO_COMPACT_MAX_MIN_INTERVAL_MS,
  AUTO_COMPACT_MAX_TRIGGER_TOKENS,
  AUTO_COMPACT_MIN_INTERVAL_FLOOR_MS,
  AUTO_COMPACT_MIN_TRIGGER_TOKENS,
} from "./compact-policy";

const base = {
  enabled: true,
  totalTokens: 300_000,
  modelContextWindow: 1_000_000,
  triggerTokens: 250_000,
  minIntervalMs: 300_000,
  lastCompactionAtMs: null,
  turnInFlight: false,
  nowMs: 1_000_000_000,
};

describe("autoCompactPolicySchema", () => {
  test("accepts the default and rejects out-of-range values", () => {
    expect(autoCompactPolicySchema.parse(defaultAutoCompactPolicy())).toEqual(defaultAutoCompactPolicy());
    expect(defaultAutoCompactPolicy().enabled).toBe(false);
    expect(autoCompactPolicySchema.safeParse({ enabled: true, triggerTokens: AUTO_COMPACT_MIN_TRIGGER_TOKENS - 1, minIntervalMs: 300_000 }).success).toBe(false);
    expect(autoCompactPolicySchema.safeParse({ enabled: true, triggerTokens: AUTO_COMPACT_MAX_TRIGGER_TOKENS + 1, minIntervalMs: 300_000 }).success).toBe(false);
    expect(autoCompactPolicySchema.safeParse({ enabled: true, triggerTokens: 250_000, minIntervalMs: 1 }).success).toBe(false);
    expect(autoCompactPolicySchema.safeParse({ enabled: true, triggerTokens: 250_000, minIntervalMs: 300_000, extra: 1 }).success).toBe(false);
  });
});

describe("evaluateAutoCompact", () => {
  test("disabled policy never fires", () => {
    expect(evaluateAutoCompact({ ...base, enabled: false })).toEqual({ action: "observe", reason: "disabled" });
  });

  test("missing usage never fires", () => {
    expect(evaluateAutoCompact({ ...base, totalTokens: null }).reason).toBe("no_usage");
  });

  test("under trigger observes", () => {
    expect(evaluateAutoCompact({ ...base, totalTokens: 249_999 }).reason).toBe("under_trigger");
  });

  test("at trigger compacts", () => {
    expect(evaluateAutoCompact(base)).toEqual({ action: "compact", reason: "over_trigger" });
  });

  test("an in-flight turn defers", () => {
    expect(evaluateAutoCompact({ ...base, turnInFlight: true }).reason).toBe("turn_in_flight");
  });

  test("a recent compaction defers until the interval elapses", () => {
    const last = base.nowMs - 60_000;
    expect(evaluateAutoCompact({ ...base, lastCompactionAtMs: last }).reason).toBe("interval_active");
    expect(evaluateAutoCompact({ ...base, lastCompactionAtMs: base.nowMs - 300_000 }).action).toBe("compact");
  });

  test("trigger is capped by the model context window", () => {
    expect(evaluateAutoCompact({ ...base, modelContextWindow: 200_000, totalTokens: 210_000 }).action).toBe("compact");
    expect(evaluateAutoCompact({ ...base, modelContextWindow: 200_000, totalTokens: 199_999 }).reason).toBe("under_trigger");
  });

  const inputArb = fc.record({
    enabled: fc.boolean(),
    totalTokens: fc.oneof(fc.constant(null), fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER })),
    modelContextWindow: fc.oneof(fc.constant(null), fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER })),
    triggerTokens: fc.integer({ min: AUTO_COMPACT_MIN_TRIGGER_TOKENS, max: AUTO_COMPACT_MAX_TRIGGER_TOKENS }),
    minIntervalMs: fc.integer({ min: AUTO_COMPACT_MIN_INTERVAL_FLOOR_MS, max: AUTO_COMPACT_MAX_MIN_INTERVAL_MS }),
    lastCompactionAtMs: fc.oneof(fc.constant(null), fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER })),
    turnInFlight: fc.boolean(),
    nowMs: fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
  });

  test("the decision stays inside the closed union for arbitrary inputs", () => {
    fc.assert(fc.property(inputArb, (input) => {
      const decision = evaluateAutoCompact(input);
      expect(decision.action === "compact").toBe(decision.reason === "over_trigger");
      expect([
        "disabled",
        "no_usage",
        "under_trigger",
        "turn_in_flight",
        "interval_active",
        "over_trigger",
      ]).toContain(decision.reason);
    }), { seed: 61, numRuns: 300 });
  });

  test("compact implies every precondition and stays monotone in observed tokens", () => {
    fc.assert(fc.property(
      inputArb,
      fc.integer({ min: 1, max: 1_000_000 }),
      (input, extra) => {
        const decision = evaluateAutoCompact(input);
        if (decision.action !== "compact" || input.totalTokens === null) return;
        const effectiveTrigger = input.modelContextWindow === null
          ? input.triggerTokens
          : Math.min(input.triggerTokens, input.modelContextWindow);
        expect(input.enabled).toBe(true);
        expect(input.turnInFlight).toBe(false);
        expect(input.totalTokens).toBeGreaterThanOrEqual(effectiveTrigger);
        if (input.lastCompactionAtMs !== null) {
          expect(input.nowMs - input.lastCompactionAtMs)
            .toBeGreaterThanOrEqual(input.minIntervalMs);
        }
        const later = Math.min(Number.MAX_SAFE_INTEGER, input.totalTokens + extra);
        if (later > input.totalTokens) {
          expect(evaluateAutoCompact({ ...input, totalTokens: later }).action).toBe("compact");
        }
      },
    ), { seed: 62, numRuns: 300 });
  });

  test("an interval_active decision fires exactly once the interval elapses", () => {
    fc.assert(fc.property(inputArb, (input) => {
      const decision = evaluateAutoCompact(input);
      if (decision.reason !== "interval_active" || input.lastCompactionAtMs === null) return;
      const boundary = input.lastCompactionAtMs + input.minIntervalMs;
      if (boundary > Number.MAX_SAFE_INTEGER) return;
      expect(evaluateAutoCompact({ ...input, nowMs: boundary }).action).toBe("compact");
    }), { seed: 63, numRuns: 300 });
  });

  test("the schema round-trips every in-bounds policy", () => {
    fc.assert(fc.property(
      fc.boolean(),
      fc.integer({ min: AUTO_COMPACT_MIN_TRIGGER_TOKENS, max: AUTO_COMPACT_MAX_TRIGGER_TOKENS }),
      fc.integer({ min: AUTO_COMPACT_MIN_INTERVAL_FLOOR_MS, max: AUTO_COMPACT_MAX_MIN_INTERVAL_MS }),
      (enabled, triggerTokens, minIntervalMs) => {
        const value = { enabled, triggerTokens, minIntervalMs };
        expect(autoCompactPolicySchema.parse(value)).toEqual(value);
        expect(autoCompactPolicySchema.parse(JSON.parse(JSON.stringify(value)) as unknown))
          .toEqual(value);
      },
    ), { seed: 64, numRuns: 200 });
  });
});
