import { describe, expect, test } from "bun:test";

import fixture from "./usage-panel.fixture.json";
import { DEVIN_PIN } from "./pin.ts";
import type { PinnedDevinRuntime } from "./runtime.ts";
import { readDevinUsagePanel, type DevinTerminalProcess, type DevinTerminalProcessFactory } from "./usage-driver.ts";

const runtime: PinnedDevinRuntime = {
  executablePath: "/opt/devin/bin/devin",
  version: DEVIN_PIN,
  build: "bcbe88c7",
  versionOutput: fixture.cliVersionOutput,
};

const panel = fixture.cases.real_max_weekly_only.text;
const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const segment = (from: string, to?: string): string => {
  const start = panel.indexOf(from);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = to === undefined ? panel.length : panel.indexOf(to, start);
  expect(end).toBeGreaterThan(start);
  return panel.slice(start, end);
};
const bannerAndPrompt = segment("Devin CLI", "/usage");
const popup = "○ /usage              Show session usage of credits / ACUs";
const quotaPanel = segment("Fetching quota", "/exit");
const goodbye = "Resume this session with `devin -r <session>`, or run `devin -r` to view recent sessions\n";

type FakeOptions = Readonly<{
  prompt?: boolean;
  respondToUsage?: boolean;
  exitOnCommand?: boolean;
  exitEarly?: boolean;
  trustPrompt?: boolean;
  flood?: number;
}>;

type Fake = Readonly<{ factory: DevinTerminalProcessFactory; writes: string[]; kills: number; argv: () => readonly string[] | undefined; environment: () => Readonly<Record<string, string>> | undefined; cwd: () => string | undefined }>;

function fakeTerminal(options: FakeOptions = {}): Fake {
  const writes: string[] = [];
  const state = { kills: 0, argv: undefined as readonly string[] | undefined, environment: undefined as Readonly<Record<string, string>> | undefined, cwd: undefined as string | undefined };
  const factory: DevinTerminalProcessFactory = (input) => {
    state.argv = input.argv;
    state.environment = input.environment;
    state.cwd = input.cwd;
    let resolveExit!: (code: number | null) => void;
    const exited = new Promise<number | null>((resolve) => { resolveExit = resolve; });
    let pending = "";
    queueMicrotask(() => {
      if (options.trustPrompt === true) { input.onData(encode(" ✓ Trust /example/project?\n")); return; }
      if (options.exitEarly === true) { resolveExit(2); return; }
      if (options.flood !== undefined) { input.onData(encode("x".repeat(options.flood))); return; }
      if (options.prompt !== false) input.onData(encode(`${bannerAndPrompt}\n`));
    });
    const process: DevinTerminalProcess = {
      exited,
      write: (data) => {
        writes.push(data);
        if (data === "\r") {
          const command = pending;
          pending = "";
          if (command === "/usage" && options.respondToUsage !== false) input.onData(encode(`${quotaPanel}\n`));
          if (command === "/exit") {
            input.onData(encode(goodbye));
            if (options.exitOnCommand !== false) resolveExit(0);
          }
          return;
        }
        pending += data;
        if (pending === "/usage") input.onData(encode(`${popup}\n`));
      },
      kill: () => { state.kills += 1; resolveExit(null); },
    };
    return process;
  };
  return {
    factory,
    writes,
    get kills() { return state.kills; },
    argv: () => state.argv,
    environment: () => state.environment,
    cwd: () => state.cwd,
  };
}

const read = (fake: Fake, options: Partial<Parameters<typeof readDevinUsagePanel>[0]> = {}) =>
  readDevinUsagePanel({
    runtime,
    workingDirectory: "/tmp/oompa-devin-usage",
    environment: { HOME: "/srv/oompa-home", PATH: "/usr/bin", WINDSURF_API_KEY: "secret" },
    terminalFactory: fake.factory,
    promptDeadlineMs: 2_000,
    quotaDeadlineMs: 2_000,
    exitDeadlineMs: 500,
    ...options,
  });

describe("Devin usage panel driver", () => {
  test("types only the usage and exit commands and returns the parsed observation", async () => {
    const fake = fakeTerminal();
    const observation = await read(fake);
    expect(observation).toMatchObject({ kind: "observed", planName: "Max", weekly: { usedPercent: 0, remainingPercent: 100 }, dailyShown: false, cliVersion: fixture.cliVersionOutput });
    expect(fake.writes).toEqual(["/usage", "\r", "/exit", "\r"]);
    expect(fake.kills).toBe(0);
    expect(fake.argv()).toEqual(["/opt/devin/bin/devin", "--respect-workspace-trust", "false"]);
    expect(fake.cwd()).toBe("/tmp/oompa-devin-usage");
    expect(fake.environment()).toEqual({ HOME: "/srv/oompa-home", PATH: "/usr/bin", TERM: "xterm-256color", NO_COLOR: "1" });
  });

  test("returns an unknown observation when the quota never renders, after exiting cleanly", async () => {
    const fake = fakeTerminal({ respondToUsage: false });
    const observation = await read(fake, { quotaDeadlineMs: 200 });
    expect(observation).toMatchObject({ kind: "unknown", reason: "quota_line_missing" });
    expect(fake.writes).toEqual(["/usage", "\r", "/exit", "\r"]);
    expect(fake.kills).toBe(0);
  });

  test("never types a command when the workspace-trust prompt appears", async () => {
    const fake = fakeTerminal({ trustPrompt: true, exitOnCommand: false });
    const observation = await read(fake, { exitDeadlineMs: 100 });
    expect(observation).toMatchObject({ kind: "unknown", reason: "workspace_trust_prompt" });
    expect(fake.writes).toEqual(["/exit", "\r"]);
    expect(fake.kills).toBe(1);
  });

  test("times out and kills a CLI that never shows its prompt", async () => {
    const fake = fakeTerminal({ prompt: false });
    await expect(read(fake, { promptDeadlineMs: 150 })).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(fake.writes).toEqual([]);
    expect(fake.kills).toBe(1);
  });

  test("reports an early exit and a flooded terminal as closed failures", async () => {
    const early = fakeTerminal({ exitEarly: true });
    await expect(read(early)).rejects.toMatchObject({ code: "PROCESS_EXITED" });
    const flood = fakeTerminal({ flood: 4_096 });
    await expect(read(flood, { maxBytes: 1_024 })).rejects.toMatchObject({ code: "PROTOCOL_LIMIT" });
    expect(flood.kills).toBe(1);
  });

  test("kills a CLI that ignores exit and still returns the observation", async () => {
    const fake = fakeTerminal({ exitOnCommand: false });
    const observation = await read(fake, { exitDeadlineMs: 100 });
    expect(observation.kind).toBe("observed");
    expect(fake.kills).toBe(1);
  });

  test("honours cancellation and validates its inputs before launching", async () => {
    const controller = new AbortController();
    controller.abort();
    const fake = fakeTerminal();
    await expect(read(fake, { signal: controller.signal })).rejects.toBeDefined();
    expect(fake.argv()).toBeUndefined();
    await expect(read(fakeTerminal(), { workingDirectory: "relative" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(read(fakeTerminal(), { promptDeadlineMs: 0 })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(read(fakeTerminal(), { maxBytes: 1 << 30 })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});
