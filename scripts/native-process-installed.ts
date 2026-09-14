import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readdirSync, realpathSync, writeFileSync, type BigIntStats } from "node:fs";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { assertNativeExecutableHeader, nativeArtifactTarget } from "../packages/native-process/src/artifact-model.ts";
import { inspectNativeProcessArchive } from "./native-process-archive.ts";
import { nativeBuildInput, nativeInputHash, nativeProcessSourceInventory } from "./native-process-build-inputs.ts";
import { admitNativeProcessDependency, nativeProcessDependency } from "./native-process-dependency.ts";
import { inspectQualifiedNativeProcessPackage } from "./native-process-package.ts";
import { NATIVE_QUALIFICATION_HARNESS_FILES, NATIVE_TRANSPORT_CASES, parseNativeQualification } from "./native-process-qualification-model.ts";
import { parseNativeSuite } from "./native-process-qualify.ts";
import { assertNativeInstalledDriver, assertNativeInstalledLock, inspectNativeInstalledDependency,
  nativeInstalledInventoryDigest, nativeInstalledPackageJson, nativeInstalledReceiptSchema,
  nativeInstalledBunArguments,
  nativeInstalledWorkerResultSchema, type NativeInstalledReceipt, type NativeInstalledWorkerResult } from "./native-process-installed-model.ts";

const repository = realpathSync(join(import.meta.dir, ".."));
const json = (bytes: Uint8Array): unknown => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
const encoded = (value: unknown): Buffer => Buffer.from(JSON.stringify(value) + "\n");
function refuse(): never { throw Error("NATIVE_PROCESS_INSTALLED_ACCEPTANCE_FAILED"); }
type Directory = Readonly<{ path: string; metadata: BigIntStats }>;
type File = Readonly<{ path: string; bytes: number; sha256: string; metadata: BigIntStats }>;
const same = (left: BigIntStats, right: BigIntStats): boolean => left.dev === right.dev && left.ino === right.ino
  && left.uid === right.uid && left.gid === right.gid && left.mode === right.mode;
const sameFile = (left: BigIntStats, right: BigIntStats): boolean => same(left, right) && left.size === right.size
  && left.nlink === right.nlink && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
function canonical(path: string): string {
  if (!isAbsolute(path) || normalize(path) !== path || realpathSync(path) !== path
    || Buffer.byteLength(path) > 4096 || path.includes("\0")) refuse();
  return path;
}
function directory(path: string, privateRoot = false): Directory {
  canonical(path);
  const metadata = lstatSync(path, { bigint: true });
  if (process.getuid === undefined || !metadata.isDirectory() || (metadata.uid !== 0n && metadata.uid !== BigInt(process.getuid()))
    || (metadata.mode & 0o022n) !== 0n
    || (privateRoot && (metadata.uid !== BigInt(process.getuid()) || (metadata.mode & 0o7777n) !== 0o700n))) refuse();
  return { path, metadata };
}
function ancestorDirectories(path: string): Directory[] {
  const values: Directory[] = [];
  for (let current = path, depth = 0; depth < 128; depth += 1) {
    values.push(directory(current));
    const parent = dirname(current);
    if (parent === current) return values;
    current = parent;
  }
  refuse();
}
function syncDirectory(expected: Directory): void {
  const fd = openSync(expected.path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    if (!same(expected.metadata, fstatSync(fd, { bigint: true }))
      || !same(expected.metadata, lstatSync(expected.path, { bigint: true }))) refuse();
    fsyncSync(fd);
  } finally { closeSync(fd); }
}
function snapshot(path: string, maximum: number): File {
  const bytes = nativeBuildInput(path, maximum), metadata = lstatSync(path, { bigint: true });
  return { path, bytes: bytes.length, sha256: nativeInputHash(bytes), metadata };
}
function assertFile(file: File): void {
  if (!sameFile(file.metadata, lstatSync(file.path, { bigint: true }))
    || nativeInputHash(nativeBuildInput(file.path, Math.max(1, file.bytes))) !== file.sha256) refuse();
}
function write(path: string, bytes: Uint8Array, mode: 0o400 | 0o500): File {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  const file = snapshot(path, Math.max(1, bytes.byteLength));
  if (file.sha256 !== nativeInputHash(bytes) || (file.metadata.mode & 0o7777n) !== BigInt(mode)) refuse();
  return file;
}

/** Exact node_modules inventory after a real copyfile installation. Every byte
 * is compared with an admitted tar member before any installed client loads. */
export function inspectNativeInstalledTree(root: string, expected: readonly Readonly<{
  path: string; bytes: Uint8Array; mode: number;
}>[]): readonly File[] {
  const files = new Map(expected.map(file => [file.path, file]));
  if (files.size !== expected.length || files.size > 4608) refuse();
  const requiredDirectories = new Set<string>([""]);
  for (const file of expected) {
    if (isAbsolute(file.path) || file.path.split("/").some(part => part === "" || part === "." || part === "..")) refuse();
    let parent = dirname(file.path);
    while (parent !== ".") { requiredDirectories.add(parent); parent = dirname(parent); }
  }
  const pending = [""], result: File[] = [];
  while (pending.length > 0) {
    const local = pending.pop() ?? refuse();
    const path = join(root, local);
    directory(path);
    for (const name of readdirSync(path)) {
      const relative = local === "" ? name : local + "/" + name, absolute = join(root, relative);
      const metadata = lstatSync(absolute);
      if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
        if (!requiredDirectories.delete(relative)) refuse();
        pending.push(relative);
      } else {
        const expected = files.get(relative);
        if (expected === undefined || !metadata.isFile() || metadata.isSymbolicLink()
          || (metadata.mode & 0o7777) !== expected.mode) refuse();
        const admitted = snapshot(absolute, expected.bytes.byteLength);
        if (admitted.sha256 !== nativeInputHash(expected.bytes) || admitted.bytes !== expected.bytes.byteLength) refuse();
        result.push(admitted); files.delete(relative);
      }
    }
  }
  requiredDirectories.delete("");
  if (files.size !== 0 || requiredDirectories.size !== 0) refuse();
  return result;
}

export type NativeInstalledOptions = Readonly<{
  archivePath: string; archiveSha256: string; manifestSha256: string;
  qualifiedBundle: string; dependencyPath: string; outputDirectory: string;
}>;

/** This is a scheduled native gate. Source/pure tests do not invoke it. The
 * release owner supplies archive/manifest pins from its governed assembly. */
export async function acceptInstalledNativeProcess(options: NativeInstalledOptions): Promise<NativeInstalledReceipt> {
  if (Bun.version !== "1.3.14" || !/^[a-f0-9]{64}$/u.test(options.archiveSha256)
    || !/^[a-f0-9]{64}$/u.test(options.manifestSha256)) refuse();
  const target = nativeArtifactTarget(process.platform, process.arch);
  if (target === null) refuse();
  const source = nativeProcessSourceInventory(repository);
  const assertSourceBytes = (path: string, bytes: Uint8Array): void => {
    const expected = source.find(file => file.path === path);
    if (expected === undefined || expected.bytes !== bytes.byteLength || expected.sha256 !== nativeInputHash(bytes)) refuse();
  };
  const archive = nativeBuildInput(canonical(options.archivePath), 64 * 1024 * 1024);
  if (nativeInputHash(archive) !== options.archiveSha256) refuse();
  const manifest = inspectQualifiedNativeProcessPackage(archive);
  if (nativeInputHash(encoded(source).subarray(0, -1)) !== manifest.source.treeSha256) refuse();
  const members = inspectNativeProcessArchive(archive);
  const manifestBytes = (members.find(file => file.path === "package/native-artifacts/manifest.json") ?? refuse()).bytes;
  if (nativeInputHash(manifestBytes) !== options.manifestSha256) refuse();
  const artifact = manifest.artifacts.find(item => item.target === target);
  if (artifact === undefined) refuse();
  const prepackBytes = (members.find(file => file.path === "package/native-artifacts/qualifications/" + artifact.rustTarget + ".json") ?? refuse()).bytes;
  const prepack = parseNativeQualification(json(prepackBytes), manifest.source);
  const bundle = canonical(options.qualifiedBundle);
  if (!Buffer.from(prepackBytes).equals(nativeBuildInput(join(bundle, "qualification.json"), 256 * 1024))) refuse();
  const harnesses = Object.fromEntries(Object.entries(NATIVE_QUALIFICATION_HARNESS_FILES).map(([name, filename]) => {
    const expected = prepack.harnesses[name as keyof typeof NATIVE_QUALIFICATION_HARNESS_FILES];
    const bytes = nativeBuildInput(join(bundle, filename), 32 * 1024 * 1024);
    if (bytes.length !== expected.bytes || nativeInputHash(bytes) !== expected.sha256) refuse();
    assertNativeExecutableHeader(bytes, { ...artifact, bytes: expected.bytes, sha256: expected.sha256 });
    return [name, bytes];
  })) as Record<keyof typeof NATIVE_QUALIFICATION_HARNESS_FILES, Buffer>;
  const dependency = nativeBuildInput(canonical(options.dependencyPath), 16 * 1024 * 1024);
  const rootLock = nativeBuildInput(join(repository, "bun.lock"), 4 * 1024 * 1024);
  assertSourceBytes("bun.lock", rootLock);
  admitNativeProcessDependency(Bun.JSONC.parse(rootLock.toString("utf8")), dependency);
  const dependencyFiles = inspectNativeInstalledDependency(dependency);
  const workerBytes = nativeBuildInput(join(repository, "scripts/native-process-installed-worker.ts"), 128 * 1024);
  const verifierBytes = nativeBuildInput(join(repository, "native/process-kernel/verify-transport.ts"), 128 * 1024);
  assertSourceBytes("scripts/native-process-installed-worker.ts", workerBytes);
  assertSourceBytes("native/process-kernel/verify-transport.ts", verifierBytes);
  assertNativeInstalledDriver(workerBytes, "worker"); assertNativeInstalledDriver(verifierBytes, "verifier");

  const output = resolve(options.outputDirectory), parent = dirname(output);
  if (output !== options.outputDirectory || output === repository || output.startsWith(repository + "/")) refuse();
  const directories = ancestorDirectories(parent);
  mkdirSync(output, { mode: 0o700 });
  directories.push(directory(output, true));
  const make = (local: string): string => {
    const path = join(output, local); mkdirSync(path, { mode: 0o700 }); directories.push(directory(path, true)); return path;
  };
  const home = make("home"), temporary = make("temporary"), imageRoot = make("images");
  make("cache");
  make("scripts"); make("native"); make("native/process-kernel"); make("harnesses");
  const fixed: File[] = [];
  for (const [path, bytes] of [["native.tgz", archive], ["zod.tgz", dependency],
    ["package.json", encoded(nativeInstalledPackageJson())], ["bunfig.toml", Buffer.from("[install]\nexact = true\n")],
    [".npmrc", Buffer.from("# Private local-only installation.\n")],
    ["scripts/native-process-installed-worker.ts", workerBytes], ["native/process-kernel/verify-transport.ts", verifierBytes]] as const) {
    fixed.push(write(join(output, path), bytes, 0o400));
  }
  for (const [name, filename] of Object.entries(NATIVE_QUALIFICATION_HARNESS_FILES)) {
    fixed.push(write(join(output, "harnesses", filename), harnesses[name as keyof typeof harnesses], 0o500));
  }
  const bun = snapshot(canonical(realpathSync(process.execPath)), 512 * 1024 * 1024);
  const selectedGit = Bun.which("git"); if (selectedGit === null) refuse();
  const git = snapshot(realpathSync(selectedGit), 512 * 1024 * 1024);
  fixed.push(bun, git);
  for (const value of directories) if (value.path === output || value.path.startsWith(output + "/")) syncDirectory(value);
  const assertInputs = (): void => {
    for (const value of directories) if (!same(value.metadata, directory(value.path).metadata)) refuse();
    for (const file of fixed) assertFile(file);
    if (!isDeepStrictEqual(nativeProcessSourceInventory(repository), source)) refuse();
  };
  const environment = Object.freeze({ HOME: home, TMPDIR: temporary, TMP: temporary, TEMP: temporary,
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LC_ALL: "C", LANG: "C",
    npm_config_userconfig: join(output, ".npmrc"), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" });
  const { requireBoundedProcessCleanup, runBoundedProcess } = await import("./bounded-process.ts");
  let sequence = 0;
  const run = async (executable: string, args: readonly string[], phase: string, timeoutMs: number,
    extra: Readonly<Record<string, string>> = {}, maximum = 1024 * 1024): Promise<Buffer> => {
    assertInputs();
    const result = requireBoundedProcessCleanup(await runBoundedProcess({ executable, arguments: args,
      cwd: output, environment: { ...environment, ...extra }, containment: "local", phase: "native-installed-" + phase,
      timeoutMs, terminationGraceMs: 250, killSettlementMs: 3000, outputMaximumBytes: maximum,
    }, { recoveryDirectory: join(output, "recovery-" + String(++sequence)) }));
    assertInputs();
    if (result.exitCode !== 0) refuse();
    return result.stdout;
  };
  const commit = async (): Promise<void> => {
    const bytes = await run(git.path, ["-C", repository, "rev-parse", "HEAD"], "source", 5000, {}, 128);
    if (bytes.toString("utf8").trim() !== manifest.source.commitSha) refuse();
  };
  await commit();
  // Installed acceptance requires the actual matching hardware, independently
  // of the earlier builder's runner. Rosetta/cross execution is not admission.
  if (target.startsWith("darwin-")) {
    const hardware = await run("/usr/sbin/sysctl", ["-n", "hw.optional.arm64"], "host-architecture", 5000, {}, 16);
    if (hardware.toString("utf8").trim() !== (target === "darwin-arm64" ? "1" : "0")) refuse();
  } else {
    const hardware = await run("/usr/bin/uname", ["-m"], "host-architecture", 5000, {}, 128);
    if (hardware.toString("utf8").trim() !== (target === "linux-arm64" ? "aarch64" : "x86_64")) refuse();
  }
  const installArguments = nativeInstalledBunArguments(output);
  await run(bun.path, [...installArguments, "--lockfile-only"], "resolve-local", 30_000);
  const lock = snapshot(join(output, "bun.lock"), 64 * 1024);
  assertNativeInstalledLock(Bun.JSONC.parse(nativeBuildInput(lock.path, 64 * 1024).toString("utf8")));
  fixed.push(lock);
  await run(bun.path, [...installArguments, "--frozen-lockfile"], "install-local", 30_000);
  const installedExpected = [...members.map(file => ({ path: "@hraness/native-process/" + file.path.slice(8), bytes: file.bytes, mode: file.mode })),
    ...dependencyFiles.map(file => ({ path: "zod/" + file.path, bytes: file.bytes, mode: file.mode }))];
  const installed = inspectNativeInstalledTree(join(output, "node_modules"), installedExpected);
  fixed.push(...installed);
  const fixture = join(output, "harnesses", NATIVE_QUALIFICATION_HARNESS_FILES.fixture);
  const worker = async (mode: "admit" | "transport"): Promise<NativeInstalledWorkerResult> => {
    const result = nativeInstalledWorkerResultSchema.parse(json(await run(bun.path,
      ["--no-env-file", "--no-install", "--no-macros", "--no-addons", `--config=${join(output, "bunfig.toml")}`,
        join(output, "scripts/native-process-installed-worker.ts"), mode, options.manifestSha256, fixture], mode, 90_000, {}, 64 * 1024)));
    if (result.mode !== mode || result.target !== target || result.manifestSha256 !== options.manifestSha256
      || !isDeepStrictEqual(result.client, manifest.client) || result.image.sha256 !== artifact.sha256
      || result.image.bytes !== artifact.bytes || result.fixtureSha256 !== prepack.harnesses.fixture.sha256) refuse();
    return result;
  };
  const admitted = await worker("admit");
  const image = snapshot(join(imageRoot, "native-process-" + manifest.version + "-" + target + "-" + artifact.sha256), 32 * 1024 * 1024);
  if (image.sha256 !== artifact.sha256 || String(image.metadata.dev) !== admitted.image.device
    || String(image.metadata.ino) !== admitted.image.inode || image.metadata.nlink !== 1n
    || (image.metadata.mode & 0o7777n) !== 0o500n) refuse();
  fixed.push(image);
  const testEnvironment = Object.freeze({ NATIVE_PROCESS_QUALIFICATION_HELPER: image.path,
    NATIVE_PROCESS_QUALIFICATION_FIXTURE: fixture });
  const unit = parseNativeSuite(await run(join(output, "harnesses", NATIVE_QUALIFICATION_HARNESS_FILES.unit),
    ["--test-threads=1", "--color=never"], "unit", 60_000, testEnvironment), 6);
  const native = parseNativeSuite(await run(join(output, "harnesses", NATIVE_QUALIFICATION_HARNESS_FILES.native),
    ["--test-threads=1", "--color=never"], "native", 120_000, testEnvironment), 20);
  const transport = await worker("transport");
  if (!isDeepStrictEqual(admitted.image, transport.image)) refuse();
  await commit();
  inspectNativeInstalledTree(join(output, "node_modules"), installedExpected);
  assertInputs();
  const receipt = nativeInstalledReceiptSchema.parse({ formatVersion: 1, phase: "installed-native",
    profile: prepack.profile, profileVersion: prepack.profileVersion, source: manifest.source,
    target, rustTarget: artifact.rustTarget, artifact: prepack.artifact, harnesses: prepack.harnesses,
    archiveSha256: options.archiveSha256, manifestSha256: options.manifestSha256, prepackSha256: nativeInputHash(prepackBytes),
    verifierSha256: nativeInputHash(verifierBytes), workerSha256: nativeInputHash(workerBytes),
    dependency: { name: "zod", version: "4.4.3", integrity: nativeProcessDependency.integrity,
      archiveSha256: nativeInputHash(dependency), inventorySha256: nativeInstalledInventoryDigest(dependencyFiles.map(file =>
        ({ path: file.path, bytes: file.bytes.length, sha256: nativeInputHash(file.bytes) }))) },
    bun: { version: "1.3.14", sha256: bun.sha256 }, installation: { localLockSha256: lock.sha256,
      clientInventorySha256: nativeInstalledInventoryDigest(manifest.client), image: transport.image },
    checks: { unit, native, transport: NATIVE_TRANSPORT_CASES } });
  // Last write is the success receipt. The whole root and immutable image stay
  // retained on success or failure; this gate has no recursive cleanup path.
  write(join(output, "installed-qualification.json"), encoded(receipt), 0o400);
  syncDirectory(directories.find(value => value.path === output) ?? refuse());
  return receipt;
}

if (import.meta.main) {
  const [archivePath, archiveSha256, manifestSha256, qualifiedBundle, dependencyPath, outputDirectory, extra] = process.argv.slice(2);
  if (archivePath === undefined || archiveSha256 === undefined || manifestSha256 === undefined || qualifiedBundle === undefined
    || dependencyPath === undefined || outputDirectory === undefined || extra !== undefined) {
    throw Error("Usage: native-process-installed.ts ARCHIVE ARCHIVE_SHA256 MANIFEST_SHA256 QUALIFIED_BUNDLE LOCAL_ZOD FRESH_OUTPUT");
  }
  const receipt = await acceptInstalledNativeProcess({ archivePath, archiveSha256, manifestSha256,
    qualifiedBundle, dependencyPath, outputDirectory });
  console.log(JSON.stringify(receipt));
}
