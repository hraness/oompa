import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { copyFile, cp, lstat, mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";
import { DIRECT_WIRE_MARKERS } from "@hraness/direct/tooling/bundle-boundary";

import {
  publicContent,
  renderLlmsText,
  renderPrivacyMarkdown,
  renderSitemapXml,
} from "../site/content.ts";
import { docsPaths, renderDocsMarkdown } from "../site/docs-content.ts";
import {
  renderSocialCardPng,
  renderSocialCardSvg,
  SOCIAL_CARD_HEIGHT,
  SOCIAL_CARD_WIDTH,
} from "../site/social-card.ts";
import { readPngDimensions } from "../site/social-card-raster.ts";
import { buildSiteStylex } from "./build-site-stylex.ts";
import { buildProductPreview } from "./build-product-preview.ts";
import { OOMPA_RELEASE_VERSION } from "./release-evidence";
import { buildOompaAppearance } from "./build-appearance";
import { snapshotMarketingPreset } from "./marketing-preset";
import { checkLanternMaterialSnapshot } from "../site/vendor/lantern-material/check.mjs";

interface BuildOptions {
  readonly check: boolean;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly releaseCommit?: string;
  readonly repositoryRoot: string;
  /** Explicit source checkout when a test isolates only its publication tree. */
  readonly sourceRoot?: string;
}

interface TextOutput {
  readonly content: string;
  readonly path: string;
}

const emptyBuildEnvironment: Readonly<Record<string, string | undefined>> =
  Object.freeze({});

const withFinalNewline = (value: string): string =>
  value.endsWith("\n") ? value : `${value}\n`;

const packageManifestSchema = z.object({
  version: z.string().regex(/^0\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u),
}).passthrough();

/**
 * The hosted identity marker carries the fixed release-evidence identity
 * version that the canonical-alias operator proves after every cutover, not
 * the package version. The package version is read for other generated
 * surfaces.
 */
export const readPackageVersion = async (
  repositoryRoot: string = resolve(import.meta.dir, ".."),
): Promise<string> => {
  const manifest: unknown = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
  return packageManifestSchema.parse(manifest).version;
};

export const OOMPA_POSTHOG_PROJECT_TOKEN_ENV =
  "NEXT_PUBLIC_POSTHOG_KEY" as const;

const postHogProjectTokenPattern = /^phc_[A-Za-z0-9_-]{8,512}$/u;

export function resolveOompaAnalyticsProjectToken(
  environment: Readonly<Record<string, string | undefined>>,
): string {
  if (environment.VERCEL_ENV !== "production") return "";

  const projectToken = environment[OOMPA_POSTHOG_PROJECT_TOKEN_ENV]?.trim();
  if (projectToken === undefined || projectToken.length === 0) {
    throw new Error(
      `${OOMPA_POSTHOG_PROJECT_TOKEN_ENV} must be configured for Vercel Production.`,
    );
  }
  if (!postHogProjectTokenPattern.test(projectToken)) {
    throw new Error(
      `${OOMPA_POSTHOG_PROJECT_TOKEN_ENV} must be a valid public phc_ project token.`,
    );
  }
  return projectToken;
}

const trackedTextOutputs = (repositoryRoot: string): readonly TextOutput[] => [
  {
    path: join(repositoryRoot, "PRIVACY.md"),
    content: renderPrivacyMarkdown(),
  },
];

const siteTextOutputs = (
  repositoryRoot: string,
  releaseCommit: string,
): readonly TextOutput[] => [
  ...docsPaths.map((path) => ({
    path: join(repositoryRoot, "dist/site", path.slice(1), "index.md"),
    content: renderDocsMarkdown(path),
  })),
  {
    path: join(repositoryRoot, "dist/site/robots.txt"),
    content: `User-agent: *\nAllow: /\nSitemap: ${publicContent.siteUrl}/sitemap.xml\n`,
  },
  {
    path: join(repositoryRoot, "dist/site/sitemap.xml"),
    content: renderSitemapXml(),
  },
  {
    path: join(repositoryRoot, "dist/site/llms.txt"),
    content: renderLlmsText(),
  },
  {
    path: join(repositoryRoot, "dist/site/social-card.svg"),
    content: renderSocialCardSvg(),
  },
  {
    path: join(repositoryRoot, "dist/site/.well-known/security.txt"),
    content: `Contact: ${publicContent.links.privateSecurityReport}\nCanonical: ${publicContent.siteUrl}/.well-known/security.txt\nPolicy: ${publicContent.links.security}\nExpires: 2027-08-22T23:59:59Z\nPreferred-Languages: en\n`,
  },
  {
    path: join(repositoryRoot, "dist/site/.well-known/hra.json"),
    content: JSON.stringify({
      generation: 1,
      product: "Oompa",
      repository: {
        id: 1_343_008_607,
        path: "hraness/oompa",
      },
      schemaVersion: 2,
      source: {
        commit: releaseCommit,
      },
      version: OOMPA_RELEASE_VERSION,
    }, null, 2),
  },
];

const staticAssets = ["favicon.svg"] as const;
const analyticsEntryPath = fileURLToPath(
  new URL("../site/analytics-entry.ts", import.meta.url),
);
const siteEntryPath = fileURLToPath(new URL("../site/site-entry.ts", import.meta.url));

/** Direct is permitted only in the separately compiled public example frame. */
export function assertSiteBrowserBundle(source: string): void {
  assert.ok(source.length > 0 && Buffer.byteLength(source) <= 4 * 1024 * 1024, "Site browser bundle exceeded its bound");
  for (const marker of [...DIRECT_WIRE_MARKERS, "@hraness/direct", "__direct_scenario", "__direct_fixture"]) {
    assert.ok(!source.includes(marker), "Direct runtime or fixture activation escaped into a parent site bundle");
  }
}
const designKitFontsStylesPath = fileURLToPath(
  import.meta.resolve("@hraness/design-kit/fonts.css"),
);
const siteFontFaces = [
  "nebula-sans/NebulaSans-Light.woff2",
  "nebula-sans/NebulaSans-LightItalic.woff2",
  "nebula-sans/NebulaSans-Book.woff2",
  "nebula-sans/NebulaSans-BookItalic.woff2",
  "nebula-sans/NebulaSans-Medium.woff2",
  "nebula-sans/NebulaSans-MediumItalic.woff2",
  "nebula-sans/NebulaSans-Semibold.woff2",
  "nebula-sans/NebulaSans-SemiboldItalic.woff2",
  "nebula-sans/NebulaSans-Bold.woff2",
  "nebula-sans/NebulaSans-BoldItalic.woff2",
  "nebula-sans/NebulaSans-Black.woff2",
  "nebula-sans/NebulaSans-BlackItalic.woff2",
  "geist-mono/GeistMono[wght].woff2",
] as const;
const siteFontDocuments = [
  "nebula-sans/LICENSE.txt",
  "nebula-sans/PROVENANCE.md",
  "geist-mono/OFL.txt",
  "geist-mono/PROVENANCE.md",
] as const;
const siteFontFiles = [...siteFontFaces, ...siteFontDocuments];

/** The pinned public stylesheet has this finite grammar, not arbitrary CSS. */
export function assertSiteFontStyleInventory(styles: string): void {
  // Only standalone comments are ignored. A comment-shaped string inside a URL
  // remains part of that URL and must never be normalized into an allowed path.
  const facePattern = /\/\*[\s\S]*?\*\/|@font-face\s*\{([^{}]*)\}/gu;
  const faces = [...styles.matchAll(facePattern)];
  const references = new Set<string>();
  for (const face of faces) {
    if (face[1] === undefined) continue;
    const declaration = /^\s*font-display:\s*swap;\s*font-family:\s*"(?:Nebula Sans|Geist Mono)";\s*font-style:\s*(?:normal|italic);\s*font-weight:\s*(?:300|400|500|600|700|900|100 900);\s*src:\s*url\("([^"\\\r\n]+)"\)\s*format\("woff2"\);\s*$/u.exec(face[1]);
    const reference = declaration?.[1];
    if (reference === undefined || references.has(reference)) {
      throw new Error("Public font stylesheet has an unsupported or duplicate font face.");
    }
    references.add(reference);
  }
  if (
    styles.replace(facePattern, "").trim() !== ""
    || references.size !== siteFontFaces.length
    || siteFontFaces.some((path) => !references.has(`./fonts/${path}`))
  ) {
    throw new Error("Public font stylesheet URLs must match the reviewed WOFF2 inventory exactly.");
  }
}

const sameFontFile = (left: Stats, right: Stats): boolean =>
  left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
  && left.size === right.size && left.nlink === right.nlink
  && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;

/** Package-manager links above the resolved package root are allowed; assets are not links. */
async function readPublicFontInput(root: string, logicalPath: string, maxBytes: number): Promise<Buffer> {
  try {
    const path = join(root, logicalPath);
    const parents = [root];
    let parentPath = root;
    for (const segment of logicalPath.split("/").slice(0, -1)) {
      parentPath = join(parentPath, segment);
      parents.push(parentPath);
    }
    const parentStats = await Promise.all(parents.map(async (parent) => ({ path: parent, stat: await lstat(parent) })));
    for (const parent of parentStats) {
      if (!parent.stat.isDirectory() || await realpath(parent.path) !== parent.path) {
        throw new Error("Nonordinary font directory.");
      }
    }
    const before = await lstat(path);
    if (!before.isFile() || before.size < 1 || before.size > maxBytes) {
      throw new Error("Nonordinary or oversized font input.");
    }
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (!sameFontFile(before, await handle.stat())) throw new Error("Changed font input.");
      const bytes = Buffer.alloc(before.size + 1);
      let length = 0;
      while (length < bytes.length) {
        const result = await handle.read(bytes, length, bytes.length - length, length);
        if (result.bytesRead === 0) break;
        length += result.bytesRead;
      }
      if (length !== before.size || !sameFontFile(before, await handle.stat())
        || !sameFontFile(before, await lstat(path))) throw new Error("Changed font input.");
      for (const parent of parentStats) {
        if (!sameFontFile(parent.stat, await lstat(parent.path))
          || await realpath(parent.path) !== parent.path) throw new Error("Changed font directory.");
      }
      return bytes.subarray(0, length);
    } finally {
      await handle.close();
    }
  } catch {
    // Native filesystem errors can contain private install paths.
    throw new Error(`Public font input is missing, changed, nonordinary, or oversized: ${logicalPath}`);
  }
}

async function snapshotSiteFonts(sourceDirectory: string): Promise<Readonly<{
  stylesheet: string;
  inputs: readonly Readonly<{ path: string; bytes: Buffer }>[];
}>> {
  let root: string;
  try {
    root = await realpath(sourceDirectory);
  } catch {
    throw new Error("Public font package directory is unavailable.");
  }
  const stylesheetBytes = await readPublicFontInput(root, "fonts.css", 64 * 1024);
  let stylesheet: string;
  try {
    stylesheet = new TextDecoder("utf-8", { fatal: true }).decode(stylesheetBytes);
  } catch {
    throw new Error("Public font stylesheet must be valid UTF-8.");
  }
  assertSiteFontStyleInventory(stylesheet);
  // Validate the complete finite set before creating any public font output.
  const inputs: { path: string; bytes: Buffer }[] = [];
  for (const path of siteFontFiles) {
    inputs.push({ path, bytes: await readPublicFontInput(root, `fonts/${path}`, path.endsWith(".woff2") ? 1024 * 1024 : 64 * 1024) });
  }
  return { stylesheet, inputs };
}

/** Publish only browser fonts and their attribution; retain PNG-only package inputs upstream. */
export async function publishSiteFonts(sourceDirectory: string, outputDirectory: string): Promise<string> {
  const { stylesheet, inputs } = await snapshotSiteFonts(sourceDirectory);
  try {
    // The site builder creates a fresh output tree. Never merge in stale font assets.
    await mkdir(outputDirectory);
    await mkdir(join(outputDirectory, "nebula-sans"));
    await mkdir(join(outputDirectory, "geist-mono"));
    for (const { path, bytes } of inputs) {
      await writeFile(join(outputDirectory, path), bytes, { flag: "wx", mode: 0o644 });
    }
  } catch {
    throw new Error("Public fonts require a fresh writable publication directory.");
  }
  return stylesheet;
}

const readExisting = async (path: string): Promise<string | undefined> => {
  try {
    return await readFile(path, "utf8");
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
};

async function buildAnalyticsBundle(
  repositoryRoot: string,
  projectToken: string,
): Promise<void> {
  const result = await Bun.build({
    define: {
      __OOMPA_POSTHOG_PROJECT_TOKEN__: JSON.stringify(projectToken),
      "process.env.NODE_ENV": JSON.stringify("production"),
    },
    entrypoints: [analyticsEntryPath],
    format: "esm",
    minify: true,
    naming: "analytics.js",
    outdir: join(repositoryRoot, "dist/site"),
    sourcemap: "none",
    target: "browser",
  });
  if (!result.success) {
    const details = result.logs.map((log) => log.message).join("\n");
    throw new Error(`Oompa analytics bundle failed.${details.length > 0 ? `\n${details}` : ""}`);
  }
}

async function buildSiteBrowserBundle(repositoryRoot: string): Promise<void> {
  const result = await Bun.build({
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    entrypoints: [siteEntryPath], format: "esm", minify: true,
    naming: "site.js", sourcemap: "none", target: "browser",
  });
  if (!result.success) {
    const details = result.logs.map((log) => log.message).join("\n");
    throw new Error(`Oompa site browser bundle failed.${details.length > 0 ? `\n${details}` : ""}`);
  }
  assert.equal(result.outputs.length, 1, "The parent site must have one self-contained browser entry");
  const output = result.outputs[0];
  assert.ok(output !== undefined && output.kind === "entry-point");
  assert.equal(basename(output.path), "site.js");
  const source = await output.text();
  assertSiteBrowserBundle(source);
  await writeFile(join(repositoryRoot, "dist/site/site.js"), source, { flag: "wx", mode: 0o644 });
}

export const buildSite = async (options: BuildOptions): Promise<readonly string[]> => {
  const mismatches: string[] = [];

  for (const output of trackedTextOutputs(options.repositoryRoot)) {
    const content = withFinalNewline(output.content);
    if (options.check) {
      if ((await readExisting(output.path)) !== content) {
        mismatches.push(output.path);
      }
      continue;
    }

    await mkdir(dirname(output.path), { recursive: true });
    await writeFile(output.path, content, { encoding: "utf8" });
  }

  if (options.check) return mismatches;

  const releaseCommit = options.releaseCommit ?? "local";
  if (releaseCommit !== "local" && !/^[0-9a-f]{40}$/u.test(releaseCommit)) {
    throw new Error("Release commit must be a lowercase 40-character Git SHA.");
  }
  const environment = options.environment ?? emptyBuildEnvironment;
  const analyticsProjectToken = resolveOompaAnalyticsProjectToken(environment);
  const fonts = await snapshotSiteFonts(dirname(designKitFontsStylesPath));
  const sourceRoot = await realpath(options.sourceRoot ?? options.repositoryRoot);
  const marketingPreset = await snapshotMarketingPreset(join(sourceRoot, "site/vendor/marketing-preset"));
  const materialRoot = join(sourceRoot, "site/vendor/lantern-material");
  const material = await checkLanternMaterialSnapshot(materialRoot);
  // Both portable layers retain the same MIT attribution. Keep the existing
  // exact public inventory rather than emitting an identical second license.
  const sharedLicense = marketingPreset.files.get("LICENSE");
  assert.ok(sharedLicense !== undefined);
  assert.equal(createHash("sha256").update(sharedLicense).digest("hex"), material.files.LICENSE.sha256);
  const presetFonts = [...marketingPreset.files].filter(([path]) => path.startsWith("fonts/"))
    .map(([path, bytes]) => ({ path: path.slice("fonts/".length), bytes }));
  const allFonts = [...fonts.inputs, ...presetFonts];
  const presetImages = [...marketingPreset.files].filter(([path]) => path.endsWith(".svg"))
    .map(([path, bytes]) => ({ path, bytes }));
  const compiled = await buildSiteStylex({
    sourceRoot,
    environment, fonts: allFonts, images: presetImages,
  });
  assert.deepEqual(await checkLanternMaterialSnapshot(materialRoot), material, "Lantern source changed during static compilation");
  // Retain failed/completed private receipts under the same ignored build root
  // as the static compiler. Only the builder's verified public projection moves.
  const previewRun = await mkdtemp(join(sourceRoot, "tmp/site-product-preview-"));
  const previewDirectory = await buildProductPreview({ repositoryRoot: sourceRoot, outputDirectory: previewRun });
  assert.equal(previewDirectory, join(previewRun, "public"));
  await rm(join(options.repositoryRoot, "dist", "site"), {
    force: true,
    recursive: true,
  });
  for (const output of siteTextOutputs(
    options.repositoryRoot,
    releaseCommit,
  )) {
    const content = withFinalNewline(output.content);
    await mkdir(dirname(output.path), { recursive: true });
    await writeFile(output.path, content, { encoding: "utf8" });
  }
  for (const [path, bytes] of compiled.files) {
    const destination = join(options.repositoryRoot, "dist/site", path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, bytes, { flag: "wx", mode: 0o644 });
  }
  // Browser fonts are already hashed graph assets. Publish their attribution
  // beside the family names without a redundant second copy of every WOFF2.
  for (const { path, bytes } of allFonts.filter(({ path }) => !path.endsWith(".woff2"))) {
    const destination = join(options.repositoryRoot, "dist/site/fonts", path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, bytes, { flag: "wx", mode: 0o644 });
  }
  for (const name of ["LICENSE", "marketing-assets/UPSTREAM.md"]) {
    const destination = join(options.repositoryRoot, "dist/site/marketing-preset", name);
    await mkdir(dirname(destination), { recursive: true });
    const bytes = marketingPreset.files.get(name);
    assert.ok(bytes !== undefined, "Canonical marketing attribution is missing");
    await writeFile(destination, bytes, { flag: "wx", mode: 0o644 });
  }
  const socialCardPng = renderSocialCardPng();
  const socialCardDimensions = readPngDimensions(socialCardPng);
  if (
    socialCardDimensions.width !== SOCIAL_CARD_WIDTH
    || socialCardDimensions.height !== SOCIAL_CARD_HEIGHT
    || socialCardDimensions.width !== publicContent.socialCard.width
    || socialCardDimensions.height !== publicContent.socialCard.height
  ) {
    throw new Error("The social card PNG must be 1200x630 and match the published Open Graph size.");
  }
  await writeFile(join(options.repositoryRoot, "dist/site", publicContent.socialCard.path), socialCardPng);
  await buildAnalyticsBundle(options.repositoryRoot, analyticsProjectToken);
  assertSiteBrowserBundle(await readFile(join(options.repositoryRoot, "dist/site/analytics.js"), "utf8"));
  await buildSiteBrowserBundle(options.repositoryRoot);
  const appearance = await buildOompaAppearance();
  assertSiteBrowserBundle(appearance);
  await writeFile(join(options.repositoryRoot, "dist/site/appearance.js"), appearance, "utf8");
  await cp(previewDirectory, join(options.repositoryRoot, "dist/site/examples/app"), {
    recursive: true, errorOnExist: true, force: false,
  });

  for (const asset of staticAssets) {
    const source = join(options.repositoryRoot, "site", asset);
    const destination = join(options.repositoryRoot, "dist/site", asset);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination);
  }
  return mismatches;
};

if (import.meta.main) {
  const repositoryRoot = resolve(import.meta.dir, "..");
  const check = Bun.argv.slice(2).includes("--check");
  const providerCommit = process.env.VERCEL_GIT_COMMIT_SHA
    ?? process.env.OOMPA_RELEASE_COMMIT;
  if (
    process.env.VERCEL === "1"
    && (providerCommit === undefined || !/^[0-9a-f]{40}$/u.test(providerCommit))
  ) {
    throw new Error("A Vercel build requires an exact source commit marker.");
  }
  const mismatches = await buildSite({
    check,
    environment: process.env,
    ...(providerCommit === undefined ? {} : { releaseCommit: providerCommit }),
    repositoryRoot,
  });
  if (mismatches.length > 0) {
    console.error(`Generated public files are stale:\n${mismatches.map((path) => relative(repositoryRoot, path)).join("\n")}`);
    process.exitCode = 1;
  }
}
