/**
 * The settings screen's command builders.
 *
 * Every control on the settings screen submits one `RemoteCommandPayload`
 * through the ordinary durable command path, so the shape of each payload is
 * built here rather than inline in a component: the daemon's validator in
 * `src/cloud/payloads.ts` is a closed union with exact key sets, and a builder
 * that drifts from it fails at the daemon rather than at the browser.
 *
 * Daemon-wide settings are session-addressed like every other command (the
 * command table is indexed by session), so the caller sends them to any live
 * session that belongs to the target machine and the `scope: "default"` field
 * is what makes them daemon defaults rather than session overrides.
 *
 * Nothing here imports React, so `bun test ./app` runs it without a document.
 */
import {
  activeRemotePresetSelection,
  type RemoteCommandPayload,
  type SupportedPreset,
} from "../oompa/cloud";

export type ApprovalMode = "auto:all" | "auto:workspace" | "manual";
export type PresetChoice = "low" | "high" | "ultra" | "fable-max" | "astra";

/** The scope every machine-level control on this screen uses. */
export const defaultSettingScope = "default" as const;

export const approvalModes: readonly ApprovalMode[] = Object.freeze([
  "auto:all",
  "auto:workspace",
  "manual",
] as const);

export const approvalModeLabels: Readonly<Record<ApprovalMode, string>> = Object.freeze({
  "auto:all": "Auto, all",
  "auto:workspace": "Auto, workspace",
  manual: "Manual",
});

export const presetChoices: readonly PresetChoice[] = Object.freeze([
  "low",
  "high",
  "ultra",
  "fable-max",
  "astra",
] as const);

export const presetLabels: Readonly<Record<PresetChoice, string>> = Object.freeze({
  "fable-max": "Fable Max",
  astra: "Devin Astra",
  // The web app and a target daemon can roll independently, and registry v1
  // projects only the stable alias rather than that daemon's active binding.
  // Keep mutable Codex controls alias-generic until the exact binding is
  // projected; otherwise an old tab or same-version source daemon can make a
  // Sol-labelled control select Astra, or the reverse.
  high: "Codex High",
  low: "Luna Max",
  ultra: "Codex Ultra",
});

export function approvalModeCommand(mode: ApprovalMode): RemoteCommandPayload {
  return { kind: "set_approval_mode", mode, scope: defaultSettingScope };
}

export function showThinkingCommand(enabled: boolean): RemoteCommandPayload {
  return { enabled, kind: "set_show_thinking", scope: defaultSettingScope };
}

export function defaultPresetCommand(preset: SupportedPreset): RemoteCommandPayload {
  return { kind: "set_default_preset", ...activeRemotePresetSelection(preset) };
}

export function sessionPresetCommand(preset: SupportedPreset): RemoteCommandPayload {
  return { kind: "set_model", ...activeRemotePresetSelection(preset) };
}

/** Fast is a session-only manual control; there is no inferred browser state. */
export function sessionFastCommand(enabled: boolean): RemoteCommandPayload {
  return { enabled, kind: "set_fast" };
}

export type SessionFastCommandNotice = Readonly<{
  applied: boolean;
  text: string;
}>;

/**
 * Truthful state for the last Fast command this browser submitted.
 *
 * The browser has no authoritative current Fast value. It may highlight a
 * choice only after the machine reports that exact command as applied; an
 * ambiguous result remains unselected because either outcome is possible.
 */
export function sessionFastCommandNotice(
  command: Readonly<{ resultCode: string | null; state: string }> | null,
  enabled: boolean | null,
): SessionFastCommandNotice | null {
  if (command === null || enabled === null) return null;
  const value = enabled ? "on" : "off";
  switch (command.state) {
    case "pending":
      return { applied: false, text: `Waiting for the machine to set Fast ${value}.` };
    case "prepared":
    case "effect_started":
      return { applied: false, text: `Setting Fast ${value} for future turns.` };
    case "applied":
      return {
        applied: true,
        text: `The machine applied Fast ${value} for future turns.`,
      };
    case "ambiguous":
      return {
        applied: false,
        text: "The machine could not confirm the Fast change. Check the session before trying again.",
      };
    case "expired":
      return { applied: false, text: "The machine never picked up the Fast change." };
    case "cancelled":
      return { applied: false, text: "The Fast change was cancelled." };
    case "failed":
      return {
        applied: false,
        text: command.resultCode === null
          ? "The machine refused the Fast change."
          : `The machine refused the Fast change: ${command.resultCode}.`,
      };
    default:
      return { applied: false, text: `Setting Fast ${value} for future turns.` };
  }
}

/** Unarchive is session scoped: it addresses the archived session itself. */
export function unarchiveSessionCommand(): RemoteCommandPayload {
  return { archived: false, kind: "archive_session" };
}

export const gatewayKeyMinimumLength = 8;
export const gatewayKeyMaximumLength = 512;

/*
 * The daemon accepts 8 to 512 printable ASCII characters with no space
 * (`isGatewayKeyShape` in `src/cloud/payloads.ts`). The check is repeated here
 * so a mistyped value is refused in the browser instead of travelling to the
 * daemon, and it is a shape check only: the value itself is never logged,
 * echoed into a notice, or held anywhere but the controlled input it came from.
 */
const gatewayKeyCharacters = /^[!-~]+$/u;

export function isGatewayKeyShape(value: string): boolean {
  return value.length >= gatewayKeyMinimumLength
    && value.length <= gatewayKeyMaximumLength
    && gatewayKeyCharacters.test(value);
}

export const gatewayKeyShapeMessage =
  `A gateway key is ${gatewayKeyMinimumLength} to ${gatewayKeyMaximumLength} `
  + "printable characters with no space.";

export function gatewayKeyCommand(key: string): RemoteCommandPayload {
  if (!isGatewayKeyShape(key)) throw new Error(gatewayKeyShapeMessage);
  return { key, kind: "set_gateway_key" };
}

/** The human-readable name of a control, used only for its progress notice. */
export const settingsCommandLabels: Readonly<Record<string, string>> = Object.freeze({
  archive_session: "Unarchive",
  set_approval_mode: "Approval mode",
  set_default_preset: "Default preset",
  set_gateway_key: "Gateway key",
  set_show_thinking: "Show thinking",
});

export function settingsCommandLabel(kind: string): string {
  return settingsCommandLabels[kind] ?? "Setting";
}
