/**
 * Read-only summaries of the legacy daily usage archive. These rows do not
 * establish live capacity, reset-credit inventory or throughput. In particular,
 * lifetime counters have no source-device provenance and must not be differenced.
 */
import { USAGE_CLOUD_PROJECTION_MAX_LIMITS, type UsageLimit, type UsageProjection, type UsageWindow } from "../oompa/cloud";

export type UsageObservation = Readonly<{
  observedAt: number;
  /** Null retains an unreadable newest row instead of falling back to old data. */
  projection: UsageProjection | null;
}>;

export type BindingWindow = Readonly<{
  limitId: string;
  limitName: string;
  resetsAt: number;
  usedPercent: number;
  windowDurationMinutes: number;
}>;

export type AccountUsageSummary = Readonly<{
  binding: BindingWindow | null;
  /** Last reported value from usable, unexpired quota windows. */
  remainingPercent: number;
  nextResetAt: number | null;
  observedAt: number;
}>;

/** Reports older than this cannot contribute to the compact summary. */
export const staleObservationMs = 2 * 60 * 60 * 1_000;

function windows(limit: UsageLimit): readonly UsageWindow[] {
  return [limit.primary, limit.secondary].filter((window): window is UsageWindow => window !== null);
}

/** Most used reported window, breaking ties by earliest reset. */
export function bindingWindow(limits: readonly UsageLimit[]): BindingWindow | null {
  return limits.filter((limit) => !limit.unlimited).flatMap((limit) =>
    windows(limit).map((window) => ({ ...window, limitId: limit.id, limitName: limit.name })))
    .sort((left, right) => right.usedPercent - left.usedPercent || left.resetsAt - right.resetsAt)[0] ?? null;
}

/**
 * Select the newest row before assessing it. Missing, failed, unreadable, future,
 * stale, expired or incomplete observations stay unknown. A reached flag also
 * cannot be explained away by a percentage below 100.
 */
export function accountUsageSummary(
  history: readonly UsageObservation[],
  now: number,
): AccountUsageSummary | null {
  const newest = [...history].sort((left, right) => right.observedAt - left.observedAt)[0];
  if (newest === undefined || newest.projection?.state !== "ready"
    || newest.observedAt > now || now - newest.observedAt > staleObservationMs) return null;
  const limits = newest.projection.data.limits;
  // The legacy producer truncates at this cap without a completeness flag.
  // Its `unlimited` bit also means missing usable windows, not proven no quota.
  if (limits.length === 0 || limits.length >= USAGE_CLOUD_PROJECTION_MAX_LIMITS) return null;
  if (limits.some((limit) => limit.unlimited || windows(limit).length === 0
    || windows(limit).some((window) => window.resetsAt <= now)
    || (limit.reached && windows(limit).every((window) => window.usedPercent < 100)))) return null;
  const binding = bindingWindow(limits);
  if (binding === null) return null;
  return {
    binding,
    nextResetAt: binding.resetsAt,
    observedAt: newest.observedAt,
    remainingPercent: Math.max(0, 100 - binding.usedPercent),
  };
}

export type ProviderUsageRollup = Readonly<{
  accounts: number;
  knownAccounts: number;
  /** Null if any included account is unknown; no partial mean masquerades as a total. */
  remainingPercent: number | null;
  nextResetAt: number | null;
  unknown: number;
}>;

export function providerUsageRollup(summaries: readonly (AccountUsageSummary | null)[], pageComplete = true): ProviderUsageRollup {
  const known = summaries.filter((summary): summary is AccountUsageSummary => summary !== null);
  const complete = pageComplete && known.length > 0 && known.length === summaries.length;
  return {
    accounts: summaries.length,
    knownAccounts: known.length,
    remainingPercent: complete
      ? known.reduce((total, summary) => total + summary.remainingPercent, 0) / known.length
      : null,
    nextResetAt: complete ? known.reduce<number | null>((earliest, summary) => {
      const reset = summary.nextResetAt;
      return reset === null ? earliest : earliest === null ? reset : Math.min(earliest, reset);
    }, null) : null,
    unknown: summaries.length - known.length,
  };
}

/** Historical reports use absolute reset instants, not promises that capacity freed up. */
export function formatResetInstant(at: number): string {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? "unknown time" : date.toISOString().replace("T", " ").replace(".000Z", " UTC");
}
