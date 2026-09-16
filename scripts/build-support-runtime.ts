import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const commit = "2d034b357680353574411217d68b02b6755b07ed";
const pin = `github:hraness/support-foundation#${commit}`;
const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8")) as { devDependencies?: Record<string, string> };
if (manifest.devDependencies?.["@hraness/support-foundation"] !== pin) throw new Error("Support foundation pin drifted.");
const reviewedInputs = {
  "dist/index.js": "8c80132d2eaa0fcbf91fe9db2a4ece735ced307e629bd411030c8e2d6f9fa3c5",
  "dist/node.js": "e5867b56351d8ebdf3d6a8de3dd8a992dd59aedfde930d1cc96adc806962de95",
  "LICENSE": "74b69bf37c8f340c9c2a54d431a15218738d9c463d0e014fa6a8bb8edce4e539",
};
for (const [path, expected] of Object.entries(reviewedInputs)) {
  const bytes = await readFile(resolve(root, "node_modules/@hraness/support-foundation", path));
  if (createHash("sha256").update(bytes).digest("hex") !== expected) throw new Error(`Support foundation input drifted: ${path}`);
}
const notice = await readFile(resolve(root, "THIRD_PARTY_NOTICES.md"), "utf8");
const license = await readFile(resolve(root, "node_modules/@hraness/support-foundation/LICENSE"), "utf8");
if (!notice.includes(license.trim()) || !notice.includes(commit)) throw new Error("Support foundation attribution drifted.");
const [mode, ...extra] = process.argv.slice(2);
if (extra.length !== 0 || (mode !== "--write" && mode !== "--check")) throw new Error("Use --write or --check.");
const result = await Bun.build({ entrypoints: [resolve(root, "scripts/support-runtime-entry.ts")], target: "bun", format: "esm" });
const [output] = result.outputs;
if (!result.success || result.outputs.length !== 1 || output === undefined) throw new Error("Support foundation bundle failed.");
const bytes = new Uint8Array(await output.arrayBuffer());
const destination = resolve(root, "src/support-runtime.js");
if (mode === "--write") await writeFile(destination, bytes);
else if (!Buffer.from(bytes).equals(await readFile(destination))) throw new Error("Committed support runtime differs from its reviewed build inputs.");
console.log(`Verified CLI-only support runtime (${bytes.byteLength} bytes).`);
