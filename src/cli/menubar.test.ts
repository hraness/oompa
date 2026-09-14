import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { resolveMenubarBinary } from "./menubar";

describe("Oompa menu-bar binary resolution", () => {
  test("accepts private executable files and skips unsafe overrides", () => {
    const directory = mkdtempSync(join(tmpdir(), "oompa-menubar-"));
    const binary = join(directory, "oompa-menubar");
    writeFileSync(binary, "prebuilt", { mode: 0o600 });
    expect(resolveMenubarBinary({ OOMPA_MENUBAR_PATH: binary })).not.toBe(binary);
    chmodSync(binary, 0o755);
    expect(resolveMenubarBinary({ OOMPA_MENUBAR_PATH: binary })).toBe(binary);
    chmodSync(binary, 0o775);
    expect(resolveMenubarBinary({ OOMPA_MENUBAR_PATH: binary })).not.toBe(binary);
  });
});
