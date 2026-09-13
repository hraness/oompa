import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { formatQueueSnapshot, parseHostQueueArguments } from "./host-queue";
import type { QueueSnapshot } from "./queue-observer";

const runId = "0123456789abcdef0123456789abcdef";
const propertyOptions = { numRuns: 128, seed: 199 };

describe("host queue command", () => {
  test("defaults to a read-only snapshot with optional JSON and closed lane filters", () => {
    expect(parseHostQueueArguments([])).toEqual({ json: false });
    expect(parseHostQueueArguments(["--json"])).toEqual({ json: true });
    for (const lane of ["compute", "browser-auth", "mac-native"] as const) {
      expect(parseHostQueueArguments([`--lane=${lane}`, "--json"])).toEqual({ json: true, lane });
      expect(parseHostQueueArguments([`--lane=${lane}`])).toEqual({ json: false, lane });
    }
  });

  test("requires a complete bounded handoff identity and keeps output selection independent", () => {
    const args = [`--request-handoff=${runId}`, "--request-id=followup-1", "--label=next-render"];
    const request = { version: 1, operation: "request-handoff", runId, requestId: "followup-1", requesterLabel: "next-render" } as const;
    expect(parseHostQueueArguments(args)).toEqual({ json: false, request });
    expect(parseHostQueueArguments(["--json", ...args])).toEqual({ json: true, request });
    for (let excluded = 0; excluded < args.length; excluded += 1) {
      expect(() => parseHostQueueArguments(args.filter((_, index) => index !== excluded))).toThrow();
    }
    expect(() => parseHostQueueArguments([...args, "--lane=browser-auth"])).toThrow();
  });

  test("stale observation repair is explicit and cannot combine with handoff or lane options", () => {
    expect(parseHostQueueArguments(["--prune-stale"])).toEqual({ json: false, pruneStale: true });
    expect(parseHostQueueArguments(["--json", "--prune-stale"])).toEqual({ json: true, pruneStale: true });
    expect(parseHostQueueArguments(["--prune-stale", "--json"])).toEqual({ json: true, pruneStale: true });
    for (const incompatible of ["--lane=browser-auth", `--request-handoff=${runId}`, "--request-id=followup", "--label=render"]) {
      expect(() => parseHostQueueArguments(["--prune-stale", incompatible])).toThrow();
    }
    expect(() => parseHostQueueArguments(["--prune-stale", "--prune-stale"])).toThrow("only once");
    expect(() => parseHostQueueArguments(["--prune-stale=true"])).toThrow();
  });

  test("argument ordering is irrelevant while duplicate options are always refused", () => {
    const arguments_ = ["--json", `--request-handoff=${runId}`, "--request-id=followup", "--label=next-render"];
    const expected = parseHostQueueArguments(arguments_);
    fc.assert(fc.property(fc.shuffledSubarray(arguments_, { minLength: arguments_.length, maxLength: arguments_.length }), ordered => {
      expect(parseHostQueueArguments(ordered)).toEqual(expected);
      for (const argument of ordered) expect(() => parseHostQueueArguments([...ordered, argument])).toThrow("only once");
    }), propertyOptions);
    expect(() => parseHostQueueArguments(["--lane=compute", "--lane=browser-auth"])).toThrow("only once");
  });

  test("never accepts a child command, shell options or loose flag spellings", () => {
    for (const arguments_ of [["--", "bun", "private.ts"], ["--help"], ["--json=true"], ["--lane", "browser-auth"],
      ["--release=true"], ["--lane=cloud"], ["--request-id=orphan"], ["--label=orphan"],
      [`--request-handoff=${runId}`], [`--request-handoff=${runId}`, "--request-id=with spaces", "--label=render"],
      [`--request-handoff=${runId}`, "--request-id=valid", "--label=/private/path"]]) {
      expect(() => parseHostQueueArguments(arguments_)).toThrow();
    }
    fc.assert(fc.property(fc.string({ maxLength: 80 }).filter(value => !["compute", "browser-auth", "mac-native"].includes(value)), lane => {
      expect(() => parseHostQueueArguments([`--lane=${lane}`])).toThrow();
    }), propertyOptions);
  });

  test("human output labels observations without promising capacity or release", () => {
    const snapshot: QueueSnapshot = { version: 1, coverage: "cooperating-wrappers-only", availability: "unknown", custody: "unknown", registry: "available",
      unresponsiveOwners: 2, owners: [{ runId, label: "current-render", taskId: "01234567-89ab-cdef-0123-456789abcdef",
        lane: "browser-auth", mode: "shared", stage: "waiting-compute", capability: "reported-held", elapsedMilliseconds: 12_340,
        queueMilliseconds: 12_340, capabilityMilliseconds: 8_000, handoffRequests: 1 }] };
    const output = formatQueueSnapshot(snapshot);
    expect(output).toContain("Cooperating wrappers only");
    expect(output).toContain("availability and custody unknown");
    expect(output).toContain("scheduler owns admission");
    expect(output).toContain("unresponsive owners: 2");
    expect(output).toContain(`${runId} current-render browser-auth waiting-compute`);
    expect(output).toContain("elapsed=12.3s");
    expect(output).toContain("capability=reported-held");
    expect(output).toContain("task=01234567-89ab-cdef-0123-456789abcdef");
    expect(output).toContain("handoff-requests=1");
    expect(formatQueueSnapshot({ ...snapshot, owners: snapshot.owners.map(value => ({ ...value, taskId: null })) })).not.toContain("task=");
    expect(formatQueueSnapshot({ ...snapshot, registry: "absent", owners: [] })).toContain("Registry: absent");
    for (const field of ["pid=", "argv=", "cwd=", "environment=", "position=", "available=true", "released"]) expect(output).not.toContain(field);
  });
});
