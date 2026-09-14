import { isDeepStrictEqual } from "node:util";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { NATIVE_CLIENT_FILES, NATIVE_PACKAGE_NAME, NATIVE_PACKAGE_VERSION,
  parseNativeArtifactManifest, parseNativeLicenseManifest, assertNativeExecutableHeader,
  type NativeArtifactManifest } from "../packages/native-process/src/artifact-model.ts";
import { createNativeProcessArchive, inspectNativeProcessArchive, type NativeArchiveFile } from "./native-process-archive.ts";
import { nativeBuildInput, nativeInputHash, nativeProcessSourceInventory } from "./native-process-build-inputs.ts";
import { parseNativeQualification, qualifiedNativeArtifact } from "./native-process-qualification-model.ts";

const json = (bytes: Uint8Array): unknown => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
const jsonBytes = (value: unknown): Buffer => Buffer.from(JSON.stringify(value, null, 2) + "\n");
const manifestPath = "package/native-artifacts/manifest.json";
const licensesPath = "package/native-artifacts/licenses/manifest.json";
const packageFiles = [...NATIVE_CLIENT_FILES, "README.md", "LICENSE"];
function reject(): never { throw Error("NATIVE_PROCESS_PACKAGE_INVALID"); }

function packageManifest(bytes: Uint8Array): void {
  const value = json(bytes);
  if (value === null || typeof value !== "object" || Array.isArray(value)) reject();
  const item = value as Record<string, unknown>;
  if (item.name !== NATIVE_PACKAGE_NAME || item.version !== NATIVE_PACKAGE_VERSION || item.type !== "module"
    || item.license !== "MIT" || !isDeepStrictEqual(item.engines, { bun: "1.3.14" })
    || !isDeepStrictEqual(item.dependencies, { zod: "4.4.3" })) reject();
  for (const name of ["optionalDependencies", "bundledDependencies", "bundleDependencies", "peerDependencies", "bin", "workspaces"]) {
    if (Object.hasOwn(item, name)) reject();
  }
  if (item.scripts === null || typeof item.scripts !== "object" || Array.isArray(item.scripts)) reject();
  for (const name of ["preinstall", "install", "postinstall", "prepare", "prepack", "postpack", "prepublish", "prepublishOnly", "publish", "postpublish"]) {
    if (Object.hasOwn(item.scripts, name)) reject();
  }
  const exports = item.exports;
  if (exports === null || typeof exports !== "object" || Array.isArray(exports)) reject();
  const expectedExports = Object.fromEntries(["index", "identity", "protocol", "byte-queue", "transport",
    "observation-protocol", "observer", "process-port", "artifact-model", "artifact-resolver"].map(name =>
    [name === "index" ? "." : "./" + name, "./src/" + name + ".ts"]));
  if (!isDeepStrictEqual(exports, expectedExports)) reject();
}

export type NativePackageBundle = Readonly<{ executable: Uint8Array; qualification: Uint8Array }>;
export type NativePackageAssembly = Readonly<{
  source: NativeArtifactManifest["source"];
  /** Exact root-relative package runtime files, README and LICENSE. */
  client: readonly Readonly<{ path: string; bytes: Uint8Array }>[];
  /** Relative to native-artifacts/licenses, including its manifest.json. */
  licenses: readonly Readonly<{ path: string; bytes: Uint8Array }>[];
  bundles: readonly NativePackageBundle[];
}>;

/** Assemble only previously qualified bytes. All canonical release authority
 * remains with the workflow; no caller-supplied JSON proves authenticated CI. */
export function assembleNativeProcessPackage(input: NativePackageAssembly): Readonly<{
  archive: Buffer; archiveSha256: string; manifest: NativeArtifactManifest; manifestSha256: string;
}> {
  if (input.bundles.length < 1 || input.bundles.length > 4) reject();
  const files: NativeArchiveFile[] = [];
  const clients = new Map(input.client.map(file => [file.path, file.bytes]));
  if (clients.size !== input.client.length || clients.size !== packageFiles.length
    || packageFiles.some(path => !clients.has(path))) reject();
  const licenseFiles = new Map(input.licenses.map(file => [file.path, file.bytes]));
  if (licenseFiles.size !== input.licenses.length || !licenseFiles.has("manifest.json")) reject();
  const licenseIndex = licenseFiles.get("manifest.json");
  if (licenseIndex === undefined) reject();
  const licenseManifest = parseNativeLicenseManifest(json(licenseIndex));
  const expectedLicenses = new Set(["manifest.json"]);
  for (const crate of licenseManifest.crates) for (const file of crate.files) {
    expectedLicenses.add(file.path);
    const bytes = licenseFiles.get(file.path);
    if (bytes === undefined || bytes.byteLength !== file.bytes || nativeInputHash(bytes) !== file.sha256) reject();
  }
  if (licenseFiles.size !== expectedLicenses.size) reject();
  for (const [path, bytes] of clients) files.push({ path: "package/" + path, mode: 0o644, bytes });
  for (const [path, bytes] of licenseFiles) files.push({ path: "package/native-artifacts/licenses/" + path, mode: 0o644, bytes });
  const artifacts = input.bundles.map(bundle => {
    const qualified = parseNativeQualification(json(bundle.qualification), input.source);
    const artifact = qualifiedNativeArtifact(qualified, nativeInputHash(bundle.qualification));
    if (bundle.executable.byteLength !== artifact.bytes || nativeInputHash(bundle.executable) !== artifact.sha256) reject();
    assertNativeExecutableHeader(bundle.executable, artifact);
    files.push({ path: "package/native-artifacts/" + artifact.rustTarget + "/oompa-process-kernel", mode: 0o755, bytes: bundle.executable },
      { path: "package/native-artifacts/qualifications/" + artifact.rustTarget + ".json", mode: 0o644, bytes: bundle.qualification });
    return artifact;
  }).sort((left, right) => left.target < right.target ? -1 : left.target > right.target ? 1 : 0);
  const manifest = parseNativeArtifactManifest({ formatVersion: 1, package: NATIVE_PACKAGE_NAME, version: NATIVE_PACKAGE_VERSION,
    protocolVersion: 1, licensesSha256: nativeInputHash(licenseIndex), source: input.source,
    client: NATIVE_CLIENT_FILES.map(path => {
      const bytes = clients.get(path);
      if (bytes === undefined) reject();
      return { path, bytes: bytes.byteLength, sha256: nativeInputHash(bytes) };
    }),
    artifacts });
  const manifestBytes = jsonBytes(manifest);
  files.push({ path: manifestPath, mode: 0o644, bytes: manifestBytes });
  const archive = createNativeProcessArchive(files);
  inspectQualifiedNativeProcessPackage(archive, manifest);
  return { archive, archiveSha256: nativeInputHash(archive), manifest, manifestSha256: nativeInputHash(manifestBytes) };
}

/** Repeat exact inventory, byte and evidence checks against the finished tarball
 * before any installer extracts it. Unknown files never become package inputs. */
export function inspectQualifiedNativeProcessPackage(archive: Uint8Array,
  expected?: NativeArtifactManifest): NativeArtifactManifest {
  const files = new Map(inspectNativeProcessArchive(archive).map(file => [file.path, file]));
  const take = (path: string, mode: 0o644 | 0o755, maximum = 1024 * 1024): Uint8Array => {
    const file = files.get(path);
    if (file === undefined || file.mode !== mode || file.bytes.byteLength < 1 || file.bytes.byteLength > maximum) reject();
    files.delete(path); return file.bytes;
  };
  const manifest = parseNativeArtifactManifest(json(take(manifestPath, 0o644, 256 * 1024)));
  if (manifest.artifacts.length === 0 || (expected !== undefined && !isDeepStrictEqual(manifest, expected))) reject();
  for (const client of manifest.client) {
    const bytes = take("package/" + client.path, 0o644);
    if (bytes.byteLength !== client.bytes || nativeInputHash(bytes) !== client.sha256) reject();
    if (client.path === "package.json") packageManifest(bytes);
  }
  take("package/README.md", 0o644); take("package/LICENSE", 0o644);
  const licenseIndex = take(licensesPath, 0o644, 256 * 1024);
  if (nativeInputHash(licenseIndex) !== manifest.licensesSha256) reject();
  const licenses = parseNativeLicenseManifest(json(licenseIndex));
  for (const crate of licenses.crates) for (const file of crate.files) {
    const bytes = take("package/native-artifacts/licenses/" + file.path, 0o644, 256 * 1024);
    if (bytes.byteLength !== file.bytes || nativeInputHash(bytes) !== file.sha256) reject();
  }
  for (const artifact of manifest.artifacts) {
    const bytes = take("package/native-artifacts/" + artifact.rustTarget + "/oompa-process-kernel", 0o755, 32 * 1024 * 1024);
    if (nativeInputHash(bytes) !== artifact.sha256) reject();
    assertNativeExecutableHeader(bytes, artifact);
    const receipt = take("package/native-artifacts/qualifications/" + artifact.rustTarget + ".json", 0o644, 256 * 1024);
    if (nativeInputHash(receipt) !== artifact.qualificationSha256) reject();
    const qualification = parseNativeQualification(json(receipt), manifest.source);
    if (!isDeepStrictEqual(qualifiedNativeArtifact(qualification, nativeInputHash(receipt)), artifact)) reject();
  }
  if (files.size !== 0) reject();
  return manifest;
}

/** Assembly is separate from qualification: each matching real OS produces a
 * bundle, then one job builds the final archive once from those exact bytes. */
export async function buildQualifiedNativeProcessPackage(outputDirectory: string,
  bundleDirectories: readonly string[]): Promise<Readonly<{ archivePath: string; archiveSha256: string; manifestSha256: string }>> {
  if (Bun.version !== "1.3.14" || bundleDirectories.length < 1 || bundleDirectories.length > 4) reject();
  const repository = realpathSync(join(import.meta.dir, ".."));
  const output = resolve(outputDirectory), parent = dirname(output);
  if (realpathSync(parent) !== parent || output === repository || output.startsWith(repository + "/")) reject();
  const inputs = nativeProcessSourceInventory(repository);
  const bundleInputs = bundleDirectories.map(directory => {
    const root = resolve(directory);
    if (realpathSync(root) !== root || !lstatSync(root).isDirectory()) reject();
    const qualification = nativeBuildInput(join(root, "qualification.json"), 256 * 1024);
    return { root, qualification, parsed: parseNativeQualification(json(qualification)),
      executable: nativeBuildInput(join(root, "oompa-process-kernel"), 32 * 1024 * 1024) };
  });
  const firstBundle = bundleInputs[0];
  if (firstBundle === undefined) reject();
  const source = firstBundle.parsed.source;
  const inputHash = (path: string): string => { const entry = inputs.find(file => file.path === path); if (entry === undefined) reject(); return entry.sha256; };
  if (source.treeSha256 !== nativeInputHash(Buffer.from(JSON.stringify(inputs)))
    || source.bunLockSha256 !== inputHash("bun.lock") || source.cargoLockSha256 !== inputHash("native/process-kernel/Cargo.lock")
    || source.toolchainSha256 !== inputHash("native/process-kernel/rust-toolchain.toml")) reject();
  const clients = packageFiles.map(path => {
    const bytes = nativeBuildInput(join(repository, "packages/native-process", path));
    const captured = inputs.find(file => file.path === "packages/native-process/" + path);
    if (captured === undefined || captured.bytes !== bytes.length || captured.sha256 !== nativeInputHash(bytes)) reject();
    return { path, bytes };
  });
  const crates = new Map<string, ReturnType<typeof parseNativeLicenseManifest>["crates"][number]>();
  const notices = new Map<string, Uint8Array>();
  for (const bundle of bundleInputs) {
    if (!isDeepStrictEqual(bundle.parsed.source, source)) reject();
    const licenseIndex = nativeBuildInput(join(bundle.root, "licenses/manifest.json"), 256 * 1024);
    if (nativeInputHash(licenseIndex) !== bundle.parsed.licensesSha256) reject();
    const index = parseNativeLicenseManifest(json(licenseIndex));
    if (!index.crates.some(crate => crate.name === `rust-runtime-${bundle.parsed.target}` && crate.version === "1.97.1")) reject();
    for (const crate of index.crates) {
      const key = crate.name + "@" + crate.version;
      const previous = crates.get(key);
      if (previous !== undefined && !isDeepStrictEqual(previous, crate)) reject();
      crates.set(key, crate);
      for (const file of crate.files) {
        const bytes = nativeBuildInput(join(bundle.root, "licenses", file.path), 256 * 1024);
        if (bytes.length !== file.bytes || nativeInputHash(bytes) !== file.sha256) reject();
        const existing = notices.get(file.path);
        if (existing !== undefined && nativeInputHash(existing) !== file.sha256) reject();
        notices.set(file.path, bytes);
      }
    }
  }
  const licenses = parseNativeLicenseManifest({ formatVersion: 1, crates: [...crates.values()].sort((left, right) =>
    left.name + "@" + left.version < right.name + "@" + right.version ? -1 : 1) });
  const built = assembleNativeProcessPackage({ source, client: clients, bundles: bundleInputs,
    licenses: [{ path: "manifest.json", bytes: jsonBytes(licenses) }, ...[...notices].map(([path, bytes]) => ({ path, bytes }))] });
  // The tool is read-only, bounded, and must be collected before output exists.
  const git = Bun.which("git"); if (git === null) reject();
  const { requireBoundedProcessCleanup, runBoundedProcess } = await import("./bounded-process.ts");
  // Build tools must never open the user's product recovery directory. Retain
  // this isolated root if the command or any following admission step fails.
  const work = realpathSync(mkdtempSync(join(parent, ".native-process-package-")));
  const workIdentity = lstatSync(work, { bigint: true });
  if (!workIdentity.isDirectory() || process.getuid === undefined || workIdentity.uid !== BigInt(process.getuid())
    || (workIdentity.mode & 0o7777n) !== 0o700n) reject();
  const current = requireBoundedProcessCleanup(await runBoundedProcess({ executable: git,
    arguments: ["rev-parse", "HEAD"], containment: "local", cwd: repository,
    environment: { PATH: "/usr/bin:/bin", LC_ALL: "C" }, outputMaximumBytes: 4096,
    phase: "native-package-source", timeoutMs: 5000, terminationGraceMs: 250,
  }, { recoveryDirectory: join(work, "recovery") }));
  if (current.exitCode !== 0 || current.stdout.toString("utf8").trim() !== source.commitSha
    || !isDeepStrictEqual(nativeProcessSourceInventory(repository), inputs)) reject();
  mkdirSync(output, { mode: 0o700 });
  const identity = lstatSync(output, { bigint: true });
  if (!identity.isDirectory() || identity.uid !== BigInt(process.getuid())
    || (identity.mode & 0o7777n) !== 0o700n || realpathSync(output) !== output) reject();
  const write = (name: string, bytes: Uint8Array): void => {
    const fd = openSync(join(output, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  };
  const archiveName = `hraness-native-process-${NATIVE_PACKAGE_VERSION}.tgz`;
  write(archiveName, built.archive);
  write("SHA256SUMS", Buffer.from(`${built.archiveSha256}  ${archiveName}\n`));
  // CI-only installation pin input. Publication binds it to the final archive
  // and workflow; adjacent agreement alone is never executable admission.
  write("admission.json", jsonBytes({ formatVersion: 1, package: NATIVE_PACKAGE_NAME, version: NATIVE_PACKAGE_VERSION,
    archiveSha256: built.archiveSha256, manifestSha256: built.manifestSha256, source,
    targets: built.manifest.artifacts.map(artifact => artifact.target) }));
  const fd = openSync(output, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const current = lstatSync(output, { bigint: true });
    const opened = fstatSync(fd, { bigint: true });
    if (current.dev !== identity.dev || current.ino !== identity.ino || current.mode !== identity.mode
      || opened.dev !== identity.dev || opened.ino !== identity.ino || opened.mode !== identity.mode) reject();
    fsyncSync(fd);
  } finally { closeSync(fd); }
  const workCurrent = lstatSync(work, { bigint: true });
  if (realpathSync(work) !== work || workCurrent.dev !== workIdentity.dev || workCurrent.ino !== workIdentity.ino
    || workCurrent.mode !== workIdentity.mode || workCurrent.uid !== workIdentity.uid) reject();
  rmSync(work, { recursive: true });
  return { archivePath: join(output, archiveName), archiveSha256: built.archiveSha256, manifestSha256: built.manifestSha256 };
}

if (import.meta.main) {
  const [output, ...bundles] = process.argv.slice(2);
  if (output === undefined) throw Error("Usage: native-process-package.ts FRESH_OUTPUT QUALIFIED_BUNDLE...");
  console.log(JSON.stringify(await buildQualifiedNativeProcessPackage(output, bundles)));
}
