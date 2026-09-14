import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { homedir, release, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { afterAll, beforeAll, expect, test } from "bun:test";

import { runBoundedProcess, type BoundedProcessRequest } from "../bounded-process";
import { observeNativePrivateClaudeIdentity, observeNativePrivateClaudeIdentityPair, type NativeIdentityAuthorityScope, type NativeIdentityProbeInput } from "./native-observer";

const enabled = process.env.OOMPA_CLAUDE_MACOS_NATIVE_OBSERVER === "1";
const nativeTest = test.skipIf(!enabled);
const repository = resolve(import.meta.dir, "../..");
const neutralEnvironment = { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C", TZ: "UTC" };
const sha256 = async (path: string): Promise<string> => createHash("sha256").update(await readFile(path)).digest("hex");
const id = (last: string): string => `00000000-0000-4000-8000-${last.padStart(12, "0")}`;
let root: string | undefined;
let fixture: string;
let fixtureSha: string;
let unjoinedRunner = false;
let runnerSequence = 0;
let unprovedProbes = 0;
let overlapInspectors = 0;
const observations: { configDir: string; pid: number }[] = [];

async function runOwned(request: BoundedProcessRequest) {
  if (root === undefined) throw new Error("native_observer_fixture_root_missing");
  unjoinedRunner = true;
  const result = await runBoundedProcess(request, { recoveryDirectory: join(root, `runner-recovery-${String(++runnerSequence)}`) });
  if (result.cleanup !== "proven") throw new Error("native_observer_runner_cleanup_unproved");
  unjoinedRunner = false;
  return result;
}

beforeAll(async () => {
  if (!enabled) return;
  if (process.platform !== "darwin" || Bun.version !== "1.3.14") throw new Error("native_observer_fixture_platform_refused");
  const requested = process.env.OOMPA_OWNED_CONTROLLER_ZIG;
  if (requested === undefined || !isAbsolute(requested)) throw new Error("native_observer_fixture_compiler_required");
  const zig = await realpath(requested);
  root = await realpath(await mkdtemp(join(tmpdir(), "oompa-native-observer-")));
  await chmod(root, 0o700);
  fixture = join(root, "fixture");
  const version = await runOwned({ executable: zig, arguments: ["version"], containment: "local", cwd: root, environment: neutralEnvironment,
    outputMaximumBytes: 256, phase: "claude-native-observer-compiler-version", terminationGraceMs: 1000, killSettlementMs: 1000, timeoutMs: 1000 });
  if (version.exitCode !== 0 || version.stdout.toString("utf8").trim() !== "0.16.0" || version.stderr.byteLength !== 0) throw new Error("native_observer_fixture_compiler_refused");
  const built = await runOwned({ executable: zig, arguments: ["build-exe", "-O", "ReleaseSafe", "-fstrip", "-lc",
    "--cache-dir", join(root, "cache"), "--global-cache-dir", join(root, "global-cache"), join(import.meta.dir, "../claude-macos-auth-process/fixture.zig"), `-femit-bin=${fixture}`],
    containment: "local", cwd: repository, environment: { ...neutralEnvironment, XDG_CACHE_HOME: join(root, "user-cache") },
    outputMaximumBytes: 1024 * 1024, phase: "claude-native-observer-fixture-build", terminationGraceMs: 1000, killSettlementMs: 1000, timeoutMs: 60000 });
  if (built.exitCode !== 0) throw new Error("native_observer_fixture_build_failed");
  fixtureSha = await sha256(fixture);
  const files = ["native-observer.ts", "native-observer.test.ts", "native-observer-native.test.ts", "observer.ts", "identity.ts",
    "../claude-macos-auth-process/binding.ts", "../claude-macos-auth-process/process.ts", "../claude-macos-auth-process/detachment.ts", "../claude-macos-auth-process/fixture.zig"];
  console.info(JSON.stringify({ evidence: "claude_macos_native_observer_provenance", platform: process.platform, architecture: process.arch,
    kernelRelease: release(), bun: Bun.version, zig, zigVersion: "0.16.0", zigSha256: await sha256(zig), fixtureSha256: fixtureSha,
    sources: Object.fromEntries(await Promise.all(files.map(async (file) => [file, await sha256(join(import.meta.dir, file))]))), root,
    abi: "native Darwin libc; Zig ReleaseSafe -fstrip -lc; unchanged synthetic status fixture; genuine empty-profile metadata reader",
  }));
}, 90000);

nativeTest("one genuine detached synthetic status child reaches the same-probe normalized observer", async () => {
  if (root === undefined) throw new Error("native_observer_fixture_root_missing");
  const configDir = join(root, "normal");
  const temporaryDirectory = join(root, "temporary");
  await mkdir(configDir, { mode: 0o700 }); await mkdir(temporaryDirectory, { mode: 0o700 });
  const executablePath = join(root, "status-fixture");
  await copyFile(fixture, executablePath); await chmod(executablePath, 0o700);
  const key = new Uint8Array(32).fill(23);
  const runtime = { executablePath, executableSha256: fixtureSha, configDir, temporaryDirectory, environment: { ...neutralEnvironment, HOME: homedir() } };
  const request = { key, runId: id("1"), attemptId: id("2"), probeId: id("3"), profile: "A" as const, configDir, deadlineMs: 3000, signal: new AbortController().signal };
  let revalidations = 0;
  let finalAssertions = 0;
  const checkScope = (scope: NativeIdentityAuthorityScope): void => {
    expect(scope).toEqual({ runId: request.runId, attemptId: request.attemptId, probeId: request.probeId, profile: request.profile,
      configDir, deadlineMs: request.deadlineMs, signal: request.signal, runtime });
    expect(scope).not.toHaveProperty("key");
  };
  const input: NativeIdentityProbeInput = { request, runtime, authority: { async revalidate(scope) {
    checkScope(scope); revalidations += 1;
    await Promise.resolve();
    return { assertCurrent(current) { checkScope(current); expect(current).toBe(scope); finalAssertions += 1; } };
  } } };
  unprovedProbes += 1;
  let observation: Awaited<ReturnType<typeof observeNativePrivateClaudeIdentity>>;
  try {
    observation = await observeNativePrivateClaudeIdentity(input);
    observations.push({ configDir, pid: observation.native.detachment.identity.pid });
    unprovedProbes -= 1;
  }
  finally { key.fill(0); }
  expect(observation.source).toBe("native_process");
  expect(observation.identity).toMatchObject({ runId: id("1"), attemptId: id("2"), probeId: id("3"), profile: "A", signedIn: false,
    accountTag: null, emailTag: null, organizationTag: null, evidence: "reported_identity_only" });
  expect(observation.native).toMatchObject({ runId: id("1"), attemptId: id("2"), probeId: id("3"), profile: "A", deadlineMs: 3000,
    detachment: { setsidChecked: true, newSession: true, controllingTty: false, stdinClosed: true, identity: { pidDomain: "darwin" } } });
  expect(observation.native.elapsedMs).toBeLessThan(3000);
  expect(revalidations).toBe(1); expect(finalAssertions).toBe(1);
  expect(JSON.stringify(observation)).not.toContain(configDir);
  expect(JSON.stringify(observation)).not.toContain("projectsDirectory");
}, 10000);

nativeTest("two genuine native status probes join protected metadata and an actual ordered overlap witness", async () => {
  if (root === undefined) throw new Error("native_observer_fixture_root_missing");
  const parent = join(root, "pair"); await mkdir(parent, { mode: 0o700 });
  const executablePath = join(parent, "status-fixture");
  await copyFile(fixture, executablePath); await chmod(executablePath, 0o700);
  const key = new Uint8Array(32).fill(24);
  const signals = new AbortController();
  const assertions: string[] = [];
  const prepare = async (profile: "A" | "B"): Promise<NativeIdentityProbeInput> => {
    const privateRoot = join(parent, profile); await mkdir(privateRoot, { mode: 0o700 });
    const configDir = join(privateRoot, "normal"); const temporaryDirectory = join(privateRoot, "temporary");
    await mkdir(configDir, { mode: 0o700 }); await mkdir(temporaryDirectory, { mode: 0o700 });
    return { request: { key, runId: id("10"), attemptId: id("11"), probeId: id(profile === "A" ? "12" : "13"), profile,
      configDir, deadlineMs: 3000, signal: signals.signal },
    runtime: { executablePath, executableSha256: fixtureSha, configDir, temporaryDirectory, environment: { ...neutralEnvironment, HOME: homedir() } },
    authority: { async revalidate(scope) {
      expect(scope.profile).toBe(profile); expect(scope.configDir).toBe(configDir); expect(scope).not.toHaveProperty("key");
      await Promise.resolve(); return { assertCurrent(current) { expect(current).toBe(scope); assertions.push(profile); } };
    } } };
  };
  try {
    const first = await prepare("A"); const second = await prepare("B");
    unprovedProbes += 2;
    const result = await observeNativePrivateClaudeIdentityPair({ first, second, overlapDeadlineMs: 1000 });
    observations.push({ configDir: first.request.configDir, pid: result.first.native.detachment.identity.pid },
      { configDir: second.request.configDir, pid: result.second.native.detachment.identity.pid });
    unprovedProbes -= 2;
    overlapInspectors += result.overlap.inspectorsJoined;
    expect(result.source).toBe("native_process");
    expect(result.first.identity).toMatchObject({ signedIn: false, profile: "A", probeId: id("12") });
    expect(result.second.identity).toMatchObject({ signedIn: false, profile: "B", probeId: id("13") });
    expect(result.overlap).toMatchObject({ admitted: true, cleanup: "joined", reason: "observed", inspectorsStarted: 3, inspectorsJoined: 3,
      targetsJoined: 2, witness: { order: "A1_B_A2" } });
    expect(result.overlap.witness?.first).toEqual(result.first.native.detachment.identity);
    expect(result.overlap.witness?.second).toEqual(result.second.native.detachment.identity);
    expect(result.first.native.detachment.identity.pid).not.toBe(result.second.native.detachment.identity.pid);
    expect(assertions).toEqual(["A", "B"]);
    expect(JSON.stringify(result)).not.toContain(parent);
  } finally { key.fill(0); }
}, 10000);

afterAll(async () => {
  if (!enabled) return;
  let cleanupFailed = unjoinedRunner || unprovedProbes !== 0;
  for (const observation of observations) {
    try {
      if (root === undefined) throw new Error("native_observer_fixture_root_missing");
      const pid = observation.pid;
      const marker = await readFile(join(observation.configDir, "started"), "utf8");
      if (marker !== `${String(pid)} ${String(pid)} ${String(pid)} detached-no-tty-stdin-eof\n`) throw new Error("native_observer_fixture_identity_unproved");
      const absent = await runOwned({ executable: "/bin/ps", arguments: ["-p", String(pid), "-o", "pid="], containment: "local", cwd: root,
        environment: neutralEnvironment, outputMaximumBytes: 256, phase: "claude-native-observer-absence", terminationGraceMs: 1000, killSettlementMs: 1000, timeoutMs: 1000 });
      if (absent.exitCode !== 1 || absent.stdout.byteLength !== 0 || absent.stderr.byteLength !== 0) throw new Error("native_observer_fixture_absence_unproved");
    } catch { cleanupFailed = true; }
  }
  if (cleanupFailed) {
    console.info(JSON.stringify({ evidence: "claude_macos_native_observer_cleanup", cleanup: "uncertain", root, retained: true }));
    throw new Error("native_observer_fixture_cleanup_unproved");
  }
  if (root !== undefined) await rm(root, { recursive: true });
  console.info(JSON.stringify({ evidence: "claude_macos_native_observer_cleanup", cleanup: "joined", fixtureChildren: observations.length,
    inspectorChildren: observations.length * 2, overlapInspectors, boundedRunners: runnerSequence, rootRemoved: root !== undefined,
    scope: "exact synthetic children and owned inspectors; bounded A1/B/A2 observational overlap only; no descendants, provider qualification or replay authority" }));
}, 10000);
