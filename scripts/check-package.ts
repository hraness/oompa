import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { access, lstat, mkdtemp, mkdir, open, opendir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { z } from "zod";

import {
  DaemonLock,
  readDaemonAuthorityReceipt,
  type DaemonAuthorityReceipt,
} from "../src/daemon/daemon-lock";
import {
  daemonIdentitySchema,
  identityFromReceipt,
  sameDaemonIdentity,
  terminateDaemonStartupChild,
  type DaemonIdentity,
} from "../src/daemon/daemon-startup";
import { rootStatusSchema } from "../src/domain/observation";
import type { StatePaths } from "../src/storage/paths";
import { resolveStatePaths } from "../src/storage/paths";
import { assertOompaInstallManifest, assertSafeDarwinInstallAcl } from "../src/install-normalizer";
import { OOMPA_INSTALL_PREFLIGHT_SUCCESS } from "../src/install-preflight";
import {
  requireBoundedProcessCleanup,
  runBoundedProcess,
} from "./bounded-process";
import {
  assertPublicSensitiveText,
  assertPublicCheckout,
  assertPublicText,
  assertPublicTree,
} from "./public-text-policy";
import { assertProductionPackageOnly, assertReviewedReleaseInventory } from "./package-policy";
import { assertPackageContentAt } from "./package-content";
import {
  assertPseudoTerminalSuccess,
  PTY_BEGIN_MARKER,
  runInPseudoTerminal,
} from "./pty-acceptance";

const packageSchema = z.object({
  bin: z.object({ oompa: z.literal("./src/cli.ts") }).strict(),
  bugs: z.object({ url: z.literal("https://github.com/hraness/oompa/issues") }).strict(),
  engines: z.object({ bun: z.literal("1.3.14") }).strict(),
  exports: z.object({ ".": z.literal("./src/index.ts") }).strict(),
  files: z.array(z.string()).min(1),
  homepage: z.literal("https://oompa.app"),
  license: z.literal("MIT"),
  name: z.literal("@hraness/oompa"),
  publishConfig: z.object({
    access: z.literal("public"),
    registry: z.literal("https://registry.npmjs.org"),
  }).strict(),
  repository: z.object({
    type: z.literal("git"),
    url: z.literal("git+https://github.com/hraness/oompa.git"),
  }).strict(),
  scripts: z.record(z.string(), z.string()),
  version: z.literal("0.8.5"),
}).passthrough();

type ProcessResult = Readonly<{
  exitCode: number;
  stderr: string;
  stdout: string;
}>;

type OwnedDaemonExit = Readonly<{
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}>;

type OwnedInstalledDaemon = Readonly<{
  child: ChildProcess;
  exited: Promise<OwnedDaemonExit>;
  exitObservation: () => OwnedDaemonExit | null;
  pid: number;
}>;

class InstalledDaemonOwnershipError extends Error {
  constructor() {
    super("The installed daemon process spawned without an exact PID, so cleanup cannot be proved.");
    this.name = "InstalledDaemonOwnershipError";
  }
}

const daemonRunningSchema = z.object({
  data: z.object({
    daemon: daemonIdentitySchema,
    running: z.literal(true),
  }).passthrough(),
  ok: z.literal(true),
  version: z.literal(1),
}).passthrough();

const installedRootStatusEnvelopeSchema = z.object({
  command: z.literal("status"),
  data: rootStatusSchema,
  ok: z.literal(true),
  version: z.literal(1),
}).strict();

const installedMissingSessionErrorSchema = z.object({
  error: z.object({ code: z.literal("NOT_FOUND") }).passthrough(),
  ok: z.literal(false),
  version: z.literal(1),
}).passthrough();
const installedNotFoundExitCode = 4;

const packageCommandTimeoutMaximumMs = 60_000;
const packageCommandOutputMaximumBytes = 32 * 1024 * 1024;
const packageCommandTerminationGraceMs = 250;
const packageCommandKillSettlementMs = 1_000;

export const runPackageCommand = async (
  executable: string,
  arguments_: readonly string[],
  options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    outputMaximumBytes?: number;
    phase?: string;
    timeoutMs?: number;
  },
): Promise<ProcessResult> => {
  const requestedTimeout = options.timeoutMs;
  const timeoutMs = requestedTimeout === undefined
    || !Number.isSafeInteger(requestedTimeout)
    || requestedTimeout < 1
    ? packageCommandTimeoutMaximumMs
    : Math.min(requestedTimeout, packageCommandTimeoutMaximumMs);
  const requestedOutputMaximum = options.outputMaximumBytes;
  const outputMaximumBytes = requestedOutputMaximum === undefined
    || !Number.isSafeInteger(requestedOutputMaximum)
    || requestedOutputMaximum < 1
    ? packageCommandOutputMaximumBytes
    : Math.min(requestedOutputMaximum, packageCommandOutputMaximumBytes);
  const result = requireBoundedProcessCleanup(await runBoundedProcess({
    arguments: arguments_,
    containment: "local",
    cwd: options.cwd,
    environment: options.env ?? process.env,
    executable,
    killSettlementMs: packageCommandKillSettlementMs,
    outputMaximumBytes,
    phase: options.phase ?? "package-acceptance-command",
    terminationGraceMs: packageCommandTerminationGraceMs,
    timeoutMs,
  }));
  return {
    exitCode: result.exitCode,
    stderr: result.stderr.toString("utf8"),
    stdout: result.stdout.toString("utf8"),
  };
};

export const parsePackageDependencyCache = (stdout: string): string => {
  if (
    Buffer.byteLength(stdout, "utf8") > 4_096
    || stdout.includes("\r")
  ) throw new Error("Bun returned a non-canonical dependency cache path.");
  const path = stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout;
  if (
    path.length < 1
    || path.includes("\n")
    || path.includes("\0")
    || !isAbsolute(path)
    || resolve(path) !== path
  ) throw new Error("Bun returned a non-canonical dependency cache path.");
  return path;
};

type PackageDependencyCacheIdentity = Readonly<{
  dev: number;
  ino: number;
  mode: number;
  uid: number;
}>;

const packageDependencyCacheIdentity = (metadata: Stats): PackageDependencyCacheIdentity => ({
  dev: metadata.dev,
  ino: metadata.ino,
  mode: metadata.mode & 0o7777,
  uid: metadata.uid,
});

const samePackageDependencyCacheIdentity = (
  left: PackageDependencyCacheIdentity,
  right: PackageDependencyCacheIdentity,
): boolean => left.dev === right.dev
  && left.ino === right.ino
  && left.mode === right.mode
  && left.uid === right.uid;

type HeldPackageDependencyCacheDirectory = Readonly<{
  handle: Awaited<ReturnType<typeof open>>;
  identity: PackageDependencyCacheIdentity;
  path: string;
  requiresCurrentOwner: boolean;
}>;

const packageDependencyCacheDirectoryPathsThrough = (path: string): readonly string[] => {
  const root = parse(path).root;
  if (root.length === 0 || !path.startsWith(root)) throw new Error("Bun dependency cache path is invalid.");
  const paths = [root];
  let current = root;
  for (const component of path.slice(root.length).split(sep).filter((value) => value.length > 0)) {
    current = join(current, component);
    paths.push(current);
  }
  return paths;
};

const assertPackageDependencyCacheDirectory = (
  metadata: Stats,
  path: string,
  uid: number,
): void => {
  const permissions = metadata.mode & 0o777;
  const rootOwnedStickyBoundary = metadata.uid === 0
    && (metadata.mode & 0o1000) !== 0
    && (permissions & 0o022) !== 0;
  if (
    !metadata.isDirectory()
    || metadata.isSymbolicLink()
    || (metadata.uid !== uid && metadata.uid !== 0)
    || (permissions & 0o100) === 0
    || ((permissions & 0o022) !== 0 && !rootOwnedStickyBoundary)
  ) throw new Error(`Bun dependency cache path custody is invalid: ${path}`);
};

class PackageDependencyCacheCustody {
  readonly #held: HeldPackageDependencyCacheDirectory[] = [];

  constructor(private readonly uid: number) {}

  async holdThrough(path: string): Promise<void> {
    let currentUserBoundarySeen = false;
    try {
      for (const directoryPath of packageDependencyCacheDirectoryPathsThrough(path)) {
        const pathMetadata = await lstat(directoryPath);
        assertPackageDependencyCacheDirectory(pathMetadata, directoryPath, this.uid);
        if (await realpath(directoryPath) !== directoryPath) {
          throw new Error(`Bun dependency cache path is not canonical: ${directoryPath}`);
        }
        if (pathMetadata.uid === this.uid) currentUserBoundarySeen = true;
        if (currentUserBoundarySeen && pathMetadata.uid !== this.uid) {
          throw new Error(`Bun dependency cache path leaves current-user custody: ${directoryPath}`);
        }
        const handle = await open(
          directoryPath,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
        try {
          const descriptorMetadata = await handle.stat();
          assertPackageDependencyCacheDirectory(descriptorMetadata, directoryPath, this.uid);
          if (currentUserBoundarySeen && descriptorMetadata.uid !== this.uid) {
            throw new Error(`Bun dependency cache descriptor leaves current-user custody: ${directoryPath}`);
          }
          const identity = packageDependencyCacheIdentity(pathMetadata);
          if (!samePackageDependencyCacheIdentity(identity, packageDependencyCacheIdentity(descriptorMetadata))) {
            throw new Error(`Bun dependency cache path changed while opening custody: ${directoryPath}`);
          }
          assertSafeDarwinInstallAcl(handle.fd, this.uid, directoryPath);
          this.#held.push({
            handle,
            identity,
            path: directoryPath,
            requiresCurrentOwner: currentUserBoundarySeen,
          });
        } catch (error: unknown) {
          await handle.close();
          throw error;
        }
      }
    } catch (error: unknown) {
      try {
        await this.close();
      } catch (closeError: unknown) {
        throw new AggregateError([error, closeError], "Bun dependency cache custody opening and cleanup both failed.");
      }
      throw error;
    }
  }

  async assertAll(): Promise<void> {
    for (const held of this.#held) {
      const [canonicalPath, pathMetadata, descriptorMetadata] = await Promise.all([
        realpath(held.path),
        lstat(held.path),
        held.handle.stat(),
      ]);
      assertPackageDependencyCacheDirectory(pathMetadata, held.path, this.uid);
      assertPackageDependencyCacheDirectory(descriptorMetadata, held.path, this.uid);
      if (
        canonicalPath !== held.path
        || (held.requiresCurrentOwner && (pathMetadata.uid !== this.uid || descriptorMetadata.uid !== this.uid))
        || !samePackageDependencyCacheIdentity(held.identity, packageDependencyCacheIdentity(pathMetadata))
        || !samePackageDependencyCacheIdentity(held.identity, packageDependencyCacheIdentity(descriptorMetadata))
      ) throw new Error(`Bun dependency cache path identity changed while in use: ${held.path}`);
      assertSafeDarwinInstallAcl(held.handle.fd, this.uid, held.path);
    }
  }

  async close(): Promise<void> {
    const held = this.#held.splice(0).reverse();
    const results = await Promise.allSettled(held.map(async ({ handle }) => await handle.close()));
    const errors = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map(({ reason }) => reason as unknown);
    if (errors.length > 0) throw new AggregateError(errors, "Bun dependency cache custody cleanup failed.");
  }
}

export const withPackageDependencyCacheCustody = async <Value>(
  path: string,
  operation: () => Promise<Value>,
): Promise<Value> => {
  const uid = process.getuid?.();
  if (uid === undefined || !isAbsolute(path) || resolve(path) !== path || await realpath(path) !== path) {
    throw new Error("Bun dependency cache custody is invalid.");
  }
  const cacheMetadata = await lstat(path);
  if (
    !cacheMetadata.isDirectory()
    || cacheMetadata.isSymbolicLink()
    || cacheMetadata.uid !== uid
    || (cacheMetadata.mode & 0o022) !== 0
  ) throw new Error("Bun dependency cache custody is invalid.");
  const custody = new PackageDependencyCacheCustody(uid);
  await custody.holdThrough(path);
  let operationFailed = false;
  let operationError: unknown;
  let custodyFailed = false;
  let custodyError: unknown;
  let closeFailed = false;
  let closeError: unknown;
  let operationValue: Value | undefined;
  try {
    try {
      try {
        operationValue = await operation();
      } catch (error: unknown) {
        operationFailed = true;
        operationError = error;
      }
      await custody.assertAll();
    } catch (error: unknown) {
      custodyFailed = true;
      custodyError = error;
    }
  } finally {
    try {
      await custody.close();
    } catch (error: unknown) {
      closeFailed = true;
      closeError = error;
    }
  }
  const errors: Error[] = [];
  const pushError = (failed: boolean, error: unknown, label: string): void => {
    if (failed) errors.push(error instanceof Error ? error : new Error(label, { cause: error }));
  };
  pushError(operationFailed, operationError, "Bun dependency cache operation failed with a non-error value.");
  pushError(custodyFailed, custodyError, "Bun dependency cache custody failed with a non-error value.");
  pushError(closeFailed, closeError, "Bun dependency cache cleanup failed with a non-error value.");
  if (errors.length > 1) {
    throw new AggregateError(errors, "Bun dependency cache use and custody settlement both failed.");
  }
  const error = errors[0];
  if (error !== undefined) throw error;
  return operationValue as Value;
};

export const packageDependencyCacheDiscoveryEnvironment = (
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv => {
  const discoveryEnvironment = { ...environment };
  delete discoveryEnvironment.BUN_INSTALL_CACHE_DIR;
  return discoveryEnvironment;
};

const resolvePackageDependencyCache = async (repositoryRoot: string): Promise<string> => {
  const discoveryEnvironment = packageDependencyCacheDiscoveryEnvironment(process.env);
  const result = requireSuccess(
    "Bun dependency cache discovery",
    await run(process.execPath, ["pm", "cache"], {
      cwd: repositoryRoot,
      env: discoveryEnvironment,
    }),
  );
  if (result.stderr !== "") throw new Error("Bun dependency cache discovery returned diagnostics.");
  const path = parsePackageDependencyCache(result.stdout);
  await withPackageDependencyCacheCustody(path, async () => {
    await access(path, constants.R_OK | constants.W_OK);
    let entries = 0;
    for await (const entry of await opendir(path)) {
      entries += 1;
      if (entry.name.length < 1 || entries > 100_000) {
        throw new Error("Bun dependency cache inventory is invalid.");
      }
    }
    if (entries === 0) throw new Error("Bun dependency cache inventory is invalid.");
  });
  return path;
};

const run = runPackageCommand;

const requireSuccess = (label: string, result: ProcessResult): ProcessResult => {
  if (result.exitCode !== 0) {
    throw new Error(`${label} failed with exit ${String(result.exitCode)}:\n${result.stderr}${result.stdout}`);
  }
  return result;
};

export const requireGitHistoryOutput = (label: string, result: ProcessResult): string => {
  if (result.exitCode !== 0 || result.stderr !== "") {
    throw new Error(`${label} failed or emitted diagnostics with exit ${String(result.exitCode)}.`);
  }
  return result.stdout;
};

const gitHistoryCommitMaximum = 100_000;
const gitCommitPattern = /^[0-9a-f]{40}$/u;
const gitHistoryCommandOutputMaximumBytes = 32 * 1024 * 1024;
const gitHistoryCommandTimeoutMaximumMs = 60_000;
const gitHistoryScanOutputMaximumBytes = 1024 * 1024 * 1024;
const gitHistoryScanTimeoutMs = 10 * 60_000;

type GitHistoryCommand =
  | Readonly<{ kind: "enumerate" }>
  | Readonly<{ commit: string; kind: "public_patch" }>
  | Readonly<{ commit: string; kind: "sensitive_patch" }>
  | Readonly<{ kind: "shallow" }>;

type GitHistoryPatchKind = "public_patch" | "sensitive_patch";

type ReviewedSyntheticHistoryFixture = "memory_summary" | "sanitized_message";

type ReviewedSyntheticHistoryPatchEvidence = Readonly<{
  fixtures: readonly ReviewedSyntheticHistoryFixture[];
  publicPatchSha256: string;
  sensitivePatchSha256: string;
}>;

const reviewedSyntheticHistoryPatchEvidence: Readonly<
  Record<string, ReviewedSyntheticHistoryPatchEvidence>
> = Object.freeze({
  "313ed3e3e1ddbe5b6464fc098926717f177418a8": Object.freeze({
    fixtures: Object.freeze(["sanitized_message"] as const),
    publicPatchSha256: "38922e6d214028499463e193e62b7fde97835cad271693f76e4876af080e5a27",
    sensitivePatchSha256: "38922e6d214028499463e193e62b7fde97835cad271693f76e4876af080e5a27",
  }),
  "5039f0bfe37706f97bd93e68f8db2dff4aa16013": Object.freeze({
    fixtures: Object.freeze(["memory_summary"] as const),
    publicPatchSha256: "b3dbdd5504acb92dc2bb0f7e1ebf6e56e7911498bd96fc8f8b7080af924fe42b",
    sensitivePatchSha256: "b3dbdd5504acb92dc2bb0f7e1ebf6e56e7911498bd96fc8f8b7080af924fe42b",
  }),
  "72fcb44fb81a79c93ade6da3a127dbb3ae1dd6f9": Object.freeze({
    fixtures: Object.freeze(["memory_summary"] as const),
    publicPatchSha256: "cb571ed9e6f3c71cf062169d36fd1d403c7da42cf409fbc1e2bf64256e222911",
    sensitivePatchSha256: "ddc5655f80d0a9308dbcf319d2247c429f6a411a14aca2fa68c3efb2113c6d50",
  }),
  b48fdb71ca201d951b9b1343a909b5f18277bc36: Object.freeze({
    fixtures: Object.freeze(["sanitized_message", "memory_summary"] as const),
    publicPatchSha256: "1b6df43d22fb500c41291b5ab8c57c06f475aa80515dd57735b6f57fa70eed46",
    sensitivePatchSha256: "59089938773a6ea6574c7df54b7a3da73272a827920845e4805a3e4735b2f812",
  }),
  f39747b917b064ff593c58dea2a05e4481319b26: Object.freeze({
    fixtures: Object.freeze(["sanitized_message"] as const),
    publicPatchSha256: "1aa2ed40e2d437c2871a6975f177f9bb5bd078c68856fa66f63511a47144fc4a",
    sensitivePatchSha256: "1aa2ed40e2d437c2871a6975f177f9bb5bd078c68856fa66f63511a47144fc4a",
  }),
});
const reviewedSyntheticHistoryPaths: Readonly<Record<ReviewedSyntheticHistoryFixture, string>> = Object.freeze({
  memory_summary: ["", "Users", "operator", "private"].join("/"),
  sanitized_message: ["", "Users", "private", "project", ""].join("/"),
});
const reviewedSyntheticHistoryPathReplacement = "[reviewed-synthetic-absolute-path]";

export const normalizeReviewedSyntheticHistoryPatch = (
  patch: string,
  expectedPatchSha256: string,
  fixtures: readonly ReviewedSyntheticHistoryFixture[],
): string => {
  if (fixtures.length < 1 || fixtures.length > 2 || new Set(fixtures).size !== fixtures.length) {
    throw new Error("Reviewed Git history synthetic-path fixture selection is invalid.");
  }
  const patchSha256 = createHash("sha256").update(patch, "utf8").digest("hex");
  if (patchSha256 !== expectedPatchSha256) {
    throw new Error("Reviewed Git history synthetic-path evidence changed.");
  }
  let normalized = patch;
  for (const fixture of fixtures) {
    const fragment = reviewedSyntheticHistoryPaths[fixture];
    if (typeof fragment !== "string") {
      throw new Error("Reviewed Git history synthetic-path fixture is unknown.");
    }
    const firstOccurrence = patch.indexOf(fragment);
    const secondOccurrence = firstOccurrence < 0
      ? -1
      : patch.indexOf(fragment, firstOccurrence + fragment.length);
    if (firstOccurrence < 0 || secondOccurrence >= 0) {
      throw new Error("Reviewed Git history synthetic-path evidence changed.");
    }
    normalized = normalized.replace(fragment, reviewedSyntheticHistoryPathReplacement);
  }
  return normalized;
};

export const selectReviewedGitHistoryPatchEvidence = (
  commit: string,
  kind: GitHistoryPatchKind,
): Readonly<{
  fixtures: readonly ReviewedSyntheticHistoryFixture[];
  patchSha256: string;
}> | undefined => {
  if (!Object.hasOwn(reviewedSyntheticHistoryPatchEvidence, commit)) return undefined;
  const evidence = reviewedSyntheticHistoryPatchEvidence[commit];
  if (evidence === undefined) return undefined;
  return Object.freeze({
    fixtures: evidence.fixtures,
    patchSha256: kind === "public_patch" ? evidence.publicPatchSha256 : evidence.sensitivePatchSha256,
  });
};

type ReviewedSyntheticPackageFixture = "other_ui" | "foreign_package" | "slopcamera_suffix";
type ReviewedSyntheticPackageEvidence = Readonly<{
  fixtures: readonly ReviewedSyntheticPackageFixture[];
  patchSha256: string;
}>;

// These immutable public-patch receipts cover only synthetic negative-test
// package names and their removal. Sensitive-text scans never use this registry.
const reviewedSyntheticPackageHistoryEvidence: Readonly<Record<string, ReviewedSyntheticPackageEvidence>> = Object.freeze({
  e19458e45523c1ace0e87c7928eb15516db94ccd: Object.freeze({
    fixtures: Object.freeze(["other_ui"] as const),
    patchSha256: "5f2599b248dc16d94bc27d980604417398c15ee2e7a981b780954d039f55309f",
  }),
  e2fd2d699a9d003e072dc44a613cd823c24f155d: Object.freeze({
    fixtures: Object.freeze(["foreign_package"] as const),
    patchSha256: "fa6583ec433c00d10d967214631fb4e04847515bb273cca51548388cb7c6ba7b",
  }),
  "52579a5debfe1ee6c31dca0f31733a798c74c6aa": Object.freeze({
    fixtures: Object.freeze(["other_ui", "foreign_package"] as const),
    patchSha256: "a93c5c423beacf7ec5068310ae648b994de67506b07d46e523739b8903458beb",
  }),
  "166451a0354d5ecb6ca375feb1128a95ff7ff966": Object.freeze({
    fixtures: Object.freeze(["other_ui"] as const),
    patchSha256: "5d7b62c01ac47c3c74389d21b288c4526728c74d68d23c18719b00df09537ef4",
  }),
  "21176e6ca34e58574376f54a9098856a90d6cd56": Object.freeze({
    fixtures: Object.freeze(["other_ui"] as const),
    patchSha256: "6fc0a85da146a9a0ffc2b3f3407481e6e966e907e99db03e41a7dabb6d3bb749",
  }),
  "47c8e1cf98eb61441b1fc6832eb6ae035d75278a": Object.freeze({
    fixtures: Object.freeze(["slopcamera_suffix"] as const),
    patchSha256: "e5ac6ac289bf4e93818d13ababd2eb965ef4b1e054fe7b85f0631b145692baf2",
  }),
  e6d707ed88d1cc93ed4ba5b30a940e7ed3a55e20: Object.freeze({
    fixtures: Object.freeze(["slopcamera_suffix"] as const),
    patchSha256: "2c3a452f10ae857876538ec8cf76c27fdddf458f92e344465ff042aa6f3a09a2",
  }),
});
const reviewedSyntheticPackageTokens: Readonly<Record<ReviewedSyntheticPackageFixture, string>> = Object.freeze({
  other_ui: ["@other", "ui"].join("/"),
  foreign_package: ["@foreign", "package"].join("/"),
  slopcamera_suffix: ["@hraness/slopcamera", "unreviewed"].join("-"),
});

export const selectReviewedGitHistoryPackageEvidence = (
  commit: string,
  kind: GitHistoryPatchKind,
): ReviewedSyntheticPackageEvidence | undefined => {
  if (kind !== "public_patch" || !Object.hasOwn(reviewedSyntheticPackageHistoryEvidence, commit)) return undefined;
  return reviewedSyntheticPackageHistoryEvidence[commit];
};

export const normalizeReviewedSyntheticPackagePatch = (
  patch: string,
  expectedPatchSha256: string,
  fixtures: readonly ReviewedSyntheticPackageFixture[],
): string => {
  if (fixtures.length < 1 || fixtures.length > 2 || new Set(fixtures).size !== fixtures.length) {
    throw new Error("Reviewed Git history synthetic-package fixture selection is invalid.");
  }
  if (createHash("sha256").update(patch, "utf8").digest("hex") !== expectedPatchSha256) {
    throw new Error("Reviewed Git history synthetic-package evidence changed.");
  }
  let normalized = patch;
  for (const fixture of fixtures) {
    const token = reviewedSyntheticPackageTokens[fixture];
    if (typeof token !== "string") throw new Error("Reviewed Git history synthetic-package fixture is unknown.");
    const firstOccurrence = patch.indexOf(token);
    // Require exactly one complete quoted fixture, not a prefix of an arbitrary
    // scoped name. Any extra occurrence or any unrelated byte changes the proof.
    if (firstOccurrence < 1 || patch.indexOf(token, firstOccurrence + token.length) >= 0
      || patch[firstOccurrence - 1] !== '"' || patch[firstOccurrence + token.length] !== '"') {
      throw new Error("Reviewed Git history synthetic-package evidence changed.");
    }
    normalized = normalized.replace(token, "[reviewed-synthetic-package]");
  }
  return normalized;
};

export const normalizeGitHistoryPatchForPublicScan = (
  commit: string,
  kind: GitHistoryPatchKind,
  patch: string,
): string => {
  const packageEvidence = selectReviewedGitHistoryPackageEvidence(commit, kind);
  if (packageEvidence !== undefined) {
    if (selectReviewedGitHistoryPatchEvidence(commit, kind) !== undefined) {
      throw new Error("Reviewed Git history patch has ambiguous fixture evidence.");
    }
    return normalizeReviewedSyntheticPackagePatch(patch, packageEvidence.patchSha256, packageEvidence.fixtures);
  }
  const evidence = selectReviewedGitHistoryPatchEvidence(commit, kind);
  if (evidence === undefined) return patch;
  return normalizeReviewedSyntheticHistoryPatch(patch, evidence.patchSha256, evidence.fixtures);
};

/**
 * Git truncates generated hunk section labels, including otherwise public package
 * names. Project only those labels out of the scope scan after exact historical
 * evidence checks. Authored lines retain their +/-/space prefix; complete raw
 * patches still receive the separate sensitive-text scan. Split physical LF
 * lines so CR and Unicode line separators cannot turn authored text into a header.
 */
export const stripGitHunkSectionHeadingsForScopeScan = (patch: string): string =>
  patch.split("\n").map((line) => line.replace(
    /^(@@ -(?:0|[1-9][0-9]*)(?:,(?:0|[1-9][0-9]*))? \+(?:0|[1-9][0-9]*)(?:,(?:0|[1-9][0-9]*))? @@) [^\r\n\u2028\u2029]*$/u,
    "$1",
  )).join("\n");

type GitHistorySpawnResult = Readonly<{
  exitCode: number;
  exitedDueToMaxBuffer: boolean;
  exitedDueToTimeout: boolean;
  stderr: Buffer;
  stdout: Buffer;
}>;

export const buildGitHistoryEnvironment = (
  repositoryRoot: string,
  temporaryDirectory: string,
): NodeJS.ProcessEnv => {
  if (
    !isAbsolute(repositoryRoot)
    || resolve(repositoryRoot) !== repositoryRoot
    || !isAbsolute(temporaryDirectory)
    || resolve(temporaryDirectory) !== temporaryDirectory
  ) {
    throw new Error("Git history command directories must be absolute and normalized.");
  }
  return Object.freeze({
    GIT_ATTR_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_NO_LAZY_FETCH: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
    HOME: repositoryRoot,
    LANG: "C",
    LC_ALL: "C",
    PATH: "/usr/bin:/bin",
    TMPDIR: temporaryDirectory,
    XDG_CONFIG_HOME: "/dev/null",
  });
};

export const projectGitHistorySpawnResult = (
  result: GitHistorySpawnResult,
): ProcessResult => {
  const outputBytes = result.stdout.byteLength + result.stderr.byteLength;
  if (
    !Number.isSafeInteger(outputBytes)
    || outputBytes > gitHistoryCommandOutputMaximumBytes
    || result.exitCode !== 0
    || result.exitedDueToMaxBuffer
    || result.exitedDueToTimeout
    || result.stderr.byteLength !== 0
  ) {
    return { exitCode: 1, stderr: "", stdout: "" };
  }
  const stdout = result.stdout.toString("utf8");
  if (Buffer.byteLength(stdout, "utf8") > gitHistoryCommandOutputMaximumBytes) {
    return { exitCode: 1, stderr: "", stdout: "" };
  }
  return { exitCode: 0, stderr: "", stdout };
};

export const gitHistoryCommandArguments = (command: GitHistoryCommand): readonly string[] => {
  if (command.kind === "shallow") {
    return ["--no-replace-objects", "rev-parse", "--is-shallow-repository"];
  }
  if (command.kind === "enumerate") {
    return ["--no-replace-objects", "rev-list", "--max-count=100001", "--all"];
  }
  if (!gitCommitPattern.test(command.commit)) {
    throw new Error("Git history patch requested a malformed commit.");
  }
  const common = [
    "-c",
    "core.attributesFile=/dev/null",
    "-c",
    "core.quotePath=true",
    "-c",
    "diff.mnemonicPrefix=false",
    "-c",
    "diff.noprefix=false",
    "-c",
    "diff.orderFile=/dev/null",
    "-c",
    "diff.relative=false",
    "-c",
    "diff.suppressBlankEmpty=false",
    "--no-replace-objects",
    "show",
    "--format=",
    "--patch",
    "--text",
    "--root",
    "--diff-merges=first-parent",
    "--no-ext-diff",
    "--no-textconv",
    "--full-index",
    "--no-color",
    "--no-renames",
    "--unified=3",
    "--inter-hunk-context=0",
    "--diff-algorithm=myers",
    "--no-indent-heuristic",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    "--output-indicator-new=+",
    "--output-indicator-old=-",
    "--output-indicator-context= ",
    "--submodule=short",
    command.commit,
  ];
  return command.kind === "sensitive_patch"
    ? common
    : [...common, "--", ".", ":(exclude)bun.lock"];
};

const runGitHistoryCommand = (
  repositoryRoot: string,
  temporaryDirectory: string,
  command: GitHistoryCommand,
  timeoutMs: number,
): ProcessResult => {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    return { exitCode: 1, stderr: "", stdout: "" };
  }
  try {
    const result = Bun.spawnSync({
      cmd: ["/usr/bin/git", "--no-pager", ...gitHistoryCommandArguments(command)],
      cwd: repositoryRoot,
      env: buildGitHistoryEnvironment(repositoryRoot, temporaryDirectory),
      killSignal: "SIGKILL",
      maxBuffer: gitHistoryCommandOutputMaximumBytes,
      stderr: "pipe",
      stdin: "ignore",
      stdout: "pipe",
      timeout: Math.min(timeoutMs, gitHistoryCommandTimeoutMaximumMs),
    });
    return projectGitHistorySpawnResult({
      exitCode: result.exitCode,
      exitedDueToMaxBuffer: result.exitedDueToMaxBuffer ?? false,
      exitedDueToTimeout: result.exitedDueToTimeout ?? false,
      stderr: result.stderr,
      stdout: result.stdout,
    });
  } catch {
    return { exitCode: 1, stderr: "", stdout: "" };
  }
};

export const parseGitHistoryCommitList = (value: string): readonly string[] => {
  const commits = value.endsWith("\n")
    ? value.slice(0, -1).split("\n")
    : value.split("\n");
  if (
    commits.length < 1
    || commits.length > gitHistoryCommitMaximum
    || commits.some((commit) => !gitCommitPattern.test(commit))
    || new Set(commits).size !== commits.length
  ) {
    throw new Error("Git history enumeration was empty, malformed, duplicate, or over its commit bound.");
  }
  return Object.freeze(commits);
};

export const assertGitHistoryPatchPublicText = (patch: string, label: string): void => {
  assertPublicSensitiveText(patch, label);
  assertPublicText(stripGitHunkSectionHeadingsForScopeScan(patch), label);
};

export const assertCompleteGitHistoryPublic = async (repositoryRoot: string): Promise<void> => {
  const temporaryDirectory = await realpath(tmpdir());
  const startedAt = performance.now();
  let scannedOutputBytes = 0;
  const readHistory = (command: GitHistoryCommand): ProcessResult => {
    const remainingMs = Math.floor(gitHistoryScanTimeoutMs - (performance.now() - startedAt));
    if (remainingMs < 1) {
      throw new Error("Git history scan exceeded its aggregate time bound.");
    }
    const result = runGitHistoryCommand(
      repositoryRoot,
      temporaryDirectory,
      command,
      remainingMs,
    );
    scannedOutputBytes += Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr);
    if (scannedOutputBytes > gitHistoryScanOutputMaximumBytes) {
      throw new Error("Git history scan exceeded its aggregate output bound.");
    }
    return result;
  };
  const shallow = requireGitHistoryOutput(
    "Git history shallow-repository check",
    readHistory({ kind: "shallow" }),
  );
  if (shallow !== "false\n") {
    throw new Error("Git history scan requires one exact non-shallow repository.");
  }
  const enumerate = async (): Promise<readonly string[]> => parseGitHistoryCommitList(
    requireGitHistoryOutput(
      "Git history enumeration",
      readHistory({ kind: "enumerate" }),
    ),
  );
  const commits = await enumerate();

  for (const commit of commits) {
    const completePatch = requireGitHistoryOutput(
      `Git history sensitive-text commit ${commit}`,
      readHistory({ commit, kind: "sensitive_patch" }),
    );
    assertPublicSensitiveText(
      normalizeGitHistoryPatchForPublicScan(commit, "sensitive_patch", completePatch),
      `Git history commit ${commit}`,
    );

    const authoredPatch = requireGitHistoryOutput(
      `Git history public-text commit ${commit}`,
      readHistory({ commit, kind: "public_patch" }),
    );
    assertGitHistoryPatchPublicText(
      normalizeGitHistoryPatchForPublicScan(commit, "public_patch", authoredPatch),
      `Git history commit ${commit}`,
    );
  }

  const finalCommits = await enumerate();
  const initialCommitSet = new Set(commits);
  if (
    finalCommits.length !== commits.length
    || finalCommits.some((commit) => !initialCommitSet.has(commit))
  ) {
    throw new Error("Git refs changed while complete history was being scanned.");
  }
  if (performance.now() - startedAt > gitHistoryScanTimeoutMs) {
    throw new Error("Git history scan exceeded its aggregate time bound.");
  }
};

const assertSessionObservationHelp = (label: string, result: ProcessResult): void => {
  requireSuccess(label, result);
  if (result.stderr !== "") throw new Error(`${label} wrote diagnostics.`);
  for (const command of [
    "oompa session status <session> [--json]",
    "oompa session watch <session> [--cursor <cursor>] [--jsonl]",
    "oompa session events <session> [--cursor <cursor>] [--limit <1..200>] [--wait-ms <0..30000>] [--json|--jsonl|--follow]",
  ]) {
    if (!result.stdout.includes(command)) {
      throw new Error(`${label} omitted ${command}.`);
    }
  }
  if (/\bhra session wait\b/u.test(result.stdout)) {
    throw new Error(`${label} exposed the withheld session wait command.`);
  }
};

const assertExactlyOneJsonValue = (value: string): unknown => {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new Error("Expected one JSON value on stdout.");
  try {
    return JSON.parse(trimmed) as unknown;
  } catch (error: unknown) {
    throw new Error("CLI stdout was not exactly one JSON value.", { cause: error });
  }
};

const processIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
};

const launchOwnedInstalledDaemon = async (input: Readonly<{
  cwd: string;
  env: NodeJS.ProcessEnv;
  executable: string;
}>): Promise<OwnedInstalledDaemon> => {
  const child = spawn(input.executable, ["daemon", "run"], {
    cwd: input.cwd,
    env: input.env,
    stdio: ["ignore", "ignore", "ignore"],
  });
  // Keep every post-construction child error observed. The spawn-specific
  // listener below still turns a failed launch into the lifecycle error.
  child.on("error", () => undefined);
  let exitObservation: OwnedDaemonExit | null = null;
  const exited = new Promise<OwnedDaemonExit>((resolveExit) => {
    child.once("close", (exitCode, signal) => {
      exitObservation = { exitCode, signal };
      resolveExit(exitObservation);
    });
  });
  await new Promise<void>((resolveSpawn, rejectSpawn) => {
    const onError = (error: Error) => {
      child.off("spawn", onSpawn);
      rejectSpawn(error);
    };
    const onSpawn = () => {
      child.off("error", onError);
      resolveSpawn();
    };
    child.once("error", onError);
    child.once("spawn", onSpawn);
  });
  const pid = child.pid;
  if (pid === undefined) {
    child.kill("SIGKILL");
    throw new InstalledDaemonOwnershipError();
  }
  return {
    child,
    exited,
    exitObservation: () => exitObservation,
    pid,
  };
};

export const waitForOwnedInstalledDaemonReady = async (input: Readonly<{
  daemon: Pick<OwnedInstalledDaemon, "exitObservation" | "pid">;
  queryStatus: () => Promise<DaemonIdentity | null>;
  readReceipt: () => Promise<DaemonAuthorityReceipt | null>;
  deadlineMs?: number;
  now?: () => number;
  pollMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}>): Promise<DaemonIdentity> => {
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? (async (milliseconds: number) => { await Bun.sleep(milliseconds); });
  const deadline = now() + (input.deadlineMs ?? 30_000);
  let lastReceipt: DaemonAuthorityReceipt | null = null;
  let lastStatusError: Error | undefined;
  while (now() <= deadline) {
    const exited = input.daemon.exitObservation();
    if (exited !== null) {
      throw new Error(
        `The owned installed daemon pid ${String(input.daemon.pid)} exited before readiness with ${
          exited.exitCode === null ? exited.signal ?? "an unknown signal" : `status ${String(exited.exitCode)}`
        }.`,
      );
    }
    lastReceipt = await input.readReceipt();
    if (
      lastReceipt !== null
      && lastReceipt.pid !== input.daemon.pid
      && (lastReceipt.state === "booting" || lastReceipt.state === "ready" || lastReceipt.state === "maintenance")
    ) {
      throw new Error(
        `The installed daemon authority belongs to unexpected pid ${String(lastReceipt.pid)} instead of owned pid ${String(input.daemon.pid)}.`,
      );
    }
    if (lastReceipt?.pid === input.daemon.pid && lastReceipt.state === "failed") {
      throw new Error(`The owned installed daemon failed before readiness: ${lastReceipt.failure ?? "unknown failure"}`);
    }
    if (lastReceipt?.pid === input.daemon.pid && lastReceipt.state === "ready") {
      const receiptIdentity = identityFromReceipt(lastReceipt);
      if (receiptIdentity === null) {
        throw new Error("The owned installed daemon published a ready receipt without a complete identity.");
      }
      try {
        const statusIdentity = await input.queryStatus();
        if (statusIdentity !== null && sameDaemonIdentity(receiptIdentity, statusIdentity)) {
          return statusIdentity;
        }
        lastStatusError = new Error("The installed daemon status did not match its owned ready receipt.");
      } catch (error: unknown) {
        lastStatusError = error instanceof Error
          ? error
          : new Error("The installed daemon status query threw a non-Error value.");
      }
    }
    await sleep(input.pollMs ?? 25);
  }
  const receiptState = lastReceipt === null
    ? "no receipt"
    : `${lastReceipt.state} receipt for pid ${String(lastReceipt.pid)}`;
  const statusState = lastStatusError === undefined ? "" : ` Last status: ${lastStatusError.message}`;
  throw new Error(
    `Owned installed daemon pid ${String(input.daemon.pid)} did not become ready before the deadline (${receiptState}).${statusState}`,
  );
};

const socketExists = async (paths: StatePaths): Promise<boolean> => {
  try {
    await lstat(paths.socket);
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
};

const waitForOwnedInstalledDaemonRelease = async (input: Readonly<{
  daemon: OwnedInstalledDaemon;
  paths: StatePaths;
  deadlineMs?: number;
  now?: () => number;
  pollMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}>): Promise<void> => {
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? (async (milliseconds: number) => { await Bun.sleep(milliseconds); });
  const deadline = now() + (input.deadlineMs ?? 10_000);
  let stableReleasedObservations = 0;
  while (now() <= deadline) {
    const exited = input.daemon.exitObservation() !== null;
    const processAlive = processIsAlive(input.daemon.pid);
    const authorityHeld = await DaemonLock.isAuthorityHeld(input.paths);
    const socketPresent = await socketExists(input.paths);
    if (exited && !processAlive && !authorityHeld && !socketPresent) {
      stableReleasedObservations += 1;
      if (stableReleasedObservations >= 2) return;
    } else {
      stableReleasedObservations = 0;
    }
    await sleep(input.pollMs ?? 25);
  }
  throw new Error(
    `Owned installed daemon pid ${String(input.daemon.pid)} did not prove process exit, authority release, and socket removal before the cleanup deadline.`,
  );
};

const terminateOwnedInstalledDaemon = async (daemon: OwnedInstalledDaemon): Promise<void> => {
  if (daemon.exitObservation() !== null) return;
  await terminateDaemonStartupChild({
    exited: daemon.exited.then((exit) => exit.exitCode ?? 1),
    kill: (signal) => { daemon.child.kill(signal); },
  });
};

export async function checkPackage(suppliedArchive?: string): Promise<void> {
const repositoryRoot = resolve(import.meta.dir, "..");
const packageJson = packageSchema.parse(
  JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8")) as unknown,
);
assertOompaInstallManifest(packageJson);
if (!packageJson.files.includes("src")) throw new Error("The package must include src.");
if (!packageJson.files.includes("!src/cloud/inviteAuthority.ts")) {
  throw new Error("The package must exclude operator-only invite authority.");
}
if (!packageJson.files.includes("!src/storage/legacy-secret-migration.ts")) {
  throw new Error("The package must exclude the checkout-only legacy secret migration implementation.");
}
await access(join(repositoryRoot, "src", "storage", "legacy-secret-migration.ts"), constants.R_OK);

await assertPublicCheckout(repositoryRoot);
await assertCompleteGitHistoryPublic(repositoryRoot);

await assertPackageContentAt(repositoryRoot);
const dependencyCacheRoot = await resolvePackageDependencyCache(repositoryRoot);

const temporaryRoot = await realpath(await mkdtemp(join(tmpdir(), "hra-package-")));
let removeTemporaryRoot = true;
try {
  const packageDirectory = join(temporaryRoot, "package");
  const consumerDirectory = join(temporaryRoot, "consumer");
  const consumerHome = join(temporaryRoot, "home");
  const consumerTemporaryDirectory = join(temporaryRoot, "tmp");
  const globalInstallRoot = join(temporaryRoot, "bun-global");
  const runtimeBin = join(temporaryRoot, "runtime-bin");
  const xdgCache = join(consumerHome, ".cache");
  const xdgConfig = join(consumerHome, ".config");
  const xdgData = join(consumerHome, ".local", "share");
  const xdgState = join(consumerHome, ".local", "state");
  await mkdir(packageDirectory, { recursive: true, mode: 0o700 });
  await mkdir(consumerDirectory, { recursive: true, mode: 0o700 });
  await mkdir(consumerHome, { recursive: true, mode: 0o700 });
  await mkdir(consumerTemporaryDirectory, { recursive: true, mode: 0o700 });
  await mkdir(globalInstallRoot, { recursive: true, mode: 0o700 });
  await mkdir(runtimeBin, { recursive: true, mode: 0o700 });
  for (const directory of [xdgCache, xdgConfig, xdgData, xdgState]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  }
  await symlink(process.execPath, join(runtimeBin, "bun"));

  const expectedArchiveName = `hraness-oompa-${packageJson.version}.tgz`;
  let archive: string;
  if (suppliedArchive === undefined) {
    requireSuccess(
      "package archive creation",
      await run("npm", ["pack", "--ignore-scripts", "--pack-destination", packageDirectory, "."], { cwd: repositoryRoot }),
    );
    archive = join(packageDirectory, expectedArchiveName);
  } else {
    archive = resolve(suppliedArchive);
    const archiveMetadata = await lstat(archive);
    if (
      archive !== suppliedArchive
      || basename(archive) !== expectedArchiveName
      || !archiveMetadata.isFile()
      || archiveMetadata.isSymbolicLink()
      || archiveMetadata.nlink !== 1
      || archiveMetadata.size < 1
      || archiveMetadata.size > 64 * 1024 * 1024
      || await realpath(archive) !== archive
    ) {
      throw new Error(`Supplied package archive must be one exact bounded ${expectedArchiveName} regular file.`);
    }
  }
  const inspectionDirectory = join(temporaryRoot, "inspection");
  await mkdir(inspectionDirectory, { recursive: true, mode: 0o700 });
  requireSuccess(
    "package archive extraction",
    await run("tar", ["-xzpf", archive, "-C", inspectionDirectory], { cwd: repositoryRoot }),
  );
  await assertPublicTree(inspectionDirectory);
  await assertProductionPackageOnly(inspectionDirectory);
  await assertPackageContentAt(join(inspectionDirectory, "package"));
  await assertReviewedReleaseInventory(join(inspectionDirectory, "package"));
  assertOompaInstallManifest(
    JSON.parse(await readFile(join(inspectionDirectory, "package", "package.json"), "utf8")) as unknown,
  );
  try {
    await access(
      join(inspectionDirectory, "package", "src", "storage", "legacy-secret-migration.ts"),
      constants.F_OK,
    );
    throw new Error("The package archive contains the checkout-only legacy secret migration implementation.");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await writeFile(
    join(consumerDirectory, "package.json"),
    `${JSON.stringify({ name: "hra-package-smoke", private: true, type: "module" }, null, 2)}\n`,
    { encoding: "utf8", flag: "wx" },
  );
  const isolatedEnvironment: NodeJS.ProcessEnv = {
    ...process.env,
    HRANESS_SUPPORT_AUDIENCE: "off",
    HRANESS_SUPPORT_EMAIL: "off",
    BUN_INSTALL: globalInstallRoot,
    BUN_INSTALL_BIN: join(globalInstallRoot, "bin"),
    BUN_INSTALL_CACHE_DIR: dependencyCacheRoot,
    BUN_INSTALL_GLOBAL_DIR: join(globalInstallRoot, "install", "global"),
    HOME: consumerHome,
    TMPDIR: consumerTemporaryDirectory,
  };
  const installGlobalTransaction = async (label: string): Promise<void> => {
    const preflight = requireSuccess(
      label,
      await withPackageDependencyCacheCustody(dependencyCacheRoot, async () =>
        await run(process.execPath, [join(repositoryRoot, "src", "install-preflight.ts"), archive], {
          cwd: consumerDirectory,
          env: isolatedEnvironment,
          phase: "package-transactional-global-install",
        })),
    );
    if (preflight.stderr !== "" || preflight.stdout !== `${OOMPA_INSTALL_PREFLIGHT_SUCCESS}\n`) {
      throw new Error(`${label} did not return its one exact success token.`);
    }
  };
  requireSuccess(
    "clean lifecycle-disabled consumer install",
    await withPackageDependencyCacheCustody(dependencyCacheRoot, async () =>
      await run(process.execPath, ["add", "--backend=copyfile", "--ignore-scripts", archive], {
        cwd: consumerDirectory,
        env: isolatedEnvironment,
      })),
  );
  const localPackageRoot = join(consumerDirectory, "node_modules", "@hraness", "oompa");
  const executable = join(consumerDirectory, "node_modules", ".bin", "oompa");
  assertOompaInstallManifest(
    JSON.parse(await readFile(join(localPackageRoot, "package.json"), "utf8")) as unknown,
  );
  if (((await lstat(join(localPackageRoot, "src", "cli.ts"))).mode & 0o777) !== 0o777) {
    throw new Error("Bun's lifecycle-disabled local install no longer exhibits the reviewed mode-0777 bin-target behavior.");
  }
  requireSuccess(
    "explicit local install normalization",
    await run(process.execPath, [join(localPackageRoot, "src", "install-normalizer.ts")], {
      cwd: consumerDirectory,
      env: isolatedEnvironment,
    }),
  );
  await assertProductionPackageOnly(localPackageRoot, "installed");
  z.object({
    dependencies: z.record(z.string(), z.string()).refine((value) => Object.hasOwn(value, "@hraness/oompa")),
    trustedDependencies: z.undefined().optional(),
  }).passthrough().parse(
    JSON.parse(await readFile(join(consumerDirectory, "package.json"), "utf8")) as unknown,
  );
  requireSuccess(
    "side-effect-free package import",
    await run(process.execPath, ["-e", "await import('@hraness/oompa')"], {
      cwd: consumerDirectory,
      env: isolatedEnvironment,
    }),
  );

  const help = requireSuccess(
    "installed CLI help",
    await run(executable, ["--help"], { cwd: consumerDirectory, env: isolatedEnvironment }),
  );
  if (!help.stdout.startsWith("Oompa\n")) throw new Error("Installed CLI help has an unexpected header.");
  if (help.stderr !== "") throw new Error("Installed CLI help wrote diagnostics.");
  assertSessionObservationHelp(
    "installed session help",
    await run(executable, ["session", "--help"], {
      cwd: consumerDirectory,
      env: isolatedEnvironment,
    }),
  );

  const version = requireSuccess(
    "installed CLI version",
    await run(executable, ["--version"], { cwd: consumerDirectory, env: isolatedEnvironment }),
  );
  if (version.stdout !== `oompa ${packageJson.version}\n` || version.stderr !== "") {
    throw new Error("Installed CLI version does not match package.json.");
  }

  const doctor = await run(executable, ["doctor", "--offline", "--json"], {
    cwd: consumerDirectory,
    env: isolatedEnvironment,
  });
  const doctorValue = assertExactlyOneJsonValue(doctor.stdout);
  const doctorSchema = z.object({
    data: z.object({ offline: z.literal(true) }).passthrough(),
    ok: z.literal(true),
    version: z.literal(1),
  }).passthrough();
  doctorSchema.parse(doctorValue);
  if (doctor.stderr !== "") throw new Error("JSON doctor wrote diagnostics to stderr.");
  if (doctor.exitCode !== 0) throw new Error("Offline doctor failed in the clean consumer.");

  await installGlobalTransaction("transactional lifecycle-disabled global consumer install");
  const globalExecutable = join(globalInstallRoot, "bin", "oompa");
  const activeGlobalCommand = await lstat(globalExecutable);
  const uid = process.getuid?.();
  if (
    uid === undefined
    || !activeGlobalCommand.isSymbolicLink()
    || activeGlobalCommand.nlink !== 1
    || activeGlobalCommand.uid !== uid
  ) {
    throw new Error("The active global Oompa command is not one exact current-user symlink.");
  }
  const globalCli = await realpath(globalExecutable);
  const globalPackageRoot = dirname(dirname(globalCli));
  const globalVersionRoot = resolve(globalPackageRoot, "..", "..", "..", "..", "..");
  if (!globalVersionRoot.startsWith(`${join(globalInstallRoot, "install", "oompa", "versions")}${sep}`)) {
    throw new Error("The active global Oompa command is outside its protected complete-version root.");
  }
  assertOompaInstallManifest(
    JSON.parse(await readFile(join(globalPackageRoot, "package.json"), "utf8")) as unknown,
  );
  if (((await lstat(globalCli)).mode & 0o777) !== 0o755) {
    throw new Error("The transactional global install did not publish its reviewed mode-0755 CLI.");
  }
  const globalNormalizer = join(globalPackageRoot, "src", "install-normalizer.ts");
  await access(globalNormalizer, constants.R_OK);
  await assertProductionPackageOnly(globalPackageRoot, "installed");
  z.object({
    dependencies: z.record(z.string(), z.string()).refine((value) => Object.hasOwn(value, "@hraness/oompa")),
    trustedDependencies: z.undefined().optional(),
  }).passthrough().parse(
    JSON.parse(
      await readFile(join(globalVersionRoot, "install", "global", "package.json"), "utf8"),
    ) as unknown,
  );
  if (await Bun.file(join(globalInstallRoot, "install", "global", "node_modules", "@hraness", "oompa")).exists()) {
    throw new Error("The transactional global install exposed Oompa in Bun's final global package path.");
  }
  const globalHelp = requireSuccess(
    "global CLI help",
    await run(globalExecutable, ["--help"], { cwd: consumerDirectory, env: isolatedEnvironment }),
  );
  if (!globalHelp.stdout.startsWith("Oompa\n") || globalHelp.stderr !== "") {
    throw new Error("Globally installed CLI help is invalid.");
  }
  assertSessionObservationHelp(
    "globally installed session help",
    await run(globalExecutable, ["session", "--help"], {
      cwd: consumerDirectory,
      env: isolatedEnvironment,
    }),
  );
  const withheldWait = await run(globalExecutable, ["session", "wait", "withheld"], {
    cwd: consumerDirectory,
    env: isolatedEnvironment,
  });
  if (
    withheldWait.exitCode !== 2
    || withheldWait.stdout !== ""
    || !withheldWait.stderr.includes("Unknown session action")
  ) {
    throw new Error("Globally installed CLI did not reject the withheld session wait command.");
  }
  const globalDoctor = await run(globalExecutable, ["doctor", "--offline", "--json"], {
    cwd: consumerDirectory,
    env: isolatedEnvironment,
  });
  doctorSchema.parse(assertExactlyOneJsonValue(globalDoctor.stdout));
  if (globalDoctor.stderr !== "" || globalDoctor.exitCode !== 0) {
    throw new Error("Globally installed CLI offline doctor failed.");
  }

  const daemonEnvironment: NodeJS.ProcessEnv = {
    ...isolatedEnvironment,
    CODEX_ELECTRON_USER_DATA_PATH: undefined,
    CODEX_HOME: undefined,
    HRA_CONVEX_URL: "",
    NODE_PATH: undefined,
    PATH: runtimeBin,
    XDG_CACHE_HOME: xdgCache,
    XDG_CONFIG_HOME: xdgConfig,
    XDG_DATA_HOME: xdgData,
    XDG_STATE_HOME: xdgState,
  };
  const daemonPaths = resolveStatePaths({
    homeDirectory: consumerHome,
    platform: process.platform,
  });
  const lifecycleTimeoutMs = 45_000;
  let lifecycleComplete = false;
  let ownedDaemon: OwnedInstalledDaemon | undefined;
  let lifecycleError: Error | undefined;
  try {
    const initialized = await runInPseudoTerminal({
      command: [globalExecutable, "init", "--yes"],
      cwd: consumerDirectory,
      environment: daemonEnvironment,
      steps: [
        { expect: PTY_BEGIN_MARKER },
        { expect: "Oompa is ready." },
        { expect: "Next: oompa account add Personal" },
      ],
      temporaryDirectory: temporaryRoot,
      timeoutMs: lifecycleTimeoutMs,
    });
    assertPseudoTerminalSuccess(initialized);
    const initializedDocuments = await lstat(join(consumerHome, "Documents"));
    if (!initializedDocuments.isDirectory() || initializedDocuments.isSymbolicLink()) {
      throw new Error("Globally installed CLI initialization did not create a safe default Documents directory in an empty home.");
    }

    const rootStatusAuthorityBefore = await readDaemonAuthorityReceipt(daemonPaths);
    if (await socketExists(daemonPaths)) {
      throw new Error("Globally installed initialization unexpectedly created a daemon socket.");
    }
    const rootStatusResult = requireSuccess(
      "globally installed root status",
      await run(globalExecutable, ["status", "--json"], {
        cwd: consumerDirectory,
        env: daemonEnvironment,
        timeoutMs: lifecycleTimeoutMs,
      }),
    );
    if (rootStatusResult.stderr !== "") {
      throw new Error("Globally installed root status wrote diagnostics.");
    }
    installedRootStatusEnvelopeSchema.parse(
      assertExactlyOneJsonValue(rootStatusResult.stdout),
    );
    if (
      !isDeepStrictEqual(
        await readDaemonAuthorityReceipt(daemonPaths),
        rootStatusAuthorityBefore,
      )
      || await socketExists(daemonPaths)
    ) {
      throw new Error("Globally installed root status changed daemon authority or created a daemon socket.");
    }

    ownedDaemon = await launchOwnedInstalledDaemon({
      cwd: consumerDirectory,
      env: daemonEnvironment,
      executable: globalExecutable,
    });
    const queryInstalledDaemonStatus = async (): Promise<DaemonIdentity | null> => {
      const status = await run(globalExecutable, ["daemon", "status", "--json"], {
        cwd: consumerDirectory,
        env: daemonEnvironment,
        timeoutMs: 2_000,
      });
      if (status.exitCode !== 0) return null;
      if (status.stderr !== "") {
        throw new Error("Globally installed daemon status wrote diagnostics.");
      }
      return daemonRunningSchema.parse(assertExactlyOneJsonValue(status.stdout)).data.daemon;
    };
    const readyIdentity = await waitForOwnedInstalledDaemonReady({
      daemon: ownedDaemon,
      queryStatus: queryInstalledDaemonStatus,
      readReceipt: async () => await readDaemonAuthorityReceipt(daemonPaths),
    });
    if (readyIdentity.pid !== ownedDaemon.pid) {
      throw new Error("The installed daemon ready identity does not belong to the directly owned process.");
    }

    const status = requireSuccess(
      "globally installed daemon status",
      await run(globalExecutable, ["daemon", "status", "--json"], {
        cwd: consumerDirectory,
        env: daemonEnvironment,
        timeoutMs: lifecycleTimeoutMs,
      }),
    );
    const statusIdentity = daemonRunningSchema.parse(assertExactlyOneJsonValue(status.stdout)).data.daemon;
    if (!sameDaemonIdentity(readyIdentity, statusIdentity)) {
      throw new Error("The installed daemon status changed after owned readiness.");
    }
    if (status.stderr !== "") {
      throw new Error("Globally installed daemon status wrote diagnostics.");
    }

    const missingSessionId = `sess_${"f".repeat(32)}`;
    for (const [label, arguments_] of [
      [
        "globally installed session status path",
        ["session", "status", missingSessionId, "--json"],
      ],
      [
        "globally installed session events path",
        ["session", "events", missingSessionId, "--json"],
      ],
    ] as const) {
      const missing = await run(globalExecutable, arguments_, {
        cwd: consumerDirectory,
        env: daemonEnvironment,
        timeoutMs: lifecycleTimeoutMs,
      });
      installedMissingSessionErrorSchema.parse(assertExactlyOneJsonValue(missing.stdout));
      if (missing.exitCode !== installedNotFoundExitCode || missing.stderr !== "") {
        throw new Error(`${label} did not return one quiet typed error.`);
      }
    }
    const missingWatch = await run(
      globalExecutable,
      ["session", "watch", missingSessionId, "--jsonl"],
      {
        cwd: consumerDirectory,
        env: daemonEnvironment,
        timeoutMs: lifecycleTimeoutMs,
      },
    );
    installedMissingSessionErrorSchema.parse(assertExactlyOneJsonValue(missingWatch.stderr));
    if (missingWatch.exitCode !== installedNotFoundExitCode || missingWatch.stdout !== "") {
      throw new Error("Globally installed session watch path did not return one typed JSONL error.");
    }

    const accountSchema = z.object({
      id: z.string().min(1),
      label: z.literal("Package Audit"),
      processGeneration: z.literal(0),
      state: z.literal("signed_out"),
    }).passthrough();
    const addedAccount = requireSuccess(
      "globally installed pristine account creation",
      await run(globalExecutable, ["account", "add", "Package Audit", "--json"], {
        cwd: consumerDirectory,
        env: daemonEnvironment,
        timeoutMs: lifecycleTimeoutMs,
      }),
    );
    const addedAccountValue = z.object({
      data: z.object({ account: accountSchema }).passthrough(),
      ok: z.literal(true),
      version: z.literal(1),
    }).passthrough().parse(assertExactlyOneJsonValue(addedAccount.stdout));
    if (addedAccount.stderr !== "") {
      throw new Error("Globally installed pristine account creation wrote diagnostics.");
    }

    const shownAccount = requireSuccess(
      "globally installed pristine account read",
      await run(globalExecutable, ["account", "show", addedAccountValue.data.account.id, "--json"], {
        cwd: consumerDirectory,
        env: daemonEnvironment,
        timeoutMs: lifecycleTimeoutMs,
      }),
    );
    z.object({
      data: z.object({ account: accountSchema }).passthrough(),
      ok: z.literal(true),
      version: z.literal(1),
    }).passthrough().parse(assertExactlyOneJsonValue(shownAccount.stdout));
    if (shownAccount.stderr !== "") {
      throw new Error("Globally installed pristine account read wrote diagnostics.");
    }

    const duplicateAccount = await run(
      globalExecutable,
      ["account", "add", "PACKAGE AUDIT", "--json"],
      {
        cwd: consumerDirectory,
        env: daemonEnvironment,
        timeoutMs: lifecycleTimeoutMs,
      },
    );
    z.object({
      error: z.object({ code: z.literal("CONFLICT") }).passthrough(),
      ok: z.literal(false),
      version: z.literal(1),
    }).passthrough().parse(assertExactlyOneJsonValue(duplicateAccount.stdout));
    if (duplicateAccount.exitCode !== 1 || duplicateAccount.stderr !== "") {
      throw new Error("Globally installed duplicate account did not return one quiet conflict.");
    }

    for (const [label, arguments_, field, length] of [
      ["globally installed account list", ["account", "list", "--json"], "accounts", 1],
      ["globally installed project list", ["project", "list", "--json"], "projects", 1],
    ] as const) {
      const listing = requireSuccess(
        label,
        await run(globalExecutable, arguments_, {
          cwd: consumerDirectory,
          env: daemonEnvironment,
          timeoutMs: lifecycleTimeoutMs,
        }),
      );
      z.object({
        data: z.record(z.string(), z.unknown()).refine(
          (data) => Array.isArray(data[field]) && data[field].length === length,
          `${field} did not have the expected installed-state cardinality`,
        ),
        ok: z.literal(true),
        version: z.literal(1),
      }).passthrough().parse(assertExactlyOneJsonValue(listing.stdout));
      if (listing.stderr !== "") throw new Error(`${label} wrote diagnostics.`);
    }

    const shell = await runInPseudoTerminal({
      command: [globalExecutable],
      cwd: consumerDirectory,
      environment: daemonEnvironment,
      steps: [
        { expect: PTY_BEGIN_MARKER },
        { expect: "Oompa shell. /help lists commands; /exit leaves the daemon running." },
        { expect: "oompa> ", write: `/account ${addedAccountValue.data.account.id}\n` },
        { expect: `Selected account ${addedAccountValue.data.account.id}.` },
        { expect: "oompa[", write: "/session\n" },
        { expect: "No results." },
        { expect: "oompa[", write: "//slash-command\n" },
        {
          expect: "oompa: Select a session with /session <selector> before sending or following it.",
        },
        { expect: "oompa[", write: "/send /slash-command\n" },
        {
          expect: "oompa: Select a session with /session <selector> before sending or following it.",
        },
        { expect: "oompa[", write: "/exit\n" },
      ],
      temporaryDirectory: temporaryRoot,
      timeoutMs: lifecycleTimeoutMs,
    });
    assertPseudoTerminalSuccess(shell);

    const postShellStatus = requireSuccess(
      "globally installed post-shell daemon status",
      await run(globalExecutable, ["daemon", "status", "--json"], {
        cwd: consumerDirectory,
        env: daemonEnvironment,
        timeoutMs: lifecycleTimeoutMs,
      }),
    );
    const postShellIdentity = daemonRunningSchema.parse(
      assertExactlyOneJsonValue(postShellStatus.stdout),
    ).data.daemon;
    if (!sameDaemonIdentity(readyIdentity, postShellIdentity)) {
      throw new Error("The installed attached shell did not leave its exact daemon authority running.");
    }
    if (postShellStatus.stderr !== "") {
      throw new Error("Globally installed post-shell daemon status wrote diagnostics.");
    }

    const stopped = requireSuccess(
      "globally installed daemon stop",
      await run(globalExecutable, ["daemon", "stop", "--json"], {
        cwd: consumerDirectory,
        env: daemonEnvironment,
        timeoutMs: lifecycleTimeoutMs,
      }),
    );
    z.object({
      data: z.object({ released: z.literal(true) }).passthrough(),
      ok: z.literal(true),
      version: z.literal(1),
    }).passthrough().parse(assertExactlyOneJsonValue(stopped.stdout));
    if (stopped.stderr !== "") {
      throw new Error("Globally installed daemon stop wrote diagnostics.");
    }

    const stoppedStatus = requireSuccess(
      "globally installed stopped-daemon status",
      await run(globalExecutable, ["daemon", "status", "--json"], {
        cwd: consumerDirectory,
        env: daemonEnvironment,
        timeoutMs: lifecycleTimeoutMs,
      }),
    );
    z.object({
      data: z.object({ running: z.literal(false) }).passthrough(),
      ok: z.literal(true),
      version: z.literal(1),
    }).passthrough().parse(assertExactlyOneJsonValue(stoppedStatus.stdout));
    if (stoppedStatus.stderr !== "") {
      throw new Error("Stopped-daemon status wrote diagnostics.");
    }
    await waitForOwnedInstalledDaemonRelease({ daemon: ownedDaemon, paths: daemonPaths });
    lifecycleComplete = true;
  } catch (error: unknown) {
    lifecycleError = error instanceof Error
      ? error
      : new Error("Installed package acceptance threw a non-Error value.");
    if (error instanceof InstalledDaemonOwnershipError) removeTemporaryRoot = false;
  }
  if (!lifecycleComplete) {
    let terminateError: Error | undefined;
    let releaseError: Error | undefined;
    if (ownedDaemon !== undefined) {
      // A socket-addressed stop could target a replacement authority after the
      // readiness failure. Cleanup therefore signals only the retained child.
      try {
        await terminateOwnedInstalledDaemon(ownedDaemon);
      } catch (error: unknown) {
        terminateError = error instanceof Error
          ? error
          : new Error("Installed daemon exact termination threw a non-Error value.");
      }
      try {
        await waitForOwnedInstalledDaemonRelease({ daemon: ownedDaemon, paths: daemonPaths });
      } catch (error: unknown) {
        releaseError = error instanceof Error
          ? error
          : new Error("Installed daemon release proof threw a non-Error value.");
        removeTemporaryRoot = false;
      }
    }
    const errors = [lifecycleError, terminateError, releaseError]
      .filter((error): error is Error => error !== undefined);
    if (errors.length > 1 || (!removeTemporaryRoot && errors.length > 0)) {
      throw new AggregateError(
        errors,
        removeTemporaryRoot
          ? "Installed package acceptance failed, but exact daemon cleanup was proved."
          : `Installed package acceptance failed and daemon cleanup was not proved; evidence remains at ${temporaryRoot}.`,
      );
    }
    const onlyError = errors[0];
    if (onlyError !== undefined) throw onlyError;
  }
  if (lifecycleError !== undefined) throw lifecycleError;

  process.stdout.write(`Verified ${basename(archive)} in isolated local and global consumers, including a restored PTY shell and the global daemon lifecycle.\n`);
} finally {
  if (removeTemporaryRoot) {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
}
}

if (import.meta.main) {
  const arguments_ = process.argv.slice(2);
  if (arguments_.length > 1) throw new Error("Usage: check-package.ts [ABSOLUTE-ARTIFACT.tgz]");
  await checkPackage(arguments_[0]);
}
