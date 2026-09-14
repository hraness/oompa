/** Explicit Mac-only synthetic PTYs under the installed scheduler; ordinary checks are inert. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseInheritedLease, resolveSlopcameraHostResourceModule } from "./host-run";
import { slopcameraArtifacts } from "./runtime-pin";
import { readThroughputEvents, throughputTelemetryRoot } from "./telemetry";

const enabled = process.env.OOMPA_HOST_TTY_NATIVE === "1";
const modes = ["child", "parent", "between", "after_join", "cached_stdin", "queued", "term", "hup", "quit", "missing_0", "missing_1", "missing_2", "spawn_error"] as const;
type Mode = typeof modes[number];
type Owner = { child: Bun.Subprocess; terminal: Bun.Terminal | null; joined: boolean; terminalExited: boolean; code: number | null; output: string; overflow: boolean; root: string; verified: boolean };
const owners: Owner[] = [];
let root: string | undefined;
let allPassed = false;
let outerDescriptors: readonly string[] = [];
const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
function leaseSnapshot(): readonly string[] {
  const lease = parseInheritedLease(process.env.OOMPA_LOCAL_EFFICIENCY_LEASE ?? "");
  if (lease.lane !== "mac-native") throw new Error("TTY_NATIVE_REQUIRES_OUTER_MAC_LEASE");
  return [3, 4].map((descriptor) => {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600 || stat.size < 1 || stat.size > 4096) throw new Error("TTY_NATIVE_OUTER_DESCRIPTOR");
    const bytes = Buffer.alloc(stat.size);
    if (readSync(descriptor, bytes, 0, bytes.length, 0) !== bytes.length) throw new Error("TTY_NATIVE_OUTER_DESCRIPTOR_READ");
    const marker: unknown = JSON.parse(bytes.toString("utf8"));
    if (typeof marker !== "object" || marker === null || !("phase" in marker) || marker.phase !== "A") throw new Error("TTY_NATIVE_OUTER_LEASE_NOT_ADMITTED");
    return `${String(stat.dev)}:${String(stat.ino)}:${sha(bytes)}`;
  });
}
const wait = async (condition: () => boolean, maximum = 8000): Promise<void> => {
  const deadline = performance.now() + maximum;
  while (!condition()) {
    if (performance.now() >= deadline) throw new Error("TTY_NATIVE_DEADLINE");
    await Bun.sleep(10);
  }
};
function record(path: string): Record<string, unknown> {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600 || stat.size > 1024) throw new Error("TTY_NATIVE_RECORD_BOUND");
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("TTY_NATIVE_RECORD_SHAPE");
  return value as Record<string, unknown>;
}
function absent(pid: unknown): boolean {
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid < 1) throw new Error("TTY_NATIVE_PID_REFUSED");
  try { process.kill(pid, 0); return false; }
  catch (error: unknown) { if (typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH") return true; throw error; }
}
beforeAll(() => {
  if (!enabled) return;
  if (process.platform !== "darwin" || Bun.version !== "1.3.14") throw new Error("TTY_NATIVE_PLATFORM_REFUSED");
  outerDescriptors = leaseSnapshot();
  const runtime = dirname(resolveSlopcameraHostResourceModule({}));
  for (const artifact of slopcameraArtifacts) {
    const bytes = readFileSync(join(runtime, artifact.name));
    if (bytes.length !== artifact.bytes || sha(bytes) !== artifact.sha256) throw new Error("TTY_NATIVE_RUNTIME_PIN_CHANGED");
  }
  root = realpathSync(mkdtempSync(join(tmpdir(), "oompa-scheduler-tty-native-")));
  chmodSync(root, 0o700);
});

function start(mode: Mode): Owner {
  if (root === undefined) throw new Error("TTY_NATIVE_ROOT_MISSING");
  const directory = join(root, mode); mkdirSync(directory, { mode: 0o700 });
  // No production lease metadata is passed to the inner wrapper. Its real
  // coordinator uses only the existing explicit test stateRoot argument.
  const owner: Owner = { child: undefined as unknown as Bun.Subprocess, terminal: null, joined: false, terminalExited: false, code: null, output: "", overflow: false, root: directory, verified: false };
  const child = Bun.spawn([process.execPath, "--no-env-file", "--config=/dev/null", join(import.meta.dir, "host-run-tty.fixture.ts"), "wrapper", mode], {
    cwd: directory, env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C", TZ: "UTC", OOMPA_HOST_TTY_FIXTURE: "1" },
    terminal: { cols: 100, rows: 24,
      data(_terminal, bytes) {
        if (owner.output.length + bytes.length > 8192) { owner.overflow = true; return; }
        owner.output += Buffer.from(bytes).toString("utf8");
      },
      exit() { owner.terminalExited = true; },
    },
  });
  owner.child = child; owner.terminal = child.terminal ?? null; owners.push(owner);
  void child.exited.then((code) => { owner.code = code; owner.joined = true; }, () => { owner.overflow = true; });
  if (owner.terminal === null) throw new Error("TTY_NATIVE_TERMINAL_MISSING");
  return owner;
}
function ctrlC(owner: Owner): void {
  if (owner.terminal?.write("\u0003") !== 1) throw new Error("TTY_NATIVE_SIGNAL_WRITE");
}

test.skipIf(!enabled)("actual TTY Ctrl-C ownership, admission cancellation and telemetry retain their distinct scopes", async () => {
  for (const mode of modes) {
    expect(leaseSnapshot()).toEqual(outerDescriptors);
    const owner = start(mode);
    const marker = (name: string): string => join(owner.root, name);
    const noTarget = mode.startsWith("missing_") || mode === "queued" || mode === "spawn_error";
    if (mode === "queued") {
      await wait(() => existsSync(marker("blocker-held")) && existsSync(marker("wrapper-ready")) && owner.output.includes("waiting for"));
      ctrlC(owner);
    } else if (mode === "spawn_error") {
      await wait(() => existsSync(marker("wrapper-returned")));
      ctrlC(owner);
    } else if (!mode.startsWith("missing_")) {
      await wait(() => existsSync(marker("target-started.json")) && existsSync(marker("wrapper-ready")));
      if (mode === "term" || mode === "hup" || mode === "quit") owner.child.kill(mode === "term" ? "SIGTERM" : mode === "hup" ? "SIGHUP" : "SIGQUIT");
      else if (mode === "after_join") {
        writeFileSync(marker("finish-target"), "", { flag: "wx", mode: 0o600 });
        await wait(() => existsSync(marker("wrapper-returned")));
        ctrlC(owner);
      } else {
        ctrlC(owner);
        await wait(() => existsSync(marker("wrapper-interrupt-1")) && existsSync(marker("interrupt-1")));
        if (mode === "between") ctrlC(owner);
        else if (mode !== "parent") writeFileSync(marker("finish-target"), "", { flag: "wx", mode: 0o600 });
      }
    }
    await wait(() => owner.joined && owner.terminalExited);
    owner.terminal?.close();
    expect(owner.terminal?.closed).toBeTrue(); expect(owner.code).toBe(0); expect(owner.overflow).toBeFalse();
    const result = record(marker("wrapper-result.json"));
    const expectedCode = mode.startsWith("missing_") || mode === "spawn_error" ? null
      : mode === "parent" || mode === "between" || mode === "queued" ? 130
      : mode === "term" ? 143 : mode === "hup" ? 129 : mode === "quit" ? 131 : 0;
    expect(result).toEqual({ source: "credential_free_fixture", pid: owner.child.pid, code: expectedCode,
      error: mode.startsWith("missing_") ? "tty_required" : mode === "spawn_error" ? "spawn_error" : null,
      wrapperInterrupts: mode === "between" ? 2 : ["child", "parent", "after_join", "cached_stdin", "queued", "spawn_error"].includes(mode) ? 1 : 0,
      listenersRestored: true, blockerJoined: true });
    expect(absent(owner.child.pid)).toBeTrue();
    if (noTarget) expect(existsSync(marker("target-started.json"))).toBeFalse();
    else {
      const target = record(marker("target-started.json"));
      const targetResult = record(marker("target-result.json"));
      expect(targetResult.pid).toBe(target.pid); expect(targetResult.code).toBe(expectedCode);
      expect(targetResult.interrupts).toBe(mode === "parent" || mode === "between" ? 2 : mode === "child" || mode === "cached_stdin" ? 1 : 0);
      expect(absent(target.pid)).toBeTrue();
    }
    const events = readThroughputEvents(throughputTelemetryRoot(marker("ledger")), { days: 1, limit: 2 });
    if (mode.startsWith("missing_")) { expect(events).toHaveLength(0); expect(existsSync(marker("ledger"))).toBeFalse(); }
    else {
      expect(events).toHaveLength(1);
      const event = events[0];
      expect(event?.outcome).toBe(["parent", "queued", "term", "hup", "quit"].includes(mode) ? "canceled" : mode === "spawn_error" ? "spawn-error" : mode === "between" ? "fail" : "pass");
      expect(event?.exitCode).toBe(expectedCode);
      expect(event?.admittedAt === null).toBe(mode === "queued");
    }
    owner.verified = true; owner.output = "";
    expect(leaseSnapshot()).toEqual(outerDescriptors);
  }
  allPassed = true;
}, 130000);

afterAll(async () => {
  if (!enabled || root === undefined) return;
  let uncertain = false;
  for (const owner of owners) {
    if (!owner.joined) {
      try { owner.child.kill("SIGTERM"); await wait(() => owner.joined, 1500); }
      catch { uncertain = true; try { owner.child.kill("SIGKILL"); await wait(() => owner.joined, 1500); } catch { uncertain = true; } }
    }
    try { owner.terminal?.close(); } catch { uncertain = true; }
    // Absence probes never authorize PID-only signals. Missing collection or a
    // missing target identity remains uncertain even after wrapper death.
    if (!owner.verified || !owner.joined || !owner.terminalExited || owner.terminal?.closed !== true) uncertain = true;
  }
  if (allPassed && !uncertain && owners.length === modes.length) {
    try {
      expect(leaseSnapshot()).toEqual(outerDescriptors);
      rmSync(root, { recursive: true });
      if (existsSync(root)) throw new Error("TTY_NATIVE_ROOT_REMAINS");
      console.info(JSON.stringify({ evidence: "credential_free_scheduler_tty", cases: modes.length, wrappersJoined: owners.length, terminalsClosed: owners.length, targetsJoined: 8,
        pinnedCoordinator: true, isolatedLedger: true, outerDescriptorsUnchanged: true, privateRootRemoved: true, actualAuthentication: false, ownerAccessibilityProven: false }));
      return;
    } catch { uncertain = true; }
  }
  console.info(JSON.stringify({ evidence: "credential_free_scheduler_tty", privateRootRemoved: false, recoveryRoot: root, cleanupUncertain: uncertain, actualAuthentication: false }));
  throw new Error("TTY_NATIVE_RECOVERY_REQUIRED");
});
