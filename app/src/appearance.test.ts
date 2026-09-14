import { expect, test } from "bun:test";
import assert from "node:assert/strict";

async function assertDefaultShell(source: string): Promise<void> {
  const palettes: (string | null)[] = [];
  const themes: (string | null)[] = [];
  const schemes: (string | null)[] = [];
  await new HTMLRewriter()
    .on("html", { element(element) {
      palettes.push(element.getAttribute("data-palette"));
      themes.push(element.getAttribute("data-theme"));
    } })
    .on('meta[name="color-scheme"]', { element(element) { schemes.push(element.getAttribute("content")); } })
    .transform(new Response(source)).arrayBuffer();
  assert.deepEqual(palettes, ["paper"], "Oompa must select its default palette before bootstrap delivery");
  assert.deepEqual(themes, ["light"], "Oompa must select its light fallback until the System or saved preference bootstrap runs");
  assert.deepEqual(schemes, ["dark light"], "Oompa must support both selectable appearances");
}

test("the authored shell names Paper light before the saved preference bootstrap", async () => {
  const source = await Bun.file(new URL("../index.html", import.meta.url)).text();
  await assertDefaultShell(source);
});

test("appearance proof rejects absent defaults and a fixed light-only or dark-only scheme", async () => {
  const source = await Bun.file(new URL("../index.html", import.meta.url)).text();
  for (const changed of [
    source.replace(' data-palette="paper"', ""),
    source.replace('data-palette="paper"', 'data-palette="gruvbox"'),
    source.replace(' data-theme="light"', ""),
    source.replace('data-theme="light"', 'data-theme="dark"'),
    source.replace('name="color-scheme" content="dark light"', 'name="color-scheme" content="dark"'),
    source.replace('name="color-scheme" content="dark light"', 'name="color-scheme" content="light"'),
  ]) await expect(assertDefaultShell(changed)).rejects.toThrow();
});

test("the compiler palette entry joins shared roles without fonts or standalone recipes", async () => {
  const foundationUrl = new URL(import.meta.resolve("@hraness/design-kit/compiler-palettes.css"));
  const foundation = await Bun.file(foundationUrl).text();
  expect(foundation).toContain('@import "@hraness/ui/compiler-foundation.css";');
  expect(foundation).toContain('@import "./palette-bridge.css";');
  expect(foundation).not.toContain("dist/stylex.css");
  expect(foundation).not.toMatch(/@font-face|@import\s+["'][^"']*fonts/iu);
  expect(foundation).not.toMatch(/@import\s+["'][^"']*compiler-tokens/iu);
  const bridge = await Bun.file(new URL("./palette-bridge.css", foundationUrl)).text();
  expect(bridge).toContain("hraness-palette");
  expect(bridge).toContain("--primary:");
  expect(bridge).toContain("--focus:");
  const appCss = await Bun.file(new URL("./index.css", import.meta.url)).text();
  expect(appCss).toContain("--color-surface: var(--background)");
  expect(appCss).toContain("--color-accent: var(--primary)");
  expect(appCss).toContain("outline: 2px solid var(--focus)");
  expect(appCss).not.toMatch(/color-scheme:\s*dark/u);
});
