import { afterEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { NATIVE_ARTIFACT_TARGETS, NATIVE_CLIENT_FILES, nativeArtifactTarget,
  type NativeArtifact, type NativeArtifactManifest } from "./artifact-model.ts";
import type * as Resolver from "./artifact-resolver.ts";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const roots: string[] = [];
const restores: Array<{ mockRestore(): void }> = [];
afterEach(() => {
  for (const restore of restores.splice(0)) restore.mockRestore();
  // Only exact fresh fixture roots created by this test owner are removed.
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true });
});
const filesystemTest = nativeArtifactTarget(process.platform, process.arch) === null ? test.skip : test;
function executable(target: NativeArtifact["target"]): Buffer<ArrayBuffer> {
  const bytes = Buffer.alloc(128), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (target.startsWith("darwin")) {
    view.setUint32(0, 0xfeedfacf, true); view.setUint32(4, target === "darwin-arm64" ? 0x0100000c : 0x01000007, true);
    view.setUint32(8, target === "darwin-arm64" ? 0 : 3, true); view.setUint32(12, 2, true);
    view.setUint32(16, 1, true); view.setUint32(20, 8, true); view.setUint32(36, 8, true);
  } else {
    view.setUint32(0, 0x7f454c46, false); bytes[4] = 2; bytes[5] = 1; bytes[6] = 1;
    view.setUint16(16, 2, true); view.setUint16(18, target === "linux-arm64" ? 183 : 62, true);
    view.setUint32(20, 1, true); view.setBigUint64(32, 64n, true);
    view.setUint16(52, 64, true); view.setUint16(54, 56, true); view.setUint16(56, 1, true);
  }
  return bytes;
}
async function fixture() {
  const target = nativeArtifactTarget(process.platform, process.arch);
  if (target === null) throw Error("unsupported fixture host");
  // Keep fixtures under the owned checkout: system /tmp is world-writable and
  // intentionally fails the production ancestor policy.
  const root = fs.mkdtempSync(join(fs.realpathSync(process.cwd()), ".native-package-test-"));
  roots.push(root);
  const installed = join(root, "package"), imageRoot = join(root, "images");
  fs.mkdirSync(installed, { mode: 0o700 }); fs.mkdirSync(imageRoot, { mode: 0o700 });
  function put(path: string, bytes: Uint8Array, mode = 0o644): void {
    fs.mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path, bytes, { mode, flag: "wx" });
  }
  for (const file of NATIVE_CLIENT_FILES) put(join(installed, file), fs.readFileSync(join(packageRoot, file)));
  const bytes = executable(target), rustTarget = NATIVE_ARTIFACT_TARGETS[target];
  const binary = join(installed, "native-artifacts", rustTarget, "oompa-process-kernel");
  put(binary, bytes, 0o755);
  const evidencePath = join(installed, "native-artifacts/qualifications", rustTarget + ".json");
  const evidence = Buffer.from('{"fixture":"synthetic only, never executes or qualifies native code"}\n');
  put(evidencePath, evidence);
  const licensePath = join(installed, "native-artifacts/licenses/fixture-1.0.0/LICENSE");
  const license = Buffer.from("Synthetic fixture license.\n");
  put(licensePath, license);
  const licenseManifestPath = join(installed, "native-artifacts/licenses/manifest.json");
  const licenseManifest = Buffer.from(JSON.stringify({ formatVersion: 1,
    crates: [{ name: "fixture", version: "1.0.0", license: "MIT",
      files: [{ path: "fixture-1.0.0/LICENSE", bytes: license.length, sha256: hash(license) }] }] }));
  put(licenseManifestPath, licenseManifest);
  const manifest: NativeArtifactManifest = {
    formatVersion: 1, package: "@hraness/native-process", version: "0.1.0", protocolVersion: 1,
    licensesSha256: hash(licenseManifest),
    source: { commitSha: "a".repeat(40), treeSha256: "b".repeat(64), bunLockSha256: "c".repeat(64),
      cargoLockSha256: "d".repeat(64), toolchainSha256: "e".repeat(64), rustVersion: "1.97.1", bunVersion: "1.3.14", profile: "release" },
    client: NATIVE_CLIENT_FILES.map(path => {
      const value = fs.readFileSync(join(installed, path)); return { path, bytes: value.length, sha256: hash(value) };
    }),
    artifacts: [{ target, rustTarget, scope: "posix-process-group", bytes: bytes.length, sha256: hash(bytes),
      qualificationProfile: "native-process-v1-posix-custody", qualificationVersion: 1, qualificationSha256: hash(evidence) }],
  };
  const manifestPath = join(installed, "native-artifacts/manifest.json");
  const manifestBytes = Buffer.from(JSON.stringify(manifest)); put(manifestPath, manifestBytes);
  // Import the copied resolver as an installed module. No executable path or
  // package-root override is provided to the production API.
  const resolver = await import(pathToFileURL(join(installed, "src/artifact-resolver.ts")).href) as typeof Resolver;
  const options = { imageRoot, manifestSha256: hash(manifestBytes) };
  return { root, installed, imageRoot, bytes, binary, evidencePath, licensePath, licenseManifestPath, manifestPath,
    manifest, options, resolver, put };
}

filesystemTest("admission publishes immutable image and existing resolution never rewrites it", async () => {
  const value = await fixture(), token = value.resolver.resolveInstalledNativeArtifact(value.options);
  const path = value.resolver.nativeArtifactExecutable(token), first = fs.lstatSync(path, { bigint: true });
  expect(first.mode & 0o777n).toBe(0o500n); expect(first.nlink).toBe(1n);
  expect(fs.readFileSync(path)).toEqual(value.bytes);
  expect(fs.readdirSync(value.imageRoot)).toEqual([path.split("/").at(-1)!]);
  const second = value.resolver.resolveInstalledNativeArtifact(value.options);
  expect(value.resolver.nativeArtifactExecutable(second)).toBe(path);
  expect(fs.lstatSync(path, { bigint: true }).ino).toBe(first.ino);
  expect(fs.lstatSync(path, { bigint: true }).mtimeNs).toBe(first.mtimeNs);
  const identity = value.resolver.nativeArtifactIdentity(token);
  expect(identity.source).toEqual(value.manifest.source);
  expect(Object.isFrozen(identity.source)).toBe(true);
  expect(Object.isFrozen(identity.artifact)).toBe(true);
  expect(() => value.resolver.nativeArtifactExecutable({ ...token })).toThrow("invalid-capability");
});

filesystemTest.each(["client", "binary", "qualification", "license", "license-index", "manifest", "extra"] as const)(
  "changed installed %s refuses before any image", async changed => {
    const value = await fixture();
    const path = changed === "client" ? join(value.installed, "src/protocol.ts") : changed === "binary" ? value.binary
      : changed === "qualification" ? value.evidencePath : changed === "license" ? value.licensePath
        : changed === "license-index" ? value.licenseManifestPath : changed === "manifest" ? value.manifestPath
          : join(value.installed, "native-artifacts/unlisted-executable");
    fs.writeFileSync(path, "tampered", { mode: 0o644 });
    expect(() => value.resolver.resolveInstalledNativeArtifact(value.options)).toThrow("admission-failed");
    expect(fs.readdirSync(value.imageRoot)).toEqual([]);
  });

filesystemTest.each(["binary-link", "source-dir-link", "image-root-link", "unsafe-root", "unsafe-client"] as const)(
  "unsafe %s metadata refuses", async changed => {
    const value = await fixture();
    if (changed === "binary-link") {
      const renamed = join(value.root, "binary"); fs.renameSync(value.binary, renamed); fs.symlinkSync(renamed, value.binary);
    } else if (changed === "source-dir-link") {
      const source = join(value.installed, "src"), renamed = join(value.root, "src");
      fs.renameSync(source, renamed); fs.symlinkSync(renamed, source);
    } else if (changed === "image-root-link") {
      const renamed = join(value.root, "images-real"); fs.renameSync(value.imageRoot, renamed); fs.symlinkSync(renamed, value.imageRoot);
    } else if (changed === "unsafe-root") fs.chmodSync(value.imageRoot, 0o755);
    else fs.chmodSync(join(value.installed, "src/protocol.ts"), 0o666);
    expect(() => value.resolver.resolveInstalledNativeArtifact(value.options)).toThrow("admission-failed");
  });

filesystemTest("Bun-style installed hard links are validated by exact bytes and stable metadata", async () => {
  const value = await fixture();
  fs.linkSync(value.binary, join(value.root, "bun-cache-alias"));
  expect(fs.lstatSync(value.binary).nlink).toBe(2);
  const token = value.resolver.resolveInstalledNativeArtifact(value.options);
  expect(fs.readFileSync(value.resolver.nativeArtifactExecutable(token))).toEqual(value.bytes);
});

filesystemTest("supported upgrade can remove the old package while retaining admitted image", async () => {
  const value = await fixture(), token = value.resolver.resolveInstalledNativeArtifact(value.options);
  const path = value.resolver.nativeArtifactExecutable(token);
  fs.rmSync(value.installed, { recursive: true });
  expect(value.resolver.nativeArtifactExecutable(token)).toBe(path);
  expect(fs.readFileSync(path)).toEqual(value.bytes);
  expect(() => value.resolver.resolveInstalledNativeArtifact(value.options)).toThrow();
});

filesystemTest.each(["same-bytes-replacement", "rewrite", "root-replacement", "mode"] as const)(
  "retained token refuses %s and never deletes the image", async changed => {
    const value = await fixture(), token = value.resolver.resolveInstalledNativeArtifact(value.options);
    const path = value.resolver.nativeArtifactExecutable(token);
    if (changed === "same-bytes-replacement") {
      fs.renameSync(path, join(value.root, "retained-old"));
      fs.writeFileSync(path, value.bytes, { mode: 0o500, flag: "wx" });
    } else if (changed === "rewrite") {
      fs.chmodSync(path, 0o700); fs.writeFileSync(path, Buffer.alloc(value.bytes.length)); fs.chmodSync(path, 0o500);
    } else if (changed === "root-replacement") {
      fs.renameSync(value.imageRoot, join(value.root, "old-images"));
      fs.mkdirSync(value.imageRoot, { mode: 0o700 }); fs.writeFileSync(path, value.bytes, { mode: 0o500, flag: "wx" });
    } else fs.chmodSync(path, 0o700);
    expect(() => value.resolver.nativeArtifactExecutable(token)).toThrow("image-changed");
    expect(fs.existsSync(path)).toBe(true);
  });

filesystemTest("a retained crash-after-link alias remains usable without deleting either image name", async () => {
  const value = await fixture(), token = value.resolver.resolveInstalledNativeArtifact(value.options);
  const path = value.resolver.nativeArtifactExecutable(token);
  const staging = join(value.imageRoot, ".native-process-stage-retained");
  fs.mkdirSync(staging, { mode: 0o700 });
  const alias = join(staging, "oompa-process-kernel"); fs.linkSync(path, alias);
  const recovered = value.resolver.resolveInstalledNativeArtifact(value.options);
  expect(value.resolver.nativeArtifactExecutable(recovered)).toBe(path);
  expect(fs.lstatSync(path).nlink).toBe(2);
  expect(fs.existsSync(alias)).toBe(true);
  // A previously captured identity cannot silently ignore even a link change.
  expect(() => value.resolver.nativeArtifactExecutable(token)).toThrow("image-changed");
  fs.chmodSync(path, 0o700); fs.chmodSync(path, 0o500);
  expect(() => value.resolver.nativeArtifactExecutable(recovered)).toThrow("image-changed");
});

filesystemTest("failure after atomic link retains published bytes and permits exact retry", async () => {
  const value = await fixture();
  const original = fs.fsyncSync;
  let calls = 0;
  const mock = spyOn(fs, "fsyncSync").mockImplementation(fd => {
    calls += 1;
    if (calls === 3) throw Error("synthetic root sync failure after link");
    original(fd);
  });
  restores.push(mock);
  expect(() => value.resolver.resolveInstalledNativeArtifact(value.options)).toThrow("admission-failed");
  mock.mockRestore();
  const names = fs.readdirSync(value.imageRoot);
  expect(names).toHaveLength(1);
  const path = join(value.imageRoot, names[0]!);
  expect(fs.readFileSync(path)).toEqual(value.bytes);
  const inode = fs.lstatSync(path, { bigint: true }).ino;
  const token = value.resolver.resolveInstalledNativeArtifact(value.options);
  expect(value.resolver.nativeArtifactExecutable(token)).toBe(path);
  expect(fs.lstatSync(path, { bigint: true }).ino).toBe(inode);
});

filesystemTest.each([true, false])("a publication race compares EEXIST bytes without replacement (matching=%s)", async matching => {
  const value = await fixture(), competitor = join(value.root, "competitor");
  const competitorBytes = matching ? value.bytes : Buffer.alloc(value.bytes.length);
  fs.writeFileSync(competitor, competitorBytes, { mode: 0o500, flag: "wx" });
  const original = fs.linkSync;
  let published: fs.PathLike | undefined;
  const mock = spyOn(fs, "linkSync").mockImplementation((_source, destination) => {
    published = destination;
    original(competitor, destination);
    throw Object.assign(Error("synthetic concurrent no-replace publication"), { code: "EEXIST" });
  });
  restores.push(mock);
  if (matching) {
    const token = value.resolver.resolveInstalledNativeArtifact(value.options);
    expect(published).toBe(value.resolver.nativeArtifactExecutable(token));
  } else expect(() => value.resolver.resolveInstalledNativeArtifact(value.options)).toThrow("admission-failed");
  mock.mockRestore();
  expect(published).toBeDefined();
  expect(fs.readFileSync(published!)).toEqual(competitorBytes);
  expect(fs.lstatSync(published!, { bigint: true }).ino).toBe(fs.lstatSync(competitor, { bigint: true }).ino);
  expect(fs.readdirSync(value.imageRoot)).toHaveLength(1);
});

filesystemTest("a second resolver admitted before staging unlink survives exactly that alias retirement", async () => {
  const value = await fixture();
  const original = fs.linkSync;
  let second: Resolver.AdmittedNativeArtifact | undefined;
  const mock = spyOn(fs, "linkSync").mockImplementation((source, destination) => {
    original(source, destination);
    expect(fs.lstatSync(destination).nlink).toBe(2);
    // B sees A's complete published bytes while A's private staging alias is
    // still present. B does not stage, rewrite, unlink or wait for A.
    second = value.resolver.resolveInstalledNativeArtifact(value.options);
  });
  restores.push(mock);
  const first = value.resolver.resolveInstalledNativeArtifact(value.options);
  mock.mockRestore();
  expect(second).toBeDefined();
  const path = value.resolver.nativeArtifactExecutable(first);
  expect(fs.lstatSync(path).nlink).toBe(1);
  expect(value.resolver.nativeArtifactExecutable(second!)).toBe(path);
  expect(value.resolver.nativeArtifactExecutable(second!)).toBe(path);
  // After consuming the permitted 2→1 observation, changed ctime with the same
  // link count is once again a strict identity refusal.
  fs.chmodSync(path, 0o700); fs.chmodSync(path, 0o500);
  expect(() => value.resolver.nativeArtifactExecutable(second!)).toThrow("image-changed");
});

filesystemTest("alias retirement cannot hide a changed image timestamp", async () => {
  const value = await fixture(), first = value.resolver.resolveInstalledNativeArtifact(value.options);
  const path = value.resolver.nativeArtifactExecutable(first), alias = join(value.root, "retained-staging-alias");
  fs.linkSync(path, alias);
  const second = value.resolver.resolveInstalledNativeArtifact(value.options);
  fs.unlinkSync(alias);
  fs.utimesSync(path, 1, 1);
  expect(() => value.resolver.nativeArtifactExecutable(second)).toThrow("image-changed");
});

filesystemTest("empty target inventory and false trusted pin refuse without an image", async () => {
  const value = await fixture();
  expect(() => value.resolver.resolveInstalledNativeArtifact({ ...value.options, manifestSha256: "f".repeat(64) })).toThrow();
  const bytes = Buffer.from(JSON.stringify({ ...value.manifest, artifacts: [] }));
  fs.writeFileSync(value.manifestPath, bytes);
  expect(() => value.resolver.resolveInstalledNativeArtifact({ ...value.options, manifestSha256: hash(bytes) })).toThrow("unsupported-target");
  expect(fs.readdirSync(value.imageRoot)).toEqual([]);
});
