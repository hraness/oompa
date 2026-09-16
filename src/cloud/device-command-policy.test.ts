import { describe, expect, test } from "bun:test";

import {
  DEVICE_COMMAND_DAILY_CAP,
  DEVICE_COMMAND_DAY_MS,
  deviceCommandDayKey,
  deviceCommandGuardDecision,
  type DeviceCommandGuardInput,
} from "./device-command-policy";
import { parseDeviceCommandPayload, type DeviceCommandPayload } from "./payloads";

const now = 1_760_000_000_000;

function payload(value: unknown): DeviceCommandPayload {
  const parsed = parseDeviceCommandPayload(value);
  if (parsed === null) throw new Error("fixture payload is not a device command");
  return parsed;
}

const sessionStart = {
  accountPublicId: "account_primary",
  kind: "session_start",
  preset: "ultra",
  presetContract: 1,
  projectPublicId: "project_alpha",
  prompt: "continue the migration",
  provider: "codex",
} as const satisfies DeviceCommandPayload;

function input(overrides: Partial<DeviceCommandGuardInput> = {}): DeviceCommandGuardInput {
  return {
    accountLinkingAllowed: false,
    accounts: [{ provider: "codex", publicId: "account_primary", status: "signed_in" }],
    deviceCommandsAllowed: true,
    ledger: { dayCount: 0, dayKey: deviceCommandDayKey(now), firstSessionStartNotifiedAt: null },
    now,
    payload: sessionStart,
    projectPublicIds: ["project_alpha"],
    requestingDeviceActive: true,
    ...overrides,
  };
}

describe("device command guards", () => {
  test("admits a well-addressed session start and notifies on the first one", () => {
    expect(deviceCommandGuardDecision(input())).toEqual({
      dayCount: 1,
      dayKey: deviceCommandDayKey(now),
      kind: "admitted",
      notifyFirstSessionStart: true,
    });
  });

  test("admits a Devin Astra start only for the matching signed-in Devin account", () => {
    const devinStart = payload({
      accountPublicId: sessionStart.accountPublicId,
      kind: sessionStart.kind,
      preset: "astra",
      projectPublicId: sessionStart.projectPublicId,
      prompt: sessionStart.prompt,
      provider: "devin",
    });
    expect(deviceCommandGuardDecision(input({
      accounts: [{ provider: "devin", publicId: "account_primary", status: "signed_in" }],
      payload: devinStart,
    }))).toMatchObject({ kind: "admitted", notifyFirstSessionStart: true });
    expect(deviceCommandGuardDecision(input({
      accounts: [{ provider: "codex", publicId: "account_primary", status: "signed_in" }],
      payload: devinStart,
    }))).toEqual({ code: "DEVICE_COMMAND_PROVIDER_UNSUPPORTED", kind: "refused" });
  });

  test("notifies exactly once per device", () => {
    const decision = deviceCommandGuardDecision(input({
      ledger: {
        dayCount: 3,
        dayKey: deviceCommandDayKey(now),
        firstSessionStartNotifiedAt: now - 1_000,
      },
    }));
    expect(decision).toMatchObject({ dayCount: 4, notifyFirstSessionStart: false });
  });

  test("only session_start notifies", () => {
    expect(deviceCommandGuardDecision(input({
      payload: payload({ kind: "usage_refresh" }),
    }))).toMatchObject({ notifyFirstSessionStart: false });
  });

  test("admits notification-hour updates through the same local cap without account or session authority", () => {
    const hours = payload({
      endMinute: 1_320,
      expectedRevision: 4,
      kind: "set_notification_hours",
      startMinute: 600,
      timeZone: "America/Puerto_Rico",
      version: 1,
    });
    expect(deviceCommandGuardDecision(input({ accounts: [], payload: hours, projectPublicIds: [] })))
      .toMatchObject({ kind: "admitted", notifyFirstSessionStart: false });
    expect(deviceCommandGuardDecision(input({ deviceCommandsAllowed: false, payload: hours })))
      .toEqual({ code: "DEVICE_COMMANDS_DENIED", kind: "refused" });
  });

  test("the kill switch refuses every kind with DEVICE_COMMANDS_DENIED", () => {
    for (const kind of [sessionStart, payload({ kind: "usage_refresh" })]) {
      expect(deviceCommandGuardDecision(input({
        deviceCommandsAllowed: false,
        payload: kind,
      }))).toEqual({ code: "DEVICE_COMMANDS_DENIED", kind: "refused" });
    }
  });

  test("a revoked requester is refused with REQUESTING_DEVICE_INACTIVE", () => {
    expect(deviceCommandGuardDecision(input({ requestingDeviceActive: false })))
      .toEqual({ code: "REQUESTING_DEVICE_INACTIVE", kind: "refused" });
  });

  test("account linking needs the local opt-in, for start and for status", () => {
    expect(deviceCommandGuardDecision(input({
      payload: payload({ accountPublicId: "account_primary", kind: "account_login_start" }),
    }))).toEqual({ code: "ACCOUNT_LINKING_DENIED", kind: "refused" });
    expect(deviceCommandGuardDecision(input({
      payload: payload({ kind: "account_login_status" }),
    }))).toEqual({ code: "ACCOUNT_LINKING_DENIED", kind: "refused" });
    expect(deviceCommandGuardDecision(input({
      accountLinkingAllowed: true,
      accounts: [{ provider: "codex", publicId: "account_primary", status: "signed_out" }],
      payload: payload({ accountPublicId: "account_primary", kind: "account_login_start" }),
    })).kind).toBe("admitted");
    expect(deviceCommandGuardDecision(input({
      accountLinkingAllowed: true,
      payload: payload({
        accountPublicId: "account_primary",
        kind: "account_login_status",
      }),
    })).kind).toBe("admitted");
  });

  test("starts account linking only from the signed-out state", () => {
    for (const status of ["signed_in", "login_pending", "recovery_required"] as const) {
      expect(deviceCommandGuardDecision(input({
        accountLinkingAllowed: true,
        accounts: [{ provider: "codex", publicId: "account_primary", status }],
        payload: payload({ accountPublicId: "account_primary", kind: "account_login_start" }),
      }))).toEqual({ code: "ACCOUNT_LOGIN_NOT_AVAILABLE", kind: "refused" });
    }
  });

  test("addressing is checked against the projected registry", () => {
    expect(deviceCommandGuardDecision(input({ accounts: [] })))
      .toEqual({ code: "DEVICE_COMMAND_ACCOUNT_UNKNOWN", kind: "refused" });
    expect(deviceCommandGuardDecision(input({ projectPublicIds: [] })))
      .toEqual({ code: "DEVICE_COMMAND_PROJECT_UNKNOWN", kind: "refused" });
    expect(deviceCommandGuardDecision(input({
      accounts: [{ provider: "codex", publicId: "account_primary", status: "signed_out" }],
    }))).toEqual({ code: "DEVICE_COMMAND_ACCOUNT_SIGNED_OUT", kind: "refused" });
    expect(deviceCommandGuardDecision(input({
      accounts: [{ provider: "claude", publicId: "account_primary", status: "signed_in" }],
    }))).toEqual({ code: "DEVICE_COMMAND_PROVIDER_UNSUPPORTED", kind: "refused" });
    for (const provider of ["claude", "devin"] as const) {
      expect(deviceCommandGuardDecision(input({
        accountLinkingAllowed: true,
        accounts: [{ provider, publicId: "account_primary", status: "signed_out" }],
        payload: payload({ accountPublicId: "account_primary", kind: "account_login_start" }),
      }))).toEqual({ code: "DEVICE_COMMAND_PROVIDER_UNSUPPORTED", kind: "refused" });
      expect(deviceCommandGuardDecision(input({
        accountLinkingAllowed: true,
        accounts: [{ provider, publicId: "account_primary", status: "signed_out" }],
        payload: payload({
          accountPublicId: "account_primary",
          kind: "account_login_status",
        }),
      }))).toEqual({ code: "DEVICE_COMMAND_PROVIDER_UNSUPPORTED", kind: "refused" });
    }
    expect(deviceCommandGuardDecision(input({
      accountLinkingAllowed: true,
      payload: payload({
        accountPublicId: "account_missing",
        kind: "account_login_status",
      }),
    }))).toEqual({ code: "DEVICE_COMMAND_ACCOUNT_UNKNOWN", kind: "refused" });
  });

  test("the per-day cap refuses at the ceiling and resets on a new day", () => {
    const today = deviceCommandDayKey(now);
    expect(deviceCommandGuardDecision(input({
      ledger: { dayCount: DEVICE_COMMAND_DAILY_CAP, dayKey: today, firstSessionStartNotifiedAt: 1 },
    }))).toEqual({ code: "DEVICE_COMMAND_DAILY_CAP", kind: "refused" });
    expect(deviceCommandGuardDecision(input({
      ledger: {
        dayCount: DEVICE_COMMAND_DAILY_CAP,
        dayKey: today - 1,
        firstSessionStartNotifiedAt: 1,
      },
    }))).toMatchObject({ dayCount: 1, dayKey: today, kind: "admitted" });
    expect(deviceCommandDayKey(now + DEVICE_COMMAND_DAY_MS)).toBe(today + 1);
  });

  test("a refused request never consumes the day's budget", () => {
    const today = deviceCommandDayKey(now);
    const refused = deviceCommandGuardDecision(input({
      deviceCommandsAllowed: false,
      ledger: { dayCount: 0, dayKey: today, firstSessionStartNotifiedAt: null },
    }));
    expect(refused).toEqual({ code: "DEVICE_COMMANDS_DENIED", kind: "refused" });
    expect("dayCount" in refused).toBe(false);
  });
});
