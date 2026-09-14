import { describe, expect, test } from "bun:test";

import { activeRemotePresetSelection, parseRemoteCommandPayload } from "../oompa/cloud";
import {
  approvalModeCommand,
  approvalModeLabels,
  approvalModes,
  defaultPresetCommand,
  gatewayKeyCommand,
  gatewayKeyMaximumLength,
  gatewayKeyMinimumLength,
  isGatewayKeyShape,
  presetChoices,
  presetLabels,
  sessionFastCommand,
  sessionFastCommandNotice,
  sessionPresetCommand,
  settingsCommandLabel,
  showThinkingCommand,
  unarchiveSessionCommand,
} from "./settings-commands";

/*
 * The daemon's own parser is the oracle. Every builder has to survive
 * `parseRemoteCommandPayload`, which enforces the exact key set of each command
 * kind, so a builder that adds or drops a field fails here rather than at the
 * machine. It is reached through the `app/src/oompa/` seam like every other
 * repository import in this app.
 */
function accepted(payload: unknown): unknown {
  const parsed = parseRemoteCommandPayload(payload);
  expect(parsed).not.toBeNull();
  return parsed;
}

describe("machine default builders", () => {
  test("approval mode is daemon scoped and round trips for every mode", () => {
    for (const mode of approvalModes) {
      const payload = approvalModeCommand(mode);
      expect(payload).toEqual({ kind: "set_approval_mode", mode, scope: "default" });
      expect(accepted(payload)).toEqual(payload);
      expect(approvalModeLabels[mode].length).toBeGreaterThan(0);
    }
  });

  test("show thinking is daemon scoped in both directions", () => {
    for (const enabled of [true, false]) {
      const payload = showThinkingCommand(enabled);
      expect(payload).toEqual({ enabled, kind: "set_show_thinking", scope: "default" });
      expect(accepted(payload)).toEqual(payload);
    }
  });

  test("default preset carries no scope and round trips for every preset", () => {
    for (const preset of presetChoices) {
      const payload = defaultPresetCommand(preset);
      expect(payload).toEqual({ kind: "set_default_preset", ...activeRemotePresetSelection(preset) });
      expect(accepted(payload)).toEqual(payload);
      expect(presetLabels[preset].length).toBeGreaterThan(0);
    }
    expect(presetLabels.high).toBe("Codex High");
    expect(presetLabels.ultra).toBe("Codex Ultra");
    expect(presetLabels.astra).toBe("Devin Astra (retired)");
    expect(presetChoices).not.toContain("astra");
  });

  test("session preset changes bind the alias to this build's exact contract", () => {
    expect(sessionPresetCommand("high"))
      .toEqual({ kind: "set_model", preset: "high", presetContract: 2 });
    expect(sessionPresetCommand("ultra"))
      .toEqual({ kind: "set_model", preset: "ultra", presetContract: 2 });
    expect(accepted(sessionPresetCommand("ultra"))).toEqual(sessionPresetCommand("ultra"));
  });

  test("Fast is an explicit session command in both directions", () => {
    for (const enabled of [true, false]) {
      const payload = sessionFastCommand(enabled);
      expect(payload).toEqual({ enabled, kind: "set_fast" });
      expect(accepted(payload)).toEqual(payload);
    }
  });

  test("Fast state is highlighted only after the exact command is applied", () => {
    const record = (state: string, resultCode: string | null = null) => ({
      resultCode,
      state,
    });

    expect(sessionFastCommandNotice(null, true)).toBeNull();
    expect(sessionFastCommandNotice(record("pending"), null)).toBeNull();
    expect(sessionFastCommandNotice(record("pending"), true)).toEqual({
      applied: false,
      text: "Waiting for the machine to set Fast on.",
    });
    expect(sessionFastCommandNotice(record("effect_started"), false)).toEqual({
      applied: false,
      text: "Setting Fast off for future turns.",
    });
    expect(sessionFastCommandNotice(record("applied"), true)).toEqual({
      applied: true,
      text: "The machine applied Fast on for future turns.",
    });
  });

  test("Fast failures and ambiguous outcomes never claim a selected value", () => {
    const failed = sessionFastCommandNotice({ resultCode: "provider_unavailable", state: "failed" }, true);
    expect(failed).toEqual({
      applied: false,
      text: "The machine refused the Fast change: provider_unavailable.",
    });
    expect(sessionFastCommandNotice({ resultCode: null, state: "ambiguous" }, false))
      .toEqual({
        applied: false,
        text: "The machine could not confirm the Fast change. Check the session before trying again.",
      });
    expect(sessionFastCommandNotice({ resultCode: null, state: "expired" }, true)?.applied)
      .toBe(false);
    expect(sessionFastCommandNotice({ resultCode: null, state: "cancelled" }, true)?.applied)
      .toBe(false);
    expect(sessionFastCommandNotice({ resultCode: null, state: "future_state" }, true)?.applied)
      .toBe(false);
  });

  test("remote Codex labels do not claim a binding registry v1 cannot prove", () => {
    expect(presetLabels).toEqual({
      "fable-max": "Fable Max",
      astra: "Devin Astra (retired)",
      high: "Codex High",
      low: "Luna Max",
      ultra: "Codex Ultra",
    });
    expect(`${presetLabels.high} ${presetLabels.ultra}`).not.toMatch(/Sol|Astra/u);
  });

  test("unarchive is the session scoped archive command with archived false", () => {
    const payload = unarchiveSessionCommand();
    expect(payload).toEqual({ archived: false, kind: "archive_session" });
    expect(accepted(payload)).toEqual(payload);
  });
});

describe("gateway key shape", () => {
  const shortest = "a".repeat(gatewayKeyMinimumLength);
  const longest = "a".repeat(gatewayKeyMaximumLength);

  test("accepts printable non-space values at both bounds", () => {
    expect(isGatewayKeyShape(shortest)).toBe(true);
    expect(isGatewayKeyShape(longest)).toBe(true);
    expect(isGatewayKeyShape("gateway.value-1234")).toBe(true);
  });

  test("refuses a value that is too short, too long, spaced, or non printable", () => {
    expect(isGatewayKeyShape("a".repeat(gatewayKeyMinimumLength - 1))).toBe(false);
    expect(isGatewayKeyShape("a".repeat(gatewayKeyMaximumLength + 1))).toBe(false);
    expect(isGatewayKeyShape("value with space")).toBe(false);
    expect(isGatewayKeyShape("value\tvalue")).toBe(false);
    expect(isGatewayKeyShape("value\nvalue")).toBe(false);
    expect(isGatewayKeyShape("")).toBe(false);
  });

  test("the builder produces exactly the two admitted keys", () => {
    const payload = gatewayKeyCommand(shortest);
    expect(Object.keys(payload).sort()).toEqual(["key", "kind"]);
    expect(accepted(payload)).toEqual(payload);
  });

  test("the builder refuses a value the daemon would refuse", () => {
    expect(() => gatewayKeyCommand("short")).toThrow();
    expect(() => gatewayKeyCommand("value with space")).toThrow();
  });

  test("the browser check agrees with the daemon parser on every sample", () => {
    const samples = [
      shortest,
      longest,
      "gateway.value-1234",
      "short",
      "value with space",
      "",
    ];
    for (const sample of samples) {
      const accepts = parseRemoteCommandPayload({ key: sample, kind: "set_gateway_key" }) !== null;
      expect(isGatewayKeyShape(sample)).toBe(accepts);
    }
  });
});

describe("settingsCommandLabel", () => {
  test("names every kind this screen submits", () => {
    expect(settingsCommandLabel("set_approval_mode")).toBe("Approval mode");
    expect(settingsCommandLabel("set_show_thinking")).toBe("Show thinking");
    expect(settingsCommandLabel("set_default_preset")).toBe("Default preset");
    expect(settingsCommandLabel("set_gateway_key")).toBe("Gateway key");
    expect(settingsCommandLabel("archive_session")).toBe("Unarchive");
  });

  test("falls back rather than throwing on an unknown kind", () => {
    expect(settingsCommandLabel("send")).toBe("Setting");
  });
});
