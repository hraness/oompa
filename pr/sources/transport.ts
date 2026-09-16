import { signalId } from "../classify.ts";
import type { PrSignal } from "../model.ts";
import { htmlDocument } from "../parse.ts";
import type { PulseSource } from "../source.ts";

/** Ceiba–Vieques–Culebra passenger ferry service alerts banner. */
export const prFerrySource: PulseSource = {
  id: "pr-ferry",
  name: "Puerto Rico Ferry",
  category: "transport",
  homepage: "https://www.puertoricoferry.com/",
  collect: async (ctx) => {
    const html = await ctx.fetchText("https://www.puertoricoferry.com/", {
      accept: "text/html",
      label: "puertoricoferry.com",
    });
    const { document } = htmlDocument(html);
    const alerts: string[] = [];
    for (const node of document.querySelectorAll(
      "[class*='alert'], .service-alert, [id*='alert'], .alert-after-header, .alert_content-wrapper",
    )) {
      const text = node.textContent.replaceAll(/\s+/gu, " ").trim();
      if (text.length > 12 && text.length < 1200 && !/^(alert|aviso|close|×)$/iu.test(text)) {
        alerts.push(text.slice(0, 600));
      }
    }
    const deduped = [...new Set(alerts)];
    return deduped.slice(0, 8).map((text, index): PrSignal => ({
      id: signalId("pr-ferry", [index.toString(), text.slice(0, 160)]),
      source: "pr-ferry",
      sourceName: "Puerto Rico Ferry (ATM)",
      category: "transport",
      severity: /cancel|suspend|suspende|reprogram|delay|retras|cerrad/iu.test(text) ? "warning" : "advisory",
      title: text.slice(0, 200),
      summary: text.length > 200 ? text.slice(0, 600) : undefined,
      url: "https://www.puertoricoferry.com/",
      regions: ["vieques", "culebra", "northeast"],
      lang: /[áéíóúñ]|servicio|ferry|viaje/iu.test(text) ? "es" : "en",
      issuedAt: undefined,
      expiresAt: undefined,
      metrics: undefined,
    }));
  },
};

/** FCC Disaster Information Reporting System activations (county cell-site outages). */
export const fccDirsSource: PulseSource = {
  id: "fcc-dirs",
  name: "FCC DIRS reports",
  category: "comms",
  homepage: "https://www.fcc.gov/disaster-information-reporting-system-dirs",
  collect: async (ctx) => {
    const html = await ctx.fetchText("https://www.fcc.gov/disaster-information-reporting-system-dirs", {
      accept: "text/html",
      label: "fcc.gov",
    });
    const { document } = htmlDocument(html);
    const links = [...document.querySelectorAll("a")]
      .map((anchor) => ({
        text: anchor.textContent.replaceAll(/\s+/gu, " ").trim(),
        href: anchor.getAttribute("href") ?? "",
      }))
      .filter(({ text, href }) => /dirs|disaster report/i.test(text + href));
    const recent = links.slice(0, 10);
    return [{
      id: signalId("fcc-dirs", ["index", recent.length.toString(), recent.map((l) => l.text).join("|").slice(0, 100)]),
      source: "fcc-dirs",
      sourceName: "FCC DIRS",
      category: "comms",
      severity: recent.some((l) => /puerto rico|hurricane|storm|fiona|activation/i.test(l.text + l.href)) ? "watch" : "info",
      title: recent.length > 0
        ? `DIRS index lists ${recent.length.toString()} disaster communications reports`
        : "DIRS index reachable; no activation documents detected",
      summary: "FCC DIRS publishes county-level cell-site and carrier outage reports during declared disasters.",
      url: "https://www.fcc.gov/disaster-information-reporting-system-dirs",
      regions: ["islandwide"],
      lang: "en",
      issuedAt: ctx.now.toISOString(),
      expiresAt: undefined,
      metrics: { linkedReports: recent.length },
    }];
  },
};
