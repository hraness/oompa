import { describe, expect, test } from "bun:test";

import fc from "fast-check";

import { localCommandSchema } from "../domain/contracts";
import {
  CliUsageError,
  claudeAccountLoginAbandonCommand,
  claudeAccountLoginCommand,
  completeProtectedAuthLogin,
  devinAccountLoginAbandonCommand,
  deviceMutationReplayCommand,
  completeProtectedInteraction,
  helpGroupNames,
  parseCli,
  requestsJsonlOutput,
  resolveUsage,
  usage,
  usageForGroup,
} from "./parser";

describe("CLI parser", () => {
  test("detects machine streaming intent only before the literal delimiter", () => {
    expect(requestsJsonlOutput(["session", "events", "release", "--jsonl"])).toBe(true);
    expect(requestsJsonlOutput(["session", "events", "release", "--follow"])).toBe(true);
    expect(requestsJsonlOutput(["session", "watch", "release", "--jsonl"])).toBe(true);
    expect(requestsJsonlOutput(["session", "send", "release", "--", "please use --jsonl"])).toBe(false);
    expect(requestsJsonlOutput(["session", "send", "release", "--", "--follow"])).toBe(false);
  });

  test("parses root status without admitting effects or extra arguments", () => {
    expect(parseCli(["status"])).toEqual({ json: false, kind: "status" });
    expect(parseCli(["status", "--json"])).toEqual({ json: true, kind: "status" });
    expect(() => parseCli(["status", "extra"])).toThrow(CliUsageError);
    expect(() => parseCli(["status", "--jsonl"])).toThrow(
      "supported only by `oompa session events` and `oompa session watch`",
    );
    expect(() => parseCli([
      "status",
      "--idempotency-key",
      "00000000-0000-4000-8000-000000000001",
    ])).toThrow("not supported by status");
  });

  test("parses menubar launch without admitting effects or extra arguments", () => {
    expect(parseCli(["menubar"])).toEqual({ json: false, kind: "menubar" });
    expect(parseCli(["menubar", "--json"])).toEqual({ json: true, kind: "menubar" });
    expect(() => parseCli(["menubar", "extra"])).toThrow(CliUsageError);
  });

  test("keeps the protected login handoff path at the CLI boundary", () => {
    const idempotencyKey = "00000000-0000-4000-8000-000000000101";
    expect(parseCli([
      "account",
      "login",
      "personal account",
      "--device-code",
      "--handoff-file",
      "/private/login/handoff.json",
      "--idempotency-key",
      idempotencyKey,
      "--json",
    ])).toEqual({
      command: {
        account: "personal account",
        deviceCode: true,
        idempotencyKey,
        kind: "account.login",
      },
      handoffFile: "/private/login/handoff.json",
      json: true,
      kind: "account.login-handoff",
      replayCommand: `oompa account login 'personal account' --device-code --idempotency-key ${idempotencyKey} --handoff-file /private/login/handoff.json --json`,
    });
    expect(() => parseCli([
      "account",
      "login",
      "personal",
      "--handoff-file",
      "relative.json",
    ])).toThrow(CliUsageError);
    expect(parseCli(["account", "login", "personal", "--json"])).toMatchObject({
      kind: "account.login-handoff",
      replayCommand: expect.stringContaining("--handoff-file /absolute/path/to/empty-protected-login.json"),
    });
    expect(parseCli(["account", "login", "personal", "--provider", "codex"])).toMatchObject({
      kind: "account.login-handoff",
      command: { account: "personal", deviceCode: false, kind: "account.login" },
    });
  });

  test("keeps Claude login and status in a provider-scoped foreground CLI flow", () => {
    const generated = parseCli(["account", "login", "personal", "--provider", "claude"]);
    expect(generated).toMatchObject({
      command: { account: "personal", kind: "account.claude-login.prepare" },
      json: false,
      kind: "account.claude-login",
    });
    if (generated.kind !== "account.claude-login") throw new Error("expected Claude login");
    expect(generated.command.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/u);
    expect(generated.replayCommand).toContain(generated.command.idempotencyKey);

    const key = "00000000-0000-4000-8000-000000000101";
    expect(parseCli(["account", "login", " personal ", "--provider", "claude", "--idempotency-key", key, "--json"])).toEqual({
      command: { account: "personal", idempotencyKey: key, kind: "account.claude-login.prepare" },
      json: true,
      kind: "account.claude-login",
      replayCommand: `oompa account login personal --provider claude --idempotency-key ${key}`,
    });
    expect(parseCli(["account", "show", "personal", "--provider", "claude", "--json"])).toEqual({
      command: { account: "personal", kind: "account.show", provider: "claude" },
      json: true,
      kind: "command",
    });
    expect(parseCli(["account", "show", "personal", "--provider", "codex"])).toEqual({
      command: { account: "personal", kind: "account.show" },
      json: false,
      kind: "command",
    });

    for (const argv of [
      ["account", "login", "personal", "--provider", "claude", "--device-code"],
      ["account", "login", "personal", "--provider", "claude", "--handoff-file", "/private/login.json"],
      ["account", "login-cancel", "personal", "--provider", "claude"],
      ["account", "login", "personal", "--provider", "other"],
    ]) expect(() => parseCli(argv)).toThrow(CliUsageError);

    expect(() => parseCli(["account", "login", "x".repeat(201), "--provider", "claude", "--json"]))
      .toThrow(CliUsageError);
    expect(() => parseCli(["account", "login", "bad\nselector", "--provider", "claude", "--json"]))
      .toThrow("control characters");
    expect(claudeAccountLoginCommand("work profile; false")).toBe(
      "oompa account login 'work profile; false' --provider claude",
    );

    const attemptId = `attempt_${"a".repeat(32)}`;
    const abandon = claudeAccountLoginAbandonCommand("personal", attemptId, key, 7);
    expect(abandon).toBe(
      `oompa account login-cancel personal --provider claude --attempt-id ${attemptId}`
      + ` --provider-generation 7 --idempotency-key ${key} --acknowledge-child-exited`,
    );
    expect(parseCli(abandon.split(" ").slice(1))).toEqual({
      command: {
        acknowledgeChildExited: true,
        account: "personal",
        attemptId,
        idempotencyKey: key,
        kind: "account.claude-login.abandon",
        providerGeneration: 7,
      },
      json: false,
      kind: "command",
    });
    for (const argv of [
      ["account", "login-cancel", "personal", "--provider", "claude", "--attempt-id", attemptId, "--provider-generation", "7", "--idempotency-key", key],
      ["account", "login-cancel", "personal", "--provider", "claude", "--provider-generation", "7", "--idempotency-key", key, "--acknowledge-child-exited"],
      ["account", "login-cancel", "personal", "--provider", "claude", "--attempt-id", attemptId, "--idempotency-key", key, "--acknowledge-child-exited"],
    ]) expect(() => parseCli(argv)).toThrow(CliUsageError);
  });

  test("retires Devin login while preserving exact local history and cleanup commands", () => {
    expect(parseCli(["account", "show", "personal", "--provider", "devin", "--json"]))
      .toEqual({
        command: { account: "personal", kind: "account.show", provider: "devin" },
        json: true,
        kind: "command",
      });
    for (const argv of [
      ["account", "login", "personal", "--provider", "devin"],
      ["account", "login", "personal", "--provider", "devin", "--manual-token-flow"],
      ["account", "login", "personal", "--provider", "devin", "--device-code"],
      ["account", "login", "personal", "--provider", "devin", "--handoff-file", "/private/login.json"],
      ["account", "login", "personal", "--provider", "codex", "--manual-token-flow"],
      ["account", "login", "personal", "--provider", "claude", "--manual-token-flow"],
      ["account", "login-cancel", "personal", "--provider", "devin"],
    ]) expect(() => parseCli(argv)).toThrow(CliUsageError);

    const key = "00000000-0000-4000-8000-000000000102";
    const attemptId = `attempt_${"b".repeat(32)}`;
    const argv = devinAccountLoginAbandonCommand("personal", attemptId, key, 8).split(" ").slice(1);
    expect(parseCli(argv)).toEqual({
      command: {
        acknowledgeChildExited: true,
        account: "personal",
        attemptId,
        idempotencyKey: key,
        kind: "account.devin-login.abandon",
        providerGeneration: 8,
      },
      json: false,
      kind: "command",
    });
    for (const required of ["--attempt-id", "--provider-generation", "--idempotency-key"]) {
      const incomplete = [...argv];
      incomplete.splice(incomplete.indexOf(required), 2);
      expect(() => parseCli(incomplete)).toThrow(CliUsageError);
    }
    expect(() => parseCli(argv.filter((value) => value !== "--acknowledge-child-exited")))
      .toThrow(CliUsageError);
  });

  test("rejects the retired provider and preset at every active CLI selection boundary", () => {
    for (const argv of [
      ["session", "start", "personal", "--provider", "devin"],
      ["session", "switch", "s", "--provider", "devin"],
      ["remote", "provider", "s", "devin"],
    ]) expect(() => parseCli(argv)).toThrow("Provider must be one of: `codex`, `claude`.");
    for (const argv of [
      ["session", "start", "personal", "--preset", "astra"],
      ["session", "switch", "s", "--provider", "codex", "--preset", "astra"],
      ["session", "preset", "s", "astra"],
      ["remote", "preset", "s", "astra"],
      ["remote", "provider", "s", "codex", "--preset", "astra"],
    ]) expect(() => parseCli(argv)).toThrow("Preset must be one of: `low`, `high`, `ultra`, `fable-max`.");
  });

  test("parses exact pending-login cancellation without accepting provider authority on argv", () => {
    expect(parseCli(["account", "login-cancel", "personal", "--json"])).toEqual({
      command: { kind: "account.login-cancel", account: "personal" },
      json: true,
      kind: "command",
    });
    expect(() => parseCli(["account", "login-cancel", "personal", "provider-login-id"]))
      .toThrow(CliUsageError);
  });

  test("parses bounded UTC account usage-history pages", () => {
    const cursor = `hrau1.${"a".repeat(128)}.${"b".repeat(43)}`;
    expect(parseCli([
      "account",
      "usage-history",
      "personal",
      "--from",
      "2026-08-23T12:00:00Z",
      "--through",
      "2026-08-23T12:05:00.125Z",
      "--limit",
      "37",
      "--cursor",
      cursor,
      "--json",
    ])).toEqual({
      command: {
        kind: "account.usage-history",
        account: "personal",
        fromObservedAt: Date.parse("2026-08-23T12:00:00Z"),
        throughObservedAt: Date.parse("2026-08-23T12:05:00.125Z"),
        limit: 37,
        cursor,
      },
      json: true,
      kind: "command",
    });
    expect(parseCli(["account", "usage-history", "personal"])).toEqual({
      command: {
        kind: "account.usage-history",
        account: "personal",
        limit: 50,
      },
      json: false,
      kind: "command",
    });
    for (const argv of [
      ["account", "usage-history"],
      ["account", "usage-history", "personal", "--limit", "0"],
      ["account", "usage-history", "personal", "--limit", "101"],
      ["account", "usage-history", "personal", "--from", "2026-02-30T00:00:00Z"],
      ["account", "usage-history", "personal", "--through", "2026-08-23T12:00:00+00:00"],
      ["account", "usage-history", "personal", "--cursor", "x".repeat(2_049)],
    ]) expect(() => parseCli(argv)).toThrow(CliUsageError);
  });

  test("maps the recommended session controls", () => {
    expect(parseCli(["session", "start", "work", "--preset", "ultra", "--fast"])).toMatchObject({ kind: "command", command: { kind: "session.start", account: "work", preset: "ultra", fast: true } });
    expect(() => parseCli(["session", "start", "work", "--message", "ship it"])).toThrow("Unexpected argument");
    expect(parseCli(["session", "fast", "session", "off", "--json"])).toEqual({ kind: "command", command: { kind: "session.fast", session: "session", enabled: false }, json: true });
    expect(parseCli(["session", "send", "session", "hello", "from", "the", "CLI"])).toMatchObject({ command: { message: "hello from the CLI" } });
  });

  test("parses the closed owner memory surface and generates replayable mutation keys", () => {
    const continuation = "memc_0123456789abcdef0123456789abcdef";
    expect(parseCli(["memory", "status", "release"])).toEqual({
      command: { kind: "memory.status", session: "release" },
      json: false,
      kind: "command",
    });
    expect(parseCli(["memory", "list", "release", "--continuation", continuation, "--json"]))
      .toEqual({
        command: {
          kind: "memory.query",
          session: "release",
          value: { continuation, mode: "list" },
        },
        json: true,
        kind: "command",
      });
    expect(parseCli(["memory", "get", "release", "architecture.boundary"]))
      .toMatchObject({
        command: {
          kind: "memory.query",
          session: "release",
          value: { key: "architecture.boundary", mode: "get" },
        },
      });
    expect(parseCli([
      "memory", "get", "release", "architecture.boundary", "--working-only",
    ])).toMatchObject({
      command: {
        kind: "memory.query",
        session: "release",
        value: { key: "architecture.boundary", mode: "get", scope: "working" },
      },
    });
    expect(parseCli(["memory", "search", "release", "--", "--authority", "boundary"]))
      .toMatchObject({
        command: {
          kind: "memory.query",
          session: "release",
          value: { mode: "search", text: "--authority boundary" },
        },
      });
    expect(parseCli([
      "memory", "explain", "release", `memq_${"1".repeat(32)}`, "3",
    ])).toMatchObject({
      command: {
        kind: "memory.explain",
        session: "release",
        value: { queryId: `memq_${"1".repeat(32)}`, row: 3 },
      },
    });

    const remembered = parseCli([
      "memory", "remember", "release", "preferences.review",
      "--title", "Review style",
      "--summary", "Prefer adversarial review.",
      "--language", "en",
      "--", "Challenge", "plans", "before", "execution.",
    ]);
    expect(remembered).toMatchObject({
      command: {
        kind: "memory.remember",
        session: "release",
        value: {
          body: "Challenge plans before execution.",
          key: "preferences.review",
          language: "en",
          summary: "Prefer adversarial review.",
          title: "Review style",
        },
      },
    });
    if (remembered.kind !== "command" || remembered.command.kind !== "memory.remember") return;
    expect(remembered.command.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/u);

    const shareKey = "00000000-0000-4000-8000-000000000501";
    expect(parseCli([
      "memory", "share", "release", "preferences.review",
      "--reason", "Reusable project convention",
      "--idempotency-key", shareKey,
    ])).toEqual({
      command: {
        kind: "memory.share",
        session: "release",
        idempotencyKey: shareKey,
        value: { key: "preferences.review", reason: "Reusable project convention" },
      },
      json: false,
      kind: "command",
    });
  });

  test("rejects widened or incoherent owner memory arguments before daemon admission", () => {
    for (const argv of [
      ["memory", "status", "release", "--continuation", "token"],
      ["memory", "status", "release", "--working-only"],
      ["memory", "get", "release", "Not A Key"],
      ["memory", "search", "release"],
      ["memory", "explain", "release", "query", "0"],
      ["memory", "explain", "release", `memq_${"1".repeat(32)}`, "256"],
      ["memory", "remember", "release", "preferences.review", "--summary", "summary", "body"],
      ["memory", "remember", "release", "preferences.review", "--title", "title", "body"],
      ["memory", "share", "release", "preferences.review"],
      ["memory", "share", "release", "preferences.review", "--working-only", "--reason", "x"],
      ["memory", "list", "release", "--idempotency-key", "00000000-0000-4000-8000-000000000502"],
      ["memory", "purge", "release"],
    ]) expect(() => parseCli(argv)).toThrow(CliUsageError);
  });

  test("parses the explicit owner-only hosted memory lifecycle", () => {
    const key = "00000000-0000-4000-8000-000000000503";
    const space = `memory_${"A".repeat(32)}`;
    expect(parseCli(["memory", "hosted", "list", "--json"])).toEqual({
      command: { kind: "memory.hosted.list" },
      json: true,
      kind: "command",
    });
    expect(parseCli([
      "memory", "hosted", "create", "jungle", "--idempotency-key", key,
    ])).toEqual({
      command: { idempotencyKey: key, kind: "memory.hosted.create", project: "jungle" },
      json: false,
      kind: "command",
    });
    expect(parseCli(["memory", "hosted", "attach", "jungle", space]))
      .toMatchObject({ command: { hostedSpaceId: space, kind: "memory.hosted.attach" } });
    expect(parseCli(["memory", "hosted", "detach", "jungle", "--generation", "7"]))
      .toMatchObject({
        command: {
          expectedGeneration: 7,
          kind: "memory.hosted.detach",
          project: "jungle",
        },
      });
    expect(parseCli(["memory", "hosted", "sync", "jungle"]))
      .toMatchObject({ command: { kind: "memory.hosted.sync", project: "jungle" } });
    for (const argv of [
      ["memory", "hosted", "attach", "jungle", "memory_invalid"],
      ["memory", "hosted", "detach", "jungle"],
      ["memory", "hosted", "detach", "jungle", "--generation", "0"],
      ["memory", "hosted", "list", "--working-only"],
      ["memory", "hosted", "purge", "jungle"],
    ]) expect(() => parseCli(argv)).toThrow(CliUsageError);
  });

  test("collects repeated --attach paths and leaves the message untouched", () => {
    // No `--attach` means the exact command the parser always produced.
    expect(parseCli(["session", "send", "s", "hello"])).toMatchObject({
      kind: "command",
      command: { kind: "session.send", message: "hello" },
    });
    for (const action of ["send", "queue", "steer"] as const) {
      expect(parseCli([
        "session", action, "s", "--attach", "a.png", "--attach", "notes.md", "look", "here",
      ])).toMatchObject({
        attach: ["a.png", "notes.md"],
        kind: "session.attach",
        command: { kind: `session.${action}`, message: "look here", session: "s" },
      });
    }
  });

  test("refuses --attach without a value, past the bound, and off a message command", () => {
    expect(() => parseCli(["session", "send", "s", "--attach"]))
      .toThrow("Missing value for --attach.");
    expect(() => parseCli(["session", "send", "s", "--attach", "--attach", "a.png", "hi"]))
      .toThrow("Missing value for --attach.");
    const nine = Array.from({ length: 9 }, (_, index) => ["--attach", `f${String(index)}.txt`]).flat();
    expect(() => parseCli(["session", "send", "s", ...nine, "hi"]))
      .toThrow("At most 8 --attach values are accepted.");
    expect(() => parseCli(["session", "rename", "s", "--attach", "a.png", "new name"]))
      .toThrow("Unknown option");
  });

  test("a literal message word after -- is never read as --attach", () => {
    expect(parseCli(["session", "send", "s", "--", "--attach", "is", "a", "word"]))
      .toMatchObject({ kind: "command", command: { message: "--attach is a word" } });
  });

  test("an attached message still carries its idempotency key", () => {
    const parsed = parseCli(["session", "send", "s", "--attach", "a.png", "hello"]);
    expect(parsed.kind).toBe("session.attach");
    if (parsed.kind !== "session.attach") return;
    expect(typeof parsed.command.idempotencyKey).toBe("string");
    expect(parsed.legacyAttachmentReplay).toBe(false);

    const key = "00000000-0000-4000-8000-000000000209";
    for (const action of ["send", "steer"] as const) {
      const replay = parseCli([
        "session", action, "s", "--attach", "a.png", "hello",
        "--idempotency-key", key,
      ]);
      expect(replay).toMatchObject({
        kind: "session.attach",
        legacyAttachmentReplay: true,
      });
    }
    expect(parseCli([
      "session", "queue", "s", "--attach", "a.png", "hello",
      "--idempotency-key", key,
    ])).toMatchObject({
      kind: "session.attach",
      legacyAttachmentReplay: false,
    });
  });

  test("chooses a session provider and its default preset", () => {
    expect(parseCli(["session", "start", "work"])).toMatchObject({
      command: { kind: "session.start", preset: "ultra", provider: "codex" },
    });
    expect(parseCli(["session", "start", "work", "--preset", "high"])).toMatchObject({
      command: { kind: "session.start", preset: "high", provider: "codex" },
    });
    expect(parseCli(["session", "start", "work", "--provider", "claude"])).toMatchObject({
      command: { kind: "session.start", preset: "fable-max", provider: "claude" },
    });
    expect(parseCli(["session", "start", "work", "--provider", "claude", "--preset", "fable-max"]))
      .toMatchObject({ command: { preset: "fable-max", provider: "claude" } });
    expect(() => parseCli(["session", "start", "work", "--provider", "gemini"]))
      .toThrow("Provider must be one of: `codex`, `claude`.");
    // The preset union is widened; the provider mismatch is refused by the
    // daemon, not by argument parsing.
    expect(parseCli(["session", "preset", "s", "fable-max"]))
      .toMatchObject({ command: { kind: "session.preset", preset: "fable-max" } });
    expect(() => parseCli([
      "session", "preset", "s", "high",
      "--idempotency-key", "00000000-0000-4000-8000-000000000207",
    ])).toThrow("--idempotency-key is not supported by session.preset");
    expect(parseCli(["remote", "preset", "s", "fable-max"]))
      .toMatchObject({ command: { kind: "remote.preset", preset: "fable-max" } });
    expect(() => parseCli(["remote", "preset", "s", "fable"]))
      .toThrow("Preset must be one of: `low`, `high`, `ultra`, `fable-max`.");
  });

  test("authors and preserves the immutable source contract for rebound session starts", () => {
    const generated = parseCli(["session", "start", "work", "--preset", "high"]);
    expect(generated).toMatchObject({
      kind: "command",
      command: {
        kind: "session.start",
        preset: "high",
        presetContract: 1,
      },
    });
    if (generated.kind !== "command" || generated.command.kind !== "session.start") {
      throw new Error("Expected a generated session start command.");
    }
    expect(generated.command.idempotencyKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );

    const idempotencyKey = "00000000-0000-4000-8000-000000000204";
    expect(parseCli([
      "--preset-contract", "2",
      "session", "start", "work", "--preset", "ultra",
      "--idempotency-key", idempotencyKey,
    ])).toMatchObject({
      kind: "command",
      command: {
        idempotencyKey,
        kind: "session.start",
        preset: "ultra",
        presetContract: 2,
      },
    });
    expect(() => parseCli([
      "session", "start", "work", "--preset", "high",
      "--idempotency-key", idempotencyKey,
    ])).toThrow("also requires --preset-contract");
    expect(() => parseCli([
      "session", "start", "work", "--preset", "high", "--preset-contract", "2",
    ])).toThrow("requires an explicit --idempotency-key");
  });

  test("keeps stable starts byte-compatible and rejects source contracts elsewhere", () => {
    const idempotencyKey = "00000000-0000-4000-8000-000000000205";
    const stable = parseCli([
      "session", "start", "work", "--provider", "claude",
      "--idempotency-key", idempotencyKey,
    ]);
    if (stable.kind !== "command") throw new Error("Expected a stable session start command.");
    const priorByteShape = {
      kind: "session.start",
      account: "work",
      provider: "claude",
      preset: "fable-max",
      fast: false,
      idempotencyKey,
    };
    expect(JSON.stringify(stable.command)).toBe(JSON.stringify(priorByteShape));
    for (const argv of [
      ["session", "start", "work", "--provider", "claude", "--preset-contract", "1", "--idempotency-key", idempotencyKey],
      ["session", "status", "session", "--preset-contract", "1"],
      ["status", "--preset-contract", "1"],
      ["session", "start", "work", "--preset-contract", "3", "--idempotency-key", idempotencyKey],
    ]) expect(() => parseCli(argv)).toThrow(CliUsageError);
  });

  test("parses a provider switch, an export, and the remote provider command", () => {
    const stableSwitch = parseCli(["session", "switch", "s", "--provider", "claude"]);
    expect(stableSwitch)
      .toMatchObject({ command: { kind: "session.switch", provider: "claude", session: "s" } });
    if (
      stableSwitch.kind !== "command"
      || stableSwitch.command.kind !== "session.switch"
    ) throw new Error("Expected a stable provider switch.");
    expect(stableSwitch.command.idempotencyKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    const reboundSwitch = parseCli([
      "session", "switch", "s", "--provider", "codex", "--preset", "ultra", "--account", "work",
    ]);
    expect(reboundSwitch).toMatchObject({
      command: {
        account: "work",
        kind: "session.switch",
        preset: "ultra",
        presetContract: 1,
        provider: "codex",
      },
    });
    if (
      reboundSwitch.kind !== "command"
      || reboundSwitch.command.kind !== "session.switch"
    ) throw new Error("Expected a rebound provider switch.");
    expect(reboundSwitch.command.idempotencyKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(parseCli(["session", "switch", "s", "--provider", "codex"]))
      .toMatchObject({ command: { presetContract: 1, provider: "codex" } });
    const switchReplayKey = "00000000-0000-4000-8000-000000000206";
    expect(parseCli([
      "session", "switch", "s", "--provider", "codex", "--preset", "high",
      "--idempotency-key", switchReplayKey, "--preset-contract", "2",
    ])).toMatchObject({
      command: {
        idempotencyKey: switchReplayKey,
        preset: "high",
        presetContract: 2,
        provider: "codex",
      },
    });
    expect(() => parseCli([
      "session", "switch", "s", "--provider", "codex", "--preset", "high",
      "--idempotency-key", switchReplayKey,
    ])).toThrow("also requires --preset-contract");
    expect(() => parseCli([
      "session", "switch", "s", "--provider", "codex", "--preset-contract", "2",
    ])).toThrow("requires an explicit --idempotency-key");
    expect(parseCli([
      "session", "switch", "s", "--provider", "claude",
      "--idempotency-key", switchReplayKey,
    ])).toMatchObject({
      command: {
        idempotencyKey: switchReplayKey,
        provider: "claude",
      },
    });
    expect(() => parseCli([
      "session", "switch", "s", "--provider", "claude",
      "--idempotency-key", switchReplayKey, "--preset-contract", "1",
    ])).toThrow("supported only for a source-sensitive Codex provider switch");
    expect(() => parseCli(["session", "switch", "s"]))
      .toThrow("Missing value for --provider.");
    expect(() => parseCli(["session", "switch", "s", "--provider", "gemini"]))
      .toThrow("Provider must be one of: `codex`, `claude`.");

    expect(parseCli(["session", "export", "s"]))
      .toMatchObject({ format: "trajectory", kind: "session.export", session: "s" });
    expect(parseCli(["session", "export", "s", "--format", "json", "--out", "out.json"]))
      .toMatchObject({ format: "json", kind: "session.export", out: "out.json", session: "s" });
    expect(() => parseCli(["session", "export", "s", "--format", "csv"]))
      .toThrow("Export format must be `trajectory` or `json`.");

    expect(parseCli(["remote", "provider", "s", "claude"]))
      .toMatchObject({ command: { kind: "remote.provider", provider: "claude", session: "s" } });
    expect(parseCli(["remote", "provider", "s", "claude", "--preset", "fable-max"]))
      .toMatchObject({ command: { kind: "remote.provider", preset: "fable-max" } });
    expect(() => parseCli(["remote", "provider", "s", "gemini"]))
      .toThrow("Provider must be one of: `codex`, `claude`.");
  });

  test("parses conversation-bound session task reads with exact task IDs", () => {
    const task = `stask_${"a".repeat(32)}`;
    expect(parseCli(["session", "task", "list", "Release work", "--json"]))
      .toEqual({
        command: { kind: "session.task.list", session: "Release work" },
        json: true,
        kind: "command",
      });
    expect(parseCli(["session", "task", "show", "Release work", task]))
      .toEqual({
        command: { kind: "session.task.show", session: "Release work", task },
        json: false,
        kind: "command",
      });
    for (const argv of [
      ["session", "task", "show", "Release work", "daily-review"],
      ["session", "task", "list", "Release work", "--"],
      ["session", "task", "show", "Release work", task, "--", "prompt"],
    ]) expect(() => parseCli(argv)).toThrow(CliUsageError);
  });

  test("creates interval tasks with a required literal prompt and durable key", () => {
    const idempotencyKey = "00000000-0000-4000-8000-000000000201";
    expect(parseCli([
      "session",
      "task",
      "create",
      "Release work",
      "--name",
      "Daily review",
      "--every-minutes",
      "1440",
      "--paused",
      "--idempotency-key",
      idempotencyKey,
      "--",
      "review",
      "--help",
      "literally",
    ])).toEqual({
      command: {
        everyMinutes: 1440,
        idempotencyKey,
        kind: "session.task.create",
        name: "Daily review",
        paused: true,
        prompt: "review --help literally",
        session: "Release work",
      },
      json: false,
      kind: "command",
    });

    const generated = parseCli([
      "session",
      "task",
      "create",
      "release",
      "--name",
      "Quarter hour",
      "--every-minutes",
      "15",
      "--",
      "check",
    ]);
    expect(generated).toMatchObject({
      command: {
        everyMinutes: 15,
        kind: "session.task.create",
        paused: false,
        prompt: "check",
      },
    });
    if (generated.kind !== "command" || generated.command.kind !== "session.task.create") {
      throw new Error("Expected a session task create command.");
    }
    expect(generated.command.idempotencyKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );

    for (const argv of [
      ["session", "task", "create", "release", "--name", "No delimiter", "--every-minutes", "15", "plain", "prompt"],
      ["session", "task", "create", "release", "--name", "Empty prompt", "--every-minutes", "15", "--"],
      ["session", "task", "create", "release", "--name", "Too fast", "--every-minutes", "14", "--", "prompt"],
      ["session", "task", "create", "release", "--name", "Too slow", "--every-minutes", "10081", "--", "prompt"],
      ["session", "task", "create", "release", "--name", "Standalone", "--every-minutes", "15", "--destination", "local", "--", "prompt"],
      ["session", "task", "create", "--", "release", "prompt"],
    ]) expect(() => parseCli(argv)).toThrow(CliUsageError);
  });

  test("parses compare-and-swap task edits and exact deletion", () => {
    const task = `stask_${"b".repeat(32)}`;
    const idempotencyKey = "00000000-0000-4000-8000-000000000202";
    expect(parseCli([
      "session",
      "task",
      "edit",
      "release",
      task,
      "--revision",
      "3",
      "--name",
      "Release review",
      "--every-minutes",
      "60",
      "--resume",
      "--idempotency-key",
      idempotencyKey,
      "--",
      "inspect",
      "the queue",
    ])).toEqual({
      command: {
        everyMinutes: 60,
        expectedRevision: 3,
        idempotencyKey,
        kind: "session.task.edit",
        name: "Release review",
        prompt: "inspect the queue",
        session: "release",
        status: "active",
        task,
      },
      json: false,
      kind: "command",
    });
    expect(parseCli([
      "session",
      "task",
      "edit",
      "release",
      task,
      "--revision",
      "4",
      "--pause",
    ])).toMatchObject({
      command: { expectedRevision: 4, kind: "session.task.edit", status: "paused", task },
    });
    expect(parseCli([
      "session",
      "task",
      "delete",
      "release",
      task,
      "--revision",
      "5",
      "--idempotency-key",
      idempotencyKey,
    ])).toEqual({
      command: {
        expectedRevision: 5,
        idempotencyKey,
        kind: "session.task.delete",
        session: "release",
        task,
      },
      json: false,
      kind: "command",
    });

    for (const argv of [
      ["session", "task", "edit", "release", task, "--revision", "3"],
      ["session", "task", "edit", "release", task, "--revision", "3", "--pause", "--resume"],
      ["session", "task", "edit", "release", task, "--revision", "0", "--pause"],
      ["session", "task", "edit", "release", task, "--revision", "3", "--"],
      ["session", "task", "delete", "release", task],
      ["session", "task", "delete", "release", task, "--revision", "3", "--"],
      ["session", "task", "delete", "release", "mutable-title", "--revision", "3"],
    ]) expect(() => parseCli(argv)).toThrow(CliUsageError);
  });

  test("parses bounded opaque session-list continuations", () => {
    const cursor = `hra1.${"a".repeat(128)}.${"b".repeat(43)}`;
    expect(parseCli([
      "session",
      "list",
      "--account",
      "mutable-label",
      "--limit",
      "37",
      "--cursor",
      cursor,
      "--json",
    ])).toEqual({
      kind: "command",
      command: {
        kind: "session.list",
        account: "mutable-label",
        archived: false,
        limit: 37,
        cursor,
      },
      json: true,
    });
    expect(() => parseCli(["session", "list", "--cursor", "x".repeat(2_049)]))
      .toThrow(CliUsageError);
    expect(() => parseCli(["session", "list", "--limit", "1.5"]))
      .toThrow("session limit must be an integer from 1 to 100");
  });

  test("parses session archive, unarchive, and the archived listing filter", () => {
    expect(parseCli(["session", "archive", "sess-1"]))
      .toEqual({ kind: "command", command: { kind: "session.archive", session: "sess-1", archived: true }, json: false });
    expect(parseCli(["session", "unarchive", "sess-1"]))
      .toEqual({ kind: "command", command: { kind: "session.archive", session: "sess-1", archived: false }, json: false });
    expect(parseCli(["session", "list", "--archived"]))
      .toEqual({ kind: "command", command: { kind: "session.list", archived: true, limit: 50 }, json: false });
    expect(parseCli(["session", "list"]))
      .toMatchObject({ command: { archived: false } });
    for (const argv of [
      ["session", "archive"],
      ["session", "archive", "sess-1", "extra"],
      ["session", "unarchive"],
    ]) expect(() => parseCli(argv)).toThrow(CliUsageError);
  });

  test("parses personal-home session adoption controls", () => {
    expect(parseCli(["session", "adoption", "status"]))
      .toEqual({ kind: "command", command: { kind: "session.adoption.status" }, json: false });
    expect(parseCli(["session", "adoption", "status", "--provider", "claude", "--json"]))
      .toEqual({
        kind: "command",
        command: { kind: "session.adoption.status", provider: "claude" },
        json: true,
      });
    expect(parseCli(["session", "adoption", "enable", "personal", "--provider", "codex"]))
      .toMatchObject({
        command: {
          account: "personal",
          enabled: true,
          kind: "session.adoption.set",
          provider: "codex",
        },
      });
    expect(parseCli(["session", "adoption", "disable", "--provider", "claude"]))
      .toMatchObject({
        command: { enabled: false, kind: "session.adoption.set", provider: "claude" },
      });
    expect(parseCli(["session", "discover", "--provider", "codex"]))
      .toMatchObject({ command: { kind: "session.adoption.discover", provider: "codex" } });

    for (const argv of [
      ["session", "adoption", "enable", "personal"],
      ["session", "adoption", "disable"],
      ["session", "adoption", "status", "--provider", "other"],
      ["session", "discover", "--provider", "other"],
      ["session", "detach", "working-session"],
      ["session", "detach"],
    ]) expect(() => parseCli(argv)).toThrow(CliUsageError);
  });

  test("keeps Devin outside every personal-home adoption command and transport shape", () => {
    for (const argv of [
      ["session", "adoption", "status", "--provider", "devin"],
      ["session", "adoption", "enable", "personal", "--provider", "devin"],
      ["session", "adoption", "disable", "--provider", "devin"],
      ["session", "discover", "--provider", "devin"],
    ]) {
      expect(() => parseCli(argv)).toThrow("Provider must be one of: `codex`, `claude`.");
    }

    for (const command of [
      { kind: "session.adoption.status", provider: "devin" },
      { account: "personal", enabled: true, kind: "session.adoption.set", provider: "devin" },
      { kind: "session.adoption.discover", provider: "devin" },
    ]) expect(localCommandSchema.safeParse(command).success).toBe(false);
  });

  test("maps cloud session reads and the closed remote command set", () => {
    const idempotencyKey = "018bcfe5-6800-7000-8000-000000000001";
    expect(parseCli(["remote", "list", "--limit", "25", "--json"])).toEqual({
      kind: "remote",
      command: { kind: "remote.list", limit: 25 },
      json: true,
    });
    expect(parseCli([
      "remote",
      "send",
      "session_12345678",
      "--idempotency-key",
      idempotencyKey,
      "--",
      "continue",
      "--carefully",
    ])).toEqual({
      kind: "remote",
      command: {
        kind: "remote.send",
        message: "continue --carefully",
        session: "session_12345678",
      },
      idempotencyKey,
      json: false,
    });
    expect(parseCli(["remote", "preset", "session_12345678", "low"]))
      .toEqual({
        kind: "remote",
        command: { kind: "remote.preset", preset: "low", session: "session_12345678" },
        json: false,
      });
    expect(parseCli(["remote", "fast", "session_12345678", "on"]))
      .toMatchObject({ command: { enabled: true, kind: "remote.fast" } });
    expect(parseCli(["remote", "command", idempotencyKey, "--json"])).toEqual({
      command: { commandPublicId: idempotencyKey, kind: "remote.command" },
      json: true,
      kind: "remote",
    });
    expect(() => parseCli(["remote", "command", "not-a-command"])).toThrow(CliUsageError);
    expect(() => parseCli(["remote", "list", "--idempotency-key", idempotencyKey]))
      .toThrow(CliUsageError);
  });

  test("routes the device command switches to the daemon, not to the cloud", () => {
    // These are local daemon state. Nothing hosted, and no browser, can set
    // them, so they parse as ordinary local commands rather than as a remote
    // invocation that would travel through the cloud transport.
    expect(parseCli(["remote", "deny", "device-commands"])).toEqual({
      kind: "command",
      command: { allowed: false, kind: "remote.policy-set", switch: "device-commands" },
      json: false,
    });
    expect(parseCli(["remote", "allow", "account-linking", "--json"])).toEqual({
      kind: "command",
      command: { allowed: true, kind: "remote.policy-set", switch: "account-linking" },
      json: true,
    });
    expect(parseCli(["remote", "policy", "--json"])).toEqual({
      kind: "command",
      command: { kind: "remote.policy-status" },
      json: true,
    });
    expect(() => parseCli(["remote", "allow", "everything"])).toThrow(CliUsageError);
    expect(() => parseCli(["remote", "allow"])).toThrow(CliUsageError);
    expect(() => parseCli(["remote", "policy", "extra"])).toThrow(CliUsageError);
    expect(() => parseCli([
      "remote",
      "deny",
      "device-commands",
      "--idempotency-key",
      "018bcfe5-6800-7000-8000-000000000001",
    ])).toThrow(CliUsageError);
  });

  test("binds a relative project directory to the invoking CLI cwd", () => {
    expect(parseCli(["project", "add", ".", "--name", "Workspace"], "/caller/workspace")).toEqual({
      kind: "command",
      command: { kind: "project.add", label: "Workspace", path: "/caller/workspace" },
      json: false,
    });
  });

  test("rejects unknown flags instead of ignoring them", () => {
    expect(() => parseCli(["account", "list", "--surprise"])).toThrow(CliUsageError);
    for (const argv of [
      ["daemon", "run", "--state-root", "/tmp/other"],
      ["daemon", "run", "--socket", "/tmp/other.sock"],
      ["daemon", "run", "--capability", "/tmp/other.capability"],
      ["daemon", "run", "--live-acceptance-fd", "3"],
    ]) {
      expect(() => parseCli(argv)).toThrow(CliUsageError);
    }
  });

  test("never repeats unknown argv values in usage errors", () => {
    const protectedLookingValue = "token=do-not-repeat\u001b]52;c;attack\u0007";
    for (const argv of [
      [protectedLookingValue],
      ["account", protectedLookingValue],
      ["account", "list", protectedLookingValue],
      ["account", "add", "work", `--${protectedLookingValue}`],
    ]) {
      try {
        parseCli(argv);
        throw new Error("Expected argv rejection.");
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(CliUsageError);
        expect((error as Error).message).not.toContain("do-not-repeat");
        expect((error as Error).message).not.toContain("\u001b");
        expect((error as Error).message).not.toContain("\u0007");
      }
    }
  });

  test("keeps destructive local profile and project deletion out of the beta surface", () => {
    expect(() => parseCli(["account", "remove", "work"])).toThrow(CliUsageError);
    expect(() => parseCli(["project", "remove", "workspace"])).toThrow(CliUsageError);
  });

  test("keeps cloud identity credentials off argv and accepts only exact protected documents", () => {
    const stdin = parseCli(["auth", "login", "--input-stdin", "--json"]);
    expect(stdin).toEqual({ input: { kind: "stdin" }, json: true, kind: "auth.login-protected" });
    const descriptor = parseCli(["auth", "login", "--input-fd", "7"]);
    expect(descriptor).toEqual({ input: { fd: 7, kind: "fd" }, json: false, kind: "auth.login-protected" });
    if (stdin.kind !== "auth.login-protected") throw new Error("Expected protected auth input.");

    expect(completeProtectedAuthLogin(stdin, { email: "person@example.com" })).toEqual({
      email: "person@example.com",
      kind: "auth.login",
    });
    expect(completeProtectedAuthLogin(stdin, {
      email: "person@example.com",
      invite: `hra_invite_identity_v1_${"a".repeat(43)}`,
    })).toEqual({
      email: "person@example.com",
      invite: `hra_invite_identity_v1_${"a".repeat(43)}`,
      kind: "auth.login",
    });
    expect(completeProtectedAuthLogin(stdin, {
      code: "01234567",
      email: "person@example.com",
    })).toEqual({ code: "01234567", email: "person@example.com", kind: "auth.login" });

    for (const argv of [
      ["auth", "login"],
      ["auth", "login", "person@example.com", "--input-stdin"],
      ["auth", "login", "--email", "person@example.com", "--input-stdin"],
      ["auth", "login", "--code", "01234567", "--input-stdin"],
      ["auth", "login", "--invite", "secret", "--input-stdin"],
      ["auth", "login", "--input-stdin", "--input-fd", "7"],
      ["auth", "login", "--input-fd", "1"],
      ["auth", "login", "--input-fd", "2"],
    ]) expect(() => parseCli(argv)).toThrow(CliUsageError);

    for (const document of [
      { code: "0123456", email: "person@example.com" },
      { code: "01234567", email: "person@example.com", invite: `hra_invite_identity_v1_${"a".repeat(43)}` },
      { email: "Person@example.com" },
      { email: "person@example.com", unexpected: true },
    ]) expect(() => completeProtectedAuthLogin(stdin, document)).toThrow(CliUsageError);
  });

  test("requires the literal account-erasure acknowledgement before creating a command", () => {
    expect(parseCli(["auth", "delete", "--acknowledge-erasure", "--json"]))
      .toEqual({
        command: { acknowledgeErasure: true, kind: "auth.delete" },
        json: true,
        kind: "command",
      });
    for (const argv of [
      ["auth", "delete"],
      ["auth", "delete", "--acknowledge-erasure=false"],
      ["auth", "delete", "--acknowledge-erasure", "extra"],
      [
        "auth",
        "delete",
        "--acknowledge-erasure",
        "--idempotency-key",
        "018bcfe5-6800-7000-8000-000000000001",
      ],
    ]) expect(() => parseCli(argv)).toThrow(CliUsageError);
  });

  test("parses read-only plugin discovery and explicitly rejects every lifecycle effect", () => {
    expect(parseCli([
      "plugin",
      "list",
      "work",
      "--project",
      "release",
      "--refresh",
      "--json",
    ])).toEqual({
      command: {
        account: "work",
        kind: "plugin.list",
        project: "release",
        refresh: true,
      },
      json: true,
      kind: "command",
    });
    expect(parseCli(["plugin", "show", "work", "Files", "--refresh"]))
      .toEqual({
        command: {
          account: "work",
          kind: "plugin.show",
          plugin: "Files",
          refresh: true,
        },
        json: false,
        kind: "command",
      });

    for (const action of ["install", "enable", "disable", "oauth", "authorize"]) {
      expect(() => parseCli(["plugin", action, "work", "files@official"]))
        .toThrow("no safe separated plugin lifecycle effect");
    }
  });

  test("preserves option-like message text after the conventional delimiter", () => {
    expect(parseCli(["session", "send", "session", "--", "please", "run", "--help", "with", "--json"])).toMatchObject({
      kind: "command",
      json: false,
      command: { kind: "session.send", message: "please run --help with --json" },
    });
  });

  test("binds an explicit idempotency key to a mutation while preserving literal payload flags", () => {
    const idempotencyKey = "00000000-0000-4000-8000-000000000104";
    expect(parseCli(["session", "send", "session", "--idempotency-key", idempotencyKey, "--", "use", "--help"])).toMatchObject({
      command: { kind: "session.send", idempotencyKey, message: "use --help" },
    });
    expect(parseCli(["account", "switch", "personal", "--idempotency-key", idempotencyKey])).toMatchObject({
      command: { kind: "account.switch", account: "personal", idempotencyKey },
    });
    expect(() => parseCli(["account", "list", "--idempotency-key", idempotencyKey])).toThrow(CliUsageError);
  });

  test("generates a discoverable desktop-switch key before transport and parses recovery", () => {
    const invocation = parseCli(["account", "switch", "personal"]);
    expect(invocation).toMatchObject({
      kind: "command",
      command: { kind: "account.switch", account: "personal" },
      json: false,
    });
    if (invocation.kind !== "command" || invocation.command.kind !== "account.switch") {
      throw new Error("Expected an account switch command.");
    }
    expect(invocation.command.idempotencyKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(parseCli(["account", "switch-recover", "--json"])).toEqual({
      kind: "command",
      command: { kind: "account.switch-recover" },
      json: true,
    });
  });

  test("generates discoverable keys at the CLI boundary for every provider-effect command", () => {
    const commands = [
      ["account", "login", "work"],
      ["account", "logout", "work"],
      ["session", "start", "work"],
      ["session", "send", "session", "hello"],
      ["session", "queue", "session", "hello"],
      ["session", "steer", "session", "hello"],
      ["session", "stop", "session"],
      ["session", "rename", "session", "New name"],
    ] as const;
    for (const argv of commands) {
      const invocation = parseCli(argv);
      if (invocation.kind === "account.login-handoff") {
        expect(invocation.command.idempotencyKey).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
        );
        continue;
      }
      if (invocation.kind !== "command" || !("idempotencyKey" in invocation.command)) {
        throw new Error(`Expected ${argv.join(" ")} to carry a key.`);
      }
      expect(invocation.command.idempotencyKey).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      );
    }
  });

  test("generates and preserves one current UUIDv7 for each device mutation", () => {
    const generated = parseCli([
      "device",
      "approve",
      "device_target",
      "--fingerprint",
      "0000-1111-2222-3333-4444-5555-6666-7777",
    ]);
    if (generated.kind !== "command" || generated.command.kind !== "device.approve") {
      throw new Error("Expected a device approval command.");
    }
    expect(generated.command.idempotencyKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );

    const explicit = generated.command.idempotencyKey;
    expect(parseCli([
      "device",
      "revoke",
      "device_target",
      "--idempotency-key",
      explicit,
    ])).toMatchObject({
      command: { device: "device_target", idempotencyKey: explicit, kind: "device.revoke" },
      kind: "command",
    });
    expect(() => parseCli([
      "device",
      "approve",
      "device_target",
      "--fingerprint",
      "0000-1111-2222-3333-4444-5555-6666-7777",
      "--idempotency-key",
      "00000000-0000-4000-8000-000000000001",
    ])).toThrow("current UUIDv7");
  });

  test("binds device approval to a displayed key fingerprint", () => {
    const fingerprint = "8144-52ea-9db6-227b-786f-8c8c-eec0-6435";
    const approval = parseCli(["device", "approve", "device_target", "--fingerprint", fingerprint]);
    if (approval.kind !== "command" || approval.command.kind !== "device.approve") {
      throw new Error("Expected a device approval command.");
    }
    expect(approval.command.fingerprint).toBe(fingerprint);
    expect(deviceMutationReplayCommand(approval.command, true)).toBe(
      "oompa device approve device_target"
      + ` --fingerprint ${fingerprint}`
      + ` --idempotency-key ${approval.command.idempotencyKey} --json`,
    );

    expect(() => parseCli(["device", "approve", "device_target"]))
      .toThrow("requires --fingerprint");
    expect(() => parseCli(["device", "approve", "device_target", "--fingerprint", "nope"]))
      .toThrow("eight lower-case hex groups");
    expect(() => parseCli([
      "device",
      "approve",
      "device_target",
      "--fingerprint",
      fingerprint.toUpperCase(),
    ])).toThrow("eight lower-case hex groups");
    expect(() => parseCli(["device", "revoke", "device_target", "--fingerprint", fingerprint]))
      .toThrow();
  });

  test("parses only the exact local account-key loss acknowledgement", () => {
    expect(parseCli([
      "device",
      "key-loss",
      "--acknowledge-no-key-holders",
      "--json",
    ])).toEqual({
      command: {
        acknowledgeNoKeyHolders: true,
        kind: "device.key-loss",
      },
      json: true,
      kind: "command",
    });
    for (const argv of [
      ["device", "key-loss"],
      ["device", "key-loss", "--acknowledge"],
      ["device", "key-loss", "--acknowledge-no-key-holders", "extra"],
      [
        "device",
        "key-loss",
        "--acknowledge-no-key-holders",
        "--acknowledge-no-key-holders",
      ],
      [
        "device",
        "key-loss",
        "--acknowledge-no-key-holders",
        "--idempotency-key",
        "018bcfe5-6800-7000-8000-000000000099",
      ],
    ] as const) {
      expect(() => parseCli(argv)).toThrow(CliUsageError);
    }
  });

  test("admits append-only projection recovery only with an explicit gap acknowledgement", () => {
    const warning = parseCli([
      "sync",
      "projection",
      "recover",
      "My session",
      "--json",
    ]);
    expect(warning).toMatchObject({
      error: {
        code: "INTERACTION_REQUIRED",
        details: {
          acknowledgementRequired: "--acknowledge-gap",
        },
      },
      json: true,
      kind: "interaction-required",
    });
    if (warning.kind !== "interaction-required") {
      throw new Error("Expected projection recovery acknowledgement admission.");
    }
    const { idempotencyKey, nextCommand } = warning.error.details;
    expect(idempotencyKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(nextCommand).toBe(
      `oompa sync projection recover 'My session' --acknowledge-gap --idempotency-key ${idempotencyKey} --json`,
    );

    expect(parseCli([
      "sync",
      "projection",
      "recover",
      "My session",
      "--acknowledge-gap",
      "--idempotency-key",
      idempotencyKey,
      "--json",
    ])).toEqual({
      command: {
        acknowledgeGap: true,
        idempotencyKey,
        kind: "sync.projection-recover",
        session: "My session",
      },
      json: true,
      kind: "sync.projection-recover",
      replayCommand: nextCommand,
    });
  });

  test("generates a current UUIDv7 and preserves an older canonical projection-recovery key", () => {
    const invocation = parseCli([
      "sync",
      "projection",
      "recover",
      "sess_12345678",
      "--acknowledge-gap",
    ]);
    expect(invocation).toMatchObject({
      command: {
        acknowledgeGap: true,
        kind: "sync.projection-recover",
        session: "sess_12345678",
      },
      json: false,
      kind: "sync.projection-recover",
    });
    if (invocation.kind !== "sync.projection-recover") {
      throw new Error("Expected an admitted projection recovery.");
    }
    expect(invocation.command.idempotencyKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(invocation.replayCommand).toContain(invocation.command.idempotencyKey);
    expect(invocation.replayCommand).toContain("sess_12345678");
    const explicit = "018bcfe5-6800-7000-8000-000000000001";
    expect(parseCli([
      "sync",
      "projection",
      "recover",
      "sess_12345678",
      "--acknowledge-gap",
      "--idempotency-key",
      explicit,
    ])).toMatchObject({
      command: { idempotencyKey: explicit, kind: "sync.projection-recover" },
      kind: "sync.projection-recover",
    });
    expect(() => parseCli([
      "sync",
      "projection",
      "recover",
      "sess_12345678",
      "--acknowledge-gap",
      "--idempotency-key",
      "00000000-0000-4000-8000-000000000001",
    ])).toThrow("UUIDv7");
    expect(() => parseCli([
      "sync",
      "projection",
      "recover",
      "sess_12345678",
      "--acknowledge-gap",
      "--idempotency-key",
      "not-a-uuid",
    ])).toThrow("UUIDv7");
  });

  test("shell-quotes the acknowledgement command without admitting unknown recovery options", () => {
    const invocation = parseCli([
      "sync",
      "projection",
      "recover",
      "team's $(unsafe) session",
    ]);
    if (invocation.kind !== "interaction-required") {
      throw new Error("Expected an acknowledgement warning.");
    }
    expect(invocation.error.details.nextCommand).toContain(
      `'team'\\''s $(unsafe) session'`,
    );
    expect(() => parseCli([
      "sync",
      "projection",
      "recover",
      "sess_12345678",
      "--acknowledge-gap",
      "--force",
    ])).toThrow(CliUsageError);
    expect(() => parseCli(["sync", "projection", "reset", "sess_12345678"]))
      .toThrow(CliUsageError);
  });

  test("parses exact peer-policy reads and compare-and-set updates", () => {
    expect(parseCli(["session", "peer-policy", "get", "release", "--json"]))
      .toEqual({
        command: { kind: "session.peer-policy.get", session: "release" },
        json: true,
        kind: "command",
      });
    expect(parseCli([
      "session",
      "peer-policy",
      "set",
      "release",
      "inspect",
      "--revision",
      "7",
    ])).toEqual({
      command: {
        expectedRevision: 7,
        kind: "session.peer-policy.set",
        mode: "inspect",
        session: "release",
      },
      json: false,
      kind: "command",
    });

    for (const argv of [
      ["session", "peer-policy", "set", "release", "off"],
      ["session", "peer-policy", "set", "release", "on", "--revision", "1"],
      ["session", "peer-policy", "set", "release", "coordinate", "--revision", "0"],
      ["session", "peer-policy", "get", "release", "--revision", "1"],
      ["session", "peer-policy", "get", "release", "extra"],
      ["session", "peer-policy", "replace", "release"],
    ]) expect(() => parseCli(argv)).toThrow(CliUsageError);

    expect(resolveUsage("session", "peer-policy").usage).toContain([
      "Usage:",
      "  oompa session peer-policy get <session> [--json]",
      "  oompa session peer-policy set <session> <off|inspect|coordinate> --revision <n> [--json]",
    ].join("\n"));
  });

  test("parses bounded session status, event pages, follow mode, and interactions", () => {
    const eventCursor = `hra1.Y3Vyc29yLXYx.${"A".repeat(43)}`;
    expect(parseCli(["session", "status", "release"])).toEqual({
      command: { kind: "session.status", session: "release" },
      json: false,
      kind: "command",
    });
    expect(parseCli(["session", "state", "release", "--json"])).toEqual({
      command: { kind: "session.state", session: "release" },
      json: true,
      kind: "command",
    });
    expect(parseCli([
      "session",
      "events",
      "release",
      "--cursor",
      eventCursor,
      "--limit",
      "80",
      "--wait-ms",
      "2500",
      "--json",
    ])).toEqual({
      command: {
        cursor: eventCursor,
        kind: "session.events",
        limit: 80,
        session: "release",
        waitMs: 2_500,
      },
      json: true,
      kind: "command",
    });
    expect(parseCli(["session", "events", "release", "--follow"])).toEqual({
      command: {
        kind: "session.events",
        limit: 200,
        session: "release",
        waitMs: 30_000,
      },
      jsonl: true,
      kind: "session.events.follow",
    });
    expect(parseCli(["session", "events", "release", "--jsonl"])).toEqual({
      command: {
        kind: "session.events",
        limit: 200,
        session: "release",
        waitMs: 30_000,
      },
      jsonl: true,
      kind: "session.events.follow",
    });
    expect(parseCli(["session", "events", "release", "--follow", "--jsonl"])).toEqual({
      command: {
        kind: "session.events",
        limit: 200,
        session: "release",
        waitMs: 30_000,
      },
      jsonl: true,
      kind: "session.events.follow",
    });
    expect(parseCli(["session", "watch", "release"])).toEqual({
      command: {
        kind: "session.events",
        limit: 200,
        session: "release",
        waitMs: 30_000,
      },
      jsonl: false,
      kind: "session.events.watch",
    });
    expect(parseCli([
      "session",
      "watch",
      "release",
      "--cursor",
      eventCursor,
      "--jsonl",
    ])).toEqual({
      command: {
        cursor: eventCursor,
        kind: "session.events",
        limit: 200,
        session: "release",
        waitMs: 30_000,
      },
      jsonl: true,
      kind: "session.events.watch",
    });
    expect(parseCli([
      "session",
      "events",
      "release",
      "--jsonl",
      "--wait-ms",
      "2500",
    ])).toEqual({
      command: {
        kind: "session.events",
        limit: 200,
        session: "release",
        waitMs: 2_500,
      },
      jsonl: true,
      kind: "session.events.follow",
    });
    expect(() => parseCli(["session", "events", "release", "--follow", "--json"]))
      .toThrow("already JSON Lines");
    expect(() => parseCli(["session", "events", "release", "--jsonl", "--json"]))
      .toThrow("mutually exclusive");
    expect(() => parseCli(["session", "status", "release", "--jsonl"]))
      .toThrow("supported only by `oompa session events` and `oompa session watch`");
    expect(() => parseCli(["account", "list", "--jsonl"]))
      .toThrow("supported only by `oompa session events` and `oompa session watch`");
    expect(() => parseCli(["session", "watch", "release", "--json"]))
      .toThrow("does not support --json");
    expect(() => parseCli(["session", "watch", "release", "--follow"]))
      .toThrow(CliUsageError);
    expect(() => parseCli(["session", "watch", "release", "--limit", "1"]))
      .toThrow(CliUsageError);
    expect(() => parseCli(["session", "watch", "release", "--wait-ms", "1"]))
      .toThrow(CliUsageError);
    expect(() => parseCli(["session", "wait", "release", "--for", "idle"]))
      .toThrow("Unknown session action");
    expect(() => parseCli([
      "session",
      "watch",
      "release",
      "--idempotency-key",
      "00000000-0000-4000-8000-000000000001",
    ])).toThrow("not supported by session.watch");
    expect(parseCli([
      "session",
      "interactions",
      "release",
      "--pending",
      "--limit",
      "12",
      "--cursor",
      "hra1.page.signature",
    ]))
      .toEqual({
        command: {
          cursor: "hra1.page.signature",
          kind: "session.interactions",
          limit: 12,
          pending: true,
          session: "release",
        },
        json: false,
        kind: "command",
      });
    for (const argv of [
      ["session", "events", "release", "--limit", "0"],
      ["session", "events", "release", "--limit", "201"],
      ["session", "events", "release", "--wait-ms", "30001"],
      ["session", "events", "release", "--wait-ms", "1.5"],
      ["session", "events", "release", "--follow", "--wait-ms", "0"],
      ["session", "interactions", "release", "--limit", "101"],
    ]) expect(() => parseCli(argv)).toThrow(CliUsageError);
    expect(() => parseCli(["session", "events", "release", "--cursor", "x".repeat(2_049)]))
      .toThrow(CliUsageError);
    expect(() => parseCli(["session", "watch", "release", "--cursor", "x".repeat(2_049)]))
      .toThrow(CliUsageError);
    for (const malformed of [
      "provider-secret",
      "hra1.page.signature",
      `hra1.e31.${"A".repeat(43)}`,
      `hra1.e30.${"x".repeat(43)}`,
    ]) {
      expect(() => parseCli(["session", "events", "release", "--cursor", malformed]))
        .toThrow(CliUsageError);
      expect(() => parseCli(["session", "watch", "release", "--cursor", malformed]))
        .toThrow(CliUsageError);
    }
    expect(() => parseCli(["session", "interactions", "release", "--cursor", "x".repeat(2_049)]))
      .toThrow(CliUsageError);
  });

  test("parses safe interaction decisions and keeps protected values out of argv", () => {
    const interaction = "50000000-0000-4000-8000-000000000001";
    expect(parseCli([
      "interaction",
      "list",
      "release",
      "--pending",
      "--limit",
      "20",
      "--cursor",
      "hra1.page.signature",
      "--json",
    ]))
      .toEqual({
        command: {
          cursor: "hra1.page.signature",
          kind: "interaction.list",
          limit: 20,
          pending: true,
          session: "release",
        },
        json: true,
        kind: "command",
      });
    expect(() => parseCli(["interaction", "list", "--cursor", "x".repeat(2_049)]))
      .toThrow(CliUsageError);
    expect(parseCli(["interaction", "show", interaction])).toEqual({
      command: { interaction, kind: "interaction.show" },
      json: false,
      kind: "command",
    });
    expect(parseCli([
      "interaction",
      "inspect",
      interaction,
      "--revision",
      "3",
      "--handoff-file",
      "/tmp/protected-approval.json",
      "--json",
    ])).toEqual({
      command: {
        expectedRevision: 3,
        interaction,
        kind: "interaction.inspect",
      },
      handoffFile: "/tmp/protected-approval.json",
      json: true,
      kind: "interaction.inspect-protected",
    });
    expect(() => parseCli([
      "interaction",
      "inspect",
      interaction,
      "--revision",
      "3",
      "--handoff-file",
      "relative.json",
    ])).toThrow(CliUsageError);
    expect(() => parseCli([
      "interaction",
      "inspect",
      interaction,
      "--revision",
      "3",
      "--idempotency-key",
      crypto.randomUUID(),
    ])).toThrow(CliUsageError);
    expect(parseCli([
      "interaction",
      "decide",
      interaction,
      "--revision",
      "3",
      "--decision",
      "session",
    ])).toEqual({
      command: {
        expectedRevision: 3,
        interaction,
        kind: "interaction.resolve",
        resolution: { decision: "session", kind: "approval_decision" },
      },
      json: false,
      kind: "command",
    });
    expect(parseCli([
      "interaction",
      "submit",
      interaction,
      "--revision",
      "4",
      "--action",
      "cancel",
    ])).toMatchObject({
      command: {
        expectedRevision: 4,
        interaction,
        resolution: { action: "cancel", kind: "mcp_submission" },
      },
      kind: "command",
    });
    expect(() => parseCli([
      "interaction",
      "decide",
      interaction,
      "--revision",
      "0",
      "--decision",
      "once",
    ])).toThrow(CliUsageError);
    expect(() => parseCli(["interaction", "show", "not-an-id"])).toThrow(CliUsageError);
  });

  test("returns only protected-input metadata for secret-bearing interaction resolutions", () => {
    const interaction = "60000000-0000-4000-8000-000000000001";
    expect(parseCli([
      "interaction",
      "grant",
      interaction,
      "--revision",
      "7",
      "--scope",
      "turn",
      "--input-fd",
      "3",
      "--json",
    ])).toEqual({
      expectedRevision: 7,
      input: { fd: 3, kind: "fd" },
      interaction,
      json: true,
      kind: "interaction.resolve-protected",
      resolution: { kind: "permission_grant", scope: "turn" },
    });
    expect(parseCli([
      "interaction",
      "answer",
      interaction,
      "--revision",
      "8",
      "--input-stdin",
    ])).toEqual({
      expectedRevision: 8,
      input: { kind: "stdin" },
      interaction,
      json: false,
      kind: "interaction.resolve-protected",
      resolution: { kind: "user_answers" },
    });
    expect(parseCli([
      "interaction",
      "submit",
      interaction,
      "--revision",
      "9",
      "--action",
      "accept",
      "--input-fd",
      "0",
    ])).toMatchObject({
      input: { fd: 0, kind: "fd" },
      resolution: { action: "accept", kind: "mcp_submission" },
    });
    for (const argv of [
      ["interaction", "grant", interaction, "--revision", "7"],
      ["interaction", "answer", interaction, "--revision", "8", "secret-answer"],
      ["interaction", "answer", interaction, "--revision", "8", "--input-fd", "1"],
      ["interaction", "answer", interaction, "--revision", "8", "--input-stdin", "--input-fd", "3"],
      ["interaction", "grant", interaction, "--revision", "8", "--permissions-json", "{\"secret\":true}"],
      ["interaction", "submit", interaction, "--revision", "9", "--action", "decline", "--input-fd", "3"],
    ]) expect(() => parseCli(argv)).toThrow(CliUsageError);
  });

  test("completes protected resolutions only from exact injected JSON envelopes", () => {
    const interaction = "60000000-0000-4000-8000-000000000001";
    const grant = parseCli([
      "interaction",
      "grant",
      interaction,
      "--revision",
      "7",
      "--scope",
      "session",
      "--input-fd",
      "3",
    ]);
    if (grant.kind !== "interaction.resolve-protected") {
      throw new Error("Expected protected permission resolution.");
    }
    expect(completeProtectedInteraction(grant, {
      permissions: ["filesystem"],
    })).toEqual({
      expectedRevision: 7,
      interaction,
      kind: "interaction.resolve",
      resolution: {
        kind: "permission_grant",
        permissions: ["filesystem"],
        scope: "session",
      },
    });
    for (const document of [
      null,
      {},
      { permissions: {} },
      { permissions: [] },
      { permissions: ["filesystem", "filesystem"] },
      { permissions: ["filesystem"], extra: true },
    ]) {
      expect(() => completeProtectedInteraction(grant, document)).toThrow(CliUsageError);
    }

    const answer = parseCli([
      "interaction",
      "answer",
      interaction,
      "--revision",
      "8",
      "--input-stdin",
    ]);
    if (answer.kind !== "interaction.resolve-protected") {
      throw new Error("Expected protected answer resolution.");
    }
    expect(completeProtectedInteraction(answer, {
      answers: { question_1: { answers: ["protected response"] } },
    })).toMatchObject({
      resolution: {
        answers: { question_1: { answers: ["protected response"] } },
        kind: "user_answers",
      },
    });

    const submission = parseCli([
      "interaction",
      "submit",
      interaction,
      "--revision",
      "9",
      "--action",
      "accept",
      "--input-fd",
      "0",
    ]);
    if (submission.kind !== "interaction.resolve-protected") {
      throw new Error("Expected protected MCP submission.");
    }
    expect(completeProtectedInteraction(submission, {
      content: { selected: ["resource-1"] },
    })).toMatchObject({
      resolution: {
        action: "accept",
        content: { selected: ["resource-1"] },
        kind: "mcp_submission",
      },
    });

    for (const document of [
      null,
      {},
      { answers: {}, extra: true },
      { answers: { question_1: { answers: [1] } } },
    ]) {
      expect(() => completeProtectedInteraction(answer, document)).toThrow(CliUsageError);
    }
  });

  test("preserves every valid bounded recovery selector through the acknowledged parser path", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 200 })
          .filter((selector) => selector.trim().length > 0),
        (selector) => {
          const invocation = parseCli([
            "sync",
            "projection",
            "recover",
            "--acknowledge-gap",
            "--",
            selector,
          ]);
          expect(invocation.kind).toBe("sync.projection-recover");
          if (invocation.kind !== "sync.projection-recover") return;
          expect(invocation.command).toMatchObject({
            acknowledgeGap: true,
            kind: "sync.projection-recover",
            session: selector.trim(),
          });
          expect(invocation.command.idempotencyKey).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
          );
        },
      ),
      { numRuns: 500 },
    );
  });

  test("is total for arbitrary argv", () => {
    fc.assert(
      fc.property(fc.array(fc.string(), { maxLength: 20 }), (argv) => {
        try { parseCli(argv); } catch (error: unknown) { expect(error).toBeInstanceOf(Error); }
      }),
      { numRuns: 1_000 },
    );
  });
});

describe("CLI help", () => {
  const sessionEventsHelp = [
    "Oompa session events",
    "",
    "Usage:",
    "  oompa session events <session> [--cursor <cursor>] [--limit <1..200>] [--wait-ms <0..30000>] [--json|--jsonl|--follow]",
    "",
    "Examples:",
    "  oompa session events my-session --wait-ms 30000 --jsonl",
  ].join("\n");

  test("parses --help, -h, and the help alias at root, group, and leaf depth", () => {
    expect(parseCli([])).toEqual({ json: false, kind: "help" });
    expect(parseCli(["--help"])).toEqual({ json: false, kind: "help" });
    expect(parseCli(["-h"])).toEqual({ json: false, kind: "help" });
    expect(parseCli(["help"])).toEqual({ json: false, kind: "help" });
    expect(parseCli(["session", "--help"])).toEqual({ group: "session", json: false, kind: "help" });
    expect(parseCli(["help", "session"])).toEqual({ group: "session", json: false, kind: "help" });
    expect(parseCli(["session", "events", "--help"])).toEqual({ group: "session", json: false, kind: "help", leaf: "events" });
    expect(parseCli(["session", "events", "my-session", "--help"])).toEqual({ group: "session", json: false, kind: "help", leaf: "events" });
    expect(parseCli(["help", "session", "events"])).toEqual({ group: "session", json: false, kind: "help", leaf: "events" });
    expect(parseCli(["--json", "--help"])).toEqual({ json: true, kind: "help" });
    expect(parseCli(["--json", "help", "work", "protocol"])).toEqual({ group: "work", json: true, kind: "help", leaf: "protocol" });
  });

  test("parses --version with and without --json", () => {
    expect(parseCli(["--version"])).toEqual({ json: false, kind: "version" });
    expect(parseCli(["-v"])).toEqual({ json: false, kind: "version" });
    expect(parseCli(["--version", "--json"])).toEqual({ json: true, kind: "version" });
    expect(parseCli(["--json", "--version"])).toEqual({ json: true, kind: "version" });
    expect(() => parseCli(["--version", "extra"])).toThrow(CliUsageError);
  });

  test("resolves leaf help to only that leaf plus the group's shared notes", () => {
    expect(resolveUsage("session", "events")).toEqual({ group: "session", leaf: "events", usage: sessionEventsHelp });
    expect(usageForGroup("session", "events")).toBe(sessionEventsHelp);
    expect(usageForGroup("session", "events")).not.toContain("oompa session watch");
    expect(usageForGroup("session", "events")).not.toContain("oompa session start");

    const decide = resolveUsage("interaction", "decide");
    expect(decide).toMatchObject({ group: "interaction", leaf: "decide" });
    expect(decide.usage).toContain("Usage:\n  oompa interaction decide <interaction-id> --revision <n> --decision <once|session|decline|cancel>\n\n");
    expect(decide.usage).toContain("Protected values are accepted only through stdin or an explicit file descriptor.");
    expect(decide.usage).toContain("Examples:\n  oompa interaction decide <id> --revision 1 --decision once");
    expect(decide.usage).not.toContain("oompa interaction answer <id>");
    expect(decide.usage).not.toContain("oompa interaction list");

    const send = resolveUsage("session", "send");
    expect(send.usage).toContain("  oompa session send|queue|steer <session> [--attach <path>]... <message>");
    expect(send.usage).toContain('  oompa session send my-session -- "run --help exactly"');
    expect(send.usage).not.toContain("oompa session events");

    const note = resolveUsage("session", "note");
    expect(note.usage).toContain("  oompa session note get|edit|clear <session>\n  oompa session note set <session> <note>");
    expect(note.usage).not.toContain("Examples:");

    const claudeLogin = resolveUsage("account", "login");
    expect(claudeLogin.usage).toContain("Claude login and status\n  require Linux");
    expect(claudeLogin.usage).toContain("macOS refuses before launching Claude");
  });

  test("falls back without echoing unknown groups or leaves", () => {
    expect(resolveUsage(undefined)).toEqual({ usage });
    expect(resolveUsage("bogus")).toEqual({ usage });
    expect(resolveUsage("bogus", "events")).toEqual({ usage });
    expect(resolveUsage("session", "bogus")).toEqual({ group: "session", usage: usageForGroup("session") });
    expect(resolveUsage("session", "")).toEqual({ group: "session", usage: usageForGroup("session") });
    expect(resolveUsage("session", "oompa")).toEqual({ group: "session", usage: usageForGroup("session") });
    expect(resolveUsage("session", "session")).toEqual({ group: "session", usage: usageForGroup("session") });
  });

  test("root help uses ASCII quotes and names the help alias", () => {
    expect(usage).not.toMatch(/[\u2018\u2019\u201c\u201d]/u);
    expect(usage).toContain("  oompa help [<group> [<command>]]\n");
    expect(usage).toContain("Run `oompa <group> --help` or `oompa help <group> [<command>]` for command examples.");
    expect(usage).toContain("Codex provider commands run on macOS and Linux");
    expect(usage).toContain("Claude login, status,\n  sessions, and provider switches require Linux");
    expect(usage).toContain("high        Sol Max         (codex)");
    expect(usage).toContain("ultra       Sol Ultra       (codex)");
    expect(usage).not.toContain("Astra Max       (codex)");
    expect(usage).not.toContain("Astra Ultra     (codex)");
    for (const group of helpGroupNames) expect(usage).toContain(`oompa ${group}`);
  });

  test("every group leaf named in a usage line resolves to help holding exactly its own usage lines", () => {
    let leaves = 0;
    for (const group of helpGroupNames) {
      const groupHelp = usageForGroup(group);
      const usageLines = groupHelp.split("\n").filter((line) => line.startsWith(`  oompa ${group} `));
      const leafNames = new Set(usageLines.flatMap((line) => line.trim().split(/\s+/u)[2]?.split("|") ?? []));
      for (const leaf of leafNames) {
        if (leaf.startsWith("<") || leaf.startsWith("[") || leaf.startsWith("-")) continue;
        leaves += 1;
        const resolved = resolveUsage(group, leaf);
        expect(resolved).toMatchObject({ group, leaf });
        expect(resolved.usage.startsWith(`Oompa ${group} ${leaf}\n\nUsage:\n  oompa ${group} `)).toBe(true);
        const resolvedLines = new Set(resolved.usage.split("\n"));
        for (const line of usageLines) {
          const named = line.trim().split(/\s+/u)[2]?.split("|").includes(leaf) ?? false;
          expect(resolvedLines.has(line)).toBe(named);
        }
      }
    }
    expect(leaves).toBeGreaterThan(60);
  });
});

describe("remote decisions and send-or-steer parsing", () => {
  test("keeps once payload compatibility but advertises only current CLI authority", () => {
    expect(parseCli([
      "remote", "resolve", "sess_a",
      "--interaction", "0192a3b4-c5d6-7e8f-8a9b-0c1d2e3f4a5b",
      "--revision", "2",
      "--decision", "once",
    ])).toMatchObject({
      command: {
        decision: "once",
        interaction: "0192a3b4-c5d6-7e8f-8a9b-0c1d2e3f4a5b",
        kind: "remote.resolve",
        revision: 2,
        session: "sess_a",
      },
    });
    expect(parseCli([
      "remote", "resolve", "sess_a",
      "--interaction", "0192a3b4-c5d6-7e8f-8a9b-0c1d2e3f4a5b",
      "--revision", "2",
      "--decision", "decline",
    ])).toMatchObject({ command: { decision: "decline", kind: "remote.resolve" } });
    expect(() => parseCli(["remote", "resolve", "sess_a", "--interaction", "0192a3b4-c5d6-7e8f-8a9b-0c1d2e3f4a5b", "--revision", "2", "--decision", "session"]))
      .toThrow("--decision decline");
    expect(() => parseCli(["remote", "resolve", "sess_a", "--interaction", "0192a3b4-c5d6-7e8f-8a9b-0c1d2e3f4a5b", "--revision", "2", "--decision", "cancel"]))
      .toThrow("--decision decline");
    expect(() => parseCli(["remote", "resolve", "sess_a", "--interaction", "nope", "--revision", "2", "--decision", "once"]))
      .toThrow("--interaction");
    expect(() => parseCli(["remote", "resolve", "sess_a", "--interaction", "0192a3b4-c5d6-7e8f-8a9b-0c1d2e3f4a5b", "--revision", "0", "--decision", "once"]))
      .toThrow("--revision");

    const help = usageForGroup("remote");
    expect(help).toContain("--decision <decline>");
    expect(help).not.toContain("--decision <once");
    expect(help).not.toContain("cancel");
  });

  test("parses remote send --or-steer", () => {
    expect(parseCli(["remote", "send", "--or-steer", "sess_a", "keep", "going"])).toMatchObject({
      command: { kind: "remote.send", message: "keep going", orSteer: true, session: "sess_a" },
    });
    expect(parseCli(["remote", "send", "sess_a", "plain"])).toMatchObject({
      command: { kind: "remote.send", message: "plain", session: "sess_a" },
    });
  });
});

describe("notification-hours parsing", () => {
  test("parses status and a complete wall-clock CAS update", () => {
    expect(parseCli(["notification-hours", "status", "--json"])).toEqual({
      command: { kind: "notification-hours.status" },
      json: true,
      kind: "command",
    });
    expect(parseCli([
      "notification-hours",
      "set",
      "--end",
      "06:15",
      "--timezone",
      "America/Puerto_Rico",
      "--revision",
      "41",
      "--start",
      "22:30",
    ])).toEqual({
      command: {
        endMinute: 6 * 60 + 15,
        expectedRevision: 41,
        kind: "notification-hours.set",
        startMinute: 22 * 60 + 30,
        timeZone: "America/Puerto_Rico",
        version: 1,
      },
      json: false,
      kind: "command",
    });
  });

  test("rejects malformed clocks, zones, revisions, and unsupported authority", () => {
    for (const clock of ["9:00", "24:00", "12:60", "12:00:00", "-1:00"]) {
      expect(() => parseCli([
        "notification-hours", "set",
        "--start", clock,
        "--end", "22:00",
        "--timezone", "UTC",
        "--revision", "1",
      ])).toThrow("HH:MM");
    }
    for (const argv of [
      ["notification-hours", "set", "--start", "10:00", "--end", "10:00", "--timezone", "UTC", "--revision", "1"],
      ["notification-hours", "set", "--start", "10:00", "--end", "22:00", "--timezone", "Not/A_Real_Zone", "--revision", "1"],
      ["notification-hours", "set", "--start", "10:00", "--end", "22:00", "--timezone", "UTC", "--revision", "0"],
      ["notification-hours", "set", "--start", "10:00", "--end", "22:00", "--timezone", "UTC", "--revision", "1.5"],
      ["notification-hours", "set", "--start", "10:00", "--end", "22:00", "--timezone", "UTC", "--revision", "1", "extra"],
      ["notification-hours", "status", "extra"],
      ["notification-hours", "replace"],
    ]) expect(() => parseCli(argv)).toThrow(CliUsageError);

    expect(() => parseCli([
      "notification-hours",
      "status",
      "--idempotency-key",
      "00000000-0000-4000-8000-000000000203",
    ])).toThrow("not supported");
  });

  test("keeps both local notification-hours command documents strict", () => {
    expect(localCommandSchema.safeParse({
      kind: "notification-hours.status",
      extra: true,
    }).success).toBe(false);
    expect(localCommandSchema.safeParse({
      kind: "notification-hours.set",
      expectedRevision: 1,
      version: 1,
      startMinute: 600,
      endMinute: 1_320,
      timeZone: "UTC",
      extra: true,
    }).success).toBe(false);
  });
});

describe("notification-email parsing", () => {
  test("parses local status, enable, and disable CAS commands", () => {
    expect(parseCli(["notification-email", "status", "--json"])).toEqual({
      command: { kind: "notification-email.status" },
      json: true,
      kind: "command",
    });
    expect(parseCli([
      "notification-email", "enable", "--revision", "7",
    ])).toEqual({
      command: {
        expectedRevision: 7,
        kind: "notification-email.enable",
      },
      json: false,
      kind: "command",
    });
    expect(parseCli([
      "notification-email", "disable", "--revision", "8", "--json",
    ])).toEqual({
      command: {
        expectedRevision: 8,
        kind: "notification-email.disable",
      },
      json: true,
      kind: "command",
    });
  });

  test("rejects missing or malformed revisions and unsupported authority", () => {
    for (const argv of [
      ["notification-email", "enable"],
      ["notification-email", "enable", "--revision", "0"],
      ["notification-email", "disable", "--revision", "1.5"],
      ["notification-email", "disable", "--revision", "1", "extra"],
      ["notification-email", "status", "--revision", "1"],
      ["notification-email", "replace", "--revision", "1"],
    ]) expect(() => parseCli(argv)).toThrow(CliUsageError);
    expect(() => parseCli([
      "notification-email",
      "status",
      "--idempotency-key",
      "00000000-0000-4000-8000-000000000204",
    ])).toThrow("not supported");
  });

  test("documents only the local closed command set", () => {
    const help = usageForGroup("notification-email");
    expect(help).toContain("notification-email enable|disable --revision <n>");
    expect(help).toContain("never claims recall");
    expect(localCommandSchema.safeParse({
      kind: "notification-email.enable",
      expectedRevision: 1,
      enabled: true,
    }).success).toBe(false);
    expect(localCommandSchema.safeParse({
      kind: "notification-email.status",
      revision: 1,
    }).success).toBe(false);
  });
});

describe("autorespond-after-hours parsing", () => {
  test("parses local status and exact revision-bound consent updates", () => {
    for (const json of [false, true]) {
      const output = json ? ["--json"] : [];
      expect(parseCli(["autorespond-after-hours", "status", ...output])).toEqual({
        command: { kind: "autorespond-after-hours.status" }, kind: "command", json,
      });
      for (const action of ["enable", "disable"] as const) {
        for (const expectedRevision of [1, 7, Number.MAX_SAFE_INTEGER]) {
          expect(parseCli(["autorespond-after-hours", action, "--revision", String(expectedRevision), ...output]))
            .toEqual({ command: { kind: `autorespond-after-hours.${action}`, expectedRevision }, kind: "command", json });
        }
      }
    }
  });

  test("rejects missing, noncanonical, and unsafe revisions", () => {
    for (const action of ["enable", "disable"]) {
      expect(() => parseCli(["autorespond-after-hours", action])).toThrow(CliUsageError);
      for (const revision of ["0", "-1", "1.5", "01", "+1", "1e2", " 1", "Infinity", "NaN", "9007199254740992"]) {
        expect(() => parseCli(["autorespond-after-hours", action, "--revision", revision])).toThrow(CliUsageError);
      }
    }
  });

  test("rejects extra authority, unknown flags, duplicate options, and remote variants", () => {
    for (const argv of [
      ["autorespond-after-hours"],
      ["autorespond-after-hours", "replace", "--revision", "1"],
      ["autorespond-after-hours", "status", "--revision", "1"],
      ["autorespond-after-hours", "status", "extra"],
      ["autorespond-after-hours", "status", "--jsonl"],
      ["autorespond-after-hours", "enable", "--revision", "1", "--revision", "1"],
      ["autorespond-after-hours", "disable", "--revision", "1", "extra"],
      ["autorespond-after-hours", "enable", "--revision", "1", "--enabled", "true"],
      ["autorespond-after-hours", "enable", "--revision", "1", "--session", "sess_example"],
      ["autorespond-after-hours", "enable", "--revision", "1", "--preset-contract", "2"],
      ["remote", "autorespond-after-hours", "enable", "--revision", "1"],
    ]) expect(() => parseCli(argv)).toThrow(CliUsageError);
    for (const action of ["status", "enable", "disable"]) {
      expect(() => parseCli([
        "autorespond-after-hours", action,
        ...(action === "status" ? [] : ["--revision", "1"]),
        "--idempotency-key", "00000000-0000-4000-8000-000000000204",
      ])).toThrow("not supported");
    }
  });

  test("documents separate consent and conditional examples without widening approvals", () => {
    const help = usageForGroup("autorespond-after-hours");
    expect(helpGroupNames).toContain("autorespond-after-hours");
    expect(help).toContain("enable|disable --revision <n>");
    expect(help).toContain("separate consent from notification email");
    expect(help).toContain("6 consecutive, 20 per hour, and 80 per day");
    expect(help).toContain("3 consecutive, 10 per hour, and 40 per day");
    expect(help).toContain("Prose always keeps 3/10/40");
    expect(help).toContain("Existing approval categories and session approval");
    expect(help).toContain("never reset counters or refund reservations");
    expect(help).toContain("Only if you choose to consent");
    expect(help).toContain("enable --revision <current-revision>");
    expect(help).not.toMatch(/enable --revision \d/u);
  });
});

describe("autorespond parsing", () => {
  test("maps on, workspace, off, default, and status to approval modes", () => {
    expect(parseCli(["autorespond", "on"])).toEqual({
      command: { kind: "autorespond.set", mode: "auto:all" },
      json: false,
      kind: "command",
    });
    expect(parseCli(["autorespond", "workspace", "--session", "sess_a"])).toMatchObject({
      command: { kind: "autorespond.set", mode: "auto:workspace", session: "sess_a" },
    });
    expect(parseCli(["autorespond", "off"])).toMatchObject({ command: { kind: "autorespond.set", mode: "manual" } });
    expect(parseCli(["autorespond", "default", "--session", "sess_a"])).toMatchObject({
      command: { kind: "autorespond.set", mode: null, session: "sess_a" },
    });
    expect(parseCli(["autorespond", "status", "--json"])).toEqual({
      command: { kind: "autorespond.status" },
      json: true,
      kind: "command",
    });
    expect(() => parseCli(["autorespond", "default"])).toThrow("--session");
    expect(() => parseCli(["autorespond", "maybe"])).toThrow("Unknown autorespond action");
  });

  test("reads the gateway key from a descriptor and never from an argument", () => {
    expect(parseCli(["autorespond", "gateway", "set"])).toEqual({
      input: { kind: "stdin" },
      json: false,
      kind: "autorespond.gateway-set",
    });
    expect(parseCli(["autorespond", "gateway", "set", "--from-fd", "3", "--json"])).toEqual({
      input: { fd: 3, kind: "fd" },
      json: true,
      kind: "autorespond.gateway-set",
    });
    expect(parseCli(["autorespond", "gateway", "clear"])).toEqual({
      command: { kind: "autorespond.gateway-clear" },
      json: false,
      kind: "command",
    });
    // The key is never accepted positionally, on stdout, or on stderr.
    expect(() => parseCli(["autorespond", "gateway", "set", ["gw", "k".repeat(22)].join("")]))
      .toThrow();
    expect(() => parseCli(["autorespond", "gateway", "set", "--from-fd", "1"])).toThrow("stdout");
    expect(() => parseCli(["autorespond", "gateway", "set", "--from-fd", "2"])).toThrow("stderr");
    expect(() => parseCli(["autorespond", "gateway", "clear", "--from-fd", "3"])).toThrow("--from-fd");
    expect(() => parseCli(["autorespond", "gateway", "rotate"])).toThrow("Unknown autorespond gateway action");
  });
});
