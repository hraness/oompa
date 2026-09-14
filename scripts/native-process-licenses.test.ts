import { afterEach, expect, test } from "bun:test";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";

import { parseNativeLicenseManifest } from "../packages/native-process/src/artifact-model.ts";
import { nativeInputHash } from "./native-process-build-inputs.ts";
import { createNativeProcessArchive } from "./native-process-archive.ts";
import { nativeCrateChecksums } from "./native-process-crate-archive.ts";
import { collectNativeProcessLicenses } from "./native-process-licenses.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true }); });
const registry = "registry+https://github.com/rust-lang/crates.io-index";
const dependencies = [["normal", "1.0.0", "a"], ["build", "2.0.0", "b"], ["dev", "3.0.0", "c"]] as const;
function crateArchive(stem: string, files: readonly { path: string; bytes: Uint8Array }[]): Buffer {
  const tar = gunzipSync(createNativeProcessArchive(files.map(file => ({ ...file, path: "package/" + file.path, mode: 0o644 }))));
  for (let offset = 0; offset < tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const path = header.subarray(0, 100).toString().split("\0")[0]!.replace("package/", stem + "/");
    if (path.length > 100) throw Error("FIXTURE_PATH_BOUND");
    header.fill(0, 0, 100); header.write(path, 0, 100, "ascii");
    header.write("ustar  \0", 257, 8, "ascii");
    header.fill(32, 148, 156);
    header.write(header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
    offset += 512 + Math.ceil(Number.parseInt(header.subarray(124, 136).toString(), 8) / 512) * 512;
  }
  return gzipSync(tar);
}
function fixture() {
  const root = mkdtempSync(join(process.cwd(), ".native-notices-test-")); roots.push(root);
  const kernel = join(root, "kernel"), toolchain = join(root, "rust-1.97.1");
  function put(path: string, text: string | Uint8Array) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); writeFileSync(path, text, { mode: 0o600 });
  }
  put(join(kernel, "Cargo.toml"), '[package]\nname="oompa-process-kernel"\nversion="0.1.0"\n');
  const packages = [{ id: "root", name: "oompa-process-kernel", version: "0.1.0", source: null as string | null,
    manifest_path: join(kernel, "Cargo.toml"), license: "MIT" as string | null, license_file: null as string | null }];
  const notices: Record<string, string> = {};
  const checksums = new Map<string, string>();
  const crateRoot = (name: string, version: string) => join(root, "registry/src/index.example", name + "-" + version);
  const cachePath = (name: string, version: string) => join(root, "registry/cache/index.example", name + "-" + version + ".crate");
  function seal(name: string): void {
    const version = dependencies.find(value => value[0] === name)![1];
    const directory = crateRoot(name, version);
    const files = readdirSync(directory, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile())
      .map(entry => ({ path: join(entry.parentPath, entry.name).slice(directory.length + 1), bytes: readFileSync(join(entry.parentPath, entry.name)) }));
    const bytes = crateArchive(name + "-" + version, files);
    put(cachePath(name, version), bytes); checksums.set(name, nativeInputHash(bytes));
    put(join(kernel, "Cargo.lock"), 'version=4\n[[package]]\nname="oompa-process-kernel"\nversion="0.1.0"\n'
      + dependencies.map(([name, version]) => '[[package]]\nname="' + name + '"\nversion="' + version
        + '"\nsource="' + registry + '"\nchecksum="' + (checksums.get(name) ?? "0".repeat(64)) + '"\n').join(""));
  }
  for (const [name, version] of dependencies) {
    const directory = crateRoot(name, version);
    const manifest = '[package]\nname="' + name + '"\nversion="' + version + '"\nlicense="MIT"\n';
    const notice = name + " exact licence bytes\n";
    put(join(directory, "Cargo.toml"), manifest); put(join(directory, "LICENSE"), notice);
    seal(name);
    notices[name!] = join(directory, "LICENSE");
    packages.push({ id: name!, name: name!, version: version!, source: registry,
      manifest_path: join(directory, "Cargo.toml"), license: "MIT", license_file: null });
  }
  for (const path of ["COPYRIGHT", "LICENSE-MIT", "LICENSE-APACHE", "share/doc/rustc/COPYRIGHT.html",
    "share/doc/rustc/COPYRIGHT-library.html", "share/doc/rustc/licenses/MIT.txt"]) put(join(toolchain, path), path + " exact runtime bytes\n");
  const metadata = { version: 1, packages, workspace_root: kernel, workspace_members: ["root"], resolve: {
    root: "root", nodes: [{ id: "root", deps: [
      { pkg: "normal", dep_kinds: [{ kind: null as string | null, target: null }] },
      { pkg: "build", dep_kinds: [{ kind: "build", target: null }] },
      { pkg: "dev", dep_kinds: [{ kind: "dev", target: null }] },
    ] }, { id: "normal", deps: [] }, { id: "build", deps: [] }, { id: "dev", deps: [] }] } };
  const options = { kernelDirectory: kernel, toolchainRoot: toolchain, target: "darwin-arm64" as const,
    outputDirectory: join(root, "licenses") };
  return { root, kernel, toolchain, metadata, options, notices, put, seal, cachePath, checksums };
}

test("collector retains exact normal/build/runtime notices and excludes dev-only closure", () => {
  const value = fixture(), result = collectNativeProcessLicenses(value.metadata, value.options);
  expect(result.manifest.crates.map(crate => crate.name)).toEqual(["build", "normal", "rust-runtime-darwin-arm64"]);
  expect(result.selection).toBe("normal-and-build-closure-plus-rust-distribution-notices");
  const bytes = readFileSync(join(value.options.outputDirectory, "manifest.json"));
  expect(nativeInputHash(bytes)).toBe(result.manifestSha256);
  const parsed = parseNativeLicenseManifest(JSON.parse(bytes.toString()) as unknown);
  expect(parsed).toEqual(result.manifest);
  for (const crate of parsed.crates) for (const file of crate.files) {
    const content = readFileSync(join(value.options.outputDirectory, file.path));
    expect(content.length).toBe(file.bytes); expect(nativeInputHash(content)).toBe(file.sha256);
  }
  expect(() => collectNativeProcessLicenses(value.metadata, value.options)).toThrow("COLLECTION_FAILED");
  expect(readFileSync(join(value.options.outputDirectory, "manifest.json"))).toEqual(bytes);
});

test("runtime notice namespaces preserve distinct target bundles without changing common crate names", () => {
  const value = fixture();
  const first = collectNativeProcessLicenses(value.metadata, value.options);
  const second = collectNativeProcessLicenses(value.metadata, { ...value.options,
    target: "linux-x64", outputDirectory: join(value.root, "linux-licenses") });
  const runtime = second.manifest.crates.find(crate => crate.name === "rust-runtime-linux-x64")!;
  expect(runtime.version).toBe("1.97.1");
  expect(runtime.files.every(file => file.path.startsWith("rust-runtime-linux-x64-1.97.1/"))).toBe(true);
  expect(second.manifest.crates.filter(crate => !crate.name.startsWith("rust-runtime-")))
    .toEqual(first.manifest.crates.filter(crate => !crate.name.startsWith("rust-runtime-")));
});

test.each(["checksum", "name", "version", "id", "node", "root-lock", "root-manifest"] as const)(
  "metadata/locked source mismatch %s refuses before output", change => {
    const value = fixture();
    if (change === "checksum") value.put(join(value.kernel, "Cargo.lock"), readFileSync(join(value.kernel, "Cargo.lock"), "utf8").replace(value.checksums.get("normal")!, "d".repeat(64)));
    else if (change === "name") value.metadata.packages[1]!.name = "different";
    else if (change === "version") value.metadata.packages[1]!.version = "9.0.0";
    else if (change === "id") value.metadata.packages[1]!.id = "different";
    else if (change === "node") value.metadata.resolve.nodes = value.metadata.resolve.nodes.filter(node => node.id !== "normal");
    else if (change === "root-lock") value.put(join(value.kernel, "Cargo.lock"), 'version=4\n[[package]]\nname="foreign"\nversion="0.1.0"\n');
    else value.put(join(value.kernel, "Cargo.toml"), '[package]\nname="foreign"\nversion="0.1.0"\n');
    expect(() => collectNativeProcessLicenses(value.metadata, value.options)).toThrow("COLLECTION_FAILED");
    expect(readdirSync(value.root)).not.toContain("licenses");
  });

test.each(["crate-notice", "runtime-notice", "tampered", "oversized", "symlink", "missing-expression"] as const)(
  "missing or unsafe %s refuses without fabricated notice evidence", change => {
    const value = fixture();
    const notice = value.notices.normal!;
    if (change === "crate-notice") unlinkSync(notice);
    else if (change === "runtime-notice") unlinkSync(join(value.toolchain, "share/doc/rustc/COPYRIGHT-library.html"));
    else if (change === "tampered") value.put(notice, "changed");
    else if (change === "oversized") value.put(notice, "x".repeat(256 * 1024 + 1));
    else if (change === "symlink") { unlinkSync(notice); symlinkSync(value.notices.build!, notice); }
    else value.metadata.packages[1]!.license = null;
    expect(() => collectNativeProcessLicenses(value.metadata, value.options)).toThrow("COLLECTION_FAILED");
    expect(readdirSync(value.root)).not.toContain("licenses");
  });

test("declared nonstandard license file is copied as evidence and never escapes its crate", () => {
  const value = fixture(), pkg = value.metadata.packages[1]!;
  const root = dirname(pkg.manifest_path);
  const manifest = '[package]\nname="normal"\nversion="1.0.0"\nlicense-file="terms/TERMS.txt"\n';
  const text = "declared exact terms\n";
  value.put(pkg.manifest_path, manifest); value.put(join(root, "terms/TERMS.txt"), text);
  value.seal("normal");
  pkg.license = null; pkg.license_file = join(root, "terms/TERMS.txt");
  const result = collectNativeProcessLicenses(value.metadata, value.options);
  const normal = result.manifest.crates.find(crate => crate.name === "normal");
  expect(normal?.license).toBe("LicenseRef-Crate-Declared-File");
  expect(normal?.files.some(file => file.path === "normal-1.0.0/terms__TERMS.txt")).toBe(true);
});

test("ordinary Cargo registry cache needs no vendored checksum and refuses a replaced cached archive", () => {
  const value = fixture();
  expect(readdirSync(dirname(value.notices.normal!))).not.toContain(".cargo-checksum.json");
  expect(collectNativeProcessLicenses(value.metadata, value.options).manifest.crates).toHaveLength(3);
  value.put(value.cachePath("normal", "1.0.0"), readFileSync(value.cachePath("build", "2.0.0")));
  expect(() => collectNativeProcessLicenses(value.metadata, { ...value.options, outputDirectory: join(value.root, "second") }))
    .toThrow("COLLECTION_FAILED:CRATE_ARCHIVE");
  expect(readdirSync(value.root)).not.toContain("second");
});

test("a missing archived notice refuses even when another valid notice remains", () => {
  const value = fixture();
  value.put(join(dirname(value.notices.normal!), "NOTICE"), "additional notice\n");
  value.seal("normal");
  unlinkSync(value.notices.normal!);
  expect(() => collectNativeProcessLicenses(value.metadata, value.options)).toThrow("COLLECTION_FAILED:EVIDENCE");
  expect(readdirSync(value.root)).not.toContain("licenses");
});

test("missing cache produces only a closed diagnostic and preserves no-output refusal", () => {
  const value = fixture(); unlinkSync(value.cachePath("normal", "1.0.0"));
  expect(() => collectNativeProcessLicenses(value.metadata, value.options)).toThrow("COLLECTION_FAILED:MISSING_INPUT");
  expect(readdirSync(value.root)).not.toContain("licenses");
});

test("registry manifest bytes must match the authenticated archive even with unchanged declared license", () => {
  const value = fixture(), manifest = value.metadata.packages[1]!.manifest_path;
  value.put(manifest, readFileSync(manifest, "utf8") + 'description="rewritten source"\n');
  expect(() => collectNativeProcessLicenses(value.metadata, value.options)).toThrow("COLLECTION_FAILED:EVIDENCE");
  expect(readdirSync(value.root)).not.toContain("licenses");
});

test("cached crate and notice files retain the single-link admission rule", () => {
  for (const kind of ["archive", "notice"]) {
    const value = fixture();
    linkSync(kind === "archive" ? value.cachePath("normal", "1.0.0") : value.notices.normal!, join(value.root, "alias"));
    expect(() => collectNativeProcessLicenses(value.metadata, value.options)).toThrow("COLLECTION_FAILED:EVIDENCE");
    expect(readdirSync(value.root)).not.toContain("licenses");
  }
});

test.each(["link", "checksum", "traversal", "prefix", "case-alias", "sparse", "bad-end", "padding", "high-numeric", "high-magic"] as const)(
  "authenticated Cargo archive refuses unsupported or ambiguous %s semantics", change => {
    const initial = crateArchive("example-1.0.0", [{ path: "Cargo.toml", bytes: Buffer.from("manifest") },
      { path: "LICENSE", bytes: Buffer.from("notice") }]);
    const tar = gunzipSync(initial), first = tar.subarray(0, 512), second = tar.subarray(1024, 1536);
    if (change === "link") first[156] = 50;
    else if (change === "traversal" || change === "prefix") {
      first.fill(0, 0, 100); first.write(change === "traversal" ? "example-1.0.0/../Cargo.toml" : "foreign-1.0.0/Cargo.toml");
    } else if (change === "case-alias") { second.fill(0, 0, 100); second.write("example-1.0.0/cargo.toml"); }
    else if (change === "sparse") first[386] = 49;
    else if (change === "bad-end") tar[tar.length - 1] = 1;
    else if (change === "padding") tar[600] = 1;
    else if (change === "high-numeric") first[100] = first[100]! | 0x80;
    else if (change === "high-magic") first[257] = first[257]! | 0x80;
    for (const header of [first, second]) {
      header.fill(32, 148, 156);
      header.write(header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
    }
    if (change === "checksum") first[0] = 120;
    const bytes = gzipSync(tar);
    expect(() => nativeCrateChecksums(bytes, "example-1.0.0", nativeInputHash(bytes))).toThrow("CRATE_ARCHIVE_INVALID");
  });
