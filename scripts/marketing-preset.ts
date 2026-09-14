import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { checkMarketingSnapshot } from "../site/vendor/marketing-preset/check.mjs";

/** The shared checker owns inventory/provenance; retain the admitted bytes for this build. */
export async function snapshotMarketingPreset(directory: string) {
  const manifest = await checkMarketingSnapshot(directory);
  const files = new Map<string, Buffer>();
  for (const [path, receipt] of Object.entries(manifest.files)) {
    const details = await lstat(join(directory, path));
    assert.ok(details.isFile() && !details.isSymbolicLink() && details.size > 0 && details.size <= 2 * 1024 * 1024,
      "Marketing preset asset is nonordinary or exceeds its bound.");
    const bytes = await readFile(join(directory, path));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), receipt.sha256,
      "Marketing snapshot changed after admission.");
    files.set(path, bytes);
  }
  return { sourceCommit: manifest.source.commit, files };
}
