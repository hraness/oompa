import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DevinError } from "./errors";
import { DEVIN_MODEL, DEVIN_PIN } from "./pin";
import { isolatedDevinEnvironment, type DevinDirectories } from "./process";
import {
  devinEnvironment,
  locateDevinExecutable,
  parseDevinVersionOutput,
  resolvePinnedDevinRuntime,
  spawnDevinVersionProbe,
  type DevinVersionProbeProcess,
  type DevinVersionProbeProcessFactory,
} from "./runtime";

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

const directories: DevinDirectories = {
  home: "/var/hra/devin/home",
  configHome: "/var/hra/devin/config",
  dataHome: "/var/hra/devin/data",
  cacheHome: "/var/hra/devin/cache",
  stateHome: "/var/hra/devin/state",
};
const encoder = new TextEncoder();
const chunks = (values: readonly Uint8Array[]): AsyncIterable<Uint8Array> => ({
  async *[Symbol.asyncIterator]() { for (const value of values) yield value; },
});
const stdoutOf = (text: string): AsyncIterable<Uint8Array> => chunks([encoder.encode(text)]);

const probe = (text: string, exitCode = 0): DevinVersionProbeProcessFactory => () => ({
  exited: Promise.resolve(exitCode),
  stdout: stdoutOf(text),
  stderr: chunks([]),
  terminate: () => undefined,
  forceTerminate: () => undefined,
});

const signal = (): AbortSignal => new AbortController().signal;

describe("pinned Devin runtime", () => {
  test("accepts only the pinned CLI's exact version shape", () => {
    expect(parseDevinVersionOutput(`devin ${DEVIN_PIN} (18033302)\n`)).toBe(DEVIN_PIN);
    expect(parseDevinVersionOutput(`devin ${DEVIN_PIN} (bcbe88c7)\n`)).toBe(DEVIN_PIN);
    for (const value of [
      DEVIN_PIN,
      `devin ${DEVIN_PIN}`,
      `wrapper devin ${DEVIN_PIN} (18033302)`,
      `devin ${DEVIN_PIN}-beta (18033302)`,
      `devin ${DEVIN_PIN} (build)`,
      `devin ${DEVIN_PIN} (zzzzzzz)`,
    ]) {
      expect(() => parseDevinVersionOutput(value)).toThrow(DevinError);
    }
  });

  test("admits exactly the pinned version and retains the reported build", async () => {
    const runtime = await resolvePinnedDevinRuntime({ executablePath: executable, processFactory: probe("devin 3000.10.27 (bcbe88c7)\n"), signal: signal() });
    expect(runtime).toEqual({
      executablePath: executable,
      version: DEVIN_PIN,
      build: "bcbe88c7",
      versionOutput: "devin 3000.10.27 (bcbe88c7)",
      model: DEVIN_MODEL,
      argv: [executable, "acp", "--model", DEVIN_MODEL],
    });
  });

  test("constructs exact Astra ACP argv after a pinned probe", async () => {
    const runtime = await resolvePinnedDevinRuntime({
      directories,
      executablePath: "/bin/echo",
      probeVersion: async () => `devin ${DEVIN_PIN} (bcbe88c7)\n`,
    });
    expect(runtime.version).toBe(DEVIN_PIN);
    expect(runtime.model).toBe(DEVIN_MODEL);
    expect(runtime.build).toBe("bcbe88c7");
    expect(runtime.versionOutput).toBe(`devin ${DEVIN_PIN} (bcbe88c7)`);
    expect(runtime.argv.slice(1)).toEqual(["acp", "--model", "gpt-6-astra"]);
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
      stderr: chunks([]),
      terminate: () => { trace.push("terminate"); },
      forceTerminate: () => { trace.push("force"); resolveExit(137); },
    };
    await expect(resolvePinnedDevinRuntime({ executablePath: executable, processFactory: () => process, versionProbeDeadlineMs: 50, signal: signal() }))
      .rejects.toMatchObject({ code: "TIMEOUT" });
    expect(trace).toEqual(["terminate", "force"]);
  });

  test("passes only the allowlisted environment plus NO_COLOR to the ambient probe", async () => {
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

  test("overrides every HOME/XDG directory and drops ambient credentials", () => {
    expect(isolatedDevinEnvironment({
      HOME: "/Users/private",
      PATH: "/usr/bin:/bin",
      DEVIN_API_KEY: "must-not-cross",
      HTTPS_PROXY: "https://must-not-cross.invalid",
    }, directories)).toEqual({
      HOME: directories.home,
      PATH: "/usr/bin:/bin",
      XDG_CONFIG_HOME: directories.configHome,
      XDG_DATA_HOME: directories.dataHome,
      XDG_CACHE_HOME: directories.cacheHome,
      XDG_STATE_HOME: directories.stateHome,
      NO_COLOR: "1",
    });
  });

  test("runs a bounded, isolated direct version probe", async () => {
    let launch: unknown;
    const result = await spawnDevinVersionProbe({
      deadlineMs: 1_000,
      directories,
      environment: { PATH: "/usr/bin:/bin", DEVIN_API_KEY: "secret" },
      executablePath: "/opt/devin",
      processFactory: (input) => {
        launch = input;
        return {
          exited: Promise.resolve(0),
          forceTerminate: () => undefined,
          stderr: chunks([]),
          stdout: chunks([encoder.encode(`devin ${DEVIN_PIN} (bcbe88c7)\n`)]),
          terminate: () => undefined,
        };
      },
      signal: new AbortController().signal,
    });
    expect(result).toBe(`devin ${DEVIN_PIN} (bcbe88c7)\n`);
    expect(launch).toEqual({
      argv: ["/opt/devin", "--version"],
      environment: {
        HOME: directories.home,
        PATH: "/usr/bin:/bin",
        XDG_CONFIG_HOME: directories.configHome,
        XDG_DATA_HOME: directories.dataHome,
        XDG_CACHE_HOME: directories.cacheHome,
        XDG_STATE_HOME: directories.stateHome,
        NO_COLOR: "1",
      },
    });
  });

  test("terminates and joins an overproducing version probe", async () => {
    let resolveExit!: (code: number) => void;
    let terminated = false;
    const process: DevinVersionProbeProcess = {
      exited: new Promise((resolve) => { resolveExit = resolve; }),
      forceTerminate: () => undefined,
      stderr: chunks([]),
      stdout: chunks([new Uint8Array(4 * 1024 + 1)]),
      terminate: () => { terminated = true; resolveExit(143); },
    };
    await expect(spawnDevinVersionProbe({
      deadlineMs: 1_000,
      directories,
      environment: {},
      executablePath: "/opt/devin",
      processFactory: () => process,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: "PROTOCOL_LIMIT" });
    expect(terminated).toBe(true);
  });

  test("locates the executable on an absolute PATH entry only", async () => {
    expect(await locateDevinExecutable({ PATH: `relative:${root}` })).toBe(executable);
    await expect(locateDevinExecutable({ PATH: "/nonexistent-oompa-path" })).rejects.toMatchObject({ code: "RUNTIME_MISMATCH" });
    await expect(locateDevinExecutable({})).rejects.toMatchObject({ code: "RUNTIME_MISMATCH" });
  });
});
