import { createHash } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, release, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { afterAll, beforeAll, expect, test } from "bun:test";
import { z } from "zod";

import { runBoundedProcess } from "../bounded-process";

const enabled = process.env.OOMPA_CLAUDE_MACOS_FOREGROUND_NATIVE === "1";
const nativeTest = test.skipIf(!enabled);
const repository = resolve(import.meta.dir, "../..");
const neutral = { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C", TZ: "UTC" };
const sha256 = async (path: string): Promise<string> => createHash("sha256").update(await readFile(path)).digest("hex");
let root: string | undefined;
let fixture: string;
let fixtureSha: string;
let toolingUncertain = false;
let spawnUncertain = false;
let nextCase = 0;

const signal = z.enum(["SIGINT", "SIGTERM"]).nullable();
const count = z.number().int().min(0).max(4);
const resultSchema = z.object({
  result: z.union([
    z.object({ state: z.literal("joined"), exitCode: z.number().int().min(0).max(255), interruptedBy: signal }).strict(),
    z.object({ state: z.literal("not_started"), reason: z.enum(["spawn_failed", "preflight_stale"]) }).strict(),
    z.object({ state: z.literal("not_started"), reason: z.literal("interrupted_before_spawn"), interruptedBy: signal }).strict(),
  ]),
  settlement: z.object({ cleanup: z.enum(["joined", "uncertain"]), childJoined: z.boolean(), exitCode: z.number().int().min(0).max(255).nullable(),
    browserMode: z.literal("owner_manual").optional(),
    ownerTerminalVerified: z.literal(true), stdin: z.literal(0), stdout: z.literal(1), stderr: z.literal(2),
    requestedSignals: z.object({ SIGINT: count, SIGTERM: count, SIGKILL: count }).strict(),
  }).strict().nullable(),
  secondRefused: z.boolean(), ownerPid: z.number().int().positive().max(2_147_483_647),
}).strict();
type WorkerResult = z.infer<typeof resultSchema>;
type Owner = {
  child: Bun.Subprocess;
  directory: string;
  mode: string;
  terminal: Bun.Terminal | null;
  terminalResult: number | null;
  outputBytes: number;
  failed: boolean;
  joined: boolean;
  code: number | null;
  result: WorkerResult | null;
  disconnected: boolean;
};
const owners: Owner[] = [];

beforeAll(async () => {
  if (!enabled) return;
  if (process.platform !== "darwin" || Bun.version !== "1.3.14") throw new Error("foreground_native_platform_refused");
  const requested = process.env.OOMPA_OWNED_CONTROLLER_ZIG;
  if (requested === undefined || !isAbsolute(requested)) throw new Error("foreground_native_compiler_required");
  const zig = await realpath(requested);
  root = await realpath(await mkdtemp(join(tmpdir(), "oompa-foreground-")));
  await chmod(root, 0o700);
  fixture = join(root, "fixture");
  toolingUncertain = true;
  const version = await runBoundedProcess({ executable: zig, arguments: ["version"], containment: "local", cwd: root, environment: neutral,
    outputMaximumBytes: 256, phase: "foreground-fixture-version", terminationGraceMs: 1000, killSettlementMs: 1000, timeoutMs: 1000,
  }, { recoveryDirectory: join(root, "version-recovery") });
  toolingUncertain = version.cleanup !== "proven";
  if (version.cleanup !== "proven" || version.exitCode !== 0 || version.stdout.toString("utf8").trim() !== "0.16.0" || version.stderr.byteLength !== 0) throw new Error("foreground_native_compiler_refused");
  toolingUncertain = true;
  const built = await runBoundedProcess({ executable: zig, arguments: ["build-exe", "-O", "ReleaseSafe", "-fstrip", "-lc",
    "--cache-dir", join(root, "cache"), "--global-cache-dir", join(root, "global-cache"), join(import.meta.dir, "foreground-fixture.zig"), `-femit-bin=${fixture}`],
    containment: "local", cwd: repository, environment: { ...neutral, XDG_CACHE_HOME: join(root, "user-cache") },
    outputMaximumBytes: 1024 * 1024, phase: "foreground-fixture-build", terminationGraceMs: 1000, killSettlementMs: 1000, timeoutMs: 60000,
  }, { recoveryDirectory: join(root, "compiler-recovery") });
  toolingUncertain = built.cleanup !== "proven";
  if (built.cleanup !== "proven" || built.exitCode !== 0) throw new Error(`foreground_native_build_failed: ${built.stderr.toString("utf8").slice(0, 4096)}`);
  fixtureSha = await sha256(fixture);
  const files = ["binding.ts", "foreground.ts", "foreground-native.test.ts", "foreground-native-worker.ts", "foreground-fixture.zig"];
  console.info(JSON.stringify({ evidence: "foreground_native_provenance", platform: process.platform, architecture: process.arch, kernelRelease: release(), bun: Bun.version,
    zig, zigVersion: "0.16.0", zigSha256: await sha256(zig), fixtureSha256: fixtureSha, root,
    sources: Object.fromEntries(await Promise.all(files.map(async (name) => [name, await sha256(join(import.meta.dir, name))]))),
  }));
}, 90000);

const exists = async (path: string): Promise<boolean> => {
  try { return (await lstat(path)).isFile(); } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
};
const waitUntil = async (condition: () => Promise<boolean> | boolean, deadlineMs = 4000): Promise<void> => {
  const deadline = performance.now() + deadlineMs;
  while (!await condition()) { if (performance.now() >= deadline) throw new Error("foreground_native_deadline"); await Bun.sleep(10); }
};
const readResult = async (owner: Owner): Promise<WorkerResult> => {
  const path = join(owner.directory, "result.json");
  if ((await lstat(path)).size > 4096) throw new Error("foreground_native_result_refused");
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  const result = resultSchema.parse(value);
  if (result.ownerPid !== owner.child.pid) throw new Error("foreground_native_owner_refused");
  owner.result = result; return result;
};

const start = async (mode: string): Promise<Owner> => {
  if (root === undefined) throw new Error("foreground_native_root_missing");
  const directory = join(root, `case-${String(++nextCase)}`);
  await mkdir(join(directory, mode), { recursive: true, mode: 0o700 });
  await mkdir(join(directory, "temporary"), { mode: 0o700 });
  await copyFile(fixture, join(directory, "fixture")); await chmod(join(directory, "fixture"), 0o700);
  await writeFile(join(directory, "input.json"), JSON.stringify({ mode, sha256: fixtureSha }), { mode: 0o600, flag: "wx" });
  let observed: Owner | null = null;
  let outputBytes = 0;
  let terminalResult: number | null = null;
  let disconnected = false;
  spawnUncertain = true;
  const child = Bun.spawn([process.execPath, "--no-install", join(import.meta.dir, "foreground-native-worker.ts")], {
    cwd: directory, env: { ...neutral, HOME: homedir(), TMPDIR: tmpdir(), OOMPA_CLAUDE_MACOS_FOREGROUND_WORKER: "1" },
    ipc() { /* No child-to-owner payload is admitted. */ },
    onDisconnect() { disconnected = true; if (observed !== null) observed.disconnected = true; },
    terminal: { cols: 80, rows: 24,
      data(_terminal, data) {
        outputBytes += data.byteLength;
        if (observed !== null) { observed.outputBytes = outputBytes; if (outputBytes > 4096) observed.failed = true; }
      },
      exit(_terminal, code) { terminalResult = code; if (observed !== null) observed.terminalResult = code; },
    },
  });
  const terminal = child.terminal ?? null;
  const owner: Owner = { child, terminal, directory, mode, terminalResult, outputBytes, disconnected, failed: outputBytes > 4096, joined: false, code: null, result: null };
  observed = owner; owners.push(owner);
  spawnUncertain = false;
  void child.exited.then((code) => { owner.joined = true; owner.code = code; }, () => { owner.failed = true; });
  if (terminal === null) throw new Error("foreground_native_terminal_missing");
  return owner;
};

const finish = async (owner: Owner): Promise<WorkerResult> => {
  await waitUntil(() => owner.joined && owner.disconnected && owner.terminalResult !== null);
  if (owner.failed || owner.code !== 0 || owner.terminalResult !== 0 || owner.terminal === null) throw new Error("foreground_native_join_refused");
  owner.terminal.close();
  if (!owner.terminal.closed) throw new Error("foreground_native_terminal_close_refused");
  return await readResult(owner);
};

nativeTest("foreground login inherits the owner's terminal and joins normally without capturing provider output", async () => {
  const owner = await start("normal"); const result = await finish(owner);
  expect(result.result).toEqual({ state: "joined", exitCode: 0, interruptedBy: null });
  expect(result.settlement).toMatchObject({ cleanup: "joined", childJoined: true, ownerTerminalVerified: true, stdin: 0, stdout: 1, stderr: 2,
    requestedSignals: { SIGINT: 0, SIGTERM: 0, SIGKILL: 0 } });
  const marker = await readFile(join(owner.directory, owner.mode, "started"), "utf8");
  const fields = marker.trim().split(" ");
  expect(fields.slice(1)).toEqual([String(owner.child.pid), String(owner.child.pid), String(owner.child.pid), "inherited-owner-tty"]);
});

nativeTest("manual-browser qualification passes exactly the fixed opener to the synthetic child", async () => {
  const owner = await start("manual_browser"); const result = await finish(owner);
  // The fixed Zig child exits before writing its marker unless BROWSER is exactly /usr/bin/true.
  // It never executes that command, a browser, a provider, or an OAuth operation.
  expect(result.result).toEqual({ state: "joined", exitCode: 0, interruptedBy: null });
  expect(result.settlement).toMatchObject({ cleanup: "joined", childJoined: true, browserMode: "owner_manual",
    requestedSignals: { SIGINT: 0, SIGTERM: 0, SIGKILL: 0 } });
  expect(await exists(join(owner.directory, owner.mode, "started"))).toBeTrue();
});

nativeTest("explicit abort forwards TERM once then forces and joins the exact foreground child", async () => {
  const owner = await start("abort");
  await waitUntil(async () => await exists(join(owner.directory, owner.mode, "started")));
  owner.child.send({ kind: "abort" });
  const result = await finish(owner);
  expect(result.result).toEqual({ state: "joined", exitCode: 137, interruptedBy: "SIGTERM" });
  expect(result.settlement).toMatchObject({ cleanup: "joined", childJoined: true, requestedSignals: { SIGINT: 0, SIGTERM: 1, SIGKILL: 1 } });
  expect(await readFile(join(owner.directory, owner.mode, "signals"), "utf8")).toBe("T");
});

nativeTest("real terminal Ctrl-C reaches the group without a duplicate forwarded signal", async () => {
  const owner = await start("ctrl_c");
  await waitUntil(async () => await exists(join(owner.directory, owner.mode, "started")));
  expect(owner.terminal?.write("\u0003")).toBe(1);
  const result = await finish(owner);
  expect(result.result).toEqual({ state: "joined", exitCode: 130, interruptedBy: "SIGINT" });
  expect(result.settlement).toMatchObject({ cleanup: "joined", childJoined: true, requestedSignals: { SIGINT: 0, SIGTERM: 0, SIGKILL: 0 } });
  expect(await readFile(join(owner.directory, owner.mode, "signals"), "utf8")).toBe("I");
});

nativeTest("pre-spawn interruption and changed executable or terminal binding create no child", async () => {
  for (const mode of ["preabort", "binding_changed", "terminal_changed"]) {
    const owner = await start(mode); const result = await finish(owner);
    expect(result.result).toMatchObject({ state: "not_started", reason: mode === "preabort" ? "interrupted_before_spawn" : "spawn_failed" });
    expect(result.settlement).toBeNull();
    expect(await exists(join(owner.directory, owner.mode, "started"))).toBeFalse();
  }
});

nativeTest("one factory binds exactly one attempt even while its first child is alive", async () => {
  const owner = await start("one_owner"); const result = await finish(owner);
  expect(result.secondRefused).toBeTrue();
  expect(result.settlement).toMatchObject({ cleanup: "joined", childJoined: true, exitCode: 0 });
});

afterAll(async () => {
  if (!enabled) return;
  let uncertain = toolingUncertain || spawnUncertain;
  for (const owner of owners) {
    try {
      const childJoined = (): boolean => owner.joined;
      if (!childJoined()) {
        owner.child.send({ kind: "abort" });
        try { await waitUntil(childJoined, 1500); }
        catch { if (!childJoined()) owner.child.kill("SIGKILL"); uncertain = true; }
      }
      await waitUntil(() => owner.joined && owner.disconnected && owner.terminalResult !== null, 1500);
      if (owner.terminal === null) throw new Error("foreground_native_terminal_missing");
      owner.terminal.close();
      if (!owner.terminal.closed || owner.terminalResult !== 0 || owner.failed || owner.code !== 0) throw new Error("foreground_native_cleanup_uncertain");
      const result = owner.result ?? await readResult(owner);
      if (result.result.state === "joined" && (result.settlement?.cleanup !== "joined" || !result.settlement.childJoined)) throw new Error("foreground_native_child_unjoined");
      const markerPath = join(owner.directory, owner.mode, "started");
      const markerExists = await exists(markerPath);
      if (result.result.state === "not_started" && (result.settlement !== null || markerExists)) throw new Error("foreground_native_result_incoherent");
      if (markerExists) {
        const marker = await readFile(markerPath, "utf8");
        const match = /^([1-9][0-9]*) ([1-9][0-9]*) [1-9][0-9]* [1-9][0-9]* inherited-owner-tty\n$/u.exec(marker);
        if (match?.[1] === undefined || match[2] !== String(owner.child.pid)) throw new Error("foreground_native_identity_refused");
        const collected = await runBoundedProcess({ executable: "/bin/ps", arguments: ["-p", match[1], "-o", "pid="],
          containment: "local", cwd: owner.directory, environment: neutral, outputMaximumBytes: 384, phase: "foreground-fixture-absence",
          terminationGraceMs: 100, killSettlementMs: 500, timeoutMs: 1000,
        }, { recoveryDirectory: join(owner.directory, "absence-recovery") });
        if (collected.cleanup !== "proven" || collected.exitCode !== 1 || collected.stdout.byteLength !== 0 || collected.stderr.byteLength !== 0) throw new Error("foreground_native_identity_unproven");
      } else if (result.result.state !== "not_started") throw new Error("foreground_native_identity_missing");
    } catch { uncertain = true; }
  }
  if (uncertain) {
    console.info(JSON.stringify({ evidence: "foreground_native_cleanup_uncertain", workers: owners.map((owner) => ({
      pid: owner.child.pid, joined: owner.joined, code: owner.code, disconnected: owner.disconnected,
      terminalResult: owner.terminalResult, terminalClosed: owner.terminal?.closed ?? false, outputBytes: owner.outputBytes,
    })) }));
    throw new Error(`foreground_native_cleanup_uncertain; retained ${root ?? "uncreated"}`);
  }
  if (root !== undefined) await rm(root, { recursive: true });
  console.info(JSON.stringify({ evidence: "foreground_native_cleanup", workersJoined: owners.length, terminalsClosed: owners.length,
    directChildrenJoined: owners.filter((owner) => owner.result?.settlement?.childJoined === true).length,
    fixtureIdentitiesAbsent: true, toolingCleanup: "proven", privateRootRemoved: root !== undefined }));
}, 30000);
