import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readlink,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

import fc from "fast-check";

import {
  buildOompaGlobalInstallCommand,
  OOMPA_INSTALL_ARCHIVE_URL,
  OOMPA_INSTALL_PREFLIGHT_LOADER,
  OOMPA_INSTALL_PREFLIGHT_SOURCE_MAXIMUM_BYTES,
  OOMPA_INSTALL_PREFLIGHT_SOURCE_SHA256,
  OOMPA_INSTALL_PREFLIGHT_SOURCE_URL,
  OOMPA_INSTALL_PREFLIGHT_SUCCESS,
} from "./install-preflight";
import {
  assertSafeDarwinInstallAcl as assertSafeDarwinNormalizerAcl,
} from "./install-normalizer";
import {
  OOMPA_INSTALL_ARCHIVE_NAME,
  OOMPA_INSTALL_RELEASE_API_URL,
  OOMPA_INSTALL_REPOSITORY_API_URL,
  OOMPA_INSTALL_REPOSITORY_ID,
  OOMPA_INSTALL_RUNTIME_INJECTION_ENVIRONMENT_NAMES,
  assertSafeDarwinInstallAcl,
  OOMPA_INSTALL_NORMALIZER_SHA256,
  isOompaInstallReceiptVersion,
  parseOfficialOompaReleaseRecord,
  parseOfficialOompaRepositoryRecord,
  resolveOfficialOompaArchiveIdentity,
  sanitizeOompaInstallChildEnvironment,
} from "./install-preflight-runtime";

const repositoryRoot = resolve(import.meta.dir, "..");
// Installer security tests use the complete publishable package tree with only
// dependency resolution metadata removed. The package gate separately checks
// the unchanged production tarball and its exact dependency policy.
const TEST_STAGING_DEADLINE_MS = 45_000;
const PUBLIC_LOADER_INSTALL_CALL = "await m.installOompaRelease(a);";
const BOUNDED_TEST_LOADER_INSTALL_CALL =
  `await m.installOompaRelease(a,{stageDeadlineMilliseconds:${String(TEST_STAGING_DEADLINE_MS)}});`;
const BOUNDED_TEST_PREFLIGHT_LOADER = OOMPA_INSTALL_PREFLIGHT_LOADER.replace(
  PUBLIC_LOADER_INSTALL_CALL,
  BOUNDED_TEST_LOADER_INSTALL_CALL,
);
if (
  OOMPA_INSTALL_PREFLIGHT_LOADER.indexOf(PUBLIC_LOADER_INSTALL_CALL)
    !== OOMPA_INSTALL_PREFLIGHT_LOADER.lastIndexOf(PUBLIC_LOADER_INSTALL_CALL)
  || BOUNDED_TEST_PREFLIGHT_LOADER === OOMPA_INSTALL_PREFLIGHT_LOADER
  || BOUNDED_TEST_PREFLIGHT_LOADER.replace(
    BOUNDED_TEST_LOADER_INSTALL_CALL,
    PUBLIC_LOADER_INSTALL_CALL,
  ) !== OOMPA_INSTALL_PREFLIGHT_LOADER
) throw new Error("The installer test loader did not receive its one bounded staging deadline.");
// Two serialized staging installs may each consume their complete bounded
// installer budget. Keep the outer test deadline above both inner budgets so
// scheduling delay cannot terminate a valid second install.
const SERIAL_STAGING_INSTALL_TEST_TIMEOUT_MS = 180_000;
const temporaryRoots: string[] = [];
const adversarialReceiptVersion = `1.2.3-${"aaa.".repeat(30)}a!`;
type DirectTestChild = Readonly<{
  exited: Promise<number>;
  kill: (signal?: number | NodeJS.Signals) => void;
}>;
const directTestChildren = new Set<DirectTestChild>();
let archivePath: string;
let archiveSha256: string;
let installerFixtureManifest: Record<string, unknown>;
let sourcePackageManifest: Record<string, unknown>;

const trackDirectTestChild = <Child extends DirectTestChild>(child: Child): Child => {
  directTestChildren.add(child);
  void child.exited.finally(() => directTestChildren.delete(child));
  return child;
};

type FetchObservation = Readonly<{
  accept: string | null;
  acceptEncoding: string | null;
  cache: RequestCache | null;
  credentials: RequestCredentials | null;
  redirect: RequestRedirect | null;
  url: string;
}>;

type OfficialInstallScenario =
  | "disallowed-redirect"
  | "overrun"
  | "success"
  | "truncated"
  | "wrong-hash";

const makeRoot = async (prefix = "oompa-install-preflight-"): Promise<string> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  await chmod(root, 0o700);
  temporaryRoots.push(root);
  return root;
};

const run = async (
  command: readonly [string, ...string[]],
  input: Readonly<{ cwd: string; environment?: NodeJS.ProcessEnv }>,
): Promise<Readonly<{ exitCode: number; stderr: string; stdout: string }>> => {
  const child = trackDirectTestChild(Bun.spawn([...command], {
    cwd: input.cwd,
    env: input.environment ?? process.env,
    stderr: "pipe",
    stdin: "ignore",
    stdout: "pipe",
  }));
  const [exitCode, stderr, stdout] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ]);
  return { exitCode, stderr, stdout };
};

// The public shell command clears these values before stage zero. Keep the
// fixture hermetic when CI itself uses NODE_OPTIONS; hostile inheritance is
// covered below by explicit per-scenario overrides.
const installEnvironment = (root: string): NodeJS.ProcessEnv => ({
  ...sanitizeOompaInstallChildEnvironment(process.env),
  BUN_INSTALL: join(root, "bun root"),
  HOME: join(root, "home"),
});

const officialArchiveAsset = (
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> => ({
  browser_download_url: OOMPA_INSTALL_ARCHIVE_URL,
  digest: `sha256:${archiveSha256}`,
  id: 8_675_309,
  name: OOMPA_INSTALL_ARCHIVE_NAME,
  size: 123,
  state: "uploaded",
  ...overrides,
});

const officialReleaseRecord = (
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> => ({
  assets: [officialArchiveAsset()],
  draft: false,
  id: 9_715_113,
  immutable: true,
  tag_name: "v0.8.5",
  ...overrides,
});

const officialRepositoryRecord = (
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> => ({
  archived: false,
  disabled: false,
  full_name: "hraness/oompa",
  id: OOMPA_INSTALL_REPOSITORY_ID,
  private: false,
  ...overrides,
});

const jsonResponse = (
  value: unknown,
  input: Readonly<{ headers?: HeadersInit; status?: number }> = {},
): Response => {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const headers = new Headers(input.headers);
  if (!headers.has("content-length")) headers.set("content-length", String(bytes.byteLength));
  return new Response(bytes, { headers, status: input.status ?? 200 });
};

const readJsonRecord = async (path: string): Promise<Record<string, unknown>> => {
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Expected one JSON object fixture at ${path}.`);
  }
  return value as Record<string, unknown>;
};

type SyntheticInstallPackageName = "@hraness/oompa" | "hra";
type SyntheticPreviousInstall = Readonly<{
  activePath: string;
  authorityRoot: string;
  cliPath: string;
  packageManifestPath: string;
  receiptPath: string;
  root: string;
  versionRoot: string;
  versionsRoot: string;
}>;

const fixturePackageComponents = (
  packageName: SyntheticInstallPackageName,
): readonly string[] => packageName === "@hraness/oompa"
  ? ["@hraness", "oompa"]
  : ["hra"];

const measureSyntheticVersion = async (
  versionRoot: string,
): Promise<Readonly<{ entryCount: number; totalBytes: number; treeSha256: string }>> => {
  let entryCount = 0;
  let totalBytes = 0;
  const treeHasher = createHash("sha256");
  const record = (value: readonly (number | string)[]): void => {
    treeHasher.update(`${JSON.stringify(value)}\n`, "utf8");
  };
  const visit = async (directory: string): Promise<void> => {
    const directoryMetadata = await lstat(directory);
    if (!directoryMetadata.isDirectory() || (directoryMetadata.mode & 0o777) !== 0o700) {
      throw new Error(`Synthetic Oompa version directory is not private: ${directory}`);
    }
    record(["directory", relative(versionRoot, directory).replaceAll("\\", "/"), 0o700]);
    const entries = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const metadata = await lstat(path);
      if (entry.isDirectory()) {
        entryCount += 1;
        await visit(path);
        continue;
      }
      if (path === join(versionRoot, ".hra-install-complete.json")) continue;
      entryCount += 1;
      if (entry.isSymbolicLink()) {
        record([
          "symlink",
          relative(versionRoot, path).replaceAll("\\", "/"),
          await readlink(path),
        ]);
        continue;
      }
      if (!entry.isFile() || !metadata.isFile()) {
        throw new Error(`Synthetic Oompa version contains an unsupported entry: ${path}`);
      }
      const bytes = await readFile(path);
      totalBytes += bytes.byteLength;
      record([
        "file",
        relative(versionRoot, path).replaceAll("\\", "/"),
        metadata.mode & 0o777,
        bytes.byteLength,
        createHash("sha256").update(bytes).digest("hex"),
      ]);
    }
  };
  await visit(versionRoot);
  return { entryCount, totalBytes, treeSha256: treeHasher.digest("hex") };
};

const writePrivateJson = async (path: string, value: unknown): Promise<void> => {
  await writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
};

const resealSyntheticVersion = async (fixture: SyntheticPreviousInstall): Promise<void> => {
  const receipt = await readJsonRecord(fixture.receiptPath);
  Object.assign(receipt, await measureSyntheticVersion(fixture.versionRoot));
  await writePrivateJson(fixture.receiptPath, receipt);
};

const createSyntheticPreviousInstall = async (
  root: string,
  input: Readonly<{
    archiveSource?: "local" | "official";
    layoutPackageName?: SyntheticInstallPackageName;
    manifestPackageName?: SyntheticInstallPackageName;
    packageName: SyntheticInstallPackageName;
    packageVersion: string;
  }>,
): Promise<SyntheticPreviousInstall> => {
  const archiveSource = input.archiveSource ?? "local";
  const layoutPackageName = input.layoutPackageName ?? input.packageName;
  const manifestPackageName = input.manifestPackageName ?? input.packageName;
  const bunRoot = join(root, "bun root");
  const authorityRoot = join(bunRoot, "install", "oompa");
  const versionsRoot = join(authorityRoot, "versions");
  const archiveIdentity = {
    archiveAssetId: archiveSource === "official" ? 8_675_308 : null,
    archiveBytes: 123,
    archiveReleaseId: archiveSource === "official" ? 9_715_112 : null,
    archiveReleaseTag: archiveSource === "official" ? `v${input.packageVersion}` : null,
    archiveRepositoryId: archiveSource === "official" ? OOMPA_INSTALL_REPOSITORY_ID : null,
    archiveSha256: createHash("sha256")
      .update(`synthetic archive:${input.packageName}:${input.packageVersion}:${archiveSource}`)
      .digest("hex"),
    archiveSource,
  } as const;
  const cliBytes = Buffer.from(`#!/usr/bin/env bun\n// synthetic ${layoutPackageName} ${input.packageVersion}\n`);
  const normalizerBytes = Buffer.from(`// synthetic normalizer ${input.packageVersion}\n`);
  const cliSha256 = createHash("sha256").update(cliBytes).digest("hex");
  const normalizerSha256 = createHash("sha256").update(normalizerBytes).digest("hex");
  const versionName = [
    `v${input.packageVersion}`,
    archiveSource,
    archiveIdentity.archiveSha256,
    normalizerSha256,
    cliSha256,
  ].join("-");
  const versionRoot = join(versionsRoot, versionName);
  const globalRoot = join(versionRoot, "install", "global");
  const packageRoot = join(globalRoot, "node_modules", ...fixturePackageComponents(layoutPackageName));
  const sourceRoot = join(packageRoot, "src");
  const cliPath = join(sourceRoot, "cli.ts");
  const packageManifestPath = join(packageRoot, "package.json");
  const activePath = join(bunRoot, "bin", "oompa");
  for (const directory of [
    bunRoot,
    join(bunRoot, "bin"),
    join(bunRoot, "install"),
    authorityRoot,
    versionsRoot,
    versionRoot,
    join(versionRoot, "install"),
    globalRoot,
    join(globalRoot, "node_modules"),
    ...(layoutPackageName === "@hraness/oompa" ? [join(globalRoot, "node_modules", "@hraness")] : []),
    packageRoot,
    sourceRoot,
  ]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
  }
  await writePrivateJson(join(globalRoot, "package.json"), {
    dependencies: { [layoutPackageName]: input.packageVersion },
  });
  await writePrivateJson(packageManifestPath, {
    bin: { oompa: "./src/cli.ts" },
    name: manifestPackageName,
    scripts: { check: "bun test" },
    version: input.packageVersion,
  });
  await writeFile(cliPath, cliBytes, { mode: 0o755 });
  await chmod(cliPath, 0o755);
  await writeFile(join(sourceRoot, "install-normalizer.ts"), normalizerBytes, { mode: 0o600 });
  await chmod(join(sourceRoot, "install-normalizer.ts"), 0o600);
  const receiptPath = join(versionRoot, ".hra-install-complete.json");
  const tree = await measureSyntheticVersion(versionRoot);
  await writePrivateJson(receiptPath, {
    ...archiveIdentity,
    cliSha256,
    completedAt: 1_725_000_000_000,
    dependencyProvenance: "bun-registry-exact-versions",
    ...tree,
    id: "00000000-0000-4000-8000-000000000001",
    normalizerSha256,
    packageName: input.packageName,
    packageVersion: input.packageVersion,
    version: 2,
  });
  await symlink(cliPath, activePath);
  return {
    activePath,
    authorityRoot,
    cliPath,
    packageManifestPath,
    receiptPath,
    root,
    versionRoot,
    versionsRoot,
  };
};

const replaceSyntheticActiveTarget = async (
  fixture: SyntheticPreviousInstall,
  target: string,
): Promise<void> => {
  await rm(fixture.activePath, { force: true });
  await symlink(target, fixture.activePath);
};

const expectNoStartedInstall = async (fixture: SyntheticPreviousInstall): Promise<void> => {
  expect(await Bun.file(join(fixture.authorityRoot, "install-intent.json")).exists()).toBeFalse();
  expect((await readdir(fixture.authorityRoot)).some((entry) => entry.startsWith(".staging-"))).toBeFalse();
};

const expectPreviousInstallRejectedBeforeStaging = async (
  fixture: SyntheticPreviousInstall,
  expectedMessage: string,
  runInstall = runInstaller,
): Promise<void> => {
  const activeTargetBefore = await readlink(fixture.activePath);
  const cliBefore = await readFile(fixture.cliPath);
  const receiptBefore = await readFile(fixture.receiptPath);
  const versionsBefore = (await readdir(fixture.versionsRoot)).sort();
  const result = await runInstall(fixture.root);
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain(expectedMessage);
  expect(result.stdout).toBe("");
  expect(await readlink(fixture.activePath)).toBe(activeTargetBefore);
  expect(await readFile(fixture.cliPath)).toEqual(cliBefore);
  expect(await readFile(fixture.receiptPath)).toEqual(receiptBefore);
  expect((await readdir(fixture.versionsRoot)).sort()).toEqual(versionsBefore);
  await expectNoStartedInstall(fixture);
};

const processIdentityExists = (pid: number, group = false): boolean => {
  try {
    process.kill(group ? -pid : pid, 0);
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
};

const waitForProcessIdentityToDisappear = async (
  pid: number,
  group = false,
  maximumWaitMilliseconds = 5_000,
): Promise<void> => {
  const deadline = Date.now() + maximumWaitMilliseconds;
  while (processIdentityExists(pid, group) && Date.now() < deadline) await Bun.sleep(10);
  expect(processIdentityExists(pid, group)).toBeFalse();
};

const runInstaller = async (root: string, poisonStageEnvironment = false): Promise<Readonly<{
  exitCode: number;
  stderr: string;
  stdout: string;
}>> => {
  await mkdir(join(root, "home"), { recursive: true, mode: 0o700 });
  await chmod(join(root, "home"), 0o700);
  const runtimePath = resolve(import.meta.dir, "install-preflight-runtime.ts");
  const program = [
    `const module = await import(${JSON.stringify(runtimePath)});`,
    `await module.installOompaRelease(${JSON.stringify(archivePath)}, {`,
    `  stageDeadlineMilliseconds: ${String(TEST_STAGING_DEADLINE_MS)},`,
    ...(poisonStageEnvironment
      ? [
        "  beforeStageWorkerSpawn: () => {",
        `    process.env.BUN_OPTIONS = ${JSON.stringify("--preload=/private/tmp/hra-missing-ambient-preload.ts")};`,
        `    process.env.NODE_OPTIONS = ${JSON.stringify("--require=/private/tmp/hra-missing-ambient-preload.js")};`,
        "  },",
      ]
      : []),
    "});",
    `process.stdout.write(${JSON.stringify(`${OOMPA_INSTALL_PREFLIGHT_SUCCESS}\n`)});`,
  ].join("\n");
  return await run([
    process.execPath,
    "--no-env-file",
    "--config=/dev/null",
    "-e",
    program,
  ], {
    cwd: root,
    environment: installEnvironment(root),
  });
};

// The local runtime is verified against its own bytes, the way the public
// command verifies the tagged runtime against the digest it carries. Release
// consistency between the two is proven by scripts/check-install-pins.ts under
// a tag ref.
const localRuntimeSha256 = createHash("sha256")
  .update(await readFile(resolve(import.meta.dir, "install-preflight-runtime.ts")))
  .digest("hex");

const runTrustedLoader = async (
  root: string,
  sourceSha256 = localRuntimeSha256,
  environmentOverrides: NodeJS.ProcessEnv = {},
): Promise<Readonly<{
  exitCode: number;
  stderr: string;
  stdout: string;
}>> => {
  await mkdir(join(root, "home"), { recursive: true, mode: 0o700 });
  await chmod(join(root, "home"), 0o700);
  const child = trackDirectTestChild(Bun.spawn([
    process.execPath,
    "--no-env-file",
    "--config=/dev/null",
    "-e",
    sourceSha256 === localRuntimeSha256
      ? BOUNDED_TEST_PREFLIGHT_LOADER
      : OOMPA_INSTALL_PREFLIGHT_LOADER,
    "--",
    archivePath,
    sourceSha256,
  ], {
    cwd: root,
    env: { ...installEnvironment(root), ...environmentOverrides },
    stderr: "pipe",
    stdin: Bun.file(resolve(import.meta.dir, "install-preflight-runtime.ts")),
    stdout: "pipe",
  }));
  const [exitCode, stderr, stdout] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ]);
  return { exitCode, stderr, stdout };
};

const runOfficialInstaller = async (
  root: string,
  scenario: OfficialInstallScenario,
  mutatePrivateArchiveBeforeReadback = false,
): Promise<Readonly<{
  exitCode: number;
  observations: readonly FetchObservation[];
  stderr: string;
  stdout: string;
}>> => {
  await mkdir(join(root, "home"), { recursive: true, mode: 0o700 });
  await chmod(join(root, "home"), 0o700);
  const observationsPath = join(root, "official-fetch-observations.json");
  const runtimePath = resolve(import.meta.dir, "install-preflight-runtime.ts");
  const authorityRoot = join(root, "bun root", "install", "oompa");
  const allowedAssetUrl = "https://release-assets.githubusercontent.com/oompa-test/archive.tgz";
  const program = [
    'const crypto = await import("node:crypto");',
    'const fs = await import("node:fs/promises");',
    'const path = await import("node:path");',
    `const module = await import(${JSON.stringify(runtimePath)});`,
    `const archiveBytes = Buffer.from(await fs.readFile(${JSON.stringify(archivePath)}));`,
    'const actualDigest = crypto.createHash("sha256").update(archiveBytes).digest("hex");',
    `const scenario = ${JSON.stringify(scenario)};`,
    "const advertisedDigest = scenario === \"wrong-hash\" ? \"0\".repeat(64) : actualDigest;",
    "const repository = { archived: false, disabled: false, full_name: \"hraness/oompa\", id: module.OOMPA_INSTALL_REPOSITORY_ID, private: false };",
    "const release = { assets: [{ browser_download_url: module.OOMPA_INSTALL_ARCHIVE_URL, digest: `sha256:${advertisedDigest}`, id: 8675309, name: module.OOMPA_INSTALL_ARCHIVE_NAME, size: archiveBytes.byteLength, state: \"uploaded\" }], draft: false, id: 9715113, immutable: true, tag_name: module.OOMPA_INSTALL_RELEASE_TAG };",
    "const jsonResponse = (value) => { const bytes = new TextEncoder().encode(JSON.stringify(value)); return new Response(bytes, { headers: { \"Content-Encoding\": \"identity\", \"Content-Length\": String(bytes.byteLength) }, status: 200 }); };",
    "const chunkedResponse = (payload, includeLength) => {",
    "  const first = Math.max(1, Math.floor(payload.byteLength / 3));",
    "  const second = Math.max(first + 1, Math.floor(payload.byteLength * 2 / 3));",
    "  const body = new ReadableStream({ start(controller) {",
    "    for (const chunk of [payload.subarray(0, first), payload.subarray(first, second), payload.subarray(second)]) if (chunk.byteLength > 0) controller.enqueue(chunk);",
    "    controller.close();",
    "  } });",
    "  const headers = new Headers({ \"Content-Encoding\": \"identity\" });",
    "  if (includeLength) headers.set(\"Content-Length\", String(payload.byteLength));",
    "  return new Response(body, { headers, status: 200 });",
    "};",
    "const observations = [];",
    "const fetcher = async (input, init) => {",
    "  const headers = new Headers(init.headers);",
    "  observations.push({ accept: headers.get(\"accept\"), acceptEncoding: headers.get(\"accept-encoding\"), cache: init.cache ?? null, credentials: init.credentials ?? null, redirect: init.redirect ?? null, url: input });",
    "  if (input === module.OOMPA_INSTALL_REPOSITORY_API_URL) return jsonResponse(repository);",
    "  if (input === module.OOMPA_INSTALL_RELEASE_API_URL) return jsonResponse(release);",
    "  if (input === module.OOMPA_INSTALL_ARCHIVE_URL) {",
    "    const location = scenario === \"disallowed-redirect\" ? \"https://evil.example/hra.tgz\" : " + JSON.stringify(allowedAssetUrl) + ";",
    "    return new Response(null, { headers: { Location: location }, status: 302 });",
    "  }",
    "  if (input === " + JSON.stringify(allowedAssetUrl) + ") {",
    "    const payload = scenario === \"truncated\"",
    "      ? archiveBytes.subarray(0, archiveBytes.byteLength - 1)",
    "      : scenario === \"overrun\"",
    "        ? Buffer.concat([archiveBytes, Buffer.from([0])])",
    "        : archiveBytes;",
    "    return chunkedResponse(payload, scenario !== \"truncated\" && scenario !== \"overrun\");",
    "  }",
    "  throw new Error(`Unexpected installer fetch: ${input}`);",
    "};",
    "const beforePrivateArchiveReadback = " + (mutatePrivateArchiveBeforeReadback
      ? "async () => { const stage = (await fs.readdir(" + JSON.stringify(authorityRoot) + ")).find((entry) => entry.startsWith(\".staging-\")); if (!stage) throw new Error(\"The private archive stage is missing.\"); const privatePath = path.join(" + JSON.stringify(authorityRoot) + ", stage, \".oompa-release-archive.tgz\"); const bytes = Buffer.from(await fs.readFile(privatePath)); bytes[0] = (bytes[0] ?? 0) ^ 1; await fs.writeFile(privatePath, bytes, { mode: 0o600 }); }"
      : "undefined") + ";",
    "try {",
    `  await module.installOompaRelease(module.OOMPA_INSTALL_ARCHIVE_URL, { beforePrivateArchiveReadback, fetcher, stageDeadlineMilliseconds: ${String(TEST_STAGING_DEADLINE_MS)} });`,
    "  process.stdout.write(`${module.OOMPA_INSTALL_SUCCESS}\\n`);",
    "} finally {",
    `  await fs.writeFile(${JSON.stringify(observationsPath)}, JSON.stringify(observations), { mode: 0o600 });`,
    "}",
  ].join("\n");
  const result = await run([process.execPath, "-e", program], {
    cwd: root,
    environment: installEnvironment(root),
  });
  const observations = await Bun.file(observationsPath).exists()
    ? JSON.parse(await readFile(observationsPath, "utf8")) as readonly FetchObservation[]
    : [];
  return { ...result, observations };
};

const runStalledStage = async (
  root: string,
  mode: "stall-after-ready" | "stall-before-ready",
): Promise<Readonly<{
  bunPid: number;
  result: Readonly<{ exitCode: number; stderr: string; stdout: string }>;
  workerPid: number;
}>> => {
  await mkdir(join(root, "home"), { recursive: true, mode: 0o700 });
  await chmod(join(root, "home"), 0o700);
  const sentinel = join(root, `${mode}-pids`);
  const runtimePath = resolve(import.meta.dir, "install-preflight-runtime.ts");
  const program = [
    "const [runtimePath, archivePath, mode, sentinel] = process.argv.slice(1);",
    "const module = await import(runtimePath);",
    "await module.installOompaRelease(archivePath, {",
    "  stageDeadlineMilliseconds: 400,",
    "  stageWorkerTestMode: mode,",
    '  afterStageWorkerStarted: async (bunPid, workerPid) => { await Bun.write(sentinel, String(bunPid) + " " + String(workerPid) + "\\n"); },',
    "});",
  ].join("\n");
  const result = await run([process.execPath, "-e", program, "--", runtimePath, archivePath, mode, sentinel], {
    cwd: root,
    environment: installEnvironment(root),
  });
  const [bunPidText, workerPidText] = (await readFile(sentinel, "utf8")).trim().split(" ");
  const bunPid = Number.parseInt(bunPidText ?? "", 10);
  const workerPid = Number.parseInt(workerPidText ?? "", 10);
  if (!Number.isSafeInteger(bunPid) || !Number.isSafeInteger(workerPid)) {
    throw new Error("The stalled-stage fixture did not capture its exact process identities.");
  }
  return { bunPid, result, workerPid };
};

const assertStalledStageRecovers = async (
  mode: "stall-after-ready" | "stall-before-ready",
): Promise<void> => {
  const root = await makeRoot(`oompa-install-${mode}-`);
  const { bunPid, result, workerPid } = await runStalledStage(root, mode);
  expect(result.exitCode).not.toBe(0);
  expect(result.stdout).toBe("");
  if (mode === "stall-before-ready") {
    expect(result.stderr).toContain("ended before publishing complete lock readiness");
  } else {
    expect(result.stderr).toContain("hard detached-authority deadline");
  }
  await waitForProcessIdentityToDisappear(workerPid);
  await waitForProcessIdentityToDisappear(bunPid, true);
  const bunRoot = join(root, "bun root");
  const authorityRoot = join(bunRoot, "install", "oompa");
  expect(await Bun.file(join(bunRoot, "bin", "oompa")).exists()).toBeFalse();
  expect((await readdir(authorityRoot)).some((entry) => entry.startsWith(".staging-"))).toBeTrue();

  const recovered = await runInstaller(root);
  expect(recovered.exitCode).toBe(0);
  expect(recovered.stderr).toBe("");
  expect(recovered.stdout).toBe(`${OOMPA_INSTALL_PREFLIGHT_SUCCESS}\n`);
  expect((await lstat(join(bunRoot, "bin", "oompa"))).isSymbolicLink()).toBeTrue();
  expect((await readdir(authorityRoot)).some((entry) => entry.startsWith(".staging-"))).toBeFalse();
  expect(await Bun.file(join(authorityRoot, "install-intent.json")).exists()).toBeFalse();
};

beforeAll(async () => {
  const root = await makeRoot("oompa-install-archive-");
  sourcePackageManifest = await readJsonRecord(join(repositoryRoot, "package.json"));
  const packed = await run([
    process.execPath,
    "pm",
    "pack",
    "--destination",
    root,
  ], { cwd: repositoryRoot });
  if (packed.exitCode !== 0) throw new Error(`Could not build installer fixture: ${packed.stderr}${packed.stdout}`);
  const productionArchivePath = join(root, "hraness-oompa-0.8.5.tgz");
  const extractedRoot = join(root, "extracted");
  await mkdir(extractedRoot, { mode: 0o700 });
  const extracted = await run(["tar", "-xzf", productionArchivePath, "-C", extractedRoot], { cwd: root });
  if (extracted.exitCode !== 0) {
    throw new Error(`Could not extract installer fixture: ${extracted.stderr}${extracted.stdout}`);
  }
  const extractedPackageRoot = join(extractedRoot, "package");
  installerFixtureManifest = await readJsonRecord(join(extractedPackageRoot, "package.json"));
  delete installerFixtureManifest.dependencies;
  delete installerFixtureManifest.devDependencies;
  await writeFile(
    join(extractedPackageRoot, "package.json"),
    `${JSON.stringify(installerFixtureManifest, undefined, 2)}\n`,
    { mode: 0o600 },
  );
  await rm(productionArchivePath);
  const repacked = await run([
    process.execPath,
    "pm",
    "pack",
    "--destination",
    root,
  ], { cwd: extractedPackageRoot });
  if (repacked.exitCode !== 0) {
    throw new Error(`Could not repack installer fixture: ${repacked.stderr}${repacked.stdout}`);
  }
  archivePath = productionArchivePath;
  await chmod(archivePath, 0o600);
  archiveSha256 = createHash("sha256").update(await readFile(archivePath)).digest("hex");
});

afterAll(async () => {
  const unsettledChildren = [...directTestChildren];
  for (const child of unsettledChildren) child.kill("SIGTERM");
  await Promise.allSettled(unsettledChildren.map(async (child) => await child.exited));
  if (process.platform === "darwin") {
    await Promise.all(temporaryRoots.map(async (root) => {
      await run(["/bin/chmod", "-RN", root], { cwd: tmpdir() });
    }));
  }
  await Promise.all(temporaryRoots.splice(0).map(async (root) => {
    await rm(root, { force: true, recursive: true });
  }));
}, 60_000);

describe("transactional Oompa installer", () => {
  test("passes installer child arguments as data without changing static eval source", async () => {
    const root = await makeRoot("oompa-install-child-arguments-");
    const values = [
      "a path with spaces",
      "\"'; process.exit(73); //",
      "backslash\\value",
      "line\nreturn\rseparator\u2028paragraph\u2029",
      "</script>",
      "--preload=unreviewed-fixture.ts",
    ];
    const program = "process.stdout.write(JSON.stringify(process.argv.slice(1)));";
    const result = await run([process.execPath, "-e", program, "--", ...values], {
      cwd: root,
      environment: installEnvironment(root),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout) as unknown).toEqual(values);
  });

  test("rejects an ambiguous maximum-length receipt semver within a joined watchdog", () => {
    expect(adversarialReceiptVersion).toHaveLength(128);
    // The child only imports the predicate and evaluates one value. SIGKILL
    // and synchronous joining keep a regressed synchronous parser finite;
    // it cannot block this test process's event loop or leave a child behind.
    const result = spawnSync(process.execPath, [
      "--no-env-file",
      "--config=/dev/null",
      "--eval",
      [
        'const { isOompaInstallReceiptVersion } = await import(process.argv[1]);',
        'process.stdout.write(String(isOompaInstallReceiptVersion(process.argv[2])) + "\\n");',
      ].join("\n"),
      resolve(import.meta.dir, "install-preflight-runtime.ts"),
      adversarialReceiptVersion,
    ], {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: sanitizeOompaInstallChildEnvironment(process.env),
      killSignal: "SIGKILL",
      maxBuffer: 1_024,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 1_000,
    });
    expect(result.error, result.error?.message).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("false\n");
  });

  test("preserves receipt semver core, prerelease, build, and end-of-input grammar", () => {
    const accepted = [
      "0.0.0", "1.2.3", "10.200.3000", "1.2.3-0", "1.2.3-10",
      "1.2.3-a", "1.2.3-A", "1.2.3-0a", "1.2.3-01a", "1.2.3-00-",
      "1.2.3--", "1.2.3---", "1.2.3-a-b.0.01A.-",
      "1.2.3+00.01.-", "1.2.3-rc.1+00.A-b", `1.2.3-${"a".repeat(122)}`,
    ];
    const rejected = [
      "", "1", "1.2", "1.2.3.4", "01.2.3", "1.02.3", "1.2.03",
      "v1.2.3", "+1.2.3", "-1.2.3", "1.2.3-", "1.2.3-00", "1.2.3-01",
      "1.2.3-a.01", "1.2.3-.a", "1.2.3-a.", "1.2.3-a..b",
      "1.2.3+", "1.2.3+.a", "1.2.3+a.", "1.2.3+a..b", "1.2.3+a+b",
      "1.2.3_foo", "1.2.3-ä", "1.2.3+é", "1.2.3-😀", " 1.2.3", "1.2.3 ",
      "1.2.3\n", "1.2.3\r", "1.2.3\r\n", "1.2.3\u2028", "1.2.3\u2029", "1.2.3\0",
      "1.2.3-a\n", "1.2.3+a\n", `1.2.3-${"a".repeat(123)}`,
    ];
    for (const value of accepted) expect(isOompaInstallReceiptVersion(value), value).toBeTrue();
    for (const value of rejected) expect(isOompaInstallReceiptVersion(value), value).toBeFalse();
  });

  test("preserves bounded generated receipt semver grammar and rejects invalid mutations", () => {
    const numeric = fc.integer({ min: 0, max: 999 }).map(String);
    const identifier = fc.array(fc.constantFrom("0", "1", "A", "a", "-"), {
      minLength: 1,
      maxLength: 4,
    }).map((characters) => characters.join(""));
    const prereleaseIdentifier = fc.oneof(numeric, identifier.map((value) => `a${value}`));
    fc.assert(fc.property(
      fc.tuple(numeric, numeric, numeric),
      fc.array(prereleaseIdentifier, { maxLength: 3 }),
      fc.array(identifier, { maxLength: 3 }),
      (core, prerelease, build) => {
        const suffix = (prerelease.length === 0 ? "" : `-${prerelease.join(".")}`)
          + (build.length === 0 ? "" : `+${build.join(".")}`);
        const version = `${core.join(".")}${suffix}`;
        expect(isOompaInstallReceiptVersion(version), version).toBeTrue();
        expect(isOompaInstallReceiptVersion(`0${version}`)).toBeFalse();
        expect(isOompaInstallReceiptVersion(`${version}\n`)).toBeFalse();
        expect(isOompaInstallReceiptVersion(`${core.join(".")}-01`)).toBeFalse();
        expect(isOompaInstallReceiptVersion(`${core.join(".")}+01`)).toBeTrue();
      },
    ), { numRuns: 300, seed: 20_260_908 });
  });

  test("refuses an ambiguous receipt semver before staging without mutating installed authority", async () => {
    const root = await makeRoot("oompa-install-semver-bound-");
    const previous = await createSyntheticPreviousInstall(root, {
      packageName: "@hraness/oompa",
      packageVersion: "0.1.4",
    });
    // Preserve a valid protected namespace so the malformed receipt reaches
    // version parsing before namespace/release comparisons can reject it.
    const receipt = await readJsonRecord(previous.receiptPath);
    receipt.packageVersion = adversarialReceiptVersion;
    await writePrivateJson(previous.receiptPath, receipt);
    await expectPreviousInstallRejectedBeforeStaging(
      previous,
      "complete Oompa version receipt is invalid",
      async (installRoot) => {
        await mkdir(join(installRoot, "home"), { recursive: true, mode: 0o700 });
        // No stage worker is permitted in this fixture, even if receipt
        // admission regresses. The direct installer is killed and joined if
        // parsing blocks; the test process remains able to inspect authority.
        const result = spawnSync(process.execPath, [
          "--no-env-file",
          "--config=/dev/null",
          "--eval",
          [
            'const { installOompaRelease } = await import(process.argv[1]);',
            "try {",
            '  await installOompaRelease(process.argv[2], { beforeStageWorkerSpawn: () => { throw new Error("Unexpected install staging"); } });',
            "} catch (error) {",
            '  process.stderr.write(error instanceof Error ? error.message : "Unexpected non-Error refusal");',
            "  process.exitCode = 1;",
            "}",
          ].join("\n"),
          resolve(import.meta.dir, "install-preflight-runtime.ts"),
          archivePath,
        ], {
          cwd: installRoot,
          encoding: "utf8",
          env: installEnvironment(installRoot),
          killSignal: "SIGKILL",
          maxBuffer: 4_096,
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 2_000,
        });
        expect(result.error, result.error?.message).toBeUndefined();
        expect(result.signal).toBeNull();
        if (result.status === null) throw new Error("The bounded receipt check did not exit normally.");
        return { exitCode: result.status, stderr: result.stderr, stdout: result.stdout };
      },
    );
  });

  test("strips only dependency maps from the private installer fixture", () => {
    expect(sourcePackageManifest.dependencies).toEqual({
      "@agentclientprotocol/sdk": "1.4.0",
      "@hraness/local-custody": "0.5.1",
      "@hraness/oh": "0.10.8",
      "@openai/codex": "0.153.2",
      convex: "1.45.0",
      effect: "3.22.1",
      zod: "4.4.3",
    });
    const dependencyFreeSourceManifest = { ...sourcePackageManifest };
    delete dependencyFreeSourceManifest.dependencies;
    delete dependencyFreeSourceManifest.devDependencies;
    expect(installerFixtureManifest).toEqual(dependencyFreeSourceManifest);
  });

  test("binds the public command to one tagged preflight and one exact tagged archive", async () => {
    expect(OOMPA_INSTALL_PREFLIGHT_SOURCE_URL).toBe(
      "https://raw.githubusercontent.com/hraness/oompa/v0.8.5/src/install-preflight-runtime.ts",
    );
    expect(OOMPA_INSTALL_ARCHIVE_URL).toBe(
      "https://github.com/hraness/oompa/releases/download/v0.8.5/hraness-oompa-0.8.5.tgz",
    );
    const runtimeBytes = await readFile(resolve(import.meta.dir, "install-preflight-runtime.ts"));
    // The public digest names the runtime at the released tag; the working
    // tree may differ between releases. check-install-pins.ts proves equality
    // under a tag ref.
    expect(OOMPA_INSTALL_PREFLIGHT_SOURCE_SHA256).toMatch(/^[0-9a-f]{64}$/u);
    const runtimeSource = runtimeBytes.toString("utf8");
    expect(runtimeSource).not.toContain('"libc.so.6"');
    expect(runtimeSource).not.toContain('"libc.musl-x86_64.so.1"');
    expect(runtimeSource).not.toContain('"libc.musl-aarch64.so.1"');
    const normalizerBytes = await readFile(resolve(import.meta.dir, "install-normalizer.ts"));
    expect(createHash("sha256").update(normalizerBytes).digest("hex")).toBe(
      OOMPA_INSTALL_NORMALIZER_SHA256,
    );
  });

  test("neutralizes ambient runtime injection before the public installer and its children", async () => {
    const command = buildOompaGlobalInstallCommand(OOMPA_INSTALL_ARCHIVE_URL);
    const unsetRuntimeInjection = OOMPA_INSTALL_RUNTIME_INJECTION_ENVIRONMENT_NAMES.join(" ");
    expect(command).toBe(
      `test "$(unset ${unsetRuntimeInjection} && curl -fsSL --connect-timeout 10 --max-time 60 --max-filesize ${String(OOMPA_INSTALL_PREFLIGHT_SOURCE_MAXIMUM_BYTES)} --retry 3 --retry-delay 1 --retry-max-time 60 --proto '=https' --tlsv1.2 ${OOMPA_INSTALL_PREFLIGHT_SOURCE_URL} | command bun --no-env-file --config=/dev/null -e '${OOMPA_INSTALL_PREFLIGHT_LOADER}' -- ${OOMPA_INSTALL_ARCHIVE_URL} ${OOMPA_INSTALL_PREFLIGHT_SOURCE_SHA256})" = ${OOMPA_INSTALL_PREFLIGHT_SUCCESS}`,
    );
    expect(command).toContain("--connect-timeout 10");
    expect(command).toContain("--max-time 60");
    expect(command).toContain(`--max-filesize ${String(OOMPA_INSTALL_PREFLIGHT_SOURCE_MAXIMUM_BYTES)}`);
    expect(command).toContain("--retry 3");
    expect(command).toContain("--retry-max-time 60");
    expect(command).toContain(OOMPA_INSTALL_PREFLIGHT_SOURCE_SHA256);
    expect(() => buildOompaGlobalInstallCommand("https://example.com/hra.tgz")).toThrow(
      "exact immutable release archive URL",
    );
    expect(command).not.toContain("| bun - ");
    expect(command).not.toContain("bun add --global");
    expect(command).not.toContain("install-normalizer.ts");

    const preservedEnvironment = {
      BUN_CONFIG_REGISTRY: "https://registry.example.test",
      BUN_OPTIONS: "--preload=/untrusted/bun.ts",
      DYLD_INSERT_LIBRARIES: "/untrusted/darwin.dylib",
      HTTPS_PROXY: "https://proxy.example.test",
      LD_PRELOAD: "/untrusted/linux.so",
      NODE_OPTIONS: "--require=/untrusted/node.js",
      SSL_CERT_FILE: "/reviewed/ca.pem",
    };
    expect(sanitizeOompaInstallChildEnvironment(preservedEnvironment)).toEqual({
      BUN_CONFIG_REGISTRY: preservedEnvironment.BUN_CONFIG_REGISTRY,
      HTTPS_PROXY: preservedEnvironment.HTTPS_PROXY,
      SSL_CERT_FILE: preservedEnvironment.SSL_CERT_FILE,
    });

    const stageZeroRoot = await makeRoot("oompa-install-public-stage-zero-");
    const fixtureBin = join(stageZeroRoot, "bin");
    const preloadPath = join(stageZeroRoot, "ambient-preload.ts");
    const preloadSentinel = join(stageZeroRoot, "ambient-preload-ran");
    await mkdir(fixtureBin, { mode: 0o700 });
    await symlink(process.execPath, join(fixtureBin, "bun"));
    await writeFile(
      join(fixtureBin, "curl"),
      "#!/bin/sh\nprintf '%s\\n' 'not the tagged Oompa runtime'\n",
      { mode: 0o700 },
    );
    await writeFile(
      preloadPath,
      `await Bun.write(${JSON.stringify(preloadSentinel)}, "ambient preload executed\\n");\n`,
      { mode: 0o600 },
    );
    await writeFile(
      join(stageZeroRoot, "bunfig.toml"),
      `preload = [${JSON.stringify(preloadPath)}]\n`,
      { mode: 0o600 },
    );
    await writeFile(
      join(stageZeroRoot, ".env"),
      `BUN_OPTIONS=--preload=${preloadPath}\n`,
      { mode: 0o600 },
    );
    const stageZero = await run(["/bin/sh", "-c", command], {
      cwd: stageZeroRoot,
      environment: {
        ...installEnvironment(stageZeroRoot),
        BUN_OPTIONS: `--preload=${preloadPath}`,
        OOMPA_TEST_PRELOAD_SENTINEL: preloadSentinel,
        PATH: `${fixtureBin}:/usr/bin:/bin`,
      },
    });
    expect(stageZero.exitCode).not.toBe(0);
    expect(stageZero.stderr).toContain("tagged Oompa preflight digest is invalid");
    expect(stageZero.stdout).toBe("");
    expect(await Bun.file(preloadSentinel).exists()).toBeFalse();

    const oversizedRoot = await makeRoot("oompa-install-source-overrun-");
    const oversized = trackDirectTestChild(Bun.spawn([
      process.execPath,
      "--no-env-file",
      "--config=/dev/null",
      "-e",
      OOMPA_INSTALL_PREFLIGHT_LOADER,
      "--",
      archivePath,
      "0".repeat(64),
    ], {
      cwd: oversizedRoot,
      env: installEnvironment(oversizedRoot),
      stderr: "pipe",
      stdin: new Blob([new Uint8Array(OOMPA_INSTALL_PREFLIGHT_SOURCE_MAXIMUM_BYTES + 1)]),
      stdout: "pipe",
    }));
    const [oversizedExitCode, oversizedStderr, oversizedStdout] = await Promise.all([
      oversized.exited,
      new Response(oversized.stderr).text(),
      new Response(oversized.stdout).text(),
    ]);
    expect(oversizedExitCode).not.toBe(0);
    expect(oversizedStderr).toContain("tagged Oompa preflight exceeds its byte limit");
    expect(oversizedStdout).toBe("");
    expect(await Bun.file(join(oversizedRoot, "bun root")).exists()).toBeFalse();

    const refusedRoot = await makeRoot("oompa-install-source-refusal-");
    const refused = await runTrustedLoader(refusedRoot, "0".repeat(64));
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr).toContain("tagged Oompa preflight digest is invalid");
    expect(refused.stdout).toBe("");
    expect(await Bun.file(join(refusedRoot, "bun root")).exists()).toBeFalse();

    const unsafeRoot = await makeRoot("oompa-install-stage-zero-refusal-");
    const unsafe = await runTrustedLoader(unsafeRoot, localRuntimeSha256, {
      BUN_OPTIONS: "",
    });
    expect(unsafe.exitCode).not.toBe(0);
    expect(unsafe.stderr).toContain("requires a neutral Bun stage zero");
    expect(unsafe.stdout).toBe("");
    expect(await Bun.file(join(unsafeRoot, "bun root")).exists()).toBeFalse();
  });

  test("accepts only one immutable GitHub release asset under the exact repository identity", () => {
    const acceptedRelease = officialReleaseRecord({
      future_release_field: { ignored: true },
      assets: [officialArchiveAsset({ future_asset_field: ["ignored"] })],
    });
    expect(parseOfficialOompaReleaseRecord(acceptedRelease)).toEqual({
      archiveAssetId: 8_675_309,
      archiveBytes: 123,
      archiveReleaseId: 9_715_113,
      archiveReleaseTag: "v0.8.5",
      archiveRepositoryId: OOMPA_INSTALL_REPOSITORY_ID,
      archiveSha256,
      archiveSource: "official",
    });
    expect(() => parseOfficialOompaRepositoryRecord(officialRepositoryRecord({
      future_repository_field: "ignored",
    }))).not.toThrow();

    const releaseFailures: readonly Readonly<{
      label: string;
      record: Readonly<Record<string, unknown>>;
      message: string;
    }>[] = [
      {
        label: "wrong tag",
        message: "not an immutable published release",
        record: officialReleaseRecord({ tag_name: "v0.1.8" }),
      },
      {
        label: "draft release",
        message: "not an immutable published release",
        record: officialReleaseRecord({ draft: true }),
      },
      {
        label: "mutable release",
        message: "not an immutable published release",
        record: officialReleaseRecord({ immutable: false }),
      },
      {
        label: "duplicate exact assets",
        message: "one exact archive asset",
        record: officialReleaseRecord({
          assets: [officialArchiveAsset(), officialArchiveAsset({ id: 8_675_310 })],
        }),
      },
      {
        label: "missing exact asset",
        message: "one exact archive asset",
        record: officialReleaseRecord({
          assets: [officialArchiveAsset({
            browser_download_url: "https://example.com/oompa-v0.8.5.tgz",
            name: "other.tgz",
          })],
        }),
      },
      {
        label: "missing digest",
        message: "archive asset is invalid",
        record: officialReleaseRecord({ assets: [officialArchiveAsset({ digest: undefined })] }),
      },
      {
        label: "invalid digest",
        message: "no exact SHA-256 digest",
        record: officialReleaseRecord({
          assets: [officialArchiveAsset({ digest: `sha256:${"A".repeat(64)}` })],
        }),
      },
    ];
    for (const failure of releaseFailures) {
      expect(() => parseOfficialOompaReleaseRecord(failure.record)).toThrow(failure.message);
    }

    for (const record of [
      officialRepositoryRecord({ id: OOMPA_INSTALL_REPOSITORY_ID + 1 }),
      officialRepositoryRecord({ full_name: "attacker/oompa" }),
      officialRepositoryRecord({ private: true }),
      officialRepositoryRecord({ archived: true }),
      officialRepositoryRecord({ disabled: true }),
    ] as const) {
      expect(() => parseOfficialOompaRepositoryRecord(record)).toThrow(
        "GitHub repository identity is invalid",
      );
    }
  });

  test("fetches bounded release authority records without redirects, credentials, or encodings", async () => {
    const calls: Array<Readonly<{ init: RequestInit; url: string }>> = [];
    const identity = await resolveOfficialOompaArchiveIdentity(async (url, init) => {
      calls.push({ init, url });
      if (url === OOMPA_INSTALL_REPOSITORY_API_URL) return jsonResponse(officialRepositoryRecord());
      if (url === OOMPA_INSTALL_RELEASE_API_URL) return jsonResponse(officialReleaseRecord());
      throw new Error(`Unexpected release-authority URL: ${url}`);
    });
    expect(identity.archiveRepositoryId).toBe(OOMPA_INSTALL_REPOSITORY_ID);
    expect(identity.archiveSha256).toBe(archiveSha256);
    expect(new Set(calls.map((call) => call.url))).toEqual(new Set([
      OOMPA_INSTALL_REPOSITORY_API_URL,
      OOMPA_INSTALL_RELEASE_API_URL,
    ]));
    for (const call of calls) {
      const headers = new Headers(call.init.headers);
      expect(call.init.cache).toBe("no-store");
      expect(call.init.credentials).toBe("omit");
      expect(call.init.redirect).toBe("error");
      expect(call.init.signal).toBeInstanceOf(AbortSignal);
      expect(headers.get("accept")).toBe("application/vnd.github+json");
      expect(headers.get("accept-encoding")).toBe("identity");
      expect(headers.get("user-agent")).toBe("oompa-installer/0.8.5");
      expect(headers.get("x-github-api-version")).toBe("2022-11-28");
      expect(headers.get("authorization")).toBeNull();
    }
  });

  test("rejects redirected, encoded, malformed, empty, and length-confused release records", async () => {
    const failures: readonly Readonly<{
      label: string;
      message: string;
      response: () => Response;
    }>[] = [
      {
        label: "redirect",
        message: "release record is unavailable",
        response: () => new Response(null, { headers: { Location: "https://example.com" }, status: 302 }),
      },
      {
        label: "encoded body",
        message: "unrequested content encoding",
        response: () => jsonResponse(officialReleaseRecord(), { headers: { "Content-Encoding": "gzip" } }),
      },
      {
        label: "zero content length",
        message: "invalid byte length",
        response: () => new Response("{}", { headers: { "Content-Length": "0" }, status: 200 }),
      },
      {
        label: "oversize declared content length",
        message: "exceeds its byte bound",
        response: () => new Response("{}", { headers: { "Content-Length": "262145" }, status: 200 }),
      },
      {
        label: "truncated declared body",
        message: "ended outside its declared byte length",
        response: () => new Response("{}", { headers: { "Content-Length": "3" }, status: 200 }),
      },
      {
        label: "malformed JSON",
        message: "invalid JSON",
        response: () => new Response("{", { headers: { "Content-Length": "1" }, status: 200 }),
      },
      {
        label: "invalid UTF-8 JSON",
        message: "invalid JSON",
        response: () => new Response(Uint8Array.of(0xff), {
          headers: { "Content-Length": "1" },
          status: 200,
        }),
      },
      {
        label: "missing body",
        message: "no bounded body",
        response: () => new Response(null, { status: 200 }),
      },
    ];
    for (const failure of failures) {
      const operation = resolveOfficialOompaArchiveIdentity(async (url) =>
        url === OOMPA_INSTALL_REPOSITORY_API_URL
          ? jsonResponse(officialRepositoryRecord())
          : failure.response());
      await expect(operation).rejects.toThrow(failure.message);
    }
  });

  test("keeps Bun's post-link tree private, verifies the complete version, and atomically activates only its CLI", async () => {
    const root = await makeRoot("oompa install transactional ");
    const first = await runTrustedLoader(root);
    expect(first).toEqual({
      exitCode: 0,
      stderr: "",
      stdout: `${OOMPA_INSTALL_PREFLIGHT_SUCCESS}\n`,
    });
    const bunRoot = join(root, "bun root");
    const activePath = join(bunRoot, "bin", "oompa");
    const activeMetadata = await lstat(activePath);
    expect(activeMetadata.isSymbolicLink()).toBeTrue();
    const activeTarget = await realpath(activePath);
    expect(activeTarget).toContain(`${join(bunRoot, "install", "oompa", "versions")}/`);
    expect(activeTarget).toEndWith("/install/global/node_modules/@hraness/oompa/src/cli.ts");
    expect((await lstat(activeTarget)).mode & 0o777).toBe(0o755);
    expect(await Bun.file(join(bunRoot, "install", "global", "node_modules", "@hraness", "oompa")).exists()).toBeFalse();
    expect(await Bun.file(join(bunRoot, "install", "oompa", "install-intent.json")).exists()).toBeFalse();
    const versions = await readdir(join(bunRoot, "install", "oompa", "versions"));
    expect(versions).toHaveLength(1);
    expect(await Bun.file(join(
      bunRoot,
      "install",
      "oompa",
      "versions",
      versions[0] as string,
      ".hra-install-complete.json",
    )).exists()).toBeTrue();
    expect(await readJsonRecord(join(
      bunRoot,
      "install",
      "oompa",
      "versions",
      versions[0] as string,
      "install",
      "global",
      "package.json",
    ))).toEqual({ dependencies: { "@hraness/oompa": "0.8.5" } });

    const second = await runInstaller(root);
    expect(second).toEqual({
      exitCode: 0,
      stderr: "",
      stdout: `${OOMPA_INSTALL_PREFLIGHT_SUCCESS}\n`,
    });
    expect(await realpath(activePath)).toBe(activeTarget);
    expect(await readdir(join(bunRoot, "install", "oompa", "versions"))).toEqual(versions);
  }, SERIAL_STAGING_INSTALL_TEST_TIMEOUT_MS);

  test("rejects a staged loopback archive URL with a malformed route UUID or archive filename", async () => {
    for (const mutation of ["route-uuid", "archive-name"] as const) {
      const root = await makeRoot(`oompa-install-loopback-${mutation}-`);
      await mkdir(join(root, "home"), { mode: 0o700 });
      const authorityRoot = join(root, "bun root", "install", "oompa");
      const runtimePath = resolve(import.meta.dir, "install-preflight-runtime.ts");
      const program = [
        `const module = await import(${JSON.stringify(runtimePath)});`,
        `await module.installOompaRelease(${JSON.stringify(archivePath)}, {`,
        `  stageDeadlineMilliseconds: ${String(TEST_STAGING_DEADLINE_MS)},`,
        "  afterStageWorkerExit: async () => {",
        '    const fs = await import("node:fs/promises");',
        '    const path = await import("node:path");',
        `    const authorityRoot = ${JSON.stringify(authorityRoot)};`,
        '    const stageName = (await fs.readdir(authorityRoot)).find((entry) => entry.startsWith(".staging-"));',
        '    if (!stageName) throw new Error("staging root is missing");',
        '    const manifestPath = path.join(authorityRoot, stageName, "install", "global", "package.json");',
        "    const manifest = JSON.parse(await fs.readFile(manifestPath, \"utf8\"));",
        "    const archiveUrl = new URL(manifest.dependencies[module.OOMPA_INSTALL_PACKAGE_NAME]);",
        mutation === "route-uuid"
          ? '    archiveUrl.pathname = "/not-a-v4-uuid/" + module.OOMPA_INSTALL_ARCHIVE_NAME;'
          : '    archiveUrl.pathname = archiveUrl.pathname.replace(/[^/]+$/u, "unexpected.tgz");',
        "    manifest.dependencies[module.OOMPA_INSTALL_PACKAGE_NAME] = archiveUrl.toString();",
        '    await fs.writeFile(manifestPath, JSON.stringify(manifest) + "\\n", { mode: 0o600 });',
        "  },",
        "});",
      ].join("\n");
      const result = await run([process.execPath, "-e", program], {
        cwd: root,
        environment: installEnvironment(root),
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("descriptor-bound loopback archive authority");
      expect(result.stdout).toBe("");
      expect(await Bun.file(join(root, "bun root", "bin", "oompa")).exists()).toBeFalse();
    }
  }, 60_000);

  test("scrubs ambient runtime preloads from the detached worker and Bun add", async () => {
    const root = await makeRoot("oompa-install-runtime-preload-");
    const installed = await runInstaller(root, true);
    expect(installed).toEqual({
      exitCode: 0,
      stderr: "",
      stdout: `${OOMPA_INSTALL_PREFLIGHT_SUCCESS}\n`,
    });
    expect(await Bun.file(join(root, "bun root", "bin", "oompa")).exists()).toBeTrue();
  }, SERIAL_STAGING_INSTALL_TEST_TIMEOUT_MS);

  test("upgrades and recovers a verified legacy unscoped 0.1.0 installation", async () => {
    const root = await makeRoot("oompa-install-legacy-upgrade-");
    const legacy = await createSyntheticPreviousInstall(root, {
      packageName: "hra",
      packageVersion: "0.1.0",
    });
    const legacyCliBefore = await readFile(legacy.cliPath);
    const legacyReceiptBefore = await readFile(legacy.receiptPath);
    const legacyTreeBefore = await measureSyntheticVersion(legacy.versionRoot);
    await mkdir(join(root, "home"), { mode: 0o700 });
    const runtimePath = resolve(import.meta.dir, "install-preflight-runtime.ts");
    const interrupted = await run([
      process.execPath,
      "-e",
      [
        `const module = await import(${JSON.stringify(runtimePath)});`,
        `await module.installOompaRelease(${JSON.stringify(archivePath)}, {`,
        `  stageDeadlineMilliseconds: ${String(TEST_STAGING_DEADLINE_MS)},`,
        '  afterNormalized: () => { throw new Error("test legacy normalized interruption"); },',
        "});",
      ].join("\n"),
    ], { cwd: root, environment: installEnvironment(root) });
    expect(interrupted.exitCode).not.toBe(0);
    expect(interrupted.stderr).toContain("test legacy normalized interruption");
    expect(interrupted.stdout).toBe("");
    expect(await readlink(legacy.activePath)).toBe(legacy.cliPath);
    expect(await readFile(legacy.cliPath)).toEqual(legacyCliBefore);
    expect(await readFile(legacy.receiptPath)).toEqual(legacyReceiptBefore);
    expect(await measureSyntheticVersion(legacy.versionRoot)).toEqual(legacyTreeBefore);
    expect(await readJsonRecord(join(legacy.authorityRoot, "install-intent.json"))).toMatchObject({
      phase: "normalized",
      previousActiveTarget: legacy.cliPath,
    });
    expect((await readdir(legacy.authorityRoot)).some((entry) => entry.startsWith(".staging-"))).toBeFalse();

    const recovered = await runInstaller(root);
    expect(recovered).toEqual({
      exitCode: 0,
      stderr: "",
      stdout: `${OOMPA_INSTALL_PREFLIGHT_SUCCESS}\n`,
    });
    const activeTarget = await readlink(legacy.activePath);
    expect(activeTarget).not.toBe(legacy.cliPath);
    expect(activeTarget).toEndWith("/install/global/node_modules/@hraness/oompa/src/cli.ts");
    expect(await realpath(legacy.activePath)).toBe(activeTarget);
    expect(await readFile(legacy.cliPath)).toEqual(legacyCliBefore);
    expect(await readFile(legacy.receiptPath)).toEqual(legacyReceiptBefore);
    expect(await measureSyntheticVersion(legacy.versionRoot)).toEqual(legacyTreeBefore);
    expect(await readdir(legacy.versionsRoot)).toHaveLength(2);
    await expectNoStartedInstall(legacy);
  }, SERIAL_STAGING_INSTALL_TEST_TIMEOUT_MS);

  for (const priorRelease of [
    {
      tag: "v0.6.0",
      archive: "https://github.com/hraness/hra/releases/download/v0.6.0/hraness-hra-0.6.0.tgz",
      archiveAssetId: 547_641_759,
      archiveBytes: 1_101_240,
      archiveReleaseId: 383_705_969,
      archiveSha256: "f9f1bfecddd867e4ca781a2a045dc9573bd91eb9810fef75b2d28e8af0c37813",
      normalizerSha256: "8c739ce5bf5e52071ef805cec6aaf8e992005348b74b0264a3b88b6593be1cd9",
      cliSha256: "0b2f72b51ddee7a90d5a395960cba98a046da74484808aca9801167d61844ba3",
    },
    {
      tag: "v0.6.2",
      archive: "https://github.com/hraness/hra/releases/download/v0.6.2/hraness-hra-0.6.2.tgz",
      archiveAssetId: 549_302_017,
      archiveBytes: 1_160_242,
      archiveReleaseId: 384_290_677,
      archiveSha256: "b5bc2a9125885c6ace33a70137202e99e1d6774f5d8945fac9bb96b6353c930c",
      normalizerSha256: "2f9851effc7b52f59ee3ef8d0e5e096d33fb7e63bcb1fff1d533c2207d003148",
      cliSha256: "2974ddeb3795f6d896b365c2f2c0bff92e745ccd047e1628ef9acb5f2a5e0f1e",
    },
    {
      tag: "v0.7.0",
      archive: "https://github.com/hraness/hra/releases/download/v0.7.0/hraness-hra-0.7.0.tgz",
      archiveAssetId: 551_312_890,
      archiveBytes: 1_359_243,
      archiveReleaseId: 385_063_983,
      archiveSha256: "6a067b5efb48bb9253f132300b09e59ae45a6e90c8f97532b5deabdc802a1061",
      normalizerSha256: "24cb487fda4dfd9ec1ec9f23048a245f7dfd1dfd60b5fa8c8b3e31193967a31e",
      cliSha256: "6635ac9aab44cf8e6ae5f833ea063eb080f922de8659b0d9825a2a4c2e9af310",
    },
  ]) {
    test(`refuses and preserves an interrupted intent owned by immutable ${priorRelease.tag}`, async () => {
      const root = await makeRoot("oompa-install-prior-release-intent-");
      const previous = await createSyntheticPreviousInstall(root, {
        archiveSource: "official",
        packageName: "@hraness/oompa",
        packageVersion: "0.5.0",
      });
      const priorArchiveSha256 = priorRelease.archiveSha256;
      const priorNormalizerSha256 = priorRelease.normalizerSha256;
      const priorCliSha256 = priorRelease.cliSha256;
      const priorVersionRoot = join(previous.versionsRoot, [
        priorRelease.tag,
        "official",
        priorArchiveSha256,
        priorNormalizerSha256,
        priorCliSha256,
      ].join("-"));
      const priorStagingRoot = join(
        previous.authorityRoot,
        ".staging-00000000-0000-4000-8000-000000000002",
      );
      const intentPath = join(previous.authorityRoot, "install-intent.json");
      const stageSentinelPath = join(priorStagingRoot, "prior-release-stage");
      await mkdir(priorStagingRoot, { mode: 0o700 });
      await chmod(priorStagingRoot, 0o700);
      await writeFile(stageSentinelPath, "prior release stage\n", { mode: 0o600 });
      const priorIntent = {
        archive: priorRelease.archive,
        archiveAssetId: priorRelease.archiveAssetId,
        archiveBytes: priorRelease.archiveBytes,
        archiveReleaseId: priorRelease.archiveReleaseId,
        archiveReleaseTag: priorRelease.tag,
        archiveRepositoryId: OOMPA_INSTALL_REPOSITORY_ID,
        archiveSha256: priorArchiveSha256,
        archiveSource: "official",
        createdAt: 1_757_192_400_000,
        id: "00000000-0000-4000-8000-000000000002",
        normalizerSha256: priorNormalizerSha256,
        phase: "prepared",
        previousActiveTarget: previous.cliPath,
        stagingRoot: priorStagingRoot,
        version: 2,
        versionRoot: priorVersionRoot,
      } as const;
      await writePrivateJson(intentPath, priorIntent);
      const activeTargetBefore = await readlink(previous.activePath);
      const intentBefore = await readFile(intentPath);
      const previousReceiptBefore = await readFile(previous.receiptPath);
      const previousTreeBefore = await measureSyntheticVersion(previous.versionRoot);
      const versionsBefore = (await readdir(previous.versionsRoot)).sort();
      const stageSentinelBefore = await readFile(stageSentinelPath);

      const result = await runInstaller(root);

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("invalid or belongs to another release");
      expect(result.stderr).toContain("rerun the exact originating release installer");
      expect(result.stdout).toBe("");
      expect(await readlink(previous.activePath)).toBe(activeTargetBefore);
      expect(await readFile(intentPath)).toEqual(intentBefore);
      expect(await readFile(previous.receiptPath)).toEqual(previousReceiptBefore);
      expect(await measureSyntheticVersion(previous.versionRoot)).toEqual(previousTreeBefore);
      expect((await readdir(previous.versionsRoot)).sort()).toEqual(versionsBefore);
      expect(await readFile(stageSentinelPath)).toEqual(stageSentinelBefore);
      expect((await lstat(priorStagingRoot)).mode & 0o777).toBe(0o700);

      // A release may reuse an unchanged normalizer. The current installer must
      // still render the same actionable, non-mutating refusal when parsing gets
      // as far as the foreign release tag instead of relying on a digest change.
      await writePrivateJson(intentPath, {
        ...priorIntent,
        normalizerSha256: OOMPA_INSTALL_NORMALIZER_SHA256,
      });
      const sameNormalizerIntent = await readFile(intentPath);
      const sameNormalizerResult = await runInstaller(root);
      expect(sameNormalizerResult.exitCode).not.toBe(0);
      expect(sameNormalizerResult.stderr).toContain("invalid or belongs to another release");
      expect(sameNormalizerResult.stderr).toContain("rerun the exact originating release installer");
      expect(sameNormalizerResult.stdout).toBe("");
      expect(await readFile(intentPath)).toEqual(sameNormalizerIntent);
      expect(await readlink(previous.activePath)).toBe(activeTargetBefore);
      expect(await readFile(previous.receiptPath)).toEqual(previousReceiptBefore);
      expect(await measureSyntheticVersion(previous.versionRoot)).toEqual(previousTreeBefore);
      expect((await readdir(previous.versionsRoot)).sort()).toEqual(versionsBefore);
      expect(await readFile(stageSentinelPath)).toEqual(stageSentinelBefore);
    });
  }

  test("accepts an older scoped official release as verified previous authority", async () => {
    const root = await makeRoot("oompa-install-older-scoped-");
    const previous = await createSyntheticPreviousInstall(root, {
      archiveSource: "official",
      packageName: "@hraness/oompa",
      packageVersion: "0.1.4",
    });
    const receiptBefore = await readFile(previous.receiptPath);
    const treeBefore = await measureSyntheticVersion(previous.versionRoot);
    const result = await runInstaller(root);
    expect(result).toEqual({
      exitCode: 0,
      stderr: "",
      stdout: `${OOMPA_INSTALL_PREFLIGHT_SUCCESS}\n`,
    });
    const activeTarget = await readlink(previous.activePath);
    expect(activeTarget).not.toBe(previous.cliPath);
    expect(activeTarget).toEndWith("/install/global/node_modules/@hraness/oompa/src/cli.ts");
    expect(await readFile(previous.receiptPath)).toEqual(receiptBefore);
    expect(await measureSyntheticVersion(previous.versionRoot)).toEqual(treeBefore);
    expect(await readdir(previous.versionsRoot)).toHaveLength(2);
    await expectNoStartedInstall(previous);
  }, SERIAL_STAGING_INSTALL_TEST_TIMEOUT_MS);

  test("rejects invalid previous package identities before staging", async () => {
    const unsupportedRoot = await makeRoot("oompa-install-legacy-version-refusal-");
    const unsupported = await createSyntheticPreviousInstall(unsupportedRoot, {
      packageName: "hra",
      packageVersion: "0.1.1",
    });
    await expectPreviousInstallRejectedBeforeStaging(unsupported, "legacy Oompa version receipt is invalid");

    const invalidSemverRoot = await makeRoot("oompa-install-semver-refusal-");
    const invalidSemver = await createSyntheticPreviousInstall(invalidSemverRoot, {
      packageName: "@hraness/oompa",
      packageVersion: "01.2.3",
    });
    await expectPreviousInstallRejectedBeforeStaging(invalidSemver, "complete Oompa version receipt is invalid");

    const officialTagRoot = await makeRoot("oompa-install-old-tag-refusal-");
    const officialTag = await createSyntheticPreviousInstall(officialTagRoot, {
      archiveSource: "official",
      packageName: "@hraness/oompa",
      packageVersion: "0.1.4",
    });
    const officialReceipt = await readJsonRecord(officialTag.receiptPath);
    officialReceipt.archiveReleaseTag = "v0.1.3";
    await writePrivateJson(officialTag.receiptPath, officialReceipt);
    await expectPreviousInstallRejectedBeforeStaging(officialTag, "official archive authority is invalid");

    const manifestRoot = await makeRoot("oompa-install-old-manifest-refusal-");
    const manifest = await createSyntheticPreviousInstall(manifestRoot, {
      packageName: "hra",
      packageVersion: "0.1.0",
    });
    const manifestValue = await readJsonRecord(manifest.packageManifestPath);
    manifestValue.name = "@hraness/oompa";
    await writePrivateJson(manifest.packageManifestPath, manifestValue);
    await resealSyntheticVersion(manifest);
    await expectPreviousInstallRejectedBeforeStaging(manifest, "installed Oompa package identity is not exact");

    const layoutRoot = await makeRoot("oompa-install-receipt-layout-refusal-");
    const layout = await createSyntheticPreviousInstall(layoutRoot, {
      layoutPackageName: "hra",
      manifestPackageName: "hra",
      packageName: "@hraness/oompa",
      packageVersion: "0.1.4",
    });
    await expectPreviousInstallRejectedBeforeStaging(layout, "package layout that conflicts with its receipt");

    const mixedRoot = await makeRoot("oompa-install-mixed-layout-refusal-");
    const mixed = await createSyntheticPreviousInstall(mixedRoot, {
      packageName: "hra",
      packageVersion: "0.1.0",
    });
    const alternatePackageRoot = join(
      mixed.versionRoot,
      "install",
      "global",
      "node_modules",
      "@hraness",
      "oompa",
    );
    await mkdir(alternatePackageRoot, { recursive: true, mode: 0o700 });
    await chmod(join(mixed.versionRoot, "install", "global", "node_modules", "@hraness"), 0o700);
    await chmod(alternatePackageRoot, 0o700);
    await expectPreviousInstallRejectedBeforeStaging(mixed, "package layout that conflicts with its receipt");

    const integrityRoot = await makeRoot("oompa-install-legacy-integrity-refusal-");
    const integrity = await createSyntheticPreviousInstall(integrityRoot, {
      packageName: "hra",
      packageVersion: "0.1.0",
    });
    const damagedCli = Buffer.from(await readFile(integrity.cliPath));
    damagedCli[0] = (damagedCli[0] ?? 0) ^ 1;
    await writeFile(integrity.cliPath, damagedCli, { mode: 0o755 });
    await chmod(integrity.cliPath, 0o755);
    await expectPreviousInstallRejectedBeforeStaging(integrity, "durable tree receipt");

    const symlinkRoot = await makeRoot("oompa-install-legacy-root-symlink-refusal-");
    const symlinked = await createSyntheticPreviousInstall(symlinkRoot, {
      packageName: "hra",
      packageVersion: "0.1.0",
    });
    const heldVersionRoot = `${symlinked.versionRoot}-held`;
    await rename(symlinked.versionRoot, heldVersionRoot);
    await symlink(heldVersionRoot, symlinked.versionRoot);
    await expectPreviousInstallRejectedBeforeStaging(symlinked, "version root is not canonical");
  }, 60_000);

  test("rejects noncanonical previous-active target layouts before staging", async () => {
    const cases: readonly Readonly<{
      label: string;
      message: string;
      target: (fixture: SyntheticPreviousInstall) => string;
    }>[] = [
      {
        label: "relative target",
        message: "target is not canonical and absolute",
        target: () => "../install/oompa/versions/relative/install/global/node_modules/oompa/src/cli.ts",
      },
      {
        label: "outside authority",
        message: "outside its protected version authority",
        target: (fixture) => join(fixture.root, "outside", "cli.ts"),
      },
      {
        label: "arbitrary package",
        message: "does not use a supported exact package layout",
        target: (fixture) => join(
          fixture.versionRoot,
          "install",
          "global",
          "node_modules",
          "attacker",
          "src",
          "cli.ts",
        ),
      },
      {
        label: "extra nesting",
        message: "does not use a supported exact package layout",
        target: (fixture) => join(
          fixture.versionRoot,
          "extra",
          "install",
          "global",
          "node_modules",
          "oompa",
          "src",
          "cli.ts",
        ),
      },
      {
        label: "missing component",
        message: "does not use a supported exact package layout",
        target: (fixture) => join(
          fixture.versionRoot,
          "install",
          "global",
          "oompa",
          "src",
          "cli.ts",
        ),
      },
      {
        label: "stale version",
        message: "names a missing complete version",
        target: (fixture) => join(
          fixture.versionsRoot,
          `v0.1.0-local-${"0".repeat(64)}-${"1".repeat(64)}-${"2".repeat(64)}`,
          "install",
          "global",
          "node_modules",
          "hra",
          "src",
          "cli.ts",
        ),
      },
    ];
    for (const testCase of cases) {
      const root = await makeRoot(`oompa-install-active-layout-${testCase.label.replaceAll(" ", "-")}-`);
      const fixture = await createSyntheticPreviousInstall(root, {
        packageName: "hra",
        packageVersion: "0.1.0",
      });
      await replaceSyntheticActiveTarget(fixture, testCase.target(fixture));
      await expectPreviousInstallRejectedBeforeStaging(fixture, testCase.message);
    }
  }, 60_000);

  test("keeps identical local and official archives in distinct namespaces and fetches the official asset", async () => {
    const root = await makeRoot("oompa-install-source-classes-");
    const local = await runInstaller(root);
    expect(local).toEqual({
      exitCode: 0,
      stderr: "",
      stdout: `${OOMPA_INSTALL_PREFLIGHT_SUCCESS}\n`,
    });
    const bunRoot = join(root, "bun root");
    const versionsRoot = join(bunRoot, "install", "oompa", "versions");
    const localVersions = await readdir(versionsRoot);
    expect(localVersions).toHaveLength(1);
    expect(localVersions[0]).toContain("-local-");

    const official = await runOfficialInstaller(root, "success");
    expect({
      exitCode: official.exitCode,
      stderr: official.stderr,
      stdout: official.stdout,
    }).toEqual({
      exitCode: 0,
      stderr: "",
      stdout: `${OOMPA_INSTALL_PREFLIGHT_SUCCESS}\n`,
    });
    const versions = (await readdir(versionsRoot)).sort();
    expect(versions).toHaveLength(2);
    const localVersion = versions.find((entry) => entry.includes("-local-"));
    const officialVersion = versions.find((entry) => entry.includes("-official-"));
    expect(localVersion).toBeDefined();
    expect(officialVersion).toBeDefined();
    expect(localVersion).not.toBe(officialVersion);

    const localReceipt = await readJsonRecord(join(
      versionsRoot,
      localVersion as string,
      ".hra-install-complete.json",
    ));
    const officialReceipt = await readJsonRecord(join(
      versionsRoot,
      officialVersion as string,
      ".hra-install-complete.json",
    ));
    expect(localReceipt.archiveSource).toBe("local");
    expect(localReceipt.archiveSha256).toBe(archiveSha256);
    expect(localReceipt.archiveRepositoryId).toBeNull();
    expect(localReceipt.archiveReleaseId).toBeNull();
    expect(localReceipt.archiveAssetId).toBeNull();
    expect(officialReceipt.archiveSource).toBe("official");
    expect(officialReceipt.archiveSha256).toBe(archiveSha256);
    expect(officialReceipt.archiveRepositoryId).toBe(OOMPA_INSTALL_REPOSITORY_ID);
    expect(officialReceipt.archiveReleaseId).toBe(9_715_113);
    expect(officialReceipt.archiveAssetId).toBe(8_675_309);
    expect(await realpath(join(bunRoot, "bin", "oompa"))).toContain(`/${officialVersion as string}/`);

    const observedUrls = new Set(official.observations.map((observation) => observation.url));
    for (const expectedUrl of [
      OOMPA_INSTALL_REPOSITORY_API_URL,
      OOMPA_INSTALL_RELEASE_API_URL,
      OOMPA_INSTALL_ARCHIVE_URL,
      "https://release-assets.githubusercontent.com/oompa-test/archive.tgz",
    ]) expect(observedUrls.has(expectedUrl)).toBeTrue();
    const archiveRequests = official.observations.filter((observation) =>
      observation.url === OOMPA_INSTALL_ARCHIVE_URL
      || observation.url === "https://release-assets.githubusercontent.com/oompa-test/archive.tgz");
    expect(archiveRequests).toHaveLength(2);
    for (const request of archiveRequests) {
      expect(request.accept).toBe("application/octet-stream");
      expect(request.acceptEncoding).toBe("identity");
      expect(request.cache).toBe("no-store");
      expect(request.credentials).toBe("omit");
      expect(request.redirect).toBe("manual");
    }
  }, SERIAL_STAGING_INSTALL_TEST_TIMEOUT_MS);

  test("rejects disallowed redirects, truncation, overrun, and a wrong official archive hash", async () => {
    const failures: readonly Readonly<{
      message: string;
      scenario: Exclude<OfficialInstallScenario, "success">;
    }>[] = [
      {
        message: "left its GitHub download authority",
        scenario: "disallowed-redirect",
      },
      {
        message: "does not match its immutable SHA-256 identity",
        scenario: "truncated",
      },
      {
        message: "exceeds its immutable byte length",
        scenario: "overrun",
      },
      {
        message: "does not match its immutable SHA-256 identity",
        scenario: "wrong-hash",
      },
    ];
    for (const failure of failures) {
      const root = await makeRoot(`oompa-install-official-${failure.scenario}-`);
      const result = await runOfficialInstaller(root, failure.scenario);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain(failure.message);
      expect(result.stdout).toBe("");
      expect(result.observations.some((observation) => observation.url === OOMPA_INSTALL_ARCHIVE_URL)).toBeTrue();
      expect(await Bun.file(join(root, "bun root", "bin", "oompa")).exists()).toBeFalse();
    }
  }, 60_000);

  test("rejects a same-size local archive mutation after recording its identity", async () => {
    const root = await makeRoot("oompa-install-local-mutation-");
    await mkdir(join(root, "home"), { mode: 0o700 });
    const localArchive = join(root, "mutable-hra.tgz");
    const original = await readFile(archivePath);
    await writeFile(localArchive, original, { mode: 0o600 });
    const runtimePath = resolve(import.meta.dir, "install-preflight-runtime.ts");
    const program = [
      'const fs = await import("node:fs/promises");',
      `const module = await import(${JSON.stringify(runtimePath)});`,
      `const archive = ${JSON.stringify(localArchive)};`,
      "await module.installOompaRelease(archive, {",
      `  stageDeadlineMilliseconds: ${String(TEST_STAGING_DEADLINE_MS)},`,
      "  afterArchiveIdentityResolved: async () => {",
      "    const bytes = Buffer.from(await fs.readFile(archive));",
      "    bytes[0] = (bytes[0] ?? 0) ^ 1;",
      "    await fs.writeFile(archive, bytes, { mode: 0o600 });",
      "  },",
      "});",
    ].join("\n");
    const result = await run([process.execPath, "-e", program], {
      cwd: root,
      environment: installEnvironment(root),
    });
    expect((await lstat(localArchive)).size).toBe(original.byteLength);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("changed after its identity was recorded");
    expect(result.stdout).toBe("");
    expect(await Bun.file(join(root, "bun root", "bin", "oompa")).exists()).toBeFalse();
  });

  test("reopens and rejects a same-size mutation of the private official archive copy", async () => {
    const root = await makeRoot("oompa-install-private-archive-mutation-");
    const result = await runOfficialInstaller(root, "success", true);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("private Oompa archive copy changed");
    expect(result.stdout).toBe("");
    expect(result.observations.some((observation) =>
      observation.url === "https://release-assets.githubusercontent.com/oompa-test/archive.tgz")).toBeTrue();
    expect(await Bun.file(join(root, "bun root", "bin", "oompa")).exists()).toBeFalse();
  });

  test("refuses a private archive changed after parent verification but before worker custody", async () => {
    const root = await makeRoot("oompa-install-worker-archive-mutation-");
    await mkdir(join(root, "home"), { mode: 0o700 });
    const runtimePath = resolve(import.meta.dir, "install-preflight-runtime.ts");
    const program = [
      'const fs = await import("node:fs/promises");',
      `const module = await import(${JSON.stringify(runtimePath)});`,
      `await module.installOompaRelease(${JSON.stringify(archivePath)}, {`,
      `  stageDeadlineMilliseconds: ${String(TEST_STAGING_DEADLINE_MS)},`,
      "  beforeStageWorkerSpawn: async (privateArchivePath) => {",
      "    const bytes = Buffer.from(await fs.readFile(privateArchivePath));",
      "    bytes[0] = (bytes[0] ?? 0) ^ 1;",
      "    await fs.writeFile(privateArchivePath, bytes, { mode: 0o600 });",
      "  },",
      "});",
    ].join("\n");
    const result = await run([process.execPath, "-e", program], {
      cwd: root,
      environment: installEnvironment(root),
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("ended before publishing complete lock readiness");
    expect(result.stdout).toBe("");
    expect(await Bun.file(join(root, "bun root", "bin", "oompa")).exists()).toBeFalse();
  });

  test("refuses a private archive changed after the worker snapshots it without re-signaling the settled Bun group", async () => {
    const root = await makeRoot("oompa-install-worker-post-snapshot-mutation-");
    await mkdir(join(root, "home"), { mode: 0o700 });
    const runtimePath = resolve(import.meta.dir, "install-preflight-runtime.ts");
    const authorityRoot = join(root, "bun root", "install", "oompa");
    const program = [
      'const fs = await import("node:fs/promises");',
      'const path = await import("node:path");',
      `const module = await import(${JSON.stringify(runtimePath)});`,
      `await module.installOompaRelease(${JSON.stringify(archivePath)}, {`,
      `  stageDeadlineMilliseconds: ${String(TEST_STAGING_DEADLINE_MS)},`,
      "  afterStageWorkerStarted: async () => {",
      `    const stage = (await fs.readdir(${JSON.stringify(authorityRoot)})).find((entry) => entry.startsWith(".staging-"));`,
      "    if (!stage) throw new Error(\"The private archive stage is missing.\");",
      `    const privateArchivePath = path.join(${JSON.stringify(authorityRoot)}, stage, ".oompa-release-archive.tgz");`,
      "    const bytes = Buffer.from(await fs.readFile(privateArchivePath));",
      "    bytes[0] = (bytes[0] ?? 0) ^ 1;",
      "    await fs.writeFile(privateArchivePath, bytes, { mode: 0o600 });",
      "  },",
      "});",
    ].join("\n");
    const result = await run([process.execPath, "-e", program], {
      cwd: root,
      environment: installEnvironment(root),
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Bun could not stage the exact Oompa archive (exit 1)");
    expect(result.stdout).toBe("");
    expect(await Bun.file(join(root, "bun root", "bin", "oompa")).exists()).toBeFalse();
  }, 60_000);

  test("refuses an extracted package mutation before an official receipt is issued", async () => {
    const root = await makeRoot("oompa-install-extracted-package-mutation-");
    await mkdir(join(root, "home"), { mode: 0o700 });
    const runtimePath = resolve(import.meta.dir, "install-preflight-runtime.ts");
    const authorityRoot = join(root, "bun root", "install", "oompa");
    const program = [
      'const fs = await import("node:fs/promises");',
      'const path = await import("node:path");',
      `const module = await import(${JSON.stringify(runtimePath)});`,
      `await module.installOompaRelease(${JSON.stringify(archivePath)}, {`,
      `  stageDeadlineMilliseconds: ${String(TEST_STAGING_DEADLINE_MS)},`,
      "  afterStageCleanupCustody: async () => {",
      `    const stage = (await fs.readdir(${JSON.stringify(authorityRoot)})).find((entry) => entry.startsWith(".staging-"));`,
      "    if (!stage) throw new Error(\"The extracted package stage is missing.\");",
      `    const packageFile = path.join(${JSON.stringify(authorityRoot)}, stage, "install/global/node_modules/@hraness/oompa/src/domain/values.ts");`,
      "    const bytes = Buffer.from(await fs.readFile(packageFile));",
      "    bytes[0] = (bytes[0] ?? 0) ^ 1;",
      "    await fs.writeFile(packageFile, bytes);",
      "  },",
      "});",
    ].join("\n");
    const result = await run([process.execPath, "-e", program], {
      cwd: root,
      environment: installEnvironment(root),
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("does not match its authenticated release archive");
    expect(result.stdout).toBe("");
    expect(await Bun.file(join(root, "bun root", "bin", "oompa")).exists()).toBeFalse();
  }, 60_000);

  test("does not traverse a replaced Bun global directory during post-stage cleanup", async () => {
    const root = await makeRoot("oompa-install-global-cleanup-symlink-");
    await mkdir(join(root, "home"), { mode: 0o700 });
    const outside = join(root, "outside-global");
    await mkdir(join(outside, "node_modules"), { recursive: true, mode: 0o700 });
    await writeFile(join(outside, "bun.lock"), "outside lock\n", { mode: 0o600 });
    await writeFile(join(outside, "package.json"), "outside manifest\n", { mode: 0o600 });
    const runtimePath = resolve(import.meta.dir, "install-preflight-runtime.ts");
    const authorityRoot = join(root, "bun root", "install", "oompa");
    const program = [
      'const fs = await import("node:fs/promises");',
      'const path = await import("node:path");',
      `const module = await import(${JSON.stringify(runtimePath)});`,
      `await module.installOompaRelease(${JSON.stringify(archivePath)}, {`,
      `  stageDeadlineMilliseconds: ${String(TEST_STAGING_DEADLINE_MS)},`,
      "  afterStageCleanupCustody: async () => {",
      `    const stage = (await fs.readdir(${JSON.stringify(authorityRoot)})).find((entry) => entry.startsWith(".staging-"));`,
      "    if (!stage) throw new Error(\"The cleanup stage is missing.\");",
      `    const stageRoot = path.join(${JSON.stringify(authorityRoot)}, stage);`,
      '    const globalRoot = path.join(stageRoot, "install", "global");',
      '    await fs.rename(globalRoot, path.join(stageRoot, "held-global"));',
      `    await fs.symlink(${JSON.stringify(outside)}, globalRoot, "dir");`,
      "  },",
      "});",
    ].join("\n");
    const result = await run([process.execPath, "-e", program], {
      cwd: root,
      environment: installEnvironment(root),
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("unsafe directory component");
    expect(await readFile(join(outside, "bun.lock"), "utf8")).toBe("outside lock\n");
    expect(await readFile(join(outside, "package.json"), "utf8")).toBe("outside manifest\n");
    expect(await Bun.file(join(root, "bun root", "bin", "oompa")).exists()).toBeFalse();
  }, 60_000);

  test("quarantines Bun cache cleanup without following nested outside symlinks", async () => {
    const root = await makeRoot("oompa-install-cache-quarantine-");
    await mkdir(join(root, "home"), { mode: 0o700 });
    const outside = join(root, "outside-cache");
    await mkdir(outside, { mode: 0o700 });
    await writeFile(join(outside, "sentinel"), "outside cache sentinel\n", { mode: 0o600 });
    const runtimePath = resolve(import.meta.dir, "install-preflight-runtime.ts");
    const authorityRoot = join(root, "bun root", "install", "oompa");
    const program = [
      'const fs = await import("node:fs/promises");',
      'const path = await import("node:path");',
      `const module = await import(${JSON.stringify(runtimePath)});`,
      `await module.installOompaRelease(${JSON.stringify(archivePath)}, {`,
      `  stageDeadlineMilliseconds: ${String(TEST_STAGING_DEADLINE_MS)},`,
      "  afterStageWorkerExit: async () => {",
      `    const stage = (await fs.readdir(${JSON.stringify(authorityRoot)})).find((entry) => entry.startsWith(".staging-"));`,
      "    if (!stage) throw new Error(\"The cache stage is missing.\");",
      `    const cacheRoot = path.join(${JSON.stringify(authorityRoot)}, stage, "install/cache");`,
      `    await fs.symlink(${JSON.stringify(outside)}, path.join(cacheRoot, "outside-bounce"), "dir");`,
      "  },",
      "});",
    ].join("\n");
    const result = await run([process.execPath, "-e", program], {
      cwd: root,
      environment: installEnvironment(root),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("");
    expect(await readFile(join(outside, "sentinel"), "utf8")).toBe("outside cache sentinel\n");
    expect((await lstat(join(root, "bun root", "bin", "oompa"))).isSymbolicLink()).toBeTrue();
  }, 60_000);

  test("quarantines only the exact Bun cache inode already held by staging custody", async () => {
    const root = await makeRoot("oompa-install-cache-held-identity-");
    await mkdir(join(root, "home"), { mode: 0o700 });
    const replacement = join(root, "replacement-cache");
    await mkdir(replacement, { mode: 0o700 });
    await writeFile(join(replacement, "sentinel"), "replacement cache sentinel\n", { mode: 0o600 });
    const runtimePath = resolve(import.meta.dir, "install-preflight-runtime.ts");
    const authorityRoot = join(root, "bun root", "install", "oompa");
    const program = [
      'const fs = await import("node:fs/promises");',
      'const path = await import("node:path");',
      `const module = await import(${JSON.stringify(runtimePath)});`,
      `await module.installOompaRelease(${JSON.stringify(archivePath)}, {`,
      `  stageDeadlineMilliseconds: ${String(TEST_STAGING_DEADLINE_MS)},`,
      "  beforeCacheQuarantine: async () => {",
      `    const stage = (await fs.readdir(${JSON.stringify(authorityRoot)})).find((entry) => entry.startsWith(".staging-"));`,
      "    if (!stage) throw new Error(\"The held cache stage is missing.\");",
      `    const stageRoot = path.join(${JSON.stringify(authorityRoot)}, stage);`,
      '    const cacheRoot = path.join(stageRoot, "install", "cache");',
      '    await fs.rename(cacheRoot, path.join(stageRoot, "held-cache"));',
      `    await fs.rename(${JSON.stringify(replacement)}, cacheRoot);`,
      "  },",
      "});",
    ].join("\n");
    const result = await run([process.execPath, "-e", program], {
      cwd: root,
      environment: installEnvironment(root),
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("no longer names its held directory descriptor");
    const stage = (await readdir(authorityRoot)).find((entry) => entry.startsWith(".staging-"));
    expect(stage).toBeDefined();
    expect(await readFile(join(authorityRoot, stage as string, "install", "cache", "sentinel"), "utf8"))
      .toBe("replacement cache sentinel\n");
    expect(await Bun.file(join(root, "bun root", "bin", "oompa")).exists()).toBeFalse();
  }, 60_000);

  test("retains staging-root descriptor custody through the version rename", async () => {
    const root = await makeRoot("oompa-install-version-root-swap-");
    await mkdir(join(root, "home"), { mode: 0o700 });
    const runtimePath = resolve(import.meta.dir, "install-preflight-runtime.ts");
    const versionsRoot = join(root, "bun root", "install", "oompa", "versions");
    const program = [
      'const fs = await import("node:fs/promises");',
      'const path = await import("node:path");',
      `const module = await import(${JSON.stringify(runtimePath)});`,
      `await module.installOompaRelease(${JSON.stringify(archivePath)}, {`,
      `  stageDeadlineMilliseconds: ${String(TEST_STAGING_DEADLINE_MS)},`,
      "  afterVersionRename: async () => {",
      `    const versionsRoot = ${JSON.stringify(versionsRoot)};`,
      "    const version = (await fs.readdir(versionsRoot)).find((entry) => !entry.endsWith(\"-authentic\"));",
      "    if (!version) throw new Error(\"The renamed version is missing.\");",
      "    const versionRoot = path.join(versionsRoot, version);",
      '    await fs.rename(versionRoot, `${versionRoot}-authentic`);',
      "    await fs.mkdir(versionRoot, { mode: 0o700 });",
      "  },",
      "});",
    ].join("\n");
    const result = await run([process.execPath, "-e", program], {
      cwd: root,
      environment: installEnvironment(root),
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("does not name its held staging directory after rename");
    expect(result.stdout).toBe("");
    expect(await Bun.file(join(root, "bun root", "bin", "oompa")).exists()).toBeFalse();
  }, 60_000);

  test("retains version-root descriptor custody through the normalized intent write", async () => {
    const root = await makeRoot("oompa-install-version-root-rebind-swap-");
    await mkdir(join(root, "home"), { mode: 0o700 });
    const runtimePath = resolve(import.meta.dir, "install-preflight-runtime.ts");
    const versionsRoot = join(root, "bun root", "install", "oompa", "versions");
    const program = [
      'const fs = await import("node:fs/promises");',
      'const path = await import("node:path");',
      `const module = await import(${JSON.stringify(runtimePath)});`,
      `await module.installOompaRelease(${JSON.stringify(archivePath)}, {`,
      `  stageDeadlineMilliseconds: ${String(TEST_STAGING_DEADLINE_MS)},`,
      "  afterVersionRebind: async () => {",
      `    const versionsRoot = ${JSON.stringify(versionsRoot)};`,
      "    const version = (await fs.readdir(versionsRoot)).find((entry) => !entry.endsWith(\"-authentic\"));",
      "    if (!version) throw new Error(\"The rebound version is missing.\");",
      "    const versionRoot = path.join(versionsRoot, version);",
      '    await fs.rename(versionRoot, `${versionRoot}-authentic`);',
      "    await fs.mkdir(versionRoot, { mode: 0o700 });",
      "  },",
      "});",
    ].join("\n");
    const result = await run([process.execPath, "-e", program], {
      cwd: root,
      environment: installEnvironment(root),
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("no longer names its held custody descriptor");
    expect(result.stdout).toBe("");
    expect(await Bun.file(join(root, "bun root", "bin", "oompa")).exists()).toBeFalse();
  }, 60_000);

  test("rejects a complete receipt whose archive identity no longer matches its namespace", async () => {
    const root = await makeRoot("oompa-install-receipt-identity-");
    const installed = await runInstaller(root);
    expect(installed.exitCode).toBe(0);
    const bunRoot = join(root, "bun root");
    const versionsRoot = join(bunRoot, "install", "oompa", "versions");
    const [versionName] = await readdir(versionsRoot);
    expect(versionName).toBeDefined();
    const receiptPath = join(versionsRoot, versionName as string, ".hra-install-complete.json");
    const receipt = await readJsonRecord(receiptPath);
    receipt.archiveSha256 = "0".repeat(64);
    await writeFile(receiptPath, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
    const activeBefore = await realpath(join(bunRoot, "bin", "oompa"));

    const rejected = await runInstaller(root);
    expect(rejected.exitCode).not.toBe(0);
    expect(rejected.stderr).toContain("namespace does not match its archive identity");
    expect(rejected.stdout).toBe("");
    expect(await realpath(join(bunRoot, "bin", "oompa"))).toBe(activeBefore);
  }, 60_000);

  test("refuses an unverified pre-existing PATH entry without replacing it or starting a staged install", async () => {
    const root = await makeRoot();
    await mkdir(join(root, "home"), { mode: 0o700 });
    const bunRoot = join(root, "bun root");
    await mkdir(join(bunRoot, "bin"), { recursive: true, mode: 0o700 });
    const activePath = join(bunRoot, "bin", "oompa");
    await writeFile(activePath, "unverified\n", { mode: 0o700 });
    const result = await run([
      process.execPath,
      resolve(import.meta.dir, "install-preflight.ts"),
      archivePath,
    ], { cwd: root, environment: installEnvironment(root) });
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(await readFile(activePath, "utf8")).toBe("unverified\n");
    expect(await Bun.file(join(bunRoot, "install", "oompa", "install-intent.json")).exists()).toBeFalse();
    const authorityEntries = await readdir(join(bunRoot, "install", "oompa"));
    expect(authorityEntries.some((entry) => entry.startsWith(".staging-"))).toBeFalse();
  });

  test("a pre-READY staging stall expires inside detached authority, leaves no process group, and recovers", async () => {
    await assertStalledStageRecovers("stall-before-ready");
  }, 60_000);

  test("a post-READY staging stall expires inside detached authority, leaves no process group, and recovers", async () => {
    await assertStalledStageRecovers("stall-after-ready");
  }, 60_000);

  test("a stalled Bun stage whose caller dies after READY retains custody until its detached deadline and recovers", async () => {
    const root = await makeRoot("oompa-install-kill-");
    await mkdir(join(root, "home"), { mode: 0o700 });
    const sentinel = join(root, "bun-link-observed");
    const runtimePath = resolve(import.meta.dir, "install-preflight-runtime.ts");
    const program = [
      "const [runtimePath, archivePath, sentinel] = process.argv.slice(1);",
      "const module = await import(runtimePath);",
      "await module.installOompaRelease(archivePath, {",
      "  stageDeadlineMilliseconds: 6000,",
      '  stageWorkerTestMode: "stall-after-ready",',
      '  afterStageWorkerReady: async (bunPid, lockPid) => { await Bun.write(sentinel, String(bunPid) + " " + String(lockPid) + "\\n"); await new Promise(() => {}); },',
      "});",
    ].join("\n");
    const child = trackDirectTestChild(Bun.spawn([process.execPath, "-e", program, "--", runtimePath, archivePath, sentinel], {
      cwd: root,
      detached: true,
      env: installEnvironment(root),
      stderr: "ignore",
      stdin: "ignore",
      stdout: "ignore",
    }));
    const deadline = Date.now() + 10_000;
    while (!await Bun.file(sentinel).exists() && Date.now() < deadline) await Bun.sleep(25);
    if (!await Bun.file(sentinel).exists()) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
      await child.exited;
      throw new Error("The stalled Bun staging process did not reach its READY boundary.");
    }
    const [bunPidText, lockPidText] = (await Bun.file(sentinel).text()).trim().split(" ");
    const bunPid = Number.parseInt(bunPidText ?? "", 10);
    const lockPid = Number.parseInt(lockPidText ?? "", 10);
    expect(Number.isSafeInteger(bunPid)).toBeTrue();
    expect(Number.isSafeInteger(lockPid)).toBeTrue();
    expect(bunPid).not.toBe(child.pid);
    expect(lockPid).not.toBe(child.pid);
    const bunRoot = join(root, "bun root");
    const authorityRoot = join(bunRoot, "install", "oompa");
    const stageName = (await readdir(authorityRoot)).find((entry) => entry.startsWith(".staging-"));
    expect(stageName).toBeDefined();
    expect(await Bun.file(join(bunRoot, "bin", "oompa")).exists()).toBeFalse();
    process.kill(child.pid, "SIGKILL");
    await child.exited;
    expect(() => process.kill(lockPid, 0)).not.toThrow();
    expect(await Bun.file(join(bunRoot, "bin", "oompa")).exists()).toBeFalse();

    const busy = await runInstaller(root);
    expect(busy.exitCode).not.toBe(0);
    expect(busy.stderr).toContain("prior Oompa Bun staging process is still running");
    expect(await Bun.file(join(bunRoot, "bin", "oompa")).exists()).toBeFalse();

    await waitForProcessIdentityToDisappear(lockPid, false, 10_000);
    await waitForProcessIdentityToDisappear(bunPid, true, 5_000);

    const recoveryDeadline = Date.now() + 5_000;
    let recovered = await runInstaller(root);
    while (
      recovered.exitCode !== 0
      && recovered.stderr.includes("prior Oompa Bun staging process is still running")
      && Date.now() < recoveryDeadline
    ) {
      await Bun.sleep(10);
      recovered = await runInstaller(root);
    }
    expect(recovered.exitCode, recovered.stderr).toBe(0);
    expect(recovered.stdout).toBe(`${OOMPA_INSTALL_PREFLIGHT_SUCCESS}\n`);
    expect((await lstat(join(bunRoot, "bin", "oompa"))).isSymbolicLink()).toBeTrue();
    expect((await readdir(authorityRoot)).some((entry) => entry.startsWith(".staging-"))).toBeFalse();
    expect(await Bun.file(join(authorityRoot, "install-intent.json")).exists()).toBeFalse();
  }, 60_000);

  test("every post-link publication boundary leaves either no command or the complete verified command", async () => {
    const root = await makeRoot("oompa-install-boundaries-");
    await mkdir(join(root, "home"), { mode: 0o700 });
    const runtimePath = resolve(import.meta.dir, "install-preflight-runtime.ts");
    const activePath = join(root, "bun root", "bin", "oompa");
    const runWithHook = async (hook: "afterNormalized" | "afterPublishRename" | "beforePublish") => await run([
      process.execPath,
      "-e",
      [
        "const [runtimePath, archivePath, deadline, hook] = process.argv.slice(1);",
        "const module = await import(runtimePath);",
        'const interrupt = () => { throw new Error("test interruption at " + hook); };',
        'const hooks = hook === "afterNormalized" ? { afterNormalized: interrupt }',
        '  : hook === "afterPublishRename" ? { afterPublishRename: interrupt }',
        '  : hook === "beforePublish" ? { beforePublish: interrupt } : undefined;',
        'if (hooks === undefined) throw new Error("Unexpected installer interruption hook.");',
        "await module.installOompaRelease(archivePath, {",
        "  stageDeadlineMilliseconds: Number(deadline),",
        "  ...hooks,",
        "});",
      ].join("\n"),
      "--",
      runtimePath,
      archivePath,
      String(TEST_STAGING_DEADLINE_MS),
      hook,
    ], { cwd: root, environment: installEnvironment(root) });

    const normalizedInterruption = await runWithHook("afterNormalized");
    expect(normalizedInterruption.exitCode).not.toBe(0);
    expect(await Bun.file(activePath).exists()).toBeFalse();

    const prepublishInterruption = await runWithHook("beforePublish");
    expect(prepublishInterruption.exitCode).not.toBe(0);
    expect(await Bun.file(activePath).exists()).toBeFalse();

    const renamedInterruption = await runWithHook("afterPublishRename");
    expect(renamedInterruption.exitCode).not.toBe(0);
    expect((await lstat(activePath)).isSymbolicLink()).toBeTrue();
    const publishedTarget = await realpath(activePath);
    expect((await lstat(publishedTarget)).mode & 0o777).toBe(0o755);

    const recovered = await runInstaller(root);
    expect(recovered.exitCode, recovered.stderr).toBe(0);
    expect(await realpath(activePath)).toBe(publishedTarget);
    expect(await Bun.file(join(root, "bun root", "install", "oompa", "install-intent.json")).exists()).toBeFalse();
  }, 60_000);

  test("detects same-size installed-tree mutation after normalization before PATH publication", async () => {
    const root = await makeRoot("oompa-install-tree-digest-");
    await mkdir(join(root, "home"), { mode: 0o700 });
    const runtimePath = resolve(import.meta.dir, "install-preflight-runtime.ts");
    const versionsRoot = join(root, "bun root", "install", "oompa", "versions");
    const program = [
      `const module = await import(${JSON.stringify(runtimePath)});`,
      `await module.installOompaRelease(${JSON.stringify(archivePath)}, {`,
      `  stageDeadlineMilliseconds: ${String(TEST_STAGING_DEADLINE_MS)},`,
      "  afterNormalized: async () => {",
      `    const versions = await (await import("node:fs/promises")).readdir(${JSON.stringify(versionsRoot)});`,
      `    const path = ${JSON.stringify(versionsRoot)} + "/" + versions[0] + "/install/global/node_modules/@hraness/oompa/src/domain/values.ts";`,
      "    const bytes = Buffer.from(await Bun.file(path).arrayBuffer());",
      "    bytes[0] = (bytes[0] ?? 0) ^ 1;",
      "    await Bun.write(path, bytes);",
      "  },",
      "});",
    ].join("\n");
    const result = await run([process.execPath, "-e", program], {
      cwd: root,
      environment: installEnvironment(root),
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("durable tree receipt");
    expect(await Bun.file(join(root, "bun root", "bin", "oompa")).exists()).toBeFalse();
  }, 60_000);

  test("rejects an outside bounce symlink even while its final target points back into the staged tree", async () => {
    const root = await makeRoot("oompa-install-symlink-bounce-");
    await mkdir(join(root, "home"), { mode: 0o700 });
    const outside = join(root, "outside");
    await mkdir(outside, { mode: 0o700 });
    const authorityRoot = join(root, "bun root", "install", "oompa");
    const runtimePath = resolve(import.meta.dir, "install-preflight-runtime.ts");
    const program = [
      `const module = await import(${JSON.stringify(runtimePath)});`,
      `await module.installOompaRelease(${JSON.stringify(archivePath)}, {`,
      `  stageDeadlineMilliseconds: ${String(TEST_STAGING_DEADLINE_MS)},`,
      "  afterStageWorkerExit: async () => {",
      '    const fs = await import("node:fs/promises");',
      '    const path = await import("node:path");',
      `    const authorityRoot = ${JSON.stringify(authorityRoot)};`,
      "    const stageName = (await fs.readdir(authorityRoot)).find((entry) => entry.startsWith(\".staging-\"));",
      '    if (!stageName) throw new Error("staging root is missing");',
      "    const stageRoot = path.join(authorityRoot, stageName);",
      "    const stagedLink = path.join(stageRoot, \"bin\", \"oompa\");",
      '    if (!(await fs.lstat(stagedLink)).isSymbolicLink()) throw new Error("staged oompa link is missing");',
      "    const inside = path.join(stageRoot, \"inside-target\");",
      `    const bounce = ${JSON.stringify(join(outside, "bounce"))};`,
      "    const candidate = path.join(stageRoot, \"outside-bounce\");",
      '    await fs.writeFile(inside, "inside\\n", { mode: 0o600 });',
      "    await fs.symlink(inside, bounce);",
      "    await fs.symlink(path.relative(path.dirname(candidate), bounce), candidate);",
      "  },",
      "});",
    ].join("\n");
    const result = await run([process.execPath, "-e", program], {
      cwd: root,
      environment: installEnvironment(root),
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("lexically escaping symbolic link");
    expect(await Bun.file(join(root, "bun root", "bin", "oompa")).exists()).toBeFalse();
  }, 60_000);

  test("accepts non-mutating Darwin ACLs and rejects a later inherited non-owner delete ALLOW", async () => {
    if (process.platform !== "darwin") return;
    const uid = process.getuid?.();
    if (uid === undefined) throw new Error("Darwin ACL proof requires a current-user identity.");
    const root = await makeRoot("oompa-install-acl-");
    const aclFree = join(root, "acl-free");
    const denyOnly = join(root, "deny-only");
    const readOnly = join(root, "read-only");
    const dangerousAllow = join(root, "dangerous-allow");
    await writeFile(aclFree, "private\n", { mode: 0o600 });
    await mkdir(denyOnly, { mode: 0o700 });
    await mkdir(readOnly, { mode: 0o700 });
    await mkdir(dangerousAllow, { mode: 0o700 });
    const aclFreeHandle = await open(aclFree, "r");
    try {
      expect(() => assertSafeDarwinInstallAcl(aclFreeHandle.fd, uid, aclFree)).not.toThrow();
      expect(() => assertSafeDarwinNormalizerAcl(aclFreeHandle.fd, uid, aclFree)).not.toThrow();
    } finally {
      await aclFreeHandle.close();
    }
    const deny = await run(["/bin/chmod", "+a", "everyone deny delete", denyOnly], { cwd: root });
    expect(deny.exitCode).toBe(0);
    const denyHandle = await open(denyOnly, "r");
    try {
      expect(() => assertSafeDarwinInstallAcl(denyHandle.fd, uid, denyOnly)).not.toThrow();
      expect(() => assertSafeDarwinNormalizerAcl(denyHandle.fd, uid, denyOnly)).not.toThrow();
    } finally {
      await denyHandle.close();
    }
    const read = await run([
      "/bin/chmod",
      "+a",
      "everyone allow list,search,readattr,readextattr,readsecurity",
      readOnly,
    ], { cwd: root });
    expect(read.exitCode).toBe(0);
    const readHandle = await open(readOnly, "r");
    try {
      expect(() => assertSafeDarwinInstallAcl(readHandle.fd, uid, readOnly)).not.toThrow();
      expect(() => assertSafeDarwinNormalizerAcl(readHandle.fd, uid, readOnly)).not.toThrow();
    } finally {
      await readHandle.close();
    }
    const leadingDeny = await run([
      "/bin/chmod",
      "+a",
      "everyone deny write,append,delete_child,writeattr,writeextattr,writesecurity,chown",
      dangerousAllow,
    ], { cwd: root });
    expect(leadingDeny.exitCode).toBe(0);
    const allow = await run([
      "/bin/chmod",
      "+a",
      "everyone allow delete,file_inherit,directory_inherit",
      dangerousAllow,
    ], { cwd: root });
    expect(allow.exitCode).toBe(0);
    const allowHandle = await open(dangerousAllow, "r");
    try {
      expect(() => assertSafeDarwinInstallAcl(allowHandle.fd, uid, dangerousAllow)).toThrow(
        "dangerous non-owner Darwin ALLOW ACL",
      );
      expect(() => assertSafeDarwinNormalizerAcl(allowHandle.fd, uid, dangerousAllow)).toThrow(
        "dangerous non-owner Darwin ALLOW ACL",
      );
    } finally {
      await allowHandle.close();
    }
  });
});
