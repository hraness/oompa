import { afterEach, describe, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initializeStatePaths, resolveStatePaths } from "../storage/paths";
import { renderFailure } from "../cli/render";
import {
  commandResponseSchema,
  localCommandSchema,
  type CommandResponse,
  type LocalCommand,
} from "../domain/contracts";
import {
  WORK_APPLY_REQUEST_VERSION,
} from "../domain/work";
import {
  callLocalDaemon,
  callWithSafeAutostart,
  commandFailureBrand,
  DEFAULT_LOCAL_CONNECTION_IDLE_TIMEOUT_MS,
  DEFAULT_LOCAL_REQUEST_DEADLINE_MS,
  DEFAULT_LOCAL_REQUEST_HEADER_TIMEOUT_MS,
  LOCAL_TRANSPORT_COMMAND_SLOTS,
  LOCAL_TRANSPORT_LONG_POLL_SLOTS,
  LOCAL_TRANSPORT_PENDING_CONNECTION_LIMIT,
  LocalDaemonIndeterminateError,
  LocalDaemonServer,
  LocalDaemonShutdownTimeoutError,
  LocalDaemonUnavailableError,
} from "./local-transport";

const servers: LocalDaemonServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => server.close()));
});

async function statePaths(): Promise<ReturnType<typeof resolveStatePaths>> {
  const home = await realpath(await mkdtemp(join(tmpdir(), "hra-daemon-")));
  const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
  await initializeStatePaths(paths);
  return paths;
}

async function fixture(deadlineMs = 200): Promise<{ paths: ReturnType<typeof resolveStatePaths>; server: LocalDaemonServer }> {
  const paths = await statePaths();
  const server = await LocalDaemonServer.start({
    paths,
    deadlineMs,
    handler: async (command) => ({ command: command.kind }),
  });
  servers.push(server);
  return { paths, server };
}

async function until(predicate: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// Long polls and `doctor` block until the gate opens or the request aborts.
// `daemon.status` and `daemon.stop` answer immediately, as the real service does.
async function gatedFixture(): Promise<{
  paths: ReturnType<typeof resolveStatePaths>;
  server: LocalDaemonServer;
  entered: () => number;
  release: () => void;
}> {
  const paths = await statePaths();
  let entered = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const server = await LocalDaemonServer.start({
    paths,
    handler: async (command, context) => {
      if (!("waitMs" in command && command.waitMs > 0) && command.kind !== "doctor") {
        return { command: command.kind };
      }
      entered += 1;
      await Promise.race([
        gate,
        new Promise<void>((resolve) => {
          if (context.signal.aborted) resolve();
          else context.signal.addEventListener("abort", () => resolve(), { once: true });
        }),
      ]);
      return { command: command.kind };
    },
  });
  servers.push(server);
  return { paths, server, entered: () => entered, release };
}

const longPoll = { kind: "session.events", session: "sess_a", limit: 1, waitMs: 30_000 } as const;
const blockingCommand = { kind: "doctor", offline: false } as const;

const localContractAccountId = `acct_${"a".repeat(32)}`;
const localContractProjectId = `proj_${"b".repeat(32)}`;
const localContractSessionId = `sess_${"c".repeat(32)}`;

const parseLocalCommand = (value: unknown): LocalCommand => localCommandSchema.parse(value);

const lowOnlyWorkCreateCommand = (): LocalCommand => parseLocalCommand({
  kind: "work.apply",
  requestId: randomUUID(),
  operation: {
    kind: "work.create",
    idempotencyKey: "018bcfe5-6800-7000-8000-000000000011",
    clientRef: "local-transport-contract-work",
    coordinatorSessionId: localContractSessionId,
    objective: "Prove the local rollout contract.",
    routes: [{
      accountId: localContractAccountId,
      projectId: localContractProjectId,
      preset: "low",
      fast: false,
    }],
    tasks: [{
      clientRef: "local-transport-contract-task",
      dependsOnRefs: [],
      dependsOnTaskIds: [],
      objective: "Run one bounded task.",
      instructions: "Preserve the immutable Work contract.",
      criteria: ["The focused contract test passes."],
      route: { accountId: localContractAccountId, projectId: localContractProjectId },
      preset: "low",
      fast: false,
      priority: 0,
      maxAttempts: 1,
      requiredReviews: 0,
      resultKind: "text",
      minEvidence: 0,
    }],
  },
});

const declaredHighWorkCreateCommand = (): LocalCommand => {
  const lowOnly = lowOnlyWorkCreateCommand();
  if (lowOnly.kind !== "work.apply" || lowOnly.operation.kind !== "work.create") {
    throw new Error("Expected the Low-only Work creation fixture.");
  }
  return parseLocalCommand({
    ...lowOnly,
    operation: {
      ...lowOnly.operation,
      idempotencyKey: "018bcfe5-6800-7000-8000-000000000013",
      clientRef: "local-transport-contract-high-work",
      routes: [
        ...lowOnly.operation.routes,
        {
          accountId: localContractAccountId,
          projectId: localContractProjectId,
          preset: "high",
          fast: false,
        },
      ],
    },
  });
};

const existingHighRouteTaskAddCommand = (): LocalCommand => {
  const lowOnly = lowOnlyWorkCreateCommand();
  if (lowOnly.kind !== "work.apply" || lowOnly.operation.kind !== "work.create") {
    throw new Error("Expected the Low-only Work creation fixture.");
  }
  return parseLocalCommand({
    kind: "work.apply",
    requestId: randomUUID(),
    operation: {
      kind: "task.addBatch",
      idempotencyKey: "018bcfe5-6800-7000-8000-000000000014",
      workId: `work_${"f".repeat(32)}`,
      expectedWorkRevision: 1,
      coordinatorSessionId: localContractSessionId,
      coordinatorCapability: `hrac1_${"A".repeat(43)}`,
      tasks: [{
        ...lowOnly.operation.tasks[0],
        clientRef: "local-transport-added-high-task",
        preset: "high",
      }],
    },
  });
};

const existingLowRouteTaskAddCommand = (): LocalCommand => {
  const high = existingHighRouteTaskAddCommand();
  if (high.kind !== "work.apply" || high.operation.kind !== "task.addBatch") {
    throw new Error("Expected the High task-add fixture.");
  }
  return parseLocalCommand({
    ...high,
    operation: {
      ...high.operation,
      idempotencyKey: "018bcfe5-6800-7000-8000-000000000015",
      tasks: high.operation.tasks.map((task) => ({
        ...task,
        clientRef: "local-transport-added-low-task",
        preset: "low",
      })),
    },
  });
};

const existingWorkJoinCommand = (): LocalCommand => parseLocalCommand({
  kind: "work.apply",
  requestId: randomUUID(),
  operation: {
    kind: "work.join",
    idempotencyKey: "018bcfe5-6800-7000-8000-000000000012",
    workId: `work_${"d".repeat(32)}`,
    coordinatorSessionId: localContractSessionId,
    coordinatorCapability: `hrac1_${"A".repeat(43)}`,
    actorSessionId: `sess_${"e".repeat(32)}`,
  },
});

const versionedWorkCommand = (
  command: LocalCommand,
  presetContract?: 1 | 2,
): LocalCommand => {
  if (command.kind !== "work.apply") throw new Error("Expected a Work apply fixture.");
  return parseLocalCommand({
    ...command,
    requestVersion: WORK_APPLY_REQUEST_VERSION,
    ...(presetContract === undefined ? {} : { presetContract }),
  });
};

const sourceSemanticLocalCommands = (): readonly LocalCommand[] => [
  parseLocalCommand({
    kind: "session.start",
    account: localContractAccountId,
    provider: "codex",
    preset: "high",
    fast: false,
    presetContract: 2,
  }),
  parseLocalCommand({
    kind: "session.preset",
    session: localContractSessionId,
    preset: "ultra",
  }),
  parseLocalCommand({
    kind: "session.switch",
    session: localContractSessionId,
    provider: "codex",
    preset: "high",
    presetContract: 2,
  }),
  parseLocalCommand({
    kind: "session.switch",
    session: localContractSessionId,
    provider: "codex",
    presetContract: 2,
  }),
  declaredHighWorkCreateCommand(),
  existingHighRouteTaskAddCommand(),
];

const stableLocalCommands = (): readonly LocalCommand[] => [
  parseLocalCommand({ kind: "daemon.status" }),
  parseLocalCommand({ kind: "daemon.stop" }),
  parseLocalCommand({
    kind: "session.start",
    account: localContractAccountId,
    provider: "codex",
    preset: "low",
    fast: false,
  }),
  parseLocalCommand({
    kind: "session.preset",
    session: localContractSessionId,
    preset: "low",
  }),
  parseLocalCommand({
    kind: "session.switch",
    session: localContractSessionId,
    provider: "claude",
  }),
  lowOnlyWorkCreateCommand(),
  existingLowRouteTaskAddCommand(),
  existingWorkJoinCommand(),
];

async function callRawLocalDaemon(
  paths: ReturnType<typeof resolveStatePaths>,
  envelope: Readonly<Record<string, unknown>>,
): Promise<CommandResponse> {
  return await new Promise<CommandResponse>((resolve, reject) => {
    const socket = createConnection(paths.socket);
    let received = Buffer.alloc(0);
    let settled = false;
    const finish = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      operation();
    };
    const deadline = setTimeout(() => {
      finish(() => reject(new Error("Timed out waiting for the raw local response.")));
      socket.destroy();
    }, 1_000);
    socket.once("connect", () => socket.write(`${JSON.stringify(envelope)}\n`));
    socket.on("data", (chunk) => {
      received = Buffer.concat([
        received,
        Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
      ]);
      const newline = received.indexOf(0x0a);
      if (newline < 0) return;
      try {
        const response = commandResponseSchema.parse(
          JSON.parse(received.subarray(0, newline).toString("utf8")) as unknown,
        );
        finish(() => resolve(response));
      } catch (error: unknown) {
        finish(() => reject(error));
      } finally {
        socket.end();
      }
    });
    socket.once("error", (error) => finish(() => reject(error)));
    socket.once("close", () => finish(() => reject(
      new Error("The daemon closed without a raw local response."),
    )));
  });
}

describe("local daemon transport", () => {
  test("keeps the default deadline above the complete cold-session budget", () => {
    expect(DEFAULT_LOCAL_REQUEST_DEADLINE_MS).toBe(
      10_000 + 10_000 + 2 * (10_000 + 40_000) + 30_000 + 30_000,
    );
  });

  test("publishes the 16 command and 16 long-poll partition with bounded phase timeouts", () => {
    expect(LOCAL_TRANSPORT_COMMAND_SLOTS).toBe(16);
    expect(LOCAL_TRANSPORT_LONG_POLL_SLOTS).toBe(16);
    expect(LOCAL_TRANSPORT_COMMAND_SLOTS + LOCAL_TRANSPORT_LONG_POLL_SLOTS).toBe(32);
    expect(LOCAL_TRANSPORT_PENDING_CONNECTION_LIMIT).toBe(32);
    expect(DEFAULT_LOCAL_REQUEST_HEADER_TIMEOUT_MS).toBe(5_000);
    expect(DEFAULT_LOCAL_CONNECTION_IDLE_TIMEOUT_MS).toBe(10_000);
    expect(DEFAULT_LOCAL_REQUEST_HEADER_TIMEOUT_MS).toBeLessThan(DEFAULT_LOCAL_REQUEST_DEADLINE_MS);
    expect(DEFAULT_LOCAL_CONNECTION_IDLE_TIMEOUT_MS).toBeLessThan(DEFAULT_LOCAL_REQUEST_DEADLINE_MS);
  });

  test("rejects out-of-bound transport timeouts before publishing an endpoint", async () => {
    const paths = await statePaths();
    const handler = async () => ({});
    await expect(LocalDaemonServer.start({ paths, handler, headerTimeoutMs: 0 })).rejects.toThrow(
      "Local transport timeouts must be positive integers within one hour.",
    );
    await expect(LocalDaemonServer.start({ paths, handler, idleTimeoutMs: 3_600_001 })).rejects.toThrow(
      "Local transport timeouts must be positive integers within one hour.",
    );
    await expect(LocalDaemonServer.start({ paths, handler, deadlineMs: 1.5 })).rejects.toThrow(
      "Local transport timeouts must be positive integers within one hour.",
    );
    await expect(callLocalDaemon({ paths, command: { kind: "daemon.status" }, deadlineMs: 20 })).rejects.toBeInstanceOf(LocalDaemonUnavailableError);
  });

  test("accepts one authenticated bounded command and reports transport occupancy in daemon.status", async () => {
    const { paths } = await fixture();
    expect(await callLocalDaemon({ paths, command: { kind: "daemon.status" } })).toEqual({
      ok: true,
      version: 1,
      requestId: expect.any(String),
      data: {
        command: "daemon.status",
        transport: {
          commandSlots: { inUse: 1, capacity: 16 },
          longPollSlots: { inUse: 0, capacity: 16 },
          pendingConnections: { inUse: 0, capacity: 32 },
          rejectedSinceStart: { command: 0, longPoll: 0, pending: 0 },
        },
      },
    });
    expect(await callLocalDaemon({ paths, command: { kind: "account.list" } })).toMatchObject({
      ok: true,
      data: { command: "account.list" },
    });
    expect((await readFile(paths.capability, "utf8")).trim()).toHaveLength(43);
  });

  test("marks source-semantic commands so an older strict daemon rejects them but still serves status and stop", async () => {
    const paths = await statePaths();
    const capability = randomBytes(32).toString("base64url");
    await writeFile(paths.capability, `${capability}\n`, { mode: 0o600 });
    const requests: Array<Readonly<Record<string, unknown>>> = [];
    const legacyServer = createServer((socket) => {
      let received = Buffer.alloc(0);
      socket.on("data", (chunk) => {
        received = Buffer.concat([
          received,
          Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
        ]);
        const newline = received.indexOf(0x0a);
        if (newline < 0) return;
        const parsed = JSON.parse(received.subarray(0, newline).toString("utf8")) as unknown;
        const record = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
          ? parsed as Readonly<Record<string, unknown>>
          : {};
        requests.push(record);
        const command = typeof record.command === "object"
          && record.command !== null
          && !Array.isArray(record.command)
          ? record.command as Readonly<Record<string, unknown>>
          : {};
        // This is the prior strict top-level schema: command validation is
        // also strict, so either an additive envelope key or a v2 Work
        // command-source key is rejected.
        const legacyAccepted = JSON.stringify(Object.keys(record).sort())
            === JSON.stringify(["capability", "command", "requestId", "version"])
          && record.version === 2
          && record.capability === capability
          && typeof record.requestId === "string"
          && localCommandSchema.safeParse(record.command).success
          && !(command.kind === "work.apply" && (
            Object.hasOwn(command, "requestVersion")
            || Object.hasOwn(command, "presetContract")
          ));
        socket.end(`${JSON.stringify(legacyAccepted
          ? {
              ok: true,
              version: 1,
              requestId: record.requestId,
              data: { legacyAccepted: true },
            }
          : {
              ok: false,
              version: 1,
              requestId: record.requestId,
              error: {
                code: "INVALID_INPUT",
                message: "The local command was rejected as invalid.",
              },
            })}\n`);
      });
    });
    await new Promise<void>((resolve, reject) => {
      legacyServer.once("error", reject);
      legacyServer.listen(paths.socket, resolve);
    });
    await chmod(paths.socket, 0o600);
    try {
      const affected = sourceSemanticLocalCommands();
      const stable = stableLocalCommands();
      for (const command of affected) {
        expect(await callLocalDaemon({ paths, command })).toMatchObject({
          ok: false,
          error: { code: "INVALID_INPUT" },
        });
      }
      for (const command of stable) {
        expect(await callLocalDaemon({ paths, command })).toMatchObject({
          ok: true,
          data: { legacyAccepted: true },
        });
      }
      for (const request of requests.slice(0, affected.length)) {
        expect(request.presetContract).toBe(2);
      }
      for (const request of requests.slice(affected.length)) {
        expect(Object.hasOwn(request, "presetContract")).toBe(false);
      }
      const stableV2 = versionedWorkCommand(existingWorkJoinCommand());
      expect(await callLocalDaemon({ paths, command: stableV2 })).toMatchObject({
        ok: false,
        error: { code: "INVALID_INPUT" },
      });
      expect(Object.hasOwn(requests.at(-1) ?? {}, "presetContract")).toBe(false);
    } finally {
      await new Promise<void>((resolve) => legacyServer.close(() => resolve()));
      await Promise.all([
        unlink(paths.socket).catch(() => undefined),
        unlink(paths.capability).catch(() => undefined),
      ]);
    }
  });

  test("rejects old or stale source-semantic envelopes before handler effects while accepting stable old envelopes", async () => {
    const paths = await statePaths();
    const handled: LocalCommand[] = [];
    const server = await LocalDaemonServer.start({
      paths,
      handler: async (command) => {
        handled.push(command);
        return { command: command.kind };
      },
    });
    servers.push(server);
    const capability = (await readFile(paths.capability, "utf8")).trim();
    const envelope = (
      command: LocalCommand,
      presetContract?: 1 | 2,
    ): Readonly<Record<string, unknown>> => ({
      version: 2,
      capability,
      requestId: randomUUID(),
      ...(presetContract === undefined ? {} : { presetContract }),
      command,
    });
    const affected = sourceSemanticLocalCommands();
    for (const command of affected) {
      expect(await callRawLocalDaemon(paths, envelope(command))).toMatchObject({ ok: false });
      expect(await callRawLocalDaemon(paths, envelope(command, 1))).toMatchObject({ ok: false });
    }
    const oldUnauthoredStart = parseLocalCommand({
      account: localContractAccountId,
      fast: false,
      kind: "session.start",
      preset: "high",
      provider: "codex",
    });
    expect(await callRawLocalDaemon(paths, envelope(oldUnauthoredStart)))
      .toMatchObject({ ok: false });
    expect(await callRawLocalDaemon(paths, envelope(oldUnauthoredStart, 2)))
      .toMatchObject({ ok: false });
    expect(handled).toEqual([]);

    for (const command of affected) {
      expect(await callRawLocalDaemon(paths, envelope(command, 2))).toMatchObject({ ok: true });
    }
    const affectedHandled = handled.length;
    expect(affectedHandled).toBe(affected.length);

    const staleAuthoredStart = parseLocalCommand({
      ...affected[0]!,
      presetContract: 1,
    });
    expect(await callRawLocalDaemon(paths, envelope(staleAuthoredStart, 2)))
      .toMatchObject({ ok: true });
    expect(handled.at(-1)).toEqual(staleAuthoredStart);
    expect(await callRawLocalDaemon(paths, envelope(staleAuthoredStart, 1)))
      .toMatchObject({ ok: false });

    const staleAuthoredSwitch = parseLocalCommand({
      ...affected[2]!,
      presetContract: 1,
    });
    expect(await callRawLocalDaemon(paths, envelope(staleAuthoredSwitch, 2)))
      .toMatchObject({ ok: true });
    expect(handled.at(-1)).toEqual(staleAuthoredSwitch);
    expect(await callRawLocalDaemon(paths, envelope(staleAuthoredSwitch, 1)))
      .toMatchObject({ ok: false });

    const stable = stableLocalCommands();
    for (const command of stable) {
      expect(await callRawLocalDaemon(paths, envelope(command))).toMatchObject({ ok: true });
    }
    expect(handled).toHaveLength(affected.length + stable.length + 2);
    expect(await callRawLocalDaemon(paths, envelope(stable[2]!, 2))).toMatchObject({ ok: false });
    expect(handled).toHaveLength(affected.length + stable.length + 2);

    // The envelope marker is the build's active contract (2, Astra) even when
    // the Work document itself declares its own route contract.
    const staleV2 = versionedWorkCommand(declaredHighWorkCreateCommand(), 2);
    expect(await callRawLocalDaemon(paths, envelope(staleV2, 2))).toMatchObject({ ok: true });
    expect(handled.at(-1)).toEqual(staleV2);
    expect(await callRawLocalDaemon(paths, envelope(staleV2, 1))).toMatchObject({ ok: false });

    const stableV2 = versionedWorkCommand(existingWorkJoinCommand());
    expect(await callRawLocalDaemon(paths, envelope(stableV2))).toMatchObject({ ok: true });
    expect(handled.at(-1)).toEqual(stableV2);
  });

  test("keeps daemon.status, daemon.stop, and shutdown admissible under 32 concurrent long polls", async () => {
    const { paths, server, entered } = await gatedFixture();
    const settled: CommandResponse[] = [];
    const polls = Array.from({ length: 32 }, async () => {
      try {
        const response = await callLocalDaemon({ paths, command: longPoll, deadlineMs: 5_000 });
        settled.push(response);
        return { status: "fulfilled" as const, response };
      } catch (error: unknown) {
        return { status: "rejected" as const, error };
      }
    });
    await until(() => entered() === 16 && settled.length === 16, "16 admitted and 16 rejected long polls");
    for (const response of settled) {
      expect(response).toEqual({
        ok: false,
        version: 1,
        requestId: expect.any(String),
        error: {
          code: "UNAVAILABLE",
          message: "The local daemon has no free long-poll slot. The poll was not started; wait briefly and poll again from the same cursor.",
          details: { reason: "local_long_poll_slots_exhausted", requestState: "not_started" },
        },
      });
    }
    expect(server.stats()).toMatchObject({
      commandSlots: { inUse: 0, capacity: 16 },
      longPollSlots: { inUse: 16, capacity: 16 },
      rejectedSinceStart: { command: 0, longPoll: 16, pending: 0 },
    });

    const started = Date.now();
    const status = await callLocalDaemon({ paths, command: { kind: "daemon.status" }, deadlineMs: 5_000 });
    expect(status).toMatchObject({
      ok: true,
      data: {
        command: "daemon.status",
        transport: { commandSlots: { inUse: 1 }, longPollSlots: { inUse: 16 }, rejectedSinceStart: { longPoll: 16 } },
      },
    });
    const stop = await callLocalDaemon({ paths, command: { kind: "daemon.stop" }, deadlineMs: 5_000 });
    expect(stop).toMatchObject({ ok: true, data: { command: "daemon.stop" } });
    if (!stop.ok) throw new Error("Expected daemon.stop to be admitted.");
    expect(stop.data).toEqual({ command: "daemon.stop" });
    expect(Date.now() - started).toBeLessThan(1_000);

    // Shutdown aborts the 16 parked long polls instead of waiting for them.
    const closing = Date.now();
    servers.splice(servers.indexOf(server), 1);
    await server.close({ deadlineMs: 2_000 });
    expect(Date.now() - closing).toBeLessThan(1_500);
    const outcomes = await Promise.all(polls);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(16);
    expect(server.stats()).toMatchObject({ commandSlots: { inUse: 0 }, longPollSlots: { inUse: 0 }, pendingConnections: { inUse: 0 } });
  });

  test("answers the 17th concurrent command with a closed UNAVAILABLE while long polls stay admissible", async () => {
    const { paths, server, entered, release } = await gatedFixture();
    const commands = Array.from({ length: 16 }, async () => await callLocalDaemon({ paths, command: blockingCommand, deadlineMs: 5_000 }));
    await until(() => entered() === 16, "16 admitted commands");

    const seventeenth = await callLocalDaemon({ paths, command: blockingCommand, deadlineMs: 5_000 });
    expect(seventeenth).toEqual({
      ok: false,
      version: 1,
      requestId: expect.any(String),
      error: {
        code: "UNAVAILABLE",
        message: "The local daemon has no free command slot. The command was not started; wait briefly and run the same command again.",
        details: { reason: "local_command_slots_exhausted", requestState: "not_started" },
      },
    });
    if (seventeenth.ok) throw new Error("Expected the closed saturation failure.");
    const stdout: string[] = [];
    const stderr: string[] = [];
    expect(renderFailure(seventeenth.error, false, {
      writeStdout: (value) => { stdout.push(value); },
      writeStderr: (value) => { stderr.push(value); },
    })).toBe(5);
    expect(stdout).toEqual([]);
    expect(stderr.join("")).toContain("oompa: The local daemon has no free command slot.");
    expect(stderr.join("")).not.toContain("uncertain");
    expect(stderr.join("")).not.toContain("replay");

    // A zero-wait read of a pollable kind is an ordinary command and shares the full pool.
    const zeroWait = await callLocalDaemon({ paths, command: { ...longPoll, waitMs: 0 }, deadlineMs: 5_000 });
    expect(zeroWait).toMatchObject({ ok: false, error: { code: "UNAVAILABLE", details: { reason: "local_command_slots_exhausted" } } });

    const poll = callLocalDaemon({ paths, command: longPoll, deadlineMs: 5_000 });
    await until(() => entered() === 17, "one long poll admitted beside full command slots");
    expect(server.stats()).toMatchObject({
      commandSlots: { inUse: 16, capacity: 16 },
      longPollSlots: { inUse: 1, capacity: 16 },
      rejectedSinceStart: { command: 2, longPoll: 0, pending: 0 },
    });

    release();
    const responses = await Promise.all([...commands, poll]);
    expect(responses.every((response) => response.ok)).toBe(true);
    await until(
      () => server.stats().commandSlots.inUse === 0 && server.stats().longPollSlots.inUse === 0,
      "slot release after the clients close",
    );
  });

  test("destroys a connection that does not complete its request frame within the header timeout", async () => {
    const paths = await statePaths();
    let handlerCalls = 0;
    const server = await LocalDaemonServer.start({
      paths,
      deadlineMs: 5_000,
      headerTimeoutMs: 50,
      handler: async () => {
        handlerCalls += 1;
        return {};
      },
    });
    servers.push(server);
    const socket = createConnection(paths.socket);
    socket.on("error", () => undefined);
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    socket.write("{\"version\":2,\"capability\":\"");
    await until(() => server.stats().pendingConnections.inUse === 1, "the pending connection");
    const started = Date.now();
    await new Promise<void>((resolve) => socket.once("close", () => resolve()));
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(handlerCalls).toBe(0);
    await until(() => server.stats().pendingConnections.inUse === 0, "pending release after the header timeout");
    expect(server.stats().rejectedSinceStart).toEqual({ command: 0, longPoll: 0, pending: 0 });
  });

  test("destroys a connection whose client stops reading the response past the idle timeout", async () => {
    const paths = await statePaths();
    let responded = 0;
    const server = await LocalDaemonServer.start({
      paths,
      deadlineMs: 5_000,
      idleTimeoutMs: 200,
      handler: async () => {
        responded += 1;
        // Larger than the kernel socket buffers, so the drain cannot finish
        // while the client is paused.
        return { payload: "x".repeat(3_500_000) };
      },
    });
    servers.push(server);
    const capability = (await readFile(paths.capability, "utf8")).trim();
    const socket = createConnection(paths.socket);
    socket.on("error", () => undefined);
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    socket.pause();
    socket.write(`${JSON.stringify({ version: 2, capability, requestId: randomUUID(), command: { kind: "daemon.stop" } })}\n`);
    await until(() => responded === 1, "the handler response");
    await new Promise((resolve) => setTimeout(resolve, 100));
    // The response is queued but undeliverable; the slot is still held before the idle timeout.
    expect(server.stats().commandSlots.inUse).toBe(1);
    const started = Date.now();
    await until(() => server.stats().commandSlots.inUse === 0, "slot release after the idle timeout");
    expect(Date.now() - started).toBeLessThan(1_500);
    socket.destroy();
  });

  test("closes connections beyond the pending pool immediately while earlier ones keep their header window", async () => {
    const paths = await statePaths();
    const server = await LocalDaemonServer.start({
      paths,
      deadlineMs: 5_000,
      headerTimeoutMs: 2_000,
      handler: async () => ({}),
    });
    servers.push(server);
    const sockets = await Promise.all(Array.from({ length: LOCAL_TRANSPORT_PENDING_CONNECTION_LIMIT }, async () => {
      const socket = createConnection(paths.socket);
      socket.on("error", () => undefined);
      await new Promise<void>((resolve) => socket.once("connect", resolve));
      return socket;
    }));
    try {
      await until(() => server.stats().pendingConnections.inUse === 32, "32 pending connections");
      const extra = createConnection(paths.socket);
      extra.on("error", () => undefined);
      const started = Date.now();
      await new Promise<void>((resolve) => extra.once("close", () => resolve()));
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(server.stats()).toMatchObject({
        pendingConnections: { inUse: 32, capacity: 32 },
        rejectedSinceStart: { command: 0, longPoll: 0, pending: 1 },
      });
    } finally {
      for (const socket of sockets) socket.destroy();
    }
    await until(() => server.stats().pendingConnections.inUse === 0, "pending release after the clients close");
  });

  test("rejects a syntactically valid response bound to another request", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "hra-daemon-")));
    const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
    await initializeStatePaths(paths);
    await writeFile(paths.capability, `${randomBytes(32).toString("base64url")}\n`, { mode: 0o600 });
    const secret = "HOSTILE_CROSS_REQUEST_SUCCESS";
    const raw = createServer((socket) => {
      let received = Buffer.alloc(0);
      socket.on("data", (chunk) => {
        received = Buffer.concat([
          received,
          Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
        ]);
        if (received.indexOf(0x0a) < 0) return;
        socket.end(`${JSON.stringify({
          ok: true,
          version: 1,
          requestId: randomUUID(),
          data: { accepted: secret },
        })}\n`);
      });
    });
    await new Promise<void>((resolve, reject) => {
      raw.once("error", reject);
      raw.listen(paths.socket, resolve);
    });
    await chmod(paths.socket, 0o600);
    try {
      await expect(callLocalDaemon({
        paths,
        command: { kind: "daemon.status" },
        deadlineMs: 1_000,
      })).rejects.toBeInstanceOf(LocalDaemonIndeterminateError);
    } finally {
      await new Promise<void>((resolve) => raw.close(() => resolve()));
      await unlink(paths.socket).catch(() => undefined);
    }
  });

  test("rejects a mismatched request protocol before entering the command handler", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "hra-daemon-")));
    const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
    await initializeStatePaths(paths);
    let handlerCalls = 0;
    const server = await LocalDaemonServer.start({
      paths,
      handler: async () => {
        handlerCalls += 1;
        return { executed: true };
      },
    });
    servers.push(server);
    const capability = (await readFile(paths.capability, "utf8")).trim();
    const requestId = randomUUID();
    const response = await new Promise<unknown>((resolve, reject) => {
      const socket = createConnection(paths.socket);
      let received = Buffer.alloc(0);
      let settled = false;
      const finish = (operation: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        operation();
      };
      const deadline = setTimeout(() => {
        finish(() => reject(new Error("Timed out waiting for the protocol-mismatch response.")));
        socket.destroy();
      }, 1_000);
      socket.once("connect", () => {
        socket.write(`${JSON.stringify({
          version: 1,
          capability,
          requestId,
          command: { kind: "daemon.status" },
        })}\n`);
      });
      socket.on("data", (chunk) => {
        received = Buffer.concat([
          received,
          Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
        ]);
        const newline = received.indexOf(0x0a);
        if (newline < 0) return;
        finish(() => resolve(JSON.parse(received.subarray(0, newline).toString("utf8")) as unknown));
        socket.end();
      });
      socket.once("error", (error) => finish(() => reject(error)));
      socket.once("close", () => finish(() => reject(
        new Error("The daemon closed without a protocol-mismatch response."),
      )));
    });

    expect(response).toMatchObject({
      ok: false,
      version: 1,
      requestId,
    });
    expect(handlerCalls).toBe(0);
  });

  test("closes unexpected daemon failures without returning runtime diagnostics", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "hra-daemon-")));
    const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
    await initializeStatePaths(paths);
    const secret = "OPAQUE_RUNTIME_SENTINEL_DO_NOT_RETURN";
    const server = await LocalDaemonServer.start({
      paths,
      handler: () => {
        throw Object.assign(
          new Error(`provider unavailable ${secret} at /private/runtime\u001b]52;c;attack\u0007`),
          { code: "UNAVAILABLE", details: { diagnostic: secret } },
        );
      },
    });
    servers.push(server);
    const response = await callLocalDaemon({ paths, command: { kind: "daemon.status" } });
    expect(response).toMatchObject({
      ok: false,
      error: {
        code: "INTERNAL",
        message: "The local request failed before a safe diagnostic was available.",
      },
    });
    expect(JSON.stringify(response)).not.toContain(secret);
    expect(JSON.stringify(response)).not.toContain("/private/runtime");
    expect(JSON.stringify(response)).not.toContain("\u001b");
  });

  test("maps declared command failures to closed messages without echoing their diagnostic", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "hra-daemon-")));
    const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
    await initializeStatePaths(paths);
    const secret = "DECLARED_FAILURE_SENTINEL_DO_NOT_RETURN";
    const server = await LocalDaemonServer.start({
      paths,
      handler: () => {
        throw Object.assign(new Error(`provider unavailable ${secret}`), {
          [commandFailureBrand]: true as const,
          code: "INTERACTION_REQUIRED" as const,
          details: {
            accountSelector: "acct_11111111111111111111111111111111",
            accountState: "signed_out",
            nextCommand: "oompa account login acct_11111111111111111111111111111111",
          },
        });
      },
    });
    servers.push(server);
    const response = await callLocalDaemon({ paths, command: { kind: "daemon.status" } });
    expect(response).toMatchObject({
      ok: false,
      error: {
        code: "INTERACTION_REQUIRED",
        details: {
          accountSelector: "acct_11111111111111111111111111111111",
          accountState: "signed_out",
          nextCommand: "oompa account login acct_11111111111111111111111111111111",
        },
        message: "The local command requires an explicit interaction.",
      },
    });
    expect(JSON.stringify(response)).not.toContain(secret);
  });

  test("renders provider-account recovery identically without controller provenance", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "hra-daemon-")));
    const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
    await initializeStatePaths(paths);
    const privateDiagnostics = [
      "personal-home account mismatch at /opt/oompa-fixture/personal/.codex runtimeScope=personal",
      "managed account revocation pending at /opt/oompa-fixture/managed/.oompa runtimeScope=managed",
    ];
    let calls = 0;
    const server = await LocalDaemonServer.start({
      paths,
      handler: () => {
        const diagnostic = privateDiagnostics[calls] ?? privateDiagnostics.at(-1);
        calls += 1;
        throw Object.assign(new Error(diagnostic), {
          [commandFailureBrand]: true as const,
          code: "RECOVERY_REQUIRED" as const,
          details: {
            accountId: "acct_11111111111111111111111111111111",
            provider: "codex",
          },
        });
      },
    });
    servers.push(server);

    const native = await callLocalDaemon({ paths, command: { kind: "daemon.status" } });
    const adopted = await callLocalDaemon({ paths, command: { kind: "daemon.status" } });
    if (native.ok || adopted.ok) throw new Error("Expected closed recovery failures.");
    expect(JSON.stringify(native.error)).toBe(JSON.stringify(adopted.error));
    expect(native.error).toEqual({
      code: "RECOVERY_REQUIRED",
      message: "The local command requires recovery before it can continue.",
      details: {
        accountId: "acct_11111111111111111111111111111111",
        provider: "codex",
      },
    });

    const rendered = [native.error, adopted.error].map((failure) => {
      const stdout: string[] = [];
      const stderr: string[] = [];
      expect(renderFailure(failure, false, {
        writeStdout: (value) => { stdout.push(value); },
        writeStderr: (value) => { stderr.push(value); },
      })).toBe(7);
      expect(stdout).toEqual([]);
      return stderr.join("");
    });
    expect(rendered[0]).toBe(rendered[1]);
    const exposed = `${JSON.stringify([native.error, adopted.error])}${rendered.join("")}`
      .toLowerCase();
    expect(exposed).not.toContain("personal");
    expect(exposed).not.toContain("managed");
    expect(exposed).not.toContain("runtimescope");
    expect(exposed).not.toContain("home");
  });

  test("preserves closed settled-rejection guidance across the local transport", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "hra-daemon-")));
    const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
    await initializeStatePaths(paths);
    const secret = "REMOTE_REJECTION_SENTINEL_DO_NOT_RETURN";
    const server = await LocalDaemonServer.start({
      paths,
      handler: () => {
        throw Object.assign(new Error(`provider rejected ${secret}`), {
          [commandFailureBrand]: true as const,
          code: "UNAVAILABLE" as const,
          details: {
            reason: "codex_remote_rejected",
            requestState: "settled",
          },
        });
      },
    });
    servers.push(server);

    const response = await callLocalDaemon({ paths, command: { kind: "daemon.status" } });
    expect(response).toEqual({
      ok: false,
      version: 1,
      requestId: expect.any(String),
      error: {
        code: "UNAVAILABLE",
        message: "Codex rejected the provider request. That request has settled; inspect current state before deciding whether a fresh attempt is appropriate.",
        details: {
          reason: "codex_remote_rejected",
          requestState: "settled",
        },
      },
    });
    expect(JSON.stringify(response)).not.toContain(secret);
    if (response.ok) throw new Error("Expected the closed settled-rejection failure.");
    const stdout: string[] = [];
    const stderr: string[] = [];
    expect(renderFailure(response.error, false, {
      writeStdout: (value) => { stdout.push(value); },
      writeStderr: (value) => { stderr.push(value); },
    })).toBe(5);
    expect(stdout).toEqual([]);
    expect(stderr.join("")).toContain(
      "oompa: Codex rejected the provider request. That request has settled; inspect current state before deciding whether a fresh attempt is appropriate.\n",
    );
  });

  test("uses an absolute client deadline", async () => {
    const { paths } = await fixture(5_000);
    const started = Date.now();
    await expect(callLocalDaemon({ paths, command: { kind: "daemon.status" }, deadlineMs: 20 })).resolves.toMatchObject({ ok: true });
    expect(Date.now() - started).toBeLessThan(200);
  });

  test("rejects an already-aborted client request before opening daemon dispatch", async () => {
    const { paths } = await fixture();
    const controller = new AbortController();
    const reason = new Error("cancelled before dispatch");
    controller.abort(reason);
    await expect(callLocalDaemon({
      paths,
      command: { kind: "daemon.status" },
      signal: controller.signal,
    })).rejects.toBe(reason);
  });

  test("destroys the client socket on abort so the daemon handler is canceled", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "hra-daemon-")));
    const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
    await initializeStatePaths(paths);
    let resolveEntered!: () => void;
    const entered = new Promise<void>((resolve) => { resolveEntered = resolve; });
    let resolveHandlerAbort!: () => void;
    const handlerAborted = new Promise<void>((resolve) => { resolveHandlerAbort = resolve; });
    const server = await LocalDaemonServer.start({
      paths,
      handler: async (_command, context) => {
        resolveEntered();
        await new Promise<void>((resolve) => {
          const aborted = () => {
            resolveHandlerAbort();
            resolve();
          };
          if (context.signal.aborted) aborted();
          else context.signal.addEventListener("abort", aborted, { once: true });
        });
        return { canceled: true };
      },
    });
    servers.push(server);
    const controller = new AbortController();
    const call = callLocalDaemon({
      paths,
      command: { kind: "daemon.status" },
      deadlineMs: 5_000,
      signal: controller.signal,
    });
    await entered;
    controller.abort(new Error("stop following"));
    await expect(call).rejects.toBeInstanceOf(LocalDaemonIndeterminateError);
    await handlerAborted;
  });

  test("closes admission and removes endpoint authority", async () => {
    const { paths, server } = await fixture();
    await server.close();
    servers.splice(servers.indexOf(server), 1);
    await expect(callLocalDaemon({ paths, command: { kind: "daemon.status" } })).rejects.toThrow();
  });

  test("runs shutdown callbacks only after the response flushes", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "hra-daemon-")));
    const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
    await initializeStatePaths(paths);
    let acknowledged = false;
    const server = await LocalDaemonServer.start({ paths, handler: async (_command, context) => {
      context.afterResponse(() => { acknowledged = true; });
      return { stopping: true };
    } });
    servers.push(server);
    expect(await callLocalDaemon({ paths, command: { kind: "daemon.stop" } })).toMatchObject({ ok: true, data: { stopping: true } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(acknowledged).toBe(true);
  });

  test("runs response callbacks once after a disconnected response becomes impossible", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "hra-daemon-")));
    const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
    await initializeStatePaths(paths);
    let releaseHandler!: () => void;
    let signalHandlerEntered!: () => void;
    let signalCallbackRan!: () => void;
    const handlerGate = new Promise<void>((resolve) => { releaseHandler = resolve; });
    const handlerEntered = new Promise<void>((resolve) => { signalHandlerEntered = resolve; });
    const callbackRan = new Promise<void>((resolve) => { signalCallbackRan = resolve; });
    let callbackCalls = 0;
    const server = await LocalDaemonServer.start({
      paths,
      handler: async (_command, context) => {
        context.afterResponse(() => {
          callbackCalls += 1;
          signalCallbackRan();
        });
        signalHandlerEntered();
        await handlerGate;
        return { stopping: true };
      },
    });
    servers.push(server);
    const controller = new AbortController();
    const call = callLocalDaemon({
      paths,
      command: { kind: "daemon.stop" },
      deadlineMs: 5_000,
      signal: controller.signal,
    });
    await handlerEntered;
    controller.abort(new Error("disconnect before the response"));
    await expect(call).rejects.toBeInstanceOf(LocalDaemonIndeterminateError);
    expect(callbackCalls).toBe(0);

    releaseHandler();
    await callbackRan;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(callbackCalls).toBe(1);
  });

  test("classifies an absent endpoint as unavailable before dispatch", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "hra-daemon-")));
    const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
    await initializeStatePaths(paths);
    await expect(callLocalDaemon({ paths, command: { kind: "daemon.status" }, deadlineMs: 20 })).rejects.toBeInstanceOf(LocalDaemonUnavailableError);
  });

  test("classifies reset after connect as indeterminate and never autostarts", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "hra-daemon-")));
    const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
    await initializeStatePaths(paths);
    await writeFile(paths.capability, `${randomBytes(32).toString("base64url")}\n`, { mode: 0o600 });
    let observed = false;
    const raw = createServer((socket) => {
      socket.once("data", () => {
        observed = true;
        socket.destroy();
      });
    });
    await new Promise<void>((resolve, reject) => {
      raw.once("error", reject);
      raw.listen(paths.socket, resolve);
    });
    await chmod(paths.socket, 0o600);
    let starts = 0;
    try {
      await expect(callWithSafeAutostart(
        async () => await callLocalDaemon({ paths, command: { kind: "daemon.status" }, deadlineMs: 100 }),
        async () => { starts += 1; },
      )).rejects.toBeInstanceOf(LocalDaemonIndeterminateError);
      expect(observed).toBe(true);
      expect(starts).toBe(0);
    } finally {
      await new Promise<void>((resolve) => raw.close(() => resolve()));
      await Promise.all([unlink(paths.socket).catch(() => undefined), unlink(paths.capability).catch(() => undefined)]);
    }
  });

  test("staged shutdown aborts admission and returns at an absolute join deadline", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "hra-daemon-")));
    const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
    await initializeStatePaths(paths);
    let resolveEntered!: () => void;
    const entered = new Promise<void>((resolve) => { resolveEntered = resolve; });
    const server = await LocalDaemonServer.start({
      paths,
      handler: async () => {
        resolveEntered();
        return await new Promise<never>(() => undefined);
      },
    });
    const call = callLocalDaemon({ paths, command: { kind: "daemon.status" }, deadlineMs: 1_000 }).catch((error: unknown) => error);
    await entered;
    const started = Date.now();
    await expect(server.close({ deadlineMs: 20 })).rejects.toBeInstanceOf(LocalDaemonShutdownTimeoutError);
    expect(Date.now() - started).toBeLessThan(250);
    expect(await call).toBeInstanceOf(LocalDaemonIndeterminateError);
  });
});
