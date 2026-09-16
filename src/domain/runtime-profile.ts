import { z } from "zod";

import {
  isAdmittedPresetRequirementV1,
  presetProvidersV1,
  presetV1Schema,
  type ProviderV1,
} from "./presets";
import { profileIdSchema, unixMillisecondsSchema } from "./values";

// V1 runtime documents own this complete schema and helper graph. Existing
// writers alias V1 below; new formats must use separate definitions.
const binaryCompareV1 = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const canonicalStringsV1 = (values: readonly string[]): boolean =>
  values.every((value, index) => index === 0 || binaryCompareV1(values[index - 1] ?? "", value) < 0);

const safeDisplayStringV1 = (maximum: number) => z.string().trim().min(1).max(maximum).refine(
  (value) => !/[\p{Cc}\p{Cf}]/u.test(value),
  "Display text must not contain control or formatting characters.",
);

export const effectiveRuntimeAppV1Schema = z.object({
  id: z.string().trim().min(1).max(200),
  name: safeDisplayStringV1(320),
  pluginDisplayNames: z.array(safeDisplayStringV1(320)).max(100),
}).strict().superRefine((value, context) => {
  if (!canonicalStringsV1(value.pluginDisplayNames)) {
    context.addIssue({ code: "custom", message: "Plugin display names must be unique and canonically ordered." });
  }
});

export const effectiveRuntimeProfileV1Schema = z.object({
  profileId: profileIdSchema,
  processGeneration: z.number().int().nonnegative(),
  observedAt: unixMillisecondsSchema,
  preset: presetV1Schema,
  model: z.string().trim().min(1).max(200),
  reasoningEffort: z.enum(["max", "ultra"]),
  serviceTier: z.literal("priority").nullable(),
  fast: z.boolean(),
  approvalPolicy: z.literal("on-request"),
  reviewMode: z.literal("auto_review"),
  permissionProfile: z.literal(":workspace"),
  computerUse: z.literal(true),
  pluginCapability: z.literal(true),
  enabledApps: z.array(effectiveRuntimeAppV1Schema).max(100),
}).strict().superRefine((value, context) => {
  if (presetProvidersV1[value.preset] !== "codex") {
    context.addIssue({ code: "custom", message: "A Codex runtime profile cannot carry another provider's model preset." });
  }
  if (!isAdmittedPresetRequirementV1(value.preset, {
    model: value.model,
    effort: value.reasoningEffort,
  })) {
    context.addIssue({ code: "custom", message: "The effective model and reasoning effort must match an admitted exact Oompa preset." });
  }
  if ((value.fast && value.serviceTier !== "priority") || (!value.fast && value.serviceTier !== null)) {
    context.addIssue({ code: "custom", message: "Fast mode and the effective service tier are incoherent." });
  }
  if (!canonicalStringsV1(value.enabledApps.map((app) => app.id))) {
    context.addIssue({ code: "custom", message: "Enabled apps must have unique, canonically ordered identities." });
  }
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 240 * 1024) {
    context.addIssue({ code: "custom", message: "The effective runtime profile exceeds its durable byte limit." });
  }
});

export type EffectiveRuntimeAppV1 = z.infer<typeof effectiveRuntimeAppV1Schema>;
export type EffectiveRuntimeProfileV1 = z.infer<typeof effectiveRuntimeProfileV1Schema>;

/**
 * The reviewed profile Oompa proves before it lets the pinned Claude Code
 * runtime start a session or a turn. Claude Code owns its own permission
 * engine, so the profile pins the interactive permission mode (every tool use
 * reaches Oompa as a `can_use_tool` control request), the exact pinned CLI
 * version, and which reviewed `CLAUDE_CONFIG_DIR` authority it uses. Managed
 * sessions use an isolated account home; adopted sessions use the explicitly
 * bound personal home without pretending that it is isolated.
 */
const effectiveClaudeRuntimeProfileFieldsV1 = {
  profileId: profileIdSchema,
  processGeneration: z.number().int().nonnegative(),
  observedAt: unixMillisecondsSchema,
  preset: z.literal("fable-max"),
  model: z.string().trim().min(1).max(200),
  reasoningEffort: z.literal("max"),
  claudeVersion: z.string().regex(/^\d{1,5}\.\d{1,5}\.\d{1,5}$/u),
  permissionMode: z.literal("default"),
} as const;

export const claudeConfigHomeV1Schema = z.enum(["isolated", "personal"]);
export type ClaudeConfigHomeV1 = z.infer<typeof claudeConfigHomeV1Schema>;

const claudeNativeFallbackV1Schema = z.discriminatedUnion("status", [
  z.object({
    evidenceDigest: z.string().regex(/^[0-9a-f]{64}$/u),
    model: z.literal("claude-opus-5"),
    status: z.literal("armed"),
  }).strict(),
  z.object({
    model: z.literal("claude-opus-5"),
    reason: z.literal("live_acceptance_required"),
    status: z.literal("unavailable"),
  }).strict(),
]);

const configHomeEffectiveClaudeRuntimeProfileV1Schema = z.object({
  ...effectiveClaudeRuntimeProfileFieldsV1,
  configHome: claudeConfigHomeV1Schema,
  outputFormat: z.literal("stream-json"),
  inputFormat: z.literal("stream-json"),
  nativeFallback: claudeNativeFallbackV1Schema.optional(),
}).strict();

// Runtime-profile rows are immutable evidence. Keep accepting the exact
// legacy shape so its stored JSON and digest remain byte-stable; new reviews
// always write `configHome` instead.
const isolatedConfigDirEffectiveClaudeRuntimeProfileV1Schema = z.object({
  ...effectiveClaudeRuntimeProfileFieldsV1,
  isolatedConfigDir: z.literal(true),
  outputFormat: z.literal("stream-json"),
  inputFormat: z.literal("stream-json"),
  nativeFallback: claudeNativeFallbackV1Schema.optional(),
}).strict();

export const effectiveClaudeRuntimeProfileV1Schema = z.union([
  configHomeEffectiveClaudeRuntimeProfileV1Schema,
  isolatedConfigDirEffectiveClaudeRuntimeProfileV1Schema,
]).superRefine((value, context) => {
  // Immutable reviews retain shipped tuples when new-write defaults change.
  if (!isAdmittedPresetRequirementV1(value.preset, {
    model: value.model,
    effort: value.reasoningEffort,
  })) {
    context.addIssue({ code: "custom", message: "The effective model must match the exact Oompa preset." });
  }
});

export type EffectiveClaudeRuntimeProfileV1 = z.infer<typeof effectiveClaudeRuntimeProfileV1Schema>;

/**
 * The exact local Devin ACP profile HRA admits. The pinned CLI owns its
 * authentication and model defaults inside the isolated home; HRA records
 * only the public runtime/protocol facts it proved before dispatch.
 */
const effectiveDevinRuntimeProfileFieldsV1 = {
  profileId: profileIdSchema,
  processGeneration: z.number().int().nonnegative(),
  observedAt: unixMillisecondsSchema,
  preset: z.literal("astra"),
  model: z.string().trim().min(1).max(200),
  reasoningEffort: z.literal("provider-default"),
  devinVersion: z.string().regex(/^\d{1,5}\.\d{1,5}\.\d{1,5}$/u),
  protocolVersion: z.literal(1),
} as const;

export const effectiveDevinRuntimeProfileV1Schema = z.object({
  ...effectiveDevinRuntimeProfileFieldsV1,
  isolatedHome: z.literal(true),
}).strict().superRefine((value, context) => {
  if (!isAdmittedPresetRequirementV1(value.preset, {
    effort: value.reasoningEffort,
    model: value.model,
  })) {
    context.addIssue({
      code: "custom",
      message: "The effective model and reasoning effort must match Devin's exact current Oompa preset.",
    });
  }
});

export type EffectiveDevinRuntimeProfileV1 = z.infer<typeof effectiveDevinRuntimeProfileV1Schema>;

/**
 * The Devin ACP document the reactivated runtime adapter reviews on the
 * current pinned CLI (`kb/plans/devin-provider.md`, Phase 2). It is a separate
 * document from the historical V1 shape above because the pinned version
 * changed. It is deliberately not a member of the reviewed union yet: Phase 3
 * admits it with an append-only migration, so until then no storage row,
 * cloud payload or browser selector accepts it. The version literal must equal
 * `DEVIN_PIN` in `src/devin/pin.ts`; `src/devin/runtime.test.ts` asserts that.
 */
const effectiveDevinRuntimeProfileFieldsV2 = {
  profileId: profileIdSchema,
  processGeneration: z.number().int().nonnegative(),
  observedAt: unixMillisecondsSchema,
  preset: z.literal("astra"),
  model: z.string().trim().min(1).max(200),
  reasoningEffort: z.literal("provider-default"),
  devinVersion: z.literal("3000.10.27"),
  protocolVersion: z.literal(1),
} as const;

export const effectiveDevinRuntimeProfileV2Schema = z.object({
  ...effectiveDevinRuntimeProfileFieldsV2,
  isolatedHome: z.literal(true),
}).strict().superRefine((value, context) => {
  if (!isAdmittedPresetRequirementV1(value.preset, {
    effort: value.reasoningEffort,
    model: value.model,
  })) {
    context.addIssue({
      code: "custom",
      message: "The effective model and reasoning effort must match Devin's exact current Oompa preset.",
    });
  }
});

export type EffectiveDevinRuntimeProfileV2 = z.infer<typeof effectiveDevinRuntimeProfileV2Schema>;

/** Public Devin V2 evidence omits the private isolated-home custody marker. */
export const publicEffectiveDevinRuntimeProfileV2Schema = z.object({
  ...effectiveDevinRuntimeProfileFieldsV2,
}).strict().superRefine((value, context) => {
  if (!isAdmittedPresetRequirementV1(value.preset, {
    effort: value.reasoningEffort,
    model: value.model,
  })) {
    context.addIssue({
      code: "custom",
      message: "The effective model and reasoning effort must match Devin's exact current Oompa preset.",
    });
  }
});

export type PublicEffectiveDevinRuntimeProfileV2 = z.infer<
  typeof publicEffectiveDevinRuntimeProfileV2Schema
>;

export const projectPublicDevinRuntimeProfileV2 = (
  profile: EffectiveDevinRuntimeProfileV2,
): PublicEffectiveDevinRuntimeProfileV2 => {
  const publicProfile: Record<string, unknown> = { ...effectiveDevinRuntimeProfileV2Schema.parse(profile) };
  delete publicProfile.isolatedHome;
  return publicEffectiveDevinRuntimeProfileV2Schema.parse(publicProfile);
};

/**
 * The reviewed runtime profile one session-start, turn-start, or queue-start
 * effect proved, for one provider.
 *
 * Provider documents are stored exactly as their provider reviewed them
 * rather than inside a `{provider, profile}` wrapper. Every member is a
 * `.strict()` object with a provider-owned discriminator (`approvalPolicy`,
 * `claudeVersion`, or `devinVersion`), so exactly one member can match and
 * every pre-existing Codex or Claude row still parses and re-serialises byte
 * for byte. These historical shapes share the identity columns in
 * `session_runtime_profiles` and `session_turn_runtime_profiles`:
 * `profile_id`, `process_generation`, and `observed_at`. V1 retains that exact
 * union. Future shape or authority extensions need an explicit new-format
 * interpretation rather than widening V1.
 */
export const reviewedRuntimeProfileV1Schema = z.union([
  effectiveRuntimeProfileV1Schema,
  effectiveClaudeRuntimeProfileV1Schema,
  effectiveDevinRuntimeProfileV1Schema,
]);

export type ReviewedRuntimeProfileV1 =
  | EffectiveRuntimeProfileV1
  | EffectiveClaudeRuntimeProfileV1
  | EffectiveDevinRuntimeProfileV1;

/**
 * Public runtime evidence intentionally omits which Claude config home owns
 * the process. That field is required private custody evidence, but exposing
 * `personal` versus `isolated` would distinguish adopted sessions from native
 * ones. The legacy isolation marker is provenance for the same reason.
 */
export const publicEffectiveClaudeRuntimeProfileV1Schema = z.object({
  ...effectiveClaudeRuntimeProfileFieldsV1,
  outputFormat: z.literal("stream-json"),
  inputFormat: z.literal("stream-json"),
  nativeFallback: claudeNativeFallbackV1Schema.optional(),
}).strict().superRefine((value, context) => {
  if (!isAdmittedPresetRequirementV1(value.preset, {
    model: value.model,
    effort: value.reasoningEffort,
  })) {
    context.addIssue({ code: "custom", message: "The effective model must match the exact Oompa preset." });
  }
});

/** Public Devin evidence omits the private isolated-home custody marker. */
export const publicEffectiveDevinRuntimeProfileV1Schema = z.object({
  ...effectiveDevinRuntimeProfileFieldsV1,
}).strict().superRefine((value, context) => {
  if (!isAdmittedPresetRequirementV1(value.preset, {
    effort: value.reasoningEffort,
    model: value.model,
  })) {
    context.addIssue({
      code: "custom",
      message: "The effective model and reasoning effort must match Devin's exact current Oompa preset.",
    });
  }
});

export const publicReviewedRuntimeProfileV1Schema = z.union([
  effectiveRuntimeProfileV1Schema,
  publicEffectiveClaudeRuntimeProfileV1Schema,
  publicEffectiveDevinRuntimeProfileV1Schema,
]);

export type PublicReviewedRuntimeProfileV1 = z.infer<typeof publicReviewedRuntimeProfileV1Schema>;

export const projectPublicReviewedRuntimeProfileV1 = (
  profile: ReviewedRuntimeProfileV1,
): PublicReviewedRuntimeProfileV1 => {
  const reviewed = reviewedRuntimeProfileV1Schema.parse(profile);
  switch (reviewedRuntimeProfileProviderV1(reviewed)) {
    case "codex":
      return effectiveRuntimeProfileV1Schema.parse(reviewed);
    case "claude": {
      const publicProfile: Record<string, unknown> = { ...reviewed };
      delete publicProfile.configHome;
      delete publicProfile.isolatedConfigDir;
      return publicEffectiveClaudeRuntimeProfileV1Schema.parse(publicProfile);
    }
    case "devin": {
      const publicProfile: Record<string, unknown> = { ...reviewed };
      delete publicProfile.isolatedHome;
      return publicEffectiveDevinRuntimeProfileV1Schema.parse(publicProfile);
    }
  }
};

/** The provider a reviewed profile belongs to, read from its exact preset. */
export const reviewedRuntimeProfileProviderV1 = (
  profile: ReviewedRuntimeProfileV1,
): ProviderV1 => presetProvidersV1[profile.preset];

/** True only for the Codex document, which is the one that carries fast mode. */
export const isCodexRuntimeProfileV1 = (
  profile: ReviewedRuntimeProfileV1,
): profile is EffectiveRuntimeProfileV1 => reviewedRuntimeProfileProviderV1(profile) === "codex";

/** True only for the Devin ACP document. */
export const isDevinRuntimeProfileV1 = (
  profile: ReviewedRuntimeProfileV1,
): profile is EffectiveDevinRuntimeProfileV1 => reviewedRuntimeProfileProviderV1(profile) === "devin";

// Current public entry points preserve the same schema and function objects.
export const effectiveRuntimeAppSchema = effectiveRuntimeAppV1Schema;
export const effectiveRuntimeProfileSchema = effectiveRuntimeProfileV1Schema;
export type EffectiveRuntimeApp = EffectiveRuntimeAppV1;
export type EffectiveRuntimeProfile = EffectiveRuntimeProfileV1;
export const claudeConfigHomeSchema = claudeConfigHomeV1Schema;
export type ClaudeConfigHome = ClaudeConfigHomeV1;
export const effectiveClaudeRuntimeProfileSchema = effectiveClaudeRuntimeProfileV1Schema;
export type EffectiveClaudeRuntimeProfile = EffectiveClaudeRuntimeProfileV1;
export const effectiveDevinRuntimeProfileSchema = effectiveDevinRuntimeProfileV1Schema;
export type EffectiveDevinRuntimeProfile = EffectiveDevinRuntimeProfileV1;
export const reviewedRuntimeProfileSchema = reviewedRuntimeProfileV1Schema;
export type ReviewedRuntimeProfile = ReviewedRuntimeProfileV1;
export const publicEffectiveClaudeRuntimeProfileSchema = publicEffectiveClaudeRuntimeProfileV1Schema;
export const publicEffectiveDevinRuntimeProfileSchema = publicEffectiveDevinRuntimeProfileV1Schema;
export const publicReviewedRuntimeProfileSchema = publicReviewedRuntimeProfileV1Schema;
export type PublicReviewedRuntimeProfile = PublicReviewedRuntimeProfileV1;
export const projectPublicReviewedRuntimeProfile = projectPublicReviewedRuntimeProfileV1;
export const reviewedRuntimeProfileProvider = reviewedRuntimeProfileProviderV1;
export const isCodexRuntimeProfile = isCodexRuntimeProfileV1;
export const isDevinRuntimeProfile = isDevinRuntimeProfileV1;
