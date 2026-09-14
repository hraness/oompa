import { describe, expect, test } from "bun:test";

import {
  activePresetBinding,
  astraPresetContract,
  assertPresetSupportedByProvider,
  assertSupportedProvider,
  currentPresetContract,
  devinPresetContract,
  defaultPresetForProvider,
  isAdmittedPresetRequirement,
  isPresetSupportedByProvider,
  legacyPresetContract,
  PresetProviderMismatchError,
  presetContractSchema,
  presetForProviderTier,
  presetProviders,
  presetRequirementForContract,
  presetRequirementForContractV1,
  presetRequirements,
  presetSchema,
  presetTiers,
  presetsForProvider,
  providerSchema,
  solCodexPresetContract,
  supportedPresetSchema,
  supportedProviderSchema,
} from "./presets";
import {
  effectiveClaudeRuntimeProfileSchema,
  effectiveDevinRuntimeProfileSchema,
  effectiveRuntimeProfileSchema,
  isDevinRuntimeProfile,
  reviewedRuntimeProfileProvider,
  reviewedRuntimeProfileSchema,
} from "./runtime-profile";

describe("model presets and providers", () => {
  test("retains every shipped preset tuple under its literal historical contract", () => {
    const historical = [
      [1, "low", "gpt-5.6-luna", "max"],
      [1, "high", "gpt-5.6-sol", "max"],
      [1, "ultra", "gpt-5.6-sol", "ultra"],
      [1, "fable-max", "claude-fable-5-1", "max"],
      [2, "low", "gpt-5.6-luna", "max"],
      [2, "high", "gpt-6-astra", "max"],
      [2, "ultra", "gpt-6-astra", "ultra"],
      [2, "fable-max", "claude-fable-5-1", "max"],
      [2, "astra", "gpt-6-astra", "provider-default"],
    ] as const;
    // Expectations must not follow the current default or derive from the
    // production lookup: existing session and capsule digests own these tuples.
    for (const [contract, preset, model, effort] of historical) {
      expect(presetContractSchema.parse(contract)).toBe(contract);
      expect(presetRequirementForContract(preset, contract)).toEqual({ model, effort });
      expect(isAdmittedPresetRequirement(preset, { model, effort })).toBe(true);
    }
    expect(() => presetRequirementForContractV1("astra", 1))
      .toThrow("No preset requirement exists for that contract.");
    for (const contract of [0, 3, 1.5, "1", "2", null]) {
      expect(presetContractSchema.safeParse(contract).success).toBe(false);
    }
  });

  test("separates current admission from immutable retired provider history", () => {
    expect(supportedProviderSchema.options).toEqual(["codex", "claude"]);
    expect(supportedPresetSchema.options).toEqual(["low", "high", "ultra", "fable-max"]);
    expect(providerSchema.parse("devin")).toBe("devin");
    expect(presetSchema.parse("astra")).toBe("astra");
    expect(() => assertSupportedProvider("devin")).toThrow("PROVIDER_RETIRED:devin");
    expect(() => assertSupportedProvider("codex")).not.toThrow();
    expect(() => assertSupportedProvider("claude")).not.toThrow();
  });
  test("names exactly the five presets and three providers", () => {
    expect(presetSchema.options).toEqual(["low", "high", "ultra", "fable-max", "astra"]);
    expect(providerSchema.options).toEqual(["codex", "claude", "devin"]);
    expect(presetsForProvider("codex")).toEqual(["low", "high", "ultra"]);
    expect(presetsForProvider("claude")).toEqual(["fable-max"]);
    expect(presetsForProvider("devin")).toEqual(["astra"]);
  });

  test("gives every provider one supported default without changing preset meanings", () => {
    expect(defaultPresetForProvider("codex")).toBe("ultra");
    expect(defaultPresetForProvider("claude")).toBe("fable-max");
    expect(defaultPresetForProvider("devin")).toBe("astra");

    for (const provider of providerSchema.options) {
      const preset = defaultPresetForProvider(provider);
      expect(presetProviders[preset]).toBe(provider);
      expect(isPresetSupportedByProvider(provider, preset)).toBe(true);
    }
  });

  test("selects supported active bindings while preserving historical Astra decoding", () => {
    expect(solCodexPresetContract).toBe(legacyPresetContract);
    expect(astraPresetContract).toBe(currentPresetContract);
    expect(devinPresetContract).toBe(astraPresetContract);
    expect(presetRequirements.high).toEqual({
      model: "gpt-6-astra",
      effort: "max",
    });
    expect(presetRequirements.ultra).toEqual({
      model: "gpt-6-astra",
      effort: "ultra",
    });
    expect(presetRequirements.astra).toEqual({
      model: "gpt-6-astra",
      effort: "provider-default",
    });
    expect(supportedPresetSchema.options.map((preset) => [
      preset,
      activePresetBinding(preset),
    ])).toEqual([
      ["low", {
        contract: currentPresetContract,
        requirement: { model: "gpt-5.6-luna", effort: "max" },
      }],
      ["high", {
        contract: astraPresetContract,
        requirement: { model: "gpt-6-astra", effort: "max" },
      }],
      ["ultra", {
        contract: astraPresetContract,
        requirement: { model: "gpt-6-astra", effort: "ultra" },
      }],
      ["fable-max", {
        contract: currentPresetContract,
        requirement: { model: "claude-fable-5-1", effort: "max" },
      }],
    ]);
    expect(activePresetBinding("astra")).toEqual({
      contract: currentPresetContract,
      requirement: { model: "gpt-6-astra", effort: "provider-default" },
    });
  });

  test("versions exact requirements without widening the admitted tuples", () => {
    expect(presetContractSchema.options.map((option) => option.value)).toEqual([
      legacyPresetContract,
      currentPresetContract,
    ]);
    expect(presetRequirementForContract("high", legacyPresetContract)).toEqual({
      model: "gpt-5.6-sol",
      effort: "max",
    });
    expect(presetRequirementForContract("high", currentPresetContract)).toEqual({
      model: "gpt-6-astra",
      effort: "max",
    });
    expect(presetRequirementForContract("ultra", currentPresetContract)).toEqual({
      model: "gpt-6-astra",
      effort: "ultra",
    });
    expect(presetRequirementForContract("astra", legacyPresetContract)).toBeUndefined();
    expect(presetRequirementForContract("astra", currentPresetContract)).toEqual({
      model: "gpt-6-astra",
      effort: "provider-default",
    });
    expect(isAdmittedPresetRequirement("high", {
      model: "gpt-5.6-sol",
      effort: "max",
    })).toBe(true);
    expect(isAdmittedPresetRequirement("high", {
      model: "gpt-6-astra",
      effort: "ultra",
    })).toBe(false);
  });

  test("refuses an unshipped legacy Devin contract before returning any runtime requirement", () => {
    expect(() => presetRequirementForContractV1("astra", legacyPresetContract))
      .toThrow("No preset requirement exists for that contract.");
    expect(presetRequirementForContract("astra", currentPresetContract)).toEqual({
      model: "gpt-6-astra",
      effort: "provider-default",
    });
  });

  test("refuses a preset the session's provider cannot run", () => {
    expect(() => { assertPresetSupportedByProvider("claude", "ultra"); })
      .toThrow(PresetProviderMismatchError);
    expect(() => { assertPresetSupportedByProvider("claude", "ultra"); })
      .toThrow("The claude provider does not support the `ultra` model preset. Supported presets: fable-max.");
    expect(() => { assertPresetSupportedByProvider("codex", "fable-max"); })
      .toThrow("Supported presets: low, high, ultra.");
    expect(() => { assertPresetSupportedByProvider("devin", "ultra"); })
      .toThrow("The devin provider does not support the `ultra` model preset. Supported presets: astra.");
    expect(() => { assertPresetSupportedByProvider("codex", "ultra"); }).not.toThrow();
    expect(() => { assertPresetSupportedByProvider("devin", "astra"); }).not.toThrow();
    expect(isPresetSupportedByProvider("claude", "fable-max")).toBe(true);
    expect(isPresetSupportedByProvider("codex", "fable-max")).toBe(false);
    expect(isPresetSupportedByProvider("devin", "astra")).toBe(true);
  });

  test("round-trips every preset through its durable provider and tier", () => {
    for (const preset of presetSchema.options) {
      const provider = presetProviders[preset];
      expect(presetForProviderTier(provider, presetTiers[preset])).toBe(preset);
    }
    // No Claude preset exists below the top tier, so a stored `low` tier can
    // never be reassembled as a Claude preset.
    expect(() => presetForProviderTier("claude", "low")).toThrow("No claude model preset exists");
    expect(() => presetForProviderTier("devin", "high")).toThrow("No devin model preset exists");
  });

  test("keeps another provider's preset out of a Codex runtime profile", () => {
    const profile = {
      approvalPolicy: "on-request",
      computerUse: true,
      enabledApps: [],
      fast: false,
      model: "gpt-6-astra",
      observedAt: 1_700_000_000_000,
      permissionProfile: ":workspace",
      pluginCapability: true,
      preset: "ultra",
      processGeneration: 1,
      profileId: "acct_00000000000000000000000000000000",
      reasoningEffort: "ultra",
      reviewMode: "auto_review",
      serviceTier: null,
    };
    expect(effectiveRuntimeProfileSchema.safeParse(profile).success).toBe(true);
    const legacy = {
      ...profile,
      model: "gpt-5.6-sol",
    };
    // Durable profile JSON is written from the parsed object, whose key order
    // is canonical. Reopening it must not rewrite that historical document.
    const legacyJson = JSON.stringify(effectiveRuntimeProfileSchema.parse(legacy));
    expect(JSON.stringify(effectiveRuntimeProfileSchema.parse(JSON.parse(legacyJson)))).toBe(legacyJson);
    expect(effectiveRuntimeProfileSchema.safeParse({
      ...legacy,
      reasoningEffort: "max",
    }).success).toBe(false);
    expect(effectiveRuntimeProfileSchema.safeParse({
      ...profile,
      model: "claude-fable-5-1",
      preset: "fable-max",
      reasoningEffort: "max",
    }).success).toBe(false);
  });

  test("keeps the reviewed native fallback state inside new Claude runtime profiles", () => {
    const profile = {
      claudeVersion: "2.1.260",
      inputFormat: "stream-json",
      isolatedConfigDir: true,
      model: "claude-fable-5-1",
      nativeFallback: {
        model: "claude-opus-5",
        reason: "live_acceptance_required",
        status: "unavailable",
      },
      observedAt: 1_700_000_000_000,
      outputFormat: "stream-json",
      permissionMode: "default",
      preset: "fable-max",
      processGeneration: 1,
      profileId: "acct_00000000000000000000000000000000",
      reasoningEffort: "max",
    };
    expect(effectiveClaudeRuntimeProfileSchema.safeParse(profile).success).toBe(true);
    expect(effectiveClaudeRuntimeProfileSchema.safeParse({
      ...profile,
      nativeFallback: {
        evidenceDigest: "not-a-digest",
        model: "claude-opus-5",
        status: "armed",
      },
    }).success).toBe(false);
    expect(effectiveClaudeRuntimeProfileSchema.safeParse({
      ...profile,
      nativeFallback: {
        evidenceDigest: "a".repeat(64),
        model: "claude-sonnet-5",
        status: "armed",
      },
    }).success).toBe(false);
    // Profiles recorded before the capability field was added remain readable
    // and keep their exact JSON and digest authority.
    expect(effectiveClaudeRuntimeProfileSchema.safeParse({
      ...profile,
      nativeFallback: undefined,
    }).success).toBe(true);
  });

  test("decodes the historical Devin Astra ACP profile without widening its exact tuple", () => {
    const profile = {
      devinVersion: "3000.6.14",
      isolatedHome: true,
      model: "gpt-6-astra",
      observedAt: 1_700_000_000_000,
      preset: "astra",
      processGeneration: 1,
      profileId: "acct_00000000000000000000000000000000",
      protocolVersion: 1,
      reasoningEffort: "provider-default",
    };
    const parsed = effectiveDevinRuntimeProfileSchema.parse(profile);
    expect(reviewedRuntimeProfileSchema.parse(profile)).toEqual(parsed);
    expect(reviewedRuntimeProfileProvider(parsed)).toBe("devin");
    expect(isDevinRuntimeProfile(parsed)).toBe(true);
    expect(effectiveDevinRuntimeProfileSchema.safeParse({
      ...profile,
      model: "gpt",
    }).success).toBe(false);
    expect(effectiveDevinRuntimeProfileSchema.safeParse({
      ...profile,
      reasoningEffort: "max",
    }).success).toBe(false);
  });
});
