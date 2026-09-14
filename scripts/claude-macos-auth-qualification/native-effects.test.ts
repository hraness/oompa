import { createHash } from "node:crypto";

import { expect, test } from "bun:test";
import fc from "fast-check";

import { CLAUDE_PIN, PINNED_CLAUDE_ARTIFACT_DIGESTS } from "../../src/claude/pin";
import type { DetachedAuthProcess, DetachedAuthSettlement } from "../claude-macos-auth-process/process";
import { QualificationCustody } from "./custody";
import { collectCredentialFreeClaudeMacosLogout, collectNativeClaudeMacosLogout, type CredentialFreeClaudeMacosLogoutPorts } from "./native-effects";

const id = (value: number): string => `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
const root = "/private/synthetic/logout";
const directory = (name: string, inode: number) => ({ path: `${root}/${name}`, device: 1, inode, mode: 0o700 });
const binding = { version: 1, runId: id(1), sourceSha: "a".repeat(40), sourceTree: "b".repeat(40), pin: CLAUDE_PIN,
  executableDigest: PINNED_CLAUDE_ARTIFACT_DIGESTS.nativeExecutable,
  executable: { path: "/private/synthetic/immutable-claude", device: 1, inode: 100 }, ownerUid: 501,
  realHome: "/Users/synthetic", forbiddenRoots: ["/private/production"], runRoot: directory("run", 2),
  profileA: directory("A", 3), profileB: directory("B", 4), temporaryA: directory("tmp-A", 5), temporaryB: directory("tmp-B", 6),
  proofKey: { path: `${root}/proof-key`, device: 1, inode: 7, mode: 0o600 } };
const deferred = () => Promise.withResolvers<undefined>();
type FixtureOptions = { step?: number; stdout?: Uint8Array; stderr?: Uint8Array; patch?: Partial<DetachedAuthSettlement>;
  exitCode?: number; streamFailure?: boolean; exitFailure?: boolean; settlementFailure?: boolean;
  settlementGate?: Promise<unknown>; outputGate?: Promise<unknown>; started?: () => void; collectionDeadlineMs?: number };
function fixture(options: FixtureOptions = {}) {
  const controller = new AbortController();
  const request = { repositoryRoot: "/private/synthetic/repository", sourceCommit: binding.sourceSha, executablePath: binding.executable.path,
    environment: { HOME: "/Users/synthetic", PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C", TMPDIR: "/private/synthetic" },
    signal: controller.signal, ...(options.collectionDeadlineMs === undefined ? {} : { collectionDeadlineMs: options.collectionDeadlineMs }) };
  const state: Record<string, unknown> = { binding, step: options.step ?? 11, pending: { attemptId: id(20), stage: "dispatched" }, failure: null, needsRecovery: false };
  const stdout = Uint8Array.from(options.stdout ?? new TextEncoder().encode("PRIVATE_LOGOUT_TEXT\n"));
  const stderr = Uint8Array.from(options.stderr ?? []);
  const terminal: DetachedAuthSettlement = { operation: "logout", cleanup: "joined", admitted: true, exitCode: 0, childJoined: true,
    stdoutEof: true, stderrEof: true, stdoutBytes: stdout.byteLength, stderrBytes: stderr.byteLength,
    detachment: { identity: { pid: 123, pidDomain: "darwin", procStart: "Fri Sep 11 16:34:59 2026" },
      setsidChecked: true, newSession: true, controllingTty: false, stdinClosed: true },
    deadlineMs: 5000, elapsedMs: 50, inspectionComplete: true, inspectorsStarted: 2, inspectorsJoined: 2, ...options.patch };
  const outputFinished = deferred();
  const counters = { started: 0, terminated: 0, forced: 0, stdoutReads: 0, stderrReads: 0, settlements: 0 };
  const calls: string[] = [];
  const ports: CredentialFreeClaudeMacosLogoutPorts = {
    state() { return state; },
    capture(input) {
      expect(input.sourceCommit).toBe(binding.sourceSha); expect(input.executablePath).toBe(binding.executable.path); calls.push("capture");
      return { source: { sourceSha: binding.sourceSha, sourceTree: binding.sourceTree, executable: binding.executable }, assertCurrent() { calls.push("source-current"); } };
    },
    async prepare(scope) {
      calls.push("ticket"); expect(scope.runId).toBe(binding.runId); expect(scope.attemptId).toBe(id(20));
      expect(scope.profile).toBe(options.step === 17 ? "B" : "A");
      await Promise.resolve(); return { assertCurrent(actual) { calls.push("custody-current"); expect(actual).toEqual(scope); } };
    },
    bind(input) {
      calls.push("bind"); const profile = options.step === 17 ? "B" : "A";
      expect(input.configDir).toBe((profile === "A" ? binding.profileA : binding.profileB).path);
      expect(input.temporaryDirectory).toBe((profile === "A" ? binding.temporaryA : binding.temporaryB).path);
      expect(input.executableSha256).toBe(binding.executableDigest); expect(input.deadlineMs).toBe(5000);
      expect(input.environment).toEqual(request.environment);
      let child: DetachedAuthProcess | null = null;
      return {
        start(operation) {
          expect(operation).toBe("logout"); calls.push(`start:${profile}`); counters.started += 1;
          const settlement = (async () => { await options.settlementGate; if (options.settlementFailure) throw new Error("private settlement failure"); return terminal; })();
          child = { stdout: { async *[Symbol.asyncIterator]() {
            counters.stdoutReads += 1;
            try { await options.outputGate; yield stdout; if (options.streamFailure) throw new Error("private stream failure"); }
            finally { outputFinished.resolve(undefined); }
          } }, stderr: { async *[Symbol.asyncIterator]() { counters.stderrReads += 1; yield stderr; } }, settlement,
          exited: (async () => { if (options.exitFailure) throw new Error("private exit failure"); return options.exitCode ?? 0; })(),
          terminate() { counters.terminated += 1; }, forceTerminate() { counters.forced += 1; } };
          // Fixture rejection is consumed by the collector on its first microtask.
          void child.exited.catch(() => undefined); void settlement.catch(() => undefined);
          options.started?.(); return child;
        },
        async settled() { counters.settlements += 1; return child === null ? null : await child.settlement; },
      };
    },
  };
  return { request, state, ports, controller, stdout, stderr, terminal, counters, calls, outputFinished };
}
const cleared = (value: ReturnType<typeof fixture>): void => {
  expect(value.stdout.every((byte) => byte === 0)).toBeTrue(); expect(value.stderr.every((byte) => byte === 0)).toBeTrue();
  expect(value.counters.stdoutReads).toBe(1); expect(value.counters.stderrReads).toBe(1); expect(value.counters.settlements).toBe(1);
};

test("only fixed A11 B17 A19 logout joins once with private digests and no signed-out claim", async () => {
  for (const step of [11, 17, 19]) {
    const value = fixture({ step, stderr: new Uint8Array([255, 0, 17]) });
    const stdoutSha256 = createHash("sha256").update(value.stdout).digest("hex");
    const stderrSha256 = createHash("sha256").update(value.stderr).digest("hex");
    const result = await collectCredentialFreeClaudeMacosLogout(value.request, value.ports);
    expect(result).toMatchObject({ source: "credential_free_fixture", kind: "logout_process_joined", step, profile: step === 17 ? "B" : "A",
      runId: binding.runId, attemptId: id(20), operation: "logout", nativeLogoutExitZero: true, cleanup: "joined", stdoutEof: true, stderrEof: true,
      stdoutSha256, stderrSha256, inspectorsStarted: 2, inspectorsJoined: 2 });
    expect(result).not.toHaveProperty("signedOut"); expect(result).not.toHaveProperty("activationAuthorized");
    expect(JSON.stringify(result)).not.toContain("PRIVATE_LOGOUT_TEXT"); expect(JSON.stringify(result)).not.toContain(root);
    expect(value.calls).toEqual(["capture", "ticket", "bind", "source-current", "custody-current", `start:${step === 17 ? "B" : "A"}`]);
    cleared(value);
  }
  const empty = fixture({ stdout: new Uint8Array() });
  expect((await collectCredentialFreeClaudeMacosLogout(empty.request, empty.ports)).stdoutBytes).toBe(0); cleared(empty);
});

test("wrong steps, pending stages, changed bindings and fixture/native mixing refuse before any effect", async () => {
  for (const patch of [{ step: 0 }, { step: 12 }, { step: 21 }, { pending: null }, { pending: { attemptId: id(20), stage: "persisted" } },
    { needsRecovery: true }, { failure: "joined_authenticated" }, { binding: { ...binding, version: 2, mode: "native_qualification" } },
    { binding: { ...binding, sourceSha: "c".repeat(40) } }]) {
    const value = fixture(); Object.assign(value.state, patch);
    await expect(collectCredentialFreeClaudeMacosLogout(value.request, value.ports)).rejects.toMatchObject({ code: "scope_refused", cleanup: "not_started" });
    expect(value.counters.started).toBe(0);
  }
  for (const extra of [{ profile: "B" }, { step: 17 }, { operation: "logout" }, { source: "native_process" }, { authority: {} }, { bind() {} }]) {
    const value = fixture();
    await expect(collectCredentialFreeClaudeMacosLogout({ ...value.request, ...extra }, value.ports)).rejects.toMatchObject({ code: "invalid_input", cleanup: "not_started" });
    expect(value.counters.started).toBe(0);
  }
  const fake = Object.create(QualificationCustody.prototype) as QualificationCustody;
  Object.defineProperty(fake, "state", { value: { ...fixture().state, binding: { ...binding, version: 2, mode: "native_qualification" } } });
  const request = { ...fixture().request, custody: fake };
  await expect(collectNativeClaudeMacosLogout(request)).rejects.toMatchObject({ code: "scope_refused", cleanup: "not_started" });
  for (const extra of [{ profile: "A" }, { collectionDeadlineMs: 1 }, { ports: {} }, { source: "credential_free_fixture" }]) {
    await expect(collectNativeClaudeMacosLogout({ ...request, ...extra })).rejects.toMatchObject({ code: "invalid_input", cleanup: "not_started" });
  }
});

test("abort and source or custody changes across preparation never pass the final assertion", async () => {
  for (const phase of ["preabort", "source", "ticket", "state", "source-current", "custody-current"]) {
    const value = fixture(); if (phase === "preabort") value.controller.abort();
    const ports: CredentialFreeClaudeMacosLogoutPorts = { ...value.ports,
      capture(input) {
        const captured = value.ports.capture(input);
        return { source: phase === "source" ? { sourceSha: binding.sourceSha, sourceTree: "c".repeat(40), executable: binding.executable } : captured.source,
          assertCurrent() { if (phase === "source-current") throw new Error("private source changed"); captured.assertCurrent(); } };
      },
      async prepare(scope) {
        const prepared = await value.ports.prepare(scope);
        if (phase === "ticket") value.controller.abort(); if (phase === "state") value.state.pending = { attemptId: id(30), stage: "dispatched" };
        return { assertCurrent(actual) { if (phase === "custody-current") throw new Error("private owner changed"); prepared.assertCurrent(actual); } };
      } };
    await expect(collectCredentialFreeClaudeMacosLogout(value.request, ports)).rejects.toMatchObject({ cleanup: "not_started" });
    expect(value.counters.started).toBe(0);
  }
});

test("one attempted logout is sticky even when start throws or the first joined receipt succeeded", async () => {
  for (const mode of ["joined", "throw", "unjoined"] as const) {
    const value = fixture(mode === "unjoined" ? { patch: { cleanup: "uncertain", childJoined: false } } : {}); let attempts = 0;
    const ports: CredentialFreeClaudeMacosLogoutPorts = { ...value.ports, bind(input) {
      const bound = value.ports.bind(input); return { ...bound, start(operation) { attempts += 1; if (mode === "throw") throw new Error("uncertain spawn"); return bound.start(operation); } };
    } };
    const first = collectCredentialFreeClaudeMacosLogout(value.request, ports);
    if (mode !== "joined") await expect(first).rejects.toMatchObject({ code: "native_unproved", cleanup: "uncertain" }); else await first;
    await expect(collectCredentialFreeClaudeMacosLogout(value.request, ports)).rejects.toMatchObject({ code: "authority_refused", cleanup: "not_started" });
    expect(attempts).toBe(1);
  }
});

test("admission requires actual EOF, exact inspectors, coherent byte counts and bounded timing", async () => {
  const patches: Partial<DetachedAuthSettlement>[] = [{ admitted: false }, { childJoined: false }, { cleanup: "uncertain" },
    { stdoutEof: false }, { stderrEof: false }, { inspectionComplete: false }, { inspectorsStarted: 1, inspectorsJoined: 1 },
    { inspectorsStarted: 2, inspectorsJoined: 1 }, { detachment: null }, { deadlineMs: 3000 }, { elapsedMs: 5000 }, { elapsedMs: -1 },
    { exitCode: 1 }, { stdoutBytes: 123 }, { stderrBytes: 100 }, { operation: "status" },
    { detachment: { ...fixture().terminal.detachment!, identity: { pid: 123, pidDomain: "darwin", procStart: "unparsed timestamp" } } }];
  for (const patch of patches) {
    const value = fixture({ patch }); await expect(collectCredentialFreeClaudeMacosLogout(value.request, value.ports)).rejects.toMatchObject({ code: "native_unproved" }); cleared(value);
  }
  for (const patch of [{ childJoined: false }, { inspectionComplete: false }, { inspectorsJoined: 1 }]) {
    const value = fixture({ patch }); await expect(collectCredentialFreeClaudeMacosLogout(value.request, value.ports)).rejects.toMatchObject({ cleanup: "uncertain" }); cleared(value);
  }
});

test("all stream, exit and settlement promises join on failure and owned raw bytes are cleared", async () => {
  for (const mode of ["stdout_limit", "stderr_limit", "stream", "exit", "settlement", "exit_mismatch"] as const) {
    const value = fixture({ ...(mode === "stdout_limit" ? { stdout: new Uint8Array(16_385).fill(120) } : {}),
      ...(mode === "stderr_limit" ? { stderr: new Uint8Array(4097).fill(120) } : {}),
      streamFailure: mode === "stream", exitFailure: mode === "exit", settlementFailure: mode === "settlement", exitCode: mode === "exit_mismatch" ? 1 : 0 });
    await expect(collectCredentialFreeClaudeMacosLogout(value.request, value.ports)).rejects.toMatchObject({ code: "native_unproved", cleanup: mode === "settlement" ? "uncertain" : "joined" });
    cleared(value);
  }
});

test("abort or stream refusal retains the actual child until its deferred settlement completes", async () => {
  for (const mode of ["abort", "stream"] as const) {
    const gate = deferred(); const started = deferred(); const value = fixture({ settlementGate: gate.promise, started: () => started.resolve(undefined), streamFailure: mode === "stream" });
    const observation = { returned: false };
    const pending = collectCredentialFreeClaudeMacosLogout(value.request, value.ports).then(() => { observation.returned = true; return null; }, (error: unknown) => { observation.returned = true; return error; });
    try {
      await started.promise; if (mode === "abort") value.controller.abort();
      await Promise.resolve(); await Promise.resolve(); expect(observation.returned).toBeFalse();
      gate.resolve(undefined); expect(await pending).toMatchObject({ code: mode === "abort" ? "aborted" : "native_unproved", cleanup: "joined" });
      expect(value.counters.terminated).toBeGreaterThan(0); cleared(value);
    } finally { gate.resolve(undefined); await pending; }
  }
});

test("missed collection deadline refuses with uncertainty and wipes late output without replay", async () => {
  const gate = deferred(); const value = fixture({ outputGate: gate.promise, settlementGate: gate.promise, collectionDeadlineMs: 5 });
  try {
    await expect(collectCredentialFreeClaudeMacosLogout(value.request, value.ports)).rejects.toMatchObject({ code: "collection_uncertain", cleanup: "uncertain" });
    expect(value.counters.terminated).toBeGreaterThan(0); expect(value.counters.forced).toBe(1);
    await expect(collectCredentialFreeClaudeMacosLogout(value.request, value.ports)).rejects.toMatchObject({ code: "authority_refused", cleanup: "not_started" });
  } finally {
    gate.resolve(undefined);
    await value.outputFinished.promise;
  }
  cleared(value);
});

test("all foreign step values outside the three fixed logout steps refuse", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: -1000, max: 1000 }).filter((step) => ![11, 17, 19].includes(step)), async (step) => {
    const value = fixture({ step });
    await expect(collectCredentialFreeClaudeMacosLogout(value.request, value.ports)).rejects.toMatchObject({ code: "scope_refused", cleanup: "not_started" });
    expect(value.counters.started).toBe(0);
  }), { numRuns: 40 });
});
