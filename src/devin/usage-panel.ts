// Parses the panel the pinned Devin CLI renders for its `/usage` slash command.
// The panel is a human-facing terminal surface. This parser recognizes only the
// lines captured on the pinned build; any other shape becomes an explicit
// `unknown` observation with a closed reason, never a guess.

/** Whole-capture bound before parsing; the driver enforces the same limit. */
export const DEVIN_USAGE_PANEL_MAX_BYTES = 256 * 1024;

export type DevinUsageUnknownReason =
  | "banner_ambiguous"
  | "empty"
  | "extra_usage_invalid"
  | "oversize"
  | "percent_invalid"
  | "quota_line_ambiguous"
  | "quota_line_missing"
  | "reset_time_invalid"
  | "workspace_trust_prompt";

export type DevinResetTime = Readonly<{
  /** Instant derived from the panel's month, day, clock time and UTC offset. */
  epochMs: number;
  /** The panel prints no year; the nearest occurrence at or after the observation is chosen. */
  kind: "absolute_without_year";
  utcOffsetMinutes: number;
  /** The exact reset text as rendered, for example `Sep 20, 4:00 AM (UTC-4)`. */
  text: string;
}>;

export type DevinQuotaWindow = Readonly<{
  usedPercent: number;
  remainingPercent: number;
  resetAt: DevinResetTime;
}>;

export type DevinExtraUsage = Readonly<{
  /** United States dollars as printed; negative when the panel shows an owed balance. */
  amountUsd: number;
  text: string;
}>;

export type DevinUsageObservation =
  | Readonly<{
    kind: "observed";
    cliVersion: string;
    observedAt: number;
    /** Plan name from the startup banner, for example `Max`, when the banner was captured. */
    planName?: string;
    /** Remaining percent from the startup banner; a separate, earlier snapshot than the panel. */
    bannerRemainingPercent?: number;
    weekly: DevinQuotaWindow;
    /** Absent when the panel shows no daily line; Max plans hide the daily quota. */
    daily?: DevinQuotaWindow;
    dailyShown: boolean;
    extraUsage?: DevinExtraUsage;
  }>
  | Readonly<{
    kind: "unknown";
    cliVersion: string;
    observedAt: number;
    reason: DevinUsageUnknownReason;
  }>;

// Built from code points so the source holds no literal control characters.
const ESC = String.fromCodePoint(0x1b);
const BEL = String.fromCodePoint(0x07);
const CSI = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, "gu");
const OSC = new RegExp(`${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`, "gu");
const CHARSET = new RegExp(`${ESC}[()][A-Za-z0-9]`, "gu");
const OTHER_ESCAPE = new RegExp(`${ESC}[=>78HDMEcNO]`, "gu");
const CONTROL = new RegExp(
  `[${String.fromCodePoint(0)}-${String.fromCodePoint(8)}${String.fromCodePoint(0x0b)}${String.fromCodePoint(0x0c)}${String.fromCodePoint(0x0e)}-${String.fromCodePoint(0x1f)}${String.fromCodePoint(0x7f)}]`,
  "gu",
);

/** Removes terminal control sequences and carriage returns; keeps text and newlines. */
export function stripTerminalControls(text: string): string {
  return text
    .replaceAll(OSC, "")
    .replaceAll(CSI, "")
    .replaceAll(CHARSET, "")
    .replaceAll(OTHER_ESCAPE, "")
    .replaceAll("\r", "")
    .replaceAll(CONTROL, "");
}

const MONTHS: Readonly<Record<string, number>> = Object.freeze({
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
});

// `Weekly  ■■■■■■■■■■■■■■■■■■■■  0% used  · resets Sep 20, 4:00 AM (UTC-4)`
const QUOTA_LINE = /(Daily|Weekly)[ \t]+[\u2500-\u25FF#=\-·. \t]{1,64}?[ \t]+(\d{1,3})% used[ \t]+·[ \t]+resets ((Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2}), (\d{1,2}):(\d{2}) (AM|PM) \(UTC([+-]\d{1,2})(?::(\d{2}))?\))/gu;
// `v3000.10.27 · Max · 100% remaining (resets in 3d 13h)`
const BANNER_LINE = /v(\d+\.\d+\.\d+) · ([A-Za-z][A-Za-z0-9 ]{0,31}?) · (\d{1,3})% remaining \(resets in [^)]{1,32}\)/gu;
const EXTRA_USAGE_MENTION = /Extra usage/u;
const EXTRA_USAGE_LINE = /Extra usage[ \t]+(-?)\$(\d{1,9}(?:,\d{3})*(?:\.\d{1,2})?)[ \t]+(?:remaining|balance)/gu;
const TRUST_PROMPT = /Trust .{1,512}\?/u;
const PARTIAL_QUOTA_LINE = /(?:Daily|Weekly)[ \t]+[\u2500-\u25FF#=\-·. \t]{1,64}?[ \t]+\d{1,3}% used/u;

const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1_000;
const YEAR_AHEAD_LIMIT_MS = 400 * 24 * 60 * 60 * 1_000;

function parsePercent(text: string): number | undefined {
  const value = Number.parseInt(text, 10);
  return Number.isSafeInteger(value) && value >= 0 && value <= 100 ? value : undefined;
}

/**
 * Turns the panel's year-less reset time into an instant. The observation time
 * supplies the year: the reset is the first occurrence at or after two days
 * before the observation, and it must lie within 400 days ahead. A calendar
 * date that does not exist (Feb 30) or a clock time outside twelve-hour range
 * is rejected.
 */
export function resolveDevinResetTime(input: Readonly<{
  observedAt: number;
  month: string;
  day: number;
  hour12: number;
  minute: number;
  meridiem: "AM" | "PM";
  offsetHours: number;
  offsetMinutes: number;
  text: string;
}>): DevinResetTime | undefined {
  const monthIndex = MONTHS[input.month];
  if (monthIndex === undefined) return undefined;
  if (input.day < 1 || input.day > 31 || input.hour12 < 1 || input.hour12 > 12 || input.minute < 0 || input.minute > 59) return undefined;
  if (Math.abs(input.offsetHours) > 14 || input.offsetMinutes < 0 || input.offsetMinutes > 59) return undefined;
  const sign = input.offsetHours < 0 || Object.is(input.offsetHours, -0) ? -1 : 1;
  const utcOffsetMinutes = sign * (Math.abs(input.offsetHours) * 60 + input.offsetMinutes);
  const hour24 = (input.hour12 % 12) + (input.meridiem === "PM" ? 12 : 0);
  const observedLocal = new Date(input.observedAt + utcOffsetMinutes * 60_000);
  for (const year of [observedLocal.getUTCFullYear(), observedLocal.getUTCFullYear() + 1]) {
    const local: number = Date.UTC(year, monthIndex, input.day, hour24, input.minute, 0, 0);
    const check: Date = new Date(local);
    if (check.getUTCMonth() !== monthIndex || check.getUTCDate() !== input.day) return undefined;
    const epochMs = local - utcOffsetMinutes * 60_000;
    if (epochMs < input.observedAt - TWO_DAYS_MS) continue;
    if (epochMs > input.observedAt + YEAR_AHEAD_LIMIT_MS) return undefined;
    return { epochMs, kind: "absolute_without_year", utcOffsetMinutes, text: input.text };
  }
  return undefined;
}

type QuotaLine = Readonly<{ label: "Daily" | "Weekly"; usedPercent: number; resetAt: DevinResetTime; key: string }>;

function parseQuotaLines(text: string, observedAt: number): { lines: readonly QuotaLine[] } | { reason: DevinUsageUnknownReason } {
  const lines: QuotaLine[] = [];
  for (const match of text.matchAll(QUOTA_LINE)) {
    const [, label, percentText, resetText, month, dayText, hourText, minuteText, meridiem, offsetHoursText, offsetMinutesText] = match;
    if (label !== "Daily" && label !== "Weekly") return { reason: "quota_line_ambiguous" };
    const usedPercent = parsePercent(percentText ?? "");
    if (usedPercent === undefined) return { reason: "percent_invalid" };
    if (meridiem !== "AM" && meridiem !== "PM") return { reason: "reset_time_invalid" };
    const resetAt = resolveDevinResetTime({
      observedAt,
      month: month ?? "",
      day: Number.parseInt(dayText ?? "", 10),
      hour12: Number.parseInt(hourText ?? "", 10),
      minute: Number.parseInt(minuteText ?? "", 10),
      meridiem,
      offsetHours: Number.parseInt(offsetHoursText ?? "", 10),
      offsetMinutes: offsetMinutesText === undefined ? 0 : Number.parseInt(offsetMinutesText, 10),
      text: resetText ?? "",
    });
    if (resetAt === undefined) return { reason: "reset_time_invalid" };
    lines.push({ label, usedPercent, resetAt, key: `${label}:${String(usedPercent)}:${resetAt.text}` });
  }
  return { lines };
}

function pickWindow(lines: readonly QuotaLine[], label: "Daily" | "Weekly"): DevinQuotaWindow | undefined | "ambiguous" {
  const matching = lines.filter((line) => line.label === label);
  if (matching.length === 0) return undefined;
  const first = matching[0];
  if (first === undefined) return undefined;
  // A redrawn panel repeats identical lines; differing values in one capture are not one observation.
  if (matching.some((line) => line.key !== first.key)) return "ambiguous";
  return { usedPercent: first.usedPercent, remainingPercent: 100 - first.usedPercent, resetAt: first.resetAt };
}

/** Parses one `/usage` capture. Input may still contain terminal controls; they are stripped first. */
export function parseDevinUsagePanel(input: Readonly<{
  text: string;
  cliVersion: string;
  observedAt: number;
}>): DevinUsageObservation {
  const unknown = (reason: DevinUsageUnknownReason): DevinUsageObservation =>
    ({ kind: "unknown", cliVersion: input.cliVersion, observedAt: input.observedAt, reason });
  if (Buffer.byteLength(input.text, "utf8") > DEVIN_USAGE_PANEL_MAX_BYTES) return unknown("oversize");
  const text = stripTerminalControls(input.text);
  if (text.trim().length === 0) return unknown("empty");
  if (TRUST_PROMPT.test(text)) return unknown("workspace_trust_prompt");

  const parsed = parseQuotaLines(text, input.observedAt);
  if ("reason" in parsed) return unknown(parsed.reason);
  const weekly = pickWindow(parsed.lines, "Weekly");
  if (weekly === "ambiguous") return unknown("quota_line_ambiguous");
  if (weekly === undefined) return unknown(PARTIAL_QUOTA_LINE.test(text) ? "reset_time_invalid" : "quota_line_missing");
  const daily = pickWindow(parsed.lines, "Daily");
  if (daily === "ambiguous") return unknown("quota_line_ambiguous");

  let planName: string | undefined;
  let bannerRemainingPercent: number | undefined;
  for (const match of text.matchAll(BANNER_LINE)) {
    const [, version, plan, remainingText] = match;
    const remaining = parsePercent(remainingText ?? "");
    if (remaining === undefined || plan === undefined) return unknown("banner_ambiguous");
    if (version !== undefined && !input.cliVersion.includes(version)) return unknown("banner_ambiguous");
    if ((planName !== undefined && planName !== plan) || (bannerRemainingPercent !== undefined && bannerRemainingPercent !== remaining)) {
      return unknown("banner_ambiguous");
    }
    planName = plan;
    bannerRemainingPercent = remaining;
  }

  let extraUsage: DevinExtraUsage | undefined;
  if (EXTRA_USAGE_MENTION.test(text)) {
    const matches = [...text.matchAll(EXTRA_USAGE_LINE)];
    const first = matches[0];
    if (first === undefined) return unknown("extra_usage_invalid");
    const [, sign, amountText] = first;
    const amount = Number.parseFloat((amountText ?? "").replaceAll(",", ""));
    if (!Number.isFinite(amount)) return unknown("extra_usage_invalid");
    if (matches.some((match) => match[0] !== first[0])) return unknown("extra_usage_invalid");
    extraUsage = { amountUsd: sign === "-" ? -amount : amount, text: first[0] };
  }

  return {
    kind: "observed",
    cliVersion: input.cliVersion,
    observedAt: input.observedAt,
    ...(planName === undefined ? {} : { planName }),
    ...(bannerRemainingPercent === undefined ? {} : { bannerRemainingPercent }),
    weekly,
    ...(daily === undefined ? {} : { daily }),
    dailyShown: daily !== undefined,
    ...(extraUsage === undefined ? {} : { extraUsage }),
  };
}
