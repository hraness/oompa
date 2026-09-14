import { describe, expect, test } from "bun:test";
import { observePrivateClaudeIdentity } from "./observer.ts";
import type { PrivateIdentityProbeRequest, PrivateIdentityObserverPorts } from "./observer.ts";
import { projectPrivateClaudeIdentity } from "./identity.ts";
import type { QualificationJoinedStatus } from "./identity.ts";
import { LIVE_QUALIFICATION_CAPABILITY } from "./orchestration.ts";

const bytes = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));
const metadata = (letter = "a") => ({ accountUuid: `synthetic-${letter}`, email: `${letter}@example.invalid`, organizationUuid: "synthetic-org" });
function request(signal = new AbortController().signal): PrivateIdentityProbeRequest {
  return { key: new Uint8Array(32).fill(37), runId: "00000000-0000-4000-8000-000000000001", attemptId: "00000000-0000-4000-8000-000000000002",
    probeId: "00000000-0000-4000-8000-000000000003", profile: "A", configDir: "/private/synthetic/observer/A", deadlineMs: 4_000, signal };
}
function status(letter = "a"): QualificationJoinedStatus {
  return { stdout: bytes({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", analyticsDisabled: true,
    projectsDirectory: `${request().configDir}/projects`, email: `${letter}@example.invalid`, orgId: "synthetic-org" }),
    stderrBytes: 0, exitCode: 0, joined: true, stdoutEof: true, stderrEof: true, deadlineMs: 4_000, elapsedMs: 10 };
}
const ports = (): PrivateIdentityObserverPorts => ({ readMetadataIdentity: async () => metadata(), probeJoinedStatus: async () => status() });

// All ports in these tests are injected. No profile, provider, runtime or filesystem is used.
describe("private metadata/status observer composition", () => {
  test("reads two actual normalized tuples around one exact joined-status request", async () => {
    const input = request();
    const order: string[] = [];
    const result = await observePrivateClaudeIdentity(input, {
      readMetadataIdentity: async (scope) => {
        order.push("metadata");
        expect(scope).toEqual({ configDir: input.configDir, configHome: "isolated" });
        return metadata();
      },
      probeJoinedStatus: async (scope) => {
        order.push("status");
        expect(scope).toEqual({ configDir: input.configDir, signal: input.signal, deadlineMs: input.deadlineMs, runId: input.runId,
          attemptId: input.attemptId, probeId: input.probeId, profile: "A" });
        expect("key" in scope).toBe(false);
        return status();
      },
    });
    expect(order).toEqual(["metadata", "status", "metadata"]);
    expect(result).toEqual(projectPrivateClaudeIdentity({ ...input, before: metadata(), after: metadata(), status: status() }));
    expect(JSON.stringify(result)).not.toContain("example.invalid");
    expect(JSON.stringify(result)).not.toContain("synthetic-org");
    expect(result.evidence).toBe("reported_identity_only");
    expect(LIVE_QUALIFICATION_CAPABILITY.status).toBe("unavailable");
  });
  test("rejects a changed tuple and cached A versus active B", async () => {
    let reads = 0;
    await expect(observePrivateClaudeIdentity(request(), { readMetadataIdentity: async () => metadata(reads++ === 0 ? "a" : "b"), probeJoinedStatus: async () => status() })).rejects.toThrow("metadata_changed");
    expect(reads).toBe(2);
    await expect(observePrivateClaudeIdentity(request(), { readMetadataIdentity: async () => metadata(), probeJoinedStatus: async () => status("b") })).rejects.toThrow("identity_mismatch");
  });
  test("snapshots the first tuple before status can mutate an injected object", async () => {
    const shared = metadata();
    await expect(observePrivateClaudeIdentity(request(), { readMetadataIdentity: async () => shared, probeJoinedStatus: async () => {
      Object.assign(shared, metadata("b"));
      return status("b");
    } })).rejects.toThrow("metadata_changed");
  });
  test("snapshots bounded status bytes before the second read and the proof key before awaits", async () => {
    const input = request();
    const originalKey = Uint8Array.from(input.key);
    const observed = status();
    let reads = 0;
    const result = await observePrivateClaudeIdentity(input, { readMetadataIdentity: async () => {
      input.key.fill(99);
      if (++reads === 2) observed.stdout.set(status("b").stdout);
      return metadata();
    }, probeJoinedStatus: async () => observed });
    expect(result).toEqual(projectPrivateClaudeIdentity({ ...input, key: originalKey, before: metadata(), after: metadata(), status: status() }));
    expect(new TextDecoder().decode(observed.stdout)).toContain("b@example.invalid");
  });
  test("private snapshot cleanup leaves caller-owned key and status buffers unchanged", async () => {
    for (const failAfterRead of [false, true]) {
      const input = request();
      const observed = status();
      const originalKey = Uint8Array.from(input.key);
      const originalStatus = Uint8Array.from(observed.stdout);
      let reads = 0;
      const operation = observePrivateClaudeIdentity(input, { readMetadataIdentity: async () => {
        if (++reads === 2 && failAfterRead) throw new Error("synthetic read failure");
        return metadata();
      }, probeJoinedStatus: async () => observed });
      if (failAfterRead) await expect(operation).rejects.toThrow("metadata_unavailable");
      else expect((await operation).signedIn).toBe(true);
      expect(input.key).toEqual(originalKey);
      expect(observed.stdout).toEqual(originalStatus);
    }
  });
  test("stops on either metadata-read failure and exposes only a closed error", async () => {
    for (const failureAt of [0, 1]) {
      let reads = 0;
      let probes = 0;
      try {
        await observePrivateClaudeIdentity(request(), { readMetadataIdentity: async () => {
          if (reads++ === failureAt) throw new Error("synthetic private diagnostic");
          return metadata();
        }, probeJoinedStatus: async () => { probes += 1; return status(); } });
        throw new Error("expected observer refusal");
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        if (!(error instanceof Error)) throw error;
        expect(error.message).toBe("CLAUDE_MACOS_QUALIFICATION_metadata_unavailable");
        expect(error.cause).toBeUndefined();
      }
      expect(reads).toBe(failureAt + 1);
      expect(probes).toBe(failureAt);
    }
  });
  test("unknown status failure never reaches the second read or returns weaker identity", async () => {
    let reads = 0;
    await expect(observePrivateClaudeIdentity(request(), { readMetadataIdentity: async () => { reads += 1; return metadata(); },
      probeJoinedStatus: async () => { throw new Error("synthetic private status failure"); } })).rejects.toThrow("status_unavailable");
    expect(reads).toBe(1);
  });
  test("requires the requested deadline, bounded bytes and complete child/stream joins before after-read", async () => {
    for (const patch of [{ deadlineMs: 3_000 }, { elapsedMs: 4_000 }, { stdoutEof: false }, { stderrEof: false }, { joined: false }, { stdout: new Uint8Array(16_385) }, { stderrBytes: 4_097 }]) {
      let reads = 0;
      await expect(observePrivateClaudeIdentity(request(), { readMetadataIdentity: async () => { reads += 1; return metadata(); },
        probeJoinedStatus: async () => ({ ...status(), ...patch }) })).rejects.toThrow();
      expect(reads).toBe(1);
    }
  });
  test("observes cancellation at each await boundary without retaining the abort reason", async () => {
    for (const phase of ["before", "first_read", "status", "second_read"] as const) {
      const controller = new AbortController();
      let reads = 0;
      let probes = 0;
      if (phase === "before") controller.abort("synthetic private abort reason");
      await expect(observePrivateClaudeIdentity(request(controller.signal), { readMetadataIdentity: async () => {
        reads += 1;
        if ((reads === 1 && phase === "first_read") || (reads === 2 && phase === "second_read")) controller.abort("synthetic private abort reason");
        return metadata();
      }, probeJoinedStatus: async () => { probes += 1; if (phase === "status") controller.abort("synthetic private abort reason"); return status(); } })).rejects.toThrow("CLAUDE_MACOS_QUALIFICATION_aborted");
      expect(reads).toBe(phase === "before" ? 0 : phase === "second_read" ? 2 : 1);
      expect(probes).toBe(phase === "status" || phase === "second_read" ? 1 : 0);
    }
  });
  test("refuses invalid request binding before any injected read or status call", async () => {
    let calls = 0;
    for (const patch of [{ configDir: "relative" }, { configDir: "/private/a/../b" }, { key: new Uint8Array(31) }, { deadlineMs: 2_999 }, { runId: "invalid" }]) {
      await expect(observePrivateClaudeIdentity({ ...request(), ...patch }, { readMetadataIdentity: async () => { calls += 1; return metadata(); },
        probeJoinedStatus: async () => { calls += 1; return status(); } })).rejects.toThrow("invalid_input");
    }
    expect(calls).toBe(0);
  });
  test("refuses noncanonical tuples instead of converting private JSON into a trusted read", async () => {
    for (const value of ["{}", bytes({ oauthAccount: metadata() }), { ...metadata(), extra: true }, { ...metadata(), accountUuid: " SYNTHETIC-A " }]) {
      let probes = 0;
      await expect(observePrivateClaudeIdentity(request(), { readMetadataIdentity: async () => value,
        probeJoinedStatus: async () => { probes += 1; return status(); } })).rejects.toThrow("status_invalid");
      expect(probes).toBe(0);
    }
    await expect(observePrivateClaudeIdentity(request(), { ...ports(), readMetadataIdentity: async () => null })).rejects.toThrow("identity_missing");
  });
});
