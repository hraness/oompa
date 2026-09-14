import { expect, test } from "bun:test";
import fc from "fast-check";
import { isDeepStrictEqual } from "node:util";

import { assertNativeExecutableHeader, MAX_NATIVE_ARTIFACT_BYTES, NATIVE_ARTIFACT_TARGETS,
  NATIVE_CLIENT_FILES, NativeArtifactError, nativeArtifactTarget, parseNativeArtifactAdmissionOptions,
  parseNativeArtifactManifest, parseNativeLicenseManifest, type NativeArtifact } from "./artifact-model.ts";

const artifact = (target: NativeArtifact["target"]): NativeArtifact => ({
  target, rustTarget: NATIVE_ARTIFACT_TARGETS[target], scope: "posix-process-group", bytes: 128,
  sha256: "a".repeat(64), qualificationProfile: "native-process-v1-posix-custody",
  qualificationVersion: 1, qualificationSha256: "b".repeat(64),
});
function manifest() {
  return { formatVersion: 1, package: "@hraness/native-process", version: "0.1.0", protocolVersion: 1,
    licensesSha256: "c".repeat(64), source: { commitSha: "d".repeat(40), treeSha256: "a".repeat(64),
      bunLockSha256: "b".repeat(64), cargoLockSha256: "c".repeat(64), toolchainSha256: "d".repeat(64),
      rustVersion: "1.97.1", bunVersion: "1.3.14", profile: "release" },
    client: NATIVE_CLIENT_FILES.map(path => ({ path, bytes: 1, sha256: "e".repeat(64) })),
    artifacts: [artifact("darwin-arm64")] };
}
function executable(target: NativeArtifact["target"]): Uint8Array {
  const bytes = new Uint8Array(128), view = new DataView(bytes.buffer);
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

test("manifest snapshots exact source, inventory and fixed qualification contract", () => {
  const raw = manifest(), parsed = parseNativeArtifactManifest(raw);
  expect(isDeepStrictEqual(parsed, raw)).toBe(true);
  raw.source.commitSha = "e".repeat(40);
  expect(parsed.source.commitSha).toBe("d".repeat(40));
  expect(Object.isFrozen(parsed.source)).toBe(true);
  expect(Object.isFrozen(parsed.client[0])).toBe(true);
  expect(Object.isFrozen(parsed.artifacts[0])).toBe(true);
  expect(parseNativeArtifactManifest({ ...manifest(), artifacts: [] }).artifacts).toHaveLength(0);
  expect(nativeArtifactTarget("win32", "x64")).toBeNull();
  expect(nativeArtifactTarget("linux", "arm64")).toBe("linux-arm64");
});

test("manifest rejects missing, repeated, foreign and oversized members", () => {
  const raw = manifest();
  for (const changed of [
    { ...raw, extra: true }, { ...raw, version: "0.2.0" }, { ...raw, licensesSha256: "A".repeat(64) },
    { ...raw, source: { ...raw.source, profile: "debug" } },
    { ...raw, client: [] }, { ...raw, client: [...raw.client].reverse() },
    { ...raw, client: raw.client.map(entry => ({ ...entry, bytes: 1024 * 1024 })) },
    { ...raw, artifacts: [raw.artifacts[0], raw.artifacts[0]] },
    { ...raw, artifacts: [{ ...raw.artifacts[0], rustTarget: "x86_64-apple-darwin" }] },
    { ...raw, artifacts: [{ ...raw.artifacts[0], qualificationVersion: 2 }] },
    { ...raw, artifacts: [{ ...raw.artifacts[0], qualificationProfile: "compiled-only" }] },
    { ...raw, artifacts: [{ ...raw.artifacts[0], bytes: MAX_NATIVE_ARTIFACT_BYTES + 1 }] },
  ]) expect(() => parseNativeArtifactManifest(changed)).toThrow("invalid-manifest");
  const accessor = manifest();
  Object.defineProperty(accessor, "source", { get() { throw Error("getter must not run"); } });
  expect(() => parseNativeArtifactManifest(accessor)).toThrow("invalid-manifest");
  const sparse = manifest(); sparse.artifacts = new Array(1);
  expect(() => parseNativeArtifactManifest(sparse)).toThrow("invalid-manifest");
});

test("licenses require bounded exact unique crate/file inventory and relative safe paths", () => {
  const raw = { formatVersion: 1, crates: [{ name: "libc", version: "0.2.189", license: "MIT OR Apache-2.0",
    files: [{ path: "libc-0.2.189/LICENSE-MIT", bytes: 120, sha256: "a".repeat(64) }] }] };
  expect(isDeepStrictEqual(parseNativeLicenseManifest(raw), raw)).toBe(true);
  for (const path of ["../LICENSE", "/LICENSE", "a/../LICENSE", "a//LICENSE", "manifest.json", "a/b/c/d/e", "a\\LICENSE"]) {
    expect(() => parseNativeLicenseManifest({ ...raw, crates: [{ ...raw.crates[0], files: [{ path, bytes: 1, sha256: "a".repeat(64) }] }] })).toThrow();
  }
  for (const value of [
    { ...raw, crates: [] }, { ...raw, crates: [...raw.crates, ...raw.crates] },
    { ...raw, crates: [{ ...raw.crates[0], files: [] }] },
    { ...raw, crates: [{ ...raw.crates[0], files: [{ path: "LICENSE", bytes: 262145, sha256: "a".repeat(64) }] }] },
  ]) expect(() => parseNativeLicenseManifest(value)).toThrow();
  expect(() => parseNativeArtifactAdmissionOptions({ imageRoot: "/owned", manifestSha256: "a".repeat(64), executable: "/override" })).toThrow();
});

test("headers identify each platform and architecture and refuse dynamic Linux interpreters", () => {
  for (const target of Object.keys(NATIVE_ARTIFACT_TARGETS) as NativeArtifact["target"][]) {
    expect(() => assertNativeExecutableHeader(executable(target), artifact(target))).not.toThrow();
    for (const other of Object.keys(NATIVE_ARTIFACT_TARGETS) as NativeArtifact["target"][]) {
      if (target !== other) expect(() => assertNativeExecutableHeader(executable(target), artifact(other))).toThrow();
    }
  }
  const dynamic = executable("linux-x64"); new DataView(dynamic.buffer).setUint32(64, 3, true);
  expect(() => assertNativeExecutableHeader(dynamic, artifact("linux-x64"))).toThrow("invalid-executable");
  const oversized = executable("darwin-arm64"); new DataView(oversized.buffer).setUint32(36, 0xfffffff8, true);
  expect(() => assertNativeExecutableHeader(oversized, artifact("darwin-arm64"))).toThrow();
});

test("arbitrary native bytes fail closed without leaking DataView or private parser details", () => {
  fc.assert(fc.property(fc.uint8Array({ minLength: 0, maxLength: 512 }), bytes => {
    for (const target of Object.keys(NATIVE_ARTIFACT_TARGETS) as NativeArtifact["target"][]) {
      try { assertNativeExecutableHeader(bytes, { ...artifact(target), bytes: bytes.length }); }
      catch (error) { expect(error).toBeInstanceOf(NativeArtifactError); }
    }
  }), { numRuns: 150 });
});
