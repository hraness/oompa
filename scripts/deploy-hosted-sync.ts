import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";

import { createBoundedAuthorityFetch } from "./bounded-authority-fetch";
import {
  isBoundedProcessCleanupUnprovenError,
  isBoundedProcessRecoveryJournalError,
  recoverBoundedProcessJournal,
  retainBoundedProcessRecoveryPath,
} from "./bounded-process";
import {
  isAuthorityContainmentUnavailable,
  renderAuthorityContainmentUnavailable,
  rethrowAuthorityContainmentUnavailable,
} from "./authority-containment";
import {
  buildConvexChildEnvironment,
  runCommand,
  type CommandRequest,
  type CommandResult,
  type CommandRunner,
} from "./configure-hosted-sync";
import {
  OOMPA_EXPECTED_CONVEX_DEPLOY_URL,
  OOMPA_RESOLVED_CONVEX_DEPLOY_URL,
} from "./assert-convex-deploy-target";
import {
  ConvexTargetError,
  parseConvexTarget,
  parseConvexTargetArguments,
  verifyConvexDefaultTarget,
  type ConvexTarget,
  type ConvexTargetVerifier,
} from "./convex-target";
import {
  canonicalDigest,
  deployEvidenceSchema,
  deployIntentSchema,
  parseDeployEvidenceFile,
  readProtectedJson,
  runtimeReleaseAttestationSchema,
  unboundRuntimeReleaseAttestationSchema,
  withSelfDigest,
  writeProtectedJsonNoReplace,
  type DeployEvidence,
  type DeployIntent,
  type RuntimeReleaseAttestation,
} from "./release-evidence";

const convexDeployOutputMaximumBytes = 512 * 1024;
const convexDeployTimeoutMs = 10 * 60 * 1_000;
const convexAuthorityTimeoutMs = 30_000;
const archivedDependencyOutputMaximumBytes = 512 * 1024;
const archivedDependencyTimeoutMs = 10 * 60 * 1_000;
const gitOutputMaximumBytes = 64 * 1024;
const sourceCommitPattern = /^[0-9a-f]{40}$/u;

type HostedDeployFailureCode =
  | "convex_deploy_failed"
  | "convex_target_refused"
  | "process_cleanup_unproven"
  | "source_dependency_install_failed"
  | "source_changed"
  | "target_file_refused"
  | "usage_invalid";

class HostedDeployError extends Error {
  readonly code: HostedDeployFailureCode;

  constructor(code: HostedDeployFailureCode) {
    super(code);
    this.name = "HostedDeployError";
    this.code = code;
  }
}

type HostedDeployFilesystemCleanupCode =
  | "deployment_binding_cleanup_failed"
  | "source_cleanup_failed";

type HostedDeployPrimaryFailureCode =
  | HostedDeployFailureCode
  | "authority_containment_unavailable"
  | "process_recovery_journal_blocked";

export class HostedDeployFilesystemCleanupError extends Error {
  readonly code: HostedDeployFilesystemCleanupCode;
  readonly primaryCode: HostedDeployPrimaryFailureCode | null;
  readonly primaryReason?: string;
  readonly recoveryPaths: readonly string[];

  constructor(
    code: HostedDeployFilesystemCleanupCode,
    recoveryPaths: readonly string[],
    primaryCode: HostedDeployPrimaryFailureCode | null,
    primaryReason?: string,
  ) {
    super(code);
    this.name = "HostedDeployFilesystemCleanupError";
    this.code = code;
    this.primaryCode = primaryCode;
    if (primaryReason !== undefined) this.primaryReason = primaryReason;
    this.recoveryPaths = [...new Set(recoveryPaths)].sort();
  }

  withRecoveryPaths(paths: readonly string[]): HostedDeployFilesystemCleanupError {
    return new HostedDeployFilesystemCleanupError(
      this.code,
      [...this.recoveryPaths, ...paths],
      this.primaryCode,
      this.primaryReason,
    );
  }
}

const primaryFailure = (
  primary: unknown,
): Readonly<{
  code: HostedDeployPrimaryFailureCode | null;
  reason?: string;
}> => {
  if (primary instanceof HostedDeployFilesystemCleanupError) {
    return {
      code: primary.primaryCode,
      ...(primary.primaryReason === undefined ? {} : { reason: primary.primaryReason }),
    };
  }
  if (primary instanceof HostedDeployError) return { code: primary.code };
  if (primary instanceof ConvexTargetError) return { code: "convex_target_refused" };
  if (isBoundedProcessRecoveryJournalError(primary)) {
    return { code: "process_recovery_journal_blocked", reason: primary.reason };
  }
  if (isAuthorityContainmentUnavailable(primary)) {
    return { code: "authority_containment_unavailable", reason: primary.reason };
  }
  return { code: primary === undefined ? null : "convex_deploy_failed" };
};

const retainFailedFilesystemCleanup = (
  kind: "binding" | "source",
  primary: unknown,
  recoveryPath: string,
): Error => {
  if (isBoundedProcessCleanupUnprovenError(primary)) {
    return primary.retainRecoveryPath(recoveryPath);
  }
  const priorPaths = primary instanceof HostedDeployFilesystemCleanupError
    ? primary.recoveryPaths
    : isBoundedProcessRecoveryJournalError(primary)
      ? primary.recoveryPaths
      : [];
  const prior = primaryFailure(primary);
  return new HostedDeployFilesystemCleanupError(
    kind === "source" ? "source_cleanup_failed" : "deployment_binding_cleanup_failed",
    [...priorPaths, recoveryPath],
    prior.code,
    prior.reason,
  );
};

const retainHostedDeployRecoveryPaths = (
  error: unknown,
  paths: readonly string[],
): unknown => {
  let retained = error;
  for (const path of paths) retained = retainBoundedProcessRecoveryPath(retained, path);
  if (retained instanceof HostedDeployFilesystemCleanupError) {
    return retained.withRecoveryPaths(paths);
  }
  return retained;
};

type DeployArguments = Readonly<{
  evidencePath?: string;
  phase?: "bootstrap" | "candidate";
  previousDeployEvidencePath?: string;
  sourceCommit: string;
  target: ConvexTarget;
}>;

export function parseDeployArguments(arguments_: readonly string[]): DeployArguments {
  let parsedTarget: ReturnType<typeof parseConvexTargetArguments>;
  try {
    parsedTarget = parseConvexTargetArguments(arguments_);
  } catch {
    throw new HostedDeployError("usage_invalid");
  }
  let sourceCommit: string | undefined;
  let evidencePath: string | undefined;
  let phase: "bootstrap" | "candidate" | undefined;
  let previousDeployEvidencePath: string | undefined;
  for (let index = 0; index < parsedTarget.otherArguments.length; index += 1) {
    const argument = parsedTarget.otherArguments[index];
    if (argument === "--source-commit" && sourceCommit === undefined) {
      const value = parsedTarget.otherArguments[index + 1];
      if (value === undefined || !sourceCommitPattern.test(value)) {
        throw new HostedDeployError("usage_invalid");
      }
      sourceCommit = value;
      index += 1;
      continue;
    }
    if (argument === "--evidence-path" && evidencePath === undefined) {
      const value = parsedTarget.otherArguments[index + 1];
      if (value === undefined || !value.startsWith("/") || value.length > 4_096) {
        throw new HostedDeployError("usage_invalid");
      }
      evidencePath = value;
      index += 1;
      continue;
    }
    if (argument === "--phase" && phase === undefined) {
      const value = parsedTarget.otherArguments[index + 1];
      if (value !== "bootstrap" && value !== "candidate") {
        throw new HostedDeployError("usage_invalid");
      }
      phase = value;
      index += 1;
      continue;
    }
    if (argument === "--previous-deploy-evidence" && previousDeployEvidencePath === undefined) {
      const value = parsedTarget.otherArguments[index + 1];
      if (value === undefined || !value.startsWith("/") || value.length > 4_096) {
        throw new HostedDeployError("usage_invalid");
      }
      previousDeployEvidencePath = value;
      index += 1;
      continue;
    }
    throw new HostedDeployError("usage_invalid");
  }
  if (sourceCommit === undefined) throw new HostedDeployError("usage_invalid");
  const evidenceConfigured = evidencePath !== undefined
    || phase !== undefined
    || previousDeployEvidencePath !== undefined;
  if (
    evidenceConfigured
    && (
      evidencePath === undefined
      || phase === undefined
      || (phase === "bootstrap" && previousDeployEvidencePath !== undefined)
      || (phase === "candidate" && previousDeployEvidencePath === undefined)
    )
  ) throw new HostedDeployError("usage_invalid");
  return {
    ...(evidencePath === undefined ? {} : { evidencePath }),
    ...(phase === undefined ? {} : { phase }),
    ...(previousDeployEvidencePath === undefined ? {} : { previousDeployEvidencePath }),
    sourceCommit,
    target: parsedTarget.target,
  };
}

const defaultRepositoryRoot = resolve(import.meta.dir, "..");
const convexCli = resolve(defaultRepositoryRoot, "node_modules", "convex", "bin", "main.js");
const resolvedTargetAssertion = resolve(import.meta.dir, "assert-convex-deploy-target.ts");
const releaseAttestationFunction = makeFunctionReference<"query", Record<string, never>, unknown>(
  "releaseAttestation:read",
);

const shellQuote = (value: string): string =>
  `'${value.replaceAll("'", `'"'"'`)}'`;

export const resolvedTargetAssertionCommand = [
  shellQuote(process.execPath),
  shellQuote(resolvedTargetAssertion),
].join(" ");

export const hostedOperationConvexCliPath = (sourceRoot: string): string =>
  resolve(sourceRoot, "node_modules", "convex", "bin", "main.js");

const archivedConvexCli = hostedOperationConvexCliPath;

const archivedTargetAssertionCommand = (sourceRoot: string): string => [
  shellQuote(process.execPath),
  shellQuote(resolve(sourceRoot, "scripts", "assert-convex-deploy-target.ts")),
].join(" ");

const invokeGit = async (
  runner: CommandRunner,
  repositoryRoot: string,
  environment: Readonly<Record<string, string>>,
  arguments_: readonly string[],
): Promise<CommandResult> => await runner({
  arguments: arguments_,
  containment: "local",
  cwd: repositoryRoot,
  environment,
  executable: "/usr/bin/git",
  outputMaximumBytes: gitOutputMaximumBytes,
  phase: "git-source-read",
  stdin: "",
  timeoutMs: 60_000,
});

const requireExactSource = async (
  runner: CommandRunner,
  repositoryRoot: string,
  environment: Readonly<Record<string, string>>,
  sourceCommit: string,
): Promise<void> => {
  const head = await invokeGit(
    runner,
    repositoryRoot,
    environment,
    ["rev-parse", "--verify", "HEAD"],
  );
  if (
    head.exitCode !== 0
    || head.stdout !== `${sourceCommit}\n`
  ) throw new HostedDeployError("source_changed");
  const status = await invokeGit(
    runner,
    repositoryRoot,
    environment,
    ["status", "--porcelain=v1", "--untracked-files=all"],
  );
  if (status.exitCode !== 0 || status.stdout !== "") {
    throw new HostedDeployError("source_changed");
  }
};

type DeploymentBinding = Readonly<{
  cleanup: () => Promise<void>;
  path: string;
  recoveryPath: string;
}>;

type TemporaryTreeRemover = (
  path: string,
  options: Readonly<{ force: boolean }>,
) => Promise<void>;

type ArchivedPathIdentity = Readonly<{
  dev: number;
  ino: number;
  kind: "directory" | "file";
  nlink: number;
  path: string;
}>;

type ArchivedSourceBinding = DeploymentBinding & Readonly<{
  revalidate: () => Promise<void>;
}>;

export type HostedOperationSourceBinding = ArchivedSourceBinding;

const removeTemporaryTree: TemporaryTreeRemover = async (path, options) => {
  await rm(path, { force: options.force, recursive: true });
};

const captureArchivedPathIdentity = async (
  path: string,
  kind: ArchivedPathIdentity["kind"],
  failureCode: "source_changed" | "source_dependency_install_failed",
): Promise<ArchivedPathIdentity> => {
  try {
    const identity = await lstat(path);
    if (
      (kind === "directory" ? !identity.isDirectory() : !identity.isFile())
      || !Number.isSafeInteger(identity.dev)
      || !Number.isSafeInteger(identity.ino)
      || !Number.isSafeInteger(identity.nlink)
      || identity.nlink < 1
      || (kind === "file" && identity.nlink !== 1)
    ) throw new HostedDeployError(failureCode);
    return {
      dev: identity.dev,
      ino: identity.ino,
      kind,
      nlink: identity.nlink,
      path,
    };
  } catch (error: unknown) {
    if (error instanceof HostedDeployError) throw error;
    throw new HostedDeployError(failureCode);
  }
};

const captureArchivedPathIdentities = async (
  paths: readonly Readonly<{ kind: ArchivedPathIdentity["kind"]; path: string }>[],
  failureCode: "source_changed" | "source_dependency_install_failed",
): Promise<readonly ArchivedPathIdentity[]> => await Promise.all(
  paths.map(async ({ kind, path }) => await captureArchivedPathIdentity(path, kind, failureCode)),
);

const revalidateArchivedPathIdentities = async (
  expected: readonly ArchivedPathIdentity[],
  allowedLinkCountChanges: ReadonlySet<string> = new Set(),
): Promise<void> => {
  const observed = await captureArchivedPathIdentities(expected, "source_changed");
  if (observed.some((identity, index) => {
    const prior = expected[index];
    return prior === undefined
      || identity.dev !== prior.dev
      || identity.ino !== prior.ino
      || identity.kind !== prior.kind
      || (
        identity.nlink !== prior.nlink
        && !allowedLinkCountChanges.has(identity.path)
      )
      || identity.path !== prior.path;
  })) throw new HostedDeployError("source_changed");
};

const closeQuietly = async (handle: FileHandle): Promise<void> => {
  await handle.close().catch(() => undefined);
};

async function createDeploymentBinding(
  deploymentName: string,
  temporaryRoot = tmpdir(),
  removeBinding: TemporaryTreeRemover = removeTemporaryTree,
): Promise<DeploymentBinding> {
  let directory: string;
  try {
    directory = await mkdtemp(join(temporaryRoot, "oompa-hosted-deploy-"));
  } catch {
    throw new HostedDeployError("target_file_refused");
  }
  const path = join(directory, "convex-target.env");
  let handle: FileHandle;
  try {
    handle = await open(
      path,
      constants.O_CREAT
        | constants.O_EXCL
        | constants.O_WRONLY
        | constants.O_NOFOLLOW,
      0o600,
    );
  } catch {
    const primary = new HostedDeployError("target_file_refused");
    try {
      await removeBinding(directory, { force: true });
    } catch {
      throw retainFailedFilesystemCleanup("binding", primary, directory);
    }
    throw primary;
  }
  try {
    await handle.writeFile(`CONVEX_DEPLOYMENT=prod:${deploymentName}\n`, "utf8");
    await handle.sync();
    const identity = await handle.stat();
    const current = await lstat(path);
    if (
      !identity.isFile()
      || identity.nlink !== 1
      || (identity.mode & 0o777) !== 0o600
      || !current.isFile()
      || current.dev !== identity.dev
      || current.ino !== identity.ino
      || current.nlink !== 1
      || (current.mode & 0o777) !== 0o600
    ) throw new HostedDeployError("target_file_refused");
  } catch {
    await closeQuietly(handle);
    const primary = new HostedDeployError("target_file_refused");
    try {
      await removeBinding(directory, { force: true });
    } catch {
      throw retainFailedFilesystemCleanup("binding", primary, directory);
    }
    throw primary;
  }
  await closeQuietly(handle);
  let cleaned = false;
  return {
    async cleanup() {
      if (cleaned) return;
      cleaned = true;
      try {
        await removeBinding(directory, { force: false });
      } catch {
        throw new HostedDeployError("target_file_refused");
      }
    },
    path,
    recoveryPath: directory,
  };
}

export type ReleaseAttestationReader = (
  target: ConvexTarget,
) => Promise<RuntimeReleaseAttestation | null>;

const runtimeReleaseAttestationReader = (
  fetcher: typeof fetch,
  timeoutMs: number,
): ReleaseAttestationReader => async (target) => {
  const client = new ConvexHttpClient(target.deploymentUrl, {
    fetch: createBoundedAuthorityFetch(fetcher, timeoutMs, "convex_authority_timeout"),
    logger: false,
  });
  let value: unknown;
  try {
    value = await client.query(releaseAttestationFunction, {});
  } catch {
    throw new HostedDeployError("convex_deploy_failed");
  }
  const bound = runtimeReleaseAttestationSchema.safeParse(value);
  if (bound.success) return bound.data;
  if (unboundRuntimeReleaseAttestationSchema.safeParse(value).success) return null;
  throw new HostedDeployError("convex_deploy_failed");
};

const releaseAttestationOverlay = (
  attestation: RuntimeReleaseAttestation,
): string => [
  'import { query } from "./server";',
  "",
  `export const RELEASE_ATTESTATION = Object.freeze(${JSON.stringify(attestation)} as const);`,
  "",
  "export const read = query({",
  "  args: {},",
  "  handler: () => RELEASE_ATTESTATION,",
  "});",
  "",
].join("\n");

const sameAttestation = (
  left: RuntimeReleaseAttestation | null,
  right: RuntimeReleaseAttestation | null,
): boolean => canonicalDigest(left) === canonicalDigest(right);

const createDeployIntent = (
  options: Readonly<{
    before: RuntimeReleaseAttestation | null;
    now: () => number;
    phase: "bootstrap" | "candidate";
    previousDeployDigest: string | null;
    revision: () => string;
    sourceCommit: string;
    target: ConvexTarget;
  }>,
): DeployIntent => {
  const deployedAtMs = Math.max(options.now(), (options.before?.deployedAtMs ?? -1) + 1);
  const after = runtimeReleaseAttestationSchema.parse({
    bound: true,
    deployedAtMs,
    previousDeployDigest: options.previousDeployDigest,
    runtimeRevision: options.revision(),
    runtimeSourceCommit: options.sourceCommit,
    schemaIdentity: "hra-release-attestation-v1",
    schemaVersion: 1,
  });
  const overlay = releaseAttestationOverlay(after);
  return deployIntentSchema.parse(withSelfDigest({
    after,
    before: options.before,
    kind: "convex-deploy-intent" as const,
    overlaySha256: createHash("sha256").update(overlay, "utf8").digest("hex"),
    phase: options.phase,
    previousDeployDigest: options.previousDeployDigest,
    schemaVersion: 1 as const,
    sourceCommit: options.sourceCommit,
    target: options.target,
    targetDigest: canonicalDigest(options.target),
  }));
};

const evidenceFromIntent = (intent: DeployIntent): DeployEvidence =>
  deployEvidenceSchema.parse(withSelfDigest({
    after: intent.after,
    before: intent.before,
    kind: "convex-deploy" as const,
    overlaySha256: intent.overlaySha256,
    phase: intent.phase,
    previousDeployDigest: intent.previousDeployDigest,
    schemaVersion: 1 as const,
    sourceCommit: intent.sourceCommit,
    target: intent.target,
    targetDigest: intent.targetDigest,
  }));

const readDeployIntent = (options: Readonly<{
  before: RuntimeReleaseAttestation | null;
  evidencePath: string;
  phase: "bootstrap" | "candidate";
  previousDeployDigest: string | null;
  sourceCommit: string;
  target: ConvexTarget;
}>): DeployIntent | undefined => {
  const path = `${options.evidencePath}.intent`;
  let existing: DeployIntent | undefined;
  try {
    existing = readProtectedJson(path, deployIntentSchema, {
      recoverInterruptedPublication: true,
    });
  } catch (error: unknown) {
    if (!(error instanceof Error) || error.message !== "evidence_not_found") throw error;
  }
  if (existing !== undefined) {
    const invariant = {
      before: options.before,
      phase: options.phase,
      previousDeployDigest: options.previousDeployDigest,
      sourceCommit: options.sourceCommit,
      target: options.target,
      targetDigest: canonicalDigest(options.target),
    };
    const recorded = {
      before: existing.before,
      phase: existing.phase,
      previousDeployDigest: existing.previousDeployDigest,
      sourceCommit: existing.sourceCommit,
      target: existing.target,
      targetDigest: existing.targetDigest,
    };
    if (canonicalDigest(invariant) !== canonicalDigest(recorded)) {
      throw new HostedDeployError("source_changed");
    }
    return existing;
  }
  return undefined;
};

const createAndPersistDeployIntent = (options: Readonly<{
  before: RuntimeReleaseAttestation | null;
  evidencePath: string;
  now: () => number;
  phase: "bootstrap" | "candidate";
  previousDeployDigest: string | null;
  revision: () => string;
  sourceCommit: string;
  target: ConvexTarget;
}>): DeployIntent => {
  const intent = createDeployIntent(options);
  writeProtectedJsonNoReplace(
    `${options.evidencePath}.intent`,
    intent,
    deployIntentSchema,
  );
  return intent;
};

const prepareArchivedSource = async (
  runner: CommandRunner,
  repositoryRoot: string,
  environment: Readonly<Record<string, string>>,
  sourceCommit: string,
  overlay: string | undefined,
  temporaryRoot: string,
  removeSource: TemporaryTreeRemover,
): Promise<ArchivedSourceBinding> => {
  const directory = await mkdtemp(join(temporaryRoot, "hra-hosted-source-"));
  try {
    await chmod(directory, 0o700);
    const archive = join(directory, "source.tar");
    const source = join(directory, "source");
    await mkdir(source, { mode: 0o700 });
    const archived = await invokeGit(
      runner,
      repositoryRoot,
      environment,
      ["archive", "--format=tar", `--output=${archive}`, sourceCommit],
    );
    if (archived.exitCode !== 0 || archived.stdout !== "") {
      throw new HostedDeployError("source_changed");
    }
    const extracted = await runner({
      arguments: ["-xf", archive, "-C", source],
      containment: "local",
      cwd: repositoryRoot,
      environment,
      executable: "/usr/bin/tar",
      outputMaximumBytes: gitOutputMaximumBytes,
      phase: "source-archive-extract",
      stdin: "",
      timeoutMs: 60_000,
    });
    if (extracted.exitCode !== 0 || extracted.stdout !== "") {
      throw new HostedDeployError("source_changed");
    }
    const packagePath = join(source, "package.json");
    const lockfilePath = join(source, "bun.lock");
    const convexSourcePath = join(source, "convex");
    const attestationPath = join(convexSourcePath, "releaseAttestation.ts");
    const scriptsPath = join(source, "scripts");
    const targetAssertionPath = join(scriptsPath, "assert-convex-deploy-target.ts");
    const archiveIdentities = await captureArchivedPathIdentities([
      { kind: "file", path: process.execPath },
      { kind: "directory", path: directory },
      { kind: "directory", path: source },
      { kind: "file", path: packagePath },
      { kind: "file", path: lockfilePath },
      { kind: "directory", path: convexSourcePath },
      { kind: "file", path: attestationPath },
      { kind: "directory", path: scriptsPath },
      { kind: "file", path: targetAssertionPath },
    ], "source_changed");
    const nodeModulesPath = join(source, "node_modules");
    try {
      await lstat(nodeModulesPath);
      throw new HostedDeployError("source_changed");
    } catch (error: unknown) {
      if (error instanceof HostedDeployError) throw error;
      if (
        !(error instanceof Error)
        || !("code" in error)
        || error.code !== "ENOENT"
      ) throw new HostedDeployError("source_changed");
    }
    let lockfileBefore: Buffer;
    let packageBefore: Buffer;
    try {
      [lockfileBefore, packageBefore] = await Promise.all([
        readFile(lockfilePath),
        readFile(packagePath),
      ]);
    } catch (error: unknown) {
      if (error instanceof HostedDeployError) throw error;
      throw new HostedDeployError("source_changed");
    }
    const installed = await runner({
      arguments: [
        "install",
        "--frozen-lockfile",
        "--ignore-scripts",
        "--backend=copyfile",
      ],
      containment: "local",
      cwd: source,
      environment,
      executable: process.execPath,
      outputMaximumBytes: archivedDependencyOutputMaximumBytes,
      phase: "source-dependency-install",
      stdin: "",
      timeoutMs: archivedDependencyTimeoutMs,
    });
    if (installed.exitCode !== 0) {
      throw new HostedDeployError("source_dependency_install_failed");
    }
    await revalidateArchivedPathIdentities(archiveIdentities, new Set([source]));
    try {
      const convexPackagePath = join(nodeModulesPath, "convex");
      const convexPackageManifestPath = join(convexPackagePath, "package.json");
      const convexBinPath = join(convexPackagePath, "bin");
      const [lockfileAfter, packageAfter] = await Promise.all([
        readFile(lockfilePath),
        readFile(packagePath),
      ]);
      if (!lockfileAfter.equals(lockfileBefore) || !packageAfter.equals(packageBefore)) {
        throw new HostedDeployError("source_dependency_install_failed");
      }
      await captureArchivedPathIdentities([
        { kind: "directory", path: nodeModulesPath },
        { kind: "directory", path: convexPackagePath },
        { kind: "file", path: convexPackageManifestPath },
        { kind: "directory", path: convexBinPath },
        { kind: "file", path: archivedConvexCli(source) },
      ], "source_dependency_install_failed");
    } catch (error: unknown) {
      if (error instanceof HostedDeployError) throw error;
      throw new HostedDeployError("source_dependency_install_failed");
    }
    if (overlay !== undefined) {
      if (dirname(attestationPath) !== join(source, "convex")) {
        throw new HostedDeployError("source_changed");
      }
      await writeFile(attestationPath, overlay, { encoding: "utf8", flag: "w", mode: 0o600 });
      if (await readFile(attestationPath, "utf8") !== overlay) {
        throw new HostedDeployError("source_changed");
      }
    }
    const launchIdentities = await captureArchivedPathIdentities([
      { kind: "file", path: process.execPath },
      { kind: "directory", path: directory },
      { kind: "directory", path: source },
      { kind: "file", path: packagePath },
      { kind: "file", path: lockfilePath },
      { kind: "directory", path: convexSourcePath },
      { kind: "file", path: attestationPath },
      { kind: "directory", path: scriptsPath },
      { kind: "file", path: targetAssertionPath },
      { kind: "directory", path: nodeModulesPath },
      { kind: "directory", path: join(nodeModulesPath, "convex") },
      { kind: "file", path: join(nodeModulesPath, "convex", "package.json") },
      { kind: "directory", path: join(nodeModulesPath, "convex", "bin") },
      { kind: "file", path: archivedConvexCli(source) },
    ], "source_dependency_install_failed");
    return {
      async cleanup() {
        await removeSource(directory, { force: false });
      },
      path: source,
      async revalidate() {
        await revalidateArchivedPathIdentities(launchIdentities);
      },
      recoveryPath: directory,
    };
  } catch (error: unknown) {
    if (isBoundedProcessCleanupUnprovenError(error)) {
      error.retainRecoveryPath(directory);
    } else {
      try {
        await removeSource(directory, { force: true });
      } catch {
        throw retainFailedFilesystemCleanup("source", error, directory);
      }
    }
    throw error;
  }
};

export const prepareHostedOperationSource = async (options: Readonly<{
  environment: Readonly<Record<string, string>>;
  repositoryRoot: string;
  runner: CommandRunner;
  sourceCommit: string;
  temporaryRoot?: string;
}>): Promise<HostedOperationSourceBinding> => await prepareArchivedSource(
  options.runner,
  options.repositoryRoot,
  options.environment,
  options.sourceCommit,
  undefined,
  options.temporaryRoot ?? tmpdir(),
  removeTemporaryTree,
);

type HostedDeployOptions = Readonly<{
  archivedSourceRemover?: TemporaryTreeRemover;
  authorityFetch?: typeof fetch;
  authorityTimeoutMs?: number;
  evidencePath?: string;
  environment?: Readonly<NodeJS.ProcessEnv>;
  now?: () => number;
  phase?: "bootstrap" | "candidate";
  previousDeployEvidencePath?: string;
  readAttestation?: ReleaseAttestationReader;
  repositoryRoot?: string;
  revision?: () => string;
  runner?: CommandRunner;
  sourceCommit: string;
  target: ConvexTarget;
  temporaryRoot?: string;
  deploymentBindingRemover?: TemporaryTreeRemover;
  verifyTarget?: ConvexTargetVerifier;
}>;

export async function deployHostedSync(
  options: HostedDeployOptions,
): Promise<DeployEvidence | undefined> {
  if (!sourceCommitPattern.test(options.sourceCommit)) {
    throw new HostedDeployError("usage_invalid");
  }
  const target = parseConvexTarget(options.target);
  const runner = options.runner ?? runCommand;
  const repositoryRoot = options.repositoryRoot ?? defaultRepositoryRoot;
  const environment = {
    ...buildConvexChildEnvironment(options.environment ?? process.env, []),
    [OOMPA_EXPECTED_CONVEX_DEPLOY_URL]: target.deploymentUrl,
  };
  const verifyTarget = options.verifyTarget ?? verifyConvexDefaultTarget;
  const authorityTimeout = options.authorityTimeoutMs ?? convexAuthorityTimeoutMs;
  if (!Number.isSafeInteger(authorityTimeout) || authorityTimeout < 1 || authorityTimeout > 120_000) {
    throw new HostedDeployError("usage_invalid");
  }
  const readAttestation = options.readAttestation
    ?? runtimeReleaseAttestationReader(options.authorityFetch ?? fetch, authorityTimeout);
  const evidenceConfigured = options.evidencePath !== undefined
    || options.phase !== undefined
    || options.previousDeployEvidencePath !== undefined;
  if (
    evidenceConfigured
    && (
      options.evidencePath === undefined
      || options.phase === undefined
      || (options.phase === "bootstrap" && options.previousDeployEvidencePath !== undefined)
      || (options.phase === "candidate" && options.previousDeployEvidencePath === undefined)
    )
  ) throw new HostedDeployError("usage_invalid");

  await requireExactSource(
    runner,
    repositoryRoot,
    environment,
    options.sourceCommit,
  );
  await verifyTarget(target);
  let intent: DeployIntent | undefined;
  let sourceBinding: ArchivedSourceBinding | undefined;
  if (options.evidencePath !== undefined && options.phase !== undefined) {
    const existingEvidence = (() => {
      try {
        return parseDeployEvidenceFile(options.evidencePath, {
          recoverInterruptedPublication: true,
        });
      } catch (error: unknown) {
        if (error instanceof Error && error.message === "evidence_not_found") return undefined;
        throw error;
      }
    })();
    const previous = options.phase === "candidate"
      ? parseDeployEvidenceFile(options.previousDeployEvidencePath ?? "")
      : undefined;
    if (
      previous !== undefined
      && canonicalDigest(previous.target) !== canonicalDigest(target)
    ) throw new HostedDeployError("source_changed");
    if (existingEvidence !== undefined) {
      const expectedPrevious = previous?.selfDigest ?? null;
      if (
        existingEvidence.sourceCommit !== options.sourceCommit
        || existingEvidence.phase !== options.phase
        || existingEvidence.previousDeployDigest !== expectedPrevious
        || canonicalDigest(existingEvidence.before) !== canonicalDigest(previous?.after ?? null)
        || canonicalDigest(existingEvidence.target) !== canonicalDigest(target)
        || !sameAttestation(await readAttestation(target), existingEvidence.after)
      ) throw new HostedDeployError("source_changed");
      await verifyTarget(target);
      await requireExactSource(runner, repositoryRoot, environment, options.sourceCommit);
      return existingEvidence;
    }
    const before = previous?.after ?? null;
    const previousDeployDigest = previous?.selfDigest ?? null;
    intent = readDeployIntent({
      before,
      evidencePath: options.evidencePath,
      phase: options.phase,
      previousDeployDigest,
      sourceCommit: options.sourceCommit,
      target,
    });
    const current = await readAttestation(target);
    if (intent !== undefined && sameAttestation(current, intent.after)) {
      const reconciled = evidenceFromIntent(intent);
      writeProtectedJsonNoReplace(
        options.evidencePath,
        reconciled,
        deployEvidenceSchema,
        { allowExactReplay: true },
      );
      await verifyTarget(target);
      await requireExactSource(runner, repositoryRoot, environment, options.sourceCommit);
      return reconciled;
    }
    if (!sameAttestation(current, intent?.before ?? before)) {
      throw new HostedDeployError("source_changed");
    }
    intent ??= createAndPersistDeployIntent({
      before,
      evidencePath: options.evidencePath,
      now: options.now ?? Date.now,
      phase: options.phase,
      previousDeployDigest,
      revision: options.revision ?? randomUUID,
      sourceCommit: options.sourceCommit,
      target,
    });
    const overlay = releaseAttestationOverlay(intent.after);
    if (createHash("sha256").update(overlay, "utf8").digest("hex") !== intent.overlaySha256) {
      throw new HostedDeployError("source_changed");
    }
    try {
      sourceBinding = await prepareArchivedSource(
        runner,
        repositoryRoot,
        environment,
        options.sourceCommit,
        overlay,
        options.temporaryRoot ?? tmpdir(),
        options.archivedSourceRemover ?? removeTemporaryTree,
      );
    } catch (error: unknown) {
      throw retainHostedDeployRecoveryPaths(
        error,
        [options.evidencePath, `${options.evidencePath}.intent`],
      );
    }
  }
  let binding: DeploymentBinding | undefined;
  let failure: Error | undefined;
  try {
    binding = await createDeploymentBinding(
      target.deploymentName,
      options.temporaryRoot,
      options.deploymentBindingRemover ?? removeTemporaryTree,
    );
    if (
      intent !== undefined
      && !sameAttestation(await readAttestation(target), intent.before)
    ) throw new HostedDeployError("source_changed");
    const deploymentSourceRoot = sourceBinding?.path;
    await sourceBinding?.revalidate();
    let result: CommandResult | undefined;
    try {
      result = await runner({
        arguments: [
          deploymentSourceRoot === undefined
            ? convexCli
            : archivedConvexCli(deploymentSourceRoot),
          "deploy",
          "--env-file",
          binding.path,
          "--yes",
          "--typecheck",
          "enable",
          "--codegen",
          "disable",
          "--cmd",
          deploymentSourceRoot === undefined
            ? resolvedTargetAssertionCommand
            : archivedTargetAssertionCommand(deploymentSourceRoot),
          "--cmd-url-env-var-name",
          OOMPA_RESOLVED_CONVEX_DEPLOY_URL,
          "--skip-workos-check",
          "--message",
          `Oompa source ${options.sourceCommit}`,
        ],
        containment: "authority",
        cwd: sourceBinding?.path ?? repositoryRoot,
        environment,
        executable: process.execPath,
        outputMaximumBytes: convexDeployOutputMaximumBytes,
        phase: "convex-deploy",
        stdin: "",
        timeoutMs: convexDeployTimeoutMs,
      });
    } catch (error: unknown) {
      if (isBoundedProcessCleanupUnprovenError(error)) throw error;
      if (isBoundedProcessRecoveryJournalError(error)) throw error;
      rethrowAuthorityContainmentUnavailable(error);
      result = undefined;
    }
    await verifyTarget(target);
    const runtimeAfter = intent === undefined ? undefined : await readAttestation(target);
    if (
      (result === undefined || result.exitCode !== 0)
      && (intent === undefined || !sameAttestation(runtimeAfter ?? null, intent.after))
    ) {
      throw new HostedDeployError("convex_deploy_failed");
    }
    if (intent !== undefined && !sameAttestation(runtimeAfter ?? null, intent.after)) {
      throw new HostedDeployError("convex_deploy_failed");
    }
    await requireExactSource(
      runner,
      repositoryRoot,
      environment,
      options.sourceCommit,
    );
  } catch (error: unknown) {
    const retained = retainHostedDeployRecoveryPaths(
      error,
      intent === undefined || options.evidencePath === undefined
        ? []
        : [options.evidencePath, `${options.evidencePath}.intent`],
    );
    failure = retained instanceof Error
      ? retained
      : new HostedDeployError("convex_deploy_failed");
  }
  const cleanupFailure = isBoundedProcessCleanupUnprovenError(failure) ? failure : undefined;
  const durableRecoveryPaths = intent === undefined || options.evidencePath === undefined
    ? []
    : [options.evidencePath, `${options.evidencePath}.intent`];
  if (cleanupFailure !== undefined) {
    if (binding !== undefined) cleanupFailure.retainRecoveryPath(binding.recoveryPath);
    if (sourceBinding !== undefined) cleanupFailure.retainRecoveryPath(sourceBinding.recoveryPath);
  }
  const cleanupUnproven = cleanupFailure !== undefined;
  if (!cleanupUnproven) {
    try {
      await binding?.cleanup();
    } catch {
      if (binding !== undefined) {
        failure = retainHostedDeployRecoveryPaths(
          retainFailedFilesystemCleanup("binding", failure, binding.recoveryPath),
          durableRecoveryPaths,
        ) as Error;
      }
    }
    try {
      await sourceBinding?.cleanup();
    } catch {
      if (sourceBinding !== undefined) {
        failure = retainHostedDeployRecoveryPaths(
          retainFailedFilesystemCleanup("source", failure, sourceBinding.recoveryPath),
          durableRecoveryPaths,
        ) as Error;
      }
    }
  }
  if (failure !== undefined) throw failure;
  if (intent !== undefined && options.evidencePath !== undefined) {
    const evidence = evidenceFromIntent(intent);
    writeProtectedJsonNoReplace(
      options.evidencePath,
      evidence,
      deployEvidenceSchema,
      { allowExactReplay: true },
    );
    return evidence;
  }
  return undefined;
}

type ExecuteOptions = Readonly<{
  archivedSourceRemover?: TemporaryTreeRemover;
  arguments: readonly string[];
  deploymentBindingRemover?: TemporaryTreeRemover;
  environment?: Readonly<NodeJS.ProcessEnv>;
  repositoryRoot?: string;
  readAttestation?: ReleaseAttestationReader;
  runner?: CommandRunner;
  stderr: Pick<NodeJS.WriteStream, "write">;
  stdout: Pick<NodeJS.WriteStream, "write">;
  temporaryRoot?: string;
  verifyTarget?: ConvexTargetVerifier;
}>;

export async function executeHostedDeploy(options: ExecuteOptions): Promise<number> {
  try {
    const parsed = parseDeployArguments(options.arguments);
    const evidence = await deployHostedSync({
      ...(options.archivedSourceRemover === undefined
        ? {}
        : { archivedSourceRemover: options.archivedSourceRemover }),
      ...(parsed.evidencePath === undefined ? {} : { evidencePath: parsed.evidencePath }),
      ...(options.environment === undefined ? {} : { environment: options.environment }),
      ...(parsed.phase === undefined ? {} : { phase: parsed.phase }),
      ...(parsed.previousDeployEvidencePath === undefined
        ? {}
        : { previousDeployEvidencePath: parsed.previousDeployEvidencePath }),
      ...(options.repositoryRoot === undefined ? {} : { repositoryRoot: options.repositoryRoot }),
      ...(options.readAttestation === undefined
        ? {}
        : { readAttestation: options.readAttestation }),
      ...(options.deploymentBindingRemover === undefined
        ? {}
        : { deploymentBindingRemover: options.deploymentBindingRemover }),
      ...(options.runner === undefined ? {} : { runner: options.runner }),
      sourceCommit: parsed.sourceCommit,
      target: parsed.target,
      ...(options.temporaryRoot === undefined ? {} : { temporaryRoot: options.temporaryRoot }),
      ...(options.verifyTarget === undefined ? {} : { verifyTarget: options.verifyTarget }),
    });
    options.stdout.write(evidence === undefined
      ? `Deployed exact source ${parsed.sourceCommit} to the verified target.\n`
      : `${JSON.stringify({
          evidenceDigest: evidence.selfDigest,
          evidencePath: parsed.evidencePath,
          phase: evidence.phase,
          schemaVersion: 1,
          sourceCommit: evidence.sourceCommit,
          status: "attested",
        })}\n`);
    return 0;
  } catch (error: unknown) {
    if (error instanceof HostedDeployFilesystemCleanupError) {
      options.stderr.write(`${JSON.stringify({
        code: error.code,
        primaryCode: error.primaryCode,
        ...(error.primaryReason === undefined ? {} : { primaryReason: error.primaryReason }),
        recoveryPaths: error.recoveryPaths,
        schemaVersion: 1,
        status: "recovery_required",
      })}\n`);
      return 75;
    }
    const authorityUnavailable = renderAuthorityContainmentUnavailable(error);
    if (authorityUnavailable !== undefined) {
      options.stderr.write(authorityUnavailable);
      return 1;
    }
    if (isBoundedProcessCleanupUnprovenError(error)) {
      options.stderr.write(`${JSON.stringify({
        code: "process_cleanup_unproven",
        phase: error.phase,
        processGroupId: error.processGroupId,
        processes: error.processes,
        recoveryPaths: error.recoveryPaths,
        schemaVersion: 1,
        status: "recovery_required",
      })}\n`);
      return 75;
    }
    if (isBoundedProcessRecoveryJournalError(error)) {
      options.stderr.write(`${JSON.stringify({
        code: "process_recovery_journal_blocked",
        reason: error.reason,
        recoveryPaths: error.recoveryPaths,
        schemaVersion: 1,
        status: "recovery_required",
      })}\n`);
      return 75;
    }
    const code = error instanceof HostedDeployError
      ? error.code
      : error instanceof ConvexTargetError
        ? "convex_target_refused"
        : "convex_deploy_failed";
    options.stderr.write(`Hosted deploy refused (${code}).\n`);
    return 1;
  }
}

if (import.meta.main) {
  let exitCode = 75;
  try {
    const rawArguments = process.argv.slice(2);
    let operatorRecoveryPaths: readonly string[] = [];
    try {
      const parsed = parseDeployArguments(rawArguments);
      if (parsed.evidencePath !== undefined) {
        operatorRecoveryPaths = [parsed.evidencePath, `${parsed.evidencePath}.intent`];
      }
    } catch {
      // The process journal remains authoritative when this invocation's
      // arguments are invalid. Only validated absolute paths are retained.
    }
    try {
      await recoverBoundedProcessJournal();
    } catch (error: unknown) {
      throw retainHostedDeployRecoveryPaths(error, operatorRecoveryPaths);
    }
    exitCode = await executeHostedDeploy({
      arguments: rawArguments,
      stderr: process.stderr,
      stdout: process.stdout,
    });
  } catch (error: unknown) {
    if (error instanceof HostedDeployFilesystemCleanupError) {
      process.stderr.write(`${JSON.stringify({
        code: error.code,
        primaryCode: error.primaryCode,
        ...(error.primaryReason === undefined ? {} : { primaryReason: error.primaryReason }),
        recoveryPaths: error.recoveryPaths,
        schemaVersion: 1,
        status: "recovery_required",
      })}\n`);
    } else {
      const authorityUnavailable = renderAuthorityContainmentUnavailable(error);
      if (authorityUnavailable !== undefined) {
        process.stderr.write(authorityUnavailable);
        exitCode = 1;
      } else if (isBoundedProcessCleanupUnprovenError(error)) {
        process.stderr.write(`${JSON.stringify({
          code: "process_cleanup_unproven",
          phase: error.phase,
          processGroupId: error.processGroupId,
          processes: error.processes,
          recoveryPaths: error.recoveryPaths,
          schemaVersion: 1,
          status: "recovery_required",
        })}\n`);
      } else if (isBoundedProcessRecoveryJournalError(error)) {
        process.stderr.write(`${JSON.stringify({
          code: "process_recovery_journal_blocked",
          reason: error.reason,
          recoveryPaths: error.recoveryPaths,
          schemaVersion: 1,
          status: "recovery_required",
        })}\n`);
      } else {
        process.stderr.write("Hosted deploy refused (convex_deploy_failed).\n");
        exitCode = 1;
      }
    }
  }
  process.exitCode = exitCode;
}

export type { CommandRequest };
