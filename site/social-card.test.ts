import { paletteColors } from "@hraness/design-kit";
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";

import { publicContent } from "./content.ts";
import { parseOpenTypeOutlineFont, SocialCardFontError } from "./social-card-font.ts";
import {
  Canvas,
  drawText,
  encodePng,
  measureText,
  parseHexColor,
  readPngDimensions,
  SocialCardRasterError,
} from "./social-card-raster.ts";
import {
  renderSocialCardPng,
  renderSocialCardSvg,
  SOCIAL_CARD_HEIGHT,
  SOCIAL_CARD_WIDTH,
  socialCardFonts,
  socialCardLines,
  socialCardLineWidths,
  socialCardMaxTextWidth,
} from "./social-card.ts";

const decodeRgb = (png: Uint8Array): { readonly rgb: Uint8Array; readonly height: number; readonly width: number } => {
  const { height, width } = readPngDimensions(png);
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let offset = 8;
  const idat: Uint8Array[] = [];
  while (offset < png.byteLength) {
    const length = view.getUint32(offset);
    const type = new TextDecoder().decode(png.subarray(offset + 4, offset + 8));
    if (type === "IDAT") idat.push(png.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  const raw = new Uint8Array(inflateSync(Buffer.concat(idat.map((chunk) => Buffer.from(chunk)))));
  const stride = width * 3;
  const rgb = new Uint8Array(stride * height);
  for (let row = 0; row < height; row += 1) {
    expect(raw[row * (stride + 1)]).toBe(0);
    rgb.set(raw.subarray(row * (stride + 1) + 1, (row + 1) * (stride + 1)), row * stride);
  }
  return { height, rgb, width };
};

const pixelAt = (image: { readonly rgb: Uint8Array; readonly width: number }, x: number, y: number): readonly [number, number, number] => {
  const offset = (y * image.width + x) * 3;
  return [image.rgb[offset] ?? -1, image.rgb[offset + 1] ?? -1, image.rgb[offset + 2] ?? -1];
};

describe("social card", () => {
  test("renders a deterministic 1200x630 PNG under 200 KiB", () => {
    const first = renderSocialCardPng();
    const second = renderSocialCardPng();
    expect(readPngDimensions(first)).toEqual({ height: 630, width: 1200 });
    expect(SOCIAL_CARD_WIDTH).toBe(publicContent.socialCard.width);
    expect(SOCIAL_CARD_HEIGHT).toBe(publicContent.socialCard.height);
    expect(first.byteLength).toBeLessThan(200 * 1024);
    expect(createHash("sha256").update(first).digest("hex"))
      .toBe(createHash("sha256").update(second).digest("hex"));
  });

  test("paints the default dark theme with visible glyphs where the text sits", () => {
    const image = decodeRgb(renderSocialCardPng());
    expect(image.width).toBe(1200);
    expect(image.height).toBe(630);
    expect(pixelAt(image, 4, 4)).toEqual([...parseHexColor(paletteColors.catppuccin.dark.background)]);
    expect(pixelAt(image, 600, 420)).toEqual([...parseHexColor(paletteColors.catppuccin.dark.surfaceRaised)]);

    const lightPixelsIn = (x0: number, y0: number, x1: number, y1: number): number => {
      let count = 0;
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          const [red] = pixelAt(image, x, y);
          if (red > 160) count += 1;
        }
      }
      return count;
    };
    expect(lightPixelsIn(88, 90, 520, 180)).toBeGreaterThan(4_000);
    expect(lightPixelsIn(560, 90, 1100, 180)).toBe(0);
    // The muted description owns the first row; read-only commands follow it.
    expect(lightPixelsIn(128, 280, 700, 306)).toBeGreaterThan(300);
    expect(lightPixelsIn(128, 328, 700, 354)).toBeGreaterThan(500);
    // Brightness thresholds select different anti-aliased edge pixels after a
    // palette change. Pin this literal release's geometry independently of
    // its colors, then compare the actual row against the same coverage.
    const mask = new Canvas(1200, 630, parseHexColor("#000000"));
    drawText(mask, socialCardFonts().book, "CLI candidate v0.8.5 · oompa.app", 88, 520, 30, parseHexColor("#ffffff"));
    const coverage = new Uint8Array((940 - 88) * (525 - 495));
    const background = parseHexColor(paletteColors.catppuccin.dark.background);
    const foreground = parseHexColor(paletteColors.catppuccin.dark.muted);
    let offset = 0;
    let mismatchedChannels = 0;
    for (let y = 495; y < 525; y += 1) {
      for (let x = 88; x < 940; x += 1) {
        const alphaByte = mask.pixels[(y * mask.width + x) * 3]!;
        coverage[offset++] = alphaByte;
        const actual = pixelAt(image, x, y);
        for (const channel of [0, 1, 2] as const) {
          const expected = Math.round(background[channel] + (foreground[channel] - background[channel]) * alphaByte / 255);
          // The independent 8-bit coverage mask introduces at most one channel
          // unit of rounding relative to the rasterizer's full-precision alpha.
          if (Math.abs(actual[channel] - expected) > 1) mismatchedChannels += 1;
        }
      }
    }
    expect(createHash("sha256").update(coverage).digest("hex"))
      .toBe("fee95d10f774e7271af69650bf34643517c4bf8b76093f3f03409a16d732aa2c");
    expect(mismatchedChannels).toBe(0);
    const luminance = (color: readonly [number, number, number]): number => color.reduce((sum, channel, index) => {
      const value = channel / 255;
      const linear = value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      return sum + linear * [0.2126, 0.7152, 0.0722][index]!;
    }, 0);
    const ink = luminance(foreground);
    const surface = luminance(background);
    expect((Math.max(ink, surface) + 0.05) / (Math.min(ink, surface) + 0.05)).toBeGreaterThanOrEqual(4.5);
  });

  test("keeps every card line inside its row and states the exact positioning text", () => {
    const lines = socialCardLines();
    expect(lines.tagline).toBe("CLI candidate v0.8.5 · oompa.app");
    expect(lines.title).toBe("Oompa");
    expect(lines.comment).toBe("# Daemon rollout blocked on capacity");
    expect(lines.commands).toEqual([
      `$ ${publicContent.doctorCommand}`,
      "$ oompa status --json",
    ]);
    for (const width of socialCardLineWidths()) {
      expect(width).toBeGreaterThan(0);
      expect(width).toBeLessThanOrEqual(socialCardMaxTextWidth);
    }
    for (const value of [lines.tagline, lines.comment, ...lines.commands]) {
      expect(value).not.toContain("\u2014");
    }
  });

  test("renders the legacy SVG from the same composition", () => {
    const svg = renderSocialCardSvg();
    expect(svg).toStartWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630"');
    expect(svg).toContain("<title id=\"title\">Oompa</title>");
    expect(svg).toContain(`<desc id="description">${publicContent.socialCard.alt}</desc>`);
    expect(svg).toContain("$ oompa status --json");
    expect(svg.indexOf("# Daemon rollout blocked on capacity")).toBeLessThan(
      svg.indexOf("$ oompa doctor --offline"),
    );
    expect(svg).toMatch(/<text x="128" y="302"[^>]*># Daemon rollout blocked on capacity<\/text>/u);
    expect(svg).toMatch(/<text x="128" y="350"[^>]*>\$ oompa doctor --offline/u);
    expect(svg).toContain('font-family="Nebula Sans, ui-sans-serif, system-ui, sans-serif"');
    expect(svg).not.toContain("<script");
    expect(svg).not.toContain("url(");
  });

  test("parses the vendored Nebula Sans outlines with bounded metrics", () => {
    const fonts = socialCardFonts();
    for (const font of [fonts.book, fonts.bold]) {
      expect(font.unitsPerEm).toBe(1000);
      expect(font.ascender).toBeGreaterThan(0);
      expect(font.descender).toBeLessThan(0);
      const h = font.glyph("H".codePointAt(0)!);
      expect(h?.advance).toBeGreaterThan(0);
      expect(h?.commands.length).toBeGreaterThan(4);
      expect(h?.commands[0]?.kind).toBe("move");
      expect(font.glyph(0x1f600)).toBeUndefined();
      const space = font.glyph(0x20);
      expect(space?.advance).toBeGreaterThan(0);
      expect(space?.commands).toEqual([]);
    }
    expect(measureText(fonts.bold, "Oompa", 116)).toBeGreaterThan(measureText(fonts.book, "Oompa", 116));
    expect(measureText(fonts.book, "", 30)).toBe(0);
  });

  test("fails closed on truncated, foreign, or oversized font payloads", () => {
    expect(() => parseOpenTypeOutlineFont(new Uint8Array(4))).toThrow(SocialCardFontError);
    expect(() => parseOpenTypeOutlineFont(new TextEncoder().encode("true".padEnd(64, "\0"))))
      .toThrow(SocialCardFontError);
    const truncated = new TextEncoder().encode("OTTO".padEnd(64, "\0"));
    truncated[5] = 3;
    expect(() => parseOpenTypeOutlineFont(truncated)).toThrow(SocialCardFontError);
    expect(() => parseOpenTypeOutlineFont(new Uint8Array(4_000_001))).toThrow(SocialCardFontError);
  });

  test("refuses missing glyphs, malformed colors, and out-of-bound canvases", () => {
    const fonts = socialCardFonts();
    const canvas = new Canvas(8, 8, parseHexColor("#ffffff"));
    expect(() => drawText(canvas, fonts.book, "\u{1F600}", 0, 6, 6, parseHexColor("#000000")))
      .toThrow(SocialCardRasterError);
    expect(() => measureText(fonts.book, "\u{1F600}", 6)).toThrow(SocialCardRasterError);
    expect(() => parseHexColor("red")).toThrow(SocialCardRasterError);
    expect(() => new Canvas(0, 8, parseHexColor("#ffffff"))).toThrow(SocialCardRasterError);
    expect(() => new Canvas(4_001, 1_000, parseHexColor("#ffffff"))).toThrow(SocialCardRasterError);
    expect(() => encodePng(2, 2, new Uint8Array(5))).toThrow(SocialCardRasterError);
    expect(() => readPngDimensions(new Uint8Array(30))).toThrow(SocialCardRasterError);
  });

  test("anti-aliases a half-covered pixel and fills a rectangle exactly", () => {
    const canvas = new Canvas(4, 4, parseHexColor("#ffffff"));
    canvas.fillRect(1, 1, 2, 2, parseHexColor("#000000"));
    const image = decodeRgb(encodePng(4, 4, canvas.toRgbBytes()));
    expect(pixelAt(image, 0, 0)).toEqual([255, 255, 255]);
    expect(pixelAt(image, 1, 1)).toEqual([0, 0, 0]);
    expect(pixelAt(image, 2, 2)).toEqual([0, 0, 0]);
    expect(pixelAt(image, 3, 3)).toEqual([255, 255, 255]);

    const half = new Canvas(2, 1, parseHexColor("#ffffff"));
    half.fillRect(0.5, 0, 1, 1, parseHexColor("#000000"));
    const halfImage = decodeRgb(encodePng(2, 1, half.toRgbBytes()));
    expect(pixelAt(halfImage, 0, 0)[0]).toBeGreaterThan(120);
    expect(pixelAt(halfImage, 0, 0)[0]).toBeLessThan(136);
    expect(pixelAt(halfImage, 1, 0)[0]).toBeGreaterThan(120);
    expect(pixelAt(halfImage, 1, 0)[0]).toBeLessThan(136);
  });
});
