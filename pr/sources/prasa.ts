import { signalId } from "../classify.ts";
import type { PrSignal } from "../model.ts";
import { absoluteUrl, htmlDocument, htmlText } from "../parse.ts";
import type { PulseSource } from "../source.ts";

const AAA = "https://www.acueductospr.com";

export const prasaEmbalsesSource: PulseSource = {
  id: "prasa-embalses",
  name: "AAA reservoir levels",
  category: "water",
  homepage: `${AAA}/infraestructura/niveles-de-los-embalses`,
  collect: async (ctx) => {
    const html = await ctx.fetchText(`${AAA}/infraestructura/niveles-de-los-embalses`, {
      accept: "text/html",
      label: "acueductospr.com",
    });
    const { document } = htmlDocument(html);
    const reservoirNames = new Set<string>();
    for (const img of document.querySelectorAll("img")) {
      const alt = img.getAttribute("alt") ?? "";
      const src = img.getAttribute("src") ?? "";
      const match = /embalse[_ -]?([a-záéíóúñ_ -]+)/iu.exec(alt !== "" ? alt : decodeURIComponent(src));
      if (match?.[1] !== undefined) {
        reservoirNames.add(match[1].replaceAll(/[_-]+/gu, " ").trim().toUpperCase().slice(0, 40));
      }
    }
    const text = htmlText(html);
    const mentionsUpdate = /(?:actualizad|updated|nivel)/iu.test(text);
    const signals: PrSignal[] = [{
      id: signalId("prasa-emb", ["daily", [...reservoirNames].sort().join("|").slice(0, 120)]),
      source: "prasa-embalses",
      sourceName: "AAA (PRASA)",
      category: "water",
      severity: "info",
      title: `Reservoir dashboard tracks ${reservoirNames.size.toString()} embalses`,
      summary: `AAA publishes reservoir levels for the island's water supply system (${[...reservoirNames].slice(0, 8).join(", ")}${reservoirNames.size > 8 ? "…" : ""}). Check the linked page for the current report.${mentionsUpdate ? "" : ""}`,
      url: `${AAA}/infraestructura/niveles-de-los-embalses`,
      regions: ["islandwide"],
      lang: "es",
      issuedAt: ctx.now.toISOString(),
      expiresAt: undefined,
      metrics: { reservoirsTracked: reservoirNames.size },
    }];
    return signals;
  },
};

export const prasaInterruptionsSource: PulseSource = {
  id: "prasa-interruptions",
  name: "AAA planned interruptions",
  category: "water",
  homepage: `${AAA}/planes-de-interrupciones-programadas-2026`,
  collect: async (ctx) => {
    const html = await ctx.fetchText(`${AAA}/planes-de-interrupciones-programadas-2026`, {
      accept: "text/html",
      label: "acueductospr.com",
    });
    const { document } = htmlDocument(html);
    const signals: PrSignal[] = [];
    for (const anchor of document.querySelectorAll("a")) {
      const href = anchor.getAttribute("href") ?? "";
      const label = anchor.textContent.replaceAll(/\s+/gu, " ").trim();
      if (!/\.pdf|interrup/i.test(href) && !/interrup|ver pdf|plan/i.test(label)) continue;
      const url = absoluteUrl(`${AAA}/`, href);
      const title = label.length > 6 ? label : decodeURIComponent(href.split("/").pop() ?? "Interrupción programada");
      if (title.length < 6 || signals.length >= 25) continue;
      signals.push({
        id: signalId("prasa-plan", [url ?? href, title]),
        source: "prasa-interruptions",
        sourceName: "AAA (PRASA): planned interruptions",
        category: "water",
        severity: "advisory",
        title: title.slice(0, 300),
        summary: "Planned service interruption or replacement plan published by AAA.",
        url: url ?? `${AAA}/planes-de-interrupciones-programadas-2026`,
        regions: ["islandwide"],
        lang: "es",
        issuedAt: undefined,
        expiresAt: undefined,
        metrics: undefined,
      });
    }
    if (signals.length === 0) {
      signals.push({
        id: signalId("prasa-plan", ["index"]),
        source: "prasa-interruptions",
        sourceName: "AAA (PRASA): planned interruptions",
        category: "water",
        severity: "info",
        title: "AAA planned interruption index",
        summary: "No individual plan documents could be parsed; check the index page for current interruption plans.",
        url: `${AAA}/planes-de-interrupciones-programadas-2026`,
        regions: ["islandwide"],
        lang: "es",
        issuedAt: undefined,
        expiresAt: undefined,
        metrics: undefined,
      });
    }
    return signals.slice(0, 25);
  },
};
