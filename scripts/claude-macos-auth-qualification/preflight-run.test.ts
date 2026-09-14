import { expect, test } from "bun:test";
import fc from "fast-check";

import { CLAUDE_PIN, PINNED_CLAUDE_ARTIFACT_DIGESTS } from "../../src/claude/pin";
import { QualificationCustodyError } from "./custody";
import { ClaudeMacosPreflightError } from "./preflight";
import { runCredentialFreeClaudeMacosPreflight, runNativeClaudeMacosPreflight } from "./preflight-run";
import { validateQualificationCheckpoint } from "./receipt";
import { createQualification, type QualificationState } from "./state";

type Ports = Parameters<typeof runCredentialFreeClaudeMacosPreflight>[1];
type Diagnostic = Awaited<ReturnType<Ports["collect"]>>;
const id = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const root = "/private/synthetic/preflight-run";
const node = (name: string, inode: number) => ({ path: `${root}/${name}`, device: 1, inode, mode: 0o700 });
const source = { sourceSha: "a".repeat(40), sourceTree: "b".repeat(40), executable: { path: "/synthetic/executable", device: 1, inode: 100 } };
const binding = { version: 1, runId: id(1), ...source, pin: CLAUDE_PIN, executableDigest: PINNED_CLAUDE_ARTIFACT_DIGESTS.nativeExecutable,
  ownerUid: 501, realHome: "/Users/synthetic", forbiddenRoots: ["/private/production"], runRoot: { path: root, device: 1, inode: 2, mode: 0o700 },
  profileA: node("A", 3), profileB: node("B", 4), temporaryA: node("tmp-A", 5), temporaryB: node("tmp-B", 6),
  proofKey: { path: `${root}/proof-key`, device: 1, inode: 7, mode: 0o600 } };
function fixture() {
  const key = new Uint8Array(32).fill(17); let state = createQualification(binding, key, id(2));
  const calls: string[] = []; const suppliedCheckpoints: Uint8Array[] = []; const suppliedKeys: Uint8Array[] = [];
  const controller = new AbortController();
  const input = { repositoryRoot: "/synthetic/repository", sourceCommit: source.sourceSha, executablePath: source.executable.path,
    environment: { HOME: binding.realHome, PATH: "/usr/bin:/bin" }, signal: controller.signal };
  const custody: Awaited<ReturnType<Ports["create"]>> = {
    runId: binding.runId, recoveryRoot: root, receiptPath: `${root}/.oompa-macos-auth-qualification-${binding.runId}.recovery.json`,
    state: () => structuredClone(state), async assertCurrent() { calls.push("custody-current"); },
    async withProofKey<T>(observe: (bytes: Uint8Array) => Promise<T>): Promise<T> {
      const copy = Uint8Array.from(key); suppliedKeys.push(copy);
      try { return await observe(copy); } finally { copy.fill(0); }
    },
    async persist(bytes) {
      suppliedCheckpoints.push(bytes); const next = validateQualificationCheckpoint(bytes, key);
      calls.push(`persist:${next.pending?.stage ?? "none"}`); await Promise.resolve(); state = next;
    },
    async releasePreserving() { calls.push("release"); },
  };
  const diagnostic = (): Diagnostic => {
    const attemptId = state.pending?.attemptId ?? id(99);
    const probes = (["A", "B"] as const).flatMap((profile) => (["version", "login_help", "logout_help"] as const).map((operation, index) => ({
      runId: binding.runId, attemptId, probeId: id(10 + (profile === "A" ? 0 : 3) + index), profile, operation, stdoutSha256: "c".repeat(64),
      stdoutBytes: 20, stderrBytes: 0 as const, deadlineMs: 5000, elapsedMs: 10,
      detachment: { identity: { pid: 123, pidDomain: "darwin" as const, procStart: "Fri Sep 11 16:34:59 2026" },
        setsidChecked: true as const, newSession: true as const, controllingTty: false as const, stdinClosed: true as const },
      loginHelp: operation === "login_help" ? { optionRows: [{ flags: ["--claudeai"], argument: "none" as const }], projectionComplete: true,
        diagnostics: { version: 1 as const, usage: "exact" as const, scan: "scanned" as const,
          lineCount: 3, optionsHeadingCount: 1, candidateCount: 1, acceptedCount: 1,
          candidateLimitExceeded: false, rejectionsTruncated: false, rejections: [] } } : null,
    })));
    return { source: "credential_free_fixture", admitted: false, reason: "login_help_unverified", runId: binding.runId, attemptId,
      exactVersionBoth: true, logoutHelpBoth: true, loginHelpBoth: false, probes };
  };
  const ports: Ports = {
    capture() { calls.push("capture"); return { source, assertCurrent() { calls.push("source-current"); } }; },
    async create() { calls.push("create"); return custody; },
    async assertFresh() { calls.push("fresh"); },
    async assertEnvironment() { calls.push("environment"); },
    async collect() { calls.push("collect-six"); return diagnostic(); },
  };
  return { input, ports, custody, diagnostic, controller, calls, suppliedCheckpoints, suppliedKeys, state: () => state,
    setState: (value: QualificationState) => { state = value; } };
}
const cleared = (value: ReturnType<typeof fixture>): void => {
  for (const bytes of [...value.suppliedCheckpoints, ...value.suppliedKeys]) expect(bytes.every((byte) => byte === 0)).toBeTrue();
};

test("fixed runner durably dispatches one fresh attempt, keeps step zero, retains evidence and releases once", async () => {
  const value = fixture(); const outcome = await runCredentialFreeClaudeMacosPreflight(value.input, value.ports);
  expect(outcome).toMatchObject({ source: "credential_free_fixture", admitted: false, step: 0, status: "blocked", reason: "login_help_unverified",
    cleanup: "joined", ownerRelease: "released", freshRootsObserved: true, checkpoint: "dispatched", recovery: { runId: binding.runId, runRoot: root } });
  expect(value.calls).toEqual(["capture", "create", "fresh", "persist:intent", "persist:persisted", "environment", "custody-current", "source-current", "persist:dispatched", "collect-six", "release"]);
  expect(value.state().events.map((event) => event.type)).toEqual(["intent", "persisted", "dispatch"]);
  expect(value.state().step).toBe(0); expect(value.state().pending?.stage).toBe("dispatched");
  expect(outcome.diagnostic?.probes).toHaveLength(6);
  expect(outcome.diagnostic?.probes.filter((probe) => probe.operation === "login_help").map((probe) => probe.loginHelp?.diagnostics))
    .toEqual(value.diagnostic().probes.filter((probe) => probe.operation === "login_help").map((probe) => probe.loginHelp?.diagnostics));
  cleared(value);
});

test("each uncertain checkpoint stops the sequence without a second write or any preflight effect", async () => {
  for (const failureAt of [1, 2, 3]) {
    const value = fixture(); let writes = 0;
    const custody = { ...value.custody, async persist(bytes: Uint8Array) {
      writes += 1; value.suppliedCheckpoints.push(bytes);
      if (writes === failureAt) throw new Error("synthetic publication uncertainty");
      await value.custody.persist(bytes);
    } };
    const outcome = await runCredentialFreeClaudeMacosPreflight(value.input, { ...value.ports, async create() { return custody; } });
    expect(outcome).toMatchObject({ status: "recovery_required", reason: "persistence_uncertain", checkpoint: "uncertain", cleanup: "not_started", ownerRelease: "released" });
    expect(writes).toBe(failureAt); expect(value.calls).not.toContain("collect-six"); expect(value.calls.filter((call) => call === "release")).toHaveLength(1); cleared(value);
  }
});

test("early admission and constructor failures preserve only genuinely known recovery scope", async () => {
  const value = fixture();
  const refused = await runCredentialFreeClaudeMacosPreflight(value.input, { ...value.ports, capture() { throw new Error("synthetic source refused"); } });
  expect(refused).toMatchObject({ status: "refused", reason: "admission_refused", recovery: null, ownerRelease: "not_acquired", checkpoint: "none" });
  const retained = await runCredentialFreeClaudeMacosPreflight(value.input, { ...value.ports,
    async create() { throw new QualificationCustodyError("recovery_required", root); } });
  expect(retained).toMatchObject({ status: "recovery_required", reason: "custody_refused", recovery: { runId: null, runRoot: root, receiptPath: null }, ownerRelease: "uncertain" });
  expect(value.calls).not.toContain("release"); expect(value.calls).not.toContain("collect-six");
});

test("fresh root or environment refusal and abort prevent dispatch or collection", async () => {
  for (const failure of ["fresh", "environment", "abort-fresh", "abort-dispatch"] as const) {
    const value = fixture();
    const ports = { ...value.ports, async assertFresh() {
      if (failure === "fresh") throw new Error("synthetic occupied root");
      if (failure === "abort-fresh") value.controller.abort();
    }, async assertEnvironment() { if (failure === "environment") throw new Error("synthetic environment refused"); },
    async create() { return { ...value.custody, async persist(bytes: Uint8Array) {
      await value.custody.persist(bytes); if (failure === "abort-dispatch" && value.state().pending?.stage === "dispatched") value.controller.abort();
    } }; } };
    const outcome = await runCredentialFreeClaudeMacosPreflight(value.input, ports);
    expect(outcome.reason).toBe(failure === "fresh" ? "fresh_roots_refused" : failure === "environment" ? "authority_refused" : "aborted");
    expect(outcome.ownerRelease).toBe("released"); expect(outcome.cleanup).toBe("not_started"); expect(value.calls).not.toContain("collect-six"); cleared(value);
  }
});

test("native collector failure preserves its explicit joined, unstarted or uncertain cleanup result", async () => {
  for (const cleanup of ["not_started", "joined", "uncertain"] as const) {
    const value = fixture();
    const outcome = await runCredentialFreeClaudeMacosPreflight(value.input, { ...value.ports, async collect() { throw new ClaudeMacosPreflightError("native_unproved", cleanup); } });
    expect(outcome).toMatchObject({ status: "recovery_required", reason: "preflight_refused", cleanup, checkpoint: "dispatched", diagnostic: null, ownerRelease: "released" });
    expect(value.state().events).toHaveLength(3); cleared(value);
  }
});

test("owner release failure preserves the primary outcome and never retries release or effects", async () => {
  for (const failedEffect of [false, true]) {
    const value = fixture(); let releases = 0;
    const outcome = await runCredentialFreeClaudeMacosPreflight(value.input, { ...value.ports,
      async create() { return { ...value.custody, async releasePreserving() { releases += 1; throw new Error("synthetic owner uncertain"); } }; },
      async collect() { if (failedEffect) throw new ClaudeMacosPreflightError("native_unproved", "uncertain"); return value.diagnostic(); },
    });
    expect(outcome).toMatchObject({ status: "recovery_required", reason: failedEffect ? "preflight_refused" : "login_help_unverified", ownerRelease: "uncertain",
      cleanup: failedEffect ? "uncertain" : "joined", checkpoint: "dispatched" });
    expect(releases).toBe(1); expect(value.state().events).toHaveLength(3); cleared(value);
  }
});

test("the owner remains held until the collector returns or reports settled uncertainty", async () => {
  const value = fixture(); const entered = Promise.withResolvers<undefined>(); const completion = Promise.withResolvers<Diagnostic>();
  const pending = runCredentialFreeClaudeMacosPreflight(value.input, { ...value.ports, async collect() { entered.resolve(undefined); return await completion.promise; } });
  await entered.promise; value.controller.abort(); await Promise.resolve();
  expect(value.calls).not.toContain("release");
  completion.reject(new ClaudeMacosPreflightError("aborted", "joined"));
  expect(await pending).toMatchObject({ reason: "aborted", cleanup: "joined", ownerRelease: "released" }); cleared(value);
});

test("fixture/native provenance substitution or unexpected diagnostic shape cannot claim a joined preflight", async () => {
  for (const change of ["mode", "run", "count", "admitted", "reason", "extra"] as const) {
    const value = fixture();
    const outcome = await runCredentialFreeClaudeMacosPreflight(value.input, { ...value.ports, async collect() {
      const diagnostic = value.diagnostic();
      const altered: unknown = { ...diagnostic, ...(change === "mode" ? { source: "native_process" } : change === "run" ? { runId: id(99) }
        : change === "count" ? { probes: [] } : change === "admitted" ? { admitted: true } : change === "reason" ? { reason: "qualified" } : { extra: true }) };
      return altered as Diagnostic;
    } });
    expect(outcome).toMatchObject({ source: "credential_free_fixture", admitted: false, reason: "preflight_refused", cleanup: "uncertain", diagnostic: null }); cleared(value);
  }
  const value = fixture(); value.setState({ ...value.state(), binding: { ...value.state().binding, version: 2, mode: "native_qualification" } });
  const outcome = await runCredentialFreeClaudeMacosPreflight(value.input, value.ports);
  expect(outcome.reason).toBe("custody_refused"); expect(value.suppliedCheckpoints).toHaveLength(0); expect(value.calls).not.toContain("collect-six");
});

test("native runner rejects caller-selected operations, effects and fabricated facts before any source admission", async () => {
  await fc.assert(fc.asyncProperty(fc.constantFrom("ports", "operation", "step", "result", "sourceChecked", "signatureRevalidated", "custody", "runtime"), async (extra) => {
    const value = fixture();
    await expect(runNativeClaudeMacosPreflight({ ...value.input, [extra]: true })).rejects.toThrow("invalid_input");
    expect(value.calls).toEqual([]);
  }), { numRuns: 32 });
});

test("input environment is captured before creation awaits", async () => {
  const value = fixture(); const original = { ...value.input.environment };
  const outcome = await runCredentialFreeClaudeMacosPreflight(value.input, { ...value.ports, async create() {
    value.input.environment.PATH = "/synthetic/later"; await Promise.resolve(); return value.custody;
  }, async assertEnvironment(_custody, input) { expect(input.environment).toEqual(original); expect(Object.isFrozen(input.environment)).toBeTrue(); } });
  expect(outcome.status).toBe("blocked"); cleared(value);
});
