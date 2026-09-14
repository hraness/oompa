import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertNativeCargoConfigurationAbsent, nativeBuildInput } from "./native-process-build-inputs.ts";

test("native input reads are bounded and refuse symbolic aliases", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "native-build-input-")));
  try {
    const path = join(root, "input"); writeFileSync(path, "abc");
    expect(nativeBuildInput(path, 3).toString()).toBe("abc");
    expect(() => nativeBuildInput(path, 2)).toThrow("INPUT_INVALID");
    symlinkSync(path, join(root, "alias"));
    expect(() => nativeBuildInput(join(root, "alias"))).toThrow("INPUT_PATH_INVALID");
  } finally { rmSync(root, { recursive: true }); }
});
test("Cargo configuration is refused in crate, ancestor, and home without following config links", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "native-cargo-config-")));
  const crate = join(root, "project", "native"), home = join(root, "cargo-home");
  mkdirSync(crate, { recursive: true }); mkdirSync(home);
  try {
    assertNativeCargoConfigurationAbsent(crate, home);
    for (const directory of [join(crate, ".cargo"), join(root, "project", ".cargo"), home]) {
      mkdirSync(directory, { recursive: true });
      for (const name of ["config", "config.toml"]) {
        const path = join(directory, name); symlinkSync(join(root, "missing"), path);
        expect(() => assertNativeCargoConfigurationAbsent(crate, home)).toThrow("AMBIENT_CARGO_CONFIG");
        rmSync(path);
      }
    }
  } finally { rmSync(root, { recursive: true }); }
});
