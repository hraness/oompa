import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { useUsageOverview } from "../data/usage";
import type { ProviderUsageRollup } from "../model/usage-meter";
import { navigate } from "../routing/router";
import { usageRoute } from "../routing/route";
import { usageMeterStyles } from "./usage-meter.stylex";

export function meterPercent(rollup: ProviderUsageRollup): number | null {
  return rollup.remainingPercent === null ? null : Math.round(Math.max(0, Math.min(100, rollup.remainingPercent)));
}

export function meterLabel(rollup: ProviderUsageRollup, ready: boolean): string {
  const percent = ready ? meterPercent(rollup) : null;
  return percent === null ? "Codex usage unknown" : `Codex reported average: ${String(percent)}% left`;
}

/** The daily archive is a history entry point, never a live availability claim. */
export function UsageMeter(): ReactNode {
  const overview = useUsageOverview();
  const percent = overview.ready && overview.complete && !overview.loading ? meterPercent(overview.codex) : null;
  const label = overview.loading ? "Loading usage history" : meterLabel(overview.codex, overview.ready && overview.complete);
  return (
    <button
      aria-label={`${label}. Open usage history.`}
      {...stylex.props(usageMeterStyles.root)}
      onClick={() => { navigate(usageRoute); }}
      type="button"
    >
      <span {...stylex.props(usageMeterStyles.provider)}>Daily history</span>
      {percent === null ? null : (
        <meter aria-hidden="true" {...stylex.props(usageMeterStyles.meter)} max={100} min={0} value={percent} />
      )}
      <span {...stylex.props(usageMeterStyles.percent)}>{label}</span>
    </button>
  );
}
