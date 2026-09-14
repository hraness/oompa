import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm } from "node:fs/promises";
import { homedir, release, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, expect, test } from "bun:test";

import { readClaudeAuthenticationObservation } from "../../src/claude/auth";
import { buildPinnedClaudeRuntimeArgv, spawnClaudeVersionProbe, type PinnedClaudeRuntime } from "../../src/claude/runtime";
import { CLAUDE_PIN, CLAUDE_PIN_EFFORT, CLAUDE_PIN_MODEL, CLAUDE_PIN_NATIVE_FALLBACK_CAPABILITY } from "../../src/claude/pin";
import { runBoundedProcess } from "../bounded-process";
import { bindDarwinDetachedAuthProcess, observeDarwinDetachedStatusOverlap, type DetachedAuthProcess, type DetachedStatusOverlap } from "./process";
import { collectOwnedDarwinInspector } from "./detachment";

const enabled = process.env.OOMPA_CLAUDE_MACOS_AUTH_PROCESS_NATIVE === "1";
const nativeTest = test.skipIf(!enabled);
const executeFile = promisify(execFile);
const repository = resolve(import.meta.dir, "../..");
const neutralEnvironment = { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C", TZ: "UTC" };
const sha256 = async (path: string): Promise<string> => createHash("sha256").update(await readFile(path)).digest("hex");
let root: string | undefined;
let fixture: string;
let fixtureSha: string;
let compilerCleanupUnproven = false;
let sequence = 0;
const owners: DetachedAuthProcess[] = [];
const overlapOwners: Promise<DetachedStatusOverlap>[] = [];
type InspectorOwner = {
  child: Bun.Subprocess<"ignore", "pipe", "pipe">;
  collection: ReturnType<typeof collectOwnedDarwinInspector> | null;
};
const inspectorOwners: InspectorOwner[] = [];
const cases: { configDir: string; descendantPossible: boolean }[] = [];

beforeAll(async () => {
  if (!enabled) return;
  if (process.platform !== "darwin" || Bun.version !== "1.3.14") throw new Error("auth_process_native_platform_refused");
  const requested = process.env.OOMPA_OWNED_CONTROLLER_ZIG;
  if (requested === undefined || !isAbsolute(requested)) throw new Error("auth_process_native_compiler_required");
  const zig = await realpath(requested);
  root = await realpath(await mkdtemp(join(tmpdir(), "oompa-auth-process-")));
  await chmod(root, 0o700);
  fixture = join(root, "fixture");
  compilerCleanupUnproven = true;
  const version = await runBoundedProcess({ executable: zig, arguments: ["version"],
    containment: "local", cwd: root, environment: neutralEnvironment,
    outputMaximumBytes: 256, phase: "claude-macos-auth-process-compiler-version", terminationGraceMs: 1000, killSettlementMs: 1000, timeoutMs: 1000,
  }, { recoveryDirectory: join(root, "version-recovery") });
  compilerCleanupUnproven = version.cleanup !== "proven";
  if (version.cleanup !== "proven" || version.exitCode !== 0 || version.stdout.toString("utf8").trim() !== "0.16.0" || version.stderr.byteLength !== 0) throw new Error("auth_process_native_compiler_refused");
  compilerCleanupUnproven = true;
  const built = await runBoundedProcess({ executable: zig, arguments: ["build-exe", "-O", "ReleaseSafe", "-fstrip", "-lc",
    "--cache-dir", join(root, "cache"), "--global-cache-dir", join(root, "global-cache"), join(import.meta.dir, "fixture.zig"), `-femit-bin=${fixture}`],
    containment: "local", cwd: repository, environment: { ...neutralEnvironment, XDG_CACHE_HOME: join(root, "user-cache") },
    outputMaximumBytes: 1024 * 1024, phase: "claude-macos-auth-process-fixture-build", terminationGraceMs: 1000, killSettlementMs: 1000, timeoutMs: 60000,
  }, { recoveryDirectory: join(root, "compiler-recovery") });
  compilerCleanupUnproven = built.cleanup !== "proven";
  if (built.cleanup !== "proven" || built.exitCode !== 0) throw new Error(`auth_process_native_build_failed: ${built.stderr.toString("utf8").slice(0, 4096)}`);
  fixtureSha = await sha256(fixture);
  const files = ["binding.ts", "process.ts", "detachment.ts", "native.test.ts", "fixture.zig"];
  console.info(JSON.stringify({ evidence: "claude_macos_auth_process_native_provenance", platform: process.platform, architecture: process.arch,
    kernelRelease: release(), bun: Bun.version, zig, zigVersion: version.stdout.toString("utf8").trim(), zigSha256: await sha256(zig), fixtureSha256: fixtureSha,
    sources: Object.fromEntries(await Promise.all(files.map(async (file) => [file, await sha256(join(import.meta.dir, file))]))), root,
    abi: "native Darwin libc; Zig ReleaseSafe -fstrip -lc; Bun direct detached spawn; synthetic program only",
  }));
}, 90000);

const exists = async (path: string): Promise<boolean> => {
  try { return (await lstat(path)).isFile(); }
  catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
};
const waitUntil = async (predicate: () => Promise<boolean>, limit = 3000): Promise<void> => {
  const deadline = performance.now() + limit;
  while (!await predicate()) { if (performance.now() >= deadline) throw new Error("auth_process_native_observation_deadline"); await Bun.sleep(10); }
};
const waitGone = async (pid: number): Promise<void> => {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("auth_process_native_pid_refused");
  await waitUntil(async () => {
    try { await executeFile("/bin/ps", ["-p", String(pid), "-o", "pid="], { env: neutralEnvironment, timeout: 1000, maxBuffer: 256 }); return false; }
    catch (error: unknown) {
      const value = error as { code?: unknown; stdout?: unknown; stderr?: unknown };
      if (value.code === 1 && value.stdout === "" && value.stderr === "") return true;
      throw new Error("auth_process_native_identity_unproven");
    }
  });
};

const prepare = async (mode = "normal", deadlineMs = 3000) => {
  if (root === undefined) throw new Error("auth_process_native_root_missing");
  const parent = join(root, `case-${String(++sequence)}`);
  const configDir = join(parent, mode);
  const temporaryDirectory = join(parent, "temporary");
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await mkdir(temporaryDirectory, { mode: 0o700 });
  cases.push({ configDir, descendantPossible: mode === "late" });
  const executablePath = join(parent, "fixture");
  await copyFile(fixture, executablePath); await chmod(executablePath, 0o700);
  const input = { executablePath, executableSha256: fixtureSha, configDir, temporaryDirectory, deadlineMs,
    environment: { ...neutralEnvironment, HOME: homedir(), ANTHROPIC_API_KEY: "synthetic-must-not-cross", NODE_OPTIONS: "synthetic-must-not-cross" },
  };
  const binding = bindDarwinDetachedAuthProcess(input);
  const start = (operation: Parameters<typeof binding.start>[0]) => { const value = binding.start(operation); owners.push(value); return value; };
  const runtime: PinnedClaudeRuntime = { executablePath, version: CLAUDE_PIN, model: CLAUDE_PIN_MODEL, effort: CLAUDE_PIN_EFFORT,
    nativeFallback: CLAUDE_PIN_NATIVE_FALLBACK_CAPABILITY, argv: buildPinnedClaudeRuntimeArgv({ executablePath, nativeFallback: CLAUDE_PIN_NATIVE_FALLBACK_CAPABILITY }) };
  return { input, binding, start, runtime };
};
const bytes = async (source: AsyncIterable<Uint8Array>): Promise<Uint8Array> => {
  const chunks: Uint8Array[] = []; for await (const value of source) chunks.push(value);
  return Buffer.concat(chunks);
};

nativeTest("direct Bun detached status is independently observed and accepted by the existing status collector", async () => {
  const value = await prepare();
  const result = await readClaudeAuthenticationObservation({ configDir: value.input.configDir, configHome: "isolated", runtime: value.runtime,
    environment: value.binding.environment, signal: new AbortController().signal, deadlineMs: 3000,
    processFactory: (input) => { const child = value.binding.statusFactory(input) as DetachedAuthProcess; owners.push(child); return child; },
  });
  expect(result).toEqual({ signedIn: false, authentication: "none" });
  const settlement = await value.binding.settled();
  expect(settlement).toMatchObject({ admitted: true, cleanup: "joined", childJoined: true, stdoutEof: true, stderrEof: true, exitCode: 1,
    inspectionComplete: true, inspectorsStarted: 2, inspectorsJoined: 2,
    detachment: { setsidChecked: true, newSession: true, controllingTty: false, stdinClosed: true, identity: { pidDomain: "darwin" } } });
  expect(settlement?.elapsedMs).toBeLessThan(3000);
  const self = await readFile(join(value.input.configDir, "started"), "utf8");
  expect(self).toBe(`${String(settlement?.detachment?.identity.pid)} ${String(settlement?.detachment?.identity.pid)} ${String(settlement?.detachment?.identity.pid)} detached-no-tty-stdin-eof\n`);
});

nativeTest("version uses the existing collector and all other fixed operations collect their exact child", async () => {
  const value = await prepare();
  const result = await spawnClaudeVersionProbe({ executablePath: value.input.executablePath, configDir: value.input.configDir, configHome: "isolated",
    environment: value.binding.environment, signal: new AbortController().signal, deadlineMs: 3000,
    processFactory: (input) => { const child = value.binding.versionFactory(input) as DetachedAuthProcess; owners.push(child); return child; },
  });
  expect(result).toBe("2.1.260 (Claude Code)\n");
  for (const operation of ["login_help", "logout_help", "logout"] as const) {
    const next = await prepare(); const child = next.start(operation);
    const [output, diagnostic, code, settlement] = await Promise.all([bytes(child.stdout), bytes(child.stderr), child.exited, child.settlement]);
    expect(code).toBe(0); expect(diagnostic.byteLength).toBe(0);
    expect(new TextDecoder().decode(output)).toBe(operation === "logout" ? "" : operation === "login_help"
      ? "Usage: claude auth login [options]\n\nOptions:\n  --claudeai  Log in with a Claude subscription\n  -h, --help  Display help\n"
      : "Usage: claude auth logout [options]\n\nOptions:\n  -h, --help  Display help\n");
    expect(settlement).toMatchObject({ admitted: true, cleanup: "joined", childJoined: true, stdoutEof: true, stderrEof: true });
  }
});

nativeTest("binding and factory mismatches refuse before synthetic execution", async () => {
  const value = await prepare();
  expect(() => value.binding.statusFactory({ argv: [value.input.executablePath, "auth", "status", "--json", "extra"], environment: value.binding.environment })).toThrow("factory_refused");
  expect(() => value.binding.statusFactory({ argv: [value.input.executablePath, "auth", "status", "--json"], environment: { ...value.binding.environment, EXTRA: "refused" } })).toThrow("factory_refused");
  await rename(value.input.configDir, `${value.input.configDir}-moved`);
  await mkdir(value.input.configDir, { mode: 0o700 });
  expect(() => value.start("status")).toThrow("binding_changed");
  expect(await exists(join(value.input.configDir, "started"))).toBeFalse();
});

nativeTest("the executable incarnation is rechecked before every dispatch", async () => {
  const value = await prepare();
  await chmod(value.input.executablePath, 0o500);
  expect(() => value.start("version")).toThrow("binding_changed");
  expect(await exists(join(value.input.configDir, "started"))).toBeFalse();
});

nativeTest("one bound child owns the operation until collection and refused observations cannot replay", async () => {
  const value = await prepare("timeout", 100);
  const child = value.start("status");
  expect(() => value.start("logout")).toThrow("owner_busy");
  const result = await child.settlement;
  expect(result).toMatchObject({ admitted: false, cleanup: "joined", childJoined: true });
  await expect(child.exited).rejects.toThrow("observation_unproven");
  expect(() => value.start("status")).toThrow("owner_busy");
});

nativeTest("explicit cancellation joins only the exact detached fixture", async () => {
  const value = await prepare("cancel"); const child = value.start("status");
  await waitUntil(async () => await exists(join(value.input.configDir, "started")));
  child.terminate(); child.forceTerminate();
  expect(await child.settlement).toMatchObject({ admitted: false, cleanup: "joined", childJoined: true });
});

nativeTest("oversized output never yields status bytes", async () => {
  const value = await prepare("overflow"); const child = value.start("status");
  await expect(bytes(child.stdout)).rejects.toThrow("observation_unproven");
  expect(await child.settlement).toMatchObject({ admitted: false, cleanup: "joined", childJoined: true, stdoutEof: false });
});

nativeTest("a quick empty exit cannot pass the existing status parser even if detachment was observed", async () => {
  const value = await prepare("immediate");
  await expect(readClaudeAuthenticationObservation({ configDir: value.input.configDir, configHome: "isolated", runtime: value.runtime,
    environment: value.binding.environment, signal: new AbortController().signal, deadlineMs: 3000,
    processFactory: (input) => { const child = value.binding.statusFactory(input) as DetachedAuthProcess; owners.push(child); return child; },
  })).rejects.toThrow();
  expect(await value.binding.settled()).toMatchObject({ cleanup: "joined", childJoined: true });
});

nativeTest("inspector timeout joins its own exact TERM-resistant child and both pipes", async () => {
  if (root === undefined) throw new Error("auth_process_native_root_missing");
  const marker = join(root, "inspector-ready");
  const child = Bun.spawn([fixture, "--inspect-hold"], { cwd: root, env: { ...neutralEnvironment, OOMPA_INSPECTOR_FIXTURE_MARKER: marker }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const owner: InspectorOwner = { child, collection: null };
  inspectorOwners.push(owner);
  await waitUntil(async () => await exists(marker));
  owner.collection = collectOwnedDarwinInspector(child, 100);
  expect(await owner.collection).toEqual({ cleanup: "joined", output: null });
  expect(child.signalCode).toBe("SIGKILL");
  await waitGone(child.pid);
});

nativeTest("descendant-held output cannot extend the observation deadline or grant containment", async () => {
  const value = await prepare("late", 700); const child = value.start("status");
  expect(await child.settlement).toMatchObject({ admitted: false, cleanup: "joined", childJoined: true, stdoutEof: false });
  await expect(child.exited).rejects.toThrow("observation_unproven");
});

const observeOverlap = (first: DetachedAuthProcess, second: DetachedAuthProcess, signal = new AbortController().signal) => {
  const observation = observeDarwinDetachedStatusOverlap(first, second, { signal, deadlineMs: 1000 });
  overlapOwners.push(observation); return observation;
};

nativeTest("actual status children supply ordered live overlap followed by both native joins", async () => {
  const a = await prepare(); const b = await prepare();
  const first = a.start("status"); const second = b.start("status");
  const pending = observeOverlap(first, second);
  expect(() => a.start("status")).toThrow("owner_busy");
  await expect(observeDarwinDetachedStatusOverlap(first, second, { signal: new AbortController().signal, deadlineMs: 1000 })).rejects.toThrow("overlap_pair_refused");
  const result = await pending;
  expect(result).toMatchObject({ admitted: true, cleanup: "joined", reason: "observed", inspectorsStarted: 3, inspectorsJoined: 3, targetsJoined: 2,
    witness: { order: "A1_B_A2" } });
  expect(result.witness?.first).toEqual((await first.settlement).detachment?.identity);
  expect(result.witness?.second).toEqual((await second.settlement).detachment?.identity);
  expect(result.witness?.first.pid).not.toBe(result.witness?.second.pid);
  expect(result.observationElapsedMs).toBeLessThan(1000);
  expect((await first.settlement).inspectorsStarted).toBe(2);
  expect((await second.settlement).inspectorsStarted).toBe(2);
});

nativeTest("completed children cannot be made concurrent by delayed or replaced public settlement promises", async () => {
  const a = await prepare(); const b = await prepare();
  const first = a.start("status");
  const actual = await first.settlement;
  Object.defineProperty(first, "settlement", { value: Promise.resolve(actual) });
  const second = b.start("status");
  await expect(observeDarwinDetachedStatusOverlap(first, second, { signal: new AbortController().signal, deadlineMs: 1000 })).rejects.toThrow("overlap_pair_refused");
  expect(await second.settlement).toMatchObject({ admitted: true, cleanup: "joined" });
});

nativeTest("descendant-held EOF does not count as a still-live target for overlap", async () => {
  const a = await prepare("late", 1500); const b = await prepare();
  const first = a.start("status");
  await waitUntil(async () => await exists(join(a.input.configDir, "descendant")));
  await Bun.sleep(30);
  const second = b.start("status");
  await expect(observeDarwinDetachedStatusOverlap(first, second, { signal: new AbortController().signal, deadlineMs: 1000 })).rejects.toThrow("overlap_pair_refused");
  expect(await first.settlement).toMatchObject({ cleanup: "joined", childJoined: true });
});

nativeTest("duplicate, swapped proxy and non-status instances refuse without consuming a valid pair", async () => {
  const a = await prepare(); const b = await prepare(); const version = await prepare();
  const first = a.start("status"); const second = b.start("status"); const other = version.start("version");
  for (const pair of [[first, first], [new Proxy(first, {}), second], [first, other]] as const) {
    await expect(observeDarwinDetachedStatusOverlap(pair[0], pair[1], { signal: new AbortController().signal, deadlineMs: 1000 })).rejects.toThrow("overlap_pair_refused");
  }
  expect(await observeOverlap(first, second)).toMatchObject({ admitted: true, cleanup: "joined" });
});

nativeTest("exit during an actual overlap observation refuses and still joins both targets and inspectors", async () => {
  const a = await prepare(); const b = await prepare();
  const first = a.start("status"); const second = b.start("status");
  const pending = observeOverlap(first, second);
  first.forceTerminate();
  expect(await pending).toMatchObject({ admitted: false, cleanup: "joined", witness: null, targetsJoined: 2 });
  expect(() => a.start("status")).toThrow("owner_busy");
  expect(() => b.start("status")).toThrow("owner_busy");
});

nativeTest("abort during overlap signals retained children and requires their original joined settlements", async () => {
  const a = await prepare(); const b = await prepare();
  const first = a.start("status"); const second = b.start("status");
  const controller = new AbortController();
  const pending = observeOverlap(first, second, controller.signal);
  controller.abort();
  expect(await pending).toMatchObject({ admitted: false, cleanup: "joined", reason: "aborted", witness: null, targetsJoined: 2 });
});

nativeTest("an early overlap witness cannot admit an oversized target result or a forged public promise", async () => {
  const a = await prepare("overflow"); const b = await prepare();
  const first = a.start("status"); const second = b.start("status");
  const original = first.settlement;
  Object.defineProperty(first, "settlement", { value: second.settlement });
  const pending = observeOverlap(first, second);
  try {
    expect(await pending).toMatchObject({ admitted: false, cleanup: "joined", witness: null, targetsJoined: 2 });
    expect(await original).toMatchObject({ admitted: false, cleanup: "joined" });
  } finally { Object.defineProperty(first, "settlement", { value: original }); }
});

afterAll(async () => {
  if (!enabled) return;
  let cleanupFailed = compilerCleanupUnproven;
  for (const pending of overlapOwners) {
    try { if ((await pending).cleanup !== "joined") cleanupFailed = true; }
    catch { cleanupFailed = true; }
  }
  for (const child of owners) {
    try { const result = await child.settlement; if (result.cleanup !== "joined" || !result.childJoined) cleanupFailed = true; }
    catch { cleanupFailed = true; }
  }
  for (const owner of inspectorOwners) {
    try {
      owner.collection ??= collectOwnedDarwinInspector(owner.child, 100);
      const result = await owner.collection;
      if (result.cleanup !== "joined") throw new Error("auth_process_inspector_unjoined");
      await waitGone(owner.child.pid);
    } catch { cleanupFailed = true; }
  }
  for (const value of cases) {
    try {
      const marker = join(value.configDir, "started");
      if (await exists(marker)) {
        const self = await readFile(marker, "utf8");
        const match = /^([1-9][0-9]*) [1-9][0-9]* [1-9][0-9]* detached-no-tty-stdin-eof\n$/u.exec(self);
        if (match?.[1] === undefined) throw new Error("auth_process_native_marker_refused");
        await waitGone(Number(match[1]));
      }
      if (value.descendantPossible) {
        const marker = join(value.configDir, "descendant");
        if (!await exists(marker)) throw new Error("auth_process_native_descendant_unproven");
        const text = await readFile(marker, "utf8");
        if (!/^[1-9][0-9]*\n$/u.test(text)) throw new Error("auth_process_native_descendant_unproven");
        await waitGone(Number(text.trim()));
      }
    } catch { cleanupFailed = true; }
  }
  if (cleanupFailed) throw new Error(`auth_process_native_cleanup_unproven; retained ${root ?? "uncreated"}`);
  if (root !== undefined) await rm(root, { recursive: true });
  console.info(JSON.stringify({ evidence: "claude_macos_auth_process_native_cleanup", ownedChildren: owners.length, ownedInspectorFixtures: inspectorOwners.length,
    inspectorChildrenStarted: (await Promise.all(owners.map((owner) => owner.settlement))).reduce((sum, value) => sum + value.inspectorsStarted, 0),
    inspectorChildrenJoined: (await Promise.all(owners.map((owner) => owner.settlement))).reduce((sum, value) => sum + value.inspectorsJoined, 0),
    overlapObservations: overlapOwners.length,
    overlapInspectorsStarted: (await Promise.all(overlapOwners)).reduce((sum, value) => sum + value.inspectorsStarted, 0),
    overlapInspectorsJoined: (await Promise.all(overlapOwners)).reduce((sum, value) => sum + value.inspectorsJoined, 0),
    compilerCleanup: "proven", exactFixtureIdentitiesAbsent: true, privateRootRemoved: root !== undefined }));
}, 30000);
