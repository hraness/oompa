import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, opendirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";

import { NATIVE_ARTIFACT_TARGETS, parseNativeLicenseManifest, type NativeArtifactTarget,
  type NativeLicenseManifest } from "../packages/native-process/src/artifact-model.ts";
import { nativeBuildInput, nativeInputHash } from "./native-process-build-inputs.ts";
import { NATIVE_CRATE_MAX_PACKED, nativeCrateChecksums } from "./native-process-crate-archive.ts";

const name = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/u);
const version = z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][a-zA-Z0-9.-]+)?$/u).max(128);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const packageSchema = z.object({ id: z.string().min(1).max(4096), name, version,
  source: z.string().max(1024).nullable(), manifest_path: z.string().min(1).max(4096),
  license: z.string().max(256).nullable(), license_file: z.string().max(4096).nullable() });
const metadataSchema = z.object({ version: z.literal(1), packages: z.array(packageSchema).min(1).max(128),
  workspace_root: z.string().min(1).max(4096), workspace_members: z.array(z.string().max(4096)).length(1),
  resolve: z.object({ root: z.string().max(4096), nodes: z.array(z.object({
    id: z.string().max(4096), deps: z.array(z.object({ pkg: z.string().max(4096), dep_kinds: z.array(z.object({
      kind: z.enum(["dev", "build"]).nullable(), target: z.string().max(4096).nullable(),
    })).min(1).max(16) })).max(128),
  })).min(1).max(128) }) });
const lockSchema = z.object({ version: z.literal(4), package: z.array(z.object({
  name, version, source: z.string().max(1024).optional(), checksum: digest.optional(),
})).min(1).max(128) });
type CargoPackage = z.infer<typeof packageSchema>;
type SelectedCargoPackage = CargoPackage & { readonly checksums: Readonly<Record<string, string>> };
export interface NativeProcessLicenseOptions {
  readonly kernelDirectory: string;
  readonly toolchainRoot: string;
  readonly target: NativeArtifactTarget;
  /** A fresh directory name under an existing owned parent; never reused. */
  readonly outputDirectory: string;
}
export type CollectedNativeProcessLicenses = Readonly<{
  manifest: NativeLicenseManifest; manifestSha256: string; cargoLockSha256: string;
  target: NativeArtifactTarget; selection: "normal-and-build-closure-plus-rust-distribution-notices";
}>;
function fail(): never { throw Error("NATIVE_PROCESS_LICENSE_EVIDENCE_INVALID"); }
function directory(path: string): string {
  if (!isAbsolute(path) || resolve(path) !== path || realpathSync(path) !== path) fail();
  const metadata = lstatSync(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) fail();
  return path;
}
function beneath(root: string, path: string): string {
  const absolute = resolve(root, path), local = relative(root, absolute);
  if (local === "" || local.startsWith("..") || isAbsolute(local) || local.split(/[\\/]/u).length > 16) fail();
  let ancestor = dirname(absolute);
  for (;;) {
    directory(ancestor);
    if (ancestor === root) break;
    ancestor = dirname(ancestor);
  }
  return absolute;
}
function toml(path: string): unknown {
  return Bun.TOML.parse(new TextDecoder("utf-8", { fatal: true }).decode(nativeBuildInput(path)));
}
function parseSelection(value: unknown, kernelDirectory: string): { selected: SelectedCargoPackage[]; lockSha256: string } {
  const metadata = metadataSchema.parse(value);
  if (directory(metadata.workspace_root) !== kernelDirectory) fail();
  const packages = new Map(metadata.packages.map(pkg => [pkg.id, pkg]));
  const nodes = new Map(metadata.resolve.nodes.map(node => [node.id, node]));
  if (packages.size !== metadata.packages.length || nodes.size !== metadata.resolve.nodes.length
    || metadata.workspace_members[0] !== metadata.resolve.root) fail();
  const root = packages.get(metadata.resolve.root);
  if (root === undefined || root.name !== "oompa-process-kernel" || root.version !== "0.1.0"
    || root.source !== null || root.manifest_path !== join(kernelDirectory, "Cargo.toml")) fail();
  z.object({ package: z.object({ name: z.literal("oompa-process-kernel"), version: z.literal("0.1.0") }) })
    .parse(toml(root.manifest_path));
  const lockPath = join(kernelDirectory, "Cargo.lock"), lockBytes = nativeBuildInput(lockPath);
  const lock = lockSchema.parse(Bun.TOML.parse(new TextDecoder("utf-8", { fatal: true }).decode(lockBytes)));
  const locked = new Map(lock.package.map(pkg => [pkg.name + "@" + pkg.version, pkg]));
  const lockedRoot = locked.get("oompa-process-kernel@0.1.0");
  if (locked.size !== lock.package.length || lockedRoot === undefined || lockedRoot.source !== undefined || lockedRoot.checksum !== undefined) fail();
  const selected: SelectedCargoPackage[] = [], seen = new Set<string>(), names = new Set<string>();
  const queue = [root.id];
  while (queue.length > 0) {
    const id = queue.pop();
    if (id === undefined) fail();
    if (seen.has(id)) continue;
    seen.add(id);
    if (seen.size > 128) fail();
    const pkg = packages.get(id), node = nodes.get(id);
    if (pkg === undefined || node === undefined) fail();
    const key = pkg.name + "@" + pkg.version;
    if (names.has(key)) fail();
    names.add(key);
    if (id !== root.id) {
      const expected = locked.get(key);
      if (pkg.source !== "registry+https://github.com/rust-lang/crates.io-index"
        || expected === undefined || expected.source !== pkg.source || expected.checksum === undefined) fail();
      const crateRoot = directory(dirname(pkg.manifest_path));
      if (basename(pkg.manifest_path) !== "Cargo.toml") fail();
      const declared = z.object({ package: z.object({ name, version,
        license: z.string().nullable().optional(), "license-file": z.string().nullable().optional() }) }).parse(toml(pkg.manifest_path));
      if (declared.package.name !== pkg.name || declared.package.version !== pkg.version
        || (declared.package.license ?? null) !== pkg.license) fail();
      const declaredFile = declared.package["license-file"] ?? null;
      if (declaredFile === null ? pkg.license_file !== null : pkg.license_file === null
        || beneath(crateRoot, declaredFile) !== beneath(crateRoot, pkg.license_file)) fail();
      // Ordinary Cargo registry sources have .cargo-ok, not the per-file
      // checksum manifest used by cargo vendor. Bind the cached original crate
      // to Cargo.lock instead of treating either marker as content authority.
      const stem = pkg.name + "-" + pkg.version, indexRoot = dirname(crateRoot), sourceRoot = dirname(indexRoot);
      if (basename(crateRoot) !== stem || basename(sourceRoot) !== "src"
        || !/^[a-zA-Z0-9._-]+$/u.test(basename(indexRoot))) fail();
      const cache = directory(join(directory(dirname(sourceRoot)), "cache", basename(indexRoot)));
      const checksums = nativeCrateChecksums(nativeBuildInput(join(cache, stem + ".crate"), NATIVE_CRATE_MAX_PACKED), stem, expected.checksum);
      if (checksums["Cargo.toml"] !== nativeInputHash(nativeBuildInput(pkg.manifest_path))) fail();
      selected.push({ ...pkg, checksums });
    }
    // Cargo --filter-platform has already selected target edges. Build and
    // proc-macro closure is deliberately retained as a notices superset.
    for (const dependency of node.deps) if (dependency.dep_kinds.some(kind => kind.kind !== "dev")) queue.push(dependency.pkg);
  }
  return { selected: selected.sort((a, b) => (a.name + "@" + a.version).localeCompare(b.name + "@" + b.version)),
    lockSha256: nativeInputHash(lockBytes) };
}
function noticePaths(root: string, budget: { nodes: number }): string[] {
  const found: string[] = [];
  const pending = [{ path: root, depth: 0, noticeDirectory: false }];
  while (pending.length > 0) {
    const item = pending.pop();
    if (item === undefined || item.depth > 16) fail();
    directory(item.path);
    const handle = opendirSync(item.path);
    try {
      for (let entry = handle.readSync(); entry !== null; entry = handle.readSync()) {
        if (++budget.nodes > 65_536) fail();
        const path = join(item.path, entry.name), metadata = lstatSync(path);
        if (metadata.isSymbolicLink()) fail();
        const isNotice = /^(?:LICENSE|LICENCE|COPYING|COPYRIGHT|NOTICE|UNLICENSE)/iu.test(entry.name);
        if (metadata.isDirectory()) pending.push({ path, depth: item.depth + 1, noticeDirectory: item.noticeDirectory || isNotice });
        else if (!metadata.isFile()) fail();
        else if (item.noticeDirectory || isNotice) found.push(path);
      }
    } finally { handle.closeSync(); }
  }
  return found.sort();
}
type CopiedNotice = Readonly<{ path: string; bytes: Buffer }>;
function collect(value: unknown, options: NativeProcessLicenseOptions): { manifest: NativeLicenseManifest; files: CopiedNotice[]; lockSha256: string } {
  if (!Object.hasOwn(NATIVE_ARTIFACT_TARGETS, options.target)) fail();
  const kernel = directory(options.kernelDirectory), toolchain = directory(options.toolchainRoot);
  const selection = parseSelection(value, kernel), files: CopiedNotice[] = [];
  const crates: Array<{ name: string; version: string; license: string; files: Array<{ path: string; bytes: number; sha256: string }> }> = [];
  const budget = { nodes: 0 }, usedPaths = new Set<string>();
  let total = 0, totalBytes = 0;
  function append(crateName: string, crateVersion: string, license: string, root: string, paths: readonly string[],
    checksums?: Readonly<Record<string, string>>): void {
    const inventory: Array<{ path: string; bytes: number; sha256: string }> = [];
    for (const path of paths) {
      const local = relative(root, beneath(root, path)).replaceAll("\\", "/");
      const destination = crateName + "-" + crateVersion.replaceAll("+", "_") + "/" + local.replaceAll("/", "__");
      if (usedPaths.has(destination)) fail();
      usedPaths.add(destination);
      const bytes = nativeBuildInput(path, 256 * 1024);
      if (bytes.length === 0 || ++total > 256) fail();
      totalBytes += bytes.length;
      if (totalBytes > 4 * 1024 * 1024 || new TextDecoder("utf-8", { fatal: true }).decode(bytes).includes("\0")) fail();
      if (checksums !== undefined && checksums[local] !== nativeInputHash(bytes)) fail();
      files.push({ path: destination, bytes });
      inventory.push({ path: destination, bytes: bytes.length, sha256: nativeInputHash(bytes) });
    }
    if (inventory.length === 0) fail();
    crates.push({ name: crateName, version: crateVersion, license, files: inventory });
  }
  for (const pkg of selection.selected) {
    const root = directory(dirname(pkg.manifest_path)), paths = noticePaths(root, budget);
    const expectedNotices = Object.keys(pkg.checksums).filter(path => path.split("/")
      .some(part => /^(?:LICENSE|LICENCE|COPYING|COPYRIGHT|NOTICE|UNLICENSE)/iu.test(part))).sort();
    if (JSON.stringify(paths.map(path => relative(root, path)).sort()) !== JSON.stringify(expectedNotices)) fail();
    if (pkg.license_file !== null) {
      const declared = beneath(root, pkg.license_file);
      if (!paths.includes(declared)) paths.push(declared);
    }
    if (pkg.license === null && pkg.license_file === null) fail();
    append(pkg.name, pkg.version, pkg.license ?? "LicenseRef-Crate-Declared-File", root, paths.sort(), pkg.checksums);
  }
  const runtimePaths = ["COPYRIGHT", "LICENSE-MIT", "LICENSE-APACHE", "share/doc/rustc/COPYRIGHT-library.html",
    "share/doc/rustc/COPYRIGHT.html"].map(path => beneath(toolchain, path));
  const runtimeLicenses = directory(join(toolchain, "share/doc/rustc/licenses"));
  const handle = opendirSync(runtimeLicenses);
  try {
    for (let entry = handle.readSync(); entry !== null; entry = handle.readSync()) {
      if (++budget.nodes > 65_536 || !/^[a-zA-Z0-9._-]+\.txt$/u.test(entry.name)) fail();
      runtimePaths.push(beneath(toolchain, join(runtimeLicenses, entry.name)));
    }
  } finally { handle.closeSync(); }
  if (runtimePaths.length === 5) fail();
  for (const path of ["lib/rustlib/src/rust/library/compiler-builtins/LICENSE.txt",
    "lib/rustlib/src/rust/library/compiler-builtins/libm/LICENSE.txt"]) {
    try { lstatSync(join(toolchain, path)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    runtimePaths.push(beneath(toolchain, path));
  }
  // Runtime distributions may carry different notices on each qualified target.
  // Preserve each exact set when a release combines several target bundles.
  append("rust-runtime-" + options.target, "1.97.1", "LicenseRef-Rust-Distribution-Notices", toolchain, runtimePaths.sort());
  const manifest = parseNativeLicenseManifest({ formatVersion: 1, crates });
  return { manifest, files, lockSha256: selection.lockSha256 };
}

/** Call with fresh output from pinned cargo 1.97.1 metadata --format-version=1
 * --locked --offline --filter-platform <target> --manifest-path <kernel>/Cargo.toml.
 * The builder owns the clean environment, absent Cargo config, toolchain pin,
 * bounded command/cleanup and exact target selection. This library spawns nothing.
 * Cached ordinary registry .crate archives must match Cargo.lock; selected local
 * manifests and the complete notice inventory must match those archived bytes.
 * It copies a notice superset, not an inferred list of binary-linked licenses. */
export function collectNativeProcessLicenses(metadata: unknown, options: NativeProcessLicenseOptions): CollectedNativeProcessLicenses {
  try {
    const result = collect(metadata, options);
    const output = resolve(options.outputDirectory);
    if (output !== options.outputDirectory) fail();
    directory(dirname(output));
    // Finish every read and shape/hash check before creating output. A failed
    // publication retains its fresh directory; retries require a new name.
    mkdirSync(output, { mode: 0o700 });
    for (const file of result.files) {
      const path = join(output, file.path);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
      try { writeFileSync(fd, file.bytes); fsyncSync(fd); } finally { closeSync(fd); }
    }
    const bytes = Buffer.from(JSON.stringify(result.manifest) + "\n");
    const fd = openSync(join(output, "manifest.json"), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    for (const path of [...new Set(result.files.map(file => dirname(join(output, file.path)))), output]) {
      const directoryFd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
    }
    return Object.freeze({ manifest: result.manifest, manifestSha256: nativeInputHash(bytes), cargoLockSha256: result.lockSha256,
      target: options.target, selection: "normal-and-build-closure-plus-rust-distribution-notices" });
  } catch (error) {
    // Never surface paths, Cargo text, or arbitrary exception messages.
    const detail = error instanceof Error && error.message === "NATIVE_PROCESS_CRATE_ARCHIVE_INVALID"
      ? "CRATE_ARCHIVE" : (error as NodeJS.ErrnoException | null)?.code === "ENOENT" ? "MISSING_INPUT" : "EVIDENCE";
    throw Error("NATIVE_PROCESS_LICENSE_COLLECTION_FAILED:" + detail);
  }
}
