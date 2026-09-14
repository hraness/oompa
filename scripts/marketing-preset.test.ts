import { expect, test } from "bun:test";
import { cp, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { snapshotMarketingPreset } from "./marketing-preset";

const source = fileURLToPath(new URL("../site/vendor/marketing-preset/", import.meta.url));

test("admits the complete immutable marketing snapshot and licensed public font", async () => {
  const snapshot = await snapshotMarketingPreset(source);
  expect(snapshot.sourceCommit).toMatch(/^[a-f0-9]{40}$/u);
  expect(snapshot.files.size).toBe(10);
  expect(snapshot.files.get("fonts/instrument-serif/OFL.txt")!.toString("utf8")).toContain("SIL OPEN FONT LICENSE");
  expect(snapshot.files.get("product-marketing-preset.css")!.toString("utf8")).toContain('data-hraness-marketing-preset="editorial"');
});

test("refuses drift, extra assets, missing assets and symbolic links", async () => {
  for (const mutation of ["drift", "extra", "missing", "symlink"] as const) {
    const directory = await mkdtemp(join(tmpdir(), "marketing-preset-test-"));
    try {
      await cp(source, directory, { recursive: true });
      if (mutation === "drift") await writeFile(join(directory, "product-marketing-preset.css"), "body { color: red; }");
      if (mutation === "extra") await writeFile(join(directory, "extra.svg"), "<svg/>");
      if (mutation === "missing") await rm(join(directory, "marketing-assets/grain.svg"));
      if (mutation === "symlink") {
        await rm(join(directory, "marketing-assets/grain.svg"));
        await symlink(join(source, "marketing-assets/grain.svg"), join(directory, "marketing-assets/grain.svg"));
      }
      await expect(snapshotMarketingPreset(directory)).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});
