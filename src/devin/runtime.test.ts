import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEVIN_PIN } from "./pin.ts";
import {
  devinEnvironment,
  locateDevinExecutable,
  resolvePinnedDevinRuntime,
  type DevinVersionProbeProcess,
  type DevinVersionProbeProcessFactory,
} from "./runtime.ts";

let root = "";
let executable = "";

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "oompa-devin-runtime-")));
  executable = join(root, "devin");
  await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
});

afterAll(async () => {
  await rm(root, { force: true, recursive: true });
});

const stdoutOf = (text: string): AsyncIterable<Uint8Array> => (async function* () { yield new TextEncoder().encode(text); })();

const probe = (text: string, exitCode = 0): DevinVersionProbeProcessFactory => () => ({
  exited: Promise.resolve(exitCode),
  stdout: stdoutOf(text),
  terminate: () => undefined,
  forceTerminate: () => undefined,
});

const signal = (): AbortSignal => new AbortController().signal;

describe("pinned Devin runtime", () => {
  test("admits exactly the pinned version and retains the reported build", async () => {
    const runtime = await resolvePinnedDevinRuntime({ executablePath: executable, processFactory: probe("devin 3000.10.27 (bcbe88c7)\n"), signal: signal() });
    expect(runtime).toEqual({ executablePath: executable, version: DEVIN_PIN, build: "bcbe88c7", versionOutput: "devin 3000.10.27 (bcbe88c7)" });
  });

  test("refuses another version, a malformed line, and a failing probe", async () => {
    for (const [text, exitCode] of [["devin 3000.10.26 (abc1234)\n", 0], ["Devin CLI 3000.10.27\n", 0], ["devin 3000.10.27 (bcbe88c7)\n", 1], ["", 0]] as const) {
      await expect(resolvePinnedDevinRuntime({ executablePath: executable, processFactory: probe(text, exitCode), signal: signal() }))
        .rejects.toMatchObject({ code: "RUNTIME_MISMATCH" });
    }
  });

  test("refuses an executable that is not a regular file and a relative path", async () => {
    await expect(resolvePinnedDevinRuntime({ executablePath: root, processFactory: probe("devin 3000.10.27 (bcbe88c7)\n"), signal: signal() }))
      .rejects.toMatchObject({ code: "RUNTIME_MISMATCH" });
    await expect(resolvePinnedDevinRuntime({ executablePath: "devin", processFactory: probe("devin 3000.10.27 (bcbe88c7)\n"), signal: signal() }))
      .rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(resolvePinnedDevinRuntime({ executablePath: join(root, "missing"), processFactory: probe("devin 3000.10.27 (bcbe88c7)\n"), signal: signal() }))
      .rejects.toMatchObject({ code: "RUNTIME_MISMATCH" });
  });

  test("bounds the version output", async () => {
    await expect(resolvePinnedDevinRuntime({ executablePath: executable, processFactory: probe("x".repeat(5_000)), signal: signal() }))
      .rejects.toMatchObject({ code: "PROTOCOL_LIMIT" });
  });

  test("bounds a hung probe with terminate, force, and an exit join", async () => {
    const trace: string[] = [];
    let resolveExit!: (code: number) => void;
    const process: DevinVersionProbeProcess = {
      exited: new Promise<number>((resolve) => { resolveExit = resolve; }),
      stdout: (async function* () { await new Promise<void>(() => undefined); yield new Uint8Array(); })(),
      terminate: () => { trace.push("terminate"); },
      forceTerminate: () => { trace.push("force"); resolveExit(137); },
    };
    await expect(resolvePinnedDevinRuntime({ executablePath: executable, processFactory: () => process, versionProbeDeadlineMs: 50, signal: signal() }))
      .rejects.toMatchObject({ code: "TIMEOUT" });
    expect(trace).toEqual(["terminate", "force"]);
  });

  test("passes only the allowlisted environment plus NO_COLOR to the probe", async () => {
    let seen: Readonly<Record<string, string>> | undefined;
    const factory: DevinVersionProbeProcessFactory = (input) => { seen = input.environment; return probe("devin 3000.10.27 (bcbe88c7)\n")(input); };
    await resolvePinnedDevinRuntime({
      executablePath: executable,
      processFactory: factory,
      environment: { HOME: "/srv/oompa-home", PATH: "/usr/bin", WINDSURF_API_KEY: "secret", DEVIN_TOKEN: "secret", XDG_DATA_HOME: "/srv/oompa-home/.local/share" },
      signal: signal(),
    });
    expect(seen).toEqual({ HOME: "/srv/oompa-home", PATH: "/usr/bin", XDG_DATA_HOME: "/srv/oompa-home/.local/share", NO_COLOR: "1" });
    expect(devinEnvironment({ SECRET: "x", HOME: "/h" })).toEqual({ HOME: "/h" });
  });

  test("locates the executable on an absolute PATH entry only", async () => {
    expect(await locateDevinExecutable({ PATH: `relative:${root}` })).toBe(executable);
    await expect(locateDevinExecutable({ PATH: "/nonexistent-oompa-path" })).rejects.toMatchObject({ code: "RUNTIME_MISMATCH" });
    await expect(locateDevinExecutable({})).rejects.toMatchObject({ code: "RUNTIME_MISMATCH" });
  });
});
