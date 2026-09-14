import { describe, expect, test } from "bun:test";

import fc from "fast-check";

import {
  commandEnvelopeSchema,
  localCommandPresetContract,
  LOCAL_COMMAND_REQUEST_VERSION,
  localCommandSchema,
  type LocalCommand,
} from "./contracts";
import { presetRequirements } from "./presets";
import { WORK_APPLY_REQUEST_VERSION } from "./work";
import { canTransitionMutation, mutationStateSchema } from "./transitions";
import { selectByIdOrLabel, utf8Bytes } from "./values";

describe("domain laws", () => {
  test("owns one exact reduced preset mapping", () => {
    expect(presetRequirements).toEqual({
      low: { model: "gpt-5.6-luna", effort: "max" },
      high: { model: "gpt-6-astra", effort: "max" },
      ultra: { model: "gpt-6-astra", effort: "ultra" },
      "fable-max": { model: "claude-fable-5-1", effort: "max" },
      astra: { model: "gpt-6-astra", effort: "provider-default" },
    });
  });

  test("command parsing is total for arbitrary JSON-like input", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        expect(() => localCommandSchema.safeParse(value)).not.toThrow();
      }),
      { numRuns: 1_000 },
    );
  });

  test("admits a predecessor attachment name only on keyed local send or steer", () => {
    const attachment = {
      byteLength: 4,
      digest: "a".repeat(64),
      mediaType: "text/plain",
      name: `legacy${String.fromCodePoint(0x2028)}notes.txt`,
    };
    const key = "00000000-0000-4000-8000-000000000002";
    for (const kind of ["session.send", "session.steer"] as const) {
      const command = {
        attachments: [attachment],
        idempotencyKey: key,
        kind,
        message: "continue",
        session: "session",
      };
      expect(localCommandSchema.safeParse(command).success).toBe(true);
      expect(localCommandSchema.safeParse({ ...command, idempotencyKey: undefined }).success)
        .toBe(false);
    }
    expect(localCommandSchema.safeParse({
      attachments: [attachment],
      idempotencyKey: key,
      kind: "session.queue",
      message: "continue",
      session: "session",
    }).success).toBe(false);
  });

  test("requires one UUIDv7 caller key for device mutations in commands and envelopes", () => {
    const capability = "a".repeat(43);
    const requestId = "00000000-0000-4000-8000-000000000001";
    const idempotencyKey = "018bcfe5-6800-7000-8000-000000000001";
    const command = {
      device: "device_target",
      fingerprint: "0000-1111-2222-3333-4444-5555-6666-7777",
      idempotencyKey,
      kind: "device.approve",
    };

    expect(localCommandSchema.safeParse(command).success).toBe(true);
    expect(commandEnvelopeSchema.safeParse({
      capability,
      command,
      requestId,
      version: LOCAL_COMMAND_REQUEST_VERSION,
    }).success)
      .toBe(true);
    expect(commandEnvelopeSchema.safeParse({ capability, command, requestId, version: 1 }).success)
      .toBe(false);
    for (const invalidCommand of [
      { device: "device_target", fingerprint: "0000-1111-2222-3333-4444-5555-6666-7777", kind: "device.approve" },
      {
        device: "device_target",
        idempotencyKey: "00000000-0000-4000-8000-000000000001",
        kind: "device.revoke",
      },
    ]) {
      expect(localCommandSchema.safeParse(invalidCommand).success).toBe(false);
      expect(commandEnvelopeSchema.safeParse({
        capability,
        command: invalidCommand,
        requestId,
        version: LOCAL_COMMAND_REQUEST_VERSION,
      }).success).toBe(false);
    }
  });

  test("fences only local envelopes that can select a rebound Codex preset", () => {
    const capability = "a".repeat(43);
    const requestId = "00000000-0000-4000-8000-000000000001";
    const accountId = `acct_${"a".repeat(32)}`;
    const projectId = `proj_${"b".repeat(32)}`;
    const sessionId = `sess_${"c".repeat(32)}`;
    const parseCommand = (value: unknown): LocalCommand => localCommandSchema.parse(value);
    const lowOnlyWorkCreate = parseCommand({
      kind: "work.apply",
      requestId,
      operation: {
        kind: "work.create",
        idempotencyKey: "018bcfe5-6800-7000-8000-000000000001",
        clientRef: "local-contract-work",
        coordinatorSessionId: sessionId,
        objective: "Prove the local rollout contract.",
        routes: [{ accountId, projectId, preset: "low", fast: false }],
        tasks: [{
          clientRef: "local-contract-task",
          dependsOnRefs: [],
          dependsOnTaskIds: [],
          objective: "Run one bounded task.",
          instructions: "Preserve the immutable Work contract.",
          criteria: ["The focused contract test passes."],
          route: { accountId, projectId },
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
    if (lowOnlyWorkCreate.kind !== "work.apply" || lowOnlyWorkCreate.operation.kind !== "work.create") {
      throw new Error("Expected the Low-only Work creation fixture.");
    }
    const declaredHighWorkCreate = parseCommand({
      ...lowOnlyWorkCreate,
      operation: {
        ...lowOnlyWorkCreate.operation,
        idempotencyKey: "018bcfe5-6800-7000-8000-000000000003",
        clientRef: "local-contract-high-work",
        routes: [
          ...lowOnlyWorkCreate.operation.routes,
          { accountId, projectId, preset: "high", fast: false },
        ],
      },
    });
    const existingHighRouteTaskAdd = parseCommand({
      kind: "work.apply",
      requestId,
      operation: {
        kind: "task.addBatch",
        idempotencyKey: "018bcfe5-6800-7000-8000-000000000004",
        workId: `work_${"f".repeat(32)}`,
        expectedWorkRevision: 1,
        coordinatorSessionId: sessionId,
        coordinatorCapability: `hrac1_${"A".repeat(43)}`,
        tasks: [{
          ...lowOnlyWorkCreate.operation.tasks[0],
          clientRef: "local-contract-added-high-task",
          preset: "high",
        }],
      },
    });
    if (
      existingHighRouteTaskAdd.kind !== "work.apply"
      || existingHighRouteTaskAdd.operation.kind !== "task.addBatch"
    ) {
      throw new Error("Expected the High task-add fixture.");
    }
    const existingLowRouteTaskAdd = parseCommand({
      ...existingHighRouteTaskAdd,
      operation: {
        ...existingHighRouteTaskAdd.operation,
        idempotencyKey: "018bcfe5-6800-7000-8000-000000000005",
        tasks: existingHighRouteTaskAdd.operation.tasks.map((task) => ({
          ...task,
          clientRef: "local-contract-added-low-task",
          preset: "low",
        })),
      },
    });
    const existingWorkJoin = parseCommand({
      kind: "work.apply",
      requestId,
      operation: {
        kind: "work.join",
        idempotencyKey: "018bcfe5-6800-7000-8000-000000000002",
        workId: `work_${"d".repeat(32)}`,
        coordinatorSessionId: sessionId,
        coordinatorCapability: `hrac1_${"A".repeat(43)}`,
        actorSessionId: `sess_${"e".repeat(32)}`,
      },
    });
    const affected = [
      parseCommand({ kind: "session.start", account: accountId, preset: "high", fast: false, presetContract: 2 }),
      parseCommand({ kind: "session.start", account: accountId, preset: "ultra", fast: false, presetContract: 2 }),
      parseCommand({ kind: "session.preset", session: sessionId, preset: "high" }),
      parseCommand({ kind: "session.switch", session: sessionId, provider: "codex", preset: "ultra", presetContract: 2 }),
      parseCommand({ kind: "session.switch", session: sessionId, provider: "codex", presetContract: 2 }),
      declaredHighWorkCreate,
      existingHighRouteTaskAdd,
    ];
    const stable = [
      parseCommand({ kind: "daemon.status" }),
      parseCommand({ kind: "daemon.stop" }),
      parseCommand({ kind: "session.start", account: accountId, preset: "low", fast: false }),
      parseCommand({ kind: "session.preset", session: sessionId, preset: "low" }),
      parseCommand({ kind: "session.switch", session: sessionId, provider: "codex", preset: "low" }),
      parseCommand({ kind: "session.switch", session: sessionId, provider: "claude" }),
      lowOnlyWorkCreate,
      existingLowRouteTaskAdd,
      existingWorkJoin,
    ];
    const envelope = (command: LocalCommand, presetContract?: 1 | 2) => ({
      capability,
      command,
      requestId,
      version: LOCAL_COMMAND_REQUEST_VERSION,
      ...(presetContract === undefined ? {} : { presetContract }),
    });

    for (const command of affected) {
      expect(localCommandPresetContract(command)).toBe(2);
      expect(localCommandSchema.safeParse({ ...command, presetContract: 2 }).success)
        .toBe(command.kind === "session.start" || command.kind === "session.switch");
      expect(commandEnvelopeSchema.safeParse(envelope(command)).success).toBe(false);
      expect(commandEnvelopeSchema.safeParse(envelope(command, 1)).success).toBe(false);
      expect(commandEnvelopeSchema.safeParse(envelope(command, 2)).success).toBe(true);
    }
    for (const command of stable) {
      expect(localCommandPresetContract(command)).toBeUndefined();
      expect(commandEnvelopeSchema.safeParse(envelope(command)).success).toBe(true);
      expect(commandEnvelopeSchema.safeParse(envelope(command, 2)).success).toBe(false);
    }
    const staleAuthoredStart = parseCommand({
      kind: "session.start",
      account: accountId,
      preset: "high",
      fast: false,
      presetContract: 1,
    });
    expect(commandEnvelopeSchema.safeParse(envelope(staleAuthoredStart, 2)).success).toBe(true);
    expect(commandEnvelopeSchema.safeParse(envelope(staleAuthoredStart, 1)).success).toBe(false);
    const staleAuthoredSwitch = parseCommand({
      kind: "session.switch",
      session: sessionId,
      provider: "codex",
      preset: "high",
      presetContract: 1,
    });
    expect(commandEnvelopeSchema.safeParse(envelope(staleAuthoredSwitch, 2)).success).toBe(true);
    expect(commandEnvelopeSchema.safeParse(envelope(staleAuthoredSwitch, 1)).success).toBe(false);
    const currentV2Work = parseCommand({
      ...declaredHighWorkCreate,
      requestVersion: WORK_APPLY_REQUEST_VERSION,
      presetContract: 2,
    });
    const staleV2Work = parseCommand({
      ...declaredHighWorkCreate,
      requestVersion: WORK_APPLY_REQUEST_VERSION,
      presetContract: 1,
    });
    expect(commandEnvelopeSchema.safeParse(envelope(currentV2Work, 2)).success).toBe(true);
    expect(commandEnvelopeSchema.safeParse(envelope(staleV2Work, 2)).success).toBe(true);
    expect(commandEnvelopeSchema.safeParse(envelope(staleV2Work, 1)).success).toBe(false);
    expect(localCommandSchema.safeParse({
      ...declaredHighWorkCreate,
      requestVersion: WORK_APPLY_REQUEST_VERSION,
    }).success).toBe(false);
    expect(localCommandSchema.safeParse({
      ...lowOnlyWorkCreate,
      requestVersion: WORK_APPLY_REQUEST_VERSION,
      presetContract: 2,
    }).success).toBe(false);
    expect(localCommandSchema.safeParse({
      ...declaredHighWorkCreate,
      presetContract: 2,
    }).success).toBe(false);
    expect(localCommandSchema.safeParse({
      kind: "session.start",
      account: accountId,
      preset: "low",
      fast: false,
      presetContract: 2,
    }).success).toBe(false);
  });

  test("binds the two-phase Claude login completion to one exact terminal outcome", () => {
    const base = {
      account: `acct_${"a".repeat(32)}`,
      attemptId: `attempt_${"b".repeat(32)}`,
      idempotencyKey: "00000000-0000-4000-8000-000000000301",
      kind: "account.claude-login.complete",
      providerGeneration: 7,
    } as const;
    expect(localCommandSchema.safeParse({
      ...base,
      outcome: { state: "joined", exitCode: 0, interruptedBy: null },
    }).success).toBe(true);
    expect(localCommandSchema.safeParse({
      ...base,
      outcome: { state: "not_started", reason: "spawn_failed" },
    }).success).toBe(true);
    expect(localCommandSchema.safeParse({
      ...base,
      outcome: { state: "not_started", reason: "preflight_stale" },
    }).success).toBe(true);
    expect(localCommandSchema.safeParse({
      ...base,
      outcome: { state: "not_started", reason: "interrupted_before_spawn", interruptedBy: "SIGINT" },
    }).success).toBe(true);
    for (const outcome of [
      { state: "joined", exitCode: 0 },
      { state: "not_started", reason: "unknown" },
      { state: "not_started", reason: "interrupted_before_spawn" },
      { state: "joined", exitCode: 0, interruptedBy: null, credential: "forbidden" },
    ]) expect(localCommandSchema.safeParse({ ...base, outcome }).success).toBe(false);
  });

  test("requires exact authority and an explicit child-exit acknowledgement to abandon Claude login", () => {
    const base = {
      account: `acct_${"a".repeat(32)}`,
      attemptId: `attempt_${"b".repeat(32)}`,
      idempotencyKey: "00000000-0000-4000-8000-000000000302",
      kind: "account.claude-login.abandon",
      providerGeneration: 7,
    } as const;
    expect(localCommandSchema.safeParse({
      ...base,
      acknowledgeChildExited: true,
    }).success).toBe(true);
    expect(localCommandSchema.safeParse(base).success).toBe(false);
    expect(localCommandSchema.safeParse({
      ...base,
      acknowledgeChildExited: false,
    }).success).toBe(false);
  });

  test("retires Devin login while retaining exact acknowledged cleanup authority", () => {
    const account = `acct_${"a".repeat(32)}`;
    const attemptId = `attempt_${"b".repeat(32)}`;
    const idempotencyKey = "00000000-0000-4000-8000-000000000303";
    expect(localCommandSchema.safeParse({
      account,
      idempotencyKey,
      kind: "account.devin-login.prepare",
      manualTokenFlow: true,
    }).success).toBe(false);
    expect(localCommandSchema.safeParse({
      account,
      idempotencyKey,
      kind: "account.devin-login.prepare",
    }).success).toBe(false);

    const completion = {
      account,
      attemptId,
      idempotencyKey,
      kind: "account.devin-login.complete",
      providerGeneration: 7,
    } as const;
    for (const outcome of [
      { state: "joined", exitCode: 0, interruptedBy: null },
      { state: "not_started", reason: "spawn_failed" },
      { state: "not_started", reason: "preflight_stale" },
      { state: "not_started", reason: "interrupted_before_spawn", interruptedBy: "SIGTERM" },
    ]) expect(localCommandSchema.safeParse({ ...completion, outcome }).success).toBe(false);
    expect(localCommandSchema.safeParse({
      ...completion,
      outcome: { state: "joined", exitCode: 0, interruptedBy: null, token: "forbidden" },
    }).success).toBe(false);

    const abandon = {
      account,
      attemptId,
      idempotencyKey,
      kind: "account.devin-login.abandon",
      providerGeneration: 7,
    } as const;
    expect(localCommandSchema.safeParse({ ...abandon, acknowledgeChildExited: true }).success)
      .toBe(true);
    expect(localCommandSchema.safeParse(abandon).success).toBe(false);
    expect(localCommandSchema.safeParse({ kind: "account.show", account, provider: "devin" }).success)
      .toBe(true);
    for (const command of [
      { kind: "session.start", account, provider: "devin", preset: "astra", fast: false },
      { kind: "session.start", account, provider: "codex", preset: "astra", fast: false },
      { kind: "session.preset", session: "legacy", preset: "astra" },
      { kind: "session.switch", session: "legacy", provider: "devin" },
    ]) expect(localCommandSchema.safeParse(command).success).toBe(false);
  });

  test("keeps owner memory commands on the same closed values as provider memory tools", () => {
    const idempotencyKey = "00000000-0000-4000-8000-000000000101";
    const remember = {
      kind: "memory.remember",
      session: "release",
      idempotencyKey,
      value: {
        key: "architecture.boundary",
        title: "Authority boundary",
        summary: "The coordinator owns memory access.",
        body: "Neither client selects an Oh store.",
      },
    };
    expect(localCommandSchema.safeParse(remember).success).toBe(true);
    expect(localCommandSchema.safeParse({
      kind: "memory.query",
      session: "release",
      value: { mode: "get", key: "architecture.boundary" },
    }).success).toBe(true);
    expect(localCommandSchema.safeParse({
      kind: "memory.explain",
      session: "release",
      value: { queryId: `memq_${"a".repeat(32)}`, row: 0 },
    }).success).toBe(true);
    for (const widened of [
      { ...remember, idempotencyKey: undefined },
      { ...remember, value: { ...remember.value, path: "/tmp/oh.sqlite" } },
      { ...remember, value: { ...remember.value, key: "Not A Key" } },
      {
        kind: "memory.query",
        session: "release",
        value: { mode: "list", programId: "arbitrary" },
      },
      {
        kind: "memory.status",
        session: "release",
        authorityDigest: "a".repeat(64),
      },
    ]) expect(localCommandSchema.safeParse(widened).success).toBe(false);
  });

  test("terminal mutation states are absorbing", () => {
    fc.assert(
      fc.property(fc.constantFrom("applied", "failed", "ambiguous", "cancelled", "reconciled"), fc.constantFrom(...mutationStateSchema.options), (from, to) => {
        expect(canTransitionMutation(from, to)).toBe(false);
      }),
    );
  });

  test("selection is exact-id first and otherwise uses one canonical Unicode label key", () => {
    const values = [
      { id: "acct_a", label: "Work" },
      { id: "acct_b", label: "work" },
      { id: "acct_c", label: "Personal" },
      { id: "acct_d", label: "Café" },
    ];
    expect(selectByIdOrLabel(values, "acct_b")).toEqual({ kind: "found", value: values[1]! });
    expect(selectByIdOrLabel(values, "WORK").kind).toBe("ambiguous");
    expect(selectByIdOrLabel(values, "personal")).toEqual({ kind: "found", value: values[2]! });
    expect(selectByIdOrLabel(values, "CAFE\u0301")).toEqual({ kind: "found", value: values[3]! });
  });

  test("UTF-8 byte accounting does not confuse code points with bytes", () => {
    expect(utf8Bytes("🙂".repeat(40))).toBe(160);
  });
});
