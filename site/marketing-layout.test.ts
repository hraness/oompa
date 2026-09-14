import { expect, test } from "bun:test";
import { createStylexTransformCollector } from "@hraness/ui/stylex-build";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

async function compiledCss(file: string): Promise<string> {
  const path = resolve(import.meta.dir, file);
  const result = await createStylexTransformCollector(root).transform(await readFile(path, "utf8"), path);
  expect(result.code).not.toContain("stylex.inject(");
  return result.rules.map(([, rule]) => rule.ltr).join("\n").replaceAll(/\s+/gu, "");
}

test("the shared hero receives compact outer spacing through the public compiler", async () => {
  const css = await compiledCss("marketing.stylex.ts");
  expect(css).toContain(":is(header)");
  expect(css).toContain("padding-block:var(--hraness-marketing-hero-space,3.5rem4rem)");
  expect(css).toContain("gap:clamp(1.5rem,3vw,2.5rem)");
});

test("preview controls compile readable labels, touch targets and distinct disabled and focus states", async () => {
  const css = await compiledCss("product-preview.stylex.ts");
  expect(css).toContain("min-height:2.75rem");
  expect(css).toContain("font-size:.875rem");
  expect(css).toContain(":disabled");
  expect(css).toContain("cursor:default");
  expect(css).toContain(":focus-visible");
  expect(css).toContain("outline-color:var(--focus)");
  expect(css).toContain("outline-width:2px");
});
