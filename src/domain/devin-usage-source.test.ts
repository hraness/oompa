import { describe, expect, test } from "bun:test";

import fixture from "../devin/usage-panel.fixture.json";
import { parseDevinUsagePanel, type DevinUsageObservation } from "../devin/usage-panel";
import {
  DEVIN_LOCAL_USAGE_SOURCE,
  devinLocalUsageObservationSchema,
  devinLocalUsageSourceBinding,
  devinLocalUsageSourceBindingSchema,
  projectDevinLocalUsageObservation,
  type DevinUsagePanelReading,
} from "./devin-usage-source";

const cliVersion = fixture.cliVersionOutput;
const observedAt = Date.UTC(2026, 8, 16, 17, 0, 0);
const cases: Readonly<Record<string, Readonly<{ source: string; text: string }>>> = fixture.cases;
const read = (name: keyof typeof fixture.cases): DevinUsageObservation =>
  parseDevinUsagePanel({ text: cases[name]?.text ?? "", cliVersion, observedAt });

// The projection is bound to the Phase 1 reader's exact observation type. If
// the reader's shape changes, this assignment stops compiling before any
// consumer can read a value the codec never admitted.
const reading = (observation: DevinUsageObservation): DevinUsagePanelReading => observation;

const profileId = `acct_${"a".repeat(32)}`;

describe("Devin local usage source", () => {
  test("names one local source that is never persisted or projected", () => {
    expect(DEVIN_LOCAL_USAGE_SOURCE).toBe("devin_usage_panel");
    const binding = devinLocalUsageSourceBinding({ profileId, processGeneration: 3 });
    expect(binding).toEqual({
      source: "devin_usage_panel",
      provider: "devin",
      scope: "local_only",
      persisted: false,
      profileId,
      processGeneration: 3,
    });
    expect(devinLocalUsageSourceBindingSchema.parse(binding)).toEqual(binding);
    // No other source name, provider or scope may wear this binding.
    for (const invalid of [
      { ...binding, source: "devin_acp" },
      { ...binding, provider: "codex" },
      { ...binding, scope: "account" },
      { ...binding, persisted: true },
      { ...binding, extra: 1 },
    ]) expect(devinLocalUsageSourceBindingSchema.safeParse(invalid).success).toBe(false);
  });

  test("projects the reviewed Max capture into the neutral window vocabulary", () => {
    const observation = projectDevinLocalUsageObservation(reading(read("real_max_weekly_only")));
    expect(observation).toEqual({
      source: "devin_usage_panel",
      state: "observed",
      cliVersion,
      observedAt,
      planName: "Max",
      bannerRemainingPercent: 100,
      windows: [{
        id: "weekly",
        scope: "account",
        usedPercent: 0,
        remainingPercent: 100,
        resetsAtMs: Date.UTC(2026, 8, 20, 8, 0, 0),
        resetsAtKind: "absolute_without_year",
        resetsAtUtcOffsetMinutes: -240,
        resetsAtText: "Sep 20, 4:00 AM (UTC-4)",
      }],
      dailyShown: false,
    });
    expect(devinLocalUsageObservationSchema.parse(observation)).toEqual(observation);
  });

  test("keeps both windows and the extra-usage balance when the panel prints them", () => {
    const both = projectDevinLocalUsageObservation(reading(read("synthetic_daily_and_weekly")));
    expect(both.state).toBe("observed");
    if (both.state !== "observed") throw new Error("unreachable");
    expect(both.dailyShown).toBe(true);
    expect(both.windows.map((window) => window.id)).toEqual(["weekly", "daily"]);
    for (const window of both.windows) {
      expect(window.usedPercent + window.remainingPercent).toBe(100);
      expect(window.resetsAtMs).toBeGreaterThan(observedAt);
    }
    const extra = projectDevinLocalUsageObservation(reading(read("synthetic_extra_usage")));
    expect(extra.state).toBe("observed");
    if (extra.state !== "observed") throw new Error("unreachable");
    expect(typeof extra.extraUsageRemainingUsd).toBe("number");
    expect(extra.extraUsageText).toBeDefined();
  });

  test("carries every closed refusal reason through unchanged", () => {
    for (const [name, reason] of [
      ["synthetic_extra_usage_malformed", "extra_usage_invalid"],
      ["synthetic_conflicting_weekly", "quota_line_ambiguous"],
      ["synthetic_percent_out_of_range", "percent_invalid"],
      ["synthetic_invalid_reset_day", "reset_time_invalid"],
      ["malformed_no_quota_line", "quota_line_missing"],
      ["workspace_trust_prompt", "workspace_trust_prompt"],
    ] as const) {
      const observation = projectDevinLocalUsageObservation(reading(read(name)));
      expect(observation).toEqual({
        source: "devin_usage_panel",
        state: "unknown",
        cliVersion,
        observedAt,
        reason,
      });
    }
  });

  test("refuses an unrecognized reason rather than inventing one", () => {
    const observation = projectDevinLocalUsageObservation({
      kind: "unknown",
      cliVersion,
      observedAt,
      reason: "something_the_reader_never_emits",
    });
    expect(observation).toEqual({
      source: "devin_usage_panel",
      state: "unknown",
      cliVersion,
      observedAt,
      reason: "quota_line_ambiguous",
    });
  });

  test("refuses an out-of-range observed reading instead of projecting a partial value", () => {
    const observation = projectDevinLocalUsageObservation({
      kind: "observed",
      cliVersion,
      observedAt,
      dailyShown: false,
      weekly: {
        usedPercent: 140,
        remainingPercent: -40,
        resetAt: {
          epochMs: observedAt + 1_000,
          kind: "absolute_without_year",
          utcOffsetMinutes: 0,
          text: "Sep 20, 4:00 AM (UTC+0)",
        },
      },
    });
    expect(observation).toEqual({
      source: "devin_usage_panel",
      state: "unknown",
      cliVersion,
      observedAt,
      reason: "quota_line_ambiguous",
    });
  });
});
