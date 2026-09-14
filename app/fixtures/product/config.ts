import assert from "node:assert/strict";
import { dirname, isAbsolute, resolve } from "node:path";
import type { Plugin } from "vite";

/** Replace only IO. Production screens, reducers, markdown, and recipes stay real. */
export const productIoModules = Object.freeze([
  "app/src/appearance.ts",
  "app/src/custody/custody-context.tsx",
  "app/src/data/archived-sessions.ts",
  "app/src/data/automatic-effort.ts",
  "app/src/data/card-order.ts",
  "app/src/data/commands.ts",
  "app/src/data/composer-attachments.ts",
  "app/src/data/device-commands.ts",
  "app/src/data/devices.ts",
  "app/src/data/registry.ts",
  "app/src/data/sent-attachments.ts",
  "app/src/data/session-heads.ts",
  "app/src/data/session-model-hook.ts",
  "app/src/data/usage.ts",
  "app/src/routing/router.ts",
]);

export function productIoPlugin(root: string): Plugin {
  const adapter = resolve(root, "app/fixtures/product/io.ts");
  const allowed = new Set(productIoModules.map((path) => resolve(root, path)));
  const dataRoot = `${resolve(root, "app/src/data")}/`;
  const custodyRoot = `${resolve(root, "app/src/custody")}/`;
  const authRoot = `${resolve(root, "app/src/auth")}/`;
  const appearanceStems = ["appearance", "appearance-entry"].map((name) => resolve(root, "app/src", name));
  return {
    name: "oompa-product-preview-io", enforce: "pre",
    resolveId(source, importer) {
      if (source === "@convex-dev/auth/react") return adapter;
      if (source === "convex" || source.startsWith("convex/") || source.startsWith("@convex-dev/auth/")) {
        throw new Error("Unreplaced live account IO in product example");
      }
      if (importer === undefined || (!source.startsWith(".") && !isAbsolute(source))) return null;
      const candidate = resolve(dirname(importer.split("?")[0] ?? importer), source);
      if ([candidate, `${candidate}.ts`, `${candidate}.tsx`].some((path) => allowed.has(path))) {
        assert.ok(!candidate.includes("/components/") && !candidate.includes("/model/") && !candidate.includes("/screens/"));
        return adapter;
      }
      // Vite strips URL postfixes and maps explicit JS extensions back to TS.
      // Only the exact appearance adapter above may cross this root-level IO seam.
      const appearanceIo = appearanceStems.some((stem) => candidate === stem
        || [".", "?", "#", "/"].some((separator) => candidate.startsWith(`${stem}${separator}`)));
      if (candidate.startsWith(dataRoot) || candidate.startsWith(custodyRoot) || candidate.startsWith(authRoot)
        || appearanceIo) {
        throw new Error("Unmapped application IO in product example");
      }
      return null;
    },
  };
}
