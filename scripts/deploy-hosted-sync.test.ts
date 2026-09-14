import { afterEach, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CommandRequest, CommandRunner } from "./configure-hosted-sync";
import {
  BoundedProcessCleanupUnprovenError,
  BoundedProcessContainmentUnavailableError,
  BoundedProcessRecoveryJournalError,
} from "./bounded-process";
import {
  deployHostedSync,
  executeHostedDeploy,
  parseDeployArguments,
  resolvedTargetAssertionCommand,
} from "./deploy-hosted-sync";
import {
  deployEvidenceSchema,
  parseDeployEvidenceFile,
  type RuntimeReleaseAttestation,
  withSelfDigest,
  writeProtectedJsonNoReplace,
} from "./release-evidence";
import {
  OOMPA_EXPECTED_CONVEX_DEPLOY_URL,
  OOMPA_RESOLVED_CONVEX_DEPLOY_URL,
  resolvedConvexDeployTargetMatches,
} from "./assert-convex-deploy-target";
import {
  ConvexTargetError,
  OOMPA_CONVEX_PROJECT_ID,
  OOMPA_CONVEX_TEAM_ID,
  type ConvexTarget,
  type ConvexTargetVerifier,
} from "./convex-target";

const sourceCommit = "a".repeat(40);
const target: ConvexTarget = {
  deploymentId: 7_654_321,
  deploymentName: "steady-otter-321",
  deploymentUrl: "https://steady-otter-321.convex.cloud",
  projectId: OOMPA_CONVEX_PROJECT_ID,
  teamId: OOMPA_CONVEX_TEAM_ID,
};
const targetArguments = [
  "--deployment",
  target.deploymentName,
  "--team-id",
  String(target.teamId),
  "--project-id",
  String(target.projectId),
  "--deployment-id",
  String(target.deploymentId),
  "--deployment-url",
  target.deploymentUrl,
] as const;

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) => {
    await rm(directory, { force: true, recursive: true });
  }));
});

const makeTemporaryDirectory = async (label: string): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), label));
  temporaryDirectories.push(directory);
  return directory;
};

const materializeArchivedSource = async (request: CommandRequest): Promise<void> => {
  const destination = request.arguments[3];
  if (destination === undefined) throw new Error("missing archive destination");
  await Promise.all([
    mkdir(join(destination, "convex"), { recursive: true, mode: 0o700 }),
    mkdir(join(destination, "scripts"), { recursive: true, mode: 0o700 }),
  ]);
  await Promise.all([
    writeFile(join(destination, "bun.lock"), "fixture-lock\n", "utf8"),
    writeFile(join(destination, "package.json"), "{}\n", "utf8"),
    writeFile(
      join(destination, "convex", "releaseAttestation.ts"),
      "// fixture release attestation\n",
      "utf8",
    ),
    writeFile(
      join(destination, "scripts", "assert-convex-deploy-target.ts"),
      "// fixture assertion\n",
      "utf8",
    ),
  ]);
};

const materializeArchivedDependencies = async (request: CommandRequest): Promise<void> => {
  const convexPackage = join(request.cwd, "node_modules", "convex");
  const convexBin = join(convexPackage, "bin");
  await mkdir(convexBin, { recursive: true, mode: 0o700 });
  await Promise.all([
    writeFile(join(convexPackage, "package.json"), "{\"name\":\"convex\"}\n", "utf8"),
    writeFile(join(convexBin, "main.js"), "// fixture Convex CLI\n", "utf8"),
  ]);
};

const outputWriter = (chunks: string[]): Pick<NodeJS.WriteStream, "write"> => ({
  write(chunk: string | Uint8Array): boolean {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  },
});

const makeDeployEvidenceHarness = async () => {
  const repositoryRoot = await makeTemporaryDirectory("oompa-hosted-chain-source-");
  const temporaryRoot = await makeTemporaryDirectory("oompa-hosted-chain-temp-");
  const evidenceDirectory = await realpath(
    await makeTemporaryDirectory("oompa-hosted-chain-output-"),
  );
  await chmod(evidenceDirectory, 0o700);
  let activeSourceCommit = sourceCommit;
  let providerResult: "deployed" | "failed-before-start-push" = "deployed";
  let runtime: RuntimeReleaseAttestation | null = null;
  let deploymentCalls = 0;
  let authorityReads = 0;
  const runner: CommandRunner = async (request) => {
    if (request.executable === "/usr/bin/git") {
      return request.arguments[0] === "rev-parse"
        ? { exitCode: 0, stderr: "", stdout: `${activeSourceCommit}\n` }
        : { exitCode: 0, stderr: "", stdout: "" };
    }
    if (request.executable === "/usr/bin/tar") {
      await materializeArchivedSource(request);
      return { exitCode: 0, stderr: "", stdout: "" };
    }
    if (request.phase === "source-dependency-install") {
      await materializeArchivedDependencies(request);
      return { exitCode: 0, stderr: "", stdout: "installed" };
    }
    deploymentCalls += 1;
    if (providerResult === "failed-before-start-push") {
      return { exitCode: 1, stderr: "provider validation stopped before start_push", stdout: "" };
    }
    const overlay = await readFile(join(request.cwd, "convex", "releaseAttestation.ts"), "utf8");
    const match = /Object\.freeze\((\{.*\}) as const\)/u.exec(overlay);
    if (match?.[1] === undefined) throw new Error("missing attestation overlay");
    runtime = JSON.parse(match[1]) as RuntimeReleaseAttestation;
    return { exitCode: 0, stderr: "", stdout: "deployed" };
  };

  return {
    get authorityReads() {
      return authorityReads;
    },
    get deploymentCalls() {
      return deploymentCalls;
    },
    get runtime() {
      return runtime;
    },
    evidenceDirectory,
    async deploy(options: Readonly<{
      evidenceName: string;
      now: number;
      phase: "bootstrap" | "candidate";
      previousEvidenceName?: string;
      providerResult?: "deployed" | "failed-before-start-push";
      revision: string;
      sourceCommit: string;
      target?: ConvexTarget;
    }>) {
      activeSourceCommit = options.sourceCommit;
      providerResult = options.providerResult ?? "deployed";
      return await deployHostedSync({
        evidencePath: join(evidenceDirectory, options.evidenceName),
        now: () => options.now,
        phase: options.phase,
        ...(options.previousEvidenceName === undefined
          ? {}
          : {
              previousDeployEvidencePath: join(
                evidenceDirectory,
                options.previousEvidenceName,
              ),
            }),
        readAttestation: async () => {
          authorityReads += 1;
          return runtime;
        },
        repositoryRoot,
        revision: () => options.revision,
        runner,
        sourceCommit: options.sourceCommit,
        target: options.target ?? target,
        temporaryRoot,
        verifyTarget: async () => undefined,
      });
    },
  };
};

describe("verified hosted deployment", () => {
  test("ships the Convex typecheck project required by the deploy gate", async () => {
    const configuration = JSON.parse(await readFile(
      join(import.meta.dir, "..", "convex", "tsconfig.json"),
      "utf8",
    )) as unknown;

    expect(configuration).toEqual({
      compilerOptions: {
        allowJs: true,
        allowImportingTsExtensions: true,
        allowSyntheticDefaultImports: true,
        exactOptionalPropertyTypes: true,
        forceConsistentCasingInFileNames: true,
        isolatedModules: true,
        jsx: "react-jsx",
        lib: ["ES2024", "DOM", "DOM.Iterable"],
        module: "ESNext",
        moduleDetection: "force",
        moduleResolution: "Bundler",
        noEmit: true,
        noFallthroughCasesInSwitch: true,
        noImplicitOverride: true,
        noUncheckedIndexedAccess: true,
        resolveJsonModule: true,
        skipLibCheck: true,
        strict: true,
        target: "ES2024",
        types: ["node"],
      },
      exclude: ["./_generated", "./**/*.test.ts", "./test.setup.ts"],
      include: ["./**/*.ts"],
    });
  });

  test("binds deploy to one exact generated target and clean source without inheriting stale selectors", async () => {
    const repositoryRoot = await makeTemporaryDirectory("hra-hosted-source-");
    const temporaryRoot = await makeTemporaryDirectory("oompa-hosted-binding-");
    await writeFile(
      join(repositoryRoot, ".env.local"),
      "CONVEX_DEPLOYMENT=prod:stale-beaver-999\n",
      "utf8",
    );
    const requests: CommandRequest[] = [];
    let bindingDocument = "";
    const runner: CommandRunner = async (request) => {
      requests.push(request);
      if (request.executable === "/usr/bin/git") {
        return request.arguments[0] === "rev-parse"
          ? { exitCode: 0, stderr: "", stdout: `${sourceCommit}\n` }
          : { exitCode: 0, stderr: "", stdout: "" };
      }
      const envFileIndex = request.arguments.indexOf("--env-file");
      const envFile = request.arguments[envFileIndex + 1];
      if (envFile === undefined) throw new Error("missing test env file");
      bindingDocument = await readFile(envFile, "utf8");
      return {
        exitCode: 0,
        stderr: "provider-stderr-sentinel",
        stdout: "provider-stdout-sentinel",
      };
    };
    const verified: ConvexTarget[] = [];
    const verifyTarget: ConvexTargetVerifier = async (value) => {
      verified.push(value);
    };
    const stdout: string[] = [];
    const stderr: string[] = [];
    const badKey = "hostile-deploy-key";

    const exitCode = await executeHostedDeploy({
      arguments: [...targetArguments, "--source-commit", sourceCommit],
      environment: {
        CONVEX_DEPLOYMENT: "prod:stale-beaver-999",
        CONVEX_DEPLOY_KEY: badKey,
        HOME: "/operator-home",
        PATH: "/safe/bin",
      },
      repositoryRoot,
      runner,
      stderr: outputWriter(stderr),
      stdout: outputWriter(stdout),
      temporaryRoot,
      verifyTarget,
    });

    expect(exitCode).toBe(0);
    expect(verified).toEqual([target, target]);
    expect(bindingDocument).toBe(`CONVEX_DEPLOYMENT=prod:${target.deploymentName}\n`);
    const deployRequest = requests.find((request) => request.executable !== "/usr/bin/git");
    if (deployRequest === undefined) throw new Error("missing deploy request");
    const bindingPath = deployRequest.arguments[3];
    if (bindingPath === undefined) throw new Error("missing deploy binding path");
    expect(deployRequest.arguments.slice(1)).toEqual([
      "deploy",
      "--env-file",
      bindingPath,
      "--yes",
      "--typecheck",
      "enable",
      "--codegen",
      "disable",
      "--cmd",
      resolvedTargetAssertionCommand,
      "--cmd-url-env-var-name",
      OOMPA_RESOLVED_CONVEX_DEPLOY_URL,
      "--skip-workos-check",
      "--message",
      `Oompa source ${sourceCommit}`,
    ]);
    expect(deployRequest.environment).toEqual({
      HOME: "/operator-home",
      [OOMPA_EXPECTED_CONVEX_DEPLOY_URL]: target.deploymentUrl,
      NO_COLOR: "1",
      PATH: "/safe/bin",
      TERM: "dumb",
    });
    expect(deployRequest.timeoutMs).toBe(600_000);
    expect(deployRequest.outputMaximumBytes).toBe(524_288);
    expect(requests.filter((request) => request.executable === "/usr/bin/git" || request.executable === "/usr/bin/tar")
      .every((request) => request.containment === "local")).toBe(true);
    expect(requests.filter((request) => request.executable !== "/usr/bin/git" && request.executable !== "/usr/bin/tar")
      .every((request) => request.containment === "authority")).toBe(true);
    expect(requests.filter((request) => request.executable === "/usr/bin/git")).toHaveLength(4);
    expect(await readdir(temporaryRoot)).toEqual([]);
    expect(stdout).toEqual([`Deployed exact source ${sourceCommit} to the verified target.\n`]);
    expect(stderr).toEqual([]);
    expect(JSON.stringify({ stderr, stdout })).not.toContain("provider-stdout-sentinel");
    expect(JSON.stringify({ stderr, stdout })).not.toContain("provider-stderr-sentinel");
  });

  test("the mandatory pre-push command refuses a deployment resolved after a default switch", () => {
    const environment = {
      [OOMPA_EXPECTED_CONVEX_DEPLOY_URL]: target.deploymentUrl,
      [OOMPA_RESOLVED_CONVEX_DEPLOY_URL]: "https://other-otter-999.convex.cloud",
    };
    expect(resolvedConvexDeployTargetMatches(environment)).toBeFalse();
    expect(resolvedTargetAssertionCommand).toContain("assert-convex-deploy-target.ts");
  });

  test("refuses an unavailable authority backend without postflight or cleanup-recovery output", async () => {
    const temporaryRoot = await makeTemporaryDirectory("oompa-hosted-authority-unavailable-");
    const stdout: string[] = [];
    const stderr: string[] = [];
    const requests: CommandRequest[] = [];
    let verifications = 0;
    expect(await executeHostedDeploy({
      arguments: [...targetArguments, "--source-commit", sourceCommit],
      repositoryRoot: "/repo",
      runner: async (request) => {
        requests.push(request);
        if (request.containment === "authority") {
          throw new BoundedProcessContainmentUnavailableError(
            "authority_backend_unavailable",
          );
        }
        return request.arguments[0] === "rev-parse"
          ? { exitCode: 0, stderr: "", stdout: `${sourceCommit}\n` }
          : { exitCode: 0, stderr: "", stdout: "" };
      },
      stderr: outputWriter(stderr),
      stdout: outputWriter(stdout),
      temporaryRoot,
      verifyTarget: async () => { verifications += 1; },
    })).toBe(1);
    expect(requests.some((request) => request.containment === "authority")).toBe(true);
    expect(verifications).toBe(1);
    expect(stdout).toEqual([]);
    expect(JSON.parse(stderr.join(""))).toEqual({
      code: "authority_containment_unavailable",
      reason: "authority_backend_unavailable",
      schemaVersion: 1,
      status: "refused",
    });
    expect(stderr.join("")).not.toContain("process_cleanup_unproven");
    expect(await readdir(temporaryRoot)).toEqual([]);
  });

  test("renders unproven deployment cleanup as a recovery-required temporary failure", async () => {
    const temporaryRoot = await makeTemporaryDirectory("oompa-hosted-cleanup-unproven-");
    const stdout: string[] = [];
    const stderr: string[] = [];
    let authorityCalls = 0;
    let verifications = 0;
    const recoveryPath = "/private/operator/process-recovery/local-deploy.json";
    const cleanup = new BoundedProcessCleanupUnprovenError(
      42_433,
      "convex-deploy",
    ).retainRecoveryPath(recoveryPath);
    expect(await executeHostedDeploy({
      arguments: [...targetArguments, "--source-commit", sourceCommit],
      repositoryRoot: "/repo",
      runner: async (request) => {
        if (request.containment === "authority") {
          authorityCalls += 1;
          throw cleanup;
        }
        return request.arguments[0] === "rev-parse"
          ? { exitCode: 0, stderr: "", stdout: `${sourceCommit}\n` }
          : { exitCode: 0, stderr: "", stdout: "" };
      },
      stderr: outputWriter(stderr),
      stdout: outputWriter(stdout),
      temporaryRoot,
      verifyTarget: async () => { verifications += 1; },
    })).toBe(75);
    expect(authorityCalls).toBe(1);
    expect(verifications).toBe(1);
    expect(stdout).toEqual([]);
    const preserved = await readdir(temporaryRoot);
    expect(preserved).toHaveLength(1);
    const bindingRecoveryPath = join(temporaryRoot, preserved[0] ?? "missing");
    expect(JSON.parse(stderr.join(""))).toEqual({
      code: "process_cleanup_unproven",
      phase: "convex-deploy",
      processGroupId: 42_433,
      processes: [{
        phase: "convex-deploy",
        recoveryIdentity: { containment: "local", processGroupId: 42_433 },
      }],
      recoveryPaths: [bindingRecoveryPath, recoveryPath].sort(),
      schemaVersion: 1,
      status: "recovery_required",
    });
  });

  test("preserves a blocked deployment recovery journal", async () => {
    const temporaryRoot = await makeTemporaryDirectory("oompa-hosted-journal-blocked-");
    const stdout: string[] = [];
    const stderr: string[] = [];
    let verifications = 0;
    const recoveryPath = "/private/operator/process-recovery/authority-deploy.json";
    expect(await executeHostedDeploy({
      arguments: [...targetArguments, "--source-commit", sourceCommit],
      repositoryRoot: "/repo",
      runner: async (request) => {
        if (request.containment === "authority") {
          throw new BoundedProcessRecoveryJournalError(
            [recoveryPath],
            "authority_recovery_required",
          );
        }
        return request.arguments[0] === "rev-parse"
          ? { exitCode: 0, stderr: "", stdout: `${sourceCommit}\n` }
          : { exitCode: 0, stderr: "", stdout: "" };
      },
      stderr: outputWriter(stderr),
      stdout: outputWriter(stdout),
      temporaryRoot,
      verifyTarget: async () => { verifications += 1; },
    })).toBe(75);
    expect(verifications).toBe(1);
    expect(stdout).toEqual([]);
    expect(JSON.parse(stderr.join(""))).toEqual({
      code: "process_recovery_journal_blocked",
      reason: "authority_recovery_required",
      recoveryPaths: [recoveryPath],
      schemaVersion: 1,
      status: "recovery_required",
    });
    expect(await readdir(temporaryRoot)).toEqual([]);
  });

  test("classifies later filesystem cleanup failures while preserving a blocked journal", async () => {
    for (const failedCleanup of ["binding", "source", "both"] as const) {
      const repositoryRoot = await makeTemporaryDirectory("oompa-hosted-journal-cleanup-source-");
      const temporaryRoot = await makeTemporaryDirectory("oompa-hosted-journal-cleanup-temp-");
      const evidenceDirectory = await realpath(
        await makeTemporaryDirectory("oompa-hosted-journal-cleanup-evidence-"),
      );
      await chmod(evidenceDirectory, 0o700);
      const evidencePath = join(evidenceDirectory, `bootstrap-${failedCleanup}.json`);
      const processRecoveryPath = `/private/operator/process-recovery/${failedCleanup}.json`;
      let archivedRoot = "";
      let bindingRoot = "";
      const stdout: string[] = [];
      const stderr: string[] = [];

      expect(await executeHostedDeploy({
        ...(failedCleanup === "source" || failedCleanup === "both"
          ? {
              archivedSourceRemover: async (path: string) => {
                archivedRoot = path;
                throw new Error("fixture source cleanup refusal");
              },
            }
          : {}),
        arguments: [
          ...targetArguments,
          "--source-commit",
          sourceCommit,
          "--phase",
          "bootstrap",
          "--evidence-path",
          evidencePath,
        ],
        ...(failedCleanup === "binding" || failedCleanup === "both"
          ? {
              deploymentBindingRemover: async (path: string) => {
                bindingRoot = path;
                throw new Error("fixture binding cleanup refusal");
              },
            }
          : {}),
        readAttestation: async () => null,
        repositoryRoot,
        runner: async (request) => {
          if (request.executable === "/usr/bin/git") {
            return request.arguments[0] === "rev-parse"
              ? { exitCode: 0, stderr: "", stdout: `${sourceCommit}\n` }
              : { exitCode: 0, stderr: "", stdout: "" };
          }
          if (request.executable === "/usr/bin/tar") {
            await materializeArchivedSource(request);
            return { exitCode: 0, stderr: "", stdout: "" };
          }
          if (request.phase === "source-dependency-install") {
            archivedRoot = join(request.cwd, "..");
            await materializeArchivedDependencies(request);
            return { exitCode: 0, stderr: "", stdout: "installed" };
          }
          if (request.containment === "authority") {
            throw new BoundedProcessRecoveryJournalError(
              [processRecoveryPath],
              "authority_recovery_required",
            );
          }
          return { exitCode: 0, stderr: "", stdout: "" };
        },
        stderr: outputWriter(stderr),
        stdout: outputWriter(stdout),
        temporaryRoot,
        verifyTarget: async () => undefined,
      })).toBe(75);

      expect(JSON.parse(stderr.join(""))).toEqual({
        code: failedCleanup === "binding"
          ? "deployment_binding_cleanup_failed"
          : "source_cleanup_failed",
        primaryCode: "process_recovery_journal_blocked",
        primaryReason: "authority_recovery_required",
        recoveryPaths: [
          evidencePath,
          `${evidencePath}.intent`,
          processRecoveryPath,
          ...(failedCleanup === "binding" || failedCleanup === "both" ? [bindingRoot] : []),
          ...(failedCleanup === "source" || failedCleanup === "both" ? [archivedRoot] : []),
        ].sort(),
        schemaVersion: 1,
        status: "recovery_required",
      });
      expect(stdout).toEqual([]);
      if (failedCleanup === "binding" || failedCleanup === "both") {
        expect(bindingRoot).toStartWith(temporaryRoot);
      }
      if (failedCleanup === "source" || failedCleanup === "both") {
        expect(archivedRoot).toStartWith(temporaryRoot);
        expect(await readdir(archivedRoot)).toContain("source");
      }
    }
  });

  test("surfaces a source archive root when local preparation cleanup is unproven", async () => {
    for (const failedExecutable of ["/usr/bin/git", "/usr/bin/tar", process.execPath] as const) {
      const repositoryRoot = await makeTemporaryDirectory("oompa-hosted-archive-terminal-source-");
      const temporaryRoot = await makeTemporaryDirectory("oompa-hosted-archive-terminal-temp-");
      const evidenceDirectory = await realpath(
        await makeTemporaryDirectory("oompa-hosted-archive-terminal-evidence-"),
      );
      await chmod(evidenceDirectory, 0o700);
      const evidencePath = join(evidenceDirectory, "bootstrap.json");
      const failedPhase = failedExecutable.endsWith("git")
        ? "git-source-read"
        : failedExecutable.endsWith("tar")
          ? "source-archive-extract"
          : "source-dependency-install";
      const processRecoveryPath = `/private/operator/process-recovery/${failedExecutable.endsWith("git") ? "git" : failedExecutable.endsWith("tar") ? "tar" : "install"}.json`;
      const cleanup = new BoundedProcessCleanupUnprovenError(
        failedExecutable.endsWith("git") ? 42_451 : failedExecutable.endsWith("tar") ? 42_452 : 42_454,
        failedPhase,
      ).retainRecoveryPath(processRecoveryPath);
      const requests: CommandRequest[] = [];
      let verifications = 0;

      await expect(deployHostedSync({
        evidencePath,
        phase: "bootstrap",
        readAttestation: async () => null,
        repositoryRoot,
        revision: () => "00000000-0000-4000-8000-000000000051",
        runner: async (request) => {
          requests.push(request);
          if (
            request.executable === failedExecutable
            && (
              failedExecutable === "/usr/bin/tar"
              || failedExecutable === process.execPath
              || request.arguments[0] === "archive"
            )
          ) throw cleanup;
          if (request.executable === "/usr/bin/tar") await materializeArchivedSource(request);
          return request.arguments[0] === "rev-parse"
            ? { exitCode: 0, stderr: "", stdout: `${sourceCommit}\n` }
            : { exitCode: 0, stderr: "", stdout: "" };
        },
        sourceCommit,
        target,
        temporaryRoot,
        verifyTarget: async () => { verifications += 1; },
      })).rejects.toBe(cleanup);

      const preserved = await readdir(temporaryRoot);
      expect(preserved).toHaveLength(1);
      const sourceRecoveryPath = join(temporaryRoot, preserved[0] ?? "missing");
      expect(cleanup.recoveryPaths).toEqual([
        evidencePath,
        `${evidencePath}.intent`,
        processRecoveryPath,
        sourceRecoveryPath,
      ].sort());
      expect(await readdir(evidenceDirectory)).toEqual(["bootstrap.json.intent"]);
      expect(verifications).toBe(1);
      expect(requests.at(-1)?.executable).toBe(failedExecutable);
      expect(requests.some((request) => request.containment === "authority")).toBe(false);
    }
  });

  test("refuses before provider execution when the archived frozen install fails", async () => {
    const repositoryRoot = await makeTemporaryDirectory("oompa-hosted-install-source-");
    const temporaryRoot = await makeTemporaryDirectory("oompa-hosted-install-temp-");
    const evidenceDirectory = await realpath(
      await makeTemporaryDirectory("oompa-hosted-install-evidence-"),
    );
    await chmod(evidenceDirectory, 0o700);
    const evidencePath = join(evidenceDirectory, "bootstrap.json");
    const requests: CommandRequest[] = [];

    await expect(deployHostedSync({
      environment: {
        CONVEX_DEPLOY_KEY: "hostile-key",
        HOME: "/operator-home",
        PATH: "/safe/bin",
      },
      evidencePath,
      phase: "bootstrap",
      readAttestation: async () => null,
      repositoryRoot,
      revision: () => "00000000-0000-4000-8000-000000000053",
      runner: async (request) => {
        requests.push(request);
        if (request.executable === "/usr/bin/git") {
          return request.arguments[0] === "rev-parse"
            ? { exitCode: 0, stderr: "", stdout: `${sourceCommit}\n` }
            : { exitCode: 0, stderr: "", stdout: "" };
        }
        if (request.executable === "/usr/bin/tar") {
          await materializeArchivedSource(request);
          return { exitCode: 0, stderr: "", stdout: "" };
        }
        if (request.phase === "source-dependency-install") {
          return {
            exitCode: 1,
            stderr: "hostile install failure",
            stdout: "hostile install output",
          };
        }
        throw new Error("provider execution was reachable after install failure");
      },
      sourceCommit,
      target,
      temporaryRoot,
      verifyTarget: async () => undefined,
    })).rejects.toThrow("source_dependency_install_failed");

    const archiveIndex = requests.findIndex((request) => request.arguments[0] === "archive");
    const extractIndex = requests.findIndex((request) => request.phase === "source-archive-extract");
    const installIndex = requests.findIndex((request) => request.phase === "source-dependency-install");
    expect(archiveIndex).toBeGreaterThanOrEqual(0);
    expect(extractIndex).toBeGreaterThan(archiveIndex);
    expect(installIndex).toBeGreaterThan(extractIndex);
    expect(requests.some((request) => request.containment === "authority")).toBeFalse();
    expect(requests[installIndex]).toMatchObject({
      arguments: [
        "install",
        "--frozen-lockfile",
        "--ignore-scripts",
        "--backend=copyfile",
      ],
      containment: "local",
      environment: {
        HOME: "/operator-home",
        [OOMPA_EXPECTED_CONVEX_DEPLOY_URL]: target.deploymentUrl,
        NO_COLOR: "1",
        PATH: "/safe/bin",
        TERM: "dumb",
      },
      executable: process.execPath,
      outputMaximumBytes: 524_288,
      phase: "source-dependency-install",
      stdin: "",
      timeoutMs: 600_000,
    });
    expect(requests[installIndex]?.cwd).toContain("hra-hosted-source-");
    expect(await readdir(temporaryRoot)).toEqual([]);
    expect(await readdir(evidenceDirectory)).toEqual(["bootstrap.json.intent"]);
  });

  test("surfaces the archived root when preparation cleanup fails with a primary error", async () => {
    const repositoryRoot = await makeTemporaryDirectory("oompa-hosted-preparation-cleanup-source-");
    const temporaryRoot = await makeTemporaryDirectory("oompa-hosted-preparation-cleanup-temp-");
    const evidenceDirectory = await realpath(
      await makeTemporaryDirectory("oompa-hosted-preparation-cleanup-evidence-"),
    );
    await chmod(evidenceDirectory, 0o700);
    const evidencePath = join(evidenceDirectory, "bootstrap.json");
    let archivedRoot = "";
    let providerCalls = 0;
    const stdout: string[] = [];
    const stderr: string[] = [];

    expect(await executeHostedDeploy({
      archivedSourceRemover: async (path) => {
        archivedRoot = path;
        throw new Error("fixture cleanup refusal");
      },
      arguments: [
        ...targetArguments,
        "--source-commit",
        sourceCommit,
        "--phase",
        "bootstrap",
        "--evidence-path",
        evidencePath,
      ],
      readAttestation: async () => null,
      repositoryRoot,
      runner: async (request) => {
        if (request.executable === "/usr/bin/git") {
          return request.arguments[0] === "rev-parse"
            ? { exitCode: 0, stderr: "", stdout: `${sourceCommit}\n` }
            : { exitCode: 0, stderr: "", stdout: "" };
        }
        if (request.executable === "/usr/bin/tar") {
          await materializeArchivedSource(request);
          return { exitCode: 0, stderr: "", stdout: "" };
        }
        if (request.phase === "source-dependency-install") {
          return { exitCode: 1, stderr: "install refused", stdout: "" };
        }
        providerCalls += 1;
        return { exitCode: 0, stderr: "", stdout: "" };
      },
      stderr: outputWriter(stderr),
      stdout: outputWriter(stdout),
      temporaryRoot,
      verifyTarget: async () => undefined,
    })).toBe(75);
    expect(providerCalls).toBe(0);
    expect(archivedRoot).toStartWith(temporaryRoot);
    expect(JSON.parse(stderr.join(""))).toEqual({
      code: "source_cleanup_failed",
      primaryCode: "source_dependency_install_failed",
      recoveryPaths: [evidencePath, `${evidencePath}.intent`, archivedRoot].sort(),
      schemaVersion: 1,
      status: "recovery_required",
    });
    expect(stderr.join("")).not.toContain("process_cleanup_unproven");
    expect(stdout).toEqual([]);
    expect(await readdir(archivedRoot)).toContain("source");
  });

  test("surfaces post-deploy archived cleanup failures with and without a primary error", async () => {
    for (const providerFails of [false, true]) {
      const repositoryRoot = await makeTemporaryDirectory("oompa-hosted-post-cleanup-source-");
      const temporaryRoot = await makeTemporaryDirectory("oompa-hosted-post-cleanup-temp-");
      const evidenceDirectory = await realpath(
        await makeTemporaryDirectory("oompa-hosted-post-cleanup-evidence-"),
      );
      await chmod(evidenceDirectory, 0o700);
      const evidencePath = join(evidenceDirectory, "bootstrap.json");
      let archivedRoot = "";
      let runtime: RuntimeReleaseAttestation | null = null;
      const stdout: string[] = [];
      const stderr: string[] = [];

      expect(await executeHostedDeploy({
        archivedSourceRemover: async (path) => {
          archivedRoot = path;
          throw new Error("fixture cleanup refusal");
        },
        arguments: [
          ...targetArguments,
          "--source-commit",
          sourceCommit,
          "--phase",
          "bootstrap",
          "--evidence-path",
          evidencePath,
        ],
        readAttestation: async () => runtime,
        repositoryRoot,
        runner: async (request) => {
          if (request.executable === "/usr/bin/git") {
            return request.arguments[0] === "rev-parse"
              ? { exitCode: 0, stderr: "", stdout: `${sourceCommit}\n` }
              : { exitCode: 0, stderr: "", stdout: "" };
          }
          if (request.executable === "/usr/bin/tar") {
            await materializeArchivedSource(request);
            return { exitCode: 0, stderr: "", stdout: "" };
          }
          if (request.phase === "source-dependency-install") {
            await materializeArchivedDependencies(request);
            return { exitCode: 0, stderr: "", stdout: "installed" };
          }
          if (providerFails) {
            return { exitCode: 1, stderr: "stopped before push", stdout: "" };
          }
          const overlay = await readFile(
            join(request.cwd, "convex", "releaseAttestation.ts"),
            "utf8",
          );
          const match = /Object\.freeze\((\{.*\}) as const\)/u.exec(overlay);
          if (match?.[1] === undefined) throw new Error("missing attestation overlay");
          runtime = JSON.parse(match[1]) as RuntimeReleaseAttestation;
          return { exitCode: 0, stderr: "", stdout: "deployed" };
        },
        stderr: outputWriter(stderr),
        stdout: outputWriter(stdout),
        temporaryRoot,
        verifyTarget: async () => undefined,
      })).toBe(75);
      expect(archivedRoot).toStartWith(temporaryRoot);
      expect(JSON.parse(stderr.join(""))).toEqual({
        code: "source_cleanup_failed",
        primaryCode: providerFails ? "convex_deploy_failed" : null,
        recoveryPaths: [evidencePath, `${evidencePath}.intent`, archivedRoot].sort(),
        schemaVersion: 1,
        status: "recovery_required",
      });
      expect(stderr.join("")).not.toContain("process_cleanup_unproven");
      expect(stdout).toEqual([]);
      expect(await readdir(archivedRoot)).toContain("source");
    }
  });

  test("composes binding and source cleanup roots without losing the primary failure", async () => {
    for (const scenario of ["success", "ordinary", "authority", "target"] as const) {
      const repositoryRoot = await makeTemporaryDirectory("oompa-hosted-cleanup-compose-source-");
      const temporaryRoot = await makeTemporaryDirectory("oompa-hosted-cleanup-compose-temp-");
      const evidenceDirectory = await realpath(
        await makeTemporaryDirectory("oompa-hosted-cleanup-compose-evidence-"),
      );
      await chmod(evidenceDirectory, 0o700);
      const evidencePath = join(evidenceDirectory, `bootstrap-${scenario}.json`);
      let runtime: RuntimeReleaseAttestation | null = null;
      let archivedRoot = "";
      let bindingRoot = "";
      let verifications = 0;
      const stdout: string[] = [];
      const stderr: string[] = [];

      expect(await executeHostedDeploy({
        ...(scenario === "ordinary"
          ? {
              archivedSourceRemover: async (path: string) => {
                archivedRoot = path;
                throw new Error("fixture source cleanup refusal");
              },
            }
          : {}),
        arguments: [
          ...targetArguments,
          "--source-commit",
          sourceCommit,
          "--phase",
          "bootstrap",
          "--evidence-path",
          evidencePath,
        ],
        deploymentBindingRemover: async (path) => {
          bindingRoot = path;
          throw new Error("fixture binding cleanup refusal");
        },
        readAttestation: async () => runtime,
        repositoryRoot,
        runner: async (request) => {
          if (request.executable === "/usr/bin/git") {
            return request.arguments[0] === "rev-parse"
              ? { exitCode: 0, stderr: "", stdout: `${sourceCommit}\n` }
              : { exitCode: 0, stderr: "", stdout: "" };
          }
          if (request.executable === "/usr/bin/tar") {
            await materializeArchivedSource(request);
            return { exitCode: 0, stderr: "", stdout: "" };
          }
          if (request.phase === "source-dependency-install") {
            archivedRoot = join(request.cwd, "..");
            await materializeArchivedDependencies(request);
            return { exitCode: 0, stderr: "", stdout: "installed" };
          }
          if (scenario === "authority") {
            throw new BoundedProcessContainmentUnavailableError(
              "authority_backend_unavailable",
            );
          }
          if (scenario === "ordinary") {
            return { exitCode: 1, stderr: "stopped", stdout: "" };
          }
          const overlay = await readFile(
            join(request.cwd, "convex", "releaseAttestation.ts"),
            "utf8",
          );
          const match = /Object\.freeze\((\{.*\}) as const\)/u.exec(overlay);
          if (match?.[1] === undefined) throw new Error("missing attestation overlay");
          runtime = JSON.parse(match[1]) as RuntimeReleaseAttestation;
          return { exitCode: 0, stderr: "", stdout: "deployed" };
        },
        stderr: outputWriter(stderr),
        stdout: outputWriter(stdout),
        temporaryRoot,
        verifyTarget: async () => {
          verifications += 1;
          if (scenario === "target" && verifications === 2) {
            throw new ConvexTargetError("target_mismatch");
          }
        },
      })).toBe(75);

      const expectedCode = scenario === "ordinary"
        ? "source_cleanup_failed"
        : "deployment_binding_cleanup_failed";
      const expectedPrimary = scenario === "ordinary"
        ? "convex_deploy_failed"
        : scenario === "authority"
          ? "authority_containment_unavailable"
          : scenario === "target"
            ? "convex_target_refused"
            : null;
      const expectedRecoveryPaths = [
        evidencePath,
        `${evidencePath}.intent`,
        bindingRoot,
        ...(scenario === "ordinary" ? [archivedRoot] : []),
      ].sort();
      expect(JSON.parse(stderr.join(""))).toEqual({
        code: expectedCode,
        primaryCode: expectedPrimary,
        ...(scenario === "authority"
          ? { primaryReason: "authority_backend_unavailable" }
          : {}),
        recoveryPaths: expectedRecoveryPaths,
        schemaVersion: 1,
        status: "recovery_required",
      });
      expect(bindingRoot).toStartWith(temporaryRoot);
      expect(stderr.join("")).not.toContain("process_cleanup_unproven");
      expect(stdout).toEqual([]);
      if (scenario === "ordinary") {
        expect(await readdir(archivedRoot)).toContain("source");
      }
    }
  });

  test("refuses symlink ancestors for the archived assertion and Convex CLI", async () => {
    for (const hostileAncestor of ["scripts", "convex-package"] as const) {
      const repositoryRoot = await makeTemporaryDirectory("oompa-hosted-symlink-source-");
      const temporaryRoot = await makeTemporaryDirectory("oompa-hosted-symlink-temp-");
      const evidenceDirectory = await realpath(
        await makeTemporaryDirectory("oompa-hosted-symlink-evidence-"),
      );
      const outside = await makeTemporaryDirectory("oompa-hosted-symlink-outside-");
      await chmod(evidenceDirectory, 0o700);
      const evidencePath = join(evidenceDirectory, `bootstrap-${hostileAncestor}.json`);
      let authorityCalls = 0;
      const requests: CommandRequest[] = [];

      await expect(deployHostedSync({
        evidencePath,
        phase: "bootstrap",
        readAttestation: async () => null,
        repositoryRoot,
        runner: async (request) => {
          requests.push(request);
          if (request.executable === "/usr/bin/git") {
            return request.arguments[0] === "rev-parse"
              ? { exitCode: 0, stderr: "", stdout: `${sourceCommit}\n` }
              : { exitCode: 0, stderr: "", stdout: "" };
          }
          if (request.executable === "/usr/bin/tar") {
            await materializeArchivedSource(request);
            if (hostileAncestor === "scripts") {
              const scriptsPath = join(request.arguments[3] ?? "", "scripts");
              await rm(scriptsPath, { force: true, recursive: true });
              await writeFile(
                join(outside, "assert-convex-deploy-target.ts"),
                "// outside assertion\n",
                "utf8",
              );
              await symlink(outside, scriptsPath, "dir");
            }
            return { exitCode: 0, stderr: "", stdout: "" };
          }
          if (request.phase === "source-dependency-install") {
            await materializeArchivedDependencies(request);
            if (hostileAncestor === "convex-package") {
              const convexPackagePath = join(request.cwd, "node_modules", "convex");
              await rm(convexPackagePath, { force: true, recursive: true });
              await mkdir(join(outside, "bin"), { recursive: true, mode: 0o700 });
              await writeFile(join(outside, "bin", "main.js"), "// outside CLI\n", "utf8");
              await symlink(outside, convexPackagePath, "dir");
            }
            return { exitCode: 0, stderr: "", stdout: "installed" };
          }
          authorityCalls += 1;
          return { exitCode: 0, stderr: "", stdout: "" };
        },
        sourceCommit,
        target,
        temporaryRoot,
        verifyTarget: async () => undefined,
      })).rejects.toThrow(
        hostileAncestor === "scripts" ? "source_changed" : "source_dependency_install_failed",
      );
      expect(authorityCalls).toBe(0);
      expect(requests.some((request) => request.containment === "authority")).toBeFalse();
      expect(await readdir(temporaryRoot)).toEqual([]);
    }
  });

  test("rechecks archived assertion and CLI identities immediately before authority launch", async () => {
    for (const substitutedPath of ["assertion", "cli"] as const) {
      const repositoryRoot = await makeTemporaryDirectory("oompa-hosted-substitution-source-");
      const temporaryRoot = await makeTemporaryDirectory("oompa-hosted-substitution-temp-");
      const evidenceDirectory = await realpath(
        await makeTemporaryDirectory("oompa-hosted-substitution-evidence-"),
      );
      await chmod(evidenceDirectory, 0o700);
      const evidencePath = join(evidenceDirectory, `bootstrap-${substitutedPath}.json`);
      let archivedSource = "";
      let authorityCalls = 0;
      let attestationReads = 0;

      await expect(deployHostedSync({
        evidencePath,
        phase: "bootstrap",
        readAttestation: async () => {
          attestationReads += 1;
          if (attestationReads === 2) {
            const path = substitutedPath === "assertion"
              ? join(archivedSource, "scripts", "assert-convex-deploy-target.ts")
              : join(archivedSource, "node_modules", "convex", "bin", "main.js");
            const replacementPath = `${path}.replacement`;
            await writeFile(replacementPath, `// substituted ${substitutedPath}\n`, "utf8");
            await rename(replacementPath, path);
          }
          return null;
        },
        repositoryRoot,
        runner: async (request) => {
          if (request.executable === "/usr/bin/git") {
            return request.arguments[0] === "rev-parse"
              ? { exitCode: 0, stderr: "", stdout: `${sourceCommit}\n` }
              : { exitCode: 0, stderr: "", stdout: "" };
          }
          if (request.executable === "/usr/bin/tar") {
            await materializeArchivedSource(request);
            return { exitCode: 0, stderr: "", stdout: "" };
          }
          if (request.phase === "source-dependency-install") {
            archivedSource = request.cwd;
            await materializeArchivedDependencies(request);
            return { exitCode: 0, stderr: "", stdout: "installed" };
          }
          authorityCalls += 1;
          return { exitCode: 0, stderr: "", stdout: "" };
        },
        sourceCommit,
        target,
        temporaryRoot,
        verifyTarget: async () => undefined,
      })).rejects.toThrow("source_changed");
      expect(attestationReads).toBe(2);
      expect(authorityCalls).toBe(0);
      expect(await readdir(temporaryRoot)).toEqual([]);
    }
  });

  test("supersedes a proven pre-mutation stop only through a fresh source path", async () => {
    const oldSourceCommit = "a".repeat(40);
    const fixedSourceCommit = "b".repeat(40);
    const repositoryRoot = await makeTemporaryDirectory("oompa-hosted-supersession-source-");
    const temporaryRoot = await makeTemporaryDirectory("oompa-hosted-supersession-temp-");
    const evidenceDirectory = await realpath(
      await makeTemporaryDirectory("oompa-hosted-supersession-evidence-"),
    );
    await chmod(evidenceDirectory, 0o700);
    const oldEvidencePath = join(evidenceDirectory, `bootstrap-${oldSourceCommit}.json`);
    const fixedEvidencePath = join(evidenceDirectory, `bootstrap-${fixedSourceCommit}.json`);
    let reportedHead = oldSourceCommit;
    let failBeforePush = true;
    let runtime: RuntimeReleaseAttestation | null = null;
    let providerCalls = 0;
    const verifiedTargets: ConvexTarget[] = [];
    const requests: CommandRequest[] = [];
    const runner: CommandRunner = async (request) => {
      requests.push(request);
      if (request.executable === "/usr/bin/git") {
        return request.arguments[0] === "rev-parse"
          ? { exitCode: 0, stderr: "", stdout: `${reportedHead}\n` }
          : { exitCode: 0, stderr: "", stdout: "" };
      }
      if (request.executable === "/usr/bin/tar") {
        await materializeArchivedSource(request);
        return { exitCode: 0, stderr: "", stdout: "" };
      }
      if (request.phase === "source-dependency-install") {
        await materializeArchivedDependencies(request);
        return { exitCode: 0, stderr: "", stdout: "installed" };
      }
      providerCalls += 1;
      if (failBeforePush) {
        return { exitCode: 1, stderr: "provider validation stopped before start_push", stdout: "" };
      }
      const overlay = await readFile(join(request.cwd, "convex", "releaseAttestation.ts"), "utf8");
      const match = /Object\.freeze\((\{.*\}) as const\)/u.exec(overlay);
      if (match?.[1] === undefined) throw new Error("missing attestation overlay");
      runtime = JSON.parse(match[1]) as RuntimeReleaseAttestation;
      return { exitCode: 0, stderr: "", stdout: "deployed" };
    };
    const readAttestation = async (): Promise<RuntimeReleaseAttestation | null> => runtime;

    await expect(deployHostedSync({
      evidencePath: oldEvidencePath,
      phase: "bootstrap",
      readAttestation,
      repositoryRoot,
      revision: () => "00000000-0000-4000-8000-000000000054",
      runner,
      sourceCommit: oldSourceCommit,
      target,
      temporaryRoot,
      verifyTarget: async (value) => { verifiedTargets.push(value); },
    })).rejects.toThrow("convex_deploy_failed");
    expect(providerCalls).toBe(1);
    expect(runtime).toBeNull();
    expect(verifiedTargets).toEqual([target, target]);
    const oldIntentDocument = await readFile(`${oldEvidencePath}.intent`, "utf8");

    reportedHead = fixedSourceCommit;
    failBeforePush = false;
    const fixed = await deployHostedSync({
      evidencePath: fixedEvidencePath,
      phase: "bootstrap",
      readAttestation,
      repositoryRoot,
      revision: () => "00000000-0000-4000-8000-000000000055",
      runner,
      sourceCommit: fixedSourceCommit,
      target,
      temporaryRoot,
      verifyTarget: async (value) => { verifiedTargets.push(value); },
    });
    expect(fixed?.sourceCommit).toBe(fixedSourceCommit);
    expect(providerCalls).toBe(2);
    expect((await readAttestation())?.runtimeSourceCommit).toBe(fixedSourceCommit);
    expect(await readFile(`${oldEvidencePath}.intent`, "utf8")).toBe(oldIntentDocument);
    expect(await Bun.file(oldEvidencePath).exists()).toBeFalse();

    reportedHead = oldSourceCommit;
    const requestCount = requests.length;
    await expect(deployHostedSync({
      evidencePath: oldEvidencePath,
      phase: "bootstrap",
      readAttestation,
      repositoryRoot,
      runner,
      sourceCommit: oldSourceCommit,
      target,
      temporaryRoot,
      verifyTarget: async (value) => { verifiedTargets.push(value); },
    })).rejects.toThrow("source_changed");
    expect(providerCalls).toBe(2);
    expect(requests.slice(requestCount).every(
      (request) => request.executable === "/usr/bin/git",
    )).toBeTrue();
    expect(await readFile(`${oldEvidencePath}.intent`, "utf8")).toBe(oldIntentDocument);
    expect(await readdir(temporaryRoot)).toEqual([]);
  });

  test("supersedes a proven pre-mutation candidate stop from the same live predecessor", async () => {
    const harness = await makeDeployEvidenceHarness();
    const oldSourceCommit = "b".repeat(40);
    const fixedSourceCommit = "c".repeat(40);
    const bootstrap = await harness.deploy({
      evidenceName: "bootstrap.json",
      now: 1_000,
      phase: "bootstrap",
      revision: "00000000-0000-4000-8000-000000000053",
      sourceCommit,
    });
    if (bootstrap === undefined) throw new Error("missing bootstrap evidence");
    const bootstrapDocument = await readFile(
      join(harness.evidenceDirectory, "bootstrap.json"),
      "utf8",
    );

    await expect(harness.deploy({
      evidenceName: `candidate-${oldSourceCommit}.json`,
      now: 2_000,
      phase: "candidate",
      previousEvidenceName: "bootstrap.json",
      providerResult: "failed-before-start-push",
      revision: "00000000-0000-4000-8000-000000000054",
      sourceCommit: oldSourceCommit,
    })).rejects.toThrow("convex_deploy_failed");
    const oldEvidencePath = join(
      harness.evidenceDirectory,
      `candidate-${oldSourceCommit}.json`,
    );
    const oldIntentDocument = await readFile(`${oldEvidencePath}.intent`, "utf8");
    expect(harness.runtime).toEqual(bootstrap.after);
    expect(harness.deploymentCalls).toBe(2);
    expect(await Bun.file(oldEvidencePath).exists()).toBeFalse();

    const fixed = await harness.deploy({
      evidenceName: `candidate-${fixedSourceCommit}.json`,
      now: 3_000,
      phase: "candidate",
      previousEvidenceName: "bootstrap.json",
      revision: "00000000-0000-4000-8000-000000000055",
      sourceCommit: fixedSourceCommit,
    });
    if (fixed === undefined) throw new Error("missing fixed candidate evidence");
    expect(fixed).toMatchObject({
      before: bootstrap.after,
      phase: "candidate",
      previousDeployDigest: bootstrap.selfDigest,
      sourceCommit: fixedSourceCommit,
    });
    expect(harness.runtime).toEqual(fixed.after);
    expect(harness.deploymentCalls).toBe(3);
    expect(await readFile(`${oldEvidencePath}.intent`, "utf8")).toBe(oldIntentDocument);
    expect(await readFile(join(harness.evidenceDirectory, "bootstrap.json"), "utf8"))
      .toBe(bootstrapDocument);

    await expect(harness.deploy({
      evidenceName: `candidate-${oldSourceCommit}.json`,
      now: 4_000,
      phase: "candidate",
      previousEvidenceName: "bootstrap.json",
      revision: "00000000-0000-4000-8000-000000000099",
      sourceCommit: oldSourceCommit,
    })).rejects.toThrow("source_changed");
    expect(harness.deploymentCalls).toBe(3);
    expect(await readFile(`${oldEvidencePath}.intent`, "utf8")).toBe(oldIntentDocument);
  });

  test("surfaces every preserved deploy root and durable intent without postflight", async () => {
    const repositoryRoot = await makeTemporaryDirectory("oompa-hosted-deploy-terminal-source-");
    const temporaryRoot = await makeTemporaryDirectory("oompa-hosted-deploy-terminal-temp-");
    const evidenceDirectory = await realpath(
      await makeTemporaryDirectory("oompa-hosted-deploy-terminal-evidence-"),
    );
    await chmod(evidenceDirectory, 0o700);
    const evidencePath = join(evidenceDirectory, "bootstrap.json");
    const processRecoveryPath = "/private/operator/process-recovery/provider-deploy.json";
    const cleanup = new BoundedProcessCleanupUnprovenError(
      42_453,
      "convex-deploy",
    ).retainRecoveryPath(processRecoveryPath);
    const requests: CommandRequest[] = [];
    let verifications = 0;
    let authorityCalls = 0;

    await expect(deployHostedSync({
      evidencePath,
      phase: "bootstrap",
      readAttestation: async () => null,
      repositoryRoot,
      revision: () => "00000000-0000-4000-8000-000000000052",
      runner: async (request) => {
        requests.push(request);
        if (request.executable === "/usr/bin/tar") {
          await materializeArchivedSource(request);
          return { exitCode: 0, stderr: "", stdout: "" };
        }
        if (request.phase === "source-dependency-install") {
          await materializeArchivedDependencies(request);
          return { exitCode: 0, stderr: "", stdout: "installed" };
        }
        if (request.containment === "authority") {
          authorityCalls += 1;
          throw cleanup;
        }
        return request.arguments[0] === "rev-parse"
          ? { exitCode: 0, stderr: "", stdout: `${sourceCommit}\n` }
          : { exitCode: 0, stderr: "", stdout: "" };
      },
      sourceCommit,
      target,
      temporaryRoot,
      verifyTarget: async () => { verifications += 1; },
    })).rejects.toBe(cleanup);

    const preserved = await readdir(temporaryRoot);
    expect(preserved).toHaveLength(2);
    expect(cleanup.recoveryPaths).toEqual([
      evidencePath,
      `${evidencePath}.intent`,
      processRecoveryPath,
      ...preserved.map((name) => join(temporaryRoot, name)),
    ].sort());
    expect(authorityCalls).toBe(1);
    expect(verifications).toBe(1);
    expect(requests.at(-1)?.phase).toBe("convex-deploy");
    expect(await readdir(evidenceDirectory)).toEqual(["bootstrap.json.intent"]);
  });

  test("refuses a dirty or wrong source before target verification or provider mutation", async () => {
    const requests: CommandRequest[] = [];
    let verifications = 0;
    const runner: CommandRunner = async (request) => {
      requests.push(request);
      if (request.arguments[0] === "rev-parse") {
        return { exitCode: 0, stderr: "", stdout: `${sourceCommit}\n` };
      }
      return { exitCode: 0, stderr: "", stdout: "?? hostile-untracked\n" };
    };

    await expect(deployHostedSync({
      repositoryRoot: "/repo",
      runner,
      sourceCommit,
      target,
      verifyTarget: async () => {
        verifications += 1;
      },
    })).rejects.toThrow("source_changed");
    expect(verifications).toBe(0);
    expect(requests).toHaveLength(2);
    expect(requests.every((request) => request.executable === "/usr/bin/git")).toBe(true);
  });

  test("always performs numeric postflight after an attempted deploy and suppresses failure output", async () => {
    const temporaryRoot = await makeTemporaryDirectory("oompa-hosted-failed-binding-");
    let verification = 0;
    const runner: CommandRunner = async (request) => {
      if (request.executable === "/usr/bin/git") {
        return request.arguments[0] === "rev-parse"
          ? { exitCode: 0, stderr: "", stdout: `${sourceCommit}\n` }
          : { exitCode: 0, stderr: "", stdout: "" };
      }
      return {
        exitCode: 1,
        stderr: "sensitive-provider-failure",
        stdout: "sensitive-provider-output",
      };
    };
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await executeHostedDeploy({
      arguments: [...targetArguments, "--source-commit", sourceCommit],
      repositoryRoot: "/repo",
      runner,
      stderr: outputWriter(stderr),
      stdout: outputWriter(stdout),
      temporaryRoot,
      verifyTarget: async () => {
        verification += 1;
      },
    });

    expect(exitCode).toBe(1);
    expect(verification).toBe(2);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual(["Hosted deploy refused (convex_deploy_failed).\n"]);
    expect(JSON.stringify({ stderr, stdout })).not.toContain("sensitive-provider");
    expect(await readdir(temporaryRoot)).toEqual([]);
  });

  test("requires an exact lowercase source commit and closed target arguments", () => {
    expect(parseDeployArguments([...targetArguments, "--source-commit", sourceCommit]))
      .toEqual({ sourceCommit, target });
    expect(() => parseDeployArguments([...targetArguments, "--source-commit", "HEAD"]))
      .toThrow("usage_invalid");
    expect(() => parseDeployArguments([
      ...targetArguments.slice(0, 3),
      String(OOMPA_CONVEX_TEAM_ID + 1),
      ...targetArguments.slice(4),
      "--source-commit",
      sourceCommit,
    ])).toThrow("usage_invalid");
    expect(() => parseDeployArguments([
      ...targetArguments,
      "--source-commit",
      sourceCommit,
      "--force",
    ])).toThrow("usage_invalid");
  });

  test("deploys a deterministic archive overlay, reconciles a lost result, and replays without mutation", async () => {
    const repositoryRoot = await makeTemporaryDirectory("oompa-hosted-evidence-source-");
    const temporaryRoot = await makeTemporaryDirectory("oompa-hosted-evidence-temp-");
    const evidenceDirectory = await realpath(
      await makeTemporaryDirectory("oompa-hosted-evidence-output-"),
    );
    await chmod(evidenceDirectory, 0o700);
    const evidencePath = join(evidenceDirectory, "bootstrap.json");
    const requests: CommandRequest[] = [];
    let runtime: RuntimeReleaseAttestation | null = null;
    let deploymentCalls = 0;
    const runner: CommandRunner = async (request) => {
      requests.push(request);
      if (request.executable === "/usr/bin/git") {
        if (request.arguments[0] === "rev-parse") {
          return { exitCode: 0, stderr: "", stdout: `${sourceCommit}\n` };
        }
        return { exitCode: 0, stderr: "", stdout: "" };
      }
      if (request.executable === "/usr/bin/tar") {
        await materializeArchivedSource(request);
        return { exitCode: 0, stderr: "", stdout: "" };
      }
      if (request.phase === "source-dependency-install") {
        await materializeArchivedDependencies(request);
        return { exitCode: 0, stderr: "", stdout: "installed" };
      }
      deploymentCalls += 1;
      const overlay = await readFile(join(request.cwd, "convex", "releaseAttestation.ts"), "utf8");
      const match = /Object\.freeze\((\{.*\}) as const\)/u.exec(overlay);
      if (match?.[1] === undefined) throw new Error("missing attestation overlay");
      runtime = JSON.parse(match[1]) as RuntimeReleaseAttestation;
      return { exitCode: 1, stderr: "lost provider response", stdout: "" };
    };
    const readAttestation = async (): Promise<RuntimeReleaseAttestation | null> => runtime;

    const first = await deployHostedSync({
      environment: { PATH: "/hostile/git-bin" },
      evidencePath,
      now: () => 1_000,
      phase: "bootstrap",
      readAttestation,
      repositoryRoot,
      revision: () => "00000000-0000-4000-8000-000000000010",
      runner,
      sourceCommit,
      target,
      temporaryRoot,
      verifyTarget: async () => undefined,
    });
    expect(first).toEqual(parseDeployEvidenceFile(evidencePath));
    expect(first).toMatchObject({
      after: {
        deployedAtMs: 1_000,
        runtimeRevision: "00000000-0000-4000-8000-000000000010",
        runtimeSourceCommit: sourceCommit,
      },
      before: null,
      phase: "bootstrap",
      sourceCommit,
    });
    expect(deploymentCalls).toBe(1);
    expect(requests.some((request) => request.arguments[0] === "archive")).toBe(true);
    expect(requests.find((request) => request.arguments[0] === "archive")).toMatchObject({
      environment: { PATH: "/hostile/git-bin" },
      executable: "/usr/bin/git",
    });
    const installRequest = requests.find(
      (request) => request.phase === "source-dependency-install",
    );
    const deployRequest = requests.find((request) => request.phase === "convex-deploy");
    if (installRequest === undefined || deployRequest === undefined) {
      throw new Error("missing archived install or deploy request");
    }
    expect(installRequest).toMatchObject({
      arguments: [
        "install",
        "--frozen-lockfile",
        "--ignore-scripts",
        "--backend=copyfile",
      ],
      containment: "local",
      environment: {
        [OOMPA_EXPECTED_CONVEX_DEPLOY_URL]: target.deploymentUrl,
        NO_COLOR: "1",
        PATH: "/hostile/git-bin",
        TERM: "dumb",
      },
      executable: process.execPath,
      outputMaximumBytes: 524_288,
      phase: "source-dependency-install",
      stdin: "",
      timeoutMs: 600_000,
    });
    expect(installRequest.cwd).toContain("hra-hosted-source-");
    expect(deployRequest.cwd).toBe(installRequest.cwd);
    expect(deployRequest.arguments[0]).toBe(
      join(installRequest.cwd, "node_modules", "convex", "bin", "main.js"),
    );
    expect(deployRequest.arguments[10]).toContain(
      join(installRequest.cwd, "scripts", "assert-convex-deploy-target.ts"),
    );
    expect(requests.indexOf(installRequest)).toBeLessThan(requests.indexOf(deployRequest));

    const requestCount = requests.length;
    const replay = await deployHostedSync({
      environment: { PATH: "/hostile/git-bin" },
      evidencePath,
      now: () => 2_000,
      phase: "bootstrap",
      readAttestation,
      repositoryRoot,
      revision: () => "00000000-0000-4000-8000-000000000099",
      runner,
      sourceCommit,
      target,
      temporaryRoot,
      verifyTarget: async () => undefined,
    });
    expect(replay?.selfDigest).toBe(first?.selfDigest);
    expect(deploymentCalls).toBe(1);
    expect(requests.slice(requestCount).every((request) => request.executable === "/usr/bin/git"))
      .toBe(true);
  });

  test("chains every later candidate from the immediately current candidate receipt", async () => {
    const harness = await makeDeployEvidenceHarness();
    const bootstrap = await harness.deploy({
      evidenceName: "bootstrap.json",
      now: 1_000,
      phase: "bootstrap",
      revision: "00000000-0000-4000-8000-000000000010",
      sourceCommit,
    });
    const firstCandidate = await harness.deploy({
      evidenceName: "candidate-one.json",
      now: 2_000,
      phase: "candidate",
      previousEvidenceName: "bootstrap.json",
      revision: "00000000-0000-4000-8000-000000000020",
      sourceCommit: "b".repeat(40),
    });
    const secondCandidate = await harness.deploy({
      evidenceName: "candidate-two.json",
      now: 3_000,
      phase: "candidate",
      previousEvidenceName: "candidate-one.json",
      revision: "00000000-0000-4000-8000-000000000030",
      sourceCommit: "c".repeat(40),
    });

    expect(bootstrap?.phase).toBe("bootstrap");
    expect(firstCandidate).toMatchObject({
      before: bootstrap?.after,
      phase: "candidate",
      previousDeployDigest: bootstrap?.selfDigest,
      sourceCommit: "b".repeat(40),
    });
    expect(secondCandidate).toMatchObject({
      before: firstCandidate?.after,
      phase: "candidate",
      previousDeployDigest: firstCandidate?.selfDigest,
      sourceCommit: "c".repeat(40),
    });
    expect(harness.deploymentCalls).toBe(3);
  });

  test("refuses a candidate predecessor receipt from another target before attestation read or mutation", async () => {
    const harness = await makeDeployEvidenceHarness();
    await harness.deploy({
      evidenceName: "bootstrap.json",
      now: 1_000,
      phase: "bootstrap",
      revision: "00000000-0000-4000-8000-000000000010",
      sourceCommit,
    });
    const authorityReads = harness.authorityReads;
    const deploymentCalls = harness.deploymentCalls;
    const otherTarget: ConvexTarget = {
      ...target,
      deploymentId: target.deploymentId + 1,
      deploymentName: "steady-otter-322",
      deploymentUrl: "https://steady-otter-322.convex.cloud",
    };

    await expect(harness.deploy({
      evidenceName: "wrong-target-candidate.json",
      now: 2_000,
      phase: "candidate",
      previousEvidenceName: "bootstrap.json",
      revision: "00000000-0000-4000-8000-000000000020",
      sourceCommit: "b".repeat(40),
      target: otherTarget,
    })).rejects.toThrow("source_changed");
    expect(harness.authorityReads).toBe(authorityReads);
    expect(harness.deploymentCalls).toBe(deploymentCalls);
    expect((await readdir(harness.evidenceDirectory)).sort()).toEqual([
      "bootstrap.json",
      "bootstrap.json.intent",
    ]);
  });

  test("refuses completed candidate evidence whose before state differs from its predecessor", async () => {
    const harness = await makeDeployEvidenceHarness();
    const bootstrap = await harness.deploy({
      evidenceName: "bootstrap.json",
      now: 1_000,
      phase: "bootstrap",
      revision: "00000000-0000-4000-8000-000000000010",
      sourceCommit,
    });
    const candidate = await harness.deploy({
      evidenceName: "candidate.json",
      now: 2_000,
      phase: "candidate",
      previousEvidenceName: "bootstrap.json",
      revision: "00000000-0000-4000-8000-000000000020",
      sourceCommit: "b".repeat(40),
    });
    if (bootstrap === undefined || candidate === undefined) {
      throw new Error("missing deployment evidence");
    }
    const { selfDigest: _selfDigest, ...candidateBody } = candidate;
    void _selfDigest;
    const malformed = deployEvidenceSchema.parse(withSelfDigest({
      ...candidateBody,
      before: {
        ...bootstrap.after,
        deployedAtMs: bootstrap.after.deployedAtMs + 1,
      },
    }));
    writeProtectedJsonNoReplace(
      join(harness.evidenceDirectory, "malformed-candidate.json"),
      malformed,
      deployEvidenceSchema,
    );
    const deploymentCalls = harness.deploymentCalls;

    await expect(harness.deploy({
      evidenceName: "malformed-candidate.json",
      now: 3_000,
      phase: "candidate",
      previousEvidenceName: "bootstrap.json",
      revision: "00000000-0000-4000-8000-000000000030",
      sourceCommit: "b".repeat(40),
    })).rejects.toThrow("source_changed");
    expect(harness.deploymentCalls).toBe(deploymentCalls);
  });

  test("reconciles a committed bootstrap intent across invocations without redeploying", async () => {
    const repositoryRoot = await makeTemporaryDirectory("oompa-hosted-crash-source-");
    const temporaryRoot = await makeTemporaryDirectory("oompa-hosted-crash-temp-");
    const evidenceDirectory = await realpath(
      await makeTemporaryDirectory("oompa-hosted-crash-output-"),
    );
    await chmod(evidenceDirectory, 0o700);
    const evidencePath = join(evidenceDirectory, "bootstrap.json");
    let runtime: RuntimeReleaseAttestation | null = null;
    let deploymentCalls = 0;
    let authorityReads = 0;
    const runner: CommandRunner = async (request) => {
      if (request.executable === "/usr/bin/git") {
        return request.arguments[0] === "rev-parse"
          ? { exitCode: 0, stderr: "", stdout: `${sourceCommit}\n` }
          : { exitCode: 0, stderr: "", stdout: "" };
      }
      if (request.executable === "/usr/bin/tar") {
        await materializeArchivedSource(request);
        return { exitCode: 0, stderr: "", stdout: "" };
      }
      if (request.phase === "source-dependency-install") {
        await materializeArchivedDependencies(request);
        return { exitCode: 0, stderr: "", stdout: "installed" };
      }
      deploymentCalls += 1;
      const overlay = await readFile(join(request.cwd, "convex", "releaseAttestation.ts"), "utf8");
      const match = /Object\.freeze\((\{.*\}) as const\)/u.exec(overlay);
      if (match?.[1] === undefined) throw new Error("missing attestation overlay");
      runtime = JSON.parse(match[1]) as RuntimeReleaseAttestation;
      return { exitCode: 0, stderr: "", stdout: "deployed" };
    };
    const readAttestation = async (): Promise<RuntimeReleaseAttestation | null> => {
      authorityReads += 1;
      if (authorityReads === 3) throw new Error("lost post-deploy authority read");
      return runtime;
    };

    await expect(deployHostedSync({
      evidencePath,
      now: () => 4_000,
      phase: "bootstrap",
      readAttestation,
      repositoryRoot,
      revision: () => "00000000-0000-4000-8000-000000000040",
      runner,
      sourceCommit,
      target,
      temporaryRoot,
      verifyTarget: async () => undefined,
    })).rejects.toThrow("lost post-deploy authority read");
    expect(await readdir(evidenceDirectory)).toEqual(["bootstrap.json.intent"]);
    expect(deploymentCalls).toBe(1);

    const reconciled = await deployHostedSync({
      evidencePath,
      now: () => 9_000,
      phase: "bootstrap",
      readAttestation,
      repositoryRoot,
      revision: () => "00000000-0000-4000-8000-000000000099",
      runner,
      sourceCommit,
      target,
      temporaryRoot,
      verifyTarget: async () => undefined,
    });
    expect(reconciled).toEqual(parseDeployEvidenceFile(evidencePath));
    expect(reconciled?.after.runtimeRevision)
      .toBe("00000000-0000-4000-8000-000000000040");
    expect(deploymentCalls).toBe(1);
  });

  test("does not reserve a bootstrap intent for a foreign committed runtime", async () => {
    const repositoryRoot = await makeTemporaryDirectory("oompa-hosted-foreign-source-");
    const evidenceDirectory = await realpath(
      await makeTemporaryDirectory("oompa-hosted-foreign-output-"),
    );
    await chmod(evidenceDirectory, 0o700);
    const evidencePath = join(evidenceDirectory, "bootstrap.json");
    let deploymentCalls = 0;
    const foreignRuntime: RuntimeReleaseAttestation = {
      bound: true,
      deployedAtMs: 1,
      previousDeployDigest: null,
      runtimeRevision: "00000000-0000-4000-8000-000000000001",
      runtimeSourceCommit: "b".repeat(40),
      schemaIdentity: "hra-release-attestation-v1",
      schemaVersion: 1,
    };
    const runner: CommandRunner = async (request) => {
      if (request.executable !== "/usr/bin/git") deploymentCalls += 1;
      return request.arguments[0] === "rev-parse"
        ? { exitCode: 0, stderr: "", stdout: `${sourceCommit}\n` }
        : { exitCode: 0, stderr: "", stdout: "" };
    };

    await expect(deployHostedSync({
      evidencePath,
      phase: "bootstrap",
      readAttestation: async () => foreignRuntime,
      repositoryRoot,
      runner,
      sourceCommit,
      target,
      verifyTarget: async () => undefined,
    })).rejects.toThrow("source_changed");
    expect(await readdir(evidenceDirectory)).toEqual([]);
    expect(deploymentCalls).toBe(0);
  });

  test("refuses an ambiguous bootstrap attestation pre-read before archive or provider mutation", async () => {
    const repositoryRoot = await makeTemporaryDirectory("oompa-hosted-preread-source-");
    const evidenceDirectory = await realpath(
      await makeTemporaryDirectory("oompa-hosted-preread-output-"),
    );
    await chmod(evidenceDirectory, 0o700);
    const requests: CommandRequest[] = [];
    let authoritySignal: AbortSignal | undefined;
    const authorityFetch = Object.assign((
      _input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ): Promise<Response> => {
      authoritySignal = init?.signal ?? undefined;
      return new Promise(() => undefined);
    }, { preconnect: () => undefined }) as typeof fetch;
    const runner: CommandRunner = async (request) => {
      requests.push(request);
      if (request.executable !== "/usr/bin/git") throw new Error("unexpected mutation");
      return request.arguments[0] === "rev-parse"
        ? { exitCode: 0, stderr: "", stdout: `${sourceCommit}\n` }
        : { exitCode: 0, stderr: "", stdout: "" };
    };

    const startedAt = performance.now();
    await expect(deployHostedSync({
      authorityFetch,
      authorityTimeoutMs: 10,
      evidencePath: join(evidenceDirectory, "bootstrap.json"),
      phase: "bootstrap",
      repositoryRoot,
      runner,
      sourceCommit,
      target,
      verifyTarget: async () => undefined,
    })).rejects.toThrow("convex_deploy_failed");
    expect(performance.now() - startedAt).toBeLessThan(500);
    expect(authoritySignal?.aborted).toBeTrue();
    expect(requests.every((request) => request.executable === "/usr/bin/git")).toBe(true);
    expect(requests.some((request) => request.arguments[0] === "archive")).toBe(false);
  });

  test("refuses an invalid existing evidence destination before archive or deployment", async () => {
    const repositoryRoot = await makeTemporaryDirectory("oompa-hosted-invalid-evidence-source-");
    const evidenceDirectory = await realpath(
      await makeTemporaryDirectory("oompa-hosted-invalid-evidence-output-"),
    );
    await chmod(evidenceDirectory, 0o700);
    const evidencePath = join(evidenceDirectory, "bootstrap.json");
    await writeFile(evidencePath, "{}\n", { mode: 0o644 });
    await chmod(evidencePath, 0o644);
    const requests: CommandRequest[] = [];
    let authorityReads = 0;
    const runner: CommandRunner = async (request) => {
      requests.push(request);
      if (request.executable !== "/usr/bin/git") {
        return { exitCode: 0, stderr: "", stdout: "" };
      }
      return request.arguments[0] === "rev-parse"
        ? { exitCode: 0, stderr: "", stdout: `${sourceCommit}\n` }
        : { exitCode: 0, stderr: "", stdout: "" };
    };

    await expect(deployHostedSync({
      evidencePath,
      phase: "bootstrap",
      readAttestation: async () => {
        authorityReads += 1;
        return null;
      },
      repositoryRoot,
      runner,
      sourceCommit,
      target,
      verifyTarget: async () => undefined,
    })).rejects.toThrow("evidence_file_invalid");
    expect(authorityReads).toBe(0);
    expect(requests.every((request) => request.executable === "/usr/bin/git")).toBeTrue();
    expect(requests.some((request) => request.arguments[0] === "archive")).toBeFalse();
  });
});
