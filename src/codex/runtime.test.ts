import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { CodexError } from "./errors.ts";
import type { CodexProcess } from "./process.ts";
import type { CodexAuthority } from "./protocol.ts";
import { launchPinnedCodexAppServer, resolvePinnedCodexRuntime } from "./runtime.ts";

const roots: string[] = [];
const codexAuthority = (processGeneration: number): CodexAuthority => ({
  profileId: "profile-a",
  processGeneration,
  provider: "codex",
  providerAccountId: "acct_00000000000000000000000000000000",
  bindingGeneration: 1,
});
const CREDENTIAL_STORE_PREFLIGHT = Object.freeze({
  cliAuth: "file",
  cwd: "/tmp/hra-control-plane/project",
  mcpOauth: "file",
} as const);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function fakePackage(version: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hra-control-plane-runtime-"));
  roots.push(root);
  await mkdir(join(root, "bin"));
  await writeFile(join(root, "bin", "codex.js"), "export {};\n", { mode: 0o700 });
  const packageJsonPath = join(root, "package.json");
  await writeFile(
    packageJsonPath,
    JSON.stringify({ name: "@openai/codex", version, bin: { codex: "bin/codex.js" } }),
  );
  return packageJsonPath;
}

class ByteQueue implements AsyncIterable<Uint8Array> {
  readonly #items: Uint8Array[] = [];
  readonly #waiters: Array<(result: IteratorResult<Uint8Array>) => void> = [];
  #closed = false;

  push(value: unknown): void {
    const bytes = new TextEncoder().encode(`${JSON.stringify(value)}\n`);
    const waiter = this.#waiters.shift();
    if (waiter === undefined) this.#items.push(bytes);
    else waiter({ done: false, value: bytes });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    return {
      next: async () => {
        const item = this.#items.shift();
        if (item !== undefined) return { done: false, value: item };
        if (this.#closed) return { done: true, value: undefined };
        return await new Promise<IteratorResult<Uint8Array>>((resolve) => {
          this.#waiters.push(resolve);
        });
      },
    };
  }
}

class TrackedProcess implements CodexProcess {
  readonly #stdout = new ByteQueue();
  readonly #stderr = new ByteQueue();
  readonly stdout = this.#stdout;
  readonly stderr = this.#stderr;
  readonly exited: Promise<number>;
  readonly signals: Array<"SIGTERM" | "SIGKILL"> = [];
  exitedSettled = false;
  readonly #onWrite: ((message: Record<string, unknown>, process: TrackedProcess) => void) | undefined;
  readonly #ignoreTerm: boolean;
  readonly #ignoreForce: boolean;
  readonly #terminateError: Error | undefined;
  #resolveExit!: (code: number) => void;

  constructor(input: Readonly<{
    ignoreForce?: boolean;
    ignoreTerm?: boolean;
    onWrite?: (message: Record<string, unknown>, process: TrackedProcess) => void;
    terminateError?: Error;
  }> = {}) {
    this.#ignoreForce = input.ignoreForce === true;
    this.#ignoreTerm = input.ignoreTerm === true;
    this.#onWrite = input.onWrite;
    this.#terminateError = input.terminateError;
    this.exited = new Promise((resolve) => {
      this.#resolveExit = resolve;
    });
  }

  async write(bytes: Uint8Array): Promise<void> {
    const message = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    this.#onWrite?.(message, this);
  }

  respond(value: unknown): void {
    this.#stdout.push(value);
  }

  terminate(): void {
    this.signals.push("SIGTERM");
    if (this.#terminateError !== undefined) throw this.#terminateError;
    if (!this.#ignoreTerm) this.#settle(0);
  }

  forceTerminate(): void {
    this.signals.push("SIGKILL");
    if (!this.#ignoreForce) this.#settle(137);
  }

  #settle(code: number): void {
    if (this.exitedSettled) return;
    this.exitedSettled = true;
    this.#stdout.close();
    this.#stderr.close();
    this.#resolveExit(code);
  }
}

describe("pinned Codex runtime", () => {
  test("resolves only the exact package and contained launcher", async () => {
    const packageJsonPath = await fakePackage("0.153.2");
    const runtime = await resolvePinnedCodexRuntime({
      packageJsonPath,
      bunExecutable: process.execPath,
    });
    expect(runtime.packageVersion).toBe("0.153.2");
    expect(runtime.launcherArgv.slice(2)).toEqual([
      "app-server",
      "--listen",
      "stdio://",
      "--config",
      'cli_auth_credentials_store="file"',
      "--config",
      'mcp_oauth_credentials_store="file"',
    ]);
  });

  test("fails closed on a version drift", async () => {
    const packageJsonPath = await fakePackage("0.149.1");
    const error = await resolvePinnedCodexRuntime({
      packageJsonPath,
      bunExecutable: process.execPath,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CodexError);
  });

  test("forces both credential stores to files in the real pinned app-server", async () => {
    const codexHome = await realpath(await mkdtemp(join(tmpdir(), "oompa-codex-custody-")));
    roots.push(codexHome);
    const client = await launchPinnedCodexAppServer({
      authority: codexAuthority(1),
      credentialStorePreflight: {
        cliAuth: "file",
        cwd: codexHome,
        mcpOauth: "file",
      },
      expectedCodexHome: codexHome,
      experimentalApi: true,
      isAuthorityCurrent: () => true,
    });
    try {
      expect(client.state).toBe("ready");
    } finally {
      await client.close();
    }
  });

  test("forwards explicit shutdown bounds to the client", async () => {
    const packageJsonPath = await fakePackage("0.153.2");
    const child = new TrackedProcess();
    const error = await launchPinnedCodexAppServer({
      packageJsonPath,
      bunExecutable: process.execPath,
      processFactory: () => child,
      authority: codexAuthority(1),
      credentialStorePreflight: CREDENTIAL_STORE_PREFLIGHT,
      expectedCodexHome: "/tmp/hra-control-plane/profile-a/codex-home",
      isAuthorityCurrent: () => true,
      shutdownTermGraceMs: 0,
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "INVALID_INPUT" });
    expect(child.exitedSettled).toBe(true);
    expect(child.signals).toEqual(["SIGTERM"]);
  });

  test("forwards the synchronous account-authority signal to the client", async () => {
    const packageJsonPath = await fakePackage("0.153.2");
    const codexHome = "/tmp/hra-control-plane/profile-a/codex-home";
    const events: string[] = [];
    const child = new TrackedProcess({
      onWrite: (message, target) => {
        if (message.method === "initialize") {
          target.respond({
            id: message.id,
            result: {
              userAgent: "codex-cli/0.153.2",
              codexHome,
              platformFamily: "unix",
              platformOs: "macos",
            },
          });
        } else if (message.method === "config/read") {
          target.respond({
            id: message.id,
            result: {
              config: {
                cli_auth_credentials_store: "file",
                mcp_oauth_credentials_store: "file",
              },
              origins: {},
            },
          });
        }
      },
    });
    const client = await launchPinnedCodexAppServer({
      packageJsonPath,
      bunExecutable: process.execPath,
      processFactory: () => child,
      authority: codexAuthority(1),
      credentialStorePreflight: CREDENTIAL_STORE_PREFLIGHT,
      expectedCodexHome: codexHome,
      isAuthorityCurrent: () => true,
      onAccountAuthoritySignal: () => { events.push("signal"); },
      onFact: ({ value }) => { events.push(`fact:${value.type}`); },
    });
    child.respond({
      method: "account/updated",
      params: { authMode: "chatgpt", planType: "pro" },
    });
    child.respond({
      method: "account/login/completed",
      params: { loginId: "login-exact", success: true },
    });
    for (let attempt = 0; attempt < 200 && events.length < 5; attempt += 1) {
      await Bun.sleep(1);
    }

    expect(events.filter((event) => event === "signal")).toHaveLength(2);
    const firstAccountFact = events.indexOf("fact:accountUpdated");
    const loginFact = events.indexOf("fact:loginCompleted");
    expect(events.slice(0, firstAccountFact).filter((event) => event === "signal"))
      .not.toHaveLength(0);
    expect(events.slice(0, loginFact).filter((event) => event === "signal"))
      .toHaveLength(2);
    await client.close();
  });

  test("reaps the exact spawned process when client construction fails", async () => {
    const packageJsonPath = await fakePackage("0.153.2");
    const child = new TrackedProcess({ ignoreTerm: true });
    const error = await launchPinnedCodexAppServer({
      packageJsonPath,
      bunExecutable: process.execPath,
      processFactory: () => child,
      authority: codexAuthority(0),
      credentialStorePreflight: CREDENTIAL_STORE_PREFLIGHT,
      expectedCodexHome: "/tmp/hra-control-plane/profile-a/codex-home",
      isAuthorityCurrent: () => true,
      shutdownTermGraceMs: 1,
      shutdownSettlementMs: 5,
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "INVALID_INPUT" });
    expect(child.exitedSettled).toBe(true);
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  test("reaps the exact spawned process when initialization fails", async () => {
    const packageJsonPath = await fakePackage("0.153.2");
    const codexHome = "/tmp/hra-control-plane/profile-a/codex-home";
    const child = new TrackedProcess({
      onWrite: (message, target) => {
        if (message.method !== "initialize") return;
        target.respond({
          id: message.id,
          result: {
            userAgent: "codex-cli/0.149.1",
            codexHome,
            platformFamily: "unix",
            platformOs: "macos",
          },
        });
      },
    });
    const error = await launchPinnedCodexAppServer({
      packageJsonPath,
      bunExecutable: process.execPath,
      processFactory: () => child,
      authority: codexAuthority(1),
      credentialStorePreflight: CREDENTIAL_STORE_PREFLIGHT,
      expectedCodexHome: codexHome,
      isAuthorityCurrent: () => true,
      shutdownTermGraceMs: 5,
      shutdownSettlementMs: 5,
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "RUNTIME_MISMATCH" });
    expect(child.exitedSettled).toBe(true);
    expect(child.signals).toEqual(["SIGTERM"]);
  });

  test("failed construction waits for native custody after root exit and accepts an asynchronous factory", async () => {
    const packageJsonPath = await fakePackage("0.153.2");
    const child = new TrackedProcess();
    let release!: () => void;
    const joined = new Promise<void>(resolve => { release = resolve; });
    const force = child.forceTerminate.bind(child);
    const nativeChild: CodexProcess = Object.assign(child, {
      joinCustody: () => joined,
      forceTerminate: () => { force(); release(); },
    });
    const error = await launchPinnedCodexAppServer({
      packageJsonPath, bunExecutable: process.execPath, processFactory: async () => nativeChild,
      authority: codexAuthority(0), credentialStorePreflight: CREDENTIAL_STORE_PREFLIGHT,
      expectedCodexHome: "/tmp/hra-control-plane/profile-a/codex-home", isAuthorityCurrent: () => true,
      shutdownTermGraceMs: 1, shutdownSettlementMs: 20,
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "INVALID_INPUT" });
    expect(child.exitedSettled).toBe(true);
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  test("preserves initialization failure when TERM cleanup also fails", async () => {
    const packageJsonPath = await fakePackage("0.153.2");
    const codexHome = "/tmp/hra-control-plane/profile-a/codex-home";
    const termError = new Error("deterministic TERM failure");
    const child = new TrackedProcess({
      terminateError: termError,
      onWrite: (message, target) => {
        if (message.method !== "initialize") return;
        target.respond({
          id: message.id,
          result: {
            userAgent: "codex-cli/0.149.1",
            codexHome,
            platformFamily: "unix",
            platformOs: "macos",
          },
        });
      },
    });
    const error = await launchPinnedCodexAppServer({
      packageJsonPath,
      bunExecutable: process.execPath,
      processFactory: () => child,
      authority: codexAuthority(1),
      credentialStorePreflight: CREDENTIAL_STORE_PREFLIGHT,
      expectedCodexHome: codexHome,
      isAuthorityCurrent: () => true,
      shutdownTermGraceMs: 1,
      shutdownSettlementMs: 5,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AggregateError);
    const errors = (error as AggregateError).errors as readonly unknown[];
    expect(errors[0]).toMatchObject({ code: "RUNTIME_MISMATCH" });
    expect(errors[1]).toBe(termError);
    expect(child.exitedSettled).toBe(true);
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  test("bounds and aggregates a process that cannot be reaped", async () => {
    const packageJsonPath = await fakePackage("0.153.2");
    const child = new TrackedProcess({ ignoreTerm: true, ignoreForce: true });
    const error = await launchPinnedCodexAppServer({
      packageJsonPath,
      bunExecutable: process.execPath,
      processFactory: () => child,
      authority: codexAuthority(0),
      credentialStorePreflight: CREDENTIAL_STORE_PREFLIGHT,
      expectedCodexHome: "/tmp/hra-control-plane/profile-a/codex-home",
      isAuthorityCurrent: () => true,
      shutdownTermGraceMs: 1,
      shutdownSettlementMs: 1,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AggregateError);
    const errors = (error as AggregateError).errors as readonly unknown[];
    expect(errors[0]).toMatchObject({ code: "INVALID_INPUT" });
    expect(errors[1]).toMatchObject({
      message: "Codex process did not exit within the bounded launch cleanup window.",
    });
    expect(child.exitedSettled).toBe(false);
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });
});
