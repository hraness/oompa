import { describe, expect, test } from "bun:test";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main } from "../cli";
import type { LocalCommand } from "../domain/contracts";
import {
  WORK_APPLY_REQUEST_LEGACY_VERSION,
  WORK_APPLY_REQUEST_VERSION,
  WORK_OPERATION_MAX_BYTES,
  WORK_PROTOCOL,
  WORK_PROTOCOL_REQUEST_MAX_BYTES,
  WORK_PROTOCOL_VERSION,
  workOperationSchema,
  type WorkOperation,
} from "../domain/work";
import { describeWorkProtocol } from "../domain/work-protocol";
import { LocalDaemonIndeterminateError } from "../daemon/local-transport";

const workId = `work_${"1".repeat(32)}` as const;
const actorSessionId = `sess_${"3".repeat(32)}` as const;
const idempotencyKey = "018f1f64-6c17-7d35-8f8e-b24a1d3a5211";
const requestId = "018f1f64-6c17-7d35-8f8e-b24a1d3a5333";
const capability = `hrac1_${"A".repeat(43)}`;

const operation: WorkOperation = {
  kind: "work.join",
  idempotencyKey,
  workId,
  coordinatorSessionId: actorSessionId,
  coordinatorCapability: capability,
  actorSessionId,
};
const reboundOperation: WorkOperation = {
  kind: "work.create",
  idempotencyKey,
  clientRef: "source-bound-work",
  coordinatorSessionId: actorSessionId,
  objective: "Preserve the request's model semantics.",
  routes: [{
    accountId: `acct_${"4".repeat(32)}`,
    projectId: `proj_${"5".repeat(32)}`,
    preset: "high",
    fast: false,
  }],
  tasks: [{
    clientRef: "source-bound-task",
    dependsOnRefs: [],
    dependsOnTaskIds: [],
    objective: "Prove source-bound admission.",
    instructions: "Run the focused contract test.",
    criteria: [],
    route: {
      accountId: `acct_${"4".repeat(32)}`,
      projectId: `proj_${"5".repeat(32)}`,
    },
    preset: "high",
    fast: false,
    priority: 0,
    maxAttempts: 1,
    requiredReviews: 0,
    resultKind: "text",
    minEvidence: 0,
  }],
};
const request = {
  protocol: WORK_PROTOCOL,
  version: WORK_APPLY_REQUEST_LEGACY_VERSION,
  requestId,
  operation,
} as const;

const result = {
  kind: "work.join" as const,
  workId,
  workRevision: 2,
  actorSessionId,
  memberCapability: capability,
};

const capture = () => {
  let stdout = "";
  let stderr = "";
  return {
    output: {
      writeStdout: (value: string) => { stdout += value; },
      writeStderr: (value: string) => { stderr += value; },
    },
    read: () => ({ stdout, stderr }),
  };
};

describe("agent-first work apply boundary", () => {
  test("keeps read-only work success and usage failures machine-readable by default", async () => {
    const success = capture();
    const commands: LocalCommand[] = [];
    expect(await main(["work", "protocol"], success.output, {
      callDaemon: (command) => {
        commands.push(command);
        return Promise.resolve({
          ok: true,
          version: 1,
          requestId: "018f1f64-6c17-7d35-8f8e-b24a1d3a5444",
          data: describeWorkProtocol({ kind: "index" }),
        });
      },
    })).toBe(0);
    // `work protocol` is a pure description served before any daemon call.
    expect(commands).toEqual([]);
    expect(success.read().stderr).toBe("");
    expect(success.read().stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(success.read().stdout)).toEqual({
      ok: true,
      version: 1,
      command: "work.protocol",
      data: describeWorkProtocol({ kind: "index" }),
    });

    for (const argv of [
      ["work", "protocol", "--human"],
      ["work", "protocol", "--idempotency-key", idempotencyKey],
      ["--idempotency-key", idempotencyKey, "work", "protocol"],
    ]) {
      const failure = capture();
      expect(await main(argv, failure.output)).toBe(2);
      expect(failure.read().stderr).toBe("");
      expect(failure.read().stdout.trim().split("\n")).toHaveLength(1);
      expect(JSON.parse(failure.read().stdout)).toMatchObject({
        ok: false,
        version: 1,
        error: { code: "INVALID_INPUT" },
      });
    }

    const streamFailure = capture();
    expect(await main(["work", "watch", "not-a-work-id"], streamFailure.output)).toBe(2);
    expect(streamFailure.read().stdout).toBe("");
    expect(streamFailure.read().stderr.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(streamFailure.read().stderr)).toMatchObject({
      ok: false,
      version: 1,
      error: { code: "INVALID_INPUT" },
    });
  });

  test("routes watch execution and its first-page failure through JSON Lines", async () => {
    const target = capture();
    const commands: LocalCommand[] = [];
    const secret = "PRIVATE-MALFORMED-WORK-EVENT-PAGE";
    expect(await main(["work", "watch", workId], target.output, {
      callDaemon: (command) => {
        commands.push(command);
        return Promise.resolve({
          ok: true,
          version: 1,
          requestId: "018f1f64-6c17-7d35-8f8e-b24a1d3a5666",
          data: { rawProviderPage: secret },
        });
      },
    })).toBe(1);
    expect(commands).toEqual([{
      kind: "work.events",
      work: workId,
      limit: 200,
      waitMs: 30_000,
    }]);
    expect(target.read().stdout).toBe("");
    expect(target.read().stderr.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(target.read().stderr)).toEqual({
      ok: false,
      version: 1,
      error: {
        code: "INTERNAL",
        message: "Oompa could not complete the request safely.",
      },
    });
    expect(target.read().stderr).not.toContain(secret);
  });

  test("refuses terminal JSON input before reading or dispatching", async () => {
    const target = capture();
    let reads = 0;
    let daemonCalls = 0;
    expect(await main([
      "work",
      "apply",
      "--input-stdin",
    ], target.output, {
      callDaemon: () => {
        daemonCalls += 1;
        throw new Error("must not dispatch");
      },
      isTerminalDescriptor: (descriptor) => {
        expect(descriptor).toBe(0);
        return true;
      },
      readProtectedDocument: () => {
        reads += 1;
        throw new Error("must not read");
      },
    })).toBe(6);
    expect(reads).toBe(0);
    expect(daemonCalls).toBe(0);
    expect(target.read().stderr).toBe("");
    expect(target.read().stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(target.read().stdout)).toEqual({
      protocol: WORK_PROTOCOL,
      version: WORK_APPLY_REQUEST_VERSION,
      requestId: null,
      ok: false,
      error: {
        code: "invalid_state",
        message: "Work operations require one bounded JSON document from non-terminal stdin or a file descriptor.",
        retryable: false,
        recovery: "none",
        exitCode: 6,
      },
    });
  });

  test("normalizes apply argv failures into a pre-admission work envelope", async () => {
    for (const argv of [
      ["work", "apply"],
      ["work", "apply", "--input-stdin", "--input-fd", "3"],
      ["work", "apply", "--unknown"],
    ]) {
      const target = capture();
      expect(await main(argv, target.output)).toBe(2);
      expect(target.read().stderr).toBe("");
      expect(JSON.parse(target.read().stdout)).toEqual({
        protocol: WORK_PROTOCOL,
        version: WORK_APPLY_REQUEST_VERSION,
        requestId: null,
        ok: false,
        error: {
          code: "invalid_request",
          message: "The work apply invocation is invalid.",
          retryable: false,
          recovery: "none",
          exitCode: 2,
        },
      });
    }
  });

  test("reads one strict document and sends the exact parsed operation", async () => {
    const target = capture();
    const commands: LocalCommand[] = [];
    expect(await main([
      "work",
      "apply",
      "--input-fd",
      "3",
    ], target.output, {
      isTerminalDescriptor: (descriptor) => {
        expect(descriptor).toBe(3);
        return false;
      },
      readProtectedDocument: (source) => {
        expect(source).toEqual({ fd: 3, kind: "fd" });
        return Promise.resolve(request);
      },
      callDaemon: (command) => {
        commands.push(command);
        return Promise.resolve({
          ok: true,
          version: 1,
          requestId: "018f1f64-6c17-7d35-8f8e-b24a1d3a5333",
          data: result,
        });
      },
    })).toBe(0);
    expect(commands).toEqual([{ kind: "work.apply", requestId, operation }]);
    expect(Object.keys(commands[0] ?? {}).sort()).toEqual(["kind", "operation", "requestId"]);
    expect(target.read().stderr).toBe("");
    expect(target.read().stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(target.read().stdout)).toEqual({
      protocol: WORK_PROTOCOL,
      version: WORK_APPLY_REQUEST_LEGACY_VERSION,
      requestId,
      ok: true,
      result,
    });
  });

  test("carries v2 source identity without rewriting the legacy inner command", async () => {
    const stableTarget = capture();
    const stableCommands: LocalCommand[] = [];
    expect(await main(["work", "apply", "--input-stdin"], stableTarget.output, {
      isTerminalDescriptor: () => false,
      readProtectedDocument: () => Promise.resolve({
        ...request,
        version: WORK_APPLY_REQUEST_VERSION,
      }),
      callDaemon: (command) => {
        stableCommands.push(command);
        return Promise.resolve({ ok: true, version: 1, requestId, data: result });
      },
    })).toBe(0);
    expect(stableCommands).toEqual([{
      kind: "work.apply",
      requestId,
      requestVersion: WORK_APPLY_REQUEST_VERSION,
      operation,
    }]);
    expect(JSON.parse(stableTarget.read().stdout)).toMatchObject({
      protocol: WORK_PROTOCOL,
      version: WORK_APPLY_REQUEST_VERSION,
      requestId,
      ok: true,
    });

    for (const presetContract of [1, 2] as const) {
      const target = capture();
      const commands: LocalCommand[] = [];
      expect(await main(["work", "apply", "--input-stdin"], target.output, {
        isTerminalDescriptor: () => false,
        readProtectedDocument: () => Promise.resolve({
          protocol: WORK_PROTOCOL,
          version: WORK_APPLY_REQUEST_VERSION,
          requestId,
          presetContract,
          operation: reboundOperation,
        }),
        callDaemon: (command) => {
          commands.push(command);
          return Promise.resolve({
            ok: false,
            version: 1,
            requestId,
            error: { code: "CONFLICT", message: "Fixture stops after source admission." },
          });
        },
      })).toBe(1);
      expect(commands).toEqual([{
        kind: "work.apply",
        requestId,
        requestVersion: WORK_APPLY_REQUEST_VERSION,
        presetContract,
        operation: reboundOperation,
      }]);
      expect(JSON.parse(target.read().stdout)).toMatchObject({
        version: WORK_APPLY_REQUEST_VERSION,
        requestId,
        ok: false,
      });
    }
  });

  test("admits schema-valid operation documents larger than the protected-value ceiling", async () => {
    const tasks = Array.from({ length: 5 }, (_, index) => ({
      clientRef: `task-${String(index)}`,
      dependsOnRefs: [],
      dependsOnTaskIds: [],
      objective: `Complete task ${String(index)}`,
      instructions: "x".repeat(16 * 1024),
      criteria: [],
      route: {
        accountId: `acct_${"4".repeat(32)}`,
        projectId: `proj_${"5".repeat(32)}`,
      },
      preset: "low",
      fast: false,
      priority: 0,
      maxAttempts: 3,
      requiredReviews: 0,
      resultKind: "text",
      minEvidence: 0,
    }));
    const largeOperation = workOperationSchema.parse({
      kind: "work.create",
      idempotencyKey,
      clientRef: "large-plan",
      coordinatorSessionId: actorSessionId,
      objective: "Verify the operation transport bound",
      routes: [{
        accountId: `acct_${"4".repeat(32)}`,
        projectId: `proj_${"5".repeat(32)}`,
        preset: "low",
        fast: false,
      }],
      tasks,
    });
    const largeRequest = {
      protocol: WORK_PROTOCOL,
      version: WORK_APPLY_REQUEST_LEGACY_VERSION,
      requestId,
      operation: largeOperation,
    } as const;
    const encoded = JSON.stringify(largeRequest);
    expect(Buffer.byteLength(encoded, "utf8")).toBeGreaterThan(64 * 1024);
    expect(Buffer.byteLength(encoded, "utf8")).toBeLessThanOrEqual(WORK_OPERATION_MAX_BYTES);
    expect(Buffer.byteLength(encoded, "utf8")).toBeLessThanOrEqual(WORK_PROTOCOL_REQUEST_MAX_BYTES);

    const temporary = await mkdtemp(join(tmpdir(), "oompa-work-operation-"));
    const path = join(temporary, "operation.json");
    await writeFile(path, encoded, { encoding: "utf8", mode: 0o600 });
    const handle = await open(path, "r");
    const commands: LocalCommand[] = [];
    const target = capture();
    try {
      expect(await main([
        "work",
        "apply",
        "--input-fd",
        String(handle.fd),
      ], target.output, {
        isTerminalDescriptor: () => false,
        callDaemon: (command) => {
          commands.push(command);
          return Promise.resolve({
            ok: false,
            version: 1,
            requestId: "018f1f64-6c17-7d35-8f8e-b24a1d3a5555",
            error: { code: "CONFLICT", message: "Fixture stopped after admission." },
          });
        },
      })).toBe(1);
    } finally {
      await handle.close();
      await rm(temporary, { force: true, recursive: true });
    }
    expect(commands).toHaveLength(1);
    expect(commands[0]).toEqual({ kind: "work.apply", requestId, operation: largeOperation });
    expect(JSON.parse(target.read().stdout)).toMatchObject({
      protocol: WORK_PROTOCOL,
      requestId,
      ok: false,
      error: { code: "conflict" },
    });
  });

  test("rejects apply input beyond the complete versioned-request ceiling", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "oompa-work-operation-overflow-"));
    const path = join(temporary, "operation.json");
    await writeFile(path, "x".repeat(WORK_PROTOCOL_REQUEST_MAX_BYTES + 1), {
      encoding: "utf8",
      mode: 0o600,
    });
    const handle = await open(path, "r");
    const target = capture();
    let daemonCalls = 0;
    try {
      expect(await main([
        "work",
        "apply",
        "--input-fd",
        String(handle.fd),
      ], target.output, {
        isTerminalDescriptor: () => false,
        callDaemon: () => {
          daemonCalls += 1;
          throw new Error("must not dispatch");
        },
      })).toBe(2);
    } finally {
      await handle.close();
      await rm(temporary, { force: true, recursive: true });
    }
    expect(daemonCalls).toBe(0);
    expect(target.read().stderr).toBe("");
    expect(JSON.parse(target.read().stdout)).toMatchObject({
      protocol: WORK_PROTOCOL,
      version: WORK_APPLY_REQUEST_VERSION,
      requestId: null,
      ok: false,
      error: {
        code: "invalid_request",
        message: "The work request input is not one bounded JSON document.",
        retryable: false,
        recovery: "none",
        exitCode: 2,
      },
    });
  });

  test("rejects extra or malformed document fields before daemon dispatch", async () => {
    const secret = "PRIVATE-UNPARSED-WORK-DOCUMENT";
    for (const fixture of [
      { document: { ...request, unexpected: secret }, expectedRequestId: null, expectedVersion: WORK_APPLY_REQUEST_VERSION },
      { document: { ...request, version: WORK_APPLY_REQUEST_VERSION, presetContract: 2 }, expectedRequestId: requestId, expectedVersion: WORK_APPLY_REQUEST_VERSION },
      { document: { ...request, version: WORK_APPLY_REQUEST_VERSION, operation: reboundOperation }, expectedRequestId: requestId, expectedVersion: WORK_APPLY_REQUEST_VERSION },
      { document: { ...request, version: WORK_APPLY_REQUEST_VERSION, presetContract: 2, operation: reboundOperation, unexpected: secret }, expectedRequestId: null, expectedVersion: WORK_APPLY_REQUEST_VERSION },
      { document: { ...request, operation: { ...operation, unexpected: secret } }, expectedRequestId: requestId, expectedVersion: WORK_APPLY_REQUEST_LEGACY_VERSION },
      { document: { ...request, operation: { ...operation, idempotencyKey: undefined } }, expectedRequestId: requestId, expectedVersion: WORK_APPLY_REQUEST_LEGACY_VERSION },
      { document: { ...request, operation: { ...operation, actorSessionId: "worker-one" } }, expectedRequestId: requestId, expectedVersion: WORK_APPLY_REQUEST_LEGACY_VERSION },
      {
        document: {
          ...request,
          operation: { kind: "work.join", workId, coordinatorSessionId: actorSessionId, actorSessionId },
        },
        expectedRequestId: requestId,
        expectedVersion: WORK_APPLY_REQUEST_LEGACY_VERSION,
      },
    ]) {
      const target = capture();
      let daemonCalls = 0;
      expect(await main([
        "work",
        "apply",
        "--input-stdin",
      ], target.output, {
        isTerminalDescriptor: () => false,
        readProtectedDocument: () => Promise.resolve(fixture.document),
        callDaemon: () => {
          daemonCalls += 1;
          throw new Error("must not dispatch");
        },
      })).toBe(2);
      expect(daemonCalls).toBe(0);
      expect(target.read().stderr).toBe("");
      expect(JSON.parse(target.read().stdout)).toMatchObject({
        protocol: WORK_PROTOCOL,
        version: fixture.expectedVersion,
        requestId: fixture.expectedRequestId,
        ok: false,
        error: {
          code: "invalid_request",
          message: "The work request document does not match the strict versioned Oompa work protocol.",
          retryable: false,
          recovery: "none",
          exitCode: 2,
        },
      });
      expect(target.read().stdout).not.toContain(secret);
    }
  });

  test("returns same-document replay authority after an indeterminate mutation", async () => {
    const target = capture();
    expect(await main([
      "work",
      "apply",
      "--input-stdin",
    ], target.output, {
      isTerminalDescriptor: () => false,
      readProtectedDocument: () => Promise.resolve(request),
      callDaemon: () => Promise.reject(
        new LocalDaemonIndeterminateError("private transport state"),
      ),
    })).toBe(7);
    expect(target.read().stderr).toBe("");
    expect(JSON.parse(target.read().stdout)).toEqual({
      protocol: WORK_PROTOCOL,
      version: WORK_PROTOCOL_VERSION,
      requestId,
      ok: false,
      error: {
        code: "effect_unknown",
        message: "The local transport outcome is uncertain; replay the exact same request document.",
        retryable: true,
        recovery: "replay_exact_request",
        exitCode: 7,
      },
    });
    expect(target.read().stdout).not.toContain("private transport state");
  });

  test("maps closed daemon reasons to exact work errors and authoritative exits", async () => {
    const fixtures = [
      { daemonCode: "CONFLICT", reason: "FENCE_MISMATCH", protocolCode: "fence_mismatch", recovery: "refresh_state_then_new_request", retryable: false, exitCode: 1 },
      { daemonCode: "CONFLICT", reason: "LEASE_EXPIRED", protocolCode: "lease_expired", recovery: "refresh_state_then_new_request", retryable: false, exitCode: 1 },
      { daemonCode: "CONFLICT", reason: "ATTEMPT_NOT_OWNER", protocolCode: "not_owner", recovery: "refresh_state_then_new_request", retryable: false, exitCode: 1 },
      { daemonCode: "CONFLICT", reason: "ROUTE_MISMATCH", protocolCode: "route_mismatch", recovery: "refresh_state_then_new_request", retryable: false, exitCode: 1 },
      { daemonCode: "CONFLICT", reason: "WORK_NOT_ACTIVE", protocolCode: "invalid_state", recovery: "refresh_state_then_new_request", retryable: false, exitCode: 1 },
      { daemonCode: "CONFLICT", reason: "ATTEMPT_EXHAUSTED", protocolCode: "limit_exceeded", recovery: "none", retryable: false, exitCode: 1 },
      { daemonCode: "INVALID_INPUT", reason: "BAD_CURSOR", protocolCode: "invalid_request", recovery: "none", retryable: false, exitCode: 2 },
      { daemonCode: "INVALID_INPUT", reason: "TASK_LIMIT_EXCEEDED", protocolCode: "limit_exceeded", recovery: "none", retryable: false, exitCode: 2 },
      { daemonCode: "NOT_FOUND", reason: "TASK_NOT_FOUND", protocolCode: "not_found", recovery: "refresh_state_then_new_request", retryable: false, exitCode: 4 },
      { daemonCode: "CONFLICT", reason: "WORK_CAPACITY_EXCEEDED", protocolCode: "limit_exceeded", recovery: "none", retryable: false, exitCode: 1 },
      { daemonCode: "RECOVERY_REQUIRED", reason: "ATTEMPT_RECOVERY_REQUIRED", protocolCode: "effect_unknown", recovery: "replay_exact_request", retryable: true, exitCode: 7 },
    ] as const;

    for (const fixture of fixtures) {
      const target = capture();
      expect(await main(["work", "apply", "--input-stdin"], target.output, {
        isTerminalDescriptor: () => false,
        readProtectedDocument: () => Promise.resolve(request),
        callDaemon: () => Promise.resolve({
          ok: false,
          version: 1,
          requestId,
          error: {
            code: fixture.daemonCode,
            message: "private daemon diagnostic",
            details: { reason: fixture.reason },
          },
        }),
      })).toBe(fixture.exitCode);
      expect(target.read().stderr).toBe("");
      expect(JSON.parse(target.read().stdout)).toMatchObject({
        protocol: WORK_PROTOCOL,
        version: WORK_PROTOCOL_VERSION,
        requestId,
        ok: false,
        error: {
          code: fixture.protocolCode,
          recovery: fixture.recovery,
          retryable: fixture.retryable,
          exitCode: fixture.exitCode,
        },
      });
      expect(target.read().stdout).not.toContain("private daemon diagnostic");
      expect(target.read().stdout).not.toContain(fixture.reason);
    }
  });

  test("keeps coarse daemon failures closed while preserving their exit classes", async () => {
    const fixtures = [
      { daemonCode: "INVALID_INPUT", protocolCode: "invalid_request", recovery: "none", retryable: false, exitCode: 2 },
      { daemonCode: "NOT_FOUND", protocolCode: "not_found", recovery: "refresh_state_then_new_request", retryable: false, exitCode: 4 },
      { daemonCode: "AMBIGUOUS", protocolCode: "conflict", recovery: "refresh_state_then_new_request", retryable: false, exitCode: 1 },
      { daemonCode: "CONFLICT", protocolCode: "conflict", recovery: "refresh_state_then_new_request", retryable: false, exitCode: 1 },
      { daemonCode: "INTERACTION_REQUIRED", protocolCode: "invalid_state", recovery: "none", retryable: false, exitCode: 6 },
      { daemonCode: "UNAVAILABLE", protocolCode: "internal", recovery: "retry_same_request", retryable: true, exitCode: 5 },
      { daemonCode: "RECOVERY_REQUIRED", protocolCode: "effect_unknown", recovery: "replay_exact_request", retryable: true, exitCode: 7 },
      { daemonCode: "INTERNAL", protocolCode: "internal", recovery: "none", retryable: false, exitCode: 1 },
    ] as const;

    for (const fixture of fixtures) {
      const target = capture();
      expect(await main(["work", "apply", "--input-stdin"], target.output, {
        isTerminalDescriptor: () => false,
        readProtectedDocument: () => Promise.resolve(request),
        callDaemon: () => Promise.resolve({
          ok: false,
          version: 1,
          requestId,
          error: {
            code: fixture.daemonCode,
            message: "private coarse diagnostic",
          },
        }),
      })).toBe(fixture.exitCode);
      expect(JSON.parse(target.read().stdout)).toMatchObject({
        requestId,
        ok: false,
        error: {
          code: fixture.protocolCode,
          recovery: fixture.recovery,
          retryable: fixture.retryable,
          exitCode: fixture.exitCode,
        },
      });
      expect(target.read().stdout).not.toContain("private coarse diagnostic");
    }
  });

  test("returns request-bound recovery authority for a malformed daemon success", async () => {
    const target = capture();
    const secret = "PRIVATE_MALFORMED_SUCCESS_SENTINEL";
    expect(await main(["work", "apply", "--input-stdin"], target.output, {
      isTerminalDescriptor: () => false,
      readProtectedDocument: () => Promise.resolve(request),
      callDaemon: () => Promise.resolve({
        ok: true,
        version: 1,
        requestId,
        data: { malformed: secret },
      }),
    })).toBe(7);
    expect(target.read().stderr).toBe("");
    expect(JSON.parse(target.read().stdout)).toEqual({
      protocol: WORK_PROTOCOL,
      version: WORK_PROTOCOL_VERSION,
      requestId,
      ok: false,
      error: {
        code: "effect_unknown",
        message: "The daemon reported success without a valid bound result; replay the exact same request document.",
        retryable: true,
        recovery: "replay_exact_request",
        exitCode: 7,
      },
    });
    expect(target.read().stdout).not.toContain(secret);
  });
});
