/** Explicit local qualification against the installed immutable runtime. */
import { beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseInheritedLease, resolveCapabilityStateRoot, resolveSlopcameraHostResourceModule } from "./host-run";
import { pruneStaleQueueEndpoints, queueRegistryRoot, readQueueSnapshot, requestQueueHandoff, type QueueOwner } from "./queue-observer";
import { slopcameraArtifacts } from "./runtime-pin";

const enabled = process.env.OOMPA_HOST_QUEUE_NATIVE === "1";
let runtime = "";
let outerIdentity = "";
function outerLease(): string {
  const lease = parseInheritedLease(process.env.OOMPA_LOCAL_EFFICIENCY_LEASE ?? "");
  const descriptor = lease.lane === "compute" ? 3 : 4;
  const metadata = fstatSync(descriptor);
  if (!metadata.isFile() || metadata.size > 4096) throw new Error("native queue test requires scheduler custody");
  const bytes = Buffer.alloc(metadata.size);
  if (readSync(descriptor, bytes, 0, bytes.length, 0) !== bytes.length) throw new Error("short outer lease read");
  return `${metadata.dev}:${metadata.ino}:${bytes.toString("hex")}`;
}
beforeAll(() => {
  if (!enabled) return;
  if ((process.platform !== "darwin" && process.platform !== "linux") || Bun.version !== "1.3.14") throw new Error("native queue platform refused");
  outerIdentity = outerLease();
  runtime = resolveSlopcameraHostResourceModule({});
  for (const artifact of slopcameraArtifacts) {
    const bytes = readFileSync(join(dirname(runtime), artifact.name));
    if (bytes.length !== artifact.bytes || createHash("sha256").update(bytes).digest("hex") !== artifact.sha256) throw new Error("native queue runtime pin changed");
  }
});
async function until(check: () => boolean | Promise<boolean>, timeout = 6_000): Promise<void> {
  const deadline = performance.now() + timeout;
  while (!await check()) {
    if (performance.now() >= deadline) throw new Error("native queue observation deadline");
    await Bun.sleep(10);
  }
}
function record(path: string): Record<string, unknown> {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > 4096) throw new Error("native queue fixture record bound");
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("native queue fixture record invalid");
  return value as Record<string, unknown>;
}
function waitingClaims(stateRoot: string): number {
  const root = resolveCapabilityStateRoot(stateRoot);
  return readdirSync(root).filter(name => /^lease-[0-9]{20}-[0-9a-f]{32}\.lock$/u.test(name))
    .filter(name => record(join(root, name)).phase === "W").length;
}
function fixture() {
  const root = mkdtempSync("/tmp/oq-native-");
  chmodSync(root, 0o700);
  const stateRoot = join(root, "host-resources-v1");
  const children: { label: string; process: ReturnType<typeof Bun.spawn>; output: Promise<string>; joined: boolean }[] = [];
  const finish = (label: string) => { writeFileSync(join(root, `${label}-finish`), "", { mode: 0o600 }); };
  const ready = (label: string) => existsSync(join(root, `${label}-ready`));
  const start = (label: string, exitCode = 0) => {
    const child = Bun.spawn([process.execPath, "--no-env-file", "--config=/dev/null", join(import.meta.dir, "host-run.ts"),
      "--mode=shared", "--lane=browser-auth", `--label=${label}`, "--task-id=00000000-0000-4000-8000-000000000001", "--",
      process.execPath, "--no-env-file", "--config=/dev/null", join(import.meta.dir, "host-queue.fixture.ts"), root, label, String(exitCode)], {
      cwd: root, stdin: "ignore", stdout: "ignore", stderr: "pipe",
      env: { PATH: "/usr/bin:/bin", LANG: "C", OOMPA_QUEUE_FIXTURE: "1", OOMPA_LOCAL_EFFICIENCY_STATE_ROOT: stateRoot,
        OOMPA_SLOPCAMERA_HOST_RESOURCES_MODULE: runtime, OOMPA_LOCAL_EFFICIENCY_TELEMETRY: "off" },
    });
    const output = (async () => {
      let bytes = 0;
      let result = "";
      const reader = child.stderr.getReader();
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.length;
          if (bytes > 16_384) throw new Error("native queue output bound");
          result += Buffer.from(chunk.value).toString("utf8");
        }
      } finally { reader.releaseLock(); }
      return result;
    })();
    const owned = { label, process: child, output, joined: false };
    children.push(owned);
    void child.exited.then(() => { owned.joined = true; });
    return child;
  };
  const owner = async (label: string): Promise<QueueOwner> => {
    let result: QueueOwner | undefined;
    await until(async () => {
      result = (await readQueueSnapshot(stateRoot)).owners.find(owner => owner.label === label);
      return result !== undefined;
    });
    if (result === undefined) throw new Error("missing observed owner");
    return result;
  };
  const cleanup = async () => {
    // Every fixture command has a finite self-exit guard. File control remains
    // valid after wrapper death, without PID-only signaling of descendants.
    for (const child of children) finish(child.label);
    for (const child of children) if (!child.joined) child.process.kill("SIGTERM");
    await until(() => children.every(child => child.joined), 8_000);
    for (const child of children) {
      await child.process.exited;
      await child.output;
      if (ready(child.label)) {
        const pid = Number(readFileSync(join(root, `${child.label}-ready`), "utf8"));
        if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("invalid fixture process identity");
        await until(() => {
          try { process.kill(pid, 0); return false; }
          catch (error: unknown) {
            if (typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH") return true;
            throw error;
          }
        }, 28_000);
      }
    }
    expect(outerLease()).toBe(outerIdentity);
    rmSync(queueRegistryRoot(stateRoot), { force: true, recursive: true });
    rmSync(root, { recursive: true });
  };
  return { root, stateRoot, start, finish, ready, owner, cleanup, children };
}

describe.skipIf(!enabled)("real scheduler queue observation", () => {
  test("handoff is an idempotent notice and canceled waiters preserve real FIFO", async () => {
    const f = fixture();
    try {
      const holder = f.start("holder");
      await until(() => f.ready("holder"));
      const holderOwner = await f.owner("holder");
      expect(holderOwner).toMatchObject({ stage: "running", capability: "reported-held", taskId: "00000000-0000-4000-8000-000000000001" });
      const first = f.start("first");
      await until(() => waitingClaims(f.stateRoot) === 1);
      const canceled = f.start("canceled");
      await until(() => waitingClaims(f.stateRoot) === 2);
      const last = f.start("last");
      await until(() => waitingClaims(f.stateRoot) === 3);
      const request = { version: 1, operation: "request-handoff", runId: holderOwner.runId, requestId: "preview-1", requesterLabel: "music-preview" } as const;
      expect((await requestQueueHandoff(f.stateRoot, request)).result).toBe("recorded");
      expect((await requestQueueHandoff(f.stateRoot, request)).result).toBe("already-recorded");
      expect((await requestQueueHandoff(f.stateRoot, { ...request, requesterLabel: "changed" })).result).toBe("conflict");
      expect((await requestQueueHandoff(f.stateRoot, { ...request, runId: (await f.owner("first")).runId })).result).toBe("not-holder");
      expect(waitingClaims(f.stateRoot)).toBe(3);
      expect(f.ready("first")).toBeFalse();
      canceled.kill("SIGTERM");
      expect(await canceled.exited).toBe(143);
      await until(() => waitingClaims(f.stateRoot) === 2);
      expect((await readQueueSnapshot(f.stateRoot)).owners.some(owner => owner.label === "canceled")).toBeFalse();
      f.finish("holder");
      expect(await holder.exited).toBe(0);
      await until(() => f.ready("first"));
      expect(f.ready("last")).toBeFalse();
      f.finish("first");
      expect(await first.exited).toBe(0);
      await until(() => f.ready("last"));
      f.finish("last");
      expect(await last.exited).toBe(0);
      expect(readFileSync(join(f.root, "order"), "utf8")).toBe("holder\nfirst\nlast\n");
      const output = await f.children[0]!.output;
      expect(output.split("handoff requested by")).toHaveLength(2);
      expect(output).not.toContain(f.root);
      expect((await readQueueSnapshot(f.stateRoot)).owners).toHaveLength(0);
      await expect(requestQueueHandoff(f.stateRoot, request)).rejects.toThrow();
    } finally { await f.cleanup(); }
  }, 25_000);

  test("a dead wrapper is unknown while its descendant's inherited kernel lease excludes the waiter", async () => {
    const f = fixture();
    try {
      const holder = f.start("holder");
      await until(() => f.ready("holder"));
      const holderOwner = await f.owner("holder");
      const waiter = f.start("waiter");
      await until(() => waitingClaims(f.stateRoot) === 1);
      holder.kill("SIGKILL");
      await holder.exited;
      const snapshot = await readQueueSnapshot(f.stateRoot);
      expect(snapshot).toMatchObject({ availability: "unknown", custody: "unknown", unresponsiveOwners: 1 });
      expect(snapshot.owners.some(owner => owner.runId === holderOwner.runId)).toBeFalse();
      await expect(requestQueueHandoff(f.stateRoot, { version: 1, operation: "request-handoff", runId: holderOwner.runId,
        requestId: "stale-owner", requesterLabel: "waiter" })).rejects.toThrow();
      const staleAt = new Date(Date.now() - 120_000);
      utimesSync(join(queueRegistryRoot(f.stateRoot), `${holderOwner.runId}-${holder.pid}.sock`), staleAt, staleAt);
      expect(await pruneStaleQueueEndpoints(f.stateRoot)).toBe(1);
      expect(await readQueueSnapshot(f.stateRoot)).toMatchObject({ availability: "unknown", custody: "unknown", unresponsiveOwners: 0 });
      // Multiple scheduler retries have run after wrapper death. Its child still
      // holds the real descriptor; removing its dead observer grants no entry.
      await Bun.sleep(600);
      expect(f.ready("waiter")).toBeFalse();
      expect(waitingClaims(f.stateRoot)).toBe(1);
      f.finish("holder");
      await until(() => f.ready("waiter"));
      f.finish("waiter");
      expect(await waiter.exited).toBe(0);
      expect(readFileSync(join(f.root, "order"), "utf8")).toBe("holder\nwaiter\n");
    } finally { await f.cleanup(); }
  }, 35_000);

  test("unsafe observation storage cannot change real admission or the child exit code", async () => {
    const f = fixture();
    try {
      mkdirSync(queueRegistryRoot(f.stateRoot), { mode: 0o755 });
      chmodSync(queueRegistryRoot(f.stateRoot), 0o755);
      const child = f.start("exit-seven", 7);
      await until(() => f.ready("exit-seven"));
      expect(await readQueueSnapshot(f.stateRoot)).toMatchObject({ registry: "unavailable", availability: "unknown", owners: [] });
      f.finish("exit-seven");
      expect(await child.exited).toBe(7);
      expect(await f.children[0]!.output).toContain("queue visibility unavailable");
    } finally { await f.cleanup(); }
  }, 15_000);
});
