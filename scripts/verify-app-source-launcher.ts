import { spawnSync, type StdioOptions } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readlinkSync,
  readSync,
  realpathSync,
  rmSync,
  type Stats,
} from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

const supportedBunVersion = "1.3.14";
const maximumOutputBytes = 64 * 1024;
const maximumSourceManifestBytes = 2 * 1024 * 1024;
const maximumCredentialBytes = 8 * 1024;
const sourceHashReadBytes = 64 * 1024;
const maximumCapturedSourceFiles = 4_096;
const maximumCapturedSourceFileBytes = 8 * 1024 * 1024;
const maximumCapturedSourceBytes = 128 * 1024 * 1024;
const sourceCommitPattern = /^[0-9a-f]{40}$/u;
const deploymentIdPattern = /^dpl_[A-Za-z0-9]{20,80}$/u;
const releaseVersionPattern = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u;
const publicRepositoryUrl = "https://github.com/hraness/oompa.git";

export const appSourceProofRuntimeInjectionEnvironmentNames = [
  "BUN_OPTIONS",
  "NODE_OPTIONS",
  "LD_AUDIT",
  "LD_LIBRARY_PATH",
  "LD_ORIGIN_PATH",
  "LD_PRELOAD",
  "DYLD_FALLBACK_FRAMEWORK_PATH",
  "DYLD_FALLBACK_LIBRARY_PATH",
  "DYLD_FRAMEWORK_PATH",
  "DYLD_IMAGE_SUFFIX",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "DYLD_ROOT_PATH",
  "DYLD_VERSIONED_FRAMEWORK_PATH",
  "DYLD_VERSIONED_LIBRARY_PATH",
] as const;

export const appSourceProofLauncherErrorCodes = [
  "usage_invalid",
  "runtime_environment_unsafe",
  "bun_version_unsupported",
  "verifier_source_invalid",
  "verifier_install_failed",
  "provider_credentials_refused",
  "verifier_execution_failed",
  "verifier_cleanup_failed",
] as const;

export type AppSourceProofLauncherErrorCode =
  (typeof appSourceProofLauncherErrorCodes)[number];

export class AppSourceProofLauncherError extends Error {
  constructor(readonly code: AppSourceProofLauncherErrorCode) {
    super(`Oompa app source proof launcher refused: ${code}`);
    this.name = "AppSourceProofLauncherError";
  }
}

type ProveArguments = Readonly<{
  deploymentId: string;
  evidencePath: string;
  mode: "prove";
  releaseVersion: string;
  sourceCommit: string;
  vercelAuthPath: string;
}>;

type VerifyRetainedArguments = Readonly<{
  evidencePath: string;
  mode: "verify-retained";
  releaseVersion: string;
  sourceCommit: string;
}>;

export type AppSourceProofLauncherArguments = ProveArguments | VerifyRetainedArguments;

type CommandCapacityArguments = Readonly<{
  mode: "command-capacity";
  operatorArguments: readonly string[];
  sourceCommit: string;
}>;

type QuotaUpgradeArguments = Readonly<{
  mode: "quota-upgrade";
  operatorArguments: readonly string[];
  sourceCommit: string;
}>;

export type HostedProtectedLauncherArguments =
  | AppSourceProofLauncherArguments
  | CommandCapacityArguments
  | QuotaUpgradeArguments;

type CommandResult = Readonly<{
  exitCode: number;
  signal: NodeJS.Signals | null;
  stderr: string;
  stdout: string;
}>;

type CommandOptions = Readonly<{
  credentialDescriptor?: number;
  cwd: string;
  environment?: Readonly<NodeJS.ProcessEnv>;
  maximumOutputBytes?: number;
}>;

type ScratchDirectoryIdentity = Readonly<{
  dev: number;
  ino: number;
  path: string;
}>;

export type AppSourceProofLauncherDependencies = Readonly<{
  closeCredential?: (descriptor: number) => void;
  createScratchDirectory?: () => string;
  cwd?: string;
  openCredential?: (path: string) => number;
  removeScratchDirectory?: (path: string) => void;
  runCommand?: (command: readonly string[], options: CommandOptions) => CommandResult;
  runtimePath?: string;
  runtimeArguments?: readonly string[];
  runtimeEnvironment?: Readonly<NodeJS.ProcessEnv>;
  runtimeVersion?: string;
  validateCredential?: (descriptor: number) => void;
}>;

function fail(code: AppSourceProofLauncherErrorCode): never {
  throw new AppSourceProofLauncherError(code);
}

const unsafeRuntimeArgument = (argument: string): boolean =>
  argument.startsWith("-r")
  || argument === "--preload"
  || argument.startsWith("--preload=")
  || argument === "--require"
  || argument.startsWith("--require=")
  || argument === "--import"
  || argument.startsWith("--import=")
  || argument === "--env-file"
  || argument.startsWith("--env-file=");

export const assertHardenedAppSourceProofStageZero = (
  runtimeArguments: readonly string[],
  environment: Readonly<NodeJS.ProcessEnv>,
): void => {
  const configArguments = runtimeArguments.filter(
    (argument) => argument === "-c" || argument.startsWith("--config"),
  );
  if (
    appSourceProofRuntimeInjectionEnvironmentNames.some(
      (name) => environment[name] !== undefined,
    )
    || runtimeArguments.filter((argument) => argument === "--no-env-file").length !== 1
    || configArguments.length !== 1
    || configArguments[0] !== "--config=/dev/null"
    || runtimeArguments.some(unsafeRuntimeArgument)
  ) fail("runtime_environment_unsafe");
};

const isNormalizedAbsolutePath = (value: string): boolean =>
  value.length > 0
  && value.length <= 4_096
  && isAbsolute(value)
  && resolve(value) === value;

const parsePairs = (
  values: readonly string[],
  allowed: ReadonlySet<string>,
): ReadonlyMap<string, string> => {
  const parsed = new Map<string, string>();
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index];
    const value = values[index + 1];
    if (
      name === undefined
      || value === undefined
      || !allowed.has(name)
      || parsed.has(name)
      || value.startsWith("--")
    ) fail("usage_invalid");
    parsed.set(name, value);
  }
  if (parsed.size !== allowed.size) fail("usage_invalid");
  return parsed;
};

export const parseAppSourceProofLauncherArguments = (
  arguments_: readonly string[],
): HostedProtectedLauncherArguments => {
  const [mode, ...rest] = arguments_;
  if (mode === "command-capacity" || mode === "quota-upgrade") {
    const sourceIndexes = rest
      .map((argument, index) => argument === "--source-commit" ? index : -1)
      .filter((index) => index >= 0);
    const sourceIndex = sourceIndexes[0];
    const sourceCommit = sourceIndex === undefined ? undefined : rest[sourceIndex + 1];
    if (
      sourceIndexes.length !== 1
      || sourceIndex === undefined
      || sourceCommit === undefined
      || !sourceCommitPattern.test(sourceCommit)
    ) fail("usage_invalid");
    return Object.freeze({
      mode,
      operatorArguments: Object.freeze([...rest]),
      sourceCommit,
    });
  }
  if (mode !== "prove" && mode !== "verify-retained") fail("usage_invalid");
  const shared = new Set(["--evidence-path", "--release-version", "--source-commit"]);
  const allowed = mode === "prove"
    ? new Set([...shared, "--deployment-id", "--vercel-auth-path"])
    : shared;
  const parsed = parsePairs(rest, allowed);
  const evidencePath = parsed.get("--evidence-path");
  const releaseVersion = parsed.get("--release-version");
  const sourceCommit = parsed.get("--source-commit");
  if (evidencePath === undefined || releaseVersion === undefined || sourceCommit === undefined) {
    fail("usage_invalid");
  }
  if (
    !isNormalizedAbsolutePath(evidencePath)
    || releaseVersion.length > 64
    || !releaseVersionPattern.test(releaseVersion)
    || !sourceCommitPattern.test(sourceCommit)
  ) fail("usage_invalid");
  if (mode === "verify-retained") {
    return Object.freeze({ evidencePath, mode, releaseVersion, sourceCommit });
  }
  const deploymentId = parsed.get("--deployment-id");
  const vercelAuthPath = parsed.get("--vercel-auth-path");
  if (deploymentId === undefined || vercelAuthPath === undefined) fail("usage_invalid");
  if (!deploymentIdPattern.test(deploymentId) || !isNormalizedAbsolutePath(vercelAuthPath)) {
    fail("usage_invalid");
  }
  return Object.freeze({
    deploymentId,
    evidencePath,
    mode,
    releaseVersion,
    sourceCommit,
    vercelAuthPath,
  });
};

export const appSourceProofChildEnvironment = (): NodeJS.ProcessEnv => ({
  GCM_INTERACTIVE: "never",
  GIT_ATTR_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_NO_REPLACE_OBJECTS: "1",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_TERMINAL_PROMPT: "0",
  LANG: "C",
  LC_ALL: "C",
  PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  SSH_ASKPASS_REQUIRE: "never",
  TMPDIR: "/tmp",
  TZ: "UTC",
});

export const commandCapacityChildEnvironment = (
  source: Readonly<NodeJS.ProcessEnv>,
): NodeJS.ProcessEnv => {
  const environment = appSourceProofChildEnvironment();
  for (const name of ["APPDATA", "HOME", "LOCALAPPDATA", "USERPROFILE", "XDG_CONFIG_HOME"] as const) {
    const value = source[name];
    if (value !== undefined && isNormalizedAbsolutePath(value)) environment[name] = value;
  }
  return environment;
};

export const appSourceProofGitCommand = (
  arguments_: readonly string[],
): readonly string[] => [
  "/usr/bin/git",
  "--no-replace-objects",
  "-c",
  "core.attributesFile=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.untrackedCache=false",
  "-c",
  "credential.helper=",
  ...arguments_,
];

const defaultRunCommand = (
  command: readonly string[],
  options: CommandOptions,
): CommandResult => {
  const [executable, ...arguments_] = command;
  if (executable === undefined) fail("verifier_execution_failed");
  const stdio: StdioOptions =
    options.credentialDescriptor === undefined
      ? ["ignore", "pipe", "pipe"]
      : ["ignore", "pipe", "pipe", options.credentialDescriptor];
  const result = spawnSync(executable, arguments_, {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.environment ?? appSourceProofChildEnvironment(),
    maxBuffer: options.maximumOutputBytes ?? maximumOutputBytes,
    stdio,
    timeout: 10 * 60 * 1_000,
    windowsHide: true,
  });
  return {
    exitCode: result.status ?? 1,
    signal: result.signal,
    stderr: result.stderr,
    stdout: result.stdout,
  };
};

const requireSuccessfulCommand = (
  result: CommandResult,
  code: AppSourceProofLauncherErrorCode,
  outputLimit = maximumOutputBytes,
): string => {
  if (result.exitCode !== 0 || result.signal !== null) fail(code);
  if (
    Buffer.byteLength(result.stdout, "utf8") > outputLimit
    || Buffer.byteLength(result.stderr, "utf8") > outputLimit
  ) fail(code);
  return result.stdout;
};

const requireSilentSuccessfulCommand = (
  result: CommandResult,
  code: AppSourceProofLauncherErrorCode,
  outputLimit = maximumOutputBytes,
): string => {
  const stdout = requireSuccessfulCommand(result, code, outputLimit);
  if (result.stderr !== "") fail(code);
  return stdout;
};

const exactRemoteMain = (value: string): string => {
  const match = /^([0-9a-f]{40})\trefs\/heads\/main\n?$/u.exec(value);
  return match?.[1] ?? fail("verifier_source_invalid");
};

const trustedScratchRoot = (): string => {
  const path = realpathSync("/tmp");
  const metadata = lstatSync(path);
  if (
    !isNormalizedAbsolutePath(path)
    || !metadata.isDirectory()
    || metadata.isSymbolicLink()
    || metadata.uid !== 0
    || (metadata.mode & 0o1777) !== 0o1777
  ) fail("verifier_install_failed");
  return path;
};

const assertTransparentIndex = (value: string): void => {
  const entries = value.split("\0").filter(Boolean);
  if (entries.some((entry) => entry[0] === "S" || /^[a-z]$/u.test(entry[0] ?? ""))) {
    fail("verifier_source_invalid");
  }
};

const checkoutTransformConfigPattern = /^(?:filter\.|core\.(?:attributesfile|autocrlf|eol|symlinks)$)/u;

const assertNoCheckoutTransformConfig = (document: string): void => {
  for (const entry of document.split("\0")) {
    if (entry === "") continue;
    const separator = entry.indexOf("\n");
    if (separator <= 0) fail("verifier_source_invalid");
    const name = entry.slice(0, separator).toLowerCase();
    const value = entry.slice(separator + 1);
    if (name === "core.attributesfile" && value === "/dev/null") continue;
    if (checkoutTransformConfigPattern.test(name)) fail("verifier_source_invalid");
  }
};

export const hasExactAppSourceProofOriginConfig = (document: string): boolean => {
  const fetchOrigins: string[] = [];
  const pushOrigins: string[] = [];
  for (const entry of document.split("\0")) {
    if (entry === "") continue;
    const separator = entry.indexOf("\n");
    if (separator <= 0) return false;
    const name = entry.slice(0, separator).toLowerCase();
    const value = entry.slice(separator + 1);
    if (name === "remote.origin.url") fetchOrigins.push(value);
    if (name === "remote.origin.pushurl") pushOrigins.push(value);
  }
  return fetchOrigins.length === 1
    && fetchOrigins[0] === publicRepositoryUrl
    && pushOrigins.length <= 1
    && (pushOrigins.length === 0 || pushOrigins[0] === publicRepositoryUrl);
};

type TrackedBlob = Readonly<{
  mode: "100644" | "100755" | "120000";
  objectId: string;
  path: string;
}>;

const parseCommittedTree = (document: string): ReadonlyMap<string, TrackedBlob> => {
  const tracked = new Map<string, TrackedBlob>();
  for (const entry of document.split("\0")) {
    if (entry === "") continue;
    const match = /^(100644|100755|120000) blob ([0-9a-f]{40})\t([\s\S]+)$/u.exec(entry);
    if (match === null) fail("verifier_source_invalid");
    const mode = match[1] as TrackedBlob["mode"];
    const objectId = match[2] as string;
    const path = match[3] as string;
    if (tracked.has(path)) fail("verifier_source_invalid");
    tracked.set(path, Object.freeze({ mode, objectId, path }));
  }
  if (tracked.size === 0) fail("verifier_source_invalid");
  return tracked;
};

const parseIndexTree = (document: string): ReadonlyMap<string, TrackedBlob> => {
  const tracked = new Map<string, TrackedBlob>();
  for (const entry of document.split("\0")) {
    if (entry === "") continue;
    const match = /^(100644|100755|120000) ([0-9a-f]{40}) 0\t([\s\S]+)$/u.exec(entry);
    if (match === null) fail("verifier_source_invalid");
    const mode = match[1] as TrackedBlob["mode"];
    const objectId = match[2] as string;
    const path = match[3] as string;
    if (tracked.has(path)) fail("verifier_source_invalid");
    tracked.set(path, Object.freeze({ mode, objectId, path }));
  }
  return tracked;
};

const sameFileIdentity = (
  left: Stats,
  right: Stats,
): boolean =>
  left.dev === right.dev
  && left.ino === right.ino
  && left.mode === right.mode
  && left.nlink === right.nlink
  && left.size === right.size
  && left.ctimeMs === right.ctimeMs
  && left.mtimeMs === right.mtimeMs;

const gitBlobDigest = (size: number, update: (hash: ReturnType<typeof createHash>) => void): string => {
  if (!Number.isSafeInteger(size) || size < 0) fail("verifier_source_invalid");
  const hash = createHash("sha1");
  hash.update(`blob ${String(size)}\0`, "utf8");
  update(hash);
  return hash.digest("hex");
};

const rawTrackedBlobDigest = (root: string, tracked: TrackedBlob, maximumBytes = Number.MAX_SAFE_INTEGER): Readonly<{ digest: string; bytes: number }> => {
  if (tracked.path === "" || isAbsolute(tracked.path)) fail("verifier_source_invalid");
  const path = resolve(root, tracked.path);
  if (path === root || !path.startsWith(`${root}${sep}`) || realpathSync(dirname(path)) !== dirname(path)) {
    fail("verifier_source_invalid");
  }
  const initial = lstatSync(path);
  if (!Number.isSafeInteger(initial.size) || initial.size < 0 || initial.size > maximumBytes) fail("verifier_source_invalid");
  if (tracked.mode === "120000") {
    if (!initial.isSymbolicLink()) fail("verifier_source_invalid");
    const target = readlinkSync(path, { encoding: "buffer" });
    const final = lstatSync(path);
    if (target.byteLength !== initial.size || !sameFileIdentity(initial, final)) {
      fail("verifier_source_invalid");
    }
    return { digest: gitBlobDigest(target.byteLength, (hash) => { hash.update(target); }), bytes: target.byteLength };
  }
  const executable = (initial.mode & 0o111) !== 0;
  if (
    !initial.isFile()
    || initial.isSymbolicLink()
    || executable !== (tracked.mode === "100755")
  ) fail("verifier_source_invalid");
  let descriptor = -1;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = fstatSync(descriptor);
    if (!sameFileIdentity(initial, opened) || !opened.isFile()) fail("verifier_source_invalid");
    const digest = gitBlobDigest(opened.size, (hash) => {
      const buffer = Buffer.allocUnsafe(sourceHashReadBytes);
      let remaining = opened.size;
      while (remaining > 0) {
        const count = readSync(descriptor, buffer, 0, Math.min(buffer.byteLength, remaining), null);
        if (count <= 0) fail("verifier_source_invalid");
        hash.update(buffer.subarray(0, count));
        remaining -= count;
      }
      const final = fstatSync(descriptor);
      if (!sameFileIdentity(opened, final) || !sameFileIdentity(final, lstatSync(path))) fail("verifier_source_invalid");
    });
    return { digest, bytes: opened.size };
  } finally {
    if (descriptor >= 0) closeSync(descriptor);
  }
};

const assertRawTrackedSource = (
  root: string,
  committed: ReadonlyMap<string, TrackedBlob>,
  index: ReadonlyMap<string, TrackedBlob>,
  captured = false,
): void => {
  if (committed.size !== index.size) fail("verifier_source_invalid");
  if (captured && committed.size > maximumCapturedSourceFiles) fail("verifier_source_invalid");
  let remaining = maximumCapturedSourceBytes;
  for (const [path, tracked] of committed) {
    if (captured && (path.length > 4_096 || resolve(root, path).length > 4_096
      || path.split("/").some((part) => part === "" || part === "." || part === ".."))) fail("verifier_source_invalid");
    const indexed = index.get(path);
    if (
      indexed === undefined
      || indexed.mode !== tracked.mode
      || indexed.objectId !== tracked.objectId
    ) fail("verifier_source_invalid");
    const observed = rawTrackedBlobDigest(root, tracked, captured ? Math.min(maximumCapturedSourceFileBytes, remaining) : undefined);
    if (observed.digest !== tracked.objectId) fail("verifier_source_invalid");
    if (captured) remaining -= observed.bytes;
  }
};

type CapturedSource = Readonly<{ sourceTree: string; committed: ReadonlyMap<string, TrackedBlob> }>;

const assertExactSource = (
  root: string,
  sourceCommit: string,
  runCommand: NonNullable<AppSourceProofLauncherDependencies["runCommand"]>,
  requireRemoteMain = true,
  capture = false,
): CapturedSource | undefined => {
  try {
    const git = (arguments_: readonly string[], outputLimit = maximumOutputBytes): string =>
      requireSilentSuccessfulCommand(
        runCommand(appSourceProofGitCommand(arguments_), { cwd: root, maximumOutputBytes: outputLimit }),
        "verifier_source_invalid",
        outputLimit,
      );
    if (git(["rev-parse", "--show-toplevel"]).trim() !== root) {
      fail("verifier_source_invalid");
    }
    if (git(["rev-parse", "--verify", "HEAD^{commit}"]).trim() !== sourceCommit) {
      fail("verifier_source_invalid");
    }
    if (git(["rev-parse", "--show-object-format"]).trim() !== "sha1") {
      fail("verifier_source_invalid");
    }
    const config = git(
      ["config", "--null", "--list"],
      maximumSourceManifestBytes,
    );
    assertNoCheckoutTransformConfig(config);
    if (!hasExactAppSourceProofOriginConfig(config)) fail("verifier_source_invalid");
    if (git(["status", "--porcelain=v1", "--untracked-files=all"]) !== "") {
      fail("verifier_source_invalid");
    }
    assertTransparentIndex(git(["ls-files", "-v", "-z"], maximumSourceManifestBytes));
    const committed = parseCommittedTree(git(
      ["ls-tree", "-r", "-z", "--full-tree", sourceCommit],
      maximumSourceManifestBytes,
    ));
    const index = parseIndexTree(git(
      ["ls-files", "--stage", "-z"],
      maximumSourceManifestBytes,
    ));
    assertRawTrackedSource(root, committed, index, capture);
    const fetchOrigins = git(["remote", "get-url", "--all", "origin"]).trim().split("\n");
    const pushOrigins = git(["remote", "get-url", "--push", "--all", "origin"]).trim().split("\n");
    if (
      fetchOrigins.length !== 1
      || pushOrigins.length !== 1
      || fetchOrigins[0] !== publicRepositoryUrl
      || pushOrigins[0] !== publicRepositoryUrl
    ) fail("verifier_source_invalid");
    if (requireRemoteMain) {
      const remoteMain = requireSilentSuccessfulCommand(runCommand(appSourceProofGitCommand([
        "ls-remote",
        "--heads",
        publicRepositoryUrl,
        "refs/heads/main",
      ]), { cwd: "/" }), "verifier_source_invalid");
      if (exactRemoteMain(remoteMain) !== sourceCommit) {
        fail("verifier_source_invalid");
      }
    }
    if (capture) {
      const sourceTree = git(["rev-parse", "--verify", `${sourceCommit}^{tree}`]).trim();
      if (!sourceCommitPattern.test(sourceTree)) fail("verifier_source_invalid");
      return { sourceTree, committed };
    }
  } catch (error: unknown) {
    if (error instanceof AppSourceProofLauncherError) throw error;
    fail("verifier_source_invalid");
  }
};

/** Recheck the operator's exact local source without network, installation or credentials. */
export const assertHostedOperatorSource = (
  { repositoryRoot, sourceCommit }: Readonly<{ repositoryRoot: string; sourceCommit: string }>,
): void => {
  try {
    if (
      !isNormalizedAbsolutePath(repositoryRoot)
      || realpathSync(repositoryRoot) !== repositoryRoot
      || !sourceCommitPattern.test(sourceCommit)
    ) fail("verifier_source_invalid");
    assertExactSource(repositoryRoot, sourceCommit, defaultRunCommand, false);
  } catch (error: unknown) {
    if (error instanceof AppSourceProofLauncherError) throw error;
    fail("verifier_source_invalid");
  }
};

/**
 * Admit exact local source once and retain its private bounded content manifest.
 * The synchronous fence performs no Git or subprocess work. It checks captured
 * tracked bytes/modes and root continuity, not later HEAD, index, origin,
 * untracked files or remote main. It grants no executable or owner authority.
 */
export const captureHostedOperatorSource = (
  { repositoryRoot, sourceCommit }: Readonly<{ repositoryRoot: string; sourceCommit: string }>,
): Readonly<{ sourceCommit: string; sourceTree: string; assertCapturedContentCurrent(): void }> => {
  try {
    if (!isNormalizedAbsolutePath(repositoryRoot) || repositoryRoot.length > 4_096
      || realpathSync(repositoryRoot) !== repositoryRoot || !sourceCommitPattern.test(sourceCommit)) fail("verifier_source_invalid");
    const root = lstatSync(repositoryRoot);
    if (!root.isDirectory() || root.isSymbolicLink()) fail("verifier_source_invalid");
    const assertRoot = (): void => {
      const current = lstatSync(repositoryRoot);
      if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== root.dev || current.ino !== root.ino
        || current.mode !== root.mode || current.uid !== root.uid || realpathSync(repositoryRoot) !== repositoryRoot) fail("verifier_source_invalid");
    };
    const admitted = assertExactSource(repositoryRoot, sourceCommit, defaultRunCommand, false, true);
    if (admitted === undefined) fail("verifier_source_invalid");
    const committed = new Map([...admitted.committed].map(([path, blob]) => [path, Object.freeze({ ...blob })]));
    const assertCapturedContentCurrent = (): void => {
      try {
        assertRoot();
        assertRawTrackedSource(repositoryRoot, committed, committed, true);
        assertRoot();
      } catch { fail("verifier_source_invalid"); }
    };
    assertCapturedContentCurrent();
    return Object.freeze({ sourceCommit, sourceTree: admitted.sourceTree, assertCapturedContentCurrent });
  } catch (error: unknown) {
    if (error instanceof AppSourceProofLauncherError) throw error;
    fail("verifier_source_invalid");
  }
};

const assertScratchDirectory = (directory: string): ScratchDirectoryIdentity => {
  const temporaryRoot = trustedScratchRoot();
  const metadata = lstatSync(directory);
  const uid = process.getuid?.();
  if (
    uid === undefined
    || !isNormalizedAbsolutePath(directory)
    || dirname(directory) !== temporaryRoot
    || !directory.startsWith(`${temporaryRoot}/hra-app-source-verifier-`)
    || !metadata.isDirectory()
    || metadata.isSymbolicLink()
    || metadata.uid !== uid
    || (metadata.mode & 0o777) !== 0o700
    || realpathSync(directory) !== directory
  ) {
    fail("verifier_install_failed");
  }
  return Object.freeze({ dev: metadata.dev, ino: metadata.ino, path: directory });
};

const assertSameScratchDirectory = (identity: ScratchDirectoryIdentity): void => {
  const metadata = lstatSync(identity.path);
  if (
    !metadata.isDirectory()
    || metadata.isSymbolicLink()
    || metadata.dev !== identity.dev
    || metadata.ino !== identity.ino
    || metadata.uid !== process.getuid?.()
    || (metadata.mode & 0o777) !== 0o700
    || realpathSync(identity.path) !== identity.path
  ) fail("verifier_cleanup_failed");
};

export const createAppSourceProofScratchDirectory = (): string => {
  const directory = mkdtempSync(join(trustedScratchRoot(), "hra-app-source-verifier-"));
  try {
    assertScratchDirectory(directory);
    return directory;
  } catch (error: unknown) {
    rmSync(directory, { force: true, recursive: true });
    throw error;
  }
};

const assertCredentialDescriptor = (descriptor: number): void => {
  const uid = process.getuid?.();
  const metadata = fstatSync(descriptor);
  if (
    uid === undefined
    || !Number.isSafeInteger(descriptor)
    || descriptor < 3
    || descriptor > 255
    || !metadata.isFile()
    || metadata.uid !== uid
    || metadata.nlink !== 1
    || (metadata.mode & 0o777) !== 0o600
    || metadata.size <= 0
    || metadata.size > maximumCredentialBytes
  ) fail("provider_credentials_refused");
};

const registeredWorktrees = (document: string): ReadonlySet<string> => new Set(
  document
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length)),
);

const renderFailure = (
  error: unknown,
  stderr: Readonly<{ write(value: string): unknown }>,
  retainedBuildIdentity?: ScratchDirectoryIdentity,
): number => {
  const code = error instanceof AppSourceProofLauncherError
    ? error.code
    : "verifier_execution_failed";
  // This identity came only from fixed-namespace scratch admission. Report its
  // original path without turning a fresh lookup into recovery authority.
  const retainedBuild = retainedBuildIdentity !== undefined
    && retainedBuildIdentity.path.length <= 512
    && isNormalizedAbsolutePath(retainedBuildIdentity.path)
    ? { directory: retainedBuildIdentity.path, locatorOnly: true } : undefined;
  stderr.write(`${JSON.stringify({ code, schemaVersion: 1, status: "refused",
    ...(retainedBuild === undefined ? {} : { retainedBuild }) })}\n`);
  return 1;
};

export const executeAppSourceProofLauncher = (
  arguments_: readonly string[],
  dependencies: AppSourceProofLauncherDependencies & Readonly<{
    stderr: Readonly<{ write(value: string): unknown }>;
    stdout: Readonly<{ write(value: string): unknown }>;
  }>,
): number => {
  let scratchDirectory: string | undefined;
  let scratchIdentity: ScratchDirectoryIdentity | undefined;
  let worktreeAddAttempted = false;
  let buildNeedsRecovery = false;
  let credentialDescriptor = -1;
  let result: CommandResult | undefined;
  let failure: unknown;
  const runCommand = dependencies.runCommand ?? defaultRunCommand;
  const closeCredential = dependencies.closeCredential ?? closeSync;
  const removeScratchDirectory = dependencies.removeScratchDirectory
    ?? ((path: string) => rmSync(path, { force: true, recursive: true }));
  try {
    assertHardenedAppSourceProofStageZero(
      dependencies.runtimeArguments ?? process.execArgv,
      dependencies.runtimeEnvironment ?? process.env,
    );
    if ((dependencies.runtimeVersion ?? Bun.version) !== supportedBunVersion) {
      fail("bun_version_unsupported");
    }
    const expected = parseAppSourceProofLauncherArguments(arguments_);
    const rootInput = dependencies.cwd ?? process.cwd();
    if (!isNormalizedAbsolutePath(rootInput) || realpathSync(rootInput) !== rootInput) {
      fail("verifier_source_invalid");
    }
    const hostedOperator = expected.mode === "command-capacity" || expected.mode === "quota-upgrade";
    const requireRemoteMain = !hostedOperator;
    assertExactSource(rootInput, expected.sourceCommit, runCommand, requireRemoteMain);

    const createdScratch = (
      dependencies.createScratchDirectory ?? createAppSourceProofScratchDirectory
    )();
    scratchIdentity = assertScratchDirectory(createdScratch);
    scratchDirectory = createdScratch;
    const worktree = join(scratchDirectory, "source");
    worktreeAddAttempted = true;
    requireSuccessfulCommand(runCommand(appSourceProofGitCommand([
      "worktree",
      "add",
      "--detach",
      worktree,
      expected.sourceCommit,
    ]), { cwd: rootInput }), "verifier_install_failed");
    const addedWorktrees = requireSilentSuccessfulCommand(
      runCommand(appSourceProofGitCommand([
        "worktree",
        "list",
        "--porcelain",
      ]), { cwd: rootInput }),
      "verifier_install_failed",
    );
    if (!registeredWorktrees(addedWorktrees).has(worktree)) {
      fail("verifier_install_failed");
    }
    // Prove the materialized bytes before Bun parses even the lockfile or
    // package manifest. Committed attributes may perform built-in checkout
    // conversions without defining a filter driver in repository config.
    assertExactSource(worktree, expected.sourceCommit, runCommand, requireRemoteMain);
    requireSuccessfulCommand(runCommand([
      dependencies.runtimePath ?? process.execPath,
      "--no-env-file",
      "--config=/dev/null",
      "install",
      "--frozen-lockfile",
      "--ignore-scripts",
      "--backend=copyfile",
    ], { cwd: worktree }), "verifier_install_failed");

    assertExactSource(rootInput, expected.sourceCommit, runCommand, requireRemoteMain);
    assertExactSource(worktree, expected.sourceCommit, runCommand, requireRemoteMain);
    if (expected.mode === "prove") {
      // The fresh, source-verified scratch checkout owns this fixed sealed build.
      // A failed attempt retains its exact source worktree and builder records.
      // No credential is opened before successful completion and source rechecks.
      buildNeedsRecovery = true;
      requireSuccessfulCommand(runCommand([
        dependencies.runtimePath ?? process.execPath,
        "--no-env-file", "--config=/dev/null", join(worktree, "scripts", "build-app.ts"),
      ], { cwd: worktree, environment: { ...appSourceProofChildEnvironment(), OOMPA_RELEASE_COMMIT: expected.sourceCommit } }),
      "verifier_install_failed");
      assertExactSource(rootInput, expected.sourceCommit, runCommand, requireRemoteMain);
      assertExactSource(worktree, expected.sourceCommit, runCommand, requireRemoteMain);
      buildNeedsRecovery = false;
    }
    const verifier = join(worktree, "scripts", "verify-app-source.ts");
    const command = hostedOperator
      ? [
          dependencies.runtimePath ?? process.execPath,
          "--no-env-file",
          "--config=/dev/null",
          join(worktree, "scripts", expected.mode === "command-capacity"
            ? "manage-command-lifecycle-capacity.ts"
            : "manage-quota-upgrade.ts"),
          ...expected.operatorArguments,
        ]
      : expected.mode === "prove"
      ? [
        dependencies.runtimePath ?? process.execPath,
        "--no-env-file",
        "--config=/dev/null",
        verifier,
        "--deployment-id",
        expected.deploymentId,
        "--evidence-path",
        expected.evidencePath,
        "--release-version",
        expected.releaseVersion,
        "--source-commit",
        expected.sourceCommit,
        "--vercel-auth-fd",
        "3",
      ]
      : [
        dependencies.runtimePath ?? process.execPath,
        "--no-env-file",
        "--config=/dev/null",
        verifier,
        "--verify-retained",
        "--evidence-path",
        expected.evidencePath,
        "--release-version",
        expected.releaseVersion,
        "--source-commit",
        expected.sourceCommit,
      ];
    if (expected.mode === "prove") {
      try {
        credentialDescriptor = (dependencies.openCredential ?? ((path: string) =>
          openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)))(
          expected.vercelAuthPath,
        );
        (dependencies.validateCredential ?? assertCredentialDescriptor)(credentialDescriptor);
      } catch {
        fail("provider_credentials_refused");
      }
    }
    result = runCommand(command, credentialDescriptor < 0
      ? {
          cwd: worktree,
          ...(hostedOperator
            ? {
                environment: commandCapacityChildEnvironment(
                  dependencies.runtimeEnvironment ?? process.env,
                ),
              }
            : {}),
        }
      : { credentialDescriptor, cwd: worktree });
    const admittedExitCodes = hostedOperator ? [0, 1, 75] : [0, 1];
    if (
      result.signal !== null
      || !admittedExitCodes.includes(result.exitCode)
      || Buffer.byteLength(result.stdout, "utf8") > maximumOutputBytes
      || Buffer.byteLength(result.stderr, "utf8") > maximumOutputBytes
    ) fail("verifier_execution_failed");
  } catch (error: unknown) {
    failure = error;
  } finally {
    if (credentialDescriptor >= 0) {
      try {
        closeCredential(credentialDescriptor);
      } catch {
        failure = new AppSourceProofLauncherError("provider_credentials_refused");
      }
    }
    if (scratchDirectory !== undefined && scratchIdentity !== undefined && !buildNeedsRecovery) {
      let cleanupFailed = false;
      try {
        assertSameScratchDirectory(scratchIdentity);
        if (worktreeAddAttempted) {
          const root = dependencies.cwd ?? process.cwd();
          const worktree = join(scratchDirectory, "source");
          const before = requireSilentSuccessfulCommand(runCommand(appSourceProofGitCommand([
            "worktree",
            "list",
            "--porcelain",
          ]), { cwd: root }), "verifier_cleanup_failed");
          if (registeredWorktrees(before).has(worktree)) {
            requireSuccessfulCommand(runCommand(appSourceProofGitCommand([
              "worktree",
              "remove",
              "--force",
              worktree,
            ]), { cwd: root }), "verifier_cleanup_failed");
          }
          const after = requireSilentSuccessfulCommand(runCommand(appSourceProofGitCommand([
            "worktree",
            "list",
            "--porcelain",
          ]), { cwd: root }), "verifier_cleanup_failed");
          if (registeredWorktrees(after).has(worktree)) {
            fail("verifier_cleanup_failed");
          }
        }
      } catch {
        cleanupFailed = true;
      }
      if (!cleanupFailed) {
        try {
          assertSameScratchDirectory(scratchIdentity);
          removeScratchDirectory(scratchDirectory);
          try {
            lstatSync(scratchDirectory);
            cleanupFailed = true;
          } catch (error: unknown) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") cleanupFailed = true;
          }
        } catch {
          cleanupFailed = true;
        }
      }
      if (cleanupFailed) {
        failure = new AppSourceProofLauncherError("verifier_cleanup_failed");
      }
    }
  }
  if (failure !== undefined) return renderFailure(failure, dependencies.stderr, buildNeedsRecovery ? scratchIdentity : undefined);
  if (result === undefined) return renderFailure(
    new AppSourceProofLauncherError("verifier_execution_failed"),
    dependencies.stderr,
  );
  if (result.stdout !== "") dependencies.stdout.write(result.stdout);
  if (result.stderr !== "") dependencies.stderr.write(result.stderr);
  return result.exitCode;
};

if (import.meta.main) {
  process.exitCode = executeAppSourceProofLauncher(process.argv.slice(2), {
    stderr: process.stderr,
    stdout: process.stdout,
  });
}
