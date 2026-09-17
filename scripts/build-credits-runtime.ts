import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const commit = "19b7f04b7bc2f829f8daed0f92ecf604aa6d6142";
const pin = `github:hraness/credits-foundation#${commit}`;
const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8")) as { devDependencies?: Record<string, string> };
if (manifest.devDependencies?.["@hraness/credits-foundation"] !== pin) throw new Error("Credits foundation pin drifted.");
const reviewedInputs = {
  "dist/index.js": "092eae9914ac115b2a9ff3e34ded6e9edc758f7a07141f55ef8adfc67602d20d",
  "dist/node.js": "6cfab8a5f16f2b830b7916e01879a250a6dceb1719f00032b396ffb465280d08",
  "dist/server.js": "d958c7e87ea1eb6d3795104bb89df7bc95514b16ab09d42d432e1e425c9f8918",
  "LICENSE": "74b69bf37c8f340c9c2a54d431a15218738d9c463d0e014fa6a8bb8edce4e539",
};
for (const [path, expected] of Object.entries(reviewedInputs)) {
  const bytes = await readFile(resolve(root, "node_modules/@hraness/credits-foundation", path));
  if (createHash("sha256").update(bytes).digest("hex") !== expected) throw new Error(`Credits foundation input drifted: ${path}`);
}
const notice = await readFile(resolve(root, "THIRD_PARTY_NOTICES.md"), "utf8");
const license = await readFile(resolve(root, "node_modules/@hraness/credits-foundation/LICENSE"), "utf8");
if (!notice.includes(license.trim()) || !notice.includes(commit)) throw new Error("Credits foundation attribution drifted.");
const [mode, ...extra] = process.argv.slice(2);
if (extra.length !== 0 || (mode !== "--write" && mode !== "--check")) throw new Error("Use --write or --check.");
const result = await Bun.build({ entrypoints: [resolve(root, "scripts/credits-runtime-entry.ts")], target: "bun", format: "esm" });
const [output] = result.outputs;
if (!result.success || result.outputs.length !== 1 || output === undefined) throw new Error("Credits foundation bundle failed.");
const bytes = new Uint8Array(await output.arrayBuffer());
const destination = resolve(root, "src/credits-runtime.js");
if (mode === "--write") await writeFile(destination, bytes);
else if (!Buffer.from(bytes).equals(await readFile(destination))) throw new Error("Committed credits runtime differs from its reviewed build inputs.");
console.log(`Verified CLI-only credits runtime (${bytes.byteLength} bytes).`);
