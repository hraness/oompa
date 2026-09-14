import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdtempSync,
  openSync, opendirSync, readSync, realpathSync, rmdirSync, unlinkSync, writeFileSync, type BigIntStats } from "node:fs";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

import { assertNativeExecutableHeader, isNativeSha256, MAX_NATIVE_MANIFEST_BYTES, MAX_NATIVE_EVIDENCE_BYTES,
  NativeArtifactError, nativeArtifactTarget, parseNativeArtifactManifest, parseNativeLicenseManifest,
  parseNativeArtifactAdmissionOptions,
  type NativeArtifact, type NativeArtifactManifest } from "./artifact-model.ts";

declare const admittedArtifact: unique symbol;
export type AdmittedNativeArtifact = Readonly<{ [admittedArtifact]: true }>;
export type NativeArtifactIdentity = Readonly<{
  packageVersion: NativeArtifactManifest["version"]; manifestSha256: string;
  source: NativeArtifactManifest["source"]; artifact: NativeArtifact;
}>;
export interface NativeArtifactAdmissionOptions {
  /** Canonical existing private directory provided by the product state owner. */
  readonly imageRoot: string;
  /** Pinned by trusted release/install metadata, never user or environment input. */
  readonly manifestSha256: string;
}
type Directory = Readonly<{ path: string; metadata: BigIntStats }>;
type Installation = Readonly<{
  manifest: NativeArtifactManifest; manifestSha256: string; directories: readonly Directory[];
  files: ReadonlyMap<string, BigIntStats>; artifact: NativeArtifact; bytes: Buffer;
}>;
type Admission = Readonly<{
  imageRoot: string; directories: readonly Directory[];
  executable: string; metadata: BigIntStats; identity: NativeArtifactIdentity;
}>;
const admissions = new WeakMap<AdmittedNativeArtifact, Admission>();
const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sameIdentity = (a: BigIntStats, b: BigIntStats): boolean => a.dev === b.dev && a.ino === b.ino
  && a.uid === b.uid && a.gid === b.gid && a.mode === b.mode;
const sameFile = (a: BigIntStats, b: BigIntStats): boolean => sameIdentity(a, b) && a.size === b.size
  && a.nlink === b.nlink && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
// A different resolver may admit the published inode before its creator
// removes the temporary hard link. Only that 2→1 transition may change ctime;
// full bytes/header are still verified and the token then retains the new stats.
const retiredStagingAlias = (before: BigIntStats, after: BigIntStats): boolean =>
  before.nlink === 2n && after.nlink === 1n && sameIdentity(before, after)
  && before.size === after.size && before.mtimeNs === after.mtimeNs;
function failure(): never { throw new NativeArtifactError("admission-failed"); }
function uid(): bigint { if (process.getuid === undefined) failure(); return BigInt(process.getuid()); }
function canonical(path: string): void {
  if (!isAbsolute(path) || normalize(path) !== path || Buffer.byteLength(path) > 4096 || path.includes("\0")
    || realpathSync(path) !== path) failure();
}
function directory(path: string, privateRoot: boolean): Directory {
  canonical(path);
  const metadata = lstatSync(path, { bigint: true });
  if (!metadata.isDirectory() || (metadata.uid !== 0n && metadata.uid !== uid())
    || (metadata.mode & 0o022n) !== 0n
    || (privateRoot && (metadata.uid !== uid() || (metadata.mode & 0o7777n) !== 0o700n))) failure();
  return { path, metadata };
}
function ancestors(path: string, privateRoot = false): readonly Directory[] {
  const entries: Directory[] = [];
  let current = path;
  for (let depth = 0; depth < 128; depth += 1) {
    entries.push(directory(current, privateRoot && depth === 0));
    const parent = dirname(current);
    if (parent === current) return entries;
    current = parent;
  }
  failure();
}
function assertDirectories(entries: readonly Directory[]): void {
  for (const expected of entries) {
    canonical(expected.path);
    if (!sameIdentity(lstatSync(expected.path, { bigint: true }), expected.metadata)) failure();
  }
}
function installedMetadata(metadata: BigIntStats): void {
  if (!metadata.isFile() || (metadata.uid !== 0n && metadata.uid !== uid()) || (metadata.mode & 0o7022n) !== 0n) failure();
}
function imageMetadata(metadata: BigIntStats): void {
  if (!metadata.isFile() || metadata.uid !== uid() || (metadata.mode & 0o7777n) !== 0o500n
    || metadata.nlink < 1n || metadata.nlink > 2n) failure();
}
function readFile(path: string, maximum: number, expected?: BigIntStats, image = false): { bytes: Buffer; metadata: BigIntStats } {
  canonical(path);
  const named = lstatSync(path, { bigint: true });
  const validate = image ? imageMetadata : installedMetadata;
  validate(named);
  if (expected !== undefined && !sameFile(named, expected) && !(image && retiredStagingAlias(expected, named))) failure();
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const metadata = fstatSync(fd, { bigint: true });
    validate(metadata);
    if (!sameFile(metadata, named) || metadata.size < 1n || metadata.size > BigInt(maximum)) failure();
    const bytes = Buffer.alloc(Number(metadata.size));
    let offset = 0, reads = 0;
    while (offset < bytes.byteLength) {
      if (++reads > 4096) failure();
      const count = readSync(fd, bytes, offset, bytes.byteLength - offset, offset);
      if (count < 1) failure();
      offset += count;
    }
    if (readSync(fd, Buffer.alloc(1), 0, 1, offset) !== 0
      || !sameFile(metadata, fstatSync(fd, { bigint: true }))
      || !sameFile(metadata, lstatSync(path, { bigint: true }))) failure();
    canonical(path);
    return { bytes, metadata };
  } finally { closeSync(fd); }
}
function installedPath(relative: string, directories: Directory[]): string {
  const components = relative.split("/");
  let path = packageRoot;
  for (let index = 0; index < components.length; index += 1) {
    const component = components[index];
    if (component === undefined || !/^[a-zA-Z0-9._-]+$/u.test(component) || component === "." || component === "..") failure();
    path = join(path, component);
    if (index < components.length - 1) directories.push(directory(path, false));
  }
  return path;
}
function assertNativeInventory(files: ReadonlyMap<string, BigIntStats>): void {
  const root = join(packageRoot, "native-artifacts");
  const expected = new Set([...files.keys()].filter(path => path.startsWith(root + "/")));
  const allowedDirectories = new Set<string>([root]);
  for (const path of expected) {
    for (let parent = dirname(path); parent !== root; parent = dirname(parent)) allowedDirectories.add(parent);
  }
  const pending = [root];
  let count = 0;
  while (pending.length > 0) {
    const path = pending.pop();
    if (path === undefined) failure();
    directory(path, false);
    const entries = opendirSync(path);
    try {
      for (let entry = entries.readSync(); entry !== null; entry = entries.readSync()) {
        if (++count > 1024) failure();
        const name = join(path, entry.name);
        const metadata = lstatSync(name, { bigint: true });
        if (metadata.isDirectory() && allowedDirectories.has(name)) pending.push(name);
        else if (metadata.isFile() && expected.delete(name)) installedMetadata(metadata);
        else failure();
      }
    } finally { entries.closeSync(); }
  }
  if (expected.size !== 0) failure();
}
function verifyInstallation(manifestSha256: string): Installation {
  const target = nativeArtifactTarget(process.platform, process.arch);
  if (target === null || process.getuid === undefined) throw new NativeArtifactError("unsupported-target");
  if (!isNativeSha256(manifestSha256)) failure();
  const directories = [...ancestors(packageRoot)];
  const files = new Map<string, BigIntStats>();
  const manifestPath = installedPath("native-artifacts/manifest.json", directories);
  const manifestFile = readFile(manifestPath, MAX_NATIVE_MANIFEST_BYTES);
  if (hash(manifestFile.bytes) !== manifestSha256) failure();
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestFile.bytes));
  const manifest = parseNativeArtifactManifest(value);
  files.set(manifestPath, manifestFile.metadata);
  const artifact = manifest.artifacts.find(entry => entry.target === target);
  if (artifact === undefined) throw new NativeArtifactError("unsupported-target");
  const licensePath = installedPath("native-artifacts/licenses/manifest.json", directories);
  const licenseFile = readFile(licensePath, MAX_NATIVE_MANIFEST_BYTES);
  if (hash(licenseFile.bytes) !== manifest.licensesSha256) failure();
  const licenses = parseNativeLicenseManifest(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(licenseFile.bytes)) as unknown);
  files.set(licensePath, licenseFile.metadata);
  for (const crate of licenses.crates) for (const file of crate.files) {
    const path = installedPath("native-artifacts/licenses/" + file.path, directories);
    const read = readFile(path, file.bytes);
    if (read.bytes.byteLength !== file.bytes || hash(read.bytes) !== file.sha256 || (read.metadata.mode & 0o111n) !== 0n) failure();
    files.set(path, read.metadata);
  }
  for (const file of manifest.client) {
    const path = installedPath(file.path, directories);
    const read = readFile(path, file.bytes);
    if (read.bytes.byteLength !== file.bytes || hash(read.bytes) !== file.sha256) failure();
    files.set(path, read.metadata);
    if (file.path === "package.json") {
      const metadata: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(read.bytes));
      if (metadata === null || typeof metadata !== "object" || !("name" in metadata) || metadata.name !== manifest.package
        || !("version" in metadata) || metadata.version !== manifest.version || !("type" in metadata) || metadata.type !== "module") failure();
    }
  }
  let bytes: Buffer | undefined;
  for (const entry of manifest.artifacts) {
    const evidencePath = installedPath("native-artifacts/qualifications/" + entry.rustTarget + ".json", directories);
    const evidence = readFile(evidencePath, MAX_NATIVE_EVIDENCE_BYTES);
    if (hash(evidence.bytes) !== entry.qualificationSha256 || (evidence.metadata.mode & 0o111n) !== 0n) failure();
    files.set(evidencePath, evidence.metadata);
    const path = installedPath("native-artifacts/" + entry.rustTarget + "/oompa-process-kernel", directories);
    const read = readFile(path, entry.bytes);
    if (read.bytes.byteLength !== entry.bytes || (read.metadata.mode & 0o111n) === 0n || hash(read.bytes) !== entry.sha256) failure();
    assertNativeExecutableHeader(read.bytes, entry);
    files.set(path, read.metadata);
    if (entry.target === target) bytes = read.bytes;
  }
  if (bytes === undefined) failure();
  assertNativeInventory(files);
  assertDirectories(directories);
  for (const [path, metadata] of files) if (!sameFile(lstatSync(path, { bigint: true }), metadata)) failure();
  return { manifest, manifestSha256, directories, files, artifact, bytes };
}
function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function imageAt(path: string, artifact: NativeArtifact, expected?: BigIntStats): BigIntStats {
  const read = readFile(path, artifact.bytes, expected, true);
  if (hash(read.bytes) !== artifact.sha256) failure();
  assertNativeExecutableHeader(read.bytes, artifact);
  return read.metadata;
}
function isExists(error: unknown): boolean { return error !== null && typeof error === "object" && "code" in error && error.code === "EEXIST"; }
function isMissing(error: unknown): boolean { return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT"; }

/** Create only. Published names are never unlinked, rewritten or replaced.
 * A crash after link publication may retain the private staging alias (nlink2).
 * Both names remain immutable within the cooperative same-UID owner contract. */
function publishImage(root: string, expectedDirectories: readonly Directory[], installation: Installation): { path: string; metadata: BigIntStats } {
  const artifact = installation.artifact;
  const path = join(root, "native-process-" + installation.manifest.version + "-" + artifact.target + "-" + artifact.sha256);
  assertDirectories(expectedDirectories);
  try { return { path, metadata: imageAt(path, artifact) }; }
  catch (error) { if (!isMissing(error)) throw error; }
  let staging: Directory | undefined, stagedPath: string | undefined, stagedMetadata: BigIntStats | undefined;
  try {
    staging = directory(mkdtempSync(join(root, ".native-process-stage-")), true);
    stagedPath = join(staging.path, "oompa-process-kernel");
    assertDirectories(expectedDirectories);
    const fd = openSync(stagedPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o500);
    try {
      stagedMetadata = fstatSync(fd, { bigint: true });
      imageMetadata(stagedMetadata);
      writeFileSync(fd, installation.bytes);
      fsyncSync(fd);
      stagedMetadata = fstatSync(fd, { bigint: true });
    } finally { closeSync(fd); }
    imageAt(stagedPath, artifact, stagedMetadata);
    syncDirectory(staging.path);
    assertDirectories([...expectedDirectories, staging]);
    try { linkSync(stagedPath, path); }
    catch (error) { if (!isExists(error)) throw error; }
    // EEXIST is a comparison, never permission to overwrite a published image.
    imageAt(path, artifact);
    syncDirectory(root);
  } finally {
    if (staging !== undefined) {
      assertDirectories([...expectedDirectories, staging]);
      if (stagedPath !== undefined && stagedMetadata !== undefined) {
        const current = lstatSync(stagedPath, { bigint: true });
        if (!sameIdentity(current, stagedMetadata) || !current.isFile()) failure();
        unlinkSync(stagedPath);
      }
      // Only our exact staging directory is removed, and only if it is empty.
      rmdirSync(staging.path);
      syncDirectory(root);
    }
  }
  assertDirectories(expectedDirectories);
  return { path, metadata: imageAt(path, artifact) };
}

/** Authenticated installation must precede loading this code. This detects
 * installed drift; it cannot bootstrap trust in a malicious already-loaded client. */
export function resolveInstalledNativeArtifact(input: NativeArtifactAdmissionOptions): AdmittedNativeArtifact {
  try {
    const options = parseNativeArtifactAdmissionOptions(input);
    const installation = verifyInstallation(options.manifestSha256);
    const directories = ancestors(options.imageRoot, true);
    const image = publishImage(options.imageRoot, directories, installation);
    const token = Object.freeze({}) as AdmittedNativeArtifact;
    const identity = Object.freeze({ packageVersion: installation.manifest.version,
      manifestSha256: installation.manifestSha256, source: installation.manifest.source, artifact: installation.artifact });
    admissions.set(token, { imageRoot: options.imageRoot, directories,
      executable: image.path, metadata: image.metadata, identity });
    return token;
  } catch (error) {
    if (error instanceof NativeArtifactError && error.reason === "unsupported-target") throw error;
    throw new NativeArtifactError("admission-failed");
  }
}
export function nativeArtifactIdentity(artifact: AdmittedNativeArtifact): NativeArtifactIdentity {
  const admission = admissions.get(artifact);
  if (admission === undefined) throw new NativeArtifactError("invalid-capability");
  return admission.identity;
}

/** Last synchronous check immediately before the trusted host calls spawn.
 * No await may intervene. There is intentionally no image release/delete API. */
export function nativeArtifactExecutable(artifact: AdmittedNativeArtifact): string {
  const admission = admissions.get(artifact);
  if (admission === undefined) throw new NativeArtifactError("invalid-capability");
  try {
    assertDirectories(admission.directories);
    directory(admission.imageRoot, true);
    const metadata = imageAt(admission.executable, admission.identity.artifact, admission.metadata);
    assertDirectories(admission.directories);
    // Consume the one permitted alias-retirement transition. Subsequent same
    // count ctime changes cannot hide behind the old two-link snapshot.
    if (!sameFile(admission.metadata, metadata)) admissions.set(artifact, { ...admission, metadata });
    return admission.executable;
  } catch { throw new NativeArtifactError("image-changed"); }
}
