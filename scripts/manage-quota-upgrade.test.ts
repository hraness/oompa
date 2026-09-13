import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { emptyQuotaUpgradeCorruptionCounts } from "../convex/quota";

import {
  finishQuotaUpgradeSource, manageQuotaUpgrade, parseQuotaUpgradeArguments, quotaUpgradeAuditPageSchema, quotaUpgradeDiagnosticPageSchema, quotaUpgradeFailureResult, quotaUpgradeMutationPageSchema,
  type QuotaUpgradeArguments, type QuotaUpgradeDependencies,
} from "./manage-quota-upgrade";
import { BoundedProcessCleanupUnprovenError, BoundedProcessInvocationGuard, BoundedProcessRecoveryJournalError } from "./bounded-process";
import { HostedDeployFilesystemCleanupError, type HostedOperationSourceBinding } from "./deploy-hosted-sync";
import { canonicalDigest, deployEvidenceSchema, withSelfDigest, type RuntimeReleaseAttestation } from "./release-evidence";

const target = { teamId: 513923, projectId: 2854545, deploymentId: 7654321,
  deploymentName: "steady-otter-321", deploymentUrl: "https://steady-otter-321.convex.cloud" } as const;
const sourceCommit = "b".repeat(40);
const before: RuntimeReleaseAttestation = { bound: true, deployedAtMs: 1, previousDeployDigest: null,
  runtimeRevision: "11111111-1111-4111-8111-111111111111", runtimeSourceCommit: "a".repeat(40),
  schemaIdentity: "hra-release-attestation-v1", schemaVersion: 1 };
const predecessor = deployEvidenceSchema.parse(withSelfDigest({ after: before, before: null, kind: "convex-deploy" as const,
  overlaySha256: "a".repeat(64), phase: "bootstrap" as const, previousDeployDigest: null, schemaVersion: 1 as const,
  sourceCommit: before.runtimeSourceCommit, target, targetDigest: canonicalDigest(target) }));
const after: RuntimeReleaseAttestation = { ...before, deployedAtMs: 2, previousDeployDigest: predecessor.selfDigest,
  runtimeRevision: "22222222-2222-4222-8222-222222222222", runtimeSourceCommit: sourceCommit };
const candidate = deployEvidenceSchema.parse(withSelfDigest({ after, before, kind: "convex-deploy" as const,
  overlaySha256: "b".repeat(64), phase: "candidate" as const, previousDeployDigest: predecessor.selfDigest,
  schemaVersion: 1 as const, sourceCommit, target, targetDigest: canonicalDigest(target) }));
const options: QuotaUpgradeArguments = { action: "repair", sourceCommit, target,
  deployEvidencePath: "/protected/candidate.json", previousDeployEvidencePath: "/protected/previous.json", evidencePath: "/protected/upgrade.json" };
const arguments_ = ["repair", "--source-commit", sourceCommit, "--deploy-evidence", options.deployEvidencePath,
  "--previous-deploy-evidence", options.previousDeployEvidencePath, "--evidence-path", "/protected/upgrade.json",
  "--execute", "--acknowledge-forward-only", "--team-id", "513923", "--project-id", "2854545",
  "--deployment-id", "7654321", "--deployment", target.deploymentName, "--deployment-url", target.deploymentUrl];

function world() {
  const state: {
    current: boolean; corrupt: boolean; calls: string[]; audits: number; mutations: number; receipts: number;
    intent?: ReturnType<QuotaUpgradeDependencies["readIntent"]>;
    receipt?: ReturnType<QuotaUpgradeDependencies["readReceipt"]>;
  } = { current: false, corrupt: false, calls: [], audits: 0, mutations: 0, receipts: 0 };
  const dependencies: QuotaUpgradeDependencies = {
    assertSource: () => { state.calls.push("source"); },
    readCandidate: (path) => path === options.deployEvidencePath ? candidate : predecessor,
    verifyTarget: async (value) => { expect(value).toEqual(target); state.calls.push("target"); },
    readAttestation: async () => { state.calls.push("runtime"); return after; },
    invoke: async (name, args) => {
      expect(args).toEqual({ expectedRuntimeAttestation: after, paginationOpts: { numItems: 8, cursor: null } });
      if (name === "quota:auditUserQuotaUpgradePage") {
        state.calls.push("audit"); state.audits += 1;
        return { schemaVersion: 1, continueCursor: "", isDone: true, scanned: 1,
          legacy: state.corrupt || state.current ? 0 : 1, unmarkedCurrent: 0,
          current: !state.corrupt && state.current ? 1 : 0, corrupt: state.corrupt ? 1 : 0 };
      }
      expect(state.intent).toBeDefined();
      expect(state.audits).toBeGreaterThan(0);
      state.calls.push("mutation"); state.mutations += 1; state.current = true;
      return { schemaVersion: 1, continueCursor: "", isDone: true, scanned: 1, current: 0, upgraded: 1, marked: 1 };
    },
    readIntent: () => state.intent,
    writeIntent: (_path, value) => { state.calls.push("intent"); state.intent = value; },
    readReceipt: () => state.receipt,
    writeReceipt: (_path, value) => { state.calls.push("receipt"); state.receipts += 1; state.receipt = value; },
  };
  return { state, dependencies };
}

describe("quota upgrade operator", () => {
  const diagnosticOptions = { action: "diagnose" as const, sourceCommit, target,
    deployEvidencePath: options.deployEvidencePath, previousDeployEvidencePath: options.previousDeployEvidencePath };
  const diagnosticPage = { schemaVersion: 1 as const, continueCursor: "", isDone: true, scanned: 2,
    legacy: 1, unmarkedCurrent: 0, current: 0, corrupt: 1,
    reasons: { ...emptyQuotaUpgradeCorruptionCounts(), schema_shape: 1 } };

  test("diagnose rejects mutation flags and evidence paths before effects", async () => {
    const readArguments = ["diagnose", ...arguments_.slice(1).filter((value, index, values) =>
      value !== "--evidence-path" && values[index - 1] !== "--evidence-path"
      && value !== "--execute" && value !== "--acknowledge-forward-only")];
    expect(parseQuotaUpgradeArguments(readArguments)).toEqual(diagnosticOptions);
    for (const extra of [["--execute"], ["--acknowledge-forward-only"], ["--evidence-path", "/protected/new.json"]]) {
      expect(() => parseQuotaUpgradeArguments([...readArguments, ...extra])).toThrow();
    }
    const { dependencies, state } = world();
    await expect(manageQuotaUpgrade({ ...diagnosticOptions, evidencePath: "/protected/new.json" }, dependencies))
      .rejects.toMatchObject({ code: "usage_invalid" });
    expect(state.calls).toEqual([]);
  });

  test("diagnose aggregates closed counts without reading or writing repair evidence", async () => {
    const { dependencies } = world();
    let pages = 0;
    const result = await manageQuotaUpgrade(diagnosticOptions, { ...dependencies,
      invoke: async (name, args) => {
        expect(name).toBe("quota:diagnoseUserQuotaUpgradePage");
        expect(args).toEqual({ expectedRuntimeAttestation: after, paginationOpts: { numItems: 8, cursor: pages === 0 ? null : "next" } });
        pages += 1;
        return { ...diagnosticPage, isDone: pages === 2, continueCursor: pages === 2 ? "" : "next" };
      },
      readIntent: () => { throw new Error("unexpected intent read"); },
      writeIntent: () => { throw new Error("unexpected intent write"); },
      readReceipt: () => { throw new Error("unexpected receipt read"); },
      writeReceipt: () => { throw new Error("unexpected receipt write"); },
    });
    expect(result).toEqual({ schemaVersion: 1, kind: "quota_upgrade_diagnostic", state: "diagnostic_complete",
      scanned: 4, legacy: 2, unmarkedCurrent: 0, current: 0, corrupt: 2,
      reasons: { ...emptyQuotaUpgradeCorruptionCounts(), schema_shape: 2 }, pages: 2,
      consistency: "per_page_only", reasonSelection: "first_failure_per_identity", repairAuthorized: false, activationAuthorized: false });
  });

  test("diagnostic rejects missing, extra and inconsistent provider fields", async () => {
    const missing = { ...diagnosticPage.reasons }; Reflect.deleteProperty(missing, "schema_shape");
    for (const value of [null, {}, { ...diagnosticPage, rawUserId: "private" },
      { ...diagnosticPage, reasons: missing }, { ...diagnosticPage, reasons: { ...diagnosticPage.reasons, other: 0 } },
      { ...diagnosticPage, corrupt: 0 }, { ...diagnosticPage, reasons: emptyQuotaUpgradeCorruptionCounts() },
      { ...diagnosticPage, reasons: { ...diagnosticPage.reasons, schema_shape: -1 } }]) {
      expect(quotaUpgradeDiagnosticPageSchema.safeParse(value).success).toBe(false);
      const { dependencies, state } = world();
      await expect(manageQuotaUpgrade(diagnosticOptions, { ...dependencies, invoke: async () => value }))
        .rejects.toMatchObject({ code: "provider_result_invalid" });
      expect(state.mutations).toBe(0); expect(state.intent).toBeUndefined(); expect(state.receipts).toBe(0);
    }
  });

  test("diagnostic parser preserves bounded partition counts through JSON round trips", () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 8 }), fc.integer({ min: 0, max: 8 }), (legacy, corrupt) => {
      const value = { ...diagnosticPage, scanned: legacy + corrupt, legacy, corrupt,
        reasons: { ...emptyQuotaUpgradeCorruptionCounts(), schema_shape: corrupt } };
      const parsed = quotaUpgradeDiagnosticPageSchema.safeParse(JSON.parse(JSON.stringify(value)) as unknown);
      expect(parsed.success).toBe(legacy + corrupt <= 8);
      if (parsed.success) expect(parsed.data).toEqual(value);
      expect(quotaUpgradeDiagnosticPageSchema.safeParse({ ...value,
        reasons: { ...value.reasons, schema_shape: corrupt + 1 } }).success).toBe(false);
    }), { numRuns: 40 });
  });

  test("diagnostic refuses stalled cursors and bounded scan overflow", async () => {
    for (const mode of ["empty", "repeat", "overflow"] as const) {
      const { dependencies } = world(); let calls = 0;
      await expect(manageQuotaUpgrade(diagnosticOptions, { ...dependencies, invoke: async () => {
        calls += 1;
        return { ...diagnosticPage, isDone: false, continueCursor: mode === "overflow" ? `page-${calls}` : "same",
          scanned: mode === "empty" ? 0 : 8, legacy: mode === "empty" ? 0 : 8, corrupt: 0,
          reasons: emptyQuotaUpgradeCorruptionCounts() };
      } })).rejects.toMatchObject({ code: "pagination_invalid" });
      expect(calls).toBeLessThanOrEqual(mode === "overflow" ? 626 : 2);
    }
  });

  test("diagnostic refuses source, target or runtime changes before and after a page", async () => {
    for (const phase of ["before", "after"] as const) for (const drift of ["source", "target", "runtime"] as const) {
      const { dependencies } = world(); let pages = 0;
      const changed = () => phase === "before" || pages > 0;
      await expect(manageQuotaUpgrade(diagnosticOptions, { ...dependencies,
        assertSource: () => { if (drift === "source" && changed()) throw new Error("changed"); },
        verifyTarget: async () => { if (drift === "target" && changed()) throw new Error("changed"); },
        readAttestation: async () => drift === "runtime" && changed() ? before : after,
        invoke: async () => { pages += 1; return diagnosticPage; },
      })).rejects.toThrow();
      expect(pages).toBe(phase === "before" ? 0 : 1);
    }
  });

  test("joins exact source cleanup only after process custody permits it", async () => {
    let cleanups = 0;
    const source: HostedOperationSourceBinding = { path: "/protected/source-root/source", recoveryPath: "/protected/source-root",
      revalidate: async () => {}, cleanup: async () => { cleanups += 1; } };
    await finishQuotaUpgradeSource(new BoundedProcessInvocationGuard(), undefined);
    await finishQuotaUpgradeSource(new BoundedProcessInvocationGuard(), source);
    expect(cleanups).toBe(1);
    for (const failure of [new BoundedProcessCleanupUnprovenError(12345, "quota-upgrade-page"),
      new BoundedProcessRecoveryJournalError(["/protected/journal"], "fixture_blocked")]) {
      const guard = new BoundedProcessInvocationGuard();
      guard.retainRecoveryPath(source.recoveryPath);
      await expect(guard.observe(async () => { throw failure; })).rejects.toThrow();
      await expect(finishQuotaUpgradeSource(guard, source)).rejects.toThrow();
      expect(cleanups).toBe(1);
      try { guard.assertMayProceed(); } catch (error: unknown) {
        expect(quotaUpgradeFailureResult(error)).toMatchObject({ exitCode: 75,
          output: { state: "recovery_required", code: "process_recovery_required", recoveryPaths: expect.arrayContaining([source.recoveryPath]) } });
      }
    }
  });

  test("retains a source cleanup failure and renders closed recovery without raw diagnostics", async () => {
    const source: HostedOperationSourceBinding = { path: "/protected/source-root/source", recoveryPath: "/protected/source-root",
      revalidate: async () => {}, cleanup: async () => { throw new Error("private filesystem diagnostic"); } };
    let failure: unknown;
    try { await finishQuotaUpgradeSource(new BoundedProcessInvocationGuard(), source); } catch (error: unknown) { failure = error; }
    expect(quotaUpgradeFailureResult(failure)).toEqual({ exitCode: 75, output: { schemaVersion: 1,
      state: "recovery_required", code: "source_cleanup_failed", recoveryPaths: ["/protected/source-root"] } });
    expect(quotaUpgradeFailureResult(new HostedDeployFilesystemCleanupError("source_cleanup_failed",
      [source.recoveryPath], "source_changed"))).toEqual(quotaUpgradeFailureResult(failure));
    expect(quotaUpgradeFailureResult(new Error("private provider diagnostic"))).toEqual({ exitCode: 1,
      output: { schemaVersion: 1, state: "refused", code: "provider_result_invalid" } });
  });

  test("requires explicit mutation acknowledgement and exact protected/source/target arguments", () => {
    expect(parseQuotaUpgradeArguments(arguments_)).toEqual(options);
    for (const flag of ["--execute", "--acknowledge-forward-only"]) {
      expect(() => parseQuotaUpgradeArguments(arguments_.filter((value) => value !== flag))).toThrow();
    }
    for (const suffix of [["--execute"], ["--source-commit", sourceCommit], ["--unexpected", "x"]]) {
      expect(() => parseQuotaUpgradeArguments([...arguments_, ...suffix])).toThrow();
    }
    expect(() => parseQuotaUpgradeArguments(arguments_.map((value) => value === options.previousDeployEvidencePath ? options.deployEvidencePath : value))).toThrow();
    expect(() => parseQuotaUpgradeArguments(["status", ...arguments_.slice(1)])).toThrow();
  });

  test("status makes only bounded reads and never creates protected evidence", async () => {
    const { state, dependencies } = world();
    const result = await manageQuotaUpgrade({ action: "status", sourceCommit, target,
      deployEvidencePath: options.deployEvidencePath, previousDeployEvidencePath: options.previousDeployEvidencePath }, dependencies);
    expect(result).toMatchObject({ state: "debt", legacy: 1, activationAuthorized: false });
    expect(state.audits).toBe(1); expect(state.mutations).toBe(0); expect(state.receipts).toBe(0);
    expect(state.intent).toBeUndefined();
  });

  test("records intent before mutation and requires two subsequent clean audits before completion", async () => {
    const { state, dependencies } = world();
    const result = await manageQuotaUpgrade(options, dependencies);
    expect(result).toMatchObject({ state: "complete", upgraded: 1, marked: 1, verificationPasses: 2, activationAuthorized: false });
    expect(state.audits).toBe(3); expect(state.mutations).toBe(1); expect(state.receipts).toBe(1);
    expect(state.calls.indexOf("intent")).toBeLessThan(state.calls.indexOf("mutation"));
    expect(state.calls.lastIndexOf("audit")).toBeLessThan(state.calls.indexOf("receipt"));
    expect(state.receipt).toMatchObject({ intentDigest: state.intent?.selfDigest, predecessorDeployDigest: predecessor.selfDigest,
      candidateDeployDigest: candidate.selfDigest, runtimeAttestation: after, activationAuthorized: false });
  });

  test("reconciles an exact completed replay without issuing another mutation or publication", async () => {
    const { state, dependencies } = world();
    await manageQuotaUpgrade(options, dependencies);
    await manageQuotaUpgrade(options, dependencies);
    expect(state.mutations).toBe(1); expect(state.receipts).toBe(1); expect(state.audits).toBe(6);
  });

  test("refuses corrupt audit state before any evidence or mutation", async () => {
    const { state, dependencies } = world(); state.corrupt = true;
    await expect(manageQuotaUpgrade(options, dependencies)).rejects.toMatchObject({ code: "quota_upgrade_corrupt" });
    expect(state.intent).toBeUndefined(); expect(state.mutations).toBe(0); expect(state.receipts).toBe(0);
  });

  test("refuses a different predecessor even when the current public runtime matches", async () => {
    const { state, dependencies } = world();
    await expect(manageQuotaUpgrade(options, { ...dependencies, readCandidate: (path) =>
      path === options.deployEvidencePath ? candidate : { ...predecessor, selfDigest: "c".repeat(64) } })).rejects.toMatchObject({ code: "candidate_invalid" });
    expect(state.audits).toBe(0); expect(state.mutations).toBe(0);
  });

  test("refuses stale runtime or source before the first provider page", async () => {
    for (const drift of ["runtime", "source"] as const) {
      const { state, dependencies } = world();
      await expect(manageQuotaUpgrade(options, { ...dependencies,
        ...(drift === "runtime" ? { readAttestation: async () => before } : { assertSource: () => { throw new Error("source changed"); } }),
      })).rejects.toThrow();
      expect(state.audits).toBe(0); expect(state.mutations).toBe(0);
    }
  });

  test("does not certify an uncertain committed mutation and reconciles it by audit on a later invocation", async () => {
    const { state, dependencies } = world();
    await expect(manageQuotaUpgrade(options, { ...dependencies, invoke: async (name, args) => {
      const result = await dependencies.invoke(name, args);
      if (name === "quota:upgradeUserQuotaPage") throw new Error("response lost");
      return result;
    } })).rejects.toThrow("response lost");
    expect(state.current).toBeTrue(); expect(state.intent).toBeDefined(); expect(state.receipt).toBeUndefined();
    await manageQuotaUpgrade(options, dependencies);
    expect(state.mutations).toBe(1); expect(state.receipts).toBe(1);
  });

  test("retains intent and refuses certification when the runtime changes after a mutation", async () => {
    const { state, dependencies } = world();
    await expect(manageQuotaUpgrade(options, { ...dependencies,
      readAttestation: async () => state.mutations === 0 ? after : before,
    })).rejects.toMatchObject({ code: "binding_changed" });
    expect(state.mutations).toBe(1); expect(state.intent).toBeDefined(); expect(state.receipt).toBeUndefined();
  });

  test("does not repair again when a completed receipt contradicts current debt", async () => {
    const { state, dependencies } = world();
    await manageQuotaUpgrade(options, dependencies); state.current = false;
    await expect(manageQuotaUpgrade(options, dependencies)).rejects.toMatchObject({ code: "evidence_invalid" });
    expect(state.mutations).toBe(1);
  });

  test("rejects intent drift before the next migration page", async () => {
    const { state, dependencies } = world();
    await expect(manageQuotaUpgrade(options, { ...dependencies, readIntent: () => state.intent === undefined ? undefined
      : { ...state.intent, sourceCommit: "c".repeat(40) },
    })).rejects.toMatchObject({ code: "evidence_invalid" });
    expect(state.mutations).toBe(0); expect(state.receipt).toBeUndefined();
  });

  test("refuses non-progressing and repeated cursors with no mutation", async () => {
    for (const scanned of [0, 1]) {
      const { state, dependencies } = world(); let calls = 0;
      await expect(manageQuotaUpgrade(options, { ...dependencies, invoke: async () => {
        calls += 1;
        return { schemaVersion: 1, continueCursor: "same", isDone: false, scanned, legacy: scanned, unmarkedCurrent: 0, current: 0, corrupt: 0 };
      } })).rejects.toMatchObject({ code: "pagination_invalid" });
      expect(calls).toBeLessThanOrEqual(2); expect(state.mutations).toBe(0);
    }
  });

  test("rejects malformed provider frames without a completion receipt", async () => {
    for (const value of [null, {}, { schemaVersion: 1, continueCursor: "", isDone: true, scanned: 1,
      legacy: 1, unmarkedCurrent: 0, current: 1, corrupt: 0 }]) {
      const { state, dependencies } = world();
      await expect(manageQuotaUpgrade(options, { ...dependencies, invoke: async () => value })).rejects.toMatchObject({ code: "provider_result_invalid" });
      expect(state.intent).toBeUndefined(); expect(state.receipts).toBe(0);
    }
  });

  test("requires both post-migration scans to be clean", async () => {
    const { state, dependencies } = world();
    await expect(manageQuotaUpgrade(options, { ...dependencies, invoke: async (name, args) => {
      const value = await dependencies.invoke(name, args);
      if (name === "quota:auditUserQuotaUpgradePage" && state.audits === 3) {
        return { schemaVersion: 1, continueCursor: "", isDone: true, scanned: 1, legacy: 1, unmarkedCurrent: 0, current: 0, corrupt: 0 };
      }
      return value;
    } })).rejects.toMatchObject({ code: "quota_upgrade_debt_remaining" });
    expect(state.receipt).toBeUndefined(); expect(state.mutations).toBe(1);
  });

  test("all valid bounded audit partitions conserve the scanned count", () => {
    fc.assert(fc.property(fc.array(fc.integer({ min: 0, max: 3 }), { maxLength: 8 }), (kinds) => {
      const bins = [0, 0, 0, 0];
      for (const kind of kinds) bins[kind] = (bins[kind] ?? 0) + 1;
      const frame = { schemaVersion: 1, continueCursor: "", isDone: true, scanned: kinds.length,
        legacy: bins[0], unmarkedCurrent: bins[1], current: bins[2], corrupt: bins[3] };
      expect(quotaUpgradeAuditPageSchema.safeParse(frame).success).toBeTrue();
      expect(quotaUpgradeAuditPageSchema.safeParse({ ...frame, scanned: kinds.length + 1 }).success).toBeFalse();
      expect(quotaUpgradeAuditPageSchema.safeParse({ ...frame, extra: "untrusted" }).success).toBeFalse();
    }));
  });

  test("mutation count bounds reject overlap and impossible upgrades", () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 8 }), (marked) => {
      const frame = { schemaVersion: 1, continueCursor: "", isDone: true, scanned: 8, current: 8 - marked, marked, upgraded: marked };
      expect(quotaUpgradeMutationPageSchema.safeParse(frame).success).toBeTrue();
      expect(quotaUpgradeMutationPageSchema.safeParse({ ...frame, upgraded: marked + 1 }).success).toBeFalse();
      expect(quotaUpgradeMutationPageSchema.safeParse({ ...frame, current: 9 - marked }).success).toBeFalse();
    }));
  });
});
