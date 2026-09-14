import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { Badge } from "./ui/badge";
import { EmptyRow, SettingsCard, SettingsSection } from "./settings-list";
import { useUsageOverview, type UsageAccountView } from "../data/usage";
import { formatRelativeTime } from "../model/relative-time";
import { formatResetInstant } from "../model/usage-meter";
import type { UsageLimit, UsageWindow } from "../oompa/cloud";
import { usageBreakdownStyles } from "./usage-breakdown.stylex";

function windowLabel(window: UsageWindow): string {
  const minutes = window.windowDurationMinutes;
  if (minutes % 1_440 === 0) return `${String(minutes / 1_440)}d window`;
  if (minutes % 60 === 0) return `${String(minutes / 60)}h window`;
  return `${String(minutes)}m window`;
}

function WindowRow({ window }: Readonly<{ window: UsageWindow }>): ReactNode {
  const used = Math.round(window.usedPercent);
  return (
    <div {...stylex.props(usageBreakdownStyles.windowRow)}>
      <span {...stylex.props(usageBreakdownStyles.windowLabel)}>{windowLabel(window)}</span>
      <meter
        aria-label={`${windowLabel(window)}: ${String(used)} percent used in this report`}
        {...stylex.props(usageBreakdownStyles.meter)} max={100} min={0} value={used}
      />
      <span {...stylex.props(usageBreakdownStyles.windowFacts)}>
        {`${String(used)}% used when reported · reset scheduled for ${formatResetInstant(window.resetsAt)}`}
      </span>
    </div>
  );
}

function LimitRows({ limit }: Readonly<{ limit: UsageLimit }>): ReactNode {
  return (
    <div {...stylex.props(usageBreakdownStyles.limit)}>
      <div {...stylex.props(usageBreakdownStyles.limitHeader)}>
        <span {...stylex.props(usageBreakdownStyles.limitName)}>{limit.name}</span>
        {limit.reached ? <Badge tone="neutral">Reached in this report</Badge> : null}
        {limit.unlimited ? <Badge tone="neutral">Quota details unavailable</Badge> : null}
      </div>
      {limit.primary === null ? null : <WindowRow window={limit.primary} />}
      {limit.secondary === null ? null : <WindowRow window={limit.secondary} />}
    </div>
  );
}

function AccountCard({ account, now, ready }: Readonly<{
  account: UsageAccountView;
  now: number;
  ready: boolean;
}>): ReactNode {
  const history = [...account.history].sort((left, right) => right.observedAt - left.observedAt);
  const newest = history[0];
  const summary = account.summary;
  const title = account.metadata?.label ?? account.publicId;
  const subtitle = account.metadata === null
    ? null
    : [account.metadata.email, account.metadata.plan].filter((part) => part !== null).join(" · ");
  return (
    <div {...stylex.props(usageBreakdownStyles.account)}>
      <div {...stylex.props(usageBreakdownStyles.accountHeader)}>
        <span {...stylex.props(usageBreakdownStyles.accountTitle)}>{title}</span>
        {subtitle === null ? null : <span {...stylex.props(usageBreakdownStyles.quiet)}>{subtitle}</span>}
      </div>
      <p {...stylex.props(usageBreakdownStyles.outlook)}>
        {!ready ? "Waiting for hosted time; usage unknown."
          : summary !== null ? `${String(Math.round(summary.remainingPercent))}% left in the last daily report.`
          : newest === undefined ? "No readable daily report; usage unknown."
          : newest.projection?.state === "ready" ? "The latest report is stale, expired or incomplete; usage unknown."
          : "The latest report is unavailable; usage unknown."}
      </p>
      {ready ? history.map((observation, index) => (
        <details key={`${String(observation.observedAt)}:${String(index)}`}>
          <summary>{`Daily report observed ${formatRelativeTime(observation.observedAt, now)} (${formatResetInstant(observation.observedAt)})`}</summary>
          {observation.projection?.state === "ready"
            ? observation.projection.data.limits.map((limit) => <LimitRows key={limit.id} limit={limit} />)
            : <p {...stylex.props(usageBreakdownStyles.quiet)}>This report is unavailable.</p>}
        </details>
      )) : null}
    </div>
  );
}

export function UsageBreakdown(): ReactNode {
  const overview = useUsageOverview();
  return (
    <div id="usage">
      <SettingsSection
        description="Codex daily reports across machines. Each machine uploads at most once per account every 24 hours. These reports do not establish live capacity; reset credits, throughput and forecasts are unavailable."
        title="Usage history"
      >
        <SettingsCard>
          {overview.loading ? <EmptyRow>Loading usage history.</EmptyRow> : null}
          {!overview.loading && !overview.complete
            ? <EmptyRow>The account listing is incomplete or unreadable; a combined percentage is unavailable.</EmptyRow> : null}
          {!overview.loading && overview.accounts.length === 0
            ? <EmptyRow>No Codex daily report is available. Usage is unknown.</EmptyRow> : null}
          {overview.accounts.map((account) => (
            <AccountCard account={account} key={account.publicId} now={overview.now} ready={overview.ready} />
          ))}
          <EmptyRow>Claude usage is unknown here. Hosted Claude usage observations are not available yet.</EmptyRow>
        </SettingsCard>
      </SettingsSection>
    </div>
  );
}
