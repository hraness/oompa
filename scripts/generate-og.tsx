import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createSocialImageCard } from "@hraness/web-discovery/social-image/card";
import { Resvg } from "@resvg/resvg-js";
import satori from "satori";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const outputPath = join(repositoryRoot, "site", "og.png");

const mark = (
  <svg aria-label="Oompa" height="42" role="img" viewBox="0 0 64 64" width="42">
    <circle cx="32" cy="32" r="27" fill="#f58220" stroke="#ad430d" strokeWidth="2" />
  </svg>
);

const card = createSocialImageCard({
  description:
    "Oompa brings your Codex and Claude Code sessions into one workspace. Follow the work in your browser, direct it from your terminal, and keep execution on your own machines.",
  domain: "oompa.app",
  eyebrow: "Oompa",
  mark,
  theme: {
    accent: "#f58220",
    background: "#1e1e2e",
    foreground: "#cdd6f4",
    muted: "#a6adc8",
  },
  title: "Oompa | Workspace for Codex and Claude Code",
});

const svg = await satori(card.element, {
  fonts: card.fonts.map((font) => ({
    data: font.data,
    name: font.name,
    style: font.style,
    weight: font.weight,
  })),
  height: card.height,
  width: card.width,
});
const png = new Resvg(svg).render().asPng();
await writeFile(outputPath, png);
console.log(`Wrote ${png.byteLength} bytes to ${outputPath}`);
