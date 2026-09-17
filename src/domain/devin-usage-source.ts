import { z } from "zod";

import { profileIdSchema, unixMillisecondsSchema } from "./values";

/**
 * The one local Devin usage source: the panel the pinned Devin CLI renders for
 * its own `/usage` slash command (`kb/plans/devin-provider.md`, Phase 1).
 *
 * It is deliberately not a member of `providerUsageSourceSchema`. That enum is
 * the persisted and hosted usage vocabulary: its values reach
 * `provider_usage_observation_receipts`, the cloud usage payloads and the
 * browser. A Devin panel observation reaches none of those in Phase 3a, so the
 * local source carries its own name and its own closed codec. Phase 3b
 * registers a data surface before anything persists it.
 */
export const DEVIN_LOCAL_USAGE_SOURCE = "devin_usage_panel";

const safeGenerationSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/**
 * What a caller is told about where a Devin quota read would come from. The
 * binding names the source and its exact profile authority; it carries no
 * quota value, because naming a source is not observing one.
 */
export const devinLocalUsageSourceBindingSchema = z.object({
  source: z.literal(DEVIN_LOCAL_USAGE_SOURCE),
  provider: z.literal("devin"),
  /** Never projected to hosted sync or the browser. */
  scope: z.literal("local_only"),
  /** No registered data surface owns a Devin observation yet; Phase 3b adds one. */
  persisted: z.literal(false),
  profileId: profileIdSchema,
  processGeneration: safeGenerationSchema,
}).strict();

export type DevinLocalUsageSourceBinding = z.infer<typeof devinLocalUsageSourceBindingSchema>;

export const devinLocalUsageSourceBinding = (input: Readonly<{
  profileId: string;
  processGeneration: number;
}>): DevinLocalUsageSourceBinding => devinLocalUsageSourceBindingSchema.parse({
  source: DEVIN_LOCAL_USAGE_SOURCE,
  provider: "devin",
  scope: "local_only",
  persisted: false,
  profileId: input.profileId,
  processGeneration: input.processGeneration,
});

/**
 * The panel prints no year, so the reader resolves the nearest occurrence at
 * or after the observation. The projection keeps both the resolved instant and
 * the exact rendered text so nothing downstream has to re-derive it.
 */
export const devinLocalUsageWindowSchema = z.object({
  id: z.enum(["weekly", "daily"]),
  scope: z.literal("account"),
  usedPercent: z.number().finite().min(0).max(100),
  remainingPercent: z.number().finite().min(0).max(100),
  resetsAtMs: unixMillisecondsSchema,
  resetsAtKind: z.literal("absolute_without_year"),
  resetsAtUtcOffsetMinutes: z.number().int().min(-1440).max(1440),
  resetsAtText: z.string().min(1).max(200),
}).strict();

export type DevinLocalUsageWindow = z.infer<typeof devinLocalUsageWindowSchema>;

/** Exactly the reader's closed refusal vocabulary; no other value is admitted. */
export const devinLocalUsageUnknownReasonSchema = z.enum([
  "banner_ambiguous",
  "empty",
  "extra_usage_invalid",
  "oversize",
  "percent_invalid",
  "quota_line_ambiguous",
  "quota_line_missing",
  "reset_time_invalid",
  "workspace_trust_prompt",
]);

const boundedPanelTextSchema = z.string().min(1).max(200);
/** The trimmed `devin --version` line the runtime already bounded. */
const cliVersionSchema = z.string().min(1).max(512);

export const devinLocalUsageObservationSchema = z.discriminatedUnion("state", [
  z.object({
    source: z.literal(DEVIN_LOCAL_USAGE_SOURCE),
    state: z.literal("observed"),
    cliVersion: cliVersionSchema,
    observedAt: unixMillisecondsSchema,
    planName: boundedPanelTextSchema.optional(),
    bannerRemainingPercent: z.number().finite().min(0).max(100).optional(),
    /** Weekly always present; daily only when the plan renders a daily line. */
    windows: z.array(devinLocalUsageWindowSchema).min(1).max(2),
    dailyShown: z.boolean(),
    extraUsageRemainingUsd: z.number().finite().optional(),
    extraUsageText: boundedPanelTextSchema.optional(),
  }).strict(),
  z.object({
    source: z.literal(DEVIN_LOCAL_USAGE_SOURCE),
    state: z.literal("unknown"),
    cliVersion: cliVersionSchema,
    observedAt: unixMillisecondsSchema,
    reason: devinLocalUsageUnknownReasonSchema,
  }).strict(),
]);

export type DevinLocalUsageObservation = z.infer<typeof devinLocalUsageObservationSchema>;

/**
 * The reader's observation shape, restated structurally so the leaf domain
 * layer does not import the provider boundary. `DevinUsageObservation` from
 * `src/devin/usage-panel.ts` satisfies it exactly; a test in this layer proves
 * that assignability against the reviewed capture, so the two cannot drift.
 */
export type DevinUsagePanelReading =
  | Readonly<{
    kind: "observed";
    cliVersion: string;
    observedAt: number;
    planName?: string;
    bannerRemainingPercent?: number;
    weekly: DevinUsagePanelWindow;
    daily?: DevinUsagePanelWindow;
    dailyShown: boolean;
    extraUsage?: Readonly<{ amountUsd: number; text: string }>;
  }>
  | Readonly<{
    kind: "unknown";
    cliVersion: string;
    observedAt: number;
    reason: string;
  }>;

type DevinUsagePanelWindow = Readonly<{
  usedPercent: number;
  remainingPercent: number;
  resetAt: Readonly<{
    epochMs: number;
    kind: "absolute_without_year";
    utcOffsetMinutes: number;
    text: string;
  }>;
}>;

const projectWindow = (
  id: DevinLocalUsageWindow["id"],
  window: DevinUsagePanelWindow,
): unknown => ({
  id,
  scope: "account",
  usedPercent: window.usedPercent,
  remainingPercent: window.remainingPercent,
  resetsAtMs: window.resetAt.epochMs,
  resetsAtKind: window.resetAt.kind,
  resetsAtUtcOffsetMinutes: window.resetAt.utcOffsetMinutes,
  resetsAtText: window.resetAt.text,
});

/**
 * Project one panel reading onto the local usage source. Nothing is inferred:
 * an `unknown` reading stays unknown with its exact reason, and a reading the
 * codec cannot admit is an `unknown` with `quota_line_ambiguous` rather than a
 * partial value.
 */
export const projectDevinLocalUsageObservation = (
  reading: DevinUsagePanelReading,
): DevinLocalUsageObservation => {
  if (reading.kind === "unknown") {
    const reason = devinLocalUsageUnknownReasonSchema.safeParse(reading.reason);
    return devinLocalUsageObservationSchema.parse({
      source: DEVIN_LOCAL_USAGE_SOURCE,
      state: "unknown",
      cliVersion: reading.cliVersion,
      observedAt: reading.observedAt,
      reason: reason.success ? reason.data : "quota_line_ambiguous",
    });
  }
  const candidate = {
    source: DEVIN_LOCAL_USAGE_SOURCE,
    state: "observed",
    cliVersion: reading.cliVersion,
    observedAt: reading.observedAt,
    ...(reading.planName === undefined ? {} : { planName: reading.planName }),
    ...(reading.bannerRemainingPercent === undefined
      ? {}
      : { bannerRemainingPercent: reading.bannerRemainingPercent }),
    windows: [
      projectWindow("weekly", reading.weekly),
      ...(reading.daily === undefined ? [] : [projectWindow("daily", reading.daily)]),
    ],
    dailyShown: reading.dailyShown,
    ...(reading.extraUsage === undefined
      ? {}
      : {
        extraUsageRemainingUsd: reading.extraUsage.amountUsd,
        extraUsageText: reading.extraUsage.text,
      }),
  };
  const parsed = devinLocalUsageObservationSchema.safeParse(candidate);
  if (parsed.success) return parsed.data;
  return devinLocalUsageObservationSchema.parse({
    source: DEVIN_LOCAL_USAGE_SOURCE,
    state: "unknown",
    cliVersion: reading.cliVersion,
    observedAt: reading.observedAt,
    reason: "quota_line_ambiguous",
  });
};
