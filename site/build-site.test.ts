import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseHTML } from "linkedom";
import fc from "fast-check";
import { transform, type Selector } from "lightningcss";
import { createStylexTransformCollector } from "@hraness/ui/stylex-build";
import { DIRECT_WIRE_MARKERS } from "@hraness/direct/tooling/bundle-boundary";

import {
  assertSiteFontStyleInventory,
  assertSiteBrowserBundle,
  buildSite as buildSiteDirect,
  OOMPA_POSTHOG_PROJECT_TOKEN_ENV,
  publishSiteFonts,
  readPackageVersion,
  resolveOompaAnalyticsProjectToken,
} from "../scripts/build-site.ts";
import { publicContent } from "./content.ts";
import { docsPaths, renderDocsMarkdown } from "./docs-content.ts";
import { PRODUCT_PREVIEW_CSP } from "../scripts/build-product-preview.ts";
import { renderSocialCardPng, renderSocialCardSvg } from "./social-card.ts";
import { readPngDimensions } from "./social-card-raster.ts";
import {
  OOMPA_MAILING_TURNSTILE_SITEKEY_ENV,
  renderAskAiAboutThis,
  renderOompaAnalyticsScript,
  renderOompaSiteFooter,
  renderDocsPages,
  renderPreviewHtml,
  renderPrivacyHtml,
  renderSiteHtml,
} from "./template.ts";
import { OOMPA_RELEASE_VERSION } from "../scripts/release-evidence";
import { mobileHeaderFlowClassName } from "./marketing.stylex.ts";
import { createSiteCompilerCase, siteCompilerHookMs, siteCompilerOuterMs } from "./build-site-test-owner";

const temporaryRoots: string[] = [];
// Ubuntu CI spent 29.36s in real graph work before final publication. Compiler
// cases have one 60s work deadline plus bounded collection/drain; pure cases keep 5s.
const compilerCases: ReturnType<typeof createSiteCompilerCase>[] = [];
const sourceRoot = await realpath(join(import.meta.dir, ".."));
const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const installedFontRoot = dirname(fileURLToPath(import.meta.resolve("@hraness/design-kit/fonts.css")));
const expectedFontPaths = [
  ...["Light", "LightItalic", "Book", "BookItalic", "Medium", "MediumItalic", "Semibold", "SemiboldItalic", "Bold", "BoldItalic", "Black", "BlackItalic"]
    .map((cut) => `nebula-sans/NebulaSans-${cut}.woff2`),
  "geist-mono/GeistMono[wght].woff2",
  "nebula-sans/LICENSE.txt",
  "nebula-sans/PROVENANCE.md",
  "geist-mono/OFL.txt",
  "geist-mono/PROVENANCE.md",
].sort();
const expectedAttributionPaths = expectedFontPaths.filter((path) => !path.endsWith(".woff2"));
const presetRoot = join(sourceRoot, "site/vendor/marketing-preset");
const presetFontPath = "instrument-serif/instrument-serif-latin-400.woff2";
const presetAttributionPaths = ["instrument-serif/OFL.txt", "instrument-serif/UPSTREAM.md"];
const allAttributionPaths = [...expectedAttributionPaths, ...presetAttributionPaths].sort();

function assertMobileHeaderRule(css: string, className: string): void {
  expect(className).toMatch(/^x[a-z0-9]+$/u);
  const targetsHeader = (selectors: readonly Selector[]): boolean => selectors.some((selector) =>
    selector.length > 0 && selector.every((part) => part.type === "class" && part.name === className));
  const expectedQueries: unknown[] = [];
  transform({ filename: "expected-mobile-header.css", code: Buffer.from("@media (max-width: 48rem) { .expected { position: static; } }"),
    visitor: { Rule: { media(rule) { expectedQueries.push(rule.value.query); } } } });
  let declarations = 0;
  const actualQueries: unknown[] = [];
  transform({ filename: "compiled-mobile-header.css", code: Buffer.from(css), visitor: { Rule: {
    style(rule) {
      if (!targetsHeader(rule.value.selectors)) return;
      declarations++;
      expect(rule.value.declarations).toEqual({ declarations: [{ property: "position", value: { type: "static" } }], importantDeclarations: [] });
    },
    media(rule) {
      if (rule.value.rules.some((child) => child.type === "style" && targetsHeader(child.value.selectors))) actualQueries.push(rule.value.query);
    },
  } } });
  expect(declarations).toBe(1);
  expect(actualQueries).toEqual(expectedQueries);
}

function compiledStylesheetJoin(html: string): { foundationPath: string; authoredHtml: string } {
  const { document } = parseHTML(html);
  const hrefs = [...document.querySelectorAll('link[rel="stylesheet"]')].map((link) => link.getAttribute("href"));
  expect(hrefs).toHaveLength(2);
  const foundationHref = hrefs[0];
  if (typeof foundationHref !== "string") throw new Error("Missing captured foundation stylesheet.");
  expect(foundationHref).toMatch(/^\/graphs\/foundation\/assets\/[A-Za-z0-9_.-]+\.css$/u);
  expect(hrefs[1]).toBe("/stylex.css");
  expect(document.querySelectorAll("style, [style]")).toHaveLength(0);
  const join = `<link rel="stylesheet" href="${foundationHref}">\n<link rel="stylesheet" href="/stylex.css">`;
  expect(html.split(join)).toHaveLength(2);
  return {
    foundationPath: foundationHref.slice(1),
    authoredHtml: html.replace(join, '<link rel="stylesheet" href="/styles.css">'),
  };
}

async function inventoryFiles(root: string, prefix = ""): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) result.push(...await inventoryFiles(root, path));
    else {
      expect(entry.isFile()).toBe(true);
      result.push(path);
    }
  }
  return result.sort();
}

async function createFontFixture(): Promise<{ source: string; output: string; styles: string }> {
  const root = await mkdtemp(join(tmpdir(), "oompa-font-publication-"));
  temporaryRoots.push(root);
  const source = join(root, "source");
  await mkdir(join(source, "fonts/nebula-sans"), { recursive: true });
  await mkdir(join(source, "fonts/geist-mono"));
  const styles = await readFile(join(installedFontRoot, "fonts.css"), "utf8");
  await writeFile(join(source, "fonts.css"), styles);
  for (const path of expectedFontPaths) await writeFile(join(source, "fonts", path), `fixture:${path}`);
  return { source, output: join(root, "published"), styles };
}

const createFixtureRoot = async (registerRoot: (root: string) => void = (root) => { temporaryRoots.push(root); }): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "oompa-site-test-"));
  registerRoot(root);
  expect(await realpath(root)).not.toBe(sourceRoot);
  await mkdir(join(root, "site"), { recursive: true });
  await Promise.all(
    ["favicon.svg", "styles.css"].map(async (asset) => {
      await writeFile(join(root, "site", asset), `fixture:${asset}\n`, "utf8");
    }),
  );
  return root;
};

function compilerCase(name: string, operation: (context: {
  buildSite: ReturnType<typeof createSiteCompilerCase>["buildSite"];
  createFixtureRoot: () => Promise<string>;
}) => Promise<void>): void {
  test(name, () => {
    const owner = createSiteCompilerCase(sourceRoot);
    compilerCases.push(owner);
    return owner.run(async () => await operation({
      buildSite: owner.buildSite,
      createFixtureRoot: async () => {
        owner.checkpoint();
        const root = await createFixtureRoot(owner.registerRoot);
        owner.checkpoint();
        return root;
      },
    }));
  }, siteCompilerOuterMs);
}

afterEach(async () => {
  // Capture lists synchronously. Late setup cannot donate a root to the next
  // test, and each compiler owner must prove collection before removing its own.
  const owners = compilerCases.splice(0);
  const unownedRoots = temporaryRoots.splice(0);
  const results = await Promise.allSettled(owners.map(async (owner) => await owner.close()));
  await Promise.all(
    unownedRoots.map(async (root) => {
      await rm(root, { force: true, recursive: true });
    }),
  );
  const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason as unknown] : []);
  if (failures.length > 0) throw new AggregateError(failures, "SITE_COMPILER_TEARDOWN_FAILED");
}, siteCompilerHookMs);

describe("static-site build", () => {
  test("does not create or require a package README in the site-owned tracked document phase", async () => {
    const root = await createFixtureRoot();
    await expect(buildSiteDirect({ check: false, repositoryRoot: root, releaseCommit: "invalid" }))
      .rejects.toThrow("Release commit must be a lowercase 40-character Git SHA.");
    await expect(lstat(join(root, "README.md"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await buildSiteDirect({ check: true, repositoryRoot: root })).toEqual([]);
    await expect(lstat(join(root, "README.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("preserves arbitrary package README bytes before compilation and in check mode", async () => {
    await fc.assert(fc.asyncProperty(fc.uint8Array({ maxLength: 512 }), async (bytes) => {
      const root = await createFixtureRoot();
      const path = join(root, "README.md");
      await writeFile(path, bytes);
      // This is a real builder boundary before any native compiler starts.
      // Site-owned tracked documents may change; the package README may not.
      await expect(buildSiteDirect({ check: false, repositoryRoot: root, releaseCommit: "invalid" }))
        .rejects.toThrow("Release commit must be a lowercase 40-character Git SHA.");
      expect(await readFile(path)).toEqual(Buffer.from(bytes));
      expect(await buildSiteDirect({ check: true, repositoryRoot: root })).toEqual([]);
      expect(await readFile(path)).toEqual(Buffer.from(bytes));
    }), { seed: 20_260_909, numRuns: 16 });
  });

  test("rejects Direct runtime or fixture selectors in parent browser bundles", () => {
    expect(() => assertSiteBrowserBundle("document.querySelector('[data-product-preview]')")).not.toThrow();
    for (const marker of [...DIRECT_WIRE_MARKERS, "@hraness/direct", "__direct_scenario", "__direct_fixture"]) {
      expect(() => assertSiteBrowserBundle(`export const leaked = ${JSON.stringify(marker)};`)).toThrow("Direct runtime or fixture activation");
    }
    expect(() => assertSiteBrowserBundle("")).toThrow("bound");
    expect(() => assertSiteBrowserBundle("x".repeat(4 * 1024 * 1024 + 1))).toThrow("bound");
  });

  test("keeps the wrapping mobile header in document flow through its emitted StyleX atom", async () => {
    const className = mobileHeaderFlowClassName();
    const path = join(sourceRoot, "site/marketing.stylex.ts");
    const compiled = await createStylexTransformCollector(sourceRoot).transform(await readFile(path, "utf8"), path);
    const css = compiled.rules.filter(([name]) => name === className).map(([, rule]) => rule.ltr).join("\n");
    assertMobileHeaderRule(css, className);
    for (const render of [renderSiteHtml, renderPrivacyHtml]) {
      const { document } = parseHTML(render());
      const headers = document.querySelectorAll('[data-hraness-marketing="header"]');
      expect(headers).toHaveLength(1);
      expect(headers[0]?.classList.contains(className)).toBe(true);
      expect(headers[0]?.hasAttribute("style")).toBe(false);
    }
    expect(await readFile(join(sourceRoot, "site/styles.css"), "utf8")).not.toContain("position: static");
    for (const invalid of [
      `.${className}{position:static}`, `@media(max-width:47rem){.${className}{position:static}}`,
      `@media(width < 48rem){.${className}{position:static}}`,
      `@media(max-width:48rem){.${className}{position:sticky}}`,
      `@media(max-width:48rem){.wrong{position:static}}`,
      `@media(max-width:48rem){.${className}{position:static!important}}`,
      `.${className}{position:sticky}@media(max-width:48rem){.${className}{position:static}}`,
    ]) expect(() => assertMobileHeaderRule(invalid, className)).toThrow();
  });

  test("publishes exactly the reviewed fonts and attribution, excluding package-only source and OTFs", async () => {
    const { source, output, styles } = await createFontFixture();
    for (const path of ["social-fonts.generated.ts", "NebulaSans-Book.otf", "NebulaSans-Bold.otf", "extra.woff2"]) {
      await writeFile(join(source, "fonts/nebula-sans", path), "not public");
    }
    expect(await publishSiteFonts(source, output)).toBe(styles);
    expect(await inventoryFiles(output)).toEqual(expectedFontPaths);
    for (const path of expectedFontPaths) {
      expect(await readFile(join(output, path))).toEqual(await readFile(join(source, "fonts", path)));
    }
    await expect(publishSiteFonts(source, output)).rejects.toThrow("fresh writable publication directory");
    expect(await inventoryFiles(output)).toEqual(expectedFontPaths);
  });

  test("requires exact stylesheet URL coverage and rejects extra, missing, duplicate, source, escaped, and remote references", async () => {
    const styles = await readFile(join(installedFontRoot, "fonts.css"), "utf8");
    expect(() => assertSiteFontStyleInventory(styles)).not.toThrow();
    const firstFace = styles.match(/@font-face\s*\{[^{}]*\}/u)?.[0];
    expect(firstFace).toBeDefined();
    if (firstFace === undefined) throw new Error("Expected the installed font-face fixture.");
    const original = "./fonts/nebula-sans/NebulaSans-Light.woff2";
    for (const changed of [
      styles.replace(firstFace, ""),
      `${styles}\n${firstFace}`,
      `${styles}\n@import url("https://invalid.example/font.css");`,
      styles.replace("src: url", "src: u\\72l"),
      styles.replace(original, "./fonts/nebula-sans/NebulaSans-/*hidden*/Light.woff2"),
      ...["./fonts/nebula-sans/extra.woff2", "./fonts/nebula-sans/social-fonts.generated.ts", "./fonts/nebula-sans/NebulaSans-Book.otf", "../outside.woff2", "https://invalid.example/font.woff2"]
        .map((url) => styles.replace(original, url)),
    ]) expect(() => assertSiteFontStyleInventory(changed)).toThrow("Public font stylesheet");
  });

  test("rejects missing, linked, directory, and oversized font inputs before publishing any files", async () => {
    for (const failure of ["missing", "symlink", "parent-symlink", "directory", "oversized"] as const) {
      const { source, output } = await createFontFixture();
      const path = join(source, "fonts/nebula-sans/NebulaSans-Light.woff2");
      if (failure === "parent-symlink") {
        await rm(join(source, "fonts/nebula-sans"), { recursive: true });
        await symlink(join(installedFontRoot, "fonts/nebula-sans"), join(source, "fonts/nebula-sans"));
      } else {
        await rm(path);
        if (failure === "symlink") await symlink(join(installedFontRoot, "fonts/nebula-sans/NebulaSans-Light.woff2"), path);
        if (failure === "directory") await mkdir(path);
        if (failure === "oversized") await writeFile(path, Buffer.alloc(1024 * 1024 + 1));
      }
      await expect(publishSiteFonts(source, output)).rejects.toThrow("Public font input is missing, changed, nonordinary, or oversized: fonts/nebula-sans/");
      await expect(readdir(output)).rejects.toThrow();
    }
  });

  test("keeps shared Ask AI presentation owned by the compiled package", async () => {
    const styles = await readFile(join(import.meta.dir, "styles.css"), "utf8");
    const recipes = await readFile(join(import.meta.dir, "presentation.stylex.ts"), "utf8");
    expect(styles).not.toContain('[data-slot="ask-ai-about-this-');
    expect(styles).not.toMatch(/(?:^|\n)a:focus-visible\s*[,{]/u);
    for (const [shared, product] of [
      ["background", "background"], ["foreground", "foreground"],
      ["font-sans", "font-sans"], ["font-heading", "font-heading"],
      ["font-mono", "font-mono"],
    ]) expect(styles).toContain(`--ui-${shared}: var(--${product});`);
    for (const [shared, product] of [
      ["foreground", "foreground"], ["border", "rule"],
      ["muted", "surface"], ["muted-foreground", "muted"],
      ["primary", "primary"], ["ring", "focus"],
    ]) expect(recipes).toContain(`"--ui-${shared}": "var(--${product})"`);
  });

  test("keeps documentation code roles separate from inverse marketing roles", async () => {
    const styles = await readFile(join(import.meta.dir, "styles.css"), "utf8");
    const recipes = await readFile(join(import.meta.dir, "presentation.stylex.ts"), "utf8");
    expect(styles).not.toContain(".oompa-inline-code {");
    expect(recipes).toContain('overflowWrap: "anywhere"');
    expect(styles).not.toMatch(/(?:^|\n)code\s*\{/u);
    expect(styles).toContain("--hraness-marketing-inverse: var(--inverse-background)");
    expect(styles).toContain("--hraness-marketing-inverse-ink: var(--inverse-foreground)");
    expect(recipes).toContain('"--foreground": "var(--code-foreground)"');
    expect(styles).toContain("--code-background: var(--surface-raised)");
    expect(styles).toContain("--code-foreground: var(--foreground)");
    expect(styles).toContain("--inverse-background: var(--inverse)");
  });

  test("renders one crawlable Ask AI row on each public page with exact provider prompts", () => {
    const subjectUrl = "https://oompa.app/privacy/";
    const prompt = `Tell me about ${subjectUrl}`;
    const row = renderAskAiAboutThis(subjectUrl);
    const providers = [
      ["chatgpt", "https://chatgpt.com/", "q"],
      ["claude", "https://claude.ai/new", "q"],
      ["perplexity", "https://perplexity.ai/", "q"],
      ["grok", "https://x.com/i/grok", "text"],
    ] as const;

    expect(row.match(/<nav\b/gu)).toHaveLength(1);
    expect(row).toContain('aria-label="Ask AI about this"');
    expect(row.match(/data-slot="ask-ai-about-this-link"/gu)).toHaveLength(4);
    expect(row.match(/target="_blank"/gu)).toHaveLength(4);
    expect(row.match(/rel="noopener noreferrer nofollow"/gu)).toHaveLength(4);
    for (const [provider, baseUrl, parameter] of providers) {
      const destination = new URL(baseUrl);
      destination.searchParams.set(parameter, prompt);
      expect(row).toContain(`data-ask-ai-provider="${provider}"`);
      expect(row).toContain(`href="${destination.href.replaceAll("&", "&amp;")}"`);
    }

    const publicPages = [
      [renderSiteHtml(), "https://oompa.app/"],
      [renderPrivacyHtml(), subjectUrl],
    ] as const;
    for (const [html, canonicalUrl] of publicPages) {
      const destination = new URL("https://chatgpt.com/");
      destination.searchParams.set("q", `Tell me about ${canonicalUrl}`);
      expect(html.match(/data-slot="ask-ai-about-this"/gu)).toHaveLength(1);
      expect(html).toContain(destination.href.replaceAll("&", "&amp;"));
    }

    expect(renderPreviewHtml()).not.toContain('data-slot="ask-ai-about-this"');
  });

  compilerCase("writes every named public artifact and then passes check mode", async ({ buildSite, createFixtureRoot }) => {
    const root = await createFixtureRoot();
    const packageReadme = "# Independently authored package README\n";
    await writeFile(join(root, "README.md"), packageReadme);
    expect(await buildSite({ check: false, repositoryRoot: root, sourceRoot })).toEqual([]);
    expect(await readFile(join(root, "README.md"), "utf8")).toBe(packageReadme);
    expect(await buildSite({ check: true, repositoryRoot: root, sourceRoot })).toEqual([]);
    expect(await readFile(join(root, "README.md"), "utf8")).toBe(packageReadme);

    const expectedPaths = [
      "PRIVACY.md",
      "dist/site/index.html",
      "dist/site/preview/index.html",
      "dist/site/privacy/index.html",
      "dist/site/robots.txt",
      "dist/site/sitemap.xml",
      "dist/site/llms.txt",
      "dist/site/.well-known/security.txt",
      "dist/site/.well-known/hra.json",
      "dist/site/analytics.js",
      "dist/site/site.js",
      "dist/site/appearance.js",
      "dist/site/favicon.svg",
      "dist/site/social-card.svg",
      "dist/site/social-card.png",
      "dist/site/stylex.css",
      ...docsPaths.flatMap((path) => [`dist/site${path}index.html`, `dist/site${path}index.md`]),
      ...allAttributionPaths.map((path) => `dist/site/fonts/${path}`),
      "dist/site/marketing-preset/LICENSE",
      "dist/site/marketing-preset/marketing-assets/UPSTREAM.md",
    ];

    for (const path of expectedPaths) {
      expect((await readFile(join(root, path))).byteLength).toBeGreaterThan(0);
    }

    const html = await readFile(join(root, "dist/site/index.html"), "utf8");
    const { foundationPath, authoredHtml } = compiledStylesheetJoin(html);
    expect(authoredHtml).toBe(renderSiteHtml());
    for (const [path, render] of [["privacy/index.html", renderPrivacyHtml], ["preview/index.html", renderPreviewHtml]] as const) {
      const route = compiledStylesheetJoin(await readFile(join(root, "dist/site", path), "utf8"));
      expect(route.foundationPath).toBe(foundationPath);
      expect(route.authoredHtml).toBe(render());
    }
    for (const [path, expected] of Object.entries(renderDocsPages())) {
      const route = compiledStylesheetJoin(await readFile(join(root, "dist/site", path.slice(1), "index.html"), "utf8"));
      expect(route.foundationPath).toBe(foundationPath);
      expect(route.authoredHtml).toBe(expected);
      expect(await readFile(join(root, "dist/site", path.slice(1), "index.md"), "utf8"))
        .toBe(renderDocsMarkdown(path).replace(/\n?$/u, "\n"));
    }
    const foundation = await readFile(join(root, "dist/site", foundationPath), "utf8");
    const union = await readFile(join(root, "dist/site/stylex.css"), "utf8");
    assertMobileHeaderRule(union, mobileHeaderFlowClassName());
    expect(foundation).toContain("Nebula Sans");
    expect(foundation).toContain(".syntax-code");
    expect(foundation).toContain(".syntax-token--command");
    expect(foundation).toContain("components.hraness-ui");
    expect(union).toContain("@layer components.hraness-stylex");
    // The linked union owns footer recipes; the captured foundation owns only
    // its shared document defaults. Exact HTML parity above preserves the full
    // canonical footer, and the atom closure below binds its emitted classes.
    expect(union).toContain("--hraness-site-footer-social-target");
    expect(union).toContain("--hraness-palette-background");
    expect(foundation).toContain(".hraness-palette");
    const { document } = parseHTML(html);
    const atomClasses = new Set([...document.querySelectorAll("[class]")]
      .flatMap((element) => [...element.classList])
      .filter((className) => /^x[a-z0-9]+$/u.test(className)));
    expect(atomClasses.size).toBeGreaterThan(10);
    for (const className of atomClasses) expect(union).toContain(`.${className}`);
    for (const styles of [foundation, union]) {
      expect(styles).not.toMatch(/@import\b/u);
      expect(styles).not.toContain("fixture:styles.css");
      expect(styles).not.toContain("node_modules/");
      expect(styles).not.toContain("sourceMappingURL=");
      expect(styles).not.toContain(import.meta.dir);
      expect(styles).not.toContain('@import "./dist/stylex.css"');
    }
    const inventory = await inventoryFiles(join(root, "dist/site"));
    const fontPaths = inventory.filter((path) => path.endsWith(".woff2"));
    expect(fontPaths).toHaveLength(14);
    for (const path of fontPaths) expect(path).toMatch(/^graphs\/foundation\/assets\/[A-Za-z0-9_.[\]-]+\.woff2$/u);
    const expectedFontBytes = await Promise.all(expectedFontPaths.filter((path) => path.endsWith(".woff2"))
      .map((path) => readFile(join(installedFontRoot, "fonts", path))));
    expectedFontBytes.push(await readFile(join(presetRoot, "fonts", presetFontPath)));
    const fieldPaths = inventory.filter((path) => path.startsWith("graphs/foundation/assets/") && path.endsWith(".svg"));
    expect(fieldPaths).toHaveLength(2);
    const fieldBytes = await Promise.all(fieldPaths.map((path) => readFile(join(root, "dist/site", path))));
    const expectedFieldBytes = await Promise.all(["grain.svg", "cells.svg"].map((path) => readFile(join(presetRoot, "marketing-assets", path))));
    expect(fieldBytes.map(hash).sort()).toEqual(expectedFieldBytes.map(hash).sort());
    const emittedFontBytes = await Promise.all(fontPaths.map((path) => readFile(join(root, "dist/site", path))));
    expect(emittedFontBytes.map(hash).sort()).toEqual(expectedFontBytes.map(hash).sort());
    const bold = await readFile(join(installedFontRoot, "fonts/nebula-sans/NebulaSans-Bold.woff2"));
    expect(bold.byteLength).toBeGreaterThan(60_000);
    expect(emittedFontBytes.some((bytes) => bytes.equals(bold))).toBe(true);
    const fontUrls: string[] = [];
    transform({ filename: foundationPath, code: Buffer.from(foundation), visitor: { Url(value) { fontUrls.push(value.url); } } });
    expect(fontUrls).toHaveLength(16);
    const resolvedFonts = fontUrls.map((url) => {
      expect(url).not.toMatch(/^(?:data:|https?:|\/)/iu);
      const resolved = new URL(url, `https://oompa.app/${foundationPath}`);
      expect(resolved.origin).toBe("https://oompa.app");
      expect(resolved.search).toBe("");
      expect(resolved.hash).toBe("");
      return decodeURIComponent(resolved.pathname.slice(1));
    });
    expect(resolvedFonts.sort()).toEqual([...fontPaths, ...fieldPaths].sort());
    const previewPaths = inventory.filter((path) => path.startsWith("examples/app/"));
    expect(previewPaths).toContain("examples/app/index.html");
    expect(previewPaths).toContain("examples/app/stylex.css");
    expect(previewPaths.filter((path) => path.endsWith(".css"))).toHaveLength(2);
    expect(previewPaths.filter((path) => path.endsWith(".js")).length).toBeGreaterThan(0);
    for (const path of previewPaths) expect(path).toMatch(/^examples\/app\/(?:index\.html|stylex\.css|graphs\/client\/assets\/[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(?:js|css))$/u);
    const preview = await readFile(join(root, "dist/site/examples/app/index.html"), "utf8");
    const directLicense = (await readFile(join(sourceRoot, "node_modules/@hraness/direct/LICENSE"), "utf8")).trim();
    const previewScripts = await Promise.all(previewPaths.filter((path) => path.endsWith(".js"))
      .map((path) => readFile(join(root, "dist/site", path), "utf8")));
    expect(previewScripts.some((script) => script.includes(directLicense))).toBe(true);
    const frameDocument = parseHTML(preview).document;
    expect(frameDocument.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content")).toBe(PRODUCT_PREVIEW_CSP);
    expect(preview).not.toContain("/analytics.js");
    expect(preview).not.toContain("/site.js");
    for (const element of frameDocument.querySelectorAll("[src],[href]")) {
      const resource = element.getAttribute("src") ?? element.getAttribute("href");
      expect(resource).toMatch(/^\.\/(?:stylex\.css|graphs\/client\/assets\/[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(?:js|css))$/u);
      expect(previewPaths).toContain(`examples/app/${resource?.slice(2)}`);
    }
    expect(inventory).toEqual([
      ...expectedPaths.filter((path) => path.startsWith("dist/site/")).map((path) => path.slice("dist/site/".length)),
      foundationPath, ...fontPaths, ...fieldPaths, ...previewPaths,
    ].sort());
    expect(inventory.filter((path) => path.endsWith(".js") && !path.startsWith("examples/app/"))).toEqual(["analytics.js", "appearance.js", "site.js"]);
    for (const path of ["analytics.js", "appearance.js", "site.js"]) assertSiteBrowserBundle(await readFile(join(root, "dist/site", path), "utf8"));
    expect(inventory.some((path) => path.endsWith("stylex-complete.json") || path.includes("/complete/") || path.endsWith(".map"))).toBe(false);
    expect(inventory.some((path) => /\.(?:map|ts|tsx|otf)$/u.test(path) || path.startsWith("graphs/renderer/"))).toBe(false);
    expect(await inventoryFiles(join(root, "dist/site/fonts"))).toEqual(allAttributionPaths);
    for (const path of presetAttributionPaths) {
      expect(await readFile(join(root, "dist/site/fonts", path))).toEqual(await readFile(join(presetRoot, "fonts", path)));
    }
    expect(document.documentElement.getAttribute("data-hraness-marketing-preset")).toBe("editorial");
    expect(document.documentElement.getAttribute("data-hraness-material")).toBe("lantern");
    expect(document.querySelector("main.hraness-marketing-field")).toBeNull();
    expect(document.querySelectorAll(".hraness-material-wall")).toHaveLength(1);
    expect(document.querySelector(".hraness-marketing-hero.hraness-material-wall")).not.toBeNull();
    expect(document.querySelector(".hraness-marketing-header.hraness-material-chrome")).not.toBeNull();
    for (const path of expectedAttributionPaths) {
      expect(await readFile(join(root, "dist/site/fonts", path)))
        .toEqual(await readFile(join(installedFontRoot, "fonts", path)));
    }

    expect(JSON.parse(
      await readFile(join(root, "dist/site/.well-known/hra.json"), "utf8"),
    )).toEqual({
      generation: 1,
      product: "Oompa",
      repository: {
        id: 1_343_008_607,
        path: "hraness/oompa",
      },
      schemaVersion: 2,
      source: {
        commit: "local",
      },
      version: OOMPA_RELEASE_VERSION,
    });
  });

  compilerCase("renders the social card as a 1200x630 PNG plus the legacy SVG path from one composition", async ({ buildSite, createFixtureRoot }) => {
    const root = await createFixtureRoot();
    await buildSite({ check: false, repositoryRoot: root, sourceRoot });
    const png = new Uint8Array(await readFile(join(root, "dist/site/social-card.png")));
    const svg = await readFile(join(root, "dist/site/social-card.svg"), "utf8");

    expect(readPngDimensions(png)).toEqual({ height: 630, width: 1200 });
    expect(Buffer.from(png).equals(Buffer.from(renderSocialCardPng()))).toBe(true);
    expect(svg).toBe(renderSocialCardSvg());
    expect(svg).toContain(publicContent.socialCard.alt);
    expect(renderSiteHtml()).toContain(
      `<meta property="og:image" content="${publicContent.siteUrl}/social-card.png">`,
    );
  });

  compilerCase("binds hosted identity to one exact source commit", async ({ buildSite, createFixtureRoot }) => {
    const root = await createFixtureRoot();
    const commit = "0123456789abcdef0123456789abcdef01234567";
    await buildSite({ check: false, releaseCommit: commit, repositoryRoot: root, sourceRoot });
    const identity = JSON.parse(
      await readFile(join(root, "dist/site/.well-known/hra.json"), "utf8"),
    ) as { source?: { commit?: unknown } };

    expect(identity.source?.commit).toBe(commit);
    await expect(buildSite({
      check: false,
      releaseCommit: "not-a-commit",
      repositoryRoot: root,
      sourceRoot,
    })).rejects.toThrow("Release commit");
  });

  compilerCase("fails Production closed without valid public analytics and mailing configuration", async ({ buildSite, createFixtureRoot }) => {
    const validToken = "phc_public_production_token";
    expect(resolveOompaAnalyticsProjectToken({ VERCEL_ENV: "preview" })).toBe("");
    expect(resolveOompaAnalyticsProjectToken({
      [OOMPA_POSTHOG_PROJECT_TOKEN_ENV]: validToken,
      VERCEL_ENV: "preview",
    })).toBe("");
    expect(resolveOompaAnalyticsProjectToken({
      [OOMPA_POSTHOG_PROJECT_TOKEN_ENV]: validToken,
      VERCEL_ENV: "production",
    })).toBe(validToken);

    for (const projectToken of [undefined, "", "phx_private", "not-a-token"]) {
      const root = await createFixtureRoot();
      await expect(buildSite({
        check: false,
        environment: {
          [OOMPA_POSTHOG_PROJECT_TOKEN_ENV]: projectToken,
          VERCEL_ENV: "production",
        },
        repositoryRoot: root,
        sourceRoot,
      })).rejects.toThrow(OOMPA_POSTHOG_PROJECT_TOKEN_ENV);
    }

    const missingTurnstileRoot = await createFixtureRoot();
    await expect(buildSite({
      check: false,
      environment: {
        [OOMPA_POSTHOG_PROJECT_TOKEN_ENV]: validToken,
        VERCEL_ENV: "production",
      },
      repositoryRoot: missingTurnstileRoot,
      sourceRoot,
    })).rejects.toThrow(OOMPA_MAILING_TURNSTILE_SITEKEY_ENV);
  });

  compilerCase("embeds only the public token in the self-hosted Production bundle", async ({ buildSite, createFixtureRoot }) => {
    const root = await createFixtureRoot();
    const publicToken = "phc_public_production_token";
    await buildSite({
      check: false,
      environment: {
        [OOMPA_MAILING_TURNSTILE_SITEKEY_ENV]: "1x00000000000000000000AA",
        [OOMPA_POSTHOG_PROJECT_TOKEN_ENV]: publicToken,
        VERCEL_ENV: "production",
      },
      repositoryRoot: root,
      sourceRoot,
    });

    const analytics = await readFile(join(root, "dist/site/analytics.js"), "utf8");
    const html = await readFile(join(root, "dist/site/index.html"), "utf8");
    expect(analytics).toContain(publicToken);
    expect(analytics).not.toMatch(/\bphx_[A-Za-z0-9_-]+\b/u);
    expect(analytics).not.toContain("POSTHOG_API_KEY");
    expect(html).toContain('data-mailing-list="signup"');
    expect(html).toContain(
      'src="https://challenges.cloudflare.com/turnstile/v0/api.js"',
    );
  });

  compilerCase("keeps the hosted identity marker at the fixed release-evidence version", async ({ buildSite, createFixtureRoot }) => {
    const root = await createFixtureRoot();
    await buildSite({ check: false, repositoryRoot: root, sourceRoot });
    const identity = JSON.parse(
      await readFile(join(root, "dist/site/.well-known/hra.json"), "utf8"),
    ) as { version?: unknown };
    // The canonical-alias operator proves this literal after every cutover;
    // it is independent of the package version in package.json.
    expect(identity.version).toBe(OOMPA_RELEASE_VERSION);
    expect(identity.version).toBe("0.1.0");
    expect(await readPackageVersion()).not.toBe(identity.version);
  });

  compilerCase("does not publish the retired adjacent-reading cluster", async ({ buildSite, createFixtureRoot }) => {
    const root = await createFixtureRoot();
    await buildSite({ check: false, repositoryRoot: root, sourceRoot });
    const publicDocuments = await Promise.all([
      "dist/site/index.html",
      "dist/site/llms.txt",
      "dist/site/sitemap.xml",
    ].map(async (path) => readFile(join(root, path), "utf8")));
    const retiredRoutes = [
      "/reading/deepseek-harness/",
      "/reading/hax/",
      "/reading/headlong-microharness/",
      "/reading/oracle-and-firm/",
    ] as const;

    for (const route of retiredRoutes) {
      for (const document of publicDocuments) {
        expect(document).not.toContain(route);
      }
      await expect(readFile(join(root, "dist/site", route, "index.html"), "utf8"))
        .rejects.toThrow();
    }
  });

  compilerCase("reconstructs the owned site output without stale retired artifacts", async ({ buildSite, createFixtureRoot }) => {
    const root = await createFixtureRoot();
    const stalePaths = [
      "dist/site/reading/index.html",
      "dist/site/reading/deepseek-harness/index.html",
      "dist/site/images/editorial/deepseek-harness.webp",
      "dist/site/docs/removed/index.html",
      "dist/site/examples/app/complete/stylex-complete.json",
      "dist/site/examples/app/graphs/client/assets/stale.js",
    ] as const;
    for (const path of stalePaths) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), "stale retired artifact\n", "utf8");
    }

    await buildSite({ check: false, repositoryRoot: root, sourceRoot });

    for (const path of stalePaths) {
      await expect(readFile(join(root, path), "utf8")).rejects.toThrow();
    }
    const html = await readFile(join(root, "dist/site/index.html"), "utf8");
    expect(compiledStylesheetJoin(html).authoredHtml).toBe(renderSiteHtml());
  });

  compilerCase("generates the inert preview without publishing it as an indexable document", async ({ buildSite, createFixtureRoot }) => {
    const root = await createFixtureRoot();
    await buildSite({ check: false, repositoryRoot: root, sourceRoot });
    const preview = await readFile(join(root, "dist/site/preview/index.html"), "utf8");
    const sitemap = await readFile(join(root, "dist/site/sitemap.xml"), "utf8");

    expect(compiledStylesheetJoin(preview).authoredHtml).toBe(renderPreviewHtml());
    expect(preview).toContain('<meta name="robots" content="noindex, nofollow">');
    expect(preview).toContain('<link rel="canonical" href="https://oompa.app/">');
    expect(preview).not.toContain("/analytics.js");
    expect(sitemap).not.toContain("/preview");
  });

  compilerCase("passes check mode in a clean clone without ignored build output", async ({ buildSite, createFixtureRoot }) => {
    const root = await createFixtureRoot();
    await buildSite({ check: false, repositoryRoot: root, sourceRoot });
    await rm(join(root, "dist"), { force: true, recursive: true });

    expect(await buildSite({ check: true, repositoryRoot: root, sourceRoot })).toEqual([]);
  });

  compilerCase("reports stale tracked public documents without repairing build output", async ({ buildSite, createFixtureRoot }) => {
    const root = await createFixtureRoot();
    await buildSite({ check: false, repositoryRoot: root, sourceRoot });
    await writeFile(join(root, "PRIVACY.md"), "stale\n", "utf8");
    await writeFile(join(root, "dist/site/stylex.css"), "stale\n", "utf8");

    const mismatches = await buildSite({ check: true, repositoryRoot: root, sourceRoot });
    expect(mismatches).toEqual([join(root, "PRIVACY.md")]);
    expect(await readFile(join(root, "PRIVACY.md"), "utf8")).toBe("stale\n");
    expect(await readFile(join(root, "dist/site/stylex.css"), "utf8")).toBe("stale\n");
  });

  test("admits only owned browser entries, configured Turnstile, and restrictive response headers", async () => {
    const repositoryRoot = join(import.meta.dir, "..");
    const html = renderSiteHtml();
    const css = await readFile(join(repositoryRoot, "site/styles.css"), "utf8");
    const vercel = JSON.parse(
      await readFile(join(repositoryRoot, "vercel.json"), "utf8"),
    ) as { headers?: unknown };

    expect(html.match(/<script[^>]+src=/gu)).toHaveLength(3);
    expect(html).toContain('<script src="/appearance.js"></script>');
    expect(html).toContain(renderOompaAnalyticsScript());
    expect(html).toContain('src="/site.js"');
    expect(renderPreviewHtml()).not.toContain(renderOompaAnalyticsScript());
    expect(renderPreviewHtml()).not.toContain('src="/site.js"');
    expect(renderPreviewHtml()).not.toContain('src="/appearance.js"');
    expect(renderOompaSiteFooter({
      [OOMPA_MAILING_TURNSTILE_SITEKEY_ENV]: "1x00000000000000000000AA",
    })).toContain(
      'src="https://challenges.cloudflare.com/turnstile/v0/api.js"',
    );
    expect(html).not.toMatch(/<link[^>]+rel="(?:icon|stylesheet)"[^>]+href="https?:\/\//);
    expect(css).not.toMatch(/url\(["']?https?:\/\//);
    expect(css).toContain('--font-sans: "Nebula Sans", ui-sans-serif, system-ui');
    expect(css).toContain("font-family: var(--font-sans);");
    expect(css).not.toMatch(/font-family:\s*ui-sans-serif/u);
    expect(css).toContain('--font-mono: ui-monospace, "SFMono-Regular"');
    expect(renderSocialCardSvg())
      .toContain('font-family="Nebula Sans, ui-sans-serif, system-ui, sans-serif"');
    expect(vercel.headers).toEqual([
      {
        source: "/preview/",
        headers: [
          {
            key: "Content-Security-Policy",
            value: "default-src 'none'; base-uri 'none'; connect-src 'none'; font-src 'self'; form-action 'none'; frame-ancestors https://hraness.com https://www.hraness.com; img-src 'self' data:; manifest-src 'self'; script-src 'none'; style-src 'self'",
          },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
          },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
        ],
      },
      {
        source: "/examples/app/:path(.*)",
        headers: [
          {
            key: "Content-Security-Policy",
            value: "default-src 'none'; script-src 'self'; style-src 'self'; img-src data: blob:; font-src 'self'; connect-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; frame-ancestors 'self'",
          },
          { key: "Access-Control-Allow-Origin", value: "*" },
          {
            key: "Permissions-Policy",
            value: "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
          },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
        ],
      },
      {
        source: "/((?!preview/?$|examples/app(?:/|$)).*)",
        headers: [
          {
            key: "Content-Security-Policy",
            value: "default-src 'none'; base-uri 'none'; connect-src https://us.i.posthog.com; font-src 'self'; form-action https://account.hraness.com; frame-ancestors 'none'; frame-src 'self' https://challenges.cloudflare.com; img-src 'self' data:; manifest-src 'self'; script-src 'self' https://challenges.cloudflare.com; style-src 'self'",
          },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
          },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
    ]);
    const parentRule = new RegExp("^/((?!preview/?$|examples/app(?:/|$)).*)$");
    for (const path of ["/preview", "/preview/", "/examples/app", "/examples/app/", "/examples/app/graphs/client/assets/main.js"]) {
      expect(parentRule.test(path)).toBe(false);
    }
    for (const path of ["/", "/docs/", "/preview/private", "/examples/application/", "/examples/app-private/", "/examples/app.js"]) {
      expect(parentRule.test(path)).toBe(true);
    }
  });
});
