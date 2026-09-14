import { describe, expect, test } from "bun:test";
import { designPaletteLabels, designPalettes, getDesignPaletteTheme } from "@hraness/design-kit";
import { createStylexTransformCollector } from "@hraness/ui/stylex-build";
import { parseHTML } from "linkedom";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { renderDocsPages, renderPreviewHtml, renderPrivacyHtml, renderSiteHtml } from "./template";

describe("public appearance delivery", () => {
  test("the public compiler owns every native menu atom and its focus and viewport constraints", async () => {
    const path = fileURLToPath(new URL("../app/src/components/appearance-menu.stylex.ts", import.meta.url));
    const collector = createStylexTransformCollector(fileURLToPath(new URL("..", import.meta.url)));
    const compiled = await collector.transform(await readFile(path, "utf8"), path);
    const css = compiled.rules.map(([, rule]) => rule.ltr).join("\n");
    const { document } = parseHTML(renderSiteHtml());
    const menu = document.querySelector("[data-oompa-appearance]")!;
    for (const element of [menu, ...menu.querySelectorAll("[class]")]) {
      for (const className of element.classList) expect(css).toContain(`.${className}`);
    }
    expect(css).toContain(":focus-visible");
    expect(css).toContain("outline-color:var(--focus)");
    expect(css).toContain("::-webkit-details-marker{display:none}");
    expect(css).toContain("min-height:2.75rem");
    expect(css.replaceAll(" ", "")).toContain("width:min(18rem,calc(100vw-2rem))");
    expect(compiled.code).not.toMatch(/stylex\.(?:create|inject)\(/u);
  });

  test("public pages expose one native header menu and a blocking external bootstrap", () => {
    for (const html of [renderSiteHtml(), renderPrivacyHtml(), ...Object.values(renderDocsPages())]) {
      const { document } = parseHTML(html);
      expect(document.documentElement.dataset.hranessTheme).toBe("paper");
      expect(document.documentElement.dataset.palette).toBe("paper");
      expect(document.documentElement.dataset.theme).toBe("light");
      const menus = document.querySelectorAll("details[data-oompa-appearance]");
      expect(menus.length).toBe(1);
      const menu = menus[0]!;
      expect(menu.closest("header")).not.toBeNull();
      expect(menu.nextElementSibling).toBeNull();
      const palettes = menu.querySelectorAll("select[data-oompa-palette] option");
      expect([...palettes].map((option) => option.getAttribute("value"))).toEqual([...designPalettes]);
      expect([...palettes].map((option) => option.textContent)).toEqual(designPalettes.map((palette) => designPaletteLabels[palette]));
      expect(menu.querySelectorAll("select[data-oompa-mode] option").length).toBe(3);
      expect(menu.querySelector("select[data-oompa-palette] option[selected]")?.getAttribute("value")).toBe("paper");
      expect(menu.querySelector("select[data-oompa-mode] option[selected]")?.getAttribute("value")).toBe("system");
      const bootstrap = document.head.querySelector('script[src="/appearance.js"]');
      expect(bootstrap).not.toBeNull();
      expect(bootstrap?.hasAttribute("async")).toBe(false);
      expect(bootstrap?.hasAttribute("defer")).toBe(false);
      expect(bootstrap?.hasAttribute("type")).toBe(false);
      expect(document.querySelectorAll("[style],style").length).toBe(0);
    }
  });

  test("the inert preview carries the complete default palette without controls or scripts", () => {
    const { document } = parseHTML(renderPreviewHtml());
    const theme = getDesignPaletteTheme("catppuccin", "dark");
    expect(document.documentElement.getAttribute("data-palette")).toBe("catppuccin");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    for (const token of theme.className.split(/\s+/u)) expect(document.documentElement.classList.contains(token)).toBe(true);
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute("content")).toBe(theme.background);
    expect(document.querySelectorAll("script,button,select,details,a[href],input,textarea").length).toBe(0);
  });
});
