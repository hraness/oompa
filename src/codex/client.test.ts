import { describe, expect, jest, spyOn, test } from "bun:test";

import { OOMPA_VERSION } from "../version.ts";
import { CodexAppServerClient, type CodexAppServerClientOptions } from "./client.ts";
import { CodexError } from "./errors.ts";
import type { CodexProcess } from "./process.ts";
import {
  OOMPA_HOST_DYNAMIC_TOOLS,
  OOMPA_CONVERSATION_AUTOMATION_DYNAMIC_TOOLS,
  type CodexAuthority,
  type CodexFact,
  type FencedCodexValue,
  type OompaHostToolCall,
} from "./protocol.ts";

const CONNECTION_ID = "018f1f55-3f10-7c1a-8f7b-c6dc608bcd3b";
const CODEX_PROVIDER_ACCOUNT_ID = "acct_00000000000000000000000000000000";
const codexAuthority = (processGeneration: number): CodexAuthority => ({
  profileId: "profile-a",
  processGeneration,
  provider: "codex",
  providerAccountId: CODEX_PROVIDER_ACCOUNT_ID,
  bindingGeneration: 1,
});
const CREDENTIAL_STORE_PREFLIGHT = Object.freeze({
  cliAuth: "file",
  cwd: "/tmp/hra-control-plane/project",
  mcpOauth: "file",
} as const);

type TestClientOptions = Omit<CodexAppServerClientOptions, "credentialStorePreflight">
  & Partial<Pick<CodexAppServerClientOptions, "credentialStorePreflight">>;

function createClient(options: TestClientOptions): CodexAppServerClient {
  return new CodexAppServerClient({
    credentialStorePreflight: CREDENTIAL_STORE_PREFLIGHT,
    ...options,
  });
}

const commandApprovalParams = (reason = "Need network access") => ({
  threadId: "thread-1",
  turnId: "turn-1",
  itemId: "item-1",
  startedAtMs: 1,
  approvalId: null,
  environmentId: null,
  reason,
  networkApprovalContext: null,
  command: "git push origin main",
  cwd: "/workspace/project",
  commandActions: [],
  additionalPermissions: null,
  proposedExecpolicyAmendment: null,
  proposedNetworkPolicyAmendments: null,
  availableDecisions: ["accept", "acceptForSession", "decline", "cancel"],
});

const conversationAutomationParams = (argumentsValue: unknown = {
  mode: "create",
  name: "Daily review",
  prompt: "Review the current conversation and continue the work.",
  schedule: { kind: "interval_minutes", minutes: 60 },
}) => ({
  threadId: "thread-1",
  turnId: "turn-1",
  callId: "call-1",
  namespace: "hra",
  tool: "automation_update",
  arguments: argumentsValue,
});

const appFixture = (id: string) => ({
  id,
  name: `App ${id}`,
  description: null,
  isAccessible: true,
  isEnabled: true,
  pluginDisplayNames: [],
});

class ByteQueue implements AsyncIterable<Uint8Array> {
  readonly #items: Uint8Array[] = [];
  readonly #waiters: ((result: IteratorResult<Uint8Array>) => void)[] = [];
  #closed = false;

  push(value: string): void {
    const bytes = new TextEncoder().encode(value);
    const waiter = this.#waiters.shift();
    if (waiter === undefined) this.#items.push(bytes);
    else waiter({ done: false, value: bytes });
  }

  close(): void {
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

class FakeProcess implements CodexProcess {
  readonly stdoutQueue = new ByteQueue();
  readonly stderrQueue = new ByteQueue();
  readonly stdout = this.stdoutQueue;
  readonly stderr = this.stderrQueue;
  readonly writes: unknown[] = [];
  readonly signals: ("SIGTERM" | "SIGKILL")[] = [];
  writeError: Error | undefined;
  writeSettlementGate: Promise<void> | undefined;
  readonly exited: Promise<number>;
  #responseCount = 0;
  #resolveExit!: (code: number) => void;

  constructor(
    readonly onWrite: (message: Record<string, unknown>, process: FakeProcess) => void,
    readonly shutdown: {
      readonly autoCredentialStorePreflight?: boolean;
      readonly ignoreKill?: boolean;
      readonly ignoreTerm?: boolean;
      readonly leaveStreamsOpenAfterKill?: boolean;
    } = {},
  ) {
    this.exited = new Promise((resolve) => {
      this.#resolveExit = resolve;
    });
  }

  async write(bytes: Uint8Array): Promise<void> {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    this.writes.push(parsed);
    if (this.writeError !== undefined) {
      const error = this.writeError;
      this.writeError = undefined;
      throw error;
    }
    const responseCountBeforeWrite = this.#responseCount;
    this.onWrite(parsed as Record<string, unknown>, this);
    if (
      (parsed as Record<string, unknown>).method === "config/read"
      && this.shutdown.autoCredentialStorePreflight !== false
      && this.#responseCount === responseCountBeforeWrite
    ) {
      this.respond({
        id: (parsed as Record<string, unknown>).id,
        result: {
          config: {
            cli_auth_credentials_store: "file",
            mcp_oauth_credentials_store: "file",
          },
          origins: {},
        },
      });
    }
    const gate = this.writeSettlementGate;
    this.writeSettlementGate = undefined;
    if (gate !== undefined) await gate;
  }

  respond(value: unknown): void {
    this.#responseCount += 1;
    this.stdoutQueue.push(`${JSON.stringify(value)}\n`);
  }

  terminate(): void {
    this.signals.push("SIGTERM");
    if (this.shutdown.ignoreTerm === true) return;
    this.stdoutQueue.close();
    this.stderrQueue.close();
    this.#resolveExit(0);
  }

  forceTerminate(): void {
    this.signals.push("SIGKILL");
    if (this.shutdown.ignoreKill === true) return;
    if (this.shutdown.leaveStreamsOpenAfterKill !== true) {
      this.stdoutQueue.close();
      this.stderrQueue.close();
    }
    this.#resolveExit(137);
  }

  settleExit(code = 137): void {
    this.#resolveExit(code);
  }
}

function successfulFake(codexHome: string, userAgent = "codex-cli/0.153.2"): FakeProcess {
  return new FakeProcess((message, process) => {
    if (message.method === "initialize") {
      process.respond({
        id: message.id,
        result: {
          userAgent,
          codexHome,
          platformFamily: "unix",
          platformOs: "macos",
        },
      });
    } else if (message.method === "account/read") {
      process.respond({
        id: message.id,
        result: {
          account: { type: "chatgpt", email: "person@example.com", planType: "pro" },
          requiresOpenaiAuth: true,
        },
      });
    }
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await Bun.sleep(1);
  }
  throw new Error("condition did not settle");
}

function deferred<T>(): Readonly<{
  promise: Promise<T>;
  resolve: (value: T) => void;
}> {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

describe("CodexAppServerClient", () => {
  test("requires credential-store proof at the client boundary", () => {
    const process = successfulFake("/tmp/hra-control-plane/profile-a/codex-home");
    const options = {
      process,
      authority: codexAuthority(1),
      expectedCodexHome: "/tmp/hra-control-plane/profile-a/codex-home",
      isAuthorityCurrent: () => true,
    } as unknown as CodexAppServerClientOptions;

    expect(() => new CodexAppServerClient(options)).toThrow(
      "credential-store preflight is required",
    );
    expect(process.writes).toEqual([]);
    expect(process.signals).toEqual([]);
  });

  test("bounds the deterministic capability-discovery deadline override", () => {
    const process = successfulFake("/tmp/hra-control-plane/profile-a/codex-home");
    expect(() => createClient({
      process,
      authority: codexAuthority(1),
      expectedCodexHome: "/tmp/hra-control-plane/profile-a/codex-home",
      isAuthorityCurrent: () => true,
      capabilityDiscoveryDeadlineMs: 40_001,
    })).toThrow("capability discovery deadline must be an integer between 1 and 40000 milliseconds");
    expect(process.writes).toEqual([]);
    expect(process.signals).toEqual([]);
  });

  test("preflights both effective credential stores before becoming available", async () => {
    const codexHome = "/tmp/hra-control-plane/profile-a/codex-home";
    let configReads = 0;
    const process = new FakeProcess((message, runtime) => {
      if (message.method === "initialize") {
        runtime.respond({
          id: message.id,
          result: {
            userAgent: "codex-cli/0.153.2",
            codexHome,
            platformFamily: "unix",
            platformOs: "macos",
          },
        });
      } else if (message.method === "config/read") {
        expect(message.params).toEqual({
          cwd: configReads === 0
            ? "/private/tmp/oompa-acceptance/project-a"
            : "/private/tmp/oompa-acceptance/project-b",
          includeLayers: false,
        });
        configReads += 1;
        runtime.respond({
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
    }, { autoCredentialStorePreflight: false });
    const client = createClient({
      process,
      authority: codexAuthority(7),
      credentialStorePreflight: {
        cliAuth: "file",
        cwd: "/private/tmp/oompa-acceptance/project-a",
        mcpOauth: "file",
      },
      expectedCodexHome: codexHome,
      isAuthorityCurrent: () => true,
    });

    await expect(client.initialize()).resolves.toMatchObject({
      authority: codexAuthority(7),
    });
    await expect(client.assertCredentialStores(
      "/private/tmp/oompa-acceptance/project-b",
    )).resolves.toBeUndefined();
    expect(process.writes).toContainEqual({
      id: 2,
      method: "config/read",
      params: {
        cwd: "/private/tmp/oompa-acceptance/project-a",
        includeLayers: false,
      },
    });
    expect(configReads).toBe(2);
    await client.close();
  });

  test("consumes a reset credit with only the caller-persisted UUID", async () => {
    const codexHome = "/tmp/hra-control-plane/profile-a/codex-home";
    const idempotencyKey = "00000000-0000-4000-8000-000000000001";
    const process = new FakeProcess((message, runtime) => {
      if (message.method === "initialize") {
        runtime.respond({
          id: message.id,
          result: {
            userAgent: "codex-cli/0.153.2",
            codexHome,
            platformFamily: "unix",
            platformOs: "macos",
          },
        });
      } else if (message.method === "account/rateLimitResetCredit/consume") {
        runtime.respond({ id: message.id, result: { outcome: "reset" } });
      }
    });
    const client = createClient({
      process,
      authority: codexAuthority(7),
      expectedCodexHome: codexHome,
      isAuthorityCurrent: () => true,
    });
    await client.initialize();

    await expect(client.consumeRateLimitResetCredit(idempotencyKey)).resolves.toEqual({
      authority: codexAuthority(7),
      value: { outcome: "reset" },
    });
    expect(process.writes.at(-1)).toEqual({
      id: 3,
      method: "account/rateLimitResetCredit/consume",
      params: { idempotencyKey },
    });
    expect(JSON.stringify(process.writes.at(-1))).not.toContain("creditId");

    const writesBeforeInvalid = process.writes.length;
    await expect(client.consumeRateLimitResetCredit("not-a-uuid")).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(process.writes).toHaveLength(writesBeforeInvalid);
    await client.close();
  });

  test("classifies an unsupported reset-credit outcome as indeterminate", async () => {
    const codexHome = "/tmp/hra-control-plane/profile-a/codex-home";
    const process = new FakeProcess((message, runtime) => {
      if (message.method === "initialize") {
        runtime.respond({
          id: message.id,
          result: {
            userAgent: "codex-cli/0.153.2",
            codexHome,
            platformFamily: "unix",
            platformOs: "macos",
          },
        });
      } else if (message.method === "account/rateLimitResetCredit/consume") {
        runtime.respond({ id: message.id, result: { outcome: "futureOutcome" } });
      }
    });
    const client = createClient({
      process,
      authority: codexAuthority(1),
      expectedCodexHome: codexHome,
      isAuthorityCurrent: () => true,
    });
    await client.initialize();

    await expect(client.consumeRateLimitResetCredit(
      "00000000-0000-4000-8000-000000000002",
    )).rejects.toMatchObject({
      code: "INDETERMINATE_EFFECT",
      operation: "account/rateLimitResetCredit/consume",
    });
    await client.close();
  });

  test("fails closed when an effective credential store is not file-backed", async () => {
    const codexHome = "/tmp/hra-control-plane/profile-a/codex-home";
    const process = new FakeProcess((message, runtime) => {
      if (message.method === "initialize") {
        runtime.respond({
          id: message.id,
          result: {
            userAgent: "codex-cli/0.153.2",
            codexHome,
            platformFamily: "unix",
            platformOs: "macos",
          },
        });
      } else if (message.method === "config/read") {
        runtime.respond({
          id: message.id,
          result: {
            config: {
              cli_auth_credentials_store: "file",
              mcp_oauth_credentials_store: "keyring",
            },
            origins: {},
          },
        });
      }
    });
    const client = createClient({
      process,
      authority: codexAuthority(7),
      credentialStorePreflight: {
        cliAuth: "file",
        cwd: "/private/tmp/oompa-acceptance/project-a",
        mcpOauth: "file",
      },
      expectedCodexHome: codexHome,
      isAuthorityCurrent: () => true,
    });

    const error = await client.initialize().catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "RUNTIME_MISMATCH" });
    expect(client.state).toBe("failed");
    expect(process.signals).toEqual(["SIGTERM"]);
  });

  test("admits no provider facts or interactions before credential-store proof", async () => {
    const codexHome = "/tmp/hra-control-plane/profile-a/codex-home";
    const facts: CodexFact[] = [];
    let configRequestId: unknown;
    const process = new FakeProcess((message, runtime) => {
      if (message.method === "initialize") {
        runtime.respond({
          id: message.id,
          result: {
            userAgent: "codex-cli/0.153.2",
            codexHome,
            platformFamily: "unix",
            platformOs: "macos",
          },
        });
      } else if (message.method === "config/read") {
        configRequestId = message.id;
        runtime.respond({
          method: "account/updated",
          params: { authMode: "chatgpt", planType: "pro" },
        });
        runtime.respond({
          id: 91,
          method: "item/commandExecution/requestApproval",
          params: commandApprovalParams(),
        });
      }
    }, { autoCredentialStorePreflight: false });
    const client = createClient({
      process,
      authority: codexAuthority(7),
      credentialStorePreflight: {
        cliAuth: "file",
        cwd: "/private/tmp/oompa-acceptance/project-a",
        mcpOauth: "file",
      },
      expectedCodexHome: codexHome,
      isAuthorityCurrent: () => true,
      onFact: ({ value }) => { facts.push(value); },
    });

    const initialization = client.initialize();
    await waitFor(() => configRequestId !== undefined);
    await waitFor(() => process.writes.some((value) =>
      (value as { id?: unknown }).id === 91));
    expect(client.state).toBe("preflighting");
    expect(facts).toEqual([]);

    process.respond({
      id: configRequestId,
      result: {
        config: {
          cli_auth_credentials_store: "file",
          mcp_oauth_credentials_store: "keyring",
        },
        origins: {},
      },
    });
    await expect(initialization).rejects.toMatchObject({ code: "RUNTIME_MISMATCH" });
    await Bun.sleep(1);
    expect(facts).toEqual([]);
    expect(process.writes).toContainEqual({
      id: 91,
      error: {
        code: -32_001,
        message: "Oompa has not activated this provider connection",
      },
    });
  });

  test("replays bounded preflight notifications only after the connection is proven", async () => {
    const codexHome = "/tmp/hra-control-plane/profile-a/codex-home";
    const facts: CodexFact[] = [];
    const process = new FakeProcess((message, runtime) => {
      if (message.method === "initialize") {
        runtime.respond({
          id: message.id,
          result: {
            userAgent: "codex-cli/0.153.2",
            codexHome,
            platformFamily: "unix",
            platformOs: "macos",
          },
        });
      } else if (message.method === "config/read") {
        runtime.respond({
          method: "account/updated",
          params: { authMode: "chatgpt", planType: "pro" },
        });
        runtime.respond({
          method: "serverRequest/resolved",
          params: { threadId: "thread-1", requestId: 91 },
        });
        runtime.respond({
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
    });
    const client = createClient({
      process,
      authority: codexAuthority(7),
      credentialStorePreflight: {
        cliAuth: "file",
        cwd: "/private/tmp/oompa-acceptance/project-a",
        mcpOauth: "file",
      },
      expectedCodexHome: codexHome,
      isAuthorityCurrent: () => true,
      connectionId: CONNECTION_ID,
      onFact: ({ value }) => { facts.push(value); },
    });

    await client.initialize();
    await waitFor(() => facts.length === 3);
    expect(facts).toEqual([
      { type: "providerConnected", connectionId: CONNECTION_ID },
      {
        type: "accountUpdated",
        authMode: "chatgpt",
        planType: "pro",
        connectionId: CONNECTION_ID,
      },
      {
        type: "protocolNotice",
        method: "serverRequest/resolved",
        connectionId: CONNECTION_ID,
      },
    ]);
    await client.close();
  });

  test("commits ready before providerConnected and preserves a notification at the activation boundary", async () => {
    const codexHome = "/tmp/hra-control-plane/profile-a/codex-home";
    const activationGate = deferred<boolean>();
    const facts: Array<Readonly<{ state: string; value: CodexFact }>> = [];
    let authorityChecks = 0;
    const process = successfulFake(codexHome);
    const client = createClient({
      process,
      authority: codexAuthority(7),
      expectedCodexHome: codexHome,
      isAuthorityCurrent: () => {
        authorityChecks += 1;
        return authorityChecks === 6 ? activationGate.promise : true;
      },
      connectionId: CONNECTION_ID,
      onFact: ({ value }) => { facts.push({ state: client.state, value }); },
    });

    const initialization = client.initialize();
    await waitFor(() => authorityChecks === 6);
    expect(client.state).toBe("preflighting");
    process.respond({
      method: "account/updated",
      params: { authMode: "chatgpt", planType: "pro" },
    });
    await Bun.sleep(1);
    expect(facts).toEqual([]);

    activationGate.resolve(true);
    await initialization;
    await waitFor(() => facts.length === 2);
    expect(facts).toEqual([
      {
        state: "ready",
        value: { type: "providerConnected", connectionId: CONNECTION_ID },
      },
      {
        state: "ready",
        value: {
          type: "accountUpdated",
          authMode: "chatgpt",
          planType: "pro",
          connectionId: CONNECTION_ID,
        },
      },
    ]);
    await client.close();
  });

  test("raises account authority before its first await and lets only the refresh read pass blocked frames", async () => {
    const codexHome = "/tmp/hra-control-plane/profile-a/codex-home";
    const barrier = deferred<undefined>();
    const events: string[] = [];
    let signaled = false;
    const process = successfulFake(codexHome);
    const client = createClient({
      process,
      authority: codexAuthority(7),
      expectedCodexHome: codexHome,
      isAuthorityCurrent: () => {
        if (signaled) events.push("authority-check");
        return true;
      },
      connectionId: CONNECTION_ID,
      onAccountAuthoritySignal: () => {
        events.push("signal");
        signaled = true;
        return barrier.promise;
      },
    });
    await client.initialize();
    const writesBeforeSignal = process.writes.length;

    process.stdoutQueue.push([
      JSON.stringify({
        method: "account/updated",
        params: { authMode: "chatgpt", planType: "pro" },
      }),
      JSON.stringify({ id: 91, method: "unsupported/request", params: {} }),
      "",
    ].join("\n"));
    await waitFor(() => events.includes("authority-check"));
    expect(events.slice(0, 2)).toEqual(["signal", "authority-check"]);

    const ordinaryRead = client.accountRead();
    const refreshRead = client.refreshAccountAuthority();
    await refreshRead;
    expect(process.writes.slice(writesBeforeSignal)).toContainEqual({
      id: expect.any(Number),
      method: "account/read",
      params: { refreshToken: true },
    });
    expect(process.writes.slice(writesBeforeSignal)).not.toContainEqual({
      id: expect.any(Number),
      method: "account/read",
      params: { refreshToken: false },
    });
    expect(process.writes.slice(writesBeforeSignal)).not.toContainEqual({
      id: 91,
      error: expect.any(Object),
    });

    barrier.resolve(undefined);
    await ordinaryRead;
    await waitFor(() => process.writes.some((frame) =>
      (frame as Record<string, unknown>).id === 91));
    expect(process.writes.slice(writesBeforeSignal)).toContainEqual({
      id: expect.any(Number),
      method: "account/read",
      params: { refreshToken: false },
    });
    await client.close();
  });

  test("holds a pre-admitted queued provider write behind a later account signal", async () => {
    const codexHome = "/tmp/hra-control-plane/profile-a/codex-home";
    const firstWriteGate = deferred<undefined>();
    const accountBarrier = deferred<undefined>();
    let signaled = false;
    const process = successfulFake(codexHome);
    const client = createClient({
      process,
      authority: codexAuthority(7),
      expectedCodexHome: codexHome,
      isAuthorityCurrent: () => true,
      connectionId: CONNECTION_ID,
      onAccountAuthoritySignal: () => {
        signaled = true;
        return accountBarrier.promise;
      },
    });
    await client.initialize();
    const writesBeforeReads = process.writes.length;
    process.writeSettlementGate = firstWriteGate.promise;
    const first = client.accountRead();
    await waitFor(() => process.writes.slice(writesBeforeReads).some((frame) =>
      (frame as Record<string, unknown>).method === "account/read"));
    const second = client.accountRead();

    process.respond({
      method: "account/updated",
      params: { authMode: "chatgpt", planType: "pro" },
    });
    await waitFor(() => signaled);
    const refresh = client.refreshAccountAuthority();
    firstWriteGate.resolve(undefined);
    await Promise.all([first, refresh]);
    expect(process.writes.slice(writesBeforeReads).filter((frame) =>
      (frame as Record<string, unknown>).method === "account/read"))
      .toEqual([
        expect.objectContaining({ params: { refreshToken: false } }),
        expect.objectContaining({ params: { refreshToken: true } }),
      ]);

    accountBarrier.resolve(undefined);
    await second;
    expect(process.writes.slice(writesBeforeReads).filter((frame) =>
      (frame as Record<string, unknown>).method === "account/read"))
      .toEqual([
        expect.objectContaining({ params: { refreshToken: false } }),
        expect.objectContaining({ params: { refreshToken: true } }),
        expect.objectContaining({ params: { refreshToken: false } }),
      ]);
    await client.close();
  });

  test("defers an already-dispatched response without blocking the refresh response read", async () => {
    const codexHome = "/tmp/hra-control-plane/profile-a/codex-home";
    const accountBarrier = deferred<undefined>();
    let ordinaryRequestId: number | undefined;
    let signaled = false;
    const process = new FakeProcess((message, runtime) => {
      if (message.method === "initialize") {
        runtime.respond({
          id: message.id,
          result: {
            userAgent: "codex-cli/0.153.2",
            codexHome,
            platformFamily: "unix",
            platformOs: "macos",
          },
        });
      } else if (message.method === "account/read") {
        const params = message.params as { refreshToken?: boolean };
        if (params.refreshToken === true) {
          runtime.respond({
            id: message.id,
            result: {
              account: { type: "chatgpt", email: "person@example.com", planType: "pro" },
              requiresOpenaiAuth: true,
            },
          });
        } else {
          ordinaryRequestId = message.id as number;
        }
      }
    });
    const client = createClient({
      process,
      authority: codexAuthority(7),
      expectedCodexHome: codexHome,
      isAuthorityCurrent: () => true,
      connectionId: CONNECTION_ID,
      onAccountAuthoritySignal: () => {
        signaled = true;
        return accountBarrier.promise;
      },
    });
    await client.initialize();
    const ordinary = client.accountRead();
    await waitFor(() => ordinaryRequestId !== undefined);
    process.stdoutQueue.push([
      JSON.stringify({
        method: "account/updated",
        params: { authMode: "chatgpt", planType: "pro" },
      }),
      JSON.stringify({
        id: ordinaryRequestId,
        result: {
          account: { type: "chatgpt", email: "old@example.com", planType: "pro" },
          requiresOpenaiAuth: true,
        },
      }),
      JSON.stringify({ id: 92, method: "unsupported/request", params: {} }),
      "",
    ].join("\n"));
    await waitFor(() => signaled);
    let ordinarySettled = false;
    void ordinary.then(() => { ordinarySettled = true; });

    await client.refreshAccountAuthority();
    await Promise.resolve();
    expect(ordinarySettled).toBe(false);
    expect(process.writes).not.toContainEqual({ id: 92, error: expect.any(Object) });

    accountBarrier.resolve(undefined);
    await ordinary;
    await waitFor(() => process.writes.some((frame) =>
      (frame as Record<string, unknown>).id === 92));
    expect(ordinarySettled).toBe(true);
    await client.close();
  });

  test("close rejects a barrier-deferred response and permanently cancels queued frames", async () => {
    const codexHome = "/tmp/hra-control-plane/profile-a/codex-home";
    const accountBarrier = deferred<undefined>();
    let ordinaryRequestId: number | undefined;
    let signaled = false;
    const process = new FakeProcess((message, runtime) => {
      if (message.method === "initialize") {
        runtime.respond({
          id: message.id,
          result: {
            userAgent: "codex-cli/0.153.2",
            codexHome,
            platformFamily: "unix",
            platformOs: "macos",
          },
        });
      } else if (message.method === "account/read") {
        ordinaryRequestId = message.id as number;
      }
    });
    const client = createClient({
      process,
      authority: codexAuthority(7),
      expectedCodexHome: codexHome,
      isAuthorityCurrent: () => true,
      connectionId: CONNECTION_ID,
      shutdownSettlementMs: 5,
      onAccountAuthoritySignal: () => {
        signaled = true;
        return accountBarrier.promise;
      },
    });
    await client.initialize();
    const ordinary = client.accountRead();
    const ordinaryError = ordinary.catch((error: unknown) => error);
    await waitFor(() => ordinaryRequestId !== undefined);
    process.stdoutQueue.push([
      JSON.stringify({
        method: "account/updated",
        params: { authMode: "chatgpt", planType: "pro" },
      }),
      JSON.stringify({
        id: ordinaryRequestId,
        result: {
          account: { type: "chatgpt", email: "old@example.com", planType: "pro" },
          requiresOpenaiAuth: true,
        },
      }),
      JSON.stringify({ id: 93, method: "unsupported/request", params: {} }),
      "",
    ].join("\n"));
    await waitFor(() => signaled);
    await client.close();
    expect(await ordinaryError).toMatchObject({ code: "PROCESS_EXITED" });
    const writesAtClose = process.writes.length;

    accountBarrier.resolve(undefined);
    await Bun.sleep(2);
    expect(process.writes).toHaveLength(writesAtClose);
    expect(process.writes).not.toContainEqual({ id: 93, error: expect.any(Object) });
  });

  test("emits no connection facts when authority becomes stale at the activation commit", async () => {
    const codexHome = "/tmp/hra-control-plane/profile-a/codex-home";
    const activationGate = deferred<boolean>();
    const facts: CodexFact[] = [];
    let authorityChecks = 0;
    const process = successfulFake(codexHome);
    const client = createClient({
      process,
      authority: codexAuthority(7),
      expectedCodexHome: codexHome,
      isAuthorityCurrent: () => {
        authorityChecks += 1;
        return authorityChecks === 6 ? activationGate.promise : true;
      },
      onFact: ({ value }) => { facts.push(value); },
    });

    const initialization = client.initialize();
    await waitFor(() => authorityChecks === 6);
    activationGate.resolve(false);
    await expect(initialization).rejects.toMatchObject({ code: "AUTHORITY_STALE" });
    await Bun.sleep(1);
    expect(facts).toEqual([]);
  });

  test("emits no buffered facts when the process exits before the activation commit", async () => {
    const codexHome = "/tmp/hra-control-plane/profile-a/codex-home";
    const activationGate = deferred<boolean>();
    const facts: CodexFact[] = [];
    let authorityChecks = 0;
    const process = new FakeProcess((message, runtime) => {
      if (message.method === "initialize") {
        runtime.respond({
          id: message.id,
          result: {
            userAgent: "codex-cli/0.153.2",
            codexHome,
            platformFamily: "unix",
            platformOs: "macos",
          },
        });
      } else if (message.method === "config/read") {
        runtime.respond({
          method: "account/updated",
          params: { authMode: "chatgpt", planType: "pro" },
        });
        runtime.respond({
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
    });
    const client = createClient({
      process,
      authority: codexAuthority(7),
      expectedCodexHome: codexHome,
      isAuthorityCurrent: () => {
        authorityChecks += 1;
        return authorityChecks === 6 ? activationGate.promise : true;
      },
      onFact: ({ value }) => { facts.push(value); },
    });

    const initialization = client.initialize();
    await waitFor(() => authorityChecks === 6);
    process.terminate();
    await waitFor(() => client.state === "failed");
    activationGate.resolve(true);
    await expect(initialization).rejects.toMatchObject({ code: "PROCESS_EXITED" });
    await Bun.sleep(1);
    expect(facts).toEqual([]);
  });

  test("fails closed on an unknown response id during credential-store preflight", async () => {
    const codexHome = "/tmp/hra-control-plane/profile-a/codex-home";
    let configRequestId: unknown;
    const process = new FakeProcess((message, runtime) => {
      if (message.method === "initialize") {
        runtime.respond({
          id: message.id,
          result: {
            userAgent: "codex-cli/0.153.2",
            codexHome,
            platformFamily: "unix",
            platformOs: "macos",
          },
        });
      } else if (message.method === "config/read") {
        configRequestId = message.id;
      }
    }, { autoCredentialStorePreflight: false });
    const client = createClient({
      process,
      authority: codexAuthority(7),
      expectedCodexHome: codexHome,
      isAuthorityCurrent: () => true,
    });

    const initialization = client.initialize();
    await waitFor(() => configRequestId !== undefined);
    process.respond({ id: 999, result: {} });
    await expect(initialization).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
    expect(client.state).toBe("failed");
  });

  test("keeps a colliding preflight server-request id distinct from the config response", async () => {
    const codexHome = "/tmp/hra-control-plane/profile-a/codex-home";
    let configRequestId: number | undefined;
    const process = new FakeProcess((message, runtime) => {
      if (message.method === "initialize") {
        runtime.respond({
          id: message.id,
          result: {
            userAgent: "codex-cli/0.153.2",
            codexHome,
            platformFamily: "unix",
            platformOs: "macos",
          },
        });
      } else if (message.method === "config/read") {
        configRequestId = message.id as number;
      }
    }, { autoCredentialStorePreflight: false });
    const client = createClient({
      process,
      authority: codexAuthority(7),
      expectedCodexHome: codexHome,
      isAuthorityCurrent: () => true,
    });

    const initialization = client.initialize();
    await waitFor(() => configRequestId !== undefined);
    process.respond({
      id: configRequestId,
      method: "item/commandExecution/requestApproval",
      params: commandApprovalParams(),
    });
    await waitFor(() => process.writes.some((frame) => {
      const value = frame as { error?: unknown; id?: unknown };
      return value.id === configRequestId && value.error !== undefined;
    }));
    process.respond({
      id: configRequestId,
      result: {
        config: {
          cli_auth_credentials_store: "file",
          mcp_oauth_credentials_store: "file",
        },
        origins: {},
      },
    });

    await expect(initialization).resolves.toMatchObject({
      authority: codexAuthority(7),
    });
    expect(process.writes).toContainEqual({
      id: configRequestId,
      error: {
        code: -32_001,
        message: "Oompa has not activated this provider connection",
      },
    });
    await client.close();
  });

  test("bounds every inbound frame while credential-store proof is pending", async () => {
    const codexHome = "/tmp/hra-control-plane/profile-a/codex-home";
    let configRequestId: unknown;
    const process = new FakeProcess((message, runtime) => {
      if (message.method === "initialize") {
        runtime.respond({
          id: message.id,
          result: {
            userAgent: "codex-cli/0.153.2",
            codexHome,
            platformFamily: "unix",
            platformOs: "macos",
          },
        });
      } else if (message.method === "config/read") {
        configRequestId = message.id;
      }
    }, { autoCredentialStorePreflight: false });
    const client = createClient({
      process,
      authority: codexAuthority(7),
      expectedCodexHome: codexHome,
      isAuthorityCurrent: () => true,
    });

    const initialization = client.initialize();
    await waitFor(() => configRequestId !== undefined);
    for (let index = 0; index < 128; index += 1) {
      process.respond({
        method: "account/updated",
        params: { authMode: "chatgpt", planType: "pro" },
      });
    }
    await expect(initialization).rejects.toMatchObject({ code: "PROTOCOL_LIMIT" });
    expect(client.state).toBe("failed");
  });

  test("bounds projected notification bytes while credential-store proof is pending", async () => {
    const codexHome = "/tmp/hra-control-plane/profile-a/codex-home";
    let configRequestId: unknown;
    const process = new FakeProcess((message, runtime) => {
      if (message.method === "initialize") {
        runtime.respond({
          id: message.id,
          result: {
            userAgent: "codex-cli/0.153.2",
            codexHome,
            platformFamily: "unix",
            platformOs: "macos",
          },
        });
      } else if (message.method === "config/read") {
        configRequestId = message.id;
      }
    }, { autoCredentialStorePreflight: false });
    const client = createClient({
      process,
      authority: codexAuthority(7),
      expectedCodexHome: codexHome,
      isAuthorityCurrent: () => true,
    });

    const initialization = client.initialize();
    await waitFor(() => configRequestId !== undefined);
    const delta = "x".repeat(32_768);
    for (let index = 0; index < 33; index += 1) {
      process.respond({
        method: "item/agentMessage/delta",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: `item-${String(index)}`,
          delta,
        },
      });
    }
    await expect(initialization).rejects.toMatchObject({ code: "PROTOCOL_LIMIT" });
    expect(client.state).toBe("failed");
  });

  test("sends the exact pinned login cancellation authority", async () => {
    const codexHome = "/tmp/hra-control-plane/profile-a/codex-home";
    const factGate = deferred<undefined>();
    let factStarted = false;
    let factSettled = false;
    const process = new FakeProcess((message, runtime) => {
      if (message.method === "initialize") {
        runtime.respond({
          id: message.id,
          result: {
            userAgent: "codex-cli/0.153.2",
            codexHome,
            platformFamily: "unix",
            platformOs: "macos",
          },
        });
      } else if (message.method === "account/login/cancel") {
        expect(message.params).toEqual({ loginId: "provider-login-exact" });
        runtime.respond({
          method: "account/login/completed",
          params: { loginId: "provider-login-exact", success: false },
        });
        runtime.respond({ id: message.id, result: { status: "notFound" } });
      }
    });
    const client = createClient({
      process,
      authority: codexAuthority(7),
      expectedCodexHome: codexHome,
      isAuthorityCurrent: () => true,
      onFact: async () => {
        factStarted = true;
        await factGate.promise;
        factSettled = true;
      },
    });
    await client.initialize();
    const cancellation = client.cancelManagedLogin("provider-login-exact");
    await waitFor(() => factStarted);
    await expect(cancellation).resolves.toEqual({
      authority: codexAuthority(7),
      value: { status: "notFound" },
    });
    expect(factSettled).toBe(false);
    expect(process.writes).toContainEqual({
      id: 3,
      method: "account/login/cancel",
      params: { loginId: "provider-login-exact" },
    });
    factGate.resolve(undefined);
    await waitFor(() => factSettled);
    await client.close();
  });

  test("initializes once and fences returned identity", async () => {
    const process = successfulFake("/tmp/hra-control-plane/profile-a/codex-home");
    const facts: FencedCodexValue<CodexFact>[] = [];
    const client = createClient({
      process,
      authority: codexAuthority(7),
      expectedCodexHome: "/tmp/hra-control-plane/profile-a/codex-home",
      isAuthorityCurrent: () => true,
      connectionId: CONNECTION_ID,
      onFact: (fact) => {
        facts.push(fact);
      },
    });
    await client.initialize();
    expect(process.writes[0]).toEqual({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "oompa", title: "Oompa", version: OOMPA_VERSION },
        capabilities: {
          experimentalApi: false,
          extensions: { "openai/standard-form-input": {} },
        },
      },
    });
    expect(JSON.stringify(process.writes[0])).not.toContain("openai/form");
    const result = await client.accountRead();
    expect(result.authority).toEqual(codexAuthority(7));
    expect(result.value.account).toEqual({
      type: "chatgpt",
      email: "person@example.com",
      planType: "pro",
    });
    expect((process.writes[1] as Record<string, unknown>).method).toBe("initialized");
    await Bun.sleep(1);
    expect(facts).toEqual([{
      authority: codexAuthority(7),
      value: { type: "providerConnected", connectionId: CONNECTION_ID },
    }]);
    await client.close();
  });

  test("rejects a CODEX_HOME mismatch before becoming ready", async () => {
    const process = successfulFake("/tmp/wrong-home");
    const client = createClient({
      process,
      authority: codexAuthority(1),
      expectedCodexHome: "/tmp/expected-home",
      isAuthorityCurrent: () => true,
    });
    const error = await client.initialize().catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "HOME_MISMATCH" });
  });

  test("accepts the pinned desktop user agent and rejects protocol version drift", async () => {
    const codexHome = "/tmp/hra-control-plane/profile-a/codex-home";
    const pinned = createClient({
      process: successfulFake(codexHome, "Codex Desktop/0.153.2 (Mac OS 26.5; arm64) dumb (oompa; 0.6.1)"),
      authority: codexAuthority(1),
      expectedCodexHome: codexHome,
      isAuthorityCurrent: () => true,
    });
    await expect(pinned.initialize()).resolves.toMatchObject({ value: { platformOs: "macos" } });
    await pinned.close();

    const drifted = createClient({
      process: successfulFake(codexHome, "Codex Desktop/0.149.1 (Mac OS 26.5; arm64)"),
      authority: codexAuthority(1),
      expectedCodexHome: codexHome,
      isAuthorityCurrent: () => true,
    });
    await expect(drifted.initialize()).rejects.toMatchObject({ code: "RUNTIME_MISMATCH" });
  });

  test("treats private stdio EOF as a dead connection rather than a reconnect", async () => {
    const codexHome = "/tmp/hra-control-plane/profile-a/codex-home";
    const process = successfulFake(codexHome);
    const facts: CodexFact[] = [];
    const client = createClient({
      process,
      authority: codexAuthority(1),
      expectedCodexHome: codexHome,
      isAuthorityCurrent: () => true,
      connectionId: CONNECTION_ID,
      onFact: ({ value }) => { facts.push(value); },
    });
    await client.initialize();
    process.stdoutQueue.close();
    await waitFor(() => client.state === "failed");
    await waitFor(() => facts.some((fact) => fact.type === "providerDisconnected"));
    expect(facts.filter((fact) => fact.type === "providerDisconnected")).toEqual([{
      type: "providerDisconnected",
      connectionId: CONNECTION_ID,
      reason: "eof",
    }]);
    await client.close();
  });

  test("refuses dispatch after the generation becomes stale", async () => {
    let current = true;
    const process = successfulFake("/tmp/hra-control-plane/profile-a/codex-home");
    const client = createClient({
      process,
      authority: codexAuthority(2),
      expectedCodexHome: "/tmp/hra-control-plane/profile-a/codex-home",
      isAuthorityCurrent: () => current,
    });
    await client.initialize();
    current = false;
    const error = await client.accountRead().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CodexError);
    expect(process.writes).toHaveLength(3);
    await client.close();
  });

  test("rejects unsupported legacy prompts instead of treating them as interactions", async () => {
    const process = successfulFake("/tmp/hra-control-plane/profile-a/codex-home");
    const client = createClient({
      process,
      authority: codexAuthority(1),
      expectedCodexHome: "/tmp/hra-control-plane/profile-a/codex-home",
      isAuthorityCurrent: () => true,
    });
    await client.initialize();
    process.respond({ id: 900, method: "execCommandApproval", params: {} });
    await Bun.sleep(1);
    expect(process.writes.at(-1)).toEqual({
      id: 900,
      error: {
        code: -32_601,
        message: "Oompa does not support this server request",
      },
    });
    await client.close();
  });

  test("requires paired conversation automation callbacks", () => {
    const codexHome = "/tmp/hra-control-plane/profile-a/codex-home";
    const base = {
      authority: codexAuthority(1),
      expectedCodexHome: codexHome,
      isAuthorityCurrent: () => true,
    } as const;
    expect(() => createClient({
      ...base,
      process: successfulFake(codexHome),
      onConversationAutomationToolCall: async () => ({ scope: "conversation" }),
    })).toThrow("conversation automation requires paired call and response-written callbacks");
    expect(() => createClient({
      ...base,
      process: successfulFake(codexHome),
      onConversationAutomationToolResponseWritten: () => undefined,
    })).toThrow("conversation automation requires paired call and response-written callbacks");
    expect(() => createClient({
      ...base,
      process: successfulFake(codexHome),
      onOompaHostToolCall: async () => ({ scope: "session" }),
    })).toThrow("Oompa host tools require paired call and response-written callbacks");
    expect(() => createClient({
      ...base,
      process: successfulFake(codexHome),
      onOompaHostToolResponseWritten: () => undefined,
    })).toThrow("Oompa host tools require paired call and response-written callbacks");
  });

  test("routes the exact conversation automation tool and wakes only after the response write", async () => {
    const process = successfulFake("/tmp/hra-control-plane/profile-a/codex-home");
    const calls: Parameters<NonNullable<
      CodexAppServerClientOptions["onConversationAutomationToolCall"]
    >>[0][] = [];
    const postWriteFrames: unknown[] = [];
    const client = createClient({
      process,
      authority: codexAuthority(7),
      expectedCodexHome: "/tmp/hra-control-plane/profile-a/codex-home",
      experimentalApi: true,
      isAuthorityCurrent: () => true,
      connectionId: CONNECTION_ID,
      onConversationAutomationToolCall: async (call) => {
        calls.push(call);
        return { task: { id: "task-1" }, scope: "conversation" };
      },
      onConversationAutomationToolResponseWritten: () => {
        postWriteFrames.push(process.writes.at(-1));
      },
    });
    await client.initialize();
    const responseWrite = deferred<undefined>();
    process.writeSettlementGate = responseWrite.promise;
    const params = conversationAutomationParams();
    process.respond({ id: "tool-request", method: "item/tool/call", params });
    await waitFor(() => calls.length === 1);
    await waitFor(() => process.writes.some((frame) =>
      (frame as { id?: unknown }).id === "tool-request"));
    expect(postWriteFrames).toEqual([]);
    responseWrite.resolve(undefined);
    await waitFor(() => postWriteFrames.length === 1);
    expect(calls[0]).toMatchObject({
      authority: codexAuthority(7),
      connectionId: CONNECTION_ID,
      requestId: { type: "string", value: "tool-request" },
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-1",
      operation: {
        mode: "create",
        name: "Daily review",
        schedule: { kind: "interval_minutes", minutes: 60 },
      },
    });
    expect(calls[0]?.requestDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(process.writes.at(-1)).toEqual({
      id: "tool-request",
      result: {
        contentItems: [{
          type: "inputText",
          text: "{\"scope\":\"conversation\",\"task\":{\"id\":\"task-1\"}}",
        }],
        success: true,
      },
    });

    process.respond({ id: "tool-request", method: "item/tool/call", params });
    await waitFor(() => calls.length === 2);
    await waitFor(() => postWriteFrames.length === 2);
    expect(calls[1]?.requestDigest).toBe(calls[0]?.requestDigest);
    expect(process.writes.filter((frame) =>
      (frame as { id?: unknown }).id === "tool-request")).toHaveLength(2);
    await client.close();
  });

  test("routes every admitted dynamic tool through the generic Oompa callback", async () => {
    const process = successfulFake("/tmp/hra-control-plane/profile-a/codex-home");
    const calls: unknown[] = [];
    const written: unknown[] = [];
    const client = createClient({
      process,
      authority: codexAuthority(7),
      expectedCodexHome: "/tmp/hra-control-plane/profile-a/codex-home",
      experimentalApi: true,
      isAuthorityCurrent: () => true,
      connectionId: CONNECTION_ID,
      onOompaHostToolCall: async (call) => {
        calls.push(call);
        return { accepted: true, tool: call.tool };
      },
      onOompaHostToolResponseWritten: (call) => {
        written.push(call);
      },
    });
    await client.initialize();
    process.respond({
      id: "peer-tool",
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-2",
        namespace: "hra",
        tool: "session_message",
        arguments: {
          sessionId: `sess_${"a".repeat(32)}`,
          expectedRevision: 2,
          delivery: "queue",
          message: "Please verify the plan.",
          reason: "Independent review",
        },
      },
    });
    await waitFor(() => written.length === 1);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      tool: "session_message",
      input: {
        expectedRevision: 2,
        delivery: "queue",
        message: "Please verify the plan.",
      },
      threadId: "thread-1",
      turnId: "turn-1",
    });
    expect(process.writes.at(-1)).toEqual({
      id: "peer-tool",
      result: {
        contentItems: [{
          type: "inputText",
          text: "{\"accepted\":true,\"tool\":\"session_message\"}",
        }],
        success: true,
      },
    });
    await client.close();
  });

  test("fences exact live host calls before queued terminal facts and preserves unrelated threads", async () => {
    const process = successfulFake("/tmp/hra-control-plane/profile-a/codex-home");
    const handlerGate = deferred<undefined>();
    const completionGate = deferred<undefined>();
    const calls: OompaHostToolCall[] = [];
    const liveAtAdmission: boolean[] = [];
    const written: OompaHostToolCall[] = [];
    let completionObserverEntered = false;
    let markerObserved = false;
    const client = createClient({
      process,
      authority: codexAuthority(7),
      expectedCodexHome: "/tmp/hra-control-plane/profile-a/codex-home",
      experimentalApi: true,
      isAuthorityCurrent: () => true,
      connectionId: CONNECTION_ID,
      onOompaHostToolCall: async (call) => {
        calls.push(call);
        liveAtAdmission.push(client.hasLiveOompaHostToolCall(call));
        await handlerGate.promise;
        return { accepted: true };
      },
      onOompaHostToolResponseWritten: (call) => { written.push(call); },
      onFact: async ({ value }) => {
        if (value.type === "turnCompleted" && value.threadId === "thread-1") {
          completionObserverEntered = true;
          await completionGate.promise;
        }
        if (value.type === "threadNameUpdated" && value.name === "receive-fence-marker") {
          markerObserved = true;
        }
      },
    });
    await client.initialize();
    const rawTurn = (id: string, status: "completed" | "inProgress") => ({
      completedAt: status === "completed" ? 2 : null,
      durationMs: status === "completed" ? 1 : null,
      id,
      items: [],
      startedAt: 1,
      status,
    });
    process.respond({
      method: "turn/started",
      params: { threadId: "thread-1", turn: rawTurn("turn-1", "inProgress") },
    });
    process.respond({
      method: "turn/started",
      params: { threadId: "thread-2", turn: rawTurn("turn-2", "inProgress") },
    });
    process.respond({
      id: "tool-thread-1",
      method: "item/tool/call",
      params: conversationAutomationParams(),
    });
    process.respond({
      id: "tool-thread-2",
      method: "item/tool/call",
      params: {
        ...conversationAutomationParams(),
        callId: "call-2",
        threadId: "thread-2",
        turnId: "turn-2",
      },
    });
    await waitFor(() => calls.length === 2);
    const first = calls[0];
    const second = calls[1];
    if (first === undefined || second === undefined) throw new Error("Missing host-tool calls.");
    expect(liveAtAdmission).toEqual([true, true]);
    expect(client.hasLiveOompaHostToolCall(first)).toBe(true);
    expect(client.hasLiveOompaHostToolCall(second)).toBe(true);
    for (const changedAuthority of [
      { ...first.authority, bindingGeneration: first.authority.bindingGeneration + 1 },
      { ...first.authority, providerAccountId: `acct_${"f".repeat(32)}` },
      { ...first.authority, provider: "claude" as const },
    ]) {
      expect(client.hasLiveOompaHostToolCall({ ...first, authority: changedAuthority })).toBe(false);
    }
    expect(client.hasLiveOompaHostToolCall({
      ...first,
      requestDigest: "f".repeat(64),
    })).toBe(false);

    process.respond({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: rawTurn("turn-1", "completed") },
    });
    await waitFor(() => completionObserverEntered);
    expect(client.hasLiveOompaHostToolCall(first)).toBe(false);
    expect(client.hasLiveOompaHostToolCall(second)).toBe(true);
    completionGate.resolve(undefined);

    process.respond({
      id: "tool-after-completion",
      method: "item/tool/call",
      params: { ...conversationAutomationParams(), callId: "call-after-completion" },
    });
    process.respond({
      method: "thread/name/updated",
      params: { threadId: "thread-2", name: "receive-fence-marker" },
    });
    await waitFor(() => markerObserved);
    expect(calls).toHaveLength(2);

    handlerGate.resolve(undefined);
    await waitFor(() => written.length === 1);
    expect(written).toEqual([second]);
    expect(process.writes.some((frame) =>
      (frame as { id?: unknown }).id === "tool-thread-1")).toBe(false);
    expect(process.writes.some((frame) =>
      (frame as { id?: unknown }).id === "tool-after-completion")).toBe(false);
    expect(process.writes.some((frame) =>
      (frame as { id?: unknown }).id === "tool-thread-2")).toBe(true);
    await client.close();
  });

  test("does not let an invalidated callback consume a same-identity replacement", async () => {
    const process = successfulFake("/tmp/hra-control-plane/profile-a/codex-home");
    const oldHandlerGate = deferred<undefined>();
    const replacementHandlerGate = deferred<undefined>();
    const calls: OompaHostToolCall[] = [];
    const client = createClient({
      process,
      authority: codexAuthority(7),
      expectedCodexHome: "/tmp/hra-control-plane/profile-a/codex-home",
      experimentalApi: true,
      isAuthorityCurrent: () => true,
      connectionId: CONNECTION_ID,
      onOompaHostToolCall: async (call) => {
        calls.push(call);
        if (call.requestId.type !== "string") throw new Error("Expected a string request id.");
        await (call.requestId.value === "old-request"
          ? oldHandlerGate.promise
          : replacementHandlerGate.promise);
        return { accepted: true };
      },
      onOompaHostToolResponseWritten: () => undefined,
    });
    await client.initialize();
    const params = conversationAutomationParams();
    process.respond({ id: "old-request", method: "item/tool/call", params });
    await waitFor(() => calls.length === 1);
    process.respond({
      method: "serverRequest/resolved",
      params: { requestId: "old-request", threadId: "thread-1" },
    });
    process.respond({ id: "replacement-request", method: "item/tool/call", params });
    await waitFor(() => calls.length === 2);
    const replacement = calls[1];
    if (replacement === undefined) throw new Error("Missing replacement host-tool call.");
    expect(replacement.requestId).toEqual({ type: "string", value: "replacement-request" });
    expect(client.hasLiveOompaHostToolCall(replacement)).toBe(true);

    oldHandlerGate.resolve(undefined);
    for (let index = 0; index < 4; index += 1) await Promise.resolve();
    expect(client.hasLiveOompaHostToolCall(replacement)).toBe(true);
    expect(process.writes.some((frame) =>
      (frame as { id?: unknown }).id === "old-request")).toBe(false);

    replacementHandlerGate.resolve(undefined);
    await waitFor(() => process.writes.some((frame) =>
      (frame as { id?: unknown }).id === "replacement-request"));
    await client.close();
    expect(calls).toHaveLength(2);
    expect(process.writes.some((frame) =>
      (frame as { id?: unknown }).id === "old-request")).toBe(false);
  });

  test("does not report a response written when an account barrier refuses its frame", async () => {
    const process = successfulFake("/tmp/hra-control-plane/profile-a/codex-home");
    const handlerGate = deferred<undefined>();
    let accountAuthoritySignaled = false;
    let call: OompaHostToolCall | undefined;
    let postWriteCalls = 0;
    const client = createClient({
      process,
      authority: codexAuthority(7),
      expectedCodexHome: "/tmp/hra-control-plane/profile-a/codex-home",
      experimentalApi: true,
      isAuthorityCurrent: () => true,
      connectionId: CONNECTION_ID,
      onAccountAuthoritySignal: () => {
        accountAuthoritySignaled = true;
        return Promise.reject(new Error("injected account refresh rejection"));
      },
      onOompaHostToolCall: async (input) => {
        call = input;
        await handlerGate.promise;
        return { accepted: true };
      },
      onOompaHostToolResponseWritten: () => { postWriteCalls += 1; },
    });
    await client.initialize();
    process.respond({
      id: "barrier-refused-response",
      method: "item/tool/call",
      params: conversationAutomationParams(),
    });
    await waitFor(() => call !== undefined);
    if (call === undefined) throw new Error("Missing Oompa host-tool call.");
    const retainedCall = call;
    expect(client.hasLiveOompaHostToolCall(retainedCall)).toBe(true);

    process.respond({
      method: "account/updated",
      params: { authMode: "chatgpt", planType: "pro" },
    });
    await waitFor(() => accountAuthoritySignaled);
    handlerGate.resolve(undefined);
    await waitFor(() => !client.hasLiveOompaHostToolCall(retainedCall));

    expect(client.state).toBe("ready");
    expect(postWriteCalls).toBe(0);
    expect(process.writes.some((frame) =>
      (frame as { id?: unknown }).id === "barrier-refused-response")).toBe(false);
    await client.close();
  });

  test("quarantines changed and cross-service reuse of a dynamic-tool request id", async () => {
    for (const collision of ["changed_tool", "brokered_request"] as const) {
      const process = successfulFake("/tmp/hra-control-plane/profile-a/codex-home");
      let calls = 0;
      const client = createClient({
        process,
        authority: codexAuthority(1),
        expectedCodexHome: "/tmp/hra-control-plane/profile-a/codex-home",
        experimentalApi: true,
        isAuthorityCurrent: () => true,
        onConversationAutomationToolCall: async () => {
          calls += 1;
          return { scope: "conversation" };
        },
        onConversationAutomationToolResponseWritten: () => undefined,
      });
      await client.initialize();
      process.respond({
        id: "collision",
        method: "item/tool/call",
        params: conversationAutomationParams(),
      });
      await waitFor(() => process.writes.some((frame) =>
        (frame as { id?: unknown }).id === "collision"));
      if (collision === "changed_tool") {
        process.respond({
          id: "collision",
          method: "item/tool/call",
          params: { ...conversationAutomationParams(), callId: "call-2" },
        });
      } else {
        process.respond({
          id: "collision",
          method: "item/commandExecution/requestApproval",
          params: commandApprovalParams(),
        });
      }
      await waitFor(() => client.state === "failed");
      expect(calls).toBe(1);
      expect(process.signals).toContain("SIGTERM");
      await client.close();
    }
  });

  test("keeps reading ordinary responses while a dynamic-tool handler is pending", async () => {
    const codexHome = "/tmp/hra-control-plane/profile-a/codex-home";
    let accountRequestId: number | undefined;
    const process = new FakeProcess((message, target) => {
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
      } else if (message.method === "account/read") {
        accountRequestId = message.id as number;
      }
    });
    const handlerGate = deferred<undefined>();
    let handlerStarted = false;
    const client = createClient({
      process,
      authority: codexAuthority(1),
      expectedCodexHome: codexHome,
      experimentalApi: true,
      isAuthorityCurrent: () => true,
      onConversationAutomationToolCall: async () => {
        handlerStarted = true;
        await handlerGate.promise;
        return { scope: "conversation" };
      },
      onConversationAutomationToolResponseWritten: () => undefined,
    });
    await client.initialize();

    const accountRead = client.accountRead();
    await waitFor(() => accountRequestId !== undefined);
    process.respond({
      id: "tool-pending",
      method: "item/tool/call",
      params: conversationAutomationParams(),
    });
    await waitFor(() => handlerStarted);
    process.respond({
      id: accountRequestId,
      result: {
        account: { type: "chatgpt", email: "person@example.com", planType: "pro" },
        requiresOpenaiAuth: true,
      },
    });
    const account = await accountRead;
    handlerGate.resolve(undefined);
    await waitFor(() => process.writes.some((frame) =>
      (frame as { id?: unknown }).id === "tool-pending"));
    expect(account).toMatchObject({
      value: { account: { type: "chatgpt", planType: "pro" } },
    });
    await client.close();
  });

  test("quarantines a dynamic-tool call without responding or waking after authority changes", async () => {
    const process = successfulFake("/tmp/hra-control-plane/profile-a/codex-home");
    const handlerGate = deferred<undefined>();
    let current = true;
    let handlerStarted = false;
    let postWriteCalls = 0;
    const client = createClient({
      process,
      authority: codexAuthority(1),
      expectedCodexHome: "/tmp/hra-control-plane/profile-a/codex-home",
      experimentalApi: true,
      isAuthorityCurrent: () => current,
      onConversationAutomationToolCall: async () => {
        handlerStarted = true;
        await handlerGate.promise;
        return { scope: "conversation" };
      },
      onConversationAutomationToolResponseWritten: () => {
        postWriteCalls += 1;
      },
    });
    await client.initialize();
    process.respond({
      id: "tool-stale",
      method: "item/tool/call",
      params: conversationAutomationParams(),
    });
    await waitFor(() => handlerStarted);
    current = false;
    handlerGate.resolve(undefined);
    await waitFor(() => client.state === "failed");
    expect(process.writes.some((frame) =>
      (frame as { id?: unknown }).id === "tool-stale")).toBe(false);
    expect(postWriteCalls).toBe(0);
    expect(process.signals).toContain("SIGTERM");
    await client.close();
  });

  test("rechecks authority inside a queued dynamic-tool response write", async () => {
    const process = successfulFake("/tmp/hra-control-plane/profile-a/codex-home");
    let current = true;
    let handlerCalls = 0;
    let postWriteCalls = 0;
    const client = createClient({
      process,
      authority: codexAuthority(1),
      expectedCodexHome: "/tmp/hra-control-plane/profile-a/codex-home",
      experimentalApi: true,
      isAuthorityCurrent: () => current,
      onConversationAutomationToolCall: async () => {
        handlerCalls += 1;
        return { scope: "conversation" };
      },
      onConversationAutomationToolResponseWritten: () => {
        postWriteCalls += 1;
      },
    });
    await client.initialize();
    const queuedWrite = deferred<undefined>();
    process.writeSettlementGate = queuedWrite.promise;
    const blockingRead = client.accountRead();
    await waitFor(() => process.writes.some((frame) =>
      (frame as { method?: unknown }).method === "account/read"));
    process.respond({
      id: "tool-queued",
      method: "item/tool/call",
      params: conversationAutomationParams(),
    });
    await waitFor(() => handlerCalls === 1);
    current = false;
    queuedWrite.resolve(undefined);
    await blockingRead;
    await waitFor(() => client.state === "failed");
    expect(process.writes.some((frame) =>
      (frame as { id?: unknown }).id === "tool-queued")).toBe(false);
    expect(postWriteCalls).toBe(0);
    await client.close();
  });

  test("lets an account refresh leapfrog a dynamic response paused in its async pre-write check", async () => {
    const codexHome = "/tmp/hra-control-plane/profile-a/codex-home";
    const preWriteGate = deferred<boolean>();
    const accountBarrier = deferred<undefined>();
    let markPreWriteStarted!: () => void;
    const preWriteStarted = new Promise<void>((resolve) => { markPreWriteStarted = resolve; });
    let authorityPhase = 0;
    let providerConnected = false;
    let accountSignaled = false;
    let postWriteCalls = 0;
    const process = successfulFake(codexHome);
    const client = createClient({
      process,
      authority: codexAuthority(1),
      expectedCodexHome: codexHome,
      experimentalApi: true,
      isAuthorityCurrent: () => {
        if (authorityPhase === 1) {
          authorityPhase = 2;
          return true;
        }
        if (authorityPhase === 2) {
          authorityPhase = 3;
          markPreWriteStarted();
          return preWriteGate.promise;
        }
        return true;
      },
      connectionId: CONNECTION_ID,
      onAccountAuthoritySignal: () => {
        accountSignaled = true;
        return accountBarrier.promise;
      },
      onConversationAutomationToolCall: () => {
        authorityPhase = 1;
        return { scope: "conversation" };
      },
      onConversationAutomationToolResponseWritten: () => { postWriteCalls += 1; },
      onFact: ({ value }) => {
        if (value.type === "providerConnected") providerConnected = true;
      },
    });
    await client.initialize();
    await waitFor(() => providerConnected);
    process.respond({
      id: "tool-account-race",
      method: "item/tool/call",
      params: conversationAutomationParams(),
    });
    await preWriteStarted;

    process.respond({
      method: "account/updated",
      params: { authMode: "chatgpt", planType: "pro" },
    });
    await waitFor(() => accountSignaled);
    const refresh = client.refreshAccountAuthority();
    preWriteGate.resolve(true);
    await refresh;
    expect(process.writes.some((frame) =>
      (frame as Record<string, unknown>).id === "tool-account-race")).toBe(false);

    accountBarrier.resolve(undefined);
    await waitFor(() => process.writes.some((frame) =>
      (frame as Record<string, unknown>).id === "tool-account-race"));
    expect(postWriteCalls).toBe(1);
    await client.close();
  });

  test("rejects dynamic-tool calls when the experimental API was not negotiated", async () => {
    const process = successfulFake("/tmp/hra-control-plane/profile-a/codex-home");
    let calls = 0;
    const client = createClient({
      process,
      authority: codexAuthority(1),
      expectedCodexHome: "/tmp/hra-control-plane/profile-a/codex-home",
      experimentalApi: false,
      isAuthorityCurrent: () => true,
      onConversationAutomationToolCall: async () => {
        calls += 1;
        return { scope: "conversation" };
      },
      onConversationAutomationToolResponseWritten: () => undefined,
    });
    await client.initialize();
    process.respond({
      id: "tool-disabled",
      method: "item/tool/call",
      params: conversationAutomationParams(),
    });
    await waitFor(() => process.writes.some((frame) =>
      (frame as { id?: unknown }).id === "tool-disabled"));
    expect(process.writes.at(-1)).toEqual({
      id: "tool-disabled",
      error: { code: -32_601, message: "Oompa did not advertise this host service" },
    });
    expect(calls).toBe(0);
    await client.close();
  });

  test("bounds close while a dynamic-tool handler remains pending", async () => {
    const process = successfulFake("/tmp/hra-control-plane/profile-a/codex-home");
    const handlerGate = deferred<undefined>();
    const diagnostics: string[] = [];
    let handlerStarted = false;
    let postWriteCalls = 0;
    const client = createClient({
      process,
      authority: codexAuthority(1),
      expectedCodexHome: "/tmp/hra-control-plane/profile-a/codex-home",
      experimentalApi: true,
      isAuthorityCurrent: () => true,
      onConversationAutomationToolCall: async () => {
        handlerStarted = true;
        await handlerGate.promise;
        return { scope: "conversation" };
      },
      onConversationAutomationToolResponseWritten: () => {
        postWriteCalls += 1;
      },
      onSafeDiagnostic: (message) => { diagnostics.push(message); },
      shutdownSettlementMs: 5,
    });
    await client.initialize();
    process.respond({
      id: "tool-close",
      method: "item/tool/call",
      params: conversationAutomationParams(),
    });
    await waitFor(() => handlerStarted);
    await client.close();
    expect(client.state).toBe("closed");
    expect(diagnostics).toContain(
      "Oompa dynamic-tool handling did not settle after Codex termination",
    );
    handlerGate.resolve(undefined);
    await Bun.sleep(1);
    expect(process.writes.some((frame) =>
      (frame as { id?: unknown }).id === "tool-close")).toBe(false);
    expect(postWriteCalls).toBe(0);
  });

  test("rejects unadvertised tools and standalone-field smuggling before the host callback", async () => {
    const process = successfulFake("/tmp/hra-control-plane/profile-a/codex-home");
    const diagnostics: string[] = [];
    let calls = 0;
    const client = createClient({
      process,
      authority: codexAuthority(1),
      expectedCodexHome: "/tmp/hra-control-plane/profile-a/codex-home",
      experimentalApi: true,
      isAuthorityCurrent: () => true,
      onSafeDiagnostic: (message) => { diagnostics.push(message); },
      onConversationAutomationToolCall: async () => {
        calls += 1;
        return "unexpected";
      },
      onConversationAutomationToolResponseWritten: () => undefined,
    });
    await client.initialize();
    const cases = [
      { ...conversationAutomationParams(), namespace: "other" },
      { ...conversationAutomationParams(), tool: "automation_create" },
      { ...conversationAutomationParams(), targetThreadId: "PRIVATE_TARGET_SENTINEL" },
      conversationAutomationParams({
        mode: "create",
        name: "Review",
        prompt: "Continue",
        schedule: { kind: "interval_minutes", minutes: 60 },
        destination: "standalone",
      }),
      conversationAutomationParams({
        mode: "create",
        name: "Review",
        prompt: "Continue",
        schedule: { kind: "interval_minutes", minutes: 60, cron: "PRIVATE_CRON_SENTINEL" },
      }),
    ];
    for (const [index, params] of cases.entries()) {
      process.respond({ id: 940 + index, method: "item/tool/call", params });
      await waitFor(() => process.writes.some((frame) =>
        (frame as { id?: unknown }).id === 940 + index));
      expect(process.writes.at(-1)).toMatchObject({
        id: 940 + index,
        error: { code: index < 2 ? -32_601 : -32_602 },
      });
    }
    process.respond({ id: 949, method: "currentTime/read", params: {} });
    await waitFor(() => process.writes.some((frame) =>
      (frame as { id?: unknown }).id === 949));
    expect(process.writes.at(-1)).toEqual({
      id: 949,
      error: { code: -32_601, message: "Oompa did not advertise this host service" },
    });
    expect(calls).toBe(0);
    expect(JSON.stringify({ writes: process.writes, diagnostics })).not.toContain("PRIVATE_");
    await client.close();
  });

  test("bounds dynamic-tool output and does not expose host failures", async () => {
    const process = successfulFake("/tmp/hra-control-plane/profile-a/codex-home");
    const diagnostics: string[] = [];
    let calls = 0;
    let postWriteCalls = 0;
    const client = createClient({
      process,
      authority: codexAuthority(1),
      expectedCodexHome: "/tmp/hra-control-plane/profile-a/codex-home",
      experimentalApi: true,
      isAuthorityCurrent: () => true,
      onSafeDiagnostic: (message) => { diagnostics.push(message); },
      onConversationAutomationToolCall: async () => {
        calls += 1;
        if (calls === 1) throw new Error("PRIVATE_HOST_FAILURE_SENTINEL");
        return "é".repeat(32_769);
      },
      onConversationAutomationToolResponseWritten: () => {
        postWriteCalls += 1;
      },
    });
    await client.initialize();
    for (const id of [950, 951]) {
      process.respond({ id, method: "item/tool/call", params: conversationAutomationParams() });
      await waitFor(() => process.writes.some((frame) =>
        (frame as { id?: unknown }).id === id));
      expect(process.writes.at(-1)).toEqual({
        id,
        result: {
          contentItems: [{
            type: "inputText",
            text: "Oompa could not complete this conversation-bound scheduled task request.",
          }],
          success: false,
        },
      });
    }
    expect(JSON.stringify({ writes: process.writes, diagnostics })).not.toContain(
      "PRIVATE_HOST_FAILURE_SENTINEL",
    );
    expect(postWriteCalls).toBe(0);
    await client.close();
  });

  test("does not wake after an indeterminate dynamic-tool response write", async () => {
    const process = successfulFake("/tmp/hra-control-plane/profile-a/codex-home");
    let handlerCalls = 0;
    let postWriteCalls = 0;
    const client = createClient({
      process,
      authority: codexAuthority(1),
      expectedCodexHome: "/tmp/hra-control-plane/profile-a/codex-home",
      experimentalApi: true,
      isAuthorityCurrent: () => true,
      onConversationAutomationToolCall: async () => {
        handlerCalls += 1;
        return { scope: "conversation" };
      },
      onConversationAutomationToolResponseWritten: () => {
        postWriteCalls += 1;
      },
    });
    await client.initialize();
    process.writeError = new Error("deterministic tool response write failure");
    process.respond({
      id: 952,
      method: "item/tool/call",
      params: conversationAutomationParams(),
    });
    await waitFor(() => handlerCalls === 1);
    await waitFor(() => client.state === "failed");
    expect(postWriteCalls).toBe(0);
    await client.close();
  });

  test("admits file approvals for rejection responses without creating a blind acceptance path", async () => {
    const process = successfulFake("/tmp/hra-control-plane/profile-a/codex-home");
    const facts: CodexFact[] = [];
    const diagnostics: string[] = [];
    const client = createClient({
      process,
      authority: codexAuthority(1),
      expectedCodexHome: "/tmp/hra-control-plane/profile-a/codex-home",
      isAuthorityCurrent: () => true,
      connectionId: CONNECTION_ID,
      onFact: ({ value }) => { facts.push(value); },
      onSafeDiagnostic: (message) => { diagnostics.push(message); },
    });
    await client.initialize();
    process.respond({
      id: 902,
      method: "item/fileChange/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-file",
        reason: "Apply the proposed patch",
        grantRoot: "/workspace",
      },
    });
    await waitFor(() => facts.some((fact) => fact.type === "interactionRequested"));
    const requested = facts.find((fact) => fact.type === "interactionRequested");
    if (requested?.type !== "interactionRequested") throw new Error("file approval was not admitted");
    expect(requested).toMatchObject({
      kind: "file_change_approval",
      provider: {
        connectionId: CONNECTION_ID,
        requestId: { type: "number", value: 902 },
        method: "item/fileChange/requestApproval",
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-file",
      },
      display: {
        kind: "file_change_approval",
        availableDecisions: ["decline", "cancel"],
      },
    });
    expect(facts.some((fact) => fact.type === "protocolNotice")).toBe(false);
    expect(diagnostics).toEqual([]);

    const writesBeforeResolution = process.writes.length;
    for (const decision of ["once", "session"] as const) {
      await expect(client.resolveInteraction({
        provider: requested.provider,
        kind: requested.kind,
        deadlineAt: requested.deadlineAt ?? Number.NaN,
        resolution: { kind: "approval_decision", decision },
      })).rejects.toMatchObject({ code: "INVALID_INPUT" });
      expect(process.writes).toHaveLength(writesBeforeResolution);
    }
    await expect(client.validateInteractionResolution({
      provider: requested.provider,
      kind: requested.kind,
      resolution: { kind: "approval_decision", decision: "decline" },
    })).resolves.toEqual({
      responseDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(process.writes).toHaveLength(writesBeforeResolution);
    await expect(client.resolveInteraction({
      provider: requested.provider,
      kind: requested.kind,
      deadlineAt: requested.deadlineAt ?? Number.NaN,
      resolution: { kind: "approval_decision", decision: "decline" },
    })).resolves.toEqual({ responseWritten: true });
    expect(process.writes.at(-1)).toEqual({ id: 902, result: { decision: "decline" } });
    await client.close();
  });

  test("classifies MCP URL elicitation as unsupported without admitting or echoing its URL", async () => {
    const process = successfulFake("/tmp/hra-control-plane/profile-a/codex-home");
    const facts: CodexFact[] = [];
    const diagnostics: string[] = [];
    const client = createClient({
      process,
      authority: codexAuthority(1),
      expectedCodexHome: "/tmp/hra-control-plane/profile-a/codex-home",
      isAuthorityCurrent: () => true,
      connectionId: CONNECTION_ID,
      onFact: ({ value }) => { facts.push(value); },
      onSafeDiagnostic: (message) => { diagnostics.push(message); },
    });
    await client.initialize();
    const sentinel = "MCP_CLIENT_URL_SECRET_SENTINEL";
    process.respond({
      id: 901,
      method: "mcpServer/elicitation/request",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        serverName: "example",
        mode: "url",
        _meta: null,
        message: "Authorize Example",
        url: `https://example.com/oauth?access_token=${sentinel}#${sentinel}`,
        elicitationId: "elicit-url",
      },
    });
    await waitFor(() => facts.some((fact) => fact.type === "protocolNotice"));
    expect(process.writes.at(-1)).toEqual({
      id: 901,
      error: {
        code: -32_601,
        message: "Oompa cannot broker this server request capability",
        data: { code: "UNSUPPORTED_CAPABILITY" },
      },
    });
    expect(facts.some((fact) => fact.type === "interactionRequested")).toBe(false);
    expect(diagnostics).toEqual([
      "Codex requested an unsupported capability for mcpServer/elicitation/request",
    ]);
    expect(JSON.stringify({ writes: process.writes, facts, diagnostics })).not.toContain(sentinel);
    await client.close();
  });

  test("fails closed on opaque and unsupported MCP forms without admitting or echoing their schemas", async () => {
    const process = successfulFake("/tmp/hra-control-plane/profile-a/codex-home");
    const facts: CodexFact[] = [];
    const diagnostics: string[] = [];
    const client = createClient({
      process,
      authority: codexAuthority(1),
      expectedCodexHome: "/tmp/hra-control-plane/profile-a/codex-home",
      isAuthorityCurrent: () => true,
      connectionId: CONNECTION_ID,
      onFact: ({ value }) => { facts.push(value); },
      onSafeDiagnostic: (message) => { diagnostics.push(message); },
    });
    await client.initialize();
    const sentinel = "MCP_CLIENT_SCHEMA_SECRET_SENTINEL";
    const requests = [
      {
        mode: "openai/form",
        requestedSchema: {
          type: "object",
          properties: { picker: { type: "openai/imagePicker", title: sentinel } },
        },
      },
      {
        mode: "form",
        requestedSchema: {
          type: "object",
          properties: { token: { type: "string", pattern: sentinel } },
        },
      },
      {
        mode: "form",
        _meta: {
          codex_approval_kind: "tool_suggestion",
          persist: "always",
          tool_type: "plugin",
          suggest_type: "install",
          install_url: `https://example.com/install?secret=${sentinel}`,
        },
        requestedSchema: { type: "object", properties: {} },
      },
      {
        mode: "form",
        _meta: {
          codex_approval_kind: "mcp_tool_call",
          codex_request_type: "approval_request",
          connector_name: sentinel,
          tool_name: "delete_records",
          tool_params: { target: sentinel },
          persist: "always",
        },
        requestedSchema: { type: "object", properties: {} },
      },
    ] as const;
    for (const [index, request] of requests.entries()) {
      process.respond({
        id: 910 + index,
        method: "mcpServer/elicitation/request",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          serverName: "example",
          _meta: null,
          message: "Configure Example",
          ...request,
        },
      });
      await waitFor(() => process.writes.some((write) =>
        (write as { id?: unknown }).id === 910 + index));
      expect(process.writes.at(-1)).toEqual({
        id: 910 + index,
        error: {
          code: -32_601,
          message: "Oompa cannot broker this server request capability",
          data: { code: "UNSUPPORTED_CAPABILITY" },
        },
      });
    }
    expect(facts.some((fact) => fact.type === "interactionRequested")).toBe(false);
    expect(diagnostics).toEqual([
      "Codex requested an unsupported capability for mcpServer/elicitation/request",
      "Codex requested an unsupported capability for mcpServer/elicitation/request",
      "Codex requested an unsupported capability for mcpServer/elicitation/request",
      "Codex requested an unsupported capability for mcpServer/elicitation/request",
    ]);
    expect(JSON.stringify({ writes: process.writes, facts, diagnostics })).not.toContain(sentinel);
    await client.close();
  });

  test("brokers a standard MCP form and writes only a schema-valid exact response", async () => {
    const process = successfulFake("/tmp/hra-control-plane/profile-a/codex-home");
    const facts: FencedCodexValue<CodexFact>[] = [];
    const client = createClient({
      process,
      authority: codexAuthority(4),
      expectedCodexHome: "/tmp/hra-control-plane/profile-a/codex-home",
      isAuthorityCurrent: () => true,
      connectionId: CONNECTION_ID,
      onFact: (fact) => { facts.push(fact); },
    });
    await client.initialize();
    const schemaOnlySentinel = "MCP_CLIENT_PRIVATE_SCHEMA_SENTINEL";
    process.respond({
      id: 911,
      method: "mcpServer/elicitation/request",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        serverName: "example",
        mode: "form",
        _meta: null,
        message: "Configure Example",
        requestedSchema: {
          type: "object",
          properties: {
            channel: {
              type: "string",
              title: schemaOnlySentinel,
              enum: ["stable", "fast"],
              enumNames: [schemaOnlySentinel, schemaOnlySentinel],
            },
            confirmed: { type: "boolean" },
          },
          required: ["channel", "confirmed"],
        },
      },
    });
    await waitFor(() => facts.some((fact) => fact.value.type === "interactionRequested"));
    const requested = facts.find((fact) => fact.value.type === "interactionRequested")?.value;
    if (requested?.type !== "interactionRequested") throw new Error("MCP form was not admitted.");
    expect(requested.display).toMatchObject({
      kind: "mcp_elicitation",
      mode: "form",
      fields: [
        { name: "channel", type: "single_select", required: true, choices: ["stable", "fast"] },
        { name: "confirmed", type: "boolean", required: true },
      ],
    });
    expect(JSON.stringify(requested.display)).not.toContain(schemaOnlySentinel);
    await Bun.sleep(1);
    const writesBeforeInvalid = process.writes.length;
    const submittedSentinel = "MCP_CLIENT_SUBMISSION_SECRET_SENTINEL";
    await expect(client.validateInteractionResolution({
      provider: requested.provider,
      kind: requested.kind,
      resolution: {
        kind: "mcp_submission",
        action: "accept",
        content: { channel: submittedSentinel, confirmed: true },
      },
    })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(process.writes).toHaveLength(writesBeforeInvalid);
    await expect(client.validateInteractionResolution({
      provider: requested.provider,
      kind: requested.kind,
      resolution: {
        kind: "mcp_submission",
        action: "accept",
        content: { channel: "fast", confirmed: true },
      },
    })).resolves.toEqual({
      responseDigest: "78cc323d0067a51b626d7e1a37704ffd9f002346cb0707dd3d28c327546510e2",
    });
    expect(process.writes).toHaveLength(writesBeforeInvalid);
    await client.resolveInteraction({
      provider: requested.provider,
      kind: requested.kind,
      deadlineAt: requested.deadlineAt ?? Number.NaN,
      resolution: {
        kind: "mcp_submission",
        action: "accept",
        content: { channel: "fast", confirmed: true },
      },
    });
    expect(process.writes.at(-1)).toEqual({
      id: 911,
      result: {
        action: "accept",
        content: { channel: "fast", confirmed: true },
        _meta: null,
      },
    });
    expect(JSON.stringify(process.writes)).not.toContain(submittedSentinel);
    await client.close();
  });

  test("admits a typed interaction and routes an exact response without granting through text", async () => {
    const process = successfulFake("/tmp/hra-control-plane/profile-a/codex-home");
    const facts: FencedCodexValue<CodexFact>[] = [];
    const client = createClient({
      process,
      authority: codexAuthority(4),
      expectedCodexHome: "/tmp/hra-control-plane/profile-a/codex-home",
      isAuthorityCurrent: () => true,
      connectionId: CONNECTION_ID,
      onFact: (fact) => { facts.push(fact); },
    });
    await client.initialize();
    process.respond({
      id: 41,
      method: "item/commandExecution/requestApproval",
      params: commandApprovalParams(),
    });
    await waitFor(() => facts.some((fact) => fact.value.type === "interactionRequested"));
    const requested = facts.find((fact) => fact.value.type === "interactionRequested")?.value;
    if (requested?.type !== "interactionRequested") throw new Error("interaction was not admitted");
    expect(requested.provider).toMatchObject({
      connectionId: CONNECTION_ID,
      requestId: { type: "number", value: 41 },
      method: "item/commandExecution/requestApproval",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
    });
    expect(requested.display).toMatchObject({
      kind: "command_approval",
      commandClass: "git push",
      availableDecisions: ["once" as const, "session" as const, "decline" as const, "cancel" as const],
    });
    await expect(client.inspectInteractionAuthority({
      provider: requested.provider,
      kind: requested.kind,
    })).resolves.toEqual({
      kind: "command_approval",
      command: "git push origin main",
      reason: "Need network access",
      availableDecisions: ["accept", "acceptForSession", "decline", "cancel"],
      workingDirectory: "/workspace/project",
      environmentId: null,
      commandActions: [],
      networkApprovalContext: null,
      additionalPermissions: null,
      proposedExecpolicyAmendment: null,
      proposedNetworkPolicyAmendments: null,
    });
    await expect(client.inspectInteractionAuthority({
      provider: { ...requested.provider, connectionId: crypto.randomUUID() },
      kind: requested.kind,
    })).rejects.toMatchObject({ code: "AUTHORITY_STALE" });
    await expect(client.resolveInteraction({
      provider: { ...requested.provider, requestDigest: "b".repeat(64) },
      kind: requested.kind,
      deadlineAt: requested.deadlineAt ?? Number.NaN,
      resolution: { kind: "approval_decision", decision: "once" },
    })).rejects.toMatchObject({ code: "AUTHORITY_STALE" });
    await client.resolveInteraction({
      provider: requested.provider,
      kind: requested.kind,
      deadlineAt: requested.deadlineAt ?? Number.NaN,
      resolution: { kind: "approval_decision", decision: "session" },
    });
    expect(process.writes.at(-1)).toEqual({ id: 41, result: { decision: "acceptForSession" } });
    await expect(client.inspectInteractionAuthority({
      provider: requested.provider,
      kind: requested.kind,
    })).rejects.toMatchObject({ code: "UNSUPPORTED_CAPABILITY" });

    process.respond({
      method: "serverRequest/resolved",
      params: { threadId: "thread-1", requestId: 41 },
    });
    await waitFor(() => facts.some((fact) => fact.value.type === "interactionResolved"));
    await client.close();
  });

  test("anchors callback deadlines at receipt and writes one provider-neutral timeout error", async () => {
    const process = successfulFake("/tmp/hra-control-plane/profile-a/codex-home");
    const facts: CodexFact[] = [];
    let now = 10_000;
    const client = createClient({
      process,
      authority: codexAuthority(1),
      expectedCodexHome: "/tmp/hra-control-plane/profile-a/codex-home",
      isAuthorityCurrent: () => true,
      connectionId: CONNECTION_ID,
      now: () => now,
      onFact: ({ value }) => { facts.push(value); },
    });
    await client.initialize();
    process.respond({
      id: "deadline-request",
      method: "item/tool/requestUserInput",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-deadline",
        isBlocking: true,
        autoResolutionMs: 5_000,
        questions: [{
          id: "choice",
          header: "Choice",
          question: "Choose",
          isOther: true,
          isSecret: false,
          options: null,
        }],
      },
    });
    await waitFor(() => facts.some((fact) => fact.type === "interactionRequested"));
    now = 14_000;
    const requested = facts.find((fact) => fact.type === "interactionRequested");
    if (requested?.type !== "interactionRequested") throw new Error("Missing deadline interaction.");
    expect(requested).toMatchObject({ requestedAt: 10_000, deadlineAt: 15_000, timeoutMs: 5_000 });
    const validated = await client.validateInteractionTimeout({ provider: requested.provider });
    expect(validated.responseDigest).toMatch(/^[a-f0-9]{64}$/u);
    await expect(client.timeoutInteraction({ provider: requested.provider }))
      .resolves.toEqual({ responseWritten: true });
    expect(process.writes.at(-1)).toEqual({
      id: "deadline-request",
      error: { code: -32_008, message: "Oompa interaction deadline expired" },
    });
    process.respond({
      method: "serverRequest/resolved",
      params: { threadId: "thread-1", requestId: "deadline-request" },
    });
    await waitFor(() => facts.some((fact) => fact.type === "interactionResolved"));
    await client.close();
  });

  test("rejects a manual response inside the serialized write boundary at its deadline", async () => {
    let now = 10_000;
    const process = successfulFake("/tmp/hra-control-plane/profile-a/codex-home");
    const facts: CodexFact[] = [];
    const client = createClient({
      process,
      authority: codexAuthority(1),
      expectedCodexHome: "/tmp/hra-control-plane/profile-a/codex-home",
      isAuthorityCurrent: () => true,
      connectionId: CONNECTION_ID,
      now: () => now,
      onFact: ({ value }) => { facts.push(value); },
    });
    await client.initialize();
    process.respond({
      id: 72,
      method: "item/commandExecution/requestApproval",
      params: { ...commandApprovalParams(), autoResolutionMs: 1_000 },
    });
    await waitFor(() => facts.some((fact) => fact.type === "interactionRequested"));
    const requested = facts.find((fact) => fact.type === "interactionRequested");
    if (requested?.type !== "interactionRequested" || requested.deadlineAt === undefined) {
      throw new Error("Missing deadline interaction.");
    }

    let releaseWrite!: () => void;
    process.writeSettlementGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const blockingRead = client.accountRead();
    await waitFor(() => process.writes.some((value) =>
      (value as { method?: string }).method === "account/read"));
    now = 10_999;
    const manualResponse = client.resolveInteraction({
      provider: requested.provider,
      kind: requested.kind,
      deadlineAt: requested.deadlineAt,
      resolution: { kind: "approval_decision", decision: "once" },
    });
    await Bun.sleep(1);
    now = 11_000;
    releaseWrite();
    await blockingRead;

    await expect(manualResponse).rejects.toMatchObject({ code: "DEADLINE_EXPIRED" });
    expect(process.writes.filter((value) =>
      (value as { id?: unknown; result?: unknown }).id === 72
      && "result" in (value as object))).toHaveLength(0);
    await expect(client.timeoutInteraction({ provider: requested.provider }))
      .resolves.toEqual({ responseWritten: true });
    expect(process.writes.at(-1)).toEqual({
      id: 72,
      error: { code: -32_008, message: "Oompa interaction deadline expired" },
    });
    await client.close();
  });

  test("admits the exact manual response one millisecond before its deadline", async () => {
    let now = 30_000;
    const process = successfulFake("/tmp/hra-control-plane/profile-a/codex-home");
    const facts: CodexFact[] = [];
    const client = createClient({
      process,
      authority: codexAuthority(1),
      expectedCodexHome: "/tmp/hra-control-plane/profile-a/codex-home",
      isAuthorityCurrent: () => true,
      connectionId: CONNECTION_ID,
      now: () => now,
      onFact: ({ value }) => { facts.push(value); },
    });
    await client.initialize();
    process.respond({
      id: 74,
      method: "item/commandExecution/requestApproval",
      params: { ...commandApprovalParams(), autoResolutionMs: 1_000 },
    });
    await waitFor(() => facts.some((fact) => fact.type === "interactionRequested"));
    const requested = facts.find((fact) => fact.type === "interactionRequested");
    if (requested?.type !== "interactionRequested" || requested.deadlineAt === undefined) {
      throw new Error("Missing provider interaction.");
    }
    now = requested.deadlineAt - 1;
    await expect(client.resolveInteraction({
      provider: requested.provider,
      kind: requested.kind,
      deadlineAt: requested.deadlineAt,
      resolution: { kind: "approval_decision", decision: "once" },
    })).resolves.toEqual({ responseWritten: true });
    expect(process.writes.at(-1)).toEqual({ id: 74, result: { decision: "accept" } });
    await client.close();
  });

  test("does not write a queued response after the provider resolves the request", async () => {
    let now = 20_000;
    const process = successfulFake("/tmp/hra-control-plane/profile-a/codex-home");
    const facts: CodexFact[] = [];
    const client = createClient({
      process,
      authority: codexAuthority(1),
      expectedCodexHome: "/tmp/hra-control-plane/profile-a/codex-home",
      isAuthorityCurrent: () => true,
      connectionId: CONNECTION_ID,
      now: () => now,
      onFact: ({ value }) => { facts.push(value); },
    });
    await client.initialize();
    process.respond({
      id: 73,
      method: "item/commandExecution/requestApproval",
      params: { ...commandApprovalParams(), autoResolutionMs: 1_000 },
    });
    await waitFor(() => facts.some((fact) => fact.type === "interactionRequested"));
    const requested = facts.find((fact) => fact.type === "interactionRequested");
    if (requested?.type !== "interactionRequested" || requested.deadlineAt === undefined) {
      throw new Error("Missing provider interaction.");
    }

    let releaseWrite!: () => void;
    process.writeSettlementGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const blockingRead = client.accountRead();
    await waitFor(() => process.writes.some((value) =>
      (value as { method?: string }).method === "account/read"));
    const manualResponse = client.resolveInteraction({
      provider: requested.provider,
      kind: requested.kind,
      deadlineAt: requested.deadlineAt,
      resolution: { kind: "approval_decision", decision: "once" },
    });
    await Bun.sleep(1);
    process.respond({
      method: "serverRequest/resolved",
      params: { threadId: "thread-1", requestId: 73 },
    });
    await waitFor(() => facts.some((fact) => fact.type === "interactionResolved"));
    now = 20_001;
    releaseWrite();
    await blockingRead;

    await expect(manualResponse).rejects.toMatchObject({ code: "AUTHORITY_STALE" });
    expect(process.writes.filter((value) =>
      (value as { id?: unknown; result?: unknown }).id === 73
      && "result" in (value as object))).toHaveLength(0);
    await client.close();
  });

  test("does not write a queued timeout after the provider resolves the request", async () => {
    const process = successfulFake("/tmp/hra-control-plane/profile-a/codex-home");
    const facts: CodexFact[] = [];
    const client = createClient({
      process,
      authority: codexAuthority(1),
      expectedCodexHome: "/tmp/hra-control-plane/profile-a/codex-home",
      isAuthorityCurrent: () => true,
      connectionId: CONNECTION_ID,
      onFact: ({ value }) => { facts.push(value); },
    });
    await client.initialize();
    process.respond({ id: 75, method: "item/commandExecution/requestApproval", params: commandApprovalParams() });
    await waitFor(() => facts.some((fact) => fact.type === "interactionRequested"));
    const requested = facts.find((fact) => fact.type === "interactionRequested");
    if (requested?.type !== "interactionRequested") throw new Error("Missing provider interaction.");

    let releaseWrite!: () => void;
    process.writeSettlementGate = new Promise<void>((resolve) => { releaseWrite = resolve; });
    const blockingRead = client.accountRead();
    await waitFor(() => process.writes.some((value) =>
      (value as { method?: string }).method === "account/read"));
    const timeout = client.timeoutInteraction({ provider: requested.provider });
    await Bun.sleep(1);
    process.respond({
      method: "serverRequest/resolved",
      params: { threadId: "thread-1", requestId: 75 },
    });
    await waitFor(() => facts.some((fact) => fact.type === "interactionResolved"));
    releaseWrite();
    await blockingRead;
    await expect(timeout).rejects.toMatchObject({ code: "AUTHORITY_STALE" });
    expect(process.writes.filter((value) =>
      (value as { id?: unknown; error?: unknown }).id === 75
      && "error" in (value as object))).toHaveLength(0);
    await client.close();
  });

  test("reserves one response frame across concurrent manual and timeout attempts", async () => {
    const process = successfulFake("/tmp/hra-control-plane/profile-a/codex-home");
    const facts: CodexFact[] = [];
    let race = false;
    let arrivals = 0;
    let releaseRace!: () => void;
    const raceGate = new Promise<void>((resolve) => { releaseRace = resolve; });
    const client = createClient({
      process,
      authority: codexAuthority(1),
      expectedCodexHome: "/tmp/hra-control-plane/profile-a/codex-home",
      isAuthorityCurrent: async () => {
        if (!race) return true;
        arrivals += 1;
        if (arrivals === 2) releaseRace();
        await raceGate;
        return true;
      },
      connectionId: CONNECTION_ID,
      onFact: ({ value }) => { facts.push(value); },
    });
    await client.initialize();
    process.respond({ id: 76, method: "item/commandExecution/requestApproval", params: commandApprovalParams() });
    await waitFor(() => facts.some((fact) => fact.type === "interactionRequested"));
    const requested = facts.find((fact) => fact.type === "interactionRequested");
    if (requested?.type !== "interactionRequested" || requested.deadlineAt === undefined) {
      throw new Error("Missing provider interaction.");
    }
    race = true;
    const outcomes = await Promise.allSettled([
      client.resolveInteraction({
        provider: requested.provider,
        kind: requested.kind,
        deadlineAt: requested.deadlineAt,
        resolution: { kind: "approval_decision", decision: "once" },
      }),
      client.timeoutInteraction({ provider: requested.provider }),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    expect(process.writes.filter((value) => (value as { id?: unknown }).id === 76)).toHaveLength(1);
    await client.close();
  });

  test("keeps an admitted manual write rejection unknown without dispatching a timeout", async () => {
    const process = successfulFake("/tmp/hra-control-plane/profile-a/codex-home");
    const facts: CodexFact[] = [];
    const client = createClient({
      process,
      authority: codexAuthority(1),
      expectedCodexHome: "/tmp/hra-control-plane/profile-a/codex-home",
      isAuthorityCurrent: () => true,
      connectionId: CONNECTION_ID,
      onFact: ({ value }) => { facts.push(value); },
    });
    await client.initialize();
    process.respond({ id: 77, method: "item/commandExecution/requestApproval", params: commandApprovalParams() });
    await waitFor(() => facts.some((fact) => fact.type === "interactionRequested"));
    const requested = facts.find((fact) => fact.type === "interactionRequested");
    if (requested?.type !== "interactionRequested" || requested.deadlineAt === undefined) {
      throw new Error("Missing provider interaction.");
    }
    process.writeError = new Error("uncertain manual response write");
    await expect(client.resolveInteraction({
      provider: requested.provider,
      kind: requested.kind,
      deadlineAt: requested.deadlineAt,
      resolution: { kind: "approval_decision", decision: "once" },
    })).rejects.toMatchObject({ code: "INDETERMINATE_EFFECT" });
    await expect(client.timeoutInteraction({ provider: requested.provider }))
      .rejects.toMatchObject({ code: "AUTHORITY_STALE" });
    expect(process.writes.filter((value) =>
      (value as { id?: unknown; error?: unknown }).id === 77
      && "error" in (value as object))).toHaveLength(0);
    await client.close();
  });

  test("quarantines the provider generation when a timeout write may have escaped", async () => {
    const process = successfulFake("/tmp/hra-control-plane/profile-a/codex-home");
    const facts: CodexFact[] = [];
    const client = createClient({
      process,
      authority: codexAuthority(1),
      expectedCodexHome: "/tmp/hra-control-plane/profile-a/codex-home",
      isAuthorityCurrent: () => true,
      connectionId: CONNECTION_ID,
      onFact: ({ value }) => { facts.push(value); },
    });
    await client.initialize();
    process.respond({ id: 52, method: "item/commandExecution/requestApproval", params: commandApprovalParams() });
    await waitFor(() => facts.some((fact) => fact.type === "interactionRequested"));
    const requested = facts.find((fact) => fact.type === "interactionRequested");
    if (requested?.type !== "interactionRequested") throw new Error("Missing interaction.");
    await client.validateInteractionTimeout({ provider: requested.provider });
    process.writeError = new Error("uncertain private pipe write");
    await expect(client.timeoutInteraction({ provider: requested.provider }))
      .rejects.toMatchObject({ code: "INDETERMINATE_EFFECT" });
    expect(client.state).toBe("failed");
    expect(process.signals).toContain("SIGTERM");
    await waitFor(() => facts.some((fact) =>
      fact.type === "providerDisconnected" && fact.reason === "protocol_fault"));
    await expect(client.timeoutInteraction({ provider: requested.provider }))
      .rejects.toMatchObject({ code: "AUTHORITY_STALE" });
    await client.close();
  });

  test("keeps numeric and string server request ids distinct", async () => {
    const process = successfulFake("/tmp/hra-control-plane/profile-a/codex-home");
    const facts: CodexFact[] = [];
    const client = createClient({
      process,
      authority: codexAuthority(1),
      expectedCodexHome: "/tmp/hra-control-plane/profile-a/codex-home",
      isAuthorityCurrent: () => true,
      connectionId: CONNECTION_ID,
      onFact: ({ value }) => { facts.push(value); },
    });
    await client.initialize();
    process.respond({ id: 1, method: "item/commandExecution/requestApproval", params: commandApprovalParams("one") });
    process.respond({ id: "1", method: "item/commandExecution/requestApproval", params: { ...commandApprovalParams("two"), itemId: "item-2" } });
    await waitFor(() => facts.filter((fact) => fact.type === "interactionRequested").length === 2);
    expect(facts.filter((fact) => fact.type === "interactionRequested").map((fact) =>
      fact.provider.requestId)).toEqual([
      { type: "number", value: 1 },
      { type: "string", value: "1" },
    ]);
    await client.close();
  });

  test("does not block response reads while durable interaction admission is pending", async () => {
    const process = successfulFake("/tmp/hra-control-plane/profile-a/codex-home");
    let releaseAdmission!: () => void;
    const admissionGate = new Promise<void>((resolve) => { releaseAdmission = resolve; });
    let admissionStarted = false;
    const client = createClient({
      process,
      authority: codexAuthority(1),
      expectedCodexHome: "/tmp/hra-control-plane/profile-a/codex-home",
      isAuthorityCurrent: () => true,
      connectionId: CONNECTION_ID,
      onFact: async ({ value }) => {
        if (value.type !== "interactionRequested") return;
        admissionStarted = true;
        await admissionGate;
      },
    });
    await client.initialize();
    process.respond({ id: 50, method: "item/commandExecution/requestApproval", params: commandApprovalParams() });
    await waitFor(() => admissionStarted);
    const account = await client.accountRead();
    expect(account.value.account).toMatchObject({ type: "chatgpt", planType: "pro" });
    releaseAdmission();
    await client.close();
  });

  test("quarantines a mutated same-id replay while accepting canonical key reordering", async () => {
    const process = successfulFake("/tmp/hra-control-plane/profile-a/codex-home");
    const client = createClient({
      process,
      authority: codexAuthority(1),
      expectedCodexHome: "/tmp/hra-control-plane/profile-a/codex-home",
      isAuthorityCurrent: () => true,
      connectionId: CONNECTION_ID,
    });
    await client.initialize();
    const params = commandApprovalParams();
    process.respond({ id: 70, method: "item/commandExecution/requestApproval", params });
    process.respond({ id: 70, method: "item/commandExecution/requestApproval", params: Object.fromEntries(Object.entries(params).reverse()) });
    await Bun.sleep(2);
    expect(client.state).toBe("ready");
    process.respond({ id: 70, method: "item/commandExecution/requestApproval", params: commandApprovalParams("mutated") });
    await waitFor(() => client.state === "failed");
    expect(process.writes.at(-1)).toEqual({
      id: 70,
      error: { code: -32_609, message: "Conflicting server request replay" },
    });
    expect(process.signals).toContain("SIGTERM");
    await client.close();
  });

  test("does not replay a barrier-blocked approval after the provider resolves it", async () => {
    const process = successfulFake("/tmp/hra-control-plane/profile-a/codex-home");
    const barrier = deferred<undefined>();
    const facts: CodexFact[] = [];
    const client = createClient({
      process,
      authority: codexAuthority(1),
      expectedCodexHome: "/tmp/hra-control-plane/profile-a/codex-home",
      isAuthorityCurrent: () => true,
      connectionId: CONNECTION_ID,
      onAccountAuthoritySignal: () => barrier.promise,
      onFact: ({ value }) => { facts.push(value); },
    });
    await client.initialize();
    const params = commandApprovalParams();
    process.respond({ id: 70, method: "item/commandExecution/requestApproval", params });
    await waitFor(() => facts.some((fact) => fact.type === "interactionRequested"));
    const requested = facts.find((fact) => fact.type === "interactionRequested");
    if (requested?.type !== "interactionRequested") throw new Error("Missing interaction.");
    await client.resolveInteraction({
      provider: requested.provider,
      kind: requested.kind,
      deadlineAt: requested.deadlineAt ?? Number.NaN,
      resolution: { kind: "approval_decision", decision: "once" },
    });
    expect(process.writes.filter((frame) =>
      (frame as Record<string, unknown>).id === 70)).toHaveLength(1);

    process.stdoutQueue.push([
      JSON.stringify({
        method: "account/updated",
        params: { authMode: "chatgpt", planType: "pro" },
      }),
      JSON.stringify({
        id: 70,
        method: "item/commandExecution/requestApproval",
        params,
      }),
      JSON.stringify({
        method: "serverRequest/resolved",
        params: { threadId: "thread-1", requestId: 70 },
      }),
      "",
    ].join("\n"));
    await waitFor(() => facts.some((fact) => fact.type === "interactionResolved"));
    barrier.resolve(undefined);
    await Bun.sleep(2);
    expect(process.writes.filter((frame) =>
      (frame as Record<string, unknown>).id === 70)).toHaveLength(1);
    expect(client.state).toBe("ready");
    await client.close();
  });

  test("binds feature and app discovery to the exact existing thread", async () => {
    const codexHome = "/tmp/hra-control-plane/profile-a/codex-home";
    const process = new FakeProcess((message, target) => {
      if (message.method === "initialize") {
        target.respond({ id: message.id, result: { userAgent: "codex-cli/0.153.2", codexHome, platformFamily: "unix", platformOs: "macos" } });
      } else if (message.method === "model/list" || message.method === "experimentalFeature/list" || message.method === "permissionProfile/list" || message.method === "app/list") {
        target.respond({ id: message.id, result: { data: [], nextCursor: null } });
      }
    });
    const client = createClient({
      process,
      authority: codexAuthority(1),
      expectedCodexHome: codexHome,
      experimentalApi: true,
      isAuthorityCurrent: () => true,
    });
    await client.initialize();
    await client.discoverCapabilities({ cwd: "/workspace/project", threadId: "thread-1", includeExperimental: true });
    expect(process.writes.slice(3)).toEqual([
      { id: 3, method: "model/list", params: { includeHidden: true, limit: 100, cursor: null } },
      { id: 4, method: "experimentalFeature/list", params: { limit: 100, threadId: "thread-1", cursor: null } },
      { id: 5, method: "permissionProfile/list", params: { limit: 100, cwd: "/workspace/project", cursor: null } },
      { id: 6, method: "app/list", params: { limit: 100, forceRefetch: true, threadId: "thread-1", cursor: null } },
    ]);
    await client.close();
  });

  test("applies one aggregate deadline to stalled capability discovery", async () => {
    const codexHome = "/tmp/hra-control-plane/profile-a/codex-home";
    const process = new FakeProcess((message, target) => {
      if (message.method === "initialize") {
        target.respond({ id: message.id, result: { userAgent: "codex-cli/0.153.2", codexHome, platformFamily: "unix", platformOs: "macos" } });
      }
    });
    const client = createClient({
      process,
      authority: codexAuthority(1),
      expectedCodexHome: codexHome,
      capabilityDiscoveryDeadlineMs: 20,
      isAuthorityCurrent: () => true,
    });
    await client.initialize();

    const startedAt = performance.now();
    await expect(client.discoverCapabilities()).rejects.toMatchObject({
      code: "TIMEOUT",
      message: "capability discovery timed out",
    });
    expect(performance.now() - startedAt).toBeLessThan(1_000);
    expect(process.writes.filter((frame) =>
      (frame as { method?: unknown }).method === "model/list")).toHaveLength(1);
    expect(client.state).toBe("ready");
    await client.close();
  });

  test("observes discovery settlement when the caller signal is already aborted", async () => {
    const codexHome = "/tmp/hra-control-plane/profile-a/codex-home";
    const process = successfulFake(codexHome);
    const client = createClient({
      process,
      authority: codexAuthority(1),
      expectedCodexHome: codexHome,
      isAuthorityCurrent: () => true,
    });
    await client.initialize();
    const controller = new AbortController();
    const reason = new Error("request boundary already closed");
    controller.abort(reason);

    await expect(client.discoverCapabilities({ signal: controller.signal })).rejects.toBe(reason);
    await Bun.sleep(2);

    expect(process.writes.some((frame) =>
      (frame as { method?: unknown }).method === "model/list")).toBe(false);
    expect(client.state).toBe("ready");
    await client.close();
  });

  test("account status reads honor caller cancellation and tolerate the late provider response", async () => {
    const codexHome = "/tmp/hra-control-plane/profile-a/codex-home";
    const requested = deferred<unknown>();
    const process = new FakeProcess((message, target) => {
      if (message.method === "initialize") {
        target.respond({ id: message.id, result: { userAgent: "codex-cli/0.153.2", codexHome, platformFamily: "unix", platformOs: "macos" } });
      } else if (message.method === "account/read") {
        requested.resolve(message.id);
      }
    });
    const client = createClient({
      process,
      authority: codexAuthority(1),
      expectedCodexHome: codexHome,
      isAuthorityCurrent: () => true,
    });
    await client.initialize();
    const controller = new AbortController();
    const reason = new Error("account status caller departed");
    const result = client.accountRead(false, controller.signal).catch((error: unknown) => error);
    try {
      const requestId = await requested.promise;
      controller.abort(reason);
      expect(await Promise.race([result, Bun.sleep(200).then(() => "still-pending")])).toBe(reason);
      process.respond({ id: requestId, result: { account: null, requiresOpenaiAuth: true } });
      await Bun.sleep(2);
      expect(client.state).toBe("ready");
    } finally {
      await client.close();
      await result;
    }
  });

  test("caller abort cancels the current page, prevents continuations, and tolerates its late response", async () => {
    const codexHome = "/tmp/hra-control-plane/profile-a/codex-home";
    let modelPage = 0;
    let stalledRequestId: unknown;
    const process = new FakeProcess((message, target) => {
      if (message.method === "initialize") {
        target.respond({ id: message.id, result: { userAgent: "codex-cli/0.153.2", codexHome, platformFamily: "unix", platformOs: "macos" } });
      } else if (message.method === "model/list") {
        modelPage += 1;
        if (modelPage === 1) {
          target.respond({ id: message.id, result: { data: [], nextCursor: "models-page-2" } });
        } else {
          stalledRequestId = message.id;
        }
      } else if (message.method === "account/read") {
        target.respond({
          id: message.id,
          result: {
            account: { type: "chatgpt", email: "person@example.com", planType: "pro" },
            requiresOpenaiAuth: true,
          },
        });
      }
    });
    const client = createClient({
      process,
      authority: codexAuthority(1),
      expectedCodexHome: codexHome,
      isAuthorityCurrent: () => true,
    });
    await client.initialize();
    const controller = new AbortController();
    const reason = new Error("request boundary closed");
    const discovery = client.discoverCapabilities({ signal: controller.signal });
    await waitFor(() => stalledRequestId !== undefined);

    controller.abort(reason);
    await expect(discovery).rejects.toBe(reason);
    process.respond({
      id: stalledRequestId,
      result: { data: [], nextCursor: "models-page-3" },
    });
    await Bun.sleep(2);

    expect(process.writes.filter((frame) =>
      (frame as { method?: unknown }).method === "model/list")).toHaveLength(2);
    await expect(client.accountRead()).resolves.toMatchObject({
      value: { account: { type: "chatgpt", planType: "pro" } },
    });
    expect(client.state).toBe("ready");
    await client.close();
  });

  test("aborted queued discovery never writes its first read frame", async () => {
    const codexHome = "/tmp/hra-control-plane/profile-a/codex-home";
    const process = successfulFake(codexHome);
    const client = createClient({
      process,
      authority: codexAuthority(1),
      expectedCodexHome: codexHome,
      isAuthorityCurrent: () => true,
    });
    await client.initialize();
    const writeGate = deferred<undefined>();
    process.writeSettlementGate = writeGate.promise;
    const occupyingRead = client.accountRead();
    await waitFor(() => process.writes.some((frame) =>
      (frame as { method?: unknown }).method === "account/read"));
    const controller = new AbortController();
    const reason = new Error("request boundary closed");
    const discovery = client.discoverCapabilities({ signal: controller.signal });
    const discoveryResult = discovery.catch((error: unknown) => error);
    await Promise.resolve();
    await Promise.resolve();

    controller.abort(reason);
    writeGate.resolve(undefined);

    await expect(occupyingRead).resolves.toMatchObject({
      value: { account: { type: "chatgpt", planType: "pro" } },
    });
    expect(await discoveryResult).toBe(reason);
    expect(process.writes.some((frame) =>
      (frame as { method?: unknown }).method === "model/list")).toBe(false);
    await client.close();
  });

  test("caller abort settles a queued credential read while the prior write remains blocked", async () => {
    const codexHome = "/tmp/hra-control-plane/profile-a/codex-home";
    const process = successfulFake(codexHome);
    const client = createClient({
      process,
      authority: codexAuthority(1),
      expectedCodexHome: codexHome,
      isAuthorityCurrent: () => true,
    });
    await client.initialize();
    const writeGate = deferred<undefined>();
    process.writeSettlementGate = writeGate.promise;
    const occupyingRead = client.accountRead();
    await waitFor(() => process.writes.some((frame) =>
      (frame as { method?: unknown }).method === "account/read"));
    const configReadsBefore = process.writes.filter((frame) =>
      (frame as { method?: unknown }).method === "config/read").length;
    const controller = new AbortController();
    const reason = new Error("request boundary closed while queued");
    const credentialRead = client.assertCredentialStores(
      "/tmp/hra-control-plane/project",
      controller.signal,
    ).then(
      () => "resolved" as const,
      (error: unknown) => error,
    );

    try {
      controller.abort(reason);
      const result = await Promise.race([
        credentialRead,
        Bun.sleep(200).then(() => "still-blocked" as const),
      ]);
      expect(result).toBe(reason);
      expect(process.writes.filter((frame) =>
        (frame as { method?: unknown }).method === "config/read")).toHaveLength(configReadsBefore);
    } finally {
      writeGate.resolve(undefined);
    }

    await expect(occupyingRead).resolves.toMatchObject({
      value: { account: { type: "chatgpt", planType: "pro" } },
    });
    await credentialRead;
    await client.close();
  });

  test("does not dispatch a queued mutation after its deadline expires", async () => {
    const codexHome = "/tmp/hra-control-plane/profile-a/codex-home";
    const process = successfulFake(codexHome);
    const client = createClient({
      process,
      authority: codexAuthority(1),
      expectedCodexHome: codexHome,
      isAuthorityCurrent: () => true,
    });
    await client.initialize();
    const writeGate = deferred<undefined>();
    process.writeSettlementGate = writeGate.promise;
    const occupyingRead = client.accountRead();
    await waitFor(() => process.writes.some((frame) =>
      (frame as { method?: unknown }).method === "account/read"));
    await expect(occupyingRead).resolves.toMatchObject({
      value: { account: { type: "chatgpt", planType: "pro" } },
    });

    jest.useFakeTimers();
    try {
      const mutation = client.renameThread("thread-1", "renamed");
      for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
      jest.advanceTimersByTime(15_000);

      await expect(mutation).rejects.toMatchObject({
        code: "TIMEOUT",
        message: "thread/name/set timed out",
      });
      expect(process.writes.some((frame) =>
        (frame as { method?: unknown }).method === "thread/name/set")).toBe(false);

      writeGate.resolve(undefined);
      for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
      expect(process.writes.some((frame) =>
        (frame as { method?: unknown }).method === "thread/name/set")).toBe(false);
    } finally {
      writeGate.resolve(undefined);
      jest.useRealTimers();
    }

    await client.close();
  });

  test("quarantines a response that arrives before its queued request is dispatched", async () => {
    const codexHome = "/tmp/hra-control-plane/profile-a/codex-home";
    const process = successfulFake(codexHome);
    const client = createClient({
      process,
      authority: codexAuthority(1),
      expectedCodexHome: codexHome,
      isAuthorityCurrent: () => true,
    });
    await client.initialize();
    const writeGate = deferred<undefined>();
    process.writeSettlementGate = writeGate.promise;
    const occupyingRead = client.accountRead();
    await waitFor(() => process.writes.some((frame) =>
      (frame as { id?: unknown }).id === 3));
    await expect(occupyingRead).resolves.toMatchObject({
      value: { account: { type: "chatgpt", planType: "pro" } },
    });
    const queuedRead = client.accountRead();
    for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
    expect(process.writes.some((frame) =>
      (frame as { id?: unknown }).id === 4)).toBe(false);

    process.respond({
      id: 4,
      result: {
        account: { type: "chatgpt", email: "person@example.com", planType: "pro" },
        requiresOpenaiAuth: true,
      },
    });
    await expect(queuedRead).rejects.toMatchObject({
      code: "PROTOCOL_ERROR",
      message: "Codex provider connection was quarantined",
    });
    expect(client.state).toBe("failed");
    expect(process.signals).toEqual(["SIGTERM"]);

    writeGate.resolve(undefined);
    for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
    expect(process.writes.some((frame) =>
      (frame as { id?: unknown }).id === 4)).toBe(false);
    await client.close();
  });

  test("keeps a dispatched mutation indeterminate when its response deadline expires", async () => {
    const codexHome = "/tmp/hra-control-plane/profile-a/codex-home";
    const mutationWritten = deferred<undefined>();
    const process = new FakeProcess((message, target) => {
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
      } else if (message.method === "thread/name/set") {
        mutationWritten.resolve(undefined);
      }
    });
    const client = createClient({
      process,
      authority: codexAuthority(1),
      expectedCodexHome: codexHome,
      isAuthorityCurrent: () => true,
    });
    await client.initialize();

    jest.useFakeTimers();
    try {
      const mutation = client.renameThread("thread-1", "renamed");
      await mutationWritten.promise;
      jest.advanceTimersByTime(15_000);

      await expect(mutation).rejects.toMatchObject({
        code: "INDETERMINATE_EFFECT",
        operation: "thread/name/set",
      });
      expect(process.writes.filter((frame) =>
        (frame as { method?: unknown }).method === "thread/name/set")).toHaveLength(1);
    } finally {
      jest.useRealTimers();
    }

    await client.close();
  });

  test("removes the caller abort listener after successful discovery", async () => {
    const codexHome = "/tmp/hra-control-plane/profile-a/codex-home";
    const process = new FakeProcess((message, target) => {
      if (message.method === "initialize") {
        target.respond({ id: message.id, result: { userAgent: "codex-cli/0.153.2", codexHome, platformFamily: "unix", platformOs: "macos" } });
      } else if (message.method === "model/list" || message.method === "experimentalFeature/list") {
        target.respond({ id: message.id, result: { data: [], nextCursor: null } });
      }
    });
    const client = createClient({
      process,
      authority: codexAuthority(1),
      expectedCodexHome: codexHome,
      capabilityDiscoveryDeadlineMs: 20,
      isAuthorityCurrent: () => true,
    });
    await client.initialize();
    const controller = new AbortController();
    const add = spyOn(controller.signal, "addEventListener");
    const remove = spyOn(controller.signal, "removeEventListener");
    try {
      await expect(client.discoverCapabilities({ signal: controller.signal })).resolves.toMatchObject({
        value: { models: [], features: [] },
      });
      expect(add).toHaveBeenCalledTimes(1);
      expect(remove).toHaveBeenCalledTimes(1);
      expect(remove.mock.calls[0]?.[1]).toBe(add.mock.calls[0]?.[1]);
      await Bun.sleep(30);
      expect(controller.signal.aborted).toBe(false);
      expect(client.state).toBe("ready");
    } finally {
      add.mockRestore();
      remove.mockRestore();
      await client.close();
    }
  });

  test("removes a read abort listener when the descriptor deadline wins", async () => {
    const codexHome = "/tmp/hra-control-plane/profile-a/codex-home";
    let configRead = 0;
    const stalled = deferred<undefined>();
    const process = new FakeProcess((message, target) => {
      if (message.method === "initialize") {
        target.respond({ id: message.id, result: { userAgent: "codex-cli/0.153.2", codexHome, platformFamily: "unix", platformOs: "macos" } });
      } else if (message.method === "config/read") {
        configRead += 1;
        if (configRead === 1) {
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
        } else {
          stalled.resolve(undefined);
        }
      }
    }, { autoCredentialStorePreflight: false });
    const client = createClient({
      process,
      authority: codexAuthority(1),
      expectedCodexHome: codexHome,
      isAuthorityCurrent: () => true,
    });
    await client.initialize();
    const controller = new AbortController();
    const add = spyOn(controller.signal, "addEventListener");
    const remove = spyOn(controller.signal, "removeEventListener");
    jest.useFakeTimers();
    try {
      const credentialRead = client.assertCredentialStores(
        "/tmp/hra-control-plane/project",
        controller.signal,
      );
      await stalled.promise;
      jest.advanceTimersByTime(10_000);
      await expect(credentialRead).rejects.toMatchObject({
        code: "TIMEOUT",
        message: "config/read timed out",
      });
      expect(add).toHaveBeenCalledTimes(1);
      expect(remove).toHaveBeenCalledTimes(1);
      expect(remove.mock.calls[0]?.[1]).toBe(add.mock.calls[0]?.[1]);
    } finally {
      jest.useRealTimers();
      add.mockRestore();
      remove.mockRestore();
      await client.close();
    }
  });

  test("refreshes the app cache once and disables refetch for every continuation", async () => {
    const codexHome = "/tmp/hra-control-plane/profile-a/codex-home";
    let appPage = 0;
    const process = new FakeProcess((message, target) => {
      if (message.method === "initialize") {
        target.respond({ id: message.id, result: { userAgent: "codex-cli/0.153.2", codexHome, platformFamily: "unix", platformOs: "macos" } });
      } else if (message.method === "model/list" || message.method === "experimentalFeature/list" || message.method === "permissionProfile/list") {
        target.respond({ id: message.id, result: { data: [], nextCursor: null } });
      } else if (message.method === "app/list") {
        appPage += 1;
        const id = `app-${String(appPage)}`;
        target.respond({
          id: message.id,
          result: {
            data: [appFixture(id)],
            nextCursor: appPage === 1
              ? "apps-page-2"
              : appPage === 2
                ? "apps-page-3"
                : null,
          },
        });
      }
    });
    const client = createClient({
      process,
      authority: codexAuthority(1),
      expectedCodexHome: codexHome,
      experimentalApi: true,
      isAuthorityCurrent: () => true,
    });
    await client.initialize();

    const capabilities = await client.discoverCapabilities({
      threadId: "thread-1",
      includeExperimental: true,
    });

    expect(capabilities.value.apps?.map((app) => app.id)).toEqual([
      "app-1",
      "app-2",
      "app-3",
    ]);
    expect(process.writes.slice(5)).toEqual([
      {
        id: 5,
        method: "permissionProfile/list",
        params: { limit: 100, cursor: null },
      },
      {
        id: 6,
        method: "app/list",
        params: {
          limit: 100,
          forceRefetch: true,
          threadId: "thread-1",
          cursor: null,
        },
      },
      {
        id: 7,
        method: "app/list",
        params: {
          limit: 100,
          forceRefetch: false,
          threadId: "thread-1",
          cursor: "apps-page-2",
        },
      },
      {
        id: 8,
        method: "app/list",
        params: {
          limit: 100,
          forceRefetch: false,
          threadId: "thread-1",
          cursor: "apps-page-3",
        },
      },
    ]);
    await client.close();
  });

  test("admits an exactly terminal 50th app page", async () => {
    const codexHome = "/tmp/hra-control-plane/profile-a/codex-home";
    let appPage = 0;
    const process = new FakeProcess((message, target) => {
      if (message.method === "initialize") {
        target.respond({ id: message.id, result: { userAgent: "codex-cli/0.153.2", codexHome, platformFamily: "unix", platformOs: "macos" } });
      } else if (message.method === "model/list" || message.method === "experimentalFeature/list" || message.method === "permissionProfile/list") {
        target.respond({ id: message.id, result: { data: [], nextCursor: null } });
      } else if (message.method === "app/list") {
        appPage += 1;
        target.respond({
          id: message.id,
          result: {
            data: [appFixture(`app-${String(appPage)}`)],
            nextCursor: appPage < 50 ? `apps-page-${String(appPage + 1)}` : null,
          },
        });
      }
    });
    const client = createClient({
      process,
      authority: codexAuthority(1),
      expectedCodexHome: codexHome,
      experimentalApi: true,
      isAuthorityCurrent: () => true,
    });
    await client.initialize();

    const capabilities = await client.discoverCapabilities({
      threadId: "thread-1",
      includeExperimental: true,
    });

    expect(capabilities.value.apps).toHaveLength(50);
    const appRequests = process.writes.filter((frame) =>
      (frame as { method?: unknown }).method === "app/list");
    expect(appRequests).toHaveLength(50);
    expect(appRequests[0]).toEqual({
      id: 6,
      method: "app/list",
      params: {
        limit: 100,
        forceRefetch: true,
        threadId: "thread-1",
        cursor: null,
      },
    });
    expect(appRequests[49]).toEqual({
      id: 55,
      method: "app/list",
      params: {
        limit: 100,
        forceRefetch: false,
        threadId: "thread-1",
        cursor: "apps-page-50",
      },
    });
    await client.close();
  });

  test("rejects a nonterminal continuation at the 50-page app limit", async () => {
    const codexHome = "/tmp/hra-control-plane/profile-a/codex-home";
    let appPage = 0;
    const process = new FakeProcess((message, target) => {
      if (message.method === "initialize") {
        target.respond({ id: message.id, result: { userAgent: "codex-cli/0.153.2", codexHome, platformFamily: "unix", platformOs: "macos" } });
      } else if (message.method === "model/list" || message.method === "experimentalFeature/list" || message.method === "permissionProfile/list") {
        target.respond({ id: message.id, result: { data: [], nextCursor: null } });
      } else if (message.method === "app/list") {
        appPage += 1;
        target.respond({
          id: message.id,
          result: { data: [], nextCursor: `apps-page-${String(appPage + 1)}` },
        });
      }
    });
    const client = createClient({
      process,
      authority: codexAuthority(1),
      expectedCodexHome: codexHome,
      experimentalApi: true,
      isAuthorityCurrent: () => true,
    });
    await client.initialize();

    await expect(client.discoverCapabilities({ includeExperimental: true })).rejects.toMatchObject({
      code: "PROTOCOL_LIMIT",
      message: "app/list exceeded its page limit",
    });
    const appRequests = process.writes.filter((frame) =>
      (frame as { method?: unknown }).method === "app/list");
    expect(appRequests).toHaveLength(50);
    expect(appRequests[49]).toEqual({
      id: 55,
      method: "app/list",
      params: { limit: 100, forceRefetch: false, cursor: "apps-page-50" },
    });
    await client.close();
  });

  test("fails closed when app pagination exceeds 5,000 aggregate items", async () => {
    const codexHome = "/tmp/hra-control-plane/profile-a/codex-home";
    let appPage = 0;
    const process = new FakeProcess((message, target) => {
      if (message.method === "initialize") {
        target.respond({ id: message.id, result: { userAgent: "codex-cli/0.153.2", codexHome, platformFamily: "unix", platformOs: "macos" } });
      } else if (message.method === "model/list" || message.method === "experimentalFeature/list" || message.method === "permissionProfile/list") {
        target.respond({ id: message.id, result: { data: [], nextCursor: null } });
      } else if (message.method === "app/list") {
        appPage += 1;
        target.respond({
          id: message.id,
          result: {
            data: Array.from(
              { length: 1_000 },
              (_, index) => appFixture(`app-${String(appPage)}-${String(index)}`),
            ),
            nextCursor: `apps-page-${String(appPage + 1)}`,
          },
        });
      }
    });
    const client = createClient({
      process,
      authority: codexAuthority(1),
      expectedCodexHome: codexHome,
      experimentalApi: true,
      isAuthorityCurrent: () => true,
    });
    await client.initialize();

    await expect(client.discoverCapabilities({ includeExperimental: true })).rejects.toMatchObject({
      code: "PROTOCOL_LIMIT",
      message: "app/list exceeded its item limit",
    });
    const appRequests = process.writes.filter((frame) =>
      (frame as { method?: unknown }).method === "app/list");
    expect(appRequests).toHaveLength(6);
    await client.close();
  });

  test("keeps non-app capability discovery at the 20-page limit", async () => {
    const codexHome = "/tmp/hra-control-plane/profile-a/codex-home";
    let modelPage = 0;
    const process = new FakeProcess((message, target) => {
      if (message.method === "initialize") {
        target.respond({ id: message.id, result: { userAgent: "codex-cli/0.153.2", codexHome, platformFamily: "unix", platformOs: "macos" } });
      } else if (message.method === "model/list") {
        modelPage += 1;
        target.respond({
          id: message.id,
          result: { data: [], nextCursor: `models-page-${String(modelPage + 1)}` },
        });
      }
    });
    const client = createClient({
      process,
      authority: codexAuthority(1),
      expectedCodexHome: codexHome,
      isAuthorityCurrent: () => true,
    });
    await client.initialize();

    await expect(client.discoverCapabilities()).rejects.toMatchObject({
      code: "PROTOCOL_LIMIT",
      message: "model/list exceeded its page limit",
    });
    const modelRequests = process.writes.filter((frame) =>
      (frame as { method?: unknown }).method === "model/list");
    expect(modelRequests).toHaveLength(20);
    expect(modelRequests[19]).toEqual({
      id: 22,
      method: "model/list",
      params: { includeHidden: true, limit: 100, cursor: "models-page-20" },
    });
    await client.close();
  });

  test("rejects a repeated app cursor after the one-shot refresh", async () => {
    const codexHome = "/tmp/hra-control-plane/profile-a/codex-home";
    const process = new FakeProcess((message, target) => {
      if (message.method === "initialize") {
        target.respond({ id: message.id, result: { userAgent: "codex-cli/0.153.2", codexHome, platformFamily: "unix", platformOs: "macos" } });
      } else if (message.method === "model/list" || message.method === "experimentalFeature/list" || message.method === "permissionProfile/list") {
        target.respond({ id: message.id, result: { data: [], nextCursor: null } });
      } else if (message.method === "app/list") {
        target.respond({ id: message.id, result: { data: [], nextCursor: "repeated" } });
      }
    });
    const client = createClient({
      process,
      authority: codexAuthority(1),
      expectedCodexHome: codexHome,
      experimentalApi: true,
      isAuthorityCurrent: () => true,
    });
    await client.initialize();

    await expect(client.discoverCapabilities({ includeExperimental: true })).rejects.toMatchObject({
      code: "PROTOCOL_ERROR",
      message: "app/list repeated a cursor",
    });
    expect(process.writes.slice(-2)).toEqual([
      {
        id: 6,
        method: "app/list",
        params: { limit: 100, forceRefetch: true, cursor: null },
      },
      {
        id: 7,
        method: "app/list",
        params: { limit: 100, forceRefetch: false, cursor: "repeated" },
      },
    ]);
    await client.close();
  });

  test("discovers plugins through the read-only pinned method and never sends a lifecycle effect", async () => {
    const codexHome = "/tmp/hra-control-plane/profile-a/codex-home";
    const process = new FakeProcess((message, target) => {
      if (message.method === "initialize") {
        target.respond({ id: message.id, result: { userAgent: "codex-cli/0.153.2", codexHome, platformFamily: "unix", platformOs: "macos" } });
      } else if (message.method === "plugin/list") {
        target.respond({
          id: message.id,
          result: {
            marketplaces: [{
              name: "official",
              path: null,
              interface: null,
              plugins: [{
                id: "files@official",
                remotePluginId: null,
                version: null,
                localVersion: null,
                name: "files",
                shareContext: null,
                source: { type: "remote" },
                installed: false,
                installedAt: null,
                enabled: false,
                installPolicy: "AVAILABLE",
                installPolicySource: null,
                mustShowInstallationInterstitial: null,
                authPolicy: "ON_USE",
                availability: "AVAILABLE",
                disabledReason: null,
                eligiblePlanTypes: null,
                interface: null,
                keywords: [],
              }],
            }],
            marketplaceLoadErrors: [],
            featuredPluginIds: [],
          },
        });
      }
    });
    const client = createClient({
      process,
      authority: codexAuthority(1),
      expectedCodexHome: codexHome,
      experimentalApi: true,
      isAuthorityCurrent: () => true,
    });
    await client.initialize();
    expect((await client.listPlugins({ cwd: "/workspace/project", forceRefetch: true })).value)
      .toMatchObject({ marketplaces: [{ plugins: [{ id: "files@official" }] }] });
    expect(process.writes.slice(3)).toEqual([{
      id: 3,
      method: "plugin/list",
      params: { cwds: ["/workspace/project"], forceRefetch: true },
    }]);
    const methods = process.writes.map((frame) =>
      typeof frame === "object" && frame !== null && "method" in frame
        ? frame.method
        : undefined);
    expect(methods).not.toContain("plugin/install");
    expect(methods).not.toContain("plugin/enable");
    expect(methods).not.toContain("plugin/disable");
    expect(methods).not.toContain("mcpServer/oauth/login");
    await client.close();
  });

  test("sends exact pinned bounded turn and filtered item list parameters", async () => {
    const codexHome = "/tmp/hra-control-plane/profile-a/codex-home";
    let turnListCalls = 0;
    const process = new FakeProcess((message, target) => {
      if (message.method === "initialize") {
        target.respond({ id: message.id, result: { userAgent: "codex-cli/0.153.2", codexHome, platformFamily: "unix", platformOs: "macos" } });
      } else if (message.method === "thread/turns/list") {
        turnListCalls += 1;
        const turn = { id: "turn", items: [], status: "completed", startedAt: 1, completedAt: 2, durationMs: 1_000 };
        target.respond({ id: message.id, result: { data: turnListCalls === 1 ? [] : [turn, { ...turn, id: "turn-2" }], nextCursor: "older", backwardsCursor: "newer" } });
      } else if (message.method === "thread/items/list") {
        target.respond({ id: message.id, result: { data: [], nextCursor: null, backwardsCursor: "back" } });
      }
    });
    const client = createClient({
      process,
      authority: codexAuthority(1),
      expectedCodexHome: codexHome,
      experimentalApi: true,
      isAuthorityCurrent: () => true,
    });
    await client.initialize();
    await client.listThreadTurns({ threadId: "thread-1", cursor: "cursor", limit: 24, sortDirection: "desc", itemsView: "summary" });
    await client.listThreadItems({ threadId: "thread-1", turnId: "turn-1", cursor: null, limit: 64, sortDirection: "asc" });
    expect(process.writes.slice(3)).toEqual([
      { id: 3, method: "thread/turns/list", params: { threadId: "thread-1", cursor: "cursor", limit: 24, sortDirection: "desc", itemsView: "summary" } },
      { id: 4, method: "thread/items/list", params: { threadId: "thread-1", turnId: "turn-1", cursor: null, limit: 64, sortDirection: "asc" } },
    ]);
    await expect(client.listThreadTurns({ threadId: "thread-1", limit: 1 }))
      .rejects.toMatchObject({ code: "PROTOCOL_LIMIT" });
    await client.close();
  });

  test("fails closed on paginated history when experimental API was not negotiated", async () => {
    const process = successfulFake("/tmp/hra-control-plane/profile-a/codex-home");
    const client = createClient({
      process,
      authority: codexAuthority(1),
      expectedCodexHome: "/tmp/hra-control-plane/profile-a/codex-home",
      isAuthorityCurrent: () => true,
    });
    await client.initialize();
    await expect(client.listThreadTurns({ threadId: "thread-1", limit: 24 })).rejects.toMatchObject({ code: "UNSUPPORTED_CAPABILITY" });
    expect(process.writes).toHaveLength(3);
    await client.close();
  });

  test.each(["current", "historical_v1"] as const)("binds the exact workspace and %s host contract", async (hostCapabilities) => {
    const codexHome = "/tmp/hra-control-plane/profile-a/codex-home";
    const thread = {
      id: "thread-1",
      sessionId: "thread-1",
      preview: "",
      ephemeral: false,
      historyMode: "paginated",
      modelProvider: "openai",
      createdAt: 1,
      updatedAt: 1,
      status: { type: "idle" },
      cwd: "/workspace/project",
      name: null,
      turns: [],
    };
    const process = new FakeProcess((message, target) => {
      if (message.method === "initialize") {
        target.respond({ id: message.id, result: { userAgent: "codex-cli/0.153.2", codexHome, platformFamily: "unix", platformOs: "macos" } });
      } else if (message.method === "thread/start") {
        target.respond({
          id: message.id,
          result: {
            thread,
            cwd: "/workspace/project",
            model: "gpt-5.6-sol",
            modelProvider: "openai",
            reasoningEffort: "max",
            serviceTier: "default",
            approvalPolicy: "on-request",
            approvalsReviewer: "auto_review",
            sandbox: { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
            activePermissionProfile: { id: ":workspace", extends: null },
            runtimeWorkspaceRoots: ["/workspace/project"],
          },
        });
      }
    });
    const client = createClient({
      process,
      authority: codexAuthority(1),
      expectedCodexHome: codexHome,
      experimentalApi: true,
      isAuthorityCurrent: () => true,
      onOompaHostToolCall: async () => ({ scope: "conversation" }),
      onOompaHostToolResponseWritten: () => undefined,
    });
    await client.initialize();
    const request = {
      cwd: "/workspace/project",
      ...(hostCapabilities === "historical_v1"
        ? { hostCapabilities }
        : { developerInstructions: "Static Oompa preamble." }),
      preset: { alias: "high", model: "gpt-5.6-sol", effort: "max", serviceTier: null, fast: false },
      policy: { review: "auto_review", permissionProfile: ":workspace", writableRoots: ["/workspace/project"] },
    } as const;
    for (const invalid of [
      { ...request, hostCapabilities: "disabled" },
      { ...request, hostCapabilities: "historical_v1", developerInstructions: "Do not upgrade historical authority." },
      { ...request, hostCapabilities: "historical_v1", developerInstructions: undefined },
    ]) {
      await expect(client.startThread(invalid as unknown as Parameters<CodexAppServerClient["startThread"]>[0]))
        .rejects.toMatchObject({ code: "INVALID_INPUT" });
    }
    expect(process.writes.filter((frame) => (frame as { method?: unknown }).method === "thread/start")).toEqual([]);
    const result = await client.startThread(request);
    expect(result.value.activePermissionProfile?.id).toBe(":workspace");
    expect(process.writes.at(-1)).toEqual({
      id: 3,
      method: "thread/start",
      params: {
        model: "gpt-5.6-sol",
        serviceTier: null,
        cwd: "/workspace/project",
        permissions: ":workspace",
        runtimeWorkspaceRoots: ["/workspace/project"],
        approvalPolicy: "on-request",
        approvalsReviewer: "auto_review",
        config: { model_reasoning_effort: "max" },
        ...(hostCapabilities === "historical_v1" ? {} : { developerInstructions: "Static Oompa preamble." }),
        ephemeral: false,
        historyMode: "paginated",
        dynamicTools: hostCapabilities === "historical_v1"
          ? OOMPA_CONVERSATION_AUTOMATION_DYNAMIC_TOOLS : OOMPA_HOST_DYNAMIC_TOOLS,
      },
    });
    await client.close();
  });

  test("classifies a thread response with a broader sandbox root as indeterminate", async () => {
    const codexHome = "/tmp/hra-control-plane/profile-a/codex-home";
    const process = new FakeProcess((message, target) => {
      if (message.method === "initialize") {
        target.respond({ id: message.id, result: { userAgent: "codex-cli/0.153.2", codexHome, platformFamily: "unix", platformOs: "macos" } });
      } else if (message.method === "thread/start") {
        target.respond({ id: message.id, result: {
          thread: { id: "thread-unsafe", sessionId: "thread-unsafe", preview: "", ephemeral: false, historyMode: "paginated", modelProvider: "openai", createdAt: 1, updatedAt: 1, status: { type: "idle" }, cwd: "/workspace/project", name: null, turns: [] },
          cwd: "/workspace/project",
          model: "gpt-5.6-sol",
          modelProvider: "openai",
          reasoningEffort: "max",
          serviceTier: "default",
          approvalPolicy: "on-request",
          approvalsReviewer: "auto_review",
          sandbox: { type: "workspaceWrite", writableRoots: ["/"], networkAccess: false },
          activePermissionProfile: { id: ":workspace", extends: null },
          runtimeWorkspaceRoots: ["/workspace/project"],
        } });
      }
    });
    const client = createClient({
      process,
      authority: codexAuthority(1),
      expectedCodexHome: codexHome,
      experimentalApi: true,
      isAuthorityCurrent: () => true,
      onConversationAutomationToolCall: async () => ({ scope: "conversation" }),
      onConversationAutomationToolResponseWritten: () => undefined,
    });
    await client.initialize();
    await expect(client.startThread({
      cwd: "/workspace/project",
      developerInstructions: "Static Oompa preamble.",
      preset: { alias: "high", model: "gpt-5.6-sol", effort: "max", serviceTier: null, fast: false },
      policy: { review: "auto_review", permissionProfile: ":workspace", writableRoots: ["/workspace/project"] },
    })).rejects.toMatchObject({ code: "INDETERMINATE_EFFECT", operation: "thread/start" });
    await client.close();
  });

  test("does not retrofit dynamic tools onto legacy resumed threads", async () => {
    const codexHome = "/tmp/hra-control-plane/profile-a/codex-home";
    const process = new FakeProcess((message, target) => {
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
      } else if (message.method === "thread/resume") {
        target.respond({
          id: message.id,
          result: {
            thread: {
              id: "thread-legacy",
              sessionId: "thread-legacy",
              preview: "",
              ephemeral: false,
              historyMode: "paginated",
              modelProvider: "openai",
              createdAt: 1,
              updatedAt: 1,
              status: { type: "idle" },
              cwd: "/workspace/project",
              name: null,
              turns: [],
            },
          },
        });
      }
    });
    const client = createClient({
      process,
      authority: codexAuthority(1),
      expectedCodexHome: codexHome,
      experimentalApi: true,
      isAuthorityCurrent: () => true,
      onConversationAutomationToolCall: async () => ({ scope: "conversation" }),
      onConversationAutomationToolResponseWritten: () => undefined,
    });
    await client.initialize();
    await client.resumeThread("thread-legacy", "Static Oompa preamble.");
    expect(process.writes.at(-1)).toEqual({
      id: 3,
      method: "thread/resume",
      params: {
        threadId: "thread-legacy",
        developerInstructions: "Static Oompa preamble.",
      },
    });
    await client.resumeThread("thread-legacy");
    expect(process.writes.at(-1)).toEqual({
      id: 4,
      method: "thread/resume",
      params: { threadId: "thread-legacy" },
    });
    await client.close();
  });

  test("applies and verifies native approval authority when claiming a resumed thread", async () => {
    const codexHome = "/tmp/hra-control-plane/profile-a/codex-home";
    const thread = {
      id: "thread-adopted",
      sessionId: "thread-adopted",
      preview: "",
      ephemeral: false,
      historyMode: "paginated",
      modelProvider: "openai",
      createdAt: 1,
      updatedAt: 1,
      status: { type: "idle" },
      cwd: "/workspace/project",
      name: null,
      turns: [],
    };
    const process = new FakeProcess((message, target) => {
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
      } else if (message.method === "thread/resume") {
        target.respond({
          id: message.id,
          result: {
            thread,
            cwd: "/workspace/project",
            model: "gpt-5.6-sol",
            modelProvider: "openai",
            reasoningEffort: "max",
            serviceTier: "default",
            approvalPolicy: "on-request",
            approvalsReviewer: "auto_review",
            sandbox: {
              type: "workspaceWrite",
              writableRoots: ["/workspace/project"],
              networkAccess: false,
              excludeTmpdirEnvVar: false,
              excludeSlashTmp: false,
            },
            activePermissionProfile: { id: ":workspace", extends: null },
            runtimeWorkspaceRoots: ["/workspace/project"],
          },
        });
      }
    });
    const client = createClient({
      process,
      authority: codexAuthority(1),
      expectedCodexHome: codexHome,
      isAuthorityCurrent: () => true,
    });
    await client.initialize();
    await client.resumeThreadWithPolicy({
      threadId: "thread-adopted",
      cwd: "/workspace/project",
      developerInstructions: "Keep this adopted thread within its reviewed policy.",
      preset: {
        alias: "high",
        model: "gpt-5.6-sol",
        effort: "max",
        serviceTier: null,
        fast: false,
      },
      policy: {
        review: "auto_review",
        permissionProfile: ":workspace",
        writableRoots: ["/workspace/project"],
      },
    });
    expect(process.writes.at(-1)).toEqual({
      id: 3,
      method: "thread/resume",
      params: {
        threadId: "thread-adopted",
        model: "gpt-5.6-sol",
        serviceTier: null,
        cwd: "/workspace/project",
        permissions: ":workspace",
        runtimeWorkspaceRoots: ["/workspace/project"],
        approvalPolicy: "on-request",
        approvalsReviewer: "auto_review",
        config: { model_reasoning_effort: "max" },
        excludeTurns: true,
      },
    });
    expect(JSON.stringify(process.writes.at(-1))).not.toContain("dynamicTools");
    await client.close();
  });

  test("sends the exact pinned thread unsubscribe request and returns its closed status", async () => {
    const codexHome = "/tmp/hra-control-plane/profile-a/codex-home";
    const process = new FakeProcess((message, target) => {
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
      } else if (message.method === "thread/unsubscribe") {
        target.respond({ id: message.id, result: { status: "unsubscribed" } });
      }
    });
    const client = createClient({
      process,
      authority: codexAuthority(1),
      expectedCodexHome: codexHome,
      isAuthorityCurrent: () => true,
    });
    await client.initialize();

    await expect(client.unsubscribeThread("thread-adopted")).resolves.toMatchObject({
      authority: codexAuthority(1),
      value: { status: "unsubscribed" },
    });
    expect(process.writes.at(-1)).toEqual({
      id: 3,
      method: "thread/unsubscribe",
      params: { threadId: "thread-adopted" },
    });
    await client.close();
  });

  test("sends the exact pinned thread compaction request and returns the empty result", async () => {
    const codexHome = "/tmp/hra-control-plane/profile-a/codex-home";
    const process = new FakeProcess((message, target) => {
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
      } else if (message.method === "thread/compact/start") {
        target.respond({ id: message.id, result: {} });
      }
    });
    const client = createClient({
      process,
      authority: codexAuthority(1),
      expectedCodexHome: codexHome,
      isAuthorityCurrent: () => true,
    });
    await client.initialize();

    await expect(client.compactThread("thread-live")).resolves.toMatchObject({
      authority: codexAuthority(1),
      value: {},
    });
    expect(process.writes.at(-1)).toEqual({
      id: 3,
      method: "thread/compact/start",
      params: { threadId: "thread-live" },
    });
    await expect(client.compactThread("")).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(client.compactThread("x".repeat(513))).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await client.close();
  });

  test("keeps a dispatched thread compaction indeterminate when its response deadline expires", async () => {
    const codexHome = "/tmp/hra-control-plane/profile-a/codex-home";
    const compactionWritten = deferred<undefined>();
    const process = new FakeProcess((message, target) => {
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
      } else if (message.method === "thread/compact/start") {
        compactionWritten.resolve(undefined);
      }
    });
    const client = createClient({
      process,
      authority: codexAuthority(1),
      expectedCodexHome: codexHome,
      isAuthorityCurrent: () => true,
    });
    await client.initialize();

    jest.useFakeTimers();
    try {
      const mutation = client.compactThread("thread-1");
      await compactionWritten.promise;
      jest.advanceTimersByTime(30_000);

      await expect(mutation).rejects.toMatchObject({
        code: "INDETERMINATE_EFFECT",
        operation: "thread/compact/start",
      });
      expect(process.writes.filter((frame) =>
        (frame as { method?: unknown }).method === "thread/compact/start")).toHaveLength(1);
    } finally {
      jest.useRealTimers();
    }

    await client.close();
  });

  test("routes a compacted notification as a bounded thread fact", async () => {
    const codexHome = "/tmp/hra-control-plane/profile-a/codex-home";
    const process = successfulFake(codexHome);
    const facts: CodexFact[] = [];
    const client = createClient({
      process,
      authority: codexAuthority(1),
      expectedCodexHome: codexHome,
      isAuthorityCurrent: () => true,
      connectionId: CONNECTION_ID,
      onFact: ({ value }) => { facts.push(value); },
    });
    await client.initialize();

    process.respond({
      method: "thread/compacted",
      params: { threadId: "thread-1", turnId: "turn-7", payload: "discarded" },
    });
    await waitFor(() => facts.some((fact) => fact.type === "threadCompaction"));
    expect(facts.filter((fact) => fact.type === "threadCompaction")).toEqual([{
      type: "threadCompaction",
      threadId: "thread-1",
      turnId: "turn-7",
      outcome: "completed",
      connectionId: CONNECTION_ID,
    }]);
    await client.close();
  });

  test("bounds shutdown when TERM and stdout settlement are ignored", async () => {
    const codexHome = "/tmp/hra-control-plane/profile-a/codex-home";
    const process = new FakeProcess(
      (message, target) => {
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
        }
      },
      { ignoreTerm: true, leaveStreamsOpenAfterKill: true },
    );
    const diagnostics: string[] = [];
    const client = createClient({
      process,
      authority: codexAuthority(3),
      expectedCodexHome: codexHome,
      isAuthorityCurrent: () => true,
      onSafeDiagnostic: (message) => diagnostics.push(message),
      shutdownTermGraceMs: 5,
      shutdownSettlementMs: 5,
    });
    await client.initialize();
    const mutation = client.renameThread("thread-1", "renamed").then(
      () => null,
      (caught: unknown) => caught,
    );
    await Bun.sleep(1);

    const closeOutcome = await Promise.race([
      Promise.all([client.close(), client.close()]).then(() => "closed" as const),
      Bun.sleep(500).then(() => "timed-out" as const),
    ]);
    const mutationError = await mutation;

    expect(closeOutcome).toBe("closed");
    expect(client.state).toBe("closed");
    expect(process.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(mutationError).toMatchObject({
      code: "INDETERMINATE_EFFECT",
      operation: "thread/name/set",
    });
    expect(diagnostics).toContain("Codex stdout did not settle after termination");
  });

  test("requires exact process-exit settlement and permits the exact close owner to retry", async () => {
    const codexHome = "/tmp/hra-control-plane/profile-a/codex-home";
    const process = new FakeProcess(
      (message, target) => {
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
        }
      },
      { ignoreKill: true, ignoreTerm: true, leaveStreamsOpenAfterKill: true },
    );
    const diagnostics: string[] = [];
    const client = createClient({
      process,
      authority: codexAuthority(3),
      expectedCodexHome: codexHome,
      isAuthorityCurrent: () => true,
      onSafeDiagnostic: (message) => diagnostics.push(message),
      shutdownTermGraceMs: 5,
      shutdownSettlementMs: 5,
    });
    await client.initialize();

    await expect(Promise.all([client.close(), client.close()])).rejects.toMatchObject({
      code: "PROCESS_EXITED",
    });
    expect(client.state).toBe("closing");
    expect(process.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(diagnostics).toContain("Codex process exit did not settle after termination");

    process.settleExit();
    await expect(client.close()).resolves.toBeUndefined();
    expect(client.state).toBe("closed");
    expect(process.signals).toEqual(["SIGTERM", "SIGKILL", "SIGTERM"]);
  });
});

test("closed Codex scope stops late stderr diagnostics without reporting normal interruption as failure", async () => {
  const codexHome = "/tmp/hra-control-plane/profile-a/codex-home";
  const diagnostics: string[] = [];
  const process = new FakeProcess((message, target) => {
    if (message.method === "initialize") {
      target.respond({ id: message.id, result: {
        userAgent: "codex-cli/0.153.2", codexHome, platformFamily: "unix", platformOs: "macos",
      } });
    }
  }, { ignoreTerm: true, leaveStreamsOpenAfterKill: true });
  const client = createClient({
    process,
    authority: codexAuthority(1),
    expectedCodexHome: codexHome,
    isAuthorityCurrent: () => true,
    onSafeDiagnostic: message => { diagnostics.push(message); },
    shutdownTermGraceMs: 5,
    shutdownSettlementMs: 5,
  });
  try {
    await client.initialize();
    process.stderrQueue.push("before");
    await waitFor(() => diagnostics.includes("Codex wrote 6 bytes to stderr"));
    await client.close();
    expect(client.state).toBe("closed");
    const completedDiagnostics = [...diagnostics];
    process.stderrQueue.push("late");
    await Bun.sleep(5);
    expect(diagnostics).toEqual(completedDiagnostics);
    expect(diagnostics).not.toContain("Codex stderr closed unexpectedly");
  } finally {
    process.stdoutQueue.close();
    process.stderrQueue.close();
    await client.close();
  }
});
