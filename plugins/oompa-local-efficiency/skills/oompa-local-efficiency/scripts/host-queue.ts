#!/usr/bin/env bun

import { resolveHostResourceStateRoot, type CapabilityLane } from "./host-run";
import { pruneStaleQueueEndpoints, readQueueSnapshot, requestQueueHandoff, requireQueueRunId, type HandoffRequest, type QueueSnapshot } from "./queue-observer";
import { requireOperationLabel } from "./shared";

export function parseHostQueueArguments(args: readonly string[]): { readonly json: boolean; readonly pruneStale?: true; readonly lane?: CapabilityLane; readonly request?: HandoffRequest } {
  let json = false;
  let pruneStale = false;
  let lane: CapabilityLane | undefined;
  let runId: string | undefined;
  let requestId: string | undefined;
  let requesterLabel: string | undefined;
  const seen = new Set<string>();
  for (const arg of args) {
    const key = arg.split("=", 1)[0] ?? "";
    if (seen.has(key)) throw new Error("queue arguments may appear only once");
    seen.add(key);
    if (arg === "--json") json = true;
    else if (arg === "--prune-stale") pruneStale = true;
    else if (arg.startsWith("--lane=")) {
      const value = arg.slice(7);
      if (value !== "compute" && value !== "browser-auth" && value !== "mac-native") throw new Error("invalid queue lane");
      lane = value;
    } else if (arg.startsWith("--request-handoff=")) runId = requireQueueRunId(arg.slice(18));
    else if (arg.startsWith("--request-id=")) requestId = requireOperationLabel(arg.slice(13), "request ID");
    else if (arg.startsWith("--label=")) requesterLabel = requireOperationLabel(arg.slice(8), "requester label");
    else throw new Error("unknown oompa-host-queue argument");
  }
  if (pruneStale) {
    if (lane !== undefined || runId !== undefined || requestId !== undefined || requesterLabel !== undefined) throw new Error("prune-stale accepts only --json");
    return { json, pruneStale: true };
  }
  if (runId === undefined && requestId === undefined && requesterLabel === undefined) return { json, ...(lane === undefined ? {} : { lane }) };
  if (runId === undefined || requestId === undefined || requesterLabel === undefined || lane !== undefined) {
    throw new Error("handoff requires --request-handoff=RUN_ID --request-id=ID --label=LABEL, without --lane");
  }
  return { json, request: { version: 1, operation: "request-handoff", runId, requestId, requesterLabel } };
}

export function formatQueueSnapshot(snapshot: QueueSnapshot): string {
  const rows = snapshot.owners.map(owner => `${owner.runId} ${owner.label} ${owner.lane} ${owner.stage}`
    + ` elapsed=${(owner.elapsedMilliseconds / 1000).toFixed(1)}s capability=${owner.capability}`
    + (owner.taskId === null ? "" : ` task=${owner.taskId}`) + ` handoff-requests=${owner.handoffRequests}`);
  return ["Cooperating wrappers only; availability and custody unknown; scheduler owns admission.",
    `Registry: ${snapshot.registry}; unresponsive owners: ${snapshot.unresponsiveOwners}`, ...rows].join("\n");
}

if (import.meta.main) {
  try {
    if (process.argv.length === 3 && process.argv[2] === "--help") {
      console.log("Usage: oompa-host-queue [--lane=compute|browser-auth|mac-native] [--json]\n"
        + "       oompa-host-queue --request-handoff=RUN_ID --request-id=ID --label=LABEL [--json]\n"
        + "       oompa-host-queue --prune-stale [--json]\n"
        + "Status is partial and read-only. Handoff records a notice; it never releases a lease.\n"
        + "Prune removes only old unreachable observation sockets; scheduler custody remains unknown.");
      process.exit(0);
    }
    const parsed = parseHostQueueArguments(process.argv.slice(2));
    const stateRoot = resolveHostResourceStateRoot();
    if (parsed.pruneStale === true) {
      const removed = await pruneStaleQueueEndpoints(stateRoot);
      console.log(parsed.json ? JSON.stringify({ version: 1, operation: "prune-stale", removed, availability: "unknown", custody: "unknown" })
        : `Removed ${removed} stale observation endpoints; scheduler capacity and custody remain unknown`);
    } else if (parsed.request === undefined) {
      const snapshot = await readQueueSnapshot(stateRoot, parsed.lane);
      console.log(parsed.json ? JSON.stringify(snapshot) : formatQueueSnapshot(snapshot));
      process.exitCode = snapshot.registry === "unavailable" ? 2 : 0;
    } else {
      const receipt = await requestQueueHandoff(stateRoot, parsed.request);
      console.log(parsed.json ? JSON.stringify(receipt) : `${receipt.result}: ${receipt.requestId} to ${receipt.runId}; notice only, release remains owner-controlled`);
      process.exitCode = receipt.result === "recorded" || receipt.result === "already-recorded" ? 0 : 2;
    }
  } catch {
    // Do not echo foreign filesystem errors or arbitrary arguments into output.
    console.error("[oompa-host-queue] invalid request or unavailable owner; handoff delivery is unknown. Retry only the same request ID and label.");
    process.exitCode = 2;
  }
}
