import { createHash } from "node:crypto";
import { chmod, mkdtemp, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";
import fc from "fast-check";

import type { CommandRequest, CommandRunner } from "./configure-hosted-sync";
import {
  BoundedProcessCleanupUnprovenError,
  BoundedProcessRecoveryJournalError,
} from "./bounded-process";
import {
  authorityReductionQuotaDiagnosticPageSchema,
  commandCapacityActivationReceiptSchema,
  commandCapacityReadinessEvidenceSchema,
  commandCapacityRetirementIntentSchema,
  commandCapacityRetirementReceiptSchema,
  executeCommandLifecycleCapacity,
  manageCommandLifecycleCapacity,
  parseCommandCapacityArguments,
} from "./manage-command-lifecycle-capacity";
import {
  OOMPA_CONVEX_PROJECT_ID,
  OOMPA_CONVEX_TEAM_ID,
  type ConvexTarget,
} from "./convex-target";
import {
  canonicalDigest,
  deployEvidenceSchema,
  readProtectedJson,
  withSelfDigest,
  writeProtectedJsonNoReplace,
  type DeployEvidence,
  type RuntimeReleaseAttestation,
} from "./release-evidence";

const sourceCommit = "a".repeat(40);
const target: ConvexTarget = {
  deploymentId: 7_654_321,
  deploymentName: "steady-otter-321",
  deploymentUrl: "https://steady-otter-321.convex.cloud",
  projectId: OOMPA_CONVEX_PROJECT_ID,
  teamId: OOMPA_CONVEX_TEAM_ID,
};
const targetArguments = [
  "--deployment", target.deploymentName,
  "--team-id", String(target.teamId),
  "--project-id", String(target.projectId),
  "--deployment-id", String(target.deploymentId),
  "--deployment-url", target.deploymentUrl,
] as const;
const sourceArguments = [
  "--source-commit", sourceCommit,
  "--deploy-evidence", "/protected/candidate.json",
] as const;
const debtId = "0198f56e-7b00-7000-8000-000000000001";
const legacyRevokedId = "0198f56e-7b00-7000-8000-000000000002";
const previousDeployDigest = "b".repeat(64);
const previousAttestation: RuntimeReleaseAttestation = {
  bound: true,
  deployedAtMs: 1_000,
  previousDeployDigest: null,
  runtimeRevision: "00000000-0000-4000-8000-000000000001",
  runtimeSourceCommit: "c".repeat(40),
  schemaIdentity: "hra-release-attestation-v1",
  schemaVersion: 1,
};
const candidateAttestation: RuntimeReleaseAttestation = {
  bound: true,
  deployedAtMs: 2_000,
  previousDeployDigest,
  runtimeRevision: "00000000-0000-4000-8000-000000000002",
  runtimeSourceCommit: sourceCommit,
  schemaIdentity: "hra-release-attestation-v1",
  schemaVersion: 1,
};

const candidateEvidence = (
  overrides: Partial<Omit<DeployEvidence, "selfDigest">> = {},
): DeployEvidence => deployEvidenceSchema.parse(withSelfDigest({
  after: candidateAttestation,
  before: previousAttestation,
  kind: "convex-deploy" as const,
  overlaySha256: "d".repeat(64),
  phase: "candidate" as const,
  previousDeployDigest,
  schemaVersion: 1 as const,
  sourceCommit,
  target,
  targetDigest: canonicalDigest(target),
  ...overrides,
}));

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) => {
    await rm(directory, { force: true, recursive: true });
  }));
});

const makeProtectedDirectory = async (label: string): Promise<string> => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), label)));
  temporaryDirectories.push(directory);
  await chmod(directory, 0o700);
  return directory;
};

function providerResult(value: unknown) {
  return { exitCode: 0, stderr: "", stdout: JSON.stringify(value) };
}

function requestCall(request: CommandRequest) {
  const name = request.arguments[2];
  const rawArgs = request.arguments[3];
  if (name === undefined || rawArgs === undefined) throw new Error("missing Convex invocation");
  return { args: JSON.parse(rawArgs) as Record<string, unknown>, name };
}

const emptyProvider: CommandRunner = async (request) => {
  const call = requestCall(request);
  if (call.name === "commandLifecycle:auditAuthorityReductionHeadroomPage") {
    return providerResult({
      capacityMissing: 0,
      continueCursor: "done",
      hardQuotaBlocked: 0,
      isDone: true,
      mode: call.args.mode,
      orphanCleanupEligible: 0,
      orphanCleanupPending: 0,
      ready: 0,
      repaired: 0,
      scanned: 0,
      schemaVersion: 1,
      topologyBlocked: 0,
    });
  }
  if (call.name === "commandLifecycle:auditReservationPage") {
    return providerResult({
      commandType: call.args.commandType,
      continueCursor: "done",
      effectRetirement: [],
      isDone: true,
      noEffectRetirement: [],
      scanned: 0,
      state: call.args.state,
      unreserved: [],
    });
  }
  if (call.name === "commandLifecycle:auditTerminalReceiptCapacityPage") {
    return providerResult({
      commandType: call.args.commandType,
      continueCursor: "done",
      isDone: true,
      legacyRevoked: [],
      operatorAbandoned: [],
      scanned: 0,
      state: call.args.state,
      unreserved: [],
      unsafeCleanup: [],
    });
  }
  throw new Error(`unexpected function ${call.name}`);
};

const outputWriter = (chunks: string[]): Pick<NodeJS.WriteStream, "write"> => ({
  write(chunk: string | Uint8Array): boolean {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  },
});

type HarnessOptions = Readonly<{
  candidate?: DeployEvidence;
  gitStatus?: string;
  indexFlags?: string;
  provider?: CommandRunner;
}>;

const makeHarness = async (options: HarnessOptions = {}) => {
  const deployDirectory = await makeProtectedDirectory("oompa-command-capacity-deploy-");
  const evidenceDirectory = await makeProtectedDirectory("oompa-command-capacity-output-");
  const sourceRoot = await makeProtectedDirectory("oompa-command-capacity-source-");
  const trackedBytes = Buffer.from("exact command-capacity source\n", "utf8");
  await writeFile(join(sourceRoot, "tracked.txt"), trackedBytes, { mode: 0o600 });
  const trackedObjectId = createHash("sha1")
    .update(`blob ${String(trackedBytes.byteLength)}\0`, "utf8")
    .update(trackedBytes)
    .digest("hex");
  const deployEvidencePath = join(deployDirectory, "candidate.json");
  const evidencePath = join(evidenceDirectory, "readiness.json");
  const retirementEvidencePath = join(evidenceDirectory, "retirement-batch.json");
  let candidate = options.candidate ?? candidateEvidence();
  const expectedProviderAttestation = candidate.after;
  writeProtectedJsonNoReplace(deployEvidencePath, candidate, deployEvidenceSchema);
  let currentAttestation = candidate.after;
  let hostedReadiness: Readonly<Record<string, unknown>> | undefined;
  let activationWrites = 0;
  let loseNextActivationOutput = false;
  let attestationReads = 0;
  let providerCalls = 0;
  let targetChecks = 0;
  let providerHook: ((count: number) => void | Promise<void>) | undefined;
  const provider = options.provider ?? emptyProvider;
  const runner: CommandRunner = async (request) => {
    if (request.executable === "/usr/bin/git") {
      expect(request.arguments[0]).toBe("--no-replace-objects");
      const command = request.arguments.slice(1);
      if (command[0] === "rev-parse" && command[1] === "--show-toplevel") {
        return { exitCode: 0, stderr: "", stdout: `${sourceRoot}\n` };
      }
      if (command[0] === "rev-parse" && command[1] === "--verify") {
        return { exitCode: 0, stderr: "", stdout: `${sourceCommit}\n` };
      }
      if (command[0] === "rev-parse" && command[1] === "--show-object-format") {
        return { exitCode: 0, stderr: "", stdout: "sha1\n" };
      }
      if (command[0] === "config") {
        return { exitCode: 0, stderr: "", stdout: "core.repositoryformatversion\n0\0" };
      }
      if (command[0] === "status") {
        return { exitCode: 0, stderr: "", stdout: options.gitStatus ?? "" };
      }
      if (command[0] === "ls-files" && command[1] === "-v") {
        return { exitCode: 0, stderr: "", stdout: options.indexFlags ?? "H tracked.txt\0" };
      }
      if (command[0] === "ls-tree") {
        return {
          exitCode: 0,
          stderr: "",
          stdout: `100644 blob ${trackedObjectId}\ttracked.txt\0`,
        };
      }
      if (command[0] === "ls-files" && command[1] === "--stage") {
        return {
          exitCode: 0,
          stderr: "",
          stdout: `100644 ${trackedObjectId} 0\ttracked.txt\0`,
        };
      }
      throw new Error(`unexpected Git command: ${command.join(" ")}`);
    }
    providerCalls += 1;
    expect(request.cwd).toBe(sourceRoot);
    expect(request.arguments[0]).toBe(join(
      sourceRoot,
      "node_modules",
      "convex",
      "bin",
      "main.js",
    ));
    expect(requestCall(request).args.expectedRuntimeAttestation).toEqual(
      expectedProviderAttestation,
    );
    const call = requestCall(request);
    let result: Awaited<ReturnType<CommandRunner>>;
    if (call.name === "commandLifecycle:activateCapacityReadiness") {
      const replay = hostedReadiness !== undefined;
      const next = {
        activatedAt: 3_001,
        candidateDeployDigest: call.args.candidateDeployDigest,
        evidenceDigest: call.args.evidenceDigest,
        lifecycleCapacityVersion: call.args.lifecycleCapacityVersion,
        runtimeAttestation: call.args.expectedRuntimeAttestation,
        schemaIdentity: "hra-command-capacity-readiness-v1",
        schemaVersion: 1,
        targetDigest: call.args.targetDigest,
      };
      if (hostedReadiness === undefined) {
        hostedReadiness = next;
        activationWrites += 1;
      } else if (canonicalDigest(hostedReadiness) !== canonicalDigest(next)) {
        result = { exitCode: 1, stderr: "activation conflict", stdout: "" };
        await providerHook?.(providerCalls);
        return result;
      }
      result = loseNextActivationOutput
        ? (() => {
            loseNextActivationOutput = false;
            return { exitCode: 0, stderr: "", stdout: "" };
          })()
        : providerResult({ readiness: hostedReadiness, replay });
    } else if (call.name === "commandLifecycle:readCapacityReadiness") {
      if (hostedReadiness === undefined) {
        result = { exitCode: 1, stderr: "not ready", stdout: "" };
      } else {
        result = providerResult({ readiness: hostedReadiness });
      }
    } else {
      result = await provider(request);
    }
    await providerHook?.(providerCalls);
    return result;
  };
  return {
    common: {
      deployEvidencePath,
      now: () => 3_000,
      prepareProviderSource: async () => ({
        cleanup: async () => {},
        path: sourceRoot,
        recoveryPath: sourceRoot,
        revalidate: async () => {},
      }),
      readAttestation: async () => {
        attestationReads += 1;
        return currentAttestation;
      },
      repositoryRoot: sourceRoot,
      runner,
      sourceCommit,
      target,
      verifyTarget: async (value: ConvexTarget) => {
        expect(value).toEqual(target);
        targetChecks += 1;
      },
    },
    deployEvidencePath,
    evidencePath,
    retirementEvidencePath,
    get attestationReads() { return attestationReads; },
    get activationWrites() { return activationWrites; },
    get candidate() { return candidate; },
    get providerCalls() { return providerCalls; },
    get targetChecks() { return targetChecks; },
    async replaceCandidate(replacement: DeployEvidence) {
      await unlink(deployEvidencePath);
      candidate = replacement;
      writeProtectedJsonNoReplace(deployEvidencePath, replacement, deployEvidenceSchema);
    },
    setAttestation(attestation: RuntimeReleaseAttestation) {
      currentAttestation = attestation;
    },
    loseNextActivationOutput() {
      loseNextActivationOutput = true;
    },
    setProviderHook(hook: (count: number) => void | Promise<void>) {
      providerHook = hook;
    },
  };
};

describe("hosted command lifecycle capacity operator", () => {
  test("requires exact source and candidate evidence plus explicit forward-only mutation intent", () => {
    expect(parseCommandCapacityArguments([
      "status",
      ...sourceArguments,
      ...targetArguments,
    ])).toEqual({
      action: "status",
      deployEvidencePath: "/protected/candidate.json",
      explicitRetirements: [],
      sourceCommit,
      target,
    });
    expect(parseCommandCapacityArguments([
      "repair",
      "--execute",
      "--acknowledge-forward-only",
      "--evidence-path",
      "/protected/readiness.json",
      ...sourceArguments,
      ...targetArguments,
    ])).toEqual({
      action: "repair",
      deployEvidencePath: "/protected/candidate.json",
      evidencePath: "/protected/readiness.json",
      explicitRetirements: [],
      sourceCommit,
      target,
    });
    expect(parseCommandCapacityArguments([
      "repair",
      "--execute",
      "--acknowledge-forward-only",
      "--acknowledge-resultless-ambiguous-retirement",
      "--evidence-path",
      "/protected/readiness.json",
      "--retirement-evidence-path",
      "/protected/retirement.json",
      "--retire-effect-started",
      `session:${debtId}`,
      ...sourceArguments,
      ...targetArguments,
    ])).toMatchObject({
      action: "repair",
      explicitRetirements: [{
        commandPublicId: debtId,
        commandType: "session",
        retirementKind: "effect_started",
      }],
      retirementEvidencePath: "/protected/retirement.json",
    });
    for (const arguments_ of [
      ["status", ...targetArguments],
      ["status", "--execute", ...sourceArguments, ...targetArguments],
      ["repair", "--execute", ...sourceArguments, ...targetArguments],
      [
        "repair",
        "--execute",
        "--acknowledge-forward-only",
        ...sourceArguments,
        ...targetArguments,
      ],
      [
        "repair",
        "--execute",
        "--acknowledge-forward-only",
        "--acknowledge-resultless-ambiguous-retirement",
        "--evidence-path",
        "/protected/readiness.json",
        "--retirement-evidence-path",
        "/protected/readiness.json.activated",
        "--retire-effect-started",
        `session:${debtId}`,
        ...sourceArguments,
        ...targetArguments,
      ],
      [
        "repair",
        "--execute",
        "--acknowledge-forward-only",
        "--evidence-path",
        "/protected/candidate.json.intent",
        "--deploy-evidence",
        "/protected/candidate.json.intent.activated",
        "--source-commit",
        sourceCommit,
        ...targetArguments,
      ],
    ]) expect(() => parseCommandCapacityArguments(arguments_)).toThrow("usage_invalid");
  });

  test("emits aggregate-only command-capacity stdout version 2", async () => {
    const harness = await makeHarness();
    const stdout: string[] = [];
    const stderr: string[] = [];
    expect(await executeCommandLifecycleCapacity({
      arguments: [
        "status",
        "--source-commit",
        sourceCommit,
        "--deploy-evidence",
        harness.deployEvidencePath,
        ...targetArguments,
      ],
      readAttestation: harness.common.readAttestation,
      prepareProviderSource: harness.common.prepareProviderSource,
      repositoryRoot: harness.common.repositoryRoot,
      runner: harness.common.runner,
      stderr: outputWriter(stderr),
      stdout: outputWriter(stdout),
      verifyTarget: harness.common.verifyTarget,
    })).toBe(0);
    expect(stderr).toEqual([]);
    expect(JSON.parse(stdout.join("")) as unknown).toMatchObject({
      authorityReductionUserCandidates: [],
      authorityReductionUserCandidatesTruncated: false,
      version: 2,
    });
  });

  test("repairs bounded IDs, proves two zero-debt passes, and publishes bound no-replace evidence", async () => {
    const requests: CommandRequest[] = [];
    let repaired = false;
    let authorityCapacityRepaired = false;
    const harness = await makeHarness({
      provider: async (request) => {
        requests.push(request);
        const call = requestCall(request);
        expect(request.arguments.slice(-2)).toEqual(["--deployment", target.deploymentName]);
        if (call.name === "commandLifecycle:reserveExisting") {
          repaired = true;
          return providerResult({ state: "reserved" });
        }
        if (call.name === "commandLifecycle:auditAuthorityReductionHeadroomPage") {
          const repairing = call.args.mode === "repair" && !authorityCapacityRepaired;
          if (repairing) authorityCapacityRepaired = true;
          return providerResult({
            capacityMissing: 0,
            continueCursor: "done",
            hardQuotaBlocked: 0,
            isDone: true,
            mode: call.args.mode,
            orphanCleanupEligible: 0,
            orphanCleanupPending: 0,
            ready: repairing ? 0 : 1,
            repaired: repairing ? 1 : 0,
            scanned: 1,
            schemaVersion: 1,
            topologyBlocked: 0,
          });
        }
        expect(call.args).toMatchObject({ paginationOpts: { cursor: null, numItems: 8 } });
        if (call.name === "commandLifecycle:auditReservationPage") {
          const debtScope = call.args.commandType === "session"
            && call.args.state === "effect_started";
          return providerResult({
            commandType: call.args.commandType,
            continueCursor: "done",
            effectRetirement: [],
            isDone: true,
            noEffectRetirement: [],
            scanned: debtScope ? 1 : 0,
            state: call.args.state,
            unreserved: debtScope && !repaired ? [debtId] : [],
          });
        }
        if (call.name === "commandLifecycle:auditTerminalReceiptCapacityPage") {
          const residual = call.args.state === "applied";
          return providerResult({
            commandType: call.args.commandType,
            continueCursor: "done",
            isDone: true,
            legacyRevoked: residual ? [legacyRevokedId] : [],
            operatorAbandoned: [],
            scanned: residual ? 1 : 0,
            state: call.args.state,
            unreserved: [],
            unsafeCleanup: [],
          });
        }
        throw new Error(`unexpected function ${call.name}`);
      },
    });
    const result = await manageCommandLifecycleCapacity({
      action: "repair",
      evidencePath: harness.evidencePath,
      ...harness.common,
    });
    expect(result).toMatchObject({
      evidencePath: harness.evidencePath,
      legacyRevoked: 2,
      lifecycleDebt: 0,
      authorityReductionRepairedThisRun: 1,
      repairedLifecycle: 1,
      repairedReceipts: 0,
      state: "ready",
      terminalReceiptDebt: 0,
      verificationPasses: 2,
    });
    const evidence = readProtectedJson(
      harness.evidencePath,
      commandCapacityReadinessEvidenceSchema,
    );
    expect(evidence).toMatchObject({
      candidateDeployDigest: harness.candidate.selfDigest,
      completedAtMs: 3_000,
      legacyRevoked: 2,
      runtimeRevision: candidateAttestation.runtimeRevision,
      sourceCommit,
      status: "ready",
      target,
    });
    expect(result.evidenceDigest).toBe(evidence.selfDigest);
    const activationReceipt = readProtectedJson(
      `${harness.evidencePath}.activated`,
      commandCapacityActivationReceiptSchema,
    );
    expect(result).toMatchObject({
      activationReceiptDigest: activationReceipt.selfDigest,
      activationReceiptPath: `${harness.evidencePath}.activated`,
    });
    expect(activationReceipt).toMatchObject({
      capacityEvidenceDigest: evidence.selfDigest,
      candidateDeployDigest: harness.candidate.selfDigest,
      status: "activated",
    });
    expect(harness.activationWrites).toBe(1);
    expect(requests).toHaveLength(52);
    expect(harness.attestationReads).toBe(11);
    expect(harness.targetChecks).toBe(
      (harness.providerCalls * 2) + (harness.attestationReads * 2),
    );
    const providerCalls = harness.providerCalls;
    await expect(manageCommandLifecycleCapacity({
      action: "repair",
      evidencePath: harness.evidencePath,
      ...harness.common,
    })).resolves.toMatchObject({ replayed: true, state: "ready" });
    expect(harness.providerCalls).toBe(providerCalls + 36);
    expect(harness.activationWrites).toBe(1);
  });

  test("refuses collisions with derived protected receipts before provider access", async () => {
    const harness = await makeHarness();
    await expect(manageCommandLifecycleCapacity({
      action: "repair",
      evidencePath: harness.evidencePath,
      explicitRetirements: [{
        commandPublicId: debtId,
        commandType: "session",
        retirementKind: "effect_started",
      }],
      retirementEvidencePath: `${harness.evidencePath}.activated`,
      ...harness.common,
    })).rejects.toThrow("usage_invalid");
    expect(harness.attestationReads).toBe(0);
    expect(harness.providerCalls).toBe(0);
    expect(() => readProtectedJson(
      harness.evidencePath,
      commandCapacityReadinessEvidenceSchema,
    )).toThrow();
  });

  test("carries the opaque cursor and reports read-only debt without mutation", async () => {
    const requests: CommandRequest[] = [];
    let firstPendingPage = true;
    const harness = await makeHarness({
      provider: async (request) => {
        requests.push(request);
        const call = requestCall(request);
        if (call.name === "commandLifecycle:auditAuthorityReductionHeadroomPage") {
          return await emptyProvider(request);
        }
        if (call.name === "commandLifecycle:auditReservationPage") {
          const scope = call.args.commandType === "session" && call.args.state === "pending";
          if (scope && firstPendingPage) {
            firstPendingPage = false;
            return providerResult({
              commandType: "session",
              continueCursor: "opaque-next",
              effectRetirement: [],
              isDone: false,
              noEffectRetirement: [{ commandPublicId: debtId, status: "deadline_pending" }],
              scanned: 8,
              state: "pending",
              unreserved: [debtId],
            });
          }
          return providerResult({
            commandType: call.args.commandType,
            continueCursor: "done",
            effectRetirement: [],
            isDone: true,
            noEffectRetirement: [],
            scanned: 0,
            state: call.args.state,
            unreserved: [],
          });
        }
        if (call.name === "commandLifecycle:auditTerminalReceiptCapacityPage") {
          return providerResult({
            commandType: call.args.commandType,
            continueCursor: "done",
            isDone: true,
            legacyRevoked: [],
            operatorAbandoned: [],
            scanned: 0,
            state: call.args.state,
            unreserved: [],
            unsafeCleanup: [],
          });
        }
        throw new Error("status must not invoke a repair mutation");
      },
    });
    expect(await manageCommandLifecycleCapacity({
      action: "status",
      ...harness.common,
    })).toMatchObject({
      lifecycleDebt: 0,
      noEffectRetirementCandidates: [{
        commandPublicId: debtId,
        commandType: "session",
        state: "pending",
        status: "deadline_pending",
      }],
      pendingPreparedDebt: 1,
      state: "debt",
      verificationPasses: 1,
    });
    const pendingCalls = requests.filter((request) => {
      const call = requestCall(request);
      return call.name === "commandLifecycle:auditReservationPage"
        && call.args.commandType === "session"
        && call.args.state === "pending";
    });
    expect(pendingCalls).toHaveLength(2);
    expect(requestCall(pendingCalls[1]!).args)
      .toMatchObject({ paginationOpts: { cursor: "opaque-next", numItems: 8 } });
  });

  test("recovers an activation whose provider response was lost before final receipt", async () => {
    const harness = await makeHarness();
    harness.loseNextActivationOutput();
    await expect(manageCommandLifecycleCapacity({
      action: "repair",
      evidencePath: harness.evidencePath,
      ...harness.common,
    })).rejects.toThrow("provider_result_invalid");
    expect(harness.activationWrites).toBe(1);
    expect(readProtectedJson(
      harness.evidencePath,
      commandCapacityReadinessEvidenceSchema,
    ).status).toBe("ready");
    expect(() => readProtectedJson(
      `${harness.evidencePath}.activated`,
      commandCapacityActivationReceiptSchema,
    )).toThrow();

    const result = await manageCommandLifecycleCapacity({
      action: "repair",
      evidencePath: harness.evidencePath,
      ...harness.common,
    });
    expect(result).toMatchObject({ replayed: true, state: "ready" });
    expect(harness.activationWrites).toBe(1);
    expect(readProtectedJson(
      `${harness.evidencePath}.activated`,
      commandCapacityActivationReceiptSchema,
    )).toMatchObject({
      capacityEvidenceDigest: result.evidenceDigest,
      status: "activated",
    });
  });

  test("reports bounded authority-reduction categories without owner identifiers", async () => {
    const harness = await makeHarness({
      provider: async (request) => {
        const call = requestCall(request);
        if (call.name !== "commandLifecycle:auditAuthorityReductionHeadroomPage") {
          return await emptyProvider(request);
        }
        if (call.args.paginationOpts && (
          call.args.paginationOpts as Readonly<Record<string, unknown>>
        ).cursor === null) {
          return providerResult({
            capacityMissing: 0,
            continueCursor: "headroom-next",
            hardQuotaBlocked: 0,
            isDone: false,
            mode: call.args.mode,
            orphanCleanupEligible: 0,
            orphanCleanupPending: 0,
            ready: 0,
            repaired: 0,
            scanned: 8,
            schemaVersion: 1,
            topologyBlocked: 8,
          });
        }
        return providerResult({
          capacityMissing: 0,
          continueCursor: "done",
          hardQuotaBlocked: 0,
          isDone: true,
          mode: call.args.mode,
          orphanCleanupEligible: 0,
          orphanCleanupPending: 1,
          ready: 0,
          repaired: 0,
          scanned: 1,
          schemaVersion: 1,
          topologyBlocked: 0,
        });
      },
    });
    expect(await manageCommandLifecycleCapacity({
      action: "status",
      ...harness.common,
    })).toMatchObject({
      authorityReductionOrphanCleanupPendingDebt: 1,
      authorityReductionServiceDebt: 1,
      authorityReductionTopologyBlockedDebt: 8,
      authorityReductionUserCandidates: [],
      authorityReductionUserCandidatesTruncated: false,
      authorityReductionUserDebt: 9,
      state: "debt",
    });
  });

  test("reports partial repair plus exact hard quota without leaking provider text", async () => {
    const privateUserId = "private-legacy-user-at-hard-quota";
    const harness = await makeHarness({
      provider: async (request) => {
        const call = requestCall(request);
        if (call.name === "commandLifecycle:auditAuthorityReductionHeadroomPage") {
          const value = {
            capacityMissing: 0,
            continueCursor: "done",
            hardQuotaBlocked: call.args.mode === "repair" ? 1 : 0,
            isDone: true,
            mode: call.args.mode,
            orphanCleanupEligible: 0,
            orphanCleanupPending: 0,
            ready: call.args.mode === "repair" ? 0 : 1,
            repaired: call.args.mode === "repair" ? 1 : 0,
            scanned: 2,
            schemaVersion: 1,
            topologyBlocked: 0,
          };
          return {
            exitCode: 0,
            stderr: `untrusted-provider-detail:${privateUserId}`,
            stdout: JSON.stringify(value),
          };
        }
        return await emptyProvider(request);
      },
    });
    const stdout: string[] = [];
    const stderr: string[] = [];
    expect(await executeCommandLifecycleCapacity({
      arguments: [
        "repair",
        "--execute",
        "--acknowledge-forward-only",
        "--evidence-path",
        harness.evidencePath,
        "--source-commit",
        sourceCommit,
        "--deploy-evidence",
        harness.deployEvidencePath,
        ...targetArguments,
      ],
      readAttestation: harness.common.readAttestation,
      prepareProviderSource: harness.common.prepareProviderSource,
      repositoryRoot: harness.common.repositoryRoot,
      runner: harness.common.runner,
      stderr: outputWriter(stderr),
      stdout: outputWriter(stdout),
      verifyTarget: harness.common.verifyTarget,
    })).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join("")).toBe(
      "Hosted command-capacity operation refused (authority_reduction_hard_quota).\n",
    );
    expect(stderr.join("")).not.toContain(privateUserId);
    expect(() => readProtectedJson(
      harness.evidencePath,
      commandCapacityReadinessEvidenceSchema,
    )).toThrow();
  });

  test("detects authority debt introduced between the two bound readiness scans", async () => {
    let headroomAudits = 0;
    const harness = await makeHarness({
      provider: async (request) => {
        const call = requestCall(request);
        if (call.name === "commandLifecycle:auditAuthorityReductionHeadroomPage") {
          headroomAudits += 1;
          const debtVisible = headroomAudits >= 3;
          return providerResult({
            capacityMissing: debtVisible && call.args.mode === "audit" ? 1 : 0,
            continueCursor: "done",
            hardQuotaBlocked: debtVisible && call.args.mode === "repair" ? 1 : 0,
            isDone: true,
            mode: call.args.mode,
            orphanCleanupEligible: 0,
            orphanCleanupPending: 0,
            ready: 0,
            repaired: 0,
            scanned: debtVisible ? 1 : 0,
            schemaVersion: 1,
            topologyBlocked: 0,
          });
        }
        return await emptyProvider(request);
      },
    });
    await expect(manageCommandLifecycleCapacity({
      action: "repair",
      evidencePath: harness.evidencePath,
      ...harness.common,
    })).rejects.toThrow("authority_reduction_hard_quota");
    expect(headroomAudits).toBe(4);
    expect(harness.attestationReads).toBeGreaterThanOrEqual(7);
    expect(() => readProtectedJson(
      harness.evidencePath,
      commandCapacityReadinessEvidenceSchema,
    )).toThrow();
  });

  test("refuses dirty source before any attestation or provider access", async () => {
    const harness = await makeHarness({ gitStatus: " M tracked.txt\n" });
    await expect(manageCommandLifecycleCapacity({
      action: "status",
      ...harness.common,
    })).rejects.toThrow("source_changed");
    expect(harness.attestationReads).toBe(0);
    expect(harness.providerCalls).toBe(0);
  });

  test("refuses a hidden skip-worktree index entry before runtime or provider access", async () => {
    const harness = await makeHarness({ indexFlags: "S tracked.txt\0" });
    await expect(manageCommandLifecycleCapacity({
      action: "status",
      ...harness.common,
    })).rejects.toThrow("source_changed");
    expect(harness.attestationReads).toBe(0);
    expect(harness.providerCalls).toBe(0);
  });

  test("refuses a replaced private runtime or dependency before provider access", async () => {
    const harness = await makeHarness();
    let cleaned = 0;
    let revalidated = 0;
    await expect(manageCommandLifecycleCapacity({
      action: "status",
      ...harness.common,
      prepareProviderSource: async () => ({
        cleanup: async () => { cleaned += 1; },
        path: harness.common.repositoryRoot,
        recoveryPath: harness.common.repositoryRoot,
        revalidate: async () => {
          revalidated += 1;
          throw new Error("private dependency replaced");
        },
      }),
    })).rejects.toThrow("source_changed");
    expect(revalidated).toBe(1);
    expect(cleaned).toBe(1);
    expect(harness.providerCalls).toBe(0);
  });

  test("refuses live runtime drift before any provider access", async () => {
    const harness = await makeHarness();
    harness.setAttestation({
      ...candidateAttestation,
      runtimeRevision: "00000000-0000-4000-8000-000000000003",
    });
    await expect(manageCommandLifecycleCapacity({
      action: "status",
      ...harness.common,
    })).rejects.toThrow("release_attestation_invalid");
    expect(harness.providerCalls).toBe(0);
  });

  test("detects candidate receipt replacement around a provider boundary", async () => {
    const harness = await makeHarness();
    harness.setProviderHook(async (count) => {
      if (count !== 1) return;
      await harness.replaceCandidate(candidateEvidence({
        after: {
          ...candidateAttestation,
          deployedAtMs: 3_000,
          runtimeRevision: "00000000-0000-4000-8000-000000000004",
        },
      }));
    });
    await expect(manageCommandLifecycleCapacity({
      action: "status",
      ...harness.common,
    })).rejects.toThrow("operation_binding_changed");
    expect(harness.providerCalls).toBe(17);
  });

  test("detects live runtime replacement around a provider boundary", async () => {
    const harness = await makeHarness();
    harness.setProviderHook((count) => {
      if (count === 1) {
        harness.setAttestation({
          ...candidateAttestation,
          runtimeRevision: "00000000-0000-4000-8000-000000000005",
        });
      }
    });
    await expect(manageCommandLifecycleCapacity({
      action: "status",
      ...harness.common,
    })).rejects.toThrow("release_attestation_invalid");
    expect(harness.providerCalls).toBe(17);
  });

  test("refuses malformed provider output and prints only a closed error", async () => {
    const harness = await makeHarness({
      provider: async () => providerResult({ unreserved: ["not-a-command-id"] }),
    });
    const stdout: string[] = [];
    const stderr: string[] = [];
    expect(await executeCommandLifecycleCapacity({
      arguments: [
        "status",
        "--source-commit",
        sourceCommit,
        "--deploy-evidence",
        harness.deployEvidencePath,
        ...targetArguments,
      ],
      readAttestation: harness.common.readAttestation,
      prepareProviderSource: harness.common.prepareProviderSource,
      repositoryRoot: harness.common.repositoryRoot,
      runner: harness.common.runner,
      stderr: outputWriter(stderr),
      stdout: outputWriter(stdout),
      verifyTarget: harness.common.verifyTarget,
    })).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join("")).toBe(
      "Hosted command-capacity operation refused (provider_result_invalid).\n",
    );
  });

  test("stores explicit retirements and replays without requiring non-invertible CLI input", async () => {
    const firstId = "0198f56e-7b00-7000-8000-000000000041";
    const secondId = "0198f56e-7b00-7000-8000-000000000042";
    let retirementCalls = 0;
    const harness = await makeHarness({
      provider: async (request) => {
        const call = requestCall(request);
        if (
          call.name === "commandLifecycle:retireLegacyEffectStarted"
          || call.name === "commandLifecycle:retireLegacyNoEffectExpired"
        ) {
          retirementCalls += 1;
          expect(call.args.acknowledgement).toBe(
            call.name === "commandLifecycle:retireLegacyEffectStarted"
              ? "RETIRE_LEGACY_EFFECT_AS_RESULTLESS_AMBIGUOUS"
              : "RETIRE_LEGACY_NO_EFFECT_AS_EXPIRED",
          );
          return providerResult({ state: "retired" });
        }
        return await emptyProvider(request);
      },
    });
    const explicitRetirements = [
      {
        commandPublicId: secondId,
        commandType: "session" as const,
        retirementKind: "no_effect_expired" as const,
      },
      {
        commandPublicId: firstId,
        commandType: "device" as const,
        retirementKind: "effect_started" as const,
      },
    ];
    expect(await manageCommandLifecycleCapacity({
      action: "repair",
      evidencePath: harness.evidencePath,
      explicitRetirements,
      retirementEvidencePath: harness.retirementEvidencePath,
      ...harness.common,
    })).toMatchObject({ replayed: false, retirementRequests: 2, state: "ready" });
    const evidence = readProtectedJson(
      harness.evidencePath,
      commandCapacityReadinessEvidenceSchema,
    );
    expect(evidence.retirementEntries).toEqual([
      {
        commandPublicId: firstId,
        commandType: "device",
        retirementKind: "effect_started",
      },
      {
        commandPublicId: secondId,
        commandType: "session",
        retirementKind: "no_effect_expired",
      },
    ]);
    expect(retirementCalls).toBe(2);

    expect(await manageCommandLifecycleCapacity({
      action: "repair",
      evidencePath: harness.evidencePath,
      retirementEvidencePath: harness.retirementEvidencePath,
      ...harness.common,
    })).toMatchObject({ replayed: true, retirementRequests: 2, state: "ready" });
    expect(retirementCalls).toBe(2);
    await expect(manageCommandLifecycleCapacity({
      action: "repair",
      evidencePath: harness.evidencePath,
      explicitRetirements: [{
        commandPublicId: firstId,
        commandType: "session",
        retirementKind: "effect_started",
      }],
      retirementEvidencePath: harness.retirementEvidencePath,
      ...harness.common,
    })).rejects.toThrow("readiness_evidence_invalid");
  });

  test("persists a replayable retirement intent before mutation and receipts the batch before readiness", async () => {
    const firstId = "0198f56e-7b00-7000-8000-000000000061";
    const secondId = "0198f56e-7b00-7000-8000-000000000062";
    let crashSecondMutation = true;
    let retainReadinessDebt = false;
    let retirementCalls = 0;
    const harness = await makeHarness({
      provider: async (request) => {
        const call = requestCall(request);
        if (call.name === "commandLifecycle:retireLegacyEffectStarted") {
          retirementCalls += 1;
          if (crashSecondMutation && call.args.commandPublicId === secondId) {
            return { exitCode: 1, stderr: "closed", stdout: "" };
          }
          return providerResult({ state: retirementCalls <= 2 ? "retired" : "exact" });
        }
        if (call.name === "commandLifecycle:reserveExisting") {
          return providerResult({ state: "exact" });
        }
        if (call.name === "commandLifecycle:auditReservationPage") {
          const blocked = retainReadinessDebt
            && call.args.commandType === "session"
            && call.args.state === "pending";
          return providerResult({
            commandType: call.args.commandType,
            continueCursor: "done",
            effectRetirement: [],
            isDone: true,
            noEffectRetirement: blocked
              ? [{ commandPublicId: debtId, status: "eligible" }]
              : [],
            scanned: blocked ? 1 : 0,
            state: call.args.state,
            unreserved: blocked ? [debtId] : [],
          });
        }
        return await emptyProvider(request);
      },
    });
    const retirements = [
      {
        commandPublicId: firstId,
        commandType: "device" as const,
        retirementKind: "effect_started" as const,
      },
      {
        commandPublicId: secondId,
        commandType: "session" as const,
        retirementKind: "effect_started" as const,
      },
    ];
    await expect(manageCommandLifecycleCapacity({
      action: "repair",
      evidencePath: harness.evidencePath,
      explicitRetirements: retirements,
      retirementEvidencePath: harness.retirementEvidencePath,
      ...harness.common,
    })).rejects.toThrow("provider_result_invalid");
    const intent = readProtectedJson(
      `${harness.retirementEvidencePath}.intent`,
      commandCapacityRetirementIntentSchema,
    );
    expect(intent.retirementEntries).toEqual(retirements);
    expect(() => readProtectedJson(
      harness.retirementEvidencePath,
      commandCapacityRetirementReceiptSchema,
    )).toThrow();

    crashSecondMutation = false;
    retainReadinessDebt = true;
    await expect(manageCommandLifecycleCapacity({
      action: "repair",
      evidencePath: harness.evidencePath,
      retirementEvidencePath: harness.retirementEvidencePath,
      ...harness.common,
    })).rejects.toThrow("readiness_debt_remaining");
    const receipt = readProtectedJson(
      harness.retirementEvidencePath,
      commandCapacityRetirementReceiptSchema,
    );
    expect(receipt).toMatchObject({
      intentDigest: intent.selfDigest,
      retirementEntries: retirements,
      status: "completed",
    });
    expect(retirementCalls).toBe(4);

    retainReadinessDebt = false;
    expect(await manageCommandLifecycleCapacity({
      action: "repair",
      evidencePath: harness.evidencePath,
      retirementEvidencePath: harness.retirementEvidencePath,
      ...harness.common,
    })).toMatchObject({
      retirementIntentDigest: intent.selfDigest,
      retirementReceiptDigest: receipt.selfDigest,
      retirementRequests: 2,
      state: "ready",
    });
    expect(retirementCalls).toBe(4);
  });

  test("reports cross-table effect candidates independently and caps retained identities", async () => {
    const sharedId = "0198f56e-7b00-7000-8000-000000000051";
    const additional = Array.from({ length: 7 }, (_, index) =>
      `0198f56e-7b00-7000-8000-${String(index + 52).padStart(12, "0")}`);
    const harness = await makeHarness({
      provider: async (request) => {
        const call = requestCall(request);
        if (call.name === "commandLifecycle:auditReservationPage") {
          const effect = call.args.state === "effect_started";
          const ids = !effect ? [] : call.args.commandType === "session"
            ? [sharedId, ...additional]
            : [sharedId];
          return providerResult({
            commandType: call.args.commandType,
            continueCursor: "done",
            effectRetirement: ids.map((commandPublicId) => ({
              commandPublicId,
              status: "eligible",
            })),
            isDone: true,
            noEffectRetirement: [],
            scanned: ids.length,
            state: call.args.state,
            unreserved: ids,
          });
        }
        return await emptyProvider(request);
      },
    });
    const result = await manageCommandLifecycleCapacity({
      action: "status",
      ...harness.common,
    });
    expect(result.lifecycleDebt).toBe(9);
    expect(result.effectRetirementCandidates).toHaveLength(8);
    expect(result.effectRetirementCandidatesTruncated).toBe(true);
    expect(result.effectRetirementCandidates[0]).toEqual({
      commandPublicId: sharedId,
      commandType: "session",
      status: "eligible",
    });
    // The total remains observational and collision-free even though the
    // bounded identity sample is already full before the device page.
    expect(result.state).toBe("debt");
  });
});

const quotaDiagnosticPage = (a = 1, d = 1) => {
  const ceiling = (applicable: boolean) => ({
    applicable: applicable ? 1 : 0, bytesBlockedByLowerBound: 0,
    bytesUnknown: applicable ? 1 : 0, recordsBlocked: 0,
  });
  const missing = a + d > 0;
  return {
    activationAuthorized: false as const, byteCost: "padding_lower_bound_only" as const,
    capacityMissing: missing ? 1 : 0,
    ceilings: {
      device: ceiling(d > 0), identity: ceiling(a > 0), job: ceiling(missing),
      receipt: ceiling(d > 0), security: ceiling(d > 0),
      serviceTotal: ceiling(missing), userTotal: ceiling(missing),
    },
    consistency: "page_snapshot" as const, continueCursor: "done",
    demand: { accountPairs: a, deviceQuartets: d, paddingBytesLowerBound: 2_048 * (2 * a + 4 * d), totalRecords: 2 * a + 4 * d },
    evaluated: missing ? 1 : 0, isDone: true,
    kind: "authority_reduction_quota_diagnostic" as const,
    orphanEligible: 0, orphanPending: 0, quotaAuthorityUnknown: 0,
    ready: missing ? 0 : 1, repairAuthorized: false as const, scanned: 1,
    schemaVersion: 1 as const, topologyBlocked: 0,
  };
};

describe("closed quota headroom operator", () => {
  test("diagnostic arguments cannot admit writes or readiness artifacts", () => {
    const args = ["diagnose-headroom", ...sourceArguments, ...targetArguments];
    expect(parseCommandCapacityArguments(args).action).toBe("diagnose-headroom");
    for (const flags of [
      ["--execute"], ["--acknowledge-forward-only"],
      ["--acknowledge-resultless-ambiguous-retirement"],
      ["--evidence-path", "/protected/ready.json"],
      ["--retirement-evidence-path", "/protected/retire.json"],
      ["--retire-effect-started", `session:${debtId}`],
      ["--function", "quota:readUser"], ["--user-id", "private-user"],
    ]) expect(() => parseCommandCapacityArguments([...args, ...flags])).toThrow("usage_invalid");
  });

  test("strict page arithmetic preserves unknown byte fit and rejects foreign authority", () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 1 }), fc.integer({ min: 0, max: 16 }), (a, d) => {
      const page = quotaDiagnosticPage(a, d);
      expect(authorityReductionQuotaDiagnosticPageSchema.parse(page)).toEqual(page);
      expect(authorityReductionQuotaDiagnosticPageSchema.safeParse({
        ...page, demand: { ...page.demand, totalRecords: page.demand.totalRecords + 1 },
      }).success).toBe(false);
    }), { numRuns: 100 });
    const page = quotaDiagnosticPage();
    for (const changed of [
      { ...page, userId: "private" }, { ...page, activationAuthorized: true },
      { ...page, repairAuthorized: true }, { ...page, byteCost: "exact" },
      { ...page, evaluated: 0 }, { ...page, scanned: 9 },
      { ...page, demand: { ...page.demand, paddingBytesLowerBound: 12_289 } },
      { ...page, ceilings: { ...page.ceilings, identity: { ...page.ceilings.identity, recordsBlocked: 2 } } },
      { ...page, ceilings: { ...page.ceilings, identity: { ...page.ceilings.identity, bytesUnknown: 0 } } },
      { ...page, ceilings: { ...page.ceilings, account: page.ceilings.identity } },
      { ...page, continueCursor: "x".repeat(4_097) },
    ]) expect(authorityReductionQuotaDiagnosticPageSchema.safeParse(changed).success).toBe(false);
  });

  test("unknown missing identities cannot reuse sets already attributed to an evaluated identity", () => {
    const page = quotaDiagnosticPage();
    expect(authorityReductionQuotaDiagnosticPageSchema.safeParse({
      ...page, capacityMissing: 2, quotaAuthorityUnknown: 1, scanned: 2,
    }).success).toBe(false);
  });

  test.each(["child", "journal"])("%s uncertainty preserves original recovery and source archive", async (kind) => {
    const failure = kind === "child"
      ? new BoundedProcessCleanupUnprovenError(12_345, "diagnostic-fixture")
      : new BoundedProcessRecoveryJournalError(["/synthetic/recovery"], "fixture");
    const harness = await makeHarness({ provider: async () => { throw failure; } });
    let cleaned = false;
    const stdout: string[] = []; const stderr: string[] = [];
    const code = await executeCommandLifecycleCapacity({
      ...harness.common,
      prepareProviderSource: async () => ({
        cleanup: async () => { cleaned = true; },
        path: harness.common.repositoryRoot,
        recoveryPath: harness.common.repositoryRoot,
        revalidate: async () => {},
      }),
      arguments: ["diagnose-headroom", "--source-commit", sourceCommit, "--deploy-evidence", harness.deployEvidencePath, ...targetArguments],
      stderr: outputWriter(stderr), stdout: outputWriter(stdout),
    });
    expect(code).toBe(75);
    expect(cleaned).toBe(false);
    expect(stdout).toEqual([]);
    expect(stderr.join("")).toContain('"status":"recovery_required"');
    expect(stderr.join("")).toContain(harness.common.repositoryRoot);
    expect(stderr.join("")).not.toContain("source_changed");
    expect(harness.providerCalls).toBe(1);
    expect(harness.attestationReads).toBe(1);
  });

  test("uses only the fixed read query and emits no cursor or readiness claim", async () => {
    const calls: string[] = [];
    const harness = await makeHarness({ provider: async (request) => {
      const call = requestCall(request); calls.push(call.name);
      expect(call.name).toBe("commandLifecycle:auditAuthorityReductionQuotaCeilingsPage");
      expect(call.args.paginationOpts).toEqual({ cursor: calls.length === 1 ? null : "opaque-page", numItems: 8 });
      expect(request.timeoutMs).toBe(60_000);
      expect(request.outputMaximumBytes).toBe(65_536);
      expect(request.stdin).toBe("");
      return providerResult({ ...quotaDiagnosticPage(), continueCursor: "opaque-page", isDone: calls.length === 2 });
    } });
    const stdout: string[] = []; const stderr: string[] = [];
    expect(await executeCommandLifecycleCapacity({
      ...harness.common,
      arguments: ["diagnose-headroom", "--source-commit", sourceCommit, "--deploy-evidence", harness.deployEvidencePath, ...targetArguments],
      stderr: outputWriter(stderr), stdout: outputWriter(stdout),
    })).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout).toHaveLength(1);
    const emitted: unknown = JSON.parse(stdout[0] ?? "null");
    expect(emitted).toMatchObject({
      activationAuthorized: false, capacityMissing: 2, consistency: "per_page_only", evaluated: 2,
      demand: { accountPairs: 2, deviceQuartets: 2, paddingBytesLowerBound: 24_576, totalRecords: 12 },
      pages: 2, repairAuthorized: false, state: "diagnostic_complete", version: 1,
      ceilings: { userTotal: { bytesUnknown: 2 } },
    });
    expect(stdout[0]).not.toContain("opaque-page");
    expect(stdout[0]).not.toContain("continueCursor");
    expect(stdout[0]).not.toContain('"state":"ready"');
    expect(harness.activationWrites).toBe(0);
    expect(calls).toHaveLength(2);
    expect(harness.attestationReads).toBe(2);
  });

  test.each(["empty_cursor", "cycle", "malformed"])("%s refuses without a repair fallback", async (kind) => {
    const harness = await makeHarness({ provider: async () => providerResult({
      ...quotaDiagnosticPage(),
      continueCursor: kind === "empty_cursor" ? "" : "repeated",
      isDone: false,
      ...(kind === "malformed" ? { userId: "private" } : {}),
    }) });
    await expect(manageCommandLifecycleCapacity({ ...harness.common, action: "diagnose-headroom" }))
      .rejects.toThrow("provider_result_invalid");
    expect(harness.providerCalls).toBe(kind === "cycle" ? 2 : 1);
    expect(harness.activationWrites).toBe(0);
  });

  test("finite empty-page scan refuses at the users-only page cap", async () => {
    let pages = 0;
    const harness = await makeHarness({ provider: async () => {
      pages += 1;
      return providerResult({ ...quotaDiagnosticPage(0, 0), ready: 0, scanned: 0,
        continueCursor: `page-${String(pages)}`, isDone: false });
    } });
    await expect(manageCommandLifecycleCapacity({ ...harness.common, action: "diagnose-headroom" }))
      .rejects.toThrow("headroom_diagnostic_incomplete");
    expect(pages).toBe(626);
    expect(harness.activationWrites).toBe(0);
  });

  test("final runtime and candidate revalidation cannot publish a completed diagnostic", async () => {
    const harness = await makeHarness({ provider: async () => providerResult(quotaDiagnosticPage()) });
    harness.setProviderHook(() => { harness.setAttestation(previousAttestation); });
    await expect(manageCommandLifecycleCapacity({ ...harness.common, action: "diagnose-headroom" }))
      .rejects.toThrow("release_attestation_invalid");
    expect(harness.providerCalls).toBe(1);
    expect(harness.activationWrites).toBe(0);
  });

  test("unknown ledger authority is retained in a completed observation", async () => {
    const page = quotaDiagnosticPage();
    const zero = { applicable: 0, bytesBlockedByLowerBound: 0, bytesUnknown: 0, recordsBlocked: 0 };
    const harness = await makeHarness({ provider: async () => providerResult({
      ...page, evaluated: 0, quotaAuthorityUnknown: 1,
      ceilings: { device: zero, identity: zero, job: zero, receipt: zero, security: zero, serviceTotal: zero, userTotal: zero },
    }) });
    const result = await manageCommandLifecycleCapacity({ ...harness.common, action: "diagnose-headroom" });
    expect(result.quotaAuthorityUnknown).toBe(1);
    expect(result.state).toBe("diagnostic_complete");
    expect(result.activationAuthorized).toBe(false);
  });
});
