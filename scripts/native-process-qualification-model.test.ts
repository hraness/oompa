import { expect, test } from "bun:test";
import { NATIVE_QUALIFICATION_HARNESS_FILES, NATIVE_TRANSPORT_CASES, parseNativeQualification } from "./native-process-qualification-model.ts";

const fixture = () => ({ formatVersion: 1, phase: "prepack-native", profile: "native-process-v1-posix-custody", profileVersion: 1,
  source: { commitSha: "a".repeat(40), treeSha256: "b".repeat(64), bunLockSha256: "c".repeat(64), cargoLockSha256: "d".repeat(64),
    toolchainSha256: "e".repeat(64), rustVersion: "1.97.1", bunVersion: "1.3.14", profile: "release" },
  target: "darwin-arm64", rustTarget: "aarch64-apple-darwin", artifact: { bytes: 64, sha256: "f".repeat(64) },
  licensesSha256: "4".repeat(64),
  harnesses: { unit: { bytes: 64, sha256: "1".repeat(64) }, native: { bytes: 128, sha256: "2".repeat(64) },
    fixture: { bytes: 256, sha256: "3".repeat(64) } },
  compiler: { rustcVerboseVersion: "rustc 1.97.1 (synthetic)", cargoVersion: "cargo 1.97.1 (synthetic)",
    bunVersion: "1.3.14", deploymentTarget: "11.0", environmentPolicy: "native-process-build-env-v1",
    linker: { sha256: "0".repeat(64), version: "synthetic linker" }, sdk: { kind: "macos", version: "fixture", buildVersion: "fixture" },
    host: { architecture: "arm64", osRelease: "fixture" } },
  checks: { clippy: "passed", unit: { passed: 6, failed: 0, ignored: 0 }, native: { passed: 20, failed: 0, ignored: 0 },
    transport: [...NATIVE_TRANSPORT_CASES] },
});
test("qualification admission requires every exact suite and target contract", () => {
  expect(parseNativeQualification(fixture()).checks.native.passed).toBe(20);
  for (const change of [
    (value: ReturnType<typeof fixture>) => { value.checks.native.passed = 19; },
    (value: ReturnType<typeof fixture>) => { value.checks.unit.ignored = 1; },
    (value: ReturnType<typeof fixture>) => { value.checks.transport.reverse(); },
    (value: ReturnType<typeof fixture>) => { value.rustTarget = "x86_64-apple-darwin"; },
    (value: ReturnType<typeof fixture>) => { value.compiler.deploymentTarget = "static-musl"; },
    (value: ReturnType<typeof fixture>) => { value.compiler.rustcVerboseVersion = "rustc 1.96.0 (synthetic)"; },
  ]) { const value = fixture(); change(value); expect(() => parseNativeQualification(value)).toThrow(); }
});
test("qualification cannot be applied to another source closure", () => {
  const original = parseNativeQualification(fixture());
  expect(() => parseNativeQualification(fixture(), { ...original.source, treeSha256: "0".repeat(64) })).toThrow("SOURCE_MISMATCH");
  expect(() => parseNativeQualification({ ...fixture(), ungovernedFlag: true })).toThrow();
  expect(() => parseNativeQualification({ ...fixture(), licensesSha256: undefined })).toThrow();
  expect(() => parseNativeQualification({ ...fixture(), licensesSha256: "0".repeat(63) })).toThrow();
});
test("internal harness evidence has three fixed names and strictly bounded immutable identities", () => {
  const original = fixture();
  expect(NATIVE_QUALIFICATION_HARNESS_FILES).toEqual({ unit: "unit-tests", native: "native-tests", fixture: "process-kernel-fixture" });
  expect(parseNativeQualification(original).harnesses).toEqual(original.harnesses);
  for (const key of ["unit", "native", "fixture"] as const) {
    const missing = Object.fromEntries(Object.entries(original.harnesses).filter(([name]) => name !== key));
    expect(() => parseNativeQualification({ ...original, harnesses: missing })).toThrow();
    for (const change of [{ bytes: 63 }, { bytes: 32 * 1024 * 1024 + 1 }, { bytes: 64.5 },
      { sha256: "0".repeat(63) }, { sha256: "F".repeat(64) }, { path: "/foreign/fixture" }]) {
      expect(() => parseNativeQualification({ ...original,
        harnesses: { ...original.harnesses, [key]: { ...original.harnesses[key], ...change } } })).toThrow();
    }
  }
  expect(() => parseNativeQualification({ ...original, harnesses: { ...original.harnesses, extra: original.harnesses.unit } })).toThrow();
});
