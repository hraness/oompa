import { z } from "zod";

// Retained V1 documents own these exact providers, presets and model tuples.
// Future writer formats must not extend or reinterpret these definitions.
export const providerV1Schema = z.enum(["codex", "claude", "devin"]);
export type ProviderV1 = z.infer<typeof providerV1Schema>;

/** Historical provider identities. Retired providers remain readable, never executable. */
export const providerSchema = providerV1Schema;
export type Provider = ProviderV1;

/** Providers whose existing personal-home sessions Oompa can adopt. */
export const adoptableProviderSchema = z.enum(["codex", "claude"]);
export type AdoptableProvider = z.infer<typeof adoptableProviderSchema>;

/** Providers admitted for new effects. Do not use historical schemas for admission. */
export const supportedProviderSchema = z.enum(["codex", "claude"]);
export type SupportedProvider = z.infer<typeof supportedProviderSchema>;

export const DEFAULT_PROVIDER = "codex" satisfies SupportedProvider;

/** Historical aliases, including those found only in retired provider records. */
export const presetV1Schema = z.enum(["low", "high", "ultra", "fable-max", "astra"]);
export type PresetV1 = z.infer<typeof presetV1Schema>;
export const presetSchema = presetV1Schema;
export type Preset = PresetV1;
export const supportedPresetSchema = z.enum(["low", "high", "ultra", "fable-max"]);
export type SupportedPreset = z.infer<typeof supportedPresetSchema>;

export const isSupportedProvider = (provider: Provider): provider is SupportedProvider =>
  supportedProviderSchema.safeParse(provider).success;

export const isSupportedPreset = (preset: Preset): preset is SupportedPreset =>
  supportedPresetSchema.safeParse(preset).success;

export function assertSupportedProvider(provider: Provider): asserts provider is SupportedProvider {
  if (!isSupportedProvider(provider)) throw new Error(`PROVIDER_RETIRED:${provider}`);
}

/**
 * The durable storage encoding of a preset. `sessions.preset` and
 * `daemon_state.default_preset` predate multi-provider presets and enforce
 * this closed set in SQLite; a preset is therefore stored as its provider plus
 * its tier and reassembled on read. Every tier/provider pair that names a real
 * preset appears in `presetsByProviderTier`.
 */
export const presetTierSchema = z.enum(["low", "high", "ultra"]);
export type PresetTier = z.infer<typeof presetTierSchema>;

/**
 * The durable interpretation of a stored preset alias.
 *
 * Contract 1 is the original Sol mapping. Contract 2 is the later Astra
 * mapping. Both integers are stored in SQLite, so never renumber or
 * reinterpret either contract. The active selection for a preset is separate
 * from this frozen history and can return to an older contract.
 */
export const legacyPresetContract = 1 as const;
export const currentPresetContract = 2 as const;
/** Semantic names for active choices; historical aliases remain API-compatible. */
export const solCodexPresetContract = legacyPresetContract;
export const astraPresetContract = currentPresetContract;
export const devinPresetContract = astraPresetContract;
// Persisted versions are independent of the default chosen for new writes.
// Adding a contract must retain each shipped version and its exact mapping.
export const presetContractV1Schema = z.union([
  z.literal(1),
  z.literal(2),
]);
export type PresetContractV1 = z.infer<typeof presetContractV1Schema>;
export const presetContractSchema = presetContractV1Schema;
export type PresetContract = PresetContractV1;

export type PresetRequirementV1 = Readonly<{
  model: string;
  effort: "max" | "ultra" | "provider-default";
}>;
export type PresetRequirement = PresetRequirementV1;

const presetContract1RequirementsV1 = {
  low: { model: "gpt-5.6-luna", effort: "max" },
  high: { model: "gpt-5.6-sol", effort: "max" },
  ultra: { model: "gpt-5.6-sol", effort: "ultra" },
  "fable-max": { model: "claude-fable-5-1", effort: "max" },
} as const satisfies Partial<Record<PresetV1, PresetRequirementV1>>;

const presetContract2RequirementsV1 = {
  low: { model: "gpt-5.6-luna", effort: "max" },
  high: { model: "gpt-6-astra", effort: "max" },
  ultra: { model: "gpt-6-astra", effort: "ultra" },
  // The local Fable model id measured for the pinned Claude Code release. It
  // is spelled here rather than imported because `src/domain` is the leaf
  // layer; `src/claude/pin.test.ts` proves the two stay equal.
  "fable-max": { model: "claude-fable-5-1", effort: "max" },
  // Retained only to decode the exact runtime tuple already stored by v39.
  astra: { model: "gpt-6-astra", effort: "provider-default" },
} as const satisfies Record<PresetV1, PresetRequirementV1>;

const presetRequirementsByContractV1: Readonly<
  Record<PresetContractV1, Partial<Readonly<Record<PresetV1, PresetRequirementV1>>>>
> = Object.freeze({
  1: Object.freeze(presetContract1RequirementsV1),
  2: Object.freeze(presetContract2RequirementsV1),
});

type ActivePresetBinding = Readonly<{
  contract: PresetContract;
  requirement: PresetRequirement;
}>;

/**
 * One atomic, exhaustive binding for a new or explicitly selected preset.
 *
 * Codex High and Ultra select their immutable Astra meanings from contract 2
 * (the owner's preferred Codex model since 2026-09-10; contract 1 Sol was the
 * active binding between 2026-09-06 and then). Low and Fable are
 * byte-identical across both contracts. Established sessions keep whichever
 * contract they were bound to until a preset is explicitly reselected. The
 * Devin Astra entry exists only so exact historical records can be decoded;
 * effect admission must first pass the supported provider and preset schemas.
 */
const activePresetBindings = Object.freeze({
  low: Object.freeze({
    contract: astraPresetContract,
    requirement: presetContract2RequirementsV1.low,
  }),
  high: Object.freeze({
    contract: astraPresetContract,
    requirement: presetContract2RequirementsV1.high,
  }),
  ultra: Object.freeze({
    contract: astraPresetContract,
    requirement: presetContract2RequirementsV1.ultra,
  }),
  "fable-max": Object.freeze({
    contract: astraPresetContract,
    requirement: presetContract2RequirementsV1["fable-max"],
  }),
  astra: Object.freeze({
    contract: devinPresetContract,
    requirement: presetContract2RequirementsV1.astra,
  }),
} as const satisfies Readonly<Record<Preset, ActivePresetBinding>>);

export const activePresetBinding = <P extends Preset>(
  preset: P,
): (typeof activePresetBindings)[P] => activePresetBindings[preset];

export const isReboundCodexPreset = (
  preset: Preset | undefined,
): preset is "high" | "ultra" => preset === "high" || preset === "ultra";

/**
 * Whether a provider-switch request can select one of the mutable Codex
 * aliases. An omitted Codex preset is source-sensitive because the daemon
 * derives the target tier from session state that the caller cannot inspect
 * atomically with dispatch.
 */
export const providerSwitchRequiresPresetContract = (
  provider: Provider,
  preset: Preset | undefined,
): boolean => provider === "codex"
  && (preset === undefined || isReboundCodexPreset(preset));

const activeReboundCodexPresetContract = (preset: "high" | "ultra"): PresetContract =>
  activePresetBinding(preset).contract;

/**
 * The one active contract shared by Codex High and Ultra wherever a boundary
 * can select either alias without observing which tier will win. Keep the
 * equality check centralized so every such boundary fails closed if those
 * aliases ever stop sharing one interpretation.
 */
export const sharedActiveCodexPresetContract = (): PresetContract => {
  const high = activeReboundCodexPresetContract("high");
  const ultra = activeReboundCodexPresetContract("ultra");
  if (high !== ultra) {
    throw new Error("Implicit Codex preset selection requires High and Ultra to share one active contract.");
  }
  return high;
};

/**
 * Requirements exposed to runtime readers. Supported aliases use their active
 * bindings; Astra retains only its exact historical tuple.
 */
export const presetRequirements = Object.freeze({
  low: activePresetBindings.low.requirement,
  high: activePresetBindings.high.requirement,
  ultra: activePresetBindings.ultra.requirement,
  "fable-max": activePresetBindings["fable-max"].requirement,
  astra: activePresetBindings.astra.requirement,
} as const satisfies Readonly<Record<Preset, PresetRequirement>>);

/** Resolve one alias under its durable, session-owned interpretation. */
export const presetRequirementForContractV1 = (
  preset: PresetV1,
  contract: PresetContractV1,
): PresetRequirementV1 => {
  const requirement = presetRequirementsByContractV1[contract][preset];
  if (requirement === undefined) {
    throw new Error("No preset requirement exists for that contract.");
  }
  return requirement;
};
type ContractRequirement<P extends Preset, C extends PresetContract> =
  C extends 2 ? PresetRequirement : P extends "astra" ? undefined : PresetRequirement;

/** Current lookup preserves the supported-provider branch's absent-tuple result. */
export const presetRequirementForContract = <P extends Preset, C extends PresetContract>(
  preset: P,
  contract: C,
): ContractRequirement<P, C> =>
  presetRequirementsByContractV1[contract][preset] as ContractRequirement<P, C>;

/**
 * Historical runtime documents remain admissible only when they carry one of
 * the exact tuples Oompa has shipped for that alias.
 */
export const isAdmittedPresetRequirementV1 = (
  preset: PresetV1,
  requirement: PresetRequirementV1,
): boolean => ([1, 2] as const).some((contract) => {
  const admitted = presetRequirementsByContractV1[contract][preset];
  return admitted !== undefined
    && admitted.model === requirement.model
    && admitted.effort === requirement.effort;
});
export const isAdmittedPresetRequirement = isAdmittedPresetRequirementV1;

export const presetProvidersV1 = {
  low: "codex",
  high: "codex",
  ultra: "codex",
  "fable-max": "claude",
  astra: "devin",
} as const satisfies Record<PresetV1, ProviderV1>;
export const presetProviders = presetProvidersV1;

/** The presets a given provider owns, as a type. */
export type ProviderPreset<P extends Provider> = {
  [K in Preset]: (typeof presetProviders)[K] extends P ? K : never;
}[Preset];

const defaultPresetsByProvider = {
  claude: "fable-max",
  codex: "ultra",
  devin: "astra",
} as const satisfies { readonly [P in Provider]: ProviderPreset<P> };

/** Historical default mapping; new sessions must first admit a supported provider. */
export const defaultPresetForProvider = <P extends Provider>(
  provider: P,
): (typeof defaultPresetsByProvider)[P] => defaultPresetsByProvider[provider];

export const presetTiers = {
  low: "low",
  high: "high",
  ultra: "ultra",
  "fable-max": "ultra",
  astra: "ultra",
} as const satisfies Record<Preset, PresetTier>;

const presetsByProviderTier: Readonly<
  Record<Provider, Partial<Readonly<Record<PresetTier, Preset>>>>
> = Object.freeze({
  claude: Object.freeze({ ultra: "fable-max" }),
  codex: Object.freeze({ high: "high", low: "low", ultra: "ultra" }),
  devin: Object.freeze({ ultra: "astra" }),
});

/** Historically mapped presets, in declaration order; not an admission check. */
export const presetsForProvider = (provider: Provider): readonly Preset[] =>
  presetSchema.options.filter((preset) => presetProviders[preset] === provider);

export class PresetProviderMismatchError extends Error {
  readonly provider: Provider;
  readonly preset: Preset;

  constructor(provider: Provider, preset: Preset) {
    super(
      `The ${provider} provider does not support the \`${preset}\` model preset. `
      + `Supported presets: ${presetsForProvider(provider).join(", ")}.`,
    );
    this.name = "PresetProviderMismatchError";
    this.provider = provider;
    this.preset = preset;
  }
}

/** Refuses a preset the session's provider cannot run, never ignores it. */
export function assertPresetSupportedByProvider<P extends Provider>(
  provider: P,
  preset: Preset,
): asserts preset is ProviderPreset<P> {
  if (presetProviders[preset] !== provider) {
    throw new PresetProviderMismatchError(provider, preset);
  }
}

/** The refusal as a value, for callers that classify instead of throwing. */
export const isPresetSupportedByProvider = (provider: Provider, preset: Preset): boolean =>
  presetProviders[preset] === provider;

/** Reassembles the preset a stored provider and tier name. */
export const presetForProviderTier = (provider: Provider, tier: PresetTier): Preset => {
  const preset = presetsByProviderTier[provider][tier];
  if (preset === undefined) {
    throw new Error(
      `No ${provider} model preset exists for the \`${tier}\` tier. `
      + `Supported presets: ${presetsForProvider(provider).join(", ")}.`,
    );
  }
  return preset;
};
