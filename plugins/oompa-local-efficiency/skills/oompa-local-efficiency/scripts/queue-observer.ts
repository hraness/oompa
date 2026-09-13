import { randomBytes } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, opendirSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import type { CapabilityLane, ResourceMode } from "./host-run";
import { requireOperationLabel, sha256 } from "./shared";

// Observation has no connection to admission. Never read, lock, repair or remove
// a scheduler marker here. A surviving descendant can retain a lease after its
// wrapper and observation socket disappear.
export const queueLimits = Object.freeze({ owners: 64, connections: 8, bytes: 2_048, timeoutMilliseconds: 400, notices: 32, staleMilliseconds: 60_000 });
const runIdPattern = /^[0-9a-f]{32}$/u;
const endpointPattern = /^([0-9a-f]{32})-([1-9][0-9]{0,9})\.sock$/u;
const stages = ["waiting-capability", "waiting-compute", "running", "settling"] as const;
export type QueueStage = typeof stages[number];
type CapabilityReport = "reported-held" | "waiting" | "none";

export type QueueOwner = {
  readonly runId: string;
  readonly label: string;
  readonly taskId: string | null;
  readonly lane: CapabilityLane;
  readonly mode: ResourceMode;
  readonly stage: QueueStage;
  readonly capability: CapabilityReport;
  readonly elapsedMilliseconds: number;
  readonly queueMilliseconds: number;
  readonly capabilityMilliseconds: number | null;
  readonly handoffRequests: number;
};
export type QueueSnapshot = {
  readonly version: 1;
  readonly coverage: "cooperating-wrappers-only";
  readonly availability: "unknown";
  readonly custody: "unknown";
  readonly registry: "available" | "absent" | "unavailable";
  readonly unresponsiveOwners: number;
  readonly owners: readonly QueueOwner[];
};
type StatusRequest = { readonly version: 1; readonly operation: "status"; readonly runId: string };
export type HandoffRequest = {
  readonly version: 1;
  readonly operation: "request-handoff";
  readonly runId: string;
  readonly requestId: string;
  readonly requesterLabel: string;
};
export type HandoffResult = "recorded" | "already-recorded" | "conflict" | "not-holder" | "limit-reached";
export type HandoffReceipt = {
  readonly version: 1;
  readonly operation: "request-handoff";
  readonly runId: string;
  readonly requestId: string;
  readonly result: HandoffResult;
};

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
    throw new Error("invalid queue observation record");
  }
  return value as Record<string, unknown>;
}
export function requireQueueRunId(value: unknown): string {
  if (typeof value !== "string" || !runIdPattern.test(value)) throw new Error("invalid queue run ID");
  return value;
}
export function requireQueueTaskId(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(value)) {
    throw new Error("--task-id must be an explicit UUID");
  }
  return value;
}
export function parseQueueRequest(value: unknown): StatusRequest | HandoffRequest {
  if (typeof value !== "object" || value === null || !("operation" in value)) throw new Error("invalid queue request");
  const record = object(value, value.operation === "status" ? ["version", "operation", "runId"]
    : ["version", "operation", "runId", "requestId", "requesterLabel"]);
  if (record.version !== 1) throw new Error("invalid queue protocol version");
  const runId = requireQueueRunId(record.runId);
  if (record.operation === "status") return { version: 1, operation: "status", runId };
  if (record.operation !== "request-handoff" || typeof record.requestId !== "string" || typeof record.requesterLabel !== "string") {
    throw new Error("invalid queue operation");
  }
  return { version: 1, operation: "request-handoff", runId,
    requestId: requireOperationLabel(record.requestId, "request ID"),
    requesterLabel: requireOperationLabel(record.requesterLabel, "requester label") };
}

export function parseQueueOwner(value: unknown): QueueOwner {
  const record = object(value, ["runId", "label", "taskId", "lane", "mode", "stage", "capability",
    "elapsedMilliseconds", "queueMilliseconds", "capabilityMilliseconds", "handoffRequests"]);
  requireQueueRunId(record.runId);
  if (typeof record.label !== "string") throw new Error("invalid owner label");
  requireOperationLabel(record.label, "owner label");
  if (record.taskId !== null) requireQueueTaskId(record.taskId);
  if ((record.lane !== "compute" && record.lane !== "browser-auth" && record.lane !== "mac-native")
    || (record.mode !== "shared" && record.mode !== "heavy" && record.mode !== "exclusive")
    || !stages.some(stage => stage === record.stage)) throw new Error("invalid owner stage");
  const expected = record.lane === "compute" ? "none"
    : record.stage === "waiting-capability" || (record.stage === "settling" && record.capabilityMilliseconds === null) ? "waiting" : "reported-held";
  if (record.capability !== expected || (record.lane === "compute" && record.stage === "waiting-capability")) {
    throw new Error("inconsistent capability observation");
  }
  for (const key of ["elapsedMilliseconds", "queueMilliseconds", "handoffRequests"] as const) {
    if (!Number.isSafeInteger(record[key]) || Number(record[key]) < 0) throw new Error("invalid observation duration or count");
  }
  if (Number(record.queueMilliseconds) > Number(record.elapsedMilliseconds) || Number(record.handoffRequests) > queueLimits.notices) {
    throw new Error("inconsistent observation bounds");
  }
  const held = record.capabilityMilliseconds;
  if (expected === "reported-held" ? !Number.isSafeInteger(held) || Number(held) < 0 || Number(held) > Number(record.elapsedMilliseconds) : held !== null) {
    throw new Error("invalid capability duration");
  }
  return record as QueueOwner;
}

// Short POSIX socket addresses also work for long checkout/state paths on macOS.
// The path contains only a uid and digest; no command, task, repository or ledger
// content. The 0700 directory is a private ephemeral observation namespace.
export function queueRegistryRoot(stateRoot: string): string {
  return join("/tmp", `oompa-q-${process.getuid?.() ?? "unknown"}-${sha256(resolve(stateRoot)).slice(0, 24)}`);
}
function privateDirectory(root: string): void {
  const metadata = lstatSync(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o700
    || (process.getuid !== undefined && metadata.uid !== process.getuid())) throw new Error("queue registry is not private");
}
function endpointIdentity(name: string): { runId: string; ownerPid: number } {
  const match = endpointPattern.exec(name);
  const ownerPid = Number(match?.[2]);
  if (match === null || !Number.isSafeInteger(ownerPid) || ownerPid > 2_147_483_647) throw new Error("invalid queue endpoint identity");
  return { runId: requireQueueRunId(match[1]), ownerPid };
}
function endpoints(root: string): string[] {
  privateDirectory(root);
  const directory = opendirSync(root);
  const result: string[] = [];
  const runIds = new Set<string>();
  try {
    for (let count = 0; ; count += 1) {
      const entry = directory.readSync();
      if (entry === null) return result;
      if (count >= queueLimits.owners) throw new Error("queue registry bound exceeded");
      const { runId } = endpointIdentity(entry.name);
      if (runIds.has(runId)) throw new Error("duplicate queue endpoint identity");
      runIds.add(runId);
      result.push(entry.name);
    }
  } finally { directory.closeSync(); }
}
function endpoint(root: string, runId: string): string {
  requireQueueRunId(runId);
  const name = endpoints(root).find(candidate => endpointIdentity(candidate).runId === runId);
  if (name === undefined) throw new Error("queue endpoint unavailable");
  const path = join(root, name);
  const metadata = lstatSync(path);
  if (!metadata.isSocket() || metadata.isSymbolicLink() || metadata.nlink !== 1 || (metadata.mode & 0o777) !== 0o600
    || (process.getuid !== undefined && metadata.uid !== process.getuid())) throw new Error("queue endpoint is not private");
  return path;
}

function receive(socket: Socket, callback: (value: unknown) => void): void {
  let bytes = Buffer.alloc(0);
  let complete = false;
  const deadline = setTimeout(() => { socket.destroy(); }, queueLimits.timeoutMilliseconds);
  deadline.unref();
  socket.once("close", () => { clearTimeout(deadline); });
  socket.once("end", () => { socket.destroy(); });
  socket.on("error", () => { socket.destroy(); });
  socket.on("data", (chunk: Buffer) => {
    if (complete) { socket.destroy(); return; }
    if (bytes.length + chunk.length > queueLimits.bytes) { socket.destroy(); return; }
    bytes = Buffer.concat([bytes, chunk]);
    const end = bytes.indexOf(10);
    if (end < 0) return;
    complete = true;
    if (end !== bytes.length - 1) { socket.destroy(); return; }
    try { callback(JSON.parse(bytes.subarray(0, end).toString("utf8")) as unknown); }
    catch { socket.destroy(); }
  });
}
function encode(value: unknown): string {
  const encoded = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(encoded) > queueLimits.bytes) throw new Error("queue message bound exceeded");
  return encoded;
}
async function exchange(root: string, request: StatusRequest | HandoffRequest): Promise<unknown> {
  const path = endpoint(root, request.runId);
  return new Promise((resolveReply, reject) => {
    const socket = createConnection(path);
    const timer = setTimeout(() => { socket.destroy(); }, queueLimits.timeoutMilliseconds);
    let done = false;
    socket.once("connect", () => { socket.write(encode(request)); });
    receive(socket, value => { done = true; resolveReply(value); socket.destroy(); });
    socket.once("close", () => { clearTimeout(timer); if (!done) reject(new Error("queue owner unavailable; delivery unknown")); });
  });
}

export function isUnreachableQueueEndpoint(error: unknown, platform: NodeJS.Platform = process.platform,
  bunVersion: string | undefined = process.versions.bun): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  // Pinned Bun maps synchronous Unix connect failures to ENOENT on Darwin and
  // Linux. This is only a candidate: prune must still prove the
  // exact old private socket node exists unchanged after the failed connection
  // and its registered owner PID is absent. A busy listener can map to ENOENT.
  // It establishes endpoint unreachability, never owner death or lease release.
  return error.code === "ECONNREFUSED"
    || (error.code === "ENOENT" && (platform === "darwin" || platform === "linux") && bunVersion === "1.3.14");
}

function ownerAbsent(ownerPid: number): boolean {
  // Signal zero only checks process existence. A live or reused PID, permission
  // refusal and every unknown result retain the observation endpoint.
  try { process.kill(ownerPid, 0); return false; }
  catch (error: unknown) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH";
  }
}

async function connectionUnreachable(path: string): Promise<boolean> {
  return new Promise(resolveRefused => {
    const socket = createConnection(path);
    let refused = false;
    let expired = false;
    const timer = setTimeout(() => { expired = true; socket.destroy(); }, queueLimits.timeoutMilliseconds);
    socket.once("connect", () => { socket.destroy(); });
    socket.once("error", (error: unknown) => {
      refused = !expired && isUnreachableQueueEndpoint(error);
      socket.destroy();
    });
    socket.once("close", () => { clearTimeout(timer); resolveRefused(!expired && refused); });
  });
}

/** Explicit observation-only repair, also used by registration near its bound.
 * An unreachable stale socket proves only that this endpoint cannot respond. It
 * says nothing about scheduler custody, capacity or surviving descendants. */
export async function pruneStaleQueueEndpoints(stateRoot: string): Promise<number> {
  const root = queueRegistryRoot(stateRoot);
  const names = endpoints(root);
  let removed = 0;
  for (let offset = 0; offset < names.length; offset += queueLimits.connections) {
    await Promise.all(names.slice(offset, offset + queueLimits.connections).map(async name => {
      try {
        const { runId, ownerPid } = endpointIdentity(name);
        const path = endpoint(root, runId);
        if (path !== join(root, name)) return;
        const before = lstatSync(path);
        if (Date.now() - before.mtimeMs < queueLimits.staleMilliseconds || !ownerAbsent(ownerPid)
          || !await connectionUnreachable(path)) return;
        if (endpoint(root, runId) !== path) return;
        const after = lstatSync(path);
        if (after.dev !== before.dev || after.ino !== before.ino || after.mtimeMs !== before.mtimeMs || !ownerAbsent(ownerPid)) return;
        unlinkSync(path);
        removed += 1;
      } catch { /* Unknown, live, new or replaced endpoints are retained. */ }
    }));
  }
  return removed;
}

export function createHandoffRecorder(): (request: HandoffRequest, holdsCapability: boolean) => HandoffReceipt {
  const recorded = new Map<string, string>();
  return (request, holdsCapability) => {
    // Reconcile a retry even after the owner starts settling; never replay it.
    const previous = recorded.get(request.requestId);
    const result: HandoffResult = previous !== undefined
      ? previous === request.requesterLabel ? "already-recorded" : "conflict"
      : !holdsCapability ? "not-holder" : recorded.size >= queueLimits.notices ? "limit-reached" : "recorded";
    if (result === "recorded") recorded.set(request.requestId, request.requesterLabel);
    return { version: 1, operation: "request-handoff", runId: request.runId, requestId: request.requestId, result };
  };
}

export type QueueObserver = {
  readonly runId: string;
  capabilityAdmitted(): void;
  cpuAdmitted(): void;
  settling(): void;
  close(): Promise<void>;
};
export async function startQueueObserver(input: {
  readonly stateRoot: string;
  readonly label: string;
  readonly taskId?: string;
  readonly lane: CapabilityLane;
  readonly mode: ResourceMode;
  readonly onHandoff: (request: HandoffRequest) => void;
}): Promise<QueueObserver> {
  requireOperationLabel(input.label, "owner label");
  if (input.taskId !== undefined) requireQueueTaskId(input.taskId);
  const root = queueRegistryRoot(input.stateRoot);
  try { mkdirSync(root, { mode: 0o700 }); } catch (error: unknown) {
    if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "EEXIST") throw error;
  }
  if (endpoints(root).length >= queueLimits.owners / 2) await pruneStaleQueueEndpoints(input.stateRoot);
  if (endpoints(root).length >= queueLimits.owners) throw new Error("queue registry is full");
  const runId = randomBytes(16).toString("hex");
  const started = performance.now();
  let capabilityAt: number | null = null;
  let cpuAt: number | null = null;
  let stage: QueueStage = input.lane === "compute" ? "waiting-compute" : "waiting-capability";
  let closed = false;
  let handoffRequests = 0;
  const record = createHandoffRecorder();
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    if (closed || sockets.size >= queueLimits.connections) { socket.destroy(); return; }
    sockets.add(socket);
    socket.unref();
    socket.once("close", () => sockets.delete(socket));
    receive(socket, value => {
      const request = parseQueueRequest(value);
      if (request.runId !== runId || closed) { socket.destroy(); return; }
      if (request.operation === "status") {
        const now = performance.now();
        const owner: QueueOwner = { runId, label: input.label, taskId: input.taskId ?? null, lane: input.lane, mode: input.mode,
          stage, capability: input.lane === "compute" ? "none" : capabilityAt === null ? "waiting" : "reported-held",
          elapsedMilliseconds: Math.max(0, Math.round(now - started)), queueMilliseconds: Math.max(0, Math.round((cpuAt ?? now) - started)),
          capabilityMilliseconds: capabilityAt === null ? null : Math.max(0, Math.round(now - capabilityAt)), handoffRequests };
        socket.end(encode({ version: 1, operation: "status", owner }));
      } else {
        const receipt = record(request, capabilityAt !== null && stage !== "settling");
        if (receipt.result === "recorded") {
          handoffRequests += 1;
          // Intent is recorded before the notice. Failure is never a reason to
          // signal the child, release its lease or replay the notice.
          try { input.onHandoff(request); } catch { /* Observation is best effort. */ }
        }
        socket.end(encode(receipt));
      }
    });
  });
  // The private filename binds cleanup to this owner without disclosing its PID
  // through status, handoff receipts or progress output.
  const path = join(root, `${runId}-${process.pid}.sock`);
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(path, () => { resolveListen(); });
  });
  try { chmodSync(path, 0o600); endpoint(root, runId); }
  catch (error: unknown) { server.close(); throw error; }
  server.on("error", () => { /* Admission and child outcome remain authoritative. */ });
  server.unref();
  return {
    runId,
    capabilityAdmitted() { capabilityAt = performance.now(); stage = "waiting-compute"; },
    cpuAdmitted() { cpuAt = performance.now(); stage = "running"; },
    settling() { stage = "settling"; },
    async close() {
      closed = true;
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolveClose => { server.close(() => { resolveClose(); }); });
    },
  };
}

export async function readQueueSnapshot(stateRoot: string, lane?: CapabilityLane): Promise<QueueSnapshot> {
  const root = queueRegistryRoot(stateRoot);
  const base = { version: 1, coverage: "cooperating-wrappers-only", availability: "unknown", custody: "unknown" } as const;
  let names: string[];
  try { names = endpoints(root); } catch (error: unknown) {
    const absent = typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
    return { ...base, registry: absent ? "absent" : "unavailable", unresponsiveOwners: 0, owners: [] };
  }
  let unresponsiveOwners = 0;
  const owners: QueueOwner[] = [];
  // Fixed fan-out and per-exchange deadlines bound a full snapshot to eight
  // batches. Order is deliberately by run ID, never presented as FIFO position.
  for (let offset = 0; offset < names.length; offset += queueLimits.connections) {
    await Promise.all(names.slice(offset, offset + queueLimits.connections).map(async name => {
      const { runId } = endpointIdentity(name);
      try {
        const value = object(await exchange(root, { version: 1, operation: "status", runId }), ["version", "operation", "owner"]);
        if (value.version !== 1 || value.operation !== "status") throw new Error("invalid queue response");
        const owner = parseQueueOwner(value.owner);
        if (owner.runId !== runId) throw new Error("queue owner changed");
        if (lane === undefined || owner.lane === lane) owners.push(owner);
      } catch { unresponsiveOwners += 1; }
    }));
  }
  return { ...base, registry: "available", unresponsiveOwners, owners: owners.sort((a, b) => a.runId.localeCompare(b.runId)) };
}

export async function requestQueueHandoff(stateRoot: string, input: HandoffRequest): Promise<HandoffReceipt> {
  const request = parseQueueRequest(input);
  if (request.operation !== "request-handoff") throw new Error("handoff request required");
  const value = object(await exchange(queueRegistryRoot(stateRoot), request), ["version", "operation", "runId", "requestId", "result"]);
  if (value.version !== 1 || value.operation !== "request-handoff" || value.runId !== request.runId || value.requestId !== request.requestId
    || !["recorded", "already-recorded", "conflict", "not-holder", "limit-reached"].some(result => result === value.result)) {
    throw new Error("invalid handoff receipt; delivery unknown");
  }
  return value as HandoffReceipt;
}
