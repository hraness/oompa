import { describe, expect, test } from "bun:test";

import { decryptBytes, encryptBytes, randomKeyBytes } from "./crypto";
import {
  cloudPayloadAad,
  activeRemoteDerivedCodexSelection,
  activeRemotePresetSelection,
  decryptDeviceCommand,
  decryptDeviceCommandResult,
  decryptDeviceRegistry,
  decryptMemorySummary,
  decryptNotificationEmail,
  decryptNotificationHours,
  decryptUsageProjection,
  decryptRemoteCommand,
  deviceCommandLimits,
  encryptDeviceCommand,
  encryptDeviceCommandResult,
  encryptDeviceRegistry,
  encryptMemorySummary,
  encryptNotificationEmail,
  encryptNotificationHours,
  encryptUsageProjection,
  encryptRemoteCommand,
  isRelayedLoginUserCode,
  isRelayedLoginUrl,
  memorySummaryFitsEncryptedEnvelope,
  parseDeviceCommandPayload,
  parseDeviceCommandResultPayload,
  parseDeviceRegistryPayload,
  parseMemorySummaryPayload,
  parseRemoteCommandPayload,
  parseSessionMetadataPayload,
  type DeviceRegistryPayload,
} from "./payloads";
import {
  USAGE_CLOUD_ENVELOPE_MAX_CIPHERTEXT_CHARACTERS,
  USAGE_CLOUD_PROJECTION_MAX_LIMITS,
} from "./usage";
import { expectPromiseToReject } from "./testAssertions";

describe("closed encrypted payloads", () => {
  test("encrypts the exact maximum usage projection at the closed envelope boundary", async () => {
    const window = {
      resetsAt: Number.MAX_VALUE,
      usedPercent: 2.2250738585072014e-308,
      windowDurationMinutes: 365 * 24 * 60,
    } as const;
    const projection = {
      data: {
        currentStreakDays: Number.MAX_SAFE_INTEGER,
        daily: [{ startDate: "9999-99-99", tokens: Number.MAX_SAFE_INTEGER }],
        lifetimeTokens: Number.MAX_SAFE_INTEGER,
        limits: Array.from({ length: USAGE_CLOUD_PROJECTION_MAX_LIMITS }, (_, index) => ({
          id: `${index}${"x".repeat(95)}`,
          individual: false,
          name: "\0".repeat(96),
          primary: window,
          reached: false,
          secondary: window,
          unlimited: false,
        })),
        longestRunningTurnSeconds: Number.MAX_SAFE_INTEGER,
        longestStreakDays: Number.MAX_SAFE_INTEGER,
        peakDailyTokens: Number.MAX_SAFE_INTEGER,
      },
      state: "ready",
    } as const;
    const key = randomKeyBytes();
    const authority = {
      entityPublicId: "account_12345678",
      keyVersion: 1,
      kind: "usage",
      userPublicId: "user_12345678",
    } as const;
    const envelope = await encryptUsageProjection(projection, key, authority);
    expect(envelope.ciphertext).toHaveLength(
      USAGE_CLOUD_ENVELOPE_MAX_CIPHERTEXT_CHARACTERS,
    );
    expect(await decryptUsageProjection(envelope, key, authority)).toEqual(projection);
  });

  test("admits every provider-specific preset in model and default-preset commands", () => {
    for (const preset of ["low", "high", "ultra", "fable-max"] as const) {
      const selection = activeRemotePresetSelection(preset);
      expect(parseRemoteCommandPayload({ kind: "set_model", ...selection }))
        .toEqual({ kind: "set_model", ...selection });
      expect(parseRemoteCommandPayload({ kind: "set_default_preset", ...selection }))
        .toEqual({ kind: "set_default_preset", ...selection });
    }
    expect(parseRemoteCommandPayload({ kind: "set_model", preset: "fable" })).toBeNull();
    expect(parseRemoteCommandPayload({ kind: "set_model", preset: "astra" })).toBeNull();
    expect(parseRemoteCommandPayload({ kind: "set_default_preset", preset: "astra" })).toBeNull();
    expect(parseRemoteCommandPayload({ kind: "set_model", preset: "ultra" })).toBeNull();
    expect(parseRemoteCommandPayload({
      kind: "set_model",
      preset: "ultra",
      presetContract: 1,
    })).toBeNull();
  });

  test("admits a provider switch with an optional preset and refuses anything else", () => {
    expect(parseRemoteCommandPayload({ kind: "set_provider", provider: "claude" }))
      .toEqual({ kind: "set_provider", provider: "claude" });
    const derivedCodex = activeRemoteDerivedCodexSelection();
    expect(derivedCodex).toEqual({ presetContract: 2, provider: "codex" });
    expect(parseRemoteCommandPayload({ kind: "set_provider", ...derivedCodex }))
      .toEqual({ kind: "set_provider", ...derivedCodex });
    expect(parseRemoteCommandPayload({ kind: "set_provider", provider: "codex" }))
      .toBeNull();
    expect(parseRemoteCommandPayload({
      kind: "set_provider",
      presetContract: 1,
      provider: "codex",
    })).toBeNull();
    expect(parseRemoteCommandPayload({
      kind: "set_provider",
      presetContract: 1,
      provider: "claude",
    })).toBeNull();
    expect(parseRemoteCommandPayload({
      kind: "set_provider",
      ...activeRemotePresetSelection("fable-max"),
      provider: "claude",
    })).toEqual({
      kind: "set_provider",
      preset: "fable-max",
      provider: "claude",
    });
    expect(parseRemoteCommandPayload({
      kind: "set_provider",
      ...activeRemotePresetSelection("high"),
      provider: "codex",
    })).toEqual({ kind: "set_provider", preset: "high", presetContract: 2, provider: "codex" });
    expect(parseRemoteCommandPayload({ kind: "set_provider", preset: "astra", provider: "devin" }))
      .toBeNull();
    expect(parseRemoteCommandPayload({ kind: "set_provider", provider: "devin" })).toBeNull();
    for (const mismatch of [
      { kind: "set_provider", preset: "astra", provider: "codex" },
      { kind: "set_provider", preset: "fable-max", provider: "devin" },
      { kind: "set_provider", preset: "ultra", presetContract: 1, provider: "claude" },
    ]) expect(parseRemoteCommandPayload(mismatch)).toBeNull();
    expect(parseRemoteCommandPayload({ kind: "set_provider", provider: "gemini" })).toBeNull();
    expect(parseRemoteCommandPayload({
      kind: "set_provider",
      preset: "high",
      provider: "codex",
    })).toBeNull();
    expect(parseRemoteCommandPayload({
      kind: "set_provider",
      preset: "high",
      presetContract: 1,
      provider: "codex",
    })).toBeNull();
    expect(parseRemoteCommandPayload({ kind: "set_provider", preset: "fable", provider: "claude" }))
      .toBeNull();
    // A remote caller never picks the account: account selection is
    // user-directed and stays on the custodian machine.
    expect(parseRemoteCommandPayload({ account: "work", kind: "set_provider", provider: "claude" }))
      .toBeNull();
    expect(parseRemoteCommandPayload({ kind: "set_provider" })).toBeNull();
  });

  test("rejects generic RPC and provider method smuggling", () => {
    const absoluteSecretPath = ["", "Users", "name", ".ssh"].join("/");
    expect(parseRemoteCommandPayload({ kind: "rpc", method: "danger" })).toBeNull();
    expect(parseRemoteCommandPayload({ kind: "send", message: "hello", method: "raw" }))
      .toBeNull();
    expect(parseRemoteCommandPayload({ kind: "set_model", preset: "unknown" })).toBeNull();
    expect(parseRemoteCommandPayload({ kind: "steer", message: `read ${absoluteSecretPath}` }))
      .toBeNull();
  });

  test("keeps exactly one bounded note and name", () => {
    expect(parseSessionMetadataPayload({ name: "Work", note: "Remember this" }))
      .toEqual({ name: "Work", note: "Remember this" });
    expect(parseSessionMetadataPayload({ name: "Work", note: "x", secondNote: "y" }))
      .toBeNull();
  });

  test("accepts only the closed historical retirement marker without dropping legacy metadata", () => {
    const retired = { archived: true, name: "Past work", note: null, retiredProvider: "devin" as const };
    expect(parseSessionMetadataPayload(retired)).toEqual(retired);
    expect(parseSessionMetadataPayload({ ...retired, retiredProvider: "codex" })).toBeNull();
    expect(parseSessionMetadataPayload({ ...retired, retiredProvider: true })).toBeNull();
    expect(parseSessionMetadataPayload({ name: "Past work", note: null }))
      .toEqual({ name: "Past work", note: null });
  });

  test("remote commands round trip only under their entity authority", async () => {
    const key = randomKeyBytes();
    const authority = {
      entityPublicId: "command_12345678",
      keyVersion: 1,
      kind: "command",
      userPublicId: "user_12345678",
    } as const;
    const existingPayload = { kind: "set_fast", enabled: true } as const;
    const existingEnvelope = await encryptRemoteCommand(existingPayload, key, authority);
    expect(await decryptRemoteCommand(existingEnvelope, key, authority)).toEqual(existingPayload);
    const devinPayload = { kind: "set_provider", preset: "astra", provider: "devin" } as const;
    // A valid envelope written by the former client must fail after decryption.
    const envelope = await encryptBytes(new TextEncoder().encode(JSON.stringify(devinPayload)), key, 1, cloudPayloadAad(authority));
    await expectPromiseToReject(decryptRemoteCommand(envelope, key, authority));
    await expectPromiseToReject(decryptRemoteCommand(envelope, key, {
      ...authority,
      entityPublicId: "command_87654321",
    }));
  });
});

describe("remote decision payloads", () => {
  const interactionId = "0192a3b4-c5d6-7e8f-8a9b-0c1d2e3f4a5b";

  test("accepts legacy decisions plus exact nonempty single-answer maps", () => {
    expect(parseRemoteCommandPayload({ kind: "resolve_interaction", interactionId, revision: 3, decision: "once" }))
      .toEqual({ decision: "once", interactionId, kind: "resolve_interaction", revision: 3 });
    expect(parseRemoteCommandPayload({ kind: "resolve_interaction", interactionId, revision: 1, decision: "cancel" }))
      .toMatchObject({ decision: "cancel" });
    expect(parseRemoteCommandPayload({
      kind: "resolve_interaction",
      interactionId,
      revision: 2,
      answers: {},
    })).toBeNull();
    expect(parseRemoteCommandPayload({
      kind: "resolve_interaction",
      interactionId,
      revision: 2,
      answers: { q1: { answers: ["spaces"] } },
    })).toEqual({ answers: { q1: { answers: ["spaces"] } }, interactionId, kind: "resolve_interaction", revision: 2 });
    expect(parseRemoteCommandPayload({ kind: "send_or_steer", message: "keep going" }))
      .toEqual({ kind: "send_or_steer", message: "keep going" });
  });

  test("refuses session scope, malformed ids, extra keys, and unsafe answers", () => {
    expect(parseRemoteCommandPayload({ kind: "resolve_interaction", interactionId, revision: 1, decision: "session" })).toBeNull();
    expect(parseRemoteCommandPayload({ kind: "resolve_interaction", interactionId: "int_1", revision: 1, decision: "once" })).toBeNull();
    expect(parseRemoteCommandPayload({ kind: "resolve_interaction", interactionId, revision: 0, decision: "once" })).toBeNull();
    expect(parseRemoteCommandPayload({ kind: "resolve_interaction", interactionId, revision: 1, decision: "once", answers: {} })).toBeNull();
    for (const answers of [[], ["eu", "us"]]) {
      expect(parseRemoteCommandPayload({
        answers: { q1: { answers } },
        interactionId,
        kind: "resolve_interaction",
        revision: 1,
      })).toBeNull();
    }
    expect(parseRemoteCommandPayload({
      answers: { q1: { answers: [""] } },
      interactionId,
      kind: "resolve_interaction",
      revision: 1,
    })).toBeNull();
    expect(parseRemoteCommandPayload({
      kind: "resolve_interaction",
      interactionId,
      revision: 1,
      answers: { q1: { answers: [["", "opt", "someone", "secret"].join("/")] } },
    })).toBeNull();
    for (const value of [
      `ghp_${"x".repeat(24)}`,
      `sk_${"x".repeat(24)}`,
      ["Bearer", "abcdefghijklmnopqrstuvwxyz"].join(" "),
    ]) {
      expect(parseRemoteCommandPayload({
        answers: { q1: { answers: [value] } },
        interactionId,
        kind: "resolve_interaction",
        revision: 1,
      })).toBeNull();
    }
    expect(parseRemoteCommandPayload({
      answers: { q1: { answers: ["😀".repeat(10_000)] } },
      interactionId,
      kind: "resolve_interaction",
      revision: 1,
    })).toBeNull();
  });

  test("refuses answer sets that cannot fit the hosted command envelope", async () => {
    const answers = Object.fromEntries(Array.from({ length: 8 }, (_, index) => [
      `field${String(index)}`,
      { answers: ["€".repeat(16_384)] },
    ]));
    const oversized = {
      answers,
      interactionId,
      kind: "resolve_interaction" as const,
      revision: 1,
    };
    expect(parseRemoteCommandPayload(oversized)).toBeNull();
    await expectPromiseToReject(
      encryptRemoteCommand(oversized, randomKeyBytes(), {
        entityPublicId: "command_12345678",
        keyVersion: 1,
        kind: "command",
        userPublicId: "user_12345678",
      }),
      "Invalid remote command payload.",
    );
  });

  test("fails closed when an untrusted command object has throwing accessors", () => {
    const attack = Object.defineProperty({}, "kind", {
      enumerable: true,
      get(): never {
        throw new Error("getter must not escape");
      },
    });
    expect(parseRemoteCommandPayload(attack)).toBeNull();

    const prototype = Object.prototype as Record<string, unknown>;
    Object.defineProperty(prototype, "kind", {
      configurable: true,
      get(): never {
        throw new Error("prototype getter must not escape");
      },
    });
    let parsed: ReturnType<typeof parseRemoteCommandPayload> = null;
    try {
      parsed = parseRemoteCommandPayload({});
    } finally {
      delete prototype.kind;
    }
    expect(parsed).toBeNull();
  });

  test("never validates and then rereads a stateful answer accessor", () => {
    let reads = 0;
    const answerAttack = Object.defineProperty({}, "answers", {
      enumerable: true,
      get() {
        reads += 1;
        return reads === 1 ? ["safe"] : [["", "opt", "someone", "secret"].join("/")];
      },
    });
    expect(parseRemoteCommandPayload({
      answers: { q1: answerAttack },
      interactionId,
      kind: "resolve_interaction",
      revision: 1,
    })).toBeNull();
    expect(reads).toBe(0);

    const commandAttack = Object.defineProperty({
      interactionId,
      kind: "resolve_interaction",
      revision: 1,
    }, "answers", {
      enumerable: true,
      get() {
        reads += 1;
        return {
          q1: {
            answers: [reads === 1 ? "safe" : ["", "opt", "someone", "secret"].join("/")],
          },
        };
      },
    });
    expect(parseRemoteCommandPayload(commandAttack)).toBeNull();
    expect(reads).toBe(0);
  });

  test("canonicalizes answer maps and rejects hidden answer-map keys", () => {
    const answers = Object.fromEntries([
      ["__proto__", { answers: ["safe"] }],
    ]);
    const parsed = parseRemoteCommandPayload({
      answers,
      interactionId,
      kind: "resolve_interaction",
      revision: 1,
    });
    expect(parsed).toMatchObject({ kind: "resolve_interaction" });
    if (parsed === null || !("answers" in parsed)) throw new Error("expected answers");
    expect(Object.keys(parsed.answers)).toEqual(["__proto__"]);
    expect(parsed.answers.__proto__).toEqual({ answers: ["safe"] });
    expect(parsed.answers).not.toBe(answers);

    const withSymbol = { q1: { answers: ["safe"] } } as Record<PropertyKey, unknown>;
    withSymbol[Symbol("hidden")] = true;
    expect(parseRemoteCommandPayload({
      answers: withSymbol,
      interactionId,
      kind: "resolve_interaction",
      revision: 1,
    })).toBeNull();
  });

  test("returns optional command fields immune to ambient prototype values", () => {
    const prototype = Object.prototype as Record<string, unknown>;
    Object.defineProperty(prototype, "preset", {
      configurable: true,
      enumerable: true,
      value: "ultra",
    });
    try {
      const parsed = parseRemoteCommandPayload({
        kind: "set_provider",
        ...activeRemoteDerivedCodexSelection(),
      });
      expect(parsed).not.toBeNull();
      expect(parsed && Object.hasOwn(parsed, "preset")).toBe(false);
      expect(parsed && "preset" in parsed ? parsed.preset : undefined).toBeUndefined();
    } finally {
      delete prototype.preset;
    }
  });
});

describe("settings command payloads", () => {
  test("accepts every settings kind with its exact key set", () => {
    expect(parseRemoteCommandPayload({ kind: "set_approval_mode", mode: "auto:workspace", scope: "session" }))
      .toEqual({ kind: "set_approval_mode", mode: "auto:workspace", scope: "session" });
    expect(parseRemoteCommandPayload({ kind: "set_show_thinking", enabled: true, scope: "default" }))
      .toEqual({ enabled: true, kind: "set_show_thinking", scope: "default" });
    expect(parseRemoteCommandPayload({
      kind: "set_default_preset",
      preset: "ultra",
      presetContract: 2,
    })).toEqual({ kind: "set_default_preset", preset: "ultra", presetContract: 2 });
    expect(parseRemoteCommandPayload({ kind: "set_default_preset", preset: "ultra" }))
      .toBeNull();
    expect(parseRemoteCommandPayload({
      kind: "set_default_preset",
      preset: "ultra",
      presetContract: 1,
    })).toBeNull();
    expect(parseRemoteCommandPayload({ kind: "archive_session", archived: true }))
      .toEqual({ archived: true, kind: "archive_session" });
    expect(parseRemoteCommandPayload({ kind: "rename_session", name: "Nightly review" }))
      .toEqual({ kind: "rename_session", name: "Nightly review" });
    expect(parseRemoteCommandPayload({ kind: "rename_session", name: null }))
      .toEqual({ kind: "rename_session", name: null });
    expect(parseRemoteCommandPayload({ kind: "set_gateway_key", key: ["gw", "x".repeat(24)].join("-") }))
      .toMatchObject({ kind: "set_gateway_key" });
  });

  test("refuses unknown scopes, modes, presets, extra keys, and unsafe names", () => {
    expect(parseRemoteCommandPayload({ kind: "set_approval_mode", mode: "auto:all", scope: "device" })).toBeNull();
    expect(parseRemoteCommandPayload({ kind: "set_approval_mode", mode: "auto", scope: "session" })).toBeNull();
    expect(parseRemoteCommandPayload({ kind: "set_approval_mode", mode: "auto:all" })).toBeNull();
    expect(parseRemoteCommandPayload({ kind: "set_show_thinking", enabled: "yes", scope: "session" })).toBeNull();
    expect(parseRemoteCommandPayload({ kind: "set_default_preset", preset: "max" })).toBeNull();
    expect(parseRemoteCommandPayload({ kind: "archive_session", archived: 1 })).toBeNull();
    expect(parseRemoteCommandPayload({ kind: "archive_session", archived: true, session: "sess" })).toBeNull();
    expect(parseRemoteCommandPayload({ kind: "rename_session", name: "" })).toBeNull();
    expect(parseRemoteCommandPayload({
      kind: "rename_session",
      name: ["", "srv", "runner", "job"].join("/"),
    })).toBeNull();
    expect(parseRemoteCommandPayload({ kind: "rename_session", name: `bell${String.fromCharCode(7)}` })).toBeNull();
    expect(parseRemoteCommandPayload({ kind: "set_gateway_key", key: "short" })).toBeNull();
    expect(parseRemoteCommandPayload({ kind: "set_gateway_key", key: `gw ${"x".repeat(24)}` })).toBeNull();
  });

  test("carries a settings command through the encrypted command envelope", async () => {
    const key = randomKeyBytes();
    const authority = {
      entityPublicId: "command_12345678",
      keyVersion: 4,
      kind: "command",
      userPublicId: "user_12345678",
    } as const;
    const payload = { kind: "set_show_thinking", enabled: true, scope: "session" } as const;
    const envelope = await encryptRemoteCommand(payload, key, authority);
    expect(await decryptRemoteCommand(envelope, key, authority)).toEqual(payload);
  });
});

describe("session metadata archive", () => {
  test("keeps archive optional and additive", () => {
    expect(parseSessionMetadataPayload({ name: "Session", note: null }))
      .toEqual({ name: "Session", note: null });
    expect(parseSessionMetadataPayload({ archived: true, name: "Session", note: null }))
      .toEqual({ archived: true, name: "Session", note: null });
    expect(parseSessionMetadataPayload({ archived: false, name: "Session", note: null }))
      .toEqual({ archived: false, name: "Session", note: null });
    expect(parseSessionMetadataPayload({ archived: "yes", name: "Session", note: null })).toBeNull();
    expect(parseSessionMetadataPayload({ archived: true, name: "Session", note: null, extra: 1 })).toBeNull();
  });
});

function registryFixture() {
  return {
    accounts: [{ label: "Work", provider: "codex", publicId: "acct_00000000000000000000000000000001", status: "signed_in" }],
    daemonVersion: "0.3.0",
    defaultApprovalMode: "auto:all",
    defaultPreset: "ultra",
    heartbeatAt: 1_700_000_000_000,
    machineLabel: "Studio",
    projects: [{ label: "Control plane", publicId: "proj_00000000000000000000000000000001" }],
    proseAutorespondConfigured: false,
    scheduledTasks: [
      {
        cadence: "every 60 minutes",
        id: "stask_00000000000000000000000000000001",
        kind: "hra_conversation",
        label: "Nightly sweep",
        nextRunAt: 1_700_000_060_000,
        sessionPublicId: "sess_00000000000000000000000000000001",
      },
    ],
    showThinkingDefault: false,
    version: 1,
  } as const;
}

describe("device registry payloads", () => {
  const registry = registryFixture();
  const authority = {
    entityPublicId: "device_12345678",
    keyVersion: 2,
    kind: "device_registry",
    userPublicId: "user_12345678",
  } as const;

  test("round-trips through the account-key envelope under its own authority kind", async () => {
    const key = randomKeyBytes();
    const envelope = await encryptDeviceRegistry(registry, key, authority);
    expect(await decryptDeviceRegistry(envelope, key, authority)).toEqual(registry);
    await expectPromiseToReject(decryptDeviceRegistry(envelope, key, {
      ...authority,
      entityPublicId: "device_87654321",
    }));
    await expectPromiseToReject(decryptDeviceRegistry(envelope, key, {
      ...authority,
      kind: "session_metadata",
    }));
  });

  test("removes legacy Codex Desktop automation metadata before encrypting the public registry", async () => {
    const privateAutomation = {
      cadence: "FREQ=WEEKLY;BYDAY=MO",
      id: "desktop-private-automation-id",
      kind: "codex_automation",
      label: "Desktop private automation label",
      nextRunAt: null,
      sessionPublicId: "sess_private_target_correlation",
    } as const;
    const legacyRegistry = {
      ...registry,
      scheduledTasks: [...registry.scheduledTasks, privateAutomation],
    };
    const parsed = parseDeviceRegistryPayload(legacyRegistry);
    expect(parsed?.scheduledTasks).toEqual(registry.scheduledTasks);

    const key = randomKeyBytes();
    const envelope = await encryptDeviceRegistry(
      legacyRegistry as unknown as DeviceRegistryPayload,
      key,
      authority,
    );
    const plaintext = new TextDecoder().decode(await decryptBytes(
      envelope,
      key,
      cloudPayloadAad(authority),
    ));
    expect(JSON.parse(plaintext)).toEqual(parsed);
    for (const privateValue of [
      privateAutomation.id,
      privateAutomation.label,
      privateAutomation.cadence,
      privateAutomation.sessionPublicId,
    ]) {
      expect(plaintext).not.toContain(privateValue);
    }
  });

  test("accepts additive exact personal-session adoption aggregates without candidate detail", async () => {
    const withAdoption = {
      ...registry,
      sessionAdoption: {
        claude: { adopted: 1, enabled: false, fenced: 2, pending: 3 },
        codex: { adopted: 4, enabled: true, fenced: 5, pending: 6 },
      },
    } as const;
    const parsed = parseDeviceRegistryPayload(withAdoption);
    expect(parsed).toEqual(withAdoption);
    expect(JSON.stringify(parsed)).not.toContain("providerThreadId");

    const key = randomKeyBytes();
    const envelope = await encryptDeviceRegistry(withAdoption, key, authority);
    expect(await decryptDeviceRegistry(envelope, key, authority)).toEqual(withAdoption);
  });

  test("accepts an additive default project only when it names a listed project", async () => {
    const withDefault = {
      ...registry,
      defaultProjectPublicId: "proj_00000000000000000000000000000001",
    } as const;
    expect(parseDeviceRegistryPayload(withDefault)).toEqual(withDefault);
    const key = randomKeyBytes();
    const envelope = await encryptDeviceRegistry(withDefault, key, authority);
    expect(await decryptDeviceRegistry(envelope, key, authority)).toEqual(withDefault);
    expect(parseDeviceRegistryPayload({
      ...registry,
      defaultProjectPublicId: "proj_00000000000000000000000000000009",
    })).toBeNull();
    expect(parseDeviceRegistryPayload({ ...registry, defaultProjectPublicId: null })).toBeNull();
    expect(parseDeviceRegistryPayload({ ...registry, defaultProjectPublicId: "/Users/me" })).toBeNull();
  });

  test("parses and encrypts a registry carrying a Devin account and Astra default", async () => {
    const providerRegistry = {
      ...registry,
      accounts: [
        ...registry.accounts,
        {
          label: "Build",
          provider: "devin",
          publicId: "acct_00000000000000000000000000000002",
          status: "signed_in",
        },
      ],
      defaultPreset: "astra",
    } as const;
    expect(parseDeviceRegistryPayload(providerRegistry)).toEqual(providerRegistry);
    const key = randomKeyBytes();
    const envelope = await encryptDeviceRegistry(providerRegistry, key, authority);
    expect(await decryptDeviceRegistry(envelope, key, authority)).toEqual(providerRegistry);
  });

  test("refuses a path-shaped label anywhere in the projection", async () => {
    const absolutePath = ["", "srv", "runner", "checkout"].join("/");
    const homePath = `~/${["projects", "control-plane"].join("/")}`;
    expect(parseDeviceRegistryPayload({ ...registry, machineLabel: absolutePath })).toBeNull();
    expect(parseDeviceRegistryPayload({
      ...registry,
      projects: [{ label: homePath, publicId: "proj_00000000000000000000000000000001" }],
    })).toBeNull();
    expect(parseDeviceRegistryPayload({
      ...registry,
      accounts: [{ ...registry.accounts[0], label: absolutePath }],
    })).toBeNull();
    expect(parseDeviceRegistryPayload({
      ...registry,
      scheduledTasks: [{ ...registry.scheduledTasks[0], label: absolutePath }],
    })).toBeNull();
    expect(parseDeviceRegistryPayload({
      ...registry,
      scheduledTasks: [{ ...registry.scheduledTasks[0], cadence: absolutePath }],
    })).toBeNull();
    await expectPromiseToReject(encryptDeviceRegistry(
      { ...registry, machineLabel: absolutePath },
      randomKeyBytes(),
      authority,
    ), "Invalid device registry payload");
  });

  test("refuses unknown versions, unknown keys, and out-of-range members", () => {
    expect(parseDeviceRegistryPayload({ ...registry, version: 2 })).toBeNull();
    expect(parseDeviceRegistryPayload({ ...registry, extra: true })).toBeNull();
    // Email consent lives in its own revision-bearing envelope. Keeping this
    // key out of the broad registry preserves the exact v1 contract for old
    // readers that reject unknown members.
    expect(parseDeviceRegistryPayload({ ...registry, attentionEmailEnabled: true })).toBeNull();
    expect(parseDeviceRegistryPayload({ ...registry, defaultPreset: "max" })).toBeNull();
    expect(parseDeviceRegistryPayload({ ...registry, defaultApprovalMode: "auto" })).toBeNull();
    expect(parseDeviceRegistryPayload({ ...registry, showThinkingDefault: "on" })).toBeNull();
    expect(parseDeviceRegistryPayload({ ...registry, heartbeatAt: -1 })).toBeNull();
    expect(parseDeviceRegistryPayload({
      ...registry,
      accounts: [{ ...registry.accounts[0], provider: "codex-cloud" }],
    })).toBeNull();
    expect(parseDeviceRegistryPayload({
      ...registry,
      accounts: [{ ...registry.accounts[0], status: "removed" }],
    })).toBeNull();
    expect(parseDeviceRegistryPayload({
      ...registry,
      scheduledTasks: [{ ...registry.scheduledTasks[0], kind: "codex_plugin" }],
    })).toBeNull();
    expect(parseDeviceRegistryPayload({
      ...registry,
      scheduledTasks: [{ ...registry.scheduledTasks[0], sessionPublicId: "sess 1" }],
    })).toBeNull();
    expect(parseDeviceRegistryPayload({
      ...registry,
      projects: Array.from({ length: 201 }, () => registry.projects[0]),
    })).toBeNull();
    const adoption = {
      claude: { adopted: 1, enabled: false, fenced: 2, pending: 3 },
      codex: { adopted: 4, enabled: true, fenced: 5, pending: 6 },
    } as const;
    expect(parseDeviceRegistryPayload({
      ...registry,
      sessionAdoption: { ...adoption, codex: { ...adoption.codex, pending: -1 } },
    })).toBeNull();
    expect(parseDeviceRegistryPayload({
      ...registry,
      sessionAdoption: { ...adoption, claude: { ...adoption.claude, enabled: "yes" } },
    })).toBeNull();
    expect(parseDeviceRegistryPayload({
      ...registry,
      sessionAdoption: { ...adoption, codex: { ...adoption.codex, title: "private" } },
    })).toBeNull();
    expect(parseDeviceRegistryPayload({
      ...registry,
      sessionAdoption: { codex: adoption.codex },
    })).toBeNull();
    expect(parseDeviceRegistryPayload({
      ...registry,
      sessionAdoption: {
        ...adoption,
        devin: { adopted: 7, enabled: true, fenced: 8, pending: 9 },
      },
    })).toBeNull();
    for (const privateExtra of [
      { candidateIds: ["candidate_private"] },
      { providerHome: "/private/provider/home" },
      { providerThreadId: "provider_thread_private" },
      { sourceProcessIdentity: { pid: 42 } },
      { authorityHash: "authority_hash_private" },
    ]) {
      expect(parseDeviceRegistryPayload({ ...registry, ...privateExtra, sessionAdoption: adoption }))
        .toBeNull();
    }
  });

  test("takes one accessor-free snapshot before validating a registry", () => {
    let getterCalls = 0;
    const withGetter = { ...registry } as Record<string, unknown>;
    Object.defineProperty(withGetter, "machineLabel", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return getterCalls === 1 ? "Studio" : "/private/after-validation";
      },
    });
    expect(parseDeviceRegistryPayload(withGetter)).toBeNull();
    expect(getterCalls).toBe(0);
  });
});

describe("memory summary payloads", () => {
  const digest = (scalar: string) => scalar.repeat(64);
  const summary = {
    coverage: { peerActions: "complete", peerPolicies: "complete", spaces: "complete" },
    observedAt: 1_700_000_000_000,
    peerActions: [{
      actor: { label: "Planner", ref: digest("a") },
      createdAt: 1_699_999_998_000,
      delivery: "steer",
      state: "applied",
      target: { label: "Builder", ref: digest("b") },
      updatedAt: 1_699_999_999_000,
    }],
    peerPolicies: [{
      mode: "coordinate",
      projectLabel: "Oompa",
      session: { label: "Planner", ref: digest("a") },
      updatedAt: 1_699_999_997_000,
    }],
    spaces: [{
      bindingDigest: digest("c"),
      canonicalSpaceId: `hra:project:space-${"d".repeat(32)}`,
      enrollment: "attached",
      head: { digest: digest("e"), operationSha256: digest("f"), sequence: 7 },
      lastExchangeAt: 1_699_999_999_500,
      projectLabel: "Oompa",
      recentRecords: [{
        key: "release-policy",
        kind: "memory_page",
        updatedAt: 1_699_999_996_000,
      }],
      recordCount: 4,
      remoteHead: { digest: digest("e"), operationSha256: digest("f"), sequence: 7 },
      syncStatus: "settled",
    }],
    version: 1,
  } as const;
  const authority = {
    entityPublicId: "device_12345678",
    keyVersion: 2,
    kind: "memory_summary",
    userPublicId: "user_12345678",
  } as const;

  test("round-trips under an authority distinct from the byte-strict device registry", async () => {
    const parsed = parseMemorySummaryPayload(summary);
    expect(parsed).toEqual(summary);
    const key = randomKeyBytes();
    const envelope = await encryptMemorySummary(summary, key, authority);
    expect(JSON.stringify(envelope)).not.toContain("release-policy");
    expect(JSON.stringify(envelope)).not.toContain("Planner");
    expect(await decryptMemorySummary(envelope, key, authority)).toEqual(summary);
    await expectPromiseToReject(decryptMemorySummary(envelope, key, {
      ...authority,
      kind: "device_registry",
    }));
    await expectPromiseToReject(decryptMemorySummary(envelope, key, {
      ...authority,
      entityPublicId: "device_87654321",
    }));

    const registry = registryFixture();
    expect(JSON.stringify(parseDeviceRegistryPayload(registry))).toBe(JSON.stringify(registry));
    expect(parseDeviceRegistryPayload({ ...registry, memorySummary: summary })).toBeNull();
  });

  test("refuses local identifiers, paths, bodies, reasons, ambiguous roles, and incoherent heads", () => {
    const space = summary.spaces[0];
    const action = summary.peerActions[0];
    expect(space).toBeDefined();
    expect(action).toBeDefined();
    expect(parseMemorySummaryPayload({
      ...summary,
      coverage: { ...summary.coverage, spaces: "unknown" },
    })).toBeNull();
    const withoutCoverage = { ...summary } as Record<string, unknown>;
    delete withoutCoverage.coverage;
    expect(parseMemorySummaryPayload(withoutCoverage)).toBeNull();
    expect(parseMemorySummaryPayload({
      ...summary,
      spaces: [{ ...space, projectId: "proj_local" }],
    })).toBeNull();
    expect(parseMemorySummaryPayload({
      ...summary,
      spaces: [{ ...space, projectLabel: ["", "Users", "operator", "private"].join("/") }],
    })).toBeNull();
    expect(parseMemorySummaryPayload({
      ...summary,
      spaces: [{ ...space, recentRecords: [{ ...space.recentRecords[0], body: "secret" }] }],
    })).toBeNull();
    expect(parseMemorySummaryPayload({
      ...summary,
      peerActions: [{ ...action, reason: "because" }],
    })).toBeNull();
    expect(parseMemorySummaryPayload({
      ...summary,
      peerActions: [{ ...action, target: action.actor }],
    })).toBeNull();
    expect(parseMemorySummaryPayload({
      ...summary,
      spaces: [{
        ...space,
        head: { ...space.head, operationSha256: null },
      }],
    })).toBeNull();
    expect(parseMemorySummaryPayload({
      ...summary,
      spaces: [{
        ...space,
        enrollment: "not_enrolled",
        remoteHead: space.remoteHead,
        syncStatus: "local_only",
      }],
    })).toBeNull();
    expect(parseMemorySummaryPayload({
      ...summary,
      spaces: [{ ...space, recordCount: 0 }],
    })).toBeNull();
    expect(parseMemorySummaryPayload({
      ...summary,
      spaces: [{ ...space, recordCount: null }],
    })).toBeNull();
    expect(parseMemorySummaryPayload({
      ...summary,
      spaces: [{
        ...space,
        enrollment: "unavailable",
        recentRecords: [],
        recordCount: null,
        syncStatus: "error",
      }],
    })).not.toBeNull();
    expect(parseMemorySummaryPayload({
      ...summary,
      spaces: [{
        ...space,
        enrollment: "detached",
        remoteHead: space.remoteHead,
        syncStatus: "local_only",
      }],
    })).not.toBeNull();
    expect(parseMemorySummaryPayload({
      ...summary,
      spaces: [{ ...space, lastExchangeAt: summary.observedAt + 1 }],
    })).toBeNull();
    expect(parseMemorySummaryPayload({
      ...summary,
      peerPolicies: [{ ...summary.peerPolicies[0], updatedAt: summary.observedAt + 1 }],
    })).toBeNull();
    expect(parseMemorySummaryPayload({
      ...summary,
      peerActions: [{ ...action, updatedAt: summary.observedAt + 1 }],
    })).toBeNull();
    expect(parseMemorySummaryPayload({
      ...summary,
      spaces: [{
        ...space,
        remoteHead: { ...space.remoteHead, digest: digest("9") },
      }],
    })).toBeNull();
    expect(parseMemorySummaryPayload({
      ...summary,
      spaces: [{ ...space, syncStatus: "local_only" }],
    })).toBeNull();
    expect(parseMemorySummaryPayload({
      ...summary,
      spaces: [{
        ...space,
        enrollment: "not_enrolled",
        head: { digest: space.head.digest, operationSha256: null, sequence: -0 },
        lastExchangeAt: null,
        recentRecords: [],
        recordCount: 0,
        remoteHead: null,
        syncStatus: "local_only",
      }],
    })).toBeNull();
    expect(parseMemorySummaryPayload({
      ...summary,
      spaces: [{
        ...space,
        enrollment: "unavailable",
        recentRecords: [],
        recordCount: -0,
        syncStatus: "error",
      }],
    })).toBeNull();
  });

  test("refuses an oversized valid summary before encryption", async () => {
    const oversized = {
      ...summary,
      peerActions: [],
      peerPolicies: Array.from({ length: 200 }, (_, index) => ({
        mode: "coordinate" as const,
        projectLabel: "P".repeat(200),
        session: {
          label: "S".repeat(200),
          ref: index.toString(16).padStart(64, "0"),
        },
        updatedAt: summary.observedAt,
      })),
      spaces: [],
    };
    expect(parseMemorySummaryPayload(oversized)).not.toBeNull();
    expect(memorySummaryFitsEncryptedEnvelope(oversized)).toBe(false);
    await expectPromiseToReject(encryptMemorySummary(oversized, randomKeyBytes(), authority));
  });

  test("enforces collection bounds and snapshots foreign values without getters", () => {
    expect(parseMemorySummaryPayload({
      ...summary,
      peerActions: Array.from({ length: 51 }, () => summary.peerActions[0]),
    })).toBeNull();
    expect(parseMemorySummaryPayload({
      ...summary,
      peerPolicies: Array.from({ length: 201 }, (_, index) => ({
        ...summary.peerPolicies[0],
        session: { label: `Session ${index}`, ref: index.toString(16).padStart(64, "0") },
      })),
    })).toBeNull();
    const foreign = { ...summary } as Record<string, unknown>;
    let getterCalls = 0;
    Object.defineProperty(foreign, "spaces", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return summary.spaces;
      },
    });
    expect(parseMemorySummaryPayload(foreign)).toBeNull();
    expect(getterCalls).toBe(0);
  });
});

describe("device command payloads", () => {
  const sessionStart = {
    accountPublicId: "account_primary",
    kind: "session_start",
    preset: "ultra",
    presetContract: 2,
    projectPublicId: "project_alpha",
    prompt: "continue the migration",
    provider: "codex",
  } as const;

  test("accepts each kind in its exact shape", () => {
    expect(parseDeviceCommandPayload(sessionStart)).toEqual(sessionStart);
    expect(parseDeviceCommandPayload({
      accountPublicId: sessionStart.accountPublicId,
      kind: sessionStart.kind,
      preset: "fable-max",
      projectPublicId: sessionStart.projectPublicId,
      prompt: sessionStart.prompt,
      provider: "claude",
    })).toEqual({
      accountPublicId: sessionStart.accountPublicId,
      kind: sessionStart.kind,
      preset: "fable-max",
      projectPublicId: sessionStart.projectPublicId,
      prompt: sessionStart.prompt,
      provider: "claude",
    });
    expect(parseDeviceCommandPayload({
      accountPublicId: sessionStart.accountPublicId,
      kind: sessionStart.kind,
      preset: "astra",
      projectPublicId: sessionStart.projectPublicId,
      prompt: sessionStart.prompt,
      provider: "devin",
    })).toBeNull();
    expect(parseDeviceCommandPayload({
      accountPublicId: "account_primary",
      kind: "account_login_start",
    })).toEqual({ accountPublicId: "account_primary", kind: "account_login_start" });
    expect(parseDeviceCommandPayload({
      accountPublicId: "account_primary",
      handoffVersion: 2,
      kind: "account_login_start",
    })).toEqual({
      accountPublicId: "account_primary",
      handoffVersion: 2,
      kind: "account_login_start",
    });
    expect(parseDeviceCommandPayload({ kind: "account_login_status" }))
      .toEqual({ kind: "account_login_status" });
    expect(parseDeviceCommandPayload({
      accountPublicId: "account_primary",
      kind: "account_login_status",
    })).toEqual({ accountPublicId: "account_primary", kind: "account_login_status" });
    expect(parseDeviceCommandPayload({ kind: "usage_refresh" }))
      .toEqual({ kind: "usage_refresh" });
    expect(parseDeviceCommandPayload({
      endMinute: 1_320,
      expectedRevision: 7,
      kind: "set_notification_hours",
      startMinute: 600,
      timeZone: "America/Puerto_Rico",
      version: 1,
    })).toMatchObject({ kind: "set_notification_hours", expectedRevision: 7 });
  });

  test("refuses an extra key, a wrong scalar, and a session command kind", () => {
    expect(parseDeviceCommandPayload({ ...sessionStart, extra: 1 })).toBeNull();
    expect(parseDeviceCommandPayload({
      accountPublicId: sessionStart.accountPublicId,
      kind: sessionStart.kind,
      preset: sessionStart.preset,
      projectPublicId: sessionStart.projectPublicId,
      prompt: sessionStart.prompt,
      provider: sessionStart.provider,
    })).toBeNull();
    expect(parseDeviceCommandPayload({
      ...sessionStart,
      presetContract: undefined,
    })).toBeNull();
    expect(parseDeviceCommandPayload({ ...sessionStart, presetContract: 1 })).toBeNull();
    expect(parseDeviceCommandPayload({
      ...sessionStart,
      preset: "fable-max",
      presetContract: 2,
      provider: "claude",
    })).toBeNull();
    expect(parseDeviceCommandPayload({ ...sessionStart, preset: "fable-max" })).toBeNull();
    expect(parseDeviceCommandPayload({ ...sessionStart, preset: "astra" })).toBeNull();
    expect(parseDeviceCommandPayload({ ...sessionStart, provider: "devin" })).toBeNull();
    expect(parseDeviceCommandPayload({
      ...sessionStart,
      preset: "fable-max",
      provider: "devin",
    })).toBeNull();
    expect(parseDeviceCommandPayload({
      ...sessionStart,
      preset: "ultra",
      provider: "claude",
    })).toBeNull();
    expect(parseDeviceCommandPayload({ ...sessionStart, provider: "gemini" })).toBeNull();
    expect(parseDeviceCommandPayload({ kind: "send_or_steer", message: "hello" })).toBeNull();
    expect(parseDeviceCommandPayload({
      enabled: true,
      expectedRevision: 1,
      kind: "set_notification_email",
    })).toBeNull();
    expect(parseDeviceCommandPayload({ kind: "account_login_status", accountPublicId: "a" }))
      .toBeNull();
    expect(parseDeviceCommandPayload({
      accountPublicId: "account_primary",
      handoffVersion: 1,
      kind: "account_login_start",
    })).toBeNull();
    expect(parseDeviceCommandPayload({
      endMinute: 600,
      expectedRevision: 7,
      kind: "set_notification_hours",
      startMinute: 600,
      timeZone: "America/Puerto_Rico",
      version: 1,
    })).toBeNull();
  });

  test("notification hours use their own AAD and strict v1 envelope", async () => {
    const key = randomKeyBytes();
    const authority = {
      entityPublicId: "device_000000000001",
      keyVersion: 1,
      kind: "notification_hours",
      userPublicId: "user_0000000000000001",
    } as const;
    const hours = { endMinute: 1_320, revision: 2, startMinute: 600, timeZone: "America/Puerto_Rico", version: 1 } as const;
    const envelope = await encryptNotificationHours(hours, key, authority);
    expect(await decryptNotificationHours(envelope, key, authority)).toEqual(hours);
    await expectPromiseToReject(decryptNotificationHours(envelope, key, { ...authority, kind: "device_registry" }));
    await expectPromiseToReject(encryptNotificationHours({ ...hours, version: 2 } as never, key, authority));
  });

  test("notification email uses its own AAD and strict revision-bearing envelope", async () => {
    const key = randomKeyBytes();
    const authority = {
      entityPublicId: "device_000000000001",
      keyVersion: 1,
      kind: "notification_email",
      userPublicId: "user_0000000000000001",
    } as const;
    const email = { enabled: true, revision: 2, version: 1 } as const;
    const envelope = await encryptNotificationEmail(email, key, authority);
    expect(await decryptNotificationEmail(envelope, key, authority)).toEqual(email);
    await expectPromiseToReject(decryptNotificationEmail(
      envelope,
      key,
      { ...authority, kind: "notification_hours" },
    ));
    await expectPromiseToReject(encryptNotificationEmail(
      { ...email, revision: 0 },
      key,
      authority,
    ));
  });

  test("never accepts a filesystem path as addressing or as a prompt", () => {
    expect(parseDeviceCommandPayload({ ...sessionStart, projectPublicId: "/srv/app" })).toBeNull();
    expect(parseDeviceCommandPayload({ ...sessionStart, projectPublicId: "~/app" })).toBeNull();
    expect(parseDeviceCommandPayload({ ...sessionStart, prompt: "open /etc/passwd" })).toBeNull();
  });

  test("bounds the prompt", () => {
    expect(parseDeviceCommandPayload({ ...sessionStart, prompt: "" })).toBeNull();
    expect(parseDeviceCommandPayload({
      ...sessionStart,
      prompt: "x".repeat(deviceCommandLimits.promptCharacters),
    })).not.toBeNull();
    expect(parseDeviceCommandPayload({
      ...sessionStart,
      prompt: "x".repeat(deviceCommandLimits.promptCharacters + 1),
    })).toBeNull();
  });

  test("a relayed device-code handoff uses the exact Codex URL and a closed user code", () => {
    expect(isRelayedLoginUrl("https://auth.openai.com/codex/device")).toBe(true);
    expect(isRelayedLoginUrl("https://auth.openai.com/codex/device/")).toBe(false);
    expect(isRelayedLoginUrl("https://auth.openai.com/codex/device?continue=1")).toBe(false);
    expect(isRelayedLoginUrl("https://auth.openai.com/codex/device#continue")).toBe(false);
    expect(isRelayedLoginUrl("https://auth.openai.com:443/codex/device")).toBe(false);
    expect(isRelayedLoginUrl("https://AUTH.OPENAI.COM/codex/device")).toBe(false);
    expect(isRelayedLoginUrl("https://auth.openai.com/codex/%64evice")).toBe(false);
    expect(isRelayedLoginUrl("https://auth.openai.com.evil.example/codex/device")).toBe(false);
    expect(isRelayedLoginUrl("https://auth-openai.com/codex/device")).toBe(false);
    expect(isRelayedLoginUrl("https://auth.open\u0430i.com/codex/device")).toBe(false);
    expect(isRelayedLoginUrl("https://chatgpt.com/codex/device")).toBe(false);
    expect(isRelayedLoginUrl("https://10.0.0.1/codex/device")).toBe(false);
    expect(isRelayedLoginUrl("https://169.254.169.254/codex/device")).toBe(false);
    expect(isRelayedLoginUrl("https://[fd00::1]/codex/device")).toBe(false);
    expect(isRelayedLoginUrl("http://localhost:1455/callback")).toBe(false);
    expect(isRelayedLoginUrl("https://localhost/callback")).toBe(false);
    expect(isRelayedLoginUrl("https://localhost./callback")).toBe(false);
    expect(isRelayedLoginUrl("https://127.0.0.2/callback")).toBe(false);
    expect(isRelayedLoginUrl("https://[::1]/callback")).toBe(false);
    expect(isRelayedLoginUrl("https://[::ffff:127.0.0.1]/callback")).toBe(false);
    expect(isRelayedLoginUrl("https://user:pass@auth.openai.com/codex/device")).toBe(false);
    expect(isRelayedLoginUrl("javascript:alert(1)")).toBe(false);
    expect(isRelayedLoginUrl(`https://auth.openai.com/${"a".repeat(2_048)}`)).toBe(false);
    expect(isRelayedLoginUrl(new URL("https://auth.openai.com/codex/device"))).toBe(false);
    expect(isRelayedLoginUserCode("ABCD-EFGH")).toBe(true);
    expect(isRelayedLoginUserCode("ABCD EFGH")).toBe(false);
    expect(isRelayedLoginUserCode("abcd-efgh")).toBe(false);
    expect(isRelayedLoginUserCode(`ABCD-${"E".repeat(13)}`)).toBe(false);
  });

  test("result payloads require the complete current handoff and each exact kind shape", () => {
    expect(parseDeviceCommandResultPayload({
      kind: "session_start",
      sessionPublicId: "sess_0000000000000001",
    })).toEqual({ kind: "session_start", sessionPublicId: "sess_0000000000000001" });
    expect(parseDeviceCommandResultPayload({
      expiresAt: 1,
      handoffVersion: 2,
      kind: "account_login_start",
      loginUrl: "https://auth.openai.com/codex/device",
      userCode: "ABCD-EFGH",
    })).not.toBeNull();
    expect(parseDeviceCommandResultPayload({
      expiresAt: 1,
      handoffVersion: 2,
      kind: "account_login_start",
      loginUrl: "http://auth.openai.com/codex/device",
      userCode: "ABCD-EFGH",
    })).toBeNull();
    // Legacy URL-only results still parse so an updated web client can consume
    // them exactly once and report that the machine must be updated.
    expect(parseDeviceCommandResultPayload({
      expiresAt: 1,
      kind: "account_login_start",
      loginUrl: "https://auth.openai.com/codex/device",
    })).not.toBeNull();
    expect(parseDeviceCommandResultPayload({
      expiresAt: 1,
      handoffVersion: 2,
      kind: "account_login_start",
      loginUrl: "https://auth.openai.com/codex/device",
      userCode: "not a device code",
    })).toBeNull();
    expect(parseDeviceCommandResultPayload({
      expiresAt: 1,
      handoffVersion: 1,
      kind: "account_login_start",
      loginUrl: "https://auth.openai.com/codex/device",
      userCode: "ABCD-EFGH",
    })).toBeNull();
    expect(parseDeviceCommandResultPayload({
      instruction: "No login is in progress.",
      kind: "account_login_status",
      status: "idle",
    })).not.toBeNull();
    expect(parseDeviceCommandResultPayload({
      instruction: "No login is in progress.",
      kind: "account_login_status",
      status: "unknown",
    })).toBeNull();
    expect(parseDeviceCommandResultPayload({ accountsRefreshed: 0, kind: "usage_refresh" }))
      .toEqual({ accountsRefreshed: 0, kind: "usage_refresh" });
    expect(parseDeviceCommandResultPayload({ accountsRefreshed: -1, kind: "usage_refresh" }))
      .toBeNull();
  });

  test("round-trips a device command and its result under their own authorities", async () => {
    const key = randomKeyBytes();
    const commandAuthority = {
      entityPublicId: "018bcfe5-6800-7000-8000-000000000001",
      keyVersion: 1,
      kind: "device_command",
      userPublicId: "user_0000000000000001",
    } as const;
    const resultAuthority = { ...commandAuthority, kind: "device_command_result" } as const;
    const devinSessionStart = { ...sessionStart, preset: "astra", provider: "devin" } as const;
    const legacyEnvelope = await encryptBytes(new TextEncoder().encode(JSON.stringify(devinSessionStart)), key, 1, cloudPayloadAad(commandAuthority));
    await expectPromiseToReject(decryptDeviceCommand(legacyEnvelope, key, commandAuthority));
    const envelope = await encryptDeviceCommand(sessionStart, key, commandAuthority);
    expect(await decryptDeviceCommand(envelope, key, commandAuthority)).toEqual(sessionStart);
    // The two authorities are separate: a command envelope never decrypts as a
    // result, so a relayed login handoff cannot be produced by replaying a request.
    await expectPromiseToReject(decryptDeviceCommandResult(envelope, key, resultAuthority));
    const result = {
      expiresAt: 1_760_000_000_000,
      handoffVersion: 2,
      kind: "account_login_start",
      loginUrl: "https://auth.openai.com/codex/device",
      userCode: "ABCD-EFGH",
    } as const;
    const resultEnvelope = await encryptDeviceCommandResult(result, key, resultAuthority);
    expect(JSON.stringify(resultEnvelope)).not.toContain(result.userCode);
    expect(await decryptDeviceCommandResult(resultEnvelope, key, resultAuthority)).toEqual(result);
  });

  test("the registry switches are additive and default conservatively", () => {
    const base = parseDeviceRegistryPayload(registryFixture());
    expect(base).not.toBeNull();
    expect(base?.accountLinkingAllowed).toBeUndefined();
    expect(base?.deviceCommandsAllowed).toBeUndefined();
    const withSwitches = parseDeviceRegistryPayload({
      ...registryFixture(),
      accountLinkingAllowed: true,
      deviceCommandsAllowed: false,
    });
    expect(withSwitches).toMatchObject({
      accountLinkingAllowed: true,
      deviceCommandsAllowed: false,
    });
    expect(parseDeviceRegistryPayload({
      ...registryFixture(),
      deviceCommandsAllowed: "yes",
    })).toBeNull();
  });
});
