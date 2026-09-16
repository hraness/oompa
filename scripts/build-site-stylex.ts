import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  artifactForFile, compilerSha256, createStylexGeneration, finalizeStylexGeneration,
  prepareStylexProducedTemplate, sealStylexProducedTemplate, stylexUnionPolicySha256,
  STYLEX_TEMPLATE_CSS_PLACEHOLDER,
} from "@hraness/ui/stylex-build";
import { collectBunStylexGraph } from "@hraness/ui/stylex-build/bun";
import { stylexVite } from "@hraness/ui/stylex-build/vite";
import { build as viteBuild } from "vite";
import { z } from "zod";

const routes = [
  "index.html", "privacy/index.html", "preview/index.html",
  "docs/index.html", "docs/start/index.html", "docs/web/index.html",
  "docs/sessions/index.html", "docs/reference/index.html", "docs/status/index.html",
  "pr/index.html",
] as const;
const docsRoutes = ["/docs/", "/docs/start/", "/docs/web/", "/docs/sessions/", "/docs/reference/", "/docs/status/"] as const;
const hash = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");
const sha = z.string().regex(/^[a-f0-9]{64}$/u);
const logicalPath = z.string().min(1).max(1024).refine((value) =>
  value.split("/").every((part) => part !== "." && part !== ".." && /^[A-Za-z0-9_.[\]-]+$/u.test(part)), "Unsafe static graph path");
const artifact = z.object({ bytes: z.number().int().min(0).max(16 * 1024 * 1024), path: logicalPath, sha256: sha }).strict();
const completeSchema = z.object({
  artifacts: z.array(artifact).min(5).max(128), compilerSha256: z.literal(compilerSha256),
  finalCss: artifact, generationId: z.literal("hra-static-site"),
  graphs: z.array(z.object({ id: z.enum(["foundation", "renderer"]), receiptSha256: sha }).strict()).length(2),
  kind: z.literal("hraness-stylex-complete-generation"),
  packages: z.array(z.object({ manifestSha256: sha, name: z.string(), version: z.string() }).strict()).length(3),
  planSha256: sha, schemaVersion: z.literal(2), state: z.literal("complete"),
  unionPolicySha256: z.literal(stylexUnionPolicySha256),
}).strict();

type SiteArtifact = z.infer<typeof artifact>;
type SiteFoundation = Readonly<{ cssPath: string; privateEntryPath: string; artifacts: readonly SiteArtifact[] }>;

function record(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
}

/** Read Vite's actual RollupOutput, never a guessed staging inventory.
 * Vite's single-stylesheet mode requires a JavaScript entry importing CSS.
 * Its one empty entry stays bound to the graph but is never published. */
export function snapshotSiteFoundation(value: unknown, expectedFontHashes: readonly string[], expectedEntrySource: string, expectedImageHashes: readonly string[]): SiteFoundation {
  assert.ok(isAbsolute(expectedEntrySource), "Static foundation entry identity must be absolute");
  const outputs = Array.isArray(value) ? value : [value];
  assert.equal(outputs.length, 1, "Static foundation must have one Rollup output");
  const output = record(outputs[0]).output;
  assert.ok(Array.isArray(output) && output.length === 18, "Static foundation must emit one empty entry, one CSS file, fourteen WOFF2 files and two exact preset SVGs");
  let privateEntryPath: string | undefined;
  const artifacts = output.map((value): SiteArtifact => {
    const item = record(value);
    assert.ok(typeof item.fileName === "string");
    if (item.type === "chunk") {
      assert.equal(privateEntryPath, undefined, "Static foundation must have exactly one private entry");
      assert.equal(item.isEntry, true);
      assert.equal(item.isDynamicEntry, false);
      assert.equal(item.facadeModuleId, expectedEntrySource);
      assert.match(item.fileName, /^assets\/foundation-[A-Za-z0-9_-]+\.js$/u);
      for (const field of ["imports", "dynamicImports", "exports", "referencedFiles"]) assert.deepEqual(item[field], []);
      assert.ok(item.code === "" || item.code === "\n", "Static foundation entry must contain no executable code");
      assert.equal(item.map, null, "Static foundation entry must not carry a source map");
      privateEntryPath = item.fileName;
      return artifact.parse({ path: item.fileName, bytes: Buffer.byteLength(item.code), sha256: hash(item.code) });
    }
    assert.equal(item.type, "asset", "Unexpected static foundation output type");
    assert.match(item.fileName, /^assets\/[A-Za-z0-9_.[\]-]+\.(?:css|woff2|svg)$/u);
    assert.ok(typeof item.source === "string" || item.source instanceof Uint8Array);
    const bytes = typeof item.source === "string" ? Buffer.byteLength(item.source) : item.source.byteLength;
    assert.ok(bytes <= 16 * 1024 * 1024, "Static foundation asset exceeded its bound");
    return artifact.parse({ path: item.fileName, bytes, sha256: hash(item.source) });
  }).sort((a, b) => a.path.localeCompare(b.path));
  assert.ok(privateEntryPath !== undefined, "Static foundation entry was not captured");
  assert.equal(new Set(artifacts.map(({ path }) => path)).size, artifacts.length);
  const css = artifacts.filter(({ path }) => path.endsWith(".css"));
  assert.equal(css.length, 1, "Static site must have one complete foundation");
  assert.equal(expectedFontHashes.length, 14, "Static site font scope changed");
  expectedFontHashes.forEach((value) => sha.parse(value));
  assert.deepEqual(
    artifacts.filter(({ path }) => path.endsWith(".woff2")).map(({ sha256 }) => sha256).sort(),
    [...expectedFontHashes].sort(),
    "Compiled fonts differ from the complete approved WOFF2 inventory",
  );
  assert.equal(expectedImageHashes.length, 2, "Static marketing field scope changed");
  expectedImageHashes.forEach((value) => sha.parse(value));
  assert.deepEqual(
    artifacts.filter(({ path }) => path.endsWith(".svg")).map(({ sha256 }) => sha256).sort(),
    [...expectedImageHashes].sort(),
    "Compiled marketing field differs from the exact approved SVG inventory",
  );
  assert.ok(css[0] !== undefined);
  return { cssPath: `graphs/foundation/${css[0].path}`, privateEntryPath, artifacts };
}

/** The completed public projection is closed independently of renderer output.
 * Every foundation byte must also match the captured RollupOutput identity. */
export function projectSiteArtifacts(value: unknown, planSha256: string, foundation: SiteFoundation, capturedFinalCss: SiteArtifact): readonly SiteArtifact[] {
  const complete = completeSchema.parse(value);
  assert.equal(complete.planSha256, sha.parse(planSha256));
  assert.deepEqual(complete.graphs.map(({ id }) => id).sort(), ["foundation", "renderer"]);
  assert.deepEqual(complete.packages.map(({ name }) => name).sort(), ["@hraness/design-kit", "@hraness/site-footer", "@hraness/ui"]);
  assert.equal(complete.finalCss.path, "stylex.css");
  assert.deepEqual(complete.finalCss, artifact.parse(capturedFinalCss), "Final union differs from its completed on-disk bytes");
  // The public completion protocol records finalCss separately from graph and
  // template artifacts. Join it exactly once at the publication boundary.
  const completedArtifacts = [...complete.artifacts, complete.finalCss];
  assert.equal(new Set(completedArtifacts.map(({ path }) => path)).size, completedArtifacts.length);
  assert.ok(completedArtifacts.reduce((sum, item) => sum + item.bytes, 0) <= 64 * 1024 * 1024);
  const captured = foundation.artifacts.map((item) => ({ ...item, path: `graphs/foundation/${item.path}` }));
  assert.deepEqual(
    complete.artifacts.filter(({ path }) => path.startsWith("graphs/foundation/")).sort((a, b) => a.path.localeCompare(b.path)),
    captured,
    "Completed foundation differs from its captured Rollup output",
  );
  const privateEntry = `graphs/foundation/${foundation.privateEntryPath}`;
  assert.ok(captured.some(({ path }) => path === privateEntry));
  const publicFoundation = captured.filter(({ path }) => path !== privateEntry);
  const allowed = new Set([...routes, "stylex.css", ...publicFoundation.map(({ path }) => path)]);
  const projected = completedArtifacts.filter(({ path }) => {
    if (allowed.has(path)) return true;
    if (path === privateEntry) return false;
    assert.match(path, /^graphs\/renderer\/(?:entries|chunks)\/[A-Za-z0-9_.-]+\.js$/u, "Unexpected static generation output");
    return false;
  });
  assert.equal(projected.length, routes.length + 1 + publicFoundation.length);
  for (const path of allowed) assert.ok(projected.some((item) => item.path === path));
  return projected;
}

/** Join the exact built renderer to its captured foundation and final union.
 * The public compiler subsequently checks native HTML topology and link order. */
export function prepareSiteDocument(html: string, foundationPath: string): string {
  assert.ok(html.length > 0 && Buffer.byteLength(html) <= 8 * 1024 * 1024);
  assert.match(foundationPath, /^graphs\/foundation\/(?:entries|assets)\/[A-Za-z0-9_.-]+\.css$/u);
  const link = '<link rel="stylesheet" href="/styles.css">';
  assert.equal(html.split(link).length - 1, 1, "Static renderer must own one stylesheet join");
  assert.ok(!html.includes(STYLEX_TEMPLATE_CSS_PLACEHOLDER));
  assert.ok(!/<style\b|\sstyle\s*=/iu.test(html), "Static renderer emitted inline presentation");
  return html.replace(link, `<link rel="stylesheet" href="/${foundationPath}">\n<link rel="stylesheet" href="${STYLEX_TEMPLATE_CSS_PLACEHOLDER}">`);
}

/** Admit only the closed captured renderer surface, never an arbitrary path map. */
export function captureSiteDocuments(value: unknown): ReadonlyMap<string, string> {
  const renderers = record(value);
  const documents = new Map<string, string>();
  for (const [index, name] of ["renderSiteHtml", "renderPrivacyHtml", "renderPreviewHtml"].entries()) {
    const render: unknown = Object.getOwnPropertyDescriptor(renderers, name)?.value;
    const path = routes[index];
    assert.ok(typeof render === "function" && path !== undefined, "Captured renderer export changed");
    const html = (render as (content: undefined) => unknown)(undefined);
    assert.equal(typeof html, "string", "Static renderer must return an HTML string");
    documents.set(path, html as string);
  }
  const renderDocs: unknown = Object.getOwnPropertyDescriptor(renderers, "renderDocsPages")?.value;
  assert.ok(typeof renderDocs === "function", "Captured documentation renderer export changed");
  const docs = record((renderDocs as () => unknown)());
  assert.equal(Object.getPrototypeOf(docs), Object.prototype, "Documentation renderer must return an ordinary route map");
  const descriptors = Object.getOwnPropertyDescriptors(docs);
  assert.deepEqual(Reflect.ownKeys(descriptors).sort(), [...docsRoutes].sort(), "Documentation renderer routes changed");
  for (const route of docsRoutes) {
    const descriptor = descriptors[route];
    assert.ok(descriptor !== undefined && "value" in descriptor && descriptor.enumerable, "Documentation routes must be own data fields");
    assert.equal(typeof descriptor.value, "string", "Documentation renderer must return HTML strings");
    documents.set(`${route.slice(1)}index.html`, descriptor.value as string);
  }
  const renderPr: unknown = Object.getOwnPropertyDescriptor(renderers, "renderPrHtml")?.value;
  assert.ok(typeof renderPr === "function", "Captured Puerto Rico renderer export changed");
  const prHtml = (renderPr as (content: undefined) => unknown)(undefined);
  assert.equal(typeof prHtml, "string", "Puerto Rico renderer must return an HTML string");
  documents.set("pr/index.html", prHtml as string);
  assert.deepEqual([...documents.keys()], [...routes]);
  return documents;
}

export type SiteStylexOutput = Readonly<{
  evidenceDirectory: string;
  files: ReadonlyMap<string, Buffer>;
}>;

/** Build-time SSR only. No renderer JavaScript, source map, graph receipt or
 * package provenance is copied to the static host. Failed generations remain
 * in the task's ignored build directory for diagnosis. */
export async function buildSiteStylex(options: Readonly<{
  sourceRoot: string;
  fonts: readonly Readonly<{ path: string; bytes: Uint8Array }>[];
  images: readonly Readonly<{ path: string; bytes: Uint8Array }>[];
}>): Promise<SiteStylexOutput> {
  const root = await realpath(options.sourceRoot);
  const temporaryRoot = join(root, "tmp");
  await mkdir(temporaryRoot, { recursive: true });
  const run = await mkdtemp(join(temporaryRoot, "site-stylex-"));
  const outputDirectory = join(run, "complete");
  const generation = await createStylexGeneration({
    expectedGraphs: [
      { adapter: "vite", entrypoints: ["site/foundation.ts"], id: "foundation", kind: "client" },
      { adapter: "bun", entrypoints: ["site/render.ts"], id: "renderer", kind: "ssr" },
    ],
    finalCssPath: "stylex.css", generationId: "hra-static-site", outputDirectory,
    packageManifests: ["@hraness/ui", "@hraness/design-kit", "@hraness/site-footer"]
      .map((name) => Bun.resolveSync(`${name}/stylex-manifest.json`, root)),
    rootDirectory: root,
    templates: routes.map((path) => ({
      cssHref: "/stylex.css", graphId: "renderer", outputPath: path,
      sourcePath: path, stylesheetGraphId: "foundation",
    })),
  });
  const expectedFonts = options.fonts.filter(({ path }) => path.endsWith(".woff2")).map(({ bytes }) => hash(bytes)).sort();
  const foundation = snapshotSiteFoundation(await viteBuild({
    // The public adapter owns root, inputs, output and assetsInlineLimit: 0.
    // Relative URLs survive the finalized graphs/foundation/ projection.
    base: "./", configFile: false, envFile: false, mode: "production",
    plugins: [stylexVite({ generation, graphId: "foundation", rootDirectory: root })],
  }), expectedFonts, join(root, "site/foundation.ts"), options.images.map(({ bytes }) => hash(bytes)).sort());
  const foundationPath = foundation.cssPath;
  const renderer = await collectBunStylexGraph({
    build: { minify: true, sourcemap: "none" }, generation, graphId: "renderer", rootDirectory: root,
  });
  const entries = renderer.outputs.filter(({ path }) => /^entries\/render-[A-Za-z0-9_-]+\.js$/u.test(path));
  assert.equal(entries.length, 1, "Static renderer must have one captured entry");
  const entry = entries[0];
  assert.ok(entry !== undefined);
  const rendererRoot = join(generation.directory, renderer.outputRoot);
  assert.deepEqual(await artifactForFile(rendererRoot, entry.path), entry);
  const module: unknown = await import(pathToFileURL(join(rendererRoot, entry.path)).href);
  for (const [path, html] of captureSiteDocuments(module)) {
    const prepared = await prepareStylexProducedTemplate(generation, path);
    await writeFile(prepared.sourcePath, prepareSiteDocument(html, foundationPath), { flag: "wx", mode: 0o644 });
    await sealStylexProducedTemplate(generation, path);
  }
  const completedDirectory = await finalizeStylexGeneration({ generation, outputDirectory, rootDirectory: root });
  assert.equal(completedDirectory, join(outputDirectory, "hra-static-site"));
  const projected = projectSiteArtifacts(
    JSON.parse(await readFile(join(completedDirectory, "stylex-complete.json"), "utf8")) as unknown,
    generation.planSha256, foundation, await artifactForFile(completedDirectory, "stylex.css"),
  );
  const files = new Map<string, Buffer>();
  for (const item of projected) {
    assert.deepEqual(await artifactForFile(completedDirectory, item.path), item);
    const bytes = await readFile(join(completedDirectory, item.path));
    assert.equal(bytes.byteLength, item.bytes);
    assert.equal(hash(bytes), item.sha256);
    files.set(item.path, bytes);
  }
  return { evidenceDirectory: run, files };
}
