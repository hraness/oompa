import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";

import fc from "fast-check";

import { readClaudeAccountProjection } from "./account";
import {
  parseClaudeAuthStatus,
  readClaudeAuthenticationObservation,
  readClaudeAuthStatus,
  runClaudeForegroundLogin,
  resolveClaudeLoginBrowserMode,
  type ClaudeAuthStatusProcess,
  type ClaudeLoginSignal,
  type ClaudeLoginSignalSource,
} from "./auth";
import { ClaudeError } from "./errors";
import { CLAUDE_PIN, CLAUDE_PIN_EFFORT, CLAUDE_PIN_MODEL, CLAUDE_PIN_NATIVE_FALLBACK_CAPABILITY } from "./pin";
import type { PinnedClaudeRuntime } from "./runtime";

const CONFIG_DIR = "/var/oompa/profiles/acct/claude-config";
const encoder = new TextEncoder();

const runtime: PinnedClaudeRuntime = {
  argv: ["/opt/oompa/claude", "--print"],
  effort: CLAUDE_PIN_EFFORT,
  executablePath: "/opt/oompa/claude",
  model: CLAUDE_PIN_MODEL,
  nativeFallback: CLAUDE_PIN_NATIVE_FALLBACK_CAPABILITY,
  version: CLAUDE_PIN,
};

const statusDocument = (overrides: Readonly<Record<string, unknown>> = {}): Uint8Array =>
  encoder.encode(JSON.stringify({
    loggedIn: false,
    authMethod: "none",
    apiProvider: "firstParty",
    analyticsDisabled: false,
    projectsDirectory: `${CONFIG_DIR}/projects`,
    ...overrides,
  }));

const chunks = (values: readonly Uint8Array[]): AsyncIterable<Uint8Array> => ({
  async *[Symbol.asyncIterator]() {
    for (const value of values) yield value;
  },
});

const completedStatusProcess = (
  stdout: Uint8Array,
  exitCode: number,
  stderr = new Uint8Array(),
): ClaudeAuthStatusProcess => ({
  exited: Promise.resolve(exitCode),
  forceTerminate: () => undefined,
  stderr: chunks([stderr]),
  stdout: chunks([stdout]),
  terminate: () => undefined,
});

class HangingStatusProcess implements ClaudeAuthStatusProcess {
  readonly stdout: AsyncIterable<Uint8Array>;
  readonly stderr: AsyncIterable<Uint8Array>;
  readonly exited: Promise<number>;
  terminated = false;
  forceTerminated = false;
  #resolveClosed!: () => void;
  #resolveExit!: (code: number) => void;

  constructor(initialStdout: readonly Uint8Array[] = []) {
    const closed = new Promise<void>((resolve) => { this.#resolveClosed = resolve; });
    this.exited = new Promise<number>((resolve) => { this.#resolveExit = resolve; });
    this.stdout = {
      async *[Symbol.asyncIterator]() {
        for (const value of initialStdout) yield value;
        await closed;
      },
    };
    this.stderr = {
      async *[Symbol.asyncIterator]() { await closed; yield new Uint8Array(); },
    };
  }

  terminate(): void {
    this.terminated = true;
    this.#resolveClosed();
    this.#resolveExit(143);
  }

  forceTerminate(): void {
    this.forceTerminated = true;
    this.#resolveClosed();
    this.#resolveExit(137);
  }
}

class FakeSignalSource implements ClaudeLoginSignalSource {
  readonly listeners = new Map<ClaudeLoginSignal, Set<() => void>>();

  add(signal: ClaudeLoginSignal, listener: () => void): void {
    const listeners = this.listeners.get(signal) ?? new Set();
    listeners.add(listener);
    this.listeners.set(signal, listeners);
  }

  remove(signal: ClaudeLoginSignal, listener: () => void): void {
    this.listeners.get(signal)?.delete(listener);
  }

  emit(signal: ClaudeLoginSignal): void {
    for (const listener of this.listeners.get(signal) ?? []) listener();
  }
}

class ImmediateSignalSource extends FakeSignalSource {
  #emitted = false;

  constructor(private readonly immediate: ClaudeLoginSignal) {
    super();
  }

  override add(signal: ClaudeLoginSignal, listener: () => void): void {
    super.add(signal, listener);
    if (signal === this.immediate && !this.#emitted) {
      this.#emitted = true;
      listener();
    }
  }
}

describe("Claude authentication status", () => {
  test("accepts only coherent pinned signed-in and signed-out results", () => {
    expect(parseClaudeAuthStatus({
      configDir: CONFIG_DIR,
      exitCode: 1,
      stdout: statusDocument(),
    })).toEqual({ signedIn: false });
    expect(parseClaudeAuthStatus({
      configDir: CONFIG_DIR,
      exitCode: 0,
      stdout: statusDocument({
        loggedIn: true,
        authMethod: "claude.ai",
        email: "person@example.test",
        orgId: "org-private",
        orgName: "Private Org",
        subscriptionType: "max",
      }),
    })).toEqual({ signedIn: true });

    for (const value of [
      { exitCode: 0, stdout: statusDocument() },
      { exitCode: 1, stdout: statusDocument({ loggedIn: true, authMethod: "claude.ai" }) },
      { exitCode: 0, stdout: statusDocument({ loggedIn: true, authMethod: "none" }) },
    ]) {
      expect(() => parseClaudeAuthStatus({ configDir: CONFIG_DIR, ...value }))
        .toThrow("incoherent authentication status");
    }
  });

  test("fails closed on malformed, widened, misplaced, and unexpected-exit documents", () => {
    expect(() => parseClaudeAuthStatus({
      configDir: CONFIG_DIR,
      exitCode: 1,
      stdout: encoder.encode("not-json"),
    })).toThrow(ClaudeError);
    expect(() => parseClaudeAuthStatus({
      configDir: CONFIG_DIR,
      exitCode: 1,
      stdout: statusDocument({ unexpected: true }),
    })).toThrow("invalid authentication status document");
    expect(() => parseClaudeAuthStatus({
      configDir: CONFIG_DIR,
      exitCode: 1,
      stdout: statusDocument({ projectsDirectory: "/another/profile/projects" }),
    })).toThrow("isolated profile directory");
    expect(() => parseClaudeAuthStatus({
      configDir: CONFIG_DIR,
      exitCode: 2,
      stdout: statusDocument(),
    })).toThrow("exited without a status result");
  });

  test("runs exact direct argv under the isolated allowlisted environment", async () => {
    let launch: Parameters<NonNullable<Parameters<typeof readClaudeAuthStatus>[0]["processFactory"]>>[0] | undefined;
    const result = await readClaudeAuthStatus({
      configDir: CONFIG_DIR,
      environment: {
        ANTHROPIC_API_KEY: "must-not-cross",
        HOME: "/Users/test",
        HTTPS_PROXY: "https://must-not-cross.invalid",
        PATH: "/usr/bin:/bin",
      },
      processFactory: (input) => {
        launch = input;
        return completedStatusProcess(statusDocument(), 1);
      },
      resolveRuntime: async (options) => {
        expect(options.configDir).toBe(CONFIG_DIR);
        return runtime;
      },
      signal: new AbortController().signal,
    });
    expect(result).toEqual({ signedIn: false });
    expect(launch?.argv).toEqual([runtime.executablePath, "auth", "status", "--json"]);
    expect(launch?.environment).toEqual({
      CLAUDE_CONFIG_DIR: CONFIG_DIR,
      HOME: "/Users/test",
      NO_COLOR: "1",
      PATH: "/usr/bin:/bin",
    });
  });

  test("bounds output and terminates before rejecting an oversized process", async () => {
    const process = new HangingStatusProcess([new Uint8Array(16 * 1024 + 1)]);
    await expect(readClaudeAuthStatus({
      configDir: CONFIG_DIR,
      processFactory: () => process,
      resolveRuntime: async () => runtime,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: "PROTOCOL_LIMIT" });
    expect(process.terminated).toBe(true);
  });

  test("keeps personal-home status and runtime admission in canonical default-home mode", async () => {
    let launch: Parameters<NonNullable<Parameters<typeof readClaudeAuthStatus>[0]["processFactory"]>>[0] | undefined;
    const result = await readClaudeAuthStatus({
      configDir: CONFIG_DIR,
      configHome: "personal",
      environment: {
        CLAUDE_CONFIG_DIR: "/must-not-cross",
        HOME: "/Users/test",
        PATH: "/usr/bin:/bin",
      },
      processFactory: (input) => {
        launch = input;
        return completedStatusProcess(statusDocument(), 1);
      },
      resolveRuntime: async (options) => {
        expect(options.configHome).toBe("personal");
        return runtime;
      },
      signal: new AbortController().signal,
    });
    expect(result).toEqual({ signedIn: false });
    expect(launch?.environment).toEqual({
      HOME: "/Users/test",
      NO_COLOR: "1",
      PATH: "/usr/bin:/bin",
    });
  });

  test("joins the status child when cancellation arrives during spawn", async () => {
    const controller = new AbortController();
    const child = new HangingStatusProcess();
    await expect(readClaudeAuthStatus({
      configDir: CONFIG_DIR,
      processFactory: () => {
        controller.abort();
        return child;
      },
      runtime,
      signal: controller.signal,
    })).rejects.toMatchObject({ code: "PROCESS_EXITED" });
    expect(child.terminated).toBe(true);
  });

  test("retains only closed authentication-mode evidence and grants OAuth identity only for claude.ai", async () => {
    for (const [authMethod, authentication] of [["claude.ai", "claude_ai"], ["api_key", "other"]] as const) {
      const input = {
        configDir: CONFIG_DIR,
        processFactory: () => completedStatusProcess(statusDocument({
          loggedIn: true,
          authMethod,
          email: "must-not-cross@example.test",
          orgId: "must-not-cross",
        }), 0),
        runtime,
        signal: new AbortController().signal,
      };
      expect(await readClaudeAuthenticationObservation(input)).toEqual({
        signedIn: true,
        authentication,
      });
      expect(await readClaudeAuthStatus(input)).toEqual({ signedIn: true });
    }
  });

  test("unreviewed authentication methods never inherit cached OAuth identity", async () => {
    const otherAuthMethod = fc.array(
      fc.integer({ min: 0, max: 64 }).map((index) =>
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-".charAt(index)),
      { minLength: 1, maxLength: 64 },
    ).map((characters) => characters.join(""))
      .filter((method) => method !== "claude.ai" && method !== "none");
    await fc.assert(fc.asyncProperty(otherAuthMethod, fc.uuid(), fc.uuid(), async (
      authMethod,
      accountUuid,
      organizationUuid,
    ) => {
      const status = await readClaudeAuthenticationObservation({
        configDir: CONFIG_DIR,
        configHome: "personal",
        processFactory: () => completedStatusProcess(statusDocument({ loggedIn: true, authMethod }), 0),
        runtime,
        signal: new AbortController().signal,
      });
      expect(status).toEqual({ signedIn: true, authentication: "other" });
      const projection = await readClaudeAccountProjection({
        configDir: CONFIG_DIR,
        configHome: "personal",
        runtime,
        signal: new AbortController().signal,
        readMetadata: async () => ({
          oauthAccount: {
            accountUuid,
            organizationUuid,
            emailAddress: `${accountUuid}@example.test`,
          },
        }),
        probeAuthStatus: async () => ({
          loggedIn: status.signedIn,
          authentication: status.authentication,
        }),
      });
      expect(projection).toEqual({ signedIn: true });
    }), { numRuns: 200, seed: 20_260_907 });
  });

  test("terminates and joins on deadline and caller abort", async () => {
    const timedOut = new HangingStatusProcess();
    await expect(readClaudeAuthStatus({
      configDir: CONFIG_DIR,
      deadlineMs: 1,
      processFactory: () => timedOut,
      resolveRuntime: async () => runtime,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(timedOut.terminated).toBe(true);

    const controller = new AbortController();
    const aborted = new HangingStatusProcess();
    let spawned!: () => void;
    const didSpawn = new Promise<void>((resolve) => { spawned = resolve; });
    const pending = readClaudeAuthStatus({
      configDir: CONFIG_DIR,
      processFactory: () => { spawned(); return aborted; },
      resolveRuntime: async () => runtime,
      signal: controller.signal,
    });
    await didSpawn;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "PROCESS_EXITED" });
    expect(aborted.terminated).toBe(true);
  });

  test("bounds the final join even when a broken process ignores forced termination", async () => {
    const never = new Promise<never>(() => undefined);
    const process: ClaudeAuthStatusProcess & { forced: boolean; terminated: boolean } = {
      exited: never,
      forced: false,
      forceTerminate() { this.forced = true; },
      stderr: { async *[Symbol.asyncIterator]() { await never; yield new Uint8Array(); } },
      stdout: { async *[Symbol.asyncIterator]() { await never; yield new Uint8Array(); } },
      terminate() { this.terminated = true; },
      terminated: false,
    };
    const startedAt = Date.now();
    await expect(readClaudeAuthStatus({
      configDir: CONFIG_DIR,
      deadlineMs: 1,
      processFactory: () => process,
      resolveRuntime: async () => runtime,
      signal: new AbortController().signal,
    })).rejects.toThrow("could not be joined after forced termination");
    expect(process.terminated).toBe(true);
    expect(process.forced).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  test("force-terminates when the status exit observer rejects without proving process exit", async () => {
    const process: ClaudeAuthStatusProcess & { forced: boolean; terminated: boolean } = {
      exited: Promise.reject(new Error("broken wait")),
      forced: false,
      forceTerminate() { this.forced = true; },
      stderr: chunks([new Uint8Array()]),
      stdout: chunks([statusDocument()]),
      terminate() { this.terminated = true; },
      terminated: false,
    };
    await expect(readClaudeAuthStatus({
      configDir: CONFIG_DIR,
      processFactory: () => process,
      resolveRuntime: async () => runtime,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: "PROCESS_EXITED" });
    expect(process.terminated).toBe(true);
    expect(process.forced).toBe(true);
  });
});

describe("Claude foreground login", () => {
  test("consumes interruption before spawn without creating a child", async () => {
    for (const interruptedBy of ["SIGINT", "SIGTERM"] as const) {
      let spawnCalls = 0;
      await expect(runClaudeForegroundLogin({
        configDir: CONFIG_DIR,
        processFactory: () => {
          spawnCalls += 1;
          throw new Error("must not spawn");
        },
        runtime,
        signal: new AbortController().signal,
        signalSource: new ImmediateSignalSource(interruptedBy),
        stdio: { stdin: 0, stdout: 1, stderr: 2 },
      })).resolves.toEqual({
        state: "not_started",
        reason: "interrupted_before_spawn",
        interruptedBy,
      });
      expect(spawnCalls).toBe(0);
    }

    const controller = new AbortController();
    controller.abort();
    let spawnCalls = 0;
    await expect(runClaudeForegroundLogin({
      configDir: CONFIG_DIR,
      processFactory: () => {
        spawnCalls += 1;
        throw new Error("must not spawn");
      },
      runtime,
      signal: controller.signal,
      stdio: { stdin: 0, stdout: 1, stderr: 2 },
    })).resolves.toEqual({
      state: "not_started",
      reason: "interrupted_before_spawn",
      interruptedBy: "SIGTERM",
    });
    expect(spawnCalls).toBe(0);
  });

  test.each(["provider_default", "owner_manual"] as const)("runs exact foreground argv and scrubbed env with %s", async (browserMode) => {
    let launch: Parameters<NonNullable<Parameters<typeof runClaudeForegroundLogin>[0]["processFactory"]>>[0] | undefined;
    const result = await runClaudeForegroundLogin({
      browserMode,
      configDir: CONFIG_DIR,
      environment: {
        ANTHROPIC_API_KEY: "must-not-cross",
        BROWSER: "/arbitrary/opener",
        CLAUDE_BG_RENDEZVOUS_SOCK: "/private/rendezvous",
        HOME: "/Users/test",
        PATH: "/usr/bin:/bin",
      },
      processFactory: (input) => {
        launch = input;
        return {
          exited: Promise.resolve(0),
          forceTerminate: () => undefined,
          sendSignal: () => undefined,
        };
      },
      resolveRuntime: async () => runtime,
      signal: new AbortController().signal,
      signalSource: new FakeSignalSource(),
      stdio: { stdin: 10, stdout: 11, stderr: 12 },
    });
    expect(result).toEqual({ state: "joined", exitCode: 0, interruptedBy: null });
    expect(launch).toEqual({
      argv: [runtime.executablePath, "auth", "login", "--claudeai"],
      environment: {
        ...(browserMode === "owner_manual" ? { BROWSER: "/usr/bin/true" } : {}),
        CLAUDE_CONFIG_DIR: CONFIG_DIR,
        HOME: "/Users/test",
        NO_COLOR: "1",
        PATH: "/usr/bin:/bin",
      },
      stdin: 10,
      stdout: 11,
      stderr: 12,
    });
  });

  test("rejects invalid browser modes and unsupported manual hosts before resolving or spawning", async () => {
    expect(resolveClaudeLoginBrowserMode(undefined)).toBe("provider_default");
    expect(resolveClaudeLoginBrowserMode("provider_default", "win32")).toBe("provider_default");
    for (const host of ["win32", "freebsd", "aix"] as const) {
      expect(() => resolveClaudeLoginBrowserMode("owner_manual", host)).toThrow("supported POSIX host");
    }
    let resolutions = 0; let spawns = 0;
    for (const mode of [null, true, false, 1, "", "manual", "/usr/bin/true", {}, []]) {
      const options: Parameters<typeof runClaudeForegroundLogin>[0] = {
        configDir: CONFIG_DIR, signal: new AbortController().signal,
        stdio: { stdin: 0, stdout: 1, stderr: 2 },
        resolveRuntime: async () => { resolutions += 1; return runtime; },
        processFactory: () => { spawns += 1; throw new Error("Unexpected spawn."); },
      };
      Reflect.set(options, "browserMode", mode);
      await expect(runClaudeForegroundLogin(options)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    }
    expect(resolutions).toBe(0); expect(spawns).toBe(0);
  });

  test("refuses unavailable fixed manual opener without resolving, spawning or falling back", async () => {
    let resolutions = 0; let spawns = 0;
    const metadata = spyOn(fs, "lstatSync").mockImplementation(() => { throw new Error("Synthetic missing fixed opener."); });
    try {
      await expect(runClaudeForegroundLogin({
        browserMode: "owner_manual", configDir: CONFIG_DIR,
        signal: new AbortController().signal, stdio: { stdin: 0, stdout: 1, stderr: 2 },
        resolveRuntime: async () => { resolutions += 1; return runtime; },
        processFactory: () => { spawns += 1; throw new Error("Unexpected spawn."); },
      })).rejects.toMatchObject({ code: "INVALID_INPUT", message: "Claude manual-browser login requires the fixed system opener." });
      expect(resolutions).toBe(0); expect(spawns).toBe(0);
    } finally { metadata.mockRestore(); }
  });

  test("captures browser mode and profile before a mutable caller crosses runtime resolution", async () => {
    let release!: (runtime: PinnedClaudeRuntime) => void;
    let launched = 0;
    const options: Parameters<typeof runClaudeForegroundLogin>[0] = {
      browserMode: "owner_manual", configDir: CONFIG_DIR,
      signal: new AbortController().signal, signalSource: new FakeSignalSource(),
      stdio: { stdin: 0, stdout: 1, stderr: 2 },
      resolveRuntime: (input) => { expect(input.configDir).toBe(CONFIG_DIR); return new Promise((resolve) => { release = resolve; }); },
      processFactory: (input) => {
        launched += 1;
        expect(input.environment.BROWSER).toBe("/usr/bin/true");
        expect(input.environment.CLAUDE_CONFIG_DIR).toBe(CONFIG_DIR);
        return { exited: Promise.resolve(0), forceTerminate() {}, sendSignal() {} };
      },
    };
    const pending = runClaudeForegroundLogin(options);
    Reflect.set(options, "browserMode", "provider_default");
    Reflect.set(options, "configDir", "/other/profile");
    release(runtime);
    await expect(pending).resolves.toEqual({ state: "joined", exitCode: 0, interruptedBy: null });
    expect(launched).toBe(1);
  });

  test.each(["provider_default", "owner_manual"] as const)("does not double-forward terminal process-group signals with %s", async (browserMode) => {
    const signalSource = new FakeSignalSource();
    const forwarded: ClaudeLoginSignal[] = [];
    let resolveExit!: (code: number) => void;
    const pending = runClaudeForegroundLogin({
      browserMode,
      configDir: CONFIG_DIR,
      processFactory: () => ({
        exited: new Promise((resolve) => { resolveExit = resolve; }),
        forceTerminate: () => undefined,
        sendSignal: (signal) => { forwarded.push(signal); },
      }),
      resolveRuntime: async () => runtime,
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
    expect(signalSource.listeners.get("SIGTERM")?.size ?? 0).toBe(0);
  });

  test.each(["provider_default", "owner_manual"] as const)("forwards only explicit abort, force-terminates, and joins the child with %s", async (browserMode) => {
    const controller = new AbortController();
    const forwarded: ClaudeLoginSignal[] = [];
    let resolveExit!: (code: number) => void;
    let spawned!: () => void;
    const didSpawn = new Promise<void>((resolve) => { spawned = resolve; });
    const pending = runClaudeForegroundLogin({
      browserMode,
      configDir: CONFIG_DIR,
      processFactory: () => {
        spawned();
        return {
          exited: new Promise((resolve) => { resolveExit = resolve; }),
          forceTerminate: () => { resolveExit(137); },
          sendSignal: (signal) => { forwarded.push(signal); },
        };
      },
      resolveRuntime: async () => runtime,
      signal: controller.signal,
      signalGraceMs: 1,
      stdio: { stdin: 0, stdout: 1, stderr: 2 },
    });
    await didSpawn;
    controller.abort();
    await expect(pending).resolves.toEqual({ state: "joined", exitCode: 137, interruptedBy: "SIGTERM" });
    expect(forwarded).toEqual(["SIGTERM"]);
  });

  test("force-terminates when the foreground exit observer rejects", async () => {
    let forced = false;
    await expect(runClaudeForegroundLogin({
      configDir: CONFIG_DIR,
      processFactory: () => ({
        exited: Promise.reject(new Error("broken foreground wait")),
        forceTerminate: () => { forced = true; },
        sendSignal: () => undefined,
      }),
      runtime,
      signal: new AbortController().signal,
      signalSource: new FakeSignalSource(),
      stdio: { stdin: 0, stdout: 1, stderr: 2 },
    })).rejects.toMatchObject({ code: "PROCESS_EXITED" });
    expect(forced).toBe(true);
  });

  test.each(["provider_default", "owner_manual"] as const)("bounds the post-interruption join without claiming an unproven exit with %s", async (browserMode) => {
    const controller = new AbortController();
    let releaseExit!: (code: number) => void;
    let forced = false;
    const pending = runClaudeForegroundLogin({
      browserMode,
      configDir: CONFIG_DIR,
      processFactory: () => ({
        exited: new Promise<number>((resolve) => { releaseExit = resolve; }),
        forceTerminate: () => { forced = true; },
        sendSignal: () => undefined,
      }),
      runtime,
      signal: controller.signal,
      signalGraceMs: 1,
      forceJoinDeadlineMs: 1,
      signalSource: new FakeSignalSource(),
      stdio: { stdin: 0, stdout: 1, stderr: 2 },
    });
    const observed = pending.then(
      (result) => ({ kind: "completed" as const, result }),
      (error: unknown) => ({ kind: "failed" as const, error }),
    );
    controller.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await Promise.race([
        observed,
        new Promise<{ kind: "unbounded" }>((resolve) => {
          timer = setTimeout(() => resolve({ kind: "unbounded" }), 250);
        }),
      ]);
      expect(forced).toBe(true);
      expect(outcome).toMatchObject({ kind: "failed", error: { code: "TIMEOUT" } });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      releaseExit(137);
      await observed;
    }
  });
});
