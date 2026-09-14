import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import type { UsageLimit, UsageProjection } from "../oompa/cloud";
import { accountUsageSummary, bindingWindow, formatResetInstant, providerUsageRollup, staleObservationMs, type UsageObservation } from "./usage-meter";

const hour = 3_600_000;
const now = 1_760_000_000_000;
function limit(overrides: Partial<UsageLimit> = {}): UsageLimit {
  return {
    id: "codex", individual: false, name: "Codex", reached: false, unlimited: false,
    primary: { resetsAt: now + hour, usedPercent: 40, windowDurationMinutes: 300 },
    secondary: { resetsAt: now + 100 * hour, usedPercent: 10, windowDurationMinutes: 10_080 },
    ...overrides,
  };
}
function ready(limits: readonly UsageLimit[]): UsageProjection {
  return { state: "ready", data: {
    limits, daily: [], currentStreakDays: 1, lifetimeTokens: 1000,
    longestRunningTurnSeconds: 0, longestStreakDays: 1, peakDailyTokens: 0,
  } };
}
const observation = (overrides: Partial<UsageObservation> = {}): UsageObservation => ({
  observedAt: now, projection: ready([limit()]), ...overrides,
});

describe("daily usage summaries", () => {
  test("selects the tightest window and the earliest reset tie", () => {
    expect(bindingWindow([limit(), limit({ id: "other", primary: {
      resetsAt: now + 2 * hour, usedPercent: 80, windowDurationMinutes: 300,
    } })])?.limitId).toBe("other");
    expect(bindingWindow([limit({ id: "later", primary: {
      resetsAt: now + 2 * hour, usedPercent: 40, windowDurationMinutes: 300,
    } }), limit()])?.limitId).toBe("codex");
  });

  test("missing, failed, unreadable and future newest rows never fall back", () => {
    expect(accountUsageSummary([], now)).toBeNull();
    for (const projection of [null, { state: "failed" }, { state: "loading" }, { state: "unavailable" }] as const) {
      expect(accountUsageSummary([observation({ observedAt: now - 1 }), observation({ projection })], now)).toBeNull();
    }
    expect(accountUsageSummary([observation({ observedAt: now + 1 })], now)).toBeNull();
  });

  test("stale and expired reports cannot imply current availability", () => {
    expect(accountUsageSummary([observation({ observedAt: now - staleObservationMs - 1 })], now)).toBeNull();
    expect(accountUsageSummary([observation({ projection: ready([limit({ primary: {
      resetsAt: now, usedPercent: 100, windowDurationMinutes: 300,
    } })]) })], now)).toBeNull();
  });

  test("missing windows and the legacy unlimited bit never mean full capacity", () => {
    for (const limits of [[], [limit({ primary: null, secondary: null })], [limit({ reached: true })]]) {
      expect(accountUsageSummary([observation({ projection: ready(limits) })], now)).toBeNull();
    }
    expect(accountUsageSummary([observation({ projection: ready([
      limit({ primary: null, secondary: null, unlimited: true }),
    ]) })], now)).toBeNull();
    expect(accountUsageSummary([observation({ projection: ready([
      limit({ primary: null, secondary: null, unlimited: true, reached: true }),
    ]) })], now)).toBeNull();
  });

  test("a full legacy limit list cannot prove complete coverage", () => {
    const limits = Array.from({ length: 8 }, (_, index) => limit({ id: `limit-${String(index)}` }));
    expect(accountUsageSummary([observation({ projection: ready(limits) })], now)).toBeNull();
    expect(accountUsageSummary([observation({ projection: ready(limits.slice(1)) })], now)?.remainingPercent).toBe(60);
  });

  test("all-unknown and partial observations have no total percentage", () => {
    const known = accountUsageSummary([observation()], now);
    for (const summaries of [[], [null], [null, null], [known, null]]) {
      const rollup = providerUsageRollup(summaries);
      expect(rollup.remainingPercent).toBeNull();
      expect(rollup.nextResetAt).toBeNull();
    }
    expect(providerUsageRollup([known])).toMatchObject({ remainingPercent: 60, knownAccounts: 1, unknown: 0 });
    expect(providerUsageRollup([known], false).remainingPercent).toBeNull();
  });

  test("real daily cadence is historical and supplies no rate, credits or forecast", () => {
    const history = [observation({ observedAt: now - 24 * hour }), observation()];
    expect(accountUsageSummary(history, now)).toEqual({
      binding: { resetsAt: now + hour, usedPercent: 40, windowDurationMinutes: 300, limitId: "codex", limitName: "Codex" },
      nextResetAt: now + hour, observedAt: now, remainingPercent: 60,
    });
    expect(accountUsageSummary(history, now + 3 * hour)).toBeNull();
  });

  test("property: bounded percentages remain bounded and unknown never contributes", () => {
    fc.assert(fc.property(fc.array(fc.integer({ min: 0, max: 100 }), { minLength: 1, maxLength: 32 }), (used) => {
      const summaries = used.map((usedPercent) => accountUsageSummary([observation({ projection: ready([
        limit({ secondary: null, primary: { resetsAt: now + hour, usedPercent, windowDurationMinutes: 300 } }),
      ]) })], now));
      const rollup = providerUsageRollup(summaries);
      expect(rollup.remainingPercent).toBeGreaterThanOrEqual(0);
      expect(rollup.remainingPercent).toBeLessThanOrEqual(100);
      expect(providerUsageRollup([...summaries, null]).remainingPercent).toBeNull();
    }));
  });

  test("property: every expired binding remains unknown at and after reset", () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 100 }), fc.integer({ min: 0, max: 1_000_000 }), (usedPercent, elapsed) => {
      const report = observation({ projection: ready([limit({ secondary: null, primary: {
        resetsAt: now, usedPercent, windowDurationMinutes: 300,
      } })]) });
      expect(accountUsageSummary([report], now + elapsed)).toBeNull();
    }));
  });

  test("absolute reset labels do not turn old or out-of-range instants into promises", () => {
    expect(formatResetInstant(now)).toBe("2025-10-09 08:53:20 UTC");
    expect(formatResetInstant(Number.MAX_VALUE)).toBe("unknown time");
  });
});
