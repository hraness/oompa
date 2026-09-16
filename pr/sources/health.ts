import { signalId } from "../classify.ts";
import type { PrSignal } from "../model.ts";
import { absoluteUrl, htmlDocument } from "../parse.ts";
import type { PulseSource } from "../source.ts";

/** CDC travel health notices relevant to Puerto Rico and the Caribbean. */
export const cdcTravelNoticesSource: PulseSource = {
  id: "cdc-travel",
  name: "CDC travel health notices",
  category: "health",
  homepage: "https://wwwnc.cdc.gov/travel/notices",
  collect: async (ctx) => {
    const html = await ctx.fetchText("https://wwwnc.cdc.gov/travel/notices", {
      accept: "text/html",
      label: "wwwnc.cdc.gov",
    });
    const { document } = htmlDocument(html);
    const signals: PrSignal[] = [];
    for (const anchor of document.querySelectorAll("a")) {
      const text = anchor.textContent.replaceAll(/\s+/gu, " ").trim();
      const href = anchor.getAttribute("href") ?? "";
      if (!/notice|watch|alert|outbreak/i.test(href) && !/dengue|oropouche|chikungunya|zika|outbreak|notice/i.test(text)) continue;
      const relevant = /puerto rico|caribbean|dengue|oropouche|chikungunya|zika|ola de calor|global|worldwide/i.test(text);
      if (!relevant) continue;
      const level = /warning|alert|level 3|level 4|avoid/i.test(text) ? "watch" : "advisory";
      signals.push({
        id: signalId("cdc-travel", [href, text.slice(0, 80)]),
        source: "cdc-travel",
        sourceName: "CDC Travelers' Health",
        category: "health",
        severity: level,
        title: text.slice(0, 300),
        summary: "CDC travel health notice relevant to Puerto Rico or the Caribbean basin.",
        url: absoluteUrl("https://wwwnc.cdc.gov/travel/notices", href) ?? "https://wwwnc.cdc.gov/travel/notices",
        regions: ["islandwide", "caribbean"],
        lang: "en",
        issuedAt: undefined,
        expiresAt: undefined,
        metrics: undefined,
      });
      if (signals.length >= 12) break;
    }
    return signals;
  },
};

/** PR Department of Health surveillance bulletins (arboviral/dengue reports). */
export const prSaludSource: PulseSource = {
  id: "pr-salud",
  name: "PR Dept. of Health",
  category: "health",
  homepage: "https://www.salud.pr.gov/",
  collect: async (ctx) => {
    const html = await ctx.fetchText("https://www.salud.pr.gov/", {
      accept: "text/html",
      label: "salud.pr.gov",
      maxBytes: 1024 * 1024,
    });
    const { document } = htmlDocument(html);
    const signals: PrSignal[] = [];
    for (const anchor of document.querySelectorAll("a")) {
      const text = anchor.textContent.replaceAll(/\s+/gu, " ").trim();
      const href = anchor.getAttribute("href") ?? "";
      if (!/dengue|arbovir|epidemi|vigilancia|influenza|covid|alerta|emergencia|bolet[ií]n|comunicado/i.test(`${text} ${href}`)) continue;
      signals.push({
        id: signalId("pr-salud", [href, text.slice(0, 80)]),
        source: "pr-salud",
        sourceName: "PR Departamento de Salud",
        category: "health",
        severity: /emergencia|epidemia|alerta/i.test(text) ? "advisory" : "info",
        title: (text.length > 8 ? text : "PR Department of Health bulletin").slice(0, 300),
        summary: "Surveillance or advisory publication from the Puerto Rico Department of Health.",
        url: absoluteUrl("https://www.salud.pr.gov/", href) ?? "https://www.salud.pr.gov/",
        regions: ["islandwide"],
        lang: "es",
        issuedAt: undefined,
        expiresAt: undefined,
        metrics: undefined,
      });
      if (signals.length >= 12) break;
    }
    return signals;
  },
};
