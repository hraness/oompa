import { signalId } from "../classify.ts";
import type { PrSignal } from "../model.ts";
import { parseFeed, xmlDocument } from "../parse.ts";
import type { PulseSource } from "../source.ts";

const gdacsNamespaceText = (item: Element, local: string): string => {
  for (const child of item.children) {
    if (child.localName.toLowerCase().endsWith(local.toLowerCase())) {
      return child.textContent.trim();
    }
  }
  return "";
};

/** UN GDACS global events filtered to the Caribbean/Atlantic basin. */
export const gdacsCaribbeanSource: PulseSource = {
  id: "gdacs-caribbean",
  name: "GDACS Caribbean",
  category: "regional",
  homepage: "https://www.gdacs.org/",
  collect: async (ctx) => {
    const xml = await ctx.fetchText("https://www.gdacs.org/xml/rss.xml", {
      accept: "application/rss+xml, */*",
      label: "gdacs.org",
    });
    const document = xmlDocument(xml);
    const signals: PrSignal[] = [];
    for (const item of document.querySelectorAll("item")) {
      const lat = Number.parseFloat(gdacsNamespaceText(item, "lat"));
      const lon = Number.parseFloat(gdacsNamespaceText(item, "long"));
      const title = (item.querySelector("title")?.textContent ?? "").trim();
      const description = (item.querySelector("description")?.textContent ?? "").replaceAll(/\s+/gu, " ").trim();
      const link = item.querySelector("link")?.textContent.trim() ?? "";
      const pub = item.querySelector("pubDate")?.textContent.trim() ?? "";
      const eventType = gdacsNamespaceText(item, "eventtype").toUpperCase();
      const country = gdacsNamespaceText(item, "country");
      const severityLevel = gdacsNamespaceText(item, "alertlevel") || gdacsNamespaceText(item, "severity");
      const inTheater = Number.isFinite(lat) && Number.isFinite(lon)
        ? lat >= 5 && lat <= 28 && lon >= -90 && lon <= -50
        : /puerto rico|caribbean|dominican|haiti|cuba|jamaica|virgin|antigua|dominica|martinique|guadeloupe|barbuda|saint|grenada|trinidad|bahamas|lesser antilles|leeward|mona/iu.test(`${title} ${description} ${country}`);
      if (!inTheater) continue;
      const severity = /red/i.test(severityLevel) ? "emergency"
        : /orange/i.test(severityLevel) ? "warning" : /green/i.test(severityLevel) ? "info" : "advisory";
      signals.push({
        id: signalId("gdacs", [item.querySelector("guid")?.textContent ?? link, title]),
        source: "gdacs-caribbean",
        sourceName: "GDACS (UN/EU)",
        category: eventType === "EQ" ? "seismic" : eventType === "TC" ? "weather" : eventType === "FL" ? "flood" : eventType === "DR" ? "climate" : "regional",
        severity,
        title: title.slice(0, 300),
        summary: `${eventType === "" ? "Event" : eventType} ${country === "" ? "" : `, ${country} `}(${severityLevel || "unrated"}). ${description}`.slice(0, 1200),
        url: link.startsWith("http") ? link : "https://www.gdacs.org/",
        regions: ["caribbean"],
        lang: "en",
        issuedAt: Number.isNaN(Date.parse(pub)) ? undefined : new Date(pub).toISOString(),
        expiresAt: undefined,
        metrics: undefined,
      });
      if (signals.length >= 20) break;
    }
    return signals;
  },
};

const CARIBBEAN_VOLCANOES = /\b(?:soufri[eè]re|kick['’]?em|kick-?em-jenny|montserrat|pel[eé]e|la soufri[eè]re|saint vincent|st\.? vincent|martinique|dominica|grenada|nevis|saba|eustatius|quill|soufriere hills|morne)\b/iu;

export const volcanoWeeklySource: PulseSource = {
  id: "volcano-caribbean",
  name: "Smithsonian volcano activity",
  category: "regional",
  homepage: "https://volcano.si.edu/news/",
  collect: async (ctx) => {
    const xml = await ctx.fetchText("https://volcano.si.edu/news/WeeklyVolcanoRSS.xml", {
      accept: "application/rss+xml, */*",
      label: "volcano.si.edu",
      lossy: true,
    });
    const items = parseFeed(xml, 60);
    return items
      .filter((item) => CARIBBEAN_VOLCANOES.test(`${item.title} ${item.summary}`))
      .slice(0, 10)
      .map((item): PrSignal => ({
        id: signalId("volcano", [item.guid ?? item.link]),
        source: "volcano-caribbean",
        sourceName: "Smithsonian/USGS Weekly Volcanic Activity Report",
        category: "regional",
        severity: /new activity|unrest|eruption|erupts|ash/iu.test(`${item.title} ${item.summary}`) ? "advisory" : "info",
        title: item.title.slice(0, 300),
        summary: item.summary.slice(0, 1000) || undefined,
        url: item.link === "" ? "https://volcano.si.edu/news/" : item.link,
        regions: ["caribbean"],
        lang: "en",
        issuedAt: item.publishedAt,
        expiresAt: undefined,
        metrics: undefined,
      }));
  },
};

/** CariCOF/CIMH regional climate outlook bulletins (drought, rainfall, heat). */
export const caricofSource: PulseSource = {
  id: "caricof",
  name: "CariCOF Caribbean climate",
  category: "climate",
  homepage: "https://rcc.cimh.edu.bb/",
  collect: async (ctx) => {
    const xml = await ctx.fetchText("https://rcc.cimh.edu.bb/feed/", {
      accept: "application/rss+xml, */*",
      label: "rcc.cimh.edu.bb",
    });
    const items = parseFeed(xml, 25);
    return items.slice(0, 10).map((item): PrSignal => ({
      id: signalId("caricof", [item.guid ?? item.link]),
      source: "caricof",
      sourceName: "CariCOF / CIMH Barbados",
      category: "climate",
      severity: /drought|sequ[ií]a|heat|calor|warning|advisory/iu.test(`${item.title} ${item.summary}`) ? "advisory" : "info",
      title: item.title.slice(0, 300),
      summary: item.summary.slice(0, 1000) || undefined,
      url: item.link === "" ? "https://rcc.cimh.edu.bb/" : item.link,
      regions: ["caribbean"],
      lang: /[áéíóúñ¿¡]/u.test(item.title) ? "es" : "en",
      issuedAt: item.publishedAt,
      expiresAt: undefined,
      metrics: undefined,
    }));
  },
};
