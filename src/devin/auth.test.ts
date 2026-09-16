import { describe, expect, test } from "bun:test";

import {
  parseDevinAuthStatus,
  readDevinAuthStatus,
  runDevinForegroundLogin,
  type DevinAuthStatusProcess,
  type DevinLoginSignal,
  type DevinLoginSignalSource,
} from "./auth";
import { DevinError } from "./errors";
import { DEVIN_MODEL, DEVIN_PIN } from "./pin";
import type { DevinDirectories } from "./process";
import type { PinnedDevinRuntime } from "./runtime";

const directories: DevinDirectories = {
  home: "/var/hra/devin/home",
  configHome: "/var/hra/devin/config",
  dataHome: "/var/hra/devin/data",
  cacheHome: "/var/hra/devin/cache",
  stateHome: "/var/hra/devin/state",
};
const runtime: PinnedDevinRuntime = {
  argv: ["/opt/devin", "acp", "--model", DEVIN_MODEL],
  executablePath: "/opt/devin",
  model: DEVIN_MODEL,
  version: DEVIN_PIN,
};
const encoder = new TextEncoder();
const signedOutStatus = [
  "Not logged in.",
  `  Credentials path: ${directories.dataHome}/devin/credentials.toml`,
  "Run `devin auth login` to authenticate.",
  "",
].join("\n");
const chunks = (values: readonly Uint8Array[]): AsyncIterable<Uint8Array> => ({
  async *[Symbol.asyncIterator]() { for (const value of values) yield value; },
});
const completedStatus = (output: string, exitCode = 0): DevinAuthStatusProcess => ({
  exited: Promise.resolve(exitCode),
  forceTerminate: () => undefined,
  stderr: chunks([]),
  stdout: chunks([encoder.encode(output)]),
  terminate: () => undefined,
});

class HangingStatusProcess implements DevinAuthStatusProcess {
  readonly exited: Promise<number>;
  readonly stdout: AsyncIterable<Uint8Array>;
  readonly stderr: AsyncIterable<Uint8Array>;
  terminated = false;
  #resolveExit!: (code: number) => void;
  #resolveStreams!: () => void;

  constructor(initial: readonly Uint8Array[] = []) {
    this.exited = new Promise((resolve) => { this.#resolveExit = resolve; });
    const streams = new Promise<void>((resolve) => { this.#resolveStreams = resolve; });
    this.stdout = {
      async *[Symbol.asyncIterator]() {
        for (const chunk of initial) yield chunk;
        await streams;
      },
    };
    this.stderr = { async *[Symbol.asyncIterator]() { await streams; yield* []; } };
  }

  terminate(): void {
    this.terminated = true;
    this.#resolveStreams();
    this.#resolveExit(143);
  }

  forceTerminate(): void {
    this.#resolveStreams();
    this.#resolveExit(137);
  }
}

class FakeSignalSource implements DevinLoginSignalSource {
  readonly listeners = new Map<DevinLoginSignal, Set<() => void>>();

  add(signal: DevinLoginSignal, listener: () => void): void {
    const listeners = this.listeners.get(signal) ?? new Set();
    listeners.add(listener);
    this.listeners.set(signal, listeners);
  }

  remove(signal: DevinLoginSignal, listener: () => void): void {
    this.listeners.get(signal)?.delete(listener);
  }

  emit(signal: DevinLoginSignal): void {
    for (const listener of this.listeners.get(signal) ?? []) listener();
  }
}

describe("Devin authentication status", () => {
  test("returns one boolean and never projects account identity", () => {
    expect(parseDevinAuthStatus({
      exitCode: 0,
      stdout: encoder.encode("Logged in (via Devin).\nAccount: private-person@example.test\n"),
    })).toEqual({ signedIn: true });
    expect(parseDevinAuthStatus({
      dataHome: directories.dataHome,
      exitCode: 0,
      stdout: encoder.encode(signedOutStatus),
    })).toEqual({ signedIn: false });
    expect(Object.keys(parseDevinAuthStatus({
      exitCode: 0,
      stdout: encoder.encode("Logged in (via Devin).\n"),
    }))).toEqual(["signedIn"]);
  });

  test("fails closed on malformed output and unexpected exits", () => {
    expect(() => parseDevinAuthStatus({ exitCode: 0, stdout: encoder.encode("maybe") }))
      .toThrow(DevinError);
    expect(() => parseDevinAuthStatus({ exitCode: 2, stdout: encoder.encode(signedOutStatus) }))
      .toThrow("without a status result");
    expect(() => parseDevinAuthStatus({
      dataHome: directories.dataHome,
      exitCode: 0,
      stdout: encoder.encode(signedOutStatus.replace(directories.dataHome, "/another/profile")),
    })).toThrow("invalid authentication status");
    expect(() => parseDevinAuthStatus({
      dataHome: directories.dataHome,
      exitCode: 0,
      stdout: encoder.encode([
        "Logged in (via Devin).",
        "  Credentials path: /another/profile/devin/credentials.toml",
        "",
      ].join("\n")),
    })).toThrow("invalid authentication status");
    expect(() => parseDevinAuthStatus({ exitCode: 0, stdout: new Uint8Array([0xff]) }))
      .toThrow("invalid authentication status");
  });

  test("runs exact argv inside the scrubbed isolated environment", async () => {
    let launch: unknown;
    await expect(readDevinAuthStatus({
      directories,
      environment: {
        DEVIN_API_KEY: "must-not-cross",
        HOME: "/Users/private",
        PATH: "/usr/bin:/bin",
      },
      processFactory: (input) => {
        launch = input;
        return completedStatus(signedOutStatus);
      },
      runtime,
      signal: new AbortController().signal,
    })).resolves.toEqual({ signedIn: false });
    expect(launch).toEqual({
      argv: ["/opt/devin", "auth", "status"],
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

  test("does not launch a status process after cancellation during runtime admission", async () => {
    const controller = new AbortController();
    let launches = 0;
    await expect(readDevinAuthStatus({
      directories,
      resolveRuntime: async () => {
        controller.abort();
        return runtime;
      },
      processFactory: () => {
        launches += 1;
        return completedStatus(signedOutStatus);
      },
      signal: controller.signal,
    })).rejects.toMatchObject({ code: "PROCESS_EXITED" });
    expect(launches).toBe(0);
  });

  test("joins a status child when cancellation occurs while spawning it", async () => {
    const controller = new AbortController();
    const child = new HangingStatusProcess();
    await expect(readDevinAuthStatus({
      directories,
      processFactory: () => {
        controller.abort();
        return child;
      },
      runtime,
      signal: controller.signal,
      deadlineMs: 10,
    })).rejects.toMatchObject({ code: "PROCESS_EXITED" });
    expect(child.terminated).toBe(true);
  });

  test("bounds output and process lifetime", async () => {
    const oversized = new HangingStatusProcess([new Uint8Array(16 * 1024 + 1)]);
    await expect(readDevinAuthStatus({
      directories,
      processFactory: () => oversized,
      runtime,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: "PROTOCOL_LIMIT" });
    expect(oversized.terminated).toBe(true);

    const timedOut = new HangingStatusProcess();
    await expect(readDevinAuthStatus({
      deadlineMs: 1,
      directories,
      processFactory: () => timedOut,
      runtime,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(timedOut.terminated).toBe(true);
  });
});

describe("Devin foreground login", () => {
  test("supports browser and explicit manual-token flows with inherited stdio", async () => {
    for (const manualTokenFlow of [false, true]) {
      let launch: unknown;
      await expect(runDevinForegroundLogin({
        directories,
        environment: { DEVIN_API_KEY: "must-not-cross", PATH: "/usr/bin:/bin" },
        manualTokenFlow,
        processFactory: (input) => {
          launch = input;
          return {
            exited: Promise.resolve(0),
            forceTerminate: () => undefined,
            sendSignal: () => undefined,
          };
        },
        runtime,
        signal: new AbortController().signal,
        signalSource: new FakeSignalSource(),
        stdio: { stdin: 10, stdout: 11, stderr: 12 },
      })).resolves.toEqual({ state: "joined", exitCode: 0, interruptedBy: null });
      expect(launch).toMatchObject({
        argv: manualTokenFlow
          ? ["/opt/devin", "auth", "login", "--force-manual-token-flow"]
          : ["/opt/devin", "auth", "login"],
        stdin: 10,
        stdout: 11,
        stderr: 12,
      });
      expect((launch as { environment: Record<string, string> }).environment.DEVIN_API_KEY)
        .toBeUndefined();
    }
  });

  test("preserves terminal signal custody without double-forwarding", async () => {
    const signalSource = new FakeSignalSource();
    const forwarded: DevinLoginSignal[] = [];
    let resolveExit!: (code: number) => void;
    const pending = runDevinForegroundLogin({
      directories,
      processFactory: () => ({
        exited: new Promise((resolve) => { resolveExit = resolve; }),
        forceTerminate: () => undefined,
        sendSignal: (signal) => { forwarded.push(signal); },
      }),
      runtime,
      signal: new AbortController().signal,
      signalSource,
      stdio: { stdin: 0, stdout: 1, stderr: 2 },
    });
    await Promise.resolve();
    signalSource.emit("SIGINT");
    resolveExit(130);
    await expect(pending).resolves.toEqual({ state: "joined", exitCode: 130, interruptedBy: "SIGINT" });
    expect(forwarded).toEqual([]);
    expect(signalSource.listeners.get("SIGINT")?.size ?? 0).toBe(0);
  });

  test("forwards AbortSignal termination and joins the foreground child", async () => {
    const controller = new AbortController();
    const forwarded: DevinLoginSignal[] = [];
    let resolveExit!: (code: number) => void;
    let markSpawned!: () => void;
    const spawned = new Promise<void>((resolve) => { markSpawned = resolve; });
    const pending = runDevinForegroundLogin({
      directories,
      processFactory: () => {
        markSpawned();
        return {
          exited: new Promise((resolve) => { resolveExit = resolve; }),
          forceTerminate: () => { resolveExit(137); },
          sendSignal: (signal) => { forwarded.push(signal); },
        };
      },
      runtime,
      signal: controller.signal,
      signalGraceMs: 1,
      signalSource: new FakeSignalSource(),
      stdio: { stdin: 0, stdout: 1, stderr: 2 },
    });
    await spawned;
    controller.abort();
    await expect(pending).resolves.toEqual({ state: "joined", exitCode: 137, interruptedBy: "SIGTERM" });
    expect(forwarded).toEqual(["SIGTERM"]);
  });
});
