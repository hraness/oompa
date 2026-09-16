import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ClaudeHostToolBindingAuthority,
  type ClaudeProcess,
  type ClaudeProcessIdentity,
  type PinnedClaudeRuntime,
} from "../claude/index";
import {
  CLAUDE_PIN,
  CLAUDE_PIN_EFFORT,
  CLAUDE_PIN_MODEL,
  CLAUDE_PIN_NATIVE_FALLBACK_CAPABILITY,
} from "../claude/pin";
import { LiveBatcher } from "../cloud/live-uploader";
import type { SessionEvent } from "../domain/session-events";
import { initializeStatePaths, resolveStatePaths } from "../storage/paths";
import { StateStore } from "../storage/state-store";
import { PinnedClaudeRuntimeManager } from "./claude-runtime-adapter";
import {
  UnavailableCloudControl,
  type CloudControlPort,
  type CodexAccountProjection,
  type CodexLoginOutcome,
  type CodexRuntimePort,
  type CompactProjectionRecoveryBlocker,
} from "./ports";
import { OompaService } from "./service";

const signal = new AbortController().signal;
const PROVIDER_USAGE_PERSISTENCE_QUEUE_LIMIT = 1_024;

/**
 * The exact `system/init`, `assistant`, `control_request`, `rate_limit_event`,
 * and `result` lines captured on the pinned build
 * (`docs/providers/claude-fixtures/`), trimmed to the fields the pinned parser
 * reads. Nothing here shells out to a real `claude` binary.
 */
const FIXTURE_SESSION_ID = "726b1b3d-ed97-4b55-9904-e58fa7d7eb45";

const initLine = {
  claude_code_version: CLAUDE_PIN,
  cwd: "<redacted-abs-path>",
  model: CLAUDE_PIN_MODEL,
  permissionMode: "default",
  session_id: FIXTURE_SESSION_ID,
  subtype: "init",
  type: "system",
};

const assistantLine = (text: string, messageId: string) => ({
  message: {
    content: [{ text, type: "text" }],
    id: messageId,
    model: CLAUDE_PIN_MODEL,
    role: "assistant",
    type: "message",
  },
  parent_tool_use_id: null,
  session_id: FIXTURE_SESSION_ID,
  type: "assistant",
});

const approvalRequestLine = (requestId: string) => ({
  request: {
    description: "Fetch HTTP status line from example.com",
    display_name: "Bash",
    input: {
      command: "curl -sI https://example.com | head -n 1",
      description: "Fetch HTTP status line from example.com",
    },
    subtype: "can_use_tool",
    tool_name: "Bash",
    tool_use_id: "toolu_01DS65QaNoiWEyuRBSzMgdvT",
  },
  request_id: requestId,
  type: "control_request",
});

const questionRequestLine = (requestId: string) => ({
  request: {
    display_name: "AskUserQuestion",
    input: {
      questions: [{
        header: "Indent",
        multiSelect: false,
        options: [
          { description: "Indent with tab characters", label: "tabs" },
          { description: "Indent with space characters", label: "spaces" },
        ],
        question: "Tabs or spaces?",
      }],
    },
    requires_user_interaction: true,
    subtype: "can_use_tool",
    tool_name: "AskUserQuestion",
    tool_use_id: "toolu_01KwcabGeec89hY4gzV1wBgf",
  },
  request_id: requestId,
  type: "control_request",
});

const subagentStartedLine = {
  description: "Read README first line",
  is_backgrounded: false,
  session_id: FIXTURE_SESSION_ID,
  spawn_depth: 1,
  subagent_type: "Explore",
  subtype: "task_started",
  task_id: "a5fb5e66c43a1adcd",
  task_type: "local_agent",
  tool_use_id: "toolu_01RNa8dUfBrdgn5ocMFVqkSN",
  type: "system",
};

const rateLimitLine = (uuid: string, utilization = 0.5) => ({
  rate_limit_info: {
    isUsingOverage: false,
    overageDisabledReason: "org_level_disabled",
    overageStatus: "rejected",
    rateLimitType: "five_hour",
    resetsAt: 1_788_499_800,
    status: "allowed",
    unifiedWindows: {
      five_hour: { resetsAt: 1_788_499_800, utilization },
    },
  },
  session_id: FIXTURE_SESSION_ID,
  type: "rate_limit_event",
  uuid,
});

const resultLine = (resultText: string) => ({
  duration_ms: 2_374,
  is_error: false,
  modelUsage: {
    [CLAUDE_PIN_MODEL]: {
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 10_123,
      canonicalModel: CLAUDE_PIN_MODEL,
      contextWindow: 1_000_000,
      costUSD: 0.2,
      inputTokens: 2,
      maxOutputTokens: 64_000,
      outputTokens: 4,
      thinkingTokens: 0,
    },
  },
  num_turns: 1,
  result: resultText,
  session_id: FIXTURE_SESSION_ID,
  stop_reason: "end_turn",
  subtype: "success",
  terminal_reason: "completed",
  total_cost_usd: 0.2,
  type: "result",
  usage: {
    cache_read_input_tokens: 10_123,
    input_tokens: 2,
    output_tokens: 4,
  },
  uuid: "48c87f50-1645-4f71-a091-4949d337eb87",
});

const pinnedRuntime: PinnedClaudeRuntime = {
  argv: ["/opt/oompa/bin/claude", "--print"],
  effort: CLAUDE_PIN_EFFORT,
  executablePath: "/opt/oompa/bin/claude",
  model: CLAUDE_PIN_MODEL,
  nativeFallback: CLAUDE_PIN_NATIVE_FALLBACK_CAPABILITY,
  version: CLAUDE_PIN,
};

class FakeClaudeProcess implements ClaudeProcess {
  readonly identity: Promise<ClaudeProcessIdentity>;
  readonly written: string[] = [];
  readonly exited: Promise<number>;
  readonly stdout: AsyncIterable<Uint8Array>;
  readonly stderr: AsyncIterable<Uint8Array> = {
    async *[Symbol.asyncIterator]() { /* silent */ },
  };
  beforeWriteReturn: ((line: string) => Promise<void> | void) | undefined;
  afterStdoutChunkRead: (() => void) | undefined;
  terminated = false;
  onTerminate: (() => void) | undefined;
  #push: ((chunk: Uint8Array) => void) | undefined;
  #finish: (() => void) | undefined;
  #resolveExit: ((code: number) => void) | undefined;

  constructor(readonly providerThreadId: string, pid: number) {
    this.identity = Promise.resolve(Object.freeze({
      pid,
      pidDomain: "darwin",
      procStart: "Fri Sep  4 12:00:00 2026",
    }));
    this.exited = new Promise((resolve) => { this.#resolveExit = resolve; });
    const queue: Uint8Array[] = [];
    let waiter: (() => void) | undefined;
    let done = false;
    this.#push = (chunk) => { queue.push(chunk); waiter?.(); waiter = undefined; };
    this.#finish = () => { done = true; waiter?.(); waiter = undefined; };
    const chunkRead = (): void => { this.afterStdoutChunkRead?.(); };
    this.stdout = {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          const chunk = queue.shift();
          if (chunk !== undefined) { yield chunk; chunkRead(); continue; }
          if (done) return;
          await new Promise<void>((resolve) => { waiter = resolve; });
        }
      },
    };
  }

  emit(...lines: readonly Readonly<Record<string, unknown>>[]): void {
    this.#push?.(new TextEncoder().encode(
      // Captured wire templates use one redacted session ID. Render that
      // placeholder for this exact launched process, never another live thread.
      lines.map((line) => `${JSON.stringify(line.session_id === FIXTURE_SESSION_ID
        ? { ...line, session_id: this.providerThreadId } : line)}\n`).join(""),
    ));
  }

  async write(bytes: Uint8Array): Promise<void> {
    const line = new TextDecoder().decode(bytes);
    this.written.push(line);
    await this.beforeWriteReturn?.(line);
  }

  terminate(): void {
    this.terminated = true;
    this.onTerminate?.();
    this.#finish?.();
    this.#resolveExit?.(0);
  }

  forceTerminate(): void { this.terminate(); }
}

/** The Codex seam a Claude-only fixture still needs for account sign-in. */
class SignInOnlyCodex implements CodexRuntimePort {
  readonly provider = "codex" as const;
  discardRuntimeReview(): void {}
  #unsupported(): never {
    throw new Error("This fixture drives the Claude provider only.");
  }
  async login(): Promise<CodexLoginOutcome> {
    return { account: { email: "person@example.com", signedIn: true }, status: "signed_in" };
  }
  async readAccount(): Promise<CodexAccountProjection> {
    return { email: "person@example.com", signedIn: true };
  }
  async releaseOwnedAuthority(): Promise<void> {}
  async logout(): Promise<void> {}
  async close(): Promise<void> {}
  cancelLogin(): Promise<never> { return Promise.reject(this.#unsupported()); }
  readUsage(): Promise<never> { return Promise.reject(this.#unsupported()); }
  consumeRateLimitReset(): Promise<never> { return Promise.reject(this.#unsupported()); }
  listPlugins(): Promise<never> { return Promise.reject(this.#unsupported()); }
  listSessions(): Promise<never> { return Promise.reject(this.#unsupported()); }
  reviewSessionStart(): Promise<never> { return Promise.reject(this.#unsupported()); }
  startSession(): Promise<never> { return Promise.reject(this.#unsupported()); }
  observeSession(): Promise<never> { return Promise.reject(this.#unsupported()); }
  readSession(): Promise<never> { return Promise.reject(this.#unsupported()); }
  endSession(): Promise<void> { return Promise.resolve(); }
  reviewTurnStart(): Promise<never> { return Promise.reject(this.#unsupported()); }
  startTurn(): Promise<never> { return Promise.reject(this.#unsupported()); }
  steer(): Promise<never> { return Promise.reject(this.#unsupported()); }
  interrupt(): Promise<never> { return Promise.reject(this.#unsupported()); }
  compact(): Promise<never> { return Promise.reject(this.#unsupported()); }
  rename(): Promise<never> { return Promise.reject(this.#unsupported()); }
  inspectTurn(): Promise<never> { return Promise.reject(this.#unsupported()); }
  inspectInteractionAuthority(): Promise<never> { return Promise.reject(this.#unsupported()); }
  validateInteractionResolution(): Promise<never> { return Promise.reject(this.#unsupported()); }
  resolveInteraction(): Promise<never> { return Promise.reject(this.#unsupported()); }
  validateInteractionTimeout(): Promise<never> { return Promise.reject(this.#unsupported()); }
  timeoutInteraction(): Promise<never> { return Promise.reject(this.#unsupported()); }
}

class OfflineCloud extends UnavailableCloudControl {
  constructor(beforeProjectionRecoveryCheck?: () => Promise<void>) {
    super({
      isCompactProjectionRecoveryUnsettled: async () => {
        await beforeProjectionRecoveryCheck?.();
        return false;
      },
      isCompactProjectionRecoveryUnsettledForProfile: async () => false,
      supersedeCompactProjectionRecoveryForProviderDeletion: async () => ({ superseded: false }),
      supersedeTerminalCompactProjectionRecoveries: async () => ({ superseded: 0 }),
    } satisfies CompactProjectionRecoveryBlocker as CompactProjectionRecoveryBlocker);
  }
}

const stores: StateStore[] = [];
const roots: string[] = [];
const services: OompaService[] = [];
const hostToolAuthorities: ClaudeHostToolBindingAuthority[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map(async (service) => { await service.close(); }));
  await Promise.all(hostToolAuthorities.splice(0).map(async (authority) => { await authority.close(); }));
  for (const store of stores.splice(0)) store.close();
  await Promise.all(roots.splice(0).map(async (root) => rm(root, { force: true, recursive: true })));
});

type ClaudeFixture = Readonly<{
  service: OompaService;
  runtime: PinnedClaudeRuntimeManager;
  store: StateStore;
  cloud: CloudControlPort;
  documents: string;
  paths: ReturnType<typeof resolveStatePaths>;
  processes: FakeClaudeProcess[];
}>;

async function claudeFixture(
  options: Readonly<{
    beforeProjectionRecoveryCheck?: () => Promise<void>;
    daemonAuthority?: ConstructorParameters<typeof OompaService>[0]["daemonAuthority"];
    immediatelyEndProcess?: boolean;
    now?: () => number;
    onFactObserved?: (fact: Readonly<{ type: string }>) => void;
    claudeSignedIn?: boolean;
    resolveRuntime?: () => Promise<PinnedClaudeRuntime>;
  }> = {},
): Promise<ClaudeFixture> {
  const home = await realpath(await mkdtemp(join(tmpdir(), "oompa-claude-")));
  roots.push(home);
  const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
  const documents = join(home, "Documents");
  await mkdir(documents, { recursive: true });
  await initializeStatePaths(paths);
  const store = new StateStore(
    paths,
    options.now === undefined ? {} : { now: options.now },
  );
  stores.push(store);
  const daemonBootId = `boot_${crypto.randomUUID().replaceAll("-", "")}`;
  const daemonGeneration = store.nextDaemonGeneration(daemonBootId);
  // These tests drive every approval by hand.
  store.setDefaultApprovalMode("manual");
  const processes: FakeClaudeProcess[] = [];
  const reference: { current?: OompaService } = {};
  const hostToolAuthority = new ClaudeHostToolBindingAuthority();
  hostToolAuthorities.push(hostToolAuthority);
  const claude = new PinnedClaudeRuntimeManager({
    configHome: "isolated",
    configDirFor: () => join(home, "claude-config"),
    isCurrent: (authority) => {
      try {
        const profile = store.requireProfile(authority.id);
        const provider = store.requireProviderAccountAuthority(
          authority.id,
          authority.provider,
        );
        return profile.state !== "removed"
          && provider.profileId === authority.id
          && provider.provider === authority.provider
          && provider.providerAccountId === authority.providerAccountId
          && provider.bindingGeneration === authority.bindingGeneration
          && provider.processGeneration === authority.generation;
      } catch {
        return false;
      }
    },
    observer: {
      fact: async (authority, fact) => {
        await reference.current?.observeClaudeFact(authority, fact);
        options.onFactObserved?.(fact);
      },
    },
    hostTools: {
      bindingAuthority: hostToolAuthority,
      callbackSocketPath: join(paths.runtime, "claude-host-tools.sock"),
      privateRoot: paths.runtime,
    },
    processFactory: (launch) => {
      const providerThreadId = launch.argv.at(-1);
      if (providerThreadId === undefined) throw new Error("Expected a session-bound Claude argv.");
      const process = new FakeClaudeProcess(providerThreadId, 8_123 + processes.length);
      processes.push(process);
      if (options.immediatelyEndProcess === true) process.terminate();
      else {
        queueMicrotask(() => { process.emit({ ...initLine, session_id: providerThreadId }); });
      }
      return process;
    },
    readAuthStatus: async () => options.claudeSignedIn === false
      ? { signedIn: false }
      : {
          accountId: "claude-test-account",
          email: "claude-test@example.com",
          organizationId: "claude-test-organization",
          signedIn: true,
        },
    resolveRuntime: options.resolveRuntime ?? (async () => pinnedRuntime),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const cloud = new OfflineCloud(options.beforeProjectionRecoveryCheck);
  const service = new OompaService({
    claude,
    claudeProcessLiveness: async (identity) => {
      for (const process of processes) {
        const actual = await process.identity;
        if (actual.pid === identity.pid && actual.pidDomain === identity.pidDomain
          && actual.procStart === identity.procStart) {
          return process.terminated ? "not_live" : "live";
        }
      }
      return "unknown";
    },
    cloud,
    codex: new SignInOnlyCodex(),
    daemonAuthority: options.daemonAuthority ?? { assertCurrent: async () => {}, close: () => {} },
    daemonGeneration,
    daemonBootId,
    paths,
    platform: "linux",
    requestStop: () => undefined,
    store,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  reference.current = service;
  services.push(service);
  return { cloud, documents, paths, processes, runtime: claude, service, store };
}

async function authenticatedClaudeAccount(
  value: ClaudeFixture,
  label: string,
): Promise<`acct_${string}`> {
  const added = await value.service.execute(
    { kind: "account.add", label },
    { signal },
  ) as { account: { id: `acct_${string}` } };
  await value.service.execute(
    { kind: "project.add", label: `${label} project`, path: value.documents },
    { signal },
  );
  return added.account.id;
}

const settle = async (): Promise<void> => {
  for (let index = 0; index < 24; index += 1) await Promise.resolve();
  await new Promise((resolve) => { setTimeout(resolve, 2); });
};

const eventBodies = async (
  value: ClaudeFixture,
  sessionId: string,
): Promise<readonly Record<string, unknown>[]> => {
  const page = await value.service.execute(
    { kind: "session.events", limit: 200, session: sessionId, waitMs: 0 },
    { signal },
  ) as { events: readonly { body: Record<string, unknown> }[] };
  return page.events.map((event) => event.body);
};

describe("Claude sessions on the local authority", () => {
  test("keeps an unsettled Claude login bound while sibling Codex authority advances", async () => {
    const value = await claudeFixture({ claudeSignedIn: false });
    const account = await authenticatedClaudeAccount(value, "Claude login generation fence");
    const loginKey = crypto.randomUUID();
    const prepared = await value.service.execute({
      account,
      idempotencyKey: loginKey,
      kind: "account.claude-login.prepare",
    }, { signal }) as { login: { attemptId: string; providerGeneration: number } };
    const before = value.store.requireProfileById(account);
    const claudeBefore = value.store.requireProviderAccountAuthority(account, "claude");

    await expect(value.service.execute({
      account,
      deviceCode: true,
      idempotencyKey: crypto.randomUUID(),
      kind: "account.login",
    }, { signal })).resolves.toMatchObject({ account: { state: "signed_in" } });
    expect(value.store.requireProfileById(account).processGeneration).toBe(before.processGeneration + 1);
    expect(value.store.requireProviderAccountAuthority(account, "claude")).toEqual(claudeBefore);
    expect(value.store.readMutation(loginKey)).toMatchObject({
      id: prepared.login.attemptId,
      state: "effect_started",
    });

    const codex = value.store.requireProviderAccountAuthority(account, "codex");
    await value.service.observeCodexFact({
      bindingGeneration: codex.bindingGeneration,
      codexHome: "unused-codex-home",
      desktopUserData: "unused-desktop-home",
      generation: codex.processGeneration,
      id: codex.profileId,
      provider: "codex",
      providerAccountId: codex.providerAccountId,
    }, {
      connectionId: "21000000-0000-4000-8000-000000000002",
      reason: "eof",
      type: "providerDisconnected",
    });
    expect(value.store.requireProfileById(account).processGeneration).toBe(before.processGeneration + 2);
    expect(value.store.requireProviderAccountAuthority(account, "claude")).toEqual(claudeBefore);
    expect(value.store.readMutation(loginKey)).toMatchObject({ state: "effect_started" });
  });

  test("keeps an idle Claude session owned and usable across a Codex login generation change", async () => {
    const value = await claudeFixture();
    const account = await authenticatedClaudeAccount(value, "Claude survives Codex login");
    const started = await value.service.execute({
      account,
      fast: false,
      kind: "session.start",
      preset: "fable-max",
      provider: "claude",
    }, { signal }) as { session: { id: `sess_${string}` } };
    const process = value.processes[0];
    if (process === undefined) throw new Error("Expected one pinned Claude process.");
    await settle();

    const before = value.store.requireProfileById(account);
    const claudeBefore = value.store.requireProviderAccountAuthority(account, "claude");
    const capturedBefore = value.store.requireSessionProviderAuthority(started.session.id);
    expect(claudeBefore.processGeneration).not.toBe(before.processGeneration);
    expect(before.state).toBe("signed_out");
    const beforeLoginBodies = await eventBodies(value, started.session.id);
    await value.service.execute({
      account,
      deviceCode: false,
      idempotencyKey: crypto.randomUUID(),
      kind: "account.login",
    }, { signal });

    const after = value.store.requireProfileById(account);
    expect(after).toMatchObject({
      processGeneration: before.processGeneration + 1,
      state: "signed_in",
    });
    expect(value.processes).toEqual([process]);
    expect(process.terminated).toBe(false);
    expect(value.store.requireProviderAccountAuthority(account, "claude")).toEqual(claudeBefore);
    expect(value.store.requireSessionProviderAuthority(started.session.id)).toEqual(capturedBefore);
    const afterLoginBodies = await eventBodies(value, started.session.id);
    expect(afterLoginBodies.filter((body) =>
      (body.type === "gap" && body.reason === "provider_restart")
      || (body.type === "connection" && body.state === "resubscribed")))
      .toEqual(beforeLoginBodies.filter((body) =>
        (body.type === "gap" && body.reason === "provider_restart")
        || (body.type === "connection" && body.state === "resubscribed")));

    await value.service.execute({
      idempotencyKey: crypto.randomUUID(),
      kind: "session.send",
      message: "Keep working after the Codex login",
      session: started.session.id,
    }, { signal });
    const stopped = await value.service.execute({
      idempotencyKey: crypto.randomUUID(),
      kind: "session.stop",
      session: started.session.id,
    }, { signal }) as { stopped: boolean };
    expect(stopped.stopped).toBe(true);
    expect(value.processes).toEqual([process]);
    expect(process.written.join("\n")).toContain("Keep working after the Codex login");
    expect(process.written.some((line) => line.includes("interrupt"))).toBe(true);
    expect(process.terminated).toBe(false);
    expect(value.store.requireSessionProviderAuthority(started.session.id)).toEqual(capturedBefore);
  });

  test("keeps in-flight Claude authority unchanged across sibling Codex login", async () => {
    const value = await claudeFixture();
    const account = await authenticatedClaudeAccount(value, "Claude blocks Codex login");
    const started = await value.service.execute({
      account,
      fast: false,
      kind: "session.start",
      preset: "fable-max",
      provider: "claude",
    }, { signal }) as { session: { id: `sess_${string}` } };
    const process = value.processes[0];
    if (process === undefined) throw new Error("Expected one pinned Claude process.");
    await settle();
    await value.service.execute({
      idempotencyKey: crypto.randomUUID(),
      kind: "session.send",
      message: "Keep this turn in flight",
      session: started.session.id,
    }, { signal });
    const before = value.store.requireProfileById(account);

    const claudeBefore = value.store.requireProviderAccountAuthority(account, "claude");
    await value.service.execute({
      account,
      deviceCode: false,
      idempotencyKey: crypto.randomUUID(),
      kind: "account.login",
    }, { signal });
    expect(value.store.requireProfileById(account)).toMatchObject({
      processGeneration: before.processGeneration + 1,
      state: "signed_in",
    });
    expect(value.store.requireProviderAccountAuthority(account, "claude")).toEqual(claudeBefore);
    expect(process.terminated).toBe(false);
    expect(await eventBodies(value, started.session.id)).not.toContainEqual(
      expect.objectContaining({ type: "gap", reason: "provider_disconnect" }),
    );

    const stopped = await value.service.execute({
      idempotencyKey: crypto.randomUUID(),
      kind: "session.stop",
      session: started.session.id,
    }, { signal }) as { stopped: boolean };
    expect(stopped.stopped).toBe(true);
    expect(process.written.some((line) => line.includes("interrupt"))).toBe(true);
    process.emit(resultLine("Stopped cleanly"));
    await settle();
    expect(value.store.requireProviderAccountAuthority(account, "claude")).toEqual(claudeBefore);
    expect(process.terminated).toBe(false);
  });

  test("keeps an idle Claude session usable when the sibling Codex runtime disconnects", async () => {
    const value = await claudeFixture();
    const account = await authenticatedClaudeAccount(value, "Claude survives Codex disconnect");
    const started = await value.service.execute({
      account,
      fast: false,
      kind: "session.start",
      preset: "fable-max",
      provider: "claude",
    }, { signal }) as { session: { id: `sess_${string}` } };
    const process = value.processes[0];
    if (process === undefined) throw new Error("Expected one pinned Claude process.");
    await settle();
    const before = value.store.requireProfileById(account);
    const claudeBefore = value.store.requireProviderAccountAuthority(account, "claude");
    const capturedBefore = value.store.requireSessionProviderAuthority(started.session.id);

    const codex = value.store.requireProviderAccountAuthority(account, "codex");
    await value.service.observeCodexFact({
      bindingGeneration: codex.bindingGeneration,
      codexHome: "unused-codex-home",
      desktopUserData: "unused-desktop-home",
      generation: codex.processGeneration,
      id: codex.profileId,
      provider: "codex",
      providerAccountId: codex.providerAccountId,
    }, {
      connectionId: "21000000-0000-4000-8000-000000000001",
      reason: "eof",
      type: "providerDisconnected",
    });

    expect(value.store.requireProfileById(account).processGeneration)
      .toBe(before.processGeneration + 1);
    expect(value.store.requireProviderAccountAuthority(account, "claude")).toEqual(claudeBefore);
    expect(value.store.requireSessionProviderAuthority(started.session.id)).toEqual(capturedBefore);
    expect(process.terminated).toBe(false);
    await value.service.execute({
      idempotencyKey: crypto.randomUUID(),
      kind: "session.send",
      message: "Continue after the Codex disconnect",
      session: started.session.id,
    }, { signal });
    const stopped = await value.service.execute({
      idempotencyKey: crypto.randomUUID(),
      kind: "session.stop",
      session: started.session.id,
    }, { signal }) as { stopped: boolean };
    expect(stopped.stopped).toBe(true);
    expect(process.written.join("\n")).toContain("Continue after the Codex disconnect");
    expect(process.written.some((line) => line.includes("interrupt"))).toBe(true);
  });

  test("refuses Fast enable locally and remotely before metadata changes", async () => {
    const value = await claudeFixture();
    const account = await authenticatedClaudeAccount(value, "Claude Fast refusal");
    const started = await value.service.execute({
      account,
      fast: false,
      kind: "session.start",
      preset: "fable-max",
      provider: "claude",
    }, { signal }) as { session: { id: `sess_${string}`; providerThreadId: string } };
    const session = value.store.requireSession(started.session.id);
    const providerAuthority = value.store.requireProviderAccountAuthority(session.profileId, "claude");
    if (session.providerThreadId === undefined) throw new Error("Expected a bound Claude session.");

    await expect(value.service.execute({
      enabled: true,
      kind: "session.fast",
      session: session.id,
    }, { signal })).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: "Fast mode is available only for Codex sessions.",
    });
    expect(value.store.requireSession(session.id).fastEnabled).toBe(false);

    await expect(value.service.executeRemote({
      enabled: true,
      kind: "session.fast",
      session: session.id,
    }, {
      bindingGeneration: providerAuthority.bindingGeneration,
      processGeneration: providerAuthority.processGeneration,
      profileId: providerAuthority.profileId,
      provider: "claude",
      providerAccountId: providerAuthority.providerAccountId,
      providerThreadId: session.providerThreadId,
      sessionId: session.id,
    }, { signal })).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: "Fast mode is available only for Codex sessions.",
    });
    expect(value.store.requireSession(session.id).fastEnabled).toBe(false);

    const invalid = value.store.updateSessionMetadata({
      expectedRevision: value.store.requireSession(session.id).revision,
      fastEnabled: true,
      sessionId: session.id,
    });
    expect(invalid.fastEnabled).toBe(true);
    await expect(value.service.execute({
      enabled: false,
      kind: "session.fast",
      session: session.id,
    }, { signal })).resolves.toMatchObject({ session: { fastEnabled: false } });
  });

  test("runs one whole session: start, turn, deltas, approval, steer, completion", async () => {
    const value = await claudeFixture();
    const account = await authenticatedClaudeAccount(value, "Claude");
    expect(value.store.requireProfileById(account).state).toBe("signed_out");

    const started = await value.service.execute({
      account,
      fast: false,
      kind: "session.start",
      preset: "fable-max",
      provider: "claude",
    }, { signal }) as {
      session: { id: `sess_${string}`; provider: string; preset: string };
      effectiveRuntimeProfile: Record<string, unknown>;
    };
    const sessionId = started.session.id;
    expect(started.session.provider).toBe("claude");
    expect(started.session.preset).toBe("fable-max");

    // The durable session-start evidence carries the Claude document.
    expect(started.effectiveRuntimeProfile).toMatchObject({
      claudeVersion: CLAUDE_PIN,
      inputFormat: "stream-json",
      model: CLAUDE_PIN_MODEL,
      nativeFallback: CLAUDE_PIN_NATIVE_FALLBACK_CAPABILITY,
      outputFormat: "stream-json",
      permissionMode: "default",
      preset: "fable-max",
      reasoningEffort: "max",
    });
    expect(started.effectiveRuntimeProfile).not.toHaveProperty("configHome");
    expect(value.store.latestSessionRuntimeProfile(sessionId)).toMatchObject({
      profile: {
        claudeVersion: CLAUDE_PIN,
        configHome: "isolated",
        preset: "fable-max",
      },
      revision: 1,
      sourceKind: "session_start",
    });

    const process = value.processes[0];
    if (process === undefined) throw new Error("Expected one pinned Claude process.");
    const sent = await value.service.execute({
      idempotencyKey: crypto.randomUUID(),
      kind: "session.send",
      message: "Check the status line for example.com",
      session: sessionId,
    }, { signal }) as { turnId: string; effectiveRuntimeProfile: Record<string, unknown> | null };
    expect(sent.effectiveRuntimeProfile).toMatchObject({ preset: "fable-max" });
    // The turn's exact reviewed profile is bound durably too.
    expect(value.store.runtimeProfileForTurn(sessionId, sent.turnId)).toMatchObject({
      claudeVersion: CLAUDE_PIN,
      preset: "fable-max",
    });
    expect(process.written.join("")).toContain("Check the status line for example.com");

    process.emit(assistantLine("Checking the status line", "msg_1"));
    await settle();

    const requestId = "7036d017-a860-42d1-b7a6-0951dcae5f6a";
    process.emit(approvalRequestLine(requestId));
    await settle();

    const pending = await value.service.execute(
      { kind: "interaction.list", limit: 10, pending: true, session: sessionId },
      { signal },
    ) as { interactions: readonly { id: string; kind: string; revision: number }[] };
    expect(pending.interactions).toHaveLength(1);
    const interaction = pending.interactions[0];
    if (interaction === undefined) throw new Error("Expected one pending interaction.");
    expect(interaction.kind).toBe("command_approval");

    await value.service.execute({
      expectedRevision: interaction.revision,
      interaction: interaction.id,
      kind: "interaction.resolve",
      resolution: { decision: "once", kind: "approval_decision" },
    }, { signal });
    // The approval left the daemon as one `control_response` on the pinned
    // process's own stdin, echoing the request's exact input.
    const control = process.written.find((line) => line.includes("control_response"));
    expect(control).toBeDefined();
    expect(control).toContain(requestId);
    expect(control).toContain("\"behavior\":\"allow\"");
    expect(control).not.toContain("permission_suggestions");
    // Claude sends no resolution notification, so the bridge publishes the
    // equivalent fact just after the write and the durable row settles.
    await settle();

    await value.service.execute({
      idempotencyKey: crypto.randomUUID(),
      kind: "session.steer",
      message: "Only the first line, please",
      session: sessionId,
    }, { signal });
    expect(process.written.join("")).toContain("Only the first line, please");

    process.emit(assistantLine("HTTP/2 200", "msg_2"));
    process.emit(rateLimitLine("bee4e95a-9a7d-4f23-a5d2-a50045b22dec"));
    process.emit(resultLine("HTTP/2 200"));
    await settle();
    await value.service.settled();

    const providerAuthority = value.store.requireProviderAccountAuthority(account, "claude");
    const usage = value.store.latestProviderUsage(providerAuthority.providerAccountId);
    expect(usage).toMatchObject({
      authority: providerAuthority,
      authorityMode: "mutation_authoritative",
      quota: {
        observationRevision: 1,
        source: "claude_rate_limit_event",
        turn: { sessionId, turnId: sent.turnId },
        quota: {
          format: "claude_v1",
          status: { state: "known", value: "allowed" },
          windows: [{
            id: "five_hour",
            resetsAtMs: 1_788_499_800_000,
            scope: "account",
            usedPercent: 50,
          }],
        },
      },
      accounting: {
        observationRevision: 1,
        source: "claude_result",
        turn: { sessionId, turnId: sent.turnId },
        accounting: {
          format: "claude_v1",
          totalCostUsd: 0.2,
        },
      },
    });

    const bodies = await eventBodies(value, sessionId);
    const types = bodies.map((body) => body.type);
    expect(types).toContain("turn_started");
    expect(types).toContain("assistant_delta");
    expect(types).toContain("interaction_requested");
    expect(types).toContain("interaction_state");
    // The approval settled terminally even though Claude sends no resolution
    // notification of its own.
    expect(bodies.filter((body) => body.type === "interaction_state").at(-1))
      .toMatchObject({ state: "resolved" });
    expect(types).toContain("token_usage");
    expect(types).toContain("turn_completed");
    expect(bodies.filter((body) => body.type === "assistant_delta").map((body) => body.text))
      .toEqual(["Checking the status line", "HTTP/2 200"]);
    // Provider turn ids never leave the daemon in the clear.
    const completed = bodies.find((body) => body.type === "turn_completed");
    expect(completed).toMatchObject({ status: "completed" });
    expect(completed?.turnId).toMatch(/^opaque_v2_[a-f0-9]{64}$/u);
    expect(JSON.stringify(bodies)).not.toContain(sent.turnId);
    expect(bodies.find((body) => body.type === "token_usage")).toMatchObject({
      cachedInputTokens: 10_123,
      inputTokens: 2,
      outputTokens: 4,
    });

    // The session state classifier ran on the same events.
    const status = await value.service.execute(
      { kind: "session.state", session: sessionId },
      { signal },
    ) as { state: string };
    expect(typeof status.state).toBe("string");

    // The turn boundary reconciled local state and the projection carries the
    // turn summary and the whole transcript.
    const shown = await value.service.execute(
      { detail: true, kind: "session.show", session: sessionId },
      { signal },
    ) as {
      session: { state: string; activeTurnId?: string };
      projection: {
        messages: readonly { role: string; text: string }[];
        turnSummaries: readonly { id: string; status: string; runtimeMs?: number }[];
      };
    };
    expect(shown.session.state).toBe("idle");
    expect(shown.session.activeTurnId).toBeUndefined();
    expect(shown.projection.messages.map((message) => message.role))
      .toEqual(["user", "assistant", "user", "assistant"]);
    expect(shown.projection.turnSummaries).toEqual([
      expect.objectContaining({ id: sent.turnId, runtimeMs: 2_374, status: "completed" }),
    ]);
  });

  test("answers a Claude question and projects its subagents as durable events", async () => {
    const value = await claudeFixture();
    const account = await authenticatedClaudeAccount(value, "Claude question");
    const started = await value.service.execute({
      account,
      fast: false,
      kind: "session.start",
      preset: "fable-max",
      provider: "claude",
    }, { signal }) as { session: { id: `sess_${string}` } };
    const sessionId = started.session.id;
    const process = value.processes[0];
    if (process === undefined) throw new Error("Expected one pinned Claude process.");
    await value.service.execute({
      idempotencyKey: crypto.randomUUID(),
      kind: "session.send",
      message: "Set up the formatter",
      session: sessionId,
    }, { signal });

    process.emit(subagentStartedLine);
    const requestId = "4d400f2f-1589-4784-b096-00448644856f";
    process.emit(questionRequestLine(requestId));
    await settle();

    const pending = await value.service.execute(
      { kind: "interaction.list", limit: 10, pending: true, session: sessionId },
      { signal },
    ) as { interactions: readonly { id: string; kind: string; revision: number }[] };
    const question = pending.interactions[0];
    if (question === undefined) throw new Error("Expected the pending question.");
    expect(question.kind).toBe("user_input");

    await value.service.execute({
      expectedRevision: question.revision,
      interaction: question.id,
      kind: "interaction.resolve",
      resolution: { answers: { q0: { answers: ["spaces"] } }, kind: "user_answers" },
    }, { signal });
    const control = process.written.find((line) => line.includes("control_response"));
    expect(control).toBeDefined();
    expect(control).toContain("\"Tabs or spaces?\":\"spaces\"");

    // Claude sends no resolution notification, so the bridge publishes the
    // equivalent fact out of band and the durable row settles just after.
    await settle();
    const bodies = await eventBodies(value, sessionId);
    const subagent = bodies.find((body) => body.type === "subagent_activity");
    expect(subagent).toMatchObject({ depth: 1, kind: "started", role: "Explore" });
    // The provider's own task id never leaves the daemon in the clear.
    expect(subagent?.agentId).toMatch(/^opaque_v2_[a-f0-9]{64}$/u);
    expect(JSON.stringify(bodies)).not.toContain("a5fb5e66c43a1adcd");
    expect(bodies.find((body) => body.type === "interaction_requested"))
      .toMatchObject({ interactionKind: "user_input" });
    expect(bodies.filter((body) => body.type === "interaction_state").at(-1))
      .toMatchObject({ state: "resolved" });
  });

  test("returns the usage callback before attempting deferred persistence", async () => {
    let observed!: () => void;
    const callbackReturned = new Promise<void>((resolve) => { observed = resolve; });
    const value = await claudeFixture({
      now: () => 10_000,
      onFactObserved: (fact) => {
        if (fact.type === "rateLimitObserved") observed();
      },
    });
    const account = await authenticatedClaudeAccount(value, "Claude deferred usage");
    const started = await value.service.execute({
      account,
      fast: false,
      kind: "session.start",
      preset: "fable-max",
      provider: "claude",
    }, { signal }) as { session: { id: `sess_${string}` } };
    const process = value.processes[0];
    if (process === undefined) throw new Error("Expected one pinned Claude process.");
    process.emit(initLine);
    await settle();
    const sent = await value.service.execute({
      idempotencyKey: crypto.randomUUID(),
      kind: "session.send",
      message: "Observe quota",
      session: started.session.id,
    }, { signal }) as { turnId: string };

    let writes = 0;
    const record = value.store.recordProviderUsageObservation.bind(value.store);
    value.store.recordProviderUsageObservation = (observation) => {
      writes += 1;
      return record(observation);
    };
    process.emit(rateLimitLine("00000000-0000-4000-8000-000000000010"));
    await callbackReturned;
    expect(writes).toBe(0);
    await value.service.settled();
    expect(writes).toBe(1);
    const authority = value.store.requireProviderAccountAuthority(account, "claude");
    expect(value.store.latestProviderUsage(authority.providerAccountId)).toMatchObject({
      quota: {
        observedAt: 10_000,
        receivedAt: 10_000,
        turn: { sessionId: started.session.id, turnId: sent.turnId },
      },
    });
  });

  test("retries direct-turn usage only after that exact turn binding commits", async () => {
    const value = await claudeFixture({ now: () => 10_000 });
    const account = await authenticatedClaudeAccount(value, "Claude direct usage race");
    const started = await value.service.execute({
      account,
      fast: false,
      kind: "session.start",
      preset: "fable-max",
      provider: "claude",
    }, { signal }) as { session: { id: `sess_${string}` } };
    const process = value.processes[0];
    if (process === undefined) throw new Error("Expected one pinned Claude process.");
    process.emit(initLine);
    await settle();

    let attempts = 0;
    let signalFirstAttempt!: () => void;
    const firstAttempt = new Promise<void>((resolve) => {
      signalFirstAttempt = resolve;
    });
    const record = value.store.recordProviderUsageObservation.bind(value.store);
    value.store.recordProviderUsageObservation = (observation) => {
      attempts += 1;
      if (attempts === 1) signalFirstAttempt();
      return record(observation);
    };
    process.beforeWriteReturn = async () => {
      process.beforeWriteReturn = undefined;
      process.emit(rateLimitLine("00000000-0000-4000-8000-000000000030"));
      await firstAttempt;
    };

    const sending = value.service.execute({
      idempotencyKey: crypto.randomUUID(),
      kind: "session.send",
      message: "Race the direct turn binding",
      session: started.session.id,
    }, { signal }) as Promise<{ turnId: string }>;
    await firstAttempt;
    expect(attempts).toBe(1);
    const sent = await sending;
    await value.service.settled();

    expect(attempts).toBe(2);
    const authority = value.store.requireProviderAccountAuthority(account, "claude");
    expect(value.store.latestProviderUsage(authority.providerAccountId)).toMatchObject({
      authority,
      quota: {
        turn: { sessionId: started.session.id, turnId: sent.turnId },
      },
    });
    expect(value.service.backgroundDiagnostics().byCode).not.toContainEqual(
      expect.objectContaining({ code: "provider_usage_persistence_failed" }),
    );
  });

  test("retries queued-turn usage only after that exact turn binding commits", async () => {
    const value = await claudeFixture({ now: () => 10_000 });
    const account = await authenticatedClaudeAccount(value, "Claude queued usage race");
    const started = await value.service.execute({
      account,
      fast: false,
      kind: "session.start",
      preset: "fable-max",
      provider: "claude",
    }, { signal }) as { session: { id: `sess_${string}` } };
    const process = value.processes[0];
    if (process === undefined) throw new Error("Expected one pinned Claude process.");
    process.emit(initLine);
    await settle();

    let attempts = 0;
    let signalFirstAttempt!: () => void;
    const firstAttempt = new Promise<void>((resolve) => {
      signalFirstAttempt = resolve;
    });
    const record = value.store.recordProviderUsageObservation.bind(value.store);
    value.store.recordProviderUsageObservation = (observation) => {
      attempts += 1;
      if (attempts === 1) signalFirstAttempt();
      return record(observation);
    };
    process.beforeWriteReturn = async () => {
      process.beforeWriteReturn = undefined;
      process.emit(rateLimitLine("00000000-0000-4000-8000-000000000031"));
      await firstAttempt;
    };

    const result = await value.service.execute({
      idempotencyKey: crypto.randomUUID(),
      kind: "session.queue",
      message: "Race the queued turn binding",
      session: started.session.id,
    }, { signal }) as { queued: { id: `queue_${string}` } };
    await firstAttempt;
    expect(attempts).toBe(1);
    await value.service.settled();

    expect(attempts).toBe(2);
    expect(value.store.requireQueue(result.queued.id)).toMatchObject({ state: "applied" });
    const authority = value.store.requireProviderAccountAuthority(account, "claude");
    const quota = value.store.providerUsageObservations({
      component: "quota",
      providerAccountId: authority.providerAccountId,
    })[0];
    expect(quota).toMatchObject({
      authority,
      turn: { sessionId: started.session.id },
    });
    if (quota?.turn === null || quota?.turn === undefined) {
      throw new Error("Expected queued usage to retain exact turn provenance.");
    }
    expect(value.store.runtimeProfileForTurn(started.session.id, quota.turn.turnId)).not.toBeNull();
    expect(value.service.backgroundDiagnostics().byCode).not.toContainEqual(
      expect.objectContaining({ code: "provider_usage_persistence_failed" }),
    );
  });

  test("settles a pre-bind usage writer when close races a failed provider start", async () => {
    const value = await claudeFixture({ now: () => 10_000 });
    const account = await authenticatedClaudeAccount(value, "Claude failed usage race");
    const started = await value.service.execute({
      account,
      fast: false,
      kind: "session.start",
      preset: "fable-max",
      provider: "claude",
    }, { signal }) as { session: { id: `sess_${string}` } };
    const process = value.processes[0];
    if (process === undefined) throw new Error("Expected one pinned Claude process.");
    process.emit(initLine);
    await settle();

    let attempts = 0;
    let signalFirstAttempt!: () => void;
    const firstAttempt = new Promise<void>((resolve) => {
      signalFirstAttempt = resolve;
    });
    let releaseProviderWrite!: () => void;
    const providerWriteGate = new Promise<void>((resolve) => {
      releaseProviderWrite = resolve;
    });
    const record = value.store.recordProviderUsageObservation.bind(value.store);
    value.store.recordProviderUsageObservation = (observation) => {
      attempts += 1;
      if (attempts === 1) signalFirstAttempt();
      return record(observation);
    };
    process.beforeWriteReturn = async () => {
      process.beforeWriteReturn = undefined;
      process.emit(rateLimitLine("00000000-0000-4000-8000-000000000033"));
      await firstAttempt;
      await providerWriteGate;
      throw new Error("test-only provider write failure");
    };

    const sending = value.service.execute({
      idempotencyKey: crypto.randomUUID(),
      kind: "session.send",
      message: "Fail before binding the turn",
      session: started.session.id,
    }, { signal });
    await firstAttempt;
    expect(attempts).toBe(1);
    const closing = value.service.close();
    releaseProviderWrite();
    const [sendOutcome, closeOutcome] = await Promise.allSettled([sending, closing]);

    expect(sendOutcome.status).toBe("rejected");
    expect(closeOutcome.status).toBe("fulfilled");
    expect(attempts).toBe(1);
    const authority = value.store.requireProviderAccountAuthority(account, "claude");
    expect(value.store.latestProviderUsage(authority.providerAccountId)).toBeNull();
    expect(value.service.backgroundDiagnostics().last).toMatchObject({
      cause: "error",
      code: "provider_usage_persistence_failed",
      count: 1,
    });
  });

  test("persists admitted historical usage after the account process generation advances", async () => {
    let signalCallbackReturned!: () => void;
    const callbackReturned = new Promise<void>((resolve) => {
      signalCallbackReturned = resolve;
    });
    const value = await claudeFixture({
      now: () => 10_000,
      onFactObserved: (fact) => {
        if (fact.type === "rateLimitObserved") signalCallbackReturned();
      },
    });
    const account = await authenticatedClaudeAccount(value, "Claude historical usage");
    const started = await value.service.execute({
      account,
      fast: false,
      kind: "session.start",
      preset: "fable-max",
      provider: "claude",
    }, { signal }) as { session: { id: `sess_${string}` } };
    const process = value.processes[0];
    if (process === undefined) throw new Error("Expected one pinned Claude process.");
    process.emit(initLine);
    await settle();
    const sent = await value.service.execute({
      idempotencyKey: crypto.randomUUID(),
      kind: "session.send",
      message: "Bind historical usage",
      session: started.session.id,
    }, { signal }) as { turnId: string };
    const frozenAuthority = value.store.requireProviderAccountAuthority(account, "claude");

    let writes = 0;
    const record = value.store.recordProviderUsageObservation.bind(value.store);
    value.store.recordProviderUsageObservation = (observation) => {
      writes += 1;
      return record(observation);
    };
    process.emit(rateLimitLine("00000000-0000-4000-8000-000000000032"));
    await callbackReturned;
    expect(writes).toBe(0);
    value.store.advanceProviderAccountProcessGeneration({
      expectedProcessGeneration: frozenAuthority.processGeneration,
      profileId: account,
      provider: "claude",
    });
    await value.service.settled();

    expect(writes).toBe(1);
    const stored = value.store.providerUsageObservations({
      component: "quota",
      providerAccountId: frozenAuthority.providerAccountId,
    })[0];
    expect(stored).toMatchObject({
      authority: frozenAuthority,
      turn: { sessionId: started.session.id, turnId: sent.turnId },
    });
    expect(value.store.requireProviderAccountAuthority(account, "claude")).toMatchObject({
      bindingGeneration: frozenAuthority.bindingGeneration,
      processGeneration: frozenAuthority.processGeneration + 1,
    });
  });

  test("reduces a result timeline before scheduling deferred accounting persistence", async () => {
    let signalCallbackReturned!: () => void;
    const callbackReturned = new Promise<void>((resolve) => {
      signalCallbackReturned = resolve;
    });
    let writes = 0;
    const persistenceSnapshots: Array<Readonly<{ state: string; completed: boolean }>> = [];
    const order: string[] = [];
    const value = await claudeFixture({
      onFactObserved: (fact) => {
        if (fact.type !== "usageAccountingObserved") return;
        order.push("callback");
        signalCallbackReturned();
      },
    });
    const account = await authenticatedClaudeAccount(value, "Claude result ordering");
    const started = await value.service.execute({
      account,
      fast: false,
      kind: "session.start",
      preset: "fable-max",
      provider: "claude",
    }, { signal }) as { session: { id: `sess_${string}` } };
    const process = value.processes[0];
    if (process === undefined) throw new Error("Expected one pinned Claude process.");
    process.emit(initLine);
    await settle();
    await value.service.execute({
      idempotencyKey: crypto.randomUUID(),
      kind: "session.send",
      message: "Observe terminal accounting",
      session: started.session.id,
    }, { signal });

    const record = value.store.recordProviderUsageObservation.bind(value.store);
    value.store.recordProviderUsageObservation = (observation) => {
      writes += 1;
      order.push("persist");
      persistenceSnapshots.push({
        state: value.store.requireSession(started.session.id).state,
        completed: value.store.listSessionEvents({
          sessionId: started.session.id, afterSequence: null, limit: 200,
        }).events.some((event) => event.body.type === "turn_completed"),
      });
      return record(observation);
    };
    process.emit(resultLine("done"));
    await callbackReturned;
    // Callback return is not a timeline commit when a native effect owns the
    // session tail. Persistence, however, must wait for that exact ordered work.
    expect(writes).toBe(0);
    await value.service.settled();
    expect(writes).toBe(1);
    expect(order).toEqual(["callback", "persist"]);
    expect(persistenceSnapshots).toEqual([{ state: "idle", completed: true }]);
  });

  test.each(["current", "retired_provider", "lost_daemon", "closing"] as const)(
    "orders terminal accounting behind deferred facts without blocking native turn admission: %s",
    async (disposition) => {
    let signalAccountingReturned!: () => void;
    const accountingReturned = new Promise<void>((resolve) => { signalAccountingReturned = resolve; });
    let signalTimelineBlocked!: () => void;
    const timelineBlocked = new Promise<void>((resolve) => { signalTimelineBlocked = resolve; });
    let releaseTimeline!: () => void;
    const timelineRelease = new Promise<void>((resolve) => { releaseTimeline = resolve; });
    let blockNextTimeline = false;
    let daemonLost = false;
    const value = await claudeFixture({
      daemonAuthority: {
        assertCurrent: async () => {
          if (daemonLost) throw new Error("test-only daemon fence lost");
        },
        close: () => { daemonLost = true; },
      },
      beforeProjectionRecoveryCheck: async () => {
        if (!blockNextTimeline) return;
        blockNextTimeline = false;
        signalTimelineBlocked();
        await timelineRelease;
      },
      onFactObserved: (fact) => {
        if (fact.type === "usageAccountingObserved") signalAccountingReturned();
      },
    });
    const account = await authenticatedClaudeAccount(value, "Claude locked accounting");
    const started = await value.service.execute({
      account, fast: false, kind: "session.start", preset: "fable-max", provider: "claude",
    }, { signal }) as { session: { id: `sess_${string}` } };
    const process = value.processes[0];
    if (process === undefined) throw new Error("Expected one pinned Claude process.");
    await settle();
    await value.service.settled();
    const frozenAuthority = value.store.requireProviderAccountAuthority(account, "claude");
    const sent = await value.service.execute({
      idempotencyKey: crypto.randomUUID(), kind: "session.send",
      message: "Start before the result-producing steer", session: started.session.id,
    }, { signal }) as { turnId: string };
    await value.service.settled();
    const snapshots: Array<Readonly<{ state: string; completed: boolean }>> = [];
    const record = value.store.recordProviderUsageObservation.bind(value.store);
    value.store.recordProviderUsageObservation = (observation) => {
      snapshots.push({
        state: value.store.requireSession(started.session.id).state,
        completed: value.store.listSessionEvents({
          sessionId: started.session.id, afterSequence: null, limit: 200,
        }).events.some((event) => event.body.type === "turn_completed"),
      });
      return record(observation);
    };
    process.beforeWriteReturn = async () => {
      process.beforeWriteReturn = undefined;
      blockNextTimeline = true;
      process.emit(resultLine("done while native admission owns the session lock"));
      // The native write deliberately awaits the reader. A callback that waits
      // for the mutation's own session tail would deadlock this real seam.
      await accountingReturned;
    };
    let closing: Promise<void> | undefined;
    try {
      await value.service.execute({
        idempotencyKey: crypto.randomUUID(), kind: "session.steer",
        message: "Complete before the native steer returns", session: started.session.id,
      }, { signal });
      await timelineBlocked;
      // Cross the already scheduled zero-delay writer turn while a real
      // timeline reducer is held. This is an event-loop barrier, not a race delay.
      await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
      expect(snapshots).toEqual([]);
      expect(value.store.requireSession(started.session.id).state).toBe("active");
      if (disposition === "retired_provider") {
        value.store.advanceProviderAccountProcessGeneration({
          profileId: account, provider: "claude",
          expectedProcessGeneration: frozenAuthority.processGeneration,
        });
      } else if (disposition === "lost_daemon") {
        daemonLost = true;
      } else if (disposition === "closing") {
        closing = value.service.close();
      }
    } finally {
      releaseTimeline();
    }
    await value.service.settled();
    await closing;
    if (disposition === "lost_daemon" || disposition === "closing") {
      expect(snapshots).toEqual([]);
      expect(value.service.backgroundDiagnostics().byCode.find((diagnostic) =>
        diagnostic.code === "provider_usage_persistence_failed"))
        .toMatchObject({ code: "provider_usage_persistence_failed", count: 1 });
      expect(value.store.providerUsageObservations({
        component: "accounting", providerAccountId: frozenAuthority.providerAccountId,
      })).toEqual([]);
    } else {
      expect(snapshots).toEqual([disposition === "current"
        ? { state: "idle", completed: true }
        : { state: "active", completed: false }]);
      expect(value.store.providerUsageObservations({
        component: "accounting", providerAccountId: frozenAuthority.providerAccountId,
      })).toMatchObject([{
        authority: frozenAuthority, turn: { sessionId: started.session.id, turnId: sent.turnId },
      }]);
    }
  });

  test("retains an immediate Claude result without restoring a completed turn to active", async () => {
    const value = await claudeFixture();
    const account = await authenticatedClaudeAccount(value, "Claude immediate result");
    const started = await value.service.execute({
      account, fast: false, kind: "session.start", preset: "fable-max", provider: "claude",
    }, { signal }) as { session: { id: `sess_${string}` } };
    const process = value.processes[0];
    if (process === undefined) throw new Error("Expected one pinned Claude process.");
    await settle();
    await value.service.settled();
    process.beforeWriteReturn = async () => {
      process.beforeWriteReturn = undefined;
      const resultRead = new Promise<void>((resolve) => {
        process.afterStdoutChunkRead = () => {
          process.afterStdoutChunkRead = undefined;
          resolve();
        };
      });
      process.emit(resultLine("Immediate completion"));
      // Prove the actual stream consumed the result before the initial native
      // write resolves; do not wait for a daemon callback or a timing delay.
      await resultRead;
    };
    const key = crypto.randomUUID();
    const sent = await value.service.execute({
      idempotencyKey: key, kind: "session.send", message: "Complete immediately",
      session: started.session.id,
    }, { signal }) as { turnId: string };
    await value.service.settled();
    expect(value.store.requireSession(started.session.id)).toMatchObject({ state: "idle" });
    expect(value.store.requireSession(started.session.id).activeTurnId).toBeUndefined();
    const facts = await eventBodies(value, started.session.id);
    const userIndex = facts.findIndex((fact) => fact.type === "user_message");
    const startedIndex = facts.findIndex((fact) => fact.type === "turn_started");
    const completedIndex = facts.findIndex((fact) => fact.type === "turn_completed");
    expect(userIndex).toBeGreaterThanOrEqual(0);
    expect(startedIndex).toBeGreaterThan(userIndex);
    expect(startedIndex).toBeGreaterThanOrEqual(0);
    expect(completedIndex).toBeGreaterThan(startedIndex);
    expect(facts.filter((fact) => fact.type === "turn_started")).toHaveLength(1);
    expect(facts.filter((fact) => fact.type === "turn_completed")).toHaveLength(1);
    expect(value.store.readMutation(key)).toMatchObject({ state: "applied", result: { turnId: sent.turnId } });
    const shown = await value.service.execute({
      kind: "session.show", session: started.session.id, detail: false,
    }, { signal });
    expect(shown).toMatchObject({ session: { state: "idle" } });
    expect(value.processes).toHaveLength(1);
  });

  test("retains an observed Claude result after write rejection without inventing success or replay", async () => {
    const value = await claudeFixture();
    const account = await authenticatedClaudeAccount(value, "Claude rejected early result");
    const started = await value.service.execute({
      account, fast: false, kind: "session.start", preset: "fable-max", provider: "claude",
    }, { signal }) as { session: { id: `sess_${string}` } };
    const process = value.processes[0];
    if (process === undefined) throw new Error("Expected one pinned Claude process.");
    await settle();
    await value.service.settled();
    process.beforeWriteReturn = async () => {
      process.beforeWriteReturn = undefined;
      const resultRead = new Promise<void>((resolve) => {
        process.afterStdoutChunkRead = () => {
          process.afterStdoutChunkRead = undefined;
          resolve();
        };
      });
      process.emit(resultLine("Observed completion despite failed write settlement"));
      await resultRead;
      throw new Error("test-only write rejection after an actual result");
    };
    const key = crypto.randomUUID();
    const command = {
      idempotencyKey: key, kind: "session.send" as const,
      message: "Do not replay a rejected write", session: started.session.id,
    };
    await expect(value.service.execute(command, { signal })).rejects.toThrow();
    await value.service.settled();
    const uncertain = value.store.readMutation(key);
    expect(uncertain).toMatchObject({ state: "ambiguous" });
    const facts = await eventBodies(value, started.session.id);
    expect(facts.some((fact) => fact.type === "turn_started")).toBe(false);
    expect(facts.some((fact) => fact.type === "user_message")).toBe(false);
    expect(facts.find((fact) => fact.type === "turn_completed")).toMatchObject({ status: "completed" });
    expect(facts.filter((fact) => fact.type === "turn_completed")).toHaveLength(1);
    expect(value.store.requireSession(started.session.id).state).toBe("recovery_required");
    expect(value.store.requireSession(started.session.id).activeTurnId).toBeUndefined();
    const captured = value.store.requireSessionProviderAuthority(started.session.id);
    expect(value.store.providerUsageObservations({
      providerAccountId: captured.providerAccountId, component: "accounting",
    })).toEqual([]);
    expect(value.service.backgroundDiagnostics().byCode.find((diagnostic) =>
      diagnostic.code === "provider_usage_persistence_failed"))
      .toMatchObject({ count: 1 });
    const writes = [...process.written];
    await expect(value.service.execute(command, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(value.store.readMutation(key)).toEqual(uncertain);
    expect(process.written).toEqual(writes);
    await expect(value.service.execute({
      ...command, idempotencyKey: crypto.randomUUID(), message: "Never replay under a new key",
    }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(process.written).toEqual(writes);
    expect(value.processes).toHaveLength(1);
  });

  test("fences a different-key Claude send after a post-write rejection without a result", async () => {
    const value = await claudeFixture();
    const account = await authenticatedClaudeAccount(value, "Claude post-write uncertainty");
    const started = await value.service.execute({
      account, fast: false, kind: "session.start", preset: "fable-max", provider: "claude",
    }, { signal }) as { session: { id: `sess_${string}` } };
    const process = value.processes[0];
    if (process === undefined) throw new Error("Expected one pinned Claude process.");
    await value.service.settled();
    const authority = value.store.requireSessionProviderAuthority(started.session.id);
    const initialWrites = [...process.written];
    const writeError = new Error("test-only rejection after recording the Claude user frame");
    process.beforeWriteReturn = () => {
      process.beforeWriteReturn = undefined;
      // FakeClaudeProcess.write has already recorded the actual user frame.
      // Emit no result, assistant response, EOF or process exit before rejecting.
      throw writeError;
    };
    const firstKey = crypto.randomUUID();
    const firstMessage = "First input with an unsettled write outcome";
    let firstError: unknown;
    try {
      await value.service.execute({
        idempotencyKey: firstKey, kind: "session.send", message: firstMessage,
        session: started.session.id,
      }, { signal });
    } catch (error: unknown) {
      firstError = error;
    }
    await value.service.settled();
    expect(firstError).toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(value.store.readMutation(firstKey)).toMatchObject({ state: "ambiguous" });
    expect(value.store.requireSession(started.session.id)).toMatchObject({ state: "recovery_required" });
    expect(value.store.requireSession(started.session.id).activeTurnId).toBeUndefined();
    const firstWrites = [...process.written];
    expect(firstWrites.slice(initialWrites.length)).toEqual([`${JSON.stringify({
      message: { content: [{ text: firstMessage, type: "text" }], role: "user" },
      type: "user",
    })}\n`]);
    expect(process.terminated).toBe(false);
    expect(value.processes).toEqual([process]);
    expect(value.store.requireSessionProviderAuthority(started.session.id)).toEqual(authority);
    const firstFacts = await eventBodies(value, started.session.id);
    expect(firstFacts.some((fact) => fact.type === "turn_started" || fact.type === "turn_completed"))
      .toBe(false);
    expect(value.store.providerUsageObservations({
      providerAccountId: authority.providerAccountId, component: "accounting",
    })).toEqual([]);

    const secondKey = crypto.randomUUID();
    expect(secondKey).not.toBe(firstKey);
    const secondOutcome = await value.service.execute({
      idempotencyKey: secondKey, kind: "session.send",
      message: "Different-key input before any result or recovery", session: started.session.id,
    }, { signal }).then(
      () => ({ status: "fulfilled" as const }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );
    await value.service.settled();
    expect(process.terminated).toBe(false);
    expect(value.processes).toEqual([process]);
    expect(value.store.requireSessionProviderAuthority(started.session.id)).toEqual(authority);
    expect((await eventBodies(value, started.session.id))
      .some((fact) => fact.type === "turn_completed")).toBe(false);
    // Decisive cross-layer safety oracle: no second frame may reach this same
    // still-open process merely because the second caller chose another key.
    expect({ outcome: secondOutcome.status, writes: process.written }).toEqual({
      outcome: "rejected", writes: firstWrites,
    });
  }, 5_000);

  test.each(["no_result", "result_before_rejection"] as const)(
    "keeps later Claude queue entries pending after an uncertain dispatch (%s)", async (disposition) => {
    const value = await claudeFixture();
    const account = await authenticatedClaudeAccount(value, "Claude uncertain queue");
    const started = await value.service.execute({
      account, fast: false, kind: "session.start", preset: "fable-max", provider: "claude",
    }, { signal }) as { session: { id: `sess_${string}` } };
    const session = started.session.id;
    const process = value.processes[0];
    if (process === undefined) throw new Error("Expected one pinned Claude process.");
    const initial = await value.service.execute({
      kind: "session.send", session, message: "Initial active turn",
    }, { signal }) as { turnId: string };
    const accountingAttempts: string[] = [];
    const record = value.store.recordProviderUsageObservation.bind(value.store);
    value.store.recordProviderUsageObservation = (observation) => {
      if (observation.source === "claude_result") {
        accountingAttempts.push(observation.turn.turnId);
      }
      return record(observation);
    };
    const first = await value.service.execute({
      kind: "session.queue", session, message: "Uncertain queued input",
    }, { signal }) as { queued: { id: `queue_${string}` } };
    const second = await value.service.execute({
      kind: "session.queue", session, message: "Must remain pending",
    }, { signal }) as { queued: { id: `queue_${string}` } };
    expect(value.store.requireQueue(first.queued.id).state).toBe("pending");
    expect(value.store.requireQueue(second.queued.id).state).toBe("pending");
    process.beforeWriteReturn = async () => {
      process.beforeWriteReturn = undefined;
      if (disposition === "result_before_rejection") {
        const queuedResultRead = new Promise<void>((resolve) => {
          process.afterStdoutChunkRead = () => {
            process.afterStdoutChunkRead = undefined;
            resolve();
          };
        });
        process.emit({
          ...resultLine("Queued turn actually completed before its write rejected"),
          uuid: "48000000-0000-4000-8000-000000000052",
        });
        await queuedResultRead;
      }
      throw new Error("test-only queued frame rejection after write");
    };
    const resultRead = new Promise<void>((resolve) => {
      process.afterStdoutChunkRead = () => {
        process.afterStdoutChunkRead = undefined;
        resolve();
      };
    });
    process.emit(resultLine("Initial turn actually completed"));
    await resultRead;
    await value.service.settled();
    expect(value.store.requireQueue(first.queued.id).state).toBe("ambiguous");
    expect(value.store.requireQueue(second.queued.id).state).toBe("pending");
    expect(value.store.requireSession(session).state).toBe("recovery_required");
    expect(process.written).toHaveLength(2);
    expect(process.written[1]).toContain("Uncertain queued input");
    expect(process.written.join("")).not.toContain("Must remain pending");
    expect((await eventBodies(value, session)).filter((fact) => fact.type === "turn_completed"))
      .toHaveLength(disposition === "result_before_rejection" ? 2 : 1);
    // Immutable accounting publication keeps its original FIFO. The initial
    // turn remains bound; the uncertain queued turn must never gain a binding
    // merely because its real completion was retained before quarantine.
    expect(accountingAttempts[0]).toBe(initial.turnId);
    expect(accountingAttempts).toHaveLength(disposition === "result_before_rejection" ? 2 : 1);
    if (disposition === "result_before_rejection") {
      expect(accountingAttempts[1]).not.toBe(initial.turnId);
      expect(value.service.backgroundDiagnostics().byCode.find((diagnostic) =>
        diagnostic.code === "provider_usage_persistence_failed")).toMatchObject({ count: 1 });
    }
    const authority = value.store.requireSessionProviderAuthority(session);
    const accounting = value.store.providerUsageObservations({
      component: "accounting", providerAccountId: authority.providerAccountId,
    });
    expect(accounting).toHaveLength(1);
    expect(accounting[0]).toMatchObject({ turn: { sessionId: session, turnId: initial.turnId } });
    expect(process.terminated).toBe(false);
    const writes = [...process.written];
    await expect(value.service.execute({
      kind: "session.send", session, message: "Different-key input after uncertain queue",
    }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    await value.service.settled();
    expect(process.written).toEqual(writes);
    expect(value.processes).toEqual([process]);
    }, 5_000,
  );

  test.each(["session.steer", "session.stop"] as const)(
    "requires recovery after a post-write Claude %s rejection", async (kind) => {
      const value = await claudeFixture();
      const account = await authenticatedClaudeAccount(value, "Claude uncertain active operation");
      const started = await value.service.execute({
        account, fast: false, kind: "session.start", preset: "fable-max", provider: "claude",
      }, { signal }) as { session: { id: `sess_${string}` } };
      const session = started.session.id;
      const process = value.processes[0];
      if (process === undefined) throw new Error("Expected one pinned Claude process.");
      await value.service.execute({ kind: "session.send", session, message: "Active turn" }, { signal });
      process.beforeWriteReturn = () => {
        process.beforeWriteReturn = undefined;
        throw new Error("test-only active operation write rejection");
      };
      const idempotencyKey = crypto.randomUUID();
      const command = kind === "session.steer"
        ? { kind, session, idempotencyKey, message: "Uncertain steering" }
        : { kind, session, idempotencyKey };
      await expect(value.service.execute(command, { signal }))
        .rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
      await value.service.settled();
      expect(value.store.readMutation(idempotencyKey)).toMatchObject({ state: "ambiguous" });
      expect(value.store.requireSession(session).state).toBe("recovery_required");
      expect(process.written).toHaveLength(2);
      const writes = [...process.written];
      await expect(value.service.execute({
        kind: "session.steer", session, message: "Do not repeat an uncertain operation",
      }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
      expect(process.written).toEqual(writes);
      expect(process.terminated).toBe(false);
    }, 5_000,
  );

  test("does not replay a Claude approval after its written response rejects", async () => {
    const value = await claudeFixture();
    const account = await authenticatedClaudeAccount(value, "Claude uncertain approval");
    const started = await value.service.execute({
      account, fast: false, kind: "session.start", preset: "fable-max", provider: "claude",
    }, { signal }) as { session: { id: `sess_${string}` } };
    const session = started.session.id;
    const process = value.processes[0];
    if (process === undefined) throw new Error("Expected one pinned Claude process.");
    await value.service.execute({ kind: "session.send", session, message: "Ask for approval" }, { signal });
    const requestRead = new Promise<void>((resolve) => {
      process.afterStdoutChunkRead = () => {
        process.afterStdoutChunkRead = undefined;
        resolve();
      };
    });
    const requestId = "48000000-0000-4000-8000-000000000061";
    process.emit(approvalRequestLine(requestId));
    await requestRead;
    await value.service.settled();
    const pending = await value.service.execute({
      kind: "interaction.list", limit: 10, pending: true, session,
    }, { signal }) as { interactions: readonly { id: string; revision: number }[] };
    expect(pending.interactions).toHaveLength(1);
    const interaction = pending.interactions[0];
    if (interaction === undefined) throw new Error("Expected the pending approval.");
    process.beforeWriteReturn = () => {
      process.beforeWriteReturn = undefined;
      throw new Error("test-only approval response rejection after write");
    };
    const command = {
      expectedRevision: interaction.revision, interaction: interaction.id,
      kind: "interaction.resolve" as const,
      resolution: { decision: "once" as const, kind: "approval_decision" as const },
    };
    await expect(value.service.execute(command, { signal }))
      .rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    await value.service.settled();
    expect(value.store.requireInteraction(interaction.id).state).toBe("resolution_unknown");
    const writes = [...process.written];
    expect(writes.filter((line) => line.includes("control_response"))).toHaveLength(1);
    expect(writes.at(-1)).toContain(requestId);
    await expect(value.service.execute(command, { signal })).rejects.toThrow();
    await value.service.settled();
    expect(value.store.requireInteraction(interaction.id).state).toBe("resolution_unknown");
    expect(process.written).toEqual(writes);
    await expect(value.service.execute({
      kind: "session.steer", session, message: "Do not bypass an uncertain approval with fresh input",
    }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(process.written).toEqual(writes);
    expect(process.terminated).toBe(false);
    expect(value.processes).toEqual([process]);
  }, 5_000);

  test("drops Claude usage callbacks stamped with a retired provider authority", async () => {
    const value = await claudeFixture();
    const account = await authenticatedClaudeAccount(value, "Claude stale usage");
    const started = await value.service.execute({
      account,
      fast: false,
      kind: "session.start",
      preset: "fable-max",
      provider: "claude",
    }, { signal }) as { session: { id: `sess_${string}` } };
    const session = value.store.requireSession(started.session.id);
    if (session.providerThreadId === undefined) throw new Error("Expected a bound Claude thread.");
    const captured = value.store.requireProviderAccountAuthority(account, "claude");
    const retiredAuthority = {
      bindingGeneration: captured.bindingGeneration,
      codexHome: "unused",
      desktopUserData: "unused",
      generation: captured.processGeneration,
      id: captured.profileId,
      provider: "claude" as const,
      providerAccountId: captured.providerAccountId,
    };
    value.store.advanceProviderAccountProcessGeneration({
      expectedProcessGeneration: captured.processGeneration,
      profileId: account,
      provider: "claude",
    });

    let writes = 0;
    const record = value.store.recordProviderUsageObservation.bind(value.store);
    value.store.recordProviderUsageObservation = (observation) => {
      writes += 1;
      return record(observation);
    };
    const frame = {
      connectionId: "00000000-0000-4000-8000-000000000020",
      observationRevision: 1,
      observedAt: 10_000,
      providerThreadId: session.providerThreadId,
      receivedAt: 10_000,
      sourceEventDigest: "a".repeat(64),
      turnId: "turn-retired-authority",
    };
    await value.service.observeClaudeFact(retiredAuthority, {
      ...frame,
      quota: {
        isUsingOverage: false,
        overageDisabledReason: null,
        overageStatus: null,
        rateLimitType: "five_hour",
        resetsAtMs: 11_000,
        status: { state: "known", value: "allowed" },
        windows: [],
      },
      sourceEventId: "00000000-0000-4000-8000-000000000021",
      type: "rateLimitObserved",
    });
    await value.service.observeClaudeFact(retiredAuthority, {
      ...frame,
      accounting: {
        models: [],
        tokens: {
          cacheCreationInputTokens: null,
          cacheReadInputTokens: null,
          inputTokens: 1,
          outputTokens: 1,
          thinkingTokens: null,
        },
        totalCostUsd: null,
      },
      sourceEventId: "00000000-0000-4000-8000-000000000022",
      type: "usageAccountingObserved",
    });
    await value.service.settled();

    expect(writes).toBe(0);
    expect(value.store.latestProviderUsage(captured.providerAccountId)).toBeNull();
    expect(value.store.requireProviderAccountAuthority(account, "claude")).toMatchObject({
      bindingGeneration: captured.bindingGeneration,
      processGeneration: captured.processGeneration + 1,
    });
  });

  test("retains a deferred persistence diagnostic after close begins", async () => {
    let observed!: () => void;
    const callbackReturned = new Promise<void>((resolve) => { observed = resolve; });
    const value = await claudeFixture({
      onFactObserved: (fact) => {
        if (fact.type === "rateLimitObserved") observed();
      },
    });
    const account = await authenticatedClaudeAccount(value, "Claude close usage failure");
    const started = await value.service.execute({
      account,
      fast: false,
      kind: "session.start",
      preset: "fable-max",
      provider: "claude",
    }, { signal }) as { session: { id: `sess_${string}` } };
    const process = value.processes[0];
    if (process === undefined) throw new Error("Expected one pinned Claude process.");
    process.emit(initLine);
    await settle();
    await value.service.execute({
      idempotencyKey: crypto.randomUUID(),
      kind: "session.send",
      message: "Observe quota before close",
      session: started.session.id,
    }, { signal });

    let writes = 0;
    value.store.recordProviderUsageObservation = () => {
      writes += 1;
      throw new Error("test-only persistence failure");
    };
    process.emit(rateLimitLine("00000000-0000-4000-8000-000000000011"));
    await callbackReturned;
    expect(writes).toBe(0);
    await value.service.close();
    expect(writes).toBe(1);
    expect(value.service.backgroundDiagnostics().last).toMatchObject({
      cause: "error",
      code: "provider_usage_persistence_failed",
      count: 1,
    });
  });

  test("drops only the new usage observation when the owned queue is full", async () => {
    let observed!: () => void;
    const accountingCallbackReturned = new Promise<void>((resolve) => { observed = resolve; });
    const value = await claudeFixture({
      onFactObserved: (fact) => {
        if (fact.type === "usageAccountingObserved") observed();
      },
    });
    const account = await authenticatedClaudeAccount(value, "Claude usage overflow");
    const started = await value.service.execute({
      account,
      fast: false,
      kind: "session.start",
      preset: "fable-max",
      provider: "claude",
    }, { signal }) as { session: { id: `sess_${string}` } };
    const process = value.processes[0];
    if (process === undefined) throw new Error("Expected one pinned Claude process.");
    process.emit(initLine);
    await settle();
    await value.service.execute({
      idempotencyKey: crypto.randomUUID(),
      kind: "session.send",
      message: "Fill the informational usage queue",
      session: started.session.id,
    }, { signal });

    let writes = 0;
    value.store.recordProviderUsageObservation = (observation) => {
      writes += 1;
      return { observation, status: "inserted" };
    };
    process.emit(
      ...Array.from({ length: PROVIDER_USAGE_PERSISTENCE_QUEUE_LIMIT }, (_, index) => rateLimitLine(
        `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
        index / 2_048,
      )),
      resultLine("done"),
    );
    await accountingCallbackReturned;
    expect(writes).toBe(0);
    expect(value.service.backgroundDiagnostics().last).toMatchObject({
      code: "provider_usage_queue_overflow",
      count: 1,
    });
    await value.service.settled();
    expect(writes).toBe(PROVIDER_USAGE_PERSISTENCE_QUEUE_LIMIT);
    expect(value.store.requireSession(started.session.id).state).toBe("idle");
  });

  test("stops an in-flight Claude turn through the same interrupt path", async () => {
    const value = await claudeFixture();
    const account = await authenticatedClaudeAccount(value, "Claude stop");
    const started = await value.service.execute({
      account,
      fast: false,
      kind: "session.start",
      preset: "fable-max",
      provider: "claude",
    }, { signal }) as { session: { id: `sess_${string}` } };
    const process = value.processes[0];
    if (process === undefined) throw new Error("Expected one pinned Claude process.");
    await value.service.execute({
      idempotencyKey: crypto.randomUUID(),
      kind: "session.send",
      message: "Start a long job",
      session: started.session.id,
    }, { signal });

    const stopped = await value.service.execute({
      idempotencyKey: crypto.randomUUID(),
      kind: "session.stop",
      session: started.session.id,
    }, { signal }) as { stopped: boolean };
    expect(stopped.stopped).toBe(true);
    expect(process.written.some((line) => line.includes("interrupt"))).toBe(true);

    process.emit(resultLine("stopped"));
    await settle();
    const bodies = await eventBodies(value, started.session.id);
    expect(bodies.find((body) => body.type === "turn_completed")).toMatchObject({
      status: "interrupted",
    });
  });

  test("resumes only the exact Claude session whose transport is lost without replaying its input", async () => {
    let observedDisconnect!: () => void;
    const disconnectObserved = new Promise<void>((resolve) => { observedDisconnect = resolve; });
    const value = await claudeFixture({
      onFactObserved: (fact) => {
        if (fact.type === "providerDisconnected") observedDisconnect();
      },
    });
    const account = await authenticatedClaudeAccount(value, "Claude transport loss");
    const idle = await value.service.execute({
      account,
      fast: false,
      kind: "session.start",
      preset: "fable-max",
      provider: "claude",
    }, { signal }) as { session: { id: `sess_${string}` } };
    const active = await value.service.execute({
      account,
      fast: false,
      kind: "session.start",
      preset: "fable-max",
      provider: "claude",
    }, { signal }) as { session: { id: `sess_${string}` } };
    const sendKey = crypto.randomUUID();
    await value.service.execute({
      idempotencyKey: sendKey,
      kind: "session.send",
      message: "Keep working",
      session: active.session.id,
    }, { signal });
    const profileBefore = value.store.requireProfile(account);
    const claudeBefore = value.store.requireProviderAccountAuthority(account, "claude");
    const capturedBefore = value.store.requireSessionProviderAuthority(active.session.id);
    const acceptedBefore = value.store.readMutation(sendKey);
    const idleBefore = value.store.requireSession(idle.session.id);
    const activeProcess = value.processes[1];
    if (activeProcess === undefined) throw new Error("Expected the active Claude process.");
    const joins: Array<Readonly<{ thread: string; processCount: number }>> = [];
    const endSession = value.runtime.endSession.bind(value.runtime);
    value.runtime.endSession = async (input) => {
      await endSession(input);
      joins.push({ thread: input.providerThreadId, processCount: value.processes.length });
    };
    const diagnostics: unknown[] = [];
    const recordDiagnostic = value.service.recordBackgroundDiagnostic.bind(value.service);
    value.service.recordBackgroundDiagnostic = (code, error) => {
      diagnostics.push({ code, error });
      recordDiagnostic(code, error);
    };

    activeProcess.terminate();
    // The reader first emits abandoned-turn facts, then its disconnect. Join
    // that exact boundary before joining the daemon's recovery work.
    await disconnectObserved;
    await value.service.settled();

    const resumed = value.store.requireSession(active.session.id);
    expect(resumed.state).toBe("idle");
    expect(resumed.activeTurnId).toBeUndefined();
    expect(value.store.requireSession(idle.session.id)).toEqual(idleBefore);
    expect(value.store.requireProviderAccountAuthority(account, "claude")).toEqual(claudeBefore);
    expect(value.store.requireSessionProviderAuthority(active.session.id)).toEqual(capturedBefore);
    expect(value.store.readMutation(sendKey)).toEqual(acceptedBefore);
    expect(diagnostics).toEqual([]);
    expect(joins).toEqual([{ thread: activeProcess.providerThreadId, processCount: 2 }]);
    expect(value.processes).toHaveLength(3);
    const replacement = value.processes[2];
    if (replacement === undefined || resumed.providerThreadId === undefined) {
      throw new Error("Expected the exact-thread replacement Claude process.");
    }
    expect(replacement.providerThreadId).toBe(activeProcess.providerThreadId);
    expect(replacement.terminated).toBe(false);
    expect(replacement.written.some((line) => line.includes("Keep working"))).toBe(false);
    expect(value.processes[0]?.terminated).toBe(false);
    expect(value.store.readClaudeProcessAuthority({
      profileId: account, providerThreadId: resumed.providerThreadId, runtimeScope: "managed",
    })).toMatchObject({
      identity: await replacement.identity, providerAuthority: claudeBefore,
      sessionId: active.session.id, state: "bound",
    });
    expect(value.store.requireProfile(account).processGeneration)
      .toBe(profileBefore.processGeneration);
    const events = await eventBodies(value, active.session.id);
    expect(events.some((body) =>
      body.type === "connection" && body.state === "disconnected"
    )).toBe(true);
    expect(events.some((body) =>
      body.type === "gap" && body.reason === "provider_disconnect"
    )).toBe(true);
    const idleEvents = await eventBodies(value, idle.session.id);
    expect(idleEvents.some((body) =>
      body.type === "connection" && body.state === "disconnected"
    )).toBe(false);
  });

  test("refuses an early Claude exit without committing a bound session or live launch", async () => {
    const value = await claudeFixture({ immediatelyEndProcess: true });
    const account = await authenticatedClaudeAccount(value, "Claude early transport loss");
    const providerBefore = value.store.requireProviderAccountAuthority(account, "claude");
    const key = crypto.randomUUID();
    const command = {
      account,
      fast: false,
      idempotencyKey: key,
      kind: "session.start" as const,
      preset: "fable-max" as const,
      provider: "claude" as const,
    };
    await expect(value.service.execute(command, { signal }))
      .rejects.toMatchObject({ code: "UNAVAILABLE" });
    await settle();
    await value.service.settled();
    expect(value.store.listSessions(50, account)).toEqual([]);
    expect(value.store.listClaudeProcessLaunchIntents()).toEqual([]);
    expect(value.store.listUnreleasedClaudeProcessAuthorities()).toEqual([]);
    expect(value.store.requireProviderAccountAuthority(account, "claude")).toEqual({
      ...providerBefore,
      bindingGeneration: providerBefore.bindingGeneration + 1,
      processGeneration: providerBefore.processGeneration + 1,
    });
    const failed = value.store.readMutation(key);
    expect(failed).toMatchObject({ state: "failed" });
    await expect(value.service.execute(command, { signal })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(value.store.readMutation(key)).toEqual(failed);
    expect(value.processes).toHaveLength(1);
    expect(value.processes[0]?.terminated).toBe(true);
  });

  test("refuses the Claude provider with the pinned version when no binary is admitted", async () => {
    const value = await claudeFixture({
      resolveRuntime: async () => {
        throw new Error("the pinned Claude Code executable is not installed");
      },
    });
    const account = await authenticatedClaudeAccount(value, "No binary");
    await expect(value.service.execute({
      account,
      fast: false,
      kind: "session.start",
      preset: "fable-max",
      provider: "claude",
    }, { signal })).rejects.toThrow(
      `Install Claude Code ${CLAUDE_PIN} exactly`,
    );
    // The refusal left no half-started durable session behind.
    expect(value.store.listSessions(50, undefined, true)).toHaveLength(0);
  });

  test("refuses Codex-only capabilities on a Claude session by name", async () => {
    const value = await claudeFixture();
    const account = await authenticatedClaudeAccount(value, "Claude capabilities");
    const started = await value.service.execute({
      account,
      fast: false,
      kind: "session.start",
      preset: "fable-max",
      provider: "claude",
    }, { signal }) as { session: { id: `sess_${string}` } };
    await expect(value.service.execute({
      idempotencyKey: crypto.randomUUID(),
      kind: "session.rename",
      name: "Renamed",
      session: started.session.id,
    }, { signal })).rejects.toThrow("The claude provider does not support renaming");
  });

  test("feeds the live uploader exactly as a Codex session does", async () => {
    const value = await claudeFixture();
    const account = await authenticatedClaudeAccount(value, "Claude live");
    const started = await value.service.execute({
      account,
      fast: false,
      kind: "session.start",
      preset: "fable-max",
      provider: "claude",
    }, { signal }) as { session: { id: `sess_${string}` } };
    const process = value.processes[0];
    if (process === undefined) throw new Error("Expected one pinned Claude process.");
    const sent = await value.service.execute({
      idempotencyKey: crypto.randomUUID(),
      kind: "session.send",
      message: "Say hello",
      session: started.session.id,
    }, { signal }) as { turnId: string };
    process.emit(assistantLine("Hello there", "msg_live"));
    process.emit(resultLine("Hello there"));
    await settle();

    // The uploader is fed the daemon's own ledger rows. It has no provider
    // knowledge at all, so this is the proof that a Claude session reaches the
    // hosted `detail` stream through the identical path.
    const listed = value.store.listSessionEvents({
      afterSequence: null,
      limit: 200,
      sessionId: started.session.id,
    });
    const batcher = new LiveBatcher({ includeThinking: false });
    for (const event of listed.events as readonly SessionEvent[]) batcher.observe(event);
    const batch = batcher.drain();
    expect(batch.flush).toBe(true);
    // A `turn_completed` closes every open stream and forces the flush rather
    // than shipping a body of its own, exactly as it does for Codex.
    expect(batch.bodies.map((body) => body.type as string)).toContain("turn_started");
    const delta = batch.bodies.find((body) => body.type === "assistant_delta");
    expect(delta).toMatchObject({ text: "Hello there" });
    expect(JSON.stringify(batch.bodies)).not.toContain(sent.turnId);
    expect(batch.bodies.some((body) => body.type === "session_state")).toBe(true);
  });
});
