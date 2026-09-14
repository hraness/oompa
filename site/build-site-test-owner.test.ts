import { describe, expect, test } from "bun:test";
import * as fc from "fast-check";
import { BoundedProcessCleanupUnprovenError, type BoundedProcessRequest, type BoundedProcessResult } from "../scripts/bounded-process";
import { createSiteCompilerCase, siteCompilerCloseMs } from "./build-site-test-owner";
import { readSiteTestBuildTerminal, siteTestBuildOptions, siteTestBuildTerminalPrefix } from "./build-site-test-protocol";

const options = { check: false, repositoryRoot: "/synthetic/site", sourceRoot: "/synthetic/source" };
const result = (terminal: unknown, exitCode = 0): BoundedProcessResult => ({
  cleanup: "proven", exitCode, stderr: Buffer.alloc(0),
  stdout: Buffer.from(`${siteTestBuildTerminalPrefix}${JSON.stringify(terminal)}\n`),
});
const success = () => result({ status: "success", mismatches: [] });
function clock() {
  let time = 0;
  const timers = new Set<{ at: number; callback: () => void }>();
  return {
    now: () => time,
    schedule(callback: () => void, milliseconds: number) {
      const timer = { at: time + milliseconds, callback };
      timers.add(timer);
      return () => { timers.delete(timer); };
    },
    advance(milliseconds: number) {
      time += milliseconds;
      for (const timer of [...timers]) if (timer.at <= time) { timers.delete(timer); timer.callback(); }
    },
  };
}

describe("owned site compiler case", () => {
  test("arms native child ownership before the Vite and StyleX preload", async () => {
    const requests: BoundedProcessRequest[] = [];
    const owner = createSiteCompilerCase(options.sourceRoot, { runProcess: async (request) => {
      requests.push(request); return success();
    } });
    await owner.run(async () => { await owner.buildSite(options); });
    await owner.close();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.arguments).toEqual([
      "--preload", "/synthetic/source/scripts/site-test-compiler-preload.ts",
      "--preload", "/synthetic/source/scripts/register-site-stylex-test-transform.ts",
      "/synthetic/source/site/build-site-test-driver.ts",
    ]);
    expect(requests[0]?.containment).toBe("local");
    expect(requests[0]?.captureLocalDiagnostics).toBe(true);
  });

  test("closed request serialization roundtrips independently of property order", () => {
    fc.assert(fc.property(fc.boolean(), fc.string({ maxLength: 64 }), fc.string({ maxLength: 64 }),
      (check, releaseCommit, token) => {
        const input = { ...options, check, releaseCommit, environment: {
          VERCEL_ENV: "production", NEXT_PUBLIC_POSTHOG_KEY: token,
        } };
        const encoded = JSON.stringify(input);
        expect(siteTestBuildOptions.parse(JSON.parse(encoded) as unknown)).toEqual(input);
        const reordered = Object.fromEntries(Object.entries({ ...input,
          environment: Object.fromEntries(Object.entries(input.environment).reverse()),
        }).reverse());
        expect(siteTestBuildOptions.parse(reordered)).toEqual(input);
        expect(() => siteTestBuildOptions.parse({ ...input, extra: true })).toThrow();
        expect(JSON.stringify(input)).toBe(encoded);
      }), { seed: 68171, numRuns: 100 });
  });

  test("escaped terminal messages roundtrip while ambiguous frames remain refused", () => {
    fc.assert(fc.property(fc.string({ maxLength: 128 }), (message) => {
      const terminal = { status: "failure" as const, name: "Error", message: `${message}\n"\\\u2028`, stack: "synthetic stack" };
      const frame = `${siteTestBuildTerminalPrefix}${JSON.stringify(terminal)}\n`;
      expect(readSiteTestBuildTerminal(Buffer.from(`diagnostic\n${frame}`))).toEqual(terminal);
      const reordered = Object.fromEntries(Object.entries(terminal).reverse());
      expect(readSiteTestBuildTerminal(Buffer.from(`${siteTestBuildTerminalPrefix}${JSON.stringify(reordered)}\n`))).toEqual(terminal);
      for (const invalid of [frame + frame, frame + "late\n", `${siteTestBuildTerminalPrefix}${JSON.stringify({ ...terminal, extra: true })}\n`]) {
        expect(() => readSiteTestBuildTerminal(Buffer.from(invalid))).toThrow();
      }
    }), { seed: 68172, numRuns: 100 });
  });

  test("exit and terminal disagreement cannot become a generated builder error", async () => {
    await fc.assert(fc.asyncProperty(fc.string({ maxLength: 128 }), fc.boolean(), async (message, claimedSuccess) => {
      const terminal = claimedSuccess ? { status: "success", mismatches: [] } : { status: "failure", name: "Error", message };
      const owner = createSiteCompilerCase(options.sourceRoot, { runProcess: async () => result(terminal, claimedSuccess ? 1 : 0) });
      await expect(owner.run(async () => { await owner.buildSite(options); })).rejects.toThrow("SITE_COMPILER_PROCESS_FAILED");
      await expect(owner.close()).rejects.toThrow("SITE_COMPILER_PROOF_FAILED");
    }), { seed: 68173, numRuns: 40 });
  });

  test("carries the actual named public configuration and preserves invalid builder inputs", () => {
    const input = { ...options, releaseCommit: "not-a-commit", environment: {
      VERCEL_ENV: "production", NEXT_PUBLIC_POSTHOG_KEY: "not-a-token",
    } };
    expect(siteTestBuildOptions.parse(input)).toEqual(input);
    expect(() => siteTestBuildOptions.parse({ ...input, environment: { PRIVATE_KEY: "forbidden" } })).toThrow();
    expect(() => siteTestBuildOptions.parse({ ...input, unexpected: true })).toThrow();
    expect(() => siteTestBuildOptions.parse({ ...input, repositoryRoot: "relative" })).toThrow();
  });

  test("requires one final closed terminal frame", () => {
    const frame = `${siteTestBuildTerminalPrefix}{"status":"success","mismatches":[]}\n`;
    expect(readSiteTestBuildTerminal(Buffer.from(`compiler diagnostic\n${frame}`))).toEqual({ status: "success", mismatches: [] });
    for (const input of ["", frame + frame, frame + "late output\n", `${siteTestBuildTerminalPrefix}{}\n`]) {
      expect(() => readSiteTestBuildTerminal(Buffer.from(input))).toThrow();
    }
  });

  test("all sequential requests share the whole proof's absolute deadline", async () => {
    const time = clock();
    const budgets: number[] = [];
    const owner = createSiteCompilerCase(options.sourceRoot, { ...time, workMs: 100, runProcess: async (request) => {
      budgets.push(request.timeoutMs); time.advance(30); return success();
    }, removeRoot: async () => {} });
    await owner.run(async () => {
      await owner.buildSite(options);
      await owner.buildSite({ ...options, check: true });
    });
    expect(budgets).toEqual([100, 70]);
    await owner.close();
  });

  test("expiry before the registered proof runs dispatches no child", async () => {
    const time = clock();
    let calls = 0;
    const owner = createSiteCompilerCase(options.sourceRoot, { ...time, workMs: 1, runProcess: async () => { calls++; return success(); } });
    const task = owner.run(async () => { await owner.buildSite(options); });
    time.advance(1);
    await expect(task).rejects.toThrow("SITE_COMPILER_CASE_DEADLINE");
    await owner.close();
    expect(calls).toBe(0);
  });

  test("cancellation after request construction but before runner entry has proven no-child cleanup", async () => {
    let calls = 0;
    const removed: string[] = [];
    const owner = createSiteCompilerCase(options.sourceRoot, {
      runProcess: async () => { calls++; return success(); },
      removeRoot: async (root) => { removed.push(root); },
    });
    owner.registerRoot(options.repositoryRoot);
    let closing: Promise<void> | undefined;
    const task = owner.run(async () => {
      const request = owner.buildSite(options);
      queueMicrotask(() => { closing = owner.close(); });
      await request;
    });
    await expect(task).rejects.toThrow("SITE_COMPILER_CASE_CLOSING");
    await closing;
    expect(calls).toBe(0);
    expect(removed).toEqual([options.repositoryRoot]);
  });

  test("cancellation between child resolution and publication prevents success and another dispatch", async () => {
    const time = clock();
    const child = Promise.withResolvers<BoundedProcessResult>();
    const entered = Promise.withResolvers<undefined>();
    let published = false;
    let calls = 0;
    const owner = createSiteCompilerCase(options.sourceRoot, { ...time, workMs: 100, runProcess: () => {
      calls++; entered.resolve(undefined); return child.promise;
    } });
    const task = owner.run(async () => {
      await owner.buildSite(options);
      published = true;
      await owner.buildSite({ ...options, check: true });
    });
    await entered.promise;
    void child.promise.then(() => { time.advance(100); });
    child.resolve(success());
    await expect(task).rejects.toThrow("SITE_COMPILER_CASE_DEADLINE");
    await owner.close();
    expect(published).toBe(false);
    expect(calls).toBe(1);
  });

  test.each(["cancelled", "late failure"] as const)("joins delayed collection and the parent proof before removing roots: %s", async (kind) => {
    const time = clock();
    const child = Promise.withResolvers<BoundedProcessResult>();
    const entered = Promise.withResolvers<BoundedProcessRequest>();
    const parentDraining = Promise.withResolvers<undefined>();
    const parentRelease = Promise.withResolvers<undefined>();
    const events: string[] = [];
    const owner = createSiteCompilerCase(options.sourceRoot, { ...time, workMs: 100, runProcess: (request) => {
      entered.resolve(request); return child.promise;
    }, removeRoot: async (root) => { events.push(`removed:${root}`); } });
    owner.registerRoot(options.repositoryRoot);
    const task = owner.run(async () => {
      try { await owner.buildSite(options); }
      finally {
        events.push("parent-draining"); parentDraining.resolve(undefined);
        await parentRelease.promise; events.push("parent-settled");
      }
    });
    const request = await entered.promise;
    const closing = owner.close();
    expect(owner.close()).toBe(closing);
    expect(request.signal?.aborted).toBe(true);
    time.advance(6_000);
    expect(events).toEqual([]);
    child.resolve(kind === "cancelled"
      ? { cleanup: "proven", exitCode: 130, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }
      : result({ status: "failure", name: "Error", message: "genuine late compiler failure" }, 1));
    await parentDraining.promise;
    expect(events).toEqual(["parent-draining"]);
    parentRelease.resolve(undefined);
    await expect(task).rejects.toThrow(kind === "cancelled" ? "SITE_COMPILER_CASE_CLOSING" : "genuine late compiler failure");
    if (kind === "cancelled") await closing;
    else {
      await expect(closing).rejects.toThrow("SITE_COMPILER_PROOF_FAILED");
      const failure = await closing.catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(AggregateError);
      if (!(failure instanceof AggregateError)) throw new Error("Expected retained late error");
      expect(failure.errors.map((error: unknown) => error instanceof Error ? error.message : String(error))).toContain("genuine late compiler failure");
    }
    expect(events).toEqual(["parent-draining", "parent-settled", `removed:${options.repositoryRoot}`]);
  });

  test("unproved child collection retains roots and recovery evidence", async () => {
    const events: string[] = [];
    const owner = createSiteCompilerCase(options.sourceRoot, { runProcess: async () => ({
      cleanup: "unproven", phase: "site-test-compiler", processGroupId: 12345,
      recoveryIdentity: { containment: "local", processGroupId: 12345 }, recoveryPath: "/synthetic/recovery.json",
      stdout: Buffer.alloc(0), stderr: Buffer.alloc(0),
    }), removeRoot: async () => { events.push("removed"); } });
    owner.registerRoot(options.repositoryRoot);
    await expect(owner.run(async () => { await owner.buildSite(options); })).rejects.toThrow("bounded_process_cleanup_unproven");
    const error = await owner.close().catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(AggregateError);
    if (!(error instanceof AggregateError)) throw new Error("Expected recovery evidence");
    expect(error.message).toContain("SITE_COMPILER_CLEANUP_UNPROVEN");
    const recovery: unknown = error.errors[0];
    expect(recovery).toBeInstanceOf(BoundedProcessCleanupUnprovenError);
    if (!(recovery instanceof BoundedProcessCleanupUnprovenError)) throw new Error("Expected native recovery identity");
    expect(recovery.recoveryPaths).toEqual(["/synthetic/recovery.json"]);
    expect(events).toEqual([]);
  });

  test.each(["builder", "transport"] as const)("a caught late request failure still fails owner cleanup: %s", async (kind) => {
    const child = Promise.withResolvers<BoundedProcessResult>();
    const entered = Promise.withResolvers<undefined>();
    const owner = createSiteCompilerCase(options.sourceRoot, { runProcess: () => {
      entered.resolve(undefined); return child.promise;
    } });
    const task = owner.run(async () => {
      await owner.buildSite(options).catch(() => {});
    });
    await entered.promise;
    const closing = owner.close();
    child.resolve(kind === "builder"
      ? result({ status: "failure", name: "Error", message: "retained late failure" }, 1)
      : { cleanup: "proven", exitCode: 1, stdout: Buffer.alloc(0), stderr: Buffer.from("broken transport") });
    await expect(task).rejects.toThrow("SITE_COMPILER_CASE_CLOSING");
    const error = await closing.catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(AggregateError);
    if (!(error instanceof AggregateError)) throw new Error("Expected retained request failure");
    expect(error.errors.map((failure: unknown) => failure instanceof Error ? failure.message : String(failure)))
      .toContain(kind === "builder" ? "retained late failure"
        : "SITE_COMPILER_PROCESS_FAILED stage=terminal_invalid exit_code=1 terminal=unparsed stdout_bytes=0 stderr_bytes=16 mode=build local_diagnostics=absent");
    if (kind === "transport") {
      const retained: unknown = error.errors[0];
      expect(retained).toBeInstanceOf(Error);
      if (!(retained instanceof Error)) throw new Error("Expected process failure diagnostics");
      expect(retained.cause).toMatchObject({ exitCode: 1, stdout: "", stderr: "broken transport" });
    }
  });

  test("a caught unknown runner failure retains its exact cause and fixture", async () => {
    const original = new Error("unknown native custody failure");
    const removed: string[] = [];
    const owner = createSiteCompilerCase(options.sourceRoot, {
      runProcess: async () => { throw original; }, removeRoot: async (root) => { removed.push(root); },
    });
    owner.registerRoot(options.repositoryRoot);
    await owner.run(async () => { await owner.buildSite(options).catch(() => {}); });
    const error = await owner.close().catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(AggregateError);
    if (!(error instanceof AggregateError)) throw new Error("Expected unproved runner evidence");
    expect(error.message).toContain("SITE_COMPILER_CLEANUP_UNPROVEN");
    expect(error.errors).toContain(original);
    expect(removed).toEqual([]);
  });

  test("bounded proof drain refusal retains roots even if the raw proof settles later", async () => {
    const time = clock();
    const release = Promise.withResolvers<undefined>();
    const entered = Promise.withResolvers<undefined>();
    const events: string[] = [];
    const owner = createSiteCompilerCase(options.sourceRoot, { ...time, removeRoot: async () => { events.push("removed"); } });
    owner.registerRoot(options.repositoryRoot);
    const task = owner.run(async () => { entered.resolve(undefined); await release.promise; });
    await entered.promise;
    const closing = owner.close();
    time.advance(siteCompilerCloseMs);
    await expect(closing).rejects.toThrow("SITE_COMPILER_PROOF_DRAIN_UNPROVEN");
    release.resolve(undefined);
    await expect(task).rejects.toThrow("SITE_COMPILER_CASE_CLOSING");
    expect(events).toEqual([]);
  });

  test.each(["missing frame", "success on failed exit"] as const)("transport failure cannot satisfy a builder error oracle: %s", async (kind) => {
    const owner = createSiteCompilerCase(options.sourceRoot, { runProcess: async () => kind === "missing frame"
      ? { cleanup: "proven", exitCode: 1, stdout: Buffer.alloc(0), stderr: Buffer.from("NEXT_PUBLIC_POSTHOG_KEY") }
      : result({ status: "success", mismatches: [] }, 1) });
    const task = owner.run(async () => { await owner.buildSite(options); });
    await expect(task).rejects.toThrow("SITE_COMPILER_PROCESS_FAILED");
    await expect(owner.close()).rejects.toThrow("SITE_COMPILER_PROOF_FAILED");
  });

  test.each(["output_bound", "terminal_invalid", "terminal_exit_mismatch"] as const)("prints only closed failure diagnostics and retains raw cause: %s", async (stage) => {
    const arbitraryOutput = "synthetic arbitrary diagnostic text";
    const stderr = Buffer.from(arbitraryOutput);
    const stdout = stage === "output_bound" ? Buffer.alloc(1024 * 1024, "x")
      : stage === "terminal_invalid" ? Buffer.from(arbitraryOutput)
        : result({ status: "success", mismatches: [] }).stdout;
    const child: BoundedProcessResult = { cleanup: "proven", exitCode: 7, stdout, stderr };
    const owner = createSiteCompilerCase(options.sourceRoot, { runProcess: async () => child });
    const failure = await owner.run(async () => { await owner.buildSite(options); }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    if (!(failure instanceof Error)) throw new Error("Expected diagnostic failure");
    expect(failure.message).toBe(`SITE_COMPILER_PROCESS_FAILED stage=${stage} exit_code=7 terminal=${stage === "terminal_exit_mismatch" ? "success" : "unparsed"} stdout_bytes=${String(stdout.byteLength)} stderr_bytes=${String(stderr.byteLength)} mode=build local_diagnostics=absent`);
    expect(failure.message).toMatch(/^SITE_COMPILER_PROCESS_FAILED stage=(output_bound|terminal_invalid|terminal_exit_mismatch) exit_code=(\d{1,3}|invalid) terminal=(unparsed|success|failure) stdout_bytes=\d{1,10} stderr_bytes=\d{1,10} mode=build local_diagnostics=absent$/u);
    expect(failure.message.length).toBeLessThan(200);
    expect(failure.message).not.toContain(arbitraryOutput);
    expect(failure.cause).toMatchObject({ exitCode: 7, stdout: stdout.toString("utf8"), stderr: arbitraryOutput });
    await expect(owner.close()).rejects.toThrow("SITE_COMPILER_PROOF_FAILED");
  });

  test.each([false, true])("closed leader-close evidence distinguishes an observed failure from forced cleanup: check=%s", async (check) => {
    for (const rawCloseCode of [0, 1] as const) {
      const child = { ...result({ status: "success", mismatches: [] }, 1), localDiagnostics: {
        version: 1 as const, rawCloseCode, rawCloseSignal: "none" as const,
        firstTerminationReason: rawCloseCode === 0 ? "residual_group_non_absent" as const : "none" as const,
        forcedExitCode: rawCloseCode === 0 ? 1 as const : null,
        closeGroup: rawCloseCode === 0 ? "non_absent" as const : "absent" as const,
        termSignalFailed: false, killSignalFailed: false,
      } };
      const owner = createSiteCompilerCase(options.sourceRoot, { runProcess: async (request) => {
        expect(request.containment).toBe("local");
        expect(request.captureLocalDiagnostics).toBe(true);
        return child;
      } });
      const failure = await owner.run(async () => { await owner.buildSite({ ...options, check }); }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      if (!(failure instanceof Error)) throw new Error("Expected retained process failure");
      expect(failure.message).toContain(`exit_code=1 terminal=success`);
      expect(failure.message).toContain(`mode=${check ? "check" : "build"} local_diagnostics=v1 raw_close_code=${String(rawCloseCode)}`);
      expect(failure.message).toContain(`termination=${child.localDiagnostics.firstTerminationReason}`);
      expect(failure.message).toContain(`forced_exit_code=${String(child.localDiagnostics.forcedExitCode)} close_group=${child.localDiagnostics.closeGroup}`);
      expect(failure.message.length).toBeLessThan(512);
      await expect(owner.close()).rejects.toThrow("SITE_COMPILER_PROOF_FAILED");
    }
  });

  test("foreign diagnostic fields cannot escape the closed failure message or change failure admission", async () => {
    const secret = "synthetic-private-path-or-output";
    const valid = {
      version: 1, rawCloseCode: 0, rawCloseSignal: "none", firstTerminationReason: "none",
      forcedExitCode: null, closeGroup: "absent", termSignalFailed: false, killSignalFailed: false,
    };
    for (const invalid of [secret, null, { ...valid, extra: secret },
      { ...valid, rawCloseCode: 256 }, { ...valid, rawCloseCode: secret },
      { ...valid, rawCloseSignal: secret }, { ...valid, firstTerminationReason: secret },
      { ...valid, forcedExitCode: 7 }, { ...valid, closeGroup: secret },
      { ...valid, termSignalFailed: secret }, { ...valid, killSignalFailed: secret },
    ]) {
      const child = result({ status: "success", mismatches: [] }, 1);
      // The injected port supplies foreign runtime data, independent of its TypeScript declaration.
      Reflect.set(child, "localDiagnostics", invalid);
      const owner = createSiteCompilerCase(options.sourceRoot, { runProcess: async () => child });
      const failure = await owner.run(async () => { await owner.buildSite(options); }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      if (!(failure instanceof Error)) throw new Error("Expected closed process failure");
      expect(failure.message).toContain("exit_code=1 terminal=success");
      expect(failure.message).toEndWith("mode=build local_diagnostics=invalid");
      expect(failure.message).not.toContain(secret);
      await expect(owner.close()).rejects.toThrow("SITE_COMPILER_PROOF_FAILED");
    }
  });

  test("closed exit diagnostic projection is order-independent and cannot admit a failed process", async () => {
    const diagnostics = fc.record({
      version: fc.constant(1),
      rawCloseCode: fc.oneof(fc.integer({ min: 0, max: 255 }), fc.constantFrom(null, "unobserved", "invalid")),
      rawCloseSignal: fc.constantFrom("none", "SIGTERM", "SIGKILL", "other", "unobserved"),
      firstTerminationReason: fc.constantFrom("none", "residual_group_non_absent", "output_limit", "abort", "timeout", "journal", "child_error"),
      forcedExitCode: fc.constantFrom(1, 124, 130, null),
      closeGroup: fc.constantFrom("unobserved", "absent", "non_absent"),
      termSignalFailed: fc.boolean(), killSignalFailed: fc.boolean(),
    });
    await fc.assert(fc.asyncProperty(diagnostics, fc.boolean(), fc.string({ maxLength: 128 }), async (diagnostic, check, payload) => {
      const failureMessage = async (metadata: unknown): Promise<string> => {
        const child = result({ status: "success", mismatches: [] }, 1);
        Reflect.set(child, "localDiagnostics", metadata);
        const owner = createSiteCompilerCase(options.sourceRoot, { runProcess: async () => child });
        const failure = await owner.run(async () => { await owner.buildSite({ ...options, check }); }).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(Error);
        if (!(failure instanceof Error)) throw new Error("Expected diagnostic process refusal");
        expect(failure.message).toStartWith("SITE_COMPILER_PROCESS_FAILED stage=terminal_exit_mismatch exit_code=1 terminal=success ");
        expect(failure.message.length).toBeLessThan(512);
        expect(failure.cause).toEqual({ exitCode: 1, stdout: child.stdout.toString("utf8"), stderr: "", error: undefined });
        await expect(owner.close()).rejects.toThrow("SITE_COMPILER_PROOF_FAILED");
        return failure.message;
      };
      const message = await failureMessage(diagnostic);
      expect(message).toEndWith(`mode=${check ? "check" : "build"} local_diagnostics=v1 raw_close_code=${String(diagnostic.rawCloseCode)} raw_close_signal=${diagnostic.rawCloseSignal} termination=${diagnostic.firstTerminationReason} forced_exit_code=${String(diagnostic.forcedExitCode)} close_group=${diagnostic.closeGroup} term_signal_failed=${String(diagnostic.termSignalFailed)} kill_signal_failed=${String(diagnostic.killSignalFailed)}`);
      expect(await failureMessage(Object.fromEntries(Object.entries(diagnostic).reverse()))).toBe(message);
      const arbitraryOutput = `synthetic-unpublished-diagnostic:${payload}`;
      const invalid = await failureMessage({ ...diagnostic, extra: arbitraryOutput });
      expect(invalid).toEndWith(`mode=${check ? "check" : "build"} local_diagnostics=invalid`);
      expect(invalid).not.toContain(arbitraryOutput);
    }), {
      seed: 68174, numRuns: 100,
      examples: [[{
        version: 1, rawCloseCode: 0, rawCloseSignal: "none", firstTerminationReason: "none",
        forcedExitCode: null, closeGroup: "absent", termSignalFailed: false, killSignalFailed: false,
      }, false, ""]],
    });
  });
});
