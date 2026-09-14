import { describe, expect, test } from "bun:test";

import {
  parseUsageEncryptedEnvelope,
  parseUsageProjection,
  USAGE_CLOUD_ENVELOPE_MAX_CIPHERTEXT_CHARACTERS,
  USAGE_CLOUD_PROJECTION_MAX_PLAINTEXT_BYTES,
  USAGE_CLOUD_PROJECTION_MAX_DAILY_ROWS,
  USAGE_CLOUD_PROJECTION_MAX_LIMITS,
  usageSnapshotDisposition,
} from "./usage";

function maximumUsageProjection() {
  const window = {
    resetsAt: Number.MAX_VALUE,
    usedPercent: 2.2250738585072014e-308,
    windowDurationMinutes: 365 * 24 * 60,
  } as const;
  return {
    data: {
      currentStreakDays: Number.MAX_SAFE_INTEGER,
      daily: [{ startDate: "9999-99-99", tokens: Number.MAX_SAFE_INTEGER }],
      lifetimeTokens: Number.MAX_SAFE_INTEGER,
      limits: Array.from({ length: USAGE_CLOUD_PROJECTION_MAX_LIMITS }, (_, index) => ({
        id: `${index}${"x".repeat(95)}`,
        individual: false,
        name: "\0".repeat(96),
        primary: window,
        reached: false,
        secondary: window,
        unlimited: false,
      })),
      longestRunningTurnSeconds: Number.MAX_SAFE_INTEGER,
      longestStreakDays: Number.MAX_SAFE_INTEGER,
      peakDailyTokens: Number.MAX_SAFE_INTEGER,
    },
    state: "ready",
  } as const;
}

const ready = {
  data: {
    currentStreakDays: 2,
    daily: [{ startDate: "2026-08-22", tokens: 123 }],
    lifetimeTokens: 1000,
    limits: [{
      id: "primary",
      individual: false,
      name: "Primary",
      primary: { resetsAt: 2_000_000, usedPercent: 42, windowDurationMinutes: 300 },
      reached: false,
      secondary: null,
      unlimited: false,
    }],
    longestRunningTurnSeconds: 120,
    longestStreakDays: 4,
    peakDailyTokens: 500,
  },
  state: "ready",
} as const;

describe("usage projection laws", () => {
  test("has an exact maximum plaintext boundary", () => {
    const maximum = maximumUsageProjection();
    expect(new TextEncoder().encode(JSON.stringify(maximum)).byteLength)
      .toBe(USAGE_CLOUD_PROJECTION_MAX_PLAINTEXT_BYTES);
    expect(parseUsageProjection(maximum)).toEqual(maximum);
    const envelope = {
      algorithm: "A256GCM" as const,
      ciphertext: "A".repeat(USAGE_CLOUD_ENVELOPE_MAX_CIPHERTEXT_CHARACTERS),
      keyVersion: 1,
      nonce: "A".repeat(16),
    };
    expect(parseUsageEncryptedEnvelope(envelope)).toEqual(envelope);
    expect(parseUsageEncryptedEnvelope({
      ...envelope,
      ciphertext: `${envelope.ciphertext}A`,
    })).toBeNull();
  });

  test("keeps v1 exact keys unchanged for older paired clients", () => {
    expect(USAGE_CLOUD_PROJECTION_MAX_PLAINTEXT_BYTES).toBe(8_120);
    expect(USAGE_CLOUD_ENVELOPE_MAX_CIPHERTEXT_CHARACTERS).toBe(10_848);
    expect(parseUsageProjection({ ...ready, data: { ...ready.data, resetCredits: 3 } })).toBeNull();
  });

  test("keeps unavailable distinct from a ready zero", () => {
    expect(parseUsageProjection({ state: "unavailable" })).toEqual({ state: "unavailable" });
    expect(parseUsageProjection(ready)).toEqual(ready);
  });

  test("rejects duplicate IDs and projections wider than the daily hosted contract", () => {
    expect(parseUsageProjection({
      ...ready,
      data: { ...ready.data, limits: [ready.data.limits[0], ready.data.limits[0]] },
    })).toBeNull();
    expect(parseUsageProjection({
      ...ready,
      data: { ...ready.data, daily: [ready.data.daily[0], ready.data.daily[0]] },
    })).toBeNull();
    expect(parseUsageProjection({
      ...ready,
      data: {
        ...ready.data,
        daily: Array.from({ length: USAGE_CLOUD_PROJECTION_MAX_DAILY_ROWS + 1 }, (_, index) => ({
          startDate: `2025-01-${String((index % 28) + 1).padStart(2, "0")}`,
          tokens: index,
        })),
      },
    })).toBeNull();
    expect(parseUsageProjection({
      ...ready,
      data: {
        ...ready.data,
        limits: Array.from({ length: USAGE_CLOUD_PROJECTION_MAX_LIMITS + 1 }, (_, index) => ({
          ...ready.data.limits[0],
          id: `limit_${index}`,
        })),
      },
    })).toBeNull();
  });

  test("orders out-of-order snapshots deterministically", () => {
    const current = {
      digest: "a",
      observedAt: 100,
      sourceDeviceId: "device-a",
      sourceRevision: 2,
    };
    expect(usageSnapshotDisposition(current, null, {
      ...current,
      digest: "b",
      observedAt: 99,
      sourceRevision: 3,
    }, 1000)).toBe("store");
    expect(usageSnapshotDisposition(current, current, current, 1000)).toBe("replay");
    expect(usageSnapshotDisposition(current, current, { ...current, digest: "changed" }, 1000))
      .toBe("conflict");
    expect(usageSnapshotDisposition(current, null, { ...current, observedAt: 301_001 }, 1_000))
      .toBe("future");
    expect(usageSnapshotDisposition({
      ...current,
      sourceDeviceId: "device_Z",
    }, null, {
      ...current,
      digest: "ascii-winner",
      sourceDeviceId: "device_a",
    }, 1_000)).toBe("replace");
    expect(usageSnapshotDisposition(current, null, {
      ...current,
      digest: "higher-revision",
      sourceRevision: 3,
    }, 1_000)).toBe("replace");
  });
});
