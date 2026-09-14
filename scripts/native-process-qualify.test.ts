import { expect, test } from "bun:test";
import { nativeQualificationEnvironment, parseNativeCompiler, parseNativeHarnesses,
  parseNativeLinkerVersion, parseNativeSuite } from "./native-process-qualify.ts";

const bytes = (text: string): Uint8Array => Buffer.from(text);
function suite(count: number): string {
  return `\nrunning ${count} tests\n${Array.from({ length: count }, (_, index) => `test fixture::case${index} ... ok`).join("\n")}\n\ntest result: ok. ${count} passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.12s\n\n`;
}

test("requires exact complete unit and native counts plus unique successful named cases", () => {
  for (const count of [6, 20] as const) expect(parseNativeSuite(bytes(suite(count)), count)).toEqual({ passed: count, failed: 0, ignored: 0 });
  for (const changed of [suite(5), suite(6).replace("case1", "case0"), suite(6).replace("0 ignored", "1 ignored"),
    suite(6).replace("0 filtered out", "1 filtered out"), suite(6).replace("case0 ... ok", "case0 ... FAILED"),
    suite(6) + suite(6), suite(6).replace("running 6 tests", "running 0 tests"), suite(6) + "extra output\n"]) {
    expect(() => parseNativeSuite(bytes(changed), 6)).toThrow("SUITE_INCOMPLETE");
  }
  expect(() => parseNativeSuite(new Uint8Array([255]), 6)).toThrow();
});

const crate = "/fixture/native/process-kernel", targetRoot = "/fixture/build/aarch64-apple-darwin";
function artifacts() {
  return [
    { reason: "compiler-artifact", manifest_path: crate + "/Cargo.toml", profile: { test: true },
      target: { name: "oompa-process-kernel", kind: ["bin"], src_path: crate + "/src/main.rs" }, executable: targetRoot + "/release/deps/unit-abc" },
    { reason: "compiler-artifact", manifest_path: crate + "/Cargo.toml", profile: { test: true },
      target: { name: "native", kind: ["test"], src_path: crate + "/tests/native.rs" }, executable: targetRoot + "/release/deps/native-def" },
    { reason: "compiler-artifact", manifest_path: crate + "/Cargo.toml", profile: { test: false },
      target: { name: "process-kernel-fixture", kind: ["bin"], src_path: crate + "/tests/fixture.rs" }, executable: targetRoot + "/release/process-kernel-fixture" },
  ];
}
const cargoOutput = (values: readonly unknown[]) => bytes([...values, { reason: "build-finished", success: true }].map(value => JSON.stringify(value)).join("\n") + "\n");

test("Cargo locator admits only the exact crate, source, target kind and distinct private-target paths", () => {
  const values = artifacts();
  expect(parseNativeHarnesses(cargoOutput([{ reason: "compiler-message" }, ...values]), crate, targetRoot)).toEqual({
    unit: targetRoot + "/release/deps/unit-abc", native: targetRoot + "/release/deps/native-def", fixture: targetRoot + "/release/process-kernel-fixture",
  });
  for (const changed of [
    values.slice(1), [...values, values[0]],
    values.map((value, index) => index === 0 ? { ...value, executable: "/foreign/unit" } : value),
    values.map((value, index) => index === 0 ? { ...value, executable: targetRoot + "/../unit" } : value),
    values.map((value, index) => index === 0 ? { ...value, manifest_path: "/foreign/Cargo.toml" } : value),
    values.map((value, index) => index === 0 ? { ...value, target: { ...value.target, kind: ["test"] } } : value),
    values.map((value, index) => index === 0 ? { ...value, executable: null } : value),
  ]) expect(() => parseNativeHarnesses(cargoOutput(changed), crate, targetRoot)).toThrow();
  expect(() => parseNativeHarnesses(cargoOutput(values).subarray(0, 10), crate, targetRoot)).toThrow();
  expect(() => parseNativeHarnesses(bytes(Buffer.from(cargoOutput(values)).toString() + '{"reason":"compiler-message"}\n'), crate, targetRoot)).toThrow();
});

test("toolchain parser requires the exact stable release and matching native architecture and OS", () => {
  const rust = bytes("rustc 1.97.1 (synthetic 2026-09-01)\nbinary: rustc\nhost: aarch64-apple-darwin\nrelease: 1.97.1\nLLVM version: 22.1.0\n");
  const cargo = bytes("cargo 1.97.1 (synthetic 2026-09-01)\n");
  expect(parseNativeCompiler(rust, cargo, "darwin-arm64").cargoVersion).toBe("cargo 1.97.1 (synthetic 2026-09-01)");
  for (const target of ["darwin-x64", "linux-arm64", "linux-x64"] as const) expect(() => parseNativeCompiler(rust, cargo, target)).toThrow("TOOLCHAIN_MISMATCH");
  for (const changed of ["1.97.1-nightly", "1.97.0", "1.98.1"]) {
    expect(() => parseNativeCompiler(bytes(Buffer.from(rust).toString().replaceAll("1.97.1", changed)), cargo, "darwin-arm64")).toThrow();
    expect(() => parseNativeCompiler(rust, bytes(Buffer.from(cargo).toString().replace("1.97.1", changed)), "darwin-arm64")).toThrow();
  }
  expect(parseNativeLinkerVersion(bytes("Apple clang version 17.0.0\nInstalledDir: /private/fixture/toolchain\n"))).toBe("Apple clang version 17.0.0");
  expect(() => parseNativeLinkerVersion(bytes("/private/fixture/compiler version\n"))).toThrow();
});

test("build environment is a closed policy with one explicit linker and no ambient flags or credentials", () => {
  const input = { home: "/fixture/home", cargoHome: "/fixture/cargo", rustupHome: "/fixture/rustup", temporary: "/fixture/tmp",
    targetDirectory: "/fixture/target", toolDirectory: "/fixture/tool/bin", rustc: "/fixture/tool/bin/rustc",
    linker: "/fixture/SDK with spaces/bin/clang", sdkRoot: "/fixture/SDK with spaces", target: "darwin-arm64" as const };
  const environment = nativeQualificationEnvironment(input);
  expect(environment.CARGO_ENCODED_RUSTFLAGS).toBe("-C\u001flinker=/fixture/SDK with spaces/bin/clang");
  expect(environment.SDKROOT).toBe(input.sdkRoot); expect(environment.MACOSX_DEPLOYMENT_TARGET).toBe("11.0");
  expect(Object.keys(environment).sort()).toEqual(["CARGO_ENCODED_RUSTFLAGS", "CARGO_HOME", "CARGO_NET_OFFLINE", "CARGO_TARGET_DIR",
    "CARGO_TERM_COLOR", "HOME", "LANG", "LC_ALL", "MACOSX_DEPLOYMENT_TARGET", "PATH", "RUSTC", "RUSTUP_HOME", "RUSTUP_TOOLCHAIN", "SDKROOT", "TEMP", "TMP", "TMPDIR"].sort());
  const { sdkRoot, ...portable } = input;
  expect(environment.SDKROOT).toBe(sdkRoot);
  const linux = nativeQualificationEnvironment({ ...portable, target: "linux-arm64" });
  expect(linux.SDKROOT).toBeUndefined(); expect(linux.MACOSX_DEPLOYMENT_TARGET).toBeUndefined();
  expect(() => nativeQualificationEnvironment({ ...portable, target: "darwin-arm64" })).toThrow("SDK_REQUIRED");
  expect(() => nativeQualificationEnvironment({ ...input, target: "linux-arm64" })).toThrow("SDK_UNEXPECTED");
  expect(() => nativeQualificationEnvironment({ ...input, linker: "/fixture/a\u001fb" })).toThrow("LINKER_INVALID");
});
