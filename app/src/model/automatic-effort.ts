import {
  activePresetBinding,
  classifyModelTaskShape,
  type ModelTaskShapeRule,
  type PresetContract,
  type SupportedPreset,
} from "../oompa/cloud";

export const automaticEffortStorageKey = "oompa-automatic-effort-v1";

/** No saved choice enables the policy. Unknown or unreadable values fail off. */
export function parseAutomaticEffortPreference(value: unknown): boolean {
  return value === null || value === "on";
}

export function automaticEffortPreference(storage: Readonly<{
  read: () => unknown;
  write: (value: "on" | "off") => void;
}>) {
  let forceOff = false;
  return {
    read: (): boolean => {
      if (forceOff) return false;
      try { return parseAutomaticEffortPreference(storage.read()); }
      catch { return false; }
    },
    write: (enabled: boolean): boolean => {
      try {
        const value = enabled ? "on" : "off";
        storage.write(value);
        if (storage.read() !== value) throw new Error("Preference was not retained");
        forceOff = false;
        return true;
      } catch {
        // A failed disable must still survive navigation within this tab.
        forceOff = true;
        return false;
      }
    },
  };
}

export type BrowserStartDecision = Readonly<{
  preset: SupportedPreset;
  reason: "automatic_max" | "automatic_ultra" | "disabled" | "unsupported_binding" | "claude_default";
  matchedRule: ModelTaskShapeRule | null;
}>;

type CodexBinding = Readonly<{
  contract: PresetContract;
  requirement: Readonly<{ model: string; effort: string }>;
}>;

/** Pure new-session selection. The caller supplies the build's exact bindings;
 * the ordinary command builder still fences them against the target daemon. */
export function selectBrowserStartEffort(input: Readonly<{
  automatic: boolean;
  provider: "codex" | "claude";
  prompt: string;
  high: CodexBinding;
  ultra: CodexBinding;
}>): BrowserStartDecision {
  if (input.provider === "claude") return { preset: "fable-max", reason: "claude_default", matchedRule: null };
  if (!input.automatic) return { preset: "ultra", reason: "disabled", matchedRule: null };
  if (input.high.contract !== 2 || input.ultra.contract !== 2
    || input.high.requirement.model !== "gpt-6-astra" || input.ultra.requirement.model !== "gpt-6-astra"
    || input.high.requirement.effort !== "max" || input.ultra.requirement.effort !== "ultra") {
    return { preset: "ultra", reason: "unsupported_binding", matchedRule: null };
  }
  const classification = classifyModelTaskShape({ taskText: input.prompt });
  const bounded = classification.shape === "well_defined" || classification.shape === "mechanical";
  // Check only classifier-bounded text. Named models are already guarded;
  // an explicit effort or preset must not be evidence for a downshift either.
  const explicitEffort = bounded
    && /\b(?:ultra|max|high|low|fast|effort|reasoning|preset)\b/iu.test(input.prompt.normalize("NFKC"));
  const useMax = bounded && !explicitEffort;
  return {
    preset: useMax ? "high" : "ultra",
    reason: useMax ? "automatic_max" : "automatic_ultra",
    matchedRule: explicitEffort ? null : classification.matchedRule,
  };
}

export function browserStartDecision(input: Readonly<{
  automatic: boolean;
  provider: "codex" | "claude";
  prompt: string;
}>): BrowserStartDecision {
  return selectBrowserStartEffort({ ...input, high: activePresetBinding("high"), ultra: activePresetBinding("ultra") });
}

export function browserStartEffortHint(decision: BrowserStartDecision): string {
  switch (decision.reason) {
    case "automatic_max": return "Automatic effort: Max for this simple prompt.";
    case "automatic_ultra": return "Automatic effort: Ultra.";
    case "disabled": return "Automatic effort is off: Ultra.";
    case "unsupported_binding": return "Ultra. Automatic effort requires the Astra update.";
    case "claude_default": return "Claude uses Fable Max.";
  }
}
