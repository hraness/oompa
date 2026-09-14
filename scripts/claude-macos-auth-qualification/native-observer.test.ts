import { expect, test } from "bun:test";
import fc from "fast-check";

import type { DetachedAuthProcess, DetachedAuthSettlement, DetachedStatusOverlap } from "../claude-macos-auth-process/process";
import { NativeIdentityObserverError, observeCredentialFreeNativeIdentity, observeCredentialFreeNativeIdentityPair, observeNativePrivateClaudeIdentityPair,
  type NativeIdentityPairInput, type NativeIdentityProbeInput } from "./native-observer";

const id = (last: string): string => `00000000-0000-4000-8000-${last.padStart(12, "0")}`;
const deferred = () => {
  const state = Promise.withResolvers<undefined>();
  return { promise: state.promise, resolve: () => state.resolve(undefined) };
};
const input = (controller = new AbortController()): NativeIdentityProbeInput => ({
  request: { key: new Uint8Array(32).fill(17), runId: id("1"), attemptId: id("2"), probeId: id("3"), profile: "A", configDir: "/private/config-a", deadlineMs: 3000, signal: controller.signal },
  runtime: { executablePath: "/private/fixture", executableSha256: "a".repeat(64), configDir: "/private/config-a", temporaryDirectory: "/private/temp-a", environment: { HOME: "/owner", PATH: "/usr/bin:/bin" } },
  authority: { async revalidate() { return { assertCurrent() {} }; } },
});
const metadata = { accountUuid: "account-a", email: "alice@example.test", organizationUuid: "organization-a" };
const status = (signedIn = false, configDir = "/private/config-a"): Uint8Array => new TextEncoder().encode(JSON.stringify({ loggedIn: signedIn, authMethod: signedIn ? "claude.ai" : "none",
  apiProvider: "firstParty", analyticsDisabled: false, projectsDirectory: `${configDir}/projects`,
  ...(signedIn ? { email: metadata.email, orgId: metadata.organizationUuid } : {}),
}));
function fixture(signedIn = false, patch: Partial<DetachedAuthSettlement> = {}, configDir = "/private/config-a") {
  const stdout = status(signedIn, configDir); const stderr = new Uint8Array([100]);
  const terminal: DetachedAuthSettlement = { operation: "status", admitted: true, cleanup: "joined", childJoined: true, exitCode: signedIn ? 0 : 1,
    stdoutEof: true, stderrEof: true, stdoutBytes: stdout.byteLength, stderrBytes: stderr.byteLength,
    detachment: { identity: { pid: 123, pidDomain: "darwin", procStart: "Fri Sep 11 16:34:59 2026" }, setsidChecked: true, newSession: true, controllingTty: false, stdinClosed: true },
    deadlineMs: 3000, elapsedMs: 50, inspectionComplete: true, inspectorsStarted: 2, inspectorsJoined: 2, ...patch };
  const child: DetachedAuthProcess = { stdout: { async *[Symbol.asyncIterator]() { yield stdout; } }, stderr: { async *[Symbol.asyncIterator]() { yield stderr; } },
    exited: Promise.resolve(signedIn ? 0 : 1), settlement: Promise.resolve(terminal), terminate() {}, forceTerminate() {} };
  let starts = 0;
  const ports = { async readMetadataIdentity() { return signedIn ? { ...metadata } : null; },
    bindStatus() { return { startStatus() { starts += 1; return child; } }; } };
  return { stdout, stderr, child, terminal, ports, starts: () => starts };
}

test("native bridge fixture joins exact evidence to signed-out and normalized signed-in observations", async () => {
  for (const signedIn of [false, true]) {
    const value = fixture(signedIn); const request = input();
    const result = await observeCredentialFreeNativeIdentity(request, value.ports);
    expect(result.source).toBe("credential_free_fixture");
    expect(result.identity.signedIn).toBe(signedIn);
    expect(result.native).toMatchObject({ runId: id("1"), attemptId: id("2"), probeId: id("3"), profile: "A", deadlineMs: 3000,
      detachment: { setsidChecked: true, newSession: true, controllingTty: false, stdinClosed: true } });
    expect(JSON.stringify(result)).not.toContain(metadata.email);
    expect(JSON.stringify(result)).not.toContain("/private/config-a");
    expect(value.stdout.every((byte) => byte === 0)).toBeTrue(); expect(value.stderr.every((byte) => byte === 0)).toBeTrue();
    expect(request.request.key.every((byte) => byte === 17)).toBeTrue();
    expect(value.starts()).toBe(1);
  }
});

test("launch authority is fresh after the first metadata await and final assertion follows binding", async () => {
  const calls: string[] = []; const value = fixture(); const request = input();
  let reads = 0;
  const changed: NativeIdentityProbeInput = { ...request, authority: { async revalidate(scope) {
    calls.push("revalidate"); expect(scope).not.toHaveProperty("key"); expect(scope.probeId).toBe(id("3"));
    await Promise.resolve(); return { assertCurrent(current) { calls.push("assert-current"); expect(current).toBe(scope); } };
  } } };
  await observeCredentialFreeNativeIdentity(changed, {
    async readMetadataIdentity() { calls.push(`metadata-${String(++reads)}`); await Promise.resolve(); return null; },
    bindStatus(binding) { calls.push("bind"); expect(binding.configDir).toBe(request.request.configDir); return { startStatus() { calls.push("start"); return value.child; } }; },
  });
  expect(calls).toEqual(["metadata-1", "revalidate", "bind", "assert-current", "start", "metadata-2"]);
});

test("scope mismatch, stale authority and pre-launch abortion never create a status child", async () => {
  for (const mode of ["scope", "authority", "preabort", "metadata_abort", "revalidation_abort"] as const) {
    const controller = new AbortController(); const value = fixture(); const request = input(controller);
    if (mode === "preabort") controller.abort();
    const changed: NativeIdentityProbeInput = { ...request, runtime: mode === "scope" ? { ...request.runtime, configDir: "/private/config-b" } : request.runtime,
      authority: { async revalidate() { if (mode === "revalidation_abort") controller.abort(); return { assertCurrent() { if (mode === "authority") throw new Error("private owner detail"); } }; } } };
    let reads = 0;
    await expect(observeCredentialFreeNativeIdentity(changed, { ...value.ports, async readMetadataIdentity() { reads += 1; if (mode === "metadata_abort") controller.abort(); return null; } })).rejects.toMatchObject({ cleanup: "not_started" });
    expect(value.starts()).toBe(0);
    if (mode === "scope" || mode === "preabort") expect(reads).toBe(0);
  }
});

test("unadmitted, contradictory, late or incomplete native evidence never becomes a joined status", async () => {
  const cases: Partial<DetachedAuthSettlement>[] = [{ admitted: false }, { cleanup: "uncertain" }, { childJoined: false }, { stdoutEof: false }, { stderrEof: false },
    { inspectionComplete: false }, { inspectorsJoined: 1 }, { inspectorsStarted: 1, inspectorsJoined: 1 }, { detachment: null }, { operation: "version" },
    { deadlineMs: 4000 }, { elapsedMs: 3000 }, { stdoutBytes: 0 }, { stderrBytes: 2 }, { exitCode: 0 }];
  for (const patch of cases) {
    const value = fixture(false, patch);
    await expect(observeCredentialFreeNativeIdentity(input(), value.ports)).rejects.toBeInstanceOf(NativeIdentityObserverError);
    expect(value.stdout.every((byte) => byte === 0)).toBeTrue(); expect(value.stderr.every((byte) => byte === 0)).toBeTrue();
  }
  for (const patch of [{ inspectionComplete: false }, { inspectorsJoined: 1 }]) {
    await expect(observeCredentialFreeNativeIdentity(input(), fixture(false, patch).ports)).rejects.toMatchObject({ cleanup: "uncertain" });
  }
});

test("fixture composition refuses missing ports before metadata or native dispatch", async () => {
  const value = fixture();
  for (const field of ["readMetadataIdentity", "bindStatus"] as const) {
    const missing = { ...value.ports, [field]: undefined } as unknown as Parameters<typeof observeCredentialFreeNativeIdentity>[1];
    await expect(observeCredentialFreeNativeIdentity(input(), missing)).rejects.toMatchObject({ code: "invalid_input", cleanup: "not_started" });
  }
  expect(value.starts()).toBe(0);
});

test("metadata drift or mismatch after a joined child remains private and clears status bytes", async () => {
  for (const mode of ["drift", "mismatch"]) {
    const value = fixture(true); let reads = 0;
    await expect(observeCredentialFreeNativeIdentity(input(), { ...value.ports,
      async readMetadataIdentity() { return { ...metadata, email: mode === "mismatch" || reads++ > 0 ? "other@example.test" : metadata.email }; },
    })).rejects.toMatchObject({ code: "observation_unproved", cleanup: "joined" });
    expect(value.stdout.every((byte) => byte === 0)).toBeTrue();
  }
});

test("abort after spawn waits for native child settlement instead of returning an early cancellation", async () => {
  const controller = new AbortController(); const value = fixture(false, { admitted: false });
  let joined!: () => void;
  const join = new Promise<void>((resolve) => { joined = resolve; });
  let spawned!: () => void; const started = new Promise<void>((resolve) => { spawned = resolve; });
  let terminations = 0;
  const child: DetachedAuthProcess = { stdout: { async *[Symbol.asyncIterator]() { await join; yield value.stdout; } }, stderr: { async *[Symbol.asyncIterator]() { await join; yield value.stderr; } },
    exited: join.then(() => 1), settlement: join.then(() => value.terminal), terminate() { terminations += 1; }, forceTerminate() {} };
  let finished = false;
  const pending = observeCredentialFreeNativeIdentity(input(controller), { ...value.ports, bindStatus() { return { startStatus() { spawned(); return child; } }; } });
  const outcome = pending.then(() => { finished = true; return null; }, (error: unknown) => { finished = true; return error; });
  await started; controller.abort(); await Promise.resolve();
  expect(terminations).toBe(1); expect(finished).toBeFalse();
  joined();
  expect(await outcome).toMatchObject({ code: "aborted", cleanup: "joined" });
  expect(value.stdout.every((byte) => byte === 0)).toBeTrue();
});

test("malformed output lengths fail closed and wipe yielded buffers", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 16_385, max: 16_512 }), async (length) => {
    const value = fixture(); const bytes = new Uint8Array(length).fill(91);
    const child = { ...value.child, stdout: { async *[Symbol.asyncIterator]() { yield bytes; } } };
    await expect(observeCredentialFreeNativeIdentity(input(), { ...value.ports, bindStatus() { return { startStatus: () => child }; } })).rejects.toBeInstanceOf(NativeIdentityObserverError);
    expect(bytes.every((byte) => byte === 0)).toBeTrue();
  }), { numRuns: 25, seed: 20260911 });
});

function pairFixture() {
  const first = input(); const other = input();
  const second: NativeIdentityProbeInput = { ...other, request: { ...other.request, profile: "B", probeId: id("4"), configDir: "/private/config-b" },
    runtime: { ...other.runtime, configDir: "/private/config-b", temporaryDirectory: "/private/temp-b" } };
  const a = fixture(); const b = fixture(false, { detachment: {
    identity: { pid: 456, pidDomain: "darwin", procStart: "Fri Sep 11 16:34:59 2026" },
    setsidChecked: true, newSession: true, controllingTty: false, stdinClosed: true,
  } }, second.request.configDir);
  const pair: NativeIdentityPairInput = { first, second, overlapDeadlineMs: 1000 };
  const proof = (): DetachedStatusOverlap => ({ admitted: true, cleanup: "joined", reason: "observed", observationDeadlineMs: 1000,
    observationElapsedMs: 10, inspectorsStarted: 3, inspectorsJoined: 3, targetsJoined: 2,
    witness: { order: "A1_B_A2", first: { pid: 123, pidDomain: "darwin", procStart: "Fri Sep 11 16:34:59 2026" },
      second: { pid: 456, pidDomain: "darwin", procStart: "Fri Sep 11 16:34:59 2026" } } });
  let starts = 0; let overlaps = 0;
  const ports: Parameters<typeof observeCredentialFreeNativeIdentityPair>[1] = {
    async readMetadataIdentity() { return null; },
    bindStatus(value) { return { startStatus() { starts += 1; return value.configDir === first.request.configDir ? a.child : b.child; } }; },
    async observeOverlap(actualFirst, actualSecond) { overlaps += 1; expect(actualFirst).toBe(a.child); expect(actualSecond).toBe(b.child);
      await Promise.all([actualFirst.settlement, actualSecond.settlement]); return proof(); },
  };
  return { pair, a, b, ports, proof, starts: () => starts, overlaps: () => overlaps };
}

test("pair rendezvous admits both authorities before fixed A/B starts and actual-handle overlap", async () => {
  const value = pairFixture(); const calls: string[] = [];
  const authority = (profile: string): NativeIdentityProbeInput["authority"] => ({ async revalidate() {
    calls.push(`authority-${profile}`); await Promise.resolve(); return { assertCurrent() { calls.push(`assert-${profile}`); } };
  } });
  const result = await observeCredentialFreeNativeIdentityPair({ ...value.pair,
    first: { ...value.pair.first, authority: authority("A") }, second: { ...value.pair.second, authority: authority("B") } }, { ...value.ports,
    async readMetadataIdentity(scope) { calls.push(`metadata-${scope.configDir.endsWith("-a") ? "A" : "B"}`); return null; },
    bindStatus(scope) { const binding = value.ports.bindStatus(scope); const profile = scope.configDir.endsWith("-a") ? "A" : "B";
      calls.push(`bind-${profile}`); return { startStatus() { calls.push(`start-${profile}`); return binding.startStatus(); } }; },
    async observeOverlap(first, second, options) { calls.push("overlap"); return await value.ports.observeOverlap(first, second, options); },
  });
  expect(result.source).toBe("credential_free_fixture"); expect(result.first.identity.profile).toBe("A"); expect(result.second.identity.profile).toBe("B");
  expect(calls.slice(calls.indexOf("assert-A"), calls.indexOf("overlap") + 1)).toEqual(["assert-A", "start-A", "assert-B", "start-B", "overlap"]);
  for (const entry of ["metadata-A", "metadata-B", "authority-A", "authority-B", "bind-A", "bind-B"]) expect(calls.indexOf(entry)).toBeLessThan(calls.indexOf("start-A"));
  expect(result.overlap.witness?.first).toEqual(result.first.native.detachment.identity);
  expect(result.overlap.witness?.second).toEqual(result.second.native.detachment.identity);
  for (const bytes of [value.a.stdout, value.a.stderr, value.b.stdout, value.b.stderr]) expect(bytes.every((byte) => byte === 0)).toBeTrue();
  expect(JSON.stringify(result)).not.toContain("/private/");
});

test("pair preflight rejects scope, key, executable and overlapping roots before any native work", async () => {
  for (const mode of ["run", "attempt", "key", "profile", "probe", "config", "temporary", "nested", "cross", "pin", "executable", "deadline"] as const) {
    const value = pairFixture(); const second = value.pair.second;
    const request = { ...second.request,
      ...(mode === "run" ? { runId: id("9") } : {}), ...(mode === "attempt" ? { attemptId: id("9") } : {}),
      ...(mode === "key" ? { key: new Uint8Array(32).fill(24) } : {}), ...(mode === "profile" ? { profile: "A" as const } : {}),
      ...(mode === "probe" ? { probeId: value.pair.first.request.probeId } : {}),
      ...(mode === "config" ? { configDir: value.pair.first.request.configDir } : {}) };
    const runtime = { ...second.runtime,
      ...(mode === "temporary" ? { temporaryDirectory: value.pair.first.runtime.temporaryDirectory } : {}),
      ...(mode === "nested" ? { temporaryDirectory: `${value.pair.first.runtime.temporaryDirectory}/nested` } : {}),
      ...(mode === "cross" ? { temporaryDirectory: value.pair.first.runtime.configDir } : {}),
      ...(mode === "pin" ? { executableSha256: "b".repeat(64) } : {}), ...(mode === "executable" ? { executablePath: "/private/other" } : {}) };
    await expect(observeCredentialFreeNativeIdentityPair({ ...value.pair, second: { ...second, request, runtime },
      ...(mode === "deadline" ? { overlapDeadlineMs: 1001 } : {}) }, value.ports)).rejects.toMatchObject({ cleanup: "not_started" });
    expect(value.starts()).toBe(0); expect(value.overlaps()).toBe(0);
  }
});

test("native pair rejects fixture results or extra port fields as input instead of accepting synthetic authority", async () => {
  const value = pairFixture();
  for (const altered of [{ ...value.pair, ports: value.ports }, { ...value.pair, source: "credential_free_fixture" },
    { ...value.pair, overlap: value.proof() }, { ...value.pair, first: { ...value.pair.first, rendezvous() {} } }]) {
    await expect(observeNativePrivateClaudeIdentityPair(altered as NativeIdentityPairInput)).rejects.toMatchObject({ code: "invalid_input", cleanup: "not_started" });
  }
  expect(value.starts()).toBe(0);
});

test("pair refuses profile A status bytes under the profile B binding despite a joined overlap", async () => {
  const value = pairFixture();
  const wrong = fixture(false, { detachment: value.b.terminal.detachment }, value.pair.first.request.configDir);
  await expect(observeCredentialFreeNativeIdentityPair(value.pair, { ...value.ports,
    bindStatus(scope) { return { startStatus: () => scope.configDir.endsWith("-a") ? value.a.child : wrong.child }; },
    async observeOverlap(first, second) {
      expect(first).toBe(value.a.child); expect(second).toBe(wrong.child);
      await Promise.all([first.settlement, second.settlement]); return value.proof();
    },
  })).rejects.toMatchObject({ code: "observation_unproved", cleanup: "joined" });
  expect(value.a.stdout.every((byte) => byte === 0)).toBeTrue(); expect(wrong.stdout.every((byte) => byte === 0)).toBeTrue();
});

test("a peer metadata or authority failure rejects the rendezvous without stranding the other observer", async () => {
  for (const mode of ["metadata", "authority"]) {
    const value = pairFixture(); let reads = 0;
    const pair = { ...value.pair, second: { ...value.pair.second, authority: { async revalidate() { if (mode === "authority") throw new Error("private detail"); return { assertCurrent() {} }; } } } };
    await expect(observeCredentialFreeNativeIdentityPair(pair, { ...value.ports, async readMetadataIdentity(scope) {
      reads += 1; if (mode === "metadata" && scope.configDir.endsWith("-b")) throw new Error("private detail"); return null;
    } })).rejects.toMatchObject({ cleanup: "not_started" });
    expect(reads).toBe(2); expect(value.starts()).toBe(0); expect(value.overlaps()).toBe(0);
  }
});

test("partial launch refusal waits for the first child's exact join and consumes its streams once", async () => {
  for (const mode of ["assert", "spawn"]) {
    const value = pairFixture(); const joined = deferred(); let terminations = 0; let reads = 0;
    const first: DetachedAuthProcess = { ...value.a.child, stdout: { async *[Symbol.asyncIterator]() { reads += 1; await joined.promise; yield value.a.stdout; } },
      stderr: { async *[Symbol.asyncIterator]() { await joined.promise; yield value.a.stderr; } },
      exited: joined.promise.then(() => 1), settlement: joined.promise.then(() => value.a.terminal), terminate() { terminations += 1; }, forceTerminate() {} };
    const firstStarted = deferred();
    const pair = { ...value.pair, second: { ...value.pair.second, authority: { async revalidate() { return { assertCurrent() { if (mode === "assert") throw new Error("private owner detail"); } }; } } } };
    let complete = false;
    const pending = observeCredentialFreeNativeIdentityPair(pair, { ...value.ports, bindStatus(scope) { return { startStatus() {
      if (scope.configDir.endsWith("-b")) throw new Error("private spawn detail"); firstStarted.resolve(); return first;
    } }; } }).then(() => null, (error: unknown) => error).finally(() => { complete = true; });
    await firstStarted.promise; await Promise.resolve();
    expect(complete).toBeFalse(); expect(terminations).toBe(1);
    joined.resolve();
    expect(await pending).toMatchObject({ cleanup: mode === "spawn" ? "uncertain" : "joined" });
    expect(reads).toBe(1); expect(value.a.stdout.every((byte) => byte === 0)).toBeTrue(); expect(value.overlaps()).toBe(0);
  }
});

test("pair cannot use unjoined overlap, crossed identities or late observations after individual successes", async () => {
  for (const patch of [{ admitted: false }, { cleanup: "uncertain" as const }, { reason: "target_unproved" as const }, { inspectorsJoined: 2 },
    { targetsJoined: 1 }, { observationDeadlineMs: 900 }, { observationElapsedMs: 1000 }, { witness: null }]) {
    const value = pairFixture();
    await expect(observeCredentialFreeNativeIdentityPair(value.pair, { ...value.ports, async observeOverlap() { return { ...value.proof(), ...patch }; } })).rejects.toBeInstanceOf(NativeIdentityObserverError);
    expect(value.a.stdout.every((byte) => byte === 0)).toBeTrue(); expect(value.b.stdout.every((byte) => byte === 0)).toBeTrue();
  }
  const value = pairFixture();
  await expect(observeCredentialFreeNativeIdentityPair(value.pair, { ...value.ports, async observeOverlap() {
    const proof = value.proof(); if (proof.witness === null) throw new Error("fixture_missing_witness");
    return { ...proof, witness: { ...proof.witness, first: proof.witness.second, second: proof.witness.first } };
  } })).rejects.toMatchObject({ code: "native_unproved", cleanup: "joined" });
});

test("pair abortion refuses before launch or waits for both started children and overlap collection", async () => {
  const value = pairFixture(); const controller = new AbortController(); controller.abort();
  await expect(observeCredentialFreeNativeIdentityPair({ ...value.pair,
    first: { ...value.pair.first, request: { ...value.pair.first.request, signal: controller.signal } } }, value.ports)).rejects.toMatchObject({ code: "aborted", cleanup: "not_started" });
  expect(value.starts()).toBe(0);

  for (const held of ["A", "B", "overlap"] as const) {
    const next = pairFixture(); const abort = new AbortController(); const overlapping = deferred();
    const joins = { A: deferred(), B: deferred(), overlap: deferred() };
    const terminations = { A: 0, B: 0 }; const streamReads = { A: 0, B: 0 }; let overlapJoined = false;
    const child = (fixture: ReturnType<typeof pairFixture>["a"], profile: "A" | "B"): DetachedAuthProcess => ({ ...fixture.child,
      stdout: { async *[Symbol.asyncIterator]() { streamReads[profile] += 1; await joins[profile].promise; yield fixture.stdout; } },
      stderr: { async *[Symbol.asyncIterator]() { await joins[profile].promise; yield fixture.stderr; } },
      exited: joins[profile].promise.then(() => 1), settlement: joins[profile].promise.then(() => fixture.terminal),
      terminate() { terminations[profile] += 1; }, forceTerminate() {} });
    const a = child(next.a, "A"); const b = child(next.b, "B");
    let complete = false;
    const result = observeCredentialFreeNativeIdentityPair({ ...next.pair,
      first: { ...next.pair.first, request: { ...next.pair.first.request, signal: abort.signal } } }, { ...next.ports,
      bindStatus(scope) { return { startStatus: () => scope.configDir.endsWith("-a") ? a : b }; },
      async observeOverlap() { overlapping.resolve(); await joins.overlap.promise; overlapJoined = true; return next.proof(); },
    }).then(() => null, (error: unknown) => error).finally(() => { complete = true; });
    try {
      await overlapping.promise; abort.abort();
      expect(terminations.A).toBeGreaterThanOrEqual(1); expect(terminations.B).toBeGreaterThanOrEqual(1);
      for (const name of ["A", "B", "overlap"] as const) if (name !== held) joins[name].resolve();
      await Promise.all(Object.entries(joins).filter(([name]) => name !== held).map(([, join]) => join.promise));
      await Promise.resolve();
      expect(complete).toBeFalse();
      joins[held].resolve();
      expect(await result).toMatchObject({ code: "aborted", cleanup: "joined" });
      expect(complete).toBeTrue(); expect(overlapJoined).toBeTrue(); expect(streamReads).toEqual({ A: 1, B: 1 });
      for (const bytes of [next.a.stdout, next.a.stderr, next.b.stdout, next.b.stderr]) expect(bytes.every((byte) => byte === 0)).toBeTrue();
    } finally {
      for (const join of Object.values(joins)) join.resolve();
      await result;
    }
  }
});
