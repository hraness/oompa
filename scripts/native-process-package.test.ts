import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NATIVE_CLIENT_FILES } from "../packages/native-process/src/artifact-model.ts";
import { createNativeProcessArchive, inspectNativeProcessArchive } from "./native-process-archive.ts";
import { nativeInputHash } from "./native-process-build-inputs.ts";
import { assembleNativeProcessPackage, inspectQualifiedNativeProcessPackage, type NativePackageAssembly } from "./native-process-package.ts";
import { NATIVE_TRANSPORT_CASES } from "./native-process-qualification-model.ts";

const encode = (value: unknown): Buffer => Buffer.from(JSON.stringify(value) + "\n");
function fixture(): NativePackageAssembly {
  const source = { commitSha: "a".repeat(40), treeSha256: "b".repeat(64), bunLockSha256: "c".repeat(64), cargoLockSha256: "d".repeat(64),
    toolchainSha256: "e".repeat(64), rustVersion: "1.97.1", bunVersion: "1.3.14", profile: "release" } as const;
  const executable = Buffer.alloc(128);
  executable.writeUInt32LE(0xfeedfacf, 0); executable.writeUInt32LE(0x0100000c, 4); executable.writeUInt32LE(2, 12);
  executable.writeUInt32LE(1, 16); executable.writeUInt32LE(8, 20); executable.writeUInt32LE(8, 36);
  const notice = Buffer.from("Synthetic fixture notice; no executable runs.\n");
  const licenses = [{ path: "manifest.json", bytes: encode({ formatVersion: 1, crates: [
    { name: "fixture", version: "1.0.0", license: "MIT", files: [
      { path: "fixture-1.0.0/LICENSE", bytes: notice.length, sha256: nativeInputHash(notice) },
    ] },
  ] }) }, { path: "fixture-1.0.0/LICENSE", bytes: notice }];
  const qualification = encode({ formatVersion: 1, phase: "prepack-native", profile: "native-process-v1-posix-custody", profileVersion: 1,
    source, target: "darwin-arm64", rustTarget: "aarch64-apple-darwin", artifact: { bytes: executable.length, sha256: nativeInputHash(executable) },
    licensesSha256: nativeInputHash(licenses[0]!.bytes),
    harnesses: { unit: { bytes: 64, sha256: "1".repeat(64) }, native: { bytes: 128, sha256: "2".repeat(64) },
      fixture: { bytes: 256, sha256: "3".repeat(64) } },
    compiler: { rustcVerboseVersion: "rustc 1.97.1 (synthetic)", cargoVersion: "cargo 1.97.1 (synthetic)", bunVersion: "1.3.14",
      deploymentTarget: "11.0", environmentPolicy: "native-process-build-env-v1", linker: { sha256: "f".repeat(64), version: "synthetic" },
      sdk: { kind: "macos", version: "fixture", buildVersion: "fixture" }, host: { architecture: "arm64", osRelease: "fixture" } },
    checks: { clippy: "passed", unit: { passed: 6, failed: 0, ignored: 0 }, native: { passed: 20, failed: 0, ignored: 0 },
      transport: NATIVE_TRANSPORT_CASES } });
  return { source, licenses, bundles: [{ executable, qualification }],
    client: [...NATIVE_CLIENT_FILES, "README.md", "LICENSE"].map(path => ({ path,
      bytes: path === "package.json" ? readFileSync(join(import.meta.dir, "../packages/native-process/package.json")) : Buffer.from("synthetic\n") })) };
}

test("one deterministic package binds exact client, notices, native bytes, and qualification evidence", () => {
  const input = fixture();
  const built = assembleNativeProcessPackage(input);
  expect(built.archive).toEqual(assembleNativeProcessPackage(input).archive);
  expect(inspectQualifiedNativeProcessPackage(built.archive)).toEqual(built.manifest);
  expect(built.archiveSha256).toBe(nativeInputHash(built.archive));
  expect(inspectNativeProcessArchive(built.archive).some(file => file.path.endsWith("qualification.json"))).toBe(false);
  expect(inspectNativeProcessArchive(built.archive).some(file => file.path.includes("qualifications/aarch64-apple-darwin.json"))).toBe(true);
  expect(inspectNativeProcessArchive(built.archive).some(file => /(?:unit-tests|native-tests|process-kernel-fixture)$/u.test(file.path))).toBe(false);
});
test("source mismatch, unqualified target and changed executable bytes refuse package creation", () => {
  const input = fixture();
  expect(() => assembleNativeProcessPackage({ ...input, source: { ...input.source, treeSha256: "0".repeat(64) } })).toThrow();
  expect(() => assembleNativeProcessPackage({ ...input, bundles: [] })).toThrow();
  expect(() => assembleNativeProcessPackage({ ...input, bundles: [input.bundles[0]!, input.bundles[0]!] })).toThrow();
  expect(() => assembleNativeProcessPackage({ ...input,
    bundles: [{ ...input.bundles[0]!, executable: Buffer.alloc(128) }] })).toThrow();
});
test("finished archive admission refuses missing notices, injected runtime files and changed bound payloads", () => {
  const built = assembleNativeProcessPackage(fixture());
  const files = inspectNativeProcessArchive(built.archive);
  expect(() => inspectQualifiedNativeProcessPackage(createNativeProcessArchive(files.filter(file => !file.path.endsWith("fixture-1.0.0/LICENSE"))))).toThrow();
  expect(() => inspectQualifiedNativeProcessPackage(createNativeProcessArchive([
    ...files, { path: "package/src/unadmitted.ts", mode: 0o644, bytes: Buffer.from("export {};") },
  ]))).toThrow();
  expect(() => inspectQualifiedNativeProcessPackage(createNativeProcessArchive(files.map(file =>
    file.path.endsWith("src/transport.ts") ? { ...file, bytes: Buffer.from("changed\n") } : file)))).toThrow();
});
test("lifecycle activation and dependency substitution cannot enter the package", () => {
  const input = fixture();
  const original: unknown = JSON.parse(input.client.find(file => file.path === "package.json")!.bytes.toString());
  for (const change of [
    { scripts: { postinstall: "unreviewed-effect" } },
    { dependencies: { zod: "latest" } },
    { bin: { helper: "./native-artifacts/helper" } },
  ]) {
    const client = input.client.map(file => file.path === "package.json"
      ? { ...file, bytes: encode({ ...(original as Record<string, unknown>), ...change }) } : file);
    expect(() => assembleNativeProcessPackage({ ...input, client })).toThrow();
  }
});
