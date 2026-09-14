import { beforeEach, describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import type { UsageOverview } from "../data/usage";
import { providerUsageRollup } from "../model/usage-meter";

let overview: UsageOverview;
await mock.module("../data/usage", () => ({ useUsageOverview: () => overview }));
const { UsageMeter } = await import("./usage-meter");
const { UsageBreakdown } = await import("./usage-breakdown");

describe("daily usage presentation", () => {
  beforeEach(() => {
    overview = { complete: true, accounts: [], codex: providerUsageRollup([null]), loading: false, now: 1_760_000_000_000, ready: true };
  });
  test("unknown capacity never paints a full meter or an unlimited claim", () => {
    const html = renderToStaticMarkup(<UsageMeter />);
    const { document } = parseHTML(html);
    expect(document.querySelector("meter")).toBeNull();
    expect(html).toContain("Codex usage unknown");
    expect(html).not.toContain("100%");
    expect(html).not.toContain("No limit reported");
  });
  test("clock and loading states cannot expose a percentage", () => {
    overview = { ...overview, ready: false, codex: { accounts: 1, knownAccounts: 1, unknown: 0, remainingPercent: 100, nextResetAt: null } };
    expect(renderToStaticMarkup(<UsageMeter />)).not.toContain("100%");
    overview = { ...overview, ready: true, loading: true };
    const html = renderToStaticMarkup(<UsageMeter />);
    expect(html).toContain("Loading usage history");
    expect(parseHTML(html).document.querySelector("meter")).toBeNull();
  });
  test("a known value is explicitly historical and unsupported facts stay unavailable", () => {
    overview = { ...overview, codex: { accounts: 1, knownAccounts: 1, unknown: 0, remainingPercent: 60, nextResetAt: null } };
    const html = renderToStaticMarkup(<UsageMeter />);
    expect(html).toContain("Codex reported average: 60% left");
    expect(html).toContain("Daily history");
    const breakdown = renderToStaticMarkup(<UsageBreakdown />);
    expect(breakdown).toContain("every 24 hours");
    expect(breakdown).toContain("Claude usage is unknown");
    overview = { ...overview, complete: false };
    expect(renderToStaticMarkup(<UsageMeter />)).not.toContain("60%");
    expect(renderToStaticMarkup(<UsageBreakdown />)).toContain("account listing is incomplete");
  });
  test("legacy missing-window reports never claim unlimited quota", () => {
    overview = { ...overview, accounts: [{
      publicId: "acct_example", metadata: null, summary: null,
      history: [{ observedAt: overview.now, projection: { state: "ready", data: {
        currentStreakDays: 0, daily: [], lifetimeTokens: 0, longestRunningTurnSeconds: 0,
        longestStreakDays: 0, peakDailyTokens: 0,
        limits: [{ id: "codex", name: "Codex", individual: false, reached: true,
          unlimited: true, primary: null, secondary: null }],
      } } }],
    }] };
    const html = renderToStaticMarkup(<UsageBreakdown />);
    expect(html).toContain("Quota details unavailable");
    expect(html).toContain("Reached in this report");
    expect(html).toContain("usage unknown");
    expect(html).not.toContain("Reported unlimited");
    expect(html).not.toContain("100%");
    expect(parseHTML(html).document.querySelector("meter")).toBeNull();
  });
});
