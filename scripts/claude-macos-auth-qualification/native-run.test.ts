import { expect, test } from "bun:test";

import { CLAUDE_PIN, CLAUDE_PIN_EFFORT, CLAUDE_PIN_MODEL, CLAUDE_PIN_NATIVE_FALLBACK_CAPABILITY, PINNED_CLAUDE_ARTIFACT_DIGESTS } from "../../src/claude/pin";
import type { PinnedClaudeRuntime } from "../../src/claude/runtime";
import { qualificationTag } from "./identity";
import { ClaudeMacosLogoutError } from "./native-effects";
import { NativeIdentityObserverError } from "./native-observer";
import { runCredentialFreeClaudeMacosQualification, runNativeClaudeMacosQualification } from "./native-run";
import { OwnerTerminalError } from "./owner-terminal";
import { validateQualificationCheckpoint } from "./receipt";
import { createQualification, QUALIFICATION_CLEANUP_ROOTS, type QualificationState } from "./state";

type Ports = Parameters<typeof runCredentialFreeClaudeMacosQualification>[1];
const deferred = <T>() => Promise.withResolvers<T>();
const id = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const root = "/private/synthetic/complete-qualification";
const directory = (name: string, inode: number) => ({ path: `${root}/${name}`, device: 1, inode, mode: 0o700 });
const source = { sourceSha: "a".repeat(40), sourceTree: "b".repeat(40), executable: { path: "/synthetic/executable", device: 1, inode: 100 } };
const binding = { version: 1, runId: id(1), ...source, pin: CLAUDE_PIN, executableDigest: PINNED_CLAUDE_ARTIFACT_DIGESTS.nativeExecutable,
  ownerUid: 501, realHome: "/Users/synthetic", forbiddenRoots: ["/private/production"], runRoot: { path: root, device: 1, inode: 2, mode: 0o700 },
  profileA: directory("A", 3), profileB: directory("B", 4), temporaryA: directory("tmp-A", 5), temporaryB: directory("tmp-B", 6),
  proofKey: { path: `${root}/proof-key`, device: 1, inode: 7, mode: 0o600 } };
function fixture() {
  const key = new Uint8Array(32).fill(17); let state = createQualification(binding, key, id(2));
  const calls: string[] = []; const bytes: Uint8Array[] = []; const controller = new AbortController();
  const input = { repositoryRoot: "/synthetic/repository", sourceCommit: source.sourceSha, executablePath: source.executable.path,
    environment: { HOME: binding.realHome, PATH: "/usr/bin:/bin" }, signal: controller.signal };
  const runtime: PinnedClaudeRuntime = { executablePath: source.executable.path, version: CLAUDE_PIN, effort: CLAUDE_PIN_EFFORT, model: CLAUDE_PIN_MODEL,
    nativeFallback: CLAUDE_PIN_NATIVE_FALLBACK_CAPABILITY, argv: [source.executable.path] };
  const runtimes = { A: runtime, B: { ...runtime } };
  const flags = { A: false, B: false }; let window: number | null = null;
  const custody: Awaited<ReturnType<Ports["create"]>> = {
    runId: binding.runId, recoveryRoot: root, receiptPath: `${root}/receipt.json`, state: () => structuredClone(state),
    async assertCurrent() { calls.push("custody-current"); },
    async withProofKey<T>(observe: (copy: Uint8Array) => Promise<T>): Promise<T> { const copy = Uint8Array.from(key); bytes.push(copy);
      try { return await observe(copy); } finally { copy.fill(0); } },
    async persist(value) { bytes.push(value); state = validateQualificationCheckpoint(value, key); calls.push(`save:${state.step}:${state.pending?.stage ?? "settled"}`); },
    async removeRoot(name) { expect(state.step).toBe(21); expect(state.pending?.stage).toBe("dispatched");
      expect(state.cleanupRoots.at(-1)).toEqual({ root: name, stage: "intent" }); expect(flags).toEqual({ A: false, B: false });
      calls.push(`remove:${name}`); return { root: name, removalReconciled: true }; },
    async releasePreserving() { calls.push("release"); },
  };
  const assertDispatch = (attemptId: string): void => { expect(state.pending).toEqual({ attemptId, stage: "dispatched" }); };
  const observe: Ports["status"] = async (profile, scope) => {
    assertDispatch(scope.attemptId); expect(scope.profile).toBe(profile);
    if (state.step >= 6) expect(window).toBe(state.step);
    calls.push(`status:${state.step}:${profile}`);
    const signedIn = flags[profile]; const account = profile === "A" ? "A" : "B";
    return { source: "credential_free_fixture", identity: { ...scope,
      profileTag: qualificationTag(key, binding.runId, "profile", profile === "A" ? binding.profileA.path : binding.profileB.path), signedIn,
      accountTag: signedIn ? qualificationTag(key, binding.runId, "account", account) : null,
      emailTag: signedIn ? qualificationTag(key, binding.runId, "email", account) : null,
      organizationTag: signedIn ? qualificationTag(key, binding.runId, "organization", account) : null, evidence: "reported_identity_only" },
      native: { ...scope, deadlineMs: 5000, elapsedMs: 10, stdoutBytes: 50, stderrBytes: 0,
        detachment: { identity: { pid: profile === "A" ? 200 : 201, pidDomain: "darwin", procStart: "Fri Sep 11 16:34:59 2026" },
          setsidChecked: true, newSession: true, controllingTty: false, stdinClosed: true } } };
  };
  const ports: Ports = {
    capture() { calls.push("capture"); return { source, assertCurrent() { calls.push("source-current"); } }; },
    async create() { calls.push("create"); return custody; }, async assertFresh() { calls.push("fresh"); }, async assertEnvironment() { calls.push("environment"); },
    async capabilities() { calls.push("six-probes"); return { kind: "capabilities_only", source: "credential_free_fixture", runId: binding.runId,
      attemptId: state.pending?.attemptId ?? id(99), exactVersionBoth: true, loginHelpBoth: true, logoutHelpBoth: true,
      probes: Array.from({ length: 6 }, (_, index) => ({ runId: binding.runId, attemptId: state.pending?.attemptId ?? id(99), probeId: id(20 + index),
        profile: index < 3 ? "A" : "B", operation: index % 3 === 0 ? "version" : index % 3 === 1 ? "login_help" : "logout_help",
        stdoutSha256: "c".repeat(64), stdoutBytes: 50, stderrBytes: 0, deadlineMs: 5000, elapsedMs: 10, loginHelp: null,
        detachment: { identity: { pid: 100 + index, pidDomain: "darwin", procStart: "Fri Sep 11 16:34:59 2026" },
          setsidChecked: true, newSession: true, controllingTty: false, stdinClosed: true } })), runtimes }; },
    status: observe,
    async pair(a, b) {
      expect(state.step).toBe(9); expect(a.attemptId).toBe(b.attemptId); expect(a.probeId).not.toBe(b.probeId); calls.push("pair-start");
      const first = await observe("A", a); const second = await observe("B", b); calls.push("pair-joined");
      return { source: "credential_free_fixture", first, second, overlap: { admitted: true, cleanup: "joined", reason: "observed",
        observationDeadlineMs: 1000, observationElapsedMs: 10, inspectorsStarted: 3, inspectorsJoined: 3, targetsJoined: 2,
        witness: { order: "A1_B_A2", first: first.native.detachment.identity, second: second.native.detachment.identity } } };
    },
    async prepareLogin(step, scope, actual) {
      assertDispatch(scope.attemptId); expect(state.step).toBe(step); expect(scope.profile).toBe(step === 4 ? "B" : "A");
      expect(actual).toBe(runtimes[scope.profile]); calls.push(`prepare:${step}`); if (step === 13) calls.push("owner-arm:13");
      let started = false; let collected = false; let finished = false;
      return { async run() { assertDispatch(scope.attemptId); expect(started).toBeFalse(); started = true; calls.push(`login:${step}`);
        if (step !== 13) flags[scope.profile] = true;
        return { state: "joined", exitCode: step === 13 ? 130 : 0, interruptedBy: step === 13 ? "SIGINT" : null }; },
      async settled() { calls.push(`login-collect:${step}`); collected = true; return started ? { cleanup: "joined", childJoined: true,
        exitCode: step === 13 ? 130 : 0, ownerTerminalVerified: true, stdin: 0, stdout: 1, stderr: 2, requestedSignals: { SIGINT: 0, SIGTERM: 0, SIGKILL: 0 } } : null; },
      async finish() { expect(collected).toBeTrue(); finished = true; calls.push(`signal-finish:${step}`); },
      async attest() { expect(collected).toBeTrue(); expect(finished).toBeTrue(); calls.push(`owner:${step}`); } };
    },
    async armWindow(scope) { expect(window).toBeNull(); assertDispatch(scope.attemptId); expect(state.step).toBe(scope.step); window = scope.step; calls.push(`arm:${scope.step}`);
      return { async finish() { assertDispatch(scope.attemptId); if (scope.step === 9) expect(calls).toContain("pair-joined"); calls.push(`no-prompt:${scope.step}`); },
        close() { window = null; calls.push(`window-close:${scope.step}`); } }; },
    async logout() {
      const step = state.step; if (step !== 11 && step !== 17 && step !== 19) throw new Error("synthetic logout order");
      const profile = step === 17 ? "B" : "A"; const attemptId = state.pending?.attemptId ?? id(999); assertDispatch(attemptId);
      calls.push(`logout:${step}:${profile}`); flags[profile] = false;
      return { source: "credential_free_fixture", kind: "logout_process_joined", runId: binding.runId, attemptId, probeId: id(200 + step), step, profile,
        operation: "logout", nativeLogoutExitZero: true, childJoined: true, stdoutEof: true, stderrEof: true, cleanup: "joined", stdoutBytes: 10, stderrBytes: 0,
        stdoutSha256: "d".repeat(64), stderrSha256: "e".repeat(64), deadlineMs: 5000, elapsedMs: 10, inspectionComplete: true, inspectorsStarted: 2, inspectorsJoined: 2,
        detachment: { identity: { pid: 300 + step, pidDomain: "darwin", procStart: "Fri Sep 11 16:34:59 2026" },
          setsidChecked: true, newSession: true, controllingTty: false, stdinClosed: true } };
    },
  };
  return { input, ports, custody, calls, bytes, controller, flags, runtimes, state: () => state, setState: (value: QualificationState) => { state = value; } };
}

test("complete fixture keeps one owner and genuine A/B runtimes for the fixed 22 steps", async () => {
  const f = fixture(); const result = await runCredentialFreeClaudeMacosQualification(f.input, f.ports);
  expect(result).toMatchObject({ source: "credential_free_fixture", sequenceComplete: true, activationAuthorized: false, step: 22,
    status: "sequence_complete", cleanup: "joined", ownerRelease: "released", checkpoint: "settled", interruptionReconciled: true, ownedRootsRemoved: true });
  expect(f.calls.filter((value) => value === "create")).toHaveLength(1); expect(f.calls.at(-1)).toBe("release");
  expect(f.calls.filter((value) => value.startsWith("login:"))).toEqual(["login:1", "login:4", "login:13", "login:15"]);
  expect(f.calls.filter((value) => value.startsWith("logout:"))).toEqual(["logout:11:A", "logout:17:B", "logout:19:A"]);
  expect(f.calls.filter((value) => value.startsWith("remove:"))).toEqual(QUALIFICATION_CLEANUP_ROOTS.map((name) => `remove:${name}`));
  expect(f.calls.filter((value) => value === "pair-start")).toHaveLength(1);
  expect(f.calls.filter((value) => value.startsWith("arm:"))).toEqual([6, 7, 8, 9, 10, 12, 14, 16, 18, 20].map((step) => `arm:${step}`));
  expect(f.state().events.filter((event) => event.type === "settled").map((event) => event.result.kind)).toEqual([
    "preflight", "login", "probe", "probe", "login", "probe", "probe", "probe", "probe", "probe", "probe", "logout", "probe", "login", "probe", "login", "probe", "logout", "probe", "logout", "probe", "cleanup"]);
  expect(f.state().attempts).toHaveLength(22); expect(f.state().pending).toBeNull(); expect(f.state().failure).toBeNull();
  expect(f.state().events).toHaveLength(96); expect(f.state().cleanupRoots.every((entry) => entry.stage === "removed")).toBeTrue();
  for (const bytes of f.bytes) expect(bytes.every((value) => value === 0)).toBeTrue();
});

test("persistence barriers at each effect class stop without replay, recovery logout or blanket cleanup", async () => {
  for (const failAt of [3, 7, 19, 39, 47, 55, 63, 71, 79, 87, 88, 90, 96]) {
    const f = fixture(); let count = 0; const prior: string[] = [];
    const result = await runCredentialFreeClaudeMacosQualification(f.input, { ...f.ports, async create() { return { ...f.custody, async persist(bytes) {
      count += 1; if (count === failAt) { prior.push(...f.calls); throw new Error("synthetic persistence uncertain"); } await f.custody.persist(bytes);
    } }; } });
    expect(result).toMatchObject({ sequenceComplete: false, status: "recovery_required", reason: "persistence_uncertain", checkpoint: "uncertain" });
    expect(count).toBe(failAt); expect(f.calls.slice(prior.length)).toEqual(["release"]);
    if (failAt >= 88) expect(result.cleanup).toBe("uncertain");
    expect(f.calls.filter((value) => value === "release")).toHaveLength(1);
  }
}, 15_000);

test("inherited auth, identity crossover and joined authenticated interruption retain their sticky checkpoint", async () => {
  for (const scenario of ["inherited", "crossover", "interrupted_race"] as const) {
    const f = fixture();
    const result = await runCredentialFreeClaudeMacosQualification(f.input, { ...f.ports, async status(profile, scope) {
      if (scenario === "inherited" && f.state().step === 0) f.flags.A = true;
      if (scenario === "interrupted_race" && f.state().step === 14) f.flags.A = true;
      const observed = await f.ports.status(profile, scope);
      return scenario === "crossover" && f.state().step === 5
        ? { ...observed, identity: { ...observed.identity, accountTag: f.state().baselineA?.accountTag ?? null } } : observed;
    } });
    expect(result.sequenceComplete).toBeFalse(); expect(result.status).toBe("recovery_required"); expect(result.cleanup).toBe("joined");
    expect(f.state().failure).toBe(scenario === "inherited" ? "inherited_authentication" : scenario === "crossover" ? "identity_crossover" : "joined_authenticated");
    expect(f.calls.some((value) => value.startsWith("remove:"))).toBeFalse();
    if (scenario === "inherited") expect(f.calls.some((value) => value.startsWith("login:") || value.startsWith("logout:"))).toBeFalse();
    if (scenario === "interrupted_race") { expect(result.reason).toBe("joined_authenticated"); expect(f.calls).not.toContain("login:15"); expect(f.calls).not.toContain("logout:17:B"); }
  }
});

test("the pair witness cannot be replaced by promise overlap, fixture provenance or crossed identities", async () => {
  for (const scenario of ["missing", "crossed", "source", "unjoined"] as const) {
    const f = fixture(); const result = await runCredentialFreeClaudeMacosQualification(f.input, { ...f.ports, async pair(a, b) {
      const value = await f.ports.pair(a, b);
      if (scenario === "source") return { ...value, source: "native_process" };
      if (scenario === "unjoined") throw new NativeIdentityObserverError("native_unproved", "uncertain");
      return { ...value, overlap: { ...value.overlap, witness: scenario === "missing" ? null : { order: "A1_B_A2", first: value.second.native.detachment.identity, second: value.first.native.detachment.identity } } };
    } });
    expect(result).toMatchObject({ sequenceComplete: false, status: "recovery_required", step: 9 });
    expect(result.cleanup).toBe(scenario === "unjoined" ? "uncertain" : "joined");
    expect(f.calls).not.toContain("no-prompt:9"); expect(f.calls).toContain("window-close:9"); expect(f.calls).not.toContain("logout:11:A");
  }
});

test("pair collection and owner response both finish before settlement or any following effect", async () => {
  const f = fixture(); const entered = deferred<undefined>(); const pair = deferred<undefined>();
  const answering = deferred<undefined>(); const answer = deferred<undefined>();
  const pending = runCredentialFreeClaudeMacosQualification(f.input, { ...f.ports,
    async pair(a, b) { const result = await f.ports.pair(a, b); entered.resolve(undefined); await pair.promise; return result; },
    async armWindow(scope) { const original = await f.ports.armWindow(scope); return scope.step !== 9 ? original : { ...original,
      async finish() { answering.resolve(undefined); await answer.promise; await original.finish(); } }; } });
  await entered.promise; expect(f.calls).not.toContain("no-prompt:9"); expect(f.state().step).toBe(9);
  pair.resolve(undefined);
  await answering.promise; expect(f.state().step).toBe(9); expect(f.calls).not.toContain("arm:10");
  answer.resolve(undefined); const result = await pending; expect(result.sequenceComplete).toBeTrue();
});

test("login completion, direct-child collection, signal handoff and fresh input form separate joins", async () => {
  const f = fixture(); const entered = deferred<undefined>(); const collected = deferred<undefined>(); const child = deferred<undefined>();
  const joinedChild = deferred<undefined>(); const pending = runCredentialFreeClaudeMacosQualification(f.input, { ...f.ports,
    async prepareLogin(...args) { const login = await f.ports.prepareLogin(...args); if (args[0] !== 1) return login;
      return { ...login, async run() { const value = await login.run(); entered.resolve(undefined); await child.promise; return value; },
        async settled() { collected.resolve(undefined); await joinedChild.promise; return await login.settled(); } }; } });
  await entered.promise; expect(f.calls).not.toContain("owner:1"); child.resolve(undefined);
  await collected.promise; expect(f.calls).not.toContain("signal-finish:1"); expect(f.calls).not.toContain("owner:1");
  joinedChild.resolve(undefined); expect((await pending).sequenceComplete).toBeTrue();
});

test("aborting while a probe is collecting still waits for its join and never accepts the owner window", async () => {
  const f = fixture(); const entered = deferred<undefined>(); const collected = deferred<undefined>();
  const pending = runCredentialFreeClaudeMacosQualification(f.input, { ...f.ports, async status(profile, scope) {
    const result = await f.ports.status(profile, scope); if (f.state().step === 6) { entered.resolve(undefined); await collected.promise; } return result;
  } });
  await entered.promise; f.controller.abort(); expect(f.calls).not.toContain("release"); collected.resolve(undefined);
  expect(await pending).toMatchObject({ reason: "aborted", cleanup: "joined", step: 6, sequenceComplete: false });
  expect(f.calls).not.toContain("no-prompt:6"); expect(f.calls).toContain("window-close:6");
});

test("unproved login collection, native logout or terminal input preserves the exact dispatched scope", async () => {
  for (const scenario of ["login", "logout", "owner"] as const) {
    const f = fixture(); const result = await runCredentialFreeClaudeMacosQualification(f.input, { ...f.ports,
      async prepareLogin(...args) { const login = await f.ports.prepareLogin(...args); return { ...login,
        async settled() { const value = await login.settled(); return scenario === "login" && value !== null ? { ...value, cleanup: "uncertain", childJoined: false } : value; },
        async attest() { if (scenario === "owner") throw new OwnerTerminalError("owner_refused", "uncertain"); await login.attest(); } }; },
      async logout() { throw new ClaudeMacosLogoutError("collection_uncertain", "uncertain"); } });
    expect(result).toMatchObject({ sequenceComplete: false, status: "recovery_required", cleanup: "uncertain", checkpoint: "dispatched" });
    expect(f.state().pending?.stage).toBe("dispatched"); expect(f.calls.some((value) => value.startsWith("remove:"))).toBeFalse();
    if (scenario !== "logout") expect(f.calls).not.toContain("owner:1");
  }
});

test("not-started/collection contradictions and non-interrupted planned login refuse advancement", async () => {
  for (const scenario of ["not_started_joined", "not_started_null", "wrong_interruption"] as const) {
    const f = fixture(); const result = await runCredentialFreeClaudeMacosQualification(f.input, { ...f.ports, async prepareLogin(...args) {
      const login = await f.ports.prepareLogin(...args);
      if (scenario === "wrong_interruption") return args[0] !== 13 ? login : { ...login, async run() { const value = await login.run(); return { ...value, state: "joined", exitCode: 0, interruptedBy: null }; } };
      return { ...login, async run() { if (scenario === "not_started_joined") await login.run(); return { state: "not_started", reason: "spawn_failed" }; } };
    } });
    expect(result.sequenceComplete).toBeFalse(); expect(result.reason).toBe("login_refused"); expect(result.step).toBe(scenario === "wrong_interruption" ? 13 : 1);
    expect(f.calls).not.toContain(scenario === "wrong_interruption" ? "owner:13" : "owner:1");
  }
});

test("partial root removal preserves ordered intent and evidence, and release failure never completes", async () => {
  for (const target of [...QUALIFICATION_CLEANUP_ROOTS, "release"] as const) {
    const f = fixture(); const result = await runCredentialFreeClaudeMacosQualification(f.input, { ...f.ports, async create() { return { ...f.custody,
      async removeRoot(name) { if (name === target) throw new Error("synthetic removal uncertain"); return await f.custody.removeRoot(name); },
      async releasePreserving() { await f.custody.releasePreserving(); if (target === "release") throw new Error("synthetic owner release uncertain"); } }; } });
    expect(result).toMatchObject({ sequenceComplete: false, status: "recovery_required" });
    if (target !== "release") { expect(result.cleanup).toBe("uncertain"); expect(f.state().cleanupRoots.at(-1)).toEqual({ root: target, stage: "intent" }); expect(result.ownedRootsRemoved).toBeFalse(); }
    else { expect(result.cleanup).toBe("joined"); expect(result.ownerRelease).toBe("uncertain"); expect(result.ownedRootsRemoved).toBeTrue(); }
    expect(f.calls.filter((value) => value === "logout:19:A")).toHaveLength(1);
  }
}, 10_000);

test("a malformed or crossed root acknowledgement cannot complete filesystem cleanup", async () => {
  for (const scenario of ["false", "crossed", "extra"] as const) {
    const f = fixture(); const result = await runCredentialFreeClaudeMacosQualification(f.input, { ...f.ports, async create() { return { ...f.custody,
      async removeRoot(name) { const ack = await f.custody.removeRoot(name);
        if (scenario === "false") Reflect.set(ack, "removalReconciled", false);
        else if (scenario === "crossed") Reflect.set(ack, "root", "profileB");
        else Reflect.set(ack, "replacementAuthority", true);
        return ack;
      } }; } });
    expect(result).toMatchObject({ sequenceComplete: false, status: "recovery_required", reason: "cleanup_refused", cleanup: "uncertain", ownedRootsRemoved: false });
    expect(f.state().cleanupRoots).toEqual([{ root: "profileA", stage: "intent" }]);
    expect(f.calls).not.toContain("remove:profileB");
  }
});

test("native entry rejects all caller authority/operation/restore/runtime/port fields before capture", async () => {
  const f = fixture();
  for (const field of ["step", "profile", "operation", "runtime", "runtimes", "restore", "ownerAttested", "concurrentOverlapObserved", "ports", "source"]) {
    await expect(runNativeClaudeMacosQualification({ ...f.input, [field]: field === "source" ? "credential_free_fixture" : true })).rejects.toMatchObject({ code: "invalid_input" });
  }
  await expect(runCredentialFreeClaudeMacosQualification(f.input, { ...f.ports, arbitrary: () => undefined } as Ports)).rejects.toMatchObject({ code: "invalid_input" });
  expect(f.calls).toHaveLength(0);
});
