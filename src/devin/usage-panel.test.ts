import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import fixture from "./usage-panel.fixture.json";
import {
  DEVIN_USAGE_PANEL_MAX_BYTES,
  parseDevinUsagePanel,
  resolveDevinResetTime,
  stripTerminalControls,
  type DevinUsageObservation,
  type DevinUsageUnknownReason,
} from "./usage-panel.ts";

const cliVersion = fixture.cliVersionOutput;
// The fixture was captured on 2026-09-16 in the afternoon, Eastern time.
const observedAt = Date.UTC(2026, 8, 16, 17, 0, 0);
const cases: Readonly<Record<string, Readonly<{ source: string; text: string }>>> = fixture.cases;
const caseText = (name: keyof typeof fixture.cases): string => cases[name]?.text ?? "";
const parse = (text: string, at = observedAt): DevinUsageObservation =>
  parseDevinUsagePanel({ text, cliVersion, observedAt: at });
const expectUnknown = (observation: DevinUsageObservation, reason: DevinUsageUnknownReason): void => {
  expect(observation.kind).toBe("unknown");
  if (observation.kind === "unknown") expect(observation.reason).toBe(reason);
};

describe("Devin usage panel parser", () => {
  test("reads the captured Max panel: weekly window, hidden daily, banner plan", () => {
    const observation = parse(caseText("real_max_weekly_only"));
    expect(fixture.cases.real_max_weekly_only.source).toBe("real");
    expect(observation).toEqual({
      kind: "observed",
      cliVersion,
      observedAt,
      planName: "Max",
      bannerRemainingPercent: 100,
      weekly: {
        usedPercent: 0,
        remainingPercent: 100,
        resetAt: {
          epochMs: Date.UTC(2026, 8, 20, 8, 0, 0),
          kind: "absolute_without_year",
          utcOffsetMinutes: -240,
          text: "Sep 20, 4:00 AM (UTC-4)",
        },
      },
      dailyShown: false,
    });
  });

  test("strips the raw terminal stream to the same observation", () => {
    const raw = Buffer.from(fixture.cases.real_max_weekly_only.rawBase64, "base64").toString("utf8");
    expect(raw).toContain(String.fromCodePoint(0x1b));
    expect(stripTerminalControls(raw)).not.toContain(String.fromCodePoint(0x1b));
    expect(parse(raw)).toEqual(parse(caseText("real_max_weekly_only")));
  });

  test("keeps the credential-free capture free of identity", () => {
    for (const entry of Object.values(fixture.cases)) {
      expect(entry.text).not.toMatch(/@[a-z0-9.-]+\.[a-z]{2,}/iu);
      expect(entry.text).not.toMatch(/devin -r [a-z]+-[a-z]+/u);
    }
  });

  test("reads a panel with both daily and weekly windows", () => {
    const observation = parse(caseText("synthetic_daily_and_weekly"));
    expect(observation).toMatchObject({
      kind: "observed",
      planName: "Pro",
      bannerRemainingPercent: 62,
      dailyShown: true,
      daily: { usedPercent: 38, remainingPercent: 62, resetAt: { epochMs: Date.UTC(2026, 8, 17, 4, 0, 0), utcOffsetMinutes: -240 } },
      weekly: { usedPercent: 17, remainingPercent: 83, resetAt: { epochMs: Date.UTC(2026, 8, 20, 8, 0, 0) } },
    });
  });

  test("reports an exhausted quota as zero remaining rather than absent", () => {
    const observation = parse(caseText("synthetic_exhausted"));
    expect(observation).toMatchObject({ kind: "observed", bannerRemainingPercent: 0, weekly: { usedPercent: 100, remainingPercent: 0 } });
  });

  test("reads the extra-usage balance line and refuses a malformed one", () => {
    expect(parse(caseText("synthetic_extra_usage"))).toMatchObject({
      kind: "observed",
      extraUsage: { amountUsd: 12.5, text: "Extra usage  $12.50 remaining" },
    });
    expectUnknown(parse(caseText("synthetic_extra_usage_malformed")), "extra_usage_invalid");
  });

  test("fails closed on every unrecognized shape", () => {
    expectUnknown(parse(caseText("synthetic_conflicting_weekly")), "quota_line_ambiguous");
    expectUnknown(parse(caseText("synthetic_percent_out_of_range")), "percent_invalid");
    expectUnknown(parse(caseText("synthetic_invalid_reset_day")), "reset_time_invalid");
    expectUnknown(parse(caseText("malformed_no_quota_line")), "quota_line_missing");
    expectUnknown(parse(caseText("truncated_quota_line")), "reset_time_invalid");
    expectUnknown(parse(caseText("workspace_trust_prompt")), "workspace_trust_prompt");
    expectUnknown(parse(""), "empty");
    expectUnknown(parse(`${String.fromCodePoint(0x1b)}[2J${String.fromCodePoint(0x1b)}[H   \n`), "empty");
    expectUnknown(parse("x".repeat(DEVIN_USAGE_PANEL_MAX_BYTES + 1)), "oversize");
  });

  test("refuses a banner from another CLI version and conflicting banners", () => {
    const weekly = "Weekly  ■■■■■■■■■■■■■■■■■■■■  0% used  · resets Sep 20, 4:00 AM (UTC-4)\n";
    expectUnknown(parse(`v3000.10.28 · Max · 100% remaining (resets in 3d 13h)\n${weekly}`), "banner_ambiguous");
    expectUnknown(parse(`v3000.10.27 · Max · 100% remaining (resets in 3d)\nv3000.10.27 · Pro · 100% remaining (resets in 3d)\n${weekly}`), "banner_ambiguous");
    expect(parse(weekly)).toMatchObject({ kind: "observed", dailyShown: false });
    expect(parse(weekly)).not.toHaveProperty("planName");
  });

  test("resolves a year-less reset across the year boundary and within a two-day grace", () => {
    const line = (date: string) => `Weekly  ■■■■  0% used  · resets ${date}, 4:00 AM (UTC-4)\n`;
    const december = Date.UTC(2026, 11, 30, 12, 0, 0);
    expect(parse(line("Jan 2"), december)).toMatchObject({ weekly: { resetAt: { epochMs: Date.UTC(2027, 0, 2, 8, 0, 0) } } });
    expect(parse(line("Sep 15"), observedAt)).toMatchObject({ weekly: { resetAt: { epochMs: Date.UTC(2026, 8, 15, 8, 0, 0) } } });
    expect(parse(line("Sep 10"), observedAt)).toMatchObject({ weekly: { resetAt: { epochMs: Date.UTC(2027, 8, 10, 8, 0, 0) } } });
    expect(parse(`Weekly  ■■■■  0% used  · resets Sep 20, 4:00 AM (UTC+5:30)\n`)).toMatchObject({
      weekly: { resetAt: { epochMs: Date.UTC(2026, 8, 19, 22, 30, 0), utcOffsetMinutes: 330 } },
    });
  });

  test("every in-range percent round-trips and every out-of-range percent fails closed", () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 100 }), (used) => {
      const observation = parse(`Weekly  ■■■■  ${String(used)}% used  · resets Sep 20, 4:00 AM (UTC-4)\n`);
      expect(observation).toMatchObject({ kind: "observed", weekly: { usedPercent: used, remainingPercent: 100 - used } });
    }));
    fc.assert(fc.property(fc.integer({ min: 101, max: 999 }), (used) => {
      expectUnknown(parse(`Weekly  ■■■■  ${String(used)}% used  · resets Sep 20, 4:00 AM (UTC-4)\n`), "percent_invalid");
    }));
  });

  test("every well-formed reset time resolves to an instant whose local fields match the panel", () => {
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
    fc.assert(fc.property(
      fc.integer({ min: 0, max: 11 }),
      fc.integer({ min: 1, max: 28 }),
      fc.integer({ min: 1, max: 12 }),
      fc.integer({ min: 0, max: 59 }),
      fc.constantFrom("AM", "PM"),
      fc.integer({ min: -12, max: 14 }),
      fc.constantFrom(0, 30, 45),
      (monthIndex, day, hour12, minute, meridiem, offsetHours, offsetMinutes) => {
        const observed = Date.UTC(2026, 0, 1, 0, 0, 0);
        const resolved = resolveDevinResetTime({
          observedAt: observed, month: months[monthIndex] ?? "Jan", day, hour12, minute, meridiem, offsetHours, offsetMinutes, text: "t",
        });
        expect(resolved).toBeDefined();
        if (resolved === undefined) return;
        const local = new Date(resolved.epochMs + resolved.utcOffsetMinutes * 60_000);
        expect(local.getUTCMonth()).toBe(monthIndex);
        expect(local.getUTCDate()).toBe(day);
        expect(local.getUTCHours()).toBe((hour12 % 12) + (meridiem === "PM" ? 12 : 0));
        expect(local.getUTCMinutes()).toBe(minute);
        expect(resolved.epochMs).toBeGreaterThanOrEqual(observed - 2 * 86_400_000);
      },
    ));
  });
});
