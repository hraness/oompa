import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { parseHTML } from "linkedom";

describe("Oompa canonical mark", () => {
  test("uses the governed hra mark with self-contained path geometry", async () => {
    const source = await readFile(new URL("./favicon.svg", import.meta.url), "utf8");
    const mark = await readFile(new URL("./marks/hra.svg", import.meta.url), "utf8");
    expect(source).toBe(mark);
    const { document } = parseHTML(source);
    const svg = document.querySelector("svg");
    expect(svg?.getAttribute("viewBox")).toBe("0 0 606 575");
    expect(svg?.querySelector("path")).not.toBeNull();
    // Geometry is local and static. No font, emoji renderer, external asset,
    // executable element or theme-specific background defines the mark.
    expect(document.querySelector("script, style, image, use, foreignObject, text, mask")).toBeNull();
    expect(source).not.toMatch(/(?:href|on\w+)\s*=|url\(/iu);
  });
});
