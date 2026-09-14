/**
 * Social card composition for oompa.app.
 *
 * Link unfurlers on X, LinkedIn, Slack, iMessage, and Discord render PNG
 * previews but not SVG, so the build rasterizes this card to a 1200x630 PNG
 * with the vendored Nebula Sans outlines. The same composition also renders
 * the legacy SVG path so an older cached `og:image` URL keeps resolving.
 */

import { nebulaSansSocialFonts } from "@hraness/design-kit/fonts/nebula-sans/social";
import { paletteColors } from "@hraness/design-kit";

import { publicContent, type PublicContent } from "./content.ts";
import { parseOpenTypeOutlineFont, type OutlineFont } from "./social-card-font.ts";
import {
  Canvas,
  drawText,
  encodePng,
  measureText,
  parseHexColor,
} from "./social-card-raster.ts";

export const SOCIAL_CARD_WIDTH = 1200;
export const SOCIAL_CARD_HEIGHT = 630;

const palette = {
  background: paletteColors.catppuccin.dark.background,
  ink: paletteColors.catppuccin.dark.foreground,
  muted: paletteColors.catppuccin.dark.muted,
  panel: paletteColors.catppuccin.dark.surfaceRaised,
  panelComment: paletteColors.catppuccin.dark.muted,
  panelText: paletteColors.catppuccin.dark.foreground,
} as const;

const layout = {
  commandBaselines: [302, 350, 398] as const,
  commandSize: 27,
  commandX: 128,
  margin: 88,
  panel: { height: 196, radius: 14, width: 1024, y: 236 },
  tagBaseline: 520,
  tagSize: 30,
  titleBaseline: 176,
  titleSize: 116,
} as const;

export interface SocialCardLines {
  readonly commands: readonly [string, string];
  readonly comment: string;
  readonly tagline: string;
  readonly title: string;
}

export const socialCardLines = (content: PublicContent = publicContent): SocialCardLines => {
  return {
    commands: [`$ ${content.doctorCommand}`, "$ oompa status --json"],
    comment: "# Daemon rollout blocked on capacity",
    tagline: `CLI candidate v${content.releaseVersion} · oompa.app`,
    title: content.productName,
  };
};

interface CardFonts {
  readonly bold: OutlineFont;
  readonly book: OutlineFont;
}

let cachedFonts: CardFonts | undefined;

export const socialCardFonts = (): CardFonts => {
  if (cachedFonts !== undefined) return cachedFonts;
  let book: OutlineFont | undefined;
  let bold: OutlineFont | undefined;
  for (const font of nebulaSansSocialFonts()) {
    if (font.weight === 400) book = parseOpenTypeOutlineFont(font.data);
    if (font.weight === 700) bold = parseOpenTypeOutlineFont(font.data);
  }
  if (book === undefined || bold === undefined) {
    throw new Error("The design kit must provide Nebula Sans Book and Bold outlines.");
  }
  cachedFonts = { bold, book };
  return cachedFonts;
};

/** Widest text run the card allows inside the panel and across the tagline row. */
export const socialCardMaxTextWidth = layout.panel.width - 2 * (layout.commandX - layout.margin);

/** Measures every card line at its rendered size so tests can prove the text fits. */
export const socialCardLineWidths = (content: PublicContent = publicContent): readonly number[] => {
  const fonts = socialCardFonts();
  const lines = socialCardLines(content);
  return [
    measureText(fonts.bold, lines.title, layout.titleSize),
    ...lines.commands.map((command) => measureText(fonts.book, command, layout.commandSize)),
    measureText(fonts.book, lines.comment, layout.commandSize),
    measureText(fonts.book, lines.tagline, layout.tagSize),
  ];
};

export const renderSocialCardPng = (content: PublicContent = publicContent): Uint8Array => {
  const fonts = socialCardFonts();
  const lines = socialCardLines(content);
  const canvas = new Canvas(SOCIAL_CARD_WIDTH, SOCIAL_CARD_HEIGHT, parseHexColor(palette.background));

  drawText(canvas, fonts.bold, lines.title, layout.margin, layout.titleBaseline, layout.titleSize, parseHexColor(palette.ink));
  canvas.fillRoundedRect(
    layout.margin,
    layout.panel.y,
    layout.panel.width,
    layout.panel.height,
    layout.panel.radius,
    parseHexColor(palette.panel),
  );
  const [commentBaseline, firstBaseline, secondBaseline] = layout.commandBaselines;
  const [firstCommand, secondCommand] = lines.commands;
  drawText(canvas, fonts.book, lines.comment, layout.commandX, commentBaseline, layout.commandSize, parseHexColor(palette.panelComment));
  drawText(canvas, fonts.book, firstCommand, layout.commandX, firstBaseline, layout.commandSize, parseHexColor(palette.panelText));
  drawText(canvas, fonts.book, secondCommand, layout.commandX, secondBaseline, layout.commandSize, parseHexColor(palette.panelText));
  drawText(canvas, fonts.book, lines.tagline, layout.margin, layout.tagBaseline, layout.tagSize, parseHexColor(palette.muted));

  return encodePng(SOCIAL_CARD_WIDTH, SOCIAL_CARD_HEIGHT, canvas.toRgbBytes());
};

const escapeXml = (value: string): string => value
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&apos;");

const sansFamily = "Nebula Sans, ui-sans-serif, system-ui, sans-serif";

/** Renders the same composition as SVG for the legacy `/social-card.svg` path. */
export const renderSocialCardSvg = (content: PublicContent = publicContent): string => {
  const lines = socialCardLines(content);
  const [commentBaseline, firstBaseline, secondBaseline] = layout.commandBaselines;
  const [firstCommand, secondCommand] = lines.commands;
  const textLine = (text: string, x: number, y: number, size: number, fill: string, weight = 400): string =>
    `  <text x="${x}" y="${y}" fill="${fill}" font-family="${sansFamily}" font-size="${size}" font-weight="${weight}">${escapeXml(text)}</text>`;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SOCIAL_CARD_WIDTH} ${SOCIAL_CARD_HEIGHT}" width="${SOCIAL_CARD_WIDTH}" height="${SOCIAL_CARD_HEIGHT}" role="img" aria-labelledby="title description">`,
    `  <title id="title">${escapeXml(lines.title)}</title>`,
    `  <desc id="description">${escapeXml(content.socialCard.alt)}</desc>`,
    `  <rect width="${SOCIAL_CARD_WIDTH}" height="${SOCIAL_CARD_HEIGHT}" fill="${palette.background}"/>`,
    textLine(lines.title, layout.margin, layout.titleBaseline, layout.titleSize, palette.ink, 700),
    `  <rect x="${layout.margin}" y="${layout.panel.y}" width="${layout.panel.width}" height="${layout.panel.height}" rx="${layout.panel.radius}" fill="${palette.panel}"/>`,
    textLine(lines.comment, layout.commandX, commentBaseline, layout.commandSize, palette.panelComment),
    textLine(firstCommand, layout.commandX, firstBaseline, layout.commandSize, palette.panelText),
    textLine(secondCommand, layout.commandX, secondBaseline, layout.commandSize, palette.panelText),
    textLine(lines.tagline, layout.margin, layout.tagBaseline, layout.tagSize, palette.muted),
    "</svg>",
    "",
  ].join("\n");
};
