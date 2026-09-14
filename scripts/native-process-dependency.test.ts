import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { admitNativeProcessDependency, nativeProcessDependency } from "./native-process-dependency.ts";

test("isolated installation dependency must match the repository's exact locked registry bytes", () => {
  const lock: unknown = Bun.JSONC.parse(readFileSync(join(import.meta.dir, "../bun.lock"), "utf8"));
  expect(() => admitNativeProcessDependency(lock)).not.toThrow();
  for (const entry of [
    ["zod@4.4.3", "", {}, "sha512-" + "A".repeat(88)],
    ["zod@4.4.4", "", {}, nativeProcessDependency.integrity],
    ["zod@4.4.3", "", { dependencies: { injected: "1.0.0" } }, nativeProcessDependency.integrity],
  ]) expect(() => admitNativeProcessDependency({ packages: { zod: entry } })).toThrow();
  expect(() => admitNativeProcessDependency(lock, new Uint8Array())).toThrow();
  expect(() => admitNativeProcessDependency(lock, new Uint8Array([1, 2, 3]))).toThrow();
});
