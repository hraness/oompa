/**
 * Switching a live session between Codex, Claude Code, and Devin.
 *
 * This module is the single alignment point for the `set_provider` remote
 * command. The daemon-side kind is being added in parallel, so the payload is
 * built here and nowhere else: when the kind lands, this file is the only one
 * that changes, and `providerSwitchSupported()` flips from false to true on its
 * own because it asks the repository contract rather than a constant.
 *
 * There is no React and no Convex here. `providerSwitchNotice` is typed
 * structurally over the three fields a command record carries, the same way
 * `deviceCommandNotice` is, so the settling line is provable without a client.
 */
import {
  activeRemoteDerivedCodexSelection,
  activeRemotePresetSelection,
  isCommandKind,
  parseRemoteCommandPayload,
  type ModelPreset,
  type RemoteCommandPayload,
} from "../oompa/cloud";

export type SessionProvider = "codex" | "claude" | "devin";

export type SessionPresetOption = Readonly<{
  label: string;
  value: ModelPreset;
}>;

const codexPresetOptions: readonly SessionPresetOption[] = Object.freeze([
  { label: "Luna Max", value: "low" },
  // These are remote aliases, not proof of the target daemon's active
  // contract. Registry v1 cannot distinguish a rolling Sol/Astra binding.
  { label: "Codex High", value: "high" },
  { label: "Codex Ultra", value: "ultra" },
]);

const claudePresetOptions: readonly SessionPresetOption[] = Object.freeze([
  { label: "Claude Fable Max", value: "fable-max" },
]);

const devinPresetOptions: readonly SessionPresetOption[] = Object.freeze([
  { label: "GPT-6 Astra", value: "astra" },
]);

const allPresetOptions: readonly SessionPresetOption[] = Object.freeze([
  ...codexPresetOptions,
  ...claudePresetOptions,
  ...devinPresetOptions,
]);

/**
 * The model choices compatible with a provider selected in this menu.
 *
 * The current session projection does not disclose its provider, so `null`
 * deliberately preserves the broad menu shown before the reader makes a
 * provider choice. Once they do choose, only that provider's presets remain.
 */
export function sessionPresetOptionsForProvider(
  provider: SessionProvider | null,
): readonly SessionPresetOption[] {
  if (provider === "codex") return codexPresetOptions;
  if (provider === "claude") return claudePresetOptions;
  if (provider === "devin") return devinPresetOptions;
  return allPresetOptions;
}

/** The pinned preset sent atomically with a provider switch. */
export function defaultSessionPresetForProvider(provider: SessionProvider): ModelPreset {
  if (provider === "claude") return "fable-max";
  if (provider === "devin") return "astra";
  return "ultra";
}

export const providerSwitchOptions: readonly Readonly<{
  label: string;
  provider: SessionProvider;
}>[] = Object.freeze([
  { label: "Run on Codex", provider: "codex" },
  { label: "Run on Claude Code (Linux machine only)", provider: "claude" },
  { label: "Run on Devin", provider: "devin" },
]);

/**
 * The one line under the menu. Switching is not a transfer of the provider's
 * own state: each provider keeps its own transcript format, its own tool
 * results, and its own reasoning, none of which the other can read. What
 * crosses is a summary the daemon writes, so the reader is told that before
 * choosing rather than after noticing the new provider has forgotten a detail.
 */
export const providerSwitchNote =
  "Switching hands the new provider a summary of the conversation so far, not the other "
  + "provider's own history. Claude targets require a Linux custodian; macOS refuses "
  + "before launching Claude.";

export const setProviderCommandKind = "set_provider";

/**
 * The one builder for the provider switch payload.
 *
 * `preset` is optional: with it, the switch and the model choice are one
 * command, so a session cannot land on the new provider under a preset that
 * provider does not have. A rebound Codex High or Ultra selection also carries
 * this build's immutable contract. A preset-omitted Codex switch carries the
 * shared High/Ultra contract because the daemon derives its target alias. That
 * makes rolling mismatches fail before switching without changing stable
 * explicit preset shapes.
 */
export function buildSetProviderPayload(input: Readonly<{
  preset?: ModelPreset;
  provider: SessionProvider;
}>): RemoteCommandPayload {
  const payload = input.preset === undefined
    ? input.provider === "codex"
      ? { kind: setProviderCommandKind, ...activeRemoteDerivedCodexSelection() }
      : { kind: setProviderCommandKind, provider: input.provider }
    : {
        kind: setProviderCommandKind,
        ...activeRemotePresetSelection(input.preset),
        provider: input.provider,
      };
  const parsed = parseRemoteCommandPayload(payload);
  if (parsed === null) throw new Error("The provider switch payload is not valid.");
  return parsed;
}

/** Build the atomic provider-and-default-preset switch used by the session menu. */
export function buildDefaultSetProviderPayload(provider: SessionProvider): RemoteCommandPayload {
  return buildSetProviderPayload({
    preset: defaultSessionPresetForProvider(provider),
    provider,
  });
}

/**
 * Whether the contract in this build carries the switch.
 *
 * `isCommandKind` is the repository's own closed list, so this is not a guess:
 * a build whose daemon cannot accept the command says so in the menu instead of
 * enqueueing something that would be refused after the round trip.
 */
export function providerSwitchSupported(): boolean {
  return isCommandKind(setProviderCommandKind);
}

/**
 * Why the switch is unavailable right now, or null when it can be taken.
 *
 * A switch mid-turn would race the provider that is writing, so it waits for
 * the turn to finish rather than racing it.
 */
export function providerSwitchDisabledReason(input: Readonly<{
  sending: boolean;
  /** `providerSwitchSupported()`, passed in so this stays a pure function. */
  supported: boolean;
  turnActive: boolean;
}>): string | null {
  if (!input.supported) {
    return "This build's daemon contract does not carry a provider switch yet.";
  }
  if (input.turnActive) return "Stop the turn first, then switch.";
  if (input.sending) return "A command is already going out.";
  return null;
}

export type ProviderSwitchNotice = Readonly<{
  settled: boolean;
  text: string;
}>;

/**
 * The one line the menu shows for the switch it last submitted.
 *
 * An ambiguous outcome is never phrased as a failure: the daemon may have
 * switched and lost the confirmation, so the honest instruction is to look at
 * the session rather than to send it again.
 */
export function providerSwitchNotice(
  command: Readonly<{ resultCode: string | null; state: string }> | null,
  provider: SessionProvider | null,
): ProviderSwitchNotice | null {
  if (command === null || provider === null) return null;
  const name = provider === "claude"
    ? "Claude Code"
    : provider === "devin" ? "Devin" : "Codex";
  switch (command.state) {
    case "pending":
      return { settled: false, text: `Waiting for the machine to pick up the switch to ${name}.` };
    case "prepared":
    case "effect_started":
      return { settled: false, text: `Switching this session to ${name}.` };
    case "applied":
      return { settled: true, text: `This session is running on ${name}.` };
    case "ambiguous":
      return {
        settled: true,
        text: "The machine could not confirm the switch. Check the session before trying again.",
      };
    case "expired":
      return { settled: true, text: "The machine never picked up the switch." };
    case "cancelled":
      return { settled: true, text: "The switch was cancelled." };
    case "failed":
      return {
        settled: true,
        text: command.resultCode === null
          ? "The machine refused the switch."
          : `The machine refused the switch: ${command.resultCode}.`,
      };
    default:
      return { settled: false, text: `Switching this session to ${name}.` };
  }
}
