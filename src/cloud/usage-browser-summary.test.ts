import { describe, expect, test } from "bun:test";

import { accountUsageSummary } from "../../app/src/model/usage-meter";
import { projectStoredUsage } from "./daemon-adapters";
import { USAGE_CLOUD_PROJECTION_MAX_LIMITS } from "./usage";

const now = 1_760_000_000_000;

describe("legacy usage archive browser interpretation", () => {
  test("missing quota metadata never becomes full capacity through legacy unlimited", () => {
    for (const reached of [null, "primary"]) {
      for (const primary of [null, { usedPercent: 70, windowDurationMins: null, resetsAt: null }]) {
        const projection = projectStoredUsage({
          usage: {
            summary: {
              lifetimeTokens: 42, peakDailyTokens: 12, longestRunningTurnSec: 9,
              currentStreakDays: 2, longestStreakDays: 3,
            },
            dailyUsageBuckets: [],
          },
          rateLimits: {
            primary: {
              limitId: "codex", limitName: "Codex", primary, secondary: null,
              planType: "plus", rateLimitReachedType: reached,
            },
            byLimitId: null,
            resetCreditsAvailable: 0,
          },
        });
        // The unchanged v1 producer derives this bit from absent usable windows;
        // it is not an explicit provider claim that this account has no quota.
        expect(projection).toMatchObject({ state: "ready", data: { limits: [{
          primary: null, secondary: null, unlimited: true, reached: reached !== null,
        }] } });
        expect(accountUsageSummary([{ observedAt: now, projection }], now)).toBeNull();
      }
    }
  });

  test("the legacy cap can omit a reached quota and cannot establish a percentage", () => {
    const limit = (id: string, usedPercent: number) => ({
      limitId: id, limitName: id, planType: "plus", rateLimitReachedType: usedPercent === 100 ? "primary" : null,
      primary: { usedPercent, windowDurationMins: 300, resetsAt: (now + 3_600_000) / 1_000 },
      secondary: null,
    });
    const projection = projectStoredUsage({
      usage: {
        summary: { lifetimeTokens: 42, peakDailyTokens: 12, longestRunningTurnSec: 9,
          currentStreakDays: 2, longestStreakDays: 3 },
        dailyUsageBuckets: [],
      },
      rateLimits: {
        primary: limit("codex", 10),
        byLimitId: Object.fromEntries(Array.from({ length: USAGE_CLOUD_PROJECTION_MAX_LIMITS }, (_, index) => [
          `limit-${String(index)}`, limit(`limit-${String(index)}`, index === USAGE_CLOUD_PROJECTION_MAX_LIMITS - 1 ? 100 : 10),
        ])),
        resetCreditsAvailable: 0,
      },
    });
    expect(projection.state).toBe("ready");
    if (projection.state !== "ready") throw new Error("Expected the legacy projection fixture to decode.");
    expect(projection.data.limits).toHaveLength(USAGE_CLOUD_PROJECTION_MAX_LIMITS);
    expect(projection.data.limits.every((entry) => !entry.reached)).toBe(true);
    expect(accountUsageSummary([{ observedAt: now, projection }], now)).toBeNull();
  });
});
