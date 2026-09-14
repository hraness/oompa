import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import type { Plugin } from "vite";

/** Closed IO-only replacement list, shared with the runner's receipt. */
export const browserIoModules = Object.freeze([
  "app/src/custody/custody-context.tsx",
  "app/src/data/archived-sessions.ts",
  "app/src/data/commands.ts",
  "app/src/data/device-commands.ts",
  "app/src/data/devices.ts",
  "app/src/data/registry.ts",
  "app/src/data/session-heads.ts",
  "app/src/data/session-model-hook.ts",
  "app/src/data/usage.ts",
]);

export function browserIoPlugin(root: string): Plugin {
  const adapter = resolve(root, "app/fixtures/browser/io.ts");
  const allowed = new Set(browserIoModules.map((path) => resolve(root, path)));
  return {
    name: "oompa-browser-fixture-io", enforce: "pre",
    resolveId(source, importer) {
      if (source === "@convex-dev/auth/react") return adapter;
      if (source === "convex/react") throw new Error("Unreplaced live Convex IO in browser fixture");
      if (importer === undefined || !source.startsWith(".")) return null;
      const candidate = resolve(dirname(importer.split("?")[0] ?? importer), source);
      if (![candidate, `${candidate}.ts`, `${candidate}.tsx`].some((path) => allowed.has(path))) return null;
      assert.ok(!candidate.includes("/components/") && !candidate.includes("/model/") && !candidate.includes("/screens/"));
      return adapter;
    },
  };
}
