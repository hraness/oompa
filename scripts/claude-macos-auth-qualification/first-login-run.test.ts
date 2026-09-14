import { PassThrough, Writable } from "node:stream";
import { EventEmitter } from "node:events";

import { expect, test } from "bun:test";

import { CLAUDE_PIN, CLAUDE_PIN_EFFORT, CLAUDE_PIN_MODEL, CLAUDE_PIN_NATIVE_FALLBACK_CAPABILITY, PINNED_CLAUDE_ARTIFACT_DIGESTS } from "../../src/claude/pin";
import type { PinnedClaudeRuntime } from "../../src/claude/runtime";
import { qualificationTag } from "./identity";
import { createCredentialFreeFirstLoginSignals, readCredentialFreeFirstLoginAttestation, runCredentialFreeClaudeMacosFirstLogin, runNativeClaudeMacosFirstLogin } from "./first-login-run";
import { validateQualificationCheckpoint } from "./receipt";
import { createQualification, type QualificationState } from "./state";

type Ports = Parameters<typeof runCredentialFreeClaudeMacosFirstLogin>[1];
const id = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const root = "/private/synthetic/first-login";
const directory = (name: string, inode: number) => ({ path: `${root}/${name}`, device: 1, inode, mode: 0o700 });
const source = { sourceSha: "a".repeat(40), sourceTree: "b".repeat(40), executable: { path: "/synthetic/executable", device: 1, inode: 100 } };
const binding = { version: 1, runId: id(1), ...source, pin: CLAUDE_PIN, executableDigest: PINNED_CLAUDE_ARTIFACT_DIGESTS.nativeExecutable,
  ownerUid: 501, realHome: "/Users/synthetic", forbiddenRoots: ["/private/production"], runRoot: { path: root, device: 1, inode: 2, mode: 0o700 },
  profileA: directory("A", 3), profileB: directory("B", 4), temporaryA: directory("tmp-A", 5), temporaryB: directory("tmp-B", 6),
  proofKey: { path: `${root}/proof-key`, device: 1, inode: 7, mode: 0o600 } };
const deferred = <T>() => Promise.withResolvers<T>();
function fixture() {
  const key = new Uint8Array(32).fill(17); let state = createQualification(binding, key, id(2));
  const calls: string[] = []; const bytes: Uint8Array[] = []; const controller = new AbortController();
  const input = { repositoryRoot: "/synthetic/repository", sourceCommit: source.sourceSha, executablePath: source.executable.path,
    environment: { HOME: binding.realHome, PATH: "/usr/bin:/bin" }, signal: controller.signal };
  const runtime: PinnedClaudeRuntime = { executablePath: source.executable.path, version: CLAUDE_PIN, effort: CLAUDE_PIN_EFFORT, model: CLAUDE_PIN_MODEL,
    nativeFallback: CLAUDE_PIN_NATIVE_FALLBACK_CAPABILITY, argv: [source.executable.path] };
  const custody: Awaited<ReturnType<Ports["create"]>> = {
    runId: binding.runId, recoveryRoot: root, receiptPath: `${root}/receipt.json`, state: () => structuredClone(state),
    async assertCurrent() { calls.push("custody-current"); },
    async withProofKey<T>(observe: (copy: Uint8Array) => Promise<T>): Promise<T> {
      const copy = Uint8Array.from(key); bytes.push(copy);
      try { return await observe(copy); } finally { copy.fill(0); }
    },
    async persist(value) { bytes.push(value); state = validateQualificationCheckpoint(value, key); calls.push(`save:${state.step}:${state.pending?.stage ?? "settled"}`); },
    async releasePreserving() { calls.push("release"); },
  };
  let started = false;
  const login: ReturnType<Ports["prepareLogin"]> = {
    async run(scope) { expect(state.step).toBe(1); expect(state.pending?.stage).toBe("dispatched"); expect(state.pending?.attemptId).toBe(scope.attemptId);
      expect(scope.profile).toBe("A"); expect(started).toBeFalse(); started = true; calls.push("login-start");
      return { state: "joined", exitCode: 0, interruptedBy: null }; },
    async settled() { calls.push("login-collect"); return started ? { cleanup: "joined", childJoined: true, exitCode: 0, ownerTerminalVerified: true,
      stdin: 0, stdout: 1, stderr: 2, requestedSignals: { SIGINT: 0, SIGTERM: 0, SIGKILL: 0 } } : null; },
    async attest(scope) { expect(state.pending?.attemptId).toBe(scope.attemptId); expect(calls).toContain("login-collect"); calls.push("owner-input"); },
    close() { calls.push("signal-close"); },
  };
  const ports: Ports = {
    capture() { calls.push("capture"); return { source, assertCurrent() { calls.push("source-current"); } }; },
    async create() { calls.push("create"); return custody; }, async assertFresh() { calls.push("fresh"); }, async assertEnvironment() { calls.push("environment"); },
    async capabilities() { calls.push("six-probes"); return { kind: "capabilities_only", source: "credential_free_fixture", runId: binding.runId,
      attemptId: state.pending?.attemptId ?? id(99), exactVersionBoth: true, loginHelpBoth: true, logoutHelpBoth: true, probes: Array.from({ length: 6 }, (_, index) => ({
        runId: binding.runId, attemptId: state.pending?.attemptId ?? id(99), probeId: id(20 + index), profile: index < 3 ? "A" : "B",
        operation: index % 3 === 0 ? "version" : index % 3 === 1 ? "login_help" : "logout_help", stdoutSha256: "c".repeat(64), stdoutBytes: 50, stderrBytes: 0, deadlineMs: 5000, elapsedMs: 10,
        loginHelp: null, detachment: { identity: { pid: 100 + index, pidDomain: "darwin", procStart: "Fri Sep 11 16:34:59 2026" }, setsidChecked: true, newSession: true, controllingTty: false, stdinClosed: true } })),
      runtimes: { A: runtime, B: { ...runtime } } }; },
    async status(_custody, _input, profile, scope) { calls.push(`status:${profile}`); const path = profile === "A" ? binding.profileA.path : binding.profileB.path;
      return { source: "credential_free_fixture", identity: { ...scope, profileTag: qualificationTag(key, binding.runId, "profile", path), signedIn: false,
        accountTag: null, emailTag: null, organizationTag: null, evidence: "reported_identity_only" },
        native: { ...scope, deadlineMs: 5000, elapsedMs: 10, stdoutBytes: 50, stderrBytes: 0,
          detachment: { identity: { pid: profile === "A" ? 200 : 201, pidDomain: "darwin", procStart: "Fri Sep 11 16:34:59 2026" }, setsidChecked: true, newSession: true, controllingTty: false, stdinClosed: true } } }; },
    prepareLogin(_custody, _input, _admission, actual) { expect(actual).toBe(runtime); calls.push("prepare-login"); return login; },
  };
  return { input, ports, custody, login, calls, bytes, controller, runtime, state: () => state, setState: (value: QualificationState) => { state = value; } };
}

test("first account persists exact steps zero and one, holds genuine runtime and stops at step two", async () => {
  const value = fixture(); const result = await runCredentialFreeClaudeMacosFirstLogin(value.input, value.ports);
  expect(result).toMatchObject({ source: "credential_free_fixture", firstLoginJoined: true, qualificationComplete: false, activationAuthorized: false,
    step: 2, status: "first_login_joined", cleanup: "joined", ownerRelease: "released", checkpoint: "settled" });
  expect(value.calls).toEqual(["capture", "create", "fresh", "save:0:intent", "save:0:persisted", "environment", "custody-current", "source-current",
    "save:0:dispatched", "six-probes", "status:A", "status:B", "save:1:settled", "prepare-login", "save:1:intent", "save:1:persisted", "environment",
    "custody-current", "source-current", "save:1:dispatched", "login-start", "login-collect", "owner-input", "save:2:settled", "signal-close", "release"]);
  expect(value.state().attempts).toHaveLength(2); expect(value.state().pending).toBeNull(); expect(value.state().baselineA).toBeNull();
  for (const bytes of value.bytes) expect(bytes.every((v) => v === 0)).toBeTrue();
});

test("every persistence failure stops before the next effect or owner answer and preserves recovery", async () => {
  for (let failAt = 1; failAt <= 8; failAt += 1) {
    const value = fixture(); let count = 0;
    const result = await runCredentialFreeClaudeMacosFirstLogin(value.input, { ...value.ports, async create() { return { ...value.custody, async persist(bytes) {
      count += 1; if (count === failAt) throw new Error("synthetic persistence uncertainty"); await value.custody.persist(bytes);
    } }; } });
    expect(result).toMatchObject({ firstLoginJoined: false, status: "recovery_required", reason: "persistence_uncertain", checkpoint: "uncertain" });
    expect(count).toBe(failAt); if (failAt <= 3) expect(value.calls).not.toContain("six-probes");
    if (failAt <= 7) expect(value.calls).not.toContain("login-start");
    expect(value.calls.filter((v) => v === "release")).toHaveLength(1);
  }
});

test("inherited authentication on either root stops before any login and never clears profiles", async () => {
  for (const target of ["A", "B"]) {
    const value = fixture(); const result = await runCredentialFreeClaudeMacosFirstLogin(value.input, { ...value.ports, async status(...args) {
      const observation = await value.ports.status(...args);
      return args[2] === target ? { ...observation, identity: { ...observation.identity, signedIn: true, accountTag: "a".repeat(64), emailTag: "b".repeat(64), organizationTag: "c".repeat(64) } } : observation;
    } });
    expect(result).toMatchObject({ reason: "inherited_authentication", status: "recovery_required", cleanup: "joined" });
    expect(value.state().failure).toBe("inherited_authentication"); expect(value.calls).not.toContain("prepare-login");
  }
});

test("crossed provenance, stale identity and public override fields cannot admit the next effect", async () => {
  const value = fixture();
  await expect(runNativeClaudeMacosFirstLogin({ ...value.input, ownerAttested: true })).rejects.toMatchObject({ code: "invalid_input" });
  const capability = await runCredentialFreeClaudeMacosFirstLogin(value.input, { ...value.ports, async capabilities(...args) { return { ...await value.ports.capabilities(...args), source: "native_process" }; } });
  expect(capability.reason).toBe("capability_refused"); expect(value.calls).not.toContain("status:A");
  const second = fixture(); const identity = await runCredentialFreeClaudeMacosFirstLogin(second.input, { ...second.ports, async status(...args) {
    const observed = await second.ports.status(...args); return { ...observed, identity: { ...observed.identity, attemptId: id(999) } };
  } });
  expect(identity.reason).toBe("identity_refused"); expect(second.calls).not.toContain("prepare-login");
});

test("owner prompt and persistence wait for the exact runner and factory join", async () => {
  const value = fixture(); const runner = deferred<Awaited<ReturnType<typeof value.login.run>>>(); const collector = deferred<Awaited<ReturnType<typeof value.login.settled>>>();
  const started = deferred<undefined>(); const collecting = deferred<undefined>();
  const pending = runCredentialFreeClaudeMacosFirstLogin(value.input, { ...value.ports, prepareLogin() { return { ...value.login,
    async run(scope) { const result = await value.login.run(scope); started.resolve(undefined); return await runner.promise.then(() => result); },
    async settled() { collecting.resolve(undefined); return await collector.promise; } }; } });
  await started.promise; expect(value.calls).not.toContain("owner-input"); runner.resolve({ state: "joined", exitCode: 0, interruptedBy: null });
  await collecting.promise; expect(value.calls).not.toContain("owner-input"); collector.resolve(await value.login.settled());
  expect((await pending).firstLoginJoined).toBeTrue();
});

test("aborted, nonzero, refused owner and contradictory not-started results never settle login", async () => {
  for (const kind of ["abort", "nonzero", "owner", "contradiction"] as const) {
    const value = fixture(); const result = await runCredentialFreeClaudeMacosFirstLogin(value.input, { ...value.ports, prepareLogin() { return { ...value.login,
      async run(scope) { await value.login.run(scope); if (kind === "abort") value.controller.abort();
        return kind === "contradiction" ? { state: "not_started", reason: "spawn_failed" } : { state: "joined", exitCode: kind === "nonzero" ? 1 : 0, interruptedBy: null }; },
      async attest() { throw new Error("synthetic owner declined"); } }; } });
    expect(result.firstLoginJoined).toBeFalse(); expect(result.status).toBe("recovery_required"); expect(value.state().step).toBe(1);
    expect(value.state().pending?.stage).toBe("dispatched"); expect(value.calls).not.toContain("save:2:settled");
  }
});

test("a missed force join cannot be undone by an unbounded factory settlement await", async () => {
  const value = fixture(); const forever = deferred<Awaited<ReturnType<typeof value.login.settled>>>();
  const startedAt = Date.now(); const result = await runCredentialFreeClaudeMacosFirstLogin(value.input, { ...value.ports, prepareLogin() { return { ...value.login,
    async run(scope) { await value.login.run(scope); throw new Error("synthetic force join timeout"); }, async settled() { return await forever.promise; } }; } });
  expect(result).toMatchObject({ firstLoginJoined: false, cleanup: "uncertain", status: "recovery_required" });
  expect(Date.now() - startedAt).toBeLessThan(2500); expect(value.calls).not.toContain("owner-input");
  forever.resolve(await value.login.settled());
});

function terminal(response?: (prompt: string, input: PassThrough) => void) {
  const input = new PassThrough(); let prompt = ""; let checks = 0;
  const output = new Writable({ write(chunk: Buffer, _encoding, done) {
    prompt += chunk.toString("utf8"); done(); if (response) setTimeout(() => { response(prompt, input); }, 0);
  } });
  return { input, output, assertCurrent() { checks += 1; }, prompt: () => prompt, checks: () => checks };
}
const challenge = (prompt: string): string => prompt.slice(prompt.indexOf("signed-in-A "));

test("the terminal reader accepts only its new exact challenge and owns no terminal descriptor", async () => {
  const streams = terminal((prompt, input) => { input.write(Buffer.from(challenge(prompt))); });
  expect(await readCredentialFreeFirstLoginAttestation(streams, new AbortController().signal)).toEqual({ source: "credential_free_fixture" });
  expect(streams.checks()).toBeGreaterThanOrEqual(3); expect(streams.input.destroyed).toBeFalse(); expect(streams.output.destroyed).toBeFalse();
  expect(streams.input.listenerCount("data")).toBe(0); expect(streams.output.listenerCount("error")).toBe(0); expect(streams.input.readableFlowing).toBeFalse();
});

test("prebuffered, ended, wrong, oversized, multiple-line and aborted terminal input refuse without closing descriptors", async () => {
  for (const kind of ["buffered", "ended", "destroyed", "wrong", "oversized", "multiple", "abort"] as const) {
    const controller = new AbortController(); const streams = terminal((prompt, input) => {
      if (kind === "abort") controller.abort(); else input.write(Buffer.from(kind === "oversized" ? "x".repeat(129) : kind === "multiple" ? challenge(prompt) + "extra\n" : "yes\n"));
    });
    if (kind === "buffered") streams.input.write("pretyped\n");
    if (kind === "ended") { streams.input.push(null); streams.input.resume(); await new Promise<undefined>((done) => { streams.input.once("end", () => { done(undefined); }); }); streams.input.pause(); }
    if (kind === "destroyed") streams.input.destroy();
    await expect(readCredentialFreeFirstLoginAttestation(streams, controller.signal)).rejects.toBeInstanceOf(Error);
    expect(streams.output.destroyed).toBeFalse(); expect(streams.input.listenerCount("data")).toBe(0);
  }
});

test("prompt callback failure and close are joined refusals instead of unhandled output errors", async () => {
  for (const kind of ["error", "close"] as const) {
    const input = new PassThrough();
    const output = new Writable({ write(_chunk, _encoding, done) { if (kind === "error") done(new Error("synthetic write failure")); else this.destroy(); } });
    await expect(readCredentialFreeFirstLoginAttestation({ input, output, assertCurrent() {} }, new AbortController().signal)).rejects.toMatchObject({ code: "owner_refused" });
    expect(input.destroyed).toBeFalse(); expect(input.listenerCount("data")).toBe(0);
  }
});

test("output failure between write completion and response admission remains observed", async () => {
  for (const event of ["error", "close"] as const) {
    const input = new PassThrough();
    const output = new Writable({ write(_chunk, _encoding, done) {
      done(); queueMicrotask(() => { if (event === "error") this.emit("error", new Error("synthetic inter-phase failure")); else this.emit("close"); });
    } });
    await expect(readCredentialFreeFirstLoginAttestation({ input, output, assertCurrent() {} }, new AbortController().signal)).rejects.toMatchObject({ code: "owner_refused" });
    expect(input.destroyed).toBeFalse(); expect(input.listenerCount("data")).toBe(0);
    expect(output.listenerCount("error")).toBe(0); expect(output.listenerCount("close")).toBe(0);
  }
});

test("a timed-out prompt write remains uncertain until its retained callback joins", async () => {
  const input = new PassThrough(); let callback: ((error?: Error | null) => void) | undefined;
  const output = new Writable({ write(_chunk, _encoding, done) { callback = done; } });
  await expect(readCredentialFreeFirstLoginAttestation({ input, output, assertCurrent() {} }, new AbortController().signal))
    .rejects.toMatchObject({ code: "owner_refused", cleanup: "uncertain" });
  expect(output.listenerCount("error")).toBe(1); expect(input.listenerCount("data")).toBe(0);
  if (callback === undefined) throw new Error("write callback was not retained"); callback();
  await Promise.resolve(); expect(output.listenerCount("error")).toBe(0); expect(output.destroyed).toBeFalse();
});

test("preflight terminal cancellation stays sticky and removes only owned signal listeners", () => {
  for (const kind of ["SIGINT", "SIGTERM", "external"] as const) {
    const events = new EventEmitter(); const controller = new AbortController(); const unrelated = (): void => {};
    events.on("SIGINT", unrelated);
    const signals = createCredentialFreeFirstLoginSignals(controller.signal, {
      add(signal, listener) { events.on(signal, listener); }, remove(signal, listener) { events.off(signal, listener); },
    });
    if (kind === "external") controller.abort(); else events.emit(kind);
    expect(signals.signal.aborted).toBeTrue(); expect(signals.source).toBe("credential_free_fixture");
    expect(() => signals.beginLogin()).toThrow(); signals.close(); signals.close();
    expect(events.listeners("SIGINT")).toEqual([unrelated]); expect(events.listenerCount("SIGTERM")).toBe(0);
  }
});

test("foreground handoff has no listener gap or duplicate Ctrl-C to TERM and stays held through owner release", async () => {
  const events = new EventEmitter(); const controller = new AbortController(); const counts: number[] = [];
  const signals = createCredentialFreeFirstLoginSignals(controller.signal, {
    add(signal, listener) { events.on(signal, listener); counts.push(events.listenerCount(signal)); },
    remove(signal, listener) { events.off(signal, listener); counts.push(events.listenerCount(signal)); },
  });
  const login = signals.beginLogin(); const sent: string[] = []; let forced = 0;
  login.attachChild({ exited: Promise.resolve(0), sendSignal(signal) { sent.push(signal); }, forceTerminate() { forced += 1; } });
  events.emit("SIGINT");
  expect(login.interruptedBy).toBe("SIGINT"); expect(signals.signal.aborted).toBeFalse(); expect(sent).toEqual([]);
  expect(counts.every((value) => value > 0)).toBeTrue();
  // The runner intentionally does not close custody at child collection; an
  // awaited final receipt/owner release retains the same terminal policy.
  await Promise.resolve(); events.emit("SIGTERM"); expect(sent).toEqual([]); expect(events.listenerCount("SIGTERM")).toBe(1);
  controller.abort(); expect(signals.signal.aborted).toBeTrue(); expect(sent).toEqual(["SIGTERM"]);
  controller.abort(); expect(sent).toEqual(["SIGTERM"]); expect(() => signals.beginLogin()).toThrow();
  signals.close(); expect(forced).toBe(0); expect(events.listenerCount("SIGINT")).toBe(0); expect(events.listenerCount("SIGTERM")).toBe(0);
});

test("a partly installed preflight signal scope is collected on source refusal", () => {
  const events = new EventEmitter();
  expect(() => createCredentialFreeFirstLoginSignals(new AbortController().signal, {
    add(signal, listener) { if (signal === "SIGTERM") throw new Error("synthetic listener refusal"); events.on(signal, listener); },
    remove(signal, listener) { events.off(signal, listener); },
  })).toThrow();
  expect(events.listenerCount("SIGINT")).toBe(0); expect(events.listenerCount("SIGTERM")).toBe(0);
});
