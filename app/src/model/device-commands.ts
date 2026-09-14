import {
  activeRemotePresetSelection,
  deviceCommandLoginResultLifetimeMs,
  deviceCommandLimits,
  parseDeviceCommandPayload,
  type DeviceCommandPayload,
  type DeviceCommandResultPayload,
  type SupportedPreset,
  type NotificationHoursUpdate,
} from "../oompa/cloud";
import type { MachineView } from "./settings-view";

/**
 * Builders for the four device commands, plus the small derivations the grid
 * composer and the settings linking flow need.
 *
 * Every builder runs its output through the daemon's own parser, so a builder
 * that adds or drops a field fails here rather than at the machine.
 */

export type PresetChoice = SupportedPreset;

/** The stable Codex Ultra alias; the target daemon owns its exact active binding. */
export const defaultSessionStartPreset: PresetChoice = "ultra";

export type SessionStartProvider = "codex" | "claude";

export const defaultSessionStartPresetForProvider = (
  provider: SessionStartProvider,
): PresetChoice => provider === "claude" ? "fable-max" : "ultra";

/**
 * One machine a browser can start a session on, with the account, preset and
 * project already chosen. The reader picks a machine and nothing else: the
 * best account the machine holds is the machine's first signed-in Codex
 * account, else its first signed-in Claude Code account, and the preset is
 * that provider's best. The project is the machine's default, else its first.
 */
export type SessionStartTarget = Readonly<{
  accountLabel: string;
  accountPublicId: string;
  machineLabel: string;
  machineOnline: boolean;
  preset: PresetChoice;
  projectPublicId: string;
  provider: SessionStartProvider;
  targetDevicePublicId: string;
}>;

/** The picker names the machine; the provider says what the start will run. */
export function sessionStartTargetLabel(target: SessionStartTarget): string {
  const provider = target.provider === "claude" ? "Claude Code" : "Codex";
  const availability = target.machineOnline ? "" : " (offline)";
  return `${target.machineLabel} — ${provider}${availability}`;
}

/** The composer repeats the choice after selection, before any remote provider effect. */
export function sessionStartTargetHint(target: SessionStartTarget): string {
  const availability = target.machineOnline
    ? ""
    : " (offline; it will run when the machine wakes)";
  const model = target.provider === "claude" ? "Fable Max" : target.preset === "high" ? "Codex High" : "Codex Ultra";
  const platform = target.provider === "claude"
    ? " Claude sessions require a Linux custodian; macOS refuses before launch."
    : "";
  return `Starts on ${target.machineLabel}${availability} as ${target.accountLabel} on ${model}.${platform}`;
}

function build(payload: DeviceCommandPayload): DeviceCommandPayload {
  const parsed = parseDeviceCommandPayload(payload);
  if (parsed === null) throw new Error("The device command payload is not valid.");
  return parsed;
}

export function sessionStartCommand(input: Readonly<{
  accountPublicId: string;
  preset: PresetChoice;
  projectPublicId: string;
  prompt: string;
  provider: SessionStartProvider;
}>): DeviceCommandPayload {
  const prompt = input.prompt.trim();
  if (prompt.length === 0) throw new Error("A new session needs a prompt.");
  if (prompt.length > deviceCommandLimits.promptCharacters) {
    throw new Error("That prompt is too long to start a session with.");
  }
  return build({
    accountPublicId: input.accountPublicId,
    kind: "session_start",
    ...activeRemotePresetSelection(input.preset),
    projectPublicId: input.projectPublicId,
    prompt,
    provider: input.provider,
  });
}

export function accountLoginStartCommand(accountPublicId: string): DeviceCommandPayload {
  return build({ accountPublicId, handoffVersion: 2, kind: "account_login_start" });
}

export function accountLoginStatusCommand(accountPublicId: string): DeviceCommandPayload {
  return build({ accountPublicId, kind: "account_login_status" });
}

export type AccountLoginActionKind = "account_login_start" | "account_login_status";

export type AccountLoginActionState =
  | Readonly<{ phase: "idle" }>
  | Readonly<{ kind: AccountLoginActionKind; phase: "submitting" }>
  | Readonly<{ commandPublicId: string; phase: "awaiting_login_handoff" }>;

export const initialAccountLoginActionState: AccountLoginActionState = { phase: "idle" };

/**
 * Claims the account row before enqueueing. This synchronous state is also held
 * in a ref by the screen, so two clicks from the same React render cannot both
 * reach the hosted mutation.
 */
export function beginAccountLoginAction(
  state: AccountLoginActionState,
  kind: AccountLoginActionKind,
): AccountLoginActionState | null {
  return state.phase === "idle" ? { kind, phase: "submitting" } : null;
}

/**
 * A status read may yield after enqueueing, but a login start keeps custody of
 * the row until its single-use handoff has been consumed or has expired.
 */
export function completeAccountLoginSubmission(
  state: AccountLoginActionState,
  commandPublicId: string,
): AccountLoginActionState {
  if (state.phase !== "submitting") return state;
  return state.kind === "account_login_start"
    ? { commandPublicId, phase: "awaiting_login_handoff" }
    : initialAccountLoginActionState;
}

/** Release only the exact login-start handoff that currently owns the row. */
export function finishAccountLoginHandoff(
  state: AccountLoginActionState,
  commandPublicId: string,
): AccountLoginActionState {
  return state.phase === "awaiting_login_handoff"
    && state.commandPublicId === commandPublicId
    ? initialAccountLoginActionState
    : state;
}

/**
 * Replaces the daemon-clock expiry with the hosted settlement deadline.
 * Convex owns this timestamp so machine and browser clock skew cannot hide a
 * freshly released code or extend its five-minute readable window.
 */
export function bindHostedLoginResultExpiry(
  result: DeviceCommandResultPayload,
  expiresAt: unknown,
  fallbackExpiresAt?: unknown,
): DeviceCommandResultPayload | null {
  const effectiveExpiresAt = Number.isSafeInteger(expiresAt) && (expiresAt as number) > 0
    ? expiresAt
    : fallbackExpiresAt;
  if (
    result.kind !== "account_login_start"
    || !Number.isSafeInteger(effectiveExpiresAt)
    || (effectiveExpiresAt as number) <= 0
  ) return null;
  return { ...result, expiresAt: effectiveExpiresAt as number };
}

/** Server-owned deadline derivable from the public command settlement row. */
export function hostedLoginHandoffDeadline(settledAt: unknown): number | null {
  if (!Number.isSafeInteger(settledAt) || (settledAt as number) < 0) return null;
  const deadline = (settledAt as number) + deviceCommandLoginResultLifetimeMs;
  return Number.isSafeInteger(deadline) ? deadline : null;
}

export type HostedLoginHandoffAdmission =
  | Readonly<{ status: "awaiting_server_clock" }>
  | Readonly<{ status: "expired_or_invalid" }>
  | Readonly<{ expiresAt: number; status: "ready" }>;

/**
 * Admit a single-use result only after the browser clock is server-anchored.
 * An ahead local clock must not permanently consume or dismiss a fresh code
 * during the render before `presence:current` establishes its offset.
 */
export function admitHostedLoginHandoff(input: Readonly<{
  now: number;
  serverClockReady: boolean;
  settledAt: unknown;
}>): HostedLoginHandoffAdmission {
  if (!input.serverClockReady) return { status: "awaiting_server_clock" };
  const expiresAt = hostedLoginHandoffDeadline(input.settledAt);
  return expiresAt === null || expiresAt <= input.now
    ? { status: "expired_or_invalid" }
    : { expiresAt, status: "ready" };
}

export function usageRefreshCommand(): DeviceCommandPayload {
  return build({ kind: "usage_refresh" });
}

/** Strictly parses the browser's `HH:MM` value without normalizing bad fields. */
export function parseNotificationClockMinute(value: string): number | null {
  const match = /^(\d{2}):(\d{2})$/u.exec(value);
  if (match === null) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59
    ? hour * 60 + minute
    : null;
}

/** Machine-local policy revision, deliberately never a registry row revision. */
export function notificationHoursCommand(input: NotificationHoursUpdate & Readonly<{
  expectedRevision: number;
}>): DeviceCommandPayload {
  return build({ ...input, kind: "set_notification_hours" });
}

/**
 * Every machine a browser could start a session on. A machine with no signed
 * in Codex or Claude account, no project, or its kill switch set stays out:
 * the picker never offers a target the daemon would refuse. Codex is preferred
 * over Claude when a machine holds both, and accounts keep the registry's own
 * order within a provider.
 */
export function sessionStartTargets(
  machines: readonly MachineView[],
): readonly SessionStartTarget[] {
  const targets: SessionStartTarget[] = [];
  for (const machine of machines) {
    if (machine.deviceStatus !== "active") continue;
    if (!machine.deviceCommandsAllowed) continue;
    const project = machine.projects.find((entry) =>
      entry.publicId === machine.defaultProjectPublicId) ?? machine.projects[0];
    if (project === undefined) continue;
    const signedIn = machine.accounts.filter((account) => account.status === "signed_in");
    const account = signedIn.find((entry) => entry.provider === "codex")
      ?? signedIn.find((entry) => entry.provider === "claude");
    if (account === undefined || (account.provider !== "codex" && account.provider !== "claude")) {
      continue;
    }
    targets.push({
      accountLabel: account.label,
      accountPublicId: account.publicId,
      machineLabel: machine.label,
      machineOnline: machine.online,
      preset: defaultSessionStartPresetForProvider(account.provider),
      projectPublicId: project.publicId,
      provider: account.provider,
      targetDevicePublicId: machine.devicePublicId,
    });
  }
  // A machine that has not heartbeated recently is still offered, but last:
  // its commands queue until it wakes rather than failing.
  return targets.sort((left, right) => {
    if (left.machineOnline !== right.machineOnline) return left.machineOnline ? -1 : 1;
    return left.machineLabel.localeCompare(right.machineLabel);
  });
}

export type DeviceCommandNotice = Readonly<{ tone: "error" | "pending" | "settled"; text: string }>;

const refusalNotices: Readonly<Record<string, string>> = {
  ACCOUNT_LINKING_DENIED:
    "Account linking from the browser is off on that machine. Run `oompa remote allow account-linking` there first.",
  ACCOUNT_LOGIN_RELAY_UNAVAILABLE:
    "That machine could not relay a login link. Run `oompa account login <account>` on the machine instead.",
  ACCOUNT_LOGIN_NOT_AVAILABLE:
    "A new login can start only while that account is signed out on the machine.",
  DEVICE_COMMANDS_DENIED:
    "That machine is not accepting commands from other devices. Run `oompa remote allow device-commands` there.",
  DEVICE_COMMAND_ACCOUNT_SIGNED_OUT: "That account is signed out on the machine.",
  DEVICE_COMMAND_ACCOUNT_UNKNOWN: "That machine no longer has that account.",
  DEVICE_COMMAND_DAILY_CAP: "This device has reached its daily limit on that machine.",
  DEVICE_COMMAND_PROJECT_UNKNOWN: "That machine no longer has that project.",
  DEVICE_COMMAND_PROVIDER_UNSUPPORTED: "That account is not the provider this request named.",
  REQUESTING_DEVICE_INACTIVE: "This device is no longer active on the account.",
  LOCAL_NOTIFICATION_HOURS_REVISION_CONFLICT:
    "Notification hours changed on the machine. Refresh and try again.",
  LOCAL_NOTIFICATION_HOURS_REVISION_EXHAUSTED:
    "Notification hours reached their local revision limit and cannot be updated.",
};

/**
 * The one line the UI shows for a device command's current state. An ambiguous
 * outcome is deliberately never phrased as a failure: the effect may have
 * happened, and the honest instruction is to look rather than to retry.
 */
export function deviceCommandNotice(command: Readonly<{
  kind: string;
  resultCode: string | null;
  state: string;
}> | null): DeviceCommandNotice | null {
  if (command === null) return null;
  switch (command.state) {
    case "pending":
      return { text: "Waiting for the machine to pick this up…", tone: "pending" };
    case "prepared":
    case "effect_started":
      return { text: "Running on the machine…", tone: "pending" };
    case "applied":
      if (command.kind === "account_login_start") return { text: "Login started.", tone: "settled" };
      if (command.kind === "account_login_status") return { text: "Status checked.", tone: "settled" };
      return command.kind === "session_start"
        ? { text: "Started. The new session appears here shortly.", tone: "settled" }
        : { text: "Done.", tone: "settled" };
    case "ambiguous":
      return {
        text: command.kind === "session_start"
          ? "The machine could not confirm whether the session started. Check the grid before trying again."
          : "The machine could not confirm the outcome. Check the machine before trying again.",
        tone: "error",
      };
    case "expired":
      return { text: "The machine never picked this up.", tone: "error" };
    case "cancelled":
      return { text: "Cancelled.", tone: "error" };
    case "failed":
      return {
        text: (command.resultCode === null ? undefined : refusalNotices[command.resultCode])
          ?? "The machine refused this request.",
        tone: "error",
      };
    default:
      return null;
  }
}
