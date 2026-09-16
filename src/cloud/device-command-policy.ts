import type { DeviceCommandPayload } from "./payloads";
import type { Provider } from "../domain/presets";

/*
 * The guards that stand between a browser and this machine. Every one of them
 * is local: the switches are set with `oompa remote allow|deny`, the cap is
 * counted in the local store, and none of them can be changed from the hosted
 * deployment. Each refusal has its own closed code so an operator can tell
 * "you turned this off" apart from "you have run out for today".
 */

export const DEVICE_COMMAND_REFUSAL_CODES = [
  "DEVICE_COMMANDS_DENIED",
  "DEVICE_COMMAND_DAILY_CAP",
  "ACCOUNT_LINKING_DENIED",
  "ACCOUNT_LOGIN_NOT_AVAILABLE",
  "DEVICE_COMMAND_ACCOUNT_UNKNOWN",
  "DEVICE_COMMAND_PROJECT_UNKNOWN",
  "DEVICE_COMMAND_ACCOUNT_SIGNED_OUT",
  "DEVICE_COMMAND_PROVIDER_UNSUPPORTED",
  "ACCOUNT_LOGIN_RELAY_UNAVAILABLE",
  "REQUESTING_DEVICE_INACTIVE",
] as const;

export type DeviceCommandRefusalCode = (typeof DEVICE_COMMAND_REFUSAL_CODES)[number];

/** One local day. The cap is a burst guard, not a billing period. */
export const DEVICE_COMMAND_DAY_MS = 24 * 60 * 60 * 1_000;

/**
 * How many device commands one requesting device may have admitted in a day.
 * A person driving the grid from a phone sends a handful; anything at this
 * scale is a loop, and a loop that starts sessions is the expensive one.
 */
export const DEVICE_COMMAND_DAILY_CAP = 100;

export function deviceCommandDayKey(now: number): number {
  return Math.floor(now / DEVICE_COMMAND_DAY_MS);
}

export type DeviceCommandRegistryAccount = Readonly<{
  provider: Provider;
  publicId: string;
  status: "login_pending" | "recovery_required" | "signed_in" | "signed_out";
}>;

export type DeviceCommandGuardInput = Readonly<{
  accountLinkingAllowed: boolean;
  accounts: readonly DeviceCommandRegistryAccount[];
  dailyCap?: number;
  deviceCommandsAllowed: boolean;
  ledger: Readonly<{
    dayCount: number;
    dayKey: number;
    firstSessionStartNotifiedAt: number | null;
  }>;
  now: number;
  payload: DeviceCommandPayload;
  projectPublicIds: readonly string[];
  requestingDeviceActive: boolean;
}>;

export type DeviceCommandGuardDecision =
  | Readonly<{
      dayCount: number;
      dayKey: number;
      kind: "admitted";
      /** True exactly once per requesting device, on its first `session_start`. */
      notifyFirstSessionStart: boolean;
    }>
  | Readonly<{ code: DeviceCommandRefusalCode; kind: "refused" }>;

/**
 * Pure admission for one device command.
 *
 * Order matters and is deliberate: the kill switch first (a denied machine
 * never even reports which accounts it has), then the requester, then the
 * per-kind opt-in, then addressing, then the cap. The cap is checked last so a
 * malformed or unauthorised request never consumes the day's budget.
 */
export function deviceCommandGuardDecision(
  input: DeviceCommandGuardInput,
): DeviceCommandGuardDecision {
  const refused = (code: DeviceCommandRefusalCode): DeviceCommandGuardDecision =>
    ({ code, kind: "refused" });

  if (!input.deviceCommandsAllowed) return refused("DEVICE_COMMANDS_DENIED");
  if (!input.requestingDeviceActive) return refused("REQUESTING_DEVICE_INACTIVE");

  const payload = input.payload;
  if (
    (payload.kind === "account_login_start" || payload.kind === "account_login_status")
    && !input.accountLinkingAllowed
  ) return refused("ACCOUNT_LINKING_DENIED");

  if (
    payload.kind === "session_start"
    || payload.kind === "account_login_start"
    || (payload.kind === "account_login_status" && "accountPublicId" in payload)
  ) {
    const account = input.accounts.find((entry) => entry.publicId === payload.accountPublicId);
    if (account === undefined) return refused("DEVICE_COMMAND_ACCOUNT_UNKNOWN");
    if (
      (payload.kind === "account_login_start" || payload.kind === "account_login_status")
      && account.provider !== "codex"
    ) return refused("DEVICE_COMMAND_PROVIDER_UNSUPPORTED");
    if (payload.kind === "account_login_start" && account.status !== "signed_out") {
      return refused("ACCOUNT_LOGIN_NOT_AVAILABLE");
    }
    if (payload.kind === "session_start") {
      // The projected provider is what the browser saw; a mismatch means the
      // picker addressed an account that is not the one it thought it was.
      if (account.provider !== payload.provider) {
        return refused("DEVICE_COMMAND_PROVIDER_UNSUPPORTED");
      }
      if (account.status !== "signed_in") return refused("DEVICE_COMMAND_ACCOUNT_SIGNED_OUT");
      if (!input.projectPublicIds.includes(payload.projectPublicId)) {
        return refused("DEVICE_COMMAND_PROJECT_UNKNOWN");
      }
    }
  }

  const dayKey = deviceCommandDayKey(input.now);
  const dayCount = input.ledger.dayKey === dayKey ? input.ledger.dayCount : 0;
  const cap = input.dailyCap ?? DEVICE_COMMAND_DAILY_CAP;
  if (dayCount >= cap) return refused("DEVICE_COMMAND_DAILY_CAP");

  return {
    dayCount: dayCount + 1,
    dayKey,
    kind: "admitted",
    notifyFirstSessionStart: payload.kind === "session_start"
      && input.ledger.firstSessionStartNotifiedAt === null,
  };
}
