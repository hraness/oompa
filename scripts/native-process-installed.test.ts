import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { createNativeProcessArchive } from "./native-process-archive.ts";
import { nativeInputHash } from "./native-process-build-inputs.ts";
import { nativeProcessDependency } from "./native-process-dependency.ts";
import { NATIVE_TRANSPORT_CASES } from "./native-process-qualification-model.ts";
import { assertNativeInstalledDriver, assertNativeInstalledLock, inspectNativeInstalledDependency,
  nativeInstalledPackageJson, nativeInstalledReceiptSchema, nativeInstalledWorkerResultSchema } from "./native-process-installed-model.ts";
import { inspectNativeInstalledTree } from "./native-process-installed.ts";

function localLock() {
  const manifest = nativeInstalledPackageJson();
  return { lockfileVersion: 1, configVersion: 1,
    workspaces: { "": { name: manifest.name, dependencies: manifest.dependencies } }, overrides: manifest.overrides,
    packages: { "@hraness/native-process": ["@hraness/native-process@file:./native.tgz", { dependencies: { zod: "4.4.3" } }],
      zod: ["zod@file:./zod.tgz", {}] } };
}
test("local graph freezes exactly two admitted tarballs with lifecycle trust empty", () => {
  expect(() => assertNativeInstalledLock(localLock())).not.toThrow();
  expect(nativeInstalledPackageJson().trustedDependencies).toEqual([]);
  for (const packages of [
    { ...localLock().packages, unexpected: ["unexpected@1.0.0", {}] },
    { ...localLock().packages, zod: ["zod@https://registry.invalid/zod.tgz", {}] },
    { ...localLock().packages, zod: ["zod@file:./zod.tgz", { dependencies: { unexpected: "1.0.0" } }] },
    { ...localLock().packages, zod: ["zod@file:../zod.tgz", {}] },
  ]) expect(() => assertNativeInstalledLock({ ...localLock(), packages })).toThrow();
  expect(() => assertNativeInstalledLock({ ...localLock(), overrides: {} })).toThrow();
});

function dependency(manifest: unknown = { name: "zod", version: "4.4.3" }) {
  return createNativeProcessArchive([
    { path: "package/package.json", mode: 0o644, bytes: Buffer.from(JSON.stringify(manifest)) },
    { path: "package/index.js", mode: 0o644, bytes: Buffer.from("export {};\n") },
  ]);
}
test("dependency inventory is bounded and rejects transitive graphs before installation", () => {
  expect(inspectNativeInstalledDependency(dependency()).map(file => file.path)).toEqual(["index.js", "package.json"]);
  for (const manifest of [{ name: "zod", version: "4.4.2" }, { name: "different", version: "4.4.3" },
    { name: "zod", version: "4.4.3", dependencies: { unexpected: "1" } },
    { name: "zod", version: "4.4.3", optionalDependencies: { unexpected: "1" } },
    { name: "zod", version: "4.4.3", bin: { zod: "./index.js" } }]) {
    expect(() => inspectNativeInstalledDependency(dependency(manifest))).toThrow();
  }
  expect(() => inspectNativeInstalledDependency(dependency().subarray(0, 10))).toThrow();
  expect(() => inspectNativeInstalledDependency(createNativeProcessArchive([
    { path: "package/package.json", mode: 0o644, bytes: Buffer.alloc(1024 * 1024 + 1) },
  ]))).toThrow();
});

test("unchanged installed drivers have closed runtime imports and no source-package fallback", () => {
  const verifier = readFileSync(join(import.meta.dir, "../native/process-kernel/verify-transport.ts"));
  const worker = readFileSync(join(import.meta.dir, "native-process-installed-worker.ts"));
  expect(() => assertNativeInstalledDriver(verifier, "verifier")).not.toThrow();
  expect(() => assertNativeInstalledDriver(worker, "worker")).not.toThrow();
  for (const text of ["import { x } from '../packages/native-process/src/index.ts';", "import('unbounded');",
    "import { x } from '@hraness/native-process/transport';", "import fs from 'node:fs'; eval('x');"]) {
    expect(() => assertNativeInstalledDriver(Buffer.from(text), "verifier")).toThrow();
  }
});

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true }); });
function installed() {
  const root = mkdtempSync(join(process.cwd(), ".native-installed-test-")); roots.push(root);
  chmodSync(root, 0o700);
  const expected = [{ path: "zod/package.json", bytes: Buffer.from('{"name":"zod","version":"4.4.3"}'), mode: 0o644 }];
  for (const file of expected) {
    const path = join(root, file.path); mkdirSync(dirname(path), { mode: 0o700 });
    writeFileSync(path, file.bytes); chmodSync(path, file.mode);
  }
  return { root, expected };
}
test("installed file tree must match every admitted member with exact modes and no extra files", () => {
  const value = installed();
  const files = inspectNativeInstalledTree(value.root, value.expected);
  expect(files.length).toBe(1); expect(files[0]!.sha256).toBe(nativeInputHash(value.expected[0]!.bytes));
  writeFileSync(join(value.root, "extra"), "unexpected");
  expect(() => inspectNativeInstalledTree(value.root, value.expected)).toThrow();
});
test.each(["mode", "bytes", "symlink", "directory"] as const)("installed %s drift refuses before loading any module", change => {
  const value = installed(), path = join(value.root, "zod/package.json");
  if (change === "mode") chmodSync(path, 0o755);
  else if (change === "bytes") writeFileSync(path, "changed");
  else if (change === "symlink") { rmSync(path); symlinkSync(join(value.root, "missing"), path); }
  else mkdirSync(join(value.root, "unexpected"));
  expect(() => inspectNativeInstalledTree(value.root, value.expected)).toThrow();
});

const sha = "a".repeat(64);
const source = { commitSha: "b".repeat(40), treeSha256: sha, bunLockSha256: sha, cargoLockSha256: sha,
  toolchainSha256: sha, rustVersion: "1.97.1", bunVersion: "1.3.14", profile: "release" } as const;
const image = { device: "1", inode: "2", uid: "501", gid: "20", mode: 0o500, bytes: 128, sha256: sha } as const;
function receipt() {
  const executable = { bytes: 128, sha256: sha };
  return { formatVersion: 1, phase: "installed-native", profile: "native-process-v1-posix-custody", profileVersion: 1,
    source, target: "darwin-arm64", rustTarget: "aarch64-apple-darwin", artifact: executable,
    harnesses: { unit: executable, native: executable, fixture: executable }, archiveSha256: sha, manifestSha256: sha,
    prepackSha256: sha, verifierSha256: sha, workerSha256: sha,
    dependency: { name: "zod", version: "4.4.3", integrity: nativeProcessDependency.integrity, archiveSha256: sha, inventorySha256: sha },
    bun: { version: "1.3.14", sha256: sha }, installation: { localLockSha256: sha, clientInventorySha256: sha, image },
    checks: { unit: { passed: 6, failed: 0, ignored: 0 }, native: { passed: 20, failed: 0, ignored: 0 }, transport: NATIVE_TRANSPORT_CASES } };
}
test("outer receipt keeps prepack and installed proof separate and refuses incomplete acceptance", () => {
  expect(nativeInstalledReceiptSchema.parse(receipt()).prepackSha256).toBe(sha);
  for (const changed of [{ ...receipt(), artifact: { bytes: 129, sha256: sha } },
    { ...receipt(), checks: { ...receipt().checks, unit: { passed: 5, failed: 0, ignored: 0 } } },
    { ...receipt(), checks: { ...receipt().checks, transport: [...NATIVE_TRANSPORT_CASES].reverse() } },
    { ...receipt(), claimedPublication: true }]) expect(() => nativeInstalledReceiptSchema.parse(changed)).toThrow();
  const worker = { version: 1, mode: "admit", manifestSha256: sha, target: "darwin-arm64", image,
    client: Array.from({ length: 11 }, (_, index) => ({ path: String(index), bytes: 1, sha256: sha })), cases: [], fixtureSha256: sha };
  expect(() => nativeInstalledWorkerResultSchema.parse(worker)).not.toThrow();
  expect(() => nativeInstalledWorkerResultSchema.parse({ ...worker, mode: "transport" })).toThrow();
});
