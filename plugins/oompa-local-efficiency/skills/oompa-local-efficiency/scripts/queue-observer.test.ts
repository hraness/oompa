import { afterEach, describe, expect, test } from "bun:test";
import fc from "fast-check";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import {
  createHandoffRecorder,
  isUnreachableQueueEndpoint,
  parseQueueOwner,
  parseQueueRequest,
  pruneStaleQueueEndpoints,
  queueLimits,
  queueRegistryRoot,
  readQueueSnapshot,
  requestQueueHandoff,
  requireQueueRunId,
  requireQueueTaskId,
  startQueueObserver,
  type HandoffRequest,
  type QueueOwner,
} from "./queue-observer";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const runId = "0123456789abcdef0123456789abcdef";
const taskId = "01234567-89ab-cdef-0123-456789abcdef";
const propertyOptions = { numRuns: 128, seed: 199 };
const runIds = fc.uint8Array({ minLength: 16, maxLength: 16 }).map(value => Buffer.from(value).toString("hex"));
const labels = fc.array(fc.integer({ min: 97, max: 122 }), { minLength: 1, maxLength: 64 }).map(value => String.fromCharCode(...value));

function fixture(): { stateRoot: string; registryRoot: string } {
  const root = mkdtempSync(join(tmpdir(), "oompa-queue-contract-"));
  const stateRoot = join(root, "private-state", "host-resources-v1");
  const registryRoot = queueRegistryRoot(stateRoot);
  cleanups.push(() => { rmSync(registryRoot, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); });
  return { stateRoot, registryRoot };
}

function handoff(ownerRunId = runId, requestId = "browser-followup", requesterLabel = "waiting-render"): HandoffRequest {
  return { version: 1, operation: "request-handoff", runId: ownerRunId, requestId, requesterLabel };
}

function owner(): QueueOwner {
  return { runId, label: "render-owner", taskId: null, lane: "browser-auth", mode: "shared", stage: "running",
    capability: "reported-held", elapsedMilliseconds: 80, queueMilliseconds: 30, capabilityMilliseconds: 50, handoffRequests: 0 };
}

function privateEndpoint(registryRoot: string, ownerRunId: string, ownerPid = process.pid): string {
  return join(registryRoot, `${ownerRunId}-${ownerPid}.sock`);
}

async function fakeOwner(registryRoot: string, respond: (socket: Socket) => void, ownerRunId = runId): Promise<string> {
  mkdirSync(registryRoot, { mode: 0o700, recursive: true });
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
    respond(socket);
  });
  const path = privateEndpoint(registryRoot, ownerRunId);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
  chmodSync(path, 0o600);
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => { server.close(() => resolve()); });
  });
  return path;
}

async function socketHolder(registryRoot: string, ownerRunIds: readonly string[]): Promise<{
  paths: string[];
  pause(): void;
  stop(): Promise<void>;
}> {
  mkdirSync(registryRoot, { mode: 0o700, recursive: true });
  // A bounded fixture opens every socket before its readiness acknowledgement.
  // Terminating and joining that exact child leaves genuine abandoned sockets.
  const source = 'import { createServer } from "node:net"; import { join } from "node:path"; const ids = JSON.parse(process.env.OOMPA_QUEUE_FIXTURE_IDS); const paths = ids.map(id => join(process.env.OOMPA_QUEUE_FIXTURE_ROOT, id + "-" + process.pid + ".sock")); await Promise.all(paths.map(path => new Promise(resolve => createServer().listen(path, 1, resolve)))); process.stdout.write("ready\\n");';
  const child = Bun.spawn([process.execPath, "-e", source], {
    env: { OOMPA_QUEUE_FIXTURE_ROOT: registryRoot, OOMPA_QUEUE_FIXTURE_IDS: JSON.stringify(ownerRunIds) }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  let joined: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    joined ??= (async () => {
      child.kill("SIGKILL");
      await child.exited;
      await new Response(child.stderr).text();
    })();
    return joined;
  };
  cleanups.push(stop);
  const reader = child.stdout.getReader();
  const deadline = setTimeout(() => child.kill("SIGKILL"), 2_000);
  try {
    const readiness = await reader.read();
    if (readiness.done || new TextDecoder().decode(readiness.value) !== "ready\n") throw new Error("stale socket fixture did not listen");
  } finally {
    clearTimeout(deadline);
    reader.releaseLock();
  }
  return { paths: ownerRunIds.map(id => privateEndpoint(registryRoot, id, child.pid)), pause() { child.kill("SIGSTOP"); }, stop };
}

async function staleEndpoints(registryRoot: string, ownerRunIds: readonly string[], age = queueLimits.staleMilliseconds * 2): Promise<string[]> {
  const holder = await socketHolder(registryRoot, ownerRunIds);
  await holder.stop();
  const timestamp = new Date(Date.now() - age);
  for (const path of holder.paths) { chmodSync(path, 0o600); utimesSync(path, timestamp, timestamp); }
  return holder.paths;
}

async function staleEndpoint(registryRoot: string, ownerRunId: string, age = queueLimits.staleMilliseconds * 2): Promise<string> {
  return (await staleEndpoints(registryRoot, [ownerRunId], age))[0]!;
}

async function rawExchange(path: string, send: (socket: Socket, onClose: (cleanup: () => void) => void) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    const chunks: Buffer[] = [];
    let stop: (() => void) | undefined;
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("fixture peer did not close within its absolute deadline")); }, queueLimits.timeoutMilliseconds * 3);
    socket.on("error", () => {});
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.once("end", () => socket.destroy());
    socket.once("connect", () => { send(socket, cleanup => { stop = cleanup; }); });
    socket.once("close", () => { clearTimeout(timer); if (typeof stop === "function") stop(); resolve(Buffer.concat(chunks).toString("utf8")); });
  });
}

async function probeAbandonedSocket(path: string): Promise<{
  code: string | null;
  errno: number | null;
  connected: boolean;
  expired: boolean;
  events: Array<"connect" | "error" | "deadline" | "close">;
}> {
  const result: Awaited<ReturnType<typeof probeAbandonedSocket>> = { code: null, errno: null, connected: false, expired: false, events: [] };
  await new Promise<void>(resolve => {
    const socket = createConnection(path);
    const deadline = setTimeout(() => { result.expired = true; result.events.push("deadline"); socket.destroy(); }, queueLimits.timeoutMilliseconds);
    socket.once("connect", () => { result.connected = true; result.events.push("connect"); socket.destroy(); });
    socket.once("error", (error: unknown) => {
      result.events.push("error");
      if (typeof error === "object" && error !== null) {
        if ("code" in error && typeof error.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/u.test(error.code)) result.code = error.code;
        if ("errno" in error && typeof error.errno === "number" && Number.isInteger(error.errno) && Math.abs(error.errno) <= 4_096) result.errno = error.errno;
      }
      socket.destroy();
    });
    socket.once("close", () => { clearTimeout(deadline); result.events.push("close"); resolve(); });
  });
  return result;
}

describe("queue observation protocol", () => {
  test("round trips closed requests and rejects added or missing fields", () => {
    fc.assert(fc.property(runIds, labels, labels, (id, requestId, requesterLabel) => {
      const requests = [{ version: 1, operation: "status", runId: id } as const, handoff(id, requestId, requesterLabel)];
      for (const request of requests) {
        expect(parseQueueRequest(JSON.parse(JSON.stringify(request)) as unknown)).toEqual(request);
        expect(() => parseQueueRequest({ ...request, argv: ["private-command"] })).toThrow();
        for (const key of Object.keys(request)) {
          const missing: Record<string, unknown> = Object.fromEntries(Object.entries(request).filter(([field]) => field !== key));
          expect(() => parseQueueRequest(missing)).toThrow();
        }
      }
    }), propertyOptions);
  });

  test("accepts only bounded run and explicit task identifiers", () => {
    fc.assert(fc.property(runIds, id => {
      expect(requireQueueRunId(id)).toBe(id);
      expect(() => requireQueueRunId(`${id}/extra`)).toThrow();
      const uuid = `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
      expect(requireQueueTaskId(uuid)).toBe(uuid);
    }), propertyOptions);
    for (const invalid of [null, undefined, 1, {}, [], "", "../owner", "A".repeat(32), "a".repeat(33), `${runId}\n`]) {
      expect(() => requireQueueRunId(invalid)).toThrow();
    }
    for (const invalid of [null, 1, "", runId, "task-title", taskId.toUpperCase(), `${taskId}\n`]) {
      expect(() => requireQueueTaskId(invalid)).toThrow();
    }
  });

  test("refuses invalid versions, foreign operations and unsafe identifier labels", () => {
    for (const value of [null, [], "status", 1, {}, { version: 2, operation: "status", runId },
      { ...handoff(), operation: "release" }, { ...handoff(), version: "1" }]) {
      expect(() => parseQueueRequest(value)).toThrow();
    }
    for (const value of ["", "a".repeat(65), "/private/path", "--flag", "with spaces", "line\nnext", "secret=value", "🙂", 10, null]) {
      expect(() => parseQueueRequest({ ...handoff(), requestId: value })).toThrow();
      expect(() => parseQueueRequest({ ...handoff(), requesterLabel: value })).toThrow();
    }
  });

  test("inherited required fields cannot conceal extra own fields in closed records", () => {
    const records = [
      { value: { version: 1, operation: "status", runId }, parse: parseQueueRequest },
      { value: handoff(), parse: parseQueueRequest },
      { value: owner(), parse: parseQueueOwner },
    ];
    for (const { value, parse } of records) {
      for (const [inheritedKey, inheritedValue] of Object.entries(value)) {
        const ownFields = Object.fromEntries(Object.entries(value).filter(([key]) => key !== inheritedKey));
        const forged: unknown = Object.setPrototypeOf({ ...ownFields, argv: ["private-command"] }, { [inheritedKey]: inheritedValue });
        expect(() => parse(forged)).toThrow();
      }
    }
  });

  test("valid owner observations round trip without accepting authority or private fields", () => {
    fc.assert(fc.property(runIds, labels, fc.nat({ max: 100_000 }), fc.nat({ max: 100_000 }), (id, label, queued, held) => {
      const value = { ...owner(), runId: id, label, taskId, queueMilliseconds: queued, elapsedMilliseconds: queued + held,
        capabilityMilliseconds: held };
      expect(parseQueueOwner(JSON.parse(JSON.stringify(value)) as unknown)).toEqual(value);
      for (const field of ["argv", "cwd", "environment", "pid", "ticket", "available", "leaseDescriptor"]) {
        expect(() => parseQueueOwner({ ...value, [field]: "private" })).toThrow();
      }
      for (const field of Object.keys(value)) {
        const missing: Record<string, unknown> = Object.fromEntries(Object.entries(value).filter(([key]) => key !== field));
        expect(() => parseQueueOwner(missing)).toThrow();
      }
    }), propertyOptions);
  });

  test("rejects impossible capability states and unbounded or inconsistent counts", () => {
    for (const patch of [
      { lane: "cloud" }, { mode: "wide" }, { stage: "released" }, { taskId: "implicit-task" },
      { capability: "available" }, { stage: "waiting-capability", capability: "reported-held" },
      { stage: "waiting-compute", capability: "waiting" }, { lane: "compute", capability: "reported-held" },
      { lane: "compute", stage: "waiting-capability", capability: "none", capabilityMilliseconds: null },
      { capabilityMilliseconds: null }, { capabilityMilliseconds: 81 }, { queueMilliseconds: 81 },
      { handoffRequests: queueLimits.notices + 1 }, { label: "/private/owner" },
    ]) expect(() => parseQueueOwner({ ...owner(), ...patch })).toThrow();
    for (const key of ["elapsedMilliseconds", "queueMilliseconds", "capabilityMilliseconds", "handoffRequests"]) {
      for (const value of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, "10"]) {
        expect(() => parseQueueOwner({ ...owner(), [key]: value })).toThrow();
      }
    }
    expect(parseQueueOwner({ ...owner(), stage: "waiting-compute" }).capability).toBe("reported-held");
    expect(parseQueueOwner({ ...owner(), lane: "compute", capability: "none", capabilityMilliseconds: null }).capability).toBe("none");
  });

  test("handoff intent is bounded, idempotent and reconciles after settling", () => {
    fc.assert(fc.property(labels, labels, (requestId, requesterLabel) => {
      const record = createHandoffRecorder();
      const request = handoff(runId, requestId, requesterLabel);
      expect(record(request, false).result).toBe("not-holder");
      expect(record(request, true).result).toBe("recorded");
      expect(record(request, true).result).toBe("already-recorded");
      expect(record(request, false).result).toBe("already-recorded");
      expect(record({ ...request, requesterLabel: requesterLabel === "other" ? "another" : "other" }, false).result).toBe("conflict");
      expect(record(handoff(runId, "new-id", "another-owner"), false).result).toBe(requestId === "new-id" ? "conflict" : "not-holder");
    }), propertyOptions);
    const record = createHandoffRecorder();
    for (let index = 0; index < queueLimits.notices; index += 1) expect(record(handoff(runId, `request-${index}`), true).result).toBe("recorded");
    expect(record(handoff(runId, "overflow"), true).result).toBe("limit-reached");
    expect(record(handoff(runId, "request-0"), false).result).toBe("already-recorded");
    expect(record(handoff(runId, "request-0", "different-label"), true).result).toBe("conflict");
  });

  test("unreachable classification limits Bun's ENOENT mapping to the qualified platform and version", () => {
    for (const platform of ["darwin", "linux"] as const) {
      expect(isUnreachableQueueEndpoint({ code: "ENOENT", errno: -2, syscall: "connect" }, platform, "1.3.14")).toBe(true);
    }
    for (const platform of ["win32", "freebsd"] as const) {
      expect(isUnreachableQueueEndpoint({ code: "ENOENT" }, platform, "1.3.14")).toBe(false);
    }
    fc.assert(fc.property(fc.string({ maxLength: 64 }).filter(value => value !== "1.3.14"), version => {
      for (const platform of ["darwin", "linux"] as const) {
        expect(isUnreachableQueueEndpoint({ code: "ENOENT" }, platform, version)).toBe(false);
      }
      for (const platform of ["darwin", "linux", "win32"] as const) {
        expect(isUnreachableQueueEndpoint({ code: "ECONNREFUSED" }, platform, version)).toBe(true);
      }
    }), propertyOptions);
    fc.assert(fc.property(fc.string({ maxLength: 64 }).filter(value => value !== "ENOENT" && value !== "ECONNREFUSED"), code => {
      for (const platform of ["darwin", "linux"] as const) {
        expect(isUnreachableQueueEndpoint({ code }, platform, "1.3.14")).toBe(false);
      }
    }), propertyOptions);
    for (const error of [null, undefined, false, 61, "ECONNREFUSED", [], {}, { errno: 61 }, { code: null },
      { code: "EACCES", errno: 61 }, { code: "ETIMEDOUT" }, { code: "ECONNRESET" }, { code: "ERR_SOCKET_CLOSED" }]) {
      for (const platform of ["darwin", "linux"] as const) {
        expect(isUnreachableQueueEndpoint(error, platform, "1.3.14")).toBe(false);
      }
    }
  });
});

describe("private queue observation sockets", () => {
  test("pinned Bun reports its qualified error for a real abandoned Unix socket", async () => {
    const { stateRoot, registryRoot } = fixture();
    const path = await staleEndpoint(registryRoot, runId);
    const before = lstatSync(path);
    const probe = await probeAbandonedSocket(path);
    const after = lstatSync(path);
    const diagnostic = JSON.stringify({ platform: process.platform, bunVersion: Bun.version, probe,
      socket: after.isSocket(), privateMode: (after.mode & 0o777) === 0o600,
      sameIdentity: before.dev === after.dev && before.ino === after.ino && before.mtimeMs === after.mtimeMs,
      oldEnough: Date.now() - after.mtimeMs >= queueLimits.staleMilliseconds });
    expect(["darwin", "linux"], diagnostic).toContain(process.platform);
    expect(Bun.version, diagnostic).toBe("1.3.14");
    expect(probe, diagnostic).toEqual({ code: "ENOENT", errno: -2, connected: false, expired: false, events: ["error", "close"] });
    expect(before.dev === after.dev && before.ino === after.ino && before.mtimeMs === after.mtimeMs, diagnostic).toBe(true);
    expect(isUnreachableQueueEndpoint({ code: probe.code }), diagnostic).toBe(true);
    expect(existsSync(stateRoot)).toBe(false);
  });

  test("an absent read-only snapshot creates neither registry nor scheduler state", async () => {
    const { stateRoot, registryRoot } = fixture();
    expect(await readQueueSnapshot(stateRoot)).toEqual({ version: 1, coverage: "cooperating-wrappers-only", availability: "unknown", custody: "unknown",
      registry: "absent", unresponsiveOwners: 0, owners: [] });
    expect(existsSync(stateRoot)).toBe(false);
    expect(existsSync(registryRoot)).toBe(false);
  });

  test("reports capability held while awaiting compute and delivers each notice once", async () => {
    const { stateRoot } = fixture();
    const notices: HandoffRequest[] = [];
    const input = { stateRoot, label: "island-render", taskId, lane: "browser-auth" as const, mode: "shared" as const,
      onHandoff: (request: HandoffRequest) => { notices.push(request); throw new Error("notice consumer failed"); },
      argv: ["sensitive-script", "/private/project"], environment: { SECRET: "sensitive-value" } };
    const observer = await startQueueObserver(input);
    cleanups.push(() => observer.close());
    const waiting = (await readQueueSnapshot(stateRoot)).owners[0];
    expect(waiting).toMatchObject({ runId: observer.runId, stage: "waiting-capability", capability: "waiting", capabilityMilliseconds: null, taskId });
    expect((await requestQueueHandoff(stateRoot, handoff(observer.runId))).result).toBe("not-holder");
    observer.capabilityAdmitted();
    const waitingCompute = (await readQueueSnapshot(stateRoot)).owners[0];
    expect(waitingCompute).toMatchObject({ stage: "waiting-compute", capability: "reported-held" });
    expect((await requestQueueHandoff(stateRoot, handoff(observer.runId))).result).toBe("recorded");
    expect((await requestQueueHandoff(stateRoot, handoff(observer.runId))).result).toBe("already-recorded");
    expect((await requestQueueHandoff(stateRoot, handoff(observer.runId, "browser-followup", "changed-requester"))).result).toBe("conflict");
    observer.cpuAdmitted();
    observer.settling();
    expect((await requestQueueHandoff(stateRoot, handoff(observer.runId, "fresh-request"))).result).toBe("not-holder");
    expect((await requestQueueHandoff(stateRoot, handoff(observer.runId))).result).toBe("already-recorded");
    expect(notices).toEqual([handoff(observer.runId)]);
    const snapshot = await readQueueSnapshot(stateRoot);
    expect(snapshot).toMatchObject({ availability: "unknown", coverage: "cooperating-wrappers-only", unresponsiveOwners: 0 });
    expect(snapshot.owners[0]).toMatchObject({ stage: "settling", capability: "reported-held", handoffRequests: 1 });
    const serialized = JSON.stringify(snapshot);
    for (const forbidden of [stateRoot, "argv", "environment", "SECRET", "sensitive-script", "/private/project", "sensitive-value", "ticket", "leaseDescriptor"]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(existsSync(stateRoot)).toBe(false);
  });

  test("compute ownership and cancelled capability waits cannot request a handoff", async () => {
    const { stateRoot } = fixture();
    const observed = await Promise.all((["compute", "browser-auth"] as const).map(async lane => {
      const observer = await startQueueObserver({ stateRoot, label: `${lane}-owner`, lane, mode: "shared", onHandoff: () => { throw new Error("must not notify"); } });
      cleanups.push(() => observer.close());
      return observer;
    }));
    const compute = observed[0]!;
    const cancelled = observed[1]!;
    compute.cpuAdmitted();
    cancelled.settling();
    expect((await requestQueueHandoff(stateRoot, handoff(compute.runId))).result).toBe("not-holder");
    expect((await requestQueueHandoff(stateRoot, handoff(cancelled.runId))).result).toBe("not-holder");
    const snapshot = await readQueueSnapshot(stateRoot);
    expect(snapshot.unresponsiveOwners).toBe(0);
    expect(snapshot.owners.find(value => value.runId === compute.runId)).toMatchObject({ capability: "none", taskId: null });
    expect(snapshot.owners.find(value => value.runId === cancelled.runId)).toMatchObject({ stage: "settling", capability: "waiting", capabilityMilliseconds: null });
  });

  test("filters live observations and orders only by opaque run ID", async () => {
    const { stateRoot } = fixture();
    for (const lane of ["browser-auth", "compute", "mac-native"] as const) {
      const observer = await startQueueObserver({ stateRoot, label: lane, lane, mode: "heavy", onHandoff: () => {} });
      cleanups.push(() => observer.close());
    }
    const snapshot = await readQueueSnapshot(stateRoot);
    expect(snapshot.owners).toHaveLength(3);
    expect(snapshot.owners.map(value => value.runId)).toEqual(snapshot.owners.map(value => value.runId).sort());
    expect((await readQueueSnapshot(stateRoot, "browser-auth")).owners.map(value => value.lane)).toEqual(["browser-auth"]);
    expect(JSON.stringify(snapshot)).not.toContain("position");
  });

  test("unsafe registry roots remain unavailable and unmodified", async () => {
    for (const unsafe of ["permission", "symlink", "regular-file", "foreign-entry", "too-many-owners"] as const) {
      const { stateRoot, registryRoot } = fixture();
      if (unsafe === "regular-file") writeFileSync(registryRoot, "private-placeholder", { mode: 0o600 });
      else if (unsafe === "symlink") {
        const target = `${registryRoot}-target`; mkdirSync(target, { mode: 0o700 }); symlinkSync(target, registryRoot);
        cleanups.push(() => rmSync(target, { recursive: true, force: true }));
      } else {
        mkdirSync(registryRoot, { mode: 0o700 });
        if (unsafe === "permission") chmodSync(registryRoot, 0o755);
        if (unsafe === "foreign-entry") writeFileSync(join(registryRoot, "private-command.txt"), "do not read or delete");
        if (unsafe === "too-many-owners") for (let index = 0; index <= queueLimits.owners; index += 1) writeFileSync(privateEndpoint(registryRoot, index.toString(16).padStart(32, "0")), "");
      }
      expect(await readQueueSnapshot(stateRoot)).toMatchObject({ registry: "unavailable", availability: "unknown", owners: [] });
      expect(existsSync(registryRoot)).toBe(true);
      expect(existsSync(stateRoot)).toBe(false);
      if (unsafe === "foreign-entry") expect(readdirSync(registryRoot)).toEqual(["private-command.txt"]);
    }
  });

  test("invalid private PID names and duplicate run IDs make the registry unavailable", async () => {
    const invalidNames = [
      `${runId}.sock`, `${runId}-0.sock`, `${runId}-01.sock`, `${runId}--1.sock`,
      `${runId}-2147483648.sock`, `${runId}-99999999999.sock`, `${runId}-1e3.sock`,
    ];
    for (const names of [...invalidNames.map(name => [name]), [`${runId}-${process.pid}.sock`, `${runId}-${process.pid + 1}.sock`]]) {
      const { stateRoot, registryRoot } = fixture();
      mkdirSync(registryRoot, { mode: 0o700 });
      for (const name of names) writeFileSync(join(registryRoot, name), "retain", { mode: 0o600 });
      expect(await readQueueSnapshot(stateRoot)).toMatchObject({ registry: "unavailable", owners: [], availability: "unknown", custody: "unknown" });
      await expect(pruneStaleQueueEndpoints(stateRoot)).rejects.toThrow();
      expect(readdirSync(registryRoot).sort()).toEqual([...names].sort());
      expect(existsSync(stateRoot)).toBe(false);
    }
    const { stateRoot, registryRoot } = fixture();
    mkdirSync(registryRoot, { mode: 0o700 });
    writeFileSync(privateEndpoint(registryRoot, runId, 2_147_483_647), "invalid socket", { mode: 0o600 });
    expect(await readQueueSnapshot(stateRoot)).toMatchObject({ registry: "available", owners: [], unresponsiveOwners: 1 });
  });

  test("stale, non-socket and unsafe endpoint metadata never imply available capacity", async () => {
    for (const unsafe of ["regular-file", "symlink", "permission", "stale"] as const) {
      const { stateRoot, registryRoot } = fixture();
      mkdirSync(registryRoot, { mode: 0o700 });
      const path = privateEndpoint(registryRoot, runId);
      if (unsafe === "regular-file") writeFileSync(path, "private contents", { mode: 0o600 });
      else if (unsafe === "symlink") symlinkSync("/synthetic/missing-owner", path);
      else {
        await fakeOwner(registryRoot, () => {});
        if (unsafe === "permission") chmodSync(path, 0o666);
        else {
          // Preserve a stale socket after its owner exits without involving
          // scheduler state or leaving a live fixture process behind.
          renameSync(path, `${path}.old`);
          await cleanups.pop()!();
          renameSync(`${path}.old`, path);
        }
      }
      expect(await readQueueSnapshot(stateRoot)).toMatchObject({ registry: "available", availability: "unknown", unresponsiveOwners: 1, owners: [] });
      expect(lstatSync(path)).toBeDefined();
    }
  });

  test("rejects oversized, extra-field, wrong-owner and malformed socket replies", async () => {
    for (const reply of [
      "x".repeat(queueLimits.bytes + 1),
      JSON.stringify({ version: 1, operation: "status", owner: { ...owner(), runId: "f".repeat(32) } }),
      JSON.stringify({ version: 1, operation: "status", owner: { ...owner(), argv: ["private"] } }),
      JSON.stringify({ version: 2, operation: "status", owner: owner() }),
      "{}\n{}", "not-json",
    ]) {
      const { stateRoot, registryRoot } = fixture();
      await fakeOwner(registryRoot, socket => { socket.once("data", () => socket.end(`${reply}\n`)); });
      expect(await readQueueSnapshot(stateRoot)).toMatchObject({ availability: "unknown", owners: [], unresponsiveOwners: 1 });
    }
  });

  test("unresponsive and trickling reply deadlines are absolute", async () => {
    for (const trickle of [false, true]) {
      const { stateRoot, registryRoot } = fixture();
      await fakeOwner(registryRoot, socket => {
        if (trickle) {
          const timer = setInterval(() => socket.write(" "), queueLimits.timeoutMilliseconds / 4);
          socket.once("close", () => clearInterval(timer));
        }
      });
      const started = performance.now();
      expect(await readQueueSnapshot(stateRoot)).toMatchObject({ owners: [], unresponsiveOwners: 1, availability: "unknown" });
      expect(performance.now() - started).toBeLessThan(queueLimits.timeoutMilliseconds * 2.5);
    }
  });

  test("owner request deadlines remain absolute despite incomplete trickling input", async () => {
    const { stateRoot, registryRoot } = fixture();
    const observer = await startQueueObserver({ stateRoot, label: "bounded-owner", lane: "browser-auth", mode: "shared", onHandoff: () => {} });
    cleanups.push(() => observer.close());
    const started = performance.now();
    expect(await rawExchange(privateEndpoint(registryRoot, observer.runId), (socket, onClose) => {
      socket.write("{");
      const timer = setInterval(() => socket.write(" "), queueLimits.timeoutMilliseconds / 4);
      onClose(() => clearInterval(timer));
    })).toBe("");
    expect(performance.now() - started).toBeLessThan(queueLimits.timeoutMilliseconds * 2.5);
    expect((await readQueueSnapshot(stateRoot)).owners).toHaveLength(1);
  });

  test("excess connections close while eight idle or trickling peers expire and status recovers", async () => {
    const { stateRoot, registryRoot } = fixture();
    const observer = await startQueueObserver({ stateRoot, label: "connection-bound", lane: "browser-auth", mode: "shared", onHandoff: () => {} });
    cleanups.push(() => observer.close());
    const path = privateEndpoint(registryRoot, observer.runId);
    let connected = 0;
    let expired = 0;
    let ready: (() => void) | undefined;
    const allConnected = new Promise<void>(resolve => { ready = resolve; });
    const idleReplies = Promise.all(Array.from({ length: queueLimits.connections }, (_, index) => rawExchange(path, (socket, onClose) => {
      connected += 1;
      if (connected === queueLimits.connections) ready?.();
      if (index % 2 === 0) {
        socket.write("{");
        const timer = setInterval(() => socket.write(" "), queueLimits.timeoutMilliseconds / 4);
        onClose(() => clearInterval(timer));
      }
    }).then(reply => { expired += 1; return reply; })));
    await allConnected;
    expect(await rawExchange(path, socket => { socket.write(`${JSON.stringify({ version: 1, operation: "status", runId: observer.runId })}\n`); })).toBe("");
    expect(expired).toBe(0);
    expect(await readQueueSnapshot(stateRoot)).toMatchObject({ owners: [], unresponsiveOwners: 1, availability: "unknown" });
    expect(await idleReplies).toEqual(Array.from({ length: queueLimits.connections }, () => ""));
    expect(expired).toBe(queueLimits.connections);
    expect(await readQueueSnapshot(stateRoot)).toMatchObject({ owners: [{ runId: observer.runId }], unresponsiveOwners: 0 });
  });

  test("owner rejects unbounded, multiple-frame and mismatched requests without notices", async () => {
    const { stateRoot, registryRoot } = fixture();
    const notices: HandoffRequest[] = [];
    const observer = await startQueueObserver({ stateRoot, label: "closed-owner", lane: "browser-auth", mode: "shared", onHandoff: request => notices.push(request) });
    cleanups.push(() => observer.close());
    observer.capabilityAdmitted();
    const path = privateEndpoint(registryRoot, observer.runId);
    for (const message of ["x".repeat(queueLimits.bytes + 1), "{}\n{}\n", `${JSON.stringify(handoff())}\n`,
      `${JSON.stringify({ ...handoff(observer.runId), argv: ["private"] })}\n`]) {
      expect(await rawExchange(path, socket => { socket.write(message); })).toBe("");
    }
    expect(notices).toEqual([]);
    expect((await readQueueSnapshot(stateRoot)).owners[0]?.handoffRequests).toBe(0);
  });

  test("foreign or mismatched handoff receipts are delivery-unknown failures", async () => {
    for (const patch of [{ requestId: "other-request" }, { runId: "f".repeat(32) }, { result: "released" }, { extra: "private" }, { version: 2 }]) {
      const { stateRoot, registryRoot } = fixture();
      await fakeOwner(registryRoot, socket => socket.once("data", () => {
        socket.end(`${JSON.stringify({ version: 1, operation: "request-handoff", runId, requestId: "browser-followup", result: "recorded", ...patch })}\n`);
      }));
      await expect(requestQueueHandoff(stateRoot, handoff())).rejects.toThrow();
    }
  });

  test("explicit stale pruning removes only old refused owned sockets after a pure snapshot", async () => {
    const { stateRoot, registryRoot } = fixture();
    const removable = await staleEndpoint(registryRoot, "1".repeat(32));
    const recent = await staleEndpoint(registryRoot, "2".repeat(32), 0);
    const idle = await fakeOwner(registryRoot, () => {}, "3".repeat(32));
    const malformed = await fakeOwner(registryRoot, socket => { socket.once("data", () => socket.end("not-json\n")); }, "4".repeat(32));
    const unsafe = await staleEndpoint(registryRoot, "5".repeat(32));
    chmodSync(unsafe, 0o666);
    const regular = privateEndpoint(registryRoot, "6".repeat(32));
    writeFileSync(regular, "private placeholder", { mode: 0o600 });
    const symlink = privateEndpoint(registryRoot, "7".repeat(32));
    symlinkSync(removable, symlink);
    const timestamp = new Date(Date.now() - queueLimits.staleMilliseconds * 2);
    for (const path of [idle, malformed, regular]) utimesSync(path, timestamp, timestamp);
    const names = readdirSync(registryRoot).sort();
    const inode = lstatSync(removable).ino;
    expect(await readQueueSnapshot(stateRoot)).toMatchObject({ owners: [], unresponsiveOwners: 7, availability: "unknown", custody: "unknown" });
    expect(readdirSync(registryRoot).sort()).toEqual(names);
    expect(lstatSync(removable).ino).toBe(inode);
    expect(await pruneStaleQueueEndpoints(stateRoot)).toBe(1);
    expect(existsSync(removable)).toBe(false);
    for (const path of [recent, idle, malformed, unsafe, regular, symlink]) expect(lstatSync(path)).toBeDefined();
    expect(await pruneStaleQueueEndpoints(stateRoot)).toBe(0);
    expect(existsSync(stateRoot)).toBe(false);
  });

  test("an old unreachable endpoint naming a live or reused PID remains intact", async () => {
    const { stateRoot, registryRoot } = fixture();
    const abandoned = await staleEndpoint(registryRoot, runId);
    const path = privateEndpoint(registryRoot, runId);
    renameSync(abandoned, path);
    const before = lstatSync(path);
    expect((await probeAbandonedSocket(path)).connected).toBe(false);
    expect(await pruneStaleQueueEndpoints(stateRoot)).toBe(0);
    expect(lstatSync(path).ino).toBe(before.ino);
    expect(existsSync(stateRoot)).toBe(false);
  });

  test("an old paused live owner retains its endpoint with queued client connections", async () => {
    const { stateRoot, registryRoot } = fixture();
    const holder = await socketHolder(registryRoot, [runId]);
    const path = holder.paths[0]!;
    chmodSync(path, 0o600);
    const timestamp = new Date(Date.now() - queueLimits.staleMilliseconds * 2);
    utimesSync(path, timestamp, timestamp);
    holder.pause();
    const clients: Socket[] = [];
    const closures: Array<Promise<void>> = [];
    cleanups.push(async () => { for (const socket of clients) socket.destroy(); await Promise.all(closures); });
    const connected = await Promise.all(Array.from({ length: queueLimits.connections }, () => new Promise<boolean>(resolve => {
      const socket = createConnection(path);
      clients.push(socket);
      closures.push(new Promise<void>(resolveClosed => { socket.once("close", () => resolveClosed()); }));
      const deadline = setTimeout(() => { socket.destroy(); resolve(false); }, queueLimits.timeoutMilliseconds);
      socket.once("connect", () => { clearTimeout(deadline); resolve(true); });
      socket.once("error", () => { clearTimeout(deadline); socket.destroy(); resolve(false); });
      socket.once("close", () => { clearTimeout(deadline); resolve(false); });
    })));
    expect(connected).toContain(true);
    expect(await readQueueSnapshot(stateRoot)).toMatchObject({ owners: [], unresponsiveOwners: 1, availability: "unknown", custody: "unknown" });
    expect(await pruneStaleQueueEndpoints(stateRoot)).toBe(0);
    expect(lstatSync(path).isSocket()).toBe(true);
    expect(existsSync(stateRoot)).toBe(false);
  });

  test("pruning retains endpoints whose inode, timestamp or private mode changes during refusal", async () => {
    for (const changed of ["inode", "timestamp", "mode"] as const) {
      const { stateRoot, registryRoot } = fixture();
      const path = await staleEndpoint(registryRoot, "1".repeat(32));
      let replacement: string | undefined;
      if (changed === "inode") {
        replacement = `${registryRoot}-replacement.sock`;
        renameSync(await staleEndpoint(registryRoot, "2".repeat(32)), replacement);
        cleanups.push(() => rmSync(replacement!, { force: true }));
      }
      const pending = pruneStaleQueueEndpoints(stateRoot);
      if (changed === "inode") {
        const previous = `${registryRoot}-previous.sock`;
        cleanups.push(() => rmSync(previous, { force: true }));
        renameSync(path, previous);
        renameSync(replacement!, path);
      } else if (changed === "timestamp") {
        const updated = new Date(Date.now() - queueLimits.staleMilliseconds * 3);
        utimesSync(path, updated, updated);
      } else chmodSync(path, 0o666);
      expect(await pending).toBe(0);
      expect(lstatSync(path)).toBeDefined();
      expect(existsSync(stateRoot)).toBe(false);
    }
  });

  test("a vanished endpoint cannot authorize pruning from its error code alone", async () => {
    const { stateRoot, registryRoot } = fixture();
    const path = await staleEndpoint(registryRoot, runId);
    const pending = pruneStaleQueueEndpoints(stateRoot);
    rmSync(path);
    expect(await pending).toBe(0);
    expect(readdirSync(registryRoot)).toEqual([]);
    expect(existsSync(stateRoot)).toBe(false);
  });

  test("registration prunes old refused endpoints only near its bounded registry limit", async () => {
    for (const count of [queueLimits.owners / 2 - 1, queueLimits.owners / 2]) {
      const { stateRoot, registryRoot } = fixture();
      await staleEndpoints(registryRoot, Array.from({ length: count }, (_, index) => index.toString(16).padStart(32, "0")));
      const observer = await startQueueObserver({ stateRoot, label: "registration-recovery", lane: "browser-auth", mode: "shared", onHandoff: () => {} });
      cleanups.push(() => observer.close());
      expect(readdirSync(registryRoot)).toHaveLength(count < queueLimits.owners / 2 ? count + 1 : 1);
      expect(existsSync(stateRoot)).toBe(false);
    }
  });

  test("pruning rejects unsafe or oversized registries without creating scheduler state", async () => {
    for (const kind of ["absent", "foreign-entry", "oversized"] as const) {
      const { stateRoot, registryRoot } = fixture();
      if (kind !== "absent") {
        mkdirSync(registryRoot, { mode: 0o700 });
        if (kind === "foreign-entry") writeFileSync(join(registryRoot, "private-placeholder"), "retain");
        else for (let index = 0; index <= queueLimits.owners; index += 1) writeFileSync(privateEndpoint(registryRoot, index.toString(16).padStart(32, "0")), "retain");
      }
      const before = existsSync(registryRoot) ? readdirSync(registryRoot).sort() : null;
      await expect(pruneStaleQueueEndpoints(stateRoot)).rejects.toThrow();
      expect(existsSync(stateRoot)).toBe(false);
      expect(existsSync(registryRoot) ? readdirSync(registryRoot).sort() : null).toEqual(before);
    }
  });
});
