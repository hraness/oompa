import { expect, test } from "bun:test";

import { IndeterminateClaudeEffectError } from "../../src/claude/errors";
import { CLAUDE_PIN, CLAUDE_PIN_EFFORT, CLAUDE_PIN_MODEL, CLAUDE_PIN_NATIVE_FALLBACK_CAPABILITY } from "../../src/claude/pin";
import type { PinnedClaudeRuntime } from "../../src/claude/runtime";
import { DarwinSessionCustodyError, JOURNAL_OPERATIONS, type JournalAttempt, type JournalOperation } from "./custody";
import { runCredentialFreeDarwinSessionQualification, runNativeDarwinSessionQualification } from "./run";

type Ports = Parameters<typeof runCredentialFreeDarwinSessionQualification>[1];
const id = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const root = "/private/synthetic/oompa-session";
function fixture() {
  const calls: string[] = []; let pending: JournalAttempt | null = null; let completed = 0; let joined = false;
  const controller = new AbortController();
  const input = { repositoryRoot: "/synthetic/repository", sourceCommit: "a".repeat(40), executablePath: "/synthetic/claude",
    environment: { HOME: "/synthetic/home", PATH: "/usr/bin:/bin" }, signal: controller.signal };
  const source = { source: { sourceSha: input.sourceCommit, sourceTree: "b".repeat(40), executable: { path: input.executablePath, device: 1, inode: 99 } },
    assertCurrent() { calls.push("source-current"); } };
  const runtime: PinnedClaudeRuntime = { executablePath: input.executablePath, version: CLAUDE_PIN, model: CLAUDE_PIN_MODEL,
    effort: CLAUDE_PIN_EFFORT, nativeFallback: CLAUDE_PIN_NATIVE_FALLBACK_CAPABILITY, argv: [input.executablePath] };
  const identity = (resume: boolean) => ({ pidDomain: "darwin" as const, pid: resume ? 1002 : 1001, procStart: resume ? "second" : "first" });
  const custody: Awaited<ReturnType<Ports["create"]>> = {
    scope: { runId: id(1), ownerEpoch: id(2), runRoot: root, receiptPath: `${root}/receipt.json`, profileRoot: `${root}/profile`,
      temporaryRoot: `${root}/temporary`, projectRoot: `${root}/project`, runtimeRoot: `${root}/runtime`, profileId: `acct_${"a".repeat(32)}`,
      providerAccountId: `pact_${"b".repeat(32)}`, providerThreadId: id(3), generation: 1 },
    async assertCurrent() { calls.push("custody-current"); },
    async begin(operation) {
      expect(pending).toBeNull(); expect(JOURNAL_OPERATIONS[completed]).toBe(operation);
      calls.push(`intent:${operation}`); await Promise.resolve(); calls.push(`dispatch:${operation}`);
      pending = Object.freeze({ runId: id(1), attemptId: id(10 + completed), operation, ordinal: completed }); return pending;
    },
    async settle(attempt) { expect(pending).toBe(attempt); calls.push(`settle:${attempt.operation}`); pending = null; completed += 1; },
    async fail(reason) { calls.push(`failure:${reason}`); }, async releasePreserving() { calls.push("release"); },
  };
  const effect = (attempt: JournalAttempt) => { expect(pending).toBe(attempt); expect(calls).toContain(`dispatch:${attempt.operation}`); calls.push(`effect:${attempt.operation}`); };
  const authentication: ReturnType<Ports["authentication"]> = {
    cleanup: "joined",
    async capability(attempt, operation) { effect(attempt); return { digest: "c".repeat(64), runtime: operation === "version" ? runtime : null }; },
    async status(attempt) { effect(attempt); return { signedIn: attempt.operation === "signed_in", identityTag: attempt.operation === "signed_in" ? "d".repeat(64) : null }; },
    async login(attempt, admittedRuntime) { expect(admittedRuntime).toBe(runtime); effect(attempt); },
    async logout(attempt) { expect(joined).toBeTrue(); effect(attempt); },
  };
  const session: ReturnType<Ports["session"]> = {
    get cleanup() { return joined ? "joined" : "uncertain"; },
    async start(attempt, resume) { effect(attempt); joined = false; return { kind: "session", threadTag: "e".repeat(64),
      connectionTag: (resume ? "f" : "a").repeat(64), processIdentity: identity(resume) }; },
    async turn(attempt, scenario) { effect(attempt); return { kind: "turn", deltaCount: 1, deltaBytes: 36, completed: true,
      decision: scenario === "approve" ? "once" : scenario === "deny" ? "decline" : null, interrupted: scenario === "interrupt" }; },
    async closeSession(attempt, final) { effect(attempt); joined = final; return { kind: "close", processIdentity: identity(final), childJoined: true, stdoutEof: true, stderrEof: true }; },
    async close() { calls.push("exact-cleanup"); joined = true; },
  };
  const ports: Ports = {
    capture(actual) { expect(actual.environment).not.toBe(input.environment); calls.push("capture"); return source; },
    async create(actual) { expect(actual).toBe(source); calls.push("create"); return custody; },
    authentication(actual, admitted) { expect(actual).toBe(custody); expect(admitted).toBe(source); return authentication; },
    session(actual, admitted, admittedRuntime) { expect(actual).toBe(custody); expect(admitted).toBe(source); expect(admittedRuntime).toBe(runtime); return session; },
    closeSignals() { calls.push("signals-joined"); return "joined"; },
  };
  return { input, ports, calls, custody, authentication, session, controller, pending: () => pending };
}

test("all fixed effects follow durable dispatch and preserve actual runtime through login and same-thread resume", async () => {
  const f = fixture(); const result = await runCredentialFreeDarwinSessionQualification(f.input, f.ports);
  expect(result).toMatchObject({ source: "credential_free_fixture", status: "sequence_complete_retained", completedOperations: 17,
    sessionSequenceComplete: true, activationAuthorized: false, managedMacAdmission: false, daemonRestartQualified: false,
    ambiguousRecoveryQualified: false, privateRootsRemoved: false, processCleanup: "joined", ownerRelease: "released", checkpoint: "settled" });
  expect(f.calls.filter((c) => c.startsWith("effect:"))).toEqual(JOURNAL_OPERATIONS.map((op) => `effect:${op}`));
  expect(f.pending()).toBeNull(); expect(f.calls.slice(-2)).toEqual(["signals-joined", "release"]);
});

test("every begin and settlement failure prevents subsequent effects and preserves pending recovery", async () => {
  for (const stage of ["begin", "settle"] as const) for (const operation of JOURNAL_OPERATIONS) {
    const f = fixture();
    const replacement = { ...f.custody,
      async begin(op: JournalOperation) { if (stage === "begin" && op === operation) throw new Error("synthetic persistence"); return await f.custody.begin(op); },
      async settle(...args: Parameters<typeof f.custody.settle>) {
        if (stage === "settle" && args[0].operation === operation) throw new Error("synthetic persistence"); await f.custody.settle(...args);
      },
    };
    const result = await runCredentialFreeDarwinSessionQualification(f.input, { ...f.ports, async create() { return replacement; },
      authentication() { return f.authentication; }, session() { return f.session; } });
    const index = JOURNAL_OPERATIONS.indexOf(operation);
    expect(result).toMatchObject({ status: "recovery_required", reason: "persistence_uncertain", sessionSequenceComplete: false, checkpoint: "uncertain", completedOperations: index });
    expect(f.calls.filter((c) => c.startsWith("effect:"))).toEqual(JOURNAL_OPERATIONS.slice(0, index + (stage === "settle" ? 1 : 0)).map((op) => `effect:${op}`));
    expect(f.calls.filter((c) => c === "release")).toHaveLength(1);
  }
});

test("ambiguous mutation never replays, resumes, logs out or deletes its profile", async () => {
  const f = fixture();
  const result = await runCredentialFreeDarwinSessionQualification(f.input, { ...f.ports, session() { return { ...f.session,
    async turn(attempt, scenario) { await f.session.turn(attempt, scenario); throw new IndeterminateClaudeEffectError("turn/start"); },
  }; } });
  expect(result).toMatchObject({ status: "recovery_required", reason: "effect_uncertain", completedOperations: 7, sessionSequenceComplete: false });
  expect(f.calls.filter((c) => c === "effect:stream_turn")).toHaveLength(1);
  expect(f.calls).not.toContain("effect:resume"); expect(f.calls).not.toContain("effect:logout");
  expect(f.calls).toContain("exact-cleanup"); expect(f.calls).toContain("failure:effect_uncertain");
});

test("inherited authentication refuses before login and before any opportunistic logout", async () => {
  const f = fixture(); const result = await runCredentialFreeDarwinSessionQualification(f.input, { ...f.ports, authentication() { return { ...f.authentication,
    async status(attempt) { await f.authentication.status(attempt); return { signedIn: true, identityTag: "f".repeat(64) }; },
  }; } });
  expect(result).toMatchObject({ reason: "inherited_authentication", completedOperations: 3, status: "recovery_required" });
  expect(f.calls).not.toContain("effect:login"); expect(f.calls).not.toContain("effect:logout");
});

test("close uncertainty cannot manufacture resume, child join or cleanup authority", async () => {
  const f = fixture(); const result = await runCredentialFreeDarwinSessionQualification(f.input, { ...f.ports, session() { return { ...f.session,
    async closeSession() { throw new Error("synthetic close uncertainty"); }, async close() { throw new Error("synthetic retained child"); },
  }; } });
  expect(result).toMatchObject({ status: "recovery_required", processCleanup: "uncertain", ownerRelease: "released", completedOperations: 11 });
  expect(f.calls).not.toContain("effect:resume"); expect(f.calls).not.toContain("effect:logout");
});

test("signal and owner release uncertainty remain separate from a complete sequence", async () => {
  for (const failure of ["signal", "owner"] as const) {
    const f = fixture(); const result = await runCredentialFreeDarwinSessionQualification(f.input, { ...f.ports,
      async create() { return { ...f.custody, async releasePreserving() { await f.custody.releasePreserving(); if (failure === "owner") throw new Error("synthetic release uncertainty"); } }; },
      authentication() { return f.authentication; }, session() { return f.session; },
      closeSignals() { if (failure === "signal") throw new Error("synthetic signal uncertainty"); return f.ports.closeSignals(); },
    });
    expect(result).toMatchObject({ status: "recovery_required", completedOperations: 17, sessionSequenceComplete: false,
      ownerRelease: failure === "owner" ? "uncertain" : "released", processCleanup: failure === "signal" ? "uncertain" : "joined" });
    expect(f.calls.filter((c) => c === "release")).toHaveLength(1);
  }
});

test("partial creation retains the known exact locator and independently reported release state", async () => {
  for (const ownerRelease of ["released", "uncertain"] as const) {
    const f = fixture(); const result = await runCredentialFreeDarwinSessionQualification(f.input, { ...f.ports,
      async create() { throw new DarwinSessionCustodyError("persistence_uncertain", root, ownerRelease); },
    });
    expect(result).toMatchObject({ status: "recovery_required", ownerRelease, recovery: { runId: null, runRoot: root, receiptPath: null } });
    expect(f.calls).not.toContain("release"); expect(f.calls.some((c) => c.startsWith("effect:"))).toBeFalse();
  }
});

test("closed native input and already aborted fixture refuse before source or provider effects", async () => {
  const f = fixture(); await expect(runNativeDarwinSessionQualification({ ...f.input, processFactory() { throw new Error("unreachable"); } })).rejects.toThrow("scope_refused");
  f.controller.abort(); const result = await runCredentialFreeDarwinSessionQualification(f.input, f.ports);
  expect(result).toMatchObject({ reason: "aborted", recovery: null, checkpoint: "none" }); expect(f.calls).toEqual(["signals-joined"]);
});


test("native source scope cannot borrow provenance from another checkout before any admission or custody", async () => {
  const f = fixture();
  await expect(runNativeDarwinSessionQualification(f.input)).rejects.toThrow("scope_refused");
  await expect(runNativeDarwinSessionQualification({ ...f.input, repositoryRoot: "/synthetic/other-checkout" })).rejects.toThrow("scope_refused");
  expect(f.calls).toEqual([]);
});
